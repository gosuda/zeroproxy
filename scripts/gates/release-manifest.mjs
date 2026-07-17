import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalDigest, canonicalJson, invariant, loadBrowserBoundaries, loadPerformanceConfig, moduleDirectory, parseArgs, readJson, sha256, validateJsonSchema, verifyCanonicalThresholdSignature, writeCanonicalReport } from "./common.mjs";
import { evaluateV1AggregateEvidence } from "./performance.mjs";
import { evaluateSoakLeakEvidence } from "./soak.mjs";
import { REQUIRED_OFFLINE_CORPUS_CATEGORIES } from "./corpus.mjs";

const GATES = ["performance", "egress", "soak", "corpus"];
const REQUIRED_ARTIFACTS = ["server", "control", "service_worker", "kernel", "rust", "runtime", "messages", "carrier", "support_matrix", "framework_fixtures", "framework_fixtures_schema", "soak_workload_server", "compatibility_deltas", "migration_disposition", "v1_baseline", "v1_evidence_manifest", "standards_lock", "build_assets", "ci_workflow"];
function validDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function verifyGateReportSignatures({ reports, signatures, keys }) {
  invariant(reports && signatures && keys, "gate reports, detached signatures, and release keys are required", "report_signature_missing");
  const verifications = {};
  for (const gate of GATES) {
    invariant(reports[gate] && signatures[gate], `detached signature is required for ${gate} report`, "report_signature_missing");
    const verification = verifyCanonicalThresholdSignature({
      value: reports[gate],
      signatures: signatures[gate],
      keys,
      label: `${gate} gate report`,
      code: "report_signature_invalid",
    });
    verifications[gate] = Object.freeze({
      ...verification,
      signature_sha256: canonicalDigest(signatures[gate]),
    });
  }
  return Object.freeze(verifications);
}

function signingPolicyReasons(keys) {
  if (!keys || !Number.isSafeInteger(keys.key_epoch)) return ["release-signing-key-set-unavailable"];
  return keys.development_only === true ? ["development-only-release-signing-keys"] : [];
}
function artifactPolicyReasons(verification, artifactHashes, configSha256, buildTreeSha256) {
  if (verification?.verified !== true) return ["artifact-evidence-signature-unverified"];
  const reasons = [];
  if (verification.development_only === true) reasons.push("artifact-evidence-development-signature");
  if (verification.performance_config_sha256 !== configSha256) reasons.push("artifact-evidence-config-mismatch");
  if (verification.build_tree_sha256 !== buildTreeSha256) reasons.push("artifact-evidence-build-mismatch");
  if (verification.artifact_hashes_sha256 !== canonicalDigest(artifactHashes)) reasons.push("artifact-evidence-hashes-mismatch");
  if (!validDigest(verification.schema_sha256)) reasons.push("artifact-evidence-schema-unavailable");
  return reasons;
}

function unavailableToolchainReasons(config) {
  return validDigest(config.toolchains_sha256) ? [] : ["toolchain-manifest-unavailable"];
}

function unavailableBrowserReasons(config) {
  return config.browser_lanes.flatMap(lane =>
    lane.availability === "available" && lane.exact_build && lane.binary_sha256
      ? []
      : [`browser-unavailable:${lane.family}`]);
}

function unavailableFixtureReasons(config) {
  return config.fixtures.flatMap(fixture =>
    fixture.availability === "available" && fixture.sha256
      ? []
      : [`fixture-unavailable:${fixture.id}`]);
}

function policyReasons(config, boundary) {
  const reasons = [
    ...unavailableToolchainReasons(config),
    ...unavailableBrowserReasons(config),
    ...unavailableFixtureReasons(config),
  ];
  if (config.reference_platform.hardware.availability !== "available")
    reasons.push("hardware-provenance-unavailable");
  if (config.packet_capture?.availability !== "available"
    || config.packet_capture?.privilege !== "available"
    || config.packet_capture?.certified !== true)
    reasons.push("chromium-packet-capture-privilege-or-certification-unavailable");
  const supported = config.browser_lanes.every(required =>
    boundary?.browser_lanes?.some(recorded =>
      recorded.family === required.family
      && recorded.exact_build === required.exact_build
      && recorded.release_supported === true
      && recorded.packet_capture_certified === true));
  if (!supported) reasons.push("required-chromium-packet-or-support-evidence-unavailable");
  return reasons;
}

