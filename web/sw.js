/* ZeroProxy Service Worker: controlled network requests are routed through the Rust WASM kernel. */
importScripts('/zp/assets/zp-core.js');
importScripts('/zp/assets/rust-rewriter.js');
// Rust zp-bundle (no-modules variant). Must be imported at top-level: SW
// `importScripts` only succeeds during initial script evaluation; lazy
// import from inside an event handler is blocked by the worker spec and
// fails with "failed to load" even if the URL is served correctly.
importScripts('/__zp/zp_bundle_sw.js');

const nativeFetch = self.fetch.bind(self);
const ORIGIN = self.location.origin;
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const tabs = new Map();
const clientContext = new Map();
const shareRoutes = new Map();
const resourceContext = new Map();
const pendingSubmissions = new Map();
const streams = new Map();
const SUBMISSION_TTL_MS = 5 * 60 * 1000;
let rewriterPromise = null;
let bundlePromise = null;

// C4: in-memory LRU cache for rewritten script bodies. Key invariant:
// SHA-256(transformerVersion | kind | targetURL | sourceBytes). A version
// bump on either rewriter pipeline invalidates every entry. Only
// SUCCESSFUL rewrites are stored — failures fall through to the
// fail-closed `blockSource()` so a transient parser bug never gets pinned.
const REWRITE_CACHE_MAX_ENTRIES = 200;
const REWRITE_CACHE_MAX_BYTES = 50 * 1024 * 1024;
const rewriteCache = new Map();
let rewriteCacheBytes = 0;
let rewriteCacheVersion = '';

function rewriteCacheTransformerVersion() {
  if (rewriteCacheVersion) return rewriteCacheVersion;
  try {
    if (self.ZPBundle && self.ZPBundle.bundleVersion) {
      rewriteCacheVersion = String(self.ZPBundle.bundleVersion || '');
    }
  } catch {}
  return rewriteCacheVersion;
}

async function rewriteCacheKey(kind, targetUrl, source) {
  const version = rewriteCacheTransformerVersion();
  // Length-prefix every field so two distinct triples can't field-boundary collide.
  const payload = `${version.length}:${version}|${String(kind).length}:${kind}|${String(targetUrl).length}:${targetUrl}|${source.length}:${source}`;
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0');
  return hex;
}

function rewriteCacheGet(key) {
  if (!rewriteCache.has(key)) return null;
  const entry = rewriteCache.get(key);
  rewriteCache.delete(key);
  rewriteCache.set(key, entry);
  return entry.code;
}

function rewriteCacheSet(key, code) {
  if (typeof code !== 'string' || code.length === 0) return;
  if (code.length > REWRITE_CACHE_MAX_BYTES) return;
  if (rewriteCache.has(key)) {
    const prev = rewriteCache.get(key);
    rewriteCacheBytes -= prev.code.length;
    rewriteCache.delete(key);
  }
  rewriteCache.set(key, { code });
  rewriteCacheBytes += code.length;
  while (rewriteCache.size > REWRITE_CACHE_MAX_ENTRIES || rewriteCacheBytes > REWRITE_CACHE_MAX_BYTES) {
    const oldest = rewriteCache.keys().next().value;
    if (oldest === undefined) break;
    const ev = rewriteCache.get(oldest);
    rewriteCache.delete(oldest);
    rewriteCacheBytes -= ev.code.length;
  }
}

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
// 2026-06-07 split-bundle (c.1) Step 2.0: activate 가 initBundle 을 실제로
// await (이전엔 fire-and-forget). SW 가 activated 상태로 진입할 때 ZPBundle.ready
// 가 보장됨 → 첫 fetch 가 cold-init latency 없이 즉시 ZPBundle 사용 가능. 30s
// timeout 으로 wasm fetch 가 실패해도 activate 가 stuck 되지 않도록 보호.
// 그래도 ZPBundle.ready 가 false 면 hot-path 가 `await initBundle()` 재시도.
self.addEventListener('activate', event => event.waitUntil((async () => {
  await self.clients.claim();
  const BUNDLE_BOOT_TIMEOUT_MS = 30000;
  await Promise.race([
    initBundle().catch(() => null),
    new Promise(r => setTimeout(r, BUNDLE_BOOT_TIMEOUT_MS)),
  ]);
})()));
self.addEventListener('message', event => event.waitUntil(handleMessage(event)));
self.addEventListener('fetch', event => { event.respondWith(handleFetch(event)); });

async function initRewriter() {
  if (!self.ZPRewriter || !self.ZPRewriter.ready || typeof self.ZPRewriter.rewriteScript !== 'function') throw new Error('REALM_INJECTION_FAILURE');
}

// Rust zp-bundle (OXC native crate). Initializes lazily and exposes
// self.ZPBundle.{rewriteScript, transformHtml, buildCSP, bundleVersion}.
// The JS ZPRewriter remains the primary path during this migration window;
// the Rust bundle is available for parity tests and gradual cut-over.
//
// captureBrowserFingerprint returns the hardcoded Chrome 148 ClientHello
// spec the WASM kernel installs into rustls' `set_captured_spec`. The
// historical server-side capture endpoint (Go `-tls-addr` HTTPS listener
// + `/zp/api/fp`) was deleted 2026-06-05: in practice the SW never
// actually fetched from it because Chrome refuses to grant SW fetch
// permission to a self-signed HTTPS port, and shipping a trusted cert in
// a local dev binary is impractical. The Chrome 148 spec below was
// captured once from a real browser at tls.peet.ws and frozen into the
// build. Updating to a future Chrome version is a one-line replacement
// of the base64 blob (decode shape: `{supportedVersions,cipherSuites,
// extensions,supportedCurves,supportedPoints,signatureSchemes,alpnProtocols}`).
//
// Phase 5.8 spec details:
//   - cipherSuites: 15 entries in Chrome 148 interleaved (AES128, AES256,
//     CHACHA) order with ECDSA/RSA per-row pairs.
//   - extensions: Chrome 148 order [0, 17613, 51, 65281, 43, 16, 5, 11,
//     13, 18, 23, 27, 10, 35, 45, 65037] — 65037 = ECH GREASE (Phase 5.10).
//   - supportedCurves: [4588, 29, 23, 24] — 4588 = X25519MLKEM768 (Phase
//     5.9 hybrid emit in mlkem_hybrid.rs).
//   - record_size_limit (id 28) ABSENT (Firefox-specific).
const CAPTURED_FINGERPRINT_B64 = 'eyJzdXBwb3J0ZWRWZXJzaW9ucyI6Wzc3Miw3NzFdLCJjaXBoZXJTdWl0ZXMiOls0ODY1LDQ4NjYsNDg2Nyw0OTE5NSw0OTE5OSw0OTE5Niw0OTIwMCw1MjM5Myw1MjM5Miw0OTE3MSw0OTE3MiwxNTYsMTU3LDQ3LDUzXSwiZXh0ZW5zaW9ucyI6WzAsMTc2MTMsNTEsNjUyODEsNDMsMTYsNSwxMSwxMywxOCwyMywyNywxMCwzNSw0NSw2NTAzN10sInN1cHBvcnRlZEN1cnZlcyI6WzQ1ODgsMjksMjMsMjRdLCJzdXBwb3J0ZWRQb2ludHMiOiJBQT09Iiwic2lnbmF0dXJlU2NoZW1lcyI6WzEwMjcsMjA1MiwxMDI1LDEyODMsMjA1MywxMjgxLDIwNTQsMTUzN10sImFscG5Qcm90b2NvbHMiOlsiaDIiLCJodHRwLzEuMSJdfQ==';
function captureBrowserFingerprint() { return CAPTURED_FINGERPRINT_B64; }

async function initBundle() {
  if (self.ZPBundle && self.ZPBundle.ready) return;
  if (bundlePromise) return bundlePromise;
  // Bundle glue is wrapped in an IIFE that exposes wasm_bindgen as
  // self.ZPBundleWBG (avoiding `let wasm_bindgen` collision with the
  // legacy rewriter-rs glue). The importScripts for the bundle happens at
  // top level of this SW (worker spec only allows importScripts there).
  const wbg = self.ZPBundleWBG;
  if (typeof wbg !== 'function') {
    throw new Error('REALM_INJECTION_FAILURE');
  }
  bundlePromise = (async () => {
    await wbg({ module_or_path: '/__zp/zp_bundle_sw_bg.wasm' });
    // CRITICAL: `wbg` (the wasm-bindgen factory function) carries the JS
    // glue wrappers as own properties (Object.assign(__wbg_init, {...exports}))
    // — those wrappers do addHeapObject/takeObject. The factory's return
    // value is the raw `wasm.exports` table, which takes/returns ints
    // (heap indices) directly and would mishandle JS objects. Always read
    // through wbg.<name>, never through the awaited factory result.
    self.ZPBundle = Object.freeze({
      ready: true,
      bundleVersion: wbg.bundleVersion,
      rewriteScript: (source, kind, targetUrl) => wbg.rewriteScript(source, kind || 'classic', targetUrl || ''),
      // Patch-mode emit: returns `{"len":N,"patches":[{start,end,replacement},…]}`
      // as a JSON string. Caller applies patches over the original source it
      // already holds — skips the O(n) full re-emit + cross-ABI string copy.
      // Optional (export missing on older bundles → SW falls back to full path).
      rewriteScriptPatches: typeof wbg.rewriteScriptPatches === 'function'
        ? (source, kind, targetUrl) => wbg.rewriteScriptPatches(source, kind || 'classic', targetUrl || '')
        : null,
      transformHtml: (html, targetUrl) => wbg.transformHtml(html, targetUrl || '', ORIGIN),
      // D2: unchained composer (rewriter_map only). Required by
      // /zp/api/sourcemap when no upstream `.map` is present.
      composeSourceMap: (source, kind, targetUrl) =>
        wbg.composeSourceMap(source, kind || 'classic', targetUrl || ''),
      // D2 follow-on: chained composer (rewriter_map ∘ original_map).
      // Optional on older bundles; the SW falls back to the unchained
      // composer when missing or when no upstream map exists.
      composeSourceMapChained: typeof wbg.composeSourceMapChained === 'function'
        ? (source, kind, targetUrl, originalMapJson) =>
            wbg.composeSourceMapChained(source, kind || 'classic', targetUrl || '', originalMapJson || '')
        : null,
      buildCSP: (wsOrigin) => wbg.buildCSP(wsOrigin || ''),
      kernelVersion: wbg.kernelVersion,
      kernelInit: wbg.kernelInit,
      kernelFetch: wbg.kernelFetch,
      kernelEchoSync: wbg.kernelEchoSync,
      kernelStream: wbg.kernelStream,
      kernelLastNamedGroups: wbg.kernelLastNamedGroups,
    });
    // Step 13: expose the Rust kernel under the same globals the SW
    // transport path already probes (self.kernelFetch / self.kernelStream).
    const kf = self.ZPBundle.kernelFetch;
    if (typeof kf === 'function') {
      // Call directly, no wrapper: ensures we don't accidentally drop or
      // re-wrap the JsValue ABI ref between page and WASM.
      self.kernelFetch = kf;
    }
    const ks = self.ZPBundle.kernelStream;
    if (typeof ks === 'function') self.kernelStream = ks;
    const ki = self.ZPBundle.kernelInit;
    if (typeof ki === 'function') {
      try { ki(); } catch {}
    }
    // Hand the captured spec to the kernel before any upstream fetch.
    // Run this in parallel with the rest of bundle init so the SW's
    // own self.fetch round-trip doesn't gate kernel readiness; if the
    // spec arrives after the first kernel_fetch, that fetch uses the
    // rustls fork's hardcoded fallback (Chrome 134, phase 2) and only
    // subsequent fetches use the captured layout. Acceptable, because
    // the launcher's first navigation happens many seconds after SW
    // activation in practice.
    const setSpec = wbg.kernelSetCapturedSpec;
    if (typeof setSpec === 'function') {
      const spec = await captureBrowserFingerprint();
      if (spec) {
        try { setSpec(spec); } catch {}
      }
    }
  })().catch(err => { bundlePromise = null; throw err; });
  return bundlePromise;
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
    // A2 hardening: same-origin sub-resources must resolve a tab from an
    // explicit signal (Referer-derived ctx or saved clientContext). No
    // first-available-tab fallback — multi-tab leak risk.
    const ctx = contextFor(req, clientId);
    const p = parseSharePath(url.pathname);
    if (p && req.mode === 'navigate') return { kind: 'PROXY_DOCUMENT', ...p };
    if (ctx && url.pathname.startsWith(ZP.CONTROL_PREFIX)) return { kind: 'VIRTUAL_SUBRESOURCE', ctx, sameOriginURL: url };
    if (p && shareRoutes.has(p.routeKey)) return { kind: 'PROXY_DOCUMENT', ...p };
    return { kind: 'UNKNOWN' };
  }
  // A2 hardening: same policy for cross-origin — no defaultContext() fallback.
  const ctx = contextFor(req, clientId);
  if (ctx && (url.protocol === 'http:' || url.protocol === 'https:')) return { kind: 'VIRTUAL_SUBRESOURCE', ctx, crossOriginURL: url };
  return { kind: 'UNKNOWN' };
}

