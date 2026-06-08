// E2 real-site regression harness — fresh Chromium profile per cycle so
// the SW-registration accumulation that wedged the taskweaver-based
// verification never happens. Spawns a single zeroproxy-server pointed
// at ./dist/web and walks puppeteer through each target in REAL_TARGETS,
// asserting the page renders (title non-empty + no fatal ZP error code
// in console) and snapshotting artifacts under
// `.ai/dogfood/e2-real-site/<YYYY-MM-DD>/<host>/`.
//
// Run: `node --test test/e2e/real-site-regression.test.js`
//   or `npm run dogfood:real-site` (added to package.json).
//
// Network gating: if the harness can't reach the open internet within
// 8 s of boot, every site test SKIPS rather than fails — the harness
// doubles as a CI-friendly regression that just-runs-when-it-can.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer');

const PROXY_PORT = process.env.ZP_PROXY_PORT || '18181';
const DIST_WEB = path.resolve('dist/web');
const SERVER_BIN = path.resolve(process.platform === 'win32' ? 'dist/zeroproxy-server.exe' : 'dist/zeroproxy-server');

// `titleMatches` MUST NOT match the launcher's "ZeroProxy" title (any
// fallback `|ZeroProxy` would pass before navigation completes). Each
// regex matches only the *target's* finalized page title.
//
// Default target list: Wikipedia (SPA-style mw.loader, no CF challenge,
// reliable on first cold visit). Cloudflare-protected sites like
// gosuda.org are opt-in via `ZP_TARGETS=cloudflare` because their CF
// challenge handling can exceed puppeteer's default 180 s
// protocolTimeout on first visit — they're closer to a manual
// dogfood check than an automated regression.
const ALL_TARGETS = {
  wikipedia: { host: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Main_Page', titleMatches: /Wikipedia, the free encyclopedia/i },
  cloudflare: { host: 'gosuda.org', url: 'https://gosuda.org', titleMatches: /gosuda/i },
};
const REAL_TARGETS = (process.env.ZP_TARGETS || 'wikipedia')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(k => {
    const t = ALL_TARGETS[k];
    if (!t) throw new Error(`unknown ZP_TARGETS entry: ${k}`);
    return t;
  });

const FATAL_ZP_ERRORS = [
  'SW_NOT_READY',
  'MALFORMED_HTML',
  'REALM_INJECTION_FAILURE',
  'REWRITE_FAILED',
  'Blocked by ZeroProxy rewrite policy',
];

function waitForHTTP(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      fetch(url).then(r => r.ok || r.status === 200 || r.status === 404 ? resolve() : retry())
        .catch(retry);
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) return reject(new Error('proxy boot timed out'));
      setTimeout(tick, 200);
    };
    tick();
  });
}

async function networkAvailable() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch('https://www.google.com/generate_204', { signal: ctl.signal, redirect: 'manual' });
    clearTimeout(t);
    return r.status === 204 || r.ok;
  } catch { return false; }
}

let serverProc = null;
let browser = null;
const outDir = path.resolve('.ai', 'dogfood', 'e2-real-site', new Date().toISOString().slice(0, 10));

test('E2 real-site regression — fresh profile, no stale SW', async (t) => {
  if (!fs.existsSync(SERVER_BIN) || !fs.existsSync(DIST_WEB)) {
    t.skip('dist/zeroproxy-server + dist/web missing — run `npm run build` first');
    return;
  }
  if (!await networkAvailable()) {
    t.skip('no outbound network — real-site harness only runs when egress is reachable');
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });

  serverProc = spawn(SERVER_BIN, ['-web', DIST_WEB, '-addr', '127.0.0.1:' + PROXY_PORT, '-socks', 'internal'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  serverProc.stdout.on('data', c => { serverLog += c; });
  serverProc.stderr.on('data', c => { serverLog += c; });
  t.after(() => {
    if (serverProc && !serverProc.killed) serverProc.kill('SIGKILL');
    if (serverLog) fs.writeFileSync(path.join(outDir, 'server.log'), serverLog);
  });

  await waitForHTTP(`http://127.0.0.1:${PROXY_PORT}/zp/`).catch(err => {
    throw new Error(`${err.message}\nserver log:\n${serverLog}`);
  });

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-e2-'));
  t.after(() => { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} });

  browser = await puppeteer.launch({
    headless: 'new',
    userDataDir,
    // Cloudflare-protected first-cold visits can exceed the default
    // 180 s CDP protocolTimeout — bump it generously so the actual
    // test-level timeouts (waitForFunction) own the deadline.
    protocolTimeout: 300000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--host-resolver-rules=MAP proxy.localhost 127.0.0.1',
    ],
  });
  t.after(() => browser && browser.close());

  for (const target of REAL_TARGETS) {
    await t.test(target.host, async (sub) => {
      const page = await browser.newPage();
      const consoleErrors = [];
      page.on('console', msg => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      page.on('pageerror', err => { consoleErrors.push(String(err && err.message || err)); });

      // 1. Open the proxy launcher and submit the target URL.
      await page.goto(`http://proxy.localhost:${PROXY_PORT}/zp/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => navigator.serviceWorker && navigator.serviceWorker.controller,
        { timeout: 30000 },
      );
      await page.evaluate((url) => {
        const input = document.querySelector('input');
        if (input) { input.value = url; input.dispatchEvent(new Event('input', { bubbles: true })); }
      }, target.url);
      const openBtn = await page.$('button');
      if (openBtn) await openBtn.click();

      // 2. Wait up to 45 s for the proxied target's real title to land.
      // The page realm's `location` is virtualized to return the
      // target URL, so we can't use it to detect "navigated off
      // launcher" — instead we rely on the strict per-target title
      // regex (configured above) which won't match the launcher's
      // "ZeroProxy" title.
      try {
        await page.waitForFunction(
          (re) => new RegExp(re, 'i').test(document.title || ''),
          { timeout: 45000 },
          target.titleMatches.source,
        );
      } catch (err) {
        const state = await page.evaluate(() => ({
          title: document.title,
          url: location.href,
          bodyLen: (document.body && document.body.innerText || '').length,
        }));
        await page.screenshot({ path: path.join(outDir, `${target.host}-FAIL.png`), fullPage: false });
        fs.writeFileSync(
          path.join(outDir, `${target.host}-errors.json`),
          JSON.stringify({ state, consoleErrors, serverLog: serverLog.slice(-4096) }, null, 2),
        );
        throw new Error(`${target.host}: ${err.message}; state=${JSON.stringify(state)}`);
      }

      // 3. Snapshot the result for visual verification.
      await page.screenshot({ path: path.join(outDir, `${target.host}.png`), fullPage: false });

      // 4. No fatal ZP error code in console.
      const fatal = consoleErrors.filter(line => FATAL_ZP_ERRORS.some(code => line.includes(code)));
      if (fatal.length > 0) {
        fs.writeFileSync(
          path.join(outDir, `${target.host}-fatal-errors.json`),
          JSON.stringify(fatal, null, 2),
        );
      }
      assert.equal(fatal.length, 0, `fatal ZP errors in ${target.host}: ${JSON.stringify(fatal)}`);
      await page.close();
    });
  }
});
