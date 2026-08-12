/*ZPCAP9*/
// 요청 목록 **전체**를 읽는다.
//
// 앞선 덤프는 40바이트에서 잘려 `["navigator.permissi…` 까지만 보였고,
// 실제로 `navigator.permissions.query()` 는 멤브레인에서 정상 동작한다
// (probe 페이지에서 resolved prompt). 즉 범인은 같은 배열의 **뒤쪽 항목**이다.
// 데이터는 UTF-16LE(5b 00 22 00 …)이므로 u16 뷰로 바로 디코드한다.
(function () {
  var W = window, C = console, D = Date, ST = setTimeout;
  var t0 = D.now();
  try { W.__ZPCAP_T0 = t0; } catch (e) {}
  function log(m) { try { C.log('ZPCAP9 ' + m + ' t=' + (D.now() - t0)); } catch (e) {} }
  log('boot');

  var MEM = null;
  function readU16(ptr, max) {
    try {
      if (!MEM || typeof ptr !== 'number' || ptr <= 0) return '?';
      if (ptr % 2) return 'odd-ptr';
      var u16 = new Uint16Array(MEM.buffer, 0, (MEM.buffer.byteLength >> 1));
      var i = ptr >> 1, out = '', n = 0;
      while (i < u16.length && n < (max || 600)) {
        var ch = u16[i++];
        if (ch === 0) break;
        out += String.fromCharCode(ch);
        n++;
      }
      return out;
    } catch (e) { return 'read-err'; }
  }

  var HOT = ['GkHXYEl9'];
  function isHot(k) { for (var i = 0; i < HOT.length; i++) if (k.indexOf(HOT[i]) >= 0) return true; return false; }

  var counts = Object.create(null);
  var cache = new WeakMap();
  var depth = 0;

  function wrapFn(key, fn) {
    var per = cache.get(fn);
    if (per) return per;
    var w = function () {
      var c = (counts[key] = (counts[key] || 0) + 1);
      var hot = isHot(key);
      if (hot) {
        // 마지막 인자가 요청 목록 포인터였다.
        var last = arguments[arguments.length - 1];
        log('ENTER x' + c + ' d=' + depth + ' list=' + readU16(last, 600));
      }
      depth++;
      try {
        var r = fn.apply(this, arguments);
        if (hot) log('LEAVE x' + c);
        return r;
      } finally { depth--; }
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
    return new Proxy(imp, { get: function (t, k) { return wrapNs(String(k), t[k]); } });
  }

  ['instantiate', 'instantiateStreaming'].forEach(function (m) {
    try {
      var WA = W.WebAssembly;
      if (!WA || typeof WA[m] !== 'function') return;
      var orig = WA[m];
      WA[m] = function (a, b) {
        var p = orig.call(WA, a, wrapImports(b));
        if (p && p.then) {
          p.then(function (res) {
            try {
              var inst = res && (res.instance || res);
              var ex = inst && inst.exports;
              if (ex) { for (var k in ex) { if (ex[k] && ex[k].buffer) { MEM = ex[k]; break; } } }
            } catch (e) {}
          }, function () {});
        }
        return p;
      };
    } catch (e) {}
  });

  for (var i = 1; i <= 20; i++) {
    (function (n) { ST(function () { log('tick' + n + ' nhomz=' + (typeof W.nhomz)); }, n * 2000); })(i);
  }
})();
