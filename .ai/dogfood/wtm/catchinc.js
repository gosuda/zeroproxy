// 프레임을 늘리지 않는 catch 계측.
//
// 왜: `__ZPC1(id, e)` 호출을 넣으면 20초에 굳는데, 같은 자리에 주석만 넣으면
// 80초 ALIVE 다. 즉 소스 변경은 무해하고 **호출**이 문제다.
// 스택이 고갈된 상태의 catch 에서 함수를 부르면 프레임이 하나 더 필요해
// 다시 RangeError 가 나고, SDK 가 다른 경로를 타게 된다.
// 그래서 호출 없이 **배열 증가식 하나**만 넣는다 — 새 프레임이 없다.
const fs = require('fs');
const inst = fs.readFileSync(__dirname + '/main-catch.js', 'utf8');

// main-catch.js 의 프렐류드를 걷어내고 호출부만 증가식으로 바꾼다.
let body = inst.slice(inst.indexOf('\n}\n') + 3);
let n = 0;
body = body.replace(/__ZPC1\((\d+),[^)]*\);/g, (m, id) => { n++; return '__ZC[' + id + ']++;'; });

const prelude = '/*ZP_CATCH_INC*/\nvar __ZC=new Array(' + n + ').fill(0);'
  + 'try{window.__ZPCATCH={n:__ZC};}catch(e){}\n';

fs.writeFileSync(__dirname + '/main-inc.js', prelude + body);
console.log('call-free counters: ' + n + ', bytes=' + (prelude.length + body.length));
