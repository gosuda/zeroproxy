import assert from "node:assert/strict";
import test from "node:test";
import { verifyIntegrity } from "../../web/sw/sri.mjs";

const encoder = new TextEncoder();

async function integrity(algorithm, source) {
  const bytes = await crypto.subtle.digest(algorithm, encoder.encode(source));
  return `${algorithm.toLowerCase().replace("-", "")}-${Buffer.from(bytes).toString("base64")}`;
}

test("SRI checks original bytes rather than rewritten bytes", async () => {
  const original = "globalThis.answer = 40 + 2;";
  const rewritten = "globalThis.answer = __zp_add(40, 2);";
  const metadata = await integrity("SHA-384", original);
  assert.equal(await verifyIntegrity(encoder.encode(original), metadata), true);
  assert.equal(await verifyIntegrity(encoder.encode(rewritten), metadata), false);
});

test("SRI accepts any matching digest at the strongest supported level", async () => {
  const body = encoder.encode("body");
  const weak = await integrity("SHA-256", "body");
  const strongMismatch = await integrity("SHA-512", "other");
  const strongMatch = await integrity("SHA-512", "body");
  assert.equal(await verifyIntegrity(body, `${weak} ${strongMismatch} ${strongMatch}?option`), true);
  assert.equal(await verifyIntegrity(body, `${weak} ${strongMismatch}`), false);
});

test("SRI never downgrades from a parsed stronger digest", async () => {
  const body = encoder.encode("body");
  const weakMatch = await integrity("SHA-256", "body");
  assert.equal(await verifyIntegrity(body, `${weakMatch} sha512-AAAA`), false);
});

test("SRI ignores unsupported and malformed metadata", async () => {
  const body = encoder.encode("body");
  assert.equal(await verifyIntegrity(body, ""), true);
  assert.equal(await verifyIntegrity(body, "md5-AAAA sha384-%%%"), true);
});

test("cross-origin SRI requires an eligible CORS response", async () => {
  const body = encoder.encode("body");
  const metadata = await integrity("SHA-384", "body");
  const base = {
    sourceURL: "https://app.example/page",
    targetURL: "https://cdn.example/app.js",
    corsMode: "anonymous",
  };
  assert.equal(await verifyIntegrity(body, metadata, {...base, headers: []}), false);
  assert.equal(await verifyIntegrity(body, metadata, {...base, headers: [["Access-Control-Allow-Origin", "*"]]}), true);
  assert.equal(await verifyIntegrity(body, metadata, {...base, corsMode: null, headers: [["Access-Control-Allow-Origin", "*"]]}), false);
});

test("credentialed and duplicate CORS response headers fail exactly", async () => {
  const body = encoder.encode("body");
  const metadata = await integrity("SHA-384", "body");
  const base = {
    sourceURL: "https://app.example/page",
    targetURL: "https://cdn.example/app.js",
    corsMode: "use-credentials",
  };
  assert.equal(await verifyIntegrity(body, metadata, {
    ...base,
    headers: [["Access-Control-Allow-Origin", "https://app.example"], ["Access-Control-Allow-Credentials", "true"]],
  }), true);
  assert.equal(await verifyIntegrity(body, metadata, {
    ...base,
    headers: [["Access-Control-Allow-Origin", "https://app.example"], ["Access-Control-Allow-Credentials", "TRUE"]],
  }), false);
  assert.equal(await verifyIntegrity(body, metadata, {
    ...base,
    headers: [
      ["Access-Control-Allow-Origin", "https://app.example"],
      ["Access-Control-Allow-Origin", "https://app.example"],
      ["Access-Control-Allow-Credentials", "true"],
    ],
  }), false);
});
