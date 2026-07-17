import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export class GateFailure extends Error {
  constructor(message, code = "gate_failure") {
    super(message);
    this.name = "GateFailure";
    this.code = code;
  }
}

export function invariant(condition, message, code = "invalid_input") {
  if (!condition) throw new GateFailure(message, code);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    invariant(Number.isFinite(value), "canonical JSON cannot contain a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  invariant(typeof value === "object", `canonical JSON cannot encode ${typeof value}`);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    invariant(value[key] !== undefined, `canonical JSON cannot encode undefined property ${key}`);
    result[key] = canonicalValue(value[key]);
  }
  return result;
}

/** RFC 8785-compatible for the report data types (finite numbers, strings, arrays, objects). */
export function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

export function canonicalDigest(value) {
  return sha256(canonicalJson(value));
}
function decodeEd25519PublicKey(rawBase64Url, code) {
  invariant(typeof rawBase64Url === "string" && /^[A-Za-z0-9_-]{43}$/u.test(rawBase64Url), "release signing key is not canonical base64url", code);
  const raw = Buffer.from(rawBase64Url, "base64url");
  invariant(raw.byteLength === 32, "release signing key is not an Ed25519 public key", code);
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    format: "der",
    type: "spki",
  });
}

function indexSignatureKeys(keys, label, code) {
  const keyByID = new Map();
  for (const key of keys) {
    invariant(
      key
        && typeof key.id === "string"
        && key.id.length > 0
        && typeof key.role === "string"
        && key.role.length > 0
        && typeof key.owner === "string"
        && key.owner.length > 0
        && typeof key.public_key === "string",
      `${label} signing key is malformed`,
      code,
    );
    invariant(!keyByID.has(key.id), `duplicate ${label} signing key ${key.id}`, code);
    keyByID.set(key.id, key);
  }
  return keyByID;
}

function verifySignatureEntry(signature, key, canonical, label, code) {
  try {
    return verifySignature(
      null,
      canonical,
      decodeEd25519PublicKey(key.public_key, code),
      Buffer.from(signature.signature, "base64url"),
    );
  } catch (error) {
    if (error instanceof GateFailure) throw error;
    throw new GateFailure(`cannot verify ${label} signature ${signature.key_id}: ${error.message}`, code);
  }
}

function collectVerifiedSignatures(entries, keyByID, canonical, label, code) {
  const verifiedRoles = new Set();
  const verifiedKeys = [];
  const verifiedOwners = new Set();
  const seen = new Set();
  for (const signature of entries) {
    invariant(
      signature
        && typeof signature.key_id === "string"
        && signature.key_id.length > 0
        && typeof signature.signature === "string"
        && /^[A-Za-z0-9_-]{86}$/u.test(signature.signature),
      `${label} signature entry is malformed`,
      code,
    );
    invariant(!seen.has(signature.key_id), `duplicate ${label} signature ${signature.key_id}`, code);
    seen.add(signature.key_id);
    const key = keyByID.get(signature.key_id);
    if (key && verifySignatureEntry(signature, key, canonical, label, code)) {
      verifiedKeys.push(key.id);
      verifiedRoles.add(key.role);
      verifiedOwners.add(key.owner);
    }
  }
  return { verifiedKeys, verifiedOwners, verifiedRoles };
}

