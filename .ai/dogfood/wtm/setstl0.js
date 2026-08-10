// dist prelude 맨 앞에 `Error.stackTraceLimit = 0` 을 넣는다.
//
// 왜 엔진 플래그가 아니라 페이지 레벨인가: `--browser-arg
// "--js-flags=--stack-trace-limit=0"` 은 **렌더러를 통째로 망가뜨린다**
// (about:blank + 자명한 exec-js 조차 타임아웃, 플래그 없이는 정상).
// 그래서 그 경로로 낸 WEDGE 판정은 무효였다.
//
// 이건 어디까지나 **가설 검증용**이다 — 스택 캡처가 wedge 의 원인이면 살아난다.
// 페이지에서 관측 가능한 값이라 그대로 출하할 물건은 아니다.
const fs = require('fs');
const p = 'f:/git/zeroproxy/dist/web/runtime-prelude.js';
let s = fs.readFileSync(p, 'utf8');

const MARK = '/*ZP_DEV_STL0*/';
if (s.indexOf(MARK) >= 0) { console.log('already set'); process.exit(0); }
s = MARK + 'try{Error.stackTraceLimit=0;}catch(e){}\n' + s;
fs.writeFileSync(p, s);
console.log('Error.stackTraceLimit=0 injected');
