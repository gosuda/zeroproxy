import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bootstrapPairedMeanCI,
  canonicalDigest,
  canonicalJson,
  collectBuildIdentity,
  GateFailure,
  loadPerformanceConfig,
  nearestRank,
  productionCertification,
  readJson,
  reportCommandSummary,
  runtimeIdentity,
  sha256,
  validateJsonSchema,
  verifyCanonicalThresholdSignature,
  writeCanonicalReport,
} from "../../scripts/gates/common.mjs";
import { REQUIRED_OFFLINE_CORPUS_CATEGORIES, runCorpusGate, verifyDeltaRegistrySignature } from "../../scripts/gates/corpus.mjs";
import { runEgressGate } from "../../scripts/gates/egress.mjs";
import { evaluateV1AggregateEvidence, runPerformanceGate } from "../../scripts/gates/performance.mjs";
import { buildReleaseManifest, verifyGateReportSignatures, verifyReleaseManifest } from "../../scripts/gates/release-manifest.mjs";
import { evaluateSoakLeakEvidence, runSoakGate } from "../../scripts/gates/soak.mjs";

const FIXED_NOW = () => new Date("2026-07-11T12:00:00.000Z");
const ARTIFACT_NAMES = ["server", "control", "service_worker", "kernel", "rust", "runtime", "messages", "carrier", "support_matrix", "framework_fixtures", "framework_fixtures_schema", "soak_workload_server", "compatibility_deltas", "migration_disposition", "v1_baseline", "v1_evidence_manifest", "standards_lock", "build_assets", "ci_workflow"];

function signingFixture() {
  const roles = ["release", "security"];
  const pairs = roles.map((role, index) => {
    const pair = generateKeyPairSync("ed25519");
    const der = pair.publicKey.export({ format: "der", type: "spki" });
    return {
      id: `${role}-${index}`,
      role,
      owner: `${role}-owner-${index}`,
      privateKey: pair.privateKey,
      public_key: der.subarray(der.byteLength - 32).toString("base64url"),
    };
  });
  const keys = {
    schema_version: 1,
    key_epoch: 7,
    threshold: 2,
    development_only: false,
    keys: pairs.map(({ id, owner, role, public_key }) => ({ id, owner, role, public_key })),
  };
  return {
    keys,
    sign(value) {
      const bytes = Buffer.from(canonicalJson(value).slice(0, -1), "utf8");
      return {
        algorithm: "Ed25519",
        canonicalization: "RFC8785",
        key_epoch: keys.key_epoch,
        development_only: false,
        signatures: pairs.map(pair => ({
          key_id: pair.id,
          signature: sign(null, bytes, pair.privateKey).toString("base64url"),
        })),
      };
    },
  };
}

function productionConfig({ fixturesAvailable = true, packetCertified = true } = {}) {
  const base = testConfig();
  return {
    ...base,
    schema_version: 2,
    pair_order: "alternating-native-mediated",
    reference_platform: {
      os: runtimeIdentity().os,
      arch: runtimeIdentity().architecture,
      hardware: {
        availability: "available",
        machine_model: "test-machine",
        cpu_model: "test-cpu",
        memory_bytes: 8_589_934_592,
      },
    },
    toolchains_sha256: "1".repeat(64),
    browser_boundaries_sha256: "2".repeat(64),
    browser_lanes: [
      {
        family: "chromium",
        exact_build: "1.0.0",
        product_build_id: "chromium-test-build",
        platform: "darwin-arm64",
        archive_url: "https://fixtures.example/chromium.zip",
        archive_sha256: "3".repeat(64),
        binary_path: "fixtures/chromium",
        binary_sha256: "4".repeat(64),
        availability: "available",
      },
      {
        family: "firefox",
        exact_build: "1.0.0",
        product_build_id: "firefox-test-build",
        platform: "darwin-arm64",
        archive_url: "https://fixtures.example/firefox.dmg",
        archive_sha256: "5".repeat(64),
        binary_path: "fixtures/firefox",
        binary_sha256: "6".repeat(64),
        availability: "available",
      },
    ],
    deferred_browser_families: [],
    fixtures: Array.from({ length: 15 }, (_, index) => ({
      id: `fixture-${index}`,
      site_class: ["content", "application", "editor_media_pwa"][Math.floor(index / 5)],
      availability: fixturesAvailable ? "available" : "unavailable",
      sha256: fixturesAvailable ? "3".repeat(64) : null,
      v1_baseline: { dcl_delta: 0.2, lcp_delta: 0.2, cpu_delta: 0.2 },
    })),
    v1_aggregate: {
      metrics: ["dcl_delta", "lcp_delta", "cpu_delta"],
      geometric_mean_overhead_reduction_min: 0.3,
      non_worse_fixture_fraction_min: 0.8,
      class_p95_regression_max: 0.05,
      zero_baseline_policy: "must-remain-zero",
    },
    leak_tolerances: {
      performance: { memory_growth_bytes: 1024, queue_growth: 0 },
      soak: {
        closed_counts_must_be_zero: ["route", "port", "stream", "worker", "realm"],
        fd_growth_max: 2,
        goroutine_growth_max: 2,
        fd_slope_per_hour_max: 0.25,
        goroutine_slope_per_hour_max: 0.25,
        rss_growth_relative_max: 0.05,
        rss_growth_bytes_floor: 33_554_432,
        rss_slope_bytes_per_hour_max: 2_097_152,
        no_post_stop_monotonic_growth: true,
      },
    },
    packet_capture: {
      backend: "tcpdump",
      interface: "test0",
      availability: packetCertified ? "available" : "unavailable",
      privilege: packetCertified ? "available" : "unavailable",
      reason: packetCertified ? "certified-test-capture" : "test-capture-unavailable",
      certified: packetCertified,
    },
  };
}

function productionBoundary({ releaseSupported = true, packetCertified = true } = {}) {
  return {
    browser_lanes: ["chromium", "firefox"].map(family => ({
      family,
      exact_build: "1.0.0",
      platform: `${process.platform}-${process.arch}`,
      release_supported: releaseSupported,
      packet_capture_certified: packetCertified,
    })),
  };
}

async function buildIdentity(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeroproxy-release-gate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "runtime.js"), "export const build = 'current';\n", "utf8");
  await writeFile(path.join(directory, "runtime.wasm"), Buffer.from([0, 97, 115, 109]));
  return { directory, build: await collectBuildIdentity(directory) };
}

function testConfig({ measuredPairs = 4, bootstrapResamples = 10_000, gates = null, soakLimits = true } = {}) {
  const runtime = runtimeIdentity();
  return {
    schema_version: 1,
    release_id: "release-gate-test",
    reference_platform: {
      os: runtime.os,
      arch: runtime.architecture,
      browser_builds: ["test-browser-1.0.0"],
    },
    warmups: 1,
    measured_pairs: measuredPairs,
    bootstrap_resamples: bootstrapResamples,
    max_cv: 0.1,
    gates: gates ?? {
      application_p95_ms: 5,
      content_p95_ms: 5,
      editor_p95_ms: 5,
    },
    site_classes: {
      content: { dcl_delta: 0.1, lcp_delta: 0.1, inp_delta_ms: 5, cpu_delta: 0.1 },
      application: { dcl_delta: 0.1, lcp_delta: 0.1, inp_delta_ms: 5, cpu_delta: 0.1 },
      editor_media_pwa: { dcl_delta: 0.1, lcp_delta: 0.1, inp_delta_ms: 5, cpu_delta: 0.1 },
    },
    soak: {
      hours: 8,
      warmup_minutes: 30,
      quiescence_minutes: 15,
      origins: 20,
      clients: 40,
      short_streams: 200,
      sse_streams: 20,
      websockets: 20,
      navigations_per_origin_per_minute: 2,
      abort_churn: 0.1,
      ...(soakLimits ? { max_memory_bytes: 1024, max_queue_depth: 8 } : {}),
    },
  };
}

function measuredFixtureEvidence(fixtureSha256 = "a".repeat(64)) {
  return {
    fixture_sha256: fixtureSha256,
    fixture_evidence: { status: "verified", verified: true, tree_sha256: fixtureSha256, asset_count: 1, served_from_snapshot: true, entry_path: "index.html" },
  };
}

const performanceScenarios = [
  { id: "content", gate: "content_p95_ms", site_class: "content", ...measuredFixtureEvidence() },
  { id: "application", gate: "application_p95_ms", site_class: "application", ...measuredFixtureEvidence() },
  { id: "editor", gate: "editor_p95_ms", site_class: "editor_media_pwa", ...measuredFixtureEvidence() },
];

