// `Object.defineProperty(X, 'p', { get(){ … X.p … } })` 형태의 **자기재귀 게터**를 찾는다.
//
// 실제로 이 버그가 있었다: Notification.permission 게터가 폴백으로 `NativeN.permission`
// 을 읽었는데 `NativeN` 이 바로 그 프로퍼티를 정의한 객체였다 → 무한 재귀 →
// 스택 오버플로 폭풍 → 렌더러가 수십 초 멈춤. 저장값이 있으면 조기 반환해서
// 간헐적으로만 보였다. 같은 실수가 더 있는지 기계적으로 확인한다.
const fs = require('fs');
const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node selfgetter.js <file…>'); process.exit(1); }

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /Object\.defineProperty\(\s*([A-Za-z0-9_$.]+)\s*,\s*['"]([A-Za-z0-9_$]+)['"]/g;
  let m, hits = 0, checked = 0;
  while ((m = re.exec(src)) !== null) {
    const obj = m[1], prop = m[2];
    checked++;
    // 정의 지점 이후 900자 안에서 `obj.prop` 을 그대로 읽는지 본다.
    const win = src.slice(m.index, m.index + 900);
    const selfRead = new RegExp('[^.\\w]' + obj.replace(/[.$]/g, '\\$&') + '\\.' + prop + '\\b');
    if (selfRead.test(win)) {
      hits++;
      const line = src.slice(0, m.index).split('\n').length;
      console.log(f + ':' + line + '  SELF-READ  ' + obj + '.' + prop);
      console.log('    ' + win.split('\n').slice(0, 6).map(s => s.trim()).join(' ').slice(0, 160));
    }
  }
  console.log(f + ': defineProperty sites=' + checked + ' suspicious=' + hits);
}
