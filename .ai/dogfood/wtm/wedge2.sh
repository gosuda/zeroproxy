#!/bin/bash
# taskweaver 0.12.0 도구로 다시. publicPath 수정을 적용한(=실브라우저와 같은 wasm 경로)
# 상태에서 wedge 를 만들고, `pause --symbolize --samples` 로 히스토그램을 **한 번에** 얻는다.
# (예전엔 dump.js/hist2.js/symbolize.ps1/modpath.js 네 개를 거쳐야 했다.)
set -e
cd /f/git/zeroproxy
cp web/runtime-prelude.js dist/web/runtime-prelude.js
node .ai/dogfood/wtm/applyfix.js
cp web/sw.js dist/web/sw.js
node .ai/dogfood/wtm/disableblocks.js

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
sleep 35
# 살아있는지 먼저 확정한다 — 굳지 않았는데 히스토그램을 뜨면 의미가 없다.
if timeout 40 taskweaver exec-js -i zp --script "return 1" >/dev/null 2>&1; then
  echo "ALIVE (wedge 재현 실패 — 히스토그램 생략)"
  exit 0
fi
echo "WEDGE — 샘플링 시작"
taskweaver pause -i zp --symbolize --samples 8 --interval-ms 250 > "$1" 2>&1
echo "wrote $1 ($(wc -c < "$1") bytes)"
