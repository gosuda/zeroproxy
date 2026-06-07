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
    'template-clone-later-insertion',
    'selector-srcdoc-xlink-virtualization',
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

test('dynamic DOM insertion matrix pins high-risk behavior surfaces to concrete hooks', () => {
  const rows = new Map(matrix().map((row) => [row.id, row]));
  assert.deepEqual(rows.get('dynamic-srcdoc-frame').existingHookNeedles, [
    "installFrameProp(w.HTMLIFrameElement.prototype, 'srcdoc')",
    "setFrameSrcdocAttribute(this, 'srcdoc', v)",
    'createFrameMessaging',
  ]);
  assert.ok(rows.get('dynamic-srcdoc-frame').probes.includes('runtime prelude injection'));
  assert.ok(
    rows
      .get('template-clone-later-insertion')
      .probes.includes('cloned script descendants are prepared at insertion'),
  );
  assert.ok(
    rows
      .get('contextual-fragment')
      .existingHookNeedles.includes("define(w.Range.prototype, 'createContextualFragment'"),
  );
  assert.ok(
    rows
      .get('domparser-html-document')
      .existingHookNeedles.includes("String(type).toLowerCase() === 'text/html'"),
  );
  assert.ok(
    rows.get('programmatic-script-insertion').existingHookNeedles.includes('prepareScriptElement'),
  );
});

test('dynamic DOM insertion matrix covers target-visible selector virtualization for srcdoc and xlink:href', () => {
  const selectorRow = matrix().find((row) => row.id === 'selector-srcdoc-xlink-virtualization');
  assert.ok(selectorRow);
  assert.equal(selectorRow.priority, 'p0');
  assert.ok(
    selectorRow.probes.includes(
      'querySelectorAll matches iframe[srcdoc] against target-visible srcdoc',
    ),
  );
  assert.ok(
    selectorRow.probes.includes('matches/closest handle SVG xlink:href target-visible URLs'),
  );
  assert.ok(selectorRow.existingHookNeedles.includes("attr === 'srcdoc'"));
  assert.ok(selectorRow.existingHookNeedles.includes("attr === 'xlink:href'"));
});
