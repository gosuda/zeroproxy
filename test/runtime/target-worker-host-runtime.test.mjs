import assert from "node:assert/strict";
import test from "node:test";
import { TargetWorkerHostRuntime } from "../../web/sw/target-worker/host-runtime.mjs";
import { moduleImportRecordMatches, normalizeModuleImport } from "../../web/sw/target-worker/validation.mjs";
import { install, installBlocked, installCapabilities, installClassic, installMessage, installModule, installNavigationPreload, messageObservations } from "./fixtures/target-worker-host-module.mjs";

const binding = Object.freeze({
  capability: "capability",
  client_epoch: 1,
  profile_id: "profile",
  registration_id: "registration",
  synthetic_origin: "https://o.example",
  worker_version: "v1",
});
const normalHash = "a".repeat(64);
const blockedHash = "b".repeat(64);
const capabilitiesHash = "c".repeat(64);
const classicHash = "d".repeat(64);
const moduleHash = "e".repeat(64);
const navigationPreloadHash = "f".repeat(64);
const messageHash = "1".repeat(64);

function port() {
  const listeners = [];
  const posted = [];
  const postedTransfers = [];
  return {
    addEventListener(type, listener) { if (type === "message") listeners.push(listener); },
    emit(data) { for (const listener of listeners) listener({ data }); },
    postMessage(message, transfer = []) { posted.push(message); postedTransfers.push(transfer); },
    posted,
    postedTransfers,
    start() {},
  };
}

function flush() { return new Promise((resolve) => setTimeout(resolve, 0)); }

function routeBuilder(kind, routeID, contentID) {
  if (kind === "target-worker") return `/_zp/target-worker-exec/${routeID}.mjs`;
  if (kind === "classic") return `/_zp/wi/${routeID}/${contentID}`;
  throw new DOMException("route rejected", "SecurityError");
}

function hydrateMessage(contentID = normalHash) {
  return {
    v: 1,
    binding,
    graph: {
      graph_hash: "graph-v1",
      resources: [{ hash: contentID, module_url: `/_zp/target-worker-exec/${contentID}.mjs`, url: "https://target.example/sw.js" }],
      type: "classic",
    },
    session_id: "session",
    type: "HYDRATE_WORKER",
  };
}

function runtime() {
  return new TargetWorkerHostRuntime({
    importModule: async (url) => ({ install: url.endsWith(`${blockedHash}.mjs`) ? installBlocked : url.endsWith(`${capabilitiesHash}.mjs`) ? installCapabilities : url.endsWith(`${moduleHash}.mjs`) ? installModule : url.endsWith(`${navigationPreloadHash}.mjs`) ? installNavigationPreload : url.endsWith(`${messageHash}.mjs`) ? installMessage : install }),
    routeBuilder,
  });
}

test("target worker module import records bind the calling module identity and referrer", () => {
  const moduleID = "4".repeat(64);
  assert.deepEqual(normalizeModuleImport({
    module_id: moduleID,
    referrer_url: "https://target.example/sw.mjs",
    specifier: "./dependency.mjs",
  }), {
    moduleID,
    referrerURL: "https://target.example/sw.mjs",
    specifier: "./dependency.mjs",
  });
  assert.throws(
    () => normalizeModuleImport({
      module_id: moduleID,
      referrer_url: "https://target.example/sw.mjs",
      specifier: "./dependency.mjs",
      unbound: true,
    }),
    error => error.name === "SecurityError",
  );
  const expected = {
    abiIdentifier: `__zp_abi_${"a".repeat(48)}`,
    capability: binding.capability,
    clientEpoch: binding.client_epoch,
    entryID: "entry",
    graphID: "graph",
    moduleID,
    now: 1_000,
    originID: "origin",
    profileID: binding.profile_id,
    referrerURL: "https://target.example/sw.mjs",
    tabID: "tab",
  };
  const record = {
    abi_identifier: expected.abiIdentifier,
    capability: expected.capability,
    client_epoch: expected.clientEpoch,
    entry_id: expected.entryID,
    expires_at: 1_001,
    graph_id: expected.graphID,
    kind: "target-worker-module",
    module_id: moduleID,
    module_type: "javascript",
    origin_id: expected.originID,
    profile_id: expected.profileID,
    source: "export default true",
    source_kind: "TargetServiceWorkerModule",
    tab_id: expected.tabID,
    target_url: expected.referrerURL,
  };
  assert.equal(moduleImportRecordMatches(record, expected), true);
  assert.equal(moduleImportRecordMatches({ ...record, module_id: "5".repeat(64) }, expected), false);
  assert.equal(moduleImportRecordMatches({ ...record, target_url: "https://target.example/forged.mjs" }, expected), false);
});

