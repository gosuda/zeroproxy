// 매트릭스 드라이버: 직접 로드(대조군) → 프록시 로드 → 표.
import { execFileSync } from 'node:child_process';

const ID = 'zp';
const PAGE = 'http://127.0.0.1:18099/page'; // server.mjs 가 띄우는 픽스처
const tw = (...a) => { try { return execFileSync('taskweaver', a, { encoding: 'utf8', timeout: 120000 }); } catch (e) { return String((e.stdout || '') + (e.stderr || '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async u => (await fetch(u)).json();

const cases = await get('http://127.0.0.1:18099/cases');
const idOf = url => { const m = /\/img\/([a-z0-9-]+)__(same|cross)\./.exec(url); return m && m[1]; };

async function arrivals() {
  const h = await get('http://127.0.0.1:18099/hits');
  const set = new Set();
  for (const port of Object.keys(h)) for (const u of h[port]) { const i = idOf(u); if (i) set.add(i); }
  return set;
}

async function loadDirect() {
  await fetch('http://127.0.0.1:18099/reset');
  tw('navigate', '-i', ID, '--url', PAGE);
  await sleep(6000);
  return arrivals();
}

async function loadProxy() {
  await fetch('http://127.0.0.1:18099/reset');
  tw('dump-recording', '-i', ID, '--clear');
  tw('navigate', '-i', ID, '--url', 'http://proxy.localhost:18080/zp/');
  tw('fill-form', '-i', ID, '--selector', 'input', '--value', PAGE);
  tw('click', '-i', ID, '--text', 'Open');
  await sleep(11000);
  const got = await arrivals();
  // 격리 축: 브라우저가 외부 오리진(18098)으로 **직접** 간 요청
  const tape = tw('dump-recording', '-i', ID, '--filter', 'network');
  const direct = new Set();
  for (const m of tape.matchAll(/"url":\s*"http:\/\/127\.0\.0\.1:1809[89][^"]*"/g)) {
    const i = idOf(m[0]); if (i) direct.add(i);
  }
  return { got, direct };
}

const control = await loadDirect();
const { got, direct } = await loadProxy();

const rows = [];
for (const c of cases) {
  const arrived = got.has(c.id);
  const wentDirect = direct.has(c.id);
  // 격리 판정은 두 신호의 조합이다.
  //   시도 O + 도착 O = 진짜 유출 (바이트가 우리를 거치지 않고 나갔다)
  //   시도 O + 도착 X = CSP 가 막았다 — 리라이트는 놓쳤고 2선 방어만 남았던 것
  //   시도 X          = 리라이트가 제대로 잡았다
  const containment = wentDirect ? (arrived ? 'LEAK' : 'csp-only') : 'ok';
  rows.push({
    id: c.id,
    cross: c.cross ? 'cross' : 'same',
    control: control.has(c.id) ? 'O' : '-',
    proxy: arrived ? 'O' : 'X',
    containment,
  });
}
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('case', 22), pad('오리진', 6), pad('직접로드', 8), pad('프록시', 6), '격리');
for (const r of rows) console.log(pad(r.id, 22), pad(r.cross, 6), pad(r.control, 8), pad(r.proxy, 6), r.containment);

const broken = rows.filter(r => r.control === 'O' && r.proxy === 'X');
const leaks = rows.filter(r => r.containment === 'LEAK');
const cspOnly = rows.filter(r => r.containment === 'csp-only');
console.log('\n[재현성] 대조군에서 되는데 프록시에서 안 되는 것:', broken.length ? broken.map(r => r.id).join(', ') : '없음');
console.log('[격리] 진짜 유출(바이트가 나감):', leaks.length ? leaks.map(r => r.id).join(', ') : '없음');
console.log('[격리] 리라이트는 놓쳤고 CSP 만 막은 것:', cspOnly.length ? cspOnly.map(r => r.id).join(', ') : '없음');
const notInControl = rows.filter(r => r.control === '-');
if (notInControl.length) console.log('(대조군에서도 안 온 케이스 — 픽스처 자체 문제일 수 있음):', notInControl.map(r => r.id).join(', '));
