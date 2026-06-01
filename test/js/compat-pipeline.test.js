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
    'defaultContext',
    'ZP_BASE_UPDATE',
  ]) assert.ok(sw.includes(needle), `missing ${needle}`);
  assert.match(sw, /url\.protocol === 'http:' \|\| url\.protocol === 'https:'/);
});

test('Rust kernel response path uses ReadableStream (no full-body buffer)', () => {
  // Step 13 cutover: the Go kernel + swhttp bridge are gone. The Rust kernel
  // streams response bodies via a ReadableStream controller built in
  // crates/zp-kernel/src/lib.rs (`build_streaming_response`).
  const kernel = read('crates/zp-kernel/src/lib.rs');
  assert.match(kernel, /build_streaming_response/);
  assert.match(kernel, /ReadableStream/);
  assert.match(kernel, /invoke_controller\(&ctrl, "enqueue"/);
});

test('websocket runtime path is routed through the Rust kernelStream bridge', () => {
  const rt = read('web/runtime-prelude.js');
  const sw = read('web/sw.js');
  const kernel = read('crates/zp-kernel/src/lib.rs');
  assert.match(rt, /ZP_WS_OPEN/);
  assert.match(sw, /kernelStream/);
  assert.match(sw, /streamIsolationKey/);
  // Server-side ws-bridge endpoint pairs with the Rust kernelStream client.
  const server = read('cmd/zeroproxy-server/main.go');
  assert.match(server, /controlPrefix\+"ws-bridge"/);
  assert.match(kernel, /kernel_stream/);
});
