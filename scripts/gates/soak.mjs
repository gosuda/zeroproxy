import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import {
  GateFailure,
  canonicalDigest,
  canonicalJson,
  collectBuildIdentity,
  finiteNonnegative,
  invariant,
  loadAdapter,
  loadBrowserBoundaries,
  loadPerformanceConfig,
  moduleDirectory,
  parseArgs,
  releaseTuple,
  reportCommandSummary,
  runtimeIdentity,
  seededRandom,
  verifyBrowserPin,
  productionCertification,
  withTemporaryDirectory,
  writeCanonicalReport,
} from "./common.mjs";

const PRODUCTION_SHAPE = Object.freeze({
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
});
const FAULT_KINDS = Object.freeze(["connection-reset", "stalled-upstream", "origin-restart", "truncated-response"]);
const OWNED_COUNT_FIELDS = Object.freeze(["route", "port", "stream", "worker", "realm"]);

function normalizedTelemetry(value, label) {
  const telemetry = {
    fd_count: finiteNonnegative(value.fd_count, `${label}.fd_count`),
    goroutine_count: finiteNonnegative(value.goroutine_count, `${label}.goroutine_count`),
  };
  for (const owner of OWNED_COUNT_FIELDS)
    telemetry[`${owner}_count`] = finiteNonnegative(value[`${owner}_count`], `${label}.${owner}_count`);
  return telemetry;
}

function normalizeBounds(soak) {
  invariant(Number.isFinite(soak.max_memory_bytes) && soak.max_memory_bytes > 0, "performance config soak.max_memory_bytes is required for a bounded soak gate", "resource_limits_missing");
  invariant(Number.isFinite(soak.max_queue_depth) && soak.max_queue_depth > 0, "performance config soak.max_queue_depth is required for a bounded soak gate", "resource_limits_missing");
  return { max_memory_bytes: soak.max_memory_bytes, max_queue_depth: soak.max_queue_depth };
}

function validateProductionShape(config, short) {
  if (short) return;
  for (const [key, expected] of Object.entries(PRODUCTION_SHAPE))
    invariant(config.soak[key] === expected, `production soak shape must retain configured ${key}=${expected}`, "invalid_config");
}

function soakTiming(config, short, testOptions) {
  return {
    duration: short ? (testOptions.duration_ms ?? 80) : config.soak.hours * 60 * 60 * 1000,
    warmup: short ? (testOptions.warmup_ms ?? 20) : config.soak.warmup_minutes * 60 * 1000,
    quiescence: short ? (testOptions.quiescence_ms ?? 20) : config.soak.quiescence_minutes * 60 * 1000,
    sampleInterval: short ? (testOptions.sample_interval_ms ?? 10) : 30_000,
    churnInterval: short ? (testOptions.churn_interval_ms ?? 20) : 60_000,
    faultInterval: short ? (testOptions.fault_interval_ms ?? 30) : 300_000,
  };
}

function buildPlan(config, { short = false, testOptions = {} } = {}) {
  invariant(!short || testOptions !== null, "short soak requires test options", "invalid_input");
  validateProductionShape(config, short);
  const timing = soakTiming(config, short, testOptions);
  for (const [name, value] of Object.entries(timing))
    invariant(Number.isFinite(value) && value > 0, `invalid soak ${name}`, "invalid_config");
  return {
    shape: { ...PRODUCTION_SHAPE },
    duration_ms: timing.duration,
    warmup_ms: timing.warmup,
    quiescence_ms: timing.quiescence,
    sample_interval_ms: timing.sampleInterval,
    churn_interval_ms: timing.churnInterval,
    fault_interval_ms: timing.faultInterval,
    short,
  };
}

function normalizeSample(value, phase, elapsedMs) {
  invariant(value && typeof value === "object", "soak adapter sample() must return an object", "adapter_invalid");
  return {
    phase,
    elapsed_ms: elapsedMs,
    memory_bytes: finiteNonnegative(value.memory_bytes, "soak sample.memory_bytes"),
    queue_depth: finiteNonnegative(value.queue_depth, "soak sample.queue_depth"),
    active_clients: finiteNonnegative(value.active_clients, "soak sample.active_clients"),
    active_origins: finiteNonnegative(value.active_origins, "soak sample.active_origins"),
    active_streams: finiteNonnegative(value.active_streams, "soak sample.active_streams"),
    ...normalizedTelemetry(value, "soak sample"),
  };
}

function requireCompleted(value, action, allowedStatuses) {
  invariant(value && typeof value === "object" && allowedStatuses.includes(value.status), `soak adapter ${action}() must return one of ${allowedStatuses.join(", ")}`, "adapter_invalid");
  return value;
}

