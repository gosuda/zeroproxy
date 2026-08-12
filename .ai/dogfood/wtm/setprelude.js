// ZP_DEV_PATCH 의 상수를 갱신한다.
//   node setprelude.js <targetFragment> [preludeFile]
// preludeFile 을 생략하면 프렐류드가 빈 문자열 = **완전한 no-op**(하네스 검증용).
const fs = require('fs');
const p = 'f:/git/zeroproxy/dist/web/sw.js';
let s = fs.readFileSync(p, 'utf8');

const MARK = '/*ZP_DEV_PATCH_CONST*/';
const at = s.indexOf(MARK);
if (at < 0) throw new Error('ZP_DEV_PATCH not installed — run installdev2.js first');

const target = process.argv[2] || '';
const file = process.argv[3];
const prelude = file ? fs.readFileSync(__dirname + '/' + file, 'utf8') : '';

s = s.slice(0, at) + MARK
  + '\nconst ZP_DEV_TARGET2 = ' + JSON.stringify(target) + ';'
  + '\nconst ZP_DEV_PRELUDE = ' + JSON.stringify(prelude) + ';\n';
fs.writeFileSync(p, s);
console.log('target=' + (target || '(none)') + ' preludeBytes=' + prelude.length);
