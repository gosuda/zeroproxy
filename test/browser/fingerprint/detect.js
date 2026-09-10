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
    // 문서 하나는 아직 남아 있다. 스트리밍 경로가 상류의 Content-Encoding/Length 를
    // 떨구고 평문을 흘려보내므로 커널이 인코딩 크기를 실을 자리가 없고,
    // `/zp/p/<token>` 요청을 페이지가 보는 이름(가상 URL)으로 잇는 매핑도 없다.
    if (nav && nav.decodedBodySize > 50000 && nav.encodedBodySize === nav.decodedBodySize) {
      add('timing', 'navigation body uncompressed — known open item (streaming path)');
    }
  } catch (e) { add('timing', 'err:' + e.name); }

  // ⑦-c 컬렉션 표면이 실제 인터페이스와 다른가 (2026-08-24 신설)
  //
  // 우리는 `querySelectorAll` / `getElementsByTagName` / `document.scripts` /
  // `attributes` 를 필터 Proxy 로 감싸 우리 자산을 숨긴다. 그 Proxy 가 여섯
  // 자리에 **한 벌의 가짜 표면**을 씌우고 있었다. 실브라우저 실측(example.com):
  //   NodeList        forEach/values/keys/entries 있음, @@iterator === Array.prototype.values
  //   HTMLCollection  넷 다 undefined,               @@iterator === Array.prototype.values
  //   NamedNodeMap    넷 다 undefined,               @@iterator === Array.prototype.values
  // 그리고 실제 메서드는 접근할 때마다 **같은 객체**다.
  //
  // 여기서는 "값이 뭐냐" 가 아니라 **자기모순과 동일성**만 본다 — 사이트마다
  // 다를 수 없는 것들이라 대조군 없이도 판정이 선다.
  try {
    var hc = document.scripts;
    var nl = document.querySelectorAll('*');
    var nn = document.body && document.body.attributes;
    // (a) `in` 은 없다는데 값은 있다 — 한 줄짜리 탐지기다.
    var pairs = [['document.scripts', hc], ['attributes', nn]];
    for (var pi = 0; pi < pairs.length; pi++) {
      var nm = pairs[pi][0], c = pairs[pi][1];
      if (!c) continue;
      var meth = ['forEach', 'values', 'keys', 'entries'];
      for (var mi = 0; mi < meth.length; mi++) {
        var k = meth[mi];
        if (typeof c[k] === 'function' && !(k in c)) add('collection', nm + '.' + k + ' exists but not `in`');
        // HTMLCollection/NamedNodeMap 에는 애초에 없어야 한다.
        else if (typeof c[k] === 'function') add('collection', nm + '.' + k + ' should be undefined');
      }
    }
    // (b) @@iterator 동일성 — 셋 다 Array.prototype.values 여야 한다.
    var iters = [['document.scripts', hc], ['querySelectorAll', nl], ['attributes', nn]];
    for (var ii = 0; ii < iters.length; ii++) {
      var inm = iters[ii][0], ic = iters[ii][1];
      if (!ic) continue;
      if (ic[Symbol.iterator] !== Array.prototype.values) add('collection', inm + ' @@iterator is not Array.prototype.values');
    }
    // (c) NodeList 의 순회 메서드도 Array.prototype.* 와 같은 객체여야 한다.
    if (nl.forEach !== Array.prototype.forEach) add('collection', 'NodeList.forEach is not Array.prototype.forEach');
    // (d) 메서드 동일성이 접근마다 흔들리면 그것만으로 후킹이 드러난다.
    if (nl.forEach !== nl.forEach) add('collection', 'NodeList.forEach identity unstable');
    if (hc.item !== hc.item) add('collection', 'HTMLCollection.item identity unstable');
    if (nn && nn.getNamedItem !== nn.getNamedItem) add('collection', 'NamedNodeMap.getNamedItem identity unstable');
    // (e) 이름 기반 접근으로 숨긴 것이 되돌아 나오는가.
    var named = hc['__zp-boot'] || (hc.namedItem && hc.namedItem('__zp-boot'));
    if (named) add('collection', 'named access returns a hidden node: ' + (named.id || named.src || '?'));
  } catch (e) { add('collection', 'err:' + e.name); }

  // ⑧ data-zp-* 이름공간이 정말 닫혀 있는가 — 읽기·쓰기·삭제 표면 전부.
  //    2026-08-26 실측: 훅이 getAttribute/hasAttribute/getAttributeNames/
  //    attributes **넷뿐**이라 NS 변종·Attr 노드·dataset·named getter 가 전부
  //    뚫려 있었다. 목록이 아니라 **규칙**으로 닫혔는지 여기서 매번 확인한다.
  try {
    // ★한 노드만 고르면 안 된다 — 문서 순서상 맨 앞은 우리 자산 script 이고
    // 거기엔 표식이 없어서 축이 통째로 조용해진다(실측으로 밟았다). 적이 실제로
    // 하듯 **문서를 훑으며** 알려진 표식 이름을 찔러 본다.
    var ZPNAMES = ['data-zp-target-url', 'data-zp-internal', 'data-zp-blocked-ping', 'data-zp-blocked-rel'];
    var ZPN = ZPNAMES[0];
    var els = document.querySelectorAll('*');
    var probeEls = [];
    for (var pi = 0; pi < els.length && pi < 300; pi++) probeEls.push(els[pi]);
    probeEls.push(document.documentElement);
    var host = probeEls[0] || document.documentElement;
    // 'data-zp-target-url' → 'zpTargetUrl'
    var zpDatasetKey = function () { return ZPN.replace(/^data-/, '').replace(/-([a-z])/g, function (_, c2) { return c2.toUpperCase(); }); };
    var reads = [
      ['getAttribute', function () { return host.getAttribute(ZPN); }],
      ['hasAttribute', function () { return host.hasAttribute(ZPN) || null; }],
      ['getAttributeNS', function () { return host.getAttributeNS(null, ZPN); }],
      ['hasAttributeNS', function () { return host.hasAttributeNS(null, ZPN) || null; }],
      ['getAttributeNode', function () { return host.getAttributeNode(ZPN); }],
      ['getAttributeNodeNS', function () { return host.getAttributeNodeNS(null, ZPN); }],
      ['attributes[name]', function () { return host.attributes[ZPN]; }],
      ['attributes in', function () { return (ZPN in host.attributes) || null; }],
      ['attributes.getNamedItem', function () { return host.attributes.getNamedItem(ZPN); }],
      ['dataset', function () { var k = zpDatasetKey(); return (host.dataset && host.dataset[k]) || null; }],
      ['dataset in', function () { var k = zpDatasetKey(); return (host.dataset && (k in host.dataset)) || null; }],
      ['dataset keys', function () { var k = Object.keys(host.dataset || {}).filter(function (x) { return /^zp[A-Z]/.test(x); }); return k.length ? k.join(',') : null; }]
    ];
    for (var ri = 0; ri < reads.length; ri++) {
      var got = null;
      for (var hi = 0; hi < probeEls.length && !got; hi++) {
        host = probeEls[hi];
        for (var ni = 0; ni < ZPNAMES.length && !got; ni++) {
          ZPN = ZPNAMES[ni];
          try { got = reads[ri][1](); } catch (e) { got = null; }
        }
      }
      if (got) add('zp-namespace read', reads[ri][0] + ' -> ' + (got && got.value !== undefined ? got.value : got));
    }
    host = probeEls[0] || document.documentElement;
    // 쓰기가 통하면 페이지가 `data-zp-internal` 로 **자기 노드를 자기 눈에서**
    // 지울 수 있다 — 진짜 브라우저는 절대 재현 못 하는 신호다.
    var probe = document.createElement('div');
    probe.className = '__zpns';
    (document.body || document.documentElement).appendChild(probe);
    var writes = [
      ['setAttribute', function () { probe.setAttribute('data-zp-internal', '1'); }],
      ['setAttributeNS', function () { probe.setAttributeNS(null, 'data-zp-internal', '1'); }],
      ['toggleAttribute', function () { probe.toggleAttribute('data-zp-internal', true); }],
      ['dataset', function () { probe.dataset.zpInternal = '1'; }],
      ['setAttributeNode', function () { var a = document.createAttribute('data-zp-internal'); a.value = '1'; probe.setAttributeNode(a); }],
      ['setNamedItem', function () { var a = document.createAttribute('data-zp-internal'); a.value = '1'; probe.attributes.setNamedItem(a); }]
    ];
    for (var wi = 0; wi < writes.length; wi++) {
      try { writes[wi][1](); } catch (e) {}
      if (document.querySelectorAll('.__zpns').length === 0) add('zp-namespace write', writes[wi][0] + " hid the page's own node");
    }
    try { probe.remove(); } catch (e) {}
    if (host.attributes !== host.attributes) add('zp-namespace', 'el.attributes identity unstable');
    if (host.dataset !== host.dataset) add('zp-namespace', 'el.dataset identity unstable');
  } catch (e) { add('zp-namespace', 'err:' + e.name); }

  // ⑨ 프레임/문서 정체
  try {
    if (/proxy\.localhost|\/zp\/p\//.test(document.baseURI)) add('baseURI', document.baseURI);
    if (/proxy\.localhost|\/zp\/p\//.test(document.referrer)) add('referrer', document.referrer);
  } catch (e) { add('identity', 'err:' + e.name); }

  // ⑩ CSS 를 통한 정체 노출 — 우리가 url() 을 프록시 URL 로 바꿔 **쓰므로**,
  // 되돌려 주지 않는 읽기 표면이 하나라도 있으면 페이지가 자기 스타일을 다시
  // 읽는 것만으로 프록시 오리진과 내부 API 경로를 알아낸다. 2026-09-10 실측:
  // 이런 표면이 16개였다(인라인 프로퍼티 / cssText / getPropertyValue /
  // getAttribute 일가 / getComputedStyle / CSSRule.cssText).
  //
  // 목록으로 적지 않는다 — 페이지에 실제로 있는 스타일을 통째로 훑는다.
  try {
    var OURS = /\/zp\/(api|assets|p)\/|proxy\.localhost/;
    var say = function (where, v) { if (v && OURS.test(String(v))) add(where, String(v).match(OURS)[0]); };

    // (a) 페이지의 인라인 style 을 모든 읽기 경로로 훑는다.
    var styled = document.querySelectorAll('[style]');
    for (var i = 0; i < styled.length && i < 200; i++) {
      var e = styled[i];
      say('style attr', e.getAttribute('style'));
      say('style attrNS', e.getAttributeNS(null, 'style'));
      try { say('style attrNode', e.getAttributeNode('style').value); } catch (er) {}
      try { say('style attributes[]', e.attributes.style.value); } catch (er) {}
      say('style.cssText', e.style.cssText);
      for (var k = 0; k < e.style.length && k < 40; k++) {
        say('style.getPropertyValue', e.style.getPropertyValue(e.style[k]));
        try { say('style[prop]', e.style[e.style[k].replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); })]); } catch (er) {}
      }
    }

    // (b) 스타일시트 규칙 — 선언을 안 거치고 텍스트를 통째로 돌려주는 경로.
    var sheets = document.styleSheets;
    for (var si = 0; si < sheets.length && si < 40; si++) {
      var rules = null;
      try { rules = sheets[si].cssRules; } catch (er) { continue; }
      for (var ri = 0; rules && ri < rules.length && ri < 300; ri++) {
        say('CSSRule.cssText', rules[ri].cssText);
        try { say('CSSRule.style.cssText', rules[ri].style.cssText); } catch (er) {}
      }
    }

    // (c) getComputedStyle — **해결된** 값이라 리라이트 결과가 그대로 보인다.
    var probes = document.querySelectorAll('body, body *');
    for (var ci = 0; ci < probes.length && ci < 120; ci++) {
      var cs = null;
      try { cs = getComputedStyle(probes[ci]); } catch (er) { continue; }
      var props = ['background-image', 'border-image-source', 'list-style-image', 'mask-image', 'content', 'cursor', 'filter'];
      for (var pi = 0; pi < props.length; pi++) say('getComputedStyle', cs.getPropertyValue(props[pi]));
    }

    // (d) 왕복 — 페이지가 쓴 값을 그대로 돌려주는가. 다른 값이 나오면
    // 그 차이 자체가 멤브레인의 존재를 알려 준다.
    var rt = document.createElement('div');
    var mark = 'url("https://example.invalid/zp-roundtrip.png")';
    rt.style.backgroundImage = mark;
    if (rt.style.backgroundImage.indexOf('example.invalid') < 0) {
      add('css roundtrip', 'backgroundImage came back as ' + rt.style.backgroundImage);
    }
    say('css roundtrip', rt.style.backgroundImage);
    say('css roundtrip attr', rt.getAttribute('style'));
  } catch (e) { add('css-identity', 'err:' + e.name); }
  return JSON.stringify(hits);
})()
