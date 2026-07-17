import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { GateFailure, readJson, runtimeIdentity, validateJsonSchema } from "../../scripts/gates/common.mjs";
import { BrowserEvidenceSession, browserEvidenceLaunchOptions, browserProxyArguments, browserTestCertificateArguments, startBrowserEvidence } from "../../scripts/gates/adapters/browser-evidence.mjs";
import { validatePerformanceEvidenceManifest } from "../../scripts/gates/adapters/performance-browser.mjs";
import { validateSoakWorkloadManifest } from "../../scripts/gates/adapters/soak-browser.mjs";
import { validateEgressBrowserManifest, validateScenarioCompletion } from "../../scripts/gates/adapters/egress-browser.mjs";
import { evaluateCorpusPage, validateCorpusBrowserManifest } from "../../scripts/gates/adapters/corpus-browser.mjs";
import { buildCorpusReleaseManifest } from "../../scripts/generate-corpus-manifest.mjs";

function config() {
  const runtime = runtimeIdentity();
  return {
    release_id: "release-gate-test",
    reference_platform: { os: runtime.os, arch: runtime.architecture, browser_builds: ["test-browser-1.0.0"] },
    gates: { application_p95_ms: 5, content_p95_ms: 5, editor_p95_ms: 5 },
    site_classes: { content: {}, application: {}, editor_media_pwa: {} },
    soak: { origins: 20, clients: 40, max_memory_bytes: 1024, max_queue_depth: 8 },
  };
}

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

test("performance browser adapter accepts only gate-complete measured manifests", async () => {
  const manifest = await fixture("performance-evidence.manifest.json");
  assert.equal(validatePerformanceEvidenceManifest(manifest, config()).scenarios.length, 3);
  const incomplete = { ...manifest, scenarios: manifest.scenarios.slice(1) };
  assert.throws(() => validatePerformanceEvidenceManifest(incomplete, config()), error => error instanceof GateFailure && error.code === "evidence_prerequisite_missing");
});

test("egress browser adapter requires an explicit navigation and target canary", async () => {
  const manifest = await fixture("egress-scenarios.manifest.json");
  assert.equal(validateEgressBrowserManifest(manifest).scenarios.length, 1);
  const missingTarget = { ...manifest, scenarios: [{ ...manifest.scenarios[0], target: null }] };
  assert.throws(() => validateEgressBrowserManifest(missingTarget), error => error instanceof GateFailure && error.code === "evidence_prerequisite_missing");
});

test("egress browser adapter requires an explicit successful page oracle", () => {
  const scenario = {
    id: "navigation-canary",
    expected_assertions: ["surface:navigation"],
  };
  const completion = {
    schema_version: 1,
    scenario_id: "navigation-canary",
    status: "completed",
    assertions: [{ id: "surface:navigation", pass: true }],
  };
  assert.equal(validateScenarioCompletion(completion, scenario), completion);
  for (const invalid of [
    { ...completion, scenario_id: "other" },
    { ...completion, status: "failed" },
    { ...completion, assertions: [] },
    { ...completion, assertions: [{ id: "surface:navigation", pass: false }] },
    { ...completion, assertions: [{ id: "duplicate", pass: true }, { id: "duplicate", pass: true }] },
    { ...completion, assertions: [{ id: "surface:navigation", pass: true }, { id: "unowned", pass: true }] },
  ]) {
    assert.throws(
      () => validateScenarioCompletion(invalid, scenario),
      error => error instanceof GateFailure && error.code === "scenario_incomplete",
    );
  }
});

test("soak browser adapter requires all configured origins and a non-shell fault driver", async () => {
  const manifest = await fixture("soak-workload.manifest.json");
  assert.equal(validateSoakWorkloadManifest(manifest, config()).origins.length, 20);
  const missingOrigin = { ...manifest, origins: manifest.origins.slice(1) };
  assert.throws(() => validateSoakWorkloadManifest(missingOrigin, config()), error => error instanceof GateFailure && error.code === "evidence_prerequisite_missing");
  assert.throws(() => validateSoakWorkloadManifest({ ...manifest, telemetry_url: null }, config()), error => error instanceof GateFailure && error.code === "evidence_prerequisite_missing");
  const duplicateOrigin = structuredClone(manifest);
  for (const field of ["page_url", "short_stream_url", "sse_url", "websocket_url"])
    duplicateOrigin.origins[1][field] = duplicateOrigin.origins[0][field];
  assert.throws(() => validateSoakWorkloadManifest(duplicateOrigin, config()), error => error instanceof GateFailure && error.code === "evidence_prerequisite_missing");
  const invalidWebSocket = structuredClone(manifest);
  invalidWebSocket.origins[0].websocket_url = "https://origin-01.test/socket";
  assert.throws(() => validateSoakWorkloadManifest(invalidWebSocket, config()), error => error instanceof GateFailure && error.code === "evidence_prerequisite_missing");
});

