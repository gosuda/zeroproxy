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
  assert.deepEqual(Array.from(ZP.parseRelayServersFromFragment('#k=seed', { origin: 'https://proxy.example' })), ['wss://proxy.example/zp/ws-pipe']);
  assert.equal(ZP.makeShareFragment('seed', []), '#k=seed&server=wss%3A%2F%2Fproxy.example%2Fzp%2Fws-pipe');
});
// The persona's `sec-ch-ua` is Chromium's own brand list for the persona's major version. These are the lists real Chrome
// sent at those versions (names, versions and order), so a change to the rule shows up here, not in a WAF's score.
test('the Chrome brand list follows Chromium\'s rule: it reproduces what real Chrome sent', () => {
  const ZP = loadCore();
  const header = major => ZP.chromeBrandList(major).map(b => `"${b.brand}";v="${b.version}"`).join(', ');
  assert.equal(header(120), '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"');
  assert.equal(header(126), '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"');
  assert.equal(header(131), '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"');
  assert.equal(header(134), '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"');
  assert.equal(header(136), '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"');
  assert.equal(header(140), '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"');
  // the greased brand this machine's own browser (Edge 154) sends is the one the rule gives at 154
  assert.ok(header(154).includes('"Not A(Brand";v="99"'));
});

test('the persona\'s User-Agent and sec-ch-ua name one Chrome version, in every realm that has its own copy', () => {
  const ZP = loadCore();
  const major = /Chrome\/(\d+)\./.exec(ZP.TARGET_USER_AGENT)[1];
  assert.equal(ZP.TARGET_SEC_CH_UA, ZP.chromeBrandList(Number(major)).map(b => `"${b.brand}";v="${b.version}"`).join(', '));
  assert.ok(ZP.TARGET_SEC_CH_UA.includes(`"Chromium";v="${major}"`) && ZP.TARGET_SEC_CH_UA.includes(`"Google Chrome";v="${major}"`));
  // a worker has no ZP: its copy of the UA string must be the same string
  const worker = fs.readFileSync('web/worker-prelude.js', 'utf8');
  const copy = /const TARGET_USER_AGENT = '([^']+)'/.exec(worker);
  assert.ok(copy, 'worker-prelude.js no longer carries a TARGET_USER_AGENT literal');
  assert.equal(copy[1], ZP.TARGET_USER_AGENT);
});