function performanceFixtureEvidenceValid(record, expectedSha256 = null) {
  const evidence = record?.fixture_evidence;
  return validDigest(record?.fixture_sha256)
    && (expectedSha256 === null || record.fixture_sha256 === expectedSha256)
    && evidence?.verified === true
    && evidence.served_from_snapshot === true
    && evidence.tree_sha256 === record.fixture_sha256
    && evidence.asset_count > 0
    && typeof evidence.entry_path === "string";
}

function hasCompleteGateSamples(report, config) {
  const expectedGates = new Set(Object.keys(config.gates));
  const scenarios = report?.scenarios ?? [];
  const observedGates = new Set(scenarios.map(scenario => scenario.gate));
  return scenarios.length === expectedGates.size
    && observedGates.size === expectedGates.size
    && [...expectedGates].every(gate => observedGates.has(gate))
    && scenarios.every(scenario => scenario.sample_count === 30 && scenario.warmup_count === 5 && scenario.pairs?.length === 30 && performanceFixtureEvidenceValid(scenario));
}

function completeFixtureReports(report, config) {
  const expectedFixtures = new Map(config.fixtures.filter(fixture => fixture.availability === "available").map(fixture => [fixture.id, fixture]));
  const fixtureReports = report?.fixture_reports ?? [];
  const observedFixtures = new Set();
  if (fixtureReports.length !== expectedFixtures.size) return null;
  for (const fixtureReport of fixtureReports) {
    const expected = expectedFixtures.get(fixtureReport.fixture_id);
    if (!expected
      || expected.site_class !== fixtureReport.site_class
      || !performanceFixtureEvidenceValid(fixtureReport, expected.sha256)
      || observedFixtures.has(fixtureReport.fixture_id)
      || fixtureReport.sample_count !== 30
      || fixtureReport.warmup_count !== 5
      || fixtureReport.pairs?.length !== 30)
      return null;
    observedFixtures.add(fixtureReport.fixture_id);
  }
  return fixtureReports;
}

function aggregateMatchesFixtureReports(fixtureReports, report, config) {
  if (!fixtureReports) return false;
  try {
    const aggregateViolations = [];
    const recomputed = evaluateV1AggregateEvidence(fixtureReports, config, aggregateViolations);
    return aggregateViolations.length === 0
      && recomputed.status === "pass"
      && canonicalJson(recomputed) === canonicalJson(report.v1_aggregate);
  } catch {
    return false;
  }
}

function performanceReportReasons(report, config) {
  const measurement = report?.measurement;
  const complete = measurement?.warmups === 5
    && measurement?.measured_pairs === 30
    && measurement?.bootstrap_resamples === 10_000
    && measurement?.max_cv === 0.1
    && !report?.invalidations?.length
    && hasCompleteGateSamples(report, config);
  const fixtureReports = completeFixtureReports(report, config);
  return [
    ...(complete ? [] : ["performance-policy-evidence-incomplete"]),
    ...(aggregateMatchesFixtureReports(fixtureReports, report, config) ? [] : ["v1-aggregate-evidence-unavailable"]),
  ];
}

function egressReportReasons(report) {
  const valid = Array.isArray(report?.scenarios)
    && report.scenarios.length > 0
    && report.scenarios.every(scenario =>
      scenario.capture?.pcap_sha256
      && scenario.capture?.provenance
      && Array.isArray(scenario.violations)
      && !scenario.violations.some(violation => /direct_target|unapproved_dns/i.test(violation.code)));
  return valid ? [] : ["egress-pcap-or-zero-direct-flow-evidence-unavailable"];
}
function sameStringSet(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && new Set(actual).size === actual.length
    && expected.every(value => actual.includes(value));
}
function uniqueSupportBrowserTuples(supportMatrix) {
  const records = supportMatrix?.browsers ?? [];
  const tuples = new Set(records.map(record => `${record.family}\0${record.exact_build}\0${record.platform}`));
  return records.length > 0 && tuples.size === records.length;
}

