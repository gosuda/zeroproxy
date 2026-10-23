/* ZeroProxy Service Worker: controlled network requests are routed through the Rust WASM kernel. */
importScripts('/zp/assets/zp-core.js?v=__ZP_BUILD_ID__');
// SW importScripts only succeeds during initial script evaluation, so load both
// WASM JS glue bundles at top level and instantiate their WASM modules lazily.
importScripts('/__zp/zp_bundle_sw.js?v=__ZP_BUILD_ID__');
importScripts('/__zp/zp_kernel_sw.js?v=__ZP_BUILD_ID__');

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

// In-memory LRU cache for rewritten script bodies, keyed by
// SHA-256(transformerVersion | kind | targetURL | sourceBytes). Only successful
// rewrites are cached so transient failures fall through to blockSource().
const REWRITE_CACHE_MAX_ENTRIES = 200;
const REWRITE_CACHE_MAX_BYTES = 50 * 1024 * 1024;
const rewriteCache = new Map();
let rewriteCacheBytes = 0;
let rewriteCacheVersion = '';

// Per-SW-lifetime rewriter telemetry surfaced via __zpKernelProbe.
const rewriteStats = {
  hits: 0,
  misses: 0,
  rewriteLatencyMs: 0,
  cacheKeyLatencyMs: 0,
  invocations: 0,
};

// Bounded ring buffer of recent outgoing transportFetch header arrays for __zpKernelProbe.
const MAX_HEADER_LOG = 16;
const outgoingHeaderLog = [];

// Record refused requests and their reasons so pages can inspect them via `__zp_refusals()`.
const MAX_REFUSAL_LOG = 64;
const refusalLog = [];
function logRefusal(code, status, targetUrl, extra) {
  try {
    refusalLog.push(Object.assign({
      ts: Date.now(),
      code: String(code || ''),
      status: status | 0,
      url: String(targetUrl || '').slice(0, 300),
    }, extra || {}));
    while (refusalLog.length > MAX_REFUSAL_LOG) refusalLog.shift();
  } catch {}
}
function logOutgoingHeaders(targetUrl, method, entries) {
  const entry = {
    ts: Date.now(),
    target: String(targetUrl).slice(0, 256),
    method,
    headers: entries.map(([k, v]) => [k, String(v).slice(0, 256)]),
    status: 0,
  };
  outgoingHeaderLog.push(entry);
  while (outgoingHeaderLog.length > MAX_HEADER_LOG) outgoingHeaderLog.shift();
  return entry;
}

// Per-SW-lifetime transport latency telemetry and bounded recent event log.
const MAX_TRANSPORT_LOG = 32;
const transportLatencyLog = [];
const transportStats = {
  requests: 0,
  totalLatencyMs: 0,
  totalBytes: 0,
  errors: 0,
};
function logTransportEvent(targetUrl, method, status, latencyMs, bytes) {
  transportStats.requests++;
  transportStats.totalLatencyMs += latencyMs;
  transportStats.totalBytes += bytes;
  if (status === 0 || status >= 500) transportStats.errors++;
  transportLatencyLog.push({
    ts: Date.now(),
    target: String(targetUrl).slice(0, 256),
    method,
    status,
    latencyMs: Math.round(latencyMs),
    bytes,
  });
  while (transportLatencyLog.length > MAX_TRANSPORT_LOG) transportLatencyLog.shift();
}

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
// Service Workers cannot intercept synchronous XHR directly, so the page parks requests on the Go server and this loop polls and fulfills them via `transportFetch`.
let syncRelayRunning = false;
async function syncFetchRelayLoop() {
  if (syncRelayRunning) return;
  syncRelayRunning = true;
  for (;;) {
    let batch = null;
    try {
      const r = await nativeFetch(ZP.apiPath('sync-fetch/poll'), { cache: 'no-store' });
      if (r.status === 200) batch = await r.json();
    } catch {
      await new Promise(res => setTimeout(res, 1000));
      continue;
    }
    if (!batch) continue;
    const jobs = Array.isArray(batch) ? batch : [batch];
    for (const job of jobs) handleSyncFetchJob(job).catch(() => {});
  }
}

// Retry briefly because inline scripts can issue synchronous XHR before tab registration finishes, falling back to the sole tab only when `tabId` is empty.
async function resolveSyncTab(tabIdOrUrl, tokenOpt) {
  if (!cookieJarLoaded) await ensureCookieJarLoaded();
  let tabId = tabIdOrUrl;
  let token = tokenOpt || '';
  if (tabIdOrUrl && typeof tabIdOrUrl === 'object' && tabIdOrUrl.searchParams) {
    tabId = tabIdOrUrl.searchParams.get('tab') || '';
    if (!token) token = tabIdOrUrl.searchParams.get('token') || '';
  }
  tabId = tabId ? String(tabId) : '';
  token = token ? String(token) : '';
  for (let i = 0; i < 20; i++) {
    if (tabId) {
      const t = tabs.get(tabId);
      if (t) {
        if (token && t.runtimeToken && token !== t.runtimeToken) return null;
        return t;
      }
    } else if (tabs.size === 1) {
      const t = tabs.values().next().value;
      if (token && t.runtimeToken && token !== t.runtimeToken) return null;
      return t;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!tabId && tabs.size === 1) {
    const t = tabs.values().next().value;
    if (token && t.runtimeToken && token !== t.runtimeToken) return null;
    return t;
  }
  return null;
}

function headerSafe(v) {
  return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
}
function utf8Base64(s) {
  const bytes = new TextEncoder().encode(String(s));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
// Rewrite `/zp/api/fetch?url=...` paths inside CSS delivered to uncontrolled documents into sync-fetch relay URLs, capped to prevent HTTP/1.1 connection exhaustion.
const MAX_RELAYED_CSS_URLS = 12;
const CSS_URL_STOP = '"\') \t\r\n';
async function relayifyCSSFetchURLs(resp, job) {
  let css;
  try { css = (await decodeResponseText(resp.clone(), false)).text; } catch { return resp; }
  const marker = ZP.apiPath('fetch') + '?url=';
  if (!css || css.indexOf(marker) < 0) return resp;
  let out = '';
  let i = 0;
  let moved = 0;
  let skipped = 0;
  for (;;) {
    const at = css.indexOf(marker, i);
    if (at < 0) { out += css.slice(i); break; }
    out += css.slice(i, at);
    let j = at + marker.length;
    while (j < css.length && CSS_URL_STOP.indexOf(css[j]) < 0) j++;
    const enc = css.slice(at + marker.length, j);
    let target = '';
    try { target = decodeURIComponent(enc.replace(/\+/g, '%20')); } catch { target = ''; }
    if (!/^https?:/i.test(target) || moved >= MAX_RELAYED_CSS_URLS) {
      if (moved >= MAX_RELAYED_CSS_URLS) skipped++;
      out += css.slice(at, j);
    } else {
      moved++;
      out += ZP.apiPath('sync-fetch')
        + '?rid=' + encodeURIComponent('sr' + ZP.randomId())
        + '&u=' + encodeURIComponent(target)
        + '&m=GET'
        + '&tab=' + encodeURIComponent(job.tab || '')
        + '&entry=' + encodeURIComponent(job.entry || '');
    }
    i = j;
  }
  if (skipped) logRefusal('css-relay-cap', 0, job.target, 'relayed first ' + MAX_RELAYED_CSS_URLS + ' URLs, left ' + skipped + ' unrewritten (expected 403)');
  if (!moved) return resp;
  const headers = new Headers(resp.headers);
  headers.delete('Content-Length');
  return new Response(out, { status: resp.status, statusText: resp.statusText, headers });
}
async function handleSyncFetchJob(job) {
  const out = { id: job.id, v: 'r4', status: 0, statusText: '', headers: [], body: null, err: '' };
  try {
    const tab = await resolveSyncTab(job.tab, job.token || job.runtimeToken);
    if (!tab) throw new Error('SW_NOT_READY tab=' + (job.tab || '(none)') + ' known=' + tabs.size);
    // Apply cookie writes queued by the page immediately before this synchronous request.
    if (tab.cookieJar && Array.isArray(job.cookies) && job.docUrl) {
      for (const pair of job.cookies) applyCookieWrite(tab, job.docUrl, pair && pair[1], pair && pair[0], undefined);
    }
    const entryId = job.entry || tab.activeEntryId;
    const entry = tab.entries && tab.entries.get(entryId);
    let resp = await transportFetch(job.target, Object.assign({
      method: job.method || 'GET',
      headers: Array.isArray(job.headers) ? job.headers : [],
      tab,
      entryId,
      // Return response Set-Cookie deltas in a header so the page applies them before synchronous send() returns.
      collectCookies: !job.kind,
    }, job.kind ? (job.cors === 'anonymous' || job.cors === 'use-credentials' ? {
      // Uncontrolled frame stylesheet or script with a crossorigin attribute.
      elementCors: true, mode: 'cors', credentials: job.cors === 'use-credentials' ? 'include' : 'same-origin',
      opaqueOrigin: !!(entry && entry.opaque),
    } : null) : {
      // Synchronous XHR obeys document CORS rules and sends cookies only when withCredentials is set.
      runtimeFetch: true, mode: 'cors', credentials: job.wc ? 'include' : 'same-origin',
      opaqueOrigin: !!(entry && entry.opaque),
    }));
    // Propagate network or CORS failures so synchronous send() throws and CORS element loads fail.
    if ((!job.kind || job.cors) && resp && resp.type === 'error') throw new Error('ZP_NETWORK_ERROR');
    const cookieChanges = resp && resp.__zpFetchMeta && resp.__zpFetchMeta.cookies;
    // Rewrite stylesheets and scripts fetched on behalf of uncontrolled frames so relative URLs and globals stay intact.
    if (job.kind === 'style') {
      resp = await rewriteCSSResponse(resp, { targetUrl: job.target });
      resp = await relayifyCSSFetchURLs(resp, job);
    }
    else if (job.kind === 'script') resp = await rewriteScriptResponse(resp, { targetUrl: job.target, kind: 'classic' });
    out.status = resp.status;
    out.statusText = resp.statusText || '';
    try {
      const visible = new Headers(resp.headers);
      corsFilterHeaders(visible, resp.__zpFetchMeta && resp.__zpFetchMeta.expose);
      visible.forEach((v, k) => out.headers.push([k, v]));
      // Package CORS-visible response headers into X-ZP-Sync-Visible for XHR getResponseHeader().
      if (!job.kind) {
        const readable = [];
        visible.forEach((v, k) => { if (!k.toLowerCase().startsWith('x-zp-') && k.toLowerCase() !== 'set-cookie') readable.push([k, v]); });
        out.headers.push(['X-ZP-Sync-Visible', utf8Base64(JSON.stringify(readable))]);
      }
    } catch {}
    if (Array.isArray(cookieChanges) && cookieChanges.length) out.headers.push(['X-ZP-Cookie-Delta', utf8Base64(JSON.stringify(cookieChanges))]);
    out.body = await resp.arrayBuffer();
  } catch (e) {
    out.err = String((e && e.message) || e || 'error');
    try { console.log('ZPSYNC-SW fail target=' + job.target + ' err=' + out.err); } catch {}
  }
  try {
    await nativeFetch(ZP.apiPath('sync-fetch/result'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-ZP-Sync-Id': String(out.id || ''),
        'X-ZP-Sync-Status': String(out.status || 0),
        'X-ZP-Sync-Statustext': headerSafe(out.statusText),
        'X-ZP-Sync-V': out.v,
        'X-ZP-Sync-Error': headerSafe(out.err),
        'X-ZP-Sync-Headers': utf8Base64(JSON.stringify(out.headers || [])),
      },
      body: out.body || new ArrayBuffer(0),
      cache: 'no-store',
    });
  } catch {}
}

// Start the polling loop at script evaluation time because an idle-terminated SW does not receive `activate` again on wake-up.
syncFetchRelayLoop();

self.addEventListener('activate', event => event.waitUntil((async () => {
  await self.clients.claim();
  syncFetchRelayLoop();
  const BUNDLE_BOOT_TIMEOUT_MS = 30000;
  await Promise.race([
    initBundle().catch(() => null),
    new Promise(r => setTimeout(r, BUNDLE_BOOT_TIMEOUT_MS)),
  ]);
  await Promise.race([
    refreshRuntimeConfig().catch(() => null),
    new Promise(r => setTimeout(r, 5000)),
  ]);
})()));

// Runtime config threaded into boot JSON on navigation (/zp/api/config).
let runtimeConfig = { wtGateway: '', wtGatewayCertHashes: [], rtcICEServers: [] };
let runtimeConfigPromise = null;
// Re-fetch runtime configuration on a short TTL so idle-restarted SWs and restarted dev servers pick up fresh certificate hashes.
const RUNTIME_CONFIG_TTL_MS = 10000;
let runtimeConfigAt = 0;
async function ensureRuntimeConfig() {
  if (Date.now() - runtimeConfigAt < RUNTIME_CONFIG_TTL_MS) return;
  await Promise.race([
    refreshRuntimeConfig().catch(() => null),
    new Promise(r => setTimeout(r, 1500)),
  ]);
}
async function refreshRuntimeConfig() {
  if (runtimeConfigPromise) return runtimeConfigPromise;
  runtimeConfigPromise = (async () => {
    try {
      const r = await self.fetch(ZP.CONTROL_PREFIX + 'api/config', { cache: 'no-store' });
      if (r && r.ok) {
        const cfg = await r.json();
        if (cfg && typeof cfg === 'object') {
          runtimeConfig = {
            wtGateway: typeof cfg.wtGateway === 'string' ? cfg.wtGateway : '',
            wtGatewayCertHashes: Array.isArray(cfg.wtGatewayCertHashes)
              ? cfg.wtGatewayCertHashes.filter(h => typeof h === 'string' && h) : [],
            rtcICEServers: Array.isArray(cfg.rtcICEServers) ? cfg.rtcICEServers : [],
          };
          runtimeConfigAt = Date.now();
        }
      }
    } catch {}
    runtimeConfigPromise = null;
    return runtimeConfig;
  })();
  return runtimeConfigPromise;
}
self.addEventListener('message', event => event.waitUntil(handleMessage(event)));
self.addEventListener('fetch', event => {
  // Only intercept http(s) requests so browser-internal schemes (chrome-extension:, data:, blob:, about:) use native handling.
  const u = event.request.url;
  if (!u.startsWith('http:') && !u.startsWith('https:')) return;
  // Pass CSP violation reports and synchronous XHR relay requests directly to the Go server so they are not misclassified as target subresources.
  if (event.request.method === 'POST') {
    try {
      const p = new URL(u).pathname;
      if (p === ZP.apiPath('csp-report')) return;
    } catch {}
  }
  try {
    if (new URL(u).pathname === ZP.apiPath('sync-fetch')) return;
  } catch {}
  const responded = handleFetch(event)
    .then(resp => reportEncodedSize(event, resp))
    .then(completeBodyResponse);
  event.respondWith(responded);
  // Attach lifetime after all header/HTML wrappers: recreating a Response
  // otherwise loses its completion promise. Cancellation must reach the kernel.
  event.waitUntil(responded.then(r => (r && r.__zpBodyDone) || undefined).catch(() => undefined));
});

function completeBodyResponse(resp) {
  if (!resp || !resp.headers || resp.headers.get('X-ZP-Body-Stream') !== '1') return resp;
  const headers = new Headers(resp.headers);
  headers.delete('X-ZP-Body-Stream');
  headers.delete('X-ZP-Stream');
  if (!resp.body) return new Response(null, { status: resp.status, statusText: resp.statusText, headers });
  const reader = resp.body.getReader();
  let resolveDone;
  const bodyDone = new Promise(resolve => { resolveDone = resolve; });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    try { reader.releaseLock(); } catch {}
    resolveDone();
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { finish(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      finally { finish(); }
    },
  }, { highWaterMark: 0 });
  const result = new Response(body, { status: resp.status, statusText: resp.statusText, headers });
  Object.defineProperty(result, '__zpBodyDone', { value: bodyDone });
  return result;
}

// Chrome ClientHello spec (base64 JSON: {supportedVersions, cipherSuites,
// extensions, supportedCurves, supportedPoints, signatureSchemes, alpnProtocols})
// installed into the WASM kernel's rustls set_captured_spec.
const CAPTURED_FINGERPRINT_B64 = 'eyJzdXBwb3J0ZWRWZXJzaW9ucyI6Wzc3Miw3NzFdLCJjaXBoZXJTdWl0ZXMiOls0ODY1LDQ4NjYsNDg2Nyw0OTE5NSw0OTE5OSw0OTE5Niw0OTIwMCw1MjM5Myw1MjM5Miw0OTE3MSw0OTE3MiwxNTYsMTU3LDQ3LDUzXSwiZXh0ZW5zaW9ucyI6WzAsMTc2MTMsNTEsNjUyODEsNDMsMTYsNSwxMSwxMywxOCwyMywyNywxMCwzNSw0NSw2NTAzNyw1MTc2NF0sInN1cHBvcnRlZEN1cnZlcyI6WzQ1ODgsMjksMjMsMjRdLCJzdXBwb3J0ZWRQb2ludHMiOiJBQT09Iiwic2lnbmF0dXJlU2NoZW1lcyI6WzIzMDgsMjMwOSwyMzEwLDEwMjcsMjA1MiwxMDI1LDEyODMsMjA1MywxMjgxLDIwNTQsMTUzN10sImFscG5Qcm90b2NvbHMiOlsiaDIiLCJodHRwLzEuMSJdfQ==';
function browserAcceptLanguage() {
  try {
    const raw = self.navigator && self.navigator.languages;
    const list = [];
    for (const l of (raw || [])) {
      if (typeof l === 'string' && l && list.indexOf(l) < 0) list.push(l);
      if (list.length >= 10) break;
    }
    if (!list.length) return 'en-US,en;q=0.9';
    return list.map((l, i) => (i === 0 ? l : l + ';q=' + Math.max(1 - i * 0.1, 0.1).toFixed(1))).join(',');
  } catch { return 'en-US,en;q=0.9'; }
}

