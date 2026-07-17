import assert from "node:assert/strict";
import test from "node:test";
import { browseHost, deriveOriginID } from "../../web/control/origin.mjs";

async function originKey() {
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from({ length: 32 }, (_, index) => index),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

test("synthetic origin IDs use the exact domain, truncation, base32, and collision-counter transcript", async () => {
  const key = await originKey();
  assert.equal(await deriveOriginID(key, "https://xn--bcher-kva.example:443"), "4jy2n75nkpyoza7menbmfs2c7n2ngdkq");
  assert.equal(await deriveOriginID(key, "https://xn--bcher-kva.example:443", 1), "m33zld5phwe6iqawdz5kr2wfkmkecci5");
  assert.equal(await deriveOriginID(key, "http://example.test:80"), "fjrejwrx6p5luuh3rq2b73qxplqgi3eh");
  assert.notEqual(
    await deriveOriginID(key, "https://example.test:443"),
    await deriveOriginID(key, "https://example.test:8443"),
    "effective port is part of the HMAC transcript",
  );
});

test("origin derivation accepts only policy-core canonical origins and monotonic counters", async () => {
  const key = await originKey();
  for (const origin of [
    "https://example.test",
    "HTTPS://example.test:443",
    "https://u@example.test:443",
    "https://example.test:0",
    "https://example.test:65536",
    "https://example..test:443",
  ]) {
    await assert.rejects(deriveOriginID(key, origin), TypeError, origin);
  }
  for (const counter of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(deriveOriginID(key, "https://example.test:443", counter), TypeError, String(counter));
  }
  const extractable = await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
  await assert.rejects(deriveOriginID(extractable, "https://example.test:443"), TypeError);
});

test("browsing hosts contain exactly one opaque origin-ID wildcard label", () => {
  const id = "4jy2n75nkpyoza7menbmfs2c7n2ngdkq";
  assert.equal(browseHost(id, "DEPLOYMENT.Example"), `o-${id}.browse.deployment.example`);
  for (const domain of ["", ".example", "example.", "example..test", "-bad.example", "bad-.example", "example/path"]) {
    assert.throws(() => browseHost(id, domain), TypeError, domain);
  }
  assert.throws(() => browseHost(`${id}a`, "deployment.example"), TypeError);
});
