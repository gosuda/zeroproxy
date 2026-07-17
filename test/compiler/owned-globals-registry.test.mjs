import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DISABLED_NETWORK_GLOBALS,
  isOwnedGlobal,
  OWNED_GLOBAL_REGISTRY,
  OWNED_GLOBAL_REGISTRY_VERSION,
  OWNED_GLOBALS,
} from "../../web/generated/owned-globals.mjs";

const source = JSON.parse(
  await readFile(new URL("../../protocol/owned-globals.json", import.meta.url), "utf8"),
);

const categories = new Set([
  "document-state",
  "dynamic-code",
  "global-identity-navigation",
  "messaging-lifecycle",
  "network",
  "network-disabled",
  "scheduling",
]);

test("owned-global registry is versioned, immutable, and closed", () => {
  assert.equal(source.schema_version, 1);
  assert.equal(OWNED_GLOBAL_REGISTRY_VERSION, source.registry_version);
  assert.deepEqual(OWNED_GLOBAL_REGISTRY, source.entries);
  assert.deepEqual(OWNED_GLOBALS, source.entries.map(entry => entry.name));
  assert(Object.isFrozen(OWNED_GLOBAL_REGISTRY));
  assert(Object.isFrozen(OWNED_GLOBALS));
  assert(Object.isFrozen(DISABLED_NETWORK_GLOBALS));
  assert(OWNED_GLOBAL_REGISTRY.every(Object.isFrozen));
  assert(OWNED_GLOBAL_REGISTRY.every(entry => categories.has(entry.category)));
  assert.deepEqual(OWNED_GLOBALS, [...OWNED_GLOBALS].sort());
  assert.equal(new Set(OWNED_GLOBALS).size, OWNED_GLOBALS.length);
  assert.deepEqual(
    DISABLED_NETWORK_GLOBALS,
    source.entries.filter(entry => entry.category === "network-disabled").map(entry => entry.name),
  );
  assert.deepEqual(DISABLED_NETWORK_GLOBALS, [
    "DigitalCredential",
    "FederatedCredential",
    "FencedFrameConfig",
    "IdentityCredential",
    "NDEFReader",
    "Notification",
    "OTPCredential",
    "PasswordCredential",
    "PaymentRequest",
    "Portal",
    "PublicKeyCredential",
    "RTCDataChannel",
    "RTCDtlsTransport",
    "RTCIceCandidate",
    "RTCIceGatherer",
    "RTCIceTransport",
    "RTCPeerConnection",
    "RTCQuicTransport",
    "RTCSctpTransport",
    "TCPServerSocket",
    "TCPSocket",
    "UDPSocket",
    "WebTransport",
    "WebTransportDatagramDuplexStream",
    "webkitRTCPeerConnection",
  ]);

  for (const name of ["window", "fetch", "Function", "setTimeout", "postMessage"]) {
    assert.equal(isOwnedGlobal(name), true, `${name} must be owned`);
  }
  for (const name of ["Math", "Array", "console", "navigator", ""]) {
    assert.equal(isOwnedGlobal(name), false, `${name} must remain native`);
  }
  assert.equal(isOwnedGlobal(null), false);
});
