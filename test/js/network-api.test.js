const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadRuntime } = require('./quickjs-test-helpers');

const apiModuleURL = pathToFileURL(path.resolve('web/runtime/network/api.mjs')).href;
const domModuleURL = pathToFileURL(path.resolve('web/runtime/dom/virtual-dom.mjs')).href;
const storageModuleURL = pathToFileURL(path.resolve('web/runtime/webapi/storage.mjs')).href;

async function apiModule() {
  return import(apiModuleURL);
}

async function domModule() {
  return import(domModuleURL);
}

async function storageModule() {
  return import(storageModuleURL);
}

function fetchMessages(url, body, headers = [['Content-Type', 'text/plain; charset=utf-8']]) {
  const bytes = new TextEncoder().encode(body);
  return [
    {
      v: 1,
      type: 'fetch.response.start',
      requestId: url,
      url,
      finalUrl: url,
      status: 200,
      statusText: 'OK',
      headers,
    },
    {
      v: 1,
      type: 'fetch.response.chunk',
      requestId: url,
      seq: 0,
      bytes: bytes.buffer,
      byteLength: bytes.byteLength,
    },
    { v: 1, type: 'fetch.response.end', requestId: url, bytesRead: bytes.byteLength },
  ];
}

async function installNetwork(fakeBackend, options = {}) {
  const runtime = await loadRuntime();
  const realm = runtime.createRealm();
  const { installVirtualDOM } = await domModule();
  const { installVirtualNetworkAPIs } = await apiModule();
  installVirtualDOM({
    realm,
    records: [
      { v: 1, type: 'node.create', docId: 'doc-net', seq: 1, nodeId: 'n-html', tag: 'html' },
      {
        v: 1,
        type: 'node.create',
        docId: 'doc-net',
        seq: 2,
        nodeId: 'n-body',
        parentNodeId: 'n-html',
        tag: 'body',
      },
    ],
    href: 'https://target.example/app/page.html',
  });
  const network = installVirtualNetworkAPIs({
    realm,
    backend: fakeBackend,
    tabId: 'tab-net',
    documentUrl: options.documentUrl || 'https://target.example/app/page.html',
    cache: options.cache,
  });
  return { realm, network };
}

test('virtual fetch Request Response Headers cache credentials cookies and timing use backend fetchRaw', async () => {
  const calls = [];
  const backend = {
    async fetchRaw(record) {
      calls.push(record);
      return fetchMessages(record.url, JSON.stringify({ ok: true, cache: record.cache }), [
        ['Content-Type', 'application/json'],
        ['X-Test', '1'],
      ]);
    },
    setCookie(record) {
      calls.push({ type: 'cookie.set', cookie: record.cookie, targetUrl: record.targetUrl });
    },
  };
  const { realm, network } = await installNetwork(backend);
  realm.evalClassic(`
    const headers = new Headers({ 'X-Test': 'a' });
    headers.append('X-Test', 'b');
    const req = new Request('/api/data', { method: 'POST', headers, body: 'payload', cache: 'reload', credentials: 'include', referrer: '/source', referrerPolicy: 'strict-origin' });
    fetch(req).then(async (response) => {
      const clone = response.clone();
      document.cookie = 'sid=abc; Path=/';
      document.cookie = 'theme=dark; Path=/';
      document.cookie = 'theme=gone; Max-Age=0; Path=/';
      globalThis.fetchResult = {
        status: response.status,
        ok: response.ok,
        url: response.url,
        header: response.headers.get('x-test'),
        json: await response.json(),
        cloneText: await clone.text(),
        cookie: document.cookie,
        timing: typeof response.timing.durationMs === 'number',
      };
    });
  `);
  await network.waitForIdle();
  const result = JSON.parse(realm.evalClassic('JSON.stringify(fetchResult)'));
  assert.deepEqual(result, {
    status: 200,
    ok: true,
    url: 'https://target.example/api/data',
    header: '1',
    json: { ok: true, cache: 'reload' },
    cloneText: '{"ok":true,"cache":"reload"}',
    cookie: 'sid=abc',
    timing: true,
  });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].cache, 'reload');
  assert.equal(calls[0].credentials, 'include');
  assert.equal(calls[0].body, 'payload');
  assert.equal(calls[0].referrer, 'https://target.example/source');
  assert.equal(calls[0].referrerPolicy, 'strict-origin');
  assert.deepEqual(calls[0].headers, [
    ['x-test', 'a'],
    ['x-test', 'b'],
  ]);
  assert.deepEqual(calls[1], {
    type: 'cookie.set',
    cookie: 'sid=abc; Path=/',
    targetUrl: 'https://target.example/app/page.html',
  });
  assert.deepEqual(calls[2], {
    type: 'cookie.set',
    cookie: 'theme=dark; Path=/',
    targetUrl: 'https://target.example/app/page.html',
  });
  assert.deepEqual(calls[3], {
    type: 'cookie.set',
    cookie: 'theme=gone; Max-Age=0; Path=/',
    targetUrl: 'https://target.example/app/page.html',
  });
  realm.destroy();
});

