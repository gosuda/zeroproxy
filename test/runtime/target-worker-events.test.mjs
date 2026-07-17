import assert from "node:assert/strict";
import test from "node:test";
import { createTargetWorkerBroker, dispatchVirtualEvent, initialJournalState } from "../../web/sw/target-worker/index.mjs";

const binding = Object.freeze({ capability: "capability-a", client_epoch: 1, profile_id: "profile-a", synthetic_origin: "https://o.example" });
const targetOrigin = "https://target.example";

function graph(hash) {
  return { graph_hash: hash, resources: [{ hash: `${hash}:resource`, url: "https://target.example/sw.js" }] };
}

function memoryJournal() {
  let revision = 0;
  let state = initialJournalState(binding);
  return {
    async compareAndSwap(message) {
      if (message.expected_revision !== revision) return { applied: false, revision, state: structuredClone(state) };
      state = structuredClone(message.state);
      revision += 1;
      return { applied: true, revision, state: structuredClone(state) };
    },
    async load() { return { revision, state: structuredClone(state) }; },
  };
}

function host() {
  const messages = [];
  return {
    async hydrate(message) {
      messages.push(message);
      return { binding: message.binding, graph_hash: message.graph.graph_hash, session_id: "session-v1" };
    },
    async send(message) { messages.push(message); },
    messages,
  };
}

function flush() { return new Promise((resolve) => setTimeout(resolve, 0)); }

async function active(broker) {
  await broker.register({
    graph: graph("v1"), operation_id: "register", registration_id: "registration", scope_url: "https://target.example/", script_url: "https://target.example/sw.js", worker_version: "v1",
  });
  await broker.completeInstall({ operation_id: "install", registration_id: "registration", success: true, worker_version: "v1" });
  await broker.beginActivation({ operation_id: "begin", registration_id: "registration", worker_version: "v1" });
  await broker.completeActivation({ operation_id: "activate", registration_id: "registration", success: true, worker_version: "v1" });
}

function workerEnvelope(type, messageID, fields = {}) {
  return {
    v: 1,
    binding: { ...binding, registration_id: "registration", worker_version: "v1" },
    message_id: messageID,
    registration_id: "registration",
    session_id: "session-v1",
    type,
    worker_version: "v1",
    ...fields,
  };
}

async function ready(broker, hostPort) {
  await flush();
  assert.equal(hostPort.messages.find((message) => message.type === "HYDRATE_WORKER")?.type, "HYDRATE_WORKER");
  await broker.receiveWorkerMessage(workerEnvelope("WORKER_READY", "ready", { graph_hash: "v1" }));
  await flush();
  assert.equal(hostPort.messages.find((message) => message.type === "EVENT_START")?.type, "EVENT_START");
}

function makeBroker(fallbacks = [], options = {}) {
  const hostPort = options.host ?? host();
  const broker = createTargetWorkerBroker({
    binding,
    controlledFetch: async (request) => {
      fallbacks.push(request.reason);
      return new Response(`fallback:${request.reason}`);
    },
    host: hostPort,
    journal: options.journal ?? memoryJournal(),
    limits: { max_stream_chunks: 8, ...options.limits },
    targetOrigin,
  });
  return { broker, fallbacks, hostPort };
}

test("broker reports control only for an active matching registration", async () => {
  const { broker } = makeBroker();
  assert.equal(await broker.controlsFetch({ client_id: "client", url: "https://target.example/page" }), false);
  await active(broker);
  assert.equal(await broker.controlsFetch({ client_id: "client", url: "https://target.example/page" }), true);
});

test("native fetch admission claims response then lifetime synchronously before hydration", async () => {
  const { broker, hostPort } = makeBroker();
  await active(broker);
  const trace = [];
  const nativeEvent = {
    respondWith(value) { trace.push("respondWith"); this.response = value; },
    waitUntil(value) { trace.push("waitUntil"); this.lifetime = value; },
  };
  const dispatch = broker.admitNativeFetch(nativeEvent, {
    event_id: "native-admission",
    request_plan: {},
    url: "https://target.example/native",
  });
  assert.deepEqual(trace, ["respondWith", "waitUntil"]);
  assert.equal(nativeEvent.response, dispatch.response);
  assert.equal(nativeEvent.lifetime, dispatch.lifetime);
  await ready(broker, hostPort);
  await broker.receiveWorkerMessage(workerEnvelope("NO_RESPONSE", "native-none", { event_id: "native-admission" }));
  await broker.receiveWorkerMessage(workerEnvelope("DISPATCH_CLOSED", "native-dispatch", { event_id: "native-admission", max_wait_seq: 0, pending_count: 0 }));
  await broker.receiveWorkerMessage(workerEnvelope("LIFETIME_CLOSED", "native-lifetime", { event_id: "native-admission", final_wait_seq: 0, outcome: "fulfilled" }));
  assert.equal(await (await dispatch.response).text(), "fallback:NO_RESPONSE");
  await dispatch.lifetime;
});

