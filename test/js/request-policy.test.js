const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { MessageChannel } = require('node:worker_threads');

function loadWorker(kernelFetch) {
  const context = {
    crypto: webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams,
    Headers, Request, Response, ArrayBuffer, Uint8Array, Blob,
    ReadableStream, TransformStream, performance, console, btoa, atob,
    location: new URL('https://proxy.example/zp/sw.js'),
    navigator: { languages: ['en-US'] },
    fetch: () => new Promise(() => {}),
    importScripts() {}, addEventListener() {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    ZPKernel: { ready: true }, kernelFetch,
    __ZP_REPORTING_HEADERS__: [], __ZP_TARGET_POLICY_HEADERS__: [],
    __ZP_HOP_BY_HOP_HEADERS__: ['location', 'set-cookie', 'x-zp-set-cookie'],
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('web/zp-core.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('web/sw.js', 'utf8'), context);
  return context;
}

function tabWithEntry() {
  const entry = { entryId: 'entry', targetUrl: 'https://site.example/page', baseUrl: 'https://cdn.example/assets/' };
  const stored = [];
  const tab = {
    tabId: 'tab', activeEntryId: entry.entryId, entries: new Map([[entry.entryId, entry]]), servers: [],
    cookieJar: { cookieHeader: () => 'session=secret', setCookieLine: (url, line) => stored.push({ url, line }) },
  };
  return { tab, entry, stored };
}

function response(status, location) {
  return new Response(null, { status, headers: location ? { Location: location } : {} });
}

test('redirects preserve PUT body views and do not mutate the initiating document', async () => {
  const seen = [];
  const worker = loadWorker(async request => {
    seen.push({ url: request.url, method: request.method, body: new TextDecoder().decode(await request.arrayBuffer()), headers: new Headers(request.headerEntries) });
    return seen.length === 1 ? response(302, '/final') : response(200);
  });
  const { tab, entry } = tabWithEntry();
  const bytes = new TextEncoder().encode('!payload?');
  await worker.transportFetch('https://site.example/start', {
    tab, method: 'PUT', body: bytes.subarray(1, 8), headers: { 'Content-Type': 'text/plain', 'X-App': 'kept' },
  });
  assert.deepEqual(seen.map(r => [r.method, r.body]), [['PUT', 'payload'], ['PUT', 'payload']]);
  assert.equal(seen[1].headers.get('x-app'), 'kept');
  assert.equal(seen[1].headers.get('x-zp-referer'), 'https://site.example/page');
  assert.equal(entry.targetUrl, 'https://site.example/page');
});

test('POST redirect drops entity headers while HEAD remains HEAD', async () => {
  const seen = [];
  const worker = loadWorker(async request => {
    seen.push({ method: request.method, headers: new Headers(request.headerEntries), bytes: (await request.arrayBuffer()).byteLength });
    return seen.length % 2 ? response(303, '/final') : response(200);
  });
  const { tab } = tabWithEntry();
  await worker.transportFetch('https://site.example/start', { tab, method: 'POST', body: new TextEncoder().encode('data'), headers: { 'Content-Type': 'application/json', 'Content-Language': 'en', 'X-App': 'kept' } });
  assert.equal(seen[1].method, 'GET');
  assert.equal(seen[1].bytes, 0);
  assert.equal(seen[1].headers.get('content-type'), null);
  assert.equal(seen[1].headers.get('content-language'), null);
  assert.equal(seen[1].headers.get('x-app'), 'kept');
  await worker.transportFetch('https://site.example/start', { tab, method: 'HEAD' });
  assert.equal(seen[3].method, 'HEAD');
});

test('credential policy applies to sending and accepting cookies across redirect hops', async () => {
  const seen = [];
  const worker = loadWorker(async request => {
    seen.push({ url: request.url, headers: new Headers(request.headerEntries) });
    return new Response(null, { status: seen.length === 1 ? 307 : 200, headers: {
      ...(seen.length === 1 ? { Location: 'https://other.example/final' } : {}),
      'X-ZP-Set-Cookie': 'new=value; Path=/',
    } });
  });
  const { tab, stored } = tabWithEntry();
  await worker.transportFetch('https://site.example/start', { tab, credentials: 'same-origin', headers: { Authorization: 'Bearer secret' } });
  assert.equal(seen[0].headers.get('cookie'), 'session=secret');
  assert.equal(seen[1].headers.get('cookie'), null);
  assert.equal(seen[1].headers.get('authorization'), null);
  assert.deepEqual(stored.map(r => r.url), ['https://site.example/start']);
  await worker.transportFetch('https://site.example/omit', { tab, credentials: 'omit' });
  assert.equal(seen[2].headers.get('cookie'), null);
  assert.equal(stored.length, 1);
});

test('request context is captured before asynchronous body reads', async () => {
  const seen = [];
  let release;
  const bodyReady = new Promise(resolve => { release = resolve; });
  const worker = loadWorker(async request => { seen.push(new Headers(request.headerEntries)); return response(200); });
  const { tab, entry } = tabWithEntry();
  const pending = worker.transportFetch('https://site.example/upload', {
    tab, method: 'POST', body: { arrayBuffer: () => bodyReady },
    refOverride: 'https://site.example/history-at-start', referrerPolicy: 'unsafe-url',
  });
  entry.targetUrl = 'https://site.example/changed';
  tab.activeEntryId = 'another-entry';
  release(new Uint8Array([1]).buffer);
  await pending;
  assert.equal(seen[0].get('x-zp-entry-id'), 'entry');
  assert.equal(seen[0].get('x-zp-referer'), 'https://site.example/history-at-start');
  assert.equal(seen[0].get('x-zp-origin'), 'https://site.example');
});

test('redirect error and manual never request the redirect target; same-origin mode rejects cross-origin', async () => {
  let calls = 0;
  const worker = loadWorker(async () => { calls++; return response(302, 'https://other.example/secret'); });
  const { tab } = tabWithEntry();
  const failed = await worker.transportFetch('https://site.example/start', { tab, runtimeFetch: true, redirect: 'error' });
  assert.equal(failed.type, 'error');
  const manual = await worker.transportFetch('https://site.example/start', { tab, runtimeFetch: true, redirect: 'manual' });
  assert.equal(manual.headers.get('location'), null);
  assert.equal(calls, 2);
  const blocked = await worker.transportFetch('https://other.example/start', { tab, mode: 'same-origin' });
  assert.equal(blocked.type, 'error');
  assert.equal(calls, 2);
});

test('Fetch responses retain native identity, filtered metadata, clone and opaque semantics', async t => {
  const descriptors = Object.getOwnPropertyDescriptors(Response.prototype);
  t.after(() => {
    for (const key of ['url', 'redirected', 'type', 'clone']) Object.defineProperty(Response.prototype, key, descriptors[key]);
  });
  const worker = loadWorker(async () => response(200));
  const decode = worker.ZP.createFetchResponseAdapter(Response, Headers);
  const adapted = decode(new Response('hello', { headers: {
    'X-ZP-Fetch-Meta': JSON.stringify({ url: 'https://site.example/final', redirected: true, type: 'basic' }),
    'X-ZP-Set-Cookie': 'secret=value',
  } }));
  assert.ok(adapted instanceof Response);
  assert.equal(adapted.url, 'https://site.example/final');
  assert.equal(adapted.redirected, true);
  assert.equal(adapted.headers.get('X-ZP-Fetch-Meta'), null);
  assert.equal(adapted.headers.get('X-ZP-Set-Cookie'), null);
  const cloned = adapted.clone();
  assert.equal(cloned.url, adapted.url);
  assert.equal(await cloned.text(), 'hello');
  assert.equal(await adapted.text(), 'hello');
  const opaque = decode(new Response(null, { status: 204, headers: {
    'X-ZP-Fetch-Meta': JSON.stringify({ url: 'https://site.example/start', redirected: false, type: 'opaqueredirect' }),
  } }));
  assert.equal(opaque.type, 'opaqueredirect');
  assert.equal(opaque.status, 0);
  assert.equal(opaque.ok, false);
  assert.equal(opaque.body, null);
  assert.equal(opaque.headers.get('Location'), null);
  assert.equal(opaque.clone().type, 'opaqueredirect');
});

test('streamed responses pull on demand and release their lifetime when cancelled', async () => {
  const worker = loadWorker(async () => response(200));
  let pulls = 0;
  let cancelled;
  const upstream = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array([42])); },
    cancel(reason) { cancelled = reason; },
  }, { highWaterMark: 0 });
  const streamed = worker.completeBodyResponse(new Response(upstream, { headers: { 'X-ZP-Body-Stream': '1' } }));
  let finished = false;
  streamed.__zpBodyDone.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(pulls, 0);
  const reader = streamed.body.getReader();
  assert.deepEqual(Array.from((await reader.read()).value), [42]);
  assert.equal(pulls, 1);
  assert.equal(finished, false);
  await reader.cancel('navigation');
  await streamed.__zpBodyDone;
  assert.equal(cancelled, 'navigation');
  assert.equal(finished, true);
  assert.equal(streamed.headers.get('X-ZP-Body-Stream'), null);
});

