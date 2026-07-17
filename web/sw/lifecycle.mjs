export const LIFECYCLE_STATES = Object.freeze([
  "UNREGISTERED",
  "INSTALLING",
  "INSTALLED_WAITING",
  "COMPATIBILITY_GATE",
  "DRAIN_OR_HANDOFF",
  "ACTIVATING",
  "READY_COLD",
  "HYDRATING",
  "READY_HOT",
  "EVICTED",
]);

const COMPATIBILITY_FIELDS = Object.freeze([
  "schema_version",
  "compatibility_epoch",
  "server_version",
  "control_version",
  "service_worker_version",
  "go_kernel_version",
  "rust_core_version",
  "runtime_version",
  "policy_version",
  "message_version",
  "error_version",
  "browser_support_sha256",
  "selectors_sha256",
  "artifact_set_sha256",
]);

const UPDATE_ARTIFACT_FIELDS = new Set(["selectors_sha256", "artifact_set_sha256"]);
const UPDATE_COMPATIBILITY_FIELDS = Object.freeze(
  COMPATIBILITY_FIELDS.filter((field) => !UPDATE_ARTIFACT_FIELDS.has(field)),
);

function lifecycleError(code) {
  const error = new Error(code);
  error.name = "InvalidStateError";
  error.code = code;
  return error;
}

function validTuple(tuple) {
  return tuple && typeof tuple === "object" && !Array.isArray(tuple)
    && Object.keys(tuple).length === COMPATIBILITY_FIELDS.length
    && COMPATIBILITY_FIELDS.every((field) => field in tuple)
    && tuple.schema_version === 1
    && Number.isSafeInteger(tuple.compatibility_epoch) && tuple.compatibility_epoch > 0
    && Number.isSafeInteger(tuple.policy_version) && tuple.policy_version > 0
    && Number.isSafeInteger(tuple.message_version) && tuple.message_version > 0
    && Number.isSafeInteger(tuple.error_version) && tuple.error_version > 0
    && /^[a-f0-9]{64}$/.test(tuple.browser_support_sha256)
    && /^[a-f0-9]{64}$/.test(tuple.selectors_sha256)
    && /^[a-f0-9]{64}$/.test(tuple.artifact_set_sha256);
}

export function compatibleLifecycleTuples(previous, next) {
  return validTuple(previous) && validTuple(next)
    && UPDATE_COMPATIBILITY_FIELDS.every((field) => previous[field] === next[field]);
}

