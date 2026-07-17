import { createCompiler, isCompilerABIIdentifier } from "../runtime/compiler.mjs";
import { createClassicWorkerBootstrap } from "./classic.mjs";
import { WorkerBootstrapProtocol } from "./common.mjs";
import { createModuleWorkerBootstrap } from "./module.mjs";
import { createSharedWorkerClassicBootstrap } from "./shared-classic.mjs";
import { createSharedWorkerModuleBootstrap } from "./shared-module.mjs";
import { WorkerSourceKind } from "./source-kinds.mjs";
import { createWorkletModuleBootstrap } from "./worklet.mjs";

const GATEWAY_ID = /^[A-Za-z0-9_-]{32}$/u;
const SEALED_TARGET = /^[A-Za-z0-9_-]{1,16384}$/u;
const FACTORIES = new Map([
  [WorkerSourceKind.workerClassic, createClassicWorkerBootstrap],
  [WorkerSourceKind.workerModule, createModuleWorkerBootstrap],
  [WorkerSourceKind.sharedWorkerClassic, createSharedWorkerClassicBootstrap],
  [WorkerSourceKind.sharedWorkerModule, createSharedWorkerModuleBootstrap],
  [WorkerSourceKind.workletModule, createWorkletModuleBootstrap],
]);
let gatewayCryptoPromise;
let policyModulePromise;