function supportMatrixReasons({ supportMatrix, supportMatrixSchema, artifactHashes, egressReport, config, browserBoundary }) {
  const reasons = [];
  if (!supportMatrix?.value || !validDigest(supportMatrix.sha256))
    return ["support-matrix-unavailable"];
  if (!supportMatrixSchema?.value || !validDigest(supportMatrixSchema.sha256))
    reasons.push("support-matrix-schema-unavailable");
  else if (!validateJsonSchema(supportMatrix.value, supportMatrixSchema.value).valid)
    reasons.push("support-matrix-schema-invalid");
  if (!uniqueSupportBrowserTuples(supportMatrix.value))
    reasons.push("support-matrix-browser-tuples-duplicate-or-missing");
  if (supportMatrix.value.release_id !== config.release_id)
    reasons.push("support-matrix-release-mismatch");
  if (artifactHashes.support_matrix !== supportMatrix.sha256)
    reasons.push("support-matrix-artifact-mismatch");
  const expectedSurfaces = supportMatrix.value.egress_surfaces ?? [];
  const egressScenarios = egressReport?.scenarios ?? [];
  const scenarioIds = egressScenarios.map(scenario => scenario.id);
  const observedSurfaces = egressScenarios.flatMap(scenario => scenario.surfaces ?? []);
  if (egressReport?.manifest?.support_matrix_sha256 !== supportMatrix.sha256
    || egressReport?.manifest?.scenario_count !== egressScenarios.length
    || new Set(scenarioIds).size !== scenarioIds.length
    || !sameStringSet(egressReport?.manifest?.surfaces, expectedSurfaces)
    || !sameStringSet([...new Set(observedSurfaces)], expectedSurfaces)
    || !egressScenarios.every(scenario => Array.isArray(scenario.surfaces) && scenario.surfaces.length > 0))
    reasons.push("egress-support-matrix-evidence-mismatch");
  const browserEvidenceComplete = config.browser_lanes
    .filter(lane => lane.availability === "available")
    .every(lane => {
      const boundary = browserBoundary?.browser_lanes?.find(browser =>
        browser.family === lane.family && browser.exact_build === lane.exact_build);
      return supportMatrix.value.browsers?.some(browser =>
        browser.family === lane.family
        && browser.exact_build === lane.exact_build
        && browser.platform === boundary?.platform

        && browser.release_supported === true
        && browser.packet_capture_certified === true);
    });
  if (!browserEvidenceComplete) reasons.push("support-matrix-browser-evidence-incomplete");
  return reasons;
}
function soakWorkloadArtifactReasons(report, artifactHashes, config) {
  const toolchain = report?.environment?.adapter_toolchain;
  const valid = validDigest(artifactHashes.soak_workload_server)
    && toolchain?.workload_server_sha256 === artifactHashes.soak_workload_server
    && validDigest(toolchain?.soak_manifest_sha256)
    && validDigest(toolchain?.workload_provenance_schema_sha256)
    && validDigest(toolchain?.workload_provenance_sha256)
    && validDigest(toolchain?.workload_origins_sha256)
    && toolchain?.workload_origin_count === config.soak.origins;
  return valid ? [] : ["soak-workload-artifact-or-origin-provenance-incomplete"];
}
function corpusFrameworkArtifactReasons(report, artifactHashes) {
  return validDigest(artifactHashes.framework_fixtures)
    && report?.manifest?.framework_inventory_sha256 === artifactHashes.framework_fixtures
    ? []
    : ["corpus-framework-fixture-inventory-mismatch"];
}


function soakReportReasons(report, config) {
  const terminal = report?.terminal;
  const plan = report?.plan;
  const planComplete = plan?.short === false
    && plan.duration_ms === config.soak.hours * 3_600_000
    && plan.warmup_ms === config.soak.warmup_minutes * 60_000
    && plan.quiescence_ms === config.soak.quiescence_minutes * 60_000
    && plan.sample_interval_ms === 30_000
    && plan.churn_interval_ms === 60_000
    && plan.fault_interval_ms === 300_000;
  let leakValid = false;
  try {
    const recomputed = evaluateSoakLeakEvidence(report.samples, terminal, config.leak_tolerances.soak);
    leakValid = recomputed.status === "pass" && canonicalJson(recomputed) === canonicalJson(report.leak_evidence);
  } catch {
    leakValid = false;
  }
  const complete = planComplete
    && terminal?.all_terminal
    && terminal.outstanding_requests === 0
    && terminal.active_streams === 0
    && terminal.unrecovered_errors === 0
    && leakValid;
  return complete ? [] : ["soak-terminal-evidence-incomplete"];
}

function corpusSiteEvidenceValid(site) {
  const actionsValid = site.actions?.native?.passed === true
    && site.actions?.mediated?.passed === true
    && site.actions.native.failures?.length === 0
    && site.actions.mediated.failures?.length === 0
    && sameStringSet(site.actions.native.executed, site.actions.mediated.executed)
    && site.actions.native.executed.length > 0;
  const behaviorValid = site.compatibility?.native?.passed === true
    && site.compatibility?.mediated?.passed === true
    && !site.stealth?.deltas?.some(delta => delta.ownership?.status !== "owned");
  if (!actionsValid || !behaviorValid) return false;
  if (site.kind === "live-canary") return site.fixture_category === null && site.fixture_sha256 === null;
  return site.kind === "offline-fixture"
    && REQUIRED_OFFLINE_CORPUS_CATEGORIES.includes(site.fixture_category)
    && site.fixture_evidence?.verified === true
    && site.fixture_evidence.served_from_snapshot === true
    && site.fixture_evidence.tree_sha256 === site.fixture_sha256
    && site.fixture_evidence.asset_count > 0
    && typeof site.fixture_evidence.entry_path === "string";
}

