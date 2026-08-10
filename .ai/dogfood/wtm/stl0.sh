#!/bin/bash
# 가설: wedge 는 **Error 스택 트레이스 캡처 폭풍**이다.
# 근거: 굳은 렌더러의 바쁜 스레드 6샘플 중 5개가 V8 스택워킹
#   (StackFrameIterator::Advance / OptimizedJSFrame::Summarize /
#    CallSiteInfo::GetFunctionDebugName / JSFunction::GetDebugName /
#    StackFrame::GcSafeLookupCodeAndOffset), 나머지는 Factory::AllocateRaw.
#   힙에 `Maximum call stack size exceeded` 문자열 3,229개.
#
# 검증: V8 에 --stack-trace-limit=0 을 주면 캡처가 O(1) 이 된다.
#   페이지에서 보이는 `Error.stackTraceLimit` 프로퍼티를 건드리지 않으므로
#   안티봇이 탐지할 만한 표면을 만들지 않는다(엔진 플래그).
#   wedge 가 사라지면 원인 확정, 그대로면 기각.
set -e
cd /f/git/zeroproxy
cp web/runtime-prelude.js dist/web/runtime-prelude.js
node .ai/dogfood/wtm/applyfix.js
cp web/sw.js dist/web/sw.js
node .ai/dogfood/wtm/disableblocks.js

cd .ai/dogfood/wtm
taskweaver kill --id zp >/dev/null 2>&1 || true
sleep 3
# --browser-arg 는 **새 데몬에만** 적용된다. 위에서 반드시 kill 해야 한다.
(taskweaver start --id zp --width 1200 --height 800 --browser-arg "--js-flags=--stack-trace-limit=0" >/dev/null 2>&1 &)
sleep 40
taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/" >/dev/null 2>&1
sleep 10
taskweaver clear-site-data -i zp --origin "http://proxy.localhost:18080" --types all >/dev/null 2>&1
taskweaver reload -i zp --hard >/dev/null 2>&1
sleep 12
taskweaver exec-js -i zp --script "document.getElementById('url').value='https://nid.naver.com/nidlogin.login'; document.querySelector('form').requestSubmit(); return 'sent'" >/dev/null 2>&1
sleep 35
OUT=$(timeout 45 taskweaver exec-js -i zp --script "
var rs=performance.getEntriesByType('resource').map(function(r){return r.name;});
var has=function(p){return rs.filter(function(n){return n.indexOf(p)>=0;}).length;};
return JSON.stringify({wasm:has('353dfc48'),bvsd:has('27b3366'),main:has('3e66f2'),errorLog:has('errorLog'),body:document.body?document.body.innerHTML.length:-1,homz:typeof window.homz,nhomz:typeof window.nhomz});" 2>&1)
if echo "$OUT" | grep -q '"status": "completed"'; then
  echo "ALIVE $(echo "$OUT" | grep -o '{.*}' | head -1)"
else
  echo "WEDGE"
fi
