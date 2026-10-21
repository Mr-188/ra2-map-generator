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
# A preview deployment is served from a SIGNED url
# (`https://x.edgeone.cool?eo_token=...&eo_time=...`); the query string has to be
# kept, but it belongs AFTER the path, not in the middle of it:
# `https://x.edgeone.cool/index.html?eo_token=...`.  Appending the relative path
# to the whole string would ask for `...cool?eo_token=...index.html`, which is a
# 404 on a URL that looks right in the log.
BASE_QUERY=
case "$BASE" in
    *\?*) BASE_QUERY="?${BASE#*\?}"; BASE="${BASE%%\?*}" ;;
esac
case "$BASE" in
    */) ;;
    *) BASE="$BASE/" ;;
esac

fail=0
checked=0
total=0

# Scratch file for the version manifest parse (read back with a `while read`, so
# it cannot be a pipeline: a subshell would swallow the failure flag).
WORK_PATHS=$(mktemp)
trap 'rm -f "$WORK_PATHS"' EXIT

check_file() {
    rel=$1
    want=${2:-}
    url="$BASE$rel$BASE_QUERY"
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
            image/x-icon) alt="image/vnd.microsoft.icon" ;;
        esac
        # Compare the bare type, ignoring parameters ("application/wasm" vs
        # "application/wasm; charset=utf-8").
        #
        # This used to be `case "$ctype" in "$want"*) ;; "$alt"*) ;; *) FAIL`, and
        # with an UNSET alternative that second pattern is `""*` -- which is just
        # `*` and matches everything.  Every check except the two javascript ones
        # therefore passed no matter what the host sent: a .wasm served as
        # application/octet-stream, the single defect this project's docs call the
        # most common static-hosting trap, was reported as ok.  A missing header
        # would have passed too, so the empty case is spelled out as well.
        base_type=$(printf '%s' "$ctype" | sed 's/;.*//; s/[[:space:]]*$//')
        if [ -z "$base_type" ]; then
            status="FAIL no Content-Type (want $want)"
        elif [ "$base_type" = "$want" ]; then
            :
        elif [ -n "$alt" ] && [ "$base_type" = "$alt" ]; then
            :
        else
            status="FAIL content-type=$ctype (want $want)"
        fi
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
# The tab icon is a copy of the retail RA2.ico, carried as an explicit exception
# to the no-game-assets rule.  It is easy to lose in a packaging change and only
# shows up as a 404 in the browser's network tab, so it is checked by name.
check_file ra2.ico                          "image/x-icon"
check_file app.js                           "text/javascript"
check_file worker.js                        "text/javascript"
# 参数集: imported by app.js as a module.  Missing from a deploy, 生成地图 is dead.
check_file sharebits.js                     "text/javascript"
# 画廊: linked from the generator's header, and js is what reads the txt list.
check_file gallery.html                     "text/html"
check_file gallery.js                       "text/javascript"
check_file gallery.txt                      "text/plain"
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

# ---- the filing numbers have to be ON the pages, not only in the repository --
# 《非经营性互联网信息服务备案管理办法》 requires the ICP number at the bottom of the
# homepage with a link to the filing system, and the 公安备案号 the same.  The
# asset checks above cannot see this: a build that serves every file but lost
# the footer looks perfect to them.  So the pages are fetched and searched --
# both of them, because the footer is one footer on one site.
for page in "" "gallery.html"; do
body=$(curl -sS -L --max-time 60 "$BASE$page$BASE_QUERY" 2>/dev/null || true)
# The checks below (version badge, 历史版本 drawer) are about the HOMEPAGE, so keep
# its body under the name they use -- overwriting $home here made them look for the
# badge in the gallery page.
[ -z "$page" ] && home=$body
where=${page:-homepage}
for needle in "苏ICP备2023037209号-2" "https://beian.miit.gov.cn/" \
              "苏公网安备32081202000454号" "beian.mps.gov.cn/#/query/webSearch?code=32081202000454" \
              "1002834147" "与 EA 无关"; do
    if printf '%s' "$body" | grep -qF -- "$needle"; then
        printf '  ok    %-46s %s\n' "$where shows" "$needle"
    else
        printf '  FAIL  %-46s missing %s\n' "$where shows" "$needle"
        fail=1
    fi
done
done
checked=$((checked + 5))

