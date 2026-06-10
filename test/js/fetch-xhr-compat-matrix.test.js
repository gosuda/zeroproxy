const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const sources = () =>
  [
    fs.readFileSync('web/runtime/network/api.mjs', 'utf8'),
    fs.readFileSync('web/runtime/network/http.mjs', 'utf8'),
    fs.readFileSync('web/runtime-prelude.mjs', 'utf8'),
    fs.readFileSync('web/runtime/facades/fingerprinting.mjs', 'utf8'),
    fs.readFileSync('internal/zphttp/roundtrip.go', 'utf8'),
    fs.readFileSync('test/js/compat-pipeline.test.js', 'utf8'),
    fs.readFileSync('test/js/static-policy.test.js', 'utf8'),
  ].join('\n');
const matrix = () =>
  JSON.parse(fs.readFileSync('test/fixtures/fetch-xhr-compat-matrix.json', 'utf8'));

const byId = (id) => matrix().find((row) => row.id === id);

test('fetch/XHR compatibility matrix covers planned axes', () => {
  const ids = new Set(matrix().map((row) => row.id));
  for (const id of [
    'fetch-mode-credentials',
    'fetch-redirect-referrer',
    'fetch-no-cors-opaque',
    'fetch-abort-upload-stream',
    'xhr-sync-async',
    'xhr-headers-errors-progress',
    'range-and-cache-headers',
  ])
    assert.equal(ids.has(id), true, id);
});

test('fetch/XHR compatibility matrix rows stay wired to implementation surfaces', () => {
  const source = sources();
  for (const row of matrix()) {
    assert.ok(row.axes.length > 0, `${row.id} axes`);
    assert.ok(row.probes.length > 0, `${row.id} probes`);
    for (const needle of row.existingNeedles)
      assert.ok(source.includes(needle), `${row.id} missing ${needle}`);
  }
});

test('fetch/XHR compatibility matrix records concrete request cases and failure classes', () => {
  for (const row of matrix()) {
    const oracle = row.behaviorOracle;
    assert.ok(oracle?.fixture, `${row.id} fixture`);
    assert.ok(Array.isArray(oracle.requests) && oracle.requests.length >= 3, `${row.id} requests`);
    assert.ok(
      Array.isArray(oracle.expectedResponses) && oracle.expectedResponses.length >= 2,
      `${row.id} expectedResponses`,
    );
    assert.deepEqual(row.failureClasses, oracle.failureClasses, `${row.id} failureClasses`);
    assert.equal(row.telemetrySurface, 'network-api', `${row.id} telemetrySurface`);
  }

  assert.equal(
    byId('fetch-redirect-referrer').behaviorOracle.requests.some(
      (request) => request.redirect === 'manual' && request.expected === 'opaqueredirect',
    ),
    true,
  );
  assert.equal(
    byId('fetch-no-cors-opaque').behaviorOracle.requests.some(
      (request) => request.mode === 'no-cors' && request.expectedType === 'opaque',
    ),
    true,
  );
  assert.deepEqual(
    byId('xhr-sync-async').behaviorOracle.requests[0].expectedReadyStates,
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    byId('xhr-headers-errors-progress').behaviorOracle.requests.find(
      (request) => request.case === 'timeout',
    ).expectedEventOrder,
    ['loadstart', 'timeout', 'loadend'],
  );
  assert.equal(
    byId('range-and-cache-headers').behaviorOracle.requests.some(
      (request) => request.expectedStatus === 206,
    ),
    true,
  );
});