function corpusCoverageValid(report, sites, frameworkFixturesSha256) {
  const offline = sites.filter(site => site.kind === "offline-fixture");
  const live = sites.filter(site => site.kind === "live-canary");
  const categories = offline.map(site => site.fixture_category);
  const evidenceDigest = canonicalDigest(sites.map(site => ({ id: site.id, fixture_evidence: site.fixture_evidence })));
  const remoteFixture = report.manifest?.mediated_fixture_origin;
  const expectedRemoteAssets = offline.reduce((sum, site) => sum + (site.fixture_evidence?.asset_count ?? 0), 0);
  return offline.length === REQUIRED_OFFLINE_CORPUS_CATEGORIES.length
    && sameStringSet(categories, REQUIRED_OFFLINE_CORPUS_CATEGORIES)
    && live.length > 0
    && report.manifest?.site_count === sites.length
    && report.manifest.live_canary_count === live.length
    && sameStringSet(report.manifest.offline_fixture_categories, REQUIRED_OFFLINE_CORPUS_CATEGORIES)
    && report.manifest.fixture_evidence_sha256 === evidenceDigest
    && remoteFixture?.status === "verified"
    && remoteFixture.verified === true
    && remoteFixture.https === true
    && remoteFixture.immutable_cache === true
    && remoteFixture.verified_before_after === true
    && validDigest(remoteFixture.base_url_sha256)
    && validDigest(remoteFixture.asset_evidence_sha256)
    && remoteFixture.asset_count === expectedRemoteAssets
    && validDigest(frameworkFixturesSha256)
    && report.manifest.framework_inventory_sha256 === frameworkFixturesSha256;
}

function corpusReportReasons(report, frameworkFixturesSha256) {
  const sites = report?.sites ?? [];
  const ids = sites.map(site => site.id);
  const valid = report?.environment?.registry_scope_verified === true
    && report?.registry?.verification?.verified === true
    && report.registry.verification.development_only !== true
    && sites.length > 0
    && new Set(ids).size === ids.length
    && sites.every(corpusSiteEvidenceValid)
    && corpusCoverageValid(report, sites, frameworkFixturesSha256);
  return valid ? [] : ["corpus-compatibility-stealth-action-or-fixture-evidence-incomplete"];
}

function gateSpecificReasons(gate, report, config, artifactHashes) {
  if (gate === "performance") return performanceReportReasons(report, config);
  if (gate === "egress") return egressReportReasons(report);
  if (gate === "soak") return soakReportReasons(report, config);
  return gate === "corpus" ? corpusReportReasons(report, artifactHashes.framework_fixtures) : [];
}

function reportEnvironmentMatches(gate, report, config, buildTreeSha256) {
  const browser = report?.environment?.browser;
  const lane = config.browser_lanes.find(candidate =>
    candidate.availability === "available"
      && candidate.family === browser?.family
      && candidate.exact_build === browser?.exact_build);
  const pin = report?.environment?.browser_pin;
  const buildProof = report?.environment?.adapter_toolchain?.build_proof;
  const adapterToolchain = report?.environment?.adapter_toolchain;
  return lane !== undefined
    && pin?.configured_pin === `${lane.family}-${lane.exact_build}`
    && pin.boundary_pin_verified === true
    && pin.binary_sha256_verified === true
    && browser.binary_sha256 === lane.binary_sha256
    && pin.release_supported === true
    && (gate !== "egress" || pin.packet_capture_certified === true)
    && report?.build?.tree_sha256 === buildTreeSha256
    && buildProof?.build_tree_sha256 === buildTreeSha256
    && (gate !== "soak" || validDigest(adapterToolchain?.telemetry_schema_sha256));
}