function isoNow(now) {
  const value = now();
  invariant(value instanceof Date && !Number.isNaN(value.valueOf()), "wall clock must return a valid Date");
  return value.toISOString();
}

function monotonicClock(clock) {
  invariant(clock && typeof clock.now === "function" && typeof clock.sleep === "function", "soak clock must implement now() and sleep()");
  return clock;
}

async function collectPhaseSample({ adapter, phase, elapsedMs, limits, plan, samples, violations }) {
  const sample = normalizeSample(await adapter.sample({ phase, elapsed_ms: elapsedMs }), phase, elapsedMs);
  samples.push(sample);
  if (sample.memory_bytes > limits.max_memory_bytes)
    violations.push({ code: "memory_limit_exceeded", phase, elapsed_ms: sample.elapsed_ms, observed: sample.memory_bytes, limit: limits.max_memory_bytes });
  if (sample.queue_depth > limits.max_queue_depth)
    violations.push({ code: "queue_limit_exceeded", phase, elapsed_ms: sample.elapsed_ms, observed: sample.queue_depth, limit: limits.max_queue_depth });
  if (phase !== "quiescence") {
    const expected = { active_clients: plan.shape.clients, active_origins: plan.shape.origins, active_streams: plan.shape.sse_streams + plan.shape.websockets };
    for (const [field, value] of Object.entries(expected))
      if (sample[field] !== value) violations.push({ code: "soak_workload_shape_mismatch", phase, field, observed: sample[field], expected: value });
  }
}

async function collectChurn({ adapter, phase, elapsedMs, plan, churnEvents }) {
  const outcome = requireCompleted(await adapter.churn({
    phase,
    abort_fraction: plan.shape.abort_churn,
    clients: plan.shape.clients,
    short_streams: plan.shape.short_streams,
  }), "churn", ["completed"]);
  churnEvents.push({ phase, elapsed_ms: elapsedMs, status: outcome.status, details: outcome.details ?? null });
}

async function collectFault({ adapter, phase, elapsedMs, random, faultEvents }) {
  const kind = FAULT_KINDS[Math.floor(random() * FAULT_KINDS.length)];
  const outcome = requireCompleted(await adapter.injectFault({ phase, kind }), "injectFault", ["injected"]);
  faultEvents.push({ phase, elapsed_ms: elapsedMs, kind, status: outcome.status, details: outcome.details ?? null });
}

async function runPhase({ adapter, clock, phase, durationMs, sampleIntervalMs, churnIntervalMs, faultIntervalMs, plan, limits, random, samples, churnEvents, faultEvents, violations }) {
  const phaseStart = clock.now();
  const phaseDeadline = phaseStart + durationMs;
  let nextSample = phaseStart;
  let nextChurn = churnIntervalMs === null ? Number.POSITIVE_INFINITY : phaseStart + churnIntervalMs;
  let nextFault = faultIntervalMs === null ? Number.POSITIVE_INFINITY : phaseStart + faultIntervalMs;
  while (clock.now() < phaseDeadline) {
    const current = clock.now();
    const elapsedMs = current - phaseStart;
    if (current >= nextSample) {
      await collectPhaseSample({ adapter, phase, elapsedMs, limits, plan, samples, violations });
      nextSample += sampleIntervalMs;
      continue;
    }
    if (current >= nextChurn) {
      await collectChurn({ adapter, phase, elapsedMs, plan, churnEvents });
      nextChurn += churnIntervalMs;
      continue;
    }
    if (current >= nextFault) {
      await collectFault({ adapter, phase, elapsedMs, random, faultEvents });
      nextFault += faultIntervalMs;
      continue;
    }
    const next = Math.min(phaseDeadline, nextSample, nextChurn, nextFault);
    await clock.sleep(Math.max(1, next - current));
  }
}

function slopePerHour(samples, field) {
  if (samples.length < 2) return Number.POSITIVE_INFINITY;
  const meanX = samples.reduce((sum, sample) => sum + sample.elapsed_ms, 0) / samples.length;
  const meanY = samples.reduce((sum, sample) => sum + sample[field], 0) / samples.length;
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    const x = sample.elapsed_ms - meanX;
    numerator += x * (sample[field] - meanY);
    denominator += x * x;
  }
  return denominator === 0 ? Number.POSITIVE_INFINITY : (numerator / denominator) * 3_600_000;
}

function growthViolation(violations, code, observed, limit) {
  if (observed > limit) violations.push({ code, observed, limit });
}

