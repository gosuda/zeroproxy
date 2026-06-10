const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
  assert.equal(comparison.ownerModule, 'runtime/virtual-renderer');
  assert.equal(comparison.status, 'triage');
  assert.deepEqual(comparison.delta.rendering.missingNativeVisibleSelectors, ['main']);
  assert.equal(comparison.failureTelemetry.schema, 'zp.failure.telemetry.v1');
  assert.equal(comparison.failureTelemetry.surface, 'rendering');
  assert.equal(comparison.failureTelemetry.redaction.rawURL, false);
  assert.deepEqual(comparison.failureTelemetry.evidence.missingVisibleSelectors, ['main']);
  assert.equal(comparison.failureTelemetry.evidence.apiFailureClass, 'rendering');
});

test('representative comparison can classify expected corpus deltas', async () => {
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
    rootSurface: {},
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
    expectedDeltas: [
      {
        surface: 'rendering',
        classification: 'expected-compatibility-gap',
        reason: 'known fixture delta',
      },
    ],
  });
  assert.equal(comparison.status, 'expected-delta');
  assert.equal(comparison.expectedDelta.classification, 'expected-compatibility-gap');
  assert.equal(comparison.failureTelemetry.severity, 'expected-delta');
  assert.deepEqual(comparison.failureTelemetry.evidence.expectedDelta, {
    classification: 'expected-compatibility-gap',
    reason: 'known fixture delta',
  });
});

test('representative comparison does not fail sparse pages on text floor alone', async () => {
  const { compareSiteRecords } = await corpusModule();
  const native = releaseFixtureRecord({
    id: 'sparse-native',
    site: 'sparse.example',
    profile: 'desktop',
    primaryFlow: 'map-shell',
    primarySelectors: ['input[aria-label]', '[role=application]'],
  });
  native.selectors = native.selectors.map((row) => ({ ...row, count: 1, visible: true }));
  native.rendering = { ...native.rendering, visibleTextLength: 5 };
  const zeroProxy = {
    ...native,
    selectors: native.selectors.map((row) => ({ ...row, count: 1, visible: true })),
    rendering: {
      ...native.rendering,
      visibleTextLength: 5,
      screenshot: { sha256: 'different', byteBucket: '<64KiB' },
    },
  };
  const comparison = compareSiteRecords(native, zeroProxy, {
    id: 'sparse-native',
    profile: 'desktop',
    primaryFlow: 'map-shell',
  });
  assert.equal(comparison.status, 'pass');
});

test('representative comparison skips text-ratio failure without a visible native anchor', async () => {
  const { compareSiteRecords } = await corpusModule();
  const native = releaseFixtureRecord({
    id: 'hidden-native-shell',
    site: 'hidden.example',
    profile: 'desktop',
    primaryFlow: 'landing',
    primarySelectors: ['body', 'main, [role=main]'],
  });
  native.selectors = native.selectors.map((row) => ({
    ...row,
    count: row.selector === 'body' ? 1 : 0,
    visible: row.selector === 'body',
  }));
  native.rendering = { ...native.rendering, visibleTextLength: 1000 };
  const zeroProxy = {
    ...native,
    rendering: {
      ...native.rendering,
      visibleTextLength: 20,
      screenshot: { sha256: 'different', byteBucket: '<64KiB' },
    },
  };
  const comparison = compareSiteRecords(native, zeroProxy, {
    id: 'hidden-native-shell',
    profile: 'desktop',
    primaryFlow: 'landing',
  });
  assert.equal(comparison.status, 'pass');
});

test('representative comparison ignores native-only request failures', async () => {
  const { compareSiteRecords } = await corpusModule();
  const native = releaseFixtureRecord({
    id: 'native-only-failure',
    site: 'nativefail.example',
    profile: 'desktop',
    primaryFlow: 'news',
    primarySelectors: ['main'],
  });
  native.requestFailures = [
    {
      resourceType: 'script',
      urlClass: { scheme: 'https', hostClass: 'third-party', pathClass: 'path' },
      failureClass: 'net::ERR_ABORTED',
    },
  ];
  const zeroProxy = { ...native, requestFailures: [] };
  const comparison = compareSiteRecords(native, zeroProxy, {
    id: 'native-only-failure',
    profile: 'desktop',
    primaryFlow: 'news',
  });
  assert.equal(comparison.status, 'pass');
  assert.deepEqual(comparison.failureTelemetry.evidence.requestFailureDeltaKeys, []);
});

