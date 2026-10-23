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
# 参数集 (the share code) is imported by app.js as a module, so a deploy that
# forgets it serves a page whose 生成地图 button never works.  Copied by name like
# everything else here - see the note under ra2.ico.
cp "$ROOT/webapp/sharebits.js" "$OUT/"
# 出生点编辑 (the preview's start-point editor).  app.js imports it, so a deploy
# that forgets it breaks the module graph and the page never boots at all.
cp "$ROOT/webapp/starts.js" "$OUT/"
# 矿石绘制 (the preview's ore brush).  Same rule: app.js imports it; a missing
# module means the whole page fails to boot (not just the brush).
cp "$ROOT/webapp/ore.js" "$OUT/"
# 中立建筑放置 (the preview's building brush).  Same rule again.
cp "$ROOT/webapp/buildings.js" "$OUT/"
# 地图编辑器 (a separate page) and the generator -> editor handoff.
cp "$ROOT/webapp/editor.html" "$OUT/"
cp "$ROOT/webapp/editor.js"   "$OUT/"
cp "$ROOT/webapp/mapstore.js" "$OUT/"
# 画廊: a page plus the one file it reads.  The generator's header links to it, so a
# deploy that forgets these ships a 404 behind that link (and a gallery that cannot
# read its own list).
cp "$ROOT/webapp/gallery.html" "$OUT/"
cp "$ROOT/webapp/gallery.js"   "$OUT/"
cp "$ROOT/webapp/gallery.txt"  "$OUT/"

# The tab / header icon.  This one file IS a retail game asset and is here as an
# explicit, authorised exception to AGENTS.md rule 1 (see the note there and in
# webapp/index.html): the user asked for the RA2 icon itself and authorised it on
# 2026-10-12.  Keep it in this list - the deploys copy files by name, so dropping
# the line silently ships a page whose favicon 404s.
cp "$ROOT/webapp/ra2.ico"    "$OUT/"

# Host configuration, read by `edgeone makers deploy`: it pins
# `Content-Type: application/wasm` for the engine and the renderer (a wasm
# served as application/octet-stream is refused by streaming instantiation),
# and keeps the small entry files revalidating while the 14 MB renderer caches.
# Shipped inside the site so that it is found whether the CLI reads it from the
# working directory or from the directory being deployed.
cp "$ROOT/webapp/edgeone.json" "$OUT/"

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

# ---- version.json ----------------------------------------------------------
# What this build is, so a player can say which one they are on and so the page
# can show it in the header.  The version is passed in by tools/versions.sh
# (tools/deploy_edgeone.sh asks it for the next one); standing alone, this
# script falls back to today's date, which is the same scheme.
#
# The fingerprints are the part that actually identifies the bytes: a version
# number can be reused or forgotten, but "engine 30a88bb1" is either the wasm
# that is deployed or it is not.  `dirty` records that the build came from a
# working tree that is not exactly a commit -- which is the normal case here,
# and worth knowing when a report does not reproduce from the repository.
MG_VERSION=${MG_VERSION:-$(date +%Y.%m.%d)}
MG_NOTE=${MG_NOTE:-}
export MG_VERSION MG_NOTE
python3 - "$OUT" "$ROOT" <<'PY'
import hashlib, json, os, subprocess, sys, time

out, root = sys.argv[1], sys.argv[2]

def sha8(path):
    try:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()[:16]
    except OSError:
        return ""

def git(*args):
    try:
        return subprocess.run(("git",) + args, cwd=root, capture_output=True,
                              text=True, timeout=10).stdout.strip()
    except Exception:
        return ""

total = 0
count = 0
for base, _dirs, files in os.walk(out):
    for name in files:
        try:
            total += os.path.getsize(os.path.join(base, name))
        except OSError:
            pass
        count += 1

info = {
    "version": os.environ.get("MG_VERSION", ""),
    "note": os.environ.get("MG_NOTE", ""),
    "commit": git("rev-parse", "--short", "HEAD"),
    "dirty": bool(git("status", "--porcelain")),
    "builtAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    "engine": sha8(os.path.join(out, "mg_engine.wasm")),
    "renderer": sha8(os.path.join(out, "render", "_framework", "CNCMaps.Engine.wasm")),
    # The two metadata files this block is about to write are part of the
    # package, so count them: a number that is off by two is the kind of detail
    # somebody later trusts.
    "files": count + 2,
    "bytes": total,
}
with open(os.path.join(out, "version.json"), "w", encoding="utf-8") as fh:
    json.dump(info, fh, ensure_ascii=False, indent=2)
    fh.write("\n")

# A manifest with just this version, so a package that is uploaded by hand (the
# console's drag-and-drop, without tools/deploy_edgeone.sh) still has a working
# 历史版本 drawer instead of one that says the list is unreadable.  The deploy
# path overwrites this with the full list in tools/versions.sh assemble -- which
# is also why an archived version drops the file: it would be stale there.
manifest = {
    "current": info["version"],
    "versions": [dict(info, path="/")],
}
with open(os.path.join(out, "versions.json"), "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
print("[package] version %s%s (commit %s%s, engine %s)"
      % (info["version"], " " + info["note"] if info["note"] else "",
         info["commit"] or "?", ", dirty" if info["dirty"] else "",
         info["engine"] or "?"))
PY

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
