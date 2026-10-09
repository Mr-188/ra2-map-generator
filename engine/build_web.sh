#!/bin/sh
# Build the browser module: the same engine + Win32 shim + reference core, but
# with engine/tools/wasm_entry.cpp as the entry point instead of mgconsole.
#
# Unlike build_wasm.sh this one has no NODERAWFS.  The picked game archives stay
# on the JS side and are sliced on demand through the ByteSource factory
# installed by mg_set_root(); only the extracted loose-file tree (about 9 MB)
# lands in MEMFS.
#
#   sh engine/build_web.sh [output-dir]
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REF=${MG_REFERENCE_DIR:-$ROOT/reference_impl/src/MapGenerator}
OUT=${1:-$ROOT/build/engine-web}

# The BROWSER artifact must be built with `worker` alone.  Adding `node` makes
# Emscripten emit a top-level `import { createRequire } from 'module'`, which
# throws in a browser and kills the worker before it ever fetches the .wasm --
# the page then just sits there with a disabled button.  The node-flavoured
# build exists only so tools/verify_webapi.mjs can drive the same sources:
#
#   MG_WEB_ENV=worker,node MG_WEB_STAGE=0 sh engine/build_web.sh build/engine-web-node
ENVIRONMENTS=${MG_WEB_ENV:-worker}
STAGE=${MG_WEB_STAGE:-1}

if [ ! -d "$REF" ]; then
    echo "reference sources not found: $REF" >&2
    exit 2
fi

# Our drivers call RandomMapGenerator::SizeSliderRange, which only exists once
# engine/reference_patches/ has been applied.  Say so plainly instead of letting
# the compiler produce "no member named 'SizeSliderRange'".
if ! grep -q 'SizeSliderRange' "$REF/MapGen.h" 2>/dev/null; then
    echo "the reference sources lack this repository's patches" >&2
    echo "  run: sh tools/apply_reference_patches.sh" >&2
    exit 2
fi

EMXX=${EMXX:-em++}
if ! command -v "$EMXX" >/dev/null 2>&1; then
    echo "$EMXX not on PATH; run tools/fetch_emscripten.sh and add it" >&2
    exit 2
fi

mkdir -p "$OUT"

FLAGS="-std=c++17 -O2 -w"
EMFLAGS="-sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=8MB -sINITIAL_MEMORY=64MB \
 -fexceptions -sFORCE_FILESYSTEM=1 -sENVIRONMENT=$ENVIRONMENTS \
 -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createMgEngine \
 -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPU8,FS \
 -sEXPORTED_FUNCTIONS=_mg_add_file,_mg_set_root,_mg_extract,_mg_generate,_mg_read_output,_mg_error,_mg_output_path,_mg_size_useful_max,_mg_size_legal_max,_mg_size_step,_mg_rect_max_sum,_malloc,_free"

echo "[web] compiling the browser module"
"$EMXX" $FLAGS $EMFLAGS \
    -I"$ROOT/engine/src/win32" -I"$ROOT/engine/src" -I"$REF" \
    "$ROOT/engine/src/win32/win32_compat.cpp" \
    "$ROOT/engine/src/ini.cpp" \
    "$ROOT/engine/src/byte_source.cpp" \
    "$ROOT/engine/src/blowfish.cpp" \
    "$ROOT/engine/src/mix.cpp" \
    "$ROOT/engine/src/extract.cpp" \
    "$REF"/MapGen*.cpp "$REF"/pch.cpp \
    "$ROOT/engine/tools/wasm_entry.cpp" \
    -o "$OUT/mg_engine.js"

if [ "$STAGE" = "1" ]; then
    # The page imports ./mg_engine.js from the worker, so the artifacts have to
    # sit next to webapp/worker.js.  They are build output; webapp/ ignores them.
    cp "$OUT/mg_engine.js"   "$ROOT/webapp/mg_engine.js"
    cp "$OUT/mg_engine.wasm" "$ROOT/webapp/mg_engine.wasm"
    printf '{\n  "type": "module"\n}\n' > "$ROOT/webapp/package.json"
    echo "[web] built $OUT/mg_engine.js (+ .wasm) and staged them into webapp/"
    # A browser artifact must not carry node-only imports; see the note above.
    if grep -q "from 'module'" "$ROOT/webapp/mg_engine.js"; then
        echo "[web] ERROR: staged artifact imports the node builtin 'module';" >&2
        echo "       rebuild with MG_WEB_ENV=worker (the default)." >&2
        exit 1
    fi
    ls -la "$ROOT/webapp"/mg_engine.* 2>/dev/null | tail -3
else
    echo "[web] built $OUT/mg_engine.js (+ .wasm) (not staged)"
fi