test('virtual Request and Response body consumption matches browser fetch objects', async () => {
  const { realm } = await installNetwork({
    async fetchRaw() {
      return fetchMessages('https://target.example/unused', 'unused');
    },
  });
  realm.evalClassic(`
    globalThis.bodyResult = [];
    function record(label, fn) {
      try {
        const value = fn();
        bodyResult.push([label, 'ok', value]);
      } catch (error) {
        bodyResult.push([label, 'throw', error.name, error.message]);
      }
    }
    async function recordAsync(label, fn) {
      try {
        const value = await fn();
        bodyResult.push([label, 'ok', value]);
      } catch (error) {
        bodyResult.push([label, 'throw', error.name, error.message]);
      }
    }
    (async () => {
      const response = new Response('hello', { status: 201, statusText: 'Created', headers: { 'X-A': 'b' } });
      bodyResult.push(['response-initial', response.bodyUsed, response.status, response.statusText, response.ok, response.headers.get('x-a'), response.type, response.redirected]);
      await recordAsync('response-body-stream', async () => {
        const streamed = new Response('stream');
        const reader = streamed.body.getReader();
        const first = await reader.read();
        const second = await reader.read();
        return [Object.prototype.toString.call(streamed.body), Array.from(first.value || []), first.done, second.done, streamed.bodyUsed];
      });
      const responseClone = response.clone();
      await recordAsync('response-multipart-formdata', async () => {
        const body = [
          '--zp',
          'Content-Disposition: form-data; name="field"',
          '',
          'alpha',
          '--zp--',
          '',
        ].join('\\r\\n');
        const data = await new Response(body, { headers: { 'Content-Type': 'multipart/form-data; boundary=zp' } }).formData();
        return [data.get('field'), Array.from(data.keys())];
      });
      await recordAsync('response-text', () => response.text());
      bodyResult.push(['response-after-text', response.bodyUsed, responseClone.bodyUsed]);
      await recordAsync('response-text-again', () => response.text());
      record('response-clone-after-used', () => response.clone());
      await recordAsync('response-clone-text', () => responseClone.text());
      await recordAsync('response-arraybuffer', async () => Array.from(new Uint8Array(await new Response(new Uint8Array([1, 2, 3])).arrayBuffer())));
      await recordAsync('response-formdata', async () => { const data = await new Response('a=1&b=two+words', { headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } }).formData(); return [data.get('a'), data.get('b'), Array.from(data.keys())]; });
      await recordAsync('response-formdata-wrong-type', () => new Response('plain', { headers: { 'Content-Type': 'text/plain' } }).formData());
      await recordAsync('response-formdata-after-text', async () => { const consumed = new Response('a=1', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); await consumed.text(); return consumed.formData(); });
      record('response-bad-status-low', () => new Response('', { status: 199 }));
      record('response-bad-status-high', () => new Response('', { status: 600 }));
      record('response-redirect', () => { const redirected = Response.redirect('/next', 301); return [redirected.status, redirected.headers.get('location'), redirected.type, redirected.redirected]; });
      record('response-redirect-bad-status', () => Response.redirect('/next', 200));
      const request = new Request('/post', { method: 'POST', body: 'payload', redirect: 'manual', credentials: 'include', cache: 'reload' });
      bodyResult.push(['request-initial', request.bodyUsed, request.method, request.redirect, request.credentials, request.cache, request.url]);
      await recordAsync('request-body-stream', async () => {
        const streamed = new Request('/stream', { method: 'POST', body: 'stream' });
        const reader = streamed.body.getReader();
        const first = await reader.read();
        const second = await reader.read();
        return [Object.prototype.toString.call(streamed.body), Array.from(first.value || []), first.done, second.done, streamed.bodyUsed];
      });
      const requestClone = request.clone();
      await recordAsync('request-text', () => request.text());
      bodyResult.push(['request-after-text', request.bodyUsed, requestClone.bodyUsed]);
      await recordAsync('request-text-again', () => request.text());
      record('request-clone-after-used', () => request.clone());
      await recordAsync('request-clone-text', () => requestClone.text());
      await recordAsync('request-formdata', async () => { const data = await new Request('/form', { method: 'POST', body: 'a=1&b=two+words', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).formData(); return [data.get('a'), data.get('b')]; });
      record('request-bad-redirect', () => new Request('/x', { redirect: 'bad' }));
      record('request-get-body', () => new Request('/x', { method: 'GET', body: 'x' }));
    })();
  `);
  for (let i = 0; i < 8; i += 1) realm.drainJobs();
  const result = JSON.parse(realm.evalClassic('JSON.stringify(bodyResult)'));
  assert.deepEqual(
    result.map((entry) => entry.slice(0, 3)),
    [
      ['response-initial', false, 201],
      [
        'response-body-stream',
        'ok',
        ['[object ReadableStream]', [115, 116, 114, 101, 97, 109], false, true, true],
      ],
      ['response-multipart-formdata', 'ok', ['alpha', ['field']]],
      ['response-text', 'ok', 'hello'],
      ['response-after-text', true, false],
      ['response-text-again', 'throw', 'TypeError'],
      ['response-clone-after-used', 'throw', 'TypeError'],
      ['response-clone-text', 'ok', 'hello'],
      ['response-arraybuffer', 'ok', [1, 2, 3]],
      ['response-formdata', 'ok', ['1', 'two words', ['a', 'b']]],
      ['response-formdata-wrong-type', 'throw', 'TypeError'],
      ['response-formdata-after-text', 'throw', 'TypeError'],
      ['response-bad-status-low', 'throw', 'RangeError'],
      ['response-bad-status-high', 'throw', 'RangeError'],
      ['response-redirect', 'ok', [301, 'https://target.example/next', 'default', false]],
      ['response-redirect-bad-status', 'throw', 'RangeError'],
      ['request-initial', false, 'POST'],
      [
        'request-body-stream',
        'ok',
        ['[object ReadableStream]', [115, 116, 114, 101, 97, 109], false, true, true],
      ],
      ['request-text', 'ok', 'payload'],
      ['request-after-text', true, false],
      ['request-text-again', 'throw', 'TypeError'],
      ['request-clone-after-used', 'throw', 'TypeError'],
      ['request-clone-text', 'ok', 'payload'],
      ['request-formdata', 'ok', ['1', 'two words']],
      ['request-bad-redirect', 'throw', 'TypeError'],
      ['request-get-body', 'throw', 'TypeError'],
    ],
  );
  assert.equal(result[0][3], 'Created');
  assert.equal(result[0][4], true);
  assert.equal(result[0][5], 'b');
  assert.equal(result[0][6], 'default');

  assert.equal(result[0][7], false);
  assert.equal(result[16][3], 'manual');
  assert.equal(result[16][4], 'include');
  assert.equal(result[16][5], 'reload');
  assert.equal(result[16][6], 'https://target.example/post');
  realm.destroy();
});