function rejected(message) {
  throw new DOMException(message, "SecurityError");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function loadGatewayCrypto() {
  if (!gatewayCryptoPromise) {
    gatewayCryptoPromise = (async () => {
      const response = await fetch("/_zp/version.json", { cache: "no-store" });
      if (!response.ok) rejected("Worker gateway manifest unavailable");
      const version = await response.json();
      const moduleURL = version?.selectors?.["share_crypto.js"];
      const wasmURL = version?.selectors?.["share_crypto.wasm"];
      if (version?.version !== 2 || typeof moduleURL !== "string" || typeof wasmURL !== "string") {
        rejected("Worker gateway assets unavailable");
      }
      const module = await import(moduleURL);
      await module.default(wasmURL);
      if (typeof module.seal_history_v2 !== "function") rejected("Worker gateway crypto unavailable");
      return module;
    })();
  }
  return gatewayCryptoPromise;
}

async function loadPolicyModule() {
  if (!policyModulePromise) {
    policyModulePromise = (async () => {
      const response = await fetch("/_zp/version.json", { cache: "no-store" });
      if (!response.ok) rejected("Worker policy manifest unavailable");
      const version = await response.json();
      const moduleURL = version?.selectors?.["policy_core.js"];
      const wasmURL = version?.selectors?.["policy_core.wasm"];
      if (version?.version !== 2 || typeof moduleURL !== "string" || typeof wasmURL !== "string") rejected("Worker policy assets unavailable");
      const module = await import(moduleURL);
      await module.default(wasmURL);
      if (typeof module.canonicalize_json !== "function" || typeof module.worker_gateway_path_result_json !== "function") rejected("Worker policy unavailable");
      return module;
    })();
  }
  return policyModulePromise;
}

function parseSourceKind() {
  const fragment = new URL(globalThis.location.href).hash.slice(1);
  const parameters = new URLSearchParams(fragment);
  const sourceKind = parameters.get("source_kind");
  if (!FACTORIES.has(sourceKind)) rejected("Unsupported worker bootstrap source kind");
  return sourceKind;
}

function controlledRoute(value) {
  if (
    !value
    || typeof value !== "object"
    || value.controlled !== true
    || typeof value.url !== "string"
    || value.url.length === 0
  ) {
    rejected("Worker bootstrap route unavailable");
  }
  return value;
}

function gatewayConfiguration(value) {
  if (
    !isRecord(value)
    || Object.keys(value).some((key) => !["expires_at", "id", "key", "lease_generation"].includes(key))
    || !GATEWAY_ID.test(value.id)
    || !GATEWAY_ID.test(value.key)
    || !Number.isSafeInteger(value.expires_at)
    || value.expires_at <= Date.now()
    || !Number.isSafeInteger(value.lease_generation)
    || value.lease_generation < 1
  ) {
    rejected("Worker gateway unavailable");
  }
  return Object.freeze({ expires_at: value.expires_at, id: value.id, key: value.key, lease_generation: value.lease_generation });
}

function canonicalGatewayTarget(policy, rawURL, targetURL) {
  if (typeof rawURL !== "string" || rawURL.length === 0 || rawURL.length > 16_384) {
    rejected("Invalid worker gateway target");
  }
  let target;
  let base;
  try {
    target = JSON.parse(policy.canonicalize_json(rawURL, targetURL));
    base = JSON.parse(policy.canonicalize_json(targetURL));
  } catch {
    rejected("Invalid worker gateway target");
  }
  if (target.origin !== base.origin) rejected("Worker gateway target rejected");
  return target.network;
}

function sealedGatewayRoute(policy, crypto, gateway, kind, rawURL, context) {
  const targetURL = canonicalGatewayTarget(policy, rawURL, context?.targetURL);
  let token;
  try {
    token = crypto.seal_history_v2(gateway.key, gateway.id, targetURL);
  } catch {
    rejected("Worker gateway sealing failed");
  }
  if (typeof token !== "string" || !SEALED_TARGET.test(token)) rejected("Worker gateway sealing failed");
  let route;
  try {
    route = JSON.parse(policy.worker_gateway_path_result_json(kind === "wi" ? "classic" : "module", gateway.id, token));
  } catch {
    rejected("Worker gateway route rejected");
  }
  if (route?.ok !== true || typeof route.path !== "string") rejected("Worker gateway route rejected");
  return Object.freeze({ controlled: true, url: route.path });
}

function routeConfiguration(initialization, controlPort, gatewayCrypto, policy) {
  const bootstrap = initialization.bootstrap;
  if (
    !isRecord(bootstrap)
    || bootstrap.root_precompiled !== true
    || !isCompilerABIIdentifier(initialization.worker_abi_identifier)
    || bootstrap.abi_identifier !== initialization.worker_abi_identifier
  ) {
    rejected("Worker bootstrap capability unavailable");
  }
  const gateway = gatewayConfiguration(bootstrap.gateway);
  return {
    async createCompiler() {
      return createCompiler({
        abiIdentifier: initialization.worker_abi_identifier,
        cacheEpoch: `${gateway.id}:${gateway.lease_generation}`,
        realmID: initialization.worker_abi_identifier,
        referrer: initialization.target_url,
      });
    },
    routes: {
      classic(context) {
        return sealedGatewayRoute(policy, gatewayCrypto, gateway, "wi", context.rawURL, context);
      },
      classicRoot() {
        return controlledRoute(bootstrap.classic_root);
      },
      fetch() {
        return Promise.reject(new TypeError("Failed to fetch"));
      },
      message() {
        return bootstrap.message_allowed === true;
      },
      module(context) {
        return sealedGatewayRoute(policy, gatewayCrypto, gateway, "wmi", context.specifier, context);
      },
      moduleRoot() {
        return Promise.resolve(controlledRoute(bootstrap.module_root));
      },
      resolveModule(context) {
        return sealedGatewayRoute(policy, gatewayCrypto, gateway, "wmi", context.specifier, context);
      },
      terminate() {
        try {
          controlPort.postMessage({
            operation: "ZERO_PROXY_WORKER_TERMINATE_V2",
            v: WorkerBootstrapProtocol.version,
          });
        } catch {
          // The local worker is already closing.
        }
      },
      worker() {
        rejected("Nested worker bootstrap route unavailable");
      },
    },
  };
}

const sourceKind = parseSourceKind();
const factory = FACTORIES.get(sourceKind);
let sharedControlPort = null;
const bootstrap = factory({
  createRuntimeConfiguration: async (initialization, controlPort) => {
    sharedControlPort = controlPort;
    const [gatewayCrypto, policy] = await Promise.all([loadGatewayCrypto(), loadPolicyModule()]);
    const configuration = routeConfiguration(initialization, controlPort, gatewayCrypto, policy);
    const compiler = await configuration.createCompiler();
    return {
      abiIdentifier: compiler.abiIdentifier,
      compiler,
      routes: configuration.routes,
    };
  },
  global: globalThis,
});

if (
  sourceKind === WorkerSourceKind.sharedWorkerClassic
  || sourceKind === WorkerSourceKind.sharedWorkerModule
) {
  void bootstrap.ready.then(() => {
    if (!sharedControlPort || typeof globalThis.dispatchEvent !== "function") {
      rejected("SharedWorker connection unavailable");
    }
    globalThis.dispatchEvent(new MessageEvent("connect", { ports: [sharedControlPort] }));
  }).catch(() => {
    try { globalThis.close(); } catch {}
  });
}
