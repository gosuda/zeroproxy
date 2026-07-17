import assert from "node:assert/strict";
import test from "node:test";
import { createRequestLifecycle, REQUEST_PHASES } from "../../web/sw/request-lifecycle.mjs";

function fixture() {
  const checkpoints = [];
  let timestamp = 0;
  const lifecycle = createRequestLifecycle({
    id: "q".repeat(32),
    requestClass: "target-route",
    now: () => ++timestamp,
    checkpoint: async record => checkpoints.push(structuredClone(record)),
  });
  return { checkpoints, lifecycle };
}

async function advanceToStreaming(lifecycle) {
  for (const phase of REQUEST_PHASES.slice(0, -1)) await lifecycle.advance(phase);
}

test("request phases are exact and complete only after streaming", async () => {
  const { checkpoints, lifecycle } = fixture();
  await advanceToStreaming(lifecycle);
  const complete = await lifecycle.complete();
  assert.equal(complete.state, "COMPLETE");
  assert.deepEqual(complete.checkpoints.map(record => record.state), REQUEST_PHASES);
  assert.deepEqual(checkpoints.map(record => record.state), REQUEST_PHASES);
  await assert.rejects(lifecycle.advance("CLASSIFIED"), { code: "REQUEST_ALREADY_TERMINAL" });
});

test("out-of-order phases fail closed", async () => {
  const { lifecycle } = fixture();
  await assert.rejects(lifecycle.advance("AUTHORIZED"), { code: "REQUEST_TRANSITION_REJECTED" });
  await lifecycle.advance("CLASSIFIED");
  await assert.rejects(lifecycle.advance("PLANNED"), { code: "REQUEST_TRANSITION_REJECTED" });
});

test("concurrent boundary reports serialize without duplicate phases", async () => {
  const { checkpoints, lifecycle } = fixture();
  await lifecycle.advance("CLASSIFIED");
  await Promise.all([
    lifecycle.advanceTo("TRANSPORTING"),
    lifecycle.advanceTo("HEADERS"),
  ]);
  assert.deepEqual(checkpoints.map(record => record.state), REQUEST_PHASES.slice(0, 7));
});

test("terminal cleanup closes each tracked resource exactly once", async () => {
  const { lifecycle } = fixture();
  await lifecycle.advance("CLASSIFIED");
  const closed = [];
  lifecycle.track("reader", "request", async () => closed.push("reader"));
  lifecycle.track("port", "coordinator", async () => closed.push("port"));
  const first = lifecycle.fail("TRANSPORT_FAILED", "NETWORK_ERROR");
  const second = lifecycle.fail("ABORTED", "ABORT_ERROR");
  assert.deepEqual(await first, await second);
  assert.deepEqual(closed, ["port", "reader"]);
  assert.equal((await lifecycle.settled).state, "TRANSPORT_FAILED");
});

test("released resource is not closed again at completion", async () => {
  const { lifecycle } = fixture();
  let cleanups = 0;
  const durable = { type: "route_ids", ids: ["r".repeat(32)] };
  const resource = lifecycle.track("target_body", "body", async () => { cleanups += 1; }, durable);
  assert.deepEqual(lifecycle.snapshot().resources, [durable]);
  await lifecycle.release(resource, false);
  assert.deepEqual(lifecycle.snapshot().resources, []);
  await advanceToStreaming(lifecycle);
  await lifecycle.complete();
  assert.equal(cleanups, 0);
});

test("resource registry is bounded and rejects duplicate ownership", async () => {
  const { lifecycle } = fixture();
  lifecycle.track("timer", "deadline", async () => {});
  assert.throws(() => lifecycle.track("timer", "deadline", async () => {}), { code: "REQUEST_RESOURCE_DUPLICATE" });
  for (let index = 1; index < 64; index += 1) lifecycle.track("map_entry", String(index), async () => {});
  assert.throws(() => lifecycle.track("lease", "overflow", async () => {}), { code: "REQUEST_RESOURCE_LIMIT" });
  await lifecycle.fail("POLICY_BLOCKED", "LIMIT");
});

