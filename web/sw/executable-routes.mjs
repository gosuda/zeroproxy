import { decodeCompilerResult } from "../compiler-result.mjs";
import { createClassicWorkerBootstrap } from "../worker/classic.mjs";
import { createModuleWorkerBootstrap } from "../worker/module.mjs";
import { createSharedWorkerClassicBootstrap } from "../worker/shared-classic.mjs";
import { createSharedWorkerModuleBootstrap } from "../worker/shared-module.mjs";
import { WorkerSourceKind } from "../worker/source-kinds.mjs";
import { createWorkletModuleBootstrap } from "../worker/worklet.mjs";
import {
  rewriteClassicScript,
  rewriteSharedWorkerClassicScript,
  rewriteWorkerClassicScript,
} from "./script-rewrite.mjs";

const MODULE_SOURCE_KINDS = new Set([
  "ModuleScript",
  "TargetServiceWorkerModule",
  WorkerSourceKind.workerModule,
  WorkerSourceKind.sharedWorkerModule,
  WorkerSourceKind.workletModule,
]);
const MODULE_TYPES = new Set(["javascript", "json"]);

const CLASSIC_SOURCE_KINDS = new Set([
  "ClassicScriptExternal",
  WorkerSourceKind.workerClassic,
  WorkerSourceKind.sharedWorkerClassic,
]);

const BOOTSTRAP_FACTORIES = Object.freeze({
  [WorkerSourceKind.workerClassic]: createClassicWorkerBootstrap,
  [WorkerSourceKind.workerModule]: createModuleWorkerBootstrap,
  [WorkerSourceKind.sharedWorkerClassic]: createSharedWorkerClassicBootstrap,
  [WorkerSourceKind.sharedWorkerModule]: createSharedWorkerModuleBootstrap,
  [WorkerSourceKind.workletModule]: createWorkletModuleBootstrap,
});

const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const ABI_IDENTIFIER = /^__zp_abi_[a-f0-9]{48}$/u;
const DEFAULT_MODULE_GRAPH_LIMITS = Object.freeze({
  maxDepth: 16,
  maxModules: 64,
  maxModuleBytes: 1_048_576,
  maxSourceBytes: 8_388_608,
  maxOutputBytes: 8_388_608,
});

function securityError(message) {
  if (typeof DOMException === "function") return new DOMException(message, "SecurityError");
  const error = new Error(message);
  error.name = "SecurityError";
  return error;
}

function reject(message) {
  throw securityError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function moduleGraphLimits(value) {
  if (value === undefined) return DEFAULT_MODULE_GRAPH_LIMITS;
  if (!isRecord(value)) reject("Invalid module graph limits");
  const allowed = ["maxDepth", "maxModules", "maxModuleBytes", "maxSourceBytes", "maxOutputBytes"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) reject("Invalid module graph limits");
  const limits = { ...DEFAULT_MODULE_GRAPH_LIMITS, ...value };
  for (const limit of Object.values(limits)) {
    if (!Number.isSafeInteger(limit) || limit <= 0) reject("Invalid module graph limits");
  }
  if (limits.maxModuleBytes > limits.maxSourceBytes) reject("Invalid module graph limits");
  return Object.freeze(limits);
}

function utf8ByteLength(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function isThenable(value) {
  return value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof value.then === "function";
}

function canonicalTargetURL(value, base) {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) {
    reject("Invalid executable target URL");
  }
  let target;
  try {
    target = new URL(value, base);
  } catch {
    reject("Invalid executable target URL");
  }
  if (
    (target.protocol !== "http:" && target.protocol !== "https:")
    || target.username !== ""
    || target.password !== ""
  ) {
    reject("Unsupported executable target URL");
  }
  return target.href;
}

function canonicalRootTargetURL(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_100_000)
    reject("Invalid executable target URL");
  let target;
  try { target = new URL(value); } catch {
    reject("Invalid executable target URL");
  }
  if (target.protocol === "http:" || target.protocol === "https:")
    return canonicalTargetURL(value);
  if (target.protocol !== "blob:" && target.protocol !== "data:")
    reject("Unsupported executable target URL");
  return target.href;
}

function safeSourceURL(value) {
  return String(value)
    .replaceAll("<", "%3C")
    .replaceAll(">", "%3E")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll("\u2028", "%E2%80%A8")
    .replaceAll("\u2029", "%E2%80%A9");
}

