// dist/web/sw.js 에 **페이로드를 읽는 dev 분기**를 설치한다 (멱등).
//
// 왜 필요한가: `cp web/sw.js dist/web/sw.js` 로 출하본을 되돌리면 분기가 사라진다.
// 그런데 inject-payload.js 는 파일 끝에 상수만 덧붙이므로, 분기가 없으면
// **아무도 그 상수를 읽지 않는다** → 계측본이 조용히 실행되지 않는다.
// 실제로 그 상태로 한 번 돌려서 "결과 0" 을 얻었다(계측본 소스가 힙에도 없었다).
const fs = require('fs');
const p = 'f:/git/zeroproxy/dist/web/sw.js';
let s = fs.readFileSync(p, 'utf8');

if (s.indexOf('__zpDevSink') >= 0) { console.log('dev branch already installed'); process.exit(0); }

// ① 플래그 선언 — `try { const tu = new URL(target);` 바로 앞
const A = /(\r?\n)(\s*)try \{(\r?\n)(\s*)const tu = new URL\(target\);/;
if (!A.test(s)) throw new Error('anchor A (try/const tu) not found');
s = s.replace(A, '$1$2let __zpDevSink = false;$1$2try {$3$4const tu = new URL(target);');

// ② 차단 조건 → dev 타깃이면 페이로드로, 아니면 원래대로 차단
// 앵커는 **현재 출하 형태**를 따라간다. 예전엔 해시 조건이 붙어 있었는데
// 2026-08-12 에 그걸 지웠고, 그 순간 이 앵커가 깨져 주입이 조용히 실패했다.
// `disableblocks.js` 가 먼저 돌면 `false && ` 가 붙으므로 그것도 받는다.
const B = /if \((false && )?tu\.host === 'ncpt\.naver\.com'\) \{/;
const mB = s.match(B);
if (!mB) throw new Error('anchor B (ncpt block condition) not found');
const disabled = mB[1] || '';   // 차단 해제 상태를 그대로 보존한다
s = s.replace(B,
  "if (tu.host === 'wtm.pstatic.net' && tu.pathname.indexOf(ZP_DEV_TARGET) >= 0) {\n"
  + '        __zpDevSink = true;\n'
  + '      } else if (' + disabled + "tu.host === 'ncpt.naver.com') {");

// ③ try/catch **밖**에서 페이로드를 돌려준다. 안에서 하면 실패가 삼켜져
//    진짜 CDN 으로 폴백하고 "계측본을 쟀다" 고 착각하게 된다(2026-08-10).
const C = /(\r?\n)(\s*)\} catch \{\}(\r?\n)(\s*)\/\/ request 자체를/;
if (!C.test(s)) throw new Error('anchor C (catch {} before transportFetch) not found');
s = s.replace(C,
  '$1$2} catch {}$1$2if (__zpDevSink) {$1$2  const bin = atob(ZP_DEV_BVSD_B64);$1$2  const bytes = new Uint8Array(bin.length);'
  + '$1$2  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);'
  + '$1$2  const body = new TextDecoder(\'utf-8\').decode(bytes);'
  + '$1$2  return rewriteScriptResponse(new Response(body, { status: 200,'
  + '$1$2    headers: { \'Content-Type\': \'text/javascript; charset=utf-8\' } }), { targetUrl: target, kind });'
  + '$1$2}$3$4// request 자체를');

fs.writeFileSync(p, s);
console.log('dev branch installed');
