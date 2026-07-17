import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  GateFailure,
  canonicalJson,
  invariant,
  moduleDirectory,
  parseArgs,
  readJson,
  validateJsonSchema,
} from "./gates/common.mjs";

const CATEGORY_SITE_CLASS = Object.freeze({
  react: "application",
  vue: "application",
  "angular-zone": "application",
  "vite-next-esm": "application",
  webpack: "application",
  jquery: "content",
  pwa: "editor_media_pwa",
  frame: "content",
  media: "editor_media_pwa",
  editor: "editor_media_pwa",
  upload: "editor_media_pwa",
  download: "editor_media_pwa",
  article: "content",
  "styled-document": "content",
  gallery: "content",
  "canvas-app": "editor_media_pwa",
  "interactive-list": "editor_media_pwa",
  "toggle-control": "editor_media_pwa",
  "tab-control": "editor_media_pwa",
});

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function validHttpUrl(value) {
  if (!nonEmptyString(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function validateProbeList(probes, label) {
  invariant(Array.isArray(probes) && probes.length > 0, `${label} must enumerate probes`, "manifest_invalid");
  const ids = new Set();
  for (const probe of probes) {
    invariant(probe && nonEmptyString(probe.id) && nonEmptyString(probe.expression) && !ids.has(probe.id), `${label} probes are invalid or duplicated`, "manifest_invalid");
    ids.add(probe.id);
  }
}

function liveCanarySite(site, siteClasses) {
  invariant(site && typeof site === "object" && !Array.isArray(site), "live canary must be an object", "manifest_invalid");
  invariant(nonEmptyString(site.id) && /^[A-Za-z0-9_.-]+$/u.test(site.id), "live canary id is invalid", "manifest_invalid");
  invariant(nonEmptyString(site.url) && validHttpUrl(site.native_url) && validHttpUrl(site.mediated_url), `live canary ${site.id} URLs are invalid`, "manifest_invalid");
  invariant(Object.hasOwn(siteClasses, site.site_class), `live canary ${site.id} site_class is invalid`, "manifest_invalid");
  validateProbeList(site.actions, `live canary ${site.id} actions`);
  validateProbeList(site.compatibility_probes, `live canary ${site.id} compatibility`);
  validateProbeList(site.stealth_probes, `live canary ${site.id} stealth`);
  return {
    id: site.id,
    url: site.url,
    kind: "live-canary",
    fixture_category: null,
    fixture_sha256: null,
    fixture_path: null,
    entry_path: null,
    mediated_url_template: null,
    site_class: site.site_class,
    native_url: site.native_url,
    mediated_url: site.mediated_url,
    actions: site.actions,
    compatibility_probes: site.compatibility_probes,
    stealth_probes: site.stealth_probes,
  };
}

function fixtureSite(fixture, mediatedUrlTemplate, siteClasses) {
  const siteClass = CATEGORY_SITE_CLASS[fixture.category];
  invariant(siteClass && Object.hasOwn(siteClasses, siteClass), `framework fixture ${fixture.category} has no configured site class`, "manifest_invalid");
  return {
    id: `fixture-${fixture.category}`,
    url: `offline:${fixture.category}`,
    kind: "offline-fixture",
    fixture_category: fixture.category,
    fixture_sha256: fixture.tree_sha256,
    fixture_path: fixture.path,
    entry_path: fixture.entry_path,
    mediated_url_template: mediatedUrlTemplate,
    site_class: siteClass,
    native_url: null,
    mediated_url: null,
    actions: [{ id: `fixture-action-${fixture.category}`, expression: fixture.action_expression }],
    compatibility_probes: [{ id: `fixture-ready-${fixture.category}`, expression: fixture.ready_expression }],
    stealth_probes: [
      { id: "navigator-shape", expression: "({userAgent:navigator.userAgent,languages:[...navigator.languages],platform:navigator.platform})" },
      { id: "dom-shape", expression: "({title:document.title,elements:document.querySelectorAll('*').length,scripts:document.scripts.length})" },
      { id: "api-shape", expression: "({fetch:typeof fetch,xhr:typeof XMLHttpRequest,eventSource:typeof EventSource,webSocket:typeof WebSocket,worker:typeof Worker})" },
      { id: "resource-timeline", expression: "performance.getEntriesByType('resource').map(entry=>({name:new URL(entry.name).pathname.split('/').at(-1),initiatorType:entry.initiatorType}))" },
    ],
  };
}

export function buildCorpusReleaseManifest({ config, inventory, mediatedUrlTemplate, oracleId, liveCanaries }) {
  invariant(config && typeof config.release_id === "string" && config.site_classes, "performance configuration is required", "manifest_invalid");
  invariant(inventory?.schema_version === 1 && Array.isArray(inventory.fixtures) && inventory.fixtures.length > 0, "framework fixture inventory is required", "manifest_invalid");
  invariant(nonEmptyString(mediatedUrlTemplate) && mediatedUrlTemplate.split("{fixture_url_encoded}").length === 2, "mediated URL template must contain exactly one fixture URL token", "manifest_invalid");
  invariant(validHttpUrl(mediatedUrlTemplate.replace("{fixture_url_encoded}", encodeURIComponent("https://fixture.invalid/index.html"))), "mediated URL template must produce an absolute HTTP(S) URL", "manifest_invalid");
  invariant(nonEmptyString(oracleId), "corpus oracle id is required", "manifest_invalid");
  invariant(Array.isArray(liveCanaries) && liveCanaries.length > 0, "at least one production live canary is required", "manifest_invalid");
  const sites = [
    ...inventory.fixtures.map(fixture => fixtureSite(fixture, mediatedUrlTemplate, config.site_classes)),
    ...liveCanaries.map(site => liveCanarySite(site, config.site_classes)),
  ];
  invariant(new Set(sites.map(site => site.id)).size === sites.length, "corpus site ids must be unique", "manifest_invalid");
  return { schema_version: 1, release_id: config.release_id, oracle_id: oracleId, sites };
}

function help() {
  return [
    "Usage: node scripts/generate-corpus-manifest.mjs --mediated-url-template <url> --oracle-id <id> --live-canaries <json> --output <json> [options]",
    "",
    "The live-canaries file is {\"sites\":[...]} with native/mediated URLs and explicit action, compatibility, and stealth probes.",
    "The mediated template must contain exactly one {fixture_url_encoded} token and must route through the release candidate.",
    "Options:",
    "  --config <path>               Performance configuration (default: protocol/performance-gates.json)",
    "  --framework-inventory <path>  Framework inventory (default: test/frameworks/manifest.json)",
    "  --schema <path>               Corpus schema (default: protocol/corpus-manifest.schema.json)",
    "  --help                        Show this help",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ["help"],
    values: ["config", "framework-inventory", "schema", "mediated-url-template", "oracle-id", "live-canaries", "output"],
  });
  invariant(args._.length === 0, "unexpected positional arguments", "invalid_cli");
  if (args.help) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  for (const name of ["mediated-url-template", "oracle-id", "live-canaries", "output"])
    invariant(nonEmptyString(args[name]), `--${name} is required`, "invalid_cli");
  const base = moduleDirectory(import.meta.url);
  const config = (await readJson(args.config ?? path.resolve(base, "../protocol/performance-gates.json"))).value;
  const inventory = (await readJson(args["framework-inventory"] ?? path.resolve(base, "../test/frameworks/manifest.json"))).value;
  const liveCanaries = (await readJson(args["live-canaries"])).value;
  invariant(liveCanaries && Object.keys(liveCanaries).length === 1 && Array.isArray(liveCanaries.sites), "live canary input must contain only a sites array", "manifest_invalid");
  const manifest = buildCorpusReleaseManifest({
    config,
    inventory,
    mediatedUrlTemplate: args["mediated-url-template"],
    oracleId: args["oracle-id"],
    liveCanaries: liveCanaries.sites,
  });
  const schema = await readJson(args.schema ?? path.resolve(base, "../protocol/corpus-manifest.schema.json"));
  const validation = validateJsonSchema(manifest, schema.value);
  invariant(validation.valid, `generated corpus manifest schema validation failed: ${validation.errors.join("; ")}`, "manifest_invalid");
  await writeFile(args.output, canonicalJson(manifest));
  process.stdout.write(canonicalJson({ output: path.resolve(args.output), site_count: manifest.sites.length }));
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch(error => {
    const message = error instanceof GateFailure ? error.message : error.stack || error.message;
    process.stderr.write(`corpus manifest generation failed: ${message}\n`);
    process.exitCode = 1;
  });
}
