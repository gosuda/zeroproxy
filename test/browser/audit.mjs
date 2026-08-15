// 사이트 하나를 프록시로 열고 같은 잣대로 잰다.
//   node audit.mjs <url> [waitMs]
// 축: (1) 격리 — 프록시 밖으로 나간 요청, (2) 재현성 — 미프록시 URL / 깨진 리소스,
//     (3) 멤브레인 소음 — CSP 위반, 403, 스타일 거부, postMessage 불일치
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const URL_ = process.argv[2];
const WAIT = Number(process.argv[3] || 14000);
const ID = 'zp';
const tw = (...a) => { try { return execFileSync('taskweaver', a, { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 180000 }); } catch (e) { return String((e.stdout || '') + (e.stderr || '')); } };
const j = s => { try { return JSON.parse(s); } catch { return null; } };

tw('clear-site-data', '-i', ID, '--types', 'all');
tw('console-logs', '-i', ID, '--clear', '--max', '1');
tw('dump-recording', '-i', ID, '--clear');
tw('navigate', '-i', ID, '--url', 'http://proxy.localhost:18080/zp/', '--timeout-ms', '20000');
tw('wait', '-i', ID, '--ms', '2000');
tw('fill-form', '-i', ID, '--selector', 'input', '--value', URL_);
tw('click', '-i', ID, '--selector', 'button');
tw('wait', '-i', ID, '--ms', String(WAIT));

const probe = readFileSync(new URL('./audit-probe.js', import.meta.url), 'utf8');
const dom = j(tw('exec-js', '-i', ID, '--world', 'isolated', '--script', probe));
const domRes = dom && dom.result ? j(dom.result) : { error: dom && dom.message || 'probe failed' };

// 격리축: 브라우저 자신의 기록에서 프록시 오리진 밖으로 나간 요청
const tape = j(tw('dump-recording', '-i', ID, '--filter', 'network')) || {};
const outside = new Map();
for (const e of (tape.network || [])) {
  const u = String(e.url || '');
  if (!/^https?:/i.test(u)) continue;
  if (u.indexOf('proxy.localhost') >= 0 || u.indexOf('127.0.0.1:18080') >= 0) continue;
  const host = u.split('/')[2] || u;
  outside.set(host, (outside.get(host) || 0) + 1);
}

const logs = (j(tw('console-logs', '-i', ID, '--max', '200')) || {}).logs || [];
const bucket = { csp: 0, http403: 0, styleRefused: 0, postMessage: 0, otherError: 0 };
const samples = {};
for (const l of logs) {
  const m = String(l.message || '');
  if (/frame-ancestors/.test(m)) continue;
  let k = null;
  if (l.source === 'csp') k = 'csp';
  else if (/status of 403/.test(m)) k = 'http403';
  else if (/Refused to apply style/.test(m)) k = 'styleRefused';
  else if (/postMessage/.test(m)) k = 'postMessage';
  else if (l.level === 'error') k = 'otherError';
  if (!k) continue;
  bucket[k]++;
  if (!samples[k]) samples[k] = m.slice(0, 120);
}

console.log(JSON.stringify({
  url: URL_,
  dom: domRes,
  outsideOrigins: [...outside.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
  console: bucket,
  samples
}));
