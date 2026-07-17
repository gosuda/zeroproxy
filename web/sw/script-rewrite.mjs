import { decodeCompilerResult } from "../compiler-result.mjs";
import { isModuleWorkerSourceKind, WorkerSourceKind } from "../worker/source-kinds.mjs";

export { WorkerSourceKind };

export const ABI_TEMPLATE_IDENTIFIER = "__zp_abi_000000000000000000000000000000000000000000000000";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();


function safeSourceURL(value) {
  return String(value)
    .replaceAll("<", "%3C")
    .replaceAll(">", "%3E")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll("\u2028", "%E2%80%A8")
    .replaceAll("\u2029", "%E2%80%A9");
}

function assertRewriteContext(source, targetURL, abiIdentifier, sourceKind) {
  if (
    typeof source !== "string"
    || typeof targetURL !== "string"
    || typeof abiIdentifier !== "string"
    || typeof sourceKind !== "string"
  ) {
    throw new TypeError("Invalid executable rewrite context");
  }
}

function compile(source, sourceKind, abiIdentifier, compiler) {
  if (typeof compiler?.compile_json !== "function") {
    throw new TypeError("Compiler ABI unavailable");
  }
  let compiled;
  try {
    compiled = decodeCompilerResult(compiler.compile_json(source, sourceKind, abiIdentifier));
  } catch {
    throw new TypeError("Invalid compiler result");
  }
  if (compiled.ok !== true) {
    throw new TypeError(`Compiler rejected executable source: ${compiled.error.code}`);
  }
  return compiled;
}

function compileTemplate(source, sourceKind, compiler) {
  if (typeof compiler?.compile_template_json !== "function") {
    throw new TypeError("Compiler template ABI unavailable");
  }
  let compiled;
  try {
    compiled = decodeCompilerResult(compiler.compile_template_json(source, sourceKind));
  } catch {
    throw new TypeError("Invalid compiler result");
  }
  if (
    compiled.ok !== true
    || !Array.isArray(compiled.abi_identifiers)
    || !Array.isArray(compiled.abi_slots)
    || !compiled.abi_identifiers.every((identifier) => typeof identifier === "string")
  ) {
    if (compiled.ok === false) {
      throw new TypeError(`Compiler rejected executable source: ${compiled.error.code}`);
    }
    throw new TypeError("Invalid compiler result");
  }
  return compiled;
}


function byteOffsetToCodeUnit(value, byteOffset) {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new TypeError("Invalid compiler byte offset");
  }
  let bytes = 0;
  let codeUnits = 0;
  for (const codePoint of value) {
    if (bytes === byteOffset) return codeUnits;
    const scalar = codePoint.codePointAt(0);
    bytes += scalar <= 0x7f ? 1 : scalar <= 0x7ff ? 2 : scalar <= 0xffff ? 3 : 4;
    codeUnits += codePoint.length;
  }
  if (bytes === byteOffset) return codeUnits;
  throw new TypeError("Compiler byte offset exceeds rewritten source");
}

export function instantiateClassicTemplate(template, abiIdentifier) {
  if (typeof abiIdentifier !== "string") {
    throw new TypeError("Invalid classic-script template");
  }
  const abiBytes = textEncoder.encode(abiIdentifier);
  if (
    !template
    || typeof template.code !== "string"
    || !Array.isArray(template.abi_slots)
    || abiBytes.byteLength !== ABI_TEMPLATE_IDENTIFIER.length
  ) {
    throw new TypeError("Invalid classic-script template");
  }
  const code = textEncoder.encode(template.code);
  const slots = template.abi_slots
    .map((slot) => {
      if (
        !slot
        || !Number.isSafeInteger(slot.start)
        || !Number.isSafeInteger(slot.end)
        || slot.start < 0
        || slot.end > code.byteLength
        || slot.end - slot.start !== ABI_TEMPLATE_IDENTIFIER.length
      ) {
        throw new TypeError("Invalid classic-script template slot");
      }
      return slot;
    })
    .sort((left, right) => left.start - right.start);
  let previousEnd = 0;
  for (const slot of slots) {
    if (slot.start < previousEnd) {
      throw new TypeError("Invalid classic-script template slot");
    }
    for (let offset = 0; offset < ABI_TEMPLATE_IDENTIFIER.length; offset += 1) {
      if (code[slot.start + offset] !== ABI_TEMPLATE_IDENTIFIER.charCodeAt(offset)) {
        throw new TypeError("Invalid classic-script template slot");
      }
    }
    code.set(abiBytes, slot.start);
    previousEnd = slot.end;
  }
  return textDecoder.decode(code);
}

function assertModuleSpecifier(record, code) {
  if (
    !record
    || typeof record.specifier !== "string"
    || !Number.isSafeInteger(record.generated_start)
    || !Number.isSafeInteger(record.generated_end)
    || record.generated_start < 0
    || record.generated_end <= record.generated_start
  ) {
    throw new TypeError("Invalid module graph compiler result");
  }
  const start = byteOffsetToCodeUnit(code, record.generated_start);
  const end = byteOffsetToCodeUnit(code, record.generated_end);
  const literal = code.slice(start, end);
  if (
    literal.length < 2
    || (literal[0] !== "'" && literal[0] !== '"')
    || literal.at(-1) !== literal[0]
  ) {
    throw new TypeError("Invalid module graph compiler span");
  }
  return { ...record, start, end };
}

function requireModuleGraph(moduleGraph, targetURL, sourceKind) {
  if (
    typeof moduleGraph?.identity !== "function"
    || typeof moduleGraph?.rewrite !== "function"
  ) {
    throw new TypeError("Controlled module graph unavailable");
  }
  const graphIdentity = moduleGraph.identity(
    Object.freeze({ targetURL, sourceKind }),
  );
  if (typeof graphIdentity !== "string" || graphIdentity.length === 0) {
    throw new TypeError("Invalid controlled module graph identity");
  }
  return graphIdentity;
}

