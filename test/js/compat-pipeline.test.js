const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = path => fs.readFileSync(path, 'utf8');

test('window fetch, XHR, and EventSource route through runtime transport shims', () => {
  const rt = read('web/runtime-prelude.js');
  assert.match(rt, /define\(root, 'fetch'/);
  assert.match(rt, /define\(root, 'XMLHttpRequest'/);
  assert.match(rt, /define\(root, 'EventSource'/);
  assert.ok(rt.includes('ZPXMLHttpRequest'));
  assert.ok(rt.includes('ZPEventSource'));
  assert.ok(rt.includes("ZP.apiPath('fetch')"));
  assert.match(rt, /Native\.fetch\(ZP\.apiPath\('fetch'\)/);
});

test('runtime navigation uses bound Location methods and catches expando href clicks', () => {
  const rt = read('web/runtime-prelude.js');
  assert.match(rt, /w\.location\.assign && w\.location\.assign\.bind\(w\.location\)/);
  assert.match(rt, /w\.location\.replace && w\.location\.replace\.bind\(w\.location\)/);
  assert.match(rt, /function clickNavigationTarget\(ev\)/);
  assert.match(rt, /typeof el\.href === 'string'/);
  assert.match(rt, /stopImmediatePropagation/);
  assert.doesNotMatch(rt, /Native\.locationAssign\.call\(location/);
});
test('runtime suppresses favicon loading without exposing placeholder hrefs', () => {
  const rt = read('web/runtime-prelude.js');
  assert.ok(rt.includes('data:application/x-zeroproxy-icon,1'));
  assert.ok(rt.includes('isIconLinkRelValue'));
  assert.ok(rt.includes('suppressIconLinkHref'));
  assert.ok(rt.includes('visibleIconAttrValue'));
  assert.ok(rt.includes('x-zeroproxy-icon'));
});

test('runtime preactivates p routes and masks navigator identity', () => {
  const rt = read('web/runtime-prelude.js');
  const worker = read('web/worker-prelude.js');
  assert.match(rt, /ZP\.encryptShareURL\(target\)/);
  assert.match(rt, /ZP_HISTORY_UPDATE/);
  assert.match(rt, /Native\.locationAssign\(path\)/);
  assert.ok(rt.includes('Chrome/134.0.0.0 Safari/537.36'));
  assert.match(rt, /installNavigatorIdentity/);
  assert.ok(worker.includes('Chrome/134.0.0.0 Safari/537.36'));
});

test('service worker owns native request capture, CORS, and context recovery', () => {
  const sw = read('web/sw.js');
  for (const needle of [
    'isCORSPreflight',
    'corsPreflight',
    'Access-Control-Allow-Origin',
    'resourceContext',
    'rememberResourceContext',
    'contextFromURL',
    'scriptRequestContext',
    'ZP_BASE_UPDATE',
  ]) assert.ok(sw.includes(needle), `missing ${needle}`);
  assert.equal(sw.includes('firstTab'), false);
  assert.equal(sw.includes('defaultContext'), false);
  assert.match(sw, /url\.protocol === 'http:' \|\| url\.protocol === 'https:'/);
});

test('response bridge exposes a ReadableStream instead of buffering response bodies', () => {
  const bridge = read('internal/swhttp/bridge_js.go');
  const kernel = read('cmd/wasm-kernel/main.go');
  const rt = read('web/runtime-prelude.js');
  const sw = read('web/sw.js');
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
  const rt = read('web/runtime-prelude.js');
  const sw = read('web/sw.js');
  const kernel = read('cmd/wasm-kernel/main.go');
  assert.match(rt, /ZP_WS_OPEN/);
  assert.match(sw, /__zp_stream/);
  assert.match(sw, /streamIsolationKey/);
  assert.match(kernel, /wsproto\.Dial/);
  assert.match(kernel, /newJSWebSocketStream/);
});
