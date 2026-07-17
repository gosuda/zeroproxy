import path from "node:path";
import { writeFile } from "node:fs/promises";
import {
  GateFailure,
  bootstrapPairedMeanCI,
  canonicalDigest,
  canonicalJson,
  coefficientOfVariation,
  collectBuildIdentity,
  finiteNonnegative,
  invariant,
  loadAdapter,
  loadBrowserBoundaries,
  loadPerformanceConfig,
  moduleDirectory,
  nearestRank,
  parseArgs,
  releaseTuple,
  reportCommandSummary,
  runtimeIdentity,
  verifyBrowserPin,
  productionCertification,
  withTemporaryDirectory,
  writeCanonicalReport,
} from "./common.mjs";

const GATE_METRICS = new Set(["dcl_ms", "lcp_ms", "inp_ms", "cpu_ms"]);

function requireFunction(value, name) {
  invariant(typeof value === "function", `performance adapter must implement ${name}()`, "adapter_invalid");
  return value;
}

function metricDirection(gate) {
  return gate.endsWith("throughput_mib_s") ? "minimum" : "maximum";
}

function percentileForGate(gate, configured = 0.95) {
  return metricDirection(gate) === "minimum" ? 1 - configured : configured;
}

function normalizeSiteMetrics(value, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label}.site_metrics is required`, "adapter_invalid");
  const normalized = {};
  for (const metric of GATE_METRICS)
    normalized[metric] = finiteNonnegative(value[metric], `${label}.site_metrics.${metric}`);
  return normalized;
}

function normalizeObservation(value, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} sample must be an object`, "adapter_invalid");
  return {
    value: finiteNonnegative(value.value, `${label}.value`),
    memory_bytes: finiteNonnegative(value.memory_bytes, `${label}.memory_bytes`),
    queue_depth: finiteNonnegative(value.queue_depth, `${label}.queue_depth`),
    site_metrics: normalizeSiteMetrics(value.site_metrics, label),
  };
}

function normalizePair(pair, label) {
  invariant(pair && typeof pair === "object", `${label} must be a pair`, "adapter_invalid");
  return {
    native: normalizeObservation(pair.native, `${label}.native`),
    mediated: normalizeObservation(pair.mediated, `${label}.mediated`),
  };
}

function normalizeLimits(value) {
  invariant(value && typeof value === "object", "performance adapter describe().resource_limits is required", "resource_limits_missing");
  return {
    max_memory_bytes: finiteNonnegative(value.max_memory_bytes, "resource_limits.max_memory_bytes"),
    max_queue_depth: finiteNonnegative(value.max_queue_depth, "resource_limits.max_queue_depth"),
  };
}

function evaluateResources(pairs, limits, violations, scenarioId, leakTolerance = null) {
  let maxMemoryBytes = 0;
  let maxQueueDepth = 0;
  for (const [index, pair] of pairs.entries()) {
    for (const [mode, observation] of Object.entries(pair)) {
      maxMemoryBytes = Math.max(maxMemoryBytes, observation.memory_bytes);
      maxQueueDepth = Math.max(maxQueueDepth, observation.queue_depth);
      if (observation.memory_bytes > limits.max_memory_bytes)
        violations.push({ code: "memory_limit_exceeded", scenario_id: scenarioId, sample_index: index, mode, observed: observation.memory_bytes, limit: limits.max_memory_bytes });
      if (observation.queue_depth > limits.max_queue_depth)
        violations.push({ code: "queue_limit_exceeded", scenario_id: scenarioId, sample_index: index, mode, observed: observation.queue_depth, limit: limits.max_queue_depth });
    }
  }
  const memoryGrowthBytes = pairs.at(-1).mediated.memory_bytes - pairs[0].mediated.memory_bytes;
  const queueGrowth = pairs.at(-1).mediated.queue_depth - pairs[0].mediated.queue_depth;
  if (leakTolerance && memoryGrowthBytes > leakTolerance.memory_growth_bytes)
    violations.push({ code: "memory_leak_tolerance_exceeded", scenario_id: scenarioId, observed: memoryGrowthBytes, limit: leakTolerance.memory_growth_bytes });
  if (leakTolerance && queueGrowth > leakTolerance.queue_growth)
    violations.push({ code: "queue_leak_tolerance_exceeded", scenario_id: scenarioId, observed: queueGrowth, limit: leakTolerance.queue_growth });
  return { max_memory_bytes: maxMemoryBytes, max_queue_depth: maxQueueDepth, memory_growth_bytes: memoryGrowthBytes, queue_growth: queueGrowth };
}

