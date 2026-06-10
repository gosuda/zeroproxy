import { decodeFetchMessages } from '../resources/loader.mjs';

export const NETWORK_API_SOURCE = String.raw`
(() => {
  const pendingFetches = new Map();
  const pendingWebSockets = new Map();
  const activeWebSockets = new Map();

  let nextMultipartBoundary = 1;
  class VirtualEvent {
    constructor(type, init = {}) {
      this.type = String(type || '');
      this.bubbles = init.bubbles !== false;
      this.cancelable = init.cancelable !== false;
      this.defaultPrevented = false;
      this.target = null;
      this.currentTarget = null;
      this.data = init.data;
      this.error = init.error;
    }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  }

  class MessageEvent extends VirtualEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.data = init.data;
      this.origin = String(init.origin || '');
      this.lastEventId = String(init.lastEventId || '');
      this.source = init.source || null;
      this.ports = init.ports || [];
    }
  }
  Object.defineProperty(MessageEvent.prototype, Symbol.toStringTag, { value: 'MessageEvent', configurable: true });

  const closeEventState = new WeakMap();
  class CloseEvent extends (globalThis.Event || VirtualEvent) {
    constructor(type, init = {}) {
      if (arguments.length < 1) throw new TypeError("Failed to construct 'CloseEvent': 1 argument required, but only 0 present.");
      super(type, init);
      delete this.code;
      delete this.reason;
      delete this.wasClean;
      closeEventState.set(this, {
        wasClean: Boolean(init.wasClean),
        code: Number(init.code || 0),
        reason: String(init.reason || ''),
      });
    }
  }
  function closeEventValue(event, key) {
    const state = closeEventState.get(event);
    if (!state) throw new TypeError('Illegal invocation');
    return state[key];
  }
  const closeEventConstructorDescriptor = Object.getOwnPropertyDescriptor(CloseEvent.prototype, 'constructor');
  delete CloseEvent.prototype.constructor;
  for (const key of ['wasClean', 'code', 'reason']) {
    Object.defineProperty(CloseEvent.prototype, key, { get() { return closeEventValue(this, key); }, enumerable: true, configurable: true });
  }
  Object.defineProperty(CloseEvent.prototype, 'constructor', closeEventConstructorDescriptor);
  Object.defineProperty(CloseEvent.prototype, Symbol.toStringTag, { value: 'CloseEvent', configurable: true });


  const eventTargetListeners = new WeakMap();
  function eventTargetListenerBucket(target, type) {
    let byType = eventTargetListeners.get(target);
    if (!byType) eventTargetListeners.set(target, byType = new Map());
    const key = String(type);
    let bucket = byType.get(key);
    if (!bucket) byType.set(key, bucket = []);
    return bucket;
  }
  class VirtualEventTarget {
    addEventListener(type, callback, options = {}) {
      if (typeof callback !== 'function' && !callback?.handleEvent) return;
      const bucket = eventTargetListenerBucket(this, type);
      if (!bucket.some((entry) => entry.callback === callback)) bucket.push({ callback, once: Boolean(options?.once) });
    }
    removeEventListener(type, callback) {
      const bucket = eventTargetListenerBucket(this, type);
      const index = bucket.findIndex((entry) => entry.callback === callback);
      if (index >= 0) bucket.splice(index, 1);
    }
    dispatchEvent(event) {
      const ev = event instanceof VirtualEvent || typeof event?.type === 'string' ? event : new VirtualEvent(event?.type || event);
      try { ev.target = ev.target || this; } catch {}
      try { ev.currentTarget = this; } catch {}
      const bucket = [...eventTargetListenerBucket(this, ev.type)];
      for (const entry of bucket) {
        if (typeof entry.callback === 'function') entry.callback.call(this, ev);
        else entry.callback.handleEvent(ev);
        if (entry.once) this.removeEventListener(ev.type, entry.callback);
      }
      const handler = this['on' + ev.type];
      if (typeof handler === 'function' && handler.call(this, ev) === false) ev.preventDefault();
      return !ev.defaultPrevented;
    }
  }
  Object.defineProperty(VirtualEventTarget, 'name', { value: 'EventTarget', configurable: true });

  const xhrEventTargetToken = {};
  const xhrEventHandlerProps = ['onloadstart', 'onprogress', 'onabort', 'onerror', 'onload', 'ontimeout', 'onloadend'];
  const XHREventTargetBase = globalThis.EventTarget || VirtualEventTarget;
  class XMLHttpRequestEventTarget extends XHREventTargetBase {
    constructor(token) {
      if (token !== xhrEventTargetToken) throw new TypeError("Failed to construct 'XMLHttpRequestEventTarget': Illegal constructor");
      super();
      initializeXHREventHandlers(this);
    }
  }
  Object.defineProperty(XMLHttpRequestEventTarget.prototype, Symbol.toStringTag, { value: 'XMLHttpRequestEventTarget', configurable: true });

  class XMLHttpRequestUpload extends XMLHttpRequestEventTarget {
    constructor(token) {
      if (token !== xhrEventTargetToken) throw new TypeError("Failed to construct 'XMLHttpRequestUpload': Illegal constructor");
      super(token);
    }
  }
  Object.defineProperty(XMLHttpRequestUpload.prototype, Symbol.toStringTag, { value: 'XMLHttpRequestUpload', configurable: true });

  function initializeXHREventHandlers(target) {
    for (const prop of xhrEventHandlerProps) target[prop] = null;
  }

  function dispatchXHREvent(target, type) {
    target.dispatchEvent(new VirtualEvent(type));
  }

  class Headers {
    constructor(init) { this.__zpItems = []; if (init) appendHeaders(this, init); }
    append(name, value) { this.__zpItems.push([normalizeName(name), String(value)]); }
    delete(name) { const key = normalizeName(name); this.__zpItems = this.__zpItems.filter(([item]) => item !== key); }
    get(name) { const key = normalizeName(name); const values = this.__zpItems.filter(([item]) => item === key).map(([, value]) => value); return values.length ? values.join(', ') : null; }
    has(name) { const key = normalizeName(name); return this.__zpItems.some(([item]) => item === key); }
    set(name, value) { this.delete(name); this.append(name, value); }
    entries() { return this.__zpItems[Symbol.iterator](); }
    keys() { return this.__zpItems.map(([name]) => name)[Symbol.iterator](); }
    values() { return this.__zpItems.map(([, value]) => value)[Symbol.iterator](); }
    forEach(callback, thisArg = undefined) { for (const [name, value] of this.__zpItems) callback.call(thisArg, value, name, this); }
    getSetCookie() { return this.__zpItems.filter(([name]) => name === 'set-cookie').map(([, value]) => value); }
    [Symbol.iterator]() { return this.entries(); }
  }
  Object.defineProperty(Headers.prototype, Symbol.iterator, { value: Headers.prototype.entries, writable: true, configurable: true });
  Object.defineProperty(Headers.prototype, Symbol.toStringTag, { value: 'Headers', configurable: true });

  function headersEntries(headers) {
    return headers instanceof Headers ? [...headers.__zpItems] : [];
  }


  class BodyReadableStream {
    constructor(owner, label) { this.__zpOwner = owner; this.__zpLabel = label; }
    getReader() { return new BodyStreamReader(this.__zpOwner, this.__zpLabel); }
    async *[Symbol.asyncIterator]() {
      const chunk = consumeBody(this.__zpOwner, this.__zpLabel);
      if (chunk.length) yield new Uint8Array(chunk);
    }
  }
  Object.defineProperty(BodyReadableStream.prototype, Symbol.toStringTag, { value: 'ReadableStream', configurable: true });

  class BodyStreamReader {
    constructor(owner, label) { this.__zpOwner = owner; this.__zpLabel = label; this.__zpDone = false; }
    async read() {
      if (this.__zpDone) return { value: undefined, done: true };
      this.__zpDone = true;
      const chunk = consumeBody(this.__zpOwner, this.__zpLabel);
      return { value: new Uint8Array(chunk), done: false };
    }
    async cancel() { this.__zpDone = true; }
    releaseLock() {}
  }

  const abortSignalState = new WeakMap();
  function AbortSignal() {
    throw new TypeError('Use \`new AbortSignal(...)\` instead of \`AbortSignal(...)\`');
  }
  Object.setPrototypeOf(AbortSignal.prototype, VirtualEventTarget.prototype);
  Object.defineProperty(AbortSignal, Symbol.hasInstance, { value: (value) => abortSignalState.has(value), configurable: true });
  Object.defineProperties(AbortSignal.prototype, {
    aborted: { get() { return abortSignalValue(this, 'aborted'); }, enumerable: true, configurable: true },
    reason: { get() { return abortSignalValue(this, 'reason'); }, enumerable: true, configurable: true },
    onabort: {
      get() { return abortSignalValue(this, 'onabort'); },
      set(value) { abortSignalRecord(this).onabort = typeof value === 'function' ? value : null; },
      enumerable: true,
      configurable: true,
    },
    throwIfAborted: {
      value: function throwIfAborted() {
        const state = abortSignalRecord(this);
        if (state.aborted) throw state.reason;
      },
      enumerable: true,
      configurable: true,
      writable: true,
    },
    [Symbol.toStringTag]: { value: 'AbortSignal', configurable: true },
  });
  function makeAbortSignal() {
    const signal = Object.create(AbortSignal.prototype);
    abortSignalState.set(signal, { aborted: false, reason: undefined, onabort: null });
    return signal;
  }
  function abortSignalRecord(signal) {
    const state = abortSignalState.get(signal);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }
  function abortSignalValue(signal, key) {
    return abortSignalRecord(signal)[key];
  }
  function abortSignalAbort(signal, reason = abortReason()) {
    const state = abortSignalRecord(signal);
    if (state.aborted) return;
    state.aborted = true;
    state.reason = reason;
    signal.dispatchEvent(new VirtualEvent('abort', { bubbles: false, cancelable: false }));
  }
  function validateAbortSignalSequence(signals) {
    if (signals == null || typeof signals[Symbol.iterator] !== 'function') {
      throw new TypeError('signals can not be converted to sequence');
    }
    return signals;
  }
  function validateAbortSignalTimeout(milliseconds) {
    const value = Number(milliseconds);
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      throw new TypeError('Value ' + milliseconds + ' is outside the range [0, 9007199254740991]');
    }
    return value;
  }
  AbortSignal.abort = function abort(reason = abortReason()) { const signal = makeAbortSignal(); abortSignalAbort(signal, reason); return signal; };
  AbortSignal.timeout = function timeout(milliseconds) {
    const delay = validateAbortSignalTimeout(milliseconds);
    const signal = makeAbortSignal();
    if (typeof setTimeout === 'function') setTimeout(() => abortSignalAbort(signal, timeoutReason()), delay);
    else abortSignalAbort(signal, timeoutReason());
    return signal;
  };
  AbortSignal.any = function any(signals) {
    const signal = makeAbortSignal();
    for (const input of validateAbortSignalSequence(signals)) {
      if (input?.aborted) { abortSignalAbort(signal, input.reason); break; }
      input?.addEventListener?.('abort', () => abortSignalAbort(signal, input.reason), { once: true });
    }
    return signal;
  };

  const abortControllerState = new WeakMap();
  class AbortController {
    constructor() { abortControllerState.set(this, { signal: makeAbortSignal() }); }
    get signal() { return abortControllerValue(this).signal; }
    abort(reason = abortReason()) { abortSignalAbort(this.signal, reason); }
  }
  function abortControllerValue(controller) {
    const state = abortControllerState.get(controller);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }
  Object.defineProperty(AbortController.prototype, Symbol.toStringTag, { value: 'AbortController', configurable: true });
  for (const key of ['signal', 'abort']) {
    const descriptor = Object.getOwnPropertyDescriptor(AbortController.prototype, key);
    Object.defineProperty(AbortController.prototype, key, { ...descriptor, enumerable: true, configurable: true });
  }

  function defineOwn(value, key, propertyValue) {
    Object.defineProperty(value, key, { value: propertyValue, enumerable: true, writable: true, configurable: true });
  }
  function ownValue(value, key, fallback) {
    return objectHasOwn(value, key) ? value[key] : fallback;
  }

  class Request {
    constructor(input, init = {}) {
      const source = input instanceof Request ? input : null;
      const bodyPresent = objectHasOwn(init, 'body');
      defineOwn(this, 'url', source ? source.url : resolveURL(String(input || '')));
      defineOwn(this, 'method', String(init.method || source?.method || 'GET').toUpperCase());
      defineOwn(this, 'headers', new Headers(source ? source.headers : undefined));
      if (init.headers) appendHeaders(this.headers, init.headers);
      const mode = objectHasOwn(init, 'mode') ? init.mode : source?.mode || 'cors';
      const cache = objectHasOwn(init, 'cache') ? init.cache : source?.cache || 'default';
      defineOwn(this, 'mode', validateRequestMode(mode));
      defineOwn(this, 'cache', validateRequestCache(cache, this.mode));
      defineOwn(this, 'credentials', validateRequestCredentials(objectHasOwn(init, 'credentials') ? init.credentials : source?.credentials || 'same-origin'));
      const redirect = objectHasOwn(init, 'redirect') ? init.redirect : source?.redirect || 'follow';
      defineOwn(this, 'redirect', validateRequestRedirect(redirect));
      defineOwn(this, 'referrer', objectHasOwn(init, 'referrer') ? (init.referrer === '' ? '' : resolveURL(init.referrer)) : source?.referrer || 'about:client');
      defineOwn(this, 'referrerPolicy', init.referrerPolicy || source?.referrerPolicy || '');
      defineOwn(this, 'signal', init.signal || source?.signal || null);
      if ((this.method === 'GET' || this.method === 'HEAD') && bodyPresent && init.body != null)
        throw new TypeError("Failed to construct 'Request': Request with GET/HEAD method cannot have body.");
      if (source?.bodyUsed && !bodyPresent) throw new TypeError("Failed to construct 'Request': Cannot construct a Request with a Request object that has already been used.");
      const body = bodyPresent ? init.body : source ? source.__zpBodyBytes : '';
      const normalized = normalizeBody(body, source?.__zpBodyType || '');
      this.__zpBodyBytes = normalized.bytes;
      this.__zpBodyType = normalized.type;
      if (normalized.type && !this.headers.has('content-type')) this.headers.set('content-type', normalized.type);
      defineOwn(this, 'body', bodyStream(this, 'Request'));
      defineOwn(this, 'bodyUsed', false);
    }
    clone() {
      if (this.bodyUsed) throw new TypeError("Failed to execute 'clone' on 'Request': Request body is already used");
      return new Request(this);
    }
    text() { return Promise.resolve(consumeBody(this, 'Request')).then(decodeUTF8); }
    json() { return this.text().then((text) => JSON.parse(text)); }
    arrayBuffer() { return Promise.resolve(bytesToArrayBuffer(consumeBody(this, 'Request'))); }
    blob() { return Promise.resolve(blobFromBytes(consumeBody(this, 'Request'), this.__zpBodyType)); }
    formData() { return Promise.resolve(bodyFormData(this, 'Request')); }
  }

  Object.defineProperties(Request.prototype, {
    body: { get() { return ownValue(this, 'body', null); }, enumerable: true, configurable: true },
    bodyUsed: { get() { return ownValue(this, 'bodyUsed', false); }, enumerable: true, configurable: true },
    bytes: { value: function bytes() { return this.arrayBuffer().then((buffer) => new Uint8Array(buffer)); }, enumerable: true, writable: true, configurable: true },
    cache: { get() { return ownValue(this, 'cache', 'default'); }, enumerable: true, configurable: true },
    credentials: { get() { return ownValue(this, 'credentials', 'same-origin'); }, enumerable: true, configurable: true },
    destination: { get() { return ''; }, enumerable: true, configurable: true },
    duplex: { get() { return 'half'; }, enumerable: true, configurable: true },
    headers: { get() { return ownValue(this, 'headers', undefined); }, enumerable: true, configurable: true },
    integrity: { get() { return ''; }, enumerable: true, configurable: true },
    isHistoryNavigation: { get() { return false; }, enumerable: true, configurable: true },
    keepalive: { get() { return false; }, enumerable: true, configurable: true },
    method: { get() { return ownValue(this, 'method', 'GET'); }, enumerable: true, configurable: true },
    mode: { get() { return ownValue(this, 'mode', 'cors'); }, enumerable: true, configurable: true },
    redirect: { get() { return ownValue(this, 'redirect', 'follow'); }, enumerable: true, configurable: true },
    referrer: { get() { return ownValue(this, 'referrer', 'about:client'); }, enumerable: true, configurable: true },
    referrerPolicy: { get() { return ownValue(this, 'referrerPolicy', ''); }, enumerable: true, configurable: true },
    signal: { get() { return ownValue(this, 'signal', null); }, enumerable: true, configurable: true },
    targetAddressSpace: { get() { return 'unknown'; }, enumerable: true, configurable: true },
    url: { get() { return ownValue(this, 'url', ''); }, enumerable: true, configurable: true },
    [Symbol.toStringTag]: { value: 'Request', configurable: true },
  });

  class Response {
    constructor(body = '', init = {}) {
      const status = objectHasOwn(init, 'status') ? Number(init.status) : 200;
      if (!init.__zpInternalStatus && (status < 200 || status > 599))
        throw new RangeError("Failed to construct 'Response': The status provided (" + status + ") is outside the range [200, 599].");
      const normalized = normalizeBody(body, '');
      this.__zpBodyBytes = normalized.bytes;
      this.__zpBodyType = normalized.type;
      this.__zpBody = decodeUTF8(this.__zpBodyBytes);
      defineOwn(this, 'body', bodyStream(this, 'Response'));
      defineOwn(this, 'bodyUsed', false);
      defineOwn(this, 'status', status);
      defineOwn(this, 'statusText', String(init.statusText || ''));
      defineOwn(this, 'headers', new Headers(init.headers || []));
      defineOwn(this, 'url', String(init.url || ''));
      defineOwn(this, 'redirected', Boolean(init.redirected));
      this.timing = init.timing || null;
      defineOwn(this, 'type', init.type || 'default');
    }
    get ok() { return this.status >= 200 && this.status < 300; }
    clone() {
      if (this.bodyUsed) throw new TypeError("Failed to execute 'clone' on 'Response': Response body is already used");
      return new Response(this.__zpBodyBytes, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url, redirected: this.redirected, timing: this.timing, type: this.type });
    }
    text() { return Promise.resolve(consumeBody(this, 'Response')).then(decodeUTF8); }
    json() { return this.text().then((text) => JSON.parse(text)); }
    arrayBuffer() { return Promise.resolve(bytesToArrayBuffer(consumeBody(this, 'Response'))); }
    blob() {
      const type = this.headers.get('content-type') || this.__zpBodyType;
      return Promise.resolve(blobFromBytes(consumeBody(this, 'Response'), type || ''));
    }
    formData() { return Promise.resolve(bodyFormData(this, 'Response')); }
    static error() { return new Response('', { status: 0, statusText: '', type: 'error', __zpInternalStatus: true }); }
    static redirect(url, status = 302) {
      const code = Number(status);
      if (code !== 301 && code !== 302 && code !== 303 && code !== 307 && code !== 308)
        throw new RangeError("Failed to execute 'redirect' on 'Response': Invalid status code");
      return new Response('', { status: code, headers: [['location', resolveURL(url)]] });
    }
  }

  Response.json = function json(data, init = {}) {
    const headers = new Headers(init.headers || []);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(data), { ...init, headers });
  };
  Object.defineProperties(Response.prototype, {
    body: { get() { return ownValue(this, 'body', null); }, enumerable: true, configurable: true },
    bodyUsed: { get() { return ownValue(this, 'bodyUsed', false); }, enumerable: true, configurable: true },
    bytes: { value: function bytes() { return this.arrayBuffer().then((buffer) => new Uint8Array(buffer)); }, enumerable: true, writable: true, configurable: true },
    headers: { get() { return ownValue(this, 'headers', undefined); }, enumerable: true, configurable: true },
    redirected: { get() { return ownValue(this, 'redirected', false); }, enumerable: true, configurable: true },
    status: { get() { return ownValue(this, 'status', 200); }, enumerable: true, configurable: true },
    statusText: { get() { return ownValue(this, 'statusText', ''); }, enumerable: true, configurable: true },
    type: { get() { return ownValue(this, 'type', 'default'); }, enumerable: true, configurable: true },
    url: { get() { return ownValue(this, 'url', ''); }, enumerable: true, configurable: true },
    [Symbol.toStringTag]: { value: 'Response', configurable: true },
  });

  function xhrReadyState(xhr) { xhr.dispatchEvent(new VirtualEvent('readystatechange')); }
  class XMLHttpRequest extends XMLHttpRequestEventTarget {
    constructor() {
      super(xhrEventTargetToken);
      defineOwn(this, 'readyState', XMLHttpRequest.UNSENT);
      defineOwn(this, 'status', 0);
      defineOwn(this, 'statusText', '');
      defineOwn(this, 'responseText', '');
      defineOwn(this, 'responseURL', '');
      defineOwn(this, 'requestHeaders', new Headers());
      defineOwn(this, 'responseHeaders', new Headers());
      defineOwn(this, 'timeout', 0);
      defineOwn(this, 'withCredentials', false);
      defineOwn(this, 'responseType', '');
      defineOwn(this, 'responseXML', null);
      defineOwn(this, 'onreadystatechange', null);
      defineOwn(this, 'upload', new XMLHttpRequestUpload(xhrEventTargetToken));
    }
    open(method, url, async = true) { if (async === false) throw new Error('SYNC_XHR_BLOCKED'); this.method = method; this.url = resolveURL(url); this.readyState = XMLHttpRequest.OPENED; xhrReadyState(this); }
    setRequestHeader(name, value) { this.requestHeaders.append(name, value); }
    getAllResponseHeaders() { return headersEntries(this.responseHeaders).map(([name, value]) => name + ': ' + value + '\r\n').join(''); }
    getResponseHeader(name) { return this.responseHeaders.get(name); }
    overrideMimeType(mime) { this.__zpOverrideMimeType = String(mime); }
    send(body = '') {
      const controller = new AbortController();
      this.__zpController = controller;
      const init = { method: this.method || 'GET', headers: this.requestHeaders, signal: controller.signal };
      const hasUploadBody = String(init.method).toUpperCase() !== 'GET' && String(init.method).toUpperCase() !== 'HEAD';
      if (hasUploadBody) {
        init.body = body;
        dispatchXHREvent(this.upload, 'loadstart');
      }
      dispatchXHREvent(this, 'loadstart');
      fetch(new Request(this.url, init)).then((response) => {
        this.status = response.status;
        this.statusText = response.statusText;
        this.responseURL = response.url;
        this.responseHeaders = response.headers;
        this.readyState = 2;
        xhrReadyState(this);
        return response.text();
      }).then((text) => {
        this.responseText = text;
        this.readyState = 4;
        xhrReadyState(this);
        if (hasUploadBody) {
          dispatchXHREvent(this.upload, 'load');
          dispatchXHREvent(this.upload, 'loadend');
        }
        dispatchXHREvent(this, 'load');
        dispatchXHREvent(this, 'loadend');
      }).catch((error) => {
        this.readyState = 4;
        xhrReadyState(this);
        const type = error?.name === 'AbortError' ? 'abort' : 'error';
        if (hasUploadBody) {
          dispatchXHREvent(this.upload, type);
          dispatchXHREvent(this.upload, 'loadend');
        }
        dispatchXHREvent(this, type);
        dispatchXHREvent(this, 'loadend');
      });
    }
    abort() { this.__zpController?.abort(); dispatchXHREvent(this, 'abort'); }
  }
  Object.defineProperty(XMLHttpRequest.prototype, Symbol.toStringTag, { value: 'XMLHttpRequest', configurable: true });
  for (const [key, value] of [['UNSENT', 0], ['OPENED', 1], ['HEADERS_RECEIVED', 2], ['LOADING', 3], ['DONE', 4]]) {
    Object.defineProperty(XMLHttpRequest, key, { value, enumerable: true, writable: false, configurable: false });
    Object.defineProperty(XMLHttpRequest.prototype, key, { value, enumerable: true, writable: false, configurable: false });
  }
  Object.defineProperties(XMLHttpRequest.prototype, {
    readyState: { get() { return ownValue(this, 'readyState', XMLHttpRequest.UNSENT); }, enumerable: true, configurable: true },
    response: { get() { return ownValue(this, 'responseText', ''); }, enumerable: true, configurable: true },
    responseText: { get() { return ownValue(this, 'responseText', ''); }, enumerable: true, configurable: true },
    onreadystatechange: { get() { return ownValue(this, 'onreadystatechange', null); }, set(value) { defineOwn(this, 'onreadystatechange', value); }, enumerable: true, configurable: true },
    responseType: { get() { return ownValue(this, 'responseType', ''); }, set(value) { defineOwn(this, 'responseType', String(value)); }, enumerable: true, configurable: true },
    responseURL: { get() { return ownValue(this, 'responseURL', ''); }, enumerable: true, configurable: true },
    responseXML: { get() { return ownValue(this, 'responseXML', null); }, enumerable: true, configurable: true },
    status: { get() { return ownValue(this, 'status', 0); }, enumerable: true, configurable: true },
    statusText: { get() { return ownValue(this, 'statusText', ''); }, enumerable: true, configurable: true },
    timeout: { get() { return ownValue(this, 'timeout', 0); }, set(value) { defineOwn(this, 'timeout', Number(value) || 0); }, enumerable: true, configurable: true },
    upload: { get() { return ownValue(this, 'upload', null); }, enumerable: true, configurable: true },
    withCredentials: { get() { return ownValue(this, 'withCredentials', false); }, set(value) { defineOwn(this, 'withCredentials', Boolean(value)); }, enumerable: true, configurable: true },
  });

  class EventSource extends VirtualEventTarget {
    constructor(url) {
      super();
      defineOwn(this, 'url', resolveURL(url));
      defineOwn(this, 'readyState', 0);
      defineOwn(this, 'withCredentials', false);
      defineOwn(this, 'onopen', null);
      defineOwn(this, 'onmessage', null);
      defineOwn(this, 'onerror', null);
      fetch(this.url).then((response) => response.text()).then((text) => {
        this.readyState = EventSource.OPEN;
        this.dispatchEvent(new VirtualEvent('open'));
        for (const data of parseSSE(text)) this.dispatchEvent(new MessageEvent('message', { data }));
      }).catch((error) => { this.readyState = EventSource.CLOSED; this.dispatchEvent(new VirtualEvent('error', { error })); });
    }
    close() { this.readyState = EventSource.CLOSED; }
  }
  for (const [key, value] of [['CONNECTING', 0], ['OPEN', 1], ['CLOSED', 2]]) {
    Object.defineProperty(EventSource, key, { value, enumerable: true, writable: false, configurable: false });
    Object.defineProperty(EventSource.prototype, key, { value, enumerable: true, writable: false, configurable: false });
  }
  Object.defineProperties(EventSource.prototype, {
    url: { get() { return ownValue(this, 'url', ''); }, enumerable: true, configurable: true },
    readyState: { get() { return ownValue(this, 'readyState', EventSource.CLOSED); }, enumerable: true, configurable: true },
    withCredentials: { get() { return ownValue(this, 'withCredentials', false); }, enumerable: true, configurable: true },
    onopen: { get() { return ownValue(this, 'onopen', null); }, set(value) { defineOwn(this, 'onopen', value); }, enumerable: true, configurable: true },
    onmessage: { get() { return ownValue(this, 'onmessage', null); }, set(value) { defineOwn(this, 'onmessage', value); }, enumerable: true, configurable: true },
    onerror: { get() { return ownValue(this, 'onerror', null); }, set(value) { defineOwn(this, 'onerror', value); }, enumerable: true, configurable: true },
    [Symbol.toStringTag]: { value: 'EventSource', configurable: true },
  });

  class WebSocket extends VirtualEventTarget {
    constructor(...args) {
      super();
      if (args.length < 1) throw new TypeError("Failed to construct 'WebSocket': 1 argument required, but only 0 present.");
      const [url, protocols = []] = args;
      this.url = resolveURL(url).replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
      this.protocol = '';
      this.extensions = '';
      this.__zpBinaryType = 'blob';
      this.bufferedAmount = 0;
      this.readyState = WebSocket.CONNECTING;
      const wsId = __zpWebSocketOpen(JSON.stringify({ url: this.url, protocols: webSocketProtocolList(protocols) }));
      this.__zpWsId = wsId;
      pendingWebSockets.set(wsId, this);
    }
    get binaryType() { return this.__zpBinaryType || 'blob'; }
    set binaryType(value) {
      if (value === 'blob' || value === 'arraybuffer') this.__zpBinaryType = value;
    }
    send(data) {
      if (this.readyState === WebSocket.CONNECTING) throw invalidStateError("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.");
      const payload = webSocketSendPayload(data);
      if (this.readyState !== WebSocket.OPEN) {
        this.bufferedAmount += payload.byteLength;
        return;
      }
      this.bufferedAmount += payload.byteLength;
      __zpWebSocketSend(JSON.stringify({ wsId: this.__zpWsId, ...payload }));
    }
    close(code = 1000, reason = '') {
      if (this.readyState === WebSocket.CLOSING || this.readyState === WebSocket.CLOSED) return;
      validateCloseCode(code);
      const text = reason === undefined ? '' : String(reason);
      validateCloseReason(text);
      this.readyState = WebSocket.CLOSING;
      if (!this.__zpWsId || pendingWebSockets.has(this.__zpWsId)) {
        this.__zpCloseRequested = { code, reason: text };
        return;
      }
      __zpWebSocketClose(JSON.stringify({ wsId: this.__zpWsId, code, reason: text }));
    }
  }
  WebSocket.CONNECTING = 0;
  WebSocket.OPEN = 1;
  WebSocket.CLOSING = 2;
  WebSocket.CLOSED = 3;

  const fetch = (input, init = {}) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    if (request.signal?.aborted) return Promise.reject(abortError(request.signal.reason));
    return new Promise((resolve, reject) => {
      const id = __zpFetchStart(JSON.stringify(requestRecord(request)));
      pendingFetches.set(id, { resolve, reject });
      if (request.signal) {
        request.signal.addEventListener('abort', () => {
          pendingFetches.delete(id);
          __zpFetchAbort(id);
          reject(abortError(request.signal.reason));
        }, { once: true });
      }
    });
  };

  function __zpResolveFetch(id, payload) {
    const pending = pendingFetches.get(String(id));
    if (!pending) return false;
    pendingFetches.delete(String(id));
    pending.resolve(responseFromPayload(typeof payload === 'string' ? JSON.parse(payload) : payload));
    return true;
  }

  function __zpRejectFetch(id, reason) {
    const pending = pendingFetches.get(String(id));
    if (!pending) return false;
    pendingFetches.delete(String(id));
    pending.reject(new Error(String(reason || 'FETCH_FAILED')));
    return true;
  }

  function __zpResolveWebSocket(id, payload) {
    const socket = pendingWebSockets.get(String(id));
    if (!socket) return false;
    pendingWebSockets.delete(String(id));
    const wsId = String(payload?.wsId || id);
    socket.__zpWsId = wsId;
    socket.protocol = payload?.selectedProtocol || '';
    socket.readyState = WebSocket.OPEN;
    activeWebSockets.set(wsId, socket);
    socket.dispatchEvent(new VirtualEvent('open', { bubbles: false, cancelable: false }));
    if (socket.__zpCloseRequested) {
      const close = socket.__zpCloseRequested;
      socket.__zpCloseRequested = null;
      socket.close(close.code, close.reason);
    }
    return true;
  }

  function __zpRejectWebSocket(id, reason) {
    const socket = pendingWebSockets.get(String(id));
    if (!socket) return false;
    pendingWebSockets.delete(String(id));
    socket.readyState = WebSocket.CLOSED;
    socket.dispatchEvent(new VirtualEvent('error', { bubbles: false, cancelable: false, error: reason }));
    socket.dispatchEvent(new CloseEvent('close', { bubbles: false, cancelable: false, code: 1006, reason: '', wasClean: false }));
    return true;
  }

  function __zpDispatchWebSocketMessage(id, payload) {
    const socket = activeWebSockets.get(String(id));
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.dispatchEvent(new MessageEvent('message', { bubbles: false, cancelable: false, data: webSocketMessageData(payload || {}, socket.binaryType) }));
    return true;
  }

  function __zpDispatchWebSocketClose(id, payload = {}) {
    const key = String(id);
    const socket = activeWebSockets.get(key) || pendingWebSockets.get(key);
    if (!socket) return false;
    activeWebSockets.delete(key);
    pendingWebSockets.delete(key);
    socket.readyState = WebSocket.CLOSED;
    socket.dispatchEvent(new CloseEvent('close', {
      bubbles: false,
      cancelable: false,
      code: Number(payload.code || 1000),
      reason: String(payload.reason || ''),
      wasClean: payload.clean !== false,
    }));
    return true;
  }

  function __zpDispatchWebSocketError(id, reason) {
    const socket = activeWebSockets.get(String(id)) || pendingWebSockets.get(String(id));
    if (!socket) return false;
    socket.dispatchEvent(new VirtualEvent('error', { bubbles: false, cancelable: false, error: reason }));
    return true;
  }

  function __zpWebSocketBuffered(id, byteLength) {
    const socket = activeWebSockets.get(String(id)) || pendingWebSockets.get(String(id));
    if (!socket) return false;
    socket.bufferedAmount = Math.max(0, socket.bufferedAmount - Math.max(0, Number(byteLength || 0)));
    return true;
  }

  function requestRecord(request) {
    return { url: request.url, method: request.method, headers: headersEntries(request.headers), mode: request.mode, cache: request.cache, credentials: request.credentials, redirect: request.redirect, referrer: request.referrer, referrerPolicy: request.referrerPolicy, body: decodeUTF8(request.__zpBodyBytes || []) };
  }
  function responseFromPayload(payload) {
    return new Response(payload.text || '', { status: payload.status, statusText: payload.statusText, headers: payload.headers || [], url: payload.finalUrl || payload.url, redirected: Boolean(payload.redirected), timing: payload.timing || null });
  }

  function objectHasOwn(value, key) { return Object.prototype.hasOwnProperty.call(value || {}, key); }

  function validateRequestMode(value) {
    const text = String(value || 'cors');
    if (text === 'navigate') throw new TypeError("Failed to construct 'Request': Cannot construct a Request with a RequestInit whose mode member is set as 'navigate'.");
    if (text === 'same-origin' || text === 'no-cors' || text === 'cors') return text;
    throw new TypeError("Failed to construct 'Request': Failed to read the 'mode' property from 'RequestInit': The provided value '" + text + "' is not a valid enum value of type RequestMode.");
  }

  function validateRequestCredentials(value) {
    const text = String(value || 'same-origin');
    if (text === 'omit' || text === 'same-origin' || text === 'include') return text;
    throw new TypeError("Failed to construct 'Request': Failed to read the 'credentials' property from 'RequestInit': The provided value '" + text + "' is not a valid enum value of type RequestCredentials.");
  }

  function validateRequestCache(value, mode) {
    const text = String(value || 'default');
    if (text !== 'default' && text !== 'no-store' && text !== 'reload' && text !== 'no-cache' && text !== 'force-cache' && text !== 'only-if-cached')
      throw new TypeError("Failed to construct 'Request': Failed to read the 'cache' property from 'RequestInit': The provided value '" + text + "' is not a valid enum value of type RequestCache.");
    if (text === 'only-if-cached' && mode !== 'same-origin')
      throw new TypeError("Failed to construct 'Request': 'only-if-cached' can be set only with 'same-origin' mode");
    return text;
  }

  function validateRequestRedirect(value) {
    const text = String(value || 'follow');
    if (text === 'follow' || text === 'error' || text === 'manual') return text;
    throw new TypeError("Failed to construct 'Request': Failed to read the 'redirect' property from 'RequestInit': The provided value '" + text + "' is not a valid enum value of type RequestRedirect.");
  }

  function normalizeBody(body, fallbackType = '') {
    if (body == null) return { bytes: [], type: fallbackType || '' };
    if (Array.isArray(body)) return { bytes: body.map((value) => Number(value) & 255), type: fallbackType || '' };
    if (body instanceof ArrayBuffer) return { bytes: byteArray(new Uint8Array(body)), type: fallbackType || '' };
    if (ArrayBuffer.isView(body)) return { bytes: byteArray(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)), type: fallbackType || '' };
    if (isFormDataBody(body)) return multipartFormDataBody(body);
    if (typeof Blob === 'function' && body instanceof Blob && Array.isArray(body.__zpBytes)) return { bytes: body.__zpBytes.slice(), type: body.type || fallbackType || '' };
    return { bytes: encodeUTF8(String(body)), type: fallbackType || '' };
  }

  function isFormDataBody(body) {
    return Boolean(body && typeof body === 'object' && Array.isArray(body.__zpEntries));
  }

  function multipartFormDataBody(form) {
    const boundary = '----zeroproxy-formdata-' + nextMultipartBoundary++;
    const bytes = [];
    for (const [name, value] of form.__zpEntries) appendMultipartPart(bytes, boundary, name, value);
    appendASCII(bytes, '--' + boundary + '--\r\n');
    return { bytes, type: 'multipart/form-data; boundary=' + boundary };
  }

  function appendMultipartPart(bytes, boundary, name, value) {
    appendASCII(bytes, '--' + boundary + '\r\n');
    if (isBlobLike(value)) appendMultipartBlob(bytes, name, value);
    else appendMultipartText(bytes, name, value);
    appendASCII(bytes, '\r\n');
  }

  function appendMultipartText(bytes, name, value) {
    appendASCII(bytes, 'Content-Disposition: form-data; name="' + multipartEscape(name) + '"\r\n\r\n');
    bytes.push(...encodeUTF8(String(value ?? '')));
  }

  function appendMultipartBlob(bytes, name, value) {
    const filename = multipartEscape(value.name || 'blob');
    appendASCII(bytes, 'Content-Disposition: form-data; name="' + multipartEscape(name) + '"; filename="' + filename + '"\r\n');
    if (value.type) appendASCII(bytes, 'Content-Type: ' + value.type + '\r\n');
    appendASCII(bytes, '\r\n');
    bytes.push(...value.__zpBytes);
  }

  function isBlobLike(value) {
    return Boolean(value && typeof value === 'object' && Array.isArray(value.__zpBytes));
  }

  function appendASCII(bytes, text) {
    for (let i = 0; i < text.length; i += 1) bytes.push(text.charCodeAt(i) & 255);
  }

  function multipartEscape(value) {
    return String(value ?? '').replace(/[\r\n"]/g, '_');
  }
  function bodyStream(owner, label) {
    return owner.__zpBodyBytes.length ? new BodyReadableStream(owner, label) : null;
  }


  function consumeBody(owner, label) {
    if (owner.bodyUsed) throw new TypeError("Failed to execute 'text' on '" + label + "': body stream already read");
    owner.bodyUsed = true;
    return owner.__zpBodyBytes.slice();
  }


  function bodyFormData(owner, label) {
    if (owner.bodyUsed) throw new TypeError("Failed to execute 'formData' on '" + label + "': body stream already read");
    const type = owner.headers?.get?.('content-type') || owner.__zpBodyType || '';
    const textType = String(type).toLowerCase();
    if (textType.includes('application/x-www-form-urlencoded')) {
      owner.bodyUsed = true;
      return formDataFromURLEncoded(decodeUTF8(owner.__zpBodyBytes || []));
    }
    const boundary = multipartBoundary(type);
    if (boundary) {
      owner.bodyUsed = true;
      return formDataFromMultipart(owner.__zpBodyBytes || [], boundary);
    }
    throw new TypeError('Failed to fetch');
  }

  function multipartBoundary(contentType) {
    const parts = String(contentType || '').split(';');
    if (parts[0].trim().toLowerCase() !== 'multipart/form-data') return '';
    for (const part of parts.slice(1)) {
      const eq = part.indexOf('=');
      if (eq < 0 || part.slice(0, eq).trim().toLowerCase() !== 'boundary') continue;
      return unquoteHeaderValue(part.slice(eq + 1).trim());
    }
    return '';
  }

  function formDataFromMultipart(bytes, boundary) {
    const data = newFormData();
    const marker = '--' + boundary;
    const text = decodeUTF8(bytes);
    for (const rawPart of text.split(marker).slice(1)) appendMultipartField(data, rawPart);
    return data;
  }

  function appendMultipartField(data, rawPart) {
    if (!rawPart || rawPart.startsWith('--')) return;
    const part = rawPart.startsWith('\r\n') ? rawPart.slice(2) : rawPart;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const headers = multipartHeaders(part.slice(0, headerEnd));
    const disposition = headers.get('content-disposition') || '';
    const name = headerParameter(disposition, 'name');
    if (name === null) return;
    const filename = headerParameter(disposition, 'filename');
    const value = stripMultipartTrailingCRLF(part.slice(headerEnd + 4));
    if (filename === null) data.append(name, value);
    else data.append(name, multipartFile(value, filename, headers.get('content-type') || ''));
  }

  function multipartHeaders(text) {
    const headers = new Map();
    for (const line of String(text || '').split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    return headers;
  }

  function headerParameter(header, name) {
    const key = String(name).toLowerCase();
    for (const part of String(header || '').split(';').slice(1)) {
      const eq = part.indexOf('=');
      if (eq < 0 || part.slice(0, eq).trim().toLowerCase() !== key) continue;
      return unquoteHeaderValue(part.slice(eq + 1).trim());
    }
    return null;
  }

  function unquoteHeaderValue(value) {
    const text = String(value || '');
    return text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
  }

  function stripMultipartTrailingCRLF(value) {
    return String(value || '').endsWith('\r\n') ? value.slice(0, -2) : String(value || '');
  }

  function multipartFile(value, filename, type) {
    const bytes = encodeUTF8(value);
    if (typeof File === 'function') return new File([bytesToArrayBuffer(bytes)], filename, { type });
    const blob = blobFromBytes(bytes, type);
    blob.name = filename;
    return blob;
  }

  function formDataFromURLEncoded(text) {
    const data = newFormData();
    for (const part of String(text || '').split('&')) {
      if (part === '') continue;
      const eq = part.indexOf('=');
      const name = eq < 0 ? part : part.slice(0, eq);
      const value = eq < 0 ? '' : part.slice(eq + 1);
      data.append(formDecode(name), formDecode(value));
    }
    return data;
  }

  function formDecode(value) {
    const text = String(value || '').replace(/\+/g, ' ');
    try { return decodeURIComponent(text); } catch { return text; }
  }

  function newFormData() {
    if (typeof FormData === 'function') return new FormData();
    const entries = [];
    return {
      append(name, value) { entries.push([String(name), String(value)]); },
      get(name) { const key = String(name); const found = entries.find(([entry]) => entry === key); return found ? found[1] : null; },
      getAll(name) { const key = String(name); return entries.filter(([entry]) => entry === key).map(([, value]) => value); },
      has(name) { const key = String(name); return entries.some(([entry]) => entry === key); },
      *keys() { for (const [name] of entries) yield name; },
      *values() { for (const [, value] of entries) yield value; },
      *entries() { yield* entries; },
      [Symbol.iterator]() { return this.entries(); },
    };
  }
  function bytesToArrayBuffer(bytes) { return arrayBufferFromBytes(bytes); }

  function blobFromBytes(bytes, type = '') {
    const buffer = bytesToArrayBuffer(bytes);
    if (typeof Blob === 'function') return new Blob([buffer], { type });
    return {
      size: bytes.length,
      type: String(type || ''),
      arrayBuffer: () => Promise.resolve(buffer.slice(0)),
      text: () => Promise.resolve(decodeUTF8(bytes)),
    };
  }

  function encodeUTF8(text) {
    const out = [];
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code < 0x80) out.push(code);
      else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
    return out;
  }

  function decodeUTF8(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length;) {
      const first = bytes[i++];
      if (first < 0x80) out += String.fromCharCode(first);
      else if (first < 0xe0 && i < bytes.length) out += String.fromCharCode(((first & 0x1f) << 6) | (bytes[i++] & 0x3f));
      else if (i + 1 < bytes.length) out += String.fromCharCode(((first & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
      else out += '\ufffd';
    }
    return out;
  }

  function webSocketSendPayload(data) {
    if (typeof data === 'string') return { opcode: 'text', bytes: data, byteLength: utf8ByteLength(data) };
    if (data instanceof ArrayBuffer) return binaryWebSocketPayload(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) return binaryWebSocketPayload(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    const text = String(data ?? '');
    return { opcode: 'text', bytes: text, byteLength: utf8ByteLength(text) };
  }

  function binaryWebSocketPayload(view) {
    return { opcode: 'binary', bytes: byteArray(view), byteLength: view.byteLength };
  }
  function webSocketMessageData(payload, binaryType) {
    if (payload.opcode === 'binary') {
      const buffer = arrayBufferFromBytes(payload.bytes || []);
      return binaryType === 'arraybuffer' ? buffer : blobFromArrayBuffer(buffer);
    }
    return String(payload.data ?? payload.bytes ?? '');
  }

  function blobFromArrayBuffer(buffer) {
    if (typeof Blob === 'function') return new Blob([buffer]);
    return {
      size: buffer.byteLength,
      type: '',
      arrayBuffer: () => Promise.resolve(buffer.slice(0)),
      text: () => Promise.resolve(String.fromCharCode(...new Uint8Array(buffer))),
    };
  }

  function byteArray(view) {
    const out = [];
    for (let i = 0; i < view.byteLength; i++) out.push(view[i]);
    return out;
  }

  function arrayBufferFromBytes(bytes) {
    const list = Array.isArray(bytes) ? bytes : [];
    const out = new ArrayBuffer(list.length);
    const view = new Uint8Array(out);
    for (let i = 0; i < list.length; i++) view[i] = Number(list[i]) & 255;
    return out;
  }

  function webSocketDOMError(name, message) {
    if (typeof DOMException === 'function') return new DOMException(message, name);
    const error = new Error(message);
    error.name = name;
    return error;
  }

  function invalidStateError(message) { return webSocketDOMError('InvalidStateError', message); }
  function invalidAccessError(message) { return webSocketDOMError('InvalidAccessError', message); }
  function syntaxError(message) { return webSocketDOMError('SyntaxError', message); }

  function webSocketProtocolList(protocols) {
    if (protocols == null) return [];
    const list = Array.isArray(protocols) ? protocols : [protocols];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < list.length; i += 1) out.push(validateWebSocketProtocol(String(list[i]), seen));
    return out;
  }

  function validateWebSocketProtocol(protocol, seen) {
    if (!protocol || !webSocketProtocolValid(protocol))
      throw syntaxError("Failed to construct 'WebSocket': The subprotocol '" + protocol + "' is invalid.");
    if (seen.has(protocol))
      throw syntaxError("Failed to construct 'WebSocket': The subprotocol '" + protocol + "' is duplicated.");
    seen.add(protocol);
    return protocol;
  }

  function webSocketProtocolValid(protocol) {
    for (let i = 0; i < protocol.length; i += 1) {
      if (!webSocketProtocolCharValid(protocol.charCodeAt(i))) return false;
    }
    return true;
  }

  function webSocketProtocolCharValid(code) {
    return (code >= 0x30 && code <= 0x39)
      || (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || code === 0x21 || code === 0x23 || code === 0x24 || code === 0x25
      || code === 0x26 || code === 0x27 || code === 0x2a || code === 0x2b
      || code === 0x2d || code === 0x2e || code === 0x5e || code === 0x5f
      || code === 0x60 || code === 0x7c || code === 0x7e;
  }

  function validateCloseCode(code) {
    const value = Number(code);
    if (value === 1000 || (value >= 3000 && value <= 4999)) return;
    throw invalidAccessError("Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. " + value + " is neither.");
  }

  function validateCloseReason(reason) {
    if (utf8ByteLength(reason) <= 123) return;
    throw syntaxError("Failed to execute 'close' on 'WebSocket': The close reason must not be greater than 123 UTF-8 bytes.");
  }

  function utf8ByteLength(text) {
    let bytes = 0;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) { bytes += 4; i += 1; }
        else bytes += 3;
      } else bytes += 3;
    }
    return bytes;
  }

  function appendHeaders(headers, init) {
    if (init instanceof Headers) { for (const [name, value] of init) headers.append(name, value); return; }
    if (Array.isArray(init)) { for (const [name, value] of init) headers.append(name, value); return; }
    for (const name of Object.keys(init || {})) headers.append(name, init[name]);
  }

  function normalizeName(name) { return String(name || '').toLowerCase(); }
  function resolveURL(url) {
    const text = String(url || '');
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return text;
    const base = String(__zpNetworkConfig.documentUrl || '');
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)/.exec(base);
    if (!match) return text;
    const origin = match[1] + '//' + match[2];
    if (text.startsWith('//')) return match[1] + text;
    if (text.startsWith('/')) return origin + text;
    const dir = match[3].replace(/[^/]*$/, '');
    return origin + dir + text;
  }
  function abortReason() {
    return typeof DOMException === 'function' ? new DOMException('The operation was aborted.', 'AbortError') : 'AbortError';
  }
  function timeoutReason() {
    return typeof DOMException === 'function' ? new DOMException('The operation timed out.', 'TimeoutError') : 'TimeoutError';
  }
  function abortError(reason) { const error = new Error(String(reason || 'AbortError')); error.name = 'AbortError'; return error; }
  function parseSSE(text) { return String(text || '').split(/\n\n+/).map((chunk) => chunk.split(/\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')).filter((item) => item !== ''); }

  function __zpInstallNetwork(config) {
    globalThis.__zpNetworkConfig = config || {};
    globalThis.Headers = Headers;
    globalThis.Request = Request;
    globalThis.Response = Response;
    if (!globalThis.AbortController) globalThis.AbortController = AbortController;
    if (!globalThis.AbortSignal) globalThis.AbortSignal = AbortSignal;
    if (!globalThis.MessageEvent) globalThis.MessageEvent = MessageEvent;
    if (!globalThis.CloseEvent) globalThis.CloseEvent = CloseEvent;
    globalThis.XMLHttpRequestEventTarget = XMLHttpRequestEventTarget;
    globalThis.XMLHttpRequestUpload = XMLHttpRequestUpload;
    globalThis.XMLHttpRequest = XMLHttpRequest;
    globalThis.EventSource = EventSource;
    globalThis.WebSocket = WebSocket;
    globalThis.fetch = fetch;
    if (globalThis.document) {
      Object.defineProperty(globalThis.document, 'cookie', { get: () => __zpCookieGet(), set: (value) => __zpCookieSet(String(value)), configurable: true });
    }
    globalThis.__zpResolveFetch = __zpResolveFetch;
    globalThis.__zpRejectFetch = __zpRejectFetch;
    globalThis.__zpResolveWebSocket = __zpResolveWebSocket;
    globalThis.__zpRejectWebSocket = __zpRejectWebSocket;
    globalThis.__zpDispatchWebSocketMessage = __zpDispatchWebSocketMessage;
    globalThis.__zpDispatchWebSocketClose = __zpDispatchWebSocketClose;
    globalThis.__zpDispatchWebSocketError = __zpDispatchWebSocketError;
    globalThis.__zpWebSocketBuffered = __zpWebSocketBuffered;
    return true;
  }

  globalThis.__zpInstallNetwork = __zpInstallNetwork;
})();
`;

