// wedged 렌더러의 주 스레드 RIP 히스토그램.
// 3샘플로는 "공통 프레임 0개" 밖에 못 봤다 — 표본을 늘려 분포를 본다.
const fs = require('fs');
const d = process.env.TEMP + '/taskweaver-zp-pause/';
const files = fs.readdirSync(d).filter(f => f.endsWith('.dmp'))
  .map(f => ({ f, t: fs.statSync(d + f).mtimeMs })).sort((a, b) => b.t - a.t)
  .slice(0, 200).map(x => x.f);

function parse(fp) {
  const b = fs.readFileSync(fp);
  if (b.readUInt32LE(0) !== 0x504d444d) return null;
  const n = b.readUInt32LE(8), dir = b.readUInt32LE(12), st = {};
  for (let i = 0; i < n; i++) { const o = dir + i * 12; st[b.readUInt32LE(o)] = { rva: b.readUInt32LE(o + 8) }; }
  if (!st[3] || !st[4]) return null;
  const mb = st[4].rva, mn = b.readUInt32LE(mb), mods = [];
  const SEP = String.fromCharCode(92);
  for (let i = 0; i < mn; i++) {
    const o = mb + 4 + i * 108, base = b.readBigUInt64LE(o), sz = BigInt(b.readUInt32LE(o + 8));
    const nr = b.readUInt32LE(o + 20), len = b.readUInt32LE(nr);
    mods.push({ base, end: base + sz, name: b.toString('utf16le', nr + 4, nr + 4 + len).split(SEP).pop() });
  }
  const tb = st[3].rva, tn = b.readUInt32LE(tb), ths = [];
  for (let i = 0; i < tn; i++) {
    const o = tb + 4 + i * 48;
    ths.push({ id: b.readUInt32LE(o), rip: b.readBigUInt64LE(b.readUInt32LE(o + 44) + 0xf8) });
  }
  return { mods, ths };
}

const hist = {};
let used = 0;
for (const f of files) {
  const r = parse(d + f);
  if (!r) continue;
  if (r.mods.length !== 22 || r.ths.length < 25) continue; // wedged 렌더러 지문
  const t = r.ths[0];
  const m = r.mods.find(m => t.rip >= m.base && t.rip < m.end);
  const k = m ? m.name + '+0x' + (t.rip - m.base).toString(16) : '<JIT>';
  hist[k] = (hist[k] || 0) + 1;
  used++;
}
console.log('samples used:', used);
Object.entries(hist).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(String(v).padStart(3), k));
