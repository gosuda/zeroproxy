import { canonicalDigest, readJson, invariant, validateJsonSchema } from "../common.mjs";
import { browserEvidenceLaunchOptions, requiredEnvironment, startBrowserEvidence } from "./browser-evidence.mjs";
import { safeRelativePath, snapshotFixtureTree, startFixtureSnapshotServer } from "../fixture-snapshot.mjs";

function validateImmutableScenario(scenario) {
  invariant(safeRelativePath(scenario.fixture_path) && safeRelativePath(scenario.entry_path), `performance evidence scenario ${scenario.id} requires safe fixture and entry paths`, "evidence_prerequisite_missing");
  invariant(typeof scenario.fixture_sha256 === "string" && /^[a-f0-9]{64}$/u.test(scenario.fixture_sha256), `performance evidence scenario ${scenario.id} requires a fixture digest`, "evidence_prerequisite_missing");
  invariant(typeof scenario.mediated_url_template === "string" && scenario.mediated_url_template.split("{fixture_url_encoded}").length === 2, `performance evidence scenario ${scenario.id} requires one fixture URL token`, "evidence_prerequisite_missing");
  invariant(scenario.native_url === null && scenario.mediated_url === null, `performance evidence scenario ${scenario.id} URLs must be gate-owned`, "evidence_prerequisite_missing");
  invariant(typeof scenario.ready_expression === "string" && scenario.ready_expression.length > 0, `performance evidence scenario ${scenario.id} requires a readiness expression`, "evidence_prerequisite_missing");
  invariant(scenario.interaction && ["click", "type"].includes(scenario.interaction.kind) && typeof scenario.interaction.selector === "string" && scenario.interaction.selector.length > 0, `performance evidence scenario ${scenario.id} requires a typed interaction`, "evidence_prerequisite_missing");
  invariant(typeof scenario.postcondition_expression === "string" && scenario.postcondition_expression.length > 0, `performance evidence scenario ${scenario.id} requires a postcondition expression`, "evidence_prerequisite_missing");
  invariant(scenario.settle_ms === 1000, `performance evidence scenario ${scenario.id} requires the canonical 1000ms settle interval`, "evidence_prerequisite_missing");
}

function validateManifest(manifest, config) {
  invariant(manifest && typeof manifest === "object" && manifest.schema_version === 1, "performance evidence manifest schema_version must be 1", "evidence_prerequisite_missing");
  invariant(manifest.release_id === config.release_id, "performance evidence manifest release_id does not match performance-gates.json", "evidence_prerequisite_missing");
  invariant(manifest.resource_limits && Number.isFinite(manifest.resource_limits.max_memory_bytes) && manifest.resource_limits.max_memory_bytes > 0 && Number.isFinite(manifest.resource_limits.max_queue_depth) && manifest.resource_limits.max_queue_depth > 0, "performance evidence manifest must declare positive resource limits", "evidence_prerequisite_missing");
  invariant(Array.isArray(manifest.scenarios) && manifest.scenarios.length > 0, "performance evidence manifest must enumerate scenarios", "evidence_prerequisite_missing");
  const expectedGates = new Set(Object.keys(config.gates));
  const expectedFixtures = new Map((config.fixtures ?? []).filter(fixture => fixture.availability === "available").map(fixture => [fixture.id, fixture]));
  const ids = new Set();
  const gates = new Set();
  const fixtures = new Set();
  for (const scenario of manifest.scenarios) {
    invariant(scenario && typeof scenario.id === "string" && scenario.id.length > 0 && !ids.has(scenario.id), "performance evidence scenario ids must be unique", "evidence_prerequisite_missing");
    ids.add(scenario.id);
    const kind = scenario.kind ?? "gate";
    if (kind === "gate") {
      invariant(expectedGates.has(scenario.gate) && !gates.has(scenario.gate), `performance evidence scenario has invalid or duplicate gate ${scenario.gate}`, "evidence_prerequisite_missing");
      gates.add(scenario.gate);
    } else {
      const fixture = expectedFixtures.get(scenario.fixture_id);
      invariant(kind === "fixture" && fixture?.site_class === scenario.site_class && !fixtures.has(scenario.fixture_id), `performance evidence scenario has invalid or duplicate fixture ${scenario.fixture_id}`, "evidence_prerequisite_missing");
      invariant(fixture.sha256 === scenario.fixture_sha256, `performance fixture ${scenario.fixture_id} digest does not match performance-gates.json`, "evidence_prerequisite_missing");
      fixtures.add(scenario.fixture_id);
    }
    invariant(Object.hasOwn(config.site_classes, scenario.site_class), `performance evidence scenario ${scenario.id} has unknown site_class`, "evidence_prerequisite_missing");
    validateImmutableScenario(scenario);
  }
  invariant(gates.size === expectedGates.size, "performance evidence manifest must cover every configured gate", "evidence_prerequisite_missing");
  invariant(fixtures.size === expectedFixtures.size, "performance evidence manifest must cover every configured fixture", "evidence_prerequisite_missing");
  return manifest;
}

