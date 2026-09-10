// 인터페이스 프로토타입의 **모양**을 찍는다. 대조군과 나란히 놓고 비교하는
// 것이 목적이라 이 프로브 자체는 판정하지 않는다.
//
// ★대문자 전역이라고 다 WebIDL 인터페이스가 아니다 — 페이지도 대문자 생성자를
// 만든다(naver 의 Agent/Flash 등). 진짜 인터페이스는 **생성자 자신이 네이티브**
// 이므로 그걸 관문으로 쓴다. 우리 대체 클래스(ZPWebSocket 등)는 toString 이
// 가려져 있어 관문을 통과한다 — 의도한 대로 검사 대상이 된다.
//
// ★`exec-js --file` 은 이 파일을 **함수 본문**으로 감싼다. IIFE 로 쓰면 값이
// 안 나온다 — 반드시 `return` 으로 끝낸다.
var NATIVE = /\{\s*\[native code\]\s*\}/;
var out = {};
var names = [];
try { names = Object.getOwnPropertyNames(window); } catch (e) { return JSON.stringify({ __error: 'enumerate:' + e.name }); }
for (var i = 0; i < names.length; i++) {
  var n = names[i];
  var c0 = n.charCodeAt(0);
  if (c0 < 65 || c0 > 90) continue;
  var proto = null;
  try {
    var iface = window[n];
    if (typeof iface !== 'function') continue;
    if (!NATIVE.test(Function.prototype.toString.call(iface))) continue;
    proto = iface.prototype;
  } catch (e) { continue; }
  if (!proto || typeof proto !== 'object') continue;
  try {
    // Symbol 키는 이름이 없으니 문자열 키만 본다. 정렬해서 순서 차이를
    // 차이로 오인하지 않게 한다.
    out[n] = Object.getOwnPropertyNames(proto).sort();
  } catch (e) { /* 접근 불가 프로토타입은 건너뛴다 */ }
}
return JSON.stringify(out);
