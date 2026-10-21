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
SRV_PIDS=
cleanup() {
    for p in $SRV_PIDS; do kill "$p" 2>/dev/null || true; done
    rm -rf "$WORK"
}
trap cleanup EXIT

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

# The 备案号 have to be ON the published pages: 《非经营性互联网信息服务备案
# 管理办法》 requires the ICP number at the bottom of the homepage with a link to
# the filing system, and the 公安备案号 the same.  Checked against the source files
# (not the packaged copy) so this also runs on a bare clone, and so a redesign
# that drops the footer fails here rather than in front of 通管局.
#
# BOTH pages, with the SAME numbers: index.html and gallery.html are one site, and a
# footer that exists in two versions drifts.  (The gallery first shipped placeholder
# numbers -- this is the check that would have caught them.)
for needle in "苏ICP备2023037209号-2" "https://beian.miit.gov.cn/" \
              "苏公网安备32081202000454号" "beian.mps.gov.cn/#/query/webSearch?code=32081202000454" \
              "1002834147" "与 EA 无关"; do
    for page in index.html gallery.html; do
        FOOT=$ROOT/webapp/$page
        if grep -qF -- "$needle" "$FOOT" 2>/dev/null; then
            ok "$page carries $needle"
        else
            bad "$page no longer carries $needle"
        fi
    done
done
for page in index.html gallery.html; do
    FOOT=$ROOT/webapp/$page
    if grep -q 'class="foot"' "$FOOT" 2>/dev/null; then
        ok "$page: the filing numbers sit in the footer"
    else
        bad "$page: the filing numbers are not in a <footer class=\"foot\">"
    fi
done

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

    # version.json is what the header badge and a bug report are anchored to.
    # The fingerprints identify the bytes; the version number alone does not.
    if python3 - "$PKG/version.json" <<'PY'
import json, re, sys
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        v = json.load(fh)
except Exception as exc:
    print("  FAIL  version.json missing or unreadable: %s" % exc); sys.exit(1)
want = {"version": r"^\d{4}\.\d{2}\.\d{2}(\.\d+)?$", "builtAt": r"^\d{4}-\d{2}-\d{2}T",
        "engine": r"^[0-9a-f]{16}$", "renderer": r"^[0-9a-f]{16}$"}
bad = [k for k, pat in want.items() if not re.match(pat, str(v.get(k, "")))]
if bad:
    print("  FAIL  version.json has a wrong or missing %s: %s" % (bad, v)); sys.exit(1)
print("  ok    version.json identifies the build (%s, engine %s, %s files)"
      % (v["version"], v["engine"], v.get("files")))
PY
    then
        pass=$((pass + 1))
    else
        fail=$((fail + 1))
    fi

    # A hand-uploaded package (no deploy script) must still have a manifest, or
    # the drawer reports an unreadable list on a site that works fine.
    if python3 - "$PKG/versions.json" <<'PY'
import json, sys
try:
    doc = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as exc:
    print("  FAIL  versions.json missing or unreadable: %s" % exc); sys.exit(1)
vs = doc.get("versions") or []
ok = doc.get("current") and len(vs) >= 1 and vs[0].get("path") == "/"
print("  %s  a plain package still ships a manifest (%s)"
      % ("ok   " if ok else "FAIL ", [e.get("path") for e in vs]))
sys.exit(0 if ok else 1)
PY
    then
        pass=$((pass + 1))
    else
        fail=$((fail + 1))
    fi
else
    printf '  skip  (webapp/mg_engine.wasm or webapp/render/_framework is absent; build first)\n'
fi

echo "[deploy] 2. the release history (versions.sh)"
# ---------------------------------------------------------------- history
# The 历史版本 drawer is only as good as this: a version has to be ARCHIVED when
# it goes live, and put back into the tree under /v/<version>/ when the next one
# is published.  Exercised in a temporary history directory so the real
# build/releases/ is untouched.
HREL=$WORK/releases
mkdir -p "$HREL"
VNEW=2099.01.01
VOLD=2099.01.02
for v in "$VNEW" "$VOLD"; do
    d=$HREL/$v
    mkdir -p "$d/render/_framework"
    echo "<html>$v</html>" > "$d/index.html"
    : > "$d/mg_engine.wasm"
    # A DISTINCT engine fingerprint per version.  A 参数集 carries the top 10 bits of
    # it, and the manifest has to carry it per version, or the page cannot turn "this
    # code came from another build" into "switch to THAT version".
    if [ "$v" = "$VNEW" ]; then eng=30a88bb1c0ffee00; else eng=9f1c02abdeadbeef; fi
    printf '{"version":"%s","commit":"c0ffee1","builtAt":"2099-01-01T00:00:00+0800","engine":"%s"}' \
        "$v" "$eng" > "$d/version.json"
    printf '{"headers":[{"source":"/*.wasm","headers":[{"key":"Content-Type","value":"application/wasm"}]}]}' > "$d/edgeone.json"
