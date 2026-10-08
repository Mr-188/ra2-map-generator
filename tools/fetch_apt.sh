#!/bin/sh
# Fetch apt packages and unpack them under a private prefix -- no root.
#
#   sh tools/fetch_apt.sh <prefix> <work-dir> <package>...
#
# Same trick as tools/fetch_emscripten.sh, generalised: resolve the dependency
# closure with `apt-get install --print-uris`, download it (large files through
# the parallel fetcher, because a single long request to these mirrors is
# throttled to a few hundred kB/s), then `dpkg-deb -x` each package.
#
# Headers land in <prefix>/usr/include and libraries in <prefix>/usr/lib/...;
# point the compiler at them with -I/-L, or set CPLUS_INCLUDE_PATH and
# LIBRARY_PATH.
set -e

DEST=$1
WORK=$2
shift 2
if [ -z "$DEST" ] || [ -z "$WORK" ] || [ $# -eq 0 ]; then
    echo "usage: $0 <prefix> <work-dir> <package>..." >&2
    exit 2
fi

HERE=$(cd "$(dirname "$0")" && pwd)
MIRROR=${MIRROR:-https://mirrors.aliyun.com/ubuntu}
CONNECTIONS=${CONNECTIONS:-16}
PARALLEL_ABOVE=${PARALLEL_ABOVE:-8388608}

mkdir -p "$WORK" "$DEST"
cd "$WORK"

echo "[apt] resolving: $*"
apt-get install --print-uris -qq -y "$@" 2>/dev/null \
    | sed -n "s|^'\([^']*\)' [^ ]* \([0-9][0-9]*\) .*|\1 \2|p" \
    | sed "s|http://[^/]*/ubuntu|$MIRROR|" > uris.txt

COUNT=$(wc -l < uris.txt)
echo "[apt] $COUNT packages"
[ "$COUNT" -gt 0 ] || { echo "[apt] nothing resolved -- check the package names" >&2; exit 1; }

i=0
while read -r uri size; do
    i=$((i + 1))
    file=$(basename "$uri" | sed 's/%2b/+/g')
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

echo "[apt] unpacking into $DEST"
for f in *.deb; do
    [ -f "$f" ] || continue
    dpkg-deb -x "$f" "$DEST" 2>/dev/null || echo "  EXTRACT_FAIL $f"
done
echo "[apt] done"
