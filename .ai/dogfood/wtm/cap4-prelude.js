/*ZPCAP4*/
// wasm import 경계를 **Proxy 로** 감싼다.
//
// 앞선 시도는 Object.keys 로 import 객체를 재구성했다가
// `function import requires a callable` 로 인스턴스화를 깨뜨렸다 —
// 지연 게터로 노출되는 항목이 있어서 복사 시점엔 함수가 아니었다.
// Proxy 는 접근 시점에 원본을 읽으므로 그 지연 평가를 보존한다.
//
// 막힌 뒤에는 로그가 안 나가므로 **침묵 직전 마지막 enter** 가 범인이다.
(function () {
  var W = window, C = console, D = Date, ST = setTimeout;
  var t0 = D.now();
  try { W.__ZPCAP_T0 = t0; } catch (e) {}
  function log(m) { try { C.log('ZPCAP4 ' + m + ' t=' + (D.now() - t0)); } catch (e) {} }
  log('boot');

  var counts = Object.create(null);
  var cache = new WeakMap();
  var depth = 0;

  function wrapFn(key, fn) {
    var per = cache.get(fn);
    if (per) return per;
    var w = function () {
      var c = (counts[key] = (counts[key] || 0) + 1);
      if (c <= 2 || c % 1000 === 0) log('imp ' + key + ' #' + c + ' d=' + depth);
      depth++;
      try { return fn.apply(this, arguments); }
      finally { depth--; }
    };
    cache.set(fn, w);
    return w;
  }

  function wrapNs(mod, ns) {
    if (!ns || typeof ns !== 'object') return ns;
    return new Proxy(ns, {
      get: function (t, k) {
        var v = t[k];
        return typeof v === 'function' ? wrapFn(mod + '.' + String(k), v) : v;
      }
    });
  }

  function wrapImports(imp) {
    if (!imp || typeof imp !== 'object') return imp;
    return new Proxy(imp, {
      get: function (t, k) { return wrapNs(String(k), t[k]); }
    });
  }

  ['instantiate', 'instantiateStreaming'].forEach(function (m) {
    try {
      var WA = W.WebAssembly;
      if (!WA || typeof WA[m] !== 'function') return;
      var orig = WA[m];
      WA[m] = function (a, b) {
        log('WA.' + m + '.call');
        var p = orig.call(WA, a, wrapImports(b));
        if (p && p.then) {
          p.then(function () { log('WA.' + m + '.ok nhomz=' + (typeof W.nhomz)); },
                 function (e) { log('WA.' + m + '.reject ' + (e && e.message)); });
        }
        return p;
      };
    } catch (e) { log('hook.' + m + '.failed'); }
  });

  for (var i = 1; i <= 20; i++) {
    (function (n) { ST(function () { log('tick' + n + ' nhomz=' + (typeof W.nhomz)); }, n * 2000); })(i);
  }
})();
