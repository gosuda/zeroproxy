/* ZeroProxy Service Worker: controlled network requests are routed through the WASM transport. */
importScripts('/zp/assets/zp-core.js');
importScripts('/zp/assets/rust-rewriter.js');
importScripts('/zp/assets/wasm_exec.js');

const nativeFetch = self.fetch.bind(self);
const ORIGIN = self.location.origin;
const tabs = new Map();
const clientContext = new Map();
const shareRoutes = new Map();
const resourceContext = new Map();
const streams = new Map();
const uploadStreams = new Map();
const inflightFetches = new Map();
let readiness = 'UNINITIALIZED';
let kernelPromise = null;
self.__zp_cookie_sync = payload => broadcastCookieSync(payload);
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => { await self.clients.claim(); initKernel().catch(() => {}); })()));
self.addEventListener('message', event => event.waitUntil(handleMessage(event)));
self.addEventListener('fetch', event => { event.respondWith(handleFetch(event)); });

async function initKernel(servers) {
  if (readiness === 'READY') return;
  if (kernelPromise) return kernelPromise;
  kernelPromise = (async () => {
    readiness = 'REWRITE_LOADING';
    await initRewriter();
    readiness = 'WASM_LOADING';
    const go = new Go();
    const resp = await nativeFetch('/zp/kernel.wasm', { cache: 'no-store' });
    if (!resp.ok) throw new Error('SW_NOT_READY');
    const result = await WebAssembly.instantiateStreaming(resp, go.importObject);
    readiness = 'WASM_LOADED';
    go.run(result.instance);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (typeof self.__go_jshttp !== 'function' || typeof self.__zp_stream !== 'function' || typeof self.__zp_kernel_init !== 'function')) await new Promise(r => setTimeout(r, 20));
    if (typeof self.__go_jshttp !== 'function' || typeof self.__zp_stream !== 'function' || typeof self.__zp_kernel_init !== 'function') throw new Error('SW_NOT_READY');
    await self.__zp_kernel_init({ servers: servers || [] });
    readiness = 'READY';
  })().catch(err => { readiness = 'UNINITIALIZED'; kernelPromise = null; throw err; });
  return kernelPromise;
}

async function initRewriter() {
  if (!self.ZPRewriter || !self.ZPRewriter.ready || typeof self.ZPRewriter.rewriteScript !== 'function') throw new Error('REALM_INJECTION_FAILURE');
}

async function handleFetch(event) {
  const req = event.request;
  const url = new URL(req.url);
  try {
    if (isCORSPreflight(req)) return corsPreflight(req);
    const clientId = event.resultingClientId || event.clientId;
    const cls = classify(req, url, clientId);
    switch (cls.kind) {
      case 'INTERNAL_ASSET': return internalAsset(req, url);
      case 'PROXY_DOCUMENT': return proxyDocument(req, cls, clientId);
      case 'RUNTIME_API': return runtimeAPI(req, url, clientId);
      case 'VIRTUAL_SUBRESOURCE': return virtualSubresource(req, cls, clientId);
      default: return req.mode === 'navigate' ? safeError('POLICY_BLOCKED', 403) : Response.error();
    }
  } catch (e) {
    return safeError(e && e.code || e && e.message || 'POLICY_BLOCKED', 400);
  }
}

function classify(req, url, clientId) {
  if (url.origin === ORIGIN) {
    if (isRuntimeAPIPath(url.pathname)) return { kind: 'RUNTIME_API' };
    if (url.pathname.startsWith(ZP.controlPath('error/'))) return { kind: 'INTERNAL_ASSET' };
    if (url.pathname === ZP.CONTROL_PREFIX || url.pathname === ZP.controlPath('index.html') || url.pathname === ZP.controlPath('sw.js') || internalPath(url.pathname)) return { kind: 'INTERNAL_ASSET' };
    const ctx = contextFor(req, clientId);
    const p = parseSharePath(url.pathname);
    if (p && req.mode === 'navigate') return { kind: 'PROXY_DOCUMENT', ...p };
    if (ctx && url.pathname.startsWith(ZP.CONTROL_PREFIX)) return { kind: 'VIRTUAL_SUBRESOURCE', ctx, sameOriginURL: url };
    if (p && shareRoutes.has(p.routeKey)) return { kind: 'PROXY_DOCUMENT', ...p };
    return { kind: 'UNKNOWN' };
  }
  const ctx = contextFor(req, clientId);
  if (ctx && (url.protocol === 'http:' || url.protocol === 'https:')) return { kind: 'VIRTUAL_SUBRESOURCE', ctx, crossOriginURL: url };
  return { kind: 'UNKNOWN' };
}

function internalPath(path) {
  return path === '/favicon.ico' || path === ZP.assetPath('zp-core.js') || path === ZP.assetPath('rust-rewriter.js') || path === ZP.assetPath('runtime-prelude.js') || path === ZP.assetPath('worker-prelude.js') || path === ZP.assetPath('wasm_exec.js') || path === ZP.controlPath('kernel.wasm') || path === ZP.controlPath('worker-bootstrap.js') || path === ZP.assetPath('favicon.ico') || path === ZP.assetPath('manifest.webmanifest');
}
function isRuntimeAPIPath(path) {
  return path === ZP.apiPath('fetch') || path === ZP.apiPath('script') || path === ZP.apiPath('worker-script');
}