function internalPath(path) {
  // `/__zp/*` is the proxy server's static asset prefix for WASM blobs
  // (`zp_bundle_sw_bg.wasm`, `zp_bundle_sw.js`, `zp_page_rt.wasm`, etc.)
  // that the page prelude and SW load via root-relative URLs. Without
  // claiming them as internal, the SW falls through to VIRTUAL_SUBRESOURCE
  // and rewrites `/__zp/zp_page_rt.wasm` against the virtual baseUrl
  // (e.g. `https://github.com/__zp/zp_page_rt.wasm`) — upstream 404 →
  // page-rt fails to instantiate → URL classification falls back → some
  // sites (GitHub) hit subtle membrane bugs that surface as React
  // hydration errors → "Looks like something went wrong" SSR fallback.
  if (path.startsWith('/__zp/')) return true;
  return path === ZP.assetPath('zp-core.js') || path === ZP.assetPath('rust-rewriter.js') || path === ZP.assetPath('runtime-prelude.js') || path === ZP.assetPath('worker-prelude.js') || path === ZP.controlPath('worker-bootstrap.js') || path === ZP.assetPath('favicon.ico') || path === ZP.assetPath('manifest.webmanifest');
}
function isRuntimeAPIPath(path) {
  return path === ZP.apiPath('fetch') || path === ZP.apiPath('script') || path === ZP.apiPath('worker-script') || path === ZP.apiPath('sourcemap') || path === '/zp/api/diag/trace' || path === '/zp/api/__shadow_log';
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
  cleanupPendingSubmissions();
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
  const submitId = new URL(req.url).searchParams.get('zp_submit');
  const resp = submitId
    ? await submittedDocument(req, route.routeKey, submitId, tab, entry, clientId)
    : await transportFetch(entry.targetUrl, { request: req, document: true, tab, entryId: entry.entryId });
  return transformDocumentResponse(resp, { tab, entry });
}
async function submittedDocument(req, routeKey, submitId, tab, entry, clientId) {
  const pending = pendingSubmissions.get(submitId);
  pendingSubmissions.delete(submitId);
  if (!pending || pending.expiresAt <= Date.now()) return safeError('SUBMISSION_EXPIRED', 410, entry.targetUrl);
  if (pending.routeKey !== routeKey || pending.tabId !== tab.tabId || pending.entryId !== entry.entryId) return safeError('POLICY_BLOCKED', 403, entry.targetUrl);
  tab.activeEntryId = entry.entryId;
  bindClientContext(clientId, tab, entry);
  return transportFetch(pending.targetUrl, { request: req, document: true, method: pending.method, headers: pending.headers, body: pending.body, tab, entryId: entry.entryId });
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
  return shouldRewriteScript(req, resp) ? rewriteScriptResponse(resp, { targetUrl, kind: scriptKindFromRequest(req) }) : resp;
}

