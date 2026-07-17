import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ADDRESS_POLICY_ID, canonicalEgressHost } from "../../web/control/address-policy.mjs";

const fixture = JSON.parse(await readFile(new URL("../../protocol/address-policy-vectors.json", import.meta.url), "utf8"));

test("browser address policy matches the shared canonical vectors", () => {
  assert.equal(ADDRESS_POLICY_ID, "zeroproxy-address-policy-v1");
  assert.equal(fixture.schema_version, 1);
  for (const vector of fixture.vectors) {
    if (vector.allowed) assert.equal(canonicalEgressHost(vector.input), vector.canonical, vector.input);
    else assert.throws(() => canonicalEgressHost(vector.input), { name: "SecurityError" }, vector.input);
  }
});