function validVersion(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function createLifecycleAuthority({
  compatibilityHash,
  compatibilityTuple,
  controlledWindowClients,
  claimClients,
  readMeta,
  writeMeta,
}) {
  if (!validVersion(compatibilityHash) || !validTuple(compatibilityTuple)
    || typeof controlledWindowClients !== "function" || typeof claimClients !== "function"
    || typeof readMeta !== "function" || typeof writeMeta !== "function") {
    throw lifecycleError("LIFECYCLE_CONFIGURATION_REJECTED");
  }
  const recordKey = `lifecycle:${compatibilityHash}`;
  let queue = Promise.resolve();

  function serialized(operation) {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  }

  async function record() {
    return readMeta(recordKey);
  }

  async function writeState(current, state, extra = {}) {
    if (!LIFECYCLE_STATES.includes(state)) throw lifecycleError("LIFECYCLE_STATE_REJECTED");
    const next = {
      ...current,
      key: recordKey,
      worker_version: compatibilityHash,
      compatibility_tuple: compatibilityTuple,
      state,
      transition_revision: (current?.transition_revision ?? -1) + 1,
      ...extra,
    };
    await writeMeta(next);
    return next;
  }

  async function installOperation() {
    const existing = await record();
    if (existing) {
      if (["INSTALLING", "INSTALLED_WAITING"].includes(existing.state)) {
        return existing.state === "INSTALLING"
          ? writeState(existing, "INSTALLED_WAITING")
          : existing;
      }
      throw lifecycleError("LIFECYCLE_INSTALL_REPLAY_REJECTED");
    }
    const active = await readMeta("lifecycle:active");
    let current = await writeState(null, "UNREGISTERED", {
      previous_worker_version: active?.worker_version ?? null,
    });
    current = await writeState(current, "INSTALLING");
    return writeState(current, "INSTALLED_WAITING");
  }

  async function gateCompatibleUpdate(current, previousVersion) {
    let next = await writeState(current, "COMPATIBILITY_GATE");
    const previous = validVersion(previousVersion)
      ? await readMeta(`lifecycle:${previousVersion}`)
      : null;
    if (!previous || !compatibleLifecycleTuples(previous.compatibility_tuple, compatibilityTuple)) {
      await writeState(next, "EVICTED", { eviction_reason: "VERSION_MISMATCH" });
      throw lifecycleError("VERSION_MISMATCH");
    }
    next = await writeState(next, "DRAIN_OR_HANDOFF");
    const clients = await controlledWindowClients();
    if (!Array.isArray(clients) || clients.length !== 0) {
      await writeState(next, "EVICTED", { eviction_reason: "DRAIN_REQUIRED" });
      throw lifecycleError("DRAIN_REQUIRED");
    }
    return next;
  }

  async function activateOperation() {
    let current = await record();
    if (!current || current.state !== "INSTALLED_WAITING") {
      throw lifecycleError("LIFECYCLE_ACTIVATION_REJECTED");
    }
    const previousVersion = current.previous_worker_version;
    if (previousVersion !== null) current = await gateCompatibleUpdate(current, previousVersion);
    current = await writeState(current, "ACTIVATING");
    await writeMeta({
      key: "lifecycle:active",
      worker_version: compatibilityHash,
      transition_revision: current.transition_revision,
    });
    current = await writeState(current, "READY_COLD");
    if (previousVersion === null) await claimClients();
    return current;
  }

  async function coldStartOperation() {
    const current = await record();
    if (!current) throw lifecycleError("LIFECYCLE_COLD_START_REJECTED");
    if (current.state === "READY_COLD" || current.state === "HYDRATING") return current;
    if (current.state !== "READY_HOT") throw lifecycleError("LIFECYCLE_COLD_START_REJECTED");
    return writeState(current, "READY_COLD", {
      restart_generation: (current.restart_generation ?? 0) + 1,
    });
  }

  async function beginHydrationOperation(snapshot) {
    const current = await record();
    if (!current || (current.state !== "READY_COLD" && current.state !== "HYDRATING")) {
      throw lifecycleError("LIFECYCLE_HYDRATION_REJECTED");
    }
    if (!snapshot || typeof snapshot !== "object"
      || typeof snapshot.profile_id !== "string"
      || !Number.isSafeInteger(snapshot.capability_epoch) || snapshot.capability_epoch < 1) {
      throw lifecycleError("LIFECYCLE_SNAPSHOT_REJECTED");
    }
    return writeState(current, "HYDRATING", {
      snapshot: {
        profile_id: snapshot.profile_id,
        origin_id: snapshot.destination_origin_id,
        tab_id: snapshot.tab_id,
        entry_id: snapshot.entry_id,
        capability_epoch: snapshot.capability_epoch,
        coordinator_revision: snapshot.coordinator_revision,
      },
    });
  }

  async function readyHotOperation() {
    const current = await record();
    if (current?.state === "READY_HOT") return current;
    if (!current || current.state !== "HYDRATING") {
      throw lifecycleError("LIFECYCLE_READY_REJECTED");
    }
    return writeState(current, "READY_HOT");
  }

  async function evictOperation(reason) {
    const current = await record();
    if (!current) throw lifecycleError("LIFECYCLE_EVICTION_REJECTED");
    if (current.state === "EVICTED") return current;
    return writeState(current, "EVICTED", { eviction_reason: reason });
  }

  return Object.freeze({
    activate: () => serialized(activateOperation),
    beginHydration: (snapshot) => serialized(() => beginHydrationOperation(snapshot)),
    coldStart: () => serialized(coldStartOperation),
    evict: (reason = "EVICTED") => serialized(() => evictOperation(reason)),
    install: () => serialized(installOperation),
    readyHot: () => serialized(readyHotOperation),
    snapshot: () => serialized(record),
  });
}
