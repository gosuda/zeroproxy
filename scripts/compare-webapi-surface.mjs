import fs from 'node:fs';
import { writeJSONFile } from './json-output.mjs';
import { compareEntryShapes } from './webapi-surface-shapes.mjs';

export function compareWebAPISurface({
  manifestPath = 'test/fixtures/webapi/bridge-surface.json',
  hostPath = 'test/fixtures/webapi/host-surface.json',
  quickjsPath = 'test/fixtures/webapi/quickjs-surface.json',
  reportPath = 'test/fixtures/webapi/webapi-gap-report.json',
  markdownPath = 'test/fixtures/webapi/webapi-gap-report.md',
} = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const host = JSON.parse(fs.readFileSync(hostPath, 'utf8'));
  const quickjs = JSON.parse(fs.readFileSync(quickjsPath, 'utf8'));
  const quickjsNames = new Set(quickjs.globals || []);
  const entries = manifest.entries || [];
  const hidden = entries.filter(
    (entry) => entry.status !== 'out-of-scope' && !quickjsNames.has(entry.name),
  );
  const missingOrPartial = entries.filter((entry) =>
    ['partial', 'blocked-by-gap'].includes(entry.status),
  );
  const blocked = entries.filter((entry) =>
    ['blocked-by-policy', 'out-of-scope'].includes(entry.status),
  );
  const globalThisSetDiff = compareGlobalThisSets(host, quickjs);
  const installedGlobalThisSetDiff = compareInstalledGlobalThisSets(host, quickjs);
  const hostEntryShapes = host.entryShapes || {};
  const installedEntryShapes =
    quickjs.installedGlobalThis?.entryShapes || quickjs.entryShapes || {};
  const shapeAuditedEntries = entries.filter((entry) => {
    const hostShape = hostEntryShapes[entry.name];
    const installedShape = installedEntryShapes[entry.name];
    return entry.status !== 'out-of-scope' && (hostShape?.exists || installedShape?.exists);
  }).length;
  const entryShapeDiffs = compareEntryShapes(entries, hostEntryShapes, installedEntryShapes);
  const implementedShapeDiffs = entryShapeDiffs.filter((entry) => entry.status === 'implemented');
  const report = {
    version: 2,
    summary: {
      entries: entries.length,
      implemented: entries.filter((entry) => entry.status === 'implemented').length,
      partial: entries.filter((entry) => entry.status === 'partial').length,
      blockedByGap: entries.filter((entry) => entry.status === 'blocked-by-gap').length,
      blockedByPolicy: entries.filter((entry) => entry.status === 'blocked-by-policy').length,
      outOfScope: entries.filter((entry) => entry.status === 'out-of-scope').length,
      hiddenMissing: hidden.length,
      hostBrowserGlobalThisKeys: globalThisSetDiff.counts.hostBrowser,
      quickJSGlobalThisKeys: globalThisSetDiff.counts.quickJS,
      browserOnlyGlobalThisKeys: globalThisSetDiff.counts.browserOnly,
      quickJSNativeGlobalThisKeys: globalThisSetDiff.counts.quickJSNative,
      quickJSOnlyGlobalThisKeys: globalThisSetDiff.counts.quickJSOnly,
      installedQuickJSGlobalThisKeys: installedGlobalThisSetDiff.counts.quickJS,
      browserOnlyAfterInstallGlobalThisKeys: installedGlobalThisSetDiff.counts.browserOnly,
      installedSharedGlobalThisKeys: installedGlobalThisSetDiff.counts.quickJSNative,
      installedQuickJSOnlyGlobalThisKeys: installedGlobalThisSetDiff.counts.quickJSOnly,
      shapeAuditedEntries,
      shapeMismatchEntries: entryShapeDiffs.length,
      implementedShapeMismatchEntries: implementedShapeDiffs.length,
    },
    globalThisSetDiff,
    installedGlobalThisSetDiff,
    hiddenMissing: hidden.map(summaryEntry),
    missingOrPartial: missingOrPartial.map(summaryEntry),
    blocked: blocked.map(summaryEntry),
    entryShapeDiffs,
    implementedShapeDiffs,
  };
  writeJSONFile(reportPath, report);
  fs.writeFileSync(markdownPath, renderMarkdown(report));
  return report;
}

function compareGlobalThisSets(host, quickjs) {
  const hostBrowser = normalizedOwnKeys(host.globalThis?.ownKeys || host.globals);
  const quickJS = normalizedOwnKeys(
    quickjs.quickjsGlobalThis?.ownKeys || quickjs.globalThis?.ownKeys || [],
  );
  const browserOnly = difference(hostBrowser, quickJS);
  const quickJSNative = intersection(hostBrowser, quickJS);
  const quickJSOnly = difference(quickJS, hostBrowser);
  return {
    hostBrowser,
    quickJS,
    browserOnly,
    quickJSNative,
    quickJSOnly,
    counts: {
      hostBrowser: hostBrowser.length,
      quickJS: quickJS.length,
      browserOnly: browserOnly.length,
      quickJSNative: quickJSNative.length,
      quickJSOnly: quickJSOnly.length,
    },
  };
}

