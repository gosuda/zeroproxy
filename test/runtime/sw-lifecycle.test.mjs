import assert from "node:assert/strict";
import test from "node:test";
import { compatibleLifecycleTuples, createLifecycleAuthority } from "../../web/sw/lifecycle.mjs";

function tuple(overrides = {}) {
  return {
    schema_version: 1,
    compatibility_epoch: 2,
    server_version: "2.0.0",
    control_version: "2.0.0",
    service_worker_version: "2.0.0",
    go_kernel_version: "2.0.0",
    rust_core_version: "2.0.0",
    runtime_version: "2.0.0",
    policy_version: 2,
    message_version: 2,
    error_version: 2,
    browser_support_sha256: "b".repeat(64),
    selectors_sha256: "s".repeat(64).replaceAll("s", "c"),
    artifact_set_sha256: "d".repeat(64),
    ...overrides,
  };
}

function authorityFixture({
  compatibilityHash = "a".repeat(64),
  compatibilityTuple = tuple(),
  clients = [],
  initial = [],
} = {}) {
  const records = new Map(initial.map(record => [record.key, structuredClone(record)]));
  const transitions = [];
  let claims = 0;
  const authority = createLifecycleAuthority({
    compatibilityHash,
    compatibilityTuple,
    controlledWindowClients: async () => clients,
    claimClients: async () => { claims += 1; },
    readMeta: async key => structuredClone(records.get(key)),
    writeMeta: async record => {
      records.set(record.key, structuredClone(record));
      if (record.key.startsWith("lifecycle:") && record.key !== "lifecycle:active") {
        transitions.push(record.state);
      }
    },
  });
  return { authority, claims: () => claims, records, transitions };
}

test("first worker persists cold hydration and hot states with conditional claim", async () => {
  const fixture = authorityFixture();
  await fixture.authority.install();
  assert.equal((await fixture.authority.snapshot()).state, "INSTALLED_WAITING");
  await fixture.authority.activate();
  assert.equal(fixture.claims(), 1, "only first activation claims the uncontrolled bootstrap");
  await fixture.authority.beginHydration({
    profile_id: "profile",
    destination_origin_id: "origin",
    tab_id: "tab",
    entry_id: "entry",
    capability_epoch: 4,
    coordinator_revision: 8,
  });
  await fixture.authority.readyHot();
  assert.equal((await fixture.authority.snapshot()).state, "READY_HOT");
  assert.deepEqual(fixture.transitions, [
    "UNREGISTERED",
    "INSTALLING",
    "INSTALLED_WAITING",
    "ACTIVATING",
    "READY_COLD",
    "HYDRATING",
    "READY_HOT",
  ]);
});

test("process restart demotes hot state before rehydration", async () => {
  const fixture = authorityFixture();
  await fixture.authority.install();
  await fixture.authority.activate();
  await fixture.authority.beginHydration({
    profile_id: "profile",
    destination_origin_id: "origin",
    tab_id: "tab",
    entry_id: "entry",
    capability_epoch: 4,
  });
  await fixture.authority.readyHot();
  const cold = await fixture.authority.coldStart();
  assert.equal(cold.state, "READY_COLD");
  assert.equal(cold.restart_generation, 1);
  assert.equal((await fixture.authority.coldStart()).restart_generation, 1);
});

test("compatible update gates the full tuple and drains before activation without claim", async () => {
  const previousHash = "1".repeat(64);
  const nextHash = "2".repeat(64);
  const previousTuple = tuple({ selectors_sha256: "3".repeat(64), artifact_set_sha256: "8".repeat(64) });
  const nextTuple = tuple({ selectors_sha256: "4".repeat(64), artifact_set_sha256: "9".repeat(64) });
  assert.equal(compatibleLifecycleTuples(previousTuple, nextTuple), true);
  const fixture = authorityFixture({
    compatibilityHash: nextHash,
    compatibilityTuple: nextTuple,
    initial: [
      {
        key: "lifecycle:active",
        worker_version: previousHash,
        transition_revision: 7,
      },
      {
        key: `lifecycle:${previousHash}`,
        worker_version: previousHash,
        compatibility_tuple: previousTuple,
        state: "READY_HOT",
        transition_revision: 7,
      },
    ],
  });
  await fixture.authority.install();

  const restarted = createLifecycleAuthority({
    compatibilityHash: nextHash,
    compatibilityTuple: nextTuple,
    controlledWindowClients: async () => [],
    claimClients: async () => { throw new Error("update must not claim existing documents"); },
    readMeta: async key => structuredClone(fixture.records.get(key)),
    writeMeta: async record => {
      fixture.records.set(record.key, structuredClone(record));
      if (record.key === `lifecycle:${nextHash}`) fixture.transitions.push(record.state);
    },
  });
  await restarted.install();
  await restarted.activate();
  assert.equal((await restarted.snapshot()).state, "READY_COLD");
  assert.deepEqual(fixture.transitions, [
    "UNREGISTERED",
    "INSTALLING",
    "INSTALLED_WAITING",
    "COMPATIBILITY_GATE",
    "DRAIN_OR_HANDOFF",
    "ACTIVATING",
    "READY_COLD",
  ]);
});

test("incompatible or undrained updates evict instead of crossing epochs", async () => {
  const previousHash = "5".repeat(64);
  const active = {
    key: "lifecycle:active",
    worker_version: previousHash,
    transition_revision: 4,
  };
  const previous = {
    key: `lifecycle:${previousHash}`,
    worker_version: previousHash,
    compatibility_tuple: tuple(),
    state: "READY_HOT",
    transition_revision: 4,
  };

  const incompatible = authorityFixture({
    compatibilityHash: "6".repeat(64),
    compatibilityTuple: tuple({ message_version: 3 }),
    initial: [active, previous],
  });
  await incompatible.authority.install();
  await assert.rejects(incompatible.authority.activate(), { code: "VERSION_MISMATCH" });
  assert.equal((await incompatible.authority.snapshot()).state, "EVICTED");
  assert.equal(incompatible.claims(), 0);

  const undrained = authorityFixture({
    compatibilityHash: "7".repeat(64),
    clients: [{ id: "existing-document" }],
    initial: [active, previous],
  });
  await undrained.authority.install();
  await assert.rejects(undrained.authority.activate(), { code: "DRAIN_REQUIRED" });
  assert.equal((await undrained.authority.snapshot()).state, "EVICTED");
  assert.equal(undrained.claims(), 0);
});
