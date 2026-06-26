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
  // Cookie jar bridge: SW tab state → URL-scoped (RFC 6265) Cookie
  // header + Set-Cookie capture. The flat `tab.documentCookie` string
  // approach was replaced (2026-06-02) by `tab.cookieJar` (a port of
  // internal/cookiejar/jar.go) to stop cross-subdomain cookie leakage
  // and to preserve login state across back/forward navigation between
  // mail.naver.com / pay.naver.com / nid.naver.com / www.naver.com.
  assert.ok(sw.includes('createCookieJar'), 'service worker must define RFC 6265 cookie jar factory');
  // The outgoing-cookie path used to read `opt.url` (undefined — the
  // bug-fixed 2026-06-02 entry), and now reads the local `u` URL object
  // built from the positional `targetUrl` arg. Match either form so a
  // future rename doesn't silently re-introduce the regression.
  assert.match(
    sw,
    /opt\.tab\.cookieJar[\s\S]{0,300}cookieHeader\((u|opt\.url|targetUrl)\)/,
    'outgoing Cookie header must come from URL-scoped jar lookup',
  );
  assert.match(
    sw,
    /opt\.tab\.cookieJar[\s\S]{0,300}setCookieLine\((u|opt\.url|targetUrl)/,
    'response Set-Cookie must be fed into jar scoped to the response URL',
  );
  assert.match(sw, /cookieJar\.documentCookieFor\(entry\.targetUrl\)/, 'boot config must expose only cookies that match the target URL');
  assert.equal(sw.includes('mergeCookie('), false, 'flat mergeCookie shim must be removed (RFC-6265 jar replaces it)');
  assert.equal(/tab\.documentCookie\s*=/.test(sw), false, 'tab.documentCookie flat-string state must be removed');
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
  // 2026-06-08 split-bundle (c.1) Step 4: rewriter-rs/ deleted. SW realm
  // loads the modern bundle via `importScripts('/__zp/zp_bundle_sw.js')`
  // (and the runtime-prelude tags are emitted by sw.js's prelude injector).
  assert.equal(sw.includes("importScripts('/zp/assets/rust-rewriter.js')"), false, 'legacy rewriter importScripts must be gone');
  assert.equal(sw.includes("importScripts('/zp/assets/js-rewriter.js')"), false);
  assert.equal(sw.includes("importScripts('/zp/assets/oxc-parser.js')"), false);
  assert.match(sw, /importScripts\('\/__zp\/zp_bundle_sw\.js'\)/, 'SW must import the modern bundle glue');
  assert.ok(sw.includes('/zp/api/script'));
  assert.ok(sw.includes('rewriteScriptResponse'));
  assert.equal(build.includes('rewriter-rs'), false, 'build must not reference deleted rewriter-rs/ crate');
  assert.ok(build.includes('wasm-bindgen'));
  assert.equal(fs.existsSync('rewriter-rs/Cargo.toml'), false, 'rewriter-rs/ crate must be deleted');
  assert.equal(fs.existsSync('rewriter-rs/src/lib.rs'), false, 'rewriter-rs/ crate must be deleted');
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
  // D3: ServiceWorker facade is "fail soft" — register/ready/getRegistration
  // resolve to a fake registration so target code doesn't crash on the
  // SW-init code path, but no real SW controls the origin. The line that
  // patches the NATIVE Navigator.prototype.serviceWorker.register is still
  // a security backstop (target can't reach a real SW via prop-accessor
  // hop) and must keep rejecting.
  assert.match(rt, /navigator\.serviceWorker.+register.+Promise\.reject/, 'native navigator.serviceWorker.register must remain a hard-reject backstop');
  // Facade fail-soft surface — register/ready/getRegistration resolve, but
  // controller stays null so no real SW takes over the origin.
  assert.match(rt, /facade,\s*'register',\s*function register\(\)\s*\{\s*return Promise\.resolve\(fakeReg\)/, 'facade.register must resolve to fakeReg');
  assert.match(rt, /defineAccessor\(facade,\s*'ready',\s*\(\)\s*=>\s*readyPromise\)/, 'facade.ready must resolve');
  assert.match(rt, /defineAccessor\(facade,\s*'controller',\s*\(\)\s*=>\s*null\)/, 'facade.controller must remain null (no real SW on origin)');
  // SyncManager / PeriodicSyncManager / PushManager / navigationPreload stubs.
  assert.match(rt, /syncMgr.+'register'.+Promise\.resolve/, 'SyncManager.register must resolve');
  assert.match(rt, /periodicSyncMgr.+'register'.+Promise\.resolve/, 'PeriodicSyncManager.register must resolve');
  assert.match(rt, /pushMgr.+'subscribe'.+Promise\.reject\(normalizedError\('NotAllowedError'\)\)/, 'PushManager.subscribe must reject NotAllowedError (graceful denied-permission shape)');
  assert.match(rt, /navPreload.+'enable'.+Promise\.resolve/, 'navigationPreload.enable must resolve');
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

// C4: in-memory LRU cache for rewritten script bodies. We can't actually
// invoke the SW pipeline from this Node test (no fetch/crypto.subtle/WASM
// harness), but we can pin the source-level invariants that prevent
// regressions:
//   1. cache helpers exist and are wired into rewriteScriptResponse
//   2. cache key mixes transformer version, kind, target URL, and source
//      length-prefixed (so two distinct inputs cannot field-boundary collide)
//   3. fail-closed block stubs are NEVER cached (cacheSet is gated on
//      the success branch only)
//   4. entry / byte caps exist and LRU eviction is in place
test('service worker rewrite cache enforces strict invariants', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.ok(sw.includes('REWRITE_CACHE_MAX_ENTRIES'), 'entry cap constant missing');
  assert.ok(sw.includes('REWRITE_CACHE_MAX_BYTES'), 'byte cap constant missing');
  assert.ok(sw.includes('rewriteCacheGet'), 'cache get helper missing');
  assert.ok(sw.includes('rewriteCacheSet'), 'cache set helper missing');
  assert.ok(sw.includes('rewriteCacheKey'), 'cache key helper missing');
  assert.match(sw, /SHA-256/);
  assert.match(sw, /rewriteCacheTransformerVersion/);
  // Block stub never cached — rewriteCacheSet must only fire in the
  // success branch (after a non-empty `code` is produced). After D2
  // landed, the success branch also appends the sourceMappingURL, so
  // the cache-set is now nested inside an `if (cacheKey)` under the
  // outer `else` — match both forms.
  assert.match(
    sw,
    /(?:else if \(cacheKey\)|if \(cacheKey\))\s*\{[\s\S]*?rewriteCacheSet\(cacheKey, code\)/,
  );
  // LRU eviction loop exists.
  assert.match(sw, /rewriteCache\.size > REWRITE_CACHE_MAX_ENTRIES \|\| rewriteCacheBytes > REWRITE_CACHE_MAX_BYTES/);
  // Cap values per plan C4 (200 entries / 50MB).
  assert.match(sw, /REWRITE_CACHE_MAX_ENTRIES\s*=\s*200/);
  assert.match(sw, /REWRITE_CACHE_MAX_BYTES\s*=\s*50\s*\*\s*1024\s*\*\s*1024/);
});

// C2: malformed HTML must fail-closed to the styled MALFORMED_HTML page,
// NOT fall open with the raw HTML body. Falling open would let target
// inline scripts execute UN-rewritten — exactly the strict-mode escape
// the "no-escape jail" design forbids.
test('transformDocumentResponse fails closed on malformed HTML (no raw passthrough)', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  // Success tracking exists.
  assert.ok(sw.includes('transformOk'), 'transformOk success flag missing');
  assert.ok(sw.includes('transformFailure'), 'transformFailure diagnostic field missing');
  // Successful transform sets transformOk = true.
  assert.match(sw, /transformed = out;\s*transformOk = true;/);
  // Failure path is fail-closed: returns the styled MALFORMED_HTML page,
  // never `transformed = html` (which would ship raw body unrewritten).
  assert.match(sw, /if \(!transformOk\) \{[\s\S]*?return safeError\('MALFORMED_HTML', 502, targetUrl\)/);
  // No fail-open recovery shortcut anywhere in transformDocumentResponse.
  assert.equal(/transformed = html;\s*\/\/ Fail-open/.test(sw), false, 'fail-open comment must be gone');
});

// B4: EventSource fidelity. WHATWG SSE §9.2 — auto-reconnect after a soft
// transport error, with `Last-Event-ID` echoed on every reconnect and the
// server-supplied `retry:` interval applied. Wrong Content-Type / non-2xx
// is a hard fail (no reconnect). HTTP 204 closes cleanly.
test('EventSource wrapper enforces SSE auto-reconnect + Last-Event-ID fidelity', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  // Reconnect plumbing exists.
  assert.ok(rt.includes('scheduleReconnect'), 'scheduleReconnect helper missing');
  assert.ok(rt.includes('DEFAULT_RECONNECT_MS'), 'default reconnect interval constant missing');
  assert.match(rt, /DEFAULT_RECONNECT_MS\s*=\s*3000/, 'default reconnect interval must match WHATWG spec (3000 ms)');
  // Last-Event-ID echo on reconnect.
  assert.match(rt, /headers\.push\(\['Last-Event-ID', es\._lastEventId\]\)/, 'Last-Event-ID header missing on reconnect');
  // retry: field updates reconnect interval (digit-string only).
  assert.match(rt, /field === 'retry'/);
  assert.match(rt, /\/\^\\d\+\$\/\.test\(value\)/);
  // Content-Type validation (text/event-stream) is enforced.
  assert.match(rt, /\/\^text\\\/event-stream\\b\/i\.test\(ct\)/);
  // 204 → clean close, no reconnect.
  assert.match(rt, /resp\.status === 204[\s\S]*?readyState = CLOSED;\s*return;/);
  // close() short-circuits an armed reconnect timer.
  assert.match(rt, /if \(this\._reconnectTimer\) \{[\s\S]*?clearTimeout\(this\._reconnectTimer\)/);
  // Per-attempt AbortController so a prior abort doesn't poison the next fetch.
  assert.match(rt, /es\._controller = new AbortController\(\);\s*runEventSource\(es\)/);
});

// C1: WebSocket boundary fidelity. The kernel transport is currently a
// stub so we cannot exercise round-trip from Node — but we CAN pin the
// invariants that prevent regressions:
//   1. close() validates code (RFC 6455 §7.4: 1000 or [3000,4999]) and
//      reason byte length (≤123 UTF-8 bytes)
//   2. negotiated sub-protocol is checked against the offered list both
//      page-side and SW-side (§4.2.2)
//   3. bufferedAmount accessor exists (read-only getter)
//   4. binaryType setter enforces 'blob' | 'arraybuffer' enum (silently
//      ignores invalid — matches browser behavior)
//   5. fail() preserves a user-requested close code instead of always
//      clobbering with 1006
test('WebSocket wrapper enforces RFC 6455 close + protocol fidelity', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  // 1. Close code/reason validation helpers exist and are invoked.
  assert.ok(rt.includes('validateCloseCode'), 'validateCloseCode helper missing');
  assert.ok(rt.includes('validateReason'), 'validateReason helper missing');
  // 1000 is the only allowed code outside [3000, 4999].
  assert.match(rt, /n !== 1000 && \(n < 3000 \|\| n > 4999\)/);
  // Reason byte-length cap = 123.
  assert.match(rt, /len > 123/);
  // 2. Sub-protocol selection enforced on both ends.
  assert.match(rt, /plist\.indexOf\(negotiated\) < 0/, 'page-side sub-protocol check missing');
  assert.match(sw, /requestedProtocols\.indexOf\(negotiated\) < 0/, 'SW-side sub-protocol check missing');
  // SW must also re-validate the token shape (defense in depth).
  assert.match(sw, /!\/\^\[\!#\$%&'\*\+\\-\.\^_`\|~0-9A-Za-z\]\+\$\/\.test\(p\)/);
  // 3. bufferedAmount is a getter (read-only per IDL).
  assert.match(rt, /Object\.defineProperty\(ZPWebSocket\.prototype, 'bufferedAmount'/);
  assert.match(rt, /get\(\) \{ return this\._bufferedAmount \| 0; \}/);
  // 4. binaryType setter accepts only 'blob' | 'arraybuffer'.
  assert.match(rt, /Object\.defineProperty\(ZPWebSocket\.prototype, 'binaryType'/);
  assert.match(rt, /s === 'blob' \|\| s === 'arraybuffer'/);
  // 5. fail() preserves a user-requested close code if the page already
  //    asked for a clean close before the transport died.
  assert.match(rt, /const code = ws\._closingCode \|\| 1006/);
  // SW close handler forwards code+reason (transport stub still gets the
  // chance to surface them when wired).
  assert.match(sw, /close: \(code, reason\) =>[\s\S]*?type: 'close', code: code \|\| 1000, reason: reason \|\| ''/);
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
// The relay was reworked: the Rust kernel `transport::fetch::fetch` is now the
// active upstream path (the Go `relay.go` shim was retired during the Step-14
// client-TLS cutover). The two-signal challenge-compat gate is enforced in the
// Rust kernel via the same `zp_shared::is_challenge_document` predicate the Go
// `internal/headers/ApplyChallengeCompat` uses (parity via shared golden
// fixtures). The Go helper stays in-tree as a defense-in-depth utility, but
// the live wire-up is Rust-side.
test('Rust kernel implements two-signal challenge gate', () => {
  const fetchRs = fs.readFileSync('crates/zp-kernel-bundle/src/kernel/transport/fetch.rs', 'utf8');
  // armed flag threaded through fetch() + build_js_response().
  assert.match(fetchRs, /armed_challenge_compat: bool/, 'fetch() must accept armed flag');
  assert.match(
    fetchRs,
    /zp_shared::is_challenge_document\(cf,\s*&host,\s*&path\)/,
    'response builder must consult zp_shared::is_challenge_document',
  );
  assert.match(
    fetchRs,
    /headers\.append\("X-ZP-Challenge-Compat",\s*"1"\)/,
    'response builder must emit the marker only via Headers.append',
  );
  // Two-signal gate: emission is gated on the armed flag being true.
  assert.match(fetchRs, /if armed_challenge_compat \{/, 'emission must be inside the armed-only branch');

  // Request-side capture-before-strip in kernel/mod.rs.
  const modRs = fs.readFileSync('crates/zp-kernel-bundle/src/kernel/mod.rs', 'utf8');
  assert.match(modRs, /let mut armed_challenge_compat = false;/);
  assert.match(modRs, /"x-zp-arm-challenge-compat"\s*=>/);
  assert.match(modRs, /armed_challenge_compat = true;/);
  // Threading: fetch() call must pass the flag.
  assert.match(
    modRs,
    /transport::fetch::fetch\([\s\S]*?armed_challenge_compat,[\s\S]*?\)/,
    'kernel_fetch must thread armed flag into transport::fetch::fetch',
  );

  // Defense-in-depth Go helper still exists and is unit-tested for parity.
  const goHelper = fs.readFileSync('internal/headers/challenge.go', 'utf8');
  assert.match(goHelper, /func ApplyChallengeCompat\(header http\.Header, armed bool, finalURL \*url\.URL\)/);
  assert.match(goHelper, /TargetIsChallengeDocument\(header, finalURL\)/);
});

// 2026-06-13 yamux transport throughput fix — NAVER 메인 같은 image-heavy
// 페이지의 28+ 동시 다운로드가 단일 WS/yamux 세션 throughput 붕괴로 ~243s
// 동시 stall 하던 회귀 (real Chrome 측정). Rust kernel split_send_size
// 16KB→256KB + Go relay MaxStreamWindowSize 256KB→16MB.
test('yamux transport throughput is tuned for concurrent downloads (split_send_size + MaxStreamWindowSize)', () => {
  const yamuxRs = fs.readFileSync('crates/zp-kernel-bundle/src/kernel/transport/yamux.rs', 'utf8');
  assert.match(yamuxRs, /set_split_send_size\(256 \* 1024\)/, 'Rust kernel must raise yamux split_send_size to 256 KiB');
  const sessionGo = fs.readFileSync('internal/yamuxconn/session.go', 'utf8');
  assert.match(sessionGo, /MaxStreamWindowSize = 16 \* 1024 \* 1024/, 'Go relay must raise yamux MaxStreamWindowSize to 16 MiB');
  assert.match(sessionGo, /func tunedConfig\(\)/, 'both Client and Server must share the tuned config');
});

// 2026-06-13 NAVER "정확히 60s" first-request stall 의 ROOT CAUSE 수정.
// relay 바이트-트레이스로 결정적 규명: www.naver.com 은 본문(압축 ~44KB)을
// ~167ms 에 전부 보내지만 h2 stream 종료 프레임(END_STREAM)을 정확히 60s
// withhold. 우리 h2 클라이언트가 END_STREAM 을 기다리느라(`data()`→None)
// 본문이 이미 완성됐는데도 60s block 함. 브라우저/curl 은 Content-Length
// 만큼 받으면 즉시 완료 → 그래서 빨랐음. Fix: body_buf 가 Content-Length
// 도달하면 END_STREAM 안 기다리고 즉시 break+반환. (h1 의 read_fixed 는
// 이미 Content-Length 존중 → h1 엔 이 버그 없음.)
test('h2 client returns at Content-Length without waiting for END_STREAM (NAVER 60s root fix)', () => {
  const http2Rs = fs.readFileSync('crates/zp-kernel-bundle/src/kernel/transport/http2.rs', 'utf8');
  assert.match(http2Rs, /content_length:\s*Option<usize>/, 'h2 must parse Content-Length to short-circuit the body loop');
  assert.match(http2Rs, /body_buf\.len\(\)\s*>=\s*cl/, 'h2 must finish once the Content-Length body is fully received');
  assert.match(http2Rs, /h2-body-cl-complete/, 'the Content-Length short-circuit must be observable in the trace ring');
});

// 2026-06-14 real-Chrome relay trace 확장 진단 + 최종 수정: 대부분 naver/
// pstatic 응답은 Content-Length 가 없고(chunked) gzip 이며 END_STREAM 을
// 60~240s withhold → (a) 매 응답 분 단위 지연, (b) 단일 yamux 세션에 스트림
// 쌓여 flow-control 고갈 → 다른 다운로드 붕괴. 최종 Fix(타이머 없이):
// Content-Length 없는 압축 응답은 gzip/br 의 자체 end-marker(CRC32+ISIZE
// footer)가 검증되는 즉시 완료 — 브라우저와 동일, truncation 없음. + END_STREAM
// 미수신 시 trailers().await 건너뜀(안 그러면 trailers 가 다시 60s block).
// ※ 이전 setTimeout-race(idle/retry) 방식은 실부하에서 future 취소가 wasm
// 을 trap(unreachable) 시켜 폐기 — read-side 검사만 사용.
test('h2 completes no-Content-Length compressed bodies via decode-end — NO setTimeout timer anywhere', () => {
  const http2Rs = fs.readFileSync('crates/zp-kernel-bundle/src/kernel/transport/http2.rs', 'utf8');
  // decode-end: compressed sub-resources finish the instant their DEFLATE
  // stream ends — read-side, no timer.
  assert.match(http2Rs, /detect_decode_end/, 'h2 must detect compressed-stream end for no-Content-Length bodies');
  assert.match(http2Rs, /decode::body_is_complete/, 'completion must use the codec end-marker check');
  assert.match(http2Rs, /h2-body-decode-end/, 'the decode-end completion must be observable in the trace ring');
  // trailers() must be gated on actually receiving END_STREAM, else it
  // re-blocks for the peer's full ~60s idle timeout.
  assert.match(http2Rs, /if end_stream\s*\{[\s\S]*?trailers\(\)\.await/, 'trailers() must only be awaited when END_STREAM was received');
  // HARD BAN: a setTimeout-based idle/timeout race in the request or body path
  // traps the wasm (`RuntimeError: unreachable`) in real Chrome — confirmed
  // twice. Neither the body loop nor the cold path may use the timer.
  assert.doesNotMatch(http2Rs, /with_timeout|BODY_IDLE_MS|timer::/, 'h2 must not use a setTimeout-based timer (crashes real Chrome)');
  const fetchRs = fs.readFileSync('crates/zp-kernel-bundle/src/kernel/transport/fetch.rs', 'utf8');
  assert.doesNotMatch(fetchRs, /with_timeout|COLD_DEADLINE_MS|timer::/, 'fetch must not use a setTimeout-based timer (crashes real Chrome)');
});

// Phase A (streaming HTML render): the main document (2xx text/html, gzip|
// identity) is handed to the page as a ReadableStream of incrementally-
// gunzipped plaintext so it renders progressively instead of blocking on
// NAVER's withheld END_STREAM (~60s). The pump is a pure `data().await` loop —
// NO timer (see the HARD BAN above). Scripts/CSS/images stay on the buffered
// arm. This pins the kernel half of the streaming pipeline.
test('h2 streams the HTML document via ReadableStream + incremental gunzip — gated, no timer', () => {
  const http2Rs = fs.readFileSync('crates/zp-kernel-bundle/src/kernel/transport/http2.rs', 'utf8');
  // The streaming arm + its return variant.
  assert.match(http2Rs, /enum H2Response/, 'send_request must return the buffered/streaming enum');
  assert.match(http2Rs, /H2Response::Streaming/, 'the streaming arm must exist');
  assert.match(http2Rs, /fn build_body_readable_stream/, 'must build a ReadableStream body for the document');
  assert.match(http2Rs, /fn pump_body/, 'an async pump must drive the body stream into the controller');
  assert.match(http2Rs, /new_with_underlying_source/, 'the ReadableStream must use an underlying source');
  assert.match(http2Rs, /enqueue_with_chunk/, 'the pump must enqueue decoded chunks');
  // GATE: streaming is restricted to HTML documents with a streamable coding.
  assert.match(http2Rs, /is_html\s*&&\s*coding_streamable/, 'streaming must be gated to text/html + gzip|identity');
  assert.match(http2Rs, /h2-stream-start/, 'the streaming arm must be observable in the trace ring');
  // The incremental decoder must be a stateful streaming gunzip — NOT the
  // whole-body decode path. And still NO timer anywhere.
  const decodeRs = fs.readFileSync('crates/zp-kernel-bundle/src/kernel/transport/decode.rs', 'utf8');
  assert.match(decodeRs, /pub\(crate\) struct StreamingGunzip/, 'decode must expose a stateful incremental gunzip');
  assert.match(http2Rs, /StreamingGunzip::new/, 'the pump must use the incremental gunzip');
  assert.doesNotMatch(http2Rs, /with_timeout|BODY_IDLE_MS|timer::|Timeout::new/, 'the streaming pump must not use any timer');
});

// Phase B (streaming HTML rewrite): the htmltx transform is refactored into a
// streaming `HtmlTxn { write, end }` primitive (two chained lol_html rewriters)
// that the buffered `transform` now delegates to — one implementation, no
// divergence. wasm-bindgen exports it as `ZPBundle.HtmlTxn` for the SW pipe.
// Chunk-invariance (chunked == whole-string) is pinned by the zp-htmltx host
// test `streaming_htmltxn_is_chunk_invariant`.
test('htmltx exposes a streaming HtmlTxn { write, end } and exports it to JS', () => {
  const htmltxRs = fs.readFileSync('crates/zp-htmltx/src/lib.rs', 'utf8');
  assert.match(htmltxRs, /pub struct HtmlTxn/, 'zp-htmltx must expose the streaming HtmlTxn');
  assert.match(htmltxRs, /fn attr_settings/, 'Pass 1 must be a reusable Settings factory');
  assert.match(htmltxRs, /fn script_settings/, 'Pass 2 must be a reusable Settings factory');
  assert.match(htmltxRs, /pub fn write\(&mut self, chunk: &\[u8\]\)/, 'HtmlTxn must accept byte chunks');
  assert.match(htmltxRs, /pub fn end\(self\)/, 'HtmlTxn::end must flush + consume');
  // transform() now delegates to HtmlTxn — single source of truth.
  assert.match(htmltxRs, /let mut txn = HtmlTxn::new/, 'buffered transform must delegate to HtmlTxn');
  // Chunk-invariance + prelude-injection host tests must exist.
  assert.match(htmltxRs, /fn streaming_htmltxn_is_chunk_invariant/, 'chunk-invariance must be pinned');
  // wasm-bindgen export for the SW.
  const bundleRs = fs.readFileSync('crates/zp-bundle/src/lib.rs', 'utf8');
  assert.match(bundleRs, /#\[wasm_bindgen\]\s*pub struct HtmlTxn/, 'HtmlTxn must be wasm-exported');
  assert.match(bundleRs, /pub fn write\(&mut self, chunk: &\[u8\]\) -> Result<Vec<u8>, JsError>/, 'JS write binding');
  assert.match(bundleRs, /pub fn end\(&mut self\) -> Result<Vec<u8>, JsError>/, 'JS end binding');
});

// The SW must only intercept http(s). Non-http schemes (chrome-extension:,
// data:, blob:) must pass through to the browser's native handler — calling
// respondWith on a chrome-extension: request returns Response.error() and
// breaks browser extensions' injected-script channels (observed on NAVER).
test('SW fetch handler passes through non-http(s) schemes (extension channels intact)', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  // The scheme guard must sit in the fetch listener, before respondWith.
  assert.match(
    sw,
    /addEventListener\('fetch'[\s\S]{0,600}?if \(!u\.startsWith\('http:'\) && !u\.startsWith\('https:'\)\) return;[\s\S]{0,80}?event\.respondWith\(handleFetch\(event\)\)/,
    'fetch listener must skip respondWith for non-http(s) URLs'
  );
});

// Phase C (SW streaming pipe): transformDocumentResponse pipes the kernel's
// streamed document (X-ZP-Stream marker) through a TransformStream backed by
// ZPBundle.HtmlTxn for a progressive render, with a buffered fallback that
// preserves fail-closed + the post-redirect CSS host rewrite.
test('SW streams the document through HtmlTxn behind the X-ZP-Stream gate, with buffered fallback', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  // The kernel marker gates streaming.
  assert.match(sw, /X-ZP-Stream/, 'SW must consult the kernel X-ZP-Stream marker');
  assert.match(sw, /function streamDocumentResponse/, 'streaming document helper must exist');
  assert.match(sw, /pipeThrough/, 'SW must pipe the body through a TransformStream');
  assert.match(sw, /new self\.ZPBundle\.HtmlTxn/, 'SW must construct the streaming HtmlTxn');
  assert.match(sw, /txn\.write\(chunk\)/, 'the transform must feed chunks to HtmlTxn.write');
  assert.match(sw, /txn\.end\(\)/, 'the flush must call HtmlTxn.end');
  // The marker must be stripped before the page sees it.
  assert.match(sw, /headers\.delete\('X-ZP-Stream'\)/, 'the X-ZP-Stream marker must be stripped from the page response');
  // Fail-closed: a mid-stream rewrite error must error the stream, never ship raw bytes.
  assert.match(sw, /controller\.error\(e\)/, 'a rewrite error must error the stream (fail-closed)');
  // Buffered fallback must remain reachable (host mismatch / no HtmlTxn).
  assert.match(sw, /fall through to buffered/, 'a buffered fallback must remain');
  // Kernel side emits the marker for streamed responses only.
  const fetchRs = fs.readFileSync('crates/zp-kernel-bundle/src/kernel/transport/fetch.rs', 'utf8');
  assert.match(fetchRs, /headers\.append\("X-ZP-Stream", "1"\)/, 'kernel must mark streaming responses');
});

// body_is_complete 는 gzip 의 경우 DEFLATE 스트림 끝(final block)을 감지 —
// footer(CRC32+ISIZE)는 안 기다림 (naver 가 footer 를 END_STREAM 까지 60s
// withhold 하므로). 진짜 truncated 스트림은 StreamEnd 못 만나 false (조기
// 완료=truncation 방지). decode_gzip 은 footer 없어도 deflate 콘텐츠를 풀도록
// raw-inflate fallback. 두 동작 다 standalone native 테스트로 검증됨.
test('decode detects DEFLATE end (footer-independent) and inflates footer-less gzip', () => {
  const decodeRs = fs.readFileSync('crates/zp-kernel-bundle/src/kernel/transport/decode.rs', 'utf8');
  assert.match(decodeRs, /pub\(crate\) fn body_is_complete/, 'decode must export body_is_complete');
  assert.match(decodeRs, /fn gzip_content_complete/, 'gzip completeness must check the DEFLATE stream end, not the footer');
  assert.match(decodeRs, /Status::StreamEnd/, 'completion is the raw DEFLATE StreamEnd');
  assert.match(decodeRs, /fn inflate_raw/, 'decode_gzip must fall back to raw inflate for footer-less gzip');
  assert.match(decodeRs, /fn gzip_header_len/, 'must parse the gzip header to locate the deflate stream');
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

// 2026-06-08 split-bundle (c.2): page realm now loads a dedicated
// `zp-page-bundle` crate's wasm (rewriter + CSS only, ~0.85 MB after wasm-opt
// vs the full SW bundle's 3.78 MB). The SW continues to load the full bundle
// via `importScripts('/__zp/zp_bundle_sw.js')`. This test pins:
//   - the new crate exists + is included in the workspace
//   - build.mjs builds it + wasm-bindgen's it + reads from the page-bundle
//     glue + wasm (not the SW bundle's)
//   - Go server allowlists the new asset paths
//   - the SW bundle wasm itself is NOT inlined as base64 into zp-page-bundle.js
//     (which was the c.1 mis-step that ballooned cold load — c.2 corrects it).
test('split-bundle (c.2): page realm uses a dedicated lighter wasm bundle', () => {
  assert.ok(fs.existsSync('crates/zp-page-bundle/Cargo.toml'), 'zp-page-bundle crate must exist');
  assert.ok(fs.existsSync('crates/zp-page-bundle/src/lib.rs'), 'zp-page-bundle lib.rs must exist');
  // 2026-06-09 E3 size win: css.rs deleted, swc_common/swc_css_*/url
  // deps dropped, zp-htmltx (lol_html) dep dropped — page bundle is
  // JS-rewriter-only now (375 KB, below the 500 KB hard target).
  // The page realm never called rewriteCSS / transformHtml; the SW
  // realm continues to do both via the full zp-bundle.
  const pageCargo = fs.readFileSync('crates/zp-page-bundle/Cargo.toml', 'utf8');
  for (const dropped of ['swc_common', 'swc_css_ast', 'swc_css_parser', 'swc_css_visit', 'zp-htmltx', /^url\s*=/m]) {
    const re = dropped instanceof RegExp ? dropped : new RegExp(`^${dropped}\\s*=`, 'm');
    assert.equal(re.test(pageCargo), false, `zp-page-bundle must NOT depend on ${dropped} after E3 slim`);
  }
  assert.equal(fs.existsSync('crates/zp-page-bundle/src/css.rs'), false, 'zp-page-bundle css.rs must have been removed in E3 slim');
  const workspaceCargo = fs.readFileSync('Cargo.toml', 'utf8');
  assert.match(workspaceCargo, /"crates\/zp-page-bundle"/, 'workspace must include zp-page-bundle');
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  assert.match(build, /'-p', 'zp-page-bundle'/, 'build must cargo-build zp-page-bundle');
  assert.match(build, /zp_page_bundle\.wasm/, 'build must reference zp_page_bundle.wasm');
  assert.match(build, /zp_page_bundle_bg\.wasm/, 'build must reference zp_page_bundle_bg.wasm');
  assert.match(build, /ZPPageBundleWBG/, 'build must expose ZPPageBundleWBG factory');
  // makeZPBundlePageClassic reads the page bundle's glue + wasm, NOT the SW bundle's.
  assert.match(build, /makeZPBundlePageClassic[\s\S]*?zp_page_bundle\.js/, 'page bundle wrapper must read zp_page_bundle.js glue');
  assert.match(build, /makeZPBundlePageClassic[\s\S]*?zp_page_bundle_bg\.wasm/, 'page bundle wrapper must read zp_page_bundle_bg.wasm bytes');
  // The c.1 mis-step (reading zp_bundle_sw_bg.wasm from inside the page wrapper)
  // would manifest as the SW wasm being inlined into the page bundle. Pin it out.
  const wrapperMatch = build.match(/async function makeZPBundlePageClassic[\s\S]*?\n\}/);
  assert.ok(wrapperMatch, 'makeZPBundlePageClassic body must be locatable');
  assert.equal(
    wrapperMatch[0].includes('zp_bundle_sw'),
    false,
    'page bundle wrapper must NOT reference the SW bundle (c.1 mis-step)',
  );
  // Go server allowlists the new artifacts.
  const mainGo = fs.readFileSync('cmd/zeroproxy-server/main.go', 'utf8');
  assert.match(mainGo, /"\/__zp\/zp_page_bundle\.js"/, 'Go server must allow /__zp/zp_page_bundle.js');
  assert.match(mainGo, /"\/__zp\/zp_page_bundle_bg\.wasm"/, 'Go server must allow /__zp/zp_page_bundle_bg.wasm');
});

// 2026-06-08 split-bundle (c.3): SW kernel/transport half (rustls + h2 + yamux +
// mlkem + tokio + flate2/brotli/ruzstd + membrane/rtcgw/wtproxy) moved to a
// dedicated `zp-kernel-bundle` crate so its wasm gets fetched + instantiated
// lazily — only on first `transportFetch` — instead of blocking SW `activate`.
// This test pins:
//   - the new crate exists + is in the workspace
//   - kernel/membrane/rtcgw/wtproxy modules live there (not in zp-bundle)
//   - zp-bundle no longer carries the kernel module declarations or the heavy
//     transport deps (rustls / h2 / yamux / tokio / mlkem / decoders)
//   - build.mjs builds + wasm-bindgen's the kernel bundle under `ZPKernelWBG`
//   - the SW top-level importScripts the kernel glue
//   - the SW has a separate `initKernel()` that owns kernel wasm instantiation
//   - transportFetch / openRuntimeStream / kernelEcho diag await initKernel()
//   - initBundle no longer wires kernel{Init,Fetch,Stream,...} into ZPBundle
//   - Go server allowlists the new asset paths.
test('split-bundle (c.3): SW kernel/transport wasm splits off into zp-kernel-bundle (lazy)', () => {
  // New crate exists.
  assert.ok(fs.existsSync('crates/zp-kernel-bundle/Cargo.toml'), 'zp-kernel-bundle crate must exist');
  assert.ok(fs.existsSync('crates/zp-kernel-bundle/src/lib.rs'), 'zp-kernel-bundle lib.rs must exist');
  assert.ok(fs.existsSync('crates/zp-kernel-bundle/src/kernel/mod.rs'), 'kernel module must move into zp-kernel-bundle');
  assert.ok(fs.existsSync('crates/zp-kernel-bundle/src/kernel/transport/mod.rs'), 'transport submodule must move with kernel');
  assert.ok(fs.existsSync('crates/zp-kernel-bundle/src/membrane.rs'), 'membrane.rs must move into zp-kernel-bundle');
  assert.ok(fs.existsSync('crates/zp-kernel-bundle/src/rtcgw_client.rs'), 'rtcgw_client.rs must move into zp-kernel-bundle');
  assert.ok(fs.existsSync('crates/zp-kernel-bundle/src/wtproxy_client.rs'), 'wtproxy_client.rs must move into zp-kernel-bundle');
  const workspaceCargo = fs.readFileSync('Cargo.toml', 'utf8');
  assert.match(workspaceCargo, /"crates\/zp-kernel-bundle"/, 'workspace must include zp-kernel-bundle');
  // zp-bundle no longer owns those modules.
  assert.equal(fs.existsSync('crates/zp-bundle/src/kernel'), false, 'kernel/ must not remain under zp-bundle');
  assert.equal(fs.existsSync('crates/zp-bundle/src/membrane.rs'), false, 'membrane.rs must not remain under zp-bundle');
  assert.equal(fs.existsSync('crates/zp-bundle/src/rtcgw_client.rs'), false, 'rtcgw_client.rs must not remain under zp-bundle');
  assert.equal(fs.existsSync('crates/zp-bundle/src/wtproxy_client.rs'), false, 'wtproxy_client.rs must not remain under zp-bundle');
  const bundleLib = fs.readFileSync('crates/zp-bundle/src/lib.rs', 'utf8');
  assert.equal(/^pub mod kernel\b/m.test(bundleLib), false, 'zp-bundle lib.rs must NOT declare pub mod kernel');
  assert.equal(/^pub mod membrane\b/m.test(bundleLib), false, 'zp-bundle lib.rs must NOT declare pub mod membrane');
  assert.equal(/^pub mod rtcgw_client\b/m.test(bundleLib), false, 'zp-bundle lib.rs must NOT declare pub mod rtcgw_client');
  assert.equal(/^pub mod wtproxy_client\b/m.test(bundleLib), false, 'zp-bundle lib.rs must NOT declare pub mod wtproxy_client');
  // zp-bundle Cargo.toml must not pull in the heavy transport stack any more.
  // (The same deps now live in zp-kernel-bundle/Cargo.toml.)
  const bundleCargo = fs.readFileSync('crates/zp-bundle/Cargo.toml', 'utf8');
  for (const heavy of ['rustls', 'h2', 'yamux', 'tokio', 'tokio-util', 'ml-kem', 'x25519-dalek', 'flate2', 'brotli', 'ruzstd', 'zp-transport-codec', 'httparse', 'webpki-roots']) {
    assert.equal(
      new RegExp(`^${heavy}\\s*=`, 'm').test(bundleCargo),
      false,
      `zp-bundle must NOT depend on '${heavy}' after the (c.3) kernel split`,
    );
  }
  const kernelCargo = fs.readFileSync('crates/zp-kernel-bundle/Cargo.toml', 'utf8');
  assert.match(kernelCargo, /^rustls\b/m, 'zp-kernel-bundle must declare rustls');
  assert.match(kernelCargo, /^h2\b/m, 'zp-kernel-bundle must declare h2');
  assert.match(kernelCargo, /^yamux\b/m, 'zp-kernel-bundle must declare yamux');
  assert.match(kernelCargo, /^tokio\b/m, 'zp-kernel-bundle must declare tokio');
  assert.match(kernelCargo, /^ml-kem\b/m, 'zp-kernel-bundle must declare ml-kem');
  // build.mjs builds the new crate + wasm-bindgen's it under ZPKernelWBG.
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  assert.match(build, /'-p', 'zp-kernel-bundle'/, 'build must cargo-build zp-kernel-bundle');
  assert.match(build, /'zp_kernel_sw'/, 'build must wasm-bindgen --out-name zp_kernel_sw');
  assert.match(build, /ZPKernelWBG/, 'build must wrap kernel glue to expose ZPKernelWBG');
  assert.match(build, /zpKernelBundleWasm/, 'build must declare zp_kernel_bundle.wasm path constant');
  // SW imports kernel glue at top level (importScripts can only happen there).
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.match(sw, /importScripts\('\/__zp\/zp_kernel_sw\.js'\)/, 'SW must importScripts the kernel glue at top level');
  // SW has a separate lazy `initKernel()` keyed on `self.ZPKernel.ready`.
  assert.match(sw, /async function initKernel\b/, 'SW must define async initKernel()');
  assert.match(sw, /self\.ZPKernel\s*=\s*Object\.freeze\(/, 'initKernel must freeze ZPKernel on self');
  assert.match(sw, /zp_kernel_sw_bg\.wasm/, 'initKernel must instantiate zp_kernel_sw_bg.wasm');
  // initBundle (the eager one) no longer exposes any kernel* members on
  // ZPBundle — kernel* moved to ZPKernel. (CRLF-tolerant regex: web/sw.js
  // may be checked out with either LF or CRLF line endings.)
  const initBundleMatch = sw.match(/async function initBundle\(\)[\s\S]*?\r?\n}\r?\n/);
  assert.ok(initBundleMatch, 'initBundle body must be locatable in sw.js');
  for (const kname of ['kernelFetch', 'kernelStream', 'kernelInit', 'kernelEchoSync', 'kernelLastNamedGroups', 'kernelVersion', 'kernelSetCapturedSpec']) {
    assert.equal(
      new RegExp(`${kname}:\\s*wbg\\.`).test(initBundleMatch[0]),
      false,
      `initBundle must NOT wire ${kname} into ZPBundle (it belongs on ZPKernel after c.3)`,
    );
  }
  // transportFetch + openRuntimeStream + kernelEcho diag await initKernel,
  // not initBundle, so the kernel wasm fetch happens lazily on first use.
  const transportFetchMatch = sw.match(/async function transportFetch[\s\S]*?\r?\n}\r?\n/);
  assert.ok(transportFetchMatch, 'transportFetch body must be locatable in sw.js');
  assert.match(transportFetchMatch[0], /await initKernel\(\)/, 'transportFetch must await initKernel()');
  const openRuntimeStreamMatch = sw.match(/async function openRuntimeStream[\s\S]*?\r?\n}\r?\n/);
  assert.ok(openRuntimeStreamMatch, 'openRuntimeStream body must be locatable in sw.js');
  assert.match(openRuntimeStreamMatch[0], /await initKernel\(\)/, 'openRuntimeStream must await initKernel() before reading self.kernelStream');
  // Go server allowlists the new artifacts.
  const mainGo = fs.readFileSync('cmd/zeroproxy-server/main.go', 'utf8');
  assert.match(mainGo, /"\/__zp\/zp_kernel_sw\.js"/, 'Go server must allow /__zp/zp_kernel_sw.js');
  assert.match(mainGo, /"\/__zp\/zp_kernel_sw_bg\.wasm"/, 'Go server must allow /__zp/zp_kernel_sw_bg.wasm');
});

// 2026-06-08 D4 client-side virtual WebTransport. The page-realm
// `WebTransport` slot now resolves to a real native-pass-through class
// when the operator has enabled the gateway (`-wt-public-url` set);
// otherwise it falls back to the existing rejected-promise stub
// (WT_UNSUPPORTED). Pins:
//   - Go server has `-wt-public-url` flag + `/zp/api/config` endpoint
//   - Go server emits `{wtGateway: ...}` from serveConfig
//   - Go listener accepts target via `?target=` query string (browser
//     `new WebTransport(...)` can't set custom request headers)
//   - SW refreshes runtime config on activate + injects `wtGateway`
//     into the boot JSON
//   - runtime-prelude captures native WebTransport + has the
//     ZPWebTransport wrapping factory
//   - installBlockers' WebTransport slot routes through that factory.
test('D4 client: virtual WebTransport routes through ZeroProxy gateway when enabled', () => {
  const mainGo = fs.readFileSync('cmd/zeroproxy-server/main.go', 'utf8');
  assert.match(mainGo, /"wt-public-url"/, 'Go server must expose -wt-public-url flag');
  assert.match(mainGo, /controlPrefix\+"api\/config"/, 'Go server must route /zp/api/config');
  assert.match(mainGo, /func \(s \*server\) serveConfig\(/, 'serveConfig handler must exist');
  assert.match(mainGo, /"wtGateway":"/, 'serveConfig must emit the wtGateway field');

  const listener = fs.readFileSync('internal/wtproxy/listener.go', 'utf8');
  assert.match(listener, /r\.URL\.Query\(\)\.Get\("target"\)/, 'listener must accept target via ?target= query string');

  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.match(sw, /async function refreshRuntimeConfig\b/, 'SW must define refreshRuntimeConfig()');
  assert.match(sw, /api\/config/, 'SW must fetch the /zp/api/config endpoint');
  assert.match(sw, /wtGateway:\s*runtimeConfig\.wtGateway/, 'SW buildRuntimePrelude must inject wtGateway into boot JSON');

  const prelude = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  assert.match(prelude, /WebTransport:\s*w\.WebTransport/, 'runtime-prelude must capture native WebTransport');
  assert.match(prelude, /function makeWebTransportConstructor\(\)/, 'runtime-prelude must define makeWebTransportConstructor');
  assert.match(prelude, /ZPWebTransport/, 'runtime-prelude must define ZPWebTransport class');
  assert.match(prelude, /ctor:\s*makeWebTransportConstructor/, 'installBlockers WebTransport entry must use the real constructor factory');
  // The wrapper must build a gateway URL with `target` set from the
  // caller's argument — pinning this prevents accidental regressions
  // where the wrapper opens WT directly against the target URL
  // (bypassing the gateway).
  assert.match(prelude, /params\.set\('target',\s*target\)/, 'ZPWebTransport must inject target into the gateway query string');
});

// 2026-06-08 D5 client-side virtual RTCPeerConnection. Page-realm
// `new RTCPeerConnection(...)` now wraps a native PC and routes signaling
// (offer / answer / ICE candidates) through the ZP gateway when the
// operator has enabled `-rtc-enable + -rtc-public-url`; otherwise it
// falls back to the legacy rejected-promise stub. Pins:
//   - Go server has `-rtc-enable` + `-rtc-public-url` flags + the
//     /zp/api/rtc/signal route + serveConfig emits `rtcGateway`
//   - SW threads `rtcGateway` into the boot JSON
//   - runtime-prelude has `makeRTCPeerConnectionConstructor` factory +
//     installBlockers RTC entries route through it
//   - the wrapper forces `iceServers: []` so page-supplied ICE servers
//     can't bypass us (defense-in-depth on top of the gateway flow).
test('D5 client: virtual RTCPeerConnection routes signaling through ZeroProxy gateway when enabled', () => {
  const mainGo = fs.readFileSync('cmd/zeroproxy-server/main.go', 'utf8');
  assert.match(mainGo, /"rtc-enable"/, 'Go server must expose -rtc-enable flag');
  assert.match(mainGo, /"rtc-public-url"/, 'Go server must expose -rtc-public-url flag');
  assert.match(mainGo, /controlPrefix\+"api\/rtc\/signal"/, 'Go server must route /zp/api/rtc/signal');
  assert.match(mainGo, /"rtcGateway":/, 'serveConfig must emit the rtcGateway field');

  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.match(sw, /rtcGateway:\s*runtimeConfig\.rtcGateway/, 'SW buildRuntimePrelude must inject rtcGateway into boot JSON');

  const prelude = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  assert.match(prelude, /function makeRTCPeerConnectionConstructor\(/, 'runtime-prelude must define makeRTCPeerConnectionConstructor');
  assert.match(prelude, /ZPRTCPeerConnection/, 'runtime-prelude must define ZPRTCPeerConnection class');
  assert.match(prelude, /'RTCPeerConnection':[^}]*ctor:\s*\(\)\s*=>\s*makeRTCPeerConnectionConstructor/, 'installBlockers RTCPeerConnection entry must use the factory');
  assert.match(prelude, /'webkitRTCPeerConnection':[^}]*ctor:\s*\(\)\s*=>\s*makeRTCPeerConnectionConstructor/, 'installBlockers webkitRTCPeerConnection entry must use the factory');
  // Defense-in-depth: page-supplied iceServers are NEVER used —
  // they'd point at attacker STUN/TURN that could leak the page IP.
  // Either we replace them with the operator's embedded TURN cred
  // tuple (`boot.rtcICEServers`) or we force empty. Post 2026-06-09
  // D5 embedded-TURN landing the assignment routes through
  // `issuedICEServers` (which falls back to `[]` when boot has no
  // tuple), so the page-supplied list is still discarded.
  assert.match(prelude, /safeConfig\.iceServers\s*=\s*issuedICEServers/, 'ZPRTCPeerConnection must overwrite iceServers (never use page-supplied)');
  assert.match(prelude, /const issuedICEServers = \(boot && Array\.isArray\(boot\.rtcICEServers\)\)/, 'ZPRTCPeerConnection must source iceServers from boot.rtcICEServers');
});

// 2026-06-08 wiki load.php deferred fix: `await initRewriter()` was a stale
// call left behind by split-bundle (c.1) Step 3 (the helper was deleted
// but the call site survived). Every external-script rewrite threw
// `ReferenceError: initRewriter is not defined`, which the outer
// try/catch swallowed and replaced with the
// `throw new DOMException('Blocked by ZeroProxy rewrite policy',
// 'NotSupportedError')` stub — visible to the page as the
// `NotSupportedError` console message on `load.php?modules=startup`.
// Pin the call site to never reintroduce the dead helper.
test('rewriteScriptResponse must not call the removed initRewriter helper', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.equal(
    /\binitRewriter\s*\(/.test(sw),
    false,
    'sw.js must not call initRewriter() (helper deleted in split-bundle c.1 Step 3)',
  );
  // ZPBundle is now the only rewriter and its readiness is guaranteed by
  // the activate handler. rewriteScriptResponse still does an idempotent
  // `await initBundle()` defensively before invoking rewriteScript.
  assert.match(
    sw,
    /async function rewriteScriptResponse[\s\S]*?await initBundle\(\)/,
    'rewriteScriptResponse must still await initBundle() before calling ZPBundle.rewriteScript',
  );
});

// 2026-06-08 split-bundle (c.1) Step 4: rewriter-rs/ crate is deleted. The
// CSS rewriter is ported to crates/zp-bundle/src/css.rs and exposed via the
// wasm-bindgen `rewriteCSS` export. SW + page realm both call
// `ZPBundle.rewriteCSS`.
test('rewriter-rs/ is deleted; CSS rewriter lives in zp-bundle (Step 4)', () => {
  // Crate directory + workspace exclusion + asset name all gone.
  assert.equal(fs.existsSync('rewriter-rs'), false, 'rewriter-rs/ directory must be removed');
  const workspaceCargo = fs.readFileSync('Cargo.toml', 'utf8');
  assert.equal(workspaceCargo.includes('"rewriter-rs"'), false, 'workspace must not exclude (or include) rewriter-rs');
  // zp-bundle has the CSS module + the SWC deps.
  assert.ok(fs.existsSync('crates/zp-bundle/src/css.rs'), 'CSS module must live at crates/zp-bundle/src/css.rs');
  const bundleCargo = fs.readFileSync('crates/zp-bundle/Cargo.toml', 'utf8');
  assert.match(bundleCargo, /^swc_css_ast\b/m, 'zp-bundle must declare swc_css_ast');
  assert.match(bundleCargo, /^swc_css_parser\b/m, 'zp-bundle must declare swc_css_parser');
  assert.match(bundleCargo, /^swc_css_visit\b/m, 'zp-bundle must declare swc_css_visit');
  // wasm-bindgen export wired in lib.rs.
  const bundleLib = fs.readFileSync('crates/zp-bundle/src/lib.rs', 'utf8');
  assert.match(bundleLib, /pub mod css\b/, 'lib.rs must declare the css module');
  assert.match(bundleLib, /js_name = rewriteCSS\b/, 'lib.rs must export rewriteCSS via wasm-bindgen');
  assert.match(bundleLib, /css::rewrite_css\(/, 'rewriteCSS export must delegate to css::rewrite_css');
  // SW + page bundle wrapper expose rewriteCSS.
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.match(sw, /rewriteCSS:\s*\(source,\s*baseUrl,\s*controlPrefix\)\s*=>\s*wbg\.rewriteCSS\(/, 'SW initBundle must expose rewriteCSS on ZPBundle');
  assert.match(sw, /self\.ZPBundle\.rewriteCSS\(/, 'rewriteCSSResponse must call ZPBundle.rewriteCSS');
  // build.mjs page bundle wrapper exposes rewriteCSS.
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  assert.match(build, /rewriteCSS:.*wbg\.rewriteCSS/, 'page bundle wrapper must expose rewriteCSS');
  // build.mjs no longer generates the legacy rust-rewriter.js artifact.
  assert.equal(build.includes("writeBundled('rust-rewriter.js'"), false, 'rust-rewriter.js artifact must not be generated');
  // ZPRewriter (legacy) is gone from SW + prelude.
  assert.equal(sw.includes('self.ZPRewriter'), false, 'SW must no longer reference self.ZPRewriter');
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  assert.equal(rt.includes('root.ZPRewriter'), false, 'prelude must no longer reference root.ZPRewriter');
});

// 2026-06-08 split-bundle (c.1) Step 2.3 + 2.4 + 3: page-realm ZPBundle infra,
// prelude primary swap, and removal of the legacy ZPRewriter.rewriteScript
// fallback. The page realm loads `zp-page-bundle.js` (initSync's wasm at
// script-tag time so `globalThis.ZPBundle.ready === true` synchronously by
// the time runtime-prelude runs), and the prelude's `callPageRewriter`
// calls ZPBundle exclusively — there is no legacy script-rewriter to fall
// back to (rewriter-rs/ is CSS-only after Step 3).
test('page-realm prelude routes JS through ZPBundle only (Step 2.3 + 2.4 + 3)', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  const mainGo = fs.readFileSync('cmd/zeroproxy-server/main.go', 'utf8');
  // Build produces the page bundle artifact.
  assert.match(build, /async function makeZPBundlePageClassic\b/, 'build must generate page bundle wrapper');
  assert.match(build, /zp-page-bundle\.js/, 'build must write zp-page-bundle.js');
  // Go server allowlists the new asset on both legacy + canonical paths.
  assert.match(mainGo, /"zp-page-bundle\.js"/, 'Go server must allow the new asset name');
  // SW injects the bundle <script> tag alongside the legacy rewriter.
  assert.match(sw, /assetPath\('zp-page-bundle\.js'\)/, "SW must inject zp-page-bundle.js script tag");
  // Prelude: callPageRewriter routes ONLY through ZPBundle.
  assert.match(rt, /function callPageRewriter\b/, 'prelude must define callPageRewriter helper');
  const fnMatch = rt.match(/function callPageRewriter\([\s\S]*?^    \}/m);
  assert.ok(fnMatch, 'callPageRewriter body must be locatable');
  const fn = fnMatch[0];
  assert.match(fn, /root\.ZPBundle/, 'callPageRewriter must call ZPBundle');
  assert.equal(
    fn.includes('root.ZPRewriter.rewriteScript'),
    false,
    'callPageRewriter must NOT call legacy ZPRewriter.rewriteScript (Step 3 dropped the JS path)',
  );
  // rewriteDynamicFunctionBody + rewriteWithPageRewriter both route through it.
  assert.match(rt, /function rewriteDynamicFunctionBody[\s\S]*?callPageRewriter\(/, 'rewriteDynamicFunctionBody must route through callPageRewriter');
  assert.match(rt, /function rewriteWithPageRewriter[\s\S]*?callPageRewriter\(/, 'rewriteWithPageRewriter must route through callPageRewriter');
});

// 2026-06-08 split-bundle (c.1) Step 2.2 + 3: SW rewriteScriptResponse now
// uses ZPBundle exclusively. The legacy ZPRewriter.rewriteScript fallback
// was removed when Step 3 dropped the OXC-based JS rewriter from rewriter-rs/.
test('SW rewriteScriptResponse routes JS through ZPBundle only (Step 2.2 + 3)', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  const fnMatch = sw.match(/async function rewriteScriptResponse\b[\s\S]*?return new Response\(code,/);
  assert.ok(fnMatch, 'rewriteScriptResponse body must be locatable');
  const body = fnMatch[0];
  assert.match(body, /self\.ZPBundle\.rewriteScript\(/, 'rewriteScriptResponse must call ZPBundle.rewriteScript');
  assert.equal(
    body.includes('self.ZPRewriter && self.ZPRewriter.rewriteScript'),
    false,
    'rewriteScriptResponse must NOT call legacy ZPRewriter.rewriteScript (Step 3 dropped the JS path)',
  );
});

// 2026-06-08 split-bundle (c.1) Step 3: shadow-compare infrastructure removed.
// After Step 2.1.5 closed the modern rewriter's `Function`/`eval` global
// gap and Step 2.2 swapped ZPBundle to primary, the legacy ZPRewriter.rewriteScript
// path no longer exists (Step 3 dropped OXC from rewriter-rs/). With only one
// rewriter, there is nothing to compare against — the recorder + buffer +
// debug endpoint are all gone.
test('SW shadow-compare infrastructure is removed after Step 3', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.equal(sw.includes('SHADOW_LOG_CAP'), false, 'SHADOW_LOG_CAP constant must be gone');
  assert.equal(sw.includes('function recordShadowDivergence'), false, 'recordShadowDivergence helper must be gone');
  assert.equal(sw.includes('function shadowCompareRewriters'), false, 'shadowCompareRewriters helper must be gone');
  assert.equal(sw.includes('__shadow_log'), false, 'debug endpoint must be gone');
});

// 2026-06-07 split-bundle (c.1) Step 2.0: activate event awaits initBundle so
// the SW transitions to `activated` only when ZPBundle.ready is true. Pin the
// invariant + the bounded timeout so the activate handler can't accidentally
// regress to fire-and-forget (which previously meant the first script fetch
// paid the full cold-init latency, a hypothesis on the NAVER hydration wedge
// observed during the Step 2a abort — see trap-notebook 2026-06-07).
test('SW activate event awaits initBundle with bounded timeout (Step 2.0)', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  // The activate handler MUST `await` either `initBundle()` itself or a
  // Promise.race wrapping it. Pure fire-and-forget (`initBundle().catch`)
  // must NOT be the terminal expression of the waitUntil promise.
  assert.match(sw, /addEventListener\(['"]activate['"]/, 'activate listener must exist');
  // Bounded timeout sentinel must guard against a stuck wasm fetch.
  assert.match(sw, /BUNDLE_BOOT_TIMEOUT_MS/, 'activate must declare a bounded timeout for bundle boot');
  assert.match(sw, /Promise\.race\(\[\s*initBundle\(\)/, 'activate must race initBundle against the timeout');
  // The Step 2a-era pattern was `initBundle().catch(() => {})` as a trailing
  // bare statement inside waitUntil. Asserting that the activate body
  // contains an await against initBundle's race rules that out.
  const activateBody = sw.match(/addEventListener\(['"]activate['"][\s\S]*?\)\)\);/);
  assert.ok(activateBody, 'activate handler body must be locatable');
  assert.match(activateBody[0], /await\s+Promise\.race/, 'activate must await the initBundle race');
});

// 2026-06-08 split-bundle (c.1) Step 2.1.5: patch-mode call site DROPPED from
// rewriteScriptResponse because `rewriteScriptPatches` returns raw marker
// strings (`\u{1}GLOBAL_GET\u{1}…`, `\u{1}MEMBER_GET\u{1}…`, …) that only
// `apply_patches` in Rust knows how to expand into `__zp_get(…)` / `__zp_set(…)`
// / `__zp_call(…)`. JS-side `applyScriptPatches` is a naive splicer; using it
// against the patches envelope produces invalid JS embedded with raw markers
// (discovered by shadow-compare on NAVER ndp-loader, see trap-notebook).
//
// The wbg wrapper still exposes `rewriteScriptPatches` (downstream callers
// that ship a Rust-side resolver can use it), the `applyScriptPatches` helper
// still exists (kept for the future marker-resolver port + still required by
// the behavior test below), but rewriteScriptResponse must NOT call them.
test('SW does not use patch-mode in rewriteScriptResponse (Step 2.1.5 marker hazard)', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  // wbg wrapper still exposes the API for future use.
  assert.ok(sw.includes('rewriteScriptPatches'), 'ZPBundle wrapper still exposes rewriteScriptPatches');
  assert.ok(sw.includes('applyScriptPatches'), 'applier helper kept for future marker resolver port');
  // The actual hot-path call site must be GONE from rewriteScriptResponse.
  // Match the structural pattern: rewriteScriptResponse → full re-emit only.
  const fnMatch = sw.match(/async function rewriteScriptResponse\b[\s\S]*?return new Response\(code,/);
  assert.ok(fnMatch, 'rewriteScriptResponse body must be locatable');
  const body = fnMatch[0];
  assert.equal(
    body.includes('self.ZPBundle.rewriteScriptPatches('), false,
    'rewriteScriptResponse must NOT call rewriteScriptPatches (markers unresolved)',
  );
  assert.equal(
    body.includes('applyScriptPatches('), false,
    'rewriteScriptResponse must NOT call applyScriptPatches (naive splicer leaks markers)',
  );
  assert.match(body, /self\.ZPBundle\.rewriteScript\(/, 'rewriteScriptResponse must call full re-emit');
});

test('applyScriptPatches behavior: empty patches, splice, malformed envelopes', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  // Extract the applier verbatim so behavior is exercised, not just shape.
  // `\n}` (no trailing newline) tolerates both LF and CRLF line endings.
  const m = sw.match(/function applyScriptPatches\(source, envelopeJson\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'applyScriptPatches definition must be locatable');
  // eslint-disable-next-line no-new-func
  const apply = new Function(`${m[0]}\nreturn applyScriptPatches;`)();

  // Empty source + empty patches → original string passes through.
  assert.equal(apply('', JSON.stringify({ len: 0, patches: [] })), '');
  // No patches → caller gets the source verbatim (no allocation).
  assert.equal(apply('var x = 1;', JSON.stringify({ len: 10, patches: [] })), 'var x = 1;');
  // Single splice — replace `location` (chars 8..16) with `__zp_loc`.
  const src = 'var u = location.href;';
  const env = JSON.stringify({ len: src.length, patches: [{ start: 8, end: 16, replacement: '__zp_loc' }] });
  assert.equal(apply(src, env), 'var u = __zp_loc.href;');
  // Two non-overlapping splices in order.
  const env2 = JSON.stringify({
    len: src.length,
    patches: [
      { start: 8, end: 16, replacement: '__zp_loc' },
      { start: 17, end: 21, replacement: '__zp_href_str' },
    ],
  });
  assert.equal(apply(src, env2), 'var u = __zp_loc.__zp_href_str;');
  // Malformed JSON → null (caller falls back).
  assert.equal(apply(src, '{not json'), null);
  // Out-of-order patches (start < cursor) → null (defensive).
  const bad = JSON.stringify({
    len: src.length,
    patches: [
      { start: 8, end: 16, replacement: 'A' },
      { start: 4, end: 7, replacement: 'B' },
    ],
  });
  assert.equal(apply(src, bad), null);
  // end > source.length → null.
  const oob = JSON.stringify({ len: src.length, patches: [{ start: 0, end: 9999, replacement: 'X' }] });
  assert.equal(apply(src, oob), null);
  // Missing patches array → null.
  assert.equal(apply(src, JSON.stringify({ len: 10 })), null);
});

test('Anti-fingerprint: ZP + ZeroProxyRT hide from getOwnPropertyNames', () => {
  // Anti-bot probes enumerate `Object.getOwnPropertyNames(window)` to
  // detect instrumentation (NAVER's warm-session V8 wedge is the canonical
  // example). The named properties `ZP` and `ZeroProxyRT` are obvious
  // ZeroProxy tells; runtime-prelude captures both into closure-local
  // bindings and deletes them from globalThis before any target script
  // executes. The Symbol.for('zeroproxy.runtime.installed') marker stays
  // — Symbol-keyed props don't appear in getOwnPropertyNames.
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  assert.match(rt, /const ZP = globalThis\.ZP;/, 'runtime-prelude must capture ZP into closure');
  assert.match(rt, /const ZeroProxyRTGlobal = globalThis\.ZeroProxyRT;/, 'runtime-prelude must capture ZeroProxyRT into closure');
  assert.match(rt, /try \{ delete globalThis\.ZP; \} catch \{\}/, 'runtime-prelude must delete window.ZP');
  assert.match(rt, /try \{ delete globalThis\.ZeroProxyRT; \} catch \{\}/, 'runtime-prelude must delete window.ZeroProxyRT');
  // The two source globals must declare `configurable: true` so the
  // delete actually takes effect (defineProperty defaults are immutable).
  const core = fs.readFileSync('web/zp-core.js', 'utf8');
  assert.match(core, /defineProperty\(globalThis, 'ZP'[\s\S]{0,200}configurable: true/);
  const rtjs = fs.readFileSync('web/zp-rt.js', 'utf8');
  assert.match(rtjs, /defineProperty\(globalThis, 'ZeroProxyRT'[\s\S]{0,200}configurable: true/);
});

test('Loop cap: rewriter neutralises infinite for/while probes', () => {
  // NAVER warm-session V8 wedge and similar anti-bot probes use tight
  // `for(;;)` / `while(1)` / `while(true)` loops to detect membrane
  // instrumentation. The rewriter caps each occurrence with a fresh
  // counter so the loop terminates after 10 M iterations regardless of
  // how the body interacts with the membrane.
  const rewriter = fs.readFileSync('crates/zp-rewriter/src/lib.rs', 'utf8');
  assert.match(rewriter, /fn visit_for_statement\(&mut self, stmt: &ForStatement<'a>\)/);
  assert.match(rewriter, /fn visit_while_statement\(&mut self, stmt: &WhileStatement<'a>\)/);
  assert.match(rewriter, /fn visit_do_while_statement\(&mut self, stmt: &DoWhileStatement<'a>\)/);
  assert.match(rewriter, /fn is_truthy_constant/);
  // The 10 M cap is the policy constant; lower would risk breaking
  // legitimate long loops, higher would let the probe wedge V8.
  assert.match(rewriter, /__zp_lc_\{id\}\+\+<10000000/);
  // Each loop must get a fresh counter ID so nested infinites don't
  // collide and reset each other.
  assert.match(rewriter, /fn next_loop_id/);
});

test('D2: sourcemap composer + SW /zp/api/sourcemap route are wired', () => {
  const rewriter = fs.readFileSync('crates/zp-rewriter/src/sourcemap.rs', 'utf8');
  // §A.4 VLQ encoder is the load-bearing primitive.
  assert.match(rewriter, /fn vlq_encode_into\(value: i64/);
  // Source Map v3 schema fields must all appear in the JSON template
  // (escaped in the Rust string literal — match the source form).
  assert.match(rewriter, /\\"version\\":3/);
  assert.match(rewriter, /\\"sources\\":/);
  assert.match(rewriter, /\\"sourcesContent\\":/);
  assert.match(rewriter, /\\"names\\":\[\]/);
  assert.match(rewriter, /\\"mappings\\":/);
  // Public composer API used by the WASM export.
  assert.match(rewriter, /pub fn compose_rewrite_map/);
  // Re-export from lib so external crates can call it.
  const lib = fs.readFileSync('crates/zp-rewriter/src/lib.rs', 'utf8');
  assert.match(lib, /pub mod sourcemap/);
  assert.match(lib, /pub use sourcemap::\{chain_with_original_map, compose_rewrite_map\}/);
  assert.match(lib, /pub fn compose_source_map/);

  // WASM bundle must expose composeSourceMap.
  const bundle = fs.readFileSync('crates/zp-bundle/src/lib.rs', 'utf8');
  assert.match(bundle, /#\[wasm_bindgen\(js_name = composeSourceMap\)\]/);
  assert.match(bundle, /zp_rewriter::compose_source_map\(source, &opts, target_url\)/);

  // SW must append a fresh `//# sourceMappingURL=` pointing to the proxy
  // route on successful rewrites — DevTools loads the composed map.
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.match(sw, /sourceMappingURL=' \+ mapURL/);
  assert.match(sw, /ZP\.apiPath\('sourcemap'\)/);
  // Pragma emission must be gated to script kinds with a fetchable origin
  // URL — synthesised wrappers (event-handler, eval, function) have none,
  // so the map URL would 404.
  assert.match(sw, /kind === 'classic' \|\| kind === 'module' \|\| kind === 'worker'/);

  // /zp/api/sourcemap must be a runtime API path and have a handler.
  assert.match(sw, /isRuntimeAPIPath[\s\S]{0,200}ZP\.apiPath\('sourcemap'\)/, 'sourcemap path must classify as RUNTIME_API');
  assert.match(sw, /url\.pathname === ZP\.apiPath\('sourcemap'\)/, 'runtimeAPI must dispatch the sourcemap route');
  assert.match(sw, /self\.ZPBundle\.composeSourceMap\(source, kind, target\)/, 'route must call the WASM composer');
  // The map must NOT be cached on the page — a transformer-version bump
  // invalidates the composition.
  assert.match(sw, /composeSourceMap[\s\S]{0,400}'Cache-Control': 'no-store'/);
});

test('C1: Rust WebSocket client implements RFC 6455 handshake + codec', () => {
  const ws = fs.readFileSync('crates/zp-kernel-bundle/src/kernel/transport/ws_client.rs', 'utf8');
  // §1.3 magic GUID for Sec-WebSocket-Accept.
  assert.match(ws, /258EAFA5-E914-47DA-95CA-C5AB0DC85B11/, 'WS_GUID must equal the RFC 6455 §1.3 value');
  // Handshake headers.
  assert.match(ws, /Upgrade: websocket/, 'handshake must request the websocket upgrade');
  assert.match(ws, /Sec-WebSocket-Version: 13/, 'handshake must announce protocol version 13');
  assert.match(ws, /Sec-WebSocket-Key: /, 'handshake must carry the client nonce');
  // §1.3 Accept computation = base64(SHA1(key || GUID)).
  assert.match(ws, /Sha1::new\(\)[\s\S]{0,200}WS_GUID/, 'expected_accept must SHA1 the key + GUID');
  // §5.3 client mask MUST be set.
  assert.match(ws, /out\.push\(0x80 \| \(op as u8\)\)/, 'frame must set FIN=1 + opcode');
  assert.match(ws, /out\.push\(0x80 \| \(len as u8\)\)/, 'MASK bit must be set on outbound frames');
  // §5.1 server frames MUST NOT be masked.
  assert.match(ws, /server frame is masked \(§5\.1 violation\)/, 'masked server frames must abort the connection');
  // Control-frame discipline (§5.5: ≤125, FIN=1, no fragmentation).
  assert.match(ws, /control frame fragmented \(FIN=0\)/);
  assert.match(ws, /control payload > 125/);
  // §4.2.2 negotiated protocol must come from the offered list.
  assert.match(ws, /ws-protocol-not-offered/, 'negotiated subprotocol must come from offered list');
  // Close payload semantics: empty → 1005; single byte → 1002 (malformed).
  assert.match(ws, /fn decode_close_payload/);
  assert.match(ws, /return \(1005, String::new\(\)\)/, 'empty close payload → 1005');
  assert.match(ws, /return \(1002, "malformed close payload"/, 'single-byte close payload → 1002');
  // §8.1: invalid UTF-8 in text frames closes with 1007.
  assert.match(ws, /1007, "invalid UTF-8 in text frame"/);

  // kernel_stream is now wired to ws_client::open (not the old stub).
  const modRs = fs.readFileSync('crates/zp-kernel-bundle/src/kernel/mod.rs', 'utf8');
  assert.equal(modRs.includes('TARGET_WS_NOT_REWIRED'), false, 'kernel_stream must no longer return the stub error');
  assert.match(modRs, /transport::ws_client::open\(&url, &protocols\)\.await/, 'kernel_stream must call ws_client::open');
});

test('transport codec crate owns the SOCKS5 / HTTP/1.1 byte invariants', () => {
  // zp-bundle's wasm-only async transport modules now delegate every
  // byte-layout decision to crates/zp-transport-codec — which IS
  // host-buildable and carries the unit tests the wasm wrappers can't
  // run themselves (parent kernel mod is #![cfg(target_arch = "wasm32")]).
  // Pin the wiring so a future refactor can't silently re-introduce the
  // duplicated inline byte layouts.
  const socks5 = fs.readFileSync('crates/zp-kernel-bundle/src/kernel/transport/socks5.rs', 'utf8');
  assert.match(
    socks5,
    /use zp_transport_codec::socks5 as codec;/,
    'socks5.rs must import the codec crate',
  );
  assert.match(
    socks5,
    /codec::build_greeting\(auth\)/,
    'socks5 method-neg must build the greeting through the codec',
  );
  assert.match(
    socks5,
    /codec::parse_greeting_reply\(reply, auth\)/,
    'socks5 method-neg must parse the greeting reply through the codec',
  );
  assert.match(
    socks5,
    /codec::build_userpass_subneg\(user, pass\)/,
    'userpass subneg must come from the codec',
  );
  assert.match(
    socks5,
    /codec::parse_userpass_reply\(reply\)/,
    'userpass reply must be parsed by the codec',
  );
  assert.match(
    socks5,
    /codec::build_connect_request\(host, port\)/,
    'CONNECT request must come from the codec',
  );
  assert.match(
    socks5,
    /codec::parse_connect_reply_head\(head\)/,
    'CONNECT reply head must be parsed by the codec',
  );
  // The legacy inline constants that used to live here are gone — the
  // codec crate is the single source of truth.
  assert.equal(
    socks5.includes('const VER: u8 = 0x05'),
    false,
    'inline VER constant must be removed (now lives in zp-transport-codec)',
  );
  assert.equal(
    socks5.includes('fn map_rep_kind'),
    false,
    'inline REP-code mapping must move to zp-transport-codec',
  );
  assert.equal(
    /TODO\(test\)/.test(socks5),
    false,
    'socks5.rs TODO(test) marker must be retired (codec carries the tests)',
  );

  const http1 = fs.readFileSync('crates/zp-kernel-bundle/src/kernel/transport/http1.rs', 'utf8');
  assert.match(
    http1,
    /use zp_transport_codec::http1 as codec;/,
    'http1.rs must import the codec crate',
  );
  assert.match(
    http1,
    /codec::build_request_head\(method, host_header, path, headers, body\.len\(\)\)/,
    'http1 write_request must build the head via the codec',
  );
  assert.match(
    http1,
    /codec::parse_response_head\(buf\)/,
    'http1 parse_head must delegate to the codec',
  );
  assert.match(
    http1,
    /codec::response_keepalive\(resp\.status, &resp\.headers\)/,
    'response_is_keepalive must delegate to the codec',
  );
  // Chunked decoder: the WHOLE state machine (size-line parse,
  // chunk-ext drop, body framing, missing-CRLF reject, body cap,
  // trailer drain, single-byte incremental feed, mid-body EOF
  // tolerance) lives in zp-transport-codec::http1::ChunkedDecoder.
  // The async loop here just pushes bytes in and drains via the
  // state machine — no inline framing logic.
  assert.match(
    http1,
    /codec::ChunkedDecoder::new\(MAX_BODY_BYTES\)/,
    'read_chunked must construct the codec ChunkedDecoder',
  );
  assert.match(
    http1,
    /codec::ChunkedStep::Done => return Ok\(decoder\.into_body\(\)\)/,
    'read_chunked must return the decoder body on Done',
  );
  assert.match(
    http1,
    /codec::ChunkedStep::NeedMore =>/,
    'read_chunked must bridge codec::ChunkedStep::NeedMore to stream.read',
  );
  // EOF tolerance: a clean / UnexpectedEof close while NeedMore must
  // surface the partial body (matches the previous hand-rolled
  // WAF-cut-the-socket tolerance, now driven by ChunkedDecoder::into_body).
  assert.match(
    http1,
    /UnexpectedEof[\s\S]{0,80}return Ok\(decoder\.into_body\(\)\)/,
    'mid-stream UnexpectedEof must yield the partial body via into_body',
  );
  assert.equal(
    /size_line\.split\(';'\)/.test(http1),
    false,
    'inline chunk-ext split must be removed (lives in zp-transport-codec)',
  );
  assert.equal(
    /u64::from_str_radix\(size_hex, 16\)/.test(http1),
    false,
    'inline hex chunk-size parse must move to zp-transport-codec',
  );
  assert.equal(
    /fn read_line\b/.test(http1),
    false,
    'dead read_line helper must be removed (ChunkedDecoder owns line consumption)',
  );
  assert.equal(
    /fn consume_trailers\b/.test(http1),
    false,
    'dead consume_trailers helper must be removed (ChunkedDecoder owns trailer drain)',
  );
  assert.equal(
    http1.includes('fn is_token'),
    false,
    'inline is_token helper must move to zp-transport-codec',
  );
  assert.equal(
    /TODO\(test\)/.test(http1),
    false,
    'http1.rs TODO(test) marker must be retired (codec carries the tests)',
  );

  // Workspace must declare the crate so cargo picks the host tests up.
  const rootCargo = fs.readFileSync('Cargo.toml', 'utf8');
  assert.match(rootCargo, /"crates\/zp-transport-codec"/);
  assert.match(rootCargo, /zp-transport-codec = \{ path = "crates\/zp-transport-codec" \}/);
});

test('D2 follow-on: sourcemap chain (rewriter_map ∘ original_map)', () => {
  // The original D2 composer mapped rewritten → bundled.js. Sites that
  // ship TypeScript via a bundler also publish a `bundled.js.map`; the
  // chained composer walks the upstream map so DevTools resolves
  // rewritten → original.ts in one hop. Best-effort — when the upstream
  // map is missing / malformed, the chained path silently falls back
  // to the unchained composer.
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  const bundleLib = fs.readFileSync('crates/zp-bundle/src/lib.rs', 'utf8');
  const rewriterLib = fs.readFileSync('crates/zp-rewriter/src/lib.rs', 'utf8');

  // WASM export must be present.
  assert.match(
    bundleLib,
    /#\[wasm_bindgen\(js_name = composeSourceMapChained\)\]/,
    'composeSourceMapChained WASM export must exist',
  );
  assert.match(
    bundleLib,
    /zp_rewriter::compose_source_map_chained\(source, &opts, target_url, original_map_json\)/,
    'export must call zp_rewriter::compose_source_map_chained with the wasm-passed args',
  );
  // Rust public API + re-export from the crate root.
  assert.match(
    rewriterLib,
    /pub use sourcemap::\{chain_with_original_map, compose_rewrite_map\}/,
    'zp-rewriter must re-export chain_with_original_map',
  );
  assert.match(
    rewriterLib,
    /pub fn compose_source_map_chained\(/,
    'compose_source_map_chained must be the public entry on zp-rewriter',
  );
  // SW: composeSourceMap (unchained) MUST be on the ZPBundle frozen
  // object. The previous build referenced it without defining it — the
  // /zp/api/sourcemap route always 503'd. Pin so a future rename or
  // accidental removal can't silently re-introduce the regression.
  assert.match(
    sw,
    /composeSourceMap: \(source, kind, targetUrl\) =>\s*wbg\.composeSourceMap\(/,
    'ZPBundle.composeSourceMap (unchained) must be defined',
  );
  // SW: composeSourceMapChained is optional (older bundles miss it);
  // when present, must be wired to wbg.composeSourceMapChained.
  assert.match(
    sw,
    /composeSourceMapChained: typeof wbg\.composeSourceMapChained === 'function'/,
    'ZPBundle.composeSourceMapChained must feature-detect',
  );
  // SW route must call fetchOriginalSourceMap + prefer the chained
  // composer when an upstream map is available.
  assert.match(
    sw,
    /async function fetchOriginalSourceMap\(source, target, tab\)/,
    'fetchOriginalSourceMap helper must exist',
  );
  assert.match(
    sw,
    /const originalMapJson = await fetchOriginalSourceMap\(source, target, tab\)\.catch\(\(\) => ''\)/,
    'sourcemap route must call fetchOriginalSourceMap before composing',
  );
  assert.match(
    sw,
    /const mapJson = originalMapJson && typeof self\.ZPBundle\.composeSourceMapChained === 'function'/,
    'sourcemap route must prefer the chained composer when an upstream map exists',
  );
  // Pragma detection: tolerate both `//#` and legacy `//@` and pick the
  // last pragma per Source Map v3 §A.3 (last-wins).
  assert.match(
    sw,
    /\/\\\/\\\/\[#@\]\\s\*sourceMappingURL=/,
    'fetchOriginalSourceMap regex must accept //# and //@ markers',
  );
  // data: URI parse must reject non-JSON payloads (e.g. binary blobs)
  // so the chained composer doesn't choke.
  assert.match(
    sw,
    /if \(!decoded\.trimStart\(\)\.startsWith\('\{'\)\) return ''/,
    'data: URI sourceMappingURL must reject non-JSON payloads',
  );
});

test('fingerprint hardening: navigator.webdriver + window.chrome facade', () => {
  // Real Chrome 148 has window.chrome.csi() / .loadTimes() / .app and
  // returns navigator.webdriver === false outside CDP. WebView2 +
  // Tauri (the host shell taskweaver runs in) deviates on both
  // counts (.webdriver may be true; chrome.webview leaks the Tauri
  // ipc shape). Anti-bot WAFs probe these shapes — install a plausible
  // facade so target pages can't distinguish ZeroProxy from a real
  // Chrome.
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  assert.match(
    rt,
    /defineAccessor\(proto, 'webdriver', \(\) => false\)/,
    'navigator.webdriver must be pinned to false on Navigator.prototype',
  );
  assert.match(
    rt,
    /defineAccessor\(nav, 'webdriver', \(\) => false\)/,
    'navigator.webdriver must be pinned to false on the navigator instance',
  );
  assert.match(
    rt,
    /function installChromeFingerprintFacade\(w\)/,
    'chrome facade installer must exist',
  );
  // Replace whatever WebView2/Tauri put on window.chrome before
  // installing our own — keeping `chrome.webview` would defeat the
  // hardening entirely.
  assert.match(
    rt,
    /try \{ delete w\.chrome; \} catch \{\}[\s\S]{0,200}Object\.defineProperty\(w, 'chrome'/,
    'installChromeFingerprintFacade must drop the existing window.chrome before installing ours',
  );
  // installChromeFingerprintFacade must be called from
  // installNavigatorIdentity so it runs during the standard install
  // sequence (NavigatorIdentity step).
  assert.match(
    rt,
    /function installNavigatorIdentity\(w\)[\s\S]{0,2000}installChromeFingerprintFacade\(w\);[\s\S]{0,40}\n  \}/,
    'installNavigatorIdentity must call installChromeFingerprintFacade before returning',
  );
  // Plausible Chrome 148 csi() / loadTimes() / app shapes — probes
  // check the return-value KEYS, not the values.
  assert.match(rt, /function chromeCsi/);
  assert.ok(rt.includes('startE:') && rt.includes('onloadT:') && rt.includes('pageT:') && rt.includes('tran:'),
    'chrome.csi() return shape must include {startE, onloadT, pageT, tran}');
  assert.match(rt, /function chromeLoadTimes/);
  assert.ok(rt.includes('requestTime:') && rt.includes('firstPaintTime:') && rt.includes('connectionInfo:'),
    'chrome.loadTimes() return shape must include {requestTime, firstPaintTime, connectionInfo}');
  assert.match(
    rt,
    /isInstalled: false[\s\S]{0,200}InstallState[\s\S]{0,200}RunningState/,
    'chrome.app must expose {isInstalled, InstallState, RunningState}',
  );
  // The facade object must NOT expose `webview:` or `runtime:` keys.
  // chrome.webview is the Tauri/WebView2 host-ipc surface (worst tell);
  // chrome.runtime is undefined off-extension on real Chrome. The
  // documentation comment in runtime-prelude.js mentions `chrome.webview`
  // by name — that's fine and excluded from this check; what's not fine
  // is a `webview:` key on the returned facade.
  const facadeBlock = rt.slice(
    rt.indexOf('function buildChromeFingerprint'),
    rt.indexOf('function installPopupHooks'),
  );
  assert.ok(facadeBlock.length > 0, 'buildChromeFingerprint block must exist');
  assert.equal(
    /^\s*webview\s*:/m.test(facadeBlock),
    false,
    'facade object must not declare a webview key (would re-leak the WebView2 ipc surface)',
  );
  assert.equal(
    /^\s*runtime\s*:/m.test(facadeBlock),
    false,
    'facade object must not declare a runtime key (real Chrome leaves it undefined off-extension)',
  );
  // Symbol audit: every ZeroProxy install marker must be
  // description-less so getOwnPropertySymbols(window).map(s => s.description)
  // returns a list of `undefined` entries instead of the obvious
  // "zeroproxy.*" tells the previous build leaked.
  assert.equal(
    /Symbol\.for\(\s*['"]zeroproxy/.test(rt),
    false,
    'no Symbol.for("zeroproxy.*") allowed — markers must be description-less Symbol() so anti-bot probes get no string match',
  );
});

test('C1: WS closing handshake defers finish until port ack (RFC 6455 §7.1.6)', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  // Prelude no longer carries the pre-C1 TODO marker — the deferred
  // finish() is the close-handshake landing.
  assert.equal(rt.includes('TODO(C1-transport)'), false, 'pre-C1 close-handshake TODO must be retired');
  // close() posts the close frame to the port and DOES NOT immediately
  // call finish(): the port handler (line ~1531) calls finish() when the
  // Rust ws_client surfaces the server's close echo. Match the structure
  // of the close() method: send postMessage then wire a guard timer.
  assert.match(
    rt,
    /this\._port\.postMessage\(\{\s*type:\s*'close',\s*code:\s*finalCode,\s*reason:\s*finalReason\s*\}\)\s*;\s*const\s+ws\s*=\s*this\s*;[\s\S]{0,200}setTimeout\(/,
    'close() must post the close frame and arm a guard timer instead of calling finish() inline',
  );
  // Guard must fall back to 1006 (abnormal closure) if the peer never
  // echoes the close — defense against a hung transport.
  assert.match(
    rt,
    /setTimeout\(\(\)\s*=>\s*\{[\s\S]{0,120}finish\(ws,\s*1006,\s*''\s*,\s*false\)/,
    'guard timer must finish with 1006 if the close handshake never completes',
  );
  // finish() clears the guard so a successful close echo doesn't leak
  // a timer.
  assert.match(rt, /ws\._closeGuard[\s\S]{0,80}clearTimeout\(ws\._closeGuard\)/, 'finish() must clear the close guard timer');
  // SW must forward the page-supplied code/reason to stream.close() so
  // the WS close frame on the wire carries the caller's choice
  // (RFC 6455 §7.1.4 / §5.5.1). The old call passed no args.
  assert.match(
    sw,
    /m\.type === 'close'\)\s*\{\s*try\s*\{\s*stream\.close\(m\.code,\s*m\.reason\)/,
    'SW must forward the page-supplied close code/reason to the Rust ws_client',
  );
  // stream.delete is deferred until the Rust handler fires (close echo)
  // so the close handler can still drain a server-close-arrives-first
  // race.
  assert.equal(
    /m\.type === 'close'\)\s*\{[^}]*streams\.delete\(id\)/.test(sw),
    false,
    'streams.delete must not run on page-initiated close — wait for Rust close echo',
  );
});

test('zp-bundle WASM export uses patch-mode under the hood', () => {
  const bundle = fs.readFileSync('crates/zp-bundle/src/lib.rs', 'utf8');
  // The WASM export must call the patch-only crate API — otherwise we pay
  // the O(n) re-emit cost on the Rust side and only save on the wire.
  assert.ok(
    bundle.includes('zp_rewriter::rewrite_script_patches(source, &opts)'),
    'rewriteScriptPatches WASM export must call rewrite_script_patches (not the full re-emit path)',
  );
});

test('D1: javascript: URL routing client-side handler', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  assert.ok(rt.includes('data-zp-jsurl'), 'runtime must dispatch data-zp-jsurl attribute');
  assert.ok(rt.includes('runJSURL'), 'runJSURL helper missing');
  assert.ok(rt.includes('Native.FunctionCtor'), 'rewritten body must use prelude-private FunctionCtor');
});

test('anchor escape vector: zp-htmltx + prelude + launcher ?via= handler', () => {
  const htmltx = fs.readFileSync('crates/zp-htmltx/src/lib.rs', 'utf8');
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  const launcher = fs.readFileSync('web/index.html', 'utf8');
  // Rust SSR rewrite: anchor/area/form/input/button URL attributes
  // produce proxy-origin `?via=` URLs + data-zp-target-url stash.
  assert.ok(
    htmltx.includes('proxied_navigation_url'),
    'zp-htmltx must define proxied_navigation_url helper'
  );
  assert.ok(
    /is_navigation\s*=\s*matches!\([\s\S]*?\("a",\s*"href"\)[\s\S]*?\("form",\s*"action"\)/.test(htmltx),
    'zp-htmltx main loop must dispatch a/area/form/formaction through is_navigation branch'
  );
  // Page-side prelude mirror: proxyViaURL helper.
  assert.ok(rt.includes('function proxyViaURL'), 'runtime-prelude must define proxyViaURL');
  // installURLProp setter must write the proxy URL (not raw target) to
  // the DOM attribute.
  assert.ok(
    /setAttribute\(attrName,\s*proxyViaURL\(t\)\)/.test(rt),
    'installURLProp setter must route raw attribute through proxyViaURL'
  );
  // setAttribute wrap usesRaw branch must also route through proxyViaURL.
  assert.ok(
    /usesRaw \? proxyViaURL\(t\) : t/.test(rt),
    'setAttribute wrap usesRaw branch must call proxyViaURL'
  );
  // page-side transformHTML walker must process every node through the
  // navigation backstop — same-name silent-skip bug from the 2026-06-06
  // follow-up commit.
  assert.ok(
    /applyNavigationBackstop\(node\)/.test(rt),
    'transformHTML walker must dispatch every node through applyNavigationBackstop'
  );
  // Launcher must convert `?via=<target>` into a real share entry.
  assert.ok(launcher.includes('async function handleVia'), 'launcher must define handleVia');
  assert.ok(
    /params\.get\(['"]via['"]\)/.test(launcher),
    'handleVia must read the via search param'
  );
  assert.ok(
    /await handleVia\(\)/.test(launcher),
    'launcher main entry must await handleVia before handleShare'
  );
});

test('active browsing emits only encrypted prefixed p routes', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  assert.equal(sw.includes('/v/'), false, 'service worker must not produce legacy /v routes');
  assert.equal(rt.includes('/v/'), false, 'runtime must not produce legacy /v routes');
  assert.ok(sw.includes('PROXY_DOCUMENT'), 'service worker must handle /zp/p documents');
  assert.ok(rt.includes('makeShareURL'), 'runtime navigation must use encrypted /p share URLs');
});

// 2026-06-08 rustls fork patch: tolerate unknown TLS 1.3 CertificateEntry
// extensions. Upstream rustls 0.23 only models `StatusRequest` in
// `CertificateExtensions` and rejects everything else (notably SCT /
// signed_certificate_timestamp delivered via RFC 6962 TLS path) with
// `InvalidMessage::UnknownCertificateExtension`. Cloudflare-fronted
// origins (example.com etc.) hit this path; without the patch the
// matrix harness lost example.com after our matrix expansion. The
// patch makes the unknown-extension closure return Ok(()) — rustls
// `read_one` consumes the extension body via `r.sub(len)?` before
// invoking the closure, so dropping the error is sound.
//
// This test pins the patched closure so a future upstream resync
// (`UPSTREAM` file bumped + sources refreshed) can't silently lose
// the fix and re-break every Cloudflare-fronted target.
test('rustls fork patch: CertificateExtensions tolerates unknown TLS 1.3 cert-entry extensions', () => {
  const upstream = fs.readFileSync('third_party-rustls-fork/UPSTREAM', 'utf8');
  assert.match(upstream, /rustls-0\.23/, 'fork must declare its upstream base version');
  const handshake = fs.readFileSync('third_party-rustls-fork/src/msgs/handshake.rs', 'utf8');
  // The patched closure inside `Codec for CertificateExtensions::read`
  // must return Ok(()) for unknown extensions, NOT
  // `Err(InvalidMessage::UnknownCertificateExtension)`.
  const certExtRead = handshake.match(/impl<'a> Codec<'a> for CertificateExtensions<'a>[\s\S]*?fn read\(r:[\s\S]*?Ok\(out\)\s*\n\s*\}/);
  assert.ok(certExtRead, 'CertificateExtensions::read must be locatable in the fork');
  assert.match(
    certExtRead[0],
    /out\.read_one\(&mut sub, \|_unk\| Ok\(\(\)\)\)/,
    'CertificateExtensions::read closure must return Ok(()) on unknown ext (rustls fork patch 2026-06-08)',
  );
  assert.equal(
    /Err\(InvalidMessage::UnknownCertificateExtension\)/.test(certExtRead[0]),
    false,
    'CertificateExtensions::read must NOT error on unknown ext (would reject SCT-in-TLS Cloudflare origins)',
  );
});

// 2026-06-08 D5 polish: SDP candidate munging + pion default
// interceptors (NACK / PLI / REMB / transport-cc) so the WebRTC
// gateway no longer leaks internal-interface host candidates and
// real-world media RTCP works through the SFU bridge. Pins:
//   - rtcgw.Config has AllowedExternalIPs field
//   - stripDisallowedCandidates + allowedSet helpers exist
//   - gateway answer emission routes through the munger
//   - api built with WithInterceptorRegistry + RegisterDefaultInterceptors
//   - main.go exposes `-rtc-allowed-ips`
test('D5 polish: SDP candidate munging + RTCP interceptors', () => {
  const server = fs.readFileSync('internal/rtcgw/server.go', 'utf8');
  assert.match(server, /AllowedExternalIPs\s+\[\]string/, 'Config must carry AllowedExternalIPs');
  assert.match(server, /func stripDisallowedCandidates\(sdp string, allowed map\[string\]struct\{\}\) string/, 'stripDisallowedCandidates helper must exist');
  assert.match(server, /func allowedSet\(addrs \[\]string\) map\[string\]struct\{\}/, 'allowedSet helper must exist');
  assert.match(server, /stripDisallowedCandidates\(ans\.SDP, allowedSet\(g\.cfg\.AllowedExternalIPs\)\)/, 'answer emission must route through the munger');
  assert.match(server, /RegisterDefaultInterceptors/, 'gateway api must register pion default interceptors');
  assert.match(server, /webrtc\.WithInterceptorRegistry/, 'gateway api must be built with InterceptorRegistry');
  const mainGo = fs.readFileSync('cmd/zeroproxy-server/main.go', 'utf8');
  assert.match(mainGo, /"rtc-allowed-ips"/, 'Go server must expose -rtc-allowed-ips flag');
});

// 2026-06-09 D5 embedded TURN. pion/turn/v4 spun in-process when
// `-rtc-turn-addr` is set, short-term TURN-REST creds re-issued on
// each /zp/api/config fetch. Pins:
//   - rtcgw.NewTURNServer + TURNConfig + ICEServerCred exist
//   - main.go has -rtc-turn-addr / -rtc-turn-external-ip / etc flags
//   - serveConfig emits rtcICEServers field
//   - SW threads rtcICEServers from /zp/api/config into boot JSON
//   - runtime-prelude ZPRTCPC reads boot.rtcICEServers (not force-empty)
test('D5 embedded TURN: pion/turn server + short-term creds + page-realm iceServers wiring', () => {
  const turn = fs.readFileSync('internal/rtcgw/turn.go', 'utf8');
  assert.match(turn, /func NewTURNServer\(cfg TURNConfig\) \(\*TURNServer, error\)/, 'NewTURNServer must exist');
  assert.match(turn, /type ICEServerCred struct/, 'ICEServerCred type must exist');
  assert.match(turn, /func \(s \*TURNServer\) IssueICEServerCreds\(/, 'IssueICEServerCreds method must exist');
  assert.match(turn, /GenerateLongTermTURNRESTCredentials/, 'must use pion long-term TURN-REST helper');
  const mainGo = fs.readFileSync('cmd/zeroproxy-server/main.go', 'utf8');
  assert.match(mainGo, /"rtc-turn-addr"/, 'main.go must expose -rtc-turn-addr');
  assert.match(mainGo, /"rtc-turn-external-ip"/, 'main.go must expose -rtc-turn-external-ip');
  assert.match(mainGo, /"rtc-turn-secret"/, 'main.go must expose -rtc-turn-secret');
  assert.match(mainGo, /rtcgw\.NewTURNServer\(/, 'main.go must call rtcgw.NewTURNServer when -rtc-turn-addr set');
  assert.match(mainGo, /s\.rtcTURN/, 'main.go server struct must carry rtcTURN field');
  assert.match(mainGo, /"rtcICEServers":/, 'serveConfig must emit rtcICEServers field');
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.match(sw, /rtcICEServers:\s*Array\.isArray\(cfg\.rtcICEServers\)/, 'SW refreshRuntimeConfig must parse rtcICEServers array');
  assert.match(sw, /rtcICEServers:\s*Array\.isArray\(runtimeConfig\.rtcICEServers\)/, 'SW boot JSON must thread rtcICEServers');
  const prelude = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  assert.match(prelude, /boot\.rtcICEServers/, 'runtime-prelude must read boot.rtcICEServers');
  assert.match(prelude, /safeConfig\.iceServers\s*=\s*issuedICEServers/, 'ZPRTCPC must assign embedded TURN creds to native iceServers (not force-empty)');
});

// 2026-06-09 NAVER anti-bot User-Agent override: page-side
// `HeadlessChrome` UA (puppeteer / WebView2 in some configs) used to
// reach the upstream because `new Headers(opt.request.headers)`
// preserved it through the first entries() loop, beating the later
// `pushOnce('user-agent', ZP.TARGET_USER_AGENT)` no-op. NAVER WAF
// instantly 403'd everything containing `HeadlessChrome`. Fix:
// pushOnce(TARGET_USER_AGENT) BEFORE the entries() loop so the
// canonical Chrome 148 UA wins regardless of what the page realm
// supplied. Verified by `node scripts/probe-naver.mjs https://www.naver.com/`
// — console errors dropped from 28 → 2 (the 2 remaining are unrelated
// CSP `frame-ancestors` warning + one stray 403 deeper in the ad SDK
// chain).
test('NAVER anti-bot fix: SW force-overrides page-side User-Agent before forward', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  // Locate the FIRST entries() loop in sw.js (it's inside
  // transportFetch's header build) and verify a pushOnce of the
  // canonical UA precedes it. Regex used on the whole file because
  // transportFetch is multi-hundred-line and lazy `\n}\n` matches
  // pickup nested arrow-function closings before the real end.
  const uaIdx = sw.search(/pushOnce\('user-agent',\s*ZP\.TARGET_USER_AGENT\);\s*\n\s*for \(const \[k, v\] of headers\.entries\(\)\) pushOnce/);
  assert.ok(uaIdx > 0,
    'SW must pushOnce(user-agent, ZP.TARGET_USER_AGENT) immediately BEFORE the headers.entries() loop — otherwise puppeteer/WebView2 HeadlessChrome UA leaks through and triggers NAVER WAF 403');
});

// 2026-06-09 perf telemetry: SW exposes rewrite-cache hit ratio +
// rewriter latency + cache-key SHA-256 share via __zpKernelProbe.
// Pinned so future tuning has stable data — also so a refactor
// can't silently drop the counters (cache hit rate is the single
// most important perf signal in trap notebook entries).
test('perf telemetry: SW exposes rewrite cache hit/miss + latency counters', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.match(sw, /const rewriteStats = \{/, 'rewriteStats counter object must exist');
  for (const field of ['hits', 'misses', 'rewriteLatencyMs', 'cacheKeyLatencyMs', 'invocations']) {
    assert.match(sw, new RegExp(`${field}:\\s*[\\d.+\\-/* ]`), `rewriteStats must declare ${field}`);
  }
  assert.match(sw, /rewriteStats\.hits\+\+/, 'cache hits must increment rewriteStats.hits');
  assert.match(sw, /rewriteStats\.misses\+\+/, 'cache misses must increment rewriteStats.misses');
  assert.match(sw, /rewriteStats\.rewriteLatencyMs \+= performance\.now\(\) - rewriteT0/, 'rewrite latency must be timed');
  assert.match(sw, /rewriteStats\.cacheKeyLatencyMs \+= performance\.now\(\) - keyT0/, 'cache-key SHA-256 latency must be timed');
  assert.match(sw, /rewriteStats:\s*\{[\s\S]*?hitRatio:/, '__zpKernelProbe must emit rewriteStats with hitRatio');
});

// 2026-06-10 NAVER 광고/트래커 instant-stub. NAVER WAF 가 비신뢰 IP 에서
// 광고/anti-bot 트래커 endpoint 를 60s slow-lane → page hydration chain
// 의 await 가 1분 hang. dogfood UX 우선으로 세 host 모두 stub:
//   - nam.veta.naver.com (광고 bid) → 204
//   - siape.veta.naver.com (sidebar 광고) → 204
//   - ntm.pstatic.net (트래커 WASM) → 200 빈 .js (광고 trade-off 수용)
// ntm 은 trap notebook 2026-06-02 "block 시 광고 모두 about:blank" 함정이
// 있지만, 이미 nam.veta/siape.veta stub 으로 광고 인벤토리가 채워지지 않아서
// 손해 boundary 작음. production deployment 시 광고 표시 원하면 ntm 만 list
// 에서 제외 + 첫 진입 1분 wait 복귀.
test('NAVER 광고/트래커 instant-stub: nam.veta + siape.veta (204) + ntm.pstatic.net (200 stub.js)', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.match(sw, /const NAVER_AD_BID_STUB_HOSTS = new Set\(\[/, 'stub list constant must exist');
  assert.match(sw, /'nam\.veta\.naver\.com'/, 'nam.veta must be stubbed');
  assert.match(sw, /'siape\.veta\.naver\.com'/, 'siape.veta must be stubbed');
  assert.match(sw, /'ntm\.pstatic\.net'/, 'ntm.pstatic.net must be stubbed (dogfood trade-off vs ads)');
  // 진입점 분기 + script vs non-script 응답 분기
  assert.match(sw, /NAVER_AD_BID_STUB_HOSTS\.has\(stubHost\)/, 'transportFetch must short-circuit on stub host');
  assert.match(sw, /const isScript = stubHost === 'ntm\.pstatic\.net'/, 'ntm must respond as script (200 + content-type js)');
  // 2026-06-10 응답 shape 수정: 204 No Content 가 광고 SDK JSON.parse fail
  // → fallback content (binary garbage) 가 페이지에 inject 되는 회귀 가설.
  // 대신 200 + {} empty JSON 으로 응답해서 SDK 가 정상 parse 후 no-bid 처리.
  assert.match(sw, /const stubBody = isScript \? '\/\* zp:stub \*\/' : '\{\}'/, 'non-script stub must return empty JSON body');
  assert.match(sw, /'application\/json; charset=utf-8'/, 'non-script stub must declare application/json content-type');
  assert.match(sw, /'\/\* zp:stub \*\/'/, 'ntm response must be a no-op JS comment');
});

// 2026-06-11 NAVER 광고 SDK ES module stub — `ssl.pstatic.net/tveta/libs/
// glad/.../gfp-display-*` 매치 시 빈 ES module 반환. dynamic import 실패
// 가 광고 SDK init chain hang 시켜서 메뉴 binding 함수가 attach 안 되는
// 회귀 (사용자 보고 햄버거 메뉴 무동작).
test('NAVER ad SDK module stub list 존재 (현재 비활성 — stub 회귀로 empty)', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.match(sw, /const NAVER_AD_MODULE_STUB_PATTERNS = \[\];/, 'module stub list 는 현재 empty (회귀 방지 — glog-logger stub 이 "t is not a constructor" 유발)');
  assert.match(sw, /NAVER_AD_MODULE_STUB_PATTERNS/, 'transportFetch 진입점에 pattern list 분기는 유지 (향후 재활성화)');
});

// 2026-06-11 Launcher ready boundary 정확화. 이전엔 `bundleReady &&
// kernelFetch === 'function'` 만 검사 → `self.kernelFetch` property 가
// 설정됐어도 `ZPKernel.ready === false` 인 race window 존재. 사용자가
// "ready 표시 후 Open click 했는데 접속 안 됨" 보고. `kernelReady`
// 추가 검사로 정확한 ready boundary 확보.
test('launcher ready boundary: bundleReady + kernelReady + kernelFetch === function', () => {
  const html = fs.readFileSync('web/index.html', 'utf8');
  assert.match(html, /probe\.bundleReady && probe\.kernelReady && probe\.kernelFetch === 'function'/,
    'launcher must require kernelReady (not just kernelFetch property) before showing Ready');
});

// 2026-06-10 NAVER dynamic thumbnail proxy stub — `s.pstatic.net/dthumb.phinf/...`
// 가 NAVER WAF 의 추가 slow-lane endpoint (20s+ wait × N) 라 page hydration
// 가 1분+ 걸림. 1×1 transparent PNG 로 stub → 즉시 hydration, thumbnail
// 빈 자리 trade-off (dogfood 우선).
test('NAVER dthumb.phinf stub: 1×1 transparent PNG via path-prefix match', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.match(sw, /const NAVER_IMAGE_STUB_PATHS = \[/, 'image stub list must exist');
  assert.match(sw, /host: 's\.pstatic\.net', pathPrefix: '\/dthumb\.phinf'/, 's.pstatic.net dthumb.phinf must be stubbed');
  assert.match(sw, /const TRANSPARENT_PNG_BYTES = Uint8Array\.from/, '1×1 transparent PNG bytes must be defined');
  assert.match(sw, /urlParts\.pathname\.startsWith\(pathPrefix\)/, 'path-prefix match must use pathname.startsWith');
  assert.match(sw, /'image\/png'/, 'stub response must declare image/png content-type');
});

// 2026-06-11 SW response cache 임시 비활성화 — dynamic ES module import
// 회귀 (gfp-display-glog-logger.js instantiate fail) 로 인해 cache hit
// path 가 module realm 과 호환 안 됨. dogfood UX 우선으로 cache 제거.
// helper 와 cache version key 는 향후 재활성화 위해 코드에 유지.
test('SW response cache: helpers + version key 유지, hit/put path 는 임시 비활성화', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.match(sw, /const RESPONSE_CACHE_NAME = 'zp-resp-v1'/, 'cache version key 유지 (재활성화 위해)');
  assert.match(sw, /async function tryRespCacheGet\(/, 'cache helper 유지');
  assert.match(sw, /async function tryRespCachePut\(/, 'cache helper 유지');
  assert.match(sw, /SW response cache 임시 비활성화/, 'disable 주석으로 의도 명시');
});

// 2026-06-10 body type handling: transportFetch must accept Uint8Array,
// ArrayBuffer, AND Blob/FormData-like (.arrayBuffer()) without crashing.
// 함정: runtimeAPI 의 /zp/api/fetch path 는 `ZP.base64UrlToBytes` 결과인
// **Uint8Array** 를 body 로 전달. 기존 `body instanceof ArrayBuffer ?
// body : await body.arrayBuffer()` 분기는 Uint8Array 가 ArrayBuffer 도
// 아니고 .arrayBuffer() 메서드도 없어서 TypeError 발생 → NAVER preload.js
// 첫 POST 에서 hydration 전체 중단.
test('transportFetch body extraction handles Uint8Array + ArrayBuffer + Blob-like', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.match(sw, /body instanceof Uint8Array/, 'must short-circuit Uint8Array');
  assert.match(sw, /body instanceof ArrayBuffer/, 'must handle ArrayBuffer');
  assert.match(sw, /typeof body\.arrayBuffer === 'function'/, 'must guard .arrayBuffer() call with typeof check');
});

// 2026-06-09 cross-host 3xx redirect rewrap: SW must swallow upstream 3xx
// + recurse instead of forwarding the Location header to the client.
// 함정: 그대로 forward 하면 브라우저가 raw Location URL 로 native nav,
// share URL escape + URL bar 가 raw target host 노출 (NAVER 페이 link
// → nid.naver.com escape 가 정확히 이 경로였음, 2026-06-09 trap notebook).
// SW 가 redirect 를 swallow + recurse + entry.targetUrl 업데이트하면
// (a) URL bar = share URL 유지, (b) fragment (k=…&server=…) 보존,
// (c) virtual location state 정확.
test('cross-host 3xx redirect: SW swallows upstream redirect and recurses (no client-side rewrap)', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  // 3xx 감지 후 recursive transportFetch 호출
  assert.match(sw, /resp\.status >= 300 && resp\.status < 400/, 'transportFetch must detect 3xx');
  assert.match(sw, /MAX_REDIRECT_DEPTH/, 'depth limit must exist to prevent infinite loops');
  assert.match(sw, /__redirectDepth/, 'depth counter must be threaded through recursive opt');
  // 301/302/303 → GET, 307/308 → preserve method (RFC 7231 §6.4.4)
  assert.match(sw, /preserveMethod = resp\.status === 307 \|\| resp\.status === 308/, 'method preservation must follow RFC 7231');
  // entry.targetUrl 업데이트 (virtual location state 동기화)
  assert.match(sw, /entry\.targetUrl = resolvedUrl/, 'entry.targetUrl must update on redirect');
  assert.match(sw, /entry\.baseUrl = resolvedUrl/, 'entry.baseUrl must update on redirect');
  // recursive call 시 headers undefined 로 비워서 transportFetch 가 새 host
  // 기준 Cookie/Referer/Origin 재빌드 (cross-host 라면 cookie scope 바뀜)
  assert.match(sw, /headers: undefined/, 'recursive call must clear opt.headers so transportFetch rebuilds for new host');
});

// 2026-06-09 transport-stage perf telemetry. With rewriter at ~1% of
// NAVER cold-load wall time, the remaining 99% is in transport
// (yamux+TLS+h2 handshake + RTT + upstream body). Without per-fetch
// timing, any "make it faster" work shoots in the dark. The pinned
// counters surface cumulative + per-fetch latency so trap notebook
// entries can cite specific outliers (e.g. "naver.com /commercial:
// 4200 ms / 200 / 18 KB" → the slow lane is the analytics endpoint).
test('perf telemetry: SW exposes transport latency counters + ring buffer', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.match(sw, /const transportStats = \{/, 'transportStats counter object must exist');
  for (const field of ['requests', 'totalLatencyMs', 'totalBytes', 'errors']) {
    assert.match(sw, new RegExp(`${field}:\\s*0`), `transportStats must declare ${field}`);
  }
  assert.match(sw, /const transportLatencyLog = \[\];/, 'transportLatencyLog ring buffer must exist');
  assert.match(sw, /function logTransportEvent\(/, 'logTransportEvent helper must exist');
  // The kernelFetch wrapper must time BOTH success and error paths
  // (otherwise transport failures vanish from the telemetry and the
  // user can't distinguish "host unreachable" from "host slow").
  assert.match(sw, /const txT0 = performance\.now\(\);/, 'transportFetch must capture start time');
  assert.match(sw, /logTransportEvent\(u, method, 0, performance\.now\(\) - txT0, 0\);/, 'error path must log a transport event');
  assert.match(sw, /logTransportEvent\(u, method, \(resp && resp\.status\) \|\| 0, performance\.now\(\) - txT0, bodyLen\);/, 'success path must log a transport event');
  // Probe response must surface both cumulative + ring buffer.
  assert.match(sw, /transportStats:\s*\{[\s\S]*?avgLatencyMs:/, '__zpKernelProbe must emit transportStats with avgLatencyMs');
  assert.match(sw, /transportLatency: transportLatencyLog\.slice\(\),/, '__zpKernelProbe must emit transportLatency ring buffer');
});

// 2026-06-09 NAVER dynamic import fix: zp-rewriter's
// `visit_import_expression` rewrites `import("./mod.js")` literal
// sources to `/zp/api/script?u=<encoded-abs>&kind=module`. Before
// this fix, NAVER's `gfp-core.js` did `import('./gfp-display-glog-logger.js')`
// which resolved against the page realm's base (`proxy.localhost`)
// and 404'd. The fix routes the resolved absolute URL through the
// SW. Pins both the visitor entry + the minimal URL resolver
// (we explicitly avoid the `url` crate to stay under the 500 KB
// page bundle target — see Cargo.toml).
test('NAVER dynamic import fix: rewriter routes literal import() through /zp/api/script', () => {
  const rewriter = fs.readFileSync('crates/zp-rewriter/src/lib.rs', 'utf8');
  assert.match(rewriter, /fn visit_import_expression\(/, 'visitor must override visit_import_expression');
  assert.match(rewriter, /fn proxied_module_url\(/, 'proxied_module_url helper must exist');
  assert.match(rewriter, /fn resolve_module_base\(/, 'resolve_module_base helper must exist (replaces url crate)');
  assert.match(rewriter, /"\/zp\/api\/script\?u=\{encoded\}&kind=module"/, 'proxied URL must include kind=module');
  // The url crate would pull ~250 KB of ICU into the page bundle;
  // verify Cargo.toml does NOT depend on it.
  const cargo = fs.readFileSync('crates/zp-rewriter/Cargo.toml', 'utf8');
  assert.equal(/^url\s*=/m.test(cargo), false, 'zp-rewriter must NOT depend on the url crate (ICU bloat)');
  assert.match(cargo, /^percent-encoding\s*=/m, 'zp-rewriter must depend on percent-encoding for query encoding');
});

// 2026-06-09 E3 size guard: page bundle must stay ≤ 500 KB. The page
// realm wasm ships to every navigation, so it's the dominant cold-load
// cost. SW-side wasm artifacts (zp_bundle_sw + lazy zp_kernel_sw) are
// not gated here because (a) they ship once per origin, not per
// navigation, and (b) they carry the full transport + CSS rewriter +
// HTML transformer which are architecturally required for SW
// document/CSS interception.
//
// If a future change pushes the page bundle back over 500 KB, the
// trigger is almost always a new transitive dep — re-audit and either
// route the call through the SW or split-load.
test('E3 size guard: zp_page_bundle_bg.wasm ≤ 500 KB', () => {
  const wasmPath = 'dist/web/__zp/zp_page_bundle_bg.wasm';
  if (!fs.existsSync(wasmPath)) {
    // Skip when dist hasn't been built — CI gates on `npm run build`
    // before running tests, but local dev may run tests pre-build.
    return;
  }
  const size = fs.statSync(wasmPath).size;
  assert.ok(
    size <= 500 * 1024,
    `zp_page_bundle_bg.wasm = ${size} bytes (${(size / 1024).toFixed(1)} KB) > 500 KB hard target`,
  );
});

// 2026-06-08 puppeteer harness hardening for the real-site
// regression matrix:
//   (a) random ephemeral port — no orphan-process aliasing
//   (b) fail-fast on server-bind conflicts
//   (c) per-subtest BrowserContext isolation (SW + cookies + storage)
//   (d) retry-on-context-destroyed title polling for SPA redirects.
test('puppeteer real-site harness: random port + bind fail-fast + subtest isolation + context-destroyed retry', () => {
  const harness = fs.readFileSync('test/e2e/real-site-regression.test.js', 'utf8');
  assert.match(harness, /30000 \+ Math\.floor\(Math\.random\(\) \* 20000\)/, 'harness must pick a random ephemeral port');
  assert.match(harness, /bind:\.\*permitted\|address already in use/i, 'harness must fail-fast on bind conflicts');
  assert.match(harness, /browser\.createBrowserContext\(\)/, 'harness must create a fresh BrowserContext per subtest');
  assert.match(harness, /Execution context was destroyed\|Target closed/, 'title-retry loop must tolerate context destruction');
});