done

# A package for VNEW: assemble must bring VOLD in under /v/ and never itself.
HPKG=$WORK/hpkg
mkdir -p "$HPKG"
echo '<html>new</html>' > "$HPKG/index.html"
cp "$HREL/$VNEW/version.json" "$HPKG/version.json"
cp "$HREL/$VNEW/edgeone.json" "$HPKG/edgeone.json"
MG_RELEASES_DIR=$HREL sh "$ROOT/tools/versions.sh" assemble "$HPKG" "$VNEW" \
    > "$WORK/assemble.log" 2>&1 || true

if [ -f "$HPKG/v/$VOLD/index.html" ]; then ok "assemble puts the kept version under /v/<version>/"; else bad "assemble did not copy $VOLD into v/"; fi
if [ -e "$HPKG/v/$VNEW" ]; then bad "assemble copied the version being published into v/ (history would nest)"; else ok "assemble leaves the version being published at the root"; fi
if python3 - "$HPKG/versions.json" "$VNEW" "$VOLD" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    doc = json.load(fh)
cur, old = sys.argv[2], sys.argv[3]
entries = {e["version"]: e for e in doc["versions"]}
paths = {v: e["path"] for v, e in entries.items()}
ok = doc.get("current") == cur and paths.get(cur) == "/" and paths.get(old) == "/v/%s/" % old
# Every entry carries an engine fingerprint, and the historical one carries ITS OWN
# (assemble reads it back out of the archived version.json).  Without it a code from
# an old build could not be resolved to a version to switch back to.
engines = {v: e.get("engine", "") for v, e in entries.items()}
ok = ok and engines.get(cur) == "30a88bb1c0ffee00" and engines.get(old) == "9f1c02abdeadbeef"
print("  %s  manifest: current=%s %s engines=%s"
      % ("ok   " if ok else "FAIL ", doc.get("current"), paths, engines))
sys.exit(0 if ok else 1)
PY
then ok "the manifest names the current version, the historical path, and both engines"; else bad "the manifest is wrong"; fi
if python3 - "$HPKG/edgeone.json" "$VOLD" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding="utf-8"))
old = sys.argv[2]
sources = {r["source"]: r for r in cfg.get("headers", [])}
want = ["/v/%s/*.wasm" % old, "/v/%s/render/_framework/*.wasm" % old]
missing = [s for s in want if s not in sources]
multistar = [s for s in sources if s.count("*") > 1]
ok = not missing and not multistar
print("  %s  wasm rules for the historical version%s" %
      ("ok   " if ok else "FAIL ", "" if ok else " (missing %s / bad %s)" % (missing, multistar)))
sys.exit(0 if ok else 1)
PY
then ok "a historical .wasm gets its own Content-Type rule (one * per pattern)"; else bad "the historical wasm rules are wrong"; fi

# Archive must not nest: v/ and versions.json stay out of the kept copy.
cat > "$HPKG/versions.json" <<'JSON'
{"current":"x","versions":[]}
JSON
mkdir -p "$HPKG/v/$VOLD"
MG_RELEASES_DIR=$HREL sh "$ROOT/tools/versions.sh" archive "$HPKG" "$VNEW" \
    > "$WORK/archive.log" 2>&1 || true
if [ -e "$HREL/$VNEW/v" ]; then bad "archive nested v/ inside the kept version"; else ok "archive keeps v/ out (no nesting)"; fi
if [ -e "$HREL/$VNEW/versions.json" ]; then bad "archive kept a stale versions.json"; else ok "archive drops the regenerated versions.json"; fi

# The version scheme itself: a date, and a counter for a second release that day.
if v=$(sh "$ROOT/tools/versions.sh" next) && printf '%s' "$v" | grep -Eq '^[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]+)?$'; then
    ok "the next version is a date ($v)"
else
    bad "versions.sh next printed '$v'"
fi

# The page has to have somewhere to SHOW all this, or the history is invisible.
PAGE=$ROOT/webapp/index.html
JS=$ROOT/webapp/app.js
for needle in 'id="ver"' 'id="hist-open"' 'id="hist"' 'id="ver-list"' '历史版本'; do
    if grep -qF -- "$needle" "$PAGE" 2>/dev/null; then ok "index.html has the version UI: $needle"; else bad "index.html lost $needle"; fi