function performanceAdapter({ values = [1, 1, 1, 1], memoryBytes = 256, fixtures = [] } = {}) {
  const calls = [];
  return {
    calls,
    closed: false,
    async describe() {
      return {
        browser: { family: "test-browser", exact_build: "1.0.0", binary_sha256: "2".repeat(64) },
        resource_limits: { max_memory_bytes: 1024, max_queue_depth: 8 },
        toolchain: { adapter: "release-test" },
      };
    },
    async enumerateScenarios() {
      return [
        ...performanceScenarios,
        ...fixtures.map(fixture => ({ id: `fixture:${fixture.id}`, kind: "fixture", fixture_id: fixture.id, site_class: fixture.site_class, ...measuredFixtureEvidence(fixture.sha256) })),
      ];
    },
    async measurePair({ phase, iteration, order }) {
      calls.push({ phase, iteration, order });
      const mediatedValue = values[iteration % values.length];
      const siteMetrics = { dcl_ms: 100, lcp_ms: 120, inp_ms: 10, cpu_ms: 20 };
      return {
        native: { value: 1, memory_bytes: 128, queue_depth: 1, site_metrics: siteMetrics },
        mediated: { value: mediatedValue, memory_bytes: memoryBytes, queue_depth: 1, site_metrics: siteMetrics },
      };
    },
    async close() { this.closed = true; },
  };
}

test("performance gate enforces p95 threshold, warmups, paired samples, and 10,000-resample CI", async t => {
  const { build } = await buildIdentity(t);
  const adapter = performanceAdapter({ values: [1, 1, 1, 6] });
  const report = await runPerformanceGate({ config: testConfig(), build, adapter, testMode: true, now: FIXED_NOW });

  assert.equal(report.status, "invalid");
  assert.equal(report.measurement.bootstrap_resamples, 10_000);
  assert.equal(adapter.calls.filter(call => call.phase === "warmup").length, 3);
  assert.equal(adapter.calls.filter(call => call.phase === "measured").length, 12);
  assert.equal(report.scenarios.every(scenario => scenario.sample_count === 4 && scenario.pairs.length === 4), true);
  assert.equal(report.violations.some(violation => violation.code === "performance_threshold_exceeded"), true);
  assert.equal(report.scenarios.every(scenario => Number.isFinite(scenario.value.paired_mean_delta_ci.upper) && scenario.value.native.p99 >= scenario.value.native.p95), true);
  assert.equal(report.invalidations.some(invalidation => invalidation.code === "sample_cv_exceeded"), true);
  assert.deepEqual(adapter.calls.filter(call => call.phase === "measured").map(call => call.order), ["mediated-first", "native-first", "mediated-first", "native-first", "mediated-first", "native-first", "mediated-first", "native-first", "mediated-first", "native-first", "mediated-first", "native-first"]);
  assert.equal(report.certification.claimed, false);
  assert.equal(adapter.closed, true);
  const invalidAdapter = performanceAdapter();
  const enumerate = invalidAdapter.enumerateScenarios.bind(invalidAdapter);
  invalidAdapter.enumerateScenarios = async () => {
    const scenarios = await enumerate();
    return scenarios.map((scenario, index) => index === 0 ? { ...scenario, fixture_evidence: { ...scenario.fixture_evidence, tree_sha256: "b".repeat(64) } } : scenario);
  };
  await assert.rejects(
    runPerformanceGate({ config: testConfig(), build, adapter: invalidAdapter, testMode: true, now: FIXED_NOW }),
    error => error instanceof GateFailure && error.code === "adapter_invalid",
  );
  assert.equal(invalidAdapter.closed, true);
});

test("minimum throughput gates evaluate the configured lower tail", async t => {
  const { build } = await buildIdentity(t);
  const adapter = performanceAdapter({ values: [1, 100, 100, 100] });
  adapter.enumerateScenarios = async () => [
    { id: "throughput", gate: "html_throughput_mib_s", site_class: "content", ...measuredFixtureEvidence() },
    { id: "application", gate: "application_p95_ms", site_class: "application", ...measuredFixtureEvidence() },
    { id: "editor", gate: "editor_p95_ms", site_class: "editor_media_pwa", ...measuredFixtureEvidence() },
  ];
  const config = {
    ...testConfig({ gates: { html_throughput_mib_s: 50, application_p95_ms: 200, editor_p95_ms: 200 } }),
    aggregation: { threshold_percentile: 0.95 },
    variance: { max_cv: 10 },
  };
  const report = await runPerformanceGate({ config, build, adapter, testMode: true, now: FIXED_NOW });
  const scenario = report.scenarios.find(candidate => candidate.gate === "html_throughput_mib_s");
  assert.ok(Math.abs(scenario.threshold.percentile - 0.05) < Number.EPSILON);
  assert.equal(scenario.value.mediated_percentile, 1);
  assert.equal(report.violations.some(violation =>
    violation.code === "performance_threshold_exceeded"
    && violation.gate === "html_throughput_mib_s"
    && violation.observed === 1), true);
});

test("percentile and paired bootstrap CI are deterministic", () => {
  assert.equal(nearestRank([1, 2, 3, 4], 0.95), 4);
  const pairs = [
    { native: 10, mediated: 11 },
    { native: 10, mediated: 13 },
    { native: 10, mediated: 15 },
  ];
  const first = bootstrapPairedMeanCI(pairs, 10_000, "bootstrap-test-seed");
  const second = bootstrapPairedMeanCI(pairs, 10_000, "bootstrap-test-seed");
  assert.deepEqual(first, second);
  assert.equal(first.resamples, 10_000);
  assert.ok(first.lower <= first.upper);
});

test("performance gate detects memory-bound leak observations", async t => {
  const { build } = await buildIdentity(t);
  const report = await runPerformanceGate({
    config: testConfig(),
    build,
    adapter: performanceAdapter({ memoryBytes: 1025 }),
    testMode: true,
    now: FIXED_NOW,
  });
  assert.equal(report.status, "fail");
  assert.equal(report.violations.some(violation => violation.code === "memory_limit_exceeded"), true);
});
test("production certification requires a passing release-supported browser and all prerequisites", () => {
  const supported = { boundary_pin_verified: true, release_supported: true };
  assert.equal(productionCertification({ testMode: false, status: "pass", browserPin: supported, prerequisites: [true] }).claimed, true);
  assert.equal(productionCertification({ testMode: true, status: "pass", browserPin: supported, prerequisites: [true] }).claimed, false);
  assert.equal(productionCertification({ testMode: false, status: "fail", browserPin: supported, prerequisites: [true] }).claimed, false);
  assert.equal(productionCertification({ testMode: false, status: "pass", browserPin: { ...supported, release_supported: false }, prerequisites: [true] }).claimed, false);
  assert.equal(productionCertification({ testMode: false, status: "pass", browserPin: supported, prerequisites: [false] }).claimed, false);
  const summary = reportCommandSummary("/tmp/report.json", { status: "pass", certification: { claimed: true } });
  assert.deepEqual(summary, { report: "/tmp/report.json", status: "pass", certification_claimed: true });
});

test("performance certification requires available content-addressed fixtures", async t => {
  const { build } = await buildIdentity(t);
  const availableConfig = productionConfig();
  const available = await runPerformanceGate({
    config: availableConfig,
    browserBoundary: productionBoundary(),
    build,
    adapter: performanceAdapter({ fixtures: availableConfig.fixtures }),
    now: FIXED_NOW,
  });
  assert.equal(available.status, "pass");
  assert.equal(available.certification.claimed, true);
  assert.equal(available.v1_aggregate.status, "pass");
  assert.equal(available.v1_aggregate.fixture_count, 15);
  const zeroConfig = productionConfig();
  zeroConfig.fixtures[0].v1_baseline = { dcl_delta: 0, lcp_delta: 0, cpu_delta: 0 };
  const zero = await runPerformanceGate({
    config: zeroConfig,
    browserBoundary: productionBoundary(),
    build,
    adapter: performanceAdapter({ fixtures: zeroConfig.fixtures }),
    now: FIXED_NOW,
  });
  assert.equal(zero.status, "pass");
  assert.deepEqual(zero.fixtures.find(fixture => fixture.fixture_id === zeroConfig.fixtures[0].id).v1_comparison, {
    dcl_delta: { baseline: 0, current: 0, regression: 0 },
    lcp_delta: { baseline: 0, current: 0, regression: 0 },
    cpu_delta: { baseline: 0, current: 0, regression: 0 },
  });
  const unavailableConfig = productionConfig({ fixturesAvailable: false });
  const unavailable = await runPerformanceGate({
    config: unavailableConfig,
    browserBoundary: productionBoundary(),
    build,
    adapter: performanceAdapter(),
    now: FIXED_NOW,
  });
  assert.equal(unavailable.status, "pass");
  assert.equal(unavailable.certification.claimed, false);
  assert.equal(unavailable.v1_aggregate.status, "not-measured");
});

test("zero V1 overhead is an explicit must-remain-zero baseline", () => {
  const config = productionConfig();
  config.fixtures[0].v1_baseline = { dcl_delta: 0, lcp_delta: 0, cpu_delta: 0 };
  config.v1_aggregate = {
    ...config.v1_aggregate,
    geometric_mean_overhead_reduction_min: 0,
    non_worse_fixture_fraction_min: 1,
  };
  const report = mediatedValue => [{
    fixture_id: config.fixtures[0].id,
    site_class: config.fixtures[0].site_class,
    pairs: Array.from({ length: 30 }, () => ({
      native: { site_metrics: { dcl_ms: 100, lcp_ms: 100, cpu_ms: 100 } },
      mediated: { site_metrics: { dcl_ms: mediatedValue, lcp_ms: mediatedValue, cpu_ms: mediatedValue } },
    })),
  }];
  const stableViolations = [];
  assert.equal(evaluateV1AggregateEvidence(report(100), config, stableViolations).status, "pass");
  assert.deepEqual(stableViolations, []);
  const regressedViolations = [];
  assert.equal(evaluateV1AggregateEvidence(report(110), config, regressedViolations).status, "fail");
  assert.equal(regressedViolations.filter(violation => violation.code === "v1_zero_baseline_regressed").length, 3);
});

