#!/bin/bash
# 오버플로 프로브를 붙이고, 굳기 전/후로 window.__ZPOVF 를 읽는다.
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
    var o = window.__ZPOVF;
    return JSON.stringify({ t: $t, installed: !!o, calls: o?o.calls:-1, overflow: o?o.overflow:-1,
      msgs: o?o.msgs:null, frames: o?o.frames:null });" > "ovf-$t.json" 2>&1 || true
  node -e '
    const fs=require("fs");let j;
    try{ j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); }catch(e){ console.log("t="+process.argv[2]+"s NO-OUTPUT"); process.exit(0); }
    console.log("t="+process.argv[2]+"s " + (j.status==="completed" ? j.result : "WEDGE"));' "ovf-$t.json" "$t"
done
