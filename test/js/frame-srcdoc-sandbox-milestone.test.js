const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const matrix = () =>
  JSON.parse(fs.readFileSync('test/fixtures/frame-srcdoc-sandbox-milestone.json', 'utf8'));
const deltas = () => JSON.parse(fs.readFileSync('test/e2e/expected-deltas.json', 'utf8'));
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

test('frame sandbox masking is target-visible but removes only escapable native sandbox', () => {
  const text = source();
  for (const needle of [
    'frameSandboxAllowsEscape',
    "tokens.has('allow-scripts') && tokens.has('allow-same-origin')",
    'frameSandboxMeta.set(el, value)',
    "Native.removeAttribute.call(el, 'sandbox')",
    'frameSandboxValue(this)',
    'hasFrameSandboxValue(this)',
    'getAttributeNamesHook',
  ])
    assert.ok(text.includes(needle), `missing sandbox evidence: ${needle}`);
});

test('unsupported frame schemes are blocked or explicitly classified', () => {
  const text = source();
  for (const needle of [
    'hasFrameBlockedURLScheme',
    'javascript|data|blob|vbscript',
    "blockExecutableURL(this, 'src', v)",
  ])
    assert.ok(text.includes(needle), `missing frame scheme evidence: ${needle}`);

  const allowlist = deltas().nativeVsZeroProxyRawSetDifferentialAllowlist;
  assert.ok(
    allowlist.some(
      (row) =>
        row.id === 'unsupported-frame-scheme-limit' && row.pattern.includes('data|blob|javascript'),
    ),
    'unsupported frame scheme expected delta missing',
  );
});
