/* ZeroProxy Service Worker: controlled network requests are routed through the Rust WASM kernel. */
importScripts('/zp/assets/zp-core.js?v=__ZP_BUILD_ID__');
// 2026-06-08 split-bundle (c.1) Step 4: legacy rewriter-rs/ deleted. Both
// JS and CSS rewriters live on ZPBundle (modern, single source of truth).
// Rust zp-bundle (no-modules variant). Must be imported at top-level: SW
// `importScripts` only succeeds during initial script evaluation; lazy
// import from inside an event handler is blocked by the worker spec and
// fails with "failed to load" even if the URL is served correctly.
importScripts('/__zp/zp_bundle_sw.js?v=__ZP_BUILD_ID__');
// 2026-06-08 split-bundle (c.3): kernel/transport WASM glue is split into
// its own bundle so the heavy stack (rustls + h2 + yamux + mlkem + tokio
// + decoders + membrane/rtcgw/wtproxy) only instantiates on the first
// upstream fetch. The JS *glue* (~tens of KB) is loaded eagerly here at
// top level because importScripts is unavailable later; the actual wasm
// (~MB) is fetched + instantiated lazily inside `initKernel()`.
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

// 2026-06-09 perf telemetry: per-SW-lifetime counters surfaced via the
// `__zpKernelProbe` diagnostic message. Production tuning + trap
// notebook entries reference these — e.g. "NAVER load: cache hits
// 12/19, total rewrite latency 540 ms" pins exactly where the cold
// path spent CPU. Counters reset on SW activate (intentional —
// they're per-session, not persistent).
const rewriteStats = {
  hits: 0,
  misses: 0,
  // Cumulative `self.ZPBundle.rewriteScript` wall time in ms (cold path).
  rewriteLatencyMs: 0,
  // Cumulative `crypto.subtle.digest` wall time in ms (cache-key SHA-256).
  // High ratio of this vs rewriteLatencyMs flags the cache key as a
  // pessimization — every cold-path call pays it even when the result
  // is later cached.
  cacheKeyLatencyMs: 0,
  // Number of `rewriteScriptResponse` invocations (== cache lookups).
  invocations: 0,
};

// 2026-06-09 transport header debug ring buffer. Captures the last
// N outgoing `transportFetch` header arrays so the probe can dump
// what we're sending upstream to an anti-bot WAF. Comparing this to
// real-Chrome capture (e.g. wireshark / chrome://net-export) is the
// fastest way to spot a header gap that triggers a 403. Bounded to
// MAX_HEADER_LOG to avoid unbounded memory growth.
const MAX_HEADER_LOG = 16;
const outgoingHeaderLog = [];

// 2026-08-13 — 거절당한 요청을 스스로 신고하게 만든다.
//
// SW 가 단일 관문이므로, 프록시가 무언가를 못 살려 준 순간은 **전부** 여기를
// 지난다. 그런데 서브리소스 실패는 페이지 콘솔에 아무것도 남기지 않아서,
// 지금까지는 "화면이 이상하다" → 스크린샷 분석 → DOM 뒤지기 순서로 눈으로
// 찾아야 했다 (NAVER 장바구니의 Braze 오버레이가 그랬다). 거절 사유를 URL·
// 클라이언트와 함께 남겨 두면 그 과정이 목록 조회 한 번으로 끝난다.
// 페이지에서는 `__zp_refusals()` 로 읽는다.
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
  outgoingHeaderLog.push({
    ts: Date.now(),
    target: String(targetUrl).slice(0, 256),
    method,
    headers: entries.map(([k, v]) => [k, String(v).slice(0, 256)]),
  });
  while (outgoingHeaderLog.length > MAX_HEADER_LOG) outgoingHeaderLog.shift();
}

// 2026-06-09 transport-stage perf telemetry. NAVER cold load 1분 분석에서
// rewriter는 1.1% (679 ms / 60 s) 라는 것이 확인됨. 나머지 99% 는
// transport (yamux+TLS+h2 핸드셰이크 + sub-resource fetch). 어느 fetch가
// 무거운지 알아야 다음 최적화 (parallel/preload/connection-pooling) 가
// 의미가 있음. ring buffer 는 마지막 N 개 fetch 만 보관 — 누적
// 카운터는 SW lifetime 전체. logTransportEvent 는 transportFetch 가
// self.kernelFetch 완료 후 호출 — 즉 핸드셰이크+body 합산 wall time.
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
// 2026-06-07 split-bundle (c.1) Step 2.0: activate 가 initBundle 을 실제로
// await (이전엔 fire-and-forget). SW 가 activated 상태로 진입할 때 ZPBundle.ready
// 가 보장됨 → 첫 fetch 가 cold-init latency 없이 즉시 ZPBundle 사용 가능. 30s
// timeout 으로 wasm fetch 가 실패해도 activate 가 stuck 되지 않도록 보호.
// 그래도 ZPBundle.ready 가 false 면 hot-path 가 `await initBundle()` 재시도.
// 동기 XHR 중계 — SW 쪽 소비자.
//
// SW 는 동기 XHR 을 **가로채지 못한다**(실측: 같은 페이지·같은 URL 에서 동기
// XHR 은 Go 까지 내려가 403, 비동기 fetch 는 SW 가 503). 그래서 페이지는
// 동기 XHR 을 same-origin 엔드포인트로 던지고, Go 가 그 응답을 park 한 채
// 여기로 작업을 넘긴다. 실제 전송은 기존 `transportFetch` 가 그대로 하므로
// egress 경로도 TLS/HTTP 지문도 달라지지 않는다.
//
// 페이지 메인 스레드가 동기 XHR 로 막혀 있어도 SW 는 별도 스레드라 돌 수 있다 —
// 그게 이 구조가 성립하는 이유다.
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
      // 서버가 잠깐 없을 수 있다. 조금 쉬고 다시 연다.
      await new Promise(res => setTimeout(res, 1000));
      continue;
    }
    if (!batch) continue;                      // 204 = 빈손, 즉시 재연결
    // 서버가 큐에 쌓인 잡을 묶어서 준다. 낡은 서버는 단일 객체를 주므로
    // 양쪽 다 받는다.
    const jobs = Array.isArray(batch) ? batch : [batch];
    for (const job of jobs) handleSyncFetchJob(job).catch(() => {}); // 다음 폴을 막지 않는다
  }
}

// 탭 등록은 페이지 로드와 **경쟁**한다. 인라인 스크립트가 아주 이른 시점에
// 동기 XHR 을 던지면 그 탭이 아직 `tabs` 에 없을 수 있다(실측: 같은 하네스에서
// 어떤 런은 성공, 어떤 런은 SW_NOT_READY). 짧게 기다렸다 다시 보고,
// 그래도 없으면 탭이 하나뿐일 때는 그것을 쓴다.
async function resolveSyncTab(tabId) {
  for (let i = 0; i < 20; i++) {
    const t = tabId && tabs.get(tabId);
    if (t) return t;
    if (!tabId && tabs.size === 1) return tabs.values().next().value;
    await new Promise(r => setTimeout(r, 100));
  }
  if (tabs.size === 1) return tabs.values().next().value;
  return null;
}

// HTTP 헤더 값에 넣어도 안전한 형태로 줄인다. 개행이 섞이면 헤더 인젝션이
// 되고, 비ASCII 는 fetch 가 거부한다.
function headerSafe(v) {
  return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
}
function utf8Base64(s) {
  const bytes = new TextEncoder().encode(String(s));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function handleSyncFetchJob(job) {
  // 릴레이 버전. 브라우저가 낡은 SW 를 물고 있는지 응답만 보고 가리기 위한 것 —
  // 이걸 안 실으면 "내 코드가 틀렸나" 와 "SW 가 낡았나" 를 구분할 수 없다.
  const out = { id: job.id, v: 'r4', status: 0, statusText: '', headers: [], body: null, err: '' };
  try {
    const tab = await resolveSyncTab(job.tab);
    if (!tab) throw new Error('SW_NOT_READY tab=' + (job.tab || '(none)') + ' known=' + tabs.size);
    let resp = await transportFetch(job.target, {
      method: job.method || 'GET',
      headers: Array.isArray(job.headers) ? job.headers : [],
      tab,
      entryId: job.entry || tab.activeEntryId,
    });
    // ★릴레이는 `transportFetch` 를 직접 부르므로 `/zp/api/fetch` 핸들러가
    // 하던 후처리를 못 탄다. 동기 XHR 은 원본 바이트를 원해서 문제가 없었지만,
    // SW-less 프레임의 `<link>`/`<script>` 가 이 경로로 오면서 필요해졌다 —
    // 리라이트가 빠지면 CSS 의 `url(../img.png)` 이 릴레이 URL 을 base 로
    // 해석돼 전부 깨진다.
    if (job.kind === 'style') resp = await rewriteCSSResponse(resp, { targetUrl: job.target });
    else if (job.kind === 'script') resp = await rewriteScriptResponse(resp, { targetUrl: job.target, kind: 'classic' });
    out.status = resp.status;
    out.statusText = resp.statusText || '';
    try { resp.headers.forEach((v, k) => out.headers.push([k, v])); } catch {}
    // ★바이트를 그대로 넘긴다. 예전에는 여기서 base64 문자열을 만들었는데,
    // 서브리소스를 전부 이 경로로 보내자 그 비용이 SW 스레드에 몰려 다른 잡이
    // 밀렸다(실측: deadSheets 2~4). 본문 크기도 33% 줄어든다.
    out.body = await resp.arrayBuffer();
  } catch (e) {
    out.err = String((e && e.message) || e || 'error');
    // 상류 실패 이유는 Go 가 버리므로 여기서 흘려 둔다. SW 콘솔은
    // `dump-recording --filter console` 로 회수되고, 렌더러가 굳어도 남는다.
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
        // 응답 헤더는 작아서 한 줄에 실어도 된다. 다만 HTTP 헤더 값은 ASCII 만
        // 안전하므로(Content-Language 등에 비ASCII 가 올 수 있다) base64 로 싣는다.
        'X-ZP-Sync-Headers': utf8Base64(JSON.stringify(out.headers || [])),
      },
      body: out.body || new ArrayBuffer(0),
      cache: 'no-store',
    });
  } catch {}
}