test('virtual Request init mode credentials and cache enums match host behavior', async () => {
  const calls = [];
  const { realm, network } = await installNetwork({
    async fetchRaw(record) {
      calls.push(record);
      return fetchMessages(record.url, 'ok');
    },
  });
  realm.evalClassic(`
    globalThis.requestInitResult = [];
    function record(label, fn) {
      try {
        requestInitResult.push([label, 'ok', fn()]);
      } catch (error) {
        requestInitResult.push([label, 'throw', error.name, error.message]);
      }
    }
    record('defaults', () => { const request = new Request('/x'); return [request.method, request.mode, request.credentials, request.cache, request.redirect, request.referrer, request.referrerPolicy]; });
    for (const mode of ['same-origin', 'no-cors', 'cors']) record('mode-' + mode, () => new Request('/x', { mode }).mode);
    record('mode-navigate', () => new Request('/x', { mode: 'navigate' }));
    record('mode-bad', () => new Request('/x', { mode: 'bad' }));
    for (const credentials of ['omit', 'same-origin', 'include']) record('credentials-' + credentials, () => new Request('/x', { credentials }).credentials);
    record('credentials-bad', () => new Request('/x', { credentials: 'bad' }));
    for (const cache of ['default', 'no-store', 'reload', 'no-cache', 'force-cache']) record('cache-' + cache, () => new Request('/x', { cache }).cache);
    record('cache-only-if-cached-default-mode', () => new Request('/x', { cache: 'only-if-cached' }));
    record('cache-only-if-cached-same-origin', () => { const request = new Request('/x', { cache: 'only-if-cached', mode: 'same-origin' }); return [request.cache, request.mode]; });
    record('cache-bad', () => new Request('/x', { cache: 'bad' }));
    fetch('/enum', { mode: 'same-origin', cache: 'reload', credentials: 'omit', redirect: 'manual' }).catch(() => {});
  `);
  await network.waitForIdle();
  const result = JSON.parse(realm.evalClassic('JSON.stringify(requestInitResult)'));
  assert.deepEqual(
    result.map((entry) => entry.slice(0, 3)),
    [
      ['defaults', 'ok', ['GET', 'cors', 'same-origin', 'default', 'follow', 'about:client', '']],
      ['mode-same-origin', 'ok', 'same-origin'],
      ['mode-no-cors', 'ok', 'no-cors'],
      ['mode-cors', 'ok', 'cors'],
      ['mode-navigate', 'throw', 'TypeError'],
      ['mode-bad', 'throw', 'TypeError'],
      ['credentials-omit', 'ok', 'omit'],
      ['credentials-same-origin', 'ok', 'same-origin'],
      ['credentials-include', 'ok', 'include'],
      ['credentials-bad', 'throw', 'TypeError'],
      ['cache-default', 'ok', 'default'],
      ['cache-no-store', 'ok', 'no-store'],
      ['cache-reload', 'ok', 'reload'],
      ['cache-no-cache', 'ok', 'no-cache'],
      ['cache-force-cache', 'ok', 'force-cache'],
      ['cache-only-if-cached-default-mode', 'throw', 'TypeError'],
      ['cache-only-if-cached-same-origin', 'ok', ['only-if-cached', 'same-origin']],
      ['cache-bad', 'throw', 'TypeError'],
    ],
  );
  assert.equal(calls[0].mode, 'same-origin');
  assert.equal(calls[0].cache, 'reload');
  assert.equal(calls[0].credentials, 'omit');
  assert.equal(calls[0].redirect, 'manual');
  realm.destroy();
});

