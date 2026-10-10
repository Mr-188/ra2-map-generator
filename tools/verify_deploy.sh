#!/bin/sh
# Acceptance for the DEPLOYMENT path.
#
#   sh tools/verify_deploy.sh
#
# tools/deploy_edgeone.sh is the only thing that can publish this project, and
# the ways it can go wrong are all silent ones: publishing bytes that were not
# built from the sources, publishing the 11 KB wasm that Emscripten produces
# from the wrong toolchain, dropping the leading-underscore renderer directory,
# or serving a .wasm as application/octet-stream so the browser refuses to
# instantiate it.  So this suite checks that it REFUSES those, and checks what
# it actually sends.
#
# Everything here runs offline and without an EdgeOne account.  Two halves:
#
#   1. the real packaging contract, on the real tree (needs the staged builds;
#      skipped, not failed, when they are absent, like verify_all.sh does);
#   2. tools/deploy_edgeone.sh itself, run inside a synthetic project root with
#      a stub `edgeone` in place of the CLI -- so the command line, the working
#      directory and the token handling are all observable, and nothing is
#      uploaded.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf '  ok    %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL  %s\n' "$1"; }

# expect_rc <label> <wanted-rc> <got-rc>
expect_rc() {
    if [ "$2" = "$3" ]; then ok "$1 (exit $3)"; else bad "$1 (wanted exit $2, got $3)"; fi
}
# expect_grep <label> <pattern> <file>
expect_grep() {
    if grep -q -- "$2" "$3" 2>/dev/null; then ok "$1"; else bad "$1"; sed 's/^/        | /' "$3" | head -8; fi
}
expect_no_grep() {
    if grep -q -- "$2" "$3" 2>/dev/null; then bad "$1"; else ok "$1"; fi
}

echo "[deploy] 1. packaging contract (real tree)"
# ---------------------------------------------------------------- real tree

if [ -f "$ROOT/webapp/mg_engine.wasm" ] && [ -d "$ROOT/webapp/render/_framework" ]; then
    PKG=$WORK/pkg
    sh tools/package_webapp.sh "$PKG" > "$WORK/package.log" 2>&1 || true

    # The host has to serve 59 renderer files under a directory whose name
    # starts with an underscore; a host that drops it returns HTML 404s for
    # every one of them.
    n=$(find "$PKG/render/_framework" -type f 2>/dev/null | wc -l | tr -d ' ')
    if [ "$n" = "59" ]; then ok "render/_framework ships 59 files"; else bad "render/_framework has $n files, expected 59"; fi

    if [ -f "$PKG/render/CNCMaps.Renderer.runtimeconfig.json" ] && [ -f "$PKG/render/package.json" ]; then
        ok "the renderer's runtimeconfig and package.json are present"
    else
        bad "the renderer's runtimeconfig or package.json is missing"
    fi

    if [ -f "$PKG/edgeone.json" ]; then ok "edgeone.json is shipped with the site"; else bad "edgeone.json is missing from the package"; fi

    # The test-only symlink to a local game install must never travel.
    if [ -e "$PKG/game" ]; then bad "the test-only game symlink was packaged"; else ok "the test-only game symlink is not packaged"; fi

    # Packaging rewrites the build machine's home out of the artifacts; a leak
    # here is published, not just committed.
    leak=$(grep -rl "$(cd ~ && pwd)" "$PKG" --include='*.js' --include='*.html' 2>/dev/null | head -1 || true)
    if [ -n "$leak" ]; then bad "the build machine's home leaked into $leak"; else ok "no build-machine path in the published artifacts"; fi

    if [ -f "$PKG/mg_engine.wasm" ]; then ok "the engine wasm is present"; else bad "mg_engine.wasm is missing from the package"; fi
else
    printf '  skip  (webapp/mg_engine.wasm or webapp/render/_framework is absent; build first)\n'
fi

