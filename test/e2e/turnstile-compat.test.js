// Armed-path e2e trace harness for the Turnstile challenge-compatibility mode
// (Task B6). This validates the COMPATIBILITY MECHANISM end-to-end in a real
// browser against a LOCAL fixture that mimics a Cloudflare challenge -- it does
// NOT contact real Cloudflare and is NOT a solver/forgery/bypass. Real challenge
// clearance is a separate human-run live smoke test.
//
// The fixture document is served with `Cf-Mitigated: challenge` (header-based
// classification) and embeds a same-fixture script under
// `/cdn-cgi/challenge-platform/` (path-based classification) so the harness
// exercises BOTH relaxation points: the document-CSP projection (sw.js addCSP)
// and the script-CSP projection + no-store skip (sw.js rewriteScriptResponse,
// kernel challengeSubresourceSkip).
//
// REDACTION CONTRACT: the recorded trace and every failure diagnostic carry only
// url-path-class, names-only cookies, status, and a through_zeroproxy bool. Token
// values, cookie values, and arm-header values are NEVER recorded or logged.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const TARGET_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

const {
  run,
  ignoreBenignSocketErrors,
  listen,
  closeServer,
  waitForHTTP,
  waitForPage,
} = require('./helpers');

// urlPathClass projects any URL onto a small, value-free vocabulary so the trace
// can describe routing without ever recording opaque tokens (share route keys,
// runtime tokens, query strings). This is the ONLY way URLs enter the record.
function urlPathClass(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return 'invalid';
  }
  const p = u.pathname;
  if (p.startsWith('/zp/p/')) return 'proxy:document';
  if (p === '/zp/api/script') return 'proxy:api-script';
  if (p.startsWith('/zp/api/')) return 'proxy:api';
  if (p.startsWith('/zp/assets/')) return 'proxy:asset';
  if (p === '/zp/kernel.wasm') return 'proxy:kernel';
  if (p.startsWith('/zp/')) return 'proxy:control';
  if (p === '/' && u.hostname === 'proxy.localhost') return 'proxy:home';
  if (p.startsWith('/cdn-cgi/challenge-platform/')) return 'challenge:subresource';
  if (p === '/challenge') return 'challenge:document';
  if (p === '/plain') return 'plain:document';
  return 'other';
}

// throughZeroproxy is the load-bearing egress check: a browser-issued request is
// "through proxy" iff it targets the proxy origin. Any challenge resource that is
// NOT through-proxy would be a direct-egress escape and a hard fail.
function throughZeroproxy(rawUrl) {
  try {
    return new URL(rawUrl).hostname === 'proxy.localhost';
  } catch {
    return false;
  }
}

// cookieNames extracts ONLY cookie names from a Cookie header, never values.
function cookieNames(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map((part) => part.split('=')[0].trim())
    .filter(Boolean);
}

// recordRequest builds the redacted browser-request trace row. No token/cookie
// values, no query strings, no arm-header values ever enter this object.
function recordRequest(req) {
  return {
    pathClass: urlPathClass(req.url()),
    resourceType: req.resourceType(),
    throughZeroproxy: throughZeroproxy(req.url()),
  };
}