test('virtual HTTP cache handles modes validators vary and partitioning', async () => {
  const { VirtualHTTPCache } = await apiModule();
  const sharedCache = new VirtualHTTPCache();
  const calls = [];
  let version = 0;
  const backend = {
    async fetchRaw(record) {
      calls.push(record);
      if (record.headers.some(([name]) => name === 'if-none-match')) {
        const notModified = fetchMessages(record.url, '', [
          ['ETag', '"v1"'],
          ['Cache-Control', 'max-age=60'],
        ]);
        notModified[0].status = 304;
        notModified[0].statusText = 'Not Modified';
        return notModified;
      }
      version += 1;
      const vary = record.url.endsWith('/vary') ? [['Vary', 'x-flavor']] : [];
      return fetchMessages(record.url, `body-${version}`, [
        ['Cache-Control', 'max-age=60'],
        ['ETag', '"v1"'],
        ...vary,
      ]);
    },
  };
  const { realm, network } = await installNetwork(backend, { cache: sharedCache });

  realm.evalClassic(`
    globalThis.cacheResults = [];
    async function grab(url, init) {
      try {
        const response = await fetch(url, init);
        cacheResults.push([url, init?.cache || 'default', await response.text(), Boolean(response.timing.cacheHit), Boolean(response.timing.revalidated)]);
      } catch (error) {
        cacheResults.push([url, init?.cache || 'default', error.message]);
      }
    }
    grab('/cache');
  `);
  await network.waitForIdle();
  realm.evalClassic(`grab('/cache');`);
  await network.waitForIdle();
  realm.evalClassic(`grab('/cache', { cache: 'reload' });`);
  await network.waitForIdle();
  realm.evalClassic(`grab('/cache', { cache: 'only-if-cached', mode: 'same-origin' });`);
  await network.waitForIdle();
  realm.evalClassic(`grab('/nostore', { cache: 'no-store' });`);
  await network.waitForIdle();
  realm.evalClassic(`grab('/nostore', { cache: 'only-if-cached', mode: 'same-origin' });`);
  await network.waitForIdle();
  realm.evalClassic(`grab('/cache', { cache: 'no-cache' });`);
  await network.waitForIdle();
  realm.evalClassic(`grab('/vary', { headers: { 'X-Flavor': 'a' } });`);
  await network.waitForIdle();
  realm.evalClassic(`grab('/vary', { headers: { 'X-Flavor': 'b' } });`);
  await network.waitForIdle();
  realm.evalClassic(`grab('/vary', { headers: { 'X-Flavor': 'a' } });`);
  await network.waitForIdle();

  const other = await installNetwork(backend, {
    cache: sharedCache,
    documentUrl: 'https://other.example/app/page.html',
  });
  other.realm.evalClassic(
    `globalThis.otherDone = ''; fetch('https://target.example/cache', { cache: 'only-if-cached', mode: 'same-origin' }).catch((error) => { globalThis.otherDone = error.message; });`,
  );
  await other.network.waitForIdle();
  const otherResult = other.realm.evalClassic('otherDone');

  assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(cacheResults)')), [
    ['/cache', 'default', 'body-1', false, false],
    ['/cache', 'default', 'body-1', true, false],
    ['/cache', 'reload', 'body-2', false, false],
    ['/cache', 'only-if-cached', 'body-2', true, false],
    ['/nostore', 'no-store', 'body-3', false, false],
    ['/nostore', 'only-if-cached', 'CACHE_MISS'],
    ['/cache', 'no-cache', 'body-2', false, true],
    ['/vary', 'default', 'body-4', false, false],
    ['/vary', 'default', 'body-5', false, false],
    ['/vary', 'default', 'body-4', true, false],
  ]);
  assert.equal(otherResult, 'CACHE_MISS');
  assert.ok(
    calls.some((record) =>
      record.headers.some(([name, value]) => name === 'if-none-match' && value === '"v1"'),
    ),
  );
  realm.destroy();
  other.realm.destroy();
});

