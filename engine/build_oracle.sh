#!/bin/sh
# Build the local oracle: the reference implementation's core translation units
# linked against this repository's Win32 shim and console driver.
#
# The reference sources are deliberately NOT part of this repository -- they
# carry no licence and bundle proprietary game assets.  They live in
# reference_impl/ (git-ignored) and are used here only to produce ground truth
# for the port.  Nothing this script builds is shipped.
#
#   sh engine/build_oracle.sh [output-dir]
#
# Override the source location with MG_REFERENCE_DIR.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REF=${MG_REFERENCE_DIR:-$ROOT/reference_impl/src/MapGenerator}
OUT=${1:-$ROOT/build/engine}

if [ ! -d "$REF" ]; then
    echo "reference sources not found: $REF" >&2
    echo "  clone them into reference_impl/ (git-ignored), or set MG_REFERENCE_DIR" >&2
    exit 2
fi

mkdir -p "$OUT/obj"

CXX=${CXX:-g++}
FLAGS="-std=c++17 -O2 -w -I$ROOT/engine/src/win32 -I$ROOT/engine/src -I$REF"

echo "[oracle] compiling this repository's shim and engine"
for src in \
    "$ROOT/engine/src/win32/win32_compat.cpp" \
    "$ROOT/engine/src/ini.cpp" \
    "$ROOT/engine/src/byte_source.cpp" \
    "$ROOT/engine/src/blowfish.cpp" \
    "$ROOT/engine/src/mix.cpp" \
    "$ROOT/engine/src/extract.cpp"
do
    obj="$OUT/obj/$(basename "$src" .cpp).o"
    $CXX $FLAGS -c "$src" -o "$obj"
done

echo "[oracle] compiling the reference implementation's core (WinMain.cpp excluded)"
for src in "$REF"/MapGen*.cpp "$REF"/pch.cpp; do
    [ -f "$src" ] || continue
    obj="$OUT/obj/ref_$(basename "$src" .cpp).o"
    $CXX $FLAGS -c "$src" -o "$obj"
done

# Every CLI that links the engine core, not just the generator driver: leaving
# one out means a source change is silently not exercised, which cost a round of
# debugging when mgextract kept running pre-patch logic.
echo "[oracle] linking the CLIs"
$CXX $FLAGS -o "$OUT/mgconsole" \
    "$ROOT/engine/tools/mgconsole.cpp" \
    "$OUT"/obj/*.o -lm
$CXX $FLAGS -o "$OUT/mgextract" \
    "$ROOT/engine/tools/mgextract.cpp" \
    "$OUT"/obj/*.o -lm
$CXX $FLAGS -o "$OUT/mixinfo" \
    "$ROOT/engine/tools/mixinfo.cpp" \
    "$OUT"/obj/*.o -lm

echo "[oracle] built mgconsole, mgextract, mixinfo"
