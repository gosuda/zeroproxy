const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleURL = (name) => pathToFileURL(path.resolve(`web/runtime/network/${name}`)).href;

async function protocolModule() {
  return import(moduleURL('protocol.mjs'));
}

async function streamModule() {
  return import(moduleURL('streams.mjs'));
}

async function backendModule() {
  return import(moduleURL('gonetworkbackend.mjs'));
}

function streamedResponse(chunks, options) {
  const encoder = new TextEncoder();
  return {
    status: options.status,
    statusText: options.statusText,
    headers: new Headers(options.headers),
    url: options.url || '',
    redirected: false,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    arrayBuffer() {
      throw new Error('arrayBuffer fallback used instead of body reader');
    },
  };
}

test('GoNetworkBackend protocol envelopes and feature negotiation are versioned', async () => {
  const {
    ARRAYBUFFER_CHUNKS,
    TRANSFERABLE_STREAMS,
    GO_NETWORK_PROTOCOL_VERSION,
    makeHello,
    negotiateReady,
  } = await protocolModule();

  const hello = makeHello({
    id: 'hello-1',
    tabId: 'tab-a',
    backendKind: 'worker',
    requiredFeatures: ['fetchRaw', ARRAYBUFFER_CHUNKS],
    servers: ['wss://relay.example/ws'],
  });
  assert.equal(hello.v, GO_NETWORK_PROTOCOL_VERSION);
  assert.equal(hello.type, 'hello');
  assert.equal(hello.backendKindRequested, 'worker');
  assert.deepEqual(hello.servers, ['wss://relay.example/ws']);

  const ready = negotiateReady(hello, {
    backendKind: 'worker',
    supportedBinaryModes: [ARRAYBUFFER_CHUNKS],
    supportedAPIs: ['fetchRaw', 'cookie'],
    supportedStorageCacheAPIs: ['httpCache'],
  });
  assert.equal(ready.type, 'ready');
  assert.equal(ready.parentId, 'hello-1');
  assert.deepEqual(ready.unsupportedRequiredFeatures, []);

  const unsupported = negotiateReady(
    makeHello({ id: 'hello-2', requiredFeatures: [TRANSFERABLE_STREAMS] }),
    {
      backendKind: 'foreground',
      supportedBinaryModes: [ARRAYBUFFER_CHUNKS],
      supportedAPIs: ['fetchRaw'],
    },
  );
  assert.equal(unsupported.error.code, 'unsupported_feature');
  assert.deepEqual(unsupported.error.features, [TRANSFERABLE_STREAMS]);
});