test('virtual HTTP cache can reload persisted entries from the storage manager', async () => {
  const { VirtualHTTPCache } = await apiModule();
  const { MemoryStorageAdapter, VirtualStorageManager } = await storageModule();
  const manager = new VirtualStorageManager({
    adapter: new MemoryStorageAdapter(),
    bodyChunkBytes: 4,
  });
  const partition = 'https://target.example';
  const calls = [];
  const backend = {
    async fetchRaw(record) {
      calls.push(record.url);
      return fetchMessages(record.url, 'durable-body', [['Cache-Control', 'max-age=60']]);
    },
  };
  const first = await installNetwork(backend, {
    cache: new VirtualHTTPCache({ storageManager: manager, storagePartition: partition }),
  });
  first.realm.evalClassic(
    `globalThis.firstBody = ''; fetch('/durable').then((response) => response.text()).then((text) => { globalThis.firstBody = text; });`,
  );
  await first.network.waitForIdle();
  await manager.flush();
  assert.equal(first.realm.evalClassic('firstBody'), 'durable-body');
  assert.equal((await manager.loadHTTPCacheSnapshot(partition))[0].payload.text, 'durable-body');

  const persisted = await manager.loadHTTPCacheSnapshot(partition);
  const second = await installNetwork(backend, {
    cache: new VirtualHTTPCache({
      entries: persisted,
      storageManager: manager,
      storagePartition: partition,
    }),
  });
  second.realm.evalClassic(
    `globalThis.secondBody = ''; fetch('/durable', { cache: 'only-if-cached', mode: 'same-origin' }).then((response) => response.text()).then((text) => { globalThis.secondBody = text; });`,
  );
  await second.network.waitForIdle();
  assert.equal(second.realm.evalClassic('secondBody'), 'durable-body');
  assert.deepEqual(calls, ['https://target.example/durable']);
  first.realm.destroy();
  second.realm.destroy();
});

