#!/bin/sh
# Publish the page to EdgeOne Makers (the product formerly called EdgeOne Pages)
# in one command.
#
#   sh tools/deploy_edgeone.sh                     # everything from ./.env
#   sh tools/deploy_edgeone.sh -n <project> -t <token>
#   sh tools/deploy_edgeone.sh -e preview          # a throwaway preview URL
#   sh tools/deploy_edgeone.sh --dry-run           # package + check, upload nothing
#
# Why a script instead of the console's drag-and-drop: the site is 67 files /
# 16 MB, 59 of them under render/_framework/, and every `.wasm` has to be served
# as `application/wasm` or the browser refuses to instantiate it.  Dragging that
# by hand on every update is how you end up shipping yesterday's worker.js.
#
# This is also the ONLY deployment path that keeps the project's red lines.
# `mg_engine.*` and `render/` are build outputs (and CNCMaps is GPL v3), so they
# are never committed; and a cloud build cannot reproduce them, because the
# reference implementation the generator is built from is not in the repository
# (no licence).  So the build happens HERE and only the finished bytes travel.
#
# Settings can live in ./.env (git-ignored), which is what turns the command
# above into a single word:
#
#   EDGEONE_PROJECT=<project name, exactly as the console shows it>
#   EDGEONE_URL=<https://your-domain/>        # verified after every deploy
#   EDGEONE_API_TOKEN=<API token>             # optional if you ran `edgeone login`
#
# Auth, in order of preference:
#   1. -t <token> / EDGEONE_API_TOKEN / .env   (what CI uses; no browser needed)
#   2. `npx edgeone@<version> login`           (browser session, stored in ~/.edgeone)
#
# The deploy updates the EXISTING project, so the custom domain and the HTTPS
# certificate you already configured survive; nothing else has to be re-entered.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

# Pinned on purpose.  The CLI moved `edgeone pages deploy` to
# `edgeone makers deploy` (deprecated alias) inside the 1.x line, and the flags
# are the interface we depend on here; an unpinned npx would one day deploy
# something else.  Override with EDGEONE_CLI_VERSION, or set EDGEONE_CLI to a
# command (e.g. a global `edgeone`) to use that instead of npx.
CLI_VER=${EDGEONE_CLI_VERSION:-1.6.41}
CLI_CMD="npx --yes edgeone@$CLI_VER"
[ -n "${EDGEONE_CLI:-}" ] && CLI_CMD=$EDGEONE_CLI

OUT=$ROOT/build/webapp
LOG=$ROOT/build/edgeone-deploy.json

# ---- settings: .env < environment < command line --------------------------
env_value() {
    # First non-empty value of $1 in ./.env or ./.env.local; .env.local wins.
    # Always succeeds: callers use it inside ${VAR:-...}, where a non-zero
    # status would trip `set -e`.
    key=$1
    out=
    for f in "$ROOT/.env" "$ROOT/.env.local"; do
        [ -f "$f" ] || continue
        v=$(sed -n "s/^[[:space:]]*$key[[:space:]]*=[[:space:]]*//p" "$f" | tail -1 \
            | tr -d '\r' | sed "s/[[:space:]]*$//; s/^[\"']//; s/[\"']$//")
        [ -n "$v" ] && out=$v
    done
    [ -n "$out" ] && printf '%s' "$out"
    return 0
}

PROJECT=${EDGEONE_PROJECT:-$(env_value EDGEONE_PROJECT)}
SITE_URL=${EDGEONE_URL:-$(env_value EDGEONE_URL)}
# EDGEONE_API_TOKEN is this script's name; EDGEONE_PAGES_API_TOKEN is the CLI's
# own, so a token copied out of the EdgeOne documentation works unrenamed.  No
# region setting is needed either: the CLI probes both API hosts with the token
# (pages-api.cloud.tencent.com for the China site, pages-api.edgeone.ai for the
# international one) and deploys to whichever accepts it.
TOKEN=${EDGEONE_API_TOKEN:-${EDGEONE_PAGES_API_TOKEN:-$(env_value EDGEONE_API_TOKEN)}}
[ -n "$TOKEN" ] || TOKEN=$(env_value EDGEONE_PAGES_API_TOKEN)
ENVNAME=${EDGEONE_ENV:-$(env_value EDGEONE_ENV)}
AREA=${EDGEONE_AREA:-$(env_value EDGEONE_AREA)}
: "${ENVNAME:=production}"

