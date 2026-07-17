import { createBoundedRewriteCache } from "../compiler-cache.mjs";
import {
  COMPILER_RESULT_SCHEMA_VERSION,
  decodeCompilerResult,
  decodeDynamicCompilerResult,
  validateCompilerResult,
  validateDynamicCompilerResult,
} from "../compiler-result.mjs";

let compilerPromise;
const ABI_IDENTIFIER = /^__zp_abi_[a-f0-9]{48}$/u;
const CACHE_KEY = /^[a-f0-9]{64}$/u;
const encoder = new TextEncoder();

function randomABIIdentifier() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `__zp_abi_${[...bytes].map(value => value.toString(16).padStart(2, "0")).join("")}`;
}

export function isCompilerABIIdentifier(value) {
  return typeof value === "string" && ABI_IDENTIFIER.test(value);
}

function compilerOptions(value) {
  const options = value ?? {};
  const allowed = ["abiIdentifier", "cacheEpoch", "realmID", "referrer"];
  if (
    !options
    || typeof options !== "object"
    || Array.isArray(options)
    || Object.keys(options).some(key => !allowed.includes(key))
  ) {
    throw new DOMException("Invalid compiler context", "SecurityError");
  }
  return options;
}

function validCacheEpoch(value) {
  if (typeof value === "string") return value.length > 0 && value.length <= 256;
  return Number.isSafeInteger(value) && value >= 0;
}

function canonicalCompilerReferrer(value) {
  try {
    return new URL(value).href;
  } catch {
    throw new DOMException("Invalid compiler referrer", "SecurityError");
  }
}

function compilerContext(value) {
  const options = compilerOptions(value);
  const abiIdentifier = options.abiIdentifier ?? randomABIIdentifier();
  if (!isCompilerABIIdentifier(abiIdentifier)) {
    throw new DOMException("Invalid compiler ABI identifier", "SecurityError");
  }
  const realmID = options.realmID ?? abiIdentifier;
  const cacheEpoch = options.cacheEpoch ?? abiIdentifier;
  const defaultReferrer = typeof globalThis.location?.href === "string"
    ? globalThis.location.href
    : "zeroproxy://compiler/referrer";
  if (
    typeof realmID !== "string"
    || realmID.length === 0
    || realmID.length > 256
    || !validCacheEpoch(cacheEpoch)
  ) {
    throw new DOMException("Invalid compiler cache context", "SecurityError");
  }
  const referrer = canonicalCompilerReferrer(options.referrer ?? defaultReferrer);
  return Object.freeze({ abiIdentifier, cacheEpoch, realmID, referrer });
}

async function loadVersion() {
  const response = await fetch("/_zp/version.json", { cache: "no-store" });
  if (!response.ok) throw new DOMException("Compiler manifest unavailable", "NetworkError");
  const version = await response.json();
  if (version.version !== 2) {
    throw new DOMException("Compiler version mismatch", "InvalidStateError");
  }
  return version;
}

function loadCompilerVersions(module, manifest) {
  let value;
  try {
    value = JSON.parse(module.compiler_versions_json());
  } catch {
    throw new DOMException("Compiler cache versions unavailable", "InvalidStateError");
  }
  if (
    value?.cache_schema_version !== 1
    || value.result_schema_version !== COMPILER_RESULT_SCHEMA_VERSION
    || value.abi_version !== 1
    || typeof value.compiler_version !== "string"
    || value.compiler_version.length === 0
    || typeof value.parser_version !== "string"
    || value.parser_version.length === 0
    || !Array.isArray(value.browser_versions)
    || value.browser_versions.length !== 2
    || value.browser_versions.some(version => typeof version !== "string" || version.length === 0)
    || typeof manifest.compatibility_hash !== "string"
    || manifest.compatibility_hash.length === 0
    || !Number.isSafeInteger(manifest.compatibility_tuple?.policy_version)
    || manifest.compatibility_tuple.policy_version < 1
    || typeof manifest.release_id !== "string"
    || manifest.release_id.length === 0
  ) {
    throw new DOMException("Compiler cache version mismatch", "InvalidStateError");
  }
  Object.freeze(value.browser_versions);
  return Object.freeze({
    ...value,
    browser_version: manifest.compatibility_hash,
    policy_version: manifest.compatibility_tuple.policy_version,
    rewrite_artifact_version: manifest.release_id,
  });
}

