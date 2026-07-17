import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { launch } from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "protocol/emerging-network-capabilities.sources.json");
const outputPath = path.join(root, "protocol/emerging-network-capabilities.json");
const generatedModulePath = path.join(root, "web/generated/emerging-network-capabilities.mjs");
const boundariesPath = path.join(root, "protocol/browser-boundaries.json");
const mode = process.argv[2] ?? "";
if (!["", "--check", "--probe"].includes(mode)) throw new Error("usage: generate-emerging-network-capabilities.mjs [--check|--probe]");

const source = JSON.parse(await readFile(sourcePath, "utf8"));
const boundaries = JSON.parse(await readFile(boundariesPath, "utf8"));
const bindingKinds = new Set(["global", "prototype-method", "static-method", "markup", "script-type"]);
const categories = new Set([
  "advertising-privacy",
  "bluetooth",
  "federated-identity",
  "geolocation",
  "isolated-navigation",
  "media-capture-device-discovery",
  "payments",
  "push-notifications-background",
  "serial-hid-nfc",
  "usb",
  "web-share-url-handlers",
  "webauthn-passkeys",
]);
if (source.schema_version !== 1 || source.inventory_version !== 1 || !Array.isArray(source.capabilities)) throw new Error("invalid emerging capability inventory header");
if (!Array.isArray(source.permissions_policy_features) || source.permissions_policy_features.length === 0) throw new Error("missing disabled permissions policy features");
if (source.policy_exception?.boundary !== "synchronous" || source.policy_exception?.name !== "NotSupportedError" || source.policy_exception?.message_suffix !== " is disabled by ZeroProxy policy") throw new Error("invalid emerging capability exception contract");
if (source.packet_test_id !== "emerging-capability-zero-egress-v1") throw new Error("invalid emerging capability packet contract");
const ids = new Set();
const bindings = new Set();
for (const capability of source.capabilities) {
  if (!capability || typeof capability !== "object" || typeof capability.id !== "string" || ids.has(capability.id)) throw new Error("duplicate or invalid emerging capability id");
  if (!categories.has(capability.category) || !Array.isArray(capability.realms) || capability.realms.length === 0) throw new Error(`invalid emerging capability ${capability.id}`);
  if (!bindingKinds.has(capability.binding?.kind)) throw new Error(`invalid emerging capability binding ${capability.id}`);
  const bindingKey = JSON.stringify(capability.binding);
  if (bindings.has(bindingKey)) throw new Error(`duplicate emerging capability binding ${bindingKey}`);
  ids.add(capability.id);
  bindings.add(bindingKey);
}
for (const category of categories) if (!source.capabilities.some(capability => capability.category === category)) throw new Error(`missing emerging capability category ${category}`);
const sortedPermissionFeatures = [...source.permissions_policy_features].sort();
if (JSON.stringify(sortedPermissionFeatures) !== JSON.stringify(source.permissions_policy_features) || new Set(sortedPermissionFeatures).size !== sortedPermissionFeatures.length) throw new Error("disabled permissions policy features must be sorted and unique");
if (boundaries.schema_version !== 2 || !Array.isArray(boundaries.browser_lanes) || boundaries.browser_lanes.length !== 2) throw new Error("invalid browser boundary authority");
const lanes = boundaries.browser_lanes.map(({ family, exact_build, platform, binary_sha256 }) => ({
  family,
  exact_build,
  platform,
  binary_sha256,
}));

function capabilityBehaviors(capability) {
  const parserPolicy = ["markup", "script-type"].includes(capability.binding.kind);
  return capability.realms.map(realm => ({
    realm,
    boundary: parserPolicy
      ? "document-policy-rejection"
      : realm === "target-service-worker" ? "promise-rejection" : "synchronous",
    exception: parserPolicy ? "SecurityError" : "NotSupportedError",
  }));
}

function baseCapability(capability) {
  return {
    ...capability,
    disposition: "disabled",
    behaviors: capabilityBehaviors(capability),
    packet_test_id: source.packet_test_id,
  };
}

