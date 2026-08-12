#!/bin/bash
# ALIVE 런이 나올 때까지 반복해서 catch 계수기를 수확한다.
#
# 왜 반복인가: 같은 바이트로 WEDGE 와 ALIVE 가 번갈아 나온다(실측).
# 단일 런으로 "계측이 방아쇠" 라고 읽었다가 다음 런에서 뒤집혔다.
# 판정이 아니라 **수확**이 목적이므로, 살아난 런에서 값만 얻으면 된다.
#
# 사전 조건: setprelude.js 로 계측본이 이미 실려 있어야 한다.
cd /f/git/zeroproxy/.ai/dogfood/wtm
ATTEMPTS=${1:-3}

for a in $(seq 1 "$ATTEMPTS"); do
  echo "=== attempt $a/$ATTEMPTS ==="
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
  sleep 45
  timeout 40 taskweaver exec-js -i zp --script "
    var z = window.__ZPCATCH;
    if (!z) return JSON.stringify({ instr: false });
    var top = z.n.map(function(v,i){return [i,v];}).filter(function(p){return p[1]>0;})
                 .sort(function(a,b){return b[1]-a[1];}).slice(0,10);
    return JSON.stringify({ instr: true, sites: z.n.filter(function(v){return v>0;}).length,
      total: z.n.reduce(function(a,b){return a+b;},0), top: top });" > "harvest-$a.json" 2>&1 || true
  RES=$(node -e '
    const fs=require("fs");let j;
    try{ j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); }catch(e){ console.log("NO-OUTPUT"); process.exit(0); }
    console.log(j.status==="completed" ? j.result : "WEDGE");' "harvest-$a.json")
  echo "$RES"
  case "$RES" in
    *'"instr":true'*) echo "harvested on attempt $a"; exit 0 ;;
  esac
done
echo "no ALIVE run in $ATTEMPTS attempts"