echo "[deploy] 2. edgeone.json rules the host will actually accept"
# ------------------------------------------------------------- host config
# `edgeone validate` accepted these patterns; the CLI's own validator allows at
# most ONE `*` per pattern and rejects everything else.  A pattern it rejects
# fails the deploy, so it is worth pinning here rather than in the console.
if python3 - "$ROOT/webapp/edgeone.json" <<'PY'
import json, sys
path = sys.argv[1]
try:
    cfg = json.load(open(path, encoding="utf-8"))
except Exception as exc:
    print("  FAIL  edgeone.json is not valid JSON: %s" % exc); sys.exit(1)

def sources(key):
    return [r.get("source", "") for r in cfg.get(key, [])]

bad_star = [s for s in sources("headers") + sources("caches") + sources("redirects") + sources("rewrites")
            if s.count("*") > 1]
if bad_star:
    print("  FAIL  a pattern with more than one '*' is rejected by the CLI: %s" % bad_star); sys.exit(1)
print("  ok    every pattern has at most one '*'")

wasm = [r for r in cfg.get("headers", [])
        if any(h.get("key", "").lower() == "content-type" for h in r.get("headers", []))
        and "wasm" in r.get("source", "")]
covered = {r["source"] for r in wasm}
if covered >= {"/*.wasm", "/render/_framework/*.wasm"}:
    print("  ok    both the engine and the renderer pin Content-Type: application/wasm")
    sys.exit(0)
print("  FAIL  .wasm Content-Type is not pinned for both trees (got %s)" % sorted(covered))
sys.exit(1)
PY
then
    pass=$((pass + 1))
else
    fail=$((fail + 1))
fi

echo "[deploy] 3. what deploy_edgeone.sh refuses, and what it sends"
# --------------------------------------------------------------- sandbox
FAKE=$WORK/fake
mkdir -p "$FAKE/tools" "$FAKE/engine/src" "$FAKE/webapp/render/_framework"
cp "$ROOT/tools/deploy_edgeone.sh" "$FAKE/tools/"

# A stand-in for the real packager: it only has to place the same shape of tree.
cat > "$FAKE/tools/package_webapp.sh" <<'STUB'
#!/bin/sh
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$1
rm -rf "$OUT"
mkdir -p "$OUT/render/_framework"
cp "$ROOT/webapp/index.html" "$OUT/"
cp "$ROOT/webapp/mg_engine.wasm" "$OUT/"
cp "$ROOT/webapp/edgeone.json" "$OUT/"
cp "$ROOT/webapp/render/_framework/"* "$OUT/render/_framework/"
STUB

# A stand-in for the CLI.  It records how it was called and answers with the
# JSON line the real one prints with --json, so the URL extraction is exercised
# without an upload.
cat > "$WORK/stub-cli" <<'STUB'
#!/bin/sh
{
    echo "cwd=$(pwd)"
    echo "argv=$*"
    echo "token=${EDGEONE_PAGES_API_TOKEN:-<unset>}"
} >> "$STUB_LOG"
printf '{"url":"https://stub.example/","deploymentId":"stub-1"}\n'
exit 0
STUB
chmod +x "$WORK/stub-cli"
STUB_LOG=$WORK/stub.log
export STUB_LOG

# The same floors the real script enforces: ~0.6 MB engine, ~14 MB renderer.
build_fake_tree() {
    # $1 = engine wasm size, $2 = framework files, $3 = bytes per file
    mkdir -p "$FAKE/engine/src" "$FAKE/webapp/render/_framework"
    # The staleness test plants a newer source; every other case has to start
    # without it, or every later case looks stale as well.
    rm -f "$FAKE/engine/src/newer.cpp"
    : > "$FAKE/webapp/index.html"
    : > "$FAKE/webapp/edgeone.json"
    : > "$FAKE/engine/src/mix.cpp"
    head -c "$1" /dev/zero > "$FAKE/webapp/mg_engine.wasm"
    rm -f "$FAKE/webapp/render/_framework/"*
    i=0
    while [ "$i" -lt "$2" ]; do
        head -c "$3" /dev/zero > "$FAKE/webapp/render/_framework/f$i.wasm"
        i=$((i + 1))
    done
    : > "$FAKE/webapp/render/_framework/dotnet.js"
    # Older than every source, so only the explicit staleness test trips the gate.
    touch -d '2020-01-01 00:00:00' "$FAKE/webapp/mg_engine.wasm" \
        "$FAKE/webapp/render/_framework/CNCMaps.Engine.wasm" "$FAKE/engine/src/mix.cpp"
}