test("egress gate fails closed before execution when packet capture is unavailable", async t => {
  const { directory, build } = await buildIdentity(t);
  const unavailable = new GateFailure("test capture unavailable", "capture_unavailable");
  await assert.rejects(
    runEgressGate({
      config: testConfig(),
      manifest: { schema_version: 1, release_id: "release-gate-test", scenarios: [{ id: "canary", surfaces: ["fetch"], url: "https://runtime.test/canary", target: { host: "target.test", ports: [443] }, allowed_dns: [], expected_assertions: ["surface:fetch"], settle_ms: 500 }] },
      supportMatrix: { schema_version: 1, release_id: "release-gate-test", egress_surfaces: ["fetch"], browsers: [{ family: "test-browser", exact_build: "1.0.0", platform: `${process.platform}-${process.arch}`, release_supported: false, packet_capture_certified: false }] },
      build,
      adapter: {
        async describe() { return { browser: { family: "test-browser", exact_build: "1.0.0", binary_sha256: "2".repeat(64) } }; },
        async executeScenario() { throw new Error("scenario must not execute without capture"); },
      },
      captureBackend: {
        async preflight() { throw unavailable; },
        async start() { throw new Error("capture must not start"); },
        async stop() { throw new Error("capture must not stop"); },
      },
      captureDir: directory,
      interfaceName: "test0",
      testMode: true,
    }),
    error => error === unavailable,
  );
});

test("egress gate records and rejects a direct target packet flow", async t => {
  const { directory, build } = await buildIdentity(t);
  const targetIp = "203.0.113.11";
  const report = await runEgressGate({
    config: testConfig(),
    manifest: { schema_version: 1, release_id: "release-gate-test", scenarios: [{ id: "canary", surfaces: ["fetch"], url: "https://runtime.test/canary", target: { host: "target.test", ports: [443] }, allowed_dns: ["proxy.test"], expected_assertions: ["surface:fetch"], settle_ms: 500 }] },
    supportMatrix: { schema_version: 1, release_id: "release-gate-test", egress_surfaces: ["fetch"], browsers: [{ family: "test-browser", exact_build: "1.0.0", platform: `${process.platform}-${process.arch}`, release_supported: false, packet_capture_certified: false }] },
    build,
    adapter: {
      async describe() { return { browser: { family: "test-browser", exact_build: "1.0.0", binary_sha256: "2".repeat(64) } }; },
      async executeScenario() { return { status: "completed", details: { exercised: true } }; },
    },
    captureBackend: {
      async preflight() { return { executable: "test-capture", version: "1" }; },
      async start() { return { id: "capture" }; },
      async stop() {
        return {
          pcap_path: path.join(directory, "canary.pcap"),
          pcap_sha256: sha256("capture"),
          pcap_size_bytes: 24,
          filter: `(udp port 53 or tcp port 53) or (host ${targetIp})`,
          provenance: { executable: "test-capture", version: "1", interface: "test0" },
          events: [{ kind: "packet", protocol: "tcp", destination_ip: targetIp, destination_port: 443 }],
        };
      },
    },
    captureDir: directory,
    interfaceName: "test0",
    resolver: { async resolve4() { return [targetIp]; }, async resolve6() { return []; } },
    testMode: true,
    now: FIXED_NOW,
  });
  assert.equal(report.status, "fail");
  assert.equal(report.violations.some(violation => violation.code === "direct_target_packet"), true);
  assert.equal(report.scenarios[0].capture.events_sha256, canonicalDigest(report.scenarios[0].capture.events));
});
test("egress certification requires capture privilege and a certified packet lane", async t => {
  const { directory, build } = await buildIdentity(t);
  const targetIp = "203.0.113.12";
  const manifest = { schema_version: 1, release_id: "release-gate-test", scenarios: [{ id: "canary", surfaces: ["fetch"], url: "https://runtime.test/canary", target: { host: "target.test", ports: [443] }, allowed_dns: [], expected_assertions: ["surface:fetch"], settle_ms: 500 }] };
  const adapter = {
    async describe() { return { browser: { family: "test-browser", exact_build: "1.0.0", binary_sha256: "2".repeat(64) } }; },
    async executeScenario() { return { status: "completed", details: { assertions: ["surface:fetch"] } }; },
  };
  const captureBackend = {
    isRealCaptureBackend: true,
    async preflight() { return { executable: "test-capture", version: "1" }; },
    async start() { return { id: "capture" }; },
    async stop() {
      return {
        pcap_path: path.join(directory, "canary-clean.pcap"),
        pcap_sha256: sha256("clean-capture"),
        pcap_size_bytes: 24,
        filter: `(udp port 53 or tcp port 53) or (host ${targetIp})`,
        provenance: { executable: "test-capture", version: "1", interface: "test0" },
        events: [],
      };
    },
  };
  const supportMatrix = { schema_version: 1, release_id: "release-gate-test", egress_surfaces: ["fetch"], browsers: [{ family: "test-browser", exact_build: "1.0.0", platform: `${process.platform}-${process.arch}`, release_supported: true, packet_capture_certified: true }] };
  const run = ({ configPacket, boundaryPacket, matrix = supportMatrix }) => runEgressGate({
    config: productionConfig({ packetCertified: configPacket }),
    browserBoundary: productionBoundary({ packetCertified: boundaryPacket }),
    manifest,
    supportMatrix: matrix,
    build,
    adapter,
    captureBackend,
    captureDir: directory,
    interfaceName: "test0",
    resolver: { async resolve4() { return [targetIp]; }, async resolve6() { return []; } },
    now: FIXED_NOW,
  });
  const certified = await run({ configPacket: true, boundaryPacket: true });
  assert.equal(certified.status, "pass");
  assert.equal(certified.certification.claimed, true);
  const configUncertified = await run({ configPacket: false, boundaryPacket: true });
  assert.equal(configUncertified.status, "pass");
  assert.equal(configUncertified.certification.claimed, false);
  const boundaryUncertified = await run({ configPacket: true, boundaryPacket: false });
  assert.equal(boundaryUncertified.status, "pass");
  assert.equal(boundaryUncertified.certification.claimed, false);
  const wrongPlatform = await run({ configPacket: true, boundaryPacket: true, matrix: { ...supportMatrix, browsers: supportMatrix.browsers.map(browser => ({ ...browser, platform: "linux-x64" })) } });
  assert.equal(wrongPlatform.status, "pass");
  assert.equal(wrongPlatform.certification.claimed, false);
  await assert.rejects(
    run({ configPacket: true, boundaryPacket: true, matrix: { ...supportMatrix, egress_surfaces: ["fetch", "xhr"] } }),
    error => error instanceof GateFailure && error.code === "manifest_incomplete",
  );
  await assert.rejects(
    run({ configPacket: true, boundaryPacket: true, matrix: { ...supportMatrix, browsers: [...supportMatrix.browsers, { ...supportMatrix.browsers[0], release_supported: false }] } }),
    error => error instanceof GateFailure && error.code === "manifest_invalid",
  );
});

test("short soak gate rejects terminal-state invariant failure", async t => {
  const { build } = await buildIdentity(t);
  let tick = 0;
  const calls = { churn: 0, fault: 0 };
  const adapter = {
    async describe() { return { browser: { family: "test-browser", exact_build: "1.0.0", binary_sha256: "2".repeat(64) } }; },
    async start() { return { status: "started" }; },
    async sample() { return { memory_bytes: 100, queue_depth: 1, active_clients: 1, active_origins: 1, active_streams: 1, fd_count: 1, goroutine_count: 1, route_count: 1, port_count: 1, stream_count: 1, worker_count: 1, realm_count: 1 }; },
    async churn() { calls.churn += 1; return { status: "completed" }; },
    async injectFault() { calls.fault += 1; return { status: "injected" }; },
    async quiesce() { return { status: "quiescing" }; },
    async terminalState() { return { all_terminal: false, outstanding_requests: 1, active_streams:1, unrecovered_errors: 1, memory_bytes: 100, fd_count: 1, goroutine_count: 1, route_count: 1, port_count: 1, stream_count: 1, worker_count: 1, realm_count: 1 }; },
  };
  const report = await runSoakGate({
    config: testConfig(),
    build,
    adapter,
    seed: "a".repeat(64),
    clock: { now: () => tick, async sleep(milliseconds) { tick += milliseconds; } },
    now: FIXED_NOW,
    testMode: true,
    short: true,
    testOptions: { duration_ms: 12, warmup_ms: 4, quiescence_ms: 4, sample_interval_ms: 2, churn_interval_ms: 3, fault_interval_ms: 3 },
  });
  assert.equal(report.status, "fail");
  assert.equal(report.violations.some(violation => violation.code === "terminal_state_incomplete"), true);
  assert.ok(calls.churn > 0 && calls.fault > 0);
  assert.equal(report.plan.short, true);
});
test("soak leak evaluator rejects slopes, terminal ownership, and post-stop growth", () => {
  const sample = (phase, elapsed_ms, memory_bytes, count) => ({
    phase, elapsed_ms, memory_bytes, queue_depth: 0, active_clients: 40, active_origins: 20, active_streams: 40,
    fd_count: count, goroutine_count: count, route_count: count, port_count: 0, stream_count: 0, worker_count: 0, realm_count: 0,
  });
  const samples = [
    sample("warmup", 0, 100, 1), sample("warmup", 1000, 100, 1),
    sample("soak", 0, 100, 1), sample("soak", 3_600_000, 40_000_000, 4),
    sample("quiescence", 0, 40_000_000, 0), sample("quiescence", 900_000, 40_000_001, 1),
  ];
  const terminal = {
    all_terminal: false, outstanding_requests: 0, active_streams: 0, unrecovered_errors: 0,
    memory_bytes: 40_000_001, fd_count: 4, goroutine_count: 4, route_count: 1, port_count: 0, stream_count: 0, worker_count: 0, realm_count: 0,
  };
  const evidence = evaluateSoakLeakEvidence(samples, terminal, productionConfig().leak_tolerances.soak);
  assert.equal(evidence.status, "fail");
  assert.equal(evidence.violations.some(violation => violation.code === "soak_rss_slope_exceeded"), true);
  assert.equal(evidence.violations.some(violation => violation.code === "soak_owned_count_not_zero"), true);
  assert.equal(evidence.violations.some(violation => violation.code === "soak_post_stop_counter_growth"), true);
});

