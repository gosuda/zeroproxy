import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { createLocalDiagnostic, createTelemetryBuffer } from "../../web/diagnostics.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const schema = JSON.parse(await readFile(path.join(root, "protocol/diagnostics.schema.json"), "utf8"));
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const releaseTuple = "a".repeat(64);

function adversarialDiagnostic() {
  return {
    code: "REWRITE_FAILED",
    stage: "REWRITE_HTML",
    request_id: "request_identifier_1234",
    target_url: "https://target.example/private?token=url-secret#fragment-secret",
    headers: { authorization: "Bearer header-secret", cookie: "cookie-secret" },
    body: "body-secret",
    source: "source-secret",
    cookies: "cookie-secret",
    form_fields: { password: "form-secret" },
    internal_cause: { stack: "stack-secret" },
  };
}

const forbidden = [
  "url-secret",
  "fragment-secret",
  "header-secret",
  "body-secret",
  "source-secret",
  "cookie-secret",
  "form-secret",
  "stack-secret",
  createHash("sha256").update("https://target.example").digest("hex"),
];

function assertRedacted(value) {
  const encoded = JSON.stringify(value);
  for (const secret of forbidden) assert.equal(encoded.includes(secret), false, secret);
}

test("local diagnostics retain only hostname, request, stable code, and detailed stage", () => {
  const local = createLocalDiagnostic(adversarialDiagnostic());
  assert.deepEqual(local, {
    schema_version: 1,
    kind: "local",
    target_hostname: "target.example",
    request_id: "request_identifier_1234",
    code: "REWRITE_FAILED",
    stage: "REWRITE_HTML",
  });
  assert.equal(validate(local), true, JSON.stringify(validate.errors));
  assertRedacted(local);
});

test("remote telemetry is profile-opt-in and emits aggregate release/stage/code counters only", async () => {
  const sent = [];
  const telemetry = createTelemetryBuffer({ releaseTuple, send: async batch => sent.push(batch) });
  assert.equal(telemetry.record({ telemetry_opt_in: false }, adversarialDiagnostic()), false);
  assert.equal(await telemetry.flush({ telemetry_opt_in: false }), false);
  assert.deepEqual(sent, []);

  assert.equal(telemetry.record({ telemetry_opt_in: true }, adversarialDiagnostic()), true);
  assert.equal(telemetry.record({ telemetry_opt_in: true }, adversarialDiagnostic()), true);
  assert.equal(await telemetry.flush({ telemetry_opt_in: true }), true);
  assert.deepEqual(sent, [{
    schema_version: 1,
    kind: "telemetry",
    release_tuple: releaseTuple,
    counters: [{ stage: "REWRITE_HTML", code: "REWRITE_FAILED", count: 2 }],
  }]);
  assert.equal(validate(sent[0]), true, JSON.stringify(validate.errors));
  assertRedacted(sent[0]);
  assert.equal(JSON.stringify(sent[0]).includes("request_identifier_1234"), false);
  assert.equal(await telemetry.flush({ telemetry_opt_in: true }), false);
});

test("diagnostic authority rejects unknown or mismatched classifications", () => {
  assert.throws(() => createLocalDiagnostic({ ...adversarialDiagnostic(), code: "UNKNOWN_PRIVATE_CODE" }), /Invalid local diagnostic/u);
  assert.throws(() => createLocalDiagnostic({ ...adversarialDiagnostic(), stage: "TLS" }), /Invalid local diagnostic/u);
  assert.throws(() => createTelemetryBuffer({ releaseTuple: "short", send() {} }), /Invalid telemetry configuration/u);
});
