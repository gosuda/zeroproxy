(() => {
  'use strict';
  const root = window;
  const marker = Symbol.for('zeroproxy.runtime.installed');
  if (root[marker]) return;
  Object.defineProperty(root, marker, { value: true, enumerable: false, configurable: false });

  const boot = Object.assign({ tabId: '', entryId: '', targetUrl: location.href, documentCookie: '' }, readBootConfig());
  const runtimeToken = String(boot.runtimeToken || '');
  const TARGET_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
  const TARGET_APP_VERSION = TARGET_USER_AGENT.replace(/^Mozilla\//, '');
  const TARGET_PLATFORM = 'Win32';
  clearBootConfig();
  const Native = captureNative(root);
  const toStringMap = new WeakMap();
  const toStringMaskedPrototypes = new WeakSet();
  const origToString = root.Function && root.Function.prototype && root.Function.prototype.toString;
  const proxyOrigin = new URL(root.location.href).origin;
  const routeKey = new URL(root.location.href).pathname.startsWith('/p/') ? new URL(root.location.href).pathname.slice(3) : '';
  let virtualURL = new URL(boot.targetUrl);
  let baseURL = virtualURL.href;
  let explicitBaseURL = '';
  let documentCookie = String(boot.documentCookie || '');
  const documentCookieRecords = [];
  initDocumentCookieRecords(documentCookie);
  const urlMeta = new WeakMap();
  const networkContainmentMarker = Symbol.for('zeroproxy.network.contained');
  const iframeHooksMarker = Symbol.for('zeroproxy.iframe.hooks');
  const listenersKey = Symbol('zp.listeners');
  const workerBlobURLs = new Set();
  const canvasHookedWindows = new WeakSet();
  const audioHookedWindows = new WeakSet();


  function readBootConfig() {
    const d = root.document;
    const el = d && d.getElementById && d.getElementById('__zp-boot');
    if (el) {
      try {
        const parsed = JSON.parse(el.textContent || '{}');
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {}
    }
    return root.__ZP_BOOT || {};
  }

  function clearBootConfig() {
    const d = root.document;
    const el = d && d.getElementById && d.getElementById('__zp-boot');
    if (el) {
      try { el.remove(); } catch {}
    }
    try { delete root.__ZP_BOOT; } catch { try { Object.defineProperty(root, '__ZP_BOOT', { value: undefined, enumerable: false }); } catch {} }
  }
  function captureNative(w) {
    const d = w.document;
    return {
      fetch: w.fetch && w.fetch.bind(w),
      XMLHttpRequest: w.XMLHttpRequest,
      WebSocket: w.WebSocket,
      EventSource: w.EventSource,
      Worker: w.Worker,
      FunctionCtor: w.Function,
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
      setAttributeNS: w.Element.prototype.setAttributeNS,
      namedSetNamedItem: w.NamedNodeMap && w.NamedNodeMap.prototype.setNamedItem,
      attrValue: w.Attr && Object.getOwnPropertyDescriptor(w.Attr.prototype, 'value'),
      matches: w.Element.prototype.matches,
      closest: w.Element.prototype.closest,
      formSubmit: w.HTMLFormElement && w.HTMLFormElement.prototype.submit,
      formRequestSubmit: w.HTMLFormElement && w.HTMLFormElement.prototype.requestSubmit,
      documentOpen: d.open && d.open.bind(d),
      documentWrite: d.write && d.write.bind(d),
      documentWriteln: d.writeln && d.writeln.bind(d),
      documentClose: d.close && d.close.bind(d),
      historyPush: w.history.pushState.bind(w.history),
      historyReplace: w.history.replaceState.bind(w.history),
      locationAssign: w.location && w.location.assign && w.location.assign.bind(w.location),
      locationReplace: w.location && w.location.replace && w.location.replace.bind(w.location),
      locationReload: w.location && w.location.reload && w.location.reload.bind(w.location),
      createObjectURL: w.URL && w.URL.createObjectURL && w.URL.createObjectURL.bind(w.URL),
      revokeObjectURL: w.URL && w.URL.revokeObjectURL && w.URL.revokeObjectURL.bind(w.URL),
      open: w.open && w.open.bind(w),
      setTimeout: w.setTimeout && w.setTimeout.bind(w),
      setInterval: w.setInterval && w.setInterval.bind(w),
      clearTimeout: w.clearTimeout && w.clearTimeout.bind(w),
      clearInterval: w.clearInterval && w.clearInterval.bind(w),
      DOMParserParseFromString: w.DOMParser && w.DOMParser.prototype && w.DOMParser.prototype.parseFromString,
      rangeCreateContextualFragment: w.Range && w.Range.prototype && w.Range.prototype.createContextualFragment,
    };
  }

  function normalizedError(name = 'NotSupportedError') {
    try { return new Native.DOMException('Blocked by ZeroProxy policy', name); } catch { const e = new Error('Blocked by ZeroProxy policy'); e.name = name; return e; }
  }
  function nativeFunctionSource(key) {
    const name = typeof key === 'symbol' ? '' : String(key);
    return 'function ' + name + '() { [native code] }';
  }
  function nativeAccessorSource(kind, key) {
    const name = typeof key === 'symbol' ? '' : String(key);
    return 'function ' + kind + ' ' + name + '() { [native code] }';
  }
  function define(obj, key, value) {
    try {
      Object.defineProperty(obj, key, { value, enumerable: false, configurable: false, writable: true });
      if (typeof value === 'function') toStringMap.set(value, nativeFunctionSource(key));
      return true;
    } catch { return false; }
  }
  function defineAccessor(obj, key, get, set) {
    try {
      Object.defineProperty(obj, key, { get, set, enumerable: false, configurable: false });
      if (typeof get === 'function') toStringMap.set(get, nativeAccessorSource('get', key));
      if (typeof set === 'function') toStringMap.set(set, nativeAccessorSource('set', key));
      return true;
    } catch { return false; }
  }
  function installToStringMasking(w) {
    const proto = w && w.Function && w.Function.prototype;
    if (!proto || toStringMaskedPrototypes.has(proto)) return;
    const orig = w === root ? origToString : proto.toString;
    if (typeof orig !== 'function') return;
    const maskedToString = function toString() {
      if (typeof this === 'function' && toStringMap.has(this)) return toStringMap.get(this);
      return orig.call(this);
    };
    toStringMap.set(maskedToString, 'function toString() { [native code] }');
    try {
      Object.defineProperty(proto, 'toString', { value: maskedToString, enumerable: false, configurable: false, writable: true });
      toStringMaskedPrototypes.add(proto);
    } catch {}
  }
  function installEventMethods(proto) {
    define(proto, 'addEventListener', function(type, fn) { if (!fn) return; const key = String(type); if (!this[listenersKey]) this[listenersKey] = new Map(); const list = this[listenersKey].get(key) || []; list.push(fn); this[listenersKey].set(key, list); });
    define(proto, 'removeEventListener', function(type, fn) { const list = this[listenersKey] && this[listenersKey].get(String(type)); if (!list) return; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); });
    define(proto, 'dispatchEvent', function(event) { const list = this[listenersKey] && this[listenersKey].get(event.type) || []; try { if (!event.target) Object.defineProperty(event, 'target', { value: this, configurable: true }); } catch {} const handler = this['on' + event.type]; if (typeof handler === 'function') handler.call(this, event); for (const fn of list.slice()) fn.call(this, event); return !event.defaultPrevented; });
  }
  function isHTTPURL(raw) { try { const u = new URL(String(raw), baseURL); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } }
  function hasExecutableURLScheme(raw) { return /^(?:javascript|data|vbscript):/i.test(String(raw).trim()); }
  function blockedURLValue(el, key) { const tag = el && el.localName; return key === 'src' && (tag === 'iframe' || tag === 'frame') ? 'about:blank' : '#'; }
  function blockExecutableURL(el, key, raw) { urlMeta.delete(el); Native.setAttribute.call(el, 'data-zp-target-url', ''); Native.setAttribute.call(el, 'data-zp-blocked-url', String(raw).trim()); Native.setAttribute.call(el, key, blockedURLValue(el, key)); if (key === 'src' && (el.localName === 'iframe' || el.localName === 'frame')) instrumentIframe(el); }
  function targetURL(raw, base = baseURL) { return ZP.canonicalTargetURL(String(raw), base).href; }
  function targetWSURL(raw, base = baseURL) { return ZP.canonicalWebSocketURL(String(raw), base.replace(/^http/, 'ws')).href; }
  function shareNavURL(raw, base = baseURL) { return ZP.makeShareURL(targetURL(raw, base), proxyOrigin); }
  async function activatedNavPath(raw, replace = false, base = baseURL) {
    const target = targetURL(raw, base);
    const share = await ZP.encryptShareURL(target);
    const path = '/p/' + share.encrypted;
    const entryId = replace ? boot.entryId : 'e' + ZP.randomId();
    await postMessageToSW({ type: 'ZP_HISTORY_UPDATE', tabId: boot.tabId, routeKey: share.encrypted, entryId, targetUrl: target, baseUrl: target, replace });
    return path;
  }
  function navigateToTarget(raw, replace = false, base = baseURL) {
    activatedNavPath(raw, replace, base).then(path => {
      if (replace && Native.locationReplace) Native.locationReplace(path);
      else if (!replace && Native.locationAssign) Native.locationAssign(path);
      else if (replace) location.replace(path);
      else location.href = path;
    }).catch(() => shareNavURL(raw, base).then(u => {
      if (replace && Native.locationReplace) Native.locationReplace(u);
      else if (!replace && Native.locationAssign) Native.locationAssign(u);
      else if (replace) location.replace(u);
      else location.href = u;
    }).catch(()=>{}));
  }
  function postMessageToSW(message, transfer) {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller || !runtimeToken) return Promise.reject(normalizedError('NetworkError'));
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const sealed = Object.assign({}, message, { runtimeToken });
      channel.port1.onmessage = ev => ev.data && ev.data.ok ? resolve(ev.data) : reject(normalizedError('NetworkError'));
      navigator.serviceWorker.controller.postMessage(sealed, transfer ? [channel.port2, ...transfer] : [channel.port2]);
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
  installToStringMasking(root);
  define(root, '__ZP_SET_BASE', updateVirtualBase);
  installPhase2Membrane();

  installWebSocket();
  installBeacon();
  installNavigationTraps();
  installPopupHooks(root);
  installNavigatorIdentity(root);
  installGetterMasking(root);
  installStorageFacades(root);
  installDOMHooks(root);
  installWorkerHooks();
  installIframeHooks(root);
  installBlockers(root);
  installCanvasAntiFingerprinting(root);
  installAudioAntiFingerprinting(root);


  function installPhase2Membrane() {
    const blockedDynamic = function(){ throw normalizedError('NotSupportedError'); };
    const virtualLocation = Object.freeze({
      get href() { return virtualURL.href; },
      set href(v) { navigateToTarget(v); },
      get protocol() { return virtualURL.protocol; },
      get host() { return virtualURL.host; },
      get hostname() { return virtualURL.hostname; },
      get port() { return virtualURL.port; },
      get pathname() { return virtualURL.pathname; },
      get search() { return virtualURL.search; },
      get hash() { return virtualURL.hash; },
      get origin() { return virtualURL.origin; },
      assign(v) { navigateToTarget(v); },
      replace(v) { navigateToTarget(v, true); },
      reload() { Native.locationReload && Native.locationReload(); },
      toString() { return virtualURL.href; },
      valueOf() { return virtualURL.href; },
      [Symbol.toPrimitive]() { return virtualURL.href; }
    });
    const scope = new Proxy(root, {
      has(_target, prop) { return prop !== Symbol.unscopables; },
      get(target, prop) {
        if (prop === Symbol.unscopables) return undefined;
        if (prop === 'window' || prop === 'self' || prop === 'globalThis' || prop === 'top' || prop === 'parent' || prop === 'frames') return scope;
        if (prop === 'location') return virtualLocation;
        if (prop === 'eval' || prop === 'Function' || prop === 'AsyncFunction' || prop === 'GeneratorFunction' || prop === 'AsyncGeneratorFunction') return blockedDynamic;
        return target[prop];
      },
      set(target, prop, value) {
        if (prop === 'location') { navigateToTarget(value); return true; }
        target[prop] = value;
        return true;
      },
      getOwnPropertyDescriptor(target, prop) {
        if (prop === 'location') return { value: virtualLocation, configurable: true, enumerable: true, writable: false };
        return Reflect.getOwnPropertyDescriptor(target, prop);
      }
    });
    function isWindowLike(value) {
      try { return value === root || value === scope || value && value.window === value; } catch { return false; }
    }
    function get(base, prop) {
      if (typeof prop !== 'symbol') prop = String(prop);
      if (isWindowLike(base)) {
        if (prop === 'window' || prop === 'self' || prop === 'globalThis' || prop === 'top' || prop === 'parent' || prop === 'frames') return scope;
        if (prop === 'location') return virtualLocation;
        if (prop === 'eval' || prop === 'Function' || prop === 'AsyncFunction' || prop === 'GeneratorFunction' || prop === 'AsyncGeneratorFunction') return blockedDynamic;
      }
      if (base === document && prop === 'defaultView') return scope;
      if (prop === 'constructor') {
        const ctor = Reflect.get(Object(base), prop);
        return ctor === Native.FunctionCtor || typeof ctor === 'function' ? blockedDynamic : ctor;
      }
      return Reflect.get(Object(base), prop);
    }
    function set(base, prop, value) {
      if (typeof prop !== 'symbol') prop = String(prop);
      if ((isWindowLike(base) && prop === 'location') || (base === virtualLocation && prop === 'href')) { navigateToTarget(value); return true; }
      Reflect.set(Object(base), prop, value);
      return true;
    }
    function call(base, prop, args) {
      const fn = get(base, prop);
      if (fn === blockedDynamic) return blockedDynamic();
      return Reflect.apply(fn, base === scope ? root : base, Array.isArray(args) ? args : []);
    }
    function construct(ctor, args) {
      if (ctor === Native.FunctionCtor || ctor === blockedDynamic) return blockedDynamic();
      return Reflect.construct(ctor, Array.isArray(args) ? args : []);
    }
    function has(base, prop) { if (isWindowLike(base) && prop === 'location') return true; return Reflect.has(Object(base), prop); }
    function getOwnPropertyDescriptor(base, prop) { if (isWindowLike(base) && prop === 'location') return { value: virtualLocation, configurable: true, enumerable: true, writable: false }; return Reflect.getOwnPropertyDescriptor(Object(base), prop); }
    function ownKeys(base) { return Reflect.ownKeys(Object(base)); }
    define(root, '__zp_get', get);
    define(root, '__zp_set', set);
    define(root, '__zp_call', call);
    define(root, '__zp_construct', construct);
    define(root, '__zp_has', has);
    define(root, '__zp_getOwnPropertyDescriptor', getOwnPropertyDescriptor);
    define(root, '__zp_ownKeys', ownKeys);
    define(root, '__zp_nav_assign', v => navigateToTarget(v));
    define(root, '__zp_nav_replace', v => navigateToTarget(v, true));
    define(root, '__zp_runClassic', fn => fn.call(root, scope));
    define(root, '__zp_runEvent', (selfValue, event, fn) => fn.call(selfValue, new Proxy(scope, { get(t, p, r) { if (p === 'event') return event; return Reflect.get(t, p, r); } })));
    for (const ctor of [Native.FunctionCtor, (async function(){}).constructor, (function*(){}).constructor, (async function*(){}).constructor]) {
      try { Object.defineProperty(ctor.prototype, 'constructor', { value: blockedDynamic, enumerable: false, configurable: false, writable: false }); } catch {}
    }
    if (Native.setTimeout) define(root, 'setTimeout', function(handler, delay, ...args) { if (typeof handler === 'string') throw normalizedError('NotSupportedError'); return Native.setTimeout(handler, delay, ...args); });
    if (Native.setInterval) define(root, 'setInterval', function(handler, delay, ...args) { if (typeof handler === 'string') throw normalizedError('NotSupportedError'); return Native.setInterval(handler, delay, ...args); });
    if (Native.documentWrite) define(document, 'write', function(...parts) { return Native.documentWrite(parts.map(p => transformHTML(String(p))).join('')); });
    if (Native.documentWriteln) define(document, 'writeln', function(...parts) { return Native.documentWriteln(parts.map(p => transformHTML(String(p))).join('') + '\n'); });
    if (Native.DOMParserParseFromString && root.DOMParser) define(root.DOMParser.prototype, 'parseFromString', function(markup, type) { return Native.DOMParserParseFromString.call(this, String(type).toLowerCase() === 'text/html' ? transformHTML(String(markup)) : markup, type); });
    if (Native.rangeCreateContextualFragment && root.Range) define(root.Range.prototype, 'createContextualFragment', function(markup) { return Native.rangeCreateContextualFragment.call(this, transformHTML(String(markup))); });
  }
  function installWebSocket() {
    function ZPWebSocket(url, protocols) {
      this.url = targetWSURL(url); this.protocol = ''; this.extensions = ''; this.readyState = 0; this.bufferedAmount = 0; this.binaryType = 'blob';
      const plist = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
      postMessageToSW({ type: 'ZP_WS_OPEN', url: this.url, protocols: plist, tabId: boot.tabId }).then(reply => {
        this.protocol = String(reply.protocol || '');
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
    document.addEventListener('click', ev => { const nav = clickNavigationTarget(ev); if (!nav) return; ev.preventDefault(); ev.stopImmediatePropagation(); if (nav.href) navigateToTarget(nav.href); }, true);
    document.addEventListener('submit', ev => { const f = ev.target; if (!f) return; ev.preventDefault(); submitForm(f, ev.submitter); }, true);
    if (Native.formSubmit) define(HTMLFormElement.prototype, 'submit', function() { submitForm(this); });
    if (Native.formRequestSubmit) define(HTMLFormElement.prototype, 'requestSubmit', function(submitter) { submitForm(this, submitter); });
    if (Native.locationAssign) define(Location.prototype, 'assign', function(u) { navigateToTarget(u); });
    if (Native.locationReplace) define(Location.prototype, 'replace', function(u) { navigateToTarget(u, true); });
    if (Native.locationReload) define(Location.prototype, 'reload', function() { Native.locationReload(); });
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
      Native.fetch(target.href, { method, body: new Native.FormData(form), credentials: 'include', headers }).then(r => r.text()).then(html => { if (Native.documentOpen) Native.documentOpen(); if (Native.documentWrite) Native.documentWrite(transformHTML(html)); if (Native.documentClose) Native.documentClose(); }).catch(()=>{});
    }
    function sameOriginHistoryURL(url) { const next = new URL(targetURL(url)); if (next.origin !== virtualURL.origin) throw normalizedError('SecurityError'); return next; }
    function clickNavigationTarget(ev) {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return null;
      for (let el = ev.target; el && el !== document; el = el.parentElement) {
        const isAnchor = el.matches && el.matches('a[href],area[href]');
        if (isAnchor) {
          if (el.hasAttribute('download')) return null;
          const target = el.getAttribute('target');
          if (target && target !== '_self') return null;
        }
        const raw = isAnchor ? el.getAttribute('data-zp-target-url') || el.getAttribute('href') : typeof el.href === 'string' ? el.href : '';
        if (!raw || raw[0] === '#') continue;
        if (hasExecutableURLScheme(raw)) return { href: '', element: el };
        if (isHTTPURL(raw)) return { href: raw, element: el };
      }
      return null;
    }
  }
  function installNavigatorIdentity(w) {
    const nav = w.navigator;
    if (!nav) return;
    const proto = w.Navigator && w.Navigator.prototype || Object.getPrototypeOf(nav);
    defineAccessor(proto, 'userAgent', () => TARGET_USER_AGENT);
    defineAccessor(nav, 'userAgent', () => TARGET_USER_AGENT);
    defineAccessor(proto, 'appVersion', () => TARGET_APP_VERSION);
    defineAccessor(nav, 'appVersion', () => TARGET_APP_VERSION);
    defineAccessor(proto, 'platform', () => TARGET_PLATFORM);
    defineAccessor(nav, 'platform', () => TARGET_PLATFORM);
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
      if (key.startsWith('on') && key.length > 2) return Native.setAttribute.call(this, k, rewriteEventAttribute(String(v)));
      if (this.localName === 'base' && key === 'href') {
        updateVirtualBase(v);
        return Native.setAttribute.call(this, k, v);
      }
      if (isURLBearing(this, key)) {
        if (hasExecutableURLScheme(v)) return blockExecutableURL(this, key, v);
        if (isHTTPURL(v)) {
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
      }
      if ((this.localName === 'iframe' || this.localName === 'frame') && key === 'srcdoc') return Native.setAttribute.call(this, k, injectSrcdoc(String(v)));
      return Native.setAttribute.call(this, k, v);
    });
    if (Native.setAttributeNS) define(w.Element.prototype, 'setAttributeNS', function(ns, k, v) { const key = String(k).toLowerCase(); return Native.setAttributeNS.call(this, ns, k, key.startsWith('on') && key.length > 2 ? rewriteEventAttribute(String(v)) : v); });
    if (Native.namedSetNamedItem && w.NamedNodeMap) define(w.NamedNodeMap.prototype, 'setNamedItem', function(attr) { if (attr && String(attr.name || '').toLowerCase().startsWith('on')) attr.value = rewriteEventAttribute(String(attr.value || '')); return Native.namedSetNamedItem.call(this, attr); });
    if (Native.attrValue && Native.attrValue.set && w.Attr) try { Object.defineProperty(w.Attr.prototype, 'value', { get: Native.attrValue.get, set(v) { Native.attrValue.set.call(this, String(this.name || '').toLowerCase().startsWith('on') ? rewriteEventAttribute(String(v)) : v); }, configurable: false }); } catch {}
    define(w.Element.prototype, 'getAttribute', function(k) { const key = String(k).toLowerCase(); if (isURLBearing(this, key)) return urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url') || Native.getAttribute.call(this, k); return Native.getAttribute.call(this, k); });
    patchHTMLSetter(w.Element.prototype, 'innerHTML');
    patchHTMLSetter(w.Element.prototype, 'outerHTML');
    define(w.Element.prototype, 'insertAdjacentHTML', function(pos, html) { const ret = Native.insertAdjacentHTML.call(this, pos, transformHTML(String(html))); syncBaseElement(this); return ret; });
    installBaseObserver();
    function patchHTMLSetter(proto, prop) { const d = Object.getOwnPropertyDescriptor(proto, prop); if (!d || !d.set) return; try { Object.defineProperty(proto, prop, { get: d.get, set(v) { d.set.call(this, transformHTML(String(v))); syncBaseElement(this); instrumentDescendantIframes(this); }, configurable: false }); } catch {} }
  }
  function isURLBearing(el, key) { const tag = el.localName; return key === 'href' && (tag === 'a' || tag === 'area') || key === 'action' && tag === 'form' || key === 'formaction' && (tag === 'input' || tag === 'button') || key === 'src' && (tag === 'iframe' || tag === 'frame'); }
  function transformHTML(s) { return String(s).replace(/<base\b[^>]*\shref=(["'])([\s\S]*?)\1[^>]*>/ig, (_, q, href) => baseSyncScript(href)).replace(/(<iframe\b[^>]*\ssrcdoc=["'])([\s\S]*?)(["'])/ig, (_, p, h, q) => p + injectSrcdoc(h).replace(/"/g,'&quot;') + q).replace(/<script\b/ig, '<script type="application/x-zeroproxy-blocked" data-zp-blocked-script').replace(/\s(on[a-z0-9_:-]+)\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)/ig, (_, name, value) => ' data-zp-blocked-' + name.toLowerCase() + '=' + value); }
  function injectSrcdoc(s) { return '<script src="/__zp/zp-core.js"><\/script><script id="__zp-boot" type="application/json">' + bootJSON() + '<\/script><script src="/__zp/runtime-prelude.js"><\/script>' + s; }
  function bootJSON() { return JSON.stringify(boot).replace(/[<>&]/g, c => c === '<' ? '\\u003c' : c === '>' ? '\\u003e' : '\\u0026'); }
  function baseSyncScript(raw) { return '<script>window.__ZP_SET_BASE&&window.__ZP_SET_BASE(' + JSON.stringify(String(raw)).replace(/</g,'\\u003c') + ');<\/script>'; }
  function rewriteEventAttribute(source) { return 'return __zp_runEvent(this,event,function(__zp_scope){with(__zp_scope){\n' + source + '\n}})'; }
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
          if (r.type === 'attributes') enforceObservedAttribute(r.target, String(r.attributeName || '').toLowerCase());
          else for (const n of r.addedNodes || []) { syncBaseElement(n); instrumentDescendantIframes(n); }
        }
      }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'src', 'srcdoc', 'action', 'formaction'] });
    } catch {}
  }
  function enforceObservedAttribute(el, key) {
    if (!el || !key) return;
    const tag = el.localName;
    if (tag === 'base' && key === 'href') { syncBaseElement(el); return; }
    if ((tag === 'iframe' || tag === 'frame') && key === 'srcdoc') {
      const raw = Native.getAttribute.call(el, 'srcdoc');
      if (raw && !raw.startsWith(injectSrcdoc(''))) Native.setAttribute.call(el, 'srcdoc', injectSrcdoc(String(raw)));
      instrumentIframe(el);
      return;
    }
    if (!isURLBearing(el, key)) return;
    const raw = Native.getAttribute.call(el, key);
    if (hasExecutableURLScheme(raw)) { blockExecutableURL(el, key, raw); return; }
    if (!raw || !isHTTPURL(raw) || String(raw).startsWith(proxyOrigin)) return;
    let target;
    try { target = targetURL(raw); } catch { return; }
    const alreadyMapped = urlMeta.get(el) === target && Native.getAttribute.call(el, 'data-zp-target-url') === target;
    urlMeta.set(el, target);
    Native.setAttribute.call(el, 'data-zp-target-url', target);
    if ((tag === 'iframe' || tag === 'frame') && key === 'src') {
      Native.setAttribute.call(el, key, 'about:blank');
      shareNavURL(target).then(u => Native.setAttribute.call(el, key, u)).catch(()=>{});
      instrumentIframe(el);
      return;
    }
    if (alreadyMapped) return;
    Native.setAttribute.call(el, key, target);
  }

  function installWorkerHooks() {
    if (Native.Worker) define(root, 'Worker', function(url, opts) { return new Native.Worker(workerBootstrapURL(url), opts); });
    if (Native.SharedWorker) define(root, 'SharedWorker', function(url, opts) { return new Native.SharedWorker(workerBootstrapURL(url), opts); });
    if (navigator.serviceWorker && navigator.serviceWorker.register) define(navigator.serviceWorker, 'register', function() { return Promise.reject(normalizedError('NotSupportedError')); });
    if (Native.createObjectURL) define(URL, 'createObjectURL', function(blob) { if (blob && /javascript|ecmascript|text\/plain|application\/octet-stream|^$/i.test(blob.type || '')) { const blocked = new Blob(["self.__ZP_WORKER_TARGET=", JSON.stringify(virtualURL.href), ";\nself.__ZP_WORKER_TAB_ID=", JSON.stringify(boot.tabId), ";\nimportScripts('/__zp/worker-prelude.js');\nthrow new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');\n"], { type: 'text/javascript' }); const raw = Native.createObjectURL(blocked); workerBlobURLs.add(raw); return raw; } return Native.createObjectURL(blob); });
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
    const blocked = new Blob(["self.__ZP_WORKER_TARGET=", JSON.stringify(virtualURL.href), ";\nself.__ZP_WORKER_TAB_ID=", JSON.stringify(boot.tabId), ";\nimportScripts('/__zp/worker-prelude.js');\nthrow new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');\n"], { type: 'text/javascript' });
    const safe = Native.createObjectURL(blocked);
    workerBlobURLs.add(safe);
    return safe;
  }

  function installIframeHooks(w) {
    if (!w || !w.document || !w.Node || !w.Element) return;
    try {
      if (w[iframeHooksMarker]) return;
      Object.defineProperty(w, iframeHooksMarker, { value: true, enumerable: false, configurable: false });
    } catch {}
    const instrumentedWindows = new WeakSet();
    const nativeCreateElement = w === root ? Native.createElement : w.document.createElement.bind(w.document);

    installFrameAccessors(w.HTMLIFrameElement && w.HTMLIFrameElement.prototype);
    installFrameAccessors(w.HTMLFrameElement && w.HTMLFrameElement.prototype);

    define(w.document, 'createElement', function(name, opts) {
      const el = nativeCreateElement(String(name), opts);
      if (/^i?frame$/i.test(String(name))) instrumentDescendantIframes(el);
      return el;
    });

    patchInsertion(w.Node.prototype, 'appendChild', w.Node.prototype.appendChild);
    patchInsertion(w.Node.prototype, 'insertBefore', w.Node.prototype.insertBefore);
    patchInsertion(w.Node.prototype, 'replaceChild', w.Node.prototype.replaceChild);
    for (const method of ['append', 'prepend', 'before', 'after', 'replaceWith']) patchInsertion(w.Element.prototype, method, w.Element.prototype[method]);

    if (w.HTMLIFrameElement) { installFrameProp(w.HTMLIFrameElement.prototype, 'src'); installFrameProp(w.HTMLIFrameElement.prototype, 'srcdoc'); }
    if (w.HTMLFrameElement) installFrameProp(w.HTMLFrameElement.prototype, 'src');

    function patchInsertion(proto, name, nativeFn) {
      if (!proto || typeof nativeFn !== 'function') return;
      define(proto, name, function(...args) {
        const frames = collectIframesFromArgs(args);
        const ret = nativeFn.apply(this, args);
        instrumentFrameList(frames);
        return ret;
      });
    }
    function installFrameAccessors(proto) {
      if (!proto) return;
      const win = frameDescriptor(proto, 'contentWindow');
      if (win && win.get) {
        try { Object.defineProperty(proto, 'contentWindow', { get() { return containFrameWindow(win.get.call(this), this); }, configurable: false, enumerable: true }); } catch {}
      }
      const doc = frameDescriptor(proto, 'contentDocument');
      if (doc && doc.get) {
        try { Object.defineProperty(proto, 'contentDocument', { get() { const childDoc = doc.get.call(this); if (childDoc && childDoc.defaultView) containFrameWindow(childDoc.defaultView, this); return childDoc; }, configurable: false, enumerable: true }); } catch {}
      }
    }
    function frameDescriptor(proto, prop) {
      for (let p = proto; p; p = Object.getPrototypeOf(p)) {
        const d = Object.getOwnPropertyDescriptor(p, prop);
        if (d) return d;
      }
      return null;
    }
    function containFrameWindow(childWin, frame) {
      if (!childWin) return childWin;
      try { if (childWin[networkContainmentMarker]) return childWin; } catch { if (instrumentedWindows.has(childWin)) return childWin; }
      instrumentedWindows.add(childWin);
      try { installNetworkContainment(childWin); }
      catch (e) {
        instrumentedWindows.delete(childWin);
        try { frame && frame.remove && frame.remove(); } catch {}
        throw e;
      }
      return childWin;
    }
    function installFrameProp(proto, prop) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) return;
      try {
        Object.defineProperty(proto, prop, {
          get: d.get,
          set(v) {
            if (prop === 'srcdoc') d.set.call(this, injectSrcdoc(String(v)));
            else if (isHTTPURL(v) && !String(v).startsWith(proxyOrigin)) {
              d.set.call(this, 'about:blank');
              shareNavURL(v).then(u => d.set.call(this, u)).catch(()=>{});
            } else d.set.call(this, v);
            instrumentIframe(this);
          },
          configurable: false
        });
      } catch {}
    }
  }
  function collectIframesFromArgs(args) {
    let frames = null;
    for (const node of args) frames = collectIframes(node, frames);
    return frames;
  }
  function collectIframes(node, frames) {
    if (!node || typeof node !== 'object') return frames;
    if (/^(IFRAME|FRAME)$/.test(node.nodeName || '')) {
      if (!frames) frames = [];
      frames.push(node);
    }
    if (node.querySelectorAll) {
      const descendants = node.querySelectorAll('iframe,frame');
      for (let i = 0; i < descendants.length; i++) {
        if (!frames) frames = [];
        frames.push(descendants[i]);
      }
    }
    return frames;
  }
  function instrumentFrameList(frames) { if (frames) for (const frame of frames) instrumentIframe(frame); }
  function instrumentDescendantIframes(node) { instrumentFrameList(collectIframes(node, null)); }
  function instrumentIframe(frame) {
    if (!frame || !/^(IFRAME|FRAME)$/.test(frame.nodeName || '')) return;
    try {
      const src = Native.getAttribute.call(frame, 'src');
      if ((!src || /^about:blank$/i.test(src)) && frame.contentWindow) installNetworkContainment(frame.contentWindow);
    } catch { try { frame.remove(); } catch {} }
  }
  function installNetworkContainment(w) {
    if (!w) return;
    try { if (w[networkContainmentMarker]) return; } catch {}
    installToStringMasking(w);
    // Native fetch is intentionally left intact; the Service Worker owns request capture.
    installNavigatorIdentity(w);
    if (root.WebSocket && !define(w, 'WebSocket', root.WebSocket)) throw normalizedError('SecurityError');
    if (w.navigator && navigator.sendBeacon) define(w.navigator, 'sendBeacon', navigator.sendBeacon.bind(navigator));
    installIframeHooks(w);
    installBlockers(w, true);
    installCanvasAntiFingerprinting(w);
    installAudioAntiFingerprinting(w);
    try { Object.defineProperty(w, networkContainmentMarker, { value: true, enumerable: false, configurable: false }); } catch {}
  }

  function installBlockers(w, strict = false) {
    for (const name of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','WebTransport','WebSocketStream']) {
      const blockCtor = function(){ throw normalizedError('NotSupportedError'); };
      const ok = define(w, name, blockCtor);
      if (strict && name in w && !ok) throw normalizedError('SecurityError');
    }
    const nav = w.navigator;
    if (nav) {
      for (const name of ['serial','hid','usb','bluetooth','requestMIDIAccess','credentials','geolocation','clipboard','wakeLock']) {
        const deny = function(){ throw normalizedError('NotSupportedError'); };
        toStringMap.set(deny, nativeAccessorSource('get', name));
        try { Object.defineProperty(nav, name, { get: deny, configurable: false }); } catch {}
      }
      if (nav.mediaDevices) for (const name of ['getUserMedia','getDisplayMedia','enumerateDevices']) define(nav.mediaDevices, name, function(){ return Promise.reject(normalizedError('NotSupportedError')); });
    }
    if (w.speechSynthesis) {
      const voices = Object.freeze([
        Object.freeze({ name: 'Google US English', lang: 'en-US', default: true, localService: false, voiceURI: 'Google US English' }),
        Object.freeze({ name: 'Microsoft David - English (United States)', lang: 'en-US', default: false, localService: true, voiceURI: 'Microsoft David' })
      ]);
      const getVoices = function() { return voices.slice(); };
      if (!define(w.speechSynthesis, 'getVoices', getVoices)) {
        try { define(Object.getPrototypeOf(w.speechSynthesis), 'getVoices', getVoices); } catch {}
      }
    }
  }

  function installCanvasAntiFingerprinting(w) {
    if (!w || canvasHookedWindows.has(w) || !w.CanvasRenderingContext2D || !w.HTMLCanvasElement) return;
    canvasHookedWindows.add(w);
    const ctxProto = w.CanvasRenderingContext2D.prototype;
    const canvasProto = w.HTMLCanvasElement.prototype;
    const origGetImageData = ctxProto && ctxProto.getImageData;
    if (typeof origGetImageData === 'function') {
      define(ctxProto, 'getImageData', function(...args) {
        const imageData = origGetImageData.apply(this, args);
        const data = imageData && imageData.data;
        if (data && data.length > 1) {
          data[0] = data[0] ^ 1;
          data[data.length - 2] = data[data.length - 2] ^ 1;
        }
        return imageData;
      });
    }
    const origToDataURL = canvasProto && canvasProto.toDataURL;
    if (typeof origToDataURL === 'function') {
      define(canvasProto, 'toDataURL', function(...args) {
        const width = this.width >>> 0;
        const height = this.height >>> 0;
        if (width && height) {
          const ctx = this.getContext && this.getContext('2d');
          if (ctx) {
            const fillStyle = ctx.fillStyle;
            const globalAlpha = ctx.globalAlpha;
            try {
              ctx.globalAlpha = 1;
              ctx.fillStyle = 'rgba(' + ((Math.random() * 256) | 0) + ',' + ((Math.random() * 256) | 0) + ',' + ((Math.random() * 256) | 0) + ',0.01)';
              ctx.fillRect((Math.random() * Math.min(width, 8)) | 0, (Math.random() * Math.min(height, 8)) | 0, 1, 1);
            } finally {
              try { ctx.fillStyle = fillStyle; } catch {}
              try { ctx.globalAlpha = globalAlpha; } catch {}
            }
          }
        }
        return origToDataURL.apply(this, args);
      });
    }
  }

  function installAudioAntiFingerprinting(w) {
    if (!w || audioHookedWindows.has(w) || !w.AudioBuffer) return;
    audioHookedWindows.add(w);
    const proto = w.AudioBuffer.prototype;
    const origGetChannelData = proto && proto.getChannelData;
    if (typeof origGetChannelData !== 'function') return;
    define(proto, 'getChannelData', function(channel) {
      const f32 = origGetChannelData.call(this, channel);
      const limit = Math.min(f32.length, 100);
      for (let i = 0; i < limit; i++) {
        if (f32[i] !== 0) {
          f32[i] += (Math.random() - 0.5) * 1e-7;
          break;
        }
      }
      return f32;
    });
  }
  try { const current = document.currentScript; if (current && /\/__zp\/runtime-prelude\.js(?:$|\?)/.test(current.src || '')) current.remove(); } catch {}
})();
