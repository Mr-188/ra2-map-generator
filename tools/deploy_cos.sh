#!/bin/sh
# Upload the packaged page to Tencent Cloud COS, with the metadata the page needs.
#
#   sh tools/deploy_cos.sh <bucket> [prefix] [--dry-run]
#
# e.g.  sh tools/deploy_cos.sh mapgen-1250000000 map/
#
# Why a script rather than dragging files into the console: the Content-Type
# matters.  COS does not know `.wasm` and will serve it as
# `application/octet-stream`; the browser then refuses WebAssembly's streaming
# instantiation and the engine falls back or fails.  Cache-Control matters too --
# without it a rebuilt page keeps serving yesterday's worker.js.
#
# Needs one of:
#   rclone   with a remote configured for COS        (recommended; cross-platform)
#   coscmd   configured with a SecretId/SecretKey
#
# The 14 MB renderer is what makes this worth scripting: it is 59 files under
# render/_framework/, and every one of them has to land with the right type.
set -e

BUCKET=$1
PREFIX=${2:-}
DRY=""
[ "$3" = "--dry-run" ] && DRY="--dry-run"
if [ -z "$BUCKET" ]; then
    echo "usage: $0 <bucket> [prefix] [--dry-run]" >&2
    echo "   e.g. $0 mapgen-1250000000 map/" >&2
    exit 2
fi
[ "$PREFIX" = "--dry-run" ] && { DRY="--dry-run"; PREFIX=""; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC=${SRC:-$ROOT/build/webapp}

if [ ! -d "$SRC/render/_framework" ]; then
    echo "[deploy] $SRC is not a packaged page; run tools/package_webapp.sh first" >&2
    exit 1
fi

# ---- what each kind of file has to be served as --------------------------
content_type() {
    case "$1" in
        *.html)            echo "text/html; charset=utf-8" ;;
        *.js|*.mjs)        echo "text/javascript; charset=utf-8" ;;
        *.json)            echo "application/json; charset=utf-8" ;;
        *.wasm)            echo "application/wasm" ;;
        *.dat|*.symbols)   echo "application/octet-stream" ;;
        *.map)             echo "application/json; charset=utf-8" ;;
        *)                 echo "application/octet-stream" ;;
    esac
}

# Small files always revalidate, so a redeploy is picked up on the next load.
# The big immutable-ish payload is cached, because re-downloading 14 MB on every
# visit would defeat the point.
cache_control() {
    case "$1" in
        index.html|app.js|worker.js|mg_engine.js|package.json) echo "no-cache" ;;
        *)                                                     echo "public, max-age=604800" ;;
    esac
}

count=0
bytes=0
if [ -n "$DRY" ]; then
    echo "[deploy] dry run -- what would be uploaded"
else
    echo "[deploy] uploading $SRC to cos://$BUCKET/$PREFIX"
fi

cd "$SRC"
find . -type f | sed 's|^\./||' | sort | while read -r f; do
    key="$PREFIX$f"
    ctype=$(content_type "$f")
    cache=$(cache_control "$f")
    size=$(wc -c < "$f")
    echo "  $f  ($size B)  $ctype  [$cache]"

    [ -n "$DRY" ] && continue

    if command -v rclone >/dev/null 2>&1; then
        # rclone sets the type from the extension; for .wasm that is not enough.
        rclone copyto "$f" "cos:$BUCKET/$key" \
            --header-upload "Content-Type: $ctype" \
            --header-upload "Cache-Control: $cache" \
            --s3-no-check-bucket
    elif command -v coscmd >/dev/null 2>&1; then
        coscmd upload -H "{\"Content-Type\":\"$ctype\",\"Cache-Control\":\"$cache\"}" "$f" "$key"
    else
        echo "[deploy] neither rclone nor coscmd is installed" >&2
        echo "         pip install coscmd      (or)      install rclone and configure a cos remote" >&2
        exit 1
    fi
done

echo
echo "[deploy] done"
cat <<'EOF'

Next, in the Tencent Cloud console (this part cannot be scripted without your
account keys):

  1. COS bucket -> 基础配置 -> 静态网站: enable it, index document = index.html
     (You do not strictly need this if you serve everything through CDN.)

  2. CDN -> 域名管理 -> 添加域名
       加速域名   map.<your-domain>
       源站类型   对象存储 COS
       源站        <bucket>
     Then add a CNAME at DNSPod pointing map.<your-domain> at the CDN address
     the console shows you.

  3. CDN -> 证书管理 -> 申请免费证书 (or upload one), and bind it to the域名.
     HTTPS is not optional: a non-secure origin works for this page, but
     browsers increasingly refuse Workers on http://.

  4. CDN -> 性能优化 -> 智能压缩: enable it.  The 14 MB renderer is mostly
     wasm, which compresses to roughly a third.

  5. Optional but recommended: CDN 缓存配置 -> 强制缓存 for /*
     for 7 days, EXCEPT index.html/app.js/worker.js, which must stay
     revalidating.  The upload above already sets Cache-Control per file, so
     leaving the default (follow origin headers) is the right choice.
EOF