test("corpus browser adapter requires native/mediated URLs and explicit probes", async () => {
  const manifest = await fixture("corpus-browser.manifest.json");
  assert.doesNotThrow(() => validateCorpusBrowserManifest(manifest));
  const missingProbe = { ...manifest, sites: [{ ...manifest.sites[0], stealth_probes: [] }] };
  assert.throws(() => validateCorpusBrowserManifest(missingProbe), error => error instanceof GateFailure && error.code === "evidence_prerequisite_missing");
});

test("corpus page establishes readiness before mutating fixture actions", async () => {
  const order = [];
  const browser = {
    async evaluate(_page, source) {
      if (source.includes("readyProbe()")) order.push("ready");
      else if (source.includes("actionProbe()")) order.push("action");
      else if (source.includes("signalProbe()")) order.push("signal");
      return JSON.stringify(true);
    },
  };
  const result = await evaluateCorpusPage(browser, {}, {
    compatibility_probes: [{ id: "ready", expression: "readyProbe()" }],
    actions: [{ id: "action", expression: "actionProbe()" }],
    stealth_probes: [{ id: "signal", expression: "signalProbe()" }],
  });
  assert.deepEqual(order, ["ready", "action", "signal"]);
  assert.equal(result.compatibility.passed, true);
  assert.equal(result.actions.passed, true);
});

test("release corpus generator binds every immutable fixture and requires a live canary", async () => {
  const releaseConfig = (await readJson(new URL("../../protocol/performance-gates.json", import.meta.url).pathname)).value;
  const inventory = (await readJson(new URL("../frameworks/manifest.json", import.meta.url).pathname)).value;
  const manifest = buildCorpusReleaseManifest({
    config: releaseConfig,
    inventory,
    mediatedUrlTemplate: "https://candidate.test/browse?target={fixture_url_encoded}",
    oracleId: "chromium-149-corpus-v1",
    liveCanaries: [{
      id: "live-canary",
      url: "https://example.com/",
      native_url: "https://example.com/",
      mediated_url: "https://candidate.test/example",
      site_class: "content",
      actions: [{ id: "load", expression: "true" }],
      compatibility_probes: [{ id: "ready", expression: "document.readyState === 'complete'" }],
      stealth_probes: [{ id: "navigator", expression: "navigator.userAgent" }],
    }],
  });
  const schema = (await readJson(new URL("../../protocol/corpus-manifest.schema.json", import.meta.url).pathname)).value;
  assert.deepEqual(validateJsonSchema(manifest, schema), { valid: true, errors: [] });
  assert.doesNotThrow(() => validateCorpusBrowserManifest(manifest));
  assert.equal(manifest.sites.filter(site => site.kind === "offline-fixture").length, inventory.fixtures.length);
  for (const fixture of inventory.fixtures) {
    const site = manifest.sites.find(candidate => candidate.fixture_category === fixture.category);
    assert.equal(site.fixture_sha256, fixture.tree_sha256);
    assert.equal(site.actions[0].expression, fixture.action_expression);
    assert.equal(site.compatibility_probes[0].expression, fixture.ready_expression);
  }
  assert.throws(
    () => buildCorpusReleaseManifest({ config: releaseConfig, inventory, mediatedUrlTemplate: "https://candidate.test/no-token", oracleId: "oracle", liveCanaries: manifest.sites.slice(-1) }),
    error => error instanceof GateFailure && error.code === "manifest_invalid",
  );
});

test("recording proxy injection is loopback-only and non-certifying", () => {
  assert.deepEqual(browserProxyArguments({}, true), []);
  assert.throws(
    () => browserProxyArguments({ ZEROPROXY_GATE_TEST_PROXY_URL: "http://127.0.0.1:8123/" }, false),
    error => error instanceof GateFailure && error.code === "evidence_prerequisite_invalid",
  );
  assert.throws(
    () => browserProxyArguments({ ZEROPROXY_GATE_TEST_PROXY_URL: "http://proxy.example:8123/" }, true),
    error => error instanceof GateFailure && error.code === "evidence_prerequisite_invalid",
  );
  assert.deepEqual(
    browserProxyArguments({ ZEROPROXY_GATE_TEST_PROXY_URL: "http://127.0.0.1:8123/" }, true),
    ["--proxy-server=http://127.0.0.1:8123", "--proxy-bypass-list=<-loopback>"],
  );
});

