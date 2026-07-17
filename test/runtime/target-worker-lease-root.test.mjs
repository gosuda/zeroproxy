import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createBoundedRewriteCache } from "../../web/compiler-cache.mjs";
import { moduleImportRecordMatches, normalizeModuleImport } from "../../web/sw/target-worker/validation.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const gatewayID = "g".repeat(32);

function state() {
  return {
    capability_epoch: 7,
    destination_origin_id: "origin-a",
    entry_id: "entry-a",
    profile_id: "profile-a",
    isolation_username: "U".repeat(43),
    isolation_password: "P".repeat(43),
    relay_profile_digests: ["A".repeat(43)],
    relay_profiles: [{ relay_wss_origin: "wss://relay.example.test", carrier_path: "/_zp/carrier", expires_at: "2099-01-01T00:00:00Z", allowed_target_ports: [443] }],
    relay_capabilities: [{ capability_id: "capability-a", relay_profile_digest: "A".repeat(43), relay_url: "wss://relay.example.test/_zp/carrier", expires_at: "2099-01-01T00:00:00Z", allowed_target_ports: [443] }],
    tab_id: "tab-a",
    target_url: "https://target.example/",
  };
}

async function loadRelease() {
  const source = (await readFile(path.join(root, "web/sw/sw.mjs"), "utf8")).replace(/^(?:import [^\n]*;\n)+/, "");
  const routes = new Map();
  const context = {
    DOMException,
    Headers,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    createBoundedRewriteCache,
    decodeCompilerResult: JSON.parse,
    moduleImportRecordMatches,
    normalizeModuleImport,
    URL,
    URLSearchParams,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    crypto: globalThis.crypto,
    clearTimeout,
    setTimeout,
    structuredClone,
    __routes: routes,
    self: { addEventListener() {}, clients: { claim: async () => {}, matchAll: async () => [] }, location: { hostname: "o-origin-a.browse.test", origin: "https://o-origin-a.browse.test" } },
  };
  context.globalThis = context;
  vm.runInNewContext(`${source}
    globalThis.__releaseLease = async (gateway, current, clientID, payload) => {
      originState = current;
      authorizeDocumentClient = async id => {
        if (id !== clientID) throw new DOMException("Document capability rejected", "SecurityError");
        return { client_id: id };
      };
      database = async () => ({ transaction: () => ({
        abort() {},
        objectStore: () => ({
          get: id => globalThis.__routes.get(id) ?? null,
          put: value => { globalThis.__routes.set(value.id, value); return value; },
        }),
      }) });
      request = async value => value;
      complete = async () => {};
      if (!globalThis.__routes.has(gateway.id)) globalThis.__routes.set(gateway.id, gateway);
      return releaseTargetWorkerBootstrap({ source: { id: clientID } }, payload);
    };
    globalThis.__targetModuleImport = async ({ binding, current, graph, payload, record }) => {
      originState = current;
      targetWorkerBroker = {
        getRegistrations: async () => [{
          registration_id: binding.registration_id,
          versions: [{ graph, worker_version: binding.worker_version }],
        }],
      };
      database = async () => ({ transaction: () => ({
        objectStore: () => ({ get: id => id === record.id ? record : null }),
      }) });
      request = async value => value;
      complete = async () => {};
      readTargetWorkerExecutable = async () => ({ expires_at: Date.now() + 60_000 });
      let capturedRoute = null;
      fetchDynamicWorkerModuleRoot = async (route, targetURL) => {
        capturedRoute = structuredClone(route);
        return { module_type: "javascript", source: "export default true", target_url: targetURL };
      };
      createTargetServiceWorkerModuleRoutes = async (_route, _source, _targetURL, graphID) => ({
        url: "/_zp/wm/" + graphID + "/dynamic.mjs",
      });
      const result = await targetWorkerModuleImport(binding, payload);
      return { result, route: capturedRoute };
    };
    globalThis.__classicResources = async ({ compiled, forceBypass, responses, updateViaCache }) => {
      originState = { target_url: "https://target.example/app/page" };
      const routes = [];
      const importsBySource = new Map(
        Object.values(responses).map(response => [response.source, response.imports ?? []]),
      );
      rewriters = { compiler: {
        compile_json(source) {
          return JSON.stringify({
            code: source,
            module_specifiers: (importsBySource.get(source) ?? []).map(specifier => ({ specifier })),
            ok: true,
          });
        },
      } };
      fetchTargetServiceWorkerScript = async route => {
        routes.push(structuredClone(route));
        const response = responses[route.target_url];
        if (!response) throw new DOMException("missing fixture", "NetworkError");
        return {
          result: { body: response.source, headers: [], status: response.status ?? 200 },
          route: { ...route, target_url: response.final_url ?? route.target_url },
        };
      };
      materializeKernelResult = async result => result;
      workerJavaScriptSource = (_route, result) => result.body;
      const graph = await targetServiceWorkerClassicUpdateResources({
        abiIdentifier: "__zp_abi_" + "a".repeat(48),
        compiled,
        forceBypass,
        rootResource: {
          hash: "root-hash",
          module_type: "javascript",
          role: "root",
          url: "https://target.example/app/sw.js",
        },
        rootRoute: {
          cache: "no-cache",
          target_url: "https://target.example/app/sw.js",
        },
        updateViaCache,
      });
      return { imports: graph.imports, resources: graph.resources, routes };
    };
    globalThis.__certifiedMaterialize = async ({ cached = true, tamper = false } = {}) => {
      const requestURL = "https://target.example/app/imported.js";
      const source = "self.certified = true";
      const compiledHash = await targetServiceWorkerDigest(source);
      const certificate = {
        compiled_hash: compiledHash,
        final_url: requestURL,
        request_url: requestURL,
        source_hash: "b".repeat(64),
      };
      const gateway = {
        certified_imports: [certificate],
        source_kind: "TargetServiceWorkerClassic",
      };
      const record = {
        ...certificate,
        source: tamper ? source + ";" : source,
        target_url: requestURL,
      };
      let networkStarted = false;
      openWorkerGateway = async () => ({
        gateway,
        resolution_id: "resolution",
        target: new URL(requestURL),
      });
      readWorkerGatewayResolution = async () => cached ? record : null;
      warmRewriters = async () => { networkStarted = true; };
      warmKernel = async () => { networkStarted = true; };
      try {
        const result = await materializeWorkerGateway("gateway", "token", false, "client");
        return { name: null, networkStarted, source: result.source };
      } catch (error) {
        return { name: error.name, networkStarted, source: null };
      }
    };
    globalThis.__updateTrigger = async ({ due, kind }) => {
      originState = { target_url: "https://target.example/app/page" };
      const registration = {
        active_version: "v1",
        installing_version: null,
        registration_id: "registration",
        scope_url: "https://target.example/app/",
        script_url: "https://target.example/sw.js",
        type: "classic",
        update_via_cache: "imports",
        versions: [{
          script_url: "https://target.example/sw.js",
          state: "ACTIVE",
          state_revision: 1,
          worker_version: "v1",
        }],
        waiting_version: null,
      };
      const calls = [];
      targetWorkerExecutionHost = {};
      targetWorkerBroker = {
        getRegistration: async () => registration,
        getRegistrations: async () => [registration],
        shouldSoftUpdate: async () => due,
      };
      runTargetServiceWorkerUpdate = async (_registration, _clientID, _operationID, options) => {
        calls.push(structuredClone(options));
        return { updated: true };
      };
      if (kind === "register") {
        await targetServiceWorkerRegister({
          operation_id: "operation-register",
          scope_url: registration.scope_url,
          script_url: registration.script_url,
        }, "client");
      } else {
        await targetServiceWorkerSoftUpdate("https://target.example/app/page", "client");
      }
      return calls;
    };
    globalThis.__coalesceUpdate = coalesceTargetServiceWorkerUpdate;
    `, context, { filename: "web/sw/sw.mjs" });
  return { certifiedMaterialize: context.__certifiedMaterialize, classicResources: context.__classicResources, coalesceUpdate: context.__coalesceUpdate, importModule: context.__targetModuleImport, release: context.__releaseLease, routes, updateTrigger: context.__updateTrigger };
}
test("production target worker update jobs coalesce until the shared result settles", async () => {
  const { coalesceUpdate } = await loadRelease();
  let release;
  let runs = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const first = coalesceUpdate("registration:a", () => {
    runs += 1;
    return pending;
  });
  const second = coalesceUpdate("registration:a", () => {
    runs += 1;
    return Promise.resolve("unexpected");
  });
  assert.equal(first, second);
  assert.equal(runs, 1);
  release("updated");
  assert.equal(await second, "updated");
  await Promise.resolve();
  assert.equal(await coalesceUpdate("registration:a", () => {
    runs += 1;
    return Promise.resolve("next");
  }), "next");
  assert.equal(runs, 2);
});


