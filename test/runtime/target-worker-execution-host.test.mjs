import assert from "node:assert/strict";
import test from "node:test";
import { createTargetWorkerBroker, createTargetWorkerExecutionHost, initialJournalState } from "../../web/sw/target-worker/index.mjs";

const binding = Object.freeze({ capability: "capability-a", client_epoch: 3, profile_id: "profile-a", synthetic_origin: "https://o.example" });
const versionBinding = Object.freeze({ ...binding, registration_id: "registration", worker_version: "v1" });

function flush() { return new Promise((resolve) => setTimeout(resolve, 0)); }

function privatePort() {
  const listeners = [];
  const posted = [];
  const transfers = [];
  return {
    addEventListener(type, listener) { if (type === "message") listeners.push(listener); },
    close() { this.closed = true; },
    emit(data) { for (const listener of listeners) listener({ data }); },
    postMessage(message, transfer = []) { posted.push(message); transfers.push(transfer); },
    posted,
    start() { this.started = true; },
    transfers,
  };
}

function setup({ limits } = {}) {
  const port = privatePort();
  const journalCalls = [];
  const compilerCalls = [];
  const host = createTargetWorkerExecutionHost({
    binding,
    compiler: {
      async rewriteGraph(message) {
        compilerCalls.push(message);
        return { graph_hash: message.graph.graph_hash, rewritten: { kind: "TargetServiceWorkerClassic", url: "https://target.example/sw.js" } };
      },
    },
    journal: {
      async hydrateVersion(message) {
        journalCalls.push(message);
        return { binding: message.binding, graph_hash: message.graph_hash };
      },
    },
    limits,
    privatePort: port,
    sessionID: () => "session-1",
  });
  return { compilerCalls, host, journalCalls, port };
}

test("execution host reports ready only after an exact bound runtime heartbeat", async () => {
  const { host, port } = setup();
  const ready = host.ping();
  const ping = port.posted.at(-1);
  assert.equal(ping.type, "HOST_RUNTIME_PING");
  assert.deepEqual(ping.binding, binding);
  port.emit({
    v: 1,
    type: "HOST_RUNTIME_PONG",
    reply_to: ping.message_id,
    binding,
  });
  assert.deepEqual(await ready, { binding });

  const unavailable = setup({ limits: { host_ping_timeout_ms: 1 } });
  await assert.rejects(unavailable.host.ping(), error => error?.name === "TimeoutError");
  unavailable.host.close();
});

test("execution host hydrates the durable graph through compiler callbacks and forwards only bound worker protocol", async () => {
  const { compilerCalls, host, journalCalls, port } = setup();
  const received = [];
  host.attachBroker({
    async receiveWorkerMessage(message) { received.push(message); },
  });
  const session = await host.host.hydrate({
    v: 1,
    binding: versionBinding,
    graph: { graph_hash: "graph-v1", resources: [{ hash: "source", url: "https://target.example/sw.js" }] },
    type: "HYDRATE_WORKER",
  });
  assert.deepEqual(session, { binding: versionBinding, graph_hash: "graph-v1", session_id: "session-1" });
  assert.equal(journalCalls[0].type, "TARGET_WORKER_HYDRATE_VERSION");
  assert.equal(compilerCalls[0].type, "TARGET_SERVICE_WORKER_REWRITE");
  assert.equal(port.posted[0].type, "HYDRATE_WORKER");
  assert.equal(port.posted[0].binding.capability, binding.capability);

  port.emit({
    v: 1,
    binding: versionBinding,
    graph_hash: "graph-v1",
    message_id: "ready",
    registration_id: "registration",
    session_id: "session-1",
    type: "WORKER_READY",
    worker_version: "v1",
  });
  await flush();
  assert.equal(received.length, 1);
  assert.equal(received[0].type, "WORKER_READY");

  await host.host.send({
    v: 1,
    binding: versionBinding,
    event_id: "event",
    event_type: "fetch",
    dispatch_deadline: 100,
    lifetime_deadline: 200,
    session_id: "session-1",
    type: "EVENT_START",
  });
  assert.equal(port.posted.at(-1).type, "EVENT_START");
  port.emit({
    v: 1,
    binding: { ...versionBinding, capability: "stale" },
    event_id: "event",
    message_id: "bad",
    registration_id: "registration",
    session_id: "session-1",
    type: "NO_RESPONSE",
    worker_version: "v1",
  });
  await flush();
  assert.equal(received.length, 1);
  assert.equal(port.posted.at(-1).type, "HOST_REJECT");
});

