/* ZeroProxy Service Worker: controlled network requests are routed through the WASM transport. */
importScripts('/__zp/zp-core.js');
importScripts('/__zp/wasm_exec.js');

const nativeFetch = self.fetch.bind(self);
const ORIGIN = self.location.origin;
const tabs = new Map();
const clientContext = new Map();
const shareRoutes = new Map();
const resourceContext = new Map();
const streams = new Map();
let readiness = 'UNINITIALIZED';
let kernelPromise = null;

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => { await self.clients.claim(); initKernel().catch(() => {}); })()));
self.addEventListener('message', event => event.waitUntil(handleMessage(event)));
self.addEventListener('fetch', event => { event.respondWith(handleFetch(event)); });

async function initKernel() {
  if (readiness === 'READY') return;
  if (kernelPromise) return kernelPromise;
  kernelPromise = (async () => {
    readiness = 'WASM_LOADING';
    const go = new Go();
    const resp = await nativeFetch('/__zp/kernel.wasm', { cache: 'no-store' });
    if (!resp.ok) throw new Error('SW_NOT_READY');
    const result = await WebAssembly.instantiateStreaming(resp, go.importObject);
    readiness = 'WASM_LOADED';
    go.run(result.instance);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (typeof self.__go_jshttp !== 'function' || typeof self.__zp_stream !== 'function' || typeof self.__zp_kernel_init !== 'function')) await new Promise(r => setTimeout(r, 20));
    if (typeof self.__go_jshttp !== 'function' || typeof self.__zp_stream !== 'function' || typeof self.__zp_kernel_init !== 'function') throw new Error('SW_NOT_READY');
    await self.__zp_kernel_init();
    readiness = 'READY';
  })().catch(err => { readiness = 'UNINITIALIZED'; kernelPromise = null; throw err; });
  return kernelPromise;
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
    if (url.pathname.startsWith('/__zp/api/')) return { kind: 'RUNTIME_API' };
    if (url.pathname.startsWith('/__zp/error/')) return { kind: 'INTERNAL_ASSET' };
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/sw.js' || internalPath(url.pathname)) return { kind: 'INTERNAL_ASSET' };
    const ctx = contextFor(req, clientId);
    const p = parseSharePath(url.pathname);
    if (p && req.mode === 'navigate') return { kind: 'PROXY_DOCUMENT', ...p };
    if (ctx) return { kind: 'VIRTUAL_SUBRESOURCE', ctx, sameOriginURL: url };
    if (p && shareRoutes.has(p.routeKey)) return { kind: 'PROXY_DOCUMENT', ...p };
    return { kind: 'UNKNOWN' };
  }
  const ctx = contextFor(req, clientId) || defaultContext();
  if (ctx && (url.protocol === 'http:' || url.protocol === 'https:')) return { kind: 'VIRTUAL_SUBRESOURCE', ctx, crossOriginURL: url };
  return { kind: 'UNKNOWN' };
}

function internalPath(path) {
  return path === '/__zp/zp-core.js' || path === '/__zp/runtime-prelude.js' || path === '/__zp/worker-prelude.js' || path === '/__zp/wasm_exec.js' || path === '/__zp/kernel.wasm' || path === '/__zp/worker-bootstrap.js' || path === '/favicon.ico' || path === '/manifest.webmanifest';
}

async function internalAsset(req, url) {
  if (url.pathname.startsWith('/__zp/error/')) return safeError(decodeURIComponent(url.pathname.split('/').pop() || 'POLICY_BLOCKED'), 400);
  if (url.pathname === '/__zp/worker-bootstrap.js') return workerBootstrap(url);
  if (url.pathname === '/' || url.pathname === '/index.html') return addCSP(await nativeFetch('/index.html', { cache: 'no-store' }), req);
  if (!internalPath(url.pathname) && url.pathname !== '/sw.js') return safeError('POLICY_BLOCKED', 403);
  return addCSP(await nativeFetch(req, { cache: 'no-store' }), req);
}

function parseSharePath(path) {
  const m = /^\/p\/([^/]+)$/.exec(path);
  if (!m) return null;
  return { routeKey: m[1] };
}