test("existing register always updates while event soft updates wait for the certified interval", async () => {
  const { updateTrigger } = await loadRelease();
  assert.deepEqual(JSON.parse(JSON.stringify(await updateTrigger({ due: false, kind: "register" }))), [{
    forceBypass: false,
    scriptURL: "https://target.example/sw.js",
    type: "classic",
    updateViaCache: "imports",
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(await updateTrigger({ due: false, kind: "soft" }))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(await updateTrigger({ due: true, kind: "soft" }))), [{
    forceBypass: true,
  }]);
});

test("production target importScripts serves only certified prefetched bytes", async () => {
  const { certifiedMaterialize } = await loadRelease();
  assert.deepEqual(JSON.parse(JSON.stringify(await certifiedMaterialize())), {
    name: null,
    networkStarted: false,
    source: "self.certified = true",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await certifiedMaterialize({ cached: false }))), {
    name: "SecurityError",
    networkStarted: false,
    source: null,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await certifiedMaterialize({ tamper: true }))), {
    name: "SecurityError",
    networkStarted: false,
    source: null,
  });
});

test("production classic update graph follows redirects and hashes recursive importScripts", async () => {
  const { classicResources } = await loadRelease();
  const result = JSON.parse(JSON.stringify(await classicResources({
    compiled: { code: "importScripts('./first.js')", module_specifiers: [{ specifier: "./first.js" }] },
    forceBypass: false,
    responses: {
      "https://target.example/app/first.js": {
        final_url: "https://target.example/lib/first.js",
        imports: ["./nested.js"],
        source: "importScripts('./nested.js')",
      },
      "https://target.example/app/nested.js": {
        source: "self.nested = true",
      },
    },
    updateViaCache: "imports",
  })));
  assert.deepEqual(
    result.resources.map(resource => ({ role: resource.role, url: resource.url })),
    [
      { role: "root", url: "https://target.example/app/sw.js" },
      { role: "import", url: "https://target.example/lib/first.js" },
      { role: "import", url: "https://target.example/app/nested.js" },
    ],
  );
  assert.equal(result.resources.every(resource => typeof resource.hash === "string" && resource.hash.length > 0), true);
  assert.deepEqual(result.routes.map(route => ({ cache: route.cache, target_url: route.target_url })), [
    { cache: "default", target_url: "https://target.example/app/first.js" },
    { cache: "default", target_url: "https://target.example/app/nested.js" },
  ]);
  assert.deepEqual(
    result.imports.map(imported => ({ final_url: imported.final_url, request_url: imported.request_url, source: imported.source })),
    [
      {
        final_url: "https://target.example/lib/first.js",
        request_url: "https://target.example/app/first.js",
        source: "importScripts('./nested.js')",
      },
      {
        final_url: "https://target.example/app/nested.js",
        request_url: "https://target.example/app/nested.js",
        source: "self.nested = true",
      },
    ],
  );
  const bypassed = JSON.parse(JSON.stringify(await classicResources({
    compiled: { code: "importScripts('./first.js')", module_specifiers: [{ specifier: "./first.js" }] },
    forceBypass: true,
    responses: {
      "https://target.example/app/first.js": { source: "self.loaded = true" },
    },
    updateViaCache: "all",
  })));
  assert.equal(bypassed.routes[0].cache, "no-cache");
});

