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
  const ERRORS = Object.freeze(['BAD_HMAC','INVALID_SHARE_LINK','MALFORMED_ROUTE','SW_NOT_READY','TARGET_PROTOCOL_BLOCKED','TLS_CERTIFICATE_INVALID','TLS_HANDSHAKE_FAILED','TARGET_CONNECT_FAILED','MALFORMED_HTML','REALM_INJECTION_FAILURE','REQUEST_BODY_TOO_LARGE','POLICY_BLOCKED']);

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
  function makeSharePath(encrypted) { return '/p/' + encrypted; }
  async function makeShareURL(targetUrl, origin = globalThis.location && globalThis.location.origin || '') {
    const s = await encryptShareURL(targetUrl);
    return origin + makeSharePath(s.encrypted) + '#k=' + s.key;
  }
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
  function fixedCSP() {
    const loc = globalThis.location;
    const ws = loc ? ((loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host) : 'wss://proxy.example';
    return "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src * 'unsafe-inline' blob: data:; img-src * blob: data:; font-src * blob: data:; media-src * blob: data:; connect-src 'self' " + ws + "; frame-src 'self' blob: data:; child-src 'self' blob: data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; manifest-src 'self'";
  }
  const api = Object.freeze({ bytesToBase64Url, base64UrlToBytes, encryptShareURL, decryptShareURL, makeShareURL, canonicalTargetURL, canonicalWebSocketURL, encodeTargetURL, decodeTargetURL, randomId, fixedCSP, ERRORS });
  Object.defineProperty(globalThis, 'ZP', { value: api, enumerable: false, configurable: false, writable: false });
})();