export function verifyCanonicalThresholdSignature({
  value,
  signatures,
  keys,
  label = "signed artifact",
  code = "signature_invalid",
}) {
  invariant(keys && signatures, `${label} signature and release keys are required`, code);
  invariant(
    signatures.algorithm === "Ed25519"
      && signatures.canonicalization === "RFC8785"
      && signatures.key_epoch === keys.key_epoch,
    `${label} signature metadata mismatch`,
    code,
  );
  invariant(
    Number.isSafeInteger(keys.threshold)
      && keys.threshold >= 2
      && Array.isArray(keys.keys)
      && Array.isArray(signatures.signatures),
    `${label} signing data is malformed`,
    code,
  );
  const keyByID = indexSignatureKeys(keys.keys, label, code);
  const canonical = Buffer.from(canonicalJson(value).slice(0, -1), "utf8");
  const { verifiedKeys, verifiedOwners, verifiedRoles } = collectVerifiedSignatures(
    signatures.signatures,
    keyByID,
    canonical,
    label,
    code,
  );
  invariant(
    verifiedKeys.length >= keys.threshold
      && verifiedOwners.size >= keys.threshold
      && verifiedRoles.has("release")
      && verifiedRoles.has("security"),
    `${label} signature threshold not met`,
    code,
  );
  return Object.freeze({
    verified: true,
    algorithm: signatures.algorithm,
    canonicalization: signatures.canonicalization,
    key_epoch: signatures.key_epoch,
    development_only: keys.development_only === true || signatures.development_only === true,
    verified_keys: Object.freeze(verifiedKeys.sort()),
    verified_owners: Object.freeze([...verifiedOwners].sort()),
    verified_roles: Object.freeze([...verifiedRoles].sort()),
  });
}









const compiledSchemas = new WeakMap();

function compileJsonSchema(schema) {
  const validator = new Ajv2020({
    allErrors: true,
    strictSchema: true,
    strictTypes: false,
    strictRequired: false,
    validateFormats: true,
  });
  addFormats(validator);
  return validator.compile(schema);
}

export function validateJsonSchema(value, schema) {
  invariant(schema && typeof schema === "object" && !Array.isArray(schema), "JSON schema is required", "schema_invalid");
  let validate = compiledSchemas.get(schema);
  if (!validate) {
    try {
      validate = compileJsonSchema(schema);
    } catch (error) {
      throw new GateFailure(`cannot compile JSON schema: ${error.message}`, "schema_invalid");
    }
    compiledSchemas.set(schema, validate);
  }
  const valid = validate(value);
  const errors = (validate.errors ?? []).map(error => `${error.instancePath || "$"} ${error.message}`);
  return Object.freeze({ valid, errors: Object.freeze(errors) });
}

