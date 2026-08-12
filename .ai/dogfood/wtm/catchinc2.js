// 카운터를 **클로저 지역**으로 두는 catch 계측.
//
// 앞선 실패의 이유: `__ZC[id]++` 의 `__ZC` 는 전역이라 zp-rewriter 가
// `__zp_get(scope,'__ZC')` 로 바꾼다. 즉 catch 마다 멤브레인 호출이 들어가
// "프레임을 늘리지 않는다" 는 의도가 무너졌다.
//
// 해법: 번들 전체를 IIFE 로 한 겹 감싸고 그 안에 `var __ZC` 를 둔다.
// 지역 식별자는 리라이터가 건드리지 않으므로 순수 배열 증가로 남는다.
// 번들은 이미 `(()=>{...})()` 로 자기완결이라 한 겹 더 감싸도 안전하다.
const fs = require('fs');
const inst = fs.readFileSync(__dirname + '/main-catch.js', 'utf8');

let body = inst.slice(inst.indexOf('\n}\n') + 3);
let n = 0;
body = body.replace(/__ZPC1\((\d+),[^)]*\);/g, (m, id) => { n++; return '__ZC[' + id + ']++;'; });

const out = '/*ZP_CATCH_INC2*/\n(function(){\nvar __ZC=new Array(' + n + ').fill(0);\n'
  + 'try{window.__ZPCATCH={n:__ZC};}catch(e){}\n'
  + body + '\n})();\n';

fs.writeFileSync(__dirname + '/main-inc2.js', out);
console.log('closure-local counters: ' + n + ', bytes=' + out.length);
