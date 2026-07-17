import assert from "node:assert/strict";
import test from "node:test";
import { createTargetWorkerBroker, initialJournalState } from "../../web/sw/target-worker/index.mjs";

const binding = Object.freeze({
  capability: "capability-a",
  client_epoch: 1,
  profile_id: "profile-a",
  synthetic_origin: "https://o.example",
});
const targetOrigin = "https://target.example";

function graph(hash, { updateHash = hash } = {}) {
  return {
    graph_hash: hash,
    resources: [{ hash: `${hash}:resource`, url: "https://target.example/sw.js" }],
    update_hash: updateHash,
    update_resources: [{ hash: `${updateHash}:source`, url: "https://target.example/sw.js" }],
  };
}

function journal() {
  let revision = 0;
  let state = initialJournalState(binding);
  return {
    async compareAndSwap(message) {
      if (message.expected_revision !== revision) return { applied: false, revision, state: structuredClone(state) };
      revision += 1;
      state = structuredClone(message.state);
      return { applied: true, revision, state: structuredClone(state) };
    },
    async load() { return { revision, state: structuredClone(state) }; },
    snapshot() { return structuredClone(state); },
  };
}

function host() {
  const messages = [];
  return {
    async hydrate(message) {
      messages.push(message);
      return { binding: message.binding, graph_hash: message.graph.graph_hash, session_id: `session:${message.binding.worker_version}` };
    },
    async send(message) { messages.push(message); },
    messages,
  };
}
function clientPort() {
  return {
    async command(message) { return { binding: message.binding, ok: true }; },
  };
}


function broker({ clock, journalPort = journal(), hostPort = host(), clientCommands = clientPort() } = {}) {
  return {
    broker: createTargetWorkerBroker({
      binding,
      clientCommands,
      ...(clock === undefined ? {} : { clock }),
      controlledFetch: async () => new Response("controlled"),
      host: hostPort,
      journal: journalPort,
      targetOrigin,
    }),
    host: hostPort,
    journal: journalPort,
  };
}

async function active(instance, registrationID, workerVersion, scope = "https://target.example/") {
  await instance.broker.register({
    graph: graph(workerVersion),
    operation_id: `${registrationID}:register`,
    registration_id: registrationID,
    scope_url: scope,
    script_url: "https://target.example/sw.js",
    worker_version: workerVersion,
  });
  await instance.broker.completeInstall({ operation_id: `${registrationID}:install`, registration_id: registrationID, success: true, worker_version: workerVersion });
  await instance.broker.beginActivation({ operation_id: `${registrationID}:begin`, registration_id: registrationID, worker_version: workerVersion });
  await instance.broker.completeActivation({ operation_id: `${registrationID}:activate`, registration_id: registrationID, success: true, worker_version: workerVersion });
}

test("registration resolution uses original target URL and the longest matching scope", async () => {
  const instance = broker();
  await active(instance, "root", "root-v1", "https://target.example/");
  await active(instance, "app", "app-v1", "https://target.example/app/");
  assert.equal((await instance.broker.getRegistration("https://target.example/app/page")).registration_id, "app");
  assert.equal((await instance.broker.getRegistration("https://target.example/elsewhere")).registration_id, "root");
  await assert.rejects(() => instance.broker.getRegistration("https://outside.example/app"), (error) => error.name === "SecurityError");
});

test("journal-backed lifecycle follows the persisted state machine and idempotent operations replay", async () => {
  const instance = broker();
  const registration = {
    graph: graph("v1"),
    operation_id: "register-once",
    registration_id: "registration",
    scope_url: "https://target.example/app/",
    script_url: "https://target.example/sw.js",
    worker_version: "v1",
  };
  assert.deepEqual(await instance.broker.register(registration), { registration_id: "registration", state: "INSTALLING", worker_version: "v1" });
  assert.deepEqual(await instance.broker.register(registration), { registration_id: "registration", state: "INSTALLING", worker_version: "v1" });
  assert.equal((await instance.broker.updateFound("registration")).worker_version, "v1");
  let version=(await instance.broker.getRegistration("https://target.example/app/a")).versions[0];
  assert.deepEqual({ state: version.state, state_revision: version.state_revision }, { state: "INSTALLING", state_revision: 1 });
  assert.equal((await instance.broker.completeInstall({ operation_id: "install-v1", registration_id: "registration", success: true, worker_version: "v1" })).state, "INSTALLED_WAITING");
  version=(await instance.broker.getRegistration("https://target.example/app/a")).versions[0];
  assert.deepEqual({ state: version.state, state_revision: version.state_revision }, { state: "INSTALLED_WAITING", state_revision: 2 });
  assert.equal((await instance.broker.beginActivation({ operation_id: "activate-v1", registration_id: "registration", worker_version: "v1" })).state, "ACTIVATING");
  version=(await instance.broker.getRegistration("https://target.example/app/a")).versions[0];
  assert.deepEqual({ state: version.state, state_revision: version.state_revision }, { state: "ACTIVATING", state_revision: 3 });
  assert.equal((await instance.broker.completeActivation({ operation_id: "activation-v1", registration_id: "registration", success: true, worker_version: "v1" })).state, "ACTIVE");
  const activeRegistration=await instance.broker.getRegistration("https://target.example/app/a");
  assert.equal(activeRegistration.active_version, "v1");
  assert.deepEqual({ state: activeRegistration.versions[0].state, state_revision: activeRegistration.versions[0].state_revision }, { state: "ACTIVE", state_revision: 4 });
});

