#!/bin/sh
# Fetch an Emscripten toolchain from an apt mirror and unpack it under
# ~/opt/emscripten (no root needed).
#
#   sh tools/fetch_emscripten.sh [destination] [work-dir]
#
# Large packages go through tools/fetch_parallel.sh: a single long-range request
# to these mirrors is throttled to a few hundred kB/s (the 243 MB emscripten
# package took over nine minutes that way), while 16 concurrent range requests
# finish it in well under a minute.
#
# ---------------------------------------------------------------------------
# WHY THE DEFAULT SUITE IS NOT THE LOCAL ONE
#
# This project needs -sSTACK_SIZE (Emscripten >= 3.1.28) and a clang whose main()
# renaming the linker knows about.  Ubuntu 24.04 (noble) ships emscripten 3.1.6,
# which fails both:
#
#   * it rejects -sSTACK_SIZE outright ("Attempt to set a non-existent setting");
#   * it predates clang's rename of main() to __main_argc_argv, so it links with
#     --export-if-defined=main, finds no entry root, and dead-strips the ENTIRE
#     program -- an 11 KB wasm that exits 0 and does nothing, silently.
#
# So the default here is a suite whose emscripten is new enough, resolved from
# that suite's own index rather than the machine's apt lists.  Override with
# SUITE=... (plucky and trixie also carry 3.1.69; sid has 6.0.5) or set
# SUITE=native to use the machine's own lists.
#
# The first run has to index the chosen suite (about 17 MB, single-stream, so it
# is slow on these mirrors).  It is cached in the work directory; delete
# <work-dir>/aptidx to refresh it.
#
# ---------------------------------------------------------------------------
# WHY CORE SYSTEM LIBRARIES ARE REMOVED AFTER UNPACKING
#
# A suite newer than the host drags its own libc.so.6, ld-linux, libm and
# libstdc++ into the prefix.  tools/emenv.sh puts that directory on
# LD_LIBRARY_PATH, so every process launched from the environment -- python3
# included -- would load a glibc newer than the loader supports and die with
# "stack smashing detected".  The toolchain's OWN libraries are fine, and were
# measured: the plucky set needs at most GLIBC_2.38 and GLIBCXX_3.4.30 against a
# 2.39 / 3.4.33 host.  So only the core system libraries are dropped.
# ---------------------------------------------------------------------------
set -e

