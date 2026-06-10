import { WEBAPI_CORE_SOURCE } from './core-source.generated.mjs';

const URL_PARTS = new Set(['protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']);
const HOST_DOMPARSER_TYPES = new Set([
  'text/html',
  'text/xml',
  'application/xml',
  'application/xhtml+xml',
  'image/svg+xml',
]);

const HOST_WEB_API_BRIDGE_DEFINITIONS = Object.freeze({
  BluetoothUUID: Object.freeze({
    staticMethods: Object.freeze(['canonicalUUID', 'getService', 'getCharacteristic', 'getDescriptor']),
  }),
  CSS: Object.freeze({
    kind: 'namespace',
    staticMethods: Object.freeze(['escape', 'supports']),
  }),
  atob: Object.freeze({
    browserOnly: true,
    kind: 'globalFunction',
  }),
  btoa: Object.freeze({
    browserOnly: true,
    kind: 'globalFunction',
  }),
  RTCError: Object.freeze({
    browserOnly: true,
    autoFacade: true,
    baseClass: 'DOMException',
    constructFields: Object.freeze(['name', 'message', 'code', 'errorDetail', 'sdpLineNumber', 'httpRequestStatusCode', 'sctpCauseCode', 'receivedAlert', 'sentAlert']),
    prototypeGetters: Object.freeze(['errorDetail', 'sdpLineNumber', 'httpRequestStatusCode', 'sctpCauseCode', 'receivedAlert', 'sentAlert']),
  }),
  RTCIceCandidate: Object.freeze({
    browserOnly: true,
    autoFacade: true,
    constructFields: Object.freeze(['candidate', 'sdpMid', 'sdpMLineIndex', 'foundation', 'component', 'priority', 'address', 'protocol', 'port', 'type', 'tcpType', 'relatedAddress', 'relatedPort', 'usernameFragment', 'relayProtocol', 'url']),
    prototypeGetters: Object.freeze(['candidate', 'sdpMid', 'sdpMLineIndex', 'foundation', 'component', 'priority', 'address', 'protocol', 'port', 'type', 'tcpType', 'relatedAddress', 'relatedPort', 'usernameFragment', 'relayProtocol', 'url']),
    prototypeMethods: Object.freeze(['toJSON']),
  }),
  RTCSessionDescription: Object.freeze({
    browserOnly: true,
    autoFacade: true,
    constructFields: Object.freeze(['type', 'sdp']),
    prototypeGetters: Object.freeze(['type', 'sdp']),
    prototypeSetters: Object.freeze(['type', 'sdp']),
    prototypeMethods: Object.freeze(['toJSON']),
  }),
  TextDecoder: Object.freeze({
    browserOnly: true,
    constructFields: Object.freeze(['encoding', 'fatal', 'ignoreBOM']),
    prototypeMethods: Object.freeze(['decode']),
    methodArgTransforms: Object.freeze({
      decode: Object.freeze(['uint8array']),
    }),
  }),
  TextEncoder: Object.freeze({
    browserOnly: true,
    constructFields: Object.freeze(['encoding']),
    prototypeMethods: Object.freeze(['encode', 'encodeInto']),
    methodArgTransforms: Object.freeze({
      encodeInto: Object.freeze([null, 'uint8array']),
    }),
    methodMutatedArgs: Object.freeze({
      encodeInto: Object.freeze([1]),
    }),
  }),
  URLPattern: Object.freeze({
    browserOnly: true,
    constructFields: Object.freeze(['protocol', 'username', 'password', 'hostname', 'port', 'pathname', 'search', 'hash', 'hasRegExpGroups']),
    prototypeMethods: Object.freeze(['test', 'exec']),
  }),
  WebSocketError: Object.freeze({
    browserOnly: true,
    autoFacade: true,
    baseClass: 'DOMException',
    constructFields: Object.freeze(['name', 'message', 'code', 'closeCode', 'reason']),
    prototypeGetters: Object.freeze(['closeCode', 'reason']),
  }),
});

const HOST_REFLECTION_EXCLUDED_GLOBALS = new Set([
  'AggregateError',
  'Array',
  'ArrayBuffer',
  'Atomics',
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
  'Boolean',
  'DataView',
  'Date',
  'Error',
  'EvalError',
  'FinalizationRegistry',
  'Float32Array',
  'Float64Array',
  'Function',
  'Infinity',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'Intl',
  'Iterator',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'Proxy',
  'RangeError',
  'ReferenceError',
  'Reflect',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'SyntaxError',
  'TypeError',
  'URIError',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'WeakMap',
  'WeakRef',
  'WeakSet',
]);




