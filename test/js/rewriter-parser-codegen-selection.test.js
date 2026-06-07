const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const fixturePath = path.join(root, 'test/fixtures/rewriter-parser-codegen-selection.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('rewriter parser and codegen selection is checked in and source-backed', () => {
  assert.equal(fixture.schema, 'zp.rewriter.parser-codegen-selection.v1');
  assert.equal(fixture.javascript.parser, 'swc_ecma_parser');
  assert.equal(fixture.javascript.codegen, 'swc_ecma_codegen');
  assert.equal(fixture.javascript.resolver, 'swc_ecma_transforms_base::resolver');
  assert.ok(fixture.javascript.selectionReasons.length >= 3);

  const cargo = read('rewriter-rs/Cargo.toml');
  for (const dep of fixture.javascript.manifestDependencies) {
    assert.match(cargo, new RegExp(`^${dep} = `, 'm'), dep);
  }
  for (const dep of fixture.css.manifestDependencies) {
    assert.match(cargo, new RegExp(`^${dep} = `, 'm'), dep);
  }

  const jsRewriter = read('rewriter-rs/src/js/swc_rewriter.rs');
  for (const needle of fixture.javascript.sourceNeedles) {
    assert.ok(jsRewriter.includes(needle), needle);
  }

  const htmlRewriter = read('rewriter-rs/src/html/document.rs');
  for (const needle of fixture.html.sourceNeedles) {
    assert.ok(htmlRewriter.includes(needle), needle);
  }
});
