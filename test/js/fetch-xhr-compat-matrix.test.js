const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const sources = () =>
  [
    fs.readFileSync('web/runtime/network/http.mjs', 'utf8'),
    fs.readFileSync('web/runtime-prelude.mjs', 'utf8'),
    fs.readFileSync('web/runtime/facades/fingerprinting.mjs', 'utf8'),
    fs.readFileSync('web/sw.js', 'utf8'),
    fs.readFileSync('internal/zphttp/roundtrip.go', 'utf8'),
    fs.readFileSync('test/js/compat-pipeline.test.js', 'utf8'),
    fs.readFileSync('test/js/static-policy.test.js', 'utf8'),
  ].join('\n');
const matrix = () =>
  JSON.parse(fs.readFileSync('test/fixtures/fetch-xhr-compat-matrix.json', 'utf8'));

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