function shouldRewriteCSS(req, resp) {
  if (req.destination === 'style') return true;
  const ct = resp && resp.headers && resp.headers.get('Content-Type') || '';
  return /\btext\/css\b/i.test(ct);
}
async function rewriteCSSResponse(resp, opt) {
  // Read the body once; CSS rewrite uses swc_css and rewrites url(...) /
  // @import to /zp/api/fetch?url=<absolute> so subresources route through
  // the SW the same way scripts do. On parse failure, ship the original
  // body — runtime-prelude DOM hooks still contain navigation.
  let css = '';
  try { css = await resp.text(); } catch { return resp; }
  let out = css;
  try {
    if (self.ZPRewriter && typeof self.ZPRewriter.rewriteCSS === 'function') {
      const r = self.ZPRewriter.rewriteCSS(css, { baseUrl: opt.targetUrl || '', controlPrefix: ZP.CONTROL_PREFIX });
      if (r && r.ok && typeof r.code === 'string') out = r.code;
    }
  } catch { /* fall through with original */ }
  const headers = new Headers(resp.headers);
  headers.delete('Content-Length');
  headers.set('Content-Type', 'text/css; charset=utf-8');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(out, { status: resp.status, statusText: resp.statusText, headers });
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
  // A2 hardening: privileged API endpoints must resolve a tab from an
  // explicit signal (URL ?tab=, referer-derived context, or client context).
  // No first-available-tab fallback — multi-tab requests must not piggy-back.
  if (url.pathname === '/zp/api/diag/trace') {
    // Connection-timing investigation: classify every tx:* line by host
    // and pattern. Produces five histograms — tls / socks5 / mux / http
    // for h2-reuse vs first-handshake — so we can tell whether the
    // dominant cost is TLS, SOCKS5 dial, mux open, or actual upstream
    // RTT. Per-host first-tls also separates "many cold origins" from
    // "one host but slow handshake".
    const ring = Array.isArray(self.__zpRustTrace) ? self.__zpRustTrace.slice() : [];
    if (url.searchParams.get('clear') === '1') { try { self.__zpRustTrace = []; } catch {} }
    const head = {};
    const buckets = {};
    const hostFirstTls = {};
    const hostCount = {};
    const slow = [];
    const stat = (k, v) => {
      if (!buckets[k]) buckets[k] = { n: 0, sum: 0, min: Infinity, max: 0, samples: [] };
      const b = buckets[k]; b.n++; b.sum += v;
      if (v < b.min) b.min = v;
      if (v > b.max) b.max = v;
      if (b.samples.length < 12) b.samples.push(v);
    };
    for (const line of ring) {
      const tag = (line.split(' ')[0] || '');
      head[tag] = (head[tag] || 0) + 1;
      const mHost = / host=([^\s]+)/.exec(line);
      const host = mHost ? mHost[1] : '';
      if (host && tag.startsWith('tx:')) hostCount[host] = (hostCount[host] || 0) + 1;
      const pull = (k) => { const m = new RegExp(' ' + k + '=(\\d+)').exec(line); return m ? Number(m[1]) : null; };
      const tlsV = pull('tls'); if (tlsV != null) {
        stat(tag + '.tls', tlsV);
        if (host && !(host in hostFirstTls)) hostFirstTls[host] = tlsV;
      }
      const socksV = pull('socks5'); if (socksV != null) stat(tag + '.socks5', socksV);
      const muxV = pull('mux'); if (muxV != null) stat(tag + '.mux', muxV);
      const httpV = pull('http'); if (httpV != null) {
        stat(tag + '.http', httpV);
        if (httpV >= 1000 && slow.length < 30) slow.push({ tag, host, http: httpV, line });
      }
      const totV = pull('total'); if (totV != null) stat(tag + '.total', totV);
    }
    // Phase 5.8 diag: when ?filter=<substr> is provided, return matching
    // raw trace lines (last 50). Useful for "why is github.com h2-err?"
    // kind of investigation — the aggregated buckets hide the exact line.
    const filter = url.searchParams.get('filter') || '';
    const rawMatches = filter
      ? ring.filter(l => l.includes(filter)).slice(-50)
      : [];
    // Phase 5.9 named_groups dump from rustls fork's apply_chrome_ja3_shape.
    let namedGroups = '';
    try {
      if (self.ZPBundle && typeof self.ZPBundle.kernelLastNamedGroups === 'function') {
        namedGroups = self.ZPBundle.kernelLastNamedGroups();
      }
    } catch (e) { namedGroups = 'err: ' + (e && e.message); }
    return new Response(JSON.stringify({
      totalLines: ring.length,
      head,
      buckets,
      hostFirstTls,
      hostCount,
      slow,
      rawMatches,
      namedGroups,
    }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.pathname === '/zp/api/__shadow_log') {
    // 2026-06-07 split-bundle (c.1) Step 2.1: dump the shadow-compare
    // circular buffer for the page-realm probe. Plain JSON; the buffer
    // is process-local SW state (resets on SW restart). Cleared on
    // ?clear=1.
    if (url.searchParams.get('clear') === '1') {
      shadowLog.length = 0;
    }
    return new Response(JSON.stringify(shadowLog, null, 2), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  if (url.pathname === '/zp/api/fetch') {
    // GET ?url=<absolute> — issued by the CSS rewriter for url(...) / @import
    // subresources. Routes the same way as the POST form below but takes the
    // target from the query string.
    const ctx = contextFor(req, clientId);
    if (req.method === 'GET') {
      const target = url.searchParams.get('url');
      if (!target) return safeError('MALFORMED_ROUTE', 400);
      const explicitTab = url.searchParams.get('tab') && tabs.get(url.searchParams.get('tab'));
      const tab = explicitTab || (ctx && tabs.get(ctx.tabId));
      if (!tab) return safeError('SW_NOT_READY', 503);
      // Iframe / sub-frame navigation through /zp/api/fetch: rewrite of
      // <iframe src=absolute> by zp-htmltx routes here. We need to (a) give
      // the iframe its own entry so its virtual baseURI is the iframe's
      // target (not the parent's), (b) bind the iframe's clientId so its
      // subresources resolve context, and (c) inject prelude + CSP via
      // transformDocumentResponse so the iframe is fully contained.
      const isDocumentRequest = req.mode === 'navigate'
        || req.destination === 'iframe'
        || req.destination === 'document'
        || req.destination === 'frame'
        || req.headers.get('Sec-Fetch-Dest') === 'iframe'
        || req.headers.get('Sec-Fetch-Dest') === 'document'
        || req.headers.get('Sec-Fetch-Dest') === 'frame';
      let entry;
      let entryId;
      if (isDocumentRequest) {
        let canonical = target;
        try { canonical = ZP.canonicalTargetURL(target).href; } catch {}
        entryId = randomEntryId();
        entry = { entryId, targetUrl: canonical, baseUrl: canonical, title: '', stateClone: null, scrollX: 0, scrollY: 0, createdAt: Date.now() };
        tab.entries.set(entryId, entry);
        bindClientContext(clientId, tab, entry);
      } else {
        entryId = (ctx && ctx.entryId) || (explicitTab && explicitTab.activeEntryId) || tab.activeEntryId;
        entry = tab.entries.get(entryId);
      }
      rememberResourceContext(url, target, { tabId: tab.tabId, entryId, targetUrl: target, baseUrl: target });
      // Script destination must go through the rewriter: zp-htmltx routes
      // <script src=ABS> here, and naked target JS would access native
      // `window`/`location`, bypassing the membrane. Detect via Sec-Fetch-Dest
      // / req.destination and route the response through rewriteScriptResponse
      // exactly like /zp/api/script.
      const isScriptRequest = !isDocumentRequest && (
        req.destination === 'script'
        || req.destination === 'worker'
        || req.destination === 'sharedworker'
        || req.headers.get('Sec-Fetch-Dest') === 'script'
        || req.headers.get('Sec-Fetch-Dest') === 'worker'
        || req.headers.get('Sec-Fetch-Dest') === 'sharedworker'
      );
      const accept = isDocumentRequest
        ? [['Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8']]
        : isScriptRequest
          ? [['Accept', 'text/javascript, application/javascript, */*;q=0.8']]
          : [['Accept', '*/*']];
      const resp = await transportFetch(target, { request: req, method: 'GET', headers: accept, tab, entryId, document: isDocumentRequest });
      if (isDocumentRequest && entry) return transformDocumentResponse(resp, { tab, entry });
      if (isScriptRequest) return rewriteScriptResponse(resp, { targetUrl: target, kind: scriptKindFromRequest(req) });
      return shouldRewriteCSS(req, resp) ? rewriteCSSResponse(resp, { targetUrl: target }) : resp;
    }
    if (req.method !== 'POST') return safeError('POLICY_BLOCKED', 405);
    const payload = await req.json();
    const explicitTab = payload.tabId && tabs.get(payload.tabId);
    const tab = explicitTab || (ctx && tabs.get(ctx.tabId));
    if (!tab) return safeError('SW_NOT_READY', 503);
    let body;
    if (payload.init && payload.init.body) body = ZP.base64UrlToBytes(payload.init.body);
    const entryId = (ctx && ctx.entryId) || (explicitTab && explicitTab.activeEntryId) || tab.activeEntryId;
    return transportFetch(payload.url, { method: payload.init && payload.init.method || 'GET', headers: payload.init && payload.init.headers || [], body, tab, entryId });
  }
  if (url.pathname === '/zp/api/script') {
    if (req.method !== 'GET') return safeError('POLICY_BLOCKED', 405);
    const target = url.searchParams.get('u');
    const kind = url.searchParams.get('kind') || 'classic';
    const scriptCtx = contextFor(req, clientId);
    const explicitTab = url.searchParams.get('tab') && tabs.get(url.searchParams.get('tab'));
    const tab = explicitTab || (scriptCtx && tabs.get(scriptCtx.tabId));
    if (!target || !tab) return safeError('SW_NOT_READY', 503);
    // DIAG: NAVER ships an anti-bot WASM tracker (508e018/58b3e8e539...js)
    // from two CDNs — wtm.pstatic.net and ncpt.naver.com — both of which
    // spin inside their WASM `$_start` when the proxy membrane is detected.
    // Debugger pause confirms the page wedges on this exact frame. Return
    // a noop body so the script tag resolves without executing the tracker.
    // ntm.pstatic.net (ntm_<hex>.js) was investigated as a candidate: 121s
    // load time looked similar, but blocking it actually breaks more ads
    // than it fixes (premium-area, da_public_*, veta_* lose their inventory
    // because GFP SDK uses ntm as a bid-token source). Leave ntm enabled.
    try {
      const tu = new URL(target);
      if (tu.host === 'wtm.pstatic.net' || tu.host === 'ncpt.naver.com') {
        return new Response('/* ZP_TRACKER_BLOCKED ' + tu.host + ' */',
          { status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
      }
      // DIAG: incrementally block NAVER ad / anti-bot SDKs to isolate which
      // one wedges V8 once NACT unlocks the heavy tracker bundle. The Veta
      // ad core, GFP display SDK, and NAC synchronizer all contain logic
      // that probes for membrane traces and busy-loops when proxied. NTM
      // is left enabled (prior session note: blocking it broke GFP bid
      // tokens and removed more ad inventory than it fixed).
      // (NAVER pm.pstatic.net / ssl.pstatic.net SDK bundle blocks removed
      // 2026-06-05 after the wedge root cause (`window.ZP` enumeration via
      // getOwnPropertyNames) was fixed by runtime-prelude closure-capture +
      // delete and the rewriter loop-cap rule landed. See the longer
      // explanation block below and `.ai/trap-notebook/real-site-compat.md`
      // 2026-06-05 entry.)
      // NAVER warm-session V8 wedge — historical block list. The probe
      // root cause (2026-06-05) is now understood: NAVER's anti-bot scripts
      // enumerated `Object.getOwnPropertyNames(window)` and tripped on the
      // `ZP` / `ZeroProxyRT` named properties (defineProperty with
      // `enumerable: false` still appeared in getOwnPropertyNames per spec).
      // runtime-prelude now captures both into closure-locals and deletes
      // them, and the rewriter caps any literal `for(;;)` / `while(true)`
      // / `while(1)` / `do while(true)` shape after 10 M iterations
      // (defense-in-depth even for sites whose probe slipped past the
      // fingerprint hide). With those two landed, the manual block list is
      // no longer load-bearing — Edge real-browser verification (2026-06-05)
      // showed NAVER renders the full page including the previously
      // blocked bundles. Removing the block also lets GFP / NAC / Veta
      // deliver ad inventory again ("기능적으로 완전한 가상 브라우징"
      // strict-mode aim).
      //
      // If a future NAVER probe shape resurfaces a wedge, re-introduce
      // a targeted block here AND file a trap-notebook entry naming the
      // specific signal — the right long-term fix is to add a new
      // hardening to runtime-prelude or zp-rewriter, not to grow this
      // list silently.
    } catch {}
    // request 자체를 transportFetch 에 전달 → browser-set headers (Accept,
    // sec-ch-ua-* 등) 가 upstream 으로 전달됨. 명시 headers 만 보내면 upstream
    // anti-bot 회로가 404 NAVER 페이지를 반환하는 경우가 있음 → SafeFrame
    // loader 미실행 → 광고 미렌더. virtualSubresource 경로와 동일 패턴 유지.
    const resp = await transportFetch(target, { request: req, tab, entryId: tab.activeEntryId });
    return rewriteScriptResponse(resp, { targetUrl: target, kind });
  }
  if (url.pathname === '/zp/api/worker-script') {
    const target = url.searchParams.get('u');
    const explicitTab = url.searchParams.get('tab') && tabs.get(url.searchParams.get('tab'));
    const ctx = contextFor(req, clientId);
    const tab = explicitTab || (ctx && tabs.get(ctx.tabId));
    if (!target || !tab) return safeError('SW_NOT_READY', 503);
    return rewriteScriptResponse(await transportFetch(target, { method: 'GET', headers: [['Accept', 'text/javascript,*/*']], tab, entryId: tab.activeEntryId }), { targetUrl: target, kind: 'worker' });
  }
  if (url.pathname === ZP.apiPath('sourcemap')) {
    // D2: serve the composed Source Map v3 JSON for a previously-rewritten
    // script. DevTools requests this when the operator opens the script in
    // the Sources panel; the URL is the `//# sourceMappingURL=…` we appended
    // in rewriteScriptResponse. Cache-Control: no-store so a re-rewrite
    // (transformer version bump, etc.) invalidates the cached map.
    const target = url.searchParams.get('u') || '';
    const kind = url.searchParams.get('k') || 'classic';
    if (!target) return safeError('POLICY_BLOCKED', 400);
    const ctx = contextFor(req, clientId);
    const tab = ctx && tabs.get(ctx.tabId);
    if (!tab) return safeError('SW_NOT_READY', 503);
    try {
      await initBundle();
      if (!self.ZPBundle || !self.ZPBundle.ready || typeof self.ZPBundle.composeSourceMap !== 'function') {
        return safeError('SW_NOT_READY', 503);
      }
      const upstream = await transportFetch(target, { method: 'GET', headers: [['Accept', 'text/javascript,*/*']], tab, entryId: tab.activeEntryId });
      if (!upstream || upstream.status >= 400) return safeError('TARGET_HTTP_FAILED', 502, target);
      const source = await upstream.text();
      // D2 follow-on: chain with the target site's *original* `.map`
      // when one is referenced. DevTools then walks straight to
      // pre-bundle TypeScript / pre-minify source instead of stopping
      // at the bundled .js. Best-effort — if the upstream map can't be
      // fetched or is malformed, the chained composer falls back to
      // the unchained map (never breaks DevTools).
      const originalMapJson = await fetchOriginalSourceMap(source, target, tab).catch(() => '');
      const mapJson = originalMapJson && typeof self.ZPBundle.composeSourceMapChained === 'function'
        ? self.ZPBundle.composeSourceMapChained(source, kind, target, originalMapJson)
        : self.ZPBundle.composeSourceMap(source, kind, target);
      return new Response(mapJson, {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
      });
    } catch (e) {
      return safeError('REWRITE_FAILED', 502, target);
    }
  }
  return safeError('POLICY_BLOCKED', 404);
}

// D2 follow-on: locate the target site's original sourceMappingURL
// pragma (RFC: `//# sourceMappingURL=…` or legacy `//@`), resolve it
// against the script URL, and fetch the JSON through the transport so
// the composer can chain `rewriter_map ∘ original_map`. Returns the
// raw map JSON, or `''` when no pragma / fetch failure / non-OK status
// / data URI parse failure. The composer's chained-mode treats `''`
// as "no chain, use the unchained map".
async function fetchOriginalSourceMap(source, target, tab) {
  // Last pragma wins per Source Map v3 §A.3. Tolerate `//#` and
  // legacy `//@` and arbitrary whitespace after the marker.
  const re = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)/g;
  let m, last = null;
  while ((m = re.exec(source))) last = m[1];
  if (!last) return '';
  // Inline data URI (typical for dev builds).
  if (last.startsWith('data:')) {
    try {
      const comma = last.indexOf(',');
      if (comma < 0) return '';
      const meta = last.slice(5, comma);
      const payload = last.slice(comma + 1);
      const isBase64 = /;\s*base64\b/i.test(meta);
      const decoded = isBase64 ? atob(payload) : decodeURIComponent(payload);
      // Reject obviously non-JSON to avoid passing garbage to the parser.
      if (!decoded.trimStart().startsWith('{')) return '';
      return decoded;
    } catch { return ''; }
  }
  // Resolve against the script URL.
  let absUrl;
  try { absUrl = new URL(last, target).toString(); } catch { return ''; }
  try {
    const resp = await transportFetch(absUrl, {
      method: 'GET',
      headers: [['Accept', 'application/json,*/*']],
      tab,
      entryId: tab.activeEntryId,
    });
    if (!resp || resp.status >= 400) return '';
    return await resp.text();
  } catch { return ''; }
}

async function transportFetch(targetUrl, opt) {
  let u;
  try { u = ZP.canonicalTargetURL(targetUrl).href; } catch (e) { return safeError(e.code || 'TARGET_PROTOCOL_BLOCKED', 403, targetUrl); }
  // Step 13: HTTP transport is Rust-only (crates/zp-kernel via zp-bundle).
  // Both kernelFetch and kernelStream are exposed from the same WASM bundle.
  try { await initBundle(); } catch { return safeError('SW_NOT_READY', 503, u); }
  if (typeof self.kernelFetch !== 'function') return safeError('SW_NOT_READY', 503, u);
  const headers = new Headers(opt.headers || (opt.request && opt.request.headers) || undefined);
  // Phase 5.8 note: page-side User-Agent survives this Headers init and
  // wins over the `pushOnce('user-agent', ZP.TARGET_USER_AGENT)` further
  // down (pushOnce no-ops when 'seen' already has it). That is the
  // desired behaviour — the page-side UA is the genuine browser UA
  // (e.g. `...Chrome/148 Safari/537.36 Edg/148.0.0.0` for Edge WebView2)
  // which is consistent with the sec-ch-ua brand list the browser also
  // forwards. TARGET_USER_AGENT only applies as a fallback for callers
  // that don't pass a Request (e.g. internal scheduled fetches).
  // Origin masking: browser-added Referer/Origin point at proxy.localhost
  // (the SW origin). Rewrite to the virtual target URL/origin so target
  // servers never see the proxy as the requester. The entry's targetUrl is
  // the document URL the page-level code thinks it's running on.
  //
  // Critical: page-side fetch() never includes Referer/Origin/User-Agent in
  // the Request headers — the browser marks them as forbidden header names
  // and either appends them at the network layer or refuses to send the JS
  // value. So `headers.has('Referer')` is almost always false for
  // page-initiated requests. We must SET these headers unconditionally (not
  // only rewrite-if-present) so anti-CSRF / anti-bot endpoints that check
  // them (e.g. NAVER /api/v1/collect/exlogcr, Wikipedia anti-scraping) don't
  // reject us. The relay server promotes the X-ZP-* sidechannel to real
  // headers before dispatching upstream.
  const entry = opt.tab.entries && opt.tab.entries.get(opt.entryId || opt.tab.activeEntryId);
  // For iframe document loads use the embedder's URL as Referer (mirrors
  // browser behaviour); for subresources inside an iframe use the iframe's
  // own virtual URL.
  const virtualBase = (opt.document && entry && entry.parentTargetUrl)
    ? entry.parentTargetUrl
    : entry && (entry.baseUrl || entry.targetUrl);
  if (virtualBase) {
    // Referer/Origin are forbidden headers — the Request constructor strips
    // them from `init.headers`. Smuggle them as X-ZP-Referer/X-ZP-Origin and
    // let the relay server promote them back to real Referer/Origin before
    // dispatching upstream. Without this, anti-CSRF endpoints 400.
    headers.set('X-ZP-Referer', virtualBase);
    let virtualOrigin = '';
    try { virtualOrigin = new URL(virtualBase).origin; } catch {}
    if (virtualOrigin) {
      const m = (opt.method || (opt.request && opt.request.method) || 'GET').toUpperCase();
      if (m !== 'GET' && m !== 'HEAD') headers.set('X-ZP-Origin', virtualOrigin);
    }
  }
  // User-Agent is a forbidden header for fetch() — same smuggle pattern.
  // Without a UA, sites like Wikipedia reject requests as suspicious bots.
  // Phase 5.8: User-Agent moved inline into headerEntries below so the
  // Chrome 148 order pass positions it after upgrade-insecure-requests.
  // The kernel still strips X-ZP-User-Agent if seen (legacy fallback).
  // Strip proxy.localhost from any header the page synthesised. (If they
  // remain after our rewrite, the value is genuinely the proxy origin.)
  for (const name of ['Referer', 'Origin']) {
    const v = headers.get(name);
    if (v && v.includes(ORIGIN)) headers.delete(name);
  }
  headers.set('X-ZP-Tab-Id', opt.tab.tabId);
  headers.set('X-ZP-Entry-Id', opt.entryId || opt.tab.activeEntryId || '');
  headers.set('X-ZP-Stream-Isolation-Key', opt.tab.streamIsolationKey);
  headers.set('X-ZP-Runtime-Token', opt.tab.runtimeToken || '');
  headers.set('X-ZP-Relay-Servers', JSON.stringify(opt.tab.servers || []));
  if (opt.document) headers.set('X-ZP-Document-Request', '1');
  // Per-tab armed challenge-compat: forwards the operator opt-in to the relay.
  // The relay strips this header (x-zp-* range) before forwarding upstream and
  // uses it as the FIRST of two signals. The SECOND is the response-side
  // classifier (Cf-Mitigated / challenges.cloudflare.com host / cdn-cgi/
  // challenge-platform path). Only when BOTH hold does the relay emit the
  // X-ZP-Challenge-Compat: 1 response marker; SW addCSP then strips it.
  if (opt.tab.challengeCompat) headers.set('X-ZP-Arm-Challenge-Compat', '1');
  // Cookie jar bridge: SW maintains tab.cookieJar (RFC 6265-scoped) via
  // ZP_COOKIE_SET messages from the page and Set-Cookie response headers.
  // Attach the cookies that domain/path-match the outgoing URL so each
  // subdomain sees only the cookies it's entitled to (no cross-leak of
  // login state between mail.naver.com / pay.naver.com / nid.naver.com /
  // www.naver.com). The Rust kernel passes Cookie through unchanged to
  // the relay.
  if (opt.tab.cookieJar) {
    // BUG FIX (2026-06-02): used to read `opt.url` which is undefined here —
    // transportFetch takes `targetUrl` as the first positional arg, never as
    // `opt.url`. Result: the cookie jar silently shipped zero cookies on
    // every outgoing request, including NAVER NACT/NID anti-bot tokens. Every
    // nid.naver.com / mail.naver.com / pay.naver.com nav was therefore cold
    // session → 60s anti-credential-stuffing slow lane.
    const cookieStr = opt.tab.cookieJar.cookieHeader(u);
    if (cookieStr) headers.set('Cookie', cookieStr);
  }
  // Build a flat [[k, v], ...] header list from BOTH our `headers` Headers
  // object AND the page-side `req.headers`. The Fetch-spec `new Request()`
  // we used to call strips "forbidden header names" — Sec-Fetch-*,
  // sec-ch-ua-*, User-Agent, etc. — which is exactly what NAVER / GitHub
  // WAFs check first; without them the upstream silently 60s-times-out.
  // The plain-object request shape below bypasses Request's filter while
  // still satisfying the kernel's `headerEntries` reader.
  const headerEntries = [];
  const seen = new Set();
  // Phase 5.8 header hygiene. Browser-emitted Client Hints split into:
  //
  //   * DEFAULT: always sent by Chrome on cross-origin nav to ANY origin.
  //     Includes sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform.
  //     Keep — anti-bot WAFs check presence as a "is this Chromium" signal.
  //
  //   * GRANT-OPT-IN: Chrome only sends after the origin returns
  //     `Accept-CH: <hint>` on a previous response. Includes
  //     device-memory, downlink, dpr, ect, rtt, sec-ch-ua-arch,
  //     sec-ch-ua-full-version, sec-ch-ua-full-version-list,
  //     sec-ch-ua-model, sec-ch-ua-platform-version, sec-ch-ua-bitness,
  //     sec-ch-ua-wow64, viewport-width, viewport-height, save-data,
  //     prefers-color-scheme, prefers-reduced-motion.
  //     The SW-intercepted Request inherits these from whatever the
  //     page's Origin (proxy.localhost) has accumulated via Accept-CH.
  //     Forwarding them upstream lies about the target's prior grant —
  //     real Chrome would have sent NONE on first contact. NAVER WAF
  //     flags this as bot-like (Chrome 148 cold-nav baseline has only
  //     the 3 DEFAULT hints).
  //
  //   * INFERRED: viewport-width, viewport-height, device-pixel-ratio
  //     — same rule as grant-opt-in.
  //
  // DROP everything in GRANT-OPT-IN / INFERRED unconditionally; the
  // 60s slow-lane originating from over-sending hints disappears.
  const DROP_CLIENT_HINTS = new Set([
    'device-memory', 'downlink', 'dpr', 'ect', 'rtt',
    'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-full-version',
    'sec-ch-ua-full-version-list', 'sec-ch-ua-model',
    'sec-ch-ua-platform-version', 'sec-ch-ua-wow64',
    'viewport-width', 'viewport-height', 'device-pixel-ratio',
    'save-data', 'prefers-color-scheme', 'prefers-reduced-motion',
  ]);
  const pushOnce = (k, v) => {
    const kl = k.toLowerCase();
    if (seen.has(kl)) return;
    if (DROP_CLIENT_HINTS.has(kl)) return;
    seen.add(kl);
    headerEntries.push([k, v]);
  };
  for (const [k, v] of headers.entries()) pushOnce(k, v);
  // Now grab anything the browser added that Headers refused to copy
  // (Sec-Fetch-Mode/Dest/Site/User, sec-ch-ua-* family, Accept-Language,
  // upgrade-insecure-requests). `request.headers.entries()` from the
  // SW-intercepted request DOES include these in Chromium.
  if (opt.request && opt.request.headers) {
    for (const [k, v] of opt.request.headers.entries()) {
      const kl = k.toLowerCase();
      // Skip ones we explicitly own (Referer/UA/Cookie were promoted via
      // X-ZP-* and would be lost here anyway). Accept-Encoding is forced
      // to identity below.
      if (kl === 'cookie' || kl === 'host' || kl === 'origin' || kl === 'referer'
          || kl === 'user-agent' || kl === 'accept-encoding'
          || kl === 'connection' || kl === 'content-length' || kl === 'transfer-encoding') {
        continue;
      }
      pushOnce(k, v);
    }
  }
  // Synthesize Sec-Fetch-* / Accept-Language if the browser didn't
  // include them. WebView2 in some configurations omits them on the
  // SW-intercepted navigation; nid.naver.com / GitHub WAFs both treat
  // a missing Sec-Fetch-Mode as bot traffic and silently drop the
  // request (60s TCP timeout from upstream's perspective). We pick the
  // values a real browser would have sent for a top-level navigation
  // to a cross-site origin.
  if (!seen.has('sec-fetch-mode')) pushOnce('sec-fetch-mode', opt.document ? 'navigate' : 'cors');
  if (!seen.has('sec-fetch-dest')) pushOnce('sec-fetch-dest', opt.document ? 'document' : 'empty');
  if (!seen.has('sec-fetch-site')) pushOnce('sec-fetch-site', 'cross-site');
  if (opt.document && !seen.has('sec-fetch-user')) pushOnce('sec-fetch-user', '?1');
  if (!seen.has('accept-language')) pushOnce('accept-language', 'en-US,en;q=0.9,ko;q=0.8');
  // Phase 5.8: emit User-Agent inline so the HEADER_ORDER sort positions
  // it correctly (real Chrome 148 sends user-agent right after
  // upgrade-insecure-requests). Previously promoted via X-ZP-User-Agent
  // in the kernel which appended at end — visible h2 fingerprint diff vs
  // Chrome at peet.ws (user-agent at index 11 instead of 4).
  pushOnce('user-agent', ZP.TARGET_USER_AGENT);
  // Phase 5.8 force Chrome 148 header order. Real Chrome emits headers
  // in this deterministic order on the wire (HEADERS frame after the
  // four pseudo-headers `m,a,s,p` which the h2 fork already pins).
  // Without this pass, headerEntries' order is "Headers.entries() = sorted
  // lowercase, then request.headers.entries() = sorted lowercase" = pure
  // alphabetical, which is a 100% Go/Rust HTTP client tell.
  //
  // Bot signal (tls.peet.ws akamai_fingerprint hash includes header order):
  //   real Chrome 148: sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform,
  //   upgrade-insecure-requests, user-agent, accept, sec-fetch-site,
  //   sec-fetch-mode, sec-fetch-user, sec-fetch-dest, accept-encoding,
  //   accept-language, priority, [cookie last, auto-added by browser]
  //
  // We slot ZP-internal headers (X-ZP-*, Cookie) at the end after the
  // real-browser tail so the prefix matches Chrome verbatim.
  const HEADER_ORDER = [
    'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
    'upgrade-insecure-requests', 'user-agent', 'accept',
    'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-user', 'sec-fetch-dest',
    'referer', 'accept-encoding', 'accept-language', 'priority',
    'cookie',
  ];
  const orderIndex = (k) => {
    const i = HEADER_ORDER.indexOf(k.toLowerCase());
    return i < 0 ? HEADER_ORDER.length : i;
  };
  headerEntries.sort((a, b) => {
    const ai = orderIndex(a[0]);
    const bi = orderIndex(b[0]);
    if (ai !== bi) return ai - bi;
    // Stable for entries beyond the known order (X-ZP-* sidechannel etc).
    return 0;
  });
  const method = opt.method || (opt.request && opt.request.method) || 'GET';
  let bodyU8 = null;
  if (method !== 'GET' && method !== 'HEAD') {
    const body = opt.body || (opt.request && await opt.request.clone().arrayBuffer());
    const n = body && (body.byteLength || body.size || 0) || 0;
    if (n > MAX_REQUEST_BODY_BYTES) return safeError('REQUEST_BODY_TOO_LARGE', 413, u);
    bodyU8 = body ? new Uint8Array(body instanceof ArrayBuffer ? body : await body.arrayBuffer()) : null;
  }
  // Plain object — no Request constructor, so forbidden headers survive.
  // The kernel reads `headerEntries` first (preferred) and `arrayBuffer`
  // for the body (still a function so the kernel's existing extractor
  // doesn't change shape).
  const reqLike = {
    url: u,
    method,
    headerEntries,
    arrayBuffer: () => Promise.resolve(bodyU8 ? bodyU8.buffer : new ArrayBuffer(0)),
  };
  let resp;
  try {
    resp = await self.kernelFetch(reqLike);
  } catch (e) {
    return safeError(e && (e.message || e.code) || 'TARGET_CONNECT_FAILED', 502, u);
  }
  // Capture Set-Cookie from the response and feed into the RFC-6265
  // jar scoped to the response URL so Domain/Path/Secure/HttpOnly
  // attributes are honored on the next outgoing request.
  try {
    const getSetCookie = resp && resp.headers && resp.headers.getSetCookie;
    const setCookies = typeof getSetCookie === 'function' ? resp.headers.getSetCookie() : (resp && resp.headers && resp.headers.get('set-cookie') ? [resp.headers.get('set-cookie')] : []);
    if (opt.tab.cookieJar) {
      // Same fix as the outgoing read above — `opt.url` was undefined, so
      // every Set-Cookie header from upstream silently dropped on the floor.
      // Now scopes the cookie to `u` (the canonical target URL we actually
      // fetched), which is the response URL for jar bookkeeping. Redirects
      // are followed server-side and the final URL would technically be
      // more accurate for Domain/Path defaults, but the kernel doesn't
      // surface it here yet; the request URL is close enough for now.
      for (const line of setCookies) opt.tab.cookieJar.setCookieLine(u, line);
      // Upstream Set-Cookie is also stripped by the Go server's
      // ConstructorPolicy (otherwise target-site auth cookies would be
      // readable by any proxy-origin page) and re-emitted into the
      // X-ZP-Set-Cookie sidechannel. Without consuming the sidechannel,
      // the jar would only see cookies that page-side JS set via
      // `document.cookie = ...` and would miss every server-issued
      // anti-bot token (NACT, etc.). The sidechannel values are joined
      // by a tab character — match the server-side encoder.
      const sidechannel = resp.headers.get('X-ZP-Set-Cookie');
      if (sidechannel) {
        for (const line of sidechannel.split('\t')) {
          if (line) opt.tab.cookieJar.setCookieLine(u, line);
        }
      }
    }
  } catch {}
  return addCSP(resp, opt.request, opt.tab && opt.tab.servers, opt.tab);
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
// 2026-06-07 split-bundle (c.1) Step 2.1: shadow-compare circular buffer and
// recorder. `rewriteScriptResponse` runs the modern ZPBundle pipeline in a
// deferred microtask after the legacy ZPRewriter produced the served response,
// then any divergence (output length / first differing byte / modern-only
// throw) is appended here. Capped circular buffer; readable from page realm
// via the `/zp/api/__shadow_log` debug endpoint. NO behavior change to the
// served response — legacy output stays the source of truth in Step 2.1.
const SHADOW_LOG_CAP = 100;
const shadowLog = [];
function recordShadowDivergence(entry) {
  if (shadowLog.length >= SHADOW_LOG_CAP) shadowLog.shift();
  shadowLog.push(entry);
}
function shadowCompareRewriters(source, opt, legacyCode) {
  if (typeof legacyCode !== 'string' || !legacyCode) return;
  if (!self.ZPBundle || !self.ZPBundle.ready) return;
  const kind = opt.kind || 'classic';
  const target = opt.targetUrl || '';
  let modernCode = null;
  let modernThrew = null;
  let path = '';
  try {
    if (typeof self.ZPBundle.rewriteScriptPatches === 'function') {
      path = 'patches';
      const envelope = self.ZPBundle.rewriteScriptPatches(source, kind, target);
      modernCode = applyScriptPatches(source, envelope);
    } else {
      path = 'full';
      modernCode = self.ZPBundle.rewriteScript(source, kind, target);
    }
  } catch (e) {
    modernThrew = String(e && e.message || e);
  }
  if (modernThrew) {
    recordShadowDivergence({
      ts: Date.now(), kind, target, path,
      sourceLen: source.length,
      legacyLen: legacyCode.length,
      modernThrew,
      legacyHead: legacyCode.slice(0, 200),
      sourceHead: source.slice(0, 200),
    });
    return;
  }
  if (typeof modernCode !== 'string' || modernCode === legacyCode) return;
  const n = Math.min(legacyCode.length, modernCode.length);
  let firstDiffIdx = -1;
  for (let i = 0; i < n; i++) {
    if (legacyCode.charCodeAt(i) !== modernCode.charCodeAt(i)) { firstDiffIdx = i; break; }
  }
  if (firstDiffIdx < 0) firstDiffIdx = n;
  const around = (s, i) => s.slice(Math.max(0, i - 20), i + 40);
  recordShadowDivergence({
    ts: Date.now(), kind, target, path,
    sourceLen: source.length,
    legacyLen: legacyCode.length,
    modernLen: modernCode.length,
    firstDiffIdx,
    legacyAroundDiff: around(legacyCode, firstDiffIdx),
    modernAroundDiff: around(modernCode, firstDiffIdx),
  });
}

// Apply a patch envelope produced by `ZPBundle.rewriteScriptPatches` over the
// original source. Patches are non-overlapping byte ranges (sorted by start
// inside the Rust crate) — we walk them in order, splicing replacements
// between untouched spans. Returns the rewritten source, or null when the
// envelope is malformed (caller falls back to full re-emit).
function applyScriptPatches(source, envelopeJson) {
  if (typeof envelopeJson !== 'string' || envelopeJson.length === 0) return null;
  let env;
  try { env = JSON.parse(envelopeJson); } catch { return null; }
  if (!env || !Array.isArray(env.patches)) return null;
  const patches = env.patches;
  // No patches → original source is already strict-safe (no dangerous
  // identifiers / member accesses). Cheaper than re-encoding via OXC.
  if (patches.length === 0) return source;
  const out = [];
  let cursor = 0;
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    const start = p && p.start | 0;
    const end = p && p.end | 0;
    if (start < cursor || end < start || end > source.length) return null;
    if (start > cursor) out.push(source.slice(cursor, start));
    out.push(typeof p.replacement === 'string' ? p.replacement : '');
    cursor = end;
  }
  if (cursor < source.length) out.push(source.slice(cursor));
  return out.join('');
}

async function rewriteScriptResponse(resp, opt) {
  const h = scriptResponseHeaders(resp);
  let code = '';
  let cacheKey = '';
  try {
    await initRewriter();
    const source = await resp.text();
    // C4: cache check before invoking the OXC pipeline. Hash inputs that
    // affect output: transformer version, script kind, target URL, source bytes.
    try {
      cacheKey = await rewriteCacheKey(opt.kind || 'classic', opt.targetUrl || '', source);
      const cached = rewriteCacheGet(cacheKey);
      if (cached !== null) {
        return new Response(cached, { status: resp.status, statusText: resp.statusText, headers: h });
      }
    } catch { cacheKey = ''; }
    let out = null;
    try {
      out = self.ZPRewriter && self.ZPRewriter.rewriteScript(source, { kind: opt.kind || 'classic', targetUrl: opt.targetUrl, strict: true, controlPrefix: ZP.CONTROL_PREFIX });
    } catch (jsErr) {
      // JS rewriter threw — try Rust bundle fallback before fail-closing.
      out = null;
    }
    if (!out || !out.ok) {
      // Fallback to Rust ZPBundle if initialized. The Rust rewriter covers a
      // subset of rules (identifier, member, call, assignment); if it succeeds
      // its output is just as safe as the JS one — fail-closed posture intact.
      try {
        await initBundle();
        if (self.ZPBundle && self.ZPBundle.ready) {
          // Prefer patch-mode emit: the Rust crate returns the patch list
          // as a JSON envelope (~kB) instead of the full rewritten source
          // (~MB on large scripts). Applying patches in JS over the buffer
          // we already hold avoids both the OXC re-emit cost and the
          // wasm-bindgen string-copy crossing.
          const kind = opt.kind || 'classic';
          const target = opt.targetUrl || '';
          if (typeof self.ZPBundle.rewriteScriptPatches === 'function') {
            try {
              const envelope = self.ZPBundle.rewriteScriptPatches(source, kind, target);
              const patched = applyScriptPatches(source, envelope);
              if (typeof patched === 'string' && patched.length > 0) {
                code = patched;
              }
            } catch { /* fall through to full re-emit */ }
          }
          if (!code) {
            const rustCode = self.ZPBundle.rewriteScript(source, kind, target);
            if (typeof rustCode === 'string' && rustCode.length > 0) {
              code = rustCode;
            }
          }
        }
      } catch (rustErr) { /* swallow; fall through to block */ }
    } else {
      code = out.code;
      // 2026-06-07 split-bundle (c.1) Step 2.1: shadow-compare. Fire the
      // modern ZPBundle pipeline in a deferred microtask so the legacy
      // response (`code`) ships without the modern's CPU cost on the hot
      // path. Divergence appended to `shadowLog`; readable via
      // /zp/api/__shadow_log.
      // CRITICAL: capture the legacy output value NOW, not via the `code`
      // let-binding. The pragma-append + cache-set code below mutates
      // `code`, so passing `code` into the microtask closure would
      // compare against a corrupted post-pragma legacy form.
      const legacyForShadow = code;
      if (legacyForShadow) {
        Promise.resolve().then(() => shadowCompareRewriters(source, opt, legacyForShadow));
      }
    }
    if (!code) {
      // 2026-06-07 split-bundle (c.1) Step 1: blockSource was a Rust-side
      // accessor for a static string. Inline the literal so we can drop
      // the wrapper from the rewriter-rs JS glue in the next milestones.
      code = "throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');";
    } else {
      // D2: append a fresh sourceMappingURL pointing to the proxy-side
      // composer. The Rust rewriter already stripped the original pragma
      // (which described the un-rewritten source) so this is the only
      // map DevTools will see. We DON'T inline a data: URL because
      // (a) every page-load would pay the compose cost regardless of
      // whether DevTools is open, and (b) the JSON is large enough that
      // injecting it would bloat the rewritten body significantly.
      // Only emit for `classic` / `module` kinds — `event-handler`,
      // `eval`, `function` are synthesised wrappers without a fetchable
      // origin URL, so a sourceMappingURL there would 404.
      const kind = opt.kind || 'classic';
      const target = opt.targetUrl || '';
      if (target && (kind === 'classic' || kind === 'module' || kind === 'worker')) {
        const mapURL = ZP.apiPath('sourcemap') + '?u=' + encodeURIComponent(target) + '&k=' + encodeURIComponent(kind);
        code = code + '\n//# sourceMappingURL=' + mapURL + '\n';
      }
      if (cacheKey) {
        // Cache only successful rewrites — never the fail-closed block stub,
        // so a transient parser bug never gets pinned in the cache.
        rewriteCacheSet(cacheKey, code);
      }
    }
  } catch {
    code = "throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');";
  }
  return new Response(code, { status: resp.status, statusText: resp.statusText, headers: h });
}
async function transformDocumentResponse(resp, opt) {
  // Only transform HTML payloads. Anything else (302 redirect, JSON, binary)
  // passes through unchanged — addCSP/streaming preserved.
  if (!resp || resp.status >= 300 || !isHTMLResponse(resp)) return resp;
  let html = '';
  try { html = await resp.text(); } catch { return resp; }
  let transformed = html;
  // C2: malformed-HTML policy is FAIL-CLOSED → MALFORMED_HTML error page.
  // The prior implementation fell open (ship raw HTML on lol_html error),
  // which meant target inline scripts could execute UN-rewritten and the
  // membrane / OXC pipeline would all be bypassed — the literal opposite
  // of strict mode. Track success explicitly so we route to A5 instead of
  // leaking the raw body.
  let transformOk = false;
  let transformFailure = '';
  try {
    await initBundle();
    if (self.ZPBundle && self.ZPBundle.ready && typeof self.ZPBundle.transformHtml === 'function') {
      // HTML rewrite base stays at the originally requested URL — using the
      // post-redirect URL re-exposes a separate NAVER-login script-completion
      // hang (see .ai/trap-notebook/INDEX.md 2026-05-31 diagnostic entry).
      // We post-process stylesheet links below to fix the redirect-host
      // mismatch without making scripts initialise on the "real" host.
      const targetUrl = (opt.entry && (opt.entry.targetUrl || opt.entry.baseUrl)) || '';
      // C2: separate "transform threw" (malformed HTML) from "transform
      // returned empty". Both route to fail-closed because the alternative
      // is shipping the un-rewritten body, which is a strict-mode escape.
      const out = self.ZPBundle.transformHtml(html, targetUrl);
      if (typeof out === 'string' && out.length > 0) {
        transformed = out;
        transformOk = true;
      } else {
        transformFailure = 'empty transform output';
      }
      // Post-process stylesheet URLs only — repoint /foo.css that 404s at
      // the originally requested host (pay.naver.com) to the post-redirect
      // host (nid.naver.com). Scripts intentionally stay broken on the
      // original host so the login JS bails early and the page renders.
      const finalUrl = (resp.headers && resp.headers.get('X-ZP-Final-URL')) || '';
      if (finalUrl) {
        try {
          const origin = (opt.entry && (opt.entry.targetUrl || opt.entry.baseUrl)) || '';
          const oUrl = new URL(origin);
          const fUrl = new URL(finalUrl);
          if (oUrl.host !== fUrl.host) {
            // zp-htmltx percent-encodes more aggressively than encodeURIComponent
            // (dots/underscores too). Match the exact encoded host substring.
            const aggrEnc = s => encodeURIComponent(s).replace(/[.~!*'()_-]/g,
              c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
            const encOrigHost = aggrEnc(oUrl.host);
            const encFinalHost = aggrEnc(fUrl.host);
            transformed = transformed.replace(
              /<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi,
              tag => tag.split(encOrigHost).join(encFinalHost)
            );
          }
        } catch {}
      }
    }
  } catch (e) {
    transformFailure = (e && (e.message || e.code)) || 'transform threw';
  }
  // C2 fail-closed: if the HTML transform pipeline produced no usable
  // output, route to the A5 MALFORMED_HTML page instead of shipping the
  // raw body. The prior fail-open behaviour bypassed every membrane
  // invariant for any input lol_html refused to parse — the strict-mode
  // escape vector the "탈출 없는 감옥" design forbids.
  if (!transformOk) {
    const targetUrl = (opt.entry && (opt.entry.targetUrl || opt.entry.baseUrl)) || '';
    void transformFailure; // reserved for diagnostics surfacing
    return safeError('MALFORMED_HTML', 502, targetUrl);
  }
  // Prelude virtualURL stays at the originally requested URL — using the
  // post-redirect URL here triggers the NAVER-login script-completion hang
  // (see .ai/trap-notebook/INDEX.md 2026-05-31 diagnostic entry). HTML rewrite
  // already absolutized root-relative URLs against the final URL above, so
  // static resources resolve correctly without virtualURL surgery.
  const preludeHTML = buildRuntimePrelude(opt.tab, opt.entry);
  const injected = injectPrelude(transformed, preludeHTML);
  const headers = new Headers(resp.headers);
  headers.delete('Content-Length');
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(injected, { status: resp.status, statusText: resp.statusText, headers });
}
function isHTMLResponse(resp) {
  const ct = resp.headers && resp.headers.get('Content-Type') || '';
  return /\btext\/html\b/i.test(ct) || /\bapplication\/xhtml\+xml\b/i.test(ct);
}
function buildRuntimePrelude(tab, entry) {
  // documentCookie is what the page's JS will see for `document.cookie`
  // on this navigation — only non-HttpOnly cookies that match the target
  // URL's domain/path/secure. The page maintains its own jar but seeds
  // it from this string on boot.
  const documentCookie = tab.cookieJar ? tab.cookieJar.documentCookieFor(entry.targetUrl) : '';
  const boot = {
    tabId: tab.tabId,
    entryId: entry.entryId,
    targetUrl: entry.targetUrl,
    documentCookie,
    runtimeToken: tab.runtimeToken || '',
    servers: tab.servers || [],
  };
  const bootJSON = JSON.stringify(boot).replace(/</g, '\\u003c');
  // The chain consumer must run before the target's anti-bot JS does (it
  // scrubs proxy-origin localStorage on naver.com, so that key family is
  // useless for hop hand-off). State now travels in the URL fragment —
  // immune to localStorage scrubs, survives reloads, no SW round trip
  // required. The inline script pops the front of `zp_chain`, rewrites
  // the current fragment to drop the consumed entry, and after the
  // per-hop wait re-encodes the remaining chain into the next URL's
  // fragment before calling location.assign on it.
  const prewarmInline = '(function(){try{var p=new URLSearchParams(location.hash.slice(1));var c=p.get("zp_chain");if(!c)return;var chain;try{chain=JSON.parse(atob(decodeURIComponent(c)));}catch(e){return;}if(!Array.isArray(chain)||!chain.length)return;var next=chain.shift();var wait=Math.max(0,Math.min(120000,Number(next.waitMs)||0));var u=new URL(next.path,location.origin);var np=new URLSearchParams(u.hash.startsWith("#")?u.hash.slice(1):u.hash);if(chain.length){np.set("zp_chain",encodeURIComponent(btoa(JSON.stringify(chain))));}else{np.delete("zp_chain");}u.hash="#"+np.toString();var assign=location.assign.bind(location);p.delete("zp_chain");try{history.replaceState(null,"","#"+p.toString());}catch(e){}setTimeout(function(){try{assign(u.toString());}catch(e){}},wait);}catch(e){}})();';
  return '<script nonce=zp>' + prewarmInline + '</script>' +
    '<script nonce=zp src=' + ZP.assetPath('zp-core.js') + '></script>' +
    '<script nonce=zp src=' + ZP.assetPath('rust-rewriter.js') + '></script>' +
    '<script nonce=zp id=__zp-boot type=application/json>' + bootJSON + '</script>' +
    '<script nonce=zp src=' + ZP.assetPath('runtime-prelude.js') + '></script>';
}
function injectPrelude(html, prelude) {
  // Inject before the first <script>, falling back to <head>/document start.
  // The prelude must run before any target script that touches location,
  // network, or storage APIs — earlier is better.
  const headMatch = /<head[^>]*>/i.exec(html);
  if (headMatch) {
    const i = headMatch.index + headMatch[0].length;
    return html.slice(0, i) + prelude + html.slice(i);
  }
  const htmlMatch = /<html[^>]*>/i.exec(html);
  if (htmlMatch) {
    const i = htmlMatch.index + htmlMatch[0].length;
    return html.slice(0, i) + '<head>' + prelude + '</head>' + html.slice(i);
  }
  return prelude + html;
}

function scriptResponseHeaders(resp) {
  const h = new Headers(resp.headers);
  h.set('Content-Type', 'text/javascript; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Content-Security-Policy', ZP.fixedCSP());
  applyCORS(h, null);
  return h;
}


async function handleMessage(event) {
  const msg = event.data || {};
  const reply = event.ports && event.ports[0];
  if (msg && msg.type === '__zpKernelEchoTest') {
    try { await initBundle(); } catch {}
    let result;
    try {
      const echoFn = (self.ZPBundle && self.ZPBundle.kernelEchoSync) || (self.ZPBundleWBG && self.ZPBundleWBG.kernelEchoSync);
      const echoed = echoFn ? echoFn(msg.val) : null;
      result = { ok: true, echoedType: typeof echoed, echoed, kernelType: typeof self.kernelFetch };
    } catch (e) {
      result = { ok: false, error: (e && e.message) || String(e) };
    }
    if (reply) reply.postMessage(result);
    return;
  }
  if (msg && msg.type === '__zpKernelProbe') {
    let initErr = null;
    try { await initBundle(); } catch (e) { initErr = (e && e.message) || String(e); }
    if (reply) reply.postMessage({ probe: {
      kernelFetch: typeof self.kernelFetch,
      kernelStream: typeof self.kernelStream,
      bundleReady: !!(self.ZPBundle && self.ZPBundle.ready),
      hasZPBundleWBG: typeof self.ZPBundleWBG,
      bundleVersion: self.ZPBundle && self.ZPBundle.bundleVersion ? self.ZPBundle.bundleVersion() : null,
      rustTrace: (self.__zpRustTrace || []).slice(-400),
      initErr,
    }});
    return;
  }
  const ok = data => reply && reply.postMessage(Object.assign({ ok: true }, data || {}));
  const fail = code => reply && reply.postMessage({ ok: false, error: code });
  try {
    if (msg.type === 'ZP_OPEN_SHARE') {
      const routeKey = String(msg.routeKey || '');
      if (!routeKey || /[^A-Za-z0-9_-]/.test(routeKey)) { fail('MALFORMED_ROUTE'); return; }
      // Launcher pre-nav: if `reuseTabId` names an existing tab, append a
      // new entry to it instead of allocating a fresh tab. Keeps the
      // cookieJar (NACT/NID/etc.) populated by the warm-up navigation
      // available to the follow-up nav to a deep subdomain. The follow-up
      // nav is a separate ZP_OPEN_SHARE call from the launcher, fired
      // before the actual page navigation happens.
      let tab = null;
      if (msg.reuseTabId) {
        tab = tabs.get(String(msg.reuseTabId)) || null;
      }
      if (tab) {
        const entryId = randomEntryId();
        const targetUrl = ZP.canonicalTargetURL(msg.targetUrl).href;
        tab.entries.set(entryId, { entryId, targetUrl, baseUrl: targetUrl, title: '', stateClone: null, scrollX: 0, scrollY: 0, createdAt: Date.now() });
        shareRoutes.set(routeKey, { tabId: tab.tabId, entryId });
        ok({ path: ZP.makeSharePath(routeKey), servers: tab.servers, tabId: tab.tabId, reused: true });
        return;
      }
      tab = createTab(msg.targetUrl, msg.servers, msg.challengeCompat);
      shareRoutes.set(routeKey, { tabId: tab.tabId, entryId: tab.activeEntryId });
      ok({ path: ZP.makeSharePath(routeKey), servers: tab.servers, tabId: tab.tabId, reused: false });
      return;
    }
    if (msg.type === 'ZP_FRAME_ROUTE') {
      const tab = runtimeTabForMessage(event, msg, fail);
      if (!tab) return;
      const routeKey = String(msg.routeKey || '');
      if (!routeKey || /[^A-Za-z0-9_-]/.test(routeKey)) { fail('MALFORMED_ROUTE'); return; }
      const targetUrl = ZP.canonicalTargetURL(msg.targetUrl).href;
      const baseUrl = msg.baseUrl ? ZP.canonicalTargetURL(msg.baseUrl, targetUrl).href : targetUrl;
      // parentTargetUrl is the embedder page's virtual URL — used as Referer
      // for the iframe document fetch so origin-aware endpoints see the
      // embedder host (otherwise they receive Referer = iframe's own host and
      // 404 / 403 — observed on NAVER shopsquare.naver.com).
      let parentTargetUrl = '';
      try { if (msg.parentTargetUrl) parentTargetUrl = ZP.canonicalTargetURL(msg.parentTargetUrl).href; } catch {}
      const entryId = String(msg.entryId || randomEntryId());
      tab.entries.set(entryId, { entryId, targetUrl, baseUrl, parentTargetUrl, title: '', stateClone: null, scrollX: 0, scrollY: 0, createdAt: Date.now() });
      shareRoutes.set(routeKey, { tabId: tab.tabId, entryId });
      ok({ path: ZP.makeSharePath(routeKey) });
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
      // Page sends ZP_COOKIE_SET with the virtualURL it observed, so the
      // jar can scope the cookie by Domain/Path against the right host
      // (default Domain = the target host, not the SW origin).
      if (tab.cookieJar && msg.targetUrl && msg.cookie) {
        tab.cookieJar.setCookieLine(String(msg.targetUrl), String(msg.cookie));
      }
      ok();
      return;
    }
    if (msg.type === 'ZP_SUBMIT_PREPARE') {
      const tab = runtimeTabForMessage(event, msg, fail);
      if (!tab) return;
      cleanupPendingSubmissions();
      const routeKey = String(msg.routeKey || '');
      if (!routeKey || /[^A-Za-z0-9_-]/.test(routeKey)) { fail('MALFORMED_ROUTE'); return; }
      const targetUrl = ZP.canonicalTargetURL(msg.targetUrl).href;
      const body = msg.body ? ZP.base64UrlToBytes(String(msg.body)) : new Uint8Array();
      if (body.byteLength > MAX_REQUEST_BODY_BYTES) { fail('REQUEST_BODY_TOO_LARGE'); return; }
      const method = String(msg.method || 'POST').toUpperCase();
      if (method === 'GET' || method === 'HEAD') { fail('POLICY_BLOCKED'); return; }
      const entryId = String(msg.entryId || randomEntryId());
      const entry = { entryId, targetUrl, baseUrl: targetUrl, title: '', stateClone: null, scrollX: 0, scrollY: 0, createdAt: Date.now() };
      tab.entries.set(entryId, entry);
      tab.activeEntryId = entryId;
      shareRoutes.set(routeKey, { tabId: tab.tabId, entryId });
      const submitId = ZP.randomId('sub');
      pendingSubmissions.set(submitId, { submitId, routeKey, tabId: tab.tabId, entryId, targetUrl, method, headers: Array.isArray(msg.headers) ? msg.headers : [], body, expiresAt: Date.now() + SUBMISSION_TTL_MS });
      ok({ submitId });
      return;
    }
    if (msg.type === 'ZP_WS_OPEN') { await openRuntimeStream(event, msg, ok, fail); return; }
    fail('POLICY_BLOCKED');
  } catch (e) { fail(e && e.code || e && e.message || 'POLICY_BLOCKED'); }
}

async function openRuntimeStream(event, msg, ok, fail) {
  const tab = runtimeTabForMessage(event, msg, fail);
  if (!tab) return;
  // Step 13: Rust kernelStream (crates/zp-kernel via zp-bundle) only.
  try { await initBundle(); } catch { fail('SW_NOT_READY'); return; }
  if (typeof self.kernelStream !== 'function') { fail('SW_NOT_READY'); return; }
  // C1: defense-in-depth — runtime prelude validates sub-protocol tokens
  // before sending ZP_WS_OPEN, but a compromised page realm could bypass
  // that. Re-validate so a malformed protocol header never reaches the
  // upstream handshake (RFC 6455 §4.1).
  const requestedProtocols = Array.isArray(msg.protocols) ? msg.protocols.slice() : [];
  for (const p of requestedProtocols) {
    if (typeof p !== 'string' || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(p)) {
      fail('POLICY_BLOCKED');
      return;
    }
  }
  let stream;
  try {
    stream = await self.kernelStream({ url: msg.url, protocols: requestedProtocols, tabId: tab.tabId, streamIsolationKey: tab.streamIsolationKey, servers: tab.servers || [] });
  } catch (e) {
    fail(e && (e.message || e.code) || 'TARGET_CONNECT_FAILED');
    return;
  }
  // C1: server-selected sub-protocol must come from the offered list
  // (RFC 6455 §4.2.2). Never propagate a non-offered protocol back to
  // the page — matches native browser fail-the-connection.
  const negotiated = String((stream && stream.protocol) || '');
  if (negotiated && requestedProtocols.length > 0 && requestedProtocols.indexOf(negotiated) < 0) {
    try { stream.close(); } catch {}
    fail('WS_BLOCKED');
    return;
  }
  const channel = new MessageChannel();
  const id = ZP.randomId('s');
  streams.set(id, stream);
  // C1: forward page-supplied close code/reason so the WS close frame on
  // the wire carries the caller's choice (RFC 6455 §7.1.4 / §5.5.1).
  // streams.delete(id) is deferred until the Rust client surfaces the
  // server's close echo, so the close handler below can still drain a
  // race where the server's close arrives before our send completes.
  channel.port1.onmessage = ev => { const m = ev.data || {}; if (m.type === 'send') stream.send(m.data); if (m.type === 'close') { try { stream.close(m.code, m.reason); } catch {} } };
  // C1: propagate upstream close code/reason if the kernel surfaces them
  // (today the transport is a stub so the page sees default 1000/'').
  stream.setHandlers({ message: data => channel.port1.postMessage({ type: 'message', data }), close: (code, reason) => { channel.port1.postMessage({ type: 'close', code: code || 1000, reason: reason || '' }); streams.delete(id); }, error: () => channel.port1.postMessage({ type: 'error' }) });
  event.ports[0].postMessage({ ok: true, id, protocol: negotiated, port: channel.port2 }, [channel.port2]);
}

function runtimeTabForMessage(event, msg, fail) {
  const tab = tabs.get(String(msg.tabId || ''));
  if (!tab) { fail('SW_NOT_READY'); return null; }
  return runtimeMessageAuthorized(event, tab, msg, fail) ? tab : null;
}
function runtimeMessageAuthorized(event, tab, msg, fail) {
  // A2 hardening: every privileged ZP_* message must (a) carry the per-tab
  // runtime capability token AND (b) originate from a known Service Worker
  // client. event.source missing means we cannot attribute the message —
  // reject rather than guess.
  if (!tab.runtimeToken || msg.runtimeToken !== tab.runtimeToken) { fail('POLICY_BLOCKED'); return false; }
  const source = event.source;
  if (!source || !source.id) { fail('POLICY_BLOCKED'); return false; }
  const ctx = clientContext.get(source.id);
  // If client context exists it must match. If it doesn't exist yet (e.g.
  // first message from a freshly opened document before BASE_UPDATE), the
  // token is sufficient proof of capability and we accept.
  if (ctx && ctx.tabId !== tab.tabId) { fail('POLICY_BLOCKED'); return false; }
  return true;
}

function createTab(targetUrl, servers, challengeCompat) {
  const target = ZP.canonicalTargetURL(targetUrl).href;
  const tabId = ZP.randomId('t');
  const entryId = randomEntryId();
  const relayServers = ZP.relayServersForShare(servers || [], { allowLoopbackWS: true });
  // Cookie jar is shared across all tabs viewing the same target origin so
  // anti-bot warm-up cookies (NACT/NID/etc.) issued in one tab immediately
  // benefit every other tab targeting the same site. The IDB layer above
  // ensures the cookies also persist across SW restarts — the NAVER 60s
  // anti-credential-stuffing lock is paid ONCE per first-cold-visit per
  // browser profile rather than on every tab open.
  // challengeCompat is the per-tab operator opt-in (B-series arm sender).
  // Persisted on the tab so every response routed through this tab can take
  // the armed CSP projection without re-reading the message stream. The
  // header/URL classifier (Go side) is the second of two signals; this flag
  // alone grants no egress, no eval, no cache skip.
  const targetOrigin = originKeyForURL(target);
  const tab = { tabId, activeEntryId: entryId, entries: new Map(), originMap: new Map(), cookieJar: getOrCreateJarForOrigin(targetOrigin), cookieJarOrigin: targetOrigin, storageNamespaces: new Map(), runtimeProfile: {}, streamIsolationKey: ZP.bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))), runtimeToken: ZP.randomId('rt'), servers: relayServers, challengeCompat: !!challengeCompat };
  tab.entries.set(entryId, { entryId, targetUrl: target, baseUrl: target, title: '', stateClone: null, scrollX: 0, scrollY: 0, createdAt: Date.now() });
  tabs.set(tabId, tab);
  return tab;
}
function cleanupPendingSubmissions() {
  const now = Date.now();
  for (const [id, rec] of pendingSubmissions) {
    if (!rec || rec.expiresAt <= now) pendingSubmissions.delete(id);
  }
}
function randomEntryId() { return ZP.randomId('e'); }
function bindClientContext(clientId, tab, entry) { if (clientId) clientContext.set(clientId, { tabId: tab.tabId, entryId: entry.entryId, targetUrl: entry.targetUrl, baseUrl: entry.baseUrl || entry.targetUrl }); }
function contextFromPath(path) { const p = parseSharePath(path); const state = p && shareRoutes.get(p.routeKey); const tab = state && tabs.get(state.tabId); const entry = tab && tab.entries.get(state.entryId); if (entry) return { tabId: tab.tabId, entryId: entry.entryId, targetUrl: entry.targetUrl, baseUrl: entry.baseUrl || entry.targetUrl }; return null; }
function contextFromURL(u) { if (u.origin === ORIGIN) return resourceContext.get(u.pathname + u.search) || contextFromPath(u.pathname); return resourceContext.get(u.href) || null; }
function contextFor(req, clientId) { const ref = req.headers.get('Referer'); if (ref) { try { const ctx = contextFromURL(new URL(ref)); if (ctx) return ctx; } catch {} } if (clientId && clientContext.has(clientId)) return clientContext.get(clientId); return null; }
// A2 hardening: multi-tab "first available" fallbacks removed. Privileged
// paths must resolve a tab explicitly (URL param, referer, capability token,
// or client context). Silently piggy-backing on another tab leaks data.
function rememberResourceContext(requestURL, targetUrl, ctx) {
  const next = { tabId: ctx.tabId, entryId: ctx.entryId, targetUrl: ctx.targetUrl, baseUrl: targetUrl };
  const key = requestURL.origin === ORIGIN ? requestURL.pathname + requestURL.search : requestURL.href;
  resourceContext.set(key, next);
  resourceContext.set(targetUrl, next);
  while (resourceContext.size > 2048) resourceContext.delete(resourceContext.keys().next().value);
}
// RFC 6265 cookie jar (port of internal/cookiejar/jar.go).
// Replaces the prior flat tab.documentCookie string + name-only merge
// helper which discarded every Set-Cookie attribute except name/value
// (no Domain/Path/Secure/HttpOnly scoping). That caused cookie leakage
// between subdomains —
// www.naver.com cookies were echoed to mail.naver.com, nid login
// cookies polluted www, and back navigation rendered pages cold-state
// because the merged cookie blob no longer matched the per-host
// expectations. Cookies are now scoped by (Domain, Path, Name) and
// re-emitted only to URLs that match.
// Shared cookie jars keyed by target-origin (eTLD+host:port string the user
// originally typed). Multiple tabs viewing the same target share the same
// jar so a NACT issued in tab A's first navigation is immediately available
// to tab B's pstatic.net sub-resource fetch. RFC 6265 domain/path matching
// inside the jar handles per-host scoping — sub-resources to s.pstatic.net
// still only see cookies whose Domain attribute matches.
//
// Records are durably mirrored to IndexedDB so the NAVER 60-second
// anti-credential-stuffing slow lane is paid ONCE per first-cold-visit per
// browser profile, not on every tab open. Without persistence, every tab
// close drops NACT/NID/long-term tokens and the next NAVER nav restarts
// the lock.
const sharedJars = new Map(); // originKey → jar
const COOKIE_DB_NAME = 'zp-cookies';
const COOKIE_DB_VERSION = 1;
const COOKIE_DB_STORE = 'jars';
const COOKIE_FLUSH_INTERVAL_MS = 60_000;
const COOKIE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // session cookies: 7d
let cookieDbPromise = null;
function openCookieDb() {
  if (cookieDbPromise) return cookieDbPromise;
  cookieDbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(COOKIE_DB_NAME, COOKIE_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(COOKIE_DB_STORE)) {
          db.createObjectStore(COOKIE_DB_STORE, { keyPath: 'targetOrigin' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  }).catch(err => { cookieDbPromise = null; throw err; });
  return cookieDbPromise;
}
async function loadAllStoredJars() {
  try {
    const db = await openCookieDb();
    await new Promise((resolve) => {
      const tx = db.transaction(COOKIE_DB_STORE, 'readonly');
      const store = tx.objectStore(COOKIE_DB_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const now = Date.now();
        for (const entry of req.result || []) {
          if (!entry || !entry.targetOrigin || !Array.isArray(entry.records)) continue;
          // Strip expired before mounting — a 7-day-old session cookie that
          // already passed its synthetic TTL should not be revived.
          const live = entry.records.filter(r => {
            if (!r) return false;
            if (r.maxAge != null) {
              if (r.maxAge <= 0) return false;
              return r.creation + r.maxAge * 1000 > now;
            }
            return r.expires == null || r.expires > now;
          });
          getOrCreateJarForOrigin(entry.targetOrigin, live);
        }
        resolve();
      };
      req.onerror = () => resolve();
    });
  } catch {}
}
async function flushDirtyJarsToIDB() {
  try {
    const dirty = [];
    for (const [origin, jar] of sharedJars) {
      if (jar.consumeDirty()) dirty.push({ origin, records: jar.snapshot() });
    }
    if (!dirty.length) return;
    const db = await openCookieDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(COOKIE_DB_STORE, 'readwrite');
      const store = tx.objectStore(COOKIE_DB_STORE);
      for (const { origin, records } of dirty) {
        store.put({ targetOrigin: origin, records, updatedAt: Date.now() });
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}
// Boot: kick off async restore. Tabs created before restore completes will
// race-create empty jars; the IDB load will MERGE entries into those jars
// rather than replace, so cookies issued during the warm-up window are not
// dropped on top by the restore.
const restorePromise = loadAllStoredJars();
// Periodic background flush. Also flush on `unload`-equivalent transitions
// where possible — SW lifecycle doesn't have a true `beforeunload`, but
// `freeze`/`activate` happen at predictable points.
setInterval(() => { flushDirtyJarsToIDB(); }, COOKIE_FLUSH_INTERVAL_MS);
self.addEventListener('message', evt => {
  if (evt.data && evt.data.type === 'ZP_FLUSH_COOKIES') {
    evt.waitUntil ? evt.waitUntil(flushDirtyJarsToIDB()) : flushDirtyJarsToIDB();
  }
});

function originKeyForURL(targetUrl) {
  try { return new URL(targetUrl).origin; } catch { return ''; }
}
function getOrCreateJarForOrigin(originKey, initialRecords) {
  let jar = sharedJars.get(originKey);
  if (jar) {
    // Merge initial records (used by IDB restore arriving after first tab).
    if (Array.isArray(initialRecords) && initialRecords.length) jar.merge(initialRecords);
    return jar;
  }
  jar = createCookieJar(initialRecords || []);
  sharedJars.set(originKey, jar);
  return jar;
}

function createCookieJar(initialRecords) {
  const records = Array.isArray(initialRecords) ? initialRecords.slice() : [];
  let dirty = false;
  function markDirty() { dirty = true; }
  function canonHost(h) { return String(h || '').toLowerCase().replace(/\.$/, ''); }
  function defaultPath(u) {
    const p = u.pathname || '/';
    if (!p.startsWith('/')) return '/';
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }
  function domainMatch(host, domain, hostOnly) {
    if (!domain) return false;
    if (hostOnly) return host === domain;
    return host === domain || host.endsWith('.' + domain);
  }
  function pathMatch(reqPath, cookiePath) {
    cookiePath = cookiePath || '/';
    if (reqPath === cookiePath) return true;
    if (!reqPath.startsWith(cookiePath)) return false;
    return cookiePath.endsWith('/') || (reqPath.length > cookiePath.length && reqPath[cookiePath.length] === '/');
  }
  function expired(r, now) {
    if (r.maxAge != null) {
      if (r.maxAge <= 0) return true;
      return r.creation + r.maxAge * 1000 < now;
    }
    return r.expires != null && r.expires < now;
  }
  function parse(line, url) {
    let u; try { u = new URL(url); } catch { return null; }
    const parts = String(line).split(/;\s*/);
    const head = parts.shift() || '';
    const eq = head.indexOf('=');
    if (eq <= 0) return null;
    const name = head.slice(0, eq).trim();
    if (!name || /[=;\r\n]/.test(name)) return null;
    const host = canonHost(u.hostname);
    const rec = {
      name, value: head.slice(eq + 1),
      domain: host, hostOnly: true,
      path: defaultPath(u),
      secure: false, httpOnly: false, sameSite: '',
      expires: null, maxAge: null,
      creation: Date.now(),
    };
    for (const attr of parts) {
      const aeq = attr.indexOf('=');
      const k = (aeq >= 0 ? attr.slice(0, aeq) : attr).trim().toLowerCase();
      const v = aeq >= 0 ? attr.slice(aeq + 1).trim() : '';
      if (k === 'domain' && v) {
        const dom = canonHost(v.replace(/^\./, ''));
        if (!dom || !domainMatch(host, dom, false)) continue;
        rec.domain = dom;
        rec.hostOnly = false;
      } else if (k === 'path' && v && v[0] === '/') {
        rec.path = v;
      } else if (k === 'expires' && v) {
        const t = Date.parse(v);
        if (!isNaN(t)) rec.expires = t;
      } else if (k === 'max-age' && v) {
        const n = parseInt(v, 10);
        if (!isNaN(n)) rec.maxAge = n;
      } else if (k === 'secure') rec.secure = true;
      else if (k === 'httponly') rec.httpOnly = true;
      else if (k === 'samesite') rec.sameSite = v.toLowerCase();
    }
    return rec;
  }
  function setCookieLine(url, line) {
    const rec = parse(line, url);
    if (!rec) return;
    if (rec.maxAge != null && rec.maxAge <= 0) {
      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        if (r.name === rec.name && r.domain === rec.domain && r.path === rec.path) {
          records.splice(i, 1);
          markDirty();
          return;
        }
      }
      return;
    }
    // Session cookies (neither Expires nor Max-Age) survive across SW
    // restarts via the IDB layer — without this synthetic TTL their
    // `expires==null` would be persisted indefinitely and never pruned.
    // 7 days mirrors the upper bound NAVER's NACT lifecycle uses in
    // practice; longer would leak stale anti-bot tokens, shorter would
    // re-trigger the 60s slow-lane on weekly use.
    if (rec.maxAge == null && rec.expires == null) {
      rec.expires = Date.now() + COOKIE_SESSION_TTL_MS;
      rec.session = true;
    }
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (r.name === rec.name && r.domain === rec.domain && r.path === rec.path) {
        rec.creation = r.creation;
        records[i] = rec;
        markDirty();
        return;
      }
    }
    records.push(rec);
    markDirty();
  }
  function cookiesForURL(url, includeHttpOnly) {
    let u; try { u = new URL(url); } catch { return []; }
    const host = canonHost(u.hostname);
    const path = u.pathname || '/';
    const isSecure = u.protocol === 'https:';
    const now = Date.now();
    const out = [];
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (expired(r, now)) { records.splice(i, 1); continue; }
      if (!includeHttpOnly && r.httpOnly) continue;
      if (!domainMatch(host, r.domain, r.hostOnly)) continue;
      if (!pathMatch(path, r.path)) continue;
      if (r.secure && !isSecure) continue;
      out.push(r);
    }
    out.sort((a, b) => (b.path.length - a.path.length) || (a.creation - b.creation));
    return out;
  }
  function cookieHeader(url) {
    return cookiesForURL(url, true).map(r => r.name + '=' + r.value).join('; ');
  }
  function documentCookieFor(url) {
    return cookiesForURL(url, false).map(r => r.name + '=' + r.value).join('; ');
  }
  function snapshot() {
    // Return non-expired records for IDB serialisation. HttpOnly stays in —
    // it's a server-side flag that gates `document.cookie` exposure, not
    // jar membership. Strip the `creation` jitter to keep serialised blobs
    // stable across short-interval flushes (smaller IDB writes).
    const now = Date.now();
    return records.filter(r => !expired(r, now)).map(r => ({
      name: r.name, value: r.value,
      domain: r.domain, hostOnly: !!r.hostOnly,
      path: r.path,
      secure: !!r.secure, httpOnly: !!r.httpOnly,
      sameSite: r.sameSite || '',
      expires: r.expires, maxAge: r.maxAge,
      creation: r.creation,
      session: !!r.session,
    }));
  }
  function merge(restored) {
    // Used by the IDB restore path when records arrive AFTER live cookies
    // already populated the jar (e.g. a fast warm-up navigation finished
    // before the IDB GET resolved). Restored records DO NOT clobber live
    // ones with the same (name, domain, path) tuple — the live value is the
    // freshest authoritative one. Restored records also do not mark the
    // jar dirty (no need to re-persist what we just loaded).
    const now = Date.now();
    for (const r of restored) {
      if (!r || !r.name || !r.domain) continue;
      let liveIdx = -1;
      for (let i = 0; i < records.length; i++) {
        const cur = records[i];
        if (cur.name === r.name && cur.domain === r.domain && cur.path === r.path) {
          liveIdx = i; break;
        }
      }
      if (liveIdx >= 0) continue;
      // Skip already-expired restored records.
      if (r.maxAge != null) {
        if (r.maxAge <= 0) continue;
        if (r.creation + r.maxAge * 1000 <= now) continue;
      } else if (r.expires != null && r.expires <= now) continue;
      records.push(r);
    }
  }
  function consumeDirty() { const was = dirty; dirty = false; return was; }
  return { setCookieLine, cookieHeader, documentCookieFor, snapshot, merge, consumeDirty };
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
// addCSP wraps a kernel response with the SW-emitted policy block. The fourth
// arg `tab` (optional) carries the per-tab arm opt-in: when armed AND the
// kernel response carries the internal X-ZP-Challenge-Compat marker (emitted
// by the Go server's ApplyChallengeCompat when ITS two-signal gate held), the
// CSP gains the Cloudflare challenge-host whitelist. The marker is ALWAYS
// stripped before the response reaches the page (B4 strip obligation):
// leaking it would expose a proxy-internal control header and undermine the
// fingerprint-blind contract. The Cache-Control overwrite is delegated to the
// Go server's ConstructorPolicy — this wrapper only fills in the no-store
// default when upstream sent nothing, which is the correct floor for both
// armed and disarmed paths.
function addCSP(resp, req, servers, tab) {
  const h = new Headers(resp.headers);
  // B4: read once, then delete unconditionally — defense in depth against a
  // disarmed tab somehow seeing the header (e.g. server bug, racing reload).
  const responseSignalled = h.get('X-ZP-Challenge-Compat') === '1';
  h.delete('X-ZP-Challenge-Compat');
  const tabArmed = !!(tab && tab.challengeCompat);
  const armedHere = tabArmed && responseSignalled;
  h.set('Content-Security-Policy', ZP.fixedCSP(servers || [], { challengeCompat: armedHere }));
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Cache-Control', h.get('Cache-Control') || 'no-store');
  applyCORS(h, req);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}
function safeError(code, status = 400, targetUrl = '') {
  if (!ZP.ERRORS.includes(code)) code = 'POLICY_BLOCKED';
  const info = ZP.errorInfo(code);
  let host = '';
  try { host = targetUrl ? new URL(targetUrl).host : ''; } catch {}
  const hostHTML = host ? '<p class="zp-host">Target host: <code>' + escapeHTML(host) + '</code></p>' : '';
  const body = [
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>ZeroProxy &middot; ', escapeHTML(info.title), '</title>',
    '<style>',
    ':root{color-scheme:light dark}',
    'html,body{height:100%;margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e6e8ec}',
    '@media (prefers-color-scheme: light){html,body{background:#f5f6fa;color:#101218}}',
    '.zp-shell{max-width:32rem;margin:8vh auto;padding:1.5rem 1.75rem;border-radius:14px;background:rgba(255,255,255,.04);box-shadow:0 1px 0 rgba(255,255,255,.06) inset, 0 12px 32px rgba(0,0,0,.25)}',
    '@media (prefers-color-scheme: light){.zp-shell{background:#fff;box-shadow:0 1px 0 rgba(0,0,0,.04) inset, 0 12px 32px rgba(0,0,0,.06)}}',
    '.zp-mark{font-weight:700;letter-spacing:.04em;font-size:.78rem;text-transform:uppercase;opacity:.7}',
    '.zp-title{font-size:1.45rem;font-weight:700;margin:.35rem 0 .25rem}',
    '.zp-code{display:inline-block;padding:.1rem .55rem;border-radius:999px;background:rgba(127,127,127,.18);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.78rem;margin-top:.25rem}',
    '.zp-host{opacity:.85;margin:.75rem 0 .25rem}',
    '.zp-host code{font-family:ui-monospace,Menlo,Consolas,monospace}',
    '.zp-desc{margin:.75rem 0 1.25rem;opacity:.88}',
    '.zp-actions{display:flex;gap:.5rem;flex-wrap:wrap}',
    '.zp-btn{appearance:none;border:0;padding:.55rem 1rem;border-radius:8px;background:#3a82f6;color:#fff;font-weight:600;cursor:pointer;font-size:.92rem}',
    '.zp-btn.secondary{background:rgba(127,127,127,.18);color:inherit}',
    '.zp-btn:hover{filter:brightness(1.08)}',
    'details{margin-top:1rem;font-size:.86rem;opacity:.78}',
    'summary{cursor:pointer;user-select:none}',
    'pre{overflow:auto;background:rgba(127,127,127,.1);padding:.5rem .75rem;border-radius:6px;margin-top:.5rem;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.78rem}',
    '</style>',
    '<main class="zp-shell">',
    '<div class="zp-mark">ZeroProxy</div>',
    '<h1 class="zp-title">', escapeHTML(info.title), '</h1>',
    '<div class="zp-code">', escapeHTML(code), '</div>',
    hostHTML,
    '<p class="zp-desc">', escapeHTML(info.desc), '</p>',
    '<div class="zp-actions">',
    '<button class="zp-btn" onclick="history.back()">Back</button>',
    '<button class="zp-btn secondary" onclick="location.reload()">Retry</button>',
    '</div>',
    '<details><summary>Technical details</summary>',
    '<pre>code: ', escapeHTML(code), '\nhost: ', escapeHTML(host || '(none)'),
    '\ntime: ', new Date().toISOString(),
    '</pre></details>',
    '</main>'
  ].join('');
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': ZP.fixedCSP(),
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': '*',
    },
  });
}
function escapeHTML(s) { return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&#34;',"'":'&#39;'}[ch])); }
function workerBootstrap(url) { const body = "const __zp_worker_params=new URLSearchParams(self.location.hash.slice(1));self.__ZP_WORKER_TARGET=__zp_worker_params.get('u')||'about:blank';self.__ZP_WORKER_TAB_ID=__zp_worker_params.get('tab')||'';self.__ZP_WORKER_SERVERS=__zp_worker_params.getAll('server');importScripts('/zp/assets/worker-prelude.js');importScripts('/zp/api/worker-script?tab=' + encodeURIComponent(self.__ZP_WORKER_TAB_ID) + '&u=' + encodeURIComponent(self.__ZP_WORKER_TARGET));"; return new Response(body, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': ZP.fixedCSP(), 'X-Content-Type-Options': 'nosniff' } }); }