test('virtual fetch abort calls backend cancellation and rejects with AbortError', async () => {
  const canceled = [];
  const backend = {
    fetchRaw() {
      return new Promise(() => {});
    },
    cancel(id) {
      canceled.push(id);
    },
  };
  const { realm, network } = await installNetwork(backend);
  realm.evalClassic(`
    const descriptorFlags = (owner, key) => {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      return [
        descriptor.enumerable,
        descriptor.configurable,
        'get' in descriptor ? typeof descriptor.get : null,
        'set' in descriptor ? typeof descriptor.set : null,
        'writable' in descriptor ? descriptor.writable : null,
        typeof descriptor.value,
        typeof descriptor.value === 'function' ? descriptor.value.length : null,
      ];
    };
    const controller = new AbortController();
    let newAbortSignal;
    try { new AbortSignal(); newAbortSignal = ['ok']; } catch (error) { newAbortSignal = [error.name, error.message]; }
    const abortEvents = [];
    controller.signal.addEventListener('abort', (event) => abortEvents.push(['listener', event.type, event.bubbles, event.cancelable, controller.signal.aborted, controller.signal.reason && controller.signal.reason.name]));
    controller.signal.onabort = (event) => abortEvents.push(['handler', event.type, event.bubbles, event.cancelable, controller.signal.aborted, controller.signal.reason && controller.signal.reason.name]);
    const staticSignal = AbortSignal.abort('static');
    const combined = AbortSignal.any([staticSignal]);
    const defaultController = new AbortController();
    defaultController.abort();
    let timeoutInvalid;
    try { AbortSignal.timeout(-1); timeoutInvalid = ['ok']; } catch (error) { timeoutInvalid = [error.name, error.message]; }
    let anyInvalid;
    try { AbortSignal.any(); anyInvalid = ['ok']; } catch (error) { anyInvalid = [error.name, error.message]; }
    globalThis.abortShape = [
      Object.prototype.toString.call(controller),
      Object.prototype.toString.call(controller.signal),
      controller.signal instanceof AbortSignal,
      Object.prototype.toString.call(staticSignal),
      staticSignal.aborted,
      staticSignal.reason,
      combined.aborted,
      combined.reason,
      typeof controller.signal.throwIfAborted,
      newAbortSignal,
    ];
    globalThis.abortStructure = {
      controllerOwn: Object.getOwnPropertyNames(controller),
      controllerProto: Object.getOwnPropertyNames(AbortController.prototype),
      controllerSignalDescriptor: descriptorFlags(AbortController.prototype, 'signal'),
      controllerAbortDescriptor: descriptorFlags(AbortController.prototype, 'abort'),
      signalCtorProps: Object.getOwnPropertyNames(AbortSignal),
      signalOwn: Object.getOwnPropertyNames(controller.signal),
      signalProto: Object.getOwnPropertyNames(AbortSignal.prototype),
      signalAbortedDescriptor: descriptorFlags(AbortSignal.prototype, 'aborted'),
      signalOnabortDescriptor: descriptorFlags(AbortSignal.prototype, 'onabort'),
      signalThrowDescriptor: descriptorFlags(AbortSignal.prototype, 'throwIfAborted'),
      defaultReason: [defaultController.signal.reason.name, defaultController.signal.reason.message, Object.prototype.toString.call(defaultController.signal.reason), Object.getOwnPropertyNames(defaultController.signal)],
      timeoutInvalid,
      anyInvalid,
    };
    globalThis.abortName = '';
    globalThis.abortPromise = fetch('/slow', { signal: controller.signal }).catch((error) => { globalThis.abortName = error.name; });
    controller.abort();
    globalThis.abortShape.push(controller.signal.aborted, controller.signal.reason && controller.signal.reason.name, abortEvents);
  `);
  await network.waitForIdle();
  realm.drainJobs();
  assert.equal(realm.evalClassic('abortName'), 'AbortError');
  assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(abortShape)')), [
    '[object AbortController]',
    '[object AbortSignal]',
    true,
    '[object AbortSignal]',
    true,
    'static',
    true,
    'static',
    'function',
    ['TypeError', 'Use `new AbortSignal(...)` instead of `AbortSignal(...)`'],
    true,
    'AbortError',
    [
      ['listener', 'abort', false, false, true, 'AbortError'],
      ['handler', 'abort', false, false, true, 'AbortError'],
    ],
  ]);
  assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(abortStructure)')), {
    controllerOwn: [],
    controllerProto: ['constructor', 'signal', 'abort'],
    controllerSignalDescriptor: [true, true, 'function', 'undefined', null, 'undefined', null],
    controllerAbortDescriptor: [true, true, null, null, true, 'function', 0],
    signalCtorProps: ['length', 'name', 'prototype', 'abort', 'timeout', 'any'],
    signalOwn: [],
    signalProto: ['constructor', 'aborted', 'reason', 'onabort', 'throwIfAborted'],
    signalAbortedDescriptor: [true, true, 'function', 'undefined', null, 'undefined', null],
    signalOnabortDescriptor: [true, true, 'function', 'function', null, 'undefined', null],
    signalThrowDescriptor: [true, true, null, null, true, 'function', 0],
    defaultReason: ['AbortError', 'The operation was aborted.', '[object DOMException]', []],
    timeoutInvalid: ['TypeError', 'Value -1 is outside the range [0, 9007199254740991]'],
    anyInvalid: ['TypeError', 'signals can not be converted to sequence'],
  });
  assert.deepEqual(canceled, ['qfetch-1']);
  realm.destroy();
});

