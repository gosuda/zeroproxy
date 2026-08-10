#!/bin/bash
# publicPath 수정을 적용한 상태(= 실브라우저와 같은 wasm 경로)에서 wedge 를 만들고
# **여러 번** pause 해서 RIP 히스토그램을 만든다. 한 샘플로 "스핀" 이라고 부르면 안 된다.
#
# dist 에만 적용한다 — 소스 트리는 건드리지 않는다(출하 구성 보호).
set -e
cd /f/git/zeroproxy
cp web/runtime-prelude.js dist/web/runtime-prelude.js
node .ai/dogfood/wtm/applyfix.js
cp web/sw.js dist/web/sw.js
# 차단 전부 해제 — 실브라우저와 동일 조건.
node .ai/dogfood/wtm/disableblocks.js
grep -c "ZP_DEV publicPath fix" dist/web/runtime-prelude.js

cd .ai/dogfood/wtm
rm -rf "$TEMP/taskweaver-zp-pause"
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
sleep 35
for i in 1 2 3 4 5 6; do
  taskweaver pause -i zp --duration-ms 400 >/dev/null 2>&1 || true
  sleep 2
done
ls "$TEMP/taskweaver-zp-pause" | wc -l
