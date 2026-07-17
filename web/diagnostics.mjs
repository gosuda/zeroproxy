import { ERROR_CODES, ERROR_STAGES, errorSpecification } from "./generated/errors.mjs";

const requestIDPattern = /^[A-Za-z0-9_-]{16,64}$/u;
const releaseTuplePattern = /^[a-f0-9]{64}$/u;
const maximumCounters = 256;

function knownError(code, stage) {
  return ERROR_CODES.includes(code)
    && ERROR_STAGES.includes(stage)
    && errorSpecification(code).stages.includes(stage);
}

function targetHostname(targetURL) {
  if (typeof targetURL !== "string") return null;
  try {
    const parsed = new URL(targetURL);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname : null;
  } catch {
    return null;
  }
}

export function createLocalDiagnostic(input) {
  if (input === null
    || typeof input !== "object"
    || !requestIDPattern.test(input.request_id)
    || !knownError(input.code, input.stage)) {
    throw new TypeError("Invalid local diagnostic");
  }
  return Object.freeze({
    schema_version: 1,
    kind: "local",
    target_hostname: targetHostname(input.target_url),
    request_id: input.request_id,
    code: input.code,
    stage: input.stage,
  });
}

export function createTelemetryBuffer({ releaseTuple, send }) {
  if (!releaseTuplePattern.test(releaseTuple) || typeof send !== "function") {
    throw new TypeError("Invalid telemetry configuration");
  }
  const counters = new Map();
  function optedIn(profile) {
    return profile !== null && typeof profile === "object" && profile.telemetry_opt_in === true;
  }
  return Object.freeze({
    record(profile, input) {
      if (!optedIn(profile)) return false;
      const local = createLocalDiagnostic(input);
      const key = `${local.stage}\0${local.code}`;
      if (!counters.has(key) && counters.size >= maximumCounters) return false;
      counters.set(key, Math.min(0xffff_ffff, (counters.get(key) ?? 0) + 1));
      return true;
    },
    async flush(profile) {
      if (!optedIn(profile) || counters.size === 0) return false;
      const entries = [...counters.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, count]) => {
          const [stage, code] = key.split("\0");
          return Object.freeze({ stage, code, count });
        });
      const batch = Object.freeze({
        schema_version: 1,
        kind: "telemetry",
        release_tuple: releaseTuple,
        counters: Object.freeze(entries),
      });
      await send(batch);
      counters.clear();
      return true;
    },
  });
}
