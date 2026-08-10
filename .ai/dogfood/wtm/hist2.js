// hist.js 개선판. hist.js 는 threads[0] 만 봤는데 그건 대개 ntdll 에서 대기 중인
// 스레드라 "6/12 가 ntdll" 같은 무의미한 분포가 나왔다.
// 여기서는 **ntdll 대기 상태가 아닌 스레드**(= 실제로 도는 것)만 모아 히스토그램한다.
const fs = require('fs');
const d = process.env.TEMP + '/taskweaver-zp-pause/';
const files = fs.readdirSync(d).filter(f => f.endsWith('.dmp'))
  .map(f => ({ f, t: fs.statSync(d + f).mtimeMs })).sort((a, b) => b.t - a.t).map(x => x.f);

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
let dumps = 0, busy = 0;
for (const f of files) {
  const r = parse(d + f);
  if (!r) continue;
  if (r.mods.length !== 22 || r.ths.length < 25) continue;   // wedged 렌더러 지문
  dumps++;
  for (const t of r.ths) {
    const m = r.mods.find(m => t.rip >= m.base && t.rip < m.end);
    const name = m ? m.name : '<JIT>';
    if (name === 'ntdll.dll') continue;                       // 대기 중 — 관심 없음
    const k = name + '+0x' + (m ? (t.rip - m.base).toString(16) : t.rip.toString(16));
    hist[k] = (hist[k] || 0) + 1;
    busy++;
  }
}
console.log('renderer dumps:', dumps, ' busy-thread samples:', busy);
Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 20)
  .forEach(([k, v]) => console.log(String(v).padStart(3), k));