test('representative comparison records script release-gate counters', async () => {
  const { compareSiteRecords } = await corpusModule();
  const base = {
    ok: true,
    urlClass: { scheme: 'https', hostClass: 'primary', pathClass: 'root' },
    lifecycle: { readyState: 'complete', elapsedMs: 100, navigation: { duration: 90 } },
    console: [],
    pageErrors: [],
    requestFailures: [],
    responses: [],
    selectors: [],
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
    rootSurface: {},
  };
  const proxy = {
    ...base,
    pageErrors: [{ name: 'SyntaxError', fingerprint: 'redacted-syntax' }],
  };
  const comparison = compareSiteRecords(base, proxy, {
    id: 'fixture',
    profile: 'desktop',
    primaryFlow: 'script',
  });
  assert.equal(comparison.firstFailingSurface, 'script-runtime');
  assert.equal(comparison.failureTelemetry.evidence.script.rewriteInducedFailureCount, 1);
  assert.equal(comparison.failureTelemetry.evidence.script.generatedJavaScriptSyntaxErrorCount, 1);
  assert.deepEqual(comparison.failureTelemetry.evidence.script.pageErrorNames, { SyntaxError: 1 });
});

test('representative release gate summarizes checked-in corpus proof', async () => {
  const { buildReleaseGateReport, compareSiteRecords } = await corpusModule();
  const native = {
    ok: true,
    urlClass: { scheme: 'https', hostClass: 'primary', pathClass: 'root' },
    lifecycle: { readyState: 'complete', elapsedMs: 100, navigation: { duration: 90 } },
    console: [],
    pageErrors: [],
    requestFailures: [],
    responses: [],
    selectors: [],
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
    rootSurface: {},
  };
  const passing = compareSiteRecords(native, native, {
    id: 'pass-site',
    profile: 'desktop',
    primaryFlow: 'load',
  });
  const failing = compareSiteRecords(
    native,
    { ...native, pageErrors: [{ name: 'SyntaxError' }] },
    {
      id: 'script-site',
      profile: 'desktop',
      primaryFlow: 'load',
    },
  );
  const gate = buildReleaseGateReport(
    [{ id: 'pass-site' }, { id: 'script-site' }],
    [
      { site: 'pass-site', comparison: passing },
      { site: 'script-site', comparison: failing },
    ],
  );
  assert.equal(gate.schema, 'zp.compat.release-gate.v1');
  assert.equal(gate.status, 'triage');
  assert.equal(gate.metrics.comparedSites, 2);
  assert.equal(gate.metrics.triageSites, 1);
  assert.equal(gate.metrics.scriptRewriteInducedFailures, 1);
  assert.equal(gate.metrics.generatedJavaScriptSyntaxErrors, 1);
  assert.equal(gate.gates.noGeneratedJavaScriptSyntaxErrors, false);
  assert.deepEqual(gate.triageSites, [
    {
      site: 'script-site',
      firstFailingSurface: 'script-runtime',
      ownerModule: 'runtime/quickjs',
    },
  ]);
  assert.equal(gate.redaction.rawSourceBodies, false);
});

test('representative release gate excludes expected corpus deltas from triage counters', async () => {
  const { buildReleaseGateReport, compareSiteRecords } = await corpusModule();
  const native = {
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
    rootSurface: {},
  };
  const expected = compareSiteRecords(
    native,
    {
      ...native,
      selectors: [{ selector: 'main', count: 0, visible: false }],
      rendering: {
        ...native.rendering,
        visibleTextLength: 10,
        screenshot: { sha256: 'b', byteBucket: '<64KiB' },
      },
      pageErrors: [{ name: 'SyntaxError' }],
    },
    {
      id: 'expected-site',
      profile: 'desktop',
      primaryFlow: 'load',
      expectedDeltas: [
        {
          surface: 'rendering',
          classification: 'expected-compatibility-gap',
          reason: 'known site delta',
        },
      ],
    },
  );
  const gate = buildReleaseGateReport(
    [{ id: 'expected-site' }],
    [{ site: 'expected-site', comparison: expected }],
  );
  assert.equal(gate.status, 'pass');
  assert.equal(gate.metrics.expectedDeltaSites, 1);
  assert.equal(gate.metrics.triageSites, 0);
  assert.equal(gate.metrics.generatedJavaScriptSyntaxErrors, 0);
  assert.deepEqual(gate.expectedDeltaSites, [
    {
      site: 'expected-site',
      firstFailingSurface: 'rendering',
      ownerModule: 'runtime/virtual-renderer',
      reason: 'known site delta',
      classification: 'expected-compatibility-gap',
    },
  ]);
});

