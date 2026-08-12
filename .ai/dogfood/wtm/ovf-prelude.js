/*ZP_OVF_PROBE*/
// 스택 오버플로의 **실제 호출자**를 잡는다.
// 엔진이 던지는 RangeError 는 JS 생성자를 안 거치지만, SDK 가 그걸 잡고
// `.stack` 을 읽으면 V8 이 prepareStackTrace 를 부른다 — 거기서 CallSite 배열을
// 그대로 받을 수 있다. 번들 바로 앞(같은 realm)에서 설치해야 의미가 있다.
(function () {
  var n = 0, ovf = 0;
  window.__ZPOVF = { calls: 0, overflow: 0, frames: null, msgs: [] };
  try {
    Error.prepareStackTrace = function (err, sites) {
      n++; window.__ZPOVF.calls = n;
      var msg = '';
      try { msg = String(err && err.message || err); } catch (e) {}
      if (window.__ZPOVF.msgs.length < 8) window.__ZPOVF.msgs.push(msg.slice(0, 50));
      if (msg.indexOf('Maximum call stack') >= 0) {
        ovf++; window.__ZPOVF.overflow = ovf;
        if (!window.__ZPOVF.frames) {
          try {
            window.__ZPOVF.frames = sites.slice(0, 30).map(function (s) {
              return (s.getFunctionName() || '?') + '@' + s.getLineNumber() + ':' + s.getColumnNumber();
            });
          } catch (e) { window.__ZPOVF.frames = ['ERR ' + (e && e.message)]; }
        }
      }
      return String(err);
    };
  } catch (e) { window.__ZPOVF.install = String(e && e.message); }
})();
