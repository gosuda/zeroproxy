const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const puppeteer = require('puppeteer');
const { loadRuntime } = require('./quickjs-test-helpers');
const { makeHostMarkupParser } = require('./host-markup-parser-helper');

const HTML_NS = 'http://www.w3.org/1999/xhtml';

const HOST_MARKUP_CORPUS = {
  documents: [
    '<p>x</p>',
    '<!doctype html><html><body><main id="m">T<br>U</main></body></html>',
    '<title>T</title><p id="unsafe" onclick="x">U</p><script>bad()</script>',
    '<title>T</title><p id="safe" onclick="x">S</p><script>bad()</script>',
    '<title>P</title><p data-drop="1"><em onclick="x">Policy</em><script>bad()</script></p>',
  ],
  fragments: [
    '<p id="x" data-a="1 &amp; 2">Hi <b>there</b><!--c--><img src="/a.png"></p>',
    '<section id="s">New<span>!</span></section>',
    '<b onclick="x">Safe</b><script>bad()</script>',
    '<b onclick="x">Unsafe</b><script>bad()</script>',
    '<section>Gone</section><p data-drop="x" data-keep="y"><em data-drop="z">Keep</em><!--c--><span onclick="bad()">S</span></p>',
    { source: '<div id="w">W<b>1</b></div>', context: { name: 'body', namespaceURI: HTML_NS } },
    '<p id="p">Hello <b>World</b></p>',
    '<p id="a">A<span id="b">B</span></p><!--c--><p id="d">D</p>',
    '<p id="m">A<b>B</b><i>C</i>D</p><p id="t">abcdef</p>',
    '<u>U</u>v',
    '<em>E</em>',
    '<span>S</span>',
    '<strong>H</strong>',
    { source: '<em>E</em>', context: { name: 'p', namespaceURI: HTML_NS } },
    { source: '<span>S</span>', context: { name: 'p', namespaceURI: HTML_NS } },
    '<p id="a">A</p>',
    { source: '<tr id="row"><td>A</td></tr>', context: { name: 'tbody', namespaceURI: HTML_NS } },
    '<span>T</span>',
    { source: '<span>T</span>', context: { name: 'template', namespaceURI: HTML_NS } },
    {
      source: '<caption>C</caption><tbody><tr><td>B</td></tr></tbody>',
      context: { name: 'table', namespaceURI: HTML_NS },
    },
  ],
  styles: [
    'background-color: blue; width: 10px;',
    'color: green !important; width: calc(1px + 2px); background-image: url("data:image/svg+xml;utf8,<svg></svg>");',
  ],
};

const domModuleURL = pathToFileURL(path.resolve('web/runtime/dom/virtual-dom.mjs')).href;
const apiModuleURL = pathToFileURL(path.resolve('web/runtime/network/api.mjs')).href;
const coreModuleURL = pathToFileURL(path.resolve('web/runtime/webapi/core.mjs')).href;
const storageModuleURL = pathToFileURL(path.resolve('web/runtime/webapi/storage.mjs')).href;

async function modules() {
  const [dom, api, core, storage] = await Promise.all([
    import(domModuleURL),
    import(apiModuleURL),
    import(coreModuleURL),
    import(storageModuleURL),
  ]);
  return { ...dom, ...api, ...core, ...storage };
}

function fetchMessages(url, body) {
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
      headers: [['Content-Type', 'text/plain']],
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

async function installCore(options = {}) {
  const runtime = await loadRuntime();
  const realm = runtime.createRealm();
  const {
    installVirtualDOM,
    installVirtualNetworkAPIs,
    installWebAPICore,
    MemoryStorageAdapter,
    VirtualStorageManager,
  } = await modules();
  installVirtualDOM({
    realm,
    href: 'https://target.example/app/page.html',
    records: [
      { v: 1, type: 'node.create', docId: 'doc-webapi', seq: 1, nodeId: 'n-html', tag: 'html' },
      {
        v: 1,
        type: 'node.create',
        docId: 'doc-webapi',
        seq: 2,
        nodeId: 'n-body',
        parentNodeId: 'n-html',
        tag: 'body',
      },
      {
        v: 1,
        type: 'node.create',
        docId: 'doc-webapi',
        seq: 3,
        nodeId: 'n-el',
        parentNodeId: 'n-body',
        tag: 'div',
      },
      {
        v: 1,
        type: 'node.attr',
        docId: 'doc-webapi',
        seq: 4,
        nodeId: 'n-el',
        name: 'id',
        value: 'el',
      },
      { v: 1, type: 'node.text', docId: 'doc-webapi', seq: 5, parentNodeId: 'n-el', text: 'hello' },
    ],
  });
  const calls = [];
  const wsEvents = new Map();
  const backend = {
    async fetchRaw(record) {
      calls.push(record);
      return fetchMessages(record.url, 'beacon-ok');
    },
    async openWebSocket(record) {
      wsEvents.set(record.wsId, record.onEvent);
      return { wsId: record.wsId, selectedProtocol: '' };
    },
  };
  const network = installVirtualNetworkAPIs({
    realm,
    backend,
    documentUrl: 'https://target.example/app/page.html',
  });
  const storageManager = new VirtualStorageManager({ adapter: new MemoryStorageAdapter() });
  const storagePartition = storageManager.partitionFor('https://target.example/app/page.html', {
    tabId: 'tab-1',
  });
  await storageManager.adapter.setItem(storagePartition, 'localStorage', 'preloaded', 'old');
  const storageSnapshot = await storageManager.loadSnapshot(storagePartition);
  const hostMarkupParser = await makeHostMarkupParser(HOST_MARKUP_CORPUS);
  installWebAPICore({
    realm,
    config: { userAgent: 'UnitTest/1', platform: 'UnitOS', ...(options.config || {}) },
    storageQuota: options.storageQuota || options.config?.storageQuota,
    hostMarkupParser,
    hostWebAPIBridge: options.hostWebAPIBridge,
    storage: { manager: storageManager, partitionKey: storagePartition, snapshot: storageSnapshot },
  });
  return { realm, network, calls, storageManager, storagePartition, wsEvents };
}

const HOST_BRIDGE_CALL_PAYLOADS = [
  { op: 'static', globalName: 'BluetoothUUID', method: 'canonicalUUID', args: [0x180d] },
  { op: 'static', globalName: 'BluetoothUUID', method: 'getService', args: ['heart_rate'] },
  {
    op: 'static',
    globalName: 'BluetoothUUID',
    method: 'getCharacteristic',
    args: ['battery_level'],
  },
  {
    op: 'static',
    globalName: 'BluetoothUUID',
    method: 'getDescriptor',
    args: ['gatt.client_characteristic_configuration'],
  },
  { op: 'static', globalName: 'BluetoothUUID', method: 'getService', args: ['not_a_service'] },
  { op: 'static', globalName: 'CSS', method: 'escape', args: ['-1a'] },
  { op: 'static', globalName: 'CSS', method: 'escape', args: ['\0'] },
  { op: 'static', globalName: 'CSS', method: 'supports', args: ['display', 'grid'] },
  { op: 'static', globalName: 'CSS', method: 'supports', args: ['(display: grid)'] },
  { op: 'static', globalName: 'CSS', method: 'supports', args: ['not-a-prop', 'x'] },
  { op: 'call', globalName: 'btoa', args: ['ZeroProxy'] },
  { op: 'call', globalName: 'atob', args: ['WmVyb1Byb3h5'] },
  { op: 'call', globalName: 'atob', args: [' WmVy\nb1Byb3h5 '] },
  { op: 'call', globalName: 'btoa', args: ['\0ÿ'] },
  { op: 'call', globalName: 'atob', args: ['%%%%'] },
  { op: 'call', globalName: 'btoa', args: ['€'] },
  { op: 'call', globalName: 'atob', args: [] },
  { op: 'call', globalName: 'btoa', args: [] },
  {
    op: 'construct',
    globalName: 'URLPattern',
    args: [{ protocol: 'https', hostname: '*.example', pathname: '/users/:id', search: 'q=*' }],
  },
  {
    op: 'method',
    globalName: 'URLPattern',
    method: 'test',
    handle: '1',
    args: ['https://api.example/users/42?q=yes#frag'],
  },
  {
    op: 'method',
    globalName: 'URLPattern',
    method: 'test',
    handle: '1',
    args: ['http://api.example/users/42?q=yes'],
  },
  {
    op: 'method',
    globalName: 'URLPattern',
    method: 'exec',
    handle: '1',
    args: ['https://api.example/users/42?q=yes#frag'],
  },
  {
    op: 'method',
    globalName: 'URLPattern',
    method: 'exec',
    handle: '1',
    args: ['https://example.org/users/42?q=yes'],
  },
  { op: 'construct', globalName: 'TextEncoder', args: [] },
  { op: 'method', globalName: 'TextEncoder', method: 'encode', handle: '2', args: ['A€😀'] },
  {
    op: 'method',
    globalName: 'TextEncoder',
    method: 'encodeInto',
    handle: '2',
    args: ['A€😀', [0, 0, 0, 0, 0]],
  },
  {
    op: 'construct',
    globalName: 'TextDecoder',
    args: ['utf-8', { fatal: false, ignoreBOM: false }],
  },
  {
    op: 'method',
    globalName: 'TextDecoder',
    method: 'decode',
    handle: '3',
    args: [[0xef, 0xbb, 0xbf, 65], {}],
  },
  {
    op: 'method',
    globalName: 'TextDecoder',
    method: 'decode',
    handle: '3',
    args: [[0xe2, 0x82], { stream: true }],
  },
  { op: 'method', globalName: 'TextDecoder', method: 'decode', handle: '3', args: [[0xac], {}] },
  { op: 'construct', globalName: 'TextDecoder', args: ['windows-1251'] },
  {
    op: 'method',
    globalName: 'TextDecoder',
    method: 'decode',
    handle: '4',
    args: [[0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2], {}],
  },
  { op: 'construct', globalName: 'TextDecoder', args: ['x-not-real'] },
  {
    op: 'construct',
    globalName: 'RTCIceCandidate',
    args: [
      {
        candidate: 'candidate:1 1 UDP 2122252543 192.0.2.1 54400 typ host',
        sdpMid: '0',
        sdpMLineIndex: 1,
        usernameFragment: 'uf',
      },
    ],
  },
  { op: 'method', globalName: 'RTCIceCandidate', method: 'toJSON', handle: '5', args: [] },
  { op: 'construct', globalName: 'RTCSessionDescription', args: [{ type: 'offer', sdp: 'v=0' }] },
  { op: 'set', globalName: 'RTCSessionDescription', property: 'sdp', handle: '6', value: 'v=1' },
  { op: 'method', globalName: 'RTCSessionDescription', method: 'toJSON', handle: '6', args: [] },
  {
    op: 'construct',
    globalName: 'RTCError',
    args: [{ errorDetail: 'data-channel-failure', sctpCauseCode: 12 }, 'failed'],
  },
  { op: 'construct', globalName: 'RTCError', args: [{}] },
  {
    op: 'construct',
    globalName: 'WebSocketError',
    args: ['closed', { closeCode: 1000, reason: 'done' }],
  },
  { op: 'construct', globalName: 'TextDecoder', args: ['windows-1251', {}] },
  {
    op: 'method',
    globalName: 'TextDecoder',
    method: 'decode',
    handle: '9',
    args: [[0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2], { stream: true }],
  },
  {
    op: 'method',
    globalName: 'TextDecoder',
    method: 'decode',
    handle: '9',
    args: [[], { stream: false }],
  },
  { op: 'method', globalName: 'TextDecoder', method: 'decode', handle: '9', args: [[], {}] },
  {
    op: 'method',
    globalName: 'TextDecoder',
    method: 'decode',
    handle: '10',
    args: [[0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2], { stream: true }],
  },
  {
    op: 'method',
    globalName: 'TextDecoder',
    method: 'decode',
    handle: '10',
    args: [[], { stream: false }],
  },
  { op: 'method', globalName: 'TextDecoder', method: 'decode', handle: '10', args: [[], {}] },
];

const HOST_BRIDGE_DEFINITIONS = {
  atob: {
    browserOnly: true,
    kind: 'globalFunction',
  },
  btoa: {
    browserOnly: true,
    kind: 'globalFunction',
  },
  BluetoothUUID: {
    staticMethods: ['canonicalUUID', 'getService', 'getCharacteristic', 'getDescriptor'],
  },
  CSS: {
    kind: 'namespace',
    staticMethods: ['escape', 'supports'],
  },
  RTCError: {
    browserOnly: true,
    autoFacade: true,
    baseClass: 'DOMException',
    constructFields: [
      'name',
      'message',
      'code',
      'errorDetail',
      'sdpLineNumber',
      'httpRequestStatusCode',
      'sctpCauseCode',
      'receivedAlert',
      'sentAlert',
    ],
    prototypeGetters: [
      'errorDetail',
      'sdpLineNumber',
      'httpRequestStatusCode',
      'sctpCauseCode',
      'receivedAlert',
      'sentAlert',
    ],
  },
  RTCIceCandidate: {
    browserOnly: true,
    autoFacade: true,
    constructFields: [
      'candidate',
      'sdpMid',
      'sdpMLineIndex',
      'foundation',
      'component',
      'priority',
      'address',
      'protocol',
      'port',
      'type',
      'tcpType',
      'relatedAddress',
      'relatedPort',
      'usernameFragment',
      'relayProtocol',
      'url',
    ],
    prototypeGetters: [
      'candidate',
      'sdpMid',
      'sdpMLineIndex',
      'foundation',
      'component',
      'priority',
      'address',
      'protocol',
      'port',
      'type',
      'tcpType',
      'relatedAddress',
      'relatedPort',
      'usernameFragment',
      'relayProtocol',
      'url',
    ],
    prototypeMethods: ['toJSON'],
  },
  RTCSessionDescription: {
    browserOnly: true,
    autoFacade: true,
    constructFields: ['type', 'sdp'],
    prototypeGetters: ['type', 'sdp'],
    prototypeSetters: ['type', 'sdp'],
    prototypeMethods: ['toJSON'],
  },
  TextDecoder: {
    browserOnly: true,
    constructFields: ['encoding', 'fatal', 'ignoreBOM'],
    prototypeMethods: ['decode'],
    methodArgTransforms: {
      decode: ['uint8array'],
    },
  },
  TextEncoder: {
    browserOnly: true,
    constructFields: ['encoding'],
    prototypeMethods: ['encode', 'encodeInto'],
    methodArgTransforms: {
      encodeInto: [null, 'uint8array'],
    },
    methodMutatedArgs: {
      encodeInto: [1],
    },
  },
  URLPattern: {
    constructFields: [
      'protocol',
      'username',
      'password',
      'hostname',
      'port',
      'pathname',
      'search',
      'hash',
      'hasRegExpGroups',
    ],
    prototypeMethods: ['test', 'exec'],
  },
  WebSocketError: {
    browserOnly: true,
    autoFacade: true,
    baseClass: 'DOMException',
    constructFields: ['name', 'message', 'code', 'closeCode', 'reason'],
    prototypeGetters: ['closeCode', 'reason'],
  },
};

let hostBridgeParitySnapshot;

async function snapshotHostBridgeParity() {
  if (!hostBridgeParitySnapshot) hostBridgeParitySnapshot = readHostBridgeParity();
  return hostBridgeParitySnapshot;
}

async function readHostBridgeParity() {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    return await page.evaluate(
      (definitions, payloads, probeSource) => {
        const handles = new Map();
        let nextHandle = 1;
        const probe = Function(`return (${probeSource})`)();
        const calls = {};
        for (const payload of payloads) calls[JSON.stringify(payload)] = dispatch(payload);
        return { shapes: snapshotShapes(), calls, browser: probe() };

        function dispatch(payload) {
          try {
            const target = globalThis[payload.globalName];
            const definition = definitions[payload.globalName];
            if (!target || !definition) return { ok: false, unavailable: true };
            if (payload.op === 'call')
              return definition.kind === 'globalFunction' && typeof target === 'function'
                ? bridgeValue(target(...(payload.args || [])))
                : { ok: false, unavailable: true };
            if (payload.op === 'static') {
              if (!bridgeStaticMethodNames({ definition, target }).includes(payload.method))
                return { ok: false, unavailable: true };
              return bridgeValue(target[payload.method](...(payload.args || [])));
            }
            if (payload.op === 'construct') {
              if (typeof target !== 'function') return { ok: false, unavailable: true };
              const instance = new target(...(payload.args || []));
              const handle = String(nextHandle++);
              handles.set(handle, { globalName: payload.globalName, instance });
              return bridgeValue({
                handle,
                fields: snapshotFields(instance, bridgeConstructFields({ definition, target })),
              });
            }
            if (payload.op === 'method') {
              if (!bridgePrototypeMethodNames({ definition, target }).includes(payload.method))
                return { ok: false, unavailable: true };
              const handle = handles.get(String(payload.handle || ''));
              if (!handle || handle.globalName !== payload.globalName)
                return { ok: false, unavailable: true };
              const args = bridgeArgs(
                payload.args,
                definition.methodArgTransforms?.[payload.method],
              );
              return bridgeValue(
                handle.instance[payload.method](...args),
                methodMutatedArgs(args, definition.methodMutatedArgs?.[payload.method]),
              );
            }
            if (payload.op === 'get') {
              if (!bridgePrototypeGetterNames({ definition, target }).includes(payload.property))
                return { ok: false, unavailable: true };
              const handle = handles.get(String(payload.handle || ''));
              if (!handle || handle.globalName !== payload.globalName)
                return { ok: false, unavailable: true };
              return bridgeValue(handle.instance[payload.property]);
            }
            if (payload.op === 'set') {
              if (!bridgePrototypeSetterNames({ definition, target }).includes(payload.property))
                return { ok: false, unavailable: true };
              const handle = handles.get(String(payload.handle || ''));
              if (!handle || handle.globalName !== payload.globalName)
                return { ok: false, unavailable: true };
              handle.instance[payload.property] = payload.value;
              return bridgeValue(handle.instance[payload.property]);
            }
          } catch (error) {
            return { ok: false, error: { name: error.name, message: error.message } };
          }
          return { ok: false, unavailable: true };
        }

        function bridgeArgs(args, transforms = []) {
          if (!Array.isArray(args)) return [];
          return args.map((arg, index) => {
            if (transforms[index] === 'uint8array')
              return new Uint8Array(Array.isArray(arg) ? arg : []);
            return arg;
          });
        }

        function bridgeValue(value, mutatedArgs = undefined) {
          const out = { ok: true, value: serialize(value) };
          if (mutatedArgs) out.mutatedArgs = mutatedArgs;
          return out;
        }

        function methodMutatedArgs(args, indexes = []) {
          if (!Array.isArray(indexes) || indexes.length === 0) return undefined;
          const out = {};
          for (const index of indexes) out[String(index)] = serialize(args[index]);
          return out;
        }

        function serialize(value, seen = new Map()) {
          if (
            value === null ||
            value === undefined ||
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
          )
            return value;
          if (ArrayBuffer.isView(value)) {
            return {
              __zpBridgeType: value.constructor?.name || 'TypedArray',
              bytes: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
            };
          }
          if (value instanceof ArrayBuffer) {
            return {
              __zpBridgeType: 'ArrayBuffer',
              bytes: Array.from(new Uint8Array(value)),
            };
          }
          if (Array.isArray(value)) return value.map((item) => serialize(item, seen));
          if (typeof value !== 'object') return undefined;
          if (seen.has(value)) return seen.get(value);
          const out = {};
          seen.set(value, out);
          for (const key of Object.keys(value).sort()) out[key] = serialize(value[key], seen);
          return out;
        }

        function snapshotFields(instance, fields) {
          const out = {};
          for (const field of fields) out[field] = serialize(instance[field]);
          return out;
        }

        function snapshotShapes() {
          const out = {};
          for (const [globalName, definition] of Object.entries(definitions)) {
            const target = globalThis[globalName];
            if (!target || (typeof target !== 'object' && typeof target !== 'function')) continue;
            const shape = {
              globalDescriptor: descriptor(globalThis, globalName),
              staticDescriptors: descriptors(
                target,
                bridgeStaticMethodNames({ definition, target }),
              ),
              bridge: bridgeDefinition(definition, target),
            };
            if (typeof target === 'function' && definition.kind !== 'namespace') {
              shape.constructorDescriptor = functionDescriptor(target);
              shape.prototypeDescriptors = descriptors(
                target.prototype,
                prototypeKeys(definition, target),
              );
              shape.prototypeToStringTag = target.prototype
                ? descriptor(target.prototype, Symbol.toStringTag)
                : null;
            } else {
              shape.objectToStringTag = descriptor(target, Symbol.toStringTag);
            }
            out[globalName] = shape;
          }
          return out;
        }

        function bridgeDefinition(definition, target) {
          const snapshot = {};
          if (definition.autoFacade) snapshot.autoFacade = true;
          if (definition.baseClass) snapshot.baseClass = String(definition.baseClass);
          const reflected = { definition, target };
          const valuesByKey = {
            constructFields: bridgeConstructFields(reflected),
            prototypeGetters: bridgePrototypeGetterNames(reflected),
            prototypeSetters: bridgePrototypeSetterNames(reflected),
            prototypeMethods: bridgePrototypeMethodNames(reflected),
            staticMethods: bridgeStaticMethodNames(reflected),
          };
          for (const [key, values] of Object.entries(valuesByKey)) {
            if (values.length) snapshot[key] = values;
          }
          return snapshot;
        }

        function prototypeKeys(definition, target) {
          const reflected = { definition, target };
          return Array.from(
            new Set([
              ...bridgeConstructFields(reflected),
              ...bridgePrototypeGetterNames(reflected),
              ...bridgePrototypeSetterNames(reflected),
              ...bridgePrototypeMethodNames(reflected),
              'constructor',
            ]),
          );
        }

        function bridgeConstructFields(context) {
          const explicit = stringArray(context.definition.constructFields);
          if (explicit.length) return explicit;
          return context.definition.autoFacade ? bridgePrototypeGetterNames(context) : [];
        }

        function bridgePrototypeGetterNames(context) {
          const explicit = stringArray(context.definition.prototypeGetters);
          if (explicit.length) return explicit;
          return context.definition.autoFacade
            ? reflectedPrototypeNames(
                context.target,
                (descriptor) => typeof descriptor.get === 'function',
              )
            : [];
        }

        function bridgePrototypeSetterNames(context) {
          const explicit = stringArray(context.definition.prototypeSetters);
          if (explicit.length) return explicit;
          return context.definition.autoFacade
            ? reflectedPrototypeNames(
                context.target,
                (descriptor) => typeof descriptor.set === 'function',
              )
            : [];
        }

        function bridgePrototypeMethodNames(context) {
          const explicit = stringArray(context.definition.prototypeMethods);
          if (explicit.length) return explicit;
          return context.definition.autoFacade
            ? reflectedPrototypeNames(
                context.target,
                (descriptor) => typeof descriptor.value === 'function',
              )
            : [];
        }

        function bridgeStaticMethodNames(context) {
          const explicit = stringArray(context.definition.staticMethods);
          if (explicit.length || context.definition.kind === 'namespace') return explicit;
          if (!context.definition.autoFacade) return [];
          return Object.getOwnPropertyNames(context.target || {}).filter((name) => {
            if (name === 'length' || name === 'name' || name === 'prototype') return false;
            return (
              typeof Object.getOwnPropertyDescriptor(context.target, name)?.value === 'function'
            );
          });
        }

        function reflectedPrototypeNames(target, predicate) {
          const prototype = target?.prototype;
          if (!prototype) return [];
          return Object.getOwnPropertyNames(prototype).filter((name) => {
            if (name === 'constructor') return false;
            return predicate(Object.getOwnPropertyDescriptor(prototype, name) || {});
          });
        }

        function stringArray(values) {
          return Array.isArray(values) ? values.map((value) => String(value)) : [];
        }

        function descriptors(owner, keys) {
          const out = {};
          if (!owner) return out;
          for (const key of keys) {
            const desc = descriptor(owner, key);
            if (desc) out[String(key)] = desc;
          }
          return out;
        }

        function descriptor(owner, key) {
          const desc = Object.getOwnPropertyDescriptor(owner, key);
          if (!desc) return null;
          const out = {
            configurable: Boolean(desc.configurable),
            enumerable: Boolean(desc.enumerable),
          };
          if ('writable' in desc) out.writable = Boolean(desc.writable);
          if (typeof desc.value === 'function') out.value = functionDescriptor(desc.value);
          else if (
            desc.value !== undefined &&
            desc.value !== null &&
            typeof desc.value !== 'object'
          )
            out.value = desc.value;
          if (desc.get) out.get = functionDescriptor(desc.get);
          if (desc.set) out.set = functionDescriptor(desc.set);
          return out;
        }

        function functionDescriptor(fn) {
          return { name: fn.name, length: fn.length };
        }
      },
      HOST_BRIDGE_DEFINITIONS,
      HOST_BRIDGE_CALL_PAYLOADS,
      bridgeParityProbe.toString(),
    );
  } finally {
    await browser.close();
  }
}

function makeRecordedHostWebAPIBridge(snapshot) {
  return {
    shapes: snapshot.shapes,
    invoke(payloadJSON) {
      const payload = JSON.parse(String(payloadJSON || '{}'));
      const response = snapshot.calls[JSON.stringify(payload)];
      return response ? JSON.parse(JSON.stringify(response)) : { ok: false, unavailable: true };
    },
  };
}

function bridgeParityProbe() {
  const pattern = new URLPattern({
    protocol: 'https',
    hostname: '*.example',
    pathname: '/users/:id',
    search: 'q=*',
  });
  const patternMatch = pattern.exec('https://api.example/users/42?q=yes#frag');
  const encoder = new TextEncoder();
  const encoded = encoder.encode('A€😀');
  const encodeIntoTarget = new Uint8Array(5);
  const encodeInto = encoder.encodeInto('A€😀', encodeIntoTarget);
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
  const decodedBOM = decoder.decode(new Uint8Array([0xef, 0xbb, 0xbf, 65]), {});
  const streamPrefix = decoder.decode(new Uint8Array([0xe2, 0x82]), { stream: true });
  const streamSuffix = decoder.decode(new Uint8Array([0xac]), {});
  const legacyDecoder = new TextDecoder('windows-1251');
  const atobConstructError = captureError(() => new atob());
  const btoaConstructError = captureError(() => new btoa());
  const rtcIceCandidate = new RTCIceCandidate({
    candidate: 'candidate:1 1 UDP 2122252543 192.0.2.1 54400 typ host',
    sdpMid: '0',
    sdpMLineIndex: 1,
    usernameFragment: 'uf',
  });
  const rtcSessionDescription = new RTCSessionDescription({ type: 'offer', sdp: 'v=0' });
  rtcSessionDescription.sdp = 'v=1';
  const rtcError = new RTCError(
    { errorDetail: 'data-channel-failure', sctpCauseCode: 12 },
    'failed',
  );
  const webSocketError = new WebSocketError('closed', { closeCode: 1000, reason: 'done' });
  return {
    BluetoothUUID: {
      type: typeof BluetoothUUID,
      globalDescriptor: descriptor(globalThis, 'BluetoothUUID'),
      staticDescriptors: descriptors(BluetoothUUID, [
        'canonicalUUID',
        'getService',
        'getCharacteristic',
        'getDescriptor',
      ]),
      prototypeTagDescriptor: descriptor(BluetoothUUID.prototype, Symbol.toStringTag),
      prototypeTag: Object.prototype.toString.call(BluetoothUUID.prototype),
      canonical: BluetoothUUID.canonicalUUID(0x180d),
      service: BluetoothUUID.getService('heart_rate'),
      characteristic: BluetoothUUID.getCharacteristic('battery_level'),
      descriptorValue: BluetoothUUID.getDescriptor('gatt.client_characteristic_configuration'),
      invalidService: captureError(() => BluetoothUUID.getService('not_a_service')),
    },
    CSS: {
      type: typeof CSS,
      globalDescriptor: descriptor(globalThis, 'CSS'),
      staticDescriptors: descriptors(CSS, [
        'escape',
        'supports',
        'px',
        'percent',
        'Q',
        'registerProperty',
      ]),
      objectTagDescriptor: descriptor(CSS, Symbol.toStringTag),
      objectTag: Object.prototype.toString.call(CSS),
      extensible: Object.isExtensible(CSS),
      values: {
        escapeDashDigit: CSS.escape('-1a'),
        escapeNull: CSS.escape('\0'),
        escapeSpace: CSS.escape('a b'),
        supportsPair: CSS.supports('display', 'grid'),
        supportsCondition: CSS.supports('(display: grid)'),
        supportsBad: CSS.supports('not-a-prop', 'x'),
        unitPx: [
          CSS.px(2).value,
          CSS.px(2).unit,
          String(CSS.px(2)),
          CSS.px(2) instanceof CSSUnitValue,
        ],
        unitPercent: [
          CSS.percent(2).value,
          CSS.percent(2).unit,
          String(CSS.percent(2)),
          CSS.percent(2) instanceof CSSUnitValue,
        ],
        unitQ: [CSS.Q(2).value, CSS.Q(2).unit, String(CSS.Q(2)), CSS.Q(2) instanceof CSSUnitValue],
        registerProperty: (() => {
          try {
            return [
              CSS.registerProperty({
                name: '--zp-bridge-probe',
                syntax: '<color>',
                inherits: false,
                initialValue: 'red',
              }),
              true,
            ];
          } catch (error) {
            return [error.name, error.message];
          }
        })(),
      },
    },
    Base64: {
      atobType: typeof atob,
      btoaType: typeof btoa,
      atobDescriptor: descriptor(globalThis, 'atob'),
      btoaDescriptor: descriptor(globalThis, 'btoa'),
      atobPrototype: Object.hasOwn(atob, 'prototype'),
      btoaPrototype: Object.hasOwn(btoa, 'prototype'),
      atobConstruct: { ok: atobConstructError.ok, name: atobConstructError.name || '' },
      btoaConstruct: { ok: btoaConstructError.ok, name: btoaConstructError.name || '' },
      values: {
        roundTrip: atob(btoa('ZeroProxy')),
        whitespaceDecode: atob(' WmVy\nb1Byb3h5 '),
        binaryEncode: btoa('\0ÿ'),
        invalidDecode: captureError(() => atob('%%%%')),
        invalidEncode: captureError(() => btoa('€')),
        missingDecode: captureError(() => atob()),
        missingEncode: captureError(() => btoa()),
      },
    },
    TextEncoding: {
      encoder: {
        type: typeof TextEncoder,
        globalDescriptor: descriptor(globalThis, 'TextEncoder'),
        prototypeDescriptors: descriptors(TextEncoder.prototype, [
          'encoding',
          'encode',
          'encodeInto',
          'constructor',
        ]),
        prototypeTagDescriptor: descriptor(TextEncoder.prototype, Symbol.toStringTag),
        instanceTag: Object.prototype.toString.call(encoder),
        instanceOwnKeys: Object.getOwnPropertyNames(encoder).sort(),
        encoding: encoder.encoding,
        encoded: Array.from(encoded),
        encodeInto,
        encodeIntoBytes: Array.from(encodeIntoTarget),
      },
      decoder: {
        type: typeof TextDecoder,
        globalDescriptor: descriptor(globalThis, 'TextDecoder'),
        prototypeDescriptors: descriptors(TextDecoder.prototype, [
          'encoding',
          'fatal',
          'ignoreBOM',
          'decode',
          'constructor',
        ]),
        prototypeTagDescriptor: descriptor(TextDecoder.prototype, Symbol.toStringTag),
        instanceTag: Object.prototype.toString.call(decoder),
        instanceOwnKeys: Object.getOwnPropertyNames(decoder).sort(),
        fields: [decoder.encoding, decoder.fatal, decoder.ignoreBOM],
        decodedBOM,
        stream: [streamPrefix, streamSuffix],
        legacy: [
          legacyDecoder.encoding,
          legacyDecoder.decode(new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), {}),
        ],
        invalidLabel: captureError(() => new TextDecoder('x-not-real')),
      },
    },
    URLPattern: {
      type: typeof URLPattern,
      globalDescriptor: descriptor(globalThis, 'URLPattern'),
      prototypeDescriptors: descriptors(URLPattern.prototype, [
        'protocol',
        'hostname',
        'pathname',
        'search',
        'hasRegExpGroups',
        'test',
        'exec',
        'constructor',
      ]),
      prototypeTagDescriptor: descriptor(URLPattern.prototype, Symbol.toStringTag),
      instanceTag: Object.prototype.toString.call(pattern),
      instanceOwnKeys: Object.getOwnPropertyNames(pattern).sort(),
      fields: [
        pattern.protocol,
        pattern.hostname,
        pattern.pathname,
        pattern.search,
        pattern.hasRegExpGroups,
      ],
      test: [
        pattern.test('https://api.example/users/42?q=yes#frag'),
        pattern.test('http://api.example/users/42?q=yes'),
      ],
      exec: {
        hostname: patternMatch.hostname.input,
        pathname: patternMatch.pathname.input,
        pathnameGroups: patternMatch.pathname.groups,
        search: patternMatch.search.input,
        miss: pattern.exec('https://example.org/users/42?q=yes'),
      },
    },
    AutoHostBridge: {
      RTCIceCandidate: {
        type: typeof RTCIceCandidate,
        globalDescriptor: descriptor(globalThis, 'RTCIceCandidate'),
        prototypeDescriptors: descriptors(RTCIceCandidate.prototype, [
          'candidate',
          'sdpMid',
          'sdpMLineIndex',
          'usernameFragment',
          'toJSON',
          'constructor',
        ]),
        prototypeTagDescriptor: descriptor(RTCIceCandidate.prototype, Symbol.toStringTag),
        instanceTag: Object.prototype.toString.call(rtcIceCandidate),
        instanceOwnKeys: Object.getOwnPropertyNames(rtcIceCandidate).sort(),
        instanceOf: rtcIceCandidate instanceof RTCIceCandidate,
        fields: [
          rtcIceCandidate.candidate,
          rtcIceCandidate.sdpMid,
          rtcIceCandidate.sdpMLineIndex,
          rtcIceCandidate.usernameFragment,
        ],
        json: rtcIceCandidate.toJSON(),
      },
      RTCSessionDescription: {
        type: typeof RTCSessionDescription,
        globalDescriptor: descriptor(globalThis, 'RTCSessionDescription'),
        prototypeDescriptors: descriptors(RTCSessionDescription.prototype, [
          'type',
          'sdp',
          'toJSON',
          'constructor',
        ]),
        prototypeTagDescriptor: descriptor(RTCSessionDescription.prototype, Symbol.toStringTag),
        instanceTag: Object.prototype.toString.call(rtcSessionDescription),
        instanceOwnKeys: Object.getOwnPropertyNames(rtcSessionDescription).sort(),
        fields: [rtcSessionDescription.type, rtcSessionDescription.sdp],
        json: rtcSessionDescription.toJSON(),
      },
      RTCError: {
        type: typeof RTCError,
        globalDescriptor: descriptor(globalThis, 'RTCError'),
        prototypeDescriptors: descriptors(RTCError.prototype, [
          'errorDetail',
          'sctpCauseCode',
          'constructor',
        ]),
        prototypeTagDescriptor: descriptor(RTCError.prototype, Symbol.toStringTag),
        prototypeParentTag: Object.prototype.toString.call(
          Object.getPrototypeOf(RTCError.prototype),
        ),
        instanceTag: Object.prototype.toString.call(rtcError),
        instanceOwnKeys: Object.getOwnPropertyNames(rtcError).sort(),
        instanceOf: [
          rtcError instanceof RTCError,
          rtcError instanceof DOMException,
          rtcError instanceof Error,
        ],
        fields: [
          rtcError.name,
          rtcError.message,
          rtcError.code,
          rtcError.errorDetail,
          rtcError.sctpCauseCode,
        ],
        missingInit: captureError(() => new RTCError({})),
      },
      WebSocketError: {
        type: typeof WebSocketError,
        globalDescriptor: descriptor(globalThis, 'WebSocketError'),
        prototypeDescriptors: descriptors(WebSocketError.prototype, [
          'closeCode',
          'reason',
          'constructor',
        ]),
        prototypeTagDescriptor: descriptor(WebSocketError.prototype, Symbol.toStringTag),
        prototypeParentTag: Object.prototype.toString.call(
          Object.getPrototypeOf(WebSocketError.prototype),
        ),
        instanceTag: Object.prototype.toString.call(webSocketError),
        instanceOwnKeys: Object.getOwnPropertyNames(webSocketError).sort(),
        instanceOf: [
          webSocketError instanceof WebSocketError,
          webSocketError instanceof DOMException,
          webSocketError instanceof Error,
        ],
        fields: [
          webSocketError.name,
          webSocketError.message,
          webSocketError.code,
          webSocketError.closeCode,
          webSocketError.reason,
        ],
      },
    },
  };

  function captureError(fn) {
    try {
      return { ok: true, value: fn() };
    } catch (error) {
      return { ok: false, name: error.name, message: error.message };
    }
  }

  function descriptors(owner, keys) {
    const out = {};
    for (const key of keys) out[String(key)] = descriptor(owner, key);
    return out;
  }

  function descriptor(owner, key) {
    const desc = Object.getOwnPropertyDescriptor(owner, key);
    if (!desc) return null;
    const out = {
      configurable: Boolean(desc.configurable),
      enumerable: Boolean(desc.enumerable),
    };
    if ('writable' in desc) out.writable = Boolean(desc.writable);
    if (typeof desc.value === 'function') out.value = functionDescriptor(desc.value);
    else if (desc.value !== undefined && desc.value !== null && typeof desc.value !== 'object')
      out.value = desc.value;
    if (desc.get) out.get = functionDescriptor(desc.get);
    if (desc.set) out.set = functionDescriptor(desc.set);
    return out;
  }

  function functionDescriptor(fn) {
    return { name: fn.name, length: fn.length };
  }
}

test('host Web API bridge emits auto-facade metadata and routes accessors', async () => {
  const { createHostWebAPIBridge } = await modules();
  class HostValue {
    constructor(init = {}) {
      this._value = String(init.value ?? '');
    }
    get value() {
      return this._value;
    }
    set value(next) {
      this._value = String(next).toUpperCase();
    }
    toJSON() {
      return { value: this._value };
    }
  }
  Object.defineProperty(HostValue.prototype, Symbol.toStringTag, {
    value: 'HostValue',
    configurable: true,
  });
  const root = { document: {} };
  Object.defineProperty(root, 'HostValue', {
    value: HostValue,
    writable: true,
    configurable: true,
  });
  const bridge = createHostWebAPIBridge(root, {
    HostValue: {
      browserOnly: true,
      autoFacade: true,
    },
  });
  assert.equal(bridge.shapes.HostValue.bridge.autoFacade, true);
  assert.deepEqual(bridge.shapes.HostValue.bridge.prototypeSetters, ['value']);
  assert.deepEqual(bridge.shapes.HostValue.bridge.constructFields, ['value']);
  assert.deepEqual(bridge.shapes.HostValue.bridge.prototypeGetters, ['value']);
  assert.deepEqual(bridge.shapes.HostValue.bridge.prototypeMethods, ['toJSON']);
  assert.deepEqual(
    bridge.invoke(
      JSON.stringify({ op: 'construct', globalName: 'HostValue', args: [{ value: 'a' }] }),
    ),
    { ok: true, value: { handle: '1', fields: { value: 'a' } } },
  );
  assert.deepEqual(
    bridge.invoke(
      JSON.stringify({ op: 'get', globalName: 'HostValue', property: 'value', handle: '1' }),
    ),
    { ok: true, value: 'a' },
  );
  assert.deepEqual(
    bridge.invoke(
      JSON.stringify({
        op: 'set',
        globalName: 'HostValue',
        property: 'value',
        handle: '1',
        value: 'b',
      }),
    ),
    { ok: true, value: 'B' },
  );
  assert.deepEqual(
    bridge.invoke(
      JSON.stringify({
        op: 'method',
        globalName: 'HostValue',
        method: 'toJSON',
        handle: '1',
        args: [],
      }),
    ),
    { ok: true, value: { value: 'B' } },
  );
});

test('webapi core can auto-bridge browser WebIDL behavior and reflection', async () => {
  const host = await snapshotHostBridgeParity();
  const { realm } = await installCore({ hostWebAPIBridge: makeRecordedHostWebAPIBridge(host) });
  try {
    const quickjs = JSON.parse(
      realm.evalClassic(`JSON.stringify((${bridgeParityProbe.toString()})())`),
    );
    assert.deepEqual(quickjs, host.browser);
    realm.evalClassic(`
      (async () => {
        const stream = new TextDecoderStream('windows-1251');
        const writer = stream.writable.getWriter();
        const reader = stream.readable.getReader();
        await writer.write(new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]));
        await writer.close();
        const chunk = await reader.read();
        const done = await reader.read();
        globalThis.legacyDecoderStreamBridge = JSON.stringify([stream.encoding, chunk.value, chunk.done, done.done]);
      })().catch((error) => {
        globalThis.legacyDecoderStreamBridge = JSON.stringify({ error: [error.name, error.message] });
      });
    `);
    for (let i = 0; i < 20; i++) realm.drainJobs();
    assert.deepEqual(JSON.parse(realm.evalClassic('legacyDecoderStreamBridge')), [
      'windows-1251',
      'Привет',
      false,
      true,
    ]);
  } finally {
    realm.destroy();
  }
});

test('webapi core exposes Intl constructors backed by host locale behavior', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    JSON.stringify({
      intlType: typeof Intl,
      canonical: Intl.getCanonicalLocales(['EN-us'])[0],
      number: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(1234.5),
      numberParts: new Intl.NumberFormat('en-US').formatToParts(12).map((part) => part.type),
      date: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(0)),
      plural: [new Intl.PluralRules('en-US').select(1), new Intl.PluralRules('en-US').select(2)],
      collator: new Intl.Collator('en-US').compare('a', 'b') < 0,
      locale: [String(new Intl.Locale('en-US')), new Intl.Locale('en-US').language],
    })
  `);
  assert.deepEqual(JSON.parse(result), {
    intlType: 'object',
    canonical: 'en-US',
    number: '1,234.50',
    numberParts: ['integer'],
    date: '01/01/1970',
    plural: ['one', 'other'],
    collator: true,
    locale: ['en-US', 'en'],
  });
  realm.destroy();
});

test('webapi core reflects resource attributes for dynamic elements', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    const script = document.createElement('script');
    script.type = 'module';
    const link = document.createElement('link');
    link.type = 'text/css';
    link.rel = 'stylesheet preload';
    const img = document.createElement('img');
    img.srcset = '/small.png 1x, /large.png 2x';
    img.sizes = '100vw';
    const input = document.createElement('input');
    input.type = 'CHECKBOX';
    JSON.stringify({
      scriptType: script.type,
      scriptAttr: script.getAttribute('type'),
      linkType: link.type,
      linkAttr: link.getAttribute('type'),
      linkRel: link.rel,
      linkRelAttr: link.getAttribute('rel'),
      imgSrcset: img.srcset,
      imgSrcsetAttr: img.getAttribute('srcset'),
      imgSizes: img.sizes,
      imgSizesAttr: img.getAttribute('sizes'),
      inputType: input.type,
      inputAttr: input.getAttribute('type'),
    });
  `);
  assert.deepEqual(JSON.parse(result), {
    scriptType: 'module',
    scriptAttr: 'module',
    linkType: 'text/css',
    linkAttr: 'text/css',
    linkRel: 'stylesheet preload',
    linkRelAttr: 'stylesheet preload',
    imgSrcset: '/small.png 1x, /large.png 2x',
    imgSrcsetAttr: '/small.png 1x, /large.png 2x',
    imgSizes: '100vw',
    imgSizesAttr: '100vw',
    inputType: 'checkbox',
    inputAttr: 'checkbox',
  });
  realm.destroy();
});

test('webapi core installs host integration storage crypto encoding history and navigator stubs', async () => {
  const { realm, network, calls, storageManager, storagePartition } = await installCore();
  const result = realm.evalClassic(`
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const shortView = new Uint16Array(2);
    const shortSame = crypto.getRandomValues(shortView) === shortView;
    const uuid = crypto.randomUUID();
    let floatError;
    try { crypto.getRandomValues(new Float32Array(1)); } catch (error) { floatError = error.name; }
    let quotaError;
    try { crypto.getRandomValues(new Uint8Array(65537)); } catch (error) { quotaError = error.name; }
    const original = { nested: { value: 1 }, list: [1, 2] };
    const cloned = structuredClone(original);
    cloned.nested.value = 2;
    const cloneKey = { id: 1 };
    const cloneValueObject = { value: 2 };
    const complex = { date: new Date(1234), regexp: /zp/gi, map: new Map([[cloneKey, cloneValueObject]]), set: new Set([cloneKey]), buffer: new Uint8Array([1, 2, 3]) };
    complex.self = complex;
    complex.regexp.lastIndex = 1;
    const complexClone = structuredClone(complex);
    const clonedError = structuredClone(new TypeError('bad'));
    const clonedDOMException = structuredClone(new DOMException('nope', 'InvalidStateError'));
    const cloneFailures = [
      (() => { try { structuredClone(function cannotClone() {}); return ['ok']; } catch (error) { return [error.name, error.code, error.message.includes('could not be cloned')]; } })(),
      (() => { try { structuredClone(Symbol('x')); return ['ok']; } catch (error) { return [error.name, error.code, error.message.includes('could not be cloned')]; } })(),
      (() => { try { structuredClone(new WeakMap()); return ['ok']; } catch (error) { return [error.name, error.code, error.message.includes('could not be cloned')]; } })(),
      (() => { try { structuredClone(new URL('https://target.example/')); return ['ok']; } catch (error) { return [error.name, error.code, error.message.includes('URL object could not be cloned')]; } })(),
    ];
    localStorage.setItem('k', 'v');
    sessionStorage.setItem('s', 't');
    history.pushState({ page: 2 }, '', '/next');
    navigator.sendBeacon('/beacon', 'payload');
    const cryptoRandomDescriptor = Object.getOwnPropertyDescriptor(Crypto.prototype, 'getRandomValues');
    JSON.stringify({
      alias: window === globalThis && self === globalThis,
      base64: atob(btoa('ZeroProxy')),
      cloneOriginal: original.nested.value,
      cloneNext: cloned.nested.value,
      cloneTypes: [
        complexClone !== complex,
        complexClone.self === complexClone,
        complexClone.date instanceof Date,
        complexClone.date.getTime(),
        complexClone.regexp instanceof RegExp,
        complexClone.regexp.source,
        complexClone.regexp.flags,
        complexClone.regexp.lastIndex,
        complexClone.map instanceof Map,
        complexClone.map.size,
        [...complexClone.map.keys()][0] !== cloneKey,
        [...complexClone.map.values()][0] !== cloneValueObject,
        [...complexClone.map.values()][0].value,
        complexClone.set instanceof Set,
        complexClone.set.has([...complexClone.map.keys()][0]),
        complexClone.buffer instanceof Uint8Array,
        Array.from(complexClone.buffer).join(','),
      ],
      cloneErrorTypes: [
        clonedError instanceof TypeError,
        clonedError.name,
        clonedError.message,
        typeof clonedError.stack,
        clonedDOMException instanceof DOMException,
        clonedDOMException.name,
        clonedDOMException.message,
        clonedDOMException.code,
      ],
      cloneFailures,
      cloneShape: [structuredClone.length, structuredClone.name, Object.hasOwn(structuredClone, 'prototype'), Reflect.ownKeys(structuredClone).map(String)],
      randomLength: bytes.length,
      randomSome: Array.from(bytes).some((value) => value !== 0),
      randomValidation: [shortSame, shortView.length, Array.from(new Uint8Array(shortView.buffer)).some((value) => value !== 0), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid), uuid[14], '89ab'.includes(uuid[19]), typeof crypto.randomUUID, floatError, quotaError, Object.prototype.toString.call(crypto), crypto instanceof Crypto, Object.isFrozen(crypto), typeof Crypto, (() => { try { new Crypto(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(), Object.hasOwn(crypto, 'getRandomValues'), Object.getOwnPropertyNames(Crypto.prototype), [cryptoRandomDescriptor.enumerable, cryptoRandomDescriptor.configurable, cryptoRandomDescriptor.writable, cryptoRandomDescriptor.value.length], Reflect.ownKeys(Crypto).map(String)],
      local: localStorage.getItem('k'),
      session: sessionStorage.getItem('s'),
      storageCtor: [Object.prototype.toString.call(localStorage), Object.prototype.toString.call(sessionStorage), localStorage instanceof Storage, sessionStorage instanceof Storage, typeof Storage, (() => { try { new Storage(); return ['ok']; } catch (error) { return [error.name, error.message]; } })()],
      preloaded: localStorage.getItem('preloaded'),
      historyLength: history.length,
      historyState: history.state.page,
      href: location.href,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      swRegistrationsType: typeof navigator.serviceWorker.getRegistrations,
      navigatorTag: Object.prototype.toString.call(navigator),
      navigatorCtor: [typeof Navigator, navigator instanceof Navigator, (() => { try { new Navigator(); return ['ok']; } catch (error) { return [error.name, error.message]; } })()],
      clientInformation: [clientInformation === navigator, Object.prototype.toString.call(clientInformation), clientInformation instanceof Navigator],
      vendor: navigator.vendor,
      appName: navigator.appName,
      product: navigator.product,
      languages: navigator.languages,
      hardwareConcurrencyType: typeof navigator.hardwareConcurrency,
      deviceMemoryType: typeof navigator.deviceMemory,
      maxTouchPoints: navigator.maxTouchPoints,
      webdriver: navigator.webdriver,
      pdfViewerEnabled: navigator.pdfViewerEnabled,
      newPluginArray: (() => { try { new PluginArray(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      newMimeTypeArray: (() => { try { new MimeTypeArray(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      plugins: [Object.prototype.toString.call(navigator.plugins), navigator.plugins instanceof PluginArray, navigator.plugins.length, typeof navigator.plugins.item, typeof navigator.plugins.namedItem, typeof navigator.plugins.refresh],
      mimeTypes: [Object.prototype.toString.call(navigator.mimeTypes), navigator.mimeTypes instanceof MimeTypeArray, navigator.mimeTypes.length, typeof navigator.mimeTypes.item, typeof navigator.mimeTypes.namedItem],
      pluginData: (() => {
        const plugin = navigator.plugins[0];
        const mimeType = navigator.mimeTypes[0];
        return {
          pluginOwnNames: Object.getOwnPropertyNames(navigator.plugins),
          mimeTypeOwnNames: Object.getOwnPropertyNames(navigator.mimeTypes),
          pluginObjectOwnNames: Object.getOwnPropertyNames(plugin),
          mimeObjectOwnNames: Object.getOwnPropertyNames(mimeType),
          pluginRows: Array.from(navigator.plugins).map((entry) => [entry.name, entry.filename, entry.description, entry.length]),
          mimeRows: Array.from(navigator.mimeTypes).map((entry) => [entry.type, entry.suffixes, entry.description, entry.enabledPlugin === plugin]),
          pluginMimeRows: Array.from(plugin).map((entry) => [entry.type, entry.suffixes, entry.description, entry.enabledPlugin === plugin]),
          lookups: [
            navigator.plugins.item(0) === plugin,
            navigator.plugins.item('missing') === plugin,
            navigator.plugins.namedItem('PDF Viewer') === plugin,
            navigator.mimeTypes.item(0) === mimeType,
            navigator.mimeTypes.item('missing') === mimeType,
            navigator.mimeTypes.namedItem('application/pdf') === mimeType,
            plugin.item(0) === plugin[0],
            plugin.item('missing') === plugin[0],
            plugin.namedItem('application/pdf') === plugin[0],
          ],
          descriptors: [
            [
              Object.getPrototypeOf(navigator.plugins) === PluginArray.prototype,
              Object.getOwnPropertyDescriptor(PluginArray.prototype, 'length').enumerable,
              Object.getOwnPropertyDescriptor(PluginArray.prototype, 'length').configurable,
              typeof Object.getOwnPropertyDescriptor(PluginArray.prototype, 'length').get,
              Object.getOwnPropertyDescriptor(PluginArray.prototype, Symbol.iterator).value === Array.prototype[Symbol.iterator],
            ],
            [
              Object.getPrototypeOf(navigator.mimeTypes) === MimeTypeArray.prototype,
              Object.getOwnPropertyDescriptor(MimeTypeArray.prototype, 'namedItem').enumerable,
              Object.getOwnPropertyDescriptor(MimeTypeArray.prototype, 'namedItem').configurable,
              Object.getOwnPropertyDescriptor(MimeTypeArray.prototype, 'namedItem').writable,
              Object.getOwnPropertyDescriptor(MimeTypeArray.prototype, Symbol.iterator).value === Array.prototype[Symbol.iterator],
            ],
            [
              Object.getPrototypeOf(plugin) === Plugin.prototype,
              Object.getOwnPropertyDescriptor(Plugin.prototype, 'name').enumerable,
              Object.getOwnPropertyDescriptor(Plugin.prototype, 'name').configurable,
              typeof Object.getOwnPropertyDescriptor(Plugin.prototype, 'name').get,
              Object.getOwnPropertyDescriptor(Plugin.prototype, Symbol.iterator).value === Array.prototype[Symbol.iterator],
            ],
            [
              Object.getPrototypeOf(mimeType) === MimeType.prototype,
              Object.getOwnPropertyNames(mimeType).length,
              Object.getOwnPropertyDescriptor(MimeType.prototype, 'enabledPlugin').enumerable,
              Object.getOwnPropertyDescriptor(MimeType.prototype, 'enabledPlugin').configurable,
              typeof Object.getOwnPropertyDescriptor(MimeType.prototype, 'enabledPlugin').get,
            ],
          ],
        };
      })(),
      storage: (() => {
        const storageGlobal = Object.getOwnPropertyDescriptor(globalThis, 'StorageManager');
        return [
          Object.prototype.toString.call(navigator.storage),
          navigator.storage instanceof StorageManager,
          typeof StorageManager,
          (() => { try { new StorageManager(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          typeof navigator.storage.estimate,
          typeof navigator.storage.persisted,
          typeof navigator.storage.persist,
          typeof navigator.storage.getDirectory,
          Object.getOwnPropertyNames(navigator.storage),
          Object.getOwnPropertyNames(StorageManager.prototype),
          [storageGlobal.enumerable, storageGlobal.configurable, storageGlobal.writable],
          [
            Object.getOwnPropertyDescriptor(StorageManager.prototype, 'estimate').enumerable,
            Object.getOwnPropertyDescriptor(StorageManager.prototype, 'estimate').configurable,
            Object.getOwnPropertyDescriptor(StorageManager.prototype, 'estimate').writable,
            Object.getOwnPropertyDescriptor(StorageManager.prototype, 'estimate').value.length,
          ],
        ];
      })(),
      geolocation: [
        Object.prototype.toString.call(navigator.geolocation),
        navigator.geolocation instanceof Geolocation,
        typeof navigator.geolocation.getCurrentPosition,
        typeof navigator.geolocation.watchPosition,
        typeof navigator.geolocation.clearWatch,
        Object.getOwnPropertyNames(navigator.geolocation).sort(),
        [
          Object.getOwnPropertyDescriptor(Geolocation.prototype, 'getCurrentPosition').enumerable,
          Object.getOwnPropertyDescriptor(Geolocation.prototype, 'getCurrentPosition').configurable,
          Object.getOwnPropertyDescriptor(Geolocation.prototype, 'getCurrentPosition').writable,
          typeof Object.getOwnPropertyDescriptor(Geolocation.prototype, 'getCurrentPosition').value,
          Object.getOwnPropertyDescriptor(Geolocation.prototype, 'getCurrentPosition').value.length,
        ],
        [
          Object.getOwnPropertyDescriptor(GeolocationPositionError.prototype, 'TIMEOUT').enumerable,
          Object.getOwnPropertyDescriptor(GeolocationPositionError.prototype, 'TIMEOUT').configurable,
          Object.getOwnPropertyDescriptor(GeolocationPositionError.prototype, 'TIMEOUT').writable,
          Object.getOwnPropertyDescriptor(GeolocationPositionError.prototype, 'TIMEOUT').value,
        ],
        (() => { try { new Geolocation(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new GeolocationPosition(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new GeolocationCoordinates(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new GeolocationPositionError(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        GeolocationPositionError.PERMISSION_DENIED,
        GeolocationPositionError.prototype.TIMEOUT,
      ],
      connection: (() => {
        const events = [];
        navigator.connection.addEventListener('change', () => events.push('change'));
        navigator.connection.dispatchEvent(new Event('change'));
        return [
          Object.prototype.toString.call(navigator.connection),
          navigator.connection instanceof NetworkInformation,
          navigator.connection instanceof EventTarget,
          navigator.connection.effectiveType,
          navigator.connection.type,
          navigator.connection.downlink,
          navigator.connection.rtt,
          navigator.connection.saveData,
          navigator.connection.onchange,
          Object.getOwnPropertyNames(navigator.connection).sort(),
          [
            Object.getOwnPropertyDescriptor(NetworkInformation.prototype, 'effectiveType').enumerable,
            Object.getOwnPropertyDescriptor(NetworkInformation.prototype, 'effectiveType').configurable,
            typeof Object.getOwnPropertyDescriptor(NetworkInformation.prototype, 'effectiveType').get,
            Object.getOwnPropertyDescriptor(NetworkInformation.prototype, 'effectiveType').set,
          ],
          [
            Object.getOwnPropertyDescriptor(NetworkInformation.prototype, 'onchange').enumerable,
            Object.getOwnPropertyDescriptor(NetworkInformation.prototype, 'onchange').configurable,
            typeof Object.getOwnPropertyDescriptor(NetworkInformation.prototype, 'onchange').get,
            typeof Object.getOwnPropertyDescriptor(NetworkInformation.prototype, 'onchange').set,
          ],
          events,
          (() => { try { new NetworkInformation(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      locks: [
        Object.prototype.toString.call(navigator.locks),
        navigator.locks instanceof LockManager,
        typeof navigator.locks.request,
        typeof navigator.locks.query,
        Object.getOwnPropertyNames(navigator.locks),
        Object.getOwnPropertyNames(LockManager.prototype),
        Object.getOwnPropertyNames(Lock.prototype),
        Object.prototype.hasOwnProperty.call(Lock, Symbol.hasInstance),
        Object.prototype.hasOwnProperty.call(LockManager, Symbol.hasInstance),
        Object.getOwnPropertyDescriptor(globalThis, 'Lock').enumerable,
        Object.getOwnPropertyDescriptor(globalThis, 'LockManager').enumerable,
        navigator.locks.request.length,
        navigator.locks.query.length,
        (() => { try { new LockManager(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { LockManager(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new Lock(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { Lock(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ],
      userActivation: [
        Object.prototype.toString.call(navigator.userActivation),
        navigator.userActivation instanceof UserActivation,
        navigator.userActivation.isActive,
        navigator.userActivation.hasBeenActive,
        Object.isFrozen(navigator.userActivation),
        Object.getOwnPropertyNames(navigator.userActivation).sort(),
        [
          Object.getOwnPropertyDescriptor(UserActivation.prototype, 'isActive').enumerable,
          Object.getOwnPropertyDescriptor(UserActivation.prototype, 'isActive').configurable,
          typeof Object.getOwnPropertyDescriptor(UserActivation.prototype, 'isActive').get,
          Object.getOwnPropertyDescriptor(UserActivation.prototype, 'isActive').set,
        ],
        (() => { try { new UserActivation(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ],
      bluetoothUUID: [
        typeof BluetoothUUID,
        BluetoothUUID.canonicalUUID(0x180f),
        BluetoothUUID.canonicalUUID('0000180F-0000-1000-8000-00805F9B34FB'),
        BluetoothUUID.getService('battery_service'),
        BluetoothUUID.getCharacteristic('battery_level'),
        BluetoothUUID.getDescriptor('gatt.client_characteristic_configuration'),
        (() => { try { new BluetoothUUID(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { BluetoothUUID.getService('unknown-service'); return ['ok']; } catch (error) { return [error.name]; } })(),
      ],
      storageEvent: (() => { const event = new StorageEvent('storage', { key: 'k', oldValue: 'old', newValue: 'new', url: 'https://target.example/page', storageArea: localStorage }); const initialized = new StorageEvent('x'); initialized.initStorageEvent('storage', true, true, 'a', 'b', 'c', 'https://target.example/other', sessionStorage); return [Object.prototype.toString.call(event), event instanceof StorageEvent, event instanceof Event, event.key, event.oldValue, event.newValue, event.url, event.storageArea === localStorage, initialized.type, initialized.bubbles, initialized.cancelable, initialized.key, initialized.oldValue, initialized.newValue, initialized.url, initialized.storageArea === sessionStorage]; })(),
      keyboard: (() => {
        const keyboardGlobal = Object.getOwnPropertyDescriptor(globalThis, 'Keyboard');
        const layoutGlobal = Object.getOwnPropertyDescriptor(globalThis, 'KeyboardLayoutMap');
        return [
          Object.prototype.toString.call(navigator.keyboard),
          navigator.keyboard instanceof Keyboard,
          Object.isFrozen(navigator.keyboard),
          Object.getOwnPropertyNames(navigator.keyboard),
          Object.getOwnPropertyNames(Keyboard.prototype),
          [keyboardGlobal.enumerable, keyboardGlobal.configurable, keyboardGlobal.writable],
          Object.prototype.hasOwnProperty.call(Keyboard, Symbol.hasInstance),
          typeof navigator.keyboard.getLayoutMap,
          typeof navigator.keyboard.lock,
          typeof navigator.keyboard.unlock,
          (() => { try { new Keyboard(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { Keyboard(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new KeyboardLayoutMap(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { KeyboardLayoutMap(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.hasOwnProperty.call(KeyboardLayoutMap, Symbol.hasInstance),
          [layoutGlobal.enumerable, layoutGlobal.configurable, layoutGlobal.writable],
          Object.getOwnPropertyNames(KeyboardLayoutMap.prototype),
          KeyboardLayoutMap.prototype[Symbol.iterator] === KeyboardLayoutMap.prototype.entries,
        ];
      })(),
      windowControlsOverlay: (() => {
        const overlay = navigator.windowControlsOverlay;
        const rect = overlay.getTitlebarAreaRect();
        const event = new WindowControlsOverlayGeometryChangeEvent('geometrychange', { visible: true, titlebarAreaRect: rect });
        return [
          Object.prototype.toString.call(overlay),
          overlay instanceof WindowControlsOverlay,
          overlay instanceof EventTarget,
          overlay.visible,
          typeof overlay.getTitlebarAreaRect,
          Object.prototype.toString.call(rect),
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          Object.prototype.toString.call(event),
          event instanceof WindowControlsOverlayGeometryChangeEvent,
          event instanceof Event,
          event.visible,
          event.titlebarAreaRect,
          (() => { try { new WindowControlsOverlay(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      wakeLock: (() => {
        const wakeGlobal = Object.getOwnPropertyDescriptor(globalThis, 'WakeLock');
        const sentinelGlobal = Object.getOwnPropertyDescriptor(globalThis, 'WakeLockSentinel');
        return [
          Object.prototype.toString.call(navigator.wakeLock),
          navigator.wakeLock instanceof WakeLock,
          Object.isFrozen(navigator.wakeLock),
          Object.getOwnPropertyNames(navigator.wakeLock),
          Object.getOwnPropertyNames(WakeLock.prototype),
          [wakeGlobal.enumerable, wakeGlobal.configurable, wakeGlobal.writable],
          Object.prototype.hasOwnProperty.call(WakeLock, Symbol.hasInstance),
          typeof navigator.wakeLock.request,
          (() => { try { new WakeLock(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { WakeLock(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new WakeLockSentinel(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { WakeLockSentinel(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.hasOwnProperty.call(WakeLockSentinel, Symbol.hasInstance),
          [sentinelGlobal.enumerable, sentinelGlobal.configurable, sentinelGlobal.writable],
          Object.getOwnPropertyNames(WakeLockSentinel.prototype),
        ];
      })(),
      gamepads: (() => {
        const pads = navigator.getGamepads();
        const gamepadGlobal = Object.getOwnPropertyDescriptor(globalThis, 'Gamepad');
        const buttonGlobal = Object.getOwnPropertyDescriptor(globalThis, 'GamepadButton');
        return [
          typeof navigator.getGamepads,
          Array.isArray(pads),
          pads.length,
          pads.every((pad) => pad === null),
          Object.isFrozen(pads),
          (() => { try { new Gamepad(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { Gamepad(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.hasOwnProperty.call(Gamepad, Symbol.hasInstance),
          Object.getOwnPropertyNames(Gamepad.prototype),
          [gamepadGlobal.enumerable, gamepadGlobal.configurable, gamepadGlobal.writable],
          Object.getOwnPropertyNames(GamepadButton.prototype),
          [buttonGlobal.enumerable, buttonGlobal.configurable, buttonGlobal.writable],
          Object.prototype.hasOwnProperty.call(GamepadButton, Symbol.hasInstance),
          (() => { try { new GamepadButton(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { GamepadButton(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      credentials: (() => {
        const credentialGlobal = Object.getOwnPropertyDescriptor(globalThis, 'Credential');
        const containerGlobal = Object.getOwnPropertyDescriptor(globalThis, 'CredentialsContainer');
        return [
          Object.prototype.toString.call(navigator.credentials),
          navigator.credentials instanceof CredentialsContainer,
          Object.isFrozen(navigator.credentials),
          Object.getOwnPropertyNames(navigator.credentials),
          Object.getOwnPropertyNames(CredentialsContainer.prototype),
          [containerGlobal.enumerable, containerGlobal.configurable, containerGlobal.writable],
          Object.getOwnPropertyNames(Credential.prototype),
          [credentialGlobal.enumerable, credentialGlobal.configurable, credentialGlobal.writable],
          Object.getOwnPropertyNames(Credential),
          [
            Object.getOwnPropertyDescriptor(Credential, 'isConditionalMediationAvailable').enumerable,
            Object.getOwnPropertyDescriptor(Credential, 'isConditionalMediationAvailable').configurable,
            Object.getOwnPropertyDescriptor(Credential, 'isConditionalMediationAvailable').writable,
            typeof Credential.isConditionalMediationAvailable,
            Credential.isConditionalMediationAvailable.length,
          ],
          Object.prototype.hasOwnProperty.call(Credential, Symbol.hasInstance),
          Object.prototype.hasOwnProperty.call(CredentialsContainer, Symbol.hasInstance),
          typeof navigator.credentials.get,
          typeof navigator.credentials.create,
          typeof navigator.credentials.store,
          typeof navigator.credentials.preventSilentAccess,
          (() => { try { new Credential(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { Credential(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new CredentialsContainer(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { CredentialsContainer(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      payment: (() => {
        const request = new PaymentRequest([{ supportedMethods: 'basic-card' }], { id: 'pay-1', total: { label: 'Total', amount: { currency: 'USD', value: '1.00' } } }, { shippingType: 'shipping' });
        return [
          typeof PaymentRequest,
          Object.prototype.toString.call(request),
          request instanceof PaymentRequest,
          request instanceof EventTarget,
          request.id,
          request.shippingAddress,
          request.shippingOption,
          request.shippingType,
          typeof request.canMakePayment,
          typeof request.show,
          (() => { try { new PaymentResponse(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new PaymentAddress(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      contacts: [
        Object.prototype.toString.call(navigator.contacts),
        navigator.contacts instanceof ContactsManager,
        Object.isFrozen(navigator.contacts),
        typeof navigator.contacts.getProperties,
        typeof navigator.contacts.select,
        (() => { try { new ContactsManager(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new ContactAddress(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ],
      mediaCapabilities: (() => {
        const mediaCapabilitiesGlobal = Object.getOwnPropertyDescriptor(globalThis, 'MediaCapabilities');
        return [
          Object.prototype.toString.call(navigator.mediaCapabilities),
          navigator.mediaCapabilities instanceof MediaCapabilities,
          Object.isFrozen(navigator.mediaCapabilities),
          Object.getOwnPropertyNames(navigator.mediaCapabilities),
          Object.getOwnPropertyNames(MediaCapabilities.prototype),
          [mediaCapabilitiesGlobal.enumerable, mediaCapabilitiesGlobal.configurable, mediaCapabilitiesGlobal.writable],
          Object.prototype.hasOwnProperty.call(MediaCapabilities, Symbol.hasInstance),
          [
            Object.getOwnPropertyDescriptor(MediaCapabilities.prototype, 'decodingInfo').enumerable,
            Object.getOwnPropertyDescriptor(MediaCapabilities.prototype, 'decodingInfo').configurable,
            Object.getOwnPropertyDescriptor(MediaCapabilities.prototype, 'decodingInfo').writable,
            Object.getOwnPropertyDescriptor(MediaCapabilities.prototype, 'decodingInfo').value.length,
          ],
          typeof navigator.mediaCapabilities.decodingInfo,
          typeof navigator.mediaCapabilities.encodingInfo,
          (() => { try { new MediaCapabilities(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { MediaCapabilities(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      mediaSession: (() => {
        const metadata = new MediaMetadata({ title: 'Track', artist: 'Artist', album: 'Album', artwork: [{ src: '/cover.png', sizes: '96x96', type: 'image/png' }] });
        navigator.mediaSession.metadata = metadata;
        navigator.mediaSession.playbackState = 'playing';
        const setHandler = navigator.mediaSession.setActionHandler('play', () => {});
        const clearHandler = navigator.mediaSession.setActionHandler('play', null);
        const setPosition = navigator.mediaSession.setPositionState({ duration: 1, position: 0, playbackRate: 1 });
        let invalidState = '';
        let invalidAction = '';
        try { navigator.mediaSession.playbackState = 'buffering'; } catch (error) { invalidState = error.name; }
        try { navigator.mediaSession.setActionHandler('bad-action', () => {}); } catch (error) { invalidAction = error.name; }
        return [
          Object.prototype.toString.call(navigator.mediaSession),
          navigator.mediaSession instanceof MediaSession,
          Object.isFrozen(navigator.mediaSession),
          Object.prototype.toString.call(metadata),
          metadata.title,
          metadata.artist,
          metadata.album,
          Object.isFrozen(metadata.artwork),
          metadata.artwork[0].src,
          metadata.artwork[0].sizes,
          metadata.artwork[0].type,
          Object.getOwnPropertyNames(metadata).sort(),
          Object.isFrozen(metadata.artwork[0]),
          metadata.chapterInfo.length,
          metadata.chapterInfo === metadata.chapterInfo,
          (() => { metadata.title = 3; return metadata.title; })(),
          (() => { try { metadata.artwork = 1; return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          navigator.mediaSession.metadata === metadata,
          navigator.mediaSession.playbackState,
          setHandler === undefined,
          clearHandler === undefined,
          setPosition === undefined,
          invalidState,
          invalidAction,
          (() => { try { new MediaSession(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      share: [
        typeof navigator.canShare,
        typeof navigator.share,
        navigator.canShare({ title: 'ZeroProxy' }),
        navigator.canShare({ files: [] }),
      ],
      launchQueue: [
        Object.prototype.toString.call(launchQueue),
        launchQueue instanceof LaunchQueue,
        Object.isFrozen(launchQueue),
        Object.getOwnPropertyNames(launchQueue),
        Object.getOwnPropertyNames(LaunchQueue.prototype),
        Object.getOwnPropertyNames(LaunchParams.prototype),
        Object.getOwnPropertyDescriptor(globalThis, 'LaunchQueue').enumerable,
        Object.getOwnPropertyDescriptor(globalThis, 'LaunchParams').enumerable,
        Object.prototype.hasOwnProperty.call(LaunchQueue, Symbol.hasInstance),
        Object.prototype.hasOwnProperty.call(LaunchParams, Symbol.hasInstance),
        typeof launchQueue.setConsumer,
        launchQueue.setConsumer.length,
        (() => { try { launchQueue.setConsumer(null); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new LaunchQueue(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { LaunchQueue(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new LaunchParams(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { LaunchParams(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ],
      notification: (() => {
        const notification = new Notification('ZeroProxy', { body: 'Body', tag: 'tag', data: { ok: true }, silent: true, requireInteraction: true, timestamp: 123 });
        const notificationGlobal = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
        const permissionDescriptor = Object.getOwnPropertyDescriptor(Notification, 'permission');
        return [
          typeof Notification,
          Notification.permission,
          Notification.maxActions,
          typeof Notification.requestPermission,
          Object.prototype.toString.call(notification),
          notification instanceof Notification,
          notification instanceof EventTarget,
          Object.getOwnPropertyNames(notification),
          Object.getOwnPropertyNames(Notification.prototype),
          Object.getOwnPropertyNames(Notification),
          [notificationGlobal.enumerable, notificationGlobal.configurable, notificationGlobal.writable],
          [permissionDescriptor.enumerable, permissionDescriptor.configurable, Boolean(permissionDescriptor.get)],
          [notification.title, notification.body, notification.tag, notification.silent, notification.requireInteraction, notification.timestamp, notification.data.ok],
          (() => { try { new Notification(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new Notification('x', { actions: [{ action: 'a', title: 'A' }] }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      reporting: (() => {
        const observed = [];
        const observer = new ReportingObserver((reports, activeObserver) => { observed.push(reports.length, activeObserver === observer); }, { types: ['csp-violation'], buffered: true });
        const observeReturn = observer.observe();
        const records = observer.takeRecords();
        const disconnectReturn = observer.disconnect();
        return [
          typeof ReportingObserver,
          Object.prototype.toString.call(observer),
          observer instanceof ReportingObserver,
          typeof observer.observe,
          typeof observer.disconnect,
          typeof observer.takeRecords,
          observeReturn === undefined,
          Array.isArray(records),
          records.length,
          disconnectReturn === undefined,
          observed.length,
          (() => { try { new ReportingObserver(null); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new ReportBody(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new CSPViolationReportBody(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.getPrototypeOf(CSPViolationReportBody.prototype) === ReportBody.prototype,
          (() => { try { new IntegrityViolationReportBody(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.getPrototypeOf(IntegrityViolationReportBody.prototype) === ReportBody.prototype,
        ];
      })(),
      crashReport: [
        Object.prototype.toString.call(crashReport),
        crashReport instanceof CrashReportContext,
        Object.isFrozen(crashReport),
        typeof crashReport.initialize,
        typeof crashReport.set,
        typeof crashReport.delete,
        (() => { try { new CrashReportContext(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ],
      featurePolicy: [
        typeof FeaturePolicy,
        Object.prototype.toString.call(document.featurePolicy),
        document.featurePolicy instanceof FeaturePolicy,
        Object.isFrozen(document.featurePolicy),
        document.featurePolicy.features().length,
        document.featurePolicy.allowedFeatures().length,
        document.featurePolicy.allowsFeature('geolocation'),
        document.featurePolicy.getAllowlistForFeature('geolocation').length,
        (() => { try { document.featurePolicy.allowsFeature(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new FeaturePolicy(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ],
      inputDeviceCapabilities: (() => {
        const caps = new InputDeviceCapabilities({ firesTouchEvents: true });
        const defaultCaps = new InputDeviceCapabilities();
        const event = new UIEvent('zp', { sourceCapabilities: caps });
        const inputGlobal = Object.getOwnPropertyDescriptor(globalThis, 'InputDeviceCapabilities');
        const firesDescriptor = Object.getOwnPropertyDescriptor(InputDeviceCapabilities.prototype, 'firesTouchEvents');
        return [
          Object.prototype.toString.call(caps),
          caps instanceof InputDeviceCapabilities,
          caps.firesTouchEvents,
          defaultCaps.firesTouchEvents,
          event.sourceCapabilities === caps,
          event.sourceCapabilities instanceof InputDeviceCapabilities,
          Object.getOwnPropertyNames(caps),
          Object.getOwnPropertyNames(InputDeviceCapabilities.prototype),
          [inputGlobal.enumerable, inputGlobal.configurable, inputGlobal.writable],
          [firesDescriptor.enumerable, firesDescriptor.configurable, Boolean(firesDescriptor.get), firesDescriptor.set ?? null],
          (() => { try { InputDeviceCapabilities(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      mediaDiagnostics: (() => {
        const mediaError = Object.create(MediaError.prototype);
        const mediaErrorGlobal = Object.getOwnPropertyDescriptor(globalThis, 'MediaError');
        const mediaErrorCodeDescriptor = Object.getOwnPropertyDescriptor(MediaError.prototype, 'code');
        const mediaErrorConstantDescriptor = Object.getOwnPropertyDescriptor(MediaError, 'MEDIA_ERR_SRC_NOT_SUPPORTED');
        const mediaErrorPrototypeConstantDescriptor = Object.getOwnPropertyDescriptor(MediaError.prototype, 'MEDIA_ERR_SRC_NOT_SUPPORTED');
        const captureMediaError = (callback) => {
          try {
            return ['ok', callback()];
          } catch (error) {
            return [error.name, error.message];
          }
        };
        const capabilities = InputDeviceInfo.prototype.getCapabilities();
        const inputDeviceInfoGlobal = Object.getOwnPropertyDescriptor(globalThis, 'InputDeviceInfo');
        const inputDeviceInfoMethod = Object.getOwnPropertyDescriptor(InputDeviceInfo.prototype, 'getCapabilities');
        return [
          typeof MediaError,
          Object.prototype.toString.call(mediaError),
          mediaError instanceof MediaError,
          Object.getOwnPropertyNames(MediaError),
          Object.getOwnPropertyNames(MediaError.prototype),
          [mediaErrorGlobal.enumerable, mediaErrorGlobal.configurable, mediaErrorGlobal.writable],
          Object.getOwnPropertyDescriptor(MediaError, 'prototype').writable,
          Object.prototype.hasOwnProperty.call(MediaError, Symbol.hasInstance),
          [mediaErrorCodeDescriptor.enumerable, mediaErrorCodeDescriptor.configurable, typeof mediaErrorCodeDescriptor.get, mediaErrorCodeDescriptor.set],
          [mediaErrorConstantDescriptor.enumerable, mediaErrorConstantDescriptor.configurable, mediaErrorConstantDescriptor.writable],
          [mediaErrorPrototypeConstantDescriptor.enumerable, mediaErrorPrototypeConstantDescriptor.configurable, mediaErrorPrototypeConstantDescriptor.writable],
          captureMediaError(() => mediaError.code),
          captureMediaError(() => mediaError.message),
          MediaError.MEDIA_ERR_ABORTED,
          MediaError.MEDIA_ERR_NETWORK,
          MediaError.MEDIA_ERR_DECODE,
          MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED,
          MediaError.prototype.MEDIA_ERR_SRC_NOT_SUPPORTED,
          captureMediaError(() => MediaError()),
          captureMediaError(() => new MediaError()),
          typeof InputDeviceInfo,
          Object.prototype.toString.call(Object.create(InputDeviceInfo.prototype)),
          Object.create(InputDeviceInfo.prototype) instanceof InputDeviceInfo,
          typeof InputDeviceInfo.prototype.getCapabilities,
          Object.keys(capabilities).length,
          Object.isFrozen(capabilities),
          Object.getOwnPropertyNames(InputDeviceInfo.prototype),
          Object.prototype.hasOwnProperty.call(InputDeviceInfo, Symbol.hasInstance),
          [inputDeviceInfoGlobal.enumerable, inputDeviceInfoGlobal.configurable, inputDeviceInfoGlobal.writable],
          [inputDeviceInfoMethod.enumerable, inputDeviceInfoMethod.configurable, inputDeviceInfoMethod.writable, inputDeviceInfoMethod.value.length],
          (() => { try { new InputDeviceInfo(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { InputDeviceInfo(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      legacyBrowserFacades: (() => {
        const plugin = Object.create(Plugin.prototype);
        const mimeType = Object.create(MimeType.prototype);
        const domError = new DOMError('NetworkError', 'offline');
        const overconstrained = new OverconstrainedError('width', 'bad');
        const quotaExceeded = new QuotaExceededError('full', { quota: 5, requested: 7 });
        return [
          typeof Plugin,
          Object.prototype.toString.call(plugin),
          plugin instanceof Plugin,
          (() => { try { new Plugin(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          typeof MimeType,
          Object.prototype.toString.call(mimeType),
          mimeType instanceof MimeType,
          (() => { try { new MimeType(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.toString.call(domError),
          domError instanceof DOMError,
          domError.name,
          domError.message,
          DOMError.name,
          DOMError.length,
          Object.getOwnPropertyDescriptor(globalThis, 'DOMError').enumerable,
          Object.getOwnPropertyNames(domError),
          (() => {
            const nameDescriptor = Object.getOwnPropertyDescriptor(DOMError.prototype, 'name');
            const messageDescriptor = Object.getOwnPropertyDescriptor(DOMError.prototype, 'message');
            const constructorDescriptor = Object.getOwnPropertyDescriptor(DOMError.prototype, 'constructor');
            return [
              [nameDescriptor.enumerable, nameDescriptor.configurable, !!nameDescriptor.get, !!nameDescriptor.set],
              [messageDescriptor.enumerable, messageDescriptor.configurable, !!messageDescriptor.get, !!messageDescriptor.set],
              [constructorDescriptor.enumerable, constructorDescriptor.writable, constructorDescriptor.configurable, constructorDescriptor.value.name, constructorDescriptor.value.length],
            ];
          })(),
          (() => { try { DOMError('NetworkError'); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new DOMError(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.toString.call(overconstrained),
          overconstrained instanceof OverconstrainedError,
          overconstrained instanceof DOMException,
          overconstrained.name,
          overconstrained.message,
          overconstrained.constraint,
          OverconstrainedError.name,
          OverconstrainedError.length,
          Object.getOwnPropertyDescriptor(globalThis, 'OverconstrainedError').enumerable,
          Object.getOwnPropertyNames(overconstrained),
          (() => {
            const constraintDescriptor = Object.getOwnPropertyDescriptor(OverconstrainedError.prototype, 'constraint');
            const constructorDescriptor = Object.getOwnPropertyDescriptor(OverconstrainedError.prototype, 'constructor');
            return [
              [constraintDescriptor.enumerable, constraintDescriptor.configurable, !!constraintDescriptor.get, !!constraintDescriptor.set],
              [constructorDescriptor.enumerable, constructorDescriptor.writable, constructorDescriptor.configurable, constructorDescriptor.value.name, constructorDescriptor.value.length],
            ];
          })(),
          (() => { try { OverconstrainedError('width'); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new OverconstrainedError(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.toString.call(quotaExceeded),
          quotaExceeded instanceof QuotaExceededError,
          quotaExceeded instanceof DOMException,
          quotaExceeded.name,
          quotaExceeded.message,
          quotaExceeded.code,
          quotaExceeded.quota,
          quotaExceeded.requested,
          QuotaExceededError.name,
          QuotaExceededError.length,
          Object.getOwnPropertyDescriptor(globalThis, 'QuotaExceededError').enumerable,
          Object.getOwnPropertyNames(quotaExceeded),
          (() => {
            const quotaDescriptor = Object.getOwnPropertyDescriptor(QuotaExceededError.prototype, 'quota');
            const requestedDescriptor = Object.getOwnPropertyDescriptor(QuotaExceededError.prototype, 'requested');
            const constructorDescriptor = Object.getOwnPropertyDescriptor(QuotaExceededError.prototype, 'constructor');
            return [
              [quotaDescriptor.enumerable, quotaDescriptor.configurable, !!quotaDescriptor.get, !!quotaDescriptor.set],
              [requestedDescriptor.enumerable, requestedDescriptor.configurable, !!requestedDescriptor.get, !!requestedDescriptor.set],
              [constructorDescriptor.enumerable, constructorDescriptor.writable, constructorDescriptor.configurable, constructorDescriptor.value.name, constructorDescriptor.value.length],
            ];
          })(),
          (() => { try { QuotaExceededError('full'); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new QuotaExceededError('bad', 'options'); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      mediaStreamFacades: (() => {
        const audioTrack = Object.create(MediaStreamTrack.prototype);
        Object.defineProperties(audioTrack, {
          __zpKind: { value: 'audio', configurable: true, writable: true },
          __zpTrackId: { value: 'audio-1', configurable: true, writable: true },
          __zpLabel: { value: 'microphone', configurable: true, writable: true },
          __zpEnabled: { value: true, configurable: true, writable: true },
          __zpMuted: { value: false, configurable: true, writable: true },
          __zpReadyState: { value: 'live', configurable: true, writable: true },
          __zpContentHint: { value: '', configurable: true, writable: true },
        });
        const videoTrack = Object.create(MediaStreamTrack.prototype);
        Object.defineProperties(videoTrack, {
          __zpKind: { value: 'video', configurable: true, writable: true },
          __zpTrackId: { value: 'video-1', configurable: true, writable: true },
          __zpLabel: { value: 'camera', configurable: true, writable: true },
          __zpEnabled: { value: true, configurable: true, writable: true },
          __zpMuted: { value: false, configurable: true, writable: true },
          __zpReadyState: { value: 'live', configurable: true, writable: true },
          __zpContentHint: { value: '', configurable: true, writable: true },
        });
        const stream = new MediaStream([audioTrack]);
        stream.addTrack(audioTrack);
        stream.addTrack(videoTrack);
        const clonedStream = stream.clone();
        audioTrack.enabled = false;
        audioTrack.stop();
        const canvasTrack = Object.create(CanvasCaptureMediaStreamTrack.prototype);
        const browserTrack = Object.create(BrowserCaptureMediaStreamTrack.prototype);
        const audioSink = Object.create(AudioSinkInfo.prototype);
        const audioStats = Object.create(MediaStreamTrackAudioStats.prototype);
        const videoStats = Object.create(MediaStreamTrackVideoStats.prototype);
        const recorder = new MediaRecorder(stream, {
          mimeType: 'video/webm',
          videoBitsPerSecond: 123,
          audioBitsPerSecond: 45,
          audioBitrateMode: 'constant',
        });
        recorder.start();
        const recorderRecordingState = recorder.state;
        let recorderStartError;
        try { recorder.start(); } catch (error) { recorderStartError = [error.name, error.message]; }
        recorder.pause();
        const recorderPausedState = recorder.state;
        recorder.resume();
        recorder.requestData();
        recorder.stop();
        const emptyStream = new webkitMediaStream();
        return [
          Object.prototype.toString.call(stream),
          stream instanceof MediaStream,
          webkitMediaStream === MediaStream,
          stream.id.startsWith('zp-media-stream-'),
          stream.getTracks().length,
          stream.getAudioTracks()[0] === audioTrack,
          stream.getVideoTracks()[0] === videoTrack,
          stream.getTrackById('video-1') === videoTrack,
          stream.active,
          audioTrack.enabled,
          audioTrack.readyState,
          clonedStream instanceof MediaStream,
          clonedStream.getTracks().length,
          emptyStream.getTracks().length,
          (() => { try { new MediaStream([{}]); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.toString.call(audioTrack),
          audioTrack instanceof MediaStreamTrack,
          audioTrack.kind,
          audioTrack.id,
          audioTrack.label,
          Object.keys(audioTrack.getCapabilities()).length,
          (() => { try { new MediaStreamTrack(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.toString.call(canvasTrack),
          canvasTrack instanceof MediaStreamTrack,
          canvasTrack.canvas,
          typeof canvasTrack.requestFrame,
          (() => { try { new CanvasCaptureMediaStreamTrack(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.toString.call(browserTrack),
          browserTrack instanceof MediaStreamTrack,
          typeof browserTrack.cropTo,
          typeof browserTrack.restrictTo,
          (() => { try { new BrowserCaptureMediaStreamTrack(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.toString.call(audioSink),
          audioSink.type,
          Object.getOwnPropertyNames(AudioSinkInfo.prototype),
          Object.getOwnPropertySymbols(AudioSinkInfo.prototype).map(String),
          [
            Object.getOwnPropertyDescriptor(globalThis, 'AudioSinkInfo').enumerable,
            Object.getOwnPropertyDescriptor(globalThis, 'AudioSinkInfo').configurable,
            Object.getOwnPropertyDescriptor(globalThis, 'AudioSinkInfo').writable,
          ],
          Object.prototype.hasOwnProperty.call(AudioSinkInfo, Symbol.hasInstance),
          (() => { try { AudioSinkInfo(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new AudioSinkInfo(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.toString.call(audioStats),
          audioStats.deliveredFrames,
          audioStats.toJSON().averageLatency,
          typeof audioStats.resetLatency,
          Object.getOwnPropertyNames(MediaStreamTrackAudioStats.prototype),
          Object.prototype.hasOwnProperty.call(MediaStreamTrackAudioStats, Symbol.hasInstance),
          (() => { try { MediaStreamTrackAudioStats(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new MediaStreamTrackAudioStats(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.toString.call(videoStats),
          videoStats.discardedFrames,
          videoStats.toJSON().totalFrames,
          Object.getOwnPropertyNames(MediaStreamTrackVideoStats.prototype),
          Object.prototype.hasOwnProperty.call(MediaStreamTrackVideoStats, Symbol.hasInstance),
          (() => { try { MediaStreamTrackVideoStats(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new MediaStreamTrackVideoStats(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.toString.call(recorder),
          recorder instanceof MediaRecorder,
          recorder.stream === stream,
          recorder.mimeType,
          recorder.videoBitsPerSecond,
          recorder.audioBitsPerSecond,
          recorder.audioBitrateMode,
          MediaRecorder.isTypeSupported('video/webm'),
          MediaRecorder.isTypeSupported('not/a type'),
          recorderRecordingState,
          recorderPausedState,
          recorder.state,
          recorderStartError,
          (() => { try { new MediaRecorder(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new MediaRecorder({}); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { recorder.stop(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      queuingStrategies: (() => {
        const byteLength = new ByteLengthQueuingStrategy({ highWaterMark: '4' });
        const count = new CountQueuingStrategy({ highWaterMark: 2 });
        const byteHighDescriptor = Object.getOwnPropertyDescriptor(ByteLengthQueuingStrategy.prototype, 'highWaterMark');
        const byteSizeDescriptor = Object.getOwnPropertyDescriptor(ByteLengthQueuingStrategy.prototype, 'size');
        const countHighDescriptor = Object.getOwnPropertyDescriptor(CountQueuingStrategy.prototype, 'highWaterMark');
        const countSizeDescriptor = Object.getOwnPropertyDescriptor(CountQueuingStrategy.prototype, 'size');
        return [
          Object.prototype.toString.call(byteLength),
          byteLength instanceof ByteLengthQueuingStrategy,
          byteLength.highWaterMark,
          byteLength.size({ byteLength: 9 }),
          byteLength.size === byteLength.size,
          Object.getOwnPropertyNames(byteLength),
          Object.getOwnPropertyDescriptor(globalThis, 'ByteLengthQueuingStrategy').enumerable,
          [byteHighDescriptor.enumerable, byteHighDescriptor.configurable, !!byteHighDescriptor.get, !!byteHighDescriptor.set],
          [byteSizeDescriptor.enumerable, byteSizeDescriptor.configurable, !!byteSizeDescriptor.get, !!byteSizeDescriptor.set],
          (() => { try { new ByteLengthQueuingStrategy(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new ByteLengthQueuingStrategy({}); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new ByteLengthQueuingStrategy(undefined); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.toString.call(count),
          count instanceof CountQueuingStrategy,
          count.highWaterMark,
          count.size({ byteLength: 9 }),
          count.size === count.size,
          Object.getOwnPropertyNames(count),
          Object.getOwnPropertyDescriptor(globalThis, 'CountQueuingStrategy').enumerable,
          [countHighDescriptor.enumerable, countHighDescriptor.configurable, !!countHighDescriptor.get, !!countHighDescriptor.set],
          [countSizeDescriptor.enumerable, countSizeDescriptor.configurable, !!countSizeDescriptor.get, !!countSizeDescriptor.set],
          (() => { try { new CountQueuingStrategy(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new CountQueuingStrategy({}); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new CountQueuingStrategy(null); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      compressionStreams: (() => {
        const compression = new CompressionStream('gzip');
        const decompression = new DecompressionStream('deflate-raw');
        return [
          Object.prototype.toString.call(compression),
          compression instanceof CompressionStream,
          Object.prototype.toString.call(compression.readable),
          Object.prototype.toString.call(compression.writable),
          Object.prototype.toString.call(decompression),
          decompression instanceof DecompressionStream,
          Object.prototype.toString.call(decompression.readable),
          Object.prototype.toString.call(decompression.writable),
          (() => { try { new CompressionStream(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new CompressionStream('br'); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new DecompressionStream('bad'); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      textEncoding: (() => {
        const encoder = new TextEncoder();
        const encoded = encoder.encode('hi €');
        const buffer = new Uint8Array(8);
        const into = encoder.encodeInto('é!', buffer);
        const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
        const decoded = decoder.decode(encoded);
        const encoderStream = new TextEncoderStream();
        const decoderStream = new TextDecoderStream('utf-8', { fatal: true });
        return [
          Object.prototype.toString.call(encoder),
          encoder instanceof TextEncoder,
          encoder.encoding,
          Array.from(encoded),
          into.read,
          into.written,
          Array.from(buffer.slice(0, into.written)),
          Object.prototype.toString.call(decoder),
          decoder instanceof TextDecoder,
          decoder.encoding,
          decoder.fatal,
          decoder.ignoreBOM,
          decoded,
          decoder.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])),
          Object.prototype.toString.call(encoderStream),
          encoderStream instanceof TextEncoderStream,
          encoderStream.encoding,
          Object.prototype.toString.call(encoderStream.readable),
          Object.prototype.toString.call(encoderStream.writable),
          Object.prototype.toString.call(decoderStream),
          decoderStream instanceof TextDecoderStream,
          decoderStream.encoding,
          decoderStream.fatal,
          decoderStream.ignoreBOM,
          Object.prototype.toString.call(decoderStream.readable),
          (() => { try { new TextDecoder('bad-encoding'); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { encoder.encodeInto('x', {}); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      highlightApi: (() => {
        const range = new Range();
        const otherRange = new StaticRange({ startContainer: document, startOffset: 0, endContainer: document, endOffset: 0 });
        const duplicate = new Highlight(range, range);
        const highlight = new Highlight();
        const addReturn = highlight.add(range);
        highlight.add(otherRange);
        highlight.priority = '-1.5';
        highlight.type = 'spelling-error';
        highlight.type = 'unknown';
        const registry = CSS.highlights;
        const setReturn = registry.set('zp', highlight);
        const forEachValues = [];
        registry.forEach(function collect(value, key, owner) { forEachValues.push([value === highlight, key, owner === registry, this.marker]); }, { marker: 'ctx' });
        const entries = [...highlight.entries()];
        const pointHighlights = registry.highlightsFromPoint(0, 0);
        const registrySize = registry.size;
        const registryHas = registry.has('zp');
        const registryGet = registry.get('zp') === highlight;
        const registryValue = [...registry.values()][0] === highlight;
        const deleteReturn = registry.delete('zp');
        return [
          typeof Highlight,
          Object.prototype.toString.call(highlight),
          highlight instanceof Highlight,
          addReturn === highlight,
          highlight.size,
          entries[0][0] === range,
          entries[0][1] === range,
          [...highlight.keys()][1] === otherRange,
          [...highlight.values()][0] === range,
          duplicate.size,
          highlight.priority,
          highlight.type,
          (() => { try { highlight.add({}); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          typeof HighlightRegistry,
          Object.prototype.toString.call(registry),
          registry instanceof HighlightRegistry,
          CSS.highlights === registry,
          setReturn === registry,
          registrySize,
          registryHas,
          registryGet,
          registryValue,
          forEachValues,
          Array.isArray(pointHighlights),
          pointHighlights.length,
          deleteReturn,
          registry.size,
          (() => { try { new HighlightRegistry(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { registry.set('bad', {}); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { registry.highlightsFromPoint(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { registry.highlightsFromPoint(Infinity, 0); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      longTailEventConstructors: (() => {
        const track = { id: 'virtual-track' };
        const trackEvent = new TrackEvent('track', { track: null });
        const eventMediaTrack = Object.create(MediaStreamTrack.prototype);
        const mediaStreamTrackEvent = new MediaStreamTrackEvent('addtrack', { track: eventMediaTrack });
        const initData = new Uint8Array([1, 2, 3]).buffer;
        const encrypted = new MediaEncryptedEvent('encrypted', { initDataType: 'cenc', initData });
        const viewTransition = { id: 'view-transition' };
        const activation = { from: 'previous-entry' };
        const pageReveal = new PageRevealEvent('pagereveal', { viewTransition });
        const pageSwap = new PageSwapEvent('pageswap', { activation, viewTransition });
        const bounds = new CharacterBoundsUpdateEvent('characterboundsupdate', { rangeStart: 1, rangeEnd: 2 });
        const textFormat = new TextFormat({ rangeStart: 3, rangeEnd: 4, underlineStyle: 'solid', underlineThickness: 'thick' });
        const textFormatsEvent = new TextFormatUpdateEvent('textformatupdate', { textFormats: [textFormat] });
        const textFormats = textFormatsEvent.getTextFormats();
        const nextTextFormats = textFormatsEvent.getTextFormats();
        const textUpdate = new TextUpdateEvent('textupdate', { updateRangeStart: 5, updateRangeEnd: 6, text: 'hello', selectionStart: 7, selectionEnd: 8 });
        const eventShape = (Ctor, event, keys, protoNames) => [
          Ctor.name,
          Ctor.length,
          Object.getOwnPropertyNames(Ctor.prototype),
          keys.every((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, key);
            return descriptor.enumerable && descriptor.configurable && typeof descriptor.get === 'function' && descriptor.set === undefined;
          }),
          keys.some((key) => Object.prototype.hasOwnProperty.call(event, key)),
          protoNames,
        ];
        return [
          Object.prototype.toString.call(trackEvent),
          trackEvent instanceof TrackEvent,
          trackEvent instanceof Event,
          trackEvent.track === null,
          Object.getOwnPropertyNames(trackEvent),
          Object.getOwnPropertyNames(TrackEvent.prototype),
          Object.getOwnPropertySymbols(TrackEvent.prototype).map(String),
          Object.prototype.hasOwnProperty.call(TrackEvent, Symbol.hasInstance),
          [
            Object.getOwnPropertyDescriptor(globalThis, 'TrackEvent').enumerable,
            Object.getOwnPropertyDescriptor(globalThis, 'TrackEvent').configurable,
            Object.getOwnPropertyDescriptor(globalThis, 'TrackEvent').writable,
          ],
          (() => { try { TrackEvent('track'); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new TrackEvent(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new TrackEvent('track', { track: {} }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          mediaStreamTrackEvent.track === eventMediaTrack,
          Object.getOwnPropertyNames(mediaStreamTrackEvent),
          Object.getOwnPropertyNames(MediaStreamTrackEvent.prototype),
          Object.getOwnPropertySymbols(MediaStreamTrackEvent.prototype).map(String),
          Object.prototype.hasOwnProperty.call(MediaStreamTrackEvent, Symbol.hasInstance),
          [
            Object.getOwnPropertyDescriptor(globalThis, 'MediaStreamTrackEvent').enumerable,
            Object.getOwnPropertyDescriptor(globalThis, 'MediaStreamTrackEvent').configurable,
            Object.getOwnPropertyDescriptor(globalThis, 'MediaStreamTrackEvent').writable,
          ],
          (() => { try { MediaStreamTrackEvent('addtrack', { track: eventMediaTrack }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new MediaStreamTrackEvent(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new MediaStreamTrackEvent('addtrack'); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new MediaStreamTrackEvent('addtrack', { track: null }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          encrypted.initDataType,
          encrypted.initData === initData,
          pageReveal.viewTransition === viewTransition,
          pageSwap.viewTransition === viewTransition,
          pageSwap.activation === activation,
          (() => { try { new TextEvent('textInput'); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.toString.call(Object.create(TextEvent.prototype)),
          Object.getPrototypeOf(TextEvent.prototype) === UIEvent.prototype,
          typeof TextEvent.prototype.initTextEvent,
          (() => { const event = document.createEvent('TextEvent'); event.initTextEvent('textInput', true, true, window, 'abc'); return [Object.prototype.toString.call(event), event instanceof TextEvent, event instanceof UIEvent, event.data, event.type, event.bubbles, event.view === window]; })(),
          (() => { try { TextEvent(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.getOwnPropertyNames(TextEvent.prototype),
          [
            Object.getOwnPropertyDescriptor(TextEvent.prototype, 'data').enumerable,
            Object.getOwnPropertyDescriptor(TextEvent.prototype, 'data').configurable,
            typeof Object.getOwnPropertyDescriptor(TextEvent.prototype, 'data').get,
            Object.getOwnPropertyDescriptor(TextEvent.prototype, 'data').set,
          ],
          [
            Object.getOwnPropertyDescriptor(TextEvent.prototype, 'initTextEvent').enumerable,
            Object.getOwnPropertyDescriptor(TextEvent.prototype, 'initTextEvent').configurable,
            Object.getOwnPropertyDescriptor(TextEvent.prototype, 'initTextEvent').writable,
            Object.getOwnPropertyDescriptor(TextEvent.prototype, 'initTextEvent').value.length,
          ],
          [
            Object.getOwnPropertyDescriptor(globalThis, 'TextEvent').enumerable,
            Object.getOwnPropertyDescriptor(globalThis, 'TextEvent').configurable,
            Object.getOwnPropertyDescriptor(globalThis, 'TextEvent').writable,
          ],
          Object.getOwnPropertyDescriptor(TextEvent, 'prototype').writable,
          Object.prototype.hasOwnProperty.call(TextEvent, Symbol.hasInstance),
          (() => { const event = document.createEvent('TextEvent'); event.initTextEvent('textInput', true, true, window, 'abc'); return Object.getOwnPropertyNames(event); })(),
          (() => { const event = document.createEvent('TextEvent'); try { event.initTextEvent(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { const event = document.createEvent('TextEvent'); try { event.initTextEvent(Symbol('textInput')); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { const event = document.createEvent('TextEvent'); event.initTextEvent('textInput'); return [event.data, event.bubbles, event.cancelable, event.view]; })(),
          bounds.rangeStart,
          bounds.rangeEnd,
          Object.prototype.toString.call(textFormat),
          textFormat.rangeStart,
          textFormat.rangeEnd,
          textFormat.underlineStyle,
          textFormat.underlineThickness,
          textFormats.length,
          textFormats[0] === textFormat,
          textFormats !== nextTextFormats,
          textUpdate.updateRangeStart,
          textUpdate.updateRangeEnd,
          textUpdate.text,
          textUpdate.selectionStart,
          textUpdate.selectionEnd,
          eventShape(MediaEncryptedEvent, encrypted, ['initDataType', 'initData'], ['initDataType', 'initData', 'constructor']),
          eventShape(PageRevealEvent, pageReveal, ['viewTransition'], ['viewTransition', 'constructor']),
          eventShape(PageSwapEvent, pageSwap, ['viewTransition', 'activation'], ['viewTransition', 'activation', 'constructor']),
          eventShape(CharacterBoundsUpdateEvent, bounds, ['rangeStart', 'rangeEnd'], ['rangeStart', 'rangeEnd', 'constructor']),
          eventShape(TextFormat, textFormat, ['rangeStart', 'rangeEnd', 'underlineStyle', 'underlineThickness'], ['rangeStart', 'rangeEnd', 'underlineStyle', 'underlineThickness', 'constructor']),
          eventShape(TextFormatUpdateEvent, textFormatsEvent, [], ['getTextFormats', 'constructor']),
          eventShape(TextUpdateEvent, textUpdate, ['updateRangeStart', 'updateRangeEnd', 'text', 'selectionStart', 'selectionEnd'], ['updateRangeStart', 'updateRangeEnd', 'text', 'selectionStart', 'selectionEnd', 'constructor']),
        ];
      })(),
      rtcEventConstructors: (() => {
        const stream = { id: 'stream' };
        const candidate = { candidate: 'candidate:1' };
        const receiver = { id: 'receiver' };
        const track = { id: 'track' };
        const transceiver = { id: 'transceiver' };
        const mediaStreamEvent = new MediaStreamEvent('addstream', { stream });
        const iceEvent = new RTCPeerConnectionIceEvent('icecandidate', { candidate });
        const iceErrorEvent = new RTCPeerConnectionIceErrorEvent('icecandidateerror', { address: '192.0.2.1', port: 3478, hostCandidate: 'host', url: 'stun:example.test', errorCode: 701, errorText: 'blocked' });
        const rtcTrackEvent = new RTCTrackEvent('track', { receiver, track, streams: [stream], transceiver });
        const rtcIceCandidate = new RTCIceCandidate({ candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 1, usernameFragment: 'uf' });
        const sessionDescription = new RTCSessionDescription({ type: 'offer', sdp: 'v=0' });
        const rtcError = new RTCError({ errorDetail: 'data-channel-failure', sctpCauseCode: 12 }, 'failed');
        const rtcErrorEvent = new RTCErrorEvent('error', { error: rtcError });
        const dataChannel = new RTCPeerConnection().createDataChannel('virtual-data-channel');
        const dataChannelEvent = new RTCDataChannelEvent('datachannel', { channel: dataChannel });
        const toneChangeEvent = new RTCDTMFToneChangeEvent('tonechange', { tone: '1' });
        const eventShape = (Ctor, event, keys, protoNames) => [
          Ctor.name,
          Ctor.length,
          Object.getOwnPropertyNames(Ctor.prototype),
          keys.every((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, key);
            return descriptor.enumerable && descriptor.configurable && typeof descriptor.get === 'function' && descriptor.set === undefined;
          }),
          keys.some((key) => Object.prototype.hasOwnProperty.call(event, key)),
          protoNames,
        ];
        return [
          Object.prototype.toString.call(mediaStreamEvent),
          mediaStreamEvent instanceof MediaStreamEvent,
          mediaStreamEvent.stream === stream,
          new MediaStreamEvent('addstream').stream === null,
          Object.prototype.toString.call(iceEvent),
          iceEvent instanceof RTCPeerConnectionIceEvent,
          iceEvent.candidate === candidate,
          new RTCPeerConnectionIceEvent('icecandidate').candidate === null,
          Object.prototype.toString.call(iceErrorEvent),
          iceErrorEvent.address,
          iceErrorEvent.port,
          iceErrorEvent.hostCandidate,
          iceErrorEvent.url,
          iceErrorEvent.errorCode,
          iceErrorEvent.errorText,
          Object.prototype.toString.call(rtcTrackEvent),
          rtcTrackEvent.receiver === receiver,
          rtcTrackEvent.track === track,
          rtcTrackEvent.streams.length,
          rtcTrackEvent.streams[0] === stream,
          rtcTrackEvent.transceiver === transceiver,
          Object.prototype.toString.call(rtcIceCandidate),
          rtcIceCandidate instanceof RTCIceCandidate,
          rtcIceCandidate.candidate,
          rtcIceCandidate.toJSON().usernameFragment,
          (() => { try { new RTCIceCandidate(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.toString.call(sessionDescription),
          sessionDescription.type,
          sessionDescription.sdp,
          sessionDescription.toJSON().type,
          (() => { try { new RTCSessionDescription({ type: 'bad', sdp: 'x' }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.toString.call(rtcError),
          rtcError instanceof RTCError,
          rtcError instanceof DOMException,
          rtcError.name,
          rtcError.message,
          rtcError.errorDetail,
          rtcError.sctpCauseCode,
          (() => { try { new RTCError({}); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.toString.call(rtcErrorEvent),
          rtcErrorEvent.error === rtcError,
          Object.getOwnPropertyNames(rtcErrorEvent),
          Object.getOwnPropertyNames(RTCErrorEvent.prototype),
          Object.getOwnPropertySymbols(RTCErrorEvent.prototype).map(String),
          Object.prototype.hasOwnProperty.call(RTCErrorEvent, Symbol.hasInstance),
          [
            Object.getOwnPropertyDescriptor(globalThis, 'RTCErrorEvent').enumerable,
            Object.getOwnPropertyDescriptor(globalThis, 'RTCErrorEvent').configurable,
            Object.getOwnPropertyDescriptor(globalThis, 'RTCErrorEvent').writable,
          ],
          (() => { try { RTCErrorEvent('error', { error: rtcError }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new RTCErrorEvent(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new RTCErrorEvent('error', {}); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.toString.call(dataChannelEvent),
          dataChannelEvent.channel === dataChannel,
          Object.getOwnPropertyNames(dataChannelEvent),
          Object.getOwnPropertyNames(RTCDataChannelEvent.prototype),
          Object.getOwnPropertySymbols(RTCDataChannelEvent.prototype).map(String),
          Object.prototype.hasOwnProperty.call(RTCDataChannelEvent, Symbol.hasInstance),
          [
            Object.getOwnPropertyDescriptor(globalThis, 'RTCDataChannelEvent').enumerable,
            Object.getOwnPropertyDescriptor(globalThis, 'RTCDataChannelEvent').configurable,
            Object.getOwnPropertyDescriptor(globalThis, 'RTCDataChannelEvent').writable,
          ],
          (() => { try { RTCDataChannelEvent('datachannel', { channel: dataChannel }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new RTCDataChannelEvent(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new RTCDataChannelEvent('datachannel', {}); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.toString.call(toneChangeEvent),
          toneChangeEvent.tone,
          eventShape(MediaStreamEvent, mediaStreamEvent, ['stream'], ['stream', 'constructor']),
          eventShape(RTCPeerConnectionIceEvent, iceEvent, ['candidate'], ['candidate', 'constructor']),
          eventShape(RTCPeerConnectionIceErrorEvent, iceErrorEvent, ['address', 'port', 'hostCandidate', 'url', 'errorCode', 'errorText'], ['address', 'port', 'hostCandidate', 'url', 'errorCode', 'errorText', 'constructor']),
          eventShape(RTCDTMFToneChangeEvent, toneChangeEvent, ['tone'], ['tone', 'constructor']),
        ];
      })(),
      captureMetadata: (() => {
        const chapter = Object.create(ChapterInformation.prototype);
        const chapterGlobal = Object.getOwnPropertyDescriptor(globalThis, 'ChapterInformation');
        const chapterTitleDescriptor = Object.getOwnPropertyDescriptor(ChapterInformation.prototype, 'title');
        const chapterArtworkDescriptor = Object.getOwnPropertyDescriptor(ChapterInformation.prototype, 'artwork');
        const captureChapter = (callback) => {
          try {
            return ['ok', callback()];
          } catch (error) {
            return [error.name, error.message];
          }
        };
        const presenter = Object.create(DelegatedInkTrailPresenter.prototype);
        return [
          typeof ChapterInformation,
          Object.prototype.toString.call(chapter),
          chapter instanceof ChapterInformation,
          Object.getOwnPropertyNames(ChapterInformation.prototype),
          [chapterGlobal.enumerable, chapterGlobal.configurable, chapterGlobal.writable],
          Object.getOwnPropertyDescriptor(ChapterInformation, 'prototype').writable,
          Object.prototype.hasOwnProperty.call(ChapterInformation, Symbol.hasInstance),
          [chapterTitleDescriptor.enumerable, chapterTitleDescriptor.configurable, typeof chapterTitleDescriptor.get, chapterTitleDescriptor.set],
          [chapterArtworkDescriptor.enumerable, chapterArtworkDescriptor.configurable, typeof chapterArtworkDescriptor.get, chapterArtworkDescriptor.set],
          captureChapter(() => chapter.title),
          captureChapter(() => chapter.startTime),
          captureChapter(() => chapter.artwork),
          captureChapter(() => ChapterInformation()),
          captureChapter(() => new ChapterInformation()),
          typeof CropTarget,
          Object.prototype.toString.call(Object.create(CropTarget.prototype)),
          typeof CropTarget.fromElement,
          (() => { try { new CropTarget(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          typeof RestrictionTarget,
          Object.prototype.toString.call(Object.create(RestrictionTarget.prototype)),
          typeof RestrictionTarget.fromElement,
          (() => { try { new RestrictionTarget(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.toString.call(presenter),
          presenter.presentationArea,
          presenter.updateInkTrailStartPoint({ x: 1, y: 2 }),
          (() => { try { new DelegatedInkTrailPresenter(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      trustedTypes: (() => {
        const policy = trustedTypes.createPolicy('zp-main', {
          createHTML: (value) => 'html:' + value,
          createScript: (value) => 'script:' + value,
          createScriptURL: (value) => 'url:' + value,
        });
        const html = policy.createHTML('x');
        const script = policy.createScript('x');
        const scriptURL = policy.createScriptURL('/x.js');
        const htmlOnly = trustedTypes.createPolicy('zp-html-only', { createHTML: (value) => value });
        return [
          typeof TrustedHTML,
          typeof TrustedScript,
          typeof TrustedScriptURL,
          typeof TrustedTypePolicy,
          typeof TrustedTypePolicyFactory,
          Object.prototype.toString.call(trustedTypes),
          trustedTypes instanceof TrustedTypePolicyFactory,
          Object.isFrozen(trustedTypes),
          Object.getOwnPropertyNames(trustedTypes),
          Object.getOwnPropertyNames(TrustedTypePolicyFactory.prototype),
          Object.getOwnPropertyNames(TrustedTypePolicy.prototype),
          Object.getOwnPropertyNames(TrustedHTML.prototype),
          Object.getOwnPropertyDescriptor(globalThis, 'TrustedHTML').enumerable,
          Object.getOwnPropertyDescriptor(globalThis, 'TrustedTypePolicyFactory').enumerable,
          Object.getOwnPropertyDescriptor(globalThis, 'trustedTypes').enumerable,
          Object.prototype.hasOwnProperty.call(TrustedHTML, Symbol.hasInstance),
          Object.prototype.hasOwnProperty.call(TrustedTypePolicy, Symbol.hasInstance),
          Object.prototype.hasOwnProperty.call(TrustedTypePolicyFactory, Symbol.hasInstance),
          String(trustedTypes.emptyHTML),
          trustedTypes.emptyHTML.toJSON(),
          trustedTypes.isHTML(trustedTypes.emptyHTML),
          String(trustedTypes.emptyScript),
          trustedTypes.isScript(trustedTypes.emptyScript),
          trustedTypes.defaultPolicy,
          Object.prototype.toString.call(policy),
          policy instanceof TrustedTypePolicy,
          Object.getOwnPropertyNames(policy),
          policy.name,
          Object.prototype.toString.call(html),
          html instanceof TrustedHTML,
          Object.getOwnPropertyNames(html),
          String(html),
          html.toJSON(),
          trustedTypes.isHTML(html),
          Object.prototype.toString.call(script),
          script instanceof TrustedScript,
          String(script),
          trustedTypes.isScript(script),
          Object.prototype.toString.call(scriptURL),
          scriptURL instanceof TrustedScriptURL,
          String(scriptURL),
          trustedTypes.isScriptURL(scriptURL),
          trustedTypes.getAttributeType('script', 'src'),
          trustedTypes.getPropertyType('HTMLScriptElement', 'src'),
          trustedTypes.getTypeMapping('HTMLScriptElement', 'script'),
          (() => { try { trustedTypes.createPolicy(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { htmlOnly.createScript('x'); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new TrustedHTML(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new TrustedTypePolicyFactory(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { TrustedHTML(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { TrustedTypePolicyFactory(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      fontLoading: (() => {
        const face = new FontFace('Virtual', 'url(/font.woff2)', {
          style: 'italic',
          weight: '700',
          display: 'swap',
        });
        const fonts = document.fonts;
        const addResult = fonts.add(face);
        const faceLoad = face.load();
        const setLoad = fonts.load('12px Virtual', 'sample');
        const entries = Array.from(fonts.entries());
        return [
          typeof FontFace,
          typeof FontFaceSet,
          Object.prototype.toString.call(face),
          face instanceof FontFace,
          face.family,
          face.style,
          face.weight,
          face.display,
          face.status,
          Object.prototype.toString.call(face.loaded),
          Object.prototype.toString.call(faceLoad),
          Object.prototype.toString.call(fonts),
          fonts instanceof FontFaceSet,
          fonts instanceof EventTarget,
          addResult === fonts,
          fonts.size,
          fonts.has(face),
          fonts.status,
          fonts.check('12px Virtual', 'sample'),
          Object.prototype.toString.call(fonts.ready),
          Object.prototype.toString.call(setLoad),
          entries.length,
          entries[0][0] === face,
          entries[0][1] === face,
          Array.from(fonts).length,
          (() => { try { fonts.add({}); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new FontFace('x'); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new FontFaceSet(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      pictureInPicture: (() => {
        const video = document.createElement('video');
        const audio = document.createElement('audio');
        video.disablePictureInPicture = true;
        const event = new PictureInPictureEvent('enterpictureinpicture', { pictureInPictureWindow: null });
        const documentEvent = new DocumentPictureInPictureEvent('enter', { window });
        const quality = video.getVideoPlaybackQuality();
        return [
          typeof HTMLMediaElement,
          video instanceof HTMLVideoElement,
          video instanceof HTMLMediaElement,
          audio instanceof HTMLMediaElement,
          Object.prototype.toString.call(video.remote),
          video.remote instanceof RemotePlayback,
          video.remote === video.remote,
          video.disablePictureInPicture,
          video.getAttribute('disablepictureinpicture'),
          document.pictureInPictureEnabled,
          document.pictureInPictureElement,
          typeof document.exitPictureInPicture,
          typeof video.requestPictureInPicture,
          typeof video.getVideoPlaybackQuality,
          Object.prototype.toString.call(quality),
          quality instanceof VideoPlaybackQuality,
          typeof quality.creationTime,
          quality.totalVideoFrames,
          quality.droppedVideoFrames,
          quality.corruptedVideoFrames,
          (() => { try { audio.getVideoPlaybackQuality(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          Object.prototype.toString.call(event),
          event instanceof PictureInPictureEvent,
          event instanceof Event,
          event.pictureInPictureWindow,
          Object.prototype.toString.call(documentEvent),
          documentEvent instanceof DocumentPictureInPictureEvent,
          documentEvent.window === window,
          Object.getOwnPropertyNames(documentEvent),
          Object.getOwnPropertyNames(DocumentPictureInPictureEvent.prototype),
          Object.getOwnPropertySymbols(DocumentPictureInPictureEvent.prototype).map(String),
          Object.prototype.hasOwnProperty.call(DocumentPictureInPictureEvent, Symbol.hasInstance),
          [
            Object.getOwnPropertyDescriptor(globalThis, 'DocumentPictureInPictureEvent').enumerable,
            Object.getOwnPropertyDescriptor(globalThis, 'DocumentPictureInPictureEvent').configurable,
            Object.getOwnPropertyDescriptor(globalThis, 'DocumentPictureInPictureEvent').writable,
          ],
          (() => { try { DocumentPictureInPictureEvent('enter', { window }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new DocumentPictureInPictureEvent(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new DocumentPictureInPictureEvent('enter', {}); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new RemotePlayback(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new PictureInPictureWindow(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ];
      })(),
      uaData: [
        Object.prototype.toString.call(navigator.userAgentData),
        navigator.userAgentData instanceof NavigatorUAData,
        navigator.userAgentData.brands[0].brand,
        navigator.userAgentData.mobile,
        navigator.userAgentData.platform,
        JSON.stringify(navigator.userAgentData),
        Object.getOwnPropertyNames(navigator.userAgentData).sort(),
        navigator.userAgentData.brands === navigator.userAgentData.brands,
        Object.isFrozen(navigator.userAgentData.brands),
        Object.isFrozen(navigator.userAgentData.brands[0]),
        [
          Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'brands').enumerable,
          Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'brands').configurable,
          typeof Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'brands').get,
          Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'brands').set,
        ],
        [
          Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'getHighEntropyValues').enumerable,
          Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'getHighEntropyValues').configurable,
          Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'getHighEntropyValues').writable,
          typeof Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'getHighEntropyValues').value,
          Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'getHighEntropyValues').value.length,
        ],
        (() => { try { new NavigatorUAData(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ],
      brands: [
        Object.prototype.toString.call(new Blob(['x'])),
        Object.prototype.toString.call(new File(['x'], 'x.txt')),
        Object.prototype.toString.call(new FileReader()),
        Object.prototype.toString.call(new FormData()),
        Object.prototype.toString.call(document.createElement('input').validity),
        Object.prototype.toString.call(new StorageEvent('storage')),
        Object.prototype.toString.call(document.createRange()),
        Object.prototype.toString.call(new StaticRange({ startContainer: document.body, startOffset: 0, endContainer: document.body, endOffset: 0 })),
        Object.prototype.toString.call(getSelection()),
        Object.prototype.toString.call(document.createTreeWalker(document.body)),
        Object.prototype.toString.call(document.createNodeIterator(document.body)),
        Object.prototype.toString.call(caches),
        Object.prototype.toString.call(IDBKeyRange.only('x')),
      ],
      eventConstructors: [
        Object.prototype.toString.call(new Event('zp')),
        (() => { const plain = new Event('plain'); plain.preventDefault(); const cancelable = new Event('cancelable', { bubbles: true, cancelable: true }); cancelable.preventDefault(); let missing = ''; try { new Event(); } catch (error) { missing = error.name; } return [plain.bubbles, plain.cancelable, plain.defaultPrevented, cancelable.bubbles, cancelable.cancelable, cancelable.defaultPrevented, Object.prototype.hasOwnProperty.call(plain, 'type'), Object.getOwnPropertyNames(plain), Object.getOwnPropertyNames(Event.prototype), missing]; })(),
        (() => { const button = document.createElement('button'); document.body.appendChild(button); const event = new Event('path', { bubbles: true, cancelable: true, composed: true }); let seen = null; button.addEventListener('path', (ev) => { ev.returnValue = false; seen = [ev.composed, typeof ev.timeStamp, Event.CAPTURING_PHASE, ev.AT_TARGET, ev.composedPath()[0] === button, ev.returnValue, ev.defaultPrevented]; }); const dispatched = button.dispatchEvent(event); return [...seen, dispatched]; })(),
        (() => { const event = document.createEvent('Event'); event.initEvent('legacy', true, true); const ui = document.createEvent('UIEvents'); ui.initUIEvent('load', true, false, window, 7); const mouse = document.createEvent('MouseEvents'); mouse.initMouseEvent('click', true, true, window, 1, 2, 3, 4, 5, true, false, true, false, 2, document.body); let bad = ''; try { document.createEvent('BogusEvent'); } catch (error) { bad = error.name; } return [event.type, event.bubbles, event.cancelable, event.defaultPrevented, ui.detail, ui.view === window, mouse instanceof MouseEvent, mouse.type, mouse.clientX, mouse.getModifierState('Control'), mouse.getModifierState('Shift'), mouse.getModifierState('Alt'), mouse.button, mouse.relatedTarget === document.body, bad]; })(),
        [Object.prototype.toString.call(new CustomEvent('zp', { detail: 0 })), new CustomEvent('zp', { detail: 0 }).detail],
        (() => { const button = document.createElement('button'); const event = new SubmitEvent('submit', { submitter: button }); return [Object.prototype.toString.call(event), event instanceof SubmitEvent, event instanceof Event, event.submitter === button]; })(),
        (() => { const formData = new FormData(); const event = new FormDataEvent('formdata', { formData }); return [Object.prototype.toString.call(event), event instanceof FormDataEvent, event instanceof Event, event.formData === formData]; })(),
        (() => { const rect = navigator.windowControlsOverlay.getTitlebarAreaRect(); const event = new WindowControlsOverlayGeometryChangeEvent('geometrychange', { visible: true, titlebarAreaRect: rect }); return [Object.prototype.toString.call(event), event instanceof WindowControlsOverlayGeometryChangeEvent, event instanceof Event, event.visible, event.titlebarAreaRect]; })(),
        (() => { const event = new VirtualKeyboardGeometryChangeEvent('geometrychange', { bubbles: true, cancelable: true, composed: true, boundingRect: new DOMRectReadOnly(1, 2, 3, 4) }); return [Object.prototype.toString.call(event), event instanceof VirtualKeyboardGeometryChangeEvent, event instanceof Event, event.bubbles, event.cancelable, event.composed, 'boundingRect' in event, typeof event.boundingRect]; })(),
        (() => { const event = new MouseEvent('click', { clientX: 12, buttons: 1, ctrlKey: true }); return [Object.prototype.toString.call(event), event instanceof MouseEvent, event instanceof Event, event.clientX, event.buttons, event.ctrlKey, event.getModifierState('Control'), event.getModifierState('Alt')]; })(),
        (() => { const event = new PointerEvent('pointerdown', { pointerId: 9, clientX: 12, width: 3, height: 4, pressure: 0.5, pointerType: 'pen', isPrimary: true }); return [Object.prototype.toString.call(event), event instanceof PointerEvent, event instanceof MouseEvent, event.clientX, event.pointerId, event.width, event.height, event.pressure, event.pointerType, event.isPrimary, 'getCoalescedEvents' in event, event.getPredictedEvents().length]; })(),
        (() => { const button = document.createElement('button'); const events = []; button.addEventListener('gotpointercapture', (event) => events.push([event.type, event.pointerId, button.hasPointerCapture(event.pointerId)])); button.addEventListener('lostpointercapture', (event) => events.push([event.type, event.pointerId, button.hasPointerCapture(event.pointerId)])); button.setPointerCapture(12); const captured = button.hasPointerCapture(12); button.releasePointerCapture(12); return [captured, button.hasPointerCapture(12), events]; })(),
        (() => { const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true, ctrlKey: true, location: KeyboardEvent.DOM_KEY_LOCATION_RIGHT }); return [Object.prototype.toString.call(event), event.key, event.code, event.repeat, event.location, event.getModifierState('Control'), event.getModifierState('Shift'), event.DOM_KEY_LOCATION_NUMPAD]; })(),
        (() => { const targetRange = new StaticRange({ startContainer: document.body, startOffset: 0, endContainer: document.body, endOffset: 0 }); const event = new InputEvent('input', { data: 'x', inputType: 'insertText', isComposing: true, targetRanges: [targetRange] }); const ranges = event.getTargetRanges(); ranges.pop(); return [Object.prototype.toString.call(event), event.data, event.inputType, event.isComposing, event.getTargetRanges()[0] === targetRange, event.getTargetRanges()[0] instanceof StaticRange, event.getTargetRanges().length, new InputEvent('input').getTargetRanges().length]; })(),
        (() => { const event = new CompositionEvent('compositionupdate', { data: '한' }); event.initCompositionEvent('compositionend', true, false, window, 'legacy'); return [Object.prototype.toString.call(event), event instanceof CompositionEvent, event instanceof UIEvent, event.data, event.type, event.bubbles]; })(),
        (() => { const related = document.body; const event = new FocusEvent('focusin', { relatedTarget: related, detail: 5 }); return [Object.prototype.toString.call(event), event instanceof FocusEvent, event instanceof UIEvent, event.type, event.bubbles, event.detail, event.relatedTarget === related]; })(),
        (() => { const dataTransfer = new DataTransfer(); const event = new ClipboardEvent('paste', { clipboardData: dataTransfer }); return [Object.prototype.toString.call(event), event instanceof ClipboardEvent, event instanceof Event, event.clipboardData === dataTransfer]; })(),
        (() => { const dataTransfer = new DataTransfer(); const event = new DragEvent('drop', { dataTransfer }); return [Object.prototype.toString.call(event), event.dataTransfer === dataTransfer]; })(),
        (() => { const target = document.body; const touch = new Touch({ identifier: 7, target, clientX: 11, clientY: 12, pageX: 21, pageY: 22, radiusX: 3, radiusY: 4, force: 0.8 }); const event = new TouchEvent('touchstart', { touches: [touch], targetTouches: [touch], changedTouches: [touch], ctrlKey: true }); let illegal = ''; try { new TouchList(); } catch (error) { illegal = error.name; } return [Object.prototype.toString.call(touch), touch instanceof Touch, touch.target === target, touch.identifier, touch.clientX, touch.pageX, touch.radiusX, touch.force, Object.prototype.toString.call(event.touches), event.touches instanceof TouchList, event.touches.length, event.touches.item(0) === touch, [...event.touches][0] === touch, event.touches.item(2), Object.prototype.toString.call(event), event instanceof TouchEvent, event instanceof UIEvent, event.ctrlKey, event.changedTouches.item(0) === touch, 'getModifierState' in event, event.altKey, illegal]; })(),
        (() => { const event = new WheelEvent('wheel', { deltaX: 1, deltaY: -2, deltaMode: WheelEvent.DOM_DELTA_LINE }); return [Object.prototype.toString.call(event), event instanceof WheelEvent, event instanceof MouseEvent, event.deltaX, event.deltaY, event.deltaMode, event.DOM_DELTA_PIXEL, WheelEvent.DOM_DELTA_PAGE]; })(),
        (() => { const event = new AnimationEvent('animationend', { animationName: 'fade', elapsedTime: 1.25, pseudoElement: '::before' }); return [Object.prototype.toString.call(event), event.animationName, event.elapsedTime, event.pseudoElement]; })(),
        (() => { const event = new TransitionEvent('transitionend', { propertyName: 'opacity', elapsedTime: 0.75, pseudoElement: '::after' }); return [Object.prototype.toString.call(event), event.propertyName, event.elapsedTime, event.pseudoElement]; })(),
        (() => { const event = new DeviceMotionEvent('devicemotion', { acceleration: { x: 1, y: 2, z: 3 }, accelerationIncludingGravity: { x: 4, y: 5, z: 6 }, rotationRate: { alpha: 7, beta: 8, gamma: 9 }, interval: 16, bubbles: true, cancelable: true, composed: true }); const empty = new DeviceMotionEvent('devicemotion'); const descriptor = Object.getOwnPropertyDescriptor(DeviceMotionEvent.prototype, 'acceleration'); const capture = (callback) => { try { return ['ok', callback()]; } catch (error) { return [error.name, error.message]; } }; return [Object.prototype.toString.call(event), event instanceof DeviceMotionEvent, event instanceof Event, event.acceleration.x, event.accelerationIncludingGravity.z, event.rotationRate.alpha, event.interval, event.bubbles, event.cancelable, event.composed, Object.prototype.toString.call(event.acceleration), Object.getOwnPropertyNames(event.acceleration), Object.prototype.toString.call(event.rotationRate), Object.getOwnPropertyNames(event.rotationRate), Object.getOwnPropertyNames(event), Object.getOwnPropertyNames(DeviceMotionEvent.prototype), [descriptor.enumerable, descriptor.configurable, typeof descriptor.get, descriptor.set], Object.getOwnPropertyDescriptor(DeviceMotionEvent, 'prototype').writable, Object.prototype.hasOwnProperty.call(DeviceMotionEvent, Symbol.hasInstance), [empty.acceleration, empty.accelerationIncludingGravity, empty.rotationRate, empty.interval], typeof DeviceMotionEvent.requestPermission, capture(() => DeviceMotionEvent('devicemotion')), capture(() => new DeviceMotionEvent()), capture(() => new DeviceMotionEvent(Symbol('x'))), capture(() => new DeviceMotionEvent('devicemotion', { acceleration: { x: Number.POSITIVE_INFINITY } })), capture(() => Object.create(DeviceMotionEvent.prototype).acceleration)]; })(),
        (() => { const event = new DeviceOrientationEvent('deviceorientation', { alpha: 1, beta: 2, gamma: 3, absolute: true, bubbles: true, cancelable: true, composed: true }); const empty = new DeviceOrientationEvent('deviceorientation'); const descriptor = Object.getOwnPropertyDescriptor(DeviceOrientationEvent.prototype, 'alpha'); const capture = (callback) => { try { return ['ok', callback()]; } catch (error) { return [error.name, error.message]; } }; return [Object.prototype.toString.call(event), event instanceof DeviceOrientationEvent, event instanceof Event, event.alpha, event.beta, event.gamma, event.absolute, event.bubbles, event.cancelable, event.composed, Object.getOwnPropertyNames(event), Object.getOwnPropertyNames(DeviceOrientationEvent.prototype), [descriptor.enumerable, descriptor.configurable, typeof descriptor.get, descriptor.set], Object.getOwnPropertyDescriptor(DeviceOrientationEvent, 'prototype').writable, Object.prototype.hasOwnProperty.call(DeviceOrientationEvent, Symbol.hasInstance), [empty.alpha, empty.beta, empty.gamma, empty.absolute], typeof DeviceOrientationEvent.requestPermission, capture(() => DeviceOrientationEvent('deviceorientation')), capture(() => new DeviceOrientationEvent()), capture(() => new DeviceOrientationEvent(Symbol('x'))), capture(() => new DeviceOrientationEvent('deviceorientation', { alpha: Number.POSITIVE_INFINITY })), capture(() => Object.create(DeviceOrientationEvent.prototype).alpha)]; })(),
        (() => { const event = new SecurityPolicyViolationEvent('securitypolicyviolation', { documentURI: 'https://a/doc', blockedURI: 'https://b/script.js', violatedDirective: 'script-src', effectiveDirective: 'script-src-elem', originalPolicy: "script-src 'none'", disposition: 'enforce', sourceFile: 'app.js', statusCode: 200, lineNumber: 4, columnNumber: 5, sample: 'eval' }); return [Object.prototype.toString.call(event), event.documentURI, event.blockedURI, event.violatedDirective, event.effectiveDirective, event.originalPolicy, event.disposition, event.sourceFile, event.statusCode, event.lineNumber, event.columnNumber, event.sample]; })(),
        (() => { const error = new Error('boom'); const event = new ErrorEvent('error', { message: 'boom', filename: 'app.js', lineno: 2, colno: 3, error }); return [Object.prototype.toString.call(event), event.message, event.filename, event.lineno, event.colno, event.error === error]; })(),
        (() => { const event = new HashChangeEvent('hashchange', { oldURL: 'https://a/#old', newURL: 'https://a/#new' }); return [Object.prototype.toString.call(event), event.oldURL, event.newURL, Object.prototype.hasOwnProperty.call(event, 'oldURL'), Object.getOwnPropertyNames(HashChangeEvent.prototype)]; })(),
        (() => { const event = new PopStateEvent('popstate', { state: { page: 2 }, hasUAVisualTransition: true }); return [Object.prototype.toString.call(event), event.state.page, event.hasUAVisualTransition, Object.prototype.hasOwnProperty.call(event, 'state'), Object.getOwnPropertyNames(PopStateEvent.prototype)]; })(),
        (() => { const promise = Promise.resolve(1); const event = new PromiseRejectionEvent('unhandledrejection', { promise, reason: 'nope' }); return [Object.prototype.toString.call(event), event.promise === promise, event.reason]; })(),
        (() => { const event = new PageTransitionEvent('pageshow', { persisted: true }); return [Object.prototype.toString.call(event), event instanceof PageTransitionEvent, event instanceof Event, event.persisted, Object.prototype.hasOwnProperty.call(event, 'persisted'), Object.getOwnPropertyNames(PageTransitionEvent.prototype)]; })(),
        (() => { try { new BeforeUnloadEvent('beforeunload', { returnValue: 'leave?' }); return ['ok']; } catch (error) { const fake = Object.create(BeforeUnloadEvent.prototype); return [error.name, error.message, Object.prototype.toString.call(fake), Object.getOwnPropertyNames(BeforeUnloadEvent.prototype), (() => { try { fake.returnValue = 'x'; return ['ok']; } catch (setError) { return [setError.name, setError.message]; } })()]; } })(),
        (() => { const event = new BeforeInstallPromptEvent('beforeinstallprompt', { platforms: ['web', 'play'] }); return [Object.prototype.toString.call(event), event instanceof BeforeInstallPromptEvent, event instanceof Event, Object.isFrozen(event.platforms), event.platforms === event.platforms, event.platforms.join(','), typeof event.prompt, event.prompt().catch(() => null) instanceof Promise, event.userChoice.catch(() => null) instanceof Promise, Object.getOwnPropertyNames(event), Object.getOwnPropertyNames(BeforeInstallPromptEvent.prototype)]; })(),
        (() => { const event = new MessageEvent('message', { data: 'payload', origin: 'https://origin.example', lastEventId: 'last', source: window, ports: [] }); return [Object.prototype.toString.call(event), event instanceof MessageEvent, event instanceof Event, event.data, event.origin, event.lastEventId, event.source === window, event.ports.length]; })(),
        (() => { const event = new AnimationPlaybackEvent('finish', { currentTime: 1.5, timelineTime: 2.5 }); return [Object.prototype.toString.call(event), event instanceof AnimationPlaybackEvent, event instanceof Event, event.currentTime, event.timelineTime]; })(),
        (() => { const blob = new Blob(['payload'], { type: 'text/plain' }); const event = new BlobEvent('dataavailable', { data: blob, timecode: 12.5 }); let missing = ''; try { new BlobEvent('dataavailable'); } catch (error) { missing = error.name; } return [Object.prototype.toString.call(event), event instanceof BlobEvent, event instanceof Event, event.data === blob, event.data.type, event.timecode, missing]; })(),
        (() => { const source = document.createElement('button'); const event = new ToggleEvent('toggle', { oldState: 'closed', newState: 'open', source }); return [Object.prototype.toString.call(event), event instanceof ToggleEvent, event instanceof Event, event.oldState, event.newState, event.source === source]; })(),
        (() => { const source = document.createElement('button'); const event = new CommandEvent('command', { command: 'show-modal', source }); return [Object.prototype.toString.call(event), event instanceof CommandEvent, event instanceof Event, event.command, event.source === source]; })(),
        (() => { const event = new ContentVisibilityAutoStateChangeEvent('contentvisibilityautostatechange', { skipped: true }); return [Object.prototype.toString.call(event), event instanceof ContentVisibilityAutoStateChangeEvent, event instanceof Event, event.skipped]; })(),
        (() => { const face = new FontFace('VirtualFont', 'url(data:font/woff2;base64,)'); const event = new FontFaceSetLoadEvent('loadingdone', { fontfaces: [face] }); return [Object.prototype.toString.call(event), event instanceof FontFaceSetLoadEvent, event instanceof Event, Array.isArray(event.fontfaces), Object.isFrozen(event.fontfaces), event.fontfaces !== event.fontfaces, event.fontfaces.length, event.fontfaces[0] === face, Object.prototype.hasOwnProperty.call(event, 'fontfaces'), Object.getOwnPropertyNames(FontFaceSetLoadEvent.prototype)]; })(),
        (() => { const event = new GamepadEvent('gamepadconnected', { gamepad: null, bubbles: true, cancelable: true, composed: true }); const descriptor = Object.getOwnPropertyDescriptor(GamepadEvent.prototype, 'gamepad'); return [Object.prototype.toString.call(event), event instanceof GamepadEvent, event instanceof Event, event.gamepad, event.bubbles, event.cancelable, event.composed, Object.getOwnPropertyNames(event), Object.getOwnPropertyNames(GamepadEvent.prototype), [descriptor.enumerable, descriptor.configurable, typeof descriptor.get, descriptor.set], Object.getOwnPropertyDescriptor(GamepadEvent, 'prototype').writable, Object.prototype.hasOwnProperty.call(GamepadEvent, Symbol.hasInstance), (() => { try { GamepadEvent('gamepadconnected'); return ['ok']; } catch (error) { return [error.name, error.message]; } })(), (() => { try { new GamepadEvent(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(), (() => { try { new GamepadEvent(Symbol('x')); return ['ok']; } catch (error) { return [error.name, error.message]; } })(), (() => { try { new GamepadEvent('gamepadconnected', { gamepad: {} }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(), (() => { try { return Object.create(GamepadEvent.prototype).gamepad; } catch (error) { return [error.name, error.message]; } })()]; })(),
        (() => { const event = new PictureInPictureEvent('enterpictureinpicture', { pictureInPictureWindow: null }); return [Object.prototype.toString.call(event), event instanceof PictureInPictureEvent, event instanceof Event, event.pictureInPictureWindow]; })(),
        (() => { const event = new DocumentPictureInPictureEvent('enter', { window }); return [Object.prototype.toString.call(event), event instanceof DocumentPictureInPictureEvent, event instanceof Event, event.window === window]; })(),
        (() => {
          const button = document.createElement('button');
          const formData = new FormData();
          const blob = new Blob(['x']);
          const specs = [
            [StorageEvent, new StorageEvent('storage', { key: 'k', oldValue: 'o', newValue: 'n', url: 'https://target.example/', storageArea: null }), ['key', 'oldValue', 'newValue', 'url', 'storageArea'], ['key', 'oldValue', 'newValue', 'url', 'storageArea', 'initStorageEvent', 'constructor']],
            [ProgressEvent, new ProgressEvent('progress', { lengthComputable: true, loaded: 1, total: 2 }), ['lengthComputable', 'loaded', 'total'], ['lengthComputable', 'loaded', 'total', 'constructor']],
            [SecurityPolicyViolationEvent, new SecurityPolicyViolationEvent('securitypolicyviolation'), ['documentURI', 'referrer', 'blockedURI', 'violatedDirective', 'effectiveDirective', 'originalPolicy', 'disposition', 'sourceFile', 'statusCode', 'lineNumber', 'columnNumber', 'sample'], ['documentURI', 'referrer', 'blockedURI', 'violatedDirective', 'effectiveDirective', 'originalPolicy', 'disposition', 'sourceFile', 'statusCode', 'lineNumber', 'columnNumber', 'sample', 'constructor']],
            [ErrorEvent, new ErrorEvent('error'), ['message', 'filename', 'lineno', 'colno', 'error'], ['message', 'filename', 'lineno', 'colno', 'error', 'constructor']],
            [PromiseRejectionEvent, new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(1) }), ['promise', 'reason'], ['promise', 'reason', 'constructor']],
            [SubmitEvent, new SubmitEvent('submit', { submitter: button }), ['submitter'], ['submitter', 'constructor']],
            [FormDataEvent, new FormDataEvent('formdata', { formData }), ['formData'], ['formData', 'constructor']],
            [MessageEvent, new MessageEvent('message', { data: 'payload', ports: [] }), ['data', 'origin', 'lastEventId', 'source', 'ports', 'userActivation'], ['data', 'origin', 'lastEventId', 'source', 'ports', 'userActivation', 'initMessageEvent', 'constructor']],
            [AnimationPlaybackEvent, new AnimationPlaybackEvent('finish'), ['currentTime', 'timelineTime'], ['currentTime', 'timelineTime', 'constructor']],
            [BlobEvent, new BlobEvent('dataavailable', { data: blob }), ['data', 'timecode'], ['data', 'timecode', 'constructor']],
            [ToggleEvent, new ToggleEvent('toggle', { source: button }), ['oldState', 'newState', 'source'], ['oldState', 'newState', 'source', 'constructor']],
            [CommandEvent, new CommandEvent('command', { source: button }), ['source', 'command'], ['source', 'command', 'constructor']],
            [ContentVisibilityAutoStateChangeEvent, new ContentVisibilityAutoStateChangeEvent('contentvisibilityautostatechange'), ['skipped'], ['skipped', 'constructor']],
          ];
          return specs.map(([Ctor, event, keys, protoNames]) => [
            Ctor.name,
            Ctor.length,
            Object.getOwnPropertyNames(Ctor.prototype),
            keys.every((key) => {
              const descriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, key);
              return descriptor.enumerable && descriptor.configurable && typeof descriptor.get === 'function' && descriptor.set === undefined;
            }),
            keys.some((key) => Object.prototype.hasOwnProperty.call(event, key)),
            protoNames,
          ]);
        })(),
        (() => {
          const cases = [
            () => new PromiseRejectionEvent('unhandledrejection'),
            () => new PromiseRejectionEvent('unhandledrejection', {}),
            () => new FormDataEvent('formdata'),
            () => new FormDataEvent('formdata', {}),
            () => new BlobEvent('dataavailable'),
            () => new BlobEvent('dataavailable', {}),
            () => new SubmitEvent('submit', { submitter: 'not-an-element' }),
          ];
          return [
            ...cases.map((probe) => {
              try {
                probe();
                return 'ok';
              } catch (error) {
                return error.name;
              }
            }),
            new PromiseRejectionEvent('unhandledrejection', { promise: 1 }).promise instanceof Promise,
            Object.isFrozen(new MessageEvent('message', { ports: [] }).ports),
          ];
        })(),
      ],
    });
  `);
  realm.evalClassic(`
    globalThis.storageEstimateResult = '';
    Promise.resolve().then(async () => {
      const beforePersisted = await navigator.storage.persisted();
      const persistResult = await navigator.storage.persist();
      const afterPersisted = await navigator.storage.persisted();
      const estimate = await navigator.storage.estimate();
      const uaEntropy = await navigator.userAgentData.getHighEntropyValues(['architecture', 'uaFullVersion', 'fullVersionList', 'unknown']);
      const uaNoArg = await Promise.resolve().then(() => navigator.userAgentData.getHighEntropyValues()).then(() => ['ok'], (error) => [error.name, error.message]);
      const uaBadSequence = await Promise.resolve().then(() => navigator.userAgentData.getHighEntropyValues(1)).then(() => ['ok'], (error) => [error.name, error.message]);
      const uaStringSequence = await Promise.resolve().then(() => navigator.userAgentData.getHighEntropyValues('ab')).then(() => ['ok'], (error) => [error.name, error.message]);
      const uaSymbolHint = await Promise.resolve().then(() => navigator.userAgentData.getHighEntropyValues([Symbol('x')])).then(() => ['ok'], (error) => [error.name, error.message]);
      const deviceMotionPermission = typeof DeviceMotionEvent.requestPermission;
      const deviceOrientationPermission = typeof DeviceOrientationEvent.requestPermission;
      const channel = new MessageChannel();
      const payload = { nested: { value: 3 } };
      const messageEvents = [];
      channel.port1.onmessage = (event) => messageEvents.push([Object.prototype.toString.call(event), event instanceof MessageEvent, event.data.nested.value, event.data !== payload, event.ports.length]);
      channel.port1.start();
      channel.port2.postMessage(payload);
      payload.nested.value = 4;
      await Promise.resolve();
      await Promise.resolve();
      const bc1 = new BroadcastChannel('zp-test');
      const bc2 = new BroadcastChannel('zp-test');
      const broadcastPayload = { nested: { value: 8 } };
      const broadcastEvents = [];
      bc1.onmessage = (event) => broadcastEvents.push([Object.prototype.toString.call(event), event instanceof MessageEvent, event.data.nested.value, event.data !== broadcastPayload, event.origin]);
      bc2.postMessage(broadcastPayload);
      broadcastPayload.nested.value = 9;
      await Promise.resolve();
      await Promise.resolve();
      bc1.close();
      bc2.close();
      const geolocationDenied = await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          () => resolve(['success']),
          (error) => resolve([Object.prototype.toString.call(error), error instanceof GeolocationPositionError, error.code, error.message, error.PERMISSION_DENIED, GeolocationPositionError.PERMISSION_DENIED, Object.getOwnPropertyNames(error).sort(), [Object.getOwnPropertyDescriptor(GeolocationPositionError.prototype, 'code').enumerable, Object.getOwnPropertyDescriptor(GeolocationPositionError.prototype, 'code').configurable, typeof Object.getOwnPropertyDescriptor(GeolocationPositionError.prototype, 'code').get, Object.getOwnPropertyDescriptor(GeolocationPositionError.prototype, 'code').set]]),
        );
      });
      const watchEvents = [];
      const watchId = navigator.geolocation.watchPosition(
        () => watchEvents.push('success'),
        (error) => watchEvents.push(error.code),
      );
      navigator.geolocation.clearWatch(watchId);
      await Promise.resolve();
      await Promise.resolve();
      const lockEvents = [];
      const lockResult = await navigator.locks.request('resource', async (lock) => {
        lockEvents.push(['held', Object.prototype.toString.call(lock), lock instanceof Lock, lock.name, lock.mode]);
        const unavailable = await navigator.locks.request('resource', { ifAvailable: true }, (lock) => lock);
        lockEvents.push(['ifAvailable', unavailable]);
        const heldQuery = await navigator.locks.query();
        lockEvents.push(['query-held', heldQuery.held.map((entry) => [entry.name, entry.mode]), heldQuery.pending.length]);
        return 'done';
      });
      const sharedLock = await navigator.locks.request('resource', { mode: 'shared' }, (lock) => [lock.name, lock.mode]);
      const lockAbortController = new AbortController();
      lockAbortController.abort('cancel-lock');
      const credentialGet = await navigator.credentials.get({ password: true });
      const credentialCreate = await navigator.credentials.create({ password: { id: 'user' } });
      const credentialStore = await navigator.credentials.store('credential-token').catch((error) => [error.name, error.message]);
      const credentialPrevent = await navigator.credentials.preventSilentAccess();
      const paymentRequest = new PaymentRequest([{ supportedMethods: 'basic-card' }], { total: { label: 'Total', amount: { currency: 'USD', value: '1.00' } } });
      const paymentCanMake = await paymentRequest.canMakePayment();
      const paymentEnrolled = await paymentRequest.hasEnrolledInstrument();
      const paymentAbort = await paymentRequest.abort();
      const paymentShow = await paymentRequest.show().catch((error) => error.name);
      const contactProperties = await navigator.contacts.getProperties();
      const contactSelect = await navigator.contacts.select(['name'], { multiple: true }).catch((error) => error.name);
      const mediaDecode = await navigator.mediaCapabilities.decodingInfo({ type: 'file', video: { contentType: 'video/webm', width: 1, height: 1, bitrate: 1, framerate: 1 } });
      const mediaEncode = await navigator.mediaCapabilities.encodingInfo({ type: 'record', audio: { contentType: 'audio/webm', channels: 1, bitrate: 1, samplerate: 8000 } }).catch((error) => [error.name, error.message]);
      const shareResult = await navigator.share({ title: 'ZeroProxy' }).catch((error) => error.name);
      const notificationPermission = await Notification.requestPermission();
      let notificationCallbackPermission = '';
      await Notification.requestPermission((permission) => { notificationCallbackPermission = permission; });
      const beforeInstallPromptEvent = new BeforeInstallPromptEvent('beforeinstallprompt', { platforms: ['web'] });
      const beforeInstallPromptChoice = await beforeInstallPromptEvent.prompt().catch((error) => [error.name, error.message]);
      const beforeInstallUserChoice = await beforeInstallPromptEvent.userChoice.catch((error) => [error.name, error.message]);
      const beforeInstallPromptSame = beforeInstallPromptEvent.prompt().catch(() => null) === beforeInstallPromptEvent.userChoice.catch(() => null);
      const cropTargetDenied = await CropTarget.fromElement(document.body).catch((error) => error.name);
      const restrictionTargetDenied = await RestrictionTarget.fromElement(document.body).catch((error) => error.name);
      const reportingEvents = [];
      const reportingObserver = new ReportingObserver((reports, observer) => reportingEvents.push([reports.length, observer === reportingObserver]), { types: ['crash'], buffered: true });
      const reportingObserve = reportingObserver.observe();
      const reportingRecords = reportingObserver.takeRecords();
      const reportingDisconnect = reportingObserver.disconnect();
      const crashInitialize = await crashReport.initialize(16);
      const crashSet = crashReport.set('route', 'checkout');
      const crashDelete = crashReport.delete('route');
      let crashQuota = '';
      try { crashReport.set('long', '01234567890123456789'); } catch (error) { crashQuota = error.name; }
      const remoteVideo = document.createElement('video');
      const remoteAvailability = [];
      const remoteWatchId = await remoteVideo.remote.watchAvailability((available) => remoteAvailability.push(available));
      await Promise.resolve();
      const remoteCancel = await remoteVideo.remote.cancelWatchAvailability(remoteWatchId);
      const remotePrompt = await remoteVideo.remote.prompt().catch((error) => error.name);
      const pipRequest = await remoteVideo.requestPictureInPicture().catch((error) => error.name);
      const pipExit = await document.exitPictureInPicture().catch((error) => error.name);
      const abortedLock = await navigator.locks.request('blocked', { signal: lockAbortController.signal }, () => 'nope').catch((error) => error);
      const layoutMap = await navigator.keyboard.getLayoutMap();
      const layoutBadForEach = (() => { try { layoutMap.forEach(null); return ['ok']; } catch (error) { return [error.name, error.message]; } })();
      await navigator.keyboard.lock(['KeyA']);
      const keyboardUnlock = navigator.keyboard.unlock();
      const wakeLockEvents = [];
      const sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => wakeLockEvents.push('listener'));
      sentinel.onrelease = () => wakeLockEvents.push('handler');
      await sentinel.release();
      await sentinel.release();
      const unsupportedWakeLock = await navigator.wakeLock.request('system').catch((error) => error.name);
      globalThis.storageEstimateResult = JSON.stringify({
        usagePositive: estimate.usage > 0,
        quotaPositive: estimate.quota > estimate.usage,
        beforePersisted,
        credentials: [
          credentialGet,
          credentialCreate,
          credentialStore,
          credentialPrevent === undefined,
        ],
        payment: [
          paymentCanMake,
          paymentEnrolled,
          paymentAbort === undefined,
          paymentShow,
        ],
        contacts: [
          contactProperties,
          Object.isFrozen(contactProperties),
          contactSelect,
        ],
        mediaCapabilities: [
          mediaDecode.supported,
          mediaDecode.smooth,
          mediaDecode.powerEfficient,
          mediaDecode.keySystemAccess,
          mediaEncode,
        ],
        share: [
          navigator.canShare({ title: 'ZeroProxy' }),
          shareResult,
        ],
        notification: [
          notificationPermission,
          notificationCallbackPermission,
        ],
        beforeInstallPrompt: [
          beforeInstallPromptChoice,
          beforeInstallUserChoice,
          beforeInstallPromptSame,
        ],
        captureTargets: [
          cropTargetDenied,
          restrictionTargetDenied,
        ],
        reporting: [
          reportingObserve === undefined,
          reportingRecords.length,
          reportingDisconnect === undefined,
          reportingEvents.length,
        ],
        crashReport: [
          crashInitialize === undefined,
          crashSet === undefined,
          crashDelete === undefined,
          crashQuota,
        ],
        pictureInPicture: [
          remoteWatchId,
          remoteAvailability,
          remoteCancel === undefined,
          remotePrompt,
          pipRequest,
          pipExit,
        ],
        keyboard: [
          Object.prototype.toString.call(layoutMap),
          layoutMap instanceof KeyboardLayoutMap,
          Object.isFrozen(layoutMap),
          Object.getOwnPropertyNames(layoutMap),
          Object.getOwnPropertyNames(KeyboardLayoutMap.prototype),
          layoutMap.size,
          layoutMap.get('KeyA'),
          layoutMap.has('KeyA'),
          [...layoutMap.entries()].length,
          [...layoutMap].length,
          layoutBadForEach,
          Object.getOwnPropertyDescriptor(KeyboardLayoutMap.prototype, Symbol.iterator).enumerable,
          keyboardUnlock === undefined,
        ],
        wakeLock: [
          Object.prototype.toString.call(sentinel),
          sentinel instanceof WakeLockSentinel,
          sentinel instanceof EventTarget,
          Object.isFrozen(sentinel),
          Object.getOwnPropertyNames(sentinel),
          Object.getOwnPropertyNames(WakeLockSentinel.prototype),
          sentinel.type,
          sentinel.released,
          wakeLockEvents,
          unsupportedWakeLock,
        ],
        afterPersisted,
        persistResult,
        uaEntropy: [uaEntropy.brands[0].brand, uaEntropy.mobile, uaEntropy.platform, uaEntropy.architecture, uaEntropy.uaFullVersion, uaEntropy.fullVersionList[0].version, Object.isFrozen(uaEntropy.brands), Object.isFrozen(uaEntropy.fullVersionList), Object.prototype.hasOwnProperty.call(uaEntropy, 'unknown'), uaNoArg, uaBadSequence, uaStringSequence, uaSymbolHint],
        devicePermissions: [deviceMotionPermission, deviceOrientationPermission],
        geolocation: [geolocationDenied, typeof watchId, watchEvents.length],
        locks: [lockEvents, lockResult, sharedLock, abortedLock],
        messageChannel: [Object.prototype.toString.call(channel), channel.port1 instanceof MessagePort, channel.port2 instanceof MessagePort, Object.prototype.toString.call(channel.port1), ...messageEvents[0]],
        broadcastChannel: [Object.prototype.toString.call(bc1), bc1 instanceof BroadcastChannel, bc1.name, ...broadcastEvents[0]],
      });
    }).catch((error) => { globalThis.storageEstimateResult = JSON.stringify({ __error: [error.name, error.message] }); });
  `);
  for (let i = 0; i < 20; i++) realm.drainJobs();
  await network.waitForIdle();
  await storageManager.flush();
  const storageSnapshot = await storageManager.loadSnapshot(storagePartition);
  assert.deepEqual(JSON.parse(result), {
    alias: true,
    base64: 'ZeroProxy',
    cloneOriginal: 1,
    cloneNext: 2,
    randomLength: 4,
    randomSome: true,
    randomValidation: [
      true,
      2,
      true,
      true,
      '4',
      true,
      'function',
      'TypeError',
      'QuotaExceededError',
      '[object Crypto]',
      true,
      true,
      'function',
      ['TypeError', "Failed to construct 'Crypto': Illegal constructor"],
      false,
      ['getRandomValues', 'constructor'],
      [true, true, true, 1],
      ['length', 'name', 'prototype'],
    ],
    local: 'v',
    session: 't',
    storageCtor: [
      '[object Storage]',
      '[object Storage]',
      true,
      true,
      'function',
      ['TypeError', "Failed to construct 'Storage': Illegal constructor"],
    ],
    preloaded: 'old',
    historyLength: 2,
    historyState: 2,
    href: 'https://target.example/next',
    userAgent: 'UnitTest/1',
    platform: 'UnitOS',
    swRegistrationsType: 'function',
    navigatorTag: '[object Navigator]',
    navigatorCtor: [
      'function',
      true,
      ['TypeError', "Failed to construct 'Navigator': Illegal constructor"],
    ],
    clientInformation: [true, '[object Navigator]', true],
    vendor: 'Google Inc.',
    appName: 'Netscape',
    cloneTypes: [
      true,
      true,
      true,
      1234,
      true,
      'zp',
      'gi',
      1,
      true,
      1,
      true,
      true,
      2,
      true,
      true,
      true,
      '1,2,3',
    ],
    cloneErrorTypes: [true, 'TypeError', 'bad', 'string', true, 'InvalidStateError', 'nope', 11],
    cloneFailures: [
      ['DataCloneError', 25, true],
      ['DataCloneError', 25, true],
      ['DataCloneError', 25, true],
      ['DataCloneError', 25, true],
    ],
    cloneShape: [1, 'structuredClone', false, ['length', 'name']],
    product: 'Gecko',
    languages: ['en-US', 'en'],
    hardwareConcurrencyType: 'number',
    deviceMemoryType: 'number',
    maxTouchPoints: 0,
    webdriver: false,
    pdfViewerEnabled: true,
    newPluginArray: ['TypeError', "Failed to construct 'PluginArray': Illegal constructor"],
    newMimeTypeArray: ['TypeError', "Failed to construct 'MimeTypeArray': Illegal constructor"],
    plugins: ['[object PluginArray]', true, 5, 'function', 'function', 'function'],
    mimeTypes: ['[object MimeTypeArray]', true, 2, 'function', 'function'],
    pluginData: {
      pluginOwnNames: [
        '0',
        '1',
        '2',
        '3',
        '4',
        'PDF Viewer',
        'Chrome PDF Viewer',
        'Chromium PDF Viewer',
        'Microsoft Edge PDF Viewer',
        'WebKit built-in PDF',
      ],
      mimeTypeOwnNames: ['0', '1', 'application/pdf', 'text/pdf'],
      pluginObjectOwnNames: ['0', '1', 'application/pdf', 'text/pdf'],
      mimeObjectOwnNames: [],
      pluginRows: [
        ['PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format', 2],
        ['Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format', 2],
        ['Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format', 2],
        ['Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format', 2],
        ['WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format', 2],
      ],
      mimeRows: [
        ['application/pdf', 'pdf', 'Portable Document Format', true],
        ['text/pdf', 'pdf', 'Portable Document Format', true],
      ],
      pluginMimeRows: [
        ['application/pdf', 'pdf', 'Portable Document Format', true],
        ['text/pdf', 'pdf', 'Portable Document Format', true],
      ],
      lookups: [true, true, true, true, true, true, true, true, true],
      descriptors: [
        [true, true, true, 'function', true],
        [true, true, true, true, true],
        [true, true, true, 'function', true],
        [true, 0, true, true, 'function'],
      ],
    },
    storage: [
      '[object StorageManager]',
      true,
      'function',
      ['TypeError', "Failed to construct 'StorageManager': Illegal constructor"],
      'function',
      'function',
      'function',
      'function',
      [],
      ['estimate', 'persisted', 'constructor', 'getDirectory', 'persist'],
      [false, true, true],
      [true, true, true, 0],
    ],
    geolocation: [
      '[object Geolocation]',
      true,
      'function',
      'function',
      'function',
      [],
      [true, true, true, 'function', 1],
      [true, false, false, 3],
      ['TypeError', "Failed to construct 'Geolocation': Illegal constructor"],
      ['TypeError', "Failed to construct 'GeolocationPosition': Illegal constructor"],
      ['TypeError', "Failed to construct 'GeolocationCoordinates': Illegal constructor"],
      ['TypeError', "Failed to construct 'GeolocationPositionError': Illegal constructor"],
      1,
      3,
    ],
    connection: [
      '[object NetworkInformation]',
      true,
      true,
      '4g',
      null,
      10,
      50,
      false,
      null,
      [],
      [true, true, 'function', null],
      [true, true, 'function', 'function'],
      ['change'],
      ['TypeError', "Failed to construct 'NetworkInformation': Illegal constructor"],
    ],
    locks: [
      '[object LockManager]',
      true,
      'function',
      'function',
      [],
      ['query', 'request', 'constructor'],
      ['name', 'mode', 'constructor'],
      false,
      false,
      false,
      false,
      2,
      0,
      ['TypeError', "Failed to construct 'LockManager': Illegal constructor"],
      ['TypeError', 'Illegal constructor'],
      ['TypeError', "Failed to construct 'Lock': Illegal constructor"],
      ['TypeError', 'Illegal constructor'],
    ],
    userActivation: [
      '[object UserActivation]',
      true,
      false,
      false,
      false,
      [],
      [true, true, 'function', null],
      ['TypeError', "Failed to construct 'UserActivation': Illegal constructor"],
    ],
    bluetoothUUID: [
      'function',
      '0000180f-0000-1000-8000-00805f9b34fb',
      '0000180f-0000-1000-8000-00805f9b34fb',
      '0000180f-0000-1000-8000-00805f9b34fb',
      '00002a19-0000-1000-8000-00805f9b34fb',
      '00002902-0000-1000-8000-00805f9b34fb',
      ['TypeError', "Failed to construct 'BluetoothUUID': Illegal constructor"],
      ['TypeError'],
    ],
    keyboard: [
      '[object Keyboard]',
      true,
      false,
      [],
      ['getLayoutMap', 'lock', 'unlock', 'constructor'],
      [false, true, true],
      false,
      'function',
      'function',
      'function',
      ['TypeError', "Failed to construct 'Keyboard': Illegal constructor"],
      ['TypeError', 'Illegal constructor'],
      ['TypeError', "Failed to construct 'KeyboardLayoutMap': Illegal constructor"],
      ['TypeError', 'Illegal constructor'],
      false,
      [false, true, true],
      ['size', 'entries', 'forEach', 'get', 'has', 'keys', 'values', 'constructor'],
      true,
    ],
    windowControlsOverlay: [
      '[object WindowControlsOverlay]',
      true,
      true,
      false,
      'function',
      '[object DOMRect]',
      0,
      0,
      0,
      0,
      '[object WindowControlsOverlayGeometryChangeEvent]',
      true,
      true,
      false,
      null,
      ['TypeError', "Failed to construct 'WindowControlsOverlay': Illegal constructor"],
    ],
    wakeLock: [
      '[object WakeLock]',
      true,
      false,
      [],
      ['request', 'constructor'],
      [false, true, true],
      false,
      'function',
      ['TypeError', "Failed to construct 'WakeLock': Illegal constructor"],
      ['TypeError', 'Illegal constructor'],
      ['TypeError', "Failed to construct 'WakeLockSentinel': Illegal constructor"],
      ['TypeError', 'Illegal constructor'],
      false,
      [false, true, true],
      ['onrelease', 'released', 'type', 'release', 'constructor'],
    ],
    gamepads: [
      'function',
      true,
      4,
      true,
      false,
      ['TypeError', "Failed to construct 'Gamepad': Illegal constructor"],
      ['TypeError', 'Illegal constructor'],
      false,
      [
        'id',
        'index',
        'connected',
        'timestamp',
        'mapping',
        'axes',
        'buttons',
        'vibrationActuator',
        'constructor',
      ],
      [false, true, true],
      ['pressed', 'touched', 'value', 'constructor'],
      [false, true, true],
      false,
      ['TypeError', "Failed to construct 'GamepadButton': Illegal constructor"],
      ['TypeError', 'Illegal constructor'],
    ],
    credentials: [
      '[object CredentialsContainer]',
      true,
      false,
      [],
      ['create', 'get', 'preventSilentAccess', 'store', 'constructor'],
      [false, true, true],
      ['id', 'type', 'constructor'],
      [false, true, true],
      ['length', 'name', 'prototype', 'isConditionalMediationAvailable'],
      [true, true, true, 'function', 0],
      false,
      false,
      'function',
      'function',
      'function',
      'function',
      ['TypeError', "Failed to construct 'Credential': Illegal constructor"],
      ['TypeError', 'Illegal constructor'],
      ['TypeError', "Failed to construct 'CredentialsContainer': Illegal constructor"],
      ['TypeError', 'Illegal constructor'],
    ],
    payment: [
      'function',
      '[object PaymentRequest]',
      true,
      true,
      'pay-1',
      null,
      null,
      'shipping',
      'function',
      'function',
      ['TypeError', "Failed to construct 'PaymentResponse': Illegal constructor"],
      ['TypeError', "Failed to construct 'PaymentAddress': Illegal constructor"],
    ],
    contacts: [
      '[object ContactsManager]',
      true,
      true,
      'function',
      'function',
      ['TypeError', "Failed to construct 'ContactsManager': Illegal constructor"],
      ['TypeError', "Failed to construct 'ContactAddress': Illegal constructor"],
    ],
    mediaCapabilities: [
      '[object MediaCapabilities]',
      true,
      false,
      [],
      ['decodingInfo', 'encodingInfo', 'constructor'],
      [false, true, true],
      false,
      [true, true, true, 1],
      'function',
      'function',
      ['TypeError', "Failed to construct 'MediaCapabilities': Illegal constructor"],
      ['TypeError', 'Illegal constructor'],
    ],
    mediaSession: [
      '[object MediaSession]',
      true,
      true,
      '[object MediaMetadata]',
      'Track',
      'Artist',
      'Album',
      true,
      'https://target.example/cover.png',
      '96x96',
      'image/png',
      [],
      true,
      0,
      false,
      '3',
      [
        'TypeError',
        "Failed to set the 'artwork' property on 'MediaMetadata': The provided value cannot be converted to a sequence.",
      ],
      true,
      'playing',
      true,
      true,
      true,
      'TypeError',
      'TypeError',
      ['TypeError', "Failed to construct 'MediaSession': Illegal constructor"],
    ],
    share: ['function', 'function', false, false],
    launchQueue: [
      '[object LaunchQueue]',
      true,
      false,
      [],
      ['setConsumer', 'constructor'],
      ['targetURL', 'files', 'constructor'],
      false,
      false,
      false,
      false,
      'function',
      1,
      [
        'TypeError',
        "Failed to execute 'setConsumer' on 'LaunchQueue': parameter 1 is not of type 'Function'.",
      ],
      ['TypeError', "Failed to construct 'LaunchQueue': Illegal constructor"],
      ['TypeError', 'Illegal constructor'],
      ['TypeError', "Failed to construct 'LaunchParams': Illegal constructor"],
      ['TypeError', 'Illegal constructor'],
    ],
    notification: [
      'function',
      'denied',
      0,
      'function',
      '[object Notification]',
      true,
      true,
      [],
      [
        'onclick',
        'onshow',
        'onerror',
        'onclose',
        'title',
        'dir',
        'lang',
        'body',
        'tag',
        'icon',
        'badge',
        'vibrate',
        'timestamp',
        'renotify',
        'silent',
        'requireInteraction',
        'data',
        'actions',
        'close',
        'constructor',
      ],
      ['length', 'name', 'prototype', 'permission', 'maxActions', 'requestPermission'],
      [false, true, true],
      [true, true, true],
      ['ZeroProxy', 'Body', 'tag', true, true, 123, true],
      ['TypeError', "Failed to construct 'Notification': 1 argument required, but only 0 present."],
      [
        'TypeError',
        "Failed to construct 'Notification': Actions are only supported for persistent notifications shown using ServiceWorkerRegistration.showNotification().",
      ],
    ],
    reporting: [
      'function',
      '[object ReportingObserver]',
      true,
      'function',
      'function',
      'function',
      true,
      true,
      0,
      true,
      0,
      [
        'TypeError',
        "Failed to construct 'ReportingObserver': parameter 1 is not of type 'Function'.",
      ],
      ['TypeError', "Failed to construct 'ReportBody': Illegal constructor"],
      ['TypeError', "Failed to construct 'CSPViolationReportBody': Illegal constructor"],
      true,
      ['TypeError', "Failed to construct 'IntegrityViolationReportBody': Illegal constructor"],
      true,
    ],
    crashReport: [
      '[object CrashReportContext]',
      true,
      false,
      'function',
      'function',
      'function',
      ['TypeError', "Failed to construct 'CrashReportContext': Illegal constructor"],
    ],
    featurePolicy: [
      'function',
      '[object FeaturePolicy]',
      true,
      false,
      0,
      0,
      false,
      0,
      [
        'TypeError',
        "Failed to execute 'allowsFeature' on 'FeaturePolicy': 1 argument required, but only 0 present.",
      ],
      ['TypeError', "Failed to construct 'FeaturePolicy': Illegal constructor"],
    ],
    inputDeviceCapabilities: [
      '[object InputDeviceCapabilities]',
      true,
      true,
      false,
      true,
      true,
      [],
      ['firesTouchEvents', 'constructor'],
      [false, true, true],
      [true, true, true, null],
      [
        'TypeError',
        "Failed to construct 'InputDeviceCapabilities': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      ],
    ],
    mediaDiagnostics: [
      'function',
      '[object MediaError]',
      true,
      [
        'length',
        'name',
        'prototype',
        'MEDIA_ERR_ABORTED',
        'MEDIA_ERR_NETWORK',
        'MEDIA_ERR_DECODE',
        'MEDIA_ERR_SRC_NOT_SUPPORTED',
      ],
      [
        'code',
        'message',
        'MEDIA_ERR_ABORTED',
        'MEDIA_ERR_NETWORK',
        'MEDIA_ERR_DECODE',
        'MEDIA_ERR_SRC_NOT_SUPPORTED',
        'constructor',
      ],
      [false, true, true],
      false,
      false,
      [true, true, 'function', null],
      [true, false, false],
      [true, false, false],
      ['TypeError', 'Illegal invocation'],
      ['TypeError', 'Illegal invocation'],
      1,
      2,
      3,
      4,
      4,
      ['TypeError', 'Illegal constructor'],
      ['TypeError', "Failed to construct 'MediaError': Illegal constructor"],
      'function',
      '[object InputDeviceInfo]',
      true,
      'function',
      0,
      true,
      ['getCapabilities', 'constructor'],
      false,
      [false, true, true],
      [true, true, true, 0],
      ['TypeError', "Failed to construct 'InputDeviceInfo': Illegal constructor"],
      ['TypeError', 'Illegal constructor'],
    ],
    legacyBrowserFacades: [
      'function',
      '[object Plugin]',
      true,
      ['TypeError', "Failed to construct 'Plugin': Illegal constructor"],
      'function',
      '[object MimeType]',
      true,
      ['TypeError', "Failed to construct 'MimeType': Illegal constructor"],
      '[object DOMError]',
      true,
      'NetworkError',
      'offline',
      'DOMError',
      1,
      false,
      [],
      [
        [true, true, true, false],
        [true, true, true, false],
        [false, true, true, 'DOMError', 1],
      ],
      [
        'TypeError',
        "Failed to construct 'DOMError': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      ],
      ['TypeError', "Failed to construct 'DOMError': 1 argument required, but only 0 present."],
      '[object OverconstrainedError]',
      true,
      true,
      'OverconstrainedError',
      'bad',
      'width',
      'OverconstrainedError',
      1,
      false,
      [],
      [
        [true, true, true, false],
        [false, true, true, 'OverconstrainedError', 1],
      ],
      [
        'TypeError',
        "Failed to construct 'OverconstrainedError': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      ],
      [
        'TypeError',
        "Failed to construct 'OverconstrainedError': 1 argument required, but only 0 present.",
      ],
      '[object QuotaExceededError]',
      true,
      true,
      'QuotaExceededError',
      'full',
      22,
      5,
      7,
      'QuotaExceededError',
      0,
      false,
      [],
      [
        [true, true, true, false],
        [true, true, true, false],
        [false, true, true, 'QuotaExceededError', 0],
      ],
      [
        'TypeError',
        "Failed to construct 'QuotaExceededError': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      ],
      [
        'TypeError',
        "Failed to construct 'QuotaExceededError': The provided value is not of type 'QuotaExceededErrorOptions'.",
      ],
    ],
    mediaStreamFacades: [
      '[object MediaStream]',
      true,
      true,
      true,
      2,
      true,
      true,
      true,
      true,
      false,
      'ended',
      true,
      2,
      0,
      [
        'TypeError',
        "Failed to execute 'addTrack' on 'MediaStream': parameter 1 is not of type 'MediaStreamTrack'.",
      ],
      '[object MediaStreamTrack]',
      true,
      'audio',
      'audio-1',
      'microphone',
      0,
      ['TypeError', "Failed to construct 'MediaStreamTrack': Illegal constructor"],
      '[object CanvasCaptureMediaStreamTrack]',
      true,
      null,
      'function',
      ['TypeError', "Failed to construct 'CanvasCaptureMediaStreamTrack': Illegal constructor"],
      '[object BrowserCaptureMediaStreamTrack]',
      true,
      'function',
      'function',
      ['TypeError', "Failed to construct 'BrowserCaptureMediaStreamTrack': Illegal constructor"],
      '[object AudioSinkInfo]',
      'none',
      ['type', 'constructor'],
      ['Symbol(Symbol.toStringTag)'],
      [false, true, true],
      false,
      ['TypeError', 'Illegal constructor'],
      ['TypeError', "Failed to construct 'AudioSinkInfo': Illegal constructor"],
      '[object MediaStreamTrackAudioStats]',
      0,
      0,
      'function',
      [
        'deliveredFrames',
        'deliveredFramesDuration',
        'totalFrames',
        'totalFramesDuration',
        'latency',
        'averageLatency',
        'minimumLatency',
        'maximumLatency',
        'resetLatency',
        'toJSON',
        'constructor',
      ],
      false,
      ['TypeError', 'Illegal constructor'],
      ['TypeError', "Failed to construct 'MediaStreamTrackAudioStats': Illegal constructor"],
      '[object MediaStreamTrackVideoStats]',
      0,
      0,
      ['deliveredFrames', 'discardedFrames', 'totalFrames', 'toJSON', 'constructor'],
      false,
      ['TypeError', 'Illegal constructor'],
      ['TypeError', "Failed to construct 'MediaStreamTrackVideoStats': Illegal constructor"],
      '[object MediaRecorder]',
      true,
      true,
      'video/webm',
      123,
      45,
      'constant',
      true,
      false,
      'recording',
      'paused',
      'inactive',
      [
        'InvalidStateError',
        "Failed to execute 'start' on 'MediaRecorder': The MediaRecorder's state is 'recording'.",
      ],
      [
        'TypeError',
        "Failed to construct 'MediaRecorder': 1 argument required, but only 0 present.",
      ],
      [
        'TypeError',
        "Failed to construct 'MediaRecorder': parameter 1 is not of type 'MediaStream'.",
      ],
      [
        'InvalidStateError',
        "Failed to execute 'stop' on 'MediaRecorder': The MediaRecorder's state is 'inactive'.",
      ],
    ],
    queuingStrategies: [
      '[object ByteLengthQueuingStrategy]',
      true,
      4,
      9,
      true,
      [],
      false,
      [true, true, true, false],
      [true, true, true, false],
      [
        'TypeError',
        "Failed to construct 'ByteLengthQueuingStrategy': 1 argument required, but only 0 present.",
      ],
      [
        'TypeError',
        "Failed to construct 'ByteLengthQueuingStrategy': Failed to read the 'highWaterMark' property from 'QueuingStrategyInit': Required member is undefined.",
      ],
      [
        'TypeError',
        "Failed to construct 'ByteLengthQueuingStrategy': The provided value is not of type 'QueuingStrategyInit'.",
      ],
      '[object CountQueuingStrategy]',
      true,
      2,
      1,
      true,
      [],
      false,
      [true, true, true, false],
      [true, true, true, false],
      [
        'TypeError',
        "Failed to construct 'CountQueuingStrategy': 1 argument required, but only 0 present.",
      ],
      [
        'TypeError',
        "Failed to construct 'CountQueuingStrategy': Failed to read the 'highWaterMark' property from 'QueuingStrategyInit': Required member is undefined.",
      ],
      [
        'TypeError',
        "Failed to construct 'CountQueuingStrategy': The provided value is not of type 'QueuingStrategyInit'.",
      ],
    ],
    compressionStreams: [
      '[object CompressionStream]',
      true,
      '[object ReadableStream]',
      '[object WritableStream]',
      '[object DecompressionStream]',
      true,
      '[object ReadableStream]',
      '[object WritableStream]',
      [
        'TypeError',
        "Failed to construct 'CompressionStream': 1 argument required, but only 0 present.",
      ],
      [
        'TypeError',
        "Failed to construct 'CompressionStream': The provided value 'br' is not a valid enum value of type CompressionFormat.",
      ],
      [
        'TypeError',
        "Failed to construct 'DecompressionStream': The provided value 'bad' is not a valid enum value of type CompressionFormat.",
      ],
    ],
    textEncoding: [
      '[object TextEncoder]',
      true,
      'utf-8',
      [104, 105, 32, 226, 130, 172],
      2,
      3,
      [195, 169, 33],
      '[object TextDecoder]',
      true,
      'utf-8',
      false,
      true,
      'hi €',
      '﻿A',
      '[object TextEncoderStream]',
      true,
      'utf-8',
      '[object ReadableStream]',
      '[object WritableStream]',
      '[object TextDecoderStream]',
      true,
      'utf-8',
      true,
      false,
      '[object ReadableStream]',
      [
        'RangeError',
        "Failed to construct 'TextDecoder': The encoding label provided ('bad-encoding') is invalid.",
      ],
      [
        'TypeError',
        "Failed to execute 'encodeInto' on 'TextEncoder': parameter 2 is not of type 'Uint8Array'.",
      ],
    ],
    highlightApi: [
      'function',
      '[object Highlight]',
      true,
      true,
      2,
      true,
      true,
      true,
      true,
      1,
      -1,
      'spelling-error',
      [
        'TypeError',
        "Failed to execute 'add' on 'Highlight': parameter 1 is not of type 'AbstractRange'.",
      ],
      'function',
      '[object HighlightRegistry]',
      true,
      true,
      true,
      1,
      true,
      true,
      true,
      [[true, 'zp', true, 'ctx']],
      true,
      0,
      true,
      0,
      ['TypeError', "Failed to construct 'HighlightRegistry': Illegal constructor"],
      [
        'TypeError',
        "Failed to execute 'set' on 'HighlightRegistry': parameter 2 is not of type 'Highlight'.",
      ],
      [
        'TypeError',
        "Failed to execute 'highlightsFromPoint' on 'HighlightRegistry': 2 arguments required, but only 0 present.",
      ],
      [
        'TypeError',
        "Failed to execute 'highlightsFromPoint' on 'HighlightRegistry': The provided float value is non-finite.",
      ],
    ],
    longTailEventConstructors: [
      '[object TrackEvent]',
      true,
      true,
      true,
      ['isTrusted'],
      ['track', 'constructor'],
      ['Symbol(Symbol.toStringTag)'],
      false,
      [false, true, true],
      [
        'TypeError',
        "Failed to construct 'TrackEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      ],
      ['TypeError', "Failed to construct 'TrackEvent': 1 argument required, but only 0 present."],
      [
        'TypeError',
        "Failed to construct 'TrackEvent': Failed to read the 'track' property from 'TrackEventInit': The provided value is not of type '(AudioTrack or TextTrack or VideoTrack)'.",
      ],
      true,
      ['isTrusted'],
      ['track', 'constructor'],
      ['Symbol(Symbol.toStringTag)'],
      false,
      [false, true, true],
      [
        'TypeError',
        "Failed to construct 'MediaStreamTrackEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      ],
      [
        'TypeError',
        "Failed to construct 'MediaStreamTrackEvent': 2 arguments required, but only 0 present.",
      ],
      [
        'TypeError',
        "Failed to construct 'MediaStreamTrackEvent': 2 arguments required, but only 1 present.",
      ],
      [
        'TypeError',
        "Failed to construct 'MediaStreamTrackEvent': Failed to read the 'track' property from 'MediaStreamTrackEventInit': Failed to convert value to 'MediaStreamTrack'.",
      ],
      'cenc',
      true,
      true,
      true,
      true,
      ['TypeError', "Failed to construct 'TextEvent': Illegal constructor"],
      '[object TextEvent]',
      true,
      'function',
      ['[object TextEvent]', true, true, 'abc', 'textInput', true, true],
      ['TypeError', 'Illegal constructor'],
      ['data', 'initTextEvent', 'constructor'],
      [true, true, 'function', null],
      [true, true, true, 1],
      [false, true, true],
      false,
      false,
      ['isTrusted'],
      [
        'TypeError',
        "Failed to execute 'initTextEvent' on 'TextEvent': 1 argument required, but only 0 present.",
      ],
      [
        'TypeError',
        "Failed to execute 'initTextEvent' on 'TextEvent': Cannot convert a Symbol value to a string",
      ],
      ['undefined', false, false, null],
      1,
      2,
      '[object TextFormat]',
      3,
      4,
      'solid',
      'thick',
      1,
      true,
      true,
      5,
      6,
      'hello',
      7,
      8,
      [
        'MediaEncryptedEvent',
        1,
        ['initDataType', 'initData', 'constructor'],
        true,
        false,
        ['initDataType', 'initData', 'constructor'],
      ],
      [
        'PageRevealEvent',
        1,
        ['viewTransition', 'constructor'],
        true,
        false,
        ['viewTransition', 'constructor'],
      ],
      [
        'PageSwapEvent',
        1,
        ['viewTransition', 'activation', 'constructor'],
        true,
        false,
        ['viewTransition', 'activation', 'constructor'],
      ],
      [
        'CharacterBoundsUpdateEvent',
        1,
        ['rangeStart', 'rangeEnd', 'constructor'],
        true,
        false,
        ['rangeStart', 'rangeEnd', 'constructor'],
      ],
      [
        'TextFormat',
        0,
        ['rangeStart', 'rangeEnd', 'underlineStyle', 'underlineThickness', 'constructor'],
        true,
        false,
        ['rangeStart', 'rangeEnd', 'underlineStyle', 'underlineThickness', 'constructor'],
      ],
      [
        'TextFormatUpdateEvent',
        1,
        ['getTextFormats', 'constructor'],
        true,
        false,
        ['getTextFormats', 'constructor'],
      ],
      [
        'TextUpdateEvent',
        1,
        [
          'updateRangeStart',
          'updateRangeEnd',
          'text',
          'selectionStart',
          'selectionEnd',
          'constructor',
        ],
        true,
        false,
        [
          'updateRangeStart',
          'updateRangeEnd',
          'text',
          'selectionStart',
          'selectionEnd',
          'constructor',
        ],
      ],
    ],
    rtcEventConstructors: [
      '[object MediaStreamEvent]',
      true,
      true,
      true,
      '[object RTCPeerConnectionIceEvent]',
      true,
      true,
      true,
      '[object RTCPeerConnectionIceErrorEvent]',
      '192.0.2.1',
      3478,
      'host',
      'stun:example.test',
      701,
      'blocked',
      '[object RTCTrackEvent]',
      true,
      true,
      1,
      true,
      true,
      '[object RTCIceCandidate]',
      true,
      'candidate:1',
      'uf',
      [
        'TypeError',
        "Failed to construct 'RTCIceCandidate': sdpMid and sdpMLineIndex are both null.",
      ],
      '[object RTCSessionDescription]',
      'offer',
      'v=0',
      'offer',
      [
        'TypeError',
        "Failed to construct 'RTCSessionDescription': Failed to read the 'type' property from 'RTCSessionDescriptionInit': The provided value 'bad' is not a valid enum value of type RTCSdpType.",
      ],
      '[object RTCError]',
      true,
      true,
      'OperationError',
      'failed',
      'data-channel-failure',
      12,
      [
        'TypeError',
        "Failed to construct 'RTCError': Failed to read the 'errorDetail' property from 'RTCErrorInit': Required member is undefined.",
      ],
      '[object RTCErrorEvent]',
      true,
      ['isTrusted'],
      ['error', 'constructor'],
      ['Symbol(Symbol.toStringTag)'],
      false,
      [false, true, true],
      [
        'TypeError',
        "Failed to construct 'RTCErrorEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      ],
      [
        'TypeError',
        "Failed to construct 'RTCErrorEvent': 2 arguments required, but only 0 present.",
      ],
      [
        'TypeError',
        "Failed to construct 'RTCErrorEvent': Failed to read the 'error' property from 'RTCErrorEventInit': Required member is undefined.",
      ],
      '[object RTCDataChannelEvent]',
      true,
      ['isTrusted'],
      ['channel', 'constructor'],
      ['Symbol(Symbol.toStringTag)'],
      false,
      [false, true, true],
      [
        'TypeError',
        "Failed to construct 'RTCDataChannelEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      ],
      [
        'TypeError',
        "Failed to construct 'RTCDataChannelEvent': 2 arguments required, but only 0 present.",
      ],
      [
        'TypeError',
        "Failed to construct 'RTCDataChannelEvent': Failed to read the 'channel' property from 'RTCDataChannelEventInit': Required member is undefined.",
      ],
      '[object RTCDTMFToneChangeEvent]',
      '1',
      ['MediaStreamEvent', 1, ['stream', 'constructor'], true, false, ['stream', 'constructor']],
      [
        'RTCPeerConnectionIceEvent',
        1,
        ['candidate', 'constructor'],
        true,
        false,
        ['candidate', 'constructor'],
      ],
      [
        'RTCPeerConnectionIceErrorEvent',
        2,
        ['address', 'port', 'hostCandidate', 'url', 'errorCode', 'errorText', 'constructor'],
        true,
        false,
        ['address', 'port', 'hostCandidate', 'url', 'errorCode', 'errorText', 'constructor'],
      ],
      ['RTCDTMFToneChangeEvent', 2, ['tone', 'constructor'], true, false, ['tone', 'constructor']],
    ],
    captureMetadata: [
      'function',
      '[object ChapterInformation]',
      true,
      ['title', 'startTime', 'artwork', 'constructor'],
      [false, true, true],
      false,
      false,
      [true, true, 'function', null],
      [true, true, 'function', null],
      ['TypeError', 'Illegal invocation'],
      ['TypeError', 'Illegal invocation'],
      ['TypeError', 'Illegal invocation'],
      ['TypeError', 'Illegal constructor'],
      ['TypeError', "Failed to construct 'ChapterInformation': Illegal constructor"],
      'function',
      '[object CropTarget]',
      'function',
      ['TypeError', "Failed to construct 'CropTarget': Illegal constructor"],
      'function',
      '[object RestrictionTarget]',
      'function',
      ['TypeError', "Failed to construct 'RestrictionTarget': Illegal constructor"],
      '[object DelegatedInkTrailPresenter]',
      null,
      null,
      ['TypeError', "Failed to construct 'DelegatedInkTrailPresenter': Illegal constructor"],
    ],
    trustedTypes: [
      'function',
      'function',
      'function',
      'function',
      'function',
      '[object TrustedTypePolicyFactory]',
      true,
      false,
      [],
      [
        'emptyHTML',
        'emptyScript',
        'defaultPolicy',
        'createPolicy',
        'getAttributeType',
        'getPropertyType',
        'getTypeMapping',
        'isHTML',
        'isScript',
        'isScriptURL',
        'constructor',
      ],
      ['name', 'createHTML', 'createScript', 'createScriptURL', 'constructor'],
      ['toJSON', 'toString', 'constructor'],
      false,
      false,
      false,
      false,
      false,
      false,
      '',
      '',
      true,
      '',
      true,
      null,
      '[object TrustedTypePolicy]',
      true,
      [],
      'zp-main',
      '[object TrustedHTML]',
      true,
      [],
      'html:x',
      'html:x',
      true,
      '[object TrustedScript]',
      true,
      'script:x',
      true,
      '[object TrustedScriptURL]',
      true,
      'url:/x.js',
      true,
      null,
      null,
      null,
      [
        'TypeError',
        "Failed to execute 'createPolicy' on 'TrustedTypePolicyFactory': 1 argument required, but only 0 present.",
      ],
      [
        'TypeError',
        "Failed to execute 'createScript' on 'TrustedTypePolicy': Policy zp-html-only's TrustedTypePolicyOptions did not specify a 'createScript' member.",
      ],
      ['TypeError', "Failed to construct 'TrustedHTML': Illegal constructor"],
      ['TypeError', "Failed to construct 'TrustedTypePolicyFactory': Illegal constructor"],
      ['TypeError', 'Illegal constructor'],
      ['TypeError', 'Illegal constructor'],
    ],
    fontLoading: [
      'function',
      'function',
      '[object FontFace]',
      true,
      'Virtual',
      'italic',
      '700',
      'swap',
      'loaded',
      '[object Promise]',
      '[object Promise]',
      '[object FontFaceSet]',
      true,
      true,
      true,
      1,
      true,
      'loaded',
      true,
      '[object Promise]',
      '[object Promise]',
      1,
      true,
      true,
      1,
      [
        'TypeError',
        "Failed to execute 'add' on 'FontFaceSet': parameter 1 is not of type 'FontFace'.",
      ],
      ['TypeError', "Failed to construct 'FontFace': 2 arguments required, but only 1 present."],
      ['TypeError', "Failed to construct 'FontFaceSet': Illegal constructor"],
    ],
    pictureInPicture: [
      'function',
      true,
      true,
      true,
      '[object RemotePlayback]',
      true,
      true,
      true,
      '',
      false,
      null,
      'function',
      'function',
      'function',
      '[object VideoPlaybackQuality]',
      true,
      'number',
      0,
      0,
      0,
      [
        'TypeError',
        "Failed to execute 'getVideoPlaybackQuality': receiver is not a video element.",
      ],
      '[object PictureInPictureEvent]',
      true,
      true,
      null,
      '[object DocumentPictureInPictureEvent]',
      true,
      true,
      ['isTrusted'],
      ['window', 'constructor'],
      ['Symbol(Symbol.toStringTag)'],
      false,
      [false, true, true],
      [
        'TypeError',
        "Failed to construct 'DocumentPictureInPictureEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      ],
      [
        'TypeError',
        "Failed to construct 'DocumentPictureInPictureEvent': 2 arguments required, but only 0 present.",
      ],
      [
        'TypeError',
        "Failed to construct 'DocumentPictureInPictureEvent': Failed to read the 'window' property from 'DocumentPictureInPictureEventInit': Required member is undefined.",
      ],
      ['TypeError', "Failed to construct 'RemotePlayback': Illegal constructor"],
      ['TypeError', "Failed to construct 'PictureInPictureWindow': Illegal constructor"],
    ],
    uaData: [
      '[object NavigatorUAData]',
      true,
      'ZeroProxy',
      false,
      'UnitOS',
      '{"brands":[{"brand":"ZeroProxy","version":"1"}],"mobile":false,"platform":"UnitOS"}',
      [],
      false,
      true,
      false,
      [true, true, 'function', null],
      [true, true, true, 'function', 1],
      ['TypeError', "Failed to construct 'NavigatorUAData': Illegal constructor"],
    ],
    storageEvent: [
      '[object StorageEvent]',
      true,
      true,
      'k',
      'old',
      'new',
      'https://target.example/page',
      true,
      'storage',
      true,
      true,
      'a',
      'b',
      'c',
      'https://target.example/other',
      true,
    ],
    brands: [
      '[object Blob]',
      '[object File]',
      '[object FileReader]',
      '[object FormData]',
      '[object ValidityState]',
      '[object StorageEvent]',
      '[object Range]',
      '[object StaticRange]',
      '[object Selection]',
      '[object TreeWalker]',
      '[object NodeIterator]',
      '[object CacheStorage]',
      '[object IDBKeyRange]',
    ],
    eventConstructors: [
      '[object Event]',
      [
        false,
        false,
        false,
        true,
        true,
        true,
        false,
        ['isTrusted'],
        [
          'type',
          'target',
          'currentTarget',
          'eventPhase',
          'bubbles',
          'cancelable',
          'defaultPrevented',
          'composed',
          'timeStamp',
          'srcElement',
          'returnValue',
          'cancelBubble',
          'NONE',
          'CAPTURING_PHASE',
          'AT_TARGET',
          'BUBBLING_PHASE',
          'composedPath',
          'initEvent',
          'preventDefault',
          'stopImmediatePropagation',
          'stopPropagation',
          'constructor',
        ],
        'TypeError',
      ],
      [true, 'number', 1, 2, true, false, true, false],
      [
        'legacy',
        true,
        true,
        false,
        7,
        true,
        true,
        'click',
        4,
        true,
        true,
        false,
        2,
        true,
        'NotSupportedError',
      ],
      ['[object CustomEvent]', 0],
      ['[object SubmitEvent]', true, true, true],
      ['[object FormDataEvent]', true, true, true],
      ['[object WindowControlsOverlayGeometryChangeEvent]', true, true, false, null],
      [
        '[object VirtualKeyboardGeometryChangeEvent]',
        true,
        true,
        false,
        false,
        false,
        false,
        'undefined',
      ],
      ['[object MouseEvent]', true, true, 12, 1, true, true, false],
      ['[object PointerEvent]', true, true, 12, 9, 3, 4, 0.5, 'pen', true, false, 0],
      [
        true,
        false,
        [
          ['gotpointercapture', 12, true],
          ['lostpointercapture', 12, false],
        ],
      ],
      ['[object KeyboardEvent]', 'Enter', 'Enter', true, 2, true, false, 3],
      ['[object InputEvent]', 'x', 'insertText', true, true, true, 1, 0],
      ['[object CompositionEvent]', true, true, 'legacy', 'compositionend', true],
      ['[object FocusEvent]', true, true, 'focusin', false, 5, true],
      ['[object ClipboardEvent]', true, true, true],
      ['[object DragEvent]', true],
      [
        '[object Touch]',
        true,
        true,
        7,
        11,
        21,
        3,
        0.8,
        '[object TouchList]',
        true,
        1,
        true,
        true,
        null,
        '[object TouchEvent]',
        true,
        true,
        true,
        true,
        false,
        false,
        'TypeError',
      ],
      ['[object WheelEvent]', true, true, 1, -2, 1, 0, 2],
      ['[object AnimationEvent]', 'fade', 1.25, '::before'],
      ['[object TransitionEvent]', 'opacity', 0.75, '::after'],
      [
        '[object DeviceMotionEvent]',
        true,
        true,
        1,
        6,
        7,
        16,
        true,
        true,
        true,
        '[object DeviceMotionEventAcceleration]',
        [],
        '[object DeviceMotionEventRotationRate]',
        [],
        ['isTrusted'],
        ['acceleration', 'accelerationIncludingGravity', 'rotationRate', 'interval', 'constructor'],
        [true, true, 'function', null],
        false,
        false,
        [null, null, null, 0],
        'undefined',
        [
          'TypeError',
          "Failed to construct 'DeviceMotionEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
        ],
        [
          'TypeError',
          "Failed to construct 'DeviceMotionEvent': 1 argument required, but only 0 present.",
        ],
        [
          'TypeError',
          "Failed to construct 'DeviceMotionEvent': Cannot convert a Symbol value to a string",
        ],
        [
          'TypeError',
          "Failed to construct 'DeviceMotionEvent': Failed to read the 'acceleration' property from 'DeviceMotionEventInit': Failed to read the 'x' property from 'DeviceMotionEventAccelerationInit': The provided double value is non-finite.",
        ],
        ['TypeError', 'Illegal invocation'],
      ],
      [
        '[object DeviceOrientationEvent]',
        true,
        true,
        1,
        2,
        3,
        true,
        true,
        true,
        true,
        ['isTrusted'],
        ['alpha', 'beta', 'gamma', 'absolute', 'constructor'],
        [true, true, 'function', null],
        false,
        false,
        [null, null, null, false],
        'undefined',
        [
          'TypeError',
          "Failed to construct 'DeviceOrientationEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
        ],
        [
          'TypeError',
          "Failed to construct 'DeviceOrientationEvent': 1 argument required, but only 0 present.",
        ],
        [
          'TypeError',
          "Failed to construct 'DeviceOrientationEvent': Cannot convert a Symbol value to a string",
        ],
        [
          'TypeError',
          "Failed to construct 'DeviceOrientationEvent': Failed to read the 'alpha' property from 'DeviceOrientationEventInit': The provided double value is non-finite.",
        ],
        ['TypeError', 'Illegal invocation'],
      ],
      [
        '[object SecurityPolicyViolationEvent]',
        'https://a/doc',
        'https://b/script.js',
        'script-src',
        'script-src-elem',
        "script-src 'none'",
        'enforce',
        'app.js',
        200,
        4,
        5,
        'eval',
      ],
      ['[object ErrorEvent]', 'boom', 'app.js', 2, 3, true],
      [
        '[object HashChangeEvent]',
        'https://a/#old',
        'https://a/#new',
        false,
        ['oldURL', 'newURL', 'constructor'],
      ],
      ['[object PopStateEvent]', 2, true, false, ['state', 'hasUAVisualTransition', 'constructor']],
      ['[object PromiseRejectionEvent]', true, 'nope'],
      ['[object PageTransitionEvent]', true, true, true, false, ['persisted', 'constructor']],
      [
        'TypeError',
        "Failed to construct 'BeforeUnloadEvent': Illegal constructor",
        '[object BeforeUnloadEvent]',
        ['returnValue', 'constructor'],
        ['TypeError', 'Illegal invocation'],
      ],
      [
        '[object BeforeInstallPromptEvent]',
        true,
        true,
        true,
        false,
        'web,play',
        'function',
        true,
        true,
        ['isTrusted'],
        ['platforms', 'userChoice', 'prompt', 'constructor'],
      ],
      ['[object MessageEvent]', true, true, 'payload', 'https://origin.example', 'last', true, 0],
      ['[object AnimationPlaybackEvent]', true, true, 1.5, 2.5],
      ['[object BlobEvent]', true, true, true, 'text/plain', 12.5, 'TypeError'],
      ['[object ToggleEvent]', true, true, 'closed', 'open', true],
      ['[object CommandEvent]', true, true, 'show-modal', true],
      ['[object ContentVisibilityAutoStateChangeEvent]', true, true, true],
      [
        '[object FontFaceSetLoadEvent]',
        true,
        true,
        true,
        true,
        true,
        1,
        true,
        false,
        ['fontfaces', 'constructor'],
      ],
      [
        '[object GamepadEvent]',
        true,
        true,
        null,
        true,
        true,
        true,
        ['isTrusted'],
        ['gamepad', 'constructor'],
        [true, true, 'function', null],
        false,
        false,
        [
          'TypeError',
          "Failed to construct 'GamepadEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
        ],
        [
          'TypeError',
          "Failed to construct 'GamepadEvent': 1 argument required, but only 0 present.",
        ],
        [
          'TypeError',
          "Failed to construct 'GamepadEvent': Cannot convert a Symbol value to a string",
        ],
        [
          'TypeError',
          "Failed to construct 'GamepadEvent': Failed to read the 'gamepad' property from 'GamepadEventInit': Failed to convert value to 'Gamepad'.",
        ],
        ['TypeError', 'Illegal invocation'],
      ],
      ['[object PictureInPictureEvent]', true, true, null],
      ['[object DocumentPictureInPictureEvent]', true, true, true],
      [
        [
          'StorageEvent',
          1,
          ['key', 'oldValue', 'newValue', 'url', 'storageArea', 'initStorageEvent', 'constructor'],
          true,
          false,
          ['key', 'oldValue', 'newValue', 'url', 'storageArea', 'initStorageEvent', 'constructor'],
        ],
        [
          'ProgressEvent',
          1,
          ['lengthComputable', 'loaded', 'total', 'constructor'],
          true,
          false,
          ['lengthComputable', 'loaded', 'total', 'constructor'],
        ],
        [
          'SecurityPolicyViolationEvent',
          1,
          [
            'documentURI',
            'referrer',
            'blockedURI',
            'violatedDirective',
            'effectiveDirective',
            'originalPolicy',
            'disposition',
            'sourceFile',
            'statusCode',
            'lineNumber',
            'columnNumber',
            'sample',
            'constructor',
          ],
          true,
          false,
          [
            'documentURI',
            'referrer',
            'blockedURI',
            'violatedDirective',
            'effectiveDirective',
            'originalPolicy',
            'disposition',
            'sourceFile',
            'statusCode',
            'lineNumber',
            'columnNumber',
            'sample',
            'constructor',
          ],
        ],
        [
          'ErrorEvent',
          1,
          ['message', 'filename', 'lineno', 'colno', 'error', 'constructor'],
          true,
          false,
          ['message', 'filename', 'lineno', 'colno', 'error', 'constructor'],
        ],
        [
          'PromiseRejectionEvent',
          2,
          ['promise', 'reason', 'constructor'],
          true,
          false,
          ['promise', 'reason', 'constructor'],
        ],
        ['SubmitEvent', 1, ['submitter', 'constructor'], true, false, ['submitter', 'constructor']],
        ['FormDataEvent', 2, ['formData', 'constructor'], true, false, ['formData', 'constructor']],
        [
          'MessageEvent',
          1,
          [
            'data',
            'origin',
            'lastEventId',
            'source',
            'ports',
            'userActivation',
            'initMessageEvent',
            'constructor',
          ],
          true,
          false,
          [
            'data',
            'origin',
            'lastEventId',
            'source',
            'ports',
            'userActivation',
            'initMessageEvent',
            'constructor',
          ],
        ],
        [
          'AnimationPlaybackEvent',
          1,
          ['currentTime', 'timelineTime', 'constructor'],
          true,
          false,
          ['currentTime', 'timelineTime', 'constructor'],
        ],
        [
          'BlobEvent',
          2,
          ['data', 'timecode', 'constructor'],
          true,
          false,
          ['data', 'timecode', 'constructor'],
        ],
        [
          'ToggleEvent',
          1,
          ['oldState', 'newState', 'source', 'constructor'],
          true,
          false,
          ['oldState', 'newState', 'source', 'constructor'],
        ],
        [
          'CommandEvent',
          1,
          ['source', 'command', 'constructor'],
          true,
          false,
          ['source', 'command', 'constructor'],
        ],
        [
          'ContentVisibilityAutoStateChangeEvent',
          1,
          ['skipped', 'constructor'],
          true,
          false,
          ['skipped', 'constructor'],
        ],
      ],
      [
        'TypeError',
        'TypeError',
        'TypeError',
        'TypeError',
        'TypeError',
        'TypeError',
        'TypeError',
        true,
        true,
      ],
    ],
  });
  assert.deepEqual(Object.fromEntries(storageSnapshot.localStorage), { preloaded: 'old', k: 'v' });
  assert.deepEqual(Object.fromEntries(storageSnapshot.sessionStorage), { s: 't' });
  assert.deepEqual(JSON.parse(realm.evalClassic('storageEstimateResult')), {
    usagePositive: true,
    quotaPositive: true,
    beforePersisted: false,
    afterPersisted: true,
    persistResult: true,
    uaEntropy: [
      'ZeroProxy',
      false,
      'UnitOS',
      '',
      '1',
      '1',
      true,
      true,
      false,
      [
        'TypeError',
        "Failed to execute 'getHighEntropyValues' on 'NavigatorUAData': 1 argument required, but only 0 present.",
      ],
      [
        'TypeError',
        "Failed to execute 'getHighEntropyValues' on 'NavigatorUAData': The provided value cannot be converted to a sequence.",
      ],
      [
        'TypeError',
        "Failed to execute 'getHighEntropyValues' on 'NavigatorUAData': The provided value cannot be converted to a sequence.",
      ],
      [
        'TypeError',
        "Failed to execute 'getHighEntropyValues' on 'NavigatorUAData': Cannot convert a Symbol value to a string",
      ],
    ],
    devicePermissions: ['undefined', 'undefined'],
    geolocation: [
      [
        '[object GeolocationPositionError]',
        true,
        1,
        'User denied Geolocation',
        1,
        1,
        [],
        [true, true, 'function', null],
      ],
      'number',
      0,
    ],
    locks: [
      [
        ['held', '[object Lock]', true, 'resource', 'exclusive'],
        ['ifAvailable', null],
        ['query-held', [['resource', 'exclusive']], 0],
      ],
      'done',
      ['resource', 'shared'],
      'cancel-lock',
    ],
    keyboard: [
      '[object KeyboardLayoutMap]',
      true,
      false,
      [],
      ['size', 'entries', 'forEach', 'get', 'has', 'keys', 'values', 'constructor'],
      0,
      null,
      false,
      0,
      0,
      [
        'TypeError',
        "Failed to execute 'forEach' on 'KeyboardLayoutMap': parameter 1 is not of type 'Function'.",
      ],
      false,
      true,
    ],
    wakeLock: [
      '[object WakeLockSentinel]',
      true,
      true,
      false,
      [],
      ['onrelease', 'released', 'type', 'release', 'constructor'],
      'screen',
      true,
      ['listener', 'handler'],
      'TypeError',
    ],
    credentials: [
      null,
      null,
      [
        'TypeError',
        "Failed to execute 'store' on 'CredentialsContainer': parameter 1 is not of type 'Credential'.",
      ],
      true,
    ],
    payment: [false, false, true, 'NotAllowedError'],
    contacts: [['name', 'email', 'tel', 'address', 'icon'], true, 'NotAllowedError'],
    mediaCapabilities: [
      false,
      false,
      false,
      null,
      [
        'TypeError',
        "Failed to execute 'encodingInfo' on 'MediaCapabilities': Failed to read the 'type' property from 'MediaEncodingConfiguration': The provided value 'record' is not a valid enum value of type MediaEncodingType.",
      ],
    ],
    share: [false, 'NotAllowedError'],
    notification: ['denied', 'denied'],
    beforeInstallPrompt: [
      [
        'InvalidStateError',
        "Failed to execute 'prompt' on 'BeforeInstallPromptEvent': The prompt() method cannot be called.",
      ],
      [
        'InvalidStateError',
        "Failed to read the 'userChoice' property from 'BeforeInstallPromptEvent': userChoice cannot be accessed on this event.",
      ],
      false,
    ],
    captureTargets: ['InvalidStateError', 'InvalidStateError'],
    reporting: [true, 0, true, 0],
    crashReport: [true, true, true, 'QuotaExceededError'],
    pictureInPicture: [1, [false], true, 'NotAllowedError', 'NotAllowedError', 'InvalidStateError'],
    messageChannel: [
      '[object MessageChannel]',
      true,
      true,
      '[object MessagePort]',
      '[object MessageEvent]',
      true,
      3,
      true,
      0,
    ],
    broadcastChannel: [
      '[object BroadcastChannel]',
      true,
      'zp-test',
      '[object MessageEvent]',
      true,
      8,
      true,
      'https://target.example',
    ],
  });
  assert.equal(calls[0].url, 'https://target.example/beacon');
  assert.equal(calls[0].method, 'POST');
  realm.destroy();
});

test('webapi core exposes browser-shaped common event payload descriptors', async () => {
  const { realm } = await installCore();
  const result = JSON.parse(
    realm.evalClassic(`
      JSON.stringify((() => {
        const button = document.createElement('button');
        const dataTransfer = new DataTransfer();
        const targetRange = new StaticRange({ startContainer: document.body, startOffset: 0, endContainer: document.body, endOffset: 0 });
        const touch = new Touch({ identifier: 7, target: button, clientX: 11, clientY: 12 });
        const shape = (Ctor, event, keys, protoNames) => [
          Ctor.name,
          Ctor.length,
          Object.getOwnPropertyNames(Ctor.prototype),
          keys.every((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, key);
            return descriptor?.enumerable === true && descriptor?.configurable === true && typeof descriptor.get === 'function' && descriptor.set === undefined;
          }),
          keys.some((key) => Object.prototype.hasOwnProperty.call(event, key)),
          protoNames,
        ];
        return {
          payloads: [
            shape(CustomEvent, new CustomEvent('x', { detail: 1 }), ['detail'], ['detail', 'initCustomEvent', 'constructor']),
            shape(UIEvent, new UIEvent('x', { detail: 2, view: window }), ['view', 'detail', 'sourceCapabilities', 'which'], ['view', 'detail', 'sourceCapabilities', 'which', 'initUIEvent', 'constructor']),
            shape(MouseEvent, new MouseEvent('x', { clientX: 3, clientY: 4, button: 1, relatedTarget: button }), ['screenX', 'screenY', 'clientX', 'clientY', 'ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'button', 'buttons', 'relatedTarget', 'pageX', 'pageY', 'x', 'y', 'offsetX', 'offsetY', 'movementX', 'movementY', 'fromElement', 'toElement', 'layerX', 'layerY'], ['screenX', 'screenY', 'clientX', 'clientY', 'ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'button', 'buttons', 'relatedTarget', 'pageX', 'pageY', 'x', 'y', 'offsetX', 'offsetY', 'movementX', 'movementY', 'fromElement', 'toElement', 'layerX', 'layerY', 'getModifierState', 'initMouseEvent', 'constructor']),
            shape(FocusEvent, new FocusEvent('x', { relatedTarget: button }), ['relatedTarget'], ['relatedTarget', 'constructor']),
            shape(KeyboardEvent, new KeyboardEvent('x', { key: 'A', code: 'KeyA', location: 1 }), ['key', 'code', 'location', 'ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'repeat', 'isComposing', 'charCode', 'keyCode'], ['key', 'code', 'location', 'ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'repeat', 'isComposing', 'charCode', 'keyCode', 'DOM_KEY_LOCATION_STANDARD', 'DOM_KEY_LOCATION_LEFT', 'DOM_KEY_LOCATION_RIGHT', 'DOM_KEY_LOCATION_NUMPAD', 'getModifierState', 'initKeyboardEvent', 'constructor']),
            shape(InputEvent, new InputEvent('input', { data: 'x', inputType: 'insertText', targetRanges: [targetRange] }), ['data', 'isComposing', 'inputType', 'dataTransfer'], ['data', 'isComposing', 'inputType', 'dataTransfer', 'getTargetRanges', 'constructor']),
            shape(CompositionEvent, new CompositionEvent('x', { data: '한' }), ['data'], ['data', 'initCompositionEvent', 'constructor']),
            shape(ClipboardEvent, new ClipboardEvent('paste', { clipboardData: dataTransfer }), ['clipboardData'], ['clipboardData', 'constructor']),
            shape(DragEvent, new DragEvent('drop', { dataTransfer }), ['dataTransfer'], ['dataTransfer', 'constructor']),
            shape(WheelEvent, new WheelEvent('wheel', { deltaX: 1, deltaY: -2, deltaMode: WheelEvent.DOM_DELTA_LINE }), ['deltaX', 'deltaY', 'deltaZ', 'deltaMode', 'wheelDeltaX', 'wheelDeltaY', 'wheelDelta'], ['deltaX', 'deltaY', 'deltaZ', 'deltaMode', 'wheelDeltaX', 'wheelDeltaY', 'wheelDelta', 'DOM_DELTA_PIXEL', 'DOM_DELTA_LINE', 'DOM_DELTA_PAGE', 'constructor']),
            shape(PointerEvent, new PointerEvent('pointerdown', { pointerId: 9, pointerType: 'pen' }), ['pointerId', 'width', 'height', 'pressure', 'tiltX', 'tiltY', 'azimuthAngle', 'altitudeAngle', 'tangentialPressure', 'twist', 'pointerType', 'isPrimary', 'persistentDeviceId'], ['pointerId', 'width', 'height', 'pressure', 'tiltX', 'tiltY', 'azimuthAngle', 'altitudeAngle', 'tangentialPressure', 'twist', 'pointerType', 'isPrimary', 'getPredictedEvents', 'persistentDeviceId', 'constructor']),
            shape(Touch, touch, ['identifier', 'target', 'screenX', 'screenY', 'clientX', 'clientY', 'pageX', 'pageY', 'radiusX', 'radiusY', 'rotationAngle', 'force'], ['identifier', 'target', 'screenX', 'screenY', 'clientX', 'clientY', 'pageX', 'pageY', 'radiusX', 'radiusY', 'rotationAngle', 'force', 'constructor']),
            shape(TouchEvent, new TouchEvent('touchstart', { touches: [touch], targetTouches: [touch], changedTouches: [touch], ctrlKey: true }), ['touches', 'targetTouches', 'changedTouches', 'altKey', 'metaKey', 'ctrlKey', 'shiftKey'], ['touches', 'targetTouches', 'changedTouches', 'altKey', 'metaKey', 'ctrlKey', 'shiftKey', 'constructor']),
            shape(AnimationEvent, new AnimationEvent('animationend', { animationName: 'fade' }), ['animationName', 'elapsedTime', 'pseudoElement'], ['animationName', 'elapsedTime', 'pseudoElement', 'constructor']),
            shape(TransitionEvent, new TransitionEvent('transitionend', { propertyName: 'opacity' }), ['propertyName', 'elapsedTime', 'pseudoElement'], ['propertyName', 'elapsedTime', 'pseudoElement', 'constructor']),
          ],
          values: [
            new UIEvent('x').view,
            new MouseEvent('x', { button: 1, clientX: 3 }).which,
            new MouseEvent('x', { button: 1, clientX: 3 }).pageX,
            new PointerEvent('x').altitudeAngle,
            'getCoalescedEvents' in new PointerEvent('x'),
            new InputEvent('input', { targetRanges: [targetRange] }).getTargetRanges()[0] === targetRange,
            Object.prototype.hasOwnProperty.call(new TouchEvent('touchstart', { touches: [touch] }).touches, 'length'),
            Object.getOwnPropertyNames(new TouchEvent('touchstart', { touches: [touch] }).touches),
          ],
        };
      })())
    `),
  );
  assert.equal(
    result.payloads.every((entry) => entry[3] === true && entry[4] === false),
    true,
  );
  for (const entry of result.payloads) assert.deepEqual(entry[2], entry[5], entry[0]);
  assert.deepEqual(result.values, [null, 2, 3, Math.PI / 2, false, true, false, ['0']]);
  realm.destroy();
});
test('webapi core exposes CustomElementRegistry basics', async () => {
  const { realm } = await installCore();
  realm.evalClassic(`
    globalThis.customElementRegistryResult = '';
    (async () => {
      class ZpWidget extends HTMLElement {}
      const before = customElements.get('zp-widget');
      const pending = customElements.whenDefined('zp-later');
      customElements.define('zp-widget', ZpWidget);
      class ZpLater extends HTMLElement {}
      customElements.define('zp-later', ZpLater, { extends: 'button' });
      const resolved = await pending;
      let duplicateName;
      try {
        customElements.define('zp-widget', class extends HTMLElement {});
        duplicateName = 'ok';
      } catch (error) {
        duplicateName = error.name;
      }
      let duplicateCtor;
      try {
        customElements.define('zp-other', ZpWidget);
        duplicateCtor = 'ok';
      } catch (error) {
        duplicateCtor = error.name;
      }
      let invalidName;
      try {
        customElements.define('notvalid', class extends HTMLElement {});
        invalidName = 'ok';
      } catch (error) {
        invalidName = error.name;
      }
      let newRegistry;
      try {
        new CustomElementRegistry();
        newRegistry = ['ok'];
      } catch (error) {
        newRegistry = [error.name, error.message];
      }
      customElements.upgrade(document.createElement('zp-widget'));
      const internalsHost = document.createElement('zp-widget');
      const internals = internalsHost.attachInternals();
      const sameInternals = internalsHost.attachInternals() === internals;
      internals.states.add('ready');
      internals.role = 'button';
      internals.ariaLabel = 'Virtual widget';
      internals.setFormValue('payload');
      internals.setValidity({ customError: true }, 'bad widget');
      let newInternals;
      try {
        new ElementInternals();
        newInternals = ['ok'];
      } catch (error) {
        newInternals = [error.name, error.message];
      }
      let newCustomStateSet;
      try {
        new CustomStateSet();
        newCustomStateSet = ['ok'];
      } catch (error) {
        newCustomStateSet = [error.name, error.message];
      }
      globalThis.customElementRegistryResult = JSON.stringify([
        Object.prototype.toString.call(customElements),
        customElements instanceof CustomElementRegistry,
        typeof CustomElementRegistry,
        before,
        customElements.get('zp-widget') === ZpWidget,
        customElements.get('zp-later') === ZpLater,
        customElements.getName(ZpWidget),
        customElements.getName(ZpLater),
        resolved === ZpLater,
        duplicateName,
        duplicateCtor,
        invalidName,
        newRegistry,
        [
          Object.prototype.toString.call(internals),
          internals instanceof ElementInternals,
          sameInternals,
          Object.prototype.toString.call(internals.states),
          internals.states instanceof CustomStateSet,
          internals.states.has('ready'),
          internals.role,
          internals.ariaLabel,
          internals.validationMessage,
          internals.form,
          internals.labels,
          newInternals,
          newCustomStateSet,
        ],
      ]);
    })().catch((error) => {
      globalThis.customElementRegistryResult = JSON.stringify(['THREW', error.name, error.message]);
    });
  `);
  for (let i = 0; i < 20; i++) realm.drainJobs();
  assert.deepEqual(JSON.parse(realm.evalClassic('customElementRegistryResult')), [
    '[object CustomElementRegistry]',
    true,
    'function',
    null,
    true,
    true,
    'zp-widget',
    'zp-later',
    true,
    'NotSupportedError',
    'NotSupportedError',
    'SyntaxError',
    ['TypeError', "Failed to construct 'CustomElementRegistry': Illegal constructor"],
    [
      '[object ElementInternals]',
      true,
      true,
      '[object CustomStateSet]',
      true,
      true,
      'button',
      'Virtual widget',
      'bad widget',
      null,
      null,
      ['TypeError', "Failed to construct 'ElementInternals': Illegal constructor"],
      ['TypeError', "Failed to construct 'CustomStateSet': Illegal constructor"],
    ],
  ]);
  realm.destroy();
});

test('webapi core exposes basic Web Streams facades', async () => {
  const { realm } = await installCore();
  realm.evalClassic(`
    globalThis.streamFacadeResult = '';
    (async () => {
      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue('a');
          controller.close();
        },
      });
      const reader = readable.getReader();
      const first = await reader.read();
      const second = await reader.read();
      reader.releaseLock();
      const writes = [];
      const writable = new WritableStream({
        write(chunk) { writes.push(chunk); },
        close() { writes.push('closed'); },
      });
      const writer = writable.getWriter();
      await writer.write('x');
      await writer.close();
      writer.releaseLock();
      const transform = new TransformStream({
        transform(chunk, controller) { controller.enqueue(chunk + '!'); },
      });
      const transformWriter = transform.writable.getWriter();
      const transformReader = transform.readable.getReader();
      await transformWriter.write('go');
      await transformWriter.close();
      const transformed = await transformReader.read();
      const byteReader = new ReadableStream({
        type: 'bytes',
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.close();
        },
      }).getReader({ mode: 'byob' });
      const view = new Uint8Array(2);
      const byob = await byteReader.read(view);
      const compression = new CompressionStream('gzip');
      const iterated = [];
      for await (const chunk of new ReadableStream({
        start(controller) {
          controller.enqueue('iter');
          controller.close();
        },
      })) iterated.push(chunk);
      const encoderStream = new TextEncoderStream();
      const encoderStreamWriter = encoderStream.writable.getWriter();
      const encoderStreamReader = encoderStream.readable.getReader();
      await encoderStreamWriter.write('é');
      await encoderStreamWriter.close();
      const encodedStreamChunk = await encoderStreamReader.read();
      const encodedStreamDone = await encoderStreamReader.read();
      const decoderStream = new TextDecoderStream();
      const decoderStreamWriter = decoderStream.writable.getWriter();
      const decoderStreamReader = decoderStream.readable.getReader();
      await decoderStreamWriter.write(new Uint8Array([0xe2, 0x82]));
      await decoderStreamWriter.write(new Uint8Array([0xac]));
      await decoderStreamWriter.close();
      const decodedStreamChunk = await decoderStreamReader.read();
      const decodedStreamDone = await decoderStreamReader.read();
      const decoderStreamLabelError = (() => {
        try { new TextDecoderStream('bad-encoding'); return ['ok']; } catch (error) { return [error.name, error.message]; }
      })();
      globalThis.streamFacadeResult = JSON.stringify({
        readable: [
          Object.prototype.toString.call(readable),
          readable instanceof ReadableStream,
          Object.prototype.toString.call(reader),
          reader instanceof ReadableStreamDefaultReader,
          readable.locked,
          first,
          second,
          readable.locked,
        ],
        writable: [
          Object.prototype.toString.call(writable),
          writable instanceof WritableStream,
          Object.prototype.toString.call(writer),
          writer instanceof WritableStreamDefaultWriter,
          writable.locked,
          writes,
          writable.locked,
        ],
        transform: [
          Object.prototype.toString.call(transform),
          transform instanceof TransformStream,
          transform.readable instanceof ReadableStream,
          transform.writable instanceof WritableStream,
          transformed,
          Object.getOwnPropertyNames(transform),
        ],
        byob: [
          Object.prototype.toString.call(byteReader),
          byteReader instanceof ReadableStreamBYOBReader,
          byob.value === view,
          Array.from(view),
        ],
        endpoints: [
          compression.readable instanceof ReadableStream,
          compression.writable instanceof WritableStream,
          encoderStream.readable instanceof ReadableStream,
          encoderStream.writable instanceof WritableStream,
          Object.getOwnPropertyNames(encoderStream),
          Object.getOwnPropertyNames(TextEncoderStream.prototype),
          Object.getOwnPropertyNames(decoderStream),
          Object.getOwnPropertyNames(TextDecoderStream.prototype),
        ],
        descriptors: [
          iterated,
          Object.getOwnPropertyNames(ReadableStream.prototype).sort(),
          [
            Object.getOwnPropertyDescriptor(ReadableStream.prototype, 'values').value.name,
            Object.getOwnPropertyDescriptor(ReadableStream.prototype, 'values').value.length,
            Object.getOwnPropertyDescriptor(ReadableStream.prototype, 'values').enumerable,
            Object.getOwnPropertyDescriptor(ReadableStream.prototype, Symbol.asyncIterator).value === Object.getOwnPropertyDescriptor(ReadableStream.prototype, 'values').value,
          ],
          [
            Object.getOwnPropertyDescriptor(WritableStreamDefaultWriter.prototype, 'write').value.name,
            Object.getOwnPropertyDescriptor(WritableStreamDefaultWriter.prototype, 'write').value.length,
            Object.getOwnPropertyDescriptor(WritableStreamDefaultWriter.prototype, 'write').enumerable,
          ],
          Object.getOwnPropertyNames(transform),
          Object.getOwnPropertyNames(TransformStream.prototype).sort(),
          Object.getOwnPropertyNames(compression),
          Object.getOwnPropertyNames(CompressionStream.prototype).sort(),
        ],
        textTransforms: [
          Array.from(encodedStreamChunk.value),
          encodedStreamChunk.done,
          encodedStreamDone.done,
          decodedStreamChunk.value,
          decodedStreamChunk.done,
          decodedStreamDone.done,
          decoderStreamLabelError,
        ],
        constructors: [
          typeof ReadableByteStreamController,
          (() => { try { new ReadableStreamDefaultController(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new WritableStreamDefaultController(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new TransformStreamDefaultController(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          (() => { try { new ReadableStreamBYOBRequest(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        ],
      });
    })().catch((error) => {
      globalThis.streamFacadeResult = JSON.stringify({ __error: [error.name, error.message, error.stack] });
    });
  `);
  for (let i = 0; i < 20; i++) realm.drainJobs();
  assert.deepEqual(JSON.parse(realm.evalClassic('streamFacadeResult')), {
    readable: [
      '[object ReadableStream]',
      true,
      '[object ReadableStreamDefaultReader]',
      true,
      false,
      { value: 'a', done: false },
      { done: true },
      false,
    ],
    writable: [
      '[object WritableStream]',
      true,
      '[object WritableStreamDefaultWriter]',
      true,
      false,
      ['x', 'closed'],
      false,
    ],
    transform: ['[object TransformStream]', true, true, true, { value: 'go!', done: false }, []],
    byob: ['[object ReadableStreamBYOBReader]', true, true, [1, 2]],
    endpoints: [
      true,
      true,
      true,
      true,
      [],
      ['encoding', 'readable', 'writable', 'constructor'],
      [],
      ['encoding', 'fatal', 'ignoreBOM', 'readable', 'writable', 'constructor'],
    ],
    descriptors: [
      ['iter'],
      ['cancel', 'constructor', 'getReader', 'locked', 'pipeThrough', 'pipeTo', 'tee', 'values'],
      ['values', 0, true, true],
      ['write', 0, true],
      [],
      ['constructor', 'readable', 'writable'],
      [],
      ['constructor', 'readable', 'writable'],
    ],
    textTransforms: [
      [195, 169],
      false,
      true,
      '€',
      false,
      true,
      [
        'RangeError',
        "Failed to construct 'TextDecoderStream': The encoding label provided ('bad-encoding') is invalid.",
      ],
    ],
    constructors: [
      'function',
      ['TypeError', "Failed to construct 'ReadableStreamDefaultController': Illegal constructor"],
      ['TypeError', "Failed to construct 'WritableStreamDefaultController': Illegal constructor"],
      ['TypeError', "Failed to construct 'TransformStreamDefaultController': Illegal constructor"],
      ['TypeError', "Failed to construct 'ReadableStreamBYOBRequest': Illegal constructor"],
    ],
  });
  realm.destroy();
});

test('webapi core exposes virtual launch queue params', async () => {
  const { realm } = await installCore({
    config: { launchParams: { targetURL: 'https://target.example/app/?launched=1', files: [] } },
  });
  realm.evalClassic(`
    globalThis.launchQueueResult = '';
    launchQueue.setConsumer((params) => {
      launchQueueResult = JSON.stringify([
        Object.prototype.toString.call(params),
        params instanceof LaunchParams,
        Object.isFrozen(params),
        Object.getOwnPropertyNames(params),
        Object.getOwnPropertyNames(LaunchParams.prototype),
        params.targetURL,
        params.files.length,
        Object.isFrozen(params.files),
      ]);
    });
  `);
  for (let i = 0; i < 5; i += 1) realm.drainJobs();
  assert.deepEqual(JSON.parse(realm.evalClassic('launchQueueResult')), [
    '[object LaunchParams]',
    true,
    false,
    [],
    ['targetURL', 'files', 'constructor'],
    'https://target.example/app/?launched=1',
    0,
    true,
  ]);
  realm.destroy();
});

test('webapi core enforces virtual storage quota and persistence grant', async () => {
  const { realm } = await installCore({ config: { storageQuota: 2048 } });
  realm.evalClassic(`
    globalThis.storageQuotaResult = '';
    (async () => {
      localStorage.setItem('small', 'ok');
      let quotaError = '';
      try {
        localStorage.setItem('large', 'x'.repeat(10000));
      } catch (error) {
        quotaError = error.name;
      }
      const cache = await caches.open('quota');
      let cacheError = '';
      try {
        await cache.put('/large-cache', new Response('y'.repeat(10000)));
      } catch (error) {
        cacheError = error.name;
      }
      const idbQuota = await new Promise((resolve) => {
        const open = indexedDB.open('quota-idb', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('items', { keyPath: 'id' });
        open.onerror = () => resolve({ openError: open.error && open.error.name });
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('items', 'readwrite');
          const store = tx.objectStore('items');
          const put = store.put({ id: 'large', body: 'z'.repeat(10000) });
          put.onsuccess = () => resolve({ error: '', missing: false });
          put.onerror = () => {
            const error = put.error && put.error.name;
            const get = store.get('large');
            get.onsuccess = () => resolve({ error, missing: get.result === undefined });
            get.onerror = () => resolve({ error, missing: false, getError: get.error && get.error.name });
          };
        };
      });
      const beforePersisted = await navigator.storage.persisted();
      const persistResult = await navigator.storage.persist();
      const afterPersisted = await navigator.storage.persisted();
      const estimate = await navigator.storage.estimate();
      globalThis.storageQuotaResult = JSON.stringify({
        small: localStorage.getItem('small'),
        large: localStorage.getItem('large'),
        quotaError,
        cacheError,
        cacheMiss: await caches.match('/large-cache') === undefined,
        idbQuota,
        beforePersisted,
        afterPersisted,
        persistResult,
        quota: estimate.quota,
        usageUnderQuota: estimate.usage <= estimate.quota,
      });
    })();
  `);
  for (let i = 0; i < 6; i++) realm.drainJobs();
  assert.deepEqual(JSON.parse(realm.evalClassic('storageQuotaResult')), {
    small: 'ok',
    large: null,
    quotaError: 'QuotaExceededError',
    cacheError: 'QuotaExceededError',
    cacheMiss: true,
    idbQuota: { error: 'QuotaExceededError', missing: true },
    beforePersisted: false,
    afterPersisted: true,
    persistResult: true,
    quota: 2048,
    usageUnderQuota: true,
  });
  realm.destroy();
});

test('webapi core History and Location enforce same-origin browser shape', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    const out = [];
    function record(label, fn) {
      try {
        out.push([label, 'ok', fn()]);
      } catch (error) {
        out.push([label, 'throw', error.name, error.message]);
      }
    }
    const events = [];
    addEventListener('popstate', (event) => events.push(event.state));
    record('initial', () => [Object.prototype.toString.call(history), Object.prototype.toString.call(location), history.length, history.state, location.origin, location.pathname, typeof History, history instanceof History, typeof Location, location instanceof Location, (() => { try { new History(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(), (() => { try { new Location(); return ['ok']; } catch (error) { return [error.name, error.message]; } })()]);
    const state = { step: 1, nested: { value: 1 } };
    record('push', () => {
      history.pushState(state, '', '/hist?q=1#x');
      state.nested.value = 9;
      const firstState = history.state;
      firstState.nested.value = 7;
      return [location.href, location.pathname, location.search, location.hash, history.length, history.state.nested.value];
    });
    record('replace', () => {
      history.replaceState({ step: 2 }, '', '?q=2#y');
      return [location.href, history.length, history.state.step];
    });
    record('cross-origin', () => history.pushState({}, '', 'https://example.invalid/x'));
    record('missing-args', () => history.pushState({}));
    record('back', () => {
      history.back();
      return [location.href, history.state, events.length, events[0]];
    });
    record('navigation-api', () => {
      const seen = [];
      navigation.addEventListener('navigate', (event) => seen.push([
        Object.prototype.toString.call(event),
        event instanceof NavigateEvent,
        event.navigationType,
        Object.prototype.toString.call(event.destination),
        event.destination instanceof NavigationDestination,
        event.destination.url,
        event.destination.getState().step,
        event.canIntercept,
        event.info,
      ]));
      const result = navigation.navigate('/nav-api#z', { state: { step: 3 }, info: 'payload' });
      const entry = navigation.currentEntry;
      const changed = new NavigationCurrentEntryChangeEvent('currententrychange', { navigationType: 'push', from: entry });
      return [
        Object.prototype.toString.call(navigation),
        navigation instanceof Navigation,
        navigation.currentEntry instanceof NavigationHistoryEntry,
        Object.prototype.toString.call(entry),
        entry.url,
        entry.getState().step,
        navigation.entries().length,
        navigation.canGoBack,
        navigation.canGoForward,
        Object.prototype.toString.call(result.committed),
        Object.prototype.toString.call(changed),
        changed instanceof NavigationCurrentEntryChangeEvent,
        changed.from === entry,
        seen[0],
        (() => { try { new Navigation(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new NavigationHistoryEntry(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new NavigationDestination(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new NavigationTransition(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new NavigationActivation(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new NavigationPrecommitController(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ];
    });
    JSON.stringify(out);
  `);
  assert.deepEqual(
    JSON.parse(result).map((entry) => entry.slice(0, 3)),
    [
      [
        'initial',
        'ok',
        [
          '[object History]',
          '[object Location]',
          1,
          null,
          'https://target.example',
          '/app/page.html',
          'function',
          true,
          'function',
          true,
          ['TypeError', "Failed to construct 'History': Illegal constructor"],
          ['TypeError', "Failed to construct 'Location': Illegal constructor"],
        ],
      ],
      ['push', 'ok', ['https://target.example/hist?q=1#x', '/hist', '?q=1', '#x', 2, 1]],
      ['replace', 'ok', ['https://target.example/hist?q=2#y', 2, 2]],
      ['cross-origin', 'throw', 'SecurityError'],
      ['missing-args', 'throw', 'TypeError'],
      ['back', 'ok', ['https://target.example/app/page.html', null, 1, null]],
      [
        'navigation-api',
        'ok',
        [
          '[object Navigation]',
          true,
          true,
          '[object NavigationHistoryEntry]',
          'https://target.example/nav-api#z',
          3,
          2,
          true,
          false,
          '[object Promise]',
          '[object NavigationCurrentEntryChangeEvent]',
          true,
          true,
          [
            '[object NavigateEvent]',
            true,
            'push',
            '[object NavigationDestination]',
            true,
            'https://target.example/nav-api#z',
            3,
            true,
            'payload',
          ],
          ['TypeError', "Failed to construct 'Navigation': Illegal constructor"],
          ['TypeError', "Failed to construct 'NavigationHistoryEntry': Illegal constructor"],
          ['TypeError', "Failed to construct 'NavigationDestination': Illegal constructor"],
          ['TypeError', "Failed to construct 'NavigationTransition': Illegal constructor"],
          ['TypeError', "Failed to construct 'NavigationActivation': Illegal constructor"],
          ['TypeError', "Failed to construct 'NavigationPrecommitController': Illegal constructor"],
        ],
      ],
    ],
  );
  realm.destroy();
});

test('webapi core exposes virtual Fullscreen state', async () => {
  const { realm } = await installCore();
  realm.evalClassic(`
    globalThis.fullscreenResult = '';
    (async () => {
      const target = document.createElement('div');
      const events = [];
      target.addEventListener('fullscreenchange', (event) => events.push(['target', event.type, document.fullscreenElement === target]));
      document.addEventListener('fullscreenchange', (event) => events.push(['document', event.type, document.fullscreenElement === target]));
      await target.requestFullscreen({ navigationUI: 'hide' });
      const afterRequest = [
        document.fullscreenEnabled,
        document.fullscreenElement === target,
        target.__zpFullscreenOptions.navigationUI,
      ];
      await document.exitFullscreen();
      fullscreenResult = JSON.stringify({
        afterRequest,
        afterExit: document.fullscreenElement,
        events,
      });
    })();
  `);
  for (let i = 0; i < 6; i++) realm.drainJobs();
  assert.deepEqual(JSON.parse(realm.evalClassic('fullscreenResult')), {
    afterRequest: [true, true, 'hide'],
    afterExit: null,
    events: [
      ['target', 'fullscreenchange', true],
      ['document', 'fullscreenchange', true],
      ['target', 'fullscreenchange', false],
      ['document', 'fullscreenchange', false],
    ],
  });
  realm.destroy();
});

test('webapi core exposes virtual ViewTransition facades', async () => {
  const { realm } = await installCore();
  realm.evalClassic(`
    globalThis.viewTransitionResult = '';
    const updates = [];
    const transition = document.startViewTransition({
      update: () => { updates.push('update'); },
      types: ['root', 'modal'],
    });
    transition.types.add('card');
    transition.types.delete('modal');
    Promise.all([transition.updateCallbackDone, transition.ready, transition.finished]).then(() => {
      globalThis.viewTransitionResult = JSON.stringify([
        Object.prototype.toString.call(transition),
        transition instanceof ViewTransition,
        Object.prototype.toString.call(transition.types),
        transition.types instanceof ViewTransitionTypeSet,
        transition.types.size,
        transition.types.has('root'),
        transition.types.has('modal'),
        Array.from(transition.types).join('|'),
        updates.join('|'),
        transition.skipTransition(),
        Object.prototype.toString.call(transition.finished),
        (() => { try { new ViewTransition(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new ViewTransitionTypeSet(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ]);
    });
  `);
  for (let i = 0; i < 8; i++) realm.drainJobs();
  assert.deepEqual(JSON.parse(realm.evalClassic('viewTransitionResult')), [
    '[object ViewTransition]',
    true,
    '[object ViewTransitionTypeSet]',
    true,
    2,
    true,
    false,
    'root|card',
    'update',
    null,
    '[object Promise]',
    ['TypeError', "Failed to construct 'ViewTransition': Illegal constructor"],
    ['TypeError', "Failed to construct 'ViewTransitionTypeSet': Illegal constructor"],
  ]);
  realm.destroy();
});
test('webapi core exposes browser-like Permissions query facade', async () => {
  const { realm } = await installCore({
    config: {
      permissions: { geolocation: 'denied', 'clipboard-write': 'granted', camera: 'invalid-state' },
    },
  });
  realm.evalClassic(`
    globalThis.permissionsResult = null;
    (async () => {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      const clipboardStatus = await navigator.permissions.query({ name: 'clipboard-write' });
      const cameraStatus = await navigator.permissions.query({ name: 'camera' });
      let bad;
      try {
        await navigator.permissions.query({ name: 'not-a-permission' });
        bad = ['ok'];
      } catch (error) {
        bad = [error.name, error.message];
      }
      let missing;
      try {
        await navigator.permissions.query();
        missing = ['ok'];
      } catch (error) {
        missing = [error.name, error.message];
      }
      const permissionsGlobal = Object.getOwnPropertyDescriptor(globalThis, 'Permissions');
      const statusGlobal = Object.getOwnPropertyDescriptor(globalThis, 'PermissionStatus');
      permissionsResult = {
        permissionsCtor: typeof Permissions,
        statusCtor: typeof PermissionStatus,
        permissionsTag: Object.prototype.toString.call(navigator.permissions),
        permissionsInstance: navigator.permissions instanceof Permissions,
        newPermissions: (() => { try { new Permissions(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        permissionsOwn: Object.getOwnPropertyNames(navigator.permissions).sort(),
        permissionsQueryDescriptor: [
          Object.getOwnPropertyDescriptor(Permissions.prototype, 'query').enumerable,
          Object.getOwnPropertyDescriptor(Permissions.prototype, 'query').configurable,
          Object.getOwnPropertyDescriptor(Permissions.prototype, 'query').writable,
          typeof Object.getOwnPropertyDescriptor(Permissions.prototype, 'query').value,
          Object.getOwnPropertyDescriptor(Permissions.prototype, 'query').value.length,
        ],
        permissionsProtoNames: Object.getOwnPropertyNames(Permissions.prototype),
        permissionsGlobal: [permissionsGlobal.enumerable, permissionsGlobal.configurable, permissionsGlobal.writable],
        statusInstance: status instanceof PermissionStatus,
        newPermissionStatus: (() => { try { new PermissionStatus(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        statusName: status.constructor.name,
        statusOwn: Object.getOwnPropertyNames(status).sort(),
        statusPermissionName: status.name,
        statusStateDescriptor: [
          Object.getOwnPropertyDescriptor(PermissionStatus.prototype, 'state').enumerable,
          Object.getOwnPropertyDescriptor(PermissionStatus.prototype, 'state').configurable,
          typeof Object.getOwnPropertyDescriptor(PermissionStatus.prototype, 'state').get,
          Object.getOwnPropertyDescriptor(PermissionStatus.prototype, 'state').set,
        ],
        statusOnchangeDescriptor: [
          Object.getOwnPropertyDescriptor(PermissionStatus.prototype, 'onchange').enumerable,
          Object.getOwnPropertyDescriptor(PermissionStatus.prototype, 'onchange').configurable,
          typeof Object.getOwnPropertyDescriptor(PermissionStatus.prototype, 'onchange').get,
          typeof Object.getOwnPropertyDescriptor(PermissionStatus.prototype, 'onchange').set,
        ],
        statusProtoNames: Object.getOwnPropertyNames(PermissionStatus.prototype),
        statusGlobal: [statusGlobal.enumerable, statusGlobal.configurable, statusGlobal.writable],
        state: status.state,
        clipboardState: clipboardStatus.state,
        cameraState: cameraStatus.state,
        onchange: status.onchange,
        listenerType: typeof status.addEventListener,
        tag: Object.prototype.toString.call(status),
        bad,
        missing,
      };
    })();
  `);
  realm.drainJobs();
  assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(permissionsResult)')), {
    permissionsCtor: 'function',
    statusCtor: 'function',
    permissionsTag: '[object Permissions]',
    permissionsInstance: true,
    newPermissions: ['TypeError', "Failed to construct 'Permissions': Illegal constructor"],
    permissionsOwn: [],
    permissionsQueryDescriptor: [true, true, true, 'function', 1],
    permissionsProtoNames: ['query', 'constructor'],
    permissionsGlobal: [false, true, true],
    statusInstance: true,
    newPermissionStatus: [
      'TypeError',
      "Failed to construct 'PermissionStatus': Illegal constructor",
    ],
    statusName: 'PermissionStatus',
    statusOwn: [],
    statusPermissionName: 'geolocation',
    statusStateDescriptor: [true, true, 'function', null],
    statusOnchangeDescriptor: [true, true, 'function', 'function'],
    statusProtoNames: ['name', 'state', 'onchange', 'constructor'],
    statusGlobal: [false, true, true],
    state: 'denied',
    clipboardState: 'granted',
    cameraState: 'prompt',
    onchange: null,
    listenerType: 'function',
    tag: '[object PermissionStatus]',
    bad: [
      'TypeError',
      "Failed to execute 'query' on 'Permissions': Failed to read the 'name' property from 'PermissionDescriptor': The provided value 'not-a-permission' is not a valid enum value of type PermissionName.",
    ],
    missing: [
      'TypeError',
      "Failed to execute 'query' on 'Permissions': 1 argument required, but only 0 present.",
    ],
  });
  realm.destroy();
});

test('webapi core exposes in-memory Blob File and FormData facades', async () => {
  const { realm } = await installCore();
  realm.evalClassic(`
    globalThis.blobResult = null;
    (async () => {
      const blob = new Blob(['hi ', new Uint8Array([0xe2, 0x82, 0xac])], { type: 'Text/Plain' });
      const slice = blob.slice(3, 6, 'APP/X-ZP');
      const file = new File([blob], 'blob.txt', { type: blob.type, lastModified: 123 });
      const form = new FormData();
      form.append('field', 'value');
      form.append('upload', blob, 'upload.txt');
      const multipartResponseBody = [
        '--zp',
        'Content-Disposition: form-data; name="field"',
        '',
        'alpha',
        '--zp',
        'Content-Disposition: form-data; name="upload"; filename="upload.txt"',
        'Content-Type: text/plain',
        '',
        'file-body',
        '--zp--',
        '',
      ].join('\\r\\n');
      const parsedMultipart = await new Response(multipartResponseBody, { headers: { 'Content-Type': 'multipart/form-data; boundary=zp' } }).formData();
      const parsedUpload = parsedMultipart.get('upload');
      const readBlob = (method, source, ...args) => new Promise((resolve) => {
        const reader = new FileReader();
        const events = [];
        const summarizeEvent = (label, event) => [
          label,
          Object.prototype.toString.call(event),
          event instanceof ProgressEvent,
          event instanceof Event,
          event.lengthComputable,
          event.loaded,
          event.total,
        ];
        reader.onloadstart = (event) => events.push(summarizeEvent('loadstart', event));
        reader.onprogress = (event) => events.push(summarizeEvent('progress', event));
        reader.addEventListener('load', (event) => events.push(summarizeEvent('load-listener', event)));
        reader.onload = (event) => events.push(summarizeEvent('load', event));
        reader.onloadend = (event) => resolve({
          tag: Object.prototype.toString.call(reader),
          readyState: reader.readyState,
          constants: [FileReader.EMPTY, reader.EMPTY, reader.LOADING, reader.DONE],
          events,
          result: reader.result,
          error: reader.error && reader.error.name,
          loadEndEvent: summarizeEvent('loadend', event),
        });
        reader[method](source, ...args);
      });
      const fileTextRead = await readBlob('readAsText', file);
      const latin1TextRead = await readBlob('readAsText', new Blob([new Uint8Array([0xe9])]), 'iso-8859-1');
      const fileArrayRead = await readBlob('readAsArrayBuffer', new Blob([new Uint8Array([1, 2, 3])]));
      fileArrayRead.result = Array.from(new Uint8Array(fileArrayRead.result));
      const fileDataURLRead = await readBlob('readAsDataURL', new Blob(['ok'], { type: 'text/plain' }));
      const constructedProgress = new ProgressEvent('progress', { lengthComputable: true, loaded: 2, total: 6 });
      const objectURL = URL.createObjectURL(blob);
      const streamReader = blob.stream().getReader();
      const streamFirst = await streamReader.read();
      const streamDone = await streamReader.read();
      const secondObjectURL = URL.createObjectURL(file);
      URL.revokeObjectURL(objectURL);
      URL.revokeObjectURL(objectURL);
      let badObjectURL = null;
      try { URL.createObjectURL({}); } catch (error) { badObjectURL = error.name; }
      const multipartRequest = new Request('/multipart', { method: 'POST', body: form });
      const multipartText = await multipartRequest.text();
      const summarizeDescriptor = (object, key) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        return [
          descriptor.enumerable,
          descriptor.configurable,
          Object.prototype.hasOwnProperty.call(descriptor, 'writable') ? descriptor.writable : null,
          Boolean(descriptor.get),
          Boolean(descriptor.set),
          typeof descriptor.value === 'function' ? [descriptor.value.name, descriptor.value.length] : typeof descriptor.value,
        ];
      };
      let badFormFilename = null;
      try { form.append('bad', 'value', 'bad.txt'); } catch (error) { badFormFilename = [error.name, error.message.includes('parameter 2 is not of type')]; }
      let badFormConstructor = null;
      try { new FormData({}); } catch (error) { badFormConstructor = [error.name, error.message.includes('HTMLFormElement')]; }
      let badFormAppend = null;
      try { form.append('bad'); } catch (error) { badFormAppend = [error.name, error.message.includes('2 arguments required')]; }
      const readerShape = new FileReader();
      let badFileReaderCall = null;
      try { FileReader(); } catch (error) { badFileReaderCall = [error.name, error.message.includes('FileReader')]; }
      let badFileReaderMissingReadArg = null;
      try { readerShape.readAsText(); } catch (error) { badFileReaderMissingReadArg = [error.name, error.message.includes('1 argument required')]; }
      blobResult = {
        blobSize: blob.size,
        blobType: blob.type,
        blobText: await blob.text(),
        sliceType: slice.type,
        parsedMultipart: [parsedMultipart.get('field'), parsedUpload.name, parsedUpload.type, await parsedUpload.text()],
        fileReaderText: [fileTextRead.tag, fileTextRead.readyState, fileTextRead.constants, fileTextRead.events, fileTextRead.result, fileTextRead.error, fileTextRead.loadEndEvent],
        fileReaderLatin1Text: latin1TextRead.result,
        progressEvent: [typeof ProgressEvent, Object.prototype.toString.call(constructedProgress), constructedProgress instanceof ProgressEvent, constructedProgress instanceof Event, constructedProgress.lengthComputable, constructedProgress.loaded, constructedProgress.total],
        fileReaderArray: fileArrayRead.result,
        fileReaderDataURL: fileDataURLRead.result,
        sliceBytes: Array.from(new Uint8Array(await slice.arrayBuffer())),
        fileName: file.name,
        fileSize: file.size,
        fileLastModified: file.lastModified,
        blobOwnProperties: Object.getOwnPropertyNames(blob),
        fileOwnProperties: Object.getOwnPropertyNames(file),
        sliceOwnProperties: Object.getOwnPropertyNames(slice),
        blobPrototypeProperties: Object.getOwnPropertyNames(Blob.prototype),
        filePrototypeProperties: Object.getOwnPropertyNames(File.prototype),
        filePrototypeChain: [Object.getPrototypeOf(file) === File.prototype, Object.getPrototypeOf(File.prototype) === Blob.prototype],
        blobBytes: Array.from(await blob.bytes()),
        fileWebkitRelativePath: file.webkitRelativePath,
        fileLastModifiedDate: file.lastModifiedDate instanceof Date && file.lastModifiedDate.getTime(),
        blobDescriptors: {
          global: summarizeDescriptor(globalThis, 'Blob'),
          size: summarizeDescriptor(Blob.prototype, 'size'),
          slice: summarizeDescriptor(Blob.prototype, 'slice'),
          bytes: summarizeDescriptor(Blob.prototype, 'bytes'),
          constructor: summarizeDescriptor(Blob.prototype, 'constructor'),
        },
        fileDescriptors: {
          global: summarizeDescriptor(globalThis, 'File'),
          name: summarizeDescriptor(File.prototype, 'name'),
          lastModifiedDate: summarizeDescriptor(File.prototype, 'lastModifiedDate'),
          constructor: summarizeDescriptor(File.prototype, 'constructor'),
        },
        fileReaderOwnProperties: Object.getOwnPropertyNames(readerShape),
        fileReaderPrototypeProperties: Object.getOwnPropertyNames(FileReader.prototype),
        fileReaderBrand: [
          Object.prototype.toString.call(readerShape),
          readerShape instanceof FileReader,
          readerShape instanceof EventTarget,
          readerShape.readyState,
          readerShape.result,
          readerShape.error,
          [FileReader.EMPTY, readerShape.EMPTY, readerShape.LOADING, readerShape.DONE],
        ],
        fileReaderBadCall: badFileReaderCall,
        fileReaderMissingReadArg: badFileReaderMissingReadArg,
        fileReaderDescriptors: {
          global: summarizeDescriptor(globalThis, 'FileReader'),
          readyState: summarizeDescriptor(FileReader.prototype, 'readyState'),
          onload: summarizeDescriptor(FileReader.prototype, 'onload'),
          EMPTY: summarizeDescriptor(FileReader.prototype, 'EMPTY'),
          abort: summarizeDescriptor(FileReader.prototype, 'abort'),
          readAsText: summarizeDescriptor(FileReader.prototype, 'readAsText'),
          constructor: summarizeDescriptor(FileReader.prototype, 'constructor'),
        },
        formOwnProperties: Object.getOwnPropertyNames(form),
        formPrototypeProperties: Object.getOwnPropertyNames(FormData.prototype),
        formBrand: [Object.prototype.toString.call(form), form instanceof FormData],
        formBadCalls: { badFormFilename, badFormConstructor, badFormAppend },
        formDescriptors: {
          global: summarizeDescriptor(globalThis, 'FormData'),
          append: summarizeDescriptor(FormData.prototype, 'append'),
          delete: summarizeDescriptor(FormData.prototype, 'delete'),
          set: summarizeDescriptor(FormData.prototype, 'set'),
          entries: summarizeDescriptor(FormData.prototype, 'entries'),
          forEach: summarizeDescriptor(FormData.prototype, 'forEach'),
          constructor: summarizeDescriptor(FormData.prototype, 'constructor'),
        },
        formField: form.get('field'),
        formUploadName: form.get('upload').name,
        formKeys: Array.from(form.keys()),
        streamTag: Object.prototype.toString.call(blob.stream()),
        streamBytes: Array.from(streamFirst.value || []),
        streamDone: streamDone.done,
        objectURL,
        secondObjectURL,
        badObjectURL,
        multipartType: multipartRequest.headers.get('content-type'),
        multipartHasField: multipartText.includes('Content-Disposition: form-data; name="field"\\r\\n\\r\\nvalue'),
        multipartHasFile: multipartText.includes('Content-Disposition: form-data; name="upload"; filename="upload.txt"') && multipartText.includes('Content-Type: text/plain'),
        multipartHasClose: multipartText.endsWith('------zeroproxy-formdata-1--\\r\\n'),
      };
    })();
  `);
  realm.drainJobs();
  assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(blobResult)')), {
    blobSize: 6,
    blobType: 'text/plain',
    blobText: 'hi €',
    sliceType: 'app/x-zp',
    parsedMultipart: ['alpha', 'upload.txt', 'text/plain', 'file-body'],
    fileReaderText: [
      '[object FileReader]',
      2,
      [0, 0, 1, 2],
      [
        ['loadstart', '[object ProgressEvent]', true, true, true, 0, 6],
        ['progress', '[object ProgressEvent]', true, true, true, 6, 6],
        ['load-listener', '[object ProgressEvent]', true, true, true, 6, 6],
        ['load', '[object ProgressEvent]', true, true, true, 6, 6],
      ],
      'hi €',
      null,
      ['loadend', '[object ProgressEvent]', true, true, true, 6, 6],
    ],
    fileReaderLatin1Text: 'é',
    fileReaderArray: [1, 2, 3],
    fileReaderDataURL: 'data:text/plain;base64,b2s=',
    progressEvent: ['function', '[object ProgressEvent]', true, true, true, 2, 6],
    sliceBytes: [226, 130, 172],
    fileName: 'blob.txt',
    fileSize: 6,
    fileLastModified: 123,
    blobOwnProperties: [],
    fileOwnProperties: [],
    sliceOwnProperties: [],
    blobPrototypeProperties: [
      'size',
      'type',
      'arrayBuffer',
      'slice',
      'stream',
      'text',
      'bytes',
      'constructor',
    ],
    filePrototypeProperties: [
      'name',
      'lastModified',
      'lastModifiedDate',
      'webkitRelativePath',
      'constructor',
    ],
    filePrototypeChain: [true, true],
    blobBytes: [104, 105, 32, 226, 130, 172],
    fileWebkitRelativePath: '',
    fileLastModifiedDate: 123,
    blobDescriptors: {
      global: [false, true, true, false, false, ['Blob', 0]],
      size: [true, true, null, true, false, 'undefined'],
      slice: [true, true, true, false, false, ['slice', 0]],
      bytes: [true, true, true, false, false, ['bytes', 0]],
      constructor: [false, true, true, false, false, ['Blob', 0]],
    },
    fileDescriptors: {
      global: [false, true, true, false, false, ['File', 2]],
      name: [true, true, null, true, false, 'undefined'],
      lastModifiedDate: [true, true, null, true, false, 'undefined'],
      constructor: [false, true, true, false, false, ['File', 2]],
    },
    fileReaderOwnProperties: [],
    fileReaderPrototypeProperties: [
      'readyState',
      'result',
      'error',
      'onloadstart',
      'onprogress',
      'onload',
      'onabort',
      'onerror',
      'onloadend',
      'EMPTY',
      'LOADING',
      'DONE',
      'abort',
      'readAsArrayBuffer',
      'readAsBinaryString',
      'readAsDataURL',
      'readAsText',
      'constructor',
    ],
    fileReaderBrand: ['[object FileReader]', true, true, 0, null, null, [0, 0, 1, 2]],
    fileReaderBadCall: ['TypeError', true],
    fileReaderMissingReadArg: ['TypeError', true],
    fileReaderDescriptors: {
      global: [false, true, true, false, false, ['FileReader', 0]],
      readyState: [true, true, null, true, false, 'undefined'],
      onload: [true, true, null, true, true, 'undefined'],
      EMPTY: [true, false, false, false, false, 'number'],
      abort: [true, true, true, false, false, ['abort', 0]],
      readAsText: [true, true, true, false, false, ['readAsText', 1]],
      constructor: [false, true, true, false, false, ['FileReader', 0]],
    },
    formOwnProperties: [],
    formPrototypeProperties: [
      'append',
      'delete',
      'get',
      'getAll',
      'has',
      'set',
      'entries',
      'forEach',
      'keys',
      'values',
      'constructor',
    ],
    formBrand: ['[object FormData]', true],
    formBadCalls: {
      badFormFilename: ['TypeError', true],
      badFormConstructor: ['TypeError', true],
      badFormAppend: ['TypeError', true],
    },
    formDescriptors: {
      global: [false, true, true, false, false, ['FormData', 0]],
      append: [true, true, true, false, false, ['append', 2]],
      delete: [true, true, true, false, false, ['delete', 1]],
      set: [true, true, true, false, false, ['set', 2]],
      entries: [true, true, true, false, false, ['entries', 0]],
      forEach: [true, true, true, false, false, ['forEach', 1]],
      constructor: [false, true, true, false, false, ['FormData', 0]],
    },
    formField: 'value',
    formUploadName: 'upload.txt',
    formKeys: ['field', 'upload'],
    streamTag: '[object ReadableStream]',
    streamBytes: [104, 105, 32, 226, 130, 172],
    streamDone: true,
    objectURL: 'blob:https://target.example/zp-1',
    secondObjectURL: 'blob:https://target.example/zp-2',
    badObjectURL: 'TypeError',
    multipartType: 'multipart/form-data; boundary=----zeroproxy-formdata-1',
    multipartHasField: true,
    multipartHasFile: true,
    multipartHasClose: true,
  });
  realm.destroy();
});

test('webapi core lets WebSocket binaryType blob deliver Blob message data', async () => {
  const { realm, network, wsEvents } = await installCore();
  realm.evalClassic(`
    globalThis.wsBlobResult = null;
    const ws = new WebSocket('/blob');
    ws.onmessage = async (event) => {
      wsBlobResult = {
        isBlob: event.data instanceof Blob,
        size: event.data.size,
        text: await event.data.text(),
      };
    };
  `);
  await network.waitForIdle();
  const [wsId, emit] = [...wsEvents.entries()][0];
  emit({ type: 'ws.message', wsId, opcode: 'binary', bytes: [104, 105] });
  realm.drainJobs();
  assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(wsBlobResult)')), {
    isBlob: true,
    size: 2,
    text: 'hi',
  });
  realm.destroy();
});

test('webapi core exposes form controls FileList and FormData(form)', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    const form = document.createElement('form');
    form.id = 'f';
    const input = document.createElement('input');
    input.name = 'q';
    input.setAttribute('dirname', 'q.dir');
    input.id = 'query';
    input.value = 'hello';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.name = 'agree';
    check.checked = true;
    const radioA = document.createElement('input');
    radioA.type = 'radio';
    radioA.name = 'group';
    radioA.setAttribute('value', 'a');
    const radioB = document.createElement('input');
    radioB.type = 'radio';
    radioB.name = 'group';
    radioB.setAttribute('value', 'b');
    radioB.checked = true;
    const file = document.createElement('input');
    file.type = 'file';
    file.name = 'upload';
    form.appendChild(input);
    form.appendChild(check);
    form.appendChild(radioA);
    form.appendChild(radioB);
    form.appendChild(file);
    const submitButton = document.createElement('button');
    submitButton.name = 'send';
    submitButton.setAttribute('value', 'go');
    const plainButton = document.createElement('button');
    plainButton.type = 'button';
    plainButton.name = 'plain';
    plainButton.setAttribute('value', 'ignored');
    const inputSubmit = document.createElement('input');
    inputSubmit.type = 'submit';
    inputSubmit.name = 'inputSend';
    inputSubmit.value = 'input-go';
    const imageSubmit = document.createElement('input');
    imageSubmit.type = 'image';
    imageSubmit.name = 'imageSend';
    form.appendChild(submitButton);
    form.appendChild(plainButton);
    form.appendChild(inputSubmit);
    form.appendChild(imageSubmit);
    const disabledFieldset = document.createElement('fieldset');
    disabledFieldset.setAttribute('disabled', '');
    const firstLegend = document.createElement('legend');
    const legendInput = document.createElement('input');
    legendInput.name = 'legendKeep';
    legendInput.value = 'yes';
    const blockedFieldsetInput = document.createElement('input');
    blockedFieldsetInput.name = 'fieldsetBlocked';
    blockedFieldsetInput.value = 'no';
    firstLegend.appendChild(legendInput);
    disabledFieldset.appendChild(firstLegend);
    disabledFieldset.appendChild(blockedFieldsetInput);
    form.appendChild(disabledFieldset);
    const explicitLabel = document.createElement('label');
    explicitLabel.htmlFor = 'query';
    explicitLabel.textContent = 'Search';
    form.appendChild(explicitLabel);
    const required = document.createElement('input');
    required.required = true;
    const email = document.createElement('input');
    email.type = 'email';
    email.value = 'bad-email';
    const number = document.createElement('input');
    number.type = 'number';
    number.setAttribute('min', '2');
    number.setAttribute('max', '4');
    number.value = '5';
    const textarea = document.createElement('textarea');
    textarea.name = 'comments';
    textarea.value = 'hello\\nworld';
    const select = document.createElement('select');
    select.name = 'choice';
    const optionA = document.createElement('option');
    optionA.value = 'a';
    optionA.textContent = 'Alpha';
    const optionB = document.createElement('option');
    optionB.value = 'b';
    optionB.id = 'choice-b';
    optionB.textContent = 'Beta';
    optionB.selected = true;
    optionB.defaultSelected = true;
    const constructedOption = new Option('Gamma', 'g', true, false);
    select.appendChild(optionA);
    select.appendChild(optionB);
    form.appendChild(textarea);
    textarea.setAttribute('dirname', 'comments.dir');
    form.appendChild(select);
    form.appendChild(required);
    form.appendChild(email);
    form.appendChild(number);
    const objectControl = document.createElement('object');
    objectControl.name = 'objectControl';
    const outputControl = document.createElement('output');
    outputControl.name = 'outputControl';
    outputControl.value = 'out';
    form.appendChild(objectControl);
    form.appendChild(outputControl);
    const explicitlyUnownedInput = document.createElement('input');
    explicitlyUnownedInput.name = 'explicitlyUnowned';
    explicitlyUnownedInput.value = 'skip';
    explicitlyUnownedInput.setAttribute('form', 'missing-form');
    form.appendChild(explicitlyUnownedInput);
    document.body.appendChild(form);
    const externalInput = document.createElement('input');
    externalInput.name = 'external';
    externalInput.value = 'linked';
    externalInput.setAttribute('form', 'f');
    document.body.appendChild(externalInput);
    const externalObject = document.createElement('object');
    externalObject.name = 'externalObject';
    externalObject.setAttribute('form', 'f');
    document.body.appendChild(externalObject);
    const implicitLabel = document.createElement('label');
    const implicitInput = document.createElement('input');
    implicitLabel.appendChild(implicitInput);
    document.body.appendChild(implicitLabel);
    let fileSetValue;
    try {
      file.value = 'x';
      fileSetValue = ['ok'];
    } catch (error) {
      fileSetValue = [error.name, error.message];
    }
    const transfer = new DataTransfer();
    const selectedFile = new File(['abc'], 'a.txt', { type: 'text/plain', lastModified: 7 });
    transfer.items.add(selectedFile);
    transfer.setData('text/plain', 'payload');
    file.files = transfer.files;
    const currentFile = file.files.item(0);
    function captureError(callback) {
      try {
        return ['ok', callback()];
      } catch (error) {
        return [error.name, error.message, error.code ?? null];
      }
    }
    const initialTransferEffects = [transfer.dropEffect, transfer.effectAllowed];
    transfer.dropEffect = 'copy';
    transfer.effectAllowed = 'all';
    const ignoredTransferEffects = [transfer.dropEffect, transfer.effectAllowed];
    const aliasTransfer = new DataTransfer();
    aliasTransfer.setData('Text', 'alias');
    aliasTransfer.setData('URL', 'https://example.test/');
    const setDragImageResults = [
      captureError(() => transfer.setDragImage()),
      captureError(() => transfer.setDragImage({}, 0, 0)),
      captureError(() => transfer.setDragImage(document.body, 1, 2)),
    ];
    const transferItemErrors = [
      captureError(() => new DataTransferItem()),
      captureError(() => new DataTransferItemList()),
      captureError(() => transfer.items.add('dupe')),
      captureError(() => transfer.items.add('dupe', 'text/plain')),
      captureError(() => transfer.items.remove()),
    ];
    let invalidEvents = 0;
    required.addEventListener('invalid', (event) => {
      if (event.bubbles === false && event.cancelable) invalidEvents += 1;
    });
    const validityBefore = [
      typeof ValidityState,
      Object.prototype.toString.call(required.validity),
      Object.getOwnPropertyNames(required.validity).sort(),
      [
        Object.getOwnPropertyDescriptor(ValidityState.prototype, 'valueMissing').enumerable,
        Object.getOwnPropertyDescriptor(ValidityState.prototype, 'valueMissing').configurable,
        typeof Object.getOwnPropertyDescriptor(ValidityState.prototype, 'valueMissing').get,
        Object.getOwnPropertyDescriptor(ValidityState.prototype, 'valueMissing').set,
      ],
      required.willValidate,
      required.validity.valueMissing,
      required.validationMessage,
      form.checkValidity(),
      invalidEvents,
      email.validity.typeMismatch,
      number.validity.rangeOverflow,
    ];
    required.value = 'filled';
    email.setCustomValidity('blocked');
    const customValidation = [email.validity.typeMismatch, email.validity.customError, email.validationMessage, email.checkValidity()];
    email.setCustomValidity('');
    email.value = 'user@example.test';
    const selectBefore = [Object.prototype.toString.call(select), typeof HTMLSelectElement, select instanceof HTMLSelectElement, Object.prototype.toString.call(select.options), typeof HTMLOptionsCollection, select.options instanceof HTMLOptionsCollection, select.options.length, select.options.item(1) === optionB, select.options.namedItem('choice-b') === optionB, Array.from(select.options).map((option) => option.value), select.value, select.selectedIndex, optionB.selected, optionB.defaultSelected];
    const optionsShape = [
      Object.getOwnPropertyNames(select.options),
      Object.keys(select.options),
      Object.getOwnPropertyDescriptor(select.options, '0') && [
        Object.getOwnPropertyDescriptor(select.options, '0').enumerable,
        Object.getOwnPropertyDescriptor(select.options, '0').configurable,
        Object.getOwnPropertyDescriptor(select.options, '0').writable,
        select.options[0] === optionA,
      ],
      Object.getOwnPropertyDescriptor(select.options, 'choice-b') && [
        Object.getOwnPropertyDescriptor(select.options, 'choice-b').enumerable,
        Object.getOwnPropertyDescriptor(select.options, 'choice-b').configurable,
        Object.getOwnPropertyDescriptor(select.options, 'choice-b').writable,
        select.options['choice-b'] === optionB,
      ],
      Object.getOwnPropertyDescriptor(select.options, 'length'),
      Object.getOwnPropertyNames(HTMLOptionsCollection.prototype),
      [
        Object.getOwnPropertyDescriptor(HTMLOptionsCollection.prototype, 'length').enumerable,
        Object.getOwnPropertyDescriptor(HTMLOptionsCollection.prototype, 'selectedIndex').enumerable,
        Object.getOwnPropertyDescriptor(HTMLOptionsCollection.prototype, 'add').value.length,
        Object.getOwnPropertyDescriptor(HTMLOptionsCollection.prototype, 'remove').value.length,
      ],
    ];
    const optionMutationSelect = document.createElement('select');
    optionMutationSelect.options.add(new Option('Two', '2'));
    optionMutationSelect.options.add(new Option('One', '1'), 0);
    optionMutationSelect.options.selectedIndex = 1;
    optionMutationSelect.options.length = 3;
    optionMutationSelect.options.remove(2);
    const optionsMutation = [
      optionMutationSelect.options.length,
      optionMutationSelect.options.selectedIndex,
      optionMutationSelect.value,
      Array.from(optionMutationSelect.options).map((option) => option.value),
    ];
    const optionConstructor = [typeof Option, Object.prototype.toString.call(constructedOption), constructedOption instanceof HTMLOptionElement, constructedOption.localName, constructedOption.textContent, constructedOption.value, constructedOption.defaultSelected, constructedOption.selected, Option.prototype === HTMLOptionElement.prototype];
    select.value = 'a';
    const selectAfter = [select.value, select.selectedIndex, optionA.selected, optionB.selected];
    const radioList = form.elements.namedItem('group');
    const radioSummary = [
      Object.prototype.toString.call(radioList),
      typeof RadioNodeList,
      radioList instanceof RadioNodeList,
      radioList instanceof NodeList,
      radioList.length,
      radioList.item(0) === radioA,
      radioList[1] === radioB,
      radioList.value,
      Object.getOwnPropertyNames(radioList),
      Object.keys(radioList),
      Object.getOwnPropertyDescriptor(radioList, '0') && [
        Object.getOwnPropertyDescriptor(radioList, '0').enumerable,
        Object.getOwnPropertyDescriptor(radioList, '0').configurable,
        Object.getOwnPropertyDescriptor(radioList, '0').writable,
        radioList[0] === radioA,
      ],
      Object.getOwnPropertyDescriptor(radioList, 'length'),
      Object.getOwnPropertyNames(RadioNodeList.prototype),
      [
        Object.getOwnPropertyDescriptor(RadioNodeList.prototype, 'value').enumerable,
        Object.getOwnPropertyDescriptor(RadioNodeList.prototype, 'value').configurable,
        typeof radioList.forEach,
        Boolean(Object.getOwnPropertyDescriptor(RadioNodeList.prototype, 'value').get),
        Boolean(Object.getOwnPropertyDescriptor(RadioNodeList.prototype, 'value').set),
      ],
    ];
    radioList.value = 'a';
    const radioAfter = [radioA.checked, radioB.checked, radioList.value];
    const liveRadioForm = document.createElement('form');
    const liveRadioA = document.createElement('input');
    liveRadioA.type = 'radio';
    liveRadioA.name = 'live';
    liveRadioA.setAttribute('value', 'a');
    const liveRadioB = document.createElement('input');
    liveRadioB.type = 'radio';
    liveRadioB.name = 'live';
    liveRadioB.setAttribute('value', 'b');
    liveRadioB.checked = true;
    liveRadioForm.appendChild(liveRadioA);
    liveRadioForm.appendChild(liveRadioB);
    const liveRadioList = liveRadioForm.elements.live;
    const liveRadioC = document.createElement('input');
    liveRadioC.type = 'radio';
    liveRadioC.name = 'live';
    liveRadioC.setAttribute('value', 'c');
    liveRadioForm.appendChild(liveRadioC);
    const liveRadioBefore = [liveRadioList.length, Array.from(liveRadioList).map((node) => node.value), liveRadioList[2] === liveRadioC, liveRadioList.value];
    liveRadioList.value = 'c';
    liveRadioC.name = 'other';
    const liveRadioAfter = [liveRadioA.checked, liveRadioB.checked, liveRadioC.checked, liveRadioList.length, Array.from(liveRadioList).map((node) => node.value), liveRadioList.value];
    const radioLiveSummary = [liveRadioBefore, liveRadioAfter];
    number.value = '3';
    const validityAfter = [form.reportValidity(), required.validity.valid, email.validity.valid, number.validity.valid, number.validationMessage];
    const labelSummary = [
      Object.prototype.toString.call(explicitLabel),
      typeof HTMLLabelElement,
      explicitLabel instanceof HTMLLabelElement,
      explicitLabel.htmlFor,
      explicitLabel.getAttribute('for'),
      explicitLabel.control === input,
      explicitLabel.form === form,
      input.labels instanceof NodeList,
      input.labels.length,
      input.labels[0] === explicitLabel,
      implicitLabel.control === implicitInput,
      implicitInput.labels instanceof NodeList,
      implicitInput.labels[0] === implicitLabel,
      implicitLabel.form,
    ];
    function formDataEntries(data) {
      return Array.from(data.entries()).map(([key, value]) => [key, value instanceof File ? [value.name, value.type, value.size] : value]);
    }
    function formDataError(callback) {
      try {
        callback();
        return ['ok'];
      } catch (error) {
        return [error.name, error.message];
      }
    }
    const eventForm = document.createElement('form');
    const eventInput = document.createElement('input');
    eventInput.name = 'a';
    eventInput.value = '1';
    eventForm.appendChild(eventInput);
    const formDataEventRows = [];
    eventForm.addEventListener('formdata', (event) => {
      formDataEventRows.push(['listener', formDataEntries(event.formData)]);
    });
    eventForm.onformdata = (event) => {
      formDataEventRows.push([
        'handler',
        event.type,
        event.bubbles,
        event.cancelable,
        event.composed,
        event instanceof FormDataEvent,
        event.formData instanceof FormData,
        formDataEntries(event.formData),
      ]);
      event.formData.append('b', '2');
    };
    formDataEventRows.push(['after', formDataEntries(new FormData(eventForm))]);
    JSON.stringify({
      input: [Object.prototype.toString.call(input), typeof HTMLInputElement, input instanceof HTMLInputElement, input.type, input.name, input.value, input.form.id, input.defaultValue],
      checkbox: [check.type, check.checked, check.value, check.defaultChecked],
      form: [Object.prototype.toString.call(form), typeof HTMLFormElement, form instanceof HTMLFormElement, Object.prototype.toString.call(form.elements), form.elements instanceof HTMLFormControlsCollection, form.elements.length, form.elements[0] === input, form.elements.namedItem('q') === input],
      file: [
        Object.prototype.toString.call(file.files),
        typeof FileList,
        file.files instanceof FileList,
        file.files.length,
        file.files.item(0) === currentFile,
        file.value,
        Object.getOwnPropertyNames(file.files).sort(),
        [
          Object.getOwnPropertyDescriptor(FileList.prototype, 'length').enumerable,
          Object.getOwnPropertyDescriptor(FileList.prototype, 'length').configurable,
          typeof Object.getOwnPropertyDescriptor(FileList.prototype, 'length').get,
          Object.getOwnPropertyDescriptor(FileList.prototype, 'length').set,
        ],
        [
          Object.getOwnPropertyDescriptor(FileList.prototype, 'item').enumerable,
          Object.getOwnPropertyDescriptor(FileList.prototype, 'item').configurable,
          Object.getOwnPropertyDescriptor(FileList.prototype, 'item').writable,
          typeof Object.getOwnPropertyDescriptor(FileList.prototype, 'item').value,
          Object.getOwnPropertyDescriptor(FileList.prototype, 'item').value.length,
        ],
        Object.getOwnPropertyNames(FileList.prototype),
        [
          Object.getOwnPropertyDescriptor(globalThis, 'FileList').enumerable,
          Object.getOwnPropertyDescriptor(globalThis, 'FileList').configurable,
          Object.getOwnPropertyDescriptor(globalThis, 'FileList').writable,
          FileList.name,
          FileList.length,
        ],
        [
          Object.getOwnPropertyDescriptor(file.files, '0').enumerable,
          Object.getOwnPropertyDescriptor(file.files, '0').configurable,
          Object.getOwnPropertyDescriptor(file.files, '0').writable,
          Boolean(Object.getOwnPropertyDescriptor(file.files, '0').get),
        ],
        [
          Object.getOwnPropertyDescriptor(FileList.prototype, Symbol.iterator).enumerable,
          Object.getOwnPropertyDescriptor(FileList.prototype, Symbol.iterator).configurable,
          Object.getOwnPropertyDescriptor(FileList.prototype, Symbol.iterator).writable,
          Object.getOwnPropertyDescriptor(FileList.prototype, Symbol.iterator).value.name,
          Object.getOwnPropertyDescriptor(FileList.prototype, Symbol.iterator).value.length,
        ],
        [
          Object.getOwnPropertyDescriptor(FileList.prototype, 'constructor').enumerable,
          Object.getOwnPropertyDescriptor(FileList.prototype, 'constructor').configurable,
          Object.getOwnPropertyDescriptor(FileList.prototype, 'constructor').writable,
          Object.getOwnPropertyDescriptor(FileList.prototype, 'constructor').value.name,
          Object.getOwnPropertyDescriptor(FileList.prototype, 'constructor').value.length,
        ],
      ],
      dataTransfer: [
        Object.prototype.toString.call(transfer),
        typeof DataTransfer,
        transfer instanceof DataTransfer,
        Object.getOwnPropertyNames(transfer).sort(),
        [
          Object.getOwnPropertyDescriptor(DataTransfer.prototype, 'items').enumerable,
          Object.getOwnPropertyDescriptor(DataTransfer.prototype, 'items').configurable,
          typeof Object.getOwnPropertyDescriptor(DataTransfer.prototype, 'items').get,
          Object.getOwnPropertyDescriptor(DataTransfer.prototype, 'items').set,
        ],
        Object.prototype.toString.call(transfer.items),
        Object.getOwnPropertyNames(transfer.items).sort(),
        typeof DataTransferItem,
        typeof DataTransferItemList,
        transfer.items.length,
        Object.prototype.toString.call(transfer.items[0]),
        Object.getOwnPropertyNames(transfer.items[0]).sort(),
        [
          Object.getOwnPropertyDescriptor(DataTransferItem.prototype, 'kind').enumerable,
          Object.getOwnPropertyDescriptor(DataTransferItem.prototype, 'kind').configurable,
          typeof Object.getOwnPropertyDescriptor(DataTransferItem.prototype, 'kind').get,
          Object.getOwnPropertyDescriptor(DataTransferItem.prototype, 'kind').set,
        ],
        transfer.items[0].kind,
        transfer.items[0].type,
        transfer.types,
        transfer.getData('text/plain'),
        Object.getOwnPropertyNames(DataTransfer.prototype),
        Object.getOwnPropertyNames(DataTransferItemList.prototype),
        Object.getOwnPropertyNames(DataTransferItem.prototype),
        [
          Object.getOwnPropertyDescriptor(transfer.items, '0').enumerable,
          Object.getOwnPropertyDescriptor(transfer.items, '0').configurable,
          Object.getOwnPropertyDescriptor(transfer.items, '0').writable,
          Boolean(Object.getOwnPropertyDescriptor(transfer.items, '0').get),
        ],
        [
          Object.isFrozen(transfer.types),
          Object.getOwnPropertyDescriptor(transfer.types, '0').writable,
          Object.getOwnPropertyDescriptor(transfer.types, '0').enumerable,
          Object.getOwnPropertyDescriptor(transfer.types, '0').configurable,
        ],
        [initialTransferEffects, ignoredTransferEffects],
        [aliasTransfer.types, aliasTransfer.getData('text/plain'), aliasTransfer.getData('text'), aliasTransfer.getData('URL')],
        setDragImageResults,
        transferItemErrors,
      ],
      selectedFiles: [file.files.length, currentFile.name, currentFile.type, currentFile.size, file.files[0] === currentFile, Array.from(file.files).map((entry) => entry.name), file.value],
      fileSetValue,
      textarea: [Object.prototype.toString.call(textarea), typeof HTMLTextAreaElement, textarea instanceof HTMLTextAreaElement, textarea.value, textarea.textContent],
      formAssociatedControls: [
        objectControl.form === form,
        outputControl.form === form,
        disabledFieldset.form === form,
        externalObject.form === form,
        form.elements.namedItem('objectControl') === objectControl,
        form.elements.namedItem('outputControl') === outputControl,
        form.elements.namedItem('externalObject') === externalObject,
      ],
      formCollectionShape: [
        Object.getOwnPropertyNames(form.elements),
        Object.keys(form.elements),
        Object.getOwnPropertyDescriptor(form.elements, '0') && [
          Object.getOwnPropertyDescriptor(form.elements, '0').enumerable,
          Object.getOwnPropertyDescriptor(form.elements, '0').configurable,
          Object.getOwnPropertyDescriptor(form.elements, '0').writable,
          form.elements[0] === input,
        ],
        Object.getOwnPropertyDescriptor(form.elements, 'q') && [
          Object.getOwnPropertyDescriptor(form.elements, 'q').enumerable,
          Object.getOwnPropertyDescriptor(form.elements, 'q').configurable,
          Object.getOwnPropertyDescriptor(form.elements, 'q').writable,
          form.elements.q === input,
        ],
        Object.getOwnPropertyDescriptor(form.elements, 'length'),
        [
          form.elements.group instanceof RadioNodeList,
          form.elements.objectControl === objectControl,
          form.elements.externalObject === externalObject,
          form.elements instanceof HTMLCollection,
          Object.getPrototypeOf(HTMLFormControlsCollection.prototype) === HTMLCollection.prototype,
          form.elements.namedItem === HTMLFormControlsCollection.prototype.namedItem,
        ],
        Object.getOwnPropertyNames(HTMLFormControlsCollection.prototype),
        [
          Object.getOwnPropertyDescriptor(HTMLFormControlsCollection.prototype, 'namedItem').enumerable,
          Object.getOwnPropertyDescriptor(HTMLFormControlsCollection.prototype, 'namedItem').configurable,
          Object.getOwnPropertyDescriptor(HTMLFormControlsCollection.prototype, 'namedItem').writable,
          Object.getOwnPropertyDescriptor(HTMLFormControlsCollection.prototype, 'namedItem').value.length,
        ],
      ],
      optionsShape,
      optionsMutation,
      selectBefore,
      optionConstructor,
      selectAfter,
      radioSummary,
      radioAfter,
      radioLiveSummary,
      labelSummary,
      formData: formDataEntries(new FormData(form)),
      submitterFormData: formDataEntries(new FormData(form, submitButton)),
      inputSubmitterFormData: formDataEntries(new FormData(form, inputSubmit)),
      imageSubmitterFormData: formDataEntries(new FormData(form, imageSubmit)),
      submitterErrors: [
        formDataError(() => new FormData(form, plainButton)),
        formDataError(() => new FormData(form, input)),
        formDataError(() => new FormData(form, document.createElement('button'))),
      ],
      formDataEventRows,
      validityBefore,
      customValidation,
      validityAfter,
    });
  `);
  assert.deepEqual(JSON.parse(result), {
    input: ['[object HTMLInputElement]', 'function', true, 'text', 'q', 'hello', 'f', ''],
    checkbox: ['checkbox', true, 'on', false],
    form: [
      '[object HTMLFormElement]',
      'function',
      true,
      '[object HTMLFormControlsCollection]',
      true,
      21,
      true,
      true,
    ],
    file: [
      '[object FileList]',
      'function',
      true,
      1,
      true,
      'C:\\fakepath\\a.txt',
      ['0'],
      [true, true, 'function', null],
      [true, true, true, 'function', 1],
      ['length', 'item', 'constructor'],
      [false, true, true, 'FileList', 0],
      [true, true, false, false],
      [false, true, true, 'values', 0],
      [false, true, true, 'FileList', 0],
    ],
    dataTransfer: [
      '[object DataTransfer]',
      'function',
      true,
      [],
      [true, true, 'function', null],
      '[object DataTransferItemList]',
      ['0', '1'],
      'function',
      'function',
      2,
      '[object DataTransferItem]',
      [],
      [true, true, 'function', null],
      'file',
      'text/plain',
      ['text/plain', 'Files'],
      'payload',
      [
        'dropEffect',
        'effectAllowed',
        'items',
        'types',
        'files',
        'clearData',
        'getData',
        'setData',
        'setDragImage',
        'constructor',
      ],
      ['length', 'add', 'clear', 'remove', 'constructor'],
      [
        'kind',
        'type',
        'getAsFile',
        'getAsString',
        'webkitGetAsEntry',
        'getAsFileSystemHandle',
        'constructor',
      ],
      [true, true, false, false],
      [true, false, true, false],
      [
        ['none', 'none'],
        ['none', 'none'],
      ],
      [['text/plain', 'text/uri-list'], 'alias', 'alias', 'https://example.test/'],
      [
        [
          'TypeError',
          "Failed to execute 'setDragImage' on 'DataTransfer': 3 arguments required, but only 0 present.",
          null,
        ],
        [
          'TypeError',
          "Failed to execute 'setDragImage' on 'DataTransfer': parameter 1 is not of type 'Element'.",
          null,
        ],
        ['ok', null],
      ],
      [
        ['TypeError', "Failed to construct 'DataTransferItem': Illegal constructor", null],
        ['TypeError', "Failed to construct 'DataTransferItemList': Illegal constructor", null],
        [
          'TypeError',
          "Failed to execute 'add' on 'DataTransferItemList': parameter 1 is not of type 'File'.",
          null,
        ],
        [
          'NotSupportedError',
          "Failed to execute 'add' on 'DataTransferItemList': An item already exists for type 'text/plain'.",
          9,
        ],
        [
          'TypeError',
          "Failed to execute 'remove' on 'DataTransferItemList': 1 argument required, but only 0 present.",
          null,
        ],
      ],
    ],
    selectedFiles: [1, 'a.txt', 'text/plain', 3, true, ['a.txt'], 'C:\\fakepath\\a.txt'],
    fileSetValue: ['InvalidStateError', 'InvalidStateError'],
    textarea: ['[object HTMLTextAreaElement]', 'function', true, 'hello\nworld', 'hello\nworld'],
    formAssociatedControls: [true, true, true, true, true, true, true],
    formCollectionShape: [
      [
        '0',
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        '8',
        '9',
        '10',
        '11',
        '12',
        '13',
        '14',
        '15',
        '16',
        '17',
        '18',
        '19',
        '20',
        'query',
        'q',
        'agree',
        'group',
        'upload',
        'send',
        'plain',
        'inputSend',
        'imageSend',
        'legendKeep',
        'fieldsetBlocked',
        'comments',
        'choice',
        'objectControl',
        'outputControl',
        'external',
        'externalObject',
      ],
      [
        '0',
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        '8',
        '9',
        '10',
        '11',
        '12',
        '13',
        '14',
        '15',
        '16',
        '17',
        '18',
        '19',
        '20',
        'query',
        'q',
        'agree',
        'group',
        'upload',
        'send',
        'plain',
        'inputSend',
        'imageSend',
        'legendKeep',
        'fieldsetBlocked',
        'comments',
        'choice',
        'objectControl',
        'outputControl',
        'external',
        'externalObject',
      ],
      [true, true, false, true],
      [true, true, false, true],
      null,
      [true, true, true, true, true, true],
      ['namedItem', 'constructor'],
      [true, true, true, 1],
    ],
    optionsShape: [
      ['0', '1', 'choice-b'],
      ['0', '1', 'choice-b'],
      [true, true, true, true],
      [true, true, false, true],
      null,
      ['length', 'selectedIndex', 'add', 'remove', 'constructor'],
      [true, true, 1, 1],
    ],
    optionsMutation: [2, 1, '2', ['1', '2']],
    selectBefore: [
      '[object HTMLSelectElement]',
      'function',
      true,
      '[object HTMLOptionsCollection]',
      'function',
      true,
      2,
      true,
      true,
      ['a', 'b'],
      'b',
      1,
      true,
      true,
    ],
    optionConstructor: [
      'function',
      '[object HTMLOptionElement]',
      true,
      'option',
      'Gamma',
      'g',
      true,
      false,
      true,
    ],
    selectAfter: ['a', 0, true, false],
    radioSummary: [
      '[object RadioNodeList]',
      'function',
      true,
      true,
      2,
      true,
      true,
      'b',
      ['0', '1'],
      ['0', '1'],
      [true, true, false, true],
      null,
      ['value', 'constructor'],
      [true, true, 'function', true, true],
    ],
    radioAfter: [true, false, 'a'],
    radioLiveSummary: [
      [3, ['a', 'b', 'c'], true, 'b'],
      [false, false, true, 2, ['a', 'b'], ''],
    ],
    labelSummary: [
      '[object HTMLLabelElement]',
      'function',
      true,
      'query',
      'query',
      true,
      true,
      true,
      1,
      true,
      true,
      true,
      true,
      null,
    ],
    validityBefore: [
      'function',
      '[object ValidityState]',
      [],
      [true, true, 'function', null],
      true,
      true,
      'Please fill out this field.',
      false,
      1,
      true,
      true,
    ],
    customValidation: [true, true, 'blocked', false],
    validityAfter: [true, true, true, true, ''],
    formData: [
      ['q', 'hello'],
      ['q.dir', 'ltr'],
      ['agree', 'on'],
      ['group', 'a'],
      ['upload', ['a.txt', 'text/plain', 3]],
      ['legendKeep', 'yes'],
      ['comments', 'hello\nworld'],
      ['comments.dir', 'ltr'],
      ['choice', 'a'],
      ['external', 'linked'],
    ],
    submitterFormData: [
      ['q', 'hello'],
      ['q.dir', 'ltr'],
      ['agree', 'on'],
      ['group', 'a'],
      ['upload', ['a.txt', 'text/plain', 3]],
      ['send', 'go'],
      ['legendKeep', 'yes'],
      ['comments', 'hello\nworld'],
      ['comments.dir', 'ltr'],
      ['choice', 'a'],
      ['external', 'linked'],
    ],
    inputSubmitterFormData: [
      ['q', 'hello'],
      ['q.dir', 'ltr'],
      ['agree', 'on'],
      ['group', 'a'],
      ['upload', ['a.txt', 'text/plain', 3]],
      ['inputSend', 'input-go'],
      ['legendKeep', 'yes'],
      ['comments', 'hello\nworld'],
      ['comments.dir', 'ltr'],
      ['choice', 'a'],
      ['external', 'linked'],
    ],
    imageSubmitterFormData: [
      ['q', 'hello'],
      ['q.dir', 'ltr'],
      ['agree', 'on'],
      ['group', 'a'],
      ['upload', ['a.txt', 'text/plain', 3]],
      ['imageSend.x', '0'],
      ['imageSend.y', '0'],
      ['legendKeep', 'yes'],
      ['comments', 'hello\nworld'],
      ['comments.dir', 'ltr'],
      ['choice', 'a'],
      ['external', 'linked'],
    ],
    submitterErrors: [
      [
        'TypeError',
        "Failed to construct 'FormData': The specified element is not a submit button.",
      ],
      [
        'TypeError',
        "Failed to construct 'FormData': The specified element is not a submit button.",
      ],
      [
        'NotFoundError',
        "Failed to construct 'FormData': The specified element is not owned by this form element.",
      ],
    ],
    formDataEventRows: [
      ['listener', [['a', '1']]],
      ['handler', 'formdata', true, false, false, true, true, [['a', '1']]],
      [
        'after',
        [
          ['a', '1'],
          ['b', '2'],
        ],
      ],
    ],
  });
  realm.destroy();
});

test('webapi core reflects anchor and resource URL properties', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    const a = document.createElement('a');
    a.href = '/path?q=1#h';
    const anchor = [Object.prototype.toString.call(a), typeof HTMLAnchorElement, a instanceof HTMLAnchorElement, a.getAttribute('href'), a.href, a.origin, a.protocol, a.host, a.hostname, a.port, a.pathname, a.search, a.hash];
    a.protocol = 'http:';
    a.hostname = 'example.test';
    a.port = '8080';
    a.pathname = '/next';
    a.search = '?x=2';
    a.hash = '#z';
    const anchorSetParts = [a.href, a.getAttribute('href')];
    const capture = (fn) => { try { return ['ok', fn()]; } catch (error) { return [error.name, error.message]; } };
    const url = new URL('../asset?y=1#old', 'https://target.example/app/page.html');
    const urlInitial = [Object.prototype.toString.call(url), url.href, url.origin, url.protocol, url.username, url.password, url.host, url.hostname, url.port, url.pathname, url.search, url.hash, String(url), url.toJSON()];
    url.protocol = 'http:';
    url.username = 'user';
    url.password = 'secret';
    url.hostname = 'example.test';
    url.port = '8080';
    url.pathname = '/done';
    url.search = '?q=2';
    url.hash = 'z';
    const urlSetParts = [url.href, url.origin, url.protocol, url.username, url.password, url.host, url.pathname, url.search, url.hash, String(url)];
    const canParseDescriptor = Object.getOwnPropertyDescriptor(URL, 'canParse');
    const parseDescriptor = Object.getOwnPropertyDescriptor(URL, 'parse');
    const createObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const urlStatics = [
      URL.name,
      URL.length,
      typeof URL.canParse,
      URL.canParse.name,
      URL.canParse.length,
      Object.prototype.hasOwnProperty.call(URL.canParse, 'prototype'),
      [canParseDescriptor.enumerable, canParseDescriptor.writable, canParseDescriptor.configurable],
      typeof URL.parse,
      URL.parse.name,
      URL.parse.length,
      Object.prototype.hasOwnProperty.call(URL.parse, 'prototype'),
      [parseDescriptor.enumerable, parseDescriptor.writable, parseDescriptor.configurable],
      [createObjectURLDescriptor.enumerable, createObjectURLDescriptor.writable, createObjectURLDescriptor.configurable],
      URL.canParse('https://target.example/a'),
      URL.canParse('/a'),
      URL.canParse('/a', 'https://target.example/base/'),
      URL.canParse('/a', ''),
      URL.parse('/a', 'https://target.example/base/')?.href,
      URL.parse('/a'),
      capture(() => new URL('%%%')),
      capture(() => new URL()),
      capture(() => new URL('/a', '')),
      capture(() => URL.canParse()),
      capture(() => URL.parse()),
    ];
    const urlHrefDescriptor = Object.getOwnPropertyDescriptor(URL.prototype, 'href');
    const urlToStringDescriptor = Object.getOwnPropertyDescriptor(URL.prototype, 'toString');
    const urlToJSONDescriptor = Object.getOwnPropertyDescriptor(URL.prototype, 'toJSON');
    const urlPrototypeShape = [
      Object.getOwnPropertyNames(url),
      [urlHrefDescriptor.enumerable, urlHrefDescriptor.configurable, !!urlHrefDescriptor.get, !!urlHrefDescriptor.set],
      [urlToStringDescriptor.enumerable, urlToStringDescriptor.writable, urlToStringDescriptor.configurable, URL.prototype.toString.name, URL.prototype.toString.length, Object.prototype.hasOwnProperty.call(URL.prototype.toString, 'prototype')],
      [urlToJSONDescriptor.enumerable, urlToJSONDescriptor.writable, urlToJSONDescriptor.configurable, URL.prototype.toJSON.name, URL.prototype.toJSON.length, Object.prototype.hasOwnProperty.call(URL.prototype.toJSON, 'prototype')],
      capture(() => { url.href = '%%%'; return url.href; }),
    ];
    const params = new URLSearchParams('b=2&a=1&a=two+words&empty=');
    params.append('space', 'x y');
    params.set('b', 'changed');
    params.delete('empty');
    const paramsSeen = [];
    params.forEach((value, key) => paramsSeen.push([key, value]));
    const paramsSizeDescriptor = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, 'size');
    const paramsAppendDescriptor = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, 'append');
    const paramsDeleteDescriptor = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, 'delete');
    const paramsShape = [
      URLSearchParams.name,
      URLSearchParams.length,
      Object.getOwnPropertyDescriptor(globalThis, 'URLSearchParams').enumerable,
      Object.getOwnPropertyNames(params),
      params.size,
      [paramsSizeDescriptor.enumerable, paramsSizeDescriptor.configurable, !!paramsSizeDescriptor.get, !!paramsSizeDescriptor.set],
      [paramsAppendDescriptor.enumerable, paramsAppendDescriptor.writable, paramsAppendDescriptor.configurable, URLSearchParams.prototype.append.name, URLSearchParams.prototype.append.length, Object.prototype.hasOwnProperty.call(URLSearchParams.prototype.append, 'prototype')],
      [paramsDeleteDescriptor.enumerable, paramsDeleteDescriptor.writable, paramsDeleteDescriptor.configurable, URLSearchParams.prototype.delete.name, URLSearchParams.prototype.delete.length, Object.prototype.hasOwnProperty.call(URLSearchParams.prototype.delete, 'prototype')],
      capture(() => new URLSearchParams([[1]])),
      capture(() => new URLSearchParams([[1, 2, 3]])),
    ];
    const paramsBeforeSort = [
      Object.prototype.toString.call(params),
      params.get('a'),
      params.getAll('a'),
      params.has('empty'),
      params.toString(),
      Array.from(params.entries()),
      paramsSeen,
      Array.from(new URLSearchParams({ c: 3, d: 'four' })),
      Array.from(new URLSearchParams([['e', '5']])),
    ];
    const optionalParams = new URLSearchParams('a=1&a=2&a=undefined&b=1');
    const paramsOptionalValue = [
      optionalParams.has('a'),
      optionalParams.has('a', '2'),
      optionalParams.has('a', 'missing'),
      optionalParams.has('a', undefined),
    ];
    optionalParams.delete('a', '1');
    paramsOptionalValue.push(Array.from(optionalParams));
    optionalParams.delete('a', undefined);
    paramsOptionalValue.push(Array.from(optionalParams), optionalParams.has('a', undefined));
    optionalParams.delete('a');
    paramsOptionalValue.push(Array.from(optionalParams));
    params.sort();
    const paramsAfterSort = [params.toString(), Array.from(params.keys()), Array.from(params.values())];
    const liveURL = new URL('/search?q=1', 'https://target.example/app/');
    const liveParams = liveURL.searchParams;
    liveParams.append('added', '✓');
    liveParams.set('q', '2');
    const liveSearchParams = [liveURL.href, liveParams.toString(), Array.from(liveParams.entries())];
    const liveParamsRef = liveURL.searchParams;
    liveURL.search = '?reset=1';
    const liveSearchSetter = [String(liveParamsRef), liveParamsRef === liveURL.searchParams, liveURL.href];
    const pattern = new URLPattern({ protocol: 'https', hostname: '*.example', pathname: '/users/*', search: 'q=*' });
    const patternMatch = pattern.exec('https://api.example/users/42?q=yes#frag');
    const exactPattern = new URLPattern('https://target.example/base/page?x=1#hash');
    const urlPattern = [
      typeof URLPattern,
      Object.prototype.toString.call(pattern),
      pattern instanceof URLPattern,
      pattern.protocol,
      pattern.hostname,
      pattern.pathname,
      pattern.search,
      pattern.test('https://api.example/users/42?q=yes#frag'),
      pattern.test('http://api.example/users/42?q=yes'),
      patternMatch.hostname.input,
      patternMatch.pathname.input,
      patternMatch.search.input,
      pattern.exec('https://example.org/users/42?q=yes') === null,
      exactPattern.protocol,
      exactPattern.hostname,
      exactPattern.pathname,
      exactPattern.search,
      exactPattern.hash,
      exactPattern.test('/base/page?x=1#hash', 'https://target.example/root/'),
      webkitURL === URL,
      typeof webkitURL.createObjectURL,
    ];
    const img = document.createElement('img');
    img.src = 'img/p.png';
    const constructedImage = new Image(12, 34);
    const constructedAudio = new Audio('/tone.ogg');
    const script = document.createElement('script');
    script.src = '/app.js';
    const link = document.createElement('link');
    link.href = 'style.css';
    const linkRelList = link.relList;
    linkRelList.add('stylesheet', 'preload');
    const sameRelList = linkRelList === link.relList;
    linkRelList.toggle('preload', false);
    const area = document.createElement('area');
    area.relList.value = 'nofollow noopener';
    const relListSummary = [
      Object.prototype.toString.call(linkRelList),
      linkRelList instanceof DOMTokenList,
      sameRelList,
      link.getAttribute('rel'),
      linkRelList.length,
      linkRelList.contains('stylesheet'),
      linkRelList.contains('preload'),
      Array.from(linkRelList),
      Object.getOwnPropertyNames(linkRelList).sort(),
      [
        Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'value').enumerable,
        Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'value').configurable,
        typeof Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'value').get,
        typeof Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'value').set,
      ],
      [
        Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'add').enumerable,
        Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'add').configurable,
        Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'add').writable,
        typeof Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'add').value,
        Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'add').value.length,
      ],
      [
        linkRelList.supports('stylesheet'),
        linkRelList.supports('preload'),
        linkRelList.supports('unknown'),
        linkRelList.supports('STYLESHEET'),
        area.relList.supports('noopener'),
      ],
      area.relList.value,
      document.createElement('div').relList,
    ];
    JSON.stringify({
      anchor,
      anchorSetParts,
      urlInitial,
      urlSetParts,
      urlStatics,
      urlPrototypeShape,
      paramsShape,
      paramsBeforeSort,
      paramsAfterSort,
      liveSearchParams,
      liveSearchSetter,
      paramsOptionalValue,
      urlPattern,
      resources: [Object.prototype.toString.call(img), typeof HTMLImageElement, img instanceof HTMLImageElement, img.getAttribute('src'), img.src, script.src, link.href, typeof Image, Object.prototype.toString.call(constructedImage), constructedImage instanceof HTMLImageElement, constructedImage.localName, constructedImage.width, constructedImage.height, Image.prototype === HTMLImageElement.prototype, typeof Audio, Object.prototype.toString.call(constructedAudio), constructedAudio instanceof HTMLAudioElement, constructedAudio.localName, constructedAudio.src, Audio.prototype === HTMLAudioElement.prototype],
      relListSummary,
    });
  `);
  assert.deepEqual(JSON.parse(result), {
    anchor: [
      '[object HTMLAnchorElement]',
      'function',
      true,
      '/path?q=1#h',
      'https://target.example/path?q=1#h',
      'https://target.example',
      'https:',
      'target.example',
      'target.example',
      '',
      '/path',
      '?q=1',
      '#h',
    ],
    anchorSetParts: ['http://example.test:8080/next?x=2#z', 'http://example.test:8080/next?x=2#z'],
    urlInitial: [
      '[object URL]',
      'https://target.example/asset?y=1#old',
      'https://target.example',
      'https:',
      '',
      '',
      'target.example',
      'target.example',
      '',
      '/asset',
      '?y=1',
      '#old',
      'https://target.example/asset?y=1#old',
      'https://target.example/asset?y=1#old',
    ],
    urlStatics: [
      'URL',
      1,
      'function',
      'canParse',
      1,
      false,
      [true, true, true],
      'function',
      'parse',
      1,
      false,
      [true, true, true],
      [true, true, true],
      true,
      false,
      true,
      false,
      'https://target.example/a',
      null,
      ['TypeError', "Failed to construct 'URL': Invalid URL"],
      ['TypeError', "Failed to construct 'URL': 1 argument required, but only 0 present."],
      ['TypeError', "Failed to construct 'URL': Invalid base URL"],
      [
        'TypeError',
        "Failed to execute 'canParse' on 'URL': 1 argument required, but only 0 present.",
      ],
      ['TypeError', "Failed to execute 'parse' on 'URL': 1 argument required, but only 0 present."],
    ],
    urlPrototypeShape: [
      [],
      [true, true, true, true],
      [true, true, true, 'toString', 0, false],
      [true, true, true, 'toJSON', 0, false],
      ['TypeError', "Failed to set the 'href' property on 'URL': Invalid URL"],
    ],
    paramsBeforeSort: [
      '[object URLSearchParams]',
      '1',
      ['1', 'two words'],
      false,
      'b=changed&a=1&a=two+words&space=x+y',
      [
        ['b', 'changed'],
        ['a', '1'],
        ['a', 'two words'],
        ['space', 'x y'],
      ],
      [
        ['b', 'changed'],
        ['a', '1'],
        ['a', 'two words'],
        ['space', 'x y'],
      ],
      [
        ['c', '3'],
        ['d', 'four'],
      ],
      [['e', '5']],
    ],
    paramsShape: [
      'URLSearchParams',
      0,
      false,
      [],
      4,
      [true, true, true, false],
      [true, true, true, 'append', 2, false],
      [true, true, true, 'delete', 1, false],
      [
        'TypeError',
        "Failed to construct 'URLSearchParams': Failed to construct 'URLSearchParams': Sequence initializer must only contain pair elements",
      ],
      [
        'TypeError',
        "Failed to construct 'URLSearchParams': Failed to construct 'URLSearchParams': Sequence initializer must only contain pair elements",
      ],
    ],
    paramsAfterSort: [
      'a=1&a=two+words&b=changed&space=x+y',
      ['a', 'a', 'b', 'space'],
      ['1', 'two words', 'changed', 'x y'],
    ],
    paramsOptionalValue: [
      true,
      true,
      false,
      true,
      [
        ['a', '2'],
        ['a', 'undefined'],
        ['b', '1'],
      ],
      [
        ['a', '2'],
        ['b', '1'],
      ],
      false,
      [['b', '1']],
    ],
    liveSearchParams: [
      'https://target.example/search?q=2&added=%E2%9C%93',
      'q=2&added=%E2%9C%93',
      [
        ['q', '2'],
        ['added', '✓'],
      ],
    ],
    liveSearchSetter: ['reset=1', true, 'https://target.example/search?reset=1'],
    urlPattern: [
      'function',
      '[object URLPattern]',
      true,
      'https',
      '*.example',
      '/users/*',
      'q=*',
      true,
      false,
      'api.example',
      '/users/42',
      'q=yes',
      true,
      'https',
      'target.example',
      '/base/page',
      'x=1',
      'hash',
      true,
      true,
      'function',
    ],
    urlSetParts: [
      'http://user:secret@example.test:8080/done?q=2#z',
      'http://example.test:8080',
      'http:',
      'user',
      'secret',
      'example.test:8080',
      '/done',
      '?q=2',
      '#z',
      'http://user:secret@example.test:8080/done?q=2#z',
    ],
    resources: [
      '[object HTMLImageElement]',
      'function',
      true,
      'img/p.png',
      'https://target.example/app/img/p.png',
      'https://target.example/app.js',
      'https://target.example/app/style.css',
      'function',
      '[object HTMLImageElement]',
      true,
      'img',
      12,
      34,
      true,
      'function',
      '[object HTMLAudioElement]',
      true,
      'audio',
      'https://target.example/tone.ogg',
      true,
    ],
    relListSummary: [
      '[object DOMTokenList]',
      true,
      true,
      'stylesheet',
      1,
      true,
      false,
      ['stylesheet'],
      ['0'],
      [true, true, 'function', 'function'],
      [true, true, true, 'function', 0],
      [true, true, false, true, true],
      'nofollow noopener',
      null,
    ],
  });
  realm.destroy();
});

test('webapi core exposes common and long-tail per-element HTML constructors', async () => {
  const { realm } = await installCore();
  const constructorCases = [
    ['a', 'HTMLAnchorElement'],
    ['area', 'HTMLAreaElement'],
    ['audio', 'HTMLAudioElement'],
    ['base', 'HTMLBaseElement'],
    ['blockquote', 'HTMLQuoteElement'],
    ['body', 'HTMLBodyElement'],
    ['br', 'HTMLBRElement'],
    ['button', 'HTMLButtonElement'],
    ['canvas', 'HTMLCanvasElement'],
    ['caption', 'HTMLTableCaptionElement'],
    ['col', 'HTMLTableColElement'],
    ['colgroup', 'HTMLTableColElement'],
    ['data', 'HTMLDataElement'],
    ['datalist', 'HTMLDataListElement'],
    ['del', 'HTMLModElement'],
    ['details', 'HTMLDetailsElement'],
    ['dialog', 'HTMLDialogElement'],
    ['dir', 'HTMLDirectoryElement'],
    ['div', 'HTMLDivElement'],
    ['dl', 'HTMLDListElement'],
    ['embed', 'HTMLEmbedElement'],
    ['fencedframe', 'HTMLFencedFrameElement'],
    ['fieldset', 'HTMLFieldSetElement'],
    ['font', 'HTMLFontElement'],
    ['form', 'HTMLFormElement'],
    ['frame', 'HTMLFrameElement'],
    ['frameset', 'HTMLFrameSetElement'],
    ['geolocation', 'HTMLGeolocationElement'],
    ['h1', 'HTMLHeadingElement'],
    ['h6', 'HTMLHeadingElement'],
    ['head', 'HTMLHeadElement'],
    ['hr', 'HTMLHRElement'],
    ['html', 'HTMLHtmlElement'],
    ['iframe', 'HTMLIFrameElement'],
    ['img', 'HTMLImageElement'],
    ['input', 'HTMLInputElement'],
    ['ins', 'HTMLModElement'],
    ['legend', 'HTMLLegendElement'],
    ['label', 'HTMLLabelElement'],
    ['li', 'HTMLLIElement'],
    ['link', 'HTMLLinkElement'],
    ['map', 'HTMLMapElement'],
    ['marquee', 'HTMLMarqueeElement'],
    ['menu', 'HTMLMenuElement'],
    ['meta', 'HTMLMetaElement'],
    ['meter', 'HTMLMeterElement'],
    ['object', 'HTMLObjectElement'],
    ['ol', 'HTMLOListElement'],
    ['optgroup', 'HTMLOptGroupElement'],
    ['option', 'HTMLOptionElement'],
    ['output', 'HTMLOutputElement'],
    ['p', 'HTMLParagraphElement'],
    ['param', 'HTMLParamElement'],
    ['picture', 'HTMLPictureElement'],
    ['pre', 'HTMLPreElement'],
    ['progress', 'HTMLProgressElement'],
    ['q', 'HTMLQuoteElement'],
    ['script', 'HTMLScriptElement'],
    ['select', 'HTMLSelectElement'],
    ['selectedcontent', 'HTMLSelectedContentElement'],
    ['slot', 'HTMLSlotElement'],
    ['source', 'HTMLSourceElement'],
    ['span', 'HTMLSpanElement'],
    ['style', 'HTMLStyleElement'],
    ['table', 'HTMLTableElement'],
    ['tbody', 'HTMLTableSectionElement'],
    ['td', 'HTMLTableCellElement'],
    ['template', 'HTMLTemplateElement'],
    ['textarea', 'HTMLTextAreaElement'],
    ['tfoot', 'HTMLTableSectionElement'],
    ['th', 'HTMLTableCellElement'],
    ['thead', 'HTMLTableSectionElement'],
    ['time', 'HTMLTimeElement'],
    ['title', 'HTMLTitleElement'],
    ['tr', 'HTMLTableRowElement'],
    ['track', 'HTMLTrackElement'],
    ['ul', 'HTMLUListElement'],
    ['video', 'HTMLVideoElement'],
  ];
  const result = realm.evalClassic(`
    (() => {
      const cases = ${JSON.stringify(constructorCases)};
      const constructorRows = cases.map(([tag, name]) => {
        const element = document.createElement(tag);
        const ctor = globalThis[name];
        let constructed;
        try {
          new ctor();
          constructed = ['ok'];
        } catch (error) {
          constructed = [error.name, error.message];
        }
        return {
          tag,
          name,
          type: typeof ctor,
          ctorName: ctor.name,
          instance: element instanceof ctor,
          htmlInstance: element instanceof HTMLElement,
          stringTag: Object.prototype.toString.call(element),
          constructError: constructed,
        };
      });
      const audio = document.createElement('audio');
      const video = document.createElement('video');
      const unknown = document.createElement('notarealtag');
      const generic = document.createElement('section');
      const custom = document.createElement('x-widget');
      const dialog = document.createElement('dialog');
      const dialogEvents = [];
      dialog.addEventListener('close', () => dialogEvents.push(['close', dialog.returnValue]));
      dialog.addEventListener('cancel', (event) => dialogEvents.push(['cancel', event.cancelable]));
      dialog.show();
      const afterShow = [dialog.open, dialog.hasAttribute('open')];
      dialog.close('done');
      const afterClose = [dialog.open, dialog.returnValue, dialog.hasAttribute('open')];
      dialog.returnValue = 'manual';
      dialog.showModal();
      dialog.requestClose('requested');
      let divShow;
      try {
        document.createElement('div').show();
        divShow = ['ok'];
      } catch (error) {
        divShow = [error.name, error.message];
      }
      const details = document.createElement('details');
      details.open = true;
      const detailsOpen = [details.open, details.hasAttribute('open')];
      details.open = false;
      const detailsClosed = [details.open, details.hasAttribute('open')];
      const data = document.createElement('data');
      data.value = 'sku-1';
      const output = document.createElement('output');
      output.value = 'ready';
      const progress = document.createElement('progress');
      const progressEmpty = [progress.value, progress.max, progress.position];
      progress.max = 10;
      progress.value = 4;
      const meter = document.createElement('meter');
      meter.min = 1;
      meter.max = 5;
      meter.low = 2;
      meter.high = 4;
      meter.optimum = 3.5;
      meter.value = 3;
      const time = document.createElement('time');
      time.dateTime = '2026-06-08';
      const mod = document.createElement('ins');
      mod.dateTime = '2026-06-09';
      mod.cite = '/change';
      const quote = document.createElement('blockquote');
      quote.cite = '/source';
      const fieldForm = document.createElement('form');
      const fieldset = document.createElement('fieldset');
      fieldset.name = 'group';
      fieldset.disabled = true;
      const legend = document.createElement('legend');
      const fieldInput = document.createElement('input');
      fieldInput.name = 'inside';
      fieldset.append(legend, fieldInput);
      fieldForm.appendChild(fieldset);
      document.body.appendChild(fieldForm);
      let fieldsetSummary;
      try {
        fieldsetSummary = [
          fieldset instanceof HTMLFieldSetElement,
          Object.prototype.toString.call(fieldset),
          fieldset.type,
          fieldset.name,
          fieldset.disabled,
          fieldset.hasAttribute('disabled'),
          fieldset.form === fieldForm,
          Object.prototype.toString.call(fieldset.elements),
          fieldset.elements instanceof HTMLFormControlsCollection,
          fieldset.elements.length,
          fieldset.elements[0] === fieldInput,
          fieldset.elements.namedItem('inside') === fieldInput,
          legend instanceof HTMLLegendElement,
          Object.prototype.toString.call(legend),
          legend.form === fieldForm,
        ];
      } catch (error) {
        fieldsetSummary = ['THREW', error.name, error.message];
      }
      return JSON.stringify({
        constructorRows,
        mediaBase: [audio instanceof HTMLMediaElement, video instanceof HTMLMediaElement],
        unknown: [
          typeof HTMLUnknownElement,
          unknown instanceof HTMLUnknownElement,
          unknown instanceof HTMLElement,
          Object.prototype.toString.call(unknown),
          generic instanceof HTMLUnknownElement,
          generic instanceof HTMLElement,
          Object.prototype.toString.call(generic),
          custom instanceof HTMLUnknownElement,
          custom instanceof HTMLElement,
          Object.prototype.toString.call(custom),
        ],
        dialog: [
          dialog instanceof HTMLDialogElement,
          Object.prototype.toString.call(dialog),
          typeof dialog.show,
          typeof dialog.showModal,
          typeof dialog.close,
          typeof dialog.requestClose,
          afterShow,
          afterClose,
          dialog.returnValue,
          dialog.open,
          dialogEvents,
          divShow,
        ],
        details: [
          details instanceof HTMLDetailsElement,
          Object.prototype.toString.call(details),
          detailsOpen,
          detailsClosed,
        ],
        fieldset: fieldsetSummary,
        elementReflections: {
          data: [data.value, data.getAttribute('value')],
          output: [output.value, output.textContent],
          progressEmpty,
          progress: [progress.value, progress.max, progress.position, progress.getAttribute('value'), progress.getAttribute('max')],
          meter: [meter.value, meter.min, meter.max, meter.low, meter.high, meter.optimum, meter.getAttribute('value'), meter.getAttribute('min')],
          time: [time.dateTime, time.getAttribute('datetime')],
          mod: [mod.dateTime, mod.getAttribute('datetime')],
          quote: [quote instanceof HTMLQuoteElement, Object.prototype.toString.call(quote), quote.cite, quote.getAttribute('cite')],
          cite: [mod.cite, mod.getAttribute('cite')],
        },
      });
    })();
  `);
  assert.deepEqual(JSON.parse(result), {
    constructorRows: constructorCases.map(([tag, name]) => ({
      tag,
      name,
      type: 'function',
      ctorName: name,
      instance: true,
      htmlInstance: true,
      stringTag: `[object ${name}]`,
      constructError: ['TypeError', `Failed to construct '${name}': Illegal constructor`],
    })),
    mediaBase: [true, true],
    unknown: [
      'function',
      true,
      true,
      '[object HTMLUnknownElement]',
      false,
      true,
      '[object HTMLElement]',
      false,
      true,
      '[object HTMLElement]',
    ],
    dialog: [
      true,
      '[object HTMLDialogElement]',
      'function',
      'function',
      'function',
      'function',
      [true, true],
      [false, 'done', false],
      'requested',
      false,
      [
        ['close', 'done'],
        ['cancel', true],
        ['close', 'requested'],
      ],
      [
        'TypeError',
        "Failed to execute 'show' on 'HTMLDialogElement': The element is not a dialog.",
      ],
    ],
    details: [true, '[object HTMLDetailsElement]', [true, true], [false, false]],
    fieldset: [
      true,
      '[object HTMLFieldSetElement]',
      'fieldset',
      'group',
      true,
      true,
      true,
      '[object HTMLFormControlsCollection]',
      true,
      1,
      true,
      true,
      true,
      '[object HTMLLegendElement]',
      true,
    ],
    elementReflections: {
      data: ['sku-1', 'sku-1'],
      output: ['ready', 'ready'],
      progressEmpty: [0, 1, -1],
      progress: [4, 10, 0.4, '4', '10'],
      meter: [3, 1, 5, 2, 4, 3.5, '3', '1'],
      time: ['2026-06-08', '2026-06-08'],
      mod: ['2026-06-09', '2026-06-09'],
      quote: [true, '[object HTMLQuoteElement]', '/source', '/source'],
      cite: ['/change', '/change'],
    },
  });
  realm.destroy();
});

test('webapi core exposes SVG element constructor brands', async () => {
  const { realm } = await installCore();
  const svgConstructorCases = [
    ['a', 'SVGAElement', ['SVGGraphicsElement']],
    ['animate', 'SVGAnimateElement', ['SVGAnimationElement']],
    ['animateMotion', 'SVGAnimateMotionElement', ['SVGAnimationElement']],
    ['animateTransform', 'SVGAnimateTransformElement', ['SVGAnimationElement']],
    ['circle', 'SVGCircleElement', ['SVGGeometryElement', 'SVGGraphicsElement']],
    ['clipPath', 'SVGClipPathElement', []],
    ['defs', 'SVGDefsElement', ['SVGGraphicsElement']],
    ['desc', 'SVGDescElement', []],
    ['ellipse', 'SVGEllipseElement', ['SVGGeometryElement', 'SVGGraphicsElement']],
    ['feBlend', 'SVGFEBlendElement', []],
    ['feColorMatrix', 'SVGFEColorMatrixElement', []],
    ['feComponentTransfer', 'SVGFEComponentTransferElement', []],
    ['feComposite', 'SVGFECompositeElement', []],
    ['feConvolveMatrix', 'SVGFEConvolveMatrixElement', []],
    ['feDiffuseLighting', 'SVGFEDiffuseLightingElement', []],
    ['feDisplacementMap', 'SVGFEDisplacementMapElement', []],
    ['feDistantLight', 'SVGFEDistantLightElement', []],
    ['feDropShadow', 'SVGFEDropShadowElement', []],
    ['feFlood', 'SVGFEFloodElement', []],
    ['feFuncA', 'SVGFEFuncAElement', ['SVGComponentTransferFunctionElement']],
    ['feFuncB', 'SVGFEFuncBElement', ['SVGComponentTransferFunctionElement']],
    ['feFuncG', 'SVGFEFuncGElement', ['SVGComponentTransferFunctionElement']],
    ['feFuncR', 'SVGFEFuncRElement', ['SVGComponentTransferFunctionElement']],
    ['feGaussianBlur', 'SVGFEGaussianBlurElement', []],
    ['feImage', 'SVGFEImageElement', []],
    ['feMerge', 'SVGFEMergeElement', []],
    ['feMergeNode', 'SVGFEMergeNodeElement', []],
    ['feMorphology', 'SVGFEMorphologyElement', []],
    ['feOffset', 'SVGFEOffsetElement', []],
    ['fePointLight', 'SVGFEPointLightElement', []],
    ['feSpecularLighting', 'SVGFESpecularLightingElement', []],
    ['feSpotLight', 'SVGFESpotLightElement', []],
    ['feTile', 'SVGFETileElement', []],
    ['feTurbulence', 'SVGFETurbulenceElement', []],
    ['filter', 'SVGFilterElement', []],
    ['foreignObject', 'SVGForeignObjectElement', ['SVGGraphicsElement']],
    ['g', 'SVGGElement', ['SVGGraphicsElement']],
    ['image', 'SVGImageElement', ['SVGGraphicsElement']],
    ['line', 'SVGLineElement', ['SVGGeometryElement', 'SVGGraphicsElement']],
    ['linearGradient', 'SVGLinearGradientElement', ['SVGGradientElement']],
    ['marker', 'SVGMarkerElement', []],
    ['mask', 'SVGMaskElement', []],
    ['metadata', 'SVGMetadataElement', []],
    ['mpath', 'SVGMPathElement', []],
    ['path', 'SVGPathElement', ['SVGGeometryElement', 'SVGGraphicsElement']],
    ['pattern', 'SVGPatternElement', []],
    ['polygon', 'SVGPolygonElement', ['SVGGeometryElement', 'SVGGraphicsElement']],
    ['polyline', 'SVGPolylineElement', ['SVGGeometryElement', 'SVGGraphicsElement']],
    ['radialGradient', 'SVGRadialGradientElement', ['SVGGradientElement']],
    ['rect', 'SVGRectElement', ['SVGGeometryElement', 'SVGGraphicsElement']],
    ['script', 'SVGScriptElement', []],
    ['set', 'SVGSetElement', ['SVGAnimationElement']],
    ['stop', 'SVGStopElement', []],
    ['style', 'SVGStyleElement', []],
    ['svg', 'SVGSVGElement', ['SVGGraphicsElement']],
    ['switch', 'SVGSwitchElement', ['SVGGraphicsElement']],
    ['symbol', 'SVGSymbolElement', []],
    [
      'text',
      'SVGTextElement',
      ['SVGTextPositioningElement', 'SVGTextContentElement', 'SVGGraphicsElement'],
    ],
    ['textPath', 'SVGTextPathElement', ['SVGTextContentElement', 'SVGGraphicsElement']],
    ['title', 'SVGTitleElement', []],
    [
      'tspan',
      'SVGTSpanElement',
      ['SVGTextPositioningElement', 'SVGTextContentElement', 'SVGGraphicsElement'],
    ],
    ['use', 'SVGUseElement', ['SVGGraphicsElement']],
    ['view', 'SVGViewElement', []],
  ];
  const svgBaseConstructors = [
    'SVGElement',
    'SVGGraphicsElement',
    'SVGGeometryElement',
    'SVGTextContentElement',
    'SVGTextPositioningElement',
    'SVGGradientElement',
    'SVGAnimationElement',
    'SVGComponentTransferFunctionElement',
  ];
  const result = realm.evalClassic(`
    (() => {
      const ns = 'http://www.w3.org/2000/svg';
      const cases = ${JSON.stringify(svgConstructorCases)};
      const baseConstructors = ${JSON.stringify(svgBaseConstructors)};
      const rows = cases.map(([tag, name, bases]) => {
        const element = document.createElementNS(ns, tag);
        const ctor = globalThis[name];
        let constructed;
        try {
          new ctor();
          constructed = ['ok'];
        } catch (error) {
          constructed = [error.name, error.message];
        }
        return {
          tag,
          name,
          localName: element.localName,
          tagName: element.tagName,
          type: typeof ctor,
          ctorName: ctor.name,
          instance: element instanceof ctor,
          svgInstance: element instanceof SVGElement,
          stringTag: Object.prototype.toString.call(element),
          baseInstances: bases.map((base) => {
            const baseCtor = globalThis[base];
            return [base, typeof baseCtor, element instanceof baseCtor];
          }),
          constructError: constructed,
        };
      });
      const baseRows = baseConstructors.map((name) => {
        const ctor = globalThis[name];
        let constructed;
        try {
          new ctor();
          constructed = ['ok'];
        } catch (error) {
          constructed = [error.name, error.message];
        }
        return {
          name,
          type: typeof ctor,
          ctorName: ctor.name,
          prototypeTag: Object.prototype.toString.call(ctor.prototype),
          constructError: constructed,
        };
      });
      const lowerBlend = document.createElementNS(ns, 'feblend');
      const linearGradient = document.createElementNS(ns, 'linearGradient');
      const lowerGradient = document.createElementNS(ns, 'lineargradient');
      document.body.append(linearGradient, lowerGradient);
      return JSON.stringify({
        rows,
        baseRows,
        lowerBlend: [
          lowerBlend.localName,
          Object.prototype.toString.call(lowerBlend),
          lowerBlend instanceof SVGFEBlendElement,
          lowerBlend instanceof SVGElement,
        ],
        tagLookups: [
          document.getElementsByTagName('linearGradient').length,
          document.getElementsByTagName('lineargradient').length,
        ],
        prototypeParents: [
          Object.getPrototypeOf(SVGGraphicsElement.prototype) === SVGElement.prototype,
          Object.getPrototypeOf(SVGGeometryElement.prototype) === SVGGraphicsElement.prototype,
          Object.getPrototypeOf(SVGTextPositioningElement.prototype) === SVGTextContentElement.prototype,
          Object.getPrototypeOf(SVGLinearGradientElement.prototype) === SVGGradientElement.prototype,
        ],
      });
    })();
  `);
  assert.deepEqual(JSON.parse(result), {
    rows: svgConstructorCases.map(([tag, name, bases]) => ({
      tag,
      name,
      localName: tag,
      tagName: tag,
      type: 'function',
      ctorName: name,
      instance: true,
      svgInstance: true,
      stringTag: `[object ${name}]`,
      baseInstances: bases.map((base) => [base, 'function', true]),
      constructError: ['TypeError', `Failed to construct '${name}': Illegal constructor`],
    })),
    baseRows: svgBaseConstructors.map((name) => ({
      name,
      type: 'function',
      ctorName: name,
      prototypeTag: `[object ${name}]`,
      constructError: ['TypeError', `Failed to construct '${name}': Illegal constructor`],
    })),
    lowerBlend: ['feblend', '[object SVGElement]', false, true],
    tagLookups: [1, 1],
    prototypeParents: [true, true, true, true],
  });
  realm.destroy();
});

test('webapi core exposes SVG value and animated facades', async () => {
  const { realm } = await installCore();
  const svgValueNames = [
    'SVGAngle',
    'SVGLength',
    'SVGNumber',
    'SVGStringList',
    'SVGLengthList',
    'SVGNumberList',
    'SVGPoint',
    'SVGPointList',
    'SVGMatrix',
    'SVGRect',
    'SVGTransform',
    'SVGTransformList',
    'SVGPreserveAspectRatio',
    'SVGAnimatedAngle',
    'SVGAnimatedBoolean',
    'SVGAnimatedEnumeration',
    'SVGAnimatedInteger',
    'SVGAnimatedLength',
    'SVGAnimatedLengthList',
    'SVGAnimatedNumber',
    'SVGAnimatedNumberList',
    'SVGAnimatedPreserveAspectRatio',
    'SVGAnimatedRect',
    'SVGAnimatedString',
    'SVGAnimatedTransformList',
    'SVGUnitTypes',
  ];
  const result = realm.evalClassic(`
    (() => {
      const names = ${JSON.stringify(svgValueNames)};
      return JSON.stringify({
        rows: names.map((name) => {
          const ctor = globalThis[name];
          let constructed;
          try {
            new ctor();
            constructed = ['ok'];
          } catch (error) {
            constructed = [error.name, error.message];
          }
          return [
            name,
            typeof ctor,
            ctor.name,
            Object.prototype.toString.call(ctor.prototype),
            constructed,
          ];
        }),
        constants: {
          angle: [SVGAngle.SVG_ANGLETYPE_DEG, SVGAngle.prototype.SVG_ANGLETYPE_GRAD],
          length: [SVGLength.SVG_LENGTHTYPE_PX, SVGLength.prototype.SVG_LENGTHTYPE_PC],
          preserveAspectRatio: [
            SVGPreserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMIDYMID,
            SVGPreserveAspectRatio.prototype.SVG_MEETORSLICE_SLICE,
          ],
          transform: [SVGTransform.SVG_TRANSFORM_MATRIX, SVGTransform.prototype.SVG_TRANSFORM_SKEWY],
          unitTypes: [SVGUnitTypes.SVG_UNIT_TYPE_USERSPACEONUSE, SVGUnitTypes.prototype.SVG_UNIT_TYPE_OBJECTBOUNDINGBOX],
        },
      });
    })();
  `);
  assert.deepEqual(JSON.parse(result), {
    rows: svgValueNames.map((name) => [
      name,
      'function',
      name,
      `[object ${name}]`,
      name === 'SVGUnitTypes'
        ? ['TypeError', 'Illegal constructor']
        : ['TypeError', `Failed to construct '${name}': Illegal constructor`],
    ]),
    constants: {
      angle: [2, 4],
      length: [5, 10],
      preserveAspectRatio: [6, 2],
      transform: [1, 6],
      unitTypes: [1, 2],
    },
  });
  realm.destroy();
});

test('webapi core exposes canvas facades', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    (() => {
      const canvas = document.createElement('canvas');
      canvas.width = 20;
      canvas.height = 10;
      const context = canvas.getContext('2d');
      const sameContext = canvas.getContext('2d');
      context.fillStyle = 'red';
      const metrics = context.measureText('abc');
      const imageData = context.createImageData(2, 3);
      const explicitImageDataBytes = new Uint8ClampedArray(8);
      const explicitImageData = new ImageData(explicitImageDataBytes, 1, 2);
      const floatImageData = new ImageData(1, 1, { colorSpace: 'display-p3', pixelFormat: 'rgba-float16' });
      const gradient = context.createLinearGradient(0, 0, 1, 1);
      gradient.addColorStop(0, 'red');
      const pattern = context.createPattern(canvas, 'repeat');
      const bitmapContext = canvas.getContext('bitmaprenderer');
      const offscreen = canvas.transferControlToOffscreen();
      const offscreenContext = offscreen.getContext('2d');
      const bitmap = offscreen.transferToImageBitmap();
      const bitmapSize = [bitmap.width, bitmap.height];
      bitmap.close();
      const path = new Path2D();
      return JSON.stringify([
        Object.prototype.toString.call(canvas),
        canvas instanceof HTMLCanvasElement,
        canvas.width,
        canvas.height,
        Object.prototype.toString.call(context),
        context instanceof CanvasRenderingContext2D,
        context.canvas === canvas,
        sameContext === context,
        context.fillStyle,
        Object.prototype.toString.call(metrics),
        metrics instanceof TextMetrics,
        metrics.width,
        Object.prototype.toString.call(imageData),
        ImageData.length,
        imageData.width,
        imageData.height,
        imageData.data.length,
        imageData.pixelFormat,
        Object.getOwnPropertyNames(imageData),
        [
          Object.getOwnPropertyDescriptor(imageData, 'data').enumerable,
          Object.getOwnPropertyDescriptor(imageData, 'data').configurable,
          Object.getOwnPropertyDescriptor(imageData, 'data').writable,
          Object.getOwnPropertyDescriptor(imageData, 'data').value === imageData.data,
        ],
        [
          Object.getOwnPropertyDescriptor(ImageData.prototype, 'data').enumerable,
          Object.getOwnPropertyDescriptor(ImageData.prototype, 'data').configurable,
          typeof Object.getOwnPropertyDescriptor(ImageData.prototype, 'data').get,
        ],
        Object.getOwnPropertyNames(ImageData.prototype),
        explicitImageData.width,
        explicitImageData.height,
        explicitImageData.colorSpace,
        explicitImageData.pixelFormat,
        explicitImageData.data === explicitImageDataBytes,
        floatImageData.colorSpace,
        floatImageData.pixelFormat,
        floatImageData.data.constructor.name,
        (() => { try { new ImageData(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new ImageData(new Uint8ClampedArray(7), 1); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new ImageData(1, 1, { colorSpace: 'bad' }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new ImageData(new Uint8ClampedArray(4), 1, 1, { pixelFormat: 'rgba-float16' }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        Object.prototype.toString.call(gradient),
        gradient instanceof CanvasGradient,
        Object.prototype.toString.call(pattern),
        pattern instanceof CanvasPattern,
        Object.prototype.toString.call(bitmapContext),
        bitmapContext instanceof ImageBitmapRenderingContext,
        Object.prototype.toString.call(offscreen),
        offscreen.width,
        offscreen.height,
        Object.prototype.toString.call(offscreenContext),
        offscreenContext instanceof OffscreenCanvasRenderingContext2D,
        offscreenContext instanceof CanvasRenderingContext2D,
        Object.prototype.toString.call(bitmap),
        bitmapSize,
        [bitmap.width, bitmap.height],
        Object.prototype.toString.call(path),
        path instanceof Path2D,
        canvas.toDataURL('image/png'),
        canvas.getContext('webgl'),
        (() => { try { new CanvasRenderingContext2D(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new CanvasGradient(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new TextMetrics(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new ImageBitmap(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ]);
    })();
  `);
  assert.deepEqual(JSON.parse(result), [
    '[object HTMLCanvasElement]',
    true,
    20,
    10,
    '[object CanvasRenderingContext2D]',
    true,
    true,
    true,
    'red',
    '[object TextMetrics]',
    true,
    30,
    '[object ImageData]',
    2,
    2,
    3,
    24,
    'rgba-unorm8',
    ['data'],
    [true, true, false, true],
    [true, true, 'function'],
    ['width', 'height', 'colorSpace', 'data', 'pixelFormat', 'constructor'],
    1,
    2,
    'srgb',
    'rgba-unorm8',
    true,
    'display-p3',
    'rgba-float16',
    'Float16Array',
    ['TypeError', "Failed to construct 'ImageData': 2 arguments required, but only 0 present."],
    [
      'InvalidStateError',
      "Failed to construct 'ImageData': The input data length is not a multiple of 4.",
    ],
    [
      'TypeError',
      "Failed to construct 'ImageData': Failed to read the 'colorSpace' property from 'ImageDataSettings': The provided value 'bad' is not a valid enum value of type PredefinedColorSpace.",
    ],
    [
      'InvalidStateError',
      "Failed to construct 'ImageData': Uint8ClampedArray must use rgba-unorm8 pixelFormat.",
    ],
    '[object CanvasGradient]',
    true,
    '[object CanvasPattern]',
    true,
    '[object ImageBitmapRenderingContext]',
    true,
    '[object OffscreenCanvas]',
    20,
    10,
    '[object OffscreenCanvasRenderingContext2D]',
    true,
    true,
    '[object ImageBitmap]',
    [20, 10],
    [0, 0],
    '[object Path2D]',
    true,
    'data:image/png;base64,',
    null,
    ['TypeError', "Failed to construct 'CanvasRenderingContext2D': Illegal constructor"],
    ['TypeError', "Failed to construct 'CanvasGradient': Illegal constructor"],
    ['TypeError', "Failed to construct 'TextMetrics': Illegal constructor"],
    ['TypeError', "Failed to construct 'ImageBitmap': Illegal constructor"],
  ]);
  realm.destroy();
});

test('webapi core exposes createImageBitmap facade', async () => {
  const { realm } = await installCore();
  realm.evalClassic(`
    globalThis.createdBitmapResult = '';
    createImageBitmap(new ImageData(2, 2), { resizeWidth: 3, resizeHeight: 4 }).then((bitmap) => {
      const initial = [Object.prototype.toString.call(bitmap), bitmap instanceof ImageBitmap, bitmap.width, bitmap.height];
      bitmap.close();
      globalThis.createdBitmapResult = JSON.stringify([
        typeof createImageBitmap,
        Object.prototype.toString.call(createImageBitmap(new ImageData(1, 1))),
        ...initial,
        bitmap.width,
        bitmap.height,
        (() => { try { createImageBitmap(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ]);
    });
  `);
  for (let i = 0; i < 8; i++) realm.drainJobs();
  assert.deepEqual(JSON.parse(realm.evalClassic('createdBitmapResult')), [
    'function',
    '[object Promise]',
    '[object ImageBitmap]',
    true,
    3,
    4,
    0,
    0,
    [
      'TypeError',
      "Failed to execute 'createImageBitmap' on 'Window': 1 argument required, but only 0 present.",
    ],
  ]);
  realm.destroy();
});

test('webapi core exposes WebRTC policy facades', async () => {
  const { realm } = await installCore();
  realm.evalClassic(`
    globalThis.rtcPolicyResult = '';
    (async () => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:example.test' }] });
      const dataChannel = pc.createDataChannel('zp-data', { ordered: false, protocol: 'zp', negotiated: true, id: 7 });
      let sendError = '';
      try { dataChannel.send('payload'); } catch (error) { sendError = error.name; }
      const offerError = await pc.createOffer().catch((error) => error.name);
      const answerError = await pc.createAnswer().catch((error) => error.name);
      const certificateError = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' }).catch((error) => error.name);
      const stats = await pc.getStats();
      pc.close();
      const illegal = [
        RTCDataChannel,
        RTCDtlsTransport,
        RTCIceTransport,
        RTCSctpTransport,
        RTCDTMFSender,
        RTCRtpReceiver,
        RTCRtpSender,
        RTCRtpTransceiver,
        RTCStatsReport,
        RTCCertificate,
        RTCEncodedAudioFrame,
        RTCEncodedVideoFrame,
        RTCRtpScriptTransform,
      ].map((Ctor) => {
        try { new Ctor(); return ['ok']; } catch (error) { return [Ctor.name, error.name, error.message]; }
      });
      rtcPolicyResult = JSON.stringify({
        peer: [
          typeof RTCPeerConnection,
          webkitRTCPeerConnection === RTCPeerConnection,
          Object.prototype.toString.call(pc),
          pc instanceof RTCPeerConnection,
          pc instanceof EventTarget,
          pc.getConfiguration().iceServers[0].urls,
          pc.getReceivers().length,
          pc.getSenders().length,
          pc.getTransceivers().length,
          offerError,
          answerError,
          certificateError,
          pc.connectionState,
          pc.signalingState,
        ],
        dataChannel: [
          Object.prototype.toString.call(dataChannel),
          dataChannel instanceof RTCDataChannel,
          dataChannel instanceof EventTarget,
          dataChannel.label,
          dataChannel.ordered,
          dataChannel.protocol,
          dataChannel.negotiated,
          dataChannel.id,
          dataChannel.readyState,
          sendError,
        ],
        stats: [
          Object.prototype.toString.call(stats),
          stats instanceof RTCStatsReport,
          stats instanceof Map,
          stats.size,
          typeof stats.forEach,
        ],
        illegal,
      });
    })();
  `);
  for (let i = 0; i < 8; i++) realm.drainJobs();
  assert.deepEqual(JSON.parse(realm.evalClassic('rtcPolicyResult')), {
    peer: [
      'function',
      true,
      '[object RTCPeerConnection]',
      true,
      true,
      'stun:example.test',
      0,
      0,
      0,
      'NotAllowedError',
      'NotAllowedError',
      'NotAllowedError',
      'closed',
      'closed',
    ],
    dataChannel: [
      '[object RTCDataChannel]',
      true,
      true,
      'zp-data',
      false,
      'zp',
      true,
      7,
      'closed',
      'InvalidStateError',
    ],
    stats: ['[object RTCStatsReport]', true, true, 0, 'function'],
    illegal: [
      ['RTCDataChannel', 'TypeError', 'Illegal constructor'],
      ['RTCDtlsTransport', 'TypeError', 'Illegal constructor'],
      ['RTCIceTransport', 'TypeError', 'Illegal constructor'],
      ['RTCSctpTransport', 'TypeError', 'Illegal constructor'],
      ['RTCDTMFSender', 'TypeError', 'Illegal constructor'],
      ['RTCRtpReceiver', 'TypeError', 'Illegal constructor'],
      ['RTCRtpSender', 'TypeError', 'Illegal constructor'],
      ['RTCRtpTransceiver', 'TypeError', 'Illegal constructor'],
      ['RTCStatsReport', 'TypeError', 'Illegal constructor'],
      ['RTCCertificate', 'TypeError', 'Illegal constructor'],
      [
        'RTCEncodedAudioFrame',
        'TypeError',
        "Failed to construct 'RTCEncodedAudioFrame': Illegal constructor",
      ],
      [
        'RTCEncodedVideoFrame',
        'TypeError',
        "Failed to construct 'RTCEncodedVideoFrame': Illegal constructor",
      ],
      [
        'RTCRtpScriptTransform',
        'TypeError',
        "Failed to construct 'RTCRtpScriptTransform': parameter 1 is not of type 'Worker'.",
      ],
    ],
  });
  realm.destroy();
});

test('webapi core exposes worker and WebSocket stream policy facades', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    (() => {
      const construct = (Ctor, ...args) => {
        try {
          new Ctor(...args);
          return ['ok'];
        } catch (error) {
          return [error.name, error.message, Object.prototype.toString.call(Ctor.prototype)];
        }
      };
      const defaultSocketError = new WebSocketError();
      const socketError = new WebSocketError('closed', { closeCode: 3000, reason: 'policy' });
      let invalidSocketError;
      try {
        new WebSocketError('bad', { closeCode: 1006 });
        invalidSocketError = ['ok'];
      } catch (error) {
        invalidSocketError = [error.name, error.message];
      }
      return JSON.stringify({
        workers: [
          typeof Worker,
          typeof SharedWorker,
          Worker.name,
          SharedWorker.name,
          construct(Worker, 'worker.js'),
          construct(SharedWorker, 'worker.js'),
        ],
        websocketStream: [
          typeof WebSocketStream,
          WebSocketStream.name,
          construct(WebSocketStream, 'wss://example.test/socket'),
          construct(WebSocketStream, 'https://example.test/socket'),
        ],
        websocketError: [
          typeof WebSocketError,
          WebSocketError.name,
          Object.prototype.toString.call(defaultSocketError),
          defaultSocketError.name,
          defaultSocketError.message,
          defaultSocketError.closeCode,
          defaultSocketError.reason,
          socketError instanceof WebSocketError,
          socketError instanceof DOMException,
          socketError.message,
          socketError.closeCode,
          socketError.reason,
          invalidSocketError,
        ],
      });
    })();
  `);
  assert.deepEqual(JSON.parse(result), {
    workers: [
      'function',
      'function',
      'Worker',
      'SharedWorker',
      ['NotSupportedError', 'Worker construction is disabled by policy.', '[object Worker]'],
      [
        'NotSupportedError',
        'SharedWorker construction is disabled by policy.',
        '[object SharedWorker]',
      ],
    ],
    websocketStream: [
      'function',
      'WebSocketStream',
      ['NotSupportedError', 'WebSocketStream is disabled by policy.', '[object WebSocketStream]'],
      [
        'SyntaxError',
        "Failed to construct 'WebSocketStream': The URL protocol must be 'ws:' or 'wss:'.",
        '[object WebSocketStream]',
      ],
    ],
    websocketError: [
      'function',
      'WebSocketError',
      '[object WebSocketError]',
      'WebSocketError',
      '',
      null,
      '',
      true,
      true,
      'closed',
      3000,
      'policy',
      ['InvalidAccessError', 'The close code must be either 1000, or between 3000 and 4999.'],
    ],
  });
  realm.destroy();
});

test('webapi core exposes background fetch push and sync facades', async () => {
  const { realm } = await installCore();
  const backgroundNames = [
    'BackgroundFetchManager',
    'BackgroundFetchRecord',
    'BackgroundFetchRegistration',
    'PushManager',
    'PushSubscription',
    'PushSubscriptionOptions',
    'SyncManager',
    'PeriodicSyncManager',
  ];
  const result = realm.evalClassic(`
    (() => {
      const names = ${JSON.stringify(backgroundNames)};
      return JSON.stringify(names.map((name) => {
        const Ctor = globalThis[name];
        try {
          new Ctor();
          return [name, 'ok'];
        } catch (error) {
          return [
            name,
            typeof Ctor,
            Ctor.name,
            error.name,
            error.message,
            Object.prototype.toString.call(Ctor.prototype),
          ];
        }
      }));
    })();
  `);
  assert.deepEqual(
    JSON.parse(result),
    backgroundNames.map((name) => [
      name,
      'function',
      name,
      'TypeError',
      `Failed to construct '${name}': Illegal constructor`,
      `[object ${name}]`,
    ]),
  );
  realm.destroy();
});

test('webapi core exposes emerging browser global facades', async () => {
  const { realm } = await installCore();
  const illegalNames = [
    'AnimationTrigger',
    'CSSFunctionDeclarations',
    'CSSFunctionDescriptors',
    'CSSFunctionRule',
    'CSSPositionTryDescriptors',
    'Fence',
    'FencedFrameConfig',
    'GamepadHapticActuator',
    'IDBRecord',
    'Ink',
    'NotRestoredReasonDetails',
    'NotRestoredReasons',
    'Scheduling',
    'SharedStorage',
    'SharedStorageAppendMethod',
    'SharedStorageClearMethod',
    'SharedStorageDeleteMethod',
    'SharedStorageModifierMethod',
    'SharedStorageSetMethod',
    'SharedStorageWorklet',
    'SnapEvent',
    'Subscriber',
    'TimelineTriggerRange',
    'TimelineTriggerRangeList',
    'WebGLObject',
    'Viewport',
  ];
  const result = realm.evalClassic(`
    (() => {
      const illegalNames = ${JSON.stringify(illegalNames)};
      const editContext = new EditContext();
      editContext.updateText(0, 0, 'hello');
      editContext.updateSelection(1, 4);
      const interestSource = document.createElement('button');
      const interest = new InterestEvent('interest', { source: interestSource, action: 'show' });
      const generator = new MediaStreamTrackGenerator({ kind: 'video' });
      const processor = new MediaStreamTrackProcessor({ track: generator });
      const observableSeen = [];
      const observableSub = new Observable((subscriber) => {
        subscriber.next(2);
        subscriber.complete();
        subscriber.next(9);
        return () => observableSeen.push('cleanup');
      }).map((value) => value + 1).subscribe({
        next: (value) => observableSeen.push(value),
        complete: () => observableSeen.push('done'),
      });
      const cancelSeen = [];
      const cancelSub = new Observable((subscriber) => {
        subscriber.next('live');
        return () => cancelSeen.push('cleanup');
      }).subscribe((value) => cancelSeen.push(value));
      const cancelBefore = cancelSub.closed;
      cancelSub.unsubscribe();
      const ofSeen = [];
      Observable.of(1, 2, 3).filter((value) => value > 1).subscribe((value) => ofSeen.push(value));
      const origin = new Origin('https://origin.test');
      const profiler = new Profiler({ sampleInterval: 7 });
      const sanitizer = new Sanitizer({ elements: ['p'] });
      sanitizer.allowElement('span').removeUnsafe().setComments(false).setDataAttributes(true);
      const trigger = new TimelineTrigger({ rangeStart: 'entry 0%', rangeEnd: 'exit 100%' });
      const pointTarget = document.createElement('button');
      pointTarget.id = 'point-target';
      document.body.append(pointTarget);
      __zpUpdateViewport({ layout: { [pointTarget.__zpNodeId]: { x: 1, y: 2, width: 3, height: 4 } } });
      const pointElement = document.elementFromPoint(1, 1);
      const pointElements = document.elementsFromPoint(1, 1);
      const caret = document.caretPositionFromPoint(1, 1);
      const caretRange = document.caretRangeFromPoint(1, 1);
      let newCaret;
      try {
        new CaretPosition();
        newCaret = ['ok'];
      } catch (error) {
        newCaret = [error.name, error.message];
      }
      return JSON.stringify({
        illegal: illegalNames.map((name) => {
          const Ctor = globalThis[name];
          try {
            new Ctor();
            return [name, 'ok'];
          } catch (error) {
            return [name, typeof Ctor, Ctor.name, error.name, error.message, Object.prototype.toString.call(Ctor.prototype)];
          }
        }),
        constructible: [
          [Object.prototype.toString.call(editContext), editContext instanceof EventTarget, editContext.text, editContext.selectionStart, editContext.selectionEnd, editContext.attachedElements().length],
          [Object.prototype.toString.call(interest), interest instanceof Event, interest.type, interest.source === interestSource, 'action' in interest],
          [Object.prototype.toString.call(generator), generator.kind, Object.prototype.toString.call(generator.writable), generator.readyState],
          [Object.prototype.toString.call(processor), Object.prototype.toString.call(processor.readable)],
          [Object.prototype.toString.call(origin), String(origin), origin.toJSON()],
          [Object.prototype.toString.call(profiler), profiler.sampleInterval, profiler.stopped],
          [Object.prototype.toString.call(sanitizer), sanitizer.get().elements.join('|'), sanitizer.get().removeUnsafe, sanitizer.get().comments, sanitizer.get().dataAttributes],
          [Object.prototype.toString.call(trigger), trigger.rangeStart, trigger.rangeEnd],
          [observableSeen, Object.prototype.toString.call(observableSub), observableSub instanceof Subscriber, observableSub.closed, cancelSeen, cancelBefore, cancelSub.closed, ofSeen],
          [
            Object.prototype.toString.call(caret),
            caret instanceof CaretPosition,
            caret.offsetNode === pointTarget,
            caret.offset,
            Object.prototype.toString.call(caret.getClientRect()),
            caret.getClientRect().toJSON(),
            pointElement === pointTarget,
            pointElements[0] === pointTarget,
            pointElements.includes(document.body),
            document.elementFromPoint(-1, 1),
            document.elementsFromPoint(-1, 1).length,
            document.caretPositionFromPoint(-1, 1),
            caretRange instanceof Range,
            caretRange.startContainer === pointTarget,
            caretRange.collapsed,
            document.caretRangeFromPoint(-1, 1),
            newCaret,
          ],
        ],
        singletons: [
          Object.prototype.toString.call(styleMedia),
          styleMedia.type,
          styleMedia.matchMedium('(min-width: 1px)'),
          Object.prototype.toString.call(chrome),
          typeof chrome.loadTimes,
          fence,
          Object.prototype.toString.call(viewport),
          typeof webkitRequestFileSystem,
          typeof webkitResolveLocalFileSystemURL,
          'event' in globalThis,
          globalThis.event,
        ],
      });
    })();
  `);
  assert.deepEqual(JSON.parse(result), {
    illegal: illegalNames.map((name) => [
      name,
      'function',
      name,
      'TypeError',
      `Failed to construct '${name}': Illegal constructor`,
      `[object ${name}]`,
    ]),
    constructible: [
      ['[object EditContext]', true, 'hello', 1, 4, 0],
      ['[object InterestEvent]', true, 'interest', true, false],
      ['[object MediaStreamTrackGenerator]', 'video', '[object WritableStream]', 'ended'],
      ['[object MediaStreamTrackProcessor]', '[object ReadableStream]'],
      ['[object Origin]', 'https://origin.test', 'https://origin.test'],
      ['[object Profiler]', 7, false],
      ['[object Sanitizer]', 'p|span', true, false, true],
      ['[object TimelineTrigger]', 'entry 0%', 'exit 100%'],
      [
        [3, 'done', 'cleanup'],
        '[object Subscriber]',
        true,
        true,
        ['live', 'cleanup'],
        false,
        true,
        [2, 3],
      ],
      [
        '[object CaretPosition]',
        true,
        true,
        0,
        '[object DOMRect]',
        { x: 1, y: 2, width: 3, height: 4, top: 2, right: 4, bottom: 6, left: 1 },
        true,
        true,
        true,
        null,
        0,
        null,
        true,
        true,
        true,
        null,
        ['TypeError', "Failed to construct 'CaretPosition': Illegal constructor"],
      ],
    ],
    singletons: [
      '[object StyleMedia]',
      'screen',
      true,
      '[object Object]',
      'function',
      null,
      '[object Viewport]',
      'function',
      'function',
      true,
      null,
    ],
  });
  realm.destroy();
});
test('webapi core exposes WebGL policy facades', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    (() => {
      const contextEvent = new WebGLContextEvent('webglcontextlost', { statusMessage: 'lost', bubbles: true, cancelable: true, composed: true });
      const defaultContextEvent = new WebGLContextEvent('webglcontextrestored');
      const contextEventDescriptor = Object.getOwnPropertyDescriptor(WebGLContextEvent.prototype, 'statusMessage');
      const contextEventGlobal = Object.getOwnPropertyDescriptor(globalThis, 'WebGLContextEvent');
      const captureContextEventError = (callback) => {
        try {
          callback();
          return ['ok'];
        } catch (error) {
          return [error.name, error.message];
        }
      };
      return JSON.stringify([
        typeof WebGLRenderingContext,
        Object.prototype.toString.call(WebGLRenderingContext.prototype),
        WebGLRenderingContext.TRIANGLES,
        WebGLRenderingContext.prototype.TRIANGLES,
        WebGLRenderingContext.NO_ERROR,
        WebGL2RenderingContext.prototype instanceof WebGLRenderingContext,
        WebGL2RenderingContext.INVALID_INDEX,
        Object.prototype.toString.call(Object.create(WebGLBuffer.prototype)),
        Object.prototype.toString.call(Object.create(WebGLFramebuffer.prototype)),
        Object.prototype.toString.call(Object.create(WebGLProgram.prototype)),
        Object.prototype.toString.call(Object.create(WebGLRenderbuffer.prototype)),
        Object.prototype.toString.call(Object.create(WebGLShader.prototype)),
        Object.prototype.toString.call(Object.create(WebGLTexture.prototype)),
        Object.prototype.toString.call(Object.create(WebGLUniformLocation.prototype)),
        Object.prototype.toString.call(Object.create(WebGLVertexArrayObject.prototype)),
        Object.prototype.toString.call(Object.create(WebGLSampler.prototype)),
        Object.prototype.toString.call(Object.create(WebGLQuery.prototype)),
        Object.prototype.toString.call(Object.create(WebGLSync.prototype)),
        Object.prototype.toString.call(Object.create(WebGLTransformFeedback.prototype)),
        Object.prototype.toString.call(Object.create(WebGLActiveInfo.prototype)),
        Object.prototype.toString.call(Object.create(WebGLShaderPrecisionFormat.prototype)),
        Object.prototype.toString.call(contextEvent),
        contextEvent instanceof WebGLContextEvent,
        contextEvent instanceof Event,
        contextEvent.type,
        contextEvent.bubbles,
        contextEvent.cancelable,
        contextEvent.composed,
        contextEvent.statusMessage,
        defaultContextEvent.statusMessage,
        Object.getOwnPropertyNames(WebGLContextEvent.prototype),
        [contextEventDescriptor.enumerable, contextEventDescriptor.configurable, typeof contextEventDescriptor.get, contextEventDescriptor.set],
        [contextEventGlobal.enumerable, contextEventGlobal.configurable, contextEventGlobal.writable],
        Object.getOwnPropertyDescriptor(WebGLContextEvent, 'prototype').writable,
        Object.prototype.hasOwnProperty.call(WebGLContextEvent, Symbol.hasInstance),
        Object.prototype.hasOwnProperty.call(contextEvent, 'statusMessage'),
        captureContextEventError(() => WebGLContextEvent('webglcontextlost')),
        captureContextEventError(() => new WebGLContextEvent()),
        captureContextEventError(() => new WebGLContextEvent(Symbol('webglcontextlost'))),
        captureContextEventError(() => new WebGLContextEvent('webglcontextlost', { statusMessage: Symbol('lost') })),
        (() => { try { new WebGLRenderingContext(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new WebGLBuffer(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new WebGLActiveInfo(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ]);
    })();
  `);
  assert.deepEqual(JSON.parse(result), [
    'function',
    '[object WebGLRenderingContext]',
    4,
    4,
    0,
    true,
    4294967295,
    '[object WebGLBuffer]',
    '[object WebGLFramebuffer]',
    '[object WebGLProgram]',
    '[object WebGLRenderbuffer]',
    '[object WebGLShader]',
    '[object WebGLTexture]',
    '[object WebGLUniformLocation]',
    '[object WebGLVertexArrayObject]',
    '[object WebGLSampler]',
    '[object WebGLQuery]',
    '[object WebGLSync]',
    '[object WebGLTransformFeedback]',
    '[object WebGLActiveInfo]',
    '[object WebGLShaderPrecisionFormat]',
    '[object WebGLContextEvent]',
    true,
    true,
    'webglcontextlost',
    true,
    true,
    true,
    'lost',
    '',
    ['statusMessage', 'constructor'],
    [true, true, 'function', null],
    [false, true, true],
    false,
    false,
    false,
    [
      'TypeError',
      "Failed to construct 'WebGLContextEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
    ],
    [
      'TypeError',
      "Failed to construct 'WebGLContextEvent': 1 argument required, but only 0 present.",
    ],
    [
      'TypeError',
      "Failed to construct 'WebGLContextEvent': Cannot convert a Symbol value to a string",
    ],
    [
      'TypeError',
      "Failed to construct 'WebGLContextEvent': Failed to read the 'statusMessage' property from 'WebGLContextEventInit': Cannot convert a Symbol value to a string",
    ],
    ['TypeError', "Failed to construct 'WebGLRenderingContext': Illegal constructor"],
    ['TypeError', "Failed to construct 'WebGLBuffer': Illegal constructor"],
    ['TypeError', "Failed to construct 'WebGLActiveInfo': Illegal constructor"],
  ]);
  realm.destroy();
});

test('webapi core exposes WebCodecs data facades', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    (() => {
      const audioChunk = new EncodedAudioChunk({ type: 'key', timestamp: 10, duration: 5, data: new Uint8Array([1, 2, 3]) });
      const videoChunk = new EncodedVideoChunk({ type: 'delta', timestamp: 20, data: new Uint8Array([4, 5]) });
      const audioCopy = new Uint8Array(3);
      audioChunk.copyTo(audioCopy);
      const colorSpace = new VideoColorSpace({ primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true });
      const audioData = new AudioData({ format: 'f32', sampleRate: 48000, numberOfFrames: 2, numberOfChannels: 1, timestamp: 30, duration: 40, data: new Uint8Array([1, 2, 3, 4]) });
      const audioClone = audioData.clone();
      audioData.close();
      const videoFrame = new VideoFrame(new ImageData(2, 2), { format: 'RGBA', timestamp: 50, duration: 60, colorSpace });
      const frameCopy = new Uint8Array(videoFrame.allocationSize());
      videoFrame.copyTo(frameCopy);
      const frameClone = videoFrame.clone();
      videoFrame.close();
      return JSON.stringify([
        Object.prototype.toString.call(audioChunk),
        audioChunk.type,
        audioChunk.timestamp,
        audioChunk.duration,
        audioChunk.byteLength,
        Array.from(audioCopy).join(','),
        Object.getOwnPropertyNames(audioChunk),
        Object.getOwnPropertyNames(EncodedAudioChunk.prototype),
        [
          Object.getOwnPropertyDescriptor(EncodedAudioChunk.prototype, 'byteLength').enumerable,
          Object.getOwnPropertyDescriptor(EncodedAudioChunk.prototype, 'byteLength').configurable,
          typeof Object.getOwnPropertyDescriptor(EncodedAudioChunk.prototype, 'byteLength').get,
          Object.getOwnPropertyDescriptor(EncodedAudioChunk.prototype, 'copyTo').enumerable,
          Object.getOwnPropertyDescriptor(EncodedAudioChunk.prototype, 'copyTo').writable,
          Object.getOwnPropertyDescriptor(EncodedAudioChunk.prototype, 'copyTo').value.length,
        ],
        Object.prototype.toString.call(videoChunk),
        videoChunk.type,
        videoChunk.duration,
        videoChunk.byteLength,
        Object.getOwnPropertyNames(videoChunk),
        Object.getOwnPropertyNames(EncodedVideoChunk.prototype),
        Object.prototype.toString.call(colorSpace),
        Object.getOwnPropertyNames(colorSpace),
        Object.getOwnPropertyNames(VideoColorSpace.prototype),
        JSON.stringify(colorSpace.toJSON()),
        (() => { try { new VideoColorSpace({ primaries: 'bad' }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new VideoColorSpace(null); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        colorSpace.toJSON(),
        Object.prototype.toString.call(audioData),
        audioData.format,
        audioData.allocationSize(),
        audioClone.sampleRate,
        audioClone.numberOfFrames,
        Object.prototype.toString.call(videoFrame),
        videoFrame.codedWidth,
        videoFrame.allocationSize(),
        frameCopy.length,
        frameClone.timestamp,
        frameClone.colorSpace.primaries,
        (() => { try { new EncodedAudioChunk(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new EncodedVideoChunk({ type: 'bad', timestamp: 1, data: new Uint8Array() }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { audioChunk.copyTo(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { audioChunk.copyTo(new Uint8Array(2)); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new EncodedAudioChunk({ type: 'key', data: new Uint8Array([1]) }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new EncodedAudioChunk({ type: 'key', timestamp: 1 }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new AudioData(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new VideoFrame(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ]);
    })();
  `);
  assert.deepEqual(JSON.parse(result), [
    '[object EncodedAudioChunk]',
    'key',
    10,
    5,
    3,
    '1,2,3',
    [],
    ['type', 'timestamp', 'byteLength', 'duration', 'copyTo', 'constructor'],
    [true, true, 'function', true, true, 1],
    '[object EncodedVideoChunk]',
    'delta',
    null,
    2,
    [],
    ['type', 'timestamp', 'duration', 'byteLength', 'copyTo', 'constructor'],
    '[object VideoColorSpace]',
    [],
    ['primaries', 'transfer', 'matrix', 'fullRange', 'toJSON', 'constructor'],
    '{"fullRange":true,"matrix":"rgb","primaries":"bt709","transfer":"iec61966-2-1"}',
    [
      'TypeError',
      "Failed to construct 'VideoColorSpace': Failed to read the 'primaries' property from 'VideoColorSpaceInit': The provided value 'bad' is not a valid enum value of type VideoColorPrimaries.",
    ],
    [
      'TypeError',
      "Failed to construct 'VideoColorSpace': The provided value is not of type 'VideoColorSpaceInit'.",
    ],
    { fullRange: true, matrix: 'rgb', primaries: 'bt709', transfer: 'iec61966-2-1' },
    '[object AudioData]',
    null,
    0,
    48000,
    2,
    '[object VideoFrame]',
    0,
    0,
    16,
    50,
    'bt709',
    [
      'TypeError',
      "Failed to construct 'EncodedAudioChunk': The provided value is not of type 'EncodedAudioChunkInit'.",
    ],
    [
      'TypeError',
      "Failed to construct 'EncodedVideoChunk': Failed to read the 'type' property from 'EncodedVideoChunkInit': The provided value 'bad' is not a valid enum value of type EncodedVideoChunkType.",
    ],
    [
      'TypeError',
      "Failed to execute 'copyTo' on 'EncodedAudioChunk': 1 argument required, but only 0 present.",
    ],
    [
      'TypeError',
      "Failed to execute 'copyTo' on 'EncodedAudioChunk': destination is not large enough.",
    ],
    [
      'TypeError',
      "Failed to construct 'EncodedAudioChunk': Failed to read the 'timestamp' property from 'EncodedAudioChunkInit': Required member is undefined.",
    ],
    [
      'TypeError',
      "Failed to construct 'EncodedAudioChunk': Failed to read the 'data' property from 'EncodedAudioChunkInit': Required member is undefined.",
    ],
    ['TypeError', "Failed to construct 'AudioData': 1 argument required, but only 0 present."],
    ['TypeError', "Failed to construct 'VideoFrame': 1 argument required, but only 0 present."],
  ]);
  realm.destroy();
});

test('webapi core exposes MediaSource facades', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    (() => {
      const source = new MediaSource();
      source.duration = 12.5;
      source.setLiveSeekableRange(2, 10);
      const liveRange = source.__zpLiveSeekableRange.slice();
      const invalidLiveRange = (() => { try { source.setLiveSeekableRange(9, 3); return ['ok']; } catch (error) { return [error.name, error.message]; } })();
      source.clearLiveSeekableRange();
      const clearedLiveRange = source.__zpLiveSeekableRange;
      const buffer = source.addSourceBuffer('video/mp4; codecs="avc1"');
      const events = [];
      buffer.addEventListener('updatestart', () => events.push('updatestart'));
      buffer.addEventListener('update', () => events.push('update'));
      buffer.addEventListener('updateend', () => events.push('updateend'));
      buffer.timestampOffset = 5;
      buffer.appendWindowStart = 1;
      buffer.appendWindowEnd = 9;
      buffer.appendBuffer(new Uint8Array([1, 2, 3]));
      source.endOfStream();
      const list = source.sourceBuffers;
      const activeList = source.activeSourceBuffers;
      const buffered = buffer.buffered;
      source.removeSourceBuffer(buffer);
      return JSON.stringify([
        Object.prototype.toString.call(source),
        source instanceof MediaSource,
        MediaSource.isTypeSupported('video/mp4'),
        MediaSource.isTypeSupported('application/octet-stream'),
        source.readyState,
        source.duration,
        liveRange,
        invalidLiveRange,
        clearedLiveRange,
        Object.prototype.toString.call(source.handle),
        source.handle instanceof MediaSourceHandle,
        Object.prototype.toString.call(buffer),
        buffer instanceof SourceBuffer,
        buffer.mode,
        buffer.updating,
        buffer.timestampOffset,
        buffer.appendWindowStart,
        buffer.appendWindowEnd,
        Object.prototype.toString.call(buffered),
        buffered.length,
        events.join(','),
        Object.prototype.toString.call(list),
        list instanceof SourceBufferList,
        list.length,
        list.item(0) === buffer,
        list[0] === buffer,
        Object.prototype.toString.call(activeList),
        source.sourceBuffers.length,
        (() => { try { new SourceBuffer(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new SourceBufferList(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new TimeRanges(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { buffered.start(0); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { source.addSourceBuffer('application/octet-stream'); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new MediaSourceHandle(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ]);
    })();
  `);
  assert.deepEqual(JSON.parse(result), [
    '[object MediaSource]',
    true,
    true,
    false,
    'ended',
    12.5,
    [2, 10],
    ['InvalidAccessError', 'The live seekable range is not valid.'],
    null,
    '[object MediaSourceHandle]',
    true,
    '[object SourceBuffer]',
    true,
    'segments',
    false,
    5,
    1,
    9,
    '[object TimeRanges]',
    0,
    'updatestart,update,updateend',
    '[object SourceBufferList]',
    true,
    0,
    false,
    false,
    '[object SourceBufferList]',
    0,
    ['TypeError', "Failed to construct 'SourceBuffer': Illegal constructor"],
    ['TypeError', "Failed to construct 'SourceBufferList': Illegal constructor"],
    ['TypeError', "Failed to construct 'TimeRanges': Illegal constructor"],
    ['IndexSizeError', 'The index is not in the allowed range.'],
    ['NotSupportedError', 'The type provided is unsupported.'],
    ['TypeError', "Failed to construct 'MediaSourceHandle': Illegal constructor"],
  ]);
  realm.destroy();
});

test('webapi core exposes text track facades', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    (() => {
      const cue = new VTTCue(1, 2, 'caption');
      cue.id = 'cue-1';
      cue.line = 3;
      cue.position = 45;
      cue.align = 'start';
      const track = Object.create(TextTrack.prototype);
      Object.defineProperties(track, {
        __zpKind: { value: 'subtitles', configurable: true, writable: true },
        __zpLabel: { value: 'English', configurable: true, writable: true },
        __zpLanguage: { value: 'en', configurable: true, writable: true },
        __zpId: { value: 'track-1', configurable: true, writable: true },
        __zpCues: { value: [], configurable: true, writable: true },
      });
      track.mode = 'showing';
      track.addCue(cue);
      const cueList = track.cues;
      const activeCues = track.activeCues;
      const cueHtml = cue.getCueAsHTML();
      const trackList = Object.create(TextTrackList.prototype);
      Object.defineProperty(trackList, '__zpTracks', { value: [track], configurable: true, writable: true });
      track.removeCue(cue);
      return JSON.stringify([
        Object.prototype.toString.call(cue),
        cue instanceof VTTCue,
        cue instanceof TextTrackCue,
        cue.startTime,
        cue.endTime,
        cue.text,
        cue.id,
        cue.line,
        cue.position,
        cue.align,
        Object.prototype.toString.call(cueHtml),
        Object.prototype.toString.call(track),
        track instanceof TextTrack,
        track.kind,
        track.label,
        track.language,
        track.mode,
        Object.prototype.toString.call(cueList),
        cueList instanceof TextTrackCueList,
        cueList.length,
        cueList.item(0) === cue,
        cueList.getCueById('cue-1') === cue,
        Object.prototype.toString.call(activeCues),
        cue.track,
        track.cues.length,
        Object.prototype.toString.call(trackList),
        trackList instanceof TextTrackList,
        trackList.length,
        trackList.item(0) === track,
        trackList.getTrackById('track-1') === track,
        (() => { try { new TextTrackCue(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new TextTrackCueList(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new TextTrack(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new TextTrackList(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ]);
    })();
  `);
  assert.deepEqual(JSON.parse(result), [
    '[object VTTCue]',
    true,
    true,
    1,
    2,
    'caption',
    'cue-1',
    3,
    45,
    'start',
    '[object DocumentFragment]',
    '[object TextTrack]',
    true,
    'subtitles',
    'English',
    'en',
    'showing',
    '[object TextTrackCueList]',
    true,
    0,
    false,
    false,
    '[object TextTrackCueList]',
    null,
    0,
    '[object TextTrackList]',
    true,
    1,
    true,
    true,
    ['TypeError', "Failed to construct 'TextTrackCue': Illegal constructor"],
    ['TypeError', "Failed to construct 'TextTrackCueList': Illegal constructor"],
    ['TypeError', "Failed to construct 'TextTrack': Illegal constructor"],
    ['TypeError', "Failed to construct 'TextTrackList': Illegal constructor"],
  ]);
  realm.destroy();
});

test('webapi core exposes speech facades', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    (() => {
      const utterance = new SpeechSynthesisUtterance('hello');
      utterance.lang = 'en-US';
      utterance.rate = 1.5;
      const synthEvents = [];
      utterance.addEventListener('start', (event) => synthEvents.push(event.type + ':' + event.utterance.text));
      utterance.addEventListener('error', (event) => synthEvents.push(event.type + ':' + event.error));
      utterance.addEventListener('end', (event) => synthEvents.push(event.type + ':' + event.charIndex));
      speechSynthesis.speak(utterance);
      speechSynthesis.pause();
      const paused = speechSynthesis.paused;
      speechSynthesis.resume();
      const grammar = new SpeechGrammar();
      grammar.src = '#JSGF V1.0;';
      grammar.weight = 0.5;
      const grammars = new SpeechGrammarList();
      grammars.addFromString('#JSGF V1.0 grammar;', 0.75);
      grammars.addFromUri('/speech.grxml', 0.25);
      const recognition = new SpeechRecognition();
      recognition.grammars = grammars;
      recognition.lang = 'en-US';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 3;
      const recognitionEvents = [];
      recognition.addEventListener('error', (event) => recognitionEvents.push(event.error + ':' + event.message));
      recognition.addEventListener('end', (event) => recognitionEvents.push(event.type));
      recognition.start();
      const recognitionEvent = new SpeechRecognitionEvent('result', { resultIndex: 2, results: ['r'], interpretation: 'i', emma: 'e' });
      const recognitionError = new SpeechRecognitionErrorEvent('error', { error: 'no-speech', message: 'm', bubbles: true, cancelable: true, composed: true });
      const synthesisEvent = new SpeechSynthesisEvent('boundary', { utterance, charIndex: 1, charLength: 2, elapsedTime: 3, name: 'word' });
      const synthesisError = new SpeechSynthesisErrorEvent('error', { utterance, error: 'interrupted' });
      return JSON.stringify([
        Object.prototype.toString.call(speechSynthesis),
        speechSynthesis instanceof SpeechSynthesis,
        speechSynthesis.getVoices().length,
        speechSynthesis.speaking,
        paused,
        speechSynthesis.paused,
        Object.prototype.toString.call(utterance),
        utterance instanceof SpeechSynthesisUtterance,
        utterance.text,
        utterance.lang,
        utterance.rate,
        synthEvents.join('|'),
        Object.prototype.toString.call(grammar),
        grammar.src,
        grammar.weight,
        Object.prototype.toString.call(grammars),
        grammars.length,
        grammars.item(0).weight,
        grammars.item(0).src,
        grammars.item(1).src,
        grammars.item(1).weight,
        Object.getOwnPropertyNames(grammar),
        Object.getOwnPropertyNames(SpeechGrammar.prototype),
        Object.getOwnPropertyNames(grammars),
        Object.getOwnPropertyNames(SpeechGrammarList.prototype),
        Object.getOwnPropertySymbols(SpeechGrammarList.prototype).map(String),
        typeof grammars.addFromURI,
        Object.prototype.toString.call(recognition),
        recognition instanceof SpeechRecognition,
        recognition.grammars === grammars,
        recognition.lang,
        recognition.continuous,
        recognition.interimResults,
        recognition.maxAlternatives,
        recognitionEvents.join('|'),
        webkitSpeechGrammar === SpeechGrammar,
        webkitSpeechGrammarList === SpeechGrammarList,
        webkitSpeechRecognition === SpeechRecognition,
        webkitSpeechRecognitionEvent === SpeechRecognitionEvent,
        webkitSpeechRecognitionError === SpeechRecognitionErrorEvent,
        Object.prototype.toString.call(recognitionEvent),
        recognitionEvent.resultIndex,
        recognitionEvent.results[0],
        recognitionEvent.interpretation,
        recognitionEvent.emma,
        Object.prototype.toString.call(recognitionError),
        recognitionError instanceof Event,
        recognitionError.error,
        recognitionError.message,
        recognitionError.bubbles,
        recognitionError.cancelable,
        recognitionError.composed,
        Object.getOwnPropertyNames(recognitionError),
        Object.getOwnPropertyNames(SpeechRecognitionErrorEvent.prototype),
        Object.getOwnPropertySymbols(SpeechRecognitionErrorEvent.prototype).map(String),
        Object.prototype.hasOwnProperty.call(SpeechRecognitionErrorEvent, Symbol.hasInstance),
        [
          Object.getOwnPropertyDescriptor(globalThis, 'SpeechRecognitionErrorEvent').enumerable,
          Object.getOwnPropertyDescriptor(globalThis, 'SpeechRecognitionErrorEvent').configurable,
          Object.getOwnPropertyDescriptor(globalThis, 'SpeechRecognitionErrorEvent').writable,
        ],
        (() => { try { SpeechRecognitionErrorEvent('error', { error: 'not-allowed' }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new SpeechRecognitionErrorEvent(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new SpeechRecognitionErrorEvent('error', { error: Symbol('speech') }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        webkitSpeechRecognitionError === SpeechRecognitionErrorEvent,
        Object.prototype.toString.call(synthesisEvent),
        synthesisEvent.utterance === utterance,
        Object.getOwnPropertyNames(synthesisEvent),
        Object.getOwnPropertyNames(SpeechSynthesisEvent.prototype),
        Object.getOwnPropertySymbols(SpeechSynthesisEvent.prototype).map(String),
        Object.prototype.hasOwnProperty.call(SpeechSynthesisEvent, Symbol.hasInstance),
        [
          Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisEvent').enumerable,
          Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisEvent').configurable,
          Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisEvent').writable,
        ],
        (() => { try { SpeechSynthesisEvent('boundary', { utterance }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new SpeechSynthesisEvent(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new SpeechSynthesisEvent('boundary', {}); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new SpeechSynthesisEvent('boundary', { utterance: {} }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        synthesisEvent.charIndex,
        synthesisEvent.charLength,
        synthesisEvent.elapsedTime,
        synthesisEvent.name,
        Object.prototype.toString.call(synthesisError),
        synthesisError instanceof SpeechSynthesisEvent,
        synthesisError.utterance === utterance,
        Object.getOwnPropertyNames(synthesisError),
        Object.getOwnPropertyNames(SpeechSynthesisErrorEvent.prototype),
        Object.getOwnPropertySymbols(SpeechSynthesisErrorEvent.prototype).map(String),
        Object.prototype.hasOwnProperty.call(SpeechSynthesisErrorEvent, Symbol.hasInstance),
        [
          Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisErrorEvent').enumerable,
          Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisErrorEvent').configurable,
          Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisErrorEvent').writable,
        ],
        (() => { try { SpeechSynthesisErrorEvent('error', { utterance, error: 'network' }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new SpeechSynthesisErrorEvent(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new SpeechSynthesisErrorEvent('error', {}); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        synthesisError.error,
        (() => { try { new SpeechSynthesis(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new SpeechSynthesisVoice(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ]);
    })();
  `);
  assert.deepEqual(JSON.parse(result), [
    '[object SpeechSynthesis]',
    true,
    0,
    false,
    true,
    false,
    '[object SpeechSynthesisUtterance]',
    true,
    'hello',
    'en-US',
    1.5,
    'start:hello|error:not-allowed|end:5',
    '[object SpeechGrammar]',
    'https://target.example/app/page.html#JSGF%20V1.0;',
    0.5,
    '[object SpeechGrammarList]',
    2,
    0.75,
    'data:application/xml,%23JSGF%20V1.0%20grammar%3B',
    'https://target.example/speech.grxml',
    0.25,
    [],
    ['src', 'weight', 'constructor'],
    ['0', '1'],
    ['length', 'addFromString', 'addFromUri', 'item', 'constructor'],
    ['Symbol(Symbol.toStringTag)', 'Symbol(Symbol.iterator)'],
    'undefined',
    '[object SpeechRecognition]',
    true,
    true,
    'en-US',
    true,
    true,
    3,
    'not-allowed:Speech recognition is disabled by policy.|end',
    true,
    true,
    true,
    true,
    true,
    '[object SpeechRecognitionEvent]',
    2,
    'r',
    'i',
    'e',
    '[object SpeechRecognitionErrorEvent]',
    true,
    'no-speech',
    'm',
    true,
    true,
    true,
    ['isTrusted'],
    ['error', 'message', 'constructor'],
    ['Symbol(Symbol.toStringTag)'],
    false,
    [false, true, true],
    [
      'TypeError',
      "Failed to construct 'SpeechRecognitionErrorEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
    ],
    [
      'TypeError',
      "Failed to construct 'SpeechRecognitionErrorEvent': 1 argument required, but only 0 present.",
    ],
    [
      'TypeError',
      "Failed to construct 'SpeechRecognitionErrorEvent': Failed to read the 'error' property from 'SpeechRecognitionErrorEventInit': Cannot convert a Symbol value to a string",
    ],
    true,
    '[object SpeechSynthesisEvent]',
    true,
    ['isTrusted'],
    ['utterance', 'charIndex', 'charLength', 'elapsedTime', 'name', 'constructor'],
    ['Symbol(Symbol.toStringTag)'],
    false,
    [false, true, true],
    [
      'TypeError',
      "Failed to construct 'SpeechSynthesisEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
    ],
    [
      'TypeError',
      "Failed to construct 'SpeechSynthesisEvent': 2 arguments required, but only 0 present.",
    ],
    [
      'TypeError',
      "Failed to construct 'SpeechSynthesisEvent': Failed to read the 'utterance' property from 'SpeechSynthesisEventInit': Required member is undefined.",
    ],
    [
      'TypeError',
      "Failed to construct 'SpeechSynthesisEvent': Failed to read the 'utterance' property from 'SpeechSynthesisEventInit': Failed to convert value to 'SpeechSynthesisUtterance'.",
    ],
    1,
    2,
    3,
    'word',
    '[object SpeechSynthesisErrorEvent]',
    true,
    true,
    ['isTrusted'],
    ['error', 'constructor'],
    ['Symbol(Symbol.toStringTag)'],
    false,
    [false, true, true],
    [
      'TypeError',
      "Failed to construct 'SpeechSynthesisErrorEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
    ],
    [
      'TypeError',
      "Failed to construct 'SpeechSynthesisErrorEvent': 2 arguments required, but only 0 present.",
    ],
    [
      'TypeError',
      "Failed to construct 'SpeechSynthesisErrorEvent': Failed to read the 'utterance' property from 'SpeechSynthesisEventInit': Required member is undefined.",
    ],
    'interrupted',
    ['TypeError', "Failed to construct 'SpeechSynthesis': Illegal constructor"],
    ['TypeError', "Failed to construct 'SpeechSynthesisVoice': Illegal constructor"],
  ]);
  realm.destroy();
});

test('webapi core exposes Web Audio facades', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    (() => {
      const context = new AudioContext({ sampleRate: 44100 });
      const buffer = context.createBuffer(2, 4, 44100);
      buffer.getChannelData(0).set([0.25, 0.5, 0.75, 1]);
      const copied = new Float32Array(2);
      buffer.copyFromChannel(copied, 0, 1);
      const source = context.createBufferSource();
      source.buffer = buffer;
      const gain = context.createGain();
      gain.gain.value = 0.5;
      const oscillator = context.createOscillator();
      oscillator.type = 'square';
      oscillator.frequency.value = 220;
      const analyser = context.createAnalyser();
      const bins = new Uint8Array(4);
      analyser.getByteTimeDomainData(bins);
      const biquad = new BiquadFilterNode(context, { type: 'highpass', frequency: 1000 });
      const delay = new DelayNode(context, { delayTime: 0.25 });
      const compressor = new DynamicsCompressorNode(context, { threshold: -12 });
      const stereo = new StereoPannerNode(context, { pan: -0.5 });
      const panner = new PannerNode(context);
      panner.setPosition(4, 5, 6);
      const shaper = new WaveShaperNode(context, { curve: new Float32Array([0, 1]), oversample: '2x' });
      const convolver = new ConvolverNode(context, { buffer });
      const iir = new IIRFilterNode(context, { feedforward: [1], feedback: [1] });
      const splitter = new ChannelSplitterNode(context, { numberOfOutputs: 4 });
      const merger = new ChannelMergerNode(context, { numberOfInputs: 3 });
      const constant = new ConstantSourceNode(context, { offset: 2 });
      const periodic = new PeriodicWave(context, { real: [1], imag: [0] });
      const workletNode = new AudioWorkletNode(context, 'processor');
      const streamDestination = new MediaStreamAudioDestinationNode(context);
      const streamSource = new MediaStreamAudioSourceNode(context, { mediaStream: streamDestination.stream });
      const mediaElementSource = new MediaElementAudioSourceNode(context, { mediaElement: document.createElement('audio') });
      const processor = context.createScriptProcessor(512, 1, 2);
      processor.onaudioprocess = () => 'handled';
      const completion = new OfflineAudioCompletionEvent('complete', { renderedBuffer: buffer, bubbles: true, cancelable: true, composed: true });
      const completionDescriptor = Object.getOwnPropertyDescriptor(OfflineAudioCompletionEvent.prototype, 'renderedBuffer');
      const completionGlobal = Object.getOwnPropertyDescriptor(globalThis, 'OfflineAudioCompletionEvent');
      const processing = new AudioProcessingEvent('audioprocess', { inputBuffer: buffer, outputBuffer: buffer, playbackTime: 1.25, bubbles: true, cancelable: true, composed: true });
      const processingPlaybackDescriptor = Object.getOwnPropertyDescriptor(AudioProcessingEvent.prototype, 'playbackTime');
      const processingInputDescriptor = Object.getOwnPropertyDescriptor(AudioProcessingEvent.prototype, 'inputBuffer');
      const processingGlobal = Object.getOwnPropertyDescriptor(globalThis, 'AudioProcessingEvent');
      const captureCompletionError = (callback) => {
        try {
          callback();
          return ['ok'];
        } catch (error) {
          return [error.name, error.message];
        }
      };
      const connected = source.connect(gain) === gain && gain.connect(context.destination) === context.destination;
      context.listener.setPosition(1, 2, 3);
      context.suspend();
      const suspended = context.state;
      context.resume();
      const offline = new OfflineAudioContext(1, 8, 8000);
      return JSON.stringify([
        Object.prototype.toString.call(context),
        context instanceof AudioContext,
        context instanceof BaseAudioContext,
        context.sampleRate,
        context.state,
        suspended,
        Object.prototype.toString.call(context.destination),
        context.destination instanceof AudioDestinationNode,
        context.destination.maxChannelCount,
        Object.prototype.toString.call(context.listener),
        context.listener.positionX.value,
        context.listener.positionY.value,
        context.listener.positionZ.value,
        Object.prototype.toString.call(context.audioWorklet),
        Object.prototype.toString.call(buffer),
        buffer.numberOfChannels,
        buffer.length,
        buffer.duration,
        Array.from(copied).join(','),
        Object.prototype.toString.call(source),
        source instanceof AudioBufferSourceNode,
        source instanceof AudioNode,
        source instanceof AudioScheduledSourceNode,
        source.buffer === buffer,
        connected,
        Object.prototype.toString.call(gain),
        gain.gain instanceof AudioParam,
        gain.gain.value,
        Object.prototype.toString.call(oscillator),
        oscillator.type,
        oscillator.frequency.value,
        oscillator instanceof AudioScheduledSourceNode,
        Object.prototype.toString.call(analyser),
        analyser.frequencyBinCount,
        Array.from(bins).join(','),
        Object.prototype.toString.call(biquad),
        biquad.type,
        biquad.frequency.value,
        Object.prototype.toString.call(delay),
        delay.delayTime.value,
        Object.prototype.toString.call(compressor),
        compressor.threshold.value,
        Object.prototype.toString.call(stereo),
        stereo.pan.value,
        Object.prototype.toString.call(panner),
        panner.positionX.value,
        panner.positionY.value,
        panner.positionZ.value,
        Object.prototype.toString.call(shaper),
        shaper.curve.length,
        shaper.oversample,
        Object.prototype.toString.call(convolver),
        convolver.buffer === buffer,
        Object.prototype.toString.call(iir),
        Object.prototype.toString.call(splitter),
        splitter.numberOfOutputs,
        Object.prototype.toString.call(merger),
        merger.numberOfInputs,
        Object.prototype.toString.call(constant),
        constant.offset.value,
        constant instanceof AudioScheduledSourceNode,
        Object.prototype.toString.call(periodic),
        Object.prototype.toString.call(workletNode),
        workletNode.parameters instanceof AudioParamMap,
        Object.prototype.toString.call(processor),
        processor instanceof ScriptProcessorNode,
        processor instanceof AudioNode,
        processor.bufferSize,
        processor.numberOfInputs,
        processor.numberOfOutputs,
        typeof processor.onaudioprocess,
        Object.prototype.toString.call(streamDestination),
        streamDestination.stream instanceof MediaStream,
        Object.prototype.toString.call(streamSource),
        streamSource.mediaStream === streamDestination.stream,
        Object.prototype.toString.call(mediaElementSource),
        Object.prototype.toString.call(mediaElementSource.mediaElement),
        Object.prototype.toString.call(completion),
        completion.renderedBuffer === buffer,
        completion instanceof Event,
        completion.bubbles,
        completion.cancelable,
        completion.composed,
        Object.getOwnPropertyNames(OfflineAudioCompletionEvent.prototype),
        [completionDescriptor.enumerable, completionDescriptor.configurable, typeof completionDescriptor.get, completionDescriptor.set],
        [completionGlobal.enumerable, completionGlobal.configurable, completionGlobal.writable],
        Object.getOwnPropertyDescriptor(OfflineAudioCompletionEvent, 'prototype').writable,
        Object.prototype.hasOwnProperty.call(OfflineAudioCompletionEvent, Symbol.hasInstance),
        Object.prototype.hasOwnProperty.call(completion, 'renderedBuffer'),
        captureCompletionError(() => OfflineAudioCompletionEvent('complete', { renderedBuffer: buffer })),
        captureCompletionError(() => new OfflineAudioCompletionEvent()),
        captureCompletionError(() => new OfflineAudioCompletionEvent('complete')),
        captureCompletionError(() => new OfflineAudioCompletionEvent('complete', null)),
        captureCompletionError(() => new OfflineAudioCompletionEvent('complete', {})),
        captureCompletionError(() => new OfflineAudioCompletionEvent('complete', { renderedBuffer: null })),
        Object.prototype.toString.call(processing),
        processing instanceof AudioProcessingEvent,
        processing instanceof Event,
        Object.getOwnPropertyNames(processing),
        processing.playbackTime,
        processing.inputBuffer === buffer,
        processing.outputBuffer === buffer,
        processing.bubbles,
        processing.cancelable,
        processing.composed,
        Object.getOwnPropertyNames(AudioProcessingEvent.prototype),
        [processingPlaybackDescriptor.enumerable, processingPlaybackDescriptor.configurable, typeof processingPlaybackDescriptor.get, processingPlaybackDescriptor.set],
        [processingInputDescriptor.enumerable, processingInputDescriptor.configurable, typeof processingInputDescriptor.get, processingInputDescriptor.set],
        [processingGlobal.enumerable, processingGlobal.configurable, processingGlobal.writable],
        Object.getOwnPropertyDescriptor(AudioProcessingEvent, 'prototype').writable,
        Object.prototype.hasOwnProperty.call(AudioProcessingEvent, Symbol.hasInstance),
        Object.prototype.hasOwnProperty.call(processing, 'playbackTime'),
        captureCompletionError(() => AudioProcessingEvent('audioprocess', { inputBuffer: buffer, outputBuffer: buffer, playbackTime: 1.25 })),
        captureCompletionError(() => new AudioProcessingEvent()),
        captureCompletionError(() => new AudioProcessingEvent('audioprocess')),
        captureCompletionError(() => new AudioProcessingEvent('audioprocess', null)),
        captureCompletionError(() => new AudioProcessingEvent('audioprocess', {})),
        captureCompletionError(() => new AudioProcessingEvent('audioprocess', { inputBuffer: null, outputBuffer: buffer, playbackTime: 1.25 })),
        captureCompletionError(() => new AudioProcessingEvent('audioprocess', { inputBuffer: buffer, playbackTime: 1.25 })),
        captureCompletionError(() => new AudioProcessingEvent('audioprocess', { inputBuffer: buffer, outputBuffer: null, playbackTime: 1.25 })),
        captureCompletionError(() => new AudioProcessingEvent('audioprocess', { inputBuffer: buffer, outputBuffer: buffer })),
        captureCompletionError(() => new AudioProcessingEvent('audioprocess', { inputBuffer: buffer, outputBuffer: buffer, playbackTime: Number.POSITIVE_INFINITY })),
        Object.prototype.toString.call(offline),
        offline.length,
        offline.sampleRate,
        (() => { try { new BaseAudioContext(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new AudioNode(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new AudioParam(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new AudioListener(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new AudioWorklet(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new AudioScheduledSourceNode(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new ScriptProcessorNode(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ]);
    })();
  `);
  assert.deepEqual(JSON.parse(result), [
    '[object AudioContext]',
    true,
    true,
    44100,
    'running',
    'suspended',
    '[object AudioDestinationNode]',
    true,
    2,
    '[object AudioListener]',
    1,
    2,
    3,
    '[object AudioWorklet]',
    '[object AudioBuffer]',
    2,
    4,
    4 / 44100,
    '0.5,0.75',
    '[object AudioBufferSourceNode]',
    true,
    true,
    true,
    true,
    true,
    '[object GainNode]',
    true,
    0.5,
    '[object OscillatorNode]',
    'square',
    220,
    true,
    '[object AnalyserNode]',
    1024,
    '128,128,128,128',
    '[object BiquadFilterNode]',
    'highpass',
    1000,
    '[object DelayNode]',
    0.25,
    '[object DynamicsCompressorNode]',
    -12,
    '[object StereoPannerNode]',
    -0.5,
    '[object PannerNode]',
    4,
    5,
    6,
    '[object WaveShaperNode]',
    2,
    '2x',
    '[object ConvolverNode]',
    true,
    '[object IIRFilterNode]',
    '[object ChannelSplitterNode]',
    4,
    '[object ChannelMergerNode]',
    3,
    '[object ConstantSourceNode]',
    2,
    true,
    '[object PeriodicWave]',
    '[object AudioWorkletNode]',
    true,
    '[object ScriptProcessorNode]',
    true,
    true,
    512,
    1,
    1,
    'function',
    '[object MediaStreamAudioDestinationNode]',
    true,
    '[object MediaStreamAudioSourceNode]',
    true,
    '[object MediaElementAudioSourceNode]',
    '[object HTMLAudioElement]',
    '[object OfflineAudioCompletionEvent]',
    true,
    true,
    true,
    true,
    true,
    ['renderedBuffer', 'constructor'],
    [true, true, 'function', null],
    [false, true, true],
    false,
    false,
    false,
    [
      'TypeError',
      "Failed to construct 'OfflineAudioCompletionEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
    ],
    [
      'TypeError',
      "Failed to construct 'OfflineAudioCompletionEvent': 2 arguments required, but only 0 present.",
    ],
    [
      'TypeError',
      "Failed to construct 'OfflineAudioCompletionEvent': 2 arguments required, but only 1 present.",
    ],
    [
      'TypeError',
      "Failed to construct 'OfflineAudioCompletionEvent': The provided value is not of type 'OfflineAudioCompletionEventInit'.",
    ],
    [
      'TypeError',
      "Failed to construct 'OfflineAudioCompletionEvent': Failed to read the 'renderedBuffer' property from 'OfflineAudioCompletionEventInit': Required member is undefined.",
    ],
    [
      'TypeError',
      "Failed to construct 'OfflineAudioCompletionEvent': Failed to read the 'renderedBuffer' property from 'OfflineAudioCompletionEventInit': Failed to convert value to 'AudioBuffer'.",
    ],
    '[object AudioProcessingEvent]',
    true,
    true,
    ['isTrusted'],
    1.25,
    true,
    true,
    true,
    true,
    true,
    ['playbackTime', 'inputBuffer', 'outputBuffer', 'constructor'],
    [true, true, 'function', null],
    [true, true, 'function', null],
    [false, true, true],
    false,
    false,
    false,
    [
      'TypeError',
      "Failed to construct 'AudioProcessingEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
    ],
    [
      'TypeError',
      "Failed to construct 'AudioProcessingEvent': 2 arguments required, but only 0 present.",
    ],
    [
      'TypeError',
      "Failed to construct 'AudioProcessingEvent': 2 arguments required, but only 1 present.",
    ],
    [
      'TypeError',
      "Failed to construct 'AudioProcessingEvent': The provided value is not of type 'AudioProcessingEventInit'.",
    ],
    [
      'TypeError',
      "Failed to construct 'AudioProcessingEvent': Failed to read the 'inputBuffer' property from 'AudioProcessingEventInit': Required member is undefined.",
    ],
    [
      'TypeError',
      "Failed to construct 'AudioProcessingEvent': Failed to read the 'inputBuffer' property from 'AudioProcessingEventInit': Failed to convert value to 'AudioBuffer'.",
    ],
    [
      'TypeError',
      "Failed to construct 'AudioProcessingEvent': Failed to read the 'outputBuffer' property from 'AudioProcessingEventInit': Required member is undefined.",
    ],
    [
      'TypeError',
      "Failed to construct 'AudioProcessingEvent': Failed to read the 'outputBuffer' property from 'AudioProcessingEventInit': Failed to convert value to 'AudioBuffer'.",
    ],
    [
      'TypeError',
      "Failed to construct 'AudioProcessingEvent': Failed to read the 'playbackTime' property from 'AudioProcessingEventInit': Required member is undefined.",
    ],
    [
      'TypeError',
      "Failed to construct 'AudioProcessingEvent': Failed to read the 'playbackTime' property from 'AudioProcessingEventInit': The provided double value is non-finite.",
    ],
    '[object OfflineAudioContext]',
    8,
    8000,
    ['TypeError', "Failed to construct 'BaseAudioContext': Illegal constructor"],
    ['TypeError', "Failed to construct 'AudioNode': Illegal constructor"],
    ['TypeError', "Failed to construct 'AudioParam': Illegal constructor"],
    ['TypeError', "Failed to construct 'AudioListener': Illegal constructor"],
    ['TypeError', "Failed to construct 'AudioWorklet': Illegal constructor"],
    ['TypeError', "Failed to construct 'AudioScheduledSourceNode': Illegal constructor"],
    ['TypeError', "Failed to construct 'ScriptProcessorNode': Illegal constructor"],
  ]);
  realm.destroy();
});

test('webapi core exposes browser-like table helpers', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    (() => {
      const table = document.createElement('table');
      const caption = table.createCaption();
      caption.textContent = 'cap';
      const head = table.createTHead();
      const headRow = head.insertRow();
      const body1 = table.createTBody();
      const body2 = table.createTBody();
      const row0 = table.insertRow();
      const c1 = row0.insertCell();
      const c0 = row0.insertCell(0);
      const bodyRow = body2.insertRow();
      const bodyCell = bodyRow.insertCell();
      const foot = table.createTFoot();
      const footRow = foot.insertRow();
      const invalids = [];
      try { table.insertRow(99); } catch (error) { invalids.push([error.name, error.message]); }
      try { row0.insertCell(5); } catch (error) { invalids.push([error.name, error.message]); }
      const before = {
        caption: table.caption === caption,
        tHead: table.tHead === head,
        tFoot: table.tFoot === foot,
        bodies: [table.tBodies.length, table.tBodies.item(0) === body1, table.tBodies.item(1) === body2],
        rows: [table.rows.length, headRow.rowIndex, row0.rowIndex, bodyRow.rowIndex, footRow.rowIndex, row0.sectionRowIndex, bodyRow.sectionRowIndex],
        cells: [row0.cells.length, row0.cells.item(0) === c0, row0.cells.item(1) === c1, c0.cellIndex, c1.cellIndex, bodyCell.cellIndex],
      };
      table.deleteRow(-1);
      row0.deleteCell(-1);
      table.deleteTHead();
      table.deleteCaption();
      table.deleteTFoot();
      return JSON.stringify({
        before,
        after: [table.rows.length, row0.cells.length, table.caption, table.tHead, table.tFoot],
        invalids: invalids.map(([name, message]) => [name, message.includes('Index') || message.includes('index')]),
      });
    })();
  `);
  assert.deepEqual(JSON.parse(result), {
    before: {
      caption: true,
      tHead: true,
      tFoot: true,
      bodies: [2, true, true],
      rows: [4, 0, 1, 2, 3, 0, 0],
      cells: [2, true, true, 0, 1, 0],
    },
    after: [2, 1, null, null, null],
    invalids: [
      ['IndexSizeError', true],
      ['IndexSizeError', true],
    ],
  });
  realm.destroy();
});
test('webapi core normalizes bridged constructor reflection names', async () => {
  const { realm } = await installCore();
  realm.evalClassic(`
    globalThis.webapiCoreResult = JSON.stringify({
      XMLSerializer: [
        XMLSerializer.name,
        Object.getOwnPropertyDescriptor(XMLSerializer, 'name').value,
        XMLSerializer.prototype.constructor.name,
        Object.prototype.toString.call(XMLSerializer.prototype),
      ],
      MediaStream: [
        MediaStream.name,
        webkitMediaStream === MediaStream,
        MediaStream.prototype.constructor.name,
      ],
      generatedNames: [
        DOMImplementation.name,
        CSSStyleSheet.name,
        Option.name,
        ResizeObserver.name,
        IntersectionObserver.name,
      ],
    });
  `);
  assert.deepEqual(JSON.parse(realm.evalClassic('webapiCoreResult')), {
    XMLSerializer: ['XMLSerializer', 'XMLSerializer', 'XMLSerializer', '[object XMLSerializer]'],
    MediaStream: ['MediaStream', true, 'MediaStream'],
    generatedNames: [
      'DOMImplementation',
      'CSSStyleSheet',
      'Option',
      'ResizeObserver',
      'IntersectionObserver',
    ],
  });
  realm.destroy();
});

test('webapi core installs DOMParser XMLSerializer Range Selection Cache and style reflections', async () => {
  const { realm } = await installCore();
  realm.evalClassic(`
    globalThis.webapiCoreResult = '';
    (async () => {
      const el = document.getElementById('el');
      el.dataset.answer = '42';
      const datasetObject = el.dataset;
      const sameDataset = datasetObject === el.dataset;
      datasetObject.longName = 'ok';
      el.setAttribute('data--x', 'dash');
      Object.defineProperty(datasetObject, 'newKey', { value: 'v', enumerable: true, configurable: true, writable: true });
      let preventExtensionsError;
      try { Object.preventExtensions(datasetObject); preventExtensionsError = ['ok']; } catch (error) { preventExtensionsError = [error.name, error.message]; }
      const domStringMapGlobal = Object.getOwnPropertyDescriptor(globalThis, 'DOMStringMap');
      let newDOMStringMap;
      try { new DOMStringMap(); newDOMStringMap = ['ok']; } catch (error) { newDOMStringMap = [error.name, error.message]; }
      const datasetSummary = [
        Object.prototype.toString.call(datasetObject),
        datasetObject instanceof DOMStringMap,
        sameDataset,
        datasetObject.answer,
        el.getAttribute('data-long-name'),
        Object.keys(datasetObject),
        Object.getOwnPropertyNames(datasetObject),
        Object.getOwnPropertyNames(DOMStringMap),
        Object.getOwnPropertySymbols(DOMStringMap).length,
        Object.getOwnPropertyNames(DOMStringMap.prototype),
        [domStringMapGlobal.enumerable, domStringMapGlobal.configurable, domStringMapGlobal.writable],
        el.getAttribute('data-new-key'),
        datasetObject.X,
        preventExtensionsError,
        'answer' in datasetObject,
        delete datasetObject.longName,
        el.hasAttribute('data-long-name'),
        typeof DOMStringMap,
        newDOMStringMap,
      ];
      el.classList.add('a', 'b');
      el.classList.remove('a');
      const classList = el.classList;
      const sameClassList = classList === el.classList;
      classList.add('c', 'b');
      const toggleOff = classList.toggle('b', false);
      const toggleOn = classList.toggle('d');
      const replaced = classList.replace('c', 'e');
      let invalidToken = '';
      let emptyToken = '';
      try { classList.add('bad token'); } catch (error) { invalidToken = error.name; }
      try { classList.add(''); } catch (error) { emptyToken = error.name; }
      let supportsError = '';
      try { classList.supports('token'); } catch (error) { supportsError = error.name; }
      const classListSummary = [
        Object.prototype.toString.call(classList),
        classList instanceof DOMTokenList,
        sameClassList,
        classList.length,
        classList.item(0),
        classList[1],
        classList.contains('d'),
        toggleOff,
        toggleOn,
        replaced,
        Array.from(classList),
        Array.from(classList.keys()),
        Array.from(classList.entries()),
        String(classList),
        Object.getOwnPropertyNames(classList).sort(),
        [
          Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'length').enumerable,
          Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'length').configurable,
          typeof Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'length').get,
          Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'length').set,
        ],
        [
          Object.getOwnPropertyDescriptor(classList, '0').value,
          Object.getOwnPropertyDescriptor(classList, '0').writable,
          Object.getOwnPropertyDescriptor(classList, '0').enumerable,
          Object.getOwnPropertyDescriptor(classList, '0').configurable,
        ],
        (() => { try { new DOMTokenList(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        invalidToken,
        emptyToken,
        supportsError,
      ];
      const focusEvents = [];
      const otherFocus = document.createElement('button');
      document.body.append(otherFocus);
      el.addEventListener('focus', () => focusEvents.push('el-focus'));
      el.addEventListener('blur', () => focusEvents.push('el-blur'));
      otherFocus.addEventListener('focus', () => focusEvents.push('other-focus'));
      otherFocus.addEventListener('blur', () => focusEvents.push('other-blur'));
      const focusInitial = [document.activeElement === document.body, document.hasFocus()];
      el.focus();
      const focusAfterEl = [document.activeElement === el, document.hasFocus()];
      otherFocus.focus();
      const focusAfterOther = [document.activeElement === otherFocus, document.hasFocus()];
      otherFocus.blur();
      const focusAfterBlur = [document.activeElement === document.body, document.hasFocus()];
      const focusSummary = [focusInitial, focusAfterEl, focusAfterOther, focusAfterBlur, focusEvents];
      otherFocus.remove();
      el.style.setProperty('color', 'red');
      el.style.cssFloat = 'left';
      const styleSummary = [
        Object.prototype.toString.call(el.style),
        Array.from(el.style),
        el.style.cssFloat,
        el.style.getPropertyValue('float'),
        el.style.parentRule,
        Object.hasOwn(CSSStyleDeclaration.prototype, 'toString'),
        String(el.style),
        Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, Symbol.iterator).value.name,
        Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssFloat').get.name,
      ];
      const range = document.createRange();
      range.setStart(el);
      const attr = el.getAttributeNode('data-answer');
      const attrBefore = [Object.prototype.toString.call(attr), attr instanceof Attr, attr.name, attr.localName, attr.value, attr.ownerElement === el];
      attr.value = '43';
      const replacementAttr = new Attr('data-answer', '44');
      const oldAttr = el.setAttributeNode(replacementAttr);
      const nsAttr = new Attr('href', '/icon.svg', 'http://www.w3.org/1999/xlink');
      el.setAttributeNodeNS(nsAttr);
      const nsNode = el.getAttributeNodeNS('http://www.w3.org/1999/xlink', 'href');
      const removedNS = el.removeAttributeNode(nsAttr);
      let missingRemove = '';
      try { el.removeAttributeNode(nsAttr); } catch (error) { missingRemove = error.name; }
      const looseAttr = new Attr('loose', 'v');
      const attrSummary = [
        attrBefore,
        oldAttr.value,
        el.getAttribute('data-answer'),
        replacementAttr.ownerElement === el,
        [nsNode.namespaceURI, nsNode.value, el.hasAttributeNS('http://www.w3.org/1999/xlink', 'href')],
        [removedNS === nsAttr, nsAttr.ownerElement, el.hasAttributeNS('http://www.w3.org/1999/xlink', 'href')],
        missingRemove,
        [Object.prototype.toString.call(looseAttr), looseAttr.ownerElement, looseAttr.value],
      ];
      getSelection().addRange(range);
      const parsed = new DOMParser().parseFromString('<p>x</p>', 'text/html');
      const serialized = new XMLSerializer().serializeToString(el);
      const walker = document.createTreeWalker(document.body);
      const first = walker.nextNode().id;
      const cache = await caches.open('v1');
      await cache.put('/cached', new Response('cached-body'));
      const cached = await caches.match('/cached');
      const table = document.createElement('table');
      const tbody = table.createTBody();
      const row = tbody.insertRow();
      row.id = 'r1';
      const allBefore = document.all;
      const allSummary = [
        typeof HTMLAllCollection,
        Object.prototype.toString.call(allBefore),
        allBefore instanceof HTMLAllCollection,
        allBefore.item(0) === document.documentElement,
        allBefore.namedItem('r1') === null,
      ];
      document.body.appendChild(table);
      const fragment = document.createDocumentFragment();
      const allAfterTable = [
        document.all.length,
        document.all.namedItem('r1') === row,
        document.all.item('r1') === row,
        Array.from(document.all).includes(row),
      ];
      const constructedFragment = new DocumentFragment();
      const strong = document.createElement('strong');
      strong.id = 'frag-strong';
      strong.className = 'frag-mark';
      strong.textContent = 'b';
      fragment.append('a', strong);
      fragment.prepend('z');
      const fragmentBeforeReplace = [
        Object.prototype.toString.call(fragment),
        fragment.nodeType,
        fragment.textContent,
        fragment.children.length,
        fragment.children.item(0).tagName,
        fragment.firstElementChild.tagName,
        fragment.lastElementChild.tagName,
        fragment.childElementCount,
        fragment.getElementById('frag-strong') === strong,
        fragment.querySelector('.frag-mark') === strong,
        fragment.querySelectorAll('strong').length,
      ];
      fragment.replaceChildren('x', document.createElement('em'));
      fragment.lastChild.textContent = 'y';
      const fragmentAfterReplace = [fragment.textContent, fragment.childNodes.length, fragment.children[0].tagName];
      let newShadowRoot;
      try {
        new ShadowRoot();
        newShadowRoot = ['ok'];
      } catch (error) {
        newShadowRoot = [error.name, error.message];
      }
      const shadowHost = document.createElement('div');
      const shadow = shadowHost.attachShadow({ mode: 'open', delegatesFocus: true, slotAssignment: 'manual' });
      shadow.append('s', document.createElement('slot'));
      const shadowSlot = shadow.children.item(0);
      const namedSlot = document.createElement('slot');
      namedSlot.name = 'named';
      const fallbackSlot = document.createElement('slot');
      fallbackSlot.name = 'missing';
      fallbackSlot.appendChild(document.createElement('em'));
      shadow.append(namedSlot, fallbackSlot);
      const defaultLight = document.createElement('span');
      defaultLight.textContent = 'light';
      const namedLight = document.createElement('span');
      namedLight.setAttribute('slot', 'named');
      namedLight.textContent = 'named';
      shadowHost.append(defaultLight, namedLight);
      shadowSlot.assign(defaultLight);
      namedSlot.assign(namedLight);
      const slotSummary = [
        defaultLight.assignedSlot === shadowSlot,
        namedLight.assignedSlot === namedSlot,
        shadowSlot.assignedNodes()[0] === defaultLight,
        shadowSlot.assignedElements()[0] === defaultLight,
        namedSlot.assignedNodes()[0] === namedLight,
        fallbackSlot.assignedNodes().length,
        fallbackSlot.assignedNodes({ flatten: true })[0].localName,
        typeof shadowSlot.assign,
      ];
      shadowSlot.focus();
      const shadowActiveSummary = [shadow.activeElement === shadowSlot, document.activeElement === shadowSlot];
      shadowSlot.blur();
      let duplicateShadow;
      try {
        shadowHost.attachShadow({ mode: 'open' });
        duplicateShadow = 'ok';
      } catch (error) {
        duplicateShadow = error.name;
      }
      let invalidShadow;
      try {
        document.createElement('div').attachShadow({ mode: 'invalid' });
        invalidShadow = 'ok';
      } catch (error) {
        invalidShadow = [error.name, error.message];
      }
      const closedShadowHost = document.createElement('span');
      const closedShadow = closedShadowHost.attachShadow({ mode: 'closed' });
      const shadowSummary = [
        typeof ShadowRoot,
        Object.prototype.toString.call(shadow),
        shadow instanceof ShadowRoot,
        shadow instanceof DocumentFragment,
        shadow.host === shadowHost,
        shadowHost.shadowRoot === shadow,
        closedShadowHost.shadowRoot,
        closedShadow.host === closedShadowHost,
        shadow.mode,
        shadow.delegatesFocus,
        shadow.slotAssignment,
        shadow.textContent,
        shadow.children.length,
        [...shadowActiveSummary, shadow.activeElement],
        slotSummary,
        shadow.styleSheets.length,
        shadow.adoptedStyleSheets.length,
        newShadowRoot,
        duplicateShadow,
        invalidShadow,
      ];
      const implementation = document.implementation;
      const htmlDoc = implementation.createHTMLDocument('Impl Title');
      const docType = implementation.createDocumentType('root', 'pub', 'sys');
      const xmlDoc = implementation.createDocument('urn:impl', 'root', docType);
      const implementationSummary = [
        Object.prototype.toString.call(implementation),
        implementation instanceof DOMImplementation,
        implementation === document.implementation,
        Object.prototype.toString.call(docType),
        docType instanceof DocumentType,
        [docType.name, docType.publicId, docType.systemId],
        [htmlDoc.title, htmlDoc.documentElement.localName, htmlDoc.body.localName, Object.prototype.toString.call(htmlDoc), htmlDoc instanceof HTMLDocument],
        [xmlDoc.contentType, xmlDoc.firstChild === docType, xmlDoc.documentElement.namespaceURI, xmlDoc.documentElement.localName, Object.prototype.toString.call(xmlDoc), xmlDoc instanceof XMLDocument],
        implementation.hasFeature('XML', '1.0'),
        [Object.getOwnPropertyDescriptor(DOMImplementation.prototype, 'createDocument').value.length, Object.getOwnPropertyDescriptor(DOMImplementation.prototype, 'createDocumentType').value.length],
      ];
      globalThis.webapiCoreResult = JSON.stringify({
        dataset: el.getAttribute('data-answer'),
        datasetSummary,
        className: el.className,
        classListSummary,
        focusSummary,
        attrSummary,
        computed: getComputedStyle(el).getPropertyValue('color'),
        styleSummary,
        selection: getSelection().rangeCount,
        parsedText: parsed.body.textContent,
        parsedInner: parsed.body.innerHTML,
        serializedIncludesDataset: serialized.includes('data-answer="44"'),
        first,
        cacheKeys: (await caches.keys()).join(','),
        cachedText: await cached.text(),
        mutationObserver: typeof MutationObserver,
        documentFragment: document.createDocumentFragment().nodeType,
        implementationSummary,
        constructedFragment: [constructedFragment instanceof DocumentFragment, constructedFragment.ownerDocument === document],
        allSummary,
        allAfterTable,
        fragmentBeforeReplace,
        fragmentAfterReplace,
        shadowSummary,
        tableRows: table.rows.length,
        tableFirstRow: table.rows.item(0).id,
      });
    })();
  `);
  realm.drainJobs();
  realm.drainJobs();
  const result = realm.evalClassic('webapiCoreResult');
  assert.deepEqual(JSON.parse(result), {
    dataset: '44',
    datasetSummary: [
      '[object DOMStringMap]',
      true,
      true,
      '42',
      'ok',
      ['answer', 'longName', 'X', 'newKey'],
      ['answer', 'longName', 'X', 'newKey'],
      ['length', 'name', 'prototype'],
      0,
      ['constructor'],
      [false, true, true],
      'v',
      'dash',
      ['TypeError', 'proxy preventExtensions handler returned false'],
      true,
      true,
      false,
      'function',
      ['TypeError', "Failed to construct 'DOMStringMap': Illegal constructor"],
    ],
    allSummary: ['function', '[object HTMLAllCollection]', true, true, true],
    allAfterTable: [6, true, true, true],
    className: 'e d',
    classListSummary: [
      '[object DOMTokenList]',
      true,
      true,
      2,
      'e',
      'd',
      true,
      false,
      true,
      true,
      ['e', 'd'],
      [0, 1],
      [
        [0, 'e'],
        [1, 'd'],
      ],
      'e d',
      ['0', '1'],
      [true, true, 'function', null],
      ['e', false, true, true],
      ['TypeError', "Failed to construct 'DOMTokenList': Illegal constructor"],
      'InvalidCharacterError',
      'SyntaxError',
      'TypeError',
    ],
    focusSummary: [
      [true, false],
      [true, true],
      [true, true],
      [true, false],
      ['el-focus', 'el-blur', 'other-focus', 'other-blur'],
    ],
    attrSummary: [
      ['[object Attr]', true, 'data-answer', 'data-answer', '42', true],
      '43',
      '44',
      true,
      ['http://www.w3.org/1999/xlink', '/icon.svg', false],
      [true, null, false],
      'NotFoundError',
      ['[object Attr]', null, 'v'],
    ],
    computed: 'rgb(255, 0, 0)',
    styleSummary: [
      '[object CSSStyleDeclaration]',
      ['color', 'float'],
      'left',
      'left',
      null,
      false,
      '[object CSSStyleDeclaration]',
      'values',
      'get cssFloat',
    ],
    selection: 1,
    parsedText: 'x',
    parsedInner: '<p>x</p>',
    serializedIncludesDataset: true,
    first: 'el',
    cacheKeys: 'v1',
    cachedText: 'cached-body',
    mutationObserver: 'function',
    documentFragment: 11,
    constructedFragment: [true, true],
    fragmentBeforeReplace: [
      '[object DocumentFragment]',
      11,
      'zab',
      1,
      'STRONG',
      'STRONG',
      'STRONG',
      1,
      true,
      true,
      1,
    ],
    fragmentAfterReplace: ['xy', 2, 'EM'],
    shadowSummary: [
      'function',
      '[object ShadowRoot]',
      true,
      true,
      true,
      true,
      null,
      true,
      'open',
      true,
      'manual',
      's',
      3,
      [true, true, null],
      [true, true, true, true, true, 0, 'em', 'function'],
      0,
      0,
      ['TypeError', "Failed to construct 'ShadowRoot': Illegal constructor"],
      'NotSupportedError',
      [
        'TypeError',
        "Failed to execute 'attachShadow' on 'Element': The 'mode' member of ShadowRootInit must be either 'open' or 'closed'.",
      ],
    ],
    implementationSummary: [
      '[object DOMImplementation]',
      true,
      true,
      '[object DocumentType]',
      true,
      ['root', 'pub', 'sys'],
      ['Impl Title', 'html', 'body', '[object HTMLDocument]', true],
      ['application/xml', true, 'urn:impl', 'root', '[object XMLDocument]', true],
      true,
      [2, 3],
    ],
    tableRows: 1,
    tableFirstRow: 'r1',
  });
  realm.destroy();
});

test('webapi core parses HTML for innerHTML outerHTML DOMParser and document.write', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    JSON.stringify((() => {
      try {
    const host = document.createElement('div');
    host.innerHTML = '<p id="x" data-a="1 &amp; 2">Hi <b>there</b><!--c--><img src="/a.png"></p>';
    const firstOuter = host.firstChild.outerHTML;
    const first = host.querySelector('#x');
    const img = host.querySelector('img');
    host.firstChild.outerHTML = '<section id="s">New<span>!</span></section>';
    const parsed = new DOMParser().parseFromString('<!doctype html><html><body><main id="m">T<br>U</main></body></html>', 'text/html');
    const written = document.implementation.createHTMLDocument('x');
    written.write('<div id="w">W<b>1</b></div>');
    const tbody = document.createElement('tbody');
    tbody.innerHTML = '<tr id="row"><td>A</td></tr>';
    const table = document.createElement('table');
    table.innerHTML = '<caption>C</caption><tbody><tr><td>B</td></tr></tbody>';
    const safe = document.createElement('div');
    safe.setHTML('<b onclick="x">Safe</b><script>bad()</script>');
    const unsafe = document.createElement('div');
    unsafe.setHTMLUnsafe('<b onclick="x">Unsafe</b><script>bad()</script>');
    const parsedUnsafe = Document.parseHTMLUnsafe('<title>T</title><p id="unsafe" onclick="x">U</p><script>bad()</script>');
    const parsedSafe = Document.parseHTML('<title>T</title><p id="safe" onclick="x">S</p><script>bad()</script>');
    const policySafe = document.createElement('div');
    policySafe.setHTML('<section>Gone</section><p data-drop="x" data-keep="y"><em data-drop="z">Keep</em><!--c--><span onclick="bad()">S</span></p>', {
      sanitizer: new Sanitizer({
        removeElements: ['section'],
        replaceWithChildrenElements: ['em'],
        dataAttributes: false,
        comments: false,
      }),
    });
    const parsedPolicy = Document.parseHTML('<title>P</title><p data-drop="1"><em onclick="x">Policy</em><script>bad()</script></p>', {
      sanitizer: new Sanitizer({ replaceWithChildrenElements: ['em'], dataAttributes: false }),
    });
    const adjacent = document.createElement('div');
    adjacent.innerHTML = '<p id="a">A</p>';
    const adjacentP = adjacent.querySelector('#a');
    const adjacentHR = document.createElement('hr');
    const adjacentReturned = adjacentP.insertAdjacentElement('beforebegin', adjacentHR);
    adjacentP.insertAdjacentHTML('afterend', '<em>E</em>');
    adjacentP.insertAdjacentText('afterbegin', '0');
    adjacentP.insertAdjacentHTML('beforeend', '<span>S</span>');
    adjacent.insertAdjacentHTML('afterbegin', '<strong>H</strong>');
    adjacent.insertAdjacentText('beforeend', 'T');
    const template = document.createElement('template');
    template.innerHTML = '<span>T</span>';
    const templateSummary = [
      template instanceof HTMLTemplateElement,
      template.content instanceof DocumentFragment,
      template.childNodes.length,
      template.content.childNodes.length,
      template.content.firstElementChild.localName,
      template.innerHTML,
    ];
    return {
      ok: true,
      initialChildren: host.childNodes.length,
      firstName: first.nodeName,
      firstText: first.textContent,
      attr: first.getAttribute('data-a'),
      imgOuter: img.outerHTML,
      initialInner: firstOuter,
      outerSetChildren: host.children.length,
      outerSetName: host.firstElementChild.localName,
      outerSetText: host.textContent,
      outerSetInner: host.innerHTML,
      parsedContentType: parsed.contentType,
      parsedText: parsed.body.textContent,
      parsedMainInner: parsed.querySelector('#m').innerHTML,
      parsedRoot: parsed.documentElement.localName,
      parsedBody: parsed.body.localName,
      writtenInner: written.body.innerHTML,
      writtenText: written.getElementById('w').textContent,
      tbodyFirst: tbody.firstElementChild.localName,
      tbodyCellText: tbody.querySelector('td').textContent,
      tableFirst: table.firstElementChild.localName,
      tableRows: table.rows.length,
      tableText: table.textContent,
      safeInner: safe.innerHTML,
      unsafeInner: unsafe.innerHTML,
      parseUnsafe: [parsedUnsafe.title, parsedUnsafe.body.children.length, parsedUnsafe.querySelector('script') !== null, parsedUnsafe.querySelector('#unsafe').getAttribute('onclick')],
      parseSafe: [parsedSafe.title, parsedSafe.body.children.length, parsedSafe.querySelector('script'), parsedSafe.querySelector('#safe').getAttribute('onclick')],
      policyInner: policySafe.innerHTML,
      parsePolicy: [parsedPolicy.title, parsedPolicy.body.innerHTML],
      adjacentSummary: [adjacent.innerHTML, adjacentReturned === adjacentHR, adjacentHR.parentNode === adjacent, adjacentP.textContent],
      templateSummary,
    };
      } catch (error) {
        return { ok: false, name: error && error.name, message: error && error.message, stack: error && error.stack };
      }
    })());
  `);
  assert.deepEqual(JSON.parse(result), {
    ok: true,
    initialChildren: 1,
    templateSummary: [true, true, 0, 1, 'span', '<span>T</span>'],
    firstName: 'P',
    firstText: 'Hi there',
    attr: '1 & 2',
    imgOuter: '<img src="/a.png">',
    initialInner: '<p id="x" data-a="1 &amp; 2">Hi <b>there</b><!--c--><img src="/a.png"></p>',
    outerSetChildren: 1,
    outerSetName: 'section',
    outerSetText: 'New!',
    outerSetInner: '<section id="s">New<span>!</span></section>',
    parsedContentType: 'text/html',
    parsedText: 'TU',
    parsedMainInner: 'T<br>U',
    parsedRoot: 'html',
    parsedBody: 'body',
    writtenInner: '<div id="w">W<b>1</b></div>',
    writtenText: 'W1',
    tbodyFirst: 'tr',
    tbodyCellText: 'A',
    tableFirst: 'caption',
    tableRows: 1,
    tableText: 'CB',
    safeInner: '<b>Safe</b>',
    unsafeInner: '<b onclick="x">Unsafe</b><script>bad()</script>',
    parseUnsafe: ['T', 2, true, 'x'],
    parseSafe: ['T', 1, null, null],
    policyInner: '<p>Keep<span>S</span></p>',
    parsePolicy: ['P', '<p>Policy</p>'],
    adjacentSummary: [
      '<strong>H</strong><hr><p id="a">0A<span>S</span></p><em>E</em>T',
      true,
      true,
      '0AS',
    ],
  });
  realm.destroy();
});

test('webapi core Range and Selection expose browser-like boundary state', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    const host = document.createElement('div');
    host.innerHTML = '<p id="p">Hello <b>World</b></p>';
    document.body.appendChild(host);
    const p = host.querySelector('#p');
    const text = p.firstChild;
    const boldText = p.querySelector('b').firstChild;
    const range = document.createRange();
    const out = [];
    out.push(['initial', range.startContainer.nodeName, range.startOffset, range.endContainer.nodeName, range.endOffset, range.collapsed, range.commonAncestorContainer.nodeName, range.toString()]);
    range.setStart(text, 1);
    range.setEnd(boldText, 3);
    out.push(['text-range', range.startContainer.nodeName, range.startOffset, range.endContainer.nodeName, range.endOffset, range.collapsed, range.commonAncestorContainer.nodeName, range.toString()]);
    range.selectNodeContents(p);
    out.push(['contents', range.startContainer.nodeName, range.startOffset, range.endContainer.nodeName, range.endOffset, range.toString()]);
    range.collapse(false);
    out.push(['collapse-end', range.startContainer.nodeName, range.startOffset, range.endContainer.nodeName, range.endOffset, range.collapsed, range.toString()]);
    range.selectNode(p.querySelector('b'));
    const clone = range.cloneRange();
    out.push(['clone', clone.startContainer.nodeName, clone.startOffset, clone.endContainer.nodeName, clone.endOffset, clone.toString()]);
    let abstractRange;
    try { new AbstractRange(); } catch (error) { abstractRange = [error.name, error.message]; }
    const rangeError = (callback) => {
      try {
        callback();
        return ['ok'];
      } catch (error) {
        return [error.name, error.message];
      }
    };
    let staticRange;
    let staticSummary;
    try {
      staticRange = new StaticRange({ startContainer: text, startOffset: 1, endContainer: boldText, endOffset: 3 });
      let staticAssignError = '';
      try { staticRange.startOffset = 9; } catch (error) { staticAssignError = error.name; }
      staticSummary = ['static', Object.prototype.toString.call(staticRange), staticRange instanceof StaticRange, staticRange instanceof AbstractRange, staticRange.collapsed, staticRange.startContainer.nodeName, staticRange.startOffset, staticRange.endContainer.nodeName, staticRange.endOffset, Object.prototype.hasOwnProperty.call(staticRange, 'startOffset'), Object.getOwnPropertyDescriptor(AbstractRange.prototype, 'startOffset').set, staticAssignError];
    } catch (error) {
      staticSummary = ['static-error', error.name, error.message];
    }
    out.push(staticSummary);
    if (staticRange) {
      out.push([
        'static-shape',
        Object.getOwnPropertyNames(StaticRange),
        Object.getOwnPropertyNames(StaticRange.prototype),
        Object.getOwnPropertyNames(staticRange),
        StaticRange.length,
        [
          rangeError(() => new StaticRange()),
          rangeError(() => new StaticRange({})),
          rangeError(() => new StaticRange({ startContainer: {}, startOffset: 0, endContainer: text, endOffset: 0 })),
          (() => {
            const negative = new StaticRange({ startContainer: text, startOffset: -1, endContainer: text, endOffset: -1 });
            return [negative.startOffset, negative.endOffset];
          })(),
        ],
      ]);
    }
    out.push(['range-abstract', range instanceof AbstractRange, clone instanceof AbstractRange, abstractRange]);
    const abstractDescriptor = Object.getOwnPropertyDescriptor(AbstractRange.prototype, 'startOffset');
    const abstractGlobalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'AbstractRange');
    out.push([
      'abstract-shape',
      Object.getOwnPropertyNames(AbstractRange),
      Object.getOwnPropertySymbols(AbstractRange).length,
      Object.getOwnPropertyNames(AbstractRange.prototype),
      [abstractDescriptor.enumerable, abstractDescriptor.configurable, abstractDescriptor.set ?? null],
      [abstractGlobalDescriptor.enumerable, abstractGlobalDescriptor.configurable, abstractGlobalDescriptor.writable],
      Object.getPrototypeOf(Range.prototype) === AbstractRange.prototype,
      Object.getPrototypeOf(StaticRange.prototype) === AbstractRange.prototype,
    ]);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    out.push(['selection-add', selection.rangeCount, selection.anchorNode.nodeName, selection.anchorOffset, selection.focusNode.nodeName, selection.focusOffset, selection.isCollapsed, selection.type, selection.toString()]);
    selection.collapse(text, 2);
    out.push(['selection-collapse', selection.rangeCount, selection.anchorNode.nodeName, selection.anchorOffset, selection.focusNode.nodeName, selection.focusOffset, selection.isCollapsed, selection.type, selection.toString()]);
    selection.selectAllChildren(p);
    out.push(['selection-all', selection.rangeCount, selection.anchorNode.nodeName, selection.anchorOffset, selection.focusNode.nodeName, selection.focusOffset, selection.toString()]);
    selection.collapseToStart();
    out.push(['selection-collapse-start', selection.rangeCount, selection.anchorNode.nodeName, selection.anchorOffset, selection.focusNode.nodeName, selection.focusOffset, selection.isCollapsed, selection.type]);
    selection.selectAllChildren(p);
    selection.extend(boldText, 2);
    out.push(['selection-extend', selection.anchorNode.nodeName, selection.anchorOffset, selection.focusNode.nodeName, selection.focusOffset, selection.toString()]);
    selection.setBaseAndExtent(text, 0, boldText, 5);
    out.push(['selection-base-extent', selection.anchorNode.nodeName, selection.anchorOffset, selection.focusNode.nodeName, selection.focusOffset, selection.toString(), selection.containsNode(p.querySelector('b')), selection.containsNode(p, true)]);
    const composedSelection = selection.getComposedRanges()[0];
    out.push(['selection-composed', Object.prototype.toString.call(composedSelection), composedSelection.startContainer.nodeName, composedSelection.startOffset, composedSelection.endContainer.nodeName, composedSelection.endOffset, selection.direction, selection.baseNode === selection.anchorNode, selection.extentNode === selection.focusNode, selection.baseOffset, selection.extentOffset]);
    selection.setBaseAndExtent(boldText, 3, text, 1);
    out.push(['selection-backward', selection.anchorNode.nodeName, selection.anchorOffset, selection.focusNode.nodeName, selection.focusOffset, selection.direction, selection.toString()]);
    selection.setBaseAndExtent(text, 0, boldText, 5);
    selection.deleteFromDocument();
    out.push(['selection-delete', p.innerHTML, selection.isCollapsed, selection.anchorNode === p, selection.anchorOffset]);
    selection.removeRange(selection.getRangeAt(0));
    out.push(['selection-remove', selection.rangeCount, selection.type]);
    selection.addRange(range);
    selection.empty();
    out.push(['selection-empty', selection.rangeCount, selection.type, selection.anchorNode]);
    const selectionShapeDescriptors = ['direction', 'baseNode', 'baseOffset', 'extentNode', 'extentOffset', 'getComposedRanges', 'modify'].map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(Selection.prototype, key);
      return [key, descriptor.enumerable, descriptor.configurable, descriptor.get?.name || descriptor.value?.name, descriptor.get?.length ?? descriptor.value?.length];
    });
    out.push(['selection-shape', Object.getOwnPropertyNames(selection), selection.direction, selection.baseNode, selection.baseOffset, selection.extentNode, selection.extentOffset, selection.getComposedRanges().length, selection.modify('move', 'forward', 'character'), selectionShapeDescriptors]);
    const mutationHost = document.createElement('div');
    mutationHost.innerHTML = '<p id="m">A<b>B</b><i>C</i>D</p><p id="t">abcdef</p>';
    document.body.appendChild(mutationHost);
    const m = mutationHost.querySelector('#m');
    const bold = m.querySelector('b');
    const italic = m.querySelector('i');
    const mut = document.createRange();
    mut.setStartBefore(bold);
    mut.setEndAfter(italic);
    const siblingRange = document.createRange();
    siblingRange.setStartBefore(italic);
    siblingRange.setEndAfter(italic);
    const clonedContents = mut.cloneContents();
    out.push(['range-constants', Range.START_TO_START, range.START_TO_END, range.END_TO_END, range.END_TO_START]);
    out.push(['range-compare', mut.compareBoundaryPoints(Range.START_TO_START, siblingRange), mut.compareBoundaryPoints(Range.START_TO_END, siblingRange), mut.compareBoundaryPoints(Range.END_TO_END, siblingRange), mut.compareBoundaryPoints(Range.END_TO_START, siblingRange)]);
    out.push(['range-clone', Object.prototype.toString.call(clonedContents), clonedContents instanceof DocumentFragment, new XMLSerializer().serializeToString(clonedContents), mut.intersectsNode(bold), mut.isPointInRange(m, 1), mut.comparePoint(m, 4)]);
    const extracted = mut.extractContents();
    out.push(['range-extract', new XMLSerializer().serializeToString(extracted), m.innerHTML, mut.collapsed, mut.startContainer === m, mut.startOffset]);
    const textRange = document.createRange();
    const textNode = mutationHost.querySelector('#t').firstChild;
    textRange.setStart(textNode, 1);
    textRange.setEnd(textNode, 4);
    const textFragment = textRange.extractContents();
    out.push(['range-text-extract', textFragment.textContent, textNode.data, textRange.collapsed, textRange.startContainer === textNode, textRange.startOffset]);
    const insertRange = document.createRange();
    insertRange.setStart(textNode, 1);
    const em = document.createElement('em');
    em.textContent = 'X';
    insertRange.insertNode(em);
    out.push(['range-insert', mutationHost.querySelector('#t').innerHTML]);
    const surroundHost = document.createElement('p');
    surroundHost.textContent = 'wrap';
    mutationHost.appendChild(surroundHost);
    const surroundText = surroundHost.firstChild;
    const surroundRange = document.createRange();
    surroundRange.setStart(surroundText, 1);
    surroundRange.setEnd(surroundText, 3);
    const mark = document.createElement('mark');
    surroundRange.surroundContents(mark);
    out.push(['range-surround', surroundHost.innerHTML, surroundRange.toString(), surroundRange.startContainer === surroundHost, surroundRange.startOffset, surroundRange.endOffset]);
    const contextual = insertRange.createContextualFragment('<u>U</u>v');
    out.push(['range-contextual', Object.prototype.toString.call(contextual), new XMLSerializer().serializeToString(contextual)]);
    JSON.stringify(out);
  `);
  assert.deepEqual(JSON.parse(result), [
    ['initial', '#document', 0, '#document', 0, true, '#document', ''],
    ['text-range', '#text', 1, '#text', 3, false, 'P', 'ello Wor'],
    ['contents', 'P', 0, 'P', 2, 'Hello World'],
    ['collapse-end', 'P', 2, 'P', 2, true, ''],
    ['clone', 'P', 1, 'P', 2, 'World'],
    ['static', '[object StaticRange]', true, true, false, '#text', 1, '#text', 3, false, null, ''],
    [
      'static-shape',
      ['length', 'name', 'prototype'],
      ['constructor'],
      [],
      1,
      [
        [
          'TypeError',
          "Failed to construct 'StaticRange': 1 argument required, but only 0 present.",
        ],
        [
          'TypeError',
          "Failed to construct 'StaticRange': Failed to read the 'endContainer' property from 'StaticRangeInit': Required member is undefined.",
        ],
        [
          'TypeError',
          "Failed to construct 'StaticRange': Failed to read the 'startContainer' property from 'StaticRangeInit': Failed to convert value to 'Node'.",
        ],
        [4294967295, 4294967295],
      ],
    ],
    [
      'range-abstract',
      true,
      true,
      ['TypeError', "Failed to construct 'AbstractRange': Illegal constructor"],
    ],
    [
      'abstract-shape',
      ['length', 'name', 'prototype'],
      0,
      ['startContainer', 'startOffset', 'endContainer', 'endOffset', 'collapsed', 'constructor'],
      [true, true, null],
      [false, true, true],
      true,
      true,
    ],
    ['selection-add', 1, 'P', 1, 'P', 2, false, 'Range', 'World'],
    ['selection-collapse', 1, '#text', 2, '#text', 2, true, 'Caret', ''],
    ['selection-all', 1, 'P', 0, 'P', 2, 'Hello World'],
    ['selection-collapse-start', 1, 'P', 0, 'P', 0, true, 'Caret'],
    ['selection-extend', 'P', 0, '#text', 2, 'Hello Wo'],
    ['selection-base-extent', '#text', 0, '#text', 5, 'Hello World', true, true],
    [
      'selection-composed',
      '[object StaticRange]',
      '#text',
      0,
      '#text',
      5,
      'forward',
      true,
      true,
      0,
      5,
    ],
    ['selection-backward', '#text', 3, '#text', 1, 'backward', 'ello Wor'],
    ['selection-delete', '', true, true, 0],
    ['selection-remove', 0, 'None'],
    ['selection-empty', 0, 'None', null],
    [
      'selection-shape',
      [],
      'none',
      null,
      0,
      null,
      0,
      0,
      null,
      [
        ['direction', true, true, 'get direction', 0],
        ['baseNode', true, true, 'get baseNode', 0],
        ['baseOffset', true, true, 'get baseOffset', 0],
        ['extentNode', true, true, 'get extentNode', 0],
        ['extentOffset', true, true, 'get extentOffset', 0],
        ['getComposedRanges', true, true, 'getComposedRanges', 0],
        ['modify', true, true, 'modify', 0],
      ],
    ],
    ['range-constants', 0, 1, 2, 3],
    ['range-compare', -1, 1, 0, -1],
    ['range-clone', '[object DocumentFragment]', true, '<b>B</b><i>C</i>', true, true, 1],
    ['range-extract', '<b>B</b><i>C</i>', 'AD', true, true, 1],
    ['range-text-extract', 'bcd', 'aef', true, true, 1],
    ['range-insert', 'a<em>X</em>ef'],
    ['range-surround', 'w<mark>ra</mark>p', 'ra', true, 1, 2],
    ['range-contextual', '[object DocumentFragment]', '<u>U</u>v'],
  ]);
  realm.destroy();
});

test('webapi core exposes basic CSSOM View geometry and scrolling', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    __zpUpdateViewport({
      innerWidth: 100,
      innerHeight: 80,
      layout: {
        'n-body': { x: 5, y: 100, width: 200, height: 300 },
        'n-el': { x: 20, y: 120, width: 40, height: 10 },
      },
    });
    const el = document.getElementById('el');
    const elementScrollEvents = [];
    el.addEventListener('scroll', () => elementScrollEvents.push([el.scrollLeft, el.scrollTop]));
    el.scrollTo({ left: 5, top: 7 });
    el.scrollBy(3, 4);
    el.scroll(1, 2);
    el.scrollBy({ left: -2, top: -5 });
    const quad = el.getBoxQuads()[0];
    const relativeQuad = el.getBoxQuads({ relativeTo: document.body })[0];
    const range = document.createRange();
    range.selectNode(el);
    const rangeRects = range.getClientRects();
    const rangeBounds = range.getBoundingClientRect();
    range.collapse(true);
    const collapsedRects = range.getClientRects();
    const collapsedBounds = range.getBoundingClientRect();
    el.scrollIntoView({ block: 'center', inline: 'end' });
    const centeredWindowScroll = [scrollX, scrollY];
    el.scrollIntoView(false);
    JSON.stringify({
      elementScroll: [el.scrollLeft, el.scrollTop, el.scroll === el.scrollTo, elementScrollEvents],
      quad: [Object.prototype.toString.call(quad), quad instanceof DOMQuad, quad.getBounds().toJSON()],
      relativeQuad: relativeQuad.getBounds().toJSON(),
      rangeGeometry: [
        Object.prototype.toString.call(rangeRects),
        rangeRects instanceof DOMRectList,
        rangeRects.length,
        rangeRects.item(0) instanceof DOMRect,
        rangeBounds.toJSON(),
        collapsedRects.length,
        collapsedBounds.toJSON(),
      ],
      windowScroll: [centeredWindowScroll, [scrollX, scrollY]],
    });
  `);
  assert.deepEqual(JSON.parse(result), {
    elementScroll: [
      0,
      0,
      true,
      [
        [5, 7],
        [8, 11],
        [1, 2],
        [0, 0],
      ],
    ],
    quad: [
      '[object DOMQuad]',
      true,
      { x: 20, y: 120, width: 40, height: 10, top: 120, right: 60, bottom: 130, left: 20 },
    ],
    relativeQuad: { x: 15, y: 20, width: 40, height: 10, top: 20, right: 55, bottom: 30, left: 15 },
    rangeGeometry: [
      '[object DOMRectList]',
      true,
      1,
      true,
      { x: 20, y: 120, width: 40, height: 10, top: 120, right: 60, bottom: 130, left: 20 },
      0,
      { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 },
    ],
    windowScroll: [
      [0, 85],
      [0, 135],
    ],
  });
  realm.destroy();
});

test('webapi core TreeWalker and NodeIterator honor show masks and filters', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    const host = document.createElement('div');
    host.innerHTML = '<p id="a">A<span id="b">B</span></p><!--c--><p id="d">D</p>';
    document.body.appendChild(host);
    const names = (next, limit = 10) => {
      const out = [];
      for (let node; (node = next()) && out.length < limit;) out.push(node.nodeName + ':' + (node.id || node.textContent || ''));
      return out;
    };
    const out = [];
    out.push(['constants', NodeFilter.SHOW_ELEMENT, NodeFilter.SHOW_TEXT, NodeFilter.FILTER_ACCEPT, NodeFilter.FILTER_REJECT, NodeFilter.FILTER_SKIP]);
    const descriptor = Object.getOwnPropertyDescriptor(NodeFilter, 'FILTER_ACCEPT');
    const globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'NodeFilter');
    const errorName = (callback) => {
      try {
        callback();
        return 'ok';
      } catch (error) {
        return error.name;
      }
    };
    out.push([
      'shape',
      typeof NodeFilter,
      Object.prototype.toString.call(NodeFilter),
      Object.getOwnPropertyNames(NodeFilter),
      [descriptor.enumerable, descriptor.configurable, descriptor.writable],
      [globalDescriptor.enumerable, globalDescriptor.configurable, globalDescriptor.writable],
      [errorName(() => NodeFilter()), errorName(() => new NodeFilter())],
    ]);
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_ELEMENT);
    const shapeIterator = document.createNodeIterator(host, NodeFilter.SHOW_ELEMENT);
    const treeWalkerGlobalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'TreeWalker');
    const nodeIteratorGlobalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'NodeIterator');
    const treeCurrentDescriptor = Object.getOwnPropertyDescriptor(TreeWalker.prototype, 'currentNode');
    const iteratorReferenceDescriptor = Object.getOwnPropertyDescriptor(NodeIterator.prototype, 'referenceNode');
    const constructError = (callback) => {
      try {
        callback();
        return ['ok'];
      } catch (error) {
        return [error.name, error.message];
      }
    };
    out.push([
      'traversal-shape',
      Object.getOwnPropertyNames(TreeWalker),
      Object.getOwnPropertySymbols(TreeWalker).length,
      Object.getOwnPropertyNames(TreeWalker.prototype),
      Object.getOwnPropertyNames(walker),
      [treeWalkerGlobalDescriptor.enumerable, treeWalkerGlobalDescriptor.configurable, treeWalkerGlobalDescriptor.writable],
      [treeCurrentDescriptor.enumerable, treeCurrentDescriptor.configurable, Boolean(treeCurrentDescriptor.get), Boolean(treeCurrentDescriptor.set)],
      constructError(() => new TreeWalker()),
      constructError(() => TreeWalker()),
      Object.getOwnPropertyNames(NodeIterator),
      Object.getOwnPropertySymbols(NodeIterator).length,
      Object.getOwnPropertyNames(NodeIterator.prototype),
      Object.getOwnPropertyNames(shapeIterator),
      [nodeIteratorGlobalDescriptor.enumerable, nodeIteratorGlobalDescriptor.configurable, nodeIteratorGlobalDescriptor.writable],
      [iteratorReferenceDescriptor.enumerable, iteratorReferenceDescriptor.configurable, Boolean(iteratorReferenceDescriptor.get), Boolean(iteratorReferenceDescriptor.set)],
      constructError(() => new NodeIterator()),
      constructError(() => NodeIterator()),
    ]);
    out.push(['walker-init', walker.root === host, walker.currentNode === host, walker.whatToShow, typeof walker.filter]);
    out.push(['walker-next', names(() => walker.nextNode())]);
    out.push(['walker-parent', walker.currentNode.id, walker.parentNode().nodeName + ':' + (walker.currentNode.id || '')]);
    out.push(['walker-siblings', walker.firstChild().nodeName + ':' + walker.currentNode.id, walker.nextSibling().nodeName + ':' + walker.currentNode.id, walker.previousSibling().nodeName + ':' + walker.currentNode.id]);
    const filtered = document.createTreeWalker(host, NodeFilter.SHOW_ELEMENT, { acceptNode(node) { return node.id === 'b' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP; } });
    out.push(['walker-filter', names(() => filtered.nextNode())]);
    const iter = document.createNodeIterator(host, NodeFilter.SHOW_ELEMENT);
    out.push(['iter-init', iter.root === host, iter.referenceNode === host, iter.pointerBeforeReferenceNode, iter.whatToShow, typeof iter.filter]);
    out.push(['iter-next', names(() => iter.nextNode())]);
    out.push(['iter-prev', names(() => iter.previousNode(), 3)]);
    JSON.stringify(out);
  `);
  assert.deepEqual(JSON.parse(result), [
    ['constants', 1, 4, 1, 2, 3],
    [
      'shape',
      'function',
      '[object Function]',
      [
        'length',
        'name',
        'FILTER_ACCEPT',
        'FILTER_REJECT',
        'FILTER_SKIP',
        'SHOW_ALL',
        'SHOW_ELEMENT',
        'SHOW_ATTRIBUTE',
        'SHOW_TEXT',
        'SHOW_CDATA_SECTION',
        'SHOW_ENTITY_REFERENCE',
        'SHOW_ENTITY',
        'SHOW_PROCESSING_INSTRUCTION',
        'SHOW_COMMENT',
        'SHOW_DOCUMENT',
        'SHOW_DOCUMENT_TYPE',
        'SHOW_DOCUMENT_FRAGMENT',
        'SHOW_NOTATION',
      ],
      [true, false, false],
      [false, true, true],
      ['TypeError', 'TypeError'],
    ],
    [
      'traversal-shape',
      ['length', 'name', 'prototype'],
      0,
      [
        'root',
        'whatToShow',
        'filter',
        'currentNode',
        'firstChild',
        'lastChild',
        'nextNode',
        'nextSibling',
        'parentNode',
        'previousNode',
        'previousSibling',
        'constructor',
      ],
      [],
      [false, true, true],
      [true, true, true, true],
      ['TypeError', "Failed to construct 'TreeWalker': Illegal constructor"],
      ['TypeError', 'Illegal constructor'],
      ['length', 'name', 'prototype'],
      0,
      [
        'root',
        'referenceNode',
        'pointerBeforeReferenceNode',
        'whatToShow',
        'filter',
        'detach',
        'nextNode',
        'previousNode',
        'constructor',
      ],
      [],
      [false, true, true],
      [true, true, true, false],
      ['TypeError', "Failed to construct 'NodeIterator': Illegal constructor"],
      ['TypeError', 'Illegal constructor'],
    ],
    ['walker-init', true, true, 1, 'object'],
    ['walker-next', ['P:a', 'SPAN:b', 'P:d']],
    ['walker-parent', 'd', 'DIV:'],
    ['walker-siblings', 'P:a', 'P:d', 'P:a'],
    ['walker-filter', ['SPAN:b']],
    ['iter-init', true, true, true, 1, 'object'],
    ['iter-next', ['DIV:ABD', 'P:a', 'SPAN:b', 'P:d']],
    ['iter-prev', ['P:d', 'SPAN:b', 'P:a']],
  ]);
  realm.destroy();
});

test('webapi core XPath facade handles common virtual DOM queries', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    const host = document.createElement('div');
    const firstP = document.createElement('p');
    firstP.id = 'a';
    firstP.append(document.createTextNode('A'));
    const span = document.createElement('span');
    span.id = 'b';
    span.append(document.createTextNode('B'));
    firstP.append(span);
    const secondP = document.createElement('p');
    secondP.id = 'd';
    secondP.className = 'x';
    secondP.append(document.createTextNode('D'));
    host.append(firstP, secondP);
    document.body.appendChild(host);
    const evaluator = new XPathEvaluator();
    const expression = evaluator.createExpression('//span', null);
    const first = expression.evaluate(document, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const snapshot = document.evaluate('//p', document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const iterator = document.evaluate('//p', document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
    const reused = document.evaluate('//span', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, first);
    const byId = document.evaluate('id("d")', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const stringResult = document.evaluate('string(//span)', document, null, XPathResult.STRING_TYPE, null);
    const countResult = document.evaluate('count(//p)', document, null, XPathResult.NUMBER_TYPE, null);
    const boolResult = document.evaluate('boolean(//span)', document, null, XPathResult.BOOLEAN_TYPE, null);
    const absolute = document.evaluate('/html/body/div', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const nsResolver = document.createNSResolver(document.documentElement);
    JSON.stringify([
      Object.prototype.toString.call(evaluator),
      Object.prototype.toString.call(expression),
      Object.prototype.toString.call(reused),
      reused === first,
      reused.singleNodeValue.id,
      snapshot.resultType,
      snapshot.snapshotLength,
      snapshot.snapshotItem(0).id,
      snapshot.snapshotItem(2),
      iterator.iterateNext().id,
      iterator.iterateNext().id,
      iterator.iterateNext(),
      byId.singleNodeValue.id,
      stringResult.stringValue,
      countResult.numberValue,
      boolResult.booleanValue,
      absolute.singleNodeValue.localName,
      typeof document.evaluate,
      typeof document.createExpression,
      typeof document.createNSResolver,
      nsResolver === document.documentElement,
      [XPathResult.ANY_TYPE, XPathResult.STRING_TYPE, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, XPathResult.FIRST_ORDERED_NODE_TYPE],
      (() => { try { new XPathExpression(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      (() => { try { new XPathResult(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
    ]);
  `);
  assert.deepEqual(JSON.parse(result), [
    '[object XPathEvaluator]',
    '[object XPathExpression]',
    '[object XPathResult]',
    true,
    'b',
    7,
    2,
    'a',
    null,
    'a',
    'd',
    null,
    'd',
    'B',
    2,
    true,
    'div',
    'function',
    'function',
    'function',
    true,
    [0, 2, 7, 9],
    ['TypeError', "Failed to construct 'XPathExpression': Illegal constructor"],
    ['TypeError', "Failed to construct 'XPathResult': Illegal constructor"],
  ]);
  realm.destroy();
});

test('webapi core CSSStyleDeclaration matches common browser style operations', async () => {
  const { realm } = await installCore();
  const result = realm.evalClassic(`
    const el = document.createElement('div');
    const style = el.style;
    const out = [];
    out.push(['initial', Object.prototype.toString.call(style), style.length, style.cssText, style.item(0), style.getPropertyValue('color')]);
    style.setProperty('color', 'red');
    style.setProperty('margin-left', '4px');
    style.setProperty('--x', ' y ');
    out.push(['setProperty', style.length, style.item(0), style.item(1), style.getPropertyValue('color'), style.color, style.marginLeft, style.getPropertyValue('--x'), style.cssText]);
    style.cssText = 'background-color: blue; width: 10px;';
    out.push(['cssText-set', style.length, style.item(0), style.item(1), style.backgroundColor, style.width, style.cssText]);
    out.push(['remove', style.removeProperty('width'), style.length, style.width, style.cssText]);
    document.body.appendChild(el);
    const computed = getComputedStyle(el);
    out.push(['computed', Object.prototype.toString.call(computed), computed.getPropertyValue('background-color'), computed.backgroundColor, typeof computed.item, computed.length > 0]);
    style.cssText = 'color: green !important; width: calc(1px + 2px); background-image: url("data:image/svg+xml;utf8,<svg></svg>");';
    out.push(['host-cssText', style.length, style.item(0), style.item(1), style.item(2), style.getPropertyValue('color'), style.getPropertyPriority('color'), style.width, style.backgroundImage, style.cssText]);
    out.push(['css-global', typeof CSS, Object.prototype.toString.call(CSS), CSS.escape('1 a#b'), CSS.supports('color', 'red'), CSS.supports('--custom', 'x'), CSS.supports('not-a-property', 'x'), CSS.supports('color: blue'), CSS.supports('(width: 1px)')]);
    const attributeStyleMap = el.attributeStyleMap;
    attributeStyleMap.set('height', new CSSUnitValue(8, 'px'));
    attributeStyleMap.append('--token', new CSSKeywordValue('ready'));
    const styleMapEntries = Array.from(attributeStyleMap.entries());
    out.push([
      'style-property-map',
      Object.prototype.toString.call(attributeStyleMap),
      attributeStyleMap instanceof StylePropertyMap,
      attributeStyleMap instanceof StylePropertyMapReadOnly,
      el.attributeStyleMap === attributeStyleMap,
      attributeStyleMap.size,
      attributeStyleMap.has('color'),
      attributeStyleMap.get('color').toString(),
      attributeStyleMap.getAll('height')[0].toString(),
      attributeStyleMap.get('--token').toString(),
      style.height,
      style.getPropertyValue('--token'),
      styleMapEntries.length,
      styleMapEntries[0][0],
      styleMapEntries[0][1] instanceof CSSStyleValue,
      Array.from(attributeStyleMap.keys()).includes('height'),
      Array.from(attributeStyleMap.values()).length,
      (() => { let seen = ''; attributeStyleMap.forEach((value, key, map) => { if (key === 'height' && map === attributeStyleMap) seen = value.toString(); }); return seen; })(),
      (() => { try { new StylePropertyMap(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      (() => { try { new StylePropertyMapReadOnly(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
    ]);
    const unit = new CSSUnitValue(12, 'px');
    const parsedUnit = CSSNumericValue.parse('2em');
    const sum = unit.add(parsedUnit);
    const clamp = new CSSMathClamp(CSS.px(1), CSS.px(2), CSS.px(3));
    const negate = new CSSMathNegate(unit);
    const invert = new CSSMathInvert(unit);
    const mathValuesDescriptor = Object.getOwnPropertyDescriptor(CSSMathSum.prototype, 'values');
    const clampLowerDescriptor = Object.getOwnPropertyDescriptor(CSSMathClamp.prototype, 'lower');
    const keyword = new CSSKeywordValue('auto');
    const unparsed = CSSStyleValue.parse('color', 'red');
    const variable = new CSSVariableReferenceValue('--brand', new CSSUnparsedValue(['red']));
    const position = new CSSPositionValue(new CSSUnitValue(25, 'px'), new CSSUnitValue(75, '%'));
    const unitValueDescriptor = Object.getOwnPropertyDescriptor(CSSUnitValue.prototype, 'value');
    const unitUnitDescriptor = Object.getOwnPropertyDescriptor(CSSUnitValue.prototype, 'unit');
    const keywordValueDescriptor = Object.getOwnPropertyDescriptor(CSSKeywordValue.prototype, 'value');
    const positionXDescriptor = Object.getOwnPropertyDescriptor(CSSPositionValue.prototype, 'x');
    const variableDescriptor = Object.getOwnPropertyDescriptor(CSSVariableReferenceValue.prototype, 'variable');
    const fallbackDescriptor = Object.getOwnPropertyDescriptor(CSSVariableReferenceValue.prototype, 'fallback');
    const captureCSSValueError = (callback) => {
      try {
        return ['ok', callback()];
      } catch (error) {
        return [error.name, error.message];
      }
    };
    out.push([
      'css-typed-om',
      Object.prototype.toString.call(unit),
      unit instanceof CSSNumericValue,
      unit instanceof CSSStyleValue,
      unit.value,
      unit.unit,
      unit.toString(),
      Object.prototype.toString.call(parsedUnit),
      parsedUnit.value,
      parsedUnit.unit,
      Object.prototype.toString.call(sum),
      sum instanceof CSSMathValue,
      sum.values.length,
      sum.values[1].unit,
      String(sum),
      CSSMathValue.length,
      CSSMathClamp.length,
      CSSMathNegate.length,
      Object.getOwnPropertyNames(CSSMathValue.prototype),
      Object.getOwnPropertyNames(CSSMathSum.prototype),
      [mathValuesDescriptor.enumerable, mathValuesDescriptor.configurable, mathValuesDescriptor.get.name, mathValuesDescriptor.get.length],
      Object.getOwnPropertyNames(CSSMathClamp.prototype),
      [clampLowerDescriptor.enumerable, clampLowerDescriptor.configurable, clampLowerDescriptor.get.name, clampLowerDescriptor.get.length],
      [clamp.lower.value, clamp.value.value, clamp.upper.value],
      Object.getOwnPropertyNames(CSSMathNegate.prototype),
      negate.value === unit,
      invert.value === unit,
      Object.prototype.toString.call(keyword),
      keyword.value,
      Object.getOwnPropertyNames(unit),
      Object.getOwnPropertyNames(CSSUnitValue.prototype),
      [unitValueDescriptor.enumerable, unitValueDescriptor.configurable, typeof unitValueDescriptor.get, typeof unitValueDescriptor.set],
      [unitUnitDescriptor.enumerable, unitUnitDescriptor.configurable, typeof unitUnitDescriptor.get, unitUnitDescriptor.set],
      [Object.getOwnPropertyDescriptor(globalThis, 'CSSUnitValue').enumerable, Object.getOwnPropertyDescriptor(globalThis, 'CSSUnitValue').configurable, Object.getOwnPropertyDescriptor(globalThis, 'CSSUnitValue').writable],
      Object.getOwnPropertyDescriptor(CSSUnitValue, 'prototype').writable,
      Object.prototype.hasOwnProperty.call(CSSUnitValue, Symbol.hasInstance),
      captureCSSValueError(() => CSSUnitValue(1, 'px')),
      captureCSSValueError(() => new CSSUnitValue()),
      captureCSSValueError(() => new CSSUnitValue(1, 'bad unit')),
      captureCSSValueError(() => new CSSUnitValue(Number.POSITIVE_INFINITY, 'px')),
      captureCSSValueError(() => { const value = new CSSUnitValue(1, 'px'); value.value = Symbol('x'); return value.value; }),
      captureCSSValueError(() => Object.create(CSSUnitValue.prototype).value),
      Object.getOwnPropertyNames(keyword),
      Object.getOwnPropertyNames(CSSKeywordValue.prototype),
      [keywordValueDescriptor.enumerable, keywordValueDescriptor.configurable, typeof keywordValueDescriptor.get, typeof keywordValueDescriptor.set],
      [Object.getOwnPropertyDescriptor(globalThis, 'CSSKeywordValue').enumerable, Object.getOwnPropertyDescriptor(globalThis, 'CSSKeywordValue').configurable, Object.getOwnPropertyDescriptor(globalThis, 'CSSKeywordValue').writable],
      Object.getOwnPropertyDescriptor(CSSKeywordValue, 'prototype').writable,
      Object.prototype.hasOwnProperty.call(CSSKeywordValue, Symbol.hasInstance),
      captureCSSValueError(() => CSSKeywordValue('auto')),
      captureCSSValueError(() => new CSSKeywordValue()),
      captureCSSValueError(() => new CSSKeywordValue(Symbol('x'))),
      captureCSSValueError(() => { const value = new CSSKeywordValue('auto'); value.value = Symbol('x'); return value.value; }),
      captureCSSValueError(() => Object.create(CSSKeywordValue.prototype).value),
      Object.prototype.toString.call(unparsed),
      unparsed.length,
      unparsed.toString(),
      Object.prototype.toString.call(variable),
      variable.variable,
      variable.fallback.toString(),
      variable instanceof CSSStyleValue,
      Object.getOwnPropertyNames(variable),
      Object.getOwnPropertyNames(CSSVariableReferenceValue.prototype),
      [variableDescriptor.enumerable, variableDescriptor.configurable, typeof variableDescriptor.get, typeof variableDescriptor.set],
      [fallbackDescriptor.enumerable, fallbackDescriptor.configurable, typeof fallbackDescriptor.get, fallbackDescriptor.set],
      [Object.getOwnPropertyDescriptor(globalThis, 'CSSVariableReferenceValue').enumerable, Object.getOwnPropertyDescriptor(globalThis, 'CSSVariableReferenceValue').configurable, Object.getOwnPropertyDescriptor(globalThis, 'CSSVariableReferenceValue').writable],
      Object.getOwnPropertyDescriptor(CSSVariableReferenceValue, 'prototype').writable,
      Object.prototype.hasOwnProperty.call(CSSVariableReferenceValue, Symbol.hasInstance),
      String(variable),
      captureCSSValueError(() => CSSVariableReferenceValue('--brand')),
      captureCSSValueError(() => new CSSVariableReferenceValue()),
      captureCSSValueError(() => new CSSVariableReferenceValue('brand')),
      captureCSSValueError(() => new CSSVariableReferenceValue(Symbol('brand'))),
      captureCSSValueError(() => new CSSVariableReferenceValue('--brand', 'red')),
      captureCSSValueError(() => { const value = new CSSVariableReferenceValue('--brand'); value.variable = 'brand'; return value.variable; }),
      captureCSSValueError(() => Object.create(CSSVariableReferenceValue.prototype).variable),
      Object.prototype.toString.call(position),
      position instanceof CSSStyleValue,
      position.x.value,
      position.y.unit,
      position.toString(),
      (() => { try { new CSSImageValue(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      (() => { try { new CSSStyleValue(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      (() => { try { new CSSNumericValue(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      (() => { try { new CSSNumericArray(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
    ]);
    const translate = new CSSTranslate(new CSSUnitValue(1, 'px'), new CSSUnitValue(2, 'px'));
    const rotate = new CSSRotate(new CSSUnitValue(45, 'deg'));
    const scale = new CSSScale(1, 2);
    const skewX = new CSSSkewX(new CSSUnitValue(10, 'deg'));
    const perspective = new CSSPerspective(new CSSUnitValue(100, 'px'));
    const matrixComponent = new CSSMatrixComponent({ is2D: true, toString: () => 'matrix(1, 0, 0, 1, 0, 0)' });
    const transform = new CSSTransformValue([translate, rotate, scale, skewX, matrixComponent]);
    out.push([
      'css-transform-typed-om',
      Object.prototype.toString.call(transform),
      transform.length,
      transform[0] === translate,
      transform.is2D,
      Array.from(transform).length,
      transform.toString(),
      Object.getOwnPropertyNames(position),
      Object.getOwnPropertyNames(CSSPositionValue.prototype),
      [positionXDescriptor.enumerable, positionXDescriptor.configurable, typeof positionXDescriptor.get, typeof positionXDescriptor.set],
      [Object.getOwnPropertyDescriptor(globalThis, 'CSSPositionValue').enumerable, Object.getOwnPropertyDescriptor(globalThis, 'CSSPositionValue').configurable, Object.getOwnPropertyDescriptor(globalThis, 'CSSPositionValue').writable],
      Object.getOwnPropertyDescriptor(CSSPositionValue, 'prototype').writable,
      Object.prototype.hasOwnProperty.call(CSSPositionValue, Symbol.hasInstance),
      captureCSSValueError(() => CSSPositionValue(new CSSUnitValue(1, 'px'), new CSSUnitValue(2, 'px'))),
      captureCSSValueError(() => new CSSPositionValue()),
      captureCSSValueError(() => new CSSPositionValue(new CSSUnitValue(1, 'px'))),
      captureCSSValueError(() => new CSSPositionValue(null, new CSSUnitValue(1, 'px'))),
      captureCSSValueError(() => { const value = new CSSPositionValue(new CSSUnitValue(1, 'px'), new CSSUnitValue(2, 'px')); value.x = 1; return value.x; }),
      captureCSSValueError(() => Object.create(CSSPositionValue.prototype).x),
      Object.prototype.toString.call(translate),
      translate.x.value,
      translate instanceof CSSTransformComponent,
      translate instanceof CSSStyleValue,
      translate.y.unit,
      translate.is2D,
      rotate.toString(),
      scale.toString(),
      skewX.toString(),
      Object.prototype.toString.call(perspective),
      perspective.length.value,
      perspective.is2D,
      Object.prototype.toString.call(matrixComponent),
      matrixComponent.is2D,
      matrixComponent.toString(),
      (() => { try { new CSSTransformComponent(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
    ]);
    const sheet = new CSSStyleSheet();
    const inserted = sheet.insertRule('a { color: red; width: 2px; }');
    const rule = sheet.cssRules.item(0);
    rule.selectorText = 'b';
    const mediaIndex = sheet.insertRule('@media screen { p { color: blue; } }', 1);
    const mediaRule = sheet.cssRules[1];
    const supportsIndex = sheet.insertRule('@supports (display: grid) { div { display: grid; } }', 2);
    const supportsRule = sheet.cssRules[2];
    sheet.deleteRule(2);
    const replacement = new CSSStyleSheet();
    replacement.replaceSync('x { height: 3px; }');
    const mediaListSheet = new CSSStyleSheet();
    const mediaList = mediaListSheet.media;
    mediaList.mediaText = 'screen';
    mediaList.appendMedium('print');
    const mediaListDuplicateSummary = (() => { mediaList.appendMedium('screen'); return [mediaList.length, mediaList.mediaText]; })();
    const mediaListDeleteMissing = (() => { try { mediaList.deleteMedium('speech'); return ['ok']; } catch (error) { return [error.name, error.message]; } })();
    let sheetList;
    const styleElement = document.createElement('style');
    styleElement.textContent = 'article { display: block; }';
    styleElement.media = 'screen';
    styleElement.setAttribute('title', 'base');
    const linkElement = document.createElement('link');
    linkElement.setAttribute('rel', 'preload stylesheet');
    linkElement.setAttribute('href', '/assets/app.css');
    linkElement.media = 'screen';
    linkElement.setAttribute('title', 'app');
    document.body.append(styleElement, linkElement);
    const documentSheets = document.styleSheets;
    sheetList = documentSheets;
    linkElement.setAttribute('href', '/assets/app-v2.css');
    linkElement.media = 'print';
    linkElement.setAttribute('title', 'app-v2');
    styleElement.media = 'print';
    const stylesheetReflectionSummary = [styleElement.sheet.media.mediaText, styleElement.sheet.title, linkElement.sheet.href, linkElement.sheet.media.mediaText, linkElement.sheet.title, documentSheets.item(1).href, documentSheets.item(1).media.mediaText];
    const adoptedSheet = new CSSStyleSheet();
    const adoptedArray = [adoptedSheet];
    document.adoptedStyleSheets = adoptedArray;
    adoptedArray.length = 0;
    const adoptedShadow = document.createElement('div').attachShadow({ mode: 'open' });
    adoptedShadow.adoptedStyleSheets = [adoptedSheet];
    let invalidDocumentAdopted = '';
    try { document.adoptedStyleSheets = [{}]; } catch (error) { invalidDocumentAdopted = error.name; }
    let invalidShadowAdopted = '';
    try { adoptedShadow.adoptedStyleSheets = [{}]; } catch (error) { invalidShadowAdopted = error.name; }
    const styleDisabledBefore = styleElement.disabled;
    styleElement.disabled = true;
    const styleDisabledSummary = [styleDisabledBefore, styleElement.disabled, styleElement.sheet.disabled, styleElement.hasAttribute('disabled')];
    styleElement.sheet.disabled = false;
    styleDisabledSummary.push(styleElement.disabled, styleElement.sheet.disabled);
    linkElement.disabled = true;
    const linkDisabledSummary = [linkElement.disabled, linkElement.sheet.disabled, linkElement.hasAttribute('disabled')];
    out.push([
      'cssom-rules',
      Object.prototype.toString.call(sheet),
      sheet instanceof CSSStyleSheet,
      sheet instanceof StyleSheet,
      inserted,
      mediaIndex,
      supportsIndex,
      Object.prototype.toString.call(sheet.cssRules),
      sheet.cssRules.length,
      Object.getOwnPropertyNames(sheet.cssRules).sort(),
      [
        Object.getOwnPropertyDescriptor(CSSRuleList.prototype, 'length').enumerable,
        Object.getOwnPropertyDescriptor(CSSRuleList.prototype, 'length').configurable,
        typeof Object.getOwnPropertyDescriptor(CSSRuleList.prototype, 'length').get,
        Object.getOwnPropertyDescriptor(CSSRuleList.prototype, 'length').set,
      ],
      [
        Object.getOwnPropertyDescriptor(CSSRuleList.prototype, 'item').enumerable,
        Object.getOwnPropertyDescriptor(CSSRuleList.prototype, 'item').configurable,
        Object.getOwnPropertyDescriptor(CSSRuleList.prototype, 'item').writable,
        typeof Object.getOwnPropertyDescriptor(CSSRuleList.prototype, 'item').value,
        Object.getOwnPropertyDescriptor(CSSRuleList.prototype, 'item').value.length,
      ],
      [
        Object.getOwnPropertyDescriptor(sheet.cssRules, '0').value === rule,
        Object.getOwnPropertyDescriptor(sheet.cssRules, '0').writable,
        Object.getOwnPropertyDescriptor(sheet.cssRules, '0').enumerable,
        Object.getOwnPropertyDescriptor(sheet.cssRules, '0').configurable,
      ],
      Object.prototype.toString.call(rule),
      rule instanceof CSSRule,
      rule.type,
      CSSRule.STYLE_RULE,
      rule.selectorText,
      rule.style.color,
      Object.prototype.toString.call(mediaRule),
      mediaRule instanceof CSSConditionRule,
      mediaRule instanceof CSSGroupingRule,
      mediaRule.media.mediaText,
      mediaRule.conditionText,
      Object.prototype.toString.call(supportsRule),
      supportsRule.conditionText,
      sheet.cssRules.length,
      replacement.cssRules[0].style.height,
      Object.prototype.toString.call(mediaList),
      mediaList.length,
      mediaList.mediaText,
      mediaList.item(0),
      mediaList.item(1),
      Object.getOwnPropertyNames(mediaList).sort(),
      [
        Object.getOwnPropertyDescriptor(MediaList.prototype, 'length').enumerable,
        Object.getOwnPropertyDescriptor(MediaList.prototype, 'length').configurable,
        typeof Object.getOwnPropertyDescriptor(MediaList.prototype, 'length').get,
        Object.getOwnPropertyDescriptor(MediaList.prototype, 'length').set,
      ],
      [
        Object.getOwnPropertyDescriptor(MediaList.prototype, 'appendMedium').enumerable,
        Object.getOwnPropertyDescriptor(MediaList.prototype, 'appendMedium').configurable,
        Object.getOwnPropertyDescriptor(MediaList.prototype, 'appendMedium').writable,
        typeof Object.getOwnPropertyDescriptor(MediaList.prototype, 'appendMedium').value,
        Object.getOwnPropertyDescriptor(MediaList.prototype, 'appendMedium').value.length,
      ],
      [
        Object.getOwnPropertyDescriptor(mediaList, '0').value,
        Object.getOwnPropertyDescriptor(mediaList, '0').writable,
        Object.getOwnPropertyDescriptor(mediaList, '0').enumerable,
        Object.getOwnPropertyDescriptor(mediaList, '0').configurable,
      ],
      mediaListDuplicateSummary,
      mediaListDeleteMissing,
      Object.prototype.toString.call(sheetList),
      sheetList.length,
      sheetList.item(0) === documentSheets.item(0),
      Object.prototype.toString.call(documentSheets),
      documentSheets.length,
      Object.getOwnPropertyNames(documentSheets).sort(),
      [
        Object.getOwnPropertyDescriptor(StyleSheetList.prototype, 'length').enumerable,
        Object.getOwnPropertyDescriptor(StyleSheetList.prototype, 'length').configurable,
        typeof Object.getOwnPropertyDescriptor(StyleSheetList.prototype, 'length').get,
        Object.getOwnPropertyDescriptor(StyleSheetList.prototype, 'length').set,
      ],
      [
        Object.getOwnPropertyDescriptor(StyleSheetList.prototype, 'item').enumerable,
        Object.getOwnPropertyDescriptor(StyleSheetList.prototype, 'item').configurable,
        Object.getOwnPropertyDescriptor(StyleSheetList.prototype, 'item').writable,
        typeof Object.getOwnPropertyDescriptor(StyleSheetList.prototype, 'item').value,
        Object.getOwnPropertyDescriptor(StyleSheetList.prototype, 'item').value.length,
      ],
      [
        Object.getOwnPropertyDescriptor(documentSheets, '0').value.ownerNode === styleElement,
        Object.getOwnPropertyDescriptor(documentSheets, '0').writable,
        Object.getOwnPropertyDescriptor(documentSheets, '0').enumerable,
        Object.getOwnPropertyDescriptor(documentSheets, '0').configurable,
      ],
      documentSheets.item(0).ownerNode === styleElement,
      documentSheets[0].cssRules[0].selectorText,
      styleElement.sheet === documentSheets.item(0),
      documentSheets.item(1).ownerNode === linkElement,
      documentSheets.item(1).href,
      linkElement.sheet === documentSheets.item(1),
      stylesheetReflectionSummary,
      document.adoptedStyleSheets[0] === adoptedSheet,
      document.adoptedStyleSheets.length,
      adoptedShadow.adoptedStyleSheets[0] === adoptedSheet,
      invalidDocumentAdopted,
      invalidShadowAdopted,
      styleDisabledSummary,
      linkDisabledSummary,
      (() => { try { new CSSRule(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      (() => { try { new StyleSheet(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      (() => { try { new CSSRuleList(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
    ]);
    const longSheet = new CSSStyleSheet();
    longSheet.insertRule('@import "theme.css" screen;');
    longSheet.insertRule('@font-face { font-family: Test; src: url(test.woff); }', 1);
    longSheet.insertRule('@page :first { margin-left: 1px; }', 2);
    longSheet.insertRule('@keyframes fade { from { opacity: 0; } }', 3);
    longSheet.insertRule('@namespace svg "http://www.w3.org/2000/svg";', 4);
    longSheet.insertRule('@layer alpha;', 5);
    longSheet.insertRule('@layer beta { a { color: green; } }', 6);
    longSheet.insertRule('@container main (width > 0px) { a { color: green; } }', 7);
    longSheet.insertRule('@scope (.card) { a { color: green; } }', 8);
    longSheet.insertRule('@starting-style { a { opacity: 0; } }', 9);
    longSheet.insertRule('& { color: purple; }', 10);
    longSheet.insertRule('@counter-style alpha-count { system: cyclic; symbols: "A"; suffix: ")"; fallback: decimal; }', 11);
    longSheet.insertRule('@property --brand-color { syntax: "<color>"; inherits: false; initial-value: red; }', 12);
    longSheet.insertRule('@font-feature-values Fancy { @styleset { nice: 1; } }', 13);
    longSheet.insertRule('@font-palette-values --brand { font-family: Fancy; base-palette: 1; override-colors: 0 red; }', 14);
    longSheet.insertRule('@position-try --flip { margin-left: 5px; }', 15);
    longSheet.insertRule('@view-transition { navigation: auto; types: slide fade; }', 16);
    const importRule = longSheet.cssRules[0];
    const fontFaceRule = longSheet.cssRules[1];
    const pageRule = longSheet.cssRules[2];
    const keyframesRule = longSheet.cssRules[3];
    const namespaceRule = longSheet.cssRules[4];
    const layerStatementRule = longSheet.cssRules[5];
    const layerBlockRule = longSheet.cssRules[6];
    const containerRule = longSheet.cssRules[7];
    const scopeRule = longSheet.cssRules[8];
    const startingStyleRule = longSheet.cssRules[9];
    const nestedDeclarations = longSheet.cssRules[10];
    const counterStyleRule = longSheet.cssRules[11];
    const propertyRule = longSheet.cssRules[12];
    const fontFeatureValuesRule = longSheet.cssRules[13];
    const fontPaletteValuesRule = longSheet.cssRules[14];
    const positionTryRule = longSheet.cssRules[15];
    const viewTransitionRule = longSheet.cssRules[16];
    out.push([
      'cssom-long-rules',
      Object.prototype.toString.call(importRule),
      importRule.href,
      importRule.media.mediaText,
      Object.prototype.toString.call(fontFaceRule),
      fontFaceRule.style.getPropertyValue('font-family'),
      Object.prototype.toString.call(pageRule),
      pageRule instanceof CSSGroupingRule,
      pageRule.selectorText,
      pageRule.style.marginLeft,
      Object.prototype.toString.call(keyframesRule),
      keyframesRule.name,
      keyframesRule.length,
      keyframesRule.findRule('from').style.getPropertyValue('opacity'),
      Object.prototype.toString.call(namespaceRule),
      namespaceRule.prefix,
      namespaceRule.namespaceURI,
      Object.prototype.toString.call(layerStatementRule),
      layerStatementRule.nameList.join('|'),
      Object.prototype.toString.call(layerBlockRule),
      layerBlockRule.name,
      Object.prototype.toString.call(containerRule),
      containerRule instanceof CSSConditionRule,
      containerRule.containerQuery,
      Object.prototype.toString.call(scopeRule),
      scopeRule.start,
      Object.prototype.toString.call(startingStyleRule),
      startingStyleRule instanceof CSSGroupingRule,
      Object.prototype.toString.call(nestedDeclarations),
      nestedDeclarations.style.color,
      Object.prototype.toString.call(counterStyleRule),
      counterStyleRule.name,
      counterStyleRule.system,
      counterStyleRule.symbols,
      counterStyleRule.fallback,
      Object.prototype.toString.call(propertyRule),
      propertyRule.name,
      propertyRule.syntax,
      propertyRule.inherits,
      propertyRule.initialValue,
      Object.prototype.toString.call(fontFeatureValuesRule),
      fontFeatureValuesRule.fontFamily,
      fontFeatureValuesRule.valueText.includes('nice'),
      Object.prototype.toString.call(fontPaletteValuesRule),
      fontPaletteValuesRule.name,
      fontPaletteValuesRule.fontFamily,
      fontPaletteValuesRule.basePalette,
      Object.prototype.toString.call(positionTryRule),
      positionTryRule.name,
      positionTryRule.style.marginLeft,
      Object.prototype.toString.call(viewTransitionRule),
      viewTransitionRule.navigation,
      viewTransitionRule.types.join('|'),
      (() => { try { new CSSImportRule(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      (() => { try { new CSSKeyframesRule(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      (() => { try { new CSSNestedDeclarations(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      (() => { try { new CSSCounterStyleRule(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      (() => { try { new CSSPropertyRule(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
    ]);
    JSON.stringify(out);
  `);
  assert.deepEqual(JSON.parse(result), [
    ['initial', '[object CSSStyleDeclaration]', 0, '', '', ''],
    [
      'setProperty',
      3,
      'color',
      'margin-left',
      'red',
      'red',
      '4px',
      'y',
      'color: red; margin-left: 4px; --x: y;',
    ],
    [
      'cssText-set',
      2,
      'background-color',
      'width',
      'blue',
      '10px',
      'background-color: blue; width: 10px;',
    ],
    ['remove', '10px', 1, '', 'background-color: blue;'],
    [
      'computed',
      '[object CSSStyleDeclaration]',
      'rgb(0, 0, 255)',
      'rgb(0, 0, 255)',
      'function',
      true,
    ],
    [
      'host-cssText',
      3,
      'width',
      'background-image',
      'color',
      'green',
      'important',
      'calc(3px)',
      'url("data:image/svg+xml;utf8,<svg></svg>")',
      'width: calc(3px); background-image: url("data:image/svg+xml;utf8,<svg></svg>"); color: green !important;',
    ],
    ['css-global', 'object', '[object CSS]', '\\31 \\ a\\#b', true, true, false, true, true],
    [
      'style-property-map',
      '[object StylePropertyMap]',
      true,
      true,
      true,
      5,
      true,
      'green',
      '8px',
      'ready',
      '8px',
      'ready',
      5,
      'width',
      true,
      true,
      5,
      '8px',
      ['TypeError', "Failed to construct 'StylePropertyMap': Illegal constructor"],
      ['TypeError', "Failed to construct 'StylePropertyMapReadOnly': Illegal constructor"],
    ],
    [
      'css-typed-om',
      '[object CSSUnitValue]',
      true,
      true,
      12,
      'px',
      '12px',
      '[object CSSUnitValue]',
      2,
      'em',
      '[object CSSMathSum]',
      true,
      2,
      'em',
      'sum(12px, 2em)',
      0,
      3,
      1,
      ['constructor', 'operator'],
      ['constructor', 'values'],
      [true, true, 'get values', 0],
      ['constructor', 'lower', 'value', 'upper'],
      [true, true, 'get lower', 0],
      [1, 2, 3],
      ['constructor', 'value'],
      true,
      true,
      '[object CSSKeywordValue]',
      'auto',
      [],
      ['value', 'unit', 'constructor'],
      [true, true, 'function', 'function'],
      [true, true, 'function', null],
      [false, true, true],
      false,
      false,
      [
        'TypeError',
        "Failed to construct 'CSSUnitValue': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      ],
      [
        'TypeError',
        "Failed to construct 'CSSUnitValue': 2 arguments required, but only 0 present.",
      ],
      ['TypeError', "Failed to construct 'CSSUnitValue': Invalid unit: bad unit"],
      ['TypeError', "Failed to construct 'CSSUnitValue': The provided double value is non-finite."],
      [
        'TypeError',
        "Failed to set the 'value' property on 'CSSUnitValue': Cannot convert a Symbol value to a number",
      ],
      ['TypeError', 'Illegal invocation'],
      [],
      ['value', 'constructor'],
      [true, true, 'function', 'function'],
      [false, true, true],
      false,
      false,
      [
        'TypeError',
        "Failed to construct 'CSSKeywordValue': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      ],
      [
        'TypeError',
        "Failed to construct 'CSSKeywordValue': 1 argument required, but only 0 present.",
      ],
      [
        'TypeError',
        "Failed to construct 'CSSKeywordValue': Cannot convert a Symbol value to a string",
      ],
      [
        'TypeError',
        "Failed to set the 'value' property on 'CSSKeywordValue': Cannot convert a Symbol value to a string",
      ],
      ['TypeError', 'Illegal invocation'],
      '[object CSSUnparsedValue]',
      1,
      'red',
      '[object CSSVariableReferenceValue]',
      '--brand',
      'red',
      false,
      [],
      ['variable', 'fallback', 'constructor'],
      [true, true, 'function', 'function'],
      [true, true, 'function', null],
      [false, true, true],
      false,
      false,
      '[object CSSVariableReferenceValue]',
      [
        'TypeError',
        "Failed to construct 'CSSVariableReferenceValue': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      ],
      [
        'TypeError',
        "Failed to construct 'CSSVariableReferenceValue': 1 argument required, but only 0 present.",
      ],
      [
        'TypeError',
        "Failed to construct 'CSSVariableReferenceValue': Invalid custom property name",
      ],
      [
        'TypeError',
        "Failed to construct 'CSSVariableReferenceValue': Cannot convert a Symbol value to a string",
      ],
      [
        'TypeError',
        "Failed to construct 'CSSVariableReferenceValue': parameter 2 is not of type 'CSSUnparsedValue'.",
      ],
      [
        'TypeError',
        "Failed to set the 'variable' property on 'CSSVariableReferenceValue': Invalid custom property name",
      ],
      ['TypeError', 'Illegal invocation'],
      '[object CSSPositionValue]',
      true,
      25,
      'percent',
      '25px 75%',
      ['TypeError', "Failed to construct 'CSSImageValue': Illegal constructor"],
      ['TypeError', "Failed to construct 'CSSStyleValue': Illegal constructor"],
      ['TypeError', "Failed to construct 'CSSNumericValue': Illegal constructor"],
      ['TypeError', "Failed to construct 'CSSNumericArray': Illegal constructor"],
    ],
    [
      'css-transform-typed-om',
      '[object CSSTransformValue]',
      5,
      true,
      true,
      5,
      'translate(1px, 2px) rotate(45deg) scale(1, 2) skewX(10deg) matrix(1, 0, 0, 1, 0, 0)',
      [],
      ['x', 'y', 'constructor'],
      [true, true, 'function', 'function'],
      [false, true, true],
      false,
      false,
      [
        'TypeError',
        "Failed to construct 'CSSPositionValue': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      ],
      [
        'TypeError',
        "Failed to construct 'CSSPositionValue': 2 arguments required, but only 0 present.",
      ],
      [
        'TypeError',
        "Failed to construct 'CSSPositionValue': 2 arguments required, but only 1 present.",
      ],
      [
        'TypeError',
        "Failed to construct 'CSSPositionValue': parameter 1 is not of type 'CSSNumericValue'.",
      ],
      [
        'TypeError',
        "Failed to set the 'x' property on 'CSSPositionValue': Failed to convert value to 'CSSNumericValue'.",
      ],
      ['TypeError', 'Illegal invocation'],
      '[object CSSTranslate]',
      1,
      true,
      true,
      'px',
      true,
      'rotate(45deg)',
      'scale(1, 2)',
      'skewX(10deg)',
      '[object CSSPerspective]',
      100,
      false,
      '[object CSSMatrixComponent]',
      true,
      'matrix(1, 0, 0, 1, 0, 0)',
      ['TypeError', "Failed to construct 'CSSTransformComponent': Illegal constructor"],
    ],
    [
      'cssom-rules',
      '[object CSSStyleSheet]',
      true,
      true,
      0,
      1,
      2,
      '[object CSSRuleList]',
      2,
      ['0', '1'],
      [true, true, 'function', null],
      [true, true, true, 'function', 1],
      [true, false, true, true],
      '[object CSSStyleRule]',
      true,
      1,
      1,
      'b',
      'red',
      '[object CSSMediaRule]',
      true,
      true,
      'screen',
      'screen',
      '[object CSSSupportsRule]',
      '(display: grid)',
      2,
      '3px',
      '[object MediaList]',
      2,
      'screen, print',
      'screen',
      'print',
      ['0', '1'],
      [true, true, 'function', null],
      [true, true, true, 'function', 1],
      ['screen', false, true, true],
      [2, 'screen, print'],
      [
        'NotFoundError',
        "Failed to execute 'deleteMedium' on 'MediaList': Failed to delete 'speech'.",
      ],
      '[object StyleSheetList]',
      2,
      true,
      '[object StyleSheetList]',
      2,
      ['0', '1'],
      [true, true, 'function', null],
      [true, true, true, 'function', 1],
      [true, false, true, true],
      true,
      'article',
      true,
      true,
      'https://target.example/assets/app-v2.css',
      true,
      [
        'print',
        'base',
        'https://target.example/assets/app-v2.css',
        'print',
        'app-v2',
        'https://target.example/assets/app-v2.css',
        'print',
      ],
      true,
      1,
      true,
      'TypeError',
      'TypeError',
      [false, true, true, false, false, false],
      [true, true, false],
      ['TypeError', "Failed to construct 'CSSRule': Illegal constructor"],
      ['TypeError', "Failed to construct 'StyleSheet': Illegal constructor"],
      ['TypeError', "Failed to construct 'CSSRuleList': Illegal constructor"],
    ],
    [
      'cssom-long-rules',
      '[object CSSImportRule]',
      'theme.css',
      'screen',
      '[object CSSFontFaceRule]',
      'Test',
      '[object CSSPageRule]',
      true,
      ':first',
      '1px',
      '[object CSSKeyframesRule]',
      'fade',
      1,
      '0',
      '[object CSSNamespaceRule]',
      'svg',
      'http://www.w3.org/2000/svg',
      '[object CSSLayerStatementRule]',
      'alpha',
      '[object CSSLayerBlockRule]',
      'beta',
      '[object CSSContainerRule]',
      true,
      'main (width > 0px)',
      '[object CSSScopeRule]',
      '(.card)',
      '[object CSSStartingStyleRule]',
      true,
      '[object CSSNestedDeclarations]',
      'purple',
      '[object CSSCounterStyleRule]',
      'alpha-count',
      'cyclic',
      '"A"',
      'decimal',
      '[object CSSPropertyRule]',
      '--brand-color',
      '"<color>"',
      false,
      'red',
      '[object CSSFontFeatureValuesRule]',
      'Fancy',
      true,
      '[object CSSFontPaletteValuesRule]',
      '--brand',
      'Fancy',
      '1',
      '[object CSSPositionTryRule]',
      '--flip',
      '5px',
      '[object CSSViewTransitionRule]',
      'auto',
      'slide|fade',
      ['TypeError', "Failed to construct 'CSSImportRule': Illegal constructor"],
      ['TypeError', "Failed to construct 'CSSKeyframesRule': Illegal constructor"],
      ['TypeError', "Failed to construct 'CSSNestedDeclarations': Illegal constructor"],
      ['TypeError', "Failed to construct 'CSSCounterStyleRule': Illegal constructor"],
      ['TypeError', "Failed to construct 'CSSPropertyRule': Illegal constructor"],
    ],
  ]);
  realm.destroy();
});

test('webapi core MutationObserver receives childList and attribute records', async () => {
  const { realm } = await installCore();
  realm.evalClassic(`
    globalThis.mutationResult = [];
    const root = document.getElementById('el');
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
    let newMutationRecord;
    try {
      new MutationRecord();
      newMutationRecord = ['ok'];
    } catch (error) {
      newMutationRecord = [error.name, error.message];
    }
    let callMutationRecord;
    try {
      MutationRecord();
      callMutationRecord = ['ok'];
    } catch (error) {
      callMutationRecord = [error.name, error.message];
    }
    let newMutationObserver;
    try {
      new MutationObserver();
      newMutationObserver = ['ok'];
    } catch (error) {
      newMutationObserver = [error.name, error.message];
    }
    globalThis.mutationRecordConstructor = [
      typeof MutationRecord,
      newMutationRecord,
      callMutationRecord,
      MutationRecord.length,
      MutationRecord.name,
      Object.getOwnPropertyNames(MutationRecord),
      Object.getOwnPropertyNames(MutationRecord.prototype),
      Object.getOwnPropertySymbols(MutationRecord.prototype).map(String),
      Object.prototype.hasOwnProperty.call(MutationRecord, Symbol.hasInstance),
      [
        Object.getOwnPropertyDescriptor(globalThis, 'MutationRecord').enumerable,
        Object.getOwnPropertyDescriptor(globalThis, 'MutationRecord').configurable,
        Object.getOwnPropertyDescriptor(globalThis, 'MutationRecord').writable,
      ],
      descriptorFlags(MutationRecord.prototype, 'type'),
      descriptorFlags(MutationRecord.prototype, 'constructor'),
    ];
    const webkitObserver = new WebKitMutationObserver(() => {});
    globalThis.webkitMutationSummary = [
      typeof WebKitMutationObserver,
      WebKitMutationObserver === MutationObserver,
      WebKitMutationObserver.prototype === MutationObserver.prototype,
      webkitObserver instanceof MutationObserver,
      webkitObserver instanceof WebKitMutationObserver,
      Object.prototype.toString.call(webkitObserver),
      Object.getOwnPropertyNames(webkitObserver),
    ];
    globalThis.mutationObserverStructure = {
      missing: newMutationObserver,
      length: MutationObserver.length,
      name: MutationObserver.name,
      prototype: Object.getOwnPropertyNames(MutationObserver.prototype),
      own: Object.getOwnPropertyNames(webkitObserver),
      tag: Object.prototype.toString.call(webkitObserver),
      disconnect: descriptorFlags(MutationObserver.prototype, 'disconnect'),
      observe: descriptorFlags(MutationObserver.prototype, 'observe'),
      takeRecords: descriptorFlags(MutationObserver.prototype, 'takeRecords'),
      constructor: descriptorFlags(MutationObserver.prototype, 'constructor'),
    };
    const observer = new MutationObserver((records, source) => {
      for (const record of records) {
        if (!globalThis.mutationRecordShape) {
          globalThis.mutationRecordShape = {
            own: Object.getOwnPropertyNames(record),
            proto: Object.getOwnPropertyNames(Object.getPrototypeOf(record)),
            addedTag: Object.prototype.toString.call(record.addedNodes),
            addedOwn: Object.getOwnPropertyNames(record.addedNodes),
            addedProto: Object.getOwnPropertyNames(Object.getPrototypeOf(record.addedNodes)),
            addedInstance: record.addedNodes instanceof NodeList,
            addedItem: record.addedNodes.item(0)?.id || record.addedNodes.item(0)?.nodeName || null,
            removedTag: Object.prototype.toString.call(record.removedNodes),
            removedOwn: Object.getOwnPropertyNames(record.removedNodes),
            removedInstance: record.removedNodes instanceof NodeList,
          };
        }
        if (record.removedNodes.length) {
          globalThis.mutationRemovedNodesShape = {
            removedTag: Object.prototype.toString.call(record.removedNodes),
            removedOwn: Object.getOwnPropertyNames(record.removedNodes),
            removedInstance: record.removedNodes instanceof NodeList,
            removedItem: record.removedNodes.item(0)?.id || record.removedNodes.item(0)?.nodeName || null,
          };
        }
        mutationResult.push({
          observerMatch: source === observer,
          recordBrand: Object.prototype.toString.call(record),
          recordInstance: record instanceof MutationRecord,
          type: record.type,
          target: record.target.id || record.target.nodeName,
          added: record.addedNodes.length,
          removed: record.removedNodes.length,
          attributeName: record.attributeName || null,
          oldValue: record.oldValue ?? null,
        });
      }
    });
    observer.observe(root, { childList: true, attributes: true, subtree: true, attributeOldValue: true });
    const child = document.createElement('span');
    child.id = 'child';
    root.appendChild(child);
    child.setAttribute('data-x', '1');
    child.setAttribute('data-x', '2');
    root.removeChild(child);
  `);
  realm.drainJobs();
  assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(mutationResult)')), [
    {
      observerMatch: true,
      recordBrand: '[object MutationRecord]',
      recordInstance: true,
      type: 'childList',
      target: 'el',
      added: 1,
      removed: 0,
      attributeName: null,
      oldValue: null,
    },
    {
      observerMatch: true,
      recordBrand: '[object MutationRecord]',
      recordInstance: true,
      type: 'attributes',
      target: 'child',
      added: 0,
      removed: 0,
      attributeName: 'data-x',
      oldValue: null,
    },
    {
      observerMatch: true,
      recordBrand: '[object MutationRecord]',
      recordInstance: true,
      type: 'attributes',
      target: 'child',
      added: 0,
      removed: 0,
      attributeName: 'data-x',
      oldValue: '1',
    },
    {
      observerMatch: true,
      recordBrand: '[object MutationRecord]',
      recordInstance: true,
      type: 'childList',
      target: 'el',
      added: 0,
      removed: 1,
      attributeName: null,
      oldValue: null,
    },
  ]);
  assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(mutationRecordConstructor)')), [
    'function',
    ['TypeError', "Failed to construct 'MutationRecord': Illegal constructor"],
    ['TypeError', 'Illegal constructor'],
    0,
    'MutationRecord',
    ['length', 'name', 'prototype'],
    [
      'type',
      'target',
      'addedNodes',
      'removedNodes',
      'previousSibling',
      'nextSibling',
      'attributeName',
      'attributeNamespace',
      'oldValue',
      'constructor',
    ],
    ['Symbol(Symbol.toStringTag)'],
    false,
    [false, true, true],
    [true, true, 'function', 'undefined', null, 'undefined', null],
    [false, true, null, null, true, 'function', 0],
  ]);
  assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(webkitMutationSummary)')), [
    'function',
    true,
    true,
    true,
    true,
    '[object MutationObserver]',
    [],
  ]);
  assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(mutationObserverStructure)')), {
    missing: [
      'TypeError',
      "Failed to construct 'MutationObserver': 1 argument required, but only 0 present.",
    ],
    length: 1,
    name: 'MutationObserver',
    prototype: ['disconnect', 'observe', 'takeRecords', 'constructor'],
    own: [],
    tag: '[object MutationObserver]',
    disconnect: [true, true, null, null, true, 'function', 0],
    observe: [true, true, null, null, true, 'function', 1],
    takeRecords: [true, true, null, null, true, 'function', 0],
    constructor: [false, true, null, null, true, 'function', 1],
  });
  assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(mutationRecordShape)')), {
    own: [],
    proto: [
      'type',
      'target',
      'addedNodes',
      'removedNodes',
      'previousSibling',
      'nextSibling',
      'attributeName',
      'attributeNamespace',
      'oldValue',
      'constructor',
    ],
    addedTag: '[object NodeList]',
    addedOwn: ['0'],
    addedProto: ['entries', 'keys', 'values', 'forEach', 'length', 'item', 'constructor'],
    addedInstance: true,
    addedItem: 'child',
    removedTag: '[object NodeList]',
    removedOwn: [],
    removedInstance: true,
  });
  assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(mutationRemovedNodesShape)')), {
    removedTag: '[object NodeList]',
    removedOwn: ['0'],
    removedInstance: true,
    removedItem: 'child',
  });
  realm.destroy();
});

test('webapi core MutationObserver supports attribute filters and characterData old values', async () => {
  const { realm } = await installCore();
  realm.evalClassic(`
    globalThis.filteredMutationResult = [];
    globalThis.noOldMutationResult = [];
    const root = document.getElementById('el');
    const text = document.createTextNode('old');
    root.appendChild(text);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        filteredMutationResult.push({
          type: record.type,
          target: record.target.id || record.target.nodeName,
          attributeName: record.attributeName || null,
          oldValue: record.oldValue ?? null,
        });
      }
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['data-keep'],
      subtree: true,
      characterData: true,
      characterDataOldValue: true,
    });
    root.setAttribute('data-skip', 'x');
    root.setAttribute('data-keep', 'a');
    text.textContent = 'new';
    const noOld = new MutationObserver((records) => {
      noOldMutationResult = records.map((record) => ({
        type: record.type,
        target: record.target.nodeName,
        oldValue: record.oldValue ?? null,
      }));
    });
    noOld.observe(text, { characterData: true });
    text.textContent = 'newer';
  `);
  realm.drainJobs();
  assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(filteredMutationResult)')), [
    {
      type: 'attributes',
      target: 'el',
      attributeName: 'data-keep',
      oldValue: null,
    },
    {
      type: 'characterData',
      target: '#text',
      attributeName: null,
      oldValue: 'old',
    },
    {
      type: 'characterData',
      target: '#text',
      attributeName: null,
      oldValue: 'new',
    },
  ]);
  assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(noOldMutationResult)')), [
    {
      type: 'characterData',
      target: '#text',
      oldValue: null,
    },
  ]);
  realm.destroy();
});

test('webapi core exposes IndexedDB facade backed by the storage manager mirror', async () => {
  const { realm, storageManager, storagePartition } = await installCore();
  realm.evalClassic(`
    globalThis.idbResult = '';
    globalThis.idbTxEvents = [];
    const req = indexedDB.open('app-db', 1);
    const factorySummary = [
      Object.prototype.toString.call(indexedDB),
      indexedDB instanceof IDBFactory,
      typeof IDBFactory,
      (() => { try { new IDBFactory(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      typeof indexedDB.open,
      typeof indexedDB.deleteDatabase,
    ];
    const versionEvent = new IDBVersionChangeEvent('versionchange', { oldVersion: 1, newVersion: 2, dataLoss: 'total', bubbles: true, cancelable: true, composed: true });
    const defaultVersionEvent = new IDBVersionChangeEvent('default');
    const wrappedVersionEvent = new IDBVersionChangeEvent('wrapped', { oldVersion: -1, newVersion: -1 });
    const versionGlobalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'IDBVersionChangeEvent');
    const versionOldDescriptor = Object.getOwnPropertyDescriptor(IDBVersionChangeEvent.prototype, 'oldVersion');
    const captureVersionError = (callback) => {
      try {
        callback();
        return ['ok'];
      } catch (error) {
        return [error.name, error.message];
      }
    };
    const versionEventSummary = [
      Object.prototype.toString.call(versionEvent),
      versionEvent instanceof IDBVersionChangeEvent,
      versionEvent instanceof Event,
      versionEvent.type,
      versionEvent.bubbles,
      versionEvent.cancelable,
      versionEvent.composed,
      versionEvent.oldVersion,
      versionEvent.newVersion,
      versionEvent.dataLoss,
      versionEvent.dataLossMessage,
      defaultVersionEvent.oldVersion,
      defaultVersionEvent.newVersion,
      defaultVersionEvent.dataLoss,
      defaultVersionEvent.dataLossMessage,
      wrappedVersionEvent.oldVersion,
      wrappedVersionEvent.newVersion,
      Object.getOwnPropertyNames(IDBVersionChangeEvent.prototype),
      [versionOldDescriptor.enumerable, versionOldDescriptor.configurable, typeof versionOldDescriptor.get, versionOldDescriptor.set],
      [versionGlobalDescriptor.enumerable, versionGlobalDescriptor.configurable, versionGlobalDescriptor.writable],
      Object.getOwnPropertyDescriptor(IDBVersionChangeEvent, 'prototype').writable,
      Object.prototype.hasOwnProperty.call(IDBVersionChangeEvent, Symbol.hasInstance),
      Object.prototype.hasOwnProperty.call(versionEvent, 'oldVersion'),
      captureVersionError(() => IDBVersionChangeEvent('versionchange')),
      captureVersionError(() => new IDBVersionChangeEvent()),
      captureVersionError(() => new IDBVersionChangeEvent(Symbol('versionchange'))),
      captureVersionError(() => new IDBVersionChangeEvent('bad', { oldVersion: Symbol('old') })),
      captureVersionError(() => new IDBVersionChangeEvent('bad', { dataLoss: 'bad' })),
    ];
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore('items', { keyPath: 'id' });
      store.createIndex('byValue', 'value');
      store.createIndex('byTag', 'tags', { multiEntry: true });
      store.createIndex('byPair', ['group', 'value']);
      store.put({ id: 'a', group: 'one', value: 1, tags: ['one', 'odd'] });
      store.put({ id: 'c', group: 'two', value: 3, tags: ['two', 'odd'] });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('items', 'readwrite');
      tx.oncomplete = () => globalThis.idbTxEvents.push('handler');
      tx.addEventListener('complete', () => globalThis.idbTxEvents.push('listener'));
      const store = tx.objectStore('items');
      const dbNameList = db.objectStoreNames;
      const storeIndexNames = store.indexNames;
      const byValueIndex = store.index('byValue');
      const internalSummary = [
        Object.prototype.toString.call(db),
        db instanceof IDBDatabase,
        Object.prototype.toString.call(tx),
        tx instanceof IDBTransaction,
        Object.prototype.toString.call(store),
        store instanceof IDBObjectStore,
        Object.prototype.toString.call(byValueIndex),
        byValueIndex instanceof IDBIndex,
        byValueIndex.objectStore instanceof IDBObjectStore,
        byValueIndex.objectStore.name,
        (() => { try { new IDBDatabase(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new IDBTransaction(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new IDBObjectStore(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new IDBIndex(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ];
      let newDOMStringList;
      try { new DOMStringList(); newDOMStringList = ['ok']; } catch (error) { newDOMStringList = [error.name, error.message]; }
      const nameListSummary = [
        Object.prototype.toString.call(dbNameList),
        dbNameList instanceof DOMStringList,
        dbNameList.length,
        dbNameList[0],
        dbNameList.item(0),
        dbNameList.item(9),
        dbNameList.contains('items'),
        Array.from(dbNameList),
        Object.getOwnPropertyNames(dbNameList).sort(),
        [
          Object.getOwnPropertyDescriptor(DOMStringList.prototype, 'length').enumerable,
          Object.getOwnPropertyDescriptor(DOMStringList.prototype, 'length').configurable,
          typeof Object.getOwnPropertyDescriptor(DOMStringList.prototype, 'length').get,
          Object.getOwnPropertyDescriptor(DOMStringList.prototype, 'length').set,
        ],
        [
          Object.getOwnPropertyDescriptor(DOMStringList.prototype, 'contains').enumerable,
          Object.getOwnPropertyDescriptor(DOMStringList.prototype, 'contains').configurable,
          Object.getOwnPropertyDescriptor(DOMStringList.prototype, 'contains').writable,
          typeof Object.getOwnPropertyDescriptor(DOMStringList.prototype, 'contains').value,
          Object.getOwnPropertyDescriptor(DOMStringList.prototype, 'contains').value.length,
        ],
        Object.prototype.toString.call(storeIndexNames),
        storeIndexNames instanceof DOMStringList,
        storeIndexNames.contains('byPair'),
        storeIndexNames.item(1),
        typeof DOMStringList,
        newDOMStringList,
      ];
      const putReq = store.put({ id: 'b', group: 'two', value: 2, tags: ['two', 'even'] });
      const requestSummary = [
        Object.prototype.toString.call(req),
        req instanceof IDBOpenDBRequest,
        req instanceof IDBRequest,
        Object.prototype.toString.call(putReq),
        putReq instanceof IDBRequest,
        putReq instanceof IDBOpenDBRequest,
        (() => { try { new IDBRequest(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new IDBOpenDBRequest(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ];
      putReq.onsuccess = () => {
        const indexReq = byValueIndex.get(2);
        indexReq.onsuccess = () => {
          const keyRange = IDBKeyRange.bound('b', 'c');
          const keyRangeSummary = [
            Object.prototype.toString.call(keyRange),
            keyRange instanceof IDBKeyRange,
            keyRange.includes('b'),
            keyRange.includes('a'),
            keyRange.lower,
            keyRange.upper,
            (() => { try { new IDBKeyRange(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          ];
          const rangeReq = store.getAll(keyRange);
          rangeReq.onsuccess = () => {
            const keys = [];
            let cursorSummary = null;
            const cursorReq = store.openCursor();
            cursorReq.onsuccess = () => {
              const cursor = cursorReq.result;
              if (cursor) {
                if (!cursorSummary) cursorSummary = [
                  Object.prototype.toString.call(cursor),
                  cursor instanceof IDBCursor,
                  cursor instanceof IDBCursorWithValue,
                  typeof IDBCursor,
                  (() => { try { new IDBCursor(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
                  (() => { try { new IDBCursorWithValue(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
                ];
                keys.push(cursor.primaryKey + ':' + cursor.value.value);
                cursor.continue();
                return;
              }
              const tagValues = [];
              const tagReq = store.index('byTag').openCursor('two');
              tagReq.onsuccess = () => {
                const tagCursor = tagReq.result;
                if (tagCursor) {
                  tagValues.push(tagCursor.primaryKey + ':' + tagCursor.value.id);
                  tagCursor.continue();
                  return;
                }
                const valueRange = [];
                const valueReq = store.index('byValue').openCursor(IDBKeyRange.bound(2, 3, true, false));
                valueReq.onsuccess = () => {
                  const valueCursor = valueReq.result;
                  if (valueCursor) {
                    valueRange.push(valueCursor.primaryKey + ':' + valueCursor.key + ':' + valueCursor.direction);
                    valueCursor.continue();
                    return;
                  }
                  const prevKeys = [];
                  const prevReq = store.openCursor(undefined, 'prev');
                  prevReq.onsuccess = () => {
                    const prevCursor = prevReq.result;
                    if (prevCursor) {
                      prevKeys.push(prevCursor.primaryKey + ':' + prevCursor.direction);
                      prevCursor.continue();
                      return;
                    }
                    const pairReq = store.index('byPair').get(['two', 2]);
                    pairReq.onsuccess = () => {
                      globalThis.idbResult = JSON.stringify({
                        index: indexReq.result,
                        pair: pairReq.result,
                        range: rangeReq.result,
                        keys,
                        prevKeys,
                        tagValues,
                        valueRange,
                        nameListSummary,
                        cursorSummary,
                        keyRangeSummary,
                        requestSummary,
                        internalSummary,
                        factorySummary,
                        versionEventSummary,
                      });
                    };
                  };
                };
              };
            };
          };
        };
      };
    };
  `);
  for (let i = 0; i < 32; i++) realm.drainJobs();
  assert.deepEqual(JSON.parse(realm.evalClassic('idbResult')), {
    index: { id: 'b', group: 'two', value: 2, tags: ['two', 'even'] },
    pair: { id: 'b', group: 'two', value: 2, tags: ['two', 'even'] },
    range: [
      { id: 'b', group: 'two', value: 2, tags: ['two', 'even'] },
      { id: 'c', group: 'two', value: 3, tags: ['two', 'odd'] },
    ],
    keys: ['a:1', 'b:2', 'c:3'],
    prevKeys: ['c:prev', 'b:prev', 'a:prev'],
    tagValues: ['b:b', 'c:c'],
    valueRange: ['c:3:next'],
    nameListSummary: [
      '[object DOMStringList]',
      true,
      1,
      'items',
      'items',
      null,
      true,
      ['items'],
      ['0'],
      [true, true, 'function', null],
      [true, true, true, 'function', 1],
      '[object DOMStringList]',
      true,
      true,
      'byTag',
      'function',
      ['TypeError', "Failed to construct 'DOMStringList': Illegal constructor"],
    ],
    cursorSummary: [
      '[object IDBCursorWithValue]',
      true,
      true,
      'function',
      ['TypeError', "Failed to construct 'IDBCursor': Illegal constructor"],
      ['TypeError', "Failed to construct 'IDBCursorWithValue': Illegal constructor"],
    ],
    keyRangeSummary: [
      '[object IDBKeyRange]',
      true,
      true,
      false,
      'b',
      'c',
      ['TypeError', "Failed to construct 'IDBKeyRange': Illegal constructor"],
    ],
    requestSummary: [
      '[object IDBOpenDBRequest]',
      true,
      true,
      '[object IDBRequest]',
      true,
      false,
      ['TypeError', "Failed to construct 'IDBRequest': Illegal constructor"],
      ['TypeError', "Failed to construct 'IDBOpenDBRequest': Illegal constructor"],
    ],
    internalSummary: [
      '[object IDBDatabase]',
      true,
      '[object IDBTransaction]',
      true,
      '[object IDBObjectStore]',
      true,
      '[object IDBIndex]',
      true,
      true,
      'items',
      ['TypeError', "Failed to construct 'IDBDatabase': Illegal constructor"],
      ['TypeError', "Failed to construct 'IDBTransaction': Illegal constructor"],
      ['TypeError', "Failed to construct 'IDBObjectStore': Illegal constructor"],
      ['TypeError', "Failed to construct 'IDBIndex': Illegal constructor"],
    ],
    factorySummary: [
      '[object IDBFactory]',
      true,
      'function',
      ['TypeError', "Failed to construct 'IDBFactory': Illegal constructor"],
      'function',
      'function',
    ],
    versionEventSummary: [
      '[object IDBVersionChangeEvent]',
      true,
      true,
      'versionchange',
      false,
      false,
      false,
      1,
      2,
      'total',
      '',
      0,
      null,
      'none',
      '',
      18446744073709552000,
      18446744073709552000,
      ['oldVersion', 'newVersion', 'dataLoss', 'dataLossMessage', 'constructor'],
      [true, true, 'function', null],
      [false, true, true],
      false,
      false,
      false,
      [
        'TypeError',
        "Failed to construct 'IDBVersionChangeEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      ],
      [
        'TypeError',
        "Failed to construct 'IDBVersionChangeEvent': 1 argument required, but only 0 present.",
      ],
      [
        'TypeError',
        "Failed to construct 'IDBVersionChangeEvent': Cannot convert a Symbol value to a string",
      ],
      [
        'TypeError',
        "Failed to construct 'IDBVersionChangeEvent': Failed to read the 'oldVersion' property from 'IDBVersionChangeEventInit': Cannot convert a Symbol value to a number",
      ],
      [
        'TypeError',
        "Failed to construct 'IDBVersionChangeEvent': Failed to read the 'dataLoss' property from 'IDBVersionChangeEventInit': The provided value 'bad' is not a valid enum value of type IDBDataLossAmount.",
      ],
    ],
  });
  assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(idbTxEvents)')), [
    'handler',
    'listener',
  ]);
  await storageManager.flush();
  const snapshot = await storageManager.loadSnapshot(storagePartition);
  const database = Object.fromEntries(snapshot.indexedDB)['app-db'];
  assert.equal(database.version, 1);
  assert.deepEqual(database.stores.items.records.b, {
    id: 'b',
    group: 'two',
    value: 2,
    tags: ['two', 'even'],
  });
  assert.deepEqual(Object.keys(database.stores.items.indexes).sort(), [
    'byPair',
    'byTag',
    'byValue',
  ]);
  realm.destroy();
});

test('webapi core persists Cache API entries through the storage manager', async () => {
  const { realm, storageManager, storagePartition } = await installCore();
  realm.evalClassic(`
    globalThis.cachePersistResult = '';
    (async () => {
      const cache = await caches.open('persistent');
      await cache.put('/asset.txt', new Response('asset-body', { status: 201, headers: [['Content-Type', 'text/plain']] }));
      const match = await caches.match('/asset.txt');
      globalThis.cachePersistResult = await match.text();
    })();
  `);
  for (let i = 0; i < 8; i++) realm.drainJobs();
  assert.equal(realm.evalClassic('cachePersistResult'), 'asset-body');
  await storageManager.flush();
  const snapshot = await storageManager.loadSnapshot(storagePartition);
  assert.equal(snapshot.cacheAPI.length, 1);
  assert.equal(snapshot.cacheAPI[0].cacheName, 'persistent');
  assert.equal(snapshot.cacheAPI[0].response.body, 'asset-body');
  realm.destroy();
});