test("controlled client commands are capability-bound, request-idempotent, and reject stale replies", async () => {
  const { host, port } = setup();
  const command = {
    v: 1,
    binding: versionBinding,
    capability: binding.capability,
    client_id: "client",
    client_revision: 4,
    message_id: "focus:1",
    type: "CLIENT_FOCUS",
  };
  const pending = host.clientCommands.command(command);
  assert.equal(port.posted.at(-1).type, "CLIENT_COMMAND");
  assert.equal(port.posted.at(-1).command, "CLIENT_FOCUS");
  port.emit({
    v: 1,
    binding: versionBinding,
    ok: true,
    reply_to: "focus:1",
    result: { binding: versionBinding, focused: true },
    type: "CLIENT_COMMAND_RESULT",
  });
  assert.deepEqual(await pending, { binding: versionBinding, focused: true });
  const posted = port.posted.length;
  assert.deepEqual(await host.clientCommands.command(command), { binding: versionBinding, focused: true });
  assert.equal(port.posted.length, posted);

  const channel = new MessageChannel();
  const transferred = {
    ...command,
    message: { port: channel.port1 },
    message_id: "message:1",
    transfer: [channel.port1],
    type: "CLIENT_POST_MESSAGE",
  };
  const messagePending = host.clientCommands.command(transferred, [channel.port1]);
  assert.equal(port.posted.at(-1).command, "CLIENT_POST_MESSAGE");
  assert.equal(port.transfers.at(-1)[0], channel.port1);
  port.emit({
    v: 1,
    binding: versionBinding,
    ok: true,
    reply_to: "message:1",
    result: { binding: versionBinding, posted: true },
    type: "CLIENT_COMMAND_RESULT",
  });
  assert.deepEqual(await messagePending, { binding: versionBinding, posted: true });
  channel.port1.close();
  channel.port2.close();

  const stale = host.clientCommands.command({ ...command, message_id: "focus:2" });
  port.emit({
    v: 1,
    binding: versionBinding,
    ok: true,
    reply_to: "focus:2",
    result: { binding: { ...versionBinding, capability: "stale" }, focused: true },
    type: "CLIENT_COMMAND_RESULT",
  });
  await assert.rejects(() => stale, (error) => error.name === "SecurityError");
  await assert.rejects(() => host.clientCommands.command({ ...command, capability: "wrong", message_id: "bad-capability" }), (error) => error.name === "SecurityError");
});

test("execution host replacement closes the attached broker and private channel", () => {
  const { host, port } = setup();
  let closes = 0;
  host.attachBroker({
    close() { closes += 1; },
    async receiveWorkerMessage() {},
  });
  host.close();
  assert.equal(closes, 1);
  assert.equal(port.closed, true);
});

