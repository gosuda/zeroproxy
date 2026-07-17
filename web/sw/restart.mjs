export const COMMAND_STATES = Object.freeze([
  "RECEIVED",
  "VALIDATED",
  "RUNNING",
  "COMMITTED",
  "REPLIED",
  "ROLLED_BACK",
]);

function restartError(code, name = "InvalidStateError") {
  const error = new Error(code);
  error.name = name;
  error.code = code;
  return error;
}

function validCommandID(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(value);
}

function commandBinding(input) {
  if (!validCommandID(input.id) || typeof input.operation !== "string"
    || input.operation.length === 0 || input.operation.length > 128
    || typeof input.source_client_id !== "string" || input.source_client_id.length === 0
    || typeof input.payload_digest !== "string" || !/^[a-f0-9]{64}$/.test(input.payload_digest)) {
    throw restartError("COMMAND_BINDING_REJECTED", "SecurityError");
  }
  return Object.freeze({
    id: input.id,
    operation: input.operation,
    source_client_id: input.source_client_id,
    payload_digest: input.payload_digest,
  });
}

function sameBinding(record, binding) {
  return record?.id === binding.id
    && record.operation === binding.operation
    && record.source_client_id === binding.source_client_id
    && record.payload_digest === binding.payload_digest;
}

export function createCommandJournal({ read, write, trim, now = Date.now } = {}) {
  if (typeof read !== "function" || typeof write !== "function"
    || typeof trim !== "function" || typeof now !== "function") {
    throw new TypeError("command journal dependencies are incomplete");
  }
  const running = new Map();
  const noOp = async () => {};

  async function persist(record, state, fields = {}) {
    if (!COMMAND_STATES.includes(state)) throw restartError("COMMAND_STATE_REJECTED");
    const timestamp = now();
    const next = {
      ...record,
      ...fields,
      state,
      updated_at: timestamp,
      checkpoints: [...(record.checkpoints ?? []), { state, at: timestamp }].slice(-16),
    };
    await write(next);
    return next;
  }

  function normalizeHandlers(handlers) {
    if (typeof handlers === "function") {
      return { validate: noOp, run: handlers, recover: noOp, replay: null };
    }
    const normalized = {
      validate: handlers?.validate,
      run: handlers?.run,
      recover: typeof handlers?.recover === "function" ? handlers.recover : noOp,
      replay: typeof handlers?.replay === "function" ? handlers.replay : null,
    };
    if (typeof normalized.validate !== "function" || typeof normalized.run !== "function") {
      throw new TypeError("command handlers are incomplete");
    }
    return normalized;
  }

  async function replayResult(handlers, result) {
    return handlers.replay ? handlers.replay(structuredClone(result)) : result;
  }

  async function recoverInterrupted(record, handlers) {
    await handlers.recover(structuredClone(record), "interrupted");
    return persist(record, "ROLLED_BACK", {
      error_code: "INTERRUPTED_BEFORE_COMMIT",
      result: undefined,
    });
  }

  async function runAttempt(record, handlers) {
    try {
      await handlers.validate();
      record = await persist(record, "VALIDATED");
      record = await persist(record, "RUNNING");
      const result = await handlers.run();
      record = await persist(record, "COMMITTED", { result: structuredClone(result) });
      await trim();
      return record.result;
    } catch (error) {
      await handlers.recover(structuredClone(record), "failed");
      await persist(record, "ROLLED_BACK", {
        error_code: typeof error?.code === "string" ? error.code : error?.name ?? "COMMAND_FAILED",
        result: undefined,
      });
      throw error;
    }
  }

  async function resume(binding, handlers) {
    let record = await read(binding.id);
    if (record && !sameBinding(record, binding)) {
      throw restartError("COMMAND_REPLAY_REJECTED", "SecurityError");
    }
    if (record?.state === "COMMITTED" || record?.state === "REPLIED") {
      await handlers.validate();
      return replayResult(handlers, record.result);
    }
    if (record && record.state !== "ROLLED_BACK") {
      record = await recoverInterrupted(record, handlers);
    }
    record = await persist({
      ...binding,
      attempt: (record?.attempt ?? 0) + 1,
      checkpoints: record?.checkpoints ?? [],
      created_at: record?.created_at ?? now(),
    }, "RECEIVED", { error_code: null });
    return runAttempt(record, handlers);
  }

  async function execute(input, providedHandlers) {
    const binding = commandBinding(input);
    const handlers = normalizeHandlers(providedHandlers);
    const active = running.get(binding.id);
    if (active) {
      if (!sameBinding(active.binding, binding)) {
        throw restartError("COMMAND_REPLAY_REJECTED", "SecurityError");
      }
      await handlers.validate();
      return replayResult(handlers, await active.promise);
    }
    const promise = resume(binding, handlers);
    running.set(binding.id, { binding, promise });
    try {
      return await promise;
    } finally {
      if (running.get(binding.id)?.promise === promise) running.delete(binding.id);
    }
  }

  async function replied(id) {
    if (!validCommandID(id)) throw restartError("COMMAND_BINDING_REJECTED", "SecurityError");
    const record = await read(id);
    if (!record || (record.state !== "COMMITTED" && record.state !== "REPLIED")) {
      throw restartError("COMMAND_REPLY_REJECTED");
    }
    if (record.state === "REPLIED") return record;
    return persist(record, "REPLIED");
  }

  return Object.freeze({ execute, replied });
}
