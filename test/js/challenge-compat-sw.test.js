// B4 characterization tests: the service worker threads the kernel's
// X-ZP-Challenge-Compat marker into the per-document CSP and the per-tab arm bit
// into rewritten challenge SCRIPTS, while NEVER leaking the internal marker to
// the page and keeping the OFF/non-challenge path byte-identical.
//
// These run REAL behavior: web/zp-core.js + web/sw.js are loaded into one vm
// context (the same harness membrane-invariants uses) so addCSP / scriptResponseHeaders
// execute against the live source, not a reimplementation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const read = (path) => fs.readFileSync(path, 'utf8');
const CF_HOST = 'https://challenges.cloudflare.com';

function loadServiceWorker() {
  const sandbox = {
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    AbortController,
    ReadableStream,
    Blob,
    WebAssembly,
    Map,
    Set,
    Promise,
    Array,
    Object,
    Reflect,
    JSON,
    Date,
    setTimeout,
    console,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    location: {
      origin: 'https://proxy.example',
      protocol: 'https:',
      host: 'proxy.example',
      href: 'https://proxy.example/zp/',
    },
    importScripts: () => {},
    addEventListener: () => {},
    fetch: () => Promise.resolve(new Response('NATIVE', { status: 200 })),
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('web/zp-core.js'), sandbox);
  vm.runInContext(read('web/sw.js'), sandbox);
  return sandbox;
}

// A document response that the KERNEL armed+classified: it carries the internal
// X-ZP-Challenge-Compat: 1 marker (the kernel only emits it under the two-signal
// gate). addCSP is the consumer.
function markedResponse(extra = {}) {
  const headers = new Headers(Object.assign({ 'X-ZP-Challenge-Compat': '1' }, extra));
  return new Response('<html></html>', { status: 200, headers });
}

test('B4 addCSP: armed+classified marker -> challengeCompat CSP, marker stripped', () => {
  const ctx = loadServiceWorker();
  const out = ctx.addCSP(markedResponse(), undefined, []);
  // The internal marker MUST NOT leak to the page.
  assert.equal(out.headers.get('X-ZP-Challenge-Compat'), null, 'internal marker must be deleted');
  // The projected CSP must permit the challenge host (challengeCompat=true).
  const csp = out.headers.get('Content-Security-Policy');
  assert.ok(csp.includes(CF_HOST), 'armed document CSP must include the challenge host');
  assert.equal(
    csp,
    ctx.ZP.fixedCSP([], { challengeCompat: true }),
    'must equal the challengeCompat projection',
  );
});

test('B4 addCSP: unmarked response -> byte-identical default CSP, no challenge host', () => {
  const ctx = loadServiceWorker();
  const out = ctx.addCSP(new Response('<html></html>', { status: 200 }), undefined, []);
  const csp = out.headers.get('Content-Security-Policy');
  assert.equal(
    csp,
    ctx.ZP.fixedCSP([], { allowDynamicCompile: false, challengeCompat: false }),
    'OFF path CSP',
  );
  assert.equal(csp, ctx.ZP.fixedCSP([]), 'OFF path is byte-identical to the default CSP');
  assert.ok(!csp.includes(CF_HOST), 'unarmed document CSP must NOT include the challenge host');
});

test('B4 addCSP: honor-not-manufacture eval is preserved alongside challengeCompat', () => {
  const ctx = loadServiceWorker();
  // Marker present but NO dynamic-compile grant -> challenge host yes, unsafe-eval no.
  const noEval = ctx.addCSP(markedResponse(), undefined, []).headers.get('Content-Security-Policy');
  assert.ok(noEval.includes(CF_HOST), 'challenge host present');
  assert.ok(!noEval.includes("'unsafe-eval'"), 'challengeCompat alone must not manufacture eval');
  // Marker + target-authoritative dynamic-compile grant -> both present.
  const withEval = ctx
    .addCSP(markedResponse({ 'X-ZP-Dynamic-Compile': '1' }), undefined, [])
    .headers.get('Content-Security-Policy');
  assert.ok(withEval.includes(CF_HOST), 'challenge host present with eval grant');
  assert.ok(withEval.includes("'unsafe-eval'"), 'honors the target eval grant');
});

test('B4 scriptResponseHeaders: armed tab -> challenge-host script CSP; unarmed -> default', () => {
  const ctx = loadServiceWorker();
  const armed = ctx.scriptResponseHeaders(new Response('//js', { status: 200 }), true);
  assert.ok(
    armed.get('Content-Security-Policy').includes(CF_HOST),
    'armed script CSP includes challenge host',
  );
  // Marker must never appear on the script path either.
  assert.equal(armed.get('X-ZP-Challenge-Compat'), null);
  const unarmed = ctx.scriptResponseHeaders(new Response('//js', { status: 200 }), false);
  assert.equal(
    unarmed.get('Content-Security-Policy'),
    ctx.ZP.fixedCSP(),
    'unarmed script CSP is byte-identical to the default CSP',
  );
  assert.ok(
    !unarmed.get('Content-Security-Policy').includes(CF_HOST),
    'unarmed script CSP omits the challenge host',
  );
});