export class VirtualHTTPCache {
  constructor(options = {}) {
    this.entries = (options.entries || []).map(deserializeHTTPCacheEntry);
    this.storageManager = options.storageManager || null;
    this.storagePartition = options.storagePartition || '';
  }

  matchEntry(request, partitionKey) {
    const method = String(request.method || 'GET').toUpperCase();
    return this.entries.find((entry) =>
      entry.partitionKey === partitionKey &&
      entry.method === method &&
      entry.url === request.url &&
      this.varyMatches(entry, request)
    ) || null;
  }

  put(request, partitionKey, payload) {
    if (String(request.method || 'GET').toUpperCase() !== 'GET') return;
    const cacheControl = parseCacheControl(headerValue(payload.headers, 'cache-control'));
    if (cacheControl.has('no-store')) return;
    const entry = {
      partitionKey,
      method: 'GET',
      url: request.url,
      payload: clonePayload(payload),
      storedAt: Date.now(),
      cacheControl,
      vary: varyNames(payload.headers),
      varyValues: new Map(),
    };
    for (const name of entry.vary) entry.varyValues.set(name, requestHeader(request, name));
    this.entries = this.entries.filter((item) => item.partitionKey !== entry.partitionKey || item.method !== entry.method || item.url !== entry.url || !sameVary(item, entry));
    this.entries.push(entry);
    this.storageManager?.track?.(this.storageManager.putHTTPCacheEntry(this.storagePartition || partitionKey, serializeHTTPCacheEntry(entry)));
  }