export async function readJson(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new GateFailure(`cannot read ${filePath}: ${error.message}`, "input_unavailable");
  }
  try {
    return { value: JSON.parse(raw), sha256: sha256(raw), raw };
  } catch (error) {
    throw new GateFailure(`invalid JSON in ${filePath}: ${error.message}`, "invalid_json");
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function validNonnegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateFixtureCoverage(config) {
  invariant(Array.isArray(config.fixtures) && config.fixtures.length >= 15, "performance config must declare at least fifteen fixtures");
  const ids = new Set();
  for (const fixture of config.fixtures) {
    invariant(typeof fixture?.id === "string" && fixture.id.length > 0 && !ids.has(fixture.id), "performance fixture ids must be unique and non-empty");
    ids.add(fixture.id);
    if (fixture.availability === "available") {
      invariant(/^[a-f0-9]{64}$/u.test(fixture.sha256), `available fixture ${fixture.id} requires a content digest`);
      for (const metric of ["dcl_delta", "lcp_delta", "cpu_delta"])
        invariant(typeof fixture.v1_baseline?.[metric] === "number" && Number.isFinite(fixture.v1_baseline[metric]) && fixture.v1_baseline[metric] >= 0, `available fixture ${fixture.id} requires nonnegative V1 ${metric}`);
    } else {
      invariant(fixture.availability === "unavailable" && fixture.sha256 === null && fixture.v1_baseline === null, `unavailable fixture ${fixture.id} must not carry unverified evidence`);
    }
  }
  for (const siteClass of ["content", "application", "editor_media_pwa"])
    invariant(config.fixtures.filter(fixture => fixture.site_class === siteClass).length >= 5, `performance config requires five ${siteClass} fixtures`);
}

function validateMeasurementPolicy(config, testMode) {
  const sampleFloor = testMode ? 1 : 30;
  const resampleFloor = testMode ? 1 : 10_000;
  invariant(Number.isInteger(config.warmups) && config.warmups >= 1, "performance config warmups must be at least one");
  invariant(Number.isInteger(config.measured_pairs) && config.measured_pairs >= sampleFloor, `performance config measured_pairs must be at least ${sampleFloor}`);
  invariant(Number.isInteger(config.bootstrap_resamples) && config.bootstrap_resamples >= resampleFloor, `performance config bootstrap_resamples must be at least ${resampleFloor}`);
  invariant(config.variance && validNonnegativeNumber(config.variance.max_cv) && config.variance.max_cv <= 0.1 && config.variance.on_exceed === "invalidate", "performance config variance policy must invalidate CV above 10%");
  invariant(config.pair_order === "alternating-native-mediated", "performance config must require alternating native/mediated pairs");
  invariant(config.aggregation?.threshold_percentile === 0.95 && config.aggregation?.paired_bootstrap_bound === "upper" && config.aggregation?.paired_bootstrap_confidence === 0.95, "performance config aggregation policy is incomplete");
}

function validateSiteClasses(config) {
  invariant(config.site_classes && typeof config.site_classes === "object", "performance config site_classes are required");
  for (const siteClass of ["content", "application", "editor_media_pwa"]) {
    const limits = config.site_classes[siteClass];
    invariant(limits && typeof limits === "object", `missing site class ${siteClass}`);
    for (const metric of ["dcl_delta", "lcp_delta", "inp_delta_ms", "cpu_delta"])
      invariant(validNonnegativeNumber(limits[metric]), `missing ${siteClass}.${metric}`);
  }
}

function validateSoak(config) {
  const soak = config.soak;
  invariant(soak && typeof soak === "object", "performance config soak is required");
  for (const key of ["hours", "warmup_minutes", "quiescence_minutes", "origins", "clients", "short_streams", "sse_streams", "websockets", "navigations_per_origin_per_minute", "abort_churn", "max_memory_bytes", "max_queue_depth"])
    invariant(validNonnegativeNumber(soak[key]), `missing soak.${key}`);
}

function validateGateThresholds(config) {
  invariant(config.gates && typeof config.gates === "object" && !Array.isArray(config.gates), "performance config gates are required");
  for (const [gate, threshold] of Object.entries(config.gates))
    invariant(nonEmptyString(gate) && validNonnegativeNumber(threshold), `invalid performance threshold ${gate}`);
}

function validatePerformancePrerequisites(config) {
  invariant(config.metric_definitions && typeof config.metric_definitions === "object", "performance config metric definitions are required");
  invariant(config.leak_tolerances?.performance && config.leak_tolerances?.soak && config.v1_aggregate, "performance config leak and V1 aggregate policies are required");
  invariant(config.packet_capture?.backend === "tcpdump" && typeof config.packet_capture.interface === "string" && typeof config.packet_capture.certified === "boolean", "performance config packet capture prerequisite is required");
  invariant(/^[a-f0-9]{64}$/u.test(config.toolchains_sha256), "performance config requires the canonical toolchain manifest digest");
  invariant(/^[a-f0-9]{64}$/u.test(config.browser_boundaries_sha256), "performance config requires the browser-boundary manifest digest");
}

function validateReferencePlatform(config) {
  invariant(config.reference_platform && typeof config.reference_platform === "object", "performance config reference_platform is required");
  invariant(nonEmptyString(config.reference_platform.os), "performance config reference_platform.os is required");
  invariant(nonEmptyString(config.reference_platform.arch), "performance config reference_platform.arch is required");
  invariant(config.reference_platform.hardware && typeof config.reference_platform.hardware === "object", "performance config exact hardware declaration is required");
}

function validatePerformanceCollections(config) {
  invariant(Array.isArray(config.browser_lanes) && config.browser_lanes.length === 2, "performance config must declare exactly two browser lanes");
  const browserFamilies = new Set(config.browser_lanes.map(lane => lane?.family));
  invariant(browserFamilies.size === 2 && browserFamilies.has("chromium") && browserFamilies.has("firefox"), "performance config requires exact Chromium and Firefox lanes");
  invariant(config.browser_lanes.every(lane => lane.availability === "available"), "performance browser lanes must be available");
  invariant(Array.isArray(config.deferred_browser_families) && config.deferred_browser_families.length === 0, "performance config cannot defer a supported browser family");
  validateFixtureCoverage(config);
  invariant(Array.isArray(config.cache_modes) && config.cache_modes.includes("cold") && config.cache_modes.includes("warm"), "performance config requires cold and warm cache modes");
}

function validatePerformanceEnvelope(config) {
  invariant(config && typeof config === "object" && !Array.isArray(config), "performance config must be an object");
  invariant(config.schema_version === 2, "unsupported performance config schema_version");
  invariant(nonEmptyString(config.release_id), "performance config release_id is required");
}

function validatePerformanceConfigBody(config, testMode) {
  validatePerformanceEnvelope(config);
  validateReferencePlatform(config);
  validatePerformanceCollections(config);
  validateMeasurementPolicy(config, testMode);
  validatePerformancePrerequisites(config);
  validateGateThresholds(config);
  validateSiteClasses(config);
  validateSoak(config);
}

export function validatePerformanceConfig(config, { testMode = false } = {}) {
  validatePerformanceConfigBody(config, testMode);
  return config;
}


export async function loadPerformanceConfig(configPath, options = {}) {
  const loaded = await readJson(configPath);
  const configDirectory = path.dirname(configPath);
  const schemaPath = options.schemaPath ?? path.join(configDirectory, "performance-gates.schema.json");
  const authorityDirectory = options.authorityDirectory ?? path.dirname(schemaPath);
  const [schema, toolchains, browserBoundaries] = await Promise.all([
    readJson(schemaPath),
    readJson(path.join(authorityDirectory, "toolchains.json")),
    readJson(path.join(authorityDirectory, "browser-boundaries.json")),
  ]);
  const schemaResult = validateJsonSchema(loaded.value, schema.value);
  invariant(schemaResult.valid, `performance config schema validation failed: ${schemaResult.errors.join("; ")}`, "invalid_config");
  invariant(canonicalDigest(toolchains.value) === loaded.value.toolchains_sha256, "performance config toolchain digest does not match protocol/toolchains.json", "invalid_config");
  invariant(canonicalDigest(browserBoundaries.value) === loaded.value.browser_boundaries_sha256, "performance config browser-boundary digest does not match protocol/browser-boundaries.json", "invalid_config");
  validatePerformanceConfig(loaded.value, options);
  return { config: loaded.value, configSha256: loaded.sha256, configSchema: schema };
}

async function walkBuildTree(root, relative = "") {
  const current = path.join(root, relative);
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    throw new GateFailure(`cannot enumerate build directory ${root}: ${error.message}`, "build_unavailable");
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
    const child = path.join(root, childRelative);
    const stat = await lstat(child);
    if (stat.isSymbolicLink()) throw new GateFailure(`build directory contains a symlink: ${childRelative}`, "build_identity_invalid");
    if (stat.isDirectory()) {
      files.push(...await walkBuildTree(root, childRelative));
    } else if (stat.isFile()) {
      const contents = await readFile(child);
      files.push({ path: childRelative, sha256: sha256(contents), size_bytes: contents.byteLength });
    } else {
      throw new GateFailure(`build directory contains unsupported entry: ${childRelative}`, "build_identity_invalid");
    }
  }
  return files;
}