export function installWebAPICore(options = {}) {
  const { realm } = options;
  if (!realm) throw new TypeError('QuickJS realm is required');
  const storage = options.storage || {};
  const storageManager = storage.manager || null;
  const storagePartition = storage.partitionKey || storage.partition || '';
  realm.defineHostFunction('__zpRandomBytes', (length) => randomBytes(Number(length || 0)));
  realm.defineHostFunction('__zpStorageSet', (area, key, value) => {
    storageManager?.setItem?.(storagePartition, String(area), String(key), String(value));
    return null;
  });
  realm.defineHostFunction('__zpStorageRemove', (area, key) => {
    storageManager?.removeItem?.(storagePartition, String(area), String(key));
    return null;
  });
  realm.defineHostFunction('__zpStorageClear', (area) => {
    storageManager?.clear?.(storagePartition, String(area));
    return null;
  });
  realm.defineHostFunction('__zpIndexedDBPut', (name, snapshotJSON) => {
    const task = storageManager?.putIndexedDBDatabase?.(storagePartition, String(name), JSON.parse(String(snapshotJSON || '{}')));
    storageManager?.track?.(task);
    return null;
  });
  realm.defineHostFunction('__zpIndexedDBDelete', (name) => {
    const task = storageManager?.deleteIndexedDBDatabase?.(storagePartition, String(name));
    storageManager?.track?.(task);
    return null;
  });
  realm.defineHostFunction('__zpCachePut', (cacheName, requestJSON, responseJSON) => {
    const task = storageManager?.putCacheAPIEntry?.(storagePartition, String(cacheName), JSON.parse(String(requestJSON || '{}')), JSON.parse(String(responseJSON || '{}')));
    storageManager?.track?.(task);
    return null;
  });
  realm.defineHostFunction('__zpCacheDelete', (cacheName, requestJSON) => {
    const task = storageManager?.deleteCacheAPIEntry?.(storagePartition, String(cacheName), JSON.parse(String(requestJSON || '{}')));
    storageManager?.track?.(task);
    return null;
  });
  realm.defineHostFunction('__zpCacheClear', (cacheName) => {
    const task = storageManager?.deleteCacheAPI?.(storagePartition, String(cacheName));
    storageManager?.track?.(task);
    return null;
  });
  const hostMarkupParser = options.hostMarkupParser || createHostMarkupParser(globalThis);
  realm.defineHostFunction('__zpHostParseHTMLDocument', (source, type) =>
    hostMarkupParser.parseDocument(source, type),
  );
  realm.defineHostFunction('__zpHostParseHTMLFragment', (source, context) =>
    hostMarkupParser.parseFragment(source, hostJSON(context)),
  );
  realm.defineHostFunction('__zpHostParseStyleDeclarations', (cssText) =>
    hostMarkupParser.parseStyleDeclarations(cssText),
  );
  realm.defineHostFunction('__zpParseURL', (url, base) => urlRecord(url, base));
  realm.defineHostFunction('__zpSetURLPart', (href, part, value, base) =>
    setURLPart(href, part, value, base),
  );
  realm.defineHostFunction('__zpParseURLSearchParams', (source) =>
    urlSearchParamsEntries(source),
  );
  realm.defineHostFunction('__zpSerializeURLSearchParams', (entriesJSON) =>
    serializeURLSearchParams(entriesJSON),
  );
  const intlCache = new Map();
  realm.defineHostFunction('__zpIntlCall', (payloadJSON) => intlCall(payloadJSON, intlCache));
  const hostWebAPIBridge = options.hostWebAPIBridge || createHostWebAPIBridge(globalThis);
  realm.defineHostFunction('__zpHostWebAPIBridge', (payloadJSON) =>
    hostWebAPIBridge.invoke(payloadJSON),
  );
  const config = {
    ...(options.config || {}),
    hostWebAPIShapes: {
      ...(options.config?.hostWebAPIShapes || {}),
      ...(hostWebAPIBridge.shapes || {}),
    },
    storageQuota: options.storageQuota || storageManager?.maxBytesPerPartition || options.config?.storageQuota,
    storageSnapshot: storage.snapshot || options.config?.storageSnapshot || {},
  };
  realm.evalClassic(WEBAPI_CORE_SOURCE, 'zeroproxy-webapi-core.js');
  realm.evalClassic(`__zpInstallWebAPICore(${JSON.stringify(config)});`, 'zeroproxy-webapi-install.js');
  const removeStorageListener = storageManager?.addStorageListener?.(storagePartition, (event) => {
    try { realm.evalClassic(`__zpDispatchStorageEvent(${JSON.stringify(JSON.stringify(event))});`, 'zeroproxy-storage-event.js'); } catch {}
  });
  return { removeStorageListener: removeStorageListener || (() => {}) };
}