test("test certificate pinning is exact and non-certifying", () => {
  const pin = `${"A".repeat(43)}=`;
  assert.deepEqual(browserTestCertificateArguments({}, true), []);
  assert.throws(
    () => browserTestCertificateArguments({ ZEROPROXY_GATE_TEST_CERT_SPKI: pin }, false),
    error => error instanceof GateFailure && error.code === "evidence_prerequisite_invalid",
  );
  assert.throws(
    () => browserTestCertificateArguments({ ZEROPROXY_GATE_TEST_CERT_SPKI: "*" }, true),
    error => error instanceof GateFailure && error.code === "evidence_prerequisite_invalid",
  );
  assert.deepEqual(browserTestCertificateArguments({ ZEROPROXY_GATE_TEST_CERT_SPKI: pin }, true), [`--ignore-certificate-errors-spki-list=${pin}`]);
});

test("every browser adapter propagates explicit non-certifying test mode", () => {
  const build = { tree_sha256: "a".repeat(64) };
  const lane = { family: "chromium", availability: "available", exact_build: "1.0.0", binary_sha256: "b".repeat(64) };
  const context = { build, config: { browser_lanes: [lane] }, test_mode: true };
  assert.deepEqual(browserEvidenceLaunchOptions(context), {
    build,
    expectedBrowserLane: lane,
    testMode: true,
  });
  assert.equal(browserEvidenceLaunchOptions({ ...context, test_mode: "true" }).testMode, false);
});

test("browser evidence cannot fabricate a run when executable and build proof are unavailable", async () => {
  await assert.rejects(
    startBrowserEvidence({ build: { tree_sha256: "0".repeat(64) }, environment: {} }),
    error => error instanceof GateFailure && error.code === "evidence_prerequisite_missing",
  );
  await assert.rejects(
    startBrowserEvidence({
      build: { tree_sha256: "0".repeat(64) },
      expectedBrowserLane: { family: "chromium", exact_build: "1.0.0", availability: "available", binary_sha256: "0".repeat(64) },
      environment: {
        ZEROPROXY_GATE_BROWSER_BIN: new URL(import.meta.url).pathname,
        ZEROPROXY_GATE_BUILD_PROOF_URL: "http://127.0.0.1:1/proof",
      },
    }),
    error => error instanceof GateFailure && error.code === "browser_pin_mismatch",
  );
});

test("browser navigation evidence serializes trusted page metrics before reporting", async () => {
  const sandbox = {
    document: {
      querySelector(selector) {
        assert.equal(selector, "#button");
        return { getBoundingClientRect: () => ({ left: 10, top: 20, width: 30, height: 40 }) };
      },
    },
    performance: {
      timeOrigin: 100_000,
      getEntriesByType(type) {
        assert.equal(type, "navigation");
        return [{ duration: 125, transferSize: 4096, domContentLoadedEventEnd: 80, startTime: 0 }];
      },
    },
    __zeroproxyGatePerformance: { inp_ms: 16, interaction_count: 1 },
    __zeroproxyGatePerformanceObserverError: null,
  };
  let performanceReads = 0;
  let listener;
  const cdp = {
    async command(method, parameters) {
      if (method === "Target.createTarget") return { targetId: "target" };
      if (method === "Target.attachToTarget") return { sessionId: "session" };
      if (method === "PerformanceTimeline.enable") {
        listener({ method: "PerformanceTimeline.timelineEventAdded", sessionId: "session", params: { event: { type: "largest-contentful-paint", time: 100.072 } } });
        return {};
      }
      if (method === "Runtime.evaluate")
        return { result: { value: runInNewContext(parameters.expression, sandbox) } };
      if (method === "Runtime.getHeapUsage") return { usedSize: 2048 };
      if (method === "Performance.getMetrics")
        return { metrics: [{ name: "TaskDuration", value: performanceReads++ === 0 ? 0 : 0.025 }] };
      return {};
    },
    waitForEvent() {
      return Promise.resolve({});
    },
    subscribe(callback) {
      listener = callback;
      return () => {};
    },
  };
  const browser = new BrowserEvidenceSession({ cdp });
  const protocol = {
    ready_expression: "true",
    interaction: { kind: "click", selector: "#button" },
    postcondition_expression: "true",
    settle_ms: 1000,
  };
  assert.deepEqual(await browser.measureNavigation("https://fixture.example/", "control_ready_cold_p95_ms", protocol), {
    value: 125,
    memory_bytes: 2048,
    queue_depth: 0,
    site_metrics: { dcl_ms: 80, lcp_ms: 72, inp_ms: 16, cpu_ms: 25 },
  });
});
