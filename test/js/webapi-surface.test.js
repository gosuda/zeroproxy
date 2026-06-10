const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/webapi', name), 'utf8'));

test('bridge surface manifest classifies every tracked Web API entry', () => {
  const manifest = fixture('bridge-surface.json');
  assert.equal(manifest.version, 1);
  const names = new Set();
  for (const entry of manifest.entries) {
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.category, 'string');
    assert.ok(
      ['implemented', 'partial', 'blocked-by-gap', 'blocked-by-policy', 'out-of-scope'].includes(
        entry.status,
      ),
      entry.name,
    );
    assert.ok(
      ['host-bridge', 'virtualized', 'direct-shim', 'blocked'].includes(
        entry.implementationStrategy,
      ),
      `missing implementation strategy: ${entry.name}`,
    );
    assert.equal(
      typeof entry.bridgeReplacementDecision,
      'string',
      `missing bridge replacement decision: ${entry.name}`,
    );
    assert.equal(names.has(entry.name), false, `duplicate surface entry ${entry.name}`);
    names.add(entry.name);
    if (entry.status === 'implemented')
      assert.ok(
        entry.source && entry.probes?.length,
        `implemented entry lacks source/probe: ${entry.name}`,
      );
    if (entry.status.startsWith('blocked') || entry.status === 'out-of-scope')
      assert.ok(entry.owner || entry.source, `blocked entry lacks owner/source: ${entry.name}`);
  }
  for (const required of [
    'fetch',
    'Request',
    'Response',
    'Headers',
    'XMLHttpRequest',
    'EventSource',
    'WebSocket',
    'Document',
    'Element',
    'EventTarget',
    'structuredClone',
    'crypto.getRandomValues',
    'navigator.serviceWorker',
  ]) {
    assert.ok(names.has(required), `missing ${required}`);
  }
});

