(() => {
  'use strict';
  const root = window;
  const marker = Symbol.for('zeroproxy.runtime.installed');
  if (root[marker]) return;
  Object.defineProperty(root, marker, { value: true, enumerable: false, configurable: false });

  const boot = Object.assign({ tabId: '', entryId: '', targetUrl: location.href, documentCookie: '' }, root.__ZP_BOOT || {});
  try { delete root.__ZP_BOOT; } catch { try { Object.defineProperty(root, '__ZP_BOOT', { value: undefined, enumerable: false }); } catch {} }
  const Native = captureNative(root);
  const proxyOrigin = new URL(root.location.href).origin;
  const routeKey = new URL(root.location.href).pathname.startsWith('/p/') ? new URL(root.location.href).pathname.slice(3) : '';
  let virtualURL = new URL(boot.targetUrl);
  let baseURL = virtualURL.href;
  let explicitBaseURL = '';
  let documentCookie = String(boot.documentCookie || '');
  const documentCookieRecords = [];
  initDocumentCookieRecords(documentCookie);
  const urlMeta = new WeakMap();
  const iframeMeta = new WeakSet();
  const listenersKey = Symbol('zp.listeners');
  const workerBlobURLs = new Set();

  function captureNative(w) {
    const d = w.document;
    return {
      fetch: w.fetch && w.fetch.bind(w),
      XMLHttpRequest: w.XMLHttpRequest,
      WebSocket: w.WebSocket,
      EventSource: w.EventSource,
      Worker: w.Worker,
      SharedWorker: w.SharedWorker,
      FormData: w.FormData,
      URL: w.URL,
      Blob: w.Blob,
      DOMException: w.DOMException,
      Request: w.Request,
      Response: w.Response,
      Headers: w.Headers,
      navigatorSendBeacon: w.navigator && w.navigator.sendBeacon && w.navigator.sendBeacon.bind(w.navigator),
      createElement: d.createElement.bind(d),
      appendChild: w.Node.prototype.appendChild,
      insertBefore: w.Node.prototype.insertBefore,
      replaceChild: w.Node.prototype.replaceChild,
      setAttribute: w.Element.prototype.setAttribute,
      getAttribute: w.Element.prototype.getAttribute,
      insertAdjacentHTML: w.Element.prototype.insertAdjacentHTML,
      matches: w.Element.prototype.matches,
      closest: w.Element.prototype.closest,
      formSubmit: w.HTMLFormElement && w.HTMLFormElement.prototype.submit,
      formRequestSubmit: w.HTMLFormElement && w.HTMLFormElement.prototype.requestSubmit,
      historyPush: w.history.pushState.bind(w.history),
      historyReplace: w.history.replaceState.bind(w.history),
      locationAssign: w.Location && w.Location.prototype.assign,
      locationReplace: w.Location && w.Location.prototype.replace,
      locationReload: w.Location && w.Location.prototype.reload,
      createObjectURL: w.URL && w.URL.createObjectURL && w.URL.createObjectURL.bind(w.URL),
      revokeObjectURL: w.URL && w.URL.revokeObjectURL && w.URL.revokeObjectURL.bind(w.URL),
      open: w.open && w.open.bind(w),
    };
  }

  function normalizedError(name = 'NotSupportedError') {
    try { return new Native.DOMException('Blocked by ZeroProxy policy', name); } catch { const e = new Error('Blocked by ZeroProxy policy'); e.name = name; return e; }
  }
  function define(obj, key, value) { try { Object.defineProperty(obj, key, { value, enumerable: false, configurable: false, writable: true }); return true; } catch { return false; } }
  function defineAccessor(obj, key, get, set) { try { Object.defineProperty(obj, key, { get, set, enumerable: false, configurable: false }); return true; } catch { return false; } }
  function installEventMethods(proto) {
    define(proto, 'addEventListener', function(type, fn) { if (!fn) return; const key = String(type); if (!this[listenersKey]) this[listenersKey] = new Map(); const list = this[listenersKey].get(key) || []; list.push(fn); this[listenersKey].set(key, list); });
    define(proto, 'removeEventListener', function(type, fn) { const list = this[listenersKey] && this[listenersKey].get(String(type)); if (!list) return; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); });
    define(proto, 'dispatchEvent', function(event) { const list = this[listenersKey] && this[listenersKey].get(event.type) || []; try { if (!event.target) Object.defineProperty(event, 'target', { value: this, configurable: true }); } catch {} const handler = this['on' + event.type]; if (typeof handler === 'function') handler.call(this, event); for (const fn of list.slice()) fn.call(this, event); return !event.defaultPrevented; });
  }
  function isHTTPURL(raw) { try { const u = new URL(String(raw), baseURL); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } }
  function targetURL(raw, base = baseURL) { return ZP.canonicalTargetURL(String(raw), base).href; }
  function targetWSURL(raw, base = baseURL) { return ZP.canonicalWebSocketURL(String(raw), base.replace(/^http/, 'ws')).href; }
  function shareNavURL(raw, base = baseURL) { return ZP.makeShareURL(targetURL(raw, base), proxyOrigin); }
  function navigateToTarget(raw, replace = false, base = baseURL) { shareNavURL(raw, base).then(u => replace ? Native.locationReplace.call(location, u) : Native.locationAssign.call(location, u)).catch(()=>{}); }
  function postMessageToSW(message, transfer) {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return Promise.reject(normalizedError('NetworkError'));
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = ev => ev.data && ev.data.ok ? resolve(ev.data) : reject(normalizedError('NetworkError'));
      navigator.serviceWorker.controller.postMessage(message, transfer ? [channel.port2, ...transfer] : [channel.port2]);
    });
  }
  function updateVirtualBase(raw) {
    try {
      const next = targetURL(raw, baseURL);
      baseURL = next;
      explicitBaseURL = next;
      postMessageToSW({ type: 'ZP_BASE_UPDATE', tabId: boot.tabId, entryId: boot.entryId, baseUrl: next }).catch(()=>{});
      return next;
    } catch {
      return baseURL;
    }
  }
  define(root, '__ZP_SET_BASE', updateVirtualBase);

  installWebSocket();
  installBeacon();
  installNavigationTraps();
  installPopupHooks(root);
  installGetterMasking(root);
  installStorageFacades(root);
  installDOMHooks(root);
  installWorkerHooks();
  installIframeHooks(root);
  installBlockers(root);


  function installWebSocket() {
    function ZPWebSocket(url, protocols) {
      this.url = targetWSURL(url); this.protocol = ''; this.extensions = ''; this.readyState = 0; this.bufferedAmount = 0; this.binaryType = 'blob';
      const plist = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
      postMessageToSW({ type: 'ZP_WS_OPEN', url: this.url, protocols: plist, tabId: boot.tabId }).then(reply => {
        this._port = reply.port;
        this._port.onmessage = ev => {
          const m = ev.data || {};
          if (m.type === 'message') this.dispatchEvent(new MessageEvent('message', { data: m.data }));
          else if (m.type === 'error') this.dispatchEvent(new Event('error'));
          else if (m.type === 'close') { this.readyState = 3; this.dispatchEvent(new CloseEvent('close')); }
        };
        this._port.start && this._port.start();
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      }).catch(() => { this.readyState = 3; this.dispatchEvent(new Event('error')); this.dispatchEvent(new CloseEvent('close')); });
    }
    ZPWebSocket.CONNECTING = 0; ZPWebSocket.OPEN = 1; ZPWebSocket.CLOSING = 2; ZPWebSocket.CLOSED = 3;
    ZPWebSocket.prototype = {};
    installEventMethods(ZPWebSocket.prototype);
    Object.assign(ZPWebSocket.prototype, { constructor: ZPWebSocket, send(data) { if (this.readyState !== 1 || !this._port) throw normalizedError('InvalidStateError'); this._port.postMessage({ type: 'send', data }); }, close(code, reason) { this.readyState = 2; if (this._port) this._port.postMessage({ type: 'close', code, reason }); this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { code: code || 1000, reason: reason || '' })); } });
    define(root, 'WebSocket', ZPWebSocket);
  }

  function installBeacon() { if (!navigator.sendBeacon || !Native.navigatorSendBeacon) return; define(navigator, 'sendBeacon', (url, data) => Native.navigatorSendBeacon(targetURL(url), data)); }

  function installNavigationTraps() {
    document.addEventListener('click', ev => { const a = ev.target && ev.target.closest && ev.target.closest('a[href],area[href]'); if (!a || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || a.target && a.target !== '_self' || a.hasAttribute('download')) return; const href = a.getAttribute('data-zp-target-url') || a.getAttribute('href'); if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return; ev.preventDefault(); navigateToTarget(href); }, true);
    document.addEventListener('submit', ev => { const f = ev.target; if (!f) return; ev.preventDefault(); submitForm(f, ev.submitter); }, true);
    if (Native.formSubmit) define(HTMLFormElement.prototype, 'submit', function() { submitForm(this); });
    if (Native.formRequestSubmit) define(HTMLFormElement.prototype, 'requestSubmit', function(submitter) { submitForm(this, submitter); });
    if (Native.locationAssign) define(Location.prototype, 'assign', function(u) { navigateToTarget(u); });
    if (Native.locationReplace) define(Location.prototype, 'replace', function(u) { navigateToTarget(u, true); });
    if (Native.locationReload) define(Location.prototype, 'reload', function() { Native.locationReload.call(location); });
    define(history, 'pushState', function(state, title, url) { if (url != null) { virtualURL = sameOriginHistoryURL(url); if (!explicitBaseURL) baseURL = virtualURL.href; } const entryId = 'e' + ZP.randomId(); postMessageToSW({ type: 'ZP_HISTORY_UPDATE', tabId: boot.tabId, routeKey, entryId, targetUrl: virtualURL.href, baseUrl: baseURL, replace: false }).catch(()=>{}); return Native.historyPush(state, title, location.pathname); });
    define(history, 'replaceState', function(state, title, url) { if (url != null) { virtualURL = sameOriginHistoryURL(url); if (!explicitBaseURL) baseURL = virtualURL.href; } postMessageToSW({ type: 'ZP_HISTORY_UPDATE', tabId: boot.tabId, routeKey, entryId: boot.entryId, targetUrl: virtualURL.href, baseUrl: baseURL, replace: true }).catch(()=>{}); return Native.historyReplace(state, title, location.pathname); });
    window.addEventListener('popstate', () => { postMessageToSW({ type: 'ZP_RESOLVE_ENTRY', path: location.pathname }).then(reply => { virtualURL = new URL(reply.targetUrl); baseURL = reply.baseUrl || virtualURL.href; explicitBaseURL = baseURL !== virtualURL.href ? baseURL : ''; if (typeof reply.scrollX === 'number' && typeof reply.scrollY === 'number') window.scrollTo(reply.scrollX, reply.scrollY); }).catch(()=>{}); }, true);
    let scrollTimer = 0;
    window.addEventListener('scroll', () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(() => postMessageToSW({ type: 'ZP_SCROLL_UPDATE', tabId: boot.tabId, entryId: boot.entryId, scrollX: window.scrollX, scrollY: window.scrollY }).catch(()=>{}), 100); }, { passive: true });
    function submitForm(form, submitter) {
      const raw = submitter && submitter.getAttribute && submitter.getAttribute('formaction') || form.getAttribute('action') || virtualURL.href;
      const method = String(submitter && submitter.getAttribute && submitter.getAttribute('formmethod') || form.getAttribute('method') || 'GET').toUpperCase();
      const target = new URL(targetURL(raw));
      urlMeta.set(form, target.href);
      if (method === 'GET') {
        try {
          const data = submitter ? new Native.FormData(form, submitter) : new Native.FormData(form);
          const qs = new URLSearchParams();
          for (const [k, v] of data) qs.append(k, String(v));
          const encoded = qs.toString();
          if (encoded) target.search = target.search ? target.search + '&' + encoded : encoded;
        } catch {}
        navigateToTarget(target.href);
        return;
      }
      const headers = new Native.Headers();
      headers.set('X-ZP-Document-Request', '1');
      Native.fetch(target.href, { method, body: new Native.FormData(form), credentials: 'include', headers }).then(r => r.text()).then(html => { document.open(); document.write(html); document.close(); }).catch(()=>{});
    }
    function sameOriginHistoryURL(url) { const next = new URL(targetURL(url)); if (next.origin !== virtualURL.origin) throw normalizedError('SecurityError'); return next; }
  }

  function installPopupHooks(w) {
    if (!Native.open) return;
    define(w, 'open', function(url = 'about:blank', target = '_blank', features) {
      const raw = String(url || 'about:blank');
      let child;
      if (raw === 'about:blank' || raw === '') child = Native.open('about:blank', target, features);
      else if (isHTTPURL(raw)) { child = Native.open('about:blank', target, features); if (child) shareNavURL(raw).then(u => { child.location.href = u; }).catch(() => { try { child.close(); } catch {} }); }
      else child = Native.open('about:blank', target, features);
      if (child && (raw === 'about:blank' || raw === '')) {
        try { installNetworkContainment(child); } catch { try { child.close(); } catch {} return null; }
      }
      return child;
    });
  }

  function installGetterMasking(w) {
    const locGet = p => () => new URL(virtualURL.href)[p];
    for (const p of ['href','protocol','host','hostname','port','pathname','search','hash','origin']) defineAccessor(w.Location && w.Location.prototype, p, locGet(p), p === 'href' ? v => { navigateToTarget(v); } : undefined);
    define(w.Location && w.Location.prototype, 'toString', function(){ return virtualURL.href; });
    defineAccessor(w.Document && w.Document.prototype, 'cookie', () => documentCookieString(), v => { const s = String(v); setDocumentCookie(s); postMessageToSW({ type: 'ZP_COOKIE_SET', tabId: boot.tabId, targetUrl: virtualURL.href, cookie: s }).catch(()=>{}); });
    installURLProp(w.HTMLAnchorElement && w.HTMLAnchorElement.prototype, 'href');
    installURLProp(w.HTMLAreaElement && w.HTMLAreaElement.prototype, 'href');
    installURLProp(w.HTMLFormElement && w.HTMLFormElement.prototype, 'action');
    installURLProp(w.HTMLInputElement && w.HTMLInputElement.prototype, 'formAction');
    installURLProp(w.HTMLButtonElement && w.HTMLButtonElement.prototype, 'formAction');
    function installURLProp(proto, prop) { if (!proto) return; defineAccessor(proto, prop, function(){ return urlMeta.get(this) || this.getAttribute('data-zp-target-url') || targetURL(this.getAttribute(prop === 'formAction' ? 'formaction' : prop) || virtualURL.href); }, function(v){ const t = targetURL(v); urlMeta.set(this, t); this.setAttribute('data-zp-target-url', t); this.setAttribute(prop === 'formAction' ? 'formaction' : prop, t); }); }
  }
  function initDocumentCookieRecords(cookieString) {
    for (const part of String(cookieString || '').split(/;\s*/)) {
      const eq = part.indexOf('=');
      if (eq > 0) documentCookieRecords.push({ name: part.slice(0, eq), value: part.slice(eq + 1), domain: virtualURL.hostname.toLowerCase(), hostOnly: true, path: '/', secure: virtualURL.protocol === 'https:', expires: Infinity });
    }
    documentCookie = documentCookieString();
  }
  function setDocumentCookie(line) {
    const parts = String(line).split(';').map(p => p.trim()).filter(Boolean);
    if (!parts.length) return;
    const eq = parts[0].indexOf('=');
    if (eq <= 0) return;
    const rec = { name: parts[0].slice(0, eq), value: parts[0].slice(eq + 1), domain: virtualURL.hostname.toLowerCase(), hostOnly: true, path: defaultCookiePath(), secure: false, expires: Infinity };
    for (let i = 1; i < parts.length; i++) {
      const [rawK, ...rest] = parts[i].split('=');
      const k = rawK.toLowerCase();
      const v = rest.join('=');
      if (k === 'domain' && v) { const d = v.replace(/^\./, '').toLowerCase(); if (virtualURL.hostname.toLowerCase() === d || virtualURL.hostname.toLowerCase().endsWith('.' + d)) { rec.domain = d; rec.hostOnly = false; } }
      else if (k === 'path' && v && v[0] === '/') rec.path = v;
      else if (k === 'secure') rec.secure = true;
      else if (k === 'max-age') rec.expires = Date.now() + Math.max(0, Number(v) || 0) * 1000;
      else if (k === 'expires') { const ts = Date.parse(v); if (!Number.isNaN(ts)) rec.expires = ts; }
    }
    const idx = documentCookieRecords.findIndex(r => r.name === rec.name && r.domain === rec.domain && r.path === rec.path);
    if (rec.expires <= Date.now()) { if (idx >= 0) documentCookieRecords.splice(idx, 1); }
    else if (idx >= 0) documentCookieRecords[idx] = rec;
    else documentCookieRecords.push(rec);
    documentCookie = documentCookieString();
  }
  function documentCookieString() {
    const now = Date.now();
    const host = virtualURL.hostname.toLowerCase();
    const path = virtualURL.pathname || '/';
    return documentCookieRecords.filter(r => r.expires > now && (!r.secure || virtualURL.protocol === 'https:') && (r.hostOnly ? r.domain === host : host === r.domain || host.endsWith('.' + r.domain)) && (path === r.path || (path.startsWith(r.path) && (r.path.endsWith('/') || path[r.path.length] === '/')))).sort((a, b) => b.path.length - a.path.length).map(r => r.name + '=' + r.value).join('; ');
  }
  function defaultCookiePath() { const p = virtualURL.pathname || '/'; const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }

  function installStorageFacades(w) {
    const prefix = 'zp:' + boot.tabId + ':' + virtualURL.origin + ':';
    const local = storageObject();
    const session = storageObject();
    defineAccessor(w, 'localStorage', () => local);
    defineAccessor(w, 'sessionStorage', () => session);
    if (w.indexedDB) {
      const nativeIDB = w.indexedDB;
      define(w, 'indexedDB', {
        open(name, version) { return nativeIDB.open(prefix + String(name), version); },
        deleteDatabase(name) { return nativeIDB.deleteDatabase(prefix + String(name)); },
        cmp: nativeIDB.cmp ? nativeIDB.cmp.bind(nativeIDB) : undefined,
        databases: nativeIDB.databases ? () => nativeIDB.databases().then(list => list.filter(db => db.name && db.name.startsWith(prefix)).map(db => Object.assign({}, db, { name: db.name.slice(prefix.length) }))) : undefined
      });
    }
    if (w.caches) {
      const nativeCaches = w.caches;
      define(w, 'caches', {
        open(name) { return nativeCaches.open(prefix + String(name)); },
        delete(name) { return nativeCaches.delete(prefix + String(name)); },
        has(name) { return nativeCaches.has(prefix + String(name)); },
        keys() { return nativeCaches.keys().then(keys => keys.filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length))); },
        match(request, opts) { return nativeCaches.keys().then(keys => keys.filter(k => k.startsWith(prefix))).then(async keys => { for (const k of keys) { const hit = await (await nativeCaches.open(k)).match(request, opts); if (hit) return hit; } return undefined; }); }
      });
    }
  }
  function storageObject() {
    const map = new Map();
    return Object.freeze({
      get length() { return map.size; },
      key(i) { return Array.from(map.keys())[Number(i)] || null; },
      getItem(k) { k = String(k); return map.has(k) ? map.get(k) : null; },
      setItem(k, v) { map.set(String(k), String(v)); },
      removeItem(k) { map.delete(String(k)); },
      clear() { map.clear(); }
    });
  }

  function installDOMHooks(w) {
    define(w.Element.prototype, 'setAttribute', function(k, v) {
      const key = String(k).toLowerCase();
      if (this.localName === 'base' && key === 'href') {
        updateVirtualBase(v);
        return Native.setAttribute.call(this, k, v);
      }
      if (isURLBearing(this, key) && isHTTPURL(v)) {
        const t = targetURL(v);
        urlMeta.set(this, t);
        Native.setAttribute.call(this, 'data-zp-target-url', t);
        if ((this.localName === 'iframe' || this.localName === 'frame') && key === 'src') {
          Native.setAttribute.call(this, k, 'about:blank');
          shareNavURL(t).then(u => Native.setAttribute.call(this, k, u)).catch(()=>{});
          return;
        }
        return Native.setAttribute.call(this, k, t);
      }
      if ((this.localName === 'iframe' || this.localName === 'frame') && key === 'srcdoc') return Native.setAttribute.call(this, k, injectSrcdoc(String(v)));
      return Native.setAttribute.call(this, k, v);
    });
    define(w.Element.prototype, 'getAttribute', function(k) { const key = String(k).toLowerCase(); if (isURLBearing(this, key)) return urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url') || Native.getAttribute.call(this, k); return Native.getAttribute.call(this, k); });
    patchHTMLSetter(w.Element.prototype, 'innerHTML');
    define(w.Element.prototype, 'insertAdjacentHTML', function(pos, html) { const ret = Native.insertAdjacentHTML.call(this, pos, transformHTML(String(html))); syncBaseElement(this); return ret; });
    installBaseObserver();
    function patchHTMLSetter(proto, prop) { const d = Object.getOwnPropertyDescriptor(proto, prop); if (!d || !d.set) return; try { Object.defineProperty(proto, prop, { get: d.get, set(v) { d.set.call(this, transformHTML(String(v))); syncBaseElement(this); instrumentDescendantIframes(this); }, configurable: false }); } catch {} }
  }
  function isURLBearing(el, key) { const tag = el.localName; return key === 'href' && (tag === 'a' || tag === 'area') || key === 'action' && tag === 'form' || key === 'formaction' && (tag === 'input' || tag === 'button') || key === 'src' && (tag === 'iframe' || tag === 'frame'); }
  function transformHTML(s) { return s.replace(/<base\b[^>]*\shref=(["'])([\s\S]*?)\1[^>]*>/ig, (_, q, href) => baseSyncScript(href)).replace(/(<iframe\b[^>]*\ssrcdoc=["'])([\s\S]*?)(["'])/ig, (_, p, h, q) => p + injectSrcdoc(h).replace(/"/g,'&quot;') + q); }
  function injectSrcdoc(s) { return '<script src="/__zp/zp-core.js"><\/script><script>Object.defineProperty(window,"__ZP_BOOT",{value:' + JSON.stringify(boot).replace(/</g,'\\u003c') + ',configurable:true});<\/script><script src="/__zp/runtime-prelude.js"><\/script>' + s; }
  function baseSyncScript(raw) { return '<script>window.__ZP_SET_BASE&&window.__ZP_SET_BASE(' + JSON.stringify(String(raw)).replace(/</g,'\\u003c') + ');<\/script>'; }
  function syncBaseElement(node) {
    if (!node) return;
    if (node.localName === 'base' && Native.getAttribute.call(node, 'href')) updateVirtualBase(Native.getAttribute.call(node, 'href'));
    if (node.querySelectorAll) node.querySelectorAll('base[href]').forEach(el => updateVirtualBase(Native.getAttribute.call(el, 'href')));
  }
  function installBaseObserver() {
    syncBaseElement(document);
    const MO = root.MutationObserver;
    if (!MO || !document.documentElement) return;
    try {
      new MO(records => {
        for (const r of records) {
          if (r.type === 'attributes') syncBaseElement(r.target);
          else for (const n of r.addedNodes || []) syncBaseElement(n);
        }
      }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    } catch {}
  }

  function installWorkerHooks() {
    if (Native.Worker) define(root, 'Worker', function(url, opts) { return new Native.Worker(workerBootstrapURL(url), opts); });
    if (Native.SharedWorker) define(root, 'SharedWorker', function(url, opts) { return new Native.SharedWorker(workerBootstrapURL(url), opts); });
    if (navigator.serviceWorker && navigator.serviceWorker.register) define(navigator.serviceWorker, 'register', function() { return Promise.reject(normalizedError('NotSupportedError')); });
    if (Native.createObjectURL) define(URL, 'createObjectURL', function(blob) { if (blob && /javascript|ecmascript|text\/plain|application\/octet-stream/i.test(blob.type || '')) { blob = new Blob(["self.__ZP_WORKER_TARGET=", JSON.stringify(virtualURL.href), ";\nself.__ZP_WORKER_TAB_ID=", JSON.stringify(boot.tabId), ";\nimportScripts('/__zp/worker-prelude.js');\n", blob], { type: 'text/javascript' }); const raw = Native.createObjectURL(blob); workerBlobURLs.add(raw); return raw; } return Native.createObjectURL(blob); });
    for (const name of ['audioWorklet','paintWorklet','layoutWorklet','animationWorklet']) { const wk = root.CSS && root.CSS[name] || root[name]; if (wk && wk.addModule) define(wk, 'addModule', function(url, opts){ return wk.addModule(workerBootstrapURL(url), opts); }); }
  }
  function workerBootstrapURL(url) {
    const raw = String(url);
    const parsed = new URL(raw, virtualURL.href);
    if (parsed.protocol === 'blob:') {
      if (!workerBlobURLs.has(parsed.href)) throw normalizedError('NotSupportedError');
      return parsed.href;
    }
    if (parsed.protocol === 'data:') return dataWorkerURL(parsed.href);
    return '/__zp/worker-bootstrap.js#u=' + encodeURIComponent(targetURL(raw)) + '&tab=' + encodeURIComponent(boot.tabId);
  }
  function dataWorkerURL(raw) {
    const comma = raw.indexOf(',');
    if (comma < 0) throw normalizedError('NotSupportedError');
    const meta = raw.slice(5, comma).toLowerCase();
    const body = raw.slice(comma + 1);
    const source = meta.includes(';base64') ? atob(body) : decodeURIComponent(body);
    const blob = new Blob(["self.__ZP_WORKER_TARGET=", JSON.stringify(virtualURL.href), ";\nself.__ZP_WORKER_TAB_ID=", JSON.stringify(boot.tabId), ";\nimportScripts('/__zp/worker-prelude.js');\n", source], { type: 'text/javascript' });
    const safe = Native.createObjectURL(blob);
    workerBlobURLs.add(safe);
    return safe;
  }

  function installIframeHooks(w) {
    define(w.document, 'createElement', function(name, opts) { const el = Native.createElement(String(name), opts); if (/^i?frame$/i.test(String(name))) queueMicrotask(() => instrumentIframe(el)); return el; });
    for (const [proto, name, nativeFn] of [[w.Node.prototype,'appendChild',Native.appendChild],[w.Node.prototype,'insertBefore',Native.insertBefore],[w.Node.prototype,'replaceChild',Native.replaceChild]]) {
      define(proto, name, function(...args) { const ret = nativeFn.apply(this, args); for (const a of args) instrumentDescendantIframes(a); return ret; });
    }
    if (w.HTMLIFrameElement) { installFrameProp(w.HTMLIFrameElement.prototype, 'src'); installFrameProp(w.HTMLIFrameElement.prototype, 'srcdoc'); }
    function installFrameProp(proto, prop) { const d = Object.getOwnPropertyDescriptor(proto, prop); if (!d || !d.set) return; try { Object.defineProperty(proto, prop, { get: d.get, set(v) { if (prop === 'srcdoc') d.set.call(this, injectSrcdoc(String(v))); else if (isHTTPURL(v)) { d.set.call(this, 'about:blank'); shareNavURL(v).then(u => d.set.call(this, u)).catch(()=>{}); } else d.set.call(this, v); instrumentIframe(this); }, configurable: false }); } catch {} }
  }
  function instrumentDescendantIframes(node) { if (!node || !node.querySelectorAll) { if (node && /^(IFRAME|FRAME)$/.test(node.nodeName)) instrumentIframe(node); return; } node.querySelectorAll('iframe,frame').forEach(instrumentIframe); }
  function instrumentIframe(frame) { if (!frame || iframeMeta.has(frame)) return; iframeMeta.add(frame); try { if (!frame.getAttribute('src') && frame.contentWindow) installNetworkContainment(frame.contentWindow); } catch { try { frame.remove(); } catch {} } }
  function installNetworkContainment(w) {
    // Native fetch is intentionally left intact; the Service Worker owns request capture.
    if (root.WebSocket) define(w, 'WebSocket', root.WebSocket);
    if (w.navigator && navigator.sendBeacon) define(w.navigator, 'sendBeacon', navigator.sendBeacon.bind(navigator));
    installBlockers(w);
  }

  function installBlockers(w) {
    const blockCtor = function(){ throw normalizedError('NotSupportedError'); };
    for (const name of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','WebTransport','WebSocketStream']) define(w, name, blockCtor);
    const nav = w.navigator;
    if (nav) {
      for (const name of ['serial','hid','usb','bluetooth','requestMIDIAccess','credentials','geolocation','clipboard','wakeLock']) { try { Object.defineProperty(nav, name, { get(){ throw normalizedError('NotSupportedError'); }, configurable: false }); } catch {} }
      if (nav.mediaDevices) for (const name of ['getUserMedia','getDisplayMedia','enumerateDevices']) define(nav.mediaDevices, name, function(){ return Promise.reject(normalizedError('NotSupportedError')); });
    }
  }
  try { const current = document.currentScript; if (current && /\/__zp\/runtime-prelude\.js(?:$|\?)/.test(current.src || '')) current.remove(); } catch {}
})();
