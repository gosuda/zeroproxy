const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const CANONICAL_ORIGIN = /^(https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?):([1-9][0-9]{0,4})$/u;
const DEPLOYMENT_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const encoder = new TextEncoder();

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) output += BASE32[(value >>> (bits -= 5)) & 31];
  }
  if (bits) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export async function deriveOriginID(profileOriginKey, canonicalOrigin, collisionCounter = 0) {
  if (
    !(profileOriginKey instanceof CryptoKey)
    || profileOriginKey.type !== "secret"
    || profileOriginKey.extractable
    || profileOriginKey.algorithm?.name !== "HMAC"
    || profileOriginKey.algorithm?.hash?.name !== "SHA-256"
    || !profileOriginKey.usages.includes("sign")
  ) throw new TypeError("profileOriginKey must be a non-extracting HMAC-SHA-256 signing key");
  const match = typeof canonicalOrigin === "string" ? CANONICAL_ORIGIN.exec(canonicalOrigin) : null;
  if (!match || Number(match[3]) > 65_535) throw new TypeError("invalid canonical origin");
  if (!Number.isSafeInteger(collisionCounter) || collisionCounter < 0) throw new TypeError("invalid collision counter");
  const counter = collisionCounter ? new Uint8Array(8) : new Uint8Array();
  if (collisionCounter) new DataView(counter.buffer).setBigUint64(0, BigInt(collisionCounter));
  const prefix = encoder.encode(`zeroproxy-origin-v2\0${canonicalOrigin}`);
  const input = new Uint8Array(prefix.length + counter.length);
  input.set(prefix);
  input.set(counter, prefix.length);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", profileOriginKey, input));
  return base32(digest.subarray(0, 20));
}

export function browseHost(originID, deploymentDomain) {
  if (!/^[a-z2-7]{32}$/.test(originID)) throw new TypeError("invalid origin id");
  const domain = typeof deploymentDomain === "string" ? deploymentDomain.toLowerCase() : "";
  if (!DEPLOYMENT_DOMAIN.test(domain) || domain.length > 205) throw new TypeError("invalid deployment domain");
  return `o-${originID}.browse.${domain}`;
}
