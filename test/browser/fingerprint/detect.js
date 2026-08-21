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
    for (const [name, fn] of fns) {
      if (typeof fn !== 'function') continue;
      const s = Function.prototype.toString.call(fn);
      if (!/\{\s*\[native code\]\s*\}/.test(s)) add('toString', name + ' => ' + s.slice(0, 60));
    }
    const d = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (d && d.get && !/\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(d.get))) add('toString', 'cookie getter');
  } catch (e) { add('toString', 'err:' + e.name); }

  // ⑦ 리소스 타이밍 — 우리 에셋 이름이 남는가
  try {
    for (const e of performance.getEntriesByType('resource')) {
      if (/\/zp\/|zeroproxy|prelude|zp-core|zp_page|__zp/i.test(e.name)) add('resource timing', e.name);
    }
  } catch (e) { add('resource timing', 'err:' + e.name); }

  // ⑧ 프레임/문서 정체
  try {
    if (/proxy\.localhost|\/zp\/p\//.test(document.baseURI)) add('baseURI', document.baseURI);
    if (/proxy\.localhost|\/zp\/p\//.test(document.referrer)) add('referrer', document.referrer);
  } catch (e) { add('identity', 'err:' + e.name); }

  return JSON.stringify(hits);
})()