done
for needle in "version.json" "versions.json"; do
    if grep -qF -- "$needle" "$JS" 2>/dev/null; then ok "app.js reads $needle"; else bad "app.js no longer reads $needle"; fi
done

echo "[deploy] 3. edgeone.json rules the host will actually accept"
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

echo "[deploy] 4. what deploy_edgeone.sh refuses, and what it sends"
# --------------------------------------------------------------- sandbox
FAKE=$WORK/fake
mkdir -p "$FAKE/tools" "$FAKE/engine/src" "$FAKE/webapp/render/_framework"
# versions.sh ships next to it: deploy_edgeone.sh asks it for the version and
# for the assemble step, and a missing sibling makes the whole run fail before
# any of the behaviour under test happens.
cp "$ROOT/tools/deploy_edgeone.sh" "$FAKE/tools/"
cp "$ROOT/tools/versions.sh" "$FAKE/tools/"

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
    # Valid JSON, not an empty file: `versions.sh assemble` extends this config
    # with the per-version wasm rules and refuses to guess when it cannot parse
    # it (a corrupt host config should fail the deploy, not be silently ignored).
    printf '{"headers":[{"source":"/*.wasm","headers":[{"key":"Content-Type","value":"application/wasm"}]}]}\n' \
        > "$FAKE/webapp/edgeone.json"
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

# A preview deployment is served from a temporary SIGNED url that only works
# from the console session, so EDGEONE_URL (the production domain) says nothing
# about it: checking production after a preview deploy reports the OLD site and
# looks like the deploy failed.  Preview must be reported and checked at the URL
# the CLI hands back, unless -u says otherwise.
cat > "$FAKE/.env" <<'ENV'
EDGEONE_PROJECT=proj
EDGEONE_URL=https://prod.example/
EDGEONE_API_TOKEN=TOK
ENV
rm -f "$STUB_LOG"
rc=$(run_deploy "$WORK/out.txt" -e preview --no-check-url)
expect_rc "a preview deploy succeeds" 0 "$rc"
expect_grep "the preview is reported at the CLI's URL, not the production domain" \
            "live at https://stub.example/" "$WORK/out.txt"
expect_no_grep "the production domain is not reported for a preview" \
               "live at https://prod.example/" "$WORK/out.txt"
rc=$(run_deploy "$WORK/out.txt" --no-check-url)
expect_grep "a production deploy is reported at EDGEONE_URL" \
            "live at https://prod.example/" "$WORK/out.txt"
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

echo "[deploy] 5. the deployed checker, against a real server"
# verify_deployed.sh is what decides whether a deployment is good, so it is
# worth testing itself rather than trusting it: a wrong verdict here is what
# lets a broken site through.  A local server serving exactly the 13 assets it
# checks (with the Content-Types the host must use) is enough to pin three
# things: a good deployment passes, a signed (query-string) URL is assembled
# with the query after the path, and a .wasm served as octet-stream is caught --
# the defect that makes the browser refuse to instantiate the engine.
SRV=$WORK/srv
for f in index.html ra2.ico app.js worker.js sharebits.js gallery.html gallery.js gallery.txt \
         mg_engine.js mg_engine.wasm package.json \
         render/package.json render/CNCMaps.Renderer.runtimeconfig.json \
         render/_framework/dotnet.js render/_framework/dotnet.native.js \
         render/_framework/dotnet.native.wasm render/_framework/CNCMaps.Engine.wasm \
         render/_framework/System.Private.CoreLib.wasm; do
    mkdir -p "$SRV/$(dirname "$f")"
    : > "$SRV/$f"
done
# The homepage is not an empty file in reality: verify_deployed.sh also checks
# that the 备案号 are actually SERVED (a build that lost the footer passes every
# asset check), so this fixture has to carry them -- on BOTH pages, since the check
# looks at both -- or "a correctly served site passes" fails for the right reason at
# the wrong time.
cat > "$SRV/index.html" <<'HTML'
<!doctype html><html lang="zh-CN"><head><title>fixture</title></head><body>
<h1>RA2 / YR 随机地图生成器 <span class="ver" id="ver" hidden></span></h1>
<button type="button" id="hist-open">历史版本</button>
<footer class="foot">
  <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener">苏ICP备2023037209号-2</a>
  <a href="https://beian.mps.gov.cn/#/query/webSearch?code=32081202000454" target="_blank" rel="noopener">苏公网安备32081202000454号</a>
  反馈与交流：QQ 群 1002834147
  非官方作品，与 EA 无关。
