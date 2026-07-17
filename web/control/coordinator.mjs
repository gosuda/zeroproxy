import { canonicalTarget, POLICY_VERSION } from "../generated/policy.mjs";
import { createPublicError, errorSpecification } from "../generated/errors.mjs";
import {
  COORDINATOR_DB_VERSION,
  openCookieRecord,
  openCoordinatorDatabase,
  sealCookieRecord,
} from "./coordinator-database.mjs";
import { deriveOriginID } from "./origin.mjs";
import { verifyRelayProfileSet } from "./relay-profile.mjs";

const COOKIE_STATE_VERSION = 1;
const encoder = new TextEncoder();
const opaqueIDPattern = /^[A-Za-z0-9_-]{32}$/;
const errorRequestIDPattern = /^[A-Za-z0-9_-]{16,64}$/;
const cookieQueues = new Map();
const attachedPorts = new Set();
const portBindings = new WeakMap();
const cookiePortProfiles = new Map();
let cookieCorePromise;
let coordinatorMessageQueue = Promise.resolve();
let relayProfilesInFlight;

function request(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function complete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

function randomID(bytes = 24) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function coordinatorError(code, name = "SecurityError") {
  const error = new Error(code);
  error.name = name;
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactObject(value, required, optional = []) {
  if (!isPlainObject(value)) throw new TypeError("invalid coordinator payload");
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowed.has(key))
    || required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError("invalid coordinator payload");
  }
  return value;
}

function requiredString(value, maximum = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError("invalid coordinator string");
  }
  return value;
}

function sequence(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("invalid cookie sequence");
  }
  return value;
}

function nowUnixSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function base64URL(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 32 << 10) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + (32 << 10))));
  }
  return btoa(chunks.join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeBase64URL(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/u.test(value)) throw new TypeError("invalid base64url value");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  let binary;
  try { binary = atob(padded); } catch { throw new TypeError("invalid base64url value"); }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (base64URL(bytes) !== value) throw new TypeError("invalid base64url value");
  return bytes;
}

async function digest(value) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(value))),
  );
  return base64URL(bytes);
}

async function sealText(keyBytes, text, aad) {
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(aad) },
      key,
      encoder.encode(text),
    ),
  );
  return { nonce, ciphertext };
}

async function openText(keyBytes, sealed, aad) {
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.nonce, additionalData: encoder.encode(aad) },
    key,
    sealed.ciphertext,
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(plain);
}

async function deriveIsolationCredentials(
  profile,
  tab,
  originID,
  documentCapability,
  relayProfileDigests,
  relayCapabilities,
) {
  if (!tab?.encrypted_stream_key || typeof tab.session_id !== "string") {
    throw new DOMException("Isolation stream root unavailable", "SecurityError");
  }
  const streamRoot = await openText(
    profile.capability_root,
    tab.encrypted_stream_key,
    `${profile.profile_id}\0stream\0${tab.session_id}`,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(streamRoot),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const binding = JSON.stringify({
    v: 2,
    profile_id: profile.profile_id,
    session_id: tab.session_id,
    tab_id: tab.tab_id,
    origin_id: originID,
    capability_epoch: profile.capability_epoch,
    document_capability: documentCapability,
    relays: relayCapabilities.map((capability, index) => ({
      relay_profile_digest: relayProfileDigests[index],
      capability_id: capability.capability_id,
    })),
  });
  const derive = async label => base64URL(new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`zeroproxy-tor-isolation-v2\0${label}\0${binding}`),
  )));
  return {
    isolation_username: await derive("username"),
    isolation_password: await derive("password"),
  };
}

const databasePromise = openCoordinatorDatabase();

function assetSelector(manifest, name) {
  const value = manifest?.selectors?.[name];
  const matcher = new RegExp(`^/_zp/assets/[a-f0-9]{64}/${name.replace(".", "\\.")}$`);
  if (typeof value !== "string" || !matcher.test(value)) {
    throw coordinatorError("COOKIE_CORE_UNAVAILABLE", "InvalidStateError");
  }
  return value;
}

async function fetchVersionManifest() {
  try {
    const response = await fetch("/_zp/version.json", { cache: "no-store" });
    if (!response.ok) throw new Error("version manifest unavailable");
    const manifest = await response.json();
    if (manifest?.version !== 2) throw new Error("version mismatch");
    return manifest;
  } catch {
    throw coordinatorError("COOKIE_CORE_UNAVAILABLE", "InvalidStateError");
  }
}

function validateCookieCore(module) {
  for (const name of [
    "apply_cookie_mutation_json",
    "snapshot_cookie_state_json",
    "document_cookie_projection_json",
    "cookie_header_for_context_json",
  ]) {
    if (typeof module[name] !== "function")
      throw coordinatorError("COOKIE_CORE_UNAVAILABLE", "InvalidStateError");
  }
  return module;
}

async function initializeCookieCore() {
  const manifest = await fetchVersionManifest();
  try {
    const module = await import(assetSelector(manifest, "cookie_core.js"));
    await module.default(assetSelector(manifest, "cookie_core.wasm"));
    return validateCookieCore(module);
  } catch {
    throw coordinatorError("COOKIE_CORE_UNAVAILABLE", "InvalidStateError");
  }
}

async function loadCookieCore() {
  cookieCorePromise ??= initializeCookieCore();
  return cookieCorePromise;
}

async function installedRelayProfiles() {
  if (relayProfilesInFlight) return relayProfilesInFlight;
  const loading = fetch("/control/config.json", { cache: "no-store", credentials: "same-origin" })
    .then(async (response) => {
      if (!response.ok) throw coordinatorError("RELAY_PROFILE_CONFIG_UNAVAILABLE", "InvalidStateError");
      const config = await response.json();
      const profiles = await verifyRelayProfileSet(config);
      if (!Array.isArray(config.installed_relay_profile_digests)
        || config.installed_relay_profile_digests.length !== profiles.size
        || config.installed_relay_profile_digests.some((digest) => !profiles.has(digest))) {
        throw coordinatorError("RELAY_PROFILE_SET_MISMATCH");
      }
      return profiles;
    });
  relayProfilesInFlight = loading;
  try {
    return await loading;
  } finally {
    if (relayProfilesInFlight === loading) relayProfilesInFlight = null;
  }
}

async function createProfile(payload, port) {
  exactObject(payload ?? {}, [], ["telemetry_opt_in"]);
  const telemetryOptIn = payload?.telemetry_opt_in ?? false;
  if (typeof telemetryOptIn !== "boolean") throw new TypeError("invalid telemetry consent");
  const profileID = randomID(18);
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const originKey = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const capabilityRoot = crypto.getRandomValues(new Uint8Array(32));
  const now = Date.now();
  const profile = {
    profile_id: profileID,
    key_version: 1,
    origin_key: originKey,
    capability_root: capabilityRoot,
    capability_epoch: 1,
    cookie_seq: 0,
    policy_version: POLICY_VERSION,
    relay_profile_digests: [],
    relay_profiles: [],
    telemetry_opt_in: telemetryOptIn,
    created_at: now,
    updated_at: now,
  };
  const db = await databasePromise;
  const transaction = db.transaction("profiles", "readwrite", { durability: "strict" });
  transaction.objectStore("profiles").add(profile);
  await complete(transaction);
  portBindings.get(port)?.control_profiles.add(profileID);
  return { profile_id: profileID, capability_epoch: 1, telemetry_opt_in: telemetryOptIn };
}

async function approveRelaySet(payload) {
  exactObject(payload, ["profile_id", "relay_profile_digests"]);
  const profileID = requiredString(payload.profile_id, 256);
  const digests = payload.relay_profile_digests;
  if (!Array.isArray(digests) || digests.length < 1 || digests.length > 8
    || digests.some((digest, index) => typeof digest !== "string"
      || !/^[A-Za-z0-9_-]{43}$/.test(digest)
      || digests.indexOf(digest) !== index)) {
    throw new TypeError("invalid ordered relay profile set");
  }
  const installed = await installedRelayProfiles();
  const relays = digests.map((digest) => {
    const relay = installed.get(digest);
    if (!relay) throw coordinatorError("RELAY_PROFILE_NOT_INSTALLED");
    return relay;
  });
  const db = await databasePromise;
  const transaction = db.transaction("profiles", "readwrite", { durability: "strict" });
  const store = transaction.objectStore("profiles");
  const profile = await request(store.get(profileID));
  if (!profile) {
    transaction.abort();
    throw new DOMException("Unknown profile", "NotFoundError");
  }
  profile.relay_profile_digests = [...digests];
  profile.relay_profiles = relays.map(relay => relay.profile);
  profile.updated_at = Date.now();
  store.put(profile);
  await complete(transaction);
  return {
    relay_profile_digests: [...digests],
    profile_ids: relays.map(relay => relay.profile.profile_id),
  };
}

async function getProfile(profileID, transaction) {
  const profile = await request(transaction.objectStore("profiles").get(profileID));
  if (!profile) throw new DOMException("Unknown profile", "NotFoundError");
  return profile;
}

async function readRecord(db, storeName, key) {
  const transaction = db.transaction(storeName, "readonly");
  const value = await request(transaction.objectStore(storeName).get(key));
  await complete(transaction);
  return value;
}

async function readCoordinatorRevision(db) {
  const metadata = await readRecord(
    db,
    "origin_kernel_meta",
    COORDINATOR_DB_VERSION,
  );
  const revision = metadata?.coordinator_revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw coordinatorError("COORDINATOR_REVISION_CORRUPT", "InvalidStateError");
  }
  return revision;
}

async function advanceCoordinatorRevision(db, expectedRevision) {
  const transaction = db.transaction("origin_kernel_meta", "readwrite", {
    durability: "strict",
  });
  const store = transaction.objectStore("origin_kernel_meta");
  const metadata = await request(store.get(COORDINATOR_DB_VERSION));
  const current = metadata?.coordinator_revision ?? 0;
  if (
    !metadata
    || !Number.isSafeInteger(current)
    || current !== expectedRevision
    || current === Number.MAX_SAFE_INTEGER
  ) {
    transaction.abort();
    throw coordinatorError("COORDINATOR_REVISION_CORRUPT", "InvalidStateError");
  }
  metadata.coordinator_revision = current + 1;
  store.put(metadata);
  await complete(transaction);
  return metadata.coordinator_revision;
}