export function evaluateSoakLeakEvidence(samples, terminal, policy) {
  const warm = samples.filter(sample => sample.phase === "warmup").at(-1);
  const soak = samples.filter(sample => sample.phase === "soak");
  const quiescence = samples.filter(sample => sample.phase === "quiescence");
  if (!warm || soak.length < 2 || quiescence.length < 2)
    return { status: "fail", violations: [{ code: "soak_leak_samples_incomplete" }], baseline: warm ?? null, slopes: null };
  const slopes = {
    memory_bytes_per_hour: slopePerHour(soak, "memory_bytes"),
    fd_per_hour: slopePerHour(soak, "fd_count"),
    goroutine_per_hour: slopePerHour(soak, "goroutine_count"),
  };
  const violations = [];
  const memoryGrowthLimit = Math.max(warm.memory_bytes * policy.rss_growth_relative_max, policy.rss_growth_bytes_floor);
  growthViolation(violations, "soak_rss_growth_exceeded", terminal.memory_bytes - warm.memory_bytes, memoryGrowthLimit);
  growthViolation(violations, "soak_fd_growth_exceeded", terminal.fd_count - warm.fd_count, policy.fd_growth_max);
  growthViolation(violations, "soak_goroutine_growth_exceeded", terminal.goroutine_count - warm.goroutine_count, policy.goroutine_growth_max);
  growthViolation(violations, "soak_rss_slope_exceeded", slopes.memory_bytes_per_hour, policy.rss_slope_bytes_per_hour_max);
  growthViolation(violations, "soak_fd_slope_exceeded", slopes.fd_per_hour, policy.fd_slope_per_hour_max);
  growthViolation(violations, "soak_goroutine_slope_exceeded", slopes.goroutine_per_hour, policy.goroutine_slope_per_hour_max);
  for (const owner of OWNED_COUNT_FIELDS) {
    const field = `${owner}_count`;
    if (terminal[field] !== 0) violations.push({ code: "soak_owned_count_not_zero", owner, observed: terminal[field] });
    if (quiescence.at(-1)[field] > quiescence[0][field])
      violations.push({ code: "soak_post_stop_counter_growth", owner, first: quiescence[0][field], last: quiescence.at(-1)[field] });
  }
  if (policy.no_post_stop_monotonic_growth)
    for (const field of ["fd_count", "goroutine_count"])
      if (quiescence.at(-1)[field] > quiescence[0][field])
        violations.push({ code: "soak_post_stop_counter_growth", owner: field, first: quiescence[0][field], last: quiescence.at(-1)[field] });
  return {
    status: violations.length === 0 ? "pass" : "fail",
    violations,
    baseline: { memory_bytes: warm.memory_bytes, fd_count: warm.fd_count, goroutine_count: warm.goroutine_count },
    terminal: { memory_bytes: terminal.memory_bytes, fd_count: terminal.fd_count, goroutine_count: terminal.goroutine_count },
    slopes,
  };
}

function terminalViolations(terminal) {
  invariant(terminal && typeof terminal === "object", "soak adapter terminalState() must return an object", "adapter_invalid");
  const normalized = {
    all_terminal: terminal.all_terminal === true,
    outstanding_requests: finiteNonnegative(terminal.outstanding_requests, "terminalState.outstanding_requests"),
    active_streams: finiteNonnegative(terminal.active_streams, "terminalState.active_streams"),
    unrecovered_errors: finiteNonnegative(terminal.unrecovered_errors, "terminalState.unrecovered_errors"),
    memory_bytes: finiteNonnegative(terminal.memory_bytes, "terminalState.memory_bytes"),
    ...normalizedTelemetry(terminal, "terminalState"),
  };
  const violations = [];
  if (!normalized.all_terminal) violations.push({ code: "terminal_state_incomplete" });
  if (normalized.outstanding_requests !== 0) violations.push({ code: "terminal_outstanding_requests" , observed: normalized.outstanding_requests });
  if (normalized.active_streams !== 0) violations.push({ code: "terminal_active_streams", observed: normalized.active_streams });
  if (normalized.unrecovered_errors !== 0) violations.push({ code: "terminal_unrecovered_errors", observed: normalized.unrecovered_errors });
  return { terminal: normalized, violations };
}

/**
 * Adapter contract: describe(), start(), sample(), churn(), injectFault(), quiesce(), and terminalState().
 * The adapter owns its concrete browser/network workload; this runner owns the fixed production shape,
 * deterministic churn/fault schedule, bounds, and terminal-state checks.
 */
