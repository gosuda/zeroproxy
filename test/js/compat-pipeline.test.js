const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

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

test('window fetch, XHR, and EventSource route through runtime transport shims', () => {
  const rt = readRuntime();
  assert.match(rt, /defineReplacingNative\(root, 'fetch'/);
  assert.match(rt, /Object\.defineProperty\(root, 'XMLHttpRequest'/);
  assert.match(rt, /defineReplacingNative\(root, 'EventSource'/);
  assert.match(rt, /finishEventSourceStream\(es\)/);
  assert.ok(rt.includes('ZPXMLHttpRequest'));
  assert.ok(rt.includes('ZPEventSource'));
  assert.ok(rt.includes("ZP.apiPath('fetch')"));
  assert.match(rt, /Native\.fetch\(`\$\{ZP\.apiPath\('fetch'\)\}\?url=/);
  for (const needle of [
    'X-ZP-Fetch-Credentials',
    'X-ZP-Fetch-Redirect',
    'X-ZP-Fetch-Referrer',
    'sendSyncXHR',
    'ProgressEvent',
  ]) {
    assert.ok(rt.includes(needle), `missing ${needle}`);
  }
  for (const needle of [
    'Object.defineProperties(ZPXMLHttpRequest',
    'DONE: { value: DONE',
    "value: 'XMLHttpRequest'",
  ]) {
    assert.ok(rt.includes(needle), `missing ${needle}`);
  }
  for (const needle of [
    'X-ZP-Response-URL',
    'X-ZP-Response-Redirected',
    'responseFacade',
    'filteredResponseHeaders',
    'opaqueResponseFacade',
  ]) {
    assert.ok(rt.includes(needle), `missing ${needle}`);
  }
});

test('runtime Performance API consumes real transport timing metadata', () => {
  const rt = readRuntime();
  const sw = readServiceWorker();
  for (const needle of [
    '__zpTransportTiming',
    '__zpPerformanceTimings',
    'recordTransportTiming(resp, target)',
    'transportTimingEntries',
    'serverTimingMetric',
  ]) {
    assert.ok(rt.includes(needle), `missing ${needle}`);
  }
  for (const needle of [
    'copyTransportTiming',
    'ZP_TRANSPORT_TIMINGS',
    'recordTransportTiming(resp, requestId, opt)',
  ]) {
    assert.ok(sw.includes(needle), `missing ${needle}`);
  }
});

test('runtime navigation uses bound Location methods and catches expando href clicks', () => {
  const rt = readRuntime();
  assert.ok(rt.includes("locationAssign: bindMethod(w.location, 'assign')"));
  assert.ok(rt.includes("locationReplace: bindMethod(w.location, 'replace')"));
  assert.match(rt, /function bindMethod\(obj, key\)[\s\S]*return fn && fn\.bind\(obj\)/);
  assert.match(rt, /function clickNavigationTarget\(ev\)/);
  assert.match(rt, /typeof el\.href === 'string'/);
  assert.match(rt, /stopImmediatePropagation/);
  assert.doesNotMatch(rt, /Native\.locationAssign\.call\(location/);
});
test('runtime suppresses favicon loading without exposing placeholder hrefs', () => {
  const rt = readRuntime();
  const server = read('cmd/zeroproxy-server/main.go');
  assert.ok(rt.includes('data:application/x-zeroproxy-icon,1'));
  assert.ok(rt.includes('isIconLinkRelValue'));
  assert.ok(rt.includes('suppressIconLinkHref'));
  assert.ok(rt.includes('visibleIconAttrValue'));
  assert.ok(rt.includes('x-zeroproxy-icon'));
  assert.ok(rt.includes("u.pathname === '/favicon.ico'"));
  assert.ok(server.includes('func (s *server) emptyFavicon'));
  assert.ok(readServiceWorker().includes("path === '/favicon.ico'"));
});

test('runtime preactivates p routes and masks navigator identity', () => {
  const rt = readRuntime();
  const worker = read('web/worker-prelude.js');
  assert.match(rt, /ZP\.encryptShareURL\(target\)/);
  assert.match(rt, /ZP_HISTORY_UPDATE/);
  assert.match(rt, /Native\.locationAssign\(path\)/);
  assert.ok(rt.includes('Chrome/148.0.0.0 Safari/537.36'));
  assert.ok(rt.includes("const TARGET_PLATFORM = 'Win32'"));
  assert.ok(rt.includes('const TARGET_UA_BRANDS'));
  assert.ok(rt.includes("defineAccessor(proto, 'userAgentData'"));
  assert.ok(rt.includes("platformVersion: '15.0.0'"));
  assert.match(rt, /installNavigatorIdentity/);
  assert.ok(worker.includes('Chrome/148.0.0.0 Safari/537.36'));
  assert.ok(worker.includes('userAgentData'));
  assert.ok(worker.includes('fullVersionList'));
});

test('service worker owns native request capture, CORS, and context recovery', () => {
  const sw = readServiceWorker();
  for (const needle of [
    'isCORSPreflight',
    'corsPreflight',
    'Access-Control-Allow-Origin',
    'resourceContext',
    'rememberResourceContext',
    'contextFromURL',
    'scriptRequestContext',
    'ZP_BASE_UPDATE',
  ])
    assert.ok(sw.includes(needle), `missing ${needle}`);
  assert.equal(sw.includes('firstTab'), false);
  assert.equal(sw.includes('defaultContext'), false);
  assert.match(sw, /url\.protocol === 'http:' \|\| url\.protocol === 'https:'/);
  assert.match(sw, /apiScript[\s\S]*transportFetch\(target, \{ request: req, method: 'GET'/);
  assert.match(sw, /apiWorkerScript[\s\S]*transportFetch\(target, \{ request: req, method: 'GET'/);
});

test('response bridge exposes a ReadableStream instead of buffering response bodies', () => {
  const bridge = read('internal/swhttp/bridge_js.go');
  const kernel = read('cmd/wasm-kernel/main.go');
  const rt = readRuntime();
  const sw = readServiceWorker();
  const worker = read('web/worker-prelude.js');
  assert.equal(/io\.ReadAll\(resp\.Body\)/.test(bridge), false);
  assert.equal(/io\.ReadAll\(resp\.Body\)/.test(kernel), false);
  assert.match(bridge, /ReadableStream/);
  assert.match(bridge, /controller\.Call\("enqueue"/);
  assert.match(kernel, /cancelReadCloser/);
  assert.match(rt, /ZP_UPLOAD_STREAM_OPEN/);
  assert.match(rt, /openUploadStream/);
  assert.match(sw, /readableStreamFromUpload/);
  assert.match(sw, /pullUploadChunk/);
  assert.match(sw, /X-ZP-Upload-Stream-Id/);
  assert.match(worker, /ZP_UPLOAD_STREAM_OPEN/);
  assert.match(worker, /X-ZP-Upload-Stream-Id/);
  assert.match(rt, /BroadcastChannel/);
  assert.match(worker, /BroadcastChannel/);
  assert.match(worker, /openRelayedUploadStream/);
});

test('websocket runtime path remains isolated through the service worker stream pipe', () => {
  const rt = readRuntime();
  const sw = readServiceWorker();
  const kernel = read('cmd/wasm-kernel/main.go');
  assert.match(rt, /ZP_WS_OPEN/);
  assert.match(sw, /__zp_stream/);
  assert.match(sw, /streamIsolationKey/);
  assert.match(kernel, /wsproto\.Dial/);
  assert.match(kernel, /newJSWebSocketStream/);
});
