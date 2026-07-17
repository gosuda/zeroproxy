import assert from "node:assert/strict";
import test from "node:test";
import { DISABLED_PERMISSIONS_POLICY_FEATURES } from "../../web/generated/emerging-network-capabilities.mjs";
import { crossOriginResourcePolicyAllows, documentTrustedTypesPolicyName, generateDocumentCSP, responseIsolationHeaders, translatePermissionsPolicy, xFrameOptionsAllows } from "../../web/sw/document-csp.mjs";

const disabledPermissionsPolicy = DISABLED_PERMISSIONS_POLICY_FEATURES
  .map(feature => `${feature}=()`)
  .join(", ");

const currentID = "a".repeat(32);
const siblingA = "b".repeat(32);
const siblingB = "c".repeat(32);
const syntheticOrigin = `https://o-${currentID}.browse.example.test`;

function configuration(overrides = {}) {
  return {
    destinationHost: new URL(syntheticOrigin).host,
    destinationOriginID: currentID,
    mappedOriginIDs: [siblingB, currentID, siblingA, siblingB],
    nonce: "n".repeat(32),
    relayURLs: ["wss://relay-b.example.test/carrier", "https://relay-a.example.test/connect"],
    syntheticOrigin,
    ...overrides,
  };
}

test("document CSP emits only exact role-bound sibling and approved relay origins", () => {
  assert.equal(generateDocumentCSP(configuration()), [
    "default-src 'none'",
    `script-src 'self' blob: 'nonce-${"n".repeat(32)}' 'wasm-unsafe-eval'`,
    `script-src-elem 'self' blob: 'nonce-${"n".repeat(32)}'`,
    "style-src 'self' 'unsafe-inline' blob:",
    "img-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self' https://relay-a.example.test wss://relay-b.example.test",
    "worker-src 'self' blob:",
    `frame-src 'self' https://o-${siblingA}.browse.example.test https://o-${siblingB}.browse.example.test blob: data:`,
    `form-action 'self' https://o-${siblingA}.browse.example.test https://o-${siblingB}.browse.example.test`,
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; "));
});

test("document CSP rejects unbound hosts, unsafe relays, and unbounded mapped origins", () => {
  assert.throws(
    () => generateDocumentCSP(configuration({ destinationHost: `o-${siblingA}.browse.example.test` })),
    error => error.name === "SecurityError",
  );
  assert.throws(
    () => generateDocumentCSP(configuration({ relayURLs: ["https://user:secret@relay.example.test/"] })),
    error => error.name === "SecurityError",
  );
  assert.throws(
    () => generateDocumentCSP(configuration({ mappedOriginIDs: Array.from({ length: 129 }, () => siblingA) })),
    error => error.name === "SecurityError",
  );
});

test("target document policies become redacted synthetic enforcement directives", () => {
  const documentPolicy = {
    version: 1,
    trusted_types: {
      directive_present: true,
      allow_any: false,
      allowed_policy_names: ["beta", "alpha"],
      allow_duplicates: true,
      require_for_script: true,
    },
    enforced_report_endpoint_count: 2,
    report_only_endpoint_count: 1,
  };
  const csp = generateDocumentCSP(configuration({ documentPolicy }));
  assert.match(csp, new RegExp(`trusted-types alpha beta ${documentTrustedTypesPolicyName("n".repeat(32))} 'allow-duplicates'`, "u"));
  assert.match(csp, /require-trusted-types-for 'script'/u);
  assert.equal(csp.includes("reports.example.test"), false);

  assert.equal(
    translatePermissionsPolicy(["geolocation=(self \"https://target.example\")", "camera=(), microphone=*"]),
    disabledPermissionsPolicy,
  );
  const isolation = responseIsolationHeaders({
    coopValues: ["same-origin; report-to=private"],
    coepValues: ["credentialless"],
    permissionsPolicyValues: ["geolocation=(self)"],
    reportToValues: [JSON.stringify({ group: "private", endpoints: [{ url: "https://reports.example.test/csp" }] })],
    reportingEndpointsValues: ["audit=\"https://reports.example.test/audit\""],
  });
  assert.deepEqual(isolation, {
    coop: "same-origin",
    coep: "credentialless",
    permissionsPolicy: disabledPermissionsPolicy,
    reportEndpointHeaderCount: 2,
  });
  assert.equal(crossOriginResourcePolicyAllows("same-site", "same-site"), true);
  assert.equal(crossOriginResourcePolicyAllows("same-origin", "same-site"), false);
  assert.equal(xFrameOptionsAllows(["SAMEORIGIN"], "same-origin"), true);
  assert.equal(xFrameOptionsAllows(["DENY"], "same-origin"), false);
});
