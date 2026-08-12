// prepareStackTrace 스텁 + **계수기**. 스텁이 wedge 시점까지 살아있는지,
// 그리고 `.stack` 포맷이 실제로 몇 번 일어나는지를 페이지 realm 에 남긴다.
//
// 주의: `window.Error` 를 감싸서 세는 건 소용없다 — 엔진이 던지는 RangeError
// (`Maximum call stack size exceeded`)는 JS 생성자를 거치지 않는다.
// prepareStackTrace 는 `.stack` 이 **포맷될 때** 불리므로 그 경로를 직접 센다.
//
// taskweaver 0.12.0 부터 exec-js 가 main world 기본이라 DOM 밀반출 없이 바로 읽힌다.
const fs = require('fs');
const p = 'f:/git/zeroproxy/dist/web/runtime-prelude.js';
let s = fs.readFileSync(p, 'utf8');

const MARK = '/*ZP_DEV_PREP2*/';
if (s.indexOf(MARK) >= 0) { console.log('already set'); process.exit(0); }

const stub = MARK + `
(function(){
  try{
    var st = { prep: 0, installedAt: Date.now(), owner: 'zp' };
    window.__ZPSTK = st;
    Object.defineProperty(Error, 'prepareStackTrace', {
      get: function(){ return st.fn; },
      set: function(v){ st.hijackedBy = String(v).slice(0,80); st.fn = v; },
      configurable: true
    });
    st.fn = function(){ st.prep++; return ''; };
    Error.stackTraceLimit = 0;
  }catch(e){ try{ window.__ZPSTK = { err: String(e && e.message || e) }; }catch(_){} }
})();
`;
fs.writeFileSync(p, stub + s);
console.log('prepareStackTrace counter injected');
