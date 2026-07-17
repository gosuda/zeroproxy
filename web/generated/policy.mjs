import { INVENTORY_POLICY_VERSION, NETWORK_INVENTORY, inventoryEntry } from "./policy-inventory.mjs";
import { EXACT_ROUTES, ROUTE_SPEC_POLICY_VERSION, ROUTE_TABLE } from "./route-spec.mjs";

export const POLICY_VERSION = 2;
if (INVENTORY_POLICY_VERSION !== POLICY_VERSION || ROUTE_SPEC_POLICY_VERSION !== POLICY_VERSION) throw new DOMException("Generated policy version mismatch", "InvalidStateError");

export { NETWORK_INVENTORY, inventoryEntry };

let policyModulePromise;

async function loadPolicyModule() {
  if (!policyModulePromise) {
    policyModulePromise = (async () => {
      const manifest = await fetch("/_zp/version.json", { cache: "no-store", credentials: "same-origin" }).then((response) => {
        if (!response.ok) throw new DOMException("Policy version manifest unavailable", "NetworkError");
        return response.json();
      });
      if (manifest.version !== POLICY_VERSION) throw new DOMException("Policy version mismatch", "InvalidStateError");
      const moduleURL = manifest.selectors?.["policy_core.js"];
      const wasmURL = manifest.selectors?.["policy_core.wasm"];
      if (typeof moduleURL !== "string" || typeof wasmURL !== "string") throw new DOMException("Policy artifact unavailable", "InvalidStateError");
      const module = await import(moduleURL);
      if(typeof module.default!=="function"||typeof module.canonicalize_result_json!=="function"||typeof module.route_path_result_json!=="function"||typeof module.parse_route_result_json!=="function"||typeof module.route_spec_version!=="function"||typeof module.sealed_route_path_result_json!=="function"||typeof module.executable_route_path_result_json!=="function")throw new DOMException("Policy binding unavailable","InvalidStateError");
      await module.default(wasmURL);
      if(module.route_spec_version()!==POLICY_VERSION)throw new DOMException("Route specification version mismatch","InvalidStateError");
      return module;
    })();
  }
  return policyModulePromise;
}

export async function canonicalTarget(raw, base) {
  if (typeof raw !== "string" || (base !== undefined && typeof base !== "string")) throw new TypeError("target URL inputs must be strings");
  const module = await loadPolicyModule();
  const result = JSON.parse(module.canonicalize_result_json(raw, base));
  if (result?.ok !== true) {
    const code = result?.error?.code;
    if (code === "UNSUPPORTED_SCHEME" || code === "USERINFO_FORBIDDEN") throw new DOMException("Target URL rejected by policy", "SecurityError");
    throw new DOMException("Invalid target URL", "SyntaxError");
  }
  const target = result.target;
  return Object.freeze({
    url: target.visible,
    networkURL: target.network,
    fragment: target.fragment ?? "",
    canonicalOrigin: target.origin,
    canonicalSite: target.site,
    scheme: target.scheme,
    host: target.host,
    port: target.port,
    origin: target.origin,
  });
}

export async function routePath(kind, id) {
  if (typeof kind !== "string" || typeof id !== "string") throw new TypeError("route inputs must be strings");
  const module = await loadPolicyModule();
  const result = JSON.parse(module.route_path_result_json(kind, id));
  if (result?.ok !== true || typeof result.path !== "string") throw new DOMException("Route rejected by policy", "SecurityError");
  return result.path;
}

export async function sealedRoutePath(kind, operationID, token) {
  if (typeof kind !== "string" || typeof operationID !== "string" || typeof token !== "string") throw new TypeError("sealed route inputs must be strings");
  const module = await loadPolicyModule();
  const result = JSON.parse(module.sealed_route_path_result_json(kind, operationID, token));
  if (result?.ok !== true || typeof result.path !== "string") throw new DOMException("Route rejected by policy", "SecurityError");
  return result.path;
}

export async function parseRoute(pathname) {
  if (typeof pathname !== "string") throw new TypeError("route pathname must be a string");
  const module = await loadPolicyModule();
  const result = JSON.parse(module.parse_route_result_json(pathname));
  if (result?.ok !== true
    || !result.route
    || !["target", "api-plan"].includes(result.route.family)
    || typeof result.route.id !== "string"
    || (result.route.family === "target" && typeof result.route.kind !== "string")
    || (result.route.family === "api-plan" && result.route.kind !== null)) {
    throw new DOMException("Route rejected by policy", "SecurityError");
  }
  return Object.freeze(result.route);
}


export function classifyRequest(pathname) {
  if (typeof pathname !== "string") return "unknown";
  const exact = EXACT_ROUTES.get(pathname);
  if (exact) return exact;
  for (const route of ROUTE_TABLE) {
    if (route.pattern.test(pathname)) return route.kind;
  }
  return "unknown";
}
