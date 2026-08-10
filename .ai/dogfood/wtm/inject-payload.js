// 계측본을 dist/web/sw.js 안에 **인라인**한다.
//
// 왜 네트워크로 안 주는가: 우리 CSP 가 `connect-src 'self'` 라서 SW 도 페이지도
// 127.0.0.1:18099 로 못 나간다("탈출 없는 감옥" 이 의도대로 동작한 결과).
// 로컬 싱크로 계측본을 내려주려던 시도가 전부 조용히 실패하고 진짜 CDN 으로
// 폴백했고, 그걸 "계측본을 쟀다" 로 오독했다(2026-08-10).
//
// 사용: node inject-payload.js <파일> [대상URL조각]
//   node inject-payload.js bvsd-cap.js              → 27b3366(bvsd) 대체
//   node inject-payload.js main-probe.js 3e66f2     → 메인 번들 대체
const fs = require('fs');
const SW = 'f:/git/zeroproxy/dist/web/sw.js';
const MARK = '\n/*ZP_DEV_PAYLOAD_BEGIN*/';

const src = process.argv[2];
const target = process.argv[3] || '27b3366';
if (!src) { console.error('usage: node inject-payload.js <file> [targetUrlFragment]'); process.exit(1); }
const body = fs.readFileSync(__dirname + '/' + src);

let sw = fs.readFileSync(SW, 'utf8');
const at = sw.indexOf(MARK);
if (at >= 0) sw = sw.slice(0, at);          // 이전 페이로드 제거 (재주입 가능)

sw += MARK
  + '\nconst ZP_DEV_TARGET = ' + JSON.stringify(target) + ';'
  + '\nconst ZP_DEV_BVSD_B64 = "' + body.toString('base64') + '";\n';
fs.writeFileSync(SW, sw);
console.log('injected ' + src + ' -> target=' + target + ' bytes=' + body.length + ' sw=' + sw.length);
