// ncaptcha-api.js(9.5KB) 의 self-discovery 표면을 정적으로 훑는다.
const fs = require('fs');
const s = fs.readFileSync(__dirname + '/ncap-raw.js', 'utf8');
const pats = ['currentScript', 'querySelector', 'getElementsByTagName', 'getAttribute',
  '\\.src', 'location', 'document\\.write', 'setTimeout', 'setInterval', 'while\\s*\\(',
  'for\\s*\\(', 'appendChild', 'createElement', 'Promise', 'addEventListener'];
for (const p of pats) {
  const n = (s.match(new RegExp(p, 'g')) || []).length;
  if (n) console.log(String(n).padStart(4) + '  ' + p);
}
const show = (needle) => {
  let i = -1, k = 0;
  while ((i = s.indexOf(needle, i + 1)) >= 0 && k < 4) {
    console.log('  [' + needle + '] …' + s.slice(Math.max(0, i - 110), i + 110).replace(/\s+/g, ' '));
    k++;
  }
};
console.log('--- 문맥:');
['currentScript', 'querySelector', '.src', 'getAttribute'].forEach(show);
