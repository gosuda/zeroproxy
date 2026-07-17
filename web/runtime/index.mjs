import { readFileSync } from "node:fs";
import { runtimeSections as abiSections } from "./abi.mjs";
import { runtimeSections as captureSections } from "./capture.mjs";
import { runtimeSections as cookiesSections } from "./cookies.mjs";
import { runtimeSections as cssomSections } from "./cssom.mjs";
import { runtimeSections as domSections } from "./dom.mjs";
import { runtimeSections as dynamicCodeSections } from "./dynamic-code.mjs";
import { runtimeSections as messagingSections } from "./messaging.mjs";
import { runtimeSections as metadataSections } from "./metadata.mjs";
import { runtimeSections as navigationSections } from "./navigation.mjs";
import { runtimeSections as networkSections } from "./network.mjs";
import { runtimeSections as realmsSections } from "./realms.mjs";
import { runtimeSections as scriptsSections } from "./scripts.mjs";
import { runtimeSections as stealthSections } from "./stealth.mjs";
import { runtimeSections as storageSections } from "./storage.mjs";
import { runtimeSections as transactionSections } from "./transaction.mjs";

const SOURCE_START = "/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/\n";
const SOURCE_END = "/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/";
const HEADER = "\"use strict\";\n{\n";
const TRY = "try{\n";
const TRAILER = "}catch(error){failInstall(error)}\n}catch(error){emergencyBlock(error)}\n}\n";
const SECTION_COUNT = 38;

const sections = Object.freeze([
  ...captureSections,
  ...transactionSections,
  ...abiSections,
  ...dynamicCodeSections,
  ...metadataSections,
  ...domSections,
  ...cssomSections,
  ...scriptsSections,
  ...navigationSections,
  ...realmsSections,
  ...messagingSections,
  ...storageSections,
  ...cookiesSections,
  ...networkSections,
  ...stealthSections,
].sort((left, right) => left.order - right.order));

const moduleSources = new Map();
function sectionSource(section) {
  let moduleSource = moduleSources.get(section.file);
  if (moduleSource === undefined) {
    moduleSource = readFileSync(new URL(section.file), "utf8");
    moduleSources.set(section.file, moduleSource);
  }
  const declaration = `export function ${section.name}() {`;
  const declarationStart = moduleSource.indexOf(declaration);
  const start = moduleSource.indexOf(SOURCE_START, declarationStart + declaration.length);
  const end = moduleSource.indexOf(SOURCE_END, start + SOURCE_START.length);
  if (declarationStart < 0 || start < 0 || end < start) throw new Error(`runtime section ${section.order} markers are invalid`);
  return moduleSource.slice(start + SOURCE_START.length, end);
}

function phaseSource(phase) {
  return sections
    .filter(section => section.phase === phase)
    .map(sectionSource)
    .join("");
}

function validateSections() {
  if (sections.length !== SECTION_COUNT) throw new Error("runtime section count mismatch");
  for (let order = 0; order < sections.length; order += 1) {
    const section = sections[order];
    const expectedPhase = order === 0 ? "emergency" : order < 4 ? "outer" : "inner";
    if (section.order !== order || section.phase !== expectedPhase || typeof section.file !== "string" || typeof section.name !== "string") {
      throw new Error(`runtime section ${order} is invalid`);
    }
  }
}

export const RUNTIME_CLASSIC_SOURCE_SHA256 = "eed0c55713b0115c00833756988821512b66c0e844bf3396f4198ead91a76e14";

export function runtimeClassicSource() {
  validateSections();
  return `${HEADER}${phaseSource("emergency")}${TRY}${phaseSource("outer")}${TRY}${phaseSource("inner")}${TRAILER}`;
}