test("dedicated host runtime acknowledges only its exact base capability binding", async () => {
  const privatePort = port();
  runtime().attach(privatePort);
  const baseBinding = {
    capability: binding.capability,
    client_epoch: binding.client_epoch,
    profile_id: binding.profile_id,
    synthetic_origin: binding.synthetic_origin,
  };
  privatePort.emit({
    v: 1,
    type: "HOST_RUNTIME_PING",
    message_id: "ping:1",
    binding: baseBinding,
  });
  await flush();
  assert.deepEqual(privatePort.posted, [{
    v: 1,
    type: "HOST_RUNTIME_PONG",
    reply_to: "ping:1",
    binding: baseBinding,
  }]);
  privatePort.emit({
    v: 1,
    type: "HOST_RUNTIME_PING",
    message_id: "ping:stale",
    binding: { ...baseBinding, capability: "stale" },
  });
  await flush();
  assert.equal(privatePort.posted.length, 1);
});

test("dedicated target host cold-hydrates, signals WORKER_READY, and streams a claimed fetch only on pull credit", async () => {
  const privatePort = port();
  runtime().attach(privatePort);
  privatePort.emit(hydrateMessage());
  await flush();
  assert.equal(privatePort.posted[0].type, "WORKER_READY");
  assert.equal(privatePort.posted[0].binding.capability, binding.capability);

  privatePort.emit({ v: 1, binding, event_id: "fetch", event_type: "fetch", session_id: "session", type: "EVENT_START", dispatch_deadline: Date.now() + 1_000, lifetime_deadline: Date.now() + 2_000 });
  await flush();
  assert.deepEqual(privatePort.posted.slice(1).map((message) => message.type).slice(0, 2), ["RESPOND_WITH_CLAIMED", "DISPATCH_CLOSED"]);
  assert.equal(privatePort.posted.some((message) => message.type === "RESPONSE_HEADERS"), true);
  assert.equal(privatePort.posted.some((message) => message.type === "RESPONSE_CHUNK"), false);

  privatePort.emit({ v: 1, binding, event_id: "fetch", sequence: 0, session_id: "session", type: "STREAM_PULL" });
  await flush();
  assert.equal(privatePort.posted.some((message) => message.type === "RESPONSE_CHUNK"), true);
  assert.equal(privatePort.posted.some((message) => message.type === "RESPONSE_END"), false);
  privatePort.emit({ v: 1, binding, event_id: "fetch", sequence: 1, session_id: "session", type: "STREAM_PULL" });
  await flush();
  assert.equal(privatePort.posted.some((message) => message.type === "RESPONSE_END"), true);
  const responseEnd=privatePort.posted.find(message=>message.type==="RESPONSE_END");
  assert.equal(responseEnd.sequence,1);
  privatePort.emit({v:1,binding,event_id:"fetch",final_wait_seq:0,response_sequence:responseEnd.sequence,session_id:"session",type:"EVENT_COMPLETE"});
  await flush();
  assert.equal(privatePort.posted.some(message=>message.type==="EVENT_FAIL"),false);
});

test("dedicated target host exposes journal-backed navigation preload controls", async () => {
  const privatePort = port();
  runtime().attach(privatePort);
  privatePort.emit(hydrateMessage(navigationPreloadHash));
  await flush();
  privatePort.emit({ v: 1, binding, event_id: "activate-preload", event_type: "activate", session_id: "session", type: "EVENT_START", dispatch_deadline: Date.now() + 1_000, lifetime_deadline: Date.now() + 2_000 });
  let enabled = false;
  let headerValue = "true";
  const seen = [];
  for (const expected of [
    "NAVIGATION_PRELOAD_GET_STATE",
    "NAVIGATION_PRELOAD_SET_HEADER",
    "NAVIGATION_PRELOAD_ENABLE",
    "NAVIGATION_PRELOAD_GET_STATE",
    "NAVIGATION_PRELOAD_DISABLE",
  ]) {
    await flush();
    const command = privatePort.posted.find(message => message.type === "HOST_COMMAND" && !seen.includes(message.message_id));
    assert.equal(command?.command, expected);
    seen.push(command.message_id);
    if (expected === "NAVIGATION_PRELOAD_SET_HEADER") {
      assert.equal(command.payload.value, "worker-v1");
      headerValue = command.payload.value;
    } else if (expected === "NAVIGATION_PRELOAD_ENABLE") enabled = true;
    else if (expected === "NAVIGATION_PRELOAD_DISABLE") enabled = false;
    privatePort.emit({
      v: 1,
      binding,
      ok: true,
      reply_to: command.message_id,
      result: { state: { enabled, header_value: headerValue } },
      session_id: "session",
      type: "HOST_COMMAND_RESULT",
    });
  }
  await flush();
  assert.equal(privatePort.posted.some(message => message.type === "WAIT_UNTIL_SETTLED" && message.outcome === "fulfilled"), true);
  assert.equal(privatePort.posted.some(message => message.type === "LIFETIME_CLOSED" && message.outcome === "fulfilled"), true);
});