test('stream completion and upstream failure settle lifetime without truncating success', async () => {
  const worker = loadWorker(async () => response(200));
  const bytes = new Uint8Array([1, 2, 3]);
  const normal = worker.completeBodyResponse(new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  }), { headers: { 'X-ZP-Body-Stream': '1' } }));
  assert.deepEqual(Array.from(new Uint8Array(await normal.arrayBuffer())), [1, 2, 3]);
  await normal.__zpBodyDone;
  const failed = worker.completeBodyResponse(new Response(new ReadableStream({
    pull(controller) { controller.error(new Error('upstream reset')); },
  }), { headers: { 'X-ZP-Body-Stream': '1' } }));
  await assert.rejects(failed.text(), /upstream reset/);
  await failed.__zpBodyDone;
});

function websocketWorker(t, options = {}) {
  const worker = loadWorker();
  const { tab } = tabWithEntry();
  tab.runtimeToken = 'runtime-token';
  worker.wsTab = tab;
  vm.runInContext('tabs.set(wsTab.tabId, wsTab)', worker);
  const timers = new Map();
  let now = 0, nextTimer = 0;
  worker.setTimeout = (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, { callback, due: now + delay });
    return id;
  };
  worker.clearTimeout = id => timers.delete(id);
  const advance = ms => {
    const until = now + ms;
    while (true) {
      let next;
      for (const timer of timers) {
        if (timer[1].due <= until && (!next || timer[1].due < next[1].due)) next = timer;
      }
      if (!next) break;
      now = next[1].due;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = until;
  };
  const channels = [];
  let portCloses = 0;
  worker.MessageChannel = class extends MessageChannel {
    constructor() {
      super();
      channels.push(this);
      const close = this.port1.close.bind(this.port1);
      this.port1.close = () => { portCloses++; close(); };
    }
  };
  const state = { handlers: {}, liveDrivers: true, aborts: 0 };
  const complete = (code, reason) => {
    state.liveDrivers = false;
    if (state.handlers.close) state.handlers.close(code, reason);
  };
  const stream = {
    protocol: options.protocol || '',
    setHandlers(handlers) {
      state.handlers = handlers;
      if (handlers.close && options.setupError) throw new Error('handler setup failed');
      if (handlers.close && options.earlyClose) complete(...options.earlyClose);
    },
    send() {},
    close() {
      if (options.closeError) throw new Error('close failed');
    },
    abort() {
      state.aborts++;
      state.liveDrivers = false;
      if (options.abortError) throw new Error('abort failed after cancellation');
      complete(1006, '');
    },
  };
  worker.kernelStream = async () => stream;
  const replies = [], failures = [];
  const open = async (protocols = []) => {
    await worker.openRuntimeStream({
      source: { id: 'client' },
      ports: [{ postMessage(message, transfer) {
        if (options.replyError) throw new Error('reply transfer failed');
        replies.push(structuredClone(message, { transfer }));
      } }],
    }, { tabId: tab.tabId, runtimeToken: tab.runtimeToken, url: 'wss://site.example/socket', protocols },
    () => {}, error => failures.push(error));
    return replies[0];
  };
  t.after(() => {
    for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
    for (const reply of replies) reply.port.close();
  });
  return {
    state, timers, channels, failures, open, complete, advance,
    command: data => channels[0].port1.onmessage({ data }),
    assertReleased() {
      assert.equal(state.liveDrivers, false);
      assert.equal(vm.runInContext('streams.size', worker), 0);
      assert.equal(timers.size, 0);
      assert.deepEqual(Object.keys(state.handlers), []);
      if (channels.length) {
        assert.equal(channels[0].port1.onmessage, null);
        assert.equal(portCloses, 1);
      }
    },
  };
}

