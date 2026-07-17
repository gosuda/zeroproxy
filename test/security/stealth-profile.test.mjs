import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { STEALTH_PROFILE } from "../../web/generated/stealth-profile.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const [profile, schema, support] = await Promise.all([
  readFile(path.join(root, "protocol/stealth-profile.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "protocol/stealth-profile.schema.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "protocol/support-matrix.json"), "utf8").then(JSON.parse),
]);
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

const requiredSurfaces = [
  "global-equality",
  "window-location-reflection",
  "canonical-wrapper-identity",
  "function-reflection",
  "target-dom",
  "parser-ordering",
  "errors-and-source",
  "performance-observability",
  "policy-violations",
  "target-service-worker",
  "internal-url-concealment",
  "root-injection-concealment",
];

test("stealth profile is exact, bounded, generated, and explicitly non-security", () => {
  assert.equal(validate(profile), true, JSON.stringify(validate.errors));
  assert.deepEqual(STEALTH_PROFILE, profile);
  assert.equal(Object.isFrozen(STEALTH_PROFILE), true);
  assert.equal(profile.universal_undetectability_claim, false);
  assert.equal(Object.isFrozen(STEALTH_PROFILE.browser_scope[0]), true);
  assert.equal(profile.claim, "bounded-browser-compatibility-profile-not-security-proof");
  assert.deepEqual(profile.surfaces.map(surface => surface.id), requiredSurfaces);
  const probes = profile.surfaces.flatMap(surface => surface.probes);
  assert.equal(probes.length, profile.limits.probe_count);
  assert.equal(new Set(probes.map(probe => probe.id)).size, probes.length);
  assert.ok(probes.length >= 48 && probes.length <= 64);
  assert.equal(profile.limits.maximum_observation_bytes, 65_536);
  assert.equal(profile.limits.maximum_probe_duration_ms, 5_000);
});

test("stealth scope is the exact pinned support tuple", () => {
  assert.deepEqual(profile.browser_scope, support.browsers.map(({ family, exact_build, platform }) => ({ family, exact_build, platform })));
  assert.deepEqual(support.stealth_oracle, requiredSurfaces);
  assert.equal(profile.comparison.fixture_bytes, "identical-native-and-mediated");
  assert.equal(profile.comparison.difference_policy, "native-equal-or-one-exact-registry-entry");
});
