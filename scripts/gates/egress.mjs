import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  GateFailure,
  canonicalDigest,
  canonicalJson,
  collectBuildIdentity,
  invariant,
  loadAdapter,
  loadBrowserBoundaries,
  loadPerformanceConfig,
  moduleDirectory,
  parseArgs,
  readJson,
  releaseTuple,
  reportCommandSummary,
  runtimeIdentity,
  verifyBrowserPin,
  validateJsonSchema,
  productionCertification,
  withTemporaryDirectory,
  writeCanonicalReport,
} from "./common.mjs";

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function normalDnsName(value) {
  return value.toLowerCase().replace(/\.$/, "");
}

function validPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}
function supportBrowserTuplesUnique(supportMatrix) {
  const records = supportMatrix?.browsers ?? [];
  const tuples = new Set(records.map(record => `${record.family}\0${record.exact_build}\0${record.platform}`));
  return records.length > 0 && tuples.size === records.length;
}
function supportBrowserCertified(supportMatrix, browser) {
  const records = supportMatrix.browsers;
  return supportBrowserTuplesUnique(supportMatrix)
    && records.some(record =>
      record.family === browser?.family
      && record.exact_build === browser?.exact_build
      && record.platform === `${process.platform}-${process.arch}`
      && record.release_supported === true
      && record.packet_capture_certified === true);
}

