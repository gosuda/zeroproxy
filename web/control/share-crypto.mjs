const MAX_TARGET_BYTES = 8192;
const MAX_SHARE_BYTES = 16 * 1024;
const SHARE_PATH_PREFIX = "/_zp/s/v2/";
const AAD_PREFIX = new TextEncoder().encode("ZeroProxy Share V2\0");
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function shareError(message, name = "DataError") {
  return new DOMException(message, name);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function compareBytes(left, right) {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function cborHead(major, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("invalid CBOR integer");
  if (value < 24) return Uint8Array.of((major << 5) | value);
  if (value <= 255) return Uint8Array.of((major << 5) | 24, value);
  if (value <= 65535) return Uint8Array.of((major << 5) | 25, value >> 8, value);
  const output = new Uint8Array(9);
  const view = new DataView(output.buffer);
  output[0] = (major << 5) | 27;
  view.setBigUint64(1, BigInt(value));
  return output;
}

function encodeCanonicalCBOR(value) {
  if (value === null) return Uint8Array.of(0xf6);
  if (Number.isSafeInteger(value) && value >= 0) return cborHead(0, value);
  if (typeof value === "string") {
    const bytes = textEncoder.encode(value);
    return concat(cborHead(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concat(cborHead(2, value.length), value);
  if (typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value)
      .map(([key, entryValue]) => [encodeCanonicalCBOR(key), encodeCanonicalCBOR(entryValue)])
      .sort(([left], [right]) => left.length - right.length || compareBytes(left, right));
    return concat(cborHead(5, entries.length), ...entries.flat());
  }
  throw new TypeError("unsupported CBOR value");
}

function encodedLengthWidth(additionalInformation) {
  switch (additionalInformation) {
    case 24: return 1;
    case 25: return 2;
    case 26: return 4;
    case 27: return 8;
    default: return 0;
  }
}

function minimumEncodedLength(width) {
  switch (width) {
    case 1: return 24n;
    case 2: return 256n;
    case 4: return 65536n;
    default: return 4294967296n;
  }
}

function readLength(bytes, state, additionalInformation) {
  if (additionalInformation < 24) return additionalInformation;
  const width = encodedLengthWidth(additionalInformation);
  if (!width || state.offset + width > bytes.length) throw shareError("Malformed CBOR");
  let value = 0n;
  for (let index = 0; index < width; index += 1) {
    value = (value << 8n) | BigInt(bytes[state.offset]);
    state.offset += 1;
  }
  if (value < minimumEncodedLength(width) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw shareError("Noncanonical CBOR");
  }
  return Number(value);
}

function decodeBytes(bytes, state, length, asText) {
  if (state.offset + length > bytes.length) throw shareError("Malformed CBOR");
  const value = bytes.slice(state.offset, state.offset + length);
  state.offset += length;
  try {
    return asText ? textDecoder.decode(value) : value;
  } catch {
    throw shareError("Invalid UTF-8");
  }
}

function decodeMap(bytes, state, length) {
  const output = Object.create(null);
  const seen = new Set();
  let previous = null;
  for (let index = 0; index < length; index += 1) {
    const keyStart = state.offset;
    const key = decodeItem(bytes, state);
    const encodedKey = bytes.slice(keyStart, state.offset);
    if (typeof key !== "string" || seen.has(key)) throw shareError("Invalid CBOR map");
    if (previous && (previous.length > encodedKey.length
      || (previous.length === encodedKey.length && compareBytes(previous, encodedKey) >= 0))) {
      throw shareError("Noncanonical CBOR map");
    }
    seen.add(key);
    output[key] = decodeItem(bytes, state);
    previous = encodedKey;
  }
  return output;
}

function decodeItem(bytes, state) {
  if (state.offset >= bytes.length) throw shareError("Malformed CBOR");
  const first = bytes[state.offset];
  state.offset += 1;
  if (first === 0xf6) return null;
  const major = first >> 5;
  const length = readLength(bytes, state, first & 31);
  if (major === 0) return length;
  if (major === 2) return decodeBytes(bytes, state, length, false);
  if (major === 3) return decodeBytes(bytes, state, length, true);
  if (major === 5) return decodeMap(bytes, state, length);
  throw shareError("Unsupported CBOR");
}

function decodeCanonicalCBOR(bytes) {
  const state = { offset: 0 };
  const value = decodeItem(bytes, state);
  if (state.offset !== bytes.length) throw shareError("Trailing CBOR");
  return value;
}

export function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeBase64url(text, noncanonicalError = "DataError") {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw shareError("Malformed envelope");
  }
  const padded = text.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - (text.length % 4)) % 4);
  let bytes;
  try {
    bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw shareError("Malformed envelope");
  }
  if (base64url(bytes) !== text) throw shareError("Noncanonical envelope", noncanonicalError);
  return bytes;
}

function canonicalControlOrigin(controlOrigin) {
  let parsed;
  try {
    parsed = new URL(controlOrigin);
  } catch {
    throw shareError("Invalid control origin", "SecurityError");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.origin === "null") {
    throw shareError("Invalid control origin", "SecurityError");
  }
  return parsed.origin;
}

const SHARE_FIELDS = Object.freeze([
  "v",
  "target_url",
  "created_at",
  "expires_at",
  "relay_profile_digest",
  "requested_profile_mode",
  "flags",
]);

function canonicalShareTarget(value) {
  if (typeof value !== "string" || textEncoder.encode(value).length > MAX_TARGET_BYTES) {
    throw shareError("Invalid target", "SecurityError");
  }
  let target;
  try {
    target = new URL(value);
  } catch {
    throw shareError("Invalid target", "SecurityError");
  }
  if ((target.protocol !== "http:" && target.protocol !== "https:") || target.username || target.password) {
    throw shareError("Invalid target", "SecurityError");
  }
  return target.href;
}

function validShareTimes(record, now) {
  return Number.isSafeInteger(record.created_at) && record.created_at >= 0
    && (record.expires_at === null || (Number.isSafeInteger(record.expires_at)
      && record.expires_at > record.created_at && record.expires_at > now));
}

function validRelayAndOptions(record) {
  const digest = record.relay_profile_digest;
  return (digest === null || (digest instanceof Uint8Array && digest.length === 32))
    && (record.requested_profile_mode === "ephemeral"
      || record.requested_profile_mode === "persistent")
    && record.flags === 0;
}

function validateShare(record, now) {
  if (!record || typeof record !== "object" || Array.isArray(record)
    || Object.keys(record).length !== SHARE_FIELDS.length
    || SHARE_FIELDS.some((field) => !(field in record)) || record.v !== 2) {
    throw shareError("Invalid share");
  }
  const targetURL = canonicalShareTarget(record.target_url);
  if (!validShareTimes(record, now)) throw shareError("Expired share", "InvalidStateError");
  if (!validRelayAndOptions(record)) throw shareError("Invalid share");
  return Object.freeze({ ...record, target_url: targetURL });
}

function assertShareSize(url) {
  if (textEncoder.encode(url).length > MAX_SHARE_BYTES) {
    throw shareError("Share too large", "QuotaExceededError");
  }
}

export async function sealShare(record, controlOrigin) {
  const origin = canonicalControlOrigin(controlOrigin);
  const checked = validateShare(record, record.created_at);
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const additionalData = concat(AAD_PREFIX, textEncoder.encode(origin));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData },
    key,
    encodeCanonicalCBOR(checked),
  ));
  const path = `${SHARE_PATH_PREFIX}${base64url(concat(nonce, ciphertext))}#k=${base64url(keyBytes)}`;
  assertShareSize(new URL(path, origin).href);
  return path;
}

