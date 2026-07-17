import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  RUNTIME_CLASSIC_SOURCE_SHA256,
  runtimeClassicSource,
} from "../../web/runtime/index.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const RESPONSIBILITIES = Object.freeze([
  "capture",
  "transaction",
  "abi",
  "dynamic-code",
  "metadata",
  "dom",
  "cssom",
  "scripts",
  "navigation",
  "realms",
  "messaging",
  "storage",
  "cookies",
  "network",
  "stealth",
]);

function digest(source) {
  return createHash("sha256").update(source).digest("hex");
}

test("runtime responsibilities assemble the frozen parser-blocking classic source", async () => {
  const sections = [];
  for (const responsibility of RESPONSIBILITIES) {
    const file = path.join(ROOT, "web/runtime", `${responsibility}.mjs`);
    const module = await import(pathToFileURL(file));
    assert.ok(module.runtimeSections.length > 0, `${responsibility} owns at least one source section`);
    for (const section of module.runtimeSections) {
      assert.equal(path.basename(new URL(section.file).pathname), `${responsibility}.mjs`);
      sections.push(section);
    }
  }

  sections.sort((left, right) => left.order - right.order);
  assert.deepEqual(sections.map(section => section.order), Array.from({ length: 38 }, (_, index) => index));
  assert.deepEqual(sections.map(section => section.phase), [
    "emergency",
    ...Array(3).fill("outer"),
    ...Array(34).fill("inner"),
  ]);

  const source = runtimeClassicSource();
  assert.equal(digest(source), RUNTIME_CLASSIC_SOURCE_SHA256);
  assert.match(source, /^"use strict";\n\{\n/u);
  assert.match(source, /\}catch\(error\)\{failInstall\(error\)\}\n\}catch\(error\)\{emergencyBlock\(error\)\}\n\}\n$/u);
  await assert.rejects(
    readFile(path.join(ROOT, "web/runtime/prelude-classic.js")),
    error => error?.code === "ENOENT",
  );
});

test("runtime node policy state has one exact opaque metadata record", async () => {
  const [metadata, dom, scripts] = await Promise.all(
    ["metadata.mjs", "dom.mjs", "scripts.mjs"].map(file =>
      readFile(path.join(ROOT, "web/runtime", file), "utf8"),
    ),
  );
  assert.match(metadata, /const nodeMetadata=new PrivateWeakMap\(\)/u);
  assert.match(
    metadata,
    /record\.visible_attributes=visibleAttributes;\s*record\.internal_route_values=new PrivateMap\(\);\s*record\.source_kind=null;\s*record\.script_state=null;\s*record\.original_nonce=null;\s*record\.original_integrity=null;\s*record\.target_srcdoc=null;\s*record\.policy_revision=runtimePolicyContext\.policy_version;\s*record\.generation=0;\s*record\.abort_controller=null;/u,
  );
  const retiredStores = [
    "prevalidatedMetadata",
    "dynamicAttributeOperations",
    "trustedExecutableNodes=new PrivateWeakSet",
    "activatedScripts=new PrivateWeakSet",
    "inertScripts=new PrivateWeakSet",
    "scriptSourceMetadata=new PrivateWeakMap",
    "detachedScriptText=new PrivateWeakMap",
    "elementMetadata=new PrivateWeakMap",
    "baseMetadata=new PrivateWeakMap",
  ];
  for (const retired of retiredStores) {
    assert.equal(
      `${metadata}\n${dom}\n${scripts}`.includes(retired),
      false,
      `retired node metadata store remains: ${retired}`,
    );
  }
});

test("script activation uses the exact ledger and native insertion lifecycle", async () => {
  const [metadata, scripts, abi] = await Promise.all(
    ["metadata.mjs", "scripts.mjs", "abi.mjs"].map(file =>
      readFile(path.join(ROOT, "web/runtime", file), "utf8"),
    ),
  );
  assert.match(
    metadata,
    /case"INERT":case"PREPARED":case"FETCHING":case"COMPILING_INLINE":case"COMPILED":case"ACTIVATING":case"EXECUTED":case"BLOCKED":case"FAILED":case"REMOVED":case"CANCELED":return true/u,
  );
  for (const field of [
    "context",
    "parser_inserted",
    "already_started",
    "listeners_installed",
    "route_pending",
    "activation_id",
  ]) {
    assert.match(metadata, new RegExp(`ledger\\.${field}=`));
  }
  assert.match(scripts, /reflectApply\(native,receiver,args\)/u);
  assert.match(scripts, /finally\{settleExecutableInsertion\(scripts,succeeded\)\}/u);
  for (const retired of [
    "activateDynamicScript",
    "executeExecutableSubtree",
    "executeScriptSubtree",
    "executeEveryScript",
  ]) {
    assert.equal(
      `${metadata}\n${scripts}\n${abi}`.includes(retired),
      false,
      `retired manual script activation remains: ${retired}`,
    );
  }
});
