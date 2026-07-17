let gatewaySealerPromise = null;
let routeBuilderPromise = null;

async function loadRouteBuilder() {
  if (!routeBuilderPromise) {
    routeBuilderPromise = (async () => {
      const response = await fetch("/_zp/version.json", { cache: "no-store" });
      if (!response.ok) throw new DOMException("Classic import route builder unavailable", "NetworkError");
      const manifest = await response.json();
      const moduleURL = manifest?.selectors?.["policy_core.js"];
      const wasmURL = manifest?.selectors?.["policy_core.wasm"];
      if (manifest?.version !== 2 || typeof moduleURL !== "string" || typeof wasmURL !== "string") throw new DOMException("Classic import route builder unavailable", "SecurityError");
      const policy = await import(moduleURL);
      if (typeof policy.default !== "function" || typeof policy.worker_gateway_path_result_json !== "function" || typeof policy.executable_route_path_result_json !== "function") throw new DOMException("Target worker route builder unavailable", "SecurityError");
      await policy.default(wasmURL);
      return (kind, routeID, contentID) => {
        let result;
        try {
          result = kind === "classic" || kind === "module"
            ? JSON.parse(policy.worker_gateway_path_result_json(kind, routeID, contentID))
            : JSON.parse(policy.executable_route_path_result_json(kind, routeID, contentID));
        } catch {
          throw new DOMException("Target worker route builder rejected", "SecurityError");
        }
        if (result?.ok !== true || typeof result.path !== "string") throw new DOMException("Target worker route builder rejected", "SecurityError");
        return result.path;
      };
    })();
  }
  return routeBuilderPromise;
}


async function loadGatewaySealer() {
  if (!gatewaySealerPromise) {
    gatewaySealerPromise = (async () => {
      const response = await fetch("/_zp/version.json", { cache: "no-store" });
      if (!response.ok) throw new DOMException("Classic import gateway unavailable", "NetworkError");
      const manifest = await response.json();
      const moduleURL = manifest?.selectors?.["share_crypto.js"];
      const wasmURL = manifest?.selectors?.["share_crypto.wasm"];
      if (manifest?.version !== 2 || typeof moduleURL !== "string" || typeof wasmURL !== "string") throw new DOMException("Classic import gateway unavailable", "SecurityError");
      const crypto = await import(moduleURL);
      await crypto.default(wasmURL);
      if (typeof crypto.seal_history_v2 !== "function") throw new DOMException("Classic import gateway unavailable", "SecurityError");
      return (key, id, targetURL) => crypto.seal_history_v2(key, id, targetURL);
    })();
  }
  return gatewaySealerPromise;
}

import { startTargetWorkerHost } from "./host-runtime.mjs";

let runtime = null;

self.addEventListener("message", (event) => {
  const message = event.data;
  if (
    runtime !== null
    || !message
    || message.v !== 1
    || message.type !== "ATTACH_TARGET_WORKER_PORT"
    || event.ports.length !== 1
  ) {
    return;
  }
  runtime = startTargetWorkerHost(event.ports[0], { loadGatewaySealer, loadRouteBuilder });
});