// B4 TWO-SIGNAL gate on the SCRIPT/WORKER path: rewriteScriptResponse projects the
// challenge CSP only when BOTH the per-tab arm bit (opt.challengeCompat) AND a
// per-response URL classification (isChallengeURL(opt.targetUrl)) hold. The arm bit
// ALONE must NOT relax a non-challenge script — that would diverge from the default
// CSP and break the non-challenge-path byte-identical invariant.
function rewriterStub() {
  // Deterministic stub so the test exercises the header/gating logic, not the wasm
  // rewriter. rewriteScriptResponse computes headers BEFORE invoking the rewriter,
  // so the CSP under test is unaffected by the stub's code output.
  return {
    ready: true,
    rewriteScript: () => ({ ok: true, code: '//ok' }),
    blockSource: () => '//blocked',
  };
}

test('B4 rewriteScriptResponse: armed tab + NON-challenge URL -> script CSP byte-identical to default (no CF host)', async () => {
  const ctx = loadServiceWorker();
  ctx.self.ZPRewriter = rewriterStub();
  const out = await ctx.rewriteScriptResponse(new Response('//js', { status: 200 }), {
    targetUrl: 'https://example.com/app.js',
    kind: 'classic',
    challengeCompat: true, // arm bit ON, but URL does NOT classify -> single signal only
  });
  const csp = out.headers.get('Content-Security-Policy');
  assert.equal(
    csp,
    ctx.ZP.fixedCSP(),
    'armed + non-challenge URL must be byte-identical to the default script CSP',
  );
  assert.ok(
    !csp.includes(CF_HOST),
    'non-challenge script on an armed tab must NOT include the challenge host',
  );
  assert.equal(
    out.headers.get('X-ZP-Challenge-Compat'),
    null,
    'internal marker must never leak on the script path',
  );
});

test('B4 rewriteScriptResponse: armed tab + challenges.cloudflare.com URL -> challenge host present', async () => {
  const ctx = loadServiceWorker();
  ctx.self.ZPRewriter = rewriterStub();
  const out = await ctx.rewriteScriptResponse(new Response('//js', { status: 200 }), {
    targetUrl: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
    kind: 'classic',
    challengeCompat: true, // BOTH signals: armed AND classified -> projection ON
  });
  const csp = out.headers.get('Content-Security-Policy');
  assert.ok(csp.includes(CF_HOST), 'armed + challenge URL must include the challenge host');
  assert.equal(
    csp,
    ctx.ZP.fixedCSP([], { challengeCompat: true }),
    'must equal the challengeCompat projection',
  );
});

test('B4 rewriteScriptResponse: armed tab + /cdn-cgi/challenge-platform/ URL -> challenge host present', async () => {
  const ctx = loadServiceWorker();
  ctx.self.ZPRewriter = rewriterStub();
  const out = await ctx.rewriteScriptResponse(new Response('//js', { status: 200 }), {
    targetUrl: 'https://victim.example/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1',
    kind: 'worker',
    challengeCompat: true,
  });
  assert.ok(
    out.headers.get('Content-Security-Policy').includes(CF_HOST),
    'same-zone challenge-platform path classifies',
  );
});

test('B4 rewriteScriptResponse: UNARMED tab + challenge URL -> default CSP (arm bit gates)', async () => {
  const ctx = loadServiceWorker();
  ctx.self.ZPRewriter = rewriterStub();
  const out = await ctx.rewriteScriptResponse(new Response('//js', { status: 200 }), {
    targetUrl: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
    kind: 'classic',
    challengeCompat: false, // arm bit OFF -> classification alone must not relax
  });
  const csp = out.headers.get('Content-Security-Policy');
  assert.equal(
    csp,
    ctx.ZP.fixedCSP(),
    'unarmed challenge script must be byte-identical to the default CSP',
  );
  assert.ok(!csp.includes(CF_HOST), 'unarmed challenge script must NOT include the challenge host');
});

