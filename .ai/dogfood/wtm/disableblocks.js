// dist/web/sw.js 의 트래커 차단을 전부 해제한다(실브라우저와 동일 조건 실험용).
// 셸 인라인(node -e)은 중첩 따옴표 때문에 깨진다 — 파일로 둔다.
const fs = require('fs');
const p = 'f:/git/zeroproxy/dist/web/sw.js';
let s = fs.readFileSync(p, 'utf8');

const a = "if (tu.host === 'ncpt.naver.com'";
if (s.indexOf(a) < 0) throw new Error('block marker not found (already disabled?)');
s = s.replace(a, "if (false && tu.host === 'ncpt.naver.com'");
fs.writeFileSync(p, s);
console.log('blocks disabled');