  payloadFromEntry(entry, timing = {}) {
    const payload = clonePayload(entry.payload);
    payload.timing = { ...(payload.timing || {}), ...timing, cacheHit: Boolean(timing.cacheHit) };
    return payload;
  }

  isFresh(entry) {
    if (!entry || entry.cacheControl.has('no-cache')) return false;
    if (!entry.cacheControl.has('max-age')) return true;
    const maxAge = Number(entry.cacheControl.get('max-age') || 0);
    return Date.now() - entry.storedAt <= maxAge * 1000;
  }

  varyMatches(entry, request) {
    for (const name of entry.vary) {
      if (entry.varyValues.get(name) !== requestHeader(request, name)) return false;
    }
    return true;
  }
}

export class VirtualNetworkAPIs {
  constructor(options = {}) {
    if (!options.realm) throw new TypeError('QuickJS realm is required');
    if (!options.backend) throw new TypeError('backend is required');
    this.realm = options.realm;
    this.backend = options.backend;
    this.tabId = options.tabId || 'shell';
    this.documentUrl = options.documentUrl || 'about:blank';
    this.servers = options.servers || [];
    this.cookieString = options.cookieString || '';
    this.nextRequestId = 1;
    this.active = new Map();
    this.timing = [];
    this.cache = options.cache || new VirtualHTTPCache();
    this.webSocketBacklog = new Map();
  }

