const text = new TextEncoder();

export function invalid(message, name = "InvalidStateError") {
  return new DOMException(message, name);
}

export function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} must be an object`, "TypeError");
  return value;
}

export function requireString(value, label, { min = 1, max = 4096 } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) throw invalid(`${label} is invalid`, "TypeError");
  return value;
}

export function requireInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${label} is invalid`, "TypeError");
  return value;
}

export function requireFunction(value, label) {
  if (typeof value !== "function") throw invalid(`${label} is required`, "TypeError");
  return value;
}

export function byteLength(value) {
  if (typeof value === "string") return text.encode(value).byteLength;
  if (value instanceof Uint8Array) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return text.encode(JSON.stringify(value)).byteLength;
}
function structuredScalarSize(value) {
  if (value === null || value === undefined) return 1;
  const type = typeof value;
  if (type === "string") return text.encode(value).byteLength;
  if (type === "number" || type === "bigint") return 8;
  if (type === "boolean") return 1;
  if (type === "object") return null;
  return 16;
}

function structuredBinarySize(value) {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  return null;
}

function pushStructuredChildren(stack, value) {
  if (value instanceof Map) {
    for (const [key, entry] of value) stack.push(key, entry);
    return;
  }
  if (value instanceof Set) {
    for (const entry of value) stack.push(entry);
    return;
  }
  for (const key of Object.keys(value)) stack.push(key, value[key]);
}

function addStructuredSize(state, amount, max) {
  state.total += amount;
  state.nodes += 1;
  return state.total <= max && state.nodes <= max;
}

export function structuredByteLength(value, max = Number.MAX_SAFE_INTEGER) {
  const stack = [value];
  const seen = new Set();
  const state = { nodes: 0, total: 0 };
  while (stack.length > 0) {
    const current = stack.pop();
    const scalarSize = structuredScalarSize(current);
    if (scalarSize !== null) {
      if (!addStructuredSize(state, scalarSize, max)) return max + 1;
      continue;
    }
    if (seen.has(current)) continue;
    seen.add(current);
    const binarySize = structuredBinarySize(current);
    if (!addStructuredSize(state, binarySize ?? 16, max)) return max + 1;
    if (binarySize === null) pushStructuredChildren(stack, current);
  }
  return state.total;
}

export function transferables(value, label = "transfer list", max = 32) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw invalid(`${label} is invalid`, "TypeError");
  const seen = new Set();
  for (const entry of value) {
    if ((typeof entry !== "object" && typeof entry !== "function") || entry === null || seen.has(entry)) {
      throw invalid(`${label} is invalid`, "DataCloneError");
    }
    seen.add(entry);
  }
  return value;
}


export function bytes(value, label, max) {
  let output;
  if (value instanceof Uint8Array) output = value;
  else if (value instanceof ArrayBuffer) output = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) output = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else throw invalid(`${label} must be bytes`, "TypeError");
  if (output.byteLength > max) throw invalid(`${label} exceeds limit`, "QuotaExceededError");
  return output;
}

export function equalBinding(left, right, { requireRegistration = false, requireVersion = false } = {}) {
  const fields = ["profile_id", "synthetic_origin", "client_epoch", "capability"];
  if (requireRegistration) fields.push("registration_id");
  if (requireVersion) fields.push("worker_version");
  return fields.every((field) => left?.[field] === right?.[field]);
}

export function normalizeBinding(value) {
  const binding = requireObject(value, "binding");
  const output = {
    profile_id: requireString(binding.profile_id, "binding.profile_id", { max: 256 }),
    synthetic_origin: normalizeOrigin(binding.synthetic_origin),
    client_epoch: requireInteger(binding.client_epoch, "binding.client_epoch", { min: 1 }),
    capability: requireString(binding.capability, "binding.capability", { max: 4096 }),
  };
  if (binding.registration_id !== undefined) output.registration_id = requireString(binding.registration_id, "binding.registration_id", { max: 256 });
  if (binding.worker_version !== undefined) output.worker_version = requireString(binding.worker_version, "binding.worker_version", { max: 256 });
  return Object.freeze(output);
}

export function normalizeOrigin(value) {
  const url = parseURL(value, "origin");
  if (url.pathname !== "/" || url.search || url.hash) throw invalid("origin must not contain a path, query, or fragment", "SecurityError");
  return url.origin;
}

export function parseURL(value, label, base) {
  const string = requireString(value, label, { max: 16384 });
  let url;
  try {
    url = new URL(string, base);
  } catch {
    throw invalid(`${label} is not a URL`, "TypeError");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw invalid(`${label} protocol is not permitted`, "SecurityError");
  if (url.username || url.password || url.hash) throw invalid(`${label} contains credentials or a fragment`, "SecurityError");
  return url;
}

export function sameOriginURL(value, origin, label) {
  const url = parseURL(value, label);
  if (url.origin !== origin) throw invalid(`${label} is outside the target origin`, "SecurityError");
  return url;
}

export function clone(value) {
  return structuredClone(value);
}

export function deferred() {
  let rejectPromise;
  let resolvePromise;
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return Object.freeze({
    get settled() { return settled; },
    promise,
    reject(reason) {
      if (settled) return false;
      settled = true;
      rejectPromise(reason);
      return true;
    },
    resolve(value) {
      if (settled) return false;
      settled = true;
      resolvePromise(value);
      return true;
    },
  });
}

export function boundedPush(list, value, max, label) {
  if (list.length >= max) throw invalid(`${label} limit exceeded`, "QuotaExceededError");
  list.push(value);
}

export function deadline(clock, milliseconds) {
  return clock.now() + milliseconds;
}

export function isPast(clock, timestamp) {
  return clock.now() >= timestamp;
}

const MODULE_ID = /^[a-f0-9]{64}$/u;

export function normalizeModuleImport(value) {
  const input = requireObject(value, "module import");
  if (
    Object.keys(input).length !== 3
    || !Object.hasOwn(input, "module_id")
    || !Object.hasOwn(input, "referrer_url")
    || !Object.hasOwn(input, "specifier")
  ) throw invalid("module import is invalid", "SecurityError");
  const moduleID = requireString(input.module_id, "module import module ID", { min: 64, max: 64 });
  if (!MODULE_ID.test(moduleID)) throw invalid("module import module ID is invalid", "SecurityError");
  return Object.freeze({
    moduleID,
    referrerURL: requireString(input.referrer_url, "module import referrer", { max: 16_384 }),
    specifier: requireString(input.specifier, "module import specifier", { min: 0, max: 16_384 }),
  });
}

export function moduleImportRecordMatches(record, expected) {
  return record !== null
    && typeof record === "object"
    && record.kind === "target-worker-module"
    && record.profile_id === expected.profileID
    && record.tab_id === expected.tabID
    && record.entry_id === expected.entryID
    && record.origin_id === expected.originID
    && record.capability === expected.capability
    && record.client_epoch === expected.clientEpoch
    && record.abi_identifier === expected.abiIdentifier
    && record.graph_id === expected.graphID
    && record.module_id === expected.moduleID
    && record.module_type === "javascript"
    && record.source_kind === "TargetServiceWorkerModule"
    && record.target_url === expected.referrerURL
    && typeof record.source === "string"
    && Number.isSafeInteger(record.expires_at)
    && record.expires_at > expected.now;
}
