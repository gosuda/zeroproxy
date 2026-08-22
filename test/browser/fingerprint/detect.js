// 타깃 사이트가 "나 프록시를 통과하고 있나?" 를 알아내려고 할 때 실제로 볼 만한
// 자리들을 그대로 훑는다. 우리 목록을 점검하는 게 아니라 **적의 코드를 돌린다.**
(function () {
  const hits = [];
  const add = (where, what) => hits.push({ where, what: String(what).slice(0, 160) });
  const ZP = /(^|[^a-z])zp[^a-z]|zeroproxy|__zp/i;

  // ① 전역 이름
  try {
    for (const k of Object.getOwnPropertyNames(window)) {
      if (/^__zp|^ZP$|zeroproxy/i.test(k)) add('window prop', k);
    }
  } catch (e) { add('window prop', 'err:' + e.name); }

  // ② 문서 마크업 — 가장 흔한 검사다. 통째로 훑어 우리 흔적을 찾는다.
  try {
    const html = document.documentElement.outerHTML;
    for (const m of html.match(/data-zp-[a-z-]+/gi) || []) add('outerHTML attr', m);
    for (const m of html.match(/[a-z-]*zeroproxy[a-z-]*/gi) || []) add('outerHTML text', m);
    if (/\/zp\/(assets|api)\//.test(html)) add('outerHTML url', (html.match(/\/zp\/(assets|api)\/[^"'\s]{0,40}/) || [])[0]);
  } catch (e) { add('outerHTML', 'err:' + e.name); }

  // ③ 속성 열거 — getAttribute 는 가려도 attributes/getAttributeNames 가 샐 수 있다.
  try {
    const els = document.querySelectorAll('*');
    const seen = new Set();
    for (let i = 0; i < els.length && i < 400; i++) {
      const el = els[i];
      for (const n of el.getAttributeNames()) if (/^data-zp-/i.test(n) && !seen.has(n)) { seen.add(n); add('getAttributeNames', n); }
      for (const a of el.attributes) if (/^data-zp-/i.test(a.name) && !seen.has('A' + a.name)) { seen.add('A' + a.name); add('attributes[]', a.name); }
    }
  } catch (e) { add('attributes', 'err:' + e.name); }

  // ④ 스크립트 태그 — 우리가 주입한 것이 보이는가
  try {
    for (const s of document.scripts) {
      const src = s.src || '';
      if (/\/zp\/|zeroproxy|prelude|zp-core|zp_page/i.test(src)) add('document.scripts', src);
    }
  } catch (e) { add('scripts', 'err:' + e.name); }

  // ⑤ 저장소 키
  try {
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (ZP.test(k)) add('localStorage', k); }
    for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (ZP.test(k)) add('sessionStorage', k); }
  } catch (e) { add('storage', 'err:' + e.name); }

  // ⑥ 후킹의 모양 — 네이티브면 [native code] 여야 하고, 접근자/데이터 구분도 실제와 같아야 한다.
  try {
    const fns = [
      ['fetch', window.fetch], ['setAttribute', Element.prototype.setAttribute],
      ['getAttribute', Element.prototype.getAttribute], ['appendChild', Node.prototype.appendChild],
      ['createObjectURL', URL.createObjectURL], ['Worker', window.Worker],
    ];
    // ★2026-08-22 — 예전에는 "네이티브가 아니면 우리 탓" 으로 셌다. 그건
    // 틀렸다 — **페이지가 자기 API 를 감싸는 건 정상**이다. github.com 은 자기
    // `fetch` 를 감싸고(`X-Fetch-Nonce` 처리), 그걸 우리 흔적으로 올려 불렀다.
    // 대조군(프록시 없이 직접 로드)에서 바이트 단위로 같은 문자열이 나오는 것을
    // 확인했다.
    //
    // 안에서는 '누가 감쌌는가' 를 알 수 없으므로, 우리 식별자가 드러난 때만
    // 센다. 그게 실제로 적에게 보이는 tell 이기도 하다.
    const OURS = /__zp|__ZP|ZeroProxy|ZPBundle|proxy\.localhost|\/zp\//;
    for (const [name, fn] of fns) {
      if (typeof fn !== 'function') continue;
      const s = Function.prototype.toString.call(fn);
      if (/\{\s*\[native code\]\s*\}/.test(s)) continue;
      if (OURS.test(s)) add('toString', name + ' => ' + s.slice(0, 60));
    }
    const d = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (d && d.get) {
      const g = Function.prototype.toString.call(d.get);
      if (!/\{\s*\[native code\]\s*\}/.test(g) && OURS.test(g)) add('toString', 'cookie getter');
    }
  } catch (e) { add('toString', 'err:' + e.name); }

  // ⑦ 리소스 타이밍 — 우리 에셋 이름이 남는가
  try {
    for (const e of performance.getEntriesByType('resource')) {
      if (/\/zp\/|zeroproxy|prelude|zp-core|zp_page|__zp/i.test(e.name)) add('resource timing', e.name);
    }
  } catch (e) { add('resource timing', 'err:' + e.name); }

  // ⑦-b 타이밍이 우리가 하는 말과 모순되는가 (2026-08-22 신설)
  //
  // 이름은 디프록시했는데 타이밍 필드는 그대로 둬서, `controller === null` 이라
  // 말해 놓고 모든 리소스가 `workerStart > 0` 이었다. 명세상 그건 불가능한
  // 조합이라 한 줄로 검사된다. 여기서는 "값이 뭐냐" 가 아니라 **우리 진술과
  // 어긋나는가**만 본다 — 절대값은 사이트마다 다르고 판정 근거가 못 된다.
  try {
    var es = performance.getEntriesByType('resource');
    var controlled = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    if (!controlled && es.length) {
      var worker = 0, emptyProto = 0;
      for (var i = 0; i < es.length; i++) {
        if (es[i].workerStart > 0) worker++;
        if (es[i].nextHopProtocol === '') emptyProto++;
      }
      if (worker) add('timing', 'workerStart>0 on ' + worker + '/' + es.length + ' with no controller');
      // SW 도 없는데 프로토콜이 전부 비어 있으면 누군가 응답을 합성한 것이다.
      if (emptyProto === es.length) add('timing', 'nextHopProtocol empty on all ' + es.length);
    }
    var nav = performance.getEntriesByType('navigation')[0];
    if (nav && !controlled) {
      if (nav.workerStart > 0) add('timing', 'navigation workerStart>0 with no controller');
      if (nav.deliveryType === 'cache' && !nav.transferSize && nav.encodedBodySize > 0) {
        add('timing', 'navigation claims cache but was not cached');
      }
    }
    // ★알려진 미해결: 우리 응답은 전부 "압축 안 됨" 으로 보인다.
    // SW 가 합성한 본문이라 브라우저가 encoded == decoded 로 잰다.
    // 실측(github): 대조군 118/135 가 압축, 프록시는 0/200.
    // 지어내면 안 되는 값이다 — 진짜 압축 크기는 트랜스포트만 안다.
    // 고치려면 SW 가 상류의 실제 encoded 크기를 헤더로 넘겨야 한다.
    var sized = 0, compressed = 0;
    for (var j = 0; j < es.length; j++) {
      if (!es[j].decodedBodySize) continue;
      sized++;
      if (es[j].encodedBodySize < es[j].decodedBodySize) compressed++;
    }
    if (sized >= 20 && compressed === 0) {
      add('timing', 'no response compressed (' + sized + ' sized entries) — known open item');
    }
  } catch (e) { add('timing', 'err:' + e.name); }

  // ⑧ 프레임/문서 정체
  try {
    if (/proxy\.localhost|\/zp\/p\//.test(document.baseURI)) add('baseURI', document.baseURI);
    if (/proxy\.localhost|\/zp\/p\//.test(document.referrer)) add('referrer', document.referrer);
  } catch (e) { add('identity', 'err:' + e.name); }

  return JSON.stringify(hits);
})()