function reportReasons(gate, report, schemaRecord, verification, config, configSha256, buildTreeSha256, artifactHashes) {
  const reasons = [];
  const schemaResult = schemaRecord?.value ? validateJsonSchema(report, schemaRecord.value) : { valid: false };
  if (!schemaResult.valid) reasons.push(`report-schema-invalid:${gate}`);
  if (report?.release?.release_id !== config.release_id
    || report?.release?.performance_config_sha256 !== configSha256
    || report?.release?.build_tree_sha256 !== buildTreeSha256)
    reasons.push(`report-release-tuple-invalid:${gate}`);
  if (!reportEnvironmentMatches(gate, report, config, buildTreeSha256))
    reasons.push(`report-environment-invalid:${gate}`);
  if (report?.status !== "pass" || report?.test_mode !== false)
    reasons.push(`report-not-production-pass:${gate}`);
  if (report?.certification?.claimed !== true)
    reasons.push(`report-certification-claim-missing:${gate}`);
  if (verification?.verified !== true || verification.key_epoch == null)
    reasons.push(`report-detached-signature-unverified:${gate}`);
  else if (verification.development_only === true)
    reasons.push(`report-development-signature:${gate}`);
  reasons.push(...gateSpecificReasons(gate, report, config, artifactHashes));
  return reasons;
}

function gateReportRecord(report, schemaRecord, verification) {
  return {
    report_sha256: report ? canonicalDigest(report) : null,
    report_schema_sha256: schemaRecord?.sha256 ?? null,
    signature_sha256: verification?.signature_sha256 ?? null,
    signature_key_epoch: verification?.key_epoch ?? null,
    signature_roles: verification?.verified_roles ?? [],
    schema_version: report?.schema_version ?? null,
    status: report?.status ?? "missing",
    test_mode: report?.test_mode ?? true,
  };
}

function collectGateReportEvidence({ reports, reportHashes, reportVerifications, reportSchemas, config, configSha256, buildTreeSha256, artifactHashes }) {
  const reasons = [];
  const records = {};
  for (const gate of GATES) {
    const report = reports[gate];
    const verification = reportVerifications[gate] ?? null;
    reasons.push(...reportReasons(gate, report, reportSchemas[gate], verification, config, configSha256, buildTreeSha256, artifactHashes));
    const record = gateReportRecord(report, reportSchemas[gate], verification);
    if (reportHashes[gate] && reportHashes[gate] !== record.report_sha256) reasons.push(`report-hash-mismatch:${gate}`);
    records[gate] = record;
  }
  return { reasons, records };
}

function releaseTupleValue({ config, configSha256, configSchemaSha256, manifestSchema, supportMatrix, supportMatrixSchema, buildTreeSha256, signingKeys, artifactHashes, artifactVerification }) {
  return {
    performance_config_version: config.schema_version,
    performance_config_sha256: configSha256,
    performance_schema_sha256: configSchemaSha256,
    release_manifest_schema_sha256: manifestSchema?.sha256 ?? null,
    support_matrix_sha256: supportMatrix?.sha256 ?? null,
    support_matrix_schema_sha256: supportMatrixSchema?.sha256 ?? null,
    performance_policy_version: `${config.schema_version}:${config.pair_order}:${config.bootstrap_resamples}`,
    build_tree_sha256: validDigest(buildTreeSha256) ? buildTreeSha256 : null,
    signing_key_epoch: signingKeys?.key_epoch ?? null,
    ci_workflow_sha256: artifactHashes.ci_workflow ?? null,
    framework_fixtures_sha256: artifactHashes.framework_fixtures ?? null,
    framework_fixtures_schema_sha256: artifactHashes.framework_fixtures_schema ?? null,
    soak_workload_server_sha256: artifactHashes.soak_workload_server ?? null,
    v1_baseline_sha256: artifactHashes.v1_baseline ?? null,
    v1_evidence_manifest_sha256: artifactHashes.v1_evidence_manifest ?? null,
    artifact_hashes_sha256: validDigest(artifactVerification?.artifact_hashes_sha256) ? artifactVerification.artifact_hashes_sha256 : null,
    artifact_statement_sha256: artifactVerification?.statement_sha256 ?? null,
    artifact_schema_sha256: artifactVerification?.schema_sha256 ?? null,
    artifact_signature_sha256: artifactVerification?.signature_sha256 ?? null,
    artifact_signature_key_epoch: artifactVerification?.key_epoch ?? null,
  };
}

function artifactDigestReasons(artifactHashes) {
  return REQUIRED_ARTIFACTS
    .filter(artifact => !validDigest(artifactHashes[artifact]))
    .map(artifact => `artifact-hash-missing:${artifact}`);
}
function performanceConfigSchemaReasons(config, configSchema, expectedSha256) {
  if (!configSchema?.value || configSchema.sha256 !== expectedSha256)
    return ["performance-config-schema-unavailable"];
  return validateJsonSchema(config, configSchema.value).valid ? [] : ["performance-config-schema-invalid"];
}