function cloneRequestContext(value) {
  if (!isRecord(value)) reject("Invalid executable request context");
  const allowed = ["credentials", "referrer", "integrity", "cache", "mode"];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) reject("Invalid executable request context");
  const {
    credentials,
    referrer,
    integrity,
    cache,
    mode,
  } = value;
  if (
    !["omit", "same-origin", "include"].includes(credentials)
    || typeof referrer !== "string"
    || typeof integrity !== "string"
    || !["default", "no-store", "reload", "no-cache", "force-cache", "only-if-cached"].includes(cache)
    || !["cors", "same-origin", "no-cors"].includes(mode)
  ) {
    reject("Invalid executable request context");
  }
  return Object.freeze({ credentials, referrer, integrity, cache, mode });
}

function compilerResult(compiler, source, sourceKind, abiIdentifier) {
  if (typeof compiler?.compile_json !== "function") reject("Compiler ABI unavailable");
  let result;
  try {
    result = decodeCompilerResult(compiler.compile_json(source, sourceKind, abiIdentifier));
  } catch {
    reject("Invalid compiler result");
  }
  if (result.ok !== true) reject(`Compiler rejected executable source: ${result.error.code}`);
  return result;
}

function byteOffsetToCodeUnit(value, byteOffset) {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) reject("Invalid module specifier offset");
  let bytes = 0;
  let codeUnits = 0;
  for (const codePoint of value) {
    if (bytes === byteOffset) return codeUnits;
    const scalar = codePoint.codePointAt(0);
    bytes += scalar <= 0x7f ? 1 : scalar <= 0x7ff ? 2 : scalar <= 0xffff ? 3 : 4;
    codeUnits += codePoint.length;
  }
  if (bytes === byteOffset) return codeUnits;
  reject("Module specifier offset exceeds output");
}

function moduleSpecifier(record, code) {
  if (
    !isRecord(record)
    || typeof record.specifier !== "string"
    || typeof record.module_type !== "string"
    || !MODULE_TYPES.has(record.module_type)
    || !Number.isSafeInteger(record.generated_start)
    || !Number.isSafeInteger(record.generated_end)
    || record.generated_start < 0
    || record.generated_end <= record.generated_start
  ) {
    reject("Invalid module graph metadata");
  }
  const start = byteOffsetToCodeUnit(code, record.generated_start);
  const end = byteOffsetToCodeUnit(code, record.generated_end);
  const literal = code.slice(start, end);
  if (literal.length < 2 || !["'", "\""].includes(literal[0]) || literal.at(-1) !== literal[0]) {
    reject("Invalid module specifier span");
  }
  return Object.freeze({
    end,
    module_type: record.module_type,
    specifier: record.specifier,
    start,
  });
}

function controlledRoute(value, graphID) {
  if (
    !isRecord(value)
    || value.graph_id !== graphID
    || typeof value.module_id !== "string"
    || !HEX_DIGEST.test(value.module_id)
    || typeof value.url !== "string"
    || value.url.length === 0
  ) {
    reject("Invalid controlled executable route");
  }
  return Object.freeze({
    controlled: true,
    graph_id: graphID,
    module_id: value.module_id,
    url: value.url,
  });
}

function routeURL(moduleRoute, graphID, contentID) {
  let route;
  try { route = moduleRoute(graphID, contentID); } catch { reject("Module route rejected"); }
  if (typeof route !== "string" || route.length === 0 || route.length > 16_384) reject("Module route rejected");
  let parsed;
  try { parsed = new URL(route, "https://route.invalid"); } catch { reject("Module route rejected"); }
  if (route !== parsed.pathname || parsed.search || parsed.hash) reject("Module route rejected");
  return route;
}

