import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "../..");
const digest = marker => Buffer.alloc(32, marker).toString("base64url");
const encoded = marker => Buffer.alloc(32, marker).toString("base64url");

function relayBinding(index) {
  const profileDigest = digest(index);
  const relayOrigin = `wss://relay-${index}.example.test`;
  return {
    digest: profileDigest,
    profile: {
      profile_id: `relay-${index}`,
      deployment_id: `deployment-${index}-identifier`,
      relay_wss_origin: relayOrigin,
      carrier_path: "/_zp/carrier",
      expires_at: "2099-01-01T00:00:00Z",
      allowed_target_ports: [80, 443],
      limits: { max_streams: 8 },
    },
    capability: {
      capability_id: `capability-${index}`,
      capability_secret: encoded(index + 10),
      deployment_salt: encoded(index + 20),
      claims_digest: encoded(index + 30),
      capability_epoch: index,
      relay_profile_digest: profileDigest,
      relay_url: `${relayOrigin}/_zp/carrier`,
      expires_at: "2099-01-01T00:00:00Z",
      allowed_target_ports: [80, 443],
    },
  };
}

async function loadWarmKernelSeam() {
  const source = (await readFile(path.join(root, "web/sw/sw.mjs"), "utf8")).replace(/^(?:import [^\n]*;\n)+/, "");
  const captured = [];
  const worker = {
    addEventListener() {},
    clients: { claim: async () => {}, matchAll: async () => [] },
    location: { hostname: "o-origin.browse.example.test", origin: "https://o-origin.browse.example.test" },
    __zeroproxyKernelTransactionFrameV2() {},
    async __zeroproxyKernelCreateV2(configuration) {
      captured.push(configuration);
      return { id: "kernel" };
    },
    async __zeroproxyKernelBindDocumentV2() { return { v: 2, bound: true }; },
  };
  const context = {
    AbortController,
    ArrayBuffer,
    DOMException,
    Headers,
    ReadableStream,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    Uint8Array,
    POLICY_VERSION: 1,
    VERSION: "test-version",
    WebAssembly: { instantiateStreaming: async () => ({ instance: {} }) },
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    clearTimeout,
    crypto: globalThis.crypto,
    fetch: async () => ({}),
    Go: class { constructor() { this.importObject = {}; } async run() {} },
    self: worker,
    setTimeout,
    structuredClone,
  };
  context.globalThis = context;
  context.__zeroproxyStaticKernel = {
    kernel_wasm_url: "/kernel.wasm",
    wasm_exec_url: "/wasm_exec.js",
  };
  vm.runInNewContext(`${source}
    globalThis.__warmOrderedRelays = async state => {
      originState = Object.freeze(state);
      kernelReady = false;
      kernelHandle = null;
      lifecycleAuthority = { readyHot: async () => {} };
      versionManifest = async () => ({ selectors: {
        "kernel.wasm": "/kernel.wasm",
        "wasm_exec.js": "/wasm_exec.js",
      } });
      return warmKernel();
    };`, context, { filename: "web/sw/sw.mjs" });
  return { warm: context.__warmOrderedRelays, captured };
}

test("ordered coordinator relay bindings reach the kernel manager without collapsing", async () => {
  const bindings = [relayBinding(1), relayBinding(2)];
  const state = {
    profile_id: "profile",
    session_id: "session",
    tab_id: "tab",
    destination_origin_id: "origin",
    entry_id: "entry",
    bootstrap_client_id: "bootstrap-client",
    document_capability: "document-capability",
    capability_epoch: 1,
    isolation_username: "U".repeat(43),
    isolation_password: "P".repeat(43),
    relay_profile_digests: bindings.map(binding => binding.digest),
    relay_profiles: bindings.map(binding => binding.profile),
    relay_capabilities: bindings.map(binding => binding.capability),
  };
  const { warm, captured } = await loadWarmKernelSeam();
  await warm(state);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].relays.length, 2);
  assert.equal(
    JSON.stringify(captured[0].relays.map(relay => [
      relay.relayProfileID,
      relay.capabilityID,
      Buffer.from(relay.relayProfileDigest).toString("base64url"),
    ])),
    JSON.stringify(bindings.map(binding => [
      binding.profile.profile_id,
      binding.capability.capability_id,
      binding.digest,
    ])),
  );
});