async function internalAsset(req, url) {
  if (url.pathname.startsWith(ZP.controlPath('error/'))) return safeError(decodeURIComponent(url.pathname.split('/').pop() || 'POLICY_BLOCKED'), 400);
  if (url.pathname === ZP.controlPath('worker-bootstrap.js')) return workerBootstrap(url);
  if (url.pathname === ZP.CONTROL_PREFIX || url.pathname === ZP.controlPath('index.html')) return addCSP(await nativeFetch(req, { cache: 'no-store' }), req);
  if (!internalPath(url.pathname) && url.pathname !== ZP.controlPath('sw.js')) return safeError('POLICY_BLOCKED', 403);
  return addCSP(await nativeFetch(req, { cache: 'no-store' }), req);
}

function parseSharePath(path) {
  const m = /^\/zp\/p\/([^/]+)$/.exec(path);
  if (!m) return null;
  return { routeKey: m[1] };
}



async function proxyDocument(req, route, clientId) {
  const state = shareRoutes.get(route.routeKey);
  if (!state) return internalAsset(new Request(ZP.CONTROL_PREFIX), new URL(ZP.CONTROL_PREFIX, ORIGIN));
  const tab = tabs.get(state.tabId);
  const entry = tab && tab.entries.get(state.entryId);
  if (!tab || !entry) {
    shareRoutes.delete(route.routeKey);
    return internalAsset(new Request(ZP.CONTROL_PREFIX), new URL(ZP.CONTROL_PREFIX, ORIGIN));
  }
  tab.activeEntryId = entry.entryId;
  bindClientContext(clientId, tab, entry);
  return transportFetch(entry.targetUrl, { request: req, document: true, tab, entryId: entry.entryId });
}


async function virtualSubresource(req, cls, clientId) {
  const ctx = cls.ctx;
  const tab = tabs.get(ctx.tabId);
  if (!tab) return Response.error();
  const targetUrl = cls.crossOriginURL ? cls.crossOriginURL.href : sameOriginTargetURL(cls.sameOriginURL, ctx);
  const document = req.mode === 'navigate' || req.headers.get('X-ZP-Document-Request') === '1';
  const resp = await transportFetch(targetUrl, { request: req, document, tab, entryId: ctx.entryId });
  rememberResourceContext(cls.crossOriginURL || cls.sameOriginURL, targetUrl, ctx);
  if (shouldRewriteCSS(req, resp)) return rewriteCSSResponse(resp, { targetUrl });
  return shouldRewriteScript(req, resp) ? rewriteScriptResponse(resp, { targetUrl, kind: scriptKindFromRequest(req), challengeCompat: tab.challengeCompat }) : resp;
}

function sameOriginTargetURL(sameOriginURL, ctx) {
  const baseTargetURL = ctx.baseUrl || ctx.targetUrl;
  if (sameOriginURL.pathname.startsWith(ZP.controlPath('p/'))) {
    return new URL(sameOriginURL.pathname.slice(ZP.controlPath('p/').length) + sameOriginURL.search, baseTargetURL).href;
  }
  const path = sameOriginURL.pathname.startsWith(ZP.CONTROL_PREFIX) ? '/' + sameOriginURL.pathname.slice(ZP.CONTROL_PREFIX.length) : sameOriginURL.pathname;
  return new URL(path + sameOriginURL.search, baseTargetURL).href;
}

async function runtimeAPI(req, url, clientId) {
  if (url.pathname === '/zp/api/fetch') {
    const resolved = runtimeFetchContext(req, clientId);
    if (!resolved) return safeError('POLICY_BLOCKED', 403);
	    const { tab, entryId } = resolved;
	    const target = url.searchParams.get('url');
	    if (target) {
	      const entry = tab.entries && tab.entries.get(entryId || tab.activeEntryId);
	      rememberResourceContext(url, target, { tabId: tab.tabId, entryId: entryId || tab.activeEntryId, targetUrl: entry && entry.targetUrl || target, baseUrl: target });
	      const resp = await transportFetch(target, { request: req, method: req.method, tab, entryId });
	      return shouldRewriteCSS(req, resp) ? rewriteCSSResponse(resp, { targetUrl: target }) : resp;
	    }
    if (req.method !== 'POST') return safeError('POLICY_BLOCKED', 405);
    const payload = await req.json();
    let body;
    if (payload.init && payload.init.body) body = ZP.base64UrlToBytes(payload.init.body);
    return transportFetch(payload.url, { method: payload.init && payload.init.method || 'GET', headers: payload.init && payload.init.headers || [], body, tab, entryId });
  }
  if (url.pathname === '/zp/api/script') {
    if (req.method !== 'GET') return safeError('POLICY_BLOCKED', 405);
    const target = url.searchParams.get('u');
    const kind = url.searchParams.get('kind') || 'classic';
    const resolved = scriptRequestContext(req, url, clientId);
    if (!target || !resolved) return safeError('SW_NOT_READY', 503);
    const headers = [['Accept', 'text/javascript, application/javascript, */*;q=0.8']];
    const ref = url.searchParams.get('ref') || '';
    const refPolicy = url.searchParams.get('rp') || '';
    if (ref) headers.push(['X-ZP-Fetch-Referrer', ref]);
    if (refPolicy) headers.push(['X-ZP-Fetch-Referrer-Policy', refPolicy]);
    const resp = await transportFetch(target, { method: 'GET', headers, tab: resolved.tab, entryId: resolved.entryId });
    return rewriteScriptResponse(resp, { targetUrl: target, kind, challengeCompat: resolved.tab.challengeCompat });
  }
  if (url.pathname === '/zp/api/worker-script') {
    const target = url.searchParams.get('u');
    const resolved = scriptRequestContext(req, url, clientId);
    if (!target || !resolved) return safeError('SW_NOT_READY', 503);
    return rewriteScriptResponse(await transportFetch(target, { method: 'GET', headers: [['Accept', 'text/javascript,*/*']], tab: resolved.tab, entryId: resolved.entryId }), { targetUrl: target, kind: 'worker', challengeCompat: resolved.tab.challengeCompat });
  }
  return safeError('POLICY_BLOCKED', 404);
}