export async function openShare(url, controlOrigin, now = Date.now()) {
  const origin = canonicalControlOrigin(controlOrigin);
  let parsed;
  try {
    parsed = new URL(url, origin);
  } catch {
    throw shareError("Invalid share origin", "SecurityError");
  }
  assertShareSize(parsed.href);
  const pathMatch = /^\/_zp\/s\/v2\/([A-Za-z0-9_-]+)$/.exec(parsed.pathname);
  const keyMatch = /^#k=([A-Za-z0-9_-]+)$/.exec(parsed.hash);
  if (parsed.origin !== origin || parsed.search || !pathMatch || !keyMatch) {
    throw shareError("Invalid share origin", "SecurityError");
  }
  const envelope = decodeBase64url(pathMatch[1], "SecurityError");
  const keyBytes = decodeBase64url(keyMatch[1], "SecurityError");
  if (envelope.length < 29 || keyBytes.length !== 32) throw shareError("Malformed envelope");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const additionalData = concat(AAD_PREFIX, textEncoder.encode(origin));
  let plaintext;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: envelope.slice(0, 12), additionalData },
      key,
      envelope.slice(12),
    ));
  } catch {
    throw shareError("Invalid share tag", "SecurityError");
  }
  return validateShare(decodeCanonicalCBOR(plaintext), now);
}
