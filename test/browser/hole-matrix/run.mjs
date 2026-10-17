// Hole matrix runner comparing direct control loads against proxied loads.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { classifyTape } from './classify.cjs';

const ID = 'zp';
const PAGE = 'http://127.0.0.1:18099/page';
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
  const c = await get('http://127.0.0.1:18099/conns');
  return { got: await arrivals(), conns: c };
}

async function loadProxy() {
  await fetch('http://127.0.0.1:18099/reset');
  tw('dump-recording', '-i', ID, '--clear');
  tw('navigate', '-i', ID, '--url', 'http://proxy.localhost:18080/zp/');
  tw('fill-form', '-i', ID, '--selector', 'input', '--value', PAGE);
  tw('click', '-i', ID, '--text', 'Open');
  await sleep(11000);
  const got = await arrivals();
  const conns = await get('http://127.0.0.1:18099/conns');
  // Classify direct browser requests to 18098/18099 by their terminal event
  // (`response` vs `failed`) rather than target arrival alone, because the proxy
  // can also fetch the target resource after a direct request is blocked by CSP.
  const tapePath = 'test/browser/hole-matrix/.last-tape.json';
  tw('dump-recording', '-i', ID, '--filter', 'network', '--output', tapePath);
  let tape = {};
  try { tape = JSON.parse(fs.readFileSync(tapePath, 'utf8')); } catch {}
  const verdicts = classifyTape(tape, idOf);
  return { got, conns, ...verdicts };
}

const controlRun = await loadDirect();
const control = controlRun.got;
const { got, conns, attempted, answered, unknown, droppedNetwork } = await loadProxy();

const rows = [];
for (const c of cases) {
  const arrived = got.has(c.id);
  const tried = attempted.has(c.id);
  // Classify containment by direct request outcome:
  //   attempted + answered = LEAK (browser reached target directly)
  //   attempted + blocked  = csp-only (rewrite missed; CSP blocked the direct request)
  //   not attempted        = ok (rewrite intercepted the URL)
  const containment = !tried
    ? 'ok'
    : answered.has(c.id) ? 'LEAK'
    : unknown.has(c.id) ? 'undecided'
    : 'csp-only';
  rows.push({
    id: c.id,
    cross: c.cross ? 'cross' : 'same',
    control: control.has(c.id) ? 'O' : '-',
    proxy: arrived ? 'O' : 'X',
    containment,
  });
}
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('case', 22), pad('origin', 6), pad('direct', 8), pad('proxy', 6), 'containment');
for (const r of rows) console.log(pad(r.id, 22), pad(r.cross, 6), pad(r.control, 8), pad(r.proxy, 6), r.containment);

const broken = rows.filter(r => r.control === 'O' && r.proxy === 'X');
const leaks = rows.filter(r => r.containment === 'LEAK');
const cspOnly = rows.filter(r => r.containment === 'csp-only');
console.log('\n[fidelity] works in control but fails via proxy:', broken.length ? broken.map(r => r.id).join(', ') : 'none');
// Compare broken cases against declared `EXPECT_BLOCKED` entries to separate new regressions from intentional blocks.
const declared = new Map(cases.map(c => [c.id, c.blockedWhy]).filter(([, w]) => w));
const regressed = broken.filter(r => !declared.has(r.id));
const stale = rows.filter(r => declared.has(r.id) && r.control === 'O' && r.proxy === 'O');
console.log('\n[fidelity] intentionally blocked (declared):', declared.size ? [...declared.keys()].join(', ') : 'none');
if (regressed.length) {
  console.log(`[!!] [fidelity] undeclared breakage (regression): ${regressed.map(r => r.id).join(', ')}`);
  console.log('     If intentional, add to EXPECT_BLOCKED in server.mjs with a rationale.');
} else {
  console.log('[fidelity] undeclared breakage: none');
}
if (stale.length) {
  console.log(`[!] [fidelity] declared blocked but now working (stale declaration): ${stale.map(r => r.id).join(', ')}`);
  console.log('     Remove from EXPECT_BLOCKED in server.mjs.');
}
console.log('[containment] direct leak (bytes reached target):', leaks.length ? leaks.map(r => r.id).join(', ') : 'none');
console.log('[containment] missed by rewriter, blocked only by CSP:', cspOnly.length ? cspOnly.map(r => r.id).join(', ') : 'none');
// Measure `preconnect` via idle TCP sockets on dedicated port 18097 because
// `preconnect` opens a socket without sending an HTTP request, whereas proxy
// dials immediately issue requests.
const preControl = ((controlRun.conns || {}).idle || {})['18097'] || 0;
const preProxy = ((conns || {}).idle || {})['18097'] || 0;
const preControlTotal = ((controlRun.conns || {}).total || {})['18097'] || 0;
const preProxyTotal = ((conns || {}).total || {})['18097'] || 0;
console.log(`[containment] preconnect sockets opened to target: control ${preControl}/${preControlTotal} / proxy ${preProxy}/${preProxyTotal} (idle/total)`
  + (preProxy > 0 ? '  <- non-zero on proxy' : ''));
if (preControlTotal === 0) {
  console.log('     [-] Control Chrome did not issue preconnect (resource hint skipped); run is inconclusive.');
} else if (preControl === 0) {
  console.log('     [!] Control connected but recorded zero idle sockets; verify socket accounting.');
}
// Warn if the network tape dropped events, which can hide terminal `response` events.
if (droppedNetwork > 0) {
  console.log(`
[!!] Network tape dropped ${droppedNetwork} events; containment verdicts are unreliable.`);
  console.log('     Ring buffer overflowed. Reduce cases or run --clear immediately before loading.');
}
const undecided = rows.filter(r => r.containment === 'undecided');
if (undecided.length) {
  console.log('[!!] Cases with no terminal event for direct request:', undecided.map(r => r.id).join(', '));
  console.log('     Tape recorded request without response/failed. Re-run to rule out a leak.');
}
const notInControl = rows.filter(r => r.control === '-');
if (notInControl.length) console.log('(did not arrive in control run; check fixture):', notInControl.map(r => r.id).join(', '));
