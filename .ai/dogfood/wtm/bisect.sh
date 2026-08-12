#!/bin/bash
# 상태 쿼리의 어느 조각이 느린지 잰다. 조각마다 따로 던지고 시간을 기록한다.
cd /f/git/zeroproxy/.ai/dogfood/wtm
run() {
  local NAME="$1"; local SCRIPT="$2"
  local S=$(date +%s%3N)
  timeout 45 taskweaver exec-js -i zp --script "$SCRIPT" > "b-$NAME.json" 2>&1 || true
  local E=$(date +%s%3N)
  node -e '
    const fs=require("fs");let j;
    try{ j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); }catch(e){ console.log(process.argv[3]+"ms  UNPARSEABLE  <- "+process.argv[2]); process.exit(0); }
    const r = j.status==="completed" ? String(j.result).slice(0,60) : ("FAIL:"+(j.error||""));
    console.log(process.argv[3]+"ms  "+r+"  <- "+process.argv[2]);' "b-$NAME.json" "$NAME" "$((E-S))"
}
run trivial      "return 1"
run homz         "return typeof window.homz"
run nhomz        "return typeof window.nhomz"
run reslen       "return performance.getEntriesByType('resource').length"
run resmap       "return performance.getEntriesByType('resource').map(function(r){return r.encodedBodySize;}).length"
run bodykids     "return document.body ? document.body.children.length : -1"
run diag         "return (window.__zp_diagnostics||[]).length"