test("worker facade emits same-task claims, rejects late respondWith, and sequences waitUntil exactly once", async () => {
  const messages = [];
  let late;
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const dispatched = dispatchVirtualEvent({ send: (message) => messages.push(message) }, {
    v: 1, event_id: "virtual-event", event_type: "fetch", registration_id: "registration", worker_version: "v1", client_id: "client", resulting_client_id: "resulting", request_plan: { method: "GET" }, preload_handle: "preload", dispatch_deadline: 100, lifetime_deadline: 200,
  }, [
    (event) => {
      assert.deepEqual({
        clientId: event.clientId,
        preloadHandle: event.preloadHandle,
        requestPlan: event.requestPlan,
        resultingClientId: event.resultingClientId,
      }, {
        clientId: "client",
        preloadHandle: "preload",
        requestPlan: { method: "GET" },
        resultingClientId: "resulting",
      });
      late = event;
      event.respondWith(new Response(null, { status: 204 }));
      event.waitUntil(first, "first");
      queueMicrotask(() => event.waitUntil(Promise.resolve(), "second"));
    },
  ]);
  assert.equal(messages[0].type, "RESPOND_WITH_CLAIMED");
  assert.throws(() => late.respondWith(new Response()), (error) => error.name === "InvalidStateError");
  await flush();
  assert.equal(messages.find((message) => message.type === "RESPONSE_END")?.sequence, 0);
  assert.deepEqual(messages.filter((message) => message.type === "WAIT_UNTIL_ADD").map((message) => [message.wait_seq, message.pending_count]), [[1, 1], [2, 2]]);
  resolveFirst();
  await dispatched.lifetime;
  const settled = messages.filter((message) => message.type === "WAIT_UNTIL_SETTLED");
  assert.deepEqual(settled.map((message) => [message.wait_seq, message.pending_count]), [[2, 1], [1, 0]]);
  assert.equal(messages.filter((message) => message.type === "LIFETIME_CLOSED").length, 1);
  assert.throws(() => late.waitUntil(Promise.resolve()), (error) => error.name === "InvalidStateError");
});

test("navigation preload is acquired lazily once and can directly claim the virtual fetch", async () => {
  const messages = [];
  const acquisitions = [];
  let first;
  const dispatched = dispatchVirtualEvent({
    preloadResponse: async input => {
      acquisitions.push(input);
      return new Response("preloaded");
    },
    send: message => messages.push(message),
  }, {
    v: 1,
    event_id: "preload-facade",
    event_type: "fetch",
    registration_id: "registration",
    worker_version: "v1",
    preload_handle: "preload-handle",
    dispatch_deadline: 100,
    lifetime_deadline: 200,
  }, [
    event => {
      first = event.preloadResponse;
      assert.equal(event.preloadResponse, first);
      event.respondWith(first);
    },
  ]);
  assert.equal(acquisitions.length, 0);
  await flush();
  assert.deepEqual(acquisitions, [{ event_id: "preload-facade", preload_handle: "preload-handle" }]);
  assert.equal(messages[0].type, "RESPOND_WITH_CLAIMED");
  assert.equal(messages.find(message => message.type === "RESPONSE_HEADERS")?.response_plan.body_present, true);
  assert.equal(messages.some(message => message.type === "RESPONSE_END"), true);
  await dispatched.lifetime;
});

test("waitUntil rejection settles the counted gate before one rejected lifetime closure", async () => {
  const messages = [];
  const dispatched = dispatchVirtualEvent({ send: message => messages.push(message) }, {
    v: 1,
    event_id: "rejected-lifetime",
    event_type: "message",
    registration_id: "registration",
    worker_version: "v1",
    dispatch_deadline: 100,
    lifetime_deadline: 200,
  }, [
    event => event.waitUntil(Promise.reject(new Error("rejected")), "rejected"),
  ]);
  await assert.rejects(() => dispatched.lifetime, error => error.name === "OperationError");
  assert.deepEqual(messages.map(message => message.type), [
    "WAIT_UNTIL_ADD",
    "NO_RESPONSE",
    "DISPATCH_CLOSED",
    "WAIT_UNTIL_SETTLED",
    "LIFETIME_CLOSED",
  ]);
  assert.deepEqual(
    messages.filter(message => message.type === "WAIT_UNTIL_SETTLED" || message.type === "LIFETIME_CLOSED")
      .map(message => ({ outcome: message.outcome, pending_count: message.pending_count })),
    [
      { outcome: "rejected", pending_count: 0 },
      { outcome: "rejected", pending_count: undefined },
    ],
  );
});

test("waitUntil closes only at its checkpoint and rejects additions once no registered promise remains", async () => {
  const checkpoints = [];
  const messages = [];
  let event;
  const dispatched = dispatchVirtualEvent({
    queueMicrotask: checkpoint => checkpoints.push(checkpoint),
    send: message => messages.push(message),
  }, {
    v: 1,
    event_id: "checkpoint",
    event_type: "message",
    registration_id: "registration",
    worker_version: "v1",
    dispatch_deadline: 100,
    lifetime_deadline: 200,
  }, [
    value => {
      event = value;
      value.waitUntil(Promise.resolve(), "resolved");
    },
  ]);
  await flush();
  assert.equal(checkpoints.length, 1);
  assert.equal(messages.some(message => message.type === "LIFETIME_CLOSED"), false);
  assert.throws(() => event.waitUntil(Promise.resolve()), error => error.name === "InvalidStateError");
  checkpoints.shift()();
  assert.deepEqual(await dispatched.lifetime, { final_wait_seq: 1, outcome: "fulfilled" });
  assert.equal(messages.filter(message => message.type === "LIFETIME_CLOSED").length, 1);
});