function randomBytes(length) {
  const out = new Uint8Array(Math.max(0, Math.min(length, 65536)));
  globalThis.crypto?.getRandomValues?.(out);
  return [...out];
}

function urlRecord(url, base) {
  try {
    const parsed =
      base === undefined ? new URL(String(url ?? '')) : new URL(String(url ?? ''), String(base));
    return {
      href: parsed.href,
      origin: parsed.origin,
      protocol: parsed.protocol,
      username: parsed.username,
      password: parsed.password,
      host: parsed.host,
      hostname: parsed.hostname,
      port: parsed.port,
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
    };
  } catch {
    return null;
  }
}

function setURLPart(href, part, value, base) {
  try {
    const parsed = new URL(String(href || ''), String(base || 'about:blank'));
    const key = String(part);
    if (!URL_PARTS.has(key)) return parsed.href;
    parsed[key] = String(value ?? '');
    return parsed.href;
  } catch {
    return null;
  }
}

function urlSearchParamsEntries(source) {
  try {
    return [...new URLSearchParams(String(source ?? '')).entries()];
  } catch {
    return [];
  }
}

function serializeURLSearchParams(entriesJSON) {
  const params = new URLSearchParams();
  try {
    const entries = JSON.parse(String(entriesJSON || '[]'));
    if (Array.isArray(entries)) {
      for (const pair of entries) if (Array.isArray(pair) && pair.length >= 2) params.append(String(pair[0]), String(pair[1]));
    }
  } catch {}
  return params.toString();
}

function intlCall(payloadJSON, cache) {
  try {
    const payload = JSON.parse(String(payloadJSON || '{}'));
    return { ok: true, value: intlCallValue(payload, cache) };
  } catch (error) {
    return { ok: false, name: error?.name || 'TypeError', message: error?.message || String(error) };
  }
}

function intlCallValue(payload, cache) {
  const intl = globalThis.Intl;
  if (!intl) throw new ReferenceError('Intl is not available on the host');
  if (payload.op === 'getCanonicalLocales') return intl.getCanonicalLocales(payload.locales);
  if (payload.op === 'supportedValuesOf') return typeof intl.supportedValuesOf === 'function' ? intl.supportedValuesOf(payload.key) : [];
  if (payload.op === 'supportedLocalesOf') return intlConstructor(payload.constructorName).supportedLocalesOf(payload.locales, payload.options);
  if (payload.op === 'locale') return localeRecord(new intl.Locale(payload.tag, payload.options));
  if (payload.op === 'localeMethod') return String(new intl.Locale(payload.tag)[payload.method]());
  if (payload.op !== 'method') throw new TypeError('Unsupported Intl operation');
  const formatter = intlFormatter(payload, cache);
  if (payload.method === 'segment') return Array.from(formatter.segment(String(payload.args?.[0] || '')), segmentRecord);
  const method = formatter[payload.method];
  if (typeof method !== 'function') throw new TypeError(`Intl.${payload.constructorName}.${payload.method} is not available`);
  return method.apply(formatter, Array.isArray(payload.args) ? payload.args : []);
}

function intlConstructor(name) {
  const Ctor = globalThis.Intl?.[String(name || '')];
  if (typeof Ctor !== 'function') throw new TypeError(`Intl.${name} is not available`);
  return Ctor;
}

function intlFormatter(payload, cache) {
  const key = JSON.stringify([payload.constructorName, payload.locales ?? null, payload.options ?? null]);
  let formatter = cache.get(key);
  if (!formatter) {
    formatter = new (intlConstructor(payload.constructorName))(payload.locales, payload.options);
    cache.set(key, formatter);
  }
  return formatter;
}