// 스크립트 평가 시점에도 시작한다. Service Worker 는 유휴 시 종료됐다가 이벤트로
// 되살아나는데, 그때 `activate` 는 다시 발생하지 않는다. activate 에서만 걸어두면
// 되살아난 SW 는 폴링을 하지 않아 동기 XHR 이 전부 타임아웃된다.
syncFetchRelayLoop();

self.addEventListener('activate', event => event.waitUntil((async () => {
  await self.clients.claim();
  syncFetchRelayLoop();   // 의도적으로 await 하지 않는다 — 영구 루프다(중복 호출은 플래그로 막힌다).
  const BUNDLE_BOOT_TIMEOUT_MS = 30000;
  await Promise.race([
    initBundle().catch(() => null),
    new Promise(r => setTimeout(r, BUNDLE_BOOT_TIMEOUT_MS)),
  ]);
  // D4: refresh the runtime config (currently just the public WT
  // gateway URL). Bounded + fire-and-forget — if the endpoint hangs or
  // returns garbage the page-side virtual WT just falls back to the
  // rejected stub, which is fine.
  await Promise.race([
    refreshRuntimeConfig().catch(() => null),
    new Promise(r => setTimeout(r, 5000)),
  ]);
})()));

// Runtime config the SW threads into the boot JSON every navigation.
// Refreshed on each activate (and lazily on demand if a navigation
// arrives before activate completes). The endpoint is plain JSON
// served from the Go control plane (`/zp/api/config`).
let runtimeConfig = { wtGateway: '', rtcGateway: '', rtcICEServers: [] };
let runtimeConfigPromise = null;
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
            rtcGateway: typeof cfg.rtcGateway === 'string' ? cfg.rtcGateway : '',
            // Each /zp/api/config response carries a fresh TURN-REST cred
            // tuple (when -rtc-turn-addr is set on the server). The
            // tuple is opaque to the SW — it's pasted into the boot JSON
            // and consumed by runtime-prelude's ZPRTCPeerConnection.
            rtcICEServers: Array.isArray(cfg.rtcICEServers) ? cfg.rtcICEServers : [],
          };
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
  // Only intercept http(s). Non-http schemes — chrome-extension: (a browser
  // extension's own injected-script channel), data:, blob:, about: — must
  // reach the browser's NATIVE handler untouched. Calling respondWith on them
  // routes through classify→UNKNOWN→`Response.error()`, which surfaces as
  // "FetchEvent ... resulted in a network error response" and breaks the
  // extension (observed on NAVER: content.js "Failed to establish injected
  // script channel"). Returning without respondWith = browser default fetch.
  const u = event.request.url;
  if (!u.startsWith('http:') && !u.startsWith('https:')) return;
  const responded = handleFetch(event);
  event.respondWith(responded);
  // Keep the worker alive until the response BODY has been fully delivered.
  // `respondWith` only extends the lifetime until the response PROMISE
  // settles; for a streaming document that is immediate (headers + an unread
  // ReadableStream), after which Chrome is free to terminate the worker while
  // the wasm pump still owes the page most of the HTML. Symptom: document
  // frozen mid-parse (NAVER at ~33 KB, readyState never reaching complete),
  // zero CPU, and CDP unable to attach to the worker — the stall that looked
  // for many sessions like NAVER anti-bot but was ours. `streamDocumentResponse`
  // attaches `__zpBodyDone`; non-streaming responses have none and resolve now.
  event.waitUntil(responded.then(r => (r && r.__zpBodyDone) || undefined).catch(() => undefined));
});

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
// 2026-08-16 갱신 — signatureSchemes 앞에 2308/2309/2310 (ML-DSA 44/65/87) 추가.
// 측정 근거: tls.peet.ws/api/all 을 같은 브라우저로 프록시 경유 vs 직접 재보니
// peetprint 8개 필드 중 **signature_algorithms 하나만** 달랐다.
//   직접  : 2308-2309-2310-1027-2052-1025-1283-2053-1281-2054-1537
//   프록시:                1027-2052-1025-1283-2053-1281-2054-1537
// ja4 도 cipher 부분(8daaf6152771)은 같고 확장/시그 해시만 달랐다
// (d8a2da3f94cd vs 806a8c22fdea). 즉 우리 wire 는 2026-07-03 에 "Chrome 완전
// 일치" 를 찍은 그대로인데 **Chrome 이 그 사이에 움직였다** — 동결된 스펙은
// 시간이 지나면 저절로 틀려진다는 뜻이고, 이 blob 은 주기적으로 재측정해야 한다.
// ja3_hash 는 실행마다 다른데 그건 회귀가 아니다: Chrome 은 확장 순서를 매
// 연결 섞으므로 ja3 는 원래 불안정하다(peetprint/ja4 는 정렬해서 해싱한다).
// 리스크: 우리가 검증할 수 없는 서명 알고리즘을 광고한다. 서버가 실제로
// ML-DSA 로 서명하면 검증에 실패하지만, 오늘 공개 CA 는 그런 인증서를 발급하지
// 않는다(Chrome 도 같은 목록을 광고한다).
// 2026-08-18 — extensions 에서 **17613 (ALPS, application_settings) 제거**.
// 이건 지문 정확도를 일부러 포기한 것이다. 이유:
//   Chrome 은 ALPS 를 광고하고, 서버가 협상하면 TLS 1.3 EncryptedExtensions
//   로 세팅을 주고받는다. 우리 TLS 스택은 ALPS 를 **구현하지 않았다**
//   (transport/tls.rs 의 phase 2 는 아직 pending). 그런데 캡처한 Chrome
//   ClientHello 를 그대로 재생하다 보니 "지원한다" 고 광고만 하고 있었다.
//   대부분의 서버는 ALPS 를 모르고 무시하지만 **Google GFE 는 실제로 협상한다**
//   — 그래서 핸드셰이크와 h2 SETTINGS 까지 멀쩡히 끝난 뒤, 응답을 읽는 도중
//   서버가 `unexpected_message` fatal alert 를 보내고 연결이 죽었다.
//   증상: ajax.googleapis.com / googletagmanager / doubleclick / accounts.google
//   전부 502. 광고·분석·폰트·로그인 위젯이 걸린 사이트가 통째로 반쪽이 된다.
// 이등분으로 확정했다: 17613 만 빼면 통과, 65037(ECH) 을 빼는 건 무관,
// signatureSchemes 를 되돌리는 것도 무관.
// **광고만 하고 못 지키는 확장은 지문 일치보다 나쁘다** — 연결 자체가 죽는다.
// 제대로 된 해법은 ALPS 를 구현하는 것(rustls fork)이고, 그때 이 줄을 되돌린다.
const CAPTURED_FINGERPRINT_B64 = 'eyJzdXBwb3J0ZWRWZXJzaW9ucyI6Wzc3Miw3NzFdLCJjaXBoZXJTdWl0ZXMiOls0ODY1LDQ4NjYsNDg2Nyw0OTE5NSw0OTE5OSw0OTE5Niw0OTIwMCw1MjM5Myw1MjM5Miw0OTE3MSw0OTE3MiwxNTYsMTU3LDQ3LDUzXSwiZXh0ZW5zaW9ucyI6WzAsNTEsNjUyODEsNDMsMTYsNSwxMSwxMywxOCwyMywyNywxMCwzNSw0NSw2NTAzN10sInN1cHBvcnRlZEN1cnZlcyI6WzQ1ODgsMjksMjMsMjRdLCJzdXBwb3J0ZWRQb2ludHMiOiJBQT09Iiwic2lnbmF0dXJlU2NoZW1lcyI6WzIzMDgsMjMwOSwyMzEwLDEwMjcsMjA1MiwxMDI1LDEyODMsMjA1MywxMjgxLDIwNTQsMTUzN10sImFscG5Qcm90b2NvbHMiOlsiaDIiLCJodHRwLzEuMSJdfQ==';
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
    await wbg({ module_or_path: '/__zp/zp_bundle_sw_bg.wasm?v=__ZP_BUILD_ID__' });
    // CRITICAL: `wbg` (the wasm-bindgen factory function) carries the JS
    // glue wrappers as own properties (Object.assign(__wbg_init, {...exports}))
    // — those wrappers do addHeapObject/takeObject. The factory's return
    // value is the raw `wasm.exports` table, which takes/returns ints
    // (heap indices) directly and would mishandle JS objects. Always read
    // through wbg.<name>, never through the awaited factory result.
    //
    // 2026-06-08 split-bundle (c.3): kernel* names moved to `self.ZPKernel`
    // (instantiated by `initKernel()` on first upstream fetch). The eager
    // `ZPBundle` surface no longer carries `kernel{Init,Fetch,Stream,
    // EchoSync,LastNamedGroups,Version}` — call sites await `initKernel()`
    // and read from `self.ZPKernel` / `self.kernelFetch` instead.
    self.ZPBundle = Object.freeze({
      ready: true,
      bundleVersion: wbg.bundleVersion,
      // proxyOrigin (= this worker's own ORIGIN) makes rewritten dynamic-import
      // URLs absolute. Root-relative ones resolve against the IMPORTING
      // context's base, which the membrane virtualises to the target host — an
      // inline script then imported https://<target>/zp/api/script?… and got
      // the target's 404 (NAVER ad SDK: 'initAd is not defined').
      rewriteScript: (source, kind, targetUrl) => wbg.rewriteScript(source, kind || 'classic', targetUrl || '', ORIGIN),
      // Patch-mode emit: returns `{"len":N,"patches":[{start,end,replacement},…]}`
      // as a JSON string. Caller applies patches over the original source it
      // already holds — skips the O(n) full re-emit + cross-ABI string copy.
      // Optional (export missing on older bundles → SW falls back to full path).
      rewriteScriptPatches: typeof wbg.rewriteScriptPatches === 'function'
        ? (source, kind, targetUrl) => wbg.rewriteScriptPatches(source, kind || 'classic', targetUrl || '', ORIGIN)
        : null,
      transformHtml: (html, targetUrl) => wbg.transformHtml(html, targetUrl || '', ORIGIN),
      // Phase C streaming render: the wasm-bindgen `HtmlTxn` class. `new
      // ZPBundle.HtmlTxn(targetUrl, ORIGIN, preludeHTML)` then feed decoded
      // HTML byte chunks via `.write(Uint8Array)` and finish with `.end()`.
      // Optional (older bundles lack it → SW stays on the buffered path).
      HtmlTxn: typeof wbg.HtmlTxn === 'function' ? wbg.HtmlTxn : null,
      // 2026-06-08 split-bundle (c.1) Step 4: CSS rewriter ported here from
      // rewriter-rs/. Mirrors the legacy `rewriteCSS` surface (positional
      // args, throws on parse failure).
      // `proxyOrigin` defaults to this worker's own origin (ORIGIN), so the
      // emitted /zp/api/fetch references are absolute and resolve correctly
      // no matter what base the consuming context has. Root-relative ones
      // resolved against the membrane's VIRTUAL base (the target origin) and
      // 404'd for every target — fonts and sprites just vanished. Derived at
      // runtime, so it follows whatever host/port the proxy is served on.
      rewriteCSS: (source, baseUrl, controlPrefix, proxyOrigin) =>
        wbg.rewriteCSS(source, baseUrl || '', controlPrefix || '/zp/', proxyOrigin === undefined ? ORIGIN : (proxyOrigin || '')),
      // D2: unchained composer (rewriter_map only). Required by
      // /zp/api/sourcemap when no upstream `.map` is present.
      composeSourceMap: (source, kind, targetUrl) =>
        wbg.composeSourceMap(source, kind || 'classic', targetUrl || '', ORIGIN),
      // D2 follow-on: chained composer (rewriter_map ∘ original_map).
      // Optional on older bundles; the SW falls back to the unchained
      // composer when missing or when no upstream map exists.
      composeSourceMapChained: typeof wbg.composeSourceMapChained === 'function'
        ? (source, kind, targetUrl, originalMapJson) =>
            wbg.composeSourceMapChained(source, kind || 'classic', targetUrl || '', originalMapJson || '', ORIGIN)
        : null,
      buildCSP: (wsOrigin) => wbg.buildCSP(wsOrigin || ''),
    });
  })().catch(err => { bundlePromise = null; throw err; });
  return bundlePromise;
}