function compareInstalledGlobalThisSets(host, quickjs) {
  const hostBrowser = normalizedOwnKeys(host.globalThis?.ownKeys || host.globals);
  const quickJS = normalizedOwnKeys(quickjs.installedGlobalThis?.ownKeys || quickjs.globals || []);
  const browserOnly = difference(hostBrowser, quickJS);
  const quickJSNative = intersection(hostBrowser, quickJS);
  const quickJSOnly = difference(quickJS, hostBrowser);
  return {
    hostBrowser,
    quickJS,
    browserOnly,
    quickJSNative,
    quickJSOnly,
    counts: {
      hostBrowser: hostBrowser.length,
      quickJS: quickJS.length,
      browserOnly: browserOnly.length,
      quickJSNative: quickJSNative.length,
      quickJSOnly: quickJSOnly.length,
    },
  };
}

function normalizedOwnKeys(keys = []) {
  return [...new Set(keys)].sort();
}

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((key) => !rightSet.has(key));
}

function intersection(left, right) {
  const rightSet = new Set(right);
  return left.filter((key) => rightSet.has(key));
}

function summaryEntry(entry) {
  return {
    name: entry.name,
    category: entry.category,
    status: entry.status,
    implementationStrategy: entry.implementationStrategy || 'direct-shim',
    bridgeReplacementDecision: entry.bridgeReplacementDecision || '',
    owner: entry.owner || '',
    expectedShapeDeltas: entry.expectedShapeDeltas || [],
    notes: entry.notes || '',
  };
}

function renderMarkdown(report) {
  const diff = report.globalThisSetDiff;
  const lines = [
    '# Web API gap report',
    '',
    `Entries: ${report.summary.entries}`,
    `Implemented: ${report.summary.implemented}`,
    `Partial: ${report.summary.partial}`,
    `Blocked by gap: ${report.summary.blockedByGap}`,
    `Blocked by policy: ${report.summary.blockedByPolicy}`,
    `Out of scope: ${report.summary.outOfScope}`,
    `Hidden missing: ${report.summary.hiddenMissing}`,
    '',
    '## globalThis Set diff',
    '',
    'The first diff is the pristine QuickJS-NG runtime before ZeroProxy installs DOM/WebAPI facades. It is a baseline engine delta, not the virtual browser exposure after `installWebAPICore()`.',
    '',
    `Host browser own keys: ${diff.counts.hostBrowser}`,
    `Pristine QuickJS-NG own keys: ${diff.counts.quickJS}`,
    `Browser-only before install: ${diff.counts.browserOnly}`,
    `Pristine QuickJS-native shared keys: ${diff.counts.quickJSNative}`,
    `Pristine QuickJS-only keys: ${diff.counts.quickJSOnly}`,
    '',
    '## Installed virtual globalThis Set diff',
    '',
    `Installed QuickJS virtual own keys: ${report.installedGlobalThisSetDiff.counts.quickJS}`,
    `Browser-only after install: ${report.installedGlobalThisSetDiff.counts.browserOnly}`,
    `Installed virtual shared keys: ${report.installedGlobalThisSetDiff.counts.quickJSNative}`,
    `Installed virtual QuickJS-only keys: ${report.installedGlobalThisSetDiff.counts.quickJSOnly}`,
    '',
    '### Browser-only globals',
    ...markdownList(diff.browserOnly),
    '',
    '### QuickJS-native shared globals',
    ...markdownList(diff.quickJSNative),
    '',
    '### QuickJS-only globals',
    ...markdownList(diff.quickJSOnly),
    '',
    '### Browser-only after install',
    ...markdownList(report.installedGlobalThisSetDiff.browserOnly),
    '',
    '### Installed virtual shared globals',
    ...markdownList(report.installedGlobalThisSetDiff.quickJSNative),
    '',
    '## Descriptor shape audit',
    '',
    `Shape-audited entries: ${report.summary.shapeAuditedEntries}`,
    `Entries with descriptor/prototype mismatches: ${report.summary.shapeMismatchEntries}`,
    `Implemented entries with descriptor/prototype mismatches: ${report.summary.implementedShapeMismatchEntries}`,
    '',
    '### Implemented shape mismatches',
    ...report.implementedShapeDiffs
      .slice(0, 80)
      .map(
        (entry) =>
          `- ${entry.name}: ${entry.mismatchCount} mismatch(es): ${entry.mismatches.join('; ')}`,
      ),
    '',
    '',
    '',
    '## Missing or partial',
    ...report.missingOrPartial.map(
      (entry) =>
        `- ${entry.name}: ${entry.status} [${entry.implementationStrategy}]${entry.notes ? ` — ${entry.notes}` : ''}${entry.bridgeReplacementDecision ? ` Decision: ${entry.bridgeReplacementDecision}` : ''}`,
    ),
    '',
    '## Blocked',
    ...report.blocked.map(
      (entry) =>
        `- ${entry.name}: ${entry.status} [${entry.implementationStrategy}]${entry.notes ? ` — ${entry.notes}` : ''}${entry.bridgeReplacementDecision ? ` Decision: ${entry.bridgeReplacementDecision}` : ''}`,
    ),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function markdownList(items) {
  if (!items.length) return ['- None'];
  return items.map((item) => `- \`${item}\``);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = compareWebAPISurface();
  if (report.summary.hiddenMissing) process.exitCode = 1;
  console.log(JSON.stringify(report.summary, null, 2));
}