test("root adapter claims native fetch synchronously, routes lifecycle events, and rejects unsupported functional events", async () => {
  const { host } = setup();
  const calls = [];
  const lifecycle = [];
  host.attachBroker({
    admitNativeFetch(nativeEvent, dispatch) {
      calls.push({ dispatch, nativeEvent });
      nativeEvent.respondWith(Promise.resolve(new Response("controlled")));
      nativeEvent.waitUntil(Promise.resolve());
      return { lifetime: Promise.resolve(), response: Promise.resolve(new Response("controlled")) };
    },
    dispatchLifecycle(input) {
      lifecycle.push(input);
      return Promise.resolve({ event_type: input.event_type });
    },
    async receiveWorkerMessage() {},
  });
  const fetchNative = {
    respondWith(value) { this.response = value; },
    waitUntil(value) { this.lifetime = value; },
  };
  const dispatch = { event_id: "fetch", request_plan: {}, url: "https://target.example/data" };
  const returned = host.dispatchRootEvent({ dispatch, event_type: "fetch", native_event: fetchNative });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].nativeEvent, fetchNative);
  assert.equal(fetchNative.response instanceof Promise, true);
  await returned;

  for (const event_type of ["install", "activate", "message"]) {
    let waited = null;
    const nativeEvent = { waitUntil(value) { waited = value; } };
    const result = host.dispatchRootEvent({ dispatch: { event_id: event_type, operation_id: event_type, registration_id: "registration", worker_version: "v1" }, event_type, native_event: nativeEvent });
    assert.equal(waited instanceof Promise, true);
    assert.deepEqual(await result, { event_type });
  }
  assert.deepEqual(lifecycle.map((entry) => entry.event_type), ["install", "activate", "message"]);
  for (const event_type of ["sync", "push", "notificationclick", "paymentrequest", "backgroundfetchsuccess"]) {
    await assert.rejects(
      () => host.dispatchRootEvent({ dispatch, event_type }),
      error => error.name === "NotSupportedError",
    );
  }
});

test("execution host is directly usable as the broker host/client boundary without root-SW wiring", async () => {
  let revision = 0;
  let state = initialJournalState(binding);
  const durableJournal = {
    async compareAndSwap(message) {
      if (message.expected_revision !== revision) return { applied: false, revision, state: structuredClone(state) };
      state = structuredClone(message.state);
      revision += 1;
      return { applied: true, revision, state: structuredClone(state) };
    },
    async hydrateVersion(message) { return { binding: message.binding, graph_hash: message.graph_hash }; },
    async load() { return { revision, state: structuredClone(state) }; },
  };
  const port = privatePort();
  const executionHost = createTargetWorkerExecutionHost({
    binding,
    compiler: { async rewriteGraph(message) { return { graph_hash: message.graph.graph_hash, source_kind: "TargetServiceWorkerClassic" }; } },
    journal: durableJournal,
    privatePort: port,
    sessionID: () => "broker-session",
  });
  const broker = createTargetWorkerBroker({
    binding,
    controlledFetch: async () => new Response("controlled-fallback"),
    host: executionHost.host,
    journal: durableJournal,
    targetOrigin: "https://target.example",
  });
  executionHost.attachBroker(broker);
  const graph = { graph_hash: "graph-v1", resources: [{ hash: "resource-v1", url: "https://target.example/sw.js" }] };
  await broker.register({ graph, operation_id: "register", registration_id: "registration", scope_url: "https://target.example/", script_url: "https://target.example/sw.js", worker_version: "v1" });
  await broker.completeInstall({ operation_id: "install", registration_id: "registration", success: true, worker_version: "v1" });
  await broker.beginActivation({ operation_id: "begin", registration_id: "registration", worker_version: "v1" });
  await broker.completeActivation({ operation_id: "activate", registration_id: "registration", success: true, worker_version: "v1" });
  const dispatch = broker.startFetch({ event_id: "fetch", request_plan: {}, url: "https://target.example/data" });
  await flush();
  assert.equal(port.posted.at(-1).type, "HYDRATE_WORKER");
  port.emit({
    v: 1,
    binding: versionBinding,
    graph_hash: "graph-v1",
    message_id: "ready",
    registration_id: "registration",
    session_id: "broker-session",
    type: "WORKER_READY",
    worker_version: "v1",
  });
  await flush();
  assert.equal(port.posted.at(-1).type, "EVENT_START");
  port.emit({
    v: 1,
    binding: versionBinding,
    event_id: "fetch",
    message_id: "no-response",
    registration_id: "registration",
    session_id: "broker-session",
    type: "NO_RESPONSE",
    worker_version: "v1",
  });
  assert.equal(await (await dispatch.response).text(), "controlled-fallback");
});

