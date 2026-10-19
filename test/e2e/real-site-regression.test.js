// E2 real-site regression harness. Spawns zeroproxy-server against ./dist/web
// and visits each target in REAL_TARGETS with a fresh Chromium profile,
// verifying non-empty target title and zero fatal ZP console errors.
//
// Run: `node --test test/e2e/real-site-regression.test.js` or `npm run dogfood:real-site`.
// Skips when outbound internet is unreachable within 8 s of boot.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer');

// Pick an ephemeral port by default so an orphan server from a prior run cannot
// silently answer requests on a fixed port; set ZP_PROXY_PORT to pin manually.
const PROXY_PORT = process.env.ZP_PROXY_PORT
  || String(30000 + Math.floor(Math.random() * 20000));
const DIST_WEB = path.resolve('dist/web');
const SERVER_BIN = path.resolve(process.platform === 'win32' ? 'dist/zeroproxy-server.exe' : 'dist/zeroproxy-server');

// `titleMatches` must match only the target's finalized page title, never the launcher's "ZeroProxy" title.
const ALL_TARGETS = {
  wikipedia: { host: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Main_Page', titleMatches: /Wikipedia, the free encyclopedia/i },
  example: { host: 'example.com', url: 'https://example.com/', titleMatches: /Example Domain/i },
  mdn: { host: 'developer.mozilla.org', url: 'https://developer.mozilla.org/en-US/docs/Web', titleMatches: /MDN|Mozilla/i },
  hackernews: { host: 'news.ycombinator.com', url: 'https://news.ycombinator.com/', titleMatches: /Hacker News/i },
  cloudflare: { host: 'gosuda.org', url: 'https://gosuda.org', titleMatches: /gosuda/i },
  cnn: { host: 'edition.cnn.com', url: 'https://edition.cnn.com/', titleMatches: /CNN/i },
  // `challengeCompat: true` enables the launcher's #challenge-compat checkbox.
  turnstile: { host: 'turnstile.zeroclover.io', url: 'https://turnstile.zeroclover.io/', titleMatches: /turnstile|cloudflare|demo/i, challengeCompat: true },
};
// `ZP_TARGETS=matrix` expands to the default automated regression targets.
const MATRIX_KEYS = ['wikipedia', 'example'];
const rawTargets = process.env.ZP_TARGETS || 'wikipedia';
const REAL_TARGETS = (rawTargets === 'matrix' ? MATRIX_KEYS.join(',') : rawTargets)
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
  let serverDied = false;
  serverProc.stdout.on('data', c => { serverLog += c; });
  serverProc.stderr.on('data', c => { serverLog += c; });
  serverProc.on('exit', code => { serverDied = code !== null; });
  t.after(() => {
    if (serverProc && !serverProc.killed) serverProc.kill('SIGKILL');
    if (serverLog) fs.writeFileSync(path.join(outDir, 'server.log'), serverLog);
  });

  await waitForHTTP(`http://127.0.0.1:${PROXY_PORT}/zp/`).catch(err => {
    throw new Error(`${err.message}\nserver log:\n${serverLog}`);
  });
  // Fail fast if the spawned server exited during boot (such as on a port conflict)
  // while waitForHTTP succeeded against an older process.
  if (serverDied || /bind:.*permitted|address already in use/i.test(serverLog)) {
    throw new Error(`server died during boot (likely port conflict on ${PROXY_PORT}):\n${serverLog}`);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-e2-'));
  t.after(() => { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} });

  browser = await puppeteer.launch({
    headless: 'new',
    userDataDir,
    // Cloudflare-protected cold visits can exceed the default 180 s CDP protocolTimeout;
    // raise it so test-level waitForFunction timeouts govern the deadline.
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
      // Use a fresh BrowserContext per subtest so SW registrations, cookies, and storage do not leak across targets.
      const ctx = await browser.createBrowserContext();
      sub.after(() => ctx.close().catch(() => {}));
      const page = await ctx.newPage();
      const consoleErrors = [];
      page.on('console', msg => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      page.on('pageerror', err => { consoleErrors.push(String(err && err.message || err)); });

      await page.goto(`http://proxy.localhost:${PROXY_PORT}/zp/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => navigator.serviceWorker && navigator.serviceWorker.controller,
        { timeout: 30000 },
      );
      await page.evaluate((url, arm) => {
        const input = document.querySelector('input#url');
        if (input) { input.value = url; input.dispatchEvent(new Event('input', { bubbles: true })); }
        if (arm) {
          const cc = document.getElementById('challenge-compat');
          if (cc && !cc.checked) { cc.checked = true; cc.dispatchEvent(new Event('change', { bubbles: true })); }
        }
      }, target.url, !!target.challengeCompat);
      const openBtn = await page.$('button');
      if (openBtn) await openBtn.click();

      // Wait up to 45 s for the proxied target's title. Because `location` is virtualized,
      // detect navigation completion via the target-specific title regex.
      // Listen to `domcontentloaded` and `load` alongside polling so redirects that destroy
      // the execution context mid-poll do not block `page.title()` until protocolTimeout.
      let titleSeen = '';
      const titleListener = async () => {
        try { titleSeen = (await page.title()) || titleSeen; } catch {}
      };
      page.on('domcontentloaded', titleListener);
      page.on('load', titleListener);
      const titleDeadline = Date.now() + 45000;
      let lastTitleErr = null;
      let titleMatched = false;
      while (Date.now() < titleDeadline) {
        if (target.titleMatches.test(titleSeen)) { titleMatched = true; break; }
        try {
          const t = await page.title();
          if (t) titleSeen = t;
          if (target.titleMatches.test(titleSeen)) { titleMatched = true; break; }
        } catch (e) {
          const msg = String(e && e.message || e);
          if (!/Execution context was destroyed|Target closed|Most likely the page has been closed|frame got detached/i.test(msg)) {
            lastTitleErr = e;
            break;
          }
        }
        await new Promise(r => setTimeout(r, 250));
      }
      page.off('domcontentloaded', titleListener);
      page.off('load', titleListener);
      try {
        if (!titleMatched) {
          throw lastTitleErr || new Error(`title did not match ${target.titleMatches} within 45 s (last seen: ${JSON.stringify(titleSeen)})`);
        }
      } catch (err) {
        let state = { title: titleSeen, url: '(unknown)', bodyLen: 0 };
        try {
          state = await page.evaluate(() => ({
            title: document.title,
            url: location.href,
            bodyLen: (document.body && document.body.innerText || '').length,
          }));
        } catch { /* context destroyed; fall back to listener-captured title */ }
        try { await page.screenshot({ path: path.join(outDir, `${target.host}-FAIL.png`), fullPage: false }); } catch {}
        fs.writeFileSync(
          path.join(outDir, `${target.host}-errors.json`),
          JSON.stringify({ state, consoleErrors, serverLog: serverLog.slice(-4096) }, null, 2),
        );
        throw new Error(`${target.host}: ${err.message}; state=${JSON.stringify(state)}`);
      }

      await page.screenshot({ path: path.join(outDir, `${target.host}.png`), fullPage: false });

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
