import { normalizePublicError } from "./generated/errors.mjs";
import { targetRouteKind } from "./generated/route-spec.mjs";

const BOOTSTRAP_SEQUENCE = Object.freeze([
  "UNCONTROLLED",
  "REGISTERING_SW",
  "WAITING_FOR_CONTROLLER",
  "CONNECTING_COORDINATOR",
  "VERIFYING_HOST_BINDING",
  "HYDRATING_ORIGIN_STATE",
  "WARMING_REWRITERS",
  "WARMING_KERNEL",
  "READY_TO_NAVIGATE",
]);
const COMMAND_TIMEOUT_MS = 15_000;
const ROOT_WORKER_PATH = "/_zp/sw.js";
const status = document.querySelector("#status");
let bootstrapStateIndex = -1;

function bootstrapError(code, name = "InvalidStateError") {
  const error = new DOMException(code, name);
  Object.defineProperty(error, "code", { configurable: true, value: code });
  return error;
}

function transition(name) {
  const expected = BOOTSTRAP_SEQUENCE[bootstrapStateIndex + 1];
  if (name !== expected) throw bootstrapError("BOOTSTRAP_STATE_VIOLATION", "SecurityError");
  bootstrapStateIndex += 1;
  document.documentElement.dataset.bootstrapState = name;
  status.value = name.replaceAll("_", " ").toLowerCase();
}

function block(error) {
  document.documentElement.dataset.bootstrapState = "BLOCKED";
  const code = typeof error?.code === "string" ? error.code : error?.name ?? "BOOTSTRAP_FAILED";
  status.value = `Blocked safely: ${code}`;
}

function handoffFromFragment() {
  const match = /^#handoff=([A-Za-z0-9_-]{32})&nonce=([A-Za-z0-9_-]{24})$/.exec(location.hash);
  if (!match) throw bootstrapError("HANDOFF_REJECTED", "SecurityError");
  history.replaceState(null, "", location.pathname + location.search);
  return Object.freeze({ handoff_id: match[1], nonce: match[2] });
}

function requireBrowserFeatures() {
  if (!("serviceWorker" in navigator) || typeof MessageChannel !== "function"
    || typeof Worker !== "function" || typeof SharedWorker !== "function") {
    throw bootstrapError("BROWSER_UNSUPPORTED", "NotSupportedError");
  }
}

function exactController(controller) {
  return controller?.scriptURL === new URL(ROOT_WORKER_PATH, location.origin).href;
}

function waitForController() {
  if (exactController(navigator.serviceWorker.controller)) {
    return Promise.resolve(navigator.serviceWorker.controller);
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
    };
    const changed = () => {
      if (!exactController(navigator.serviceWorker.controller)) return;
      cleanup();
      resolve(navigator.serviceWorker.controller);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(bootstrapError("SERVICE_WORKER_UNAVAILABLE", "TimeoutError"));
    }, COMMAND_TIMEOUT_MS);
    navigator.serviceWorker.addEventListener("controllerchange", changed);
  });
}

async function registerRootWorker() {
  const registration = await navigator.serviceWorker.register(ROOT_WORKER_PATH, {
    scope: "/",
    type: "module",
    updateViaCache: "none",
  });
  if (registration.scope !== new URL("/", location.origin).href) {
    throw bootstrapError("SERVICE_WORKER_SCOPE_REJECTED", "SecurityError");
  }
  return registration;
}

function commandID() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function swCommand(controller, operation, payload, ports = []) {
  const requestID = commandID();
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const cleanup = () => {
      clearTimeout(timer);
      channel.port1.close();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(bootstrapError("SERVICE_WORKER_TIMEOUT", "TimeoutError"));
    }, COMMAND_TIMEOUT_MS);
    channel.port1.onmessage = (event) => {
      cleanup();
      const response = event.data;
      if (response?.request_id !== requestID) {
        reject(bootstrapError("SERVICE_WORKER_REJECTED"));
      } else if (response.ok === true) {
        resolve(response.result);
      } else {
        try {
          const publicError = normalizePublicError(response.error);
          if (publicError.request_id !== requestID) throw new TypeError("mismatched error request ID");
          reject(bootstrapError(publicError.code));
        } catch {
          reject(bootstrapError("SERVICE_WORKER_REJECTED"));
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
      reject(bootstrapError("SERVICE_WORKER_UNAVAILABLE"));
    }
  });
}

