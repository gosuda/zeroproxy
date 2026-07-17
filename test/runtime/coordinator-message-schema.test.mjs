import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const root = path.resolve(import.meta.dirname, "../..");
const [messagesSchema, errorsSchema] = await Promise.all([
  readFile(path.join(root, "protocol/messages.schema.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "protocol/errors.schema.json"), "utf8").then(JSON.parse),
]);
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(errorsSchema);
const validate = ajv.compile(messagesSchema);

const request = {
  v: 2,
  request_id: "request_identifier_1234",
  operation: "MAP_ORIGIN",
  expected_revision: 7,
  payload: { profile_id: "profile" },
};
const success = {
  v: 2,
  request_id: request.request_id,
  ok: true,
  revision: 8,
  result: { origin_id: "origin" },
};
const failure = {
  v: 2,
  request_id: request.request_id,
  ok: false,
  revision: 7,
  error: {
    code: "STALE_OPERATION",
    stage: "COORDINATOR",
    retryable: true,
    request_id: request.request_id,
    message_key: "stale_operation",
  },
};

test("coordinator protocol accepts only exact revisioned request and response envelopes", () => {
  assert.equal(validate(request), true, JSON.stringify(validate.errors));
  assert.equal(validate(success), true, JSON.stringify(validate.errors));
  assert.equal(validate(failure), true, JSON.stringify(validate.errors));

  for (const malformed of [
    { ...request, unexpected: true },
    Object.fromEntries(Object.entries(request).filter(([key]) => key !== "expected_revision")),
    { ...request, request_id: "short" },
    { ...success, error: failure.error },
    { ...failure, result: {} },
    { ...success, ok: false },
    { ...failure, ok: true },
  ]) {
    assert.equal(validate(malformed), false, JSON.stringify(malformed));
  }
});