test('checked-in release artifact records redacted corpus gate state', async () => {
  const { loadCorpus, releaseGateSeedSemantics } = await corpusModule();
  const corpus = loadCorpus();
  const artifactPath = path.resolve(__dirname, '../e2e/representative-sites.release.json');
  const artifactText = fs.readFileSync(artifactPath, 'utf8');
  const artifact = JSON.parse(artifactText);

  assert.equal(artifact.schema, 'zp.compat.release-gate.v1');
  assert.equal(artifact.corpusVersion.length, 20);
  assert.equal(artifact.metrics.siteCount, corpus.length);
  assert.equal(artifact.metrics.comparedSites, corpus.length);
  assert.equal(artifact.metrics.missingComparisons, 0);
  assert.equal(artifact.gates.allSitesCompared, true);
  assert.equal(artifact.status, Object.values(artifact.gates).every(Boolean) ? 'pass' : 'triage');
  assert.equal(
    artifact.metrics.passSites +
      (artifact.metrics.expectedDeltaSites || 0) +
      artifact.metrics.triageSites,
    artifact.metrics.comparedSites,
  );
  if (artifact.status === 'triage') {
    assert.equal(artifact.triageSites.length, artifact.metrics.triageSites);
    for (const site of artifact.triageSites) {
      assert.ok(site.site);
      assert.ok(site.firstFailingSurface);
      assert.ok(site.ownerModule);
    }
  }
  if (artifact.metrics.expectedDeltaSites) {
    assert.equal(artifact.expectedDeltaSites.length, artifact.metrics.expectedDeltaSites);
    for (const site of artifact.expectedDeltaSites) {
      assert.ok(site.site);
      assert.ok(site.firstFailingSurface);
      assert.ok(site.ownerModule);
      assert.ok(site.classification);
    }
  }
  assert.deepEqual(artifact.seedCorpus, releaseGateSeedSemantics(corpus));
  assert.equal(artifact.redaction.rawUrls, false);
  assert.equal(artifact.redaction.rawConsoleText, false);
  assert.equal(artifact.redaction.rawIpDnsValues, false);
  assert.equal(artifact.redaction.rawSourceBodies, false);
  assert.equal(artifactText.includes('https://'), false);
  assert.equal(artifactText.includes('www.google.com/search?q='), false);
  assert.equal(artifactText.includes('203.0.113.'), false);
});

function releaseFixtureRecord(site) {
  const iframeExpectations = site.iframeExpectations || {};
  const renderExpectations = site.renderExpectations || {};
  const frameCount =
    iframeExpectations.adCandidates || iframeExpectations.nonBlank || iframeExpectations.googleMaps
      ? 1
      : 0;
  return {
    ok: true,
    urlClass: {
      scheme: site.fixture ? 'http' : 'https',
      hostClass: site.fixture ? 'local-fixture' : 'primary',
      pathClass: 'root',
    },
    lifecycle: { readyState: 'complete', elapsedMs: 100, navigation: { duration: 90 } },
    console: [],
    pageErrors: [],
    requestFailures: [],
    responses: [],
    selectors: site.primarySelectors.map((selector) => ({ selector, count: 1, visible: true })),
    rendering: {
      titleLength: 32,
      visibleTextLength: renderExpectations.nonBlankMap ? 2048 : 1024,
      body: { width: 1024, height: 768 },
      screenshot: { sha256: `fixture-${site.id}`, byteBucket: '<64KiB' },
    },
    iframes: {
      count: frameCount,
      visibleCount: frameCount,
      nonBlankCount: iframeExpectations.nonBlank || iframeExpectations.googleMaps ? 1 : 0,
      adCandidateCount: iframeExpectations.adCandidates ? 1 : 0,
      googleMapsCandidateCount: iframeExpectations.googleMaps ? 1 : 0,
      entries: [],
    },
    resources: { count: 0, byInitiator: {}, byHostClass: {}, byDuration: {}, bySize: {} },
    transportTimings: [],
    rootSurface: {},
  };
}

test('representative comparison classifies bounded root-surface deltas', async () => {
  const { compareSiteRecords } = await corpusModule();
  const base = {
    ok: true,
    urlClass: { scheme: 'https', hostClass: 'primary', pathClass: 'root' },
    lifecycle: { readyState: 'complete', elapsedMs: 100, navigation: { duration: 90 } },
    console: [],
    pageErrors: [],
    requestFailures: [],
    responses: [],
    selectors: [],
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
    rootSurface: {
      ownKeyCount: 10,
      ownNameCount: 10,
      ownSymbolCount: 0,
      toStringTag: 'Window',
      selectedDescriptors: {
        location: { constructorName: 'Location' },
        fetch: { constructorName: 'Function' },
      },
      selectedGraph: { fetch: { ownNameCount: 2 } },
    },
  };
  const proxy = {
    ...base,
    rootSurface: {
      ownKeyCount: 9,
      ownNameCount: 10,
      ownSymbolCount: 0,
      toStringTag: 'Window',
      selectedDescriptors: {
        location: { constructorName: 'Object' },
        fetch: { constructorName: 'Function' },
      },
      selectedGraph: { fetch: { ownNameCount: 3 } },
    },
  };
  const comparison = compareSiteRecords(base, proxy, {
    id: 'root-surface',
    profile: 'desktop',
    primaryFlow: 'inspect',
  });
  assert.equal(comparison.delta.rootSurface.mismatchCount, 3);
  assert.deepEqual(comparison.delta.rootSurface.classes, {
    'native-browser-version-delta': 1,
    'security-delta': 1,
    'compatibility-gap': 1,
  });
  assert.deepEqual(comparison.failureTelemetry.evidence.rootSurface.samplePaths, [
    'ownKeyCount',
    'selectedDescriptors.location',
    'selectedGraph.fetch',
  ]);
});
