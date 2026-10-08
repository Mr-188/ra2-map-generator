#!/bin/sh
# Put a locally-extracted Emscripten on PATH without root.
#
#   . tools/emenv.sh          # in a POSIX shell
#   sh -c '. tools/emenv.sh && sh engine/build_wasm.sh'
#
# tools/fetch_emscripten.sh unpacks the Debian packages under ~/opt/emscripten.
# Two of their paths are absolute and therefore wrong once relocated:
#
#   * /usr/bin/emcc is a symlink to ../share/emscripten/wrapper, and that wrapper
#     hardcodes `exec /usr/share/emscripten/$BASENAME`.  Putting the real
#     share/emscripten directory on PATH bypasses it.
#   * the .emscripten config points LLVM_ROOT at /usr/bin and BINARYEN_ROOT at
#     /usr, so both are overridden here.
#
# Debian ships a PREBUILT cache (the whole sysroot) inside the package and sets
# FROZEN_CACHE = True in .emscripten.  Pointing EM_CACHE at an empty directory
# therefore fails with 'FROZEN_CACHE is set, but cache file is missing'; the
# packaged cache is the one to use.
EM_PREFIX=${EM_PREFIX:-$HOME/opt/emscripten}
EM_CACHE=${EM_CACHE:-$EM_PREFIX/usr/share/emscripten/cache}

if [ ! -x "$EM_PREFIX/usr/share/emscripten/emcc" ]; then
    echo "emscripten not found under $EM_PREFIX; run tools/fetch_emscripten.sh" >&2
    return 1 2>/dev/null || exit 1
fi

EM_LLVM_ROOT="$EM_PREFIX/usr/bin"
EM_BINARYEN_ROOT="$EM_PREFIX/usr"
EM_NODE_JS=${EM_NODE_JS:-$(command -v node || echo /usr/bin/node)}
export EM_LLVM_ROOT EM_BINARYEN_ROOT EM_CACHE EM_NODE_JS

mkdir -p "$EM_CACHE"
PATH="$EM_PREFIX/usr/share/emscripten:$PATH"
export PATH

# The extracted clang-19 / llvm-19 live outside the loader's search path, so
# libclang-cpp.so.19 and friends have to be pointed at explicitly.
for d in "$EM_PREFIX/usr/lib/x86_64-linux-gnu" "$EM_PREFIX/usr/lib" \
         "$EM_PREFIX/usr/lib/llvm-19/lib"; do
    if [ -d "$d" ]; then
        LD_LIBRARY_PATH="$d${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    fi
done
export LD_LIBRARY_PATH

# clang finds its builtin headers relative to its own prefix; make sure the
# relocated llvm-19 tree is the one it uses.
export EM_LLVM_ROOT="$EM_PREFIX/usr/bin"
