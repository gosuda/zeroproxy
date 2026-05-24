const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('service worker has no unclassified native fetch fallback', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  assert.equal(/return\s+fetch\s*\(\s*event\.request\s*\)/.test(sw), false);
  assert.match(sw, /event\.respondWith\(handleFetch\(event\)\)/);
});

test('runtime avoids forbidden global deception hooks', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8');
  assert.equal(rt.includes('Function.prototype.toString'), false);
  assert.equal(rt.includes('Object.getOwnPropertyDescriptor ='), false);
  assert.equal(rt.includes('window.__zp'), false);
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
    "define(w.document, 'createElement'",
    "define(w, 'open'",
    "'appendChild'",
    "'insertBefore'",
    "'replaceChild'",
    "'insertAdjacentHTML'",
    "'getAttribute'",
    'installNetworkContainment',
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
  ]) assert.ok(rt.includes(needle), `missing ${needle}`);
});

test('service worker waits for initialized WASM transport and cookie bridge', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8');
  const kernel = fs.readFileSync('cmd/wasm-kernel/main.go', 'utf8');
  assert.ok(sw.includes('__zp_kernel_init'), 'service worker does not require transport init');
  assert.ok(sw.includes('__zp_cookie_set'), 'service worker does not bridge document.cookie to kernel jar');
  assert.ok(kernel.includes('js.Global().Set("__zp_kernel_init"'), 'kernel init export missing');
  assert.ok(kernel.includes('js.Global().Set("__zp_cookie_set"'), 'kernel cookie export missing');
  assert.ok(kernel.includes('Target host:'), 'kernel error page does not expose target host');
  assert.ok(sw.includes('Target host:'), 'service worker error page does not expose target host');
});

test('service worker names every required safe error class', () => {
  const core = fs.readFileSync('web/zp-core.js', 'utf8');
  for (const code of ['BAD_HMAC','INVALID_SHARE_LINK','MALFORMED_ROUTE','SW_NOT_READY','TARGET_PROTOCOL_BLOCKED','TLS_CERTIFICATE_INVALID','TLS_HANDSHAKE_FAILED','TARGET_CONNECT_FAILED','MALFORMED_HTML','REALM_INJECTION_FAILURE','POLICY_BLOCKED']) {
    assert.ok(core.includes(code), `missing ${code}`);
  }
});