async function loadCompiler() {
  if (!compilerPromise) {
    compilerPromise = (async () => {
      const manifest = await loadVersion();
      const moduleURL = manifest.selectors?.["js_compiler.js"];
      const wasmURL = manifest.selectors?.["js_compiler.wasm"];
      if (typeof moduleURL !== "string" || typeof wasmURL !== "string") {
        throw new DOMException("Compiler assets missing", "InvalidStateError");
      }
      const module = await import(moduleURL);
      await module.default(wasmURL);
      if (
        typeof module.compile_json !== "function"
        || typeof module.compile_json_with_direct_eval_strictness !== "function"
        || typeof module.compile_dynamic_function_json !== "function"
        || typeof module.compiler_cache_key !== "function"
        || typeof module.compiler_versions_json !== "function"
      ) {
        throw new DOMException("Compiler ABI unavailable", "InvalidStateError");
      }
      return Object.freeze({
        module,
        versions: loadCompilerVersions(module, manifest),
      });
    })();
  }
  return compilerPromise;
}

function directEvalStrictness(sourceKind, metadata) {
  if (sourceKind !== "DirectEvalScript") {
    if (metadata !== undefined) throw new TypeError("metadata is only valid for direct eval");
    return null;
  }
  if (
    !metadata
    || typeof metadata !== "object"
    || Array.isArray(metadata)
    || Object.keys(metadata).length !== 1
    || typeof metadata.caller_strict !== "boolean"
  ) {
    throw new TypeError("direct eval requires caller_strict metadata");
  }
  return metadata.caller_strict;
}

function compilerFailure(result, syntax = false) {
  const code = result.error.code;
  if (syntax && code === "PARSE_FAILED") throw new SyntaxError("Invalid executable source");
  throw new DOMException(code, "SecurityError");
}

function freezeRecord(record) {
  return record && typeof record === "object" ? Object.freeze(record) : record;
}

function freezeCompilerResult(result) {
  if (result.ok === false) {
    Object.freeze(result.edits);
    Object.freeze(result.edit_map);
    Object.freeze(result.module_specifiers);
    Object.freeze(result.diagnostics);
    Object.freeze(result.error);
    return Object.freeze(result);
  }
  result.edits.forEach(freezeRecord);
  result.edit_map.forEach(freezeRecord);
  result.module_specifiers.forEach(freezeRecord);
  result.diagnostics.forEach(freezeRecord);
  Object.freeze(result.edits);
  Object.freeze(result.edit_map);
  Object.freeze(result.module_specifiers);
  Object.freeze(result.diagnostics);
  Object.freeze(result.source_map.names);
  Object.freeze(result.source_map.sources);
  Object.freeze(result.source_map.sourcesContent);
  Object.freeze(result.source_map);
  if (Array.isArray(result.abi_slots)) {
    result.abi_slots.forEach(freezeRecord);
    Object.freeze(result.abi_slots);
  }
  if (Array.isArray(result.abi_identifiers)) Object.freeze(result.abi_identifiers);
  return Object.freeze(result);
}

function freezeDynamicCompilerResult(result) {
  if (result.ok === false) return freezeCompilerResult(result);
  result.parameters = Object.freeze(result.parameters.map(freezeCompilerResult));
  result.body = freezeCompilerResult(result.body);
  result.diagnostics.forEach(freezeRecord);
  result.diagnostics = Object.freeze(result.diagnostics);
  return Object.freeze(result);
}

function cacheEntryValid(entry, versions) {
  if (
    entry?.abi_version !== versions.abi_version
    || entry.browser_version !== versions.browser_version
    || entry.cache_schema_version !== versions.cache_schema_version
    || entry.compiler_version !== versions.compiler_version
    || entry.parser_version !== versions.parser_version
    || entry.policy_version !== versions.policy_version
    || entry.result_schema_version !== versions.result_schema_version
    || entry.rewrite_artifact_version !== versions.rewrite_artifact_version
    || typeof entry.dynamic !== "boolean"
  ) {
    return false;
  }
  try {
    if (entry.dynamic) validateDynamicCompilerResult(entry.result);
    else validateCompilerResult(entry.result);
    return Object.isFrozen(entry.result);
  } catch {
    return false;
  }
}

