// C0 membrane invariant freeze: characterization tests that pin the CURRENT
// observable security contract of the JS membrane (web/sw.js,
// web/runtime-prelude.mjs, web/worker-prelude.js, web/zp-core.js). These tests
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
const readServiceWorker = () =>
  [
    read('web/sw.js'),
    read('web/sw/kernel.js'),
    read('web/sw/routes.js'),
    read('web/sw/transport.js'),
    read('web/sw/responses.js'),
  ].join('\n');
const readRuntime = () =>
  [
    read('web/runtime-prelude.mjs'),
    read('web/runtime/abi/artifact-masking.mjs'),
    read('web/runtime/abi/native-capture.mjs'),
    read('web/runtime/dynamic-code/facade.mjs'),
    read('web/runtime/dynamic-code/source.mjs'),
    read('web/runtime/dom/attributes.mjs'),
    read('web/runtime/facades/document.mjs'),
    read('web/runtime/facades/events.mjs'),
    read('web/runtime/facades/fingerprinting.mjs'),
    read('web/runtime/facades/history.mjs'),
    read('web/runtime/facades/location.mjs'),
    read('web/runtime/facades/navigator.mjs'),
    read('web/runtime/facades/storage.mjs'),
    read('web/runtime/frames/accessors.mjs'),
    read('web/runtime/frames/child-rewrite.mjs'),
    read('web/runtime/frames/messaging.mjs'),
    read('web/runtime/frames/policy.mjs'),
    read('web/runtime/frames/sandbox.mjs'),
    read('web/runtime/network/http.mjs'),
    read('web/runtime/network/websocket.mjs'),
    read('web/runtime/workers/facades.mjs'),
  ].join('\n');

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
    importScripts: (...urls) => {
      for (const url of urls) {
        if (String(url).includes('/zp/assets/sw-kernel.js')) {
          vm.runInContext(read('web/sw/kernel.js'), sandbox);
        }
        if (String(url).includes('/zp/assets/sw-routes.js')) {
          vm.runInContext(read('web/sw/routes.js'), sandbox);
        }
        if (String(url).includes('/zp/assets/sw-transport.js')) {
          vm.runInContext(read('web/sw/transport.js'), sandbox);
        }
        if (String(url).includes('/zp/assets/sw-responses.js')) {
          vm.runInContext(read('web/sw/responses.js'), sandbox);
        }
      }
    },
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
  const sw = readServiceWorker();
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
  const src = readRuntime();
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
  w.ZPHTTPRewriter = {};
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
    'ZPHTTPRewriter',
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
    'ZPHTTPRewriter',
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

function loadFilteredNamedNodeMap() {
  const src = readRuntime();
  const code = [
    'function attrLocalName(key) { const s = String(key || "").toLowerCase(); const i = s.indexOf(":"); return i >= 0 ? s.slice(i + 1) : s; }',
    extractFunction(src, 'eventAttrName'),
    extractFunction(src, 'eventDataAttrName'),
    extractFunction(src, 'eventAttributeFacade'),
    extractFunction(src, 'filteredNamedNodeMap'),
    extractFunction(src, 'filteredCollection'),
    'function isZPAttrName(name) { return String(name || "").toLowerCase().startsWith("data-zp-"); }',
    'function setEventAttribute(owner, name, value) { owner.lastEventSet = { name, value }; }',
    'function setNamedAttributeNode() { return null; }',
    'function removeNamedAttributeNode() { return null; }',
    'module.exports = { filteredNamedNodeMap };',
  ].join('\n\n');
  const sandbox = { module: { exports: {} }, Object, Proxy, String, Number, Symbol };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.module.exports.filteredNamedNodeMap;
}

function loadFilteredCollection() {
  const src = readRuntime();
  const code = `${extractFunction(src, 'filteredCollection')}\nmodule.exports = { filteredCollection };`;
  const sandbox = { module: { exports: {} }, Object, Proxy, String, Number, Symbol };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.module.exports.filteredCollection;
}

test('membrane: filtered DOM collections preserve native collection instanceof checks', () => {
  const filteredCollection = loadFilteredCollection();
  function FakeNodeList() {}
  const keep = { id: 'keep' };
  const hidden = { id: 'hide' };
  const raw = Object.create(FakeNodeList.prototype);
  raw[0] = hidden;
  raw[1] = keep;
  raw.length = 2;

  const filtered = filteredCollection(raw, (node) => node.id !== 'hide');

  assert.equal(filtered instanceof FakeNodeList, true);
  assert.deepEqual(Array.from(filtered), [keep]);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0], keep);
});