async function browseConfig() {
  const response = await fetch("/_zp/config", { cache: "no-store" });
  if (!response.ok) throw bootstrapError("COORDINATOR_UNAVAILABLE", "NetworkError");
  const config = await response.json();
  if (typeof config.control_host !== "string" || typeof config.browse_domain !== "string") {
    throw bootstrapError("COORDINATOR_UNAVAILABLE", "DataError");
  }
  const controlOrigin = new URL(`https://${config.control_host}`);
  if (controlOrigin.host !== config.control_host || controlOrigin.pathname !== "/") {
    throw bootstrapError("COORDINATOR_UNAVAILABLE", "SecurityError");
  }
  return Object.freeze({ ...config, control_origin: controlOrigin.origin });
}

function validFormSubmission(value) {
  if (value === null) return true;
  const fields = ["method", "content_type", "body", "body_length", "body_sha256", "source_url", "referrer_policy"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length || !fields.every(field => field in value)
    || value.method !== "POST" || typeof value.content_type !== "string" || value.content_type.length === 0 || value.content_type.length > 1_024 || /[\r\n]/u.test(value.content_type)
    || !(value.body instanceof Uint8Array) || value.body.byteLength > 16 << 20 || value.body_length !== value.body.byteLength
    || typeof value.body_sha256 !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.body_sha256)
    || typeof value.referrer_policy !== "string") return false;
  try {
    const source = new URL(value.source_url);
    return ["http:", "https:"].includes(source.protocol) && source.username === "" && source.password === "";
  } catch {
    return false;
  }
}

const ATTACHED_STATE_FIELDS = Object.freeze([
  "profile_id",
  "session_id",
  "tab_id",
  "entry_id",
  "destination_origin_id",
  "destination_host",
  "capability_epoch",
  "document_capability",
  "lineage_revision",
  "target_url",
  "isolation_username",
  "isolation_password",
  "relay_profile_digests",
  "relay_profiles",
  "relay_capabilities",
  "ancestor_urls",
  "form_submission",
  "coordinator_revision",
]);

function exactAttachedState(state) {
  return state && typeof state === "object" && !Array.isArray(state)
    && Object.keys(state).length === ATTACHED_STATE_FIELDS.length
    && ATTACHED_STATE_FIELDS.every((field) => field in state)
    && /^[a-z2-7]{32}$/.test(state.destination_origin_id)
    && state.destination_host === location.host
    && Number.isSafeInteger(state.capability_epoch) && state.capability_epoch > 0
    && Number.isSafeInteger(state.coordinator_revision) && state.coordinator_revision >= 0
    && Array.isArray(state.ancestor_urls)
    && state.ancestor_urls.length <= 32
    && state.ancestor_urls.every((value) => {
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && url.username === "" && url.password === "";
      } catch {
        return false;
      }
    })
    && validFormSubmission(state.form_submission)
    && typeof state.isolation_username === "string"
    && /^[A-Za-z0-9_-]{43}$/.test(state.isolation_username)
    && typeof state.isolation_password === "string"
    && /^[A-Za-z0-9_-]{43}$/.test(state.isolation_password)
    && Array.isArray(state.relay_profile_digests)
    && state.relay_profile_digests.length >= 1
    && state.relay_profile_digests.length <= 8
    && Array.isArray(state.relay_profiles)
    && state.relay_profiles.length === state.relay_profile_digests.length
    && Array.isArray(state.relay_capabilities)
    && state.relay_capabilities.length === state.relay_profile_digests.length
    && state.relay_profile_digests.every((digest, index) =>
      typeof digest === "string" && /^[A-Za-z0-9_-]{43}$/.test(digest)
      && state.relay_profile_digests.indexOf(digest) === index
      && state.relay_profiles[index] && typeof state.relay_profiles[index] === "object"
      && state.relay_capabilities[index] && typeof state.relay_capabilities[index] === "object"
      && state.relay_capabilities[index].relay_profile_digest === digest);
}