test("corpus gate rejects unowned deterministic deltas and permits exact owned deltas", async t => {
  const { build } = await buildIdentity(t);
  const manifest = {
    schema_version: 1,
    release_id: "release-gate-test",
    oracle_id: "test-oracle",
    sites: [{ id: "content", url: "https://runtime.test/content", kind: "live-canary", fixture_category: null, fixture_sha256: null, fixture_path: null, entry_path: null, mediated_url_template: null, native_url: "https://native.test/content", mediated_url: "https://runtime.test/content", site_class: "content", actions: [{ id: "load-content", expression: "true" }], compatibility_probes: [{ id: "ready", expression: "document.readyState === 'complete'" }], stealth_probes: [{ id: "canvas", expression: "HTMLCanvasElement.prototype.toDataURL.toString()" }] }],
  };
  const adapter = {
    async describe() { return { browser: { family: "test-browser", exact_build: "1.0.0", binary_sha256: "2".repeat(64) } }; },
    async evaluateSite({ mode }) {
      return {
        actions: { passed: true, executed: ["load-content"], failures: [] },
        compatibility: { passed: true, failures: [] },
        deterministic_signals: [{ id: "canvas", signature: mode === "native" ? "native-signature" : "mediated-signature" }],
      };
    },
  };
  const baseRegistry = {
    registry_version: 1,
    release_id: "release-gate-test",
    oracle_id: "test-oracle",
    oracle_digest: "1".repeat(64),
    generated_at: "2026-07-11T00:00:00.000Z",
    browser_scope: [{ family: "test-browser", exact_build: "1.0.0", platform: `${process.platform}-${process.arch}` }],
    entries: [],
  };
  await assert.rejects(
    runCorpusGate({ config: testConfig(), manifest, registry: { ...baseRegistry, oracle_id: "wrong-oracle" }, allowUnsignedRegistry: true, build, adapter, testMode: true, now: FIXED_NOW }),
    error => error instanceof GateFailure && error.code === "oracle_mismatch",
  );
  const unowned = await runCorpusGate({ config: testConfig(), manifest, registry: baseRegistry, allowUnsignedRegistry: true, build, adapter, testMode: true, now: FIXED_NOW });
  assert.equal(unowned.status, "fail");
  const delta = unowned.sites[0].stealth.deltas[0];
  assert.equal(delta.ownership.status, "unowned");
  const ownedRegistry = {
    ...baseRegistry,
    entries: [{
      id: "delta-canvas",
      observation_id: "corpus-deterministic-signal.canvas",
      exact_signature: {
        surface: "corpus-deterministic-signal",
        probe_id: "canvas",
        native_digest: canonicalDigest("native-signature"),
        mediated_digest: canonicalDigest("mediated-signature"),
      },
      category: "browser-implementation-difference",
      issue_url: "https://github.com/gosuda/zeroproxy/issues/new?title=Corpus%20canvas%20delta",
      owner: "release-test",
      rationale: "The test fixture deliberately emits different deterministic canvas signatures.",
      affected_release_range: "release-gate-test",
      affected_browser_builds: baseRegistry.browser_scope,
      introduced_at: "2026-07-10T00:00:00.000Z",
      expires_at: "2026-08-01T00:00:00.000Z",
      removal_condition: "Remove when the mediated test fixture emits the native canvas signature.",
      test_id: "test-oracle",
    }],
  };
  const owned = await runCorpusGate({ config: testConfig(), manifest, registry: ownedRegistry, allowUnsignedRegistry: true, build, adapter, testMode: true, now: FIXED_NOW });
  assert.equal(owned.status, "pass");
  assert.equal(owned.sites[0].stealth.deltas[0].ownership.status, "owned");
  const firefoxScope = { family: "firefox", exact_build: "152.0.6", platform: `${process.platform}-${process.arch}` };
  const outOfScopeRegistry = {
    ...ownedRegistry,
    browser_scope: [...ownedRegistry.browser_scope, firefoxScope],
    entries: [{ ...ownedRegistry.entries[0], affected_browser_builds: [firefoxScope] }],
  };
  const outOfScope = await runCorpusGate({ config: testConfig(), manifest, registry: outOfScopeRegistry, allowUnsignedRegistry: true, build, adapter, testMode: true, now: FIXED_NOW });
  assert.equal(outOfScope.status, "fail");
  assert.equal(outOfScope.sites[0].stealth.deltas[0].ownership.status, "unowned");
  const equalAdapter = {
    ...adapter,
    async evaluateSite() {
      return {
        actions: { passed: true, executed: ["load-content"], failures: [] },
        compatibility: { passed: true, failures: [] },
        deterministic_signals: [{ id: "canvas", signature: "same-signature" }],
      };
    },
  };
  const unobserved = await runCorpusGate({ config: testConfig(), manifest, registry: ownedRegistry, allowUnsignedRegistry: true, build, adapter: equalAdapter, testMode: true, now: FIXED_NOW });
  assert.equal(unobserved.status, "fail");
  assert.equal(unobserved.violations.some(violation => violation.code === "unobserved_registry_entry" && violation.registry_entry_id === "delta-canvas"), true);
  const expiredRegistry = {
    ...ownedRegistry,
    entries: [{ ...ownedRegistry.entries[0], expires_at: "2026-07-11T11:00:00.000Z" }],
  };
  await assert.rejects(
    runCorpusGate({ config: testConfig(), manifest, registry: expiredRegistry, allowUnsignedRegistry: true, build, adapter, testMode: true, now: FIXED_NOW }),
    error => error instanceof GateFailure && error.code === "registry_entry_expired",
  );
  const duplicateObservationRegistry = {
    ...ownedRegistry,
    entries: [
      ownedRegistry.entries[0],
      {
        ...ownedRegistry.entries[0],
        id: "delta-canvas-second",
        exact_signature: { ...ownedRegistry.entries[0].exact_signature, mediated_digest: "f".repeat(64) },
      },
    ],
  };
  await assert.rejects(
    runCorpusGate({ config: testConfig(), manifest, registry: duplicateObservationRegistry, allowUnsignedRegistry: true, build, adapter, testMode: true, now: FIXED_NOW }),
    error => error instanceof GateFailure && /duplicate compatibility observation/u.test(error.message),
  );
  const incompleteActionsAdapter = { ...adapter, async evaluateSite({ mode }) { return { actions: { passed: true, executed: ["unrelated"], failures: [] }, compatibility: { passed: true, failures: [] }, deterministic_signals: [{ id: "canvas", signature: mode === "native" ? "native-signature" : "mediated-signature" }] }; } };
  await assert.rejects(
    runCorpusGate({ config: testConfig(), manifest, registry: ownedRegistry, allowUnsignedRegistry: true, build, adapter: incompleteActionsAdapter, testMode: true, now: FIXED_NOW }),
    error => error instanceof GateFailure && error.code === "adapter_invalid",
  );
});
test("production corpus certification rejects development-only registry signatures", async t => {
  const { directory, build } = await buildIdentity(t);
  await Promise.all(REQUIRED_OFFLINE_CORPUS_CATEGORIES.map(async category => {
    const fixtureDirectory = path.join(directory, `fixture-${category}`);
    await mkdir(fixtureDirectory);
    await writeFile(path.join(fixtureDirectory, "index.html"), `<!doctype html><title>${category}</title>`, "utf8");
  }));
  const offlineSites = await Promise.all(REQUIRED_OFFLINE_CORPUS_CATEGORIES.map(async (category, index) => {
    const identity = await collectBuildIdentity(path.join(directory, `fixture-${category}`));
    return {
      id: `fixture-${category}`, url: `offline:${category}`, kind: "offline-fixture", fixture_category: category,
      fixture_sha256: identity.tree_sha256, fixture_path: `fixture-${category}`, entry_path: "index.html",
      mediated_url_template: "https://runtime.test/mediate?fixture={fixture_url_encoded}", native_url: null, mediated_url: null,
      site_class: ["content", "application", "editor_media_pwa"][index % 3],
      actions: [{ id: `action-${category}`, expression: "true" }],
      compatibility_probes: [{ id: "ready", expression: "true" }],
      stealth_probes: [{ id: "surface", expression: "navigator.userAgent" }],
    };
  }));
  const frameworkInventory = {
    schema_version: 1,
    toolchain: {
      node: "24.4.1",
      packages: {
        "@angular/compiler": "1.0.0",
        "@angular/core": "1.0.0",
        "@angular/platform-browser": "1.0.0",
        esbuild: "1.0.0",
        jquery: "1.0.0",
        react: "1.0.0",
        "react-dom": "1.0.0",
        rxjs: "1.0.0",
        tslib: "1.0.0",
        vue: "1.0.0",
        webpack: "1.0.0",
        "zone.js": "1.0.0",
      },
    },
    fixtures: offlineSites.map(site => ({
      category: site.fixture_category,
      path: site.fixture_path,
      entry_path: site.entry_path,
      tree_sha256: site.fixture_sha256,
      action_expression: site.actions[0].expression,
      ready_expression: site.compatibility_probes[0].expression,
    })),
  };
  const liveSite = {
    id: "live-content", url: "https://runtime.test/content", kind: "live-canary", fixture_category: null, fixture_sha256: null, fixture_path: null, entry_path: null, mediated_url_template: null,
    native_url: "https://native.test/content", mediated_url: "https://runtime.test/content", site_class: "content",
    actions: [{ id: "action-live", expression: "true" }], compatibility_probes: [{ id: "ready", expression: "true" }], stealth_probes: [{ id: "surface", expression: "navigator.userAgent" }],
  };
  const manifest = { schema_version: 1, release_id: "release-gate-test", oracle_id: "production-oracle", sites: [...offlineSites, liveSite] };
  const registry = {
    registry_version: 1,
    release_id: manifest.release_id,
    oracle_id: manifest.oracle_id,
    oracle_digest: "1".repeat(64),
    generated_at: "2026-07-11T00:00:00.000Z",
    browser_scope: [{ family: "test-browser", exact_build: "1.0.0", platform: `${process.platform}-${process.arch}` }],
    entries: [],
  };
  const adapter = {
    async describe() { return { browser: { family: "test-browser", exact_build: "1.0.0", binary_sha256: "2".repeat(64) } }; },
    async evaluateSite({ site, mode }) {
      if (site.kind === "offline-fixture" && mode === "native") {
        const response = await fetch(site.native_url);
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /^text\/html/);
        assert.match(await response.text(), new RegExp(`<title>${site.fixture_category}</title>`));
      }
      if (site.kind === "offline-fixture" && mode === "mediated") {
        const fixtureUrl = new URL(site.mediated_url).searchParams.get("fixture");
        assert.match(fixtureUrl, new RegExp(`^https://fixtures\\.test/[a-f0-9]{64}/fixture/${site.id}/index\\.html$`));
      }
      return {
        actions: { passed: true, executed: site.actions.map(action => action.id), failures: [] },
        compatibility: { passed: true, failures: [] },
        deterministic_signals: [{ id: "surface", signature: "same-signature" }],
      };
    },
  };
  const frameworkInventorySha256 = canonicalDigest(frameworkInventory);
  const mediatedFixtureBaseUrl = `https://fixtures.test/${frameworkInventorySha256}/`;
  const remoteFixtureVerifier = async ({ snapshots, baseUrl, requireHttps }) => {
    assert.equal(baseUrl, mediatedFixtureBaseUrl);
    assert.equal(requireHttps, true);
    return {
      status: "verified",
      verified: true,
      https: true,
      immutable_cache: true,
      base_url_sha256: canonicalDigest(baseUrl),
      asset_evidence_sha256: "8".repeat(64),
      asset_count: [...snapshots.values()].reduce((sum, snapshot) => sum + snapshot.assets.size, 0),
      urlFor(id, relativePath) { return new URL(`fixture/${id}/${relativePath}`, baseUrl).href; },
    };
  };
  const input = { config: productionConfig(), browserBoundary: productionBoundary(), manifest, frameworkInventory, frameworkInventorySha256, registry, build, adapter, fixtureRoot: directory, mediatedFixtureBaseUrl, remoteFixtureVerifier, now: FIXED_NOW };
  await assert.rejects(
    runCorpusGate({ ...input, registryVerification: { verified: true, development_only: true } }),
    error => error.code === "registry_signature_invalid",
  );
  await assert.rejects(
    runCorpusGate({
      ...input,
      registry: {
        ...registry,
        browser_scope: [{ family: "test-browser", exact_build: "2.0.0", platform: `${process.platform}-${process.arch}` }],
      },
      registryVerification: { verified: true, development_only: false, key_epoch: 1 },
    }),
    error => error instanceof GateFailure && error.code === "browser_scope_mismatch",
  );
  const unprovenInventory = structuredClone(frameworkInventory);
  delete unprovenInventory.toolchain;
  await assert.rejects(
    runCorpusGate({ ...input, frameworkInventory: unprovenInventory, registryVerification: { verified: true, development_only: false, key_epoch: 1 } }),
    error => error instanceof GateFailure && error.code === "corpus_incomplete",
  );
  const report = await runCorpusGate({ ...input, registryVerification: { verified: true, development_only: false, key_epoch: 1 } });
  assert.equal(report.status, "pass");
  assert.equal(report.certification.claimed, true);
  assert.deepEqual(report.manifest.offline_fixture_categories, [...REQUIRED_OFFLINE_CORPUS_CATEGORIES].sort());
  assert.equal(report.manifest.live_canary_count, 1);
  assert.equal(report.sites.filter(site => site.kind === "offline-fixture").every(site => site.fixture_evidence.verified && site.fixture_evidence.served_from_snapshot), true);
  assert.equal(report.manifest.mediated_fixture_origin.verified_before_after, true);
  let mutableVerification = 0;
  await assert.rejects(
    runCorpusGate({
      ...input,
      remoteFixtureVerifier: async options => {
        const evidence = await remoteFixtureVerifier(options);
        mutableVerification += 1;
        return mutableVerification === 1 ? evidence : { ...evidence, asset_evidence_sha256: "9".repeat(64) };
      },
      registryVerification: { verified: true, development_only: false, key_epoch: 1 },
    }),
    error => error instanceof GateFailure && error.code === "fixture_evidence_invalid",
  );
  await assert.rejects(
    runCorpusGate({
      ...input,
      frameworkInventory: {
        ...frameworkInventory,
        fixtures: frameworkInventory.fixtures.map(fixture =>
          fixture.category === "react" ? { ...fixture, action_expression: "tampered()" } : fixture),
      },
      registryVerification: { verified: true, development_only: false, key_epoch: 1 },
    }),
    error => error instanceof GateFailure && error.code === "corpus_incomplete",
  );
  await writeFile(path.join(directory, "fixture-react", "index.html"), "tampered", "utf8");
  await assert.rejects(
    runCorpusGate({ ...input, registryVerification: { verified: true, development_only: false, key_epoch: 1 } }),
    error => error instanceof GateFailure && error.code === "fixture_evidence_invalid",
  );
});