export async function collectBuildIdentity(buildDir) {
  invariant(nonEmptyString(buildDir), "a build directory is required", "build_unavailable");
  const root = path.resolve(buildDir);
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    throw new GateFailure(`cannot inspect build directory ${root}: ${error.message}`, "build_unavailable");
  }
  invariant(rootStat.isDirectory(), `build path is not a directory: ${root}`, "build_unavailable");
  const assets = await walkBuildTree(root);
  invariant(assets.length > 0, "build directory contains no assets", "build_identity_invalid");
  return {
    root,
    assets,
    tree_sha256: canonicalDigest(assets),
  };
}

export function runtimeIdentity() {
  return {
    architecture: process.arch,
    os: `${process.platform}-${os.release()}`,
    node: process.version,
    toolchain: {
      node_executable: process.execPath,
      node_version: process.version,
    },
  };
}

export function releaseTuple(config, configSha256, build) {
  return {
    release_id: config.release_id,
    performance_config_sha256: configSha256,
    build_tree_sha256: build.tree_sha256,
  };
}

function isPlaceholderBuild(build) {
  return /^(?:pending|not-certified|unknown|unset)$/i.test(build);
}

export function verifyBrowserPin({ config, browser, boundary, testMode = false }) {
  invariant(browser && typeof browser === "object", "adapter did not provide browser identity", "browser_pin_missing");
  invariant(nonEmptyString(browser.family), "browser identity family is required", "browser_pin_missing");
  invariant(nonEmptyString(browser.exact_build), "browser identity exact_build is required", "browser_pin_missing");
  invariant(!isPlaceholderBuild(browser.exact_build), `browser build is not an exact build: ${browser.exact_build}`, "browser_pin_missing");
  const configuredPin = `${browser.family}-${browser.exact_build}`;
  const configuredLane = config.browser_lanes?.find(lane => lane.family === browser.family && lane.exact_build === browser.exact_build && lane.availability === "available");
  if (configuredLane === undefined) {
    invariant(testMode && config.reference_platform.browser_builds?.includes(configuredPin), `browser ${configuredPin} is not an available exact performance-gates browser lane`, "browser_pin_mismatch");
  }
  invariant(runtimeIdentity().os === config.reference_platform.os, `host OS ${runtimeIdentity().os} does not match configured ${config.reference_platform.os}`, "platform_mismatch");
  invariant(process.arch === config.reference_platform.arch, `host architecture ${process.arch} does not match configured ${config.reference_platform.arch}`, "platform_mismatch");
  if (testMode) return { configured_pin: configuredPin, boundary_pin_verified: false, release_supported: false, packet_capture_certified: false };
  invariant(configuredLane && browser.binary_sha256 === configuredLane.binary_sha256, `browser ${configuredPin} executable digest does not match its configured lane`, "browser_pin_mismatch");

  invariant(boundary && Array.isArray(boundary.browser_lanes), "browser boundary declarations are unavailable", "browser_pin_missing");
  const expectedPlatform = `${process.platform}-${process.arch}`;
  const lane = boundary.browser_lanes.find(candidate => candidate.family === browser.family && candidate.exact_build === browser.exact_build && candidate.platform === expectedPlatform);
  invariant(lane, `browser ${configuredPin} is not pinned in browser-boundaries.json for ${expectedPlatform}`, "browser_pin_mismatch");
  return {
    configured_pin: configuredPin,
    boundary_pin_verified: true,
    binary_sha256_verified: true,
    release_supported: lane.release_supported === true,
    packet_capture_certified: lane.packet_capture_certified === true,
  };
}
export function productionCertification({ testMode, status, browserPin, prerequisites = [] }) {
  if (testMode) return Object.freeze({ claimed: false, reason: "test-mode evidence cannot certify a release" });
  if (status !== "pass") return Object.freeze({ claimed: false, reason: "gate violations prevent certification" });
  if (browserPin?.boundary_pin_verified !== true || browserPin.release_supported !== true)
    return Object.freeze({ claimed: false, reason: "browser boundary is not release-supported" });
  const missing = prerequisites.filter(value => value !== true).length;
  if (missing > 0) return Object.freeze({ claimed: false, reason: "production evidence prerequisites are incomplete" });
  return Object.freeze({ claimed: true, reason: "production gate passed on a release-supported pinned browser" });
}
export function reportCommandSummary(reportPath, report) {
  invariant(typeof reportPath === "string" && reportPath.length > 0, "report output path is required");
  invariant(report?.certification && typeof report.certification.claimed === "boolean", "report certification result is required");
  return Object.freeze({
    report: reportPath,
    status: report.status,
    certification_claimed: report.certification.claimed,
  });
}

