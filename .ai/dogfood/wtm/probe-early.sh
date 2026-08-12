#!/bin/bash
# wedge 는 제출 후 ~20초쯤 온다. 그 **전에** 페이지 realm 을 여러 번 들여다본다.
# taskweaver 0.12.0 의 main world 덕에 window.__ZPSTK 를 바로 읽을 수 있다.
set -e
cd /f/git/zeroproxy
cp web/runtime-prelude.js dist/web/runtime-prelude.js
node .ai/dogfood/wtm/applyfix.js
cp web/sw.js dist/web/sw.js
node .ai/dogfood/wtm/disableblocks.js
node .ai/dogfood/wtm/setprep2.js

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

for t in 4 8 12 16 20 26 32; do
  sleep 4
  # 파싱을 셸 grep 에 맡기지 않는다 — 패턴이 깨지면 빈 문자열이 나오고
  # 그걸 WEDGE 로 오판한다(실제로 한 번 당했다).
  timeout 20 taskweaver exec-js -i zp --script "
    var s = window.__ZPSTK;
    return JSON.stringify({ t: $t, stk: s || null, limit: Error.stackTraceLimit,
      prepIsFn: typeof Error.prepareStackTrace });" > "probe-$t.json" 2>&1 || true
  node -e '
    const fs=require("fs");let j;
    try{ j=JSON.parse(fs.readFileSync("probe-'"$t"'.json","utf8")); }catch(e){ console.log("t='"$t"'s UNPARSEABLE"); process.exit(0); }
    if(j.status!=="completed"){ console.log("t='"$t"'s WEDGE ("+(j.error||j.message||"?")+")"); process.exit(3); }
    console.log("t='"$t"'s "+j.result);' || exit 0
done
