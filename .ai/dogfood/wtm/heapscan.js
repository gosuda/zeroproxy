// 844MB full-memory 덤프에서 "무엇이 대량 복제되는가" 를 센다.
// 주의: 844MB 는 V8 최대 문자열(512MB)을 넘으므로 통째로 toString 하면
// ERR_STRING_TOO_LONG. 64MB 청크 + 겹침으로 훑는다.
// UTF-16 스캔은 바이너리를 문자열로 오독하므로 latin1(V8 1바이트 문자열)로 훑고,
// 문자 다양성/알파벳 비율로 바이너리를 거른다.
const fs = require('fs');
const file = process.argv[2];
const size = fs.statSync(file).size;
console.log('dump bytes=' + size);

const MARKERS = ['nid.naver.com', 'nhomz', 'wtm.pstatic', 'ncpt.naver', '__zp_', 'zp/api/script',
  'addHeapObject', 'proxy.localhost', 'data-zp-target-url', 'ncaptcha', 'asdom', 'Illegal invocation',
  'ZP_TRACKER_BLOCKED', 'globalThis'];

const looksReal = (s) => {
  if (new Set(s).size < 10) return false;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  return letters / s.length > 0.45;
};

const CHUNK = 64 * 1024 * 1024, OVERLAP = 4096;
const fd = fs.openSync(file, 'r');
const buf = Buffer.alloc(CHUNK + OVERLAP);

const seen = Object.create(null);
const marks = Object.create(null);
for (const m of MARKERS) marks[m] = 0;

let pos = 0, chunks = 0;
while (pos < size) {
  const want = Math.min(CHUNK + OVERLAP, size - pos);
  const got = fs.readSync(fd, buf, 0, want, pos);
  if (got <= 0) break;
  const text = buf.toString('latin1', 0, got);

  const re = /[\x20-\x7E]{24,}/g;
  let m;
  while ((m = re.exec(text))) {
    if (!looksReal(m[0])) continue;
    const k = m[0].slice(0, 72);
    seen[k] = (seen[k] || 0) + 1;
  }
  for (const mk of MARKERS) {
    let i = -1;
    while ((i = text.indexOf(mk, i + 1)) >= 0) marks[mk]++;
  }
  chunks++;
  pos += CHUNK; // OVERLAP 만큼 겹쳐 읽으므로 경계에서 잘린 문자열도 잡힌다
}
fs.closeSync(fd);
console.log('chunks=' + chunks);

console.log('\n=== latin1 복제 상위 25');
Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 25)
  .forEach(([k, v]) => console.log(String(v).padStart(7) + '  ' + k));

console.log('\n=== 마커 절대 빈도');
Object.entries(marks).sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(String(v).padStart(8) + '  ' + k));
