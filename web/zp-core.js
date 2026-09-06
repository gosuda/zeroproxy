/* ZeroProxy shared browser primitives. Classic script; exposes non-enumerable global ZP. */
(() => {
  'use strict';
  if (globalThis.ZP) return;
  const te = new TextEncoder();
  const td = new TextDecoder('utf-8', { fatal: true });
  const SHARE_INFO_ENC = te.encode('zp-url-cbc-enc');
  const SHARE_INFO_MAC = te.encode('zp-url-cbc-mac');
  const SHARE_MAC_PREFIX = te.encode('ZP-CBC-URL-V1');
  const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
  const WS_PROTOCOLS = new Set(['ws:', 'wss:']);
  const CONTROL_PREFIX = '/zp/';
  const ASSET_PREFIX = CONTROL_PREFIX + 'assets/';
  // Default User-Agent presented to target servers. Browsers mark User-Agent
  // as a forbidden header for fetch(), so the SW smuggles it via
  // X-ZP-User-Agent and the relay promotes it. Matches the value the prelude
  // exposes via navigator.userAgent so HTTP+JS UA stay consistent.
  // Phase 5.8: matches the JA3/extension layout in sw.js capturedFingerprint
  // (Chrome 148). Sec-CH-UA emitted by the page-side prelude pins v=148 on
  // the brand entries; mismatch with this UA string is a WAF signal
  // ("UA claims 148, sec-ch-ua claims 134" = bot).
  // 2026-08-16: 148 → 151. sw.js 의 captured TLS spec 을 오늘의 Chrome 에 맞춰
  // 갱신했으므로(ML-DSA sig algs) UA 도 같이 올린다 — TLS 는 151 인데 UA 가
  // 148 이면 그 불일치 자체가 새로운 tell 이다. 셋(UA / sec-ch-ua / TLS)은
  // 항상 같은 버전을 말해야 한다.
  const TARGET_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
  // Wire `sec-ch-ua` MUST match the Chrome 148 UA above. The transport
  // previously forwarded the host browser's real header, which on Edge/WebView2
  // reads `"Microsoft Edge WebView2";v="149", "Microsoft Edge";v="149"` — a
  // glaring tell (UA says Chrome, sec-ch-ua says Edge, v149≠v148) that anti-bot
  // WAFs (NAVER) profile. Force the canonical Chrome 148 low-entropy brand list
  // so UA + sec-ch-ua + TLS spec all agree on Chrome 148. (GREASE brand mirrors
  // the Chromium 14x algorithm; the high-entropy hints stay dropped, as Chrome
  // only sends them on explicit server request.)
  // 2026-08-16: 브랜드 목록을 실제 브라우저가 오늘 보내는 모양으로 맞춘다.
  // 같은 머신에서 직접 측정한 값은
  //   "Chromium";v="151", "Not=A?Brand";v="99", "Microsoft Edge WebView2";v="151", "Microsoft Edge";v="151"
  // 이다 — GREASE 브랜드의 **표기법도 위치도** 바뀌었다(`"Not)A;Brand";v="24"`
  // 선두 → `"Not=A?Brand";v="99"` 두 번째). 우리는 Edge 가 아니라 순수 Chrome
  // 페르소나를 유지하므로 Edge 두 항목만 "Google Chrome" 으로 바꿔 쓴다.
  const TARGET_SEC_CH_UA = '"Chromium";v="151", "Not=A?Brand";v="99", "Google Chrome";v="151"';
  const MAX_RELAY_SERVERS = 8;
  const MAX_RELAY_SERVER_BYTES = 2048;
  const ERRORS = Object.freeze(['BAD_HMAC','INVALID_SHARE_LINK','MALFORMED_ROUTE','SW_NOT_READY','TARGET_PROTOCOL_BLOCKED','TLS_CERTIFICATE_INVALID','TLS_HANDSHAKE_FAILED','TARGET_CONNECT_FAILED','TARGET_HTTP_FAILED','MALFORMED_HTML','REALM_INJECTION_FAILURE','REQUEST_BODY_TOO_LARGE','SUBMISSION_EXPIRED','POLICY_BLOCKED','REWRITE_FAILED','SCRIPT_SRC_BLOCKED','REDIRECT_BODY_NONREPLAYABLE','REDIRECT_LIMIT_EXCEEDED','WS_BLOCKED','RTC_GATEWAY_UNAVAILABLE','WT_UNSUPPORTED']);
  // Human-friendly title + description per error code. Parity with
  // crates/zp-shared/src/errors.rs ErrorCode::as_str.
  const ERROR_INFO = Object.freeze({
    BAD_HMAC: { title: 'Tampered share link', desc: 'The share link signature does not verify. The link may have been altered.' },
    INVALID_SHARE_LINK: { title: 'Invalid share link', desc: 'The share link or decryption key is missing or malformed.' },
    MALFORMED_ROUTE: { title: 'Malformed route', desc: 'The requested ZeroProxy route is not well-formed.' },
    SW_NOT_READY: { title: 'Transport not ready', desc: 'The ZeroProxy Service Worker transport is still initializing. Refresh in a moment.' },
    TARGET_PROTOCOL_BLOCKED: { title: 'Unsupported scheme', desc: 'Only http:// and https:// targets are allowed.' },
    TLS_CERTIFICATE_INVALID: { title: 'TLS certificate rejected', desc: 'The target presented a TLS certificate that did not pass validation.' },
    TLS_HANDSHAKE_FAILED: { title: 'TLS handshake failed', desc: 'ZeroProxy could not establish a TLS connection with the target.' },
    TARGET_CONNECT_FAILED: { title: 'Could not reach target', desc: 'ZeroProxy could not connect to the target server.' },
    // 상류가 4xx/5xx 를 주거나 HTTP/TLS 계층이 실패한 경우. 예전에는 목록에
    // 없어서 POLICY_BLOCKED 로 접혔고, 네트워크 실패가 "정책 차단" 으로 둔갑해
    // 원인 추적을 정반대로 보냈다.
    TARGET_HTTP_FAILED: { title: 'Target returned an error', desc: 'The target server responded with an error, or the HTTP/TLS layer failed before a response arrived. Retry, or check the target URL.' },
    MALFORMED_HTML: { title: 'Malformed HTML', desc: 'The target response contained HTML that could not be safely parsed in strict mode.' },
    REALM_INJECTION_FAILURE: { title: 'Containment failed', desc: 'ZeroProxy could not inject the page containment runtime. Target code execution was blocked.' },
    REQUEST_BODY_TOO_LARGE: { title: 'Request body too large', desc: 'The uploaded body exceeded the ZeroProxy maximum size.' },
    SUBMISSION_EXPIRED: { title: 'Form submission expired', desc: 'The original POST submission cache has expired. Reload the form and resubmit.' },
    POLICY_BLOCKED: { title: 'Blocked by policy', desc: 'This operation is not allowed by ZeroProxy strict-mode policy.' },
    REWRITE_FAILED: { title: 'JavaScript rewrite failed', desc: 'A target script could not be safely rewritten and was blocked in strict mode.' },
    SCRIPT_SRC_BLOCKED: { title: 'Script source blocked', desc: 'A script was loaded via a scheme that bypasses the ZeroProxy rewrite pipeline (blob:/data:).' },
    REDIRECT_BODY_NONREPLAYABLE: { title: 'Redirect body cannot be replayed', desc: 'A 307/308 redirect requires resending the request body, but the body is too large or not replayable.' },
    // 리다이렉트 상한을 넘었다. 예전에는 마지막 3xx 를 그대로 브라우저에
    // 넘겼는데, 그 Location 이 절대 URL 이면 **브라우저가 따라가 프록시 밖으로
    // 나갔다**(2026-08-21 실측, 진짜 탈출). 이제 여기서 멈춘다.
    REDIRECT_LIMIT_EXCEEDED: { title: 'Too many redirects', desc: 'The target redirected more times than the proxy will follow. The chain was stopped here rather than handing the last hop to the browser.' },
    WS_BLOCKED: { title: 'WebSocket blocked', desc: 'A WebSocket connection attempt did not go through the ZeroProxy bridge.' },
    RTC_GATEWAY_UNAVAILABLE: { title: 'WebRTC gateway unavailable', desc: 'WebRTC traffic must route through the ZeroProxy gateway, which is not yet provisioned.' },
    WT_UNSUPPORTED: { title: 'WebTransport unsupported', desc: 'WebTransport is not yet supported by this ZeroProxy server.' },
  });
  function errorInfo(code) { return ERROR_INFO[code] || ERROR_INFO.POLICY_BLOCKED; }

  function bytesToBase64Url(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  function base64UrlToBytes(raw) {
    if (typeof raw !== 'string' || raw.length === 0) throw new Error('INVALID_BASE64URL');
    if (/[^A-Za-z0-9_-]/.test(raw) || raw.includes('=') || raw.length % 4 === 1) throw new Error('INVALID_BASE64URL');
    const pad = raw.length % 4 === 0 ? '' : '='.repeat(4 - (raw.length % 4));
    const bin = atob((raw + pad).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function concatBytes(...chunks) {
    let n = 0; for (const c of chunks) n += c.length;
    const out = new Uint8Array(n); let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  async function deriveShareKeys(seed) {
    if (!(seed instanceof Uint8Array) || seed.byteLength !== 64) throw new Error('INVALID_SHARE_LINK');
    const material = await crypto.subtle.importKey('raw', seed, 'HKDF', false, ['deriveKey']);
    const encKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: SHARE_INFO_ENC }, material, { name: 'AES-CBC', length: 256 }, false, ['encrypt', 'decrypt']);
    const macKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: SHARE_INFO_MAC }, material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
    return { encKey, macKey };
  }
  async function encryptShareURL(targetUrl) {
    const canonical = canonicalTargetURL(targetUrl).href;
    const seed = crypto.getRandomValues(new Uint8Array(64));
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const { encKey, macKey } = await deriveShareKeys(seed);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, encKey, te.encode(canonical)));
    const tagData = concatBytes(SHARE_MAC_PREFIX, iv, ciphertext);
    const tag = new Uint8Array(await crypto.subtle.sign('HMAC', macKey, tagData));
    return { encrypted: bytesToBase64Url(concatBytes(iv, ciphertext, tag)), key: bytesToBase64Url(seed), targetUrl: canonical };
  }
  async function decryptShareURL(encrypted, key) {
    const seed = base64UrlToBytes(key);
    const blob = base64UrlToBytes(encrypted);
    if (blob.byteLength < 64 || (blob.byteLength - 16 - 32) % 16 !== 0) throw safeError('INVALID_SHARE_LINK');
    const iv = blob.slice(0, 16);
    const ciphertext = blob.slice(16, blob.byteLength - 32);
    const tag = blob.slice(blob.byteLength - 32);
    const { encKey, macKey } = await deriveShareKeys(seed);
    const ok = await crypto.subtle.verify('HMAC', macKey, tag, concatBytes(SHARE_MAC_PREFIX, iv, ciphertext));
    if (!ok) throw safeError('BAD_HMAC');
    let plain;
    try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, encKey, ciphertext)); }
    catch { throw safeError('INVALID_SHARE_LINK'); }
    return canonicalTargetURL(td.decode(plain)).href;
  }
  function controlPath(path) {
    const raw = String(path || '');
    return CONTROL_PREFIX + raw.replace(/^\/+/, '');
  }
  // 2026-08-14 — 에셋 URL 에 build id 를 실어 `immutable` 캐시를 가능하게 한다.
  //
  // 빌드가 바뀌면 id 가 바뀌고 URL 이 바뀌므로 낡은 사본이 재사용될 수 없다.
  // 빌드 스크립트가 `__ZP_BUILD_ID__` 를 치환한다 — 치환되지 않은 개발 환경
  // (dist 를 거치지 않고 web/ 을 직접 서빙)에서는 플레이스홀더가 그대로 남는데,
  // 그때는 쿼리를 아예 붙이지 않아 서버가 `no-cache` 로 응답하게 둔다.
  // **`assetPath` 는 쿼리를 붙이지 않는다.** 이 함수는 URL 을 만드는 데도
  // 쓰이지만 **경로 비교**에도 쓰인다(sw.js `internalPath`, prelude 의 자기
  // 스크립트 판별). 여기에 `?v=` 를 붙였더니 `url.pathname` 과의 비교가 전부
  // 어긋나 내부 에셋이 VIRTUAL_SUBRESOURCE 로 분류돼 404 가 났다.
  // URL 을 emit 할 때만 `assetURL` 을 쓴다.
  const BUILD_ID = '__ZP_BUILD_ID__';
  const ASSET_VERSION_QUERY = /^[0-9a-f]{6,}$/.test(BUILD_ID) ? '?v=' + BUILD_ID : '';
  function assetPath(name) { return ASSET_PREFIX + String(name || '').replace(/^\/+/, ''); }
  function assetURL(name) { return assetPath(name) + ASSET_VERSION_QUERY; }
  function versionedAsset(absolutePath) { return String(absolutePath || '') + ASSET_VERSION_QUERY; }
  // ★2026-08-22 — "우리 자산" 목록이 세 벌이었고 집합이 서로 달랐다.
  // sw.js `internalPath` 는 7개, prelude 의 자기 스크립트 판별은 3개(부분집합),
  // Go 는 `/__zp/` 파일명을 따로 하드코딩. 프렐류드가 못 알아보는 자산은
  // **직렬화 세정에서 안 지워진다** — 이번 세션에 같은 부류를 한 번 밟았다.
  // 새 자산을 추가할 자리는 이제 여기 하나다.
  //
  // 둘로 나눠 두는 이유: 페이지가 스크립트 태그로 만날 수 있는 것(SCRIPTS)과,
  // SW 가 "내부 경로라 타깃으로 보내면 안 되는 것"(전체)은 범위가 다르다.
  // favicon/manifest 는 문서에 링크로 실려 살아 있어야 하므로 스크립트 판별에
  // 넣지 않는다.
  const INTERNAL_ASSET_SCRIPTS = Object.freeze(['zp-core.js', 'zp-page-bundle.js', 'runtime-prelude.js', 'worker-prelude.js']);
  const INTERNAL_ASSET_OTHER = Object.freeze(['favicon.ico', 'manifest.webmanifest']);
  function isInternalAssetScriptPath(path) { return INTERNAL_ASSET_SCRIPTS.some(n => path === assetPath(n)); }
  function isInternalPath(path) {
    const p = String(path || '');
    // `/__zp/*` 는 wasm-bindgen 산출물 접두다. 여기서 claim 하지 않으면 SW 가
    // VIRTUAL_SUBRESOURCE 로 분류해 가상 base(=타깃) 기준으로 리라이트한다.
    if (p.startsWith('/__zp/')) return true;
    if (isInternalAssetScriptPath(p)) return true;
    if (INTERNAL_ASSET_OTHER.some(n => p === assetPath(n))) return true;
    return p === controlPath('worker-bootstrap.js');
  }
  function apiPath(name) { return controlPath('api/' + String(name || '').replace(/^\/+/, '')); }
  function errorPath(code) { return controlPath('error/' + encodeURIComponent(String(code || 'POLICY_BLOCKED'))); }
  function makeSharePath(encrypted) { return controlPath('p/' + encrypted); }
  async function makeShareURL(targetUrl, origin = globalThis.location && globalThis.location.origin || '', servers) {
    const s = await encryptShareURL(targetUrl);
    return origin + makeSharePath(s.encrypted) + makeShareFragment(s.key, relayServersForShare(servers, { origin, allowLoopbackWS: true }));
  }
  function makeShareFragment(key, servers) {
    const params = new URLSearchParams();
    params.set('k', String(key));
    for (const server of relayServersForShare(servers, { allowLoopbackWS: true })) params.append('server', server);
    return '#' + params.toString();
  }
  function defaultRelayServer(origin) {
    const loc = globalThis.location;
    const rawOrigin = origin || loc && (loc.origin || (loc.protocol && loc.host ? loc.protocol + '//' + loc.host : '')) || 'https://proxy.example';
    const u = new URL(rawOrigin);
    return (u.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + u.host + controlPath('ws-pipe');
  }
  function relayServersForShare(values, options = {}) {
    const normalized = normalizeRelayServers(values || [], options);
    return normalized.length ? normalized : [defaultRelayServer(options.origin)];
  }
  function isSharePath(path) { return String(path || '').startsWith(controlPath('p/')); }
  function shareRouteKey(path) { return isSharePath(path) ? String(path).slice(controlPath('p/').length) : ''; }
  function safeError(code) { const e = new Error(code); e.code = ERRORS.includes(code) ? code : 'POLICY_BLOCKED'; return e; }
  function canonicalTargetURL(input, base) {
    const u = new URL(String(input), base || undefined);
    if (!HTTP_PROTOCOLS.has(u.protocol)) throw safeError('TARGET_PROTOCOL_BLOCKED');
    u.username = ''; u.password = '';
    return u;
  }
  function canonicalWebSocketURL(input, base) {
    const u = new URL(String(input), base || undefined);
    if (!WS_PROTOCOLS.has(u.protocol)) throw safeError('TARGET_PROTOCOL_BLOCKED');
    u.username = ''; u.password = '';
    return u;
  }
  function encodeTargetURL(url) { return bytesToBase64Url(te.encode(canonicalTargetURL(url).href)); }
  function decodeTargetURL(encoded) { return canonicalTargetURL(td.decode(base64UrlToBytes(encoded))).href; }
  function randomId(prefix = '') { const b = crypto.getRandomValues(new Uint8Array(12)); return prefix + bytesToBase64Url(b); }
  // fixedCSP builds the SW-emitted CSP for proxied responses. The legacy
  // signature fixedCSP(servers) and fixedCSP() remain byte-identical (default
  // options); the optional second arg projects the armed Cloudflare-Turnstile
  // compatibility branch when options.challengeCompat is truthy, mirroring the
  // Rust+Go server side: it adds https://challenges.cloudflare.com to
  // script-src, frame-src, child-src, connect-src and NOTHING ELSE — no
  // wildcards, no nonce inflation, no extra eval, no leakage into
  // style/img/font/media/worker. Callers are responsible for the per-tab
  // two-signal gate (operator opt-in AND classifier match); this builder is
  // a pure projection.
  function fixedCSP(servers, options) {
    const loc = globalThis.location;
    const ws = loc ? ((loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host) : 'wss://proxy.example';
    const connect = new Set(["'self'", ws]);
    for (const server of normalizeRelayServers(servers || [], { allowLoopbackWS: true })) {
      try { const u = new URL(server); connect.add(u.origin); } catch {}
    }
    const armed = !!(options && options.challengeCompat);
    const cf = ' https://challenges.cloudflare.com';
    if (armed) connect.add('https://challenges.cloudflare.com');
    return "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'" + (armed ? cf : '') + "; style-src 'self' 'unsafe-inline' blob: data:; img-src 'self' blob: data:; font-src 'self' blob: data:; media-src 'self' blob: data:; connect-src " + Array.from(connect).join(' ') + "; frame-src 'self' blob: data:" + (armed ? cf : '') + "; child-src 'self' blob: data:" + (armed ? cf : '') + "; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; manifest-src 'self'; report-uri /zp/api/csp-report";
  }
  function parseRelayServersFromFragment(fragment, options) {
    const raw = String(fragment || '');
    const params = new URLSearchParams(raw && raw[0] === '#' ? raw.slice(1) : raw);
    return relayServersForShare(params.getAll('server'), options);
  }
  function normalizeRelayServers(values, options = {}) {
    if (!values) return [];
    const list = Array.isArray(values) ? values : [values];
    const out = [];
    const seen = new Set();
    let total = 0;
    for (const raw of list) {
      if (out.length >= MAX_RELAY_SERVERS) throw safeError('MALFORMED_ROUTE');
      const value = String(raw || '').trim();
      if (!value) continue;
      let u;
      try { u = new URL(value); } catch { throw safeError('MALFORMED_ROUTE'); }
      if (u.username || u.password || u.hash) throw safeError('MALFORMED_ROUTE');
      if (u.protocol === 'ws:') {
        if (!options.allowLoopbackWS || !isLoopbackHost(u.hostname)) throw safeError('TARGET_PROTOCOL_BLOCKED');
      } else if (u.protocol !== 'wss:') {
        throw safeError('TARGET_PROTOCOL_BLOCKED');
      }
      u.username = '';
      u.password = '';
      u.hash = '';
      const normalized = u.href;
      total += normalized.length;
      if (total > MAX_RELAY_SERVER_BYTES) throw safeError('MALFORMED_ROUTE');
      if (!seen.has(normalized)) {
        seen.add(normalized);
        out.push(normalized);
      }
    }
    return out;
  }
  function isLoopbackHost(host) {
    const h = String(host || '').toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1' || h === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(h);
  }
  function redirectMethod(status, method) {
    if ((status === 301 || status === 302) && method === 'POST') return 'GET';
    if (status === 303 && method !== 'GET' && method !== 'HEAD') return 'GET';
    return method;
  }
  // Keep native Response identity and brand checks; metadata belongs to the
  // response, not own properties or a Proxy that breaks borrowed methods.
  function createFetchResponseAdapter(ResponseCtor, HeadersCtor, installAccessor, installMethod) {
    const metadata = new WeakMap();
    const proto = ResponseCtor.prototype;
    const nativeClone = proto.clone;
    const nativeError = ResponseCtor.error.bind(ResponseCtor);
    for (const key of ['url', 'redirected', 'type']) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, key);
      const get = function () {
        const native = descriptor.get.call(this);
        const record = metadata.get(this);
        return record ? record[key] : native;
      };
      if (installAccessor) installAccessor(proto, key, get, undefined);
      else Object.defineProperty(proto, key, Object.assign({}, descriptor, { get }));
    }
    const clone = function clone() {
      const result = nativeClone.call(this);
      const record = metadata.get(this);
      if (record) metadata.set(result, record);
      return result;
    };
    if (installMethod) installMethod(proto, 'clone', clone);
    else Object.defineProperty(proto, 'clone', Object.assign({}, Object.getOwnPropertyDescriptor(proto, 'clone'), { value: clone }));
    return function decodeFetchResponse(response) {
      const encoded = response.headers.get('X-ZP-Fetch-Meta');
      if (!encoded) return response;
      const record = JSON.parse(encoded);
      let result;
      if (record.type === 'opaque' || record.type === 'opaqueredirect') {
        if (response.body) response.body.cancel().catch(() => {});
        result = nativeError();
        if (record.type === 'opaque') record.url = '';
        record.redirected = false;
      } else {
        const headers = new HeadersCtor(response.headers);
        headers.delete('X-ZP-Fetch-Meta');
        headers.delete('X-ZP-Set-Cookie');
        headers.delete('X-ZP-Final-URL');
        result = new ResponseCtor(response.body, { status: response.status, statusText: response.statusText, headers });
      }
      metadata.set(result, Object.freeze(record));
      return result;
    };
  }
  const api = Object.freeze({ CONTROL_PREFIX, ASSET_PREFIX, TARGET_USER_AGENT, TARGET_SEC_CH_UA, bytesToBase64Url, base64UrlToBytes, encryptShareURL, decryptShareURL, makeShareURL, makeSharePath, makeShareFragment, defaultRelayServer, relayServersForShare, isSharePath, shareRouteKey, controlPath, assetPath, assetURL, versionedAsset, apiPath, errorPath, INTERNAL_ASSET_SCRIPTS, isInternalAssetScriptPath, isInternalPath, canonicalTargetURL, canonicalWebSocketURL, encodeTargetURL, decodeTargetURL, randomId, fixedCSP, parseRelayServersFromFragment, normalizeRelayServers, isLoopbackHost, redirectMethod, createFetchResponseAdapter, ERRORS, errorInfo });
  // `configurable: true` so the page-realm runtime-prelude can DELETE the
  // named property after capturing it into a closure-local binding.
  // Without that, `Object.getOwnPropertyNames(window)` enumerates `ZP`
  // (the spec returns all own properties regardless of `enumerable`) and
  // an anti-bot probe trivially fingerprints ZeroProxy. SW realm uses ZP
  // directly (no membrane there), so the live mutability concern is only
  // page realm — and runtime-prelude runs BEFORE any target script, so
  // the delete happens before there is anyone to tamper with it.
  Object.defineProperty(globalThis, 'ZP', { value: api, enumerable: false, configurable: true, writable: false });
})();
