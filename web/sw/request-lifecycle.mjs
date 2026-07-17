export const REQUEST_PHASES = Object.freeze([
  "CLASSIFIED",
  "AUTHORIZED",
  "PLANNED",
  "BODY_OPEN",
  "QUEUED",
  "TRANSPORTING",
  "HEADERS",
  "TRANSFORMING_IF_REQUIRED",
  "STREAMING",
  "COMPLETE",
]);

export const REQUEST_TERMINALS = Object.freeze([
  "POLICY_BLOCKED",
  "ABORTED",
  "TIMED_OUT",
  "TRANSPORT_FAILED",
  "REWRITE_FAILED",
  "CLIENT_GONE",
  "VERSION_MISMATCH",
]);

const RESOURCE_KINDS = new Set([
  "reader",
  "writer",
  "port",
  "target_body",
  "smux_stream",
  "lease",
  "timer",
  "map_entry",
  "idb_entry",
]);
const TERMINALS = new Set(["COMPLETE", ...REQUEST_TERMINALS]);
const MAX_RESOURCES = 64;

function lifecycleError(code, name = "InvalidStateError") {
  const error = new Error(code);
  error.name = name;
  error.code = code;
  return error;
}

function validID(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

function durableResourceRecord(value) {
  if (value === null) return null;
  const serialized = JSON.stringify(value);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof serialized !== "string" || serialized.length > 4096) {
    throw lifecycleError("REQUEST_RESOURCE_REJECTED");
  }
  return structuredClone(value);
}

