#!/bin/bash
# 캡차 상태를 **wedge 개시 이전**(제출 후 8~20초)에 수확한다.
# 35초 캡처는 wedge 개시와 겹쳐 해석이 갈렸다.
# 출력 파싱은 node 로 — 셸 파이프는 종료코드/버퍼링으로 결과를 조용히 잃는다.
cd /f/git/zeroproxy/.ai/dogfood/wtm
LAB=${1:-run}
taskweaver kill --id zp >/dev/null 2>&1
sleep 3
(taskweaver start --id zp --width 1200 --height 800 >/dev/null 2>&1 &)
sleep 38
taskweaver navigate -i zp --url "https://nid.naver.com/nidlogin.login" >/dev/null 2>&1
sleep 18
taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/" >/dev/null 2>&1
sleep 8
taskweaver clear-site-data -i zp --origin "http://proxy.localhost:18080" --types all >/dev/null 2>&1
taskweaver reload -i zp --hard >/dev/null 2>&1
sleep 10
taskweaver exec-js -i zp --script "document.getElementById('url').value='https://nid.naver.com/nidlogin.login'; document.querySelector('form').requestSubmit(); return 'sent'" >/dev/null 2>&1
for T in 8 14 20 28; do
  sleep 6
  timeout 30 taskweaver exec-js -i zp --script "
    var rs=performance.getEntriesByType('resource');
    var sz=function(p){return rs.filter(function(r){return r.name.indexOf(p)>=0;}).map(function(r){return r.encodedBodySize;});};
    return JSON.stringify({t:$T, homz:typeof window.homz, nhomz:typeof window.nhomz, ncaptcha:typeof window.ncaptcha,
      main:sz('75b49359'), wasm:sz('8fbcc8a6'), second:sz('a3d739e9'), ncap:sz('ncaptcha-api'), res:rs.length});" > "ec-$LAB-$T.json" 2>&1 || true
  node -e '
    const fs=require("fs");let j;
    try{ j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); }catch(e){ console.log(process.argv[2]+" t="+process.argv[3]+" NO-OUTPUT"); process.exit(0); }
    console.log(process.argv[2]+" t="+process.argv[3]+": " + (j.status==="completed" ? j.result : "WEDGE"));' "ec-$LAB-$T.json" "$LAB" "$T"
done
