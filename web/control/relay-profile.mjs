import { ADDRESS_POLICY_ID, BLOCKED_ADDRESS_SUFFIXES } from "../generated/address-policy.mjs";

const PROFILE_FIELDS = Object.freeze([
  "address_policy_digest", "allowed_browse_domain", "allowed_target_ports", "allowed_target_schemes",
  "carrier_path", "deployment_id", "display_name", "expires_at", "issued_at", "key_epoch", "limits",
  "privacy_disclosure", "profile_id", "relay_wss_origin", "schema_version", "tor_mode",
]);
const LIMIT_FIELDS = Object.freeze([
  "download_byte_budget", "handshake_timeout_ms", "idle_timeout_ms", "max_frame_bytes", "max_frames_per_second",
  "max_message_bytes", "max_sessions", "max_streams", "session_deadline_ms", "upload_byte_budget",
]);
const DISCLOSURE = "The relay sees the client IP, target hostname and port, timing and volume, and plaintext HTTP, but not verified HTTPS plaintext.";
const encoder = new TextEncoder();

function securityError(message) {
  return new DOMException(message, "SecurityError");
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactObject(value, required, optional = []) {
  if (!plainObject(value)) throw securityError("Relay profile object required");
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some((key) => !(key in value)) || keys.some((key) => !allowed.has(key)) || keys.length < required.length) {
    throw securityError("Relay profile fields rejected");
  }
  return value;
}

function canonicalJSON(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw securityError("Non-finite relay profile number");
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw securityError("Unsupported relay profile value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`;
}

function decodeBase64URL(value, bytes, label) {
  if (typeof value !== "string" || !new RegExp(`^[A-Za-z0-9_-]{${Math.ceil(bytes * 4 / 3)}}$`).test(value)) {
    throw securityError(`Invalid ${label}`);
  }
  let decoded;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    decoded = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw securityError(`Invalid ${label}`);
  }
  if (decoded.byteLength !== bytes) throw securityError(`Invalid ${label}`);
  return decoded;
}

function base64URL(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw securityError(`Invalid ${label}`);
  return value;
}

function canonicalTime(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) throw securityError(`Invalid ${label}`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value.replace("Z", ".000Z")) throw securityError(`Invalid ${label}`);
  return parsed;
}

function domain(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 253 || value !== value.toLowerCase()) return false;
  return value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$|^[a-z0-9]$/.test(label));
}

function validateLimits(value) {
  exactObject(value, LIMIT_FIELDS);
  integer(value.max_sessions, 1, 4096, "max sessions");
  integer(value.max_streams, 1, 4096, "max streams");
  integer(value.upload_byte_budget, 1, Number.MAX_SAFE_INTEGER, "upload budget");
  integer(value.download_byte_budget, 1, Number.MAX_SAFE_INTEGER, "download budget");
  integer(value.max_frame_bytes, 1, 65_536, "frame limit");
  integer(value.max_message_bytes, value.max_frame_bytes, 4_194_304, "message limit");
  integer(value.max_frames_per_second, 1, 10_000, "frame rate");
  integer(value.handshake_timeout_ms, 1_000, 60_000, "handshake timeout");
  integer(value.idle_timeout_ms, 1_000, 3_600_000, "idle timeout");
  integer(value.session_deadline_ms, value.idle_timeout_ms, 86_400_000, "session deadline");
}

function validateProfileIdentity(profile) {
  if (profile.schema_version !== 1 || typeof profile.profile_id !== "string" || !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(profile.profile_id)) throw securityError("Invalid relay profile identity");
  if (typeof profile.display_name !== "string" || profile.display_name.length === 0 || profile.display_name.length > 128) throw securityError("Invalid relay display name");
  if (typeof profile.deployment_id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(profile.deployment_id)) throw securityError("Invalid relay deployment");
}