export function buildReleaseManifest({
  config,
  configSha256,
  configSchemaSha256,
  configSchema = null,
  browserBoundary,
  supportMatrix = null,
  supportMatrixSchema = null,
  reports,
  reportHashes = {},
  reportVerifications = {},
  reportSchemas = {},
  artifactHashes = {},
  artifactVerification = null,
  manifestSchema = null,
  signingKeys = null,
  now = () => new Date(),
}) {
  invariant(reports, "release manifest requires all gate reports");
  invariant(validDigest(configSha256) && validDigest(configSchemaSha256), "release policy digests are required");
  const buildTreeSha256 = reports.performance?.release?.build_tree_sha256;
  const gateEvidence = collectGateReportEvidence({
    reports, reportHashes, reportVerifications, reportSchemas, config, configSha256, buildTreeSha256, artifactHashes,
  });
  const reasons = [
    ...policyReasons(config, browserBoundary),
    ...signingPolicyReasons(signingKeys),
    ...artifactPolicyReasons(artifactVerification, artifactHashes, configSha256, buildTreeSha256),
    ...artifactDigestReasons(artifactHashes),
    ...gateEvidence.reasons,
    ...performanceConfigSchemaReasons(config, configSchema, configSchemaSha256),
    ...supportMatrixReasons({ supportMatrix, supportMatrixSchema, artifactHashes, egressReport: reports.egress, config, browserBoundary }),
    ...soakWorkloadArtifactReasons(reports.soak, artifactHashes, config),
    ...corpusFrameworkArtifactReasons(reports.corpus, artifactHashes),
  ];
  if (!validDigest(manifestSchema?.sha256)) reasons.push("release-manifest-schema-unavailable");
  if (!validDigest(buildTreeSha256)) reasons.push("build-tree-identity-missing");
  const generated = now();
  invariant(generated instanceof Date && !Number.isNaN(generated.valueOf()), "release manifest clock must return a valid Date");
  const ineligibilityReasons = [...new Set(reasons)].sort();
  return {
    schema_version: 1,
    manifest_type: "release-cutover-gate",
    release_id: config.release_id,
    generated_at: generated.toISOString(),
    release_tuple: releaseTupleValue({
      config, configSha256, configSchemaSha256, manifestSchema, supportMatrix, supportMatrixSchema, buildTreeSha256, signingKeys, artifactHashes, artifactVerification,
    }),
    gate_reports: gateEvidence.records,
    artifact_hashes: artifactHashes,
    signature_required: true,
    production_eligible: ineligibilityReasons.length === 0,
    ineligibility_reasons: ineligibilityReasons,
  };
}

export async function verifyReleaseManifest({
  manifest,
  manifestSignatures,
  signingKeys,
  config,
  configSha256,
  configSchemaSha256,
  configSchema,
  supportMatrix,
  supportMatrixSchema,
  browserBoundary,
  reports,
  reportHashes,
  reportVerifications,
  reportSchemas,
  manifestSchema,
  artifactHashes = {},
  artifactVerification,
}) {
  const expected = buildReleaseManifest({
    config,
    configSha256,
    configSchemaSha256,
    configSchema,
    browserBoundary,
    supportMatrix,
    supportMatrixSchema,
    reports,
    reportHashes,
    reportVerifications,
    reportSchemas,
    manifestSchema,
    artifactHashes,
    artifactVerification,
    signingKeys,
    now: () => new Date(manifest.generated_at),
  });
  invariant(canonicalJson(manifest) === canonicalJson(expected), "release manifest is not the atomic canonical tuple of supplied policy and reports", "release_manifest_invalid");
  const manifestSchemaResult = manifestSchema?.value ? validateJsonSchema(manifest, manifestSchema.value) : { valid: false };
  invariant(manifestSchemaResult.valid, `release manifest schema validation failed: ${manifestSchemaResult.errors?.join("; ") ?? "schema unavailable"}`, "release_manifest_schema_invalid");
  const verification = verifyCanonicalThresholdSignature({
    value: manifest,
    signatures: manifestSignatures,
    keys: signingKeys,
    label: "release manifest",
    code: "release_manifest_signature_unverified",
  });
  invariant(verification.development_only !== true, "development-only signatures cannot certify a production release", "release_manifest_signature_unverified");
  invariant(manifest.production_eligible === true && manifest.ineligibility_reasons.length === 0, "release manifest has unmet production gates", "release_manifest_ineligible");
  return Object.freeze({ production_eligible: true, ineligibility_reasons: [], signature_verification: verification });
}

