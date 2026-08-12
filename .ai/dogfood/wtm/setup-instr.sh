#!/bin/bash
# B팔 설정: 계측본(클로저 지역 카운터)을 본문 치환 모드로 싣는다.
set -e
cd /f/git/zeroproxy/.ai/dogfood/wtm
node catchinstr.js wtm-new-main.js main-catch.js >/dev/null
node catchinc2.js >/dev/null
node /f/git/zeroproxy/.ai/dogfood/wtm/installdev2.js >/dev/null
node setprelude.js 75b49359 main-inc2.js replace >/dev/null
# 배선 검증 — 조용히 실패하면 "계측 결과 0" 으로 오독하게 된다.
node -e '
const s=require("fs").readFileSync("f:/git/zeroproxy/dist/web/sw.js","utf8");
for (const n of ["ZP_DEV_PATCH","ZP_DEV_REPLACE = true","ZP_CATCH_INC2"]) {
  if (s.indexOf(n) < 0) { console.error("wiring missing: " + n); process.exit(1); }
}
new Function(s);
console.log("instr wiring OK");'