function exactBridgeFailure(message) {
  return message && typeof message === "object"
    && Object.keys(message).length === 3
    && ["v", "operation", "error"].every((field) => field in message)
    && message.v === 2 && message.operation === "ATTACH_FAILED"
    && message.error && typeof message.error === "object"
    && Object.keys(message.error).length === 1
    && typeof message.error.code === "string";
}

function exactBridgeAttachment(event) {
  const message = event.data;
  return message && typeof message === "object"
    && message.v === 2 && message.operation === "ATTACHED"
    && Object.keys(message).length === 3
    && event.ports.length === 1
    && exactAttachedState(message.state);
}

function bridgeFailure(message) {
  const code = message.error.code === "BROWSER_UNSUPPORTED"
    ? "BROWSER_UNSUPPORTED"
    : "COORDINATOR_UNAVAILABLE";
  return bootstrapError(code);
}

function closeTransferredPorts(event) {
  for (const port of event.ports) port.close();
}

function connectCoordinator(config, handoff) {
  const iframe = document.createElement("iframe");
  iframe.hidden = true;
  iframe.referrerPolicy = "no-referrer";
  iframe.src = `${config.control_origin}/control/bridge.html#nonce=${handoff.nonce}`;
  document.documentElement.append(iframe);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      removeEventListener("message", receive);
      iframe.remove();
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(bootstrapError("COORDINATOR_UNAVAILABLE", "TimeoutError"));
    }, COMMAND_TIMEOUT_MS);
    const receive = (event) => {
      if (event.source !== iframe.contentWindow || event.origin !== config.control_origin) return;
      if (exactBridgeFailure(event.data)) {
        fail(bridgeFailure(event.data));
        return;
      }
      if (!exactBridgeAttachment(event)) {
        closeTransferredPorts(event);
        fail(bootstrapError("COORDINATOR_UNAVAILABLE", "SecurityError"));
        return;
      }
      cleanup();
      resolve({ state: Object.freeze(event.data.state), port: event.ports[0] });
    };
    addEventListener("message", receive);
    iframe.addEventListener("error", () => {
      fail(bootstrapError("COORDINATOR_UNAVAILABLE", "NetworkError"));
    }, { once: true });
    iframe.addEventListener("load", () => {
      iframe.contentWindow.postMessage({
        v: 2,
        operation: "ATTACH",
        handoff_id: handoff.handoff_id,
        nonce: handoff.nonce,
      }, config.control_origin);
    }, { once: true });
  });
}

function verifyHostBinding(config, state) {
  const expectedHostname = `o-${state.destination_origin_id}.browse.${config.browse_domain}`;
  if (location.hostname !== expectedHostname || location.host !== state.destination_host) {
    throw bootstrapError("HOST_BINDING_REJECTED", "SecurityError");
  }
}


async function runBootstrap() {
  transition("UNCONTROLLED");
  const handoff = handoffFromFragment();
  requireBrowserFeatures();

  transition("REGISTERING_SW");
  await registerRootWorker();
  transition("WAITING_FOR_CONTROLLER");
  const controller = await waitForController();

  transition("CONNECTING_COORDINATOR");
  const config = await browseConfig();
  const attached = await connectCoordinator(config, handoff);

  transition("VERIFYING_HOST_BINDING");
  verifyHostBinding(config, attached.state);

  transition("HYDRATING_ORIGIN_STATE");
  try {
    await swCommand(controller, "ATTACH_COORDINATOR", attached.state, [attached.port]);
  } catch (error) {
    attached.port.close();
    throw error;
  }
  await swCommand(controller, "WAIT_TARGET_WORKER_HOST", {});

  transition("WARMING_REWRITERS");
  await swCommand(controller, "WARM_REWRITERS", {});
  transition("WARMING_KERNEL");
  await swCommand(controller, "WARM_KERNEL", {});

  transition("READY_TO_NAVIGATE");
  const route = await swCommand(controller, "ALLOCATE_DOCUMENT_ROUTE", attached.state);
  if (!route || Object.keys(route).length !== 1 || targetRouteKind(route.path) !== "document") {
    throw bootstrapError("DOCUMENT_ROUTE_REJECTED", "SecurityError");
  }
  location.replace(route.path);
}

runBootstrap().catch(block);
