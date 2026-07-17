import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeCompilerResult,
  decodeDynamicCompilerResult,
} from "../../web/compiler-result.mjs";

function success(source = "window") {
  return {
    schema_version: 1,
    ok: true,
    code: "__zp_abi_000000000000000000000000000000000000000000000000.scope.window",
    edits: [{
      kind: "owned_global_reference",
      start: 0,
      end: 6,
      replacement: "__zp_abi_000000000000000000000000000000000000000000000000.scope.window",
    }],
    edit_map: [{
      original_start: 0,
      original_end: 6,
      generated_start: 0,
      generated_end: 77,
    }],
    source_map: {
      version: 3,
      file: "zeroproxy://compiler/source",
      sources: ["zeroproxy://compiler/source"],
      sourcesContent: [source],
      names: [],
      mappings: "AAAA",
    },
    module_specifiers: [],
    source_url: null,
    source_mapping_url: null,
    diagnostics: [],
  };
}

function failure() {
  return {
    schema_version: 1,
    ok: false,
    code: null,
    edits: [],
    edit_map: [],
    source_map: null,
    module_specifiers: [],
    source_url: null,
    source_mapping_url: null,
    error: {
      code: "PARSE_FAILED",
      source_kind: "IndirectEvalScript",
      stage: "parse",
      recoverability: "none",
    },
    diagnostics: [],
  };
}

test("compiler success separates byte edit maps from Source Map v3 output", () => {
  const result = decodeCompilerResult(JSON.stringify(success()));
  assert.equal(result.ok, true);
  assert.equal(Array.isArray(result.edit_map), true);
  assert.equal(Array.isArray(result.source_map), false);
  assert.equal(result.source_map.version, 3);
  assert.equal(result.source_map.sourcesContent[0], "window");
});

test("compiler result validation rejects malformed nested success and failure records", () => {
  const badEdit = success();
  badEdit.edits[0].start = -1;
  assert.throws(() => decodeCompilerResult(JSON.stringify(badEdit)), /Invalid compiler result/u);

  const badMap = success();
  badMap.source_map.sourcesContent = [];
  assert.throws(() => decodeCompilerResult(JSON.stringify(badMap)), /Invalid compiler result/u);

  const badFailure = failure();
  badFailure.error.stage = "unknown";
  assert.throws(() => decodeCompilerResult(JSON.stringify(badFailure)), /Invalid compiler result/u);
});

test("dynamic compiler envelopes validate every parameter and body result", () => {
  const valid = {
    schema_version: 1,
    ok: true,
    parameters: [success("value")],
    body: success("return value"),
    diagnostics: [],
  };
  assert.equal(decodeDynamicCompilerResult(JSON.stringify(valid)).ok, true);
  valid.parameters[0].module_specifiers = [{}];
  assert.throws(
    () => decodeDynamicCompilerResult(JSON.stringify(valid)),
    /Invalid dynamic compiler result/u,
  );
  assert.equal(decodeDynamicCompilerResult(JSON.stringify(failure())).error.code, "PARSE_FAILED");
});
