import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { moduleDirectory, readJson, sha256, validateJsonSchema } from "./gates/common.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(moduleDirectory(import.meta.url), "..");
const baselinePath = path.join(root, "protocol/v1-baseline.json");
const schemaPath = path.join(root, "protocol/v1-baseline.schema.json");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function merkleRoot(entries) {
  let level = entries
    .toSorted((left, right) => left.path.localeCompare(right.path))
    .map((entry) => createHash("sha256").update(`${entry.path}\0${entry.size}\0${entry.sha256}`).digest());
  invariant(level.length > 0, "V1 raw evidence manifest has no entries");
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level.at(-1));
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(createHash("sha256").update(Buffer.concat([level[index], level[index + 1]])).digest());
    }
    level = next;
  }
  return level[0].toString("hex");
}

async function gitBytes(args) {
  const { stdout } = await execFileAsync("git", args, { cwd: root, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function verifyEntry(entry, baseline) {
  invariant(typeof entry.source_uri === "string" && entry.source_uri.length > 0, `missing source_uri for ${entry.path}`);
  invariant(typeof entry.verify_command === "string" && entry.verify_command.length > 0, `missing verify_command for ${entry.path}`);
  let bytes;
  if (entry.source_uri.startsWith("git-archive://")) {
    const suffix = entry.source_uri.slice("git-archive://".length);
    const separator = suffix.indexOf("/");
    const commit = suffix.slice(0, separator);
    const member = suffix.slice(separator + 1);
    invariant(commit === baseline.source_commit.commit, `wrong source commit for ${entry.path}`);
    bytes = member.length === 0
      ? await gitBytes(["archive", "--format=tar", commit])
      : await gitBytes(["show", `${commit}:${member}`]);
  } else {
    const chromium = baseline.browser_evidence.find((entry) => entry.family === "chromium" && entry.status === "captured");
    invariant(chromium && entry.sha256 === chromium.binary_sha256, `unrecognized external evidence entry ${entry.path}`);
    bytes = await readFile(path.join(root, chromium.binary_path));
  }
  invariant(bytes.byteLength === entry.size, `size mismatch for ${entry.path}: ${bytes.byteLength} != ${entry.size}`);
  invariant(sha256(bytes) === entry.sha256, `digest mismatch for ${entry.path}`);
}

const [baselineRecord, baselineSchema] = await Promise.all([readJson(baselinePath), readJson(schemaPath)]);
const schemaResult = validateJsonSchema(baselineRecord.value, baselineSchema.value);
invariant(schemaResult.valid, `V1 baseline schema validation failed: ${schemaResult.errors.join("; ")}`);
const baseline = baselineRecord.value;
invariant(baseline.product_source_exclusion === true, "V1 source exclusion must be explicit");

const objectType = (await gitBytes(["cat-file", "-t", baseline.source_commit.commit])).toString("utf8").trim();
invariant(objectType === "commit", "frozen V1 object is not a commit");
const tree = (await gitBytes(["rev-parse", `${baseline.source_commit.commit}^{tree}`])).toString("utf8").trim();
invariant(tree === baseline.source_commit.tree, "frozen V1 tree digest mismatch");

const manifestPath = path.join(root, baseline.evidence_merkle.manifest_path);
const rawManifest = (await readJson(manifestPath)).value;
invariant(rawManifest.source_commit === baseline.source_commit.commit, "raw evidence manifest commit mismatch");
invariant(rawManifest.merkle_algorithm === baseline.evidence_merkle.algorithm, "raw evidence Merkle algorithm mismatch");
invariant(rawManifest.leaf_format === baseline.evidence_merkle.leaf_format, "raw evidence leaf format mismatch");
const rootDigest = merkleRoot(rawManifest.entries);
invariant(rootDigest === rawManifest.merkle_root && rootDigest === baseline.evidence_merkle.root, "raw evidence Merkle root mismatch");
for (const entry of rawManifest.entries) await verifyEntry(entry, baseline);

console.log(JSON.stringify({
  schema_valid: true,
  source_commit: baseline.source_commit.commit,
  source_tree: tree,
  evidence_entries: rawManifest.entries.length,
  evidence_merkle_root: rootDigest,
  corpus_sites: baseline.corpus.site_count,
  production_eligible: baseline.production_eligible,
}));
