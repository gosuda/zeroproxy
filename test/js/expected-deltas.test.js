const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const deltas = () => JSON.parse(fs.readFileSync('test/e2e/expected-deltas.json', 'utf8'));

test('expected delta allowlist covers frame, srcdoc, data/blob, and wrapper artifacts', () => {
  const ids = new Set(deltas().nativeVsZeroProxyRawSetDifferentialAllowlist.map((row) => row.id));
  for (const id of [
    'frame-srcdoc-runtime-gap',
    'frame-sandbox-security-delta',
    'data-blob-worker-frame-limit',
    'target-visible-wrapper-artifact',
  ])
    assert.equal(ids.has(id), true, id);
});

test('expected delta allowlist entries are classified and bounded', () => {
  for (const row of deltas().nativeVsZeroProxyRawSetDifferentialAllowlist) {
    assert.ok(row.id && row.pattern && row.reason, row.id || 'missing-id');
    assert.ok(row.pattern.startsWith('^'), `${row.id} pattern must be anchored`);
    assert.equal(
      /secret|cookie|password/i.test(row.reason),
      false,
      `${row.id} reason must stay redacted`,
    );
  }
});