async function defaultDigest(bytes) {
  if (!globalThis.crypto?.subtle) reject("Digest capability unavailable");
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function contentDigest(source, digest) {
  const bytes = new TextEncoder().encode(source);
  const output = await digest(bytes);
  if (typeof output !== "string" || !HEX_DIGEST.test(output)) reject("Invalid module content digest");
  return output;
}

function assertSourceKind(sourceKind) {
  if (!MODULE_SOURCE_KINDS.has(sourceKind) && !CLASSIC_SOURCE_KINDS.has(sourceKind)) {
    reject("Unsupported executable source kind");
  }
  return sourceKind;
}

function appendSourceURL(code, sourceURL) {
  return `${code}\n//# sourceURL=${safeSourceURL(sourceURL)}`;
}

function moduleContextPrelude(abiIdentifier, targetURL, moduleID) {
  return `const ${abiIdentifier}=globalThis[${JSON.stringify(abiIdentifier)}].moduleContext(import.meta,${JSON.stringify(targetURL)},${JSON.stringify(moduleID)});\n`;
}
/**
 * Builds a content-addressed graph for module source. Loading is delegated to
 * the caller so this module never performs browser-network I/O itself.
 */
export function createContentAddressedModuleGraph({
  abiIdentifier,
  compiler,
  digest = defaultDigest,
  graphID,
  limits,
  load,
  moduleRoute,
  policyVersion,
  resolveSpecifier,
  requestContext,
} = {}) {
  if (typeof abiIdentifier !== "string" || !ABI_IDENTIFIER.test(abiIdentifier)) reject("Invalid executable ABI identifier");
  if (
    typeof compiler?.compile_json !== "function"
    || typeof digest !== "function"
    || typeof graphID !== "string"
    || graphID.length === 0
    || typeof load !== "function"
    || typeof moduleRoute !== "function"
    || !Number.isSafeInteger(policyVersion)
    || policyVersion < 1
  ) {
    reject("Invalid module graph configuration");
  }
  if (resolveSpecifier !== undefined && typeof resolveSpecifier !== "function") reject("Invalid module specifier resolver");
  const context = cloneRequestContext(requestContext);
  const graphLimits = moduleGraphLimits(limits);
  let moduleCount = 0;
  let sourceBytes = 0;
  let outputBytes = 0;

  function reserveSource(source) {
    const size = utf8ByteLength(source);
    if (moduleCount >= graphLimits.maxModules || size > graphLimits.maxModuleBytes || sourceBytes + size > graphLimits.maxSourceBytes) {
      reject("Module graph exceeds limits");
    }
    moduleCount += 1;
    sourceBytes += size;
  }

  function reserveOutput(source) {
    const size = utf8ByteLength(source);
    if (outputBytes + size > graphLimits.maxOutputBytes) reject("Module graph exceeds limits");
    outputBytes += size;
  }

  function checkedModuleType(value) {
    if (typeof value !== "string" || !MODULE_TYPES.has(value)) {
      reject("Unsupported module type");
    }
    return value;
  }

  function identityKey(targetURL, sourceKind, moduleType) {
    return JSON.stringify({
      cache: context.cache,
      credentials: context.credentials,
      integrity: context.integrity,
      mode: context.mode,
      module_type: moduleType,
      policy_version: policyVersion,
      referrer: context.referrer,
      source_kind: sourceKind,
      target_url: targetURL,
    });
  }

  const byIdentity = new Map();
  const byModuleID = new Map();

  async function createEntry(targetURL, sourceKind, moduleType) {
    const identity = identityKey(targetURL, sourceKind, moduleType);
    const moduleID = await contentDigest(identity, digest);
    const collision = byModuleID.get(moduleID);
    if (collision && collision.identity !== identity) reject("Module identity digest collision");
    const route = Object.freeze({
      controlled: true,
      graph_id: graphID,
      module_id: moduleID,
      url: routeURL(moduleRoute, graphID, moduleID),
    });
    const entry = {
      content: null,
      contentID: null,
      identity,
      moduleID,
      moduleType,
      output: null,
      rewritten: null,
      route,
      sourceKind,
      targetURL,
    };
    byIdentity.set(identity, entry);
    byModuleID.set(moduleID, entry);
    return entry;
  }

  async function populateModuleEntry(entry, canonicalURL, importerURL, depth) {
    const loaded = await load(Object.freeze({
      importer_url: importerURL,
      module_type: entry.moduleType,
      request_context: context,
      source_kind: entry.sourceKind,
      target_url: canonicalURL,
    }));
    if (!isRecord(loaded) || typeof loaded.source !== "string") reject("Invalid controlled module source");
    const finalURL = canonicalTargetURL(loaded.target_url ?? canonicalURL, canonicalURL);
    if (finalURL !== canonicalURL) reject("Executable redirects require a controlled route");
    if (loaded.module_type !== undefined && loaded.module_type !== entry.moduleType) {
      reject("Controlled module type mismatch");
    }
    entry.contentID = await contentDigest(loaded.source, digest);
    reserveSource(loaded.source);
    entry.content = loaded.source;
    entry.rewritten = rewriteLoaded(entry, depth);
    await entry.rewritten;
    return entry.route;
  }

  async function loadModule(
    targetURL,
    sourceKind,
    importerURL = null,
    depth = 1,
    moduleType = "javascript",
  ) {
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > graphLimits.maxDepth) {
      reject("Module graph exceeds limits");
    }
    const canonicalURL = canonicalTargetURL(targetURL, importerURL ?? undefined);
    const checkedType = checkedModuleType(moduleType);
    const identity = identityKey(canonicalURL, sourceKind, checkedType);
    const cached = byIdentity.get(identity);
    if (cached) return cached.route;
    const entry = await createEntry(canonicalURL, sourceKind, checkedType);
    try {
      return await populateModuleEntry(entry, canonicalURL, importerURL, depth);
    } catch (error) {
      if (byIdentity.get(identity) === entry) byIdentity.delete(identity);
      if (byModuleID.get(entry.moduleID) === entry) byModuleID.delete(entry.moduleID);
      throw error;
    }
  }

  async function rewriteLoaded(entry, depth) {
    if (entry.moduleType === "json") {
      entry.output = entry.content;
      reserveOutput(entry.output);
      return entry.output;
    }
    const compiled = compilerResult(
      compiler,
      entry.content,
      entry.sourceKind,
      abiIdentifier,
    );
    if (!Array.isArray(compiled.module_specifiers)) reject("Module compiler graph metadata unavailable");
    const specifiers = compiled.module_specifiers
      .map((record) => moduleSpecifier(record, compiled.code))
      .sort((left, right) => right.start - left.start);
    let output = compiled.code;
    let previousStart = output.length;
    for (const record of specifiers) {
      if (record.end > previousStart) reject("Overlapping module graph spans");
      const resolved = resolveSpecifier
        ? await resolveSpecifier(Object.freeze({
            importer_url: entry.targetURL,
            module_type: record.module_type,
            request_context: context,
            source_kind: entry.sourceKind,
            specifier: record.specifier,
          }))
        : record.specifier;
      const resolvedURL = typeof resolved === "string" ? resolved : resolved?.url;
      if (typeof resolvedURL !== "string" || resolvedURL.length === 0) reject("Invalid resolved module specifier");
      const resolvedType = checkedModuleType(
        typeof resolved === "string"
          ? record.module_type
          : resolved.module_type ?? record.module_type,
      );
      const dependency = await loadModule(
        resolvedURL,
        entry.sourceKind,
        entry.targetURL,
        depth + 1,
        resolvedType,
      );
      const route = controlledRoute(dependency, graphID);
      output = `${output.slice(0, record.start)}${JSON.stringify(route.url)}${output.slice(record.end)}`;
      previousStart = record.start;
    }
    entry.output = appendSourceURL(
      `${moduleContextPrelude(abiIdentifier, entry.targetURL, entry.moduleID)}${output}`,
      compiled.source_url ?? entry.targetURL,
    );
    reserveOutput(entry.output);
    return entry.output;
  }

  async function rewriteRoot(
    source,
    targetURL,
    sourceKind,
    moduleType = "javascript",
  ) {
    if (typeof source !== "string" || !MODULE_SOURCE_KINDS.has(sourceKind)) reject("Invalid module root");
    const canonicalURL = canonicalRootTargetURL(targetURL);
    const checkedType = checkedModuleType(moduleType);
    if (checkedType !== "javascript" && sourceKind === WorkerSourceKind.workletModule) {
      reject("Unsupported worklet module type");
    }
    const identity = identityKey(canonicalURL, sourceKind, checkedType);
    const contentID = await contentDigest(source, digest);
    const existing = byIdentity.get(identity);
    if (existing) {
      if (existing.contentID !== null && existing.contentID !== contentID) reject("Conflicting module root content");
      await existing.rewritten;
      return Object.freeze({ route: existing.route, source: existing.output });
    }
    const entry = await createEntry(canonicalURL, sourceKind, checkedType);
    reserveSource(source);
    entry.content = source;
    entry.contentID = contentID;
    entry.rewritten = rewriteLoaded(entry, 0);
    try {
      await entry.rewritten;
    } catch (error) {
      if (byIdentity.get(identity) === entry) byIdentity.delete(identity);
      if (byModuleID.get(entry.moduleID) === entry) byModuleID.delete(entry.moduleID);
      throw error;
    }
    return Object.freeze({ route: entry.route, source: entry.output });
  }

  async function sourceFor(moduleID) {
    if (typeof moduleID !== "string" || !HEX_DIGEST.test(moduleID)) reject("Invalid module ID");
    const entry = byModuleID.get(moduleID);
    if (!entry) reject("Unknown module identity");
    await entry.rewritten;
    return Object.freeze({
      content_id: entry.contentID,
      graph_id: graphID,
      module_id: moduleID,
      module_type: entry.moduleType,
      request_context: context,
      source: entry.output,
      source_kind: entry.sourceKind,
      target_url: entry.targetURL,
    });
  }

  async function allSources() {
    const entries = [];
    for (const [moduleID, entry] of byModuleID) {
      await entry.rewritten;
      entries.push(Object.freeze({
        content_id: entry.contentID,
        graph_id: graphID,
        module_id: moduleID,
        module_type: entry.moduleType,
        source: entry.output,
        target_url: entry.targetURL,
        source_kind: entry.sourceKind,
      }));
    }
    return Object.freeze(entries);
  }

  return Object.freeze({
    allSources,
    context,
    graph_id: graphID,
    policy_version: policyVersion,
    rewriteRoot,
    sourceFor,
  });
}

