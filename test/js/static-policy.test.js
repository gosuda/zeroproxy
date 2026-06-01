const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('service worker has no unclassified native fetch fallback', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.equal(/return\s+fetch\s*\(\s*event\.request\s*\)/.test(sw), false);
  assert.match(sw, /event\.respondWith\(handleFetch\(event\)\)/);
});

test('runtime avoids stale escape gaps and forbidden harness markers', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  assert.ok(rt.includes('installToStringMasking'));
  assert.equal(rt.includes('Object.getOwnPropertyDescriptor ='), false);
  assert.equal(rt.includes('window.__zp'), false);
  assert.equal(rt.includes('queueMicrotask'), false);
  assert.ok(rt.includes('Function.prototype.toString'));
});

test('runtime reads boot config from inert JSON script', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  assert.ok(rt.includes("getElementById('__zp-boot')"));
  assert.ok(rt.includes('JSON.parse(el.textContent'));
  assert.ok(rt.includes('type="application/json"'));
  assert.equal(rt.includes('Object.defineProperty(window,"__ZP_BOOT"'), false);
});

test('runtime installs required escape-vector hooks', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  for (const needle of [
    "document.addEventListener('click'",
    "document.addEventListener('submit'",
    'HTMLFormElement.prototype',
    'popstate',
    'ZP_RESOLVE_ENTRY',
    'ZP_SCROLL_UPDATE',
    'runtimeToken',
    "define(w.document, 'createElement'",
    "define(w, 'open'",
    "'appendChild'",
    "'insertBefore'",
    "'replaceChild'",
    "'append'",
    "'prepend'",
    "'before'",
    "'after'",
    "'replaceWith'",
    "'insertAdjacentHTML'",
    "'getAttribute'",
    'installNetworkContainment',
    "'contentWindow'",
    "'contentDocument'",
    'new WeakSet',
    "attributeFilter: ['href', 'xlink:href', 'src', 'srcdoc', 'action', 'formaction', 'poster', 'integrity', 'type', 'rel', 'target']",
    'enforceObservedAttribute',
    'data-zp-integrity',
    'installIntegrityProp',
    'installScriptProp',
    'installLinkProp',
    'shouldBlockURLAttribute',
    'installToStringMasking',
    'toStringMap',
    'installCanvasAntiFingerprinting',
    'getImageData',
    'toDataURL',
    'installAudioAntiFingerprinting',
    'getChannelData',
    'speechSynthesis',
    'getVoices',
    'installStorageFacades',
    'localStorage',
    'indexedDB',
    'caches',
    'documentCookieString',
    "define(root, 'Worker'",
    "define(root, 'SharedWorker'",
    'workerBlobURLs',
    'dataWorkerURL',
    "'RTCPeerConnection'",
    "'WebTransport'",
    "'WebSocketStream'",
    // D6: getUserMedia / geolocation pass-through (browser consent gates them).
    'installPhase2Membrane',
    '__zp_runClassic',
    '__zp_get',
    '__zp_assign',
    'FunctionCtor',
    "define(root, 'setTimeout'",
    // document.write is wrapped at Document.prototype level (covers parent +
    // iframe realms in one shot) — see trap-notebook 2026-05-30 NAVER GFP fix.
    "define(docProto, 'write'",
    'createContextualFragment',
    'parseFromString',
    'rewriteEventAttribute',
    'enforceSubtreePolicies',
    'installTargetServiceWorkerBlocker',
    'serializeFormSubmission',
    'shareFragmentForKey',
    'postMessageWrapperFor',
  ]) assert.ok(rt.includes(needle), `missing ${needle}`);
});

