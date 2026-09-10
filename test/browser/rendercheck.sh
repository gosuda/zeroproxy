#!/bin/sh
# 실사이트 점검. 사이트마다 **대조군(직접 로드)과 프록시를 쌍으로** 재고 비교한다.
#
#   title           — 문서가 실제로 떴는가
#   raw             — 격리 월드에서 본 **원본 URL** 서브리소스 (0 이어야 한다)
#   csp             — CSP 위반 (리라이트를 놓친 자리의 유일한 신호)
#   err             — 페이지 자신의 콘솔 에러
#   height / els / aboveFold / styleEntities  — 레이아웃·CSS 무결성 (2026-08-26 신설)
#
# ★쌍으로 재는 이유: 프록시 단독 수치는 의미가 없다. 2026-08-26 CSS 버그는
# 요소 수·raw·csp·err 를 **전부 통과**했고 오직 대조군 대비 높이 3배로만 보였다.
# 자세한 것: .ai/trap-notebook/rewriter.md#style-raw-text-이스케이프
#
# 사용: sh test/browser/rendercheck.sh "https://a/" "https://b/" …

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
PROBE="$SELF_DIR/layout-probe.js"
PROXY_HOME="http://proxy.localhost:18080/zp/"

# 페이지 높이 비율이 이 범위를 벗어나면 FLAG. CSS 가 통째로 빠지면 배 단위로
# 벌어지므로 넉넉히 잡아도 잡힌다(이번 버그는 2.91배였다).
LO=70    # 0.70
HI=145   # 1.45

json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=eval('j.'+process.argv[1]);console.log(v===undefined||v===null?'?':v)}catch(e){console.log('?')}})" "$1"; }

measure() { # $1 = probe 파일 → 한 줄 JSON
  taskweaver exec-js -i zp --file "$1" 2>/dev/null
}

for U in "$@"; do
  # ── 대조군: 직접 로드 ────────────────────────────────────────────────
  taskweaver navigate -i zp --url "$U" --timeout-ms 40000 >/dev/null 2>&1
  taskweaver wait -i zp --ms 20000 >/dev/null 2>&1
  C=$(measure "$PROBE")
  CH=$(echo "$C" | json 'result.height')
  CE=$(echo "$C" | json 'result.els')
  CA=$(echo "$C" | json 'result.aboveFold')

  # ── 프록시 ──────────────────────────────────────────────────────────
  taskweaver console-logs -i zp --clear >/dev/null 2>&1
  taskweaver navigate -i zp --url "$PROXY_HOME" --timeout-ms 20000 >/dev/null 2>&1
  taskweaver fill-form -i zp --selector "input" --value "$U" >/dev/null 2>&1
  # wait-navigation 은 **클릭 전에** 띄운다. 클릭이 0초에 반환되면서 문서가
  # 이미 갈아치워지면 목격할 교체가 없어 타임아웃을 다 쓴다(0.17.1 실측).
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

  # ── 판정 ────────────────────────────────────────────────────────────
  #
  # ★맨 먼저 "쟀는가" 를 본다. 2026-09-10 에 taskweaver 데몬이 죽은 채로 13분을
  # 돌렸는데 네 사이트가 전부 `=> OK` 로 나왔다 — 모든 값이 `?` 라 어떤 플래그도
  # 발화하지 않았기 때문이다. **안 잰 것과 통과한 것은 다르다.**
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