async function proxyDocument(req, route, clientId) {
  const state = shareRoutes.get(route.routeKey);
  if (!state) return internalAsset(new Request('/'), new URL('/', ORIGIN));
  const tab = tabs.get(state.tabId);
  const entry = tab && tab.entries.get(state.entryId);
  if (!tab || !entry) {
    shareRoutes.delete(route.routeKey);
    return internalAsset(new Request('/'), new URL('/', ORIGIN));
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
  return resp;
}

function sameOriginTargetURL(sameOriginURL, ctx) {
  const baseTargetURL = ctx.baseUrl || ctx.targetUrl;
  if (sameOriginURL.pathname.startsWith('/p/')) {
    return new URL(sameOriginURL.pathname.slice(3) + sameOriginURL.search, baseTargetURL).href;
  }
  return new URL(sameOriginURL.pathname + sameOriginURL.search, baseTargetURL).href;
}

async function runtimeAPI(req, url, clientId) {
  if (url.pathname === '/__zp/api/fetch') {
    if (req.method !== 'POST') return safeError('POLICY_BLOCKED', 405);
    const payload = await req.json();
    const ctx = contextFor(req, clientId);
    const tab = ctx && tabs.get(ctx.tabId) || firstTab();
    if (!tab) return safeError('SW_NOT_READY', 503);
    let body;
    if (payload.init && payload.init.body) body = ZP.base64UrlToBytes(payload.init.body);
    return transportFetch(payload.url, { method: payload.init && payload.init.method || 'GET', headers: payload.init && payload.init.headers || [], body, tab: payload.tabId && tabs.get(payload.tabId) || tab, entryId: ctx && ctx.entryId || (payload.tabId && tabs.get(payload.tabId) && tabs.get(payload.tabId).activeEntryId) || tab.activeEntryId });
  }
  if (url.pathname === '/__zp/api/worker-script') {
    const target = url.searchParams.get('u');
    const tab = url.searchParams.get('tab') && tabs.get(url.searchParams.get('tab')) || firstTab();
    if (!target || !tab) return safeError('SW_NOT_READY', 503);
    return transportFetch(target, { method: 'GET', headers: [['Accept', 'text/javascript,*/*']], tab, entryId: tab.activeEntryId });
  }
  return safeError('POLICY_BLOCKED', 404);
}

async function transportFetch(targetUrl, opt) {
  let u;
  try { u = ZP.canonicalTargetURL(targetUrl).href; } catch (e) { return safeError(e.code || 'TARGET_PROTOCOL_BLOCKED', 403, targetUrl); }
  if (readiness !== 'READY') { try { await initKernel(); } catch { return safeError('SW_NOT_READY', 503); } }
  const headers = new Headers(opt.headers || (opt.request && opt.request.headers) || undefined);
  headers.set('X-ZP-Tab-Id', opt.tab.tabId);
  headers.set('X-ZP-Entry-Id', opt.entryId || opt.tab.activeEntryId || '');
  headers.set('X-ZP-Stream-Isolation-Key', opt.tab.streamIsolationKey);
  headers.set('X-ZP-Runtime-Token', opt.tab.runtimeToken || '');
  if (opt.document) headers.set('X-ZP-Document-Request', '1');
  const init = { method: opt.method || (opt.request && opt.request.method) || 'GET', headers };
  if (init.method !== 'GET' && init.method !== 'HEAD') init.body = opt.body || (opt.request && await opt.request.clone().arrayBuffer());
  const resp = await self.__go_jshttp(new Request(u, init));
  return addCSP(resp, opt.request);
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
      const tab = createTab(msg.targetUrl);
      shareRoutes.set(routeKey, { tabId: tab.tabId, entryId: tab.activeEntryId });
      ok({ path: '/p/' + routeKey });
      return;
    }
    if (msg.type === 'ZP_HISTORY_UPDATE') {
      const tab = runtimeTabForMessage(event, msg, fail);
      if (!tab) return;
      const targetUrl = ZP.canonicalTargetURL(msg.targetUrl).href;
      const baseUrl = msg.baseUrl ? ZP.canonicalTargetURL(msg.baseUrl, targetUrl).href : targetUrl;
      const entry = { entryId: msg.entryId, targetUrl, baseUrl, title: '', stateClone: null, scrollX: 0, scrollY: 0, createdAt: Date.now() };
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
      ok({ tabId: tab.tabId, entryId: entry.entryId, targetUrl: entry.targetUrl, baseUrl: entry.baseUrl || entry.targetUrl, scrollX: entry.scrollX || 0, scrollY: entry.scrollY || 0 });
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
    if (msg.type === 'ZP_WS_OPEN') { await openRuntimeStream(event, msg, ok, fail); return; }
    fail('POLICY_BLOCKED');
  } catch (e) { fail(e && e.code || e && e.message || 'POLICY_BLOCKED'); }
}

