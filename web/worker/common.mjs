import {
  decodeCompilerResult,
  decodeDynamicCompilerResult,
  validateCompilerResult,
  validateDynamicCompilerResult,
} from "../compiler-result.mjs";
import { DISABLED_CAPABILITY_METHODS } from "../generated/emerging-network-capabilities.mjs";
import { DISABLED_NETWORK_GLOBALS } from "../generated/owned-globals.mjs";
import {
  isModuleWorkerSourceKind,
  isWorkerSourceKind,
  WorkerSourceKind,
} from "./source-kinds.mjs";

const nativeReflectApply = Reflect.apply;
const nativeGlobalThis = globalThis;
const nativeMapDelete = Map.prototype.delete;
const nativeMapGet = Map.prototype.get;
const nativeMapSet = Map.prototype.set;
const nativeObjectFreeze = Object.freeze;
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const NativeDOMException = globalThis.DOMException;
const NativeError = Error;
const NativeEvalError = EvalError;
const NativeString = String;
const NativeSyntaxError = SyntaxError;
const NativeTextDecoder = TextDecoder;
const NativeTextEncoder = TextEncoder;
const NativeUint8Array = Uint8Array;
const arrayJoin = Array.prototype.join;
const arrayPop = Array.prototype.pop;
const arrayPush = Array.prototype.push;
const nativeAtob = globalThis.atob;
const nativeNumberParseInt = Number.parseInt;
const nativeRegExpExec = RegExp.prototype.exec;
const nativeRegExpTest = RegExp.prototype.test;
const nativeSetHas = Set.prototype.has;
const nativeStringCharCodeAt = String.prototype.charCodeAt;
const nativeStringCodePointAt = String.prototype.codePointAt;
const nativeStringFromCharCode = String.fromCharCode;
const nativeStringFromCodePoint = String.fromCodePoint;
const stringIndexOf = String.prototype.indexOf;
const stringSlice = String.prototype.slice;
const stringSplit = String.prototype.split;
const stringToLowerCase = String.prototype.toLowerCase;
const stringTrim = String.prototype.trim;
const textDecoderDecode = TextDecoder.prototype.decode;
const textEncoderEncode = TextEncoder.prototype.encode;
const uint8ArrayFrom = Uint8Array.from;
const ABI_IDENTIFIER = /^__zp_abi_[a-f0-9]{48}$/u;
const toDynamicSource = value => `${value}`;
const JAVASCRIPT_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
]);

function securityError(message) {
  if (typeof NativeDOMException === "function") {
    return new NativeDOMException(message, "SecurityError");
  }
  const error = new NativeError(message);
  error.name = "SecurityError";
  return error;
}

function blocked(message) {
  throw securityError(message);
}

function denyStringCompilation() {
  throw new NativeEvalError("String compilation is disabled by ZeroProxy policy");
}

function isThenable(value) {
  return value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof value.then === "function";
}

function assertControlledRoute(value, message) {
  if (
    !value
    || typeof value !== "object"
    || value.controlled !== true
    || typeof value.url !== "string"
    || value.url.length === 0
    || isThenable(value)
  ) {
    blocked(message);
  }
  return value;
}

function normalizeCompilerResult(value) {
  let result;
  try {
    result = validateCompilerResult(value);
  } catch {
    blocked("Compiler returned an invalid executable result");
  }
  if (result.ok !== true) {
    blocked(`Compiler rejected executable source: ${result.error.code}`);
  }
  return result;
}

function normalizeDynamicFunctionCompilerResult(value) {
  let result;
  try {
    result = validateDynamicCompilerResult(value);
  } catch {
    blocked("Compiler returned an invalid dynamic function result");
  }
  if (result.ok !== true) {
    blocked(`Compiler rejected dynamic function source: ${result.error.code}`);
  }
  return result;
}

function compileDynamicFunctionSource(
  compiler,
  parameters,
  body,
  sourceKind,
  abiIdentifier,
) {
  if (
    !Array.isArray(parameters)
    || parameters.some((parameter) => typeof parameter !== "string")
    || typeof body !== "string"
  ) {
    blocked("Dynamic function source must be strings");
  }
  try {
    if (typeof compiler?.compileDynamicFunction === "function") {
      const result = compiler.abiIdentifier === abiIdentifier
        ? compiler.compileDynamicFunction(parameters, body, sourceKind)
        : compiler.compileDynamicFunction(parameters, body, sourceKind, abiIdentifier);
      return normalizeDynamicFunctionCompilerResult(result);
    }
    if (typeof compiler?.compile_dynamic_function_json === "function") {
      return normalizeDynamicFunctionCompilerResult(decodeDynamicCompilerResult(
        compiler.compile_dynamic_function_json(
          JSON.stringify(parameters),
          body,
          sourceKind,
          abiIdentifier,
        ),
      ));
    }
  } catch (error) {
    const message = typeof error === "string"
      ? error
      : typeof error?.message === "string" ? error.message : "";
    if (message.includes("PARSE_FAILED")) {
      throw new NativeSyntaxError("Invalid function source");
    }
    blocked("Dynamic function source was rejected by the compiler");
  }
  blocked("Dynamic function compiler capability unavailable");
}

function compileSource(compiler, source, sourceKind, abiIdentifier, metadata) {
  if (typeof source !== "string") blocked("Executable source must be a string");
  const directEval = sourceKind === "DirectEvalScript";
  const dynamicText = directEval || sourceKind === "IndirectEvalScript" || sourceKind === "TimerString";
  if (
    directEval
    && (
      !metadata
      || typeof metadata !== "object"
      || Array.isArray(metadata)
      || Object.keys(metadata).length !== 1
      || typeof metadata.caller_strict !== "boolean"
    )
  ) blocked("Direct eval caller metadata is invalid");
  if (!directEval && metadata !== undefined) blocked("Compiler metadata is invalid");
  try {
    if (typeof compiler?.compile === "function") {
      const result = compiler.abiIdentifier === abiIdentifier
        ? compiler.compile(source, sourceKind, metadata)
        : compiler.compile(source, sourceKind, abiIdentifier, metadata);
      return normalizeCompilerResult(result);
    }
    if (directEval && typeof compiler?.compile_json_with_direct_eval_strictness === "function") {
      return normalizeCompilerResult(decodeCompilerResult(
        compiler.compile_json_with_direct_eval_strictness(
          source,
          sourceKind,
          abiIdentifier,
          metadata.caller_strict,
        ),
      ));
    }
    if (!directEval && typeof compiler?.compile_json === "function") {
      return normalizeCompilerResult(
        decodeCompilerResult(compiler.compile_json(source, sourceKind, abiIdentifier)),
      );
    }
  } catch (error) {
    const message = typeof error === "string"
      ? error
      : typeof error?.message === "string" ? error.message : "";
    if (dynamicText && (error instanceof NativeSyntaxError || message.includes("PARSE_FAILED"))) {
      throw new NativeSyntaxError("Invalid executable source");
    }
    blocked("Executable source was rejected by the compiler");
  }
  blocked("Compiler capability unavailable");
}

function requireRoute(routes, method) {
  const route = routes?.[method];
  if (typeof route !== "function") blocked(`Controlled ${method} route unavailable`);
  return route;
}

function parseURL(global, targetURL) {
  try {
    return new global.URL(targetURL);
  } catch {
    blocked("Invalid target worker URL");
  }
}

function readCharset(mediaType, fallback = "utf-8") {
  const match = nativeReflectApply(
    nativeRegExpExec,
    /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/iu,
    [mediaType],
  );
  return nativeReflectApply(stringTrim, match?.[1] ?? match?.[2] ?? fallback, []);
}