test('membrane: NamedNodeMap named lookup exposes masked event attrs without ZP backing attrs', () => {
  const filteredNamedNodeMap = loadFilteredNamedNodeMap();
  const owner = {};
  const backing = { name: 'data-zp-event-onsubmit', value: 'rewritten-internal-code' };
  const href = { name: 'href', value: '/home' };
  const raw = [backing, href];
  raw.length = 2;
  raw.getNamedItem = (name) =>
    raw.find((attr) => String(attr.name).toLowerCase() === String(name).toLowerCase()) || null;

  const filtered = filteredNamedNodeMap(raw, owner);
  const eventAttr = filtered.onsubmit;

  assert.equal(filtered.length, 1, 'hidden ZP backing attr must not count as visible');
  assert.equal(filtered.href, href, 'ordinary named attributes must remain reachable');
  assert.equal(
    filtered['data-zp-event-onsubmit'],
    undefined,
    'ZP event backing attr must stay hidden',
  );
  assert.equal(
    filtered.getNamedItem('onsubmit').name,
    'onsubmit',
    'property and getNamedItem agree',
  );
  assert.equal(eventAttr.name, 'onsubmit');
  assert.equal(
    eventAttr.value,
    '',
    'rewritten event handler source must not leak through Attr.value',
  );
  assert.equal(eventAttr.ownerElement, owner);
  assert.equal(
    'onsubmit' in filtered,
    true,
    'named event attr must participate in property existence',
  );

  eventAttr.value = 'next-source';
  assert.equal(owner.lastEventSet.name, 'onsubmit');
  assert.equal(owner.lastEventSet.value, 'next-source');
});

// DOM-enumeration filter: selectorTargetsZP is the pure gate that makes
// querySelector / querySelectorAll / matches / closest refuse ZP-artifact
// selectors. Extract and exercise it directly.
function loadSelectorFilter() {
  const src = readRuntime();
  const code = `${extractFunction(src, 'selectorTargetsZP')}\nmodule.exports = { selectorTargetsZP };`;
  const sandbox = { module: { exports: {} }, String };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.module.exports.selectorTargetsZP;
}

function loadEmptyNativeNodeList() {
  const src = readRuntime();
  const code = `${extractFunction(src, 'emptyNativeNodeList')}\nmodule.exports = { emptyNativeNodeList };`;
  const sandbox = { module: { exports: {} } };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.module.exports.emptyNativeNodeList;
}

test('membrane: blocked selector collections keep a native NodeList backing when possible', () => {
  const emptyNativeNodeList = loadEmptyNativeNodeList();
  const raw = { length: 0 };
  const owner = {};
  const out = emptyNativeNodeList(function querySelectorAll(selector) {
    this.selector = selector;
    return raw;
  }, owner);

  assert.equal(out, raw);
  assert.equal(owner.selector, ':not(*)');
  const fallback = emptyNativeNodeList(() => {
    throw new Error('native qsa unavailable');
  }, owner);
  assert.equal(Array.isArray(fallback), true);
  assert.equal(fallback.length, 0);
});

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

function loadTargetVisibleSelectorHarness() {
  const src = readRuntime();
  const attrRE = src.match(/const targetVisibleSelectorAttrRE = .*;/);
  assert.ok(attrRE, 'target-visible selector attribute regex must exist');
  const functions = [
    'filteredCollection',
    'filterSelectorOne',
    'selectorUsesTargetVisibleURL',
    'targetVisibleSelectorOne',
    'targetVisibleSelectorAll',
    'targetVisibleElementMatches',
    'targetVisibleClosest',
    'broadTargetVisibleSelector',
    'targetVisibleSelectorMatch',
    'visibleSelectorAttr',
    'targetVisibleAttrMatch',
  ]
    .map((name) => extractFunction(src, name))
    .join('\n');
  const code = `
    const Native = {
      getAttribute(attr) {
        return this.attrs && Object.prototype.hasOwnProperty.call(this.attrs, attr)
          ? this.attrs[attr]
          : null;
      }
    };
    function visibleSrcset(el) { return el.visibleSrcset || ''; }
    function visibleSrcdoc(el) { return el.visibleSrcdoc || Native.getAttribute.call(el, 'srcdoc') || ''; }
    function visibleNavigationURL(el, attr) { return el.visibleNavigation && el.visibleNavigation[attr] || Native.getAttribute.call(el, attr) || ''; }
    function visibleResourceURL(el, attr) { return el.visibleResource && el.visibleResource[attr] || Native.getAttribute.call(el, attr) || ''; }
    function usesRawURLAttribute(el, attr) { return !!(el.rawURLAttrs && el.rawURLAttrs.includes(attr)); }
    function isResourceURLAttribute(el, attr) { return !!(el.resourceURLAttrs && el.resourceURLAttrs.includes(attr)); }
    function isZPAssetNode(node) { return !!(node && node.zp); }
    ${attrRE[0]}
    ${functions}
    module.exports = {
      targetVisibleSelectorOne,
      targetVisibleSelectorAll,
      targetVisibleElementMatches,
      targetVisibleClosest,
      broadTargetVisibleSelector,
      targetVisibleSelectorMatch,
      targetVisibleAttrMatch,
      visibleSelectorAttr,
    };
  `;
  const sandbox = { module: { exports: {} }, Object, Proxy, String, Symbol };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.module.exports;
}

