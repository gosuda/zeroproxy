const algorithms = Object.freeze({
  sha256: Object.freeze({ digest: "SHA-256", size: 32, strength: 1 }),
  sha384: Object.freeze({ digest: "SHA-384", size: 48, strength: 2 }),
  sha512: Object.freeze({ digest: "SHA-512", size: 64, strength: 3 }),
});

function decodeDigest(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  if (normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function strongestDigests(metadata) {
  if (typeof metadata !== "string" || metadata.trim() === "") return null;
  let strongest = 0;
  let selected = [];
  for (const token of metadata.trim().split(/\s+/u)) {
    const match = /^(sha256|sha384|sha512)-([^?]+)(?:\?[^\s]*)?$/u.exec(token);
    if (!match) continue;
    const algorithm = algorithms[match[1]];
    const digest = decodeDigest(match[2]);
    if (!digest || algorithm.strength < strongest) continue;
    if (algorithm.strength > strongest) {
      strongest = algorithm.strength;
      selected = [];
    }
    selected.push(digest);
  }
  if (selected.length === 0) return null;
  const algorithm = Object.values(algorithms).find(candidate => candidate.strength === strongest);
  return { algorithm: algorithm.digest, digests: selected };
}

function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}
function headerValues(headers, name) {
  return headers?.filter?.(([key]) => String(key).toLowerCase() === name).map(([, value]) => value) ?? [];
}

function corsAllowsIntegrity({ sourceURL, targetURL, corsMode, headers }) {
  let source;
  let target;
  try {
    source = new URL(sourceURL);
    target = new URL(targetURL);
  } catch {
    return false;
  }
  if (source.origin === target.origin) return true;
  if (corsMode !== "anonymous" && corsMode !== "use-credentials") return false;
  const allowedOrigins = headerValues(headers, "access-control-allow-origin");
  if (allowedOrigins.length !== 1) return false;
  const allowedOrigin = allowedOrigins[0];
  if (corsMode === "use-credentials") {
    const credentials = headerValues(headers, "access-control-allow-credentials");
    return allowedOrigin === source.origin && credentials.length === 1 && credentials[0] === "true";
  }
  return allowedOrigin === "*" || allowedOrigin === source.origin;
}


export async function verifyIntegrity(body, metadata, corsContext = null) {
  const expected = strongestDigests(metadata);
  if (!expected) return true;
  if (corsContext && !corsAllowsIntegrity(corsContext)) return false;
  const actual = new Uint8Array(await crypto.subtle.digest(expected.algorithm, body));
  return expected.digests.some(digest => equalBytes(actual, digest));
}
