import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { STEALTH_PROFILE } from "../../web/generated/stealth-profile.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dist = path.join(root, "dist/web");
const pinnedChromium = path.join(root, ".puppeteer-cache/chrome/mac_arm-150.0.7871.124/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const pinnedFirefox = path.join(root, ".puppeteer-cache/firefox/mac_arm-stable_152.0.6/Firefox.app/Contents/MacOS/firefox");
const chromium = process.env.ZP_CHROMIUM_PATH ?? process.env.CHROME_BIN ?? (existsSync(pinnedChromium) ? pinnedChromium : null);
const firefox = process.env.ZP_FIREFOX_PATH ?? (existsSync(pinnedFirefox) ? pinnedFirefox : null);
const [fixture, host, probes, workerFixture, version, registry] = await Promise.all([
  readFile(path.join(root, "test/browser/stealth-release-oracle.html")),
  readFile(path.join(root, "test/browser/stealth-release-host.mjs")),
  readFile(path.join(root, "test/browser/stealth-release-probes.mjs")),
  readFile(path.join(root, "test/browser/stealth-release-worker.mjs")),
  readFile(path.join(dist, "_zp/version.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "protocol/compatibility-deltas.json"), "utf8").then(JSON.parse),
]);
const runtimePath = version.selectors["runtime-prelude.js"];
assert.match(runtimePath, /^\/_zp\/assets\/[a-f0-9]{64}\/runtime-prelude\.js$/u);
const runtimeBytes = await readFile(path.join(dist, runtimePath));
const runtimeIntegrity = `sha384-${createHash("sha384").update(runtimeBytes).digest("base64")}`;
const fixtureDigest = createHash("sha256").update(fixture).update(host).update(probes).update(workerFixture).digest("hex");
const probeIDs = STEALTH_PROFILE.surfaces.flatMap(surface => surface.probes.map(probe => probe.id));
const probeByID = new Map(STEALTH_PROFILE.surfaces.flatMap(surface => surface.probes.map(probe => [probe.id, { ...probe, surface: surface.id }])));
assert.equal(registry.registry_version, 1);
assert.equal(registry.release_id, version.release_id);
assert.equal(registry.oracle_id, "stealth-release-oracle-v2");
assert.equal(registry.oracle_digest, fixtureDigest);
assert.equal(new Set(registry.entries.map(entry => entry.id)).size, registry.entries.length);
const observationBrowsers = registry.entries.flatMap(entry => entry.affected_browser_builds.map(browser => `${entry.observation_id}:${browser.family}:${browser.exact_build}:${browser.platform}`));
assert.equal(new Set(observationBrowsers).size, observationBrowsers.length);
const registryBySignature = new Map(registry.entries.map(entry => [JSON.stringify(entry.exact_signature), entry]));
assert.equal(registryBySignature.size, registry.entries.length);
const now = Date.parse(registry.generated_at);
for (const entry of registry.entries) {
  assert.equal(entry.test_id, registry.oracle_id);
  assert.ok(Date.parse(entry.introduced_at) <= now);
  assert.ok(Date.parse(entry.expires_at) > now);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function observationDigest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function ownedNamesAbsent(value) {
  return value === true || value === 0 || Array.isArray(value) && value.length === 0;
}
function classifyDifferences(native, mediated, context, differences, matchedEntries) {
  for (const probeID of probeIDs) {
    const probe = probeByID.get(probeID);
    const nativeDigest = observationDigest(native[probeID]);
    const mediatedDigest = observationDigest(mediated[probeID]);
    const pass = probe.expected_relation === "owned-internal-names-absent"
      ? ownedNamesAbsent(mediated[probeID])
      : nativeDigest === mediatedDigest;
    if (pass) continue;
    const signature = {
      surface: `${context.realm}/${probe.surface}`,
      probe_id: probeID,
      native_digest: nativeDigest,
      mediated_digest: mediatedDigest,
    };
    const key = JSON.stringify(signature);
    const entry = registryBySignature.get(key);
    const browser = registry.browser_scope.find(candidate =>
      candidate.family === context.browser
      && candidate.exact_build === context.exact_build
      && candidate.platform === context.platform);
    assert.ok(browser, `registry does not bind ${context.browser} ${context.exact_build} ${context.platform}`);
    if (!entry && process.env.ZP_ORACLE_COLLECT !== "1") assert.fail(`unregistered compatibility delta ${key}`);
    if (!entry) {
      const prior = differences.get(key);
      if (prior) prior.contexts.push(context);
      else differences.set(key, { ...signature, contexts: [context] });
      continue;
    }
    assert.equal(entry.observation_id, `${context.realm}/${probe.surface}.${probeID}`);
    assert.equal(entry.affected_release_range, registry.release_id);
    assert.ok(entry.affected_browser_builds.some(candidate =>
      candidate.family === context.browser
      && candidate.exact_build === context.exact_build
      && candidate.platform === context.platform));
    matchedEntries.add(entry.id);
    const prior = differences.get(key);
    if (prior) prior.contexts.push(context);
    else differences.set(key, { ...signature, registry_entry_id: entry.id, contexts: [context] });
  }
}
function classifyWorkerDifference(native, mediated, context, differences, matchedEntries) {
  const signature = {
    surface: "worker-context",
    probe_id: "new-module-worker",
    native_digest: observationDigest(native),
    mediated_digest: observationDigest(mediated),
  };
  if (signature.native_digest === signature.mediated_digest) return;
  const key = JSON.stringify(signature);
  const entry = registryBySignature.get(key);
  if (!entry && process.env.ZP_ORACLE_COLLECT !== "1") assert.fail(`unregistered compatibility delta ${key}`);
  if (entry) {
    assert.equal(entry.observation_id, "worker-context.new-module-worker");
    assert.ok(entry.affected_browser_builds.some(candidate =>
      candidate.family === context.browser
      && candidate.exact_build === context.exact_build
      && candidate.platform === context.platform));
    matchedEntries.add(entry.id);
  }
  const prior = differences.get(key);
  if (prior) prior.contexts.push(context);
  else differences.set(key, { ...signature, registry_entry_id: entry?.id ?? null, contexts: [context] });
}

function contentType(file) {
  if (file.endsWith(".mjs") || file.endsWith(".js")) return "text/javascript;charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".json")) return "application/json;charset=utf-8";
  return "application/octet-stream";
}

async function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (process.env.ZP_ORACLE_TRACE === "1") process.stderr.write(`${request.headers.host} ${url.pathname} ${url.searchParams.get("role") ?? "top"} ${url.searchParams.get("mode") ?? ""}\n`);
      if (url.pathname === "/oracle") {
        const strict = url.searchParams.get("policy") === "strict";
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Security-Policy": strict
            ? "default-src 'none'; script-src 'self' 'nonce-zp-oracle-runtime' 'wasm-unsafe-eval'; connect-src 'self'; frame-src http:; worker-src 'self'; base-uri 'none'"
            : "default-src 'self'; script-src 'self' 'nonce-zp-oracle-runtime' 'wasm-unsafe-eval'; connect-src 'self'; frame-src http:; worker-src 'self'; base-uri 'none'",
          "Content-Type": "text/html;charset=utf-8",
        });
        response.end(fixture);
        return;
      }
      if (url.pathname === "/stealth-release-host.mjs" || url.pathname === "/stealth-release-probes.mjs" || url.pathname === "/stealth-release-worker.mjs") {
        response.writeHead(200, { "Cache-Control": "public,max-age=31536000,immutable", "Content-Type": "text/javascript;charset=utf-8" });
        response.end(url.pathname.includes("host") ? host : url.pathname.includes("worker") ? workerFixture : probes);
        return;
      }
      const file = path.resolve(dist, `.${decodeURIComponent(url.pathname)}`);
      if (!file.startsWith(`${dist}${path.sep}`)) throw new Error("path escaped fixture root");
      const bytes = await readFile(file);
      response.writeHead(200, { "Cache-Control": "public,max-age=31536000,immutable", "Content-Type": contentType(file) });
      response.end(bytes);
    } catch {
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end("not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, resolve);
  });
  return server;
}