// 2026-06-08 split-bundle (c.3): kernel/transport half — fetched +
// instantiated lazily on first upstream fetch. The JS glue was already
// loaded by the top-level `importScripts('/__zp/zp_kernel_sw.js?v=__ZP_BUILD_ID__')` (no
// way to importScripts later — worker spec forbids it), but the actual
// `zp_kernel_sw_bg.wasm` (multi-MB rustls + h2 + yamux + mlkem +
// decoders) only crosses the network when something actually needs to
// talk upstream.
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
    // Expose the Rust kernel under the globals the SW transport path
    // probes. Call directly (no wrapper) so the JsValue ABI ref doesn't
    // get dropped between page and WASM.
    if (typeof self.ZPKernel.kernelFetch === 'function') {
      self.kernelFetch = self.ZPKernel.kernelFetch;
    }
    if (typeof self.ZPKernel.kernelStream === 'function') {
      self.kernelStream = self.ZPKernel.kernelStream;
    }
    if (typeof self.ZPKernel.kernelInit === 'function') {
      try { self.ZPKernel.kernelInit(); } catch {}
    }
    // Hand the captured spec to the kernel before the first upstream
    // fetch finishes resolving. The rustls fork's hardcoded Chrome 134
    // fallback covers the race window if a kernel_fetch fires before
    // this resolves.
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
    const clientId = event.resultingClientId || event.clientId;
    const cls = classify(req, url, clientId);
    switch (cls.kind) {
      case 'INTERNAL_ASSET': return internalAsset(req, url);
      case 'PROXY_DOCUMENT': return proxyDocument(req, cls, clientId);
      case 'RUNTIME_API': return runtimeAPI(req, url, clientId);
      case 'VIRTUAL_SUBRESOURCE': return virtualSubresource(req, cls, clientId);
      // 204 rather than a 1x1 image: "no icon", stated once and cached, so the
      // browser stops asking and nothing is logged.
      case 'BLANK_ICON': return new Response(null, { status: 204, headers: { 'cache-control': 'max-age=86400' } });
      // 여기가 "프록시가 못 살려 준" 요청이 실제로 죽는 자리다. 서브리소스는
      // `Response.error()` 라 페이지 콘솔에 사유가 남지 않으므로 반드시 남긴다
      // — 이 한 줄이 "화면이 이상하다" 를 URL 목록으로 바꾼다.
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
    // A2 hardening: same-origin sub-resources must resolve a tab from an
    // explicit signal (Referer-derived ctx or saved clientContext). No
    // first-available-tab fallback — multi-tab leak risk.
    const ctx = contextFor(req, clientId);
    const p = parseSharePath(url.pathname);
    if (p && req.mode === 'navigate') return { kind: 'PROXY_DOCUMENT', ...p };
    if (ctx) {
      // 프록시 오리진의 "우리 것이 아닌" 경로 = 타깃 코드가 URL 을 **문서
      // 기준**으로 해석한 결과다. 대표적으로 런타임에 주입된 CSS:
      //   style.textContent = '#a{background:url(/img/bg.png)}'
      // 브라우저 CSS 엔진이 문서 URL 기준으로 풀기 때문에 프록시 오리진의
      // `/img/bg.png` 로 나온다. htmltx 는 네트워크에서 온 바이트만 고치고
      // 멤브레인은 CSS 엔진의 URL 해석에 손댈 수 없으므로, 이 경로를 여기서
      // 받아 주지 않으면 런타임 CSS 서브리소스는 전부 죽는다 (실측: 루트상대
      // <style>/insertRule/el.style/@font-face/adoptedStyleSheets 5종).
      //
      // ctx 가 있으면 타깃이 이미 확정돼 있으므로 `api/fetch?url=` 로 도는
      // 것과 권한이 같다 — 새로 열리는 문은 없다. ctx 가 없으면 아래 UNKNOWN
      // 으로 떨어진다: 탭은 절대 추측하지 않는다 (A2).
      if (url.pathname.startsWith(ZP.CONTROL_PREFIX)) {
        // `/zp/…` 로 나온 건 위의 정상 경로와 달리 **증상**이다: 타깃 코드가
        // 우리 내부 URL 을 손에 넣어 거기에 상대 경로를 풀었다는 뜻
        // (예: `/zp/api/script?u=…` 로 서빙된 모듈이 `./x.js` 를 `/zp/api/`
        // 기준으로 해석). 아래 매핑은 우리 내부 경로 모양을 업스트림에 흘리고
        // 십중팔구 404 로 끝난다. 누가 쐈는지 남겨 두면 발신자를 특정할 수 있다.
        try {
          (self.__zpRustTrace = self.__zpRustTrace || []).push(
            `sw:zp-path-as-subresource ${url.pathname} search=${String(url.search || '(none)').slice(0, 120)} dest=${req.destination || '?'} mode=${req.mode || '?'} initiator=${String(req.referrer || '(none)').slice(-160)} ref=${String(req.headers.get('Referer') || '(none)').slice(-160)}`
          );
        } catch {}
      }
      return { kind: 'VIRTUAL_SUBRESOURCE', ctx, sameOriginURL: url };
    }
    if (p && shareRoutes.has(p.routeKey)) return { kind: 'PROXY_DOCUMENT', ...p };
    // The browser's own tab-icon request: proxy origin, `/favicon.ico`, and no
    // client behind it (browser chrome issues it, not a document). It therefore
    // resolves no ctx, lands in UNKNOWN and gets `Response.error()` — a console
    // network error on every proxied page plus a broken tab icon.
    //
    // Answer it locally and empty. Asking the TARGET for an icon is not an
    // option: icon links are deliberately stripped (`x-zeroproxy-icon`) so the
    // tab cannot identify the site being browsed, and honouring this request
    // upstream would reintroduce exactly that. There is no local icon file
    // either (`build.mjs` copies one only if present, and none ships).
    //
    // Only the client-less case is claimed. A page-initiated `/favicon.ico`
    // (`<img src="/favicon.ico">`) resolves a ctx and keeps going through the
    // normal subresource path — that one IS the target's business.
    if (url.pathname === '/favicon.ico' && !ctx) return { kind: 'BLANK_ICON' };
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
  return path === ZP.assetPath('zp-core.js') || path === ZP.assetPath('zp-page-bundle.js') || path === ZP.assetPath('runtime-prelude.js') || path === ZP.assetPath('worker-prelude.js') || path === ZP.controlPath('worker-bootstrap.js') || path === ZP.assetPath('favicon.ico') || path === ZP.assetPath('manifest.webmanifest');
}
function isRuntimeAPIPath(path) {
  return path === ZP.apiPath('fetch') || path === ZP.apiPath('script') || path === ZP.apiPath('worker-script') || path === ZP.apiPath('sourcemap') || path === '/zp/api/diag/trace';
}

