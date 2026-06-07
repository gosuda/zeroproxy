const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const sources = () =>
  [
    fs.readFileSync('web/runtime-prelude.mjs', 'utf8'),
    fs.readFileSync('web/runtime/facades/document.mjs', 'utf8'),
    fs.readFileSync('web/runtime/facades/storage.mjs', 'utf8'),
    fs.readFileSync('web/sw.js', 'utf8'),
    fs.readFileSync('scripts/compat-corpus.mjs', 'utf8'),
    fs.readFileSync('internal/cookiejar/jar.go', 'utf8'),
    fs.readFileSync('internal/zphttp/redirect.go', 'utf8'),
  ].join('\n');
const matrix = () =>
  JSON.parse(fs.readFileSync('test/fixtures/cookie-storage-samesite-matrix.json', 'utf8'));

const byId = (id) => matrix().find((row) => row.id === id);

test('cookie/storage/SameSite diagnostics matrix covers planned surfaces', () => {
  const ids = new Set(matrix().map((row) => row.id));
  for (const id of [
    'redirect-chain-set-cookie',
    'document-cookie-network-cookie',
    'samesite-lax-strict-none',
    'iframe-cookie-visibility',
    'storage-sharing-reload-popup-frame',
    'cookie-failure-telemetry',
  ])
    assert.equal(ids.has(id), true, id);
});

test('cookie/storage/SameSite diagnostics matrix is redacted and wired', () => {
  const source = sources();
  for (const row of matrix()) {
    assert.ok(
      row.redaction.every((item) => !/value$/i.test(item)),
      `${row.id} must not log raw values`,
    );
    for (const needle of row.existingNeedles)
      assert.ok(source.includes(needle), `${row.id} missing ${needle}`);
  }
});

test('cookie/storage/SameSite diagnostics matrix carries concrete redacted behavior oracles', () => {
  for (const row of matrix()) {
    const oracle = row.behaviorOracle;
    assert.ok(oracle?.fixture, `${row.id} fixture`);
    assert.ok(Array.isArray(oracle.stimulus) && oracle.stimulus.length >= 3, `${row.id} stimulus`);
    assert.ok(
      oracle.expectedState && typeof oracle.expectedState === 'object',
      `${row.id} expectedState`,
    );
    assert.ok(
      oracle.redactedEvidence && typeof oracle.redactedEvidence === 'object',
      `${row.id} redactedEvidence`,
    );
    const redacted = JSON.stringify(oracle.redactedEvidence);
    for (const forbidden of oracle.forbiddenEvidence || [])
      assert.equal(redacted.includes(forbidden), false, `${row.id} leaked ${forbidden}`);
  }

  assert.deepEqual(byId('redirect-chain-set-cookie').behaviorOracle.expectedState.sameSiteClasses, [
    'Lax',
    'None',
  ]);
  assert.equal(
    byId('document-cookie-network-cookie').behaviorOracle.expectedState.httpOnlyHiddenFromDocument,
    true,
  );
  assert.deepEqual(
    byId('samesite-lax-strict-none').behaviorOracle.expectedState.allowedNamesByContext
      .crossSiteSubresource,
    ['noneCookie'],
  );
  assert.deepEqual(
    byId('iframe-cookie-visibility').behaviorOracle.expectedState.srcdocFrameCookieNames,
    [],
  );
  assert.equal(
    byId('storage-sharing-reload-popup-frame').behaviorOracle.expectedState
      .crossTargetPopupSeesLocalStorage,
    false,
  );
  assert.deepEqual(byId('cookie-failure-telemetry').behaviorOracle.expectedState.failureBuckets, [
    'bad-samesite',
    'insecure-none',
    'oversize',
    'domain-mismatch',
  ]);
});
