// webpack publicPath(`n.p`) 유도 지점을 찾는다.
// 왜 중요한가: wasm URL 이 `n.p + "353dfc48….wasm"` 이다. 실브라우저는 이 wasm 을
// 받지만 프록시에서는 **아예 요청조차 하지 않는다**. n.p 가 어긋나면 그렇게 된다.
const fs = require('fs');
const s = fs.readFileSync(__dirname + '/wtm-raw.js', 'utf8');

const around = (i, before, after) =>
  s.slice(Math.max(0, i - before), i + after).replace(/\s+/g, ' ');

for (const needle of ['currentScript', 'importScripts', 'scriptUrl', 'getElementsByTagName']) {
  let i = s.indexOf(needle);
  console.log('\n### ' + needle + ' @' + i);
  if (i > 0) console.log(around(i, 420, 320));
}

console.log('\n### .p= assignments touching script/src/url');
let j = s.indexOf('.p=');
let n = 0;
while (j > 0 && n < 4) {
  const ctx = around(j, 300, 260);
  if (/script|src|url|http|origin|location/i.test(ctx)) { console.log('\n@' + j + ': ' + ctx); n++; }
  j = s.indexOf('.p=', j + 1);
}
