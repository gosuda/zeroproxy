import assert from "node:assert/strict";
import test from "node:test";
import { ABI_TEMPLATE_IDENTIFIER, rewriteClassicScript, rewriteWorkerModule, rewriteWorkletModule } from "../../web/sw/script-rewrite.mjs";

const ABI = "__zp_abi_222222222222222222222222222222222222222222222222";
function compilerSuccess(source, overrides = {}) {
  return {
    schema_version: 1,
    ok: true,
    code: source,
    edits: [],
    edit_map: [],
    source_map: {
      version: 3,
      file: "zeroproxy://test/source",
      sources: ["zeroproxy://test/source"],
      sourcesContent: [source],
      names: [],
      mappings: "",
    },
    module_specifiers: [],
    source_url: null,
    source_mapping_url: null,
    diagnostics: [],
    ...overrides,
  };
}


test("external classic scripts end with a controlled map and sanitized source identity", () => {
  const calls = [];
  const compiler = {
    compile_template_json(source, kind) {
      calls.push({ operation: "compileTemplate", source, kind });
      return JSON.stringify(compilerSuccess(source, {
        code: `${ABI_TEMPLATE_IDENTIFIER}.scope.window;`,
        edits: [{ kind: "owned_global_reference", start: 0, end: 6, replacement: `${ABI_TEMPLATE_IDENTIFIER}.scope.window` }],
        edit_map: [{ original_start: 0, original_end: 6, generated_start: 0, generated_end: 64 }],
        source_url: "authored.js\nself.evil=true<",
        source_mapping_url: "https://target.test/app.js.map",
        abi_identifiers: [],
        abi_slots: [{ start: 0, end: ABI_TEMPLATE_IDENTIFIER.length }],
      }));
    },
    source_map_base64(...args) {
      calls.push({ operation: "map", args });
      return "Y29udHJvbGxlZA==";
    },
  };
  const source = "window";
  const output = rewriteClassicScript(source, "https://target.test/app.js", ABI, compiler);
  assert.deepEqual(calls[0], { operation: "compileTemplate", source, kind: "ClassicScriptExternal" });
  assert.deepEqual(calls[1].args, [
    source,
    `${ABI}.scope.window;`,
    0,
    "authored.js%0Aself.evil=true%3C",
    JSON.stringify([{ original_start: 0, original_end: 6, generated_start: 0, generated_end: 64 }]),
    "https://target.test/app.js.map",
  ]);
  assert.match(output, /\/\/# sourceURL=authored\.js%0Aself\.evil=true%3C\n/u);
  assert.ok(output.endsWith("//# sourceMappingURL=data:application/json;base64,Y29udHJvbGxlZA=="));
  assert.equal(output.includes("https://target.test/app.js.map"), false);
});

test("external classic scripts reject malformed compiler and map results", () => {
  assert.throws(
    () => rewriteClassicScript("window", "https://target.test/app.js", ABI, {
      compile_template_json: () => JSON.stringify({ code: "window", source_map: null, abi_identifiers: [], abi_slots: [] }),
      source_map_base64: () => "map",
    }),
    /Invalid classic-script compiler result/u,
  );
  assert.throws(
    () => rewriteClassicScript("window", "https://target.test/app.js", ABI, {
      compile_template_json: () => JSON.stringify(compilerSuccess("window", { abi_identifiers: [], abi_slots: [] })),
      source_map_base64: () => "",
    }),
    /Invalid classic-script source map/u,
  );
});

test("classic templates fill only compiler-owned ABI slots and reject colliding ABIs", () => {
  const code = `${ABI_TEMPLATE_IDENTIFIER}.evalSource("${ABI_TEMPLATE_IDENTIFIER}",null);`;
  const compiler = {
    compile_template_json: () => JSON.stringify(compilerSuccess("window", {
      code,
      edits: [{ kind: "owned_global_reference", start: 0, end: 6, replacement: code }],
      edit_map: [{
        original_start: 0,
        original_end: 6,
        generated_start: 0,
        generated_end: Buffer.byteLength(code),
      }],
      abi_identifiers: [],
      abi_slots: [{ start: 0, end: ABI_TEMPLATE_IDENTIFIER.length }],
    })),
    source_map_base64: () => "map",
  };
  const output = rewriteClassicScript("window", "https://target.test/app.js", ABI, compiler);
  assert.match(output, new RegExp(`${ABI}\\.evalSource\\("${ABI_TEMPLATE_IDENTIFIER}",null\\)`, "u"));
  assert.throws(
    () => rewriteClassicScript("window", "https://target.test/app.js", ABI, {
      ...compiler,
      compile_template_json: () => JSON.stringify(compilerSuccess("window", {
        code: `${ABI_TEMPLATE_IDENTIFIER}.scope.window;`,
        edits: [{ kind: "owned_global_reference", start: 0, end: 6, replacement: `${ABI_TEMPLATE_IDENTIFIER}.scope.window` }],
        edit_map: [{ original_start: 0, original_end: 6, generated_start: 0, generated_end: Buffer.byteLength(`${ABI_TEMPLATE_IDENTIFIER}.scope.window;`) }],
        abi_identifiers: [ABI],
        abi_slots: [{ start: 0, end: ABI_TEMPLATE_IDENTIFIER.length }],
      })),
    }),
    /Compiler rejected executable source/u,
  );
});

test("worker module graph rewriting preserves compiler-owned byte spans and rejects unbound graph routes", () => {
  const calls = [];
  const code = "/*😀*/ import value from './first.js'; export { value } from './second.js';";
  const literal = (specifier) => {
    const start = code.indexOf(specifier) - 1;
    const end = start + specifier.length + 2;
    return {
      original_start: Buffer.byteLength(code.slice(0, start)),
      original_end: Buffer.byteLength(code.slice(0, end)),
      generated_start: Buffer.byteLength(code.slice(0, start)),
      generated_end: Buffer.byteLength(code.slice(0, end)),
      specifier,
      module_type: "javascript",
    };
  };
  const compiler = {
    compile_json(source, sourceKind, abiIdentifier) {
      calls.push({ abiIdentifier, source, sourceKind });
      return JSON.stringify(compilerSuccess(source, {
        code,
        module_specifiers: [literal("./first.js"), literal("./second.js")],
      }));
    },
  };
  const graphCalls = [];
  const graph = {
    identity(context) {
      graphCalls.push({ operation: "identity", context });
      return "graph-7";
    },
    rewrite(context) {
      graphCalls.push({ operation: "rewrite", context });
      return {
        controlled: true,
        graphIdentity: "graph-7",
        url: `/_zp/modules/${context.specifier.slice(2)}`,
      };
    },
  };
  const output = rewriteWorkerModule(
    "import value from './first.js'; export { value } from './second.js';",
    "https://target.test/worker.mjs",
    ABI,
    compiler,
    graph,
  );
  assert.deepEqual(calls, [{
    abiIdentifier: ABI,
    source: "import value from './first.js'; export { value } from './second.js';",
    sourceKind: "ModuleWorker",
  }]);
  assert.match(output, /from "\/_zp\/modules\/first\.js"/u);
  assert.match(output, /from "\/_zp\/modules\/second\.js"/u);
  assert.equal(graphCalls.filter((call) => call.operation === "rewrite").length, 2);
  assert.throws(
    () => rewriteWorkletModule("registerProcessor('x', class {})", "https://target.test/worklet.mjs", ABI, compiler, {
      identity() { return "worklet"; },
      rewrite() { return { controlled: true, graphIdentity: "other", url: "/_zp/worklet" }; },
    }),
    /Invalid controlled module route/u,
  );
});
