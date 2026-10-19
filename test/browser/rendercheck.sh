#!/bin/sh
# Compare direct control loads against proxied loads across layout, CSS, CSP, and unproxied URL metrics:
#   title         : document title
#   raw           : unproxied subresource URLs observed from the isolated world (expected: 0)
#   csp           : CSP violations
#   err           : page console errors
#   height / els / aboveFold / styleEntities : layout and `<style>` raw-text integrity
#
# Usage: sh test/browser/rendercheck.sh "https://a/" "https://b/" ...

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
PROBE="$SELF_DIR/layout-probe.js"
PROXY_HOME="http://proxy.localhost:18080/zp/"
. "$SELF_DIR/_zp-session.sh"
zp_ensure || { echo "NO_MEASUREMENT: taskweaver zp daemon is not usable (renderer not ok)"; exit 1; }

# Allowed proxied-to-control scrollHeight percentage range (70% to 145%).
LO=70
HI=145

json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=eval('j.'+process.argv[1]);console.log(v===undefined||v===null?'?':v)}catch(e){console.log('?')}})" "$1"; }

measure() {
  taskweaver exec-js -i zp --file "$1" 2>/dev/null
}

for U in "$@"; do
  taskweaver navigate -i zp --url "$U" --timeout-ms 40000 >/dev/null 2>&1
  taskweaver wait -i zp --ms 20000 >/dev/null 2>&1
  C=$(measure "$PROBE")
  CH=$(echo "$C" | json 'result.height')
  CE=$(echo "$C" | json 'result.els')
  CA=$(echo "$C" | json 'result.aboveFold')

  zp_reset_proxy_state
  taskweaver console-logs -i zp --clear >/dev/null 2>&1
  taskweaver navigate -i zp --url "$PROXY_HOME" --timeout-ms 20000 >/dev/null 2>&1
  taskweaver fill-form -i zp --selector "input" --value "$U" >/dev/null 2>&1
  # Start wait-navigation in the background before clicking Open so fast navigations are not missed.
  taskweaver wait-navigation -i zp --timeout-ms 45000 >/dev/null 2>&1 &
  WN=$!
  sleep 1
  taskweaver click -i zp --text "Open" >/dev/null 2>&1
  wait $WN
  taskweaver wait -i zp --ms 18000 >/dev/null 2>&1

  T=$(taskweaver get-url -i zp 2>/dev/null | json 'title')
  P=$(measure "$PROBE")
  PH=$(echo "$P" | json 'result.height')
  PE=$(echo "$P" | json 'result.els')
  PA=$(echo "$P" | json 'result.aboveFold')
  PS=$(echo "$P" | json 'result.styleEntities')

  RAW=$(taskweaver exec-js -i zp --world isolated --script "var sel='img,script,link,iframe,source,video,audio,input,image,use';var a=[...document.querySelectorAll(sel)].map(e=>e.getAttribute('src')||e.getAttribute('href')||e.getAttribute('poster')||'');return a.filter(s=>/^https?:\/\//.test(s)&&!s.includes('proxy.localhost')).length" 2>/dev/null | json 'result')
  CSP=$(taskweaver console-logs -i zp --source csp --max 100 2>/dev/null | json 'logs.length')
  ERR=$(taskweaver console-logs -i zp --level error --max 100 2>/dev/null | json 'logs.length')

  # Flag missing measurements explicitly so a wedged renderer does not report OK.
  FLAG=""
  for V in "$PH" "$CH" "$PE" "$CE" "$PA" "$CA"; do
    case "$V" in ''|'?') FLAG="$FLAG NO_MEASUREMENT"; break;; esac
  done
  case "$PS" in ''|'?'|0) ;; *) FLAG="$FLAG STYLE_ENTITY($PS)";; esac
  R="?"
  if [ "$CH" != "?" ] && [ "$PH" != "?" ] && [ "$CH" -gt 0 ] 2>/dev/null; then
    R=$(( PH * 100 / CH ))
    if [ "$R" -lt "$LO" ] || [ "$R" -gt "$HI" ]; then FLAG="$FLAG HEIGHT(${R}%)"; fi
  fi
  if [ "$PA" != "?" ] && [ "$PA" -eq 0 ] 2>/dev/null; then FLAG="$FLAG ABOVE_FOLD(0)"; fi
  [ -z "$FLAG" ] && FLAG=" OK"

  echo "$U | title=$T | raw=$RAW csp=$CSP err=$ERR"
  echo "    height ${PH} / ${CH} = ${R}%   els ${PE} / ${CE}   aboveFold ${PA} / ${CA}   styleEntities ${PS}  =>${FLAG}"
done