test("broker hydrates cold workers, requires WORKER_READY, and converts a claimed stream with one-chunk backpressure", async () => {
  const { broker, hostPort } = makeBroker();
  await active(broker);
  const dispatch = broker.startFetch({ event_id: "event", request_plan: { method: "GET" }, url: "https://target.example/data" });
  await ready(broker, hostPort);
  await broker.receiveWorkerMessage(workerEnvelope("RESPOND_WITH_CLAIMED", "claim", { event_id: "event" }));
  assert.equal(dispatch.claimed, true);
  await broker.receiveWorkerMessage(workerEnvelope("RESPONSE_HEADERS", "headers", {
    event_id: "event", response_plan: { body_present: true, headers: [["content-type", "text/plain"]], status: 200, status_text: "OK" },
  }));
  const response = await dispatch.response;
  await broker.receiveWorkerMessage(workerEnvelope("RESPONSE_CHUNK", "chunk-0", { bytes: new TextEncoder().encode("one"), event_id: "event", sequence: 0 }));
  await assert.rejects(
    () => broker.receiveWorkerMessage(workerEnvelope("RESPONSE_CHUNK", "chunk-1", { bytes: new TextEncoder().encode("two"), event_id: "event", sequence: 1 })),
    (error) => error.name === "QuotaExceededError",
  );
  await assert.rejects(() => response.text(), (error) => error.name === "NetworkError");
  assert.equal(hostPort.messages.some((message) => message.type === "STREAM_CANCEL"), true);
});

test("broker validates protocol versions and completes only after exact response and lifetime sequences", async () => {
  const { broker, hostPort } = makeBroker();
  await active(broker);
  const dispatch = broker.startFetch({ event_id: "complete", request_plan: {}, url: "https://target.example/complete" });
  await ready(broker, hostPort);
  await assert.rejects(
    () => broker.receiveWorkerMessage({ ...workerEnvelope("NO_RESPONSE", "old-version", { event_id: "complete" }), v: 2 }),
    error => error.name === "SecurityError",
  );
  await broker.receiveWorkerMessage(workerEnvelope("RESPOND_WITH_CLAIMED", "complete-claim", { event_id: "complete" }));
  await broker.receiveWorkerMessage(workerEnvelope("RESPONSE_HEADERS", "complete-headers", {
    event_id: "complete",
    response_plan: { body_present: false, headers: [], status: 204, status_text: "No Content" },
  }));
  await assert.rejects(
    () => broker.receiveWorkerMessage(workerEnvelope("RESPONSE_END", "bad-end", { event_id: "complete", sequence: 1 })),
    error => error.name === "SecurityError",
  );
  assert.deepEqual(
    await broker.receiveWorkerMessage(workerEnvelope("RESPONSE_END", "complete-end", { event_id: "complete", sequence: 0 })),
    { ended: true, sequence: 0 },
  );
  await broker.receiveWorkerMessage(workerEnvelope("DISPATCH_CLOSED", "complete-dispatch", { event_id: "complete", max_wait_seq: 0, pending_count: 0 }));
  await broker.receiveWorkerMessage(workerEnvelope("LIFETIME_CLOSED", "complete-lifetime", { event_id: "complete", final_wait_seq: 0, outcome: "fulfilled" }));
  assert.equal((await dispatch.response).status, 204);
  await dispatch.lifetime;
  await flush();
  assert.deepEqual(
    hostPort.messages.filter(message => message.type === "EVENT_COMPLETE").map(message => ({
      event_id: message.event_id,
      final_wait_seq: message.final_wait_seq,
      response_sequence: message.response_sequence,
      v: message.v,
    })),
    [{ event_id: "complete", final_wait_seq: 0, response_sequence: 0, v: 1 }],
  );
});

test("broker rejects body-bearing null-body response statuses before construction", async () => {
  const { broker, hostPort } = makeBroker();
  await active(broker);
  const dispatch = broker.startFetch({ event_id: "invalid-null-body", request_plan: {}, url: "https://target.example/invalid-null-body" });
  await ready(broker, hostPort);
  await broker.receiveWorkerMessage(workerEnvelope("RESPOND_WITH_CLAIMED", "invalid-null-body-claim", { event_id: "invalid-null-body" }));
  await assert.rejects(() => broker.receiveWorkerMessage(workerEnvelope("RESPONSE_HEADERS", "invalid-null-body-headers", {
    event_id: "invalid-null-body",
    response_plan: { body_present: true, headers: [], status: 204, status_text: "No Content" },
  })), error => error.name === "TypeError");
  await assert.rejects(() => dispatch.response, error => error.name === "NetworkError");
});