DEST=${1:-$HOME/opt/emscripten}
WORK=${2:-$HOME/opt/emdl}
HERE=$(cd "$(dirname "$0")" && pwd)
MIRROR=${MIRROR:-https://mirrors.aliyun.com/ubuntu}
SUITE=${SUITE:-questing}
CONNECTIONS=${CONNECTIONS:-16}
# Above this size the parallel fetcher is used instead of a single curl.
PARALLEL_ABOVE=${PARALLEL_ABOVE:-8388608}

mkdir -p "$WORK" "$DEST"
cd "$WORK"

LOCAL_SUITE=$(sed -n 's/^VERSION_CODENAME=//p' /etc/os-release 2>/dev/null | tr -d '"')

APTOPTS=""
CROSS=0
if [ "$SUITE" != "native" ] && [ "$SUITE" != "$LOCAL_SUITE" ]; then
    CROSS=1
    IDX=$WORK/aptidx
    mkdir -p "$IDX/lists/partial" "$IDX/cache/archives/partial"
    cat > "$IDX/sources.list" <<EOF
deb $MIRROR $SUITE main universe
deb $MIRROR $SUITE-updates main universe
EOF
    # shellcheck disable=SC2086
    APTOPTS="-o Dir::Etc::sourcelist=$IDX/sources.list -o Dir::Etc::sourceparts=- \
 -o Dir::State::lists=$IDX/lists -o Dir::Cache=$IDX/cache \
 -o Acquire::Check-Valid-Until=false -o Debug::NoLocking=1"
    if [ ! -f "$IDX/.indexed" ]; then
        echo "[emsdk] indexing $SUITE (one-off, ~17 MB, cached in $IDX)"
        # shellcheck disable=SC2086
        apt-get $APTOPTS update >/dev/null
        touch "$IDX/.indexed"
    fi
fi

echo "[emsdk] resolving the emscripten closure from $MIRROR ($SUITE)"
# shellcheck disable=SC2086
apt-get $APTOPTS install --print-uris -qq emscripten 2>/dev/null \
    | sed -n "s|^'\([^']*\)' [^ ]* \([0-9][0-9]*\) .*|\1 \2|p" \
    | sed "s|http://[^/]*/ubuntu|$MIRROR|" > uris.txt

COUNT=$(wc -l < uris.txt)
[ "$COUNT" -gt 0 ] || { echo "[emsdk] nothing resolved for suite '$SUITE'" >&2; exit 1; }
echo "[emsdk] $COUNT packages"

i=0
while read -r uri size; do
    i=$((i + 1))
    file=$(basename "$uri")
    # apt percent-encodes '+' and ':' in file names; decode for the local path.
    file=$(printf '%s' "$file" | sed 's/%2b/+/g; s/%3a/:/g')
    if [ -f "$file" ] && [ "$(wc -c < "$file")" = "$size" ]; then
        echo "  [$i/$COUNT] $file (cached)"
        continue
    fi
    echo "  [$i/$COUNT] $file ($(( size / 1048576 )) MB)"
    if [ "$size" -gt "$PARALLEL_ABOVE" ]; then
        sh "$HERE/fetch_parallel.sh" "$uri" "$file" "$size" "$CONNECTIONS" \
            || echo "    FAILED $uri"
    else
        curl -sS -L -o "$file" "$uri" || echo "    FAILED $uri"
    fi
done < uris.txt

echo "[emsdk] unpacking into $DEST"
for f in *.deb; do
    [ -f "$f" ] || continue
    dpkg-deb -x "$f" "$DEST" 2>/dev/null || echo "  EXTRACT_FAIL $f"
done

# Drop the core system libraries a newer suite brought along.  See the header:
# leaving them here makes emenv.sh refuse the prefix (and rightly so).
if [ "$CROSS" = "1" ]; then
    LIBDIR=$DEST/usr/lib/x86_64-linux-gnu
    if [ -d "$LIBDIR" ]; then
        pruned=0
        cd "$LIBDIR"
        for pat in 'libc.so*' 'libc-2*' 'ld-linux*' 'libm.so*' 'libm-2*' \
                   'libpthread*' 'libdl*' 'librt*' 'libgcc_s*' 'libstdc++*'; do
            for f in $pat; do
                [ -e "$f" ] || continue
                if rm -f "$f"; then pruned=$((pruned + 1)); fi
            done
        done
        cd "$WORK"
        echo "[emsdk] pruned $pruned core system lib entries (cross-suite)"
    fi
fi

# Capability check: the setting the build scripts pass, and the name it had
# before 3.1.28.  Cheap, needs no execution, and catches the silent-dead-strip
# toolchain before anyone wastes a build on it.
SETTINGS=$DEST/usr/share/emscripten/src/settings.js
if [ -f "$SETTINGS" ] && ! grep -q 'var STACK_SIZE' "$SETTINGS"; then
    echo "[emsdk] ERROR: the $SUITE emscripten is too old for this project" >&2
    echo "  (no STACK_SIZE in settings.js).  Try SUITE=questing or SUITE=plucky." >&2
    exit 1
fi

echo "[emsdk] done"
if [ -x "$DEST/usr/share/emscripten/emcc" ]; then
    echo "  emcc: $DEST/usr/share/emscripten/emcc"
elif [ -x "$DEST/usr/bin/emcc" ]; then
    echo "  emcc: $DEST/usr/bin/emcc (a shim is created by tools/emenv.sh)"
else
    echo "  (emcc not where expected; inspect $DEST/usr/share/emscripten)"
fi
echo "  next: sh -c '. tools/emenv.sh && sh engine/build_wasm.sh'"
