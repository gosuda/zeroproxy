const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const gates = () => JSON.parse(fs.readFileSync('test/fixtures/performance-gates.json', 'utf8'));

test('performance gates declare every planned budget surface', () => {
  const g = gates();
  for (const key of [
    'htmlSanitizer',
    'runtimeBootstrap',
    'quickjsRuntimeInit',
    'quickjsScriptEval',
    'representativeSiteLoad',
  ])
    assert.ok(g[key], key);
});

test('performance gates are tied to existing measured paths', () => {
  const g = gates();
  const quickjs = fs.readFileSync('test/js/quickjs-runtime.test.js', 'utf8');
  const corpus = fs.readFileSync('scripts/compat-corpus.mjs', 'utf8');
  assert.ok(quickjs.includes('QuickJS'));
  assert.ok(quickjs.includes('evalClassic'));
  assert.equal(g.quickjsRuntimeInit.maxMs, 1000);
  assert.ok(corpus.includes('transportTimings'));
  assert.equal(g.htmlSanitizer.firstByteMs, null);
  assert.equal(g.htmlSanitizer.status, 'documented-non-streaming');
});
