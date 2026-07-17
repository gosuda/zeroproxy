import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { NATIVE_FAILURE_SHAPES, NATIVE_FAILURE_TABLE_VERSION } from "../../web/generated/native-failure-shapes.mjs";
import { createNavigationFailureResponse } from "../../web/sw/navigation-failure.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const [table, schema] = await Promise.all([
  readFile(path.join(root, "protocol/native-failure-shapes.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "protocol/native-failure-shapes.schema.json"), "utf8").then(JSON.parse),
]);
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

test("native failure table is exact, closed, generated, and executable-byte safe", () => {
  assert.equal(validate(table), true, JSON.stringify(validate.errors));
  assert.equal(NATIVE_FAILURE_TABLE_VERSION, table.table_version);
  assert.deepEqual(Object.keys(NATIVE_FAILURE_SHAPES), table.rows.map(({ surface }) => surface));
  for (const row of table.rows) {
    assert.deepEqual(NATIVE_FAILURE_SHAPES[row.surface], row);
    assert.equal(row.original_bytes_executed, false);
    assert.match(row.test_id, /^[a-z][a-z0-9-]+$/u);
  }
});

test("navigation failures are external-script same-origin documents with stable local diagnostics", async () => {
  const response = createNavigationFailureResponse({
    code: "REWRITE_FAILED",
    requestID: "request_identifier_1234",
    retryPath: `/_zp/p/document/${"r".repeat(32)}`,
    scriptPath: `/_zp/assets/${"a".repeat(64)}/native-failure-page.mjs`,
    stage: "REWRITE_HTML",
    targetURL: "https://target.example/private?secret=value#fragment",
  });
  const html = await response.text();
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'; script-src 'self'/u);
  assert.match(html, /<button id="zp-back"[^>]*>Back<\/button>/u);
  assert.match(html, /<button id="zp-home"[^>]*>Home<\/button>/u);
  assert.match(html, /<button id="zp-retry"[^>]*>Retry<\/button>/u);
  assert.match(html, /<script type="module" src="\/_zp\/assets\/[a-f0-9]{64}\/native-failure-page\.mjs"><\/script>/u);
  assert.equal(/<script(?![^>]+src=)/u.test(html), false);
  assert.equal(html.includes("https://target.example/private?secret=value#fragment"), false);
  assert.match(html, /REWRITE_FAILED/u);
  assert.match(html, /target\.example/u);
  assert.match(html, /REWRITE_HTML/u);
  assert.match(html, /request_identifier_1234/u);
});

test("navigation failure responses reject untrusted diagnostics and routes", () => {
  const valid = {
    code: "REWRITE_FAILED",
    requestID: "request_identifier_1234",
    retryPath: "/_zp/p/document/retry",
    scriptPath: "/_zp/assets/script/native-failure-page.mjs",
    stage: "REWRITE_HTML",
  };
  assert.throws(() => createNavigationFailureResponse({ ...valid, code: "source text" }), /Invalid navigation failure response/u);
  assert.throws(() => createNavigationFailureResponse({ ...valid, requestID: "short" }), /Invalid navigation failure response/u);
  assert.throws(() => createNavigationFailureResponse({ ...valid, retryPath: "https://target.example/" }), /Invalid navigation failure response/u);
  assert.throws(() => createNavigationFailureResponse({ ...valid, scriptPath: "//target.example/script.js" }), /Invalid navigation failure response/u);
});