run_deploy() {
    # $1 = output file; the rest are the script's arguments
    out=$1
    shift
    set +e
    EDGEONE_CLI=$WORK/stub-cli sh "$FAKE/tools/deploy_edgeone.sh" "$@" > "$out" 2>&1
    echo $?
    set -e
}

# --- the refusals ---------------------------------------------------------
build_fake_tree 600000 55 250000

rc=$(run_deploy "$WORK/out.txt" --dry-run -n proj)
if [ "$rc" = "0" ]; then ok "a fresh, complete build passes the checks"; else bad "a fresh build was refused (exit $rc)"; sed 's/^/        | /' "$WORK/out.txt" | head -10; fi

# Missing engine output: the build never ran.
rm -f "$FAKE/webapp/mg_engine.wasm"
rc=$(run_deploy "$WORK/out.txt" --dry-run -n proj)
if [ "$rc" != "0" ] && grep -q 'is missing' "$WORK/out.txt"; then ok "a missing engine build is refused"; else bad "a missing engine build was not refused (exit $rc)"; fi
rm -f "$WORK/out.txt"

# The 11 KB empty-program wasm (the wrong-toolchain failure this project hit).
build_fake_tree 11000 55 250000
rc=$(run_deploy "$WORK/out.txt" --dry-run -n proj --force)
if [ "$rc" != "0" ] && grep -q 'empty-program' "$WORK/out.txt"; then ok "a 11 KB empty engine is refused"; else bad "an empty engine was not refused (exit $rc)"; sed 's/^/        | /' "$WORK/out.txt" | head -8; fi
rm -f "$WORK/out.txt"

# A truncated renderer staging.
build_fake_tree 600000 3 1000
rc=$(run_deploy "$WORK/out.txt" --dry-run -n proj --force)
if [ "$rc" != "0" ]; then ok "a truncated renderer is refused"; else bad "a truncated renderer was not refused"; fi
rm -f "$WORK/out.txt"

# Stale bytes: a source is newer than the artifact that would be published.
build_fake_tree 600000 55 250000
sleep 1
: > "$FAKE/engine/src/newer.cpp"
rc=$(run_deploy "$WORK/out.txt" --dry-run -n proj)
if [ "$rc" != "0" ] && grep -q 'REFUSING' "$WORK/out.txt"; then ok "publishing stale bytes is refused"; else bad "stale bytes were not refused (exit $rc)"; sed 's/^/        | /' "$WORK/out.txt" | head -10; fi
expect_grep "the refusal names the newer source" "newer.cpp" "$WORK/out.txt"
expect_grep "the refusal prints how to rebuild" "engine/build_web.sh" "$WORK/out.txt"
rc=$(run_deploy "$WORK/out.txt.dry" --dry-run -n proj --force)
expect_rc "--force overrides the staleness gate" 0 "$rc"

# --- usage errors ----------------------------------------------------------
build_fake_tree 600000 55 250000
rc=$(run_deploy "$WORK/out.txt" -n proj -e staging)
expect_rc "an unknown environment is rejected" 2 "$rc"
rc=$(run_deploy "$WORK/out.txt" --dry-run -n proj --nonsense)
expect_rc "an unknown flag is rejected" 2 "$rc"
rc=$(run_deploy "$WORK/out.txt")
if [ "$rc" != "0" ] && grep -q 'no project name' "$WORK/out.txt"; then ok "a real deploy without a project name is refused"; else bad "the project name was not required (exit $rc)"; fi

# --- what it sends ---------------------------------------------------------
rm -f "$STUB_LOG"
rc=$(run_deploy "$WORK/out.txt" --dry-run -n proj)
expect_rc "dry run succeeds" 0 "$rc"
if [ -f "$STUB_LOG" ]; then bad "dry run still invoked the CLI"; else ok "dry run does not invoke the CLI"; fi
expect_grep "dry run prints the command it would use" "makers deploy" "$WORK/out.txt"

