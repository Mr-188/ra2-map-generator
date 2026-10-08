#!/bin/sh
# Fetch a Chromium snapshot so tools/verify_browser.mjs can drive the real page.
#
#   sh tools/fetch_chromium.sh [revision]
#
# There is no browser on this machine and the distro packages one as a snap stub.
# Chromium's own snapshot archive is mirrored by npmmirror, which is fast from
# here -- the redirect target (cdn.npmmirror.com) served 11 MB/s while the
# redirecting host throttled a single long request to about 600 B/s, so the
# parallel fetcher is used.
#
# The extracted tree needs +x restoring afterwards: zip does not carry the
# executable bit and chrome refuses to spawn its crashpad handler without it.
set -e

REV=${1:-1714102}
DEST=${DEST:-$HOME/opt/chrome}
ZIP=${ZIP:-$HOME/opt/chrome-linux.zip}
HERE=$(cd "$(dirname "$0")" && pwd)

URL="https://cdn.npmmirror.com/binaries/chromium-browser-snapshots/Linux_x64/$REV/chrome-linux.zip"

echo "[chromium] resolving $URL"
SIZE=$(curl -sSI -L "$URL" | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ll]ength: //p' | tail -1)
if [ -z "$SIZE" ]; then
    echo "[chromium] could not determine the size" >&2
    exit 1
fi
echo "[chromium] $(( SIZE / 1048576 )) MB"

if [ ! -f "$ZIP" ] || [ "$(wc -c < "$ZIP")" != "$SIZE" ]; then
    sh "$HERE/fetch_parallel.sh" "$URL" "$ZIP" "$SIZE" "${CONNECTIONS:-8}"
else
    echo "[chromium] cached $ZIP"
fi

rm -rf "$DEST"
mkdir -p "$DEST"
echo "[chromium] extracting into $DEST"
python3 - "$ZIP" "$DEST" <<'PY'
import sys, zipfile
zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])
PY

# zip loses the executable bit; chrome will not start without it.
find "$DEST" -type f -exec chmod +x {} +
BIN=$(find "$DEST" -name chrome -type f | head -1)
echo "[chromium] $BIN"
"$BIN" --version