function releaseCLIArguments(argv) {
  return parseArgs(argv, {
    flags: ["help"],
    values: [
      "config", "schema", "boundary", "support-matrix", "support-matrix-schema", "keys", "artifacts", "artifacts-signature", "manifest", "manifest-signature", "output",
      ...GATES.flatMap(gate => [`${gate}-report`, `${gate}-signature`]),
    ],
  });
}

async function loadGateEvidence(args) {
  const reports = {};
  const reportHashes = {};
  const signatures = {};
  for (const gate of GATES) {
    invariant(args[`${gate}-report`], `--${gate}-report is required`, "invalid_cli");
    invariant(args[`${gate}-signature`], `--${gate}-signature is required`, "invalid_cli");
    const loaded = await readJson(args[`${gate}-report`]);
    reports[gate] = loaded.value;
    reportHashes[gate] = canonicalDigest(loaded.value);
    signatures[gate] = (await readJson(args[`${gate}-signature`])).value;
  }
  return { reports, reportHashes, signatures };
}

async function loadReportSchemas(base) {
  const schemas = {};
  for (const gate of GATES)
    schemas[gate] = await readJson(path.resolve(base, `../../protocol/${gate}-report.schema.json`));
  return schemas;
}

async function loadArtifactEvidence({ statementPath, signaturePath, base, config, configSha256, buildTreeSha256, signingKeys, artifactSchema }) {
  invariant(statementPath, "--artifacts is required", "invalid_cli");
  invariant(signaturePath, "--artifacts-signature is required", "invalid_cli");
  const statement = (await readJson(statementPath)).value;
  const schemaResult = validateJsonSchema(statement, artifactSchema.value);
  invariant(schemaResult.valid, `artifact statement schema validation failed: ${schemaResult.errors.join("; ")}`, "artifact_evidence_invalid");
  invariant(
    statement?.schema_version === 1
      && statement.release_id === config.release_id
      && statement.performance_config_sha256 === configSha256
      && statement.build_tree_sha256 === buildTreeSha256
      && statement.artifact_hashes
      && typeof statement.artifact_hashes === "object"
      && !Array.isArray(statement.artifact_hashes),
    "artifact statement is malformed or belongs to another release",
    "artifact_evidence_invalid",
  );
  const signatures = (await readJson(signaturePath)).value;
  const verification = verifyCanonicalThresholdSignature({
    value: statement,
    signatures,
    keys: signingKeys,
    label: "release artifact statement",
    code: "artifact_evidence_signature_invalid",
  });
  const currentCI = sha256(await readFile(path.resolve(base, "../../.github/workflows/ci.yml")));
  invariant(statement.artifact_hashes.ci_workflow === currentCI, "ci_workflow artifact digest does not match the current workflow", "artifact_hash_mismatch");
  const frameworkFixtures = await readJson(path.resolve(base, "../../test/frameworks/manifest.json"));
  const frameworkFixturesSchema = await readJson(path.resolve(base, "../../protocol/framework-fixtures.schema.json"));
  const frameworkFixturesValidation = validateJsonSchema(frameworkFixtures.value, frameworkFixturesSchema.value);
  invariant(frameworkFixturesValidation.valid, `framework fixture inventory schema validation failed: ${frameworkFixturesValidation.errors.join("; ")}`, "artifact_hash_mismatch");
  invariant(statement.artifact_hashes.framework_fixtures === frameworkFixtures.sha256, "framework_fixtures artifact digest does not match the current deterministic inventory", "artifact_hash_mismatch");
  invariant(statement.artifact_hashes.framework_fixtures_schema === frameworkFixturesSchema.sha256, "framework_fixtures_schema artifact digest does not match the current schema", "artifact_hash_mismatch");
  const v1Baseline = await readJson(path.resolve(base, "../../protocol/v1-baseline.json"));
  const v1BaselineSchema = await readJson(path.resolve(base, "../../protocol/v1-baseline.schema.json"));
  const v1BaselineValidation = validateJsonSchema(v1Baseline.value, v1BaselineSchema.value);
  invariant(v1BaselineValidation.valid, `V1 baseline schema validation failed: ${v1BaselineValidation.errors.join("; ")}`, "artifact_hash_mismatch");
  const v1EvidenceManifest = await readJson(path.resolve(base, "../../evidence/2.0.0/v1/raw-manifest.json"));
  invariant(v1Baseline.value.evidence_merkle.root === v1EvidenceManifest.value.merkle_root, "V1 baseline and raw evidence Merkle roots differ", "artifact_hash_mismatch");
  invariant(statement.artifact_hashes.v1_baseline === v1Baseline.sha256, "v1_baseline artifact digest does not match the frozen baseline", "artifact_hash_mismatch");
  invariant(statement.artifact_hashes.v1_evidence_manifest === v1EvidenceManifest.sha256, "v1_evidence_manifest artifact digest does not match the recoverable raw manifest", "artifact_hash_mismatch");
  return {
    artifactHashes: statement.artifact_hashes,
    artifactVerification: Object.freeze({
      ...verification,
      statement_sha256: canonicalDigest(statement),
      signature_sha256: canonicalDigest(signatures),
      schema_sha256: artifactSchema.sha256,
      performance_config_sha256: statement.performance_config_sha256,
      build_tree_sha256: statement.build_tree_sha256,
      artifact_hashes_sha256: canonicalDigest(statement.artifact_hashes),
    }),
  };
}