function siteDelta(nativeValue, mediatedValue, metric) {
  if (metric === "inp_ms") return mediatedValue - nativeValue;
  if (nativeValue === 0) {
    invariant(mediatedValue === 0, `cannot calculate ${metric} relative delta from a zero native measurement`, "measurement_unavailable");
    return 0;
  }
  return (mediatedValue - nativeValue) / nativeValue;
}

function evaluateSiteClass(pairs, siteClass, limits, violations, scenarioId) {
  const metrics = {};
  const limitByMetric = {
    dcl_ms: limits.dcl_delta,
    lcp_ms: limits.lcp_delta,
    inp_ms: limits.inp_delta_ms,
    cpu_ms: limits.cpu_delta,
  };
  for (const metric of GATE_METRICS) {
    const deltas = pairs.map(pair => siteDelta(pair.native.site_metrics[metric], pair.mediated.site_metrics[metric], metric));
    const p95 = nearestRank(deltas, 0.95);
    const limit = limitByMetric[metric];
    metrics[metric] = { p95_delta: p95, limit };
    if (p95 > limit)
      violations.push({ code: "site_class_delta_exceeded", scenario_id: scenarioId, site_class: siteClass, metric, observed: p95, limit });
  }
  return metrics;
}

function validateScenarioFixtureEvidence(scenario) {
  const evidence = scenario.fixture_evidence;
  invariant(typeof scenario.fixture_sha256 === "string" && /^[a-f0-9]{64}$/u.test(scenario.fixture_sha256), `performance scenario ${scenario.id} fixture digest is required`, "adapter_invalid");
  invariant(evidence?.verified === true
    && evidence.served_from_snapshot === true
    && evidence.tree_sha256 === scenario.fixture_sha256
    && evidence.asset_count > 0
    && typeof evidence.entry_path === "string",
  `performance scenario ${scenario.id} fixture evidence is invalid`, "adapter_invalid");
}

