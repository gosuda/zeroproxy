import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const root = path.resolve(import.meta.dirname, "../..");
const [schema, fixtures] = await Promise.all([
  readFile(path.join(root, "protocol/carrier.schema.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "protocol/carrier.fixtures.json"), "utf8").then(JSON.parse),
]);
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addKeyword({ keyword: "x-cbor-key", schemaType: "number" });
ajv.addKeyword({ keyword: "x-cbor-type", schemaType: "string" });
ajv.addSchema(schema);

const validators = Object.fromEntries([
  ["CLIENT_INIT", "ClientInit"],
  ["SERVER_CHALLENGE", "ServerChallenge"],
  ["CLIENT_AUTH", "ClientAuth"],
  ["SERVER_ACCEPT", "ServerAccept"],
].map(([frame, definition]) => [
  frame,
  ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` }),
]));
const validateClaims = ajv.compile({ $ref: `${schema.$id}#/$defs/CapabilityClaims` });

test("canonical carrier fixtures satisfy the separate exact wire schema", () => {
  assert.equal(fixtures.schema_version, 1);
  assert.equal(fixtures.subprotocol, "zeroproxy.carrier.v2");
  assert.deepEqual(Object.keys(fixtures.frames), Object.keys(validators));
  assert.equal(validateClaims(fixtures.capability_claims.value), true, ajv.errorsText(validateClaims.errors));
  assert.match(fixtures.capability_claims.canonical_cbor_hex, /^(?:[0-9a-f]{2})+$/);
  for (const [name, validate] of Object.entries(validators)) {
    assert.equal(validate(fixtures.frames[name].value), true, `${name}: ${ajv.errorsText(validate.errors)}`);
    assert.match(fixtures.frames[name].canonical_cbor_hex, /^(?:[0-9a-f]{2})+$/);
    assert.ok(fixtures.frames[name].canonical_cbor_hex.length <= 4096 * 2);
  }
});

test("carrier schema rejects unknown fields, malformed fixed bytes, and invalid selections", () => {
  const invalidInit = structuredClone(fixtures.frames.CLIENT_INIT.value);
  invalidInit.ambient_token = "forbidden";
  assert.equal(validators.CLIENT_INIT(invalidInit), false);

  const invalidChallenge = structuredClone(fixtures.frames.SERVER_CHALLENGE.value);
  invalidChallenge.challenge_id = "00";
  assert.equal(validators.SERVER_CHALLENGE(invalidChallenge), false);

  const invalidAccept = structuredClone(fixtures.frames.SERVER_ACCEPT.value);
  invalidAccept.negotiated_limits.max_frame_bytes = 65537;
  assert.equal(validators.SERVER_ACCEPT(invalidAccept), false);
  const invalidClaims = structuredClone(fixtures.capability_claims.value);
  invalidClaims.allowed_browsing_origins = ["https://attacker.example"];
  assert.equal(validateClaims(invalidClaims), false);
});
