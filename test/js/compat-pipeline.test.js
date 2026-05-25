const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = path => fs.readFileSync(path, 'utf8');

test('window fetch, XHR, and EventSource are not replaced by runtime transport shims', () => {
  const rt = read('web/runtime-prelude.js');
  assert.equal(rt.includes("define(root, 'fetch'"), false);
  assert.equal(rt.includes("define(root, 'XMLHttpRequest'"), false);
  assert.equal(rt.includes("define(root, 'EventSource'"), false);
  assert.equal(rt.includes('ZPXMLHttpRequest'), false);
  assert.equal(rt.includes('/__zp/api/fetch'), false);
  assert.match(rt, /Native\.fetch\(target\.href/);
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

test('service worker owns native request capture, CORS, and context recovery', () => {
  const sw = read('web/sw.js');
  for (const needle of [
    'isCORSPreflight',
    'corsPreflight',
    'Access-Control-Allow-Origin',
    'resourceContext',
    'rememberResourceContext',
    'contextFromURL',
    'defaultContext',
    'ZP_BASE_UPDATE',
  ]) assert.ok(sw.includes(needle), `missing ${needle}`);
  assert.match(sw, /url\.protocol === 'http:' \|\| url\.protocol === 'https:'/);
});

test('response bridge exposes a ReadableStream instead of buffering response bodies', () => {
  const bridge = read('internal/swhttp/bridge_js.go');
  const kernel = read('cmd/wasm-kernel/main.go');
  assert.equal(/io\.ReadAll\(resp\.Body\)/.test(bridge), false);
  assert.equal(/io\.ReadAll\(resp\.Body\)/.test(kernel), false);
  assert.match(bridge, /ReadableStream/);
  assert.match(bridge, /controller\.Call\("enqueue"/);
  assert.match(kernel, /cancelReadCloser/);
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
