#!/bin/bash
# 범용 러너. 사용: bash run3.sh [추가로 적용할 dist 패치 스크립트…]
#
# 게이트 교훈(2026-08-12): liveness 를 **한 번만** 재면 안 된다. 직전 런에서
# 35초 시점 프로브는 통과했고 그 **뒤에** 굳었다 — 그걸 ALIVE 로 보고할 뻔했다.
# 여기서는 창(90초)을 두고 반복해서 재고, 한 번이라도 타임아웃하면 WEDGE 다.
set -e
cd /f/git/zeroproxy
cp web/runtime-prelude.js dist/web/runtime-prelude.js
node .ai/dogfood/wtm/applyfix.js
cp web/sw.js dist/web/sw.js
node .ai/dogfood/wtm/disableblocks.js
for extra in "$@"; do node ".ai/dogfood/wtm/$extra"; done

cd .ai/dogfood/wtm
taskweaver kill --id zp >/dev/null 2>&1 || true
sleep 3
(taskweaver start --id zp --width 1200 --height 800 >/dev/null 2>&1 &)
sleep 40
taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/" >/dev/null 2>&1
sleep 10
taskweaver clear-site-data -i zp --origin "http://proxy.localhost:18080" --types all >/dev/null 2>&1
taskweaver reload -i zp --hard >/dev/null 2>&1
sleep 12
taskweaver exec-js -i zp --script "document.getElementById('url').value='https://nid.naver.com/nidlogin.login'; document.querySelector('form').requestSubmit(); return 'sent'" >/dev/null 2>&1

for t in 20 30 40 50 60 70 80 90; do
  sleep 10
  if ! timeout 25 taskweaver exec-js -i zp --script "return 1" >/dev/null 2>&1; then
    echo "WEDGE at ~${t}s"
    exit 0
  fi
done
echo -n "ALIVE(90s) "
timeout 40 taskweaver exec-js -i zp --script "
var rs=performance.getEntriesByType('resource').map(function(r){return r.name;});
var has=function(p){return rs.filter(function(n){return n.indexOf(p)>=0;}).length;};
return JSON.stringify({wasm:has('353dfc48'),bvsd:has('27b3366'),main:has('3e66f2'),errorLog:has('errorLog'),
  body:document.body?document.body.innerHTML.length:-1,homz:typeof window.homz,nhomz:typeof window.nhomz});" 2>&1 | grep -o '{[^}]*}' | head -1