test("broker keeps rejected waitUntil independent from an unclaimed controlled response", async () => {
  const { broker, hostPort } = makeBroker();
  await active(broker);
  const dispatch = broker.startFetch({ event_id: "rejected-wait", request_plan: {}, url: "https://target.example/rejected-wait" });
  await ready(broker, hostPort);
  await broker.receiveWorkerMessage(workerEnvelope("WAIT_UNTIL_ADD", "rejected-add", {
    event_id: "rejected-wait",
    pending_count: 1,
    promise_id: "wait",
    wait_seq: 1,
  }));
  await broker.receiveWorkerMessage(workerEnvelope("NO_RESPONSE", "rejected-none", { event_id: "rejected-wait" }));
  await broker.receiveWorkerMessage(workerEnvelope("DISPATCH_CLOSED", "rejected-dispatch", {
    event_id: "rejected-wait",
    max_wait_seq: 1,
    pending_count: 1,
  }));
  await broker.receiveWorkerMessage(workerEnvelope("WAIT_UNTIL_SETTLED", "rejected-settled", {
    event_id: "rejected-wait",
    outcome: "rejected",
    pending_count: 0,
    promise_id: "wait",
    wait_seq: 1,
  }));
  await broker.receiveWorkerMessage(workerEnvelope("LIFETIME_CLOSED", "rejected-lifetime", {
    event_id: "rejected-wait",
    final_wait_seq: 1,
    outcome: "rejected",
  }));
  assert.equal(await (await dispatch.response).text(), "fallback:NO_RESPONSE");
  await assert.rejects(() => dispatch.lifetime, error => error.name === "OperationError");
  await flush();
  assert.equal(hostPort.messages.some(message => message.type === "EVENT_COMPLETE"), false);
  assert.deepEqual(
    hostPort.messages.filter(message => message.type === "EVENT_FAIL").map(message => [message.phase, message.code]),
    [["lifetime", "WAIT_UNTIL_REJECTED"]],
  );
});

test("pre-claim worker crashes use controlled fallback while post-claim crashes are terminal", async () => {
  const pre = makeBroker();
  await active(pre.broker);
  const preDispatch = pre.broker.startFetch({ event_id: "pre", request_plan: {}, url: "https://target.example/pre" });
  await ready(pre.broker, pre.hostPort);
  assert.equal(preDispatch.claimed, false);
  await pre.broker.crashWorker({ registration_id: "registration", worker_version: "v1" });
  assert.equal(await (await preDispatch.response).text(), "fallback:execution worker crashed");
  assert.deepEqual(pre.fallbacks, ["execution worker crashed"]);

  const post = makeBroker();
  await active(post.broker);
  const postDispatch = post.broker.startFetch({ event_id: "post", request_plan: {}, url: "https://target.example/post" });
  await ready(post.broker, post.hostPort);
  await post.broker.receiveWorkerMessage(workerEnvelope("RESPOND_WITH_CLAIMED", "post-claim", { event_id: "post" }));
  assert.equal(postDispatch.claimed, true);
  await post.broker.crashWorker({ registration_id: "registration", worker_version: "v1" });
  await assert.rejects(() => postDispatch.response, (error) => error.name === "NetworkError");
  assert.deepEqual(post.fallbacks, []);
});

test("dispatch claim state separates fallback failures from claimed response failures", async () => {
  const failing = () => {
    const hostPort=host();
    const broker=createTargetWorkerBroker({
      binding,
      controlledFetch:async()=>{throw new DOMException("controlled transport failed","NetworkError")},
      host:hostPort,
      journal:memoryJournal(),
      targetOrigin,
    });
    return {broker,hostPort};
  };

  const noResponse=failing();
  await active(noResponse.broker);
  const unclaimed=noResponse.broker.startFetch({event_id:"fallback-failed",request_plan:{},url:"https://target.example/fallback-failed"});
  await ready(noResponse.broker,noResponse.hostPort);
  await noResponse.broker.receiveWorkerMessage(workerEnvelope("NO_RESPONSE","fallback-failed-none",{event_id:"fallback-failed"}));
  await noResponse.broker.receiveWorkerMessage(workerEnvelope("DISPATCH_CLOSED","fallback-failed-dispatch",{event_id:"fallback-failed",max_wait_seq:0,pending_count:0}));
  await noResponse.broker.receiveWorkerMessage(workerEnvelope("LIFETIME_CLOSED","fallback-failed-lifetime",{event_id:"fallback-failed",final_wait_seq:0,outcome:"fulfilled"}));
  assert.equal(unclaimed.claimed,false);
  await assert.rejects(()=>unclaimed.response,error=>error.name==="NetworkError");

  const preCrash=failing();
  await active(preCrash.broker);
  const preCrashDispatch=preCrash.broker.startFetch({event_id:"precrash-failed",request_plan:{},url:"https://target.example/precrash-failed"});
  await ready(preCrash.broker,preCrash.hostPort);
  await preCrash.broker.crashWorker({registration_id:"registration",worker_version:"v1"});
  assert.equal(preCrashDispatch.claimed,false);
  await assert.rejects(()=>preCrashDispatch.response,error=>error.name==="NetworkError");

  const claimed=makeBroker();
  await active(claimed.broker);
  const claimedDispatch=claimed.broker.startFetch({event_id:"claimed-rejected",request_plan:{},url:"https://target.example/claimed-rejected"});
  await ready(claimed.broker,claimed.hostPort);
  await claimed.broker.receiveWorkerMessage(workerEnvelope("RESPOND_WITH_CLAIMED","claimed-rejected-claim",{event_id:"claimed-rejected"}));
  await claimed.broker.receiveWorkerMessage(workerEnvelope("EVENT_FAIL","claimed-rejected-fail",{event_id:"claimed-rejected",phase:"response",code:"RESPOND_WITH_REJECTED"}));
  assert.equal(claimedDispatch.claimed,true);
  await assert.rejects(()=>claimedDispatch.response,error=>error.name==="NetworkError");
});

