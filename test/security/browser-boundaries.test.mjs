import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const boundary = JSON.parse(await readFile(new URL("../../protocol/browser-boundaries.json", import.meta.url)));
const support = JSON.parse(await readFile(new URL("../../protocol/support-matrix.json", import.meta.url)));

const MEDIATION_CLAIM = "ZeroProxy provides a versioned compatibility and artifact-minimization profile. Passing it means every known stable mediation signal in the specified observations and browser builds is minimized, owned, and listed in the signed delta registry, and no unowned deterministic signal is accepted. It is not a proof of invisibility against arbitrary hostile JavaScript, pristine cross-realm inspection, browser internals, extensions, DevTools, or statistical timing analysis.";
const EGRESS_CLAIM = "No direct target IP/DNS egress is known or observed through the complete, versioned, enumerated transport/navigation/execution matrix; every supported release is packet-capture tested, and unsupported surfaces are disabled or fail closed.";

test("release support requires exact binary evidence and every certification gate", () => {
  for (const lane of boundary.browser_lanes) {
    assert.match(lane.exact_build, /^[0-9]+(?:\.[0-9]+){2,3}$/u);
    assert.match(lane.archive_sha256, /^[a-f0-9]{64}$/u);
    assert.match(lane.binary_sha256, /^[a-f0-9]{64}$/u);
    if (lane.release_supported) {
      assert.equal(lane.packet_capture_certified, true);
      for (const oracle of [lane.native_semantics_oracle, lane.runtime_oracle, lane.transport_oracle, lane.performance_oracle, lane.soak_oracle, lane.corpus_oracle]) {
        assert.equal(oracle, "pass");
      }
    }
  }
  assert.equal(boundary.production_release_eligible, boundary.browser_lanes.every((lane) => lane.release_supported && lane.packet_capture_certified));
});

test("only the approved literal bounded product claims are present", () => {
  assert.equal(boundary.claim_text.mediation, MEDIATION_CLAIM);
  assert.equal(boundary.claim_text.egress, EGRESS_CLAIM);
  assert.equal(support.claim, EGRESS_CLAIM);
  const serialized = JSON.stringify(boundary.claim_text).toLowerCase();
  for (const forbidden of ["undetectable", "mathematical no-egress", "guaranteed anonymous"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("uncertified surfaces are explicitly fail-closed", () => {
  assert.deepEqual(new Set(boundary.unsupported_fail_closed), new Set([
    "WebRTC",
    "WebTransport",
    "direct UDP",
    "raw sockets",
    "synchronous XMLHttpRequest",
    "unsupported background and privacy APIs",
  ]));
});
