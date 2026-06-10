const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const matrix = () =>
  JSON.parse(fs.readFileSync('test/fixtures/rewrite-surface-long-tail.json', 'utf8'));
const source = () =>
  [
    fs.readFileSync('web/runtime-prelude.mjs', 'utf8'),
    fs.readFileSync('web/runtime/webapi/core.mjs', 'utf8'),
    fs.readFileSync('web/runtime/facades/fingerprinting.mjs', 'utf8'),
    fs.readFileSync('web/runtime/facades/document.mjs', 'utf8'),
    fs.readFileSync('web/runtime/facades/storage.mjs', 'utf8'),
    fs.readFileSync('scripts/compat-corpus.mjs', 'utf8'),
    fs.readFileSync('test/e2e/representative-sites.json', 'utf8'),
    fs.readFileSync('docs/masking-surfaces.md', 'utf8'),
  ]
    .join('\n')
    .toLowerCase();

test('rewrite-surface long tail has classified rows', () => {
  for (const row of matrix()) {
    assert.ok(row.id && row.surface && row.status, row.id || 'missing-id');
    assert.ok(row.priority === 'p0' || row.priority === 'p1', row.id);
  }
});

test('rewrite-surface long tail rows stay tied to source or docs', () => {
  const text = source();
  for (const row of matrix()) {
    for (const needle of row.needles)
      assert.ok(text.includes(String(needle).toLowerCase()), `${row.id} missing ${needle}`);
  }
});