function originByID(store, profileID, originID) {
  return request(store.index("by_origin_id").get([profileID, originID]));
}

async function readOriginByID(db, profileID, originID) {
  const transaction = db.transaction("origin_map", "readonly");
  const value = await originByID(transaction.objectStore("origin_map"), profileID, originID);
  await complete(transaction);
  return value;
}

async function mapOrigin(payload) {
  exactObject(payload, ["profile_id", "target_url"]);
  const target = await canonicalTarget(requiredString(payload.target_url));
  const db = await databasePromise;
  const key = [payload.profile_id, target.canonicalOrigin];
  const profile = await readRecord(db, "profiles", payload.profile_id);
  if (!profile) throw new DOMException("Unknown profile", "NotFoundError");
  const existing = await readRecord(db, "origin_map", key);
  if (existing) return { origin_id: existing.origin_id, canonical_origin: existing.canonical_origin };
  for (let collision = 0; ; collision++) {
    const originID = await deriveOriginID(profile.origin_key, target.canonicalOrigin, collision);
    const transaction = db.transaction("origin_map", "readwrite", { durability: "strict" });
    const store = transaction.objectStore("origin_map");
    const [current, prior] = await Promise.all([
      request(store.get(key)),
      originByID(store, payload.profile_id, originID),
    ]);
    if (current) {
      await complete(transaction);
      return { origin_id: current.origin_id, canonical_origin: current.canonical_origin };
    }
    if (prior && prior.canonical_origin !== target.canonicalOrigin) {
      transaction.abort();
      continue;
    }
    const mapping = {
      profile_id: payload.profile_id,
      canonical_origin: target.canonicalOrigin,
      canonical_site: target.canonicalSite,
      origin_id: originID,
      collision_counter: collision,
      version: 2,
    };
    store.add(mapping);
    await complete(transaction);
    return { origin_id: originID, canonical_origin: target.canonicalOrigin };
  }
}

async function setRelayCapability(payload) {
  exactObject(payload, ["profile_id", "origin_id", "capability"]);
  const keys = [
    "capability_id",
    "capability_secret",
    "deployment_salt",
    "claims_digest",
    "capability_epoch",
    "expires_at",
    "relay_url",
    "relay_profile_digest",
    "allowed_target_ports",
  ];
  const capability = payload.capability;
  if (
    !payload.origin_id
    || !isPlainObject(capability)
    || Object.keys(capability).length !== keys.length
    || keys.some((key) => !(key in capability))
    || Date.parse(capability.expires_at) <= Date.now()
    || !Array.isArray(capability.allowed_target_ports)
  ) {
    throw new TypeError("invalid relay capability");
  }
  const db = await databasePromise;
  const profile = await readRecord(db, "profiles", payload.profile_id);
  if (!profile) throw new DOMException("Unknown profile", "NotFoundError");
  const relayIndex = profile.relay_profile_digests?.indexOf(capability.relay_profile_digest) ?? -1;
  const relayProfile = profile.relay_profiles?.[relayIndex];
  if (relayIndex < 0 || relayProfile == null
    || capability.relay_url !== relayProfile.relay_wss_origin + relayProfile.carrier_path
    || capability.expires_at > relayProfile.expires_at
    || capability.allowed_target_ports.length !== relayProfile.allowed_target_ports.length
    || capability.allowed_target_ports.some((port, index) => port !== relayProfile.allowed_target_ports[index])) {
    throw coordinatorError("RELAY_CAPABILITY_PROFILE_MISMATCH");
  }
  const sealed = await sealText(
    profile.capability_root,
    JSON.stringify(capability),
    `${payload.profile_id}\0relay\0${payload.origin_id}\0${capability.relay_profile_digest}`,
  );
  const transaction = db.transaction(["profiles", "relay_capabilities"], "readwrite", {
    durability: "strict",
  });
  const profiles = transaction.objectStore("profiles");
  const current = await request(profiles.get(payload.profile_id));
  if (!current) {
    transaction.abort();
    throw new DOMException("Unknown profile", "NotFoundError");
  }
  current.updated_at = Date.now();
  profiles.put(current);
  transaction.objectStore("relay_capabilities").put({
    profile_id: payload.profile_id,
    origin_id: payload.origin_id,
    relay_profile_digest: capability.relay_profile_digest,
    encrypted_capability: sealed,
  });
  await complete(transaction);
  return { installed: true };
}

const HANDOFF_PAYLOAD_FIELDS = Object.freeze([
  "v",
  "profile_id",
  "tab_id",
  "entry_id",
  "source_origin_id",
  "destination_origin_id",
  "capability_epoch",
  "nonce",
  "expires_at",
  "ancestor_urls",
  "form_submission",
]);

function handoffAAD(id, destinationHost, bodyLength = 0, bodyDigest = "none") {
  return `zeroproxy-handoff-v2\0${id}\0${destinationHost}\0${bodyLength}:${bodyDigest}`;
}