test('webapi comparator fixtures expose actionable gaps and globalThis set diff', () => {
  const quickjs = fixture('quickjs-surface.json');
  const host = fixture('host-surface.json');
  const report = fixture('webapi-gap-report.json');
  assert.equal(quickjs.version, 2);
  assert.equal(host.version, 2);
  assert.equal(report.version, 2);
  assert.equal(report.summary.hiddenMissing, 0);
  assert.ok(report.summary.partial > 0, 'gap report should keep partial work visible');
  assert.ok(report.missingOrPartial.some((entry) => entry.name === 'IndexedDB'));
  assert.ok(report.blocked.some((entry) => entry.name === 'navigator.serviceWorker'));
  assert.ok(quickjs.quickjsGlobalThis.ownKeys.includes('String'));
  assert.ok(quickjs.quickjsGlobalThis.ownKeys.includes('BigInt'));
  assert.ok(quickjs.installedGlobalThis.ownKeys.includes('fetch'));
  assert.ok(quickjs.installedGlobalThis.ownKeys.includes('Document'));
  assert.ok(report.globalThisSetDiff.quickJSNative.includes('String'));
  assert.ok(report.globalThisSetDiff.quickJSNative.includes('BigInt'));
  assert.ok(report.globalThisSetDiff.browserOnly.includes('fetch'));
  assert.equal(report.installedGlobalThisSetDiff.browserOnly.includes('fetch'), false);
  assert.ok(
    report.summary.browserOnlyAfterInstallGlobalThisKeys < report.summary.browserOnlyGlobalThisKeys,
  );
  assert.deepEqual(report.installedGlobalThisSetDiff.browserOnly, ['Temporal', 'WebAssembly']);
  assert.ok(quickjs.installedGlobalThis.entryShapes.fetch.exists);
  assert.ok(host.entryShapes.fetch.exists);
  assert.ok(report.summary.shapeAuditedEntries > 0);
  assert.ok(report.summary.shapeMismatchEntries > 0);
  assert.equal(report.summary.implementedShapeMismatchEntries, 0);
  assert.deepEqual(report.implementedShapeDiffs, []);
  for (const name of [
    'atob',
    'btoa',
    'queueMicrotask',
    'requestIdleCallback',
    'IdleDeadline',
    'origin',
    'DOMPoint',
    'NodeList',
    'HTMLCollection',
    'WebKitCSSMatrix',
    'NamedNodeMap',
    'RadioNodeList',
    'EventCounts',
    'PerformanceMark',
    'DOMException',
    'PerformanceMeasure',
    'PerformanceNavigation',
    'PerformanceEntry',
    'PerformanceNavigationTiming',
    'PerformanceTiming',
    'DocumentFragment',
    'Text',
    'Comment',
    'Attr',
    'PerformanceTimingConfidence',
    'PerformanceServerTiming',
    'PerformanceObserverEntryList',
    'TreeWalker',
    'NodeIterator',
    'Touch',
    'TouchList',
    'Event',
    'MessageEvent',
    'CustomEvent',
    'UIEvent',
    'MouseEvent',
    'BeforeInstallPromptEvent',
    'KeyboardEvent',
    'WheelEvent',
    'FragmentDirective',
    'VisualViewport',
    'AbortSignal',
    'CloseEvent',
    'UserActivation',
    'NetworkInformation',
    'BarProp',
    'DOMError',
    'OverconstrainedError',
    'QuotaExceededError',
    'Screen',
    'TrustedTypePolicy',
    'MutationRecord',
    'CloseWatcher',
    'MediaError',
    'InputDeviceInfo',
    'ChapterInformation',
    'SpeechGrammar',
    'SpeechGrammarList',
    'CSSKeywordValue',
    'CSSUnitValue',
    'CSSPositionValue',
    'CSSVariableReferenceValue',
    'TextEncoder',
    'TextDecoder',
    'TextEncoderStream',
    'TextDecoderStream',
    'Blob',
    'FileList',
    'DataTransferItem',
    'LaunchParams',
    'AudioSinkInfo',
    'EncodedAudioChunk',
    'EncodedVideoChunk',
    'VideoColorSpace',
    'RTCIceCandidate',
    'RTCError',
    'RTCSessionDescription',
    'WebSocketError',
    'ImageData',
    'Plugin',
    'MimeType',
    'NavigatorUAData',
    'GeolocationPosition',
    'GeolocationCoordinates',
    'Permissions',
    'PermissionStatus',
    'StyleSheetList',
    'CSSRuleList',
    'PluginArray',
    'DOMStringList',
    'DOMTokenList',
    'MediaList',
    'MimeTypeArray',
    'fetch',
    'Headers',
    'Request',
    'Response',
    'XMLHttpRequest',
    'EventSource',
    'URLSearchParams',
    'URL',
    'webkitURL',
    'URLPattern',
    'BluetoothUUID',
  ]) {
    assert.equal(
      report.implementedShapeDiffs.some((entry) => entry.name === name),
      false,
      `${name} should match the descriptor-shape audit`,
    );
  }
  const markdown = fs.readFileSync(
    path.join(root, 'test/fixtures/webapi/webapi-gap-report.md'),
    'utf8',
  );
  assert.match(markdown, /Web API gap report/);
  assert.match(markdown, /globalThis Set diff/);
  assert.match(markdown, /Descriptor shape audit/);
  assert.match(markdown, /IndexedDB/);
});

test('webapi surface scripts regenerate committed fixture shape', () => {
  for (const command of [
    ['node', ['scripts/snapshot-quickjs-surface.mjs']],
    ['node', ['scripts/compare-webapi-surface.mjs']],
    ['node', ['scripts/probe-webapi-behavior.mjs']],
  ]) {
    const result = childProcess.spawnSync(command[0], command[1], { cwd: root, encoding: 'utf8' });
    assert.equal(
      result.status,
      0,
      `${command.flat().join(' ')} failed\n${result.stdout}\n${result.stderr}`,
    );
  }
  const probes = fixture('webapi-behavior-probes.json');
  assert.ok(probes.probes.some((probe) => probe.name === 'network-api'));
  assert.ok(probes.probes.some((probe) => probe.name === 'webapi-core'));
});
