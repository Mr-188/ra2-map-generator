#!/bin/sh
# Fetch one large file with N parallel range requests.
#
# A single long-range request to the mirrors here is throttled to a few hundred
# kB/s, while a fresh short ranged request runs at several MB/s -- so splitting
# the file into chunks and fetching them concurrently is the difference between
# nine minutes and under a minute for the 243 MB emscripten package.
#
#   sh tools/fetch_parallel.sh <url> <outfile> <size> [connections]
set -e

URL=$1
OUT=$2
SIZE=$3
N=${4:-16}

if [ -z "$URL" ] || [ -z "$OUT" ] || [ -z "$SIZE" ]; then
    echo "usage: $0 <url> <outfile> <size> [connections]" >&2
    exit 2
fi

DIR=$(dirname "$OUT")
mkdir -p "$DIR"
BASE=$(basename "$OUT")
TMP="$DIR/.$BASE.parts"
rm -rf "$TMP"
mkdir -p "$TMP"

CHUNK=$(( (SIZE + N - 1) / N ))
i=0
while [ $i -lt $N ]; do
    start=$(( i * CHUNK ))
    end=$(( start + CHUNK - 1 ))
    [ $end -ge "$SIZE" ] && end=$(( SIZE - 1 ))
    if [ $start -lt "$SIZE" ]; then
        # -L matters: mirrors redirect to a CDN, and without it the saved
        # "chunk" is the redirect body -- a file of the wrong length that still
        # passes a per-chunk check.
        curl -sS -L -r "$start-$end" -o "$TMP/part.$i" "$URL" &
    fi
    i=$(( i + 1 ))
done
wait

# Concatenate in NUMERIC order.  A plain `for f in part.*` sorts lexically, so
# part.10 lands before part.2 and the result is the right length but scrambled --
# which is exactly the kind of corruption that passes a size check and only
# shows up much later.
i=0
while [ $i -lt $N ]; do
    f="$TMP/part.$i"
    if [ -f "$f" ]; then
        cat "$f"
    fi
    i=$(( i + 1 ))
done > "$OUT"
rm -rf "$TMP"

GOT=$(wc -c < "$OUT")
if [ "$GOT" -ne "$SIZE" ]; then
    echo "size mismatch: got $GOT, expected $SIZE" >&2
    exit 1
fi
echo "ok $OUT $GOT bytes"
