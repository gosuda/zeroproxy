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
    // Proxy-origin ABSOLUTE. A root-relative path resolves against the
    // worker's virtualized base (the target origin), so the request would be
    // sent to the target host and 404. `self.location` here is the real worker
    // script URL on the proxy origin — captured before any virtualization.
    return self.location.origin + '/zp/api/script?kind=module&u=' + encodeURIComponent(u.href);
  });
  try { self.eval = blockedDynamic; } catch {}
  try { self.Function = blockedDynamic; } catch {}
  // Keep in lockstep with ZP.TARGET_USER_AGENT (web/zp-core.js) and the
  // captured Chrome 148 TLS spec. A Worker reporting a different Chrome version
  // (was 134) than the main realm (148) is a cross-context inconsistency an
  // anti-bot can profile — every realm must claim the SAME Chrome build.
  // zp-core.js 의 TARGET_USER_AGENT 와 반드시 같은 값 (여기는 워커라 ZP 가 없다).
  const TARGET_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
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
  const NativeRequest = self.Request;
  const decodeFetchResponse = ZP.createFetchResponseAdapter(self.Response, self.Headers);
  self.fetch = async (input, init = {}) => {
    const raw = input && typeof input.url === 'string' ? input.url : String(input);
    if (/^(?:blob|data):/i.test(raw.trim())) return nativeFetch(input, init);
    const target = ZP.canonicalTargetURL(raw, base.href).href;
    const req = input instanceof NativeRequest ? new NativeRequest(input, init) : new NativeRequest(target, init);
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : ZP.bytesToBase64Url(new Uint8Array(await req.clone().arrayBuffer()));
    const response = await nativeFetch('/zp/api/fetch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: req.signal,
      body: JSON.stringify({ tabId, documentURL: base.href, url: target, init: {
        method: req.method, headers: Array.from(req.headers.entries()), body,
        credentials: req.credentials, mode: req.mode, referrer: req.referrer,
        referrerPolicy: req.referrerPolicy, redirect: req.redirect,
      } }),
    });
    return decodeFetchResponse(response);
  };
  // ── XHR-over-fetch shim ──────────────────────────────────────────────
  // Workers have no in-realm rewriter, but they DO have the proxied
  // self.fetch above — an async XHR emulation on top of it restores
  // axios/pdf.js/emscripten-style loaders without opening a new egress.
  // Synchronous XHR cannot exist over fetch; async=false fails closed.
  const XHR_EVENTS = ['readystatechange', 'loadstart', 'progress', 'load', 'error', 'timeout', 'abort', 'loadend'];
  class WorkerXHRUpload extends EventTarget {}
  class WorkerXHR extends EventTarget {
    constructor() {
      super();
      this.readyState = 0;
      this.responseType = '';
      this.response = null;
      this.responseText = '';
      this.responseURL = '';
      this.status = 0;
      this.statusText = '';
      this.timeout = 0;
      this.withCredentials = false;
      this.upload = new WorkerXHRUpload();
      this._method = 'GET';
      this._url = '';
      this._headers = [];
      this._responseHeaders = null;
      this._controller = null;
      this._aborted = false;
      this._timer = null;
      this._mime = null;
    }
    open(method, url, async = true, user = undefined, password = undefined) {
      if (async === false) {
        // Sync XHR is legal in workers natively, but our transport is
        // fetch — there is no synchronous byte path to emulate it on.
        try { throw new DOMException('Synchronous XMLHttpRequest is not supported in this worker', 'InvalidStateError'); } catch (e) { throw e; }
      }
      this._method = String(method || 'GET').toUpperCase();
      this._url = String(url);
      this._headers = [];
      this._responseHeaders = null;
      this._aborted = false;
      this._controller = null;
      this.status = 0; this.statusText = ''; this.response = null; this.responseText = ''; this.responseURL = '';
      this._changeState(1);
    }
    setRequestHeader(name, value) {
      if (this.readyState !== 1) { try { throw new DOMException('InvalidStateError', 'InvalidStateError'); } catch (e) { throw e; } }
      const n = String(name).toLowerCase();
      for (const h of this._headers) if (h[0].toLowerCase() === n) { h[1] += ', ' + String(value); return; }
      this._headers.push([String(name), String(value)]);
    }
    overrideMimeType(mime) { this._mime = String(mime); }
    getResponseHeader(name) {
      if (!this._responseHeaders) return null;
      return this._responseHeaders.get(String(name));
    }
    getAllResponseHeaders() {
      if (!this._responseHeaders) return '';
      let out = '';
      for (const [k, v] of this._responseHeaders.entries()) out += k + ': ' + v + '\r\n';
      return out;
    }
    abort() {
      this._aborted = true;
      try { this._controller && this._controller.abort(); } catch {}
      this.readyState = 0;
      this._fire('abort');
      this._fire('loadend');
    }
    _changeState(s) { this.readyState = s; this._fire('readystatechange'); }
    _fire(type) {
      try { this.dispatchEvent(new Event(type)); } catch {}
      const h = this['on' + type];
      if (typeof h === 'function') { try { h.call(this, new Event(type)); } catch {} }
    }
    send(body = null) {
      if (this.readyState !== 1) { try { throw new DOMException('InvalidStateError', 'InvalidStateError'); } catch (e) { throw e; } }
      this._controller = new AbortController();
      const init = { method: this._method, headers: this._headers, signal: this._controller.signal, credentials: this.withCredentials ? 'include' : 'same-origin' };
      if (body != null && this._method !== 'GET' && this._method !== 'HEAD') init.body = body;
      this._fire('loadstart');
      if (this.timeout > 0) {
        this._timer = setTimeout(() => {
          try { this._controller.abort(); } catch {}
          this._aborted = true;
          this._fire('timeout');
          this._fire('loadend');
        }, this.timeout);
      }
      self.fetch(this._url, init).then(async resp => {
        if (this._aborted) return;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        this.status = resp.status;
        this.statusText = resp.statusText;
        this.responseURL = resp.url || '';
        this._responseHeaders = resp.headers;
        this._changeState(2);
        this._changeState(3);
        let out;
        const t = this.responseType;
        if (t === 'arraybuffer') out = await resp.arrayBuffer();
        else if (t === 'blob') out = await resp.blob();
        else if (t === 'json') { const text = await resp.text(); try { out = JSON.parse(text); } catch { out = null; } }
        else { const text = await resp.text(); out = text; this.responseText = text; }
        this.response = out;
        this._changeState(4);
        this._fire('load');
        this._fire('loadend');
      }).catch(() => {
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        if (this._aborted) return; // abort/timeout already fired
        this._fire('error');
        this._fire('loadend');
      });
    }
  }
  for (const [n, v] of [['UNSENT', 0], ['OPENED', 1], ['HEADERS_RECEIVED', 2], ['LOADING', 3], ['DONE', 4]]) {
    WorkerXHR[n] = v; WorkerXHR.prototype[n] = v;
  }
  for (const e of XHR_EVENTS) WorkerXHR.prototype['on' + e] = null;
  self.XMLHttpRequest = WorkerXHR;
  // ── Storage namespacing ──────────────────────────────────────────────
  // Real indexedDB/caches live on the PROXY origin — two targets would
  // read each other's databases. Namespace every key by the virtual
  // target origin so each target sees only its own store.
  const ns = 'ZP|' + base.origin + '|';
  const nsOf = name => ns + String(name);
  const unNs = name => name.startsWith(ns) ? name.slice(ns.length) : name;
  if (self.indexedDB) {
    const nativeIDB = self.indexedDB;
    const idb = Object.create(nativeIDB);
    idb.open = (name, version) => version === undefined ? nativeIDB.open(nsOf(name)) : nativeIDB.open(nsOf(name), version);
    idb.deleteDatabase = name => nativeIDB.deleteDatabase(nsOf(name));
    if (nativeIDB.databases) {
      idb.databases = () => nativeIDB.databases().then(list =>
        list.filter(d => typeof d.name === 'string' && d.name.startsWith(ns))
            .map(d => ({ name: unNs(d.name), version: d.version })));
    }
    // `indexedDB` 는 worker 전역의 getter-only 접근자 — 모듈(strict) 워커에서
    // `self.indexedDB = …` 대입은 TypeError 로 부팅이 죽는다. 접근자를
    // 프로퍼티로 갈아 끼운다 (네이티브는 configurable 이라 허용).
    Object.defineProperty(self, 'indexedDB', { value: idb, writable: true, enumerable: true, configurable: true });
  }
  if (self.caches) {
    const nativeCaches = self.caches;
    const cs = Object.create(nativeCaches);
    cs.open = name => nativeCaches.open(nsOf(name));
    cs.has = name => nativeCaches.has(nsOf(name));
    cs.delete = name => nativeCaches.delete(nsOf(name));
    cs.keys = () => nativeCaches.keys().then(list => list.filter(k => k.startsWith(ns)).map(unNs));
    // match() opens every cache looking for the request — restrict to
    // our namespace by iterating keys() instead of the global index.
    cs.match = (request, options) => cs.keys().then(async keys => {
      for (const k of keys) {
        const c = await nativeCaches.open(nsOf(k));
        const hit = await c.match(request, options);
        if (hit) return hit;
      }
      return undefined;
    });
    Object.defineProperty(self, 'caches', { value: cs, writable: true, enumerable: true, configurable: true });
  }
  // cookieStore: in workers the real store reads PROXY-origin cookies —
  // a cross-target bleed. Give each worker an in-memory jar with the
  // CookieStore surface; there is no page-realm channel to sync against.
  {
    const jar = new Map();
    const parseExpires = o => o && o.expires ? Number(o.expires) : null;
    const sweep = () => { const now = Date.now(); for (const [k, v] of jar) if (v.expires && v.expires <= now) jar.delete(k); };
    const fire = changes => { try { cookieStore.dispatchEvent(Object.assign(new Event('change'), { changed: changes, deleted: [] })); } catch {} };
    const cookieStore = new EventTarget();
    cookieStore.get = async (name, options) => {
      sweep();
      const n = typeof name === 'object' && name ? name.name : name;
      if (n == null) { const first = jar.values().next().value; return first || null; }
      return jar.get(String(n)) || null;
    };
    cookieStore.getAll = async (name, options) => { sweep(); const n = typeof name === 'object' && name ? name.name : name; if (n == null) return [...jar.values()]; const c = jar.get(String(n)); return c ? [c] : []; };
    cookieStore.set = async (name, value, options) => {
      const opts = typeof name === 'object' && name ? name : (options || {});
      const n = String(opts.name !== undefined ? opts.name : name);
      const v = String(opts.value !== undefined ? opts.value : value);
      const rec = { name: n, value: v, domain: null, path: opts.path || '/', expires: parseExpires(opts), sameSite: opts.sameSite || 'strict', partitioned: !!opts.partitioned };
      jar.set(n, rec);
      fire([Object.assign({}, rec)]);
    };
    cookieStore.delete = async (name, options) => { const n = String(typeof name === 'object' && name ? name.name : name); jar.delete(n); };
    cookieStore.onchange = null;
    Object.defineProperty(self, 'cookieStore', { value: cookieStore, writable: true, enumerable: true, configurable: true });
  }
  // ── String timers fail closed ────────────────────────────────────────
  // setTimeout('code') compiles in the REAL worker global, which bypasses
  // every __zp_* mediation — and this realm has no synchronous rewriter.
  // Function timers keep working; string timers get the same closed-door
  // answer as eval/Function.
  const nativeSetTimeout = self.setTimeout.bind(self);
  const nativeSetInterval = self.setInterval.bind(self);
  self.setTimeout = (handler, timeout, ...args) => {
    if (typeof handler === 'string') blockedDynamic();
    return nativeSetTimeout(handler, timeout, ...args);
  };
  self.setInterval = (handler, timeout, ...args) => {
    if (typeof handler === 'string') blockedDynamic();
    return nativeSetInterval(handler, timeout, ...args);
  };
  // ── EventSource over proxied fetch ───────────────────────────────────
  // SSE is a streaming GET — our fetch pipes the transport body through,
  // so events arrive as the stream delivers them. WebSocket stays
  // blocked: the yamux kernel lives in the service worker and a dedicated
  // worker has no SW message channel, so there is no transport to hook.
  class WorkerEventSource extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 0;
      this.withCredentials = false;
      this.onopen = null; this.onmessage = null; this.onerror = null;
      this._controller = new AbortController();
      this._run();
    }
    close() { this.readyState = 2; try { this._controller.abort(); } catch {} }
    _fire(type, event) { try { this.dispatchEvent(event); } catch {} const h = this['on' + type]; if (typeof h === 'function') { try { h.call(this, event); } catch {} } }
    async _run() {
      try {
        const resp = await self.fetch(this.url, { headers: [['Accept', 'text/event-stream']] });
        if (!resp.ok || !resp.body) throw new Error('bad sse');
        this.readyState = 1;
        this._fire('open', new Event('open'));
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '', data = '', eventName = '', lastId = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done || this.readyState === 2) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, ''); buf = buf.slice(idx + 1);
            if (line === '') {
              if (data !== '') {
                const type = eventName || 'message';
                const ev = new MessageEvent(type, { data: data.replace(/\n$/, ''), lastEventId: lastId });
                try { this.dispatchEvent(ev); } catch {}
                if (type === 'message' && typeof this.onmessage === 'function') { try { this.onmessage.call(this, ev); } catch {} }
              }
              data = ''; eventName = '';
            } else if (line.startsWith(':')) { /* comment/heartbeat */ }
            else {
              const c = line.indexOf(':');
              const field = c < 0 ? line : line.slice(0, c);
              const v = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
              if (field === 'data') data += v + '\n';
              else if (field === 'event') eventName = v;
              else if (field === 'id') lastId = v;
            }
          }
        }
        if (this.readyState !== 2) { this.readyState = 0; this._fire('error', new Event('error')); }
      } catch {
        if (this.readyState !== 2) { this.readyState = 0; this._fire('error', new Event('error')); }
      }
    }
  }
  WorkerEventSource.CONNECTING = 0; WorkerEventSource.OPEN = 1; WorkerEventSource.CLOSED = 2;
  WorkerEventSource.prototype.CONNECTING = 0; WorkerEventSource.prototype.OPEN = 1; WorkerEventSource.prototype.CLOSED = 2;
  self.EventSource = WorkerEventSource;
  self.WebSocket = function(){ blocked(); };
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