export function createRequestLifecycle({ id, requestClass, checkpoint, now = Date.now } = {}) {
  if (!validID(id) || typeof requestClass !== "string" || requestClass.length === 0
    || requestClass.length > 128 || typeof checkpoint !== "function" || typeof now !== "function") {
    throw lifecycleError("REQUEST_LIFECYCLE_CONFIGURATION_REJECTED");
  }
  const resources = new Map();
  const checkpoints = [];
  let state = null;
  let revision = 0;
  let terminalPromise = null;
  let resolveSettled;
  let updatedAt = now();
  const settled = new Promise(resolve => { resolveSettled = resolve; });
  let queue = Promise.resolve();

  function record(errorCode = null) {
    return Object.freeze({
      id,
      request_class: requestClass,
      state,
      revision,
      error_code: errorCode,
      checkpoints: checkpoints.map(checkpointRecord => ({...checkpointRecord})),
      resource_count: resources.size,
      resources: [...resources.values()].filter(resource => resource.durable !== null).map(resource => structuredClone(resource.durable)),
      updated_at: updatedAt,
    });
  }

  async function persist(errorCode = null) {
    const value = record(errorCode);
    await checkpoint(value);
    return value;
  }

  function serialized(operation) {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  }

  async function advanceOperation(next) {
    if (terminalPromise || TERMINALS.has(state)) throw lifecycleError("REQUEST_ALREADY_TERMINAL");
    const expected = state === null ? REQUEST_PHASES[0] : REQUEST_PHASES[REQUEST_PHASES.indexOf(state) + 1];
    if (next !== expected || next === "COMPLETE") throw lifecycleError("REQUEST_TRANSITION_REJECTED");
    state = next;
    revision += 1;
    updatedAt = now();
    checkpoints.push({state,revision,at:updatedAt});
    return persist();
  }

  async function advanceToOperation(target) {
    const targetIndex = REQUEST_PHASES.indexOf(target);
    if (targetIndex < 0 || target === "COMPLETE") throw lifecycleError("REQUEST_TRANSITION_REJECTED");
    if (terminalPromise || TERMINALS.has(state)) throw lifecycleError("REQUEST_ALREADY_TERMINAL");
    let currentIndex = state === null ? -1 : REQUEST_PHASES.indexOf(state);
    while (currentIndex < targetIndex) {
      currentIndex += 1;
      await advanceOperation(REQUEST_PHASES[currentIndex]);
    }
    return record();
  }

  function track(kind, key, cleanup, durable = null) {
    if (terminalPromise || TERMINALS.has(state)) throw lifecycleError("REQUEST_ALREADY_TERMINAL");
    if (!RESOURCE_KINDS.has(kind) || typeof key !== "string" || key.length === 0
      || key.length > 128 || typeof cleanup !== "function") {
      throw lifecycleError("REQUEST_RESOURCE_REJECTED");
    }
    const durableRecord = durableResourceRecord(durable);
    const idKey = `${kind}\0${key}`;
    if (resources.has(idKey)) throw lifecycleError("REQUEST_RESOURCE_DUPLICATE");
    if (resources.size >= MAX_RESOURCES) throw lifecycleError("REQUEST_RESOURCE_LIMIT", "QuotaExceededError");
    resources.set(idKey, { cleanup, closed: false, durable: durableRecord });
    return idKey;
  }

  function trackDurable(kind, key, cleanup, durable, commit) {
    if (typeof commit !== "function") throw lifecycleError("REQUEST_RESOURCE_REJECTED");
    return serialized(async () => {
      const idKey = track(kind, key, cleanup, durable);
      try {
        await commit(record());
        return idKey;
      } catch (error) {
        await release(idKey, true);
        throw error;
      }
    });
  }

  async function release(idKey, runCleanup = true) {
    const resource = resources.get(idKey);
    if (!resource || resource.closed) return false;
    resource.closed = true;
    resources.delete(idKey);
    if (runCleanup) await resource.cleanup();
    return true;
  }

  function ownedResources(idKeys) {
    const owned = idKeys.map(idKey => [idKey, resources.get(idKey)]);
    if (owned.some(([, resource]) => !resource || resource.closed)) {
      throw lifecycleError("REQUEST_RESOURCE_REJECTED");
    }
    return owned;
  }

  function setTransferOwnership(owned, restore) {
    for (const [idKey, resource] of owned) {
      resource.closed = !restore;
      if (restore) resources.set(idKey, resource);
      else resources.delete(idKey);
    }
  }

  function transfer(idKeys) {
    if (!Array.isArray(idKeys) || idKeys.length === 0 || idKeys.length > MAX_RESOURCES
      || new Set(idKeys).size !== idKeys.length) {
      throw lifecycleError("REQUEST_RESOURCE_REJECTED");
    }
    return serialized(async () => {
      if (terminalPromise || TERMINALS.has(state)) throw lifecycleError("REQUEST_ALREADY_TERMINAL");
      const owned = ownedResources(idKeys);
      setTransferOwnership(owned, false);
      try {
        await persist();
      } catch (error) {
        setTransferOwnership(owned, true);
        throw error;
      }
      return owned.length;
    });
  }

  async function cleanupAll() {
    const entries = [...resources.entries()].reverse();
    const results = await Promise.allSettled(entries.map(([idKey]) => release(idKey, true)));
    return results.filter(result => result.status === "rejected").length;
  }

  async function settleOperation(terminal, errorCode) {
    if (terminal === "COMPLETE" && state !== "STREAMING") throw lifecycleError("REQUEST_COMPLETION_REJECTED");
    state = terminal;
    revision += 1;
    updatedAt = now();
    checkpoints.push({state,revision,at:updatedAt});
    const cleanupFailures = await cleanupAll();
    const value = await persist(errorCode ?? (cleanupFailures === 0 ? null : "REQUEST_CLEANUP_FAILED"));
    resolveSettled(value);
    return value;
  }

  function settle(terminal, errorCode = null) {
    if (!TERMINALS.has(terminal)) throw lifecycleError("REQUEST_TERMINAL_REJECTED");
    if (terminalPromise) return terminalPromise;
    terminalPromise = serialized(() => settleOperation(terminal, errorCode));
    return terminalPromise;
  }

  return Object.freeze({
    advance: next => serialized(() => advanceOperation(next)),
    advanceTo: target => serialized(() => advanceToOperation(target)),
    complete: () => settle("COMPLETE"),
    fail: (terminal, errorCode = null) => settle(terminal, errorCode),
    release,
    settled,
    snapshot: () => record(),
    track,
    trackDurable,
    transfer,
  });
}