// Design lock-in: the script/worker path classifies by URL ONLY and DELIBERATELY
// ignores response headers (e.g. cf-mitigated: challenge). The cf-mitigated signal
// is a DOCUMENT-level signal; it is honored at the document layer by the kernel's
// full targetIsChallengeDocument predicate (header OR url), surfaced via the
// X-ZP-Challenge-Compat marker that addCSP reads on the navigation response. A
// challenge SUBRESOURCE (worker/script) in the real Turnstile flow is always served
// from challenges.cloudflare.com or /cdn-cgi/challenge-platform/, so URL matching
// covers it. This test pins that an armed tab + non-CF URL stays on the default CSP
// even when the response carries cf-mitigated: challenge (no body/header sniffing).
test('B4 rewriteScriptResponse: armed tab + non-CF URL + cf-mitigated header -> default CSP (header ignored on script path)', async () => {
  const ctx = loadServiceWorker();
  ctx.self.ZPRewriter = rewriterStub();
  const resp = new Response('//js', { status: 200, headers: { 'Cf-Mitigated': 'challenge' } });
  const out = await ctx.rewriteScriptResponse(resp, {
    targetUrl: 'https://example.com/app.js',
    kind: 'classic',
    challengeCompat: true,
  });
  const csp = out.headers.get('Content-Security-Policy');
  assert.equal(
    csp,
    ctx.ZP.fixedCSP(),
    'response headers must NOT relax the script CSP; URL is the only script-path signal',
  );
  assert.ok(
    !csp.includes(CF_HOST),
    'cf-mitigated header alone must not add the challenge host on the script path',
  );
});

test('B4 isChallengeURL: URL-only classifier mirrors the kernel; malformed URL is false', () => {
  const ctx = loadServiceWorker();
  assert.equal(ctx.isChallengeURL('https://challenges.cloudflare.com/x'), true);
  assert.equal(ctx.isChallengeURL('https://v.example/cdn-cgi/challenge-platform/h'), true);
  assert.equal(ctx.isChallengeURL('https://example.com/app.js'), false);
  assert.equal(ctx.isChallengeURL('https://notchallenges.cloudflare.com.evil.example/x'), false);
  assert.equal(ctx.isChallengeURL('not a url'), false);
  assert.equal(ctx.isChallengeURL(undefined), false);
});

test('B4 scriptResponseHeaders: internal marker on a script response is stripped (no leak)', () => {
  const ctx = loadServiceWorker();
  const marked = new Response('//js', { status: 200, headers: { 'X-ZP-Challenge-Compat': '1' } });
  const h = ctx.scriptResponseHeaders(marked, false);
  assert.equal(
    h.get('X-ZP-Challenge-Compat'),
    null,
    'marker must be deleted from script response headers',
  );
});

// ---------------------------------------------------------------------------
// B5 behavioral arm tests: the kernel arm header X-Zp-Challenge-Compat-Arm is
// set authoritatively from TRUSTED per-tab state inside transportFetch, and any
// page-supplied (forged) value is unconditionally deleted first. Default OFF.
//
// Seam: readiness !== 'READY' (sw.js) only gates whether initKernel runs; on
// success transportFetch falls through to self.__go_jshttp. So stubbing
// initKernel to a no-op and capturing the final Request via __go_jshttp lets the
// REAL delete+conditional-set run end-to-end against a real createTab() tab.
function loadServiceWorkerWithBridge() {
  const ctx = loadServiceWorker();
  let captured = null;
  ctx.initKernel = async () => {}; // no-op: drive transportFetch past the readiness gate
  ctx.self.__go_jshttp = (request) => {
    captured = request;
    return new ctx.Response('ok', { status: 200 });
  };
  return { ctx, getCaptured: () => captured };
}

test('B5 transportFetch: ARMED tab sets X-Zp-Challenge-Compat-Arm:1 from trusted state', async () => {
  const { ctx, getCaptured } = loadServiceWorkerWithBridge();
  const tab = ctx.createTab('https://example.com/', [], true); // explicit opt-in
  await ctx.transportFetch('https://example.com/', { method: 'GET', tab });
  assert.equal(
    getCaptured().headers.get('X-Zp-Challenge-Compat-Arm'),
    '1',
    'armed tab must set the kernel arm header from trusted per-tab state',
  );
});

test('B5 transportFetch: UNARMED tab emits NO arm header (default OFF / byte-identical)', async () => {
  const { ctx, getCaptured } = loadServiceWorkerWithBridge();
  const tab = ctx.createTab('https://example.com/', []); // default OFF
  await ctx.transportFetch('https://example.com/', { method: 'GET', tab });
  assert.equal(
    getCaptured().headers.get('X-Zp-Challenge-Compat-Arm'),
    null,
    'unarmed tab must never emit the kernel arm header',
  );
});

