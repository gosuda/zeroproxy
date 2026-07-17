const FORM_ENCTYPES = new Set([
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
]);

const BEACON_MAX_BYTES = 64 << 10;
const SEALED_OPERATION_LIMIT = 4_096;
const SEALED_OPERATION_ID = /^[0-9a-f]{48}$/;
const PING_BYTES = new Uint8Array([80, 73, 78, 71]);

function planError(message) {
  throw new DOMException(message, "SecurityError");
}

export function normalizeFormMethod(value) {
  if (typeof value !== "string") planError("Invalid form method");
  const method = value.toUpperCase();
  if (method !== "GET" && method !== "POST") planError("Unsupported form method");
  return method;
}

export function normalizeFormEnctype(value) {
  if (typeof value !== "string") planError("Invalid form enctype");
  const enctype = value.toLowerCase();
  if (!FORM_ENCTYPES.has(enctype)) planError("Unsupported form enctype");
  return enctype;
}

export function formContentTypeMatches(enctype, contentType) {
  if (typeof contentType !== "string" || contentType.length === 0 || contentType.length > 1024 || /[\r\n]/.test(contentType)) return false;
  const normalized = contentType.toLowerCase();
  if (enctype === "multipart/form-data") return /^multipart\/form-data;\s*boundary=[^\s;]{1,200}(?:;|$)/.test(normalized);
  if (enctype === "application/x-www-form-urlencoded") return /^application\/x-www-form-urlencoded(?:\s*;|$)/.test(normalized);
  return /^text\/plain(?:\s*;|$)/.test(normalized);
}

export function normalizeBeaconBody(value, contentType) {
  if (!(value instanceof Uint8Array) || value.byteLength > BEACON_MAX_BYTES) planError("Invalid beacon body");
  if (typeof contentType !== "string" || contentType.length > 256 || /[\r\n]/.test(contentType)) planError("Invalid beacon content type");
  return Object.freeze({ body: value.slice(), contentType });
}

export function normalizePingBody(value, contentType) {
  if (!(value instanceof Uint8Array)
    || value.byteLength !== PING_BYTES.byteLength
    || value.some((byte, index) => byte !== PING_BYTES[index])
    || !/^text\/ping(?:\s*;|$)/i.test(contentType)) planError("Invalid anchor ping body");
  return PING_BYTES.slice();
}

export function normalizeDownloadFilename(value, targetURL) {
  if (value == null || value === "") {
    const name = new URL(targetURL).pathname.split("/").filter(Boolean).at(-1);
    return name && name.length <= 255 ? name : "download";
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 255 || /[\u0000-\u001f\u007f\\/\r\n]/.test(value)) planError("Invalid download filename");
  return value;
}

export function attachmentDisposition(filename) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function preserveAttachmentDisposition(value, fallbackFilename) {
  if (typeof value === "string" && value.length <= 1_024 && !/[\r\n]/.test(value) && /^\s*attachment(?:\s*;|$)/i.test(value)) return value;
  return attachmentDisposition(fallbackFilename);
}

export function nextSealedOperationRecord(current, binding, operation) {
  if (!binding || typeof binding !== "object" || !SEALED_OPERATION_ID.test(operation)
    || typeof binding.source_client_id !== "string" || binding.source_client_id.length === 0
    || typeof binding.document_id !== "string" || binding.document_id.length === 0
    || typeof binding.profile_id !== "string" || binding.profile_id.length === 0
    || typeof binding.origin_id !== "string" || binding.origin_id.length === 0
    || !Number.isSafeInteger(binding.capability_epoch) || binding.capability_epoch < 1) planError("Invalid sealed operation binding");
  const expected = {
    id: `sealed-use:${binding.source_client_id}`,
    kind: "sealed-use",
    source_client_id: binding.source_client_id,
    document_id: binding.document_id,
    profile_id: binding.profile_id,
    origin_id: binding.origin_id,
    capability_epoch: binding.capability_epoch,
  };
  const operations = current?.operations ?? [];
  if (current != null && (typeof current !== "object"
    || Object.entries(expected).some(([key, value]) => current[key] !== value)
    || !Array.isArray(operations)
    || operations.length > SEALED_OPERATION_LIMIT
    || operations.some(value => !SEALED_OPERATION_ID.test(value))
    || new Set(operations).size !== operations.length)) planError("Invalid sealed operation record");
  if (operations.includes(operation)) planError("Sealed operation replay");
  if (operations.length >= SEALED_OPERATION_LIMIT) planError("Sealed operation limit exceeded");
  return Object.freeze({ ...expected, operations: Object.freeze([...operations, operation]) });
}

const REFERRER_POLICIES = new Set([
  "",
  "no-referrer",
  "no-referrer-when-downgrade",
  "origin",
  "origin-when-cross-origin",
  "same-origin",
  "strict-origin",
  "strict-origin-when-cross-origin",
  "unsafe-url",
]);

function httpURL(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    planError(`Invalid ${label} URL`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) planError(`Invalid ${label} URL`);
  return url;
}

function trustworthyDowngrade(source, target) {
  return source.protocol === "https:" && target.protocol !== "https:";
}

export function serializeRequestOrigin(sourceURL, targetURL, referrerPolicy, method = "POST") {
  const source = httpURL(sourceURL, "request source"), target = httpURL(targetURL, "request target");
  if (!REFERRER_POLICIES.has(referrerPolicy) || typeof method !== "string") planError("Invalid request origin policy");
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD") return "";
  const crossOrigin = source.origin !== target.origin;
  const nullOrigin = referrerPolicy === "no-referrer"
    || referrerPolicy === "same-origin" && crossOrigin
    || ["no-referrer-when-downgrade", "strict-origin", "strict-origin-when-cross-origin"].includes(referrerPolicy) && trustworthyDowngrade(source, target);
  return nullOrigin ? "null" : source.origin;
}

export function anchorPingRequestMetadata(sourceURL, pingURL, destinationURL, referrerPolicy) {
  const source = httpURL(sourceURL, "ping source"), ping = httpURL(pingURL, "ping target"), destination = httpURL(destinationURL, "ping destination");
  const headers = [["Accept", "*/*"], ["Content-Type", "text/ping"], ["Ping-To", destination.href]];
  if (source.origin === ping.origin || source.protocol !== "https:") headers.push(["Ping-From", source.href]);
  return Object.freeze({
    headers: Object.freeze(headers.map(pair => Object.freeze(pair))),
    corsOrigin: "",
    referrerPolicy,
    referrerSource: "",
    referrer: "",
  });
}

export const anchorPingPolicy = Object.freeze({ enabled: true, max_targets: 16, content_type: "text/ping", body: "PING" });
