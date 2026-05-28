(() => {
  'use strict';
  if (self.__ZP_WORKER_PRELUDE) return;
  Object.defineProperty(self, '__ZP_WORKER_PRELUDE', { value: true, enumerable: false, configurable: false });
  importScripts('/zp/assets/zp-core.js');
  const nativeFetch = self.fetch.bind(self);
  const base = new URL(self.__ZP_WORKER_TARGET || 'https://invalid.local/');
  const tabId = String(self.__ZP_WORKER_TAB_ID || '');
  const blockedDynamic = function(){ try { throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError'); } catch(e) { throw e; } };
  const scope = new Proxy(self, {
    has(_target, prop) { return prop !== Symbol.unscopables; },
    get(target, prop) {
      if (prop === Symbol.unscopables) return undefined;
      if (prop === 'self' || prop === 'globalThis' || prop === 'window' || prop === 'top' || prop === 'parent' || prop === 'frames') return scope;
      if (prop === 'location') return base;
      if (prop === 'eval' || prop === 'Function') return blockedDynamic;
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
      if (prop === 'location') return base;
      if (prop === 'eval' || prop === 'Function') return blockedDynamic;
    }
    const actual = workerTarget(target);
    const value = Reflect.get(Object(actual), prop);
    return prop === 'postMessage' && typeof value === 'function' ? value.bind(actual) : value;
  }
  function set(target, prop, value) {
    if (typeof prop !== 'symbol') prop = String(prop);
    if ((isWorkerGlobal(target) && prop === 'location') || target === base) blockedDynamic();
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
  function call(target, prop, args) {
    const actual = workerTarget(target);
    return Reflect.apply(get(target, prop), actual, Array.isArray(args) ? args : []);
  }
  function construct(ctor, args) { return Reflect.construct(ctor, Array.isArray(args) ? args : []); }
  function has(target, prop) { return isWorkerGlobal(target) && prop === 'location' || Reflect.has(Object(workerTarget(target)), prop); }
  function getOwnPropertyDescriptor(target, prop) {
    if (isWorkerGlobal(target) && prop === 'location') return { value: base, configurable: true, enumerable: true, writable: false };
    return Reflect.getOwnPropertyDescriptor(Object(workerTarget(target)), prop);
  }
  function ownKeys(target) { return Reflect.ownKeys(Object(workerTarget(target))); }
  expose('__zp_get', get);
  expose('__zp_set', set);
  expose('__zp_assign', assign);
  expose('__zp_call', call);
  expose('__zp_construct', construct);
  expose('__zp_has', has);
  expose('__zp_getOwnPropertyDescriptor', getOwnPropertyDescriptor);
  expose('__zp_ownKeys', ownKeys);
  expose('__zp_module_url', (specifier, referrer) => {
    const spec = String(specifier);
    if (!spec.startsWith('/') && !spec.startsWith('./') && !spec.startsWith('../') && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec)) throw new TypeError('Blocked by ZeroProxy rewrite policy');
    const u = new URL(spec, referrer || base.href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw blockedDynamic();
    return '/zp/api/script?kind=module&u=' + encodeURIComponent(u.href);
  });
  try { self.eval = blockedDynamic; } catch {}
  try { self.Function = blockedDynamic; } catch {}
  const TARGET_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
  const TARGET_APP_VERSION = TARGET_USER_AGENT.replace(/^Mozilla\//, '');
  const TARGET_PLATFORM = 'Win32';
  const nav = self.navigator;
  if (nav) {
    const proto = self.WorkerNavigator && self.WorkerNavigator.prototype || Object.getPrototypeOf(nav);
    for (const [key, value] of [['userAgent', TARGET_USER_AGENT], ['appVersion', TARGET_APP_VERSION], ['platform', TARGET_PLATFORM]]) {
      try { Object.defineProperty(proto, key, { get: () => value, enumerable: false, configurable: false }); } catch {}
      try { Object.defineProperty(nav, key, { get: () => value, enumerable: false, configurable: false }); } catch {}
    }
  }
  function blocked(){ try { throw new DOMException('Blocked by ZeroProxy policy','NotSupportedError'); } catch(e) { throw e; } }
  async function bodyToBase64(body) {
    if (body == null) return null;
    let ab;
    if (typeof body === 'string') ab = new TextEncoder().encode(body).buffer;
    else if (body instanceof ArrayBuffer) ab = body;
    else if (ArrayBuffer.isView(body)) ab = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    else if (body instanceof Blob) ab = await body.arrayBuffer();
    else if (body instanceof URLSearchParams) ab = new TextEncoder().encode(body.toString()).buffer;
    else ab = new TextEncoder().encode(String(body)).buffer;
    return ZP.bytesToBase64Url(new Uint8Array(ab));
  }
  self.fetch = async (input, init={}) => {
    const headers = new Headers(init.headers || input.headers || {});
    const body = init.body != null ? init.body : (input instanceof Request && input.method !== 'GET' && input.method !== 'HEAD' ? await input.clone().arrayBuffer() : null);
    return nativeFetch('/zp/api/fetch', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tabId, url: ZP.canonicalTargetURL(input.url || input, base.href).href, init:{ method:init.method || input.method || 'GET', headers: Array.from(headers.entries()), body: await bodyToBase64(body), credentials: init.credentials, mode: init.mode, referrer: init.referrer, redirect: init.redirect, cache: init.cache, integrity: init.integrity } }) });
  };
  self.XMLHttpRequest = undefined;
  self.WebSocket = function(){ blocked(); };
  self.EventSource = function(){ blocked(); };
  self.RTCPeerConnection = self.webkitRTCPeerConnection = self.WebTransport = self.WebSocketStream = function(){ blocked(); };
  const nativeImportScripts = self.importScripts.bind(self);
  function importScriptURL(raw) {
    const value = String(raw);
    const internal = new URL(value, self.location.href);
    if (internal.origin === self.location.origin && internal.pathname === '/zp/api/worker-script') return internal.pathname + internal.search + internal.hash;
    const parsed = new URL(value, base.href);
    return '/zp/api/worker-script?tab=' + encodeURIComponent(tabId) + '&u=' + encodeURIComponent(ZP.canonicalTargetURL(parsed.href, base.href).href);
  }
  self.importScripts = (...urls) => nativeImportScripts(...urls.map(importScriptURL));
})();