function decodePercentBytes(value) {
  const bytes = [];
  const encoder = new NativeTextEncoder();
  for (let index = 0; index < value.length;) {
    if (value[index] === "%") {
      const hex = nativeReflectApply(stringSlice, value, [index + 1, index + 3]);
      if (nativeReflectApply(nativeRegExpTest, /^[0-9a-f]{2}$/iu, [hex])) {
        nativeReflectApply(arrayPush, bytes, [nativeNumberParseInt(hex, 16)]);
        index += 3;
        continue;
      }
    }
    const codePoint = nativeReflectApply(nativeStringCodePointAt, value, [index]);
    const encoded = nativeReflectApply(
      textEncoderEncode,
      encoder,
      [nativeStringFromCodePoint(codePoint)],
    );
    for (let offset = 0; offset < encoded.length; offset += 1) {
      nativeReflectApply(arrayPush, bytes, [encoded[offset]]);
    }
    index += codePoint > 0xffff ? 2 : 1;
  }
  const result = new NativeUint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) result[index] = bytes[index];
  return result;
}

function decodeDataURL(value, sourceKind) {
  if (!nativeReflectApply(nativeRegExpTest, /^data:/iu, [value])) {
    blocked("Invalid data executable URL");
  }
  const fragment = nativeReflectApply(stringIndexOf, value, ["#"]);
  const dataValue = fragment === -1 ? value : nativeReflectApply(stringSlice, value, [0, fragment]);
  const comma = nativeReflectApply(stringIndexOf, dataValue, [","]);
  if (comma < 5) blocked("Malformed data executable URL");
  const metadata = nativeReflectApply(stringSlice, dataValue, [5, comma]);
  const parts = nativeReflectApply(stringSplit, metadata, [";"]);
  const lastPart = parts.length === 0 ? "" : parts[parts.length - 1];
  const base64 = nativeReflectApply(
    stringToLowerCase,
    nativeReflectApply(stringTrim, lastPart, []),
    [],
  ) === "base64";
  if (base64) nativeReflectApply(arrayPop, parts, []);
  const mediaType = nativeReflectApply(
    stringTrim,
    nativeReflectApply(arrayJoin, parts, [";"]) || "text/plain;charset=US-ASCII",
    [],
  );
  const essence = nativeReflectApply(
    stringToLowerCase,
    nativeReflectApply(
      stringTrim,
      nativeReflectApply(stringSplit, mediaType, [";", 1])[0],
      [],
    ),
    [],
  );
  if (
    isModuleWorkerSourceKind(sourceKind)
    && !nativeReflectApply(nativeSetHas, JAVASCRIPT_MIME_TYPES, [essence])
  ) {
    blocked("Unsupported data executable MIME type");
  }
  const encoded = nativeReflectApply(stringSlice, dataValue, [comma + 1]);
  let bytes;
  try {
    if (base64) {
      const base64Bytes = decodePercentBytes(encoded);
      let base64Text = "";
      for (let index = 0; index < base64Bytes.length; index += 1) {
        base64Text += nativeStringFromCharCode(base64Bytes[index]);
      }
      bytes = nativeReflectApply(uint8ArrayFrom, NativeUint8Array, [
        nativeReflectApply(nativeAtob, nativeGlobalThis, [base64Text]),
        character => nativeReflectApply(nativeStringCharCodeAt, character, [0]),
      ]);
    } else {
      bytes = decodePercentBytes(encoded);
    }
  } catch {
    blocked("Malformed data executable URL");
  }
  const fallback = metadata === "" ? "us-ascii" : "utf-8";
  const label = readCharset(mediaType, fallback);
  let decoder;
  try { decoder = new NativeTextDecoder(label || "utf-8"); }
  catch { decoder = new NativeTextDecoder(); }
  const source = nativeReflectApply(textDecoderDecode, decoder, [bytes]);
  return nativeObjectFreeze({
    kind: "data",
    mediaType,
    source,
    url: value,
    release() {},
  });
}

function validateBlobType(mediaType, sourceKind) {
  const essence = nativeReflectApply(
    stringToLowerCase,
    nativeReflectApply(
      stringTrim,
      nativeReflectApply(stringSplit, mediaType, [";", 1])[0],
      [],
    ),
    [],
  );
  if (
    isModuleWorkerSourceKind(sourceKind)
    && !nativeReflectApply(nativeSetHas, JAVASCRIPT_MIME_TYPES, [essence])
  ) {
    blocked("Unsupported blob executable MIME type");
  }
  return mediaType;
}

export function createExecutableSourceRegistry(global) {
  const nativeURL = global?.URL;
  const blobURLSupported = typeof nativeURL?.createObjectURL === "function"
    && typeof nativeURL?.revokeObjectURL === "function";
  const nativeCreateObjectURL = blobURLSupported ? nativeURL.createObjectURL : null;
  const nativeRevokeObjectURL = blobURLSupported ? nativeURL.revokeObjectURL : null;
  const nativeBlobType = nativeObjectGetOwnPropertyDescriptor(global?.Blob?.prototype, "type")?.get;
  const entries = new Map();

  function discard(url, entry) {
    if (entry.revoked && entry.leases === 0) nativeReflectApply(nativeMapDelete, entries, [url]);
  }

  function createObjectURL(blob) {
    if (!blobURLSupported) blocked("Native blob URL capability unavailable");
    const url = nativeReflectApply(nativeCreateObjectURL, nativeURL, [blob]);
    if (typeof url !== "string" || url.length === 0) blocked("Native blob URL creation failed");
    if (typeof nativeBlobType !== "function") blocked("Native blob type capability unavailable");
    let mediaType;
    try { mediaType = nativeReflectApply(nativeBlobType, blob, []); }
    catch { blocked("Native blob type capability unavailable"); }
    nativeReflectApply(nativeMapSet, entries, [url, {
      blob,
      leases: 0,
      mediaType,
      revoked: false,
    }]);
    return url;
  }

  function revokeObjectURL(value) {
    if (!blobURLSupported) blocked("Native blob URL capability unavailable");
    const url = NativeString(value);
    nativeReflectApply(nativeRevokeObjectURL, nativeURL, [url]);
    const entry = nativeReflectApply(nativeMapGet, entries, [url]);
    if (!entry) return;
    entry.revoked = true;
    discard(url, entry);
  }

  function capture(value, sourceKind = WorkerSourceKind.workerClassic) {
    const url = NativeString(value);
    const entry = nativeReflectApply(nativeMapGet, entries, [url]);
    if (entry) {
      if (entry.revoked) blocked("Revoked blob executable URL");
      const mediaType = validateBlobType(entry.mediaType, sourceKind);
      entry.leases += 1;
      let released = false;
      return nativeObjectFreeze({
        blob: entry.blob,
        kind: "blob",
        mediaType,
        url,
        release() {
          if (released) return;
          released = true;
          entry.leases -= 1;
          discard(url, entry);
        },
      });
    }
    if (nativeReflectApply(nativeRegExpTest, /^blob:/iu, [url])) {
      blocked("Uncaptured blob executable URL");
    }
    if (nativeReflectApply(nativeRegExpTest, /^data:/iu, [url])) {
      return decodeDataURL(url, sourceKind);
    }
    return nativeObjectFreeze({ kind: "url", url, release() {} });
  }

  return nativeObjectFreeze({
    capture,
    createObjectURL,
    revokeObjectURL,
  });
}

