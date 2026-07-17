let targetRegistration = null;
let nextWorker = 0;
let controllerRevision = 0;
let controllerIssued = false;
let readyCommands = 0;
let lastUpdateType = null;
let lastUpdateViaCache = null;
let navigationPreload = { enabled: false, header_value: "true" };

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function worker(scriptURL, state = "activated", stateRevision = 4) {
  return { id: `worker-${++nextWorker}`, scriptURL, state, state_revision: stateRevision };
}

function workerView(value) {
  return value ? { ...value } : null;
}

function registrationView() {
  if (!targetRegistration) return null;
  return {
    id: targetRegistration.id,
    scope: targetRegistration.scope,
    scriptURL: targetRegistration.scriptURL,
    updateViaCache: targetRegistration.updateViaCache,
    type: targetRegistration.type,
    installing: workerView(targetRegistration.installing),
    waiting: workerView(targetRegistration.waiting),
    active: workerView(targetRegistration.active),
  };
}
async function notify(context, message, transfer = []) {
  const client = await self.clients.get(context.clientID);
  if (!client) return;
  const envelope = { v: 1, runtime_capability: context.capability, ...message };
  if (transfer.length === 0) client.postMessage(envelope);
  else client.postMessage(envelope, transfer);
}

async function notifyLifecycle(context, eventType, changedWorker) {
  await notify(context, {
    type: "TARGET_SERVICE_WORKER_LIFECYCLE",
    event_type: eventType,
    registration_id: targetRegistration?.id ?? context.registrationID,
    worker_version: changedWorker?.id ?? context.workerVersion,
    worker: workerView(changedWorker),
    registration: registrationView(),
  });
}

async function notifyController(context) {
  controllerIssued = true;
  controllerRevision += 1;
  await notify(context, {
    type: "TARGET_SERVICE_WORKER_CONTROLLER_CHANGE",
    controller: registrationView(),
    controller_revision: controllerRevision,
  });
  await notify(context, {
    type: "TARGET_SERVICE_WORKER_CONTROLLER_CHANGE",
    controller: null,
    controller_revision: controllerRevision,
  });
}
async function handleCommand(context, event) {
  const message = event.data;
  const reply = (ok, result = null) => context.port.postMessage({ v: 2, request_id: message?.request_id, ok, result });
  if (message?.v !== 2 || typeof message.request_id !== "string" || typeof message.operation !== "string") {
    reply(false);
    return;
  }
  const payload = message.payload ?? {};
  try {
    switch (message.operation) {
      case "TARGET_SERVICE_WORKER_REGISTER": {
        const active = worker(payload.script_url);
        targetRegistration = {
          id: "registration-1",
          scope: payload.scope_url ?? new URL("./", payload.script_url).href,
          scriptURL: payload.script_url,
          updateViaCache: payload.update_via_cache,
          type: payload.type,
          installing: null,
          waiting: null,
          active,
        };
        context.registrationID = targetRegistration.id;
        context.workerVersion = active.id;
        reply(true, registrationView());
        return;
      }
      case "TARGET_SERVICE_WORKER_GET_REGISTRATION":
        reply(true, targetRegistration && payload.url.startsWith(targetRegistration.scope) ? registrationView() : null);
        return;
      case "TARGET_SERVICE_WORKER_GET_REGISTRATIONS":
        reply(true, targetRegistration ? [registrationView()] : []);
        return;
      case "TARGET_SERVICE_WORKER_READY":
        readyCommands += 1;
        reply(true, controllerIssued ? registrationView() : null);
        if (!controllerIssued && targetRegistration) setTimeout(() => void notifyController(context), 50);
        return;
      case "TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_GET":
        reply(true, { ...navigationPreload });
        return;
      case "TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_ENABLE":
        navigationPreload.enabled = true;
        reply(true, { ...navigationPreload });
        return;
      case "TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_DISABLE":
        navigationPreload.enabled = false;
        reply(true, { ...navigationPreload });
        return;
      case "TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_SET_HEADER":
        navigationPreload.header_value = payload.value;
        reply(true, { ...navigationPreload });
        return;
      case "TARGET_SERVICE_WORKER_UPDATE": {
        if (!targetRegistration) throw new Error("registration unavailable");
        lastUpdateType = payload.type;
        lastUpdateViaCache = payload.update_via_cache;
        const previous = targetRegistration.active;
        const candidate = worker(targetRegistration.scriptURL, "installing", 1);
        targetRegistration.installing = candidate;
        await notifyLifecycle(context, "updatefound", candidate);
        await delay(15);
        candidate.state = "installed";
        candidate.state_revision = 2;
        targetRegistration.installing = null;
        targetRegistration.waiting = candidate;
        await notifyLifecycle(context, "statechange", candidate);
        await delay(15);
        candidate.state = "activating";
        candidate.state_revision = 3;
        targetRegistration.waiting = null;
        await notifyLifecycle(context, "statechange", candidate);
        await delay(15);
        candidate.state = "activated";
        candidate.state_revision = 4;
        previous.state = "redundant";
        previous.state_revision = 5;
        targetRegistration.active = candidate;
        context.workerVersion = candidate.id;
        await notifyController(context);
        await notifyLifecycle(context, "statechange", candidate);
        await notifyLifecycle(context, "statechange", previous);
        await delay(15);
        reply(true, registrationView());
        return;
      }
      case "TARGET_SERVICE_WORKER_POST_MESSAGE": {
        const transfer = [...event.ports];
        for (const port of transfer) port.postMessage({ via: "target-worker-port" });
        await notify(context, {
          type: "TARGET_SERVICE_WORKER_MESSAGE",
          message: {
            diagnostics: { lastUpdateType, lastUpdateViaCache, readyCommands },
            pong: payload.message?.ping,
            transferredPorts: transfer.length,
          },
        }, transfer);
        reply(true, true);
        return;
      }
      case "TARGET_SERVICE_WORKER_UNREGISTER": {
        if (!targetRegistration) {
          reply(true, false);
          return;
        }
        context.registrationID = targetRegistration.id;
        context.workerVersion = targetRegistration.active?.id ?? targetRegistration.id;
        targetRegistration = null;
        await notifyLifecycle(context, "unregistered", null);
        reply(true, true);
        return;
      }
      default:
        reply(false);
    }
  } catch {
    reply(false);
  }
}

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("message", event => {
  const message = event.data;
  const port = event.ports[0];
  if (message?.v !== 2 || message.operation !== "BIND_RUNTIME_PORT" || !port || typeof message.payload?.runtime_capability !== "string") return;
  const context = {
    capability: message.payload.runtime_capability,
    clientID: event.source.id,
    port,
    registrationID: "",
    workerVersion: "",
  };
  port.onmessage = command => void handleCommand(context, command);
  port.start();
  port.postMessage({ v: 2, operation: "RUNTIME_PORT_READY" });
});
