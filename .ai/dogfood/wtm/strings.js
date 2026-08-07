// wedged 렌더러 덤프에서 "무엇이 대량으로 존재하는가" 를 센다.
// 프로세스는 minidump 지문(모듈 22 / 스레드 25+)으로 특정한다 —
// WorkingSet 최대값으로 고르면 브라우저/GPU 프로세스를 잘못 집는다(직전 실수).
const fs = require('fs');
const d = process.env.TEMP + '/taskweaver-zp-pause/';

function meta(fp) {
  const b = fs.readFileSync(fp);
  if (b.readUInt32LE(0) !== 0x504d444d) return null;
  const n = b.readUInt32LE(8), dir = b.readUInt32LE(12), st = {};
  for (let i = 0; i < n; i++) { const o = dir + i * 12; st[b.readUInt32LE(o)] = { rva: b.readUInt32LE(o + 8) }; }
  if (!st[3] || !st[4]) return null;
  return { b, mods: b.readUInt32LE(st[4].rva), ths: b.readUInt32LE(st[3].rva) };
}

const files = fs.readdirSync(d).filter(f => f.endsWith('.dmp'))
  .map(f => ({ f, t: fs.statSync(d + f).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 20);

let pick = null;
for (const { f } of files) {
  const m = meta(d + f);
  if (m && m.mods === 22 && m.ths >= 25) { pick = { f, m }; break; }
}
if (!pick) { console.log('wedged renderer dump not found; candidates:'); files.slice(0, 8).forEach(({ f }) => { const m = meta(d + f); if (m) console.log('  ' + f + ' mods=' + m.mods + ' ths=' + m.ths); }); process.exit(1); }

console.log('picked ' + pick.f + ' (mods=' + pick.m.mods + ' threads=' + pick.m.ths + ', ' + pick.m.b.length + ' bytes)');
const b = pick.m.b;

// UTF-16LE 로 저장된 V8 2바이트 문자열과 latin1 1바이트 문자열을 각각 훑는다.
const count = (text, label) => {
  const seen = Object.create(null);
  const re = /[\x20-\x7E]{12,}/g;
  let m;
  while ((m = re.exec(text))) {
    const k = m[0].slice(0, 60);
    seen[k] = (seen[k] || 0) + 1;
  }
  const top = Object.entries(seen).filter(([, v]) => v >= 3).sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.log('\n=== ' + label + ' (>=3회, 상위 20)');
  top.forEach(([k, v]) => console.log(String(v).padStart(6) + '  ' + k));
};

count(b.toString('latin1'), 'latin1 (1바이트 문자열/네이티브)');
count(b.toString('utf16le'), 'utf16le (V8 2바이트 문자열)');
