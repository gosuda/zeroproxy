/* ZeroProxy shared browser primitives. Classic script; exposes non-enumerable global ZP. */
(() => {
  'use strict';
  if (globalThis.ZP) return;
  // Tables built with a copy of each built-in's prototype taken before any page script ran (the same factories as
  // web/membrane/00-head.js): a page that wraps `Set.prototype.add` must not see the relay URLs this library dedupes.
  const sealProtoOf = proto => Object.create(null, Object.getOwnPropertyDescriptors(proto));
  const SEALED_MAP = sealProtoOf(Map.prototype);
  const SEALED_SET = sealProtoOf(Set.prototype);
  const SEALED_WEAKMAP = sealProtoOf(WeakMap.prototype);
  const sealedSetProto = Object.setPrototypeOf;
  const newMap = entries => {
    const m = sealedSetProto(new Map(), SEALED_MAP);
    if (entries) for (let i = 0; i < entries.length; i++) m.set(entries[i][0], entries[i][1]);
    return m;
  };
  const newSet = items => {
    const t = sealedSetProto(new Set(), SEALED_SET);
    if (items) for (let i = 0; i < items.length; i++) t.add(items[i]);
    return t;
  };
  const newWeakMap = () => sealedSetProto(new WeakMap(), SEALED_WEAKMAP);
  const te = new TextEncoder();
  const td = new TextDecoder('utf-8', { fatal: true });
  const SHARE_INFO_ENC = te.encode('zp-url-cbc-enc');
  const SHARE_INFO_MAC = te.encode('zp-url-cbc-mac');
  const SHARE_MAC_PREFIX = te.encode('ZP-CBC-URL-V1');
  const HTTP_PROTOCOLS = newSet(['http:', 'https:']);
  const WS_PROTOCOLS = newSet(['ws:', 'wss:']);
  const CONTROL_PREFIX = '/zp/';
  const ASSET_PREFIX = CONTROL_PREFIX + 'assets/';
  // Default User-Agent presented to target servers. Browsers forbid setting User-Agent on fetch(), so the SW sends
  // X-ZP-User-Agent and the relay promotes it. The HTTP User-Agent, navigator.userAgent, Sec-CH-UA brands, and the
  // captured TLS ClientHello in sw.js must all report the same Chrome major version to avoid cross-signal WAF detection.
  // Keep worker-prelude.js TARGET_USER_AGENT in lockstep.
  const TARGET_CHROME_MAJOR = 154;
  const TARGET_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + TARGET_CHROME_MAJOR + '.0.0.0 Safari/537.36';
  // Chromium derives the low-entropy Sec-CH-UA brand list deterministically from the major version
  // (components/embedder_support/user_agent_utils.cc): the GREASE brand is `Not` + a + `A` + b + `Brand` with a and b
  // indexed by `major % 11` and `(major + 1) % 11`, its version is `["8", "99", "24"][major % 3]`, and `major % 6`
  // selects the permutation of [GREASE, Chromium, Google Chrome]. Computing this list guarantees the wire header
  // matches TARGET_CHROME_MAJOR rather than leaking the host browser's own brand (such as Edge WebView2).
  function chromeBrandList(major) {
    const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const generated = [
      { brand: 'Not' + chars[major % 11] + 'A' + chars[(major + 1) % 11] + 'Brand', version: ['8', '99', '24'][major % 3] },
      { brand: 'Chromium', version: String(major) },
      { brand: 'Google Chrome', version: String(major) },
    ];
    const order = orders[major % 6];
    const list = [];
    generated.forEach((entry, i) => { list[order[i]] = entry; });
    return list;
  }
  const TARGET_SEC_CH_UA = chromeBrandList(TARGET_CHROME_MAJOR).map(b => '"' + b.brand + '";v="' + b.version + '"').join(', ');
  // High-entropy User-Agent values returned by `navigator.userAgentData.getHighEntropyValues()` and `Sec-CH-UA-*`
  // headers when requested via `Accept-CH`. Both the HTTP hints and the JS API report the full four-part build number
  // (`.0.0.0` appears only in the reduced User-Agent string); the GREASE brand reports its major version plus `.0.0.0`.
  const TARGET_CHROME_FULL_VERSION = TARGET_CHROME_MAJOR + '.0.8037.98';
  const TARGET_UA_HIGH_ENTROPY = Object.freeze({
    architecture: 'x86',
    bitness: '64',
    formFactors: Object.freeze(['Desktop']),
    fullVersionList: Object.freeze(chromeBrandList(TARGET_CHROME_MAJOR).map(b => Object.freeze({
      brand: b.brand,
      version: b.brand === 'Chromium' || b.brand === 'Google Chrome' ? TARGET_CHROME_FULL_VERSION : b.version + '.0.0.0',
    }))),
    model: '',
    platformVersion: '19.0.0',
    uaFullVersion: TARGET_CHROME_FULL_VERSION,
    wow64: false,
  });
  // Blink serializes the WebIDL dictionary returned by `getHighEntropyValues(hints)` with keys in alphabetical order,
  // always including `brands`, `mobile`, and `platform` alongside any recognized hint names.
  // `clientEnvOf` captures viewport, DPR, and media-preference values for client hints on tab requests.
  function clientEnvOf(win) {
    const env = { top: false };
    try {
      const mq = q => { try { return !!win.matchMedia(q).matches; } catch { return false; } };
      env.dpr = Number(win.devicePixelRatio) || 1;
      env.vw = Number(win.innerWidth) || 0;
      env.vh = Number(win.innerHeight) || 0;
      env.scheme = mq('(prefers-color-scheme: dark)') ? 'dark' : 'light';
      env.motion = mq('(prefers-reduced-motion: reduce)') ? 'reduce' : 'no-preference';
      env.transparency = mq('(prefers-reduced-transparency: reduce)') ? 'reduce' : 'no-preference';
      env.top = win.top === win;
    } catch {}
    return env;
  }
  function uaHighEntropyValues(hints, brands, platform) {
    const all = Object.assign({ brands, mobile: false, platform }, TARGET_UA_HIGH_ENTROPY);
    const wanted = newSet(['brands', 'mobile', 'platform']);
    for (const h of (hints || [])) if (Object.prototype.hasOwnProperty.call(all, h)) wanted.add(String(h));
    const out = {};
    for (const k of Array.from(wanted).sort()) {
      const v = all[k];
      out[k] = Array.isArray(v) ? v.map(x => (x && typeof x === 'object' ? Object.assign({}, x) : x)) : v;
    }
    return out;
  }
  const MAX_RELAY_SERVERS = 8;
  const MAX_RELAY_SERVER_BYTES = 2048;
  const ERRORS = Object.freeze(['BAD_HMAC','INVALID_SHARE_LINK','MALFORMED_ROUTE','SW_NOT_READY','TARGET_PROTOCOL_BLOCKED','TLS_CERTIFICATE_INVALID','TLS_HANDSHAKE_FAILED','TARGET_CONNECT_FAILED','TARGET_HTTP_FAILED','MALFORMED_HTML','REALM_INJECTION_FAILURE','REQUEST_BODY_TOO_LARGE','SUBMISSION_EXPIRED','POLICY_BLOCKED','REWRITE_FAILED','SCRIPT_SRC_BLOCKED','REDIRECT_BODY_NONREPLAYABLE','REDIRECT_LIMIT_EXCEEDED','WS_BLOCKED','RTC_GATEWAY_UNAVAILABLE','WT_UNSUPPORTED']);
  // Error titles and descriptions matching crates/zp-shared/src/errors.rs ErrorCode::as_str.
  const ERROR_INFO = Object.freeze({
    BAD_HMAC: { title: 'Tampered share link', desc: 'The share link signature does not verify. The link may have been altered.' },
    INVALID_SHARE_LINK: { title: 'Invalid share link', desc: 'The share link or decryption key is missing or malformed.' },
    MALFORMED_ROUTE: { title: 'Malformed route', desc: 'The requested ZeroProxy route is not well-formed.' },
    SW_NOT_READY: { title: 'Transport not ready', desc: 'The ZeroProxy Service Worker transport is still initializing. Refresh in a moment.' },
    TARGET_PROTOCOL_BLOCKED: { title: 'Unsupported scheme', desc: 'Only http:// and https:// targets are allowed.' },
    TLS_CERTIFICATE_INVALID: { title: 'TLS certificate rejected', desc: 'The target presented a TLS certificate that did not pass validation.' },
    TLS_HANDSHAKE_FAILED: { title: 'TLS handshake failed', desc: 'ZeroProxy could not establish a TLS connection with the target.' },
    TARGET_CONNECT_FAILED: { title: 'Could not reach target', desc: 'ZeroProxy could not connect to the target server.' },
    TARGET_HTTP_FAILED: { title: 'Target returned an error', desc: 'The target server responded with an error, or the HTTP/TLS layer failed before a response arrived. Retry, or check the target URL.' },
    MALFORMED_HTML: { title: 'Malformed HTML', desc: 'The target response contained HTML that could not be safely parsed in strict mode.' },
    REALM_INJECTION_FAILURE: { title: 'Containment failed', desc: 'ZeroProxy could not inject the page containment runtime. Target code execution was blocked.' },
    REQUEST_BODY_TOO_LARGE: { title: 'Request body too large', desc: 'The uploaded body exceeded the ZeroProxy maximum size.' },
    SUBMISSION_EXPIRED: { title: 'Form submission expired', desc: 'The original POST submission cache has expired. Reload the form and resubmit.' },
    POLICY_BLOCKED: { title: 'Blocked by policy', desc: 'This operation is not allowed by ZeroProxy strict-mode policy.' },
    REWRITE_FAILED: { title: 'JavaScript rewrite failed', desc: 'A target script could not be safely rewritten and was blocked in strict mode.' },
    SCRIPT_SRC_BLOCKED: { title: 'Script source blocked', desc: 'A script was loaded via a scheme that bypasses the ZeroProxy rewrite pipeline (blob:/data:).' },
    REDIRECT_BODY_NONREPLAYABLE: { title: 'Redirect body cannot be replayed', desc: 'A 307/308 redirect requires resending the request body, but the body is too large or not replayable.' },
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
  // Builds the gateway request for `new WebTransport(target, options)`. Because the browser connects to the gateway
  // rather than the target, `serverCertificateHashes` from the caller are forwarded as `certhash` query parameters for
  // the gateway's upstream dial instead of being passed to the native constructor (where they would fail against the
  // gateway's own certificate). `gatewayCertHashes` pins a self-signed development gateway certificate when present.
  const WT_OPTION_MEMBERS = Object.freeze(['allowPooling', 'requireUnreliable', 'congestionControl', 'protocols', 'anticipatedConcurrentIncomingUnidirectionalStreams', 'anticipatedConcurrentIncomingBidirectionalStreams', 'datagramsReadableType']);
  const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
  function bufferSourceBytes(v) {
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    arrayBufferByteLength.call(v); // brand check: TypeError for anything but an ArrayBuffer
    return new Uint8Array(v);
  }
  // Replaces the caller's ICE servers with the operator's TURN credentials and forces `iceTransportPolicy: 'relay'`
  // so the browser gathers only relay candidates and never exposes the client IP address. DTLS/SRTP remain end-to-end.
  function relayOnlyRTCConfiguration(config, iceServers) {
    const c = Object.assign({}, config == null ? {} : config);
    c.iceServers = iceServers;
    c.iceTransportPolicy = 'relay';
    return c;
  }
  function webTransportGatewayRequest(gatewayURL, target, tabId, options, gatewayCertHashes) {
    const gw = new URL(gatewayURL);
    gw.searchParams.set('target', String(target));
    if (tabId) gw.searchParams.set('tab', String(tabId));
    const native = {};
    if (options != null && typeof options === 'object') {
      for (const k of WT_OPTION_MEMBERS) {
        const v = options[k];
        if (v !== undefined) native[k] = v;
      }
      const pins = options.serverCertificateHashes;
      if (pins != null) {
        // An empty array still requests certificate pinning; the gateway must not fall back to CA validation.
        gw.searchParams.set('pinned', '1');
        for (const h of pins) {
          if (!h || String(h.algorithm).toLowerCase() !== 'sha-256') continue;
          gw.searchParams.append('certhash', bytesToBase64Url(bufferSourceBytes(h.value)));
        }
      }
    }
    const own = Array.isArray(gatewayCertHashes) ? gatewayCertHashes.filter(h => typeof h === 'string' && h) : [];
    if (own.length) native.serverCertificateHashes = own.map(h => ({ algorithm: 'sha-256', value: base64UrlToBytes(h) }));
    return { url: gw.toString(), options: native };
  }
  // Binary envelope for `POST /zp/api/v2/fetch`: `[u32le headLen][headJSON][rawBody]`.
  // `head` carries the request metadata with `init.body` set to null while the raw body bytes follow the header.
  const ENVELOPE_MIME = 'application/zp-envelope';
  function encodeEnvelope(headObj, bodyBytes) {
    const head = te.encode(JSON.stringify(headObj));
    const body = bodyBytes || new Uint8Array(0);
    const out = new Uint8Array(4 + head.length + body.length);
    new DataView(out.buffer).setUint32(0, head.length, true);
    out.set(head, 4);
    out.set(body, 4 + head.length);
    return out;
  }
  function decodeEnvelope(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (u8.length < 4) throw new Error('BAD_ENVELOPE');
    const headLen = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(0, true);
    if (headLen > u8.length - 4) throw new Error('BAD_ENVELOPE');
    const head = JSON.parse(td.decode(u8.subarray(4, 4 + headLen)));
    return { head, body: u8.subarray(4 + headLen) };
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
  // Build scripts replace `__ZP_BUILD_ID__` with a content hash so `assetURL` can append `?v=<id>` for immutable
  // caching. `assetPath` omits the query string because callers compare it directly against `url.pathname`.
  const BUILD_ID = '__ZP_BUILD_ID__';
  const ASSET_VERSION_QUERY = /^[0-9a-f]{6,}$/.test(BUILD_ID) ? '?v=' + BUILD_ID : '';
  function assetPath(name) { return ASSET_PREFIX + String(name || '').replace(/^\/+/, ''); }
  function assetURL(name) { return assetPath(name) + ASSET_VERSION_QUERY; }
  function versionedAsset(absolutePath) { return String(absolutePath || '') + ASSET_VERSION_QUERY; }
  // Canonical lists of proxy-internal assets. `INTERNAL_ASSET_SCRIPTS` identifies scripts stripped from DOM
  // serialization by the prelude; `INTERNAL_ASSET_OTHER` covers non-script assets (`favicon.ico`, manifest) that
  // the SW serves locally rather than routing as target subresources.
  const INTERNAL_ASSET_SCRIPTS = Object.freeze(['zp-core.js', 'zp-page-bundle.js', 'runtime-prelude.js', 'worker-prelude.js']);
  const INTERNAL_ASSET_OTHER = Object.freeze(['favicon.ico', 'manifest.webmanifest']);
  function isInternalAssetScriptPath(path) { return INTERNAL_ASSET_SCRIPTS.some(n => path === assetPath(n)); }
  function isInternalPath(path) {
    const p = String(path || '');
    // `/__zp/*` serves WASM artifacts and must not be routed as a target subresource.
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
  // Wire message type constants shared across the launcher, page runtime, and Service Worker.
  const MSG = Object.freeze({
    BASE_UPDATE: 'ZP_BASE_UPDATE',
    BIND_CLIENT: 'ZP_BIND_CLIENT',
    COOKIE_SET: 'ZP_COOKIE_SET',
    COOKIE_CHANGE: 'ZP_COOKIE_CHANGE',
    ENCODED_SIZE: 'ZP_ENCODED_SIZE',
    ENCODED_SIZE_QUERY: 'ZP_ENCODED_SIZE_QUERY',
    FLUSH_COOKIES: 'ZP_FLUSH_COOKIES',
    FRAME_ROUTE: 'ZP_FRAME_ROUTE',
    HISTORY_UPDATE: 'ZP_HISTORY_UPDATE',
    OPEN_SHARE: 'ZP_OPEN_SHARE',
    REFERRER_POLICY: 'ZP_REFERRER_POLICY',
    RESOLVE_ENTRY: 'ZP_RESOLVE_ENTRY',
    SCROLL_UPDATE: 'ZP_SCROLL_UPDATE',
    SUBMIT_PREPARE: 'ZP_SUBMIT_PREPARE',
    WORKER_STASH: 'ZP_WORKER_STASH',
    WS_OPEN: 'ZP_WS_OPEN',
  });
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
  // Builds the Content-Security-Policy header emitted by the SW for proxied responses. When `options.challengeCompat`
  // is set, adds `https://challenges.cloudflare.com` to `script-src`, `frame-src`, `child-src`, and `connect-src`.
  function fixedCSP(servers, options) {
    const loc = globalThis.location;
    const ws = loc ? ((loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host) : 'wss://proxy.example';
    const connect = newSet(["'self'", ws]);
    for (const server of normalizeRelayServers(servers || [], { allowLoopbackWS: true })) {
      try { const u = new URL(server); connect.add(u.origin); } catch {}
    }
    // The WebTransport gateway listens on a separate port and requires its origin in `connect-src`.
    for (const extra of (options && options.extraConnect) || []) {
      try { connect.add(new URL(extra).origin); } catch {}
    }
    const armed = !!(options && options.challengeCompat);
    const cf = ' https://challenges.cloudflare.com';
    if (armed) connect.add('https://challenges.cloudflare.com');
    return "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:" + (armed ? cf : '') + "; style-src 'self' 'unsafe-inline' blob: data:; img-src 'self' blob: data:; font-src 'self' blob: data:; media-src 'self' blob: data:; connect-src " + Array.from(connect).join(' ') + " blob: data:; frame-src 'self' blob: data:" + (armed ? cf : '') + "; child-src 'self' blob: data:" + (armed ? cf : '') + "; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; manifest-src 'self'; report-uri /zp/api/csp-report";
  }
  // Filters `<meta http-equiv="Content-Security-Policy">` directives to match `zp-shared::csp::filter_meta_csp`.
  // Browser `<meta>` CSP only tightens header policies, so infrastructure directives merge required proxy sources
  // (`'self'`, `blob:`, `'unsafe-inline'`, `'unsafe-eval'`, `'wasm-unsafe-eval'`) while resource directives preserve
  // `'none'` or add `'self'`. Keep in sync with the Rust implementation.
  const META_CSP_INFRA = {
    'script-src': "'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
    'script-src-elem': "'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
    'script-src-attr': "'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
    'connect-src': "'self' blob: data:",
    'worker-src': "'self' blob:",
    'child-src': "'self' blob: data:",
    'frame-src': "'self' blob: data:",
    'style-src': "'self' 'unsafe-inline' blob: data:",
    'style-src-elem': "'self' 'unsafe-inline' blob: data:",
    'style-src-attr': "'self' 'unsafe-inline' blob: data:",
    'default-src': "'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:",
  };
  const META_CSP_RESOURCE = newSet(['img-src', 'media-src', 'font-src', 'object-src', 'manifest-src', 'prefetch-src', 'form-action', 'base-uri']);
  function filterMetaCSP(content) {
    const out = [];
    for (const segment of String(content || '').split(';')) {
      const seg = segment.trim();
      if (!seg) continue;
      const parts = seg.split(/\s+/);
      const name = (parts.shift() || '').toLowerCase();
      if (!parts.length) continue;
      const infra = META_CSP_INFRA[name];
      if (infra) {
        const sources = parts.filter(s => s !== "'none'");
        for (const extra of infra.split(/\s+/)) if (!sources.includes(extra)) sources.push(extra);
        out.push(name + ' ' + sources.join(' '));
      } else if (META_CSP_RESOURCE.has(name)) {
        if (parts.includes("'none'")) out.push(name + " 'none'");
        else { const sources = parts.slice(); if (!sources.includes("'self'")) sources.push("'self'"); out.push(name + ' ' + sources.join(' ')); }
      }
    }
    return out.join('; ');
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
    const seen = newSet();
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
  // Preserves native Response identity and brand checks by storing virtualized metadata in a WeakMap rather than
  // wrapping instances in a Proxy. `onMeta(record)` runs before returning so callers can apply `record.cookies`.
  function createFetchResponseAdapter(ResponseCtor, HeadersCtor, installAccessor, installMethod, onMeta) {
    const metadata = newWeakMap();
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
      // The worker refused the request (a CORS check failed, a redirect was not allowed): fetch() rejects.
      if (record.type === 'error') {
        if (response.body) response.body.cancel().catch(() => {});
        throw new TypeError('Failed to fetch');
      }
      if (onMeta) { try { onMeta(record); } catch {} }
      delete record.cookies;
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
        // Chromium may expose an empty stream for a synthetic SW response,
        // but reconstructing 204/205/304 requires an actual null body.
        const nullBody = response.status === 204 || response.status === 205 || response.status === 304;
        if (nullBody && response.body) response.body.cancel().catch(() => {});
        result = new ResponseCtor(nullBody ? null : response.body, { status: response.status, statusText: response.statusText, headers });
      }
      metadata.set(result, Object.freeze(record));
      return result;
    };
  }
  const api = Object.freeze({ CONTROL_PREFIX, ASSET_PREFIX, TARGET_USER_AGENT, TARGET_SEC_CH_UA, TARGET_CHROME_FULL_VERSION, TARGET_UA_HIGH_ENTROPY, uaHighEntropyValues, clientEnvOf, chromeBrandList, bytesToBase64Url, base64UrlToBytes, webTransportGatewayRequest, relayOnlyRTCConfiguration, ENVELOPE_MIME,encodeEnvelope, decodeEnvelope, encryptShareURL, decryptShareURL, makeShareURL, makeSharePath, makeShareFragment, defaultRelayServer, relayServersForShare, isSharePath, shareRouteKey, controlPath, assetPath, assetURL, versionedAsset, apiPath, errorPath, INTERNAL_ASSET_SCRIPTS, isInternalAssetScriptPath, isInternalPath, canonicalTargetURL, canonicalWebSocketURL, encodeTargetURL, decodeTargetURL, randomId, fixedCSP, filterMetaCSP, parseRelayServersFromFragment, normalizeRelayServers, isLoopbackHost, redirectMethod, createFetchResponseAdapter, ERRORS, errorInfo, MSG });
  // `configurable: true` allows the page prelude to delete `globalThis.ZP` after capturing it into a closure binding,
  // preventing `Object.getOwnPropertyNames(window)` from exposing `ZP` to target scripts.
  Object.defineProperty(globalThis, 'ZP', { value: api, enumerable: false, configurable: true, writable: false });
})();