test("stale, cross-capability, and duplicate worker messages are rejected or idempotent", async () => {
  const { broker, hostPort } = makeBroker();
  await active(broker);
  const dispatch = broker.startFetch({ event_id: "event", request_plan: {}, url: "https://target.example/data" });
  await ready(broker, hostPort);
  const invalidCapability = workerEnvelope("NO_RESPONSE", "bad", { event_id: "event", binding: { ...binding, capability: "other", registration_id: "registration", worker_version: "v1" } });
  await assert.rejects(() => broker.receiveWorkerMessage(invalidCapability), (error) => error.name === "SecurityError");
  assert.deepEqual(await broker.receiveWorkerMessage(workerEnvelope("NO_RESPONSE", "once", { event_id: "event" })), { no_response: true });
  assert.deepEqual(await broker.receiveWorkerMessage(workerEnvelope("NO_RESPONSE", "once", { event_id: "event" })), { duplicate: true });
  assert.equal(await (await dispatch.response).text(), "fallback:NO_RESPONSE");
});

test("install and activate lifecycle dispatches are bounded by worker lifetime closure and journal transitions", async () => {
  const { broker, hostPort } = makeBroker();
  await broker.register({
    graph: graph("v1"), operation_id: "register", registration_id: "registration", scope_url: "https://target.example/", script_url: "https://target.example/sw.js", worker_version: "v1",
  });
  const install = broker.dispatchLifecycle({ event_id: "install-event", event_type: "install", operation_id: "install-lifecycle", registration_id: "registration", worker_version: "v1" });
  await flush();
  await broker.receiveWorkerMessage(workerEnvelope("WORKER_READY", "lifecycle-ready", { graph_hash: "v1" }));
  await flush();
  await broker.receiveWorkerMessage(workerEnvelope("NO_RESPONSE", "install-none", { event_id: "install-event" }));
  await broker.receiveWorkerMessage(workerEnvelope("DISPATCH_CLOSED", "install-dispatch", { event_id: "install-event", max_wait_seq: 0, pending_count: 0 }));
  await broker.receiveWorkerMessage(workerEnvelope("LIFETIME_CLOSED", "install-lifetime", { event_id: "install-event", final_wait_seq: 0, outcome: "fulfilled" }));
  assert.equal((await install).state, "INSTALLED_WAITING");
  await broker.beginActivation({ operation_id: "begin", registration_id: "registration", worker_version: "v1" });
  const activate = broker.dispatchLifecycle({ event_id: "activate-event", event_type: "activate", operation_id: "activate-lifecycle", registration_id: "registration", worker_version: "v1" });
  await flush();
  await broker.receiveWorkerMessage(workerEnvelope("NO_RESPONSE", "activate-none", { event_id: "activate-event" }));
  await broker.receiveWorkerMessage(workerEnvelope("DISPATCH_CLOSED", "activate-dispatch", { event_id: "activate-event", max_wait_seq: 0, pending_count: 0 }));
  await broker.receiveWorkerMessage(workerEnvelope("LIFETIME_CLOSED", "activate-lifetime", { event_id: "activate-event", final_wait_seq: 0, outcome: "fulfilled" }));
  assert.equal((await activate).state, "ACTIVE");
  assert.equal(hostPort.messages.filter((message) => message.type === "EVENT_START").map((message) => message.event_type).join(","), "install,activate");
});

test("broker leaves navigation preload absent until the registration enables it", async () => {
  const { broker, hostPort } = makeBroker();
  let starts = 0;
  await active(broker);
  const dispatch = broker.startFetch({
    event_id: "preload-disabled",
    preload: {
      handle: "disabled-handle",
      start() { starts += 1; return new Response("unexpected"); },
    },
    request_plan: {},
    url: "https://target.example/disabled",
  });
  await ready(broker, hostPort);
  const started = hostPort.messages.find(message => message.type === "EVENT_START" && message.event_id === "preload-disabled");
  assert.equal(started.preload_handle, undefined);
  assert.equal(starts, 0);
  await broker.receiveWorkerMessage(workerEnvelope("NO_RESPONSE", "preload-disabled-none", { event_id: "preload-disabled" }));
  await broker.receiveWorkerMessage(workerEnvelope("DISPATCH_CLOSED", "preload-disabled-dispatch", { event_id: "preload-disabled", max_wait_seq: 0, pending_count: 0 }));
  await broker.receiveWorkerMessage(workerEnvelope("LIFETIME_CLOSED", "preload-disabled-lifetime", { event_id: "preload-disabled", final_wait_seq: 0, outcome: "fulfilled" }));
  assert.equal(await (await dispatch.response).text(), "fallback:NO_RESPONSE");
  await dispatch.lifetime;
});

