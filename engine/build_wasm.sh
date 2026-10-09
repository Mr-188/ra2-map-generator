#!/bin/sh
# Build the same console pipeline for WebAssembly, so the browser port can be
# checked against the native oracle BEFORE any browser code exists.
#
# The point of this target is verification: compiled with NODERAWFS it runs under
# node against the same extraction tree, and `tools/verify_wasm.py` then requires
# its map to be byte-identical to the native build's.  A faithful result here
# means the later browser front end only has to swap the filesystem backend, not
# the algorithm.
#
#   sh engine/build_wasm.sh [output-dir]
#
# Needs em++ on PATH (see tools/fetch_emscripten.sh).
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REF=${MG_REFERENCE_DIR:-$ROOT/reference_impl/src/MapGenerator}
OUT=${1:-$ROOT/build/engine-wasm}

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

# -sALLOW_MEMORY_GROWTH : the generator allocates freely
# -sSTACK_SIZE          : the sources keep several MAX_PATH buffers on the stack
# -fexceptions          : std::vector and friends
# -sNODERAWFS=1         : node reads the real extraction tree directly, so the
#                         native and wasm runs see identical input
# -sEXIT_RUNTIME=1      : propagate main()'s return code to the shell
FLAGS="-std=c++17 -O2 -w"
EMFLAGS="-sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=8MB -sINITIAL_MEMORY=256MB \
 -fexceptions -sNODERAWFS=1 -sEXIT_RUNTIME=1 -sENVIRONMENT=node \
 -sFORCE_FILESYSTEM=1"

echo "[wasm] compiling engine + shim + reference + driver"
"$EMXX" $FLAGS $EMFLAGS \
    -I"$ROOT/engine/src/win32" -I"$ROOT/engine/src" -I"$REF" \
    "$ROOT/engine/src/win32/win32_compat.cpp" \
    "$ROOT/engine/src/ini.cpp" \
    "$ROOT/engine/src/byte_source.cpp" \
    "$ROOT/engine/src/blowfish.cpp" \
    "$ROOT/engine/src/mix.cpp" \
    "$ROOT/engine/src/extract.cpp" \
    "$REF"/MapGen*.cpp "$REF"/pch.cpp \
    "$ROOT/engine/tools/mgconsole.cpp" \
    -o "$OUT/mgconsole.js"

echo "[wasm] built $OUT/mgconsole.js"
ls -la "$OUT"/mgconsole.* 2>/dev/null || true
