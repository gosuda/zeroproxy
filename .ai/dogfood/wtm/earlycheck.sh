#!/bin/bash
# 계측본이 실제로 실행됐는지 wedge 전에 직접 확인한다.
set -e
cd /f/git/zeroproxy
cp web/runtime-prelude.js dist/web/runtime-prelude.js
node .ai/dogfood/wtm/applyfix.js >/dev/null
cp web/sw.js dist/web/sw.js
node .ai/dogfood/wtm/disableblocks.js >/dev/null
node .ai/dogfood/wtm/injectmain.js | tail -1
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
for t in 5 9 13 17; do
  sleep 4
  timeout 20 taskweaver exec-js -i zp --script "
    var z = window.__ZPCATCH;
    var rs = performance.getEntriesByType('resource').filter(function(r){return r.name.indexOf('3e66f2')>=0;});
    return JSON.stringify({ t: $t, instrLoaded: !!z, marks: z? z.marks.length : -1,
      nonzero: z ? z.n.filter(function(v){return v>0;}).length : -1,
      sizes: rs.map(function(r){return r.encodedBodySize;}) });" > "ec-$t.json" 2>&1 || true
  node -e '
    const fs=require("fs");let j;
    try{ j=JSON.parse(fs.readFileSync("ec-'"$t"'.json","utf8")); }catch(e){ console.log("t='"$t"'s NO-OUTPUT"); process.exit(0); }
    console.log("t='"$t"'s " + (j.status==="completed" ? j.result : "WEDGE"));'
done
