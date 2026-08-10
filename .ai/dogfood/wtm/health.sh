#!/bin/bash
# 스텁 해제 후 건강도 1회: 렌더러 생존 + wtm 번들 로드 + window.nhomz 정의 + 콘솔 에러 수
cd /f/git/zeroproxy/.ai/dogfood/wtm
URL="${1:-https://nid.naver.com/nidlogin.login}"
taskweaver kill --id zp >/dev/null 2>&1
sleep 3
(taskweaver start --id zp --width 1200 --height 800 >/dev/null 2>&1 &)
sleep 40
taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/" >/dev/null 2>&1
sleep 10
taskweaver exec-js -i zp --script "document.getElementById('url').value='$URL'; document.querySelector('form').requestSubmit(); return 'sent'" >/dev/null 2>&1
sleep 30
OUT=$(timeout 45 taskweaver exec-js -i zp --script "
return JSON.stringify({
  wtm: performance.getEntriesByType('resource').filter(function(r){return /3e66f2|wtm\.pstatic/.test(r.name)}).map(function(r){return r.encodedBodySize}),
  nhomz: typeof window.nhomz,
  homz: typeof window.homz,
  body: document.body ? document.body.innerHTML.length : 0,
  diag: (window.__zp_diagnostics && window.__zp_diagnostics.length) || 0
})" 2>&1)
if echo "$OUT" | grep -q '"status": "completed"'; then
  echo "ALIVE $(echo "$OUT" | grep -o '{\\\"wtm.*}' | head -1)"
  taskweaver console-logs -i zp --level error --max 3 2>&1 | grep -o '"count": [0-9]*'
else
  echo "WEDGE"
fi
