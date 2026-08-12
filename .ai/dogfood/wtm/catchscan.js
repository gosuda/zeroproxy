// 힙 덤프에서 catch 계수기 마커를 회수한다.
// 마커 형식: ZPCATCH#<catchId>#<count>#<첫 예외 메시지>
// 같은 id 가 여러 번(256, 512, …) 찍히므로 **최대 count** 만 남긴다.
const fs = require('fs');
const path = process.argv[2];
const CH = 64 * 1024 * 1024;

const fd = fs.openSync(path, 'r');
const size = fs.fstatSync(fd).size;
const buf = Buffer.allocUnsafe(CH);
const marks = new Map();
let overflow = 0, off = 0;
const RE = /ZPCATCH#(\d+)#(\d+)#([\x20-\x7e]{0,40})/g;
const PRINTABLE = /[^\x20-\x7e]/;

while (off < size) {
  const len = fs.readSync(fd, buf, 0, Math.min(CH, size - off), off);
  if (len <= 0) break;
  const sl = buf.subarray(0, len);
  for (const enc of ['latin1', 'utf16le']) {
    const h = sl.toString(enc);
    let i = -1;
    while ((i = h.indexOf('Maximum call stack size exceeded', i + 1)) >= 0) overflow++;
    let m; RE.lastIndex = 0;
    while ((m = RE.exec(h)) !== null) {
      const id = m[1], cnt = parseInt(m[2], 10);
      let msg = m[3];
      const bad = msg.search(PRINTABLE);
      if (bad >= 0) msg = msg.slice(0, bad);
      const prev = marks.get(id);
      if (!prev || cnt > prev.count) marks.set(id, { count: cnt, msg });
    }
  }
  off += len - 4096;
  if (len < CH) break;
}
fs.closeSync(fd);

console.log('dump bytes:', size);
console.log('overflow strings:', overflow);
console.log('catch ids seen:', marks.size);
[...marks.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12)
  .forEach(([id, v]) => console.log(String(v.count).padStart(8), 'catch#' + id, '|', v.msg.slice(0, 45)));
