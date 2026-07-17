const resourcePlans = new Map();
const resourceRoutePaths = new Map();

const plans = new Map();
const apiRequestPlans = new Map();
const eventSourcePlans = new Map();
const eventSourceTokens = new Map();

function tokenFor(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function scriptLedgerResponse(url) {
  const plan = resourcePlans.get(url.pathname);
  if (!plan) return new Response("missing script plan", { status: 404 });
  if (plan.kind === "classic") {
    const channel = new BroadcastChannel("zeroproxy-script-ledger");
    channel.postMessage({ type: "fetch-started", target: plan.target });
    channel.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    return new Response('globalThis.dynamicExternalRuns=(globalThis.dynamicExternalRuns??0)+1;globalThis.dynamicExternalCurrentScript=document.currentScript===globalThis.dynamicExternalScript', { headers: { "Content-Type": "text/javascript;charset=utf-8" } });
  }
  return new Response('globalThis.dynamicExternalModuleRuns=(globalThis.dynamicExternalModuleRuns??0)+1;globalThis.dynamicExternalModuleCurrentScript=document.currentScript', { headers: { "Content-Type": "text/javascript;charset=utf-8" } });
}

async function boundedRequestBody(request) {
  if (!request.body) return null;
  const reader = request.body.getReader(), chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) throw new TypeError("gateway upload chunk is invalid");
    length += value.byteLength;
    if (length > 16 << 20) throw new RangeError("gateway upload exceeds 16 MiB");
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function trustedLastEventID(text,current) {
  let value = current;
  for (const line of text.split(/\r\n|\r|\n/u)) {
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const raw = colon < 0 ? "" : line.slice(colon + 1);
    const candidate = raw[0] === " " ? raw.slice(1) : raw;
    if (field === "id" && candidate.length <= 4096 && !candidate.includes("\0")) value = candidate;
  }
  return value;
}
async function relayAPIRequest(request) {
  const body = await boundedRequestBody(request);
  const url = new URL(request.url),stableToken = url.pathname.slice("/_zp/api/".length),plan = apiRequestPlans.get(stableToken);
  let activePlan = plan;
  if (plan?.xhr_native_content_type) {
    const contentType = request.headers.get("content-type");
    if (contentType) activePlan = { ...plan, headers: [...plan.headers, ["Content-Type", contentType]] };
  }
  const target = activePlan ? `${url.origin}/_zp/api/${tokenFor(activePlan)}` : request.url;
  if (plan?.request_kind !== "eventsource") apiRequestPlans.delete(stableToken);
  const options = { method: request.method, headers: request.headers, redirect: "error", credentials: "omit" };
  if (body !== null) options.body = body;
  const response = await fetch(target, options);
  if (plan?.request_kind !== "eventsource") return response;
  const bytes = await response.arrayBuffer();
  plan.last_event_id = trustedLastEventID(new TextDecoder().decode(bytes), plan.last_event_id ?? "");
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function streamPlan(port, plan, requestID) {
  const target = new URL(plan.target_url);
  const fail = target.pathname === "/socket-error";
  let closed = false;
  const post = message => port.postMessage({ v: 2, request_id: requestID, ...message });
  const echo = command => {
    if (closed) return;
    post({ type: "ack", seq: command.seq });
    post({ type: "message", data_kind: command.kind, data: command.data });
  };
  port.start();
  port.onmessage = event => {
    if (closed) return;
    const command = event.data;
    if (!command || command.v !== 2 || command.request_id !== requestID || typeof command.type !== "string") return;
    if (command.type === "send") {
      if (target.pathname === "/stream") setTimeout(() => echo(command), 25);
      else echo(command);
      return;
    }
    if (command.type === "close") {
      closed = true;
      if (target.pathname === "/socket")
        post({ type: "message", data_kind: "text", data: new TextEncoder().encode("while-closing") });
      post({ type: "close", code: command.code, reason: command.reason, was_clean: true });
      return;
    }
    if (command.type === "cancel") closed = true;
  };
  post({ type: "ready", max_message_bytes: 1 << 20, send_high_water_mark: 1 << 20 });
  if (fail) {
    queueMicrotask(() => {
      if (closed) return;
      post({ type: "error", error: "MOCK_FAILURE" });
      post({ type: "error", error: "MOCK_FAILURE_DUPLICATE" });
      post({ type: "close", code: 1006, reason: "", was_clean: false });
      post({ type: "close", code: 1006, reason: "", was_clean: false });
      closed = true;
    });
  } else {
    post({ type: "open", protocol: plan.protocols?.[0] ?? "" });
  }
}

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith("/_zp/script-ledger/")) {
    event.respondWith(scriptLedgerResponse(url));
    return;
  }
  if (url.origin === self.location.origin && url.pathname.startsWith("/_zp/api/")) event.respondWith(relayAPIRequest(event.request));
});

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("message", event => {
  const message = event.data;
  if (message?.v !== 2 || message.operation !== "BIND_RUNTIME_PORT" || event.ports.length !== 1) return;
  const runtimePort = event.ports[0];
  runtimePort.start();
  runtimePort.onmessage = runtimeEvent => {
    const command = runtimeEvent.data;
    if (!command || command.v !== 2 || typeof command.operation !== "string") return;
    if (command.operation === "ALLOCATE_RESOURCE_ROUTE") {
      try {
        const target = new URL(command.payload?.target_url);
        let kind, path;
        if (target.pathname === "/script-ledger-classic.js" && command.payload?.resource_kind === "Script") {
          kind = "classic";
          path = "/_zp/script-ledger/classic.js";
        } else if (target.pathname === "/script-ledger-module.js" && command.payload?.resource_kind === "Module") {
          kind = "module";
          path = "/_zp/script-ledger/module.js";
        } else {
          throw new Error("unsupported script route");
        }
        const routeID = crypto.randomUUID();
        resourcePlans.set(path, { kind, target: target.href });
        resourceRoutePaths.set(routeID, path);
        runtimePort.postMessage({ v: 2, request_id: command.request_id, ok: true, result: { path, route_id: routeID, policy_revision: 2, client_bound: true } });
      } catch (error) {
        runtimePort.postMessage({ v: 2, request_id: command.request_id, ok: false, error: `${error?.name}: ${error?.message}` });
      }
      return;
    }
    if (command.operation === "REVOKE_RESOURCE_ROUTE") {
      const path = resourceRoutePaths.get(command.payload?.route_id);
      if (path) resourcePlans.delete(path);
      resourceRoutePaths.delete(command.payload?.route_id);
      runtimePort.postMessage({ v: 2, request_id: command.request_id, ok: true, result: { revoked: Boolean(path) } });
      return;
    }
    if (command.operation === "ALLOCATE_API_PLAN") {
      try {
        const id = crypto.randomUUID();
        const plan = command.payload;
        if (plan.request_kind === "eventsource") plan.mock_lease = id;
        const token = tokenFor(plan);
        plans.set(id, plan);
        apiRequestPlans.set(token, plan);
        if (plan.request_kind === "eventsource") {
          eventSourcePlans.set(token, plan);
          eventSourceTokens.set(id, token);
        }
        runtimePort.postMessage({ v: 2, request_id: command.request_id, ok: true, result: { id, path: `/_zp/api/${token}`, revision: 0, body_handle: plan.body_handle } });
      } catch (error) {
        runtimePort.postMessage({ v: 2, request_id: command.request_id, ok: false, error: `${error?.name}: ${error?.message}` });
      }
      return;
    }
    if (command.operation === "EVENTSOURCE_RECONNECT" || command.operation === "EVENTSOURCE_REVOKE") {
      const plan = plans.get(command.payload?.id), token = eventSourceTokens.get(command.payload?.id);
      if (!plan || !token || plan.request_kind !== "eventsource") {
        runtimePort.postMessage({ v: 2, request_id: command.request_id, ok: false, error: "EVENTSOURCE_LEASE_INVALID" });
        return;
      }
      if (command.operation === "EVENTSOURCE_REVOKE") {
        plans.delete(command.payload.id);
        eventSourcePlans.delete(token);
        apiRequestPlans.delete(token);
        eventSourceTokens.delete(command.payload.id);
      } else {
        plan.headers = plan.headers.filter(([name]) => name.toLowerCase() !== "last-event-id");
        if (plan.last_event_id) plan.headers.push(["Last-Event-ID", plan.last_event_id]);
      }
      runtimePort.postMessage({ v: 2, request_id: command.request_id, ok: true, result: {} });
      return;
    }
    if (command.operation === "OPEN_API_STREAM") {
      const plan = plans.get(command.payload?.id);
      const streamPort = runtimeEvent.ports[0];
      if (!plan || !streamPort || plan.request_kind !== "websocket") {
        streamPort?.postMessage({ v: 2, type: "error" });
        return;
      }
      streamPlan(streamPort, plan, command.payload.id);
    }
  };
  runtimePort.postMessage({ v: 2, operation: "RUNTIME_PORT_READY" });
});