test('virtual XHR EventSource and WebSocket route through backend shims', async () => {
  const calls = [];
  const wsEvents = new Map();
  const backend = {
    async fetchRaw(record) {
      calls.push(record);
      if (record.url.endsWith('/events'))
        return fetchMessages(record.url, 'data: one\n\ndata: two\n\n', [
          ['Content-Type', 'text/event-stream'],
        ]);
      return fetchMessages(record.url, 'xhr-body');
    },
    async openWebSocket(record) {
      calls.push({ type: 'ws.open', url: record.url, protocols: record.protocols });
      wsEvents.set(record.wsId, record.onEvent);
      queueMicrotask(() => {
        record.onEvent({
          type: 'ws.message',
          wsId: record.wsId,
          opcode: 'text',
          bytes: 'server-text',
        });
        record.onEvent({
          type: 'ws.message',
          wsId: record.wsId,
          opcode: 'binary',
          bytes: [1, 2, 3],
        });
      });
      return { wsId: record.wsId, selectedProtocol: 'chat' };
    },
    async sendWebSocket(record) {
      calls.push({
        type: 'ws.send',
        wsId: record.wsId,
        opcode: record.opcode,
        bytes: record.bytes,
      });
      return { type: 'ws.send', wsId: record.wsId };
    },
    async closeWebSocket(record) {
      calls.push({ type: 'ws.close', wsId: record.wsId, code: record.code, reason: record.reason });
      wsEvents.get(record.wsId)?.({
        type: 'ws.close',
        wsId: record.wsId,
        code: record.code,
        reason: record.reason,
        clean: true,
        source: 'local',
      });
      return {
        type: 'ws.close',
        wsId: record.wsId,
        code: record.code,
        reason: record.reason,
        clean: true,
      };
    },
  };
  const { realm, network } = await installNetwork(backend);
  realm.evalClassic(`
    globalThis.events = [];
    events.push(['event-constructors', Object.prototype.toString.call(new MessageEvent('message', { data: 'direct' })), new MessageEvent('message', { data: 'direct' }).data, (() => { const close = new CloseEvent('close', { code: 1001, reason: 'bye', wasClean: true }); let missing = ''; try { new CloseEvent(); } catch (error) { missing = error.name; } return [Object.prototype.toString.call(close), close instanceof CloseEvent, close.code, close.reason, close.wasClean, Object.prototype.hasOwnProperty.call(close, 'code'), Object.getOwnPropertyNames(CloseEvent.prototype), missing]; })()]);
    const xhr = new XMLHttpRequest();
    const xhrBrandErrors = [
      (() => { try { new XMLHttpRequestEventTarget(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      (() => { try { new XMLHttpRequestUpload(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
    ];
    const uploadManual = [];
    xhr.upload.addEventListener('load', () => uploadManual.push('listener'));
    xhr.upload.onload = () => uploadManual.push('handler');
    xhr.upload.dispatchEvent(new Event('load'));
    events.push([
      'xhr-brands',
      typeof XMLHttpRequestEventTarget,
      typeof XMLHttpRequestUpload,
      Object.prototype.toString.call(xhr),
      xhr instanceof XMLHttpRequestEventTarget,
      xhr instanceof EventTarget,
      Object.prototype.toString.call(xhr.upload),
      xhr.upload instanceof XMLHttpRequestUpload,
      xhr.upload instanceof XMLHttpRequestEventTarget,
      xhr.upload instanceof EventTarget,
      xhr.upload === xhr.upload,
      xhr.onloadstart,
      xhr.upload.onloadstart,
      xhrBrandErrors,
      uploadManual,
      [
        Object.getPrototypeOf(XMLHttpRequest.prototype) === XMLHttpRequestEventTarget.prototype,
        Object.getPrototypeOf(XMLHttpRequestUpload.prototype) === XMLHttpRequestEventTarget.prototype,
      ],
    ]);
    xhr.addEventListener('loadstart', () => events.push(['xhr-event', 'loadstart']));
    xhr.addEventListener('loadend', () => events.push(['xhr-event', 'loadend']));
    xhr.onload = () => events.push(['xhr', xhr.status, xhr.responseText, xhr.responseURL]);
    xhr.open('GET', '/xhr');
    xhr.send();
    const source = new EventSource('/events');
    source.onmessage = (event) => events.push(['sse', Object.prototype.toString.call(event), event instanceof MessageEvent, event.data]);
    const ws = new WebSocket('/socket', 'chat');
    events.push(['ws-initial', ws.readyState, ws.binaryType, ws.protocol]);
    try { ws.send('too-soon'); } catch (error) { events.push(['ws-send-before-open', error.name]); }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      events.push(['ws-open', ws.readyState, ws.binaryType, ws.protocol]);
      ws.send('client-hi');
      events.push(['ws-buffered-after-text', ws.bufferedAmount]);
      ws.send(new Uint8Array([7, 8]));
      events.push(['ws-buffered-after-bin', ws.bufferedAmount]);
    };
    ws.onmessage = (event) => {
      events.push(['ws-message', Object.prototype.toString.call(event), event instanceof MessageEvent, typeof event.data, event.data instanceof ArrayBuffer ? Array.from(new Uint8Array(event.data)) : event.data]);
      if (event.data instanceof ArrayBuffer) ws.close(1000, 'done');
    };
    ws.onclose = (event) => events.push(['ws-close', Object.prototype.toString.call(event), event instanceof CloseEvent, ws.readyState, event.code, event.reason, event.wasClean]);
  `);
  await network.waitForIdle();
  const events = JSON.parse(realm.evalClassic('JSON.stringify(events)'));
  assert.deepEqual(
    new Set(events.map((event) => JSON.stringify(event))),
    new Set([
      JSON.stringify([
        'event-constructors',
        '[object MessageEvent]',
        'direct',
        [
          '[object CloseEvent]',
          true,
          1001,
          'bye',
          true,
          false,
          ['wasClean', 'code', 'reason', 'constructor'],
          'TypeError',
        ],
      ]),
      JSON.stringify(['xhr', 200, 'xhr-body', 'https://target.example/xhr']),
      JSON.stringify([
        'xhr-brands',
        'function',
        'function',
        '[object XMLHttpRequest]',
        true,
        true,
        '[object XMLHttpRequestUpload]',
        true,
        true,
        true,
        true,
        null,
        null,
        [
          ['TypeError', "Failed to construct 'XMLHttpRequestEventTarget': Illegal constructor"],
          ['TypeError', "Failed to construct 'XMLHttpRequestUpload': Illegal constructor"],
        ],
        ['listener', 'handler'],
        [true, true],
      ]),
      JSON.stringify(['xhr-event', 'loadstart']),
      JSON.stringify(['xhr-event', 'loadend']),
      JSON.stringify(['sse', '[object MessageEvent]', true, 'one']),
      JSON.stringify(['sse', '[object MessageEvent]', true, 'two']),
      JSON.stringify(['ws-initial', 0, 'blob', '']),
      JSON.stringify(['ws-send-before-open', 'InvalidStateError']),
      JSON.stringify(['ws-open', 1, 'arraybuffer', 'chat']),
      JSON.stringify(['ws-message', '[object MessageEvent]', true, 'string', 'server-text']),
      JSON.stringify(['ws-buffered-after-text', 9]),
      JSON.stringify(['ws-buffered-after-bin', 11]),
      JSON.stringify(['ws-message', '[object MessageEvent]', true, 'object', [1, 2, 3]]),
      JSON.stringify(['ws-close', '[object CloseEvent]', true, 3, 1000, 'done', true]),
    ]),
  );
  assert.deepEqual(
    calls.map((call) => call.type || call.url),
    [
      'https://target.example/xhr',
      'https://target.example/events',
      'ws.open',
      'ws.send',
      'ws.send',
      'ws.close',
    ],
  );
  assert.equal(calls[2].url, 'wss://target.example/socket');
  assert.deepEqual(calls[4].bytes, [7, 8]);
  realm.destroy();
});

