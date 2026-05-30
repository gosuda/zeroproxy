(() => {
  'use strict';
  if (self.__ZP_WORKER_PRELUDE) return;
  Object.defineProperty(self, '__ZP_WORKER_PRELUDE', { value: true, enumerable: false, configurable: false });
  const proxyOrigin = String(self.__ZP_WORKER_PROXY_ORIGIN || self.location && self.location.origin || '');
  function internalURL(path) {
    return proxyOrigin ? new URL(path, proxyOrigin).href : path;
  }
  importScripts(internalURL('/zp/assets/zp-core.js'));
  const nativeFunctionToString = self.Function && self.Function.prototype && self.Function.prototype.toString;
  const toStringMap = new WeakMap();
  function nativeFunctionSource(name) { return 'function ' + name + '() { [native code] }'; }
  function maskNativeFunction(fn, name) {
    if (typeof fn === 'function') toStringMap.set(fn, nativeFunctionSource(name));
  }
  if (nativeFunctionToString) {
    const maskedToString = function toString() {
      if (toStringMap.has(this)) return toStringMap.get(this);
      return nativeFunctionToString.call(this);
    };
    toStringMap.set(maskedToString, nativeFunctionSource('toString'));
    try { Object.defineProperty(self.Function.prototype, 'toString', { value: maskedToString, enumerable: false, configurable: true, writable: true }); } catch {}
  }
  const nativeFetch = self.fetch.bind(self);
  const base = new URL(self.__ZP_WORKER_LOCATION || self.__ZP_WORKER_TARGET || 'https://invalid.local/');
  function makeWorkerLocationFacade(url) {
    const loc = {};
    for (const prop of ['href','origin','protocol','host','hostname','port','pathname','search','hash']) {
      Object.defineProperty(loc, prop, { get: () => url[prop], enumerable: false, configurable: true });
    }
    Object.defineProperty(loc, 'toString', { value: function toString() { return url.href; }, enumerable: false, configurable: true });
    Object.defineProperty(loc, Symbol.toStringTag, { value: 'WorkerLocation', enumerable: false, configurable: true });
    try { Object.defineProperty(loc, 'constructor', { value: self.location && self.location.constructor, enumerable: false, configurable: true }); } catch {}
    return loc;
  }
  const workerLocation = makeWorkerLocationFacade(base);
  try { Object.defineProperty(self, 'location', { value: workerLocation, enumerable: true, configurable: true }); } catch {}
  try { Object.defineProperty(self, 'origin', { value: base.origin, enumerable: true, configurable: true }); } catch {}
  const tabId = String(self.__ZP_WORKER_TAB_ID || '');
  const runtimeToken = String(self.__ZP_WORKER_RUNTIME_TOKEN || '');
  const blockedDynamic = function(){ try { throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError'); } catch(e) { throw e; } };
  const scope = new Proxy(self, {
    has(_target, prop) { return prop !== Symbol.unscopables; },
    get(target, prop) {
      if (prop === Symbol.unscopables) return undefined;
      if (prop === 'self' || prop === 'globalThis' || prop === 'window' || prop === 'top' || prop === 'parent' || prop === 'frames') return scope;
      if (prop === 'location') return workerLocation;
      return Reflect.get(target, prop);
    },
    set(target, prop, value) { return Reflect.set(target, prop, value); }
  });
  Object.defineProperty(self, '__zp_runClassic', { value: fn => fn(scope), enumerable: false, configurable: false });
  function expose(name, value) { Object.defineProperty(self, name, { value, enumerable: false, configurable: false }); }
  function isWorkerGlobal(value) { return value === self || value === scope; }
  function workerTarget(value) { return value === scope ? self : value; }
  function get(target, prop) {
    if (typeof prop !== 'symbol') prop = String(prop);
    if (isWorkerGlobal(target)) {
      if (prop === 'self' || prop === 'globalThis' || prop === 'window' || prop === 'top' || prop === 'parent' || prop === 'frames') return scope;
      if (prop === 'location') return workerLocation;
    }
    const actual = workerTarget(target);
    const value = Reflect.get(Object(actual), prop);
    return prop === 'postMessage' && typeof value === 'function' ? value.bind(actual) : value;
  }
  function optionalGet(target, prop) {
    if (target === null || target === undefined) return undefined;
    return get(target, prop);
  }
  function set(target, prop, value) {
    if (typeof prop !== 'symbol') prop = String(prop);
    if ((isWorkerGlobal(target) && prop === 'location') || target === workerLocation) blockedDynamic();
    Reflect.set(Object(workerTarget(target)), prop, value);
    return value;
  }
  function assign(target, prop, operator, value) {
    const current = get(target, prop);
    let next;
    switch (operator) {
      case '+=': next = current + value; break;
      case '-=': next = current - value; break;
      case '*=': next = current * value; break;
      case '/=': next = current / value; break;
      case '%=': next = current % value; break;
      case '**=': next = current ** value; break;
      case '<<=': next = current << value; break;
      case '>>=': next = current >> value; break;
      case '>>>=': next = current >>> value; break;
      case '&=': next = current & value; break;
      case '^=': next = current ^ value; break;
      case '|=': next = current | value; break;
      case '&&=': if (!current) return current; next = value(); break;
      case '||=': if (current) return current; next = value(); break;
      case '??=': if (current !== null && current !== undefined) return current; next = value(); break;
      default: blockedDynamic();
    }
    return set(target, prop, next);
  }
  function update(target, prop, operator, prefix) {
    const current = get(target, prop);
    const next = operator === '++' ? current + 1 : current - 1;
    set(target, prop, next);
    return prefix ? next : current;
  }
  function call(target, prop, args) {
    const actual = workerTarget(target);
    return Reflect.apply(get(target, prop), actual, Array.isArray(args) ? args : []);
  }
  function optionalCall(target, prop, args) {
    if (target === null || target === undefined) return undefined;
    const fn = optionalGet(target, prop);
    if (fn === null || fn === undefined) return undefined;
    return call(target, prop, args);
  }
  function construct(ctor, args) { return Reflect.construct(ctor, Array.isArray(args) ? args : []); }
  function has(target, prop) { return isWorkerGlobal(target) && prop === 'location' || Reflect.has(Object(workerTarget(target)), prop); }
  function getOwnPropertyDescriptor(target, prop) {
    if (isWorkerGlobal(target) && prop === 'location') return { value: workerLocation, configurable: true, enumerable: true, writable: false };
    return Reflect.getOwnPropertyDescriptor(Object(workerTarget(target)), prop);
  }
  function ownKeys(target) { return Reflect.ownKeys(Object(workerTarget(target))); }
  expose('__zp_get', get);
  expose('__zp_optionalGet', optionalGet);
  expose('__zp_set', set);
  expose('__zp_assign', assign);
  expose('__zp_call', call);
  expose('__zp_optionalCall', optionalCall);
  expose('__zp_update', update);
  expose('__zp_construct', construct);
  expose('__zp_has', has);
  expose('__zp_getOwnPropertyDescriptor', getOwnPropertyDescriptor);
  expose('__zp_ownKeys', ownKeys);
  expose('__zp_module_url', (specifier, referrer) => {
    const spec = String(specifier);
    if (!spec.startsWith('/') && !spec.startsWith('./') && !spec.startsWith('../') && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec)) throw new TypeError('Blocked by ZeroProxy rewrite policy');
    const u = new URL(spec, referrer || base.href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw blockedDynamic();
    return internalURL('/zp/api/script?kind=module&u=' + encodeURIComponent(u.href) + '&tab=' + encodeURIComponent(tabId) + '&rt=' + encodeURIComponent(runtimeToken));
  });
  const TARGET_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
  const TARGET_APP_VERSION = TARGET_USER_AGENT.replace(/^Mozilla\//, '');
  const TARGET_PLATFORM = 'Win32';
  const TARGET_UA_BRANDS = Object.freeze([
    Object.freeze({ brand: 'Chromium', version: '134' }),
    Object.freeze({ brand: 'Not:A-Brand', version: '24' }),
    Object.freeze({ brand: 'Google Chrome', version: '134' })
  ]);
  const TARGET_UA_FULL_VERSION_LIST = Object.freeze([
    Object.freeze({ brand: 'Chromium', version: '134.0.0.0' }),
    Object.freeze({ brand: 'Not:A-Brand', version: '24.0.0.0' }),
    Object.freeze({ brand: 'Google Chrome', version: '134.0.0.0' })
  ]);
  function makeUserAgentData() {
    return Object.freeze({
      brands: Object.freeze(TARGET_UA_BRANDS.map(b => Object.freeze({ brand: b.brand, version: b.version }))),
      mobile: false,
      platform: 'Windows',
      getHighEntropyValues(hints) {
        const values = {
          architecture: 'x86',
          bitness: '64',
          brands: TARGET_UA_BRANDS.map(b => ({ brand: b.brand, version: b.version })),
          fullVersionList: TARGET_UA_FULL_VERSION_LIST.map(b => ({ brand: b.brand, version: b.version })),
          mobile: false,
          model: '',
          platform: 'Windows',
          platformVersion: '10.0.0',
          uaFullVersion: '134.0.0.0',
          fullVersion: '134.0.0.0',
          wow64: false
        };
        const out = { brands: values.brands, mobile: false, platform: 'Windows' };
        for (const hint of Array.isArray(hints) ? hints.map(String) : []) if (Object.prototype.hasOwnProperty.call(values, hint)) out[hint] = values[hint];
        return Promise.resolve(out);
      },
      toJSON() { return { brands: this.brands, mobile: false, platform: 'Windows' }; }
    });
  }
  const nav = self.navigator;
  if (nav) {
    const proto = self.WorkerNavigator && self.WorkerNavigator.prototype || Object.getPrototypeOf(nav);
    for (const [key, value] of [['userAgent', TARGET_USER_AGENT], ['appVersion', TARGET_APP_VERSION], ['platform', TARGET_PLATFORM]]) {
      try { Object.defineProperty(proto, key, { get: () => value, enumerable: false, configurable: false }); } catch {}
      try { Object.defineProperty(nav, key, { get: () => value, enumerable: false, configurable: false }); } catch {}
    }
    const userAgentData = makeUserAgentData();
    try { Object.defineProperty(proto, 'userAgentData', { get: () => userAgentData, enumerable: false, configurable: false }); } catch {}
    try { Object.defineProperty(nav, 'userAgentData', { get: () => userAgentData, enumerable: false, configurable: false }); } catch {}
  }
  function blocked(){ try { throw new DOMException('Blocked by ZeroProxy policy','NotSupportedError'); } catch(e) { throw e; } }
  function postMessageToSW(message, transfer) {
    const controller = nav && nav.serviceWorker && nav.serviceWorker.controller;
    if (!controller || !runtimeToken) return Promise.reject(new TypeError('NetworkError'));
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const sealed = Object.assign({}, message, { runtimeToken });
      channel.port1.onmessage = ev => {
        const data = ev.data || {};
        if (data.ok) resolve(data);
        else reject(new TypeError(data.error || 'NetworkError'));
      };
      controller.postMessage(sealed, transfer ? [channel.port2, ...transfer] : [channel.port2]);
    });
  }
  function workerUploadChannelName() {
    return '__zp_worker_upload:' + tabId + ':' + runtimeToken;
  }
  function isStreamableBody(body) {
    return !!body && typeof body.getReader === 'function';
  }
  function chunkToArrayBuffer(value) {
    let bytes;
    if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (value && value.buffer instanceof ArrayBuffer) bytes = new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength || value.buffer.byteLength);
    else bytes = new Uint8Array();
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  }
  function makeStreamCloser(reader, transport) {
    let closed = false;
    return {
      isClosed: () => closed,
      close() {
        if (closed) return;
        closed = true;
        try { reader.releaseLock && reader.releaseLock(); } catch {}
        try { transport.close(); } catch {}
      }
    };
  }
  function cancelReader(reader) {
    try { reader.cancel && reader.cancel(); } catch {}
  }
  // Serializes pulls behind a single-flight guard so a re-entrant pull (arriving while
  // a prior read() is in flight) is dropped rather than double-reading the body.
  function makePullGate(reader, sink, closer) {
    let reading = false;
    return async () => {
      if (closer.isClosed() || reading) return;
      reading = true;
      try { await pumpUploadChunk(reader, sink, closer); } finally { reading = false; }
    };
  }
  // Routes one inbound BroadcastChannel message addressed to this relay (role 'page',
  // matching id) to the open-stream lifecycle. `settle` carries the open-promise's
  // resolve/reject and a cancelTimer() that clears the ready timeout.
  function routeRelayMessage(msg, ctx) {
    if (msg.role !== 'page' || msg.id !== ctx.id) return;
    if (msg.type === 'ready') { ctx.settle.cancelTimer(); ctx.settle.resolve(String(msg.streamId || '')); return; }
    if (msg.type === 'cancel') { cancelReader(ctx.reader); ctx.closer.close(); return; }
    if (msg.type === 'error') { ctx.settle.cancelTimer(); ctx.closer.close(); ctx.settle.reject(new TypeError(msg.error || 'NetworkError')); return; }
    if (msg.type === 'pull') ctx.pull();
  }
  // Pulls one chunk and forwards it via the supplied transport sink, then closes on
  // done/error. `sink` owns the transport-specific postMessage (relay: no transfer;
  // MessageChannel: transfers the buffer) so each path keeps its exact semantics.
  async function pumpUploadChunk(reader, sink, closer) {
    try {
      const chunk = await reader.read();
      if (chunk.done) {
        sink.close();
        closer.close();
        return;
      }
      sink.chunk(chunkToArrayBuffer(chunk.value));
    } catch (err) {
      sink.error(err && (err.name || err.message) || 'NetworkError');
      closer.close();
    }
  }
  async function openRelayedUploadStream(body) {
    if (typeof self.BroadcastChannel !== 'function' || !isStreamableBody(body)) return '';
    const id = ZP.randomId('wup');
    const bc = new BroadcastChannel(workerUploadChannelName());
    const reader = body.getReader();
    const closer = makeStreamCloser(reader, bc);
    const sink = {
      chunk: (data) => bc.postMessage({ role: 'worker', type: 'chunk', id, tabId, runtimeToken, data }),
      close: () => bc.postMessage({ role: 'worker', type: 'close', id, tabId, runtimeToken }),
      error: (error) => bc.postMessage({ role: 'worker', type: 'error', id, tabId, runtimeToken, error })
    };
    const pull = makePullGate(reader, sink, closer);
    const streamId = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { closer.close(); reject(new TypeError('NetworkError')); }, 5000);
      const settle = { resolve, reject, cancelTimer: () => clearTimeout(timer) };
      const ctx = { id, reader, closer, pull, settle };
      bc.onmessage = ev => routeRelayMessage(ev && ev.data || {}, ctx);
      bc.postMessage({ role: 'worker', type: 'open', id, tabId, runtimeToken });
    });
    return streamId;
  }
  async function openUploadStream(body) {
    if (!isStreamableBody(body)) return '';
    const controller = nav && nav.serviceWorker && nav.serviceWorker.controller;
    if (!controller) return openRelayedUploadStream(body);
    const id = ZP.randomId('up');
    const channel = new MessageChannel();
    const port = channel.port1;
    const reader = body.getReader();
    const closer = makeStreamCloser(reader, port);
    const sink = {
      // chunk post is intentionally NOT wrapped: a throwing post (e.g. DataCloneError)
      // must propagate to pumpUploadChunk's catch so the stream fails closed (error + close).
      chunk: (data) => port.postMessage({ type: 'chunk', data }, [data]),
      close: () => { try { port.postMessage({ type: 'close' }); } catch {} },
      error: (error) => { try { port.postMessage({ type: 'error', error }); } catch {} }
    };
    const pull = makePullGate(reader, sink, closer);
    port.onmessage = ev => {
      const msg = ev && ev.data || {};
      if (msg.type === 'cancel') { cancelReader(reader); closer.close(); return; }
      if (msg.type === 'pull') return pull();
    };
    try {
      await postMessageToSW({ type: 'ZP_UPLOAD_STREAM_OPEN', tabId, id }, [channel.port2]);
      return id;
    } catch (err) {
      closer.close();
      return openRelayedUploadStream(body);
    }
  }
  function buildFetchRequest(input, init) {
    if (input && typeof input === 'object' && typeof input.url === 'string' && typeof input.clone === 'function') return new Request(input, init);
    return new Request(String(input), init);
  }
  // `priority` is not universally present on Request; guard membership and tolerate a
  // throwing getter so the header set never breaks the forward request.
  function setFetchPriorityHeader(req, headers) {
    if (!('priority' in req)) return;
    try { headers.set('X-ZP-Fetch-Priority', String(req.priority || '')); } catch {}
  }
  // Stamps the ZP transport headers carrying tab/runtime identity and the original
  // fetch-init semantics the server must replay. Every header is load-bearing.
  function buildForwardHeaders(req) {
    const headers = new Headers(req.headers);
    headers.set('X-ZP-Tab-Id', tabId);
    headers.set('X-ZP-Runtime-Token', runtimeToken);
    headers.set('X-ZP-Document-URL', self.__ZP_WORKER_TARGET || base.href);
    headers.set('X-ZP-Fetch-Credentials', req.credentials || 'same-origin');
    headers.set('X-ZP-Fetch-Mode', req.mode || 'cors');
    headers.set('X-ZP-Fetch-Cache', req.cache || 'default');
    headers.set('X-ZP-Fetch-Redirect', req.redirect || 'follow');
    headers.set('X-ZP-Fetch-Referrer', req.referrer || self.__ZP_WORKER_TARGET || 'about:client');
    headers.set('X-ZP-Fetch-Referrer-Policy', req.referrerPolicy || '');
    headers.set('X-ZP-Fetch-Integrity', req.integrity || '');
    headers.set('X-ZP-Fetch-Keepalive', req.keepalive ? '1' : '0');
    setFetchPriorityHeader(req, headers);
    return headers;
  }
  // Routes the request body through the upload-stream relay when present, falling back
  // to a half-duplex streaming body when no stream channel could be opened.
  async function applyUploadBody(req, headers, apiInit) {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const streamId = await openUploadStream(req.body).catch(() => '');
    if (streamId) { headers.set('X-ZP-Upload-Stream-Id', streamId); return; }
    apiInit.body = req.body;
    apiInit.duplex = 'half';
  }
  self.fetch = async function fetch(input, init={}) {
    const target = ZP.canonicalTargetURL(input && input.url || input, base.href).href;
    const req = buildFetchRequest(input, init);
    const headers = buildForwardHeaders(req);
    const apiInit = { method: req.method, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'follow' };
    await applyUploadBody(req, headers, apiInit);
    return nativeFetch(internalURL('/zp/api/fetch?url=' + encodeURIComponent(target)), apiInit);
  };
  maskNativeFunction(self.fetch, 'fetch');
  self.XMLHttpRequest = undefined;
  self.WebSocket = function(){ blocked(); };
  self.EventSource = function(){ blocked(); };
  self.RTCPeerConnection = self.webkitRTCPeerConnection = self.WebTransport = self.WebSocketStream = function(){ blocked(); };
  const nativeImportScripts = self.importScripts.bind(self);
  function importScriptURL(raw) {
    const value = String(raw);
    const internal = new URL(value, proxyOrigin || self.location.href);
    if (internal.origin === proxyOrigin && internal.pathname === '/zp/api/worker-script') return internal.href;
    const parsed = new URL(value, base.href);
    return internalURL('/zp/api/worker-script?tab=' + encodeURIComponent(tabId) + '&rt=' + encodeURIComponent(runtimeToken) + '&u=' + encodeURIComponent(ZP.canonicalTargetURL(parsed.href, base.href).href));
  }
  self.importScripts = function importScripts(...urls) { return nativeImportScripts(...urls.map(importScriptURL)); };
  maskNativeFunction(self.importScripts, 'importScripts');
})();
