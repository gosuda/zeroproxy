import { normalizePublicError } from "./generated/errors.mjs";
const ROOT_WORKER_PATH = "/_zp/sw.js";
const HOST_FRAME_PATH = "/_zp/target-worker-host";
const COMMAND_TIMEOUT_MS = 15_000;
const ATTACH_WINDOW_MS = 30_000;
const PROBE_INTERVAL_MS = 5_000;
const CONFIGURE_OPERATION = "CONFIGURE_TARGET_WORKER_HOST";
const READY_OPERATION = "TARGET_WORKER_HOST_READY";
const status = document.querySelector("#status");
let activeHost = null;

function hostError(code, name = "InvalidStateError") {
  const error = new DOMException(code, name);
  Object.defineProperty(error, "code", { configurable: true, value: code });
  return error;
}

function block(error) {
  activeHost?.terminate();
  activeHost = null;
  document.documentElement.dataset.hostState = "BLOCKED";
  status.value = `Blocked safely: ${typeof error?.code === "string" ? error.code : error?.name ?? "HOST_FAILED"}`;
}

function exactController(controller) {
  return controller?.scriptURL === new URL(ROOT_WORKER_PATH, location.origin).href;
}

function commandID() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function requireFeatures() {
  if (!("serviceWorker" in navigator) || typeof MessageChannel !== "function" || typeof Worker !== "function") {
    throw hostError("BROWSER_UNSUPPORTED", "NotSupportedError");
  }
}

async function browseConfig() {
  const response = await fetch("/_zp/config", { cache: "no-store" });
  if (!response.ok) throw hostError("CONTROL_ORIGIN_UNAVAILABLE", "NetworkError");
  const config = await response.json();
  if (!config || typeof config.control_host !== "string" || typeof config.browse_domain !== "string") {
    throw hostError("CONTROL_ORIGIN_UNAVAILABLE", "DataError");
  }
  const control = new URL(`https://${config.control_host}`);
  if (control.host !== config.control_host || control.pathname !== "/" || control.search || control.hash) {
    throw hostError("CONTROL_ORIGIN_REJECTED", "SecurityError");
  }
  return Object.freeze({ control_origin: control.origin });
}

function waitForController() {
  if (exactController(navigator.serviceWorker.controller)) return Promise.resolve(navigator.serviceWorker.controller);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
    };
    const changed = () => {
      if (!exactController(navigator.serviceWorker.controller)) return;
      cleanup();
      resolve(navigator.serviceWorker.controller);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(hostError("SERVICE_WORKER_UNAVAILABLE", "TimeoutError"));
    }, COMMAND_TIMEOUT_MS);
    navigator.serviceWorker.addEventListener("controllerchange", changed);
  });
}

async function rootController() {
  const registration = await navigator.serviceWorker.register(ROOT_WORKER_PATH, {
    scope: "/",
    type: "module",
    updateViaCache: "none",
  });
  if (registration.scope !== new URL("/", location.origin).href) {
    throw hostError("SERVICE_WORKER_SCOPE_REJECTED", "SecurityError");
  }
  return waitForController();
}

function exactBinding(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 6
    && value.v === 2
    && value.operation === CONFIGURE_OPERATION
    && typeof value.profile_id === "string"
    && value.profile_id.length > 0
    && value.profile_id.length <= 256
    && value.synthetic_origin === location.origin
    && Number.isSafeInteger(value.client_epoch)
    && value.client_epoch > 0
    && typeof value.capability === "string"
    && /^[A-Za-z0-9_-]{43}$/u.test(value.capability);
}

function serviceCommand(controller, operation, payload, ports = []) {
  const requestID = commandID();
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const cleanup = () => {
      clearTimeout(timer);
      channel.port1.close();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(hostError("SERVICE_WORKER_TIMEOUT", "TimeoutError"));
    }, COMMAND_TIMEOUT_MS);
    channel.port1.onmessage = event => {
      cleanup();
      const response = event.data;
      if (response?.request_id !== requestID) {
        reject(hostError("SERVICE_WORKER_REJECTED"));
      } else if (response.ok === true) {
        resolve(response.result);
      } else {
        try {
          const publicError = normalizePublicError(response.error);
          if (publicError.request_id !== requestID) throw new TypeError("mismatched error request ID");
          reject(hostError(publicError.code));
        } catch {
          reject(hostError("SERVICE_WORKER_REJECTED"));
        }
      }
    };
    try {
      controller.postMessage({
        v: 2,
        command_id: requestID,
        operation,
        payload,
        replyPort: channel.port2,
      }, [channel.port2, ...ports]);
    } catch {
      cleanup();
      reject(hostError("SERVICE_WORKER_UNAVAILABLE"));
    }
  });
}