test('membrane: selector virtualization matches target-visible srcdoc and xlink:href values', () => {
  const selector = loadTargetVisibleSelectorHarness();
  const srcdocFrame = {
    nodeType: 1,
    localName: 'iframe',
    attrs: { srcdoc: '<script src="/zp/assets/runtime.js"></script>' },
    visibleSrcdoc: '<h1>Native Secret</h1><script src="/app.js"></script>',
    broadMatches: ['iframe[srcdoc]'],
  };
  const xlinkUse = {
    nodeType: 1,
    localName: 'use',
    attrs: { 'xlink:href': '/zp/p/route#k=abc' },
    visibleResource: { href: 'https://target.example/sprite.svg#icon' },
    broadMatches: ['use[xlink\\:href]'],
  };
  const zpAsset = {
    nodeType: 1,
    localName: 'script',
    zp: true,
    attrs: { src: '/zp/assets/runtime.js' },
  };
  const qsaSelectors = [];
  const root = {
    querySelectorAll(sel) {
      qsaSelectors.push(sel);
      return [srcdocFrame, xlinkUse, zpAsset];
    },
  };

  const srcdocMatches = selector.targetVisibleSelectorAll(
    root,
    'iframe[srcdoc*="Native Secret"]',
    root.querySelectorAll,
  );
  assert.equal(qsaSelectors.pop(), 'iframe[srcdoc]');
  assert.equal(srcdocMatches.length, 1);
  assert.equal(srcdocMatches[0], srcdocFrame);
  assert.equal(
    selector.targetVisibleSelectorOne(
      root,
      'iframe[srcdoc$="</script>"]',
      null,
      root.querySelectorAll,
    ),
    srcdocFrame,
  );

  const xlinkMatches = selector.targetVisibleSelectorAll(
    root,
    'use[xlink\\:href$="#icon"]',
    root.querySelectorAll,
  );
  assert.equal(qsaSelectors.pop(), 'use[xlink\\:href]');
  assert.equal(xlinkMatches.length, 1);
  assert.equal(xlinkMatches[0], xlinkUse);
  assert.equal(
    selector.visibleSelectorAttr(xlinkUse, 'xlink\\:href'),
    'https://target.example/sprite.svg#icon',
  );
});

test('membrane: selector virtualization applies URL operators across matches and closest', () => {
  const selector = loadTargetVisibleSelectorHarness();
  const frame = {
    nodeType: 1,
    localName: 'iframe',
    parentElement: null,
    attrs: { srcdoc: '<script src="/zp/assets/runtime.js"></script>' },
    visibleSrcdoc: '<main data-lang="en-US">primary secret </main>',
    broadMatches: ['iframe[srcdoc]'],
  };
  const child = {
    nodeType: 1,
    localName: 'span',
    parentElement: frame,
    attrs: {},
    broadMatches: [],
  };
  const nativeMatches = function (sel) {
    return this.broadMatches.includes(sel);
  };

  assert.equal(
    selector.targetVisibleElementMatches(frame, 'iframe[srcdoc^="<main"]', nativeMatches),
    true,
  );
  assert.equal(
    selector.targetVisibleElementMatches(frame, 'iframe[srcdoc~="secret"]', nativeMatches),
    true,
  );
  assert.equal(
    selector.targetVisibleClosest(child, 'iframe[srcdoc*="data-lang"]', null, nativeMatches),
    frame,
  );
  assert.equal(selector.targetVisibleAttrMatch('en-US', '|=', 'en'), true);
  assert.equal(selector.targetVisibleAttrMatch('bundle.module.js', '$=', '.js'), true);
  assert.equal(
    selector.targetVisibleAttrMatch(
      'HTTPS://TARGET.EXAMPLE/APP.JS',
      '^=',
      'https://target.example/',
      'i',
    ),
    true,
  );
});