test("broker transfers a navigation preload once without trusting response provenance", async () => {
  const { broker, hostPort } = makeBroker();
  const canceled = [];
  const starts = [];
  await active(broker);
  await broker.configureNavigationPreload({ operation_id: "preload-enable", registration_id: "registration", enabled: true, header_value: "preload-v1" });
  const dispatch = broker.startFetch({
    event_id: "preload-transfer",
    preload: {
      cancel(reason) { canceled.push(reason); },
      handle: "preload-transfer-handle",
      start(context) { starts.push(context); return new Response(null, { status: 204 }); },
    },
    request_plan: {},
    url: "https://target.example/transfer",
  });
  await ready(broker, hostPort);
  assert.equal(hostPort.messages.find(message => message.type === "EVENT_START")?.preload_handle, "preload-transfer-handle");
  assert.deepEqual(starts, [{ binding, event_id: "preload-transfer", header_value: "preload-v1" }]);
  const preload = await broker.consumePreload({
    event_id: "preload-transfer",
    preload_handle: "preload-transfer-handle",
    registration_id: "registration",
    worker_version: "v1",
  });
  assert.equal(preload.status, 204);
  await assert.rejects(() => broker.consumePreload({
    event_id: "preload-transfer",
    preload_handle: "preload-transfer-handle",
    registration_id: "registration",
    worker_version: "v1",
  }), error => error.name === "InvalidStateError");
  await broker.receiveWorkerMessage(workerEnvelope("RESPOND_WITH_CLAIMED", "preload-transfer-claim", { event_id: "preload-transfer" }));
  await broker.receiveWorkerMessage(workerEnvelope("RESPONSE_HEADERS", "preload-transfer-headers", {
    event_id: "preload-transfer",
    response_plan: { body_present: false, headers: [], status: 204, status_text: "No Content" },
  }));
  await broker.receiveWorkerMessage(workerEnvelope("RESPONSE_END", "preload-transfer-end", { event_id: "preload-transfer", sequence: 0 }));
  await broker.receiveWorkerMessage(workerEnvelope("DISPATCH_CLOSED", "preload-transfer-dispatch", { event_id: "preload-transfer", max_wait_seq: 0, pending_count: 0 }));
  await broker.receiveWorkerMessage(workerEnvelope("LIFETIME_CLOSED", "preload-transfer-lifetime", { event_id: "preload-transfer", final_wait_seq: 0, outcome: "fulfilled" }));
  const response = await dispatch.response;
  await dispatch.lifetime;
  assert.equal(response.body, null);
  assert.deepEqual(canceled, []);
});

test("preload remains controlled and host-start timeout closes the queue before a cold restart", async () => {
  const canceled = [];
  const preloaded = [];
  const hostPort = host();
  const preloadBroker = createTargetWorkerBroker({
    binding,
    controlledFetch: async (request) => {
      preloaded.push(await request.preload_response);
      return preloaded.at(-1);
    },
    host: hostPort,
    journal: memoryJournal(),
    targetOrigin,
  });
  await active(preloadBroker);
  await preloadBroker.configureNavigationPreload({ operation_id: "preload-fallback-enable", registration_id: "registration", enabled: true });
  const preloadDispatch = preloadBroker.startFetch({
    event_id: "preload",
    preload: {
      cancel(reason) { canceled.push(reason); },
      handle: "preload-handle",
      start() { return new Response("preloaded"); },
    },
    request_plan: {},
    url: "https://target.example/data",
  });
  await ready(preloadBroker, hostPort);
  await preloadBroker.receiveWorkerMessage(workerEnvelope("NO_RESPONSE", "preload-none", { event_id: "preload" }));
  await preloadBroker.receiveWorkerMessage(workerEnvelope("DISPATCH_CLOSED", "preload-dispatch", { event_id: "preload", max_wait_seq: 0, pending_count: 0 }));
  await preloadBroker.receiveWorkerMessage(workerEnvelope("LIFETIME_CLOSED", "preload-lifetime", { event_id: "preload", final_wait_seq: 0, outcome: "fulfilled" }));
  assert.equal(await (await preloadDispatch.response).text(), "preloaded");
  assert.equal(preloaded.length, 1);
  assert.deepEqual(canceled, []);

  const canceledDispatch = preloadBroker.startFetch({
    event_id: "preload-canceled",
    preload: {
      cancel(reason) { canceled.push(reason); },
      handle: "preload-canceled-handle",
      start() { return new Response("unused"); },
    },
    request_plan: {},
    url: "https://target.example/canceled",
  });
  await flush();
  await preloadBroker.receiveWorkerMessage(workerEnvelope("RESPOND_WITH_CLAIMED", "preload-canceled-claim", { event_id: "preload-canceled" }));
  await preloadBroker.receiveWorkerMessage(workerEnvelope("RESPONSE_HEADERS", "preload-canceled-headers", {
    event_id: "preload-canceled",
    response_plan: { body_present: false, headers: [], status: 204, status_text: "No Content" },
  }));
  await preloadBroker.receiveWorkerMessage(workerEnvelope("RESPONSE_END", "preload-canceled-end", { event_id: "preload-canceled", sequence: 0 }));
  await preloadBroker.receiveWorkerMessage(workerEnvelope("DISPATCH_CLOSED", "preload-canceled-dispatch", { event_id: "preload-canceled", max_wait_seq: 0, pending_count: 0 }));
  await preloadBroker.receiveWorkerMessage(workerEnvelope("LIFETIME_CLOSED", "preload-canceled-lifetime", { event_id: "preload-canceled", final_wait_seq: 0, outcome: "fulfilled" }));
  assert.equal((await canceledDispatch.response).status, 204);
  await canceledDispatch.lifetime;
  assert.deepEqual(canceled, ["EVENT_COMPLETE"]);
  let hydrations = 0;
  const timeoutBroker = createTargetWorkerBroker({
    binding,
    controlledFetch: async (request) => new Response(request.reason),
    host: {
      async hydrate() { hydrations += 1; return new Promise(() => {}); },
      async send() {},
    },
    journal: memoryJournal(),
    limits: { host_start_ms: 1 },
    targetOrigin,
  });
  await active(timeoutBroker);
  const first = timeoutBroker.startFetch({ event_id: "timeout-1", request_plan: {}, url: "https://target.example/a" });
  assert.equal(await (await first.response).text(), "HOST_START_TIMEOUT");
  assert.deepEqual(await first.lifetime, { fallback: "HOST_START_TIMEOUT" });
  const second = timeoutBroker.startFetch({ event_id: "timeout-2", request_plan: {}, url: "https://target.example/b" });
  assert.equal(await (await second.response).text(), "HOST_START_TIMEOUT");
  assert.equal(hydrations, 2);
});