async function targetWorkerHostURL() {
  const response = await fetch("/_zp/version.json", { cache: "no-store" });
  if (!response.ok) throw hostError("TARGET_WORKER_HOST_UNAVAILABLE", "NetworkError");
  const manifest = await response.json();
  const hostURL = manifest?.selectors?.["target-worker-host-classic.js"];
  if (manifest?.version !== 2 || typeof hostURL !== "string"
    || !/^\/_zp\/assets\/[a-f0-9]{64}\/target-worker-host-classic\.js$/u.test(hostURL)) {
    throw hostError("TARGET_WORKER_HOST_REJECTED", "SecurityError");
  }
  return hostURL;
}

async function attachOnce(binding, hostURL) {
  const controller = await rootController();
  const channel = new MessageChannel();
  const host = new Worker(hostURL, { name: "ZeroProxyTargetWorkerHost" });
  try {
    host.postMessage({ v: 1, type: "ATTACH_TARGET_WORKER_PORT" }, [channel.port2]);
    await serviceCommand(controller, "ATTACH_TARGET_WORKER_HOST", binding, [channel.port1]);
    activeHost?.terminate();
    activeHost = host;
  } catch (error) {
    host.terminate();
    throw error;
  }
}

async function probe(binding) {
  const result = await serviceCommand(await rootController(), "PROBE_TARGET_WORKER_HOST", binding);
  return result?.attached === true;
}

async function attachUntilReady(binding, hostURL) {
  const deadline = Date.now() + ATTACH_WINDOW_MS;
  let lastError = hostError("TARGET_WORKER_HOST_UNAVAILABLE");
  while (Date.now() < deadline) {
    try {
      await attachOnce(binding, hostURL);
      document.documentElement.dataset.hostState = "ATTACHED";
      status.value = "Execution host attached";
      return;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw lastError;
}

async function maintainAttachment(binding) {
  const hostURL = await targetWorkerHostURL();
  await attachUntilReady(binding, hostURL);
  for (;;) {
    await sleep(PROBE_INTERVAL_MS);
    let attached = false;
    try {
      attached = await probe(binding);
    } catch {
      // Reattach below after controller loss, process eviction, or capability reset.
    }
    if (!attached) await attachUntilReady(binding, hostURL);
  }
}

function waitForConfigurationEvent() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      removeEventListener("message", receive);
      reject(hostError("HOST_CONFIGURATION_TIMEOUT", "TimeoutError"));
    }, COMMAND_TIMEOUT_MS);
    const receive = event => {
      if (event.source !== parent) return;
      clearTimeout(timer);
      removeEventListener("message", receive);
      resolve(event);
    };
    addEventListener("message", receive);
  });
}

async function start() {
  if (location.pathname !== HOST_FRAME_PATH || location.search || location.hash || top === self) {
    throw hostError("HOST_CONTEXT_REJECTED", "SecurityError");
  }
  requireFeatures();
  const configuration = waitForConfigurationEvent();
  const [{ control_origin: controlOrigin }, , event] = await Promise.all([
    browseConfig(),
    rootController(),
    configuration,
  ]);
  if (event.origin !== controlOrigin || !exactBinding(event.data)) {
    throw hostError("HOST_CONFIGURATION_REJECTED", "SecurityError");
  }
  const binding = Object.freeze({
    profile_id: event.data.profile_id,
    synthetic_origin: event.data.synthetic_origin,
    client_epoch: event.data.client_epoch,
    capability: event.data.capability,
  });
  parent.postMessage(Object.freeze({
    v: 2,
    operation: READY_OPERATION,
    ...binding,
  }), controlOrigin);
  document.documentElement.dataset.hostState = "READY";
  status.value = "Execution host ready";
  await maintainAttachment(binding);
}

void start().catch(block);