test("production worker lease release invalidates the generation and rejects replay", async () => {
  const { release, routes } = await loadRelease();
  const gateway = {
    abi_identifier: `__zp_abi_${"a".repeat(48)}`,
    capability_epoch: 7,
    entry_id: "entry-a",
    expires_at: Date.now() + 60_000,
    id: gatewayID,
    kind: "worker-gateway",
    lease_active: true,
    lease_generation: 4,
    origin_id: "origin-a",
    profile_id: "profile-a",
    source_client_id: "client-a",
    tab_id: "tab-a",
  };
  assert.equal((await release(gateway, state(), "client-a", { gateway_id: gatewayID, lease_generation: 4 })).released, true);
  assert.equal(routes.get(gatewayID).lease_active, false);
  assert.equal(routes.get(gatewayID).lease_generation, 5);
  await assert.rejects(() => release(gateway, state(), "client-a", { gateway_id: gatewayID, lease_generation: 4 }), error => error.name === "SecurityError");
});

test("production target worker computed imports require the persisted calling module ID", async () => {
  const { importModule } = await loadRelease();
  const current = state();
  const moduleID = "4".repeat(64);
  const graphID = "m".repeat(32);
  const abiIdentifier = `__zp_abi_${"a".repeat(48)}`;
  const binding = {
    capability: "target-worker-capability",
    client_epoch: 3,
    profile_id: current.profile_id,
    registration_id: "registration-a",
    synthetic_origin: "https://o-origin-a.browse.test",
    worker_version: "worker-version-a",
  };
  const graph = {
    abi_identifier: abiIdentifier,
    graph_hash: "b".repeat(64),
    module_graph_id: graphID,
    module_referrer: current.target_url,
    type: "module",
  };
  const payload = {
    module_id: moduleID,
    referrer_url: "https://target.example/sw.mjs",
    specifier: "./dependency.mjs",
  };
  const record = {
    abi_identifier: abiIdentifier,
    capability: binding.capability,
    client_epoch: binding.client_epoch,
    entry_id: current.entry_id,
    expires_at: Date.now() + 60_000,
    graph_id: graphID,
    id: `${graphID}:${moduleID}`,
    kind: "target-worker-module",
    module_id: moduleID,
    module_type: "javascript",
    origin_id: current.destination_origin_id,
    profile_id: current.profile_id,
    source: "export default true",
    source_kind: "TargetServiceWorkerModule",
    tab_id: current.tab_id,
    target_url: payload.referrer_url,
  };
  const allocation = await importModule({ binding, current, graph, payload, record });
  assert.equal(allocation.result.url, `/_zp/wm/${graphID}/dynamic.mjs`);
  assert.equal(allocation.result.target_url, "https://target.example/dependency.mjs");
  assert.equal(allocation.route.source_url, payload.referrer_url);
  await assert.rejects(
    () => importModule({
      binding,
      current,
      graph,
      payload: { ...payload, module_id: "5".repeat(64) },
      record,
    }),
    error => error.name === "SecurityError",
  );
  await assert.rejects(
    () => importModule({
      binding,
      current,
      graph,
      payload: { ...payload, referrer_url: "https://target.example/forged.mjs" },
      record,
    }),
    error => error.name === "SecurityError",
  );
});