test('GoNetworkBackend message fixtures cover fetch ws cookie cache storage health shutdown and cancel', async () => {
  const {
    GO_NETWORK_PROTOCOL_VERSION,
    makeCacheMessage,
    makeCookieMessage,
    makeEnvelope,
    makeErrorMessage,
    makeFetchResponseStart,
    makeFetchStart,
    makeStorageMessage,
    makeWebSocketMessage,
  } = await protocolModule();
  const { makeArrayBufferChunkMessages, makeStreamControl } = await streamModule();

  const fetchStart = makeFetchStart({
    requestId: 'req-1',
    tabId: 'tab-1',
    url: 'https://target.example/app.js',
    documentUrl: 'https://target.example/',
    headers: [
      ['Accept', 'text/javascript'],
      ['X-ZP-Test', '1'],
    ],
    initiator: 'script',
    navigationId: 'nav-1',
    resourceId: 'res-1',
  });
  assert.equal(fetchStart.rawMode, true);
  assert.deepEqual(fetchStart.headers, [
    ['Accept', 'text/javascript'],
    ['X-ZP-Test', '1'],
  ]);

  const bodyStreamId = 'body-req-1';
  const messages = [
    fetchStart,
    makeEnvelope('fetch.body.chunk', {
      id: 'body-up-0',
      tabId: 'tab-1',
      requestId: 'req-1',
      streamId: 'upload-1',
      seq: 0,
    }),
    makeEnvelope('fetch.body.end', {
      id: 'body-up-end',
      tabId: 'tab-1',
      requestId: 'req-1',
      streamId: 'upload-1',
    }),
    makeFetchResponseStart({
      requestId: 'req-1',
      tabId: 'tab-1',
      url: fetchStart.url,
      status: 200,
      bodyStreamId,
    }),
    ...makeArrayBufferChunkMessages({
      bytes: 'abcdef',
      bodyStreamId,
      requestId: 'req-1',
      tabId: 'tab-1',
      chunkSize: 3,
    }),
    makeErrorMessage('fetch.error', {
      requestId: 'req-2',
      tabId: 'tab-1',
      code: 'TARGET_CONNECT_FAILED',
    }),
    makeEnvelope('fetch.cancel', { id: 'req-3', tabId: 'tab-1', requestId: 'req-3' }),
    makeEnvelope('sanitize.document', {
      id: 'sanitize-html-1',
      tabId: 'tab-1',
      docId: 'doc-1',
      finalUrl: 'https://target.example/',
      headers: [['Link', '</font.woff2>; rel=preload']],
    }),
    makeEnvelope('sanitize.stylesheet', {
      id: 'sanitize-css-1',
      tabId: 'tab-1',
      docId: 'doc-1',
      baseUrl: 'https://target.example/app.css',
    }),
    makeWebSocketMessage('ws.open', {
      id: 'ws-1',
      tabId: 'tab-1',
      url: 'wss://target.example/ws',
      protocols: ['chat'],
    }),
    makeWebSocketMessage('ws.accepted', {
      parentId: 'ws-1',
      tabId: 'tab-1',
      wsId: 'ws-1',
      selectedProtocol: 'chat',
    }),
    makeWebSocketMessage('ws.send', {
      id: 'ws-send-1',
      tabId: 'tab-1',
      wsId: 'ws-1',
      opcode: 'text',
      bytes: 'hi',
      seq: 1,
    }),
    makeWebSocketMessage('ws.message', {
      id: 'ws-msg-1',
      tabId: 'tab-1',
      wsId: 'ws-1',
      opcode: 'binary',
      bytes: new ArrayBuffer(1),
      seq: 2,
    }),
    makeWebSocketMessage('ws.close', {
      id: 'ws-close-1',
      tabId: 'tab-1',
      wsId: 'ws-1',
      code: 1000,
      reason: 'done',
      clean: true,
      source: 'remote',
    }),
    makeWebSocketMessage('ws.error', {
      id: 'ws-error-1',
      tabId: 'tab-1',
      wsId: 'ws-1',
      reason: 'bad',
    }),
    makeCookieMessage('cookie.get', {
      id: 'cookie-get-1',
      tabId: 'tab-1',
      targetUrl: 'https://target.example/',
    }),
    makeCookieMessage('cookie.get.result', {
      parentId: 'cookie-get-1',
      tabId: 'tab-1',
      cookieString: 'sid=1',
      cookieRecords: [{ name: 'sid' }],
    }),
    makeCookieMessage('cookie.set', {
      id: 'cookie-set-1',
      tabId: 'tab-1',
      targetUrl: 'https://target.example/',
      cookie: 'sid=2',
    }),
    makeCookieMessage('cookie.set.result', { parentId: 'cookie-set-1', tabId: 'tab-1', ok: true }),
    makeStreamControl('stream.credit', {
      id: 'credit-1',
      tabId: 'tab-1',
      streamId: bodyStreamId,
      credit: 2,
    }),
    makeStreamControl('stream.pause', { id: 'pause-1', tabId: 'tab-1', streamId: bodyStreamId }),
    makeStreamControl('stream.resume', { id: 'resume-1', tabId: 'tab-1', streamId: bodyStreamId }),
    makeStreamControl('stream.cancel', {
      id: 'stream-cancel-1',
      tabId: 'tab-1',
      streamId: bodyStreamId,
    }),
    makeEnvelope('health.ping', { id: 'health-1', tabId: 'tab-1' }),
    makeEnvelope('health.pong', { parentId: 'health-1', tabId: 'tab-1' }),
    makeCacheMessage('cache.match', {
      id: 'cache-match-1',
      tabId: 'tab-1',
      cacheKey: 'GET https://target.example/',
    }),
    makeCacheMessage('cache.put', {
      id: 'cache-put-1',
      tabId: 'tab-1',
      cacheKey: 'GET https://target.example/',
    }),
    makeCacheMessage('cache.revalidate', {
      id: 'cache-reval-1',
      tabId: 'tab-1',
      cacheKey: 'GET https://target.example/',
    }),
    makeCacheMessage('cache.evict', {
      id: 'cache-evict-1',
      tabId: 'tab-1',
      partitionKey: 'origin:https://target.example',
    }),
    makeCacheMessage('cache.clearPartition', {
      id: 'cache-clear-1',
      tabId: 'tab-1',
      partitionKey: 'origin:https://target.example',
    }),
    makeCacheMessage('cache.decision', {
      id: 'cache-decision-1',
      tabId: 'tab-1',
      decision: { action: 'skip' },
    }),
    makeStorageMessage('storage.get', {
      id: 'storage-get-1',
      tabId: 'tab-1',
      store: 'localStorage',
      key: 'k',
    }),
    makeStorageMessage('storage.set', {
      id: 'storage-set-1',
      tabId: 'tab-1',
      store: 'localStorage',
      key: 'k',
      value: 'v',
    }),
    makeStorageMessage('storage.delete', {
      id: 'storage-delete-1',
      tabId: 'tab-1',
      store: 'localStorage',
      key: 'k',
    }),
    makeStorageMessage('storage.transaction', {
      id: 'storage-tx-1',
      tabId: 'tab-1',
      store: 'localStorage',
      transactionId: 'tx-1',
    }),
    makeEnvelope('shutdown', { id: 'shutdown-1', tabId: 'tab-1' }),
  ];

  const types = new Set(messages.map((message) => message.type));
  for (const required of [
    'fetch.start',
    'fetch.response.chunk',
    'sanitize.document',
    'sanitize.stylesheet',
    'ws.open',
    'cookie.set',
    'stream.credit',
    'cache.decision',
    'storage.transaction',
    'shutdown',
  ]) {
    assert.ok(types.has(required), `missing ${required}`);
  }
  for (const message of messages) {
    assert.equal(message.v, GO_NETWORK_PROTOCOL_VERSION, message.type);
    assert.ok(message.type, 'type missing');
    assert.ok(message.id, `${message.type} id missing`);
    assert.ok(message.tabId, `${message.type} tabId missing`);
  }
});

