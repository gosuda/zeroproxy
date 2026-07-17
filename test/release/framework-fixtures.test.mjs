import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { chromiumBrowserLane, startBrowserEvidence } from "../../scripts/gates/adapters/browser-evidence.mjs";
import { evaluateCorpusPage } from "../../scripts/gates/adapters/corpus-browser.mjs";
import { snapshotFixtureTree, startFixtureSnapshotServer, verifyRemoteFixtureOrigin } from "../../scripts/gates/fixture-snapshot.mjs";
import { readJson, validateJsonSchema } from "../../scripts/gates/common.mjs";
import { buildCorpusReleaseManifest } from "../../scripts/generate-corpus-manifest.mjs";
import { publishFrameworkFixtures } from "../../scripts/publish-framework-fixtures.mjs";

import { REQUIRED_OFFLINE_CORPUS_CATEGORIES } from "../../scripts/gates/corpus.mjs";
const root = path.resolve(import.meta.dirname, "../..");
const fixtureRoot = path.join(root, "test/frameworks");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function buildRecordingProxy(binaryPath) {
  const child = spawn("go", ["build", "-o", binaryPath, "./cmd/egress-test-proxy"], {
    cwd: root,
    env: { ...process.env, GOTOOLCHAIN: "go1.26.3" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`recording proxy build failed code=${code}: ${stderr}`)));
  });
}

async function startRecordingProxy(eventsPath, allowedEndpoint) {
  const binaryPath = path.join(path.dirname(eventsPath), "egress-test-proxy");
  await buildRecordingProxy(binaryPath);
  const child = spawn(binaryPath, [
    "--events", eventsPath,
    "--allow-endpoint", allowedEndpoint,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  try {
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`recording proxy readiness timed out: ${stderr}`)), 20_000);
      const inspect = () => {
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timeout);
        try { resolve(JSON.parse(stdout.slice(0, newline))); } catch (error) { reject(error); }
      };
      child.stdout.on("data", inspect);
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`recording proxy exited before readiness code=${code} signal=${signal}: ${stderr}`));
      });
      inspect();
    });
    assert.equal(ready.schema_version, 1);
    return { child, eventsPath, proxyUrl: ready.proxy_url, exited };
  } catch (error) {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    await exited;
    throw error;
  }
}

async function stopRecordingProxy(proxy) {
  if (proxy.child.exitCode === null && !proxy.child.killed) proxy.child.kill("SIGTERM");
  const result = await proxy.exited;
  assert.equal(result.code === 0 || result.signal === "SIGTERM", true, `recording proxy exit: ${JSON.stringify(result)}`);
}



test("framework publisher emits the content-addressed release layout", async t => {
  const inventory = await readJson(path.join(fixtureRoot, "manifest.json"));
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "zeroproxy-framework-publish-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const publication = await publishFrameworkFixtures({
    inventory: inventory.value,
    inventorySha256: inventory.sha256,
    fixtureRoot,
    outputRoot,
  });
  assert.equal(publication.inventory_sha256, inventory.sha256);
  assert.match(publication.url_layout, new RegExp(inventory.sha256));
  assert.match(publication.deployment_manifest_sha256, /^[a-f0-9]{64}$/u);
  await access(path.join(publication.destination, "fixture", "fixture-pwa", "app.js"));
  await access(path.join(publication.destination, "inventory.json"));
  const deployment = JSON.parse(await readFile(path.join(publication.destination, "deployment-manifest.json"), "utf8"));
  assert.equal(deployment.assets.length, publication.asset_count);
  assert.equal(deployment.assets.every(asset => typeof asset.content_type === "string" && asset.content_type.length > 0), true);
  await assert.rejects(
    publishFrameworkFixtures({ inventory: { ...inventory.value, schema_version: 2 }, inventorySha256: inventory.sha256, fixtureRoot, outputRoot }),
    error => error.code === "manifest_invalid",
  );
});

