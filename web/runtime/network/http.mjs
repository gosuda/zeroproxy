/* ZeroProxy runtime HTTP fetch facade. */
export function createHTTPFetchFacade({
  root,
  Native,
  boot,
  runtimeToken,
  normalizedError,
  postMessageToSW,
  openUploadStream,
  getActiveEntryId,
  getVirtualURL,
  getBaseURL,
  getDocumentReferrerPolicy,
  proxyOrigin,
  isInternalRequestURL = () => false,
}) {
  const {
    Array = globalThis.Array,
    ArrayBuffer = globalThis.ArrayBuffer,
    Blob = globalThis.Blob,
    Map = globalThis.Map,
    Object = globalThis.Object,
    Promise = globalThis.Promise,
    Proxy = globalThis.Proxy,
    String = globalThis.String,
    SyntaxError = globalThis.SyntaxError,
    TextEncoder = globalThis.TextEncoder,
    URL = globalThis.URL,
    URLSearchParams = globalThis.URLSearchParams,
    encodeURIComponent = globalThis.encodeURIComponent,
    functionBind = globalThis.Function.prototype.bind,
    objectAssign = globalThis.Object.assign,
    objectDefineProperty = globalThis.Object.defineProperty,
    objectFreeze = globalThis.Object.freeze,
    objectHasOwn = globalThis.Object.hasOwn,
    reflectApply = globalThis.Reflect.apply,
    reflectGet = globalThis.Reflect.get,
  } = Native;

  function requestURLString(input) {
    return input && typeof input === 'object' && typeof input.url === 'string' ? input.url : String(input);
  }

  function internalProxyRequestURL(raw) {
    try {
      const u = new URL(String(raw), proxyOrigin);
      return isInternalRequestURL(u.href) ? u.href : '';
    } catch {
      return '';
    }
  }

  function requestTargetURL(input) {
    const raw = requestURLString(input);
    const internal = internalProxyRequestURL(raw);
    if (internal) return internal;
    const parsed = new URL(raw, getBaseURL());
    if (parsed.origin === proxyOrigin) return new URL(parsed.pathname + parsed.search + parsed.hash, getBaseURL()).href;
    return ZP.canonicalTargetURL(parsed.href, getBaseURL()).href;
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
    if (!init || !objectHasOwn(init, 'body')) return false;
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

  function performanceTimingStore() {
    if (!root.__zpPerformanceTimings) {
      try {
        objectDefineProperty(root, '__zpPerformanceTimings', {
          value: [],
          enumerable: false,
          configurable: false,
        });
      } catch {
        root.__zpPerformanceTimings = [];
      }
    }
    return root.__zpPerformanceTimings;
  }

  function recordTransportTiming(resp, targetUrl) {
    const timing = resp && resp.__zpTransportTiming;
    if (!timing || typeof timing !== 'object') return;
    const store = performanceTimingStore();
    store[store.length] = objectAssign({ targetUrl }, timing);
    if (store.length > 256) {
      const keep = 256;
      const offset = store.length - keep;
      for (let i = 0; i < keep; i += 1) store[i] = store[i + offset];
      store.length = keep;
    }
  }

  function sameOriginURL(a, b) {
    try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
  }

  function opaqueResponseFacade(resp) {
    if (!resp || !Native.Headers) return resp;
    const emptyHeaders = new Native.Headers();
    const cloneOpaque = () => opaqueResponseFacade(resp.clone());
    const values = new Map([
      ['type', 'opaque'],
      ['url', ''],
      ['redirected', false],
      ['status', 0],
      ['statusText', ''],
      ['ok', false],
      ['headers', emptyHeaders],
      ['body', null],
      ['bodyUsed', false],
      ['clone', cloneOpaque],
      ['text', () => Promise.resolve('')],
      ['arrayBuffer', () => Promise.resolve(new ArrayBuffer(0))],
      ['blob', () => Promise.resolve(new Blob([]))],
      ['json', () => Promise.reject(new SyntaxError('Unexpected end of JSON input'))],
      ['formData', () => Promise.reject(normalizedError('TypeError'))],
    ]);
    return new Proxy(resp, {
      get(target, prop) {
        return values.has(prop) ? values.get(prop) : boundTargetMember(target, prop);
      }
    });
  }

  function responseFacade(resp, fallbackURL) {
    if (!resp || !resp.headers || !Native.Headers) return resp;
    const visibleURL = resp.headers.get('X-ZP-Response-URL') || fallbackURL || resp.url;
    const visibleRedirected = resp.headers.get('X-ZP-Response-Redirected') === '1';
    let visibleHeaders = null;
    const cloneFacade = () => responseFacade(resp.clone(), visibleURL);
    const values = new Map([
      ['url', () => visibleURL],
      ['redirected', () => visibleRedirected],
      ['headers', () => visibleHeaders || (visibleHeaders = filteredResponseHeaders(resp))],
      ['clone', () => cloneFacade],
    ]);
    return new Proxy(resp, {
      get(target, prop) {
        const value = values.get(prop);
        return value ? value() : boundTargetMember(target, prop);
      }
    });
  }

  function boundTargetMember(target, prop) {
    const value = reflectGet(target, prop, target);
    return typeof value === 'function' ? reflectApply(functionBind, value, [target]) : value;
  }

  async function fetchThroughRuntime(input, init = {}) {
    if (!Native.fetch || !Native.Request || !Native.Headers) throw normalizedError('NetworkError');
    const internal = internalProxyRequestURL(requestURLString(input));
    if (internal) return Native.fetch(internal, init);
    throw normalizedError('NetworkError');
  }

  function markReplayableRequestBody(apiHeaders, input, init) {
    if (replayableRequestBody(input, init)) apiHeaders.set('X-ZP-Upload-Replayable', '1');
  }

  async function prepareRuntimeFetchBody(req, apiInit, apiHeaders, abort) {
    await attachFetchBody(req, apiInit, apiHeaders, abort && abort.promise);
    if (req.signal) apiInit.signal = req.signal;
  }

  async function runtimeFetchResponse(req, resp, target, virtualURL) {
    recordTransportTiming(resp, target);
    await enforceRedirectError(req, resp);
    if (opaqueResponseRequired(req, target, virtualURL)) return opaqueResponseFacade(resp);
    return responseFacade(resp, target);
  }

  function opaqueResponseRequired(req, target, virtualURL) {
    return (req.mode || 'cors') === 'no-cors' && !sameOriginURL(virtualURL.href, target);
  }

  function runtimeRequest(input, init) {
    const requestLike = input && typeof input === 'object' && typeof input.url === 'string' && typeof input.clone === 'function';
    return requestLike ? new Native.Request(input, init) : new Native.Request(String(input), init);
  }

  function runtimeFetchHeaders(req, virtualURL, requestId) {
    const headers = new Native.Headers(req.headers);
    headers.delete('X-ZP-Upload-Replayable');
    headers.set('X-ZP-Tab-Id', boot.tabId);
    headers.set('X-ZP-Entry-Id', getActiveEntryId());
    headers.set('X-ZP-Runtime-Token', runtimeToken);
    headers.set('X-ZP-Document-URL', virtualURL.href);
    headers.set('X-ZP-Request-Id', requestId);
    setFetchPolicyHeaders(headers, req);
    return headers;
  }

  function setFetchPolicyHeaders(headers, req) {
    headers.set('X-ZP-Fetch-Credentials', req.credentials || 'same-origin');
    headers.set('X-ZP-Fetch-Mode', req.mode || 'cors');
    headers.set('X-ZP-Fetch-Cache', req.cache || 'default');
    headers.set('X-ZP-Fetch-Redirect', req.redirect || 'follow');
    headers.set('X-ZP-Fetch-Referrer', req.referrer || 'about:client');
    headers.set('X-ZP-Fetch-Referrer-Policy', req.referrerPolicy || getDocumentReferrerPolicy() || '');
    headers.set('X-ZP-Fetch-Integrity', req.integrity || '');
    headers.set('X-ZP-Fetch-Keepalive', req.keepalive ? '1' : '0');
    if ('priority' in req) {
      try { headers.set('X-ZP-Fetch-Priority', String(req.priority || '')); } catch {}
    }
  }

  function runtimeFetchInit(req, headers) {
    return {
      method: req.method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'follow'
    };
  }

  function setupFetchAbort(req, requestId) {
    if (!req.signal) return null;
    let listener = null;
    const promise = new Promise((_, reject) => {
      listener = () => {
        postMessageToSW({ type: 'ZP_FETCH_ABORT', tabId: boot.tabId, entryId: getActiveEntryId(), requestId }).catch(()=>{});
        reject(normalizedError('AbortError'));
      };
    });
    if (req.signal.aborted) listener();
    else req.signal.addEventListener('abort', listener, { once: true });
    return { listener, promise };
  }

  async function attachFetchBody(req, init, headers, abortPromise) {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const opened = openUploadStream(req.body, req.signal);
    const streamId = abortPromise ? await Promise.race([opened, abortPromise]) : await opened;
    if (streamId) {
      headers.set('X-ZP-Upload-Stream-Id', streamId);
      return;
    }
    init.body = req.body;
    init.duplex = 'half';
  }

  function fetchRuntimeAPI(_target, _init, abortPromise) {
    const blocked = Promise.reject(normalizedError('NetworkError'));
    return abortPromise ? Promise.race([blocked, abortPromise]) : blocked;
  }

  async function enforceRedirectError(req, resp) {
    if ((req.redirect || 'follow') !== 'error' || resp.status !== 403) return;
    const text = await resp.clone().text().catch(() => '');
    if (/ZeroProxy\s+POLICY_BLOCKED|POLICY_BLOCKED/.test(text)) throw normalizedError('TypeError');
  }

  function detachFetchAbort(req, abort) {
    if (!abort || !abort.listener || !req.signal) return;
    try { req.signal.removeEventListener('abort', abort.listener); } catch {}
  }

  return objectFreeze({
    fetchThroughRuntime,
    replayableBodySize,
    requestTargetURL,
  });
}
