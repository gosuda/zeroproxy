// 멤브레인 `get()` 에 재귀 깊이 계수기 + 상한을 건다 (dist 전용).
//
// 근거: 굳은 렌더러의 메인 스레드 스택에 `Builtins_LoadIC` 가 **2,961번** 반복된다.
// 프로퍼티 로드가 재귀한다는 뜻이고, 힙에는 `Maximum call stack size exceeded`
// 문자열이 3,231개 있다. 즉 "스택 넘칠 때까지 재귀 → RangeError → 재시도" 가
// 수천 번 반복된다. 루프가 아니라 재귀라 루프 상한으로는 안 잡혔던 것이다.
//
// 400 에서 기록하고 던진다. 기록만 하면 결국 굳어서 읽을 수가 없다.
const fs = require('fs');
const p = 'f:/git/zeroproxy/dist/web/runtime-prelude.js';
let s = fs.readFileSync(p, 'utf8');

const OPEN = 'function get(base, prop) {';
if (s.indexOf(OPEN) < 0) throw new Error('get() not found');
if (s.indexOf('__zpGetInner') >= 0) { console.log('already instrumented'); process.exit(0); }

const wrapper = `function get(base, prop) {
      var __D = (window.__ZPD || (window.__ZPD = { d: 0, max: 0, hit: null, caps: 0 }));
      if (++__D.d > __D.max) __D.max = __D.d;
      if (__D.d > 400) {
        if (!__D.hit) {
          __D.hit = { prop: String(prop), base: (function(){ try { return Object.prototype.toString.call(base); } catch (e) { return '?'; } })() };
          try {
            var __L = Error.stackTraceLimit; Error.stackTraceLimit = 60;
            __D.hit.stack = new Error('ZPDEPTH').stack;
            Error.stackTraceLimit = __L;
          } catch (e) {}
        }
        __D.caps++; __D.d--;
        throw new Error('ZP_GET_DEPTH_CAP');
      }
      try { return __zpGetInner(base, prop); } finally { __D.d--; }
    }
    function __zpGetInner(base, prop) {`;

s = s.replace(OPEN, wrapper);
fs.writeFileSync(p, s);
console.log('get() depth cap installed');
