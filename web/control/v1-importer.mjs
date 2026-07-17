const MAX_INPUT_BYTES = 16 * 1024;
export const V1_IMPORT_SUNSET = Date.parse("2026-10-09T00:00:00Z");

function decodeBase64URL(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > MAX_INPUT_BYTES) throw new DOMException("Invalid V1 link", "DataError");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

export function inspectV1Fragment(fragment, now = Date.now()) {
  const text = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  const params = new URLSearchParams(text);
  const encoded = params.get("v1");
  if (!encoded || params.size !== 1) throw new DOMException("Invalid V1 link", "DataError");
  const bytes = decodeBase64URL(encoded);
  let record;
  try { record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new DOMException("Invalid V1 link", "DataError"); }
  if (!record || record.v !== 1 || typeof record.url !== "string" || Object.keys(record).some(k => !["v", "url", "expires_at", "nonce"].includes(k))) throw new DOMException("Unsupported V1 link", "NotSupportedError");
  const target = new URL(record.url);
  if (!/^https?:$/.test(target.protocol) || target.username || target.password || record.url.length > 8192) throw new DOMException("Unsupported target URL", "SecurityError");
  if (record.expires_at != null && (!Number.isSafeInteger(record.expires_at) || record.expires_at <= now)) throw new DOMException("Expired V1 link", "InvalidStateError");
  if (typeof record.nonce !== "string" || record.nonce.length < 16) throw new DOMException("Invalid import nonce", "DataError");
  return Object.freeze({ targetURL: target.href, nonce: record.nonce });
}

export async function approveAndMint(inspected, approval, mint) {
  if (approval !== true) return Object.freeze({ approved: false });
  if (typeof mint !== "function") throw new TypeError("mint must be a function");
  const result = await mint({ targetURL: inspected.targetURL, importNonce: inspected.nonce });
  return Object.freeze({ approved: true, result });
}

export function createV1Importer({ now = Date.now, mint, nonceStore }) {
  if (typeof now !== "function" || typeof mint !== "function" || !nonceStore) throw new TypeError("invalid importer dependencies");
  for (const method of ["reserve", "commit", "release"]) {
    if (typeof nonceStore[method] !== "function") throw new TypeError(`nonceStore.${method} is required`);
  }
  return Object.freeze({
    inspect(fragment) {
      if (now() >= V1_IMPORT_SUNSET) throw new DOMException("V1 import has ended", "NotSupportedError");
      return inspectV1Fragment(fragment, now());
    },
    async approve(inspected, approved) {
      if (now() >= V1_IMPORT_SUNSET) throw new DOMException("V1 import has ended", "NotSupportedError");
      if (approved !== true) return Object.freeze({ approved: false });
      if (!await nonceStore.reserve(inspected.nonce)) throw new DOMException("Import nonce already used", "InvalidStateError");
      let committed = false;
      try {
        const result = await mint({ targetURL: inspected.targetURL, importNonce: inspected.nonce });
        await nonceStore.commit(inspected.nonce);
        committed = true;
        return Object.freeze({ approved: true, result });
      } finally {
        if (!committed) await nonceStore.release(inspected.nonce);
      }
    }
  });
}
