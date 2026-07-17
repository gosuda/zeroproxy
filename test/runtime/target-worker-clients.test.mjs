import assert from "node:assert/strict";
import test from "node:test";
import { createTargetWorkerBroker, initialJournalState } from "../../web/sw/target-worker/index.mjs";

const binding = Object.freeze({ capability: "capability-a", client_epoch: 7, profile_id: "profile-a", synthetic_origin: "https://o.example" });
const targetOrigin = "https://target.example";

function graph(hash) {
  return { graph_hash: hash, resources: [{ hash: `${hash}:resource`, url: "https://target.example/sw.js" }] };
}

function journal() {
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

function setup() {
  const commands = [];
  const commandTransfers = [];
  const clientCommands = {
    async command(message, transfer = []) {
      commands.push(message);
      commandTransfers.push({ message_id: message.message_id, transfer });
      const clientID = message.type === "CLIENT_OPEN_WINDOW" ? "native-opened" : message.client_id;
      return { binding: message.binding, client_id: clientID, ok: true };
    },
  };
  const host = {
    async hydrate(message) { return { binding: message.binding, graph_hash: message.graph.graph_hash, session_id: "session" }; },
    async send() {},
  };
  return {
    broker: createTargetWorkerBroker({
      binding,
      clientCommands,
      controlledFetch: async () => new Response("controlled"),
      host,
      journal: journal(),
      targetOrigin,
    }),
    commands,
    commandTransfers,
  };
}

async function activate(broker, version, operationPrefix) {
  if (version === "v1") {
    await broker.register({ graph: graph(version), operation_id: `${operationPrefix}-register`, registration_id: "registration", scope_url: "https://target.example/app/", script_url: "https://target.example/sw.js", worker_version: version });
  } else {
    await broker.update({ graph: graph(version), operation_id: `${operationPrefix}-update`, registration_id: "registration", worker_version: version });
  }
  await broker.completeInstall({ operation_id: `${operationPrefix}-install`, registration_id: "registration", success: true, worker_version: version });
  if (version === "v1") await broker.beginActivation({ operation_id: `${operationPrefix}-begin`, registration_id: "registration", worker_version: version });
  else await broker.skipWaiting({ operation_id: `${operationPrefix}-skip`, registration_id: "registration", worker_version: version });
  await broker.completeActivation({ operation_id: `${operationPrefix}-activate`, registration_id: "registration", success: true, worker_version: version });
}

test("activation promotion and clients.claim persist controller revisions before ordered controllerchange commands", async () => {
  const { broker, commands } = setup();
  await broker.register({ graph: graph("v1"), operation_id: "v1-register", registration_id: "registration", scope_url: "https://target.example/app/", script_url: "https://target.example/sw.js", worker_version: "v1" });
  const first = await broker.commitClient({ client_id: "a", operation_id: "client-a", type: "window", url: "https://target.example/app/a" });
  const second = await broker.commitClient({ client_id: "b", operation_id: "client-b", type: "window", url: "https://target.example/app/b" });
  assert.equal(first.controller_revision, 0);
  assert.equal(second.controller_revision, 0);
  await broker.completeInstall({ operation_id: "v1-install", registration_id: "registration", success: true, worker_version: "v1" });
  await broker.beginActivation({ operation_id: "v1-begin", registration_id: "registration", worker_version: "v1" });
  await broker.completeActivation({ operation_id: "v1-activate", registration_id: "registration", success: true, worker_version: "v1" });
  const claim = await broker.claim({ operation_id: "claim-v1", registration_id: "registration", worker_version: "v1" });
  assert.deepEqual(claim.changes.map(change => [change.client_id, change.controller_revision, change.controller.worker_version]), [["a", 1, "v1"], ["b", 1, "v1"]]);
  await activate(broker, "v2", "v2");
  assert.deepEqual((await broker.matchAll()).map(client => [client.client_id, client.controller_revision, client.controller.worker_version]), [["a", 2, "v2"], ["b", 2, "v2"]]);
  assert.deepEqual((await broker.claim({ operation_id: "claim-v2", registration_id: "registration", worker_version: "v2" })).changes, []);
  const changes = commands.filter(message => message.type === "CONTROLLER_CHANGE");
  assert.deepEqual(changes.map(message => [message.client_id, message.controller_revision, message.controller.worker_version]), [["a", 1, "v1"], ["b", 1, "v1"], ["a", 2, "v2"], ["b", 2, "v2"]]);
  assert.equal(changes.every(message => message.binding.capability === binding.capability && message.binding.client_epoch === 7), true);
});

test("virtual client commands use original URLs, capability bindings, and refuse cross-origin navigation", async () => {
  const { broker, commands } = setup();
  await activate(broker, "v1", "v1");
  await broker.commitClient({ client_id: "client", operation_id: "create", type: "window", url: "https://target.example/app/a" });
  await broker.focus({ client_id: "client", operation_id: "focus" });
  await broker.navigate({ client_id: "client", operation_id: "navigate", url: "https://target.example/app/b" });
  const opened = await broker.openWindow({ client_id: "opened", operation_id: "open", url: "https://target.example/app/new" });
  await broker.postMessage({ client_id: "client", message: { hello: "world" }, operation_id: "message" });
  assert.equal(opened.client.client_id, "native-opened");
  assert.deepEqual(commands.filter((message) => message.type !== "CONTROLLER_CHANGE").map((message) => message.type), ["CLIENT_FOCUS", "CLIENT_NAVIGATE", "CLIENT_OPEN_WINDOW", "CLIENT_POST_MESSAGE"]);
  const navigate = commands.find((message) => message.type === "CLIENT_NAVIGATE");
  assert.equal(navigate.url, "https://target.example/app/b");
  assert.equal(navigate.capability, binding.capability);
  await assert.rejects(() => broker.navigate({ client_id: "client", operation_id: "escape", url: "https://evil.example/" }), (error) => error.name === "SecurityError");
});

test("worker-scoped client lookup preserves identities, target URLs, WindowClient methods, and transfers", async () => {
  const { broker, commands, commandTransfers } = setup();
  await activate(broker, "v1", "v1");
  await broker.commitClient({ client_id: "window", operation_id: "window-create", type: "window", url: "https://target.example/app/a" });
  await broker.commitClient({ client_id: "worker", operation_id: "worker-create", type: "worker", url: "https://target.example/app/worker" });
  await broker.commitClient({ client_id: "uncontrolled", operation_id: "uncontrolled-create", type: "window", url: "https://target.example/outside" });
  assert.deepEqual((await broker.matchAll({
    registration_id: "registration",
    worker_version: "v1",
  })).map(client => client.client_id).sort(), ["window", "worker"]);
  assert.deepEqual((await broker.matchAll({
    include_uncontrolled: true,
    registration_id: "registration",
    type: "window",
    worker_version: "v1",
  })).map(client => client.client_id).sort(), ["uncontrolled", "window"]);
  assert.equal((await broker.getClient({ client_id: "worker" })).url, "https://target.example/app/worker");
  assert.equal((await broker.focus({ client_id: "window", operation_id: "window-focus" })).client.client_id, "window");
  assert.equal((await broker.navigate({ client_id: "window", operation_id: "window-navigate", url: "https://target.example/app/b" })).client.url, "https://target.example/app/b");
  await assert.rejects(() => broker.focus({ client_id: "worker", operation_id: "worker-focus" }), error => error.name === "TypeError");
  const channel = new MessageChannel();
  await broker.postMessage({ client_id: "window", message: { port: channel.port1 }, operation_id: "window-message", transfer: [channel.port1] });
  const message = commands.find(command => command.type === "CLIENT_POST_MESSAGE");
  assert.equal(message.message.port, channel.port1);
  assert.equal(message.transfer[0], channel.port1);
  assert.equal(commandTransfers.find(entry => entry.message_id === message.message_id).transfer[0], channel.port1);
  channel.port1.close();
  channel.port2.close();
});

test("client command replies with a stale capability binding fail closed", async () => {
  const instance = setup();
  await activate(instance.broker, "v1", "v1");
  await instance.broker.commitClient({ client_id: "client", operation_id: "create", type: "window", url: "https://target.example/app/a" });
  const badBroker = createTargetWorkerBroker({
    binding,
    clientCommands: { async command(message) { return { binding: { ...message.binding, capability: "stale" } }; } },
    controlledFetch: async () => new Response("controlled"),
    host: { async hydrate(message) { return { binding: message.binding, graph_hash: message.graph.graph_hash, session_id: "session" }; }, async send() {} },
    journal: journal(),
    targetOrigin,
  });
  await activate(badBroker, "v1", "bad");
  await assert.rejects(() => badBroker.commitClient({ client_id: "client", operation_id: "bad-client", type: "window", url: "https://target.example/app/a" }), (error) => error.name === "SecurityError");
  await assert.rejects(() => badBroker.focus({ client_id: "client", operation_id: "bad-focus" }), (error) => error.name === "SecurityError");
});
