import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  DISABLED_CAPABILITY_METHODS,
  DISABLED_EMERGING_GLOBALS,
  DISABLED_PERMISSIONS_POLICY_FEATURES,
  EMERGING_MARKUP_BLOCKS,
} from "../../web/generated/emerging-network-capabilities.mjs";
import { DISABLED_NETWORK_GLOBALS } from "../../web/generated/owned-globals.mjs";

const load = async name => JSON.parse(await readFile(new URL(`../../protocol/${name}`, import.meta.url), "utf8"));
const [boundaries, inventory, policyInventory, schema, source] = await Promise.all([
  load("browser-boundaries.json"),
  load("emerging-network-capabilities.json"),
  load("policy-inventory.sources.json"),
  load("emerging-network-capabilities.schema.json"),
  load("emerging-network-capabilities.sources.json"),
]);

const categories = [
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
];

test("emerging network inventory is schema-valid and pinned to both release browsers", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.equal(validate(inventory), true, ajv.errorsText(validate.errors));
  assert.equal(inventory.release_id, boundaries.release_id);
  assert.deepEqual(
    inventory.browser_lanes,
    boundaries.browser_lanes.map(({ family, exact_build, platform, binary_sha256 }) => ({
      family,
      exact_build,
      platform,
      binary_sha256,
    })),
  );
  for (const family of ["chromium", "firefox"]) {
    const values = inventory.capabilities.map(capability => capability.native_presence[family]);
    assert(values.includes(true), `${family} inventory must contain observed surfaces`);
    assert(values.includes(false), `${family} inventory must record native omissions`);
  }
});

function expectedBehaviors(capability) {
  const parserPolicy = ["markup", "script-type"].includes(capability.binding.kind);
  return capability.realms.map(realm => ({
    realm,
    boundary: parserPolicy
      ? "document-policy-rejection"
      : realm === "target-service-worker" ? "promise-rejection" : "synchronous",
    exception: parserPolicy ? "SecurityError" : "NotSupportedError",
  }));
}

test("every required emerging capability category has one exact disabled behavior and packet contract", () => {
  assert.deepEqual([...new Set(inventory.capabilities.map(capability => capability.category))].sort(), categories);
  assert.equal(new Set(inventory.capabilities.map(capability => capability.id)).size, inventory.capabilities.length);
  assert.equal(new Set(inventory.capabilities.map(capability => JSON.stringify(capability.binding))).size, inventory.capabilities.length);
  for (const capability of inventory.capabilities) {
    assert.equal(capability.disposition, "disabled");
    assert.deepEqual(capability.behaviors, expectedBehaviors(capability));
    assert.equal(capability.packet_test_id, "emerging-capability-zero-egress-v1");
  }
  assert.deepEqual(
    inventory.capabilities.map(({ native_presence: _nativePresence, ...capability }) => capability),
    source.capabilities.map(capability => ({
      ...capability,
      disposition: "disabled",
      behaviors: expectedBehaviors(capability),
      packet_test_id: "emerging-capability-zero-egress-v1",
    })),
  );
});

test("generated runtime and markup authorities cover every executable inventory binding", () => {
  const globals = inventory.capabilities
    .filter(capability => capability.binding.kind === "global")
    .map(capability => capability.binding.name);
  assert.deepEqual(DISABLED_EMERGING_GLOBALS, globals);
  for (const name of globals) assert(DISABLED_NETWORK_GLOBALS.includes(name), `${name} must be compiler-owned`);

  const documentMethods = inventory.capabilities
    .filter(capability => capability.realms.includes("document") && ["prototype-method", "static-method"].includes(capability.binding.kind));
  assert.deepEqual(DISABLED_CAPABILITY_METHODS.map(method => method.id), documentMethods.map(capability => capability.id));

  const markup = inventory.capabilities.filter(capability => capability.binding.kind === "markup");
  assert.deepEqual(EMERGING_MARKUP_BLOCKS.map(entry => entry.id), markup.map(capability => capability.id));
  for (const capability of markup) {
    assert(policyInventory.entries.some(entry => entry.namespace === "html"
      && entry.element === capability.binding.element
      && entry.attribute === capability.binding.attribute
      && entry.disposition === "block"), `${capability.id} must be blocked by the static policy inventory`);
  }
  assert.deepEqual(DISABLED_PERMISSIONS_POLICY_FEATURES, inventory.permissions_policy_features);
});
