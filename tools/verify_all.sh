#!/bin/sh
# Run every acceptance suite in dependency order.
#
#   sh tools/verify_all.sh [game-dir]
#
# Each stage builds on the one before it, so a failure here says exactly how far
# the pipeline is trustworthy:
#
#   verify_mix      the C++ MIX layer agrees with the verified Python reader
#   verify_extract  it materialises the same loose-file tree the generator reads
#   verify_oracle   the reference pipeline produces a rich, deterministic map
#   verify_wasm     the same pipeline in wasm is byte-identical to native
#   verify_webapi   the browser entry-point contract holds, byte-identically,
#                   and (with --render) the worker's flatten+render flow produces
#                   a preview pixel-identical to the reference render
#   verify_render   the extracted loose tree renders identically to the .mix files
#   verify_uicontract  the page and the worker agree on their message vocabulary
#   verify_browser  the REAL page, in a real browser: generate and render
#
# Set MG_SKIP_BUILD=1 to reuse whatever is already in build/.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
GAME=${1:-}
cd "$ROOT"

fail=0
step() {
    name=$1
    shift
    printf '%-16s ' "$name"
    if "$@" > "/tmp/verify_$name.log" 2>&1; then
        tail -1 "/tmp/verify_$name.log"
    else
        echo "FAILED (see /tmp/verify_$name.log)"
        tail -20 "/tmp/verify_$name.log"
        fail=1
    fi
}

# ---- builds ---------------------------------------------------------------
if [ "${MG_SKIP_BUILD:-0}" != "1" ]; then
    echo "[verify] building the native oracle"
    sh engine/build_oracle.sh > /tmp/verify_build_native.log 2>&1 \
        || { echo "  native build failed; see /tmp/verify_build_native.log"; exit 1; }

    echo "[verify] building the wasm console"
    if [ -x "$HOME/opt/emscripten/usr/share/emscripten/emcc" ]; then
        sh -c '. tools/emenv.sh && sh engine/build_wasm.sh' > /tmp/verify_build_wasm.log 2>&1 \
            || { echo "  wasm build failed; see /tmp/verify_build_wasm.log"; exit 1; }
        sh -c '. tools/emenv.sh && sh engine/build_web.sh' > /tmp/verify_build_web.log 2>&1 \
            || { echo "  web build failed; see /tmp/verify_build_web.log"; exit 1; }
        # A second, node-flavoured build of the same sources, so the contract test
        # can drive it; the shipped artifact must stay browser-only.
        sh -c '. tools/emenv.sh && MG_WEB_ENV=worker,node MG_WEB_STAGE=0 \
                sh engine/build_web.sh build/engine-web-node' \
            > /tmp/verify_build_webnode.log 2>&1 \
            || { echo "  node web build failed; see /tmp/verify_build_webnode.log"; exit 1; }
    fi
    if [ -f reference_impl/ccmaps-net/CNCMaps.Renderer/CNCMaps.Renderer.csproj ] \
            && [ -x "$HOME/opt/dotnet-apt/usr/bin/dotnet" ]; then
        MG_RENDER_STAGE=0 sh engine/build_render_web.sh build/ccmaps-web \
            > /tmp/verify_build_render.log 2>&1 \
            || echo "  (renderer build failed; see /tmp/verify_build_render.log)"
    else
        echo "  (emscripten not installed; skipping the wasm targets)"
    fi
fi

# ---- a native oracle map for the byte comparisons -------------------------
if [ ! -f build/oracle_assets/oracle.map ] && [ -x build/engine/mgextract ]; then
    GD=${GAME:-$(python3 -c 'import sys;sys.path.insert(0,".");from maptools.game_dir import find_game_dir;print(find_game_dir() or "")')}
    if [ -n "$GD" ]; then
        echo "[verify] materialising the oracle map"
        sh engine/build_oracle.sh > /dev/null 2>&1 || true
        ./build/engine/mgextract --game-dir "$GD" --out build/oracle_assets --theater 0 > /dev/null
        ./build/engine/mgconsole --root "$ROOT/build/oracle_assets" --land 1 --theater 0 \
            --size 1 --players 2 --seed 20260913 \
            --out "$ROOT/build/oracle_assets/oracle.map" > /dev/null 2>&1
    fi
fi

# ---- suites ---------------------------------------------------------------
if [ -n "$GAME" ]; then
    step verify_mix     python3 tools/verify_mix.py --game-dir "$GAME"
    step verify_extract python3 tools/verify_extract.py --game-dir "$GAME"
    step verify_oracle  python3 tools/verify_oracle.py --game-dir "$GAME"
else
    step verify_mix     python3 tools/verify_mix.py
    step verify_extract python3 tools/verify_extract.py
    step verify_oracle  python3 tools/verify_oracle.py
fi

if [ -f build/engine-wasm/mgconsole.js ]; then
    if [ -n "$GAME" ]; then
        step verify_wasm python3 tools/verify_wasm.py --game-dir "$GAME"
    else
        step verify_wasm python3 tools/verify_wasm.py
    fi
fi

if [ -f build/engine-web-node/mg_engine.js ]; then
    GD=${GAME:-$(python3 -c 'import sys;sys.path.insert(0,".");from maptools.game_dir import find_game_dir;print(find_game_dir() or "")')}
    RENDER_ARGS=""
    if [ -d build/ccmaps-web/_framework ]; then
        RENDER_ARGS="--render build/ccmaps-web --preview build/render_test/worker_flow.png"
    fi
    # shellcheck disable=SC2086
    step verify_webapi node tools/verify_webapi.mjs \
        --web build/engine-web-node --game "$GD" --assets build/oracle_assets \
        --product webapp $RENDER_ARGS
fi

# The render path needs the reference renderer and the .NET SDK, neither of which
# is present everywhere.
if [ -f reference_impl/ccmaps-net/CNCMaps.Renderer/CNCMaps.Renderer.csproj ]; then
    if [ -n "$GAME" ]; then
        step verify_render python3 tools/verify_render.py --game-dir "$GAME"
    else
        step verify_render python3 tools/verify_render.py
    fi
fi

# Cheap and textual, but it catches the exact defect that shipped once: the
# worker posted `preview` and the page's switch had no case for it, so rendering
# worked and the page showed nothing.
step verify_uicontract python3 tools/verify_uicontract.py

# The real thing: a browser driving the real page.  Three separate defects
# reached the user because everything else here runs the engine in node, where
# there is no worker, no FileReaderSync and no browser environment detection.
# Skipped when no browser is installed rather than failing the run.
CHROME_BIN=$(find "$HOME/opt/chrome" -name chrome -type f 2>/dev/null | head -1)
if [ -n "$CHROME_BIN" ] && [ -d node_modules/puppeteer-core ]; then
    GD=${GAME:-$(python3 -c 'import sys;sys.path.insert(0,".");from maptools.game_dir import find_game_dir;print(find_game_dir() or "")')}
    if [ -n "$GD" ]; then
        # The page fetches the archives itself; a webkitdirectory input cannot be
        # populated from a test harness.  Same origin, so no CORS.
        ln -sfn "$GD" webapp/game
        step verify_browser node tools/verify_browser.mjs \
            --game "$GD" --gameurl /game/ --shot build/render_test/page.png
    fi
else
    echo "verify_browser   (skipped: no chromium or puppeteer-core; see tools/fetch_chromium.sh)"
fi

echo
if [ "$fail" != "0" ]; then
    echo "FAILED -- see the logs above"
    exit 1
fi
echo "OK -- every acceptance suite passed"