async function executeSoakGate({
  config,
  configSha256 = canonicalDigest(config),
  browserBoundary = null,
  build,
  adapter,
  seed = null,
  now = () => new Date(),
  clock = { now: () => Date.now(), sleep },
  testMode = false,
  short = false,
  testOptions = {},
}) {
  invariant(config && build && adapter, "soak gate requires config, build, and adapter");
  invariant(!short || testMode, "short soak execution is always test-mode", "invalid_input");
  for (const method of ["describe", "start", "sample", "churn", "injectFault", "quiesce", "terminalState"])
    invariant(typeof adapter[method] === "function", `soak adapter must implement ${method}()`, "adapter_invalid");
  const plan = buildPlan(config, { short, testOptions });
  const limits = normalizeBounds(config.soak);
  const timer = monotonicClock(clock);
  const context = { build, release: releaseTuple(config, configSha256, build), plan, test_mode: testMode };
  const environment = await adapter.describe(context);
  invariant(environment && typeof environment === "object", "soak adapter describe() must return an object", "adapter_invalid");
  const browserPin = verifyBrowserPin({ config, browser: environment.browser, boundary: browserBoundary, testMode });
  const deterministicSeed = seed ?? canonicalDigest({ release: config.release_id, build: build.tree_sha256, gate: "soak" });
  invariant(typeof deterministicSeed === "string" && /^[a-f0-9]{64}$/.test(deterministicSeed), "soak seed must be a 64-character lowercase hexadecimal digest", "invalid_input");
  const random = seededRandom(deterministicSeed);
  const samples = [];
  const churnEvents = [];
  const faultEvents = [];
  const violations = [];
  let terminal;

  requireCompleted(await adapter.start({ shape: plan.shape, seed: deterministicSeed, context }), "start", ["started"]);
  await runPhase({ adapter, clock: timer, phase: "warmup", durationMs: plan.warmup_ms, sampleIntervalMs: plan.sample_interval_ms, churnIntervalMs: null, faultIntervalMs: null, plan, limits, random, samples, churnEvents, faultEvents, violations });
  await runPhase({ adapter, clock: timer, phase: "soak", durationMs: plan.duration_ms, sampleIntervalMs: plan.sample_interval_ms, churnIntervalMs: plan.churn_interval_ms, faultIntervalMs: plan.fault_interval_ms, plan, limits, random, samples, churnEvents, faultEvents, violations });
  requireCompleted(await adapter.quiesce({ duration_ms: plan.quiescence_ms, context }), "quiesce", ["quiescing", "completed"]);
  await runPhase({ adapter, clock: timer, phase: "quiescence", durationMs: plan.quiescence_ms, sampleIntervalMs: plan.sample_interval_ms, churnIntervalMs: null, faultIntervalMs: null, plan, limits, random, samples, churnEvents, faultEvents, violations });
  const terminalOutcome = terminalViolations(await adapter.terminalState({ context }));
  terminal = terminalOutcome.terminal;
  violations.push(...terminalOutcome.violations);
  const leakEvidence = short
    ? { status: "not-measured", violations: [], baseline: null, terminal: null, slopes: null }
    : evaluateSoakLeakEvidence(samples, terminal, config.leak_tolerances.soak);
  violations.push(...leakEvidence.violations);

  const memoryMaximum = Math.max(...samples.map(sample => sample.memory_bytes));
  const queueMaximum = Math.max(...samples.map(sample => sample.queue_depth));
  const status = violations.length === 0 ? "pass" : "fail";
  return {
    schema_version: 1,
    report_type: "soak-gate",
    generated_at: isoNow(now),
    status,
    test_mode: testMode,
    certification: productionCertification({ testMode, status, browserPin }),
    release: releaseTuple(config, configSha256, build),
    environment: {
      ...runtimeIdentity(),
      browser: environment.browser,
      browser_pin: browserPin,
      adapter_toolchain: environment.toolchain ?? null,
    },
    build: { tree_sha256: build.tree_sha256, assets: build.assets },
    plan: {
      ...plan,
      resource_limits: limits,
      deterministic_seed: deterministicSeed,
      fault_kinds: FAULT_KINDS,
    },
    samples,
    resource_maxima: { memory_bytes: memoryMaximum, queue_depth: queueMaximum },
    churn_events: churnEvents,
    fault_events: faultEvents,
    terminal,
    leak_evidence: leakEvidence,
    violations,
  };
}
export async function runSoakGate(options) {
  const adapter = options?.adapter;
  try {
    return await executeSoakGate(options);
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
    soak: {
      ...PRODUCTION_SHAPE,
      max_memory_bytes: 1024,
      max_queue_depth: 8,
    },
  };
}

