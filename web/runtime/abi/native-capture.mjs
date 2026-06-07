const NativeArray = Array;
const NativeArrayBuffer = ArrayBuffer;
const NativeDate = Date;
const NativeError = Error;
const NativeFunctionApply = Function.prototype.apply;
const NativeFunctionBind = Function.prototype.bind;
const NativeFunctionCall = Function.prototype.call;
const NativeJSON = JSON;
const NativeInfinity = Infinity;
const NativeMap = Map;
const NativeMath = Math;
const NativeNumber = Number;
const NativeObject = Object;
const NativePromise = Promise;
const NativeProxy = Proxy;
const NativeReflect = Reflect;
const NativeRegExp = RegExp;
const NativeSet = Set;
const NativeString = String;
const NativeSymbol = Symbol;
const NativeSyntaxError = SyntaxError;
const NativeTypeError = TypeError;
const NativeUint8Array = Uint8Array;
const NativeURL = URL;
const NativeURLSearchParams = URLSearchParams;
const NativeWeakMap = WeakMap;
const NativeWeakSet = WeakSet;
const nativeArrayFrom = NativeArray.from;
const nativeArrayIsArray = NativeArray.isArray;
const nativeDecodeURIComponent = decodeURIComponent;
const nativeEncodeURIComponent = encodeURIComponent;
const nativeObjectAssign = NativeObject.assign;
const nativeObjectCreate = NativeObject.create;
const nativeObjectDefineProperty = NativeObject.defineProperty;
const nativeObjectFreeze = NativeObject.freeze;
const nativeObjectGetOwnPropertyDescriptor = NativeObject.getOwnPropertyDescriptor;
const nativeObjectGetOwnPropertyDescriptors = NativeObject.getOwnPropertyDescriptors;
const nativeObjectGetOwnPropertyNames = NativeObject.getOwnPropertyNames;
const nativeObjectGetOwnPropertySymbols = NativeObject.getOwnPropertySymbols;
const nativeObjectGetPrototypeOf = NativeObject.getPrototypeOf;
const nativeObjectHasOwn = NativeObject.hasOwn;
const nativeObjectKeys = NativeObject.keys;
const nativeObjectSetPrototypeOf = NativeObject.setPrototypeOf;
const nativeReflectApply = NativeReflect.apply;
const nativeReflectConstruct = NativeReflect.construct;
const nativeReflectDeleteProperty = NativeReflect.deleteProperty;
const nativeReflectGet = NativeReflect.get;
const nativeReflectGetOwnPropertyDescriptor = NativeReflect.getOwnPropertyDescriptor;
const nativeReflectGetPrototypeOf = NativeReflect.getPrototypeOf;
const nativeReflectHas = NativeReflect.has;
const nativeReflectOwnKeys = NativeReflect.ownKeys;
const nativeReflectSet = NativeReflect.set;
const nativeReflectSetPrototypeOf = NativeReflect.setPrototypeOf;
const nativeURLSearchParamsAppend = NativeURLSearchParams.prototype.append;
const nativeURLSearchParamsGetAll = NativeURLSearchParams.prototype.getAll;
const nativeURLSearchParamsSet = NativeURLSearchParams.prototype.set;
const nativeURLSearchParamsToString = NativeURLSearchParams.prototype.toString;

export function readBootConfig(root) {
  return root.__ZP_BOOT || {};
}

export function clearBootConfig(root) {
  try {
    delete root.__ZP_BOOT;
  } catch {
    try {
      nativeObjectDefineProperty(root, '__ZP_BOOT', {
        value: undefined,
        enumerable: false,
      });
    } catch {}
  }
}

export function captureNative(w) {
  return {
    ...captureCore(w),
    ...captureNavigator(w),
    ...captureDOM(w),
    ...captureDocumentIO(w),
    ...captureNavigation(w),
    ...captureTimersAndParsers(w),
    ...captureReflection(w),
    indexedDB: w.indexedDB,
    localStorage: safeLocalStorage(w),
  };
}