test("target message events expose stable Client identity, target URLs, and transferable ports", async () => {
  const privatePort = port();
  messageObservations.length = 0;
  runtime().attach(privatePort);
  privatePort.emit(hydrateMessage(messageHash));
  await flush();
  const channel = new MessageChannel();
  channel.port2.start();
  const directMessage = new Promise(resolve => { channel.port2.onmessage = event => resolve(event.data); });
  privatePort.emit({
    v: 1,
    binding,
    client_id: "client-a",
    dispatch_deadline: Date.now() + 1_000,
    event_id: "message-event",
    event_type: "message",
    lifetime_deadline: Date.now() + 2_000,
    request_plan: { message: { ping: true }, origin: "https://target.example" },
    session_id: "session",
    source_client: { client_id: "client-a", type: "window", url: "https://target.example/app" },
    transfer: [channel.port1],
    type: "EVENT_START",
  });
  assert.deepEqual(await directMessage, { via: "virtual-message-event" });
  await flush();
  assert.deepEqual(messageObservations, [{
    data: { ping: true },
    origin: "https://target.example",
    ports: 1,
    source_id: "client-a",
    source_type: "window",
    source_url: "https://target.example/app",
  }]);
  const commandIndex = privatePort.posted.findIndex(message => message.type === "HOST_COMMAND" && message.command === "CLIENT_POST_MESSAGE");
  const command = privatePort.posted[commandIndex];
  assert.deepEqual(command.payload.message, { echo: { ping: true } });
  assert.equal(command.payload.transfer.length, 1);
  assert.equal(privatePort.postedTransfers[commandIndex][0], command.payload.transfer[0]);
  privatePort.emit({ v: 1, binding, ok: true, reply_to: command.message_id, result: { binding }, session_id: "session", type: "HOST_COMMAND_RESULT" });
  command.payload.transfer[0].close();
  channel.port2.close();
});

test("dedicated target host fails closed and terminates when its compiled graph attempts a blocked capability", async () => {
  const privatePort = port();
  runtime().attach(privatePort);
  privatePort.emit(hydrateMessage(blockedHash));
  await flush();
  assert.equal(privatePort.posted.length, 1);
  assert.equal(privatePort.posted[0].type, "EVENT_FAIL");
  assert.equal(privatePort.posted[0].phase, "host");
});

test("dedicated target host rejects an unclassified executable graph before installation", async () => {
  const privatePort = port();
  runtime().attach(privatePort);
  const hydrate = hydrateMessage();
  hydrate.graph.type = "unclassified";
  privatePort.emit(hydrate);
  await flush();
  assert.equal(privatePort.posted.length, 1);
  assert.equal(privatePort.posted[0].type, "EVENT_FAIL");
  assert.equal(privatePort.posted[0].phase, "host");
});

test("dedicated target host mediates cache, controlled fetch, clients, and lifecycle capabilities over its bound command port", async () => {
  const privatePort = port();
  runtime().attach(privatePort);
  privatePort.emit(hydrateMessage(capabilitiesHash));
  await flush();
  privatePort.emit({ v: 1, binding, event_id: "activate", event_type: "activate", session_id: "session", type: "EVENT_START", dispatch_deadline: Date.now() + 1_000, lifetime_deadline: Date.now() + 2_000 });

  const commands = [];
  for (let attempts = 0; attempts < 12; attempts += 1) {
    await flush();
    const command = privatePort.posted.find(message => message.type === "HOST_COMMAND" && !commands.includes(message.message_id));
    if (!command) break;
    commands.push(command.message_id);
    const client = { client_id: "client-a", type: "window", url: "https://target.example/" };
    const result = command.command === "FETCH"
      ? { response: { body: new Uint8Array([111, 107]), headers: [], status: 200, status_text: "" } }
      : command.command === "CLIENTS_MATCH_ALL"
        ? { clients: [client] }
        : command.command === "CLIENTS_GET" || command.command === "CLIENT_FOCUS"
          ? { client }
          : {};
    privatePort.emit({ v: 1, binding, ok: true, reply_to: command.message_id, result, session_id: "session", type: "HOST_COMMAND_RESULT" });
  }
  await flush();
  assert.deepEqual(commands.map(id => privatePort.posted.find(message => message.message_id === id).command), [
    "CACHE_OPEN",
    "CACHE_PUT",
    "FETCH",
    "CLIENTS_MATCH_ALL",
    "CLIENTS_GET",
    "CLIENT_FOCUS",
    "REGISTRATION_SKIP_WAITING",
  ]);
  assert.equal(privatePort.posted.some(message => message.type === "LIFETIME_CLOSED"), true);
});