  install() {
    this.realm.defineHostFunction('__zpFetchStart', (json) => this.startFetch(json));
    this.realm.defineHostFunction('__zpFetchAbort', (requestId) => this.abortFetch(requestId));
    this.realm.defineHostFunction('__zpCookieGet', () => this.cookieString);
    this.realm.defineHostFunction('__zpCookieSet', (value) => this.setCookie(value));
    this.realm.defineHostFunction('__zpWebSocketOpen', (json) => this.openWebSocket(json));
    this.realm.defineHostFunction('__zpWebSocketSend', (json) => this.sendWebSocket(json));
    this.realm.defineHostFunction('__zpWebSocketClose', (json) => this.closeWebSocket(json));
    this.realm.evalClassic(NETWORK_API_SOURCE, 'zeroproxy-network-api.js');
    this.realm.evalClassic(`__zpInstallNetwork(${JSON.stringify({ documentUrl: this.documentUrl })});`, 'zeroproxy-network-install.js');
    return this;
  }

  startFetch(json) {
    const request = JSON.parse(String(json || '{}'));
    const requestId = `qfetch-${this.nextRequestId++}`;
    const startedAt = Date.now();
    const promise = this.fetchWithCache(request, requestId, startedAt)
      .then((payload) => this.resolveFetchPayload(requestId, payload))
      .catch((error) => this.rejectFetch(requestId, error));
    this.active.set(requestId, promise);
    return requestId;
  }