function localeRecord(locale) {
  return {
    id: String(locale),
    baseName: locale.baseName,
    calendar: locale.calendar,
    caseFirst: locale.caseFirst,
    collation: locale.collation,
    hourCycle: locale.hourCycle,
    language: locale.language,
    numberingSystem: locale.numberingSystem,
    numeric: locale.numeric,
    region: locale.region,
    script: locale.script,
  };
}

function segmentRecord(entry) {
  return {
    segment: entry.segment,
    index: entry.index,
    input: entry.input,
    isWordLike: entry.isWordLike,
  };
}

export function createHostWebAPIBridge(root = globalThis, definitions = HOST_WEB_API_BRIDGE_DEFINITIONS) {
  const handles = new Map();
  let nextHandle = 1;
  return {
    shapes: snapshotHostWebAPIShapes(root, definitions),
    invoke(payloadJSON) {
      try {
        const payload = JSON.parse(String(payloadJSON || '{}'));
        return hostWebAPIBridgeDispatch(root, definitions, handles, () => nextHandle++, payload);
      } catch (error) {
        return bridgeError(error);
      }
    },
  };
}

function hostWebAPIBridgeDispatch(root, definitions, handles, nextHandle, payload) {
  const context = hostBridgeContext(root, definitions, payload);
  if (!context) return bridgeUnavailable();
  if (payload.op === 'call') return hostBridgeGlobalCall(context, payload);
  if (payload.op === 'static') return hostBridgeStaticCall(context, payload);
  if (payload.op === 'construct') return hostBridgeConstructCall(context, handles, nextHandle, payload);
  if (payload.op === 'method') return hostBridgeMethodCall(context, handles, payload);
  if (payload.op === 'get') return hostBridgeGetCall(context, handles, payload);
  if (payload.op === 'set') return hostBridgeSetCall(context, handles, payload);
  if (payload.op === 'release') return hostBridgeReleaseCall(handles, payload);
  return bridgeUnavailable();
}

function hostBridgeContext(root, definitions, payload) {
  const globalName = String(payload.globalName || '');
  const definition = definitions[globalName];
  const target = root?.[globalName];
  if (!definition || (definition.browserOnly && !isBrowserHost(root))) return null;
  if (definition.kind === 'globalFunction') {
    return typeof target === 'function' ? { globalName, definition, target } : null;
  }
  if (definition.kind === 'namespace') {
    return target && (typeof target === 'object' || typeof target === 'function')
      ? { globalName, definition, target }
      : null;
  }
  return typeof target === 'function' ? { globalName, definition, target } : null;
}

function isBrowserHost(root) {
  return Boolean(root?.document);
}

function hostBridgeGlobalCall(context, payload) {
  if (context.definition.kind !== 'globalFunction' || typeof context.target !== 'function') return bridgeUnavailable();
  return bridgeValue(context.target.apply(undefined, bridgeArgs(payload.args)));
}

function hostBridgeStaticCall(context, payload) {
  const method = String(payload.method || '');
  if (!bridgeStaticMethodNames(context).includes(method)) return bridgeUnavailable();
  const fn = context.target[method];
  if (typeof fn !== 'function') return bridgeUnavailable();
  return bridgeValue(fn.apply(context.target, bridgeArgs(payload.args)));
}

function hostBridgeConstructCall(context, handles, nextHandle, payload) {
  if (typeof context.target !== 'function') return bridgeUnavailable();
  const instance = new context.target(...bridgeArgs(payload.args));
  const handle = String(nextHandle());
  handles.set(handle, { globalName: context.globalName, instance });
  return bridgeValue({
    handle,
    fields: snapshotBridgeFields(instance, bridgeConstructFields(context)),
  });
}

function hostBridgeMethodCall(context, handles, payload) {
  const method = String(payload.method || '');
  if (!bridgePrototypeMethodNames(context).includes(method)) return bridgeUnavailable();
  const handle = handles.get(String(payload.handle || ''));
  if (!handle || handle.globalName !== context.globalName) return bridgeUnavailable();
  const fn = handle.instance?.[method];
  if (typeof fn !== 'function') return bridgeUnavailable();
  const args = bridgeArgs(payload.args, context.definition.methodArgTransforms?.[method]);
  return bridgeValue(fn.apply(handle.instance, args), methodMutatedArgs(args, context.definition.methodMutatedArgs?.[method]));
}

