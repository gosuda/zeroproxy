// 매트릭스 드라이버: 직접 로드(대조군) → 프록시 로드 → 표.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

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
  // 2026-08-20 — "시도했다" 와 "성공했다" 를 구분하지 않아 csp-only 를 LEAK 으로
  // 올려 부르고 있었다. 테이프에는 CSP 가 막은 요청도 `request` 로 남고(뒤에
  // `failed` 가 따라온다), 도착 축은 **우리 프록시가 대신 가져와도** 켜진다 —
  // 멤브레인이 뒤늦게 원본 URL 을 주워 프록시 경로로 다시 부르면 바이트는
  // 도착한다. 그래서 "시도 O + 도착 O = 유출" 이 성립하지 않는다. 실제로
  // a11~a15 가 그렇게 LEAK 으로 찍혔는데 직접 요청은 전부 `failed` 였다.
  //
  // 판정을 **직접 요청의 결과**로 바꾼다: 같은 request_id 에 `response` 가
  // 붙었으면 브라우저가 타깃과 실제로 말한 것(=유출), `failed` 만 있으면 막힌 것.
  const tapePath = 'test/browser/hole-matrix/.last-tape.json';
  tw('dump-recording', '-i', ID, '--filter', 'network', '--output', tapePath);
  let events = [];
  try { events = (JSON.parse(fs.readFileSync(tapePath, 'utf8')).network) || []; } catch {}
  const idByReq = new Map();
  for (const e of events) {
    if (e.kind !== 'request' || !e.url) continue;
    if (!/127.0.0.1:1809[89]/.test(e.url)) continue;
    const i = idOf(e.url);
    if (i) idByReq.set(e.request_id, i);
  }
  const attempted = new Set(idByReq.values());
  const answered = new Set();
  for (const e of events) {
    if (e.kind !== 'response') continue;
    const i = idByReq.get(e.request_id);
    if (i) answered.add(i);
  }
  return { got, attempted, answered };
}

const control = await loadDirect();
const { got, attempted, answered } = await loadProxy();

const rows = [];
for (const c of cases) {
  const arrived = got.has(c.id);
  const tried = attempted.has(c.id);
  // 격리 판정은 **직접 요청의 결과**로 한다.
  //   시도 O + 응답 O = 진짜 유출 (브라우저가 타깃과 실제로 말했다)
  //   시도 O + 응답 X = CSP 가 막았다 — 리라이트는 놓쳤고 2선 방어만 남았던 것
  //   시도 X          = 리라이트가 제대로 잡았다
  // 도착 축(arrived)은 재현성 지표로만 쓴다 — 우리 프록시가 대신 가져와도 켜진다.
  const containment = tried ? (answered.has(c.id) ? 'LEAK' : 'csp-only') : 'ok';
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
