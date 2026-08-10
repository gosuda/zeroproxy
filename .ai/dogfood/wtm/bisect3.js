// 올바른 대상 조건에서의 __zpStep 이분 탐색.
// sw.js: ncpt 만 차단(= wtm 의 27b3366 은 실제로 실행된다).
// prelude: 지정한 설치 단계를 건너뛴다.
const fs = require('fs');
const skip = (process.argv[2] || '').split(',').filter(Boolean);

const q = 'web/sw.js';
let w = fs.readFileSync(q, 'utf8');
const polRe = /if \(tu\.host === 'ncpt\.naver\.com'[\s\S]{0,260}?\n\s*\}/;
if (!polRe.test(w)) throw new Error('sw policy anchor missing');
w = w.replace(polRe, "if (tu.host === 'ncpt.naver.com') {\n        return new Response('/* ZP_TRACKER_BLOCKED */', { status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });\n      }");
fs.writeFileSync(q, w);

const p = 'web/runtime-prelude.js';
let s = fs.readFileSync(p, 'utf8');
const anchor = '  function __zpStep(name, fn) {';
if (!s.includes(anchor)) throw new Error('__zpStep anchor missing');
s = s.replace(anchor, [
  '  // DIAG (임시) — wedge 원인 서브시스템 이분 탐색 (올바른 대상 조건)',
  '  const ZP_DIAG_SKIP = ' + JSON.stringify(skip) + ';',
  anchor,
  '    if (ZP_DIAG_SKIP.indexOf(name) >= 0) { zpTrace("install:" + name + ":SKIPPED"); return; }',
].join('\n'));
fs.writeFileSync(p, s);
console.log('skip=' + JSON.stringify(skip));