// Client Hints negotiation matching Chrome:
// - sec-ch-ua, sec-ch-ua-mobile, and sec-ch-ua-platform are sent on every request to a potentially trustworthy URL.
// - High-entropy hints are sent only after a top-level document of that origin opts in via Accept-CH.
// - A top-level navigation whose response specifies missing Critical-CH hints is reissued once with those hints.
const CLIENT_HINT_NAV_ORDER = [
  'device-memory', 'sec-ch-device-memory', 'dpr', 'sec-ch-dpr', 'viewport-width', 'sec-ch-viewport-width',
  'sec-ch-viewport-height', 'rtt', 'downlink', 'ect', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-full-version',
  'sec-ch-ua-arch', 'sec-ch-ua-platform', 'sec-ch-ua-platform-version', 'sec-ch-ua-model', 'sec-ch-ua-bitness',
  'sec-ch-ua-wow64', 'sec-ch-ua-full-version-list', 'sec-ch-ua-form-factors', 'sec-ch-prefers-color-scheme',
  'sec-ch-prefers-reduced-motion', 'sec-ch-prefers-reduced-transparency', 'save-data',
];
const CLIENT_HINT_DEFAULTS = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'];
// Host browser client hints on incoming SW requests describe the proxy origin and must not be forwarded upstream.
const BROWSER_CLIENT_HINTS = new Set([...CLIENT_HINT_NAV_ORDER, 'width', 'sec-ch-width', 'sec-ch-ua-reduced', 'sec-ch-ua-full']);
// Per-origin high-entropy hint set requested by the latest top-level Accept-CH response header.
const clientHintPrefs = new Map();
function parseClientHintList(value) {
  const out = new Set();
  for (const raw of String(value || '').split(',')) {
    const name = raw.trim().toLowerCase();
    if (CLIENT_HINT_NAV_ORDER.includes(name)) out.add(name);
  }
  return out;
}
// Chrome sends client hints and Sec-Fetch-* headers only to potentially trustworthy URLs (https or loopback).
function potentiallyTrustworthyURL(u) {
  try {
    const url = new URL(u);
    if (url.protocol === 'https:') return true;
    const h = url.hostname;
    return h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '[::1]';
  } catch { return false; }
}
// Compute client hint values from the target UA persona, navigator device/network metrics, and tab viewport/media state.
function clientHintValue(name, env) {
  const he = ZP.TARGET_UA_HIGH_ENTROPY;
  const q = s => '"' + s + '"';
  const nav = self.navigator || {};
  const conn = nav.connection || null;
  switch (name) {
    case 'sec-ch-ua': return ZP.TARGET_SEC_CH_UA;
    case 'sec-ch-ua-mobile': return '?0';
    case 'sec-ch-ua-platform': return q('Windows');
    case 'sec-ch-ua-arch': return q(he.architecture);
    case 'sec-ch-ua-bitness': return q(he.bitness);
    case 'sec-ch-ua-full-version': return q(he.uaFullVersion);
    case 'sec-ch-ua-full-version-list': return he.fullVersionList.map(b => q(b.brand) + ';v=' + q(b.version)).join(', ');
    case 'sec-ch-ua-model': return q(he.model);
    case 'sec-ch-ua-platform-version': return q(he.platformVersion);
    case 'sec-ch-ua-wow64': return he.wow64 ? '?1' : '?0';
    case 'sec-ch-ua-form-factors': return he.formFactors.map(q).join(', ');
    case 'device-memory': case 'sec-ch-device-memory': return typeof nav.deviceMemory === 'number' ? String(nav.deviceMemory) : null;
    case 'rtt': return conn && typeof conn.rtt === 'number' ? String(conn.rtt) : null;
    case 'downlink': return conn && typeof conn.downlink === 'number' ? String(conn.downlink) : null;
    case 'ect': return conn && conn.effectiveType ? String(conn.effectiveType) : null;
    case 'save-data': return conn && conn.saveData ? 'on' : null;
  }
  if (!env) return null;
  switch (name) {
    case 'dpr': case 'sec-ch-dpr': return typeof env.dpr === 'number' && env.dpr > 0 ? String(env.dpr) : null;
    case 'viewport-width': case 'sec-ch-viewport-width': return env.vw > 0 ? String(Math.round(env.vw)) : null;
    case 'sec-ch-viewport-height': return env.vh > 0 ? String(Math.round(env.vh)) : null;
    case 'sec-ch-prefers-color-scheme': return env.scheme === 'dark' ? 'dark' : env.scheme === 'light' ? 'light' : null;
    case 'sec-ch-prefers-reduced-motion': return env.motion === 'reduce' ? 'reduce' : env.motion === 'no-preference' ? 'no-preference' : null;
    case 'sec-ch-prefers-reduced-transparency': return env.transparency === 'reduce' ? 'reduce' : env.transparency === 'no-preference' ? 'no-preference' : null;
  }
  return null;
}
function sanitizeClientEnv(env) {
  if (!env || typeof env !== 'object') return null;
  const num = v => (typeof v === 'number' && isFinite(v) && v > 0 && v < 100000 ? v : 0);
  const pick = (v, allowed) => (allowed.includes(v) ? v : '');
  return {
    dpr: num(env.dpr), vw: num(env.vw), vh: num(env.vh),
    scheme: pick(env.scheme, ['light', 'dark']),
    motion: pick(env.motion, ['reduce', 'no-preference']),
    transparency: pick(env.transparency, ['reduce', 'no-preference']),
  };
}
// High-entropy hints for a request in Chrome's navigation order.
function highEntropyHintsFor(opt, u, topLevel, inFrame) {
  if (!potentiallyTrustworthyURL(u)) return [];
  let origin;
  try { origin = new URL(u).origin; } catch { return []; }
  const top = opt.tab && opt.tab.topOrigin;
  let prefs = null;
  if (topLevel) prefs = clientHintPrefs.get(origin);
  else if (origin === top) {
    if (inFrame) {
      const entry = opt.tab.entries && opt.tab.entries.get(opt.entryId);
      let parent = top;
      try { if (entry && entry.parentTargetUrl) parent = new URL(entry.parentTargetUrl).origin; } catch {}
      if (parent === top) prefs = clientHintPrefs.get(top);
    } else if (opt.context && opt.context.origin === top) prefs = clientHintPrefs.get(top);
  }
  if (!prefs || !prefs.size) return [];
  return CLIENT_HINT_NAV_ORDER.filter(n => prefs.has(n) && !CLIENT_HINT_DEFAULTS.includes(n));
}