test('service worker uses Rust kernel transport and cookie bridge', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  // Step 13: HTTP transport is Rust kernelFetch only; legacy Go __zp_kernel_init/wasm_exec.js removed.
  assert.ok(sw.includes('self.kernelFetch'), 'service worker must expose Rust kernelFetch transport');
  assert.ok(sw.includes('self.kernelStream'), 'service worker must expose Rust kernelStream for WebSocket bridging');
  assert.equal(sw.includes("importScripts('/zp/assets/wasm_exec.js')"), false, 'wasm_exec.js must not be imported (Go kernel removed)');
  assert.equal(sw.includes('__zp_kernel_init'), false, 'Go __zp_kernel_init must not be referenced');
  assert.equal(sw.includes('__zp_cookie_set'), false, 'Go __zp_cookie_set must not be referenced');
  assert.equal(sw.includes('__go_jshttp'), false, 'Go __go_jshttp must not be referenced');
  assert.equal(sw.includes('__zp_stream'), false, 'Go __zp_stream must not be referenced');
  // Cookie jar bridge: SW tab state → Cookie header + Set-Cookie capture.
  assert.match(sw, /headers\.set\('Cookie',\s*opt\.tab\.documentCookie\)/, 'cookie header must be attached to outgoing relay request');
  assert.match(sw, /mergeCookie\(opt\.tab\.documentCookie/, 'response Set-Cookie must be merged back into tab state');
  assert.ok(sw.includes('runtimeTabForMessage'), 'service worker does not gate runtime messages by tab');
  assert.ok(sw.includes('runtimeMessageAuthorized'), 'service worker does not validate runtime capability tokens');
  assert.ok(sw.includes('runtimeToken: ZP.randomId'), 'service worker does not generate runtime capability tokens');
  assert.ok(sw.includes('X-ZP-Runtime-Token'), 'service worker does not pass runtime capability to documents');
  // A2 hardening guards: firstTab() / defaultContext() multi-tab leak fallback must not return.
  assert.equal(/\bfirstTab\s*\(/.test(sw), false, 'SW must not call firstTab() — multi-tab leak');
  assert.equal(/function\s+firstTab\b/.test(sw), false, 'SW must not define firstTab()');
  assert.equal(/function\s+defaultContext\b/.test(sw), false, 'SW must not define defaultContext()');
  assert.match(sw, /if \(!source \|\| !source\.id\)/, 'runtimeMessageAuthorized must require non-null event.source');
  assert.ok(sw.includes('Target host:'), 'service worker error page does not expose target host');
});

test('Go WASM kernel is fully removed from the tree (Step 13)', () => {
  assert.equal(fs.existsSync('cmd/wasm-kernel'), false, 'cmd/wasm-kernel must be deleted');
  assert.equal(fs.existsSync('web/wasm_exec.js'), false, 'wasm_exec.js must not be in web/');
});

test('service worker response wrappers force nosniff', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.match(sw, /h\.set\('X-Content-Type-Options', 'nosniff'\)/);
  assert.match(sw, /'X-Content-Type-Options': 'nosniff'/);
});

