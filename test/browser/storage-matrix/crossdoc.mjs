// Verify cross-document BroadcastChannel and SharedWorker isolation between
// concurrent frames targeting the same origin (A) vs a different origin (B).
import { execFileSync } from 'node:child_process';

const ID = 'zp';
const PROXY = 'http://proxy.localhost:18080';
// Use `/hdrprobe` rather than `/page` because `/page` spawns 18 iframes of its own.
const A = 'http://localhost:18099/hdrprobe';
const B = 'http://127.0.0.1:18098/hdrprobe';
const tw = (...a) => {
  try { return execFileSync('taskweaver', a, { encoding: 'utf8', timeout: 120000 }); }
  catch (e) { return String((e.stdout || '') + (e.stderr || '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = s => { try { return JSON.parse(s); } catch { return {}; } };
const run = (script, ...extra) => json(tw('exec-js', '-i', ID, '--await', '--script', script, ...extra)).result;
const frameBase = (i) => {
  const r = run('return document.baseURI;', '--frame', String(i));
  return typeof r === 'string' ? r : '';
};

tw('navigate', '-i', ID, '--url', PROXY + '/zp/');
await sleep(1500);
tw('clear-site-data', '-i', ID, '--types', 'all');
tw('reload', '-i', ID, '--hard');
await sleep(2500);
tw('navigate', '-i', ID, '--url', PROXY + '/zp/');
tw('fill-form', '-i', ID, '--selector', 'input', '--value', A);
tw('click', '-i', ID, '--text', 'Open');
await sleep(9000);

run(`
  for (const [id, src] of [['zpSame', ${JSON.stringify(A)}], ['zpOther', ${JSON.stringify(B)}]]) {
    const f = document.createElement('iframe');
    f.id = id; f.width = 120; f.height = 60; f.src = src;
    document.body.appendChild(f);
  }
  return 'planted';
`);
await sleep(11000);

// Resolve child frame indices by `document.baseURI` rather than assuming fixed frame ordering.
const total = Number(json(tw('get-frames', '-i', ID)).total_count || 0);
let sameIdx = -1, otherIdx = -1;
for (let i = 0; i < total; i++) {
  const base = frameBase(i);
  if (base === A && sameIdx < 0) sameIdx = i;
  else if (base === B && otherIdx < 0) otherIdx = i;
}
console.log(`Frames (${total}): same-target(A)=${sameIdx} other-target(B)=${otherIdx}`);
if (sameIdx < 0 || otherIdx < 0) {
  console.log('[!] Target frames not found; run is inconclusive.');
  process.exit(0);
}

const ARM = `
  self.__zp_bc_got = [];
  try {
    const bc = new BroadcastChannel('zp_probe_chan');
    bc.onmessage = (e) => { self.__zp_bc_got.push(String(e.data)); };
    self.__zp_bc_ref = bc;
    return 'armed';
  } catch (e) { return 'arm-err:' + e.name; }
`;
console.log('Frame A receiver:', run(ARM, '--frame', String(sameIdx)));
console.log('Frame B receiver:', run(ARM, '--frame', String(otherIdx)));

const sent = run(`
  const tx = new BroadcastChannel('zp_probe_chan');
  tx.postMessage('FROM-A');
  await new Promise(r => setTimeout(r, 3000));
  return 'sent';
`);
const gotSame = json(run('return JSON.stringify(self.__zp_bc_got || null);', '--frame', String(sameIdx)) || 'null') || [];
const gotOther = json(run('return JSON.stringify(self.__zp_bc_got || null);', '--frame', String(otherIdx)) || 'null') || [];

console.log('\nVerdict:');
console.log('[fidelity] same-target frame received:', gotSame.length ? gotSame.join(',') : 'none');
console.log('[isolation] other-target frame received:', gotOther.length ? gotOther.join(',') : 'none');
if (!gotSame.length) {
  console.log('[!] Same-target delivery failed; BroadcastChannel is broken or instrumentation failed.');
  console.log('    Zero messages on other-target is not evidence of isolation in this run.');
} else if (gotOther.length) {
  console.log('[!!] Other-target received message: isolation leak.');
} else {
  console.log('[ok] Same-target received and other-target did not: verified isolation with positive control.');
}

// SharedWorker instance sharing: two connections from target A should receive
// sequential connection numbers (1, 2), whereas target B should receive 1 from a separate instance.
const SW_CONNECT = (origin) => `
  try {
    const w = new SharedWorker(${JSON.stringify('%ORIGIN%/sharedworker.js')}.replace('%ORIGIN%', ${JSON.stringify(origin)}), 'zp_probe_sw');
    const n = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout')), 6000);
      w.port.onmessage = (e) => { clearTimeout(t); res(e.data); };
      w.port.start();
      w.port.postMessage('n');
    });
    return String(n);
  } catch (e) { return 'err:' + (e && e.name ? e.name : String(e)); }
`;
const swSame1 = run(SW_CONNECT(new URL(A).origin), '--frame', String(sameIdx));
const swSame2 = run(SW_CONNECT(new URL(A).origin));
const swOther = run(SW_CONNECT(new URL(B).origin), '--frame', String(otherIdx));
console.log('\n[SharedWorker] same-target frame=' + swSame1 + ' / same-target top=' + swSame2 + ' / other-target=' + swOther);
if (String(swSame1).startsWith('err') || String(swSame2).startsWith('err')) {
  console.log('[!] SharedWorker connection failed on same-target; isolation verdict is inconclusive.');
} else if (String(swSame2) === String(swSame1)) {
  console.log('[!] Both same-target connections received the same sequence number; instance is not shared.');
} else if (!String(swOther).startsWith('err') && Number(swOther) > 1) {
  console.log('[!!] Other-target attached to the same SharedWorker instance: isolation leak.');
} else {
  console.log('[ok] Same-target shares instance and other-target is isolated: verified with positive control.');
}