// Wire header ordering templates matching Blink's navigation and subresource header ordering.
const NAV_REQUEST_LINE = ['upgrade-insecure-requests', 'user-agent', 'accept'];
const NAV_TAIL = ['*', 'origin', 'content-type', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-user', 'sec-fetch-dest', 'sec-fetch-storage-access', 'referer', 'accept-encoding', 'accept-language', 'cookie', 'priority'];
const SUB_TAIL = ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-storage-access', 'referer', 'accept-encoding', 'accept-language', 'cookie', 'priority'];
const SUB_MAP_PLAIN = ['sec-ch-ua-platform', 'user-agent', 'sec-ch-ua', 'content-type', '*', 'sec-ch-ua-mobile', 'accept', 'origin'];
const SUB_MAP_UA = ['sec-ch-ua-full-version-list', 'sec-ch-ua-platform', 'sec-ch-ua', 'sec-ch-ua-bitness', 'sec-ch-ua-model', 'sec-ch-ua-mobile', 'sec-ch-ua-arch', 'sec-ch-ua-full-version', 'user-agent', 'content-type', '*', 'sec-ch-ua-platform-version', 'accept', 'origin'];
const SUB_MAP_ALL = ['sec-ch-ua-full-version-list', 'sec-ch-ua-platform', 'viewport-width', 'device-memory', 'sec-ch-ua', 'sec-ch-dpr', 'sec-ch-ua-model', 'sec-ch-ua-mobile', 'sec-ch-ua-form-factors', 'sec-ch-ua-bitness', 'sec-ch-ua-wow64', 'sec-ch-ua-arch', 'sec-ch-prefers-reduced-transparency', 'sec-ch-ua-full-version', 'content-type', 'sec-ch-viewport-width', 'downlink', 'sec-ch-viewport-height', 'ect', 'sec-ch-device-memory', 'sec-ch-prefers-reduced-motion', 'dpr', 'sec-ch-prefers-color-scheme', 'user-agent', '*', 'rtt', 'sec-ch-ua-platform-version', 'save-data', 'accept', 'origin'];
function requestHeaderTemplate(kind, hints) {
  if (kind === 'navigation') return [...CLIENT_HINT_NAV_ORDER.filter(n => hints.includes(n)), ...NAV_REQUEST_LINE, ...NAV_TAIL];
  if (kind === 'critical-restart') return [...NAV_REQUEST_LINE, ...CLIENT_HINT_NAV_ORDER.filter(n => hints.includes(n)), ...NAV_TAIL];
  const high = hints.filter(n => !CLIENT_HINT_DEFAULTS.includes(n));
  const uaOnly = high.every(n => SUB_MAP_UA.includes(n));
  const map = !high.length ? SUB_MAP_PLAIN : uaOnly ? SUB_MAP_UA : SUB_MAP_ALL;
  return [...map, ...SUB_TAIL];
}
// Order lowercase header entries by template position, placing unlisted names at '*' in their relative order.
function orderRequestHeaders(entries, template) {
  const star = template.indexOf('*');
  const rank = name => { const i = template.indexOf(name); return i < 0 ? star : i; };
  const indexed = entries.map((e, i) => ({ e, i, r: rank(String(e[0]).toLowerCase()) }));
  indexed.sort((a, b) => (a.r - b.r) || (a.i - b.i));
  const sorted = indexed.map(x => x.e);
  const present = new Set(sorted.map(e => String(e[0]).toLowerCase()));
  const order = [];
  for (const name of template) {
    if (name === '*') { for (const e of sorted) { const n = String(e[0]).toLowerCase(); if (rank(n) === star && !order.includes(n)) order.push(n); } continue; }
    if (!order.includes(name)) order.push(name);
  }
  for (const n of present) if (!order.includes(n)) order.push(n);
  return { sorted, order };
}

function captureBrowserFingerprint() { return CAPTURED_FINGERPRINT_B64; }

async function initBundle() {
  if (self.ZPBundle && self.ZPBundle.ready) return;
  if (bundlePromise) return bundlePromise;
  const wbg = self.ZPBundleWBG;
  if (typeof wbg !== 'function') {
    throw new Error('REALM_INJECTION_FAILURE');
  }
  bundlePromise = (async () => {
    await wbg({ module_or_path: '/__zp/zp_bundle_sw_bg.wasm?v=__ZP_BUILD_ID__' });
    // Read exports from the wbg factory properties rather than the raw wasm.exports return value so JS heap wrappers run.
    self.ZPBundle = Object.freeze({
      ready: true,
      bundleVersion: wbg.bundleVersion,
      // Pass ORIGIN as proxyOrigin so rewritten dynamic-import URLs are absolute and do not resolve against the virtual target base.
      rewriteScript: (source, kind, targetUrl) => wbg.rewriteScript(source, kind || 'classic', targetUrl || '', ORIGIN),
      rewriteScriptPatches: typeof wbg.rewriteScriptPatches === 'function'
        ? (source, kind, targetUrl) => wbg.rewriteScriptPatches(source, kind || 'classic', targetUrl || '', ORIGIN)
        : null,
      transformHtml: (html, targetUrl) => wbg.transformHtml(html, targetUrl || '', ORIGIN),
      HtmlTxn: typeof wbg.HtmlTxn === 'function' ? wbg.HtmlTxn : null,
      // Pass ORIGIN as proxyOrigin so emitted /zp/api/fetch URLs are absolute regardless of the consuming context's virtual base.
      rewriteCSS: (source, baseUrl, controlPrefix, proxyOrigin) =>
        wbg.rewriteCSS(source, baseUrl || '', controlPrefix || '/zp/', proxyOrigin === undefined ? ORIGIN : (proxyOrigin || '')),
      composeSourceMap: (source, kind, targetUrl) =>
        wbg.composeSourceMap(source, kind || 'classic', targetUrl || '', ORIGIN),
      composeSourceMapChained: typeof wbg.composeSourceMapChained === 'function'
        ? (source, kind, targetUrl, originalMapJson) =>
            wbg.composeSourceMapChained(source, kind || 'classic', targetUrl || '', originalMapJson || '', ORIGIN)
        : null,
      buildCSP: (wsOrigin) => wbg.buildCSP(wsOrigin || ''),
    });
  })().catch(err => { bundlePromise = null; throw err; });
  return bundlePromise;
}

// Instantiate the transport WASM kernel lazily on the first upstream fetch.
let kernelPromise = null;
async function initKernel() {
  if (self.ZPKernel && self.ZPKernel.ready) return;
  if (kernelPromise) return kernelPromise;
  const wbg = self.ZPKernelWBG;
  if (typeof wbg !== 'function') {
    throw new Error('KERNEL_REALM_INJECTION_FAILURE');
  }
  kernelPromise = (async () => {
    await wbg({ module_or_path: '/__zp/zp_kernel_sw_bg.wasm?v=__ZP_BUILD_ID__' });
    self.ZPKernel = Object.freeze({
      ready: true,
      kernelVersion: wbg.kernelVersion,
      kernelInit: wbg.kernelInit,
      kernelFetch: wbg.kernelFetch,
      kernelEchoSync: wbg.kernelEchoSync,
      kernelStream: wbg.kernelStream,
      kernelLastNamedGroups: wbg.kernelLastNamedGroups,
    });
    if (typeof self.ZPKernel.kernelFetch === 'function') {
      self.kernelFetch = self.ZPKernel.kernelFetch;
    }
    if (typeof self.ZPKernel.kernelStream === 'function') {
      self.kernelStream = self.ZPKernel.kernelStream;
    }
    if (typeof self.ZPKernel.kernelInit === 'function') {
      try { self.ZPKernel.kernelInit(); } catch {}
    }
    const setSpec = wbg.kernelSetCapturedSpec;
    if (typeof setSpec === 'function') {
      const spec = captureBrowserFingerprint();
      if (spec) {
        try { setSpec(spec); } catch {}
      }
    }
  })().catch(err => { kernelPromise = null; throw err; });
  return kernelPromise;
}

async function handleFetch(event) {
  const req = event.request;
  const url = new URL(req.url);
  try {
    if (isCORSPreflight(req)) return corsPreflight(req);
    if (!cookieJarLoaded) await ensureCookieJarLoaded();
    const clientId = event.resultingClientId || event.clientId;
    const cls = classify(req, url, clientId);
    switch (cls.kind) {
      case 'INTERNAL_ASSET': return internalAsset(req, url);
      case 'PROXY_DOCUMENT': return proxyDocument(req, cls, clientId);
      case 'RUNTIME_API': return runtimeAPI(req, url, clientId);
      case 'VIRTUAL_SUBRESOURCE': return virtualSubresource(req, cls, clientId);
      case 'BLANK_ICON': return new Response(null, { status: 204, headers: { 'cache-control': 'max-age=86400' } });
      // Record unclassified subresource refusals in `refusalLog` because `Response.error()` produces no console reason.
      default:
        logRefusal('UNCLASSIFIED', req.mode === 'navigate' ? 403 : 0, url.href, {
          mode: req.mode, dest: req.destination, client: clientId || '', ref: req.headers.get('Referer') || '',
        });
        return req.mode === 'navigate' ? safeError('POLICY_BLOCKED', 403) : Response.error();
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
    // Same-origin subresources must resolve a tab from an explicit Referer or saved clientContext without falling back to an arbitrary tab.
    const ctx = contextFor(req, clientId);
    const p = parseSharePath(url.pathname);
    if (p && req.mode === 'navigate') return { kind: 'PROXY_DOCUMENT', ...p };
    if (ctx) {
      // Route proxy-origin relative subresources (such as runtime CSS resolved against the document URL) as virtual subresources when client context is known.
      if (url.pathname.startsWith(ZP.CONTROL_PREFIX)) {
        try {
          (self.__zpRustTrace = self.__zpRustTrace || []).push(
            `sw:zp-path-as-subresource ${url.pathname} search=${String(url.search || '(none)').slice(0, 120)} dest=${req.destination || '?'} mode=${req.mode || '?'} initiator=${String(req.referrer || '(none)').slice(-160)} ref=${String(req.headers.get('Referer') || '(none)').slice(-160)}`
          );
        } catch {}
      }
      return { kind: 'VIRTUAL_SUBRESOURCE', ctx, sameOriginURL: url };
    }
    if (p && shareRoutes.has(p.routeKey)) return { kind: 'PROXY_DOCUMENT', ...p };
    // Answer browser-initiated /favicon.ico requests (no client ctx) with 204 so the tab does not leak the target icon or log a network error.
    if (url.pathname === '/favicon.ico' && !ctx) return { kind: 'BLANK_ICON' };
    return { kind: 'UNKNOWN' };
  }
  const ctx = contextFor(req, clientId);
  if (ctx && (url.protocol === 'http:' || url.protocol === 'https:')) return { kind: 'VIRTUAL_SUBRESOURCE', ctx, crossOriginURL: url };
  return { kind: 'UNKNOWN' };
}

function internalPath(path) {
  return ZP.isInternalPath(path);
}
function isRuntimeAPIPath(path) {
  return path === ZP.apiPath('fetch') || path === ZP.apiPath('v2/fetch') || path === ZP.apiPath('script') || path === ZP.apiPath('worker-script') || path === ZP.apiPath('sourcemap') || path === '/zp/api/diag/trace';
}

async function internalAsset(req, url) {
  if (url.pathname.startsWith(ZP.controlPath('error/'))) return safeError(decodeURIComponent(url.pathname.split('/').pop() || 'POLICY_BLOCKED'), 400);
  if (url.pathname === ZP.controlPath('worker-bootstrap.js')) return workerBootstrap(url);
  if (url.pathname === ZP.CONTROL_PREFIX || url.pathname === ZP.controlPath('index.html')) return addCSP(await nativeFetch(req, { cache: 'no-store' }), req);
  if (!internalPath(url.pathname) && url.pathname !== ZP.controlPath('sw.js')) return safeError('POLICY_BLOCKED', 403);
  // Use the default cache mode for internal assets so `Last-Modified` conditional revalidation (`304 Not Modified`) works.
  return addCSP(await nativeFetch(req), req);
}

function parseSharePath(path) {
  const m = /^\/zp\/p\/([^/]+)$/.exec(path);
  if (!m) return null;
  return { routeKey: m[1] };
}



function isChildFrameDocument(req, entry, routeState) {
  if (routeState && routeState.frameRoute) return true;
  if (entry && (entry.frameRoute || entry.parentTargetUrl)) return true;
  if (req) {
    const dest = req.destination || '';
    if (dest === 'iframe' || dest === 'frame') return true;
    const secDest = req.headers && req.headers.get('Sec-Fetch-Dest');
    if (secDest === 'iframe' || secDest === 'frame') return true;
  }
  return false;
}

// The launcher page, served for a share route this worker has no state for: the page boots the route from its fragment. For an iframe it
// must be embeddable by a page that demands cross-origin isolation (a site frame is opened from another real origin).
async function launcherForRoute(req) {
  const resp = await internalAsset(new Request(ZP.CONTROL_PREFIX), new URL(ZP.CONTROL_PREFIX, ORIGIN));
  if (!isChildFrameDocument(req, null, null)) return resp;
  const h = new Headers(resp.headers);
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}
async function proxyDocument(req, route, clientId) {
  cleanupPendingSubmissions();
  const state = shareRoutes.get(route.routeKey);
  if (!state) return launcherForRoute(req);
  const tab = tabs.get(state.tabId);
  const entry = tab && tab.entries.get(state.entryId);
  if (!tab || !entry) {
    shareRoutes.delete(route.routeKey);
    return launcherForRoute(req);
  }
  const isFrame = isChildFrameDocument(req, entry, state);
  if (isFrame) entry.frameRoute = true;
  if (!isFrame || !tab.activeEntryId) tab.activeEntryId = entry.entryId;
  bindClientContext(clientId, tab, entry);
  scheduleStateFlush();
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
  const isFrame = isChildFrameDocument(req, entry, null);
  if (isFrame) entry.frameRoute = true;
  if (!isFrame || !tab.activeEntryId) tab.activeEntryId = entry.entryId;
  bindClientContext(clientId, tab, entry);
  scheduleStateFlush();
  return transportFetch(pending.targetUrl, { request: req, document: true, method: pending.method, headers: pending.headers, body: pending.body, tab, entryId: entry.entryId, submitReferrer: pending.referrer });
}


async function virtualSubresource(req, cls, clientId) {
  const ctx = cls.ctx;
  const tab = tabs.get(ctx.tabId);
  if (!tab) return Response.error();
  const targetUrl = cls.crossOriginURL ? cls.crossOriginURL.href : sameOriginTargetURL(cls.sameOriginURL, ctx);
  const document = req.mode === 'navigate' || req.headers.get('X-ZP-Document-Request') === '1';
  const resp = await transportFetch(targetUrl, { request: req, document, tab, entryId: ctx.entryId, noRange: isPlaylistTarget(req, targetUrl) });
  rememberResourceContext(cls.crossOriginURL || cls.sameOriginURL, targetUrl, ctx);
  if (isMediaElementRequest(req) && isPlaylistResponse(resp, targetUrl)) {
    return rewritePlaylistResponse(req, resp, {
      targetUrl, tab,
      refetch: () => transportFetch(targetUrl, { request: req, document, tab, entryId: ctx.entryId, noRange: true }),
    });
  }
  if (shouldRewriteCSS(req, resp)) return rewriteCSSResponse(resp, { targetUrl });
  return shouldRewriteScript(req, resp) ? rewriteScriptResponse(resp, { targetUrl, kind: scriptKindFromRequest(req), req }) : resp;
}

function shouldRewriteCSS(req, resp) {
  if (req.destination === 'style') return true;
  // Recognize stylesheet requests proxied via `fetch()` by a parent frame on behalf of an uncontrolled child document.
  if (req.headers.get('X-ZP-Style-Request') === '1') return true;
  const ct = resp && resp.headers && resp.headers.get('Content-Type') || '';
  return /\btext\/css\b/i.test(ct);
}
async function rewriteCSSResponse(resp, opt) {
  // Rewrite CSS url(...) and @import references to /zp/api/fetch?url=<absolute>, falling back to the original body on parse failure.
  let css = '';
  try { css = (await decodeResponseText(resp, false)).text; } catch { return resp; }
  let out = css;
  try {
    if (self.ZPBundle && self.ZPBundle.ready && typeof self.ZPBundle.rewriteCSS === 'function') {
      const code = self.ZPBundle.rewriteCSS(css, opt.targetUrl || '', ZP.CONTROL_PREFIX);
      if (typeof code === 'string' && code.length > 0) out = code;
    }
  } catch { /* fall through with original */ }
  const headers = new Headers(resp.headers);
  headers.delete('Content-Length');
  headers.set('Content-Type', 'text/css; charset=utf-8');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(out, { status: resp.status, statusText: resp.statusText, headers });
}

// Native media elements fetch HLS variants, keys, and segments directly in the browser media stack, bypassing page hooks.
// Rewrite playlist URIs to /zp/api/fetch?url=<absolute> when the request originates from a video or audio element.
const PLAYLIST_TYPE_RE = /\b(?:application\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)|audio\/(?:x-)?mpegurl)\b/i;
const PLAYLIST_PATH_RE = /\.m3u8?$/i;
function isMediaElementRequest(req) {
  return req.destination === 'video' || req.destination === 'audio';
}
function isPlaylistResponse(resp, targetUrl) {
  if (!resp || (resp.status !== 200 && resp.status !== 206)) return false;
  const ct = resp.headers.get('Content-Type') || '';
  if (PLAYLIST_TYPE_RE.test(ct)) return true;
  let path = '';
  try { path = new URL(targetUrl).pathname; } catch {}
  return PLAYLIST_PATH_RE.test(path) && (!ct || /^(?:text\/plain|application\/octet-stream|binary\/octet-stream)\b/i.test(ct));
}
// Strip Range on media element requests targeting playlists so the full playlist can be rewritten before slicing.
function isPlaylistTarget(req, targetUrl) {
  if (!isMediaElementRequest(req)) return false;
  try { return PLAYLIST_PATH_RE.test(new URL(targetUrl).pathname); } catch { return false; }
}
function playlistProxyURI(uri, baseUrl, tab) {
  const t = String(uri).trim();
  if (!t) return uri;
  let abs;
  try { abs = new URL(t, baseUrl); } catch { return uri; }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return uri;
  return ORIGIN + ZP.apiPath('fetch') + '?url=' + encodeURIComponent(abs.href) + (tab ? '&tab=' + encodeURIComponent(tab.tabId) : '');
}
function rewritePlaylistText(text, baseUrl, tab) {
  return String(text).replace(/^﻿/, '').split(/(\r?\n)/).map(line => {
    if (line === '' || line === '\n' || line === '\r\n') return line;
    if (line.charAt(0) === '#') return line.replace(/URI="([^"]*)"/g, (_m, u) => 'URI="' + playlistProxyURI(u, baseUrl, tab) + '"');
    return line.trim() ? playlistProxyURI(line, baseUrl, tab) : line;
  }).join('');
}
async function rewritePlaylistResponse(req, resp, opt) {
  // Refetch partial (206) playlist responses whole before rewriting, then serve any requested byte range from the rewritten buffer.
  let source = resp;
  if (resp.status === 206) {
    try { source = await opt.refetch(); } catch { return resp; }
    if (!source || source.status !== 200) return resp;
  }
  let text;
  try { text = await source.text(); } catch { return resp; }
  const headers = new Headers(source.headers);
  for (const name of ['Content-Length', 'Content-Range', 'Content-Encoding', 'Transfer-Encoding', 'ETag', 'Last-Modified']) headers.delete(name);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (!/^\s*#EXTM3U/.test(text.replace(/^﻿/, ''))) return new Response(text, { status: source.status, statusText: source.statusText, headers });
  const bytes = new TextEncoder().encode(rewritePlaylistText(text, opt.targetUrl, opt.tab));
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('Range') || '');
  if (range && (range[1] !== '' || range[2] !== '')) {
    let start;
    let end;
    if (range[1] === '') { start = Math.max(0, bytes.length - Number(range[2])); end = bytes.length - 1; }
    else { start = Number(range[1]); end = range[2] === '' ? bytes.length - 1 : Math.min(Number(range[2]), bytes.length - 1); }
    if (start >= bytes.length || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + bytes.length } });
    headers.set('Content-Range', 'bytes ' + start + '-' + end + '/' + bytes.length);
    return new Response(bytes.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
  }
  return new Response(bytes, { status: 200, statusText: source.statusText, headers });
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
  // Privileged API endpoints must resolve a tab from an explicit signal (?tab=, Referer context, or clientContext).
  if (url.pathname === '/zp/api/diag/trace') {
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
    const filter = url.searchParams.get('filter') || '';
    const rawMatches = filter
      ? ring.filter(l => l.includes(filter)).slice(-50)
      : [];
    let namedGroups = '';
    try {
      if (self.ZPKernel && typeof self.ZPKernel.kernelLastNamedGroups === 'function') {
        namedGroups = self.ZPKernel.kernelLastNamedGroups();
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
  if (url.pathname === '/zp/api/fetch' || url.pathname === ZP.apiPath('v2/fetch')) {
    // GET ?url=<absolute> serves rewritten CSS url(...) / @import subresources and iframe navigations (v1 only).
    const ctx = contextFor(req, clientId);
    if (req.method === 'GET') {
      if (url.pathname !== ZP.apiPath('fetch')) return safeError('POLICY_BLOCKED', 405);
      const target = url.searchParams.get('url');
      if (!target) return safeError('MALFORMED_ROUTE', 400);
      const explicitTab = url.searchParams.get('tab') && tabs.get(url.searchParams.get('tab'));
      const tab = explicitTab || (ctx && tabs.get(ctx.tabId));
      if (!tab) return safeError('SW_NOT_READY', 503, target || req.url);
      // Allocate a dedicated entry and bind clientId for iframe/document navigations so subresources resolve against the frame's target URL.
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
        const isFrameRequest = req.destination === 'iframe'
          || req.destination === 'frame'
          || req.headers.get('Sec-Fetch-Dest') === 'iframe'
          || req.headers.get('Sec-Fetch-Dest') === 'frame';
        let canonical = target;
        try { canonical = ZP.canonicalTargetURL(target).href; } catch {}
        entryId = randomEntryId();
        entry = { entryId, targetUrl: canonical, baseUrl: canonical, title: '', stateClone: null, scrollX: 0, scrollY: 0, createdAt: Date.now(), frameRoute: isFrameRequest };
        tab.entries.set(entryId, entry);
        if (!isFrameRequest || !tab.activeEntryId) tab.activeEntryId = entryId;
        bindClientContext(clientId, tab, entry);
        scheduleStateFlush();
      } else {
        entryId = (ctx && ctx.entryId) || (explicitTab && explicitTab.activeEntryId) || tab.activeEntryId;
        entry = tab.entries.get(entryId);
      }
      rememberResourceContext(url, target, { tabId: tab.tabId, entryId, targetUrl: target, baseUrl: target });
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
      const elementCors = isDocumentRequest ? null : elementCorsOptions(req, entry);
      const mediaRequest = !isDocumentRequest && !isScriptRequest && isMediaElementRequest(req);
      const resp = await transportFetch(target, Object.assign({ request: req, method: 'GET', headers: accept, tab, entryId, document: isDocumentRequest, noRange: mediaRequest && isPlaylistTarget(req, target) }, elementCors));
      if (elementCors && resp.type === 'error') return resp;
      if (isDocumentRequest && entry) return transformDocumentResponse(resp, { tab, entry });
      if (mediaRequest && isPlaylistResponse(resp, target)) {
        return rewritePlaylistResponse(req, resp, {
          targetUrl: target, tab,
          refetch: () => transportFetch(target, Object.assign({ request: req, method: 'GET', headers: accept, tab, entryId, document: false, noRange: true }, elementCors)),
        });
      }
      if (isScriptRequest) return rewriteScriptResponse(resp, { targetUrl: target, kind: scriptKindFromRequest(req), req });
      return shouldRewriteCSS(req, resp) ? rewriteCSSResponse(resp, { targetUrl: target }) : resp;
    }
    if (req.method !== 'POST') return safeError('POLICY_BLOCKED', 405);
    // v2 uses a binary envelope ([u32le headLen][JSON head][raw body]) instead of base64-in-JSON.
    const isV2 = url.pathname === ZP.apiPath('v2/fetch');
    let payload, bodyBytes;
    if (isV2) {
      try { const env = ZP.decodeEnvelope(await req.arrayBuffer()); payload = env.head; bodyBytes = env.body.length ? env.body : null; }
      catch { return safeError('MALFORMED_ROUTE', 400); }
    } else {
      payload = await req.json();
      bodyBytes = payload.init && payload.init.body != null ? ZP.base64UrlToBytes(payload.init.body) : null;
    }
    const explicitTab = payload.tabId && tabs.get(payload.tabId);
    if (explicitTab && ctx && explicitTab.tabId !== ctx.tabId) return Response.error();
    const tab = explicitTab || (ctx && tabs.get(ctx.tabId));
    if (!tab) return safeError('SW_NOT_READY', 503, req.url);
    const init = payload.init || {};
    const entryId = tab.entries.has(payload.entryId) ? payload.entryId : (ctx && ctx.entryId) || tab.activeEntryId;
    const resp = await transportFetch(payload.url, {
      method: init.method || 'GET', headers: init.headers || [],
      body: bodyBytes,
      tab, entryId, runtimeFetch: true, refOverride: payload.documentURL, opaqueOrigin: !!payload.opaque,
      implicitHeaders: Array.isArray(payload.implicitHeaders) ? payload.implicitHeaders.map(h => String(h).toLowerCase()) : undefined,
      credentials: init.credentials || 'same-origin', mode: init.mode || 'cors',
      redirect: init.redirect || 'follow', referrer: init.referrer,
      referrerPolicy: init.referrerPolicy || '',
    });
    // Encode network/CORS errors in X-ZP-Fetch-Meta so the page rejects fetch() without treating the SW endpoint as unreachable.
    if (resp.type === 'error') return new Response(null, { status: 200, headers: { 'X-ZP-Fetch-Meta': JSON.stringify({ type: 'error' }) } });
    const headers = new Headers(resp.headers);
    corsFilterHeaders(headers, resp.__zpFetchMeta && resp.__zpFetchMeta.expose);
    headers.set('X-ZP-Fetch-Meta', JSON.stringify(resp.__zpFetchMeta || { url: payload.url, type: 'basic', redirected: false }));
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
  }
  if (url.pathname === '/zp/api/script') {
    if (req.method !== 'GET') return safeError('POLICY_BLOCKED', 405);
    const target = url.searchParams.get('u');
    // Prefer the page-supplied `ref` parameter over `entry.baseUrl`, which may not yet reflect a same-tick `history.replaceState` call.
    const refOverride = url.searchParams.get('ref') || '';
    const kind = url.searchParams.get('kind') || 'classic';
    const scriptCtx = contextFor(req, clientId);
    const explicitTab = url.searchParams.get('tab') && tabs.get(url.searchParams.get('tab'));
    const tab = explicitTab || (scriptCtx && tabs.get(scriptCtx.tabId));
    if (!target || !tab) return safeError('SW_NOT_READY', 503, target || req.url);
    {
    }
    // Bind `srcdoc` frames to their entry on their first script request via the `entry` query parameter.
    const urlEntry = explicitTab && url.searchParams.get('entry');
    const namedEntry = urlEntry && explicitTab.entries.get(urlEntry);
    if (!scriptCtx && namedEntry && clientId) bindClientContext(clientId, explicitTab, namedEntry);
    const scriptEntryId = (scriptCtx && scriptCtx.entryId) || (namedEntry && urlEntry) || tab.activeEntryId;
    const elementCors = elementCorsOptions(req, tab.entries.get(scriptEntryId));
    const resp = await transportFetch(target, Object.assign({ request: req, tab, entryId: scriptEntryId, refOverride }, elementCors));
    if (elementCors && resp.type === 'error') return resp;
    return rewriteScriptResponse(resp, { targetUrl: target, kind, req });
  }
  if (url.pathname === '/zp/api/worker-script') {
    const target = url.searchParams.get('u');
    const explicitTab = url.searchParams.get('tab') && tabs.get(url.searchParams.get('tab'));
    const ctx = contextFor(req, clientId);
    const tab = explicitTab || (ctx && tabs.get(ctx.tabId));
    if (!target || !tab) return safeError('SW_NOT_READY', 503, target || req.url);
    const kind = url.searchParams.get('kind') === 'module' ? 'module' : 'worker';
    const wsEntryId = (ctx && ctx.entryId) || tab.activeEntryId;
    // Bind the worker client to the tab so subsequent module dependency fetches resolve their client context.
    bindClientContext(clientId, tab, tab.entries.get(wsEntryId) || { entryId: wsEntryId, targetUrl: target, baseUrl: target });
    // Serve stashed `blob:`/`data:` worker sources from `workerSrcStash` when `srctok` is present.
    const srcTok = url.searchParams.get('srctok');
    let upstream;
    if (srcTok) {
      const stashed = workerSrcStash.get(srcTok);
      workerSrcStash.delete(srcTok);
      upstream = stashed == null ? null : new Response(stashed, { status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
    } else {
      // Supply worker fetch metadata explicitly because the bootstrap request originates from inside the worker.
      let workerDest = 'worker';
      try { const client = clientId && await self.clients.get(clientId); if (client && client.type === 'sharedworker') workerDest = 'sharedworker'; } catch {}
      upstream = await transportFetch(target, { method: 'GET', headers: [['Accept', 'text/javascript,*/*']], tab, entryId: wsEntryId, fetchMeta: { mode: 'same-origin', dest: workerDest } });
    }
    if (!upstream) return safeError('SW_NOT_READY', 503, req.url);
    const rewritten = await rewriteScriptResponse(upstream, { targetUrl: target, kind, req });
    return rewritten;
  }
  if (url.pathname === ZP.apiPath('sourcemap')) {
    // Serve composed Source Map v3 JSON for a rewritten script.
    const target = url.searchParams.get('u') || '';
    const kind = url.searchParams.get('k') || 'classic';
    if (!target) return safeError('POLICY_BLOCKED', 400);
    const ctx = contextFor(req, clientId);
    const tab = ctx && tabs.get(ctx.tabId);
    if (!tab) return safeError('SW_NOT_READY', 503, req.url);
    try {
      await initBundle();
      if (!self.ZPBundle || !self.ZPBundle.ready || typeof self.ZPBundle.composeSourceMap !== 'function') {
        return safeError('SW_NOT_READY', 503, req.url);
      }
      const upstream = await transportFetch(target, { method: 'GET', headers: [['Accept', 'text/javascript,*/*']], tab, entryId: (ctx && ctx.entryId) || tab.activeEntryId });
      if (!upstream || upstream.status >= 400) return safeError('TARGET_HTTP_FAILED', 502, target);
      const source = (await decodeResponseText(upstream, false)).text;
      // Chain with the upstream source map when available, falling back to the unchained rewriter map.
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
  // Log unmatched /zp/api/* requests with Referer and destination to identify relative URL leaks from rewritten scripts.
  try {
    (self.__zpRustTrace = self.__zpRustTrace || []).push(
      `sw:api-404 path=${url.pathname} dest=${req.destination || '?'} mode=${req.mode || '?'} ref=${String(req.headers.get('Referer') || '').slice(-120)}`
    );
  } catch {}
  return safeError('POLICY_BLOCKED', 404);
}

// Resolve and fetch the script's original sourceMappingURL pragma (or decode an inline data: URI), returning '' on failure.
async function fetchOriginalSourceMap(source, target, tab) {
  // Last pragma wins per Source Map v3 section A.3.
  const re = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)/g;
  let m, last = null;
  while ((m = re.exec(source))) last = m[1];
  if (!last) return '';
  if (last.startsWith('data:')) {
    try {
      const comma = last.indexOf(',');
      if (comma < 0) return '';
      const meta = last.slice(5, comma);
      const payload = last.slice(comma + 1);
      const isBase64 = /;\s*base64\b/i.test(meta);
      const decoded = isBase64 ? atob(payload) : decodeURIComponent(payload);
      if (!decoded.trimStart().startsWith('{')) return '';
      return decoded;
    } catch { return ''; }
  }
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

const NAVER_AD_BID_STUB_HOSTS = new Set([]);

const NAVER_IMAGE_STUB_PATHS = [];

const NAVER_AD_MODULE_STUB_PATTERNS = [];
const TRANSPARENT_PNG_BYTES = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII='),
  c => c.charCodeAt(0)
);

const RESPONSE_CACHE_NAME = 'zp-resp-v1';
const STATIC_ASSET_EXT_RE = /\.(?:js|css|png|jpg|jpeg|gif|svg|webp|woff2?|ttf|otf|ico|mp3|mp4|wasm)(?:\?|$)/i;

async function tryRespCacheGet(url) {
  try {
    const c = await caches.open(RESPONSE_CACHE_NAME);
    const r = await c.match(url);
    return r || null;
  } catch { return null; }
}
async function tryRespCachePut(url, response) {
  try {
    const c = await caches.open(RESPONSE_CACHE_NAME);
    await c.put(url, response);
  } catch {}
}

// Compute the outgoing `Referer` header value according to the active `Referrer-Policy`.
function refererForPolicy(base, targetUrl, policy) {
  let b, tgt;
  try { b = new URL(base); tgt = new URL(targetUrl); } catch { return ''; }
  if (b.protocol !== 'http:' && b.protocol !== 'https:') return '';
  const sameOrigin = b.origin === tgt.origin;
  const downgrade = b.protocol === 'https:' && tgt.protocol === 'http:';
  // Strip credentials and fragment identifiers before emitting a `Referer` URL.
  const full = () => { try { const c = new URL(b.href); c.username = ''; c.password = ''; c.hash = ''; return c.href; } catch { return ''; } };
  const originOnly = () => b.origin + '/';
  switch (String(policy || '').toLowerCase()) {
    case 'no-referrer': return '';
    case 'unsafe-url': return full();
    case 'origin': return originOnly();
    case 'origin-when-cross-origin': return sameOrigin ? full() : originOnly();
    case 'same-origin': return sameOrigin ? full() : '';
    case 'strict-origin': return downgrade ? '' : originOnly();
    case 'no-referrer-when-downgrade': return downgrade ? '' : full();
    case 'strict-origin-when-cross-origin':
    default:
      if (downgrade) return '';
      return sameOrigin ? full() : originOnly();
  }
}
// Bound upstream transport requests with an overall deadline so stalled origins do not hang indefinitely.
const TRANSPORT_DEADLINE_MS = 90000;
function withTransportDeadline(promise, targetUrl, method) {
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('TARGET_CONNECT_FAILED: transport deadline ' + TRANSPORT_DEADLINE_MS + 'ms');
      e.zpTransportTimeout = true;
      logRefusal('TRANSPORT_DEADLINE', 504, targetUrl, { method: String(method || '') });
      reject(e);
    }, TRANSPORT_DEADLINE_MS);
  });
  return Promise.race([promise, deadline]).finally(() => { if (timer !== null) clearTimeout(timer); });
}

function navigationDestination(req) {
  try {
    const d = req && req.destination;
    if (d === 'iframe' || d === 'frame' || d === 'embed' || d === 'object') return d;
  } catch {}
  return 'document';
}

// Compute Sec-Fetch-Mode and Sec-Fetch-Dest for element loads vs runtime fetch()/XHR calls.
function subrequestFetchMetadata(opt) {
  if (opt.fetchMeta) return opt.fetchMeta;
  if (!opt.runtimeFetch && opt.request) {
    let dest = '';
    let mode = '';
    try { dest = opt.request.destination || ''; mode = opt.request.mode || ''; } catch {}
    if (opt.elementCors) mode = 'cors';
    if (mode !== 'no-cors' && mode !== 'cors' && mode !== 'same-origin') mode = 'cors';
    return { mode, dest: dest || 'empty' };
  }
  const mode = opt.mode === 'no-cors' || opt.mode === 'same-origin' ? opt.mode : 'cors';
  return { mode, dest: 'empty' };
}

function subrequestCredentials(opt) {
  if (!opt.runtimeFetch && opt.request && !opt.fetchMeta && !opt.elementCors) {
    try { return opt.request.credentials || 'same-origin'; } catch {}
  }
  return opt.credentials || 'same-origin';
}

// Compute schemeful Sec-Fetch-Site relation between initiatorUrl and targetUrl.
function fetchSiteRelation(initiatorUrl, targetUrl) {
  try {
    const a = new URL(initiatorUrl);
    const b = new URL(targetUrl);
    if (a.origin === b.origin) return 'same-origin';
    if (a.protocol === b.protocol && registrableDomain(a.hostname) === registrableDomain(b.hostname)) return 'same-site';
  } catch {}
  return 'cross-site';
}

function referrerFromBrowserHeader(req) {
  try {
    // Read `req.referrer` first because `Referer` is a forbidden header on navigation `Request` objects, and map proxy share routes back to their target URL.
    let ref = '';
    try { const r = req && req.referrer; if (r && r !== 'about:client') ref = r; } catch {}
    if (!ref) { try { ref = (req && req.headers && req.headers.get('Referer')) || ''; } catch {} }
    if (!ref) return '';
    const u = new URL(ref);
    if (u.origin !== ORIGIN) return ref;
    const ctx = contextFromURL(u);
    return (ctx && (ctx.baseUrl || ctx.targetUrl)) || '';
  } catch { return ''; }
}