function validateScenario(scenario, ids, observedSurfaces) {
  invariant(scenario && typeof scenario === "object", "egress scenario must be an object");
  invariant(nonEmptyString(scenario.id), "egress scenario id is required");
  invariant(!ids.has(scenario.id), `duplicate egress scenario ${scenario.id}`);
  ids.add(scenario.id);
  invariant(Array.isArray(scenario.surfaces) && scenario.surfaces.length > 0 && scenario.surfaces.every(nonEmptyString), `egress scenario ${scenario.id} surfaces must enumerate covered support-matrix surfaces`);
  invariant(new Set(scenario.surfaces).size === scenario.surfaces.length, `egress scenario ${scenario.id} surfaces must be unique`);
  for (const surface of scenario.surfaces) observedSurfaces.add(surface);
  invariant(nonEmptyString(scenario.url) && /^https?:\/\//.test(scenario.url), `egress scenario ${scenario.id} url must be absolute HTTP(S)`);
  invariant(scenario.target && typeof scenario.target === "object", `egress scenario ${scenario.id} target is required`);
  invariant(nonEmptyString(scenario.target.host), `egress scenario ${scenario.id} target.host is required`);
  invariant(Array.isArray(scenario.target.ports) && scenario.target.ports.length > 0 && scenario.target.ports.every(validPort), `egress scenario ${scenario.id} target.ports must contain valid ports`);
  invariant(Array.isArray(scenario.allowed_dns) && scenario.allowed_dns.every(nonEmptyString), `egress scenario ${scenario.id} allowed_dns must be an array of names`);
  invariant(Array.isArray(scenario.expected_assertions) && scenario.expected_assertions.length > 0 && scenario.expected_assertions.every(nonEmptyString), `egress scenario ${scenario.id} expected_assertions must enumerate observable contracts`);
  invariant(new Set(scenario.expected_assertions).size === scenario.expected_assertions.length, `egress scenario ${scenario.id} expected_assertions must be unique`);
  invariant(scenario.surfaces.every(surface => scenario.expected_assertions.includes(`surface:${surface}`)), `egress scenario ${scenario.id} must assert each declared surface`, "manifest_incomplete");
  invariant(Number.isInteger(scenario.settle_ms) && scenario.settle_ms >= 500 && scenario.settle_ms <= 10_000, `egress scenario ${scenario.id} settle_ms must be between 500 and 10000`);
  invariant(!scenario.allowed_dns.map(normalDnsName).includes(normalDnsName(scenario.target.host)), `egress scenario ${scenario.id} must not allow direct target DNS`);
}

function validateSupportCoverage(manifest, supportMatrix, observedSurfaces) {
  invariant(supportMatrix && supportMatrix.release_id === manifest.release_id, "support matrix is required and must match the egress release_id", "release_mismatch");
  invariant(supportBrowserTuplesUnique(supportMatrix), "support matrix browser tuples must be nonempty and unique", "manifest_invalid");
  invariant(Array.isArray(supportMatrix.egress_surfaces) && supportMatrix.egress_surfaces.length > 0, "support matrix must enumerate egress surfaces", "manifest_invalid");
  const expectedSurfaces = [...new Set(supportMatrix.egress_surfaces)];
  invariant(expectedSurfaces.length === supportMatrix.egress_surfaces.length && expectedSurfaces.every(nonEmptyString), "support matrix egress surfaces must be nonempty and unique", "manifest_invalid");
  invariant(observedSurfaces.size === expectedSurfaces.length && expectedSurfaces.every(surface => observedSurfaces.has(surface)), "egress scenarios must cover every support-matrix surface exactly without undeclared surfaces", "manifest_incomplete");
}

function validateManifest(manifest, supportMatrix) {
  invariant(manifest && typeof manifest === "object" && !Array.isArray(manifest), "egress scenario manifest must be an object");
  invariant(manifest.schema_version === 1, "unsupported egress scenario manifest schema_version");
  invariant(nonEmptyString(manifest.release_id), "egress scenario manifest release_id is required");
  invariant(Array.isArray(manifest.scenarios) && manifest.scenarios.length > 0, "egress scenario manifest must enumerate at least one scenario");
  const ids = new Set();
  const observedSurfaces = new Set();
  for (const scenario of manifest.scenarios) validateScenario(scenario, ids, observedSurfaces);
  validateSupportCoverage(manifest, supportMatrix, observedSurfaces);
  return manifest;
}

async function runProcess(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => reject(new GateFailure(`cannot execute ${executable}: ${error.message}`, "capture_unavailable")));
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function waitForExit(child) {
  return new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
}

function endpoint(value) {
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;
  const port = Number(value.slice(dot + 1));
  if (!Number.isInteger(port)) return null;
  return { ip: value.slice(0, dot), port };
}

function parseTcpdump(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const match = line.match(/\bIP6?\s+(.+?)\s+>\s+(.+?):\s*(.*)$/);
    if (!match) continue;
    const source = endpoint(match[1]);
    const destination = endpoint(match[2]);
    if (!source || !destination) continue;
    const detail = match[3];
    const dns = destination.port === 53 && detail.match(/\b(?:A|AAAA|CNAME|HTTPS|MX|NS|PTR|SOA|SRV|TXT)\?\s+([^\s,]+)/i);
    if (destination.port === 53) {
      if (dns) events.push({ kind: "dns", query_name: normalDnsName(dns[1]), resolver_ip: destination.ip, resolver_port: destination.port });
      else events.push({ kind: "dns-unparsed", resolver_ip: destination.ip, resolver_port: destination.port, summary: detail });
      continue;
    }
    const protocol = /\bFlags\s*\[|\bseq\s+\d+/i.test(detail) ? "tcp" : "udp";
    events.push({ kind: "packet", protocol, source_ip: source.ip, source_port: source.port, destination_ip: destination.ip, destination_port: destination.port });
  }
  return events;
}

function buildBpfFilter(targetIps) {
  invariant(Array.isArray(targetIps) && targetIps.length > 0, "capture requires resolved target IPs", "capture_invalid");
  const targetFilter = targetIps.map(ip => `host ${ip}`).join(" or ");
  return `(udp port 53 or tcp port 53) or (${targetFilter})`;
}

export class TcpdumpCaptureBackend {
  constructor({ executable = "tcpdump" } = {}) {
    this.executable = executable;
    this.isRealCaptureBackend = true;
  }

  async preflight({ interfaceName }) {
    invariant(nonEmptyString(interfaceName), "--interface is required for packet capture", "capture_unavailable");
    const version = await runProcess(this.executable, ["--version"]);
    invariant(version.code === 0, `tcpdump preflight failed: ${version.stderr || version.stdout}`, "capture_unavailable");
    return { executable: this.executable, version: (version.stdout || version.stderr).trim() };
  }

  async start({ interfaceName, targetIps, captureDir, scenarioId, backend }) {
    await mkdir(captureDir, { recursive: true, mode: 0o700 });
    const pcapPath = path.join(captureDir, `${scenarioId.replace(/[^A-Za-z0-9_.-]/g, "_")}.pcap`);
    const filter = buildBpfFilter(targetIps);
    const child = spawn(this.executable, ["-U", "-w", pcapPath, "-i", interfaceName, "-nn", "-s", "0", filter], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    const exited = waitForExit(child);
    const startup = await Promise.race([
      new Promise(resolve => setTimeout(() => resolve(null), 125)),
      exited,
      new Promise((_, reject) => child.once("error", error => reject(new GateFailure(`cannot start tcpdump: ${error.message}`, "capture_unavailable")))),
    ]);
    invariant(startup === null, `tcpdump exited before capture started: ${stderr}`, "capture_unavailable");
    return { child, exited, stderr: () => stderr, pcap_path: pcapPath, filter, backend, started_at: new Date().toISOString() };
  }

  async stop(session) {
    if (session.child.exitCode === null && !session.child.killed) session.child.kill("SIGINT");
    const result = await session.exited;
    invariant(result.code === 0 || result.signal === "SIGINT", `tcpdump capture failed: ${session.stderr()}`, "capture_unavailable");
    let pcap;
    try {
      pcap = await readFile(session.pcap_path);
    } catch (error) {
      throw new GateFailure(`tcpdump did not produce a packet capture: ${error.message}`, "capture_unavailable");
    }
    invariant(pcap.byteLength >= 24, "tcpdump packet capture is truncated", "capture_unavailable");
    const decoded = await runProcess(this.executable, ["-nn", "-vvv", "-r", session.pcap_path]);
    invariant(decoded.code === 0, `tcpdump could not decode packet capture: ${decoded.stderr}`, "capture_unavailable");
    return {
      pcap_path: session.pcap_path,
      pcap_sha256: createHash("sha256").update(pcap).digest("hex"),
      pcap_size_bytes: pcap.byteLength,
      filter: session.filter,
      events: parseTcpdump(decoded.stdout),
      provenance: { ...session.backend, started_at: session.started_at, stopped_at: new Date().toISOString() },
    };
  }
}

async function resolveTarget(host, resolver) {
  const results = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
  const addresses = results.flatMap(result => result.status === "fulfilled" ? result.value : []);
  const sorted = [...new Set(addresses)].sort();
  invariant(sorted.length > 0, `could not resolve target ${host} to an IP address`, "target_unresolved");
  return sorted;
}

function validateCaptureEvidence({ capture, scenario, targetIps }) {
  invariant(capture && typeof capture === "object", `capture for ${scenario.id} is missing`, "capture_invalid");
  invariant(Array.isArray(capture.events), `capture for ${scenario.id} did not return parsed events`, "capture_invalid");
  invariant(typeof capture.pcap_sha256 === "string" && /^[a-f0-9]{64}$/.test(capture.pcap_sha256), `capture for ${scenario.id} lacks a verified pcap hash`, "capture_invalid");
  invariant(capture.provenance && typeof capture.provenance === "object", `capture for ${scenario.id} lacks provenance`, "capture_invalid");
  invariant(typeof capture.filter === "string" && capture.filter.includes("port 53"), `capture for ${scenario.id} did not cover DNS`, "capture_invalid");
  for (const targetIp of targetIps)
    invariant(capture.filter.includes(targetIp), `capture for ${scenario.id} did not cover target IP ${targetIp}`, "capture_invalid");
}

function evaluateDnsEvent(event, eventIndex, allowedDns, targetName) {
  const queryName = typeof event.query_name === "string" ? normalDnsName(event.query_name) : "";
  if (!queryName) return { code: "unrecognized_capture_event", event_index: eventIndex };
  if (queryName === targetName) return { code: "direct_target_dns", event_index: eventIndex, query_name: queryName };
  if (!allowedDns.has(queryName)) return { code: "unapproved_dns", event_index: eventIndex, query_name: queryName };
  return null;
}

function evaluatePacketEvent(event, eventIndex, targetIps) {
  if (!nonEmptyString(event.destination_ip) || !validPort(event.destination_port) || !nonEmptyString(event.protocol))
    return { code: "unrecognized_capture_event", event_index: eventIndex };
  if (!targetIps.includes(event.destination_ip)
    && !(nonEmptyString(event.source_ip) && targetIps.includes(event.source_ip))) return null;
  return {
    code: "direct_target_packet",
    event_index: eventIndex,
    source_ip: event.source_ip ?? null,
    destination_ip: event.destination_ip,
    destination_port: event.destination_port,
    protocol: event.protocol,
  };
}

function evaluateCaptureEvent(event, eventIndex, targetIps, allowedDns, targetName) {
  if (!event || typeof event !== "object")
    return { code: "unrecognized_capture_event", event_index: eventIndex };
  if (event.kind === "dns") return evaluateDnsEvent(event, eventIndex, allowedDns, targetName);
  if (event.kind === "packet") return evaluatePacketEvent(event, eventIndex, targetIps);
  return { code: "unrecognized_capture_event", event_index: eventIndex };
}

function evaluateCapture({ capture, scenario, targetIps }) {
  validateCaptureEvidence({ capture, scenario, targetIps });
  const allowedDns = new Set(scenario.allowed_dns.map(normalDnsName));
  const targetName = normalDnsName(scenario.target.host);
  const violations = [];
  for (const [index, event] of capture.events.entries()) {
    const violation = evaluateCaptureEvent(event, index, targetIps, allowedDns, targetName);
    if (violation !== null) violations.push(violation);
  }
  return violations;
}

function isoNow(now) {
  const value = now();
  invariant(value instanceof Date && !Number.isNaN(value.valueOf()), "clock must return a valid Date");
  return value.toISOString();
}

/**
 * Adapter contract: describe() returns {browser:{family,exact_build}} and executeScenario()
 * executes every named manifest scenario against the supplied immutable build identity.
 * Capture is started before execution and must return a real pcap plus every parsed DNS/target flow.
 */
async function executeEgressScenario({ scenario, resolver, captureBackend, interfaceName, captureDir, backend, adapter, context }) {
  const targetIps = await resolveTarget(scenario.target.host, resolver);
  const session = await captureBackend.start({ interfaceName, targetIps, captureDir, scenarioId: scenario.id, backend });
  let execution;
  let capture;
  try {
    execution = await adapter.executeScenario({ scenario, target_ips: targetIps, context });
    invariant(execution && execution.status === "completed", `egress scenario ${scenario.id} did not complete`, "scenario_incomplete");
  } finally {
    capture = await captureBackend.stop(session);
  }
  const violations = evaluateCapture({ capture, scenario, targetIps });
  return {
    report: {
      id: scenario.id,
      url: scenario.url,
      surfaces: [...scenario.surfaces].sort(),
      target: { host: scenario.target.host, ports: [...scenario.target.ports].sort((left, right) => left - right), resolved_ips: targetIps },
      allowed_dns: [...scenario.allowed_dns].map(normalDnsName).sort(),
      execution: { status: execution.status, details: execution.details ?? null },
      capture: {
        pcap_path: capture.pcap_path,
        pcap_sha256: capture.pcap_sha256,
        pcap_size_bytes: capture.pcap_size_bytes,
        filter: capture.filter,
        provenance: capture.provenance,
        events: capture.events,
        events_sha256: canonicalDigest(capture.events),
      },
      violations,
    },
    violations: violations.map(violation => ({ scenario_id: scenario.id, ...violation })),
  };
}

async function collectEgressReports(options) {
  const reports = [];
  const violations = [];
  for (const scenario of [...options.manifest.scenarios].sort((left, right) => left.id.localeCompare(right.id))) {
    const result = await executeEgressScenario({ ...options, scenario });
    reports.push(result.report);
    violations.push(...result.violations);
  }
  return { reports, violations };
}

async function executeEgressGate({
  config,
  configSha256 = canonicalDigest(config),
  browserBoundary = null,
  manifest,
  supportMatrix = null,
  supportMatrixSha256 = supportMatrix ? canonicalDigest(supportMatrix) : null,
  manifestSha256 = canonicalDigest(manifest),
  build,
  adapter,
  captureBackend = new TcpdumpCaptureBackend(),
  captureDir,
  interfaceName,
  resolver = dns,
  now = () => new Date(),
  testMode = false,
}) {
  invariant(config && manifest && build && adapter, "egress gate requires config, manifest, build, and adapter");
  validateManifest(manifest, supportMatrix);
  invariant(manifest.release_id === config.release_id, "egress manifest release_id does not match performance configuration", "release_mismatch");
  invariant(typeof adapter.describe === "function" && typeof adapter.executeScenario === "function", "egress adapter must implement describe() and executeScenario()", "adapter_invalid");
  invariant(captureBackend && typeof captureBackend.preflight === "function" && typeof captureBackend.start === "function" && typeof captureBackend.stop === "function", "capture backend is incomplete", "capture_unavailable");
  if (!testMode) invariant(captureBackend.isRealCaptureBackend === true, "a real packet capture backend is required", "capture_unavailable");
  invariant(nonEmptyString(captureDir), "--capture-dir is required so packet captures remain evidence", "capture_unavailable");

  const context = { build, release: releaseTuple(config, configSha256, build), manifest_sha256: manifestSha256, test_mode: testMode };
  const environment = await adapter.describe(context);
  invariant(environment && typeof environment === "object", "egress adapter describe() must return an object", "adapter_invalid");
  const browserPin = verifyBrowserPin({ config, browser: environment.browser, boundary: browserBoundary, testMode });
  const backend = await captureBackend.preflight({ interfaceName, captureDir });
  invariant(backend && typeof backend === "object" && nonEmptyString(backend.executable) && nonEmptyString(backend.version), "capture backend preflight did not return executable provenance", "capture_unavailable");

  const { reports, violations: allViolations } = await collectEgressReports({
    manifest, resolver, captureBackend, interfaceName, captureDir, backend, adapter, context,
  });
    const status = allViolations.length === 0 ? "pass" : "fail";
    return {
    schema_version: 1,
    report_type: "egress-gate",
    generated_at: isoNow(now),
    status,
    test_mode: testMode,
    certification: productionCertification({
      testMode,
      status,
      browserPin,
      prerequisites: [
        config.packet_capture?.availability === "available",
        config.packet_capture?.privilege === "available",
        config.packet_capture?.certified === true,
        browserPin.packet_capture_certified === true,
        supportBrowserCertified(supportMatrix, environment.browser),
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
    manifest: {
      sha256: manifestSha256,
      scenario_count: reports.length,
      support_matrix_sha256: supportMatrixSha256,
      surfaces: [...new Set(manifest.scenarios.flatMap(scenario => scenario.surfaces))].sort(),
    },
    scenarios: reports,
    violations: allViolations,
  };
}
export async function runEgressGate(options) {
  const adapter = options?.adapter;
  try {
    return await executeEgressGate(options);
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

export async function runEgressSelfTest() {
  return withTemporaryDirectory("zeroproxy-egress-self-test", async root => {
    await writeFile(path.join(root, "current-build.bin"), "self-test build input\n", "utf8");
    const unavailable = new GateFailure("capture intentionally unavailable during self-test", "capture_unavailable");
    const adapter = {
      async describe() { return { browser: { family: "test-browser", exact_build: "1.0.0" } }; },
      async executeScenario() { return { status: "completed" }; },
    };
    const captureBackend = {
      async preflight() { throw unavailable; },
      async start() { throw new Error("must not start capture after preflight failure"); },
      async stop() { throw new Error("must not stop an unstarted capture"); },
    };
    try {
      await runEgressGate({
        config: selfTestConfig(),
        manifest: { schema_version: 1, release_id: "gate-self-test", scenarios: [{ id: "canary", surfaces: ["fetch"], url: "https://runtime.invalid/canary", target: { host: "target.invalid", ports: [443] }, allowed_dns: [], expected_assertions: ["surface:fetch"], settle_ms: 500 }] },
        supportMatrix: { schema_version: 1, release_id: "gate-self-test", egress_surfaces: ["fetch"], browsers: [{ family: "test-browser", exact_build: "1.0.0", platform: `${process.platform}-${process.arch}`, release_supported: false, packet_capture_certified: false }] },
        build: await collectBuildIdentity(root),
        adapter,
        captureBackend,
        captureDir: root,
        interfaceName: "self-test",
        testMode: true,
      });
    } catch (error) {
      invariant(error === unavailable, "egress self-test expected capture-unavailable failure", "self_test_failed");
      return { self_test: "egress-capture-unavailable-fails-closed", status: "pass", certification_claimed: false };
    }
    throw new GateFailure("egress self-test unexpectedly continued without packet capture", "self_test_failed");
  });
}

function help() {
  return [
    "Usage: node scripts/gates/egress.mjs --adapter <module.mjs> --manifest <scenarios.json> --build-dir <dir> --capture-dir <dir> --interface <name> --output <report.json> [options]",
    "",
    "The adapter exports createEgressEvidenceAdapter(context), then implements describe() and executeScenario().",
    "The runner always requires a real tcpdump capture backend outside --test-mode; it never skips packet capture.",
    "Options:",
    "  --config <path>      Performance configuration (default: protocol/performance-gates.json)",
    "  --boundary <path>    Browser boundary declaration (default: protocol/browser-boundaries.json)",
    "  --support-matrix <path>  Support matrix (default: protocol/support-matrix.json)",
    "  --test-mode          Permit only explicit non-certifying test adapters",
    "  --self-test          Exercise capture-unavailable fail-closed behavior",
    "  --help               Show this help",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ["help", "self-test", "test-mode"],
    values: ["adapter", "manifest", "build-dir", "capture-dir", "interface", "output", "config", "boundary", "support-matrix"],
  });
  invariant(args._.length === 0, "unexpected positional arguments", "invalid_cli");
  if (args.help) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  if (args["self-test"]) {
    invariant(!args.adapter && !args.manifest && !args["build-dir"] && !args.output, "--self-test cannot be combined with production inputs", "invalid_cli");
    process.stdout.write(canonicalJson(await runEgressSelfTest()));
    return;
  }
  const base = moduleDirectory(import.meta.url);
  const configPath = args.config ?? path.resolve(base, "../../protocol/performance-gates.json");
  const boundaryPath = args.boundary ?? path.resolve(base, "../../protocol/browser-boundaries.json");
  const supportMatrixPath = args["support-matrix"] ?? path.resolve(base, "../../protocol/support-matrix.json");
  const manifestPath = args.manifest;
  invariant(nonEmptyString(manifestPath), "--manifest is required", "invalid_cli");
  const { config, configSha256 } = await loadPerformanceConfig(configPath, { testMode: args["test-mode"] === true });
  const manifestRaw = await readFile(manifestPath, "utf8");
  let manifest;
  try { manifest = JSON.parse(manifestRaw); } catch (error) { throw new GateFailure(`invalid JSON in ${manifestPath}: ${error.message}`, "invalid_json"); }
  const manifestSchema = await readJson(path.resolve(base, "../../protocol/egress-scenario-manifest.schema.json"));
  const manifestValidation = validateJsonSchema(manifest, manifestSchema.value);
  invariant(manifestValidation.valid, `egress manifest schema validation failed: ${manifestValidation.errors.join("; ")}`, "manifest_invalid");
  const supportMatrixRecord = await readJson(supportMatrixPath);
  const supportMatrixSchema = await readJson(path.resolve(base, "../../protocol/support-matrix.schema.json"));
  const supportMatrixValidation = validateJsonSchema(supportMatrixRecord.value, supportMatrixSchema.value);
  invariant(supportMatrixValidation.valid, `support matrix schema validation failed: ${supportMatrixValidation.errors.join("; ")}`, "manifest_invalid");
  const supportMatrix = supportMatrixRecord.value;
  const build = await collectBuildIdentity(args["build-dir"]);
  const factory = await loadAdapter(args.adapter, "createEgressEvidenceAdapter");
  const adapter = await factory({ config, manifest, build, test_mode: args["test-mode"] === true });
  const report = await runEgressGate({
    config,
    configSha256,
    browserBoundary: await loadBrowserBoundaries(boundaryPath),
    manifest,
    manifestSha256: createHash("sha256").update(manifestRaw).digest("hex"),
    supportMatrix,
    supportMatrixSha256: supportMatrixRecord.sha256,
    build,
    adapter,
    captureDir: args["capture-dir"],
    interfaceName: args.interface,
    testMode: args["test-mode"] === true,
  });
  const destination = await writeCanonicalReport(args.output, report);
  process.stdout.write(canonicalJson(reportCommandSummary(destination, report)));
  if (report.status !== "pass") process.exitCode = 1;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch(error => {
    const message = error instanceof GateFailure ? error.message : error.stack || error.message;
    process.stderr.write(`egress gate failed: ${message}\n`);
    process.exitCode = 1;
  });
}
