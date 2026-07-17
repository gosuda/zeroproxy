import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalDigest,
  canonicalJson,
  collectBuildIdentity,
  GateFailure,
  invariant,
  loadAdapter,
  loadBrowserBoundaries,
  loadPerformanceConfig,
  moduleDirectory,
  parseArgs,
  productionCertification,
  readJson,
  releaseTuple,
  reportCommandSummary,
  runtimeIdentity,
  validateJsonSchema,
  verifyBrowserPin,
  verifyCanonicalThresholdSignature,
  withTemporaryDirectory,
  writeCanonicalReport,
} from "./common.mjs";
import { safeRelativePath, snapshotFixtureTree, startFixtureSnapshotServer, verifyRemoteFixtureOrigin } from "./fixture-snapshot.mjs";
export const REQUIRED_OFFLINE_CORPUS_CATEGORIES = Object.freeze([
  "react", "vue", "angular-zone", "vite-next-esm", "webpack", "jquery",
  "pwa", "frame", "media", "editor", "upload", "download",
]);
const REQUIRED_FRAMEWORK_PACKAGES = Object.freeze([
  "@angular/compiler", "@angular/core", "@angular/platform-browser", "esbuild", "jquery", "react",
  "react-dom", "rxjs", "tslib", "vue", "webpack", "zone.js",
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function validateProbeList(site, kind, probes) {
  invariant(Array.isArray(probes) && probes.length > 0, `corpus site ${site.id} requires ${kind}`);
  const probeIds = new Set();
  for (const probe of probes) {
    invariant(probe && nonEmptyString(probe.id) && nonEmptyString(probe.expression), `corpus site ${site.id} has invalid ${kind} probe`);
    invariant(!probeIds.has(probe.id), `corpus site ${site.id} has duplicate ${kind} probe ${probe.id}`);
    probeIds.add(probe.id);
  }
}

function validateCorpusSite(site, ids, config) {
  invariant(site && typeof site === "object", "corpus site must be an object");
  invariant(nonEmptyString(site.id), "corpus site id is required");
  invariant(/^[A-Za-z0-9_.-]+$/u.test(site.id), `corpus site ${site.id} id is not URL-safe`);
  invariant(!ids.has(site.id), `duplicate corpus site ${site.id}`);
  ids.add(site.id);
  invariant(nonEmptyString(site.url), `corpus site ${site.id} url is required`);
  invariant(site.kind === "offline-fixture" || site.kind === "live-canary", `corpus site ${site.id} kind is invalid`);
  if (site.kind === "offline-fixture") {
    invariant(REQUIRED_OFFLINE_CORPUS_CATEGORIES.includes(site.fixture_category), `corpus site ${site.id} fixture_category is invalid`);
    invariant(typeof site.fixture_sha256 === "string" && /^[a-f0-9]{64}$/u.test(site.fixture_sha256), `corpus site ${site.id} fixture_sha256 is required`);
    invariant(safeRelativePath(site.fixture_path), `corpus site ${site.id} fixture_path must be a safe relative path`);
    invariant(safeRelativePath(site.entry_path), `corpus site ${site.id} entry_path must be a safe relative path`);
    invariant(nonEmptyString(site.mediated_url_template) && site.mediated_url_template.split("{fixture_url_encoded}").length === 2, `corpus site ${site.id} mediated_url_template must contain exactly one fixture URL token`);
    invariant(site.native_url === null && site.mediated_url === null, `offline corpus site ${site.id} execution URLs are gate-owned`);
  } else {
    invariant(site.fixture_category === null && site.fixture_sha256 === null && site.fixture_path === null && site.entry_path === null && site.mediated_url_template === null, `live corpus site ${site.id} must not claim an offline fixture`);
    invariant(nonEmptyString(site.native_url) && /^https?:\/\//.test(site.native_url), `live corpus site ${site.id} native_url must be absolute HTTP(S)`);
    invariant(nonEmptyString(site.mediated_url) && /^https?:\/\//.test(site.mediated_url), `live corpus site ${site.id} mediated_url must be absolute HTTP(S)`);
  }
  validateProbeList(site, "actions", site.actions);
  validateProbeList(site, "compatibility_probes", site.compatibility_probes);
  validateProbeList(site, "stealth_probes", site.stealth_probes);
  invariant(Object.hasOwn(config.site_classes, site.site_class), `corpus site ${site.id} has unknown site class ${site.site_class}`);
}

function validateFrameworkInventory(inventory) {
  invariant(inventory && typeof inventory === "object" && !Array.isArray(inventory), "production corpus requires the checked framework fixture inventory", "corpus_incomplete");
  invariant(inventory.schema_version === 1 && Array.isArray(inventory.fixtures), "framework fixture inventory is invalid", "corpus_incomplete");
  invariant(Object.keys(inventory).length === 3 && Object.hasOwn(inventory, "toolchain"), "framework fixture inventory has an invalid top-level shape", "corpus_incomplete");
  const toolchain = inventory.toolchain;
  invariant(toolchain && typeof toolchain === "object" && !Array.isArray(toolchain)
    && Object.keys(toolchain).length === 2
    && typeof toolchain.node === "string"
    && /^[0-9]+\.[0-9]+\.[0-9]+$/u.test(toolchain.node)
    && toolchain.packages && typeof toolchain.packages === "object" && !Array.isArray(toolchain.packages),
  "framework fixture inventory toolchain is invalid", "corpus_incomplete");
  const packageNames = Object.keys(toolchain.packages);
  invariant(packageNames.length === REQUIRED_FRAMEWORK_PACKAGES.length
    && REQUIRED_FRAMEWORK_PACKAGES.every(name => /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(toolchain.packages[name])),
  "framework fixture inventory must pin every framework package to an exact version", "corpus_incomplete");
  const categories = inventory.fixtures.map(fixture => fixture.category);
  invariant(inventory.fixtures.length === REQUIRED_OFFLINE_CORPUS_CATEGORIES.length
    && new Set(categories).size === REQUIRED_OFFLINE_CORPUS_CATEGORIES.length
    && REQUIRED_OFFLINE_CORPUS_CATEGORIES.every(category => categories.includes(category)),
  "framework fixture inventory must contain exactly one fixture for every required offline category", "corpus_incomplete");
  for (const fixture of inventory.fixtures) {
    invariant(fixture && typeof fixture === "object" && !Array.isArray(fixture)
      && Object.keys(fixture).length === 6
      && safeRelativePath(fixture.path)
      && safeRelativePath(fixture.entry_path)
      && typeof fixture.tree_sha256 === "string" && /^[a-f0-9]{64}$/u.test(fixture.tree_sha256)
      && nonEmptyString(fixture.action_expression)
      && nonEmptyString(fixture.ready_expression),
    `framework fixture inventory entry ${fixture?.category ?? "unknown"} is invalid`, "corpus_incomplete");
  }
  return new Map(inventory.fixtures.map(fixture => [fixture.category, fixture]));
}

function validateProductionCoverage(manifest, frameworkInventory) {
  const offlineSites = manifest.sites.filter(site => site.kind === "offline-fixture");
  const offlineCategories = offlineSites.map(site => site.fixture_category);
  const covered = new Set(offlineCategories);
  invariant(offlineCategories.length === REQUIRED_OFFLINE_CORPUS_CATEGORIES.length
    && covered.size === REQUIRED_OFFLINE_CORPUS_CATEGORIES.length
    && REQUIRED_OFFLINE_CORPUS_CATEGORIES.every(category => covered.has(category)),
  "production corpus must execute exactly one fixture for every required offline category", "corpus_incomplete");
  const fixturesByCategory = validateFrameworkInventory(frameworkInventory);
  for (const site of offlineSites) {
    const fixture = fixturesByCategory.get(site.fixture_category);
    invariant(site.fixture_path === fixture.path, `corpus site ${site.id} fixture_path does not match the checked framework inventory`, "corpus_incomplete");
    invariant(site.entry_path === fixture.entry_path, `corpus site ${site.id} entry_path does not match the checked framework inventory`, "corpus_incomplete");
    invariant(site.fixture_sha256 === fixture.tree_sha256, `corpus site ${site.id} fixture digest does not match the checked framework inventory`, "corpus_incomplete");
    invariant(site.actions.some(action => action.expression === fixture.action_expression), `corpus site ${site.id} does not execute the checked framework action`, "corpus_incomplete");
    invariant(site.compatibility_probes.some(probe => probe.expression === fixture.ready_expression), `corpus site ${site.id} does not execute the checked framework readiness probe`, "corpus_incomplete");
  }
  invariant(manifest.sites.some(site => site.kind === "live-canary"), "production corpus must execute at least one live canary", "corpus_incomplete");
}

function validateCorpusManifest(manifest, config, testMode, frameworkInventory) {
  invariant(manifest && typeof manifest === "object" && !Array.isArray(manifest), "corpus manifest must be an object");
  invariant(manifest.schema_version === 1, "unsupported corpus manifest schema_version");
  invariant(manifest.release_id === config.release_id, "corpus manifest release_id does not match performance configuration", "release_mismatch");
  invariant(nonEmptyString(manifest.oracle_id), "corpus manifest oracle_id is required");
  invariant(Array.isArray(manifest.sites) && manifest.sites.length > 0, "corpus manifest must enumerate at least one site");
  const ids = new Set();
  for (const site of manifest.sites) validateCorpusSite(site, ids, config);
  if (!testMode) validateProductionCoverage(manifest, frameworkInventory);
  return manifest;
}

async function collectFixtureEvidence(manifest, fixtureRoot) {
  const offlineSites = manifest.sites.filter(site => site.kind === "offline-fixture");
  invariant(offlineSites.length === 0 || fixtureRoot, "offline corpus requires --fixture-root with vendored fixture bytes", "fixture_evidence_missing");
  const evidence = new Map();
  for (const site of offlineSites) {
    evidence.set(site.id, await snapshotFixtureTree({
      fixtureRoot,
      fixturePath: site.fixture_path,
      entryPath: site.entry_path,
      expectedSha256: site.fixture_sha256,
      label: `corpus site ${site.id}`,
    }));
  }
  return evidence;
}

function siteFixtureEvidence(site, fixtureEvidence) {
  return site.kind === "offline-fixture"
    ? fixtureEvidence.get(site.id).report
    : { status: "not-applicable", verified: false, tree_sha256: null, asset_count: 0, served_from_snapshot: false, entry_path: null };
}



function executionManifest(manifest, fixtureServer, mediatedFixtureOrigin) {
  return {
    ...manifest,
    sites: manifest.sites.map(site => {
      if (site.kind === "live-canary") return site;
      const fixtureUrl = fixtureServer.urlFor(site.id, site.entry_path);
      const mediatedTargetUrl = mediatedFixtureOrigin.urlFor(site.id, site.entry_path);
      const mediatedUrl = site.mediated_url_template.replace("{fixture_url_encoded}", encodeURIComponent(mediatedTargetUrl));
      invariant(/^https?:\/\//.test(mediatedUrl), `corpus site ${site.id} mediated URL template did not produce HTTP(S)`, "fixture_evidence_invalid");
      return { ...site, native_url: fixtureUrl, mediated_url: mediatedUrl };
    }),
  };
}


function validateRegistry(registry, manifest) {
  invariant(registry && typeof registry === "object" && !Array.isArray(registry), "compatibility delta registry must be an object");
  invariant(Object.keys(registry).length === 7, "compatibility delta registry has an invalid top-level shape");
  invariant(registry.registry_version === 1, "unsupported compatibility delta registry version");
  invariant(registry.release_id === manifest.release_id, "compatibility delta registry release_id does not match corpus manifest", "release_mismatch");
  invariant(registry.oracle_id === manifest.oracle_id, "compatibility delta registry oracle_id does not match corpus manifest", "oracle_mismatch");
  invariant(/^[a-f0-9]{64}$/u.test(registry.oracle_digest), "compatibility delta registry oracle_digest is invalid");
  invariant(Number.isFinite(Date.parse(registry.generated_at)), "compatibility delta registry generated_at is invalid");
  invariant(Array.isArray(registry.browser_scope) && registry.browser_scope.length > 0, "compatibility delta registry browser_scope is required");
  invariant(Array.isArray(registry.entries), "compatibility delta registry entries are required");
  const browserIdentity = browser => browser && typeof browser === "object" && !Array.isArray(browser)
    && Object.keys(browser).length === 3 && ["chromium", "firefox", "safari", "test-browser"].includes(browser.family)
    && nonEmptyString(browser.exact_build) && nonEmptyString(browser.platform);
  invariant(registry.browser_scope.every(browserIdentity), "compatibility delta registry contains an invalid browser scope");
  const scopedBrowsers = new Set(registry.browser_scope.map(browser => `${browser.family}:${browser.exact_build}:${browser.platform}`));
  invariant(scopedBrowsers.size === registry.browser_scope.length, "compatibility delta registry contains duplicate browser scope");
  const identities = new Set();
  const observations = new Set();
  for (const entry of registry.entries) {
    const signature = entry?.exact_signature;
    invariant(entry && typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry).length === 13
      && /^delta-[a-z0-9-]+$/u.test(entry.id) && nonEmptyString(entry.observation_id)
      && signature && typeof signature === "object" && !Array.isArray(signature) && Object.keys(signature).length === 4
      && nonEmptyString(signature.surface) && nonEmptyString(signature.probe_id)
      && /^[a-f0-9]{64}$/u.test(signature.native_digest) && /^[a-f0-9]{64}$/u.test(signature.mediated_digest)
      && ["intentional-security-boundary", "platform-limitation", "browser-implementation-difference"].includes(entry.category)
      && /^https:\/\/github\.com\/gosuda\/zeroproxy\/issues\//u.test(entry.issue_url)
      && nonEmptyString(entry.owner) && nonEmptyString(entry.rationale) && nonEmptyString(entry.affected_release_range)
      && Array.isArray(entry.affected_browser_builds) && entry.affected_browser_builds.length > 0 && entry.affected_browser_builds.every(browserIdentity)
      && Number.isFinite(Date.parse(entry.introduced_at)) && Number.isFinite(Date.parse(entry.expires_at))
      && Date.parse(entry.introduced_at) <= Date.parse(registry.generated_at) && Date.parse(entry.expires_at) > Date.parse(registry.generated_at)
      && nonEmptyString(entry.removal_condition) && entry.test_id === registry.oracle_id,
    "compatibility delta registry contains an invalid ownership entry");
    invariant(entry.observation_id === `${signature.surface}.${signature.probe_id}`, `compatibility ownership entry ${entry.id} observation_id is not exact`);
    invariant(entry.affected_browser_builds.every(browser => scopedBrowsers.has(`${browser.family}:${browser.exact_build}:${browser.platform}`)), `compatibility ownership entry ${entry.id} exceeds browser scope`);
    const identity = JSON.stringify(signature);
    invariant(!identities.has(identity), `duplicate compatibility ownership signature ${identity}`);
    for (const browser of entry.affected_browser_builds) {
      const observation = `${entry.observation_id}:${browser.family}:${browser.exact_build}:${browser.platform}`;
      invariant(!observations.has(observation), `duplicate compatibility observation ${observation}`);
      observations.add(observation);
    }
    identities.add(identity);
  }
  return registry;
}


/** Verify the RFC 8785 canonical compatibility registry with the release threshold. */
export function verifyDeltaRegistrySignature({ registry, signatures, keys }) {
  return verifyCanonicalThresholdSignature({
    value: registry,
    signatures,
    keys,
    label: "compatibility delta registry",
    code: "registry_signature_invalid",
  });
}

function normalizeSignals(value, label) {
  invariant(Array.isArray(value), `${label}.deterministic_signals must be an array`, "adapter_invalid");
  const signals = [];
  const ids = new Set();
  for (const signal of value) {
    invariant(signal && nonEmptyString(signal.id) && nonEmptyString(signal.signature), `${label} contains invalid deterministic signal`, "adapter_invalid");
    invariant(!ids.has(signal.id), `${label} has duplicate deterministic signal ${signal.id}`, "adapter_invalid");
    ids.add(signal.id);
    signals.push({ id: signal.id, signature: signal.signature });
  }
  return signals.sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeActions(value, label) {
  invariant(value && typeof value === "object" && typeof value.passed === "boolean", `${label}.actions.passed is required`, "adapter_invalid");
  invariant(Array.isArray(value.executed) && value.executed.length > 0 && value.executed.every(nonEmptyString), `${label}.actions.executed must enumerate actions`, "adapter_invalid");
  invariant(new Set(value.executed).size === value.executed.length, `${label}.actions.executed must be unique`, "adapter_invalid");
  invariant(Array.isArray(value.failures) && value.failures.every(nonEmptyString), `${label}.actions.failures must be strings`, "adapter_invalid");
  return { passed: value.passed, executed: [...value.executed].sort(), failures: [...value.failures].sort() };
}

function normalizeEvaluation(value, label) {
  invariant(value && typeof value === "object", `${label} evaluation must be an object`, "adapter_invalid");
  invariant(value.compatibility && typeof value.compatibility === "object" && typeof value.compatibility.passed === "boolean", `${label}.compatibility.passed is required`, "adapter_invalid");
  const failures = value.compatibility.failures ?? [];
  invariant(Array.isArray(failures) && failures.every(nonEmptyString), `${label}.compatibility.failures must be strings`, "adapter_invalid");
  invariant(value.actions && typeof value.actions === "object", `${label}.actions is required`, "adapter_invalid");
  return {
    actions: normalizeActions(value.actions, label),
    compatibility: { passed: value.compatibility.passed, failures: [...failures].sort() },
    deterministic_signals: normalizeSignals(value.deterministic_signals, label),
  };
}
function validateExecutedActions(evaluation, site, label) {
  const expected = site.actions.map(action => action.id).sort();
  invariant(JSON.stringify(evaluation.actions.executed) === JSON.stringify(expected), `${label}.actions.executed does not match the manifest`, "adapter_invalid");
}

function browserInRegistryScope(registry, browser) {
  const platform = `${process.platform}-${process.arch}`;
  return registry.browser_scope.some(scope => scope.family === browser.family && scope.exact_build === browser.exact_build && scope.platform === platform);
}

function compareSignals(nativeSignals, mediatedSignals, registry, browser) {
  const nativeById = new Map(nativeSignals.map(signal => [signal.id, signal.signature]));
  const mediatedById = new Map(mediatedSignals.map(signal => [signal.id, signal.signature]));
  const ids = [...new Set([...nativeById.keys(), ...mediatedById.keys()])].sort();
  const platform = `${process.platform}-${process.arch}`;
  const ownership = new Map(registry.entries
    .filter(entry => entry.affected_browser_builds.some(scope => scope.family === browser.family && scope.exact_build === browser.exact_build && scope.platform === platform))
    .map(entry => [JSON.stringify(entry.exact_signature), entry]));
  return ids.flatMap(id => {
    const nativeSignature = nativeById.get(id) ?? null;
    const mediatedSignature = mediatedById.get(id) ?? null;
    if (nativeSignature === mediatedSignature) return [];
    const signature = {
      surface: "corpus-deterministic-signal",
      probe_id: id,
      native_digest: canonicalDigest(nativeSignature),
      mediated_digest: canonicalDigest(mediatedSignature),
    };
    const exactSignature = canonicalDigest(signature);
    const owner = ownership.get(JSON.stringify(signature));
    return [{
      id,
      exact_signature: exactSignature,
      native_signature: nativeSignature,
      mediated_signature: mediatedSignature,
      ownership: owner ? { status: "owned", owner: owner.owner, registry_entry_id: owner.id } : { status: "unowned" },
    }];
  });
}

function isoNow(now) {
  const value = now();
  invariant(value instanceof Date && !Number.isNaN(value.valueOf()), "clock must return a valid Date");
  return value.toISOString();
}

/**
 * Adapter contract: describe() returns {browser:{family,exact_build}};
 * evaluateSite({site, mode}) returns compatibility and deterministic signals for both native and mediated modes.
 */
async function evaluateCorpusSite({ site, adapter, browser, context, registry, violations, fixtureEvidence }) {
  const native = normalizeEvaluation(await adapter.evaluateSite({ site, mode: "native", context }), `${site.id} native`);
  const mediated = normalizeEvaluation(await adapter.evaluateSite({ site, mode: "mediated", context }), `${site.id} mediated`);
  validateExecutedActions(native, site, `${site.id} native`);
  validateExecutedActions(mediated, site, `${site.id} mediated`);
  const deltas = compareSignals(native.deterministic_signals, mediated.deterministic_signals, registry, browser);
  if (!native.actions.passed)
    violations.push({ code: "native_action_failure", site_id: site.id, failures: native.actions.failures });
  if (!mediated.actions.passed)
    violations.push({ code: "mediated_action_failure", site_id: site.id, failures: mediated.actions.failures });
  if (!native.compatibility.passed)
    violations.push({ code: "native_compatibility_failure", site_id: site.id, failures: native.compatibility.failures });
  if (!mediated.compatibility.passed)
    violations.push({ code: "mediated_compatibility_failure", site_id: site.id, failures: mediated.compatibility.failures });
  for (const delta of deltas) {
    if (delta.ownership.status === "unowned")
      violations.push({ code: "unowned_deterministic_delta", site_id: site.id, delta_id: delta.id, exact_signature: delta.exact_signature });
  }
  return {
    id: site.id,
    url: site.url,
    site_class: site.site_class,
    kind: site.kind,
    fixture_category: site.fixture_category,
    fixture_sha256: site.fixture_sha256,
    fixture_path: site.fixture_path,
    fixture_evidence: siteFixtureEvidence(site, fixtureEvidence),
    execution_urls: { native: site.native_url, mediated: site.mediated_url },
    actions: { native: native.actions, mediated: mediated.actions },
    compatibility: { native: native.compatibility, mediated: mediated.compatibility },
    stealth: {
      native_signals: native.deterministic_signals,
      mediated_signals: mediated.deterministic_signals,
      deltas,
      outcome: deltas.some(delta => delta.ownership.status === "unowned") ? "unowned-delta" : "owned-or-no-delta",
    },
  };
}

async function collectCorpusReports({ manifest, adapter, browser, context, registry, violations, fixtureEvidence }) {
  const reports = [];
  for (const site of [...manifest.sites].sort((left, right) => left.id.localeCompare(right.id)))
    reports.push(await evaluateCorpusSite({ site, adapter, browser, context, registry, violations, fixtureEvidence }));
  return reports;
}
function contentAddressedFixtureBase(baseUrl, inventorySha256) {
  try {
    return /^[a-f0-9]{64}$/u.test(inventorySha256) && new URL(baseUrl).pathname.split("/").includes(inventorySha256);
  } catch {
    return false;
  }
}

function sameRemoteFixtureEvidence(before, after) {
  return after?.status === "verified"
    && after.verified === true
    && after.https === before.https
    && after.immutable_cache === before.immutable_cache
    && after.base_url_sha256 === before.base_url_sha256
    && after.asset_evidence_sha256 === before.asset_evidence_sha256
    && after.asset_count === before.asset_count;
}
function validateRegistryVerification({ registryVerification, allowUnsignedRegistry, testMode }) {
  if (testMode) {
    invariant(registryVerification?.verified === true || allowUnsignedRegistry, "test-mode unsigned registry requires explicit allowUnsignedRegistry", "registry_signature_missing");
    return;
  }
  invariant(registryVerification?.verified === true, "a verified compatibility delta registry is required", "registry_signature_missing");
  invariant(registryVerification.development_only !== true, "development-only compatibility signatures cannot certify production evidence", "registry_signature_invalid");
}

function validateRemoteFixtureEvidence(evidence, expectedAssets, testMode) {
  invariant(evidence.status === "verified"
    && evidence.verified === true
    && (!testMode ? evidence.https === true : typeof evidence.https === "boolean")
    && (!testMode ? evidence.immutable_cache === true : typeof evidence.immutable_cache === "boolean")
    && typeof evidence.base_url_sha256 === "string" && /^[a-f0-9]{64}$/u.test(evidence.base_url_sha256)
    && typeof evidence.asset_evidence_sha256 === "string" && /^[a-f0-9]{64}$/u.test(evidence.asset_evidence_sha256)
    && evidence.asset_count === expectedAssets
    && typeof evidence.urlFor === "function",
  "mediated fixture origin verification is incomplete", "fixture_evidence_invalid");
}

async function prepareRemoteFixtureEvidence({ fixtureEvidence, baseUrl, inventorySha256, verifier, testMode }) {
  if (!baseUrl) {
    invariant(testMode, "production corpus requires a release-reachable --mediated-fixture-base-url", "fixture_evidence_missing");
    return null;
  }
  invariant(testMode || contentAddressedFixtureBase(baseUrl, inventorySha256), "production mediated fixture base URL must contain the checked inventory digest as a path segment", "fixture_evidence_invalid");
  const evidence = await verifier({ snapshots: fixtureEvidence, baseUrl, requireHttps: !testMode });
  const expectedAssets = [...fixtureEvidence.values()].reduce((sum, fixture) => sum + fixture.report.asset_count, 0);
  validateRemoteFixtureEvidence(evidence, expectedAssets, testMode);
  return evidence;
}

async function reverifyRemoteFixtureEvidence({ before, fixtureEvidence, baseUrl, verifier, testMode }) {
  if (!before) return null;
  const after = await verifier({ snapshots: fixtureEvidence, baseUrl, requireHttps: !testMode });
  invariant(sameRemoteFixtureEvidence(before, after), "mediated fixture origin changed during corpus execution", "fixture_evidence_invalid");
  return after;
}

function verifyRegistryBrowserScope(registry, browser, testMode) {
  if (!testMode) invariant(browserInRegistryScope(registry, browser), "browser is outside signed compatibility delta registry scope", "browser_scope_mismatch");
}
function validateRegistryReleaseTimestamp(registry, releaseTimestamp) {
  invariant(releaseTimestamp instanceof Date && !Number.isNaN(releaseTimestamp.valueOf()), "clock must return a valid Date");
  for (const entry of registry.entries) {
    invariant(Date.parse(entry.introduced_at) <= releaseTimestamp.valueOf(), `compatibility registry entry ${entry.id} is not active at the release timestamp`, "registry_entry_inactive");
    invariant(Date.parse(entry.expires_at) > releaseTimestamp.valueOf(), `compatibility registry entry ${entry.id} expired before the release timestamp`, "registry_entry_expired");
  }
}

function collectUnobservedRegistryViolations(registry, reports, browser) {
  const platform = `${process.platform}-${process.arch}`;
  const applicableEntries = registry.entries.filter(entry =>
    entry.exact_signature.surface === "corpus-deterministic-signal"
    && entry.affected_browser_builds.some(scope =>
      scope.family === browser.family
      && scope.exact_build === browser.exact_build
      && scope.platform === platform));
  const observedEntries = new Set(reports.flatMap(report => report.stealth.deltas
    .filter(delta => delta.ownership.status === "owned")
    .map(delta => delta.ownership.registry_entry_id)));
  return applicableEntries
    .filter(entry => !observedEntries.has(entry.id))
    .map(entry => ({ code: "unobserved_registry_entry", registry_entry_id: entry.id, test_id: entry.test_id }));
}



async function executeCorpusGate({
  config,
  configSha256 = canonicalDigest(config),
  browserBoundary = null,
  manifest,
  manifestSha256 = canonicalDigest(manifest),
  frameworkInventory = null,
  frameworkInventorySha256 = canonicalDigest(frameworkInventory ?? { schema_version: 1, fixtures: [] }),
  registry,
  registrySha256 = canonicalDigest(registry),
  registryVerification = null,
  allowUnsignedRegistry = false,
  build,
  adapter,
  fixtureRoot = null,
  mediatedFixtureBaseUrl = null,
  remoteFixtureVerifier = verifyRemoteFixtureOrigin,
  now = () => new Date(),
  testMode = false,
}) {
  invariant(config && manifest && registry && build && adapter, "corpus gate requires config, manifest, registry, build, and adapter");
  validateCorpusManifest(manifest, config, testMode, frameworkInventory);
  validateRegistry(registry, manifest);
  const releaseTimestamp = now();
  validateRegistryReleaseTimestamp(registry, releaseTimestamp);
  invariant(typeof adapter.describe === "function" && typeof adapter.evaluateSite === "function", "corpus adapter must implement describe() and evaluateSite()", "adapter_invalid");
  validateRegistryVerification({ registryVerification, allowUnsignedRegistry, testMode });
  const fixtureEvidence = await collectFixtureEvidence(manifest, fixtureRoot);
  const remoteFixtureEvidence = await prepareRemoteFixtureEvidence({
    fixtureEvidence,
    baseUrl: mediatedFixtureBaseUrl,
    inventorySha256: frameworkInventorySha256,
    verifier: remoteFixtureVerifier,
    testMode,
  });
  const context = { build, release: releaseTuple(config, configSha256, build), manifest_sha256: manifestSha256, framework_inventory_sha256: frameworkInventorySha256, registry_sha256: registrySha256, test_mode: testMode };
  const environment = await adapter.describe(context);
  invariant(environment && typeof environment === "object", "corpus adapter describe() must return an object", "adapter_invalid");
  const browserPin = verifyBrowserPin({ config, browser: environment.browser, boundary: browserBoundary, testMode });
  verifyRegistryBrowserScope(registry, environment.browser, testMode);

  const fixtureServer = await startFixtureSnapshotServer(fixtureEvidence);
  const mediatedFixtureOrigin = remoteFixtureEvidence ?? {
    status: "not-applicable",
    verified: false,
    https: false,
    immutable_cache: false,
    base_url_sha256: null,
    asset_evidence_sha256: null,
    asset_count: 0,
    urlFor: (id, entryPath) => fixtureServer.urlFor(id, entryPath),
  };
  const violations = [];
  let reports;
  let remoteFixtureEvidenceAfter;
  try {
    const executableManifest = executionManifest(manifest, fixtureServer, mediatedFixtureOrigin);
    reports = await collectCorpusReports({ manifest: executableManifest, adapter, browser: environment.browser, context, registry, violations, fixtureEvidence });
    remoteFixtureEvidenceAfter = await reverifyRemoteFixtureEvidence({
      before: remoteFixtureEvidence,
      fixtureEvidence,
      baseUrl: mediatedFixtureBaseUrl,
      verifier: remoteFixtureVerifier,
      testMode,
    });
  } finally {
    await fixtureServer.close();
  }
  violations.push(...collectUnobservedRegistryViolations(registry, reports, environment.browser));

  const status = violations.length === 0 ? "pass" : "fail";
  return {
    schema_version: 1,
    report_type: "corpus-gate",
    generated_at: releaseTimestamp.toISOString(),
    status,
    test_mode: testMode,
    certification: productionCertification({
      testMode,
      status,
      browserPin,
      prerequisites: [
        registryVerification?.verified === true && registryVerification.development_only !== true,
        [...fixtureEvidence.values()].every(evidence => evidence.report.verified === true),
        remoteFixtureEvidence?.verified === true && remoteFixtureEvidence.https === true && remoteFixtureEvidence.immutable_cache === true && sameRemoteFixtureEvidence(remoteFixtureEvidence, remoteFixtureEvidenceAfter),
      ],
    }),
    release: releaseTuple(config, configSha256, build),
    environment: {
      ...runtimeIdentity(),
      browser: environment.browser,
      browser_pin: browserPin,
      adapter_toolchain: environment.toolchain ?? null,
      registry_scope_verified: !testMode,
    },
    build: { tree_sha256: build.tree_sha256, assets: build.assets },
    manifest: {
      sha256: manifestSha256,
      framework_inventory_sha256: frameworkInventorySha256,
      site_count: reports.length,
      oracle_id: manifest.oracle_id,
      offline_fixture_categories: reports.filter(site => site.kind === "offline-fixture").map(site => site.fixture_category).sort(),
      live_canary_count: reports.filter(site => site.kind === "live-canary").length,
      fixture_evidence_sha256: canonicalDigest(reports.map(site => ({ id: site.id, fixture_evidence: site.fixture_evidence }))),
      mediated_fixture_origin: {
        status: mediatedFixtureOrigin.status,
        verified: mediatedFixtureOrigin.verified,
        https: mediatedFixtureOrigin.https,
        immutable_cache: mediatedFixtureOrigin.immutable_cache,
        base_url_sha256: mediatedFixtureOrigin.base_url_sha256,
        asset_evidence_sha256: mediatedFixtureOrigin.asset_evidence_sha256,
        asset_count: mediatedFixtureOrigin.asset_count,
        verified_before_after: remoteFixtureEvidence !== null && sameRemoteFixtureEvidence(remoteFixtureEvidence, remoteFixtureEvidenceAfter),
      },
    },
    registry: {
      sha256: registrySha256,
      oracle_id: registry.oracle_id,
      entry_count: registry.entries.length,
      verification: registryVerification ?? { verified: false, mode: "unsigned-test-fixture" },
    },
    sites: reports,
    violations,
  };
}
export async function runCorpusGate(options) {
  const adapter = options?.adapter;
  try {
    return await executeCorpusGate(options);
  } finally {
    if (typeof adapter?.close === "function") await adapter.close();
  }
}

function selfTestConfig() {
  const runtime = runtimeIdentity();
  return {
    schema_version: 1,
    release_id: "gate-self-test",
    reference_platform: { os: runtime.os, arch: runtime.architecture, browser_builds: ["test-browser-1.0.0"] },
    warmups: 1, measured_pairs: 1, bootstrap_resamples: 1, max_cv: 0.1,
    gates: { self_test_p95_ms: 1 },
    site_classes: {
      content: { dcl_delta: 0.1, lcp_delta: 0.1, inp_delta_ms: 1, cpu_delta: 0.1 },
      application: { dcl_delta: 0.1, lcp_delta: 0.1, inp_delta_ms: 1, cpu_delta: 0.1 },
      editor_media_pwa: { dcl_delta: 0.1, lcp_delta: 0.1, inp_delta_ms: 1, cpu_delta: 0.1 },
    },
    soak: { hours: 8, warmup_minutes: 30, quiescence_minutes: 15, origins: 20, clients: 40, short_streams: 200, sse_streams: 20, websockets: 20, abort_churn: 0.1 },
  };
}

export async function runCorpusSelfTest() {
  return withTemporaryDirectory("zeroproxy-corpus-self-test", async root => {
    await writeFile(path.join(root, "current-build.bin"), "self-test build input\n", "utf8");
    const adapter = {
      async describe() { return { browser: { family: "test-browser", exact_build: "1.0.0" }, toolchain: { kind: "deterministic-self-test" } }; },
      async evaluateSite({ mode }) {
        return {
          actions: { passed: true, executed: ["surface:self-test"], failures: [] },
          compatibility: { passed: true, failures: [] },
          deterministic_signals: [{ id: "canvas", signature: mode === "native" ? "native" : "mediated" }],
        };
      },
    };
    const report = await runCorpusGate({
      config: selfTestConfig(),
      manifest: { schema_version: 1, release_id: "gate-self-test", oracle_id: "self-test-oracle", sites: [{ id: "site", url: "https://site.invalid/", native_url: "https://native.invalid/", mediated_url: "https://site.invalid/", kind: "live-canary", fixture_category: null, fixture_sha256: null, fixture_path: null, entry_path: null, mediated_url_template: null, site_class: "content", actions: [{ id: "surface:self-test", expression: "true" }], compatibility_probes: [{ id: "ready", expression: "document.readyState === 'complete'" }], stealth_probes: [{ id: "navigator", expression: "navigator.userAgent" }] }] },
      registry: {
        registry_version: 1,
        release_id: "gate-self-test",
        oracle_id: "self-test-oracle",
        oracle_digest: "0".repeat(64),
        generated_at: "2026-01-01T00:00:00.000Z",
        browser_scope: [{ family: "test-browser", exact_build: "1.0.0", platform: `${process.platform}-${process.arch}` }],
        entries: [],
      },
      allowUnsignedRegistry: true,
      build: await collectBuildIdentity(root),
      adapter,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      testMode: true,
    });
    invariant(report.status === "fail" && report.violations.some(violation => violation.code === "unowned_deterministic_delta"), "corpus self-test did not reject an unowned deterministic delta", "self_test_failed");
    return { self_test: "corpus-unowned-delta-fails-closed", status: "pass", certification_claimed: false };
  });
}

function help() {
  return [
    "Usage: node scripts/gates/corpus.mjs --adapter <module.mjs> --manifest <corpus.json> --build-dir <dir> --output <report.json> [options]",
    "",
    "The adapter exports createCorpusEvidenceAdapter(context), then implements describe() and evaluateSite({site, mode}).",
    "Production requires a verified signed compatibility-delta registry; --unsigned-test-registry is test-mode only.",
    "Options:",
    "  --config <path>                 Performance configuration (default: protocol/performance-gates.json)",
    "  --boundary <path>               Browser boundary declaration (default: protocol/browser-boundaries.json)",
    "  --registry <path>               Delta registry (default: protocol/compatibility-deltas.json)",
    "  --registry-signature <path>     Registry signature (default: protocol/compatibility-deltas.sig)",
    "  --release-keys <path>           Release signing keys (default: protocol/release-signing-keys.json)",
    "  --fixture-root <path>           Root containing vendored offline fixtures",
    "  --mediated-fixture-base-url <url>  Release-reachable immutable HTTPS fixture base",
    "  --framework-inventory <path>    Checked fixture inventory (default: test/frameworks/manifest.json)",
    "  --test-mode                     Mark execution as non-certifying",
    "  --unsigned-test-registry        Allow only an explicit unsigned test fixture with --test-mode",
    "  --self-test                     Exercise unowned-delta rejection",
    "  --help                          Show this help",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ["help", "self-test", "test-mode", "unsigned-test-registry"],
    values: ["adapter", "manifest", "framework-inventory", "build-dir", "fixture-root", "mediated-fixture-base-url", "output", "config", "boundary", "registry", "registry-signature", "release-keys"],
  });
  invariant(args._.length === 0, "unexpected positional arguments", "invalid_cli");
  if (args.help) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  if (args["self-test"]) {
    invariant(!args.adapter && !args.manifest && !args["build-dir"] && !args.output, "--self-test cannot be combined with production inputs", "invalid_cli");
    process.stdout.write(canonicalJson(await runCorpusSelfTest()));
    return;
  }
  const testMode = args["test-mode"] === true;
  invariant(!args["unsigned-test-registry"] || testMode, "--unsigned-test-registry requires --test-mode", "invalid_cli");
  const base = moduleDirectory(import.meta.url);
  const configPath = args.config ?? path.resolve(base, "../../protocol/performance-gates.json");
  const boundaryPath = args.boundary ?? path.resolve(base, "../../protocol/browser-boundaries.json");
  const registryPath = args.registry ?? path.resolve(base, "../../protocol/compatibility-deltas.json");
  const signaturePath = args["registry-signature"] ?? path.resolve(base, "../../protocol/compatibility-deltas.sig");
  const keyPath = args["release-keys"] ?? path.resolve(base, "../../protocol/release-signing-keys.json");
  const frameworkInventoryPath = args["framework-inventory"] ?? path.resolve(base, "../../test/frameworks/manifest.json");
  invariant(nonEmptyString(args.manifest), "--manifest is required", "invalid_cli");
  const { config, configSha256 } = await loadPerformanceConfig(configPath, { testMode });
  const manifestLoaded = await readJson(args.manifest);
  const registryLoaded = await readJson(registryPath);
  const frameworkInventoryLoaded = await readJson(frameworkInventoryPath);
  const manifestSchema = await readJson(path.resolve(base, "../../protocol/corpus-manifest.schema.json"));
  const manifestValidation = validateJsonSchema(manifestLoaded.value, manifestSchema.value);
  invariant(manifestValidation.valid, `corpus manifest schema validation failed: ${manifestValidation.errors.join("; ")}`, "manifest_invalid");
  const frameworkInventorySchema = await readJson(path.resolve(base, "../../protocol/framework-fixtures.schema.json"));
  const frameworkInventoryValidation = validateJsonSchema(frameworkInventoryLoaded.value, frameworkInventorySchema.value);
  invariant(frameworkInventoryValidation.valid, `framework fixture inventory schema validation failed: ${frameworkInventoryValidation.errors.join("; ")}`, "manifest_invalid");
  const registrySchema = await readJson(path.resolve(base, "../../protocol/compatibility-deltas.schema.json"));
  const registryValidation = validateJsonSchema(registryLoaded.value, registrySchema.value);
  invariant(registryValidation.valid, `compatibility registry schema validation failed: ${registryValidation.errors.join("; ")}`, "registry_invalid");
  let registryVerification = null;
  if (!args["unsigned-test-registry"]) {
    const signaturesLoaded = await readJson(signaturePath);
    const keysLoaded = await readJson(keyPath);
    const signatureSchema = await readJson(path.resolve(base, "../../protocol/release-signature.schema.json"));
    const keysSchema = await readJson(path.resolve(base, "../../protocol/release-signing-keys.schema.json"));
    const signatureValidation = validateJsonSchema(signaturesLoaded.value, signatureSchema.value);
    const keysValidation = validateJsonSchema(keysLoaded.value, keysSchema.value);
    invariant(signatureValidation.valid, `compatibility registry signature schema validation failed: ${signatureValidation.errors.join("; ")}`, "registry_signature_invalid");
    invariant(keysValidation.valid, `release signing key schema validation failed: ${keysValidation.errors.join("; ")}`, "registry_signature_invalid");
    registryVerification = verifyDeltaRegistrySignature({ registry: registryLoaded.value, signatures: signaturesLoaded.value, keys: keysLoaded.value });
  }
  const build = await collectBuildIdentity(args["build-dir"]);
  const factory = await loadAdapter(args.adapter, "createCorpusEvidenceAdapter");
  const adapter = await factory({ config, manifest: manifestLoaded.value, registry: registryLoaded.value, build, test_mode: testMode });
  const report = await runCorpusGate({
    config,
    configSha256,
    browserBoundary: await loadBrowserBoundaries(boundaryPath),
    manifest: manifestLoaded.value,
    manifestSha256: manifestLoaded.sha256,
    frameworkInventory: frameworkInventoryLoaded.value,
    frameworkInventorySha256: frameworkInventoryLoaded.sha256,
    registry: registryLoaded.value,
    registrySha256: registryLoaded.sha256,
    registryVerification,
    allowUnsignedRegistry: args["unsigned-test-registry"] === true,
    fixtureRoot: args["fixture-root"],
    mediatedFixtureBaseUrl: args["mediated-fixture-base-url"],
    build,
    adapter,
    testMode,
  });
  const destination = await writeCanonicalReport(args.output, report);
  process.stdout.write(canonicalJson(reportCommandSummary(destination, report)));
  if (report.status !== "pass") process.exitCode = 1;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch(error => {
    const message = error instanceof GateFailure ? error.message : error.stack || error.message;
    process.stderr.write(`corpus gate failed: ${message}\n`);
    process.exitCode = 1;
  });
}
