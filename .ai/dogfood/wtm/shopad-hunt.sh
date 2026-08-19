#!/bin/sh
# shopad 재현 사냥: N회 로드하며 (1) shopad 모듈 부착 여부 (2) CSP 위반 (3) __zpRaw 적재를 본다.
URL=$(cat .ai/dogfood/wtm/naver-share.txt)
OUT=.ai/dogfood/wtm/shopad-hunt.log
N=${1:-20}
i=1
while [ $i -le $N ]; do
  taskweaver console-logs -i zp --clear >/dev/null 2>&1
  taskweaver navigate -i zp --url "$URL" --timeout-ms 25000 >/dev/null 2>&1
  sleep 7
  # shopad 부착 여부 — 메인 월드는 가상 URL(=원본)을 돌려주므로 이름으로 찾을 수 있다
  SHOP=$(taskweaver exec-js -i zp --world main --script "return [...document.querySelectorAll('iframe,div')].filter(e=>/shopsquare|shopping\.phinf|shopad/i.test((e.getAttribute&&e.getAttribute('src'))||e.className||'')).length" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).result)}catch(e){console.log('?')}})")
  CSP=$(taskweaver console-logs -i zp --source csp --max 100 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const d=JSON.parse(s);console.log((d.logs||d.entries||[]).length)}catch(e){console.log('?')}})")
  NF=$(taskweaver get-frames -i zp 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).total_count)}catch(e){console.log(0)}})")
  RAW=0
  j=0
  while [ $j -lt "$NF" ]; do
    n=$(taskweaver exec-js -i zp --frame $j --world isolated --script "return (globalThis.__zpRaw||[]).length" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).result||0)}catch(e){console.log(0)}})")
    RAW=$((RAW + n))
    j=$((j+1))
  done
  TOPRAW=$(taskweaver exec-js -i zp --world isolated --script "return (globalThis.__zpRaw||[]).length" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).result||0)}catch(e){console.log(0)}})")
  echo "run=$i shopad=$SHOP csp=$CSP frames=$NF raw_frames=$RAW raw_top=$TOPRAW" >> $OUT
  if [ "$CSP" != "0" ] || [ "$RAW" != "0" ] || [ "$TOPRAW" != "0" ]; then
    echo "  !! HIT on run $i — dumping" >> $OUT
    taskweaver console-logs -i zp --source csp --max 100 >> $OUT 2>&1
    j=0
    while [ $j -lt "$NF" ]; do
      taskweaver exec-js -i zp --frame $j --world isolated --script "return JSON.stringify((globalThis.__zpRaw||[]).slice(0,20))" >> $OUT 2>&1
      j=$((j+1))
    done
    taskweaver exec-js -i zp --world isolated --script "return JSON.stringify((globalThis.__zpRaw||[]).slice(0,20))" >> $OUT 2>&1
  fi
  i=$((i+1))
done
echo "DONE $N runs" >> $OUT
