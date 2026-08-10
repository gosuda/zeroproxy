#!/bin/bash
# 최종 검증: 차단을 **전부 풀고** 실브라우저와 같은 거동이 나오는지 본다.
#   기대: wasm(353dfc48) 로드됨, bvsd(27b3366) 요청 없음, 페이지 살아있음,
#         window.homz / nhomz 정의됨.
cd /f/git/zeroproxy/.ai/dogfood/wtm
taskweaver kill --id zp >/dev/null 2>&1
sleep 3
(taskweaver start --id zp --width 1200 --height 800 >/dev/null 2>&1 &)
sleep 40
taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/" >/dev/null 2>&1
sleep 10
taskweaver clear-site-data -i zp --origin "http://proxy.localhost:18080" --types all >/dev/null 2>&1
taskweaver reload -i zp --hard >/dev/null 2>&1
sleep 12
taskweaver exec-js -i zp --script "document.getElementById('url').value='https://nid.naver.com/nidlogin.login'; document.querySelector('form').requestSubmit(); return 'sent'" >/dev/null 2>&1
sleep 30
OUT=$(timeout 45 taskweaver exec-js -i zp --script "
var rs = performance.getEntriesByType('resource').map(function(r){return r.name;});
var has = function(p){ return rs.filter(function(n){return n.indexOf(p)>=0;}).length; };
return JSON.stringify({
  wasm: has('353dfc48'),
  bvsd: has('27b3366'),
  main: has('3e66f2'),
  errorLog: has('errorLog'),
  body: document.body ? document.body.innerHTML.length : -1,
  diag: (window.__zp_diagnostics||[]).length
});" 2>&1)
if echo "$OUT" | grep -q '"status": "completed"'; then
  echo "ALIVE $(echo "$OUT" | grep -o '{\\\"wasm.*}' | head -1)"
else
  echo "WEDGE"
fi
