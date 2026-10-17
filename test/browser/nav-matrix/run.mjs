// Navigation matrix runner verifying that top-level and child-frame navigations
// remain confined to the proxy origin.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const ID = 'zp';
const FIX = 'http://127.0.0.1:18087';
const PROXY = 'http://proxy.localhost:18080';
const tw = (...a) => { try { return execFileSync('taskweaver', a, { encoding: 'utf8', timeout: 120000 }); } catch (e) { return String((e.stdout || '') + (e.stderr || '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async u => (await fetch(u)).json();
const json = s => { try { return JSON.parse(s); } catch { return {}; } };

const cases = await get(FIX + '/cases');
const tapePath = 'test/browser/nav-matrix/.last-tape.json';

const rows = [];
for (const c of cases) {
  // Navigate to about:blank before resetting fixture hits so in-flight navigations
  // from the previous case do not pollute the control run.
  tw('navigate', '-i', ID, '--url', 'about:blank');
  await sleep(700);
  await fetch(FIX + '/reset');
  tw('navigate', '-i', ID, '--url', FIX + (c.path || '/nav/' + c.id));
  await sleep(5000);
  const controlHits = await get(FIX + '/hits');
  const controlLanded = Object.values(controlHits).flat().some(u => u.includes('/landed/' + c.id));

  // Navigate to about:blank before clearing the recording tape so remaining redirect
  // hops from the control run are not recorded as direct requests during the proxy run.
  tw('navigate', '-i', ID, '--url', 'about:blank');
  await sleep(1500);
  await fetch(FIX + '/reset');
  tw('dump-recording', '-i', ID, '--clear');
  tw('navigate', '-i', ID, '--url', PROXY + '/zp/');
  tw('fill-form', '-i', ID, '--selector', 'input', '--value', FIX + (c.path || '/nav/' + c.id));
  tw('click', '-i', ID, '--text', 'Open');
  await sleep(8000);

  const url = String(json(tw('get-url', '-i', ID)).url || '');
  const onProxy = url.startsWith(PROXY);

  // For frame cases, inspect child frame URLs because the top-level document URL does not change.
  let framesOutside = 0;
  if (c.axis === 'frame') {
    const total = Number(json(tw('get-frames', '-i', ID)).total_count || 0);
    for (let i = 0; i < total; i++) {
      const r = json(tw('exec-js', '-i', ID, '--frame', String(i), '--world', 'isolated',
        '--script', 'return String(location.href||"")'));
      const href = String(r.result || '');
      if (/127.0.0.1:1808[67]/.test(href)) framesOutside++;
    }
  }

  // Also check the network tape for direct document requests to the landing origin (18086/18087).
  tw('dump-recording', '-i', ID, '--filter', 'network', '--output', tapePath);
  let events = [];
  try { events = (JSON.parse(fs.readFileSync(tapePath, 'utf8')).network) || []; } catch {}
  const directDoc = events.filter(e =>
    e.kind === 'request' && /127\.0\.0\.1:1808[67]/.test(e.url || '') &&
    (e.resource_type === 'Document' || e.resource_type === 'Other')
  ).length;

  const hits = await get(FIX + '/hits');
  const landed = Object.values(hits).flat().some(u => u.includes('/landed/' + c.id));

  rows.push({
    id: c.id,
    axis: c.axis === 'frame' ? 'frame' : 'top',
    where: onProxy ? 'proxy' : 'outside',
    direct: directDoc,
    frames: framesOutside,
    control: controlLanded ? 'O' : '-',
    landed: landed ? 'O' : '-',
    verdict: !onProxy || directDoc > 0 || framesOutside > 0 ? 'escape' : 'ok',
  });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('case', 24), pad('axis', 7), pad('control', 7), pad('location', 8), pad('direct', 6), pad('outFrames', 9), pad('landed', 6), 'verdict');
for (const r of rows) console.log(pad(r.id, 24), pad(r.axis, 7), pad(r.control, 7), pad(r.where, 8), pad(r.direct, 6), pad(r.frames, 9), pad(r.landed, 6), r.verdict);

const escapes = rows.filter(r => r.verdict === 'escape');
const stuck = rows.filter(r => r.verdict === 'ok' && r.landed === '-' && r.control === 'O');
const blockedByBrowser = rows.filter(r => r.control === '-');
console.log('\n[containment] document escaped proxy origin:', escapes.length ? escapes.map(r => r.id).join(', ') : 'none');
console.log('[fidelity] works in control but fails via proxy:', stuck.length ? stuck.map(r => r.id).join(', ') : 'none');
if (blockedByBrowser.length) console.log('(blocked in control run as well by browser policy):', blockedByBrowser.map(r => r.id).join(', '));