test('chunked ArrayBuffer fallback obeys explicit credit pause resume and cancel', async () => {
  const { CreditWindow, makeArrayBufferChunkMessages, makeStreamControl } = await streamModule();
  const messages = makeArrayBufferChunkMessages({
    bytes: 'abcdefgh',
    bodyStreamId: 'body-1',
    requestId: 'req-1',
    tabId: 'tab-1',
    chunkSize: 3,
  });
  assert.deepEqual(
    messages.filter((m) => m.type === 'fetch.response.chunk').map((m) => m.byteLength),
    [3, 3, 2],
  );
  assert.equal(messages.at(-1).type, 'fetch.response.end');
  assert.equal(messages.at(-1).bytesRead, 8);

  const credit = new CreditWindow();
  assert.equal(credit.canSend(), false);
  credit.apply(makeStreamControl('stream.credit', { streamId: 'body-1', credit: 2 }));
  assert.equal(credit.canSend(), true);
  assert.equal(credit.consume(), true);
  credit.apply(makeStreamControl('stream.pause', { streamId: 'body-1' }));
  assert.equal(credit.canSend(), false);
  credit.apply(makeStreamControl('stream.resume', { streamId: 'body-1' }));
  assert.equal(credit.consume(), true);
  assert.equal(credit.canSend(), false);
  credit.apply(makeStreamControl('stream.cancel', { streamId: 'body-1' }));
  assert.deepEqual(credit.snapshot(), { credit: 0, paused: false, canceled: true });
});