async function internalAsset(req, url) {
  if (url.pathname.startsWith(ZP.controlPath('error/'))) return safeError(decodeURIComponent(url.pathname.split('/').pop() || 'POLICY_BLOCKED'), 400);
  if (url.pathname === ZP.controlPath('worker-bootstrap.js')) return workerBootstrap(url);
  if (url.pathname === ZP.CONTROL_PREFIX || url.pathname === ZP.controlPath('index.html')) return addCSP(await nativeFetch(req, { cache: 'no-store' }), req);
  if (!internalPath(url.pathname) && url.pathname !== ZP.controlPath('sw.js')) return safeError('POLICY_BLOCKED', 403);
  // 2026-08-14 — 내부 에셋은 HTTP 캐시를 쓰게 둔다.
  //
  // 여기서 `cache: 'no-store'` 를 강제하면 Go 가 `no-cache` 를 줘도 소용이
  // 없다 — SW 의 이 fetch 가 브라우저 캐시를 통째로 우회하므로 조건부 요청이
  // 나가지 않는다. 실측: 서버 헤더만 고쳤을 때 2회차 로드도 여전히 200 × 9.
  // 기본 모드로 두면 Last-Modified 기반 재검증이 살아나 304 로 끝난다.
  // 신선도는 그대로다 — `no-cache` 는 매번 재검증을 강제한다.
  //
  // `sw.js` 는 Go 가 여전히 `no-store` 를 주므로 여기 분기가 필요 없다:
  // 업데이트 방아쇠 경로는 서버 헤더로만 통제한다.
  return addCSP(await nativeFetch(req), req);
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
  // SW-less 프레임(document.write / about:blank)의 `<link>` 를 부모가 대신
  // 받아 blob 으로 물려줄 때 쓰는 신호. 그 fetch 는 destination 이 'empty' 라
  // 위 판정을 못 타는데, 리라이트가 빠지면 `url(...)` 이 상대경로로 남아
  // blob: 을 base 로 해석돼 배경이 전부 깨진다.
  if (req.headers.get('X-ZP-Style-Request') === '1') return true;
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
    // 2026-06-08 split-bundle (c.1) Step 4: CSS rewriter ported to ZPBundle
    // (SWC-based, same surface). The legacy ZPRewriter is being deleted in
    // this step; the wbg wrapper exposes `rewriteCSS(source, base_url,
    // control_prefix)` (positional) which throws a `CSS_PARSE_FAILED`
    // JsError on parse failure — both cases fall through to ship the
    // original body.
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
    // 2026-06-08 split-bundle (c.3): kernel surface moved to `self.ZPKernel`.
    // Only available after the kernel wasm has been lazy-instantiated by
    // a prior `transportFetch`; if not yet, just leave the field empty.
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
    // 페이지가 요청 시점의 가상 문서 URL 을 실어 보낸다 — entry.baseUrl 은
    // history.replaceState 직후 같은 틱 요청에서 낡아 있을 수 있다.
    const refOverride = url.searchParams.get('ref') || '';
    const kind = url.searchParams.get('kind') || 'classic';
    const scriptCtx = contextFor(req, clientId);
    const explicitTab = url.searchParams.get('tab') && tabs.get(url.searchParams.get('tab'));
    const tab = explicitTab || (scriptCtx && tabs.get(scriptCtx.tabId));
    if (!target || !tab) return safeError('SW_NOT_READY', 503);
    // NAVER anti-bot (WTM / nCaptcha) — 차단은 **전부 걷혔다**(2026-08-12).
    //
    // 그동안 이 자리에 wtm/ncpt 스텁이 있었고, 그 명분은 "실행시키면 렌더러가
    // 굳는다" 였다. 그 wedge 의 진짜 원인은 남의 코드가 아니라 우리 코드였다:
    //   ① `runtime-prelude.js` 의 `Notification.permission` 게터가 폴백으로
    //      자기 자신을 읽어 **무한 재귀**했다. WTM 의 wasm 이 속성 목록
    //      `["navigator.permissions.query(...).state","Notification.permission"]`
    //      을 읽는 순간 스택 오버플로 폭풍이 나고 렌더러가 수십 초 멈췄다.
    //   ② `script.src` 가 프록시 URL 을 흘려 webpack publicPath 가 깨졌고,
    //      그 탓에 SDK 가 순수 JS 프로버로 폴백하며 `ncpt/errorLog` 를 쏟았다.
    // 둘 다 고쳤다. 측정: 차단 유지 6/6 ALIVE, **ncpt 차단 해제 5/5 ALIVE**,
    // `__zp_diagnostics` 0.
    //
    // 걷은 이득이 크다. 차단이 켜져 있으면 `ncaptcha-api.js` 가 40바이트 스텁이
    // 되어 `nhomz` 가 정의되지 않고 캡차가 **원천 봉쇄**된다. 지금은 실제로
    // 78,954바이트가 로드되고 `nhomz` (1.11.1-wasm), `initNcaptcha`,
    // `__ncaptcha_api` 가 전부 정의된다.
    //
    // 다시 막고 싶어지면: 증상만 보고 스텁을 넣지 말 것. 이 두 버그처럼
    // **원인이 우리 쪽일 수 있다**. 그리고 해시로 핀한 차단은 벤더가 빌드를
    // 갈면 조용히 죽으므로(`fce46da` → `1baa7f7` 에서 실제로 그랬다) 쓰지 말 것.
    //
    // ntm.pstatic.net (ntm_<hex>.js) is deliberately NOT blocked: it looked
    // like the same 121 s symptom, but stubbing it removes more ad inventory
    // than it fixes (GFP SDK uses ntm as a bid-token source).
    // (아래는 차단 목록의 역사 기록이다. 실행 코드는 남아 있지 않다 —
    //  같은 실수를 반복하지 않도록 왜 넣었고 왜 걷었는지를 남긴다.)
    {
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
    }
    // request 자체를 transportFetch 에 전달 → browser-set headers (Accept,
    // sec-ch-ua-* 등) 가 upstream 으로 전달됨. 명시 headers 만 보내면 upstream
    // anti-bot 회로가 404 NAVER 페이지를 반환하는 경우가 있음 → SafeFrame
    // loader 미실행 → 광고 미렌더. virtualSubresource 경로와 동일 패턴 유지.
    const resp = await transportFetch(target, { request: req, tab, entryId: tab.activeEntryId, refOverride });
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
  // Unmatched /zp/api/* — record who asked. The page console only shows
  // "404 (from service worker)" with a `script:1` initiator, which is not
  // enough to find the emitter: a relative reference inside a script we serve
  // at `/zp/api/script?…` resolves to `/zp/api/<name>` and lands here. Logging
  // the referrer + destination identifies it in one reproduction.
  try {
    (self.__zpRustTrace = self.__zpRustTrace || []).push(
      `sw:api-404 path=${url.pathname} dest=${req.destination || '?'} mode=${req.mode || '?'} ref=${String(req.headers.get('Referer') || '').slice(-120)}`
    );
  } catch {}
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

// 2026-06-10 NAVER 광고/트래커 instant-stub list. NAVER WAF 는 비신뢰
// IP (residential / VPN / proxy) 에서 광고/anti-bot 트래커 endpoint 를
// 60s slow-lane 후 응답하는 design — 우리 IP/JA3 가 분류받으면 우회 불가
// (trap notebook 2026-06-02 IP-reputation gate 결정적 측정). 그 60s 가
// page hydration chain (메뉴/link binding) 의 await 안에 있어서 첫 NAVER
// 진입 = 1분 이상 wait. transportLatency telemetry 로 확정한 endpoints:
//   nam.veta.naver.com/gfp/v1   → 200, 62820ms, 0 bytes (광고 bid)
//   siape.veta.naver.com/fxshow → 200, 62878ms, 0 bytes (sidebar 광고)
//   ntm.pstatic.net/scripts/ntm_xxx.js → 200, 64742ms, 206 KB (트래커 WASM)
// 
// **Stub 결정**: dogfood 가능성 우선 → 세 host 모두 instant 204.
// **광고 trade-off** (trap notebook 2026-06-02 ntm reject 항목): ntm block
// 시 정상 작동 광고들 (premium / da_public / veta) 모두 about:blank
// iframes 로 깨짐. 그러나 우리 환경에선 이미 nam.veta/siape.veta stub 으로
// 광고 인벤토리가 어차피 채워지지 않음 → ntm 도 stub 해도 손해 boundary
// 작음. 광고 자체 보다 메뉴/페이 link 빠른 반응이 dogfood UX 우선.
// 
// production deployment 시 광고 표시 원하면 ntm 만 list 에서 제거 + 첫
// 진입 1분 wait 받아들이거나 SW response cache 구현 (별도 트랙).
// 2026-07-29 — EMPTIED. The 60s these stubs existed to dodge was NOT a NAVER
// WAF slow-lane: it was our own transport bug (rustls `read_tls` returns one
// record per call, and `TlsStream::poll_read` polled the socket before feeding
// the ciphertext it already held, so a fully-delivered response sat undecrypted
// until the peer's next keepalive PING — exactly 60s). See trap-notebook
// 2026-07-28. A direct HTTP/2 probe to www.naver.com from the same IP showed
// last-data and END_STREAM arriving with gap=0ms, 3/3.
//
// With the real cause fixed, stubbing these actively BREAKS the page: the `{}`
// bodies show up as empty panels in NAVER's own UI and the 1×1 PNG blanks every
// news/card thumbnail. Keep the lists (and this history) so a regression can be
// bisected by re-adding a host, but ship empty.
const NAVER_AD_BID_STUB_HOSTS = new Set([]);

// 2026-06-10 NAVER dynamic thumbnail proxy (`s.pstatic.net/dthumb.phinf/...`)
// 도 NAVER WAF 의 추가 slow-lane endpoint — 비신뢰 IP 에서 20s+ wait
// (transportLatency 측정값: 4 개 × 20040ms = 80s). 페이지의 핵심 이미지
// (뉴스/카드 thumbnail) 들이 여기 — 그래서 dthumb 응답이 늦으면 page
// hydration 완성 안 됨. ntm 과 같이 stub 으로 우회 — 차이점은 이미지라
// 1×1 transparent PNG 로 응답 (binary 이미지 응답). 결과: thumbnail 빈
// 자리 (UI 깨짐 visible) trade-off, dogfood 가능성 우선.
// 2026-07-29 — EMPTIED for the same reason as NAVER_AD_BID_STUB_HOSTS above:
// the "20s+ per dthumb request" this worked around was our TLS read lost
// wakeup, not a WAF slow-lane. Stubbing blanked every news/card thumbnail.
const NAVER_IMAGE_STUB_PATHS = [];

// 2026-06-11 NAVER 광고 SDK ES module stub. **좁은 매칭만** — 광고 SDK 의
// `gfp-display-glog-logger.js` (logger 전용, dynamic import fail 의 cascade
// source) 만 빈 module 로 stub. **절대 매치 안 시킬 path**:
// `gfp-display-sdk.js` (광고 SDK 메인, 168 KB), `gfp-display-nda.js`
// (정상 작동 SDK), `gfp-core.js`. 너무 광범위한 `gfp-display-*` 패턴은
// SDK 메인까지 stub 해서 광고 SDK init fail → page hydration 지연
// (2026-06-11 회귀: 사용자 보고 "또 오래 걸림"). Logger 만 빈 module 로
// 대체하면 (a) dynamic import 즉시 resolve, (b) SDK 메인은 정상 init,
// (c) logging 만 silent — page hydration 정상 진행.
// 2026-06-11: stub 제거. glog-logger 를 빈/Proxy module 로 stub 하면 SDK 의
// named import 또는 생성자 호출에서 "t is not a constructor" throw (회귀).
// gfp-display-sdk.js (168 KB) 가 정상 fetch+rewrite 되는 것 확인됐으니
// glog-logger 도 정상 fetch 경로로 두고, dynamic import 실패의 진짜
// 원인 (rewriter 의 module 변환 / transport) 을 별도 진단. 빈 list 면
// 아래 stub 분기 no-op.
const NAVER_AD_MODULE_STUB_PATTERNS = [];
// 1×1 transparent PNG (67 bytes) — Web 표준 가장 작은 valid PNG.
const TRANSPARENT_PNG_BYTES = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII='),
  c => c.charCodeAt(0)
);