function rewriteModuleSpecifiers(compiled, targetURL, sourceKind, moduleGraph) {
  if (!Array.isArray(compiled.module_specifiers)) {
    throw new TypeError("Module compiler graph metadata unavailable");
  }
  const graphIdentity = requireModuleGraph(moduleGraph, targetURL, sourceKind);
  const specifiers = compiled.module_specifiers
    .map((record) => assertModuleSpecifier(record, compiled.code))
    .sort((left, right) => right.start - left.start);
  let output = compiled.code;
  let previousStart = output.length;
  for (const record of specifiers) {
    if (record.end > previousStart) {
      throw new TypeError("Overlapping module graph compiler spans");
    }
    const route = moduleGraph.rewrite(
      Object.freeze({
        graphIdentity,
        importerURL: targetURL,
        sourceKind,
        specifier: record.specifier,
      }),
    );
    if (
      !route
      || typeof route !== "object"
      || route.graphIdentity !== graphIdentity
      || route.controlled !== true
      || typeof route.url !== "string"
      || route.url.length === 0
    ) {
      throw new TypeError("Invalid controlled module route");
    }
    output = `${output.slice(0, record.start)}${JSON.stringify(route.url)}${output.slice(record.end)}`;
    previousStart = record.start;
  }
  return output;
}

export function compileClassicTemplate(source, compiler) {
  try {
    return compileTemplate(source, "ClassicScriptExternal", compiler);
  } catch (error) {
    if (error instanceof TypeError && error.message === "Invalid compiler result") {
      throw new TypeError("Invalid classic-script compiler result");
    }
    throw error;
  }
}

export function renderClassicTemplate(source, targetURL, abiIdentifier, compiler, template) {
  assertRewriteContext(source, targetURL, abiIdentifier, "ClassicScriptExternal");
  if (
    !Array.isArray(template?.abi_identifiers)
    || template.abi_identifiers.some((identifier) => typeof identifier !== "string")
    || template.abi_identifiers.includes(abiIdentifier)
  ) {
    throw new TypeError("Compiler rejected executable source");
  }
  if (typeof compiler?.source_map_base64 !== "function") {
    throw new TypeError("Compiler source-map ABI unavailable");
  }
  const code = instantiateClassicTemplate(template, abiIdentifier);
  const effectiveSourceURL = safeSourceURL(template.source_url ?? targetURL);
  const sourceMap = compiler.source_map_base64(
    source,
    code,
    0,
    effectiveSourceURL,
    JSON.stringify(template.edit_map),
    template.source_mapping_url ?? undefined,
  );
  if (typeof sourceMap !== "string" || sourceMap.length === 0) {
    throw new TypeError("Invalid classic-script source map");
  }
  return `${code}\n//# sourceURL=${effectiveSourceURL}\n//# sourceMappingURL=data:application/json;base64,${sourceMap}`;
}

export function rewriteClassicScript(source, targetURL, abiIdentifier, compiler) {
  return renderClassicTemplate(
    source,
    targetURL,
    abiIdentifier,
    compiler,
    compileClassicTemplate(source, compiler),
  );
}

export function rewriteModuleScript(
  source,
  targetURL,
  abiIdentifier,
  compiler,
  sourceKind,
  moduleGraph,
) {
  assertRewriteContext(source, targetURL, abiIdentifier, sourceKind);
  if (!isModuleWorkerSourceKind(sourceKind)) {
    throw new TypeError("Unsupported module source kind");
  }
  if (
    sourceKind !== WorkerSourceKind.workerModule
    && sourceKind !== WorkerSourceKind.sharedWorkerModule
    && sourceKind !== WorkerSourceKind.workletModule
  ) {
    throw new TypeError("Classic workers do not have module graphs");
  }
  const compiled = compile(source, sourceKind, abiIdentifier, compiler);
  const code = rewriteModuleSpecifiers(
    compiled,
    targetURL,
    sourceKind,
    moduleGraph,
  );
  return `${code}\n//# sourceURL=${safeSourceURL(compiled.source_url ?? targetURL)}`;
}

export function rewriteWorkerClassicScript(source, targetURL, abiIdentifier, compiler) {
  assertRewriteContext(source, targetURL, abiIdentifier, WorkerSourceKind.workerClassic);
  return compile(source, WorkerSourceKind.workerClassic, abiIdentifier, compiler).code;
}

export function rewriteSharedWorkerClassicScript(source, targetURL, abiIdentifier, compiler) {
  assertRewriteContext(source, targetURL, abiIdentifier, WorkerSourceKind.sharedWorkerClassic);
  return compile(source, WorkerSourceKind.sharedWorkerClassic, abiIdentifier, compiler).code;
}

export function rewriteWorkerModule(source, targetURL, abiIdentifier, compiler, moduleGraph) {
  return rewriteModuleScript(
    source,
    targetURL,
    abiIdentifier,
    compiler,
    WorkerSourceKind.workerModule,
    moduleGraph,
  );
}

export function rewriteSharedWorkerModule(source, targetURL, abiIdentifier, compiler, moduleGraph) {
  return rewriteModuleScript(
    source,
    targetURL,
    abiIdentifier,
    compiler,
    WorkerSourceKind.sharedWorkerModule,
    moduleGraph,
  );
}

export function rewriteWorkletModule(source, targetURL, abiIdentifier, compiler, moduleGraph) {
  return rewriteModuleScript(
    source,
    targetURL,
    abiIdentifier,
    compiler,
    WorkerSourceKind.workletModule,
    moduleGraph,
  );
}