function hostBridgeGetCall(context, handles, payload) {
  const property = String(payload.property || '');
  if (!bridgePrototypeGetterNames(context).includes(property)) return bridgeUnavailable();
  const handle = handles.get(String(payload.handle || ''));
  if (!handle || handle.globalName !== context.globalName) return bridgeUnavailable();
  return bridgeValue(handle.instance?.[property]);
}

function hostBridgeSetCall(context, handles, payload) {
  const property = String(payload.property || '');
  if (!bridgePrototypeSetterNames(context).includes(property)) return bridgeUnavailable();
  const handle = handles.get(String(payload.handle || ''));
  if (!handle || handle.globalName !== context.globalName) return bridgeUnavailable();
  handle.instance[property] = bridgeArgs([payload.value])[0];
  return bridgeValue(handle.instance?.[property]);
}

function hostBridgeReleaseCall(handles, payload) {
  handles.delete(String(payload.handle || ''));
  return bridgeValue(true);
}

function bridgeArgs(args, transforms = []) {
  if (!Array.isArray(args)) return [];
  return args.map((arg, index) => transformBridgeArg(arg, transforms[index]));
}

function transformBridgeArg(arg, transform) {
  if (transform === 'uint8array') return new Uint8Array(Array.isArray(arg) ? arg : []);
  return arg;
}

function bridgeValue(value, mutatedArgs = undefined) {
  const out = { ok: true, value: serializeBridgeValue(value) };
  if (mutatedArgs) out.mutatedArgs = mutatedArgs;
  return out;
}

function methodMutatedArgs(args, indexes = []) {
  if (!Array.isArray(indexes) || indexes.length === 0) return undefined;
  const out = {};
  for (const index of indexes) out[String(index)] = serializeBridgeValue(args[index]);
  return out;
}

function bridgeUnavailable() {
  return { ok: false, unavailable: true };
}

function bridgeError(error) {
  return {
    ok: false,
    error: {
      name: error?.name || 'Error',
      message: error?.message || String(error),
    },
  };
}

function serializeBridgeValue(value, seen = new Map()) {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (ArrayBuffer.isView(value)) {
    return {
      __zpBridgeType: value.constructor?.name || 'TypedArray',
      bytes: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    };
  }
  if (value instanceof ArrayBuffer) {
    return {
      __zpBridgeType: 'ArrayBuffer',
      bytes: Array.from(new Uint8Array(value)),
    };
  }
  if (Array.isArray(value)) return value.map((item) => serializeBridgeValue(item, seen));
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return seen.get(value);
  const out = {};
  seen.set(value, out);
  for (const key of Object.keys(value).sort()) out[key] = serializeBridgeValue(value[key], seen);
  return out;
}

function snapshotBridgeFields(instance, fields = []) {
  const out = {};
  for (const field of fields) out[field] = serializeBridgeValue(instance?.[field]);
  return out;
}

function snapshotHostWebAPIShapes(root, definitions) {
  const shapes = {};
  if (isBrowserHost(root)) snapshotHostFunctionReflection(root, shapes);
  for (const [globalName, definition] of Object.entries(definitions)) {
    if (definition.browserOnly && !isBrowserHost(root)) continue;
    const target = root?.[globalName];
    if (!target || (typeof target !== 'object' && typeof target !== 'function')) continue;
    const shape = shapes[globalName] || {};
    shape.globalDescriptor = descriptorSnapshot(root, globalName);
    shape.staticDescriptors = selectedDescriptorSnapshots(target, bridgeStaticMethodNames({ definition, target }));
    shape.bridge = bridgeDefinitionSnapshot(definition, target);
    if (typeof target === 'function' && definition.kind !== 'namespace') {
      shape.constructorDescriptor = functionDescriptorSnapshot(target);
      shape.prototypeDescriptors = selectedDescriptorSnapshots(target.prototype, bridgePrototypeKeys(definition, target));
      shape.prototypeToStringTag = descriptorSnapshot(target.prototype, Symbol.toStringTag);
    } else {
      shape.objectToStringTag = descriptorSnapshot(target, Symbol.toStringTag);
    }
    shapes[globalName] = shape;
  }
  return shapes;
}