test("canonical report writer emits stable key ordering and all report schemas parse", async t => {
  const { directory, build } = await buildIdentity(t);
  const report = {
    schema_version: 1,
    report_type: "example",
    generated_at: "2026-07-11T12:00:00.000Z",
    build: { tree_sha256: build.tree_sha256, assets: build.assets },
    z: [3, 2, 1],
    a: { z: true, a: false },
  };
  const output = path.join(directory, "canonical-report.json");
  await writeCanonicalReport(output, report);
  assert.equal(await readFile(output, "utf8"), canonicalJson(report));
  assert.match(await readFile(output, "utf8"), /^\{"a"/);
  for (const schema of ["performance-report", "egress-report", "soak-report", "corpus-report", "performance-evidence-manifest", "egress-scenario-manifest", "soak-workload-manifest", "soak-workload-provenance", "soak-telemetry", "corpus-manifest", "framework-fixtures", "support-matrix", "release-artifact-manifest", "release-cutover-manifest"]) {
    const parsed = JSON.parse(await readFile(new URL(`../../protocol/${schema}.schema.json`, import.meta.url), "utf8"));
    assert.equal(parsed.$schema, "https://json-schema.org/draft/2020-12/schema");
  }
});

test("existing signed compatibility registry verifies before production corpus use", async () => {
  const registry = JSON.parse(await readFile(new URL("../../protocol/compatibility-deltas.json", import.meta.url), "utf8"));
  const signatures = JSON.parse(await readFile(new URL("../../protocol/compatibility-deltas.sig", import.meta.url), "utf8"));
  const keys = JSON.parse(await readFile(new URL("../../protocol/release-signing-keys.json", import.meta.url), "utf8"));
  const verification = verifyDeltaRegistrySignature({ registry, signatures, keys });
  assert.equal(verification.verified, true);
  assert.deepEqual(verification.verified_roles, ["release", "security"]);
  assert.deepEqual(verification.verified_owners, ["release-engineering-fixture", "security-engineering-fixture"]);
  const ownerOnlyKeys = structuredClone(keys);
  ownerOnlyKeys.keys[1].owner = ownerOnlyKeys.keys[0].owner;
  assert.throws(
    () => verifyDeltaRegistrySignature({ registry, signatures, keys: ownerOnlyKeys }),
    error => error instanceof GateFailure && error.code === "registry_signature_invalid",
  );
  assert.throws(
    () => verifyDeltaRegistrySignature({ registry: { ...registry, oracle_digest: "f".repeat(64) }, signatures, keys }),
    error => error instanceof GateFailure && error.code === "registry_signature_invalid",
  );
  assert.throws(
    () => verifyDeltaRegistrySignature({ registry, signatures: { ...signatures, key_epoch: keys.key_epoch + 1 }, keys }),
    error => error instanceof GateFailure && error.code === "registry_signature_invalid",
  );
});

test("threshold-signed gate reports produce one atomic production-eligible release tuple", async t => {
  const signing = signingFixture();
  const sourceConfig = (await readJson(new URL("../../protocol/performance-gates.json", import.meta.url).pathname)).value;
  const config = {
    ...sourceConfig,
    fixtures: sourceConfig.fixtures.map(fixture => ({
      ...fixture,
      availability: "available",
      sha256: "3".repeat(64),
      v1_baseline: { dcl_delta: 0.2, lcp_delta: 0.2, cpu_delta: 0.2 },
    })),
    packet_capture: { ...sourceConfig.packet_capture, availability: "available", privilege: "available", reason: "certified-test-evidence", certified: true },
  };
  const configSchema = await readJson(new URL("../../protocol/performance-gates.schema.json", import.meta.url).pathname);
  const telemetrySchema = await readJson(new URL("../../protocol/soak-telemetry.schema.json", import.meta.url).pathname);
  const workloadProvenanceSchema = await readJson(new URL("../../protocol/soak-workload-provenance.schema.json", import.meta.url).pathname);
  assert.deepEqual(validateJsonSchema(config, configSchema.value), { valid: true, errors: [] });
  const configSha256 = canonicalDigest(config);
  const configSchemaSha256 = configSchema.sha256;
  const buildTreeSha256 = "4".repeat(64);
  const browserLane = config.browser_lanes[0];
  const browserBoundary = { browser_lanes: config.browser_lanes.map(lane => ({ family: lane.family, exact_build: lane.exact_build, platform: lane.platform, release_supported: true, packet_capture_certified: true })) };
  const supportMatrixSchema = await readJson(new URL("../../protocol/support-matrix.schema.json", import.meta.url).pathname);
  const supportMatrixSource = (await readJson(new URL("../../protocol/support-matrix.json", import.meta.url).pathname)).value;
  const supportMatrixValue = {
    ...supportMatrixSource,
    release_id: config.release_id,
    browsers: supportMatrixSource.browsers.map(browser => {
      const lane = config.browser_lanes.find(({ family }) => family === browser.family);
      return {
        ...browser,
        exact_build: lane.exact_build,
        product_build_id: lane.product_build_id,
        platform: lane.platform,
        archive_sha256: lane.archive_sha256,
        binary_sha256: lane.binary_sha256,
        native_oracle_passed: true,
        runtime_gate_passed: true,
        transport_gate_passed: true,
        performance_gate_passed: true,
        soak_gate_passed: true,
        corpus_gate_passed: true,
        release_supported: true,
        packet_capture_certified: true,
      };
    }),
  };
  assert.deepEqual(validateJsonSchema(supportMatrixValue, supportMatrixSchema.value), { valid: true, errors: [] });
  const supportMatrix = { value: supportMatrixValue, sha256: canonicalDigest(supportMatrixValue) };
  const release = { release_id: config.release_id, performance_config_sha256: configSha256, build_tree_sha256: buildTreeSha256 };
  const generated_at = FIXED_NOW().toISOString();
  const soakWorkloadServerSha256 = "d".repeat(64);
  const environment = {
    architecture: process.arch,
    os: runtimeIdentity().os,
    node: process.versions.node,
    toolchain: {},
    browser: { family: browserLane.family, exact_build: browserLane.exact_build, binary_sha256: browserLane.binary_sha256 },
    browser_pin: { configured_pin: `${browserLane.family}-${browserLane.exact_build}`, boundary_pin_verified: true, binary_sha256_verified: true, release_supported: true, packet_capture_certified: true },
    adapter_toolchain: {
      build_proof: { build_tree_sha256: buildTreeSha256 },
      telemetry_schema_sha256: telemetrySchema.sha256,
      soak_manifest_sha256: "a".repeat(64),
      workload_provenance_schema_sha256: workloadProvenanceSchema.sha256,
      workload_provenance_sha256: "b".repeat(64),
      workload_server_sha256: soakWorkloadServerSha256,
      workload_origin_count: config.soak.origins,
      workload_origins_sha256: "c".repeat(64),
    },
  };
  const build = { tree_sha256: buildTreeSha256, assets: [{ path: "asset.bin", sha256: "8".repeat(64), size_bytes: 1 }] };
  const nativeSiteMetrics = { dcl_ms: 100, lcp_ms: 100, inp_ms: 10, cpu_ms: 100 };
  const measurementPair = {
    native: { site_metrics: nativeSiteMetrics },
    mediated: { site_metrics: { ...nativeSiteMetrics } },
  };
  const measuredPairs = Array.from({ length: 30 }, () => measurementPair);
  const gateScenarios = Object.keys(config.gates).map((gate, index) => ({
    id: `gate-${index}`, gate, site_class: ["content", "application", "editor_media_pwa"][index % 3], threshold: {}, sample_count: 30, warmup_count: 5,
    ...measuredFixtureEvidence(),
    value: { native: { p50: 1, p95: 1, p99: 1 }, mediated: { p50: 1, p95: 1, p99: 1 }, mediated_percentile: 1, mediated_cv: 0, paired_mean_delta_ci: { method: "paired", resamples: 10_000, seed: "seed", lower: 0, upper: 0 } },
    resource: {}, site_metrics: {}, pairs: measuredPairs,
  }));
  const fixtureReports = config.fixtures.map(fixture => ({
    id: `fixture-${fixture.id}`, fixture_id: fixture.id, site_class: fixture.site_class, sample_count: 30, warmup_count: 5,
    ...measuredFixtureEvidence(fixture.sha256),
    resource: {}, site_metrics: {}, v1_comparison: {
      dcl_delta: { baseline: 0.2, current: 0, regression: -1 },
      lcp_delta: { baseline: 0.2, current: 0, regression: -1 },
      cpu_delta: { baseline: 0.2, current: 0, regression: -1 },
    },
    pairs: measuredPairs,
  }));
  const aggregateViolations = [];
  const v1Aggregate = evaluateV1AggregateEvidence(fixtureReports, config, aggregateViolations);
  assert.deepEqual(aggregateViolations, []);
  const telemetrySample = (phase, elapsed_ms, active) => ({
    phase, elapsed_ms, memory_bytes: 100, queue_depth: 0, active_clients: active ? 40 : 0, active_origins: active ? 20 : 0, active_streams: active ? 240 : 0,
    fd_count: 10, goroutine_count: 20, route_count: active ? 1 : 0, port_count: active ? 1 : 0, stream_count: active ? 1 : 0, worker_count: active ? 1 : 0, realm_count: active ? 1 : 0,
  });
  const soakSamples = [
    telemetrySample("warmup", 0, true), telemetrySample("warmup", 1000, true),
    telemetrySample("soak", 0, true), telemetrySample("soak", 28_800_000, true),
    telemetrySample("quiescence", 0, false), telemetrySample("quiescence", 900_000, false),
  ];
  const soakTerminal = {
    all_terminal: true, outstanding_requests: 0, active_streams: 0, unrecovered_errors: 0,
    memory_bytes: 100, fd_count: 10, goroutine_count: 20, route_count: 0, port_count: 0, stream_count: 0, worker_count: 0, realm_count: 0,
  };
  const soakLeakEvidence = evaluateSoakLeakEvidence(soakSamples, soakTerminal, config.leak_tolerances.soak);
  assert.equal(soakLeakEvidence.status, "pass");
  const egressScenarios = supportMatrixValue.egress_surfaces.map((surface, index) => ({
    id: `canary-${index}`,
    surfaces: [surface],
    url: `https://runtime.test/${surface}`,
    target: { host: "target.test", ports: [443], resolved_ips: ["203.0.113.1"] },
    allowed_dns: [],
    execution: { status: "completed", details: { assertions: [`surface:${surface}`] } },
    capture: { pcap_path: `${surface}.pcap`, pcap_sha256: index.toString(16).repeat(64).slice(0, 64), pcap_size_bytes: 24, filter: "host 203.0.113.1", provenance: { backend: "tcpdump" }, events: [], events_sha256: "6".repeat(64) },
    violations: [],
  }));
  const corpusSites = [
    ...REQUIRED_OFFLINE_CORPUS_CATEGORIES.map((category, index) => ({
      id: `fixture-${category}`, url: `offline:${category}`, site_class: ["content", "application", "editor_media_pwa"][index % 3],
      kind: "offline-fixture", fixture_category: category, fixture_sha256: "9".repeat(64), fixture_path: `fixture-${category}`,
      fixture_evidence: { status: "verified", verified: true, tree_sha256: "9".repeat(64), asset_count: 1, served_from_snapshot: true, entry_path: "index.html" },
      execution_urls: { native: `http://127.0.0.1:1234/fixture/fixture-${category}/index.html`, mediated: `https://runtime.test/mediate?fixture=${category}` },
      actions: { native: { passed: true, executed: [`action-${category}`], failures: [] }, mediated: { passed: true, executed: [`action-${category}`], failures: [] } },
      compatibility: { native: { passed: true, failures: [] }, mediated: { passed: true, failures: [] } },
      stealth: { native_signals: [], mediated_signals: [], deltas: [], outcome: "owned-or-no-delta" },
    })),
    {
      id: "live-canary", url: "https://runtime.test/", site_class: "content",
      kind: "live-canary", fixture_category: null, fixture_sha256: null, fixture_path: null,
      fixture_evidence: { status: "not-applicable", verified: false, tree_sha256: null, asset_count: 0, served_from_snapshot: false, entry_path: null },
      execution_urls: { native: "https://native.test/", mediated: "https://runtime.test/" },
      actions: { native: { passed: true, executed: ["action-live"], failures: [] }, mediated: { passed: true, executed: ["action-live"], failures: [] } },
      compatibility: { native: { passed: true, failures: [] }, mediated: { passed: true, failures: [] } },
      stealth: { native_signals: [], mediated_signals: [], deltas: [], outcome: "owned-or-no-delta" },
    },
  ];
  const corpusFixtureEvidenceSha256 = canonicalDigest(corpusSites.map(site => ({ id: site.id, fixture_evidence: site.fixture_evidence })));
  const frameworkFixturesSha256 = sha256(await readFile(new URL("../frameworks/manifest.json", import.meta.url)));
  const reports = {
    performance: {
      schema_version: 1, report_type: "performance-gate", generated_at, status: "pass", test_mode: false,
      certification: { claimed: true, reason: "passed" }, release, environment, build,
      measurement: { warmups: 5, measured_pairs: 30, bootstrap_resamples: 10_000, bootstrap_method: "paired-mean-bootstrap-nearest-rank-v1", max_cv: 0.1, resource_limits: { max_memory_bytes: 1024, max_queue_depth: 8 }, deterministic_seed: "7".repeat(64) },
      scenarios: gateScenarios,
      fixture_reports: fixtureReports,
      v1_aggregate: v1Aggregate,
      invalidations: [], violations: [],
    },
    egress: {
      schema_version: 1, report_type: "egress-gate", generated_at, status: "pass", test_mode: false,
      certification: { claimed: true, reason: "passed" }, release, environment, build,
      manifest: { sha256: "1".repeat(64), scenario_count: egressScenarios.length, support_matrix_sha256: supportMatrix.sha256, surfaces: [...supportMatrixValue.egress_surfaces].sort() },
      scenarios: egressScenarios,
      violations: [],
    },
    soak: {
      schema_version: 1, report_type: "soak-gate", generated_at, status: "pass", test_mode: false,
      certification: { claimed: true, reason: "passed" }, release, environment, build,
      plan: {
        shape: { hours: 8, warmup_minutes: 30, quiescence_minutes: 15, origins: 20, clients: 40, short_streams: 200, sse_streams: 20, websockets: 20, navigations_per_origin_per_minute: 2, abort_churn: 0.1 },
        duration_ms: 28_800_000, warmup_ms: 1_800_000, quiescence_ms: 900_000, sample_interval_ms: 30_000, churn_interval_ms: 60_000, fault_interval_ms: 300_000,
        short: false, resource_limits: { max_memory_bytes: 1024, max_queue_depth: 8 }, deterministic_seed: "7".repeat(64), fault_kinds: ["relay-loss"],
      },
      samples: soakSamples,
      resource_maxima: { memory_bytes: 100, queue_depth: 0 }, churn_events: [], fault_events: [],
      terminal: soakTerminal, leak_evidence: soakLeakEvidence, violations: [],
    },
    corpus: {
      schema_version: 1, report_type: "corpus-gate", generated_at, status: "pass", test_mode: false,
      certification: { claimed: true, reason: "passed" }, release, environment: { ...environment, registry_scope_verified: true }, build,
      manifest: { sha256: "1".repeat(64), framework_inventory_sha256: frameworkFixturesSha256, site_count: corpusSites.length, oracle_id: "oracle", offline_fixture_categories: [...REQUIRED_OFFLINE_CORPUS_CATEGORIES].sort(), live_canary_count: 1, fixture_evidence_sha256: corpusFixtureEvidenceSha256, mediated_fixture_origin: { status: "verified", verified: true, https: true, immutable_cache: true, base_url_sha256: "3".repeat(64), asset_evidence_sha256: "4".repeat(64), asset_count: REQUIRED_OFFLINE_CORPUS_CATEGORIES.length, verified_before_after: true } },
      registry: { sha256: "2".repeat(64), oracle_id: "oracle", entry_count: 0, verification: { verified: true, development_only: false } },
      sites: corpusSites,
      violations: [],
    },
  };
  const reportSchemas = Object.fromEntries(await Promise.all(["performance", "egress", "soak", "corpus"].map(async gate => [
    gate,
    await readJson(new URL(`../../protocol/${gate}-report.schema.json`, import.meta.url).pathname),
  ])));
  for (const [gate, report] of Object.entries(reports))
    assert.deepEqual(validateJsonSchema(report, reportSchemas[gate].value), { valid: true, errors: [] });
  for (const [gate, report] of Object.entries(reports)) {
    const missingType = { ...report };
    delete missingType.report_type;
    assert.equal(validateJsonSchema(missingType, reportSchemas[gate].value).valid, false);
  }
  const invalidDate = { ...reports.performance, generated_at: "July 11, 2026" };
  assert.equal(validateJsonSchema(invalidDate, reportSchemas.performance.value).valid, false);
  const invalidPort = structuredClone(reports.egress);
  invalidPort.scenarios[0].target.ports[0] = 99_999;
  assert.equal(validateJsonSchema(invalidPort, reportSchemas.egress.value).valid, false);
  const signatures = Object.fromEntries(Object.entries(reports).map(([gate, report]) => [gate, signing.sign(report)]));
  const reportVerifications = verifyGateReportSignatures({ reports, signatures, keys: signing.keys });
  const reportHashes = Object.fromEntries(Object.entries(reports).map(([gate, report]) => [gate, canonicalDigest(report)]));
  const artifactHashes = Object.fromEntries(ARTIFACT_NAMES.map((name, index) => [name, (index % 10).toString().repeat(64)]));
  artifactHashes.ci_workflow = sha256(await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url)));
  artifactHashes.support_matrix = supportMatrix.sha256;
  artifactHashes.framework_fixtures = frameworkFixturesSha256;
  artifactHashes.framework_fixtures_schema = sha256(await readFile(new URL("../../protocol/framework-fixtures.schema.json", import.meta.url)));
  artifactHashes.soak_workload_server = soakWorkloadServerSha256;
  artifactHashes.v1_baseline = sha256(await readFile(new URL("../../protocol/v1-baseline.json", import.meta.url)));
  artifactHashes.v1_evidence_manifest = sha256(await readFile(new URL("../../evidence/2.0.0/v1/raw-manifest.json", import.meta.url)));
  const artifactStatement = { schema_version: 1, release_id: config.release_id, performance_config_sha256: configSha256, build_tree_sha256: buildTreeSha256, artifact_hashes: artifactHashes };
  const artifactSchema = await readJson(new URL("../../protocol/release-artifact-manifest.schema.json", import.meta.url).pathname);
  const manifestSchema = await readJson(new URL("../../protocol/release-cutover-manifest.schema.json", import.meta.url).pathname);
  assert.deepEqual(validateJsonSchema(artifactStatement, artifactSchema.value), { valid: true, errors: [] });
  const artifactSignatures = signing.sign(artifactStatement);
  const artifactVerification = {
    ...verifyCanonicalThresholdSignature({ value: artifactStatement, signatures: artifactSignatures, keys: signing.keys, label: "test artifact statement" }),
    statement_sha256: canonicalDigest(artifactStatement),
    signature_sha256: canonicalDigest(artifactSignatures),
    schema_sha256: artifactSchema.sha256,
    performance_config_sha256: configSha256,
    build_tree_sha256: buildTreeSha256,
    artifact_hashes_sha256: canonicalDigest(artifactHashes),
  };
  const input = {
    config, configSha256, configSchemaSha256, configSchema, browserBoundary, supportMatrix, supportMatrixSchema, reports, reportHashes,
    reportSchemas, reportVerifications, artifactHashes, artifactVerification, manifestSchema, signingKeys: signing.keys, now: FIXED_NOW,
  };
  const manifest = buildReleaseManifest(input);
  assert.deepEqual(validateJsonSchema(manifest, manifestSchema.value), { valid: true, errors: [] });
  assert.equal(manifest.production_eligible, true);
  assert.deepEqual(manifest.ineligibility_reasons, []);
  assert.equal(manifest.release_tuple.build_tree_sha256, buildTreeSha256);
  const manifestSignatures = signing.sign(manifest);
  const verified = await verifyReleaseManifest({ ...input, manifest, manifestSignatures });
  assert.equal(verified.production_eligible, true);
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeroproxy-release-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = {
    config: path.join(directory, "performance-gates.json"),
    boundary: path.join(directory, "browser-boundaries.json"),
    keys: path.join(directory, "release-signing-keys.json"),
    supportMatrix: path.join(directory, "support-matrix.json"),
    artifacts: path.join(directory, "release-artifacts.json"),
    artifactSignature: path.join(directory, "release-artifacts.sig"),
    manifest: path.join(directory, "release-manifest.json"),
    manifestSignature: path.join(directory, "release-manifest.sig"),
  };
  await Promise.all([
    writeFile(paths.config, canonicalJson(config)),
    writeFile(paths.boundary, canonicalJson(browserBoundary)),
    writeFile(paths.supportMatrix, canonicalJson(supportMatrixValue)),
    writeFile(paths.keys, canonicalJson(signing.keys)),
    writeFile(paths.artifacts, canonicalJson(artifactStatement)),
    writeFile(paths.artifactSignature, canonicalJson(artifactSignatures)),
    ...Object.entries(reports).flatMap(([gate, report]) => [
      writeFile(path.join(directory, `${gate}-report.json`), canonicalJson(report)),
      writeFile(path.join(directory, `${gate}-report.sig`), canonicalJson(signatures[gate])),
    ]),
  ]);
  const repository = path.resolve(new URL("../..", import.meta.url).pathname);
  const cli = path.join(repository, "scripts/gates/release-manifest.mjs");
  const baseArguments = [
    cli,
    "--config", paths.config,
    "--schema", new URL("../../protocol/performance-gates.schema.json", import.meta.url).pathname,
    "--boundary", paths.boundary,
    "--support-matrix", paths.supportMatrix,
    "--support-matrix-schema", new URL("../../protocol/support-matrix.schema.json", import.meta.url).pathname,
    "--keys", paths.keys,
    "--artifacts", paths.artifacts,
    "--artifacts-signature", paths.artifactSignature,
    ...Object.keys(reports).flatMap(gate => [
      `--${gate}-report`, path.join(directory, `${gate}-report.json`),
      `--${gate}-signature`, path.join(directory, `${gate}-report.sig`),
    ]),
  ];
  const remoteTamperedReports = structuredClone(reports);
  remoteTamperedReports.corpus.manifest.mediated_fixture_origin.immutable_cache = false;
  const remoteTamperedSignatures = { ...signatures, corpus: signing.sign(remoteTamperedReports.corpus) };
  const remoteTamperedVerifications = verifyGateReportSignatures({ reports: remoteTamperedReports, signatures: remoteTamperedSignatures, keys: signing.keys });
  const remoteTampered = buildReleaseManifest({ ...input, reports: remoteTamperedReports, reportVerifications: remoteTamperedVerifications });
  assert.equal(remoteTampered.production_eligible, false);
  assert.equal(remoteTampered.ineligibility_reasons.includes("corpus-compatibility-stealth-action-or-fixture-evidence-incomplete"), true);
  const unsigned = spawnSync(process.execPath, [...baseArguments, "--output", paths.manifest], { cwd: repository, encoding: "utf8" });
  assert.equal(unsigned.status, 1);
  assert.equal(unsigned.stderr, "");
  assert.deepEqual(JSON.parse(unsigned.stdout), {
    detached_signature_required: true,
    evidence_eligible: true,
    ineligibility_reasons: [],
    output: paths.manifest,
    production_eligible: false,
  });
  const cliManifest = JSON.parse(await readFile(paths.manifest, "utf8"));
  await writeFile(paths.manifestSignature, canonicalJson(signing.sign(cliManifest)));
  const signed = spawnSync(process.execPath, [...baseArguments, "--manifest", paths.manifest, "--manifest-signature", paths.manifestSignature], { cwd: repository, encoding: "utf8" });
  assert.equal(signed.status, 0, signed.stderr);
  assert.equal(JSON.parse(signed.stdout).production_eligible, true);
  const mismatchedReports = { ...reports, corpus: { ...reports.corpus, release: { ...release, build_tree_sha256: "6".repeat(64) } } };
  const mismatchedSignatures = { ...signatures, corpus: signing.sign(mismatchedReports.corpus) };
  const mismatchedVerifications = verifyGateReportSignatures({ reports: mismatchedReports, signatures: mismatchedSignatures, keys: signing.keys });
  const mismatched = buildReleaseManifest({ ...input, reports: mismatchedReports, reportVerifications: mismatchedVerifications });
  assert.equal(mismatched.production_eligible, false);
  assert.equal(mismatched.ineligibility_reasons.includes("report-release-tuple-invalid:corpus"), true);
  const inventoryTamperedReports = structuredClone(reports);
  inventoryTamperedReports.corpus.manifest.framework_inventory_sha256 = "f".repeat(64);
  const inventoryTamperedSignatures = { ...signatures, corpus: signing.sign(inventoryTamperedReports.corpus) };
  const inventoryTamperedVerifications = verifyGateReportSignatures({ reports: inventoryTamperedReports, signatures: inventoryTamperedSignatures, keys: signing.keys });
  const inventoryTampered = buildReleaseManifest({ ...input, reports: inventoryTamperedReports, reportVerifications: inventoryTamperedVerifications });
  assert.equal(inventoryTampered.production_eligible, false);
  assert.equal(inventoryTampered.ineligibility_reasons.includes("corpus-framework-fixture-inventory-mismatch"), true);
  assert.equal(inventoryTampered.ineligibility_reasons.includes("corpus-compatibility-stealth-action-or-fixture-evidence-incomplete"), true);
  const narrowedSupportValue = { ...supportMatrixValue, egress_surfaces: supportMatrixValue.egress_surfaces.slice(1) };
  const narrowedSupport = buildReleaseManifest({ ...input, supportMatrix: { value: narrowedSupportValue, sha256: canonicalDigest(narrowedSupportValue) } });
  assert.equal(narrowedSupport.production_eligible, false);
  assert.equal(narrowedSupport.ineligibility_reasons.includes("support-matrix-artifact-mismatch"), true);
  assert.equal(narrowedSupport.ineligibility_reasons.includes("egress-support-matrix-evidence-mismatch"), true);
  const mismatchedArtifactHashes = { ...artifactHashes, soak_workload_server: "e".repeat(64) };
  const mismatchedArtifactManifest = buildReleaseManifest({ ...input, artifactHashes: mismatchedArtifactHashes });
  assert.equal(mismatchedArtifactManifest.production_eligible, false);
  assert.equal(mismatchedArtifactManifest.ineligibility_reasons.includes("artifact-evidence-hashes-mismatch"), true);
  assert.equal(mismatchedArtifactManifest.ineligibility_reasons.includes("soak-workload-artifact-or-origin-provenance-incomplete"), true);
});

