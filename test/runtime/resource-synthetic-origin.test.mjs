import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createBoundedRewriteCache } from "../../web/compiler-cache.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const sourceOrigin = "https://alpha.example:443";
const targetOrigin = "https://beta.example:443";
const sourceURL = "https://alpha.example/";
const targetURL = "https://beta.example/frame";
const sourceID = "a".repeat(32);
const targetID = "b".repeat(32);

function originStateRecord() {
  const relayProfileDigest = "A".repeat(43);
  return {
    capability_epoch: 1,
    destination_origin_id: sourceID,
    document_capability: "document-capability",
    entry_id: "entry",
    profile_id: "profile",
    relay_profile_digests: [relayProfileDigest],
    relay_profiles: [{
      allowed_target_ports: [443],
      carrier_path: "/_zp/carrier",
      expires_at: "2099-01-01T00:00:00Z",
      relay_wss_origin: "wss://relay.example.test",
    }],
    relay_capabilities: [{
      allowed_target_ports: [443],
      expires_at: "2099-01-01T00:00:00Z",
      relay_profile_digest: relayProfileDigest,
      relay_url: "wss://relay.example.test/_zp/carrier",
    }],
    session_id: "session",
    tab_id: "tab",
    target_url: sourceURL,
  };
}

async function loadResourceAllocationSeam() {
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
    URLSearchParams,
    createBoundedRewriteCache,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    clearTimeout,
    crypto: globalThis.crypto,
    setTimeout,
    structuredClone,
    POLICY_VERSION: 2,
    canonicalTarget: async value => Object.freeze({ canonicalOrigin: new URL(value).origin === "https://beta.example" ? targetOrigin : sourceOrigin }),
    self: {
      addEventListener() {},
      clients: { claim: async () => {}, matchAll: async () => [] },
      location: {
        hostname: `o-${sourceID}.browse.test`,
        origin: `https://o-${sourceID}.browse.test`,
        protocol: "https:",
      },
    },
  };
  context.__routes = routes;
  context.globalThis = context;
  vm.runInNewContext(`${source}
    globalThis.__allocateResourceRoute = async (mapping, targetURL = ${JSON.stringify(targetURL)}) => {
      originState = Object.freeze(${JSON.stringify(originStateRecord())});
      authorizeDocumentClient = async () => ({ abi_identifier: "__zp_abi_${"a".repeat(48)}", runtime_capability: "runtime-capability" });
      rewriters = { policy: { route_path_result_json: (kind, id) => JSON.stringify({ ok: true, path: "/_zp/" + (kind === "api" ? "api" : "p/" + kind) + "/" + id }) } };
      coordinatorCall = async () => mapping;
      database = async () => ({ transaction: () => ({
        objectStore: () => ({ add: value => globalThis.__routes.push(value) }),
      }) });
      complete = async () => {};
      return allocateResourceRoute({ source: { id: "bootstrap-client" } }, {
        resource_kind: "Frame",
        target_url: targetURL,
      });
    };`, context, { filename: "web/sw/sw.mjs" });
  return { allocate: context.__allocateResourceRoute, routes };
}

test("cross-origin resource routes require an exactly matching canonical coordinator origin", async () => {
  const { allocate } = await loadResourceAllocationSeam();

  const route = await allocate({ canonical_origin: targetOrigin, origin_id: targetID });
  assert.match(route.path, /^\/_zp\/p\/navigation\/[A-Za-z0-9_-]{32}$/u);
  assert.equal(route.synthetic_origin, `https://o-${targetID}.browse.test`);
  assert.equal(route.target_url, targetURL);
  assert.equal(route.virtual_origin, "https://beta.example");

  await assert.rejects(
    () => allocate({ origin_id: targetID }),
    error => error.name === "SecurityError",
  );
  await assert.rejects(
    () => allocate({ canonical_origin: sourceOrigin, origin_id: targetID }),
    error => error.name === "SecurityError",
  );

  const sameOriginRoute = await allocate(undefined, "https://alpha.example/frame");
  assert.equal(sameOriginRoute.synthetic_origin, `https://o-${sourceID}.browse.test`);
});