async function readOracle(page) {
  const deadline = Date.now() + 60_000;
  let result;
  while (Date.now() < deadline) {
    result = await page.evaluate(() => globalThis.__stealthReleaseOracle ?? null);
    if (result !== null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (result === null) {
    const diagnostic = await page.evaluate(() => ({
      href: location.href,
      progress: globalThis.__stealthReleaseProgress ?? null,
      oracle: globalThis.__stealthReleaseOracle ?? null,
    }));
    throw new Error(`stealth oracle timed out: ${JSON.stringify(diagnostic)}`);
  }
  assert.ok(result);
  if (result.ok !== true) {
    const frames = await Promise.all(page.frames().map(async frame => {
      try {
        return await frame.evaluate(() => ({
          href: location.href,
          result: globalThis.__stealthReleaseContextResult ?? null,
          progress: globalThis.__stealthReleaseProgress ?? null,
        }));
      } catch (error) {
        return { evaluation_error: error.message, url: frame.url() };
      }
    }));
    assert.fail(JSON.stringify({ result, frames }));
  }
  assert.ok(result.contexts && typeof result.contexts === "object", JSON.stringify(result));
  assert.deepEqual(Object.keys(result.contexts).sort(), ["about-blank-realm", "cross-frame", "cross-popup", "same-frame", "same-popup", "top"]);
  for (const [context, observations] of Object.entries(result.contexts)) {
    assert.ok(observations && typeof observations === "object", `${context}: ${JSON.stringify(result)}`);
    assert.deepEqual(Object.keys(observations).sort(), [...probeIDs].sort());
    assert.ok(Buffer.byteLength(JSON.stringify(observations)) <= STEALTH_PROFILE.limits.maximum_observation_bytes);
  }
  assert.ok(result.worker && typeof result.worker === "object");
  return { contexts: result.contexts, worker: result.worker };
}

function oracleURL(origin, mode, policy, integrity) {
  const url = new URL("/oracle", origin);
  url.searchParams.set("mode", mode);
  url.searchParams.set("policy", policy);
  url.searchParams.set("runtime", runtimePath);
  url.searchParams.set("target", `${origin}/oracle?mode=native&policy=${policy}`);
  url.searchParams.set("cross_origin", origin.replace("127.0.0.1", "localhost"));
  if (integrity) url.searchParams.set("integrity", runtimeIntegrity);
  return url.href;
}

async function scenario(page, origin, mode, policy, integrity) {
  await page.setCacheEnabled(true);
  await page.goto(oracleURL(origin, mode, policy, integrity), { waitUntil: "load" });
  const first = await readOracle(page);
  await page.reload({ waitUntil: "load" });
  const warm = await readOracle(page);
  await page.setCacheEnabled(false);
  await page.reload({ waitUntil: "load" });
  const forced = await readOracle(page);
  await page.setCacheEnabled(true);
  return { first, forced, warm };
}

for (const lane of [
  { browser: "chrome", executablePath: chromium, family: "chromium", protocol: "cdp" },
  { browser: "firefox", executablePath: firefox, family: "firefox", protocol: "webDriverBiDi" },
]) {
  test(`hostile stealth release oracle classifies pinned ${lane.family}`, {
    skip: lane.executablePath ? false : `pinned ${lane.family} unavailable`,
    timeout: 120_000,
  }, async () => {
    const scope = STEALTH_PROFILE.browser_scope.find(browser => browser.family === lane.family);
    assert.ok(scope);
    assert.equal(lane.executablePath.includes(scope.exact_build), true);
    const server = await startServer();
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await puppeteer.launch({
      browser: lane.browser,
      executablePath: lane.executablePath,
      headless: true,
      protocol: lane.protocol,
      args: lane.family === "chromium" ? ["--disable-gpu", "--no-sandbox"] : [],
    });
    const differences = new Map();
    const matchedEntries = new Set();
    try {
      for (const configuration of [
        { integrity: false, policy: "default" },
        { integrity: true, policy: "strict" },
      ]) {
        const nativePage = await browser.newPage();
        const mediatedPage = await browser.newPage();
        try {
          const [native, mediated] = await Promise.all([
            scenario(nativePage, origin, "native", configuration.policy, configuration.integrity),
            scenario(mediatedPage, origin, "mediated", configuration.policy, configuration.integrity),
          ]);
          for (const cacheState of ["first", "warm", "forced"]) {
            const context = {
              browser: lane.family,
              exact_build: scope.exact_build,
              platform: scope.platform,
              cache_state: cacheState,
              integrity: configuration.integrity,
              policy: configuration.policy,
            };
            for (const realm of Object.keys(native[cacheState].contexts)) {
              classifyDifferences(native[cacheState].contexts[realm], mediated[cacheState].contexts[realm], {
                ...context,
                realm,
              }, differences, matchedEntries);
            }
            classifyWorkerDifference(native[cacheState].worker, mediated[cacheState].worker, context, differences, matchedEntries);
          }
        } finally {
          await nativePage.close();
          await mediatedPage.close();
        }
      }
      if (process.env.ZP_ORACLE_COLLECT === "1") {
        process.stdout.write(`${JSON.stringify({ browser: lane.family, fixtureDigest, differences: [...differences.values()] })}\n`);
      } else {
        const expectedEntries = registry.entries
          .filter(entry => entry.affected_browser_builds.some(browser => browser.family === lane.family && browser.exact_build === scope.exact_build && browser.platform === scope.platform))
          .map(entry => entry.id)
          .sort();
        assert.deepEqual([...matchedEntries].sort(), expectedEntries);
      }
    } finally {
      await browser.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
