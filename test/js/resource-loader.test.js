const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleURL = (name) => pathToFileURL(path.resolve(`web/runtime/resources/${name}`)).href;

async function loaderModule() {
  return import(moduleURL('loader.mjs'));
}

function fetchMessages(url, body, headers = [['Content-Type', 'text/plain; charset=utf-8']]) {
  const bytes = new TextEncoder().encode(body);
  return [
    {
      v: 1,
      type: 'fetch.response.start',
      id: `${url}:start`,
      tabId: 'shell',
      requestId: url,
      url,
      finalUrl: url,
      status: 200,
      headers,
      bodyStreamId: `${url}:body`,
    },
    {
      v: 1,
      type: 'fetch.response.chunk',
      id: `${url}:chunk`,
      tabId: 'shell',
      requestId: url,
      bodyStreamId: `${url}:body`,
      seq: 0,
      bytes: bytes.buffer,
      byteLength: bytes.byteLength,
    },
    {
      v: 1,
      type: 'fetch.response.end',
      id: `${url}:end`,
      tabId: 'shell',
      requestId: url,
      bodyStreamId: `${url}:body`,
      bytesRead: bytes.byteLength,
    },
  ];
}

function fakeRealm(calls) {
  return {
    evalClassic(source, filename) {
      calls.push(['classic', filename, source]);
      return true;
    },
    evalModule(source, filename) {
      calls.push(['module', filename, source]);
      return true;
    },
    drainJobs() {
      calls.push(['drain']);
      return 0;
    },
  };
}

test('VirtualResourceLoader sanitizes before records are exposed and fetches resources through backend', async () => {
  const { VirtualResourceLoader } = await loaderModule();
  const fetches = [];
  const sanitizeCalls = [];
  const evalCalls = [];
  const revoked = [];
  const backend = {
    async fetchRaw(record) {
      fetches.push(record);
      if (record.url.endsWith('/'))
        return fetchMessages(record.url, '<html></html>', [
          ['Content-Type', 'text/html; charset=utf-8'],
          ['Link', '</preload.png>; rel=preload'],
        ]);
      if (record.url.endsWith('/app.js'))
        return fetchMessages(record.url, 'globalThis.externalRan = true;', [
          ['Content-Type', 'text/javascript'],
        ]);
      if (record.url.endsWith('/app.css'))
        return fetchMessages(record.url, 'body{background:url(bg.png)}', [
          ['Content-Type', 'text/css'],
        ]);
      if (record.url.endsWith('/img.png'))
        return fetchMessages(record.url, 'image-bytes', [['Content-Type', 'image/png']]);
      if (record.url.endsWith('/bg.png'))
        return fetchMessages(record.url, 'bg-bytes', [['Content-Type', 'image/png']]);
      throw new Error(`unexpected fetch ${record.url}`);
    },
    async sanitizeDocument(record) {
      sanitizeCalls.push(['html', record.headers]);
      return {
        v: 1,
        type: 'sanitize.document.result',
        docId: record.docId,
        finalUrl: record.finalUrl,
        records: [
          { v: 1, type: 'document.start', docId: record.docId, seq: 1 },
          {
            v: 1,
            type: 'script.inline',
            docId: record.docId,
            seq: 2,
            nodeId: 'n1',
            source: 'globalThis.inlineRan = true;',
          },
          {
            v: 1,
            type: 'resource.discovered',
            docId: record.docId,
            seq: 3,
            resourceId: 'script-1',
            kind: 'script',
            resolvedTargetUrl: 'https://target.example/app.js',
            fetchPolicy: 'backend',
          },
          { v: 1, type: 'script.external', docId: record.docId, seq: 4, resourceId: 'script-1' },
          {
            v: 1,
            type: 'resource.discovered',
            docId: record.docId,
            seq: 5,
            resourceId: 'style-1',
            kind: 'style',
            resolvedTargetUrl: 'https://target.example/app.css',
            fetchPolicy: 'backend',
          },
          { v: 1, type: 'style.external', docId: record.docId, seq: 6, resourceId: 'style-1' },
          {
            v: 1,
            type: 'resource.discovered',
            docId: record.docId,
            seq: 7,
            resourceId: 'image-1',
            kind: 'image',
            resolvedTargetUrl: 'https://target.example/img.png',
            fetchPolicy: 'backend',
          },
          { v: 1, type: 'document.end', docId: record.docId, seq: 8 },
        ],
      };
    },
    async sanitizeStylesheet(record) {
      sanitizeCalls.push(['css', record.baseUrl]);
      return {
        v: 1,
        type: 'sanitize.stylesheet.result',
        docId: record.docId,
        css: 'body{background:url("zp-internal://resource/css-1")}',
        records: [
          {
            v: 1,
            type: 'resource.discovered',
            docId: record.docId,
            seq: 9,
            resourceId: 'css-1',
            kind: 'css-url',
            resolvedTargetUrl: 'https://target.example/bg.png',
            fetchPolicy: 'backend',
          },
        ],
      };
    },
  };
  const loader = new VirtualResourceLoader({
    backend,
    realm: fakeRealm(evalCalls),
    createObjectURL: (_bytes, _type, resource) => `blob:zp-${resource.resourceId}`,
    revokeObjectURL: (url) => revoked.push(url),
  });

  const state = await loader.loadDocument({
    targetUrl: 'https://target.example/',
    docId: 'doc-test',
  });
  await Promise.all(state.pendingPassiveResources);

  assert.deepEqual(
    fetches.map((record) => record.url),
    [
      'https://target.example/',
      'https://target.example/app.js',
      'https://target.example/app.css',
      'https://target.example/bg.png',
      'https://target.example/img.png',
    ],
  );
  assert.equal(
    fetches.every((record) => record.rawMode !== false),
    true,
  );
  assert.equal(sanitizeCalls[0][0], 'html');
  assert.deepEqual(
    sanitizeCalls[0][1].map(([name]) => name),
    ['Content-Type', 'Link'],
  );
  assert.deepEqual(
    evalCalls.filter((call) => call[0] === 'classic').map((call) => call[2]),
    ['globalThis.inlineRan = true;', 'globalThis.externalRan = true;'],
  );
  assert.equal(state.fetchedResources.length, 4);
  assert.ok(
    state.records.some(
      (record) => record.type === 'resource.blob.ready' && record.resourceId === 'style-1:css-1',
    ),
  );
  loader.revokeAll();
  assert.deepEqual(revoked.sort(), [
    'blob:zp-image-1',
    'blob:zp-script-1',
    'blob:zp-style-1',
    'blob:zp-style-1:css-1',
  ]);
});