function captureCore(w) {
  return {
    globalThis: w,
    Array: NativeArray,
    ArrayBuffer: NativeArrayBuffer,
    Date: NativeDate,
    Error: NativeError,
    JSON: NativeJSON,
    Infinity: NativeInfinity,
    Map: NativeMap,
    Math: NativeMath,
    Number: NativeNumber,
    Object: NativeObject,
    Promise: NativePromise,
    Proxy: NativeProxy,
    Reflect: NativeReflect,
    RegExp: NativeRegExp,
    Set: NativeSet,
    String: NativeString,
    Symbol: NativeSymbol,
    SyntaxError: NativeSyntaxError,
    TypeError: NativeTypeError,
    Uint8Array: NativeUint8Array,
    URL: NativeURL,
    URLSearchParams: NativeURLSearchParams,
    WeakMap: NativeWeakMap,
    WeakSet: NativeWeakSet,
    decodeURIComponent: nativeDecodeURIComponent,
    encodeURIComponent: nativeEncodeURIComponent,
    functionApply: NativeFunctionApply,
    functionBind: NativeFunctionBind,
    functionCall: NativeFunctionCall,
    arrayFrom: nativeArrayFrom,
    arrayIsArray: nativeArrayIsArray,
    objectAssign: nativeObjectAssign,
    objectCreate: nativeObjectCreate,
    objectDefineProperty: nativeObjectDefineProperty,
    objectFreeze: nativeObjectFreeze,
    objectGetOwnPropertyDescriptor: nativeObjectGetOwnPropertyDescriptor,
    objectGetOwnPropertyDescriptors: nativeObjectGetOwnPropertyDescriptors,
    objectGetOwnPropertyNames: nativeObjectGetOwnPropertyNames,
    objectGetOwnPropertySymbols: nativeObjectGetOwnPropertySymbols,
    objectGetPrototypeOf: nativeObjectGetPrototypeOf,
    objectHasOwn: nativeObjectHasOwn,
    objectKeys: nativeObjectKeys,
    objectSetPrototypeOf: nativeObjectSetPrototypeOf,
    reflectApply: nativeReflectApply,
    reflectConstruct: nativeReflectConstruct,
    reflectDeleteProperty: nativeReflectDeleteProperty,
    reflectGet: nativeReflectGet,
    reflectGetOwnPropertyDescriptor: nativeReflectGetOwnPropertyDescriptor,
    reflectGetPrototypeOf: nativeReflectGetPrototypeOf,
    reflectHas: nativeReflectHas,
    reflectOwnKeys: nativeReflectOwnKeys,
    reflectSet: nativeReflectSet,
    reflectSetPrototypeOf: nativeReflectSetPrototypeOf,
    urlSearchParamsAppend: nativeURLSearchParamsAppend,
    urlSearchParamsGetAll: nativeURLSearchParamsGetAll,
    urlSearchParamsSet: nativeURLSearchParamsSet,
    urlSearchParamsToString: nativeURLSearchParamsToString,
    fetch: bindMethod(w, 'fetch'),
    XMLHttpRequest: w.XMLHttpRequest,
    WebSocket: w.WebSocket,
    EventSource: w.EventSource,
    Worker: w.Worker,
    FunctionCtor: w.Function,
    eval: w.eval,
    SharedWorker: w.SharedWorker,
    FormData: w.FormData,
    Blob: w.Blob,
    TextDecoder: w.TextDecoder,
    TextEncoder: w.TextEncoder,
    MessageChannel: w.MessageChannel,
    BroadcastChannel: w.BroadcastChannel,
    ReadableStream: w.ReadableStream,
    WritableStream: w.WritableStream,
    AbortController: w.AbortController,
    Event: w.Event,
    MessageEvent: w.MessageEvent,
    ProgressEvent: w.ProgressEvent,
    CloseEvent: w.CloseEvent,
    HashChangeEvent: w.HashChangeEvent,
    Location: w.Location,
    DOMException: w.DOMException,
    Request: w.Request,
    Response: w.Response,
    Headers: w.Headers,
  };
}

function captureNavigator(w) {
  const serviceWorker = value(w.navigator, 'serviceWorker');
  return {
    serviceWorkerController: value(serviceWorker, 'controller'),
    navigatorSendBeacon: bindMethod(w.navigator, 'sendBeacon'),
    serviceWorker,
  };
}

function captureDOM(w) {
  const d = w.document;
  const node = proto(w, 'Node');
  const element = proto(w, 'Element');
  const doc = proto(w, 'Document');
  return {
    createElement: bindMethod(d, 'createElement'),
    createElementNS: bindMethod(d, 'createElementNS'),
    appendChild: node.appendChild,
    insertBefore: node.insertBefore,
    replaceChild: node.replaceChild,
    ...captureElementPrototype(element),
    ...captureNamedNodeMap(w),
    ...captureQueryAndTraversal(w, doc, element),
    ...captureTextAndForm(w, node),
  };
}

function captureElementPrototype(element) {
  return {
    setAttribute: element.setAttribute,
    setAttributeNode: element.setAttributeNode,
    setAttributeNodeNS: element.setAttributeNodeNS,
    getAttributeNode: element.getAttributeNode,
    getAttributeNodeNS: element.getAttributeNodeNS,
    removeAttributeNode: element.removeAttributeNode,
    getAttribute: element.getAttribute,
    removeAttribute: element.removeAttribute,
    removeAttributeNS: element.removeAttributeNS,
    hasAttribute: element.hasAttribute,
    getAttributeNames: element.getAttributeNames,
    insertAdjacentHTML: element.insertAdjacentHTML,
    elementInnerHTML: desc(element, 'innerHTML'),
    elementOuterHTML: desc(element, 'outerHTML'),
    elementAttributes: desc(element, 'attributes'),
    setAttributeNS: element.setAttributeNS,
    matches: element.matches,
    closest: element.closest,
  };
}

