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
  const initialProxyURL = new URL(root.location.href);
  const proxyOrigin = initialProxyURL.origin;
  const activeServers = ZP.relayServersForShare(Array.isArray(boot.servers) ? boot.servers : [], { allowLoopbackWS: true });
  let activeProxyPath = initialProxyURL.pathname;
  let activeProxyFragment = preservedShareFragment(initialProxyURL.hash);
  let activeRouteKey = ZP.isSharePath(activeProxyPath) ? ZP.shareRouteKey(activeProxyPath) : '';
  let virtualURL = new URL(boot.targetUrl);
  let activeEntryId = boot.entryId;
  let baseURL = virtualURL.href;
  let explicitBaseURL = '';
  let activeShareVersion = 0;
  let documentCookie = String(boot.documentCookie || '');
  let documentReferrerPolicy = normalizeReferrerPolicy(boot.referrerPolicy || '');
  const dynamicCompileAllowed = boot.dynamicCompileAllowed === true;
  const documentCookieRecords = [];
  initDocumentCookieRecords(documentCookie);
  const urlMeta = new WeakMap();
  const messageListenerWrappers = new WeakMap();
  const frameWindowOrigins = new WeakMap();
  const crossWindowProxyCache = new WeakMap();
  const postMessageWrappers = new WeakMap();
  const postMessageOriginals = new WeakMap();
  const frameTargetOriginMarker = Symbol.for('zeroproxy.frame.targetOrigin');
  const networkContainmentMarker = Symbol.for('zeroproxy.network.contained');
  const iframeHooksMarker = Symbol.for('zeroproxy.iframe.hooks');
  const stealthMarker = Symbol.for('zeroproxy.stealth.membrane');
  const listenersKey = Symbol('zp.listeners');
  const membraneRawTargets = new WeakMap();
  const rewrittenInlineScripts = new WeakSet();
  const rewrittenStyleNodes = new WeakSet();
  const nativeFormSubmissions = new WeakSet();
  const windowMethodBindings = new Map();
  const integrityBackupAttr = 'data-zp-integrity';
  const hiddenIconHref = 'data:application/x-zeroproxy-icon,1';
  const WINDOW_BOUND_METHODS = new Set(['addEventListener','removeEventListener','dispatchEvent','setTimeout','setInterval','clearTimeout','clearInterval','requestAnimationFrame','cancelAnimationFrame','requestIdleCallback','cancelIdleCallback','matchMedia','getComputedStyle','postMessage','atob','btoa','focus','blur','close','print','alert','confirm','prompt','scroll','scrollTo','scrollBy']);
  const workerBlobURLs = new Set();
  const canvasHookedWindows = new WeakSet();
  const audioHookedWindows = new WeakSet();
  const serviceWorkerFacades = new WeakMap();
  const storageMaps = new Map();
  const storageWindows = new Set();
  const storageDirtyKeys = new Map();
  let storageDBPromise = null;


  function readBootConfig() {
    return root.__ZP_BOOT || {};
  }

  function clearBootConfig() {
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
      serviceWorkerController: w.navigator && w.navigator.serviceWorker && w.navigator.serviceWorker.controller,
      Headers: w.Headers,
      navigatorSendBeacon: w.navigator && w.navigator.sendBeacon && w.navigator.sendBeacon.bind(w.navigator),
      serviceWorker: w.navigator && w.navigator.serviceWorker,
      createElement: d.createElement.bind(d),
      createElementNS: d.createElementNS && d.createElementNS.bind(d),
      appendChild: w.Node.prototype.appendChild,
      insertBefore: w.Node.prototype.insertBefore,
      replaceChild: w.Node.prototype.replaceChild,
      setAttribute: w.Element.prototype.setAttribute,
      getAttribute: w.Element.prototype.getAttribute,
      removeAttribute: w.Element.prototype.removeAttribute,
      hasAttribute: w.Element.prototype.hasAttribute,
      getAttributeNames: w.Element.prototype.getAttributeNames,
      insertAdjacentHTML: w.Element.prototype.insertAdjacentHTML,
      elementInnerHTML: Object.getOwnPropertyDescriptor(w.Element.prototype, 'innerHTML'),
      elementOuterHTML: Object.getOwnPropertyDescriptor(w.Element.prototype, 'outerHTML'),
      elementAttributes: Object.getOwnPropertyDescriptor(w.Element.prototype, 'attributes'),
      setAttributeNS: w.Element.prototype.setAttributeNS,
      namedSetNamedItem: w.NamedNodeMap && w.NamedNodeMap.prototype.setNamedItem,
      attrValue: w.Attr && Object.getOwnPropertyDescriptor(w.Attr.prototype, 'value'),
      matches: w.Element.prototype.matches,
      closest: w.Element.prototype.closest,
      querySelector: w.Document.prototype.querySelector,
      querySelectorAll: w.Document.prototype.querySelectorAll,
      elementQuerySelector: w.Element.prototype.querySelector,
      elementQuerySelectorAll: w.Element.prototype.querySelectorAll,
      documentGetElementsByTagName: w.Document.prototype.getElementsByTagName,
      elementGetElementsByTagName: w.Element.prototype.getElementsByTagName,
      documentScripts: Object.getOwnPropertyDescriptor(w.Document.prototype, 'scripts'),
      createNodeIterator: w.Document.prototype.createNodeIterator,
      createTreeWalker: w.Document.prototype.createTreeWalker,
      createHTMLDocument: d.implementation && d.implementation.createHTMLDocument && d.implementation.createHTMLDocument.bind(d.implementation),
      scriptText: w.HTMLScriptElement && Object.getOwnPropertyDescriptor(w.HTMLScriptElement.prototype, 'text'),
      nodeTextContent: Object.getOwnPropertyDescriptor(w.Node.prototype, 'textContent'),
      htmlInnerText: w.HTMLElement && Object.getOwnPropertyDescriptor(w.HTMLElement.prototype, 'innerText'),
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
      locationHref: Object.getOwnPropertyDescriptor(w.Location && w.Location.prototype, 'href') || Object.getOwnPropertyDescriptor(w.location, 'href'),
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
      windowAddEventListener: w.addEventListener && w.addEventListener.bind(w),
      windowRemoveEventListener: w.removeEventListener && w.removeEventListener.bind(w),
      objectGetPrototypeOf: Object.getPrototypeOf,
      reflectGetPrototypeOf: w.Reflect && w.Reflect.getPrototypeOf,
      reflectApply: w.Reflect && w.Reflect.apply,
      weakMapGet: w.WeakMap && w.WeakMap.prototype && w.WeakMap.prototype.get,
      indexedDB: w.indexedDB,
      localStorage: (() => { try { return w.localStorage; } catch { return null; } })(),
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
  function maskNativeFunction(fn, key) {
    if (typeof fn === 'function') toStringMap.set(fn, nativeFunctionSource(key));
  }
  function maskMethods(obj, keys) {
    for (const key of keys) maskNativeFunction(obj && obj[key], key);
  }
  function define(obj, key, value) {
    try {
      Object.defineProperty(obj, key, { value, enumerable: false, configurable: false, writable: true });
      maskNativeFunction(value, key);
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
      Object.defineProperty(proto, 'toString', { value: maskedToString, enumerable: false, configurable: true, writable: true });
      toStringMaskedPrototypes.add(proto);
    } catch {}
  }
  function installEventMethods(proto) {
    define(proto, 'addEventListener', function(type, fn) { if (!fn) return; const key = String(type); if (!this[listenersKey]) this[listenersKey] = new Map(); const list = this[listenersKey].get(key) || []; list.push(fn); this[listenersKey].set(key, list); });
    define(proto, 'removeEventListener', function(type, fn) { const list = this[listenersKey] && this[listenersKey].get(String(type)); if (!list) return; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); });
    define(proto, 'dispatchEvent', function(event) { const list = this[listenersKey] && this[listenersKey].get(event.type) || []; try { if (!event.target) Object.defineProperty(event, 'target', { value: this, configurable: true }); } catch {} const handler = this['on' + event.type]; if (typeof handler === 'function') handler.call(this, event); for (const fn of list.slice()) fn.call(this, event); return !event.defaultPrevented; });
  }
  function preservedShareFragment(hash) {
    if (!hash) return '';
    try {
      const raw = hash[0] === '#' ? hash.slice(1) : hash;
      const params = new URLSearchParams(raw);
      const key = params.get('k');
      return key ? ZP.makeShareFragment(key, activeServers) : '';
    } catch { return ''; }
  }
  function shareFragmentForKey(key) { return ZP.makeShareFragment(String(key), activeServers); }
  function proxyHistoryURL() { return activeProxyPath + activeProxyFragment; }
  function nativeLocationURL() {
    try {
      const href = Native.locationHref && Native.locationHref.get && Native.locationHref.get.call(root.location);
      if (href) return new URL(href);
    } catch {}
    try { return new URL(proxyHistoryURL(), proxyOrigin); } catch { return new URL(initialProxyURL.href); }
  }
  function visibleProxyURL() { const u = nativeLocationURL(); return u.pathname + u.search + u.hash; }
  function setActiveShareRoute(share) {
    activeProxyPath = ZP.makeSharePath(share.encrypted);
    activeRouteKey = share.encrypted;
    activeProxyFragment = shareFragmentForKey(share.key);
  }
  function replaceVisibleProxyURL() {
    const next = proxyHistoryURL();
    if (visibleProxyURL() !== next) {
      try { Native.historyReplace(root.history.state, '', next); } catch {}
    }
  }
  function refreshVisibleShareRoute(entryId, target, base) {
    const version = ++activeShareVersion;
    ZP.encryptShareURL(target).then(share => {
      return postMessageToSW({ type: 'ZP_HISTORY_UPDATE', tabId: boot.tabId, routeKey: share.encrypted, entryId, targetUrl: target, baseUrl: base, replace: true }).then(() => share);
    }).then(share => {
      if (version !== activeShareVersion || entryId !== activeEntryId || target !== virtualURL.href) return;
      setActiveShareRoute(share);
      replaceVisibleProxyURL();
    }).catch(()=>{});
  }
  function isHTTPURL(raw) { try { const u = new URL(String(raw), baseURL); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } }
  function hasExecutableURLScheme(raw) { return /^(?:javascript|data|vbscript):/i.test(String(raw).trim()); }
  function hasDangerousURLScheme(raw) { return /^(?:javascript|vbscript):/i.test(String(raw).trim()); }
  function shouldBlockURLAttribute(el, key, raw) {
    const tag = el && el.localName;
    const localKey = attrLocalName(key);
    const strict = localKey === 'src' && tag === 'script' || localKey === 'src' && (tag === 'iframe' || tag === 'frame') || usesRawURLAttribute(el, key);
    return strict ? hasExecutableURLScheme(raw) : hasDangerousURLScheme(raw);
  }
  function blockedURLValue(el, key) { const tag = el && el.localName; return key === 'src' && (tag === 'iframe' || tag === 'frame') ? 'about:blank' : key === 'src' && tag === 'script' ? ZP.errorPath('POLICY_BLOCKED') : '#'; }
  function blockExecutableURL(el, key, raw) { urlMeta.delete(el); Native.setAttribute.call(el, 'data-zp-target-url', ''); Native.setAttribute.call(el, 'data-zp-blocked-url', String(raw).trim()); Native.setAttribute.call(el, key, blockedURLValue(el, key)); if (key === 'src' && (el.localName === 'iframe' || el.localName === 'frame')) instrumentIframe(el); }
  function isIntegrityBearing(el) { const tag = el && el.localName; return tag === 'script' || tag === 'link'; }
  function backedIntegrity(el) { return isIntegrityBearing(el) ? Native.getAttribute.call(el, integrityBackupAttr) : null; }
  function setBackedIntegrity(el, value) { Native.setAttribute.call(el, integrityBackupAttr, String(value)); if (Native.removeAttribute) Native.removeAttribute.call(el, 'integrity'); }
  function targetURL(raw, base = baseURL) { return ZP.canonicalTargetURL(String(raw), base).href; }
  function targetWSURL(raw, base = baseURL) { return ZP.canonicalWebSocketURL(String(raw), base.replace(/^http/, 'ws')).href; }
  function shareNavURL(raw, base = baseURL) { return ZP.makeShareURL(targetURL(raw, base), proxyOrigin, activeServers); }
  function sameOriginHistoryURL(url) { const next = new URL(targetURL(url)); if (next.origin !== virtualURL.origin) throw normalizedError('SecurityError'); return next; }
  function commitVirtualHistory(state, title, url, replace = false) {
    const next = url != null ? sameOriginHistoryURL(url) : new URL(virtualURL.href);
    virtualURL = next;
    if (!explicitBaseURL) baseURL = virtualURL.href;
    const entryId = replace && activeEntryId ? activeEntryId : 'e' + ZP.randomId();
    activeEntryId = entryId;
    postMessageToSW({ type: 'ZP_HISTORY_UPDATE', tabId: boot.tabId, routeKey: activeRouteKey, entryId, targetUrl: virtualURL.href, baseUrl: baseURL, replace }).catch(()=>{});
    const out = (replace ? Native.historyReplace : Native.historyPush)(state, title, proxyHistoryURL());
    refreshVisibleShareRoute(entryId, virtualURL.href, baseURL);
    return out;
  }
  function updateVirtualHash(raw, replace = false) {
    const oldURL = virtualURL.href;
    const next = new URL(virtualURL.href);
    let hash = String(raw);
    if (hash && hash[0] !== '#') hash = '#' + hash;
    next.hash = hash;
    if (next.href === virtualURL.href) return;
    const out = commitVirtualHistory(null, '', next.href, replace);
    try { window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: virtualURL.href })); } catch { try { window.dispatchEvent(new Event('hashchange')); } catch {} }
    return out;
  }
  function setVirtualLocation(raw, replace = false) {
    const next = new URL(targetURL(raw));
    if (next.origin === virtualURL.origin && next.pathname === virtualURL.pathname && next.search === virtualURL.search) {
      updateVirtualHash(next.hash, replace);
      return;
    }
    navigateToTarget(next.href, replace);
  }
  async function activatedNavPath(raw, replace = false, base = baseURL) {
    const target = targetURL(raw, base);
    const share = await ZP.encryptShareURL(target);
    const path = ZP.makeSharePath(share.encrypted);
    const entryId = replace ? activeEntryId : 'e' + ZP.randomId();
    await postMessageToSW({ type: 'ZP_HISTORY_UPDATE', tabId: boot.tabId, routeKey: share.encrypted, entryId, targetUrl: target, baseUrl: target, replace });
    activeProxyPath = path;
    activeRouteKey = share.encrypted;
    activeProxyFragment = shareFragmentForKey(share.key);
    return path + activeProxyFragment;
  }
  async function activatedFrameURL(raw, base = baseURL) {
    const target = targetURL(raw, base);
    const share = await ZP.encryptShareURL(target);
    const entryId = 'e' + ZP.randomId();
    await postMessageToSW({ type: 'ZP_FRAME_ROUTE', tabId: boot.tabId, routeKey: share.encrypted, entryId, targetUrl: target, baseUrl: target });
    return proxyOrigin + ZP.makeSharePath(share.encrypted) + shareFragmentForKey(share.key);
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
    const controller = Native.serviceWorkerController || Native.serviceWorker && Native.serviceWorker.controller;
    if (!controller || !runtimeToken) return Promise.reject(normalizedError('NetworkError'));
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const sealed = Object.assign({}, message, { runtimeToken });
      channel.port1.onmessage = ev => {
        const data = ev.data || {};
        if (data.ok) resolve(data);
        else { const err = new Error(data.error || 'NetworkError'); err.code = data.error || 'NetworkError'; reject(err); }
      };
      controller.postMessage(sealed, transfer ? [channel.port2, ...transfer] : [channel.port2]);
    });
  }
  async function openUploadStream(body, signal) {
    if (!body || typeof body.getReader !== 'function') return '';
    const id = ZP.randomId('up');
    const channel = new MessageChannel();
    const port = channel.port1;
    const reader = body.getReader();
    let closed = false;
    let reading = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try { reader.releaseLock && reader.releaseLock(); } catch {}
      try { port.close(); } catch {}
    };
    const cancel = () => {
      if (closed) return;
      try { reader.cancel && reader.cancel(); } catch {}
      try { port.postMessage({ type: 'error', error: 'AbortError' }); } catch {}
      close();
    };
    port.onmessage = async ev => {
      const msg = ev && ev.data || {};
      if (msg.type === 'cancel') { cancel(); return; }
      if (msg.type !== 'pull' || closed || reading) return;
      reading = true;
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          try { port.postMessage({ type: 'close' }); } catch {}
          close();
          return;
        }
        const value = chunk.value;
        let bytes;
        if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
        else if (value && value.buffer instanceof ArrayBuffer) bytes = new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength || value.buffer.byteLength);
        else bytes = new Uint8Array();
        const data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
        port.postMessage({ type: 'chunk', data }, [data]);
      } catch (err) {
        try { port.postMessage({ type: 'error', error: err && (err.name || err.message) || 'NetworkError' }); } catch {}
        close();
      } finally {
        reading = false;
      }
    };
    if (signal) {
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    }
    await postMessageToSW({ type: 'ZP_UPLOAD_STREAM_OPEN', tabId: boot.tabId, entryId: activeEntryId, id }, [channel.port2]);
    return id;
  }
  function workerUploadChannelName() {
    return '__zp_worker_upload:' + boot.tabId + ':' + runtimeToken;
  }
  function installWorkerUploadRelay() {
    if (typeof root.BroadcastChannel !== 'function' || typeof root.ReadableStream !== 'function') return;
    let bc;
    try { bc = new root.BroadcastChannel(workerUploadChannelName()); } catch { return; }
    const pending = new Map();
    bc.onmessage = async ev => {
      const msg = ev && ev.data || {};
      if (msg.role !== 'worker' || msg.tabId !== boot.tabId || msg.runtimeToken !== runtimeToken) return;
      const id = String(msg.id || '');
      if (!id) return;
      if (msg.type === 'open') {
        let controllerRef = null;
        let closed = false;
        const stream = new root.ReadableStream({
          pull(controller) {
            controllerRef = controller;
            bc.postMessage({ role: 'page', type: 'pull', id });
          },
          cancel() {
            closed = true;
            pending.delete(id);
            bc.postMessage({ role: 'page', type: 'cancel', id });
          }
        });
        pending.set(id, {
          chunk(data) {
            if (closed || !controllerRef) return;
            controllerRef.enqueue(new Uint8Array(data || new ArrayBuffer(0)));
            controllerRef = null;
          },
          close() {
            if (closed) return;
            closed = true;
            pending.delete(id);
            if (controllerRef) controllerRef.close();
          },
          error(error) {
            if (closed) return;
            closed = true;
            pending.delete(id);
            if (controllerRef) controllerRef.error(new Error(error || 'NetworkError'));
          }
        });
        try {
          const streamId = await openUploadStream(stream);
          bc.postMessage({ role: 'page', type: 'ready', id, streamId });
        } catch (err) {
          pending.delete(id);
          bc.postMessage({ role: 'page', type: 'error', id, error: err && (err.name || err.message) || 'NetworkError' });
        }
        return;
      }
      const relay = pending.get(id);
      if (!relay) return;
      if (msg.type === 'chunk') relay.chunk(msg.data);
      else if (msg.type === 'close') relay.close();
      else if (msg.type === 'error') relay.error(msg.error);
    };
  }
  function updateVirtualBase(raw) {
    try {
      const next = targetURL(raw, baseURL);
      baseURL = next;
      explicitBaseURL = next;
      postMessageToSW({ type: 'ZP_BASE_UPDATE', tabId: boot.tabId, entryId: activeEntryId, baseUrl: next }).catch(()=>{});
      return next;
    } catch {
      return baseURL;
    }
  }
	  function rewritePageSource(source, kind) {
	    if (!root.ZPRewriter || !root.ZPRewriter.ready || typeof root.ZPRewriter.rewriteScript !== 'function') return fallbackRewritePageSource(source, kind);
	    const out = root.ZPRewriter.rewriteScript(String(source || ''), { kind, targetUrl: virtualURL.href, strict: true, controlPrefix: ZP.CONTROL_PREFIX });
	    if (!out || !out.ok || typeof out.code !== 'string') throw normalizedError('NotSupportedError');
	    return out.code;
	  }
	  function fallbackRewritePageSource(source, kind) {
	    if (kind && kind !== 'classic') throw normalizedError('NotSupportedError');
	    const text = String(source || '');
	    if (/\b(?:import|export|function|class|with)\b|=>|`/.test(text)) throw normalizedError('NotSupportedError');
	    let out = text;
	    out = out.replace(/\b(?:window|self|globalThis)\.location\.href\b/g, '__zp_get(globalThis,"location").href');
	    out = out.replace(/(^|[^\w$.])location\.href\b/g, '$1__zp_get(globalThis,"location").href');
	    out = out.replace(/\b(?:window|self|globalThis)\.location\.origin\b/g, '__zp_get(globalThis,"location").origin');
	    out = out.replace(/(^|[^\w$.])location\.origin\b/g, '$1__zp_get(globalThis,"location").origin');
	    if (out === text && !/^\s*(?:window|self|globalThis)\.[A-Za-z_$][\w$]*\s*=/.test(text)) throw normalizedError('NotSupportedError');
	    return out;
	  }
	  function cssResourceURL(raw, base) {
	    const text = String(raw || '').trim();
	    if (!text || text[0] === '#' || /^(?:data|blob|about):/i.test(text)) return text;
	    try { return resourceProxyPath(targetURL(text, base)); } catch { return text; }
	  }
	  function resourceProxyPath(target) { return ZP.apiPath('fetch') + '?url=' + encodeURIComponent(target); }
	  function parseSrcset(raw) {
	    const out = [];
	    let s = String(raw || '').trim();
	    while (s) {
	      let i = 0;
	      if (/^data:/i.test(s)) while (i < s.length && !/\s/.test(s[i])) i++;
	      else while (i < s.length && !/[\s,]/.test(s[i])) i++;
	      const url = s.slice(0, i);
	      let j = i;
	      while (j < s.length && s[j] !== ',') j++;
	      const descriptor = s.slice(i, j).trim();
	      const rawCandidate = s.slice(0, j).trim();
	      if (url) out.push({ url, descriptor, raw: rawCandidate });
	      s = j < s.length ? s.slice(j + 1).trim() : '';
	    }
	    return out;
	  }
	  function joinSrcsetCandidate(url, descriptor) { return descriptor ? url + ' ' + descriptor : url; }
	  function rewriteSrcsetValue(raw, base = baseURL) {
	    const candidates = parseSrcset(raw);
	    if (!candidates.length) return { changed: false, actual: String(raw || ''), visible: String(raw || '') };
	    let changed = false;
	    const actual = [];
	    const visible = [];
	    for (const c of candidates) {
	      let target = proxiedFetchTarget(c.url);
	      if (!target) {
	        try { target = targetURL(c.url, base); }
	        catch { actual.push(c.raw); visible.push(c.raw); continue; }
	      }
	      actual.push(joinSrcsetCandidate(resourceProxyPath(target), c.descriptor));
	      visible.push(joinSrcsetCandidate(target, c.descriptor));
	      changed = true;
	    }
	    return { changed, actual: actual.join(', '), visible: visible.join(', ') };
	  }
	  function fallbackRewriteCSS(source, base) {
	    const css = String(source || '');
	    let out = '';
	    let i = 0;
	    while (i < css.length) {
	      const ch = css[i];
	      const next = css[i + 1];
	      if (ch === '/' && next === '*') {
	        const end = css.indexOf('*/', i + 2);
	        const j = end < 0 ? css.length : end + 2;
	        out += css.slice(i, j);
	        i = j;
	        continue;
	      }
	      if (ch === '"' || ch === "'") {
	        const quote = ch;
	        let j = i + 1;
	        while (j < css.length) {
	          if (css[j] === '\\') { j += 2; continue; }
	          if (css[j] === quote) { j++; break; }
	          j++;
	        }
	        out += css.slice(i, j);
	        i = j;
	        continue;
	      }
	      if ((ch === 'u' || ch === 'U') && css.slice(i, i + 3).toLowerCase() === 'url' && !/[A-Za-z0-9_-]/.test(css[i - 1] || '') && !/[A-Za-z0-9_-]/.test(css[i + 3] || '')) {
	        let open = i + 3;
	        while (/\s/.test(css[open] || '')) open++;
	        if (css[open] === '(') {
	          let j = open + 1;
	          while (/\s/.test(css[j] || '')) j++;
	          const quote = css[j] === '"' || css[j] === "'" ? css[j++] : '';
	          let value = '';
	          while (j < css.length) {
	            if (css[j] === '\\' && j + 1 < css.length) { value += css.slice(j, j + 2); j += 2; continue; }
	            if (quote ? css[j] === quote : css[j] === ')') break;
	            value += css[j++];
	          }
	          if (quote && css[j] === quote) j++;
	          while (/\s/.test(css[j] || '')) j++;
	          if (css[j] === ')') {
	            out += 'url("' + cssResourceURL(value, base) + '")';
	            i = j + 1;
	            continue;
	          }
	        }
	      }
	      if (ch === '@' && css.slice(i, i + 7).toLowerCase() === '@import') {
	        out += css.slice(i, i + 7);
	        i += 7;
	        while (i < css.length && /\s/.test(css[i])) out += css[i++];
	        const quote = css[i] === '"' || css[i] === "'" ? css[i++] : '';
	        if (quote) {
	          let value = '';
	          while (i < css.length) {
	            if (css[i] === '\\' && i + 1 < css.length) { value += css.slice(i, i + 2); i += 2; continue; }
	            if (css[i] === quote) break;
	            value += css[i++];
	          }
	          if (css[i] === quote) i++;
	          out += '"' + cssResourceURL(value, base) + '"';
	          continue;
	        }
	      }
	      out += ch;
	      i++;
	    }
	    return out;
	  }
	  function rewriteCSSSource(source, base = baseURL) {
	    if (!root.ZPRewriter || !root.ZPRewriter.ready || typeof root.ZPRewriter.rewriteCSS !== 'function') return fallbackRewriteCSS(source, base);
	    const out = root.ZPRewriter.rewriteCSS(String(source || ''), { baseUrl: base, controlPrefix: ZP.CONTROL_PREFIX });
	    return out && out.ok && typeof out.code === 'string' ? out.code : fallbackRewriteCSS(source, base);
	  }
  function normalizePostMessageTargetOrigin(targetOrigin) {
    if (targetOrigin == null) return targetOrigin;
    const s = String(targetOrigin);
    if (s === '*' || s === '/') return s;
    try {
      const u = new URL(s);
      if (u.protocol === 'http:' || u.protocol === 'https:') return proxyOrigin;
    } catch {}
    return s;
  }
  function postMessageWrapperFor(target) {
    if (!target || typeof target.postMessage !== 'function') return undefined;
    if (postMessageWrappers.has(target)) return postMessageWrappers.get(target);
    const original = target.postMessage.bind(target);
    postMessageOriginals.set(target, original);
    const wrapped = function postMessage(message, targetOrigin, transfer) {
      if (arguments.length < 2) return original(message, proxyOrigin);
      const mapped = normalizePostMessageTargetOrigin(targetOrigin);
      return arguments.length > 2 ? original(message, mapped, transfer) : original(message, mapped);
    };
    maskNativeFunction(wrapped, 'postMessage');
    postMessageWrappers.set(target, wrapped);
    return wrapped;
  }
  function virtualOriginForMessage(ev) {
    if (!ev || ev.origin !== proxyOrigin || !ev.source) return '';
    try {
      const origin = frameWindowOrigins.get(ev.source) || ev.source[frameTargetOriginMarker];
      return origin || '';
    } catch {
      return '';
    }
  }
  function virtualizeMessageEvent(ev) {
    const origin = virtualOriginForMessage(ev);
    if (!origin) return ev;
    try {
      return new MessageEvent(ev.type, { data: ev.data, origin, lastEventId: ev.lastEventId || '', source: ev.source, ports: ev.ports || [] });
    } catch {
      try {
        const clone = Object.create(ev);
        Object.defineProperty(clone, 'origin', { value: origin, configurable: true });
        return clone;
      } catch {
        return ev;
      }
    }
  }
  function rememberFrameOrigin(frame) {
    if (!frame) return;
    let target = '';
    try { target = urlMeta.get(frame) || Native.getAttribute.call(frame, 'data-zp-target-url') || ''; } catch {}
    if (!target) return;
    try {
      const child = frame.contentWindow;
      if (child) frameWindowOrigins.set(child, new URL(target).origin);
    } catch {}
  }
  try { Object.defineProperty(root, frameTargetOriginMarker, { get() { return virtualURL.origin; }, enumerable: false, configurable: false }); } catch {}
  installToStringMasking(root);
  define(root, '__ZP_SET_BASE', updateVirtualBase);
  installPhase2Membrane();

  installWebSocket();
  installWebSocketStream();
  installHTTPAPIs();
  installBeacon();
  installNavigationTraps();
  installCookieSync();
  installPopupHooks(root);
  installPostMessageHooks(root);
  installNavigatorIdentity(root);
  installGetterMasking(root);
  installStorageFacades(root);
  installWorkerUploadRelay();
  installOwnPropertyMasking(root);
  installDOMHooks(root);
  installStealthMembrane(root);
  installPerformanceMasking(root);
  installWorkerHooks();
  installTargetServiceWorkerBlocker(root);
  installIframeHooks(root);
  installBlockers(root);
  installCanvasAntiFingerprinting(root);
  installAudioAntiFingerprinting(root);
  removeBootstrapArtifacts();


  function installPhase2Membrane() {
    function boundWindowMethod(target, prop) {
      const fn = target[prop];
      if (typeof fn !== 'function') return fn;
      if (windowMethodBindings.has(prop)) return windowMethodBindings.get(prop);
      const bound = fn.bind(target);
      maskNativeFunction(bound, prop);
      windowMethodBindings.set(prop, bound);
      return bound;
    }

    const NativeAsyncFunction = (async function(){}).constructor;
    const NativeGeneratorFunction = (function*(){}).constructor;
    const NativeAsyncGeneratorFunction = (async function*(){}).constructor;
    function stringArgs(args) {
      const out = new Array(args.length);
      for (let i = 0; i < args.length; i++) out[i] = String(args[i]);
      return out;
    }
	    function unsupportedDynamicCompile(params, body, kind) {
	      if (!dynamicCompileAllowed) throw normalizedError('SecurityError');
	      throw normalizedError('NotSupportedError');
	    }
    function simpleDynamicValue(expr) {
      const text = String(expr || '').trim().replace(/;+\s*$/, '');
      if (text === 'location.href' || text === 'window.location.href' || text === 'self.location.href' || text === 'globalThis.location.href') return virtualURL.href;
      if (text === 'location.origin' || text === 'window.location.origin') return virtualURL.origin;
      if (text === 'location.hash' || text === 'window.location.hash') return virtualURL.hash;
      if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
      const quoted = /^(['"])([\s\S]*)\1$/.exec(text);
      if (quoted) return quoted[2];
      return undefined;
    }
    function compileSimpleDynamic(params, body, kind) {
      if (params.length || kind !== 'function') return null;
      const text = String(body || '').trim();
      const m = /^return\s+([\s\S]*?);?$/.exec(text);
      if (!m) return null;
      const fn = function anonymous() { return simpleDynamicValue(m[1]); };
      toStringMap.set(fn, dynamicSource(kind, params, body));
      return fn;
    }
    function evalSimpleDynamic(text) {
      const source = String(text || '').trim();
      const assignment = /^(?:window|self|globalThis)\.([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?);?$/.exec(source);
      if (assignment) {
        const value = simpleDynamicValue(assignment[2]);
        if (value !== undefined) {
          root[assignment[1]] = value;
          return value;
        }
      }
      return simpleDynamicValue(source);
    }
    function compileTimerString(source) {
      const text = String(source || '');
      let compiled = null;
      return function anonymous() {
        const simple = evalSimpleDynamic(text);
        if (simple !== undefined) return simple;
        if (!compiled) compiled = compileEvalSource(text);
        return compiled.call(root, scope);
      };
    }
    function scopedCallArgs(args) {
      const argv = new Array(args.length + 1);
      argv[0] = scope;
      for (let i = 0; i < args.length; i++) argv[i + 1] = args[i];
      return argv;
    }
    function dynamicSource(kind, params, body) {
      const prefix = kind === 'async' ? 'async function' : kind === 'generator' ? 'function*' : kind === 'asyncGenerator' ? 'async function*' : 'function';
      return prefix + ' anonymous(' + params.join(',') + '\n) {\n' + body + '\n}';
    }
    function compileDynamic(ctor, args, kind) {
      const parts = stringArgs(args);
      const body = parts.length ? parts[parts.length - 1] : '';
      const params = new Array(parts.length > 0 ? parts.length - 1 : 0);
      for (let i = 0; i < params.length; i++) params[i] = parts[i];
      if (!dynamicCompileAllowed) throw normalizedError('SecurityError');
      const simple = compileSimpleDynamic(params, body, kind);
      if (simple) return simple;
      const rewritten = rewriteDynamicFunctionBody(params, body);
      const fn = Reflect.construct(ctor, params.concat(rewritten));
      toStringMap.set(fn, dynamicSource(kind, params, body));
      return fn;
    }
    function isEvalExpressionCandidate(text) {
      return !/^(?:function|class|var|let|const|if|for|while|do|switch|try|throw|return|break|continue|with|import|export|debugger)\b/.test(text.trimStart());
    }
    function dynamicEval(source) {
      if (arguments.length === 0) return undefined;
      if (!dynamicCompileAllowed) throw normalizedError('SecurityError');
      const text = String(source);
      const simple = evalSimpleDynamic(text);
      if (simple !== undefined) return simple;
      return compileEvalSource(text).call(root, scope);
    }
    function compileEvalSource(text) {
      if (!dynamicCompileAllowed) throw normalizedError('SecurityError');
      let source = String(text || '');
      if (isEvalExpressionCandidate(source)) source = 'return (' + source + ');';
      const rewritten = rewriteWithPageRewriter(source, 'classic');
      return Native.FunctionCtor('scope', rewritten);
    }
    const dynamicFunction = function Function(...args) { return compileDynamic(Native.FunctionCtor, args, 'function'); };
    const dynamicAsyncFunction = function AsyncFunction(...args) { return compileDynamic(NativeAsyncFunction, args, 'async'); };
    const dynamicGeneratorFunction = function GeneratorFunction(...args) { return compileDynamic(NativeGeneratorFunction, args, 'generator'); };
    const dynamicAsyncGeneratorFunction = function AsyncGeneratorFunction(...args) { return compileDynamic(NativeAsyncGeneratorFunction, args, 'asyncGenerator'); };
    function setDynamicConstructorIdentity(fn, name, proto) {
      try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch {}
      try { Object.defineProperty(fn, 'length', { value: 1, configurable: true }); } catch {}
      if (proto) try { Object.defineProperty(fn, 'prototype', { value: proto, enumerable: false, configurable: false, writable: false }); } catch {}
      maskNativeFunction(fn, name);
    }
    setDynamicConstructorIdentity(dynamicFunction, 'Function', Native.FunctionCtor && Native.FunctionCtor.prototype);
    setDynamicConstructorIdentity(dynamicAsyncFunction, 'AsyncFunction', NativeAsyncFunction && NativeAsyncFunction.prototype);
    setDynamicConstructorIdentity(dynamicGeneratorFunction, 'GeneratorFunction', NativeGeneratorFunction && NativeGeneratorFunction.prototype);
    setDynamicConstructorIdentity(dynamicAsyncGeneratorFunction, 'AsyncGeneratorFunction', NativeAsyncGeneratorFunction && NativeAsyncGeneratorFunction.prototype);
    try { Object.defineProperty(dynamicEval, 'name', { value: 'eval', configurable: true }); } catch {}
    try { Object.defineProperty(dynamicEval, 'length', { value: 1, configurable: true }); } catch {}
    maskNativeFunction(dynamicEval, 'eval');
    const dynamicConstructorWrappers = new Map([
      [Native.FunctionCtor, dynamicFunction],
      [dynamicFunction, dynamicFunction],
      [NativeAsyncFunction, dynamicAsyncFunction],
      [dynamicAsyncFunction, dynamicAsyncFunction],
      [NativeGeneratorFunction, dynamicGeneratorFunction],
      [dynamicGeneratorFunction, dynamicGeneratorFunction],
      [NativeAsyncGeneratorFunction, dynamicAsyncGeneratorFunction],
      [dynamicAsyncGeneratorFunction, dynamicAsyncGeneratorFunction]
    ]);
    function dynamicWrapperFor(value) { return dynamicConstructorWrappers.get(value) || null; }
    function dynamicGlobal(name) {
      if (name === 'eval') return dynamicEval;
      if (name === 'Function') return dynamicFunction;
      if (name === 'AsyncFunction') return dynamicAsyncFunction;
      if (name === 'GeneratorFunction') return dynamicGeneratorFunction;
      if (name === 'AsyncGeneratorFunction') return dynamicAsyncGeneratorFunction;
      return null;
    }
    const virtualPrototypeCache = new WeakMap();
    function unwrapRaw(value) {
      try {
        const raw = Native.reflectApply && Native.weakMapGet ? Native.reflectApply(Native.weakMapGet, membraneRawTargets, [value]) : membraneRawTargets.get(value);
        return raw || value;
      } catch {
        return value;
      }
    }
    function virtualPrototypeFor(proto) {
      if (!proto || (typeof proto !== 'object' && typeof proto !== 'function')) return proto;
      if (virtualPrototypeCache.has(proto)) return virtualPrototypeCache.get(proto);
      const safe = Object.create(null);
      const ctor = proto.constructor;
      Object.defineProperty(safe, 'constructor', { value: dynamicWrapperFor(ctor) || dynamicFunction, enumerable: false, configurable: false, writable: false });
      try { Object.freeze(safe); } catch {}
      virtualPrototypeCache.set(proto, safe);
      return safe;
    }
    function shouldVirtualizePrototype(value, proto) {
      if (value == null) return false;
      const t = typeof value;
      if (t !== 'object' && t !== 'function') return true;
      if (typeof proto === 'function') return false;
      const ctor = proto && proto.constructor;
      return ctor === Native.FunctionCtor || ctor === NativeAsyncFunction || ctor === NativeGeneratorFunction || ctor === NativeAsyncGeneratorFunction || dynamicWrapperFor(ctor);
    }
    function safeGetPrototypeOf(value) {
      const raw = unwrapRaw(value);
      const proto = Native.objectGetPrototypeOf(raw);
      return shouldVirtualizePrototype(raw, proto) ? virtualPrototypeFor(proto) : proto;
    }
    if (Native.objectGetPrototypeOf) define(Object, 'getPrototypeOf', safeGetPrototypeOf);
    if (Native.reflectGetPrototypeOf && root.Reflect) define(root.Reflect, 'getPrototypeOf', safeGetPrototypeOf);
    const virtualLocation = Object.freeze({
      get href() { return virtualURL.href; },
      set href(v) { setVirtualLocation(v); },
      get protocol() { return virtualURL.protocol; },
      get host() { return virtualURL.host; },
      get hostname() { return virtualURL.hostname; },
      get port() { return virtualURL.port; },
      get pathname() { return virtualURL.pathname; },
      get search() { return virtualURL.search; },
      get hash() { return virtualURL.hash; },
      set hash(v) { updateVirtualHash(v); },
      get origin() { return virtualURL.origin; },
      assign(v) { setVirtualLocation(v); },
      replace(v) { setVirtualLocation(v, true); },
      reload() { Native.locationReload && Native.locationReload(); },
      toString() { return virtualURL.href; },
      valueOf() { return virtualURL.href; },
      [Symbol.toPrimitive]() { return virtualURL.href; }
    });
    maskMethods(virtualLocation, ['assign','replace','reload','toString','valueOf']);
    function safeCrossWindow(targetWindow) {
      if (!targetWindow || targetWindow === root) return scope;
      if (crossWindowProxyCache.has(targetWindow)) return crossWindowProxyCache.get(targetWindow);
      const proxy = {};
      Object.defineProperties(proxy, {
        window: { get() { return proxy; }, enumerable: true },
        self: { get() { return proxy; }, enumerable: true },
        globalThis: { get() { return proxy; }, enumerable: true },
        top: { get() { return proxy; }, enumerable: true },
        parent: { get() { return proxy; }, enumerable: true },
        frames: { get() { return proxy; }, enumerable: true },
        location: { get() { return virtualLocation; }, enumerable: true },
        postMessage: { value: postMessageWrapperFor(targetWindow), enumerable: true }
      });
      membraneRawTargets.set(proxy, targetWindow);
      crossWindowProxyCache.set(targetWindow, proxy);
      return proxy;
    }
    function virtualWindowProperty(target, prop) {
      if (prop === 'top' || prop === 'parent' || prop === 'opener') {
        try {
          const child = target[prop];
          if (child && child !== target) return safeCrossWindow(child);
        } catch {}
      }
      return scope;
    }
    maskNativeFunction(virtualLocation[Symbol.toPrimitive], Symbol.toPrimitive);
    const scope = new Proxy(root, {
      has(_target, prop) { return prop !== Symbol.unscopables; },
      get(target, prop) {
        if (prop === Symbol.unscopables) return undefined;
        if (prop === 'window' || prop === 'self' || prop === 'globalThis' || prop === 'frames') return scope;
        if (prop === 'top' || prop === 'parent' || prop === 'opener') return virtualWindowProperty(target, prop);
        if (prop === 'location') return virtualLocation;
        if (prop === 'postMessage') return postMessageWrapperFor(target);
        const dynamic = typeof prop === 'symbol' ? null : dynamicGlobal(String(prop));
        if (dynamic) return dynamic;
        if (WINDOW_BOUND_METHODS.has(prop)) return boundWindowMethod(target, prop);
        return target[prop];
      },
      set(target, prop, value) {
        if (prop === 'location') { setVirtualLocation(value); return true; }
        target[prop] = value;
        return true;
      },
      getOwnPropertyDescriptor(target, prop) {
        if (prop === 'location') return { value: virtualLocation, configurable: true, enumerable: true, writable: false };
        return Reflect.getOwnPropertyDescriptor(target, prop);
      }
    });
    membraneRawTargets.set(scope, root);
    function isWindowLike(value) {
      try { return value === root || value === scope || value && value.window === value; } catch { return false; }
    }
    function get(base, prop) {
      if (typeof prop !== 'symbol') prop = String(prop);
      if (base === document && (prop === 'URL' || prop === 'documentURI')) return virtualURL.href;
      if (base === document && prop === 'baseURI') return baseURL;
      if (base === document && prop === 'referrer') return '';
      if (isWindowLike(base)) {
        if (prop === 'window' || prop === 'self' || prop === 'globalThis' || prop === 'frames') return base === scope || base === root ? scope : base;
        if (prop === 'top' || prop === 'parent' || prop === 'opener') return base === scope || base === root ? virtualWindowProperty(root, prop) : base;
        if (prop === 'location') return virtualLocation;
        if (prop === 'postMessage') return postMessageWrapperFor(base === scope ? root : base);
        const dynamic = dynamicGlobal(prop);
        if (dynamic) return dynamic;
      }
      if (base === document && prop === 'defaultView') return scope;
      if (prop === 'postMessage') {
        const fn = Reflect.get(Object(base), prop);
        if (typeof fn === 'function') {
          const bound = fn.bind(base);
          maskNativeFunction(bound, prop);
          return bound;
        }
        return fn;
      }
      if (prop === 'constructor') {
        const ctor = Reflect.get(Object(base), prop);
        return dynamicWrapperFor(ctor) || ctor;
      }
      return Reflect.get(Object(base), prop);
    }
    function set(base, prop, value) {
      if (typeof prop !== 'symbol') prop = String(prop);
      if ((isWindowLike(base) && prop === 'location') || (base === virtualLocation && prop === 'href')) { setVirtualLocation(value); return value; }
      if (base === virtualLocation && prop === 'hash') { updateVirtualHash(value); return value; }
      Reflect.set(Object(base), prop, value);
      return value;
    }
    function assign(base, prop, operator, value) {
      if (typeof prop !== 'symbol') prop = String(prop);
      const current = get(base, prop);
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
        default: throw normalizedError('NotSupportedError');
      }
      return set(base, prop, next);
    }
    function update(base, prop, operator, prefix) {
      if (typeof prop !== 'symbol') prop = String(prop);
      const current = get(base, prop);
      const next = operator === '++' ? current + 1 : current - 1;
      set(base, prop, next);
      return prefix ? next : current;
    }
    function call(base, prop, args) {
      const rawBase = unwrapRaw(base === scope ? root : base);
      const fn = get(base, prop);
      const callArgs = Array.isArray(args) ? args.map(unwrapRaw) : [];
      return Native.reflectApply ? Native.reflectApply(fn, rawBase, callArgs) : Reflect.apply(fn, rawBase, callArgs);
    }
    function construct(ctor, args) {
      const dynamic = dynamicWrapperFor(ctor);
      return Reflect.construct(dynamic || ctor, Array.isArray(args) ? args : []);
    }
    function has(base, prop) { if (isWindowLike(base) && prop === 'location') return true; return Reflect.has(Object(base), prop); }
    function getOwnPropertyDescriptor(base, prop) { if (isWindowLike(base) && prop === 'location') return { value: virtualLocation, configurable: true, enumerable: true, writable: false }; return Reflect.getOwnPropertyDescriptor(Object(base), prop); }
    function ownKeys(base) { return Reflect.ownKeys(Object(base)); }
    function moduleURL(specifier, referrer) {
      const spec = String(specifier);
      if (!spec.startsWith('/') && !spec.startsWith('./') && !spec.startsWith('../') && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec)) throw normalizedError('TypeError');
      const u = new URL(spec, referrer || baseURL);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw normalizedError('NotSupportedError');
      return scriptProxyPath(u.href, 'module');
    }
    define(root, '__zp_get', get);
    define(root, '__zp_set', set);
    define(root, '__zp_assign', assign);
    define(root, '__zp_call', call);
    define(root, '__zp_update', update);
    define(root, '__zp_construct', construct);
    define(root, '__zp_has', has);
    define(root, '__zp_getOwnPropertyDescriptor', getOwnPropertyDescriptor);
    define(root, '__zp_ownKeys', ownKeys);
    define(root, '__zp_module_url', moduleURL);
    define(root, '__zp_nav_assign', v => setVirtualLocation(v));
    define(root, '__zp_nav_replace', v => setVirtualLocation(v, true));
    define(root, '__zp_runClassic', fn => fn.call(root, scope));
    define(root, '__zp_runEvent', (selfValue, event, fn) => fn.call(selfValue, new Proxy(scope, { get(t, p, r) { if (p === 'event') return event; return Reflect.get(t, p, r); } })));
    function rewriteDynamicFunctionBody(params, body) {
      if (root.ZPRewriter && typeof root.ZPRewriter.rewriteFunctionBody === 'function') {
        const out = root.ZPRewriter.rewriteFunctionBody(String(body || ''), params, virtualURL.href, ZP.CONTROL_PREFIX);
        if (out && out.ok && typeof out.code === 'string') return out.code;
        throw normalizedError('NotSupportedError');
      }
      return rewriteWithPageRewriter(body, 'function');
    }
    function rewriteWithPageRewriter(source, kind) {
      return rewritePageSource(source, kind);
    }
    define(root, 'eval', dynamicEval);
    define(root, 'Function', dynamicFunction);
    for (const [ctor, wrapper] of dynamicConstructorWrappers) {
      if (ctor && ctor.prototype) try { Object.defineProperty(ctor.prototype, 'constructor', { value: wrapper, enumerable: false, configurable: false, writable: false }); } catch {}
    }
    if (Native.setTimeout) define(root, 'setTimeout', function(handler, delay, ...args) { return Native.setTimeout(typeof handler === 'string' ? compileTimerString(handler) : handler, delay, ...args); });
    if (Native.setInterval) define(root, 'setInterval', function(handler, delay, ...args) { return Native.setInterval(typeof handler === 'string' ? compileTimerString(handler) : handler, delay, ...args); });
    if (Native.documentWrite) define(document, 'write', function(...parts) { return Native.documentWrite(parts.map(p => transformHTML(String(p))).join('')); });
    if (Native.documentWriteln) define(document, 'writeln', function(...parts) { return Native.documentWriteln(parts.map(p => transformHTML(String(p))).join('') + '\n'); });
    if (Native.DOMParserParseFromString && root.DOMParser) define(root.DOMParser.prototype, 'parseFromString', function(markup, type) { return Native.DOMParserParseFromString.call(this, String(type).toLowerCase() === 'text/html' ? transformHTML(String(markup)) : markup, type); });
    if (Native.rangeCreateContextualFragment && root.Range) define(root.Range.prototype, 'createContextualFragment', function(markup) { return Native.rangeCreateContextualFragment.call(this, transformHTML(String(markup))); });
  }
  function requestTargetURL(input) {
    const raw = input && typeof input === 'object' && typeof input.url === 'string' ? input.url : String(input);
    const parsed = new URL(raw, baseURL);
    if (parsed.origin === proxyOrigin) return new URL(parsed.pathname + parsed.search + parsed.hash, baseURL).href;
    return ZP.canonicalTargetURL(parsed.href, baseURL).href;
  }
  function replayableBodySize(body) {
    if (body == null) return 0;
    if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
    if (body instanceof ArrayBuffer) return body.byteLength;
    if (ArrayBuffer.isView(body)) return body.byteLength;
    if (Native.Blob && body instanceof Native.Blob) return body.size;
    if (body instanceof URLSearchParams) return new TextEncoder().encode(String(body)).byteLength;
    return null;
  }
  function replayableRequestBody(input, init) {
    if (!init || !Object.prototype.hasOwnProperty.call(init, 'body')) return false;
    const size = replayableBodySize(init.body);
    return size != null && size <= 1024 * 1024;
  }
  function filteredResponseHeaders(resp) {
    const headers = new Native.Headers();
    try {
      resp.headers.forEach((value, key) => {
        if (!String(key).toLowerCase().startsWith('x-zp-response-')) headers.append(key, value);
      });
    } catch {}
    return headers;
  }
  function sameOriginURL(a, b) {
    try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
  }
  function opaqueResponseFacade(resp) {
    if (!resp || !Native.Headers) return resp;
    const emptyHeaders = new Native.Headers();
    const cloneOpaque = () => opaqueResponseFacade(resp.clone());
    return new Proxy(resp, {
      get(target, prop, receiver) {
        if (prop === 'type') return 'opaque';
        if (prop === 'url') return '';
        if (prop === 'redirected') return false;
        if (prop === 'status') return 0;
        if (prop === 'statusText') return '';
        if (prop === 'ok') return false;
        if (prop === 'headers') return emptyHeaders;
        if (prop === 'body') return null;
        if (prop === 'bodyUsed') return false;
        if (prop === 'clone') return cloneOpaque;
        if (prop === 'text') return () => Promise.resolve('');
        if (prop === 'arrayBuffer') return () => Promise.resolve(new ArrayBuffer(0));
        if (prop === 'blob') return () => Promise.resolve(new Blob([]));
        if (prop === 'json') return () => Promise.reject(new SyntaxError('Unexpected end of JSON input'));
        if (prop === 'formData') return () => Promise.reject(normalizedError('TypeError'));
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }
  function responseFacade(resp, fallbackURL) {
    if (!resp || !resp.headers || !Native.Headers) return resp;
    const visibleURL = resp.headers.get('X-ZP-Response-URL') || fallbackURL || resp.url;
    const visibleRedirected = resp.headers.get('X-ZP-Response-Redirected') === '1';
    let visibleHeaders = null;
    const cloneFacade = () => responseFacade(resp.clone(), visibleURL);
    return new Proxy(resp, {
      get(target, prop, receiver) {
        if (prop === 'url') return visibleURL;
        if (prop === 'redirected') return visibleRedirected;
        if (prop === 'headers') return visibleHeaders || (visibleHeaders = filteredResponseHeaders(target));
        if (prop === 'clone') return cloneFacade;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }
  async function fetchThroughRuntime(input, init = {}) {
    if (!Native.fetch || !Native.Request || !Native.Headers) throw normalizedError('NetworkError');
    const target = requestTargetURL(input);
    const req = input && typeof input === 'object' && typeof input.url === 'string' && typeof input.clone === 'function' ? new Native.Request(input, init) : new Native.Request(String(input), init);
    const apiHeaders = new Native.Headers(req.headers);
    apiHeaders.delete('X-ZP-Upload-Replayable');
    apiHeaders.set('X-ZP-Tab-Id', boot.tabId);
    apiHeaders.set('X-ZP-Entry-Id', activeEntryId);
    apiHeaders.set('X-ZP-Runtime-Token', runtimeToken);
    apiHeaders.set('X-ZP-Document-URL', virtualURL.href);
    const requestId = ZP.randomId('req');
    apiHeaders.set('X-ZP-Request-Id', requestId);
    apiHeaders.set('X-ZP-Fetch-Credentials', req.credentials || 'same-origin');
    apiHeaders.set('X-ZP-Fetch-Mode', req.mode || 'cors');
    apiHeaders.set('X-ZP-Fetch-Cache', req.cache || 'default');
    apiHeaders.set('X-ZP-Fetch-Redirect', req.redirect || 'follow');
    apiHeaders.set('X-ZP-Fetch-Referrer', req.referrer || 'about:client');
    apiHeaders.set('X-ZP-Fetch-Referrer-Policy', req.referrerPolicy || documentReferrerPolicy || '');
    apiHeaders.set('X-ZP-Fetch-Integrity', req.integrity || '');
    apiHeaders.set('X-ZP-Fetch-Keepalive', req.keepalive ? '1' : '0');
    if ('priority' in req) {
      try { apiHeaders.set('X-ZP-Fetch-Priority', String(req.priority || '')); } catch {}
    }
    if (replayableRequestBody(input, init)) apiHeaders.set('X-ZP-Upload-Replayable', '1');
    const apiInit = {
      method: req.method,
      headers: apiHeaders,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'follow'
    };
    let abortListener = null;
    let abortPromise = null;
    if (req.signal) {
      abortPromise = new Promise((_, reject) => {
        abortListener = () => {
          postMessageToSW({ type: 'ZP_FETCH_ABORT', tabId: boot.tabId, entryId: activeEntryId, requestId }).catch(()=>{});
          reject(normalizedError('AbortError'));
        };
      });
      if (req.signal.aborted) abortListener();
      else req.signal.addEventListener('abort', abortListener, { once: true });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const opened = openUploadStream(req.body, req.signal);
      const streamId = abortPromise ? await Promise.race([opened, abortPromise]) : await opened;
      if (streamId) apiHeaders.set('X-ZP-Upload-Stream-Id', streamId);
      else {
        apiInit.body = req.body;
        apiInit.duplex = 'half';
      }
    }
    if (req.signal) apiInit.signal = req.signal;
    try {
      const fetchPromise = Native.fetch(ZP.apiPath('fetch') + '?url=' + encodeURIComponent(target), apiInit);
      const resp = abortPromise ? await Promise.race([fetchPromise, abortPromise]) : await fetchPromise;
      if ((req.redirect || 'follow') === 'error' && resp.status === 403) {
        const text = await resp.clone().text().catch(() => '');
        if (/ZeroProxy\s+POLICY_BLOCKED|POLICY_BLOCKED/.test(text)) throw normalizedError('TypeError');
      }
      if ((req.mode || 'cors') === 'no-cors' && !sameOriginURL(virtualURL.href, target)) return opaqueResponseFacade(resp);
      return responseFacade(resp, target);
    } finally {
      if (abortListener && req.signal) {
        try { req.signal.removeEventListener('abort', abortListener); } catch {}
      }
    }
  }
  function fireEvent(target, type) {
    let ev;
    try { ev = new Event(type); } catch { ev = { type }; }
    return target.dispatchEvent(ev);
  }
  function fireProgress(target, type, loaded = 0, total = 0, lengthComputable = false) {
    let ev;
    try { ev = new ProgressEvent(type, { loaded, total, lengthComputable }); } catch { ev = { type, loaded, total, lengthComputable }; }
    return target.dispatchEvent(ev);
  }
  function installHTTPAPIs() {
    if (Native.fetch && Native.Request && Native.Headers) define(root, 'fetch', function fetch(input, init) { return fetchThroughRuntime(input, init); });
    if (Native.XMLHttpRequest && Native.fetch && Native.Request && Native.Headers) {
      const UNSENT = 0, OPENED = 1, HEADERS_RECEIVED = 2, LOADING = 3, DONE = 4;
      function ZPXMLHttpRequest() {
        this.readyState = UNSENT;
        this.response = this.responseText = '';
        this.responseXML = null;
        this._responseType = '';
        this.responseURL = '';
        this.status = 0;
        this.statusText = '';
        this._timeout = 0;
        this._withCredentials = false;
        this.upload = {};
        installEventMethods(this.upload);
        this._headers = [];
        this._responseHeaders = null;
        this._method = 'GET';
        this._url = '';
        this._async = true;
        this._sent = false;
        this._controller = null;
        this._timer = 0;
      }
      function xhrReady(xhr, state) {
        xhr.readyState = state;
        fireEvent(xhr, 'readystatechange');
      }
      function xhrDone(xhr, type) {
        clearTimeout(xhr._timer);
        xhr._timer = 0;
        xhrReady(xhr, DONE);
        fireEvent(xhr, type);
        fireEvent(xhr, 'loadend');
      }
      installEventMethods(ZPXMLHttpRequest.prototype);
      Object.assign(ZPXMLHttpRequest.prototype, {
        constructor: ZPXMLHttpRequest,
        UNSENT, OPENED, HEADERS_RECEIVED, LOADING, DONE,
        open(method, url, async = true, user, password) {
          this.abort();
          this._async = async !== false;
          this._method = String(method || 'GET').toUpperCase();
          const target = new URL(requestTargetURL(url));
          if (user != null) target.username = String(user);
          if (password != null) target.password = String(password);
          this._url = target.href;
          this.responseURL = this._url;
          this._headers = [];
          this._responseHeaders = null;
          this.status = 0;
          this.statusText = '';
          this.response = this.responseText = '';
          this.responseXML = null;
          xhrReady(this, OPENED);
        },
        setRequestHeader(name, value) {
          if (this.readyState !== OPENED || this._sent) throw normalizedError('InvalidStateError');
          this._headers.push([String(name), String(value)]);
        },
        send(body = null) {
          if (this.readyState !== OPENED || this._sent) throw normalizedError('InvalidStateError');
          if (!this._async) return sendSyncXHR(this, body);
          this._sent = true;
          this._controller = new AbortController();
          const init = { method: this._method, headers: this._headers, credentials: this._withCredentials ? 'include' : 'same-origin', signal: this._controller.signal };
          if (body != null && this._method !== 'GET' && this._method !== 'HEAD') init.body = body;
          fireEvent(this, 'loadstart');
          if (body != null && this.upload && this.upload.dispatchEvent) {
            const total = uploadBodySize(body);
            fireProgress(this.upload, 'loadstart', 0, total || 0, total != null);
            fireProgress(this.upload, 'progress', total || 0, total || 0, total != null);
            fireProgress(this.upload, 'load', total || 0, total || 0, total != null);
            fireProgress(this.upload, 'loadend', total || 0, total || 0, total != null);
          }
          if (this._timeout > 0) this._timer = setTimeout(() => { try { this._controller.abort(); } catch {} this._sent = false; xhrDone(this, 'timeout'); }, this._timeout);
          fetchThroughRuntime(this._url, init).then(async resp => {
            if (!this._sent) return;
            this.status = resp.status;
            this.statusText = resp.statusText;
            this._responseHeaders = resp.headers;
            xhrReady(this, HEADERS_RECEIVED);
            xhrReady(this, LOADING);
            if (this._responseType === 'arraybuffer') this.response = await resp.arrayBuffer();
            else if (this._responseType === 'blob') this.response = await resp.blob();
            else if (this._responseType === 'json') { const text = await resp.text(); try { this.response = text ? JSON.parse(text) : null; } catch { this.response = null; } }
            else if (resp.body && resp.body.getReader) {
              const reader = resp.body.getReader();
              const decoder = new TextDecoder();
              const total = Number(resp.headers.get('Content-Length') || 0);
              let loaded = 0;
              for (;;) {
                const part = await reader.read();
                if (part.done) break;
                loaded += part.value && part.value.byteLength || 0;
                this.responseText += decoder.decode(part.value, { stream: true });
                this.response = this.responseText;
                xhrReady(this, LOADING);
                fireProgress(this, 'progress', loaded, total, total > 0);
              }
              this.responseText += decoder.decode();
              this.response = this.responseText;
              this.responseXML = parseXHRResponseXML(this, this.responseText);
              if (this._responseType === 'document') this.response = this.responseXML;
            }
            else { this.responseText = await resp.text(); this.response = this.responseText; this.responseXML = parseXHRResponseXML(this, this.responseText); if (this._responseType === 'document') this.response = this.responseXML; fireProgress(this, 'progress', this.responseText.length, this.responseText.length, true); }
            this._sent = false;
            xhrDone(this, 'load');
          }).catch(() => {
            if (!this._sent) return;
            this._sent = false;
            this.status = 0;
            this.statusText = '';
            xhrDone(this, 'error');
          });
        },
        abort() {
          if (this._controller) { try { this._controller.abort(); } catch {} }
          clearTimeout(this._timer);
          this._timer = 0;
          const active = this._sent;
          this._sent = false;
          this._controller = null;
          if (active) xhrDone(this, 'abort');
        },
        getResponseHeader(name) { return this._responseHeaders ? this._responseHeaders.get(String(name)) : null; },
        getAllResponseHeaders() { if (!this._responseHeaders) return ''; let out = ''; this._responseHeaders.forEach((v, k) => { out += k + ': ' + v + '\r\n'; }); return out; },
        overrideMimeType() {}
      });
      function syncXHRBody(body) {
        if (body == null) return null;
        if (typeof body === 'string' || body instanceof Native.Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof FormData || body instanceof URLSearchParams) return body;
        return String(body);
      }
      function uploadBodySize(body) {
        if (body == null) return 0;
        if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
        if (body instanceof ArrayBuffer) return body.byteLength;
        if (ArrayBuffer.isView(body)) return body.byteLength;
        if (Native.Blob && body instanceof Native.Blob) return body.size;
        if (body instanceof URLSearchParams) return new TextEncoder().encode(String(body)).byteLength;
        return null;
      }
      function syncHeadersFromXHR(nativeXHR) {
        const h = new Native.Headers();
        const raw = nativeXHR.getAllResponseHeaders && nativeXHR.getAllResponseHeaders() || '';
        String(raw).split(/\r?\n/).forEach(line => {
          const idx = line.indexOf(':');
          if (idx > 0) h.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
        });
        return h;
      }
      function parseXHRResponseXML(xhr, text) {
        const parser = root.DOMParser;
        if (!parser || typeof parser !== 'function') return null;
        const contentType = xhr._responseHeaders && xhr._responseHeaders.get('content-type') || '';
        const wantsDocument = xhr._responseType === 'document';
        const xmlish = /\b(?:application|text)\/(?:[\w.+-]+\+)?xml\b/i.test(contentType) || /\+xml\b/i.test(contentType);
        const htmlish = /\btext\/html\b/i.test(contentType);
        if (!wantsDocument && !xmlish) return null;
        try {
          return new parser().parseFromString(String(text || ''), htmlish ? 'text/html' : 'application/xml');
        } catch {
          return null;
        }
      }
      function setXHRResponseType(xhr, value) {
        const s = String(value || '');
        const normalized = s === 'arraybuffer' || s === 'blob' || s === 'document' || s === 'json' || s === 'text' ? s : '';
        if (xhr.readyState === LOADING || xhr.readyState === DONE) throw normalizedError('InvalidStateError');
        if (!xhr._async && normalized && normalized !== 'text') throw normalizedError('InvalidAccessError');
        xhr._responseType = normalized;
      }
      function setXHRTimeout(xhr, value) {
        const n = Math.max(0, Number(value) || 0);
        if (!xhr._async && n !== 0) throw normalizedError('InvalidAccessError');
        xhr._timeout = n;
      }
      function setXHRWithCredentials(xhr, value) {
        if (xhr.readyState !== UNSENT && xhr.readyState !== OPENED || xhr._sent) throw normalizedError('InvalidStateError');
        xhr._withCredentials = !!value;
      }
      function sendSyncXHR(xhr, body) {
        if (xhr._timeout) throw normalizedError('InvalidAccessError');
        if (xhr._responseType && xhr._responseType !== 'text') throw normalizedError('InvalidAccessError');
        xhr._sent = true;
        fireEvent(xhr, 'loadstart');
        const nativeXHR = new Native.XMLHttpRequest();
        nativeXHR.open(xhr._method, ZP.apiPath('fetch') + '?url=' + encodeURIComponent(xhr._url), false);
        nativeXHR.setRequestHeader('X-ZP-Tab-Id', boot.tabId);
        nativeXHR.setRequestHeader('X-ZP-Entry-Id', activeEntryId);
        nativeXHR.setRequestHeader('X-ZP-Runtime-Token', runtimeToken);
        nativeXHR.setRequestHeader('X-ZP-Document-URL', virtualURL.href);
        nativeXHR.setRequestHeader('X-ZP-Fetch-Credentials', xhr._withCredentials ? 'include' : 'same-origin');
        nativeXHR.setRequestHeader('X-ZP-Fetch-Mode', 'cors');
        nativeXHR.setRequestHeader('X-ZP-Fetch-Redirect', 'follow');
        nativeXHR.setRequestHeader('X-ZP-Fetch-Referrer', virtualURL.href);
        nativeXHR.setRequestHeader('X-ZP-Fetch-Referrer-Policy', '');
        if (replayableBodySize(body) != null && replayableBodySize(body) <= 1024 * 1024) nativeXHR.setRequestHeader('X-ZP-Upload-Replayable', '1');
        for (const [name, value] of xhr._headers) nativeXHR.setRequestHeader(name, value);
        try {
          nativeXHR.send(xhr._method === 'GET' || xhr._method === 'HEAD' ? null : syncXHRBody(body));
          if (nativeXHR.status === 403 && /ZeroProxy POLICY_BLOCKED/.test(nativeXHR.responseText || '')) throw normalizedError('NetworkError');
          xhr.status = nativeXHR.status;
          xhr.statusText = nativeXHR.statusText;
          xhr.responseURL = xhr._url;
          xhr._responseHeaders = syncHeadersFromXHR(nativeXHR);
          xhrReady(xhr, HEADERS_RECEIVED);
          xhrReady(xhr, LOADING);
          xhr.responseText = nativeXHR.responseText || '';
          xhr.response = xhr.responseText;
          xhr.responseXML = parseXHRResponseXML(xhr, xhr.responseText);
          if (xhr._responseType === 'document') xhr.response = xhr.responseXML;
          xhr._sent = false;
          xhrDone(xhr, 'load');
        } catch {
          xhr.status = 0;
          xhr.statusText = '';
          xhr._sent = false;
          xhrDone(xhr, 'error');
        }
      }
      Object.defineProperties(ZPXMLHttpRequest.prototype, {
        responseType: { configurable: true, enumerable: true, get() { return this._responseType || ''; }, set(value) { setXHRResponseType(this, value); } },
        timeout: { configurable: true, enumerable: true, get() { return this._timeout || 0; }, set(value) { setXHRTimeout(this, value); } },
        withCredentials: { configurable: true, enumerable: true, get() { return !!this._withCredentials; }, set(value) { setXHRWithCredentials(this, value); } }
      });
      maskMethods(ZPXMLHttpRequest.prototype, ['open','setRequestHeader','send','abort','getResponseHeader','getAllResponseHeaders','overrideMimeType']);
      define(root, 'XMLHttpRequest', ZPXMLHttpRequest);
    }
    if (Native.EventSource && Native.fetch && Native.Request && Native.Headers) {
      const CONNECTING = 0, OPEN = 1, CLOSED = 2;
      function ZPEventSource(url, init = {}) {
        this.url = requestTargetURL(url);
        this.withCredentials = !!(init && init.withCredentials);
        this.readyState = CONNECTING;
        this._closed = false;
        this._controller = new AbortController();
        runEventSource(this, url, init || {});
      }
      installEventMethods(ZPEventSource.prototype);
      Object.assign(ZPEventSource.prototype, {
        constructor: ZPEventSource,
        CONNECTING, OPEN, CLOSED,
        close() {
          this._closed = true;
          this.readyState = CLOSED;
          try { this._controller.abort(); } catch {}
        }
      });
      maskMethods(ZPEventSource.prototype, ['close']);
      define(root, 'EventSource', ZPEventSource);
      function runEventSource(es, url, init) {
        fetchThroughRuntime(url, { method: 'GET', headers: [['Accept', 'text/event-stream']], credentials: init.withCredentials ? 'include' : 'same-origin', cache: 'no-store', signal: es._controller.signal }).then(async resp => {
          if (!resp.ok) throw normalizedError('NetworkError');
          if (es._closed) return;
          es.readyState = OPEN;
          fireEvent(es, 'open');
          if (!resp.body || !resp.body.getReader) {
            consumeSSE(es, await resp.text(), true);
            return;
          }
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            buf = consumeSSE(es, buf + decoder.decode(part.value, { stream: true }), false);
          }
          consumeSSE(es, buf + decoder.decode(), true);
        }).catch(() => {
          if (es._closed) return;
          es.readyState = CLOSED;
          fireEvent(es, 'error');
        });
      }
      function consumeSSE(es, text, final) {
        let buf = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          dispatchSSE(es, buf.slice(0, idx));
          buf = buf.slice(idx + 2);
        }
        if (final && buf) {
          dispatchSSE(es, buf);
          return '';
        }
        return buf;
      }
      function dispatchSSE(es, block) {
        if (es._closed) return;
        let data = '', eventType = 'message', lastEventId = '';
        for (const line of String(block).split('\n')) {
          if (!line || line[0] === ':') continue;
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? '' : line.slice(colon + 1);
          if (value[0] === ' ') value = value.slice(1);
          if (field === 'data') data += value + '\n';
          else if (field === 'event') eventType = value || 'message';
          else if (field === 'id') lastEventId = value;
        }
        if (!data) return;
        data = data.slice(0, -1);
        let ev;
        try { ev = new MessageEvent(eventType, { data, origin: new URL(es.url).origin, lastEventId }); }
        catch { ev = new Event(eventType); try { Object.defineProperties(ev, { data: { value: data }, origin: { value: new URL(es.url).origin }, lastEventId: { value: lastEventId } }); } catch {} }
        es.dispatchEvent(ev);
      }
    }
  }
  function installWebSocket() {
    const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
    const tokenRE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
    function protocolList(protocols) {
      if (protocols == null) return [];
      const list = typeof protocols === 'string' ? [protocols] : Array.isArray(protocols) ? protocols.slice() : null;
      if (!list) throw normalizedError('SyntaxError');
      const out = [];
      const seen = new Set();
      for (const p of list) {
        const s = String(p);
        if (!s || !tokenRE.test(s) || seen.has(s)) throw normalizedError('SyntaxError');
        seen.add(s);
        out.push(s);
      }
      return out;
    }
    function closeEvent(code, reason, wasClean) {
      try { return new CloseEvent('close', { code, reason, wasClean }); }
      catch { const ev = new Event('close'); try { Object.defineProperties(ev, { code: { value: code }, reason: { value: reason }, wasClean: { value: wasClean } }); } catch {} return ev; }
    }
    function finish(ws, code, reason, wasClean) {
      if (ws._closed) return;
      ws._closed = true;
      ws.readyState = CLOSED;
      ws.dispatchEvent(closeEvent(code || 1000, reason || '', wasClean !== false));
    }
    function fail(ws) {
      if (ws._closed) return;
      ws.dispatchEvent(new Event('error'));
      finish(ws, 1006, '', false);
    }
    function ZPWebSocket(url, protocols) {
      if (arguments.length < 1) throw new TypeError("Failed to construct 'WebSocket': 1 argument required, but only 0 present.");
      this.url = targetWSURL(url);
      this.protocol = '';
      this.extensions = '';
      this.readyState = CONNECTING;
      this.bufferedAmount = 0;
      this.binaryType = 'blob';
      this._port = null;
      this._closed = false;
      const plist = protocolList(protocols);
      postMessageToSW({ type: 'ZP_WS_OPEN', url: this.url, protocols: plist, tabId: boot.tabId, documentUrl: virtualURL.href }).then(reply => {
        if (this._closed) { try { reply.port && reply.port.postMessage({ type: 'close' }); } catch {} return; }
        this.protocol = String(reply.protocol || '');
        this._port = reply.port;
        this._port.onmessage = ev => {
          const m = ev.data || {};
          if (m.type === 'message') {
            let data = m.data;
            if (this.binaryType === 'blob' && data instanceof ArrayBuffer && Native.Blob) data = new Native.Blob([data]);
            this.dispatchEvent(new MessageEvent('message', { data, origin: new URL(this.url).origin }));
          } else if (m.type === 'error') {
            fail(this);
          } else if (m.type === 'close') {
            finish(this, m.code || 1000, m.reason || '', true);
          }
        };
        this._port.start && this._port.start();
        this.readyState = OPEN;
        this.dispatchEvent(new Event('open'));
      }).catch(() => fail(this));
    }
    ZPWebSocket.CONNECTING = CONNECTING; ZPWebSocket.OPEN = OPEN; ZPWebSocket.CLOSING = CLOSING; ZPWebSocket.CLOSED = CLOSED;
    ZPWebSocket.prototype = { CONNECTING, OPEN, CLOSING, CLOSED };
    installEventMethods(ZPWebSocket.prototype);
    Object.assign(ZPWebSocket.prototype, {
      constructor: ZPWebSocket,
      send(data) {
        if (this.readyState !== OPEN || !this._port) throw normalizedError('InvalidStateError');
        if (Native.Blob && data instanceof Native.Blob) {
          data.arrayBuffer().then(buf => { if (this.readyState === OPEN && this._port) this._port.postMessage({ type: 'send', data: buf }); }).catch(() => fail(this));
          return;
        }
        this._port.postMessage({ type: 'send', data });
      },
      close(code = 1000, reason = '') {
        if (this._closed || this.readyState === CLOSING || this.readyState === CLOSED) return;
        this.readyState = CLOSING;
        if (this._port) this._port.postMessage({ type: 'close', code, reason });
        finish(this, code, reason, true);
      }
    });
    define(root, 'WebSocket', ZPWebSocket);
  }

  function installWebSocketStream() {
    if (!root.WebSocket || !root.ReadableStream || !root.WritableStream) return;
    function ZPWebSocketStream(url, options = {}) {
      if (!(this instanceof ZPWebSocketStream)) throw new TypeError("Failed to construct 'WebSocketStream': Please use the 'new' operator.");
      let closeResolve;
      this.closed = new Promise(resolve => { closeResolve = resolve; });
      this.opened = new Promise((resolve, reject) => {
        let ws;
        let settled = false;
        let controllerReadable = null;
        const failOpen = err => { if (!settled) { settled = true; reject(err); } };
        try {
          ws = new root.WebSocket(url, options && options.protocols);
          ws.binaryType = 'arraybuffer';
          const readable = new root.ReadableStream({
            start(controller) { controllerReadable = controller; },
            cancel() { try { ws.close(); } catch {} }
          });
          const writable = new root.WritableStream({
            write(chunk) { ws.send(chunk); },
            close() { ws.close(); },
            abort() { ws.close(); }
          });
          ws.onopen = () => { settled = true; resolve({ readable, writable, protocol: ws.protocol, extensions: ws.extensions || '' }); };
          ws.onmessage = event => { if (controllerReadable) controllerReadable.enqueue(event.data); };
          ws.onerror = err => { if (!settled) failOpen(err); else if (controllerReadable) { try { controllerReadable.error(err); } catch {} } };
          ws.onclose = event => {
            if (!settled) failOpen(normalizedError('NetworkError'));
            try { controllerReadable && controllerReadable.close(); } catch {}
            closeResolve({ closeCode: event.code, reason: event.reason });
          };
        } catch (err) {
          failOpen(err);
        }
      });
    }
    try { Object.defineProperty(ZPWebSocketStream, 'name', { value: 'WebSocketStream', configurable: true }); } catch {}
    ZPWebSocketStream.prototype.constructor = ZPWebSocketStream;
    maskNativeFunction(ZPWebSocketStream, 'WebSocketStream');
    define(root, 'WebSocketStream', ZPWebSocketStream);
  }

  function installBeacon() { if (!navigator.sendBeacon || !Native.fetch || !Native.Request || !Native.Headers) return; define(navigator, 'sendBeacon', function sendBeacon(url, data) { try { fetchThroughRuntime(url, { method: 'POST', body: data, keepalive: true, credentials: 'include' }).catch(()=>{}); return true; } catch { return false; } }); }

  function installNavigationTraps() {
    document.addEventListener('click', ev => { const nav = clickNavigationTarget(ev); if (!nav) return; ev.preventDefault(); ev.stopImmediatePropagation(); if (nav.hash != null) updateVirtualHash(nav.hash); else if (nav.href) setVirtualLocation(nav.href); }, true);
    document.addEventListener('submit', ev => { const f = ev.target; if (!f) return; ev.preventDefault(); submitForm(f, ev.submitter); }, true);
    if (Native.formSubmit) define(HTMLFormElement.prototype, 'submit', function() { submitForm(this); });
    if (Native.formRequestSubmit) define(HTMLFormElement.prototype, 'requestSubmit', function(submitter) { submitForm(this, submitter); });
    if (Native.locationAssign) define(Location.prototype, 'assign', function(u) { setVirtualLocation(u); });
    if (Native.locationReplace) define(Location.prototype, 'replace', function(u) { setVirtualLocation(u, true); });
    if (Native.locationReload) define(Location.prototype, 'reload', function() { Native.locationReload(); });
    define(history, 'pushState', function(state, title, url) { return commitVirtualHistory(state, title, url, false); });
    define(history, 'replaceState', function(state, title, url) { return commitVirtualHistory(state, title, url, true); });
    window.addEventListener('popstate', () => { postMessageToSW({ type: 'ZP_RESOLVE_ENTRY', path: activeProxyPath }).then(reply => { activeEntryId = reply.entryId || activeEntryId; virtualURL = new URL(reply.targetUrl); baseURL = reply.baseUrl || virtualURL.href; explicitBaseURL = baseURL !== virtualURL.href ? baseURL : ''; if (typeof reply.scrollX === 'number' && typeof reply.scrollY === 'number') window.scrollTo(reply.scrollX, reply.scrollY); }).catch(()=>{}); }, true);
    let scrollTimer = 0;
    window.addEventListener('scroll', () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(() => postMessageToSW({ type: 'ZP_SCROLL_UPDATE', tabId: boot.tabId, entryId: activeEntryId, scrollX: window.scrollX, scrollY: window.scrollY }).catch(()=>{}), 100); }, { passive: true });
    function submitForm(form, submitter) { submitFormNavigation(form, submitter).catch(() => { Native.locationAssign && Native.locationAssign(ZP.errorPath('TARGET_CONNECT_FAILED')); }); }
    async function submitFormNavigation(form, submitter) {
      const raw = submitter && submitter.getAttribute && submitter.getAttribute('formaction') || form.getAttribute('action') || virtualURL.href;
      const method = String(submitter && submitter.getAttribute && submitter.getAttribute('formmethod') || form.getAttribute('method') || 'GET').toUpperCase();
      if (method === 'DIALOG') return;
      const target = new URL(targetURL(raw));
      urlMeta.set(form, target.href);
      if (method === 'GET') {
        try {
          const data = submitter ? new Native.FormData(form, submitter) : new Native.FormData(form);
          const qs = new URLSearchParams();
          for (const [k, v] of data) qs.append(k, formEntryValue(v));
          const encoded = qs.toString();
          if (encoded) target.search = target.search ? target.search + '&' + encoded : encoded;
        } catch {}
        navigateToTarget(target.href);
        return;
      }
      const body = formRequestBody(form, submitter);
      const reqHeaders = new Native.Headers();
      reqHeaders.set('X-ZP-Document-Request', '1');
      const resp = await fetchThroughRuntime(target.href, { method, body, headers: reqHeaders });
      const html = await resp.text();
      virtualURL = new URL(target.href);
      baseURL = virtualURL.href;
      explicitBaseURL = '';
      try {
        const share = await preactivateRouteFor(target.href, false, target.href);
        activeRouteKey = share.encrypted;
        activeProxyPath = ZP.makeSharePath(share.encrypted);
        activeProxyFragment = shareFragmentForKey(share.key);
      } catch {}
      if (Native.documentOpen) Native.documentOpen();
      if (Native.documentWrite) Native.documentWrite(html);
      if (Native.documentClose) Native.documentClose();
    }
    function formRequestBody(form, submitter) {
      const data = submitter ? new Native.FormData(form, submitter) : new Native.FormData(form);
      const enctype = normalizedFormEncoding(form, submitter);
      if (enctype === 'multipart/form-data') {
        return data;
      }
      const text = enctype === 'text/plain' ? plainFormBody(data) : urlEncodedFormBody(data);
      const type = enctype === 'text/plain' ? 'text/plain;charset=UTF-8' : 'application/x-www-form-urlencoded;charset=UTF-8';
      return new Blob([text], { type });
    }
    function normalizedFormEncoding(form, submitter) {
      const raw = String(submitter && submitter.getAttribute && submitter.getAttribute('formenctype') || form.getAttribute('enctype') || 'application/x-www-form-urlencoded').toLowerCase();
      return raw === 'multipart/form-data' || raw === 'text/plain' ? raw : 'application/x-www-form-urlencoded';
    }
    function formEntryValue(v) { return v && typeof v === 'object' && typeof v.name === 'string' && typeof v.size === 'number' ? v.name : String(v); }
    function urlEncodedFormBody(data) { const qs = new URLSearchParams(); for (const [k, v] of data) qs.append(k, formEntryValue(v)); return qs.toString(); }
    function plainFormBody(data) { const out = []; for (const [k, v] of data) out.push(String(k) + '=' + formEntryValue(v)); return out.join('\r\n'); }
    function clickNavigationTarget(ev) {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return null;
      for (let el = ev.target; el && el !== document; el = el.parentElement) {
        const isAnchor = el.matches && el.matches('a[href],area[href]');
        if (isAnchor) {
          if (el.hasAttribute('download')) return null;
          const target = el.getAttribute('target');
          if (target && target !== '_self') return null;
        }
        const raw = isAnchor ? Native.getAttribute.call(el, 'data-zp-target-url') || el.getAttribute('href') : typeof el.href === 'string' ? el.href : '';
        if (!raw) continue;
        if (raw[0] === '#') return { hash: raw, element: el };
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

  function installPostMessageHooks(w) {
    if (!Native.windowAddEventListener || !Native.windowRemoveEventListener) return;
    function wrap(listener) {
      if (!listener || (typeof listener !== 'function' && typeof listener.handleEvent !== 'function')) return listener;
      if (messageListenerWrappers.has(listener)) return messageListenerWrappers.get(listener);
      const wrapped = function(ev) {
        const next = virtualizeMessageEvent(ev);
        return typeof listener === 'function' ? listener.call(this, next) : listener.handleEvent.call(listener, next);
      };
      messageListenerWrappers.set(listener, wrapped);
      return wrapped;
    }
    define(w, 'addEventListener', function(type, listener, options) {
      return Native.windowAddEventListener(String(type), String(type) === 'message' ? wrap(listener) : listener, options);
    });
    define(w, 'removeEventListener', function(type, listener, options) {
      return Native.windowRemoveEventListener(String(type), String(type) === 'message' ? messageListenerWrappers.get(listener) || listener : listener, options);
    });
    const wrappedPostMessage = postMessageWrapperFor(w);
    if (wrappedPostMessage) define(w, 'postMessage', wrappedPostMessage);
    let onmessage = null;
    defineAccessor(w, 'onmessage', () => onmessage, value => {
      if (onmessage) Native.windowRemoveEventListener('message', messageListenerWrappers.get(onmessage) || onmessage);
      onmessage = typeof value === 'function' ? value : null;
      if (onmessage) Native.windowAddEventListener('message', wrap(onmessage));
    });
  }

  function usesRawURLAttribute(el, key) {
    const tag = el && el.localName;
    const localKey = attrLocalName(key);
    return localKey === 'href' && (tag === 'a' || tag === 'area') || localKey === 'action' && tag === 'form' || localKey === 'formaction' && (tag === 'input' || tag === 'button');
  }
  function isResourceURLAttribute(el, key) {
    const tag = el && el.localName;
    const localKey = attrLocalName(key);
    return localKey === 'src' && (tag === 'img' || tag === 'source' || tag === 'audio' || tag === 'video' || tag === 'track' || tag === 'input') || localKey === 'poster' && tag === 'video' || localKey === 'href' && el && el.namespaceURI === 'http://www.w3.org/2000/svg' && (tag === 'image' || tag === 'use');
  }
  function isSrcsetAttribute(el, key) {
    const tag = el && el.localName;
    return attrLocalName(key) === 'srcset' && (tag === 'img' || tag === 'source');
  }
  function visibleResourceURL(el, attrName) {
    return urlMeta.get(el) || Native.getAttribute.call(el, 'data-zp-target-url') || Native.getAttribute.call(el, attrName) || '';
  }
  function visibleSrcset(el) {
    const stored = Native.getAttribute.call(el, 'data-zp-target-srcset');
    if (stored) return stored;
    const raw = Native.getAttribute.call(el, 'srcset') || '';
    const rewritten = rewriteSrcsetValue(raw);
    return rewritten.changed ? rewritten.visible : raw.replace(/(?:https?:\/\/[^/\s,]+)?\/zp\/api\/fetch\?url=([^\s,]+)/g, (_m, encoded) => {
      try { return decodeURIComponent(encoded); } catch { return _m; }
    });
  }
  function writeAttr(el, ns, name, value) {
    if (ns !== undefined && Native.setAttributeNS) return Native.setAttributeNS.call(el, ns, name, value);
    return Native.setAttribute.call(el, name, value);
  }
  function setResourceURLAttribute(el, attrName, raw, ns) {
    const value = raw == null ? '' : String(raw);
    let target = proxiedFetchTarget(value);
    if (!target) {
      if (hasDangerousURLScheme(value)) return blockExecutableURL(el, attrLocalName(attrName), value);
      if (!isHTTPURL(value)) return writeAttr(el, ns, attrName, value);
      try { target = targetURL(value); } catch { return blockExecutableURL(el, attrLocalName(attrName), value); }
    }
    urlMeta.set(el, target);
    if (Native.getAttribute.call(el, 'data-zp-target-url') !== target) Native.setAttribute.call(el, 'data-zp-target-url', target);
    return writeAttr(el, ns, attrName, resourceProxyPath(target));
  }
  function setSrcsetAttribute(el, attrName, raw, ns) {
    const rewritten = rewriteSrcsetValue(raw);
    if (!rewritten.changed) return writeAttr(el, ns, attrName, String(raw || ''));
    Native.setAttribute.call(el, 'data-zp-target-srcset', rewritten.visible);
    return writeAttr(el, ns, attrName, rewritten.actual);
  }
  function installGetterMasking(w) {
    const locGet = p => () => new URL(virtualURL.href)[p];
    for (const p of ['href','protocol','host','hostname','port','pathname','search','hash','origin']) defineAccessor(w.Location && w.Location.prototype, p, locGet(p), p === 'href' ? v => { setVirtualLocation(v); } : p === 'hash' ? v => { updateVirtualHash(v); } : undefined);
    define(w.Location && w.Location.prototype, 'toString', function(){ return virtualURL.href; });
    defineAccessor(w.Document && w.Document.prototype, 'URL', () => virtualURL.href);
    defineAccessor(w.Document && w.Document.prototype, 'documentURI', () => virtualURL.href);
    defineAccessor(w.Document && w.Document.prototype, 'baseURI', () => baseURL);
    defineAccessor(w.Document && w.Document.prototype, 'referrer', () => '');
    defineAccessor(w.Document && w.Document.prototype, 'cookie', () => documentCookieString(), v => { const s = String(v); setDocumentCookie(s); postMessageToSW({ type: 'ZP_COOKIE_SET', tabId: boot.tabId, targetUrl: virtualURL.href, cookie: s }).catch(()=>{}); });
    installURLProp(w.HTMLAnchorElement && w.HTMLAnchorElement.prototype, 'href');
    installURLProp(w.HTMLAreaElement && w.HTMLAreaElement.prototype, 'href');
    installURLProp(w.HTMLFormElement && w.HTMLFormElement.prototype, 'action');
    installURLProp(w.HTMLInputElement && w.HTMLInputElement.prototype, 'formAction');
    installURLProp(w.HTMLButtonElement && w.HTMLButtonElement.prototype, 'formAction');
    function installURLProp(proto, prop) { if (!proto) return; defineAccessor(proto, prop, function(){ return urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url') || targetURL(this.getAttribute(prop === 'formAction' ? 'formaction' : prop) || virtualURL.href); }, function(v){ const t = targetURL(v); urlMeta.set(this, t); Native.setAttribute.call(this, 'data-zp-target-url', t); this.setAttribute(prop === 'formAction' ? 'formaction' : prop, t); }); }
  }
  function initDocumentCookieRecords(cookieString) {
    documentCookieRecords.splice(0, documentCookieRecords.length);
    for (const part of String(cookieString || '').split(/;\s*/)) {
      const eq = part.indexOf('=');
      if (eq > 0) documentCookieRecords.push({ name: part.slice(0, eq), value: part.slice(eq + 1), domain: virtualURL.hostname.toLowerCase(), hostOnly: true, path: '/', secure: virtualURL.protocol === 'https:', sameSite: 'Unspecified', expires: Infinity });
    }
    documentCookie = documentCookieString();
  }
  function syncDocumentCookieRecords(records, sourceUrl) {
    let source;
    try { source = new URL(sourceUrl || virtualURL.href); } catch { source = virtualURL; }
    const sourceHost = source.hostname.toLowerCase();
    const sourceSecure = source.protocol === 'https:';
    for (let i = documentCookieRecords.length - 1; i >= 0; i--) {
      const r = documentCookieRecords[i];
      if ((r.hostOnly ? r.domain === sourceHost : sourceHost === r.domain || sourceHost.endsWith('.' + r.domain)) && (!r.secure || sourceSecure)) documentCookieRecords.splice(i, 1);
    }
    const now = Date.now();
    for (const raw of Array.isArray(records) ? records : []) {
      if (!raw || typeof raw.name !== 'string' || raw.name === '') continue;
      const domain = String(raw.domain || sourceHost).replace(/^\./, '').toLowerCase();
      const rec = {
        name: raw.name,
        value: String(raw.value || ''),
        domain,
        hostOnly: raw.hostOnly !== false,
        path: String(raw.path || '/').startsWith('/') ? String(raw.path || '/') : '/',
        secure: !!raw.secure,
        sameSite: normalizeSameSite(raw.sameSite),
        expires: typeof raw.expiresMs === 'number' ? raw.expiresMs : Infinity
      };
      if (rec.expires <= now) continue;
      documentCookieRecords.push(rec);
    }
    documentCookie = documentCookieString();
  }
  function setDocumentCookie(line) {
    const parts = String(line).split(';').map(p => p.trim()).filter(Boolean);
    if (!parts.length) return;
    const eq = parts[0].indexOf('=');
    if (eq <= 0) return;
    const rec = { name: parts[0].slice(0, eq), value: parts[0].slice(eq + 1), domain: virtualURL.hostname.toLowerCase(), hostOnly: true, path: defaultCookiePath(), secure: false, sameSite: 'Unspecified', expires: Infinity };
    for (let i = 1; i < parts.length; i++) {
      const [rawK, ...rest] = parts[i].split('=');
      const k = rawK.toLowerCase();
      const v = rest.join('=');
      if (k === 'domain' && v) { const d = v.replace(/^\./, '').toLowerCase(); if (virtualURL.hostname.toLowerCase() === d || virtualURL.hostname.toLowerCase().endsWith('.' + d)) { rec.domain = d; rec.hostOnly = false; } }
      else if (k === 'path' && v && v[0] === '/') rec.path = v;
      else if (k === 'secure') rec.secure = true;
      else if (k === 'samesite') rec.sameSite = normalizeSameSite(v);
      else if (k === 'max-age') rec.expires = Date.now() + Math.max(0, Number(v) || 0) * 1000;
      else if (k === 'expires') { const ts = Date.parse(v); if (!Number.isNaN(ts)) rec.expires = ts; }
    }
    if (rec.sameSite === 'None' && !rec.secure) return;
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
  function normalizeSameSite(value) {
    const v = String(value || '').toLowerCase();
    if (v === 'lax') return 'Lax';
    if (v === 'strict') return 'Strict';
    if (v === 'none') return 'None';
    return 'Unspecified';
  }
  function defaultCookiePath() { const p = virtualURL.pathname || '/'; const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
  function installCookieSync() {
    const sw = navigator.serviceWorker;
    if (!sw || !sw.addEventListener) return;
    sw.addEventListener('message', ev => {
      const msg = ev && ev.data || {};
      if (msg.type !== 'ZP_COOKIE_SYNC') return;
      if (msg.tabId && msg.tabId !== boot.tabId) return;
      if (msg.targetUrl) {
        try {
          const u = new URL(msg.targetUrl);
          if (u.origin !== virtualURL.origin) return;
        } catch { return; }
      }
      if (Array.isArray(msg.cookieRecords)) syncDocumentCookieRecords(msg.cookieRecords, msg.targetUrl);
      else if (typeof msg.cookieString === 'string') initDocumentCookieRecords(msg.cookieString);
    });
  }

  function installStorageFacades(w) {
    const prefix = storagePrefixForVirtualOrigin();
    const localKey = prefix + 'local';
    const sessionKey = prefix + 'session';
    const local = storageObject(localKey, w);
    const session = storageObject(sessionKey, w);
    storageWindows.add({ w, localKey, sessionKey });
    defineAccessor(w, 'localStorage', () => local);
    defineAccessor(w, 'sessionStorage', () => session);
    if (w.indexedDB) {
      const nativeIDB = w.indexedDB;
      define(w, 'indexedDB', {
        open(name, version) { return nativeIDB.open(prefix + 'idb:' + String(name), version); },
        deleteDatabase(name) { return nativeIDB.deleteDatabase(prefix + 'idb:' + String(name)); },
        cmp: nativeIDB.cmp ? nativeIDB.cmp.bind(nativeIDB) : undefined,
        databases: nativeIDB.databases ? () => nativeIDB.databases().then(list => list.filter(db => db.name && db.name.startsWith(prefix + 'idb:')).map(db => Object.assign({}, db, { name: db.name.slice((prefix + 'idb:').length) }))) : undefined
      });
    }
    if (w.caches) {
      const nativeCaches = w.caches;
      define(w, 'caches', {
        open(name) { return nativeCaches.open(prefix + 'cache:' + String(name)); },
        delete(name) { return nativeCaches.delete(prefix + 'cache:' + String(name)); },
        has(name) { return nativeCaches.has(prefix + 'cache:' + String(name)); },
        keys() { return nativeCaches.keys().then(keys => keys.filter(k => k.startsWith(prefix + 'cache:')).map(k => k.slice((prefix + 'cache:').length))); },
        match(request, opts) { return nativeCaches.keys().then(keys => keys.filter(k => k.startsWith(prefix + 'cache:'))).then(async keys => { for (const k of keys) { const hit = await (await nativeCaches.open(k)).match(request, opts); if (hit) return hit; } return undefined; }); }
      });
    }
  }
  function storagePrefixForVirtualOrigin() { return 'zp:' + virtualURL.origin + ':'; }
  function storageMap(key) {
    let map = storageMaps.get(key);
    if (!map) {
      map = new Map();
      storageMaps.set(key, map);
      loadStorageMirror(key, map);
      loadPersistentStorage(key, map).then(() => saveStorageMirror(key, map)).catch(()=>{});
    }
    return map;
  }
  function storageObject(namespaceKey, ownerWindow) {
    const map = storageMap(namespaceKey);
    return Object.freeze({
      get length() { return map.size; },
      key(i) { return Array.from(map.keys())[Number(i)] || null; },
      getItem(k) { k = String(k); return map.has(k) ? map.get(k) : null; },
      setItem(k, v) { k = String(k); v = String(v); const oldValue = map.has(k) ? map.get(k) : null; map.set(k, v); markStorageDirty(namespaceKey, k); saveStorageMirror(namespaceKey, map); persistStorageValue(namespaceKey, k, v).catch(()=>{}); dispatchStorageEvents(namespaceKey, ownerWindow, k, oldValue, v); },
      removeItem(k) { k = String(k); const oldValue = map.has(k) ? map.get(k) : null; map.delete(k); markStorageDirty(namespaceKey, k); saveStorageMirror(namespaceKey, map); deletePersistentStorageValue(namespaceKey, k).catch(()=>{}); dispatchStorageEvents(namespaceKey, ownerWindow, k, oldValue, null); },
      clear() { if (!map.size) return; map.clear(); markStorageDirty(namespaceKey, '*'); saveStorageMirror(namespaceKey, map); clearPersistentStorage(namespaceKey).catch(()=>{}); dispatchStorageEvents(namespaceKey, ownerWindow, null, null, null); }
    });
  }
  function storageMirrorKey(namespace) { return 'zp:idb-mirror:' + namespace; }
  function loadStorageMirror(namespace, map) {
    const store = Native.localStorage;
    if (!store) return;
    try {
      const raw = store.getItem(storageMirrorKey(namespace));
      const items = raw && JSON.parse(raw);
      if (!Array.isArray(items)) return;
      for (const pair of items) {
        if (Array.isArray(pair) && typeof pair[0] === 'string') map.set(pair[0], String(pair[1]));
      }
    } catch {}
  }
  function saveStorageMirror(namespace, map) {
    const store = Native.localStorage;
    if (!store) return;
    try {
      store.setItem(storageMirrorKey(namespace), JSON.stringify(Array.from(map.entries())));
    } catch {}
  }
  function markStorageDirty(namespace, key) {
    let keys = storageDirtyKeys.get(namespace);
    if (!keys) {
      keys = new Set();
      storageDirtyKeys.set(namespace, keys);
    }
    keys.add(String(key));
  }
  function isStorageDirty(namespace, key) {
    const keys = storageDirtyKeys.get(namespace);
    return !!keys && (keys.has('*') || keys.has(String(key)));
  }
  function storageDB() {
    if (!Native.indexedDB) return Promise.reject(normalizedError('NotSupportedError'));
    if (storageDBPromise) return storageDBPromise;
    storageDBPromise = new Promise((resolve, reject) => {
      const req = Native.indexedDB.open('zeroproxy-storage-v1', 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore('kv', { keyPath: ['namespace', 'key'] }); } catch {} };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || normalizedError('UnknownError'));
    });
    return storageDBPromise;
  }
  async function loadPersistentStorage(namespace, map) {
    const db = await storageDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const store = tx.objectStore('kv');
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const rec = cursor.value;
        if (rec && rec.namespace === namespace && typeof rec.key === 'string' && !isStorageDirty(namespace, rec.key)) map.set(rec.key, String(rec.value));
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || normalizedError('UnknownError'));
    });
  }
  async function persistStorageValue(namespace, key, value) {
    const db = await storageDB();
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put({ namespace, key, value });
  }
  async function deletePersistentStorageValue(namespace, key) {
    const db = await storageDB();
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete([namespace, key]);
  }
  async function clearPersistentStorage(namespace) {
    const db = await storageDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        if (cursor.value && cursor.value.namespace === namespace) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || normalizedError('UnknownError'));
    });
  }
  function dispatchStorageEvents(namespaceKey, sourceWindow, key, oldValue, newValue) {
    for (const rec of Array.from(storageWindows)) {
      const w = rec.w;
      if (!w || w === sourceWindow || (rec.localKey !== namespaceKey && rec.sessionKey !== namespaceKey)) continue;
      try {
        const ev = new w.StorageEvent('storage', { key, oldValue, newValue, url: virtualURL.href });
        w.dispatchEvent(ev);
      } catch { try { w.dispatchEvent(new Event('storage')); } catch {} }
    }
  }
  function attrLocalName(key) {
    const s = String(key || '').toLowerCase();
    const i = s.indexOf(':');
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function tokenListContains(list, token) {
    return String(list || '').toLowerCase().split(/[\s,]+/).includes(token);
  }
  function isBlockedLinkRelValue(rel) {
    for (const token of ['modulepreload','preload','prefetch','preconnect','dns-prefetch','prerender','manifest']) {
      if (tokenListContains(rel, token)) return true;
    }
    return false;
  }
	  function isIconLinkRelValue(rel) {
	    for (const token of String(rel || '').toLowerCase().split(/[\s,]+/)) {
	      if (token === 'icon' || token === 'mask-icon' || token === 'apple-touch-icon' || token === 'apple-touch-icon-precomposed' || token === 'apple-touch-startup-image' || token === 'fluid-icon') return true;
	    }
	    return false;
	  }
	  function isStylesheetLinkRelValue(rel) {
	    for (const token of String(rel || '').toLowerCase().split(/[\s,]+/)) if (token === 'stylesheet') return true;
	    return false;
	  }
	  function isBlockedLink(el) { return el && el.localName === 'link' && isBlockedLinkRelValue(Native.getAttribute.call(el, 'rel') || ''); }
	  function isIconLink(el) { return el && el.localName === 'link' && isIconLinkRelValue(Native.getAttribute.call(el, 'rel') || ''); }
	  function isStylesheetLink(el) { return el && el.localName === 'link' && isStylesheetLinkRelValue(Native.getAttribute.call(el, 'rel') || ''); }
	  function hasSuppressedBlockedLinkRel(el) { return el && el.localName === 'link' && isBlockedLinkRelValue(Native.getAttribute.call(el, 'data-zp-blocked-rel') || ''); }
	  function visibleLinkTarget(el) { return urlMeta.get(el) || Native.getAttribute.call(el, 'data-zp-target-url') || ''; }
	  function proxiedFetchTarget(raw) {
	    try {
	      const u = new URL(String(raw || ''), proxyOrigin);
	      if (u.pathname === ZP.apiPath('fetch')) return u.searchParams.get('url') || '';
	    } catch {}
	    return '';
	  }
	  function setStylesheetLinkHref(el, raw) {
	    const value = raw == null ? '' : String(raw);
	    let target = proxiedFetchTarget(value);
	    if (!target) {
	      if (hasDangerousURLScheme(value)) return blockLinkURL(el, value);
	      if (!isHTTPURL(value)) return Native.setAttribute.call(el, 'href', value);
	      target = targetURL(value);
	    }
	    urlMeta.set(el, target);
	    if (Native.getAttribute.call(el, 'data-zp-target-url') !== target) Native.setAttribute.call(el, 'data-zp-target-url', target);
	    const proxied = resourceProxyPath(target);
	    if (Native.getAttribute.call(el, 'href') !== proxied) Native.setAttribute.call(el, 'href', proxied);
	  }
	  function suppressBlockedLinkRel(el, rawRel) {
    Native.setAttribute.call(el, 'data-zp-blocked-rel', String(rawRel));
    if (Native.removeAttribute) Native.removeAttribute.call(el, 'rel');
    blockLinkURL(el, Native.getAttribute.call(el, 'href') || '');
  }
  function blockLinkURL(el, raw) {
    if (raw != null && String(raw) !== '') Native.setAttribute.call(el, 'data-zp-blocked-url', String(raw));
    urlMeta.delete(el);
    if (Native.removeAttribute) Native.removeAttribute.call(el, 'href');
  }
  function suppressIconLinkHref(el, raw) {
    const value = raw == null ? '' : String(raw);
    let visible = value;
    if (value && isHTTPURL(value)) {
      try { visible = targetURL(value); } catch {}
    }
    const currentVisible = Native.getAttribute.call(el, 'data-zp-target-url') || '';
    const currentHref = Native.getAttribute.call(el, 'href') || '';
    if (visible) {
      urlMeta.set(el, visible);
      if (currentVisible !== visible) Native.setAttribute.call(el, 'data-zp-target-url', visible);
    } else {
      urlMeta.delete(el);
      if (currentVisible && Native.removeAttribute) Native.removeAttribute.call(el, 'data-zp-target-url');
    }
    if (currentHref !== hiddenIconHref) Native.setAttribute.call(el, 'href', hiddenIconHref);
  }
  function enforceLinkPolicy(el) {
    if (!el || el.localName !== 'link') return;
    const rel = Native.getAttribute.call(el, 'rel') || '';
    if (isBlockedLinkRelValue(rel)) {
      suppressBlockedLinkRel(el, rel);
      return;
    }
    if (rel && Native.removeAttribute) Native.removeAttribute.call(el, 'data-zp-blocked-rel');
    if (hasSuppressedBlockedLinkRel(el)) {
      blockLinkURL(el, Native.getAttribute.call(el, 'href') || '');
      return;
    }
	    if (isIconLinkRelValue(rel)) {
	      suppressIconLinkHref(el, visibleLinkTarget(el) || Native.getAttribute.call(el, 'href') || '');
	      return;
	    }
	    if (isStylesheetLinkRelValue(rel)) {
	      setStylesheetLinkHref(el, visibleLinkTarget(el) || Native.getAttribute.call(el, 'href') || '');
	      return;
	    }
    if (Native.getAttribute.call(el, 'href') === hiddenIconHref) {
      const restored = visibleLinkTarget(el);
      if (restored) Native.setAttribute.call(el, 'href', restored);
      else if (Native.removeAttribute) Native.removeAttribute.call(el, 'href');
    }
    const href = Native.getAttribute.call(el, 'href') || '';
    if (href && isHTTPURL(href) && !String(href).startsWith(proxyOrigin)) {
      const target = targetURL(href);
      const alreadyMapped = urlMeta.get(el) === target && Native.getAttribute.call(el, 'data-zp-target-url') === target && Native.getAttribute.call(el, 'href') === target;
      urlMeta.set(el, target);
      if (Native.getAttribute.call(el, 'data-zp-target-url') !== target) Native.setAttribute.call(el, 'data-zp-target-url', target);
      if (!alreadyMapped && Native.getAttribute.call(el, 'href') !== target) Native.setAttribute.call(el, 'href', target);
    }
  }
  function visibleIconAttrValue(attr) {
    const owner = attr && attr.ownerElement;
    if (!owner || owner.localName !== 'link' || String(attr.name || '').toLowerCase() !== 'href' || !isIconLinkRelValue(Native.getAttribute.call(owner, 'rel') || '')) return null;
    return visibleLinkTarget(owner) || Native.getAttribute.call(owner, 'href') || '';
  }
  function visibleMaskedAttrValue(attr) {
    const icon = visibleIconAttrValue(attr);
    if (icon !== null) return icon;
    const owner = attr && attr.ownerElement;
    const name = String(attr && attr.name || '').toLowerCase();
    if (!owner || !name) return null;
    if (name === 'srcset' || isSrcsetAttribute(owner, name)) return visibleSrcset(owner);
    if (isResourceURLAttribute(owner, name) || owner.localName === 'link' && String(name).toLowerCase() === 'href') return urlMeta.get(owner) || Native.getAttribute.call(owner, 'data-zp-target-url') || null;
    return null;
  }
  function restoreVisibleLinkState(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.localName === 'link' && isIconLinkRelValue(Native.getAttribute.call(node, 'rel') || '')) {
      const target = Native.getAttribute.call(node, 'data-zp-target-url') || '';
      if (target) Native.setAttribute.call(node, 'href', target);
    }
  }
  function restoreVisibleResourceState(node) {
    if (!node || node.nodeType !== 1 || node.localName === 'script') return;
    if (Native.getAttributeNames) {
      for (const name of Native.getAttributeNames.call(node)) {
        const lower = String(name).toLowerCase();
        if (isSrcsetAttribute(node, lower)) {
          const srcset = visibleSrcset(node);
          if (srcset) Native.setAttribute.call(node, name, srcset);
        } else if (isResourceURLAttribute(node, lower) || node.localName === 'link' && lower === 'href') {
          const target = urlMeta.get(node) || Native.getAttribute.call(node, 'data-zp-target-url');
          if (target) Native.setAttribute.call(node, name, target);
        }
      }
    }
  }
  function restoreVisibleScriptState(node) {
    if (!node || node.nodeType !== 1 || node.localName !== 'script') return;
    const target = Native.getAttribute.call(node, 'data-zp-target-url') || '';
    if (target) Native.setAttribute.call(node, 'src', target);
  }
  function scriptTextExposesInternals(node) {
    if (!node || node.localName !== 'script') return false;
    let text = '';
    try { text = node.textContent || ''; } catch { return false; }
    return /__zp_|__ZP_|ZPRewriter|ZPRustRewriter|runtimeToken|data-zp-|\/zp\/assets\/|\/zp\/api\/script|zeroproxy/i.test(text);
  }
  function sanitizeSerializedNode(node) {
    restoreVisibleLinkState(node);
    restoreVisibleResourceState(node);
    restoreVisibleScriptState(node);
    if (isZPAssetNode(node)) { node.remove(); return false; }
    if (scriptTextExposesInternals(node)) node.textContent = '';
    if (Native.getAttributeNames) for (const name of Native.getAttributeNames.call(node)) if (isZPAttrName(name)) Native.removeAttribute.call(node, name);
    return true;
  }
  function sanitizeSerializedHTML(html) {
    const source = String(html || '');
    if (/^\s*<html[\s>]/i.test(source) && root.DOMParser && Native.DOMParserParseFromString) {
      try {
        const parsed = Native.DOMParserParseFromString.call(new root.DOMParser(), source, 'text/html');
        const docEl = parsed && parsed.documentElement;
        if (docEl) {
          const descendants = Native.elementQuerySelectorAll ? Array.from(Native.elementQuerySelectorAll.call(docEl, '*')) : Array.from(docEl.querySelectorAll('*'));
          for (const node of [docEl, ...descendants]) sanitizeSerializedNode(node);
          return Native.elementOuterHTML && Native.elementOuterHTML.get ? Native.elementOuterHTML.get.call(docEl) : docEl.outerHTML;
        }
      } catch {}
    }
    const parserDoc = Native.createHTMLDocument ? Native.createHTMLDocument('') : document.implementation.createHTMLDocument('');
    const container = parserDoc.createElement('div');
    if (Native.elementInnerHTML && Native.elementInnerHTML.set) Native.elementInnerHTML.set.call(container, source);
    else container.innerHTML = source;
    const nodes = Native.elementQuerySelectorAll ? Array.from(Native.elementQuerySelectorAll.call(container, '*')) : Array.from(container.querySelectorAll('*'));
    for (const node of nodes) {
      sanitizeSerializedNode(node);
    }
    return Native.elementInnerHTML && Native.elementInnerHTML.get ? Native.elementInnerHTML.get.call(container) : container.innerHTML;
  }
  function isNavigationTargetElement(el) {
    const tag = el && el.localName;
    return tag === 'a' || tag === 'area' || tag === 'form' || tag === 'button' || tag === 'input';
  }
  function setSafeNavigationTarget(el, attrName, value) {
    const raw = String(value || '');
    if (raw && raw !== '_self') Native.setAttribute.call(el, 'data-zp-blocked-target', raw);
    return Native.setAttribute.call(el, attrName, '_self');
  }
  function isZPAttrName(name) { return String(name || '').toLowerCase().startsWith('data-zp-'); }
  function isZeroProxyAssetURL(raw) {
    if (!raw) return false;
    try {
      const u = new URL(String(raw), proxyOrigin);
      return u.origin === proxyOrigin && (u.pathname === ZP.assetPath('zp-core.js') || u.pathname === ZP.assetPath('runtime-prelude.js') || u.pathname === ZP.assetPath('rust-rewriter.js') || u.pathname === ZP.assetPath('wasm_exec.js') || u.pathname === ZP.apiPath('script') || u.pathname === ZP.apiPath('worker-script'));
    } catch { return false; }
  }
  function isZPAssetNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.id === '__zp-boot') return true;
    return node.localName === 'script' && isZeroProxyAssetURL(Native.getAttribute.call(node, 'src'));
  }
  function filteredNamedNodeMap(raw) {
    return filteredCollection(raw, attr => attr && !isZPAttrName(attr.name));
  }
  function filteredCollection(raw, predicate) {
    const nth = index => {
      let seen = 0;
      for (let i = 0; raw && i < raw.length; i++) {
        const item = raw[i];
        if (predicate(item)) {
          if (seen === index) return item;
          seen++;
        }
      }
      return null;
    };
    const length = () => {
      let n = 0;
      for (let i = 0; raw && i < raw.length; i++) if (predicate(raw[i])) n++;
      return n;
    };
    return new Proxy({}, {
      get(_target, prop) {
        if (prop === 'length') return length();
        if (prop === 'item') return index => nth(Number(index) || 0);
        if (prop === 'getNamedItem') return name => {
          const lower = String(name || '').toLowerCase();
          if (isZPAttrName(lower)) return null;
          for (let i = 0; raw && i < raw.length; i++) if (raw[i] && String(raw[i].name).toLowerCase() === lower && predicate(raw[i])) return raw[i];
          return null;
        };
        if (prop === Symbol.iterator) return function*(){ for (let i = 0; i < length(); i++) yield nth(i); };
        if (/^(?:0|[1-9]\d*)$/.test(String(prop))) {
          const index = Number(prop);
          return index < length() ? nth(index) : undefined;
        }
        const value = raw && raw[prop];
        return typeof value === 'function' ? value.bind(raw) : value;
      },
      has(_target, prop) { return prop === 'length' || (/^(?:0|[1-9]\\d*)$/.test(String(prop)) && Number(prop) < length()); }
    });
  }
  function sanitizeSerializedHTML(html) {
    const source = String(html || '');
    if (/^\s*<html[\s>]/i.test(source) && root.DOMParser && Native.DOMParserParseFromString) {
      try {
        const parsed = Native.DOMParserParseFromString.call(new root.DOMParser(), source, 'text/html');
        const docEl = parsed && parsed.documentElement;
        if (docEl) {
          const descendants = Native.elementQuerySelectorAll ? Array.from(Native.elementQuerySelectorAll.call(docEl, '*')) : Array.from(docEl.querySelectorAll('*'));
          for (const node of [docEl, ...descendants]) sanitizeSerializedNode(node);
          return Native.elementOuterHTML && Native.elementOuterHTML.get ? Native.elementOuterHTML.get.call(docEl) : docEl.outerHTML;
        }
      } catch {}
    }
    const parserDoc = Native.createHTMLDocument ? Native.createHTMLDocument('') : document.implementation.createHTMLDocument('');
    const container = parserDoc.createElement('div');
    if (Native.elementInnerHTML && Native.elementInnerHTML.set) Native.elementInnerHTML.set.call(container, source);
    else container.innerHTML = source;
    const nodes = Native.elementQuerySelectorAll ? Array.from(Native.elementQuerySelectorAll.call(container, '*')) : Array.from(container.querySelectorAll('*'));
    for (const node of nodes) {
      sanitizeSerializedNode(node);
    }
    return Native.elementInnerHTML && Native.elementInnerHTML.get ? Native.elementInnerHTML.get.call(container) : container.innerHTML;
  }

  function installStealthMembrane(w) {
    if (!w || !w.Document || !w.Element) return;
    try { if (w[stealthMarker]) return; Object.defineProperty(w, stealthMarker, { value: true, enumerable: false, configurable: false }); } catch {}
    const docGetTags = w.Document.prototype.getElementsByTagName;
    const elemGetTags = w.Element.prototype.getElementsByTagName;
    if (typeof docGetTags === 'function') define(w.Document.prototype, 'getElementsByTagName', function(tag) {
      const raw = docGetTags.apply(this, arguments);
      return shouldFilterTag(tag) ? filteredCollection(raw, node => !isZPAssetNode(node)) : raw;
    });
    if (typeof elemGetTags === 'function') define(w.Element.prototype, 'getElementsByTagName', function(tag) {
      const raw = elemGetTags.apply(this, arguments);
      return shouldFilterTag(tag) ? filteredCollection(raw, node => !isZPAssetNode(node)) : raw;
    });
    const scriptsDesc = Object.getOwnPropertyDescriptor(w.Document.prototype, 'scripts') || Native.documentScripts;
    if (scriptsDesc && scriptsDesc.get) try { Object.defineProperty(w.Document.prototype, 'scripts', { get() { return filteredCollection(scriptsDesc.get.call(this), node => !isZPAssetNode(node)); }, configurable: false }); } catch {}
    const docQS = w.Document.prototype.querySelector;
    const docQSA = w.Document.prototype.querySelectorAll;
    const elemQS = w.Element.prototype.querySelector;
    const elemQSA = w.Element.prototype.querySelectorAll;
    if (typeof docQS === 'function') define(w.Document.prototype, 'querySelector', function(sel) { return selectorTargetsZP(sel) ? null : filterSelectorOne(docQS.apply(this, arguments)); });
    if (typeof elemQS === 'function') define(w.Element.prototype, 'querySelector', function(sel) { return selectorTargetsZP(sel) ? null : filterSelectorOne(elemQS.apply(this, arguments)); });
    if (typeof docQSA === 'function') define(w.Document.prototype, 'querySelectorAll', function(sel) { return selectorTargetsZP(sel) ? filteredCollection([], () => false) : filteredCollection(docQSA.apply(this, arguments), node => !isZPAssetNode(node)); });
    if (typeof elemQSA === 'function') define(w.Element.prototype, 'querySelectorAll', function(sel) { return selectorTargetsZP(sel) ? filteredCollection([], () => false) : filteredCollection(elemQSA.apply(this, arguments), node => !isZPAssetNode(node)); });
    const matches = w.Element.prototype.matches;
    const closest = w.Element.prototype.closest;
    if (typeof matches === 'function') define(w.Element.prototype, 'matches', function(sel) { return selectorTargetsZP(sel) ? false : matches.apply(this, arguments); });
    if (typeof closest === 'function') define(w.Element.prototype, 'closest', function(sel) { return selectorTargetsZP(sel) ? null : filterSelectorOne(closest.apply(this, arguments)); });
    const nodeIterator = w.Document.prototype.createNodeIterator;
    if (typeof nodeIterator === 'function') define(w.Document.prototype, 'createNodeIterator', function() { return filteredTraversal(nodeIterator.apply(this, arguments)); });
    const treeWalker = w.Document.prototype.createTreeWalker;
    if (typeof treeWalker === 'function') define(w.Document.prototype, 'createTreeWalker', function() { return filteredTraversal(treeWalker.apply(this, arguments)); });
  }
  function shouldFilterTag(tag) {
    const t = String(tag || '').toLowerCase();
    return t === '*' || t === 'script' || t === 'meta' || t === 'link';
  }
  function selectorTargetsZP(selector) {
    const s = String(selector || '').toLowerCase();
    return s.includes('data-zp-') || s.includes('#__zp-boot') || s.includes('/zp/assets/') || s.includes('/zp/api/') || s.includes('src*="zp"') || s.includes("src*='zp'") || s.includes('src*=zp') || s.includes('zeroproxy') || s.includes('x-zeroproxy-icon');
  }
  function filterSelectorOne(node) { return isZPAssetNode(node) ? null : node; }
  function filteredTraversal(raw) {
    return new Proxy(raw, {
      get(target, prop) {
        if (prop === 'nextNode' || prop === 'previousNode') return function() {
          let node;
          do { node = target[prop](); } while (node && isZPAssetNode(node));
          return node;
        };
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  function hiddenGlobalKey(key) {
    if (typeof key === 'symbol') {
      const desc = String(key.description || '');
      return desc.toLowerCase().includes('zeroproxy') || desc.toLowerCase().startsWith('zp.');
    }
    const name = String(key || '');
    return name === 'ZP' || name === 'ZPRewriter' || name === 'ZPRustRewriter' || name === '__ZP_BOOT' || name === '__ZP_SET_BASE' || name.startsWith('__zp_') || name.startsWith('__ZP_');
  }
  function isGlobalObjectForMasking(value, w) {
    try { return value === w || value && value.window === value; } catch { return false; }
  }
  function visibleOwnKeysFor(value, keys, w) {
    return isGlobalObjectForMasking(value, w) ? Array.from(keys || []).filter(key => !hiddenGlobalKey(key)) : keys;
  }
  function installOwnPropertyMasking(w) {
    const Obj = w && w.Object;
    const Refl = w && w.Reflect;
    if (!Obj) return;
    const defineMask = (obj, key, value) => {
      try {
        Object.defineProperty(obj, key, { value, enumerable: false, configurable: true, writable: true });
        maskNativeFunction(value, key);
      } catch {}
    };
    const keys = Obj.keys;
    const getNames = Obj.getOwnPropertyNames;
    const getSymbols = Obj.getOwnPropertySymbols;
    const getDescriptor = Obj.getOwnPropertyDescriptor;
    const getDescriptors = Obj.getOwnPropertyDescriptors;
    const ownKeys = Refl && Refl.ownKeys;
    if (typeof keys === 'function') defineMask(Obj, 'keys', function zpObjectKeys(value) {
      return visibleOwnKeysFor(value, keys.call(Obj, value), w);
    });
    if (typeof getNames === 'function') defineMask(Obj, 'getOwnPropertyNames', function zpGetOwnPropertyNames(value) {
      return visibleOwnKeysFor(value, getNames.call(Obj, value), w);
    });
    if (typeof getSymbols === 'function') defineMask(Obj, 'getOwnPropertySymbols', function zpGetOwnPropertySymbols(value) {
      return visibleOwnKeysFor(value, getSymbols.call(Obj, value), w);
    });
    if (typeof getDescriptor === 'function') defineMask(Obj, 'getOwnPropertyDescriptor', function zpGetOwnPropertyDescriptor(value, key) {
      if (isGlobalObjectForMasking(value, w) && hiddenGlobalKey(key)) return undefined;
      return getDescriptor.call(Obj, value, key);
    });
    if (typeof getDescriptors === 'function') defineMask(Obj, 'getOwnPropertyDescriptors', function zpGetOwnPropertyDescriptors(value) {
      const out = getDescriptors.call(Obj, value);
      if (isGlobalObjectForMasking(value, w)) {
        for (const key of ownKeys ? ownKeys.call(Refl, out) : getNames.call(Obj, out)) {
          if (hiddenGlobalKey(key)) delete out[key];
        }
      }
      return out;
    });
    if (Refl && typeof ownKeys === 'function') defineMask(Refl, 'ownKeys', function zpReflectOwnKeys(value) {
      return visibleOwnKeysFor(value, ownKeys.call(Refl, value), w);
    });
  }

  function visibleResourceEntryName(raw) {
    try {
      const u = new URL(String(raw || ''), proxyOrigin);
      if (u.origin !== proxyOrigin) return String(raw || '');
      if (u.pathname === ZP.apiPath('fetch')) return u.searchParams.get('url') || String(raw || '');
      if (u.pathname === ZP.apiPath('script') || u.pathname === ZP.apiPath('worker-script')) return u.searchParams.get('u') || String(raw || '');
      if (isZeroProxyAssetURL(u.href)) return '';
    } catch {}
    return String(raw || '');
  }
  function wrapPerformanceEntry(entry) {
    const visible = visibleResourceEntryName(entry && entry.name);
    if (!visible) return null;
    if (!entry || visible === entry.name) return entry;
    return new Proxy(entry, {
      get(target, prop) {
        if (prop === 'name') return visible;
        if (prop === 'toJSON') return () => Object.assign({}, target.toJSON ? target.toJSON() : target, { name: visible });
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }
  function maskPerformanceList(list) {
    return Array.from(list || []).map(wrapPerformanceEntry).filter(Boolean);
  }
  function installPerformanceMasking(w) {
    const perf = w && w.performance;
    if (!perf) return;
    if (typeof perf.getEntries === 'function') {
      const native = perf.getEntries.bind(perf);
      define(perf, 'getEntries', function() { return maskPerformanceList(native()); });
    }
    if (typeof perf.getEntriesByType === 'function') {
      const native = perf.getEntriesByType.bind(perf);
      define(perf, 'getEntriesByType', function(type) { return String(type) === 'resource' ? maskPerformanceList(native(type)) : native(type); });
    }
    if (typeof perf.getEntriesByName === 'function') {
      const native = perf.getEntriesByName.bind(perf);
      define(perf, 'getEntriesByName', function(name, type) {
        const direct = native(name, type);
        if (direct && direct.length) return maskPerformanceList(direct);
        return maskPerformanceList(native(resourceProxyPath(String(name)), type));
      });
    }
  }


  function installDOMHooks(w) {
    define(w.Element.prototype, 'setAttribute', function(k, v) {
      const key = String(k).toLowerCase();
      const localKey = attrLocalName(key);
      if (key === 'integrity' && isIntegrityBearing(this)) return setBackedIntegrity(this, v);
      if (localKey === 'style') return Native.setAttribute.call(this, k, rewriteCSSSource(String(v)));
      if (localKey === 'target' && isNavigationTargetElement(this)) return setSafeNavigationTarget(this, k, v);
      if (this.localName === 'link' && localKey === 'rel') {
        const value = String(v);
        if (isBlockedLinkRelValue(value)) return suppressBlockedLinkRel(this, value);
        if (Native.removeAttribute) Native.removeAttribute.call(this, 'data-zp-blocked-rel');
        const ret = Native.setAttribute.call(this, k, v);
        enforceLinkPolicy(this);
        return ret;
      }
	      if (this.localName === 'link' && localKey === 'href' && (isBlockedLink(this) || hasSuppressedBlockedLinkRel(this))) return blockLinkURL(this, v);
	      if (this.localName === 'link' && localKey === 'href' && isIconLink(this)) return suppressIconLinkHref(this, v);
	      if (this.localName === 'link' && localKey === 'href' && isStylesheetLink(this)) return setStylesheetLinkHref(this, v);
	      if (key.startsWith('on') && key.length > 2) {
	        Native.setAttribute.call(this, 'data-zp-blocked-' + key, String(v));
	        if (Native.removeAttribute) Native.removeAttribute.call(this, k);
	        return;
	      }
      if (this.localName === 'base' && localKey === 'href') {
        updateVirtualBase(v);
        return Native.setAttribute.call(this, k, v);
      }
      if (this.localName === 'script' && (localKey === 'src' || localKey === 'href')) return setScriptSource(this, v);
      if (isSrcsetAttribute(this, key)) return setSrcsetAttribute(this, k, v);
      if (isResourceURLAttribute(this, key)) return setResourceURLAttribute(this, k, v);
      if (isURLBearing(this, key)) {
        if (shouldBlockURLAttribute(this, localKey, v)) return blockExecutableURL(this, localKey, v);
        if (isHTTPURL(v)) {
          const t = targetURL(v);
          urlMeta.set(this, t);
          if (!usesRawURLAttribute(this, key)) Native.setAttribute.call(this, 'data-zp-target-url', t);
          if ((this.localName === 'iframe' || this.localName === 'frame') && localKey === 'src') {
            Native.setAttribute.call(this, k, 'about:blank');
            activatedFrameURL(t).then(u => { Native.setAttribute.call(this, k, u); rememberFrameOrigin(this); }).catch(()=>{});
            return;
          }
          if (this.localName === 'link' && localKey === 'href' && isIconLink(this)) return suppressIconLinkHref(this, t);
          return Native.setAttribute.call(this, k, usesRawURLAttribute(this, key) ? v : t);
        }
      }
      if ((this.localName === 'iframe' || this.localName === 'frame') && localKey === 'srcdoc') return Native.setAttribute.call(this, k, injectSrcdoc(String(v)));
      return Native.setAttribute.call(this, k, v);
    });
    if (Native.setAttributeNS) define(w.Element.prototype, 'setAttributeNS', function(ns, k, v) {
      const key = String(k).toLowerCase();
      const localKey = attrLocalName(key);
      if (key === 'integrity' && isIntegrityBearing(this)) return setBackedIntegrity(this, v);
	      if (this.localName === 'script' && (localKey === 'src' || localKey === 'href')) return setScriptSource(this, v);
	      if (this.localName === 'link' && localKey === 'href' && isIconLink(this)) return suppressIconLinkHref(this, v);
	      if (this.localName === 'link' && localKey === 'href' && isStylesheetLink(this)) return setStylesheetLinkHref(this, v);
      if (isSrcsetAttribute(this, key)) return setSrcsetAttribute(this, k, v, ns);
      if (isResourceURLAttribute(this, key)) return setResourceURLAttribute(this, k, v, ns);
      if (isURLBearing(this, key)) {
        if (shouldBlockURLAttribute(this, localKey, v)) return blockExecutableURL(this, localKey, v);
        if (isHTTPURL(v)) {
          const t = targetURL(v);
          urlMeta.set(this, t);
          if (!usesRawURLAttribute(this, key)) Native.setAttribute.call(this, 'data-zp-target-url', t);
          return Native.setAttributeNS.call(this, ns, k, usesRawURLAttribute(this, key) ? v : t);
        }
      }
	      if (key.startsWith('on') && key.length > 2) {
	        Native.setAttribute.call(this, 'data-zp-blocked-' + key, String(v));
	        if (Native.removeAttributeNS) Native.removeAttributeNS.call(this, ns, k);
	        return;
	      }
	      return Native.setAttributeNS.call(this, ns, k, v);
	    });
	    if (Native.namedSetNamedItem && w.NamedNodeMap) define(w.NamedNodeMap.prototype, 'setNamedItem', function(attr) { if (attr && String(attr.name || '').toLowerCase().startsWith('on')) return attr.ownerElement ? Native.setAttribute.call(attr.ownerElement, 'data-zp-blocked-' + String(attr.name).toLowerCase(), String(attr.value || '')) : null; return Native.namedSetNamedItem.call(this, attr); });
	    if (Native.attrValue && Native.attrValue.set && w.Attr) try { Object.defineProperty(w.Attr.prototype, 'value', { get() { const masked = visibleMaskedAttrValue(this); return masked === null ? Native.attrValue.get.call(this) : masked; }, set(v) { Native.attrValue.set.call(this, String(this.name || '').toLowerCase().startsWith('on') ? '' : v); }, configurable: false }); } catch {}
    define(w.Element.prototype, 'getAttribute', function(k) {
      const key = String(k).toLowerCase();
      if (isZPAttrName(key)) return null;
      if (key === 'integrity' && isIntegrityBearing(this)) {
        const backed = backedIntegrity(this);
        return backed !== null ? backed : Native.getAttribute.call(this, k);
      }
      if (key === 'srcset' || isSrcsetAttribute(this, key)) return visibleSrcset(this);
      if (isURLBearing(this, key)) return usesRawURLAttribute(this, key) ? Native.getAttribute.call(this, k) : urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url') || Native.getAttribute.call(this, k);
      return Native.getAttribute.call(this, k);
    });
    if (Native.hasAttribute) define(w.Element.prototype, 'hasAttribute', function(k) {
      const key = String(k).toLowerCase();
      if (isZPAttrName(key)) return false;
      if (key === 'integrity' && isIntegrityBearing(this)) return backedIntegrity(this) !== null || Native.hasAttribute.call(this, k);
      return Native.hasAttribute.call(this, k);
    });
    if (Native.removeAttribute) define(w.Element.prototype, 'removeAttribute', function(k) {
      const key = String(k).toLowerCase();
      const localKey = attrLocalName(key);
      if (key === 'integrity' && isIntegrityBearing(this)) {
        Native.removeAttribute.call(this, integrityBackupAttr);
        return Native.removeAttribute.call(this, k);
      }
      if (this.localName === 'link' && localKey === 'href' && isIconLink(this)) {
        urlMeta.delete(this);
        if (Native.removeAttribute) Native.removeAttribute.call(this, 'data-zp-target-url');
        return Native.removeAttribute.call(this, k);
      }
      if (this.localName === 'link' && localKey === 'rel') {
        const ret = Native.removeAttribute.call(this, k);
        enforceLinkPolicy(this);
        return ret;
      }
      if (isResourceURLAttribute(this, key)) {
        urlMeta.delete(this);
        Native.removeAttribute.call(this, 'data-zp-target-url');
      }
      if (isSrcsetAttribute(this, key)) Native.removeAttribute.call(this, 'data-zp-target-srcset');
      return Native.removeAttribute.call(this, k);
    });
    if (Native.getAttributeNames) define(w.Element.prototype, 'getAttributeNames', function() {
      const names = Native.getAttributeNames.call(this).filter(name => !isZPAttrName(name));
      if (isIntegrityBearing(this) && backedIntegrity(this) !== null && !names.some(name => String(name).toLowerCase() === 'integrity')) names.push('integrity');
      return names;
    });
    if (Native.elementAttributes && Native.elementAttributes.get) try { Object.defineProperty(w.Element.prototype, 'attributes', { get() { return filteredNamedNodeMap(Native.elementAttributes.get.call(this)); }, configurable: false }); } catch {}
    installIntegrityProp(w.HTMLScriptElement && w.HTMLScriptElement.prototype);
    installIntegrityProp(w.HTMLLinkElement && w.HTMLLinkElement.prototype);
    installScriptProp(w.HTMLScriptElement && w.HTMLScriptElement.prototype);
    installScriptTextProps(w);
    installLinkProp(w.HTMLLinkElement && w.HTMLLinkElement.prototype);
    installResourceURLProps(w);
    patchHTMLSetter(w.Element.prototype, 'innerHTML');
    patchHTMLSetter(w.Element.prototype, 'outerHTML');
    if (w.HTMLElement && w.HTMLElement.prototype) {
      patchHTMLSetter(w.HTMLElement.prototype, 'innerHTML');
      patchHTMLSetter(w.HTMLElement.prototype, 'outerHTML');
    }
    define(w.Element.prototype, 'insertAdjacentHTML', function(pos, html) { const ret = Native.insertAdjacentHTML.call(this, pos, transformHTML(String(html))); syncBaseElement(this); enforceSubtreePolicies(this); return ret; });
    installBaseObserver();
    function patchHTMLSetter(proto, prop) {
      let d = null;
      for (let p = proto; p && !d; p = Object.getPrototypeOf(p)) d = Object.getOwnPropertyDescriptor(p, prop);
      if (!d || !d.set) return;
      try {
        Object.defineProperty(proto, prop, {
          get() { return d.get ? sanitizeSerializedHTML(d.get.call(this)) : ''; },
          set(v) {
            if (this && this.localName === 'template' && prop === 'innerHTML') {
              d.set.call(this, String(v));
              enforceSubtreePolicies(this.content);
              instrumentDescendantIframes(this.content);
              return;
            }
            if (this && this.localName === 'script' && prop === 'innerHTML') {
              d.set.call(this, String(v));
              if (this.isConnected) prepareScriptElement(this);
              return;
            }
            d.set.call(this, transformHTML(String(v)));
            syncBaseElement(this);
            instrumentDescendantIframes(this);
            enforceSubtreePolicies(this);
          },
          configurable: false
        });
      } catch {}
    }
  }
  function installIntegrityProp(proto) {
    if (!proto) return;
    defineAccessor(proto, 'integrity', function() {
      const backed = backedIntegrity(this);
      return backed !== null ? backed : Native.getAttribute.call(this, 'integrity') || '';
    }, function(v) {
      setBackedIntegrity(this, v);
    });
  }
  function propertyDescriptor(proto, prop) {
    for (let p = proto; p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, prop);
      if (d) return d;
    }
    return null;
  }
  function executableScriptKindForElement(el) {
    const t = String(Native.getAttribute.call(el, 'type') || '').trim().toLowerCase();
    if (t === 'module') return 'module';
    if (t === '' || t === 'text/javascript' || t === 'application/javascript' || t === 'application/ecmascript' || t === 'text/ecmascript') return 'classic';
    return '';
  }
  function scriptProxyPath(target, kind) {
    return ZP.apiPath('script') + '?kind=' + encodeURIComponent(kind) + '&u=' + encodeURIComponent(target) + '&tab=' + encodeURIComponent(boot.tabId) + '&rt=' + encodeURIComponent(runtimeToken);
  }
  function setScriptSource(el, raw) {
    const kind = executableScriptKindForElement(el);
    const value = String(raw);
    const trimmed = value.trim();
    if (trimmed.startsWith(ZP.CONTROL_PREFIX) || trimmed.startsWith(proxyOrigin + ZP.CONTROL_PREFIX)) {
      const internal = trimmed.startsWith(proxyOrigin) ? new URL(trimmed).pathname + new URL(trimmed).search : value;
      if (Native.getAttribute.call(el, 'src') === internal) return;
      return Native.setAttribute.call(el, 'src', internal);
    }
    if (!kind) {
      urlMeta.delete(el);
      return Native.setAttribute.call(el, 'src', value);
    }
    if (hasExecutableURLScheme(value) || !isHTTPURL(value)) return blockExecutableURL(el, 'src', value);
    let target;
    try { target = targetURL(value); } catch { return blockExecutableURL(el, 'src', value); }
    urlMeta.set(el, target);
    Native.setAttribute.call(el, 'data-zp-target-url', target);
    return Native.setAttribute.call(el, 'src', scriptProxyPath(target, kind));
  }
  function installScriptTextProps(w) {
    const scriptProto = w.HTMLScriptElement && w.HTMLScriptElement.prototype;
    if (!scriptProto) return;
    for (const prop of ['text', 'textContent', 'innerText']) {
      const d = propertyDescriptor(scriptProto, prop) || propertyDescriptor(w.Node && w.Node.prototype, prop);
      if (!d || !d.set) continue;
      try {
        Object.defineProperty(scriptProto, prop, {
          get() { return d.get ? d.get.call(this) : ''; },
          set(v) { d.set.call(this, v); if (this.isConnected) prepareScriptElement(this); },
          configurable: false
        });
      } catch {}
    }
  }
  function installScriptProp(proto) {
    if (!proto) return;
    const d = propertyDescriptor(proto, 'src');
    if (!d || !d.get) return;
    try {
      Object.defineProperty(proto, 'src', {
        get() { return urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url') || d.get.call(this); },
        set(v) { setScriptSource(this, v); },
        configurable: false
      });
    } catch {}
  }
  function installLinkProp(proto) {
    if (!proto) return;
    const hrefDescriptor = propertyDescriptor(proto, 'href');
    if (hrefDescriptor && hrefDescriptor.get) try {
      Object.defineProperty(proto, 'href', {
        get() { return urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url') || hrefDescriptor.get.call(this); },
        set(v) {
	          if (isBlockedLink(this) || hasSuppressedBlockedLinkRel(this)) return blockLinkURL(this, v);
	          if (isIconLink(this)) return suppressIconLinkHref(this, v);
	          if (isStylesheetLink(this)) return setStylesheetLinkHref(this, v);
          const value = String(v);
          if (shouldBlockURLAttribute(this, 'href', value)) return blockExecutableURL(this, 'href', value);
          if (isHTTPURL(value)) {
            const t = targetURL(value);
            urlMeta.set(this, t);
            Native.setAttribute.call(this, 'data-zp-target-url', t);
            return hrefDescriptor.set ? hrefDescriptor.set.call(this, t) : Native.setAttribute.call(this, 'href', t);
          }
          return hrefDescriptor.set ? hrefDescriptor.set.call(this, value) : Native.setAttribute.call(this, 'href', value);
        },
        configurable: false
      });
    } catch {}
    const relDescriptor = propertyDescriptor(proto, 'rel');
    if (relDescriptor && relDescriptor.get) try {
      Object.defineProperty(proto, 'rel', {
        get() { return relDescriptor.get.call(this); },
        set(v) {
          const value = String(v);
          if (isBlockedLinkRelValue(value)) return suppressBlockedLinkRel(this, value);
          if (Native.removeAttribute) Native.removeAttribute.call(this, 'data-zp-blocked-rel');
          const ret = relDescriptor.set ? relDescriptor.set.call(this, value) : Native.setAttribute.call(this, 'rel', value);
          enforceLinkPolicy(this);
          return ret;
        },
        configurable: false
      });
    } catch {}
  }
  function installResourceURLProps(w) {
    installResourceProp(w.HTMLImageElement && w.HTMLImageElement.prototype, 'src', 'src');
    installResourceProp(w.HTMLImageElement && w.HTMLImageElement.prototype, 'currentSrc', 'src', true);
    installSrcsetProp(w.HTMLImageElement && w.HTMLImageElement.prototype);
    installResourceGetAttribute(w.HTMLImageElement && w.HTMLImageElement.prototype);
    installResourceProp(w.HTMLSourceElement && w.HTMLSourceElement.prototype, 'src', 'src');
    installSrcsetProp(w.HTMLSourceElement && w.HTMLSourceElement.prototype);
    installResourceGetAttribute(w.HTMLSourceElement && w.HTMLSourceElement.prototype);
    installResourceProp(w.HTMLMediaElement && w.HTMLMediaElement.prototype, 'src', 'src');
    installResourceGetAttribute(w.HTMLMediaElement && w.HTMLMediaElement.prototype);
    installResourceProp(w.HTMLVideoElement && w.HTMLVideoElement.prototype, 'poster', 'poster');
    installResourceProp(w.HTMLInputElement && w.HTMLInputElement.prototype, 'src', 'src');
    installResourceGetAttribute(w.HTMLInputElement && w.HTMLInputElement.prototype);
  }
  function installResourceProp(proto, prop, attrName, readonly) {
    if (!proto) return;
    const d = propertyDescriptor(proto, prop);
    if (!d || !d.get) return;
    try {
      Object.defineProperty(proto, prop, {
        get() { return visibleResourceURL(this, attrName) || d.get.call(this); },
        set: readonly ? undefined : function(v) { setResourceURLAttribute(this, attrName, v); },
        configurable: false
      });
    } catch {}
  }
  function installSrcsetProp(proto) {
    if (!proto) return;
    const d = propertyDescriptor(proto, 'srcset');
    if (!d || !d.get) return;
    try {
      Object.defineProperty(proto, 'srcset', {
        get() { return visibleSrcset(this); },
        set(v) { setSrcsetAttribute(this, 'srcset', v); },
        configurable: false
      });
    } catch {}
  }
  function installResourceGetAttribute(proto) {
    if (!proto) return;
    define(proto, 'getAttribute', function(k) {
      const key = String(k).toLowerCase();
      if (isZPAttrName(key)) return null;
      if (key === 'srcset' || isSrcsetAttribute(this, key)) return visibleSrcset(this);
      if (isResourceURLAttribute(this, key)) return visibleResourceURL(this, attrLocalName(key));
      return Native.getAttribute.call(this, k);
    });
  }
  function getScriptText(el) {
    if (Native.scriptText && Native.scriptText.get) return String(Native.scriptText.get.call(el) || '');
    if (Native.nodeTextContent && Native.nodeTextContent.get) return String(Native.nodeTextContent.get.call(el) || '');
    return String(el.textContent || '');
  }
  function setScriptText(el, value) {
    const text = String(value || '');
    if (Native.scriptText && Native.scriptText.set) { Native.scriptText.set.call(el, text); return; }
    if (Native.nodeTextContent && Native.nodeTextContent.set) { Native.nodeTextContent.set.call(el, text); return; }
    el.textContent = text;
  }
  function elementText(el) {
    if (Native.nodeTextContent && Native.nodeTextContent.get) return String(Native.nodeTextContent.get.call(el) || '');
    return String(el && el.textContent || '');
  }
  function setElementText(el, value) {
    if (Native.nodeTextContent && Native.nodeTextContent.set) return Native.nodeTextContent.set.call(el, String(value || ''));
    el.textContent = String(value || '');
  }
  function prepareStyleElement(el) {
    if (!el || el.localName !== 'style' || rewrittenStyleNodes.has(el)) return;
    const text = elementText(el);
    if (!text) return;
    setElementText(el, rewriteCSSSource(text));
    rewrittenStyleNodes.add(el);
  }
  function inlineScriptWrapper(source, kind) {
    return rewritePageSource(source, kind === 'module' ? 'module' : 'classic');
  }
  function isPreparedInlineScript(text) {
    return /^throw new DOMException\('Blocked by ZeroProxy rewrite policy'/.test(String(text || '').trim());
  }
	  function prepareScriptElement(el) {
	    if (!el || el.localName !== 'script') return;
	    if (Native.getAttribute.call(el, 'data-zp-static-script') === '1') {
	      rewrittenInlineScripts.add(el);
	      if (Native.removeAttribute) Native.removeAttribute.call(el, 'data-zp-static-script');
	      return;
	    }
	    const dataType = executableScriptDataType(el);
    if (dataType === 'importmap') {
      if (!Native.getAttribute.call(el, 'src')) setScriptText(el, rewriteImportMapText(getScriptText(el)));
      return;
    }
    const raw = Native.getAttribute.call(el, 'src') || Native.getAttribute.call(el, 'href');
    if (raw) {
      setScriptSource(el, raw);
      return;
    }
    if (dataType) {
      const text = getScriptText(el);
      if (!text) return;
      if (rewrittenInlineScripts.has(el) || isPreparedInlineScript(text)) return;
      try {
        setScriptText(el, inlineScriptWrapper(text, dataType));
        Native.setAttribute.call(el, 'nonce', 'zp');
        rewrittenInlineScripts.add(el);
      } catch {
        setScriptText(el, "throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');");
        Native.setAttribute.call(el, 'nonce', 'zp');
        rewrittenInlineScripts.add(el);
      }
    }
  }
  function instrumentScriptElement(el) { prepareScriptElement(el); }
  function isSVGURLBearing(el, key) { return el && el.namespaceURI === 'http://www.w3.org/2000/svg' && attrLocalName(key) === 'href' && /^(a|image|use|script)$/.test(el.localName || ''); }
  function isURLBearing(el, key) { const tag = el.localName; const localKey = attrLocalName(key); return localKey === 'href' && (tag === 'a' || tag === 'area' || tag === 'link' || isSVGURLBearing(el, key)) || localKey === 'action' && tag === 'form' || localKey === 'formaction' && (tag === 'input' || tag === 'button') || localKey === 'src' && (tag === 'iframe' || tag === 'frame' || tag === 'script' || tag === 'img' || tag === 'source' || tag === 'audio' || tag === 'video' || tag === 'track' || tag === 'input') || localKey === 'poster' && tag === 'video'; }
  function executableScriptDataType(el) {
    const kind = executableScriptKindForElement(el);
    if (kind) return kind;
    const t = String(Native.getAttribute.call(el, 'type') || '').trim().toLowerCase();
    return t === 'importmap' ? 'importmap' : '';
  }
  function blockInlineScriptElement(el) {
    Native.setAttribute.call(el, 'type', 'application/x-zeroproxy-blocked');
    Native.setAttribute.call(el, 'data-zp-blocked-script', '1');
    setScriptText(el, '');
  }
  function rewriteImportMapText(source) {
    let map;
    try { map = JSON.parse(String(source || '{}')); } catch { return '{}'; }
    if (!map || typeof map !== 'object' || Array.isArray(map)) return '{}';
    const rewriteAddress = value => {
      if (typeof value !== 'string') return value;
      try {
        const u = new URL(value, baseURL);
        if (u.protocol === 'http:' || u.protocol === 'https:') return scriptProxyPath(u.href, 'module');
        return ZP.errorPath('POLICY_BLOCKED');
      } catch {
        return ZP.errorPath('POLICY_BLOCKED');
      }
    };
    if (map.imports && typeof map.imports === 'object' && !Array.isArray(map.imports)) {
      for (const key of Object.keys(map.imports)) map.imports[key] = rewriteAddress(map.imports[key]);
    }
    if (map.scopes && typeof map.scopes === 'object' && !Array.isArray(map.scopes)) {
      const nextScopes = {};
      for (const scope of Object.keys(map.scopes)) {
        let scopeKey = scope;
        try {
          const u = new URL(scope, baseURL);
          if (u.protocol === 'http:' || u.protocol === 'https:') scopeKey = scriptProxyPath(u.href, 'module');
        } catch {}
        const entries = map.scopes[scope];
        if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
          const out = {};
          for (const key of Object.keys(entries)) out[key] = rewriteAddress(entries[key]);
          nextScopes[scopeKey] = out;
        }
      }
      map.scopes = nextScopes;
    }
    return JSON.stringify(map).replace(/[<>&]/g, c => c === '<' ? '\\u003c' : c === '>' ? '\\u003e' : '\\u0026');
  }
  function transformHTML(value) {
    const html = String(value);
    if (!html) return html;
    const parserDoc = Native.createHTMLDocument ? Native.createHTMLDocument('') : document.implementation.createHTMLDocument('');
    const container = parserDoc.createElement('template');
    if (Native.elementInnerHTML && Native.elementInnerHTML.set) Native.elementInnerHTML.set.call(container, html);
    else container.innerHTML = html;
    const root = container.content || container;
    const walker = parserDoc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    for (const node of nodes) {
      const tag = node.localName;
      if (tag === 'base' && Native.getAttribute.call(node, 'href')) {
        const href = Native.getAttribute.call(node, 'href') || '';
        updateVirtualBase(href);
        const script = parserDoc.createElement('script');
        setScriptText(script, 'window.__ZP_SET_BASE&&window.__ZP_SET_BASE(' + JSON.stringify(href).replace(/</g, '\\\\u003c') + ');');
        node.replaceWith(script);
        continue;
      }
      if (tag === 'link') enforceLinkPolicy(node);
      if ((tag === 'iframe' || tag === 'frame') && Native.hasAttribute.call(node, 'srcdoc')) {
        Native.setAttribute.call(node, 'srcdoc', injectSrcdoc(Native.getAttribute.call(node, 'srcdoc') || ''));
      }
      if (tag === 'script') {
        const dtype = executableScriptDataType(node);
        if (dtype === 'importmap') setScriptText(node, rewriteImportMapText(getScriptText(node)));
        else if (dtype) blockInlineScriptElement(node);
      }
      if (tag === 'style') {
        setElementText(node, rewriteCSSSource(elementText(node)));
        rewrittenStyleNodes.add(node);
      }
      if (Native.getAttributeNames) {
        for (const attrName of Native.getAttributeNames.call(node)) {
          const lowerAttr = String(attrName).toLowerCase();
          if (lowerAttr === 'style') Native.setAttribute.call(node, attrName, rewriteCSSSource(Native.getAttribute.call(node, attrName) || ''));
          if (isSrcsetAttribute(node, lowerAttr)) setSrcsetAttribute(node, attrName, Native.getAttribute.call(node, attrName) || '');
          if (lowerAttr === 'integrity' && isIntegrityBearing(node)) setBackedIntegrity(node, Native.getAttribute.call(node, attrName) || '');
	          if (lowerAttr.startsWith('on') && lowerAttr.length > 2) {
	            const val = Native.getAttribute.call(node, attrName) || '';
	            Native.setAttribute.call(node, 'data-zp-blocked-' + lowerAttr, val);
	            if (Native.removeAttribute) Native.removeAttribute.call(node, attrName);
	          }
          if (isSrcsetAttribute(node, lowerAttr) || isURLBearing(node, lowerAttr)) enforceObservedAttribute(node, lowerAttr);
        }
      }
    }
    return Native.elementInnerHTML && Native.elementInnerHTML.get ? Native.elementInnerHTML.get.call(container) : container.innerHTML;
  }
  function injectSrcdoc(s) { return '<script nonce="zp" src="/zp/assets/zp-core.js"><\/script><script nonce="zp" src="/zp/assets/rust-rewriter.js"><\/script><script nonce="zp">(function(){const boot=' + bootJSON() + ';Object.defineProperty(window,"__ZP_BOOT",{value:boot,enumerable:false,configurable:true,writable:false});try{document.currentScript.remove()}catch{}})();<\/script><script nonce="zp" src="/zp/assets/runtime-prelude.js"><\/script>' + transformHTML(String(s)); }
  function bootJSON() { return JSON.stringify(Object.assign({}, boot, { servers: activeServers })).replace(/[<>&]/g, c => c === '<' ? '\\u003c' : c === '>' ? '\\u003e' : '\\u0026'); }
  function rewriteEventAttribute(source) {
    try { return rewritePageSource(source, 'event-handler'); }
    catch { return "throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError')"; }
  }
  function normalizeReferrerPolicy(value) {
    const v = String(value || '').trim().toLowerCase();
    if (v === 'never') return 'no-referrer';
    if (v === 'default') return 'strict-origin-when-cross-origin';
    if (v === 'always') return 'unsafe-url';
    if (v === 'origin-when-crossorigin') return 'origin-when-cross-origin';
    if (v === 'no-referrer' || v === 'no-referrer-when-downgrade' || v === 'origin' || v === 'origin-when-cross-origin' || v === 'same-origin' || v === 'strict-origin' || v === 'strict-origin-when-cross-origin' || v === 'unsafe-url') return v;
    return '';
  }
  function syncBaseElement(node) {
    if (!node) return;
    if (node.localName === 'base' && Native.getAttribute.call(node, 'href')) updateVirtualBase(Native.getAttribute.call(node, 'href'));
    if (node.querySelectorAll) node.querySelectorAll('base[href]').forEach(el => updateVirtualBase(Native.getAttribute.call(el, 'href')));
  }
  function syncReferrerPolicyElement(node) {
    if (!node) return;
    if (node.localName === 'meta' && String(Native.getAttribute.call(node, 'name') || '').toLowerCase() === 'referrer') {
      const policy = normalizeReferrerPolicy(Native.getAttribute.call(node, 'content') || '');
      if (policy) documentReferrerPolicy = policy;
    }
    if (node.querySelectorAll) {
      const metas = node.querySelectorAll('meta[name]');
      for (let i = 0; i < metas.length; i++) syncReferrerPolicyElement(metas[i]);
    }
  }
  function installBaseObserver() {
    syncBaseElement(document);
    syncReferrerPolicyElement(document);
    const MO = root.MutationObserver;
    if (!MO || !document.documentElement) return;
    try {
      new MO(records => {
        for (const r of records) {
        if (r.type === 'attributes') { syncReferrerPolicyElement(r.target); enforceObservedAttribute(r.target, String(r.attributeName || '').toLowerCase()); }
          else for (const n of r.addedNodes || []) { syncBaseElement(n); syncReferrerPolicyElement(n); enforceSubtreePolicies(n); instrumentDescendantIframes(n); }
        }
      }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'xlink:href', 'src', 'srcset', 'srcdoc', 'action', 'formaction', 'poster', 'integrity', 'type', 'rel', 'target', 'style', 'name', 'content'] });
    } catch {}
  }
  function enforceObservedAttribute(el, key) {
    if (!el || !key) return;
    const localKey = attrLocalName(key);
    const tag = el.localName;
	    if (tag === 'base' && localKey === 'href') { syncBaseElement(el); return; }
	    if (tag === 'meta' && (localKey === 'name' || localKey === 'content')) { syncReferrerPolicyElement(el); return; }
	    if (localKey === 'style') {
	      const raw = Native.getAttribute.call(el, key);
	      if (raw) {
	        const next = rewriteCSSSource(raw);
	        if (next !== raw) Native.setAttribute.call(el, key, next);
	      }
	      return;
	    }
    if (tag === 'link' && (localKey === 'rel' || localKey === 'href')) { enforceLinkPolicy(el); return; }
    if (localKey === 'target' && isNavigationTargetElement(el)) { const raw = Native.getAttribute.call(el, key); if (raw && raw !== '_self') setSafeNavigationTarget(el, key, raw); return; }
    if (tag === 'script' && (localKey === 'src' || localKey === 'href' || localKey === 'type')) {
      const target = urlMeta.get(el) || Native.getAttribute.call(el, 'data-zp-target-url') || '';
      if (target && Native.getAttribute.call(el, 'src') === scriptProxyPath(target, executableScriptKindForElement(el) || 'classic')) return;
      const raw = target || Native.getAttribute.call(el, 'src') || Native.getAttribute.call(el, 'href');
      if (raw) setScriptSource(el, raw);
      return;
    }
    if (localKey === 'integrity' && isIntegrityBearing(el)) {
      const raw = Native.getAttribute.call(el, 'integrity');
      if (raw !== null) setBackedIntegrity(el, raw);
      return;
    }
    if ((tag === 'iframe' || tag === 'frame') && localKey === 'srcdoc') {
      const raw = Native.getAttribute.call(el, 'srcdoc');
      if (raw && !raw.startsWith(injectSrcdoc(''))) Native.setAttribute.call(el, 'srcdoc', injectSrcdoc(String(raw)));
      instrumentIframe(el);
      return;
    }
    if (isSrcsetAttribute(el, key)) {
      const raw = Native.getAttribute.call(el, key);
      if (raw && !Native.getAttribute.call(el, 'data-zp-target-srcset')) setSrcsetAttribute(el, key, raw);
      return;
    }
    if (!isURLBearing(el, key)) return;
    const raw = Native.getAttribute.call(el, key);
    if (shouldBlockURLAttribute(el, localKey, raw)) { blockExecutableURL(el, localKey, raw); return; }
    if (!raw || !isHTTPURL(raw) || String(raw).startsWith(proxyOrigin)) return;
    if (isResourceURLAttribute(el, key)) {
      if (!Native.getAttribute.call(el, 'data-zp-target-url')) setResourceURLAttribute(el, key, raw);
      return;
    }
    let target;
    try { target = targetURL(raw); } catch { return; }
    const alreadyMapped = urlMeta.get(el) === target && (!usesRawURLAttribute(el, key) ? Native.getAttribute.call(el, 'data-zp-target-url') === target : true);
    urlMeta.set(el, target);
    if (!usesRawURLAttribute(el, key)) Native.setAttribute.call(el, 'data-zp-target-url', target);
    if ((tag === 'iframe' || tag === 'frame') && localKey === 'src') {
      Native.setAttribute.call(el, key, 'about:blank');
      activatedFrameURL(target).then(u => { Native.setAttribute.call(el, key, u); rememberFrameOrigin(el); }).catch(()=>{});
      instrumentIframe(el);
      return;
    }
    if (alreadyMapped) return;
    if (!usesRawURLAttribute(el, key)) Native.setAttribute.call(el, key, target);
  }
  function enforceSubtreePolicies(node) {
    if (!node || typeof node !== 'object') return;
    if (node.nodeType === 1) enforceElementPolicy(node);
    if (node.querySelectorAll) node.querySelectorAll('script,link,iframe,frame,a,area,form,input,button,img,source,audio,video,track,svg a,svg image,svg use').forEach(enforceElementPolicy);
  }
  function enforceElementPolicy(el) {
    if (!el || !el.localName) return;
    if (el.localName === 'script') instrumentScriptElement(el);
    if (el.localName === 'link') enforceLinkPolicy(el);
    if (el.localName === 'iframe' || el.localName === 'frame') instrumentIframe(el);
    if (Native.getAttributeNames) {
      for (const name of Native.getAttributeNames.call(el)) enforceObservedAttribute(el, String(name).toLowerCase());
    }
  }

  function installWorkerHooks() {
    if (Native.Worker) define(root, 'Worker', function(url, opts) { return new Native.Worker(workerBootstrapURL(url), opts); });
    if (Native.SharedWorker) define(root, 'SharedWorker', function(url, opts) { return new Native.SharedWorker(workerBootstrapURL(url), opts); });
    if (navigator.serviceWorker && navigator.serviceWorker.register) define(navigator.serviceWorker, 'register', function() { return Promise.reject(normalizedError('NotSupportedError')); });
    if (Native.createObjectURL) define(URL, 'createObjectURL', function(blob) { if (blob && /javascript|ecmascript|text\/plain|application\/octet-stream|^$/i.test(blob.type || '')) { const blocked = new Blob(["self.__ZP_WORKER_TARGET=", JSON.stringify(virtualURL.href), ";\nself.__ZP_WORKER_TAB_ID=", JSON.stringify(boot.tabId), ";\nimportScripts('/zp/assets/worker-prelude.js');\nthrow new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');\n"], { type: 'text/javascript' }); const raw = Native.createObjectURL(blocked); workerBlobURLs.add(raw); return raw; } return Native.createObjectURL(blob); });
    for (const name of ['audioWorklet','paintWorklet','layoutWorklet','animationWorklet']) { const wk = root.CSS && root.CSS[name] || root[name]; if (wk && wk.addModule) define(wk, 'addModule', function(url, opts){ return wk.addModule(workerBootstrapURL(url), opts); }); }
  }
  function installTargetServiceWorkerBlocker(w) {
    const nav = w && w.navigator;
    if (!nav) return;
    if (serviceWorkerFacades.has(w)) return;
    const facade = {};
    const blockedReady = Promise.reject(normalizedError('NotSupportedError'));
    blockedReady.catch(()=>{});
    let oncontrollerchange = null;
    define(facade, 'register', function register() { return Promise.reject(normalizedError('NotSupportedError')); });
    define(facade, 'getRegistration', function getRegistration() { return Promise.resolve(undefined); });
    define(facade, 'getRegistrations', function getRegistrations() { return Promise.resolve([]); });
    define(facade, 'startMessages', function startMessages() {});
    define(facade, 'addEventListener', function addEventListener() {});
    define(facade, 'removeEventListener', function removeEventListener() {});
    defineAccessor(facade, 'controller', () => null);
    defineAccessor(facade, 'ready', () => blockedReady);
    defineAccessor(facade, 'oncontrollerchange', () => oncontrollerchange, v => { oncontrollerchange = typeof v === 'function' ? v : null; });
    const existing = (() => { try { return nav.serviceWorker; } catch { return null; } })();
    if (existing && existing !== facade) {
      define(existing, 'register', facade.register);
      define(existing, 'getRegistration', facade.getRegistration);
      define(existing, 'getRegistrations', facade.getRegistrations);
      define(existing, 'startMessages', facade.startMessages);
      defineAccessor(existing, 'controller', () => null);
      defineAccessor(existing, 'ready', () => blockedReady);
      defineAccessor(existing, 'oncontrollerchange', () => oncontrollerchange, v => { oncontrollerchange = typeof v === 'function' ? v : null; });
    }
    serviceWorkerFacades.set(w, facade);
    const proto = w.Navigator && w.Navigator.prototype || Object.getPrototypeOf(nav);
    defineAccessor(proto, 'serviceWorker', () => facade);
    defineAccessor(nav, 'serviceWorker', () => facade);
  }
  function workerBootstrapURL(url) {
    const raw = String(url);
    const parsed = new URL(raw, virtualURL.href);
    if (parsed.protocol === 'blob:') {
      if (!workerBlobURLs.has(parsed.href)) throw normalizedError('NotSupportedError');
      return parsed.href;
    }
    if (parsed.protocol === 'data:') return dataWorkerURL(parsed.href);
    const params = new URLSearchParams();
    params.set('u', requestTargetURL(raw));
    params.set('tab', boot.tabId);
    params.set('rt', runtimeToken);
    for (const server of activeServers) params.append('server', server);
    return ZP.controlPath('worker-bootstrap.js') + '#' + params.toString();
  }
  function dataWorkerURL(raw) {
    const comma = raw.indexOf(',');
    if (comma < 0) throw normalizedError('NotSupportedError');
    const blocked = new Blob(["self.__ZP_WORKER_TARGET=", JSON.stringify(virtualURL.href), ";\nself.__ZP_WORKER_TAB_ID=", JSON.stringify(boot.tabId), ";\nimportScripts('/zp/assets/worker-prelude.js');\nthrow new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');\n"], { type: 'text/javascript' });
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
    const nativeCreateElementNS = w === root ? Native.createElementNS : w.document.createElementNS && w.document.createElementNS.bind(w.document);

    installFrameAccessors(w.HTMLIFrameElement && w.HTMLIFrameElement.prototype);
    installFrameAccessors(w.HTMLFrameElement && w.HTMLFrameElement.prototype);

    define(w.document, 'createElement', function(name, opts) {
      const el = nativeCreateElement(String(name), opts);
      if (/^i?frame$/i.test(String(name))) instrumentDescendantIframes(el);
      if (/^script$/i.test(String(name))) instrumentScriptElement(el);
      return el;
    });
    if (nativeCreateElementNS) define(w.document, 'createElementNS', function(ns, name, opts) {
      const el = nativeCreateElementNS(String(ns), String(name), opts);
      if (/^script$/i.test(String(name))) instrumentScriptElement(el);
      return el;
    });

    patchInsertion(w.Node.prototype, 'appendChild', w.Node.prototype.appendChild);
    patchInsertion(w.Node.prototype, 'insertBefore', w.Node.prototype.insertBefore);
    patchInsertion(w.Node.prototype, 'replaceChild', w.Node.prototype.replaceChild);
    for (const proto of [w.Element && w.Element.prototype, w.Document && w.Document.prototype, w.DocumentFragment && w.DocumentFragment.prototype]) {
      for (const method of ['append', 'prepend', 'before', 'after', 'replaceWith']) patchInsertion(proto, method, proto && proto[method]);
    }

    if (w.HTMLIFrameElement) { installFrameProp(w.HTMLIFrameElement.prototype, 'src'); installFrameProp(w.HTMLIFrameElement.prototype, 'srcdoc'); }
    if (w.HTMLFrameElement) installFrameProp(w.HTMLFrameElement.prototype, 'src');

    function patchInsertion(proto, name, nativeFn) {
      if (!proto || typeof nativeFn !== 'function') return;
      define(proto, name, function(...args) {
        prepareActivatingNodes(args);
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
              const t = targetURL(v);
              urlMeta.set(this, t);
              Native.setAttribute.call(this, 'data-zp-target-url', t);
              d.set.call(this, 'about:blank');
              activatedFrameURL(t).then(u => { d.set.call(this, u); rememberFrameOrigin(this); }).catch(()=>{});
            } else d.set.call(this, v);
            instrumentIframe(this);
          },
          configurable: false
        });
      } catch {}
    }
  }
  function prepareActivatingNodes(args) {
    for (const node of args || []) prepareActivatingNode(node);
  }
  function prepareActivatingNode(node) {
    if (!node || typeof node !== 'object') return;
    if ((node.nodeName || '').toUpperCase() === 'SCRIPT') prepareScriptElement(node);
    if (node.querySelectorAll) {
      const scripts = node.querySelectorAll('script');
      for (let i = 0; i < scripts.length; i++) prepareScriptElement(scripts[i]);
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
      rememberFrameOrigin(frame);
      if ((!src || /^about:blank$/i.test(src)) && frame.contentWindow) installNetworkContainment(frame.contentWindow);
    } catch { try { frame.remove(); } catch {} }
  }
  function installNetworkContainment(w) {
    if (!w) return;
    try { if (w[networkContainmentMarker]) return; } catch {}
    installToStringMasking(w);
    const childFunction = w.Function;
    if (root.eval && !define(w, 'eval', root.eval)) throw normalizedError('SecurityError');
    if (root.Function && !define(w, 'Function', root.Function)) throw normalizedError('SecurityError');
    if (childFunction && childFunction.prototype) try { Object.defineProperty(childFunction.prototype, 'constructor', { value: root.Function, enumerable: false, configurable: false, writable: false }); } catch {}
    if (root.fetch && !define(w, 'fetch', root.fetch.bind(root))) throw normalizedError('SecurityError');
    installNavigatorIdentity(w);
    installGetterMasking(w);
    installStorageFacades(w);
    installPostMessageHooks(w);
    if (root.XMLHttpRequest && !define(w, 'XMLHttpRequest', root.XMLHttpRequest)) throw normalizedError('SecurityError');
    if (root.EventSource && !define(w, 'EventSource', root.EventSource)) throw normalizedError('SecurityError');
    if (root.WebSocket && !define(w, 'WebSocket', root.WebSocket)) throw normalizedError('SecurityError');
    if (w.navigator && navigator.sendBeacon) define(w.navigator, 'sendBeacon', navigator.sendBeacon.bind(navigator));
    installOwnPropertyMasking(w);
    installDOMHooks(w);
    installStealthMembrane(w);
    installTargetServiceWorkerBlocker(w);
    installIframeHooks(w);
    installBlockers(w, true);
    installCanvasAntiFingerprinting(w);
    installAudioAntiFingerprinting(w);
    try { Object.defineProperty(w, networkContainmentMarker, { value: true, enumerable: false, configurable: false }); } catch {}
  }

  function installBlockers(w, strict = false) {
    for (const name of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','WebTransport']) {
      const blockCtor = function(){ throw normalizedError('NotSupportedError'); };
      const ok = define(w, name, blockCtor);
      if (strict && name in w && !ok) throw normalizedError('SecurityError');
    }
    if (root.WebSocketStream && !define(w, 'WebSocketStream', root.WebSocketStream) && strict) throw normalizedError('SecurityError');
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
  function removeBootstrapArtifacts() {
    try {
      const nodes = document.querySelectorAll && document.querySelectorAll('script[src*="/zp/assets/zp-core.js"],script[src*="/zp/assets/rust-rewriter.js"],script[src*="/zp/assets/runtime-prelude.js"]');
      if (nodes) nodes.forEach(node => { try { node.remove(); } catch {} });
    } catch {}
  }
  try { const current = document.currentScript; if (current && /\/zp\/assets\/runtime-prelude\.js(?:$|\?)/.test(current.src || '')) current.remove(); } catch {}
})();
