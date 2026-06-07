const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const runtime = () => fs.readFileSync('web/runtime-prelude.mjs', 'utf8');
const inventory = () =>
  JSON.parse(fs.readFileSync('test/fixtures/dom-mutation-inventory.json', 'utf8'));

test('DOM mutation inventory covers every planned API family', () => {
  const rows = inventory();
  const families = new Set(rows.map((row) => row.family));
  for (const family of [
    'create',
    'insert-replace-existing-node',
    'html-string-sinks',
    'document-write-and-fragment-parse',
    'attribute-mutation',
    'template-content',
    'frame-source-properties',
    'clone-import-adopt',
    'script-content-mutation',
    'serialize',
    'remove',
  ]) {
    assert.equal(families.has(family), true, family);
  }
  for (const row of rows) {
    assert.ok(row.status, `${row.family} status`);
    assert.ok(Array.isArray(row.apis) && row.apis.length > 0, `${row.family} apis`);
    assert.ok(row.coverage, `${row.family} coverage`);
  }
});

test('DOM mutation inventory hooked rows stay wired to runtime source', () => {
  const source = runtime();
  for (const row of inventory()) {
    if (!['hooked', 'partial'].includes(row.status)) continue;
    assert.ok(row.sourceNeedles.length > 0, `${row.family} source needles`);
    for (const needle of row.sourceNeedles) {
      assert.ok(source.includes(needle), `${row.family} missing ${needle}`);
    }
  }
});

test('DOM mutation inventory pins parser, script, template, and selector-adjacent mutation risks', () => {
  const rows = new Map(inventory().map((row) => [row.family, row]));
  assert.equal(rows.get('document-write-and-fragment-parse').status, 'hooked');
  assert.ok(
    rows
      .get('document-write-and-fragment-parse')
      .sourceNeedles.includes("define(w.DOMParser.prototype, 'parseFromString'"),
  );
  assert.ok(
    rows
      .get('document-write-and-fragment-parse')
      .sourceNeedles.includes("define(w.Range.prototype, 'createContextualFragment'"),
  );
  assert.equal(rows.get('template-content').status, 'hooked');
  assert.ok(rows.get('clone-import-adopt').coverage.includes('insertion'));
  assert.equal(rows.get('script-content-mutation').status, 'hooked');
  assert.ok(
    rows.get('script-content-mutation').sourceNeedles.includes('installScriptTextProps(w)'),
  );
});
