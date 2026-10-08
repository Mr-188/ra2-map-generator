#!/bin/sh
# Build the RENDERING half of the product: CNCMaps compiled to browser-wasm.
#
#   sh engine/build_render_web.sh [out-dir]
#
# The rendering half of the page is a .NET WASM module.  That is not a
# compromise -- the current CNCMaps is a pure software rasteriser (zero OpenGL
# calls, no GPU dependency), so the SAME source that produces the reference
# images compiles straight to wasm.  "Identical to CNCMaps" is therefore free
# rather than reimplemented, which is the whole reason this path was chosen over
# porting the older C++ renderer.
#
# Requirements, none of which are on the machine by default:
#   * the .NET SDK            -- tools/fetch_apt.sh <prefix> <work> dotnet-sdk-10.0
#   * libunwind8              -- tools/fetch_apt.sh <prefix> <work> libunwind8
#   * the wasm-tools workload -- dotnet workload install wasm-tools
#   * the reference source    -- reference_impl/ccmaps-net (local oracle)
#
# CNCMaps is GPL v3.  Shipping this module ships GPL v3 code and obliges us to
# offer corresponding source to users; that was accepted explicitly.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-$ROOT/build/ccmaps-web}
SRC=${MG_CCMAPS_SRC:-$ROOT/reference_impl/ccmaps-net}
PROJ="$SRC/CNCMaps.Renderer/CNCMaps.Renderer.csproj"

DOTNET_ROOT=${DOTNET_ROOT:-$HOME/opt/dotnet-apt/usr/lib/dotnet}
DOTNET=${DOTNET_EXE:-$HOME/opt/dotnet-apt/usr/bin/dotnet}
UNWIND=$HOME/opt/dotnet-apt/usr/lib/x86_64-linux-gnu

if [ ! -f "$PROJ" ]; then
    echo "[render] the reference renderer is missing at $SRC" >&2
    echo "         clone github.com/zzattack/ccmaps-net into reference_impl/ccmaps-net" >&2
    exit 1
fi
if [ ! -x "$DOTNET" ]; then
    echo "[render] dotnet not found at $DOTNET" >&2
    echo "         see the requirements at the top of this script" >&2
    exit 1
fi

export DOTNET_ROOT
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1
[ -d "$UNWIND" ] && LD_LIBRARY_PATH="$UNWIND${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export LD_LIBRARY_PATH

# Our entry point lives in the tracked tree; the reference project is gitignored,
# so it is copied in on every build rather than edited in place.
cp "$ROOT/engine/render/WebEntry.cs" "$SRC/CNCMaps.Renderer/WebEntry.cs"

echo "[render] publishing CNCMaps for browser-wasm"
"$DOTNET" publish "$PROJ" -c Release -r browser-wasm --self-contained -o "$OUT" -v q --nologo

# The deployable unit is the AppBundle: it holds _framework/ (dotnet.js plus one
# .wasm per assembly) and the runtimeconfig.  The -o directory holds the managed
# assemblies that feed it.
BUNDLE="$SRC/CNCMaps.Renderer/bin/Release/net10.0/browser-wasm/AppBundle"
if [ ! -d "$BUNDLE/_framework" ]; then
    echo "[render] no app bundle at $BUNDLE" >&2
    exit 1
fi
rm -rf "$OUT/_framework"
cp -r "$BUNDLE/_framework" "$OUT/_framework"
cp "$BUNDLE/CNCMaps.Renderer.runtimeconfig.json" "$OUT/" 2>/dev/null || true
printf '{\n  "type": "module"\n}\n' > "$OUT/package.json"

# The page loads the renderer from webapp/render/, so stage it there.  These are
# build output; webapp/ ignores them.
STAGE=${MG_RENDER_STAGE:-1}
if [ "$STAGE" = "1" ]; then
    rm -rf "$ROOT/webapp/render"
    mkdir -p "$ROOT/webapp/render"
    cp -r "$OUT/_framework" "$ROOT/webapp/render/_framework"
    cp "$OUT/package.json" "$ROOT/webapp/render/package.json"
    # The runtimeconfig is not optional: the runtime reads mainAssemblyName and
    # the framework list out of it.  Leaving it behind made the renderer load
    # every asset, then stop without an error the page could see -- so the staged
    # tree is compared against the bundle rather than trusted.
    cp "$BUNDLE/CNCMaps.Renderer.runtimeconfig.json" "$ROOT/webapp/render/"
    # .stamp is a build bookkeeping file the runtime never reads.
    if ! diff -r -x .stamp "$BUNDLE" "$ROOT/webapp/render" > /tmp/render_stage_diff.txt 2>&1; then
        echo "[render] ERROR: the staged tree differs from the app bundle:" >&2
        head -20 /tmp/render_stage_diff.txt >&2
        exit 1
    fi
    SIZE=$(du -sh "$ROOT/webapp/render" | cut -f1)
    echo "[render] staged $SIZE into webapp/render/ (matches the app bundle)"
else
    echo "[render] built $OUT (not staged)"
fi
