// 멤브레인 서브시스템 이분 탐색: __zpStep 을 이름으로 건너뛴다.
// 사용: node bisect.js "GetterMasking,DOMHooks,StealthMembrane"
const fs = require('fs');
const skip = (process.argv[2] || '').split(',').filter(Boolean);

const p = 'web/runtime-prelude.js';
let s = fs.readFileSync(p, 'utf8');
const anchor = '  function __zpStep(name, fn) {';
if (!s.includes(anchor)) throw new Error('__zpStep anchor missing');

const repl = [
  '  // DIAG (임시) — wedge 원인 서브시스템 이분 탐색.',
  '  const ZP_DIAG_SKIP = ' + JSON.stringify(skip) + ';',
  anchor,
  '    if (ZP_DIAG_SKIP.indexOf(name) >= 0) { zpTrace("install:" + name + ":SKIPPED"); return; }',
].join('\n');
s = s.replace(anchor, repl);
fs.writeFileSync(p, s);

const q = 'web/sw.js';
let w = fs.readFileSync(q, 'utf8');
const re = /(\r?\n)(\s*)if \(tu\.host === 'wtm\.pstatic\.net' \|\| tu\.host === 'ncpt\.naver\.com'\) \{/;
if (!re.test(w)) throw new Error('sw anchor missing');
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
console.log('skip=' + JSON.stringify(skip));