async function transportFetch(targetUrl, opt) {
  let target;
  try { target = ZP.canonicalTargetURL(targetUrl).href; }
  catch (e) { return safeError(e.code || 'TARGET_PROTOCOL_BLOCKED', 403, targetUrl); }
  const entryId = opt.entryId || opt.tab.activeEntryId;
  const entry = opt.tab.entries && opt.tab.entries.get(entryId);
  const documentUrl = entry && entry.targetUrl || target;
  let referrer = opt.document ? (entry && entry.parentTargetUrl || referrerFromBrowserHeader(opt.request)) : documentUrl;
  if (opt.submitReferrer) referrer = opt.submitReferrer;
  else if (opt.refOverride) {
    try {
      const proposed = new URL(opt.refOverride);
      if (proposed.origin === new URL(documentUrl).origin) referrer = proposed.href;
    } catch {}
  }
  // A submitted form's entry is made for the address it posts to, but the request's origin is the submitting document's: that is the
  // `Origin` header a cross-origin form carries.
  const initiatorOrigin = opt.submitReferrer ? new URL(opt.submitReferrer).origin : new URL(documentUrl).origin;
  const context = Object.freeze({
    entryId, documentUrl, origin: opt.opaqueOrigin ? 'null' : initiatorOrigin, referrer,
    // A site frame's first request comes from its own launcher page, whose policy says nothing about the embedder's.
    referrerPolicy: opt.document && entry && entry.siteFrame ? entry.siteFrame.referrerPolicy : (opt.referrerPolicy || (opt.request && opt.request.referrerPolicy) || (entry && entry.referrerPolicy) || ''),
  });
  const method = String(opt.method || (opt.request && opt.request.method) || 'GET');
  let body = null;
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      const input = opt.body != null ? opt.body : opt.request ? await opt.request.clone().arrayBuffer() : null;
      if (input != null) {
        if (input instanceof ArrayBuffer) body = new Uint8Array(input);
        else if (ArrayBuffer.isView(input)) body = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        else if (typeof input.arrayBuffer === 'function') body = new Uint8Array(await input.arrayBuffer());
        else return Response.error();
        if (body.byteLength > MAX_REQUEST_BODY_BYTES) return safeError('REQUEST_BODY_TOO_LARGE', 413, target);
        // The kernel consumes an ArrayBuffer; do not expose bytes outside a view.
        if (body.byteOffset !== 0 || body.byteLength !== body.buffer.byteLength) body = body.slice();
      }
    } catch { return Response.error(); }
  }
  const state = Object.assign({}, opt, {
    entryId, context, method, body,
    headers: new Headers(opt.headers || (opt.request && opt.request.headers) || undefined),
    credentials: opt.credentials || 'include', redirect: opt.redirect || 'follow',
    redirectDepth: 0,
    // Subresource requests from an opaque document are cross-site and only send/store SameSite=None cookies.
    initiatorOpaque: !!(opt.opaqueOrigin || (entry && entry.opaque)) && !opt.document,
    // Collect Set-Cookie deltas across redirect hops so the page's document.cookie snapshot updates before fetch/XHR resolves.
    cookieDelta: opt.runtimeFetch || opt.collectCookies ? [] : null,
  });
  return transportFetchHop(target, state);
}

