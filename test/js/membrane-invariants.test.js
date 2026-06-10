const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadRuntime } = require('./quickjs-test-helpers');

const legacyServiceWorkerPaths = [
  'web/sw.js',
  'web/sw-entry.mjs',
  'web/sw/kernel.js',
  'web/sw/routes.js',
  'web/sw/transport.js',
  'web/sw/responses.js',
];

test('membrane: legacy Service Worker and /zp/api target routes are absent', () => {
  for (const file of legacyServiceWorkerPaths)
    assert.equal(fs.existsSync(file), false, `${file} must stay deleted`);
  for (const file of [
    'web/index.html',
    'web/host-shell-entry.mjs',
    'web/runtime/resources/loader.mjs',
    'web/runtime/network/api.mjs',
    'web/runtime/dom/virtual-dom.mjs',
    'web/runtime/webapi/core.mjs',
    'web/worker-prelude.js',
    'cmd/zeroproxy-server/main.go',
  ]) {
    assert.equal(
      fs.readFileSync(file, 'utf8').includes('/zp/api/'),
      false,
      `${file} leaks legacy /zp/api route`,
    );
  }
});

test('membrane: target navigator.serviceWorker is an unsupported virtual facade', async () => {
  const runtime = await loadRuntime();
  const realm = runtime.createRealm();
  const domURL = pathToFileURL(path.resolve('web/runtime/dom/virtual-dom.mjs')).href;
  const coreURL = pathToFileURL(path.resolve('web/runtime/webapi/core.mjs')).href;
  const { installVirtualDOM } = await import(domURL);
  const { installWebAPICore } = await import(coreURL);
  installVirtualDOM({ realm, records: [], href: 'https://target.example/' });
  installWebAPICore({ realm });
  const result = realm.evalClassic(`
    (async () => {
      const out = { controller: navigator.serviceWorker.controller || null, registrations: await navigator.serviceWorker.getRegistrations() };
      try { await navigator.serviceWorker.register('/sw.js'); } catch (error) { out.registerError = error.message; }
      globalThis.__zpSWFacadeResult = JSON.stringify(out);
    })();
  `);
  realm.drainJobs();
  const parsed = JSON.parse(realm.evalClassic('__zpSWFacadeResult'));
  assert.deepEqual(parsed, {
    controller: null,
    registrations: [],
    registerError: 'ServiceWorkerUnsupported',
  });
  realm.destroy();
});

test('membrane: virtual DOM event bridge preserves listener options and inline handlers', async () => {
  const runtime = await loadRuntime();
  const realm = runtime.createRealm();
  const domURL = pathToFileURL(path.resolve('web/runtime/dom/virtual-dom.mjs')).href;
  const { installVirtualDOM } = await import(domURL);
  installVirtualDOM({
    realm,
    href: 'https://target.example/events',
    records: [
      { v: 1, type: 'node.create', docId: 'doc', seq: 1, nodeId: 'n-html', tag: 'html' },
      {
        v: 1,
        type: 'node.create',
        docId: 'doc',
        seq: 2,
        nodeId: 'n-body',
        parentNodeId: 'n-html',
        tag: 'body',
      },
      {
        v: 1,
        type: 'node.create',
        docId: 'doc',
        seq: 3,
        nodeId: 'n-button',
        parentNodeId: 'n-body',
        tag: 'button',
      },
      {
        v: 1,
        type: 'node.attr',
        docId: 'doc',
        seq: 4,
        nodeId: 'n-button',
        name: 'id',
        value: 'button',
      },
      {
        v: 1,
        type: 'event.inlineHandler',
        docId: 'doc',
        seq: 5,
        nodeId: 'n-button',
        event: 'click',
        source: 'globalThis.inlineRan = event.type;',
      },
    ],
  });
  const result = realm.evalClassic(`
    const button = document.getElementById('button');
    const order = [];
    button.addEventListener('click', { handleEvent(event) { order.push('object:' + event.type); } }, { once: true });
    button.onclick = function(event) { order.push('idl:' + this.id + ':' + event.currentTarget.id); };
    const first = __zpDispatchNativeEvent(button.__zpNodeId, 'click');
    const second = __zpDispatchNativeEvent(button.__zpNodeId, 'click');
    JSON.stringify({ first, second, order, inlineRan: globalThis.inlineRan });
  `);
  assert.deepEqual(JSON.parse(result), {
    first: true,
    second: true,
    order: ['object:click', 'idl:button:button', 'idl:button:button'],
  });
  realm.destroy();
});

test('membrane: host shell renders through native renderer without target-origin URLs', () => {
  const shell = fs.readFileSync('web/host-shell-entry.mjs', 'utf8');
  const loader = fs.readFileSync('web/runtime/resources/loader.mjs', 'utf8');
  const dom = fs.readFileSync('web/runtime/dom/virtual-dom.mjs', 'utf8');
  assert.ok(shell.includes('NativeRenderer'));
  assert.ok(shell.includes('ensureRenderRoot'));
  assert.ok(loader.includes('internalResourceURL'));
  assert.ok(dom.includes('__zpDomMutation'));
  assert.equal(dom.includes('targetUrl:'), false);
});