function sameBytes(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function sameSealedValue(left, right) {
  return sameBytes(left?.nonce, right?.nonce) && sameBytes(left?.ciphertext, right?.ciphertext);
}

function authorizeHandoffSource(port, payload, tab, coldSessionID) {
  const binding = portBindings.get(port);
  if (
    payload.source_origin_id === "control"
    && binding?.control_profiles.has(payload.profile_id)
    && !tab
  ) {
    return { parent_entry_id: null, session_id: coldSessionID };
  }
  const lineage = binding?.lineage;
  if (
    !lineage
    || lineage.profile_id !== payload.profile_id
    || lineage.tab_id !== payload.tab_id
    || lineage.entry_id !== payload.source_entry_id
    || lineage.origin_id !== payload.source_origin_id
    || lineage.capability_epoch !== payload.capability_epoch
    || !tab
    || tab.current_entry_id !== lineage.entry_id
    || tab.origin_id !== lineage.origin_id
    || tab.capability_epoch !== lineage.capability_epoch
    || tab.state !== "ACTIVE"
  ) {
    throw coordinatorError("CAPABILITY_REJECTED");
  }
  return { parent_entry_id: lineage.entry_id, session_id: tab.session_id };
}

async function revokePendingLineage(transaction, profileID, tabID, entryID, revokedAt) {
  const handoffStore = transaction.objectStore("handoffs");
  const handoffs = await request(handoffStore.getAll());
  for (const handoff of handoffs) {
    if (handoff.profile_id === profileID && handoff.tab_id === tabID) handoffStore.delete(handoff.id);
  }
  const historyStore = transaction.objectStore("history");
  const histories = await request(historyStore.index("by_tab").getAll([profileID, tabID]));
  const supersededEntries = new Set();
  for (const history of histories) {
    if (history.state !== "PENDING" || history.entry_id === entryID) continue;
    supersededEntries.add(history.entry_id);
    history.state = "ABORTED";
    history.revoked_at = revokedAt;
    historyStore.put(history);
  }
  const routeStore = transaction.objectStore("routes");
  const routes = await request(routeStore.index("by_tab").getAll([profileID, tabID]));
  for (const route of routes) {
    if (
      !supersededEntries.has(route.entry_id)
      || route.revoked_at !== null && route.revoked_at !== undefined
    ) continue;
    route.revoked_at = revokedAt;
    routeStore.put(route);
  }
}

const FORM_HANDOFF_MAX_BYTES = 16 << 20;
const formReferrerPolicies = new Set(["", "no-referrer", "no-referrer-when-downgrade", "origin", "origin-when-cross-origin", "same-origin", "strict-origin", "strict-origin-when-cross-origin", "unsafe-url"]);

async function validatedFormSubmission(value) {
  if (value === undefined) return { formSource: null, formSubmission: null };
  exactObject(value, ["method", "content_type", "body_base64", "body_length", "body_sha256", "source_url", "referrer_policy"]);
  if (value.method !== "POST"
    || typeof value.content_type !== "string" || value.content_type.length === 0 || value.content_type.length > 1_024 || /[\r\n]/u.test(value.content_type)
    || !/^(?:application\/x-www-form-urlencoded(?:\s*;|$)|multipart\/form-data;\s*boundary=[^\s;]{1,200}(?:;|$)|text\/plain(?:\s*;|$))/iu.test(value.content_type)
    || typeof value.body_base64 !== "string" || value.body_base64.length > 23 << 20
    || !Number.isSafeInteger(value.body_length) || value.body_length < 0 || value.body_length > FORM_HANDOFF_MAX_BYTES
    || typeof value.body_sha256 !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.body_sha256)
    || !formReferrerPolicies.has(value.referrer_policy)) {
    throw new DOMException("Form handoff rejected", "SecurityError");
  }
  const body = decodeBase64URL(value.body_base64);
  const actualDigest = base64URL(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
  if (body.byteLength !== value.body_length || actualDigest !== value.body_sha256) {
    throw new DOMException("Form handoff body rejected", "SecurityError");
  }
  const formSource = await canonicalTarget(value.source_url);
  return { formSource, formSubmission: { ...value, source_url: formSource.url } };
}

async function validatedHandoffTargets(payload) {
  exactObject(
    payload,
    [
      "profile_id",
      "tab_id",
      "entry_id",
      "source_origin_id",
      "destination_origin_id",
      "capability_epoch",
      "destination_host",
      "target_url",
    ],
    ["source_entry_id", "ancestor_urls", "form_submission"],
  );
  if (
    !opaqueIDPattern.test(payload.tab_id)
    || !opaqueIDPattern.test(payload.entry_id)
    || (payload.source_entry_id !== undefined && !opaqueIDPattern.test(payload.source_entry_id))
  ) {
    throw new DOMException("Handoff identifier mismatch", "SecurityError");
  }
  requiredString(payload.destination_host, 512);
  if (payload.ancestor_urls !== undefined && (!Array.isArray(payload.ancestor_urls) || payload.ancestor_urls.length > 32)) {
    throw new DOMException("Handoff ancestor chain mismatch", "SecurityError");
  }
  const target = await canonicalTarget(payload.target_url);
  const { formSource, formSubmission } = await validatedFormSubmission(payload.form_submission);
  const ancestorURLs = [];
  for (const value of payload.ancestor_urls ?? []) {
    if (typeof value !== "string") throw new DOMException("Handoff ancestor mismatch", "SecurityError");
    ancestorURLs.push((await canonicalTarget(value)).url);
  }
  return { ancestorURLs, formSource, formSubmission, target };
}

function createPendingHandoffTab(transaction, { coldSessionID, encryptedStreamKey, mapping, now, payload, profile, source }) {
  transaction.objectStore("sessions").add({
    session_id: source.session_id,
    profile_id: payload.profile_id,
    protocol_epoch: 2,
    compiler_epoch: null,
    kernel_epoch: null,
    capability_root: profile.capability_root,
    browser_feature_probes: null,
    active_origin_inventory: [],
    state: "PENDING",
    created_at: now,
    updated_at: now,
  });
  return {
    profile_id: payload.profile_id,
    tab_id: payload.tab_id,
    session_id: source.session_id,
    opener_tab_id: null,
    encrypted_stream_key: encryptedStreamKey,
    top_level_site: mapping.canonical_site,
    capability_epoch: payload.capability_epoch,
    state: "PENDING",
    origin_id: null,
    current_entry_id: null,
    document_capability: null,
    cookie_capability: randomID(32),
    revision: 0,
    created_at: now,
    last_seen_at: now,
  };
}

async function writePendingHandoff(input, transaction) {
  const { ancestorURLs, coldSessionID, encryptedStreamKey, encryptedTargetURL, expiresAt, formSubmission, id, mapping, nonce, now, payload, port, profile, sealedPayload, target } = input;
  const [currentProfile, tab] = await Promise.all([
    getProfile(payload.profile_id, transaction),
    request(transaction.objectStore("tabs").get([payload.profile_id, payload.tab_id])),
  ]);
  if (currentProfile.capability_epoch !== payload.capability_epoch) {
    throw new DOMException("Capability epoch mismatch", "InvalidStateError");
  }
  const source = authorizeHandoffSource(port, payload, tab, coldSessionID);
  const pendingRevision = Math.max(tab?.revision ?? 0, tab?.pending_revision ?? 0) + 1;
  await revokePendingLineage(transaction, payload.profile_id, payload.tab_id, payload.entry_id, now);
  const currentTab = tab ?? createPendingHandoffTab(transaction, {
    coldSessionID,
    encryptedStreamKey,
    mapping,
    now,
    payload,
    profile,
    source,
  });
  currentTab.pending_entry_id = payload.entry_id;
  currentTab.pending_origin_id = payload.destination_origin_id;
  currentTab.pending_revision = pendingRevision;
  currentTab.last_seen_at = now;
  transaction.objectStore("tabs").put(currentTab);
  transaction.objectStore("history").add({
    profile_id: payload.profile_id,
    tab_id: payload.tab_id,
    entry_id: payload.entry_id,
    parent_entry_id: source.parent_entry_id,
    origin_id: payload.destination_origin_id,
    encrypted_target_url: encryptedTargetURL,
    base_url: target.networkURL,
    referrer_url: formSubmission?.source_url ?? ancestorURLs.at(-1) ?? null,
    state_clone: null,
    scroll_x: 0,
    scroll_y: 0,
    state: "PENDING",
    revision: pendingRevision,
    created_at: now,
  });
  transaction.objectStore("handoffs").add({
    id,
    profile_id: payload.profile_id,
    tab_id: payload.tab_id,
    entry_id: payload.entry_id,
    source_origin_id: payload.source_origin_id,
    destination_origin_id: payload.destination_origin_id,
    capability_epoch: payload.capability_epoch,
    destination_host: payload.destination_host,
    pending_revision: pendingRevision,
    sealed_payload: sealedPayload,
    form_submission_length: formSubmission?.body_length ?? 0,
    form_submission_digest: formSubmission?.body_sha256 ?? "none",
    expires_at: expiresAt,
  });
  await complete(transaction);
  return { handoff_id: id, bridge_nonce: nonce, expires_at: expiresAt };
}

async function createHandoff(payload, port) {
  const { ancestorURLs, formSource, formSubmission, target } = await validatedHandoffTargets(payload);
  const db = await databasePromise;
  const profile = await readRecord(db, "profiles", payload.profile_id);
  if (!profile || profile.capability_epoch !== payload.capability_epoch) {
    throw new DOMException("Capability epoch mismatch", "InvalidStateError");
  }
  const [mapping, formSourceMapping] = await Promise.all([
    readOriginByID(db, payload.profile_id, payload.destination_origin_id),
    formSource ? readRecord(db, "origin_map", [payload.profile_id, formSource.canonicalOrigin]) : null,
  ]);
  if (!mapping || mapping.canonical_origin !== target.canonicalOrigin
    || formSource && formSourceMapping?.canonical_origin !== formSource.canonicalOrigin) {
    throw new DOMException("Handoff origin mismatch", "SecurityError");
  }
  const now = Date.now();
  const expiresAt = now + 30_000;
  const nonce = randomID(18);
  const id = randomID();
  const sealedPayload = await sealText(
    profile.capability_root,
    JSON.stringify({
      v: 2,
      profile_id: payload.profile_id,
      tab_id: payload.tab_id,
      entry_id: payload.entry_id,
      source_origin_id: payload.source_origin_id,
      destination_origin_id: payload.destination_origin_id,
      capability_epoch: payload.capability_epoch,
      nonce,
      expires_at: expiresAt,
      ancestor_urls: ancestorURLs,
      form_submission: formSubmission,
    }),
    handoffAAD(id, payload.destination_host, formSubmission?.body_length, formSubmission?.body_sha256),
  );
  const historyKey = `${payload.profile_id}\0${payload.tab_id}\0${payload.entry_id}`;
  const encryptedTargetURL = await sealText(profile.capability_root, target.url, historyKey);
  const coldSessionID = randomID(24);
  const encryptedStreamKey = await sealText(
    profile.capability_root,
    randomID(32),
    `${payload.profile_id}\0stream\0${coldSessionID}`,
  );
  const transaction = db.transaction(
    ["profiles", "sessions", "tabs", "history", "routes", "handoffs"],
    "readwrite",
    { durability: "strict" },
  );
  try {
    return await writePendingHandoff({
      ancestorURLs,
      coldSessionID,
      encryptedStreamKey,
      encryptedTargetURL,
      expiresAt,
      formSubmission,
      id,
      mapping,
      nonce,
      now,
      payload,
      port,
      profile,
      sealedPayload,
      target,
    }, transaction);
  } catch (error) {
    try {
      transaction.abort();
    } catch {}
    throw error;
  }
}

async function openHandoffPayload(profile, record) {
  try {
    const value = JSON.parse(await openText(
      profile.capability_root,
      record.sealed_payload,
      handoffAAD(record.id, record.destination_host, record.form_submission_length, record.form_submission_digest),
    ));
    exactObject(value, HANDOFF_PAYLOAD_FIELDS);
    return value;
  } catch {
    throw new DOMException("Handoff unavailable", "SecurityError");
  }
}

function validOpenedFormSubmission(record,value){
  if(record.form_submission_digest==="none")return record.form_submission_length===0&&value===null;
  return value&&typeof value==="object"
    &&value.method==="POST"
    &&value.body_length===record.form_submission_length
    &&value.body_sha256===record.form_submission_digest
    &&typeof value.body_base64==="string"
    &&typeof value.content_type==="string"
    &&typeof value.source_url==="string"
    &&formReferrerPolicies.has(value.referrer_policy);
}

function materializeOpenedFormSubmission(record,value){
  if(value===null)return null;
  const body=decodeBase64URL(value.body_base64);
  if(body.byteLength!==record.form_submission_length)throw new DOMException("Form handoff unavailable","SecurityError");
  return {method:value.method,content_type:value.content_type,body,body_length:value.body_length,body_sha256:value.body_sha256,source_url:value.source_url,referrer_policy:value.referrer_policy};
}

function validOpenedHandoff(record, opened, payload) {
  return opened.v === 2
    && opened.profile_id === record.profile_id
    && opened.tab_id === record.tab_id
    && opened.entry_id === record.entry_id
    && opened.source_origin_id === record.source_origin_id
    && opened.destination_origin_id === record.destination_origin_id
    && opened.capability_epoch === record.capability_epoch
    && opened.expires_at === record.expires_at
    && opened.expires_at > Date.now()
    && opened.nonce === payload.bridge_nonce
    && validOpenedFormSubmission(record,opened.form_submission)
    && record.destination_host === payload.destination_host;
}

function validCommittedHandoff(currentProfile, current, tab, history, record) {
  return currentProfile.capability_epoch === record.capability_epoch
    && Boolean(current)
    && sameSealedValue(current.sealed_payload, record.sealed_payload)
    && tab?.pending_entry_id === record.entry_id
    && tab.pending_revision === record.pending_revision
    && history?.state === "PENDING"
    && history.revision === record.pending_revision;
}

function activateHandoffTab(tab, record, documentCapability, now) {
  tab.origin_id = record.destination_origin_id;
  tab.current_entry_id = record.entry_id;
  tab.document_capability = documentCapability;
  tab.document_revision = (tab.document_revision ?? 0) + 1;
  tab.revision = record.pending_revision;
  tab.pending_entry_id = null;
  tab.pending_origin_id = null;
  tab.pending_revision = null;
  tab.state = "ACTIVE";
  tab.last_seen_at = now;
}

async function activateHandoffSession(transaction, tab, record, now) {
  const store = transaction.objectStore("sessions");
  const session = await request(store.get(tab.session_id));
  if (!session || session.profile_id !== record.profile_id) {
    throw new DOMException("Handoff state unavailable", "SecurityError");
  }
  session.active_origin_inventory = [
    ...new Set([...(session.active_origin_inventory ?? []), record.destination_origin_id]),
  ];
  session.state = "ACTIVE";
  session.updated_at = now;
  store.put(session);
}

async function revokePriorRoutes(transaction, record, now) {
  const store = transaction.objectStore("routes");
  const routes = await request(store.index("by_tab").getAll([record.profile_id, record.tab_id]));
  for (const route of routes) {
    if (route.entry_id === record.entry_id || route.revoked_at) continue;
    route.revoked_at = now;
    store.put(route);
  }
}

async function commitHandoff(db, record, documentCapability, port) {
  const now = Date.now();
  const transaction = db.transaction(
    ["profiles", "sessions", "tabs", "history", "routes", "handoffs"],
    "readwrite",
    { durability: "strict" },
  );
  try {
    const handoffStore = transaction.objectStore("handoffs");
    const [currentProfile, current, tab, pendingHistory] = await Promise.all([
      getProfile(record.profile_id, transaction),
      request(handoffStore.get(record.id)),
      request(transaction.objectStore("tabs").get([record.profile_id, record.tab_id])),
      request(transaction.objectStore("history").get([
        record.profile_id,
        record.tab_id,
        record.entry_id,
      ])),
    ]);
    if (!validCommittedHandoff(currentProfile, current, tab, pendingHistory, record)) {
      throw new DOMException("Handoff unavailable", "SecurityError");
    }
    handoffStore.delete(record.id);
    activateHandoffTab(tab, record, documentCapability, now);
    transaction.objectStore("tabs").put(tab);
    pendingHistory.state = "ACTIVE";
    pendingHistory.activated_at = now;
    transaction.objectStore("history").put(pendingHistory);
    await activateHandoffSession(transaction, tab, record, now);
    await revokePriorRoutes(transaction, record, now);
    await complete(transaction);
    portBindings.get(port).lineage = {
      profile_id: record.profile_id,
      tab_id: record.tab_id,
      entry_id: record.entry_id,
      origin_id: record.destination_origin_id,
      capability_epoch: record.capability_epoch,
      document_capability: documentCapability,
      revision: tab.revision,
    };
    return tab;
  } catch (error) {
    try {
      transaction.abort();
    } catch {}
    throw error;
  }
}
async function consumeHandoff(payload, port) {
  exactObject(payload, ["handoff_id", "destination_host", "bridge_nonce"]);
  const db = await databasePromise;
  const record = await readRecord(db, "handoffs", payload.handoff_id);
  if (!record || record.expires_at <= Date.now() || record.destination_host !== payload.destination_host) {
    throw new DOMException("Handoff unavailable", "SecurityError");
  }
  const historyKey = `${record.profile_id}\0${record.tab_id}\0${record.entry_id}`;
  const [profile, history, tabRecord, installed] = await Promise.all([
    readRecord(db, "profiles", record.profile_id),
    readRecord(db, "history", [record.profile_id, record.tab_id, record.entry_id]),
    readRecord(db, "tabs", [record.profile_id, record.tab_id]),
    installedRelayProfiles(),
  ]);
  if (!profile || profile.capability_epoch !== record.capability_epoch || history?.state !== "PENDING"
    || !Array.isArray(profile.relay_profile_digests)
    || profile.relay_profile_digests.length < 1
    || profile.relay_profile_digests.length > 8
    || !Array.isArray(profile.relay_profiles)
    || profile.relay_profiles.length !== profile.relay_profile_digests.length) {
    throw new DOMException("Handoff state unavailable", "SecurityError");
  }
  const relayProfiles = profile.relay_profile_digests.map((relayDigest) => {
    const verified = installed.get(relayDigest);
    if (!verified) throw new DOMException("Relay profile unavailable", "SecurityError");
    return verified.profile;
  });
  const relayRecords = await Promise.all(profile.relay_profile_digests.map(relayDigest => readRecord(
    db,
    "relay_capabilities",
    [record.profile_id, record.destination_origin_id, relayDigest],
  )));
  if (relayRecords.some(relayRecord => !relayRecord?.encrypted_capability)) {
    throw new DOMException("Relay capability unavailable", "SecurityError");
  }
  const opened = await openHandoffPayload(profile, record);
  if (!validOpenedHandoff(record, opened, payload)) {
    throw new DOMException("Handoff unavailable", "SecurityError");
  }
  const formSubmission=materializeOpenedFormSubmission(record,opened.form_submission);
  const [targetURL, relayCapabilities] = await Promise.all([
    openText(profile.capability_root, history.encrypted_target_url, historyKey),
    Promise.all(relayRecords.map((relayRecord, index) => openText(
      profile.capability_root,
      relayRecord.encrypted_capability,
      `${record.profile_id}\0relay\0${record.destination_origin_id}\0${profile.relay_profile_digests[index]}`,
    ).then(JSON.parse))),
  ]);
  for (const [index, relayCapability] of relayCapabilities.entries()) {
    const relayDigest = profile.relay_profile_digests[index];
    const relayProfile = relayProfiles[index];
    if (Date.parse(relayCapability.expires_at) <= Date.now()
      || relayCapability.relay_profile_digest !== relayDigest
      || relayCapability.relay_url !== relayProfile.relay_wss_origin + relayProfile.carrier_path
      || relayCapability.allowed_target_ports.length !== relayProfile.allowed_target_ports.length
      || relayCapability.allowed_target_ports.some((port, portIndex) => port !== relayProfile.allowed_target_ports[portIndex])) {
      throw new DOMException("Relay capability expired or mismatched", "SecurityError");
    }
  }
  const documentCapability = randomID(32);
  const isolation = await deriveIsolationCredentials(
    profile,
    tabRecord,
    record.destination_origin_id,
    documentCapability,
    profile.relay_profile_digests,
    relayCapabilities,
  );
  const tab = await commitHandoff(db, record, documentCapability, port);
  return {
    profile_id: record.profile_id,
    session_id: tab.session_id,
    tab_id: record.tab_id,
    entry_id: record.entry_id,
    destination_origin_id: record.destination_origin_id,
    destination_host: record.destination_host,
    capability_epoch: record.capability_epoch,
    document_capability: documentCapability,
    lineage_revision: tab.revision,
    target_url: targetURL,
    ancestor_urls: [...opened.ancestor_urls],
    form_submission:formSubmission,
    relay_profile_digests: [...profile.relay_profile_digests],
    relay_profiles: relayProfiles,
    relay_capabilities: relayCapabilities,
    ...isolation,
  };
}

function historyUpdatePayload(payload) {
  exactObject(
    payload,
    [
      "profile_id",
      "tab_id",
      "entry_id",
      "origin_id",
      "capability_epoch",
      "target_url",
      "expected_revision",
    ],
    ["base_url", "referrer_url", "state_clone", "scroll_x", "scroll_y"],
  );
  if (
    !opaqueIDPattern.test(payload.tab_id)
    || !opaqueIDPattern.test(payload.entry_id)
    || !Number.isSafeInteger(payload.expected_revision)
    || payload.expected_revision < 1
    || !Number.isSafeInteger(payload.capability_epoch)
    || payload.capability_epoch < 1
    || (payload.scroll_x !== undefined && !Number.isFinite(payload.scroll_x))
    || (payload.scroll_y !== undefined && !Number.isFinite(payload.scroll_y))
  ) {
    throw new TypeError("invalid history update");
  }
  if (payload.referrer_url !== undefined && payload.referrer_url !== null) {
    requiredString(payload.referrer_url);
  }
  return payload;
}

function validHistoryLineage(binding, tab, payload) {
  const lineage = binding?.lineage;
  return lineage?.profile_id === payload.profile_id
    && lineage.tab_id === payload.tab_id
    && lineage.origin_id === payload.origin_id
    && lineage.capability_epoch === payload.capability_epoch
    && lineage.revision === payload.expected_revision
    && tab?.current_entry_id === lineage.entry_id
    && tab.origin_id === lineage.origin_id
    && tab.revision === lineage.revision
    && tab.state === "ACTIVE";
}

async function updateSameOriginHistory(payload, port) {
  historyUpdatePayload(payload);
  const target = await canonicalTarget(requiredString(payload.target_url));
  const db = await databasePromise;
  const [profile, mapping] = await Promise.all([
    readRecord(db, "profiles", payload.profile_id),
    readOriginByID(db, payload.profile_id, payload.origin_id),
  ]);
  if (
    !profile
    || profile.capability_epoch !== payload.capability_epoch
    || mapping?.canonical_origin !== target.canonicalOrigin
  ) {
    throw coordinatorError("CAPABILITY_REJECTED");
  }
  const historyKey = `${payload.profile_id}\0${payload.tab_id}\0${payload.entry_id}`;
  const encryptedTargetURL = await sealText(profile.capability_root, target.url, historyKey);
  const documentCapability = randomID(32);
  const now = Date.now();
  const transaction = db.transaction(
    ["profiles", "tabs", "history", "routes", "handoffs"],
    "readwrite",
    { durability: "strict" },
  );
  try {
    const [currentProfile, tab] = await Promise.all([
      getProfile(payload.profile_id, transaction),
      request(transaction.objectStore("tabs").get([payload.profile_id, payload.tab_id])),
    ]);
    if (
      currentProfile.capability_epoch !== payload.capability_epoch
      || !validHistoryLineage(portBindings.get(port), tab, payload)
    ) {
      throw coordinatorError("CAPABILITY_REJECTED");
    }
    const revision = tab.revision + 1;
    await revokePendingLineage(transaction, payload.profile_id, payload.tab_id, payload.entry_id, now);
    transaction.objectStore("history").add({
      profile_id: payload.profile_id,
      tab_id: payload.tab_id,
      entry_id: payload.entry_id,
      parent_entry_id: tab.current_entry_id,
      origin_id: payload.origin_id,
      encrypted_target_url: encryptedTargetURL,
      base_url: payload.base_url ?? target.networkURL,
      referrer_url: payload.referrer_url ?? null,
      state_clone: payload.state_clone ?? null,
      scroll_x: payload.scroll_x ?? 0,
      scroll_y: payload.scroll_y ?? 0,
      state: "ACTIVE",
      revision,
      created_at: now,
      activated_at: now,
    });
    tab.current_entry_id = payload.entry_id;
    tab.document_capability = documentCapability;
    tab.document_revision = (tab.document_revision ?? 0) + 1;
    tab.revision = revision;
    tab.last_seen_at = now;
    transaction.objectStore("tabs").put(tab);
    await complete(transaction);
    const lineage = portBindings.get(port).lineage;
    lineage.entry_id = payload.entry_id;
    lineage.document_capability = documentCapability;
    lineage.revision = revision;
    return {
      entry_id: payload.entry_id,
      document_capability: documentCapability,
      revision,
      target_url: target.url,
    };
  } catch (error) {
    try {
      transaction.abort();
    } catch {}
    throw error;
  }
}

function cookieContextFromPayload(payload) {
  for (const key of ["profile_id", "origin_id", "tab_id", "cookie_capability"]) {
    requiredString(payload[key], 256);
  }
  if (!Number.isSafeInteger(payload.capability_epoch) || payload.capability_epoch < 1) {
    throw new TypeError("invalid cookie capability epoch");
  }
  return {
    profile_id: payload.profile_id,
    origin_id: payload.origin_id,
    tab_id: payload.tab_id,
    capability_epoch: payload.capability_epoch,
    cookie_capability: payload.cookie_capability,
  };
}

function tabKey(context) {
  return [context.profile_id, context.tab_id];
}

async function createCookieContext(payload) {
  exactObject(payload, ["profile_id", "origin_id", "tab_id", "capability_epoch"]);
  requiredString(payload.profile_id, 256);
  requiredString(payload.origin_id, 256);
  requiredString(payload.tab_id, 256);
  if (!Number.isSafeInteger(payload.capability_epoch) || payload.capability_epoch < 1) {
    throw new TypeError("invalid cookie capability epoch");
  }
  const db = await databasePromise;
  const transaction = db.transaction(
    ["profiles", "origin_map", "sessions", "tabs"],
    "readwrite",
    { durability: "strict" },
  );
  const profiles = transaction.objectStore("profiles");
  const tabs = transaction.objectStore("tabs");
  const [profile, mapping, existing] = await Promise.all([
    request(profiles.get(payload.profile_id)),
    originByID(transaction.objectStore("origin_map"), payload.profile_id, payload.origin_id),
    request(tabs.get([payload.profile_id, payload.tab_id])),
  ]);
  if (
    !profile
    || profile.capability_epoch !== payload.capability_epoch
    || !mapping
    || mapping.profile_id !== payload.profile_id
  ) {
    transaction.abort();
    throw coordinatorError("CAPABILITY_REJECTED");
  }
  if (existing) {
    if (
      existing.origin_id !== payload.origin_id
      || existing.capability_epoch !== payload.capability_epoch
      || typeof existing.cookie_capability !== "string"
      || typeof existing.top_level_site !== "string"
      || existing.top_level_site.length === 0
    ) {
      transaction.abort();
      throw coordinatorError("CAPABILITY_REJECTED");
    }
    await complete(transaction);
    return {
      profile_id: payload.profile_id,
      origin_id: payload.origin_id,
      tab_id: payload.tab_id,
      capability_epoch: payload.capability_epoch,
      cookie_capability: existing.cookie_capability,
      top_level_site: existing.top_level_site,
    };
  }
  const now = Date.now();
  const context = {
    profile_id: payload.profile_id,
    origin_id: payload.origin_id,
    tab_id: payload.tab_id,
    session_id: randomID(24),
    opener_tab_id: null,
    encrypted_stream_key: null,
    top_level_site: mapping.canonical_site,
    capability_epoch: payload.capability_epoch,
    cookie_capability: randomID(32),
    state: "ACTIVE",
    created_at: now,
    last_seen_at: now,
  };
  transaction.objectStore("sessions").add({
    session_id: context.session_id,
    profile_id: context.profile_id,
    protocol_epoch: 2,
    compiler_epoch: null,
    kernel_epoch: null,
    capability_root: profile.capability_root,
    browser_feature_probes: null,
    active_origin_inventory: [context.origin_id],
    state: "ACTIVE",
    created_at: now,
    updated_at: now,
  });
  tabs.add(context);
  await complete(transaction);
  return {
    profile_id: context.profile_id,
    origin_id: context.origin_id,
    tab_id: context.tab_id,
    capability_epoch: context.capability_epoch,
    cookie_capability: context.cookie_capability,
    top_level_site: context.top_level_site,
  };
}

async function verifyCookieContext(transaction, context) {
  const [profile, mapping, tab] = await Promise.all([
    request(transaction.objectStore("profiles").get(context.profile_id)),
    originByID(transaction.objectStore("origin_map"), context.profile_id, context.origin_id),
    request(transaction.objectStore("tabs").get(tabKey(context))),
  ]);
  if (
    !profile
    || profile.capability_epoch !== context.capability_epoch
    || !mapping
    || mapping.profile_id !== context.profile_id
    || mapping.origin_id !== context.origin_id
    || !tab
    || tab.profile_id !== context.profile_id
    || tab.origin_id !== context.origin_id
    || tab.capability_epoch !== context.capability_epoch
    || tab.cookie_capability !== context.cookie_capability
    || typeof tab.top_level_site !== "string"
    || tab.top_level_site.length === 0
  ) {
    throw coordinatorError("CAPABILITY_REJECTED");
  }
  return { profile, mapping, tab };
}

async function canonicalCookieTargetContext(value, mapping, topLevelSite, allowCrossOrigin = false) {
  exactObject(value, ["request_url", "top_level_site", "is_top_level_navigation", "method"]);
  const [requestTarget, suppliedTopLevelTarget, authorizedTopLevelTarget] = await Promise.all([
    canonicalTarget(requiredString(value.request_url)),
    canonicalTarget(requiredString(value.top_level_site)),
    canonicalTarget(requiredString(topLevelSite)),
  ]);
  if (
    requestTarget.networkURL !== value.request_url
    || suppliedTopLevelTarget.networkURL !== value.top_level_site
    || suppliedTopLevelTarget.canonicalSite !== authorizedTopLevelTarget.canonicalSite
    || (!allowCrossOrigin && requestTarget.canonicalOrigin !== mapping.canonical_origin)
    || typeof value.is_top_level_navigation !== "boolean"
    || typeof value.method !== "string"
    || value.method.length === 0
    || value.method.length > 32
    || /[^\x21-\x7e]/.test(value.method)
  ) {
    throw coordinatorError("CAPABILITY_REJECTED");
  }
  return {
    request_url: requestTarget.networkURL,
    top_level_site: authorizedTopLevelTarget.networkURL,
    is_top_level_navigation: value.is_top_level_navigation,
    method: value.method,
  };
}

async function normalizeCookieMutation(payload, verified) {
  exactObject(
    payload,
    [
      "profile_id",
      "origin_id",
      "tab_id",
      "capability_epoch",
      "cookie_capability",
      "op_id",
      "source_kind",
      "base_seq",
      "causal_after_seq",
      "canonical_target_context",
      "raw_set_cookie_or_document_cookie",
    ],
    ["response_chain_id", "header_index"],
  );
  const context = cookieContextFromPayload(payload);
  if (!["HTTP_RESPONSE", "DOCUMENT"].includes(payload.source_kind)) {
    throw new TypeError("invalid cookie source");
  }
  const targetContext = await canonicalCookieTargetContext(
    payload.canonical_target_context,
    verified.mapping,
    verified.tab.top_level_site,
    payload.source_kind === "HTTP_RESPONSE",
  );
  const opID = requiredString(payload.op_id, 256);
  const raw = requiredString(payload.raw_set_cookie_or_document_cookie, 4096);
  const responseChainID = payload.response_chain_id;
  const headerIndex = payload.header_index;
  if (
    (responseChainID === undefined) !== (headerIndex === undefined)
    || (responseChainID !== undefined
      && (payload.source_kind !== "HTTP_RESPONSE"
        || typeof responseChainID !== "string"
        || responseChainID.length === 0
        || responseChainID.length > 256
        || !Number.isSafeInteger(headerIndex)
        || headerIndex < 0))
  ) {
    throw new TypeError("invalid cookie response order");
  }
  return {
    ...context,
    mutation: {
      op_id: opID,
      source_kind: payload.source_kind,
      base_seq: sequence(payload.base_seq),
      causal_after_seq: sequence(payload.causal_after_seq),
      canonical_target_context: targetContext,
      raw_set_cookie_or_document_cookie: raw,
      ...(responseChainID === undefined
        ? {}
        : { response_chain_id: responseChainID, header_index: headerIndex }),
    },
  };
}

function enqueueCookieOperation(profileID, operation) {
  const previous = cookieQueues.get(profileID) ?? Promise.resolve();
  const queued = previous.then(operation, operation);
  cookieQueues.set(profileID, queued.catch(() => {}));
  return queued;
}


function stateSnapshot(core, stateJSON, now) {
  const snapshot = JSON.parse(core.snapshot_cookie_state_json(stateJSON, now));
  if (
    !isPlainObject(snapshot)
    || !Number.isSafeInteger(snapshot.cookie_seq)
    || snapshot.cookie_seq < 0
    || !Array.isArray(snapshot.cookies)
  ) {
    throw coordinatorError("COOKIE_STATE_CORRUPT", "InvalidStateError");
  }
  return snapshot;
}

function cookieJournalCommits(entries, profileID, afterSeq) {
  return entries
    .filter(
      entry => entry?.profile_id === profileID
        && Number.isSafeInteger(entry.cookie_seq)
        && entry.cookie_seq > afterSeq
        && isPlainObject(entry.commit)
        && entry.commit.cookie_seq === entry.cookie_seq,
    )
    .map(entry => entry.commit)
    .sort((left, right) => left.cookie_seq - right.cookie_seq);
}

function enforceResponseOrder(state, mutation) {
  if (!mutation.response_chain_id || Object.hasOwn(state.journal ?? {}, mutation.op_id)) return;
  const entries = Object.values(state.journal ?? {}).filter(
    entry => entry?.mutation?.response_chain_id === mutation.response_chain_id,
  );
  const index = mutation.header_index;
  if (
    entries.some(entry => entry?.mutation?.header_index === index)
    || (index > 0 && !entries.some(entry => entry?.mutation?.header_index === index - 1))
  ) {
    throw coordinatorError("STALE_OPERATION");
  }
}

function applyCookieMutation(core, stateJSON, mutation) {
  try {
    return JSON.parse(core.apply_cookie_mutation_json(
      stateJSON,
      JSON.stringify(mutation),
      nowUnixSeconds(),
    ));
  } catch (error) {
    if (String(error).includes("duplicate operation with different payload"))
      throw coordinatorError("DUPLICATE_OPERATION");
    throw coordinatorError("COOKIE_CORE_REJECTED");
  }
}

function validateCookieOutcome(outcome, state, mutation, before) {
  const commit = outcome?.commit;
  const nextState = outcome?.state;
  const isReplay = Object.hasOwn(state.journal ?? {}, mutation.op_id);
  const replayInvalid = isReplay
    && (commit?.cookie_seq > before.cookie_seq || nextState?.cookie_seq !== before.cookie_seq);
  const newInvalid = !isReplay
    && (nextState?.cookie_seq !== commit?.cookie_seq || commit?.cookie_seq !== before.cookie_seq + 1);
  if (!isPlainObject(commit)
    || !isPlainObject(nextState)
    || commit.op_id !== mutation.op_id
    || !Number.isSafeInteger(commit.cookie_seq)
    || !Number.isSafeInteger(nextState.cookie_seq)
    || replayInvalid
    || newInvalid) {
    throw coordinatorError(isReplay ? "COOKIE_STATE_CORRUPT" : "COOKIE_CORE_UNAVAILABLE", "InvalidStateError");
  }
  return { commit, isReplay, nextState };
}

async function cookieAuthorityState(profile, cookieRecords, journalRecords) {
  if (cookieRecords.some(record => typeof record.legacy_state_json === "string")) {
    throw coordinatorError("COOKIE_STATE_CORRUPT", "InvalidStateError");
  }
  let cookies;
  try {
    cookies = await Promise.all(cookieRecords.map(record => openCookieRecord(profile, record)));
  } catch {
    throw coordinatorError("COOKIE_STATE_CORRUPT", "InvalidStateError");
  }
  const journal = Object.create(null);
  for (const record of journalRecords) {
    if (
      record?.profile_id !== profile.profile_id
      || !isPlainObject(record.journal_entry)
      || record.journal_entry.commit?.cookie_seq !== record.cookie_seq
      || record.journal_entry.commit?.op_id !== record.op_id
    ) {
      throw coordinatorError("COOKIE_STATE_CORRUPT", "InvalidStateError");
    }
    journal[record.op_id] = record.journal_entry;
  }
  return {
    version: COOKIE_STATE_VERSION,
    cookie_seq: profile.cookie_seq,
    cookies,
    journal,
  };
}

async function loadCookieAuthority(db, context) {
  const transaction = db.transaction(
    ["profiles", "origin_map", "tabs", "cookies", "cookie_journal"],
    "readonly",
  );
  try {
    const [validated, cookieRecords, journalRecords] = await Promise.all([
      verifyCookieContext(transaction, context),
      request(transaction.objectStore("cookies").index("by_profile").getAll(context.profile_id)),
      request(transaction.objectStore("cookie_journal").index("by_profile").getAll(context.profile_id)),
    ]);
    await complete(transaction);
    const state = await cookieAuthorityState(validated.profile, cookieRecords, journalRecords);
    return { ...validated, state, journalRecords };
  } catch (error) {
    try {
      transaction.abort();
    } catch {}
    throw error;
  }
}

function deleteProfileCookies(store, profileID) {
  return new Promise((resolve, reject) => {
    const cursorRequest = store.index("by_profile").openCursor(profileID);
    cursorRequest.onerror = () => reject(cursorRequest.error);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
  });
}

async function writeCookieOutcome(db, context, beforeSequence, outcome, sealedRows) {
  const transaction = db.transaction(
    ["profiles", "origin_map", "tabs", "cookies", "cookie_journal"],
    "readwrite",
    { durability: "strict" },
  );
  const validated = await verifiedCookieWriteContext(transaction, context);
  if (validated.profile.cookie_seq !== beforeSequence) {
    transaction.abort();
    throw coordinatorError("STALE_OPERATION");
  }
  await deleteProfileCookies(transaction.objectStore("cookies"), context.profile_id);
  const cookieStore = transaction.objectStore("cookies");
  for (const row of sealedRows) cookieStore.add(row);
  validated.profile.cookie_seq = outcome.commit.cookie_seq;
  validated.profile.updated_at = Date.now();
  transaction.objectStore("profiles").put(validated.profile);
  transaction.objectStore("cookie_journal").add({
    profile_id: context.profile_id,
    cookie_seq: outcome.commit.cookie_seq,
    op_id: outcome.commit.op_id,
    commit: outcome.commit,
    journal_entry: outcome.nextState.journal[outcome.commit.op_id],
    committed_at: Date.now(),
  });
  await complete(transaction);
}

async function verifiedCookieWriteContext(transaction, context) {
  try {
    return await verifyCookieContext(transaction, context);
  } catch (error) {
    transaction.abort();
    throw error;
  }
}

async function persistCookieMutation(normalized) {
  const core = await loadCookieCore();
  const db = await databasePromise;
  const context = {
    profile_id: normalized.profile_id,
    origin_id: normalized.origin_id,
    tab_id: normalized.tab_id,
    capability_epoch: normalized.capability_epoch,
    cookie_capability: normalized.cookie_capability,
  };
  const loaded = await loadCookieAuthority(db, context);
  const stateJSON = JSON.stringify(loaded.state);
  const before = stateSnapshot(core, stateJSON, nowUnixSeconds());
  if (before.cookie_seq !== loaded.profile.cookie_seq) {
    throw coordinatorError("COOKIE_STATE_CORRUPT", "InvalidStateError");
  }
  enforceResponseOrder(loaded.state, normalized.mutation);
  const outcome = validateCookieOutcome(
    applyCookieMutation(core, stateJSON, normalized.mutation),
    loaded.state,
    normalized.mutation,
    before,
  );
  if (!outcome.isReplay) {
    const sealedRows = await Promise.all(
      outcome.nextState.cookies.map(cookie => sealCookieRecord(loaded.profile, cookie)),
    );
    await writeCookieOutcome(db, context, before.cookie_seq, outcome, sealedRows);
  }
  const publicCommit = await publicCookieCommit(outcome.commit);
  if (!outcome.isReplay) broadcastCookieCommit(context, publicCommit);
  return publicCommit;
}

async function publicCookieCommit(commit) {
  return {
    operation: "COOKIE_COMMIT",
    op_id: commit.op_id,
    cookie_seq: commit.cookie_seq,
    accepted: commit.accepted === true,
    ...(commit.reason === undefined || commit.reason === null ? {} : { reason: commit.reason }),
    visible_delta: Array.isArray(commit.visible_delta) ? commit.visible_delta : [],
    http_only_delta_digest: await digest(
      Array.isArray(commit.http_only_delta) ? commit.http_only_delta : [],
    ),
  };
}

function broadcastCookieCommit(context, commit) {
  for (const port of attachedPorts) {
    if (!cookiePortProfiles.get(port)?.has(context.profile_id)) continue;
    try {
      port.postMessage({
        v: 2,
        profile_id: context.profile_id,
        origin_id: context.origin_id,
        tab_id: context.tab_id,
        ...commit,
      });
    } catch {
      attachedPorts.delete(port);
      cookiePortProfiles.delete(port);
    }
  }
}

async function cookieMutate(payload) {
  exactObject(payload, [
    "profile_id",
    "origin_id",
    "tab_id",
    "capability_epoch",
    "cookie_capability",
    "op_id",
    "source_kind",
    "base_seq",
    "causal_after_seq",
    "canonical_target_context",
    "raw_set_cookie_or_document_cookie",
  ], ["response_chain_id", "header_index"]);
  const provisional = cookieContextFromPayload(payload);
  const db = await databasePromise;
  const lookup = db.transaction(["profiles", "origin_map", "tabs"], "readonly");
  let verified;
  try {
    verified = await verifyCookieContext(lookup, provisional);
    await complete(lookup);
  } catch (error) {
    lookup.abort();
    throw error;
  }
  const normalized = await normalizeCookieMutation(payload, verified);
  return enqueueCookieOperation(normalized.profile_id, () => persistCookieMutation(normalized));
}

async function normalizeSnapshotRequest(payload, verified) {
  exactObject(payload, [
    "profile_id",
    "origin_id",
    "tab_id",
    "capability_epoch",
    "cookie_capability",
    "known_seq",
    "projection",
    "canonical_target_context",
  ]);
  const context = cookieContextFromPayload(payload);
  if (!["DOCUMENT", "KERNEL", "HEADER"].includes(payload.projection)) {
    throw new TypeError("invalid cookie projection");
  }
  return {
    ...context,
    known_seq: sequence(payload.known_seq),
    projection: payload.projection,
    canonical_target_context: await canonicalCookieTargetContext(
      payload.canonical_target_context,
      verified.mapping,
      verified.tab.top_level_site,
      payload.projection !== "DOCUMENT",
    ),
  };
}

async function verifySnapshotLookup(provisional) {
  const db = await databasePromise;
  const lookup = db.transaction(["profiles", "origin_map", "tabs"], "readonly");
  try {
    const verified = await verifyCookieContext(lookup, provisional);
    await complete(lookup);
    return verified;
  } catch (error) {
    lookup.abort();
    throw error;
  }
}

async function snapshotProjection(core, stateJSON, snapshot, normalized, journalRecords) {
  if (normalized.projection === "DOCUMENT") {
    const projection = JSON.parse(core.document_cookie_projection_json(
      stateJSON,
      JSON.stringify(normalized.canonical_target_context),
      nowUnixSeconds(),
    ));
    if (!Array.isArray(projection)) throw coordinatorError("COOKIE_CORE_UNAVAILABLE", "InvalidStateError");
    return { kind: "SNAPSHOT", cookies: projection };
  }
  if (normalized.projection === "HEADER") {
    const header = core.cookie_header_for_context_json(
      stateJSON,
      JSON.stringify(normalized.canonical_target_context),
      nowUnixSeconds(),
    );
    if (typeof header !== "string") throw coordinatorError("COOKIE_CORE_UNAVAILABLE", "InvalidStateError");
    return { kind: "HEADER", value: header };
  }
  if (normalized.known_seq === 0) return { kind: "SNAPSHOT", cookies: snapshot.cookies };
  const commits = cookieJournalCommits(
    journalRecords,
    normalized.profile_id,
    normalized.known_seq,
  );
  const contiguous = commits.every(
    (commit, index) => commit.cookie_seq === normalized.known_seq + index + 1,
  );
  return contiguous
    ? { kind: "DELTA", from_seq: normalized.known_seq, commits }
    : { kind: "SNAPSHOT", cookies: snapshot.cookies };
}

function validateStoredSnapshot(snapshot, current, normalized) {
  const stale = normalized.known_seq > snapshot.cookie_seq;
  if (snapshot.cookie_seq !== current.profile.cookie_seq || stale)
    throw coordinatorError(stale ? "STALE_OPERATION" : "COOKIE_STATE_CORRUPT", "InvalidStateError");
}

async function executeSnapshotRequest(normalized) {
  const core = await loadCookieCore();
  const database = await databasePromise;
  const current = await loadCookieAuthority(database, normalized);
  const stateJSON = JSON.stringify(current.state);
  const snapshot = stateSnapshot(core, stateJSON, nowUnixSeconds());
  validateStoredSnapshot(snapshot, current, normalized);
  const jarOrDelta = await snapshotProjection(
    core,
    stateJSON,
    snapshot,
    normalized,
    current.journalRecords,
  );
  return {
    operation: "COOKIE_SNAPSHOT",
    cookie_seq: snapshot.cookie_seq,
    jar_or_delta: jarOrDelta,
  };
}

async function cookieSnapshotRequest(payload) {
  exactObject(payload, [
    "profile_id",
    "origin_id",
    "tab_id",
    "capability_epoch",
    "cookie_capability",
    "known_seq",
    "projection",
    "canonical_target_context",
  ]);
  const provisional = cookieContextFromPayload(payload);
  const verified = await verifySnapshotLookup(provisional);
  const normalized = await normalizeSnapshotRequest(payload, verified);
  return enqueueCookieOperation(normalized.profile_id, () => executeSnapshotRequest(normalized));
}

async function cookieCommit(payload) {
  exactObject(payload, [
    "profile_id",
    "origin_id",
    "tab_id",
    "capability_epoch",
    "cookie_capability",
    "op_id",
  ]);
  const context = cookieContextFromPayload(payload);
  const opID = requiredString(payload.op_id, 256);
  return enqueueCookieOperation(context.profile_id, async () => {
    const db = await databasePromise;
    const transaction = db.transaction(["profiles", "origin_map", "tabs", "cookie_journal"], "readonly");
    try {
      await verifyCookieContext(transaction, context);
      const entry = await request(
        transaction.objectStore("cookie_journal").index("by_operation").get([
          context.profile_id,
          opID,
        ]),
      );
      if (!entry?.commit) throw coordinatorError("UNKNOWN_OPERATION", "NotFoundError");
      await complete(transaction);
      return publicCookieCommit(entry.commit);
    } catch (error) {
      transaction.abort();
      throw error;
    }
  });
}

function targetWorkerBindingFromPayload(payload) {
  const binding = payload.binding;
  if (!isPlainObject(binding)) throw new TypeError("invalid target worker binding");
  exactObject(binding, ["profile_id", "synthetic_origin", "client_epoch", "capability"], ["registration_id", "worker_version"]);
  requiredString(binding.profile_id, 256);
  requiredString(binding.synthetic_origin, 4096);
  requiredString(binding.capability, 4096);
  if (!Number.isSafeInteger(binding.client_epoch) || binding.client_epoch < 1) throw new TypeError("invalid target worker epoch");
  if (binding.registration_id !== undefined) requiredString(binding.registration_id, 256);
  if (binding.worker_version !== undefined) requiredString(binding.worker_version, 256);
  const context = cookieContextFromPayload(payload);
  if (binding.profile_id !== context.profile_id || binding.client_epoch !== context.capability_epoch) {
    throw coordinatorError("CAPABILITY_REJECTED");
  }
  return { binding, context };
}

function targetWorkerJournalKey(context) {
  return [context.profile_id, context.origin_id];
}

function initialTargetWorkerState(binding) {
  return {
    binding: structuredClone(binding),
    clients: [],
    operations: {},
    registrations: [],
    schema_version: 1,
  };
}

function validTargetWorkerState(state, binding) {
  return isPlainObject(state)
    && state.schema_version === 1
    && isPlainObject(state.binding)
    && state.binding.profile_id === binding.profile_id
    && state.binding.synthetic_origin === binding.synthetic_origin
    && state.binding.client_epoch === binding.client_epoch
    && state.binding.capability === binding.capability
    && Array.isArray(state.registrations)
    && Array.isArray(state.clients)
    && isPlainObject(state.operations);
}

async function targetWorkerJournalLoad(payload) {
  exactObject(payload, ["profile_id", "origin_id", "tab_id", "capability_epoch", "cookie_capability", "binding"]);
  const { binding, context } = targetWorkerBindingFromPayload(payload);
  const db = await databasePromise;
  const transaction = db.transaction(["profiles", "origin_map", "tabs", "target_worker_journal"], "readonly");
  try {
    await verifyCookieContext(transaction, context);
    const record = await request(transaction.objectStore("target_worker_journal").get(targetWorkerJournalKey(context)));
    if (record && (!Number.isSafeInteger(record.revision) || record.revision < 0 || !validTargetWorkerState(record.state, binding))) {
      throw coordinatorError("TARGET_WORKER_JOURNAL_CORRUPT");
    }
    await complete(transaction);
    return record
      ? { revision: record.revision, state: record.state }
      : { revision: 0, state: initialTargetWorkerState(binding) };
  } catch (error) {
    transaction.abort();
    throw error;
  }
}

async function targetWorkerJournalCompareAndSwap(payload) {
  exactObject(payload, [
    "profile_id",
    "origin_id",
    "tab_id",
    "capability_epoch",
    "cookie_capability",
    "binding",
    "expected_revision",
    "operation_id",
    "operation_binding",
    "state",
  ]);
  const { binding, context } = targetWorkerBindingFromPayload(payload);
  exactObject(payload.operation_binding, ["profile_id", "synthetic_origin", "client_epoch", "capability"], ["registration_id", "worker_version"]);
  if(payload.operation_binding.registration_id!==undefined)requiredString(payload.operation_binding.registration_id,256);
  if(payload.operation_binding.worker_version!==undefined)requiredString(payload.operation_binding.worker_version,256);
  if (
    !Number.isSafeInteger(payload.expected_revision)
    || payload.expected_revision < 0
    || requiredString(payload.operation_id, 256) !== payload.operation_id
    || !isPlainObject(payload.operation_binding)
    || payload.operation_binding.profile_id !== binding.profile_id
    || payload.operation_binding.synthetic_origin !== binding.synthetic_origin
    || payload.operation_binding.client_epoch !== binding.client_epoch
    || payload.operation_binding.capability !== binding.capability
    || !validTargetWorkerState(payload.state, binding)
  ) {
    throw new TypeError("invalid target worker journal compare-and-swap");
  }
  const db = await databasePromise;
  const transaction = db.transaction(["profiles", "origin_map", "tabs", "target_worker_journal"], "readwrite", { durability: "strict" });
  try {
    await verifyCookieContext(transaction, context);
    const store = transaction.objectStore("target_worker_journal");
    const key = targetWorkerJournalKey(context);
    const record = await request(store.get(key));
    const current = record ?? { revision: 0, state: initialTargetWorkerState(binding) };
    if (!Number.isSafeInteger(current.revision) || current.revision < 0 || !validTargetWorkerState(current.state, binding)) {
      throw coordinatorError("TARGET_WORKER_JOURNAL_CORRUPT");
    }
    if (current.state.operations?.[payload.operation_id]) {
      await complete(transaction);
      return { applied: true, revision: current.revision, state: current.state };
    }
    if (current.revision !== payload.expected_revision) {
      await complete(transaction);
      return { applied: false, revision: current.revision, state: current.state };
    }
    const next = {
      profile_id: context.profile_id,
      origin_id: context.origin_id,
      revision: current.revision + 1,
      state: payload.state,
      updated_at: Date.now(),
    };
    store.put(next);
    await complete(transaction);
    return { applied: true, revision: next.revision, state: next.state };
  } catch (error) {
    transaction.abort();
    throw error;
  }
}

const operations = Object.freeze({
  CREATE_PROFILE: createProfile,
  APPROVE_RELAY_SET: approveRelaySet,
  MAP_ORIGIN: mapOrigin,
  SET_RELAY_CAPABILITY: setRelayCapability,
  CREATE_HANDOFF: createHandoff,
  CONSUME_HANDOFF: consumeHandoff,
  UPDATE_SAME_ORIGIN_HISTORY: updateSameOriginHistory,
  CREATE_COOKIE_CONTEXT: createCookieContext,
  COOKIE_SNAPSHOT_REQUEST: cookieSnapshotRequest,
  COOKIE_MUTATE: cookieMutate,
  COOKIE_COMMIT: cookieCommit,
  TARGET_WORKER_JOURNAL_LOAD: targetWorkerJournalLoad,
  TARGET_WORKER_JOURNAL_CAS: targetWorkerJournalCompareAndSwap,
});

function bindCookieProfile(port, operation, payload) {
  if (!["CREATE_COOKIE_CONTEXT", "COOKIE_SNAPSHOT_REQUEST", "COOKIE_MUTATE", "COOKIE_COMMIT"].includes(operation)) {
    return;
  }
  const profileID = payload?.profile_id;
  if (typeof profileID !== "string") return;
  let profiles = cookiePortProfiles.get(port);
  if (!profiles) {
    profiles = new Set();
    cookiePortProfiles.set(port, profiles);
  }
  profiles.add(profileID);
}

const INITIAL_PORT_OPERATIONS = Object.freeze(new Set([
  "CREATE_PROFILE",
  "CONSUME_HANDOFF",
  "COOKIE_SNAPSHOT_REQUEST",
  "COOKIE_MUTATE",
  "COOKIE_COMMIT",
  "TARGET_WORKER_JOURNAL_LOAD",
  "TARGET_WORKER_JOURNAL_CAS",
]));
const CONTROL_PORT_OPERATIONS = Object.freeze(new Set([
  ...INITIAL_PORT_OPERATIONS,
  "MAP_ORIGIN",
  "APPROVE_RELAY_SET",
  "SET_RELAY_CAPABILITY",
  "CREATE_HANDOFF",
  "CREATE_COOKIE_CONTEXT",
]));
const TARGET_PORT_OPERATIONS = Object.freeze(new Set([
  "MAP_ORIGIN",
  "CREATE_HANDOFF",
  "UPDATE_SAME_ORIGIN_HISTORY",
  "CREATE_COOKIE_CONTEXT",
  "COOKIE_SNAPSHOT_REQUEST",
  "COOKIE_MUTATE",
  "COOKIE_COMMIT",
  "TARGET_WORKER_JOURNAL_LOAD",
  "TARGET_WORKER_JOURNAL_CAS",
]));
const REVISION_REQUIRED_OPERATIONS = Object.freeze(new Set([
  "SET_RELAY_CAPABILITY",
  "APPROVE_RELAY_SET",
  "CREATE_HANDOFF",
  "UPDATE_SAME_ORIGIN_HISTORY",
]));
const RECOVERY_OPERATIONS = Object.freeze(new Set([
  "COOKIE_SNAPSHOT_REQUEST",
  "COOKIE_MUTATE",
  "COOKIE_COMMIT",
  "TARGET_WORKER_JOURNAL_LOAD",
  "TARGET_WORKER_JOURNAL_CAS",
]));
const PORT_TTL_MS = 30 * 60 * 1000;
const MAX_COORDINATOR_MESSAGE_BYTES = 64 * 1024;
const MAX_FORM_HANDOFF_MESSAGE_BYTES = 24 << 20;
const MAX_PORT_REQUEST_IDS = 4096;

function validCoordinatorMessage(message) {
  if (!isPlainObject(message)) return false;
  try {
    exactObject(
      message,
      ["v", "request_id", "operation", "expected_revision", "payload"],
    );
    const encoded = JSON.stringify(message);
    const maximumBytes=message.operation==="CREATE_HANDOFF"&&message.payload?.form_submission!==undefined?MAX_FORM_HANDOFF_MESSAGE_BYTES:MAX_COORDINATOR_MESSAGE_BYTES;
    return message.v === 2
      && typeof message.request_id === "string"
      && message.request_id.length >= 16
      && message.request_id.length <= 64
      && /^[A-Za-z0-9_-]+$/u.test(message.request_id)
      && typeof message.operation === "string"
      && /^[A-Z][A-Z0-9_]{1,63}$/u.test(message.operation)
      && Boolean(operations[message.operation])
      && (message.expected_revision === null
        || Number.isSafeInteger(message.expected_revision) && message.expected_revision >= 0)
      && isPlainObject(message.payload)
      && Object.keys(message.payload).length <= 64
      && typeof encoded === "string"
      && encoder.encode(encoded).byteLength <= maximumBytes;
  } catch {
    return false;
  }
}

function coordinatorFailureCode(error) {
  if (typeof error?.code === "string" && error.code) {
    try {
      errorSpecification(error.code);
      return error.code;
    } catch {
      // Map unknown causes once at this owning boundary.
    }
  }
  if (error?.name === "SecurityError") return "CAPABILITY_REJECTED";
  if (error?.name === "TypeError") return "INVALID_MESSAGE";
  if (error?.name === "TransactionInactiveError") return "COOKIE_STATE_UNAVAILABLE";
  return "COORDINATOR_FAILED";
}

function postCoordinatorFailure(port, requestID, revision, code) {
  const responseRequestID = typeof requestID === "string" && errorRequestIDPattern.test(requestID)
    ? requestID
    : randomID();
  port.postMessage({
    v: 2,
    request_id: responseRequestID,
    ok: false,
    revision,
    error: createPublicError(code, responseRequestID),
  });
}

function lineageMatchesPayload(lineage, payload) {
  return lineage?.profile_id === payload.profile_id
    && (payload.tab_id === undefined || payload.tab_id === lineage.tab_id)
    && (payload.capability_epoch === undefined
      || payload.capability_epoch === lineage.capability_epoch)
    && (payload.origin_id === undefined || payload.origin_id === lineage.origin_id);
}

function portProfileAuthorized(binding, message) {
  const profileID = message.payload.profile_id;
  if (typeof profileID !== "string") return true;
  if (binding.control_profiles.has(profileID)) return true;
  if (lineageMatchesPayload(binding.lineage, message.payload)) return true;
  return binding.mode === "UNBOUND" && RECOVERY_OPERATIONS.has(message.operation);
}

function authorizeBoundPort(port, message) {
  const binding = portBindings.get(port);
  if (
    !binding
    || binding.expires_at <= Date.now()
    || !binding.allowed_operations.has(message.operation)
  ) {
    throw coordinatorError("CAPABILITY_REJECTED");
  }
  if (binding.request_ids.has(message.request_id)) {
    throw coordinatorError("REPLAY_DETECTED");
  }
  if (binding.request_ids.size >= MAX_PORT_REQUEST_IDS) {
    throw coordinatorError("PORT_REQUEST_LIMIT", "InvalidStateError");
  }
  binding.request_ids.add(message.request_id);
  if (!portProfileAuthorized(binding, message)) {
    throw coordinatorError("CAPABILITY_REJECTED");
  }
  return binding;
}

function bindPortAfterOperation(port, operation, payload, result) {
  const binding = portBindings.get(port);
  if (operation === "CREATE_PROFILE") {
    binding.mode = "CONTROL";
    binding.allowed_operations = new Set(CONTROL_PORT_OPERATIONS);
  } else if (operation === "CONSUME_HANDOFF") {
    binding.mode = "TARGET";
    binding.allowed_operations = new Set(TARGET_PORT_OPERATIONS);
    binding.expires_at = Math.min(
      Date.now() + PORT_TTL_MS,
      ...result.relay_capabilities.map(capability => Date.parse(capability.expires_at)),
    );
  } else if (binding.mode === "UNBOUND" && RECOVERY_OPERATIONS.has(operation)) {
    binding.mode = "RECOVERY";
    binding.allowed_operations = new Set(RECOVERY_OPERATIONS);
    binding.lineage = {
      profile_id: payload.profile_id,
      tab_id: payload.tab_id,
      origin_id: payload.origin_id,
      capability_epoch: payload.capability_epoch,
      entry_id: null,
      document_capability: null,
      revision: null,
    };
  }
}

async function handleCoordinatorMessage(port, message) {
  const db = await databasePromise;
  let revision = await readCoordinatorRevision(db);
  if (!validCoordinatorMessage(message)) {
    postCoordinatorFailure(
      port,
      typeof message?.request_id === "string" ? message.request_id : "",
      revision,
      "INVALID_MESSAGE",
    );
    return;
  }
  try {
    authorizeBoundPort(port, message);
    if (
      REVISION_REQUIRED_OPERATIONS.has(message.operation)
      && message.expected_revision !== revision
    ) {
      throw coordinatorError("STALE_OPERATION");
    }
    revision = await advanceCoordinatorRevision(db, revision);
    const result = await operations[message.operation](message.payload, port);
    bindPortAfterOperation(port, message.operation, message.payload, result);
    bindCookieProfile(port, message.operation, message.payload);
    port.postMessage({
      v: 2,
      request_id: message.request_id,
      ok: true,
      revision,
      result,
    });
  } catch (error) {
    postCoordinatorFailure(
      port,
      message.request_id,
      revision,
      coordinatorFailureCode(error),
    );
  }
}

function enqueueCoordinatorMessage(port, message) {
  const handled = coordinatorMessageQueue.then(() => handleCoordinatorMessage(port, message));
  coordinatorMessageQueue = handled.catch(() => {});
}

function attach(port) {
  attachedPorts.add(port);
  cookiePortProfiles.set(port, new Set());
  portBindings.set(port, {
    port_id: randomID(18),
    mode: "UNBOUND",
    allowed_operations: new Set(INITIAL_PORT_OPERATIONS),
    control_profiles: new Set(),
    lineage: null,
    expires_at: Date.now() + PORT_TTL_MS,
    request_ids: new Set(),
  });
  port.onmessage = event => {
    enqueueCoordinatorMessage(port, event.data);
  };
  port.onmessageerror = () => {
    attachedPorts.delete(port);
    cookiePortProfiles.delete(port);
    portBindings.delete(port);
  };
  port.start();
}

self.onconnect = (event) => {
  for (const port of event.ports) attach(port);
};
