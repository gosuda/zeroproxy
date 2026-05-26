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
    "attributeFilter: ['href', 'src', 'srcdoc', 'action', 'formaction']",
    'enforceObservedAttribute',
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
    'getUserMedia',
    'geolocation',
    'installPhase2Membrane',
    '__zp_runClassic',
    '__zp_get',
    'FunctionCtor',
    "define(root, 'setTimeout'",
    "define(document, 'write'",
    'createContextualFragment',
    'parseFromString',
    'rewriteEventAttribute',
  ]) assert.ok(rt.includes(needle), `missing ${needle}`);
});

test('service worker waits for initialized WASM transport and cookie bridge', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  const kernel = fs.readFileSync('cmd/wasm-kernel/main.go', 'utf8');
  assert.ok(sw.includes('__zp_kernel_init'), 'service worker does not require transport init');
  assert.match(sw, /^importScripts\('\/__zp\/wasm_exec\.js'\);/m, 'wasm_exec must be imported during service worker installation');
  assert.ok(sw.includes('__zp_cookie_set'), 'service worker does not bridge document.cookie to kernel jar');
  assert.ok(sw.includes('runtimeTabForMessage'), 'service worker does not gate runtime messages by tab');
  assert.ok(sw.includes('runtimeMessageAuthorized'), 'service worker does not validate runtime capability tokens');
  assert.ok(sw.includes('runtimeToken: ZP.randomId'), 'service worker does not generate runtime capability tokens');
  assert.ok(sw.includes('X-ZP-Runtime-Token'), 'service worker does not pass runtime capability to documents');
  assert.ok(kernel.includes('js.Global().Set("__zp_kernel_init"'), 'kernel init export missing');
  assert.ok(kernel.includes('js.Global().Set("__zp_cookie_set"'), 'kernel cookie export missing');
  assert.ok(kernel.includes('Target host:'), 'kernel error page does not expose target host');
  assert.ok(sw.includes('Target host:'), 'service worker error page does not expose target host');
});

test('service worker response wrappers force nosniff', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.match(sw, /h\.set\('X-Content-Type-Options', 'nosniff'\)/);
  assert.match(sw, /'X-Content-Type-Options': 'nosniff'/);
});

test('phase 2 script rewriting pipeline is fail-closed', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  const rewriter = fs.readFileSync('web/js-rewriter.js', 'utf8');
  const core = fs.readFileSync('web/zp-core.js', 'utf8');
  const server = fs.readFileSync('cmd/zeroproxy-server/main.go', 'utf8');
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  assert.ok(sw.includes("importScripts('/__zp/js-rewriter.js')"));
  assert.ok(sw.includes('/__zp/api/script'));
  assert.ok(sw.includes('rewriteScriptResponse'));
  assert.ok(rewriter.includes('ZPRewriter'));
  assert.ok(rewriter.includes('phase2-oxc-abi-2'));
  assert.ok(sw.includes("importScripts('/__zp/oxc-parser.js')"));
  assert.ok(sw.includes('/__zp/oxc_parser_wasm_bg.wasm'));
  assert.ok(build.includes('@oxc-parser/wasm/web/oxc_parser_wasm.js'));
  assert.ok(build.includes('@oxc-parser/wasm/web/oxc_parser_wasm_bg.wasm'));
  assert.ok(build.includes('wasm_exec.js'));
  assert.equal(fs.existsSync('web/oxc-parser.js'), false);
  assert.equal(fs.existsSync('web/oxc_parser_wasm_bg.wasm'), false);
  assert.equal(fs.existsSync('web/wasm_exec.js'), false);
  assert.ok(rewriter.includes('blockSource'));
  assert.match(rt, /setAttributeNS/);
  assert.match(rt, /NamedNodeMap/);
  assert.match(rt, /Attr\.prototype/);
  assert.equal(/connect-src\s+\*/.test(core), false);
  assert.match(core, /connect-src 'self'/);
  assert.equal(/script-src \*/.test(core), false);
  assert.equal(/script-src \*/.test(server), false);
  assert.match(server, /connect-src 'self'/);
  assert.ok(sw.includes('MAX_REQUEST_BODY_BYTES'));
  assert.ok(sw.includes('REQUEST_BODY_TOO_LARGE'));
  assert.ok(fs.readFileSync('internal/swhttp/bridge_js.go', 'utf8').includes('GetBody'));
  assert.ok(fs.readFileSync('internal/shareurl/shareurl.go', 'utf8').includes('unsupported target URL'));
  assert.ok(server.includes('closeBoth'));
});

test('service worker names every required safe error class', () => {
  const core = fs.readFileSync('web/zp-core.js', 'utf8');
  for (const code of ['BAD_HMAC','INVALID_SHARE_LINK','MALFORMED_ROUTE','SW_NOT_READY','TARGET_PROTOCOL_BLOCKED','TLS_CERTIFICATE_INVALID','TLS_HANDSHAKE_FAILED','TARGET_CONNECT_FAILED','MALFORMED_HTML','REALM_INJECTION_FAILURE','REQUEST_BODY_TOO_LARGE','POLICY_BLOCKED']) {
    assert.ok(core.includes(code), `missing ${code}`);
  }
});

test('active browsing emits only encrypted p routes', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  assert.equal(sw.includes('/v/'), false, 'service worker must not produce legacy /v routes');
  assert.equal(rt.includes('/v/'), false, 'runtime must not produce legacy /v routes');
  assert.ok(sw.includes('PROXY_DOCUMENT'), 'service worker must handle /p documents');
  assert.ok(rt.includes('makeShareURL'), 'runtime navigation must use encrypted /p share URLs');
});
