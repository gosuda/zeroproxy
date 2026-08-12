// 멤브레인 `call()` 에 재귀 깊이 계수기 + 상한 (dist 전용).
//
// 왜 get() 이 아니라 call() 인가 — 앞선 계측의 결함:
//   get(base,prop) 은 **함수를 반환하고 즉시 끝난다**. 실제 호출은 call() 안의
//   Reflect.apply 에서 일어난다. 그래서 `__zp_call` 을 통한 재귀에서는 get 의
//   깊이가 매번 1이고, get 에 건 상한은 **원리적으로 발동할 수 없다**.
//   "멤브레인 재귀 기각(마커 1회)" 은 그 때문에 근거가 못 된다 → 여기서 다시 잰다.
const fs = require('fs');
const p = 'f:/git/zeroproxy/dist/web/runtime-prelude.js';
let s = fs.readFileSync(p, 'utf8');

// 줄바꿈이 CRLF 라 문자열 리터럴 매칭은 조용히 실패한다 — 정규식으로 받는다.
const OPEN = /function call\(base, prop, args\) \{\r?\n\s*const fn = get\(base, prop\);\r?\n\s*return Reflect\.apply\([^\n]*\);\r?\n\s*\}/;
if (!OPEN.test(s)) throw new Error('call() not found');
if (s.indexOf('__ZPC') >= 0) { console.log('already instrumented'); process.exit(0); }

const wrapped = `    function call(base, prop, args) {
      var __D = (window.__ZPC || (window.__ZPC = { d: 0, max: 0, hit: null, caps: 0 }));
      if (++__D.d > __D.max) __D.max = __D.d;
      if (__D.d > 500) {
        if (!__D.hit) {
          __D.hit = { prop: String(prop), depth: __D.d };
          try {
            var __L = Error.stackTraceLimit; Error.stackTraceLimit = 40;
            __D.hit.stack = new Error('ZPCALLDEPTH').stack;
            Error.stackTraceLimit = __L;
          } catch (e) {}
        }
        __D.caps++; __D.d--;
        throw new Error('ZP_CALL_DEPTH_CAP');
      }
      try {
        const fn = get(base, prop);
        return Reflect.apply(fn, base === scope ? root : base, Array.isArray(args) ? args : []);
      } finally { __D.d--; }
    }`;

fs.writeFileSync(p, s.replace(OPEN, wrapped));
console.log('call() depth cap installed');