// The challenge fixture target. It mimics Cloudflare WITHOUT being Cloudflare:
// - GET /challenge -> challenge DOCUMENT (Cf-Mitigated: challenge header) that
//   embeds a same-fixture challenge subresource at a /cdn-cgi/challenge-platform/
//   path (relative URL -> resolves to the proxy origin -> naturally through-proxy).
// - GET /cdn-cgi/challenge-platform/orchestrate.js -> the challenge SUBRESOURCE.
// - GET /plain -> a vanilla, non-challenge document (the OFF/baseline reference).
// It sends NO Content-Security-Policy header, so the kernel's eval grant
// (targetDynamicCompileAllowed) is the SAME default-allow for every fixture; this
// holds allowDynamicCompile constant so the byte-identical OFF==baseline check
// isolates the challenge projection as the only variable.
function createChallengeTarget(seen) {
  const server = http.createServer((req, res) => {
    ignoreBenignSocketErrors(req);
    ignoreBenignSocketErrors(res);
    const url = new URL(req.url, 'http://challenge-fixture.local');
    seen.push({
      pathClass: urlPathClass(`http://challenge-fixture.local${req.url}`),
      method: req.method,
      userAgent: req.headers['user-agent'] || '',
      cookieNames: cookieNames(req.headers.cookie),
    });
    if (url.pathname === '/challenge') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cf-Mitigated': 'challenge',
      });
      res.end(`<!doctype html><html><head><title>Turnstile Compat Fixture</title></head><body>
        <main id="challenge-root"><h1>CHALLENGE</h1></main>
        <script>window.__challengeDocHref = location.href;</script>
        <script id="challenge-orchestrate" src="/cdn-cgi/challenge-platform/orchestrate.js"></script>
      </body></html>`);
      return;
    }
    if (url.pathname === '/cdn-cgi/challenge-platform/orchestrate.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        // Mimic Cloudflare's cacheable subresource semantics; the armed path's
        // challengeSubresourceSkip preserves these instead of forcing no-store.
        'Cache-Control': 'public, max-age=300',
      });
      res.end(`window.__challengeSubLoaded = true; window.__challengeSubHref = location.href;`);
      return;
    }
    if (url.pathname === '/plain') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Plain Fixture</title></head><body>
        <main id="plain-root"><h1>PLAIN</h1></main>
        <script>window.__plainDocHref = location.href;</script>
      </body></html>`);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  return server;
}

// openTarget drives the REAL B5 opt-in UI in a fresh browser context (clean SW /
// cookie isolation; the arm is birth-only so each run mints its own kernel tab).
// It returns ONLY redacted observations.
async function openTarget(browser, proxyPort, targetUrl, { arm, waitTitle }) {
  const context = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await context.newPage();
  await page.goto(`http://proxy.localhost:${proxyPort}/`, { waitUntil: 'domcontentloaded' });
  await waitForPage(
    page,
    () =>
      navigator.serviceWorker &&
      navigator.serviceWorker.controller &&
      document.querySelector('#status')?.textContent === 'Ready.',
  );

  // Capture the SW-synthesized challenge-document navigation response. Chrome
  // surfaces SW-provided headers on the navigation with fromServiceWorker:true.
  // The listener MUST be attached BEFORE the click because the armed navigation
  // is a client-side location.assign, not a page.goto we can await.
  let documentResponse = null;
  const requestTrace = [];
  page.on('request', (req) => {
    requestTrace.push(recordRequest(req));
  });
  page.on('response', (resp) => {
    const req = resp.request();
    if (
      req.resourceType() === 'document' &&
      resp.fromServiceWorker() &&
      urlPathClass(resp.url()) === 'proxy:document'
    ) {
      documentResponse = {
        status: resp.status(),
        csp: resp.headers()['content-security-policy'] || '',
        // The internal marker MUST be stripped before the page; record only its
        // presence (a name), never any value.
        markerPresent: Object.prototype.hasOwnProperty.call(
          resp.headers(),
          'x-zp-challenge-compat',
        ),
      };
    }
  });

  if (arm) await page.click('#challenge-compat');
  await page.type('#url', targetUrl);
  await page.click('button');
  await waitForPage(page, (title) => document.title === title, [waitTitle]);
  // Let challenge subresources settle (the through-proxy script fetch).
  await waitForPage(
    page,
    () => window.__challengeSubLoaded === true || document.title === 'Plain Fixture',
  ).catch(() => {});

  const pageState = await page.evaluate(() => ({
    title: document.title,
    challengeSubLoaded: window.__challengeSubLoaded === true,
  }));

  await context.close();
  return { documentResponse, requestTrace, pageState };
}

