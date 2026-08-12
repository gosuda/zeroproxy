#!/bin/bash
# 새 하네스(헤더 보존 + 본문 치환)로 catch 계수기를 싣고, 굳기 전에 읽는다.
# sw.js 는 호출 전에 setprelude.js 로 이미 구성돼 있어야 한다.
set -e
cd /f/git/zeroproxy/.ai/dogfood/wtm
taskweaver kill --id zp >/dev/null 2>&1 || true
sleep 3
(taskweaver start --id zp --width 1200 --height 800 >/dev/null 2>&1 &)
sleep 40
taskweaver navigate -i zp --url "https://nid.naver.com/nidlogin.login" >/dev/null 2>&1
sleep 20
taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/" >/dev/null 2>&1
sleep 8
taskweaver clear-site-data -i zp --origin "http://proxy.localhost:18080" --types all >/dev/null 2>&1
taskweaver reload -i zp --hard >/dev/null 2>&1
sleep 12
taskweaver exec-js -i zp --script "document.getElementById('url').value='https://nid.naver.com/nidlogin.login'; document.querySelector('form').requestSubmit(); return 'sent'" >/dev/null 2>&1
for t in 20 35 50 65 80; do
  sleep 15
  timeout 40 taskweaver exec-js -i zp --script "
    var z = window.__ZPCATCH;
    if (!z) return JSON.stringify({ t: $t, instr: false });
    var top = z.n.map(function(v,i){return [i,v];}).filter(function(p){return p[1]>0;})
                 .sort(function(a,b){return b[1]-a[1];}).slice(0,8);
    return JSON.stringify({ t: $t, instr: true, sites: z.n.filter(function(v){return v>0;}).length,
      total: z.n.reduce(function(a,b){return a+b;},0), top: top });" > "c2-$t.json" 2>&1 || true
  node -e '
    const fs=require("fs");let j;
    try{ j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); }catch(e){ console.log("t="+process.argv[2]+"s NO-OUTPUT"); process.exit(0); }
    console.log("t="+process.argv[2]+"s " + (j.status==="completed" ? j.result : "WEDGE"));' "c2-$t.json" "$t"
done
