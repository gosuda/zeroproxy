// dist prelude 를 **수정 이전 거동**으로 되돌린다 (A/B 의 대조 팔).
// 즉 wtm/ncpt 에 한해 `.src` 로 프록시 URL 을 흘리던 예외를 다시 넣는다.
const fs = require('fs');
const p = 'f:/git/zeroproxy/dist/web/runtime-prelude.js';
let s = fs.readFileSync(p, 'utf8');

const ANCHOR = '          // 마스킹 값을 돌려주는 건 원래의 strict 동작이라 E1 상 탈출면도 줄어든다.';
if (s.indexOf(ANCHOR) < 0) throw new Error('anchor not found — prelude shape changed');
if (s.indexOf('ZP_DEV_UNFIX') >= 0) { console.log('already unfixed'); process.exit(0); }

s = s.replace(ANCHOR, ANCHOR + '\n'
  + '          /*ZP_DEV_UNFIX*/\n'
  + '          try {\n'
  + '            const h = new Native.URL(masked).host;\n'
  + "            if (h === 'wtm.pstatic.net' || h === 'ncpt.naver.com') return d.get.call(this);\n"
  + '          } catch {}');
fs.writeFileSync(p, s);
console.log('pre-fix behaviour restored (dist only)');
