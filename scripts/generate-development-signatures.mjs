import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "./gates/common.mjs";

const root = path.resolve(import.meta.dirname, "..");
const keyPath = path.join(root, "protocol/release-signing-keys.json");
const signedDocuments = Object.freeze([
  ["protocol/address-policy.json", "protocol/address-policy.sig"],
  ["protocol/compatibility-deltas.json", "protocol/compatibility-deltas.sig"],
  ["protocol/v1-migration-disposition.json", "protocol/v1-migration-disposition.sig"],
  ["protocol/relay-profiles/e466728411805ea3c97c9ba046b0d88d6e0477c0683078c441854bce65801e24.json", "protocol/relay-profiles/e466728411805ea3c97c9ba046b0d88d6e0477c0683078c441854bce65801e24.sig"],
]);
const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");

function fixtureKey(id) {
  const seed = createHash("sha256").update(`zeroproxy-development-only-ed25519-fixture:${id}`).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([pkcs8Prefix, seed]), format: "der", type: "pkcs8" });
  const publicDER = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return {
    privateKey,
    publicKey: publicDER.subarray(-32).toString("base64url"),
  };
}

const keys = JSON.parse(await readFile(keyPath, "utf8"));
if (keys.development_only !== true || keys.threshold !== 2 || keys.keys.length !== 2) {
  throw new Error("development signature generation requires the checked two-key development-only trust set");
}
const material = new Map();
for (const key of keys.keys) {
  if (!key.owner.endsWith("-fixture")) throw new Error(`refusing non-fixture key ${key.id}`);
  const generated = fixtureKey(key.id);
  key.public_key = generated.publicKey;
  material.set(key.id, generated.privateKey);
}
await writeFile(keyPath, `${JSON.stringify(keys, null, 2)}\n`);

for (const [documentName, signatureName] of signedDocuments) {
  const document = JSON.parse(await readFile(path.join(root, documentName), "utf8"));
  const canonical = Buffer.from(canonicalJson(document).slice(0, -1));
  const signatures = {
    algorithm: "Ed25519",
    canonicalization: "RFC8785",
    key_epoch: keys.key_epoch,
    development_only: true,
    signatures: keys.keys.map(key => ({
      key_id: key.id,
      signature: sign(null, canonical, material.get(key.id)).toString("base64url"),
    })),
  };
  await writeFile(path.join(root, signatureName), `${JSON.stringify(signatures, null, 2)}\n`);
}