test('virtual WebSocket validates protocols binaryType and close arguments like host behavior', async () => {
  const opens = [];
  const backend = {
    async openWebSocket(record) {
      opens.push({ url: record.url, protocols: record.protocols });
      return { wsId: record.wsId, selectedProtocol: record.protocols[0] || '' };
    },
  };
  const { realm, network } = await installNetwork(backend);
  realm.evalClassic(`
    globalThis.wsEdges = [];
    function record(label, fn) {
      try {
        wsEdges.push([label, 'ok', fn()]);
      } catch (error) {
        wsEdges.push([label, 'throw', error.name, error.message]);
      }
    }
    record('no-args', () => new WebSocket());
    record('empty-protocol', () => new WebSocket('/socket', ''));
    record('duplicate-protocol', () => new WebSocket('/socket', ['chat', 'chat']));
    record('bad-protocol-char', () => new WebSocket('/socket', 'bad protocol'));
    const ws = new WebSocket('/socket', 'chat');
    record('binaryType-invalid', () => { ws.binaryType = 'bad'; return ws.binaryType; });
    record('binaryType-arraybuffer', () => { ws.binaryType = 'arraybuffer'; return ws.binaryType; });
    record('close-1001', () => ws.close(1001));
    record('close-long-reason', () => ws.close(1000, 'x'.repeat(124)));
    const ws2 = new WebSocket('/socket2');
    record('close-max-reason', () => { ws2.close(1000, 'x'.repeat(123)); return ws2.readyState; });
  `);
  await network.waitForIdle();
  const edges = JSON.parse(realm.evalClassic('JSON.stringify(wsEdges)'));
  assert.deepEqual(
    edges.map(([label, state, name]) => [label, state, name]),
    [
      ['no-args', 'throw', 'TypeError'],
      ['empty-protocol', 'throw', 'SyntaxError'],
      ['duplicate-protocol', 'throw', 'SyntaxError'],
      ['bad-protocol-char', 'throw', 'SyntaxError'],
      ['binaryType-invalid', 'ok', 'blob'],
      ['binaryType-arraybuffer', 'ok', 'arraybuffer'],
      ['close-1001', 'throw', 'InvalidAccessError'],
      ['close-long-reason', 'throw', 'SyntaxError'],
      ['close-max-reason', 'ok', 2],
    ],
  );
  assert.match(edges.find(([label]) => label === 'close-1001')[3], /1001 is neither/);
  assert.match(edges.find(([label]) => label === 'close-long-reason')[3], /123 UTF-8 bytes/);
  assert.deepEqual(
    opens.map((record) => record.protocols),
    [['chat'], []],
  );
  realm.destroy();
});