function validateRelayAuthority(profile) {
  let relay;
  try { relay = new URL(profile.relay_wss_origin); } catch { throw securityError("Invalid relay origin"); }
  if (relay.protocol !== "wss:" || relay.username || relay.password || relay.pathname !== "/" || relay.search || relay.hash || `${relay.protocol}//${relay.host}` !== profile.relay_wss_origin) throw securityError("Invalid relay origin");
  if (profile.carrier_path !== "/_zp/carrier" || !domain(profile.allowed_browse_domain)) throw securityError("Invalid relay browsing authority");
}

function validateTargetPolicy(profile) {
  if (!Array.isArray(profile.allowed_target_schemes) || profile.allowed_target_schemes.length === 0 || profile.allowed_target_schemes.length > 2 || profile.allowed_target_schemes.some((scheme, index) => !["http", "https"].includes(scheme) || index > 0 && scheme <= profile.allowed_target_schemes[index - 1])) throw securityError("Invalid relay target schemes");
  if (!Array.isArray(profile.allowed_target_ports) || profile.allowed_target_ports.length === 0 || profile.allowed_target_ports.length > 256 || profile.allowed_target_ports.some((port, index) => !Number.isInteger(port) || port < 1 || port > 65_535 || index > 0 && port <= profile.allowed_target_ports[index - 1])) throw securityError("Invalid relay target ports");
  if (typeof profile.address_policy_digest !== "string" || !/^[a-f0-9]{64}$/.test(profile.address_policy_digest) || profile.tor_mode !== "SOCKS5_DOMAIN_RFC1929") throw securityError("Invalid relay egress policy");
}

function validateProfileValidity(profile, now) {
  const issued = canonicalTime(profile.issued_at, "relay issue time");
  const expires = canonicalTime(profile.expires_at, "relay expiry");
  integer(profile.key_epoch, 1, Number.MAX_SAFE_INTEGER, "relay key epoch");
  if (issued >= expires || now < issued || now >= expires || "revoked_at" in profile) throw securityError("Relay profile expired or revoked");
}

function validateProfile(profile, now) {
  exactObject(profile, PROFILE_FIELDS, ["revoked_at"]);
  validateProfileIdentity(profile);
  validateRelayAuthority(profile);
  validateTargetPolicy(profile);
  validateLimits(profile.limits);
  if (profile.privacy_disclosure !== DISCLOSURE) throw securityError("Invalid relay privacy disclosure");
  validateProfileValidity(profile, now);
}

function validateKeys(keys, now, allowDevelopment) {
  exactObject(keys, ["schema_version", "key_epoch", "threshold", "development_only", "keys"]);
  if (keys.schema_version !== 1 || keys.threshold !== 2 || keys.development_only !== true && keys.development_only !== false || !Array.isArray(keys.keys) || keys.keys.length < keys.threshold || keys.keys.length > 16) throw securityError("Invalid relay signing key set");
  if (keys.development_only && !allowDevelopment) throw securityError("Development relay signatures forbidden");
  const byID = new Map();
  const publicKeys = new Set();
  for (const key of keys.keys) {
    exactObject(key, ["id", "role", "owner", "public_key", "valid_from", "valid_until"]);
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(key.id) || !["release", "security"].includes(key.role) || typeof key.owner !== "string" || key.owner.length < 3 || key.owner.length > 128 || byID.has(key.id) || publicKeys.has(key.public_key)) throw securityError("Invalid relay signing key");
    const validFrom = canonicalTime(key.valid_from, "key validity");
    const validUntil = canonicalTime(key.valid_until, "key validity");
    if (now < validFrom || now >= validUntil) throw securityError("Relay signing key expired");
    decodeBase64URL(key.public_key, 32, "relay public key");
    byID.set(key.id, key);
    publicKeys.add(key.public_key);
  }
  return byID;
}