/**
 * Returns a synchronous route callback for the worker runtime's classic
 * importScripts contract. The resolver is deliberately required to be
 * synchronous: native importScripts ordering is observable.
 */
export function createOrderedClassicImportScriptsRoute({
  requestContext,
  resolve,
} = {}) {
  const context = cloneRequestContext(requestContext);
  if (typeof resolve !== "function") reject("Classic executable resolver unavailable");
  return function classicRoute({ rawURL, sourceKind, targetURL } = {}) {
    if (!CLASSIC_SOURCE_KINDS.has(sourceKind) || typeof rawURL !== "string") reject("Invalid classic importScripts request");
    const canonicalURL = canonicalTargetURL(rawURL, targetURL);
    const result = resolve(Object.freeze({
      request_context: context,
      source_kind: sourceKind,
      target_url: canonicalURL,
    }));
    if (isThenable(result)) reject("Classic importScripts route must be synchronous");
    if (!isRecord(result) || result.controlled !== true || typeof result.url !== "string" || result.url.length === 0) {
      reject("Invalid controlled classic route");
    }
    return Object.freeze({ controlled: true, url: result.url });
  };
}

export function createTargetServiceWorkerModuleWrapper(abiIdentifier, rootURL) {
  if (
    typeof abiIdentifier !== "string"
    || !ABI_IDENTIFIER.test(abiIdentifier)
    || typeof rootURL !== "string"
    || rootURL.length === 0
  ) {
    reject("Invalid target service worker module wrapper");
  }
  const name = JSON.stringify(abiIdentifier);
  const root = JSON.stringify(rootURL);
  return `export async function install(scope,importModule){
const contexts=new WeakMap,metas=new WeakMap,NativeDOMException=DOMException,NativeEvalError=EvalError,NativePromise=Promise,NativeTypeError=TypeError,NativeURL=URL,toSource=value=>\`\${value}\`,deny=()=>{throw new NativeEvalError("String compilation is disabled by ZeroProxy policy")};if(typeof importModule!=="function")throw new NativeTypeError("Target worker module import capability unavailable");
function checkedMeta(nativeMeta,originalURL){if(nativeMeta===null||(typeof nativeMeta!=="object"&&typeof nativeMeta!=="function")||typeof originalURL!=="string")throw new NativeDOMException("Invalid native module context","SecurityError")}
function moduleMeta(nativeMeta,originalURL){checkedMeta(nativeMeta,originalURL);const existing=metas.get(nativeMeta);if(existing){if(existing.originalURL!==originalURL)throw new NativeDOMException("Module context identity mismatch","SecurityError");return existing.meta}const meta=Object.freeze({url:originalURL,resolve:value=>new NativeURL(toSource(value),originalURL).href});metas.set(nativeMeta,{originalURL,meta});return meta}
const abi=Object.freeze({scope,thisValue:value=>value,evalSource(value){if(typeof value!=="string")return value;return deny()},indirectEval(value){if(typeof value!=="string")return value;return deny()},dynamicFunction:deny,importOperand:value=>value,moduleMeta,moduleContext(nativeMeta,originalURL,moduleID){checkedMeta(nativeMeta,originalURL);if(typeof moduleID!=="string"||!/^[0-9a-f]{64}$/.test(moduleID))throw new NativeDOMException("Invalid module identity","SecurityError");const existing=contexts.get(nativeMeta);if(existing){if(existing.originalURL!==originalURL||existing.moduleID!==moduleID)throw new NativeDOMException("Module context identity mismatch","SecurityError");return existing.context}const context=Object.freeze({...abi,importMeta:moduleMeta(nativeMeta,originalURL),importModule(value,options){return NativePromise.resolve().then(async()=>{const plan=await importModule(moduleID,originalURL,toSource(value));return import(plan.url,options)})}});contexts.set(nativeMeta,{context,moduleID,originalURL});return context}});
Object.defineProperty(globalThis,${name},{configurable:false,enumerable:false,writable:false,value:abi});
await import(${root})
}`;
}