function preflightURLRegistry(global) {
  const URLConstructor = global.URL;
  const create = Object.getOwnPropertyDescriptor(URLConstructor, "createObjectURL");
  const revoke = Object.getOwnPropertyDescriptor(URLConstructor, "revokeObjectURL");
  if (!create?.configurable || !revoke?.configurable) return null;
  return { URLConstructor, create, revoke };
}
function installURLRegistry(global, registry, preflight) {
  Object.defineProperty(preflight.URLConstructor, "createObjectURL", {
    ...preflight.create,
    value: registry.createObjectURL,
  });
  Object.defineProperty(preflight.URLConstructor, "revokeObjectURL", {
    ...preflight.revoke,
    value: registry.revokeObjectURL,
  });
  return () => {
    Object.defineProperty(preflight.URLConstructor, "createObjectURL", preflight.create);
    Object.defineProperty(preflight.URLConstructor, "revokeObjectURL", preflight.revoke);
  };
}

function createLocationFacade(global, targetURL, targetOrigin) {
  const target = parseURL(global, targetURL);
  if (
    target.protocol !== "blob:"
    && target.protocol !== "data:"
    && target.origin !== targetOrigin
  ) {
    blocked("Target worker origin binding mismatch");
  }
  const denied = () => blocked("Worker navigation is blocked");
  return Object.freeze({
    assign: denied,
    get hash() { return target.hash; },
    get host() { return target.host; },
    get hostname() { return target.hostname; },
    get href() { return target.href; },
    get origin() { return targetOrigin; },
    get pathname() { return target.pathname; },
    get port() { return target.port; },
    get protocol() { return target.protocol; },
    get search() { return target.search; },
    replace: denied,
    reload: denied,
    toString() { return target.href; },
  });
}

function classifyNestedWorker(shared, options) {
  const type = options == null ? undefined : Reflect.get(Object(options), "type");
  if (type !== undefined && type !== "classic" && type !== "module") {
    throw new TypeError("Invalid worker type");
  }
  if (shared) {
    return type === "module"
      ? WorkerSourceKind.sharedWorkerModule
      : WorkerSourceKind.sharedWorkerClassic;
  }
  return type === "module"
    ? WorkerSourceKind.workerModule
    : WorkerSourceKind.workerClassic;
}

function mirrorFunctionReflection(facade, native, reflection) {
  for (const key of ["name", "length"]) {
    const descriptor = Object.getOwnPropertyDescriptor(native, key);
    if (descriptor) Object.defineProperty(facade, key, descriptor);
  }
  reflection.sources.set(
    facade,
    Reflect.apply(reflection.toString, native, []),
  );
  return facade;
}

function createDisabledNetworkFacade(name, nativeConstructor, reflection) {
  let facade = function DisabledNetworkConstructor() {
    throw new NativeDOMException(
      `${name} is disabled by ZeroProxy policy`,
      "NotSupportedError",
    );
  };
  Object.setPrototypeOf(facade, Object.getPrototypeOf(nativeConstructor));
  const prototypeDescriptor = Object.getOwnPropertyDescriptor(
    nativeConstructor,
    "prototype",
  );
  if (prototypeDescriptor) {
    Object.defineProperty(facade, "prototype", prototypeDescriptor);
    const constructorDescriptor = Object.getOwnPropertyDescriptor(
      prototypeDescriptor.value,
      "constructor",
    );
    if (!constructorDescriptor?.configurable) {
      blocked(`Native worker ${name} prototype constructor unavailable`);
    }
    Object.defineProperty(prototypeDescriptor.value, "constructor", {
      ...constructorDescriptor,
      configurable: false,
      value: facade,
      writable: false,
    });
  }
  facade = mirrorFunctionReflection(facade, nativeConstructor, reflection);
  return facade;
}

function createDisabledNetworkConstructors(global, reflection) {
  const constructors = new Map();
  const facadeByNative = new Map();
  for (const name of DISABLED_NETWORK_GLOBALS) {
    const nativeConstructor = Reflect.get(global, name, global);
    if (typeof nativeConstructor !== "function") continue;
    const descriptor = Object.getOwnPropertyDescriptor(global, name);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      blocked(`Native worker ${name} descriptor unavailable`);
    }
    let facade = facadeByNative.get(nativeConstructor);
    if (!facade) {
      facade = createDisabledNetworkFacade(name, nativeConstructor, reflection);
      facadeByNative.set(nativeConstructor, facade);
    }
    constructors.set(name, Object.freeze({ descriptor, facade }));
  }
  return constructors;
}

function installDisabledCapabilityMethods(global, constructors, reflection) {
  const records = [];
  for (const definition of DISABLED_CAPABILITY_METHODS) {
    const owner = Reflect.get(global, definition.owner, global);
    const nativeTarget = definition.kind === "static-method"
      ? owner
      : owner?.prototype;
    const target = definition.kind === "static-method"
      ? constructors.get(definition.owner)?.facade ?? owner
      : nativeTarget;
    const descriptor = nativeTarget
      && Object.getOwnPropertyDescriptor(nativeTarget, definition.member);
    if (!target || !descriptor || !Object.hasOwn(descriptor, "value")
      || typeof descriptor.value !== "function") continue;
    const existing = Object.getOwnPropertyDescriptor(target, definition.member);
    if (existing && !existing.configurable) {
      blocked(`Native worker ${definition.label} descriptor unavailable`);
    }
    const facade = mirrorFunctionReflection(
      function DisabledCapabilityMethod() {
        throw new NativeDOMException(
          `${definition.label} is disabled by ZeroProxy policy`,
          "NotSupportedError",
        );
      },
      descriptor.value,
      reflection,
    );
    Object.defineProperty(target, definition.member, {
      ...descriptor,
      configurable: false,
      value: facade,
      writable: false,
    });
    records.push(Object.freeze({
      facade,
      member: definition.member,
      target,
    }));
  }
  return Object.freeze(records);
}

function disabledCapabilityMethodsHealthy(records) {
  return records.every(record => {
    const descriptor = Object.getOwnPropertyDescriptor(record.target, record.member);
    return descriptor?.value === record.facade
      && descriptor.configurable === false
      && descriptor.writable === false;
  });
}

function workerRuntimeHealthy(
  active,
  evalDescriptorsHealthy,
  constructors,
  scopeValues,
  workerGlobalTarget,
  capabilityMethods,
) {
  return active
    && evalDescriptorsHealthy()
    && disabledNetworkConstructorsHealthy(
      constructors,
      scopeValues,
      workerGlobalTarget,
    )
    && disabledCapabilityMethodsHealthy(capabilityMethods);
}

function installDisabledNetworkConstructors(
  constructors,
  scopeValues,
  workerGlobalTarget,
) {
  for (const [name, record] of constructors) {
    const descriptor = {
      ...record.descriptor,
      configurable: false,
      value: record.facade,
      writable: false,
    };
    Object.defineProperty(scopeValues, name, descriptor);
    Object.defineProperty(workerGlobalTarget, name, descriptor);
  }
}

function disabledNetworkConstructorsHealthy(
  constructors,
  scopeValues,
  workerGlobalTarget,
) {
  for (const [name, record] of constructors) {
    const scopeDescriptor = Object.getOwnPropertyDescriptor(scopeValues, name);
    const globalDescriptor = Object.getOwnPropertyDescriptor(workerGlobalTarget, name);
    if (
      scopeDescriptor?.value !== record.facade
      || scopeDescriptor.configurable !== false
      || scopeDescriptor.writable !== false
      || globalDescriptor?.value !== record.facade
      || globalDescriptor.configurable !== false
      || globalDescriptor.writable !== false
      || record.facade.prototype?.constructor !== record.facade
    ) return false;
  }
  return true;
}

function dynamicFunctionSource(sourceKind, parameters, body) {
  const prefix = sourceKind === "AsyncFunctionBody"
    ? "async function"
    : sourceKind === "GeneratorFunctionBody"
      ? "function*"
      : sourceKind === "AsyncGeneratorFunctionBody" ? "async function*" : "function";
  return `${prefix} anonymous(${parameters.join(",")}\n) {\n${body}\n}`;
}

