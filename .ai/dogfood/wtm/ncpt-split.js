// ncpt 를 통째로 막지 말고 파일 단위로 나눠 어느 것이 wedge 트리거인지 본다.
// 인자: 차단할 ncpt 경로 패턴(콤마 구분). 예) "3e66f2"  /  "ncaptcha-api"  / ""(전부 허용)
const fs = require('fs');
const pats = (process.argv[2] || '').split(',').filter(Boolean);

const p = 'web/sw.js';
let s = fs.readFileSync(p, 'utf8');
const needle = "      if (tu.host === 'ncpt.naver.com'\n        || (tu.host === 'wtm.pstatic.net' && tu.pathname.indexOf('27b3366') >= 0)) {";
const needleCRLF = needle.replace(/\n/g, '\r\n');
const has = s.includes(needle) ? needle : (s.includes(needleCRLF) ? needleCRLF : null);
if (!has) throw new Error('policy anchor missing');

const repl = "      const ZP_NCPT_BLOCK = " + JSON.stringify(pats) + ";\n"
  + "      if ((tu.host === 'ncpt.naver.com' && ZP_NCPT_BLOCK.some(x => tu.pathname.indexOf(x) >= 0))\n"
  + "        || (tu.host === 'wtm.pstatic.net' && tu.pathname.indexOf('27b3366') >= 0)) {";
s = s.replace(has, repl.replace(/\n/g, has === needleCRLF ? '\r\n' : '\n'));
fs.writeFileSync(p, s);
console.log('ncpt block patterns=' + JSON.stringify(pats));