  async fetchWithCache(request, requestId, startedAt) {
    const mode = request.cache || 'default';
    const partitionKey = cachePartition(this.documentUrl);
    const cached = this.cache.matchEntry(request, partitionKey);
    const cachedPayload = this.cachedPayloadForMode(cached, mode);
    if (cachedPayload) return cachedPayload;
    if (mode === 'only-if-cached') throw new Error('CACHE_MISS');
    const fetchRequest = cached && shouldRevalidate(mode, cached, this.cache)
      ? withRevalidationHeaders(request, cached.payload.headers)
      : request;
    const response = decodeFetchMessages(await this.backend.fetchRaw(this.fetchRecord(fetchRequest, requestId)));
    const completedAt = Date.now();
    if (response.status === 304 && cached) {
      return this.cache.payloadFromEntry(cached, { startedAt, completedAt, durationMs: completedAt - startedAt, revalidated: true });
    }
    const payload = payloadFromResponse(response, startedAt, completedAt);
    if (shouldStoreResponse(mode, payload)) this.cache.put(request, partitionKey, payload);
    return payload;
  }

  cachedPayloadForMode(cached, mode) {
    if (!cached || mode === 'reload' || mode === 'no-store' || mode === 'no-cache') return null;
    if (mode === 'force-cache' || this.cache.isFresh(cached)) {
      return this.cache.payloadFromEntry(cached, { cacheHit: true });
    }
    return null;
  }