function websocketCloseMessages(port) {
  return new Promise(resolve => {
    const messages = [];
    port.onmessage = event => {
      messages.push(event.data);
      if (event.data.type === 'close') resolve(messages);
    };
  });
}

test('WebSocket close deadline aborts a silent peer without timing out an open socket', { timeout: 5000 }, async t => {
  const ws = websocketWorker(t);
  const reply = await ws.open();
  const closed = websocketCloseMessages(reply.port);
  ws.advance(60000);
  assert.equal(ws.state.liveDrivers, true);
  assert.equal(ws.state.aborts, 0);
  ws.command({ type: 'close', code: 3001, reason: 'requested' });
  const lateClose = ws.state.handlers.close;
  ws.advance(29999);
  assert.equal(ws.state.liveDrivers, true);
  ws.advance(1);
  assert.equal(ws.state.aborts, 1);
  ws.assertReleased();
  lateClose(3001, 'late echo');
  ws.assertReleased();
  assert.deepEqual(await closed, [{ type: 'close', code: 1006, reason: '' }]);
});

test('WebSocket peer close preserves its status and cancels the deadline', { timeout: 5000 }, async t => {
  const ws = websocketWorker(t);
  const reply = await ws.open();
  const closed = websocketCloseMessages(reply.port);
  ws.command({ type: 'close', code: 3001, reason: 'requested' });
  ws.advance(29999);
  const lateClose = ws.state.handlers.close;
  ws.complete(3002, 'peer status');
  ws.assertReleased();
  ws.advance(60000);
  lateClose(1006, '');
  assert.equal(ws.state.aborts, 0);
  ws.assertReleased();
  assert.deepEqual(await closed, [{ type: 'close', code: 3002, reason: 'peer status' }]);
});