test("module target service workers allocate computed imports through the bound host capability", async () => {
  const privatePort = port();
  runtime().attach(privatePort);
  const hydrate = hydrateMessage(moduleHash);
  hydrate.graph.type = "module";
  privatePort.emit(hydrate);
  await flush();
  privatePort.emit({ v: 1, binding, event_id: "install-module", event_type: "install", session_id: "session", type: "EVENT_START", dispatch_deadline: Date.now() + 1_000, lifetime_deadline: Date.now() + 2_000 });
  await flush();
  const command = privatePort.posted.find(message => message.type === "HOST_COMMAND");
  assert.equal(command.command, "MODULE_IMPORT");
  assert.deepEqual(command.payload, {
    module_id: "4".repeat(64),
    referrer_url: "https://target.example/sw.mjs",
    specifier: "./dependency.mjs",
  });
  privatePort.emit({
    v: 1,
    binding,
    ok: true,
    reply_to: command.message_id,
    result: { url: "/_zp/wm/graph/module.mjs" },
    session_id: "session",
    type: "HOST_COMMAND_RESULT",
  });
  await flush();
  assert.equal(privatePort.posted.some(message => message.type === "LIFETIME_CLOSED"), true);
});

test("classic target service workers preserve ordered synchronous importScripts through policy-built lease-bound opaque gateway routes", async () => {
  const privatePort = port();
  const imported = [];
  const built = [];
  new TargetWorkerHostRuntime({
    importModule: async () => ({ install: installClassic }),
    loadGatewaySealer: async () => (key, id, target) => `${key.slice(0, 4)}${id.slice(0, 4)}${target.endsWith("first.js") ? "first" : "second"}`,
    nativeImportScripts: (...urls) => imported.push(urls),
    routeBuilder: (kind, id, token) => {
      built.push({ id, kind, token });
      return kind === "target-worker" ? `/_zp/target-worker-exec/${id}.mjs` : `/_zp/wi/${id}/${token}`;
    },
  }).attach(privatePort);
  const message = hydrateMessage(classicHash);
  message.graph.classic_gateway = { expires_at: Date.now() + 60_000, id: "g".repeat(32), key: "k".repeat(32), lease_generation: 1 };
  privatePort.emit(message);
  await flush();
  assert.deepEqual(built, [
    { id: classicHash, kind: "target-worker", token: null },
    { id: "g".repeat(32), kind: "classic", token: "kkkkggggfirst" },
    { id: "g".repeat(32), kind: "classic", token: "kkkkggggsecond" },
  ]);
  assert.deepEqual(imported, [[
    `/_zp/wi/${"g".repeat(32)}/kkkkggggfirst`,
    `/_zp/wi/${"g".repeat(32)}/kkkkggggsecond`,
  ]]);
  assert.equal(privatePort.posted[0].type, "WORKER_READY");
});

test("unsupported functional APIs reject asynchronously with NotSupportedError and listener registration fails synchronously", async () => {
  const privatePort = port();
  const failures = [];
  let synchronous = false;
  new TargetWorkerHostRuntime({
    importModule: async () => ({
      async install(scope) {
        const operations = [
          () => scope.registration.pushManager.subscribe(),
          () => scope.registration.sync.register(),
          () => scope.registration.periodicSync.register(),
          () => scope.registration.backgroundFetch.fetch(),
          () => scope.registration.showNotification(),
          () => scope.registration.getNotifications(),
          () => scope.registration.paymentManager.enableDelegations(),
        ];
        const promises = operations.map(operation => {
          try {
            return operation();
          } catch (error) {
            synchronous = true;
            throw error;
          }
        });
        failures.push(...(await Promise.allSettled(promises)).map(result => result.reason?.name));
      },
    }),
    routeBuilder,
  }).attach(privatePort);
  privatePort.emit(hydrateMessage());
  await flush();
  assert.equal(synchronous, false);
  assert.deepEqual(failures, Array.from({ length: 7 }, () => "NotSupportedError"));
  assert.equal(privatePort.posted[0]?.type, "WORKER_READY");

  const rejectedPort = port();
  new TargetWorkerHostRuntime({
    importModule: async () => ({ install(scope) { scope.addEventListener("push", () => {}); } }),
    routeBuilder,
  }).attach(rejectedPort);
  rejectedPort.emit(hydrateMessage());
  await flush();
  assert.equal(rejectedPort.posted[0]?.type, "EVENT_FAIL");
  assert.equal(rejectedPort.posted[0]?.code, "NotSupportedError");
  assert.equal(rejectedPort.posted.some(message => message.type === "WORKER_READY"), false);
});

