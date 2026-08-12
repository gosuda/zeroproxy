// 번들 앞뒤에 마커를 붙인 본문을 만든다(REPLACE 모드용).
//
// 앞 마커만 있으면 "시작은 했다" 까지만 알 수 있다. 뒤 마커가 있어야
// 번들이 끝까지 동기 실행되는지, 아니면 중간에 오래 물려 있는지 갈린다.
//
// (셸에서 node -e 로 이런 문자열을 만들면 따옴표가 먹힌다 — 파일로 둔다.)
const fs = require('fs');
const pre = fs.readFileSync(__dirname + '/cap-prelude.js', 'utf8');
const src = fs.readFileSync(__dirname + '/wtm-new-main.js', 'utf8');

// t0 를 전역에 남겨 뒤 마커가 경과시간을 계산할 수 있게 한다.
const pre2 = pre.replace('var t0 = D.now();', 'var t0 = D.now(); try{ W.__ZPCAP_T0 = t0; }catch(e){}');

const post = [
  '',
  '/*ZPCAP_END*/',
  'try {',
  '  var __e0 = (window.__ZPCAP_T0 || 0);',
  "  console.log('ZPCAP end t=' + (Date.now() - __e0)",
  "    + ' homz=' + (typeof window.homz)",
  "    + ' nhomz=' + (typeof window.nhomz)",
  "    + ' ncaptcha=' + (typeof window.ncaptcha));",
  '} catch (e) {}',
  '',
].join('\n');

fs.writeFileSync(__dirname + '/cap-body.js', pre2 + src + post);
console.log('cap-body bytes=' + (pre2.length + src.length + post.length));