export async function loadBrowserBoundaries(boundaryPath) {
  return (await readJson(boundaryPath)).value;
}

export function parseArgs(argv, { flags = [], values = [] } = {}) {
  const result = { _: [] };
  const knownFlags = new Set(flags);
  const knownValues = new Set(values);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      result._.push(arg);
      continue;
    }
    const [name, inlineValue] = arg.slice(2).split("=", 2);
    if (knownFlags.has(name)) {
      invariant(inlineValue === undefined, `--${name} does not accept a value`);
      result[name] = true;
      continue;
    }
    invariant(knownValues.has(name), `unknown option --${name}`, "invalid_cli");
    const value = inlineValue ?? argv[++index];
    invariant(value !== undefined && !value.startsWith("--"), `--${name} requires a value`, "invalid_cli");
    result[name] = value;
  }
  return result;
}

export async function loadAdapter(adapterPath, factoryName) {
  invariant(nonEmptyString(adapterPath), `--adapter is required for ${factoryName}`, "adapter_missing");
  let module;
  try {
    module = await import(pathToFileURL(path.resolve(adapterPath)).href);
  } catch (error) {
    throw new GateFailure(`cannot load adapter ${adapterPath}: ${error.message}`, "adapter_missing");
  }
  const factory = module[factoryName];
  invariant(typeof factory === "function", `adapter ${adapterPath} must export ${factoryName}(context)`, "adapter_invalid");
  return factory;
}

