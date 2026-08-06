// chrome-tracing 이벤트 집계. wedge 구간에서 무엇이 반복되는지 본다.
const fs = require('fs');
const raw = fs.readFileSync(__dirname + '/trace.json', 'utf8');
let ev;
try { const j = JSON.parse(raw); ev = Array.isArray(j) ? j : (j.traceEvents || []); }
catch (e) { console.log('parse fail, len=' + raw.length + ' head=' + raw.slice(0, 120)); process.exit(1); }

console.log('events=' + ev.length);
const byName = {}, durByName = {};
for (const e of ev) {
  if (!e || !e.name) continue;
  byName[e.name] = (byName[e.name] || 0) + 1;
  if (typeof e.dur === 'number') durByName[e.name] = (durByName[e.name] || 0) + e.dur;
}
console.log('\n=== top 25 by count:');
Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 25)
  .forEach(([k, v]) => console.log(String(v).padStart(8) + '  ' + k));
console.log('\n=== top 15 by total dur(us):');
Object.entries(durByName).sort((a, b) => b[1] - a[1]).slice(0, 15)
  .forEach(([k, v]) => console.log(String(Math.round(v)).padStart(10) + '  ' + k));
