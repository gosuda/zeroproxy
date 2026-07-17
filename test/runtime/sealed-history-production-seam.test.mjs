import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const dist = path.join(root, "dist/web");
const entryID = "e".repeat(32);
const capability = "c".repeat(32);

async function loadHistoryCrypto() {
  const version = JSON.parse(await readFile(path.join(dist, "_zp/version.json"), "utf8"));
  const glueAsset = version.selectors?.["share_crypto.js"];
  const wasmAsset = version.selectors?.["share_crypto.wasm"];
  assert.equal(typeof glueAsset, "string", "current share crypto glue selector is required");
  assert.equal(typeof wasmAsset, "string", "current share crypto wasm selector is required");
  const glue = await import(`${pathToFileURL(path.resolve(dist, `.${glueAsset}`)).href}?sealed-history-production-seam`);
  await glue.default({ module_or_path: await readFile(path.resolve(dist, `.${wasmAsset}`)) });
  return glue;
}

async function loadProductionOpenHistoryRoute(historyCrypto) {
  const source = (await readFile(path.join(root, "web/sw/sw.mjs"), "utf8")).replace(/^(?:import [^\n]*;\n)+/, "");
  const historyKeys = new Map();
  const context = {
    URL,
    URLSearchParams,
    DOMException,
    Response,
    Request,
    Headers,
    TextEncoder,
    TextDecoder,
    MessageChannel,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    console,
    createBoundedRewriteCache: () => ({}),
    structuredClone,
    __historyCrypto: historyCrypto,
    __historyKeys: historyKeys,
    self: { addEventListener() {}, clients: { claim: async () => {} }, skipWaiting: async () => {}, location: { hostname: "o-origin-a.browse.test" } },
  };
  context.globalThis = context;
  vm.runInNewContext(`${source}
    globalThis.__openHistoryProductionSeam = async (key, state, requestedEntryID, token) => {
      originState = state;
      historyCrypto = globalThis.__historyCrypto;
      database = async () => ({ transaction: () => ({ objectStore: () => ({ get: id => globalThis.__historyKeys.get(id) ?? null }) }) });
      request = async value => value;
      complete = async () => {};
      globalThis.__historyKeys.clear();
      globalThis.__historyKeys.set(key.entry_id, key);
      return openHistoryRoute(requestedEntryID, token);
    };`, context, { filename: "web/sw/sw.mjs" });
  return context.__openHistoryProductionSeam;
}

function originState() {
  return {
    profile_id: "profile-a",
    destination_origin_id: "origin-a",
    capability_epoch: 7,
    target_url: "https://target.example/application/root",
    isolation_username: "U".repeat(43),
    isolation_password: "P".repeat(43),
    relay_profile_digests: ["A".repeat(43)],
    relay_profiles: [{ relay_wss_origin: "wss://relay.example.test", carrier_path: "/_zp/carrier", expires_at: "2099-01-01T00:00:00Z", allowed_target_ports: [443] }],
    relay_capabilities: [{ relay_profile_digest: "A".repeat(43), relay_url: "wss://relay.example.test/_zp/carrier", expires_at: "2099-01-01T00:00:00Z", allowed_target_ports: [443] }],
  };
}

function historyKey(overrides = {}) {
  return {
    entry_id: entryID,
    profile_id: "profile-a",
    tab_id: "tab-a",
    origin_id: "origin-a",
    capability_epoch: 7,
    runtime_capability: capability,
    expires_at: Date.now() + 60_000,
    abi_identifier: `__zp_abi_${"a".repeat(48)}`,
    ...overrides,
  };
}

function tamper(token) {
  const last = token.at(-1);
  return `${token.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

test("production openHistoryRoute validates durable history keys before real wasm decryption", async () => {
  const historyCrypto = await loadHistoryCrypto();
  const openHistoryRoute = await loadProductionOpenHistoryRoute(historyCrypto);
  const targetURL = "https://target.example/application/history?secret=sealed#fragment";
  const token = historyCrypto.seal_history_v2(capability, entryID, targetURL);
  const state = originState();

  const key = historyKey();
  const route = await openHistoryRoute(key, state, entryID, token);
  assert.deepEqual(JSON.parse(JSON.stringify(route)), {
    id: entryID,
    kind: "document",
    profile_id: "profile-a",
    tab_id: "tab-a",
    entry_id: entryID,
    origin_id: "origin-a",
    target_url: "https://target.example/application/history?secret=sealed",
    visible_target_url: targetURL,
    source_url: state.target_url,
    abi_identifier: `__zp_abi_${"a".repeat(48)}`,
    history_runtime_capability: capability,
    expires_at: key.expires_at,
    consumed: false,
  });

  for (const key of [
    historyKey({ profile_id: "profile-b" }),
    historyKey({ origin_id: "origin-b" }),
    historyKey({ capability_epoch: 8 }),
    historyKey({ expires_at: Date.now() - 1 }),
  ]) {
    assert.equal(await openHistoryRoute(key, state, entryID, token), null);
  }
  assert.equal(await openHistoryRoute(historyKey(), state, "z".repeat(32), token), null);
  assert.equal(await openHistoryRoute(historyKey(), state, entryID, tamper(token)), null);
  assert.equal(await openHistoryRoute(historyKey({ runtime_capability: "d".repeat(32) }), state, entryID, token), null);
});
