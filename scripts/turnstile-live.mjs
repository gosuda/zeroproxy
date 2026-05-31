// HUMAN-RUN live Cloudflare Turnstile compatibility harness. This is NOT a CI test,
// NOT a solver, NOT a bypass. It boots the real proxy stack, opens an instrumented
// browser at the proxy UI, and lets a real human solve a real challenge through the
// proxy while it records ONLY redacted observations: path-classes, resource types,
// through-proxy booleans, response status, and the projected CSP policy string. It
// never records tokens, cookie values, request bodies, challenge script source, or
// raw URLs. It CANNOT assert clearance (server-authoritative); it surfaces whether the
// membrane BREAKS the legitimate challenge (egress escape, missing CSP projection) so a
// human can judge a real pass. See docs/cloudflare-turnstile/README.md.
//
// Usage:
//   npm run turnstile:live                      # interactive: you drive a headful browser
//   ZP_TURNSTILE_LIVE_URL=https://zone npm run turnstile:live   # autodrive a single URL
// Env: ZP_TURNSTILE_LIVE_HEADLESS=1 (headless; cannot solve interactive challenges),
//      ZP_TURNSTILE_LIVE_SOCKS=internal|<host:port> (egress; default internal/direct),
//      ZP_TURNSTILE_LIVE_TIMEOUT_MS=<ms> (solve window; default 300000).

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADLESS = process.env.ZP_TURNSTILE_LIVE_HEADLESS === '1';
const SOCKS = process.env.ZP_TURNSTILE_LIVE_SOCKS || 'internal';
const AUTODRIVE_URL = process.env.ZP_TURNSTILE_LIVE_URL || '';
const SOLVE_TIMEOUT_MS = Number(process.env.ZP_TURNSTILE_LIVE_TIMEOUT_MS || 300000);

// Cleanup is module-scoped so the early SIGINT handler can tear the stack down even if
// Ctrl-C arrives during build/launch, before the solve window opens. splice() makes it
// run-once (the finally block and the signal handler share it harmlessly).
const cleanups = [];
let solveResolve = null;
let solveTimer = null;
let shuttingDown = false;

// runCleanups tears the stack down once, awaiting async teardown (browser.close) so a
// SIGINT path does not exit mid-close. splice() makes it idempotent across the finally
// block and the signal handler; shuttingDown lets the handler ignore repeat Ctrl-C
// until this settles.
async function runCleanups() {
  shuttingDown = true;
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      await fn();
    } catch {
      // best-effort teardown
    }
  }
}

// endSolve ends the solve window exactly once, clearing the pending timeout so a Ctrl-C
// resolve does not leave the timer holding the event loop open until it fires.
function endSolve() {
  if (!solveResolve) return;
  const resolve = solveResolve;
  solveResolve = null;
  if (solveTimer) {
    clearTimeout(solveTimer);
    solveTimer = null;
  }
  resolve();
}

// shutdownAndExit runs the full teardown (browser + proxy + tmpdir) once, then exits.
// We disabled puppeteer's own SIGINT/SIGTERM/SIGHUP handlers (they exit before our
// verdict prints AND only close the browser, leaking the proxy + tmpdir), so EVERY
// termination signal must route here or those resources orphan.
function shutdownAndExit(code) {
  if (shuttingDown) return;
  runCleanups().finally(() => process.exit(code));
}

process.on('SIGINT', () => {
  if (shuttingDown) return; // teardown already in progress: ignore repeat Ctrl-C
  if (solveResolve) {
    // Ctrl-C during the solve window: end it so the verdict prints, then main's
    // finally tears down and the post-settle exit fires.
    endSolve();
    return;
  }
  shutdownAndExit(130); // setup-phase Ctrl-C: nothing to report yet, just tear down.
});
// SIGTERM (kill) / SIGHUP (terminal closed) are not "show me the verdict" signals --
// tear the stack down and exit so nothing orphans. 128 + signal number, by convention.
process.on('SIGTERM', () => shutdownAndExit(143));
process.on('SIGHUP', () => shutdownAndExit(129));

