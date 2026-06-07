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
  assert.ok(sw.includes("importScripts('/zp/assets/rust-rewriter.js')"));
  assert.equal(sw.includes("importScripts('/zp/assets/js-rewriter.js')"), false);
  assert.equal(sw.includes("importScripts('/zp/assets/oxc-parser.js')"), false);
  assert.ok(sw.includes('/zp/api/script'));
  assert.ok(sw.includes('rewriteScriptResponse'));
  assert.ok(build.includes('rewriter-rs'));
  assert.ok(build.includes('wasm-bindgen'));
  assert.ok(build.includes('ZPRewriter'));
  assert.ok(build.includes('ZPRustRewriter'));
  assert.ok(build.includes('phase3-rust-wasm-css'));
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
  const fetchRs = fs.readFileSync('crates/zp-bundle/src/kernel/transport/fetch.rs', 'utf8');
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
  const modRs = fs.readFileSync('crates/zp-bundle/src/kernel/mod.rs', 'utf8');
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

// 2026-06-08 split-bundle (c.1) Step 3: rewriter-rs/ crate is now CSS-only.
// All OXC dependencies removed from rewriter-rs/Cargo.toml + rewrite_script
// gone from rewriter-rs/src/lib.rs. The generated classic script (`rust-rewriter.js`)
// exposes only rewriteCSS on ZPRewriter/ZPRustRewriter.
test('rewriter-rs/ is CSS-only after Step 3', () => {
  const cargo = fs.readFileSync('rewriter-rs/Cargo.toml', 'utf8');
  const lib = fs.readFileSync('rewriter-rs/src/lib.rs', 'utf8');
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  // No OXC dependencies.
  assert.equal(/^oxc_/m.test(cargo), false, 'rewriter-rs Cargo.toml must NOT declare any oxc_* crate');
  // SWC CSS deps survive.
  assert.match(cargo, /^swc_css_ast\b/m, 'rewriter-rs must keep swc_css_ast');
  assert.match(cargo, /^swc_css_parser\b/m, 'rewriter-rs must keep swc_css_parser');
  // lib.rs: no rewrite_script + no OXC use statements.
  assert.equal(lib.includes('pub fn rewrite_script'), false, 'rewrite_script must be removed from rewriter-rs');
  assert.equal(/use oxc_/.test(lib), false, 'rewriter-rs lib.rs must not import any oxc_* crate');
  assert.match(lib, /pub fn rewrite_css\b/, 'rewrite_css must survive');
  // Generated rust-rewriter.js exposes ZPRewriter with rewriteCSS only.
  assert.match(build, /rewriteCSS:\s*rewriteCSSPublic/, 'rewriter-rs classic must expose rewriteCSS');
  // The old rewriteScript wrapper is gone from the generator (search for the
  // public wrapper name AND the WASM raw export call so an accidental partial
  // revert surfaces).
  assert.equal(build.includes('rewriteScript: rewriteScriptPublic'), false, 'rewriter-rs classic must NOT expose rewriteScript');
  assert.equal(build.includes('wasm_bindgen.rewrite_script'), false, 'rewriter-rs classic must NOT call rewrite_script');
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
  const ws = fs.readFileSync('crates/zp-bundle/src/kernel/transport/ws_client.rs', 'utf8');
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
  const modRs = fs.readFileSync('crates/zp-bundle/src/kernel/mod.rs', 'utf8');
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
  const socks5 = fs.readFileSync('crates/zp-bundle/src/kernel/transport/socks5.rs', 'utf8');
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

  const http1 = fs.readFileSync('crates/zp-bundle/src/kernel/transport/http1.rs', 'utf8');
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
