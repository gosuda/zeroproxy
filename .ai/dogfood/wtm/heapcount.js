// 800MB+ 풀메모리 덤프를 **청크로** 훑는다.
// strings.js 는 덤프 전체를 한 문자열로 만들려다 V8 문자열 상한(0x1fffffe8)에 걸려 죽었다.
//
// 목적 둘:
//   (1) 가설을 가르는 needle 개수 세기 (JS 문자열은 대개 UTF-16LE, 일부 latin1)
//   (2) **스택 프레임 모양** 문자열의 상위 반복을 뽑아, 무엇의 스택이 쌓이는지 보기
const fs = require('fs');
const path = process.argv[2];
const CHUNK = 64 * 1024 * 1024;
const OVERLAP = 4096;

const NEEDLES = [
  'Maximum call stack size exceeded',
  'proxy.localhost:18080/zp/api/script',
  'wtm.pstatic.net',
  '353dfc48',
  '27b3366',
  'runtime-prelude.js',
  'Illegal invocation',
  'Cannot redefine property',
  'at Object.',
  'RangeError',
];

const counts = Object.fromEntries(NEEDLES.map(n => [n, { u16: 0, l1: 0 }]));
const frameTally = new Map();
const FRAME_RE = /at [A-Za-z0-9_$.<> ]{1,60} \(https?:\/\/[^\s)]{1,120}\)/g;

const fd = fs.openSync(path, 'r');
const size = fs.fstatSync(fd).size;
const buf = Buffer.allocUnsafe(CHUNK);
let off = 0, chunks = 0;

while (off < size) {
  const len = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - off), off);
  if (len <= 0) break;
  const slice = buf.subarray(0, len);
  const l1 = slice.toString('latin1');
  // UTF-16LE 는 짝수 정렬 가정. 홀수 시작 문자열은 놓치지만 개수 비교엔 충분.
  const u16 = slice.toString('utf16le');

  for (const n of NEEDLES) {
    let i = -1; while ((i = l1.indexOf(n, i + 1)) >= 0) counts[n].l1++;
    i = -1;     while ((i = u16.indexOf(n, i + 1)) >= 0) counts[n].u16++;
  }
  for (const hay of [l1, u16]) {
    let m; FRAME_RE.lastIndex = 0;
    while ((m = FRAME_RE.exec(hay)) !== null) {
      const k = m[0].slice(0, 130);
      frameTally.set(k, (frameTally.get(k) || 0) + 1);
      if (frameTally.size > 200000) break;
    }
  }
  chunks++;
  off += len - OVERLAP;
  if (len < CHUNK) break;
}
fs.closeSync(fd);

console.log('chunks:', chunks, ' bytes:', size);
console.log('\n=== needle counts (utf16 / latin1) ===');
for (const n of NEEDLES) console.log(String(counts[n].u16).padStart(7), String(counts[n].l1).padStart(7), ' ', n);

console.log('\n=== top stack-frame strings ===');
[...frameTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
  .forEach(([k, v]) => console.log(String(v).padStart(6), k));
