// 재귀 지점 특정: 여러 덤프 중 **실제로 채워진 스택이 가장 깊은** 표본을 고른다.
// (앞선 실패: 스택 '영역 크기'(=예약 986KB)로 골라 빈 스택을 분석했다.)
// 깊은 표본에서 모듈 내 리턴 주소 빈도를 세면, 재귀 프레임이 수백~수천 번 반복돼 드러난다.
const fs = require('fs');
const d = process.env.TEMP + '/taskweaver-zp-pause/';
const SEP = String.fromCharCode(92);

function parse(fp) {
  const b = fs.readFileSync(fp);
  if (b.length < 32 || b.readUInt32LE(0) !== 0x504d444d) return null;
  const n = b.readUInt32LE(8), dir = b.readUInt32LE(12), st = {};
  for (let i = 0; i < n; i++) { const o = dir + i * 12; st[b.readUInt32LE(o)] = { rva: b.readUInt32LE(o + 8) }; }
  if (!st[3] || !st[4]) return null;
  const mb = st[4].rva, mn = b.readUInt32LE(mb);
  if (mn !== 22) return null;                       // wedged 렌더러 지문
  const mods = [];
  for (let i = 0; i < mn; i++) {
    const o = mb + 4 + i * 108, base = b.readBigUInt64LE(o), sz = BigInt(b.readUInt32LE(o + 8));
    const nr = b.readUInt32LE(o + 20), len = b.readUInt32LE(nr);
    mods.push({ base, end: base + sz, name: b.toString('utf16le', nr + 4, nr + 4 + len).split(SEP).pop() });
  }
  const tb = st[3].rva, tn = b.readUInt32LE(tb);
  if (tn < 25) return null;
  const o0 = tb + 4;
  const t0 = { id: b.readUInt32LE(o0), size: b.readUInt32LE(o0 + 32), rva: b.readUInt32LE(o0 + 36) };
  return { b, mods, t0 };
}

const locate = (mods, a) => { for (const m of mods) if (a >= m.base && a < m.end) return m.name + '+0x' + (a - m.base).toString(16); return null; };

const files = fs.readdirSync(d).filter(f => f.endsWith('.dmp'));
const cands = [];
for (const f of files) {
  let r; try { r = parse(d + f); } catch { continue; }
  if (!r) continue;
  // "채워진" 깊이 = 모듈 내 주소로 해석되는 8바이트 슬롯 개수
  let filled = 0;
  for (let off = 0; off + 8 <= r.t0.size; off += 8) {
    if (locate(r.mods, r.b.readBigUInt64LE(r.t0.rva + off))) filled++;
  }
  cands.push({ f, filled, r });
}
cands.sort((a, b) => b.filled - a.filled);
console.log('wedged-renderer dumps=' + cands.length);
cands.slice(0, 6).forEach(c => console.log('  filled=' + String(c.filled).padStart(6) + '  ' + c.f));

const best = cands[0];
if (!best) process.exit(1);
console.log('\n=== deepest sample: ' + best.f + ' (filled slots=' + best.filled + ')');
const hist = Object.create(null);
for (let off = 0; off + 8 <= best.r.t0.size; off += 8) {
  const loc = locate(best.r.mods, best.r.b.readBigUInt64LE(best.r.t0.rva + off));
  if (loc) hist[loc] = (hist[loc] || 0) + 1;
}
Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 25)
  .forEach(([k, v]) => console.log(String(v).padStart(7) + '  ' + k));
