const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function loadCore() {
  const ctx = {
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    location: { origin: 'https://proxy.example', protocol: 'https:', host: 'proxy.example' },
  };
  vm.runInNewContext(fs.readFileSync('web/zp-core.js', 'utf8'), ctx);
  return ctx.ZP;
}

test('share URL envelope round-trips and rejects HMAC tamper', async () => {
  const ZP = loadCore();
  const share = await ZP.encryptShareURL('https://Example.com/a/../b?q=1#frag');
  assert.equal(
    await ZP.decryptShareURL(share.encrypted, share.key),
    'https://example.com/b?q=1#frag',
  );
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
  const servers = Array.from(
    ZP.parseRelayServersFromFragment(
      '#k=seed&server=wss%3A%2F%2Frelay.example%2Fws&server=wss%3A%2F%2Frelay.example%3A443%2Fws&server=ws%3A%2F%2F127.0.0.1%3A8787%2Fws',
      { allowLoopbackWS: true },
    ),
  );
  assert.deepEqual(servers, ['wss://relay.example/ws', 'ws://127.0.0.1:8787/ws']);
  assert.throws(
    () =>
      ZP.parseRelayServersFromFragment('#server=ws%3A%2F%2Frelay.example%2Fws', {
        allowLoopbackWS: false,
      }),
    /TARGET_PROTOCOL_BLOCKED/,
  );
  const url = await ZP.makeShareURL('https://example.com/', 'https://proxy.example', servers);
  assert.match(url, /^https:\/\/proxy\.example\/zp\/p\//);
  assert.match(
    url,
    /#k=[^&]+&server=wss%3A%2F%2Frelay\.example%2Fws&server=ws%3A%2F%2F127\.0\.0\.1%3A8787%2Fws$/,
  );
  assert.deepEqual(
    Array.from(ZP.parseRelayServersFromFragment('#k=seed', { origin: 'https://proxy.example' })),
    ['wss://proxy.example/zp/ws-pipe'],
  );
  assert.equal(
    ZP.makeShareFragment('seed', []),
    '#k=seed&server=wss%3A%2F%2Fproxy.example%2Fzp%2Fws-pipe',
  );
});
test('normalizeRelayServers enforces scheme, credential, dedup, cap, and budget invariants', () => {
  const ZP = loadCore();
  // Array.from re-wraps the vm-realm result in this realm so deepStrictEqual's
  // prototype check passes (mirrors the relay-fragment test above); a throw in
  // normalizeRelayServers propagates before Array.from runs.
  const N = (v, o) => Array.from(ZP.normalizeRelayServers(v, o));

  // wss is admissible; ws only to a loopback host, and only when explicitly allowed.
  assert.deepEqual(N('wss://relay.example/ws'), ['wss://relay.example/ws']);
  assert.deepEqual(N('ws://127.0.0.1:8787/ws', { allowLoopbackWS: true }), [
    'ws://127.0.0.1:8787/ws',
  ]);
  assert.deepEqual(N('ws://localhost/ws', { allowLoopbackWS: true }), ['ws://localhost/ws']);

  // Non-wss schemes, and ws to a non-loopback host or with loopback disallowed, are blocked.
  assert.throws(() => N('https://relay.example/ws'), /TARGET_PROTOCOL_BLOCKED/);
  assert.throws(
    () => N('ws://relay.example/ws', { allowLoopbackWS: true }),
    /TARGET_PROTOCOL_BLOCKED/,
  );
  assert.throws(
    () => N('ws://127.0.0.1/ws', { allowLoopbackWS: false }),
    /TARGET_PROTOCOL_BLOCKED/,
  );

  // Embedded credentials or a fragment are rejected outright — never laundered through.
  assert.throws(() => N('wss://user:pass@relay.example/ws'), /MALFORMED_ROUTE/);
  assert.throws(() => N('wss://relay.example/ws#frag'), /MALFORMED_ROUTE/);
  assert.throws(() => N('not a url'), /MALFORMED_ROUTE/);

  // The cap admits exactly MAX_RELAY_SERVERS (8) distinct entries and rejects the
  // 9th — pinning both boundary sides catches a silent raise OR lowering of the cap.
  // It is also enforced before a blank surplus entry is skipped (order matters).
  const eight = Array.from({ length: 8 }, (_, i) => `wss://r${i}.example/ws`);
  assert.equal(N(eight).length, 8);
  assert.throws(() => N([...eight, 'wss://r8.example/ws']), /MALFORMED_ROUTE/);
  assert.throws(() => N([...eight, '   ']), /MALFORMED_ROUTE/);

  // The budget bounds the running AGGREGATE, not each entry: entries each well
  // under the cap but jointly over it are rejected (would pass a per-entry limit).
  const mid = (i) => `wss://r${i}.example/${'a'.repeat(600)}`; // ~617 B each
  assert.equal(N([mid(0), mid(1), mid(2)]).length, 3); // 3*617=1851 <= 2048
  assert.throws(() => N([mid(0), mid(1), mid(2), mid(3)]), /MALFORMED_ROUTE/); // 2468 > 2048
  // Duplicates collapse in the output but are CHARGED before the dedup check:
  // three copies of one ~720 B URL dedupe to a single entry yet still bust 2048.
  const big = `wss://relay.example/${'a'.repeat(700)}`; // 720 B
  assert.deepEqual(N([big]), [big]); // one copy: 720 <= 2048
  assert.throws(() => N([big, big, big]), /MALFORMED_ROUTE/); // 2160 > 2048 despite dedup to 1
  // A single entry over the cap is rejected too.
  assert.throws(() => N(`wss://relay.example/${'a'.repeat(2100)}`), /MALFORMED_ROUTE/);
  // Distinct duplicates dedupe in the output.
  assert.deepEqual(N(['wss://a.example/ws', 'wss://a.example/ws', 'wss://b.example/ws']), [
    'wss://a.example/ws',
    'wss://b.example/ws',
  ]);

  // Blank and nullish inputs normalize to an empty list.
  assert.deepEqual(N(null), []);
  assert.deepEqual(N(['', '   ']), []);
});