DO_VERIFY=0
DO_FORCE=0
DRY=0
CHECK_URL=1

usage() {
    cat <<'EOF'
usage: sh tools/deploy_edgeone.sh [-n project] [-e production|preview]
                                  [-a global|overseas] [-t token] [-u url]
                                  [--verify] [--force] [--dry-run] [--no-check-url]

  -n, --name      EdgeOne project name (or EDGEONE_PROJECT / .env)
  -e, --env       production (default) or preview
  -a, --area      deploy area: global (default) or overseas
  -t, --token     API token (or EDGEONE_API_TOKEN / .env, or `edgeone login`)
  -u, --url       site URL to verify after the deploy (or EDGEONE_URL / .env)
      --verify    run tools/verify_all.sh first and refuse to publish a red run
      --force     publish even if the artifacts are older than the sources
      --dry-run   package and check everything, but upload nothing
      --no-check-url  skip the post-deploy asset/Content-Type check
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        -n|--name)   PROJECT=${2:?$1 needs a value}; shift 2 ;;
        -e|--env)    ENVNAME=${2:?$1 needs a value}; shift 2 ;;
        -a|--area)   AREA=${2:?$1 needs a value}; shift 2 ;;
        -t|--token)  TOKEN=${2:?$1 needs a value}; shift 2 ;;
        -u|--url)    SITE_URL=${2:?$1 needs a value}; shift 2 ;;
        --verify)    DO_VERIFY=1; shift ;;
        --force)     DO_FORCE=1; shift ;;
        --dry-run)   DRY=1; shift ;;
        --no-check-url) CHECK_URL=0; shift ;;
        -h|--help)   usage; exit 0 ;;
        *) echo "[deploy] unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
done

case "$ENVNAME" in
    production|preview) ;;
    *) echo "[deploy] -e must be production or preview (got '$ENVNAME')" >&2; exit 2 ;;
esac
if [ -z "$PROJECT" ] && [ "$DRY" = 0 ]; then
    echo "[deploy] no project name: pass -n <project> or set EDGEONE_PROJECT." >&2
    echo "         Use the name the EdgeOne console shows for the site you" >&2
    echo "         already deployed; the deploy updates that project in place." >&2
    exit 2
fi