export function createWorkletModuleWrapper(abiIdentifier, rootURL) {
  if (
    typeof abiIdentifier !== "string"
    || !ABI_IDENTIFIER.test(abiIdentifier)
    || typeof rootURL !== "string"
    || rootURL.length === 0
  ) {
    reject("Invalid worklet module wrapper");
  }
  const name = JSON.stringify(abiIdentifier);
  const root = JSON.stringify(rootURL);
  return `const evalDescriptor=Object.getOwnPropertyDescriptor(globalThis,"eval");
if(!evalDescriptor||!Object.hasOwn(evalDescriptor,"value")||typeof evalDescriptor.value!=="function"||evalDescriptor.configurable!==true)throw new DOMException("Worklet eval descriptor unavailable","SecurityError");
const intrinsicEval=evalDescriptor.value,indirectEval=value=>{if(typeof value!=="string")return value;throw new DOMException("Dynamic code is unavailable","SecurityError")};
const scope=Object.freeze(Object.defineProperties({AudioWorkletProcessor:globalThis.AudioWorkletProcessor,CSS:globalThis.CSS,registerPaint:typeof globalThis.registerPaint==="function"?globalThis.registerPaint.bind(globalThis):undefined,registerProcessor:typeof globalThis.registerProcessor==="function"?globalThis.registerProcessor.bind(globalThis):undefined},{currentFrame:{get:()=>globalThis.currentFrame},currentTime:{get:()=>globalThis.currentTime},eval:{...evalDescriptor,configurable:false,value:indirectEval,writable:false},sampleRate:{get:()=>globalThis.sampleRate}}));
if(typeof scope.registerPaint!=="function"&&typeof scope.registerProcessor!=="function")throw new DOMException("Unsupported worklet capability","NotSupportedError");
const contexts=new WeakMap(),metas=new WeakMap(),toSource=value=>\`\${value}\`,NativeDOMException=DOMException,NativePromise=Promise,NativeURL=URL;
function checkedMeta(nativeMeta,originalURL){if(nativeMeta===null||(typeof nativeMeta!=="object"&&typeof nativeMeta!=="function")||typeof originalURL!=="string")throw new DOMException("Invalid native module context","SecurityError")}
function moduleMeta(nativeMeta,originalURL){checkedMeta(nativeMeta,originalURL);const existing=metas.get(nativeMeta);if(existing){if(existing.originalURL!==originalURL)throw new DOMException("Module context identity mismatch","SecurityError");return existing.meta}const meta=Object.freeze({url:originalURL,resolve:value=>new NativeURL(toSource(value),originalURL).href});metas.set(nativeMeta,{originalURL,meta});return meta}
function protectedEvalDescriptorMatches(descriptor,value){return descriptor&&Object.hasOwn(descriptor,"value")&&descriptor.value===value&&descriptor.writable===false&&descriptor.configurable===false&&descriptor.enumerable===evalDescriptor.enumerable}
function evalDescriptorsHealthy(){return protectedEvalDescriptorMatches(Object.getOwnPropertyDescriptor(globalThis,"eval"),intrinsicEval)&&protectedEvalDescriptorMatches(Object.getOwnPropertyDescriptor(scope,"eval"),indirectEval)}
const abi=Object.freeze({scope,thisValue(value){return value},evalSource(value){if(typeof value!=="string")return value;throw new NativeDOMException("Dynamic code is unavailable","SecurityError")},importOperand(value){return value},moduleMeta,importModule(value){return NativePromise.resolve().then(()=>{toSource(value);throw new NativeDOMException("Dynamic module loading is unavailable","SecurityError")})},moduleContext(nativeMeta,originalURL,moduleID){checkedMeta(nativeMeta,originalURL);if(typeof moduleID!=="string"||!/^[0-9a-f]{64}$/.test(moduleID))throw new NativeDOMException("Invalid module identity","SecurityError");const existing=contexts.get(nativeMeta);if(existing){if(existing.originalURL!==originalURL||existing.moduleID!==moduleID)throw new NativeDOMException("Module context identity mismatch","SecurityError");return existing.context}const context=Object.freeze({scope,thisValue:abi.thisValue,evalSource:abi.evalSource,importMeta:moduleMeta(nativeMeta,originalURL),importModule:abi.importModule,importOperand:abi.importOperand});contexts.set(nativeMeta,{context,moduleID,originalURL});return context},runtimeHealth:evalDescriptorsHealthy});
Object.defineProperty(globalThis,${name},{configurable:false,enumerable:false,writable:false,value:abi});
Object.defineProperty(globalThis,"eval",{...evalDescriptor,configurable:false,value:intrinsicEval,writable:false});
if(!evalDescriptorsHealthy())throw new DOMException("Worklet eval hardening failed","SecurityError");
await import(${root});`;
}

