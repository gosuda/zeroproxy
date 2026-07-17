import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  GateFailure,
  canonicalJson,
  canonicalDigest,
  invariant,
  moduleDirectory,
  parseArgs,
  readJson,
  sha256,
  validateJsonSchema,
} from "./gates/common.mjs";
import { snapshotFixtureTree } from "./gates/fixture-snapshot.mjs";

function validDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export async function publishFrameworkFixtures({ inventory, inventorySha256, fixtureRoot, outputRoot }) {
  invariant(inventory?.schema_version === 1 && Array.isArray(inventory.fixtures), "framework fixture inventory is invalid", "manifest_invalid");
  invariant(validDigest(inventorySha256) && inventorySha256 === canonicalDigest(inventory), "framework fixture inventory digest is invalid or does not match its canonical content", "manifest_invalid");
  invariant(typeof fixtureRoot === "string" && typeof outputRoot === "string", "fixture and publication roots are required", "invalid_cli");
  const destination = path.resolve(outputRoot, inventorySha256);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const deploymentAssets = [];
  for (const fixture of inventory.fixtures) {
    const id = `fixture-${fixture.category}`;
    const snapshot = await snapshotFixtureTree({
      fixtureRoot,
      fixturePath: fixture.path,
      entryPath: fixture.entry_path,
      expectedSha256: fixture.tree_sha256,
      label: `published framework fixture ${fixture.category}`,
    });
    for (const [relativePath, asset] of snapshot.assets) {
      const assetPath = path.join(destination, "fixture", id, relativePath);
      await mkdir(path.dirname(assetPath), { recursive: true });
      await writeFile(assetPath, asset.bytes);
      deploymentAssets.push({ path: path.posix.join("fixture", id, relativePath), sha256: sha256(asset.bytes), content_type: asset.content_type });
    }
  }
  await writeFile(path.join(destination, "inventory.json"), canonicalJson(inventory));
  const deploymentManifest = { schema_version: 1, inventory_sha256: inventorySha256, assets: deploymentAssets };
  await writeFile(path.join(destination, "deployment-manifest.json"), canonicalJson(deploymentManifest));
  return Object.freeze({
    inventory_sha256: inventorySha256,
    destination,
    asset_count: deploymentAssets.length,
    deployment_manifest_sha256: canonicalDigest(deploymentManifest),
    url_layout: `<https-fixture-root>/${inventorySha256}/fixture/<site-id>/<asset-path>`,
  });
}

function help() {
  return [
    "Usage: node scripts/publish-framework-fixtures.mjs --output-root <directory> [options]",
    "",
    "Writes <output-root>/<inventory-sha>/fixture/fixture-<category>/<asset> for upload to an immutable HTTPS origin.",
    "Upload using deployment-manifest.json MIME values and Cache-Control: public,max-age=31536000,immutable.",
    "The production corpus gate re-fetches every asset before and after mediated execution and requires exact MIME, cache policy, and byte identity.",
    "Options:",
    "  --framework-inventory <path>  Inventory (default: test/frameworks/manifest.json)",
    "  --fixture-root <path>         Fixture root (default: test/frameworks)",
    "  --schema <path>               Inventory schema (default: protocol/framework-fixtures.schema.json)",
    "  --help                        Show this help",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ["help"],
    values: ["output-root", "framework-inventory", "fixture-root", "schema"],
  });
  invariant(args._.length === 0, "unexpected positional arguments", "invalid_cli");
  if (args.help) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  invariant(typeof args["output-root"] === "string" && args["output-root"].length > 0, "--output-root is required", "invalid_cli");
  const base = moduleDirectory(import.meta.url);
  const inventory = await readJson(args["framework-inventory"] ?? path.resolve(base, "../test/frameworks/manifest.json"));
  const schema = await readJson(args.schema ?? path.resolve(base, "../protocol/framework-fixtures.schema.json"));
  const validation = validateJsonSchema(inventory.value, schema.value);
  invariant(validation.valid, `framework fixture inventory schema validation failed: ${validation.errors.join("; ")}`, "manifest_invalid");
  const result = await publishFrameworkFixtures({
    inventory: inventory.value,
    inventorySha256: inventory.sha256,
    fixtureRoot: args["fixture-root"] ?? path.resolve(base, "../test/frameworks"),
    outputRoot: args["output-root"],
  });
  process.stdout.write(canonicalJson(result));
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch(error => {
    const message = error instanceof GateFailure ? error.message : error.stack || error.message;
    process.stderr.write(`framework fixture publication failed: ${message}\n`);
    process.exitCode = 1;
  });
}