test('phase 3 script rewriting pipeline is fail-closed', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  const core = fs.readFileSync('web/zp-core.js', 'utf8');
  const server = fs.readFileSync('cmd/zeroproxy-server/main.go', 'utf8');
  const csp = fs.readFileSync('internal/headers/csp.go', 'utf8');
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  assert.ok(sw.includes("importScripts('/zp/assets/rust-rewriter.js')"));
  assert.equal(sw.includes("importScripts('/zp/assets/js-rewriter.js')"), false);
  assert.equal(sw.includes("importScripts('/zp/assets/oxc-parser.js')"), false);
  assert.ok(sw.includes('/zp/api/script'));
  assert.ok(sw.includes('rewriteScriptResponse'));
  assert.ok(build.includes('rewriter-rs'));
  assert.ok(build.includes('wasm-bindgen'));
  assert.ok(build.includes('ZPRewriter'));
  assert.ok(build.includes('ZPRustRewriter'));
  assert.ok(build.includes('phase3-rust-wasm-ast-3-css'));
  assert.ok(build.includes('cargoBinPath'));
  assert.ok(fs.existsSync('rewriter-rs/Cargo.toml'), 'Rust rewriter manifest missing');
  assert.ok(fs.existsSync('rewriter-rs/src/lib.rs'), 'Rust rewriter AST walker missing');
  assert.equal(fs.existsSync('web/js-rewriter.js'), false);
  assert.equal(fs.existsSync('web/oxc-parser.js'), false);
  assert.equal(fs.existsSync('web/oxc_parser_wasm_bg.wasm'), false);
  assert.equal(fs.existsSync('web/wasm_exec.js'), false);
  assert.match(rt, /setAttributeNS/);
  assert.match(rt, /NamedNodeMap/);
  assert.match(rt, /Attr\.prototype/);
  // A3 hardening: blob: URLs must be blocked for script/iframe/frame/embed/object.
  assert.ok(rt.includes('hasContextBlockedScheme'), 'runtime must define context-aware blob:/data: blocker');
  assert.match(rt, /tag === 'script' \|\| tag === 'iframe' \|\| tag === 'frame' \|\| tag === 'embed' \|\| tag === 'object'/, 'blob: must be blocked for code-loading tags');
  // Empty MIME type still routed through worker bootstrap wrapper.
  assert.ok(rt.includes('application\\/octet-stream|^$'), 'createObjectURL must catch empty-MIME blob workers');
  // ServiceWorker.register must reject (target sites cannot install rogue SWs).
  assert.match(rt, /navigator\.serviceWorker.+register.+Promise\.reject/, 'navigator.serviceWorker.register must be neutralized');
  // B3 (foreground): dynamic compilation is rewritten/scoped, not blocked.
  // The runtime wraps eval/Function/Async/Generator constructors so their
  // bodies execute in a `with(__zp_scope){...}` envelope where dangerous
  // globals resolve to membrane wrappers. Verify the dynamic-rewrite primitives:
  assert.ok(rt.includes('dynamicEval'), 'dynamicEval wrapper missing');
  assert.ok(rt.includes('dynamicFunction'), 'dynamicFunction wrapper missing');
  assert.ok(rt.includes('compileScoped'), 'compileScoped helper missing');
  assert.ok(rt.includes('compileDynamic'), 'compileDynamic helper missing');
  assert.ok(rt.includes('with(__zp_scope)'), 'scope envelope missing in dynamic compile');
  assert.ok(rt.includes("(async function(){}).constructor"), 'AsyncFunction constructor must be enumerated');
  assert.ok(rt.includes("(function*(){}).constructor"), 'GeneratorFunction constructor must be enumerated');
  assert.equal(/connect-src\s+\*/.test(core), false);
  assert.ok(core.includes("connect-src "));
  assert.equal(/script-src \*/.test(core), false);
  assert.equal(/script-src \*/.test(csp), false, 'Go CSP must not allow script-src wildcard');
  assert.equal(/connect-src\s+\*/.test(csp), false, 'Go CSP must not allow connect-src wildcard');
  assert.match(csp, /connect-src 'self'/, 'Go CSP must restrict connect-src to self + ws');
  assert.ok(server.includes('headers.BuildCSP'), 'server must delegate CSP to shared headers.BuildCSP');
  assert.equal(core.includes('navigate-to'), false);
  assert.equal(csp.includes('navigate-to'), false);
  assert.ok(sw.includes('MAX_REQUEST_BODY_BYTES'));
  assert.ok(sw.includes('pendingSubmissions'));
  assert.ok(sw.includes('ZP_SUBMIT_PREPARE'));
  assert.ok(sw.includes('zp_submit'));
  assert.ok(sw.includes('REQUEST_BODY_TOO_LARGE'));
  assert.ok(fs.readFileSync('internal/shareurl/shareurl.go', 'utf8').includes('unsupported target URL'));
  assert.ok(server.includes('closeBoth'));
});

test('service worker names every required safe error class', () => {
  const core = fs.readFileSync('web/zp-core.js', 'utf8');
  for (const code of ['BAD_HMAC','INVALID_SHARE_LINK','MALFORMED_ROUTE','SW_NOT_READY','TARGET_PROTOCOL_BLOCKED','TLS_CERTIFICATE_INVALID','TLS_HANDSHAKE_FAILED','TARGET_CONNECT_FAILED','MALFORMED_HTML','REALM_INJECTION_FAILURE','REQUEST_BODY_TOO_LARGE','SUBMISSION_EXPIRED','POLICY_BLOCKED','REWRITE_FAILED','SCRIPT_SRC_BLOCKED','REDIRECT_BODY_NONREPLAYABLE','WS_BLOCKED','RTC_GATEWAY_UNAVAILABLE','WT_UNSUPPORTED']) {
    assert.ok(core.includes(code), `missing ${code}`);
  }
  // A5: each code must have human-readable info.
  assert.ok(core.includes('ERROR_INFO'), 'ERROR_INFO map missing');
  assert.ok(core.includes('errorInfo'), 'errorInfo() helper missing');
});

