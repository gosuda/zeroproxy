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

test('runtime membrane uses captured native WeakMap lookup for raw unwrapping', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  assert.ok(rt.includes('weakMapGet: w.WeakMap && w.WeakMap.prototype && w.WeakMap.prototype.get'));
  assert.ok(rt.includes('Native.reflectApply(Native.weakMapGet, membraneRawTargets, [value])'));
  assert.ok(rt.includes('Native.reflectApply ? Native.reflectApply(fn, rawBase, callArgs)'));
});

test('runtime reads boot config from self-removing prelude state', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  const tx = fs.readFileSync('internal/htmltx/transform.go', 'utf8');
  assert.ok(rt.includes('root.__ZP_BOOT'));
  assert.ok(rt.includes("delete root.__ZP_BOOT"));
  assert.ok(tx.includes("document.currentScript.remove()"));
  assert.equal(tx.includes('id=__zp-boot'), false);
  assert.equal(rt.includes("getElementById('__zp-boot')"), false);
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
    "attributeFilter: ['href', 'xlink:href', 'src', 'srcset', 'srcdoc', 'action', 'formaction', 'poster', 'integrity', 'type', 'rel', 'target', 'style', 'name', 'content']",
    'enforceObservedAttribute',
    'data-zp-integrity',
    'installIntegrityProp',
    'installScriptProp',
    'installLinkProp',
    'installResourceURLProps',
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
    'normalizeSameSite',
    'ZP_COOKIE_SYNC',
    'X-ZP-Tab-Id',
    'X-ZP-Runtime-Token',
    'syncReferrerPolicyElement',
    'documentReferrerPolicy',
    'src*="zp"',
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
    '__zp_assign',
    "define(root, 'setTimeout'",
    'installDocumentWriteHooks',
    'createContextualFragment',
    'parseFromString',
    'rewriteEventAttribute',
    'enforceSubtreePolicies',
    'installTargetServiceWorkerBlocker',
    'formRequestBody',
    'shareFragmentForKey',
    'postMessageWrapperFor',
    'Object, \'getPrototypeOf\'',
    'Reflect, \'getPrototypeOf\'',
  ]) assert.ok(rt.includes(needle), `missing ${needle}`);
});

test('service worker waits for initialized WASM transport and cookie bridge', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  const kernel = fs.readFileSync('cmd/wasm-kernel/main.go', 'utf8');
  assert.ok(sw.includes('__zp_kernel_init'), 'service worker does not require transport init');
  assert.match(sw, /^importScripts\('\/zp\/assets\/wasm_exec\.js'\);/m, 'wasm_exec must be imported during service worker installation');
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

test('phase 3 script rewriting pipeline is fail-closed', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
	  const core = fs.readFileSync('web/zp-core.js', 'utf8');
	  const server = fs.readFileSync('cmd/zeroproxy-server/main.go', 'utf8');
	  const htmltx = fs.readFileSync('internal/htmltx/transform.go', 'utf8');
	  const index = fs.readFileSync('web/index.html', 'utf8');
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
  assert.ok(build.includes('wasm_exec.js'));
  assert.equal(fs.existsSync('web/js-rewriter.js'), false);
  assert.equal(fs.existsSync('web/oxc-parser.js'), false);
  assert.equal(fs.existsSync('web/oxc_parser_wasm_bg.wasm'), false);
  assert.equal(fs.existsSync('web/wasm_exec.js'), false);
  assert.match(rt, /setAttributeNS/);
  assert.match(rt, /NamedNodeMap/);
  assert.match(rt, /Attr\.prototype/);
  assert.equal(/connect-src\s+\*/.test(core), false);
  assert.ok(core.includes("connect-src "));
	  assert.equal(/script-src \*/.test(core), false);
	  assert.equal(/script-src \*/.test(server), false);
	  assert.ok(core.includes("'unsafe-eval'"));
	  assert.equal(server.includes("'unsafe-eval'"), false);
	  assert.ok(core.includes("'wasm-unsafe-eval'"));
	  assert.ok(index.includes("'wasm-unsafe-eval'"));
	  assert.ok(core.includes("script-src 'self' 'nonce-zp' 'wasm-unsafe-eval'"));
	  assert.ok(core.includes("allowDynamicCompile"));
	  assert.ok(index.includes("script-src 'self' 'nonce-zp' 'wasm-unsafe-eval'"));
	  assert.ok(server.includes("script-src 'self' 'nonce-zp' 'wasm-unsafe-eval'"));
	  assert.ok(server.includes("script-src 'self' 'wasm-unsafe-eval'"));
	  assert.match(htmltx, /runtimePrelude[\s\S]*rust-rewriter\.js/);
	  assert.match(rt, /injectSrcdoc[\s\S]*rust-rewriter\.js/);
	  assert.equal(rt.includes('Reflect.construct(Native.FunctionCtor'), false);
	  assert.match(server, /connect-src 'self'/);
  assert.equal(core.includes('navigate-to'), false);
  assert.equal(server.includes('navigate-to'), false);
  assert.equal(sw.includes('MAX_REQUEST_BODY_BYTES'), false);
  assert.equal(sw.includes('pendingSubmissions'), false);
  assert.equal(sw.includes('ZP_SUBMIT_PREPARE'), false);
  assert.equal(sw.includes('zp_submit'), false);
  assert.equal(sw.includes('REQUEST_BODY_TOO_LARGE'), false);
  assert.ok(sw.includes('runtimeFetchContext'));
  assert.ok(sw.includes('scriptRequestContext'));
  assert.equal(/url\.pathname === '\/zp\/api\/fetch'[\s\S]{0,240}firstTab\(\)/.test(sw), false);
  assert.equal(sw.includes('firstTab'), false);
  const bridge = fs.readFileSync('internal/swhttp/bridge_js.go', 'utf8');
  assert.ok(bridge.includes('getReader'));
  assert.ok(bridge.includes('X-ZP-Upload-Replayable'));
  assert.ok(fs.readFileSync('internal/shareurl/shareurl.go', 'utf8').includes('unsupported target URL'));
  assert.ok(server.includes('closeBoth'));
});

test('service worker names every required safe error class', () => {
  const core = fs.readFileSync('web/zp-core.js', 'utf8');
  for (const code of ['BAD_HMAC','INVALID_SHARE_LINK','MALFORMED_ROUTE','SW_NOT_READY','TARGET_PROTOCOL_BLOCKED','TLS_CERTIFICATE_INVALID','TLS_HANDSHAKE_FAILED','TARGET_CONNECT_FAILED','MALFORMED_HTML','REALM_INJECTION_FAILURE','REQUEST_BODY_TOO_LARGE','SUBMISSION_EXPIRED','POLICY_BLOCKED']) {
    assert.ok(core.includes(code), `missing ${code}`);
  }
});

test('active browsing emits only encrypted prefixed p routes', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  assert.equal(sw.includes('/v/'), false, 'service worker must not produce legacy /v routes');
  assert.equal(rt.includes('/v/'), false, 'runtime must not produce legacy /v routes');
  assert.ok(sw.includes('PROXY_DOCUMENT'), 'service worker must handle /zp/p documents');
  assert.ok(rt.includes('makeShareURL'), 'runtime navigation must use encrypted /p share URLs');
});
