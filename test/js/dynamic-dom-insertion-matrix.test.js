const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const runtime = () => fs.readFileSync('web/runtime-prelude.mjs', 'utf8');
const matrix = () =>
  JSON.parse(fs.readFileSync('test/fixtures/dynamic-dom-insertion-matrix.json', 'utf8'));

test('dynamic DOM insertion matrix prioritizes every planned fixture family', () => {
  const rows = matrix();
  const ids = new Set(rows.map((row) => row.id));
  for (const id of [
    'inner-html-url-script-frame',
    'document-write-script-base',
    'programmatic-script-insertion',
    'template-content-later-insertion',
    'contextual-fragment',
    'domparser-html-document',
    'hydration-dynamic-chunk',
    'dynamic-srcdoc-frame',
  ]) {
    assert.equal(ids.has(id), true, id);
  }
  assert.ok(
    rows.filter((row) => row.priority === 'p0').length >= 4,
    'high-risk dynamic insertion rows must be p0',
  );
});

test('dynamic DOM insertion matrix rows stay wired to runtime hooks', () => {
  const source = runtime();
  for (const row of matrix()) {
    assert.ok(Array.isArray(row.probes) && row.probes.length > 0, `${row.id} probes`);
    assert.ok(row.expectedDelta, `${row.id} expected delta`);
    for (const needle of row.existingHookNeedles) {
      assert.ok(source.includes(needle), `${row.id} missing ${needle}`);
    }
  }
});