function log(msg) {
  process.stdout.write(`[turnstile-live] ${msg}\n`);
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// urlPathClass/throughZeroproxy mirror the value-free vocabulary in
// test/e2e/turnstile-compat.test.js so URLs enter the trace ONLY as classes -- never
// query strings, share keys, runtime tokens, or opaque challenge params.
function urlPathClass(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return 'invalid';
  }
  if (u.hostname === 'challenges.cloudflare.com') return 'challenge:cf-direct';
  const p = u.pathname;
  if (p.startsWith('/zp/p/')) return 'proxy:document';
  if (p.startsWith('/zp/api/')) return 'proxy:api';
  if (p.startsWith('/zp/assets/')) return 'proxy:asset';
  if (p.startsWith('/zp/')) return 'proxy:control';
  if (p === '/' && u.hostname === 'proxy.localhost') return 'proxy:home';
  if (p.startsWith('/cdn-cgi/challenge-platform/')) return 'challenge:subresource';
  return 'other';
}

function throughZeroproxy(rawUrl) {
  try {
    return new URL(rawUrl).hostname === 'proxy.localhost';
  } catch {
    return false;
  }
}

// hostOnly keeps the autodrive target value-free in logs (host, never path/query).
function hostOnly(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return '(invalid url)';
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function buildStack(outDir) {
  const r = spawnSync('node', ['scripts/build.mjs', '--out', outDir], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error(`build.mjs exited ${r.status}`);
}

function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(true);
    });
    req.setTimeout(1000, () => req.destroy());
    req.once('error', () => resolve(false));
  });
}

async function waitForHTTP(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe(url)) return;
    if (Date.now() > deadline) throw new Error(`proxy did not answer at ${url}`);
    await delay(200);
  }
}

// makeRecorder accumulates ONLY redacted observations. The captured CSP is a security
// POLICY string (origins + the fixed 'nonce-zp' literal, never a secret) kept so a
// human can see whether the challenge host was projected.
function makeRecorder() {
  const escapes = [];
  let doc = null;
  return {
    onRequest(req) {
      if (throughZeroproxy(req.url())) return;
      escapes.push({ pathClass: urlPathClass(req.url()), resourceType: req.resourceType() });
    },
    onResponse(resp) {
      const req = resp.request();
      if (req.resourceType() !== 'document' || !resp.fromServiceWorker()) return;
      if (urlPathClass(resp.url()) !== 'proxy:document') return;
      const csp = resp.headers()['content-security-policy'] || '';
      doc = {
        status: resp.status(),
        cspProjectsChallengeHost: csp.includes('challenges.cloudflare.com'),
        csp,
        markerPresent: Object.hasOwn(resp.headers(), 'x-zp-challenge-compat'),
      };
    },
    verdict() {
      return { escapes, doc };
    },
  };
}

function launchBrowser() {
  return puppeteer.launch({
    headless: HEADLESS,
    // Puppeteer's default signal handlers call process.exit(130) on SIGINT, which
    // pre-empts our own SIGINT path (endSolve -> printVerdict -> redacted teardown)
    // and kills the process before the verdict prints. Own the signals ourselves.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--host-resolver-rules=MAP proxy.localhost 127.0.0.1',
      '--disable-background-networking',
      '--no-default-browser-check',
      '--disable-component-update',
      '--disable-sync',
    ],
  });
}

// observe attaches the recorder to a target's page (the top page and any later
// popup/new-tab target). OOPIF subframes return no page() and are not captured here --
// see the scope caveat printed with the verdict.
function observe(rec, page) {
  page.on('request', rec.onRequest);
  page.on('response', rec.onResponse);
}