function createDynamicFunctionConstructor(
  compiler,
  abiIdentifier,
  sourceKind,
  native,
  stringCompilationAllowed,
  reflection,
) {
  if (typeof native !== "function") {
    blocked("Dynamic function constructor unavailable");
  }
  const facade = function DynamicFunctionFacade(...arguments_) {
    const converted = arguments_.map(toDynamicSource);
    if (!stringCompilationAllowed) denyStringCompilation();
    const argumentCount = converted.length;
    const body = argumentCount === 0 ? "" : converted.pop();
    const compiled = compileDynamicFunctionSource(
      compiler,
      converted,
      body,
      sourceKind,
      abiIdentifier,
    );
    const invocationArguments = compiled.parameters.map((parameter) => parameter.code);
    if (argumentCount !== 0) invocationArguments.push(compiled.body.code);
    const constructed = new.target
      ? Reflect.construct(native, invocationArguments, new.target)
      : Reflect.apply(native, undefined, invocationArguments);
    if (typeof constructed === "function") {
      reflection.sources.set(constructed, dynamicFunctionSource(sourceKind, converted, body));
    }
    return constructed;
  };
  Object.setPrototypeOf(facade, Object.getPrototypeOf(native));
  const prototypeDescriptor = Object.getOwnPropertyDescriptor(native, "prototype");
  if (prototypeDescriptor) {
    Object.defineProperty(facade, "prototype", prototypeDescriptor);
  }
  return mirrorFunctionReflection(facade, native, reflection);
}

function nativeAsyncFunction(global) {
  return Object.getPrototypeOf(async function () {}).constructor
    || global.Function;
}

function nativeGeneratorFunction(global) {
  return Object.getPrototypeOf(function* () {}).constructor || global.Function;
}

function preflightFunctionConstructors(facades, reflection) {
  const prototypes = [
    [Object.getPrototypeOf(function () {}), facades.Function],
    [Object.getPrototypeOf(async function () {}), facades.AsyncFunction],
    [Object.getPrototypeOf(function* () {}), facades.GeneratorFunction],
    [Object.getPrototypeOf(async function* () {}), facades.AsyncGeneratorFunction],
  ];
  const records = [];
  for (const [prototype, facade] of prototypes) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
    if (!descriptor?.configurable || typeof facade !== "function") {
      blocked("Dynamic constructor hardening cannot be installed atomically");
    }
    records.push({ descriptor, facade, prototype });
  }
  const toStringDescriptor = Object.getOwnPropertyDescriptor(
    reflection.prototype,
    "toString",
  );
  if (
    !toStringDescriptor?.configurable
    || toStringDescriptor.value !== reflection.toString
  ) {
    blocked("Function reflection hardening cannot be installed atomically");
  }
  const safeFunctionToString = mirrorFunctionReflection(
    function safeFunctionToString() {
      return reflection.sources.get(this)
        ?? Reflect.apply(reflection.toString, this, []);
    },
    reflection.toString,
    reflection,
  );
  return {
    constructorRecords: records,
    functionPrototype: reflection.prototype,
    safeFunctionToString,
    toStringDescriptor,
  };
}

function installFunctionConstructors(preflight) {
  const installed = [];
  try {
    Object.defineProperty(
      preflight.functionPrototype,
      "toString",
      { ...preflight.toStringDescriptor, value: preflight.safeFunctionToString },
    );
    for (const record of preflight.constructorRecords) {
      Object.defineProperty(record.prototype, "constructor", {
        ...record.descriptor,
        value: record.facade,
      });
      installed.push(record);
    }
  } catch (error) {
    for (let index = installed.length - 1; index >= 0; index -= 1) {
      const record = installed[index];
      Object.defineProperty(record.prototype, "constructor", record.descriptor);
    }
    Object.defineProperty(
      preflight.functionPrototype,
      "toString",
      preflight.toStringDescriptor,
    );
    throw error;
  }
  return () => {
    for (let index = preflight.constructorRecords.length - 1; index >= 0; index -= 1) {
      const record = preflight.constructorRecords[index];
      Object.defineProperty(record.prototype, "constructor", record.descriptor);
    }
    Object.defineProperty(
      preflight.functionPrototype,
      "toString",
      preflight.toStringDescriptor,
    );
  };
}

function nativeAsyncGeneratorFunction(global) {
  return Object.getPrototypeOf(async function* () {}).constructor || global.Function;
}

function validateRuntimeConfiguration(global, configuration) {
  const {
    abiIdentifier,
    compiler,
    registry,
    routes,
    stringCompilationAllowed,
    sourceKind,
    targetOrigin,
    targetURL,
  } = configuration ?? {};
  if (!isWorkerSourceKind(sourceKind)) blocked("Invalid worker source kind");
  if (typeof abiIdentifier !== "string" || !ABI_IDENTIFIER.test(abiIdentifier)) {
    blocked("Invalid worker ABI identifier");
  }
  if (typeof targetURL !== "string" || typeof targetOrigin !== "string") {
    blocked("Invalid target worker identity");
  }
  if (typeof stringCompilationAllowed !== "boolean") {
    blocked("Invalid worker string compilation policy");
  }
  if (
    Object.prototype.hasOwnProperty.call(global, abiIdentifier)
    || Object.getOwnPropertyDescriptor(global, abiIdentifier)
  ) {
    blocked("Worker ABI identifier collision");
  }
  const evalDescriptor = Object.getOwnPropertyDescriptor(global, "eval");
  if (
    !evalDescriptor
    || !Object.hasOwn(evalDescriptor, "value")
    || typeof evalDescriptor.value !== "function"
    || evalDescriptor.configurable !== true
  ) {
    blocked("Worker eval descriptor unavailable");
  }
  return {
    abiIdentifier,
    compiler,
    evalDescriptor,
    intrinsicEval: evalDescriptor.value,
    registry,
    routes,
    sourceKind,
    stringCompilationAllowed,
    targetOrigin,
    targetURL,
  };
}