test("fetch timeouts preserve distinct dispatch, headers, stream-idle, and lifetime failures", async () => {
  const dispatchCase = makeBroker([], { limits: { dispatch_claim_ms: 10, event_lifetime_ms: 100 } });
  await active(dispatchCase.broker);
  const dispatch = dispatchCase.broker.startFetch({ event_id: "dispatch-timeout", request_plan: {}, url: "https://target.example/dispatch" });
  await ready(dispatchCase.broker, dispatchCase.hostPort);
  assert.equal(await (await dispatch.response).text(), "fallback:DISPATCH_TIMEOUT");
  assert.deepEqual(await dispatch.lifetime, { fallback: "DISPATCH_TIMEOUT" });

  const headersCase = makeBroker([], { limits: { event_lifetime_ms: 100, response_headers_ms: 10 } });
  await active(headersCase.broker);
  const headers = headersCase.broker.startFetch({ event_id: "headers-timeout", request_plan: {}, url: "https://target.example/headers" });
  await ready(headersCase.broker, headersCase.hostPort);
  await headersCase.broker.receiveWorkerMessage(workerEnvelope("RESPOND_WITH_CLAIMED", "headers-claim", { event_id: "headers-timeout" }));
  await assert.rejects(headers.response, error => error.name === "NetworkError" && error.message === "RESPONSE_HEADERS_TIMEOUT");
  await assert.rejects(headers.lifetime, error => error.name === "NetworkError" && error.message === "RESPONSE_HEADERS_TIMEOUT");
  await flush();
  assert.equal(headersCase.hostPort.messages.find(message => message.type === "EVENT_FAIL")?.code, "RESPONSE_HEADERS_TIMEOUT");

  const streamCase = makeBroker([], { limits: { event_lifetime_ms: 100, stream_idle_ms: 10 } });
  await active(streamCase.broker);
  const stream = streamCase.broker.startFetch({ event_id: "stream-timeout", request_plan: {}, url: "https://target.example/stream" });
  await ready(streamCase.broker, streamCase.hostPort);
  await streamCase.broker.receiveWorkerMessage(workerEnvelope("RESPOND_WITH_CLAIMED", "stream-claim", { event_id: "stream-timeout" }));
  await streamCase.broker.receiveWorkerMessage(workerEnvelope("RESPONSE_HEADERS", "stream-headers", {
    event_id: "stream-timeout",
    response_plan: { body_present: true, headers: [], status: 200, status_text: "OK" },
  }));
  const streamedResponse = await stream.response;
  await assert.rejects(streamedResponse.body.getReader().read(), error => error.name === "NetworkError" && error.message === "STREAM_IDLE_TIMEOUT");
  await assert.rejects(stream.lifetime, error => error.name === "NetworkError" && error.message === "STREAM_IDLE_TIMEOUT");
  await flush();
  assert.equal(streamCase.hostPort.messages.find(message => message.type === "EVENT_FAIL")?.code, "STREAM_IDLE_TIMEOUT");

  const lifetimeCase = makeBroker([], { limits: { event_lifetime_ms: 10, response_headers_ms: 100 } });
  await active(lifetimeCase.broker);
  const lifetime = lifetimeCase.broker.startFetch({ event_id: "lifetime-timeout", request_plan: {}, url: "https://target.example/lifetime" });
  await ready(lifetimeCase.broker, lifetimeCase.hostPort);
  await lifetimeCase.broker.receiveWorkerMessage(workerEnvelope("RESPOND_WITH_CLAIMED", "lifetime-claim", { event_id: "lifetime-timeout" }));
  await lifetimeCase.broker.receiveWorkerMessage(workerEnvelope("RESPONSE_HEADERS", "lifetime-headers", {
    event_id: "lifetime-timeout",
    response_plan: { body_present: false, headers: [], status: 204, status_text: "No Content" },
  }));
  await lifetimeCase.broker.receiveWorkerMessage(workerEnvelope("RESPONSE_END", "lifetime-end", { event_id: "lifetime-timeout", sequence: 0 }));
  await lifetimeCase.broker.receiveWorkerMessage(workerEnvelope("DISPATCH_CLOSED", "lifetime-dispatch", { event_id: "lifetime-timeout", max_wait_seq: 0, pending_count: 0 }));
  assert.equal((await lifetime.response).status, 204);
  await assert.rejects(lifetime.lifetime, error => error.name === "NetworkError" && error.message === "EVENT_LIFETIME_TIMEOUT");
  await flush();
  assert.equal(lifetimeCase.hostPort.messages.find(message => message.type === "EVENT_FAIL")?.code, "EVENT_LIFETIME_TIMEOUT");
});
test("cold broker recovery rehydrates the durable active graph and authenticates WORKER_READY before dispatch", async () => {
  const durableJournal = memoryJournal();
  const original = makeBroker([], { journal: durableJournal });
  await active(original.broker);

  const recovered = makeBroker([], { journal: durableJournal });
  const dispatch = recovered.broker.startFetch({ event_id: "recovered-event", request_plan: { method: "GET" }, url: "https://target.example/recovered" });
  await flush();
  const hydration = recovered.hostPort.messages.find(message => message.type === "HYDRATE_WORKER");
  assert.equal(hydration.graph.graph_hash, "v1");
  assert.equal(hydration.binding.registration_id, "registration");
  assert.equal(hydration.binding.worker_version, "v1");
  assert.equal(recovered.hostPort.messages.some(message => message.type === "EVENT_START"), false);

  await assert.rejects(
    () => recovered.broker.receiveWorkerMessage(workerEnvelope("WORKER_READY", "forged-ready", { graph_hash: "forged" })),
    error => error.name === "SecurityError",
  );
  assert.equal(recovered.hostPort.messages.some(message => message.type === "EVENT_START"), false);
  await recovered.broker.receiveWorkerMessage(workerEnvelope("WORKER_READY", "recovered-ready", { graph_hash: "v1" }));
  await flush();
  assert.equal(recovered.hostPort.messages.find(message => message.type === "EVENT_START")?.event_id, "recovered-event");

  await recovered.broker.receiveWorkerMessage(workerEnvelope("NO_RESPONSE", "recovered-none", { event_id: "recovered-event" }));
  await recovered.broker.receiveWorkerMessage(workerEnvelope("DISPATCH_CLOSED", "recovered-dispatch", { event_id: "recovered-event", max_wait_seq: 0, pending_count: 0 }));
  await recovered.broker.receiveWorkerMessage(workerEnvelope("LIFETIME_CLOSED", "recovered-lifetime", { event_id: "recovered-event", final_wait_seq: 0, outcome: "fulfilled" }));
  assert.equal(await (await dispatch.response).text(), "fallback:NO_RESPONSE");
  await dispatch.lifetime;
});