# ---- is the staged build actually current? --------------------------------
# `find -newer` is the only cheap signal that the bytes we are about to publish
# were built from the sources on disk: packaging wipes and refills build/, so
# the staged copies in webapp/ are the ones whose date means anything.
age_of() {
    # "3 days ago" for a nicer message; stat's format differs across platforms.
    python3 - "$1" <<'PY'
import os, sys, time
secs = time.time() - os.path.getmtime(sys.argv[1])
for unit, size in (("day", 86400), ("hour", 3600), ("minute", 60)):
    if secs >= size:
        n = int(secs // size)
        print("%d %s%s ago" % (n, unit, "" if n == 1 else "s"))
        break
else:
    print("just now")
PY
}

stale_check() {
    art=$1          # the staged build output
    hint=$2         # how to rebuild it
    shift 2
    [ "$1" = "--" ] && shift
    if [ ! -f "$art" ]; then
        echo "[deploy] ERROR: $art is missing -- it has not been built, or the" >&2
        echo "         build failed.  Rebuild it with:" >&2
        echo "           $hint" >&2
        exit 1
    fi
    [ "$DO_FORCE" = 1 ] && return 0
    newer=
    for src in "$@"; do
        [ -e "$src" ] || continue
        # obj/ and bin/ are build output, not source: a renderer build rewrites
        # them, and dating the shipped bytes against them would fire every time.
        found=$(find "$src" -type f \
                    -not -path '*/obj/*' -not -path '*/bin/*' \
                    -newer "$art" -print -quit 2>/dev/null || true)
        [ -n "$found" ] && { newer=$found; break; }
    done
    if [ -n "$newer" ]; then
        echo "[deploy] REFUSING: this build output is $(age_of "$art"), but a source is newer:" >&2
        echo "            $newer" >&2
        echo "            $art" >&2
        echo "          Publishing now would ship bytes that do not match the sources." >&2
        echo "          Rebuild it:" >&2
        echo "            $hint" >&2
        echo "          or pass --force if you know these are the bytes you want." >&2
        exit 1
    fi
}

# ---- preflight ------------------------------------------------------------
if ! command -v python3 >/dev/null 2>&1; then
    echo "[deploy] python3 not found -- the packaging and the URL check need it" >&2
    exit 1
fi
if ! command -v npx >/dev/null 2>&1 && [ -z "${EDGEONE_CLI:-}" ]; then
    echo "[deploy] npx not found -- install Node.js, or set EDGEONE_CLI to an edgeone binary" >&2
    exit 1
fi

echo "[deploy] checking the staged build"
stale_check "$ROOT/webapp/mg_engine.wasm" \
            "sh -c '. tools/emenv.sh && sh engine/build_web.sh'" -- \
            "$ROOT/engine/src" "$ROOT/engine/CMakeLists.txt" "$ROOT/engine/build_web.sh"
stale_check "$ROOT/webapp/render/_framework/CNCMaps.Engine.wasm" \
            "sh engine/build_render_web.sh" -- \
            "$ROOT/engine/render" "$ROOT/engine/build_render_web.sh" "$ROOT/reference_impl/ccmaps-net"

if [ "$DO_VERIFY" = 1 ]; then
    echo "[deploy] running the acceptance gauntlet first (MG_SKIP_BUILD=1 reuses build/)"
    sh tools/verify_all.sh
else
    echo "[deploy] (not running tools/verify_all.sh; pass --verify to gate on it)"
fi

# ---- package --------------------------------------------------------------
echo "[deploy] packaging"
sh tools/package_webapp.sh "$OUT"

# ---- sanity: the exact failure modes this project has actually shipped ----
ENGINE_WASM=$OUT/mg_engine.wasm
FRAMEWORK=$OUT/render/_framework
fail=0
size_of() { wc -c < "$1" | tr -d ' '; }

# Emscripten's wrong-toolchain failure is a 11 KB wasm that exits 0 and does
# nothing (see docs/DEPLOY.md).  The real engine is ~0.6 MB; a floor catches it
# without pinning the exact size.
esize=$(size_of "$ENGINE_WASM")
if [ "$esize" -lt 300000 ]; then
    echo "[deploy] ERROR: mg_engine.wasm is only $esize bytes -- that is the" >&2
    echo "         empty-program failure, not a build. Rebuild with the pinned" >&2
    echo "         Emscripten (tools/emenv.sh) before publishing." >&2
    fail=1
fi
# The renderer is 59 files / ~14 MB; a partial staging (or a directory dropped
# by a host that dislikes the leading underscore) is what this catches.
if [ ! -d "$FRAMEWORK" ]; then
    echo "[deploy] ERROR: $FRAMEWORK is missing" >&2
    fail=1
else
    nfiles=$(find "$FRAMEWORK" -type f | wc -l | tr -d ' ')
    nbytes=$(du -sb "$FRAMEWORK" | cut -f1)
    [ "$nfiles" -lt 50 ] && { echo "[deploy] ERROR: only $nfiles files in render/_framework (expect ~59)" >&2; fail=1; }
    [ "$nbytes" -lt 10000000 ] && { echo "[deploy] ERROR: render/_framework is only $nbytes bytes (expect ~14 MB)" >&2; fail=1; }
fi
[ -f "$OUT/render/_framework/dotnet.js" ] || { echo "[deploy] ERROR: render/_framework/dotnet.js is missing" >&2; fail=1; }
[ -f "$OUT/index.html" ] || { echo "[deploy] ERROR: index.html is missing" >&2; fail=1; }
# The test-only symlink to a local game install must never be published.
[ -e "$OUT/game" ] && { echo "[deploy] ERROR: the test-only 'game' symlink is in the package" >&2; fail=1; }
[ "$fail" = 0 ] || exit 1

total=$(find "$OUT" -type f | wc -l | tr -d ' ')
echo "[deploy] package ok: $total files, $(du -sh "$OUT" | cut -f1), engine $esize B"

# ---- the exact command ----------------------------------------------------
# A dry run is allowed without a project name, so the printed command shows a
# placeholder instead of an empty -n.  On a real deploy PROJECT is never empty
# (checked above), so the two are the same string.
PROJECT_SHOWN=${PROJECT:-<project-name>}
set -- makers deploy . \
       -n "$PROJECT_SHOWN" \
       -e "$ENVNAME" \
       --json
[ -n "$AREA" ] && set -- "$@" -a "$AREA"
# The token is passed through the environment, never as -t: an argument is
# visible in `ps` and lands in shell history and CI logs.
CMD_DESC="$CLI_CMD $*"
[ -n "$TOKEN" ] && CMD_DESC="$CMD_DESC   (token via EDGEONE_PAGES_API_TOKEN)"

if [ "$DRY" = 1 ]; then
    cat <<EOF

[deploy] DRY RUN -- nothing was uploaded.
         would run, from $OUT:
           $CMD_DESC
         environment:
           EDGEONE_PROJECT=${PROJECT:-<not set>}
           EDGEONE_ENV=$ENVNAME
           EDGEONE_AREA=${AREA:-(CLI default: global)}
           token: $([ -n "$TOKEN" ] && echo "provided" || echo "none -- would need 'edgeone login'")
         verify after deploy: $([ -n "$SITE_URL" ] && echo "$SITE_URL" || echo "(URL parsed from the CLI output)")

To publish for real, drop --dry-run.
EOF
    exit 0
fi

# ---- deploy ---------------------------------------------------------------
echo "[deploy] uploading to project '$PROJECT' ($ENVNAME)"
if [ -n "$TOKEN" ]; then
    EDGEONE_PAGES_API_TOKEN=$TOKEN
    export EDGEONE_PAGES_API_TOKEN
fi

# Run from the packaged directory and deploy '.', so that the `edgeone.json`
# next to the site (wasm Content-Type, cache rules) is found whether the CLI
# resolves its config from the working directory or from the directory being
# deployed.
rc=0
( cd "$OUT" && $CLI_CMD "$@" ) > "$LOG" 2>&1 || rc=$?
cat "$LOG"
if [ "$rc" != 0 ]; then
    echo "[deploy] FAILED (exit $rc); full output kept in $LOG" >&2
    exit "$rc"
fi

# A mistyped project name does not fail: the CLI creates a new project instead.
# That looks like a successful deploy while your real site stays on the old
# build, so it is worth saying out loud.
if grep -q 'Creating new project with name' "$LOG" 2>/dev/null; then
    echo >&2
    echo "[deploy] WARNING: no existing project was found under '$PROJECT', so the CLI" >&2
    echo "         CREATED a new one. Your live site is probably still serving the old" >&2
    echo "         build. Check the name against the console and deploy again:" >&2
    echo "           China site:  https://console.cloud.tencent.com/edgeone/pages" >&2
    echo "           International: https://console.tencentcloud.com/edgeone/pages" >&2
fi

# ---- what actually went live ---------------------------------------------
if [ -z "$SITE_URL" ]; then
    SITE_URL=$(python3 - "$LOG" <<'PY'
import json, sys
url = ""
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    line = line.strip()
    i, j = line.find("{"), line.rfind("}")
    if i < 0 or j <= i:
        continue
    try:
        obj = json.loads(line[i:j + 1])
    except Exception:
        continue
    stack = [obj]
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            for key in ("url", "deploymentUrl", "previewUrl", "siteUrl"):
                v = cur.get(key)
                if isinstance(v, str) and v.startswith("http"):
                    url = v
            stack.extend(cur.values())
        elif isinstance(cur, list):
            stack.extend(cur)
print(url)
PY
)
fi

if [ -z "$SITE_URL" ]; then
    echo
    echo "[deploy] deployed, but no URL could be read from the CLI output."
    echo "         Point the script at your domain so this check runs every time:"
    echo "           EDGEONE_URL=https://your-domain/ sh tools/deploy_edgeone.sh"
    exit 0
fi

echo
echo "[deploy] live at $SITE_URL"
if [ "$CHECK_URL" = 1 ]; then
    sh tools/verify_deployed.sh "$SITE_URL"
    echo
    echo "Now open it in a browser and generate + render once: a wrong"
    echo "Content-Type or a 404 on a lazily-fetched renderer file only shows up"
    echo "there.  If you just updated worker.js/app.js and the page looks stale,"
    echo "hard-reload (Ctrl+Shift+R); they are served no-cache but the browser"
    echo "still keeps a copy."
fi
