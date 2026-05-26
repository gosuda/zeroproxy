(() => {
  'use strict';
  if (self.__ZP_WORKER_PRELUDE) return;
  Object.defineProperty(self, '__ZP_WORKER_PRELUDE', { value: true, enumerable: false, configurable: false });
  importScripts('/__zp/zp-core.js');
  const nativeFetch = self.fetch.bind(self);
  const base = new URL(self.__ZP_WORKER_TARGET || 'https://invalid.local/');
  const tabId = String(self.__ZP_WORKER_TAB_ID || '');
  const blockedDynamic = function(){ try { throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError'); } catch(e) { throw e; } };
  const scope = new Proxy(self, {
    has(_target, prop) { return prop !== Symbol.unscopables; },
    get(target, prop, receiver) {
      if (prop === Symbol.unscopables) return undefined;
      if (prop === 'self' || prop === 'globalThis') return scope;
      if (prop === 'location') return base;
      if (prop === 'eval' || prop === 'Function') return blockedDynamic;
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver) { return Reflect.set(target, prop, value, receiver); }
  });
  Object.defineProperty(self, '__zp_runClassic', { value: fn => fn(scope), enumerable: false, configurable: false });
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
    return nativeFetch('/__zp/api/fetch', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tabId, url: ZP.canonicalTargetURL(input.url || input, base.href).href, init:{ method:init.method || input.method || 'GET', headers: Array.from(headers.entries()), body: await bodyToBase64(body), credentials: init.credentials, mode: init.mode, referrer: init.referrer, redirect: init.redirect, cache: init.cache, integrity: init.integrity } }) });
  };
  self.XMLHttpRequest = undefined;
  self.WebSocket = function(){ blocked(); };
  self.EventSource = function(){ blocked(); };
  self.RTCPeerConnection = self.webkitRTCPeerConnection = self.WebTransport = self.WebSocketStream = function(){ blocked(); };
  const nativeImportScripts = self.importScripts.bind(self);
  self.importScripts = (...urls) => nativeImportScripts(...urls.map(u => '/__zp/api/worker-script?tab=' + encodeURIComponent(tabId) + '&u=' + encodeURIComponent(ZP.canonicalTargetURL(u, base.href).href)));
})();