export async function writeCanonicalReport(outputPath, report) {
  invariant(nonEmptyString(outputPath), "--output is required", "output_missing");
  const destination = path.resolve(outputPath);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, canonicalJson(report), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, destination);
  return destination;
}

export async function withTemporaryDirectory(prefix, callback) {
  const root = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function nearestRank(values, percentile) {
  invariant(Array.isArray(values) && values.length > 0, "percentile requires at least one sample");
  invariant(typeof percentile === "number" && percentile > 0 && percentile <= 1, "percentile must be in (0, 1]");
  const sorted = [...values];
  for (const value of sorted) invariant(Number.isFinite(value), "percentile samples must be finite");
  sorted.sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

export function coefficientOfVariation(values) {
  invariant(Array.isArray(values) && values.length > 0, "coefficient of variation requires at least one sample");
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  if (mean === 0) {
    invariant(variance === 0, "coefficient of variation is undefined for varying zero-mean samples", "measurement_unavailable");
    return 0;
  }
  return Math.sqrt(variance) / Math.abs(mean);
}

function fnv1a(input) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function seededRandom(seed) {
  invariant(nonEmptyString(seed), "deterministic seed is required");
  let state = fnv1a(seed) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

export function bootstrapPairedMeanCI(pairs, resamples, seed) {
  invariant(Array.isArray(pairs) && pairs.length > 0, "bootstrap requires paired samples");
  invariant(Number.isInteger(resamples) && resamples >= 1, "bootstrap resamples must be a positive integer");
  const deltas = pairs.map(pair => {
    invariant(pair && Number.isFinite(pair.native) && Number.isFinite(pair.mediated), "bootstrap pair values must be finite");
    return pair.mediated - pair.native;
  });
  const random = seededRandom(seed);
  const means = new Array(resamples);
  for (let sample = 0; sample < resamples; sample += 1) {
    let total = 0;
    for (let index = 0; index < deltas.length; index += 1)
      total += deltas[Math.floor(random() * deltas.length)];
    means[sample] = total / deltas.length;
  }
  return {
    method: "paired-mean-bootstrap-nearest-rank-v1",
    resamples,
    seed,
    lower: nearestRank(means, 0.025),
    upper: nearestRank(means, 0.975),
  };
}

export function finiteNonnegative(value, label) {
  invariant(validNonnegativeNumber(value), `${label} must be a finite non-negative number`);
  return value;
}

export function moduleDirectory(metaUrl) {
  return path.dirname(fileURLToPath(metaUrl));
}