function cacheKey(module, source, context) {
  const key = module.compiler_cache_key(source, JSON.stringify(context));
  if (typeof key !== "string" || !CACHE_KEY.test(key)) {
    throw new TypeError("Invalid compiler cache key");
  }
  return key;
}

function cacheEntry(result, dynamic, versions) {
  return Object.freeze({
    abi_version: versions.abi_version,
    browser_version: versions.browser_version,
    cache_schema_version: versions.cache_schema_version,
    compiler_version: versions.compiler_version,
    dynamic,
    parser_version: versions.parser_version,
    policy_version: versions.policy_version,
    result,
    result_schema_version: versions.result_schema_version,
    rewrite_artifact_version: versions.rewrite_artifact_version,
  });
}

export async function createCompiler(options) {
  const context = compilerContext(options);
  const { module, versions } = await loadCompiler();
  const cache = createBoundedRewriteCache({
    epoch: () => `${context.cacheEpoch}\0${versions.browser_version}`,
    maxAgeMs: 5 * 60_000,
    maxBytes: 16 << 20,
    maxEntries: 128,
    sizeOf: entry => encoder.encode(JSON.stringify(entry)).byteLength,
    validate: entry => cacheEntryValid(entry, versions),
  });
  const sharedKeyContext = Object.freeze({
    abi_version: versions.abi_version,
    browser_version: versions.browser_version,
    cache_schema_version: versions.cache_schema_version,
    compiler_version: versions.compiler_version,
    parser_version: versions.parser_version,
    policy_version: versions.policy_version,
    realm: context.realmID,
    referrer: context.referrer,
    result_schema_version: versions.result_schema_version,
    rewrite_artifact_version: versions.rewrite_artifact_version,
  });
  const abiIdentifier = context.abiIdentifier;
  return Object.freeze({
    abiIdentifier,
    compile(source, sourceKind, metadata) {
      if (typeof source !== "string") throw new TypeError("source must be a string");
      const callerStrict = directEvalStrictness(sourceKind, metadata);
      let entry;
      try {
        const key = cacheKey(module, source, {
          ...sharedKeyContext,
          family: sourceKind,
          strictness: callerStrict,
          type: "source",
        });
        entry = cache.getOrCreateSync(key, () => {
          const encoded = callerStrict === null
            ? module.compile_json(source, sourceKind, abiIdentifier)
            : module.compile_json_with_direct_eval_strictness(
              source,
              sourceKind,
              abiIdentifier,
              callerStrict,
            );
          return cacheEntry(freezeCompilerResult(decodeCompilerResult(encoded)), false, versions);
        });
      } catch (error) {
        if (error instanceof TypeError && error.message === "Invalid compiler result") {
          throw new DOMException("Invalid compiler result", "DataError");
        }
        throw new DOMException("Compiler unavailable", "InvalidStateError");
      }
      if (entry.result.ok !== true) {
        compilerFailure(
          entry.result,
          sourceKind === "DirectEvalScript"
            || sourceKind === "IndirectEvalScript"
            || sourceKind === "TimerString",
        );
      }
      return entry.result;
    },
    compileDynamicFunction(parameters, body, sourceKind) {
      if (
        !Array.isArray(parameters)
        || parameters.some(parameter => typeof parameter !== "string")
        || typeof body !== "string"
      ) {
        throw new TypeError("dynamic function source must be strings");
      }
      let entry;
      try {
        const source = JSON.stringify({ body, parameters });
        const key = cacheKey(module, source, {
          ...sharedKeyContext,
          family: sourceKind,
          strictness: null,
          type: "dynamic-function",
        });
        entry = cache.getOrCreateSync(key, () => cacheEntry(
          freezeDynamicCompilerResult(decodeDynamicCompilerResult(
            module.compile_dynamic_function_json(
              JSON.stringify(parameters),
              body,
              sourceKind,
              abiIdentifier,
            ),
          )),
          true,
          versions,
        ));
      } catch (error) {
        if (error instanceof TypeError && error.message === "Invalid dynamic compiler result") {
          throw new DOMException("Invalid dynamic compiler result", "DataError");
        }
        throw new DOMException("Compiler unavailable", "InvalidStateError");
      }
      if (entry.result.ok !== true) compilerFailure(entry.result, true);
      return entry.result;
    },
  });
}
