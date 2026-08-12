#!/bin/bash
# 콘솔 push 방식으로 캡차 전역을 회수한다. 페이지에 쿼리를 던지지 않는다.
set -e
cd /f/git/zeroproxy
cp web/sw.js dist/web/sw.js
cp web/runtime-prelude.js dist/web/runtime-prelude.js
node .ai/dogfood/wtm/disableblocks.js >/dev/null
node .ai/dogfood/wtm/installdev2.js >/dev/null
cd .ai/dogfood/wtm
# PREPEND 모드(3번째 인자 없음) — 원본 번들은 그대로 두고 앞에만 덧댄다.
node setprelude.js 75b49359 cap-prelude.js
node -e '
const s=require("fs").readFileSync("f:/git/zeroproxy/dist/web/sw.js","utf8");
for (const n of ["ZP_DEV_PATCH","ZPCAP"]) if (s.indexOf(n)<0){console.error("wiring missing: "+n);process.exit(1);}
new Function(s); console.log("wiring OK");'

taskweaver kill --id zp >/dev/null 2>&1 || true
sleep 3
# --record 는 새 데몬에만 적용된다. 반드시 kill 후 start.
(taskweaver start --id zp --width 1200 --height 800 --record >/dev/null 2>&1 &)
sleep 40
taskweaver navigate -i zp --url "https://nid.naver.com/nidlogin.login" >/dev/null 2>&1
sleep 18
taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/" >/dev/null 2>&1
sleep 8
taskweaver clear-site-data -i zp --origin "http://proxy.localhost:18080" --types all >/dev/null 2>&1
taskweaver reload -i zp --hard >/dev/null 2>&1
sleep 12
taskweaver exec-js -i zp --script "document.getElementById('url').value='https://nid.naver.com/nidlogin.login'; document.querySelector('form').requestSubmit(); return 'sent'" >/dev/null 2>&1
sleep 65
taskweaver dump-recording -i zp --filter console > "${1:-push}-console.json" 2>&1
node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
console.log("armed:", j.armed, " wedged_at_ms:", j.renderer_wedged_at_ms, " console entries:", (j.console||[]).length);
const lines=(j.console||[]).map(function(e){ return (e.text||(e.args||[]).join(" ")||""); }).filter(function(t){ return t.indexOf("ZPCAP")>=0; });
console.log("ZPCAP lines:", lines.length);
lines.slice(0,12).forEach(function(t){ console.log("  "+t); });
if (lines.length) console.log("  ...last: " + lines[lines.length-1]);' "${1:-push}-console.json"