function captureNamedNodeMap(w) {
  const named = proto(w, 'NamedNodeMap');
  const attr = proto(w, 'Attr');
  const node = proto(w, 'Node');
  return {
    namedSetNamedItem: value(named, 'setNamedItem'),
    namedSetNamedItemNS: value(named, 'setNamedItemNS'),
    attrValue: desc(attr, 'value'),
    attrNodeValue: desc(attr, 'nodeValue') || desc(node, 'nodeValue'),
  };
}

function captureQueryAndTraversal(w, doc, element) {
  return {
    querySelector: doc.querySelector,
    querySelectorAll: doc.querySelectorAll,
    elementQuerySelector: element.querySelector,
    elementQuerySelectorAll: element.querySelectorAll,
    documentGetElementsByTagName: doc.getElementsByTagName,
    elementGetElementsByTagName: element.getElementsByTagName,
    documentScripts: desc(doc, 'scripts'),
    createNodeIterator: doc.createNodeIterator,
    createTreeWalker: doc.createTreeWalker,
    createHTMLDocument: bindMethod(w.document.implementation, 'createHTMLDocument'),
  };
}

function captureTextAndForm(w, node) {
  const script = proto(w, 'HTMLScriptElement');
  const html = proto(w, 'HTMLElement');
  const form = proto(w, 'HTMLFormElement');
  return {
    scriptText: desc(script, 'text'),
    nodeTextContent: desc(node, 'textContent'),
    htmlInnerText: desc(html, 'innerText'),
    formSubmit: value(form, 'submit'),
    formRequestSubmit: value(form, 'requestSubmit'),
  };
}

function captureDocumentIO(w) {
  const d = w.document;
  return {
    documentOpen: bindMethod(d, 'open'),
    documentWrite: bindMethod(d, 'write'),
    documentWriteln: bindMethod(d, 'writeln'),
    documentClose: bindMethod(d, 'close'),
  };
}

function captureNavigation(w) {
  const locationProto = proto(w, 'Location');
  return {
    historyPush: bindMethod(w.history, 'pushState'),
    historyReplace: bindMethod(w.history, 'replaceState'),
    locationAssign: bindMethod(w.location, 'assign'),
    locationReplace: bindMethod(w.location, 'replace'),
    locationHref: desc(locationProto, 'href') || desc(w.location, 'href'),
    locationReload: bindMethod(w.location, 'reload'),
    createObjectURL: bindMethod(w.URL, 'createObjectURL'),
    revokeObjectURL: bindMethod(w.URL, 'revokeObjectURL'),
    open: bindMethod(w, 'open'),
  };
}

function captureTimersAndParsers(w) {
  return {
    setTimeout: bindMethod(w, 'setTimeout'),
    setInterval: bindMethod(w, 'setInterval'),
    clearTimeout: bindMethod(w, 'clearTimeout'),
    clearInterval: bindMethod(w, 'clearInterval'),
    DOMParserParseFromString: value(proto(w, 'DOMParser'), 'parseFromString'),
    rangeCreateContextualFragment: value(proto(w, 'Range'), 'createContextualFragment'),
    windowAddEventListener: bindMethod(w, 'addEventListener'),
    windowRemoveEventListener: bindMethod(w, 'removeEventListener'),
  };
}

function captureReflection(w) {
  return {
    objectGetPrototypeOf: nativeObjectGetPrototypeOf,
    reflectGetPrototypeOf: nativeReflectGetPrototypeOf,
    reflectApply: nativeReflectApply,
    weakMapGet: value(proto(w, 'WeakMap'), 'get'),
  };
}

function bindMethod(obj, key) {
  const fn = value(obj, key);
  return fn && nativeReflectApply(NativeFunctionBind, fn, [obj]);
}

function desc(obj, key) {
  return obj ? nativeObjectGetOwnPropertyDescriptor(obj, key) : undefined;
}

function proto(w, name) {
  return value(w[name], 'prototype');
}

function value(obj, key) {
  return obj && obj[key];
}

function safeLocalStorage(w) {
  try {
    return w.localStorage;
  } catch {
    return null;
  }
}

export function createNormalizedError(Native) {
  return function normalizedError(name = 'NotSupportedError') {
    try {
      return new Native.DOMException('Blocked by ZeroProxy policy', name);
    } catch {
      const e = new NativeError('Blocked by ZeroProxy policy');
      e.name = name;
      return e;
    }
  };
}