  fetchRecord(request, requestId) {
    return {
      id: requestId,
      requestId,
      tabId: this.tabId,
      url: request.url,
      documentUrl: this.documentUrl,
      method: request.method || 'GET',
      headers: request.headers || [],
      body: request.body || undefined,
      mode: request.mode || 'cors',
      cache: request.cache || 'default',
      credentials: request.credentials || 'same-origin',
      redirect: request.redirect || 'follow',
      referrer: request.referrer || '',
      referrerPolicy: request.referrerPolicy || '',
      initiator: 'fetch',
      servers: this.servers,
      rawMode: true,
    };
  }

  resolveFetchPayload(requestId, payload) {
    if (!this.active.has(requestId)) return false;
    this.timing.push({ requestId, ...(payload.timing || {}) });
    this.active.delete(requestId);
    this.realm.evalClassic(`__zpResolveFetch(${JSON.stringify(requestId)}, ${JSON.stringify(payload)});`, 'zeroproxy-network-resolve.js');
    this.realm.drainJobs();
    return true;
  }

  rejectFetch(requestId, error) {
    if (!this.active.has(requestId)) return false;
    this.active.delete(requestId);
    this.realm.evalClassic(`__zpRejectFetch(${JSON.stringify(requestId)}, ${JSON.stringify(error?.message || String(error))});`, 'zeroproxy-network-reject.js');
    this.realm.drainJobs();
    return false;
  }