test("cold worker queues reject excess count and bytes before target dispatch", async () => {
  const countCase = makeBroker([], { limits: { host_start_ms: 100, max_events_per_registration: 1 } });
  await active(countCase.broker);
  const first = countCase.broker.startFetch({ event_id: "queue-first", request_plan: {}, url: "https://target.example/first" });
  await flush();
  const second = countCase.broker.startFetch({ event_id: "queue-second", request_plan: {}, url: "https://target.example/second" });
  assert.equal(await (await second.response).text(), "fallback:worker event queue limit exceeded");
  assert.deepEqual(await second.lifetime, { fallback: "worker event queue limit exceeded" });
  await countCase.broker.receiveWorkerMessage(workerEnvelope("WORKER_READY", "queue-ready", { graph_hash: "v1" }));
  await flush();
  await countCase.broker.receiveWorkerMessage(workerEnvelope("NO_RESPONSE", "queue-first-none", { event_id: "queue-first" }));
  await countCase.broker.receiveWorkerMessage(workerEnvelope("DISPATCH_CLOSED", "queue-first-dispatch", { event_id: "queue-first", max_wait_seq: 0, pending_count: 0 }));
  await countCase.broker.receiveWorkerMessage(workerEnvelope("LIFETIME_CLOSED", "queue-first-lifetime", { event_id: "queue-first", final_wait_seq: 0, outcome: "fulfilled" }));
  assert.equal(await (await first.response).text(), "fallback:NO_RESPONSE");
  await first.lifetime;

  const bytesCase = makeBroker([], { limits: { max_event_bytes: 64 } });
  await active(bytesCase.broker);
  const oversized = bytesCase.broker.startFetch({
    event_id: "queue-oversized",
    request_plan: { body: "x".repeat(256) },
    url: "https://target.example/oversized",
  });
  assert.equal(await (await oversized.response).text(), "fallback:event request plan exceeds limit");
  assert.deepEqual(await oversized.lifetime, { fallback: "event request plan exceeds limit" });
  assert.equal(bytesCase.hostPort.messages.some(message => message.type === "HYDRATE_WORKER"), false);
});
