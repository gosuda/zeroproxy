#!/bin/bash
# wedge 재현 1회 — **올바른 대상 조건**: ncpt 만 차단, wtm 전부(27b3366 포함) 실행.
#
# 판정은 세 갈래다. ALIVE 를 그냥 "고쳐졌다" 로 읽으면 안 된다 —
# 트리거 파일이 아예 로드되지 않아 살아있는 경우가 실제로 세 번 나왔다.
#   WEDGE                        렌더러가 굳음 (= 재현됨)
#   ALIVE(27b3366 ran)           살아있고 트리거도 실행됨 (= 유의미한 개선)
#   INVALID(27b3366 never ran)   살아있지만 트리거 미실행 (= 판단 불가, 버릴 것)
cd /f/git/zeroproxy/.ai/dogfood/wtm
taskweaver kill --id zp >/dev/null 2>&1
sleep 3
(taskweaver start --id zp --width 1200 --height 800 >/dev/null 2>&1 &)
sleep 40
taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/" >/dev/null 2>&1
sleep 10
# 브라우저 프로필이 kill/start 를 넘어 살아남으므로 **낡은 SW 가 계속 돈다**.
# 이걸 안 지우면 sw.js 를 아무리 고쳐도 반영되지 않는다 — 실제로 계측본이
# 한 번도 로드되지 않은 채 WEDGE 를 관측했다(2026-08-10).
taskweaver clear-site-data -i zp --origin "http://proxy.localhost:18080" --types all >/dev/null 2>&1
taskweaver reload -i zp --hard >/dev/null 2>&1
sleep 12
taskweaver exec-js -i zp --script "document.getElementById('url').value='https://nid.naver.com/nidlogin.login'; document.querySelector('form').requestSubmit(); return 'sent'" >/dev/null 2>&1
sleep 30
OUT=$(timeout 45 taskweaver exec-js -i zp --script "
return JSON.stringify(performance.getEntriesByType('resource')
  .filter(function(r){ return /wtm\.pstatic|ncpt\.naver/.test(r.name); })
  .map(function(r){ return r.name.replace(/^.*\//,'').slice(0,26) + ':' + r.encodedBodySize; }))" 2>&1)
LIST=$(echo "$OUT" | grep -o '\[.*\]' | head -1)
if echo "$OUT" | grep -q '"status": "completed"'; then
  if echo "$LIST" | grep -qE "27b3366[^:]*:[0-9]{6,}"; then
    echo "ALIVE(27b3366 REALLY ran) $LIST"
  else
    echo "INVALID(27b3366 stubbed or absent) $LIST"
  fi
else
  echo "WEDGE"
fi
