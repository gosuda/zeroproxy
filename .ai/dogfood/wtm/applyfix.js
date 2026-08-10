// publicPath 수정을 dist/web/runtime-prelude.js 에만 적용한다(소스 트리 보호).
// diff/patch 는 CRLF 때문에 조용히 실패했다 — 문자열 치환이 확실하다.
const fs = require('fs');
const p = 'f:/git/zeroproxy/dist/web/runtime-prelude.js';
let s = fs.readFileSync(p, 'utf8');

const needle = "if (h === 'wtm.pstatic.net' || h === 'ncpt.naver.com') return d.get.call(this);";
if (s.indexOf(needle) < 0) throw new Error('exception line not found — already fixed?');

// 예외 한 줄만 무력화한다. 나머지 구조는 그대로 두어 부작용을 없앤다.
s = s.replace(needle, "if (false) return d.get.call(this);   /* ZP_DEV publicPath fix */");
fs.writeFileSync(p, s);
console.log('publicPath fix applied to dist');
