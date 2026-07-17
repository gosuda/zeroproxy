const FRAME_TYPES = new Set(["OPEN", "PULL", "CHUNK", "CLOSE", "ERROR", "CANCEL"]);
const CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;

export function exactFrame(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const expected = ["type", ...fields].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

export function validStreamSequence(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validStreamCode(value) {
  return typeof value === "string" && CODE_PATTERN.test(value);
}

export function validFrameType(value) {
  return typeof value === "string" && FRAME_TYPES.has(value);
}

function kernelStartFailure(state, networkError, fail) {
  return fail(state, networkError()) === false ? "settled" : "failed";
}

export function acceptKernelTransactionStart(state, result, networkError, fail) {
  state.started = true;
  const direction = state.bodyExpected ? "BIDIRECTIONAL" : "DOWNLOAD";
  if (
    !exactFrame(result, ["stream_id", "direction", "max_chunk_bytes", "high_water_mark", "deadline_ms"])
    || result.type !== "OPEN"
    || result.stream_id !== state.requestID
    || result.direction !== direction
    || !Number.isSafeInteger(result.max_chunk_bytes)
    || result.max_chunk_bytes < 1
    || result.max_chunk_bytes > 64 << 10
    || !Number.isSafeInteger(result.high_water_mark)
    || result.high_water_mark < result.max_chunk_bytes
    || result.high_water_mark > 4 << 20
    || !Number.isSafeInteger(result.deadline_ms)
    || result.deadline_ms < 1
    || result.deadline_ms > 86_400_000
  ) {
    return kernelStartFailure(state, networkError, fail);
  }
  state.maxChunkBytes = result.max_chunk_bytes;
  state.highWaterMark = result.high_water_mark;
  state.deadlineMS = result.deadline_ms;
  state.opened = true;
  return "accepted";
}

export async function beginKernelTransaction(state, start, networkError, fail) {
  let result;
  try {
    result = await start();
  } catch {
    return kernelStartFailure(state, networkError, fail);
  }
  return acceptKernelTransactionStart(state, result, networkError, fail);
}
