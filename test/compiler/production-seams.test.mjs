import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runtimeClassicSource } from "../../web/runtime/index.mjs";
import {
  createContentAddressedModuleGraph,
  createExecutableRouteRewriter,
} from "../../web/sw/executable-routes.mjs";
import { rewriteClassicScript } from "../../web/sw/script-rewrite.mjs";
import { WorkerSourceKind } from "../../web/worker/source-kinds.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DIST = path.join(ROOT, "dist");
const WEB_DIST = path.join(DIST, "web");
const ABI = "__zp_abi_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

async function loadRustBinding(name) {
  const directory = path.join(DIST, "bindings", name);
  const modulePath = path.join(directory, `${name}.js`);
  const wasmPath = path.join(directory, `${name}_bg.wasm`);
  const module = await import(`${pathToFileURL(modulePath).href}?production-seam=${name}`);
  module.initSync({ module: await readFile(wasmPath) });
  return module;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function moduleGraph(compiler, sourceKind) {
  const dependencyURL = "https://target.example/app/dependency.mjs";
  const sources = new Map([[dependencyURL, "export const dependency = globalThis;"]]);
  const graph = createContentAddressedModuleGraph({
    abiIdentifier: ABI,
    compiler,
    digest,
    graphID: `production-${sourceKind}`,
    load(request) {
      return {
        source: sources.get(request.target_url),
        target_url: request.target_url,
      };
    },
    moduleRoute: (graphID, contentID) => `/_zp/module/${graphID}/${contentID}.mjs`,
    policyVersion: 2,
    requestContext: Object.freeze({
      cache: "no-store",
      credentials: "same-origin",
      integrity: "",
      mode: "cors",
      referrer: "https://target.example/app/index.html",
    }),
  });
  return createExecutableRouteRewriter({ abiIdentifier: ABI, compiler, moduleGraph: graph });
}

test("shipped WASM drives static scripts, HTML delivery, and every module graph seam", async () => {
  const compiler = await loadRustBinding("js_compiler");
  const versions = JSON.parse(compiler.compiler_versions_json());
  assert.equal(versions.result_schema_version, 1);
  assert.equal(versions.abi_version, 1);
  assert.equal(versions.browser_versions.length, 2);
  assert.match(compiler.compiler_cache_key("window", JSON.stringify({ seam: "production" })), /^[a-f0-9]{64}$/u);
  const targetClassic = JSON.parse(compiler.compile_json(
    "importScripts('./first.js', './second.js'); self.importScripts('./third.js')",
    "TargetServiceWorkerClassic",
    ABI,
  ));
  assert.deepEqual(
    targetClassic.module_specifiers.map(specifier => specifier.specifier),
    ["./first.js", "./second.js", "./third.js"],
  );
  const dynamicTargetClassic = JSON.parse(compiler.compile_json(
    "const load = importScripts; load('./dynamic.js')",
    "TargetServiceWorkerClassic",
    ABI,
  ));
  assert.equal(dynamicTargetClassic.ok, false);
  assert.equal(dynamicTargetClassic.error.code, "UNSUPPORTED_IMPORT_SCRIPTS_SHAPE");

  const classic = rewriteClassicScript(
    "window.productionValue = fetch;",
    "https://target.example/app/classic.js",
    ABI,
    compiler,
  );
  assert.match(classic, new RegExp(`${ABI}\\.scope\\.window`, "u"));
  assert.match(classic, new RegExp(`${ABI}\\.scope\\.fetch`, "u"));
  assert.match(classic, /sourceMappingURL=data:application\/json;base64,/u);
  assert.doesNotMatch(classic, /window\.productionValue = fetch/u);

  for (const sourceKind of [
    "ModuleScript",
    "TargetServiceWorkerModule",
    WorkerSourceKind.workerModule,
    WorkerSourceKind.sharedWorkerModule,
    WorkerSourceKind.workletModule,
  ]) {
    const router = moduleGraph(compiler, sourceKind);
    const rewritten = await router.rewrite({
      source: "import { dependency } from './dependency.mjs'; globalThis.answer = dependency;",
      sourceKind,
      targetURL: "https://target.example/app/root.mjs",
    });
    assert.equal(rewritten.source_kind, sourceKind);
    assert.equal(rewritten.module_route.controlled, true);
    assert.match(rewritten.source, /\/_zp\/module\/production-/u);
    assert.match(rewritten.source, new RegExp(`${ABI}\\.scope\\.globalThis`, "u"));
    assert.doesNotMatch(rewritten.source, /["']\.\/dependency\.mjs["']/u);
  }

  const targetWorkerDynamic = await moduleGraph(compiler, "TargetServiceWorkerModule").rewrite({
    source: "const specifier='./lazy.mjs';export const load=()=>import(specifier);",
    sourceKind: "TargetServiceWorkerModule",
    targetURL: "https://target.example/sw.mjs",
  });
  assert.match(
    targetWorkerDynamic.source,
    new RegExp(`moduleContext\\(import\\.meta,"https://target\\.example/sw\\.mjs","[a-f0-9]{64}"\\)`, "u"),
  );
  assert.match(targetWorkerDynamic.source, new RegExp(`${ABI}\\.importModule\\(specifier\\)`, "u"));
  assert.doesNotMatch(targetWorkerDynamic.source, /import\(specifier\)/u);

  const htmlRewriter = await loadRustBinding("html_rewriter");
  const importMap = await loadRustBinding("import_map");
  const parserRecords = JSON.parse(htmlRewriter.extract_import_maps_json(
    "<script type='importmap'>{\"imports\":{\"before\":\"./before.mjs\"}}</script><base href='/assets/'><script type='importmap'></script><link rel='modulepreload' href='./entry.mjs'><script type='importmap'>{\"imports\":{\"late\":\"./late.mjs\"}}</script>",
    "https://target.example/app/index.html",
  ));
  assert.deepEqual(parserRecords, [
    {
      base_url: "https://target.example/app/index.html",
      module_graph_started: false,
      source: "{\"imports\":{\"before\":\"./before.mjs\"}}",
    },
    {
      base_url: "https://target.example/assets/",
      module_graph_started: false,
      source: "",
    },
    {
      base_url: "https://target.example/assets/",
      module_graph_started: true,
      source: "{\"imports\":{\"late\":\"./late.mjs\"}}",
    },
  ]);

  const basedRecords = JSON.parse(htmlRewriter.extract_import_maps_json(
    "<base href='/assets/'><script type='importmap'>{\"imports\":{\"pkg\":\"./pkg.mjs\"}}</script>",
    "https://target.example/app/index.html",
  ));
  const basedRegistration = JSON.parse(importMap.import_map_register_json(
    "",
    basedRecords[0].source,
    basedRecords[0].base_url,
    basedRecords[0].module_graph_started,
  ));
  assert.equal(basedRegistration.registered, true);
  assert.equal(
    JSON.parse(importMap.import_map_resolve_json(
      basedRegistration.handle,
      "pkg",
      "https://target.example/app/main.mjs",
    )).resolved_url,
    "https://target.example/assets/pkg.mjs",
  );
  const lateRecord = JSON.parse(htmlRewriter.extract_import_maps_json(
    "<script type='module' src='./entry.mjs'></script><script type='importmap'>{\"imports\":{\"pkg\":\"./late.mjs\"}}</script>",
    "https://target.example/app/index.html",
  ))[0];
  assert.equal(
    JSON.parse(importMap.import_map_register_json(
      "",
      lateRecord.source,
      lateRecord.base_url,
      lateRecord.module_graph_started,
    )).registered,
    false,
  );
  const routeCalls = [];
  const context = {
    approved_target_ports: [80, 443],
    document_charset: "utf-8",
    document_id: "document",
    effective_base_url: "https://target.example/app/index.html",
    policy_version: 2,
    profile_id: "profile",
    referrer_policy: "strict-origin-when-cross-origin",
    referrer_url: null,
    relay_profile: "relay",
    tab_id: "tab",
    target_csp: [],
    target_csp_report_only: [],
    target_url: "https://target.example/app/index.html",
    virtual_origin: "https://target.example:443",
    virtual_site: "https://target.example",
  };
  const output = htmlRewriter.rewrite_html(
    "<html><head><script src='./external.js'></script></head><body><script>window.inlineValue=fetch;</script><script type='module'>import value from './dependency.mjs';globalThis.moduleValue=value;</script></body></html>",
    JSON.stringify(context),
    "/_zp/runtime-prelude.js",
    "https://proxy.example/_zp/vbase/document/",
    ABI,
    "runtime-nonce",
    (url, kind, integrity, crossorigin, moduleType, moduleReferrer) => {
      routeCalls.push({ crossorigin, integrity, kind, moduleReferrer, moduleType, url });
      return `/_zp/production-route/${routeCalls.length}.mjs`;
    },
  );
  assert.match(output, /src="\/_zp\/production-route\/1\.mjs"/u);
  assert.match(output, new RegExp(`${ABI}\\.scope\\.window`, "u"));
  assert.match(output, new RegExp(`${ABI}\\.scope\\.fetch`, "u"));
  assert.match(output, /["']\/_zp\/production-route\/2\.mjs["']/u);
  assert.ok(routeCalls.some(call => call.kind === "Script"));
  assert.ok(routeCalls.some(call => call.kind === "Module" && call.moduleReferrer === "https://target.example/app/index.html"));
});

async function filesBelow(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(candidate));
    else if (entry.isFile() && /\.(?:js|mjs)$/u.test(entry.name)) result.push(candidate);
  }
  return result;
}

const FORBIDDEN_ARCHITECTURE = Object.freeze([
  ["generic compiler ABI helper", /\b__zp_(?:get|call|set|update|in|optional)\b/u],
  ["retired target-worker source kind", /["']Target(?:Worker|SharedWorker)(?:Classic|Module)["']|["']TargetWorkletModule["']/u],
  ["flow-insensitive alias lowering", /\b(?:evalAliases|flowInsensitive|flow_insensitive)\b/u],
  ["simple-expression Function fast path", /\b(?:isSimpleExpression|simpleExpression|simple_expression)\b/u],
  ["compiler output fallback to original source", /(?:compiled|result)\.code\s*(?:\?\?|\|\|)\s*(?:source|original)\b/u],
  ["exception fallback to original source", /catch\s*(?:\([^)]*\))?\s*\{[^}]{0,256}\breturn\s+(?:source|original)\b/su],
  ["parse retry", /parse_once\s*\([^;]{0,256}(?:or_else|unwrap_or_else)\s*\([^)]*parse_once/su],
]);

test("source and shipped artifacts reject retired compiler architectures", async () => {
  const manifest = JSON.parse(await readFile(path.join(WEB_DIST, "_zp/version.json"), "utf8"));
  const sourceFiles = [
    "crates/js-compiler/src/lib.rs",
    "web/runtime/compiler.mjs",
    "web/worker/common.mjs",
    "web/sw/executable-routes.mjs",
    "web/sw/script-rewrite.mjs",
    "web/sw/sw.mjs",
  ].map(file => path.join(ROOT, file));
  const builtDirectories = ["service-worker.mjs", "worker-bootstrap.mjs"]
    .map(selector => path.dirname(path.resolve(WEB_DIST, `.${manifest.selectors[selector]}`)));
  const builtFiles = [
    path.resolve(WEB_DIST, `.${manifest.selectors["runtime-prelude.js"]}`),
    ...await filesBelow(builtDirectories[0]),
    ...await filesBelow(builtDirectories[1]),
  ];
  for (const file of [...new Set([...sourceFiles, ...builtFiles])]) {
    const source = await readFile(file, "utf8");
    for (const [name, expression] of FORBIDDEN_ARCHITECTURE) {
      assert.doesNotMatch(source, expression, `${name} found in ${path.relative(ROOT, file)}`);
    }
  }
  for (const [name, expression] of FORBIDDEN_ARCHITECTURE) {
    assert.doesNotMatch(runtimeClassicSource(), expression, `${name} found in assembled runtime source`);
  }

  const compilerSource = await readFile(path.join(ROOT, "crates/js-compiler/src/lib.rs"), "utf8");
  const editKindBody = /pub enum EditKind \{(?<body>[^}]+)\}/u.exec(compilerSource)?.groups?.body;
  assert.ok(editKindBody, "EditKind enum is discoverable");
  const editKinds = [...editKindBody.matchAll(/^\s{4}(?<name>[A-Z][A-Za-z]+),$/gmu)]
    .map(match => match.groups.name);
  assert.deepEqual(editKinds, [
    "OwnedGlobalReference",
    "OwnedGlobalTarget",
    "OwnedGlobalShorthand",
    "ThisExpression",
    "DirectEvalArgument",
    "DynamicImport",
    "ImportMeta",
  ]);
});
