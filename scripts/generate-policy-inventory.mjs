import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "protocol/policy-inventory.sources.json");
const rustPath = resolve(root, "crates/policy-core/src/generated_inventory.rs");
const jsPath = resolve(root, "web/generated/policy-inventory.mjs");
const check = process.argv.slice(2).join(" ") === "--check";
const source = JSON.parse(await readFile(sourcePath, "utf8"));
const kinds = new Set(["Document", "Script", "Module", "Style", "Image", "Font", "Media", "Frame", "Worker", "Manifest", "Download"]);
const parsings = new Set(["single-url", "srcset", "refresh", "style", "srcdoc", "event-handler", "rel-token-dependent"]);
const dispositions = new Set(["virtual-base", "controlled-navigation", "controlled-fetch", "controlled-executable", "remove-hint", "recursive-document", "compile-event-handler", "block"]);
if (source.schema_version !== 1 || source.policy_version !== 2 || !Array.isArray(source.entries)) throw new Error("invalid policy inventory header");
const seen = new Set();
for (const entry of source.entries) {
  if (!entry || typeof entry !== "object") throw new Error("invalid inventory entry");
  for (const key of ["namespace", "element", "attribute", "parsing", "disposition"]) if (typeof entry[key] !== "string" || entry[key] === "") throw new Error(`missing ${key}`);
  if (!["html", "svg", "mathml"].includes(entry.namespace) || !parsings.has(entry.parsing) || !dispositions.has(entry.disposition)) throw new Error("invalid inventory behavior");
  if (entry.resource_kind !== undefined && !kinds.has(entry.resource_kind)) throw new Error("invalid resource kind");
  if (entry.type_essence !== undefined && (typeof entry.type_essence !== "string" || entry.type_essence === "")) throw new Error("invalid MIME essence");
  if (entry.rel && !["rel-token-dependent", "srcset"].includes(entry.parsing)) throw new Error("rel map requires rel-token-dependent or srcset parsing");
  if (entry.rel && (typeof entry.rel !== "object" || Array.isArray(entry.rel))) throw new Error("invalid rel map");
  for (const kind of Object.values(entry.rel ?? {})) if (kind !== null && !kinds.has(kind)) throw new Error("invalid rel resource kind");
  const key = `${entry.namespace}:${entry.element}:${entry.attribute}:${entry.parsing}:${entry.disposition}:${entry.type_essence ?? ""}:${Boolean(entry.rel)}`;
  if (seen.has(key)) throw new Error(`duplicate inventory entry ${key}`);
  seen.add(key);
}
const json = JSON.stringify(source.entries);
const rustString = value => JSON.stringify(value);
const resource = value => value ? `Some(ResourceKind::${value})` : "None";
const parsing = value => `InventoryParsing::${({"single-url":"SingleUrl",srcset:"Srcset",refresh:"Refresh",style:"Style",srcdoc:"Srcdoc","event-handler":"EventHandler","rel-token-dependent":"RelTokenDependent"})[value]}`;
const disposition = value => `InventoryDisposition::${({"virtual-base":"VirtualBase","controlled-navigation":"ControlledNavigation","controlled-fetch":"ControlledFetch","controlled-executable":"ControlledExecutable","remove-hint":"RemoveHint","recursive-document":"RecursiveDocument","compile-event-handler":"CompileEventHandler",block:"Block"})[value]}`;
const direct = source.entries.filter(entry => !entry.rel);
const rel = source.entries.filter(entry => entry.rel).sort((left, right) => Number(right.disposition === "remove-hint") - Number(left.disposition === "remove-hint"));
const emittedEntry = entry => `InventoryEntry { parsing: ${parsing(entry.parsing)}, disposition: ${disposition(entry.disposition)}, resource_kind: ${resource(entry.resource_kind)} }`;
const emittedDirect = direct.map(entry => {
  const element = entry.element === "*" ? "true" : `element == ${rustString(entry.element)}`;
  const attribute = entry.attribute === "on*" ? 'attribute.starts_with("on")' : `attribute == ${rustString(entry.attribute)}`;
  const httpEquiv = entry.http_equiv ? ` && http_equiv.is_some_and(|value| value.eq_ignore_ascii_case(${rustString(entry.http_equiv)}))` : "";
  const typeEssence = entry.type_essence ? ` && type_essence.is_some_and(|value| value.eq_ignore_ascii_case(${rustString(entry.type_essence)}))` : "";
  return `    if namespace == ${rustString(entry.namespace)} && ${element} && ${attribute}${httpEquiv}${typeEssence} { return Some(${emittedEntry(entry)}); }`;
}).join("\n");
const emittedRel = rel.map(entry => {
  const rels = Object.entries(entry.rel).map(([token, kind]) => `                if token.eq_ignore_ascii_case(${rustString(token)}) { selected = Some(InventoryEntry { parsing: ${parsing(entry.parsing)}, disposition: ${disposition(entry.disposition)}, resource_kind: ${resource(kind)} }); }`).join("\n");
  return `    if namespace == ${rustString(entry.namespace)} && element == ${rustString(entry.element)} && attribute == ${rustString(entry.attribute)} {\n        let mut selected = None;\n        for token in link_rel.unwrap_or_default().split_ascii_whitespace() {\n${rels}\n        }\n        if selected.is_some() { return selected; }\n    }`;
}).join("\n");
const rust = `// Generated by scripts/generate-policy-inventory.mjs. DO NOT EDIT.\n\npub fn html_inventory_entry(\n    namespace: &str,\n    element: &str,\n    attribute: &str,\n    link_rel: Option<&str>,\n    http_equiv: Option<&str>,\n    type_essence: Option<&str>,\n) -> Option<InventoryEntry> {\n${emittedRel}\n${emittedDirect}\n    None\n}\n`;
const js = `// Generated by scripts/generate-policy-inventory.mjs. DO NOT EDIT.\nexport const INVENTORY_POLICY_VERSION = ${source.policy_version};\nexport const NETWORK_INVENTORY = Object.freeze(${json}.map(Object.freeze));\nfunction matches(entry, namespace, element, attribute, type, httpEquiv) {\n  return entry.namespace === namespace && (entry.element === "*" || entry.element === element) && (entry.attribute === "on*" ? attribute.startsWith("on") : entry.attribute === attribute) && (!entry.type_essence || entry.type_essence === type) && (!entry.http_equiv || entry.http_equiv === httpEquiv);\n}\nexport function inventoryEntry(namespace, element, attribute, rel = "", typeEssence = "", httpEquiv = "") {\n  const normalized = String(rel).toLowerCase().trim().split(/\\s+/);\n  const type = String(typeEssence).split(";")[0].trim().toLowerCase();\n  const equiv = String(httpEquiv).trim().toLowerCase();\n  const relEntries = NETWORK_INVENTORY.filter(entry => entry.rel && matches(entry, namespace, element, attribute, type, equiv)).sort((left, right) => Number(right.disposition === "remove-hint") - Number(left.disposition === "remove-hint"));\n  for (const entry of relEntries) {\n    let selected;\n    for (const token of normalized) if (Object.hasOwn(entry.rel, token)) selected = entry.rel[token];\n    if (selected !== undefined) return Object.freeze({ ...entry, resource_kind: selected });\n  }\n  return NETWORK_INVENTORY.find(entry => !entry.rel && matches(entry, namespace, element, attribute, type, equiv)) ?? null;\n}\n`;
async function sync(path, content) {
  let current = null;
  try { current = await readFile(path, "utf8"); } catch {}
  if (current === content) return;
  if (check) throw new Error(`generated inventory is stale: ${path}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
await sync(rustPath, rust);
await sync(jsPath, js);
