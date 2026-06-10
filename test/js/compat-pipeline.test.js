const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = (path) => fs.readFileSync(path, 'utf8');
const readHostPipeline = () =>
  [
    read('web/host-shell-entry.mjs'),
    read('web/runtime/resources/loader.mjs'),
    read('web/runtime/network/api.mjs'),
    read('web/runtime/network/gonetworkbackend.mjs'),
    read('web/runtime/dom/virtual-dom.mjs'),
    read('web/runtime/webapi/core.mjs'),
    read('web/runtime/quickjs/engine.mjs'),
  ].join('\n');

const legacyServiceWorkerPaths = [
  'web/sw.js',
  'web/sw-entry.mjs',
  'web/sw/kernel.js',
  'web/sw/routes.js',
  'web/sw/transport.js',
  'web/sw/responses.js',
];

test('QuickJS fetch, XHR, EventSource, and WebSocket route through GoNetworkBackend shims', () => {
  const api = read('web/runtime/network/api.mjs');
  const backend = read('web/runtime/network/gonetworkbackend.mjs');
  for (const needle of [
    'globalThis.fetch = fetch',
    'globalThis.XMLHttpRequest = XMLHttpRequest',
    'globalThis.EventSource = EventSource',
    'globalThis.WebSocket = WebSocket',
    'this.backend.fetchRaw',
    'this.backend.openWebSocket',
    'this.backend.setCookie',
    'this.backend.cancel',
  ]) {
    assert.ok(api.includes(needle), `missing ${needle}`);
  }
  assert.ok(backend.includes('class WorkerBackend'));
  assert.ok(backend.includes('class ForegroundBackend'));
  assert.ok(backend.includes('sanitizeDocument'));
  assert.equal(api.includes('/zp/api/'), false);
});

test('host shell owns navigation, rendering, and virtual Web APIs without service worker assets', () => {
  const pipeline = readHostPipeline();
  const index = read('web/index.html');
  for (const file of legacyServiceWorkerPaths)
    assert.equal(fs.existsSync(file), false, `${file} must stay deleted`);
  assert.ok(index.includes('/zp/assets/host-shell.js'));
  assert.equal(index.includes('navigator.serviceWorker'), false);
  assert.ok(pipeline.includes('new GoNetworkBackend'));
  assert.ok(pipeline.includes('installVirtualDOM'));
  assert.ok(pipeline.includes('installVirtualNetworkAPIs'));
  assert.ok(pipeline.includes('installWebAPICore'));
  assert.ok(pipeline.includes('evalClassic'));
  assert.ok(pipeline.includes('NativeRenderer'));
  assert.equal(pipeline.includes('/zp/api/'), false);
});

test('response bridge remains streaming and worker fetch is fail-closed after service worker deletion', () => {
  const bridge = read('internal/swhttp/bridge_js.go');
  const kernel = read('cmd/wasm-kernel/main.go');
  const worker = read('web/worker-prelude.js');
  assert.equal(/io\.ReadAll\(resp\.Body\)/.test(bridge), false);
  assert.equal(/io\.ReadAll\(resp\.Body\)/.test(kernel), false);
  assert.match(bridge, /ReadableStream/);
  assert.match(bridge, /controller\.Call\("enqueue"/);
  assert.match(kernel, /cancelReadCloser/);
  assert.doesNotMatch(worker, /openRelayedUploadStream/);
  assert.match(worker, /worker fetch is unavailable after QuickJS cutover/);
  assert.equal(worker.includes('/zp/api/'), false);
});

test('websocket runtime path remains isolated through GoNetworkBackend and wasm kernel', () => {
  const api = read('web/runtime/network/api.mjs');
  const backend = read('web/runtime/network/gonetworkbackend.mjs');
  const kernel = read('cmd/wasm-kernel/main.go');
  assert.match(api, /openWebSocket/);
  assert.match(backend, /ws\.open/);
  assert.match(kernel, /wsproto\.Dial/);
  assert.match(kernel, /newJSWebSocketStream/);
});