export async function runSoakSelfTest() {
  return withTemporaryDirectory("zeroproxy-soak-self-test", async root => {
    await writeFile(path.join(root, "current-build.bin"), "self-test build input\n", "utf8");
    let samples = 0;
    const adapter = {
      async describe() { return { browser: { family: "test-browser", exact_build: "1.0.0" }, toolchain: { kind: "deterministic-self-test" } }; },
      async start() { return { status: "started" }; },
      async sample() { samples += 1; return { memory_bytes: 128, queue_depth: 1, active_clients: 1, active_origins: 1, active_streams: 1, fd_count: 1, goroutine_count: 1, route_count: 1, port_count: 1, stream_count: 1, worker_count: 1, realm_count: 1 }; },
      async churn() { return { status: "completed" }; },
      async injectFault() { return { status: "injected" }; },
      async quiesce() { return { status: "quiescing" }; },
      async terminalState() { return { all_terminal: false, outstanding_requests: 1, active_streams: 1, unrecovered_errors: 1, memory_bytes: 128, fd_count: 1, goroutine_count: 1, route_count: 1, port_count: 1, stream_count: 1, worker_count: 1, realm_count: 1 }; },
    };
    const report = await runSoakGate({
      config: selfTestConfig(),
      build: await collectBuildIdentity(root),
      adapter,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      testMode: true,
      short: true,
      testOptions: { duration_ms: 35, warmup_ms: 10, quiescence_ms: 10, sample_interval_ms: 5, churn_interval_ms: 10, fault_interval_ms: 10 },
    });
    invariant(samples > 0 && report.status === "fail" && report.violations.some(violation => violation.code === "terminal_state_incomplete"), "soak self-test did not reject terminal-state leak", "self_test_failed");
    return { self_test: "soak-terminal-invariant-fails-closed", status: "pass", certification_claimed: false, sample_count: samples };
  });
}

function help() {
  return [
    "Usage: node scripts/gates/soak.mjs --adapter <module.mjs> --build-dir <dir> --output <report.json> [options]",
    "",
    "The adapter exports createSoakEvidenceAdapter(context), then implements describe(), start(), sample(), churn(), injectFault(), quiesce(), and terminalState().",
    "Production reads the immutable eight-hour shape from protocol/performance-gates.json and fails closed without configured memory/queue limits.",
    "Options:",
    "  --config <path>      Performance configuration (default: protocol/performance-gates.json)",
    "  --boundary <path>    Browser boundary declaration (default: protocol/browser-boundaries.json)",
    "  --seed <sha256>      Deterministic 64-hex seed (default derives from release/build tuple)",
    "  --short              Run only a non-certifying short test configuration",
    "  --test-mode          Mark supplied test configuration as non-certifying",
    "  --self-test          Exercise terminal invariant rejection in short mode",
    "  --help               Show this help",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ["help", "self-test", "test-mode", "short"],
    values: ["adapter", "build-dir", "output", "config", "boundary", "seed"],
  });
  invariant(args._.length === 0, "unexpected positional arguments", "invalid_cli");
  if (args.help) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  if (args["self-test"]) {
    invariant(!args.adapter && !args["build-dir"] && !args.output, "--self-test cannot be combined with production inputs", "invalid_cli");
    process.stdout.write(canonicalJson(await runSoakSelfTest()));
    return;
  }
  const short = args.short === true;
  const testMode = args["test-mode"] === true || short;
  const base = moduleDirectory(import.meta.url);
  const configPath = args.config ?? path.resolve(base, "../../protocol/performance-gates.json");
  const boundaryPath = args.boundary ?? path.resolve(base, "../../protocol/browser-boundaries.json");
  const { config, configSha256 } = await loadPerformanceConfig(configPath, { testMode });
  const build = await collectBuildIdentity(args["build-dir"]);
  const factory = await loadAdapter(args.adapter, "createSoakEvidenceAdapter");
  const adapter = await factory({ config, build, test_mode: testMode, short });
  const report = await runSoakGate({
    config,
    configSha256,
    browserBoundary: await loadBrowserBoundaries(boundaryPath),
    build,
    adapter,
    seed: args.seed ?? null,
    testMode,
    short,
  });
  const destination = await writeCanonicalReport(args.output, report);
  process.stdout.write(canonicalJson(reportCommandSummary(destination, report)));
  if (report.status !== "pass") process.exitCode = 1;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch(error => {
    const message = error instanceof GateFailure ? error.message : error.stack || error.message;
    process.stderr.write(`soak gate failed: ${message}\n`);
    process.exitCode = 1;
  });
}