/**
 * Generates the bootstrap program served to target Worker/SharedWorker/
 * Worklet constructors. The program delegates initialization to the existing
 * worker factories selected by worker-bootstrap.mjs's source_kind fragment.
 */
export function workerBootstrapSource({ bootstrapModuleURL, sourceKind } = {}) {
  if (typeof bootstrapModuleURL !== "string" || bootstrapModuleURL.length === 0 || !Object.hasOwn(BOOTSTRAP_FACTORIES, sourceKind)) {
    reject("Invalid worker bootstrap configuration");
  }
  const bootstrapURL = new URL(bootstrapModuleURL, "https://bootstrap.invalid/");
  bootstrapURL.hash = new URLSearchParams({ source_kind: sourceKind }).toString();
  const url = bootstrapModuleURL.startsWith("/") ? `${bootstrapModuleURL.split("#", 1)[0]}${bootstrapURL.hash}` : bootstrapURL.href;
  if (CLASSIC_SOURCE_KINDS.has(sourceKind)) {
    return `void import(${JSON.stringify(url)}).catch(()=>{try{globalThis.close()}catch{}});`;
  }
  return `import ${JSON.stringify(url)};`;
}

export const workerBootstrapFactories = BOOTSTRAP_FACTORIES;

/**
 * Narrow top-level executable router for Main's future SW wiring.
 */
