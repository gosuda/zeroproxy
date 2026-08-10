// /zp/api/script 핸들러(= tab 이 스코프에 있음)에서 응답을 실측해 로컬 싱크로 보낸다.
// SW 전역 fetch 는 직접 egress 가 막히므로 반드시 transportFetch 를 쓴다(기록된 함정).
const fs = require('fs');
const p = 'web/sw.js';
let s = fs.readFileSync(p, 'utf8');

// 차단 해제 = WEDGE 재현 조건
const polRe = /if \(tu\.host === 'ncpt\.naver\.com'[\s\S]{0,260}?\n\s*\}/;
if (polRe.test(s)) s = s.replace(polRe, 'if (false) {\n        return new Response("", { status: 200 });\n      }');

const anchor = "    const resp = await transportFetch(target, { request: req, tab, entryId: tab.activeEntryId });";
if (!s.includes(anchor)) throw new Error('script-handler anchor missing');

const probe = anchor + "\n"
  + "    try {\n"
  + "      if (/wtm\\.pstatic\\.net|ncpt\\.naver\\.com/.test(target)) {\n"
  + "        const __c = resp.clone();\n"
  + "        const __b = await __c.text();\n"
  + "        const __h = [];\n"
  + "        try { resp.headers.forEach((v, k) => __h.push(k + '=' + String(v).slice(0, 30))); } catch {}\n"
  + "        const __msg = target.slice(-42) + '|st=' + resp.status + '|len=' + __b.length + '|' + __h.join(',').slice(0, 260);\n"
  + "        transportFetch('http://127.0.0.1:18099/m?HDR|' + encodeURIComponent(__msg), { method: 'GET', headers: [], tab, entryId: tab.activeEntryId }).catch(() => {});\n"
  + "      }\n"
  + "    } catch {}";
s = s.replace(anchor, probe);
fs.writeFileSync(p, s);
console.log('patched script-handler probe');