test('membrane: selector virtualization hooks target-visible URL attributes', () => {
  const rt = readRuntime();
  for (const needle of [
    'targetVisibleSelectorOne',
    'targetVisibleSelectorAll',
    'targetVisibleElementMatches',
    'targetVisibleClosest',
    'broadTargetVisibleSelector',
    'targetVisibleSelectorMatch',
    'visibleSelectorAttr',
    'targetVisibleAttrMatch',
  ]) {
    assert.ok(rt.includes(needle), `missing ${needle}`);
  }
  assert.ok(rt.includes('visibleNavigationURL(el, attr)'));
  assert.ok(rt.includes('visibleResourceURL(el, attr)'));
  assert.ok(rt.includes('visibleSrcset(el)'));
  assert.match(rt, /href\|src\|action\|formaction\|poster\|srcset\|srcdoc\|xlink/);
  assert.ok(rt.includes("attr === 'srcdoc'"));
  assert.ok(rt.includes("attr === 'xlink:href'"));
  assert.ok(rt.includes('visibleSrcdoc(el)'));
  assert.ok(rt.includes('data-zp-target-srcdoc'));
});

test('membrane: stealth + masking hooks are installed into the runtime global', () => {
  const rt = readRuntime();
  // The installers exist and are invoked during membrane setup.
  assert.match(rt, /function installStealthMembrane\(w\)/);
  assert.match(rt, /function installOwnPropertyMasking\(w\)/);
  assert.match(rt, /installOwnPropertyMasking\(root\)/);
  assert.match(rt, /installStealthMembrane\(root\)/);
  // The stealth membrane overrides the live DOM enumeration surface so ZP asset
  // nodes are filtered out of getElementsByTagName / scripts / querySelectorAll.
  for (const needle of [
    "defineReplacingNative(w.Document.prototype, 'getElementsByTagName'",
    "defineReplacingNative(w.Element.prototype, 'getElementsByTagName'",
    "Object.defineProperty(w.Document.prototype, 'scripts'",
    "defineReplacingNative(w.Document.prototype, 'querySelectorAll'",
    "defineReplacingNative(w.Element.prototype, 'querySelectorAll'",
    "defineReplacingNative(w.Document.prototype, 'createTreeWalker'",
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
  assert.ok(worker.includes('installWorkerOwnPropertyMasking()'));
  assert.ok(worker.includes("defineMasked(Refl, 'ownKeys'"));
  assert.ok(worker.includes("defineMasked(Obj, 'getOwnPropertyDescriptor'"));
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

// ---------------------------------------------------------------------------
// Invariant 3c: connect-src confines egress to self + proxy WS + relay origins
//
// connect-src is the egress-confinement directive -- the ONLY allow-list of
// origins proxied content may open a connection to. buildConnectSrc gathers it
// from 'self', the proxy's own WebSocket origin, and every normalized relay
// origin (deduped). A regression that DROPPED a relay origin breaks the
// transport; one that leaked a wildcard or an unnormalized host breaches the
// no-direct-egress invariant. Every fixedCSP test above used empty servers and
// never exercised this gathering -- pin it behaviorally here.
// ---------------------------------------------------------------------------

test('membrane: fixedCSP connect-src confines to self + proxy WS + relay origins (deduped, no wildcard)', () => {
  const { ctx } = loadServiceWorker();
  // Collect ALL connect-src directives (parseCSPEntries preserves duplicates) and
  // require EXACTLY one. A smuggled `connect-src *; ...; connect-src 'self'` would
  // have the browser honor the wildcard FIRST directive -- a Map().get() would
  // collapse to the last and miss it. Assert single, then return its tokens.
  const connectOf = (servers, options) => {
    const entries = parseCSPEntries(ctx.ZP.fixedCSP(servers, options)).filter(
      ([name]) => name === 'connect-src',
    );
    assert.equal(entries.length, 1, 'fixedCSP must emit exactly one connect-src directive');
    return entries[0][1];
  };

  // Two distinct relay origins -> both present, after 'self' and the proxy WS origin.
  const two = connectOf(['wss://relay-a.example/p', 'wss://relay-b.example:8443/q']);
  assert.deepEqual(
    two,
    ["'self'", 'wss://proxy.example', 'wss://relay-a.example', 'wss://relay-b.example:8443'],
    'connect-src = self, proxy WS, then each relay origin in order',
  );

  // Same origin via two different paths -> deduped to a SINGLE origin token.
  assert.deepEqual(
    connectOf(['wss://relay-a.example/p1', 'wss://relay-a.example/p2']),
    ["'self'", 'wss://proxy.example', 'wss://relay-a.example'],
    'duplicate relay origins collapse to a single connect-src token',
  );

  // Never a bare wildcard, regardless of relay input.
  assert.equal(two.includes('*'), false, 'connect-src must never carry a bare wildcard');
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

test('membrane: event facade options & object listener support', () => {
  const src = fs.readFileSync('web/runtime/facades/events.mjs', 'utf8');
  const code =
    src.replace('export function createEventTargetFacade', 'function createEventTargetFacade') +
    '\ncreateEventTargetFacade;';
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const createEventTargetFacade = vm.runInContext(code, sandbox);

  const target = {};
  const ZPEventTarget = createEventTargetFacade({
    Native: {
      Map,
      String,
      Array: { from: Array.from },
      arrayFrom: Array.from,
      Object: { defineProperty: Object.defineProperty },
      objectDefineProperty: Object.defineProperty,
      Reflect: { apply: Reflect.apply },
      reflectApply: Reflect.apply,
    },
    define: (obj, name, fn) => {
      obj[name] = fn;
    },
    listenersKey: '__listeners',
  });
  ZPEventTarget.installEventMethods(target);

  // 1. once option
  let onceCount = 0;
  target.addEventListener(
    'once-test',
    () => {
      onceCount++;
    },
    { once: true },
  );
  target.dispatchEvent({ type: 'once-test' });
  target.dispatchEvent({ type: 'once-test' });
  assert.equal(onceCount, 1, 'once listener must fire exactly once');

  // 2. signal option
  let signalCount = 0;
  const controller = new AbortController();
  target.addEventListener(
    'signal-test',
    () => {
      signalCount++;
    },
    { signal: controller.signal },
  );
  target.dispatchEvent({ type: 'signal-test' });
  controller.abort();
  target.dispatchEvent({ type: 'signal-test' });
  assert.equal(signalCount, 1, 'signal-aborted listener must not fire after abort');

  // 3. handleEvent object listener
  let handleEventCount = 0;
  const listener = {
    handleEvent(e) {
      assert.equal(e.type, 'handle-event-test');
      handleEventCount++;
    },
  };
  target.addEventListener('handle-event-test', listener);
  target.dispatchEvent({ type: 'handle-event-test' });
  assert.equal(handleEventCount, 1, 'handleEvent listener must fire');
  target.removeEventListener('handle-event-test', listener);
  target.dispatchEvent({ type: 'handle-event-test' });
  assert.equal(handleEventCount, 1, 'handleEvent listener must not fire after removal');
});

test('membrane: direct Storage access via Proxy', () => {
  const src = fs.readFileSync('web/runtime/facades/storage.mjs', 'utf8');
  const code =
    src.replace('export function createStorageFacades', 'function createStorageFacades') +
    '\ncreateStorageFacades;';
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const createStorageFacades = vm.runInContext(code, sandbox);

  const storageMock = new Map();
  const ZPStorage = createStorageFacades({
    Native: {
      Array: { from: Array.from, isArray: Array.isArray },
      arrayFrom: Array.from,
      arrayIsArray: Array.isArray,
      JSON,
      Map,
      Number,
      Promise,
      Proxy,
      Set,
      String,
      Function: { prototype: { bind: Function.prototype.bind } },
      functionBind: Function.prototype.bind,
      Object: {
        assign: Object.assign,
        freeze: Object.freeze,
        getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
      },
      objectAssign: Object.assign,
      objectFreeze: Object.freeze,
      objectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
      Reflect: { apply: Reflect.apply },
      reflectApply: Reflect.apply,
      localStorage: {
        getItem(key) {
          return storageMock.get(key) || null;
        },
        setItem(key, val) {
          storageMock.set(key, val);
        },
      },
    },
    define: (obj, name, val) => {
      obj[name] = val;
    },
    defineAccessor: (obj, name, get, set) => {
      Object.defineProperty(obj, name, { get, set, configurable: true });
    },
    normalizedError: (msg) => new Error(msg),
    getVirtualURL: () => new URL('https://example.com/'),
  });

  const w = {
    indexedDB: {
      open() {
        return {};
      },
    },
    caches: {
      open() {
        return Promise.resolve({});
      },
    },
  };
  ZPStorage.installStorageFacades(w);

  const storage = w.localStorage;
  // Test direct property set
  storage.testkey = 'value';
  assert.equal(storage.getItem('testkey'), 'value');
  assert.equal(storage.testkey, 'value');

  // Test ownKeys
  assert.deepEqual(Object.keys(storage), ['testkey']);

  // Test property descriptor
  const desc = Object.getOwnPropertyDescriptor(storage, 'testkey');
  assert.ok(desc);
  assert.equal(desc.value, 'value');
  assert.equal(desc.enumerable, true);

  // Test direct property delete
  delete storage.testkey;
  assert.equal(storage.testkey, undefined);
  assert.equal(storage.getItem('testkey'), null);
  assert.deepEqual(Object.keys(storage), []);
});

test('membrane: generic Location setters & dispatcher', () => {
  const src = fs.readFileSync('web/runtime/facades/location.mjs', 'utf8');
  const code =
    src
      .replace('export function createLocationFacades', 'function createLocationFacades')
      .replace('function finalizeLocationFacade', 'function finalizeLocationFacade') +
    '\ncreateLocationFacades;';
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const createLocationFacades = vm.runInContext(code, sandbox);

  let virtualUrl = new URL('https://example.com/foo?q=1#hash');
  let setCalls = [];
  const ZPLocation = createLocationFacades({
    Native: {
      Symbol,
      URL,
      Object: {
        defineProperty: Object.defineProperty,
        freeze: Object.freeze,
        getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
      },
      objectDefineProperty: Object.defineProperty,
      objectFreeze: Object.freeze,
      objectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
    },
    getVirtualURL: () => virtualUrl,
    getVisibleURL: () => virtualUrl,
    setVirtualLocation: (v, replace) => {
      virtualUrl = new URL(v);
      setCalls.push({ v, replace });
    },
    updateVirtualHash: (v) => {
      virtualUrl.hash = v;
    },
    maskMethods: () => {},
    maskNativeFunction: () => {},
  });

  const { virtualLocation } = ZPLocation;

  assert.equal(virtualLocation.pathname, '/foo');
  assert.equal(virtualLocation.search, '?q=1');

  // Test setting search
  virtualLocation.search = '?q=2';
  assert.equal(virtualUrl.search, '?q=2');
  assert.equal(setCalls[setCalls.length - 1].v, 'https://example.com/foo?q=2#hash');

  // Test setting pathname
  virtualLocation.pathname = '/bar';
  assert.equal(virtualUrl.pathname, '/bar');
  assert.equal(setCalls[setCalls.length - 1].v, 'https://example.com/bar?q=2#hash');

  // Test setting protocol
  virtualLocation.protocol = 'http:';
  assert.equal(virtualUrl.protocol, 'http:');
  assert.equal(setCalls[setCalls.length - 1].v, 'http://example.com/bar?q=2#hash');

  // Now test the generic setter dispatch in runtime-prelude.mjs
  const preludeSrc = readRuntime();
  const codePrelude = [
    extractFunction(preludeSrc, 'isLocationAssign'),
    extractFunction(preludeSrc, 'set'),
    'module.exports = { isLocationAssign, set };',
  ].join('\n\n');
  const sandboxPrelude = {
    module: { exports: {} },
    isWindowLike: () => false,
    document: {},
    virtualLocation,
    setVirtualLocation: (v) => {
      virtualUrl = new URL(v);
    },
    updateVirtualHash: (v) => {
      virtualUrl.hash = v;
    },
    Native: {
      objectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
    },
    objectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
    reflectApply: Reflect.apply,
    reflectSet: Reflect.set,
    Object,
  };
  vm.createContext(sandboxPrelude);
  vm.runInContext(codePrelude, sandboxPrelude);
  const runtimeSet = sandboxPrelude.module.exports.set;

  runtimeSet(virtualLocation, 'search', '?q=3');
  assert.equal(virtualUrl.search, '?q=3');
});