function expectedInventory(nativePresence) {
  return {
    schema_version: source.schema_version,
    inventory_version: source.inventory_version,
    release_id: boundaries.release_id,
    browser_lanes: lanes,
    policy_exception: source.policy_exception,
    packet_test_id: source.packet_test_id,
    permissions_policy_features: source.permissions_policy_features,
    capabilities: source.capabilities.map(capability => ({
      ...baseCapability(capability),
      native_presence: nativePresence[capability.id],
    })),
  };
}

async function probeLane(lane) {
  const configured = boundaries.browser_lanes.find(candidate => candidate.family === lane.family);
  const executablePath = path.resolve(root, configured.binary_path);
  const browser = await launch({
    browser: lane.family === "firefox" ? "firefox" : "chrome",
    executablePath,
    headless: true,
    args: lane.family === "chromium" ? ["--no-first-run"] : [],
  });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end("<!doctype html><meta charset=utf-8><title>ZeroProxy capability probe</title>");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded" });
    return await page.evaluate(capabilities => {
      const present = binding => {
        switch (binding.kind) {
          case "global": return typeof globalThis[binding.name] === "function";
          case "prototype-method": return typeof globalThis[binding.owner]?.prototype?.[binding.member] === "function";
          case "static-method": return typeof globalThis[binding.owner]?.[binding.member] === "function";
          case "markup": return binding.attribute in document.createElement(binding.element);
          case "script-type": return HTMLScriptElement.supports?.(binding.type) === true;
          default: return false;
        }
      };
      return Object.fromEntries(capabilities.map(capability => [capability.id, present(capability.binding)]));
    }, source.capabilities);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

function generatedModule() {
  const documentMethods = source.capabilities
    .filter(capability => capability.realms.includes("document") && ["prototype-method", "static-method"].includes(capability.binding.kind))
    .map(capability => ({ id: capability.id, label: `${capability.binding.owner}.${capability.binding.member}`, ...capability.binding }));
  const markupBlocks = source.capabilities
    .filter(capability => capability.binding.kind === "markup")
    .map(capability => ({ id: capability.id, ...capability.binding }));
  return `// Generated by scripts/generate-emerging-network-capabilities.mjs. DO NOT EDIT.\nexport const EMERGING_CAPABILITY_INVENTORY_VERSION = ${source.inventory_version};\nexport const DISABLED_CAPABILITY_METHODS = Object.freeze(${JSON.stringify(documentMethods)}.map(Object.freeze));\nexport const DISABLED_EMERGING_GLOBALS = Object.freeze(${JSON.stringify(source.capabilities.filter(capability => capability.binding.kind === "global").map(capability => capability.binding.name))});\nexport const DISABLED_PERMISSIONS_POLICY_FEATURES = Object.freeze(${JSON.stringify(source.permissions_policy_features)});\nexport const EMERGING_MARKUP_BLOCKS = Object.freeze(${JSON.stringify(markupBlocks)}.map(Object.freeze));\n`;
}

if (mode === "--probe") {
  const observations = {};
  for (const lane of lanes) {
    const result = await probeLane(lane);
    for (const capability of source.capabilities) {
      observations[capability.id] ??= {};
      observations[capability.id][lane.family] = result[capability.id] === true;
    }
  }
  await writeFile(outputPath, `${JSON.stringify(expectedInventory(observations), null, 2)}\n`);
  await writeFile(generatedModulePath, generatedModule());
} else {
  const current = JSON.parse(await readFile(outputPath, "utf8"));
  const nativePresence = Object.fromEntries(current.capabilities.map(capability => [capability.id, capability.native_presence]));
  const expected = expectedInventory(nativePresence);
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("generated emerging capability inventory is stale");
  for (const capability of current.capabilities) {
    if (typeof capability.native_presence?.chromium !== "boolean" || typeof capability.native_presence?.firefox !== "boolean") throw new Error(`missing browser observation for ${capability.id}`);
  }
  const moduleSource = generatedModule();
  if (mode === "--check") {
    if (await readFile(generatedModulePath, "utf8") !== moduleSource) throw new Error("generated emerging capability runtime authority is stale");
  } else {
    await writeFile(generatedModulePath, moduleSource);
  }
}
