#!/bin/bash
# 캡차가 실제로 초기화되는지 본다. ncpt 차단 유무를 교대로 비교한다.
#
# 관측은 **가볍게** — innerHTML 직렬화 같은 무거운 쿼리는 그 자체로 30초
# 타임아웃을 만들어 "굳었다" 와 구분이 안 된다(실측).
cd /f/git/zeroproxy/.ai/dogfood/wtm
N=${1:-2}

capture() {
  timeout 40 taskweaver exec-js -i zp --script "
    var rs = performance.getEntriesByType('resource');
    var sz = function(p){ return rs.filter(function(r){return r.name.indexOf(p)>=0;})
                            .map(function(r){return r.encodedBodySize;}); };
    var q = function(s){ try { return document.querySelectorAll(s).length; } catch(e){ return -1; } };
    return JSON.stringify({
      homz: typeof window.homz, nhomz: typeof window.nhomz,
      ncaptcha: typeof window.ncaptcha,
      main: sz('75b49359'), wasm: sz('8fbcc8a6'), second: sz('a3d739e9'), ncap: sz('ncaptcha-api'),
      capIframe: q('iframe[src*=\"ncpt\"], iframe[src*=\"captcha\"]'),
      capNode: q('[id*=\"captcha\"], [class*=\"captcha\"]'),
      bodyKids: document.body ? document.body.children.length : -1,
      diag: (window.__zp_diagnostics||[]).length
    });" 2>&1
}

run_once() {
  local LAB="$1"
  taskweaver kill --id zp >/dev/null 2>&1
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
  sleep 35
  # **자명한 프로브를 먼저** 던진다. 이걸 안 하면 "렌더러가 굳음" 과
  # "캡처 쿼리가 느림" 이 구분되지 않는다 — 앞선 4런이 정확히 그 상태였다.
  if ! timeout 40 taskweaver exec-js -i zp --script "return 1" >/dev/null 2>&1; then
    echo "$LAB: WEDGE"
    return
  fi
  capture > "cap-$LAB.json"
  node -e '
    const fs=require("fs");let j;
    try{ j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); }catch(e){ console.log(process.argv[2]+": UNPARSEABLE"); process.exit(0); }
    console.log(process.argv[2]+": " + (j.status==="completed" ? j.result : "ALIVE-but-capture-failed"));' "cap-$LAB.json" "$LAB"
}

for i in $(seq 1 "$N"); do
  cp /f/git/zeroproxy/web/sw.js /f/git/zeroproxy/dist/web/sw.js
  run_once "blocked-$i"
  cp /f/git/zeroproxy/web/sw.js /f/git/zeroproxy/dist/web/sw.js
  node disableblocks.js >/dev/null
  run_once "open-$i"
done
cp /f/git/zeroproxy/web/sw.js /f/git/zeroproxy/dist/web/sw.js
