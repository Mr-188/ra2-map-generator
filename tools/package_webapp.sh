#!/bin/sh
# Build a deployable copy of the page.
#
#   sh tools/package_webapp.sh [out-dir]
#
# Produces a directory (and a zip beside it) containing EXACTLY what a browser
# needs and nothing else -- in particular not the `game` symlink the browser test
# uses to feed a local install over HTTP, and not the capability probe.
#
# The page is 16 MB across 68 files: the generator engine is 0.7 MB, the map
# renderer (CNCMaps compiled to browser-wasm) is 15 MB.  Both are static assets;
# there is no backend and nothing is uploaded.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-$ROOT/build/webapp}

rm -rf "$OUT"
mkdir -p "$OUT/render"

# The page itself.
cp "$ROOT/webapp/index.html" "$OUT/"
cp "$ROOT/webapp/app.js"     "$OUT/"
cp "$ROOT/webapp/worker.js"  "$OUT/"

# The generator engine (engine/build_web.sh stages these).
if [ ! -f "$ROOT/webapp/mg_engine.wasm" ]; then
    echo "[package] webapp/mg_engine.wasm is missing; run engine/build_web.sh" >&2
    exit 1
fi
cp "$ROOT/webapp/mg_engine.js"   "$OUT/"
cp "$ROOT/webapp/mg_engine.wasm" "$OUT/"
# Node needs to be told the module is ESM; harmless in a browser.
cp "$ROOT/webapp/package.json"   "$OUT/"

# The renderer (engine/build_render_web.sh stages these).
if [ ! -d "$ROOT/webapp/render/_framework" ]; then
    echo "[package] webapp/render/ is missing; run engine/build_render_web.sh" >&2
    exit 1
fi
cp -r "$ROOT/webapp/render/_framework" "$OUT/render/_framework"
cp "$ROOT/webapp/render/package.json" "$OUT/render/"
cp "$ROOT/webapp/render/CNCMaps.Renderer.runtimeconfig.json" "$OUT/render/"

# Emscripten records which source file each inlined block came from, as
# `// include: /home/<builder>/.dotnet/packs/...` comments.  They are inert, but
# they leak the build machine's layout into a public artifact, so they are
# rewritten to a neutral root.  Only comments contain them -- the browser test
# runs against this packaged copy precisely to prove that.
HOME_DIR_EARLY=$(cd ~ && pwd)
find "$OUT" -name '*.js' -type f -exec \
    sed -i "s|$HOME_DIR_EARLY|/build|g" {} +

# GitHub Pages runs Jekyll unless told not to, and Jekyll silently DROPS any
# directory whose name starts with an underscore -- which is where the .NET
# runtime puts every one of its assemblies (`render/_framework`).  A 404 on 59
# files that are plainly present in the branch is a confusing way to find out.
: > "$OUT/.nojekyll"

# Nothing may point back at this machine.
#
# The patterns are deliberately narrow.  A bare /home/ match flags Emscripten's
# own `FS.mkdir("/home/web_user")`, which is part of its virtual filesystem and
# has to be there; a bare "localhost" match flags comments in the .NET runtime.
# What actually breaks a deployment is this machine's home directory or a host
# baked into a URL.
HOME_DIR=$(cd ~ && pwd)
BAD=$(grep -rlE "$HOME_DIR|https?://(127\.0\.0\.1|localhost)" "$OUT" \
        --include='*.js' --include='*.html' 2>/dev/null || true)
if [ -n "$BAD" ]; then
    echo "[package] ERROR: the copy contains this machine's home or a local URL:" >&2
    echo "$BAD" >&2
    exit 1
fi
if [ -e "$OUT/game" ]; then
    echo "[package] ERROR: the test-only game symlink was copied" >&2
    exit 1
fi

COUNT=$(find "$OUT" -type f | wc -l)
SIZE=$(du -sh "$OUT" | cut -f1)
# No `zip` on this machine; python3 is already a dependency of the project.
ZIP="$OUT.zip"
rm -f "$ZIP"
python3 - "$OUT" "$ZIP" <<'PY'
import os, sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
base = os.path.dirname(src)
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    # Entries are stored at the ROOT of the archive, not under a wrapper
    # directory: static hosts that accept a zip extract it in place, and a
    # wrapper folder would put the whole site one level too deep.
    for root, _dirs, files in os.walk(src):
        for name in files:
            full = os.path.join(root, name)
            z.write(full, os.path.relpath(full, src))
PY

echo "[package] $OUT  ($COUNT files, $SIZE)"
echo "[package] $ZIP  ($(du -h "$ZIP" | cut -f1))"
echo
echo "This is a STATIC site.  To use it on another machine with the game"
echo "installed, serve the directory over http -- opening index.html from the"
echo "filesystem will not work, because a file:// origin cannot create a Worker"
echo "and cannot fetch a .wasm:"
echo
echo "  python3 -m http.server 8017 --directory $OUT"
echo
echo "or upload it to any static host (GitHub Pages, Cloudflare Pages, ...) and"
echo "open the URL.  The player picks their own game folder; nothing is uploaded."
