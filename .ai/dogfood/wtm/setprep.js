// dist prelude 맨 앞에 `Error.prepareStackTrace` 를 상수 반환으로 박는다.
//
// 왜 stackTraceLimit=0 이 아니라 이것인가:
//   stackTraceLimit 은 Error 생성 시점의 **프레임 수집**만 제한한다.
//   그런데 굳은 렌더러의 8/8 샘플은 `CallSiteInfo::ComputeSourcePosition`,
//   `SharedFunctionInfo::EnsureSourcePositionsAvailable`,
//   `OptimizedJSFrame::Summarize` — 즉 `.stack` **문자열을 만드는** 경로였다.
//   prepareStackTrace 를 지정하면 V8 은 기본 포맷터를 건너뛰고, CallSite 의
//   getLineNumber() 등을 부르지 않는 한 소스 위치 계산을 아예 안 한다.
//
// 검증용이다. 페이지에서 관측 가능한 값이라 그대로 출하할 물건은 아니다.
const fs = require('fs');
const p = 'f:/git/zeroproxy/dist/web/runtime-prelude.js';
let s = fs.readFileSync(p, 'utf8');

const MARK = '/*ZP_DEV_PREP*/';
if (s.indexOf(MARK) >= 0) { console.log('already set'); process.exit(0); }
s = MARK + 'try{Error.prepareStackTrace=function(){return "";};Error.stackTraceLimit=0;}catch(e){}\n' + s;
fs.writeFileSync(p, s);
console.log('prepareStackTrace stub injected');