function validateScenarios(scenarios, config) {
  invariant(Array.isArray(scenarios) && scenarios.length > 0, "performance adapter enumerateScenarios() must return a non-empty array", "adapter_invalid");
  const expectedGates = new Set(Object.keys(config.gates));
  const expectedFixtures = new Map((config.fixtures ?? []).filter(fixture => fixture.availability === "available").map(fixture => [fixture.id, fixture]));
  const observedGates = new Set();
  const observedFixtures = new Set();
  const observedIds = new Set();
  const observedSiteClasses = new Set();
  const normalized = [];
  for (const candidate of scenarios) {
    invariant(candidate && typeof candidate === "object", "performance scenario must be an object", "adapter_invalid");
    const scenario = { ...candidate, kind: candidate.kind ?? "gate" };
    invariant(typeof scenario.id === "string" && scenario.id.length > 0, "performance scenario id is required", "adapter_invalid");
    invariant(!observedIds.has(scenario.id), `duplicate performance scenario id ${scenario.id}`, "adapter_invalid");
    invariant(Object.hasOwn(config.site_classes, scenario.site_class), `performance scenario ${scenario.id} has unknown site class ${scenario.site_class}`, "adapter_invalid");
    validateScenarioFixtureEvidence(scenario);
    if (scenario.kind === "gate") {
      invariant(expectedGates.has(scenario.gate), `performance scenario ${scenario.id} references unknown gate ${scenario.gate}`, "adapter_invalid");
      invariant(!observedGates.has(scenario.gate), `performance gate ${scenario.gate} has more than one scenario`, "adapter_invalid");
      observedGates.add(scenario.gate);
    } else {
      invariant(scenario.kind === "fixture", `performance scenario ${scenario.id} has unknown kind ${scenario.kind}`, "adapter_invalid");
      const fixture = expectedFixtures.get(scenario.fixture_id);
      invariant(fixture && fixture.site_class === scenario.site_class, `performance fixture scenario ${scenario.id} is not declared by performance-gates.json`, "adapter_invalid");
      invariant(!observedFixtures.has(scenario.fixture_id), `performance fixture ${scenario.fixture_id} has more than one scenario`, "adapter_invalid");
      observedFixtures.add(scenario.fixture_id);
    }
    observedIds.add(scenario.id);
    observedSiteClasses.add(scenario.site_class);
    normalized.push(Object.freeze(scenario));
  }
  for (const gate of expectedGates)
    invariant(observedGates.has(gate), `performance adapter omitted configured gate ${gate}`, "adapter_invalid");
  for (const fixture of expectedFixtures.keys())
    invariant(observedFixtures.has(fixture), `performance adapter omitted configured fixture ${fixture}`, "adapter_invalid");
  for (const siteClass of Object.keys(config.site_classes))
    invariant(observedSiteClasses.has(siteClass), `performance adapter omitted site class ${siteClass}`, "adapter_invalid");
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

function reportScenario({ scenario, pairs, config, limits, seed, violations, invalidations }) {
  const nativeValues = pairs.map(pair => pair.native.value);
  const mediatedValues = pairs.map(pair => pair.mediated.value);
  const direction = metricDirection(scenario.gate);
  const percentile = percentileForGate(scenario.gate, config.aggregation?.threshold_percentile);
  const observed = nearestRank(mediatedValues, percentile);
  const threshold = config.gates[scenario.gate];
  const pairedCi = bootstrapPairedMeanCI(pairs.map(pair => ({ native: pair.native.value, mediated: pair.mediated.value })), config.bootstrap_resamples, `${seed}:${scenario.id}`);
  const passesThreshold = direction === "maximum" ? observed <= threshold : observed >= threshold;
  if (!passesThreshold)
    violations.push({ code: "performance_threshold_exceeded", scenario_id: scenario.id, gate: scenario.gate, direction, percentile, observed, threshold });
  const bootstrapPasses = direction === "maximum" ? pairedCi.upper <= threshold : pairedCi.lower >= threshold;
  if (!bootstrapPasses)
    violations.push({ code: "paired_bootstrap_bound_exceeded", scenario_id: scenario.id, gate: scenario.gate, bound: direction === "maximum" ? "upper" : "lower", observed: direction === "maximum" ? pairedCi.upper : pairedCi.lower, threshold });
  const cv = coefficientOfVariation(mediatedValues);
  const maxCv = config.variance?.max_cv ?? config.max_cv;
  if (cv > maxCv)
    invalidations.push({ code: "sample_cv_exceeded", scenario_id: scenario.id, observed: cv, limit: maxCv });
  const resource = evaluateResources(pairs, limits, violations, scenario.id, config.leak_tolerances?.performance ?? null);
  const siteMetrics = evaluateSiteClass(pairs, scenario.site_class, config.site_classes[scenario.site_class], violations, scenario.id);
  return {
    id: scenario.id, gate: scenario.gate, site_class: scenario.site_class,
    fixture_sha256: scenario.fixture_sha256,
    fixture_evidence: scenario.fixture_evidence,
    threshold: { direction, value: threshold, percentile }, sample_count: pairs.length, warmup_count: config.warmups,
    value: {
      native: { p50: nearestRank(nativeValues, 0.5), p95: nearestRank(nativeValues, 0.95), p99: nearestRank(nativeValues, 0.99) },
      mediated: { p50: nearestRank(mediatedValues, 0.5), p95: nearestRank(mediatedValues, 0.95), p99: nearestRank(mediatedValues, 0.99) },
      mediated_percentile: observed, mediated_cv: cv, paired_mean_delta_ci: pairedCi,
    },
    resource, site_metrics: siteMetrics, pairs,
  };
}
function fixtureReport({ scenario, pairs, config, limits, violations }) {
  const fixture = config.fixtures.find(candidate => candidate.id === scenario.fixture_id);
  const resource = evaluateResources(pairs, limits, violations, scenario.id, config.leak_tolerances?.performance ?? null);
  const siteMetrics = evaluateSiteClass(pairs, scenario.site_class, config.site_classes[scenario.site_class], violations, scenario.id);
  const metricMap = { dcl_delta: "dcl_ms", lcp_delta: "lcp_ms", cpu_delta: "cpu_ms" };
  const v1Comparison = {};
  for (const [metric, siteMetric] of Object.entries(metricMap)) {
    const baseline = fixture.v1_baseline?.[metric];
    const current = Math.max(0, siteMetrics[siteMetric].p95_delta);
    if (!Number.isFinite(baseline) || baseline < 0) {
      violations.push({ code: "v1_fixture_baseline_missing", fixture_id: fixture.id, metric });
      v1Comparison[metric] = { baseline: null, current, regression: null };
      continue;
    }
    if (baseline === 0) {
      if (current > 0) violations.push({ code: "v1_zero_baseline_regressed", fixture_id: fixture.id, metric, observed: current, limit: 0 });
      v1Comparison[metric] = { baseline, current, regression: current === 0 ? 0 : 1 };
      continue;
    }
    v1Comparison[metric] = { baseline, current, regression: (current - baseline) / baseline };
  }
  return {
    id: scenario.id,
    fixture_id: fixture.id,
    site_class: scenario.site_class,
    fixture_sha256: scenario.fixture_sha256,
    fixture_evidence: scenario.fixture_evidence,
    sample_count: pairs.length,
    warmup_count: config.warmups,
    resource,
    site_metrics: siteMetrics,
    v1_comparison: v1Comparison,
    pairs,
  };
}

function measuredFixtureOverhead(report, metric) {
  const siteMetric = { dcl_delta: "dcl_ms", lcp_delta: "lcp_ms", cpu_delta: "cpu_ms" }[metric];
  invariant(siteMetric, `unknown V1 aggregate metric ${metric}`, "measurement_unavailable");
  const deltas = report.pairs.map(pair =>
    siteDelta(pair.native.site_metrics[siteMetric], pair.mediated.site_metrics[siteMetric], siteMetric));
  return Math.max(0, nearestRank(deltas, 0.95));
}

export function evaluateV1AggregateEvidence(fixtureReports, config, violations = []) {
  if (fixtureReports.length === 0)
    return { status: "not-measured", fixture_count: 0, geometric_mean_overhead_reduction: null, non_worse_fixture_fraction: null, class_p95_regression: {} };
  const fixtureByID = new Map(config.fixtures.map(fixture => [fixture.id, fixture]));
  const comparisons = fixtureReports.flatMap(report =>
    config.v1_aggregate.metrics.map(metric => {
      const baseline = fixtureByID.get(report.fixture_id)?.v1_baseline?.[metric];
      const current = measuredFixtureOverhead(report, metric);
      const zeroBaseline = baseline === 0;
      return {
        baseline,
        current,
        regression: zeroBaseline ? (current === 0 ? 0 : 1) : (current - baseline) / baseline,
        zero_baseline_regressed: zeroBaseline && current > 0,
        fixture_id: report.fixture_id,
        site_class: report.site_class,
        metric,
      };
    }));
  const valid = comparisons.filter(value => Number.isFinite(value.baseline) && value.baseline >= 0 && Number.isFinite(value.current));
  if (valid.length !== comparisons.length)
    return { status: "fail", fixture_count: fixtureReports.length, geometric_mean_overhead_reduction: null, non_worse_fixture_fraction: null, class_p95_regression: {} };
  const ratios = valid.filter(value => value.baseline > 0).map(value => value.current === 0 ? Number.EPSILON : value.current / value.baseline);
  const geometricMeanRatio = ratios.length === 0 ? 1 : Math.exp(ratios.reduce((sum, value) => sum + Math.log(value), 0) / ratios.length);
  const reduction = 1 - geometricMeanRatio;
  const nonWorse = fixtureReports.filter(report =>
    valid.filter(value => value.fixture_id === report.fixture_id).every(value => value.regression <= 0)).length / fixtureReports.length;
  const classP95Regression = {};
  for (const siteClass of Object.keys(config.site_classes)) {
    const regressions = valid.filter(value => value.site_class === siteClass).map(value => value.regression);
    classP95Regression[siteClass] = nearestRank(regressions, 0.95);
  }
  const policy = config.v1_aggregate;
  invariant(policy.zero_baseline_policy === "must-remain-zero", "V1 zero-baseline policy is missing", "invalid_config");
  for (const comparison of valid.filter(value => value.zero_baseline_regressed)) {
    const recorded = violations.some(violation => violation.code === "v1_zero_baseline_regressed" && violation.fixture_id === comparison.fixture_id && violation.metric === comparison.metric);
    if (!recorded) violations.push({ code: "v1_zero_baseline_regressed", fixture_id: comparison.fixture_id, metric: comparison.metric, observed: comparison.current, limit: 0 });
  }
  if (reduction < policy.geometric_mean_overhead_reduction_min)
    violations.push({ code: "v1_geometric_mean_improvement_insufficient", observed: reduction, limit: policy.geometric_mean_overhead_reduction_min });
  if (nonWorse < policy.non_worse_fixture_fraction_min)
    violations.push({ code: "v1_non_worse_fixture_fraction_insufficient", observed: nonWorse, limit: policy.non_worse_fixture_fraction_min });
  for (const [siteClass, regression] of Object.entries(classP95Regression))
    if (regression > policy.class_p95_regression_max)
      violations.push({ code: "v1_class_p95_regression_exceeded", site_class: siteClass, observed: regression, limit: policy.class_p95_regression_max });
  const failed = violations.some(violation => violation.code.startsWith("v1_"));
  return {
    status: failed ? "fail" : "pass",
    fixture_count: fixtureReports.length,
    geometric_mean_overhead_reduction: reduction,
    non_worse_fixture_fraction: nonWorse,
    class_p95_regression: classP95Regression,
  };
}

function isoNow(now) {
  const value = now();
  invariant(value instanceof Date && !Number.isNaN(value.valueOf()), "clock must return a valid Date");
  return value.toISOString();
}

/**
 * Adapter contract: describe() returns {browser:{family,exact_build}, resource_limits};
 * enumerateScenarios() returns one scenario for every configured gate and deterministic fixture;
 * measurePair({scenario, phase, iteration}) returns native and mediated measurements.
 */
async function collectScenarioReports({ scenarios, config, context, measurePair, limits, seed, violations, invalidations }) {
  const gateReports = [];
  const fixtureReports = [];
  for (const scenario of scenarios) {
    for (let iteration = 0; iteration < config.warmups; iteration += 1) {
      const order = iteration % 2 === 0 ? "native-first" : "mediated-first";
      normalizePair(await measurePair({ scenario, phase: "warmup", iteration, order, context }), `${scenario.id} warmup ${iteration}`);
    }
    const pairs = [];
    for (let iteration = 0; iteration < config.measured_pairs; iteration += 1) {
      const order = (iteration + config.warmups) % 2 === 0 ? "native-first" : "mediated-first";
      const pair = await measurePair({ scenario, phase: "measured", iteration, order, context });
      pairs.push(normalizePair(pair, `${scenario.id} measured ${iteration}`));
    }
    if (scenario.kind === "fixture")
      fixtureReports.push(fixtureReport({ scenario, pairs, config, limits, violations }));
    else
      gateReports.push(reportScenario({ scenario, pairs, config, limits, seed, violations, invalidations }));
  }
  return { gateReports, fixtureReports };
}

async function executePerformanceGate({
  config,
  configSha256 = canonicalDigest(config),
  browserBoundary = null,
  build,
  adapter,
  now = () => new Date(),
  testMode = false,
}) {
  invariant(config && build && adapter, "performance gate requires config, build, and adapter");
  const describe = requireFunction(adapter.describe, "describe");
  const enumerateScenarios = requireFunction(adapter.enumerateScenarios, "enumerateScenarios");
  const measurePair = requireFunction(adapter.measurePair, "measurePair");
  const context = {
    release: { release_id: config.release_id, performance_config_sha256: configSha256, build_tree_sha256: build.tree_sha256 },
    build,
    test_mode: testMode,
  };
  const environment = await describe(context);
  invariant(environment && typeof environment === "object", "performance adapter describe() must return an object", "adapter_invalid");
  const browserPin = verifyBrowserPin({ config, browser: environment.browser, boundary: browserBoundary, testMode });
  const limits = normalizeLimits(environment.resource_limits);
  const scenarios = validateScenarios(await enumerateScenarios(context), config);
  const violations = [];
  const invalidations = [];
  const seed = canonicalDigest({ release: config.release_id, build: build.tree_sha256, gate: "performance" });
  const reports = await collectScenarioReports({
    scenarios, config, context, measurePair, limits, seed, violations, invalidations,
  });

  const v1Aggregate = evaluateV1AggregateEvidence(reports.fixtureReports, config, violations);
  const status = invalidations.length > 0 ? "invalid" : violations.length === 0 ? "pass" : "fail";
  return {
    schema_version: 1,
    report_type: "performance-gate",
    generated_at: isoNow(now),
    status,
    test_mode: testMode,
    certification: productionCertification({
      testMode,
      status,
      browserPin,
      prerequisites: [
        config.fixtures?.every(fixture => fixture.availability === "available" && /^[a-f0-9]{64}$/u.test(fixture.sha256) && fixture.v1_baseline),
      ],
    }),
    release: releaseTuple(config, configSha256, build),
    environment: {
      ...runtimeIdentity(),
      browser: environment.browser,
      browser_pin: browserPin,
      adapter_toolchain: environment.toolchain ?? null,
    },
    build: { tree_sha256: build.tree_sha256, assets: build.assets },
    measurement: {
      warmups: config.warmups,
      measured_pairs: config.measured_pairs,
      bootstrap_resamples: config.bootstrap_resamples,
      bootstrap_method: "paired-mean-bootstrap-nearest-rank-v1",
      max_cv: config.variance?.max_cv ?? config.max_cv,
      resource_limits: limits,
      deterministic_seed: seed,
    },
    fixture_reports: reports.fixtureReports,
    v1_aggregate: v1Aggregate,
    scenarios: reports.gateReports,
    invalidations,
    violations,
  };
}
export async function runPerformanceGate(options) {
  const adapter = options?.adapter;
  try {
    return await executePerformanceGate(options);
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
    warmups: 1,
    measured_pairs: 3,
    bootstrap_resamples: 10_000,
    max_cv: 0.1,
    gates: {
      content_p95_ms: 100,
      application_p95_ms: 100,
      editor_p95_ms: 100,
    },
    site_classes: {
      content: { dcl_delta: 0.1, lcp_delta: 0.1, inp_delta_ms: 20, cpu_delta: 0.1 },
      application: { dcl_delta: 0.1, lcp_delta: 0.1, inp_delta_ms: 20, cpu_delta: 0.1 },
      editor_media_pwa: { dcl_delta: 0.1, lcp_delta: 0.1, inp_delta_ms: 20, cpu_delta: 0.1 },
    },
    soak: { hours: 8, warmup_minutes: 30, quiescence_minutes: 15, origins: 20, clients: 40, short_streams: 200, sse_streams: 20, websockets: 20, abort_churn: 0.1 },
  };
}

function selfTestAdapter() {
  const fixtureSha256 = "a".repeat(64);
  const fixtureEvidence = { status: "verified", verified: true, tree_sha256: fixtureSha256, asset_count: 1, served_from_snapshot: true, entry_path: "self-test.html" };
  const scenarios = [
    { id: "content", gate: "content_p95_ms", site_class: "content", fixture_sha256: fixtureSha256, fixture_evidence: fixtureEvidence },
    { id: "application", gate: "application_p95_ms", site_class: "application", fixture_sha256: fixtureSha256, fixture_evidence: fixtureEvidence },
    { id: "editor", gate: "editor_p95_ms", site_class: "editor_media_pwa", fixture_sha256: fixtureSha256, fixture_evidence: fixtureEvidence },
  ];
  return {
    async describe() {
      return { browser: { family: "test-browser", exact_build: "1.0.0" }, resource_limits: { max_memory_bytes: 1024, max_queue_depth: 8 }, toolchain: { kind: "deterministic-self-test" } };
    },
    async enumerateScenarios() { return scenarios; },
    async measurePair({ iteration }) {
      // Execute a fixed CPU workload so the self-test drives the same paired runner path.
      let accumulator = 0;
      for (let value = 0; value < 200; value += 1) accumulator = (accumulator + value + iteration) % 97;
      const nativeValue = 1 + accumulator / 10_000;
      return {
        native: { value: nativeValue, memory_bytes: 256, queue_depth: 1, site_metrics: { dcl_ms: 10, lcp_ms: 12, inp_ms: 2, cpu_ms: 4 } },
        mediated: { value: nativeValue + 0.01, memory_bytes: 300, queue_depth: 1, site_metrics: { dcl_ms: 10.1, lcp_ms: 12.1, inp_ms: 2.5, cpu_ms: 4.1 } },
      };
    },
  };
}

export async function runPerformanceSelfTest() {
  return withTemporaryDirectory("zeroproxy-performance-self-test", async root => {
    await writeFile(path.join(root, "current-build.bin"), "self-test build input\n", "utf8");
    const report = await runPerformanceGate({
      config: selfTestConfig(),
      build: await collectBuildIdentity(root),
      adapter: selfTestAdapter(),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      testMode: true,
    });
    invariant(report.status === "pass", "performance self-test did not pass", "self_test_failed");
    invariant(report.certification.claimed === false, "performance self-test must never claim certification", "self_test_failed");
    return { self_test: "performance", status: "pass", certification_claimed: false, report_sha256: canonicalDigest(report) };
  });
}

function help() {
  return [
    "Usage: node scripts/gates/performance.mjs --adapter <module.mjs> --build-dir <dir> --output <report.json> [options]",
    "",
    "The adapter exports createPerformanceEvidenceAdapter(context), then implements describe(), enumerateScenarios(), and measurePair().",
    "Options:",
    "  --config <path>      Performance configuration (default: protocol/performance-gates.json)",
    "  --boundary <path>    Browser boundary declaration (default: protocol/browser-boundaries.json)",
    "  --test-mode          Mark a short/test configuration as non-certifying",
    "  --self-test          Run a deterministic non-certifying runner exercise",
    "  --help               Show this help",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ["help", "self-test", "test-mode"],
    values: ["adapter", "build-dir", "output", "config", "boundary"],
  });
  invariant(args._.length === 0, "unexpected positional arguments", "invalid_cli");
  if (args.help) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  if (args["self-test"]) {
    invariant(!args.adapter && !args["build-dir"] && !args.output, "--self-test cannot be combined with adapter, build, or output options", "invalid_cli");
    process.stdout.write(canonicalJson(await runPerformanceSelfTest()));
    return;
  }
  const base = moduleDirectory(import.meta.url);
  const configPath = args.config ?? path.resolve(base, "../../protocol/performance-gates.json");
  const boundaryPath = args.boundary ?? path.resolve(base, "../../protocol/browser-boundaries.json");
  const testMode = args["test-mode"] === true;
  const { config, configSha256 } = await loadPerformanceConfig(configPath, { testMode });
  const factory = await loadAdapter(args.adapter, "createPerformanceEvidenceAdapter");
  const build = await collectBuildIdentity(args["build-dir"]);
  const adapter = await factory({ config, build, test_mode: testMode });
  const report = await runPerformanceGate({
    config,
    configSha256,
    browserBoundary: await loadBrowserBoundaries(boundaryPath),
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
    process.stderr.write(`performance gate failed: ${message}\n`);
    process.exitCode = 1;
  });
}
