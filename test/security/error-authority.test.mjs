import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  createInternalError,
  createPublicError,
  ERROR_CODES,
  ERROR_STAGES,
  ERROR_VERSION,
  errorSpecification,
  normalizeInternalError,
  normalizePublicError,
  publicizeError,
} from "../../web/generated/errors.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const [source, schema] = await Promise.all([
  readFile(path.join(root, "protocol/errors.sources.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "protocol/errors.schema.json"), "utf8").then(JSON.parse),
]);
const requestID = "request_identifier_1234";
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);
const validatePublic = ajv.getSchema(schema.$id);
const validateInternal = ajv.compile({ $ref: `${schema.$id}#/$defs/internal_error` });

test("generated error authority preserves the exact closed source registry", () => {
  assert.equal(ERROR_VERSION, source.error_version);
  assert.deepEqual(ERROR_STAGES, source.stages);
  assert.deepEqual(ERROR_CODES, source.codes.map(({ code }) => code));
  for (const entry of source.codes) {
    assert.deepEqual(errorSpecification(entry.code), {
      stages: entry.stages,
      retryable: entry.retryable,
      message_key: entry.message_key,
    });
  }
});

test("every registered code-stage pair validates as exact internal and public envelopes", () => {
  for (const entry of source.codes) {
    for (const stage of entry.stages) {
      const internal = createInternalError(entry.code, stage, requestID, { boundary: stage });
      const publicError = publicizeError(internal);
      assert.equal(validateInternal(internal), true, JSON.stringify(validateInternal.errors));
      assert.equal(validatePublic(publicError), true, JSON.stringify(validatePublic.errors));
      assert.deepEqual(publicError, {
        code: entry.code,
        stage,
        retryable: entry.retryable,
        request_id: requestID,
        message_key: entry.message_key,
      });
      assert.equal(JSON.stringify(publicError).includes("boundary"), false);
    }
  }
});

test("bindings reject unknown versions, codes, stages, fields, and authority drift", () => {
  const internal = createInternalError("STALE_OPERATION", "COORDINATOR", requestID, "private source text");
  const publicError = createPublicError("STALE_OPERATION", requestID);
  assert.throws(() => createInternalError("UNKNOWN", "INTERNAL", requestID, null), /unknown error code/u);
  assert.throws(() => createInternalError("STALE_OPERATION", "BODY", requestID, null), /invalid error stage/u);
  assert.throws(() => createInternalError("STALE_OPERATION", "COORDINATOR", requestID, null, ERROR_VERSION + 1), /unknown error version/u);
  assert.throws(() => normalizeInternalError({ ...internal, retryable: false }), /invalid retryable/u);
  assert.throws(() => normalizeInternalError({ ...internal, extra: true }), /invalid internal error envelope/u);
  assert.throws(() => normalizeInternalError({ ...internal, internal_cause: { missing: undefined } }), /invalid internal error cause/u);
  assert.throws(() => normalizePublicError({ ...publicError, message_key: "private source text" }), /invalid public message key/u);
  assert.throws(() => normalizePublicError({ ...publicError, request_id: "short" }), /invalid error request ID/u);
  assert.equal(validateInternal({ ...internal, stage: "UNKNOWN" }), false);
  assert.equal(validatePublic({ ...publicError, code: "UNKNOWN" }), false);
  assert.equal(validatePublic({ ...publicError, extra: true }), false);
});