// 2026-06-10 SW response cache for static assets. NAVER cold-load 의 824
// requests / 3163s 누적 wait 의 진짜 원인은 SW 가 모든 fetch 를 매번 cold
// path 로 보낸다는 것 — 브라우저 native HTTP cache 를 SW 가 가로채니
// 활용 불가. 두 번째 진입 / 새로고침 시 같은 immutable static asset (hash
// URL 인 `.js`, `.css`, `.png` 등) 을 또 fetch. Cache API 로 SW lifetime
// 지속되는 persistent cache 를 유지 — GET + 200 + static extension 매치
// 응답만 cache. NAVER hash URL (`ntm_xxx.js`, `preload.20fd9b94.js`) 은
// content-addressed 라 invalidation 신경 안 써도 됨. cache version key 로
// 전체 무효화 가능.
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

async function transportFetch(targetUrl, opt) {
  let u;
  try { u = ZP.canonicalTargetURL(targetUrl).href; } catch (e) { return safeError(e.code || 'TARGET_PROTOCOL_BLOCKED', 403, targetUrl); }
  const txMethod = opt.method || (opt.request && opt.request.method) || 'GET';
  // NAVER 광고/트래커 instant-stub — see NAVER_AD_BID_STUB_HOSTS doc.
  // ntm.pstatic.net 은 트래커 WASM script 로 응답해야 하므로 빈 .js content,
  // 그 외 (nam.veta/siape.veta) 는 204 No Content 로 응답.
  let urlParts = null;
  try {
    urlParts = new URL(u);
    const stubHost = urlParts.host;
    if (NAVER_AD_BID_STUB_HOSTS.has(stubHost)) {
      const isScript = stubHost === 'ntm.pstatic.net';
      // 2026-06-10 stub 응답 shape: 광고 SDK 가 `nam.veta/gfp/v1` /
      // `siape.veta/fxshow` 응답을 JSON.parse 시도. 204 No Content (빈
      // body) 반환 시 parse error → SDK 의 catch 가 어떤 fallback content
      // 를 inject 가능 (사용자 환경에서 binary garbage 가 메인 페이지에
      // 표시되는 회귀 가설). 대신 200 + `{}` empty JSON 으로 응답하면 SDK
      // 가 정상 parse + "no bid → no inventory" 로 처리. ntm 은 script 라
      // 그대로 빈 .js.
      const stubBody = isScript ? '/* zp:stub */' : '{}';
      const stubCType = isScript ? 'application/javascript; charset=utf-8' : 'application/json; charset=utf-8';
      logTransportEvent(u, txMethod, 200, 0, stubBody.length);
      return new Response(stubBody, {
        status: 200,
        headers: { 'Content-Type': stubCType, 'Cache-Control': 'no-store', 'Content-Security-Policy': ZP.fixedCSP() },
      });
    }
    // NAVER dynamic thumbnail proxy stub — 1×1 transparent PNG.
    for (const { host, pathPrefix } of NAVER_IMAGE_STUB_PATHS) {
      if (urlParts.host === host && urlParts.pathname.startsWith(pathPrefix)) {
        logTransportEvent(u, txMethod, 200, 0, TRANSPARENT_PNG_BYTES.byteLength);
        return new Response(TRANSPARENT_PNG_BYTES, {
          status: 200,
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Security-Policy': ZP.fixedCSP() },
        });
      }
    }
    // NAVER 광고 SDK module stub — no-op ES module 응답으로 dynamic import
    // 즉시 resolve. ssl.pstatic.net/tveta/libs/glad/.../gfp-display-glog-logger
    // 매치. 2026-06-11 회귀: `export default {};` 는 SDK 가 logger 를
    // `new Logger()` 처럼 생성자로 호출할 때 "t is not a constructor"
    // throw. default export 를 **호출/생성 가능한 no-op class** 로 제공해서
    // `new X()`, `X()`, `X.method()` 모두 silent no-op 되도록. Proxy 로
    // 임의 property 접근/호출도 안전하게 흡수.
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
  // 2026-06-11 SW response cache 임시 비활성화 — dynamic ES module import
  // 의 cache hit path 에서 puppeteer chromium 의 race / spec edge 로
  // gfp-display-glog-logger.js 같은 module 이 instantiate fail (console
  // errors 2 → 5 회귀). dogfood UX 우선으로 cache 제거. stub list (광고/
  // 트래커/dthumb) 만 유지. 향후 Cache API + ES module 호환 path 별도 트랙.
  // if (txMethod === 'GET' && urlParts && STATIC_ASSET_EXT_RE.test(urlParts.pathname)) {
  //   const cached = await tryRespCacheGet(u);
  //   if (cached) { … }
  // }
  // Step 13: HTTP transport is Rust-only (crates/zp-kernel-bundle).
  // 2026-06-08 split-bundle (c.3): kernel + transport wasm is lazy —
  // first `transportFetch` is what actually triggers the multi-MB
  // `zp_kernel_sw_bg.wasm` fetch + instantiate. Subsequent calls hit the
  // ready check at the top of `initKernel()`.
  try { await initKernel(); } catch { return safeError('SW_NOT_READY', 503, u); }
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
  // 페이지가 명시적으로 준 ref 가 있으면 그것을 쓴다. 타깃과 **같은 오리진**일
  // 때만 받아들인다 — 아니면 페이지가 임의의 Referer 를 만들어 낼 수 있다.
  let refFromPage = '';
  try {
    if (opt.refOverride && virtualBase && new URL(opt.refOverride).origin === new URL(virtualBase).origin) refFromPage = new URL(opt.refOverride).href;
  } catch {}
  const effectiveBase = refFromPage || virtualBase;
  if (effectiveBase) {
    // Referer/Origin are forbidden headers — the Request constructor strips
    // them from `init.headers`. Smuggle them as X-ZP-Referer/X-ZP-Origin and
    // let the relay server promote them back to real Referer/Origin before
    // dispatching upstream. Without this, anti-CSRF endpoints 400.
    headers.set('X-ZP-Referer', effectiveBase);
    let virtualOrigin = '';
    try { virtualOrigin = new URL(effectiveBase).origin; } catch {}
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
  // 2026-06-09 NAVER anti-bot fix: force-set User-Agent FIRST so the
  // page-side `HeadlessChrome`-flavored UA from puppeteer / WebView2
  // never reaches the upstream. NAVER WAF instantly classifies the
  // `HeadlessChrome` substring as a bot and returns 403 on every ad
  // SDK fetch (gfp-display-sdk.js, gfp-display-glog-logger.js, …).
  // Before this fix, the request.headers loop below would inject
  // `user-agent: ...HeadlessChrome/148.0.0.0...` and the later
  // `pushOnce('user-agent', ZP.TARGET_USER_AGENT)` no-op'd because
  // `seen` already had it. Real-Chrome operators in WebView2 still
  // get the canonical Chrome 148 UA — no harm.
  pushOnce('user-agent', ZP.TARGET_USER_AGENT);
  // Force the canonical Chrome 148 sec-ch-ua FIRST so the browser's real header
  // (Edge/WebView2 → "Microsoft Edge";v="149") loses the pushOnce race and is
  // dropped. Otherwise the wire shows a Chrome UA + an Edge sec-ch-ua + v149 —
  // an anti-bot tell. UA, sec-ch-ua, and the TLS spec now all agree: Chrome 148.
  pushOnce('sec-ch-ua', ZP.TARGET_SEC_CH_UA);
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
  // RFC 9218 `priority`. 2026-08-16 실측: 같은 머신의 직접 Chrome 은 최상위
  // 문서 요청에 `priority: u=0, i` 를 보내는데 우리는 아예 안 보냈다.
  // HEADER_ORDER 에는 이미 자리(accept-language 다음)가 잡혀 있었는데 값이
  // 없어서 비어 있던 것 — 헤더 "순서" 만 맞추고 "존재" 는 안 맞춘 셈이었다.
  if (opt.document && !seen.has('priority')) pushOnce('priority', 'u=0, i');
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
    // Body 타입은 caller 마다 다름: runtimeAPI 의 /zp/api/fetch path 는
    // `ZP.base64UrlToBytes` 결과인 Uint8Array, opt.request.clone()
    // .arrayBuffer() 는 ArrayBuffer, Blob/FormData 같은 표준 body 는
    // .arrayBuffer() 메서드 보유. 이 분기 빠지면 NAVER preload.js 의 첫
    // POST 호출에서 `body.arrayBuffer is not a function` 으로 hydration
    // 전체 멈춤 (2026-06-10 trap notebook).
    if (body instanceof Uint8Array) bodyU8 = body;
    else if (body instanceof ArrayBuffer) bodyU8 = new Uint8Array(body);
    else if (body && typeof body.arrayBuffer === 'function') bodyU8 = new Uint8Array(await body.arrayBuffer());
    else bodyU8 = null;
  }
  logOutgoingHeaders(u, method, headerEntries);
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
  const txT0 = performance.now();
  try {
    resp = await self.kernelFetch(reqLike);
  } catch (e) {
    logTransportEvent(u, method, 0, performance.now() - txT0, 0);
    // Record WHY. The page only ever sees "502 (Bad Gateway)", which tells us
    // nothing about whether the kernel refused, the handshake failed, or the
    // stream died — and these failures are intermittent, so a reproduction
    // without the reason attached is wasted. Goes to the same trace ring the
    // kernel uses, readable via the SW's `__zpTraceDump` message.
    try {
      const reason = (e && (e.message || e.code)) || String(e);
      (self.__zpRustTrace = self.__zpRustTrace || []).push(
        `sw:transport-fail ${method} ${String(u).slice(0, 120)} after=${Math.round(performance.now() - txT0)}ms err=${reason}`
      );
    } catch {}
    return safeError(e && (e.message || e.code) || 'TARGET_CONNECT_FAILED', 502, u);
  }
  // body length signal — Content-Length is upstream-authoritative when
  // present; for chunked / unknown we estimate 0 to avoid double-buffer
  // (probe is best-effort, not metering).
  let bodyLen = 0;
  try {
    const cl = resp && resp.headers && resp.headers.get('content-length');
    if (cl) bodyLen = parseInt(cl, 10) || 0;
  } catch {}
  logTransportEvent(u, method, (resp && resp.status) || 0, performance.now() - txT0, bodyLen);
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
  // 2026-06-11 SW response cache write 비활성화 (cache hit path 와 같이
  // disable). 자세한 이유는 cache_first 분기 주석 참조.
  // 2026-06-09 cross-host 3xx redirect rewrap.
  // 함정: Rust kernel 는 redirect-follow 안 함 (fetch.rs 의 `No redirect
  // follow` policy) — 3xx 를 그대로 SW 로 surface. 우리가 그걸 다시 그대로
  // 클라이언트로 forward 하면 브라우저는 raw Location URL 로 native nav
  // → URL bar = `https://nid.naver.com/...`, 우리 share URL escape.
  // NAVER 페이 link 시나리오 (pay.naver.com 302 → nid.naver.com/nidlogin.login)
  // 가 정확히 이 경로로 escape 했음 (2026-06-09 trap notebook).
  //
  // Fix: SW 가 3xx 를 swallow 하고 같은 transportFetch 안에서 재귀 follow.
  // (a) entry.targetUrl 을 새 URL 로 업데이트 → virtual location state 동기화,
  // (b) URL bar 는 share URL 그대로 유지 → fragment (k=…&server=…) 보존,
  // (c) 다음 transportFetch 호출이 새 host 기준 Cookie / Referer / Origin
  //     rebuild (entry.targetUrl 이 이미 업데이트됨).
  // Method 처리: 301/302/303 은 GET 으로 강제 (RFC 7231 §6.4.4), 307/308 은
  // 원래 method 유지. Depth limit 5 — 무한 loop 차단.
  const MAX_REDIRECT_DEPTH = 5;
  if (resp && resp.status >= 300 && resp.status < 400) {
    const currentDepth = opt.__redirectDepth || 0;
    if (currentDepth < MAX_REDIRECT_DEPTH) {
      const loc = resp.headers.get('Location');
      if (loc) {
        let resolvedUrl = null;
        try { resolvedUrl = new URL(loc, u).href; } catch {}
        if (resolvedUrl) {
          if (entry) {
            entry.targetUrl = resolvedUrl;
            entry.baseUrl = resolvedUrl;
          }
          const preserveMethod = resp.status === 307 || resp.status === 308;
          return transportFetch(resolvedUrl, {
            request: opt.request,
            document: opt.document,
            tab: opt.tab,
            entryId: opt.entryId,
            method: preserveMethod ? method : 'GET',
            headers: undefined, // rebuilt by transportFetch for the new host
            body: preserveMethod ? opt.body : null,
            __redirectDepth: currentDepth + 1,
          });
        }
      }
    }
  }
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
// 2026-06-08 split-bundle (c.1) Step 3: shadow-compare infrastructure
// removed. The legacy ZPRewriter.rewriteScript path no longer exists, so
// comparing against it is meaningless. The `applyScriptPatches` helper
// below is retained for the future patch-mode marker-resolver port; its
// envelope contract is documented inline.

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
  rewriteStats.invocations++;
  // 우리 에러 페이지(safeError)는 HTML 이다. 그걸 스크립트 리라이터에 넣으면
  // 당연히 파싱에 실패하고, fail-closed 스텁이 "Blocked by ZeroProxy rewrite
  // policy" 를 던진다 — **네트워크 실패가 정책 차단으로 둔갑한다.**
  // 실제로 이것 때문에 Google 호스트들의 TLS 실패
  // (`h2: response: tls: … received fatal alert: UnexpectedMessage`) 가
  // "리라이터 파싱 실패" 로 보였다. 원인 규명을 정반대로 보내는 종류의 버그다.
  // 문서 경로(transformDocumentResponse)에는 이미 같은 가드가 있다.
  if (resp && resp.headers && resp.headers.get('X-ZP-Error') === '1') {
    const upstream = resp.headers.get('X-ZP-Error-Code') || 'TARGET_CONNECT_FAILED';
    const h = scriptResponseHeaders(resp);
    return new Response(
      'throw new DOMException(' + JSON.stringify('ZeroProxy: upstream fetch failed (' + upstream + ')') + ", 'NetworkError');",
      { status: resp.status, statusText: resp.statusText, headers: h }
    );
  }
  const h = scriptResponseHeaders(resp);
  let code = '';
  let cacheKey = '';
  try {
    // 2026-06-08: dead init-rewriter helper call removed (helper
    // deleted in split-bundle c.1 Step 3, call site forgotten). The
    // ReferenceError it produced was swallowed by the outer try/catch
    // and replaced with the "Blocked by ZeroProxy rewrite policy" block
    // stub for every external `<script src>` — Wikipedia's
    // `load.php?modules=startup` was the most visible victim because
    // mw.loader surfaces the throw as an uncaught console error.
    // ZPBundle.ready is guaranteed by the activate handler now, so
    // `await initBundle()` below covers the lazy-retry case alone.
    const source = await resp.text();
    // C4: cache check before invoking the OXC pipeline. Hash inputs that
    // affect output: transformer version, script kind, target URL, source bytes.
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
    // 2026-06-08 split-bundle (c.1) Step 2.2: SW primary swap. ZPBundle
    // (modern OXC 0.133) is now the primary script rewriter; legacy
    // ZPRewriter (OXC 0.60, in rewriter-rs/) only runs as a fallback if
    // modern errors. Shadow-compare on NAVER + Wikipedia recorded 0
    // divergence after Step 2.1.5 added `Function` / `eval` to
    // DANGEROUS_GLOBALS and dropped the marker-unsafe patches path.
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
        }
      }
    } catch (rustErr) { /* swallow; legacy fallback below */ }
    // 2026-06-08 split-bundle (c.1) Step 3: legacy ZPRewriter.rewriteScript
    // fallback dropped. The rewriter-rs/ crate's OXC JS path no longer
    // exists; if ZPBundle (modern) failed above, we fail-closed to the
    // POLICY_BLOCKED stub below — same posture as a real parse error.
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
  //
  // The guard used to be `status >= 300`, which also let every 4xx/5xx HTML
  // *body* through un-rewritten. That is not a redirect — it is a document the
  // browser renders and executes. Cloudflare's managed challenge is exactly
  // that shape (403 + `cf-mitigated: challenge` + a full HTML page), so the
  // interstitial reached the page with no prelude, no membrane and no URL
  // rewriting: its `/cdn-cgi/challenge-platform/...` script resolved against
  // the PROXY origin, Go answered POLICY_BLOCKED, and the challenge could
  // never run ("Just a moment..." forever). Worse in general — an error page
  // carrying ABSOLUTE URLs would have loaded them straight from the browser,
  // which is a containment escape, not just a fidelity bug.
  // So: skip redirects only (3xx has no renderable body anyway) and keep every
  // other HTML status on the rewrite path.
  if (!resp || !isHTMLResponse(resp)) return resp;
  if (resp.status >= 300 && resp.status < 400) return resp;
  // Our own error pages (safeError) are already proxy-origin documents built
  // from fixed markup — rewriting them against the target URL would inject a
  // membrane into a page that has nothing to contain.
  if (resp.headers && resp.headers.get('X-ZP-Error') === '1') return resp;

  // Phase C — progressive streaming render. Used ONLY when the kernel actually
  // streamed this document (X-ZP-Stream marker, set in build_streaming_js_response
  // for 2xx text/html gzip|identity). The body is piped through the streaming
  // HtmlTxn so the page renders as bytes arrive — the fix for NAVER's withheld
  // END_STREAM (~60s) where the buffered `resp.text()` below would block. Falls
  // back to the buffered path (which keeps fail-closed MALFORMED_HTML + the
  // post-redirect CSS host-rewrite) on host mismatch or any failure.
  const kernelStreamed = resp.headers && resp.headers.get('X-ZP-Stream') === '1';
  if (kernelStreamed && resp.body) {
    try {
      await initBundle();
      if (self.ZPBundle && self.ZPBundle.ready && typeof self.ZPBundle.HtmlTxn === 'function') {
        const targetUrl = (opt.entry && (opt.entry.targetUrl || opt.entry.baseUrl)) || '';
        // Post-redirect host mismatch needs a whole-doc CSS regex (see the
        // buffered path below) — not streamable. Use the buffered path there.
        const finalUrl = (resp.headers && resp.headers.get('X-ZP-Final-URL')) || '';
        let hostMismatch = false;
        if (finalUrl && targetUrl) {
          try { hostMismatch = new URL(targetUrl).host !== new URL(finalUrl).host; } catch {}
        }
        if (!hostMismatch) {
          const streamed = streamDocumentResponse(resp, opt, targetUrl);
          if (streamed) return streamed;
        }
      }
    } catch { /* fall through to buffered */ }
  }

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
    // Surface the reason: a 502 from here and a 502 from a transport failure
    // are indistinguishable in the page console, and the HTML rewriter can
    // fail-closed for reasons worth knowing (a wasm panic shows up as a bare
    // "unreachable" — see the zp-bundle panic hook).
    try {
      (self.__zpRustTrace = self.__zpRustTrace || []).push(
        `sw:html-transform-fail ${String(targetUrl).slice(0, 120)} reason=${String(transformFailure).slice(0, 160)}`
      );
    } catch {}
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
// Phase C streaming render. Pipes the kernel's decoded-HTML ReadableStream
// through the wasm `HtmlTxn` (incremental rewrite + prelude injection at
// <head>) so the page renders progressively. Returns a streaming Response, or
// null if the txn couldn't be constructed (caller falls back to buffered).
//
// Strict-mode fail-closed is preserved: on a rewrite error mid-stream we
// `controller.error` (the page sees a network failure / what already rendered)
// instead of shipping un-rewritten bytes. The prelude is injected by HtmlTxn at
// the <head> open tag, so NO separate injectPrelude is needed here.
function streamDocumentResponse(resp, opt, targetUrl) {
  const preludeHTML = buildRuntimePrelude(opt.tab, opt.entry);
  let txn;
  try { txn = new self.ZPBundle.HtmlTxn(targetUrl, ORIGIN, preludeHTML); }
  catch { return null; }
  // Lifetime anchor for `event.waitUntil` (see the fetch listener). Resolves
  // when the body stream is fully delivered — normally, on error, or on
  // consumer cancel — so the Service Worker cannot be terminated mid-stream.
  let markBodyDone;
  const bodyDone = new Promise(res => { markBodyDone = res; });
  // Diagnostics for the document pipe. The kernel reports how many decoded
  // bytes it enqueued (`tx:h2-stream-deflate-end out=…`); these counters say
  // how many of them actually reached the page. A gap between the two localises
  // a stalled document to this TransformStream rather than to the network.
  const stats = { id: (self.__zpStreamSeq = (self.__zpStreamSeq || 0) + 1), url: targetUrl.slice(-40), in: 0, out: 0, chunks: 0, state: 'open', err: '' };
  // Keep the last few streams: a navigation often fetches the document twice
  // (first attempt cancelled, then re-requested), so a single global would
  // report the wrong one.
  self.__zpStreamStats = ((self.__zpStreamStats || []).concat([stats])).slice(-6);
  const ts = new TransformStream({
    transform(chunk, controller) {
      try {
        // chunk is a Uint8Array of decoded (gunzipped) HTML bytes.
        stats.chunks++;
        stats.in += (chunk && chunk.byteLength) || 0;
        const out = txn.write(chunk);
        if (out && out.byteLength) { stats.out += out.byteLength; controller.enqueue(out); }
      } catch (e) {
        stats.state = 'error';
        stats.err = (e && (e.message || e.code)) || String(e);
        markBodyDone();
        controller.error(e);
      }
    },
    flush(controller) {
      try {
        const tail = txn.end();
        if (tail && tail.byteLength) { stats.out += tail.byteLength; controller.enqueue(tail); }
        stats.state = 'closed';
      } catch (e) {
        stats.state = 'flush-error';
        stats.err = (e && (e.message || e.code)) || String(e);
        controller.error(e);
      }
      markBodyDone();
    },
    cancel(reason) {
      stats.state = 'cancelled';
      stats.err = String(reason || '');
      markBodyDone();
    },
  });
  const headers = new Headers(resp.headers);
  headers.delete('Content-Length');     // decoded plaintext, unknown length
  headers.delete('X-ZP-Stream');        // strip the SW-internal marker
  headers.set('Content-Type', 'text/html; charset=utf-8');
  // 스트리밍 문서에도 버퍼 경로(`addCSP`)와 **같은** 보안 헤더를 건다.
  // 빠져 있던 동안 프록시 문서에는 CSP 가 없었다.
  applyZPSecurityHeaders(headers, opt.request, opt.tab && opt.tab.servers, opt.tab);
  const out = new Response(resp.body.pipeThrough(ts), {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
  // Hand the completion promise to the fetch listener. `respondWith` only
  // extends the worker's life until the RESPONSE promise settles — which is
  // immediately, since we return headers + an unread ReadableStream. Without
  // a `waitUntil` on this, Chrome may terminate the worker while the wasm
  // pump is still feeding the stream: CPU goes idle, the document freezes
  // mid-parse (NAVER stalled at ~33 KB, readyState stuck), and CDP can't even
  // attach to the dead worker. That was the real "NAVER 60s" — not anti-bot.
  try { Object.defineProperty(out, '__zpBodyDone', { value: bodyDone }); } catch {}
  return out;
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
    // D4 — empty string when the operator hasn't enabled `-wt-public-url`;
    // page-realm virtual `WebTransport` falls back to the rejected stub
    // path (WT_UNSUPPORTED) when this is empty.
    wtGateway: runtimeConfig.wtGateway || '',
    // D5 — empty string when the operator hasn't enabled `-rtc-enable +
    // -rtc-public-url`; page-realm virtual `RTCPeerConnection` falls
    // back to the rejected stub path (RTC_GATEWAY_UNAVAILABLE).
    rtcGateway: runtimeConfig.rtcGateway || '',
    // D5 embedded TURN: array of `{urls,username,credential}` cred
    // tuples the page realm RTCPC passes verbatim to native. Empty
    // means no embedded TURN — page realm forces iceServers=[] and
    // gets host candidates only (existing behaviour).
    rtcICEServers: Array.isArray(runtimeConfig.rtcICEServers) ? runtimeConfig.rtcICEServers : [],
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
  // 2026-08-13 — CSP 를 **문서 안에도** 박는다.
  //
  // 실측: SW 가 합성한 응답이라도 non-streaming(`new Response(string, …)`)
  // 이면 CSP 가 정상 강제된다(에러 페이지에서 외부 이미지 차단 확인).
  // 그런데 스트리밍 문서(`new Response(ReadableStream, …)`)에서는 같은
  // 헤더를 실어도 강제되지 않는다 — 리라이트 안 된 외부 이미지가 그대로
  // 로드됐다. 헤더 경로가 왜 무시되는지는 별개로 파야 하지만, 문서에 직접
  // 박은 meta 는 파서가 처리하므로 응답 합성 방식과 무관하다.
  //
  // 프렐류드는 문서 맨 앞에 주입되므로 이 meta 는 어떤 서브리소스보다 먼저
  // 온다 — CSP meta 의 요구 조건이 그것이다. `frame-ancestors` 는 meta 에서
  // 무시되지만 프록시 문서 정책은 그걸 쓰지 않는다(중첩 iframe 때문에 일부러
  // 뺐다). 헤더도 그대로 둔다 — 둘 다 있으면 각각 강제되고 값이 같으므로
  // 실효 정책은 변하지 않는다.
  const cspMeta = '<meta http-equiv="Content-Security-Policy" content="'
    + ZP.fixedCSP(tab.servers || [], { challengeCompat: !!tab.challengeCompat }).replace(/"/g, '&quot;')
    + '">';
  return cspMeta +
    '<script nonce=zp>' + prewarmInline + '</script>' +
    '<script nonce=zp src=' + ZP.assetURL('zp-core.js') + '></script>' +
    // 2026-06-08 split-bundle (c.1) Step 4: legacy rust-rewriter.js script
    // tag dropped. zp-page-bundle.js inlines the wasm + initSync's so
    // `globalThis.ZPBundle.ready === true` by the time runtime-prelude's
    // IIFE runs — the modern bundle covers both JS and CSS rewrite.
    '<script nonce=zp src=' + ZP.assetURL('zp-page-bundle.js') + '></script>' +
    '<script nonce=zp id=__zp-boot type=application/json>' + bootJSON + '</script>' +
    '<script nonce=zp src=' + ZP.assetURL('runtime-prelude.js') + '></script>';
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
  // Proxied-page keepalive ping (runtime-prelude `startSWKeepAlive`). Receiving
  // this event is the whole point — it resets the SW idle timer so the
  // in-memory tab state (tabs/shareRoutes/clientContext) survives long
  // fetch-quiet gaps (notably the ~60s streamed-document withhold). No reply,
  // no work; just return so we never touch the kernel for a heartbeat.
  if (msg && msg.type === '__zpKeepAlive') return;
  // Diagnostic: dump the kernel trace ring WITHOUT touching the kernel. The
  // full __zpKernelProbe awaits initKernel(), which hangs once the kernel wasm
  // has trapped (poisoned instance) — exactly when we most need the panic line
  // the panic-hook pushed here. self.__zpRustTrace is a plain JS array, so it
  // survives the wasm trap. No init, immediate reply.
  if (msg && msg.type === '__zpTraceDump') {
    if (reply) reply.postMessage({ ok: true, trace: (self.__zpRustTrace || []).slice(-400), streamStats: self.__zpStreamStats || null });
    return;
  }
  // 거절 로그 덤프 — 페이지의 `__zp_refusals()` 가 읽는다. 커널을 건드리지
  // 않으므로 wasm 이 죽어 있어도 답한다.
  if (msg && msg.type === '__zpRefusalDump') {
    if (reply) reply.postMessage({ ok: true, refusals: refusalLog.slice(-MAX_REFUSAL_LOG) });
    return;
  }
  if (msg && msg.type === '__zpKernelEchoTest') {
    // 2026-06-08 split-bundle (c.3): echoSync is a kernel-half export now.
    // Probe through initKernel() — initBundle() doesn't carry kernel*.
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
    // 2026-06-08 split-bundle (c.3): the diagnostic probe should reflect
    // the *post-init* kernel state. Force-init the kernel half before
    // reporting (independent of whether anything has yet routed a fetch).
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
      // 2026-06-09 perf telemetry — see `rewriteStats` declaration.
      // hitRatio rounded so probe output stays compact; raw counts
      // are also included for ad-hoc analysis. cacheKeyShare is the
      // % of `rewriteLatencyMs` spent on the SHA-256 cache key —
      // when this dominates, the cache key is a pessimization.
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
      // 2026-06-09 transport header debug — last N outgoing fetches.
      // Compare with chrome://net-export / Wireshark capture from a
      // real Chrome 148 hit to spot anti-bot trigger gaps.
      outgoingHeaders: outgoingHeaderLog.slice(),
      // 2026-06-09 transport-stage perf telemetry. NAVER cold-load
      // attribution: with rewriter at ~1% of wall time, this surfaces
      // where the other 99% lives (per-fetch yamux+TLS+h2 cost +
      // upstream RTT). Top-K slowest entries are visible in the
      // ring buffer; cumulative `transportStats` reflects SW lifetime.
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
    // 2026-08-13 — 클라이언트가 자기 탭을 명시적으로 등록한다.
    //
    // `contextFor` 는 (a) Referer 로 share 경로를 되짚거나 (b) 이미 바인딩된
    // clientId 로만 탭을 찾는다. 그런데 `srcdoc` / `blob:` / `about:blank`
    // 문서는 내비게이션 요청이 없어 (b) 가 채워질 일이 없고, 그 문서의
    // 서브리소스는 Referer 도 우리 origin 이 아니라 (a) 도 실패한다. 결과:
    // **최상위 문서에서는 정상 로드되는 바로 그 URL 이** srcdoc iframe 에서
    // 오면 거절당했다 (NAVER 장바구니 위 Braze 오버레이가 이미지 전부 실패).
    //
    // 프렐류드는 이런 문서에도 주입되고 boot 설정으로 자기 tabId/entryId 를
    // 안다. 부팅 직후 이 메시지를 보내 clientId 를 묶어 준다. A2 불변식은
    // 그대로다 — runtimeTabForMessage 가 per-tab capability token 을 요구하므로
    // 토큰 없는 클라이언트는 자기를 아무 탭에나 붙일 수 없다. srcdoc 은 부모의
    // entry 를 물려받는데, 그게 명세상 맞다 (srcdoc 은 부모의 URL/base 를 쓴다).
    if (msg.type === 'ZP_BIND_CLIENT') {
      const tab = runtimeTabForMessage(event, msg, fail);
      if (!tab) return;
      const entry = tab.entries.get(msg.entryId || tab.activeEntryId);
      if (!entry) { fail('SW_NOT_READY'); return; }
      const sourceId = event.source && event.source.id;
      if (sourceId) bindClientContext(sourceId, tab, entry);
      ok({ bound: !!sourceId });
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
  // Step 13: Rust kernelStream (crates/zp-kernel-bundle).
  // 2026-06-08 split-bundle (c.3): kernel wasm is lazy — first ZP_WS_OPEN
  // is what actually triggers the multi-MB kernel wasm instantiation.
  try { await initKernel(); } catch { fail('SW_NOT_READY'); return; }
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

// 2026-08-13 — 쿠키 jar 키를 origin 이 아니라 **등록가능 도메인(eTLD+1)** 으로
// 잡는다. origin 키는 서브도메인마다 jar 를 갈라 놓아서, `nid.naver.com` 으로
// 시작한 탭에서 로그인한 뒤 `www.naver.com` 을 새 탭으로 열면 NID_AUT/NID_SES
// 가 없는 빈 jar 를 받아 **로그아웃 상태로 보였다**. 브라우저는 쿠키를 Domain
// 속성 기준으로 서브도메인끼리 공유하므로, 우리도 그 경계에 맞춰야 한다.
// jar 내부의 RFC 6265 domainMatch 가 여전히 호스트별 스코핑을 강제하므로
// 키를 넓혀도 엉뚱한 호스트로 쿠키가 새지 않는다.
//
// 공개 접미사 목록(PSL)은 번들에 없다. 아래 휴리스틱은 `naver.com` →
// naver.com, `example.co.kr` → example.co.kr 처럼 실제로 마주치는 형태를
// 커버한다. **중요**: 같은 함수를 쿠키 파서의 "Domain 이 공개 접미사면 거부"
// 검사에도 쓴다. 두 곳이 같은 경계를 보게 해서, 넓힌 키가 `Domain=co.kr`
// 같은 초광역 쿠키를 받아들이는 구멍으로 이어지지 않게 한다.
const SECOND_LEVEL_SUFFIX = new Set([
  'co', 'ne', 'or', 'ac', 'go', 're', 'pe', 'kg', 'seoul', 'busan',
  'com', 'net', 'org', 'gov', 'edu', 'mil', 'int', 'info', 'biz', 'nom',
]);
function registrableDomain(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || /^\d+(\.\d+)*$/.test(h) || h.indexOf(':') >= 0) return h; // IP / IPv6 literal
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  // `example.co.kr` 형태: 마지막이 2글자 ccTLD 이고 그 앞이 알려진
  // 2단계 접미사면 세 라벨을 잡는다. 그 외에는 두 라벨.
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  if (tld.length === 2 && SECOND_LEVEL_SUFFIX.has(sld)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}
// A cookie whose Domain attribute IS the public suffix (`com`, `co.kr`) must be
// rejected — otherwise one site could write a cookie every sibling under that
// suffix would carry. `registrableDomain` defines where that boundary is.
function isPublicSuffixDomain(dom) {
  const d = String(dom || '').toLowerCase().replace(/\.$/, '');
  if (!d) return true;
  if (/^\d+(\.\d+)*$/.test(d) || d.indexOf(':') >= 0) return false; // IP literal
  const parts = d.split('.');
  if (parts.length < 2) return true;                       // `com`
  // `co.kr` 자체도 공개 접미사다. registrableDomain 은 두 라벨짜리를 그대로
  // 돌려주므로 여기서 따로 잡아야 한다.
  if (parts.length === 2 && parts[1].length === 2 && SECOND_LEVEL_SUFFIX.has(parts[0])) return true;
  return registrableDomain(d) !== d;
}
function originKeyForURL(targetUrl) {
  try { return registrableDomain(new URL(targetUrl).hostname); } catch { return ''; }
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
        // jar 를 등록가능 도메인 단위로 공유하게 되면서, `Domain=co.kr` 같은
        // 공개 접미사 쿠키를 받아 주면 그 아래 모든 사이트가 그걸 물고 나가는
        // 구멍이 된다. 브라우저와 같은 규칙으로 거부한다.
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
// 2026-08-13 — addCSP 의 헤더 적용부를 분리했다.
//
// `addCSP` 는 `new Response(resp.body, …)` 를 만들어 돌려주는 형태라 이미
// 파이프한 스트림에는 쓸 수 없었고, 그래서 `streamDocumentResponse` 는
// 상류 헤더를 그대로 쓰고 **우리 CSP 를 아예 안 붙였다**. 스트리밍이 문서의
// 기본 경로이므로 사실상 모든 프록시 문서에 CSP 가 없었다.
// 실측(수정 전): 런처 페이지에서는 외부 이미지가 차단되는데, 같은 이미지가
// 프록시 문서에서는 그대로 로드됐다.
function applyZPSecurityHeaders(h, req, servers, tab) {
  // B4: read once, then delete unconditionally — defense in depth against a
  // disarmed tab somehow seeing the header (e.g. server bug, racing reload).
  const responseSignalled = h.get('X-ZP-Challenge-Compat') === '1';
  h.delete('X-ZP-Challenge-Compat');
  const armedHere = !!(tab && tab.challengeCompat) && responseSignalled;
  h.set('Content-Security-Policy', ZP.fixedCSP(servers || [], { challengeCompat: armedHere }));
  // 2026-08-14 — 브라우저가 타깃에게 **직접** 보고하게 만드는 헤더를 전부 지운다.
  //
  // 실측(nid.naver.com): 응답에 `Content-Security-Policy-Report-Only` 가 실려
  // 오고 그 안에 `report-uri https://nid.naver.com/login/api/csp.repo.naver.only`
  // 가 있다. 이름이 `Content-Security-Policy` 와 달라서 위의 `set` 이 건드리지
  // 못했고, 그대로 페이지에 적용되고 있었다. 위반이 하나 생길 때마다 브라우저가
  // 그 엔드포인트로 POST 하는데 **CSP 리포트는 Service Worker 가 가로챌 수 없다**
  // — 릴레이를 우회하는 직접 egress, 즉 실제 IP 유출 경로다.
  //
  // Report-To / Reporting-Endpoints / NEL 도 같은 부류(네트워크 오류·경고를
  // 브라우저가 지정 엔드포인트로 직접 전송)라 함께 지운다. 우리 정책에는
  // report-uri 가 없으므로 지우는 쪽이 기능 손실도 없다.
  h.delete('Content-Security-Policy-Report-Only');
  h.delete('Report-To');
  h.delete('Reporting-Endpoints');
  h.delete('NEL');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Cache-Control', h.get('Cache-Control') || 'no-store');
  applyCORS(h, req);
  return h;
}
function addCSP(resp, req, servers, tab) {
  const h = new Headers(resp.headers);
  // B4: read once, then delete unconditionally — defense in depth against a
  // disarmed tab somehow seeing the header (e.g. server bug, racing reload).
  applyZPSecurityHeaders(h, req, servers, tab);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}
function safeError(code, status = 400, targetUrl = '') {
  // 커널이 주는 에러는 `CODE: 상세` 꼴이다 (예:
  // `TARGET_HTTP_FAILED: h2: response: tls: process: received fatal alert:
  // UnexpectedMessage`). 통째로 ERRORS 대조를 하면 못 찾아서 전부
  // POLICY_BLOCKED 로 뭉개졌다 — 네트워크/TLS 실패가 "정책 차단" 으로
  // 둔갑해 원인 추적을 정반대 방향으로 보낸다. 앞 토큰을 먼저 본다.
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
      // Marks this as OUR page, not the target's, so transformDocumentResponse
      // (which now rewrites 4xx/5xx HTML bodies) leaves it alone.
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
function workerBootstrap(url) { const body = "const __zp_worker_params=new URLSearchParams(self.location.hash.slice(1));self.__ZP_WORKER_TARGET=__zp_worker_params.get('u')||'about:blank';self.__ZP_WORKER_TAB_ID=__zp_worker_params.get('tab')||'';self.__ZP_WORKER_SERVERS=__zp_worker_params.getAll('server');importScripts('/zp/assets/worker-prelude.js?v=__ZP_BUILD_ID__');importScripts('/zp/api/worker-script?tab=' + encodeURIComponent(self.__ZP_WORKER_TAB_ID) + '&u=' + encodeURIComponent(self.__ZP_WORKER_TARGET));"; return new Response(body, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': ZP.fixedCSP(), 'X-Content-Type-Options': 'nosniff' } }); }
