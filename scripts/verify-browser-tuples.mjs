import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { moduleDirectory, readJson, sha256, validateJsonSchema } from "./gates/common.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(moduleDirectory(import.meta.url), "..");
const support = await readJson(path.join(root, "protocol/support-matrix.json"));
const supportSchema = await readJson(path.join(root, "protocol/support-matrix.schema.json"));
const boundaries = await readJson(path.join(root, "protocol/browser-boundaries.json"));
const boundariesSchema = await readJson(path.join(root, "protocol/browser-boundaries.schema.json"));

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

for (const [name, record, schema] of [
  ["support matrix", support, supportSchema],
  ["browser boundaries", boundaries, boundariesSchema],
]) {
  const result = validateJsonSchema(record.value, schema.value);
  invariant(result.valid, `${name} schema validation failed: ${result.errors.join("; ")}`);
}

invariant(support.value.release_id === boundaries.value.release_id, "browser records use different releases");
invariant(support.value.deferred_browser_families.length === 0, "desktop browser lanes may not be deferred");
const boundaryByFamily = new Map(boundaries.value.browser_lanes.map((lane) => [lane.family, lane]));
for (const browser of support.value.browsers) {
  const boundary = boundaryByFamily.get(browser.family);
  invariant(boundary, `missing ${browser.family} browser boundary`);
  for (const field of ["channel", "exact_build", "product_build_id", "platform", "archive_url", "archive_sha256", "binary_path", "binary_sha256", "release_supported", "packet_capture_certified"]) {
    invariant(browser[field] === boundary[field], `${browser.family} ${field} differs across browser records`);
  }
  const binaryPath = path.join(root, browser.binary_path);
  const bytes = await readFile(binaryPath);
  invariant(sha256(bytes) === browser.binary_sha256, `${browser.family} binary digest mismatch`);
  const { stdout, stderr } = await execFileAsync(binaryPath, ["--version"], { cwd: root, encoding: "utf8" });
  invariant(`${stdout}${stderr}`.includes(browser.exact_build), `${browser.family} executable does not report ${browser.exact_build}`);
  const allProductGates = browser.native_oracle_passed
    && browser.runtime_gate_passed
    && browser.transport_gate_passed
    && browser.performance_gate_passed
    && browser.soak_gate_passed
    && browser.corpus_gate_passed
    && browser.packet_capture_certified;
  invariant(browser.release_supported === allProductGates, `${browser.family} release_supported is not derived from all required gates`);
}
invariant(boundaries.value.production_release_eligible === boundaries.value.browser_lanes.every((lane) => lane.release_supported && lane.packet_capture_certified), "production eligibility does not match browser lanes");

console.log(JSON.stringify({
  schema_valid: true,
  release_id: support.value.release_id,
  browsers: support.value.browsers.map(({ family, exact_build, product_build_id, binary_sha256, release_supported }) => ({ family, exact_build, product_build_id, binary_sha256, release_supported })),
  production_release_eligible: boundaries.value.production_release_eligible,
}));