test("module registration durably preserves its dedicated executable graph identity", async () => {
  const instance = broker();
  const moduleGraph = {
    abi_identifier: "__zp_abi_555555555555555555555555555555555555555555555555",
    graph_hash: "module-graph",
    module_graph_id: "m".repeat(32),
    module_referrer: "https://target.example/app/",
    resources: [{ hash: "module-resource", module_url: "/_zp/target-worker-exec/module.mjs", url: "https://target.example/sw.mjs" }],
    type: "module",
    update_hash: "module-update",
    update_resources: [{ hash: "module-source", module_type: "javascript", url: "https://target.example/sw.mjs" }],
  };
  await instance.broker.register({
    graph: moduleGraph,
    operation_id: "module-register",
    registration_id: "module-registration",
    scope_url: "https://target.example/app/",
    script_url: "https://target.example/sw.mjs",
    type: "module",
    worker_version: "module-v1",
  });
  const registration = await instance.broker.getRegistration("https://target.example/app/page");
  assert.equal(registration.type, "module");
  assert.deepEqual(registration.versions[0].graph, moduleGraph);
});

test("navigation preload state is disabled by default and journaled per registration", async () => {
  const journalPort = journal();
  const first = broker({ journalPort });
  await active(first, "registration", "v1");
  assert.deepEqual(await first.broker.getNavigationPreloadState("registration"), { enabled: false, header_value: "true" });
  assert.deepEqual(await first.broker.configureNavigationPreload({
    enabled: true,
    header_value: "worker-v1",
    operation_id: "preload-enable",
    registration_id: "registration",
  }), { enabled: true, header_value: "worker-v1" });
  const recovered = broker({ journalPort });
  assert.deepEqual(await recovered.broker.getNavigationPreloadState("registration"), { enabled: true, header_value: "worker-v1" });
  assert.deepEqual(await recovered.broker.configureNavigationPreload({
    enabled: false,
    operation_id: "preload-disable",
    registration_id: "registration",
  }), { enabled: false, header_value: "worker-v1" });
  await assert.rejects(() => recovered.broker.configureNavigationPreload({
    header_value: "bad\r\nvalue",
    operation_id: "preload-invalid",
    registration_id: "registration",
  }), error => error.name === "TypeError");
});

test("concurrent updates coalesce on a graph-pinned candidate and failed candidates preserve active ownership", async () => {
  const instance = broker();
  await active(instance, "registration", "v1");
  const inputs = ["update-a", "update-b"].map((operation_id) => ({ graph: graph("v2"), operation_id, registration_id: "registration", worker_version: "v2" }));
  const results = await Promise.all(inputs.map((input) => instance.broker.update(input)));
  assert.deepEqual(results, [
    { registration_id: "registration", state: "INSTALLING", worker_version: "v2" },
    { registration_id: "registration", state: "INSTALLING", worker_version: "v2" },
  ]);
  await instance.broker.completeInstall({ operation_id: "fail-v2", registration_id: "registration", success: false, worker_version: "v2" });
  const registration = await instance.broker.getRegistration("https://target.example/a");
  assert.equal(registration.active_version, "v1");
  assert.equal(registration.versions.find((version) => version.worker_version === "v2").state, "REDUNDANT");
  await assert.rejects(
    () => instance.broker.update({ graph: graph("different"), operation_id: "pinned", registration_id: "registration", worker_version: "v2" }),
    (error) => error.name === "SecurityError",
  );
});

