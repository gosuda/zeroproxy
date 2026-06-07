const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const gates = () => JSON.parse(fs.readFileSync('test/fixtures/performance-gates.json', 'utf8'));

test('performance gates declare every planned budget surface', () => {
  const g = gates();
  for (const key of [
    'htmlTransform',
    'runtimeBootstrap',
    'rustRewriterInit',
    'rewriteScript',
    'dynamicFunctionBody',
    'representativeSiteLoad',
  ])
    assert.ok(g[key], key);
});

test('performance gates are tied to existing measured paths', () => {
  const g = gates();
  const tests = fs.readFileSync('test/js/rewriter.test.js', 'utf8');
  const corpus = fs.readFileSync('scripts/compat-corpus.mjs', 'utf8');
  assert.ok(tests.includes('assertWithinBudget'));
  assert.ok(tests.includes(String(g.runtimeBootstrap.maxBytes)));
  assert.ok(tests.includes(String(g.dynamicFunctionBody.maxMs)));
  assert.ok(corpus.includes('transportTimings'));
  assert.equal(g.htmlTransform.firstByteMs, null);
  assert.equal(g.htmlTransform.status, 'documented-non-streaming');
});
