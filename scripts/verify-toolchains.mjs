import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { canonicalDigest, collectBuildIdentity, moduleDirectory, readJson, sha256, validateJsonSchema } from "./gates/common.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(moduleDirectory(import.meta.url), "..");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function resolvedPath(value) {
  return path.isAbsolute(value) ? value : path.join(root, value);
}

async function fileDigest(value) {
  return sha256(await readFile(resolvedPath(value)));
}

const manifest = await readJson(path.join(root, "protocol/toolchains.json"));
const schema = await readJson(path.join(root, "protocol/toolchains.schema.json"));
const validation = validateJsonSchema(manifest.value, schema.value);
invariant(validation.valid, `toolchain manifest schema validation failed: ${validation.errors.join("; ")}`);
invariant(manifest.value.platform.os === `${process.platform}-${os.release()}`, "toolchain host OS mismatch");
invariant(manifest.value.platform.arch === process.arch, "toolchain host architecture mismatch");

const requiredTools = new Map([
  ["node", "24.4.1"],
  ["npm", "11.4.2"],
  ["go", "1.26.3"],
  ["rust", "1.96.0"],
  ["wasm-bindgen-cli", "0.2.122"],
  ["binaryen", "129"],
  ["tor", "0.4.9.11"],
  ["tcpdump", "4.99.1 Apple 148 / libpcap 1.10.1"],
  ["biome", "2.5.3"],
  ["esbuild", "0.28.1"],
  ["golangci-lint", "2.12.2"],
]);
const tools = new Map();
for (const tool of manifest.value.tools) {
  invariant(!tools.has(tool.name), `duplicate toolchain entry ${tool.name}`);
  tools.set(tool.name, tool);
  invariant(await fileDigest(tool.path) === tool.sha256, `${tool.name} executable digest mismatch`);
  const { stdout, stderr } = await execFileAsync(resolvedPath(tool.path), tool.version_args, { cwd: root, encoding: "utf8", timeout: 30_000 });
  invariant(new RegExp(tool.version_pattern, "u").test(`${stdout}${stderr}`), `${tool.name} version output mismatch`);
}
for (const [name, version] of requiredTools) invariant(tools.get(name)?.version === version, `missing exact ${name} ${version}`);
invariant(tools.size === requiredTools.size, "undeclared toolchain executable present in manifest");

const target = manifest.value.rust_targets[0];
invariant(manifest.value.rust_targets.length === 1, "exactly one Rust target declaration is required");
const targetIdentity = await collectBuildIdentity(resolvedPath(target.path));
invariant(targetIdentity.tree_sha256 === target.tree_sha256, `${target.triple} target tree digest mismatch`);

const cargoLock = await readFile(path.join(root, "Cargo.lock"), "utf8");
const cargoPackages = new Map();
for (const block of cargoLock.split("[[package]]").slice(1)) {
  const name = /^\s*name = "([^"]+)"/mu.exec(block)?.[1];
  const version = /^\s*version = "([^"]+)"/mu.exec(block)?.[1];
  const packageSha256 = /^\s*checksum = "([a-f0-9]{64})"/mu.exec(block)?.[1];
  if (name && version && packageSha256) cargoPackages.set(`${name}@${version}`, packageSha256);
}
const libraryNames = new Set();
for (const library of manifest.value.rust_libraries) {
  invariant(!libraryNames.has(library.name), `duplicate Rust library ${library.name}`);
  libraryNames.add(library.name);
  invariant(cargoPackages.get(`${library.name}@${library.version}`) === library.package_sha256, `${library.name} package checksum mismatch`);
}
for (const name of ["wasm-bindgen", "wasm-bindgen-macro", "wasm-bindgen-macro-support", "wasm-bindgen-shared"])
  invariant(libraryNames.has(name), `missing exact Rust library ${name}`);

const boundaries = await readJson(path.join(root, "protocol/browser-boundaries.json"));
const boundaryByFamily = new Map(boundaries.value.browser_lanes.map(lane => [lane.family, lane]));
const browserFamilies = new Set();
for (const browser of manifest.value.browsers) {
  invariant(!browserFamilies.has(browser.family), `duplicate browser ${browser.family}`);
  browserFamilies.add(browser.family);
  const boundary = boundaryByFamily.get(browser.family);
  invariant(boundary, `browser boundary missing ${browser.family}`);
  for (const field of ["exact_build", "product_build_id", "platform", "archive_url", "archive_sha256", "binary_path", "binary_sha256"])
    invariant(browser[field] === boundary[field], `${browser.family} ${field} differs from browser boundary`);
  invariant(await fileDigest(browser.binary_path) === browser.binary_sha256, `${browser.family} binary digest mismatch`);
}
invariant(browserFamilies.size === 2 && browserFamilies.has("chromium") && browserFamilies.has("firefox"), "both desktop browser toolchains are required");

const lockNames = new Set();
for (const lock of manifest.value.dependency_locks) {
  invariant(!lockNames.has(lock.name), `duplicate dependency lock ${lock.name}`);
  lockNames.add(lock.name);
  invariant(await fileDigest(lock.path) === lock.sha256, `${lock.name} dependency lock digest mismatch`);
}
for (const name of ["npm", "cargo", "go"]) invariant(lockNames.has(name), `missing ${name} dependency lock`);

process.stdout.write(`${JSON.stringify({
  schema_valid: true,
  release_id: manifest.value.release_id,
  toolchains_sha256: canonicalDigest(manifest.value),
  tools: [...tools].map(([name, tool]) => ({ name, version: tool.version, sha256: tool.sha256 })),
  rust_target: { triple: target.triple, tree_sha256: target.tree_sha256 },
  browsers: manifest.value.browsers.map(({ family, exact_build, binary_sha256 }) => ({ family, exact_build, binary_sha256 })),
  dependency_locks: manifest.value.dependency_locks,
})}\n`);