async function transportFetch(targetUrl, opt) {
  let u;
  try { u = ZP.canonicalTargetURL(targetUrl).href; } catch (e) { return safeError(e.code || 'TARGET_PROTOCOL_BLOCKED', 403, targetUrl); }
  if (readiness !== 'READY') { try { await initKernel(opt.tab && opt.tab.servers); } catch { return safeError('SW_NOT_READY', 503); } }
  const headers = new Headers(opt.headers || (opt.request && opt.request.headers) || undefined);
  headers.set('X-ZP-Tab-Id', opt.tab.tabId);
  headers.set('X-ZP-Entry-Id', opt.entryId || opt.tab.activeEntryId || '');
  headers.set('X-ZP-Stream-Isolation-Key', opt.tab.streamIsolationKey);
  headers.set('X-ZP-Runtime-Token', opt.tab.runtimeToken || '');
  headers.set('X-ZP-Relay-Servers', JSON.stringify(opt.tab.servers || []));
  // B4: authoritatively set/delete the kernel arm header the SAME way as
  // X-ZP-Tab-Id / X-ZP-Runtime-Token (per B1's INBOUND-STRIP OBLIGATION). The
  // unconditional delete drops any page-forged value (e.g. via /zp/api/fetch
  // payload headers); the conditional set re-adds it ONLY for an armed tab.
  headers.delete('X-Zp-Challenge-Compat-Arm');
  if (opt.tab.challengeCompat) headers.set('X-Zp-Challenge-Compat-Arm', '1');
  if (opt.document) headers.set('X-ZP-Document-Request', '1');
  if (!headers.has('X-ZP-Document-URL')) {
    const entry = opt.tab.entries && opt.tab.entries.get(opt.entryId || opt.tab.activeEntryId);
    headers.set('X-ZP-Document-URL', entry && (entry.baseUrl || entry.targetUrl) || u);
  }
  if (opt.document && !headers.has('X-ZP-Document-Referrer')) {
    const entry = opt.tab.entries && opt.tab.entries.get(opt.entryId || opt.tab.activeEntryId);
    headers.set('X-ZP-Document-Referrer', entry && entry.referrerUrl || '');
  }
  if (!headers.has('X-ZP-Fetch-Credentials')) headers.set('X-ZP-Fetch-Credentials', opt.document ? 'include' : (opt.request && opt.request.credentials || 'same-origin'));
  if (!headers.has('X-ZP-Fetch-Mode')) headers.set('X-ZP-Fetch-Mode', opt.request && opt.request.mode || (opt.document ? 'navigate' : 'cors'));
  if (!headers.has('X-ZP-Fetch-Cache')) headers.set('X-ZP-Fetch-Cache', opt.request && opt.request.cache || 'default');
  if (opt.document) headers.set('X-ZP-Fetch-Redirect', 'follow');
  else if (!headers.has('X-ZP-Fetch-Redirect')) headers.set('X-ZP-Fetch-Redirect', opt.request && opt.request.redirect || 'follow');
  if (!headers.has('X-ZP-Fetch-Referrer')) headers.set('X-ZP-Fetch-Referrer', opt.request && opt.request.referrer || 'about:client');
  if (!headers.has('X-ZP-Fetch-Referrer-Policy')) headers.set('X-ZP-Fetch-Referrer-Policy', opt.request && opt.request.referrerPolicy || '');
  const uploadStreamId = headers.get('X-ZP-Upload-Stream-Id') || '';
  headers.delete('X-ZP-Upload-Stream-Id');
  const requestId = headers.get('X-ZP-Request-Id') || '';
  headers.delete('X-ZP-Request-Id');
  const init = { method: opt.method || (opt.request && opt.request.method) || 'GET', headers };
  let requestController = null;
  let requestAbortListener = null;
  if (requestId || opt.request && opt.request.signal) {
    requestController = new AbortController();
    init.signal = requestController.signal;
    if (requestId) inflightFetches.set(requestId, requestController);
    if (opt.request && opt.request.signal) {
      requestAbortListener = () => requestController.abort();
      if (opt.request.signal.aborted) requestController.abort();
      else opt.request.signal.addEventListener('abort', requestAbortListener, { once: true });
    }
  }
  if (init.method !== 'GET' && init.method !== 'HEAD') {
    if (opt.body != null) {
      init.body = opt.body;
    } else if (uploadStreamId) {
      const upload = uploadStreams.get(uploadStreamId);
      if (!upload || upload.tabId !== opt.tab.tabId) return safeError('POLICY_BLOCKED', 403);
      init.body = readableStreamFromUpload(uploadStreamId, upload);
      init.duplex = 'half';
    } else if (opt.request && opt.request.body) {
      init.body = opt.request.body;
      init.duplex = 'half';
    }
  }
  try {
    const resp = await self.__go_jshttp(new Request(u, init));
    return addCSP(resp, opt.request, opt.tab && opt.tab.servers);
  } finally {
    if (requestId) inflightFetches.delete(requestId);
    if (requestAbortListener && opt.request && opt.request.signal) {
      try { opt.request.signal.removeEventListener('abort', requestAbortListener); } catch {}
    }
  }
}

