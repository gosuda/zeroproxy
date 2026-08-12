// dev 계측을 **헤더 보존** 방식으로 설치한다 (dist 전용, 멱등).
//
// 왜 새로 만드나: 기존 installdev.js 는 upstream 을 아예 안 부르고 합성 Response 를
// 돌려줬다. 그러면 **무수정 원본을 실어도 20초에 굳는다**(정상 ~60초) — 경로 자체가
// 거동을 바꾼다는 뜻이라 메인 번들 계측에 못 쓴다(2026-08-12).
//
// 여기서는 정상 `transportFetch` 를 그대로 하고, 그 응답 **본문 앞에만** 프렐류드를
// 덧댄다. 상태/헤더는 원본을 그대로 물려준다. 프렐류드를 빈 문자열로 두면
// 완전한 no-op 이 되므로, 그 상태에서 정상 거동(~60초)이 나오는지로 하네스를 검증한다.
const fs = require('fs');
const p = 'f:/git/zeroproxy/dist/web/sw.js';
let s = fs.readFileSync(p, 'utf8');

if (s.indexOf('ZP_DEV_PATCH') >= 0) { console.log('already installed'); process.exit(0); }

const A = /(\r?\n)(\s*)const resp = await transportFetch\(target, \{ request: req, tab, entryId: tab\.activeEntryId \}\);(\r?\n)(\s*)return rewriteScriptResponse\(resp, \{ targetUrl: target, kind \}\);/;
if (!A.test(s)) throw new Error('anchor (script transportFetch) not found');

s = s.replace(A,
  '$1$2const resp = await transportFetch(target, { request: req, tab, entryId: tab.activeEntryId });'
  + '$1$2// ZP_DEV_PATCH — 응답 본문 앞에만 프렐류드를 덧댄다. 상태/헤더는 원본 유지.'
  + '$1$2if (ZP_DEV_PRELUDE && ZP_DEV_TARGET2 && target.indexOf(ZP_DEV_TARGET2) >= 0) {'
  + '$1$2  const src = await resp.text();'
  + '$1$2  // REPLACE 모드: 본문을 통째로 갈아끼운다. 그래도 upstream 요청은 **실제로**'
  + '$1$2  // 했으므로 쿠키/타이밍/헤더는 정상 경로 그대로다 — 합성 Response 로'
  + '$1$2  // 대체하던 옛 방식이 거동을 바꾼 지점이 바로 거기였다.'
  + '$1$2  const body = ZP_DEV_REPLACE ? ZP_DEV_PRELUDE : (ZP_DEV_PRELUDE + src);'
  + '$1$2  const patched = new Response(body, { status: resp.status, headers: resp.headers });'
  + '$1$2  return rewriteScriptResponse(patched, { targetUrl: target, kind });'
  + '$1$2}'
  + '$3$4return rewriteScriptResponse(resp, { targetUrl: target, kind });');

// 상수는 파일 끝에 붙인다(주입기가 갱신한다).
s += '\n/*ZP_DEV_PATCH_CONST*/\nconst ZP_DEV_TARGET2 = "";\nconst ZP_DEV_REPLACE = false;\nconst ZP_DEV_PRELUDE = "";\n';
fs.writeFileSync(p, s);
console.log('header-preserving dev patch installed');