test('VirtualResourceLoader records passive resource timeouts and continues document processing', async () => {
  const { VirtualResourceLoader } = await loaderModule();
  const evalCalls = [];
  const canceled = [];
  const backend = {
    async fetchRaw(record) {
      if (record.url.endsWith('/')) return fetchMessages(record.url, '<html></html>');
      if (record.url.endsWith('/stalled.png')) return new Promise(() => {});
      throw new Error(`unexpected fetch ${record.url}`);
    },
    async cancel(requestId) {
      canceled.push(requestId);
    },
    async sanitizeDocument(record) {
      return {
        v: 1,
        type: 'sanitize.document.result',
        docId: record.docId,
        finalUrl: record.finalUrl,
        records: [
          { v: 1, type: 'document.start', docId: record.docId, seq: 1 },
          {
            v: 1,
            type: 'resource.discovered',
            docId: record.docId,
            seq: 2,
            resourceId: 'stalled-image',
            kind: 'image',
            resolvedTargetUrl: 'https://target.example/stalled.png',
            fetchPolicy: 'backend',
          },
          { v: 1, type: 'document.end', docId: record.docId, seq: 3 },
        ],
      };
    },
  };
  const loader = new VirtualResourceLoader({
    backend,
    realm: fakeRealm(evalCalls),
    resourceTimeoutMs: 5,
  });

  const state = await loader.loadDocument({
    targetUrl: 'https://target.example/',
    docId: 'doc-timeout',
  });
  await Promise.all(state.pendingPassiveResources);

  assert.deepEqual(canceled, ['shell:image:stalled-image']);
  assert.equal(state.fetchedResources.length, 0);
  assert.equal(state.errors.length, 1);
  assert.equal(state.errors[0].resourceId, 'stalled-image');
  assert.match(state.errors[0].error, /FETCH_TIMEOUT/);
});

