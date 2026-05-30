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
  const MAX_RELAY_SERVERS = 8;
  const MAX_RELAY_SERVER_BYTES = 2048;
  const ERRORS = Object.freeze(['BAD_HMAC','INVALID_SHARE_LINK','MALFORMED_ROUTE','SW_NOT_READY','TARGET_PROTOCOL_BLOCKED','TLS_CERTIFICATE_INVALID','TLS_HANDSHAKE_FAILED','TARGET_CONNECT_FAILED','MALFORMED_HTML','REALM_INJECTION_FAILURE','REQUEST_BODY_TOO_LARGE','SUBMISSION_EXPIRED','POLICY_BLOCKED']);

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
  function assetPath(name) { return ASSET_PREFIX + String(name || '').replace(/^\/+/, ''); }
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
  function fixedCSP(servers, options = {}) {
    const loc = globalThis.location;
    const ws = loc ? ((loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host) : 'wss://proxy.example';
    const connect = new Set(["'self'", ws]);
    for (const server of normalizeRelayServers(servers || [], { allowLoopbackWS: true })) {
      try { const u = new URL(server); connect.add(u.origin); } catch {}
    }
    // Challenge-compatibility projection (default OFF; caller-gated by the two-signal
    // arm+classifier chain in cmd/wasm-kernel). When ON we ADD the challenge host to
    // script/connect/frame/child so a real human's Cloudflare challenge can execute;
    // it adds NO wildcard and NO direct-egress capability (fetches still route through
    // the proxy transport), and it NEVER manufactures eval -- 'unsafe-eval' rides the
    // existing allowDynamicCompile grant below, honoring the target CSP only (F3).
    const challengeCompat = !!(options && options.challengeCompat);
    const cf = challengeCompat ? " https://challenges.cloudflare.com" : "";
    if (challengeCompat) connect.add("https://challenges.cloudflare.com");
    const script = options && options.allowDynamicCompile ? "script-src 'self' blob: 'nonce-zp' 'unsafe-eval' 'wasm-unsafe-eval'" : "script-src 'self' blob: 'nonce-zp' 'wasm-unsafe-eval'";
    return "default-src 'none'; " + script + cf + "; style-src * 'unsafe-inline' blob: data:; img-src * blob: data:; font-src * blob: data:; media-src * blob: data:; connect-src " + Array.from(connect).join(' ') + "; frame-src 'self' blob: data:" + cf + "; child-src 'self' blob: data:" + cf + "; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; manifest-src 'self'";
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
  const api = Object.freeze({ CONTROL_PREFIX, ASSET_PREFIX, bytesToBase64Url, base64UrlToBytes, encryptShareURL, decryptShareURL, makeShareURL, makeSharePath, makeShareFragment, defaultRelayServer, relayServersForShare, isSharePath, shareRouteKey, controlPath, assetPath, apiPath, errorPath, canonicalTargetURL, canonicalWebSocketURL, encodeTargetURL, decodeTargetURL, randomId, fixedCSP, parseRelayServersFromFragment, normalizeRelayServers, isLoopbackHost, ERRORS });
  Object.defineProperty(globalThis, 'ZP', { value: api, enumerable: false, configurable: false, writable: false });
})();