rm -f "$STUB_LOG"
rc=$(run_deploy "$WORK/out.txt" -n proj -t SECRET-TOKEN-9f3a --no-check-url)
expect_rc "a real deploy runs to completion" 0 "$rc"
expect_grep "it deploys the packaged directory" "cwd=.*build/webapp" "$STUB_LOG"
expect_grep "it passes the project and environment" "makers deploy . -n proj -e production --json" "$STUB_LOG"
expect_grep "the token reaches the CLI through the environment" "token=SECRET-TOKEN-9f3a" "$STUB_LOG"
if grep '^argv=' "$STUB_LOG" | grep -q 'SECRET-TOKEN-9f3a'; then
    bad "the token was passed as an argument (visible in ps and shell history)"
else
    ok "the token is never an argument (ps and shell history)"
fi
expect_no_grep "the token is not echoed to the terminal or CI log" "SECRET-TOKEN-9f3a" "$WORK/out.txt"
expect_grep "the deployed URL is reported" "live at https://stub.example/" "$WORK/out.txt"

rm -f "$STUB_LOG"
rc=$(run_deploy "$WORK/out.txt" -n proj -t SECRET-TOKEN-9f3a -e preview -a overseas --no-check-url)
expect_grep "preview and area are passed through" "makers deploy . -n proj -e preview --json -a overseas" "$STUB_LOG"

# .env is how the command becomes a single word; it must be read, and it must
# not be able to smuggle anything else in.
cat > "$FAKE/.env" <<'ENV'
EDGEONE_PROJECT=from-env-file
EDGEONE_URL=https://env.example/
EDGEONE_API_TOKEN=ENV-FILE-TOKEN
ENV
rm -f "$STUB_LOG"
rc=$(run_deploy "$WORK/out.txt" --no-check-url)
expect_grep ".env supplies the project name" "makers deploy . -n from-env-file" "$STUB_LOG"
expect_grep ".env supplies the token" "token=ENV-FILE-TOKEN" "$STUB_LOG"
expect_grep ".env supplies the URL to verify" "https://env.example/" "$WORK/out.txt"
rm -f "$FAKE/.env" "$WORK/out.txt"

# The CLI's own variable name is what the EdgeOne docs use, so a token copied
# from there has to work without being renamed.  No region is needed with it:
# the CLI probes the China and the international API and uses whichever
# accepts the token.
cat > "$FAKE/.env" <<'ENV'
EDGEONE_PROJECT=cli-named
EDGEONE_PAGES_API_TOKEN=CLI-NAMED-TOKEN
ENV
rm -f "$STUB_LOG"
rc=$(run_deploy "$WORK/out.txt" --no-check-url)
expect_grep "the CLI's own token variable name works in .env" "token=CLI-NAMED-TOKEN" "$STUB_LOG"
rm -f "$FAKE/.env" "$WORK/out.txt"

# A mistyped project name does not fail: the CLI silently creates a new
# project, and the real site keeps serving the old build.  That has to be said
# out loud rather than reported as a success.
cat > "$WORK/loud-cli" <<'STUB'
#!/bin/sh
echo "[CreatePagesProject] Creating new project with name: typo in global area"
printf '{"url":"https://typo.example/","deploymentId":"stub-2"}\n'
exit 0
STUB
chmod +x "$WORK/loud-cli"
set +e
EDGEONE_CLI=$WORK/loud-cli sh "$FAKE/tools/deploy_edgeone.sh" -n typo -t TOK --no-check-url \
    > "$WORK/out.txt" 2>&1
rc=$?
set -e
expect_rc "a newly created project still exits 0 (the CLI's behaviour)" 0 "$rc"
expect_grep "but it is reported as a warning, not a success" "CREATED a new one" "$WORK/out.txt"
rm -f "$WORK/out.txt"

echo
if [ "$fail" != 0 ]; then
    printf '[verify_deploy] FAILED: %d/%d checks failed\n' "$fail" "$((pass + fail))"
    exit 1
fi
printf '[verify_deploy] OK -- %d checks\n' "$pass"