test('ForegroundBackend uses injected Go kernel exports and never falls back to native fetch', async () => {
  const { ForegroundBackend } = await backendModule();
  let nativeFetchCalled = false;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => {
    nativeFetchCalled = true;
    throw new Error('native fetch must not be used for target traffic');
  };

  const seen = [];
  const kernelExports = {
    async init(options) {
      seen.push(['init', options.servers]);
    },
    async fetchRaw(record) {
      seen.push(['fetchRaw', record]);
      return streamedResponse(['abc', 'def'], {
        status: 201,
        statusText: 'Created',
        headers: [
          ['Content-Type', 'text/plain'],
          ['X-ZP-Response-URL', 'https://target.example/final'],
        ],
      });
    },
    cookieSet(record) {
      seen.push(['cookieSet', record.cookie]);
      return true;
    },
    cookieGet(record) {
      seen.push(['cookieGet', record.targetUrl]);
      return {
        type: 'cookie.get.result',
        id: 'cookie-result',
        parentId: record.id,
        tabId: record.tabId,
        cookieString: 'sid=1',
      };
    },
  };

  try {
    const backend = new ForegroundBackend({ kernelExports, maximumChunkSize: 3 });
    const init = await backend.init({ tabId: 'tab-1', servers: ['wss://relay.example/ws'] });
    assert.equal(init.backend, 'foreground');
    assert.deepEqual(seen.shift(), ['init', ['wss://relay.example/ws']]);

    const messages = await backend.fetchRaw({
      requestId: 'req-1',
      tabId: 'tab-1',
      url: 'https://target.example/start',
      headers: [['Accept', 'text/plain']],
    });
    assert.equal(messages[0].type, 'fetch.response.start');
    assert.equal(messages[0].status, 201);
    assert.equal(messages[0].finalUrl, 'https://target.example/final');
    assert.deepEqual(
      messages.filter((m) => m.type === 'fetch.response.chunk').map((m) => m.byteLength),
      [3, 3],
    );
    assert.equal(messages.at(-1).type, 'fetch.response.end');
    assert.equal(messages.at(-1).bytesRead, 6);
    assert.equal(seen[0][0], 'fetchRaw');
    assert.equal(seen[0][1].rawMode, true);
    assert.equal(seen[0][1].signal instanceof AbortSignal, true);
    assert.equal((await backend.cancel('req-1')).code, 'CANCELED');

    assert.equal(
      (
        await backend.setCookie({
          tabId: 'tab-1',
          targetUrl: 'https://target.example/',
          cookie: 'sid=2',
        })
      ).ok,
      true,
    );
    assert.equal(
      (await backend.getDocumentCookie({ tabId: 'tab-1', targetUrl: 'https://target.example/' }))
        .cookieString,
      'sid=1',
    );
    assert.equal((await backend.health()).type, 'health.pong');
    assert.equal((await backend.shutdown()).complete, true);
    assert.equal(nativeFetchCalled, false);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('ForegroundBackend exposes sanitizer RPC through injected Go kernel exports', async () => {
  const { ForegroundBackend } = await backendModule();
  const calls = [];
  const kernelExports = {
    async init() {},
    __zp_sanitize_html(record) {
      calls.push(['html', record.docId, record.headers]);
      return { docId: record.docId, records: [{ type: 'document.start' }] };
    },
    __zp_sanitize_css(record) {
      calls.push(['css', record.baseUrl]);
      return { docId: record.docId, css: 'body{}', records: [] };
    },
  };
  const backend = new ForegroundBackend({ kernelExports });
  await backend.init({ tabId: 'tab-1' });
  const html = await backend.sanitizeDocument({
    id: 'sanitize-html',
    tabId: 'tab-1',
    docId: 'doc-1',
    headers: [['Link', '</font.woff2>; rel=preload']],
  });
  const css = await backend.sanitizeStylesheet({
    id: 'sanitize-css',
    tabId: 'tab-1',
    docId: 'doc-1',
    baseUrl: 'https://target.example/app.css',
  });
  assert.equal(html.type, 'sanitize.document.result');
  assert.equal(html.docId, 'doc-1');
  assert.equal(css.type, 'sanitize.stylesheet.result');
  assert.equal(css.css, 'body{}');
  assert.deepEqual(calls, [
    ['html', 'doc-1', [['Link', '</font.woff2>; rel=preload']]],
    ['css', 'https://target.example/app.css'],
  ]);
});

test('WorkerBackend boots through the network worker asset and preserves normalized fetch records', async () => {
  const { WorkerBackend } = await backendModule();
  const { makeFetchResponseStart, negotiateReady } = await protocolModule();
  const { makeArrayBufferChunkMessages } = await streamModule();
  const requests = [];

  class FakeWorker {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      FakeWorker.last = this;
    }
    addEventListener(_type, listener) {
      this.listener = listener;
    }
    postMessage(message) {
      requests.push(message);
      queueMicrotask(() => this.listener({ data: fakeResponse(message) }));
    }
    terminate() {
      this.terminated = true;
    }
  }

  function fakeResponse(message) {
    if (message.type === 'hello') return negotiateReady(message, { backendKind: 'worker' });
    if (message.type === 'init')
      return {
        v: message.v,
        type: 'init.ok',
        id: 'init-ok',
        parentId: message.id,
        tabId: message.tabId,
      };
    if (message.type === 'fetch.start') {
      return [
        makeFetchResponseStart({
          requestId: message.requestId,
          tabId: message.tabId,
          url: message.url,
          status: 200,
          bodyStreamId: 'body-req',
        }),
        ...makeArrayBufferChunkMessages({
          bytes: 'ok',
          bodyStreamId: 'body-req',
          requestId: message.requestId,
          tabId: message.tabId,
        }),
      ];
    }
    return {
      v: message.v,
      type: 'shutdown',
      id: 'shutdown-ok',
      parentId: message.id,
      tabId: message.tabId,
      complete: true,
    };
  }

  const backend = new WorkerBackend({
    WorkerCtor: FakeWorker,
    workerURL: '/zp/assets/network-worker.js',
  });
  await backend.init({ tabId: 'tab-1', servers: ['wss://relay.example/ws'] });
  assert.equal(FakeWorker.last.url, '/zp/assets/network-worker.js');
  assert.equal(FakeWorker.last.options.name, 'zeroproxy-network');

  const messages = await backend.fetchRaw({
    requestId: 'req-1',
    tabId: 'tab-1',
    url: 'https://target.example/',
  });
  assert.equal(messages[0].type, 'fetch.response.start');
  assert.equal(requests.find((msg) => msg.type === 'fetch.start').rawMode, true);
  await backend.shutdown();
  assert.equal(FakeWorker.last.terminated, true);
});

test('WorkerBackend dispatches WebSocket push frames and sends close records', async () => {
  const { WorkerBackend } = await backendModule();
  const { makeEnvelope, makeWebSocketMessage, negotiateReady } = await protocolModule();
  const requests = [];
  const pushed = [];

  class FakeWorker {
    constructor() {
      FakeWorker.last = this;
    }
    addEventListener(_type, listener) {
      this.listener = listener;
    }
    postMessage(message) {
      requests.push(message);
      queueMicrotask(() => this.listener({ data: fakeResponse(message) }));
      if (message.type === 'ws.open') {
        queueMicrotask(() =>
          this.listener({
            data: makeWebSocketMessage('ws.message', {
              parentId: message.id,
              tabId: message.tabId,
              wsId: message.wsId,
              opcode: 'text',
              bytes: 'server-text',
            }),
          }),
        );
      }
    }
    terminate() {}
  }

  function fakeResponse(message) {
    if (message.type === 'hello') return negotiateReady(message, { backendKind: 'worker' });
    if (message.type === 'init')
      return makeEnvelope('init.ok', { parentId: message.id, tabId: message.tabId });
    if (message.type === 'ws.open')
      return makeWebSocketMessage('ws.accepted', {
        parentId: message.id,
        tabId: message.tabId,
        wsId: message.wsId,
        selectedProtocol: 'chat',
      });
    if (message.type === 'ws.send')
      return makeWebSocketMessage('ws.send', {
        parentId: message.id,
        tabId: message.tabId,
        wsId: message.wsId,
        opcode: message.opcode,
        bytes: message.bytes,
      });
    if (message.type === 'ws.close')
      return makeWebSocketMessage('ws.close', {
        parentId: message.id,
        tabId: message.tabId,
        wsId: message.wsId,
        code: message.code,
        reason: message.reason,
        clean: true,
      });
    throw new Error(`unexpected worker message ${message.type}`);
  }

  const backend = new WorkerBackend({ WorkerCtor: FakeWorker });
  await backend.init({ tabId: 'tab-1' });
  backend.addWebSocketListener('ws-1', (message) => pushed.push(message));
  await backend.openWebSocket({
    id: 'ws-1',
    wsId: 'ws-1',
    tabId: 'tab-1',
    url: 'wss://target.example/socket',
    protocols: ['chat'],
  });
  await new Promise((resolve) => queueMicrotask(resolve));
  await backend.sendWebSocket({
    id: 'send-1',
    tabId: 'tab-1',
    wsId: 'ws-1',
    opcode: 'binary',
    bytes: new Uint8Array([7, 8]).buffer,
  });
  await backend.closeWebSocket({
    id: 'close-1',
    tabId: 'tab-1',
    wsId: 'ws-1',
    code: 1000,
    reason: 'done',
  });

  assert.equal(pushed[0].type, 'ws.message');
  assert.equal(pushed[0].bytes, 'server-text');
  assert.equal(requests.find((message) => message.type === 'ws.send').opcode, 'binary');
  assert.equal(requests.find((message) => message.type === 'ws.close').reason, 'done');
});

test('GoNetworkBackend falls back from WorkerBackend to ForegroundBackend through the same API', async () => {
  const { GoNetworkBackend } = await backendModule();
  const calls = [];
  const workerBackend = {
    async init() {
      calls.push('worker.init');
      throw Object.assign(new Error('worker boot failed'), { code: 'WORKER_BOOT_FAILED' });
    },
  };
  const foregroundBackend = {
    async init(options) {
      calls.push(['foreground.init', options.servers]);
      return { backend: 'foreground' };
    },
    async health() {
      return { type: 'health.pong', backendKind: 'foreground' };
    },
  };

  const backend = new GoNetworkBackend({ workerBackend, foregroundBackend });
  const result = await backend.init({ servers: ['wss://relay.example/ws'] });
  assert.equal(result.backend, 'foreground');
  assert.deepEqual(calls, ['worker.init', ['foreground.init', ['wss://relay.example/ws']]]);
  assert.deepEqual(await backend.health(), { type: 'health.pong', backendKind: 'foreground' });
});

test('WorkerBackend and ForegroundBackend match the same normalized request corpus', async () => {
  const { ForegroundBackend, WorkerBackend } = await backendModule();
  const {
    makeCookieMessage,
    makeEnvelope,
    makeFetchResponseStart,
    makeWebSocketMessage,
    negotiateReady,
  } = await protocolModule();
  const { makeArrayBufferChunkMessages } = await streamModule();
  const fetchRecord = {
    requestId: 'diff-fetch',
    tabId: 'tab-1',
    url: 'https://target.example/data',
    headers: [['Accept', 'text/plain']],
    resourceId: 'res-1',
  };
  const fetchMessages = [
    makeFetchResponseStart({
      requestId: fetchRecord.requestId,
      tabId: fetchRecord.tabId,
      resourceId: fetchRecord.resourceId,
      url: fetchRecord.url,
      finalUrl: 'https://target.example/final',
      status: 202,
      statusText: 'Accepted',
      headers: [['Content-Type', 'text/plain']],
      bodyStreamId: 'body-diff-fetch',
      networkBackend: 'foreground',
    }),
    ...makeArrayBufferChunkMessages({
      bytes: 'abcd',
      bodyStreamId: 'body-diff-fetch',
      requestId: fetchRecord.requestId,
      tabId: fetchRecord.tabId,
      chunkSize: 2,
    }),
  ];
  const kernelExports = {
    async init() {},
    async fetchRaw() {
      return fetchMessages;
    },
    openWebSocket() {
      return { streamId: 'stream-1', protocol: 'chat' };
    },
    cookieSet() {
      return true;
    },
    cookieGet(record) {
      return makeCookieMessage('cookie.get.result', {
        parentId: record.id,
        tabId: record.tabId,
        targetUrl: record.targetUrl,
        cookieString: 'sid=1',
      });
    },
  };
  class FakeWorker {
    addEventListener(_type, listener) {
      this.listener = listener;
    }
    postMessage(message) {
      queueMicrotask(() => this.listener({ data: workerResponse(message) }));
    }
    terminate() {}
  }
  function workerResponse(message) {
    if (message.type === 'hello') return negotiateReady(message, { backendKind: 'worker' });
    if (message.type === 'init')
      return makeEnvelope('init.ok', {
        parentId: message.id,
        tabId: message.tabId,
        backendKind: 'worker',
      });
    if (message.type === 'fetch.start') return fetchMessages;
    if (message.type === 'ws.open')
      return makeWebSocketMessage('ws.accepted', {
        parentId: message.id,
        tabId: message.tabId,
        wsId: message.wsId || message.id,
        streamId: 'stream-1',
        selectedProtocol: 'chat',
      });
    if (message.type === 'cookie.set')
      return makeCookieMessage('cookie.set.result', {
        parentId: message.id,
        tabId: message.tabId,
        ok: true,
      });
    if (message.type === 'cookie.get')
      return makeCookieMessage('cookie.get.result', {
        parentId: message.id,
        tabId: message.tabId,
        targetUrl: message.targetUrl,
        cookieString: 'sid=1',
      });
    if (message.type === 'health.ping')
      return makeEnvelope('health.pong', {
        parentId: message.id,
        tabId: message.tabId,
        backendKind: 'worker',
      });
    if (message.type === 'shutdown')
      return makeEnvelope('shutdown', {
        parentId: message.id,
        tabId: message.tabId,
        backendKind: 'worker',
        complete: true,
      });
    throw new Error(`unexpected worker message ${message.type}`);
  }
  function fetchShape(messages) {
    return messages.map((message) => ({
      type: message.type,
      status: message.status,
      finalUrl: message.finalUrl,
      byteLength: message.byteLength,
      bytesRead: message.bytesRead,
      cookieString: message.cookieString,
    }));
  }
  function stripBackendKind(message) {
    const copy = { ...message };
    for (const key of ['backendKind', 'id', 'parentId', 'wsId']) delete copy[key];
    return copy;
  }
  const worker = new WorkerBackend({ WorkerCtor: FakeWorker });
  const foreground = new ForegroundBackend({ kernelExports, maximumChunkSize: 2 });
  await worker.init({ tabId: 'tab-1', servers: ['wss://relay.example/ws'] });
  await foreground.init({ tabId: 'tab-1', servers: ['wss://relay.example/ws'] });
  assert.deepEqual(
    fetchShape(await worker.fetchRaw(fetchRecord)),
    fetchShape(await foreground.fetchRaw(fetchRecord)),
  );
  assert.deepEqual(
    stripBackendKind(
      await worker.openWebSocket({ tabId: 'tab-1', url: 'wss://target.example/ws' }),
    ),
    stripBackendKind(
      await foreground.openWebSocket({ tabId: 'tab-1', url: 'wss://target.example/ws' }),
    ),
  );
  assert.deepEqual(
    stripBackendKind(
      await worker.setCookie({ tabId: 'tab-1', targetUrl: fetchRecord.url, cookie: 'sid=1' }),
    ),
    stripBackendKind(
      await foreground.setCookie({ tabId: 'tab-1', targetUrl: fetchRecord.url, cookie: 'sid=1' }),
    ),
  );
  assert.deepEqual(
    stripBackendKind(
      await worker.getDocumentCookie({ tabId: 'tab-1', targetUrl: fetchRecord.url }),
    ),
    stripBackendKind(
      await foreground.getDocumentCookie({ tabId: 'tab-1', targetUrl: fetchRecord.url }),
    ),
  );
  assert.equal((await worker.health()).type, (await foreground.health()).type);
  assert.equal((await worker.shutdown()).complete, (await foreground.shutdown()).complete);
});
