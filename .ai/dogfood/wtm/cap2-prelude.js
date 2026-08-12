/*ZPCAP2*/
// 비동기 단계를 찍는다.
//
// 앞선 측정: 메인 번들 동기 실행은 33ms 에 끝나고 그때 nhomz 는 undefined 다.
// 예약한 타이머는 하나도 못 돌았다 → **막히는 건 그 뒤의 비동기 구간**이다.
// 가장 유력한 후보가 wasm 인스턴스화이므로 그 경계를 콘솔로 흘린다(push).
//
// 전역은 클로저 지역에 한 번만 잡는다 — 리라이터가 전역 읽기마다 __zp_get 을 넣는다.
(function () {
  var W = window, C = console, D = Date, ST = setTimeout;
  var t0 = D.now();
  try { W.__ZPCAP_T0 = t0; } catch (e) {}
  function log(m) { try { C.log('ZPCAP2 ' + m + ' t=' + (D.now() - t0)); } catch (e) {} }
  log('boot nhomz=' + (typeof W.nhomz));

  // fetch: .wasm 요청의 시작/완료 시각
  try {
    var nf = W.fetch;
    W.fetch = function (u) {
      var url = '';
      try { url = String((u && u.url) || u); } catch (e) {}
      var isWasm = url.indexOf('.wasm') >= 0;
      if (isWasm) log('fetch.start ' + url.slice(0, 90));
      var p = nf.apply(this, arguments);
      if (isWasm && p && p.then) {
        p.then(function (r) { log('fetch.ok status=' + (r && r.status)); },
               function (e) { log('fetch.err ' + (e && e.message)); });
      }
      return p;
    };
  } catch (e) { log('hook.fetch.failed'); }

  // WebAssembly 경계
  ['instantiateStreaming', 'compileStreaming', 'instantiate', 'compile'].forEach(function (m) {
    try {
      var WA = W.WebAssembly;
      if (!WA || typeof WA[m] !== 'function') { log('WA.' + m + ' missing'); return; }
      var orig = WA[m];
      WA[m] = function () {
        log('WA.' + m + '.call');
        var p;
        try { p = orig.apply(WA, arguments); }
        catch (e) { log('WA.' + m + '.throw ' + (e && e.message)); throw e; }
        if (p && p.then) {
          p.then(function () { log('WA.' + m + '.ok nhomz=' + (typeof W.nhomz)); },
                 function (e) { log('WA.' + m + '.reject ' + (e && e.message)); });
        }
        return p;
      };
    } catch (e) { log('hook.WA.' + m + '.failed'); }
  });

  // 살아 있으면 계속 흘린다. 하나도 안 찍히면 그 구간이 통째로 막힌 것이다.
  for (var i = 1; i <= 20; i++) {
    (function (n) { ST(function () { log('tick' + n + ' nhomz=' + (typeof W.nhomz)); }, n * 2000); })(i);
  }
})();
