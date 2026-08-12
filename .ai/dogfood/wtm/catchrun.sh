#!/bin/bash
# catch 계측본을 메인 번들 자리에 넣고 돌린다.
# 주의: run3.sh 는 dist/web/sw.js 를 출하본으로 되돌리므로, 페이로드 주입과
# **분기 설치**를 그 뒤(extras)에 해야 한다. 분기 없이 상수만 붙이면
# 아무도 읽지 않아 계측본이 조용히 실행되지 않는다(실제로 한 번 당했다).
set -e
bash run3.sh injectmain.js 2>&1 | tail -3
PID=$(taskweaver pause -i zp --duration-ms 200 2>&1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=(j.candidate_processes||[]).filter(p=>p.type==="renderer").sort((a,b)=>b.working_set_bytes-a.working_set_bytes)[0];console.log(r?r.pid:"");});')
echo "renderer pid=$PID"
taskweaver pause -i zp --full-memory --only-pid "$PID" > fmcatch.json 2>&1
node -e 'const j=require("./fmcatch.json");console.log((j.minidump_paths||[])[0]||"")'
