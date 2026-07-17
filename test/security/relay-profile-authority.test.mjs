import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { verifyRelayProfileSet } from "../../web/control/relay-profile.mjs";

const digest = "e466728411805ea3c97c9ba046b0d88d6e0477c0683078c441854bce65801e24";
const profile = JSON.parse(await readFile(new URL(`../../protocol/relay-profiles/${digest}.json`, import.meta.url), "utf8"));
const signatures = JSON.parse(await readFile(new URL(`../../protocol/relay-profiles/${digest}.sig`, import.meta.url), "utf8"));
const keys = JSON.parse(await readFile(new URL("../../protocol/release-signing-keys.json", import.meta.url), "utf8"));
const addressPolicy = JSON.parse(await readFile(new URL("../../protocol/address-policy.json", import.meta.url), "utf8"));
const addressPolicySignatures = JSON.parse(await readFile(new URL("../../protocol/address-policy.sig", import.meta.url), "utf8"));
const digestBase64URL = Buffer.from(digest, "hex").toString("base64url");
const at = Date.parse("2026-07-16T00:00:00Z");

function config(overrides = {}) {
  return {
    development_mode: true,
    release_signing_keys: structuredClone(keys),
    address_policy: structuredClone(addressPolicy),
    address_policy_signatures: structuredClone(addressPolicySignatures),
    relay_profiles: [{ digest: digestBase64URL, profile: structuredClone(profile), signatures: structuredClone(signatures) }],
    ...overrides,
  };
}

test("browser verifies the signed content-addressed relay profile", async () => {
  const installed = await verifyRelayProfileSet(config(), { now: at });
  const verified = installed.get(digestBase64URL);
  assert.equal(installed.size, 1);
  assert.equal(verified.relay_url, "wss://relay.example.test/_zp/carrier");
  assert.equal(verified.profile.privacy_disclosure, "The relay sees the client IP, target hostname and port, timing and volume, and plaintext HTTP, but not verified HTTPS plaintext.");
  assert.equal(Object.isFrozen(verified.profile), true);
});

test("browser re-verification rejects a profile that expired after installation", async () => {
  const configured = config();
  const installed = await verifyRelayProfileSet(configured, { now: at });
  assert.equal(installed.has(digestBase64URL), true);
  await assert.rejects(
    verifyRelayProfileSet(configured, { now: Date.parse("2027-01-01T00:00:00Z") }),
    { name: "SecurityError" },
  );
});

test("browser rejects profile digest, signature, expiry, revocation, and development mismatches", async () => {
  const cases = [
    ["digest", () => { const value = config(); value.relay_profiles[0].digest = "A".repeat(43); return value; }],
    ["signature", () => { const value = config(); value.relay_profiles[0].signatures.signatures[0].signature = "A".repeat(86); return value; }],
    ["address policy", () => { const value = config(); value.address_policy.blocked_suffixes.pop(); return value; }],
    ["address signature", () => { const value = config(); value.address_policy_signatures.signatures[0].signature = "A".repeat(86); return value; }],
    ["revocation", () => { const value = config(); value.relay_profiles[0].profile.revoked_at = "2026-07-15T00:00:00Z"; return value; }],
    ["development", () => config({ development_mode: false })],
    ["unknown field", () => { const value = config(); value.relay_profiles[0].profile.unknown = true; return value; }],
  ];
  for (const [name, create] of cases) {
    await assert.rejects(verifyRelayProfileSet(create(), { now: at }), { name: "SecurityError" }, name);
  }
  await assert.rejects(verifyRelayProfileSet(config(), { now: Date.parse("2027-01-01T00:00:00Z") }), { name: "SecurityError" });
});