async function openRuntimeStream(event, msg, ok, fail) {
  if (readiness !== 'READY') { try { await initKernel(); } catch { fail('SW_NOT_READY'); return; } }
  const tab = runtimeTabForMessage(event, msg, fail);
  if (!tab) return;
  if (typeof self.__zp_stream !== 'function') { fail('SW_NOT_READY'); return; }
  const stream = await self.__zp_stream({ url: msg.url, protocols: msg.protocols || [], tabId: tab.tabId, streamIsolationKey: tab.streamIsolationKey });
  const channel = new MessageChannel();
  const id = ZP.randomId('s');
  streams.set(id, stream);
  channel.port1.onmessage = ev => { const m = ev.data || {}; if (m.type === 'send') stream.send(m.data); if (m.type === 'close') { stream.close(); streams.delete(id); } };
  stream.setHandlers({ message: data => channel.port1.postMessage({ type: 'message', data }), close: () => { channel.port1.postMessage({ type: 'close' }); streams.delete(id); }, error: () => channel.port1.postMessage({ type: 'error' }) });
  event.ports[0].postMessage({ ok: true, id, port: channel.port2 }, [channel.port2]);
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

function createTab(targetUrl) {
  const target = ZP.canonicalTargetURL(targetUrl).href;
  const tabId = ZP.randomId('t');
  const entryId = randomEntryId();
  const tab = { tabId, activeEntryId: entryId, entries: new Map(), originMap: new Map(), cookieJar: null, storageNamespaces: new Map(), runtimeProfile: {}, streamIsolationKey: ZP.bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))), runtimeToken: ZP.randomId('rt'), documentCookie: '' };
  tab.entries.set(entryId, { entryId, targetUrl: target, baseUrl: target, title: '', stateClone: null, scrollX: 0, scrollY: 0, createdAt: Date.now() });
  tabs.set(tabId, tab);
  return tab;
}
function randomEntryId() { return ZP.randomId('e'); }
function bindClientContext(clientId, tab, entry) { if (clientId) clientContext.set(clientId, { tabId: tab.tabId, entryId: entry.entryId, targetUrl: entry.targetUrl, baseUrl: entry.baseUrl || entry.targetUrl }); }
function contextFromPath(path) { const p = parseSharePath(path); const state = p && shareRoutes.get(p.routeKey); const tab = state && tabs.get(state.tabId); const entry = tab && tab.entries.get(state.entryId); if (entry) return { tabId: tab.tabId, entryId: entry.entryId, targetUrl: entry.targetUrl, baseUrl: entry.baseUrl || entry.targetUrl }; return null; }
function contextFromURL(u) { if (u.origin === ORIGIN) return resourceContext.get(u.pathname + u.search) || contextFromPath(u.pathname); return resourceContext.get(u.href) || null; }
function contextFor(req, clientId) { const ref = req.headers.get('Referer'); if (ref) { try { const ctx = contextFromURL(new URL(ref)); if (ctx) return ctx; } catch {} } if (clientId && clientContext.has(clientId)) return clientContext.get(clientId); return null; }
function defaultContext() { const tab = firstTab(); const entry = tab && tab.entries.get(tab.activeEntryId); if (!entry) return null; return { tabId: tab.tabId, entryId: entry.entryId, targetUrl: entry.targetUrl, baseUrl: entry.baseUrl || entry.targetUrl }; }
function firstTab() { for (const t of tabs.values()) return t; return null; }
function rememberResourceContext(requestURL, targetUrl, ctx) {
  const next = { tabId: ctx.tabId, entryId: ctx.entryId, targetUrl: ctx.targetUrl, baseUrl: targetUrl };
  const key = requestURL.origin === ORIGIN ? requestURL.pathname + requestURL.search : requestURL.href;
  resourceContext.set(key, next);
  resourceContext.set(targetUrl, next);
  while (resourceContext.size > 2048) resourceContext.delete(resourceContext.keys().next().value);
}
function mergeCookie(current, line) { const first = String(line).split(';',1)[0]; const eq = first.indexOf('='); if (eq <= 0) return current; const name = first.slice(0, eq); const kept = current ? current.split(/;\s*/).filter(p => p.split('=')[0] !== name) : []; kept.push(first); return kept.join('; '); }
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
function addCSP(resp, req) { const h = new Headers(resp.headers); h.set('Content-Security-Policy', ZP.fixedCSP()); h.set('X-Content-Type-Options', 'nosniff'); h.set('Cache-Control', h.get('Cache-Control') || 'no-store'); applyCORS(h, req); return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h }); }
function safeError(code, status = 400, targetUrl = '') { if (!ZP.ERRORS.includes(code)) code = 'POLICY_BLOCKED'; let host = ''; try { host = targetUrl ? new URL(targetUrl).host : ''; } catch {} const hostHTML = host ? '<p>Target host: '+escapeHTML(host)+'</p>' : ''; const body = '<!doctype html><meta charset="utf-8"><title>ZeroProxy '+code+'</title><main><h1>ZeroProxy</h1><p>'+code+'</p>'+hostHTML+'<button onclick="history.back()">Back</button><button onclick="location.reload()">Retry</button></main>'; return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': ZP.fixedCSP(), 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': '*' } }); }
function escapeHTML(s) { return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&#34;',"'":'&#39;'}[ch])); }
function workerBootstrap(url) { const body = "const __zp_worker_params=new URLSearchParams(self.location.hash.slice(1));self.__ZP_WORKER_TARGET=__zp_worker_params.get('u')||'about:blank';self.__ZP_WORKER_TAB_ID=__zp_worker_params.get('tab')||'';importScripts('/__zp/worker-prelude.js');importScripts('/__zp/api/worker-script?tab=' + encodeURIComponent(self.__ZP_WORKER_TAB_ID) + '&u=' + encodeURIComponent(self.__ZP_WORKER_TARGET));"; return new Response(body, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': ZP.fixedCSP(), 'X-Content-Type-Options': 'nosniff' } }); }