async function transportFetchHop(targetUrl, opt) {
  let u;
  try { u = ZP.canonicalTargetURL(targetUrl).href; } catch (e) { return safeError(e.code || 'TARGET_PROTOCOL_BLOCKED', 403, targetUrl); }
  if (opt.mode === 'same-origin' && new URL(u).origin !== opt.context.origin) return Response.error();
  const txMethod = opt.method || (opt.request && opt.request.method) || 'GET';
  let urlParts = null;
  try {
    urlParts = new URL(u);
    const stubHost = urlParts.host;
    if (NAVER_AD_BID_STUB_HOSTS.has(stubHost)) {
      const isScript = stubHost === 'ntm.pstatic.net';
      const stubBody = isScript ? '/* zp:stub */' : '{}';
      const stubCType = isScript ? 'application/javascript; charset=utf-8' : 'application/json; charset=utf-8';
      logTransportEvent(u, txMethod, 200, 0, stubBody.length);
      return new Response(stubBody, {
        status: 200,
        headers: { 'Content-Type': stubCType, 'Cache-Control': 'no-store', 'Content-Security-Policy': ZP.fixedCSP() },
      });
    }
    for (const { host, pathPrefix } of NAVER_IMAGE_STUB_PATHS) {
      if (urlParts.host === host && urlParts.pathname.startsWith(pathPrefix)) {
        logTransportEvent(u, txMethod, 200, 0, TRANSPARENT_PNG_BYTES.byteLength);
        return new Response(TRANSPARENT_PNG_BYTES, {
          status: 200,
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Security-Policy': ZP.fixedCSP() },
        });
      }
    }
    if (urlParts.host === 'ssl.pstatic.net') {
      for (const re of NAVER_AD_MODULE_STUB_PATTERNS) {
        if (re.test(urlParts.pathname)) {
          const modBody =
            'const noop=function(){};' +
            'const h={get:(_,p)=>p==="prototype"?noop.prototype:stub,apply:()=>stub,construct:()=>stub};' +
            'const stub=new Proxy(noop,h);' +
            'export default stub;';
          logTransportEvent(u, txMethod, 200, 0, modBody.length);
          return new Response(modBody, {
            status: 200,
            headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': ZP.fixedCSP() },
          });
        }
      }
    }
  } catch {}
  try { await initKernel(); } catch { return safeError('SW_NOT_READY', 503, u); }
  if (typeof self.kernelFetch !== 'function') return safeError('SW_NOT_READY', 503, u);
  // Taint cross-origin CORS requests and run preflight when method or headers are not CORS-safelisted.
  const corsMode = !!((opt.runtimeFetch || opt.elementCors) && opt.mode === 'cors');
  const corsRequest = corsMode && !opt.preflight;
  const corsOrigin = opt.originTainted ? 'null' : opt.context.origin;
  const corsCredentials = opt.credentials === 'include';
  if (corsRequest) {
    if (new URL(u).origin !== opt.context.origin) opt.tainted = true;
    if (opt.tainted && !opt.elementCors) {
      const unsafeNames = corsUnsafeHeaderNames(opt.headers, opt.implicitHeaders);
      if ((!corsSafelistedMethod(txMethod) || unsafeNames.length)
          && !(await runCORSPreflight(u, opt, txMethod, unsafeNames, corsOrigin, corsCredentials))) {
        logRefusal('CORS_PREFLIGHT_FAILED', 0, u, { method: txMethod, origin: corsOrigin, headers: unsafeNames.join(',') });
        return Response.error();
      }
    }
  }
  const headers = new Headers(opt.headers || (opt.request && opt.request.headers) || undefined);
  // Smuggle forbidden headers (Referer, Origin) via X-ZP-* so the kernel/relay can promote them to real upstream headers.
  const context = opt.context;
  let effectiveBase = context.referrer;
  if (opt.referrer === '') effectiveBase = '';
  else if (opt.referrer && opt.referrer !== 'about:client') {
    try {
      const explicit = new URL(opt.referrer);
      if (explicit.origin === context.origin) effectiveBase = explicit.href;
    } catch {}
  }
  headers.delete('X-ZP-Referer');
  headers.delete('X-ZP-Origin');
  let sentReferer = '';
  if (effectiveBase) {
    const referrerPolicy = context.referrerPolicy;
    const refValue = refererForPolicy(effectiveBase, u, referrerPolicy);
    if (refValue) headers.set('X-ZP-Referer', refValue);
    sentReferer = refValue || '';
  }
  // Record the Referer sent on the final hop so document.referrer matches what upstream received.
  if (opt.document) {
    const docEntry = opt.tab && opt.tab.entries && opt.tab.entries.get(opt.entryId);
    if (docEntry) docEntry.documentReferrer = sentReferer;
  }
  // Emit Origin on non-GET/HEAD requests, CORS-mode element loads, and cross-origin CORS fetches.
  if ((opt.method !== 'GET' && opt.method !== 'HEAD')
       || (corsMode && (opt.originTainted || opt.elementCors || new URL(u).origin !== context.origin))) {
    headers.set('X-ZP-Origin', opt.originTainted ? 'null' : context.origin);
  }
  for (const name of ['Referer', 'Origin']) {
    const v = headers.get(name);
    if (v && v.includes(ORIGIN)) headers.delete(name);
  }
  headers.set('X-ZP-Tab-Id', opt.tab.tabId);
  headers.set('X-ZP-Entry-Id', context.entryId || '');
  headers.set('X-ZP-Stream-Isolation-Key', opt.tab.streamIsolationKey);
  headers.set('X-ZP-Runtime-Token', opt.tab.runtimeToken || '');
  headers.set('X-ZP-Relay-Servers', JSON.stringify(opt.tab.servers || []));
  if (opt.document) headers.set('X-ZP-Document-Request', '1');
  if (opt.tab.challengeCompat) headers.set('X-ZP-Arm-Challenge-Compat', '1');
  // Attach RFC 6265-scoped cookies from tab.cookieJar when credentials mode permits.
  const credentialsAllowed = opt.credentials === 'include'
    || (opt.credentials === 'same-origin' && new URL(u).origin === context.origin);
  headers.delete('Cookie');
  if (credentialsAllowed && opt.tab.cookieJar) {
    const cookieStr = opt.tab.cookieJar.cookieHeader(u, { crossSite: opt.initiatorOpaque });
    if (cookieStr) headers.set('Cookie', cookieStr);
  }
  // Build a flat [name, value] list without constructing a Request object so forbidden headers (Sec-Fetch-*, sec-ch-ua-*, User-Agent) survive.
  const headerEntries = [];
  const seen = new Set();
  const trustworthy = potentiallyTrustworthyURL(u);
  const pushOnce = (k, v, own) => {
    const kl = k.toLowerCase();
    if (seen.has(kl)) return;
    if (!own && BROWSER_CLIENT_HINTS.has(kl)) return;
    if (!trustworthy && kl.startsWith('sec-fetch-')) return;
    seen.add(kl);
    headerEntries.push([k, v]);
  };
  // Force-set the target persona User-Agent first so HeadlessChrome or host-browser UA strings from request.headers are ignored.
  pushOnce('user-agent', ZP.TARGET_USER_AGENT);
  for (const [k, v] of headers.entries()) {
    if (opt.noRange && (k.toLowerCase() === 'range' || k.toLowerCase() === 'if-range')) continue;
    pushOnce(k, v);
  }
  // Copy browser-supplied headers (Sec-Fetch-*, Accept-Language, Upgrade-Insecure-Requests) from the initial intercepted request.
  if (opt.redirectDepth === 0 && opt.request && opt.request.headers) {
    for (const [k, v] of opt.request.headers.entries()) {
      const kl = k.toLowerCase();
      if (kl === 'cookie' || kl === 'host' || kl === 'origin' || kl === 'referer'
          || kl === 'user-agent' || kl === 'accept-encoding'
          || kl === 'connection' || kl === 'content-length' || kl === 'transfer-encoding') {
        continue;
      }
      if (opt.noRange && (kl === 'range' || kl === 'if-range')) continue;
      pushOnce(k, v);
    }
  }
  // Synthesize Sec-Fetch-* metadata, Accept-Language, and Priority when omitted on the incoming request.
  const navDest = opt.document ? navigationDestination(opt.request) : 'document';
  const inFrame = navDest !== 'document';
  const sub = opt.document ? null : subrequestFetchMetadata(opt);
  if (!seen.has('sec-fetch-mode')) pushOnce('sec-fetch-mode', opt.document ? 'navigate' : sub.mode);
  if (!seen.has('sec-fetch-dest')) pushOnce('sec-fetch-dest', opt.document ? navDest : sub.dest);
  if (!seen.has('sec-fetch-site')) {
    let site = 'cross-site';
    if (opt.document) site = context.referrer ? fetchSiteRelation(context.referrer, u) : (inFrame ? 'cross-site' : 'none');
    else if (!opt.initiatorOpaque) site = fetchSiteRelation(context.documentUrl, u);
    pushOnce('sec-fetch-site', site);
    if (site === 'cross-site' && (opt.document ? inFrame : subrequestCredentials(opt) === 'include')) pushOnce('sec-fetch-storage-access', 'active');
  }
  if (opt.document && !inFrame && !seen.has('sec-fetch-user')) pushOnce('sec-fetch-user', '?1');
  if (!seen.has('accept-language')) pushOnce('accept-language', browserAcceptLanguage());
  if (opt.document && !seen.has('priority')) pushOnce('priority', 'u=0, i');
  if (!opt.document && opt.runtimeFetch && !seen.has('accept')) pushOnce('accept', '*/*');
  pushOnce('user-agent', ZP.TARGET_USER_AGENT);
  const sentHints = trustworthy
    ? [...CLIENT_HINT_DEFAULTS, ...highEntropyHintsFor(opt, u, opt.document && !inFrame, inFrame)]
    : [];
  const hintEnv = opt.tab && opt.tab.clientEnv;
  for (const name of sentHints) {
    const v = clientHintValue(name, hintEnv);
    if (v !== null) pushOnce(name, v, true);
  }
  // Order headers according to Chrome's wire template and pass the order list to the kernel via X-ZP-Header-Order.
  const template = requestHeaderTemplate(opt.document ? (opt.criticalRestart ? 'critical-restart' : 'navigation') : 'sub',
    sentHints.filter(n => seen.has(n)));
  const ordered = orderRequestHeaders(headerEntries, template);
  headerEntries.length = 0;
  headerEntries.push(...ordered.sorted);
  headerEntries.push(['X-ZP-Header-Order', ordered.order.filter(n => !n.startsWith('x-zp-')).join(',')]);
  const method = opt.method;
  const bodyU8 = opt.body;
  const outgoing = logOutgoingHeaders(u, method, headerEntries);
  const reqLike = {
    url: u,
    method,
    headerEntries,
    arrayBuffer: () => Promise.resolve(bodyU8 ? bodyU8.buffer : new ArrayBuffer(0)),
  };
  let resp;
  const txT0 = performance.now();
  try {
    resp = await withTransportDeadline(self.kernelFetch(reqLike), u, method);
  } catch (e) {
    logTransportEvent(u, method, 0, performance.now() - txT0, 0);
    try {
      const reason = (e && (e.message || e.code)) || String(e);
      (self.__zpRustTrace = self.__zpRustTrace || []).push(
        `sw:transport-fail ${method} ${String(u).slice(0, 120)} after=${Math.round(performance.now() - txT0)}ms err=${reason}`
      );
    } catch {}
    // Return a network error for runtime fetch()/XHR so the caller rejects instead of receiving a synthetic 502 HTML page.
    if (opt.runtimeFetch) {
      logRefusal(e && (e.message || e.code) || 'TARGET_CONNECT_FAILED', 0, u, { runtimeFetch: true, timeout: !!(e && e.zpTransportTimeout) });
      return Response.error();
    }
    // Distinguish connection failures (502) from upstream transport timeouts (504).
    if (e && e.zpTransportTimeout) return safeError(e.message, 504, u);
    return safeError(e && (e.message || e.code) || 'TARGET_CONNECT_FAILED', 502, u);
  }
  let bodyLen = 0;
  try {
    const cl = resp && resp.headers && resp.headers.get('content-length');
    if (cl) bodyLen = parseInt(cl, 10) || 0;
  } catch {}
  logTransportEvent(u, method, (resp && resp.status) || 0, performance.now() - txT0, bodyLen);
  outgoing.status = (resp && resp.status) || 0;
  // Capture response Set-Cookie headers (and X-ZP-Set-Cookie sidechannel lines) into the RFC 6265 cookie jar scoped to this hop's URL.
  try {
    const getSetCookie = resp && resp.headers && resp.headers.getSetCookie;
    const setCookies = typeof getSetCookie === 'function' ? resp.headers.getSetCookie() : (resp && resp.headers && resp.headers.get('set-cookie') ? [resp.headers.get('set-cookie')] : []);
    if (credentialsAllowed && opt.tab.cookieJar) {
      const noteForPage = change => { if (opt.cookieDelta && change && !change.httpOnly) opt.cookieDelta.push(change); };
      const setMeta = opt.initiatorOpaque ? { crossSite: true } : undefined;
      for (const line of setCookies) noteForPage(opt.tab.cookieJar.setCookieLine(u, line, setMeta));
      const sidechannel = resp.headers.get('X-ZP-Set-Cookie');
      if (sidechannel) {
        for (const line of sidechannel.split('\t')) {
          if (line) noteForPage(opt.tab.cookieJar.setCookieLine(u, line, setMeta));
        }
      }
    }
  } catch {}
  if (opt.preflight) return resp;
  // Update per-origin Accept-CH preferences on top-level navigations and reissue once if Critical-CH names missing hints.
  if (opt.document && !inFrame && resp && resp.headers && potentiallyTrustworthyURL(u)) {
    let hintOrigin = '';
    try { hintOrigin = new URL(u).origin; } catch {}
    const acceptCH = resp.headers.get('accept-ch');
    if (hintOrigin && acceptCH !== null) clientHintPrefs.set(hintOrigin, parseClientHintList(acceptCH));
    const criticalCH = resp.headers.get('critical-ch');
    const redirecting = [301, 302, 303, 307, 308].includes(resp.status) && resp.headers.get('Location');
    if (hintOrigin && criticalCH && !opt.criticalRestart && !redirecting) {
      const prefs = clientHintPrefs.get(hintOrigin) || new Set();
      const missing = [...parseClientHintList(criticalCH)]
        .filter(n => prefs.has(n) && !sentHints.includes(n) && clientHintValue(n, hintEnv) !== null);
      if (missing.length) {
        if (resp.body) resp.body.cancel().catch(() => {});
        return transportFetchHop(u, Object.assign({}, opt, { criticalRestart: true }));
      }
    }
  }
  if (corsRequest && opt.tainted && resp && !corsCheck(resp.headers, corsOrigin, corsCredentials)) {
    if (resp.body) resp.body.cancel().catch(() => {});
    logRefusal('CORS_CHECK_FAILED', resp.status, u, { method: txMethod, origin: corsOrigin, credentials: corsCredentials, allow: resp.headers.get('access-control-allow-origin') });
    return Response.error();
  }
  const location = resp && resp.headers.get('Location');
  if (location && [301, 302, 303, 307, 308].includes(resp.status)) {
    if (resp.body) resp.body.cancel().catch(() => {});
    if (opt.redirect === 'error') return Response.error();
    if (opt.redirect === 'manual') {
      const opaque = new Response(null, { status: 204 });
      opaque.__zpFetchMeta = { type: 'opaqueredirect', url: targetUrl, redirected: false, cookies: opt.cookieDelta && opt.cookieDelta.length ? opt.cookieDelta : undefined };
      return opaque;
    }
    if (opt.redirectDepth >= 20) return opt.runtimeFetch ? Response.error() : safeError('REDIRECT_LIMIT_EXCEEDED', 508, targetUrl);
    let nextURL, rawNext;
    try { rawNext = new URL(location, u); nextURL = ZP.canonicalTargetURL(rawNext.href).href; }
    catch { return Response.error(); }
    const nextMethod = ZP.redirectMethod(resp.status, method);
    const nextHeaders = new Headers(opt.headers);
    if (nextMethod !== method) {
      for (const name of ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length']) nextHeaders.delete(name);
    }
    if (new URL(nextURL).origin !== new URL(u).origin) nextHeaders.delete('Authorization');
    const policy = resp.headers.get('Referrer-Policy');
    const nextContext = policy ? Object.freeze(Object.assign({}, context, { referrerPolicy: policy })) : context;
    let originTainted = !!opt.originTainted;
    if (corsRequest) {
      const from = new URL(u).origin;
      const next = new URL(nextURL);
      // Reject cross-origin redirects carrying URL credentials, and taint Origin ('null') across two foreign origins.
      if (next.origin !== context.origin && (rawNext.username || rawNext.password)) {
        logRefusal('CORS_REDIRECT_CREDENTIALS', resp.status, nextURL, { method: txMethod, origin: corsOrigin });
        return Response.error();
      }
      if (next.origin !== from && from !== context.origin) originTainted = true;
    }
    return transportFetchHop(nextURL, Object.assign({}, opt, {
      method: nextMethod, body: nextMethod === method ? bodyU8 : null,
      headers: nextHeaders, context: nextContext, redirectDepth: opt.redirectDepth + 1,
      tainted: opt.tainted, originTainted,
    }));
  }
  // Commit navigation URL and top-level origin only after the final redirect hop.
  if (opt.document) {
    const entry = opt.tab.entries && opt.tab.entries.get(context.entryId);
    if (entry && entry.targetUrl === context.documentUrl) { entry.targetUrl = u; entry.baseUrl = u; }
    if (!inFrame) { try { opt.tab.topOrigin = new URL(u).origin; } catch {} }
    scheduleStateFlush();
  }
  const expose = corsRequest && opt.tainted ? corsExposedHeaders(resp.headers, corsCredentials) : undefined;
  const result = addCSP(resp, opt.request, opt.tab.servers, opt.tab, u);
  result.__zpFetchMeta = {
    url: u, redirected: opt.redirectDepth > 0,
    type: opt.mode === 'no-cors' && new URL(u).origin !== context.origin ? 'opaque' : expose ? 'cors' : 'basic',
    expose,
    cookies: opt.cookieDelta && opt.cookieDelta.length ? opt.cookieDelta : undefined,
  };
  return result;
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

// Apply a sorted, non-overlapping patch envelope produced by ZPBundle.rewriteScriptPatches over source, returning null if malformed.
function applyScriptPatches(source, envelopeJson) {
  if (typeof envelopeJson !== 'string' || envelopeJson.length === 0) return null;
  let env;
  try { env = JSON.parse(envelopeJson); } catch { return null; }
  if (!env || !Array.isArray(env.patches)) return null;
  const patches = env.patches;
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

function extractCharsetFromContentType(contentType) {
  if (!contentType) return '';
  const m = /;?\s*charset\s*=\s*["']?([^"';\s]+)/i.exec(String(contentType));
  return m ? m[1].trim() : '';
}
function extractCharsetFromHTMLBytes(bytes) {
  if (!bytes || !bytes.byteLength) return '';
  const headLen = Math.min(bytes.byteLength, 2048);
  let ascii = '';
  try {
    ascii = new TextDecoder('latin1').decode(bytes.subarray(0, headLen));
  } catch {
    for (let i = 0; i < headLen; i++) ascii += String.fromCharCode(bytes[i]);
  }
  const tagRe = /<meta\b[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(ascii))) {
    const tag = m[0];
    const direct = /\bcharset\s*=\s*["']?\s*([a-zA-Z0-9._-]+)/i.exec(tag);
    if (direct && direct[1]) return direct[1].trim();
    const content = /\bcontent\s*=\s*["']([^"']*charset\s*=\s*[^"']+)["']/i.exec(tag);
    if (content && content[1]) {
      const sub = /charset\s*=\s*([a-zA-Z0-9._-]+)/i.exec(content[1]);
      if (sub && sub[1]) return sub[1].trim();
    }
  }
  return '';
}
function isUtf8CharsetLabel(label) {
  if (!label) return true;
  const norm = String(label).trim().toLowerCase();
  return norm === 'utf-8' || norm === 'utf8' || norm === 'unicode-1-1-utf-8';
}
function decodeTextBytes(bytes, contentType, isHTML) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  let charset = extractCharsetFromContentType(contentType);
  if (!charset && isHTML) charset = extractCharsetFromHTMLBytes(u8);
  const nonUtf8 = Boolean(charset && !isUtf8CharsetLabel(charset));
  if (nonUtf8) {
    try {
      const dec = new TextDecoder(charset.trim().toLowerCase());
      return { text: dec.decode(u8), charset: charset.trim(), nonUtf8: true };
    } catch {}
  }
  return { text: new TextDecoder('utf-8').decode(u8), charset: 'utf-8', nonUtf8: false };
}
async function decodeResponseText(resp, isHTML) {
  const buf = await resp.arrayBuffer();
  const ct = (resp.headers && resp.headers.get('Content-Type')) || '';
  return decodeTextBytes(new Uint8Array(buf), ct, !!isHTML);
}
function rewriteMetaCharsetToUtf8(html) {
  if (!html) return html;
  return html.replace(/<meta\b[^>]*>/gi, tag => {
    if (/\bhttp-equiv\s*=\s*["']?content-type["']?/i.test(tag) && /\bcharset\s*=/i.test(tag)) {
      return tag.replace(/(charset\s*=\s*)([a-zA-Z0-9._-]+)/i, '$1utf-8');
    }
    if (/\bcharset\s*=\s*["']?[a-zA-Z0-9._-]+["']?/i.test(tag)) {
      return tag.replace(/(\bcharset\s*=\s*["']?)([a-zA-Z0-9._-]+)/i, '$1utf-8');
    }
    return tag;
  });
}

async function rewriteScriptResponse(resp, opt) {
  rewriteStats.invocations++;
  // Convert `safeError` HTML responses into `NetworkError` throws so the script rewriter does not mistake them for syntax errors and report a policy block.
  if (resp && resp.headers && resp.headers.get('X-ZP-Error') === '1') {
    const upstream = resp.headers.get('X-ZP-Error-Code') || 'TARGET_CONNECT_FAILED';
    const h = scriptResponseHeaders(resp, opt && opt.req);
    return new Response(
      'throw new DOMException(' + JSON.stringify('ZeroProxy: upstream fetch failed (' + upstream + ')') + ", 'NetworkError');",
      { status: resp.status, statusText: resp.statusText, headers: h }
    );
  }
  const h = scriptResponseHeaders(resp, opt && opt.req);
  let code = '';
  let cacheKey = '';
  try {
    const source = (await decodeResponseText(resp, false)).text;
    try {
      const keyT0 = performance.now();
      cacheKey = await rewriteCacheKey(opt.kind || 'classic', opt.targetUrl || '', source);
      rewriteStats.cacheKeyLatencyMs += performance.now() - keyT0;
      const cached = rewriteCacheGet(cacheKey);
      if (cached !== null) {
        rewriteStats.hits++;
        return new Response(cached, { status: resp.status, statusText: resp.statusText, headers: h });
      }
      rewriteStats.misses++;
    } catch { cacheKey = ''; rewriteStats.misses++; }
    try {
      await initBundle();
      if (self.ZPBundle && self.ZPBundle.ready) {
        const kind = opt.kind || 'classic';
        const target = opt.targetUrl || '';
        const rewriteT0 = performance.now();
        const rustCode = self.ZPBundle.rewriteScript(source, kind, target);
        rewriteStats.rewriteLatencyMs += performance.now() - rewriteT0;
        if (typeof rustCode === 'string' && rustCode.length > 0) {
          code = rustCode;
        } else if (rustCode === '' && source === '') {
          // Preserve empty script bodies as a no-op instead of treating empty output as a rewrite failure.
          code = '\n';
        }
      }
    } catch (rustErr) { /* fail-closed below */ }
    if (!code) {
      code = "throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');";
    } else {
      // Append a sourceMappingURL pointing to /zp/api/sourcemap for classic, module, and worker scripts.
      const kind = opt.kind || 'classic';
      const target = opt.targetUrl || '';
      if (target && (kind === 'classic' || kind === 'module' || kind === 'worker')) {
        const mapURL = ZP.apiPath('sourcemap') + '?u=' + encodeURIComponent(target) + '&k=' + encodeURIComponent(kind);
        code = code + '\n//# sourceMappingURL=' + mapURL + '\n';
      }
      if (cacheKey) {
        rewriteCacheSet(cacheKey, code);
      }
    }
  } catch {
    code = "throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');";
  }
  return new Response(code, { status: resp.status, statusText: resp.statusText, headers: h });
}
async function transformDocumentResponse(resp, opt) {
  await ensureRuntimeConfig();
  // Record the last valid `Referrer-Policy` token declared on the document response into `opt.entry`.
  try {
    const declared = resp.headers.get('Referrer-Policy');
    if (declared && opt && opt.entry) {
      const token = declared.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).pop();
      if (token) opt.entry.referrerPolicy = token;
    }
  } catch {}
  // Transform all non-3xx HTML responses (including 4xx/5xx challenge or error pages) except internal safeError pages.
  if (!resp || !isHTMLResponse(resp)) return resp;
  if (resp.status >= 300 && resp.status < 400) return resp;
  if (resp.headers && resp.headers.get('X-ZP-Error') === '1') return resp;

  const contentTypeHeader = (resp.headers && resp.headers.get('Content-Type')) || '';
  const headerCharset = extractCharsetFromContentType(contentTypeHeader);
  const nonUtf8Header = Boolean(headerCharset && !isUtf8CharsetLabel(headerCharset));
  let prefetchedBytes = null;

  // Pipe kernel-streamed UTF-8 HTML responses through HtmlTxn for progressive rendering unless redirected across hosts.
  const kernelStreamed = resp.headers && resp.headers.get('X-ZP-Stream') === '1';
  if (kernelStreamed && resp.body && !nonUtf8Header) {
    try {
      await initBundle();
      if (self.ZPBundle && self.ZPBundle.ready && typeof self.ZPBundle.HtmlTxn === 'function') {
        const targetUrl = (opt.entry && (opt.entry.targetUrl || opt.entry.baseUrl)) || '';
        const finalUrl = (resp.headers && resp.headers.get('X-ZP-Final-URL')) || '';
        let hostMismatch = false;
        if (finalUrl && targetUrl) {
          try { hostMismatch = new URL(targetUrl).host !== new URL(finalUrl).host; } catch {}
        }
        if (!hostMismatch) {
          if (headerCharset) {
            const streamed = streamDocumentResponse(resp, opt, targetUrl);
            if (streamed) return streamed;
          } else {
            const reader = resp.body.getReader();
            const first = await reader.read();
            const firstChunk = (!first.done && first.value) ? (first.value instanceof Uint8Array ? first.value : new Uint8Array(first.value)) : new Uint8Array(0);
            const metaCharset = extractCharsetFromHTMLBytes(firstChunk);
            if (metaCharset && !isUtf8CharsetLabel(metaCharset)) {
              const chunks = firstChunk.byteLength ? [firstChunk] : [];
              let total = firstChunk.byteLength;
              while (!first.done) {
                const next = await reader.read();
                if (next.done) break;
                const u8 = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
                chunks.push(u8);
                total += u8.byteLength;
              }
              prefetchedBytes = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) { prefetchedBytes.set(c, off); off += c.byteLength; }
            } else {
              const replayStream = new ReadableStream({
                start(controller) {
                  if (firstChunk.byteLength) controller.enqueue(firstChunk);
                  if (first.done) controller.close();
                },
                async pull(controller) {
                  try {
                    const next = await reader.read();
                    if (next.done) controller.close();
                    else controller.enqueue(next.value);
                  } catch (err) {
                    controller.error(err);
                  }
                },
                cancel(reason) {
                  try { return reader.cancel(reason); } catch {}
                },
              });
              const streamed = streamDocumentResponse(resp, opt, targetUrl, replayStream);
              if (streamed) return streamed;
              prefetchedBytes = new Uint8Array(await new Response(replayStream).arrayBuffer());
            }
          }
        }
      }
    } catch { /* fall through to buffered */ }
  }

  let html = '';
  try {
    const rawBytes = prefetchedBytes || new Uint8Array(await resp.arrayBuffer());
    const decoded = decodeTextBytes(rawBytes, contentTypeHeader, true);
    html = decoded.nonUtf8 ? rewriteMetaCharsetToUtf8(decoded.text) : decoded.text;
  } catch { return resp; }
  let transformed = html;
  // Fail-closed to MALFORMED_HTML if the HTML rewriter throws or produces empty output so un-rewritten inline scripts never execute.
  let transformOk = false;
  let transformFailure = '';
  try {
    await initBundle();
    if (self.ZPBundle && self.ZPBundle.ready && typeof self.ZPBundle.transformHtml === 'function') {
      const targetUrl = (opt.entry && (opt.entry.targetUrl || opt.entry.baseUrl)) || '';
      const out = self.ZPBundle.transformHtml(html, targetUrl);
      if (typeof out === 'string' && out.length > 0) {
        transformed = out;
        transformOk = true;
      } else {
        transformFailure = 'empty transform output';
      }
      // Repoint stylesheet links from the pre-redirect host to X-ZP-Final-URL when a cross-host redirect occurred.
      const finalUrl = (resp.headers && resp.headers.get('X-ZP-Final-URL')) || '';
      if (finalUrl) {
        try {
          const origin = (opt.entry && (opt.entry.targetUrl || opt.entry.baseUrl)) || '';
          const oUrl = new URL(origin);
          const fUrl = new URL(finalUrl);
          if (oUrl.host !== fUrl.host) {
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
  if (!transformOk) {
    const targetUrl = (opt.entry && (opt.entry.targetUrl || opt.entry.baseUrl)) || '';
    try {
      (self.__zpRustTrace = self.__zpRustTrace || []).push(
        `sw:html-transform-fail ${String(targetUrl).slice(0, 120)} reason=${String(transformFailure).slice(0, 160)}`
      );
    } catch {}
    return safeError('MALFORMED_HTML', 502, targetUrl);
  }

  const preludeHTML = buildRuntimePrelude(opt.tab, opt.entry, ZP.trustedTypesPolicies(resp.headers && resp.headers.get('Content-Security-Policy')), targetEvalRefusal(resp.headers));
  const injected = injectPrelude(transformed, preludeHTML);
  const headers = new Headers(resp.headers);
  headers.delete('Content-Length');
  headers.delete('X-ZP-Eval-CSP');
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(injected, { status: resp.status, statusText: resp.statusText, headers });
}
// Pipe decoded HTML bytes through ZPBundle.HtmlTxn for progressive rewriting and prelude injection, failing closed on stream errors.
function streamDocumentResponse(resp, opt, targetUrl, bodyStream) {
  const preludeHTML = buildRuntimePrelude(opt.tab, opt.entry, ZP.trustedTypesPolicies(resp.headers && resp.headers.get('Content-Security-Policy')), targetEvalRefusal(resp.headers));
  let txn;
  try { txn = new self.ZPBundle.HtmlTxn(targetUrl, ORIGIN, preludeHTML); }
  catch { return null; }
  const stats = { id: (self.__zpStreamSeq = (self.__zpStreamSeq || 0) + 1), url: targetUrl.slice(-40), in: 0, out: 0, chunks: 0, state: 'open', err: '' };
  self.__zpStreamStats = ((self.__zpStreamStats || []).concat([stats])).slice(-6);
  const ts = new TransformStream({
    transform(chunk, controller) {
      try {
        stats.chunks++;
        stats.in += (chunk && chunk.byteLength) || 0;
        const out = txn.write(chunk);
        if (out && out.byteLength) { stats.out += out.byteLength; controller.enqueue(out); }
      } catch (e) {
        stats.state = 'error';
        stats.err = (e && (e.message || e.code)) || String(e);
        controller.error(e);
      }
    },
    flush(controller) {
      try {
        const tail = txn.end();
        if (tail && tail.byteLength) { stats.out += tail.byteLength; controller.enqueue(tail); }
        stats.state = 'closed';
        // Deliver the pre-decompression wire byte count recorded by the kernel pump once the stream finishes flushing.
        deliverStreamEncoded(streamIdForReport);
      } catch (e) {
        stats.state = 'flush-error';
        stats.err = (e && (e.message || e.code)) || String(e);
        controller.error(e);
      }
    },
  });
  const headers = new Headers(resp.headers);
  const streamIdForReport = resp.headers.get('X-ZP-Stream-Id') || '';
  headers.delete('Content-Length');
  headers.delete('X-ZP-Stream');
  headers.set('Content-Type', 'text/html; charset=utf-8');
  applyZPSecurityHeaders(headers, opt.request, opt.tab && opt.tab.servers, opt.tab, targetUrl);
  headers.delete('X-ZP-Eval-CSP');
  const out = new Response((bodyStream || resp.body).pipeThrough(ts), {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
  return out;
}
function isHTMLResponse(resp) {
  const ct = resp.headers && resp.headers.get('Content-Type') || '';
  return /\btext\/html\b/i.test(ct) || /\bapplication\/xhtml\+xml\b/i.test(ct);
}
// The target's policy that refuses string evaluation: kept in an internal header once the response's own policy has been replaced (see
// applyZPSecurityHeaders), else read from the policy itself.
function targetEvalRefusal(headers) {
  if (!headers) return '';
  return headers.get('X-ZP-Eval-CSP') || ZP.evalBlockingPolicy(headers.get('Content-Security-Policy'));
}
// `ttPolicies`: the target's enforced Trusted Types policies (`ZP.trustedTypesPolicies` of its header), which the document enforces and which
// a blob or data worker it starts inherits. `evalBlocking`: the first policy of that header that refuses string evaluation (`ZP.evalBlockingPolicy`),
// which the membrane enforces for `eval` and `Function` because the proxy's own policy has to allow them.
function buildRuntimePrelude(tab, entry, ttPolicies, evalBlocking) {
  // Seed initial non-HttpOnly document.cookie values matching entry.targetUrl.
  const documentCookie = tab.cookieJar ? tab.cookieJar.documentCookieFor(entry.targetUrl) : '';
  const ttList = Array.isArray(ttPolicies) ? ttPolicies : [];
  const boot = {
    tabId: tab.tabId,
    entryId: entry.entryId,
    targetUrl: entry.targetUrl,
    documentCookie,
    runtimeToken: tab.runtimeToken || '',
    servers: tab.servers || [],
    wtGateway: runtimeConfig.wtGateway || '',
    wtGatewayCertHashes: Array.isArray(runtimeConfig.wtGatewayCertHashes) ? runtimeConfig.wtGatewayCertHashes : [],
    rtcICEServers: Array.isArray(runtimeConfig.rtcICEServers) ? runtimeConfig.rtcICEServers : [],
    ...(entry.opaque ? { opaque: true } : null),
    ...(tab.siteFrames ? { siteFrames: true } : null),
    ...(tab.challengeCompat ? { challengeCompat: true } : null),
    ...(ttList.length ? { trustedTypesPolicies: ttList } : null),
    ...(evalBlocking ? { cspEvalBlock: evalBlocking } : null),
    ...(ZP.requiresTrustedTypes(ttList.join(', ')) ? { trustedTypes: true } : null),
    ...(entry.referrerPolicy ? { referrerPolicy: entry.referrerPolicy } : null),
    ...(entry.siteFrame ? { siteFrame: entry.siteFrame } : null),
    ...(typeof entry.documentReferrer === 'string' ? { referrer: entry.documentReferrer } : null),
  };
  const bootJSON = JSON.stringify(boot).replace(/</g, '\\u003c');
  // Consume zp_chain hop state from the URL fragment before target scripts run.
  const prewarmInline = '(function(){try{var p=new URLSearchParams(location.hash.slice(1));var c=p.get("zp_chain");if(!c)return;var chain;try{chain=JSON.parse(atob(decodeURIComponent(c)));}catch(e){return;}if(!Array.isArray(chain)||!chain.length)return;var next=chain.shift();var wait=Math.max(0,Math.min(120000,Number(next.waitMs)||0));var u=new URL(next.path,location.origin);var np=new URLSearchParams(u.hash.startsWith("#")?u.hash.slice(1):u.hash);if(chain.length){np.set("zp_chain",encodeURIComponent(btoa(JSON.stringify(chain))));}else{np.delete("zp_chain");}u.hash="#"+np.toString();var assign=location.assign.bind(location);p.delete("zp_chain");try{history.replaceState(null,"","#"+p.toString());}catch(e){}setTimeout(function(){try{assign(u.toString());}catch(e){}},wait);}catch(e){}})();';
  // Tag inline prelude scripts with `data-zp-internal` so DOM serialization strips them.
  return '<script nonce=zp data-zp-internal>' + prewarmInline + '</script>' +
    '<script nonce=zp src=' + ZP.assetURL('zp-core.js') + '></script>' +
    '<script nonce=zp src=' + ZP.assetURL('zp-page-bundle.js') + '></script>' +
    '<script nonce=zp id=__zp-boot type=application/json>' + bootJSON + '</script>' +
    '<script nonce=zp src=' + ZP.assetURL('runtime-prelude.js') + '></script>';
}
function injectPrelude(html, prelude) {
  // Inject at the start of <head> (or <html>/document start) so the membrane initializes before any target script runs.
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

function scriptResponseHeaders(resp, req) {
  const h = new Headers(resp.headers);
  h.delete('Content-Security-Policy');
  h.delete('Content-Security-Policy-Report-Only');
  h.delete('X-Content-Security-Policy');
  h.delete('X-WebKit-CSP');
  h.set('Content-Type', 'text/javascript; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Content-Security-Policy', ZP.fixedCSP());
  applyCORS(h, req);
  return h;
}


async function handleMessage(event) {
  const msg = event.data || {};
  const reply = event.ports && event.ports[0];
  // Keepalive ping from runtime-prelude to reset the SW idle timer during long fetch-quiet gaps.
  if (msg && msg.type === '__zpKeepAlive') return;
  if (msg && msg.type === ZP.MSG.ENCODED_SIZE_QUERY) {
    const key = String(msg.url || '');
    const size = docEncodedByUrl.get(key) || streamEncodedByUrl.get(key) || 0;
    if (size) { docEncodedByUrl.delete(key); streamEncodedByUrl.delete(key); }
    if (reply) reply.postMessage({ ok: true, size });
    return;
  }
  // Dump the JS-array trace ring without calling initKernel() so diagnostics still work after a WASM trap.
  if (msg && msg.type === '__zpTraceDump') {
    if (reply) reply.postMessage({ ok: true, trace: (self.__zpRustTrace || []).slice(-400), streamStats: self.__zpStreamStats || null });
    return;
  }
  if (msg && msg.type === '__zpRefusalDump') {
    if (reply) reply.postMessage({ ok: true, refusals: refusalLog.slice(-MAX_REFUSAL_LOG) });
    return;
  }
  if (msg && msg.type === '__zpKernelEchoTest') {
    try { await initKernel(); } catch {}
    let result;
    try {
      const echoFn = (self.ZPKernel && self.ZPKernel.kernelEchoSync) || (self.ZPKernelWBG && self.ZPKernelWBG.kernelEchoSync);
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
    try { await initKernel(); } catch (e) { initErr = initErr || (e && e.message) || String(e); }
    if (reply) reply.postMessage({ probe: {
      kernelFetch: typeof self.kernelFetch,
      kernelStream: typeof self.kernelStream,
      bundleReady: !!(self.ZPBundle && self.ZPBundle.ready),
      kernelReady: !!(self.ZPKernel && self.ZPKernel.ready),
      hasZPBundleWBG: typeof self.ZPBundleWBG,
      hasZPKernelWBG: typeof self.ZPKernelWBG,
      bundleVersion: self.ZPBundle && self.ZPBundle.bundleVersion ? self.ZPBundle.bundleVersion() : null,
      kernelVersion: self.ZPKernel && self.ZPKernel.kernelVersion ? self.ZPKernel.kernelVersion() : null,
      rustTrace: (self.__zpRustTrace || []).slice(-400),
      rewriteStats: {
        invocations: rewriteStats.invocations,
        hits: rewriteStats.hits,
        misses: rewriteStats.misses,
        hitRatio: rewriteStats.invocations > 0
          ? Math.round((rewriteStats.hits / rewriteStats.invocations) * 1000) / 1000
          : 0,
        rewriteLatencyMs: Math.round(rewriteStats.rewriteLatencyMs),
        cacheKeyLatencyMs: Math.round(rewriteStats.cacheKeyLatencyMs),
        cacheKeyShare: rewriteStats.rewriteLatencyMs > 0
          ? Math.round((rewriteStats.cacheKeyLatencyMs / (rewriteStats.rewriteLatencyMs + rewriteStats.cacheKeyLatencyMs)) * 1000) / 1000
          : 0,
        cacheEntries: rewriteCache.size,
        cacheBytes: rewriteCacheBytes,
      },
      outgoingHeaders: outgoingHeaderLog.slice(),
      transportStats: {
        requests: transportStats.requests,
        totalLatencyMs: Math.round(transportStats.totalLatencyMs),
        totalBytes: transportStats.totalBytes,
        errors: transportStats.errors,
        avgLatencyMs: transportStats.requests > 0
          ? Math.round((transportStats.totalLatencyMs / transportStats.requests) * 10) / 10
          : 0,
      },
      transportLatency: transportLatencyLog.slice(),
      initErr,
    }});
    return;
  }
  const ok = data => reply && reply.postMessage(Object.assign({ ok: true }, data || {}));
  const fail = code => reply && reply.postMessage({ ok: false, error: code });
  try {
    if (!cookieJarLoaded) await ensureCookieJarLoaded();
    if (msg.type === ZP.MSG.OPEN_SHARE) {
      const routeKey = String(msg.routeKey || '');
      if (!routeKey || /[^A-Za-z0-9_-]/.test(routeKey)) { fail('MALFORMED_ROUTE'); return; }
      // Reuse an existing tab when reuseTabId is specified so warm-up cookies remain available to follow-up navigations.
      let tab = null;
      if (msg.reuseTabId) {
        tab = tabs.get(String(msg.reuseTabId)) || null;
      }
      const openerEnv = sanitizeClientEnv(msg.env);
      if (tab) {
        if (openerEnv) tab.clientEnv = openerEnv;
        const entryId = randomEntryId();
        const targetUrl = ZP.canonicalTargetURL(msg.targetUrl).href;
        tab.entries.set(entryId, { entryId, targetUrl, baseUrl: targetUrl, title: '', stateClone: null, scrollX: 0, scrollY: 0, createdAt: Date.now(), opaque: !!msg.opaque, frameRoute: false });
        shareRoutes.set(routeKey, { tabId: tab.tabId, entryId, targetURL: targetUrl, frameRoute: false });
        scheduleStateFlush();
        ok({ path: ZP.makeSharePath(routeKey), servers: tab.servers, tabId: tab.tabId, reused: true });
        return;
      }
      tab = createTab(msg.targetUrl, msg.servers, msg.challengeCompat);
      if (openerEnv) tab.clientEnv = openerEnv;
      const first = tab.entries.get(tab.activeEntryId);
      if (msg.opaque && first) first.opaque = true;
      // A site frame: its embedder lives at another real origin of this proxy (see ZP.siteFrameOrigin), so the tab is born as a frame
      // of that page: the embedder's address is the Referer, the top document's origin decides what counts as cross-site.
      const siteFrame = msg.siteFrame ? sanitizeSiteFrame(msg.siteFrame) : null;
      if (siteFrame && first) {
        first.frameRoute = true;
        first.parentTargetUrl = siteFrame.parentUrl;
        first.siteFrame = siteFrame;
        tab.siteFrames = true;
        try { tab.topOrigin = new URL(siteFrame.topUrl).origin; } catch {}
      }
      if (msg.siteFrames) tab.siteFrames = true;
      shareRoutes.set(routeKey, { tabId: tab.tabId, entryId: tab.activeEntryId, targetURL: first ? first.targetUrl : '', frameRoute: !!siteFrame });
      scheduleStateFlush();
      ok({ path: ZP.makeSharePath(routeKey), servers: tab.servers, tabId: tab.tabId, reused: false });
      return;
    }
    if (msg.type === ZP.MSG.FRAME_ROUTE) {
      const tab = runtimeTabForMessage(event, msg, fail);
      if (!tab) return;
      const routeKey = String(msg.routeKey || '');
      if (!routeKey || /[^A-Za-z0-9_-]/.test(routeKey)) { fail('MALFORMED_ROUTE'); return; }
      const targetUrl = ZP.canonicalTargetURL(msg.targetUrl).href;
      const baseUrl = msg.baseUrl ? ZP.canonicalTargetURL(msg.baseUrl, targetUrl).href : targetUrl;
      // Record parentTargetUrl so the iframe document fetch sends the embedder's virtual URL as Referer.
      let parentTargetUrl = '';
      try { if (msg.parentTargetUrl) parentTargetUrl = ZP.canonicalTargetURL(msg.parentTargetUrl).href; } catch {}
      const entryId = String(msg.entryId || randomEntryId());
      tab.entries.set(entryId, { entryId, targetUrl, baseUrl, parentTargetUrl, title: '', stateClone: null, scrollX: 0, scrollY: 0, createdAt: Date.now(), opaque: !!msg.opaque, frameRoute: true });
      shareRoutes.set(routeKey, { tabId: tab.tabId, entryId, targetURL: targetUrl, frameRoute: true });
      scheduleStateFlush();
      ok({ path: ZP.makeSharePath(routeKey) });
      return;
    }
    if (msg.type === ZP.MSG.HISTORY_UPDATE) {
      const tab = runtimeTabForMessage(event, msg, fail);
      if (!tab) return;
      const targetUrl = ZP.canonicalTargetURL(msg.targetUrl).href;
      const baseUrl = msg.baseUrl ? ZP.canonicalTargetURL(msg.baseUrl, targetUrl).href : targetUrl;
      const prevEntry = tab.entries.get(msg.entryId);
      const callerCtx = event.source && event.source.id ? clientContext.get(event.source.id) : null;
      const callerEntry = callerCtx && callerCtx.tabId === tab.tabId ? tab.entries.get(callerCtx.entryId) : null;
      const isFrame = Boolean((prevEntry && (prevEntry.frameRoute || prevEntry.parentTargetUrl)) || (callerEntry && (callerEntry.frameRoute || callerEntry.parentTargetUrl)) || msg.frameRoute);
      const parentTargetUrl = (prevEntry && prevEntry.parentTargetUrl) || (callerEntry && callerEntry.parentTargetUrl) || '';
      const entry = { entryId: msg.entryId, targetUrl, baseUrl, parentTargetUrl, title: '', stateClone: null, scrollX: 0, scrollY: 0, createdAt: Date.now(), opaque: !!msg.opaque, frameRoute: isFrame };
      tab.entries.set(entry.entryId, entry);
      if (!isFrame || !tab.activeEntryId) tab.activeEntryId = entry.entryId;
      if (msg.routeKey) shareRoutes.set(String(msg.routeKey), { tabId: tab.tabId, entryId: entry.entryId, targetURL: targetUrl, frameRoute: isFrame });
      scheduleStateFlush();
      ok();
      return;
    }
    // Bind `clientId` on boot for clients created without a navigation request (`srcdoc`, `blob:`, `about:blank`).
    if (msg.type === ZP.MSG.BIND_CLIENT) {
      const tab = runtimeTabForMessage(event, msg, fail);
      if (!tab) return;
      const entry = tab.entries.get(msg.entryId || tab.activeEntryId);
      if (!entry) { fail('SW_NOT_READY'); return; }
      const sourceId = event.source && event.source.id;
      if (sourceId) bindClientContext(sourceId, tab, entry);
      if (msg.env && msg.env.top === true) { const env = sanitizeClientEnv(msg.env); if (env) tab.clientEnv = env; }
      scheduleStateFlush();
      ok({ bound: !!sourceId });
      return;
    }
    if (msg.type === ZP.MSG.BASE_UPDATE) {
      const tab = runtimeTabForMessage(event, msg, fail);
      if (!tab) return;
      const entry = tab.entries.get(msg.entryId || tab.activeEntryId);
      if (!entry) { fail('SW_NOT_READY'); return; }
      entry.baseUrl = ZP.canonicalTargetURL(msg.baseUrl, entry.targetUrl).href;
      const sourceId = event.source && event.source.id;
      if (sourceId) bindClientContext(sourceId, tab, entry);
      scheduleStateFlush();
      ok({ baseUrl: entry.baseUrl });
      return;
    }
    // Apply document referrer policies declared via `<meta name="referrer">` to `entry.referrerPolicy` so runtime fetches honor them.
    if (msg.type === ZP.MSG.REFERRER_POLICY) {
      const tab = runtimeTabForMessage(event, msg, fail);
      if (!tab) return;
      const entry = tab.entries.get(msg.entryId || tab.activeEntryId);
      if (!entry) { fail('SW_NOT_READY'); return; }
      const token = String(msg.policy || '').trim().toLowerCase();
      if (['', 'no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url'].includes(token)) entry.referrerPolicy = token;
      scheduleStateFlush();
      ok({ referrerPolicy: entry.referrerPolicy || '' });
      return;
    }
    if (msg.type === ZP.MSG.RESOLVE_ENTRY) {
      const ctx = contextFromPath(new URL(msg.path, ORIGIN).pathname);
      const tab = ctx && tabs.get(ctx.tabId);
      const entry = tab && tab.entries.get(ctx.entryId);
      if (!entry) { fail('SW_NOT_READY'); return; }
      if (!runtimeMessageAuthorized(event, tab, msg, fail)) return;
      ok({ tabId: tab.tabId, entryId: entry.entryId, targetUrl: entry.targetUrl, baseUrl: entry.baseUrl || entry.targetUrl, scrollX: entry.scrollX || 0, scrollY: entry.scrollY || 0, servers: tab.servers || [] });
      return;
    }
    if (msg.type === ZP.MSG.SCROLL_UPDATE) {
      const tab = runtimeTabForMessage(event, msg, fail);
      if (!tab) return;
      const entry = tab.entries.get(msg.entryId);
      if (entry) { entry.scrollX = Number(msg.scrollX) || 0; entry.scrollY = Number(msg.scrollY) || 0; scheduleStateFlush(); }
      ok();
      return;
    }
    if (msg.type === ZP.MSG.COOKIE_SET) {
      const tab = runtimeTabForMessage(event, msg, fail);
      if (!tab) return;
      if (tab.cookieJar && msg.targetUrl && msg.cookie) {
        applyCookieWrite(tab, String(msg.targetUrl), String(msg.cookie), msg.wid, event.source && event.source.id);
      }
      ok();
      return;
    }
    if (msg.type === ZP.MSG.SUBMIT_PREPARE) {
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
      // The submitting document's address, as it stands (history.replaceState included), is the Referer of its form submission. Only an
      // address in that document's own origin is believed, the rule a fetch's `documentURL` follows; anything else keeps the old derivation.
      let referrer = '';
      try {
        const from = tab.entries.get(String(msg.fromEntryId || ''));
        const claimed = new URL(String(msg.referrer || ''));
        if (from && /^https?:$/.test(claimed.protocol) && claimed.origin === new URL(from.targetUrl).origin) referrer = claimed.href;
      } catch {}
      const entry = { entryId, targetUrl, baseUrl: targetUrl, title: '', stateClone: null, scrollX: 0, scrollY: 0, createdAt: Date.now() };
      tab.entries.set(entryId, entry);
      tab.activeEntryId = entryId;
      shareRoutes.set(routeKey, { tabId: tab.tabId, entryId, targetURL: targetUrl, frameRoute: false });
      scheduleStateFlush();
      const submitId = ZP.randomId('sub');
      pendingSubmissions.set(submitId, { submitId, routeKey, tabId: tab.tabId, entryId, targetUrl, method, headers: Array.isArray(msg.headers) ? msg.headers : [], body, referrer, expiresAt: Date.now() + SUBMISSION_TTL_MS });
      ok({ submitId });
      return;
    }
    if (msg.type === ZP.MSG.WS_OPEN) { await openRuntimeStream(event, msg, ok, fail); return; }
    // Stash `blob:` worker sources read by a module worker so it can `import('/zp/api/worker-script?srctok=...')`.
    if (msg.type === ZP.MSG.WORKER_STASH) {
      const src = typeof msg.src === 'string' ? msg.src : '';
      if (!src || src.length > 4000000) { fail('POLICY_BLOCKED'); return; }
      const tok = ZP.randomId('ws');
      workerSrcStash.set(tok, src);
      ok({ tok });
      return;
    }
    fail('POLICY_BLOCKED');
  } catch (e) { fail(e && e.code || e && e.message || 'POLICY_BLOCKED'); }
}

async function openRuntimeStream(event, msg, ok, fail) {
  const tab = runtimeTabForMessage(event, msg, fail);
  if (!tab) return;
  // Bind identity before lazy kernel initialization can yield to a navigation.
  const client = event.source && clientContext.get(event.source.id);
  const entryId = client && client.tabId === tab.tabId ? client.entryId : msg.entryId || tab.activeEntryId;
  const entry = tab.entries.get(entryId);
  if (!entry) { fail('SW_NOT_READY'); return; }
  let target;
  try { target = ZP.canonicalWebSocketURL(msg.url); }
  catch { fail('WS_BLOCKED'); return; }
  const origin = new URL(entry.targetUrl).origin;
  const cookieURL = new URL(target.href);
  cookieURL.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
  const cookie = tab.cookieJar ? tab.cookieJar.cookieHeader(cookieURL.href) : '';
  try { await initKernel(); } catch { fail('SW_NOT_READY'); return; }
  if (typeof self.kernelStream !== 'function') { fail('SW_NOT_READY'); return; }
  // Re-validate RFC 6455 section 4.1 sub-protocol tokens before passing them to the upstream handshake.
  const requestedProtocols = Array.isArray(msg.protocols) ? msg.protocols.slice() : [];
  for (const p of requestedProtocols) {
    if (typeof p !== 'string' || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(p)) {
      fail('POLICY_BLOCKED');
      return;
    }
  }
  let stream;
  try {
    stream = await self.kernelStream({ url: target.href, protocols: requestedProtocols, userAgent: ZP.TARGET_USER_AGENT, origin, cookie, tabId: tab.tabId, isolationKey: tab.streamIsolationKey, streamIsolationKey: tab.streamIsolationKey, servers: tab.servers || [] });
  } catch (e) {
    fail(e && (e.message || e.code) || 'TARGET_CONNECT_FAILED');
    return;
  }
  let channel = null;
  let id = null;
  let done = false;
  let closeDeadline = null;
  const post = message => {
    try { if (channel) channel.port1.postMessage(message); } catch {}
  };
  const finish = (code, reason) => {
    if (done) return;
    done = true;
    if (closeDeadline !== null) {
      clearTimeout(closeDeadline);
      closeDeadline = null;
    }
    if (id !== null) streams.delete(id);
    post({ type: 'close', code, reason });
    if (channel) {
      channel.port1.onmessage = null;
      try { channel.port1.close(); } catch {}
    }
    try { stream.setHandlers({}); } catch {}
  };
  const abort = () => {
    if (done) return;
    try { stream.abort(); }
    catch { post({ type: 'error' }); }
    finally { finish(1006, ''); }
  };
  try {
    // A rejected handshake still owns kernel drivers: abort, do not wait for
    // a peer that may never echo Close. This also covers channel/setup errors.
    const negotiated = String((stream && stream.protocol) || '');
    if (negotiated && requestedProtocols.indexOf(negotiated) < 0) throw new Error('WS_BLOCKED');
    channel = new MessageChannel();
    id = ZP.randomId('s');
    streams.set(id, stream);
    channel.port1.onmessage = ev => {
      if (done) return;
      const m = ev.data || {};
      try {
        if (m.type === 'send') stream.send(m.data);
        if (m.type === 'close' && closeDeadline === null) {
          // Bound only the close handshake, never an idle open connection.
          // Arm first: close() can synchronously deliver its terminal callback.
          closeDeadline = setTimeout(abort, 30000);
          stream.close(m.code, m.reason);
        }
        if (m.type === 'abort') abort();
      } catch {
        post({ type: 'error' });
        abort();
      }
    };
    stream.setHandlers({
      message: data => { if (!done) post({ type: 'message', data }); },
      close: finish,
      error: () => { if (!done) post({ type: 'error' }); },
    });
    // setHandlers may finish synchronously. Keep port2 available for transfer:
    // its queued terminal message survives closing the sending endpoint.
    event.ports[0].postMessage({ ok: true, id, protocol: negotiated, port: channel.port2 }, [channel.port2]);
  } catch (e) {
    abort();
    if (channel) { try { channel.port2.close(); } catch {} }
    fail(e && (e.message || e.code) || 'WS_BLOCKED');
  }
}

function runtimeTabForMessage(event, msg, fail) {
  const tab = tabs.get(String(msg.tabId || ''));
  if (!tab) { fail('SW_NOT_READY'); return null; }
  return runtimeMessageAuthorized(event, tab, msg, fail) ? tab : null;
}
function runtimeMessageAuthorized(event, tab, msg, fail) {
  // Require both the per-tab runtime capability token and a known SW client source.
  if (!tab.runtimeToken || msg.runtimeToken !== tab.runtimeToken) { fail('POLICY_BLOCKED'); return false; }
  const source = event.source;
  if (!source || !source.id) { fail('POLICY_BLOCKED'); return false; }
  const ctx = clientContext.get(source.id);
  if (ctx && ctx.tabId !== tab.tabId) { fail('POLICY_BLOCKED'); return false; }
  return true;
}

// What a site frame is told about the page that embeds it: the embedder's real origin and address, the top document's address, and
// the origin of the proxy page that owns the tab. Only http(s) URLs and origins are kept.
function sanitizeSiteFrame(raw) {
  const out = { parentOrigin: '', parentUrl: '', topUrl: '', mainOrigin: '', referrerPolicy: '' };
  try {
    if (!raw || typeof raw !== 'object') return null;
    // The policy the embedder applies to this frame (its `referrerpolicy` attribute, else its document's), which the browser would
    // have put on the frame's navigation request had the embedder and the frame shared an origin.
    const policy = String(raw.referrerPolicy || '').trim().toLowerCase();
    if (['', 'no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url'].includes(policy)) out.referrerPolicy = policy;
    out.parentOrigin = new URL(String(raw.parentOrigin)).origin;
    out.mainOrigin = new URL(String(raw.mainOrigin)).origin;
    out.parentUrl = ZP.canonicalTargetURL(String(raw.parentUrl)).href;
    out.topUrl = ZP.canonicalTargetURL(String(raw.topUrl)).href;
  } catch { return null; }
  return out;
}
function createTab(targetUrl, servers, challengeCompat) {
  const target = ZP.canonicalTargetURL(targetUrl).href;
  const tabId = ZP.randomId('t');
  const entryId = randomEntryId();
  const relayServers = ZP.relayServersForShare(servers || [], { allowLoopbackWS: true });
  // Share the RFC 6265 cookie jar across tabs targeting the same registrable domain.
  const targetOrigin = originKeyForURL(target);
  const tab = { tabId, activeEntryId: entryId, entries: new Map(), originMap: new Map(), cookieJar: getOrCreateJarForOrigin(targetOrigin), cookieJarOrigin: targetOrigin, storageNamespaces: new Map(), runtimeProfile: {}, streamIsolationKey: ZP.bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))), runtimeToken: ZP.randomId('rt'), servers: relayServers, challengeCompat: !!challengeCompat, topOrigin: new URL(target).origin, clientEnv: null };
  tab.entries.set(entryId, { entryId, targetUrl: target, baseUrl: target, title: '', stateClone: null, scrollX: 0, scrollY: 0, createdAt: Date.now(), frameRoute: false });
  tabs.set(tabId, tab);
  scheduleStateFlush();
  return tab;
}
function cleanupPendingSubmissions() {
  const now = Date.now();
  for (const [id, rec] of pendingSubmissions) {
    if (!rec || rec.expiresAt <= now) pendingSubmissions.delete(id);
  }
}
function randomEntryId() { return ZP.randomId('e'); }
function bindClientContext(clientId, tab, entry) {
  if (clientId) {
    clientContext.set(clientId, { tabId: tab.tabId, entryId: entry.entryId, targetUrl: entry.targetUrl, baseUrl: entry.baseUrl || entry.targetUrl });
    scheduleStateFlush();
  }
}
function contextFromPath(path) { const p = parseSharePath(path); const state = p && shareRoutes.get(p.routeKey); const tab = state && tabs.get(state.tabId); const entry = tab && tab.entries.get(state.entryId); if (entry) return { tabId: tab.tabId, entryId: entry.entryId, targetUrl: entry.targetUrl, baseUrl: entry.baseUrl || entry.targetUrl }; return null; }
function contextFromURL(u) { if (u.origin === ORIGIN) return resourceContext.get(u.pathname + u.search) || contextFromPath(u.pathname); return resourceContext.get(u.href) || null; }
function contextFor(req, clientId) { const ref = req.headers.get('Referer'); if (ref) { try { const ctx = contextFromURL(new URL(ref)); if (ctx) return ctx; } catch {} } if (clientId && clientContext.has(clientId)) return clientContext.get(clientId); return null; }
function rememberResourceContext(requestURL, targetUrl, ctx) {
  const next = { tabId: ctx.tabId, entryId: ctx.entryId, targetUrl: ctx.targetUrl, baseUrl: targetUrl };
  const key = requestURL.origin === ORIGIN ? requestURL.pathname + requestURL.search : requestURL.href;
  resourceContext.set(key, next);
  resourceContext.set(targetUrl, next);
  while (resourceContext.size > 2048) resourceContext.delete(resourceContext.keys().next().value);
}
// RFC 6265 cookie jars keyed by registrable domain and mirrored to IndexedDB across SW restarts.
const sharedJars = new Map();
const COOKIE_DB_NAME = 'zp-cookies';
const COOKIE_DB_VERSION = 1;
const COOKIE_DB_STORE = 'jars';
const COOKIE_FLUSH_INTERVAL_MS = 60_000;
const COOKIE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_TABS_KEY = '__zp_state_tabs__';
const STATE_ROUTES_KEY = '__zp_state_routes__';
let cookieDbPromise = null;
let cookieJarLoaded = false;
let cookieFlushTimer = null;
let stateFlushTimer = null;
function scheduleCookieFlush() {
  if (cookieFlushTimer !== null) return;
  cookieFlushTimer = setTimeout(() => {
    cookieFlushTimer = null;
    flushDirtyJarsToIDB();
  }, 20);
}
function scheduleStateFlush() {
  if (stateFlushTimer !== null) return;
  stateFlushTimer = setTimeout(() => {
    stateFlushTimer = null;
    flushStateToIDB();
  }, 20);
}
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
        const rows = req.result || [];
        const now = Date.now();
        let tabsRecord = null;
        let routesRecord = null;
        for (const entry of rows) {
          if (!entry || !entry.targetOrigin) continue;
          if (entry.targetOrigin === STATE_TABS_KEY) { tabsRecord = entry; continue; }
          if (entry.targetOrigin === STATE_ROUTES_KEY) { routesRecord = entry; continue; }
          if (String(entry.targetOrigin).startsWith('__zp_state_')) continue;
          if (!Array.isArray(entry.records)) continue;
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
        if (tabsRecord && Array.isArray(tabsRecord.tabs)) {
          for (const st of tabsRecord.tabs) {
            if (!st || !st.tabId) continue;
            let tab = tabs.get(st.tabId);
            if (!tab) {
              const jarOrigin = st.cookieJarOrigin || originKeyForURL(st.topOrigin || '');
              tab = {
                tabId: st.tabId,
                activeEntryId: st.activeEntryId || '',
                entries: new Map(),
                originMap: new Map(),
                cookieJar: getOrCreateJarForOrigin(jarOrigin),
                cookieJarOrigin: jarOrigin,
                storageNamespaces: new Map(),
                runtimeProfile: {},
                streamIsolationKey: st.streamIsolationKey || ZP.bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32))),
                runtimeToken: st.runtimeToken || ZP.randomId('rt'),
                servers: Array.isArray(st.servers) ? st.servers.slice() : [],
                challengeCompat: !!st.challengeCompat,
                siteFrames: !!st.siteFrames,
                topOrigin: st.topOrigin || '',
                clientEnv: st.clientEnv || null,
              };
              tabs.set(tab.tabId, tab);
            }
            if (Array.isArray(st.entries)) {
              for (const e of st.entries) {
                if (!e || !e.entryId || tab.entries.has(e.entryId)) continue;
                tab.entries.set(e.entryId, {
                  entryId: e.entryId,
                  targetUrl: e.targetUrl || '',
                  baseUrl: e.baseUrl || e.targetUrl || '',
                  parentTargetUrl: e.parentTargetUrl || '',
                  title: e.title || '',
                  stateClone: null,
                  scrollX: Number(e.scrollX) || 0,
                  scrollY: Number(e.scrollY) || 0,
                  createdAt: Number(e.createdAt) || now,
                  opaque: !!e.opaque,
                  frameRoute: !!e.frameRoute,
                  referrerPolicy: e.referrerPolicy || '',
                  ...(e.siteFrame ? { siteFrame: sanitizeSiteFrame(e.siteFrame) } : null),
                  ...(typeof e.documentReferrer === 'string' ? { documentReferrer: e.documentReferrer } : null),
                });
              }
            }
            if (!tab.activeEntryId && tab.entries.size > 0) {
              tab.activeEntryId = tab.entries.keys().next().value;
            }
          }
        }
        if (routesRecord) {
          if (Array.isArray(routesRecord.routes)) {
            for (const r of routesRecord.routes) {
              if (!r || !r.routeKey || !r.tabId || shareRoutes.has(r.routeKey)) continue;
              if (!tabs.has(r.tabId)) continue;
              shareRoutes.set(r.routeKey, {
                tabId: r.tabId,
                entryId: r.entryId || '',
                targetURL: r.targetURL || '',
                frameRoute: !!r.frameRoute,
              });
            }
          }
          if (Array.isArray(routesRecord.clients)) {
            for (const c of routesRecord.clients) {
              if (!c || !c.clientId || !c.tabId || clientContext.has(c.clientId)) continue;
              if (!tabs.has(c.tabId)) continue;
              clientContext.set(c.clientId, {
                tabId: c.tabId,
                entryId: c.entryId || '',
                targetUrl: c.targetUrl || '',
                baseUrl: c.baseUrl || c.targetUrl || '',
              });
            }
          }
        }
        cookieJarLoaded = true;
        resolve();
      };
      req.onerror = () => { cookieJarLoaded = true; resolve(); };
    });
  } catch {
    cookieJarLoaded = true;
  }
}
async function ensureCookieJarLoaded() {
  if (cookieJarLoaded) return;
  try { await restorePromise; } catch {}
  cookieJarLoaded = true;
}
function serializeTabsState() {
  const out = [];
  for (const [, tab] of tabs) {
    if (!tab || !tab.tabId) continue;
    const entries = [];
    if (tab.entries) {
      for (const [, e] of tab.entries) {
        if (!e || !e.entryId) continue;
        entries.push({
          entryId: e.entryId,
          targetUrl: e.targetUrl || '',
          baseUrl: e.baseUrl || e.targetUrl || '',
          parentTargetUrl: e.parentTargetUrl || '',
          title: e.title || '',
          scrollX: Number(e.scrollX) || 0,
          scrollY: Number(e.scrollY) || 0,
          createdAt: Number(e.createdAt) || Date.now(),
          opaque: !!e.opaque,
          frameRoute: !!e.frameRoute,
          referrerPolicy: e.referrerPolicy || '',
          siteFrame: e.siteFrame || undefined,
          documentReferrer: typeof e.documentReferrer === 'string' ? e.documentReferrer : undefined,
        });
      }
    }
    out.push({
      tabId: tab.tabId,
      activeEntryId: tab.activeEntryId || '',
      cookieJarOrigin: tab.cookieJarOrigin || originKeyForURL(tab.topOrigin || ''),
      streamIsolationKey: tab.streamIsolationKey || '',
      runtimeToken: tab.runtimeToken || '',
      servers: Array.isArray(tab.servers) ? tab.servers.slice() : [],
      challengeCompat: !!tab.challengeCompat,
      siteFrames: !!tab.siteFrames,
      topOrigin: tab.topOrigin || '',
      clientEnv: tab.clientEnv || null,
      entries,
    });
  }
  return out;
}
function serializeRoutesState() {
  const routes = [];
  for (const [routeKey, state] of shareRoutes) {
    if (!routeKey || !state || !state.tabId) continue;
    const tab = tabs.get(state.tabId);
    const entry = tab && tab.entries && tab.entries.get(state.entryId);
    routes.push({
      routeKey,
      tabId: state.tabId,
      entryId: state.entryId || '',
      targetURL: state.targetURL || (entry && entry.targetUrl) || '',
      frameRoute: !!(state.frameRoute || (entry && entry.frameRoute)),
    });
  }
  const clients = [];
  for (const [clientId, ctx] of clientContext) {
    if (!clientId || !ctx || !ctx.tabId) continue;
    clients.push({
      clientId,
      tabId: ctx.tabId,
      entryId: ctx.entryId || '',
      targetUrl: ctx.targetUrl || '',
      baseUrl: ctx.baseUrl || ctx.targetUrl || '',
    });
  }
  return { routes, clients };
}
async function flushStateToIDB() {
  try {
    const db = await openCookieDb();
    const tabsSnap = serializeTabsState();
    const routesSnap = serializeRoutesState();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(COOKIE_DB_STORE, 'readwrite');
      const store = tx.objectStore(COOKIE_DB_STORE);
      const now = Date.now();
      store.put({ targetOrigin: STATE_TABS_KEY, tabs: tabsSnap, updatedAt: now });
      store.put({ targetOrigin: STATE_ROUTES_KEY, routes: routesSnap.routes, clients: routesSnap.clients, updatedAt: now });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
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
const restorePromise = loadAllStoredJars();
setInterval(() => { flushDirtyJarsToIDB(); flushStateToIDB(); }, COOKIE_FLUSH_INTERVAL_MS);
self.addEventListener('message', evt => {
  if (evt.data && evt.data.type === ZP.MSG.FLUSH_COOKIES) {
    const p = Promise.all([flushDirtyJarsToIDB(), flushStateToIDB()]);
    if (evt.waitUntil) evt.waitUntil(p);
  }
});

// Compute the registrable domain (eTLD+1) to align subdomain cookie-jar sharing with public-suffix rejection.
const SECOND_LEVEL_SUFFIX = new Set([
  'co', 'ne', 'or', 'ac', 'go', 're', 'pe', 'kg', 'seoul', 'busan',
  'com', 'net', 'org', 'gov', 'edu', 'mil', 'int', 'info', 'biz', 'nom',
]);
function registrableDomain(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || /^\d+(\.\d+)*$/.test(h) || h.indexOf(':') >= 0) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  if (tld.length === 2 && SECOND_LEVEL_SUFFIX.has(sld)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}
// Reject cookies whose Domain attribute is a public suffix (e.g., com or co.kr).
function isPublicSuffixDomain(dom) {
  const d = String(dom || '').toLowerCase().replace(/\.$/, '');
  if (!d) return true;
  if (/^\d+(\.\d+)*$/.test(d) || d.indexOf(':') >= 0) return false;
  const parts = d.split('.');
  if (parts.length < 2) return true;
  if (parts.length === 2 && parts[1].length === 2 && SECOND_LEVEL_SUFFIX.has(parts[0])) return true;
  return registrableDomain(d) !== d;
}
function originKeyForURL(targetUrl) {
  try { return registrableDomain(new URL(targetUrl).hostname); } catch { return ''; }
}
function getOrCreateJarForOrigin(originKey, initialRecords) {
  let jar = sharedJars.get(originKey);
  if (jar) {
    if (Array.isArray(initialRecords) && initialRecords.length) jar.merge(initialRecords);
    return jar;
  }
  jar = createCookieJar(initialRecords || [], (change, meta) => queueCookiePush(jar, change, meta && meta.sourceClientId));
  sharedJars.set(originKey, jar);
  return jar;
}

// Broadcast non-HttpOnly cookie changes to window clients whose virtual host domain-matches the cookie.
const cookieEpoch = ZP.randomId('ck');
let cookieChangeSeq = 0;
const cookiePushQueue = new Map();
function cookieChangeVisibleToHost(change, host) {
  return change.hostOnly ? host === change.domain : (host === change.domain || host.endsWith('.' + change.domain));
}
function queueCookiePush(jar, change, sourceClientId) {
  if (!change || change.httpOnly) return;
  let queue = cookiePushQueue.get(jar);
  if (!queue) {
    queue = [];
    cookiePushQueue.set(jar, queue);
    Promise.resolve().then(() => flushCookiePush(jar)).catch(() => {});
  }
  queue.push({ change, sourceClientId: sourceClientId || '' });
}
async function flushCookiePush(jar) {
  const batch = cookiePushQueue.get(jar) || [];
  cookiePushQueue.delete(jar);
  if (!batch.length) return;
  let windows;
  try { windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true }); } catch { return; }
  for (const client of windows) {
    const ctx = clientContext.get(client.id);
    const tab = ctx && tabs.get(ctx.tabId);
    if (!tab || tab.cookieJar !== jar) continue;
    let host;
    try { host = new URL(ctx.targetUrl).hostname.toLowerCase(); } catch { continue; }
    const changes = batch.filter(b => b.sourceClientId !== client.id && cookieChangeVisibleToHost(b.change, host)).map(b => b.change);
    if (changes.length) { try { client.postMessage({ type: ZP.MSG.COOKIE_CHANGE, changes }); } catch {} }
  }
}

function createCookieJar(initialRecords, notify) {
  const records = Array.isArray(initialRecords) ? initialRecords.slice() : [];
  let dirty = false;
  function markDirty() { dirty = true; scheduleCookieFlush(); }
  function canonHost(h) { return String(h || '').toLowerCase().replace(/\.$/, ''); }
  // Treat loopback origins (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) as secure for cookies over HTTP so `SameSite=None; Secure` cookies work on local targets just as in Chrome.
  function secureForCookies(u) {
    if (u.protocol === 'https:' || u.protocol === 'wss:') return true;
    const h = canonHost(u.hostname);
    return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
  }
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
        // Reject public-suffix Domain attributes so a cookie jar shared per registrable domain cannot leak cookies across unrelated sites under the suffix.
        if (!dom || isPublicSuffixDomain(dom) || !domainMatch(host, dom, false)) continue;
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
  // Produces a pre-parsed cookie mutation record (`expires` is null for session cookies) so pages apply the jar's exact Domain, session, and deletion decisions without re-parsing.
  function changeFor(rec, deleted) {
    return {
      id: cookieEpoch + ':' + (++cookieChangeSeq),
      name: rec.name, value: rec.value, domain: rec.domain, hostOnly: !!rec.hostOnly, path: rec.path,
      secure: !!rec.secure, httpOnly: !!rec.httpOnly, sameSite: rec.sameSite || '',
      expires: rec.session ? null : (rec.maxAge != null ? rec.creation + rec.maxAge * 1000 : rec.expires),
      deleted: !!deleted,
    };
  }
  function setCookieLine(url, line, meta) {
    const rec = parse(line, url);
    if (!rec) return null;
    if (meta && meta.crossSite && rec.sameSite !== 'none') return null;
    const report = deleted => {
      const change = changeFor(rec, deleted);
      if (meta && meta.wid) change.wid = meta.wid;
      if (notify) { try { notify(change, meta); } catch {} }
      return change;
    };
    if (rec.maxAge != null && rec.maxAge <= 0) {
      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        if (r.name === rec.name && r.domain === rec.domain && r.path === rec.path) {
          records.splice(i, 1);
          markDirty();
          break;
        }
      }
      return report(true);
    }
    // Bound session cookies persisted in IndexedDB with a synthetic TTL so they do not accumulate indefinitely across worker restarts.
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
        return report(expired(rec, Date.now()));
      }
    }
    records.push(rec);
    markDirty();
    return report(expired(rec, Date.now()));
  }
  function cookiesForURL(url, includeHttpOnly, crossSite) {
    let u; try { u = new URL(url); } catch { return []; }
    const host = canonHost(u.hostname);
    const path = u.pathname || '/';
    const isSecure = secureForCookies(u);
    const now = Date.now();
    const out = [];
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (expired(r, now)) { records.splice(i, 1); continue; }
      if (!includeHttpOnly && r.httpOnly) continue;
      if (crossSite && r.sameSite !== 'none') continue;
      if (!domainMatch(host, r.domain, r.hostOnly)) continue;
      if (!pathMatch(path, r.path)) continue;
      if (r.secure && !isSecure) continue;
      out.push(r);
    }
    out.sort((a, b) => (b.path.length - a.path.length) || (a.creation - b.creation));
    return out;
  }
  function cookieHeader(url, opts) {
    return cookiesForURL(url, true, !!(opts && opts.crossSite)).map(r => r.name + '=' + r.value).join('; ');
  }
  function documentCookieFor(url) {
    return cookiesForURL(url, false).map(r => r.name + '=' + r.value).join('; ');
  }
  function snapshot() {
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
    // Preserve live records over late-arriving IndexedDB restore entries with the same (name, domain, path) tuple, and avoid marking the jar dirty for freshly loaded state.
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
// Deduplicates `document.cookie` writes that arrive via both postMessage and a synchronous request header, and echoes `wid` on the change event so the originating document ignores its own write.
function applyCookieWrite(tab, targetUrl, line, wid, sourceClientId) {
  if (!line || !tab.cookieJar) return;
  if (wid) {
    const seen = tab.cookieWriteIds || (tab.cookieWriteIds = new Set());
    if (seen.has(wid)) return;
    seen.add(wid);
    if (seen.size > 256) seen.delete(seen.values().next().value);
  }
  tab.cookieJar.setCookieLine(String(targetUrl), String(line), { sourceClientId, wid });
}
// Enforces virtual-origin CORS and credential rules for subresource elements (`crossorigin`, module scripts, fonts), using `X-ZP-Element-CORS` when a parent frame proxies the fetch on behalf of an uncontrolled child document (`srcdoc`, `blob:`, `document.write`).
function elementCorsOptions(req, entry) {
  const hint = req.headers.get('X-ZP-Element-CORS');
  let credentials;
  if (hint === 'anonymous') credentials = 'same-origin';
  else if (hint === 'use-credentials') credentials = 'include';
  else if (req.mode === 'cors' && req.destination) credentials = req.credentials;
  else return null;
  return { elementCors: true, mode: 'cors', credentials, opaqueOrigin: !!(entry && entry.opaque) };
}
// Enforces Fetch Standard CORS checks, preflights, safelisted headers, and header filtering against the document's virtual origin because the browser sees every proxy response as same-origin.
const CORS_SAFE_RESPONSE_HEADERS = ['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma'];
const CORS_PREFLIGHT_DEFAULT_AGE_S = 5;
const CORS_PREFLIGHT_MAX_AGE_S = 7200;
const CORS_PREFLIGHT_CACHE_CAP = 256;
const corsPreflightCache = new Map();
function corsSafelistedMethod(method) { return method === 'GET' || method === 'HEAD' || method === 'POST'; }
function corsSafeHeaderValue(value) {
  return value.length <= 128 && !/[\u0000-\u0008\u000a-\u001f"():<>?@[\\\]{}\u007f]/.test(value);
}
function corsUnsafeHeaderNames(headers, implicit) {
  const out = new Set();
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (implicit && implicit.includes(lower)) continue;
    let safe = false;
    if (lower === 'accept' || lower === 'accept-language' || lower === 'content-language') safe = corsSafeHeaderValue(value);
    else if (lower === 'content-type') {
      const essence = value.split(';')[0].trim().toLowerCase();
      safe = corsSafeHeaderValue(value) && (essence === 'application/x-www-form-urlencoded' || essence === 'multipart/form-data' || essence === 'text/plain');
    } else if (lower === 'range') safe = /^bytes=\d+-\d*$/.test(value);
    if (!safe) out.add(lower);
  }
  return Array.from(out).sort();
}
function corsTokenList(value) {
  return value ? value.split(',').map(t => t.trim()).filter(Boolean) : [];
}
function corsCheck(headers, requestOrigin, credentials) {
  const allowed = headers.get('access-control-allow-origin');
  if (allowed === null) return false;
  if (!credentials && allowed === '*') return true;
  if (allowed !== requestOrigin) return false;
  return !credentials || headers.get('access-control-allow-credentials') === 'true';
}
function corsExposedHeaders(headers, credentials) {
  const names = new Set(CORS_SAFE_RESPONSE_HEADERS);
  for (const token of corsTokenList(headers.get('access-control-expose-headers'))) {
    const lower = token.toLowerCase();
    if (lower === '*' && !credentials) { for (const name of headers.keys()) names.add(name.toLowerCase()); }
    else if (lower !== '*') names.add(lower);
  }
  return { names: Array.from(names) };
}
// Retains internal `X-ZP-*` control headers while stripping unexposed upstream headers from CORS responses.
function corsFilterHeaders(headers, expose) {
  if (!expose) return;
  const visible = new Set(expose.names);
  for (const name of Array.from(headers.keys())) {
    const lower = name.toLowerCase();
    if (!lower.startsWith('x-zp-') && !visible.has(lower)) headers.delete(name);
  }
}
function corsPreflightAllows(entry, method, names, credentials) {
  const wildcard = list => !credentials && list.includes('*');
  if (!corsSafelistedMethod(method) && !wildcard(entry.methods) && !entry.methods.includes(method)) return false;
  // Match Chromium's behavior of allowing `Authorization` under a wildcard `Access-Control-Allow-Headers: *` when credentials are omitted.
  for (const name of names) if (!entry.headers.includes(name) && !wildcard(entry.headers)) return false;
  return true;
}
async function runCORSPreflight(url, opt, method, names, requestOrigin, credentials) {
  const key = [opt.tab.tabId, requestOrigin, url, credentials ? 1 : 0].join('\n');
  const now = Date.now();
  const cached = corsPreflightCache.get(key);
  if (cached && cached.expires > now && corsPreflightAllows(cached, method, names, credentials)) return true;
  const headers = new Headers();
  headers.set('Accept', '*/*');
  headers.set('Access-Control-Request-Method', method);
  if (names.length) headers.set('Access-Control-Request-Headers', names.join(','));
  const resp = await transportFetchHop(url, Object.assign({}, opt, {
    method: 'OPTIONS', body: null, headers, credentials: 'omit', redirect: 'error', redirectDepth: 0,
    mode: 'cors', preflight: true, cookieDelta: null, collectCookies: false,
  }));
  if (!resp || resp.type === 'error' || resp.status < 200 || resp.status > 299) return false;
  if (resp.body) resp.body.cancel().catch(() => {});
  if (!corsCheck(resp.headers, requestOrigin, credentials)) return false;
  const entry = {
    methods: corsTokenList(resp.headers.get('access-control-allow-methods')),
    headers: corsTokenList(resp.headers.get('access-control-allow-headers')).map(t => t.toLowerCase()),
    expires: 0,
  };
  if (!corsPreflightAllows(entry, method, names, credentials)) return false;
  const maxAgeHeader = resp.headers.get('access-control-max-age');
  const maxAge = maxAgeHeader !== null && /^\d+$/.test(maxAgeHeader.trim()) ? Math.min(parseInt(maxAgeHeader, 10), CORS_PREFLIGHT_MAX_AGE_S) : CORS_PREFLIGHT_DEFAULT_AGE_S;
  if (maxAge > 0) {
    entry.expires = now + maxAge * 1000;
    if (corsPreflightCache.size >= CORS_PREFLIGHT_CACHE_CAP) corsPreflightCache.delete(corsPreflightCache.keys().next().value);
    corsPreflightCache.set(key, entry);
  }
  return true;
}
function isCORSPreflight(req) { return req.method === 'OPTIONS' && req.headers.has('Access-Control-Request-Method'); }
function corsPreflight(req) { const h = new Headers(); applyCORS(h, req); h.set('Access-Control-Max-Age', '86400'); h.set('Cache-Control', 'no-store'); return new Response(null, { status: 204, headers: h }); }
function applyCORS(h, req) {
  // Reflect the concrete request origin so credentialed `mode: 'cors'` requests (such as module worker `import()`) succeed, and omit `Access-Control-Allow-Credentials: true` when falling back to `*`.
  const origin = req && (req.headers.get('Origin') || (req.url ? new URL(req.url).origin : '')) || '*';
  h.set('Access-Control-Allow-Origin', origin);
  if (origin !== '*') {
    h.set('Vary', h.get('Vary') ? h.get('Vary') + ', Origin' : 'Origin');
    h.set('Access-Control-Allow-Credentials', 'true');
  }
  h.set('Access-Control-Allow-Methods', req && req.headers.get('Access-Control-Request-Method') || 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  h.set('Access-Control-Allow-Headers', req && req.headers.get('Access-Control-Request-Headers') || '*');
  h.set('Access-Control-Expose-Headers', '*');
}
// Rewrites the target URL inside a `Refresh` response header into a launcher `?via=` URL so header-driven redirects stay inside the proxy instead of escaping or failing to land.
function proxiedRefreshValue(raw, targetUrl) {
  const s = String(raw || '');
  if (!s) return '';
  const at = s.toLowerCase().indexOf('url=');
  if (at < 0) return s;
  const head = s.slice(0, at);
  let v = s.slice(at + 4).trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
  v = v.trim();
  if (!v || /^javascript:/i.test(v)) return '';
  let abs;
  try { abs = new URL(v, targetUrl).toString(); } catch { return ''; }
  if (!/^https?:/i.test(abs)) return '';
  return head + 'url=' + ORIGIN + ZP.CONTROL_PREFIX + '?via=' + encodeURIComponent(abs);
}
// Target response header strip lists injected from `crates/zp-shared/testdata/response_header_policy.json` at build time.
const ZP_HOP_BY_HOP_HEADERS = __ZP_HOP_BY_HOP_HEADERS__;
const ZP_TARGET_POLICY_HEADERS = __ZP_TARGET_POLICY_HEADERS__;
// Browser reporting headers (`Report-To`, `Reporting-Endpoints`, `NEL`, `Content-Security-Policy-Report-Only`) that trigger out-of-band browser egress bypassing the Service Worker.
const ZP_REPORTING_HEADERS = __ZP_REPORTING_HEADERS__;
// Admits the WebTransport gateway origin in `connect-src` across document headers, meta tags, and worker bootstraps.
function proxiedCSP(servers, challengeCompat, siteFrames) {
  return ZP.fixedCSP(servers || [], {
    challengeCompat: !!challengeCompat,
    siteFrames: !!siteFrames,
    extraConnect: runtimeConfig.wtGateway ? [runtimeConfig.wtGateway] : [],
  });
}
// Enforces the proxy CSP on response headers, strips internal `X-ZP-Challenge-Compat` and out-of-band reporting/navigation/hop-by-hop headers, and rewrites `Refresh` headers to stay within the proxy.
function applyZPSecurityHeaders(h, req, servers, tab, targetUrl) {
  // Attach the virtual target URL alongside `X-ZP-Encoded-Size` or `X-ZP-Stream-Id` so Navigation Timing entries on `/zp/p/<token>` documents match the page's virtual URL.
  try { if (targetUrl && (h.get('X-ZP-Encoded-Size') || h.get('X-ZP-Stream-Id'))) h.set('X-ZP-Encoded-For', targetUrl); } catch {}
  const rawRefresh = h.get('Refresh');
  const responseSignalled = h.get('X-ZP-Challenge-Compat') === '1';
  h.delete('X-ZP-Challenge-Compat');
  const armedHere = !!(tab && tab.challengeCompat) && responseSignalled;
  // The proxy's policy replaces the target's, except that the Trusted Types directives of the target's policies are carried along
  // (each as a policy of its own, so the browser enforces them as it would have): a document that declares them binds the page's
  // string sinks and the membrane's alike, and expects its `default` policy and `createPolicy` name list to be honoured.
  // Only for documents: a worker script's own response CSP governs the worker, whose prelude does not handle Trusted Types sinks.
  const targetCSP = /\b(text\/html|application\/xhtml\+xml)\b/i.test(h.get('Content-Type') || '') ? (h.get('Content-Security-Policy') || '') : '';
  // The target's policy that refuses string evaluation cannot be carried along (the proxy's own has to allow it for the membrane): the document
  // transform, which runs after this, takes it from this internal header and the membrane enforces it for the page.
  const evalRefusal = ZP.evalBlockingPolicy(targetCSP);
  if (evalRefusal) h.set('X-ZP-Eval-CSP', evalRefusal); else h.delete('X-ZP-Eval-CSP');
  h.delete('Content-Security-Policy');
  h.delete('Content-Security-Policy-Report-Only');
  h.delete('X-Content-Security-Policy');
  h.delete('X-WebKit-CSP');
  h.set('Content-Security-Policy', [proxiedCSP(servers, armedHere, tab && tab.siteFrames)].concat(ZP.trustedTypesPolicies(targetCSP)).join(', '));
  for (const name of ZP_REPORTING_HEADERS) h.delete(name);
  for (const name of ZP_TARGET_POLICY_HEADERS) h.delete(name);
  for (const name of ZP_HOP_BY_HOP_HEADERS) h.delete(name);
  if (rawRefresh && targetUrl) {
    const next = proxiedRefreshValue(rawRefresh, targetUrl);
    if (next) h.set('Refresh', next);
  }
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Cache-Control', h.get('Cache-Control') || 'no-store');
  applyCORS(h, req);
  return h;
}
// Relays pre-decompression wire byte counts (`X-ZP-Encoded-Size`) to the requesting client only so Resource Timing reports accurate `encodedBodySize` without leaking target URLs across tabs.
const pendingStreamReports = new Map();
// One-time stash for `blob:`/`data:` worker sources passed via bootstrap URL hash and consumed by `/zp/api/worker-script?srctok=...`.
const workerSrcStash = new Map();
const streamEncodedByUrl = new Map();
// Keep navigation document sizes in a separate FIFO from subresources so bursts of subresource requests cannot evict the document's entry before the page queries it.
const docEncodedByUrl = new Map();
const DOC_ENCODED_CAP = 8;
function isNavigationRequest(req) {
  try { return req.mode === "navigate" || req.destination === "document" || req.destination === "iframe"; } catch { return false; }
}
function recordEncoded(url, size, isDoc) {
  const m = isDoc ? docEncodedByUrl : streamEncodedByUrl;
  m.set(url, size);
  const cap = isDoc ? DOC_ENCODED_CAP : 32;
  if (m.size > cap) m.delete(m.keys().next().value);
}
function deliverStreamEncoded(streamId) {
  if (!streamId) return;
  const pending = pendingStreamReports.get(streamId);
  pendingStreamReports.delete(streamId);
  if (!pending) return;
  const table = self.__zpStreamEncoded;
  const size = table && Number(table[streamId]);
  if (!size) return;
  try { delete table[streamId]; } catch {}
  // Record by URL in addition to pushing via `postMessage` because a navigation's `resultingClientId` may not resolve or have its message listener attached at stream flush time.
  recordEncoded(pending.url, size, !!pending.isDoc);
  self.clients.get(pending.clientId).then(client => {
    if (client) client.postMessage({ type: ZP.MSG.ENCODED_SIZE, url: pending.url, size });
  }).catch(() => {});
}
async function reportEncodedSize(event, resp) {
  try {
    if (!resp || !resp.headers) return resp;
    const streamId = resp.headers.get('X-ZP-Stream-Id');
    const encFor0 = resp.headers.get('X-ZP-Encoded-For');
    if (streamId) {
      const id = event.clientId || event.resultingClientId;
      if (id && encFor0) pendingStreamReports.set(streamId, { clientId: id, url: encFor0, isDoc: isNavigationRequest(event.request) });
      const h2 = new Headers(resp.headers);
      h2.delete('X-ZP-Stream-Id');
      h2.delete('X-ZP-Encoded-For');
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h2 });
    }
    const enc = resp.headers.get('X-ZP-Encoded-Size');
    if (!enc) return resp;
    const headers = new Headers(resp.headers);
    const encFor = resp.headers.get('X-ZP-Encoded-For');
    headers.delete('X-ZP-Encoded-Size');
    headers.delete('X-ZP-Encoded-For');
    const out = new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
    const id = event.clientId || event.resultingClientId;
    // Do not `await clients.get(resultingClientId)` on the response path: a navigation's resulting client only materializes after the response commits, so awaiting it deadlocks `respondWith`.
    if (id) {
      self.clients.get(id).then((client) => {
        if (client) client.postMessage({ type: ZP.MSG.ENCODED_SIZE, url: encFor || encodedSizeKey(event.request.url), size: Number(enc) || 0 });
      }).catch(() => {});
    }
    if (encFor) {
      recordEncoded(encFor, Number(enc) || 0, isNavigationRequest(event.request));
    }
    return out;
  } catch { return resp; }
}
function encodedSizeKey(rawURL) {
  try {
    const u = new URL(rawURL);
    if (u.pathname === ZP.apiPath('fetch') || u.pathname === ZP.apiPath('v2/fetch')) return u.searchParams.get('url') || rawURL;
    if (u.pathname === ZP.apiPath('script') || u.pathname === ZP.apiPath('worker-script') || u.pathname === ZP.apiPath('sourcemap')) {
      return u.searchParams.get('u') || rawURL;
    }
    return rawURL;
  } catch { return rawURL; }
}
function addCSP(resp, req, servers, tab, targetUrl) {
  const h = new Headers(resp.headers);
  applyZPSecurityHeaders(h, req, servers, tab, targetUrl);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}
function safeError(code, status = 400, targetUrl = '') {
  // Extract the leading error code token before `:` so detailed kernel errors (such as `TARGET_HTTP_FAILED: ...`) map to their specific error code instead of falling back to `POLICY_BLOCKED`.
  const detail = String(code == null ? '' : code);
  if (!ZP.ERRORS.includes(detail)) {
    const head = detail.split(':', 1)[0].trim();
    if (ZP.ERRORS.includes(head)) code = head;
  }
  logRefusal(detail, status, targetUrl);
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
      // Marks synthetic proxy error pages so `transformDocumentResponse` does not rewrite them as upstream 4xx/5xx HTML bodies.
      'X-ZP-Error': '1',
      'X-ZP-Error-Code': code,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': '*',
    },
  });
}
function escapeHTML(s) { return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&#34;',"'":'&#39;'}[ch])); }
function workerBootstrap(url) {
  const hashParams = url.hash ? new URLSearchParams(url.hash.slice(1)) : null;
  // A blob or data worker inherits the Trusted Types policies of the document that started it: its membrane lists them as `tt`, and they join this
  // response's CSP so the worker's own sinks are bound as the creator's are. Only Trusted Types directives are taken from the list.
  const tt = hashParams ? ZP.trustedTypesPolicies(hashParams.getAll('tt').join(', ')) : [];
  // Where the worker enforces them, the bootstrap makes the policy its prelude hands Trusted values from and loads its scripts through it.
  const ttHead = tt.length
    ? "self.__ZP_WORKER_TT=" + JSON.stringify(tt) + ";try{self.__ZP_WORKER_TP=self.trustedTypes.createPolicy(" + JSON.stringify(ZP.TT_POLICY_NAME) + ",{createScript:function(s){return s},createScriptURL:function(s){return s}})}catch(e){}"
    : '';
  const ttOpen = tt.length ? "(function(){var tp=self.__ZP_WORKER_TP;var tu=function(s){return tp?tp.createScriptURL(s):s};" : '';
  const ttClose = tt.length ? "})();" : '';
  const U = expr => tt.length ? 'tu(' + expr + ')' : expr;
  // Wrap bootstrap state initialization in an IIFE so top-level bindings do not pollute a classic worker's global lexical scope.
  const head = "(function(){var p=new URLSearchParams(self.location.hash.slice(1));self.__ZP_WORKER_TARGET=p.get('u')||'about:blank';self.__ZP_WORKER_REF=p.get('ref')||'';self.__ZP_WORKER_TAB_ID=p.get('tab')||'';self.__ZP_WORKER_SERVERS=p.getAll('server');self.__ZP_WORKER_SRC_URL=p.get('srcu')||'';self.__ZP_WORKER_WT_GATEWAY=p.get('wtg')||'';self.__ZP_WORKER_WT_GATEWAY_HASHES=p.getAll('wtgh');try{self.__ZP_WORKER_RTC_ICE=JSON.parse(p.get('ice')||'[]')}catch(e){self.__ZP_WORKER_RTC_ICE=[]}" + ttHead + "})();";
  // Module workers lack `importScripts`, so chain `import()` calls sequentially through `zp-core`, `zp-page-bundle`, `worker-prelude`, and the target script.
  const mod = hashParams && hashParams.get('mod') === '1';
  const src = hashParams ? hashParams.get('src') : null;
  const srcu = hashParams ? hashParams.get('srcu') : null;
  let scriptURL = "'/zp/api/worker-script?tab=' + encodeURIComponent(self.__ZP_WORKER_TAB_ID) + '&u=' + encodeURIComponent(self.__ZP_WORKER_TARGET)" + (mod ? " + '&kind=module'" : "");
  if (src != null) {
    const tok = ZP.randomId('ws');
    workerSrcStash.set(tok, src);
    scriptURL = "'/zp/api/worker-script?srctok=" + tok + "&tab=' + encodeURIComponent(self.__ZP_WORKER_TAB_ID) + '&u=' + encodeURIComponent(self.__ZP_WORKER_TARGET)" + (mod ? " + '&kind=module'" : "");
  }
  const body = srcu != null
    ? (mod
      ? head + "import('/zp/assets/zp-core.js?v=__ZP_BUILD_ID__').then(function(){return import('/zp/assets/zp-page-bundle.js?v=__ZP_BUILD_ID__').catch(function(){})}).then(function(){return import('/zp/assets/worker-prelude.js?v=__ZP_BUILD_ID__')}).catch(function(e){setTimeout(function(){throw e},0)});"
      : head + ttOpen + "importScripts(" + U("'/zp/assets/worker-prelude.js?v=__ZP_BUILD_ID__'") + ");try{importScripts(" + U("'/zp/assets/zp-page-bundle.js?v=__ZP_BUILD_ID__'") + ")}catch(e){};if(self.__zp_settle)self.__zp_settle();if(self.__zp_runSrcu)self.__zp_runSrcu();" + ttClose)
    : (mod
      ? head + "var __zp_script_url=" + scriptURL + ";import('/zp/assets/zp-core.js?v=__ZP_BUILD_ID__').then(function(){return import('/zp/assets/zp-page-bundle.js?v=__ZP_BUILD_ID__').catch(function(){})}).then(function(){return import('/zp/assets/worker-prelude.js?v=__ZP_BUILD_ID__')}).then(function(){return import(__zp_script_url)}).catch(function(e){setTimeout(function(){throw e},0)});"
      : head + ttOpen + "importScripts(" + U("'/zp/assets/worker-prelude.js?v=__ZP_BUILD_ID__'") + ");try{importScripts(" + U("'/zp/assets/zp-page-bundle.js?v=__ZP_BUILD_ID__'") + ")}catch(e){};if(self.__zp_settle)self.__zp_settle();importScripts(" + U(scriptURL) + ");" + ttClose);
  // Emit `Cross-Origin-Embedder-Policy: require-corp` on the worker bootstrap response so workers spawned by COEP-isolated documents (`require-corp` or `credentialless`) are not blocked by the browser.
  return new Response(body, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': [proxiedCSP([], false)].concat(tt).join(', '), 'Cross-Origin-Embedder-Policy': 'require-corp', 'X-Content-Type-Options': 'nosniff' } });
}