test('armed challenge-compat path projects CSP, strips marker, routes subresources through proxy; OFF byte-identical', {
  timeout: 120000,
}, async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroproxy-turnstile-'));
  const buildOut = path.join(temp, 'dist');
  run('node', ['scripts/build.mjs', '--out', buildOut]);
  const kernelPath = path.join(buildOut, 'kernel.wasm');
  const serverPath = path.join(
    buildOut,
    process.platform === 'win32' ? 'zeroproxy-server.exe' : 'zeroproxy-server',
  );
  const webPath = path.join(buildOut, 'web');

  const seen = [];
  const target = createChallengeTarget(seen);
  const targetPort = await listen(target);
  t.after(() => closeServer(target));
  const targetHost = 'localhost';

  const proxyPort = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.once('error', reject);
  });
  const proxy = childProcess.spawn(
    serverPath,
    [
      '-addr',
      `127.0.0.1:${proxyPort}`,
      '-web',
      webPath,
      '-kernel',
      kernelPath,
      '-socks',
      'internal',
    ],
    { cwd: path.resolve(__dirname, '../..'), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => proxy.kill('SIGTERM'));
  let proxyLog = '';
  proxy.stdout.on('data', (chunk) => {
    proxyLog += chunk;
  });
  proxy.stderr.on('data', (chunk) => {
    proxyLog += chunk;
  });
  await waitForHTTP(`http://127.0.0.1:${proxyPort}/`).catch((err) => {
    throw new Error(`${err.message}\nproxy output:\n${proxyLog}`);
  });

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--host-resolver-rules=MAP proxy.localhost 127.0.0.1',
    ],
  });
  t.after(() => browser.close());

  const challengeUrl = `http://${targetHost}:${targetPort}/challenge`;
  const plainUrl = `http://${targetHost}:${targetPort}/plain`;

  const armed = await openTarget(browser, proxyPort, challengeUrl, {
    arm: true,
    waitTitle: 'Turnstile Compat Fixture',
  });
  const off = await openTarget(browser, proxyPort, challengeUrl, {
    arm: false,
    waitTitle: 'Turnstile Compat Fixture',
  });
  const baseline = await openTarget(browser, proxyPort, plainUrl, {
    arm: false,
    waitTitle: 'Plain Fixture',
  });

  // Redacted diagnostic surface: NO token/cookie/arm values, only path-classes,
  // status, names-only cookies, and the through-proxy bool.
  const diag = JSON.stringify(
    {
      armed: {
        status: armed.documentResponse && armed.documentResponse.status,
        markerPresent: armed.documentResponse && armed.documentResponse.markerPresent,
        requestTrace: armed.requestTrace,
        pageState: armed.pageState,
      },
      off: {
        status: off.documentResponse && off.documentResponse.status,
        requestTrace: off.requestTrace,
      },
      baseline: { status: baseline.documentResponse && baseline.documentResponse.status },
      targetSeen: seen.map((s) => ({
        pathClass: s.pathClass,
        method: s.method,
        cookieNames: s.cookieNames,
      })),
    },
    null,
    2,
  );

  assert.ok(armed.documentResponse, `armed challenge document response not observed; diag=${diag}`);
  assert.ok(off.documentResponse, `off challenge document response not observed; diag=${diag}`);
  assert.ok(baseline.documentResponse, `baseline document response not observed; diag=${diag}`);

  const armedCSP = armed.documentResponse.csp;
  const offCSP = off.documentResponse.csp;
  const baselineCSP = baseline.documentResponse.csp;

  // (a) ARMED: the projected challenge CSP reaches the page. The challenge host
  // is added to script/connect/frame/child so a real human's Cloudflare widget
  // can execute.
  for (const directive of ['script-src', 'connect-src', 'frame-src', 'child-src']) {
    const segment = armedCSP
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(directive));
    assert.ok(
      segment && segment.includes('https://challenges.cloudflare.com'),
      `armed CSP ${directive} missing challenges.cloudflare.com: ${segment}; diag=${diag}`,
    );
  }
  // honor-not-manufacture: the projection adds NO wildcard egress and does not
  // touch worker-src (eval is never manufactured by the projection).
  assert.ok(
    !/connect-src[^;]*\*/.test(armedCSP),
    `armed CSP connect-src must not contain a wildcard; diag=${diag}`,
  );
  assert.ok(
    /worker-src 'self' blob:;/.test(armedCSP),
    `armed CSP worker-src must stay 'self' blob:; diag=${diag}`,
  );

  // (b) The internal X-ZP-Challenge-Compat marker is ABSENT from the
  // page-visible response headers (consumed-and-deleted at the SW layer).
  assert.equal(
    armed.documentResponse.markerPresent,
    false,
    `internal X-ZP-Challenge-Compat marker leaked to the page; diag=${diag}`,
  );

  // (c) Challenge subresources are routed THROUGH the proxy (/zp/api/*). Every
  // browser-issued challenge resource must be through_zeroproxy; any false is a
  // hard fail (no egress escape).
  assert.ok(
    armed.pageState.challengeSubLoaded,
    `armed challenge subresource did not load; diag=${diag}`,
  );
  const challengeRequests = armed.requestTrace.filter((r) => r.pathClass.startsWith('proxy:'));
  assert.ok(
    challengeRequests.length > 0,
    `expected proxy-routed requests on the armed path; diag=${diag}`,
  );
  // The armed challenge subresource must appear as a through-proxy api-script.
  assert.ok(
    armed.requestTrace.some((r) => r.pathClass === 'proxy:api-script' && r.throughZeroproxy),
    `armed challenge subresource not routed through /zp/api/script; diag=${diag}`,
  );
  // NO browser request on the armed path may escape the proxy origin.
  const armedEscapes = armed.requestTrace.filter((r) => !r.throughZeroproxy);
  assert.deepEqual(
    armedEscapes,
    [],
    `armed path leaked direct-egress requests (no egress escape allowed); diag=${diag}`,
  );

  // Defense-in-depth: every target-origin request the fixture saw arrived via
  // the proxy transport carrying the proxied UA (the browser never reached the
  // target directly).
  for (const s of seen) {
    assert.equal(
      s.userAgent,
      TARGET_UA,
      `target request ${s.pathClass} did not carry the proxied UA; diag=${diag}`,
    );
  }

  // (d) OFF compat: the challenge-document CSP is BYTE-IDENTICAL to the
  // non-compat plain-document baseline (allowDynamicCompile held constant), and
  // the ARMED CSP differs ONLY by the additive challenge projection.
  assert.equal(
    offCSP,
    baselineCSP,
    `OFF challenge CSP must be byte-identical to the non-compat baseline; diag=${diag}`,
  );
  assert.notEqual(
    armedCSP,
    offCSP,
    `ARMED CSP must differ from the OFF CSP (projection applied); diag=${diag}`,
  );
  // The ARMED CSP must be exactly the OFF CSP plus the challenge-host additions:
  // stripping every `https://challenges.cloudflare.com` occurrence from ARMED
  // must reproduce the OFF CSP byte-for-byte (additive projection only).
  const strippedArmed = armedCSP
    .split('; ')
    .map((directive) =>
      directive
        .replace(/ https:\/\/challenges\.cloudflare\.com/g, '')
        .replace(/https:\/\/challenges\.cloudflare\.com /g, ''),
    )
    .join('; ');
  assert.equal(
    strippedArmed,
    offCSP,
    `ARMED CSP must equal OFF CSP plus ONLY the challenge-host additions; diag=${diag}`,
  );
});
