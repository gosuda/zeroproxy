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

// Pick an ephemeral port per harness invocation by default — sharing a
// fixed `18181` across reruns meant a previous orphan process could
// silently own the port and answer requests, hiding fresh-spawn bind
// failures (Wikipedia "passes" through the orphan, later tests fail
// when the orphan finally stutters). Caller can pin via `ZP_PROXY_PORT`
// when manually correlating logs/screenshots.
const PROXY_PORT = process.env.ZP_PROXY_PORT
  || String(30000 + Math.floor(Math.random() * 20000));
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
  // Wikipedia — SPA-style mw.loader, no CF gate, stable cold visit.
  wikipedia: { host: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Main_Page', titleMatches: /Wikipedia, the free encyclopedia/i },
  // example.com — IANA reserved-for-documentation domain. Tiny static
  // page, no JS frameworks, ZERO third-party fetches: the canonical
  // "does the SW + rewriter + transport path produce a renderable
  // document at all" smoke target.
  example: { host: 'example.com', url: 'https://example.com/', titleMatches: /Example Domain/i },
  // MDN docs landing page. Heavier JS surface (Yari React app), useful
  // signal for "real developer site" smoke under the page bundle.
  mdn: { host: 'developer.mozilla.org', url: 'https://developer.mozilla.org/en-US/docs/Web', titleMatches: /MDN|Mozilla/i },
  // Hacker News — server-rendered, minimal JS, lightweight. Exercises
  // the document path with no SPA bundle to confound title timing.
  hackernews: { host: 'news.ycombinator.com', url: 'https://news.ycombinator.com/', titleMatches: /Hacker News/i },
  // Cloudflare-protected sites are opt-in via `ZP_TARGETS=cloudflare`
  // because CF challenge handling can exceed puppeteer's default 180 s
  // protocolTimeout — they're closer to a manual dogfood check than
  // an automated regression.
  cloudflare: { host: 'gosuda.org', url: 'https://gosuda.org', titleMatches: /gosuda/i },
};
// `ZP_TARGETS=matrix` expands to the auto-evidence matrix. Both
// `wikipedia` and `example` (the latter after the rustls fork patch
// landed 2026-06-08 to tolerate SCT in TLS 1.3 CertificateEntry
// extensions, see `.ai/trap-notebook/INDEX.md`) qualify as
// known-good across the SW + transport + rewriter pipeline.
// `mdn` / `hackernews` remain in `ALL_TARGETS` for opt-in evidence
// runs and Phase 3 investigation:
//   - `mdn` — initial transport stalls on first cold visit (not a
//     harness flake — the retry-on-context-destroyed loop landed
//     2026-06-08, MDN's failure now manifests as transport hang
//     rather than execution-context destruction). Likely a
//     fingerprint or upstream-timing interaction; Phase 3.
//   - `hackernews` — sequential cookie probes noisy under headless
//     puppeteer without further harness work.
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
  // Fail-fast: if the spawned server exited before waitForHTTP returned
  // (typically `bind: address already in use` from a prior orphan), the
  // waitForHTTP poll may have succeeded against the *orphan* instead.
  // Refuse to proceed — a real evidence run must own its own port.
  if (serverDied || /bind:.*permitted|address already in use/i.test(serverLog)) {
    throw new Error(`server died during boot (likely port conflict on ${PROXY_PORT}):\n${serverLog}`);
  }

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
      // Fresh incognito BrowserContext per subtest so SW
      // registrations / cookies / storage do NOT cross-contaminate.
      // The matrix-run-4 (2026-06-08) regression showed Wikipedia's
      // SW state aliased to the next subtest's proxy.localhost
      // origin and broke example.com's launcher submission.
      const ctx = await browser.createBrowserContext();
      sub.after(() => ctx.close().catch(() => {}));
      const page = await ctx.newPage();
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
      //
      // Sites that do `location.replace` (e.g. MDN's locale resolver)
      // destroy the page's execution context mid-poll, which makes
      // `page.title()` block until the protocol timeout. We avoid
      // that by binding a `page.on('domcontentloaded', …)` listener
      // that fires every time the renderer commits a new doc —
      // recording the most-recent `document.title` snapshot from
      // within each fresh context. The harness then races a deadline
      // against "any committed doc whose title matches the regex."
      //
      // Belt-and-suspenders: also poll every 250 ms inside try/catch,
      // tolerating context-destroyed faults so stable docs that
      // never re-commit (the common case — Wikipedia, example.com)
      // still resolve quickly.
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
        } catch { /* context destroyed — fall back to listener-captured title */ }
        try { await page.screenshot({ path: path.join(outDir, `${target.host}-FAIL.png`), fullPage: false }); } catch {}
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
