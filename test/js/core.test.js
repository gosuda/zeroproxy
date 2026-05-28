const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function loadCore() {
  const ctx = { crypto: webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams, btoa: s => Buffer.from(s, 'binary').toString('base64'), atob: s => Buffer.from(s, 'base64').toString('binary'), location: { origin: 'https://proxy.example', protocol: 'https:', host: 'proxy.example' } };
  vm.runInNewContext(fs.readFileSync('web/zp-core.js', 'utf8'), ctx);
  return ctx.ZP;
}

test('share URL envelope round-trips and rejects HMAC tamper', async () => {
  const ZP = loadCore();
  const share = await ZP.encryptShareURL('https://Example.com/a/../b?q=1#frag');
  assert.equal(await ZP.decryptShareURL(share.encrypted, share.key), 'https://example.com/b?q=1#frag');
  const raw = ZP.base64UrlToBytes(share.encrypted);
  raw[20] ^= 1;
  await assert.rejects(() => ZP.decryptShareURL(ZP.bytesToBase64Url(raw), share.key), /BAD_HMAC/);
});

test('base64url decoder is raw path-safe only', () => {
  const ZP = loadCore();
  assert.throws(() => ZP.base64UrlToBytes('abcd='), /INVALID_BASE64URL/);
  assert.throws(() => ZP.base64UrlToBytes('ab+cd'), /INVALID_BASE64URL/);
  assert.throws(() => ZP.base64UrlToBytes('a'), /INVALID_BASE64URL/);
});
test('relay server fragments normalize, dedupe, and round-trip through share URLs', async () => {
  const ZP = loadCore();
  const servers = Array.from(ZP.parseRelayServersFromFragment('#k=seed&server=wss%3A%2F%2Frelay.example%2Fws&server=wss%3A%2F%2Frelay.example%3A443%2Fws&server=ws%3A%2F%2F127.0.0.1%3A8787%2Fws', { allowLoopbackWS: true }));
  assert.deepEqual(servers, ['wss://relay.example/ws', 'ws://127.0.0.1:8787/ws']);
  assert.throws(() => ZP.parseRelayServersFromFragment('#server=ws%3A%2F%2Frelay.example%2Fws', { allowLoopbackWS: false }), /TARGET_PROTOCOL_BLOCKED/);
  const url = await ZP.makeShareURL('https://example.com/', 'https://proxy.example', servers);
  assert.match(url, /^https:\/\/proxy\.example\/zp\/p\//);
  assert.match(url, /#k=[^&]+&server=wss%3A%2F%2Frelay\.example%2Fws&server=ws%3A%2F%2F127\.0\.0\.1%3A8787%2Fws$/);
});