function scriptKindFromRequest(req) {
  if (req.destination === 'worker' || req.destination === 'sharedworker') return 'worker';
  return 'classic';
}
function shouldRewriteScript(req, resp) {
  if (req.destination === 'script' || req.destination === 'worker' || req.destination === 'sharedworker') return true;
  const ct = resp && resp.headers && resp.headers.get('Content-Type') || '';
  return /\b(?:java|ecma)script\b/i.test(ct) || /\btext\/(?:x-)?javascript\b/i.test(ct);
}
// B4 two-signal gate (URL half): mirror the kernel's targetIsChallengeDocument
// URL test (cmd/wasm-kernel/challenge.go) using the FINAL URL ONLY. The script
// path projects the challenge CSP only when the per-tab arm bit AND this
// classification both hold, so non-challenge scripts/workers on an armed tab stay
// byte-identical. Header/body are never read here; this grants no egress.
function isChallengeURL(targetUrl) {
  let u;
  try { u = new URL(targetUrl); } catch { return false; }
  return u.hostname === 'challenges.cloudflare.com' || u.pathname.startsWith('/cdn-cgi/challenge-platform/');
}
async function rewriteScriptResponse(resp, opt) {
  const challengeCompat = !!(opt && opt.challengeCompat) && isChallengeURL(opt && opt.targetUrl);
  const h = scriptResponseHeaders(resp, challengeCompat);
  let code = '';
  try {
    await initRewriter();
    const source = await resp.text();
    const out = self.ZPRewriter && self.ZPRewriter.rewriteScript(source, { kind: opt.kind || 'classic', targetUrl: opt.targetUrl, strict: true, controlPrefix: ZP.CONTROL_PREFIX });
    code = out && out.ok ? out.code : (self.ZPRewriter ? self.ZPRewriter.blockSource() : "throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');");
  } catch {
    code = "throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');";
  }
  return new Response(code, { status: resp.status, statusText: resp.statusText, headers: h });
}
function shouldRewriteCSS(req, resp) {
  if (req.destination === 'style') return true;
  const ct = resp && resp.headers && resp.headers.get('Content-Type') || '';
  return /\btext\/css\b/i.test(ct);
}
async function rewriteCSSResponse(resp, opt) {
  const h = new Headers(resp.headers);
  h.set('Content-Type', 'text/css; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  applyCORS(h, null);
  try {
    await initRewriter();
    const source = await resp.text();
    const out = self.ZPRewriter && self.ZPRewriter.rewriteCSS(source, { baseUrl: opt.targetUrl, controlPrefix: ZP.CONTROL_PREFIX });
    return new Response(out && out.ok ? out.code : source, { status: resp.status, statusText: resp.statusText, headers: h });
  } catch {
    return new Response(await resp.text().catch(() => ''), { status: resp.status, statusText: resp.statusText, headers: h });
  }
}
function scriptResponseHeaders(resp, challengeCompat) {
  const h = new Headers(resp.headers);
  h.set('Content-Type', 'text/javascript; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  h.set('X-Content-Type-Options', 'nosniff');
  // B4: defense-in-depth strip of the internal kernel marker so it can never reach
  // the page on the script path even if upstream consumption changes (transportFetch
  // -> addCSP already deletes it before any script response reaches here).
  h.delete('X-ZP-Challenge-Compat');
  // B4: project the challenge CSP onto rewritten challenge SCRIPTS so a real human's
  // Cloudflare widget can execute. challengeCompat is the CALLER-COMPUTED TWO-SIGNAL
  // result (per-tab arm bit AND isChallengeURL of the script's targetUrl). Default
  // OFF: falsy => fixedCSP() byte-identical to before. The projection adds NO egress
  // and NEVER manufactures eval (worker-src stays 'self' blob:).
  h.set('Content-Security-Policy', ZP.fixedCSP([], { challengeCompat: !!challengeCompat }));
  applyCORS(h, null);
  return h;
}


async function handleMessage(event) {
  const msg = event.data || {};
  const reply = event.ports && event.ports[0];
  const ok = data => reply && reply.postMessage(Object.assign({ ok: true }, data || {}));
  const fail = code => reply && reply.postMessage({ ok: false, error: code });
  try {
    if (msg.type === 'ZP_OPEN_SHARE') {
      const routeKey = String(msg.routeKey || '');
      if (!routeKey || /[^A-Za-z0-9_-]/.test(routeKey)) { fail('MALFORMED_ROUTE'); return; }
      const tab = createTab(msg.targetUrl, msg.servers, msg.challengeCompat);
      shareRoutes.set(routeKey, { tabId: tab.tabId, entryId: tab.activeEntryId });
      ok({ path: ZP.makeSharePath(routeKey), servers: tab.servers });
      return;
    }
    if (msg.type === 'ZP_FRAME_ROUTE') {
      const tab = runtimeTabForMessage(event, msg, fail);
      if (!tab) return;
      const routeKey = String(msg.routeKey || '');
      if (!routeKey || /[^A-Za-z0-9_-]/.test(routeKey)) { fail('MALFORMED_ROUTE'); return; }
      const targetUrl = ZP.canonicalTargetURL(msg.targetUrl).href;
      const baseUrl = msg.baseUrl ? ZP.canonicalTargetURL(msg.baseUrl, targetUrl).href : targetUrl;
      const entryId = String(msg.entryId || randomEntryId());
      tab.entries.set(entryId, { entryId, targetUrl, baseUrl, referrerUrl: String(msg.referrerUrl || ''), title: '', stateClone: null, scrollX: 0, scrollY: 0, createdAt: Date.now() });
      shareRoutes.set(routeKey, { tabId: tab.tabId, entryId });
      ok({ path: ZP.makeSharePath(routeKey) });
      return;
    }
    if (msg.type === 'ZP_HISTORY_UPDATE') {
      const tab = runtimeTabForMessage(event, msg, fail);
      if (!tab) return;
      const targetUrl = ZP.canonicalTargetURL(msg.targetUrl).href;
      const baseUrl = msg.baseUrl ? ZP.canonicalTargetURL(msg.baseUrl, targetUrl).href : targetUrl;
      const entry = { entryId: msg.entryId, targetUrl, baseUrl, referrerUrl: String(msg.referrerUrl || ''), title: '', stateClone: null, scrollX: 0, scrollY: 0, createdAt: Date.now() };
      tab.entries.set(entry.entryId, entry);
      tab.activeEntryId = entry.entryId;
      if (msg.routeKey) shareRoutes.set(String(msg.routeKey), { tabId: tab.tabId, entryId: entry.entryId });
      ok();
      return;
    }
    if (msg.type === 'ZP_BASE_UPDATE') {
      const tab = runtimeTabForMessage(event, msg, fail);
      if (!tab) return;
      const entry = tab.entries.get(msg.entryId || tab.activeEntryId);
      if (!entry) { fail('SW_NOT_READY'); return; }
      entry.baseUrl = ZP.canonicalTargetURL(msg.baseUrl, entry.targetUrl).href;
      const sourceId = event.source && event.source.id;
      if (sourceId) bindClientContext(sourceId, tab, entry);
      ok({ baseUrl: entry.baseUrl });
      return;
    }
    if (msg.type === 'ZP_RESOLVE_ENTRY') {
      const ctx = contextFromPath(new URL(msg.path, ORIGIN).pathname);
      const tab = ctx && tabs.get(ctx.tabId);
      const entry = tab && tab.entries.get(ctx.entryId);
      if (!entry) { fail('SW_NOT_READY'); return; }
      if (!runtimeMessageAuthorized(event, tab, msg, fail)) return;
      ok({ tabId: tab.tabId, entryId: entry.entryId, targetUrl: entry.targetUrl, baseUrl: entry.baseUrl || entry.targetUrl, scrollX: entry.scrollX || 0, scrollY: entry.scrollY || 0, servers: tab.servers || [] });
      return;
    }
    if (msg.type === 'ZP_SCROLL_UPDATE') {
      const tab = runtimeTabForMessage(event, msg, fail);
      if (!tab) return;
      const entry = tab.entries.get(msg.entryId);
      if (entry) { entry.scrollX = Number(msg.scrollX) || 0; entry.scrollY = Number(msg.scrollY) || 0; }
      ok();
      return;
    }
    if (msg.type === 'ZP_COOKIE_SET') {
      const tab = runtimeTabForMessage(event, msg, fail);
      if (!tab) return;
      tab.documentCookie = mergeCookie(tab.documentCookie || '', msg.cookie);
      if (typeof self.__zp_cookie_set === 'function') self.__zp_cookie_set({ tabId: tab.tabId, targetUrl: msg.targetUrl, cookie: msg.cookie, streamIsolationKey: tab.streamIsolationKey });
      ok();
      return;
    }
    if (msg.type === 'ZP_FETCH_ABORT') {
      const tab = runtimeTabForMessage(event, msg, fail);
      if (!tab) return;
      const id = String(msg.requestId || '');
      const controller = id && inflightFetches.get(id);
      if (controller) controller.abort();
      ok();
      return;
    }
    if (msg.type === 'ZP_UPLOAD_STREAM_OPEN') {
      const tab = runtimeTabForMessage(event, msg, fail);
      if (!tab) return;
      const port = event.ports && event.ports[1];
      const id = String(msg.id || '');
      if (!id || !port || uploadStreams.has(id)) { fail('POLICY_BLOCKED'); return; }
      uploadStreams.set(id, { tabId: tab.tabId, port, queue: [], waiter: null, closed: false, error: null, createdAt: Date.now() });
      port.onmessage = ev => handleUploadPortMessage(id, ev && ev.data || {});
      try { port.start && port.start(); } catch {}
      ok({ id });
      return;
    }
    if (msg.type === 'ZP_WS_OPEN') { await openRuntimeStream(event, msg, ok, fail); return; }
    fail('POLICY_BLOCKED');
  } catch (e) { fail(e && e.code || e && e.message || 'POLICY_BLOCKED'); }
}

function handleUploadPortMessage(id, msg) {
  const upload = uploadStreams.get(id);
  if (!upload) return;
  const finish = value => {
    const waiter = upload.waiter;
    upload.waiter = null;
    if (waiter) waiter.resolve(value);
    else upload.queue.push(value);
  };
  if (msg.type === 'chunk') {
    finish(msg.data || new ArrayBuffer(0));
    return;
  }
  if (msg.type === 'close') {
    upload.closed = true;
    finish(null);
    return;
  }
  if (msg.type === 'error') {
    upload.error = msg.error || 'NetworkError';
    const waiter = upload.waiter;
    upload.waiter = null;
    if (waiter) waiter.reject(new Error(upload.error));
  }
}

function pullUploadChunk(id, upload) {
  if (upload.queue.length) {
    const value = upload.queue.shift();
    return value && typeof value.then === 'function' ? value : Promise.resolve(value);
  }
  if (upload.closed) return Promise.resolve(null);
  if (upload.error) return Promise.reject(new Error(upload.error));
  if (upload.waiter) return Promise.reject(new Error('UPLOAD_STREAM_BUSY'));
  return new Promise((resolve, reject) => {
    upload.waiter = { resolve, reject };
    try { upload.port.postMessage({ type: 'pull' }); }
    catch (err) {
      upload.waiter = null;
      reject(err);
    }
  });
}

function readableStreamFromUpload(id, upload) {
  return new ReadableStream({
    async pull(controller) {
      const chunk = await pullUploadChunk(id, upload);
      if (chunk == null) {
        uploadStreams.delete(id);
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunk));
    },
    cancel() {
      uploadStreams.delete(id);
      try { upload.port.postMessage({ type: 'cancel' }); } catch {}
      try { upload.port.close(); } catch {}
    }
  });
}

async function openRuntimeStream(event, msg, ok, fail) {
  const tab = runtimeTabForMessage(event, msg, fail);
  if (!tab) return;
  if (readiness !== 'READY') { try { await initKernel(tab.servers); } catch { fail('SW_NOT_READY'); return; } }
  if (typeof self.__zp_stream !== 'function') { fail('SW_NOT_READY'); return; }
  const stream = await self.__zp_stream({ url: msg.url, protocols: msg.protocols || [], tabId: tab.tabId, documentUrl: msg.documentUrl || '', streamIsolationKey: tab.streamIsolationKey, servers: tab.servers || [] });
  const channel = new MessageChannel();
  const id = ZP.randomId('s');
  streams.set(id, stream);
  channel.port1.onmessage = ev => { const m = ev.data || {}; if (m.type === 'send') stream.send(m.data); if (m.type === 'close') { stream.close(); streams.delete(id); } };
  stream.setHandlers({ message: data => channel.port1.postMessage({ type: 'message', data }), close: () => { channel.port1.postMessage({ type: 'close' }); streams.delete(id); }, error: () => channel.port1.postMessage({ type: 'error' }) });
  event.ports[0].postMessage({ ok: true, id, protocol: stream.protocol || '', port: channel.port2 }, [channel.port2]);
}

function runtimeTabForMessage(event, msg, fail) {
  const tab = tabs.get(String(msg.tabId || ''));
  if (!tab) { fail('SW_NOT_READY'); return null; }
  return runtimeMessageAuthorized(event, tab, msg, fail) ? tab : null;
}
function runtimeMessageAuthorized(event, tab, msg, fail) {
  if (!tab.runtimeToken || msg.runtimeToken !== tab.runtimeToken) { fail('POLICY_BLOCKED'); return false; }
  const sourceId = event.source && event.source.id;
  const ctx = sourceId && clientContext.get(sourceId);
  if (ctx && ctx.tabId !== tab.tabId) { fail('POLICY_BLOCKED'); return false; }
  return true;
}

function createTab(targetUrl, servers, challengeCompat) {
  const target = ZP.canonicalTargetURL(targetUrl).href;
  const tabId = ZP.randomId('t');
  const entryId = randomEntryId();
  const relayServers = ZP.relayServersForShare(servers || [], { allowLoopbackWS: true });
  // B4: challengeCompat is the per-tab arm bit, set ONCE at tab birth from the
  // explicit opt-in (default OFF). Birth-only by design: it mirrors the kernel's
  // birth-only TabState.ChallengeCompat so a live tab can never be re-armed.
  const tab = { tabId, activeEntryId: entryId, entries: new Map(), originMap: new Map(), cookieJar: null, storageNamespaces: new Map(), runtimeProfile: {}, streamIsolationKey: ZP.bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))), runtimeToken: ZP.randomId('rt'), documentCookie: '', servers: relayServers, challengeCompat: !!challengeCompat };
  tab.entries.set(entryId, { entryId, targetUrl: target, baseUrl: target, referrerUrl: '', title: '', stateClone: null, scrollX: 0, scrollY: 0, createdAt: Date.now() });
  tabs.set(tabId, tab);
  return tab;
}
function randomEntryId() { return ZP.randomId('e'); }
function bindClientContext(clientId, tab, entry) { if (clientId) clientContext.set(clientId, { tabId: tab.tabId, entryId: entry.entryId, targetUrl: entry.targetUrl, baseUrl: entry.baseUrl || entry.targetUrl }); }
function contextFromPath(path) { const p = parseSharePath(path); const state = p && shareRoutes.get(p.routeKey); const tab = state && tabs.get(state.tabId); const entry = tab && tab.entries.get(state.entryId); if (entry) return { tabId: tab.tabId, entryId: entry.entryId, targetUrl: entry.targetUrl, baseUrl: entry.baseUrl || entry.targetUrl }; return null; }
function contextFromURL(u) { if (u.origin === ORIGIN) return resourceContext.get(u.pathname + u.search) || contextFromPath(u.pathname); return resourceContext.get(u.href) || null; }
function contextFor(req, clientId) { const ref = req.headers.get('Referer'); if (ref) { try { const ctx = contextFromURL(new URL(ref)); if (ctx) return ctx; } catch {} } if (clientId && clientContext.has(clientId)) return clientContext.get(clientId); return null; }
function runtimeFetchContext(req, clientId) {
  const headerTab = req.headers.get('X-ZP-Tab-Id') || '';
  const headerEntry = req.headers.get('X-ZP-Entry-Id') || '';
  const token = req.headers.get('X-ZP-Runtime-Token') || '';
  const ctx = contextFor(req, clientId);
  if (ctx) {
    const tab = tabs.get(ctx.tabId);
    if (!tab) return null;
    if (headerTab && headerTab !== ctx.tabId) return null;
    if (token && token !== tab.runtimeToken) return null;
    return { tab, entryId: ctx.entryId || tab.activeEntryId };
  }
  if (!headerTab || !token) return null;
  const tab = tabs.get(headerTab);
  if (!tab || token !== tab.runtimeToken) return null;
  return { tab, entryId: headerEntry || tab.activeEntryId };
}
function scriptRequestContext(req, url, clientId) {
  const queryTab = url.searchParams.get('tab') || '';
  const queryToken = url.searchParams.get('rt') || '';
  const headerTab = req.headers.get('X-ZP-Tab-Id') || '';
  const token = req.headers.get('X-ZP-Runtime-Token') || queryToken;
  if (queryTab && token) {
    const tab = tabs.get(queryTab);
    if (!tab || token !== tab.runtimeToken) return null;
    if (headerTab && headerTab !== queryTab) return null;
    return { tab, entryId: url.searchParams.get('entry') || tab.activeEntryId };
  }
  const ctx = contextFor(req, clientId);
  if (ctx) {
    const tab = tabs.get(ctx.tabId);
    if (!tab) return null;
    if (queryTab && queryTab !== ctx.tabId) return null;
    if (headerTab && headerTab !== ctx.tabId) return null;
    if (token && token !== tab.runtimeToken) return null;
    return { tab, entryId: ctx.entryId || tab.activeEntryId };
  }
  const tabId = queryTab || headerTab;
  if (!tabId || !token) return null;
  const tab = tabs.get(tabId);
  if (!tab || token !== tab.runtimeToken) return null;
  return { tab, entryId: url.searchParams.get('entry') || tab.activeEntryId };
}
function rememberResourceContext(requestURL, targetUrl, ctx) {
  const next = { tabId: ctx.tabId, entryId: ctx.entryId, targetUrl: ctx.targetUrl, baseUrl: targetUrl };
  const key = requestURL.origin === ORIGIN ? requestURL.pathname + requestURL.search : requestURL.href;
  resourceContext.set(key, next);
  resourceContext.set(targetUrl, next);
  while (resourceContext.size > 2048) resourceContext.delete(resourceContext.keys().next().value);
}
function mergeCookie(current, line) { const first = String(line).split(';',1)[0]; const eq = first.indexOf('='); if (eq <= 0) return current; const name = first.slice(0, eq); const kept = current ? current.split(/;\s*/).filter(p => p.split('=')[0] !== name) : []; kept.push(first); return kept.join('; '); }
async function broadcastCookieSync(payload) {
  const msg = Object.assign({ type: 'ZP_COOKIE_SYNC' }, payload || {});
  const tab = tabs.get(String(msg.tabId || ''));
  if (tab && typeof msg.cookieString === 'string') tab.documentCookie = msg.cookieString;
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    const ctx = clientContext.get(client.id);
    if (!msg.tabId || ctx && ctx.tabId === msg.tabId) {
      try { client.postMessage(msg); } catch {}
    }
  }
}
function isCORSPreflight(req) { return req.method === 'OPTIONS' && req.headers.has('Access-Control-Request-Method'); }
function corsPreflight(req) { const h = new Headers(); applyCORS(h, req); h.set('Access-Control-Max-Age', '86400'); h.set('Cache-Control', 'no-store'); return new Response(null, { status: 204, headers: h }); }
function applyCORS(h, req) {
  const origin = req && req.headers.get('Origin') || '*';
  h.set('Access-Control-Allow-Origin', origin);
  if (origin !== '*') h.set('Vary', h.get('Vary') ? h.get('Vary') + ', Origin' : 'Origin');
  h.set('Access-Control-Allow-Credentials', 'true');
  h.set('Access-Control-Allow-Methods', req && req.headers.get('Access-Control-Request-Method') || 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  h.set('Access-Control-Allow-Headers', req && req.headers.get('Access-Control-Request-Headers') || '*');
  h.set('Access-Control-Expose-Headers', '*');
}
function normalizedByteStream(body) {
  if (!body || typeof body.getReader !== 'function') return body || null;
  const reader = body.getReader();
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        try { reader.releaseLock(); } catch {}
        return;
      }
      const value = next.value;
      if (value == null) return;
      if (value instanceof Uint8Array) controller.enqueue(value);
      else if (value instanceof ArrayBuffer) controller.enqueue(new Uint8Array(value));
      else if (value && value.buffer instanceof ArrayBuffer) controller.enqueue(new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength || value.buffer.byteLength));
      else if (typeof Blob !== 'undefined' && value instanceof Blob) controller.enqueue(new Uint8Array(await value.arrayBuffer()));
      else if (typeof value === 'string') controller.enqueue(encoder.encode(value));
      else controller.enqueue(encoder.encode(String(value)));
    },
    cancel(reason) {
      try { reader.cancel(reason); } catch {}
      try { reader.releaseLock(); } catch {}
    }
  });
}
function addCSP(resp, req, servers) {
  const h = new Headers(resp.headers);
  const allowDynamicCompile = h.get('X-ZP-Dynamic-Compile') === '1';
  h.delete('X-ZP-Dynamic-Compile');
  // B4: consume the kernel's two-signal (armed AND header/URL-classified) challenge
  // marker and project the challenge CSP. The internal marker is DELETED here so it
  // never reaches the proxied page. Default OFF: absent marker => challengeCompat
  // false => byte-identical to the prior CSP.
  const challengeCompat = h.get('X-ZP-Challenge-Compat') === '1';
  h.delete('X-ZP-Challenge-Compat');
  h.set('Content-Security-Policy', ZP.fixedCSP(servers || [], { allowDynamicCompile, challengeCompat }));
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Cache-Control', h.get('Cache-Control') || 'no-store');
  applyCORS(h, req);
  return new Response(normalizedByteStream(resp.body), { status: resp.status, statusText: resp.statusText, headers: h });
}
function safeError(code, status = 400, targetUrl = '') { if (!ZP.ERRORS.includes(code)) code = 'POLICY_BLOCKED'; let host = ''; try { host = targetUrl ? new URL(targetUrl).host : ''; } catch {} const hostHTML = host ? '<p>Target host: '+escapeHTML(host)+'</p>' : ''; const body = '<!doctype html><meta charset="utf-8"><title>ZeroProxy '+code+'</title><main><h1>ZeroProxy</h1><p>'+code+'</p>'+hostHTML+'<button onclick="history.back()">Back</button><button onclick="location.reload()">Retry</button></main>'; return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': ZP.fixedCSP(), 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': '*' } }); }
function escapeHTML(s) { return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&#34;',"'":'&#39;'}[ch])); }
function workerBootstrap(url) { const body = "const __zp_worker_params=new URLSearchParams(self.location.hash.slice(1));self.__ZP_WORKER_TARGET=__zp_worker_params.get('u')||'about:blank';self.__ZP_WORKER_LOCATION=__zp_worker_params.get('loc')||self.__ZP_WORKER_TARGET;self.__ZP_WORKER_TAB_ID=__zp_worker_params.get('tab')||'';self.__ZP_WORKER_RUNTIME_TOKEN=__zp_worker_params.get('rt')||'';self.__ZP_WORKER_SERVERS=__zp_worker_params.getAll('server');importScripts('/zp/assets/worker-prelude.js');importScripts('/zp/api/worker-script?tab=' + encodeURIComponent(self.__ZP_WORKER_TAB_ID) + '&rt=' + encodeURIComponent(self.__ZP_WORKER_RUNTIME_TOKEN) + '&u=' + encodeURIComponent(self.__ZP_WORKER_TARGET));"; return new Response(body, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': ZP.fixedCSP(), 'X-Content-Type-Options': 'nosniff' } }); }
