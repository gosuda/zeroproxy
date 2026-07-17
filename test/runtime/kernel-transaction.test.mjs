import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptKernelTransactionStart,
  beginKernelTransaction,
  exactFrame,
  validFrameType,
  validStreamCode,
  validStreamSequence,
} from "../../web/sw/kernel-transaction.mjs";

function networkError() {
  return new DOMException("Network request failed", "NetworkError");
}

function openFrame(overrides = {}) {
  return {
    type: "OPEN",
    stream_id: "request-1",
    direction: "DOWNLOAD",
    max_chunk_bytes: 64 << 10,
    high_water_mark: 256 << 10,
    deadline_ms: 60_000,
    ...overrides,
  };
}

function accepted(result, initial = {}) {
  const state = {
    bodyExpected: false,
    requestID: "request-1",
    started: false,
    maxChunkBytes: 64 << 10,
    ...initial,
  };
  const failures = [];
  const value = acceptKernelTransactionStart(state, result, networkError, (failedState, error) => {
    failures.push({ error, started: failedState.started });
  });
  return { failures, state, value };
}

test("kernel transaction start accepts only an exact bounded OPEN frame", () => {
  for (const maxChunkBytes of [1, 16 << 10, 64 << 10]) {
    const result = accepted(openFrame({ max_chunk_bytes: maxChunkBytes }));
    assert.equal(result.value, "accepted");
    assert.equal(result.state.started, true);
    assert.equal(result.state.opened, true);
    assert.equal(result.state.maxChunkBytes, maxChunkBytes);
    assert.equal(result.state.highWaterMark, 256 << 10);
    assert.equal(result.state.deadlineMS, 60_000);
    assert.deepEqual(result.failures, []);
  }
  assert.equal(accepted(openFrame({ direction: "BIDIRECTIONAL" }), { bodyExpected: true }).value, "accepted");
});

test("stream frame grammar is closed and rejects unknown fields", () => {
  assert.equal(exactFrame({ type: "PULL", seq: 0, desired_bytes: 1 }, ["seq", "desired_bytes"]), true);
  assert.equal(exactFrame({ type: "PULL", seq: 0, desired_bytes: 1, extra: true }, ["seq", "desired_bytes"]), false);
  assert.equal(exactFrame({ type: "CHUNK", seq: 0, chunk: new ArrayBuffer(1) }, ["seq", "chunk"]), true);
  assert.equal(validStreamSequence(0), true);
  assert.equal(validStreamSequence(-1), false);
  assert.equal(validStreamSequence(1.5), false);
  assert.equal(validStreamCode("PORT_CLOSED"), true);
  assert.equal(validStreamCode("raw error"), false);
  for (const type of ["OPEN", "PULL", "CHUNK", "CLOSE", "ERROR", "CANCEL"])
    assert.equal(validFrameType(type), true);
  assert.equal(validFrameType("ACK"), false);
});

test("malformed OPEN frames become cancellable before canonical failure", () => {
  const malformed = [
    null,
    {},
    openFrame({ type: "open" }),
    openFrame({ stream_id: "other" }),
    openFrame({ direction: "BIDIRECTIONAL" }),
    openFrame({ max_chunk_bytes: 0 }),
    openFrame({ max_chunk_bytes: (64 << 10) + 1 }),
    openFrame({ max_chunk_bytes: 1.5 }),
    openFrame({ high_water_mark: 0 }),
    openFrame({ high_water_mark: (4 << 20) + 1 }),
    openFrame({ deadline_ms: 0 }),
    { ...openFrame(), extra: true },
  ];
  for (const result of malformed) {
    const outcome = accepted(result, { cancelSent: false });
    assert.equal(outcome.value, "failed");
    assert.equal(outcome.state.started, true);
    assert.equal(outcome.state.maxChunkBytes, 64 << 10);
    assert.equal(outcome.failures.length, 1);
    assert.equal(outcome.failures[0].started, true);
    assert.equal(outcome.failures[0].error.name, "NetworkError");
  }
});

test("rejected and malformed starts settle through one canonical failure path", async () => {
  for (const start of [
    () => Promise.reject(new Error("raw kernel failure")),
    () => Promise.resolve(openFrame({ stream_id: "wrong" })),
  ]) {
    const state = { bodyExpected: false, requestID: "request-1", started: false, maxChunkBytes: 64 << 10 };
    const failures = [];
    const result = await beginKernelTransaction(state, start, networkError, (failedState, error) => {
      failures.push({ error, started: failedState.started });
    });
    assert.equal(result, "failed");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].error.name, "NetworkError");
    assert.equal(failures[0].started, state.started);
  }
});

test("abort during a pending malformed start is reported as pre-settled", async () => {
  let resolveStart;
  const pendingStart = new Promise(resolve => { resolveStart = resolve; });
  const state = {
    bodyExpected: false,
    cancelSent: false,
    maxChunkBytes: 64 << 10,
    requestID: "request-1",
    settled: false,
    started: false,
  };
  const failures = [];
  const beginning = beginKernelTransaction(
    state,
    () => pendingStart,
    networkError,
    (failedState, error) => {
      if (failedState.settled) return false;
      failedState.settled = true;
      failures.push(error);
      return true;
    },
  );
  state.cancelSent = true;
  state.settled = true;
  resolveStart(openFrame({ stream_id: "wrong" }));
  assert.equal(await beginning, "settled");
  assert.equal(state.started, true);
  assert.equal(state.cancelSent, true);
  assert.deepEqual(failures, []);
});