// Pins the JS-side fixedCSP armed projection: when called with
// { challengeCompat: true } it must add https://challenges.cloudflare.com to
// exactly four directives (script/frame/child/connect-src) and nothing else.
// Default options must leave the legacy output byte-identical.
test('fixedCSP options.challengeCompat adds CF host only to four directives', () => {
  const code = fs.readFileSync('web/zp-core.js', 'utf8');
  // The implementation reads options.challengeCompat and gates a `cf` constant.
  assert.match(code, /options\s+&&\s+options\.challengeCompat/, 'fixedCSP must accept options.challengeCompat');
  assert.match(code, /https:\/\/challenges\.cloudflare\.com/, 'CF challenge host literal missing');
  // Off path (legacy signature) must not leak the CF host string. Reading the
  // function as text means it WILL contain the literal in source — the runtime
  // check below covers the actual emit. Confirm the if-armed gate exists.
  assert.match(code, /armed\s*\?\s*cf\s*:\s*''/, 'armed projection must be gated by armed ternary');

  // Evaluate fixedCSP in a vm sandbox to assert the actual emit.
  const vm = require('node:vm');
  const sandbox = {
    globalThis: undefined,
    crypto: { getRandomValues: () => new Uint8Array(12) },
    URL: URL,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    Set: Set,
    Map: Map,
    self: undefined,
    console: console,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code + '\n;this.__zp = self.ZP;', sandbox);
  const ZP = sandbox.__zp;
  assert.ok(ZP && typeof ZP.fixedCSP === 'function', 'ZP.fixedCSP must be exported');

  const off = ZP.fixedCSP([]);
  const on = ZP.fixedCSP([], { challengeCompat: true });
  assert.equal(off.includes('https://challenges.cloudflare.com'), false, 'off path must not contain CF host');
  const cfCount = (on.match(/https:\/\/challenges\.cloudflare\.com/g) || []).length;
  assert.equal(cfCount, 4, `armed CSP must mention CF host exactly 4 times, got ${cfCount}:\n${on}`);
  assert.ok(on.includes("script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://challenges.cloudflare.com"));
  assert.ok(on.includes('frame-src \'self\' blob: data: https://challenges.cloudflare.com'));
  assert.ok(on.includes('child-src \'self\' blob: data: https://challenges.cloudflare.com'));
  assert.match(on, /connect-src [^;]*https:\/\/challenges\.cloudflare\.com/);
  // Untouched directives must NOT gain the host.
  assert.equal(/style-src[^;]*https:\/\/challenges\.cloudflare\.com/.test(on), false);
  assert.equal(/img-src[^;]*https:\/\/challenges\.cloudflare\.com/.test(on), false);
  assert.equal(/worker-src[^;]*https:\/\/challenges\.cloudflare\.com/.test(on), false);
});

// Pins the SW two-signal challenge-compat plumbing: per-tab arm state + the
// X-ZP-Challenge-Compat response marker MUST be read-and-stripped before the
// proxied page sees it, and the request-side X-ZP-Arm-Challenge-Compat header
// must be sent when the tab is armed.
test('service worker plumbs challenge-compat arm + strips response marker', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.match(sw, /tab\.challengeCompat/, 'SW must persist per-tab challengeCompat flag');
  assert.match(sw, /createTab\(.*challengeCompat\)/, 'createTab must accept challengeCompat from ZP_OPEN_SHARE');
  assert.match(sw, /X-ZP-Arm-Challenge-Compat/, 'SW must emit per-tab arm request header');
  assert.match(sw, /h\.delete\('X-ZP-Challenge-Compat'\)/, 'addCSP must strip response marker (B4 obligation)');
  assert.match(sw, /challengeCompat:\s*armedHere/, 'CSP must be armed only when both signals hold');
});

// Pins the Go side: relay extracts the arm header, strips the x-zp-* range
// before forwarding, classifies via headers.IsChallengeDocument, and only
// emits X-ZP-Challenge-Compat: 1 when both signals hold.
test('Go relay implements two-signal challenge gate', () => {
  const relay = fs.readFileSync('cmd/zeroproxy-server/relay.go', 'utf8');
  assert.match(relay, /armedChallengeRequestHeader\s*=\s*"X-ZP-Arm-Challenge-Compat"/);
  assert.match(relay, /armedChallengeResponseHeader\s*=\s*"X-ZP-Challenge-Compat"/);
  assert.match(relay, /maybeApplyChallengeMarker/);
  assert.match(relay, /headers\.IsChallengeDocument/);
  // Used in BOTH bridgeRelayWS and bridgeMuxRelayWS code paths.
  const armedReads = relay.match(/armedChallenge\s*=\s*strings\.TrimSpace\(kv\[1\]\)\s*==\s*"1"/g) || [];
  assert.ok(armedReads.length >= 2, `armedChallenge must be wired in both relay paths, got ${armedReads.length}`);
});

