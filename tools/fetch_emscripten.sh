#!/bin/sh
# Fetch the Emscripten toolchain from an apt mirror and unpack it under
# ~/opt/emscripten (no root needed) -- the same trick used for a local wine.
#
# Large packages go through tools/fetch_parallel.sh: a single long-range request
# to these mirrors is throttled to a few hundred kB/s (the 243 MB emscripten
# package took over nine minutes that way), while 16 concurrent range requests
# finish it in well under a minute.
#
#   sh tools/fetch_emscripten.sh [destination] [work-dir]
set -e

DEST=${1:-$HOME/opt/emscripten}
WORK=${2:-$HOME/opt/emdl}
HERE=$(cd "$(dirname "$0")" && pwd)
MIRROR=${MIRROR:-https://mirrors.aliyun.com/ubuntu}
CONNECTIONS=${CONNECTIONS:-16}
# Above this size the parallel fetcher is used instead of a single curl.
PARALLEL_ABOVE=${PARALLEL_ABOVE:-8388608}

mkdir -p "$WORK" "$DEST"
cd "$WORK"

echo "[emsdk] resolving the dependency closure from $MIRROR"
# 'url' size MD5Sum:...  ->  "url size"
apt-get install --print-uris -qq emscripten 2>/dev/null \
    | sed -n "s|^'\([^']*\)' [^ ]* \([0-9][0-9]*\) .*|\1 \2|p" \
    | sed "s|http://[^/]*/ubuntu|$MIRROR|" > uris.txt

COUNT=$(wc -l < uris.txt)
echo "[emsdk] $COUNT packages"

i=0
while read -r uri size; do
    i=$((i + 1))
    file=$(basename "$uri")
    # apt percent-encodes '+' in file names; decode it for the local path.
    file=$(printf '%s' "$file" | sed 's/%2b/+/g')
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

echo "[emsdk] done"
if [ -x "$DEST/usr/bin/emcc" ]; then
    echo "  emcc: $DEST/usr/bin/emcc"
else
    echo "  (emcc not where expected; inspect $DEST/usr/bin)"
    ls "$DEST/usr/bin" 2>/dev/null | head
fi
