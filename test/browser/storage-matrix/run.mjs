// Verify storage and cookie partitioning across two distinct target origins (A and B)
// hosted under the same browser proxy origin:
//   (1) isolation: values written by A must not be readable by B,
//   (2) persistence: values written by A must persist when revisiting A,
//   (3) hygiene: internal proxy storage keys must not be visible to page scripts.
import { execFileSync } from 'node:child_process';

const ID = 'zp';
const PROXY = 'http://proxy.localhost:18080';
// Use distinct hostnames (`localhost` vs `127.0.0.1`) because RFC 6265 cookies are
// host-scoped rather than port-scoped.
const A = 'http://localhost:18099/page';
const B = 'http://127.0.0.1:18098/page';
const tw = (...a) => {
  try { return execFileSync('taskweaver', a, { encoding: 'utf8', timeout: 120000 }); }
  catch (e) { return String((e.stdout || '') + (e.stderr || '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = s => { try { return JSON.parse(s); } catch { return {}; } };
const evalJS = (script, world) => {
  const args = ['exec-js', '-i', ID, '--await', '--script', script];
  if (world) args.push('--world', world);
  const out = json(tw(...args));
  return out.result;
};

async function open(target) {
  tw('navigate', '-i', ID, '--url', PROXY + '/zp/');
  tw('fill-form', '-i', ID, '--selector', 'input', '--value', target);
  tw('click', '-i', ID, '--text', 'Open');
  await sleep(9000);
}

// Exercise both `setItem` and named property assignment (`localStorage.zp_probe_named = ...`).
const WRITE = `
  localStorage.setItem('zp_probe_local', 'A-local');
  localStorage.zp_probe_named = 'A-named';
  sessionStorage.setItem('zp_probe_session', 'A-session');
  document.cookie = 'zp_probe_cookie=A-cookie; path=/';
  const done = [];
  try {
    const c = await caches.open('zp_probe_cache');
    await c.put(new Request('/zp-probe'), new Response('A-cache'));
    done.push('cache');
  } catch (e) { done.push('cache-err:' + e.name); }
  try {
    await new Promise((res, rej) => {
      const rq = indexedDB.open('zp_probe_db', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('s');
      rq.onsuccess = () => {
        const tx = rq.result.transaction('s', 'readwrite');
        tx.objectStore('s').put('A-idb', 'k');
        tx.oncomplete = () => { rq.result.close(); res(); };
        tx.onerror = () => rej(tx.error);
      };
      rq.onerror = () => rej(rq.error);
    });
    done.push('idb');
  } catch (e) { done.push('idb-err:' + e.name); }
  return JSON.stringify(done);
`;

const READ = `
  const out = {};
  out.local = localStorage.getItem('zp_probe_local');
  out.named = localStorage.zp_probe_named === undefined ? null : localStorage.zp_probe_named;
  out.session = sessionStorage.getItem('zp_probe_session');
  out.cookie = /zp_probe_cookie=([^;]*)/.test(document.cookie) ? RegExp.$1 : null;
  try {
    const c = await caches.open('zp_probe_cache');
    const hit = await c.match(new Request('/zp-probe'));
    out.cache = hit ? await hit.text() : null;
  } catch (e) { out.cache = 'err:' + e.name; }
  try {
    out.idb = await new Promise((res) => {
      const rq = indexedDB.open('zp_probe_db', 1);
      rq.onupgradeneeded = () => { try { rq.result.createObjectStore('s'); } catch {} };
      rq.onsuccess = () => {
        let v = null;
        try {
          const g = rq.result.transaction('s', 'readonly').objectStore('s').get('k');
          g.onsuccess = () => { v = g.result === undefined ? null : g.result; rq.result.close(); res(v); };
          g.onerror = () => { rq.result.close(); res(null); };
        } catch (e) { rq.result.close(); res(null); }
      };
      rq.onerror = () => res(null);
    });
  } catch (e) { out.idb = 'err:' + e.name; }
  // Hygiene check: internal proxy keys must not appear in localStorage enumeration.
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  out.visibleKeys = keys;
  out.internalVisible = keys.filter(k => k && /^_*zp[:_]/i.test(k) && !k.startsWith('zp_probe'));
  return JSON.stringify(out);
`;

const FIELDS = ['local', 'named', 'session', 'cookie', 'cache', 'idb'];
const EXPECT_A = { local: 'A-local', named: 'A-named', session: 'A-session', cookie: 'A-cookie', cache: 'A-cache', idb: 'A-idb' };

// Clear site data before starting so residual storage from earlier runs does not skew results.
tw('navigate', '-i', ID, '--url', PROXY + '/zp/');
await sleep(1500);
tw('clear-site-data', '-i', ID, '--types', 'all');
tw('reload', '-i', ID, '--hard');
await sleep(2500);

await open(A);
const wrote = evalJS(WRITE);
console.log('A write:', wrote);
const readA1 = json(evalJS(READ));

await open(B);
const readB = json(evalJS(READ));

await open(A);
const readA2 = json(evalJS(READ));

const pad = (s, n) => String(s).padEnd(n);
console.log('\n' + pad('field', 10), pad('after A', 12), pad('on B', 12), pad('revisit A', 12), 'verdict');
const leaks = [], lost = [];
for (const f of FIELDS) {
  const a1 = readA1[f], b = readB[f], a2 = readA2[f];
  const leaked = b != null && String(b) === EXPECT_A[f];
  const persisted = a2 != null && String(a2) === EXPECT_A[f];
  // sessionStorage is tab-scoped, so values persist across same-tab navigations.
  let verdict = 'ok';
  if (leaked) { verdict = 'LEAK'; leaks.push(f); }
  else if (!persisted) { verdict = 'LOST'; lost.push(f); }
  console.log(pad(f, 10), pad(a1 === null ? '-' : a1, 12), pad(b === null ? '-' : b, 12), pad(a2 === null ? '-' : a2, 12), verdict);
}
console.log('\n[isolation] target A values read by target B:', leaks.length ? leaks.join(', ') : 'none');
console.log('[persistence] lost on returning to target A:', lost.length ? lost.join(', ') : 'none');
const internal = readA2.internalVisible || [];
console.log('[hygiene] internal proxy keys visible to page:', internal.length ? internal.join(', ') : 'none');
console.log('          (all visible keys:', (readA2.visibleKeys || []).join(', ') || 'none', ')');
// Flag fields that failed to write on target A so missing values on B are not misread as isolation.
const wroteNothing = FIELDS.filter(f => readA1[f] == null);
if (wroteNothing.length) {
  console.log(`\n[!] Failed to write on target A: ${wroteNothing.join(', ')}; absence on B is not evidence of isolation.`);
}
