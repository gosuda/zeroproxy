// 무엇이 320번 요청되고, 어느 스크립트가 16,459 FunctionCall 을 만드는가.
const fs = require('fs');
const j = JSON.parse(fs.readFileSync(__dirname + '/trace.json', 'utf8'));
const ev = Array.isArray(j) ? j : (j.traceEvents || []);

const short = (u) => {
  if (!u) return '?';
  u = String(u);
  const m = u.match(/u=([^&]+)/);
  if (m) { try { return 'ZP>' + decodeURIComponent(m[1]).slice(0, 70); } catch { return 'ZP>' + m[1].slice(0, 70); } }
  return u.slice(0, 80);
};

const bump = (m, k) => (m[k] = (m[k] || 0) + 1);
const reqs = {}, fns = {}, ready = {};

for (const e of ev) {
  const a = (e && e.args) || {};
  const d = a.data || {};
  if (e.name === 'ResourceSendRequest') bump(reqs, short(d.url));
  else if (e.name === 'FunctionCall') bump(fns, short(d.url || d.scriptName || d.functionName));
  else if (e.name === 'Document::SetReadyState') {
    const k = Object.keys(a).map(x => x + '=' + JSON.stringify(a[x]).slice(0, 60)).join(' ');
    bump(ready, k || 'noargs');
  }
}

const top = (m, n, title) => {
  console.log('\n=== ' + title);
  Object.entries(m).sort((x, y) => y[1] - x[1]).slice(0, n)
    .forEach(([k, v]) => console.log(String(v).padStart(6) + '  ' + k));
};
top(reqs, 15, 'ResourceSendRequest by URL');
top(fns, 12, 'FunctionCall by script');
top(ready, 8, 'Document::SetReadyState args');