# ---- the version badge and the 历史版本 drawer ------------------------------
# The drawer is only useful if the versions it offers actually answer, so this
# checks the two files the page reads AND probes every historical path the
# manifest lists.  A manifest naming a version whose bytes never went up hands
# the player a link to a 404 -- worse than offering no history at all.
for needle in 'id="ver"' '历史版本'; do
    if printf '%s' "$home" | grep -qF -- "$needle"; then
        printf '  ok    %-46s %s\n' "homepage has" "$needle"
    else
        printf '  FAIL  %-46s missing %s\n' "homepage has" "$needle"
        fail=1
    fi
done
checked=$((checked + 2))

vjson=$(curl -sS -L --max-time 30 "$BASE/version.json$BASE_QUERY" 2>/dev/null || true)
vstr=$(printf '%s' "$vjson" | python3 -c \
       'import json,sys;print(json.load(sys.stdin).get("version",""))' 2>/dev/null || true)
if [ -n "$vstr" ]; then
    printf '  ok    %-46s %s\n' "version.json is served" "$vstr"
else
    printf '  FAIL  %-46s missing or unreadable\n' "version.json is served"
    fail=1
fi
checked=$((checked + 1))

mjson=$(curl -sS -L --max-time 30 "$BASE/versions.json$BASE_QUERY" 2>/dev/null || true)
printf '%s' "$mjson" | python3 -c '
import json, sys
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(1)
for e in doc.get("versions", []):
    print("%s\t%s\t%s" % (e.get("version", "?"), e.get("path", "/"), e.get("engine", "")))
' > "$WORK_PATHS" 2>/dev/null || true
if [ -s "$WORK_PATHS" ]; then
    printf '  ok    %-46s %s version(s)\n' "versions.json is served" \
           "$(wc -l < "$WORK_PATHS" | tr -d ' ')"
    checked=$((checked + 1))

    # Every entry needs the engine fingerprint the 参数集 compares against: without
    # it the page cannot turn "this code came from another build" into "switch to
    # THAT version" -- and it would say the version is no longer kept, which is a
    # lie about a version that IS being served.
    if awk -F'\t' '$3 !~ /^[0-9a-f]{16}$/ { bad = 1 } END { exit bad }' "$WORK_PATHS"; then
        printf '  ok    %-46s %s\n' "every version carries an engine id" \
               "$(wc -l < "$WORK_PATHS" | tr -d ' ')"
    else
        printf '  FAIL  %-46s the page cannot resolve a code to a version\n' \
               "every version carries an engine id"
        fail=1
    fi
    checked=$((checked + 1))

    # Read from a file rather than piping into `while`: a pipeline would run the
    # loop in a subshell and the `fail=1` inside it would be lost.
    while IFS="$(printf '\t')" read -r ver path engine; do
        [ -n "$path" ] || continue
        [ "$path" = "/" ] && continue
        code=$(curl -sS -o /dev/null -w '%{http_code}' -L --max-time 60 \
               "$BASE${path#/}index.html$BASE_QUERY" 2>/dev/null || echo "000")
        if [ "$code" = "200" ]; then
            printf '  ok    %-46s http=%s\n' "historical $ver answers" "$code"
        else
            printf '  FAIL  %-46s http=%s (the drawer would link to a dead version)\n' \
                   "historical $ver answers" "$code"
            fail=1
        fi
        # The version's own version.json has to agree with the manifest entry: the
        # page sends the player to that URL on the strength of this number, and a
        # mismatch is a switch that lands where the code STILL does not match.
        got=$(curl -sS -L --max-time 30 "$BASE${path#/}version.json$BASE_QUERY" 2>/dev/null \
              | python3 -c 'import json,sys;print(json.load(sys.stdin).get("engine",""))' 2>/dev/null || true)
        if [ "$got" = "$engine" ]; then
            printf '  ok    %-46s %s\n' "historical $ver keeps its engine id" "$got"
        else
            printf '  FAIL  %-46s manifest=%s served=%s\n' \
                   "historical $ver keeps its engine id" "$engine" "${got:-none}"
            fail=1
        fi
        checked=$((checked + 1))
    done < "$WORK_PATHS"
else
    printf '  FAIL  %-46s missing or unreadable\n' "versions.json is served"
    fail=1
    checked=$((checked + 1))
fi

# A 404 must look like a 404, not like the index page.
missing=$(curl -sS -o /dev/null -w '%{http_code}' -L --max-time 30 \
          "$BASE/definitely-not-here-9f3a2b.js$BASE_QUERY" 2>/dev/null || echo "000")
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
