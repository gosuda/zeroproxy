// 힙 덤프에서 임의 needle 개수를 센다. 사용: node needles.js <dump> <needle…>
// "결과 0" 이 미실행인지 저빈도인지 가르는 용도 — 이 확인 없이 0을 해석하면 안 된다.
const fs = require('fs');
const path = process.argv[2];
const NEED = process.argv.slice(3);
const CH = 64 * 1024 * 1024;

const fd = fs.openSync(path, 'r');
const size = fs.fstatSync(fd).size;
const buf = Buffer.allocUnsafe(CH);
const c = {};
NEED.forEach(n => c[n] = { l1: 0, u16: 0 });
let off = 0;
while (off < size) {
  const len = fs.readSync(fd, buf, 0, Math.min(CH, size - off), off);
  if (len <= 0) break;
  const sl = buf.subarray(0, len);
  const l1 = sl.toString('latin1'), u16 = sl.toString('utf16le');
  for (const n of NEED) {
    let i = -1; while ((i = l1.indexOf(n, i + 1)) >= 0) c[n].l1++;
    i = -1; while ((i = u16.indexOf(n, i + 1)) >= 0) c[n].u16++;
  }
  off += len - 4096;
  if (len < CH) break;
}
fs.closeSync(fd);
console.log('bytes:', size);
for (const n of NEED) console.log(String(c[n].u16).padStart(7), String(c[n].l1).padStart(7), ' ', n);
