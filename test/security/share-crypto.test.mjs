import assert from "node:assert/strict";
import test from "node:test";
import { base64url, openShare, sealShare } from "../../web/control/share-crypto.mjs";

const CONTROL_ORIGIN = "https://control.test";
const AAD = new TextEncoder().encode("ZeroProxy Share V2\0https://control.test");

function record(overrides = {}) {
  return {
    v: 2,
    target_url: "https://example.test/path?q=1",
    created_at: 1000,
    expires_at: 2000,
    relay_profile_digest: null,
    requested_profile_mode: "ephemeral",
    flags: 0,
    ...overrides,
  };
}

function decodeBase64url(text) {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function concat(...parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function findBytes(bytes, sequence) {
  outer: for (let offset = 0; offset <= bytes.length - sequence.length; offset += 1) {
    for (let index = 0; index < sequence.length; index += 1) {
      if (bytes[offset + index] !== sequence[index]) continue outer;
    }
    return offset;
  }
  throw new Error("CBOR sequence unavailable");
}

function readCBORLength(bytes, offset, additionalInformation) {
  if (additionalInformation < 24) return [additionalInformation, offset];
  const width = { 24: 1, 25: 2, 26: 4, 27: 8 }[additionalInformation];
  if (!width) throw new Error("unsupported fixture CBOR");
  let length = 0;
  for (let index = 0; index < width; index += 1) length = (length * 256) + bytes[offset + index];
  return [length, offset + width];
}

function cborItemEnd(bytes, start) {
  const first = bytes[start];
  if (first === 0xf6) return start + 1;
  const major = first >> 5;
  const [length, bodyStart] = readCBORLength(bytes, start + 1, first & 31);
  if (major === 0) return bodyStart;
  if (major === 2 || major === 3) return bodyStart + length;
  if (major === 5) {
    let end = bodyStart;
    for (let index = 0; index < length * 2; index += 1) end = cborItemEnd(bytes, end);
    return end;
  }
  throw new Error("unsupported fixture CBOR");
}

async function decryptFixture(path) {
  const parsed = new URL(path, CONTROL_ORIGIN);
  const envelope = decodeBase64url(parsed.pathname.slice("/_zp/s/v2/".length));
  const keyBytes = decodeBase64url(parsed.hash.slice(3));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt", "encrypt"]);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: envelope.slice(0, 12), additionalData: AAD },
    key,
    envelope.slice(12),
  ));
  return { key, keyBytes, nonce: envelope.slice(0, 12), plaintext };
}

async function resealFixture(fixture, plaintext) {
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: fixture.nonce, additionalData: AAD },
    fixture.key,
    plaintext,
  ));
  return `${CONTROL_ORIGIN}/_zp/s/v2/${base64url(concat(fixture.nonce, ciphertext))}#k=${base64url(fixture.keyBytes)}`;
}

test("share round trip keeps key only in fragment", async () => {
  const path = await sealShare(record(), CONTROL_ORIGIN);
  const parsed = new URL(path, CONTROL_ORIGIN);
  assert.equal(parsed.search, "");
  assert.match(parsed.hash, /^#k=[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(parsed.pathname, /example|q=1/);
  const opened = await openShare(parsed.href, CONTROL_ORIGIN, 1500);
  assert.equal(opened.target_url, "https://example.test/path?q=1");
});

test("share rejects tamper expiry origin userinfo and unsafe records", async () => {
  const path = await sealShare(record(), CONTROL_ORIGIN);
  const parsed = new URL(path, CONTROL_ORIGIN);
  parsed.pathname = `${parsed.pathname.slice(0, -1)}${parsed.pathname.at(-1) === "A" ? "B" : "A"}`;
  await assert.rejects(openShare(parsed.href, CONTROL_ORIGIN, 1500), { name: "SecurityError" });

  const expired = await sealShare(record(), CONTROL_ORIGIN);
  await assert.rejects(openShare(expired, CONTROL_ORIGIN, 2000), { name: "InvalidStateError" });
  await assert.rejects(sealShare(record({ target_url: "https://u:p@example.test" }), CONTROL_ORIGIN), { name: "SecurityError" });
  await assert.rejects(sealShare(record({ target_url: "ftp://example.test" }), CONTROL_ORIGIN), { name: "SecurityError" });
  await assert.rejects(sealShare(record({ relay_profile_digest: new Uint8Array(31) }), CONTROL_ORIGIN), { name: "DataError" });
  await assert.rejects(sealShare(record({ flags: 1 }), CONTROL_ORIGIN), { name: "DataError" });
  await assert.rejects(openShare(expired, "https://other.test", 1500), { name: "SecurityError" });
  await assert.rejects(openShare(expired, "http://control.test", 1500), { name: "SecurityError" });
});

test("share URL grammar rejects query padding duplicate and extra fragment fields", async () => {
  const path = await sealShare(record(), CONTROL_ORIGIN);
  const parsed = new URL(path, CONTROL_ORIGIN);
  const key = parsed.hash.slice(3);
  for (const invalid of [
    `${parsed.href}&k=${key}`,
    `${parsed.href}&extra=1`,
    `${parsed.origin}${parsed.pathname}?extra=1${parsed.hash}`,
    `${parsed.origin}${parsed.pathname}=${parsed.hash}`,
    `${parsed.origin}${parsed.pathname}/extra${parsed.hash}`,
  ]) {
    await assert.rejects(openShare(invalid, CONTROL_ORIGIN, 1500), { name: "SecurityError" });
  }
});

test("share rejects duplicate and noncanonical CBOR plus invalid UTF-8", async () => {
  const path = await sealShare(record(), CONTROL_ORIGIN);
  const fixture = await decryptFixture(path);
  assert.equal(fixture.plaintext[0], 0xa7);

  const firstKeyEnd = cborItemEnd(fixture.plaintext, 1);
  const firstPairEnd = cborItemEnd(fixture.plaintext, firstKeyEnd);
  const duplicateMap = concat(
    Uint8Array.of(0xa8),
    fixture.plaintext.slice(1),
    fixture.plaintext.slice(1, firstPairEnd),
  );
  await assert.rejects(openShare(await resealFixture(fixture, duplicateMap), CONTROL_ORIGIN, 1500), { name: "DataError" });

  const flagsKey = concat(Uint8Array.of(0x65), new TextEncoder().encode("flags"), Uint8Array.of(0));
  const flagsOffset = findBytes(fixture.plaintext, flagsKey);
  const noncanonicalInteger = concat(
    fixture.plaintext.slice(0, flagsOffset + flagsKey.length - 1),
    Uint8Array.of(0x18, 0),
    fixture.plaintext.slice(flagsOffset + flagsKey.length),
  );
  await assert.rejects(openShare(await resealFixture(fixture, noncanonicalInteger), CONTROL_ORIGIN, 1500), { name: "DataError" });

  const targetKey = concat(Uint8Array.of(0x6a), new TextEncoder().encode("target_url"));
  const targetOffset = findBytes(fixture.plaintext, targetKey) + targetKey.length;
  const invalidUTF8 = fixture.plaintext.slice();
  const [, targetBody] = readCBORLength(invalidUTF8, targetOffset + 1, invalidUTF8[targetOffset] & 31);
  invalidUTF8[targetBody] = 0xff;
  await assert.rejects(openShare(await resealFixture(fixture, invalidUTF8), CONTROL_ORIGIN, 1500), { name: "DataError" });
});
