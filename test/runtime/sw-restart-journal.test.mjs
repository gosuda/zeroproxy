import assert from "node:assert/strict";
import test from "node:test";
import { createCommandJournal } from "../../web/sw/restart.mjs";

const commandID = "c".repeat(32);
const digest = "d".repeat(64);

function fixture(initial = []) {
  const records = new Map(initial.map(record => [record.id, structuredClone(record)]));
  const writes = [];
  let timestamp = 100;
  const journal = createCommandJournal({
    now: () => ++timestamp,
    read: async id => structuredClone(records.get(id)),
    write: async record => {
      records.set(record.id, structuredClone(record));
      writes.push(structuredClone(record));
    },
    trim: async () => {},
  });
  return { journal, records, writes };
}

function binding(overrides = {}) {
  return {
    id: commandID,
    operation: "ALLOCATE_DOCUMENT_ROUTE",
    source_client_id: "client-a",
    payload_digest: digest,
    ...overrides,
  };
}

test("command checkpoints are durable through commit and reply", async () => {
  const state = fixture();
  const calls = [];
  const result = await state.journal.execute(binding(), {
    validate: async () => { calls.push("validate"); },
    run: async () => { calls.push("run"); return { path: "/route" }; },
  });
  assert.deepEqual(result, { path: "/route" });
  assert.deepEqual(calls, ["validate", "run"]);
  assert.deepEqual(state.writes.map(record => record.state), [
    "RECEIVED", "VALIDATED", "RUNNING", "COMMITTED",
  ]);
  await state.journal.replied(commandID);
  assert.equal(state.records.get(commandID).state, "REPLIED");
});

test("committed result replays without repeating durable work", async () => {
  const state = fixture();
  let runs = 0;
  await state.journal.execute(binding(), async () => { runs += 1; return { value: 7 }; });
  const replay = await state.journal.execute(binding(), async () => { runs += 1; return { value: 8 }; });
  assert.deepEqual(replay, { value: 7 });
  assert.equal(runs, 1);
});

test("committed replay revalidates the current invocation", async () => {
  const state = fixture();
  await state.journal.execute(binding(), async () => ({ value: 7 }));
  const authorizationError = Object.assign(new Error("stale source"), { code: "AUTHORIZATION_REJECTED" });
  await assert.rejects(state.journal.execute(binding(), {
    validate: async () => { throw authorizationError; },
    run: async () => { throw new Error("committed work must not rerun"); },
  }), { code: "AUTHORIZATION_REJECTED" });
});

test("interrupted work recovers before a new validated attempt", async () => {
  const state = fixture([{
    ...binding(),
    state: "RUNNING",
    attempt: 1,
    created_at: 1,
    updated_at: 2,
    checkpoints: [{ state: "RUNNING", at: 2 }],
  }]);
  const recovered = [];
  const result = await state.journal.execute(binding(), {
    validate: async () => {},
    recover: async (record, reason) => recovered.push([record.state, reason]),
    run: async () => "resumed",
  });
  assert.equal(result, "resumed");
  assert.deepEqual(recovered, [["RUNNING", "interrupted"]]);
  assert.equal(state.records.get(commandID).attempt, 2);
  assert.deepEqual(state.writes.map(record => record.state), [
    "ROLLED_BACK", "RECEIVED", "VALIDATED", "RUNNING", "COMMITTED",
  ]);
});

test("concurrent duplicate IDs reject a different binding before joining", async () => {
  const state = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = state.journal.execute(binding(), async () => { await gate; return "first"; });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    state.journal.execute(binding({ operation: "WARM_KERNEL" }), async () => "second"),
    { code: "COMMAND_REPLAY_REJECTED" },
  );
  release();
  assert.equal(await first, "first");
});

test("concurrent process-local duplicate installs its replacement transport", async () => {
  const state = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = state.journal.execute(binding(), async () => {
    await gate;
    return { attached: true };
  });
  await new Promise(resolve => setImmediate(resolve));
  let replayed = 0;
  const second = state.journal.execute(binding(), {
    validate: async () => {},
    run: async () => { throw new Error("joined command must not rerun durable work"); },
    replay: async result => {
      replayed += 1;
      return result;
    },
  });
  release();
  assert.deepEqual(await first, { attached: true });
  assert.deepEqual(await second, { attached: true });
  assert.equal(replayed, 1);
});

test("failed work invokes recovery and leaves a retryable rollback", async () => {
  const state = fixture();
  const recovered = [];
  await assert.rejects(state.journal.execute(binding(), {
    validate: async () => {},
    recover: async (record, reason) => recovered.push([record.state, reason]),
    run: async () => { throw Object.assign(new Error("boom"), { code: "EXPECTED_FAILURE" }); },
  }), { code: "EXPECTED_FAILURE" });
  assert.deepEqual(recovered, [["RUNNING", "failed"]]);
  assert.equal(state.records.get(commandID).state, "ROLLED_BACK");
  assert.equal(state.records.get(commandID).error_code, "EXPECTED_FAILURE");
});