test("release cutover tuple is atomic and unavailable evidence never certifies", async () => {
  const configLoaded = await loadPerformanceConfig(new URL("../../protocol/performance-gates.json", import.meta.url).pathname);
  const schemaLoaded = await readJson(new URL("../../protocol/performance-gates.schema.json", import.meta.url).pathname);
  const boundary = JSON.parse(await readFile(new URL("../../protocol/browser-boundaries.json", import.meta.url), "utf8"));
  const reports = Object.fromEntries(["performance", "egress", "soak", "corpus"].map(gate => [gate, {
    schema_version: 1, report_type: `${gate}-gate`, status: "pass", test_mode: false,
    release: { release_id: configLoaded.config.release_id, performance_config_sha256: configLoaded.configSha256, build_tree_sha256: "7".repeat(64) },
  }]));
  const reportHashes = Object.fromEntries(Object.entries(reports).map(([gate, report]) => [gate, canonicalDigest(report)]));
  const manifest = buildReleaseManifest({ config: configLoaded.config, configSha256: configLoaded.configSha256, configSchemaSha256: schemaLoaded.sha256, browserBoundary: boundary, reports, reportHashes, now: FIXED_NOW });
  assert.equal(manifest.production_eligible, false);
  assert.equal(manifest.ineligibility_reasons.includes("browser-unavailable:chromium"), false);
  assert.equal(manifest.ineligibility_reasons.includes("chromium-packet-capture-privilege-or-certification-unavailable"), true);
  assert.equal(manifest.ineligibility_reasons.includes("required-chromium-packet-or-support-evidence-unavailable"), true);
  assert.equal(manifest.ineligibility_reasons.some(reason => reason.includes("firefox")), false);
  assert.equal(manifest.ineligibility_reasons.includes("report-certification-claim-missing:performance"), true);
  assert.equal(manifest.ineligibility_reasons.includes("release-signing-key-set-unavailable"), true);
  assert.equal(manifest.ineligibility_reasons.includes("artifact-evidence-signature-unverified"), true);
  assert.equal(manifest.ineligibility_reasons.includes("release-manifest-schema-unavailable"), true);
  await assert.rejects(verifyReleaseManifest({ manifest, config: configLoaded.config, configSha256: configLoaded.configSha256, configSchemaSha256: schemaLoaded.sha256, browserBoundary: boundary, reports, reportHashes }), error => error.code === "release_manifest_schema_invalid");
});