function releaseUsage() {
  return "Usage: node scripts/gates/release-manifest.mjs --keys <keys.json> --artifacts <statement.json> --artifacts-signature <file> --performance-report <file> --performance-signature <file> --egress-report <file> --egress-signature <file> --soak-report <file> --soak-signature <file> --corpus-report <file> --corpus-signature <file> (--output <unsigned-manifest> | --manifest <signed-manifest> --manifest-signature <file>)\n";
}

async function main() {
  const args = releaseCLIArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(releaseUsage());
    return;
  }
  const base = moduleDirectory(import.meta.url);
  const configPath = args.config ?? path.resolve(base, "../../protocol/performance-gates.json");
  const schemaPath = args.schema ?? path.resolve(base, "../../protocol/performance-gates.schema.json");
  const { config, configSha256, configSchema: schema } = await loadPerformanceConfig(configPath, { schemaPath });
  const manifestSchema = await readJson(path.resolve(base, "../../protocol/release-cutover-manifest.schema.json"));
  const artifactSchema = await readJson(path.resolve(base, "../../protocol/release-artifact-manifest.schema.json"));
  const browserBoundary = await loadBrowserBoundaries(args.boundary ?? path.resolve(base, "../../protocol/browser-boundaries.json"));
  const supportMatrix = await readJson(args["support-matrix"] ?? path.resolve(base, "../../protocol/support-matrix.json"));
  const supportMatrixSchema = await readJson(args["support-matrix-schema"] ?? path.resolve(base, "../../protocol/support-matrix.schema.json"));
  const signingKeys = (await readJson(args.keys ?? path.resolve(base, "../../protocol/release-signing-keys.json"))).value;
  const { reports, reportHashes, signatures } = await loadGateEvidence(args);
  const reportSchemas = await loadReportSchemas(base);
  const reportVerifications = verifyGateReportSignatures({ reports, signatures, keys: signingKeys });
  const buildTreeSha256 = reports.performance?.release?.build_tree_sha256;
  const { artifactHashes, artifactVerification } = await loadArtifactEvidence({ statementPath: args.artifacts, signaturePath: args["artifacts-signature"], base, config, configSha256, buildTreeSha256, signingKeys, artifactSchema });
  const input = {
    config,
    configSha256,
    configSchemaSha256: schema.sha256,
    configSchema: schema,
    browserBoundary,
    reports,
    supportMatrix,
    supportMatrixSchema,
    reportHashes,
    reportSchemas,
    reportVerifications,
    artifactHashes,
    artifactVerification,
    manifestSchema,
    signingKeys,
  };
  if (args.manifest) {
    invariant(args["manifest-signature"], "--manifest-signature is required with --manifest", "invalid_cli");
    const manifest = (await readJson(args.manifest)).value;
    const manifestSignatures = (await readJson(args["manifest-signature"])).value;
    const result = await verifyReleaseManifest({ ...input, manifest, manifestSignatures });
    process.stdout.write(canonicalJson({ manifest: args.manifest, ...result }));
    return;
  }
  invariant(args.output, "--output is required when building a release manifest", "invalid_cli");
  const manifest = buildReleaseManifest(input);
  const output = await writeCanonicalReport(args.output, manifest);
  process.stdout.write(canonicalJson({
    output,
    evidence_eligible: manifest.production_eligible,
    production_eligible: false,
    detached_signature_required: true,
    ineligibility_reasons: manifest.ineligibility_reasons,
  }));
  process.exitCode = 1;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) main().catch(error => { process.stderr.write(`release manifest failed: ${error.message}\n`); process.exitCode = 1; });