test('B5 transportFetch: page-FORGED arm header on an UNARMED tab is DELETED (forgery blocked)', async () => {
  const { ctx, getCaptured } = loadServiceWorkerWithBridge();
  const tab = ctx.createTab('https://example.com/', []); // unarmed trusted state
  // A proxied page can smuggle headers in via the /zp/api/fetch payload; model that
  // as a forged inbound arm header on the request. The unconditional delete must win.
  const forged = new ctx.Request('https://example.com/', {
    headers: { 'X-Zp-Challenge-Compat-Arm': '1' },
  });
  await ctx.transportFetch('https://example.com/', { request: forged, method: 'GET', tab });
  assert.equal(
    getCaptured().headers.get('X-Zp-Challenge-Compat-Arm'),
    null,
    'page-forged arm header must be deleted; trusted unarmed state wins',
  );
});

test('B5 transportFetch: ARMED tab overrides a page-forged arm header with trusted :1', async () => {
  const { ctx, getCaptured } = loadServiceWorkerWithBridge();
  const tab = ctx.createTab('https://example.com/', [], true);
  const forged = new ctx.Request('https://example.com/', {
    headers: { 'X-Zp-Challenge-Compat-Arm': 'evil' },
  });
  await ctx.transportFetch('https://example.com/', { request: forged, method: 'GET', tab });
  assert.equal(
    getCaptured().headers.get('X-Zp-Challenge-Compat-Arm'),
    '1',
    'forged value is deleted then re-set to the trusted :1 (never the page value)',
  );
});

// B5 runtime-prelude defense-in-depth: fetchThroughRuntime must strip any inbound
// arm header (text-level, consistent with how static-policy.test.js treats this
// file; the full prelude is not executed here).
test('B5 runtime-prelude: fetchThroughRuntime strips inbound X-Zp-Challenge-Compat-Arm', () => {
  const rt = read('web/runtime-prelude.js');
  const start = rt.indexOf('async function fetchThroughRuntime');
  assert.notEqual(start, -1, 'fetchThroughRuntime must exist');
  const body = rt.slice(start, start + 2000);
  assert.match(
    body,
    /apiHeaders\.delete\('X-Zp-Challenge-Compat-Arm'\)/,
    'fetchThroughRuntime must delete any page-supplied arm header',
  );
});

// B5 trusted-hop wiring: the index.html opt-in checkbox is the ONLY user surface
// for the arm, and it threads challengeCompat into the window->SW ZP_OPEN_SHARE
// message. Default UNCHECKED.
test('B5 index.html: opt-in checkbox threads challengeCompat into ZP_OPEN_SHARE (default off)', () => {
  const html = read('web/index.html');
  assert.match(html, /id="challenge-compat"[^>]*type="checkbox"/, 'opt-in checkbox present');
  assert.ok(!/id="challenge-compat"[^>]*checked/.test(html), 'checkbox must default UNCHECKED');
  assert.match(
    html,
    /type: 'ZP_OPEN_SHARE'[^}]*challengeCompat/,
    'openTarget must thread challengeCompat into the ZP_OPEN_SHARE message',
  );
});

test('B4 createTab: challengeCompat is the per-tab arm bit, default OFF', () => {
  const ctx = loadServiceWorker();
  const off = ctx.createTab('https://example.com/', []);
  assert.equal(off.challengeCompat, false, 'default tab is unarmed');
  const armed = ctx.createTab('https://example.com/', [], true);
  assert.equal(armed.challengeCompat, true, 'explicit opt-in arms the tab');
});

// Static guards: the load-bearing arm-header strip and the script-path threading
// must remain present (text-level, since transportFetch needs the kernel bridge).
test('B4 plumbing: transportFetch authoritatively strips/sets the kernel arm header', () => {
  const sw = read('web/sw.js');
  assert.match(
    sw,
    /headers\.delete\('X-Zp-Challenge-Compat-Arm'\)/,
    'unconditional arm-header delete',
  );
  assert.match(
    sw,
    /if \(opt\.tab\.challengeCompat\) headers\.set\('X-Zp-Challenge-Compat-Arm', '1'\)/,
    'conditional arm-header set for armed tabs',
  );
  // EVERY rewriteScriptResponse call site must thread the tab arm bit so challenge
  // SCRIPTS get the projected CSP. There are 3 sites (virtualSubresource via `tab`,
  // /zp/api/script and /zp/api/worker-script via `resolved.tab`); a half-edit that
  // wires only some is the exact failure this guard catches.
  const callSites = sw.match(/(?<!function )rewriteScriptResponse\(/g) || [];
  const threaded = sw.match(/challengeCompat: (?:tab|resolved\.tab)\.challengeCompat/g) || [];
  assert.equal(callSites.length, 3, 'expected exactly 3 rewriteScriptResponse call sites');
  assert.equal(
    threaded.length,
    3,
    'every rewriteScriptResponse call site must thread the tab arm bit',
  );
  // ZP_OPEN_SHARE plumbs the opt-in field into createTab.
  assert.match(
    sw,
    /createTab\(msg\.targetUrl, msg\.servers, msg\.challengeCompat\)/,
    'open-share plumbs opt-in',
  );
});