// Pins the membrane sandbox virtualization: target sites that fingerprint
// iframe.sandbox containing both allow-scripts and allow-same-origin must see
// the virtualized value while the real DOM has no sandbox attribute (membrane
// already isolates the iframe).
test('runtime virtualizes dangerous sandbox attribute combinations on iframes', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  assert.match(rt, /const\s+frameSandboxMeta\s*=\s*new\s+WeakMap\(\)/);
  assert.match(rt, /function\s+frameSandboxAllowsEscape\(/);
  assert.match(rt, /tokens\.has\('allow-scripts'\)\s*&&\s*tokens\.has\('allow-same-origin'\)/);
  assert.match(rt, /function\s+setFrameSandboxAttribute\(/);
  assert.match(rt, /function\s+sanitizeFrameSandbox\(/);
  assert.match(rt, /function\s+isFrameElement\(/);
  // Hook coverage: setAttribute, setAttributeNS, getAttribute, hasAttribute,
  // removeAttribute, getAttributeNames, enforceObservedAttribute,
  // prepareActivatingNode (insertion).
  assert.match(rt, /localKey === 'sandbox' && isFrameElement\(this\)\) return setFrameSandboxAttribute/);
  assert.match(rt, /key === 'sandbox' && isFrameElement\(this\) && frameSandboxMeta\.has/);
  assert.match(rt, /localKey === 'sandbox' && isFrameElement\(el\)\) \{ sanitizeFrameSandbox/);
});

test('D7: per-target-origin storage isolation surfaces', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  // localStorage/sessionStorage wrap native storage with origin-hashed prefix.
  assert.match(rt, /function prefixedStorage\(native, prefix\)/, 'prefixedStorage helper missing');
  assert.match(rt, /localPrefix = 'zp:l:'/, 'localStorage prefix missing');
  assert.match(rt, /sessionPrefix = 'zp:s:'/, 'sessionStorage prefix missing');
  // Cross-target isolation primitives.
  assert.match(rt, /BroadcastChannel.+bcPrefix/s, 'BroadcastChannel must be prefixed');
  assert.match(rt, /SharedWorker.+sharedWorkerPrefix/s, 'SharedWorker must be prefixed');
  // document.origin / document.domain / window.origin virtualised.
  assert.match(rt, /Document\.prototype, 'origin'/, 'Document.prototype.origin getter missing');
  assert.match(rt, /document, 'domain'/, 'document.domain getter/setter missing');
  assert.match(rt, /w, 'origin'/, 'window.origin getter missing');
});

test('A5: styled ZeroProxy error page in safeError', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.ok(sw.includes('zp-shell'), 'styled error page wrapper missing');
  assert.ok(sw.includes('zp-title'), 'styled error page title element missing');
  assert.ok(sw.includes('zp-code'), 'styled error page code badge missing');
  assert.ok(sw.includes('Technical details'), 'technical details disclosure missing');
  assert.ok(sw.includes('ZP.errorInfo'), 'safeError must consult ZP.errorInfo for human strings');
});

test('SW wires Rust zp-bundle alongside JS rewriter', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  // Lazy import: SW source references the bundle URL, loaded inside
  // initBundle() rather than at top level so registration stays fast and
  // SW eval doesn't fault on a missing artifact during dev iterations.
  assert.ok(sw.includes("'/__zp/zp_bundle_sw.js'"), 'SW must reference Rust bundle no-modules glue URL');
  assert.ok(sw.includes('initBundle'), 'initBundle() helper missing');
  assert.ok(sw.includes('self.ZPBundle'), 'self.ZPBundle export missing');
  assert.ok(sw.includes('zp_bundle_sw_bg.wasm'), 'bundle wasm URL must be referenced');
  assert.ok(sw.includes('self.ZPBundleWBG'), 'must consume wasm-bindgen IIFE export');
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  assert.ok(build.includes("'--target', 'no-modules'"), 'build must produce no-modules variant for SW');
  assert.ok(build.includes('zp_bundle_sw'), 'build must emit zp_bundle_sw artifacts');
  assert.ok(build.includes('ZPBundleWBG'), 'build must wrap glue in IIFE exposing ZPBundleWBG');
});

test('D1: javascript: URL routing client-side handler', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  assert.ok(rt.includes('data-zp-jsurl'), 'runtime must dispatch data-zp-jsurl attribute');
  assert.ok(rt.includes('runJSURL'), 'runJSURL helper missing');
  assert.ok(rt.includes('Native.FunctionCtor'), 'rewritten body must use prelude-private FunctionCtor');
});

test('active browsing emits only encrypted prefixed p routes', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  assert.equal(sw.includes('/v/'), false, 'service worker must not produce legacy /v routes');
  assert.equal(rt.includes('/v/'), false, 'runtime must not produce legacy /v routes');
  assert.ok(sw.includes('PROXY_DOCUMENT'), 'service worker must handle /zp/p documents');
  assert.ok(rt.includes('makeShareURL'), 'runtime navigation must use encrypted /p share URLs');
});
