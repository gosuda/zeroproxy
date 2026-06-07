const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const matrix = () =>
  JSON.parse(fs.readFileSync('test/fixtures/frame-srcdoc-sandbox-milestone.json', 'utf8'));
const source = () =>
  [
    fs.readFileSync('web/runtime-prelude.mjs', 'utf8'),
    fs.readFileSync('rewriter-rs/src/html/document.rs', 'utf8'),
    fs.readFileSync('web/runtime/frames/policy.mjs', 'utf8'),
    fs.readFileSync('web/runtime/frames/sandbox.mjs', 'utf8'),
    fs.readFileSync('scripts/compat-corpus.mjs', 'utf8'),
    fs.readFileSync('test/js/static-policy.test.js', 'utf8'),
  ].join('\n');

test('frame/srcdoc/sandbox milestone covers dedicated frame workstream rows', () => {
  const ids = new Set(matrix().map((row) => row.id));
  for (const id of [
    'ordinary-frame-routing',
    'dynamic-srcdoc-document-transform',
    'sandbox-token-deltas',
    'widget-login-payment-challenge',
    'srcdoc-static-html-transform',
  ])
    assert.equal(ids.has(id), true, id);
});

test('frame/srcdoc/sandbox milestone rows declare expected deltas and wiring', () => {
  const text = source();
  for (const row of matrix()) {
    assert.ok(row.expectedDelta, `${row.id} expectedDelta`);
    assert.ok(row.probes.length > 0, `${row.id} probes`);
    for (const needle of row.existingNeedles)
      assert.ok(text.includes(needle), `${row.id} missing ${needle}`);
  }
});