test('WebSocket repeated close requests cannot extend the first deadline', { timeout: 5000 }, async t => {
  const ws = websocketWorker(t);
  const reply = await ws.open();
  const closed = websocketCloseMessages(reply.port);
  ws.command({ type: 'close', code: 1000 });
  ws.advance(29999);
  ws.command({ type: 'close', code: 3001 });
  ws.advance(1);
  assert.equal(ws.state.aborts, 1);
  ws.assertReleased();
  assert.deepEqual(await closed, [{ type: 'close', code: 1006, reason: '' }]);
});

test('WebSocket early kernel completion survives MessagePort transfer and releases handlers', { timeout: 5000 }, async t => {
  const ws = websocketWorker(t, { earlyClose: [1000, 'already finished'] });
  const reply = await ws.open();
  ws.assertReleased();
  assert.equal(ws.state.aborts, 0);
  assert.deepEqual(ws.failures, []);
  assert.deepEqual(await websocketCloseMessages(reply.port), [{ type: 'close', code: 1000, reason: 'already finished' }]);
});

test('WebSocket explicit abort releases the stream once even with a queued close callback', { timeout: 5000 }, async t => {
  const ws = websocketWorker(t);
  const reply = await ws.open();
  const closed = websocketCloseMessages(reply.port);
  const queuedMessage = ws.channels[0].port1.onmessage;
  const queuedClose = ws.state.handlers.close;
  ws.command({ type: 'close', code: 1000 });
  ws.command({ type: 'abort' });
  queuedMessage({ data: { type: 'abort' } });
  queuedClose(1000, 'too late');
  ws.advance(60000);
  assert.equal(ws.state.aborts, 1);
  ws.assertReleased();
  assert.deepEqual(await closed, [{ type: 'close', code: 1006, reason: '' }]);
});

test('WebSocket close and abort exceptions still settle the port and remove the stream', { timeout: 5000 }, async t => {
  const ws = websocketWorker(t, { closeError: true, abortError: true });
  const reply = await ws.open();
  const closed = websocketCloseMessages(reply.port);
  ws.command({ type: 'close', code: 1000 });
  assert.equal(ws.state.aborts, 1);
  ws.assertReleased();
  const messages = await closed;
  assert.ok(messages.some(message => message.type === 'error'));
  assert.deepEqual(messages.filter(message => message.type === 'close'), [{ type: 'close', code: 1006, reason: '' }]);
});

test('WebSocket rejected protocols and failed setup abort allocated kernel drivers', async t => {
  for (const options of [{ protocol: 'unoffered' }, { setupError: true }, { replyError: true }]) {
    await t.test(Object.keys(options)[0], async t => {
      const ws = websocketWorker(t, options);
      assert.equal(await ws.open(), undefined);
      assert.equal(ws.state.aborts, 1);
      assert.equal(ws.failures.length, 1);
      ws.assertReleased();
    });
  }
});