test("target worker executable module URL must bind the policy-issued content digest", async () => {
  const privatePort = port();
  runtime().attach(privatePort);
  const message = hydrateMessage(normalHash);
  message.graph.resources[0].module_url = `/_zp/target-worker-exec/${blockedHash}.mjs`;
  privatePort.emit(message);
  await flush();
  assert.equal(privatePort.posted[0]?.type, "EVENT_FAIL");
});

for (const [name, routeBuilder] of [
  ["is absent", null],
  ["rejects", () => { throw new DOMException("rejected", "SecurityError"); }],
  ["returns a malformed route", () => "/_zp/wmi/forged/route"],
]) {
  test(`classic target service workers fail before importScripts when the policy route builder ${name}`, async () => {
    const privatePort = port();
    const imported = [];
    new TargetWorkerHostRuntime({
      importModule: async () => ({ install: installClassic }),
      loadGatewaySealer: async () => () => "sealed-token",
      nativeImportScripts: (...urls) => imported.push(urls),
      routeBuilder: routeBuilder === null ? null : (kind, id, token) => kind === "target-worker" ? `/_zp/target-worker-exec/${id}.mjs` : routeBuilder(kind, id, token),
    }).attach(privatePort);
    const message = hydrateMessage(classicHash);
    message.graph.classic_gateway = { expires_at: Date.now() + 60_000, id: "g".repeat(32), key: "k".repeat(32), lease_generation: 1 };
    privatePort.emit(message);
    await flush();
    assert.deepEqual(imported, []);
    assert.equal(privatePort.posted[0]?.type, "EVENT_FAIL");
  });
}

test("dedicated target host exposes navigation preload as a transferable response promise", async () => {
  const privatePort = port();
  new TargetWorkerHostRuntime({
    importModule: async () => ({
      install(scope) {
        scope.addEventListener("fetch", event => event.respondWith(event.preloadResponse));
      },
    }),
    routeBuilder,
  }).attach(privatePort);
  privatePort.emit(hydrateMessage());
  await flush();
  privatePort.emit({
    v: 1,
    binding,
    event_id: "preloaded-fetch",
    event_type: "fetch",
    preload_handle: "preload-handle",
    session_id: "session",
    type: "EVENT_START",
    dispatch_deadline: Date.now() + 1_000,
    lifetime_deadline: Date.now() + 2_000,
  });
  await flush();
  const command = privatePort.posted.find(message => message.type === "HOST_COMMAND");
  assert.equal(command.command, "NAVIGATION_PRELOAD");
  assert.deepEqual(command.payload, {
    event_id: "preloaded-fetch",
    preload_handle: "preload-handle",
  });
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("preloaded"));
      controller.close();
    },
  });
  privatePort.emit({
    v: 1,
    binding,
    ok: true,
    reply_to: command.message_id,
    result: { response: { body, headers: [["content-type", "text/plain"]], status: 200, status_text: "OK" } },
    session_id: "session",
    type: "HOST_COMMAND_RESULT",
  });
  await flush();
  assert.equal(privatePort.posted.some(message => message.type === "RESPONSE_HEADERS"), true);
  privatePort.emit({ v: 1, binding, event_id: "preloaded-fetch", sequence: 0, session_id: "session", type: "STREAM_PULL" });
  await flush();
  const chunk = privatePort.posted.find(message => message.type === "RESPONSE_CHUNK");
  assert.equal(new TextDecoder().decode(chunk.bytes), "preloaded");
  privatePort.emit({ v: 1, binding, event_id: "preloaded-fetch", sequence: 1, session_id: "session", type: "STREAM_PULL" });
  await flush();
  assert.equal(privatePort.posted.find(message => message.type === "RESPONSE_END")?.sequence, 1);
});