test('VirtualResourceLoader runs deferred external scripts after later inline records', async () => {
  const { VirtualResourceLoader } = await loaderModule();
  const evalCalls = [];
  const backend = {
    async fetchRaw(record) {
      if (record.url.endsWith('/')) return fetchMessages(record.url, '<html></html>');
      if (record.url.endsWith('/defer.js'))
        return fetchMessages(record.url, 'globalThis.deferredRan = true;', [
          ['Content-Type', 'text/javascript'],
        ]);
      throw new Error(`unexpected fetch ${record.url}`);
    },
    async sanitizeDocument(record) {
      return {
        v: 1,
        type: 'sanitize.document.result',
        docId: record.docId,
        finalUrl: record.finalUrl,
        records: [
          { v: 1, type: 'document.start', docId: record.docId, seq: 1 },
          {
            v: 1,
            type: 'node.create',
            docId: record.docId,
            seq: 2,
            nodeId: 'n-script',
            tag: 'script',
          },
          {
            v: 1,
            type: 'node.attr',
            docId: record.docId,
            seq: 3,
            nodeId: 'n-script',
            name: 'defer',
            value: 'defer',
          },
          {
            v: 1,
            type: 'resource.discovered',
            docId: record.docId,
            seq: 4,
            resourceId: 'script-1',
            kind: 'script',
            resolvedTargetUrl: 'https://target.example/defer.js',
            fetchPolicy: 'backend',
          },
          {
            v: 1,
            type: 'script.external',
            docId: record.docId,
            seq: 5,
            nodeId: 'n-script',
            resourceId: 'script-1',
          },
          {
            v: 1,
            type: 'script.inline',
            docId: record.docId,
            seq: 6,
            nodeId: 'n-inline',
            source: 'globalThis.inlineDataReady = true;',
          },
          { v: 1, type: 'document.end', docId: record.docId, seq: 7 },
        ],
      };
    },
    async sanitizeStylesheet() {
      throw new Error('unexpected stylesheet');
    },
  };
  const loader = new VirtualResourceLoader({
    backend,
    realm: fakeRealm(evalCalls),
    createObjectURL: () => 'blob:script',
  });

  await loader.loadDocument({ targetUrl: 'https://target.example/', docId: 'doc-defer' });

  assert.deepEqual(
    evalCalls.filter((call) => call[0] === 'classic').map((call) => call[2]),
    ['globalThis.inlineDataReady = true;', 'globalThis.deferredRan = true;'],
  );
});

test('VirtualResourceLoader executes dynamically inserted external scripts through the backend', async () => {
  const { VirtualResourceLoader } = await loaderModule();
  const evalCalls = [];
  const fetches = [];
  const backend = {
    async fetchRaw(record) {
      fetches.push(record);
      if (record.url === 'https://target.example/dynamic.js')
        return fetchMessages(record.url, 'globalThis.dynamicRan = true;', [
          ['Content-Type', 'text/javascript'],
        ]);
      throw new Error(`unexpected fetch ${record.url}`);
    },
  };
  const loader = new VirtualResourceLoader({
    backend,
    realm: fakeRealm(evalCalls),
    createObjectURL: () => 'blob:dynamic-script',
  });
  const appendRecord = {
    v: 1,
    type: 'dom.appendChild',
    docId: 'doc-dynamic',
    seq: 2,
    nodeId: 'v-script',
    parentNodeId: 'n-body',
    nodeType: 1,
    tag: 'script',
  };
  const state = {
    docId: 'doc-dynamic',
    targetUrl: 'https://target.example/page',
    finalUrl: 'https://target.example/page',
    records: [
      {
        v: 1,
        type: 'dom.attr',
        docId: 'doc-dynamic',
        seq: 1,
        nodeId: 'v-script',
        name: 'src',
        value: '/dynamic.js',
      },
      appendRecord,
    ],
    resources: new Map(),
    executedScripts: [],
    fetchedResources: [],
    errors: [],
    dynamicScripts: new Set(),
    dynamicResourceCounter: 0,
  };

  await loader.handleDOMMutation(state, appendRecord);

  assert.deepEqual(
    fetches.map((record) => record.url),
    ['https://target.example/dynamic.js'],
  );
  assert.deepEqual(
    evalCalls.filter((call) => call[0] === 'classic').map((call) => call[2]),
    [
      'globalThis.dynamicRan = true;',
      'globalThis.__zpDispatchNodeEvent && globalThis.__zpDispatchNodeEvent("v-script", "load")',
    ],
  );
  assert.equal(state.executedScripts[0].resourceId, 'dynamic-script-1');
  assert.ok(
    state.records.some(
      (record) => record.type === 'resource.discovered' && record.rawValue === '/dynamic.js',
    ),
  );
  assert.ok(
    state.records.some(
      (record) => record.type === 'script.external' && record.nodeId === 'v-script',
    ),
  );
});