function createRuntime(global, configuration) {
  const {
    abiIdentifier,
    compiler,
    evalDescriptor,
    intrinsicEval,
    registry: configuredRegistry,
    routes,
    stringCompilationAllowed,
    sourceKind,
    targetOrigin,
    targetURL,
  } = validateRuntimeConfiguration(global, configuration);
  const registry = configuredRegistry ?? createExecutableSourceRegistry(global);
  const nativeBlobURL = typeof global.URL?.createObjectURL === "function"
    && typeof global.URL?.revokeObjectURL === "function";
  const registryPreflight = configuredRegistry || !nativeBlobURL
    ? null
    : preflightURLRegistry(global);
  const location = createLocationFacade(global, targetURL, targetOrigin);
  const native = Object.freeze({
    caches: global.caches,
    clearInterval: global.clearInterval,
    clearTimeout: global.clearTimeout,
    close: global.close,
    importScripts: global.importScripts,
    indexedDB: global.indexedDB,
    postMessage: global.postMessage,
    queueMicrotask: global.queueMicrotask,
    setInterval: global.setInterval,
    setTimeout: global.setTimeout,
    worker: global.Worker,
    sharedWorker: global.SharedWorker,
    URL: global.URL,
    eval: intrinsicEval,
  });
  let active = true;
  const timers = new Map();
  const abortControllers = new Set();
  const nestedCleanups = new Set();
  let constructorRollback = null;
  let urlRollback = null;

  function assertActive() {
    if (!active) blocked("Worker has terminated");
  }

  function clearTimer(id, nativeClear) {
    timers.delete(id);
    if (typeof nativeClear === "function") Reflect.apply(nativeClear, global, [id]);
  }

  function schedule(kind, handler, delay, arguments_) {
    assertActive();
    const nativeTimer = kind === "interval" ? native.setInterval : native.setTimeout;
    if (typeof nativeTimer !== "function") blocked("Native timer unavailable");
    let callback = handler;
    if (typeof handler !== "function") {
      const source = String(handler);
      if (!stringCompilationAllowed) denyStringCompilation();
      callback = compileSource(compiler, source, "TimerString", abiIdentifier).code;
    }
    let id;
    if (typeof callback === "function") {
      id = Reflect.apply(nativeTimer, global, [function timerCallback(...callbackArguments) {
        if (kind === "timeout") timers.delete(id);
        if (!active) return;
        return Reflect.apply(callback, global, callbackArguments);
      }, delay, ...arguments_]);
    } else {
      id = Reflect.apply(nativeTimer, global, [callback, delay, ...arguments_]);
    }
    timers.set(id, kind);
    return id;
  }

  function controlledFetch(...arguments_) {
    assertActive();
    const controller = new AbortController();
    abortControllers.add(controller);
    let result;
    try {
      result = requireRoute(routes, "fetch")(
        Object.freeze({
          arguments: arguments_,
          signal: controller.signal,
          sourceKind,
          targetOrigin,
          targetURL,
        }),
      );
    } catch {
      abortControllers.delete(controller);
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    return Promise.resolve(result).finally(() => abortControllers.delete(controller));
  }

  function controlledPostMessage(...arguments_) {
    assertActive();
    const allow = requireRoute(routes, "message")(
      Object.freeze({
        arguments: arguments_,
        sourceKind,
        targetOrigin,
        targetURL,
      }),
    );
    if (allow !== true || typeof native.postMessage !== "function") {
      blocked("Worker message rejected");
    }
    return Reflect.apply(native.postMessage, global, arguments_);
  }

  function controlledImportScripts(...arguments_) {
    assertActive();
    if (isModuleWorkerSourceKind(sourceKind)) blocked("importScripts is unavailable in module workers");
    if (typeof native.importScripts !== "function") blocked("Native importScripts unavailable");
    const route = requireRoute(routes, "classic");
    for (const rawURL of arguments_) {
      const plan = assertControlledRoute(route(Object.freeze({
        rawURL: String(rawURL),
        sourceKind,
        targetOrigin,
        targetURL,
      })), "Controlled classic worker route rejected");
      Reflect.apply(native.importScripts, global, [plan.url]);
    }
  }

  function importModuleFrom(referrerURL, specifier, options) {
    return Promise.resolve().then(async () => {
      assertActive();
      const plan = assertControlledRoute(await requireRoute(routes, "module")(
        Object.freeze({
          options,
          sourceKind,
          specifier: String(specifier),
          targetOrigin,
          targetURL: referrerURL,
        }),
      ), "Controlled module worker route rejected");
      assertActive();
      return import(plan.url, options);
    });
  }

  function importModule(specifier, options) {
    return importModuleFrom(targetURL, specifier, options);
  }

  function controlledWorker(shared, input, options, hasOptions) {
    assertActive();
    const nestedSourceKind = classifyNestedWorker(shared, options);
    const executable = registry.capture(input, nestedSourceKind);
    let plan;
    try {
      const compiled = executable.kind === "data"
        ? compileSource(compiler, executable.source, nestedSourceKind, abiIdentifier)
        : null;
      plan = assertControlledRoute(requireRoute(routes, "worker")(
        Object.freeze({
          compiled,
          executable,
          sourceKind: nestedSourceKind,
          targetOrigin,
          targetURL,
        }),
      ), "Controlled nested worker route rejected");
      const NativeConstructor = shared ? native.sharedWorker : native.worker;
      if (typeof NativeConstructor !== "function") blocked("Native worker constructor unavailable");
      const instance = Reflect.construct(NativeConstructor, hasOptions ? [plan.url, options] : [plan.url]);
      return wrapNestedWorker(instance, executable.release, shared);
    } catch (error) {
      executable.release();
      throw error;
    }
  }

  function wrapNestedWorker(instance, release, shared) {
    let released = false;
    let portFacade;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      nestedCleanups.delete(teardown);
      release();
    };
    const teardown = () => {
      releaseOnce();
      try {
        if (shared) {
          const port = Reflect.get(instance, "port", instance);
          const close = Reflect.get(port, "close", port);
          if (typeof close === "function") Reflect.apply(close, port, []);
        } else {
          const terminate = Reflect.get(instance, "terminate", instance);
          if (typeof terminate === "function") Reflect.apply(terminate, instance, []);
        }
      } catch {
        // Lease release has already happened; native child cleanup is best effort.
      }
    };
    nestedCleanups.add(teardown);
    return new Proxy(instance, {
      get(target, key) {
        if (!shared && key === "terminate") {
          const terminate = Reflect.get(target, key, target);
          return (...arguments_) => {
            releaseOnce();
            return Reflect.apply(terminate, target, arguments_);
          };
        }
        if (shared && key === "port") {
          if (portFacade) return portFacade;
          const port = Reflect.get(target, key, target);
          portFacade = new Proxy(port, {
            get(portTarget, portKey) {
              if (portKey === "close") {
                const close = Reflect.get(portTarget, portKey, portTarget);
                return (...arguments_) => {
                  releaseOnce();
                  return Reflect.apply(close, portTarget, arguments_);
                };
              }
              const value = Reflect.get(portTarget, portKey, portTarget);
              return typeof value === "function" ? value.bind(portTarget) : value;
            },
          });
          return portFacade;
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  function terminateResources() {
    for (const [id, kind] of timers)
      clearTimer(id, kind === "interval" ? native.clearInterval : native.clearTimeout);
    for (const controller of abortControllers) controller.abort();
    abortControllers.clear();
    for (const cleanup of [...nestedCleanups]) cleanup();
  }

  function closeNativeRealm() {
    try {
      constructorRollback?.();
    } catch {
      // Prototype tampering cannot prevent native realm closure.
    } finally {
      constructorRollback = null;
    }
    try {
      urlRollback?.();
    } catch {
      // URL facade tampering cannot prevent native realm closure.
    } finally {
      urlRollback = null;
    }
    try {
      if (typeof native.close === "function") Reflect.apply(native.close, global, []);
    } catch {
      // The native realm is already closing or closed.
    }
  }

  function terminate() {
    if (!active) return;
    active = false;
    terminateResources();
    try {
      if (typeof routes?.terminate === "function")
        routes.terminate(Object.freeze({ sourceKind, targetOrigin, targetURL }));
    } finally {
      closeNativeRealm();
    }
  }

  const functionPrototype = Object.getPrototypeOf(function () {});
  const functionToStringDescriptor = Object.getOwnPropertyDescriptor(
    functionPrototype,
    "toString",
  );
  if (
    !functionToStringDescriptor
    || !Object.hasOwn(functionToStringDescriptor, "value")
    || typeof functionToStringDescriptor.value !== "function"
    || functionToStringDescriptor.configurable !== true
  ) {
    blocked("Worker Function reflection descriptor unavailable");
  }
  const functionReflection = {
    prototype: functionPrototype,
    sources: new WeakMap(),
    toString: functionToStringDescriptor.value,
  };
  const indirectEval = mirrorFunctionReflection(function evalFacade(value) {
    if (typeof value !== "string") return value;
    if (!stringCompilationAllowed) denyStringCompilation();
    return Reflect.apply(
      intrinsicEval,
      global,
      [compileSource(compiler, value, "IndirectEvalScript", abiIdentifier).code],
    );
  }, intrinsicEval, functionReflection);
  const unsupported = () => blocked("Worker network API is unsupported");
  const disabledNetworkConstructors = createDisabledNetworkConstructors(
    global,
    functionReflection,
  );
  const disabledCapabilityMethods = installDisabledCapabilityMethods(
    global,
    disabledNetworkConstructors,
    functionReflection,
  );
  const internalCachePrefix = "__zeroproxy_internal_";
  function internalCacheName(value) {
    return String(value).startsWith(internalCachePrefix);
  }
  function requiredWorkerStorage(value, label) {
    if (sourceKind === WorkerSourceKind.workletModule) return undefined;
    if (value === undefined || value === null) blocked(`Native worker ${label} unavailable`);
    return value;
  }
  async function publicWorkerCacheStorageMatch(cacheMethods, storageReceiver, requestValue, options) {
    const cacheName = options === undefined || options === null
      ? undefined
      : Reflect.get(options, "cacheName");
    if (cacheName !== undefined) {
      if (internalCacheName(cacheName)) return undefined;
      return Reflect.apply(cacheMethods.match, storageReceiver, [
        requestValue,
        { ...options, cacheName: String(cacheName) },
      ]);
    }
    const names = await Reflect.apply(cacheMethods.keys, storageReceiver, []);
    for (const name of names) {
      if (internalCacheName(name)) continue;
      const cache = await Reflect.apply(cacheMethods.open, storageReceiver, [name]);
      const result = await Reflect.apply(Reflect.get(cache, "match", cache), cache, [requestValue, options]);
      if (result !== undefined) return result;
    }
    return undefined;
  }
  function publicWorkerCacheStorage(storage) {
    if (storage === undefined) return undefined;
    const cacheMethods = Object.freeze({
      delete: Reflect.get(storage, "delete", storage),
      has: Reflect.get(storage, "has", storage),
      keys: Reflect.get(storage, "keys", storage),
      match: Reflect.get(storage, "match", storage),
      open: Reflect.get(storage, "open", storage),
    });
    if (Object.values(cacheMethods).some(method => typeof method !== "function")) {
      blocked("Native worker CacheStorage methods unavailable");
    }
    let facade;
    const receiver = value => value === facade ? storage : value;
    const methods = Object.create(null);
    methods.open = function open(name) {
      const normalized = String(name);
      if (internalCacheName(normalized)) return Promise.reject(securityError("Reserved cache name"));
      return Reflect.apply(cacheMethods.open, receiver(this), [normalized]);
    };
    methods.delete = function delete_(name) {
      const normalized = String(name);
      if (internalCacheName(normalized)) return Promise.resolve(false);
      return Reflect.apply(cacheMethods.delete, receiver(this), [normalized]);
    };
    methods.has = function has(name) {
      const normalized = String(name);
      if (internalCacheName(normalized)) return Promise.resolve(false);
      return Reflect.apply(cacheMethods.has, receiver(this), [normalized]);
    };
    methods.keys = async function keys() {
      const names = await Reflect.apply(cacheMethods.keys, receiver(this), []);
      return names.filter(name => !internalCacheName(name));
    };
    methods.match = function match(requestValue, options) {
      return publicWorkerCacheStorageMatch(cacheMethods, receiver(this), requestValue, options);
    };
    facade = new Proxy(storage, {
      get(target, key) {
        if (Object.hasOwn(methods, key)) return methods[key];
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return facade;
  }
  const workerIndexedDB = requiredWorkerStorage(native.indexedDB, "IndexedDB");
  const workerCaches = publicWorkerCacheStorage(requiredWorkerStorage(native.caches, "CacheStorage"));
  const functionFacade = createDynamicFunctionConstructor(
    compiler,
    abiIdentifier,
    "FunctionBody",
    global.Function,
    stringCompilationAllowed,
    functionReflection,
  );
  const scopeValues = Object.create(null);
  const protectedFacadeEvalDescriptor = {
    ...evalDescriptor,
    configurable: false,
    value: indirectEval,
    writable: false,
  };
  Object.defineProperty(scopeValues, "eval", protectedFacadeEvalDescriptor);
  const scope = new Proxy(scopeValues, {
    get(_target, key) {
      if (key === "onmessage" || key === "onmessageerror" || key === "onconnect") {
        return Reflect.get(global, key, global);
      }
      if (key in scopeValues) return scopeValues[key];
      return undefined;
    },
    set(_target, key, value) {
      if (key === "onmessage" || key === "onmessageerror" || key === "onconnect") {
        Reflect.set(global, key, value, global);
        return true;
      }
      return false;
    },
  });
  const workerGlobalTarget = Object.create(null);
  Object.defineProperty(workerGlobalTarget, "eval", protectedFacadeEvalDescriptor);
  const workerGlobal = new Proxy(workerGlobalTarget, {
    get(_target, key) {
      if (key === abiIdentifier || key === "constructor" || key === "__proto__") return undefined;
      if (key === "onmessage" || key === "onmessageerror" || key === "onconnect") {
        return Reflect.get(global, key, global);
      }
      if (key in scopeValues) return scopeValues[key];
      const value = Reflect.get(global, key, global);
      return typeof value === "function" ? value.bind(global) : value;
    },
    set(_target, key, value) {
      if (key === abiIdentifier) return false;
      return Reflect.set(global, key, value, global);
    },
    getPrototypeOf() { return null; },
  });

  function protectedEvalDescriptorMatches(descriptor, value) {
    return descriptor
      && Object.hasOwn(descriptor, "value")
      && descriptor.value === value
      && descriptor.writable === false
      && descriptor.configurable === false
      && descriptor.enumerable === evalDescriptor.enumerable;
  }

  function evalDescriptorsHealthy() {
    return protectedEvalDescriptorMatches(
      Object.getOwnPropertyDescriptor(global, "eval"),
      intrinsicEval,
    )
      && protectedEvalDescriptorMatches(
        Object.getOwnPropertyDescriptor(scopeValues, "eval"),
        indirectEval,
      )
      && protectedEvalDescriptorMatches(
        Object.getOwnPropertyDescriptor(workerGlobalTarget, "eval"),
        indirectEval,
      );
  }

  function moduleMeta(referrerURL) {
    return Object.freeze({
      resolve(specifier) {
        return new native.URL(String(specifier), referrerURL).href;
      },
      url: referrerURL,
    });
  }

  const moduleContexts = new WeakMap();
  function moduleContext(nativeMeta, referrerURL) {
    if (
      nativeMeta === null
      || (typeof nativeMeta !== "object" && typeof nativeMeta !== "function")
      || typeof referrerURL !== "string"
    ) {
      blocked("Invalid native module context");
    }
    const existing = moduleContexts.get(nativeMeta);
    if (existing) {
      if (existing.referrerURL !== referrerURL) blocked("Module context identity mismatch");
      return existing.context;
    }
    const context = Object.freeze({
      ...abi,
      importMeta: moduleMeta(referrerURL),
      importModule(specifier, options) {
        return importModuleFrom(referrerURL, specifier, options);
      },
    });
    moduleContexts.set(nativeMeta, Object.freeze({ context, referrerURL }));
    return context;
  }

  Object.assign(scopeValues, {
    AsyncFunction: createDynamicFunctionConstructor(
      compiler,
      abiIdentifier,
      "AsyncFunctionBody",
      nativeAsyncFunction(global),
      stringCompilationAllowed,
      functionReflection,
    ),
    AsyncGeneratorFunction: createDynamicFunctionConstructor(
      compiler,
      abiIdentifier,
      "AsyncGeneratorFunctionBody",
      nativeAsyncGeneratorFunction(global),
      stringCompilationAllowed,
      functionReflection,
    ),
    EventSource: unsupported,
    Function: functionFacade,
    GeneratorFunction: createDynamicFunctionConstructor(
      compiler,
      abiIdentifier,
      "GeneratorFunctionBody",
      nativeGeneratorFunction(global),
      stringCompilationAllowed,
      functionReflection,
    ),
    SharedWorker: function SharedWorkerFacade(input, options) {
      return controlledWorker(true, input, options, arguments.length > 1);
    },
    WebSocket: unsupported,
    WebSocketStream: unsupported,
    Worker: function WorkerFacade(input, options) {
      return controlledWorker(false, input, options, arguments.length > 1);
    },
    XMLHttpRequest: unsupported,
    caches: workerCaches,
    clearInterval(id) { clearTimer(id, native.clearInterval); },
    clearTimeout(id) { clearTimer(id, native.clearTimeout); },
    close: terminate,
    document: undefined,
    fetch: controlledFetch,
    frames: undefined,
    globalThis: workerGlobal,
    history: undefined,
    importMeta: moduleMeta(targetURL),
    importModule,
    importScripts: controlledImportScripts,
    indexedDB: workerIndexedDB,
    localStorage: undefined,
    location,
    opener: undefined,
    postMessage: controlledPostMessage,
    queueMicrotask(callback) {
      assertActive();
      if (typeof native.queueMicrotask !== "function") blocked("Native queueMicrotask unavailable");
      return Reflect.apply(native.queueMicrotask, global, [() => {
        if (active) Reflect.apply(callback, global, []);
      }]);
    },
    self: workerGlobal,
    sessionStorage: undefined,
    setInterval(handler, delay, ...arguments_) {
      return schedule("interval", handler, delay, arguments_);
    },
    setTimeout(handler, delay, ...arguments_) {
      return schedule("timeout", handler, delay, arguments_);
    },
    thisValue(value) {
      return value === global ? workerGlobal : value;
    },
    top: undefined,
    window: undefined,
  });
  installDisabledNetworkConstructors(
    disabledNetworkConstructors,
    scopeValues,
    workerGlobalTarget,
  );
  const constructorRecords = preflightFunctionConstructors({
    AsyncFunction: scopeValues.AsyncFunction,
    AsyncGeneratorFunction: scopeValues.AsyncGeneratorFunction,
    Function: scopeValues.Function,
    GeneratorFunction: scopeValues.GeneratorFunction,
  }, functionReflection);
  const abi = Object.freeze({
    evalSource(value, metadata) {
      if (typeof value !== "string") return value;
      if (!stringCompilationAllowed) denyStringCompilation();
      return compileSource(compiler, value, "DirectEvalScript", abiIdentifier, metadata).code;
    },
    importModule,
    moduleContext,
    scope,
    thisValue: scopeValues.thisValue,
    runtimeHealth() {
      return workerRuntimeHealthy(
        active,
        evalDescriptorsHealthy,
        disabledNetworkConstructors,
        scopeValues,
        workerGlobalTarget,
        disabledCapabilityMethods,
      );
    },
  });
  try {
    if (registryPreflight) urlRollback = installURLRegistry(global, registry, registryPreflight);
    constructorRollback = installFunctionConstructors(constructorRecords);
    Object.defineProperty(global, abiIdentifier, {
      configurable: false,
      enumerable: false,
      value: abi,
      writable: false,
    });
    Object.defineProperty(global, "eval", {
      ...evalDescriptor,
      configurable: false,
      value: intrinsicEval,
      writable: false,
    });
    if (!evalDescriptorsHealthy()) blocked("Worker eval hardening failed");
  } catch (error) {
    constructorRollback?.();
    constructorRollback = null;
    urlRollback?.();
    urlRollback = null;
    throw error;
  }

  return Object.freeze({
    executeClassic(source, rootPrecompiled = false) {
      try {
        assertActive();
        if (isModuleWorkerSourceKind(sourceKind)) blocked("Classic target in module worker");
        if (rootPrecompiled !== true && rootPrecompiled !== false) blocked("Invalid classic root execution contract");
        const context = {
          root_precompiled: rootPrecompiled,
          sourceKind,
          targetOrigin,
          targetURL,
        };
        if (!rootPrecompiled) context.compiled = compileSource(compiler, source, sourceKind, abiIdentifier);
        const plan = assertControlledRoute(requireRoute(routes, "classicRoot")(
          Object.freeze(context),
        ), "Controlled classic target route rejected");
        assertActive();
        if (typeof native.importScripts !== "function") blocked("Native importScripts unavailable");
        Reflect.apply(native.importScripts, global, [plan.url]);
      } catch (error) {
        terminate();
        throw error;
      }
    },
    async executeModule(source, rootPrecompiled = false) {
      try {
        assertActive();
        if (!isModuleWorkerSourceKind(sourceKind)) blocked("Module target in classic worker");
        if (rootPrecompiled !== true && rootPrecompiled !== false) blocked("Invalid module root execution contract");
        const context = {
          root_precompiled: rootPrecompiled,
          sourceKind,
          targetOrigin,
          targetURL,
        };
        if (!rootPrecompiled) context.compiled = compileSource(compiler, source, sourceKind, abiIdentifier);
        const plan = assertControlledRoute(await requireRoute(routes, "moduleRoot")(
          Object.freeze(context),
        ), "Controlled module target route rejected");
        assertActive();
        return await import(plan.url);
      } catch (error) {
        terminate();
        throw error;
      }
    },
    get active() { return active; },
    get location() { return location; },
    get origin() { return targetOrigin; },
    registry,
    scope,
    terminate,
  });
}

export function installWorkerRuntime(configuration) {
  const global = configuration?.global ?? globalThis;
  if (!global || (typeof global !== "object" && typeof global !== "function")) {
    blocked("Worker global unavailable");
  }
  return createRuntime(global, configuration);
}

export const WorkerBootstrapProtocol = Object.freeze({
  initialize: "ZERO_PROXY_WORKER_INITIALIZE_V2",
  port: "ZERO_PROXY_WORKER_PORT_V2",
  portReady: "ZERO_PROXY_WORKER_PORT_READY_V2",
  ready: "ZERO_PROXY_WORKER_READY_V2",
  rejected: "ZERO_PROXY_WORKER_REJECTED_V2",
  version: 2,
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMessagePort(value) {
  return value
    && typeof value === "object"
    && typeof value.addEventListener === "function"
    && typeof value.postMessage === "function"
    && typeof value.start === "function"
    && typeof value.close === "function";
}

function bootstrapError() {
  return securityError("Worker bootstrap rejected");
}

/**
 * Creates a realm-local, port-gated target-worker bootstrap.
 *
 * Dedicated Worker, module Worker, and worklet hosts first transfer exactly
 * one MessagePort in a global message
 * `{v: 2, operation: WorkerBootstrapProtocol.port}`. SharedWorker hosts use
 * the one native `connect` event port instead. In both cases, the first port
 * message must be `{v: 2, operation: WorkerBootstrapProtocol.initialize,
 * sequence: 0, source_kind, source}`. Runtime capabilities are intentionally
 * never sent through that message: `createRuntimeConfiguration` supplies
 * compiler and controlled route functions in the worker realm.
 *
 * @param {{
 *   createRuntimeConfiguration: (initialization: object, port: MessagePort) => object | Promise<object>,
 *   global?: object,
 *   installRuntime?: typeof installWorkerRuntime,
 *   sourceKind: string,
 * }} options
 * @returns {{dispose: () => void, readonly ready: Promise<object>, readonly runtime: object | null, readonly state: string}}
 */
export function createPortInitializedWorkerBootstrap(options) {
  const rawOptions = options ?? {};
  if (
    !isRecord(rawOptions)
    || [
      "abiIdentifier",
      "compiler",
      "routes",
      "source",
      "targetOrigin",
      "targetURL",
    ].some((key) => Object.prototype.hasOwnProperty.call(rawOptions, key))
  ) {
    blocked("Direct worker initialization is forbidden");
  }
  const {
    createRuntimeConfiguration,
    global = globalThis,
    installRuntime = installWorkerRuntime,
    sourceKind,
  } = rawOptions;
  if (
    !isWorkerSourceKind(sourceKind)
    || typeof createRuntimeConfiguration !== "function"
    || typeof installRuntime !== "function"
    || !global
    || typeof global.addEventListener !== "function"
    || typeof global.removeEventListener !== "function"
  ) {
    blocked("Invalid worker bootstrap factory");
  }
  const transportEvent = (
    sourceKind === WorkerSourceKind.sharedWorkerClassic
    || sourceKind === WorkerSourceKind.sharedWorkerModule
  ) ? "connect" : "message";
  const sharedTransport = transportEvent === "connect";
  const nativeDispatchEvent = sharedTransport ? global.dispatchEvent : null;
  const NativeMessageEvent = sharedTransport ? global.MessageEvent : null;
  if (sharedTransport && (typeof nativeDispatchEvent !== "function" || typeof NativeMessageEvent !== "function")) {
    blocked("Shared worker connection transport unavailable");
  }

  let controlPort = null;
  let currentRuntime = null;
  let state = "AWAITING_PORT";
  let settled = false;
  const pendingSharedPorts = [];
  let dispatchingSharedConnection = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  function postControl(message) {
    try {
      controlPort?.postMessage(message);
    } catch {
      // A disconnected control port cannot reopen a failed bootstrap.
    }
  }

  function dispatchSharedConnection(port) {
    const event = new NativeMessageEvent("connect", { ports: [port] });
    dispatchingSharedConnection = true;
    try {
      Reflect.apply(nativeDispatchEvent, global, [event]);
    } finally {
      dispatchingSharedConnection = false;
    }
  }

  function closeRealm() {
    try {
      currentRuntime?.terminate();
    } catch {
      // Termination is best effort after the fail-closed state has committed.
    }
    try {
      controlPort?.close();
    } catch {
      // Same as native Worker teardown.
    }
    try {
      if (typeof global.close === "function") global.close();
    } catch {
      // No target code can execute after a failed bootstrap regardless.
    }
  }

  function rejectBootstrap() {
    if (settled) return;
    settled = true;
    state = "REJECTED";
    global.removeEventListener(transportEvent, receivePort);
    postControl(Object.freeze({
      operation: WorkerBootstrapProtocol.rejected,
      v: WorkerBootstrapProtocol.version,
    }));
    closeRealm();
    rejectReady(bootstrapError());
  }

  const allowedInitializationKeys = Object.freeze([
    "abi_identifier", "bootstrap", "operation", "root_precompiled", "sequence",
    "source", "source_kind", "string_compilation_allowed", "target_origin",
    "target_url", "v", "worker_abi_identifier",
  ]);

  function validInitialization(event, initialization) {
    if (settled || (event?.ports?.length ?? 0) !== 0 || !isRecord(initialization)) return false;
    if (Object.keys(initialization).some(key => !allowedInitializationKeys.includes(key))) return false;
    if (initialization.v !== WorkerBootstrapProtocol.version
      || initialization.operation !== WorkerBootstrapProtocol.initialize
      || initialization.sequence !== 0
      || initialization.source_kind !== sourceKind
      || initialization.root_precompiled !== true) return false;
    if (typeof initialization.string_compilation_allowed !== "boolean") return false;
    if (!ABI_IDENTIFIER.test(initialization.worker_abi_identifier)) return false;
    if ("abi_identifier" in initialization
      && initialization.abi_identifier !== initialization.worker_abi_identifier) return false;
    return typeof initialization.source === "string"
      && typeof initialization.target_origin === "string"
      && typeof initialization.target_url === "string";
  }

  async function createInitializedRuntime(initialization) {
    const supplied = await createRuntimeConfiguration(Object.freeze({
      bootstrap: initialization.bootstrap,
      rootPrecompiled: initialization.root_precompiled,
      source: initialization.source,
      sourceKind,
      stringCompilationAllowed: initialization.string_compilation_allowed,
      targetOrigin: initialization.target_origin,
      targetURL: initialization.target_url,
      worker_abi_identifier: initialization.worker_abi_identifier,
    }), controlPort);
    if (!isRecord(supplied)) throw bootstrapError();
    const runtimeConfiguration = {
      ...supplied,
      global,
      sourceKind,
      targetOrigin: initialization.target_origin,
      stringCompilationAllowed: initialization.string_compilation_allowed,
      targetURL: initialization.target_url,
    };
    if (runtimeConfiguration.abiIdentifier !== initialization.worker_abi_identifier
      || runtimeConfiguration.targetOrigin !== initialization.target_origin
      || runtimeConfiguration.targetURL !== initialization.target_url) throw bootstrapError();
    return installRuntime(runtimeConfiguration);
  }

  async function executeInitializedRuntime(initialization) {
    currentRuntime = await createInitializedRuntime(initialization);
    if (isModuleWorkerSourceKind(sourceKind))
      await currentRuntime.executeModule(initialization.source, initialization.root_precompiled);
    else
      currentRuntime.executeClassic(initialization.source, initialization.root_precompiled);
  }

  function publishReady() {
    settled = true;
    state = "READY";
    postControl(Object.freeze({
      operation: WorkerBootstrapProtocol.ready,
      source_kind: sourceKind,
      v: WorkerBootstrapProtocol.version,
    }));
    resolveReady(currentRuntime);
    if (!sharedTransport) return;
    dispatchSharedConnection(controlPort);
    for (const port of pendingSharedPorts.splice(0)) dispatchSharedConnection(port);
  }

  async function initialize(event) {
    const initialization = event?.data;
    if (!validInitialization(event, initialization)) {
      rejectBootstrap();
      return;
    }
    state = "INITIALIZING";
    try {
      await executeInitializedRuntime(initialization);
      if (settled) {
        currentRuntime.terminate();
        return;
      }
      publishReady();
    } catch {
      rejectBootstrap();
    }
  }

  function offeredMessagePort(event) {
    return event?.ports?.length === 1 && isMessagePort(event.ports[0])
      ? event.ports[0]
      : null;
  }

  function queueSharedPort(port) {
    if (!sharedTransport || port === null) return false;
    if (state === "READY") {
      dispatchSharedConnection(port);
      return true;
    }
    if (state === "AWAITING_PORT" || state === "REJECTED" || state === "DISPOSED") return false;
    pendingSharedPorts.push(port);
    return true;
  }

  function validPortOffer(offer, port) {
    if (settled || state !== "AWAITING_PORT" || port === null) return false;
    return sharedTransport
      || (isRecord(offer)
        && offer.v === WorkerBootstrapProtocol.version
        && offer.operation === WorkerBootstrapProtocol.port);
  }

  function acceptControlPort(port) {
    controlPort = port;
    state = "AWAITING_INITIALIZATION";
    if (!sharedTransport) global.removeEventListener(transportEvent, receivePort);
    controlPort.addEventListener("message", initialize, { once: true });
    controlPort.start();
    postControl(Object.freeze({
      operation: WorkerBootstrapProtocol.portReady,
      source_kind: sourceKind,
      v: WorkerBootstrapProtocol.version,
    }));
  }

  function receivePort(event) {
    if (dispatchingSharedConnection) return;
    const port = offeredMessagePort(event);
    if (queueSharedPort(port)) return;
    if (!validPortOffer(event?.data, port)) return;
    acceptControlPort(port);
  }

  global.addEventListener(transportEvent, receivePort);
  return Object.freeze({
    dispose() {
      if (state === "READY") {
        state = "DISPOSED";
        global.removeEventListener(transportEvent, receivePort);
        closeRealm();
        return;
      }
      rejectBootstrap();
    },
    get ready() { return ready; },
    get runtime() { return currentRuntime; },
    get state() { return state; },
  });
}
