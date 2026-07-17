import assert from "node:assert/strict";
import test from "node:test";

import { classifyRequest } from "../../web/generated/policy.mjs";

const capability = "A".repeat(32);

test("rewritten external stylesheet route reaches the target route handler", () => {
  assert.equal(classifyRequest(`/_zp/p/style/${capability}`), "target-route");
  assert.notEqual(classifyRequest(`/_zp/p/style/${capability}`), "unknown");
});

test("navigation target routes share the closed target-route grammar", () => {
  assert.equal(classifyRequest(`/_zp/p/navigation/${capability}`), "target-route");
  assert.equal(classifyRequest(`/_zp/p/navigation/${capability}?forged=1`), "unknown");
});

test("every policy-core target route segment is admitted", () => {
  for (const kind of ["document", "navigation", "resource", "script", "module", "style", "worker", "worklet", "download", "target-worker"]) {
    assert.equal(classifyRequest(`/_zp/p/${kind}/${capability}`), "target-route");
  }
});

test("api plans and malformed target routes remain disjoint", () => {
  assert.equal(classifyRequest(`/_zp/api/${capability}`), "api-plan");
  assert.equal(classifyRequest(`/_zp/p/style/${capability.slice(1)}`), "unknown");
  assert.equal(classifyRequest("/_zp/p/style/not-a-capability"), "unknown");
});

test("sealed navigation and egress routes use only the closed operation/token grammar", () => {
  const operation = "a".repeat(48);
  const token = "t".repeat(32);
  for (const kind of ["navigation", "form", "beacon", "ping", "download"]) {
    assert.equal(classifyRequest(`/_zp/${kind}/${operation}/${token}`), "sealed-route");
    assert.equal(classifyRequest(`/_zp/${kind}/${operation.slice(1)}/${token}`), "unknown");
    assert.equal(classifyRequest(`/_zp/${kind}/${operation}/${token}!`), "unknown");
  }
  assert.equal(classifyRequest(`/_zp/wi/${capability}/${token}`), "worker-gateway-classic");
  assert.equal(classifyRequest(`/_zp/wmi/${capability}/${token}`), "worker-gateway-module");
  assert.equal(classifyRequest(`/_zp/w/${capability}.js`), "worker-executable-classic");
  assert.equal(classifyRequest(`/_zp/wm/${capability}/${"b".repeat(64)}.mjs`), "worker-executable-module");
  assert.equal(classifyRequest(`/_zp/dm/${capability}/${"d".repeat(64)}.mjs`), "document-executable-module");
  assert.equal(classifyRequest(`/_zp/worklet/${capability}.mjs`), "worklet-executable");
  assert.equal(classifyRequest(`/_zp/target-worker-exec/${"c".repeat(64)}.mjs`), "target-worker-executable");
  assert.equal(classifyRequest(`/_zp/unknown/${operation}/${token}`), "unknown");
});
