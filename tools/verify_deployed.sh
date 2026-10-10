#!/bin/sh
# Check a DEPLOYED copy of the page: is every asset reachable, and with the
# metadata the browser needs?
#
#   sh tools/verify_deployed.sh https://map.example.com/
#
# This is the deployment counterpart to tools/verify_browser.mjs.  The browser
# test needs to feed the page a game directory, which it can only do from the
# same origin, so it cannot run against a live site.  What CAN be checked from
# anywhere is the thing that most often breaks on a static host:
#
#   * a .wasm served as application/octet-stream, which makes the browser refuse
#     WebAssembly streaming instantiation;
#   * a missing file (the renderer alone is 59 of them, under render/_framework);
#   * an HTML page returned for a missing asset, so the failure looks like a
#     parse error instead of a 404.
set -e

BASE=$1
if [ -z "$BASE" ]; then
    echo "usage: $0 <base-url>" >&2
    echo "   e.g. $0 https://map.example.com/" >&2
    exit 2
fi
case "$BASE" in
    */) ;;
    *) BASE="$BASE/" ;;
esac

fail=0
checked=0
total=0

check_file() {
    rel=$1
    want=${2:-}
    url="$BASE$rel"
    hdr=$(curl -sS -o /dev/null -D - -L --max-time 60 "$url" 2>/dev/null || true)
    code=$(printf '%s' "$hdr" | sed -n 's|^HTTP/[0-9.]* \([0-9]*\).*|\1|p' | tail -1)
    ctype=$(printf '%s' "$hdr" | tr -d '\r' | sed -n 's|^[Cc]ontent-[Tt]ype: ||p' | tail -1)
    len=$(printf '%s' "$hdr" | tr -d '\r' | sed -n 's|^[Cc]ontent-[Ll]ength: ||p' | tail -1)
    checked=$((checked + 1))
    [ -n "$len" ] && total=$((total + len))

    # A missing file must be reported as missing.  Reporting the Content-Type of
    # the host's 404 page instead ("want text/javascript, got text/html") sends
    # you looking for a MIME misconfiguration when the file simply is not there
    # -- which is what a host that answers unknown paths with its 404 page does.
    status="ok"
    if [ "$code" != "200" ]; then
        status="FAIL http=$code"
    elif [ -n "$want" ]; then
        # application/javascript is the legacy spelling of text/javascript and
        # both are accepted by browsers; only a genuinely wrong type matters.
        alt=""
        case "$want" in
            text/javascript) alt="application/javascript" ;;
            application/javascript) alt="text/javascript" ;;
        esac
        case "$ctype" in
            "$want"*) ;;
            "$alt"*) ;;
            *) status="FAIL content-type=$ctype (want $want)" ;;
        esac
    fi
    if [ "$status" = "ok" ]; then
        printf '  ok    %-46s %10s B  %s\n' "$rel" "${len:-?}" "$ctype"
    else
        printf '  FAIL  %-46s %s\n' "$rel" "$status"
        fail=1
    fi
}

echo "[deployed] $BASE"
check_file index.html                       "text/html"
check_file app.js                           "text/javascript"
check_file worker.js                        "text/javascript"
check_file mg_engine.js                     "text/javascript"
check_file mg_engine.wasm                   "application/wasm"
check_file package.json                     "application/json"

# The renderer is fetched lazily, on the first "render preview".
check_file render/package.json              "application/json"
check_file render/_framework/dotnet.js      "text/javascript"
check_file render/_framework/dotnet.native.js "text/javascript"
check_file render/_framework/dotnet.native.wasm  "application/wasm"
check_file render/_framework/CNCMaps.Engine.wasm "application/wasm"
check_file render/_framework/System.Private.CoreLib.wasm "application/wasm"
check_file render/CNCMaps.Renderer.runtimeconfig.json "application/json"

# A 404 must look like a 404, not like the index page.
missing=$(curl -sS -o /dev/null -w '%{http_code}' -L --max-time 30 \
          "$BASE/definitely-not-here-9f3a2b.js" 2>/dev/null || echo "000")
if [ "$missing" = "404" ] || [ "$missing" = "403" ]; then
    printf '  ok    %-46s http=%s\n' "missing file returns 404" "$missing"
else
    printf '  FAIL  %-46s http=%s (a SPA fallback will hide broken asset paths)\n' \
           "missing file returns 404" "$missing"
    fail=1
fi

echo
printf '  %d files checked, %d KB accounted for\n' "$checked" "$((total / 1024))"
echo
if [ "$fail" != "0" ]; then
    echo "FAILED -- fix the above before sharing the URL"
    exit 1
fi
echo "OK -- the deployed copy serves every asset with usable metadata"
echo
echo "Now open it in a browser and generate + render once.  That is the only"
echo "thing this script cannot do."
