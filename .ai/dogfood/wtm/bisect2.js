// installDOMHooks 내부 후크 단위 이분 탐색.
// `X()` 형태의 설치 호출 앞에 `ZPD('name') ||` 를 끼워 skip 가능하게 만든다.
// (define(...) 은 문(statement)이라 `ZPD(n) || define(...)` 로 바꿔도 의미가 같다.)
const fs = require('fs');
const skip = (process.argv[2] || '').split(',').filter(Boolean);

const p = 'web/runtime-prelude.js';
let s = fs.readFileSync(p, 'utf8');

const head = '  function installDOMHooks(w) {';
if (!s.includes(head)) throw new Error('installDOMHooks anchor missing');
s = s.replace(head, head + '\n    // DIAG (임시) — 후크 단위 이분 탐색\n    const ZP_D_SKIP = ' + JSON.stringify(skip) + ';\n    const ZPD = (n) => ZP_D_SKIP.indexOf(n) >= 0;');

const TARGETS = [
  ["define(w.Element.prototype, 'setAttribute',", 'setAttribute'],
  ["define(w.Element.prototype, 'setAttributeNS',", 'setAttributeNS'],
  ["define(w.NamedNodeMap.prototype, 'setNamedItem',", 'setNamedItem'],
  ["define(w.Element.prototype, 'getAttribute',", 'getAttribute'],
  ["define(w.Element.prototype, 'hasAttribute',", 'hasAttribute'],
  ["define(w.Element.prototype, 'removeAttribute',", 'removeAttribute'],
  ["define(w.Element.prototype, 'getAttributeNames',", 'getAttributeNames'],
  ["define(w.Element.prototype, 'insertAdjacentHTML',", 'insertAdjacentHTML'],
  ['installIntegrityProp(w.HTMLScriptElement', 'integrityScript'],
  ['installIntegrityProp(w.HTMLLinkElement', 'integrityLink'],
  ['installScriptProp(w.HTMLScriptElement', 'scriptProp'],
  ['installScriptTextProps(w)', 'scriptText'],
  ['installLinkProp(w.HTMLLinkElement', 'linkProp'],
  ['installBaseObserver(w.document || document)', 'baseObserver'],
];

let n = 0;
for (const [needle, name] of TARGETS) {
  const i = s.indexOf(needle);
  if (i < 0) { console.error('MISS: ' + name); continue; }
  s = s.slice(0, i) + "ZPD('" + name + "') || " + s.slice(i);
  n++;
}
fs.writeFileSync(p, s);

const q = 'web/sw.js';
let w = fs.readFileSync(q, 'utf8');
const re = /(\r?\n)(\s*)if \(tu\.host === 'wtm\.pstatic\.net' \|\| tu\.host === 'ncpt\.naver\.com'\) \{/;
const inj = "$1$2// DIAG$1$2if (tu.host === 'wtm.pstatic.net' && tu.pathname.endsWith('.js')) {"
  + "$1$2  try {"
  + "$1$2    const local = await transportFetch('http://127.0.0.1:18099/zp-dev-wtm.js', { method: 'GET', headers: [['Accept','text/javascript,*/*']], tab, entryId: tab.activeEntryId });"
  + "$1$2    if (local && local.status < 400) {"
  + "$1$2      const text = await local.text();"
  + "$1$2      return rewriteScriptResponse(new Response(text, { status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8' } }), { targetUrl: target, kind });"
  + "$1$2    }"
  + "$1$2  } catch {}"
  + "$1$2}"
  + "$1$2if (tu.host === 'wtm.pstatic.net' || tu.host === 'ncpt.naver.com') {";
fs.writeFileSync(q, w.replace(re, inj));
console.log('wrapped=' + n + ' skip=' + JSON.stringify(skip));
