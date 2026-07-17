function reject(message) {
  throw new TypeError(message);
}

function validLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) reject(`Invalid ${name}`);
  return value;
}

export function createBoundedRewriteCache({
  maxEntries,
  maxBytes,
  maxAgeMs,
  now = () => Date.now(),
  sizeOf,
  validate = () => true,
  epoch = () => 0,
} = {}) {
  validLimit(maxEntries, "maxEntries");
  validLimit(maxBytes, "maxBytes");
  validLimit(maxAgeMs, "maxAgeMs");
  if (
    typeof now !== "function"
    || typeof sizeOf !== "function"
    || typeof validate !== "function"
    || typeof epoch !== "function"
  ) {
    reject("Invalid cache callbacks");
  }

  const entries = new Map();
  const inFlight = new Map();
  let bytes = 0;
  let generation = 0;
  let currentEpoch = epoch();

  function remove(key) {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    bytes -= entry.bytes;
    return true;
  }

  function clearEntries() {
    entries.clear();
    bytes = 0;
  }

  function synchronizeEpoch() {
    const nextEpoch = epoch();
    if (!Object.is(nextEpoch, currentEpoch)) {
      clearEntries();
      inFlight.clear();
      currentEpoch = nextEpoch;
      generation += 1;
    }
    return generation;
  }

  function evictExpired(clock = now()) {
    for (const [key, entry] of entries) {
      if (clock - entry.createdAt >= maxAgeMs) remove(key);
    }
  }

  function evictToFit(extraBytes) {
    while (entries.size >= maxEntries || bytes + extraBytes > maxBytes) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) return;
      remove(oldest);
    }
  }

  function cachedValue(key) {
    const existing = entries.get(key);
    if (!existing) return undefined;
    if (validate(existing.value, key) !== true) {
      remove(key);
      return undefined;
    }
    entries.delete(key);
    entries.set(key, existing);
    return existing.value;
  }

  function retain(key, value, requestGeneration) {
    if (validate(value, key) !== true) reject("Invalid cache entry");
    const entryBytes = sizeOf(value);
    if (!Number.isSafeInteger(entryBytes) || entryBytes < 0) reject("Invalid cache entry size");
    synchronizeEpoch();
    if (requestGeneration !== generation || entryBytes > maxBytes) return value;
    evictExpired();
    evictToFit(entryBytes);
    entries.set(key, Object.freeze({ value, bytes: entryBytes, createdAt: now() }));
    bytes += entryBytes;
    return value;
  }

  async function getOrCreate(key, factory) {
    if (typeof key !== "string" || key.length === 0 || typeof factory !== "function") reject("Invalid cache request");
    const requestGeneration = synchronizeEpoch();
    evictExpired();
    const existing = cachedValue(key);
    if (existing !== undefined) return existing;
    const running = inFlight.get(key);
    if (running?.generation === requestGeneration) return running.promise;
    let operation;
    operation = (async () => retain(key, await factory(), requestGeneration))();
    inFlight.set(key, Object.freeze({ generation: requestGeneration, promise: operation }));
    try {
      return await operation;
    } finally {
      if (inFlight.get(key)?.promise === operation) inFlight.delete(key);
    }
  }

  function getOrCreateSync(key, factory) {
    if (typeof key !== "string" || key.length === 0 || typeof factory !== "function") reject("Invalid cache request");
    const requestGeneration = synchronizeEpoch();
    evictExpired();
    const existing = cachedValue(key);
    if (existing !== undefined) return existing;
    return retain(key, factory(), requestGeneration);
  }

  function clear() {
    clearEntries();
    inFlight.clear();
    currentEpoch = epoch();
    generation += 1;
  }

  return Object.freeze({
    clear,
    getOrCreate,
    getOrCreateSync,
    invalidate(predicate) {
      if (typeof predicate !== "function") reject("Invalid cache predicate");
      synchronizeEpoch();
      for (const [key, entry] of entries) if (predicate(key, entry.value)) remove(key);
    },
    snapshot() {
      synchronizeEpoch();
      evictExpired();
      return Object.freeze({ bytes, entries: entries.size, inFlight: inFlight.size });
    },
  });
}
