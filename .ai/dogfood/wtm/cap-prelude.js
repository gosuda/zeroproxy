/*ZPCAP*/
// 캡차 전역 상태를 **콘솔로 흘려보낸다**(pull → push).
// exec-js 로 물어보면 메인 스레드가 막힌 구간에 걸려 30초 타임아웃에 잡힌다.
// console.log 는 데몬이 --record 로 버퍼링하므로 렌더러가 굳어도 회수된다.
//
// 멤브레인 비용을 줄이려고 전역 참조를 클로저 지역에 한 번만 잡는다 —
// 리라이터는 전역 읽기마다 __zp_get 을 넣으므로 반복 접근은 그만큼 비싸다.
(function () {
  var W = window, C = console, ST = setTimeout, D = Date;
  var t0 = D.now();
  function tick(tag) {
    try {
      C.log('ZPCAP ' + tag + ' t=' + (D.now() - t0)
        + ' homz=' + (typeof W.homz)
        + ' nhomz=' + (typeof W.nhomz)
        + ' ncaptcha=' + (typeof W.ncaptcha));
    } catch (e) {}
  }
  tick('boot');
  for (var i = 1; i <= 20; i++) (function (n) { ST(function () { tick('t' + n); }, n * 3000); })(i);
})();