</footer>
</body></html>
HTML
cat > "$SRV/gallery.html" <<'HTML'
<!doctype html><html lang="zh-CN"><head><title>fixture gallery</title></head><body>
<footer class="foot">
  <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener">苏ICP备2023037209号-2</a>
  <a href="https://beian.mps.gov.cn/#/query/webSearch?code=32081202000454" target="_blank" rel="noopener">苏公网安备32081202000454号</a>
  反馈与交流：QQ 群 1002834147
  非官方作品，与 EA 无关。
</footer>
</body></html>
HTML
# The version files, and the historical copy they point at: verify_deployed.sh
# checks that every version the manifest lists actually answers, so the fixture
# has to look like a real deployment (one current + one historical) rather than
# a directory of empty files.
printf '{"version":"2099.01.01","commit":"c0ffee1","builtAt":"2099-01-01T00:00:00+0800","engine":"0123456789abcdef","renderer":"fedcba9876543210"}\n' \
    > "$SRV/version.json"
mkdir -p "$SRV/v/2098.12.31"
printf '<!doctype html><html lang="zh-CN"><body><span id="ver"></span>历史版本</body></html>\n' \
    > "$SRV/v/2098.12.31/index.html"
# Each served version carries its OWN engine id, and the manifest entry has to
# agree with it: the page sends a player to a version on the strength of that
# number, so a mismatch here would be a switch that lands somewhere the 参数集
# still does not match.
printf '{"version":"2098.12.31","commit":"beefbeef","builtAt":"2098-12-31T00:00:00+0800","engine":"fedcba9876543210"}\n' \
    > "$SRV/v/2098.12.31/version.json"
cat > "$SRV/versions.json" <<'JSON'
{
  "current": "2099.01.01",
  "versions": [
    { "version": "2099.01.01", "builtAt": "2099-01-01T00:00:00+0800", "commit": "c0ffee1", "path": "/", "engine": "0123456789abcdef" },
    { "version": "2098.12.31", "builtAt": "2098-12-31T00:00:00+0800", "commit": "beefbeef", "path": "/v/2098.12.31/", "engine": "fedcba9876543210" }
  ]
}
JSON
cat > "$WORK/serve.py" <<'PY'
import functools, http.server, socketserver, sys
port, root, mode = int(sys.argv[1]), sys.argv[2], sys.argv[3]
types = {"application/wasm" if mode == "good" else "application/octet-stream":
         [".wasm"], "text/javascript": [".js"],
         "application/json": [".json"], "text/html": [".html"],
         "image/x-icon": [".ico"], "text/plain": [".txt"]}
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {}
    def log_message(self, *a): pass
for ctype, exts in types.items():
    for ext in exts:
        H.extensions_map[ext] = ctype
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", port), functools.partial(H, directory=root)) as s:
    s.serve_forever()
PY

start_server() {   # start_server <port> <mode>; 1 if it never came up
    python3 "$WORK/serve.py" "$1" "$SRV" "$2" &
    p=$!
    SRV_PIDS="$SRV_PIDS $p"
    i=0
    while [ "$i" -lt 60 ]; do
        curl -sS -o /dev/null "http://127.0.0.1:$1/" 2>/dev/null && return 0
        i=$((i + 1))
        sleep 0.1
    done
    return 1
}

PORT=8931
if start_server "$PORT" good; then
    set +e
    sh "$ROOT/tools/verify_deployed.sh" "http://127.0.0.1:$PORT/" > "$WORK/vd.txt" 2>&1; rc=$?
    set -e
    expect_rc "a correctly served site passes the deployed check" 0 "$rc"
    set +e
    sh "$ROOT/tools/verify_deployed.sh" "http://127.0.0.1:$PORT/?eo_token=abc&eo_time=1" \
        > "$WORK/vd-signed.txt" 2>&1; rc=$?
    set -e
    expect_rc "a signed (query-string) url is checked, query after the path" 0 "$rc"
    expect_grep "the signed check reports the assets it found" "mg_engine.wasm" "$WORK/vd-signed.txt"
else
    bad "a local test server could not be started on port $PORT"
fi

PORT=8932
if start_server "$PORT" badwasm; then
    set +e
    sh "$ROOT/tools/verify_deployed.sh" "http://127.0.0.1:$PORT/" > "$WORK/vd-bad.txt" 2>&1; rc=$?
    set -e
    expect_rc "a .wasm served as octet-stream fails the deployed check" 1 "$rc"
    expect_grep "and the failure names the wasm Content-Type" \
                "want application/wasm" "$WORK/vd-bad.txt"
else
    bad "a local test server could not be started on port $PORT"
fi

echo
if [ "$fail" != 0 ]; then
    printf '[verify_deploy] FAILED: %d/%d checks failed\n' "$fail" "$((pass + fail))"
    exit 1
fi
printf '[verify_deploy] OK -- %d checks\n' "$pass"
