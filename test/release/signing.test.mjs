import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = new URL("../../", import.meta.url);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("Go RFC 8785 ceremony emits a deterministic cross-language digest and remains non-production before signatures", async () => {
  const output = await mkdtemp(join(tmpdir(), "zeroproxy-signing-"));
  const canonicalPath = join(output, "migration.canonical.json");
  const requestPath = join(output, "migration.signing-request.json");
  const arguments_ = [
    "run", "./cmd/zeroproxy-release", "prepare",
    "-document", "protocol/v1-migration-disposition.json",
    "-schema", "protocol/v1-migration-disposition.schema.json",
    "-keys", "protocol/release-signing-keys.json",
    "-protocol-dir", "protocol",
    "-canonical-out", canonicalPath,
    "-request-out", requestPath,
    "-at", "2026-07-16T00:00:00Z",
  ];
  const first = await execute("go", arguments_, { cwd: root, env: { ...process.env, GOTOOLCHAIN: "go1.26.3" } });
  const canonical = await readFile(canonicalPath);
  const requestBytes = await readFile(requestPath);
  const request = JSON.parse(requestBytes);
  assert.deepEqual(JSON.parse(canonical), JSON.parse(await readFile(new URL("protocol/v1-migration-disposition.json", root), "utf8")));
  assert.equal(request.canonical_sha256, sha256(canonical));
  assert.equal(request.production_eligible, false);
  assert.equal(request.threshold, 2);
  assert.deepEqual(request.required_roles, ["security"]);
  assert.match(first.stdout, /"production_eligible":false/);

  const second = await execute("go", arguments_, { cwd: root, env: { ...process.env, GOTOOLCHAIN: "go1.26.3" } });
  assert.equal(second.stderr, "");
  assert.deepEqual(await readFile(canonicalPath), canonical);
  assert.deepEqual(await readFile(requestPath), requestBytes);
});
