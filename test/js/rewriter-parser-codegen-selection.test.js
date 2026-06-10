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

test('target JavaScript AST/codegen rewriter is removed from active browser build', () => {
  assert.equal(fixture.schema, 'zp.rewriter.parser-codegen-selection.v2');
  assert.equal(fixture.javascript.status, 'removed-from-target-hot-path');
  assert.ok(fixture.javascript.selectionReasons.length >= 3);

  const activeSources = [
    'scripts/build.mjs',
    'web/runtime-prelude-entry.mjs',
    'web/runtime-prelude.mjs',
    'web/runtime/dynamic-code/facade.mjs',
    'cmd/wasm-kernel/main.go',
  ]
    .map(read)
    .join('\n');
  for (const needle of fixture.javascript.forbiddenSourceNeedles) {
    assert.equal(activeSources.includes(needle), false, `${needle} must not be active`);
  }

  const htmlSanitizer = read(fixture.html.source);
  for (const needle of fixture.html.sourceNeedles)
    assert.ok(htmlSanitizer.includes(needle), needle);

  const cssRewriter = read(fixture.css.source);
  for (const needle of fixture.css.sourceNeedles) assert.ok(cssRewriter.includes(needle), needle);
});
