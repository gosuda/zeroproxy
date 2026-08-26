#!/bin/sh
# 실사이트 렌더링/격리 3축 점검. 사이트마다:
#   title      — 문서가 실제로 떴는가
#   raw        — 격리 월드에서 본 **원본 URL** 서브리소스 (0 이어야 한다)
#   csp        — CSP 위반 (리라이트를 놓친 자리의 유일한 신호)
#   err        — 페이지 자신의 콘솔 에러
for U in "$@"; do
  taskweaver console-logs -i zp --clear >/dev/null 2>&1
  taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/" --timeout-ms 20000 >/dev/null 2>&1
  taskweaver fill-form -i zp --selector "input" --value "$U" >/dev/null 2>&1
  taskweaver click -i zp --text "Open" >/dev/null 2>&1
  taskweaver wait -i zp --ms 20000 >/dev/null 2>&1
  T=$(taskweaver get-url -i zp | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).title||'(no title)')}catch(e){console.log('?')}})")
  RAW=$(taskweaver exec-js -i zp --world isolated --script "var sel='img,script,link,iframe,source,video,audio,input,image,use';var a=[...document.querySelectorAll(sel)].map(e=>e.getAttribute('src')||e.getAttribute('href')||e.getAttribute('poster')||'');return a.filter(s=>/^https?:\/\//.test(s)&&!s.includes('proxy.localhost')).length" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).result)}catch(e){console.log('?')}})")
  CSP=$(taskweaver console-logs -i zp --source csp --max 100 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log((JSON.parse(s).logs||[]).length)}catch(e){console.log('?')}})")
  ERR=$(taskweaver console-logs -i zp --level error --max 100 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log((JSON.parse(s).logs||[]).length)}catch(e){console.log('?')}})")
  echo "$U | title=$T | raw=$RAW | csp=$CSP | err=$ERR"
done
