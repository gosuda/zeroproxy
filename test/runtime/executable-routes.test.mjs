import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import {
  createContentAddressedModuleGraph,
  createExecutableRouteRewriter,
  createOrderedClassicImportScriptsRoute,
  createTargetServiceWorkerModuleWrapper,
  createWorkletModuleWrapper,
  workerBootstrapFactories,
  workerBootstrapSource,
} from "../../web/sw/executable-routes.mjs";
import { WorkerSourceKind } from "../../web/worker/source-kinds.mjs";

const ABI = "__zp_abi_222222222222222222222222222222222222222222222222";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compilerResult(source, sourceKind, abiIdentifier) {
  const code = source
    .replace(/\bimport\.meta\b/gu, `${abiIdentifier}.importMeta`)
    .replace(/\bimport\s*\(\s*(?!["'])/gu, `${abiIdentifier}.importModule(`);
  const specifiers = [];
  const expression = /(?:from\s*|import\s+|import\s*\(\s*)(["'])([^"']+)\1/gu;
  for (const match of code.matchAll(expression)) {
    const literalStart = match.index + match[0].indexOf(match[1]);
    const literalEnd = literalStart + match[1].length + match[2].length + match[1].length;
    specifiers.push({
      original_start: Buffer.byteLength(source.slice(0, Math.min(literalStart, source.length))),
      original_end: Buffer.byteLength(source.slice(0, Math.min(literalEnd, source.length))),
      generated_start: Buffer.byteLength(code.slice(0, literalStart)),
      generated_end: Buffer.byteLength(code.slice(0, literalEnd)),
      specifier: match[2],
      module_type: /\b(?:with|assert)\s*\{\s*type\s*:\s*['"]json['"]/u.test(
        code.slice(literalEnd, literalEnd + 96),
      ) ? "json" : "javascript",
    });
  }
  return JSON.stringify({
    schema_version: 1,
    ok: true,
    code,
    edits: [],
    edit_map: [],
    source_map: {
      version: 3,
      file: `authored-${sourceKind}.js`,
      sources: [`authored-${sourceKind}.js`],
      sourcesContent: [source],
      names: [],
      mappings: "",
    },
    module_specifiers: specifiers,
    source_url: `authored-${sourceKind}.js`,
    source_mapping_url: null,
    diagnostics: [],
  });
}

const compiler = {
  compile_json(source, sourceKind, abiIdentifier) {
    assert.equal(abiIdentifier, ABI);
    return compilerResult(source, sourceKind, abiIdentifier);
  },
  compile_template_json(source, sourceKind) {
    const result = JSON.parse(compilerResult(source, sourceKind, "__zp_abi_000000000000000000000000000000000000000000000000"));
    result.abi_identifiers = [];
    result.abi_slots = [];
    return JSON.stringify(result);
  },
  source_map_base64() { return "Y29udHJvbGxlZA=="; },
};

const requestContext = Object.freeze({
  cache: "no-store",
  credentials: "omit",
  integrity: "sha256-control",
  mode: "cors",
  referrer: "https://target.example/app/index.html",
});

async function createTemporaryModuleSet() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "zeroproxy-executable-routes-")));
  return Object.freeze({
    cleanup() {
      return rm(directory, { force: true, recursive: true });
    },
    url(name) {
      return pathToFileURL(join(directory, name)).href;
    },
    write(name, source) {
      return writeFile(join(directory, name), source, "utf8");
    },
  });
}

test("module routes compile static imports into canonical content-addressed routes", async () => {
  const sources = new Map([
    ["https://target.example/app/first.mjs", "export const first = 1;"],
    ["https://target.example/app/second.mjs", "export const second = 2;"],
  ]);
  const loads = [];
  const graph = createContentAddressedModuleGraph({
    policyVersion: 2,
    abiIdentifier: ABI,
    compiler,
    digest,
    graphID: "graph-1",
    load(request) {
      loads.push(request);
      return { source: sources.get(request.target_url), target_url: request.target_url };
    },
    moduleRoute: (_graphID, contentID) => `/_zp/module/${contentID}.mjs`,
    requestContext,
  });
  const router = createExecutableRouteRewriter({ abiIdentifier: ABI, compiler, moduleGraph: graph });
  const root = "import { first } from './first.mjs'; export { second } from './second.mjs';";
  const rewritten = await router.rewrite({
    source: root,
    sourceKind: "ModuleScript",
    targetURL: "https://target.example/app/root.mjs",
  });

  const rootEntries = await graph.allSources();
  const firstEntry = rootEntries.find(
    entry => entry.target_url === "https://target.example/app/first.mjs",
  );
  const secondEntry = rootEntries.find(
    entry => entry.target_url === "https://target.example/app/second.mjs",
  );
  assert.equal(rewritten.module_route.controlled, true);
  assert.match(rewritten.source, new RegExp(`/_zp/module/${firstEntry.module_id}\\.mjs`, "u"));
  assert.match(rewritten.source, new RegExp(`/_zp/module/${secondEntry.module_id}\\.mjs`, "u"));
  assert.deepEqual(new Set(loads.map(request => request.target_url)), new Set(sources.keys()));
  assert.match(rewritten.source, /sourceURL=authored-ModuleScript\.js/u);
  assert.deepEqual(new Set(loads.map(request => request.target_url)), new Set(sources.keys()));
  assert.ok(loads.every(request => request.request_context === graph.context));
  assert.ok(loads.every(request => request.request_context.integrity === requestContext.integrity));

  const rootEntry = await graph.sourceFor(rewritten.module_route.module_id);
  assert.equal(rootEntry.source, rewritten.source);
  assert.equal(rootEntry.request_context.credentials, "omit");
  assert.equal(rootEntries.length, 3);
  const worklet = await router.rewrite({
    source: "import './first.mjs';",
    sourceKind: WorkerSourceKind.workletModule,
    targetURL: "https://target.example/app/worklet.mjs",
  });
  const workletEntries = await graph.allSources();
  const workletDependency = workletEntries.find(
    entry => entry.target_url === "https://target.example/app/first.mjs"
      && entry.source_kind === WorkerSourceKind.workletModule,
  );
  assert.notEqual(workletDependency.module_id, firstEntry.module_id);
  assert.match(worklet.source, new RegExp(`/_zp/module/${workletDependency.module_id}\\.mjs`, "u"));
  assert.match(worklet.source, /sourceURL=authored-WorkletModule\.js/u);
});

test("module identity binds URL type fetch context and policy independently of content", async () => {
  const sharedSource = "export const shared = true;";
  const jsonSource = "{\"value\":7}";
  const loads = [];
  const graph = createContentAddressedModuleGraph({
    policyVersion: 2,
    abiIdentifier: ABI,
    compiler,
    digest,
    graphID: "identity-graph",
    load(request) {
      loads.push(request);
      return {
        module_type: request.module_type,
        source: request.module_type === "json" ? jsonSource : sharedSource,
        target_url: request.target_url,
      };
    },
    moduleRoute: (graphID, moduleID) => `/_zp/module/${graphID}/${moduleID}.mjs`,
    requestContext,
  });
  const rootSource = [
    "import './same-a.mjs';",
    "import './same-b.mjs';",
    "import config from './config.json' with { type: 'json' };",
    "export { config };",
  ].join("");
  const first = await graph.rewriteRoot(
    rootSource,
    "https://target.example/app/root.mjs",
    "ModuleScript",
  );
  const entries = await graph.allSources();
  const sameA = entries.find(entry => entry.target_url.endsWith("/same-a.mjs"));
  const sameB = entries.find(entry => entry.target_url.endsWith("/same-b.mjs"));
  const json = entries.find(entry => entry.module_type === "json");
  assert.equal(sameA.content_id, sameB.content_id);
  assert.notEqual(sameA.module_id, sameB.module_id);
  assert.equal(json.content_id, digest(new TextEncoder().encode(jsonSource)));
  assert.equal((await graph.sourceFor(json.module_id)).source, jsonSource);
  assert.match(first.source, new RegExp(`${json.module_id}\\.mjs['"] with \\{ type: 'json' \\}`, "u"));
  assert.ok(loads.every(request => request.request_context === graph.context));
  assert.equal(loads.find(request => request.target_url.endsWith("config.json")).module_type, "json");
  const repeated = await graph.rewriteRoot(
    rootSource,
    "https://target.example/app/root.mjs",
    "ModuleScript",
  );
  assert.equal(repeated.route.url, first.route.url);
  assert.equal((await graph.allSources()).length, entries.length);
  assert.equal(loads.length, 3);
  const fragmentOne = await graph.rewriteRoot(
    "export const fragment = true;",
    "https://target.example/app/fragment.mjs#one",
    "ModuleScript",
  );
  const fragmentTwo = await graph.rewriteRoot(
    "export const fragment = true;",
    "https://target.example/app/fragment.mjs#two",
    "ModuleScript",
  );
  assert.notEqual(fragmentOne.route.module_id, fragmentTwo.route.module_id);
  assert.match(fragmentOne.source, /fragment\.mjs#one/u);
  assert.match(fragmentTwo.source, /fragment\.mjs#two/u);

  const policyGraph = createContentAddressedModuleGraph({
    policyVersion: 3,
    abiIdentifier: ABI,
    compiler,
    digest,
    graphID: "identity-graph",
    load() {
      throw new Error("unexpected dependency");
    },
    moduleRoute: (graphID, moduleID) => `/_zp/module/${graphID}/${moduleID}.mjs`,
    requestContext,
  });
  const policyRoot = await policyGraph.rewriteRoot(
    "export const root = true;",
    "https://target.example/app/policy-root.mjs",
    "ModuleScript",
  );
  const currentPolicyRoot = await graph.rewriteRoot(
    "export const root = true;",
    "https://target.example/app/policy-root.mjs",
    "ModuleScript",
  );
  assert.notEqual(policyRoot.route.module_id, currentPolicyRoot.route.module_id);
  const serviceWorkerRoot = await graph.rewriteRoot(
    "export const serviceWorker = true;",
    "https://target.example/sw.mjs",
    "TargetServiceWorkerModule",
  );
  assert.match(serviceWorkerRoot.source, /sourceURL=authored-TargetServiceWorkerModule\.js/u);
});

test("document module routes bind native import.meta to one target-visible module ABI", async () => {
  const targetURL = "https://target.example/app/routed-root.mjs";
  const graph = createContentAddressedModuleGraph({
    policyVersion: 2,
    abiIdentifier: ABI,
    compiler,
    digest,
    graphID: "module-context-graph",
    load() {
      throw new Error("unexpected dependency");
    },
    moduleRoute: (_graphID, contentID) => `/_zp/document-module/${contentID}.mjs`,
    requestContext,
  });
  const rewritten = await graph.rewriteRoot(
    "globalThis.__zpDocumentModuleContextProbe=import.meta.url;export default 1",
    targetURL,
    "ModuleScript",
  );
  const calls = [];
  const abi = Object.freeze({
    moduleContext(nativeMeta, originalURL) {
      calls.push({ nativeURL: nativeMeta.url, originalURL });
      return Object.freeze({ importMeta: Object.freeze({ url: originalURL }) });
    },
  });
  Object.defineProperty(globalThis, ABI, {
    configurable: true,
    enumerable: false,
    value: abi,
    writable: false,
  });
  const modules = await createTemporaryModuleSet();
  try {
    await modules.write("document-root.mjs", rewritten.source);
    await import(modules.url("document-root.mjs"));
    assert.equal(globalThis.__zpDocumentModuleContextProbe, targetURL);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].originalURL, targetURL);
    assert.equal(calls[0].nativeURL, modules.url("document-root.mjs"));
  } finally {
    delete globalThis.__zpDocumentModuleContextProbe;
    delete globalThis[ABI];
    await modules.cleanup();
  }
});

test("worklet wrapper hardens eval and installs one frozen ABI before routed module execution", async () => {
  const workletABI = "__zp_abi_333333333333333333333333333333333333333333333333";
  const targetURL = "https://target.example/app/worklet-root.mjs";
  const moduleID = "3".repeat(64);
  const rootSource = `const ${workletABI}=globalThis[${JSON.stringify(workletABI)}].moduleContext(import.meta,${JSON.stringify(targetURL)},${JSON.stringify(moduleID)});globalThis.__zpWorkletModuleProbe={context:${workletABI},resolvedURL:${workletABI}.importMeta.resolve("./dependency.mjs"),targetURL:${workletABI}.importMeta.url};export default true;`;
  const modules = await createTemporaryModuleSet();
  await modules.write("worklet-root.mjs", rootSource);
  const rootURL = modules.url("worklet-root.mjs");
  const wrapper = createWorkletModuleWrapper(workletABI, rootURL);
  await modules.write("worklet-wrapper.mjs", wrapper);
  const wrapperURL = modules.url("worklet-wrapper.mjs");
  const workerSource = `
    const { parentPort } = require("node:worker_threads");
    globalThis.registerProcessor = () => {};
    (async () => {
      const intrinsicEval = globalThis.eval;
      await import(${JSON.stringify(wrapperURL)});
      const abi = globalThis[${JSON.stringify(workletABI)}];
      const context = globalThis.__zpWorkletModuleProbe.context;
      const abiDescriptor = Object.getOwnPropertyDescriptor(globalThis, ${JSON.stringify(workletABI)});
      const rawEvalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "eval");
      const scopeEvalDescriptor = Object.getOwnPropertyDescriptor(context.scope, "eval");
      let coerced = false;
      const importPromise = context.importModule({
        toString() {
          coerced = true;
          return "./blocked.mjs";
        },
      });
      const coercedBefore = coerced;
      let importError = null;
      try {
        await importPromise;
      } catch (error) {
        importError = error.name;
      }
      let attackerCalled = false;
      const attacker = () => { attackerCalled = true; };
      parentPort.postMessage({
        abiAttributes: [abiDescriptor.configurable, abiDescriptor.enumerable, abiDescriptor.writable],
        abiFrozen: Object.isFrozen(abiDescriptor.value),
        attackerCalled,
        coercedAfter: coerced,
        coercedBefore,
        contextFrozen: Object.isFrozen(context),
        evalAttributes: [rawEvalDescriptor.configurable, rawEvalDescriptor.enumerable, rawEvalDescriptor.writable],
        facadeEvalAttributes: [scopeEvalDescriptor.configurable, scopeEvalDescriptor.enumerable, scopeEvalDescriptor.writable],
        facadeEvalValue: scopeEvalDescriptor.value === context.scope.eval,
        health: abi.runtimeHealth(),
        importError,
        rawDelete: Reflect.deleteProperty(globalThis, "eval"),
        rawEvalValue: rawEvalDescriptor.value === intrinsicEval,
        rawSet: Reflect.set(globalThis, "eval", attacker),
        scopeDelete: Reflect.deleteProperty(context.scope, "eval"),
        scopeSet: Reflect.set(context.scope, "eval", attacker),
        resolvedURL: globalThis.__zpWorkletModuleProbe.resolvedURL,
        targetURL: globalThis.__zpWorkletModuleProbe.targetURL,
      });
    })().catch(error => parentPort.postMessage({ error: String(error), stack: error?.stack }));
  `;
  const worker = new Worker(workerSource, { eval: true });
  try {
    const state = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    assert.equal(state.error, undefined, state.stack ?? state.error);
    assert.deepEqual(state, {
      abiAttributes: [false, false, false],
      abiFrozen: true,
      attackerCalled: false,
      coercedAfter: true,
      coercedBefore: false,
      contextFrozen: true,
      evalAttributes: [false, false, false],
      facadeEvalAttributes: [false, false, false],
      facadeEvalValue: true,
      health: true,
      importError: "SecurityError",
      rawDelete: false,
      rawEvalValue: true,
      rawSet: false,
      scopeDelete: false,
      scopeSet: false,
      resolvedURL: "https://target.example/app/dependency.mjs",
      targetURL,
    });
  } finally {
    await worker.terminate();
    await modules.cleanup();
  }
});

test("target service worker module wrapper installs a stable target-visible ABI and mediates computed imports asynchronously", async () => {
  const serviceABI = "__zp_abi_444444444444444444444444444444444444444444444444";
  const targetURL = "https://target.example/sw.mjs";
  const moduleID = "4".repeat(64);
  const mismatchedModuleID = "5".repeat(64);
  const modules = await createTemporaryModuleSet();
  await modules.write("dependency.mjs", "export default 7;");
  const dependencyURL = modules.url("dependency.mjs");
  const rootSource = `
    const context=globalThis[${JSON.stringify(serviceABI)}].moduleContext(import.meta,${JSON.stringify(targetURL)},${JSON.stringify(moduleID)});
    const repeated=globalThis[${JSON.stringify(serviceABI)}].moduleContext(import.meta,${JSON.stringify(targetURL)},${JSON.stringify(moduleID)});
    let identityMismatch;
    try{globalThis[${JSON.stringify(serviceABI)}].moduleContext(import.meta,${JSON.stringify(targetURL)},${JSON.stringify(mismatchedModuleID)})}catch(error){identityMismatch=error.name}
    const dependency=await context.importModule({toString(){globalThis.__zpTargetModuleCoercion=globalThis.__zpTargetModuleSynchronous?\"sync\":\"async\";return \"./dependency.mjs\"}});
    globalThis.__zpTargetModuleProbe=Object.freeze({
      contextFrozen:Object.isFrozen(context),
      contextStable:context===repeated,
      dependency:dependency.default,
      identityMismatch,
      metaStable:context.importMeta===repeated.importMeta,
      resolved:context.importMeta.resolve(\"./dependency.mjs\"),
      url:context.importMeta.url,
    });
  `;
  await modules.write("target-root.mjs", rootSource);
  const rootURL = modules.url("target-root.mjs");
  const wrapper = createTargetServiceWorkerModuleWrapper(serviceABI, rootURL);
  await modules.write("target-wrapper.mjs", wrapper);
  const wrapperURL = modules.url("target-wrapper.mjs");
  const calls = [];
  const scope = Object.freeze({});
  const importModule = async (boundModuleID, referrerURL, specifier) => {
    calls.push({ moduleID: boundModuleID, referrerURL, specifier });
    return { url: dependencyURL };
  };
  try {
    globalThis.__zpTargetModuleSynchronous = true;
    const module = await import(wrapperURL);
    await assert.rejects(
      () => module.install(scope),
      error => error.name === "TypeError" && error.message === "Target worker module import capability unavailable",
    );
    const installing = module.install(scope, importModule);
    globalThis.__zpTargetModuleSynchronous = false;
    await installing;
    assert.equal(globalThis.__zpTargetModuleCoercion, "async");
    assert.deepEqual(calls, [{ moduleID, referrerURL: targetURL, specifier: "./dependency.mjs" }]);
    assert.equal("__zeroProxyImportModule" in scope, false);
    assert.deepEqual(globalThis.__zpTargetModuleProbe, {
      contextFrozen: true,
      contextStable: true,
      dependency: 7,
      identityMismatch: "SecurityError",
      metaStable: true,
      resolved: "https://target.example/dependency.mjs",
      url: targetURL,
    });
  } finally {
    delete globalThis.__zpTargetModuleCoercion;
    delete globalThis.__zpTargetModuleProbe;
    delete globalThis.__zpTargetModuleSynchronous;
    await modules.cleanup();
  }
});

test("module graph resolves bare specifiers before controlled-route allocation", async () => {
  const graph = createContentAddressedModuleGraph({
    policyVersion: 2,
    abiIdentifier: ABI,
    compiler,
    digest,
    graphID: "import-map-graph",
    load(request) {
      assert.equal(request.target_url, "https://target.example/vendor/pkg.mjs");
      return { source: "export default 1;", target_url: request.target_url };
    },
    moduleRoute: (_graphID, contentID) => `/_zp/module/${contentID}.mjs`,
    resolveSpecifier({ specifier, importer_url }) {
      assert.equal(specifier, "pkg");
      assert.equal(importer_url, "https://target.example/app/root.mjs");
      return "https://target.example/vendor/pkg.mjs";
    },
    requestContext,
  });
  const root = await graph.rewriteRoot(
    "import value from 'pkg'; export { value };",
    "https://target.example/app/root.mjs",
    "ModuleScript",
  );
  assert.match(root.source, /_zp\/module\/[a-f0-9]{64}\.mjs/u);
});

test("module graphs mediate dynamic imports per referrer and resolve static A→B→A cycles deterministically", async () => {
  const graph = createContentAddressedModuleGraph({
    policyVersion: 2,
    abiIdentifier: ABI,
    compiler,
    digest,
    graphID: "cycle-graph",
    load(request) {
      const sources = new Map([
        ["https://target.example/app/a.mjs", "import './b.mjs'; export const a = true;"],
        ["https://target.example/app/b.mjs", "import './a.mjs'; export const b = true;"],
        ["https://target.example/app/literal.mjs", "export default 'literal';"],
      ]);
      return { source: sources.get(request.target_url), target_url: request.target_url };
    },
    moduleRoute: (graphID, contentID) => `/_zp/wm/${graphID}/${contentID}.mjs`,
    requestContext,
  });
  const root = await graph.rewriteRoot("import './a.mjs'; export const root = true;", "https://target.example/app/root.mjs", WorkerSourceKind.workerModule);
  assert.match(root.source, /_zp\/wm\/cycle-graph\/[a-f0-9]{64}\.mjs/u);
  assert.equal((await graph.allSources()).length, 3);
  const dynamicSource = "const name='./runtime.mjs'; export const literal=import('./literal.mjs'); export const computed=import(name,{with:{type:'json'}});";
  const dynamic = await graph.rewriteRoot(dynamicSource, "https://target.example/app/dynamic-root.mjs", WorkerSourceKind.workerModule);
  assert.match(dynamic.source, new RegExp(`const ${ABI}=globalThis\\[\"${ABI}\"\\]\\.moduleContext\\(import\\.meta,\"https://target\\.example/app/dynamic-root\\.mjs\",\"[a-f0-9]{64}\"\\)`, "u"));
  assert.equal(dynamic.source.match(new RegExp(`${ABI}\\.importModule\\(`, "gu"))?.length, 1);
  const literalEntry = (await graph.allSources()).find(
    entry => entry.target_url === "https://target.example/app/literal.mjs",
  );
  assert.match(
    dynamic.source,
    new RegExp(`import\\(\"/_zp/wm/cycle-graph/${literalEntry.module_id}\\.mjs\"\\)`, "u"),
  );
  assert.equal((await graph.allSources()).length, 5, "only computed dependencies remain lazy");
  const nested = createContentAddressedModuleGraph({
    policyVersion: 2,
    abiIdentifier: ABI,
    compiler,
    digest,
    graphID: "depth-graph",
    limits: { maxDepth: 1 },
    load(request) {
      if (request.target_url.endsWith("/first.mjs")) return { source: "import './second.mjs';", target_url: request.target_url };
      return { source: "export const second = true;", target_url: request.target_url };
    },
    moduleRoute: (graphID, contentID) => `/_zp/wm/${graphID}/${contentID}.mjs`,
    requestContext,
  });
  await assert.rejects(
    nested.rewriteRoot("import './first.mjs';", "https://target.example/app/root.mjs", WorkerSourceKind.workerModule),
    error => error.name === "SecurityError" && error.message === "Module graph exceeds limits",
  );
});

test("blob and data module roots preserve target-visible referrers and mediate absolute dependencies", async () => {
  const dependencyURL = "https://target.example/modules/dependency.mjs";
  const dependencySource = "export const dependency = true;";
  const loads = [];
  const graph = createContentAddressedModuleGraph({
    policyVersion: 2,
    abiIdentifier: ABI,
    compiler,
    digest,
    graphID: "direct-root-graph",
    load(request) {
      loads.push(request);
      return { source: dependencySource, target_url: request.target_url };
    },
    moduleRoute: (graphID, contentID) => `/_zp/wm/${graphID}/${contentID}.mjs`,
    requestContext,
  });
  const blobURL = "blob:https://target.example/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const blob = await graph.rewriteRoot(
    `export const loaded=import(${JSON.stringify(dependencyURL)});`,
    blobURL,
    WorkerSourceKind.workerModule,
  );
  assert.match(blob.source, new RegExp(`moduleContext\\(import\\.meta,${JSON.stringify(blobURL)},\"[a-f0-9]{64}\"\\)`, "u"));
  assert.equal(loads[0].importer_url, blobURL);
  assert.equal(loads[0].target_url, dependencyURL);

  const dataURL = "data:text/javascript,export%20default%201";
  const data = await graph.rewriteRoot(
    "const specifier='https://target.example/modules/computed.mjs'; export const loaded=import(specifier);",
    dataURL,
    WorkerSourceKind.workerModule,
  );
  assert.match(data.source, new RegExp(`moduleContext\\(import\\.meta,${JSON.stringify(dataURL)},\"[a-f0-9]{64}\"\\)`, "u"));
  assert.match(data.source, new RegExp(`${ABI}\\.importModule\\(specifier\\)`, "u"));
  await assert.rejects(
    graph.rewriteRoot("import('./relative.mjs');", "data:text/javascript,relative", WorkerSourceKind.workerModule),
    error => error.name === "SecurityError" && error.message === "Invalid executable target URL",
  );
});

test("module graphs reject source and graph-count limit exhaustion before routes can escape containment", async () => {
  const graph = createContentAddressedModuleGraph({
    policyVersion: 2,
    abiIdentifier: ABI,
    compiler,
    digest,
    graphID: "bounded-graph",
    limits: {
      maxModules: 1,
      maxModuleBytes: 1_024,
      maxSourceBytes: 1_024,
      maxOutputBytes: 1_024,
    },
    load() {
      return { source: "export const dependency = true;", target_url: "https://target.example/app/dependency.mjs" };
    },
    moduleRoute: (graphID, contentID) => `/_zp/wm/${graphID}/${contentID}.mjs`,
    requestContext,
  });
  await assert.rejects(
    graph.rewriteRoot("import './dependency.mjs';", "https://target.example/app/root.mjs", "ModuleScript"),
    error => error.name === "SecurityError" && error.message === "Module graph exceeds limits",
  );

  const sourceLimited = createContentAddressedModuleGraph({
    policyVersion: 2,
    abiIdentifier: ABI,
    compiler,
    digest,
    graphID: "source-limited",
    limits: {
      maxModules: 2,
      maxModuleBytes: 8,
      maxSourceBytes: 8,
      maxOutputBytes: 1_024,
    },
    load() {
      throw new Error("Oversized root must fail before dependency loading");
    },
    moduleRoute: (graphID, contentID) => `/_zp/wm/${graphID}/${contentID}.mjs`,
    requestContext,
  });
  await assert.rejects(
    sourceLimited.rewriteRoot("export const oversized = true;", "https://target.example/app/root.mjs", "ModuleScript"),
    error => error.name === "SecurityError" && error.message === "Module graph exceeds limits",
  );
});

test("classic executable routes use typed compiler kinds and worker importScripts plans stay synchronous and ordered", async () => {
  const router = createExecutableRouteRewriter({ abiIdentifier: ABI, compiler });
  const classic = await router.rewrite({
    source: "window.answer = 42;",
    sourceKind: "ClassicScriptExternal",
    targetURL: "https://target.example/app.js",
  });
  assert.match(classic.source, /sourceURL=authored-ClassicScriptExternal\.js/u);
  assert.match(classic.source, /sourceMappingURL=data:application\/json;base64,Y29udHJvbGxlZA==/u);

  const worker = await router.rewrite({
    source: "self.answer = 42;",
    sourceKind: WorkerSourceKind.workerClassic,
    targetURL: "https://target.example/worker.js",
  });
  assert.equal(worker.source, "self.answer = 42;");

  const ordered = [];
  const classicRoute = createOrderedClassicImportScriptsRoute({
    requestContext,
    resolve(request) {
      ordered.push(request.target_url);
      return { controlled: true, url: `/_zp/classic/${ordered.length}` };
    },
  });
  const first = classicRoute({ rawURL: "first.js", sourceKind: WorkerSourceKind.workerClassic, targetURL: "https://target.example/workers/root.js" });
  const second = classicRoute({ rawURL: "second.js", sourceKind: WorkerSourceKind.workerClassic, targetURL: "https://target.example/workers/root.js" });
  assert.deepEqual(ordered, [
    "https://target.example/workers/first.js",
    "https://target.example/workers/second.js",
  ]);
  assert.deepEqual([first.url, second.url], ["/_zp/classic/1", "/_zp/classic/2"]);
  const asyncRoute = createOrderedClassicImportScriptsRoute({ requestContext, resolve: () => Promise.resolve({ controlled: true, url: "/_zp/late" }) });
  assert.throws(
    () => asyncRoute({ rawURL: "late.js", sourceKind: WorkerSourceKind.workerClassic, targetURL: "https://target.example/root.js" }),
    error => error.name === "SecurityError",
  );
});

test("worker bootstrap source selects the existing typed worker factories", () => {
  const classic = workerBootstrapSource({
    bootstrapModuleURL: "/_zp/assets/worker-bootstrap.mjs",
    sourceKind: WorkerSourceKind.sharedWorkerClassic,
  });
  const module = workerBootstrapSource({
    bootstrapModuleURL: "/_zp/assets/worker-bootstrap.mjs",
    sourceKind: WorkerSourceKind.workerModule,
  });
  assert.match(classic, /^void import\("\/_zp\/assets\/worker-bootstrap\.mjs#source_kind=SharedClassicWorker"\)/u);
  assert.equal(module, "import \"/_zp/assets/worker-bootstrap.mjs#source_kind=ModuleWorker\";");
  assert.equal(typeof workerBootstrapFactories[WorkerSourceKind.workerClassic], "function");
  assert.equal(typeof workerBootstrapFactories[WorkerSourceKind.workerModule], "function");
  assert.equal(typeof workerBootstrapFactories[WorkerSourceKind.sharedWorkerClassic], "function");
  assert.equal(typeof workerBootstrapFactories[WorkerSourceKind.sharedWorkerModule], "function");
  assert.equal(typeof workerBootstrapFactories[WorkerSourceKind.workletModule], "function");
});
