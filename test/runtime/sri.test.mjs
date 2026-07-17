import assert from "node:assert/strict";
import test from "node:test";

import { verifyIntegrity } from "../../web/sw/sri.mjs";

const bytes = new TextEncoder().encode("original target bytes");
const digest = Buffer.from(await crypto.subtle.digest("SHA-384", bytes)).toString("base64");
const metadata = `sha256-invalid sha384-${digest}`;

test("SRI verifies the strongest matching digest over original bytes", async () => {
  assert.equal(
    await verifyIntegrity(bytes, metadata, {
      sourceURL: "https://target.example/document.html",
      targetURL: "https://target.example/app.js",
      corsMode: null,
      headers: [],
    }),
    true,
  );
  assert.equal(
    await verifyIntegrity(new TextEncoder().encode("rewritten bytes"), metadata, {
      sourceURL: "https://target.example/document.html",
      targetURL: "https://target.example/app.js",
      corsMode: null,
      headers: [],
    }),
    false,
  );
});

test("SRI rejects cross-origin resources without eligible CORS", async () => {
  const context = {
    sourceURL: "https://document.example/index.html",
    targetURL: "https://cdn.example/app.js",
    corsMode: "anonymous",
    headers: [["Access-Control-Allow-Origin", "https://other.example"]],
  };
  assert.equal(await verifyIntegrity(bytes, metadata, context), false);
  assert.equal(
    await verifyIntegrity(bytes, metadata, {
      ...context,
      headers: [["Access-Control-Allow-Origin", "*"]],
    }),
    true,
  );
});