async function verifySignatures(profile, signatures, keys, keyByID, allowDevelopment) {
  exactObject(signatures, ["algorithm", "canonicalization", "key_epoch", "development_only", "signatures"]);
  if (signatures.algorithm !== "Ed25519" || signatures.canonicalization !== "RFC8785" || signatures.key_epoch !== keys.key_epoch || signatures.development_only !== keys.development_only || signatures.development_only && !allowDevelopment || !Array.isArray(signatures.signatures)) throw securityError("Relay signature metadata mismatch");
  const canonical = encoder.encode(canonicalJSON(profile));
  const owners = new Set();
  const roles = new Set();
  const seen = new Set();
  for (const item of signatures.signatures) {
    exactObject(item, ["key_id", "signature"]);
    if (seen.has(item.key_id)) throw securityError("Duplicate relay signature");
    seen.add(item.key_id);
    const key = keyByID.get(item.key_id);
    if (!key) throw securityError("Unknown relay signing key");
    const publicKey = await crypto.subtle.importKey("raw", decodeBase64URL(key.public_key, 32, "relay public key"), { name: "Ed25519" }, false, ["verify"]);
    const valid = await crypto.subtle.verify({ name: "Ed25519" }, publicKey, decodeBase64URL(item.signature, 64, "relay signature"), canonical);
    if (!valid) throw securityError("Relay signature verification failed");
    owners.add(key.owner);
    roles.add(key.role);
  }
  if (seen.size < keys.threshold || owners.size < keys.threshold || !roles.has("security")) throw securityError("Relay signature threshold not met");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

async function verifyAddressPolicy(config, keys, keyByID, allowDevelopment) {
  const policy = exactObject(config.address_policy, [
    "schema_version", "policy_id", "hostname_canonicalization", "socks_address_type",
    "reject_ip_literals", "reject_single_label", "blocked_suffixes",
  ]);
  if (policy.schema_version !== 1
    || policy.policy_id !== ADDRESS_POLICY_ID
    || policy.hostname_canonicalization !== "UTS46_IDNA2008_LOOKUP"
    || policy.socks_address_type !== "DOMAIN"
    || policy.reject_ip_literals !== true
    || policy.reject_single_label !== true
    || JSON.stringify(policy.blocked_suffixes) !== JSON.stringify(BLOCKED_ADDRESS_SUFFIXES)) {
    throw securityError("Address policy mismatch");
  }
  await verifySignatures(
    policy,
    config.address_policy_signatures,
    keys,
    keyByID,
    allowDevelopment,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalJSON(policy))));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyRelayProfileSet(config, { now = Date.now() } = {}) {
  if (!plainObject(config) || !Array.isArray(config.relay_profiles) || config.relay_profiles.length === 0 || config.relay_profiles.length > 64) throw securityError("Installed relay profiles unavailable");
  const allowDevelopment = config.development_mode === true;
  const keys = config.release_signing_keys;
  const keyByID = validateKeys(keys, now, allowDevelopment);
  const addressPolicyDigest = await verifyAddressPolicy(config, keys, keyByID, allowDevelopment);
  const profiles = new Map();
  for (const record of config.relay_profiles) {
    exactObject(record, ["digest", "profile", "signatures"]);
    decodeBase64URL(record.digest, 32, "relay profile digest");
    if (profiles.has(record.digest)) throw securityError("Duplicate relay profile digest");
    validateProfile(record.profile, now);
    if (record.profile.key_epoch !== keys.key_epoch) throw securityError("Relay profile key epoch mismatch");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalJSON(record.profile))));
    if (base64URL(digest) !== record.digest) throw securityError("Relay profile digest mismatch");
    if (record.profile.address_policy_digest !== addressPolicyDigest) {
      throw securityError("Relay address policy digest mismatch");
    }
    await verifySignatures(record.profile, record.signatures, keys, keyByID, allowDevelopment);
    const profile = structuredClone(record.profile);
    profiles.set(record.digest, deepFreeze({ digest: record.digest, profile, relay_url: profile.relay_wss_origin + profile.carrier_path }));
  }
  return profiles;
}

export { canonicalJSON, DISCLOSURE };
