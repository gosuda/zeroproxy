import assert from "node:assert/strict";
import test from "node:test";
import { createCoordinatorJournalMirror } from "../../web/sw/target-worker/coordinator-journal.mjs";
import { initialJournalState } from "../../web/sw/target-worker/index.mjs";

const binding = Object.freeze({ capability: "capability", client_epoch: 1, profile_id: "profile", synthetic_origin: "https://o.example" });

function mirror(initial = null) {
  const writes = [];
  return {
    async write(value) { writes.push(structuredClone(value)); this.value = structuredClone(value); },
    value: initial,
    writes,
  };
}

test("cold restart hydrates the per-origin mirror exclusively from the authoritative coordinator journal", async () => {
  const durableState = initialJournalState(binding);
  durableState.registrations.push({ registration_id: "registration" });
  const local = mirror();
  const journal = createCoordinatorJournalMirror({
    binding,
    coordinatorCall: async (operation, payload) => {
      assert.equal(operation, "TARGET_WORKER_JOURNAL_LOAD");
      assert.equal(payload.binding, binding);
      return { revision: 9, state: durableState };
    },
    mirror: local,
  });
  const loaded = await journal.load();
  assert.equal(loaded.revision, 9);
  assert.equal(loaded.state.registrations[0].registration_id, "registration");
  assert.equal(local.writes.length, 1);
  assert.equal(local.value.revision, 9);
});

test("divergent local mirror is overwritten by coordinator state and coordinator failure never falls back to stale state", async () => {
  const stale = initialJournalState(binding);
  stale.registrations.push({ registration_id: "stale" });
  const authoritative = initialJournalState(binding);
  authoritative.registrations.push({ registration_id: "authoritative" });
  const local = mirror({ revision: 2, state: stale });
  const journal = createCoordinatorJournalMirror({
    binding,
    coordinatorCall: async () => ({ revision: 7, state: authoritative }),
    mirror: local,
  });
  const loaded = await journal.load();
  assert.equal(loaded.state.registrations[0].registration_id, "authoritative");
  assert.equal(local.value.state.registrations[0].registration_id, "authoritative");

  const unavailable = createCoordinatorJournalMirror({
    binding,
    coordinatorCall: async () => { throw new DOMException("Coordinator unavailable", "NetworkError"); },
    mirror: local,
  });
  await assert.rejects(() => unavailable.load(), (error) => error.name === "NetworkError");
  assert.equal(local.value.revision, 7);
});
