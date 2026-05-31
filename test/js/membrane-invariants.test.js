// C0 membrane invariant freeze: characterization tests that pin the CURRENT
// observable security contract of the JS membrane (web/sw.js,
// web/runtime-prelude.js, web/worker-prelude.js, web/zp-core.js). These tests
// MUST stay green against the present code. Any later refactor that flips a
// fail-closed branch or removes a masking hook is meant to turn one of these
// red. They exercise REAL behavior (loaded into a vm / executed in isolation),
// not vacuous getters.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const read = (path) => fs.readFileSync(path, 'utf8');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Brace-matched extraction of a named function declaration straight from the
// live source file. If the function is renamed or deleted (e.g. a masking hook
// is dropped during the upcoming decomposition), this throws and the test
// suite goes red instead of silently passing against a stale reimplementation.
function extractFunction(src, name) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  assert.notEqual(start, -1, `source no longer declares function ${name}`);
  let depth = 0;
  let i = src.indexOf('{', start);
  assert.notEqual(i, -1, `function ${name} has no body`);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  const code = src.slice(start, i);
  assert.ok(code.length > sig.length, `extracted empty body for ${name}`);
  return code;
}

// Load web/zp-core.js then web/sw.js into one vm context with a minimal
// service-worker-shaped global. The classifier and fetch handler are top-level
// function declarations, so they land on the context object (same mechanism
// core.test.js uses to reach ctx.ZP). A `fetch` spy lets us prove the membrane
// never falls back to native passthrough for target traffic.
function loadServiceWorker() {
  let nativeFetchCalls = 0;
  let lastNativeFetchArg = null;
  const sandbox = {
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
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
    // Sentinel-returning spy: a regression that adds `return fetch(event.request)`
    // would bump this counter and surface a 200 'NATIVE' body. It returns rather
    // than throws so handleFetch's catch cannot mask the passthrough.
    fetch: (arg) => {
      nativeFetchCalls += 1;
      lastNativeFetchArg = arg;
      return Promise.resolve(new Response('NATIVE', { status: 200 }));
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('web/zp-core.js'), sandbox);
  assert.equal(typeof sandbox.ZP, 'object', 'zp-core.js did not populate ZP');
  vm.runInContext(read('web/sw.js'), sandbox);
  return {
    ctx: sandbox,
    nativeFetchCalls: () => nativeFetchCalls,
    lastNativeFetchArg: () => lastNativeFetchArg,
  };
}

function fakeRequest(url, { mode = 'no-cors', method = 'GET', headers = {} } = {}) {
  const h = new Headers(headers);
  return { url, mode, method, headers: h };
}

// ---------------------------------------------------------------------------
// Invariant 1: NO-DIRECT-EGRESS / FAIL-CLOSED CLASSIFICATION
// ---------------------------------------------------------------------------

test('membrane: SW classifier marks unknown same-origin and cross-origin requests UNKNOWN', () => {
  const { ctx } = loadServiceWorker();
  // classify() runs in the SW vm realm, so its result object has a cross-realm
  // prototype; assert on the observable .kind field rather than deepEqual.
  // Unknown same-origin path with no client context -> UNKNOWN (not an asset,
  // not a share route, not a runtime API).
  const sameOrigin = fakeRequest('https://proxy.example/some/unmapped/path');
  assert.equal(
    ctx.classify(sameOrigin, new ctx.URL(sameOrigin.url), undefined).kind,
    'UNKNOWN',
    'unmapped same-origin request must classify UNKNOWN',
  );
  // Arbitrary cross-origin request with no recovered context -> UNKNOWN.
  const crossOrigin = fakeRequest('https://tracker.evil.example/beacon.gif');
  assert.equal(
    ctx.classify(crossOrigin, new ctx.URL(crossOrigin.url), undefined).kind,
    'UNKNOWN',
    'context-less cross-origin request must classify UNKNOWN',
  );
});

test('membrane: unknown navigation fails closed to POLICY_BLOCKED 403 with no native fetch', async () => {
  const sw = loadServiceWorker();
  const req = fakeRequest('https://proxy.example/totally/unknown', { mode: 'navigate' });
  const res = await sw.ctx.handleFetch({ request: req, clientId: undefined });
  assert.equal(res.status, 403, 'unknown navigation must be blocked with 403');
  const body = await res.text();
  assert.ok(body.includes('POLICY_BLOCKED'), 'blocked navigation must name POLICY_BLOCKED');
  // The decisive characterization: native fetch(event.request) is never reached.
  assert.equal(sw.nativeFetchCalls(), 0, 'unknown navigation must NOT fall back to native fetch');
});

test('membrane: unknown subresource fails closed to Response.error with no native fetch', async () => {
  const sw = loadServiceWorker();
  // Cross-origin, non-navigate subresource with no context: the membrane must
  // emit an opaque network error, never proxy it to the real network.
  const req = fakeRequest('https://cdn.evil.example/track.js', { mode: 'no-cors' });
  const res = await sw.ctx.handleFetch({ request: req, clientId: undefined });
  assert.equal(res.type, 'error', 'unknown subresource must yield a Response.error()');
  assert.equal(sw.nativeFetchCalls(), 0, 'unknown subresource must NOT fall back to native fetch');
  assert.equal(
    sw.lastNativeFetchArg(),
    null,
    'native transport must never have seen the target request',
  );
});

test('membrane: SW source never bridges target traffic to native fetch(event.request)', () => {
  // Belt-and-suspenders against the exact passthrough escape: the only native
  // fetch the SW may use is the bound `nativeFetch` for first-party asset/kernel
  // loads. A direct `fetch(event.request)` would be a no-classification egress.
  const sw = read('web/sw.js');
  assert.equal(
    /\bfetch\s*\(\s*event\.request\s*\)/.test(sw),
    false,
    'service worker must not pass the raw event.request to native fetch',
  );
  assert.match(sw, /event\.respondWith\(handleFetch\(event\)\)/);
  // The default branch of handleFetch is the fail-closed sink.
  assert.match(
    sw,
    /default:\s*return req\.mode === 'navigate' \? safeError\('POLICY_BLOCKED', 403\) : Response\.error\(\)/,
    'handleFetch default branch must fail closed (403 navigate / Response.error subresource)',
  );
});

// ---------------------------------------------------------------------------
// Invariant 2: MASKING-HOOK PRESENCE (stealth membrane filters ZP artifacts)
// ---------------------------------------------------------------------------

// Extract the own-property masking installer plus its pure predicates and run
// them against a fake global. This proves the filter is INSTALLED and ACTUALLY
// FILTERS: a probe for a ZP artifact comes back hidden, benign props survive.
//
// The installer redefines Object.keys / getOwnPropertyNames / Reflect.ownKeys
// on whatever intrinsics the fake global exposes. To avoid monkey-patching the
// host (Node) intrinsics process-wide -- which would make tests order-dependent
// -- everything runs inside an isolated vm context whose Object/Reflect are
// context-local, and the fake global is wired to those same context-local
// intrinsics.
function loadOwnPropertyMasking() {
  const src = read('web/runtime-prelude.js');
  const code = [
    extractFunction(src, 'hiddenGlobalKey'),
    extractFunction(src, 'isGlobalObjectForMasking'),
    extractFunction(src, 'visibleOwnKeysFor'),
    extractFunction(src, 'installOwnPropertyMasking'),
    // maskNativeFunction is a toString-masking detail irrelevant to enumeration
    // filtering; stub it so the installer runs in isolation.
    'function maskNativeFunction() {}',
    'module.exports = { hiddenGlobalKey, isGlobalObjectForMasking, visibleOwnKeysFor, installOwnPropertyMasking };',
  ].join('\n\n');
  const sandbox = { module: { exports: {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // Context-local intrinsics: mutating these never touches the host process.
  const ctxObject = vm.runInContext('Object', sandbox);
  const ctxReflect = vm.runInContext('Reflect', sandbox);
  vm.runInContext(code, sandbox);
  return { ...sandbox.module.exports, Object: ctxObject, Reflect: ctxReflect };
}

test('membrane: own-property masking hides ZP artifacts from enumeration, keeps app props', () => {
  const M = loadOwnPropertyMasking();
  // Fake page global wired to context-local intrinsics; window self-reference is
  // what marks it as the masked target.
  const w = { Object: M.Object, Reflect: M.Reflect };
  w.window = w;
  // ZeroProxy artifacts that must be hidden.
  w.ZP = {};
  w.ZPRewriter = {};
  w.ZPRustRewriter = {};
  w.__ZP_BOOT = {};
  w.__ZP_SET_BASE = () => {};
  w.__zp_get = () => {};
  w.__zp_ownKeys = () => {};
  // Benign application-visible properties that must survive.
  w.jQuery = {};
  w.appData = { a: 1 };
  w.normalProp = 42;

  M.installOwnPropertyMasking(w);

  const hidden = [
    'ZP',
    'ZPRewriter',
    'ZPRustRewriter',
    '__ZP_BOOT',
    '__ZP_SET_BASE',
    '__zp_get',
    '__zp_ownKeys',
  ];
  const visible = ['jQuery', 'appData', 'normalProp'];

  const names = w.Object.getOwnPropertyNames(w);
  for (const k of hidden) assert.ok(!names.includes(k), `getOwnPropertyNames leaks ${k}`);
  for (const k of visible) assert.ok(names.includes(k), `getOwnPropertyNames dropped benign ${k}`);

  const keys = w.Object.keys(w);
  for (const k of hidden) assert.ok(!keys.includes(k), `Object.keys leaks ${k}`);

  const reflectKeys = w.Reflect.ownKeys(w);
  for (const k of hidden) assert.ok(!reflectKeys.includes(k), `Reflect.ownKeys leaks ${k}`);

  // Direct descriptor probe must also report the artifact as absent.
  assert.equal(
    w.Object.getOwnPropertyDescriptor(w, 'ZP'),
    undefined,
    'getOwnPropertyDescriptor must hide ZP on the global',
  );
  assert.ok(
    w.Object.getOwnPropertyDescriptor(w, 'jQuery'),
    'getOwnPropertyDescriptor must still report benign props',
  );

  // getOwnPropertyDescriptors must scrub the artifact entries too.
  const descs = w.Object.getOwnPropertyDescriptors(w);
  for (const k of hidden) assert.ok(!(k in descs), `getOwnPropertyDescriptors leaks ${k}`);
  assert.ok('jQuery' in descs, 'getOwnPropertyDescriptors dropped benign jQuery');
});

test('membrane: hiddenGlobalKey predicate classifies ZP globals vs app globals', () => {
  const M = loadOwnPropertyMasking();
  for (const k of [
    'ZP',
    'ZPRewriter',
    'ZPRustRewriter',
    '__ZP_BOOT',
    '__ZP_SET_BASE',
    '__zp_x',
    '__ZP_Y',
  ]) {
    assert.ok(M.hiddenGlobalKey(k), `hiddenGlobalKey should hide ${k}`);
  }
  for (const k of ['fetch', 'document', 'jQuery', 'addEventListener', 'zpilot', 'myZP']) {
    assert.ok(!M.hiddenGlobalKey(k), `hiddenGlobalKey must not hide benign ${k}`);
  }
  // Off-target objects (non-window) must NOT be filtered at all.
  const plain = { ZP: 1, jQuery: 2 };
  assert.deepEqual(
    M.visibleOwnKeysFor(plain, ['ZP', 'jQuery'], { window: { window: {} } }),
    ['ZP', 'jQuery'],
    'masking must not strip keys from non-global objects',
  );
});

// DOM-enumeration filter: selectorTargetsZP is the pure gate that makes
// querySelector / querySelectorAll / matches / closest refuse ZP-artifact
// selectors. Extract and exercise it directly.
function loadSelectorFilter() {
  const src = read('web/runtime-prelude.js');
  const code =
    extractFunction(src, 'selectorTargetsZP') + '\nmodule.exports = { selectorTargetsZP };';
  const sandbox = { module: { exports: {} }, String };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.module.exports.selectorTargetsZP;
}

test('membrane: selector filter rejects probes for data-zp-*, /zp/assets/, /zp/api/, zeroproxy', () => {
  const selectorTargetsZP = loadSelectorFilter();
  const zpSelectors = [
    '[data-zp-target-url]',
    'script[data-zp-integrity]',
    '#__zp-boot',
    'script[src*="/zp/assets/"]',
    'link[href*="/zp/api/"]',
    'meta[content*="zeroproxy"]',
    'img[src*="x-zeroproxy-icon"]',
    'script[src*="zp"]',
  ];
  for (const sel of zpSelectors) {
    assert.ok(selectorTargetsZP(sel), `selectorTargetsZP must flag ${sel}`);
  }
  for (const sel of ['.container > div', '#app', 'a[href]', 'input[name="email"]']) {
    assert.ok(!selectorTargetsZP(sel), `selectorTargetsZP must allow benign ${sel}`);
  }
});

test('membrane: stealth + masking hooks are installed into the runtime global', () => {
  const rt = read('web/runtime-prelude.js');
  // The installers exist and are invoked during membrane setup.
  assert.match(rt, /function installStealthMembrane\(w\)/);
  assert.match(rt, /function installOwnPropertyMasking\(w\)/);
  assert.match(rt, /installOwnPropertyMasking\(root\)/);
  assert.match(rt, /installStealthMembrane\(root\)/);
  // The stealth membrane overrides the live DOM enumeration surface so ZP asset
  // nodes are filtered out of getElementsByTagName / scripts / querySelectorAll.
  for (const needle of [
    "define(w.Document.prototype, 'getElementsByTagName'",
    "define(w.Element.prototype, 'getElementsByTagName'",
    "Object.defineProperty(w.Document.prototype, 'scripts'",
    "define(w.Document.prototype, 'querySelectorAll'",
    "define(w.Element.prototype, 'querySelectorAll'",
    "define(w.Document.prototype, 'createTreeWalker'",
    'isZPAssetNode',
  ]) {
    assert.ok(rt.includes(needle), `stealth membrane missing hook: ${needle}`);
  }
  // The node-level artifact predicate keys off the boot marker and proxy asset
  // URLs; deleting either branch would unmask ZP nodes.
  assert.match(rt, /function isZPAssetNode\(node\)/);
  assert.match(rt, /node\.id === '__zp-boot'/);
  assert.match(rt, /isZeroProxyAssetURL/);
  // Worker realm carries the matching native-function masking for fetch/importScripts.
  const worker = read('web/worker-prelude.js');
  assert.match(worker, /maskNativeFunction/);
  assert.ok(worker.includes("maskNativeFunction(self.fetch, 'fetch')"));
  assert.ok(worker.includes("maskNativeFunction(self.importScripts, 'importScripts')"));
});

// ---------------------------------------------------------------------------
// Invariant 3: membrane CSP default-deny posture
//
// The non-challenge CSP byte-strings for the document/server CSP are already
// pinned in test/js/static-policy.test.js (script-src / connect-src variants
// and the nosniff header). We do NOT duplicate those. What was UNPINNED is the
// fail-closed default-deny skeleton that every membrane error/bootstrap
// response carries via ZP.fixedCSP() -- pin it behaviorally here.
// ---------------------------------------------------------------------------

test('membrane: ZP.fixedCSP() is default-deny with locked-down base/object/form-action', () => {
  const { ctx } = loadServiceWorker();
  const csp = ctx.ZP.fixedCSP();
  assert.ok(csp.startsWith("default-src 'none'; "), 'membrane CSP must start default-src none');
  assert.match(csp, /object-src 'none'/, 'membrane CSP must forbid plugins');
  assert.match(csp, /base-uri 'none'/, 'membrane CSP must lock base-uri');
  assert.match(csp, /form-action 'self'/, 'membrane CSP must constrain form-action');
  assert.match(csp, /frame-src 'self' blob: data:/, 'membrane CSP must constrain frame-src');
  assert.match(csp, /worker-src 'self' blob:/, 'membrane CSP must constrain worker-src');
  // Default (non-dynamic-compile) script-src must NOT grant unsafe-eval.
  assert.equal(/'unsafe-eval'/.test(csp), false, 'default membrane CSP must not grant unsafe-eval');
  // The opt-in dynamic-compile branch is the only place unsafe-eval appears.
  const dynamic = ctx.ZP.fixedCSP([], { allowDynamicCompile: true });
  assert.match(dynamic, /'unsafe-eval'/, 'allowDynamicCompile branch must grant unsafe-eval');
});

// ---------------------------------------------------------------------------
// Invariant 3b: challenge-compatibility CSP projection (default OFF)
//
// challengeCompat is the opt-in projection that lets a REAL human's Cloudflare
// challenge execute through the proxy. It must (a) be byte-identical to the
// default CSP when OFF, (b) when ON add ONLY the challenge host to
// script/connect/frame/child plus the already-present blob: worker capability,
// (c) NEVER open a wildcard / direct-egress hole, and (d) NEVER manufacture
// eval -- 'unsafe-eval' may appear only when allowDynamicCompile is already set
// (honoring the target's own grant; F3).
// ---------------------------------------------------------------------------

test('membrane: challengeCompat OFF path is byte-identical to the default CSP', () => {
  const { ctx } = loadServiceWorker();
  const base = ctx.ZP.fixedCSP();
  assert.equal(ctx.ZP.fixedCSP([], {}), base, 'empty options must equal the default CSP');
  assert.equal(
    ctx.ZP.fixedCSP([], { challengeCompat: false }),
    base,
    'challengeCompat:false must be byte-identical to the default CSP',
  );
});

// Parse a CSP string into ORDERED [directive, source-token[]] entries. We do NOT
// collapse by name: a smuggled duplicate directive must remain visible so the
// delta proof below can reject it (duplicates would otherwise evade a Map).
function parseCSPEntries(csp) {
  return csp
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((part) => {
      const tokens = part.split(/\s+/);
      return [tokens[0], tokens.slice(1)];
    });
}

function directiveNames(entries) {
  return entries.map(([name]) => name);
}

test('membrane: armed challengeCompat adds EXACTLY the challenge host and nothing else', () => {
  const { ctx } = loadServiceWorker();
  const cf = 'https://challenges.cloudflare.com';
  const baseEntries = parseCSPEntries(ctx.ZP.fixedCSP());
  const armedEntries = parseCSPEntries(ctx.ZP.fixedCSP([], { challengeCompat: true }));

  // Directive SEQUENCE is unchanged -- no directive added, removed, reordered, or
  // DUPLICATED (comparing the full ordered name list catches a smuggled dup).
  assert.deepEqual(
    directiveNames(armedEntries),
    directiveNames(baseEntries),
    'armed CSP must not add/remove/duplicate/reorder directives',
  );
  // Baseline itself must have no duplicate directive (guards the proof's premise).
  const baseNames = directiveNames(baseEntries);
  assert.equal(
    new Set(baseNames).size,
    baseNames.length,
    'baseline CSP has no duplicate directive',
  );

  // The challenge host is the ONLY added token, and only on these four directives.
  const projected = new Set(['script-src', 'connect-src', 'frame-src', 'child-src']);
  for (let i = 0; i < baseEntries.length; i++) {
    const [name, baseTokens] = baseEntries[i];
    const armedTokens = armedEntries[i][1];
    const added = armedTokens.filter((t) => !baseTokens.includes(t));
    const removed = baseTokens.filter((t) => !armedTokens.includes(t));
    assert.deepEqual(removed, [], `${name} must not drop any baseline token when armed`);
    if (projected.has(name)) {
      // EXACTLY the challenge host -- not https:, not a wildcard, not another host.
      assert.deepEqual(added, [cf], `${name} armed delta must be exactly the challenge host`);
    } else {
      assert.deepEqual(added, [], `${name} must be byte-identical when armed`);
    }
  }

  // Spelled-out consequences of the delta proof, for readability at the failure site.
  const armedByName = new Map(armedEntries);
  assert.deepEqual(
    armedByName.get('worker-src'),
    ["'self'", 'blob:'],
    'worker-src keeps blob: (no cf)',
  );
  assert.ok(
    armedByName.get('script-src').includes("'nonce-zp'"),
    'armed script-src preserves the nonce',
  );
  // NO egress/execution escape: the directives that could leak a fetch or run code
  // must never carry a bare wildcard. (style/img/font/media already use '*' in the
  // unchanged baseline; the delta proof above guarantees we added nothing there.)
  const guardedDirectives = [
    'script-src',
    'connect-src',
    'frame-src',
    'child-src',
    'worker-src',
    'object-src',
  ];
  for (const guarded of guardedDirectives) {
    const tokens = armedByName.get(guarded) || [];
    assert.equal(tokens.includes('*'), false, `${guarded} must not carry a bare wildcard source`);
  }
});

test('membrane: challengeCompat honors but never manufactures the eval grant (F3)', () => {
  const { ctx } = loadServiceWorker();
  // Bare 'unsafe-eval' (not the distinct 'wasm-unsafe-eval') is the discriminator.
  const hasBareEval = (csp) => /(^|[^-])'unsafe-eval'/.test(csp);
  // Armed WITHOUT a target eval grant -> still NO eval (honor-not-manufacture).
  const armedNoEval = ctx.ZP.fixedCSP([], { challengeCompat: true });
  assert.equal(
    hasBareEval(armedNoEval),
    false,
    'challengeCompat alone must not manufacture unsafe-eval',
  );
  // Armed AND the target already granted eval -> eval rides the existing grant only.
  const armedWithEval = ctx.ZP.fixedCSP([], { challengeCompat: true, allowDynamicCompile: true });
  assert.equal(
    hasBareEval(armedWithEval),
    true,
    'challengeCompat must honor an existing allowDynamicCompile eval grant',
  );
});

test('membrane: blocked navigation response carries the default-deny membrane CSP', async () => {
  const sw = loadServiceWorker();
  const req = fakeRequest('https://proxy.example/unknown/route', { mode: 'navigate' });
  const res = await sw.ctx.handleFetch({ request: req, clientId: undefined });
  const csp = res.headers.get('Content-Security-Policy') || '';
  assert.ok(
    csp.startsWith("default-src 'none'; "),
    'fail-closed error page must serve the default-deny membrane CSP',
  );
  assert.equal(
    res.headers.get('X-Content-Type-Options'),
    'nosniff',
    'fail-closed error page must keep nosniff',
  );
});
