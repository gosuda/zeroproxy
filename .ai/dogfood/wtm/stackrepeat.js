// 폭주 재귀라면 메인 스레드 스택에 같은 리턴 주소가 수백~수천 번 반복된다.
// full-memory 덤프의 스레드 스택 영역을 8바이트씩 훑어 모듈 내 주소 빈도를 센다.
const fs = require('fs');
const file = process.argv[2];
const b = fs.readFileSync(file);
if (b.readUInt32LE(0) !== 0x504d444d) throw new Error('not a minidump');

const n = b.readUInt32LE(8), dir = b.readUInt32LE(12), st = {};
for (let i = 0; i < n; i++) { const o = dir + i * 12; st[b.readUInt32LE(o)] = { rva: b.readUInt32LE(o + 8) }; }

const SEP = String.fromCharCode(92);
const mb = st[4].rva, mn = b.readUInt32LE(mb), mods = [];
for (let i = 0; i < mn; i++) {
  const o = mb + 4 + i * 108, base = b.readBigUInt64LE(o), sz = BigInt(b.readUInt32LE(o + 8));
  const nr = b.readUInt32LE(o + 20), len = b.readUInt32LE(nr);
  mods.push({ base, end: base + sz, name: b.toString('utf16le', nr + 4, nr + 4 + len).split(SEP).pop() });
}
const locate = (a) => { for (const m of mods) if (a >= m.base && a < m.end) return m.name + '+0x' + (a - m.base).toString(16); return null; };

const tb = st[3].rva, tn = b.readUInt32LE(tb);
console.log('modules=' + mn + ' threads=' + tn);

// 스택이 가장 큰 스레드 = 재귀로 부풀어 오른 메인 스레드 후보
let best = null;
for (let i = 0; i < tn; i++) {
  const o = tb + 4 + i * 48;
  const t = { idx: i, id: b.readUInt32LE(o), size: b.readUInt32LE(o + 32), rva: b.readUInt32LE(o + 36) };
  if (!best || t.size > best.size) best = t;
  if (i === 0) console.log('thread0 tid=' + t.id + ' stack=' + (t.size / 1024).toFixed(0) + 'KB');
}
console.log('largest stack: tid=' + best.id + ' idx=' + best.idx + ' ' + (best.size / 1024).toFixed(0) + 'KB');

for (const t of [best]) {
  const hist = Object.create(null);
  for (let off = 0; off + 8 <= t.size; off += 8) {
    const v = b.readBigUInt64LE(t.rva + off);
    const loc = locate(v);
    if (loc) hist[loc] = (hist[loc] || 0) + 1;
  }
  const top = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.log('\n=== tid=' + t.id + ' 스택 내 모듈 주소 빈도 상위 20');
  top.forEach(([k, v]) => console.log(String(v).padStart(7) + '  ' + k));
}