async function snapshotScenarios(manifest, fixtureRoot) {
  const snapshots = new Map();
  for (const scenario of manifest.scenarios) {
    snapshots.set(scenario.id, await snapshotFixtureTree({
      fixtureRoot,
      fixturePath: scenario.fixture_path,
      entryPath: scenario.entry_path,
      expectedSha256: scenario.fixture_sha256,
      label: `performance scenario ${scenario.id}`,
    }));
  }
  return snapshots;
}

function executableScenarios(manifest, server) {
  return manifest.scenarios.map(scenario => {
    const fixtureUrl = server.urlFor(scenario.id, scenario.entry_path);
    const mediatedUrl = scenario.mediated_url_template.replace("{fixture_url_encoded}", encodeURIComponent(fixtureUrl));
    invariant(/^https?:\/\//.test(mediatedUrl), `performance scenario ${scenario.id} mediated URL template did not produce HTTP(S)`, "evidence_prerequisite_missing");
    return { ...scenario, native_url: fixtureUrl, mediated_url: mediatedUrl };
  });
}

function snapshotEvidence(scenarios, snapshots) {
  return scenarios.map(scenario => ({ id: scenario.id, kind: scenario.kind, gate: scenario.gate ?? null, fixture_id: scenario.fixture_id ?? null, fixture_sha256: scenario.fixture_sha256, ...snapshots.get(scenario.id).report }));
}

/**
 * Production adapter selected with --adapter scripts/gates/adapters/performance-browser.mjs.
 * Required environment: ZEROPROXY_GATE_BROWSER_BIN, ZEROPROXY_GATE_BUILD_PROOF_URL,
 * ZEROPROXY_GATE_PERFORMANCE_MANIFEST, and ZEROPROXY_GATE_FIXTURE_ROOT. It launches
 * Chromium through CDP and returns only browser-derived navigation/resource measurements
 * against immutable, gate-served fixture snapshots.
 */
export async function createPerformanceEvidenceAdapter(context) {
  const manifestPath = requiredEnvironment("ZEROPROXY_GATE_PERFORMANCE_MANIFEST");
  const fixtureRoot = requiredEnvironment("ZEROPROXY_GATE_FIXTURE_ROOT");
  const loadedManifest = await readJson(manifestPath);
  const manifestSchema = await readJson(new URL("../../../protocol/performance-evidence-manifest.schema.json", import.meta.url).pathname);
  const schemaValidation = validateJsonSchema(loadedManifest.value, manifestSchema.value);
  invariant(schemaValidation.valid, `performance evidence manifest schema validation failed: ${schemaValidation.errors.join("; ")}`, "evidence_prerequisite_missing");
  const manifest = validateManifest(loadedManifest.value, context.config);
  const snapshots = await snapshotScenarios(manifest, fixtureRoot);
  const browser = await startBrowserEvidence(browserEvidenceLaunchOptions(context));
  let server;
  try {
    server = await startFixtureSnapshotServer(snapshots);
  } catch (error) {
    await browser.close();
    throw error;
  }
  const scenarios = executableScenarios(manifest, server);
  const evidence = snapshotEvidence(scenarios, snapshots);
  return {
    async describe() {
      return {
        browser: browser.browser,
        resource_limits: manifest.resource_limits,
        toolchain: {
          kind: "chromium-cdp-browser-evidence-v1",
          browser_product: browser.browserVersion.product,
          build_proof: browser.buildProof,
          performance_manifest: manifestPath,
          performance_manifest_sha256: loadedManifest.sha256,
          fixture_evidence_sha256: canonicalDigest(evidence),
          fixture_evidence: evidence,
        },
      };
    },
    async enumerateScenarios() {
      return scenarios.map(({ id, kind = "gate", gate, fixture_id, site_class, fixture_sha256 }) => ({ id, kind, gate, fixture_id, site_class, fixture_evidence: snapshots.get(id).report, fixture_sha256 }));
    },
    async measurePair({ scenario, order }) {
      const source = scenarios.find(candidate => candidate.id === scenario.id);
      invariant(source, `performance evidence scenario ${scenario.id} was not enumerated`, "evidence_prerequisite_missing");
      const metric = source.gate ?? "fixture_site_metrics";
      if (order === "mediated-first") {
        const mediated = await browser.measureNavigation(source.mediated_url, metric, source);
        const native = await browser.measureNavigation(source.native_url, metric, source);
        return { native, mediated };
      }
      const native = await browser.measureNavigation(source.native_url, metric, source);
      const mediated = await browser.measureNavigation(source.mediated_url, metric, source);
      return { native, mediated };
    },
    async close() {
      try {
        await browser.close();
      } finally {
        await server.close();
      }
    },
  };
}

export { validateManifest as validatePerformanceEvidenceManifest };