function snapshotHostFunctionReflection(root, shapes) {
  for (const globalName of Object.getOwnPropertyNames(root || {})) {
    if (HOST_REFLECTION_EXCLUDED_GLOBALS.has(globalName)) continue;
    const target = root?.[globalName];
    if (typeof target !== 'function') continue;
    const shape = shapes[globalName] || {};
    shape.globalDescriptor = shape.globalDescriptor || descriptorSnapshot(root, globalName);
    shape.constructorDescriptor = shape.constructorDescriptor || functionDescriptorSnapshot(target);
    shape.prototypeToStringTag = shape.prototypeToStringTag || descriptorSnapshot(target.prototype, Symbol.toStringTag);
    shapes[globalName] = shape;
  }
}

function bridgeDefinitionSnapshot(definition, target) {
  const snapshot = {};
  if (definition.autoFacade) snapshot.autoFacade = true;
  if (definition.baseClass) snapshot.baseClass = String(definition.baseClass);
  const reflected = { definition, target };
  const valuesByKey = {
    constructFields: bridgeConstructFields(reflected),
    prototypeGetters: bridgePrototypeGetterNames(reflected),
    prototypeSetters: bridgePrototypeSetterNames(reflected),
    prototypeMethods: bridgePrototypeMethodNames(reflected),
    staticMethods: bridgeStaticMethodNames(reflected),
  };
  for (const [key, values] of Object.entries(valuesByKey)) {
    if (values.length) snapshot[key] = values;
  }
  return snapshot;
}

function bridgePrototypeKeys(definition, target) {
  const reflected = { definition, target };
  return uniqueStrings([
    ...bridgeConstructFields(reflected),
    ...bridgePrototypeGetterNames(reflected),
    ...bridgePrototypeSetterNames(reflected),
    ...bridgePrototypeMethodNames(reflected),
    'constructor',
  ]);
}

function bridgeConstructFields(context) {
  const explicit = stringArray(context.definition.constructFields);
  if (explicit.length) return explicit;
  return context.definition.autoFacade ? bridgePrototypeGetterNames(context) : [];
}

function bridgePrototypeGetterNames(context) {
  const explicit = stringArray(context.definition.prototypeGetters);
  if (explicit.length) return explicit;
  return context.definition.autoFacade ? reflectedPrototypeNames(context.target, (descriptor) => typeof descriptor.get === 'function') : [];
}

function bridgePrototypeSetterNames(context) {
  const explicit = stringArray(context.definition.prototypeSetters);
  if (explicit.length) return explicit;
  return context.definition.autoFacade ? reflectedPrototypeNames(context.target, (descriptor) => typeof descriptor.set === 'function') : [];
}

function bridgePrototypeMethodNames(context) {
  const explicit = stringArray(context.definition.prototypeMethods);
  if (explicit.length) return explicit;
  return context.definition.autoFacade ? reflectedPrototypeNames(context.target, (descriptor) => typeof descriptor.value === 'function') : [];
}

function bridgeStaticMethodNames(context) {
  const explicit = stringArray(context.definition.staticMethods);
  if (explicit.length || context.definition.kind === 'namespace') return explicit;
  if (!context.definition.autoFacade) return [];
  return Object.getOwnPropertyNames(context.target || {}).filter((name) => {
    if (name === 'length' || name === 'name' || name === 'prototype') return false;
    return typeof Object.getOwnPropertyDescriptor(context.target, name)?.value === 'function';
  });
}

function reflectedPrototypeNames(target, predicate) {
  const prototype = target?.prototype;
  if (!prototype) return [];
  return Object.getOwnPropertyNames(prototype).filter((name) => {
    if (name === 'constructor') return false;
    return predicate(Object.getOwnPropertyDescriptor(prototype, name) || {});
  });
}

function stringArray(values) {
  return Array.isArray(values) ? values.map((value) => String(value)) : [];
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map((value) => String(value))));
}

function selectedDescriptorSnapshots(owner, keys) {
  const out = {};
  for (const key of keys) {
    const snapshot = descriptorSnapshot(owner, key);
    if (snapshot) out[String(key)] = snapshot;
  }
  return out;
}

function functionDescriptorSnapshot(fn) {
  return {
    name: typeof fn === 'function' ? fn.name : '',
    length: typeof fn === 'function' ? fn.length : 0,
  };
}

