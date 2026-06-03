export function readBootConfig(root) {
  return root.__ZP_BOOT || {};
}

export function clearBootConfig(root) {
  try {
    delete root.__ZP_BOOT;
  } catch {
    try {
      Object.defineProperty(root, '__ZP_BOOT', {
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
    fetch: bindMethod(w, 'fetch'),
    XMLHttpRequest: w.XMLHttpRequest,
    WebSocket: w.WebSocket,
    EventSource: w.EventSource,
    Worker: w.Worker,
    FunctionCtor: w.Function,
    eval: w.eval,
    SharedWorker: w.SharedWorker,
    FormData: w.FormData,
    URL: w.URL,
    Blob: w.Blob,
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
    createElement: d.createElement.bind(d),
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
    historyPush: w.history.pushState.bind(w.history),
    historyReplace: w.history.replaceState.bind(w.history),
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
    objectGetPrototypeOf: Object.getPrototypeOf,
    reflectGetPrototypeOf: value(w.Reflect, 'getPrototypeOf'),
    reflectApply: value(w.Reflect, 'apply'),
    weakMapGet: value(proto(w, 'WeakMap'), 'get'),
  };
}

function bindMethod(obj, key) {
  const fn = value(obj, key);
  return fn && fn.bind(obj);
}

function desc(obj, key) {
  return obj ? Object.getOwnPropertyDescriptor(obj, key) : undefined;
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
      const e = new Error('Blocked by ZeroProxy policy');
      e.name = name;
      return e;
    }
  };
}