test('VirtualResourceLoader fetches dynamic renderer resources and notifies renderer records', async () => {
  const { VirtualResourceLoader } = await loaderModule();
  const evalCalls = [];
  const fetches = [];
  const rendererRecords = [];
  const sanitizeCalls = [];
  const backend = {
    async fetchRaw(record) {
      fetches.push(record);
      if (record.url === 'https://target.example/dynamic.png')
        return fetchMessages(record.url, 'image-bytes', [['Content-Type', 'image/png']]);
      if (record.url === 'https://target.example/dynamic-small.png')
        return fetchMessages(record.url, 'small-bytes', [['Content-Type', 'image/png']]);
      if (record.url === 'https://target.example/dynamic-large.png')
        return fetchMessages(record.url, 'large-bytes', [['Content-Type', 'image/png']]);
      if (record.url === 'https://target.example/dynamic.css')
        return fetchMessages(record.url, '.dynamic{background:url(/dynamic-bg.png)}', [
          ['Content-Type', 'text/css'],
        ]);
      if (record.url === 'https://target.example/dynamic-bg.png')
        return fetchMessages(record.url, 'bg-bytes', [['Content-Type', 'image/png']]);
      if (record.url === 'https://target.example/dynamic-inline-bg.png')
        return fetchMessages(record.url, 'inline-bg-bytes', [['Content-Type', 'image/png']]);
      throw new Error(`unexpected fetch ${record.url}`);
    },
    async sanitizeStylesheet(record) {
      sanitizeCalls.push(record);
      if (record.kind === 'inline-style') {
        return {
          v: 1,
          type: 'sanitize.stylesheet.result',
          docId: record.docId,
          css: '.inline{background:url("zp-internal://resource/inline-bg")}',
          records: [
            {
              v: 1,
              type: 'resource.discovered',
              docId: record.docId,
              seq: 1,
              resourceId: 'inline-bg',
              kind: 'css-url',
              resolvedTargetUrl: 'https://target.example/dynamic-inline-bg.png',
              fetchPolicy: 'backend',
            },
          ],
        };
      }
      return {
        v: 1,
        type: 'sanitize.stylesheet.result',
        docId: record.docId,
        css: '.dynamic{background:url("zp-internal://resource/bg")}',
        records: [
          {
            v: 1,
            type: 'resource.discovered',
            docId: record.docId,
            seq: 1,
            resourceId: 'bg',
            kind: 'css-url',
            resolvedTargetUrl: 'https://target.example/dynamic-bg.png',
            fetchPolicy: 'backend',
          },
        ],
      };
    },
  };
  const loader = new VirtualResourceLoader({
    backend,
    realm: fakeRealm(evalCalls),
    createObjectURL: (_bytes, _type, resource) => `blob:${resource.resourceId}`,
  });
  const appendImage = {
    v: 1,
    type: 'dom.appendChild',
    docId: 'doc-dynamic-resource',
    seq: 3,
    nodeId: 'v-img',
    parentNodeId: 'n-body',
    nodeType: 1,
    tag: 'img',
  };
  const appendLink = {
    v: 1,
    type: 'dom.appendChild',
    docId: 'doc-dynamic-resource',
    seq: 6,
    nodeId: 'v-link',
    parentNodeId: 'n-head',
    nodeType: 1,
    tag: 'link',
  };
  const appendStyle = {
    v: 1,
    type: 'dom.appendChild',
    docId: 'doc-dynamic-resource',
    seq: 7,
    nodeId: 'v-style',
    parentNodeId: 'n-head',
    nodeType: 1,
    tag: 'style',
  };
  const appendStyleText = {
    v: 1,
    type: 'dom.appendChild',
    docId: 'doc-dynamic-resource',
    seq: 8,
    nodeId: 'v-style-text',
    parentNodeId: 'v-style',
    nodeType: 3,
    text: '.inline{background:url(/dynamic-inline-bg.png)}',
  };
  const state = {
    docId: 'doc-dynamic-resource',
    targetUrl: 'https://target.example/page',
    finalUrl: 'https://target.example/page',
    records: [
      {
        v: 1,
        type: 'dom.attr',
        docId: 'doc-dynamic-resource',
        seq: 1,
        nodeId: 'v-img',
        name: 'src',
        value: '/dynamic.png',
      },
      {
        v: 1,
        type: 'dom.attr',
        docId: 'doc-dynamic-resource',
        seq: 2,
        nodeId: 'v-img',
        name: 'srcset',
        value: '/dynamic-small.png 1x, /dynamic-large.png 2x',
      },
      appendImage,
      {
        v: 1,
        type: 'dom.attr',
        docId: 'doc-dynamic-resource',
        seq: 4,
        nodeId: 'v-link',
        name: 'rel',
        value: 'stylesheet',
      },
      {
        v: 1,
        type: 'dom.attr',
        docId: 'doc-dynamic-resource',
        seq: 5,
        nodeId: 'v-link',
        name: 'href',
        value: '/dynamic.css',
      },
      appendLink,
      appendStyle,
      appendStyleText,
    ],
    resources: new Map(),
    executedScripts: [],
    fetchedResources: [],
    errors: [],
    dynamicScripts: new Set(),
    dynamicResourceCounter: 0,
    renderer: { applyMutation: (record) => rendererRecords.push(record) },
    pendingPassiveResources: [],
    pendingPassiveResourceFetches: new Map(),
    passiveResourceQueue: [],
    passiveResourceActive: 0,
  };

  await loader.handleDOMMutation(state, appendImage);
  await loader.handleDOMMutation(state, appendLink);
  await loader.handleDOMMutation(state, appendStyle);
  await loader.handleDOMMutation(state, appendStyleText);
  await Promise.all(state.pendingPassiveResources);

  assert.deepEqual(
    fetches.map((record) => record.url),
    [
      'https://target.example/dynamic.png',
      'https://target.example/dynamic-small.png',
      'https://target.example/dynamic-large.png',
      'https://target.example/dynamic.css',
      'https://target.example/dynamic-bg.png',
      'https://target.example/dynamic-inline-bg.png',
    ],
  );
  assert.equal(sanitizeCalls.length, 2);
  assert.deepEqual(
    evalCalls.filter((call) => call[0] === 'classic').map((call) => call[2]),
    [
      'globalThis.__zpDispatchNodeEvent && globalThis.__zpDispatchNodeEvent("v-img", "load")',
      'globalThis.__zpDispatchNodeEvent && globalThis.__zpDispatchNodeEvent("v-link", "load")',
    ],
  );
  assert.ok(
    rendererRecords.some(
      (record) => record.type === 'resource.discovered' && record.resourceId === 'dynamic-image-1',
    ),
  );
  assert.ok(
    rendererRecords.some(
      (record) => record.type === 'resource.blob.ready' && record.resourceId === 'dynamic-image-1',
    ),
  );
  assert.ok(
    rendererRecords.some(
      (record) =>
        record.type === 'dom.attr' &&
        record.name === 'srcset' &&
        record.value === 'blob:dynamic-srcset-2 1x, blob:dynamic-srcset-3 2x',
    ),
  );
  assert.ok(
    rendererRecords.some(
      (record) => record.type === 'style.inline' && record.resourceId === 'dynamic-style-4',
    ),
  );
  assert.ok(
    rendererRecords.some(
      (record) =>
        record.type === 'style.inline' && record.resourceId === 'dynamic-style-inline-v-style',
    ),
  );
  assert.deepEqual(
    state.fetchedResources.map((resource) => resource.resourceId),
    [
      'dynamic-image-1',
      'dynamic-srcset-2',
      'dynamic-srcset-3',
      'dynamic-style-4',
      'dynamic-style-4:bg',
      'dynamic-style-inline-v-style:inline-bg',
    ],
  );
});