async function openUI(page, proxyPort) {
  await page.goto(`http://proxy.localhost:${proxyPort}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      navigator.serviceWorker?.controller &&
      document.querySelector('#status')?.textContent === 'Ready.',
    { timeout: 30000 },
  );
}

async function autodrive(page, targetUrl) {
  await page.click('#challenge-compat');
  await page.type('#url', targetUrl);
  await page.click('button');
}

function printInstructions(proxyPort) {
  log('interactive mode -- in the browser window that just opened:');
  log('  1. tick "Challenge compatibility mode"');
  log('  2. enter the real Cloudflare-protected URL and click Open');
  log('  3. solve the challenge as a human');
  log(`  (UI is http://proxy.localhost:${proxyPort}/ ; resolved to the local proxy)`);
  log(`press Ctrl-C when done (auto-ends in ${Math.round(SOLVE_TIMEOUT_MS / 1000)}s)`);
}

function waitForSolveOrSignal() {
  return new Promise((resolve) => {
    solveResolve = resolve;
    setTimeout(() => {
      if (!solveResolve) return;
      solveResolve = null;
      resolve();
    }, SOLVE_TIMEOUT_MS);
  });
}

function printVerdict(v) {
  log('=== VERDICT (redacted; clearance is NOT asserted) ===');
  log(`proxy document captured: ${v.doc ? 'yes' : 'no'}`);
  if (v.doc) {
    log(
      `  status=${v.doc.status} cspProjectsChallengeHost=${v.doc.cspProjectsChallengeHost} internalMarkerStripped=${!v.doc.markerPresent}`,
    );
    log(`  CSP: ${v.doc.csp || '(none)'}`);
  }
  log(`browser requests NOT through proxy: ${v.escapes.length}`);
  for (const e of v.escapes) log(`  - ${e.pathClass} (${e.resourceType})`);
  const pageEscapes = v.escapes.filter(
    (e) => e.pathClass === 'challenge:cf-direct' || e.resourceType !== 'other',
  );
  if (pageEscapes.length) {
    log(
      `!! ${pageEscapes.length} page-level escape(s): the membrane failed to contain a real resource. A clean pass requires ZERO challenge:cf-direct escapes.`,
    );
  } else if (v.escapes.length) {
    log(
      `${v.escapes.length} non-proxy request(s) observed, none page-level typed -- review the list above`,
    );
  } else {
    log('no egress escape detected in observed scope (membrane contained all observed traffic)');
  }
  log('SCOPE: this observes top-level + popup page requests only. Cross-origin challenge');
  log('iframes (OOPIF) and service-worker-internal traffic are NOT fully captured here --');
  log("cross-check the browser's own devtools Network tab for the authoritative view.");
}

async function main() {
  try {
    const outDir = mkdtempSync(path.join(tmpdir(), 'zeroproxy-live-'));
    cleanups.push(() => rmSync(outDir, { recursive: true, force: true }));
    log('building stack...');
    buildStack(outDir);
    const exe = process.platform === 'win32' ? 'zeroproxy-server.exe' : 'zeroproxy-server';
    const proxyPort = await freePort();
    log(
      `starting proxy on 127.0.0.1:${proxyPort} (-socks ${SOCKS === 'internal' ? 'internal' : 'external'})`,
    );
    const proxy = spawn(
      path.join(outDir, exe),
      // biome-ignore format: keep the server flag list readable as pairs
      ['-addr', `127.0.0.1:${proxyPort}`, '-web', path.join(outDir, 'web'), '-kernel', path.join(outDir, 'kernel.wasm'), '-socks', SOCKS],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    cleanups.push(() => proxy.kill('SIGTERM'));
    // The real server log is OUTSIDE the harness redaction contract; capture it to a
    // buffer and surface it ONLY if startup fails -- never stream it to stdout.
    let proxyLog = '';
    const capture = (chunk) => {
      proxyLog += chunk;
    };
    proxy.stdout.on('data', capture);
    proxy.stderr.on('data', capture);
    await waitForHTTP(`http://127.0.0.1:${proxyPort}/`).catch((err) => {
      throw new Error(`${err.message}\n--- proxy startup output ---\n${proxyLog}`);
    });

    const browser = await launchBrowser();
    cleanups.push(async () => {
      // Bound teardown: a wedged browser.close() must not hang the human's terminal.
      // SIGKILL the chromium process ONLY if the graceful close did not win the race.
      const closed = browser.close().then(
        () => true,
        () => false,
      );
      const graceful = await Promise.race([closed, delay(3000).then(() => false)]);
      if (!graceful) browser.process()?.kill('SIGKILL');
    });
    const rec = makeRecorder();
    browser.on('targetcreated', async (target) => {
      const p = await target.page().catch(() => null);
      if (p) observe(rec, p);
    });
    const page = await browser.newPage();
    observe(rec, page);

    await openUI(page, proxyPort);
    if (AUTODRIVE_URL) {
      log(`autodrive: arming compat + opening host ${hostOnly(AUTODRIVE_URL)}`);
      await autodrive(page, AUTODRIVE_URL);
    } else {
      printInstructions(proxyPort);
    }
    await waitForSolveOrSignal();
    printVerdict(rec.verdict());
  } finally {
    await runCleanups();
  }
}

main()
  .catch((err) => {
    log(`FAILED: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // Spawned children (proxy, chromium) keep the event loop alive past teardown, so a
    // natural exit hangs (empirically ~30s+). Force a prompt exit AFTER awaited teardown
    // -- every harness line is written before teardown, so the verdict is not truncated.
    process.exit(process.exitCode ?? 0);
  });