export function createExecutableRouteRewriter({
  abiIdentifier,
  compiler,
  moduleGraph,
} = {}) {
  if (typeof abiIdentifier !== "string" || !ABI_IDENTIFIER.test(abiIdentifier) || typeof compiler?.compile_json !== "function") {
    reject("Invalid executable route rewriter configuration");
  }
  return Object.freeze({
    async rewrite({ source, sourceKind, targetURL } = {}) {
      assertSourceKind(sourceKind);
      if (typeof source !== "string") reject("Invalid executable source");
      const canonicalURL = canonicalTargetURL(targetURL);
      if (sourceKind === "ClassicScriptExternal") {
        return Object.freeze({ source: rewriteClassicScript(source, canonicalURL, abiIdentifier, compiler), source_kind: sourceKind, target_url: canonicalURL });
      }
      if (sourceKind === WorkerSourceKind.workerClassic) {
        return Object.freeze({ source: rewriteWorkerClassicScript(source, canonicalURL, abiIdentifier, compiler), source_kind: sourceKind, target_url: canonicalURL });
      }
      if (sourceKind === WorkerSourceKind.sharedWorkerClassic) {
        return Object.freeze({ source: rewriteSharedWorkerClassicScript(source, canonicalURL, abiIdentifier, compiler), source_kind: sourceKind, target_url: canonicalURL });
      }
      if (!moduleGraph || typeof moduleGraph.rewriteRoot !== "function") reject("Controlled module graph unavailable");
      const rewritten = await moduleGraph.rewriteRoot(source, canonicalURL, sourceKind);
      return Object.freeze({
        module_route: controlledRoute(rewritten.route, moduleGraph.graph_id),
        source: rewritten.source,
        source_kind: sourceKind,
        target_url: canonicalURL,
      });
    },
  });
}