test("execution host routes host capability commands only through the injected bound dispatcher", async () => {
  const port = privatePort();
  const calls = [];
  const host = createTargetWorkerExecutionHost({
    binding,
    capabilities: {
      async dispatch(message) {
        calls.push(message);
        return { response: { body: new Uint8Array([111, 107]), headers: [], status: 200, status_text: "" } };
      },
    },
    compiler: { async rewriteGraph(message) { return { graph_hash: message.graph.graph_hash, resources: [{ module_url: "/_zp/target-worker-exec/a.mjs" }] }; } },
    journal: { async hydrateVersion(message) { return { binding: message.binding, graph_hash: message.graph_hash }; } },
    privatePort: port,
    sessionID: () => "command-session",
  });
  host.attachBroker({
    async receiveWorkerMessage() {},
    async claim() { throw new Error("not expected"); },
  });
  await host.host.hydrate({
    v: 1,
    binding: versionBinding,
    graph: { graph_hash: "graph-v1", resources: [{ hash: "source", url: "https://target.example/sw.js" }] },
    type: "HYDRATE_WORKER",
  });
  port.emit({
    v: 1,
    binding: versionBinding,
    command: "FETCH",
    message_id: "host-fetch",
    payload: { request: { body: null, credentials: "include", headers: [], method: "GET", mode: "cors", redirect: "follow", url: "https://target.example/data" } },
    registration_id: "registration",
    session_id: "command-session",
    type: "HOST_COMMAND",
    worker_version: "v1",
  });
  await flush();
  assert.deepEqual(calls, [{
    binding: versionBinding,
    command: "FETCH",
    message_id: "host-fetch",
    payload: { request: { body: null, credentials: "include", headers: [], method: "GET", mode: "cors", redirect: "follow", url: "https://target.example/data" } },
  }]);
  assert.equal(port.posted.at(-1).type, "HOST_COMMAND_RESULT");
  assert.equal(port.posted.at(-1).ok, true);
  assert.equal(port.posted.at(-1).result.response.status, 200);

  port.emit({ ...port.posted.at(-1), binding: { ...versionBinding, capability: "stale" }, message_id: "stale-host-fetch", reply_to: undefined, type: "HOST_COMMAND", command: "FETCH" });
  await flush();
  assert.equal(port.posted.at(-1).type, "HOST_COMMAND_RESULT");
  assert.equal(port.posted.at(-1).ok, false);
  assert.equal(calls.length, 1);
});

test("execution host transfers a bound navigation preload stream exactly once", async () => {
  const { host, port } = setup();
  const consumed = [];
  host.attachBroker({
    async consumePreload(input) {
      consumed.push(input);
      return new Response("preloaded", { headers: { "content-type": "text/plain" } });
    },
    async receiveWorkerMessage() {},
  });
  await host.host.hydrate({
    v: 1,
    binding: versionBinding,
    graph: { graph_hash: "graph-v1", resources: [{ hash: "source", url: "https://target.example/sw.js" }] },
    type: "HYDRATE_WORKER",
  });
  port.emit({
    v: 1,
    binding: versionBinding,
    command: "NAVIGATION_PRELOAD",
    message_id: "preload-command",
    payload: { event_id: "fetch", preload_handle: "preload-handle" },
    registration_id: "registration",
    session_id: "session-1",
    type: "HOST_COMMAND",
    worker_version: "v1",
  });
  await flush();
  const reply = port.posted.at(-1);
  assert.deepEqual(consumed, [{
    event_id: "fetch",
    preload_handle: "preload-handle",
    registration_id: "registration",
    worker_version: "v1",
  }]);
  assert.equal(reply.type, "HOST_COMMAND_RESULT");
  assert.equal(reply.ok, true);
  assert.equal(port.transfers.at(-1).length, 1);
  assert.equal(port.transfers.at(-1)[0], reply.result.response.body);
  assert.equal(await new Response(reply.result.response.body).text(), "preloaded");
});