test("all vendored framework fixture actions execute in pinned Chromium", async t => {
  const config = JSON.parse(await readFile(path.join(root, "protocol/performance-gates.json"), "utf8"));
  const lane = chromiumBrowserLane(config);
  try {
    await access(lane.binary_path);
  } catch {
    t.skip(`pinned Chromium unavailable: ${lane.binary_path}`);
    return;
  }
  const inventory = JSON.parse(await readFile(path.join(fixtureRoot, "manifest.json"), "utf8"));
  const schema = await readJson(path.join(root, "protocol/framework-fixtures.schema.json"));
  assert.deepEqual(validateJsonSchema(inventory, schema.value), { valid: true, errors: [] });
  const packageManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(inventory.toolchain.node, packageManifest.engines.node);
  assert.deepEqual(
    inventory.toolchain.packages,
    Object.fromEntries(Object.keys(inventory.toolchain.packages).map(name => [name, packageManifest.devDependencies[name]])),
  );
  assert.equal(inventory.fixtures.length, 19);
  assert.equal(REQUIRED_OFFLINE_CORPUS_CATEGORIES.every(category => inventory.fixtures.some(fixture => fixture.category === category)), true);
  const releaseCorpus = buildCorpusReleaseManifest({
    config,
    inventory,
    mediatedUrlTemplate: "https://candidate.invalid/browse?target={fixture_url_encoded}",
    oracleId: "pinned-chromium-framework-oracle-v1",
    liveCanaries: [{
      id: "generator-contract-canary",
      url: "https://example.invalid/",
      native_url: "https://example.invalid/",
      mediated_url: "https://candidate.invalid/example",
      site_class: "content",
      actions: [{ id: "load", expression: "true" }],
      compatibility_probes: [{ id: "ready", expression: "true" }],
      stealth_probes: [{ id: "navigator", expression: "navigator.userAgent" }],
    }],
  });
  const corpusSites = new Map(releaseCorpus.sites.filter(site => site.kind === "offline-fixture").map(site => [site.fixture_category, site]));
  const snapshots = new Map();
  for (const fixture of inventory.fixtures) {
    const site = corpusSites.get(fixture.category);
    snapshots.set(site.id, await snapshotFixtureTree({
      fixtureRoot,
      fixturePath: fixture.path,
      entryPath: fixture.entry_path,
      expectedSha256: fixture.tree_sha256,
      label: `framework fixture ${fixture.category}`,
    }));
  }
  const fixtureServer = await startFixtureSnapshotServer(snapshots);
  const fixtureEndpoint = new URL(fixtureServer.origin).host;
  const proxyDirectory = await mkdtemp(path.join(os.tmpdir(), "zeroproxy-recording-proxy-"));
  const recordingProxy = await startRecordingProxy(path.join(proxyDirectory, "events.jsonl"), fixtureEndpoint);
  t.after(async () => {
    await stopRecordingProxy(recordingProxy);
    await rm(proxyDirectory, { recursive: true, force: true });
  });
  const remoteProof = await verifyRemoteFixtureOrigin({ snapshots, baseUrl: `${fixtureServer.origin}/`, requireHttps: false });
  assert.equal(remoteProof.verified, true);
  assert.equal(remoteProof.asset_count, [...snapshots.values()].reduce((sum, snapshot) => sum + snapshot.assets.size, 0));
  const build = { tree_sha256: "4".repeat(64) };
  const proofServer = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ build_tree_sha256: build.tree_sha256 }));
  });
  await listen(proofServer);
  const address = proofServer.address();
  assert.ok(address && typeof address === "object");
  let browser;
  try {
    browser = await startBrowserEvidence({
      build,
      expectedBrowserLane: lane,
      environment: {
        ZEROPROXY_GATE_BROWSER_BIN: lane.binary_path,
        ZEROPROXY_GATE_BUILD_PROOF_URL: `http://127.0.0.1:${address.port}/proof`,
        ZEROPROXY_GATE_TEST_PROXY_URL: recordingProxy.proxyUrl,
      },
      testMode: true,
    });
    for (const fixture of inventory.fixtures) {
      await t.test(fixture.category, async () => {
        const site = corpusSites.get(fixture.category);
        const page = await browser.createPage();
        try {
          await browser.navigate(page, fixtureServer.urlFor(site.id, fixture.entry_path));
          const result = await evaluateCorpusPage(browser, page, site);
          assert.equal(result.compatibility.passed, true);
          assert.equal(result.actions.passed, true);
          assert.equal(result.deterministic_signals.length, 4);
        } finally {
          await browser.closePage(page);
        }
      });
    }
  } finally {
    if (browser) await browser.close();
    await fixtureServer.close();
    await close(proofServer);
    await stopRecordingProxy(recordingProxy);
  }
  const proxyEvents = (await readFile(recordingProxy.eventsPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const allowedProxyEvents = proxyEvents.filter(event => event.allowed === true);
  assert.equal(allowedProxyEvents.length > 0 && allowedProxyEvents.every(event => event.destination === fixtureEndpoint), true, JSON.stringify(proxyEvents));
  assert.equal(proxyEvents.filter(event => event.allowed === false).every(event => event.destination !== fixtureEndpoint), true, JSON.stringify(proxyEvents));
});
