const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const matrix = () =>
  JSON.parse(fs.readFileSync('test/fixtures/event-listener-compat-matrix.json', 'utf8'));
const source = () =>
  [
    fs.readFileSync('web/runtime-prelude.mjs', 'utf8'),
    fs.readFileSync('web/runtime/facades/events.mjs', 'utf8'),
    fs.readFileSync('rewriter-rs/src/html/document.rs', 'utf8'),
    fs.readFileSync('test/js/membrane-invariants.test.js', 'utf8'),
  ].join('\n');

test('event-listener compatibility matrix covers planned listener surfaces', () => {
  const ids = new Set(matrix().map((row) => row.id));
  for (const id of [
    'add-remove-identity',
    'listener-options',
    'dispatch-propagation-order',
    'inline-and-onproperty',
    'message-event-wrapping',
    'internal-listener-invisibility',
  ])
    assert.equal(ids.has(id), true, id);
});

test('event-listener compatibility matrix rows stay wired', () => {
  const text = source();
  for (const row of matrix()) {
    assert.ok(row.apis.length > 0, `${row.id} apis`);
    assert.ok(row.probes.length > 0, `${row.id} probes`);
    for (const needle of row.existingNeedles)
      assert.ok(text.includes(needle), `${row.id} missing ${needle}`);
  }
});
