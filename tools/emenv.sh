#!/bin/sh
# Put a locally-extracted Emscripten on PATH without root.
#
#   . tools/emenv.sh          # in a POSIX shell
#   sh -c '. tools/emenv.sh && sh engine/build_wasm.sh'
#
# Exits non-zero when the toolchain found is one this project cannot use, and
# says why.  That check is the point of this script as much as the PATH work is:
#
#   Ubuntu 24.04 ships emscripten 3.1.6.  It rejects -sSTACK_SIZE outright, and
#   -- far worse -- it predates clang renaming main() to __main_argc_argv, so it
#   links with --export-if-defined=main, finds no entry root, and dead-strips the
#   ENTIRE program.  The result is an 11 KB wasm that exits 0, prints nothing and
#   does nothing, with no error at any point.  A build that silently produces an
#   empty program must not be mistaken for a working one, so it is refused here.
#
#   tools/fetch_emscripten.sh   fetches a version that passes (questing, 3.1.69)
#
# Two things about the packaged tree need compensating for, and they are the same
# two the Debian package has always needed:
#
#   * /usr/bin/emcc is a symlink to ../share/emscripten/wrapper, and that wrapper
#     hardcodes `exec /usr/share/emscripten/$BASENAME`.  Putting the real
#     share/emscripten directory on PATH bypasses it.
#   * binaryen's tools (wasm-opt, wasm-emscripten-finalize) are looked up by BARE
#     NAME, so the directory holding them has to be on PATH -- AFTER
#     share/emscripten, never before, or `emcc` resolves back to the broken
#     wrapper.  The .emscripten config's LLVM_ROOT / BINARYEN_ROOT are overridden
#     here for the same reason.
#
# Debian ships a PREBUILT cache (the whole sysroot) inside the package and sets
# FROZEN_CACHE = True in .emscripten.  Pointing EM_CACHE at an empty directory
# therefore fails with 'FROZEN_CACHE is set, but cache file is missing'; the
# packaged cache is the one to use.

EM_PREFIX=${EM_PREFIX:-$HOME/opt/emscripten}
EM_CACHE=${EM_CACHE:-$EM_PREFIX/usr/share/emscripten/cache}
EM_SHARE=$EM_PREFIX/usr/share/emscripten

if [ ! -d "$EM_SHARE" ]; then
    echo "emscripten not found under $EM_PREFIX" >&2
    echo "  run tools/fetch_emscripten.sh, or set EM_PREFIX to another unpacked toolchain" >&2
    return 1 2>/dev/null || exit 1
fi

# A capability check rather than a version string: this is the exact setting the
# build scripts pass, and the name it had before 3.1.28.
if [ -f "$EM_SHARE/src/settings.js" ] && ! grep -q 'var STACK_SIZE' "$EM_SHARE/src/settings.js"; then
    echo "the emscripten at $EM_PREFIX is too old for this project" >&2
    echo "  it has TOTAL_STACK where this needs STACK_SIZE (emscripten >= 3.1.28), and it" >&2
    echo "  silently dead-strips main(int, char**) into an empty program." >&2
    echo "  re-fetch a usable one: sh tools/fetch_emscripten.sh" >&2
    return 1 2>/dev/null || exit 1
fi

# A cross-suite prefix can carry its own libc / ld-linux.  Those must never reach
# LD_LIBRARY_PATH below: every process in the environment, python3 included, would
# load a glibc newer than the loader supports and die with "stack smashing
# detected".  fetch_emscripten.sh removes them; refuse to set up if they are here,
# because a half-working environment is worse than a clear failure.
for core in libc.so.6 ld-linux-x86-64.so.2; do
    if [ -e "$EM_PREFIX/usr/lib/x86_64-linux-gnu/$core" ]; then
        echo "$EM_PREFIX carries its own $core" >&2
        echo "  that shadows the system one for everything launched from this environment;" >&2
        echo "  re-run tools/fetch_emscripten.sh to get a pruned toolchain" >&2
        return 1 2>/dev/null || exit 1
    fi
done

# Some packages ship share/emscripten/emcc, some only emcc.py beside a wrapper
# that hardcodes /usr/share/emscripten.  Provide the missing entry points locally.
if [ ! -x "$EM_SHARE/emcc" ]; then
    printf '#!/bin/sh\nHERE=$(cd "$(dirname "$0")" && pwd)\nexec "${EMSDK_PYTHON:-python3}" "$HERE/emcc.py" "$@"\n' > "$EM_SHARE/emcc"
    chmod +x "$EM_SHARE/emcc"
fi
if [ ! -x "$EM_SHARE/em++" ]; then
    printf '#!/bin/sh\nHERE=$(cd "$(dirname "$0")" && pwd)\nexec "${EMSDK_PYTHON:-python3}" "$HERE/em++.py" "$@"\n' > "$EM_SHARE/em++"
    chmod +x "$EM_SHARE/em++"
fi

EM_LLVM_ROOT="$EM_PREFIX/usr/bin"
EM_BINARYEN_ROOT="$EM_PREFIX/usr"
EM_NODE_JS=${EM_NODE_JS:-$(command -v node || echo /usr/bin/node)}
export EM_LLVM_ROOT EM_BINARYEN_ROOT EM_CACHE EM_NODE_JS

mkdir -p "$EM_CACHE"
# share/emscripten FIRST, then usr/bin for binaryen -- order matters, see above.
PATH="$EM_SHARE:$EM_PREFIX/usr/bin:$PATH"
export PATH

# The extracted clang / llvm live outside the loader's search path, so their
# shared libraries have to be pointed at explicitly.  llvm-19 is what current
# packages use; llvm-15 is covered for completeness.
for d in "$EM_PREFIX/usr/lib/x86_64-linux-gnu" "$EM_PREFIX/usr/lib" \
         "$EM_PREFIX/usr/lib/llvm-19/lib" "$EM_PREFIX/usr/lib/llvm-15/lib"; do
    if [ -d "$d" ]; then
        LD_LIBRARY_PATH="$d${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    fi
done
export LD_LIBRARY_PATH