  abortFetch(requestId) {
    const id = String(requestId || '');
    this.active.delete(id);
    if (typeof this.backend.cancel === 'function') this.backend.cancel(id);
    return true;
  }

  setCookie(value) {
    const text = String(value || '');
    this.cookieString = mergeCookie(this.cookieString, text);
    if (typeof this.backend.setCookie === 'function') {
      this.backend.setCookie({ tabId: this.tabId, targetUrl: this.documentUrl, cookie: text, servers: this.servers });
    }
    return undefined;
  }

  openWebSocket(json) {
    const request = JSON.parse(String(json || '{}'));
    const wsId = `qws-${this.nextRequestId++}`;
    this.backend.addWebSocketListener?.(wsId, (message) => this.handleWebSocketEvent(message));
    const promise = this.backend.openWebSocket({
      tabId: this.tabId,
      wsId,
      url: request.url,
      protocols: request.protocols || [],
      documentUrl: this.documentUrl,
      servers: this.servers,
      onEvent: (message) => this.handleWebSocketEvent({ wsId, ...message }),
    }).then((message) => {
      this.realm.evalClassic(`__zpResolveWebSocket(${JSON.stringify(wsId)}, ${JSON.stringify(message || {})});`, 'zeroproxy-ws-resolve.js');
      this.realm.drainJobs();
      this.flushWebSocketBacklog(wsId);
    }).catch((error) => {
      this.realm.evalClassic(`__zpRejectWebSocket(${JSON.stringify(wsId)}, ${JSON.stringify(error?.message || String(error))});`, 'zeroproxy-ws-reject.js');
      this.realm.drainJobs();
    });
    this.active.set(wsId, promise.finally(() => this.active.delete(wsId)));
    return wsId;
  }

