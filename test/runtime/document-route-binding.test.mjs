import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createBoundedRewriteCache } from "../../web/compiler-cache.mjs";

const root = path.resolve(import.meta.dirname, "../..");

function originStateRecord() {
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

async function loadAllocationSeam() {
  const source = (await readFile(path.join(root, "web/sw/sw.mjs"), "utf8")).replace(/^(?:import [^\n]*;\n)+/, "");
  const routes = [];
  const context = {
    DOMException,
    Headers,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    createBoundedRewriteCache,
    URLSearchParams,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    clearTimeout,
    crypto: globalThis.crypto,
    setTimeout,
    structuredClone,
    self: {
      addEventListener() {},
      clients: { claim: async () => {}, matchAll: async () => [] },
      location: { hostname: "o-origin-a.browse.test", origin: "https://o-origin-a.browse.test" },
    },
  };
  context.__routes = routes;
  context.globalThis = context;
  vm.runInNewContext(`${source}
    globalThis.__allocateDocumentRoute = async (payload) => {
      originState = Object.freeze(${JSON.stringify(originStateRecord())});
      policyReady = true;
      kernelReady = true;
      lifecycle = () => ({ snapshot: async () => ({ state: "READY_HOT" }) });
      rewriters = { policy: { route_path_result_json: (kind, id) => JSON.stringify({ ok: true, path: "/_zp/" + (kind === "api" ? "api" : "p/" + kind) + "/" + id }) } };
      request = async value => value;
      database = async () => ({ transaction: () => ({
        objectStore: () => ({
          add: value => globalThis.__routes.push(value),
          get: () => undefined,
        }),
      }) });
      complete = async () => {};
      return allocateRoute({ source: { id: "bootstrap-client" } }, payload, randomID());
    };`, context, { filename: "web/sw/sw.mjs" });
  return { allocate: context.__allocateDocumentRoute, routes };
}

function validPayload() {
  return {
    destination_origin_id: "origin-a",
    entry_id: "entry-a",
    profile_id: "profile-a",
    tab_id: "tab-a",
    target_url: "https://target.example/",
  };
}

test("document routes persist only the kernel-bound destination origin", async () => {
  const { allocate, routes } = await loadAllocationSeam();
  const result = await allocate(validPayload());
  assert.match(result.path, /^\/_zp\/p\/document\/[A-Za-z0-9_-]{32}$/);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].origin_id, "origin-a");
  assert.equal(routes[0].source_client_id, "bootstrap-client");
});

test("document route allocation rejects a mismatched destination origin", async () => {
  const { allocate, routes } = await loadAllocationSeam();
  await assert.rejects(
    () => allocate({ ...validPayload(), destination_origin_id: "origin-b" }),
    error => error.name === "InvalidStateError",
  );
  assert.equal(routes.length, 0);
});