test("durable mutation excludes settlement until its side effect is recoverable", async () => {
  const { checkpoints, lifecycle } = fixture();
  await lifecycle.advance("CLASSIFIED");
  let continueCommit;
  let commitStarted;
  let cleanupCount = 0;
  let sideEffect = false;
  const started = new Promise(resolve => { commitStarted = resolve; });
  const gate = new Promise(resolve => { continueCommit = resolve; });
  const mutation = lifecycle.trackDurable(
    "idb_entry",
    "document-routes",
    async () => {
      cleanupCount += 1;
      sideEffect = false;
    },
    { type: "route_ids", ids: ["r".repeat(32)] },
    async snapshot => {
      assert.deepEqual(snapshot.resources, [{ type: "route_ids", ids: ["r".repeat(32)] }]);
      commitStarted();
      await gate;
      sideEffect = true;
    },
  );
  await started;
  const terminal = lifecycle.fail("TIMED_OUT", "REQUEST_DEADLINE_EXCEEDED");
  assert.equal(cleanupCount, 0);
  continueCommit();
  await mutation;
  await terminal;
  assert.equal(cleanupCount, 1);
  assert.equal(sideEffect, false);
  assert.equal(checkpoints.at(-1).state, "TIMED_OUT");
  assert.deepEqual(checkpoints.at(-1).resources, []);
});

test("durable mutation failure removes its ownership before settlement", async () => {
  const { lifecycle } = fixture();
  let cleanupCount = 0;
  await assert.rejects(
    lifecycle.trackDurable(
      "idb_entry",
      "document-binding",
      async () => { cleanupCount += 1; },
      { type: "document_binding", client_id: "client", entry_id: "e".repeat(32) },
      async () => { throw new Error("transaction aborted"); },
    ),
    /transaction aborted/,
  );
  assert.equal(cleanupCount, 1);
  assert.deepEqual(lifecycle.snapshot().resources, []);
  await lifecycle.fail("TRANSPORT_FAILED", "TRANSACTION_ABORTED");
  assert.equal(cleanupCount, 1);
});

test("durable ownership transfer checkpoints before settlement can proceed", async () => {
  const checkpoints = [];
  let releaseCheckpoint;
  let transferStarted;
  const started = new Promise(resolve => { transferStarted = resolve; });
  const gate = new Promise(resolve => { releaseCheckpoint = resolve; });
  let checkpointCount = 0;
  let cleanupCount = 0;
  const lifecycle = createRequestLifecycle({
    id: "s".repeat(32),
    requestClass: "target-route",
    checkpoint: async record => {
      checkpointCount += 1;
      if (checkpointCount === 2) {
        transferStarted();
        await gate;
      }
      checkpoints.push(structuredClone(record));
    },
  });
  await lifecycle.advance("CLASSIFIED");
  const resource = lifecycle.track(
    "idb_entry",
    "document-binding",
    async () => { cleanupCount += 1; },
    { type: "document_binding", client_id: "client", entry_id: "e".repeat(32) },
  );
  const transfer = lifecycle.transfer([resource]);
  await started;
  const terminal = lifecycle.fail("CLIENT_GONE", "WORKER_STOPPED");
  assert.equal(cleanupCount, 0);
  releaseCheckpoint();
  assert.equal(await transfer, 1);
  await terminal;
  assert.equal(cleanupCount, 0);
  assert.deepEqual(checkpoints.slice(-2).map(record => [record.state, record.resources]), [
    ["CLASSIFIED", []],
    ["CLIENT_GONE", []],
  ]);
});

test("failed durable ownership transfer restores cleanup ownership", async () => {
  let checkpointCount = 0;
  let cleanupCount = 0;
  const lifecycle = createRequestLifecycle({
    id: "t".repeat(32),
    requestClass: "target-route",
    checkpoint: async () => {
      checkpointCount += 1;
      if (checkpointCount === 2) throw new Error("checkpoint failed");
    },
  });
  await lifecycle.advance("CLASSIFIED");
  const durable = { type: "route_ids", ids: ["r".repeat(32)] };
  const resource = lifecycle.track("idb_entry", "document-routes", async () => { cleanupCount += 1; }, durable);
  await assert.rejects(lifecycle.transfer([resource]), /checkpoint failed/);
  assert.deepEqual(lifecycle.snapshot().resources, [durable]);
  await lifecycle.fail("TRANSPORT_FAILED", "CHECKPOINT_FAILED");
  assert.equal(cleanupCount, 1);
});