  sendWebSocket(json) {
    const message = JSON.parse(String(json || '{}'));
    const requestId = `qws-send-${this.nextRequestId++}`;
    const send = this.backend.sendWebSocket?.({ id: requestId, tabId: this.tabId, ...message });
    const promise = Promise.resolve(send).then(() => {
      this.realm.evalClassic(`__zpWebSocketBuffered(${JSON.stringify(message.wsId)}, ${JSON.stringify(message.byteLength || 0)});`, 'zeroproxy-ws-buffered.js');
      this.realm.drainJobs();
    }).catch((error) => this.handleWebSocketEvent({ type: 'ws.error', wsId: message.wsId, reason: error?.message || String(error) }));
    this.active.set(requestId, promise.finally(() => this.active.delete(requestId)));
    return true;
  }

  closeWebSocket(json) {
    const message = JSON.parse(String(json || '{}'));
    const requestId = `qws-close-${this.nextRequestId++}`;
    const close = this.backend.closeWebSocket?.({ id: requestId, tabId: this.tabId, ...message });
    const promise = Promise.resolve(close).then((result) => {
      if (result?.type === 'ws.close' || result?.type === 'close') this.handleWebSocketEvent(result);
      else if (!result) this.handleWebSocketEvent({ type: 'ws.close', wsId: message.wsId, code: message.code || 1000, reason: message.reason || '', clean: true, source: 'local' });
    }).catch((error) => this.handleWebSocketEvent({ type: 'ws.error', wsId: message.wsId, reason: error?.message || String(error) }));
    this.active.set(requestId, promise.finally(() => this.active.delete(requestId)));
    return true;
  }

  handleWebSocketEvent(message) {
    const wsId = String(message?.wsId || message?.id || '');
    if (!wsId) return false;
    const type = String(message.type || '');
    let delivered = false;
    if (type === 'ws.message' || type === 'message') {
      delivered = this.realm.evalClassic(`__zpDispatchWebSocketMessage(${JSON.stringify(wsId)}, ${JSON.stringify(webSocketEventPayload(message))});`, 'zeroproxy-ws-message.js');
      if (!delivered) this.queueWebSocketEvent(wsId, message);
    } else if (type === 'ws.close' || type === 'close') {
      delivered = this.realm.evalClassic(`__zpDispatchWebSocketClose(${JSON.stringify(wsId)}, ${JSON.stringify({ code: message.code, reason: message.reason, clean: message.clean })});`, 'zeroproxy-ws-close.js');
    } else if (type === 'ws.error' || type === 'error') {
      delivered = this.realm.evalClassic(`__zpDispatchWebSocketError(${JSON.stringify(wsId)}, ${JSON.stringify(message.reason || message.debug || message.error || 'WebSocket error')});`, 'zeroproxy-ws-error.js');
    } else {
      return false;
    }
    this.realm.drainJobs();
    return delivered;
  }

  queueWebSocketEvent(wsId, message) {
    const key = String(wsId || '');
    const backlog = this.webSocketBacklog.get(key) || [];
    backlog.push(message);
    this.webSocketBacklog.set(key, backlog);
  }

  flushWebSocketBacklog(wsId) {
    const key = String(wsId || '');
    const backlog = this.webSocketBacklog.get(key) || [];
    this.webSocketBacklog.delete(key);
    for (const message of backlog) this.handleWebSocketEvent(message);
  }

  async waitForIdle() {
    for (;;) {
      const pending = [...this.active.values()];
      if (!pending.length) return true;
      await Promise.allSettled(pending);
      this.realm.drainJobs();
    }
  }
}

export function installVirtualNetworkAPIs(options = {}) {
  return new VirtualNetworkAPIs(options).install();
}

function payloadFromResponse(response, startedAt, completedAt) {
  return {
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    finalUrl: response.finalUrl,
    redirected: response.finalUrl !== response.url,
    headers: response.headers,
    text: response.text,
    timing: { startedAt, completedAt, durationMs: completedAt - startedAt, cacheHit: false },
  };
}

function webSocketEventPayload(message = {}) {
  const opcode = message.opcode || (message.bytes == null ? 'text' : 'binary');
  if (opcode === 'binary') return { opcode, bytes: arrayBufferLikeToList(message.bytes) };
  return { opcode: 'text', data: String(message.data ?? message.bytes ?? '') };
}

function arrayBufferLikeToList(value) {
  if (Array.isArray(value)) return value.map((item) => Number(item) & 255);
  if (value instanceof ArrayBuffer) return [...new Uint8Array(value)];
  if (ArrayBuffer.isView(value)) return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)];
  return [];
}

function shouldRevalidate(mode, cached, cache) {
  return mode === 'no-cache' || !cache.isFresh(cached);
}

function shouldStoreResponse(mode, payload) {
  return mode !== 'no-store' && payload.status === 200;
}

function withRevalidationHeaders(request, responseHeaders) {
  const headers = [...(request.headers || [])];
  const etag = headerValue(responseHeaders, 'etag');
  const modified = headerValue(responseHeaders, 'last-modified');
  if (etag) headers.push(['if-none-match', etag]);
  if (modified) headers.push(['if-modified-since', modified]);
  return { ...request, headers };
}

function clonePayload(payload) {
  return {
    ...payload,
    headers: (payload.headers || []).map(([name, value]) => [name, value]),
    timing: { ...(payload.timing || {}) },
  };
}

function cachePartition(documentUrl) {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:)\/\/([^/?#]*)/.exec(String(documentUrl || ''));
  return match ? `${match[1]}//${match[2]}` : 'opaque';
}

function requestHeader(request, name) {
  return headerValue(request.headers || [], name);
}

function headerValue(headers, name) {
  const wanted = String(name || '').toLowerCase();
  for (const [headerName, value] of headers || []) {
    if (String(headerName).toLowerCase() === wanted) return String(value);
  }
  return '';
}

function parseCacheControl(value) {
  const out = new Map();
  for (const part of String(value || '').split(',')) {
    const [rawName, rawValue = ''] = part.trim().split('=');
    if (rawName) out.set(rawName.toLowerCase(), rawValue.replace(/^"|"$/g, ''));
  }
  return out;
}

function varyNames(headers) {
  return headerValue(headers, 'vary')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name && name !== '*');
}

function sameVary(left, right) {
  if (left.vary.length !== right.vary.length) return false;
  return left.vary.every((name) => right.vary.includes(name) && left.varyValues.get(name) === right.varyValues.get(name));
}


function serializeHTTPCacheEntry(entry) {
  return {
    partitionKey: entry.partitionKey,
    method: entry.method,
    url: entry.url,
    payload: clonePayload(entry.payload),
    storedAt: entry.storedAt,
    cacheControl: [...entry.cacheControl],
    vary: [...entry.vary],
    varyValues: [...entry.varyValues],
  };
}

function deserializeHTTPCacheEntry(entry) {
  return {
    partitionKey: entry.partitionKey,
    method: entry.method,
    url: entry.url,
    payload: clonePayload(entry.payload || {}),
    storedAt: Number(entry.storedAt || Date.now()),
    cacheControl: new Map(entry.cacheControl || []),
    vary: [...(entry.vary || [])],
    varyValues: new Map(entry.varyValues || []),
  };
}
function mergeCookie(existing, line) {
  const [nameValue] = String(line || '').split(';', 1);
  const [name, value = ''] = nameValue.split('=');
  const key = name.trim();
  if (!key) return existing;
  const jar = new Map(String(existing || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [k, ...rest] = part.split('=');
    return [k, rest.join('=')];
  }));
  jar.set(key, value);
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}
