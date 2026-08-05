// 프록시 로드본(wedge 직전 청크 회수)과 직접 로드본의 구조/스타일 diff.
// taskweaver get-html 은 {"html": "{\"ok\":true,\"value\":\"…\"}"} 처럼 래퍼가
// 두 겹이고, 안쪽 문자열에 raw 개행이 있어 JSON.parse 가 실패한다 → 수동 언이스케이프.
const fs = require('fs');
const BS = String.fromCharCode(92);

let h = JSON.parse(fs.readFileSync(__dirname + '/direct.raw', 'utf8')).html;
h = h.replace(/^\{"ok":true,"value":"/, '').replace(/"\}\s*$/, '');
h = h.split(BS + 'u003C').join('<').split(BS + 'u003E').join('>')
     .split(BS + 'u0026').join('&').split(BS + '"').join('"')
     .split(BS + 'n').join('\n').split(BS + BS).join(BS);
fs.writeFileSync(__dirname + '/direct.html', h);

const a = fs.readFileSync(__dirname + '/proxy.html', 'utf8');
const tags = t => (t.match(/<[a-zA-Z][a-zA-Z0-9-]*/g) || []).map(x => x.slice(1).toLowerCase());
const cnt = l => l.reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {});
const ta = tags(a), tb = tags(h), ca = cnt(ta), cb = cnt(tb);

console.log('tags proxy=' + ta.length + ' direct=' + tb.length);
[...new Set([...Object.keys(ca), ...Object.keys(cb)])].sort().forEach(k => {
  if ((ca[k] || 0) !== (cb[k] || 0)) console.log('  tag ' + k + ': p=' + (ca[k] || 0) + ' d=' + (cb[k] || 0));
});

const st = t => (t.match(/style="[^"]*"/g) || []);
console.log('style attrs p=' + st(a).length + ' d=' + st(h).length);
console.log('--- proxy inline styles:');
st(a).forEach(x => console.log('   P ' + x.slice(0, 120)));
console.log('--- direct inline styles:');
st(h).forEach(x => console.log('   D ' + x.slice(0, 120)));
