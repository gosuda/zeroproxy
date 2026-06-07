const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

async function corpusModule() {
  return import(path.resolve(__dirname, '../../scripts/compat-corpus.mjs'));
}

test('representative site corpus is checked in with required seed sites', async () => {
  const { loadCorpus } = await corpusModule();
  const corpus = loadCorpus();
  const ids = new Set(corpus.map((entry) => entry.id));
  for (const id of [
    'naver-desktop',
    'naver-mobile',
    'google-search',
    'google-maps',
    'embedded-google-maps',
    'wikipedia',
    'github',
    'hacker-news',
    'reddit',
    'x-com',
    'amazon',
    'nytimes',
    'cloudflare',
    'ipleak',
  ]) {
    assert.equal(ids.has(id), true, id);
  }
  assert.equal(
    corpus.every((entry) => entry.primaryFlow && entry.profile),
    true,
  );
});

test('representative corpus redacts raw URLs, IPs, and tokens from fingerprints', async () => {
  const { redactText, fingerprintText } = await corpusModule();
  const site = { site: 'ipleak.net', url: 'https://ipleak.net' };
  const raw =
    'GET https://secret.example/path?token=abcdefghijklmnopqrstuvwxyz123456 bearer abcdefghijklmnopqrstuvwxyz123456 from 203.0.113.44 failed';
  const redacted = redactText(raw, site);
  assert.equal(redacted.includes('secret.example'), false);
  assert.equal(redacted.includes('abcdefghijklmnopqrstuvwxyz123456'), false);
  assert.equal(redacted.includes('203.0.113.44'), false);
  assert.match(redacted, /<url:https:third-party>/);
  assert.match(redacted, /<ipv4>/);
  assert.match(redacted, /<token>/);
  assert.match(fingerprintText(raw, site), /^[0-9a-f]{20}$/);
});

test('representative comparison records first failing surface and owner', async () => {
  const { compareSiteRecords } = await corpusModule();
  const base = {
    ok: true,
    urlClass: { scheme: 'https', hostClass: 'primary', pathClass: 'root' },
    lifecycle: { readyState: 'complete', elapsedMs: 100, navigation: { duration: 90 } },
    console: [],
    pageErrors: [],
    requestFailures: [],
    responses: [],
    selectors: [{ selector: 'main', count: 1, visible: true }],
    rendering: {
      titleLength: 5,
      visibleTextLength: 1000,
      body: { width: 100, height: 100 },
      screenshot: { sha256: 'a', byteBucket: '<64KiB' },
    },
    iframes: {
      count: 0,
      visibleCount: 0,
      nonBlankCount: 0,
      adCandidateCount: 0,
      googleMapsCandidateCount: 0,
      entries: [],
    },
    resources: { count: 0, byInitiator: {}, byHostClass: {}, byDuration: {}, bySize: {} },
    transportTimings: [],
  };
  const proxy = {
    ...base,
    selectors: [{ selector: 'main', count: 0, visible: false }],
    rendering: {
      ...base.rendering,
      visibleTextLength: 10,
      screenshot: { sha256: 'b', byteBucket: '<64KiB' },
    },
  };
  const comparison = compareSiteRecords(base, proxy, {
    id: 'fixture',
    profile: 'desktop',
    primaryFlow: 'render',
  });
  assert.equal(comparison.firstFailingSurface, 'rendering');
  assert.equal(comparison.ownerModule, 'runtime/html-rewriter');
  assert.equal(comparison.status, 'triage');
  assert.deepEqual(comparison.delta.rendering.missingNativeVisibleSelectors, ['main']);
  assert.equal(comparison.failureTelemetry.schema, 'zp.failure.telemetry.v1');
  assert.equal(comparison.failureTelemetry.surface, 'rendering');
  assert.equal(comparison.failureTelemetry.redaction.rawURL, false);
  assert.deepEqual(comparison.failureTelemetry.evidence.missingVisibleSelectors, ['main']);
});