function descriptorSnapshot(owner, key) {
  const desc = owner ? Object.getOwnPropertyDescriptor(owner, key) : null;
  if (!desc) return null;
  const out = {
    configurable: Boolean(desc.configurable),
    enumerable: Boolean(desc.enumerable),
  };
  if ('writable' in desc) out.writable = Boolean(desc.writable);
  if (typeof desc.value === 'function') out.value = functionDescriptorSnapshot(desc.value);
  else if (desc.value !== undefined && desc.value !== null && typeof desc.value !== 'object') out.value = desc.value;
  if (desc.get) out.get = functionDescriptorSnapshot(desc.get);
  if (desc.set) out.set = functionDescriptorSnapshot(desc.set);
  return out;
}

export function createHostMarkupParser(root = globalThis) {
  const DOMParserCtor = root?.DOMParser;
  if (typeof DOMParserCtor !== 'function') return unavailableHostMarkupParser();
  return {
    parseDocument(source, type) {
      const parser = new DOMParserCtor();
      const parseType = normalizeDOMParserType(type);
      const doc = parser.parseFromString(String(source ?? ''), parseType);
      return documentSnapshot(doc, parseType);
    },
    parseFragment(source, context) {
      const parser = new DOMParserCtor();
      const doc = parser.parseFromString('<!doctype html><html><body></body></html>', 'text/html');
      const contextElement = createHostFragmentContext(doc, context);
      contextElement.innerHTML = String(source ?? '');
      return childSnapshots(contextElement);
    },
    parseStyleDeclarations(cssText) {
      const parser = new DOMParserCtor();
      const doc = parser.parseFromString('<!doctype html><html><body></body></html>', 'text/html');
      const element = doc.createElement('div');
      (doc.body || doc.documentElement || doc).appendChild(element);
      element.style.cssText = String(cssText ?? '');
      return styleDeclarationsSnapshot(element.style);
    },
  };
}

function createHostFragmentContext(doc, context) {
  const name = String(context?.name || 'div');
  const namespaceURI = String(context?.namespaceURI || 'http://www.w3.org/1999/xhtml');
  const element =
    namespaceURI && namespaceURI !== 'http://www.w3.org/1999/xhtml'
      ? doc.createElementNS(namespaceURI, name)
      : doc.createElement(name);
  (doc.body || doc.documentElement || doc).appendChild(element);
  return element;
}


function hostJSON(value) {
  return value && typeof value === 'object' && Object.hasOwn(value, 'json') ? value.json : value;
}
function unavailableHostMarkupParser() {
  const unavailable = () => {
    throw new TypeError('Host DOMParser is unavailable');
  };
  return { parseDocument: unavailable, parseFragment: unavailable, parseStyleDeclarations: unavailable };
}

function normalizeDOMParserType(type) {
  const text = String(type || 'text/html').toLowerCase();
  return HOST_DOMPARSER_TYPES.has(text) ? text : 'text/html';
}

function documentSnapshot(doc, contentType) {
  return {
    contentType: doc?.contentType || contentType,
    title: doc?.title || '',
    head: childSnapshots(doc?.head),
    body: documentBodySnapshot(doc),
  };
}

function documentBodySnapshot(doc) {
  if (!doc) return [];
  if (doc.body) return childSnapshots(doc.body);
  return doc.documentElement ? [nodeSnapshot(doc.documentElement)] : childSnapshots(doc);
}

function childSnapshots(parent) {
  return Array.from(parent?.childNodes || [], nodeSnapshot).filter(Boolean);
}

function nodeSnapshot(node) {
  if (!node) return null;
  if (node.nodeType === 3) return { type: 'text', text: node.nodeValue || '' };
  if (node.nodeType === 8) return { type: 'comment', text: node.nodeValue || '' };
  if (node.nodeType !== 1) return null;
  return {
    type: 'element',
    name: node.localName || String(node.nodeName || '').toLowerCase(),
    namespaceURI: node.namespaceURI || '',
    attributes: attributeSnapshots(node),
    children: childSnapshots(node),
  };
}

function attributeSnapshots(element) {
  return Array.from(element.attributes || [], (attr) => ({
    name: attr.name,
    namespaceURI: attr.namespaceURI || '',
    value: attr.value || '',
  }));
}

function styleDeclarationsSnapshot(style) {
  const out = [];
  for (let i = 0; i < style.length; i += 1) {
    const name = style.item(i);
    out.push({
      name,
      value: style.getPropertyValue(name),
      priority: style.getPropertyPriority(name),
    });
  }
  return out;
}
