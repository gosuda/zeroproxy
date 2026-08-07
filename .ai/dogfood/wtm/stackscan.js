// "Maximum call stack size exceeded" 가 힙에 3,227개 있다 = 폭주 재귀.
// 어디서 재귀하는지: 그 문자열 주변의 스택 트레이스 문자열을 긁어 함수/URL 빈도를 센다.
const fs = require('fs');
const file = process.argv[2];
const size = fs.statSync(file).size;
const NEEDLE = 'Maximum call stack size exceeded';

const CHUNK = 64 * 1024 * 1024, OVERLAP = 8192;
const fd = fs.openSync(file, 'r');
const buf = Buffer.alloc(CHUNK + OVERLAP);

const frames = Object.create(null);   // "at fn (url:line)" 빈도
const near = Object.create(null);     // needle 주변 인쇄가능 문자열
let hits = 0, pos = 0;

while (pos < size) {
  const want = Math.min(CHUNK + OVERLAP, size - pos);
  const got = fs.readSync(fd, buf, 0, want, pos);
  if (got <= 0) break;
  const text = buf.toString('latin1', 0, got);

  let i = -1;
  while ((i = text.indexOf(NEEDLE, i + 1)) >= 0) {
    hits++;
    const ctx = text.slice(Math.max(0, i - 1200), Math.min(text.length, i + 1200));
    // "    at fn (url:line:col)" 형태 프레임 추출
    const fr = ctx.match(/at [^\s(]+ \([^)]{5,140}\)/g) || [];
    for (const f of fr) frames[f.slice(0, 130)] = (frames[f.slice(0, 130)] || 0) + 1;
    // 프레임이 안 잡히면 주변 URL 이라도
    const urls = ctx.match(/https?:\/\/[^\s"'<>]{10,120}/g) || [];
    for (const u of urls) near[u.slice(0, 110)] = (near[u.slice(0, 110)] || 0) + 1;
  }
  pos += CHUNK;
}
fs.closeSync(fd);

console.log('needle hits=' + hits);
const top = (m, n, t) => {
  console.log('\n=== ' + t);
  Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n)
    .forEach(([k, v]) => console.log(String(v).padStart(6) + '  ' + k));
};
top(frames, 20, '재귀 스택 프레임 (needle 주변)');
top(near, 15, 'needle 주변 URL');