test("stable source identity suppresses compiled-only updates and resets the certified interval", async () => {
  let now = 1_000;
  const instance = broker({ clock: { now: () => now } });
  await active(instance, "registration", "v1");
  const interval = 24 * 60 * 60 * 1_000;
  assert.equal(await instance.broker.shouldSoftUpdate("registration"), false);
  now += interval - 1;
  assert.equal(await instance.broker.shouldSoftUpdate("registration"), false);
  now += 1;
  assert.equal(await instance.broker.shouldSoftUpdate("registration"), true);
  const result = await instance.broker.update({
    graph: graph("different-compiled-output", { updateHash: "v1" }),
    operation_id: "stable-update",
    registration_id: "registration",
    script_url: "https://target.example/new-sw.js",
    type: "module",
    update_via_cache: "none",
    worker_version: "v2",
  });
  assert.deepEqual(result, { registration_id: "registration", state: "ACTIVE", unchanged: true, worker_version: "v1" });
  assert.equal(await instance.broker.shouldSoftUpdate("registration"), false);
  const registration = await instance.broker.getRegistration("https://target.example/a");
  assert.deepEqual(
    {
      active_script_url: registration.versions[0].script_url,
      installing_version: registration.installing_version,
      script_url: registration.script_url,
      type: registration.type,
      update_via_cache: registration.update_via_cache,
    },
    {
      active_script_url: "https://target.example/sw.js",
      installing_version: null,
      script_url: "https://target.example/new-sw.js",
      type: "module",
      update_via_cache: "none",
    },
  );
});

test("waiting candidate promotion starts only after the last controlled client leaves", async () => {
  const instance = broker();
  await active(instance, "registration", "v1", "https://target.example/app/");
  await instance.broker.commitClient({ client_id: "client", operation_id: "client-create", type: "window", url: "https://target.example/app/a" });
  await instance.broker.update({ graph: graph("v2"), operation_id: "update-v2", registration_id: "registration", worker_version: "v2" });
  await instance.broker.completeInstall({ operation_id: "install-v2", registration_id: "registration", success: true, worker_version: "v2" });
  await assert.rejects(() => instance.broker.beginActivation({ operation_id: "blocked", registration_id: "registration", worker_version: "v2" }), (error) => error.name === "InvalidStateError");
  assert.deepEqual(
    await instance.broker.releaseClient({ client_id: "client", operation_id: "client-release" }),
    { activation_required: [{ registration_id: "registration", worker_version: "v2" }], client_id: "client" },
  );
  const activating=await instance.broker.getRegistration("https://target.example/app/a");
  const candidate=activating.versions.find(version => version.worker_version === "v2");
  assert.deepEqual({ state: candidate.state, state_revision: candidate.state_revision }, { state: "ACTIVATING", state_revision: 3 });
  await instance.broker.completeActivation({ operation_id: "activate-v2", registration_id: "registration", success: true, worker_version: "v2" });
  const registration = await instance.broker.getRegistration("https://target.example/app/a");
  assert.equal(registration.active_version, "v2");
  assert.equal(registration.versions.find((version) => version.worker_version === "v1").state, "REDUNDANT");
});

test("skipWaiting requested during install persists and makes the committed candidate activation-eligible", async () => {
  const instance = broker();
  await active(instance, "registration", "v1", "https://target.example/app/");
  await instance.broker.commitClient({ client_id: "client", operation_id: "client-create", type: "window", url: "https://target.example/app/a" });
  await instance.broker.update({ graph: graph("v2"), operation_id: "update-v2", registration_id: "registration", worker_version: "v2" });
  assert.deepEqual(
    await instance.broker.skipWaiting({ operation_id: "skip-installing-v2", registration_id: "registration", worker_version: "v2" }),
    { registration_id: "registration", skip_waiting_requested: true, state: "INSTALLING", worker_version: "v2" },
  );
  const installing=await instance.broker.getRegistration("https://target.example/app/a");
  assert.equal(installing.versions.find(version => version.worker_version === "v2").skip_waiting_requested, true);
  const installed=await instance.broker.completeInstall({ operation_id: "install-v2", registration_id: "registration", success: true, worker_version: "v2" });
  assert.equal(installed.activation_eligible, true);
  assert.equal((await instance.broker.beginActivation({ operation_id: "begin-v2", registration_id: "registration", worker_version: "v2" })).state, "ACTIVATING");
});

test("unregister commits once and removes the registration from future lookups", async () => {
  const instance = broker();
  await active(instance, "registration", "v1");
  assert.deepEqual(
    await instance.broker.unregister({ operation_id: "unregister-v1", registration_id: "registration" }),
    { registration_id: "registration", unregistered: true },
  );
  assert.equal(await instance.broker.getRegistration("https://target.example/a"), null);
  assert.deepEqual(await instance.broker.getRegistrations(), []);
  assert.deepEqual(
    await instance.broker.unregister({ operation_id: "unregister-v1-again", registration_id: "registration" }),
    { registration_id: "registration", unregistered: false },
  );
});
