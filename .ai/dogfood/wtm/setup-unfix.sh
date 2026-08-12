#!/bin/bash
set -e
node /f/git/zeroproxy/.ai/dogfood/wtm/unfix.js
node -e '
const s=require("fs").readFileSync("f:/git/zeroproxy/dist/web/runtime-prelude.js","utf8");
if (s.indexOf("ZP_DEV_UNFIX") < 0) { console.error("unfix wiring missing"); process.exit(1); }
new Function(s); console.log("unfix wiring OK");'
