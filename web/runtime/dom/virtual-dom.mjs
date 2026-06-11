export const VIRTUAL_DOM_SOURCE = String.raw`
(() => {
  let nextNodeId = 100000;
  let rafId = 1;
  const nodes = new Map();
  const listeners = new WeakMap();
  const mediaQueries = new Set();
  const resizeObservers = new Set();
  const intersectionObservers = new Set();
  const virtualAnimations = new Set();
  const handlerProps = Object.freeze([
    'onabort',
    'onafterprint',
    'onanimationcancel',
    'onanimationend',
    'onanimationiteration',
    'onanimationstart',
    'onappinstalled',
    'onauxclick',
    'onbeforeinput',
    'onbeforeinstallprompt',
    'onbeforematch',
    'onbeforeprint',
    'onbeforetoggle',
    'onbeforeunload',
    'onbeforexrselect',
    'onblur',
    'oncancel',
    'oncanplay',
    'oncanplaythrough',
    'onchange',
    'onclick',
    'onclose',
    'oncommand',
    'oncontentvisibilityautostatechange',
    'oncontextlost',
    'oncontextmenu',
    'oncontextrestored',
    'oncuechange',
    'ondblclick',
    'ondrag',
    'ondragend',
    'ondragenter',
    'ondragleave',
    'ondragover',
    'ondragstart',
    'ondrop',
    'ondurationchange',
    'onemptied',
    'onended',
    'onerror',
    'onfocus',
    'onfullscreenchange',
    'onfullscreenerror',
    'onformdata',
    'ongamepadconnected',
    'ongamepaddisconnected',
    'ongotpointercapture',
    'onhashchange',
    'oninput',
    'oninvalid',
    'onkeydown',
    'onkeypress',
    'onkeyup',
    'onlanguagechange',
    'onload',
    'onloadeddata',
    'onloadedmetadata',
    'onloadstart',
    'onlostpointercapture',
    'onmessage',
    'onmessageerror',
    'onmousedown',
    'onmouseenter',
    'onmouseleave',
    'onmousemove',
    'onmouseout',
    'onmouseover',
    'onmouseup',
    'onmousewheel',
    'onoffline',
    'ononline',
    'onpagehide',
    'onpagereveal',
    'onpageshow',
    'onpageswap',
    'onpause',
    'onplay',
    'onplaying',
    'onpointercancel',
    'onpointerdown',
    'onpointerenter',
    'onpointerleave',
    'onpointermove',
    'onpointerout',
    'onpointerover',
    'onpointerup',
    'onpopstate',
    'onprogress',
    'onratechange',
    'onrejectionhandled',
    'onreset',
    'onresize',
    'onscroll',
    'onscrollend',
    'onscrollsnapchange',
    'onscrollsnapchanging',
    'onsearch',
    'onsecuritypolicyviolation',
    'onseeked',
    'onseeking',
    'onselect',
    'onselectionchange',
    'onselectstart',
    'onslotchange',
    'onstalled',
    'onstorage',
    'onsubmit',
    'onsuspend',
    'ontimeupdate',
    'ontoggle',
    'ontransitioncancel',
    'ontransitionend',
    'ontransitionrun',
    'ontransitionstart',
    'onunhandledrejection',
    'onunload',
    'onvolumechange',
    'onwaiting',
    'onwebkitanimationend',
    'onwebkitanimationiteration',
    'onwebkitanimationstart',
    'onwebkittransitionend',
    'onwheel',
  ]);
  const collectionQuery = Symbol('zp.collection.query');
  const screenSlots = new WeakMap();
  let viewport = makeViewport({});
  let visualViewport = null;
  let screenOrientation = null;
  let performanceObject = null;
  let performanceNavigationName = 'about:blank';
  let windowEventTarget = null;
  let windowNameValue = '';
  let windowStatusValue = '';
  let windowEventValue = undefined;
  let windowOpenerValue = null;
  let layoutRects = Object.create(null);
  const domExceptionCodes = {
    IndexSizeError: 1,
    DOMStringSizeError: 2,
    HierarchyRequestError: 3,
    WrongDocumentError: 4,
    InvalidCharacterError: 5,
    NoDataAllowedError: 6,
    NoModificationAllowedError: 7,
    NotFoundError: 8,
    NotSupportedError: 9,
    InUseAttributeError: 10,
    InvalidStateError: 11,
    SyntaxError: 12,
    InvalidModificationError: 13,
    NamespaceError: 14,
    InvalidAccessError: 15,
    ValidationError: 16,
    TypeMismatchError: 17,
    SecurityError: 18,
    NetworkError: 19,
    AbortError: 20,
    URLMismatchError: 21,
    QuotaExceededError: 22,
    TimeoutError: 23,
    InvalidNodeTypeError: 24,
    DataCloneError: 25,
  };
  const domExceptionConstantNames = {
    IndexSizeError: 'INDEX_SIZE_ERR',
    DOMStringSizeError: 'DOMSTRING_SIZE_ERR',
    HierarchyRequestError: 'HIERARCHY_REQUEST_ERR',
    WrongDocumentError: 'WRONG_DOCUMENT_ERR',
    InvalidCharacterError: 'INVALID_CHARACTER_ERR',
    NoModificationAllowedError: 'NO_MODIFICATION_ALLOWED_ERR',
    NoDataAllowedError: 'NO_DATA_ALLOWED_ERR',
    NotFoundError: 'NOT_FOUND_ERR',
    NotSupportedError: 'NOT_SUPPORTED_ERR',
    InUseAttributeError: 'INUSE_ATTRIBUTE_ERR',
    InvalidStateError: 'INVALID_STATE_ERR',
    SyntaxError: 'SYNTAX_ERR',
    InvalidModificationError: 'INVALID_MODIFICATION_ERR',
    NamespaceError: 'NAMESPACE_ERR',
    InvalidAccessError: 'INVALID_ACCESS_ERR',
    SecurityError: 'SECURITY_ERR',
    NetworkError: 'NETWORK_ERR',
    ValidationError: 'VALIDATION_ERR',
    TypeMismatchError: 'TYPE_MISMATCH_ERR',
    AbortError: 'ABORT_ERR',
    URLMismatchError: 'URL_MISMATCH_ERR',
    QuotaExceededError: 'QUOTA_EXCEEDED_ERR',
    TimeoutError: 'TIMEOUT_ERR',
    InvalidNodeTypeError: 'INVALID_NODE_TYPE_ERR',
    DataCloneError: 'DATA_CLONE_ERR',
  };

  const domExceptionState = new WeakMap();


  function DOMException(message = '', name = 'Error') {
    if (!new.target) throw new TypeError("Failed to construct 'DOMException': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    const errorName = String(name);
    domExceptionState.set(this, { message: String(message), name: errorName, code: domExceptionCodes[errorName] || 0 });
  }
  Object.setPrototypeOf(DOMException.prototype, Error.prototype);
  Object.defineProperty(DOMException.prototype, 'name', { get() { return domExceptionValue(this, 'name'); }, enumerable: true, configurable: true });
  Object.defineProperty(DOMException.prototype, 'message', { get() { return domExceptionValue(this, 'message'); }, enumerable: true, configurable: true });
  Object.defineProperty(DOMException.prototype, 'code', { get() { return domExceptionValue(this, 'code'); }, enumerable: true, configurable: true });
  Object.defineProperty(DOMException.prototype, Symbol.toStringTag, { value: 'DOMException', configurable: true });
  for (const [name, constantName] of Object.entries(domExceptionConstantNames)) {
    const code = domExceptionCodes[name];
    Object.defineProperty(DOMException, constantName, { value: code, enumerable: true, configurable: false });
    Object.defineProperty(DOMException.prototype, constantName, { value: code, enumerable: true, configurable: false });
  }

  function domExceptionValue(target, key) {
    const state = domExceptionState.get(target);
    if (!state) throw new TypeError('Illegal invocation');
    return state[key];
  }

  function namedError(name, message = name) {
    return new DOMException(message, name);
  }

  const virtualEventState = new WeakMap();
  function requiredVirtualEventType(args) {
    if (args.length < 1) throw new TypeError("Failed to construct 'Event': 1 argument required, but only 0 present.");
    return String(args[0]);
  }
  function virtualEventInit(args) {
    const init = args.length > 1 ? args[1] : {};
    return init === null || init === undefined ? {} : Object(init);
  }
  function virtualEventRecord(event) {
    const state = virtualEventState.get(event);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }
  function virtualEventValue(event, key) {
    return virtualEventRecord(event)[key];
  }
  function setVirtualEventField(event, key, value) {
    virtualEventRecord(event)[key] = value;
  }
  function defineVirtualEventGetter(proto, key, sourceKey = key) {
    Object.defineProperty(proto, key, { get() { return virtualEventValue(this, sourceKey); }, enumerable: true, configurable: true });
  }

  class VirtualEvent {
    constructor(type, init = {}) {
      const eventType = requiredVirtualEventType(arguments);
      const eventInit = virtualEventInit(arguments);
      virtualEventState.set(this, {
        type: eventType,
        bubbles: Boolean(eventInit.bubbles),
        cancelable: Boolean(eventInit.cancelable),
        composed: Boolean(eventInit.composed),
        defaultPrevented: false,
        target: null,
        currentTarget: null,
        eventPhase: 0,
        timeStamp: Date.now(),
      });
      Object.defineProperty(this, 'isTrusted', { value: false });
    }
    initEvent(type, bubbles = false, cancelable = false) {
      const state = virtualEventRecord(this);
      state.type = String(type || '');
      state.bubbles = Boolean(bubbles);
      state.cancelable = Boolean(cancelable);
      state.defaultPrevented = false;
    }
    preventDefault() {
      const state = virtualEventRecord(this);
      if (state.cancelable && !this.__zpPassive) state.defaultPrevented = true;
    }
    get returnValue() { return !virtualEventValue(this, 'defaultPrevented'); }
    set returnValue(value) { if (value === false) this.preventDefault(); }
    get cancelBubble() { return Boolean(this.__zpStopped); }
    set cancelBubble(value) { if (value) this.stopPropagation(); }
    get srcElement() { return virtualEventValue(this, 'target'); }
    composedPath() { return this.__zpPath ? [...this.__zpPath] : []; }
    stopPropagation() { this.__zpStopped = true; }
    stopImmediatePropagation() { this.__zpStopped = true; this.__zpImmediateStopped = true; }
  }
  Object.defineProperty(VirtualEvent, 'name', { value: 'Event', configurable: true });
  function defineVirtualEventConstant(name, value) {
    Object.defineProperty(VirtualEvent, name, { value, enumerable: true });
    Object.defineProperty(VirtualEvent.prototype, name, { value, enumerable: true });
  }
  function installVirtualEventPrototype() {
    const proto = VirtualEvent.prototype;
    const descriptors = Object.fromEntries(Object.getOwnPropertyNames(proto).map((name) => [name, Object.getOwnPropertyDescriptor(proto, name)]));
    for (const name of Object.keys(descriptors)) delete proto[name];
    for (const key of ['type', 'target', 'currentTarget', 'eventPhase', 'bubbles', 'cancelable', 'defaultPrevented', 'composed', 'timeStamp']) defineVirtualEventGetter(proto, key);
    defineVirtualEventGetter(proto, 'srcElement', 'target');
    Object.defineProperty(proto, 'returnValue', { ...descriptors.returnValue, enumerable: true, configurable: true });
    Object.defineProperty(proto, 'cancelBubble', { ...descriptors.cancelBubble, enumerable: true, configurable: true });
    for (const [name, value] of Object.entries({ NONE: 0, CAPTURING_PHASE: 1, AT_TARGET: 2, BUBBLING_PHASE: 3 })) defineVirtualEventConstant(name, value);
    for (const name of ['composedPath', 'initEvent', 'preventDefault', 'stopImmediatePropagation', 'stopPropagation', 'constructor']) Object.defineProperty(proto, name, { ...descriptors[name], enumerable: name !== 'constructor', configurable: true });
    Object.defineProperty(proto, Symbol.toStringTag, { value: 'Event', configurable: true });
  }
  installVirtualEventPrototype();


  class VirtualEventTarget {
    addEventListener(type, callback, options = {}) {
      if (typeof callback !== 'function' && !callback?.handleEvent) return;
      const normalized = normalizeListenerOptions(options);
      if (normalized.signal?.aborted) return;
      const bucket = listenerBucket(this, type);
      if (!bucket.some((entry) => entry.callback === callback && entry.capture === normalized.capture)) {
        const entry = { callback, capture: normalized.capture, once: normalized.once, passive: normalized.passive, signal: normalized.signal || null, abortCallback: null };
        if (entry.signal?.addEventListener) {
          entry.abortCallback = () => this.removeEventListener(type, callback, { capture: normalized.capture });
          entry.signal.addEventListener('abort', entry.abortCallback, { once: true });
        }
        bucket.push(entry);
      }
    }
    removeEventListener(type, callback, options = {}) {
      const capture = normalizeListenerOptions(options).capture;
      const bucket = listenerBucket(this, type);
      const index = bucket.findIndex((entry) => entry.callback === callback && entry.capture === capture);
      if (index >= 0) {
        const [entry] = bucket.splice(index, 1);
        if (entry.signal?.removeEventListener && entry.abortCallback) entry.signal.removeEventListener('abort', entry.abortCallback, { capture: false });
      }
    }
    dispatchEvent(event) {
      const ev = event instanceof VirtualEvent ? event : new VirtualEvent(event?.type || event);
      if (!ev.target) setVirtualEventField(ev, 'target', this);
      currentPerformance().__zpCountEvent(ev.type);
      ev.__zpStopped = false;
      ev.__zpImmediateStopped = false;
      const path = eventPath(this);
      ev.__zpPath = path;
      invokePath(path.slice(1).reverse(), ev, 1, true);
      if (!ev.__zpStopped) invokePath([this], ev, 2, true);
      if (!ev.__zpStopped) invokePath([this], ev, 2, false);
      if (ev.bubbles && !ev.__zpStopped) invokePath(path.slice(1), ev, 3, false);
      setVirtualEventField(ev, 'eventPhase', 0);
      setVirtualEventField(ev, 'currentTarget', null);
      return !ev.defaultPrevented;
    }
    when(type) { return new Promise((resolve) => this.addEventListener(type, resolve, { once: true })); }
  }
  Object.defineProperty(VirtualEventTarget, 'name', { value: 'EventTarget', configurable: true });
  Object.defineProperty(VirtualEventTarget.prototype, Symbol.toStringTag, { value: 'EventTarget', configurable: true });


  const abortSignalState = new WeakMap();
  function abortReason() {
    return new DOMException('The operation was aborted.', 'AbortError');
  }
  function timeoutReason() {
    return new DOMException('The operation timed out.', 'TimeoutError');
  }
  function AbortSignal() {
    throw new TypeError('Use \`new AbortSignal(...)\` instead of \`AbortSignal(...)\`');
  }
  Object.setPrototypeOf(AbortSignal.prototype, VirtualEventTarget.prototype);
  Object.defineProperty(AbortSignal, Symbol.hasInstance, { value: (value) => abortSignalState.has(value), configurable: true });
  Object.defineProperties(AbortSignal.prototype, {
    aborted: { get() { return abortSignalValue(this, 'aborted'); }, enumerable: true, configurable: true },
    reason: { get() { return abortSignalValue(this, 'reason'); }, enumerable: true, configurable: true },
    onabort: {
      get() { return abortSignalValue(this, 'onabort'); },
      set(value) { abortSignalRecord(this).onabort = typeof value === 'function' ? value : null; },
      enumerable: true,
      configurable: true,
    },
    throwIfAborted: {
      value: function throwIfAborted() {
        const state = abortSignalRecord(this);
        if (state.aborted) throw state.reason;
      },
      enumerable: true,
      configurable: true,
      writable: true,
    },
    [Symbol.toStringTag]: { value: 'AbortSignal', configurable: true },
  });
  function makeAbortSignal() {
    const signal = Object.create(AbortSignal.prototype);
    abortSignalState.set(signal, { aborted: false, reason: undefined, onabort: null });
    return signal;
  }
  function abortSignalRecord(signal) {
    const state = abortSignalState.get(signal);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }
  function abortSignalValue(signal, key) {
    return abortSignalRecord(signal)[key];
  }
  function abortSignalAbort(signal, reason = abortReason()) {
    const state = abortSignalRecord(signal);
    if (state.aborted) return;
    state.aborted = true;
    state.reason = reason;
    signal.dispatchEvent(new VirtualEvent('abort'));
  }
  function validateAbortSignalSequence(signals) {
    if (signals == null || typeof signals[Symbol.iterator] !== 'function') {
      throw new TypeError('signals can not be converted to sequence');
    }
    return signals;
  }
  function validateAbortSignalTimeout(milliseconds) {
    const value = Number(milliseconds);
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      throw new TypeError('Value ' + milliseconds + ' is outside the range [0, 9007199254740991]');
    }
    return value;
  }
  AbortSignal.abort = function abort(reason = abortReason()) {
    const signal = makeAbortSignal();
    abortSignalAbort(signal, reason);
    return signal;
  };
  AbortSignal.timeout = function timeout(milliseconds) {
    const delay = validateAbortSignalTimeout(milliseconds);
    const signal = makeAbortSignal();
    if (typeof setTimeout === 'function') setTimeout(() => abortSignalAbort(signal, timeoutReason()), delay);
    else abortSignalAbort(signal, timeoutReason());
    return signal;
  };
  AbortSignal.any = function any(signals) {
    const signal = makeAbortSignal();
    for (const input of validateAbortSignalSequence(signals)) {
      if (input?.aborted) {
        abortSignalAbort(signal, input.reason);
        break;
      }
      input?.addEventListener?.('abort', () => abortSignalAbort(signal, input.reason), { once: true });
    }
    return signal;
  };

  const abortControllerState = new WeakMap();
  class AbortController {
    constructor() { abortControllerState.set(this, { signal: makeAbortSignal() }); }
    get signal() { return abortControllerValue(this).signal; }
    abort(reason = abortReason()) { abortSignalAbort(this.signal, reason); }
  }
  function abortControllerValue(controller) {
    const state = abortControllerState.get(controller);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }
  Object.defineProperty(AbortController.prototype, Symbol.toStringTag, { value: 'AbortController', configurable: true });
  makeDescriptorsEnumerable(AbortController.prototype, ['signal', 'abort']);

  const closeWatcherState = new WeakMap();
  function CloseWatcher(options = {}) {
    if (!new.target) throw new TypeError("Failed to construct 'CloseWatcher': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    const watcher = Reflect.construct(VirtualEventTarget, [], new.target);
    const signal = options?.signal || null;
    const state = { active: true, signal, abortHandler: null, oncancel: null, onclose: null };
    state.abortHandler = () => closeWatcherDestroy(watcher);
    closeWatcherState.set(watcher, state);
    if (signal?.aborted) closeWatcherDestroy(watcher);
    else signal?.addEventListener?.('abort', state.abortHandler, { once: true });
    return watcher;
  }
  CloseWatcher.prototype = Object.create(VirtualEventTarget.prototype);
  Object.defineProperties(CloseWatcher.prototype, {
    oncancel: {
      get() { return closeWatcherValue(this).oncancel; },
      set(value) { closeWatcherValue(this).oncancel = typeof value === 'function' ? value : null; },
      enumerable: true,
      configurable: true,
    },
    onclose: {
      get() { return closeWatcherValue(this).onclose; },
      set(value) { closeWatcherValue(this).onclose = typeof value === 'function' ? value : null; },
      enumerable: true,
      configurable: true,
    },
    close: { value: function close() {
      if (!closeWatcherDeactivate(this)) return;
      this.dispatchEvent(new VirtualEvent('close'));
    }, enumerable: true, writable: true, configurable: true },
    destroy: { value: function destroy() { closeWatcherDestroy(this); }, enumerable: true, writable: true, configurable: true },
    requestClose: { value: function requestClose() {
      if (!closeWatcherValue(this).active) return;
      if (this.dispatchEvent(new VirtualEvent('cancel', { cancelable: true }))) this.close();
    }, enumerable: true, writable: true, configurable: true },
    constructor: { value: CloseWatcher, enumerable: false, writable: true, configurable: true },
  });
  function closeWatcherValue(watcher) {
    const state = closeWatcherState.get(watcher);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }
  function closeWatcherDestroy(watcher) {
    closeWatcherDeactivate(watcher);
  }
  function closeWatcherDeactivate(watcher) {
    const state = closeWatcherValue(watcher);
    if (!state.active) return false;
    state.active = false;
    state.signal?.removeEventListener?.('abort', state.abortHandler);
    return true;
  }
  Object.defineProperty(CloseWatcher.prototype, Symbol.toStringTag, { value: 'CloseWatcher', configurable: true });


  class VirtualNode extends VirtualEventTarget {
    constructor(type, nodeName, ownerDocument, nodeId) {
      super();
      this.__zpNodeType = type;
      this.__zpNodeName = nodeName;
      this.__zpOwnerDocument = ownerDocument || null;
      this.__zpParentNode = null;
      this.__zpChildren = [];
      Object.defineProperty(this, 'childNodes', {
        value: liveCollection(() => this.__zpChildren, 'NodeList'),
        enumerable: true,
        configurable: true
      });
      this.__zpNodeId = nodeId || makeNodeId();
      nodes.set(this.__zpNodeId, this);
    }
    appendChild(child) { return appendNode(this, child, true); }
    removeChild(child) { return removeNode(this, child, true); }
    insertBefore(child, before) { return insertNode(this, child, before, true); }
    replaceChild(next, old) { this.insertBefore(next, old); this.removeChild(old); return old; }
    cloneNode(deep = false) { return cloneVirtualNode(this, Boolean(deep)); }
    contains(node) { for (let cur = node; cur; cur = cur.parentNode) if (cur === this) return true; return false; }
    hasChildNodes() { return this.__zpChildren.length > 0; }
    getRootNode(options = {}) { return rootOf(this, Boolean(options?.composed)); }
    get isConnected() { return rootOf(this, true)?.nodeType === 9; }
    isSameNode(other) { return this === other; }
    isEqualNode(other) { return equalVirtualNodes(this, other); }
    compareDocumentPosition(other) { return compareVirtualDocumentPosition(this, other); }
    normalize() { normalizeVirtualNode(this); }
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
    get firstChild() { return this.__zpChildren[0] || null; }
    get lastChild() { return this.__zpChildren[this.__zpChildren.length - 1] || null; }
    get previousSibling() { return siblingOf(this, -1); }
    get nextSibling() { return siblingOf(this, 1); }
    get textContent() { return this.__zpChildren.filter((child) => child.nodeType !== 8).map((child) => child.textContent).join(''); }
    set textContent(value) { setNodeText(this, String(value ?? '')); }
  }
  const nodeConstants = {
    ELEMENT_NODE: 1,
    ATTRIBUTE_NODE: 2,
    TEXT_NODE: 3,
    CDATA_SECTION_NODE: 4,
    PROCESSING_INSTRUCTION_NODE: 7,
    COMMENT_NODE: 8,
    DOCUMENT_NODE: 9,
    DOCUMENT_TYPE_NODE: 10,
    DOCUMENT_FRAGMENT_NODE: 11,
    ENTITY_REFERENCE_NODE: 5,
    ENTITY_NODE: 6,
    NOTATION_NODE: 12,
    DOCUMENT_POSITION_DISCONNECTED: 1,
    DOCUMENT_POSITION_PRECEDING: 2,
    DOCUMENT_POSITION_FOLLOWING: 4,
    DOCUMENT_POSITION_CONTAINS: 8,
    DOCUMENT_POSITION_CONTAINED_BY: 16,
    DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 32,
  };
  for (const [name, value] of Object.entries(nodeConstants)) {
    Object.defineProperty(VirtualNode, name, { value, enumerable: true });
    Object.defineProperty(VirtualNode.prototype, name, { value, enumerable: true });
  }
  Object.defineProperties(VirtualNode.prototype, {
    ownerDocument: { get() { return this.__zpOwnerDocument || null; }, enumerable: true, configurable: true },
    parentNode: { get() { return this.__zpParentNode || null; }, enumerable: true, configurable: true },
    baseURI: { get() { return this.ownerDocument?.location?.href || globalThis.location?.href || 'about:blank'; }, enumerable: true, configurable: true },
    childNodes: { get() { return liveCollection(() => this.__zpChildren || [], 'NodeList'); }, enumerable: true, configurable: true },
    nodeName: { get() { return this.__zpNodeName ?? this.__zpName ?? ''; }, enumerable: true, configurable: true },
    nodeType: { get() { return this.__zpNodeType ?? 0; }, enumerable: true, configurable: true },
    nodeValue: { get() { if (this.__zpNodeType === 2) return this.value; if (this.__zpNodeType === 3 || this.__zpNodeType === 4 || this.__zpNodeType === 7 || this.__zpNodeType === 8) return this.data; return null; }, set(value) { if (this.__zpNodeType === 2) this.value = value; else if (this.__zpNodeType === 3 || this.__zpNodeType === 4 || this.__zpNodeType === 7 || this.__zpNodeType === 8) this.textContent = value; }, enumerable: true, configurable: true },
    isDefaultNamespace: { value: function isDefaultNamespace(namespaceURI) { return (this.lookupNamespaceURI(null) || null) === (namespaceURI === undefined ? null : namespaceURI); }, enumerable: true, writable: true, configurable: true },
    lookupNamespaceURI: { value: function lookupNamespaceURI(prefix) { const wanted = prefix === undefined ? null : prefix; return this.namespaceURI && wanted === (this.prefix || null) ? this.namespaceURI : (this.parentNode?.lookupNamespaceURI?.(prefix) ?? null); }, enumerable: true, writable: true, configurable: true },
    lookupPrefix: { value: function lookupPrefix(namespaceURI) { return this.namespaceURI === namespaceURI ? (this.prefix || null) : (this.parentNode?.lookupPrefix?.(namespaceURI) ?? null); }, enumerable: true, writable: true, configurable: true },
  });


  function childNodeBefore(...values) {
    if (!this.parentNode) return;
    for (const node of values.map((value) => coerceNode(value, this.ownerDocument))) this.parentNode.insertBefore(node, this);
  }

  function childNodeAfter(...values) {
    if (!this.parentNode) return;
    const before = this.nextSibling;
    for (const node of values.map((value) => coerceNode(value, this.ownerDocument))) this.parentNode.insertBefore(node, before);
  }

  function childNodeRemove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  function childNodeReplaceWith(...values) {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    const before = this.nextSibling;
    for (const node of values.map((value) => coerceNode(value, this.ownerDocument))) parent.insertBefore(node, before);
    parent.removeChild(this);
  }

  function defineChildNodeMethods(proto) {
    Object.defineProperties(proto, {
      before: { value: childNodeBefore, enumerable: true, writable: true, configurable: true },
      after: { value: childNodeAfter, enumerable: true, writable: true, configurable: true },
      remove: { value: childNodeRemove, enumerable: true, writable: true, configurable: true },
      replaceWith: { value: childNodeReplaceWith, enumerable: true, writable: true, configurable: true },
    });
  }
  function cloneVirtualNode(node, deep, ownerDocument = null) {
    const clone = cloneVirtualNodeShallow(node, ownerDocument);
    if (deep) for (const child of node.__zpChildren || []) clone.appendChild(cloneVirtualNode(child, true, ownerDocument || clone.ownerDocument));
    return clone;
  }

  function cloneVirtualNodeShallow(node, ownerDocument = null) {
    const doc = nodeOwnerDocument(node, ownerDocument);
    if (node?.nodeType === 3) return new Text(node.textContent || '', doc);
    if (node?.nodeType === 8) return new Comment(node.textContent || '', doc);
    if (node?.nodeType === 4) return new VirtualCDATASection(node.textContent || '', doc);
    if (node?.nodeType === 7) return new VirtualProcessingInstruction(node.target || node.nodeName, node.textContent || '', doc);
    if (node?.nodeType === 11) return doc?.createDocumentFragment?.() || new VirtualNode(11, '#document-fragment', doc);
    if (node?.nodeType === 9) return new VirtualDocument(String(node.location?.href || 'about:blank'));
    if (node?.nodeType !== 1) return new VirtualNode(node?.nodeType || 0, node?.nodeName || '', doc);
    const clone = doc.createElementNS(node.namespaceURI || HTML_NS, node.localName || node.nodeName);
    copyVirtualNodeAttributes(node, clone);
    return clone;
  }

  function copyVirtualNodeAttributes(source, target) {
    const attrs = source?.__zpAttributes ? Array.from(source.__zpAttributes.values()) : [];
    for (const attr of attrs) {
      if (attr.namespaceURI) target.setAttributeNS(attr.namespaceURI, attr.name, attr.value || '');
      else target.setAttribute(attr.name, attr.value || '');
    }
  }

  function nodeOwnerDocument(node, ownerDocument = null) {
    return ownerDocument || (node?.nodeType === 9 ? node : (node?.ownerDocument || globalThis.document || null));
  }

  function updateOwnerDocument(node, ownerDocument) {
    node.__zpOwnerDocument = ownerDocument || null;
    for (const child of node.__zpChildren || []) updateOwnerDocument(child, ownerDocument);
  }

  function rootOf(node, composed = false) {
    let root = node;
    while (root?.parentNode) root = root.parentNode;
    return composed && root?.host ? rootOf(root.host, true) : root;
  }

  function compareVirtualDocumentPosition(node, other) {
    if (node === other) return 0;
    if (!(other instanceof VirtualNode)) return nodeConstants.DOCUMENT_POSITION_DISCONNECTED | nodeConstants.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC;
    const root = rootOf(node);
    if (root !== rootOf(other)) return nodeConstants.DOCUMENT_POSITION_DISCONNECTED | nodeConstants.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC;
    if (node.contains(other)) return nodeConstants.DOCUMENT_POSITION_CONTAINED_BY | nodeConstants.DOCUMENT_POSITION_FOLLOWING;
    if (other.contains(node)) return nodeConstants.DOCUMENT_POSITION_CONTAINS | nodeConstants.DOCUMENT_POSITION_PRECEDING;
    return documentOrderIndex(root, node) < documentOrderIndex(root, other) ? nodeConstants.DOCUMENT_POSITION_FOLLOWING : nodeConstants.DOCUMENT_POSITION_PRECEDING;
  }

  function documentOrderIndex(root, target) {
    const stack = [root];
    let index = 0;
    while (stack.length) {
      const node = stack.shift();
      if (node === target) return index;
      index += 1;
      stack.unshift(...(node.__zpChildren || []).slice().reverse());
    }
    return -1;
  }

  function normalizeVirtualNode(node) {
    let previousText = null;
    for (const child of [...node.__zpChildren]) {
      if (child.nodeType !== 3) {
        previousText = null;
        child.normalize?.();
        continue;
      }
      if (!child.textContent) { node.removeChild(child); continue; }
      if (previousText) {
        previousText.textContent += child.textContent;
        node.removeChild(child);
      } else previousText = child;
    }
  }

  function equalVirtualNodes(left, right) {
    if (!(right instanceof VirtualNode) || left.nodeType !== right.nodeType || left.nodeName !== right.nodeName) return false;
    if (!equalVirtualNodeValue(left, right) || !equalVirtualNodeAttributes(left, right)) return false;
    const leftChildren = left.__zpChildren || [];
    const rightChildren = right.__zpChildren || [];
    return leftChildren.length === rightChildren.length && leftChildren.every((child, index) => equalVirtualNodes(child, rightChildren[index]));
  }

  function equalVirtualNodeValue(left, right) {
    return left.nodeType === 3 || left.nodeType === 4 || left.nodeType === 7 || left.nodeType === 8 ? left.textContent === right.textContent : left.localName === right.localName && left.namespaceURI === right.namespaceURI;
  }

  function equalVirtualNodeAttributes(left, right) {
    const leftAttrs = sortedVirtualAttrs(left);
    const rightAttrs = sortedVirtualAttrs(right);
    return leftAttrs.length === rightAttrs.length && leftAttrs.every((attr, index) => attr === rightAttrs[index]);
  }

  function sortedVirtualAttrs(node) {
    return Array.from(node?.attributes?.values?.() || []).map((attr) => (attr.namespaceURI || '') + '\u0000' + attr.name + '\u0000' + (attr.value || '')).sort();
  }
  function CharacterData() { throw new TypeError("Failed to construct 'CharacterData': Illegal constructor"); }
  Object.defineProperty(CharacterData, Symbol.hasInstance, { value: (value) => value instanceof VirtualText || value instanceof VirtualComment || value instanceof VirtualCDATASection || value instanceof VirtualProcessingInstruction, configurable: true });
  Object.defineProperty(CharacterData.prototype, Symbol.toStringTag, { value: 'CharacterData', configurable: true });
  Object.setPrototypeOf(CharacterData.prototype, VirtualNode.prototype);
  Object.defineProperties(CharacterData.prototype, {
    data: { get() { return Object.prototype.hasOwnProperty.call(this, 'data') ? Object.getOwnPropertyDescriptor(this, 'data').value : ''; }, set(value) { this.textContent = value; }, enumerable: true, configurable: true },
    length: { get() { return String(this.data ?? '').length; }, enumerable: true, configurable: true },
    previousElementSibling: { get() { for (let node = this.previousSibling; node; node = node.previousSibling) if (node.nodeType === 1) return node; return null; }, enumerable: true, configurable: true },
    nextElementSibling: { get() { for (let node = this.nextSibling; node; node = node.nextSibling) if (node.nodeType === 1) return node; return null; }, enumerable: true, configurable: true },
    appendData: { value: function appendData(data) { this.textContent = String(this.data ?? '') + String(data); }, enumerable: true, writable: true, configurable: true },
    deleteData: { value: function deleteData(offset, count) { const start = characterDataOffset(this, offset); const remove = Math.max(0, Number(count) || 0); this.textContent = String(this.data ?? '').slice(0, start) + String(this.data ?? '').slice(start + remove); }, enumerable: true, writable: true, configurable: true },
    insertData: { value: function insertData(offset, data) { const start = characterDataOffset(this, offset); const text = String(this.data ?? ''); this.textContent = text.slice(0, start) + String(data) + text.slice(start); }, enumerable: true, writable: true, configurable: true },
    replaceData: { value: function replaceData(offset, count, data) { const start = characterDataOffset(this, offset); const text = String(this.data ?? ''); const remove = Math.max(0, Number(count) || 0); this.textContent = text.slice(0, start) + String(data) + text.slice(start + remove); }, enumerable: true, writable: true, configurable: true },
    substringData: { value: function substringData(offset, count) { const start = characterDataOffset(this, offset); return String(this.data ?? '').slice(start, start + Math.max(0, Number(count) || 0)); }, enumerable: true, writable: true, configurable: true },
    [Symbol.unscopables]: { value: { after: true, before: true, remove: true, replaceWith: true }, configurable: true },
  });
  defineChildNodeMethods(CharacterData.prototype);

  class VirtualText extends VirtualNode {
    constructor(text, ownerDocument, nodeId) { super(3, '#text', ownerDocument, nodeId); this.data = String(text || ''); }
    get textContent() { return this.data; }
    set textContent(value) { const old = this.data; this.data = String(value ?? ''); emit('dom.text', { nodeId: this.__zpNodeId, text: this.data }); notifyMutation({ type: 'characterData', target: this, oldValue: old, addedNodes: [], removedNodes: [] }); }
  }
  Object.defineProperty(VirtualText, 'name', { value: 'CharacterData', configurable: true });
  class Text extends VirtualText {
    constructor(data = '', ownerDocument = globalThis.document || null, nodeId) { super(data, ownerDocument, nodeId); }
    get wholeText() { return adjacentText(this, -1).reverse().concat(this, adjacentText(this, 1)).map((node) => node.data).join(''); }
    get assignedSlot() { return null; }
    splitText(offset) {
      const index = Number(offset ?? 0);
      if (!Number.isInteger(index) || index < 0 || index > this.data.length) throw namedError('IndexSizeError');
      const tail = this.data.slice(index);
      this.textContent = this.data.slice(0, index);
      const next = new Text(tail, this.ownerDocument);
      if (this.parentNode) this.parentNode.insertBefore(next, this.nextSibling);
      return next;
    }
  }

  function adjacentText(node, direction) {
    const result = [];
    for (let current = direction < 0 ? node.previousSibling : node.nextSibling; current?.nodeType === 3; current = direction < 0 ? current.previousSibling : current.nextSibling) result.push(current);
    return result;
  }
  Object.defineProperty(Text.prototype, Symbol.toStringTag, { value: 'Text', configurable: true });



  class VirtualComment extends VirtualNode {
    constructor(text, ownerDocument, nodeId) { super(8, '#comment', ownerDocument, nodeId); this.data = String(text || ''); }
    get textContent() { return this.data; }
    set textContent(value) { const old = this.data; this.data = String(value ?? ''); notifyMutation({ type: 'characterData', target: this, oldValue: old, addedNodes: [], removedNodes: [] }); }
  }
  Object.defineProperty(VirtualComment, 'name', { value: 'CharacterData', configurable: true });
  class Comment extends VirtualComment { constructor(data = '', ownerDocument = globalThis.document || null, nodeId) { super(data, ownerDocument, nodeId); } }
  Object.defineProperty(Comment.prototype, Symbol.toStringTag, { value: 'Comment', configurable: true });


  function CDATASection() { throw new TypeError("Failed to construct 'CDATASection': Illegal constructor"); }
  Object.defineProperty(CDATASection, Symbol.hasInstance, { value: (value) => value instanceof VirtualCDATASection, configurable: true });

  class VirtualCDATASection extends VirtualNode {
    constructor(text, ownerDocument, nodeId) { super(4, '#cdata-section', ownerDocument, nodeId); this.data = String(text || ''); }
    get textContent() { return this.data; }
    set textContent(value) { const old = this.data; this.data = String(value ?? ''); notifyMutation({ type: 'characterData', target: this, oldValue: old, addedNodes: [], removedNodes: [] }); }
  }
  Object.defineProperty(VirtualCDATASection.prototype, Symbol.toStringTag, { value: 'CDATASection', configurable: true });


  function ProcessingInstruction() { throw new TypeError("Failed to construct 'ProcessingInstruction': Illegal constructor"); }
  Object.defineProperty(ProcessingInstruction, Symbol.hasInstance, { value: (value) => value instanceof VirtualProcessingInstruction, configurable: true });

  class VirtualProcessingInstruction extends VirtualNode {
    constructor(target, data, ownerDocument, nodeId) {
      const normalizedTarget = String(target || '');
      super(7, normalizedTarget, ownerDocument, nodeId);
      this.target = normalizedTarget;
      this.data = String(data || '');
    }
    get textContent() { return this.data; }
    set textContent(value) { const old = this.data; this.data = String(value ?? ''); notifyMutation({ type: 'characterData', target: this, oldValue: old, addedNodes: [], removedNodes: [] }); }
  }
  Object.defineProperty(VirtualProcessingInstruction.prototype, Symbol.toStringTag, { value: 'ProcessingInstruction', configurable: true });

  for (const proto of [VirtualText.prototype, VirtualComment.prototype, VirtualCDATASection.prototype, VirtualProcessingInstruction.prototype]) {
    Object.defineProperties(proto, {
      length: { get() { return this.data.length; }, configurable: true },
      nodeValue: { get() { return this.data; }, set(value) { this.textContent = value; }, configurable: true },
      appendData: { value(data) { this.textContent = this.data + String(data); }, configurable: true },
      deleteData: { value(offset, count) { const start = characterDataOffset(this, offset); const remove = Math.max(0, Number(count) || 0); this.textContent = this.data.slice(0, start) + this.data.slice(start + remove); }, configurable: true },
      insertData: { value(offset, data) { const start = characterDataOffset(this, offset); this.textContent = this.data.slice(0, start) + String(data) + this.data.slice(start); }, configurable: true },
      replaceData: { value(offset, count, data) { const start = characterDataOffset(this, offset); const remove = Math.max(0, Number(count) || 0); this.textContent = this.data.slice(0, start) + String(data) + this.data.slice(start + remove); }, configurable: true },
      substringData: { value(offset, count) { const start = characterDataOffset(this, offset); return this.data.slice(start, start + Math.max(0, Number(count) || 0)); }, configurable: true },
    });
  }

  function characterDataOffset(node, offset) {
    const index = Number(offset);
    if (!Number.isInteger(index) || index < 0 || index > node.data.length) throw namedError('IndexSizeError');
    return index;
  }


  function VirtualNodeList() { throw new TypeError("Failed to construct 'NodeList': Illegal constructor"); }
  Object.defineProperty(VirtualNodeList, 'name', { value: 'NodeList', configurable: true });
  {
    const constructorDescriptor = Object.getOwnPropertyDescriptor(VirtualNodeList.prototype, 'constructor');
    delete VirtualNodeList.prototype.constructor;
    Object.defineProperties(VirtualNodeList.prototype, {
      entries: { value: collectionEntries, enumerable: true, writable: true, configurable: true },
      keys: { value: collectionKeys, enumerable: true, writable: true, configurable: true },
      values: { value: collectionValues, enumerable: true, writable: true, configurable: true },
      forEach: { value: collectionForEach, enumerable: true, writable: true, configurable: true },
      length: { get: collectionLength, enumerable: true, configurable: true },
      item: { value: function item(index) { return collectionItem(this, index); }, enumerable: true, writable: true, configurable: true },
      constructor: constructorDescriptor,
      [Symbol.iterator]: { value: collectionValues, writable: true, configurable: true },
      [Symbol.toStringTag]: { value: 'NodeList', configurable: true },
    });
  }

  function VirtualHTMLCollection() { throw new TypeError("Failed to construct 'HTMLCollection': Illegal constructor"); }
  Object.defineProperty(VirtualHTMLCollection, 'name', { value: 'HTMLCollection', configurable: true });
  {
    const constructorDescriptor = Object.getOwnPropertyDescriptor(VirtualHTMLCollection.prototype, 'constructor');
    delete VirtualHTMLCollection.prototype.constructor;
    Object.defineProperties(VirtualHTMLCollection.prototype, {
      length: { get: collectionLength, enumerable: true, configurable: true },
      item: { value: function item(index) { return collectionItem(this, index); }, enumerable: true, writable: true, configurable: true },
      namedItem: { value: collectionNamedItem, enumerable: true, writable: true, configurable: true },
      constructor: constructorDescriptor,
      [Symbol.iterator]: { value: collectionValues, writable: true, configurable: true },
      [Symbol.toStringTag]: { value: 'HTMLCollection', configurable: true },
    });
  }


  function Window() { throw new TypeError("Failed to construct 'Window': Illegal constructor"); }
  Object.defineProperty(Window, Symbol.hasInstance, { value: (value) => value === globalThis, configurable: true });

  const barPropSlots = new WeakMap();
  function BarProp() {
    if (new.target) throw new TypeError("Failed to construct 'BarProp': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  delete BarProp.prototype.constructor;
  Object.defineProperty(BarProp.prototype, 'visible', {
    get() {
      const state = barPropSlots.get(this);
      if (!state) throw new TypeError('Illegal invocation');
      return state.visible;
    },
    enumerable: true,
    configurable: true,
  });

  function makeBarProp(visible = true) {
    const bar = Object.create(BarProp.prototype);
    barPropSlots.set(bar, { visible: Boolean(visible) });
    return bar;
  }
  Object.defineProperty(BarProp.prototype, 'constructor', { value: BarProp, writable: true, configurable: true });
  Object.defineProperty(BarProp.prototype, Symbol.toStringTag, { value: 'BarProp', configurable: true });

  const externalSlots = new WeakSet();
  function External() {
    if (new.target) throw new TypeError("Failed to construct 'External': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  delete External.prototype.constructor;
  Object.defineProperties(External.prototype, {
    AddSearchProvider: { value: function AddSearchProvider() {}, enumerable: true, writable: true, configurable: true },
    IsSearchProviderInstalled: { value: function IsSearchProviderInstalled() {}, enumerable: true, writable: true, configurable: true },
    constructor: { value: External, writable: true, configurable: true },
  });
  Object.defineProperty(External.prototype, Symbol.toStringTag, { value: 'External', configurable: true });
  function makeExternal() {
    const external = Object.create(External.prototype);
    externalSlots.add(external);
    return external;
  }

  const fragmentDirectiveSlots = new WeakSet();
  function FragmentDirective() { throw new TypeError("Failed to construct 'FragmentDirective': Illegal constructor"); }
  Object.defineProperty(FragmentDirective, Symbol.hasInstance, { value: (value) => fragmentDirectiveSlots.has(value), configurable: true });
  function makeFragmentDirective() {
    const directive = Object.create(FragmentDirective.prototype);
    fragmentDirectiveSlots.add(directive);
    return directive;
  }
  Object.defineProperty(FragmentDirective.prototype, Symbol.toStringTag, { value: 'FragmentDirective', configurable: true });

  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

  function HTMLElement() { throw new TypeError("Failed to construct 'HTMLElement': Illegal constructor"); }
  Object.defineProperty(HTMLElement, Symbol.hasInstance, { value: (value) => value instanceof VirtualElement && value.namespaceURI === HTML_NS, configurable: true });
  function SVGElement() { throw new TypeError("Failed to construct 'SVGElement': Illegal constructor"); }
  Object.defineProperty(SVGElement, Symbol.hasInstance, { value: (value) => value instanceof VirtualElement && value.namespaceURI === SVG_NS, configurable: true });
  function MathMLElement() { throw new TypeError("Failed to construct 'MathMLElement': Illegal constructor"); }
  Object.defineProperty(MathMLElement, Symbol.hasInstance, { value: (value) => value instanceof VirtualElement && value.namespaceURI === MATHML_NS, configurable: true });
  function HTMLDocument() { throw new TypeError("Failed to construct 'HTMLDocument': Illegal constructor"); }
  Object.defineProperty(HTMLDocument, Symbol.hasInstance, { value: (value) => value instanceof VirtualDocument && documentToStringTag(value) === 'HTMLDocument', configurable: true });
  function XMLDocument() { throw new TypeError("Failed to construct 'XMLDocument': Illegal constructor"); }
  Object.defineProperty(XMLDocument, Symbol.hasInstance, { value: (value) => value instanceof VirtualDocument && documentToStringTag(value) === 'XMLDocument', configurable: true });
  function makeDescriptorsEnumerable(owner, keys) {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) Object.defineProperty(owner, key, { ...descriptor, enumerable: true });
    }
  }
  const domRectState = new WeakMap();
  function setDOMRectState(target, x, y, width, height) {
    domRectState.set(target, {
      x: rectNumber(x),
      y: rectNumber(y),
      width: rectNumber(width),
      height: rectNumber(height),
    });
  }
  function domRectValue(target) {
    const state = domRectState.get(target);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }
  class DOMRectReadOnly {
    constructor(x = 0, y = 0, width = 0, height = 0) {
      setDOMRectState(this, x, y, width, height);
    }
    get x() { return domRectValue(this).x; }
    get y() { return domRectValue(this).y; }
    get width() { return domRectValue(this).width; }
    get height() { return domRectValue(this).height; }
    get top() { return Math.min(this.y, this.y + this.height); }
    get right() { return Math.max(this.x, this.x + this.width); }
    get bottom() { return Math.max(this.y, this.y + this.height); }
    get left() { return Math.min(this.x, this.x + this.width); }
    toJSON() {
      return { x: this.x, y: this.y, width: this.width, height: this.height, top: this.top, right: this.right, bottom: this.bottom, left: this.left };
    }
    static fromRect(other = {}) {
      return new DOMRectReadOnly(other?.x ?? 0, other?.y ?? 0, other?.width ?? 0, other?.height ?? 0);
    }
  }
  Object.defineProperty(DOMRectReadOnly.prototype, Symbol.toStringTag, { value: 'DOMRectReadOnly', configurable: true });

  class DOMRect extends DOMRectReadOnly {
    get x() { return domRectValue(this).x; }
    set x(value) { domRectValue(this).x = rectNumber(value); }
    get y() { return domRectValue(this).y; }
    set y(value) { domRectValue(this).y = rectNumber(value); }
    get width() { return domRectValue(this).width; }
    set width(value) { domRectValue(this).width = rectNumber(value); }
    get height() { return domRectValue(this).height; }
    set height(value) { domRectValue(this).height = rectNumber(value); }
    static fromRect(other = {}) {
      return new DOMRect(other?.x ?? 0, other?.y ?? 0, other?.width ?? 0, other?.height ?? 0);
    }
  }
  Object.defineProperty(DOMRect.prototype, Symbol.toStringTag, { value: 'DOMRect', configurable: true });
  function DOMRectList() { throw new TypeError("Failed to construct 'DOMRectList': Illegal constructor"); }
  makeDescriptorsEnumerable(DOMRectReadOnly.prototype, ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left', 'toJSON']);
  makeDescriptorsEnumerable(DOMRectReadOnly, ['fromRect']);
  makeDescriptorsEnumerable(DOMRect.prototype, ['x', 'y', 'width', 'height']);
  makeDescriptorsEnumerable(DOMRect, ['fromRect']);
  Object.defineProperty(DOMRectList, Symbol.hasInstance, { value: (value) => Boolean(value?.__zpDOMRectList), configurable: true });
  Object.defineProperty(DOMRectList.prototype, Symbol.toStringTag, { value: 'DOMRectList', configurable: true });
  function makeDOMRectList(rects) {
    const list = Object.create(DOMRectList.prototype);
    Object.defineProperty(list, '__zpDOMRectList', { value: true, configurable: true });
    Object.defineProperty(list, 'length', { value: rects.length, configurable: true });
    list.item = (index) => rects[Number(index)] || null;
    list[Symbol.iterator] = function* iterator() { yield* rects; };
    for (let index = 0; index < rects.length; index += 1) Object.defineProperty(list, index, { value: rects[index], enumerable: true, configurable: true });
    return list;
  }

  const domPointState = new WeakMap();
  function setDOMPointState(target, x, y, z, w) {
    domPointState.set(target, {
      x: rectNumber(x),
      y: rectNumber(y),
      z: rectNumber(z),
      w: rectNumber(w),
    });
  }
  function domPointValue(target) {
    const state = domPointState.get(target);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }
  class DOMPointReadOnly {
    constructor(x = 0, y = 0, z = 0, w = 1) {
      setDOMPointState(this, x, y, z, w);
    }
    get x() { return domPointValue(this).x; }
    get y() { return domPointValue(this).y; }
    get z() { return domPointValue(this).z; }
    get w() { return domPointValue(this).w; }
    matrixTransform(matrix = {}) {
      const m11 = rectNumber(matrix.m11 ?? matrix.a ?? 1);
      const m12 = rectNumber(matrix.m12 ?? matrix.b ?? 0);
      const m13 = rectNumber(matrix.m13 ?? 0);
      const m14 = rectNumber(matrix.m14 ?? 0);
      const m21 = rectNumber(matrix.m21 ?? matrix.c ?? 0);
      const m22 = rectNumber(matrix.m22 ?? matrix.d ?? 1);
      const m23 = rectNumber(matrix.m23 ?? 0);
      const m24 = rectNumber(matrix.m24 ?? 0);
      const m31 = rectNumber(matrix.m31 ?? 0);
      const m32 = rectNumber(matrix.m32 ?? 0);
      const m33 = rectNumber(matrix.m33 ?? 1);
      const m34 = rectNumber(matrix.m34 ?? 0);
      const m41 = rectNumber(matrix.m41 ?? matrix.e ?? 0);
      const m42 = rectNumber(matrix.m42 ?? matrix.f ?? 0);
      const m43 = rectNumber(matrix.m43 ?? 0);
      const m44 = rectNumber(matrix.m44 ?? 1);
      return new DOMPoint(
        this.x * m11 + this.y * m21 + this.z * m31 + this.w * m41,
        this.x * m12 + this.y * m22 + this.z * m32 + this.w * m42,
        this.x * m13 + this.y * m23 + this.z * m33 + this.w * m43,
        this.x * m14 + this.y * m24 + this.z * m34 + this.w * m44,
      );
    }
    toJSON() { return { x: this.x, y: this.y, z: this.z, w: this.w }; }
    static fromPoint(other = {}) {
      return new DOMPointReadOnly(other?.x ?? 0, other?.y ?? 0, other?.z ?? 0, other?.w ?? 1);
    }
  }
  Object.defineProperty(DOMPointReadOnly.prototype, Symbol.toStringTag, { value: 'DOMPointReadOnly', configurable: true });

  class DOMPoint extends DOMPointReadOnly {
    get x() { return domPointValue(this).x; }
    set x(value) { domPointValue(this).x = rectNumber(value); }
    get y() { return domPointValue(this).y; }
    set y(value) { domPointValue(this).y = rectNumber(value); }
    get z() { return domPointValue(this).z; }
    set z(value) { domPointValue(this).z = rectNumber(value); }
    get w() { return domPointValue(this).w; }
    set w(value) { domPointValue(this).w = rectNumber(value); }
    static fromPoint(other = {}) {
      return new DOMPoint(other?.x ?? 0, other?.y ?? 0, other?.z ?? 0, other?.w ?? 1);
    }
  }
  Object.defineProperty(DOMPoint.prototype, Symbol.toStringTag, { value: 'DOMPoint', configurable: true });
  makeDescriptorsEnumerable(DOMPointReadOnly.prototype, ['x', 'y', 'z', 'w', 'matrixTransform', 'toJSON']);
  makeDescriptorsEnumerable(DOMPointReadOnly, ['fromPoint']);
  makeDescriptorsEnumerable(DOMPoint.prototype, ['x', 'y', 'z', 'w']);
  makeDescriptorsEnumerable(DOMPoint, ['fromPoint']);

  function domPointFrom(other = {}) {
    return new DOMPoint(other?.x ?? 0, other?.y ?? 0, other?.z ?? 0, other?.w ?? 1);
  }

  const domQuadState = new WeakMap();
  function setDOMQuadState(target, p1, p2, p3, p4) {
    domQuadState.set(target, {
      p1: domPointFrom(p1),
      p2: domPointFrom(p2),
      p3: domPointFrom(p3),
      p4: domPointFrom(p4),
    });
  }
  function domQuadValue(target) {
    const state = domQuadState.get(target);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }
  class DOMQuad {
    constructor(p1 = {}, p2 = {}, p3 = {}, p4 = {}) {
      setDOMQuadState(this, p1, p2, p3, p4);
    }
    get p1() { return domQuadValue(this).p1; }
    get p2() { return domQuadValue(this).p2; }
    get p3() { return domQuadValue(this).p3; }
    get p4() { return domQuadValue(this).p4; }
    getBounds() {
      const left = Math.min(this.p1.x, this.p2.x, this.p3.x, this.p4.x);
      const top = Math.min(this.p1.y, this.p2.y, this.p3.y, this.p4.y);
      const right = Math.max(this.p1.x, this.p2.x, this.p3.x, this.p4.x);
      const bottom = Math.max(this.p1.y, this.p2.y, this.p3.y, this.p4.y);
      return new DOMRect(left, top, right - left, bottom - top);
    }
    toJSON() {
      return { p1: this.p1.toJSON(), p2: this.p2.toJSON(), p3: this.p3.toJSON(), p4: this.p4.toJSON() };
    }
    static fromRect(other = {}) {
      const x = rectNumber(other?.x ?? 0);
      const y = rectNumber(other?.y ?? 0);
      const width = rectNumber(other?.width ?? 0);
      const height = rectNumber(other?.height ?? 0);
      return new DOMQuad({ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height });
    }
    static fromQuad(other = {}) {
      return new DOMQuad(other?.p1, other?.p2, other?.p3, other?.p4);
    }
  }
  Object.defineProperty(DOMQuad.prototype, Symbol.toStringTag, { value: 'DOMQuad', configurable: true });
  makeDescriptorsEnumerable(DOMQuad.prototype, ['p1', 'p2', 'p3', 'p4', 'getBounds', 'toJSON']);
  makeDescriptorsEnumerable(DOMQuad, ['fromRect', 'fromQuad']);

  function matrixValues(init = {}) {
    const values = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    if (init && typeof init.length === 'number') {
      if (init.length === 6) {
        values[0] = rectNumber(init[0]); values[1] = rectNumber(init[1]);
        values[4] = rectNumber(init[2]); values[5] = rectNumber(init[3]);
        values[12] = rectNumber(init[4]); values[13] = rectNumber(init[5]);
      } else if (init.length === 16) {
        for (let index = 0; index < 16; index += 1) values[index] = rectNumber(init[index]);
      }
      return values;
    }
    values[0] = rectNumber(init?.m11 ?? init?.a ?? 1); values[1] = rectNumber(init?.m12 ?? init?.b ?? 0);
    values[2] = rectNumber(init?.m13 ?? 0); values[3] = rectNumber(init?.m14 ?? 0);
    values[4] = rectNumber(init?.m21 ?? init?.c ?? 0); values[5] = rectNumber(init?.m22 ?? init?.d ?? 1);
    values[6] = rectNumber(init?.m23 ?? 0); values[7] = rectNumber(init?.m24 ?? 0);
    values[8] = rectNumber(init?.m31 ?? 0); values[9] = rectNumber(init?.m32 ?? 0);
    values[10] = rectNumber(init?.m33 ?? 1); values[11] = rectNumber(init?.m34 ?? 0);
    values[12] = rectNumber(init?.m41 ?? init?.e ?? 0); values[13] = rectNumber(init?.m42 ?? init?.f ?? 0);
    values[14] = rectNumber(init?.m43 ?? 0); values[15] = rectNumber(init?.m44 ?? 1);
    return values;
  }

  const domMatrixState = new WeakMap();
  function setDOMMatrixState(target, values) {
    domMatrixState.set(target, values);
  }
  function domMatrixValue(target) {
    const values = domMatrixState.get(target);
    if (!values) throw new TypeError('Illegal invocation');
    return values;
  }

  class DOMMatrixReadOnly {
    constructor(init = {}) { setDOMMatrixState(this, matrixValues(init)); }
    get a() { return this.m11; } get b() { return this.m12; } get c() { return this.m21; } get d() { return this.m22; } get e() { return this.m41; } get f() { return this.m42; }
    get m11() { return domMatrixValue(this)[0]; } get m12() { return domMatrixValue(this)[1]; } get m13() { return domMatrixValue(this)[2]; } get m14() { return domMatrixValue(this)[3]; }
    get m21() { return domMatrixValue(this)[4]; } get m22() { return domMatrixValue(this)[5]; } get m23() { return domMatrixValue(this)[6]; } get m24() { return domMatrixValue(this)[7]; }
    get m31() { return domMatrixValue(this)[8]; } get m32() { return domMatrixValue(this)[9]; } get m33() { return domMatrixValue(this)[10]; } get m34() { return domMatrixValue(this)[11]; }
    get m41() { return domMatrixValue(this)[12]; } get m42() { return domMatrixValue(this)[13]; } get m43() { return domMatrixValue(this)[14]; } get m44() { return domMatrixValue(this)[15]; }
    get is2D() { return this.m13 === 0 && this.m14 === 0 && this.m23 === 0 && this.m24 === 0 && this.m31 === 0 && this.m32 === 0 && this.m34 === 0 && this.m43 === 0 && this.m33 === 1 && this.m44 === 1; }
    get isIdentity() { return this.m11 === 1 && this.m12 === 0 && this.m13 === 0 && this.m14 === 0 && this.m21 === 0 && this.m22 === 1 && this.m23 === 0 && this.m24 === 0 && this.m31 === 0 && this.m32 === 0 && this.m33 === 1 && this.m34 === 0 && this.m41 === 0 && this.m42 === 0 && this.m43 === 0 && this.m44 === 1; }
    translate(tx = 0, ty = 0, tz = 0) { return DOMMatrix.fromMatrix(this).translateSelf(tx, ty, tz); }
    scale(scaleX = 1, scaleY = scaleX, scaleZ = 1) { return DOMMatrix.fromMatrix(this).scaleSelf(scaleX, scaleY, scaleZ); }
    transformPoint(point = {}) { return domPointFrom(point).matrixTransform(this); }
    toJSON() { return { a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f, m11: this.m11, m12: this.m12, m13: this.m13, m14: this.m14, m21: this.m21, m22: this.m22, m23: this.m23, m24: this.m24, m31: this.m31, m32: this.m32, m33: this.m33, m34: this.m34, m41: this.m41, m42: this.m42, m43: this.m43, m44: this.m44, is2D: this.is2D, isIdentity: this.isIdentity }; }
    static fromMatrix(other = {}) { return new DOMMatrixReadOnly(other); }
  }
  Object.defineProperty(DOMMatrixReadOnly.prototype, Symbol.toStringTag, { value: 'DOMMatrixReadOnly', configurable: true });

  class DOMMatrix extends DOMMatrixReadOnly {
    get a() { return this.m11; } set a(value) { this.m11 = value; }
    get b() { return this.m12; } set b(value) { this.m12 = value; }
    get c() { return this.m21; } set c(value) { this.m21 = value; }
    get d() { return this.m22; } set d(value) { this.m22 = value; }
    get e() { return this.m41; } set e(value) { this.m41 = value; }
    get f() { return this.m42; } set f(value) { this.m42 = value; }
    get m11() { return domMatrixValue(this)[0]; } set m11(value) { domMatrixValue(this)[0] = rectNumber(value); }
    get m12() { return domMatrixValue(this)[1]; } set m12(value) { domMatrixValue(this)[1] = rectNumber(value); }
    get m13() { return domMatrixValue(this)[2]; } set m13(value) { domMatrixValue(this)[2] = rectNumber(value); }
    get m14() { return domMatrixValue(this)[3]; } set m14(value) { domMatrixValue(this)[3] = rectNumber(value); }
    get m21() { return domMatrixValue(this)[4]; } set m21(value) { domMatrixValue(this)[4] = rectNumber(value); }
    get m22() { return domMatrixValue(this)[5]; } set m22(value) { domMatrixValue(this)[5] = rectNumber(value); }
    get m23() { return domMatrixValue(this)[6]; } set m23(value) { domMatrixValue(this)[6] = rectNumber(value); }
    get m24() { return domMatrixValue(this)[7]; } set m24(value) { domMatrixValue(this)[7] = rectNumber(value); }
    get m31() { return domMatrixValue(this)[8]; } set m31(value) { domMatrixValue(this)[8] = rectNumber(value); }
    get m32() { return domMatrixValue(this)[9]; } set m32(value) { domMatrixValue(this)[9] = rectNumber(value); }
    get m33() { return domMatrixValue(this)[10]; } set m33(value) { domMatrixValue(this)[10] = rectNumber(value); }
    get m34() { return domMatrixValue(this)[11]; } set m34(value) { domMatrixValue(this)[11] = rectNumber(value); }
    get m41() { return domMatrixValue(this)[12]; } set m41(value) { domMatrixValue(this)[12] = rectNumber(value); }
    get m42() { return domMatrixValue(this)[13]; } set m42(value) { domMatrixValue(this)[13] = rectNumber(value); }
    get m43() { return domMatrixValue(this)[14]; } set m43(value) { domMatrixValue(this)[14] = rectNumber(value); }
    get m44() { return domMatrixValue(this)[15]; } set m44(value) { domMatrixValue(this)[15] = rectNumber(value); }
    translateSelf(tx = 0, ty = 0, tz = 0) { this.m41 += rectNumber(tx); this.m42 += rectNumber(ty); this.m43 += rectNumber(tz); return this; }
    scaleSelf(scaleX = 1, scaleY = scaleX, scaleZ = 1) { this.m11 *= rectNumber(scaleX); this.m22 *= rectNumber(scaleY); this.m33 *= rectNumber(scaleZ); return this; }
    static fromMatrix(other = {}) { return new DOMMatrix(other); }
    static fromFloat32Array(array) { return new DOMMatrix(array); }
    static fromFloat64Array(array) { return new DOMMatrix(array); }
  }
  Object.defineProperty(DOMMatrix.prototype, Symbol.toStringTag, { value: 'DOMMatrix', configurable: true });

  function multiplyMatrixValues(left, right) {
    const out = new Array(16);
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 4; col += 1) {
        out[row * 4 + col] = left[row * 4] * right[col] + left[row * 4 + 1] * right[4 + col] + left[row * 4 + 2] * right[8 + col] + left[row * 4 + 3] * right[12 + col];
      }
    }
    return out;
  }

  function rotationZMatrix(angle) {
    const radians = rectNumber(angle) * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return [cos, sin, 0, 0, -sin, cos, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }

  function skewMatrix(xAngle, yAngle) {
    return [1, Math.tan(rectNumber(yAngle) * Math.PI / 180), 0, 0, Math.tan(rectNumber(xAngle) * Math.PI / 180), 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }

  function parseMatrixString(source) {
    const text = String(source ?? '').trim();
    if (!text || text === 'none') return matrixValues();
    const match2d = /^matrix\(([^)]+)\)$/i.exec(text);
    if (match2d) return matrixValues(match2d[1].split(/[\s,]+/).filter(Boolean).map(Number));
    const match3d = /^matrix3d\(([^)]+)\)$/i.exec(text);
    if (match3d) return matrixValues(match3d[1].split(/[\s,]+/).filter(Boolean).map(Number));
    throw new SyntaxError("Failed to execute 'setMatrixValue' on 'DOMMatrix': Could not parse transform list.");
  }

  Object.defineProperties(DOMMatrix.prototype, {
    multiplySelf: { value: function multiplySelf(other = {}) { setDOMMatrixState(this, multiplyMatrixValues(domMatrixValue(this), matrixValues(other))); return this; }, enumerable: true, writable: true, configurable: true },
    preMultiplySelf: { value: function preMultiplySelf(other = {}) { setDOMMatrixState(this, multiplyMatrixValues(matrixValues(other), domMatrixValue(this))); return this; }, enumerable: true, writable: true, configurable: true },
    invertSelf: { value: function invertSelf() { return this; }, enumerable: true, writable: true, configurable: true },
    rotateSelf: { value: function rotateSelf(rotX = 0, rotY = 0, rotZ = rotY ? 0 : rotX) { void rotX; void rotY; return this.multiplySelf(rotationZMatrix(rotZ)); }, enumerable: true, writable: true, configurable: true },
    rotateFromVectorSelf: { value: function rotateFromVectorSelf(x = 0, y = 0) { return this.rotateSelf(0, 0, Math.atan2(rectNumber(y), rectNumber(x)) * 180 / Math.PI); }, enumerable: true, writable: true, configurable: true },
    rotateAxisAngleSelf: { value: function rotateAxisAngleSelf(x = 0, y = 0, z = 1, angle = 0) { return rectNumber(z) || (!rectNumber(x) && !rectNumber(y)) ? this.rotateSelf(0, 0, angle) : this; }, enumerable: true, writable: true, configurable: true },
    scale3dSelf: { value: function scale3dSelf(scale = 1) { return this.scaleSelf(scale, scale, scale); }, enumerable: true, writable: true, configurable: true },
    skewXSelf: { value: function skewXSelf(sx = 0) { return this.multiplySelf(skewMatrix(sx, 0)); }, enumerable: true, writable: true, configurable: true },
    skewYSelf: { value: function skewYSelf(sy = 0) { return this.multiplySelf(skewMatrix(0, sy)); }, enumerable: true, writable: true, configurable: true },
    setMatrixValue: { value: function setMatrixValue(transformList) { setDOMMatrixState(this, parseMatrixString(transformList)); return this; }, enumerable: true, writable: true, configurable: true },
  });

  class VirtualElement extends VirtualNode {
    constructor(tagName, ownerDocument, nodeId, namespaceURI = HTML_NS) {
      const ns = namespaceURI === undefined ? HTML_NS : String(namespaceURI || '');
      const rawName = String(tagName || '');
      const qualified = parseQualifiedName(rawName);
      const localName = ns === HTML_NS ? rawName.toLowerCase() : qualified.localName;
      const nodeName = ns === HTML_NS ? rawName.toUpperCase() : rawName;
      super(1, nodeName, ownerDocument, nodeId);
      this.localName = localName;
      this.prefix = ns && ns !== HTML_NS ? qualified.prefix : null;
      this.tagName = this.nodeName;
      this.namespaceURI = ns;
      this.__zpAttributes = new Map();
      this.attributes = new VirtualNamedNodeMap(this);
    }
    setAttribute(name, value) { setAttr(this, '', name, value, true); }
    getAttribute(name) { return attrValue(this, '', name); }
    removeAttribute(name) { removeAttr(this, '', name, true); }
    setAttributeNS(ns, name, value) { setAttr(this, String(ns || ''), name, value, true); }
    getAttributeNS(ns, name) { return attrValue(this, String(ns || ''), name); }
    removeAttributeNS(ns, name) { removeAttr(this, String(ns || ''), name, true); }
    hasAttribute(name) { return this.getAttribute(name) !== null; }
    hasAttributeNS(ns, name) { return this.getAttributeNS(ns, name) !== null; }
    hasAttributes() { return this.attributes.length > 0; }
    getAttributeNames() { return Array.from(this.__zpAttributes.values()).map((attr) => attr.name); }
    toggleAttribute(name, force = undefined) {
      const present = this.hasAttribute(name);
      const enabled = force === undefined ? !present : Boolean(force);
      if (enabled) {
        if (!present) this.setAttribute(name, '');
        return true;
      }
      if (present) this.removeAttribute(name);
      return false;
    }
    get id() { return this.getAttribute('id') || ''; }
    set id(value) { this.setAttribute('id', value); }
    get className() { return this.getAttribute('class') || ''; }
    set className(value) { this.setAttribute('class', value); }
    get children() { return liveCollection(() => this.__zpChildren.filter((node) => node.nodeType === 1), 'HTMLCollection'); }
    get firstElementChild() { return this.children.item(0); }
    getElementsByClassName(name) { return liveCollection(() => descendants(this).filter((node) => hasClass(node, name)), 'HTMLCollection'); }
    getElementsByTagName(tag) { return tagsUnder(this, tag); }
    querySelectorAll(selector) { return liveCollection(() => descendants(this).filter((node) => matchesSelector(node, selector)), 'NodeList'); }
    querySelector(selector) { return this.querySelectorAll(selector).item(0); }
    animate(keyframes) { const animation = new Animation(new KeyframeEffect(this, keyframes, arguments[1]), this.ownerDocument?.timeline || globalThis.document?.timeline || null); virtualAnimations.add(animation); animation.play(); return animation; }
    getAnimations() { return activeAnimationsFor((animation) => animation.effect?.target === this); }
    closest(selector) { for (let node = this; node; node = node.parentNode) if (matchesSelector(node, selector)) return node; return null; }
    matches(selector) { return matchesSelector(this, selector); }
    append(...values) { for (const node of values.map((value) => coerceNode(value, this.ownerDocument))) this.appendChild(node); }
    prepend(...values) {
      const before = this.firstChild;
      for (const node of values.map((value) => coerceNode(value, this.ownerDocument))) this.insertBefore(node, before);
    }
    replaceChildren(...values) {
      for (const child of [...this.__zpChildren]) this.removeChild(child);
      this.append(...values);
    }
    getBoundingClientRect() { return rectFor(this.__zpNodeId); }
    getClientRects() { return makeDOMRectList([this.getBoundingClientRect()]); }
  }

  defineChildNodeMethods(VirtualElement.prototype);
  Object.defineProperties(VirtualElement.prototype, {
    innerText: { get() { return innerTextForNode(this); }, set(value) { setNodeText(this, String(value ?? '')); }, enumerable: true, configurable: true },
  });

  reflectStringAttribute(VirtualElement.prototype, 'name');
  reflectStringAttribute(VirtualElement.prototype, 'title');
  reflectStringAttribute(VirtualElement.prototype, 'lang');
  reflectStringAttribute(VirtualElement.prototype, 'dir');
  reflectStringAttribute(VirtualElement.prototype, 'alt');
  reflectStringAttribute(VirtualElement.prototype, 'rel');
  reflectStringAttribute(VirtualElement.prototype, 'target');
  reflectStringAttribute(VirtualElement.prototype, 'type');
  reflectStringAttribute(VirtualElement.prototype, 'value');
  reflectStringAttribute(VirtualElement.prototype, 'placeholder');
  reflectStringAttribute(VirtualElement.prototype, 'role');
  reflectStringAttribute(VirtualElement.prototype, 'htmlFor', 'for');
  reflectURLAttribute(VirtualElement.prototype, 'href');
  reflectURLAttribute(VirtualElement.prototype, 'src');
  reflectURLAttribute(VirtualElement.prototype, 'action');
  reflectURLAttribute(VirtualElement.prototype, 'formAction', 'formaction');
  reflectURLAttribute(VirtualElement.prototype, 'poster');
  reflectURLAttribute(VirtualElement.prototype, 'cite');
  reflectURLAttribute(VirtualElement.prototype, 'data');
  reflectBooleanAttribute(VirtualElement.prototype, 'hidden');
  reflectBooleanAttribute(VirtualElement.prototype, 'disabled');
  reflectBooleanAttribute(VirtualElement.prototype, 'checked');
  reflectBooleanAttribute(VirtualElement.prototype, 'selected');
  reflectBooleanAttribute(VirtualElement.prototype, 'multiple');
  reflectBooleanAttribute(VirtualElement.prototype, 'required');
  reflectBooleanAttribute(VirtualElement.prototype, 'readOnly', 'readonly');
  reflectBooleanAttribute(VirtualElement.prototype, 'open');
  reflectBooleanAttribute(VirtualElement.prototype, 'autofocus');
  reflectBooleanAttribute(VirtualElement.prototype, 'controls');
  reflectBooleanAttribute(VirtualElement.prototype, 'loop');
  reflectBooleanAttribute(VirtualElement.prototype, 'muted');

  function reflectStringAttribute(proto, propertyName, attributeName = propertyName) {
    Object.defineProperty(proto, propertyName, {
      get() { return this.getAttribute(attributeName) || ''; },
      set(value) { this.setAttribute(attributeName, value); },
      enumerable: true,
      configurable: true,
    });
  }

  function reflectURLAttribute(proto, propertyName, attributeName = propertyName) {
    Object.defineProperty(proto, propertyName, {
      get() { return resolveElementURL(this.getAttribute(attributeName), this.ownerDocument?.location?.href || 'about:blank'); },
      set(value) { this.setAttribute(attributeName, value); },
      enumerable: true,
      configurable: true,
    });
  }

  function reflectBooleanAttribute(proto, propertyName, attributeName = propertyName) {
    Object.defineProperty(proto, propertyName, {
      get() { return this.hasAttribute(attributeName); },
      set(value) {
        if (value) this.setAttribute(attributeName, '');
        else this.removeAttribute(attributeName);
      },
      enumerable: true,
      configurable: true,
    });
  }

  function resolveElementURL(value, baseHref) {
    const text = String(value || '');
    if (!text) return '';
    return resolveLocationURL(text, baseHref || 'about:blank');
  }

  class VirtualDocument extends VirtualNode {
    constructor(href) {
      super(9, '#document', null, 'document');
      this.__zpOwnerDocument = this;
      this.location = makeLocation(href);
      this.contentType = 'text/html';
      this.documentElement = null;
      this.head = null;
      this.body = null;
      this.readyState = 'complete';
      this.fragmentDirective = makeFragmentDirective();
      this.timeline = new DocumentTimeline();
    }
    get defaultView() { return globalThis; }
    get forms() { return documentElementCollection(this, (node) => node.localName === 'form'); }
    get images() { return documentElementCollection(this, (node) => node.localName === 'img'); }
    get links() { return documentElementCollection(this, (node) => (node.localName === 'a' || node.localName === 'area') && node.hasAttribute('href')); }
    get anchors() { return documentElementCollection(this, (node) => node.localName === 'a' && node.hasAttribute('name')); }
    get scripts() { return documentElementCollection(this, (node) => node.localName === 'script'); }
    get embeds() { return documentElementCollection(this, (node) => node.localName === 'embed'); }
    get plugins() { return this.embeds; }
    getAnimations() { return activeAnimationsFor((animation) => animation.effect?.target?.ownerDocument === this); }
    createElement(tagName) { return new VirtualElement(tagName, this); }
    createElementNS(ns, tagName) { return new VirtualElement(tagName, this, undefined, String(ns || '')); }
    createTextNode(text) { return new Text(text, this); }
    createComment(text) { return new Comment(text, this); }
    createCDATASection(data) { return new VirtualCDATASection(data, this); }
    createProcessingInstruction(target, data) {
      const name = String(target || '');
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) throw namedError('InvalidCharacterError');
      if (String(data || '').includes('?>')) throw namedError('InvalidCharacterError');
      return new VirtualProcessingInstruction(name, data, this);
    }
    importNode(node, deep = false) {
      if (!(node instanceof VirtualNode) || node.nodeType === 9) throw namedError('NotSupportedError');
      return cloneVirtualNode(node, Boolean(deep), this);
    }
    adoptNode(node) {
      if (!(node instanceof VirtualNode) || node.nodeType === 9) throw namedError('NotSupportedError');
      node.parentNode?.removeChild(node);
      updateOwnerDocument(node, this);
      return node;
    }
    getElementById(id) { return descendants(this).find((node) => node.id === String(id)) || null; }
    getElementsByClassName(name) { return liveCollection(() => descendants(this).filter((node) => hasClass(node, name)), 'HTMLCollection'); }
    getElementsByTagName(tag) { return tagsUnder(this, tag); }
    querySelectorAll(selector) { return liveCollection(() => descendants(this).filter((node) => matchesSelector(node, selector)), 'NodeList'); }
    querySelector(selector) { return this.querySelectorAll(selector).item(0); }
    append(...values) { for (const node of values.map((value) => coerceNode(value, this))) this.appendChild(node); }
    prepend(...values) {
      const before = this.firstChild;
      for (const node of values.map((value) => coerceNode(value, this))) this.insertBefore(node, before);
    }
  }

  Object.defineProperty(VirtualDocument.prototype, Symbol.toStringTag, { get() { return documentToStringTag(this); }, configurable: true });

  function documentToStringTag(doc) {
    const type = String(doc?.contentType || '').toLowerCase();
    if (type && type !== 'text/html') return 'XMLDocument';
    const rootNS = doc?.documentElement?.namespaceURI;
    return rootNS && rootNS !== HTML_NS ? 'XMLDocument' : 'HTMLDocument';
  }

  const namedNodeMapState = new WeakMap();
  class VirtualNamedNodeMap {
    constructor(element) {
      const state = { element };
      const proxy = new Proxy(this, {
        get(target, prop, receiver) {
          if (isCollectionIndex(prop)) return target.item(Number(prop));
          const value = Reflect.get(target, prop, receiver);
          if (value !== undefined || typeof prop !== 'string') return value;
          return target.getNamedItem(prop) || undefined;
        },
        has(target, prop) {
          return (isCollectionIndex(prop) && target.item(Number(prop)) !== null) || (typeof prop === 'string' && target.getNamedItem(prop) !== null) || Reflect.has(target, prop);
        },
        ownKeys(target) {
          const attrs = namedNodeMapValues(target);
          const numeric = attrs.map((_, index) => String(index));
          return [...new Set([...numeric, ...attrs.map((attr) => attr.name)])];
        },
        getOwnPropertyDescriptor(target, prop) {
          if (isCollectionIndex(prop)) {
            const value = target.item(Number(prop));
            return value ? { value, enumerable: true, configurable: true } : undefined;
          }
          if (typeof prop === 'string') {
            const value = target.getNamedItem(prop);
            if (value) return { value, enumerable: false, configurable: true };
          }
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      });
      namedNodeMapState.set(this, state);
      namedNodeMapState.set(proxy, state);
      return proxy;
    }
    get length() { return namedNodeMapValues(this).length; }
    getNamedItem(name) { return namedNodeMapElement(this).__zpAttributes.get(attrKey('', name)) || null; }
    getNamedItemNS(namespaceURI, localName) { return namedNodeMapElement(this).__zpAttributes.get(attrKey(namespaceURI, localName)) || null; }
    item(index) { return namedNodeMapValues(this)[Number(index)] || null; }
    removeNamedItem(name) { return removeNamedMapItem(namedNodeMapElement(this), '', name); }
    removeNamedItemNS(namespaceURI, localName) { return removeNamedMapItem(namedNodeMapElement(this), namespaceURI, localName); }
    setNamedItem(attr) { return setNamedMapItem(namedNodeMapElement(this), attr, false); }
    setNamedItemNS(attr) { return setNamedMapItem(namedNodeMapElement(this), attr, true); }
    [Symbol.iterator]() { return namedNodeMapValues(this)[Symbol.iterator](); }
  }
  function NamedNodeMap() { throw new TypeError("Failed to construct 'NamedNodeMap': Illegal constructor"); }
  NamedNodeMap.prototype = VirtualNamedNodeMap.prototype;
  installNamedNodeMapPrototype(NamedNodeMap);

  function namedNodeMapElement(map) {
    const state = namedNodeMapState.get(map);
    if (!state) throw new TypeError('Illegal invocation');
    return state.element;
  }
  function namedNodeMapValues(map) {
    return Array.from(namedNodeMapElement(map).__zpAttributes.values());
  }
  function namedNodeMapIterator() {
    return namedNodeMapValues(this)[Symbol.iterator]();
  }
  Object.defineProperty(namedNodeMapIterator, 'name', { value: 'values', configurable: true });
  function installNamedNodeMapPrototype(Constructor) {
    const proto = Constructor.prototype;
    const descriptors = Object.fromEntries(Reflect.ownKeys(proto).map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)]));
    for (const key of Reflect.ownKeys(proto)) delete proto[key];
    for (const key of ['length', 'getNamedItem', 'getNamedItemNS', 'item', 'removeNamedItem', 'removeNamedItemNS', 'setNamedItem', 'setNamedItemNS']) {
      Object.defineProperty(proto, key, { ...descriptors[key], enumerable: true, configurable: true });
    }
    Object.defineProperty(proto, Symbol.iterator, { value: namedNodeMapIterator, writable: true, configurable: true });
    Object.defineProperty(proto, 'constructor', { value: Constructor, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(proto, Symbol.toStringTag, { value: 'NamedNodeMap', configurable: true });
  }

  const mediaQueryListState = new WeakMap();
  function MediaQueryList() {
    if (new.target) throw new TypeError("Failed to construct 'MediaQueryList': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }

  const mediaQueryListEventState = new WeakMap();
  function MediaQueryListEvent(type, init = {}) {
    if (!new.target) throw new TypeError("Failed to construct 'MediaQueryListEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (arguments.length < 1) throw new TypeError("Failed to construct 'MediaQueryListEvent': 1 argument required, but only 0 present.");
    const event = Reflect.construct(VirtualEvent, [type, init], new.target);
    mediaQueryListEventState.set(event, {
      media: String(init?.media || ''),
      matches: Boolean(init?.matches),
    });
    return event;
  }
  MediaQueryListEvent.prototype = Object.create(VirtualEvent.prototype);
  Object.defineProperties(MediaQueryListEvent.prototype, {
    media: { get() { return mediaQueryListEventValue(this).media; }, enumerable: true, configurable: true },
    matches: { get() { return mediaQueryListEventValue(this).matches; }, enumerable: true, configurable: true },
    constructor: { value: MediaQueryListEvent, writable: true, configurable: true },
  });
  Object.defineProperty(MediaQueryListEvent.prototype, Symbol.toStringTag, { value: 'MediaQueryListEvent', configurable: true });
  function mediaQueryListEventValue(event) {
    const state = mediaQueryListEventState.get(event);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function VirtualMediaQueryList(query) {
    const list = Reflect.construct(VirtualEventTarget, [], new.target);
    mediaQueryListState.set(list, {
      media: String(query || ''),
      matches: evaluateMedia(query),
      onchange: null,
    });
    mediaQueries.add(list);
    return list;
  }
  VirtualMediaQueryList.prototype = Object.create(VirtualEventTarget.prototype);
  Object.defineProperties(VirtualMediaQueryList.prototype, {
    media: { get() { return mediaQueryListValue(this).media; }, enumerable: true, configurable: true },
    matches: { get() { return mediaQueryListValue(this).matches; }, enumerable: true, configurable: true },
    onchange: {
      get() { return mediaQueryListValue(this).onchange; },
      set(value) { mediaQueryListValue(this).onchange = typeof value === 'function' ? value : null; },
      enumerable: true,
      configurable: true,
    },
    addListener: { value: function addListener(callback) { this.addEventListener('change', callback); }, enumerable: true, writable: true, configurable: true },
    removeListener: { value: function removeListener(callback) { this.removeEventListener('change', callback); }, enumerable: true, writable: true, configurable: true },
    constructor: { value: MediaQueryList, writable: true, configurable: true },
  });
  Object.defineProperty(MediaQueryList, 'prototype', { value: VirtualMediaQueryList.prototype });
  Object.defineProperty(VirtualMediaQueryList.prototype, Symbol.toStringTag, { value: 'MediaQueryList', configurable: true });
  function mediaQueryListValue(list) {
    const state = mediaQueryListState.get(list);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }
  function refreshMediaQueryList(list) {
    const state = mediaQueryListValue(list);
    const next = evaluateMedia(state.media);
    if (next === state.matches) return;
    state.matches = next;
    list.dispatchEvent(new MediaQueryListEvent('change', { matches: state.matches, media: state.media }));
  }

  const resizeObserverSizeToken = {};
  const resizeObserverEntryToken = {};
  const intersectionObserverEntryToken = {};
  const resizeObserverSizeSlots = new WeakMap();
  const resizeObserverEntrySlots = new WeakMap();
  const intersectionObserverEntrySlots = new WeakMap();
  const resizeObserverSlots = new WeakMap();
  const intersectionObserverSlots = new WeakMap();


  class ResizeObserverSize {
    constructor(token, inlineSize = 0, blockSize = 0) {
      if (token !== resizeObserverSizeToken) throw new TypeError("Failed to construct 'ResizeObserverSize': Illegal constructor");
      resizeObserverSizeSlots.set(this, {
        inlineSize: Number(inlineSize) || 0,
        blockSize: Number(blockSize) || 0,
      });
    }
    get inlineSize() { return resizeObserverSizeValue(this).inlineSize; }
    get blockSize() { return resizeObserverSizeValue(this).blockSize; }
  }
  Object.defineProperty(ResizeObserverSize.prototype, Symbol.toStringTag, { value: 'ResizeObserverSize', configurable: true });

  class ResizeObserverEntry {
    constructor(token, target) {
      if (token !== resizeObserverEntryToken) throw new TypeError("Failed to construct 'ResizeObserverEntry': Illegal constructor");
      const rect = rectFor(target?.__zpNodeId);
      resizeObserverEntrySlots.set(this, {
        target: target || null,
        contentRect: rect,
        borderBoxSize: Object.freeze([new ResizeObserverSize(resizeObserverSizeToken, rect.width, rect.height)]),
        contentBoxSize: Object.freeze([new ResizeObserverSize(resizeObserverSizeToken, rect.width, rect.height)]),
        devicePixelContentBoxSize: Object.freeze([new ResizeObserverSize(resizeObserverSizeToken, rect.width * devicePixelRatio, rect.height * devicePixelRatio)]),
      });
    }
    get target() { return resizeObserverEntryValue(this).target; }
    get contentRect() { return resizeObserverEntryValue(this).contentRect; }
    get borderBoxSize() { return resizeObserverEntryValue(this).borderBoxSize; }
    get contentBoxSize() { return resizeObserverEntryValue(this).contentBoxSize; }
    get devicePixelContentBoxSize() { return resizeObserverEntryValue(this).devicePixelContentBoxSize; }
  }
  Object.defineProperty(ResizeObserverEntry.prototype, Symbol.toStringTag, { value: 'ResizeObserverEntry', configurable: true });

  class IntersectionObserverEntry {
    constructor(token, target) {
      if (token !== intersectionObserverEntryToken) throw new TypeError("Failed to construct 'IntersectionObserverEntry': Illegal constructor");
      const rect = rectFor(target?.__zpNodeId);
      intersectionObserverEntrySlots.set(this, {
        time: performanceObject?.now?.() || 0,
        rootBounds: null,
        boundingClientRect: rect,
        intersectionRect: rect,
        isIntersecting: true,
        isVisible: true,
        intersectionRatio: 1,
        target: target || null,
      });
    }
    get time() { return intersectionObserverEntryValue(this).time; }
    get rootBounds() { return intersectionObserverEntryValue(this).rootBounds; }
    get boundingClientRect() { return intersectionObserverEntryValue(this).boundingClientRect; }
    get intersectionRect() { return intersectionObserverEntryValue(this).intersectionRect; }
    get isIntersecting() { return intersectionObserverEntryValue(this).isIntersecting; }
    get isVisible() { return intersectionObserverEntryValue(this).isVisible; }
    get intersectionRatio() { return intersectionObserverEntryValue(this).intersectionRatio; }
    get target() { return intersectionObserverEntryValue(this).target; }
  }
  Object.defineProperty(IntersectionObserverEntry.prototype, Symbol.toStringTag, { value: 'IntersectionObserverEntry', configurable: true });

  function resizeObserverSizeValue(size) {
    return resizeObserverSizeSlots.get(size) || { inlineSize: 0, blockSize: 0 };
  }

  function resizeObserverEntryValue(entry) {
    return resizeObserverEntrySlots.get(entry) || {
      target: null,
      contentRect: new DOMRect(0, 0, 0, 0),
      borderBoxSize: Object.freeze([]),
      contentBoxSize: Object.freeze([]),
      devicePixelContentBoxSize: Object.freeze([]),
    };
  }

  function intersectionObserverEntryValue(entry) {
    return intersectionObserverEntrySlots.get(entry) || {
      time: 0,
      rootBounds: null,
      boundingClientRect: new DOMRect(0, 0, 0, 0),
      intersectionRect: new DOMRect(0, 0, 0, 0),
      isIntersecting: false,
      isVisible: false,
      intersectionRatio: 0,
      target: null,
    };
  }

  class VirtualResizeObserver {
    constructor(callback) {
      resizeObserverSlots.set(this, { callback, targets: new Set() });
      resizeObservers.add(this);
    }
    observe(target) { if (target?.__zpNodeId) resizeObserverState(this).targets.add(target); }
    unobserve(target) { resizeObserverState(this).targets.delete(target); }
    disconnect() { resizeObserverState(this).targets.clear(); resizeObservers.delete(this); }
  }
  Object.defineProperty(VirtualResizeObserver.prototype, Symbol.toStringTag, { value: 'ResizeObserver', configurable: true });

  class VirtualIntersectionObserver {
    constructor(callback, options = {}) {
      intersectionObserverSlots.set(this, {
        callback,
        targets: new Set(),
        root: options?.root || null,
        rootMargin: observerMargin(options?.rootMargin),
        scrollMargin: observerMargin(options?.scrollMargin),
        thresholds: Object.freeze(intersectionThresholds(options?.threshold)),
        delay: Number(options?.delay || 0),
        trackVisibility: Boolean(options?.trackVisibility),
      });
      intersectionObservers.add(this);
    }
    get root() { return intersectionObserverState(this).root; }
    get rootMargin() { return intersectionObserverState(this).rootMargin; }
    get scrollMargin() { return intersectionObserverState(this).scrollMargin; }
    get thresholds() { return intersectionObserverState(this).thresholds; }
    get delay() { return intersectionObserverState(this).delay; }
    get trackVisibility() { return intersectionObserverState(this).trackVisibility; }
    observe(target) { if (target?.__zpNodeId) intersectionObserverState(this).targets.add(target); }
    unobserve(target) { intersectionObserverState(this).targets.delete(target); }
    disconnect() { intersectionObserverState(this).targets.clear(); intersectionObservers.delete(this); }
    takeRecords() { return []; }
  }
  Object.defineProperty(VirtualIntersectionObserver.prototype, Symbol.toStringTag, { value: 'IntersectionObserver', configurable: true });

  function resizeObserverState(observer) {
    return resizeObserverSlots.get(observer) || { callback: null, targets: new Set() };
  }

  function intersectionObserverState(observer) {
    return intersectionObserverSlots.get(observer) || { callback: null, targets: new Set(), root: null, rootMargin: '0px 0px 0px 0px', scrollMargin: '0px 0px 0px 0px', thresholds: Object.freeze([0]), delay: 0, trackVisibility: false };
  }

  function intersectionThresholds(threshold) {
    const values = Array.isArray(threshold) ? threshold : [threshold ?? 0];
    return values.map((value) => Number(value) || 0).sort((left, right) => left - right);
  }

  function observerMargin(value) {
    const parts = String(value || '0px').trim().split(/\s+/).filter(Boolean);
    const [top = '0px', right = top, bottom = top, left = right] = parts;
    return [top, right, bottom, left].join(' ');
  }

  function deliverResizeObserver(observer) {
    const state = resizeObserverState(observer);
    if (!state.targets.size) return;
    const entries = [...state.targets].map((target) => new ResizeObserverEntry(resizeObserverEntryToken, target));
    state.callback?.(entries, observer);
  }

  function deliverIntersectionObserver(observer) {
    const state = intersectionObserverState(observer);
    if (!state.targets.size) return;
    const entries = [...state.targets].map((target) => new IntersectionObserverEntry(intersectionObserverEntryToken, target));
    state.callback?.(entries, observer);
  }


  function __zpLoadDocument(records, options = {}) {
    const doc = new VirtualDocument(options.href || 'about:blank');
    performanceNavigationName = options.href || 'about:blank';
    performanceObject = null;
    viewport = makeViewport(options.viewport || {});
    layoutRects = { ...((options.viewport && options.viewport.layout) || {}) };
    installGlobals(doc);
    for (const record of records || []) applyInitialRecord(doc, record);
    return true;
  }

  function __zpApplyDocumentRecords(records) {
    for (const record of records || []) applyInitialRecord(globalThis.document, record);
    return true;
  }

  function applyInitialRecord(doc, record) {
    if (record.type === 'node.create') createInitialElement(doc, record);
    else if (record.type === 'node.attr') setInitialAttr(record);
    else if (record.type === 'node.text') createInitialText(doc, record);
    else if (record.type === 'event.inlineHandler') installInlineHandler(record);
  }

  function createInitialElement(doc, record) {
    const element = new VirtualElement(record.tag, doc, record.nodeId, record.namespaceURI || undefined);
    if (record.tag === 'html') doc.documentElement = element;
    if (record.tag === 'head') doc.head = element;
    if (record.tag === 'body') doc.body = element;
    appendInitial(doc, record.parentNodeId, element);
  }

  function createInitialText(doc, record) {
    const text = new Text(record.text, doc, 'text-' + record.seq);
    appendInitial(doc, record.parentNodeId, text);
  }

  function appendInitial(doc, parentNodeId, node) {
    const parent = nodes.get(parentNodeId) || doc;
    appendNode(parent, node, false);
  }

  function setInitialAttr(record) {
    const node = nodes.get(record.nodeId);
    if (node?.nodeType === 1) setAttr(node, record.namespaceURI || '', record.name, record.value, false);
  }

  function installInlineHandler(record) {
    const node = nodes.get(record.nodeId);
    if (!node) return;
    node['on' + record.event] = Function('event', String(record.source || ''));
  }


  function Screen() { throw new TypeError("Failed to construct 'Screen': Illegal constructor"); }
  Object.defineProperty(Screen, Symbol.hasInstance, { value: (value) => screenSlots.has(value), configurable: true });
  Object.defineProperties(Screen.prototype, {
    width: { get() { return screenValue(this).width; }, enumerable: true, configurable: true },
    height: { get() { return screenValue(this).height; }, enumerable: true, configurable: true },
    availWidth: { get() { return screenValue(this).width; }, enumerable: true, configurable: true },
    availHeight: { get() { return screenValue(this).height; }, enumerable: true, configurable: true },
    availLeft: { get() { screenValue(this); return 0; }, enumerable: true, configurable: true },
    availTop: { get() { screenValue(this); return 0; }, enumerable: true, configurable: true },
    colorDepth: { get() { screenValue(this); return 24; }, enumerable: true, configurable: true },
    pixelDepth: { get() { screenValue(this); return 24; }, enumerable: true, configurable: true },
    orientation: { get() { const state = screenValue(this); return currentScreenOrientation(state.width, state.height); }, enumerable: true, configurable: true },
    [Symbol.toStringTag]: { value: 'Screen', configurable: true },
  });
  Object.setPrototypeOf(Screen.prototype, VirtualEventTarget.prototype);

  const screenOrientationSlots = new WeakMap();
  function ScreenOrientation() {
    if (new.target) throw new TypeError("Failed to construct 'ScreenOrientation': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  const screenOrientationTypes = new Set(['any', 'natural', 'landscape', 'portrait', 'portrait-primary', 'portrait-secondary', 'landscape-primary', 'landscape-secondary']);

  class VirtualScreenOrientation extends VirtualEventTarget {
    constructor(width, height) {
      super();
      screenOrientationSlots.set(this, { type: 'landscape-primary', angle: 0, onchange: null });
      updateScreenOrientation(this, width, height);
    }
  }
  function updateScreenOrientation(orientation, width, height) {
    const state = screenOrientationValue(orientation);
    state.type = Number(width) >= Number(height) ? 'landscape-primary' : 'portrait-primary';
    state.angle = 0;
  }
  Object.defineProperty(ScreenOrientation, 'prototype', { value: VirtualScreenOrientation.prototype });
  delete VirtualScreenOrientation.prototype.constructor;
  Object.defineProperties(VirtualScreenOrientation.prototype, {
    angle: { get() { return screenOrientationValue(this).angle; }, enumerable: true, configurable: true },
    type: { get() { return screenOrientationValue(this).type; }, enumerable: true, configurable: true },
    onchange: {
      get() { return screenOrientationValue(this).onchange; },
      set(value) { screenOrientationValue(this).onchange = typeof value === 'function' ? value : null; },
      enumerable: true,
      configurable: true,
    },
    lock: {
      value: function lock(orientation) {
        screenOrientationValue(this);
        if (arguments.length < 1) return Promise.reject(new TypeError("Failed to execute 'lock' on 'ScreenOrientation': 1 argument required, but only 0 present."));
        const requested = String(orientation);
        if (!screenOrientationTypes.has(requested)) return Promise.reject(new TypeError("Failed to execute 'lock' on 'ScreenOrientation': The provided value '" + requested + "' is not a valid enum value of type OrientationLockType."));
        return Promise.reject(namedError('NotSupportedError', 'screen.orientation.lock() is not available on this device.'));
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    unlock: { value: function unlock() { screenOrientationValue(this); }, enumerable: true, writable: true, configurable: true },
    constructor: { value: ScreenOrientation, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(VirtualScreenOrientation.prototype, Symbol.toStringTag, { value: 'ScreenOrientation', configurable: true });

  function screenValue(value) {
    const state = screenSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function screenOrientationValue(value) {
    const state = screenOrientationSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function currentScreenOrientation(width, height) {
    if (!screenOrientation) screenOrientation = new VirtualScreenOrientation(width, height);
    else updateScreenOrientation(screenOrientation, width, height);
    return screenOrientation;
  }

  function createScreen(width, height) {
    const screen = Object.create(Screen.prototype);
    screenSlots.set(screen, { width, height, onchange: null });
    return screen;
  }

  function Performance() { throw new TypeError("Failed to construct 'Performance': Illegal constructor"); }
  Object.defineProperty(Performance, Symbol.hasInstance, { value: (value) => Boolean(value?.__zpPerformance), configurable: true });
  const eventCountsSlots = new WeakMap();
  function EventCounts() {
    if (new.target) throw new TypeError("Failed to construct 'EventCounts': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  delete EventCounts.prototype.constructor;
  Object.defineProperties(EventCounts.prototype, {
    size: { get() { return eventCountsValue(this).size; }, enumerable: true, configurable: true },
    entries: { value: function* entries() { yield* eventCountsValue(this).entries(); }, enumerable: true, writable: true, configurable: true },
    forEach: {
      value: function forEach(callback) {
        if (typeof callback !== 'function') throw new TypeError("Failed to execute 'forEach' on 'EventCounts': parameter 1 is not of type 'Function'.");
        const thisArg = arguments.length > 1 ? arguments[1] : undefined;
        for (const [key, value] of eventCountsValue(this)) callback.call(thisArg, value, key, this);
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    get: { value: function get(type) { return eventCountsValue(this).get(String(type)) || 0; }, enumerable: true, writable: true, configurable: true },
    has: { value: function has(type) { return eventCountsValue(this).has(String(type)); }, enumerable: true, writable: true, configurable: true },
    keys: { value: function* keys() { yield* eventCountsValue(this).keys(); }, enumerable: true, writable: true, configurable: true },
    values: { value: function* values() { yield* eventCountsValue(this).values(); }, enumerable: true, writable: true, configurable: true },
    constructor: { value: EventCounts, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(EventCounts.prototype, Symbol.toStringTag, { value: 'EventCounts', configurable: true });
  Object.defineProperty(EventCounts.prototype, Symbol.iterator, { value: EventCounts.prototype.entries, writable: true, configurable: true });
  function createEventCounts(counts) {
    const eventCounts = Object.create(EventCounts.prototype);
    eventCountsSlots.set(eventCounts, counts);
    return eventCounts;
  }
  function eventCountsValue(value) {
    const counts = eventCountsSlots.get(value);
    if (!counts) throw new TypeError('Illegal invocation');
    return counts;
  }
  const performanceEntryState = new WeakMap();
  const performanceMarkState = new WeakMap();
  const performanceMeasureState = new WeakMap();
  const performanceExtendedEntryState = new WeakMap();
  const performanceEntryToken = {};
  class PerformanceEntry {
    constructor(token, name, entryType, startTime, duration) {
      if (token !== performanceEntryToken) throw new TypeError("Failed to construct 'PerformanceEntry': Illegal constructor");
      performanceEntryState.set(this, { name: String(name), entryType: String(entryType), startTime: rectNumber(startTime), duration: rectNumber(duration) });
    }
  }
  definePerformanceEntryPrototype(PerformanceEntry);
  class PerformanceMark extends PerformanceEntry {
    constructor(tokenOrName, nameOrOptions, startTime, detail = null) {
      if (tokenOrName === performanceEntryToken) {
        super(tokenOrName, nameOrOptions, 'mark', startTime, 0);
        performanceMarkState.set(this, { detail });
        return;
      }
      if (arguments.length < 1) throw new TypeError("Failed to construct 'PerformanceMark': 1 argument required, but only 0 present.");
      const options = markOptions(nameOrOptions);
      super(performanceEntryToken, tokenOrName, 'mark', options.startTime ?? currentPerformance().now(), 0);
      performanceMarkState.set(this, { detail: options.detail ?? null });
    }
  }
  Object.defineProperty(PerformanceMark, 'length', { value: 1, configurable: true });
  definePerformanceDetailPrototype(PerformanceMark, performanceMarkState, 'PerformanceMark');
  class PerformanceMeasure extends PerformanceEntry {
    constructor(token, name, startTime, duration, detail = null) {
      if (token !== performanceEntryToken) throw new TypeError("Failed to construct 'PerformanceMeasure': Illegal constructor");
      super(token, name, 'measure', startTime, duration);
      performanceMeasureState.set(this, { detail });
    }
  }
  Object.defineProperty(PerformanceMeasure, 'length', { value: 0, configurable: true });
  definePerformanceDetailPrototype(PerformanceMeasure, performanceMeasureState, 'PerformanceMeasure');

  function definePerformanceEntryPrototype(Ctor) {
    const constructorDescriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, 'constructor');
    delete Ctor.prototype.constructor;
    for (const key of ['name', 'entryType', 'startTime', 'duration']) Object.defineProperty(Ctor.prototype, key, { get() { return performanceEntryValue(this, key); }, enumerable: true, configurable: true });
    Object.defineProperty(Ctor.prototype, 'toJSON', { value: function toJSON() { return { name: this.name, entryType: this.entryType, startTime: this.startTime, duration: this.duration }; }, enumerable: true, configurable: true, writable: true });
    Object.defineProperty(Ctor.prototype, 'constructor', constructorDescriptor);
    Object.defineProperty(Ctor.prototype, Symbol.toStringTag, { value: 'PerformanceEntry', configurable: true });
  }

  function definePerformanceDetailPrototype(Ctor, stateMap, tag) {
    const constructorDescriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, 'constructor');
    delete Ctor.prototype.constructor;
    Object.defineProperty(Ctor.prototype, 'detail', { get() {
      const state = stateMap.get(this);
      if (!state) throw new TypeError('Illegal invocation');
      return state.detail;
    }, enumerable: true, configurable: true });
    Object.defineProperty(Ctor.prototype, 'constructor', constructorDescriptor);
    Object.defineProperty(Ctor.prototype, Symbol.toStringTag, { value: tag, configurable: true });
  }

  function performanceEntryValue(target, key) {
    const state = performanceEntryState.get(target);
    if (!state) throw new TypeError('Illegal invocation');
    return state[key];
  }

  function markOptions(options) {
    if (options === undefined || options === null) return {};
    if (typeof options !== 'object' && typeof options !== 'function') throw new TypeError("Failed to construct 'PerformanceMark': parameter 2 is not of type 'PerformanceMarkOptions'.");
    return { startTime: options.startTime === undefined ? undefined : rectNumber(options.startTime), detail: options.detail };
  }
  function setPerformanceExtendedState(target, state) {
    performanceExtendedEntryState.set(target, state);
  }
  function performanceExtendedValue(target, key) {
    const state = performanceExtendedEntryState.get(target);
    if (!state) throw new TypeError('Illegal invocation');
    return state[key];
  }
  function performanceEntryToJSON(target, keys) {
    const result = PerformanceEntry.prototype.toJSON.call(target);
    for (const key of keys) result[key] = target[key];
    return result;
  }
  function definePerformanceEntryFields(Ctor, fields, tag) {
    const constructorDescriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, 'constructor');
    delete Ctor.prototype.constructor;
    for (const key of fields) Object.defineProperty(Ctor.prototype, key, { get() { return performanceExtendedValue(this, key); }, enumerable: true, configurable: true });
    Object.defineProperty(Ctor.prototype, 'toJSON', { value: function toJSON() { return performanceEntryToJSON(this, fields); }, enumerable: true, configurable: true, writable: true });
    Object.defineProperty(Ctor.prototype, 'constructor', constructorDescriptor);
    Object.defineProperty(Ctor.prototype, Symbol.toStringTag, { value: tag, configurable: true });
  }
  function defineLayoutShiftAttributionPrototype(Ctor) {
    const constructorDescriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, 'constructor');
    delete Ctor.prototype.constructor;
    for (const key of ['node', 'previousRect', 'currentRect']) Object.defineProperty(Ctor.prototype, key, { get() { return performanceExtendedValue(this, key); }, enumerable: true, configurable: true });
    Object.defineProperty(Ctor.prototype, 'toJSON', { value: function toJSON() { return { node: this.node, previousRect: this.previousRect, currentRect: this.currentRect }; }, enumerable: true, configurable: true, writable: true });
    Object.defineProperty(Ctor.prototype, 'constructor', constructorDescriptor);
    Object.defineProperty(Ctor.prototype, Symbol.toStringTag, { value: 'LayoutShiftAttribution', configurable: true });
  }
  class PerformancePaintTiming extends PerformanceEntry {
    constructor(token, name = '', startTime = 0) {
      if (token !== performanceEntryToken) throw new TypeError("Failed to construct 'PerformancePaintTiming': Illegal constructor");
      super(token, name, 'paint', startTime, 0);
      setPerformanceExtendedState(this, { paintTime: this.startTime, presentationTime: this.startTime });
    }
  }
  class VisibilityStateEntry extends PerformanceEntry {
    constructor(token, name = '', startTime = 0) {
      if (token !== performanceEntryToken) throw new TypeError("Failed to construct 'VisibilityStateEntry': Illegal constructor");
      super(token, name, 'visibility-state', startTime, 0);
    }
  }
  function assertPerformanceEntryToken(token, interfaceName) {
    if (token !== performanceEntryToken) throw new TypeError("Failed to construct '" + interfaceName + "': Illegal constructor");
  }
  class PerformanceEventTiming extends PerformanceEntry {
    constructor(token, name = '', startTime = 0, duration = 0) {
      assertPerformanceEntryToken(token, 'PerformanceEventTiming');
      super(token, name, 'event', startTime, duration);
      setPerformanceExtendedState(this, { cancelable: false, interactionId: 0, processingStart: this.startTime, processingEnd: this.startTime + this.duration, target: null });
    }
  }
  class PerformanceLongTaskTiming extends PerformanceEntry {
    constructor(token, name = '', startTime = 0, duration = 0) {
      assertPerformanceEntryToken(token, 'PerformanceLongTaskTiming');
      super(token, name, 'longtask', startTime, duration);
      setPerformanceExtendedState(this, { attribution: Object.freeze([]) });
    }
  }
  class PerformanceLongAnimationFrameTiming extends PerformanceEntry {
    constructor(token, name = '', startTime = 0, duration = 0) {
      assertPerformanceEntryToken(token, 'PerformanceLongAnimationFrameTiming');
      super(token, name, 'long-animation-frame', startTime, duration);
      setPerformanceExtendedState(this, { blockingDuration: 0, firstUIEventTimestamp: 0, paintTime: 0, presentationTime: 0, renderStart: this.startTime, scripts: Object.freeze([]), styleAndLayoutStart: this.startTime });
    }
  }
  class PerformanceScriptTiming extends PerformanceEntry {
    constructor(token, name = '', startTime = 0, duration = 0) {
      assertPerformanceEntryToken(token, 'PerformanceScriptTiming');
      super(token, name, 'script', startTime, duration);
      setPerformanceExtendedState(this, { executionStart: this.startTime, forcedStyleAndLayoutDuration: 0, invoker: '', invokerType: '', pauseDuration: 0, sourceCharPosition: -1, sourceFunctionName: '', sourceURL: '', window: null, windowAttribution: 'self' });
    }
  }
  class PerformanceElementTiming extends PerformanceEntry {
    constructor(token, name = '', startTime = 0, duration = 0) {
      assertPerformanceEntryToken(token, 'PerformanceElementTiming');
      super(token, name, 'element', startTime, duration);
      setPerformanceExtendedState(this, { element: null, id: '', identifier: '', intersectionRect: new DOMRectReadOnly(0, 0, 0, 0), loadTime: 0, naturalHeight: 0, naturalWidth: 0, paintTime: 0, presentationTime: 0, renderTime: 0, url: '' });
    }
  }
  class LargestContentfulPaint extends PerformanceEntry {
    constructor(token, name = '', startTime = 0, duration = 0) {
      assertPerformanceEntryToken(token, 'LargestContentfulPaint');
      super(token, name, 'largest-contentful-paint', startTime, duration);
      setPerformanceExtendedState(this, { element: null, id: '', loadTime: 0, paintTime: 0, presentationTime: 0, renderTime: 0, size: 0, url: '' });
    }
  }
  class LayoutShift extends PerformanceEntry {
    constructor(token, name = '', startTime = 0, duration = 0) {
      assertPerformanceEntryToken(token, 'LayoutShift');
      super(token, name, 'layout-shift', startTime, duration);
      setPerformanceExtendedState(this, { hadRecentInput: false, lastInputTime: 0, sources: Object.freeze([]), value: 0 });
    }
  }
  class TaskAttributionTiming extends PerformanceEntry {
    constructor(token, name = '', startTime = 0, duration = 0) {
      assertPerformanceEntryToken(token, 'TaskAttributionTiming');
      super(token, name, 'taskattribution', startTime, duration);
      setPerformanceExtendedState(this, { containerId: '', containerName: '', containerSrc: '', containerType: '' });
    }
  }
  const layoutShiftAttributionToken = {};
  class LayoutShiftAttribution {
    constructor(token) {
      if (token !== layoutShiftAttributionToken) throw new TypeError("Failed to construct 'LayoutShiftAttribution': Illegal constructor");
      setPerformanceExtendedState(this, { node: null, previousRect: new DOMRectReadOnly(0, 0, 0, 0), currentRect: new DOMRectReadOnly(0, 0, 0, 0) });
    }
  }
  const performanceNavigationState = new WeakMap();
  function PerformanceNavigation() { throw new TypeError("Failed to construct 'PerformanceNavigation': Illegal constructor"); }
  function makePerformanceNavigation() {
    const navigation = Object.create(PerformanceNavigation.prototype);
    performanceNavigationState.set(navigation, { type: 0, redirectCount: 0 });
    return navigation;
  }

  const performanceTimingState = new WeakMap();
  function PerformanceTiming() { throw new TypeError("Failed to construct 'PerformanceTiming': Illegal constructor"); }
  const performanceTimingKeys = [
    'navigationStart', 'unloadEventStart', 'unloadEventEnd', 'redirectStart', 'redirectEnd',
    'fetchStart', 'domainLookupStart', 'domainLookupEnd', 'connectStart', 'connectEnd',
    'secureConnectionStart', 'requestStart', 'responseStart', 'responseEnd', 'domLoading',
    'domInteractive', 'domContentLoadedEventStart', 'domContentLoadedEventEnd', 'domComplete',
    'loadEventStart', 'loadEventEnd',
  ];
  const performanceTimingJSONKeys = [
    'connectStart', 'secureConnectionStart', 'unloadEventEnd', 'domainLookupStart', 'domainLookupEnd',
    'responseStart', 'connectEnd', 'responseEnd', 'requestStart', 'domLoading',
    'redirectStart', 'loadEventEnd', 'domComplete', 'navigationStart', 'loadEventStart',
    'domContentLoadedEventEnd', 'unloadEventStart', 'redirectEnd', 'domInteractive',
    'fetchStart', 'domContentLoadedEventStart',
  ];
  function makePerformanceTiming() {
    const timing = Object.create(PerformanceTiming.prototype);
    performanceTimingState.set(timing, Object.fromEntries(performanceTimingKeys.map((key) => [key, 0])));
    return timing;
  }
  function performanceTimingValue(target, key) {
    const state = performanceTimingState.get(target);
    if (!state) throw new TypeError('Illegal invocation');
    return state[key];
  }
  function performanceNavigationValue(target, key) {
    const state = performanceNavigationState.get(target);
    if (!state) throw new TypeError('Illegal invocation');
    return state[key];
  }
  function performanceTimingToJSON() {
    const result = {};
    for (const key of performanceTimingJSONKeys) result[key] = this[key];
    return result;
  }
  Object.defineProperty(performanceTimingToJSON, 'name', { value: 'toJSON', configurable: true });
  const performanceTimingConfidenceState = new WeakMap();
  const performanceTimingConfidenceToken = {};
  function PerformanceTimingConfidence(token, randomizedTriggerRate = 0, value = 'low') {
    if (token !== performanceTimingConfidenceToken) throw new TypeError("Failed to construct 'PerformanceTimingConfidence': Illegal constructor");
    performanceTimingConfidenceState.set(this, { randomizedTriggerRate: rectNumber(randomizedTriggerRate), value: String(value) });
  }
  function makePerformanceTimingConfidence() {
    return new PerformanceTimingConfidence(performanceTimingConfidenceToken, 0, 'low');
  }
  function performanceTimingConfidenceValue(target, key) {
    const state = performanceTimingConfidenceState.get(target);
    if (!state) throw new TypeError('Illegal invocation');
    return state[key];
  }
  const performanceServerTimingState = new WeakMap();
  const performanceServerTimingToken = {};
  class PerformanceServerTiming {
    constructor(token, name = '', duration = 0, description = '') {
      if (token !== performanceServerTimingToken) throw new TypeError("Failed to construct 'PerformanceServerTiming': Illegal constructor");
      performanceServerTimingState.set(this, { name: String(name), duration: rectNumber(duration), description: String(description) });
    }
  }
  const performanceServerTimingConstructorDescriptor = Object.getOwnPropertyDescriptor(PerformanceServerTiming.prototype, 'constructor');
  delete PerformanceServerTiming.prototype.constructor;
  for (const key of ['name', 'duration', 'description']) Object.defineProperty(PerformanceServerTiming.prototype, key, { get() {
    const state = performanceServerTimingState.get(this);
    if (!state) throw new TypeError('Illegal invocation');
    return state[key];
  }, enumerable: true, configurable: true });
  Object.defineProperty(PerformanceServerTiming.prototype, 'toJSON', { value: function toJSON() { return { name: this.name, duration: this.duration, description: this.description }; }, enumerable: true, configurable: true, writable: true });
  Object.defineProperty(PerformanceServerTiming.prototype, 'constructor', performanceServerTimingConstructorDescriptor);
  Object.defineProperty(PerformanceServerTiming.prototype, Symbol.toStringTag, { value: 'PerformanceServerTiming', configurable: true });

  const performanceResourceTimingState = new WeakMap();
  const performanceResourceTimingKeysBeforeToJSON = [
    'initiatorType', 'nextHopProtocol', 'deliveryType', 'workerStart', 'redirectStart', 'redirectEnd',
    'fetchStart', 'domainLookupStart', 'domainLookupEnd', 'connectStart', 'connectEnd',
    'secureConnectionStart', 'requestStart', 'responseStart', 'responseEnd', 'transferSize',
    'encodedBodySize', 'decodedBodySize', 'serverTiming', 'responseStatus',
    'finalResponseHeadersStart', 'firstInterimResponseStart',
  ];
  const performanceResourceTimingKeysAfterToJSON = [
    'workerRouterEvaluationStart', 'workerCacheLookupStart', 'workerMatchedSourceType',
    'workerFinalSourceType', 'renderBlockingStatus', 'contentType', 'contentEncoding',
  ];
  class PerformanceResourceTiming extends PerformanceEntry {
    constructor(token, name, entryType = 'resource', startTime = 0, duration = 0, init = {}) {
      if (token !== performanceEntryToken) throw new TypeError("Failed to construct 'PerformanceResourceTiming': Illegal constructor");
      super(token, name, entryType, startTime, duration);
      performanceResourceTimingState.set(this, makePerformanceResourceTimingState(init, startTime, duration));
    }
  }
  definePerformanceResourceTimingPrototype(PerformanceResourceTiming);

  function makePerformanceResourceTimingState(init, startTime, duration) {
    return {
      initiatorType: String(init.initiatorType || ''),
      nextHopProtocol: String(init.nextHopProtocol || ''),
      deliveryType: String(init.deliveryType || ''),
      workerStart: rectNumber(init.workerStart),
      redirectStart: rectNumber(init.redirectStart),
      redirectEnd: rectNumber(init.redirectEnd),
      fetchStart: rectNumber(init.fetchStart ?? startTime),
      domainLookupStart: rectNumber(init.domainLookupStart),
      domainLookupEnd: rectNumber(init.domainLookupEnd),
      connectStart: rectNumber(init.connectStart),
      connectEnd: rectNumber(init.connectEnd),
      secureConnectionStart: rectNumber(init.secureConnectionStart),
      requestStart: rectNumber(init.requestStart),
      responseStart: rectNumber(init.responseStart),
      responseEnd: rectNumber(init.responseEnd ?? (rectNumber(startTime) + rectNumber(duration))),
      transferSize: rectNumber(init.transferSize),
      encodedBodySize: rectNumber(init.encodedBodySize),
      decodedBodySize: rectNumber(init.decodedBodySize),
      serverTiming: Object.freeze([...(init.serverTiming || [])]),
      responseStatus: rectNumber(init.responseStatus),
      finalResponseHeadersStart: rectNumber(init.finalResponseHeadersStart),
      firstInterimResponseStart: rectNumber(init.firstInterimResponseStart),
      workerRouterEvaluationStart: rectNumber(init.workerRouterEvaluationStart),
      workerCacheLookupStart: rectNumber(init.workerCacheLookupStart),
      workerMatchedSourceType: String(init.workerMatchedSourceType || ''),
      workerFinalSourceType: String(init.workerFinalSourceType || ''),
      renderBlockingStatus: String(init.renderBlockingStatus || 'non-blocking'),
      contentType: String(init.contentType || ''),
      contentEncoding: String(init.contentEncoding || ''),
    };
  }

  function definePerformanceResourceTimingPrototype(Ctor) {
    const constructorDescriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, 'constructor');
    delete Ctor.prototype.constructor;
    for (const key of performanceResourceTimingKeysBeforeToJSON) Object.defineProperty(Ctor.prototype, key, { get() { return performanceResourceTimingValue(this, key); }, enumerable: true, configurable: true });
    Object.defineProperty(Ctor.prototype, 'toJSON', { value: performanceResourceTimingToJSON, enumerable: true, configurable: true, writable: true });
    for (const key of performanceResourceTimingKeysAfterToJSON) Object.defineProperty(Ctor.prototype, key, { get() { return performanceResourceTimingValue(this, key); }, enumerable: true, configurable: true });
    Object.defineProperty(Ctor.prototype, 'constructor', constructorDescriptor);
    Object.defineProperty(Ctor.prototype, Symbol.toStringTag, { value: 'PerformanceResourceTiming', configurable: true });
  }

  function performanceResourceTimingValue(target, key) {
    const state = performanceResourceTimingState.get(target);
    if (!state) throw new TypeError('Illegal invocation');
    return state[key];
  }

  function performanceResourceTimingToJSON() {
    const result = { ...PerformanceEntry.prototype.toJSON.call(this) };
    for (const key of [...performanceResourceTimingKeysBeforeToJSON, ...performanceResourceTimingKeysAfterToJSON]) {
      const value = this[key];
      result[key] = key === 'serverTiming' ? value.map((entry) => entry.toJSON()) : value;
    }
    return result;
  }

  const performanceNavigationTimingState = new WeakMap();
  const performanceNavigationTimingKeys = [
    'unloadEventStart', 'unloadEventEnd', 'domInteractive', 'domContentLoadedEventStart',
    'domContentLoadedEventEnd', 'domComplete', 'loadEventStart', 'loadEventEnd',
    'type', 'redirectCount', 'criticalCHRestart', 'activationStart',
  ];
  class PerformanceNavigationTiming extends PerformanceResourceTiming {
    constructor(token, name) {
      if (token !== performanceEntryToken) throw new TypeError("Failed to construct 'PerformanceNavigationTiming': Illegal constructor");
      super(token, name, 'navigation', 0, 0, { initiatorType: 'navigation', responseEnd: 0 });
      performanceNavigationTimingState.set(this, {
        unloadEventStart: 0,
        unloadEventEnd: 0,
        domInteractive: 0,
        domContentLoadedEventStart: 0,
        domContentLoadedEventEnd: 0,
        domComplete: 0,
        loadEventStart: 0,
        loadEventEnd: 0,
        type: 'navigate',
        redirectCount: 0,
        criticalCHRestart: 0,
        activationStart: 0,
        confidence: makePerformanceTimingConfidence(),
        notRestoredReasons: null,
      });
    }
  }
  definePerformanceNavigationTimingPrototype(PerformanceNavigationTiming);

  function definePerformanceNavigationTimingPrototype(Ctor) {
    const constructorDescriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, 'constructor');
    delete Ctor.prototype.constructor;
    for (const key of performanceNavigationTimingKeys) Object.defineProperty(Ctor.prototype, key, { get() { return performanceNavigationTimingValue(this, key); }, enumerable: true, configurable: true });
    Object.defineProperty(Ctor.prototype, 'toJSON', { value: performanceNavigationTimingToJSON, enumerable: true, configurable: true, writable: true });
    Object.defineProperty(Ctor.prototype, 'confidence', { get() { return performanceNavigationTimingValue(this, 'confidence'); }, enumerable: true, configurable: true });
    Object.defineProperty(Ctor.prototype, 'constructor', constructorDescriptor);
    Object.defineProperty(Ctor.prototype, 'notRestoredReasons', { get() { return performanceNavigationTimingValue(this, 'notRestoredReasons'); }, enumerable: true, configurable: true });
    Object.defineProperty(Ctor.prototype, Symbol.toStringTag, { value: 'PerformanceNavigationTiming', configurable: true });
  }

  function performanceNavigationTimingValue(target, key) {
    const state = performanceNavigationTimingState.get(target);
    if (!state) throw new TypeError('Illegal invocation');
    return state[key];
  }

  function performanceNavigationTimingToJSON() {
    return {
      ...PerformanceResourceTiming.prototype.toJSON.call(this),
      unloadEventStart: this.unloadEventStart,
      unloadEventEnd: this.unloadEventEnd,
      domInteractive: this.domInteractive,
      domContentLoadedEventStart: this.domContentLoadedEventStart,
      domContentLoadedEventEnd: this.domContentLoadedEventEnd,
      domComplete: this.domComplete,
      loadEventStart: this.loadEventStart,
      loadEventEnd: this.loadEventEnd,
      type: this.type,
      redirectCount: this.redirectCount,
      activationStart: this.activationStart,
      criticalCHRestart: this.criticalCHRestart,
      notRestoredReasons: this.notRestoredReasons,
      confidence: this.confidence,
    };
  }
  Object.defineProperty(performanceNavigationTimingToJSON, 'name', { value: 'toJSON', configurable: true });
  Object.defineProperty(PerformanceMeasure.prototype, Symbol.toStringTag, { value: 'PerformanceMeasure', configurable: true });
  definePerformanceEntryFields(PerformancePaintTiming, ['paintTime', 'presentationTime'], 'PerformancePaintTiming');
  Object.defineProperty(VisibilityStateEntry.prototype, Symbol.toStringTag, { value: 'VisibilityStateEntry', configurable: true });
  definePerformanceEntryFields(PerformanceEventTiming, ['cancelable', 'interactionId', 'processingEnd', 'processingStart', 'target'], 'PerformanceEventTiming');
  definePerformanceEntryFields(PerformanceLongTaskTiming, ['attribution'], 'PerformanceLongTaskTiming');
  definePerformanceEntryFields(PerformanceLongAnimationFrameTiming, ['blockingDuration', 'firstUIEventTimestamp', 'paintTime', 'presentationTime', 'renderStart', 'scripts', 'styleAndLayoutStart'], 'PerformanceLongAnimationFrameTiming');
  definePerformanceEntryFields(PerformanceScriptTiming, ['executionStart', 'forcedStyleAndLayoutDuration', 'invoker', 'invokerType', 'pauseDuration', 'sourceCharPosition', 'sourceFunctionName', 'sourceURL', 'window', 'windowAttribution'], 'PerformanceScriptTiming');
  definePerformanceEntryFields(PerformanceElementTiming, ['element', 'id', 'identifier', 'intersectionRect', 'loadTime', 'naturalHeight', 'naturalWidth', 'paintTime', 'presentationTime', 'renderTime', 'url'], 'PerformanceElementTiming');
  definePerformanceEntryFields(LargestContentfulPaint, ['element', 'id', 'loadTime', 'paintTime', 'presentationTime', 'renderTime', 'size', 'url'], 'LargestContentfulPaint');
  definePerformanceEntryFields(LayoutShift, ['hadRecentInput', 'lastInputTime', 'sources', 'value'], 'LayoutShift');
  definePerformanceEntryFields(TaskAttributionTiming, ['containerId', 'containerName', 'containerSrc', 'containerType'], 'TaskAttributionTiming');
  defineLayoutShiftAttributionPrototype(LayoutShiftAttribution);
  const performanceNavigationConstructorDescriptor = Object.getOwnPropertyDescriptor(PerformanceNavigation.prototype, 'constructor');
  delete PerformanceNavigation.prototype.constructor;
  Object.defineProperty(PerformanceNavigation.prototype, 'type', { get() { return performanceNavigationValue(this, 'type'); }, enumerable: true, configurable: true });
  Object.defineProperty(PerformanceNavigation.prototype, 'redirectCount', { get() { return performanceNavigationValue(this, 'redirectCount'); }, enumerable: true, configurable: true });
  Object.defineProperties(PerformanceNavigation.prototype, {
    TYPE_NAVIGATE: { value: 0, enumerable: true },
    TYPE_RELOAD: { value: 1, enumerable: true },
    TYPE_BACK_FORWARD: { value: 2, enumerable: true },
    TYPE_RESERVED: { value: 255, enumerable: true },
    toJSON: { value: function toJSON() { return { type: this.type, redirectCount: this.redirectCount }; }, enumerable: true, configurable: true, writable: true },
    constructor: performanceNavigationConstructorDescriptor,
  });
  Object.defineProperties(PerformanceNavigation, {
    TYPE_NAVIGATE: { value: 0, enumerable: true },
    TYPE_RELOAD: { value: 1, enumerable: true },
    TYPE_BACK_FORWARD: { value: 2, enumerable: true },
    TYPE_RESERVED: { value: 255, enumerable: true },
  });
  Object.defineProperty(PerformanceNavigation.prototype, Symbol.toStringTag, { value: 'PerformanceNavigation', configurable: true });
  const performanceTimingConstructorDescriptor = Object.getOwnPropertyDescriptor(PerformanceTiming.prototype, 'constructor');
  delete PerformanceTiming.prototype.constructor;
  for (const key of performanceTimingKeys) Object.defineProperty(PerformanceTiming.prototype, key, { get() { return performanceTimingValue(this, key); }, enumerable: true, configurable: true });
  Object.defineProperty(PerformanceTiming.prototype, 'toJSON', { value: performanceTimingToJSON, enumerable: true, configurable: true, writable: true });
  Object.defineProperty(PerformanceTiming.prototype, 'constructor', performanceTimingConstructorDescriptor);
  Object.defineProperty(PerformanceTiming.prototype, Symbol.toStringTag, { value: 'PerformanceTiming', configurable: true });
  const performanceTimingConfidenceConstructorDescriptor = Object.getOwnPropertyDescriptor(PerformanceTimingConfidence.prototype, 'constructor');
  delete PerformanceTimingConfidence.prototype.constructor;
  for (const key of ['randomizedTriggerRate', 'value']) Object.defineProperty(PerformanceTimingConfidence.prototype, key, { get() { return performanceTimingConfidenceValue(this, key); }, enumerable: true, configurable: true });
  Object.defineProperty(PerformanceTimingConfidence.prototype, 'toJSON', { value: function toJSON() { return { randomizedTriggerRate: this.randomizedTriggerRate, value: this.value }; }, enumerable: true, configurable: true, writable: true });
  Object.defineProperty(PerformanceTimingConfidence.prototype, 'constructor', performanceTimingConfidenceConstructorDescriptor);
  Object.defineProperty(PerformanceTimingConfidence.prototype, Symbol.toStringTag, { value: 'PerformanceTimingConfidence', configurable: true });

  const performanceObserverEntryListState = new WeakMap();
  const performanceObserverEntryListToken = {};
  class PerformanceObserverEntryList {
    constructor(token, entries) {
      if (token !== performanceObserverEntryListToken) throw new TypeError("Failed to construct 'PerformanceObserverEntryList': Illegal constructor");
      performanceObserverEntryListState.set(this, [...entries]);
    }
  }
  function performanceObserverEntryListEntries(target) {
    const entries = performanceObserverEntryListState.get(target);
    if (!entries) throw new TypeError('Illegal invocation');
    return entries;
  }
  const performanceObserverEntryListConstructorDescriptor = Object.getOwnPropertyDescriptor(PerformanceObserverEntryList.prototype, 'constructor');
  delete PerformanceObserverEntryList.prototype.constructor;
  Object.defineProperty(PerformanceObserverEntryList.prototype, 'getEntries', { value: function getEntries() { return [...performanceObserverEntryListEntries(this)]; }, enumerable: true, configurable: true, writable: true });
  Object.defineProperty(PerformanceObserverEntryList.prototype, 'getEntriesByName', { value: function getEntriesByName(name, type = undefined) { return performanceObserverEntryListEntries(this).filter((entry) => entry.name === String(name) && (type === undefined || entry.entryType === String(type))); }, enumerable: true, configurable: true, writable: true });
  Object.defineProperty(PerformanceObserverEntryList.prototype, 'getEntriesByType', { value: function getEntriesByType(type) { return performanceObserverEntryListEntries(this).filter((entry) => entry.entryType === String(type)); }, enumerable: true, configurable: true, writable: true });
  Object.defineProperty(PerformanceObserverEntryList.prototype, 'constructor', performanceObserverEntryListConstructorDescriptor);
  Object.defineProperty(PerformanceObserverEntryList.prototype, Symbol.toStringTag, { value: 'PerformanceObserverEntryList', configurable: true });

  class PerformanceObserver {
    constructor(callback) {
      if (typeof callback !== 'function') throw new TypeError("Failed to construct 'PerformanceObserver': parameter 1 is not of type 'Function'.");
      this.__zpCallback = callback;
      this.__zpEntryTypes = new Set();
      this.__zpRecords = [];
      this.__zpQueued = false;
      this.__zpRegistered = false;
    }
    observe(options = {}) {
      const entryTypes = performanceObserverTypes(options);
      if (entryTypes.length === 0) throw new TypeError("Failed to execute 'observe' on 'PerformanceObserver': No valid entryTypes were supplied.");
      this.__zpEntryTypes = new Set(entryTypes);
      currentPerformance().__zpRegisterObserver(this);
      if (options.buffered) for (const entry of currentPerformance().getEntries()) queuePerformanceObserverEntry(this, entry);
    }
    disconnect() {
      currentPerformance().__zpUnregisterObserver(this);
      this.__zpRecords = [];
      this.__zpQueued = false;
    }
    takeRecords() {
      const records = this.__zpRecords;
      this.__zpRecords = [];
      this.__zpQueued = false;
      return [...records];
    }
    static get supportedEntryTypes() { return ['navigation', 'mark', 'measure']; }
  }

  function queuePerformanceObserverEntry(observer, entry) {
    if (!observer.__zpEntryTypes.has(entry.entryType)) return;
    observer.__zpRecords.push(entry);
    if (observer.__zpQueued) return;
    observer.__zpQueued = true;
    Promise.resolve().then(() => {
      const records = observer.takeRecords();
      if (records.length > 0) observer.__zpCallback(new PerformanceObserverEntryList(performanceObserverEntryListToken, records), observer);
    });
  }
  Object.defineProperty(PerformanceObserver.prototype, Symbol.toStringTag, { value: 'PerformanceObserver', configurable: true });

  const animationTimelineToken = {};
  const animationTimelineState = new WeakMap();
  function timelineStateFor(value) {
    const state = animationTimelineState.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }
  class AnimationTimeline {
    constructor(token) {
      if (token !== animationTimelineToken) throw new TypeError("Failed to construct 'AnimationTimeline': Illegal constructor");
      animationTimelineState.set(this, { originTime: 0, source: null, axis: 'block', subject: null, startOffset: null, endOffset: null });
    }
    get currentTime() { return viewport.now - timelineStateFor(this).originTime; }
    get duration() { return null; }
  }
  Object.defineProperty(AnimationTimeline.prototype, Symbol.toStringTag, { value: 'AnimationTimeline', configurable: true });

  class DocumentTimeline extends AnimationTimeline {
    constructor(options = {}) {
      super(animationTimelineToken);
      timelineStateFor(this).originTime = rectNumber(options.originTime);
    }
  }
  Object.defineProperty(DocumentTimeline.prototype, Symbol.toStringTag, { value: 'DocumentTimeline', configurable: true });

  class ScrollTimeline extends AnimationTimeline {
    constructor(options = {}) {
      super(animationTimelineToken);
      const state = timelineStateFor(this);
      state.source = options.source ?? null;
      state.axis = normalizeTimelineAxis(options.axis);
    }
    get source() { return timelineStateFor(this).source; }
    get axis() { return timelineStateFor(this).axis; }
  }
  Object.defineProperty(ScrollTimeline.prototype, Symbol.toStringTag, { value: 'ScrollTimeline', configurable: true });

  class ViewTimeline extends ScrollTimeline {
    constructor(options = {}) {
      super({ source: options.subject ?? null, axis: options.axis });
      const state = timelineStateFor(this);
      state.subject = options.subject ?? null;
      state.startOffset = options.startOffset ?? null;
      state.endOffset = options.endOffset ?? null;
      this.inset = options.inset ?? 'auto';
    }
    get subject() { return timelineStateFor(this).subject; }
    get startOffset() { return timelineStateFor(this).startOffset; }
    get endOffset() { return timelineStateFor(this).endOffset; }
  }
  Object.defineProperty(ViewTimeline.prototype, Symbol.toStringTag, { value: 'ViewTimeline', configurable: true });

  function normalizeTimelineAxis(axis) {
    const value = String(axis ?? 'block');
    return ['block', 'inline', 'x', 'y'].includes(value) ? value : 'block';
  }

  const animationEffectToken = {};
  const animationEffectState = new WeakMap();
  function animationEffectStateFor(value) {
    const state = animationEffectState.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }
  class AnimationEffect {
    constructor(token) {
      if (token !== animationEffectToken) throw new TypeError("Failed to construct 'AnimationEffect': Illegal constructor");
      animationEffectState.set(this, { target: null, pseudoElement: null, composite: 'replace', keyframes: [], timing: normalizeAnimationTiming() });
    }
    getTiming() { return { ...animationEffectStateFor(this).timing }; }
    getComputedTiming() {
      const timing = animationEffectStateFor(this).timing;
      return { ...timing, activeDuration: timing.duration, endTime: timing.duration, localTime: null, progress: null, currentIteration: null };
    }
    updateTiming(options = {}) {
      const state = animationEffectStateFor(this);
      state.timing = { ...state.timing, ...normalizeAnimationTiming(options, state.timing) };
    }
  }
  Object.defineProperty(AnimationEffect.prototype, Symbol.toStringTag, { value: 'AnimationEffect', configurable: true });

  class KeyframeEffect extends AnimationEffect {
    constructor(target = null, keyframes = [], options = {}) {
      super(animationEffectToken);
      const state = animationEffectStateFor(this);
      state.target = target;
      state.keyframes = normalizeKeyframes(keyframes);
      state.timing = normalizeAnimationTiming(options);
    }
    get target() { return animationEffectStateFor(this).target; }
    set target(value) { animationEffectStateFor(this).target = value; }
    get pseudoElement() { return animationEffectStateFor(this).pseudoElement; }
    set pseudoElement(value) { animationEffectStateFor(this).pseudoElement = value; }
    get composite() { return animationEffectStateFor(this).composite; }
    set composite(value) { animationEffectStateFor(this).composite = String(value); }
    getKeyframes() { return animationEffectStateFor(this).keyframes.map((frame) => ({ ...frame })); }
    setKeyframes(keyframes) { animationEffectStateFor(this).keyframes = normalizeKeyframes(keyframes); }
  }
  Object.defineProperty(KeyframeEffect.prototype, Symbol.toStringTag, { value: 'KeyframeEffect', configurable: true });

  class Animation extends VirtualEventTarget {
    constructor(effect = null, timeline = globalThis.document?.timeline || null) {
      super();
      this.id = '';
      this.effect = effect;
      this.timeline = timeline;
      this.startTime = null;
      this.currentTime = null;
      this.playbackRate = 1;
      this.playState = 'idle';
      this.replaceState = 'active';
      this.pending = false;
      this.ready = Promise.resolve(this);
      this.finished = Promise.resolve(this);
    }
    play() { this.playState = 'running'; if (this.currentTime === null) this.currentTime = 0; }
    pause() { this.playState = 'paused'; if (this.currentTime === null) this.currentTime = 0; }
    cancel() { this.playState = 'idle'; this.currentTime = null; this.dispatchEvent(new VirtualEvent('cancel')); }
    finish() { this.playState = 'finished'; this.currentTime = this.effect?.getTiming?.().duration || 0; this.dispatchEvent(new VirtualEvent('finish')); }
    reverse() { this.playbackRate = -this.playbackRate || -1; this.play(); }
    updatePlaybackRate(rate) { this.playbackRate = rectNumber(rate); }
    persist() { this.replaceState = 'persisted'; }
    commitStyles() {}
  }
  Object.defineProperty(Animation.prototype, Symbol.toStringTag, { value: 'Animation', configurable: true });

  function CSSAnimation() { throw new TypeError("Failed to construct 'CSSAnimation': Illegal constructor"); }
  CSSAnimation.prototype = Object.create(Animation.prototype, { constructor: { value: CSSAnimation, writable: true, configurable: true } });
  Object.defineProperty(CSSAnimation.prototype, 'animationName', { get() { return ''; }, enumerable: true, configurable: true });
  Object.defineProperty(CSSAnimation.prototype, Symbol.toStringTag, { value: 'CSSAnimation', configurable: true });

  function CSSTransition() { throw new TypeError("Failed to construct 'CSSTransition': Illegal constructor"); }
  CSSTransition.prototype = Object.create(Animation.prototype, { constructor: { value: CSSTransition, writable: true, configurable: true } });
  Object.defineProperty(CSSTransition.prototype, 'transitionProperty', { get() { return ''; }, enumerable: true, configurable: true });
  Object.defineProperty(CSSTransition.prototype, Symbol.toStringTag, { value: 'CSSTransition', configurable: true });

  function activeAnimationsFor(predicate) {
    return Array.from(virtualAnimations).filter((animation) => animation.playState !== 'idle' && predicate(animation));
  }

  function normalizeKeyframes(keyframes) {
    if (Array.isArray(keyframes)) return keyframes.map((frame) => ({ ...frame }));
    if (!keyframes || typeof keyframes !== 'object') return [];
    return Object.keys(keyframes).map((property) => ({ [property]: keyframes[property] }));
  }

  function normalizeAnimationTiming(options = {}, base = {}) {
    const timing = typeof options === 'number' ? { duration: options } : options;
    return {
      delay: rectNumber(timing.delay ?? base.delay),
      endDelay: rectNumber(timing.endDelay ?? base.endDelay),
      fill: timing.fill || base.fill || 'auto',
      iterationStart: rectNumber(timing.iterationStart ?? base.iterationStart),
      iterations: rectNumber(timing.iterations ?? base.iterations ?? 1),
      duration: rectNumber(timing.duration ?? base.duration),
      direction: timing.direction || base.direction || 'normal',
      easing: timing.easing || base.easing || 'linear',
    };
  }

  function performanceObserverTypes(options = {}) {
    const types = [];
    if (Array.isArray(options.entryTypes)) types.push(...options.entryTypes);
    if (options.type !== undefined) types.push(options.type);
    return [...new Set(types.map((type) => String(type)).filter((type) => PerformanceObserver.supportedEntryTypes.includes(type)))];
  }


  class VirtualPerformance {
    constructor() {
      this.__zpPerformance = true;
      this.timeOrigin = 0;
      this.__zpEntries = [new PerformanceNavigationTiming(performanceEntryToken, performanceNavigationName)];
      this.__zpObservers = new Set();
      this.__zpEventCounts = new Map();
      this.eventCounts = createEventCounts(this.__zpEventCounts);
      this.navigation = makePerformanceNavigation();
      this.timing = makePerformanceTiming();
    }
    now() { return viewport.now; }
    mark(name, options = undefined) {
      const markInit = markOptions(options);
      const entry = new PerformanceMark(performanceEntryToken, name, markInit.startTime ?? this.now(), markInit.detail ?? null);
      this.__zpEntries.push(entry);
      this.__zpNotify(entry);
      return entry;
    }
    measure(name, startOrOptions = 0, end = undefined) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'measure' on 'Performance': 1 argument required, but only 0 present.");
      const measureName = performanceDOMString(name, 'measure');
      const resolved = resolveMeasureTiming(this.__zpEntries, this.now(), startOrOptions, end);
      const entry = new PerformanceMeasure(performanceEntryToken, measureName, resolved.startTime, resolved.duration, resolved.detail);
      this.__zpEntries.push(entry);
      this.__zpNotify(entry);
      return entry;
    }
    getEntries() { return [...this.__zpEntries]; }
    getEntriesByName(name, type = undefined) { return this.__zpEntries.filter((entry) => entry.name === String(name) && (type === undefined || entry.entryType === String(type))); }
    getEntriesByType(type) { return this.__zpEntries.filter((entry) => entry.entryType === String(type)); }
    clearMarks(name = undefined) { this.__zpEntries = this.__zpEntries.filter((entry) => entry.entryType !== 'mark' || (name !== undefined && entry.name !== String(name))); }
    clearMeasures(name = undefined) { this.__zpEntries = this.__zpEntries.filter((entry) => entry.entryType !== 'measure' || (name !== undefined && entry.name !== String(name))); }
    __zpRegisterObserver(observer) { this.__zpObservers.add(observer); observer.__zpRegistered = true; }
    __zpUnregisterObserver(observer) { this.__zpObservers.delete(observer); observer.__zpRegistered = false; }
    __zpNotify(entry) { for (const observer of [...this.__zpObservers]) queuePerformanceObserverEntry(observer, entry); }
    __zpCountEvent(type) {
      const key = String(type || '');
      this.__zpEventCounts.set(key, (this.__zpEventCounts.get(key) || 0) + 1);
    }
    clearResourceTimings() { this.__zpEntries = this.__zpEntries.filter((entry) => entry.entryType !== 'resource'); }
  }
  Object.defineProperty(VirtualPerformance.prototype, Symbol.toStringTag, { value: 'Performance', configurable: true });

  function currentPerformance() {
    return (performanceObject ||= new VirtualPerformance());
  }

  function performanceEntry(name, entryType, startTime, duration) {
    return entryType === 'mark'
      ? new PerformanceMark(performanceEntryToken, name, startTime)
      : new PerformanceMeasure(performanceEntryToken, name, startTime, duration);
  }

  function resolveMeasureTiming(entries, now, startOrOptions, end) {
    const isOptions = startOrOptions !== null && (typeof startOrOptions === 'object' || typeof startOrOptions === 'function');
    if (!isOptions) {
      const startTime = performanceMeasureTime(entries, startOrOptions, 'measure');
      const endTime = end === undefined ? now : performanceMeasureTime(entries, end, 'measure');
      return { startTime, duration: Math.max(0, endTime - startTime), detail: null };
    }
    const options = startOrOptions;
    const hasStart = options.start !== undefined;
    const hasEnd = options.end !== undefined;
    const hasDuration = options.duration !== undefined;
    if (hasStart && hasEnd && hasDuration) throw new TypeError("Failed to execute 'measure' on 'Performance': If a non-empty PerformanceMeasureOptions object was passed, it must not have all of its 'start', 'duration', and 'end' properties defined");
    const duration = hasDuration ? rectNumber(options.duration) : undefined;
    const startPoint = hasStart ? performanceMeasureTime(entries, options.start, 'measure') : undefined;
    const endPoint = hasEnd ? performanceMeasureTime(entries, options.end, 'measure') : undefined;
    if (hasStart && hasEnd) return { startTime: startPoint, duration: Math.max(0, endPoint - startPoint), detail: options.detail ?? null };
    if (hasStart && hasDuration) return { startTime: startPoint, duration: Math.max(0, duration), detail: options.detail ?? null };
    if (hasEnd && hasDuration) return { startTime: Math.max(0, endPoint - duration), duration: Math.max(0, duration), detail: options.detail ?? null };
    if (hasEnd) return { startTime: 0, duration: Math.max(0, endPoint), detail: options.detail ?? null };
    if (hasDuration) return { startTime: 0, duration: Math.max(0, duration), detail: options.detail ?? null };
    if (hasStart) return { startTime: startPoint, duration: Math.max(0, now - startPoint), detail: options.detail ?? null };
    return { startTime: 0, duration: Math.max(0, now), detail: options.detail ?? null };
  }

  function performanceDOMString(value, operation) {
    if (typeof value === 'symbol') throw new TypeError("Failed to execute '" + operation + "' on 'Performance': Cannot convert a Symbol value to a string");
    return String(value);
  }

  function performanceTime(entries, value) {
    if (typeof value !== 'string') return Number(value || 0);
    for (let index = entries.length - 1; index >= 0; index -= 1) if (entries[index].name === value) return entries[index].startTime;
    return 0;
  }

  function performanceMeasureTime(entries, value, operation) {
    if (typeof value !== 'string') return Number(value || 0);
    for (let index = entries.length - 1; index >= 0; index -= 1) if (entries[index].name === value) return entries[index].startTime;
    throw new SyntaxError("Failed to execute '" + operation + "' on 'Performance': The mark '" + value + "' does not exist.");
  }

  const visualViewportSlots = new WeakSet();
  function VisualViewport() { throw new TypeError("Failed to construct 'VisualViewport': Illegal constructor"); }
  Object.defineProperty(VisualViewport, Symbol.hasInstance, { value: (value) => visualViewportSlots.has(value), configurable: true });

  class VirtualVisualViewport extends VirtualEventTarget {
    constructor() {
      super();
      visualViewportSlots.add(this);
    }
    get width() { return viewport.innerWidth; }
    get height() { return viewport.innerHeight; }
    get offsetLeft() { return viewport.scrollX; }
    get offsetTop() { return viewport.scrollY; }
    get pageLeft() { return viewport.scrollX; }
    get pageTop() { return viewport.scrollY; }
    get scale() { return viewport.scale; }
    get onresize() { return this.__zp_onresize || null; }
    set onresize(value) { this.__zp_onresize = typeof value === 'function' ? value : null; }
    get onscroll() { return this.__zp_onscroll || null; }
    set onscroll(value) { this.__zp_onscroll = typeof value === 'function' ? value : null; }
    get onscrollend() { return this.__zp_onscrollend || null; }
    set onscrollend(value) { this.__zp_onscrollend = typeof value === 'function' ? value : null; }
  }
  Object.defineProperty(VirtualVisualViewport.prototype, Symbol.toStringTag, { value: 'VisualViewport', configurable: true });
  Object.defineProperty(VisualViewport, 'prototype', { value: VirtualVisualViewport.prototype });
  Object.defineProperty(VirtualVisualViewport.prototype, 'constructor', { value: VisualViewport, writable: true, configurable: true });
  makeDescriptorsEnumerable(VirtualVisualViewport.prototype, ['offsetLeft', 'offsetTop', 'pageLeft', 'pageTop', 'width', 'height', 'scale', 'onresize', 'onscroll', 'onscrollend']);

  function currentVisualViewport() {
    return (visualViewport ||= new VirtualVisualViewport());
  }

  function currentWindowEventTarget() {
    if (!windowEventTarget) {
      windowEventTarget = new VirtualEventTarget();
      for (const prop of handlerProps) windowEventTarget[prop] = null;
    }
    return windowEventTarget;
  }

  function namedWindowAccessor(kind, name, callback) {
    let fn;
    if (kind === 'set') fn = function set(value) { return callback(value); };
    else fn = function get() { return callback(); };
    Object.defineProperty(fn, 'name', { value: kind + ' ' + name, configurable: true });
    return fn;
  }

  function defineWindowAccessor(name, getValue, setValue = null, configurable = true) {
    const descriptor = {
      get: namedWindowAccessor('get', name, getValue),
      enumerable: true,
      configurable,
    };
    if (setValue) descriptor.set = namedWindowAccessor('set', name, setValue);
    Object.defineProperty(globalThis, name, descriptor);
  }



  function installGlobals(doc) {
    defineWindowAccessor('window', () => globalThis, null, false);
    defineWindowAccessor('self', () => globalThis, () => {});
    globalThis.Window = Window;
    Object.defineProperty(globalThis, 'BarProp', { value: BarProp, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'External', { value: External, writable: true, configurable: true });
    globalThis.FragmentDirective = FragmentDirective;
    Object.defineProperty(globalThis, Symbol.toStringTag, { value: 'Window', configurable: true });
    defineWindowAccessor('document', () => doc, null, false);
    defineWindowAccessor('location', () => doc.location, (value) => { doc.location.href = String(value); }, false);
    defineWindowAccessor('frames', () => globalThis, () => {});
    defineWindowAccessor('parent', () => globalThis, () => {});
    defineWindowAccessor('top', () => globalThis, null, false);
    windowOpenerValue = null;
    windowNameValue = '';
    windowStatusValue = '';
    windowEventValue = undefined;
    defineWindowAccessor('opener', () => windowOpenerValue, (value) => { windowOpenerValue = value; });
    defineWindowAccessor('frameElement', () => null);
    defineWindowAccessor('length', () => 0, () => {});
    defineWindowAccessor('closed', () => false, null);
    defineWindowAccessor('name', () => windowNameValue, (value) => { windowNameValue = String(value); });
    defineWindowAccessor('isSecureContext', () => isPotentiallyTrustworthyLocation(doc.location), null);
    defineWindowAccessor('crossOriginIsolated', () => false, null);
    defineWindowAccessor('credentialless', () => false, null);
    defineWindowAccessor('originAgentCluster', () => false, null);
    defineWindowAccessor('event', () => windowEventValue, (value) => { windowEventValue = value; });
    Object.defineProperty(globalThis, 'offscreenBuffering', { get: namedWindowAccessor('get', 'offscreenBuffering', () => false), set: namedWindowAccessor('set', 'offscreenBuffering', () => {}), enumerable: false, configurable: true });
    globalThis.Event = VirtualEvent;
    globalThis.Text = Text;
    globalThis.Comment = Comment;
    globalThis.HTMLElement = HTMLElement;
    globalThis.SVGElement = SVGElement;
    globalThis.MathMLElement = MathMLElement;
    globalThis.HTMLDocument = HTMLDocument;
    globalThis.XMLDocument = XMLDocument;
    Object.defineProperty(globalThis, 'DOMException', { value: DOMException, writable: true, configurable: true });
    globalThis.EventTarget = VirtualEventTarget;
    globalThis.AbortController = AbortController;
    globalThis.AbortSignal = AbortSignal;
    Object.defineProperty(globalThis, 'CloseWatcher', { value: CloseWatcher, writable: true, configurable: true });
    globalThis.addEventListener = (...args) => currentWindowEventTarget().addEventListener(...args);
    globalThis.CDATASection = CDATASection;
    globalThis.ProcessingInstruction = ProcessingInstruction;
    globalThis.removeEventListener = (...args) => currentWindowEventTarget().removeEventListener(...args);
    globalThis.dispatchEvent = (event) => currentWindowEventTarget().dispatchEvent(event);
    for (const prop of handlerProps) {
      Object.defineProperty(globalThis, prop, {
        get: namedWindowAccessor('get', prop, () => currentWindowEventTarget()[prop]),
        set: namedWindowAccessor('set', prop, (value) => { currentWindowEventTarget()[prop] = typeof value === 'function' ? value : null; }),
        enumerable: true,
        configurable: true,
      });
    }
    globalThis.NamedNodeMap = NamedNodeMap;

    globalThis.AnimationTimeline = AnimationTimeline;
    globalThis.AnimationEffect = AnimationEffect;
    globalThis.KeyframeEffect = KeyframeEffect;
    globalThis.Animation = Animation;
    globalThis.CSSAnimation = CSSAnimation;
    globalThis.CSSTransition = CSSTransition;
    globalThis.DocumentTimeline = DocumentTimeline;
    globalThis.ScrollTimeline = ScrollTimeline;
    globalThis.ViewTimeline = ViewTimeline;
    globalThis.CharacterData = CharacterData;
    globalThis.Node = VirtualNode;
    globalThis.Element = VirtualElement;
    globalThis.Document = VirtualDocument;
    globalThis.NodeList = VirtualNodeList;
    globalThis.HTMLCollection = VirtualHTMLCollection;
    globalThis.DOMRectReadOnly = DOMRectReadOnly;
    globalThis.DOMRect = DOMRect;
    globalThis.DOMRectList = DOMRectList;
    globalThis.DOMPointReadOnly = DOMPointReadOnly;
    globalThis.DOMPoint = DOMPoint;
    globalThis.DOMQuad = DOMQuad;
    globalThis.DOMMatrixReadOnly = DOMMatrixReadOnly;
    globalThis.DOMMatrix = DOMMatrix;
    globalThis.WebKitCSSMatrix = DOMMatrix;
    globalThis.VisualViewport = VisualViewport;
    globalThis.Screen = Screen;
    globalThis.ScreenOrientation = ScreenOrientation;
    Object.defineProperty(globalThis, 'MediaQueryList', { value: MediaQueryList, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'MediaQueryListEvent', { value: MediaQueryListEvent, writable: true, configurable: true });
    globalThis.ResizeObserver = VirtualResizeObserver;
    globalThis.ResizeObserverEntry = ResizeObserverEntry;
    const matchMedia = (query) => new VirtualMediaQueryList(query);
    Object.defineProperty(matchMedia, 'name', { value: 'matchMedia', configurable: true });
    globalThis.matchMedia = matchMedia;
    globalThis.ResizeObserverSize = ResizeObserverSize;
    globalThis.IntersectionObserver = VirtualIntersectionObserver;
    globalThis.Performance = Performance;
    globalThis.IntersectionObserverEntry = IntersectionObserverEntry;
    globalThis.PerformanceEntry = PerformanceEntry;
    globalThis.PerformanceMark = PerformanceMark;
    globalThis.PerformanceMeasure = PerformanceMeasure;
    globalThis.PerformanceResourceTiming = PerformanceResourceTiming;
    globalThis.PerformanceNavigationTiming = PerformanceNavigationTiming;
    globalThis.PerformanceServerTiming = PerformanceServerTiming;
    globalThis.PerformancePaintTiming = PerformancePaintTiming;
    globalThis.VisibilityStateEntry = VisibilityStateEntry;
    globalThis.PerformanceNavigation = PerformanceNavigation;
    globalThis.PerformanceTiming = PerformanceTiming;
    globalThis.PerformanceTimingConfidence = PerformanceTimingConfidence;
    globalThis.PerformanceEventTiming = PerformanceEventTiming;
    globalThis.PerformanceLongTaskTiming = PerformanceLongTaskTiming;
    globalThis.PerformanceLongAnimationFrameTiming = PerformanceLongAnimationFrameTiming;
    globalThis.PerformanceScriptTiming = PerformanceScriptTiming;
    globalThis.PerformanceElementTiming = PerformanceElementTiming;
    globalThis.LargestContentfulPaint = LargestContentfulPaint;
    globalThis.LayoutShift = LayoutShift;
    globalThis.LayoutShiftAttribution = LayoutShiftAttribution;
    globalThis.TaskAttributionTiming = TaskAttributionTiming;
    globalThis.PerformanceObserver = PerformanceObserver;
    globalThis.PerformanceObserverEntryList = PerformanceObserverEntryList;
    Object.defineProperty(globalThis, 'EventCounts', { value: EventCounts, writable: true, configurable: true });
    globalThis.performance = currentPerformance();
    defineWindowAccessor('visualViewport', () => currentVisualViewport(), () => {});
    defineWindowAccessor('screen', () => viewport.screen, () => {});
    defineWindowAccessor('innerWidth', () => viewport.innerWidth, () => {});
    defineWindowAccessor('innerHeight', () => viewport.innerHeight, () => {});
    defineWindowAccessor('devicePixelRatio', () => viewport.devicePixelRatio, () => {});
    defineWindowAccessor('outerWidth', () => viewport.innerWidth, () => {});
    defineWindowAccessor('outerHeight', () => viewport.innerHeight, () => {});
    defineWindowAccessor('screenX', () => 0, () => {});
    defineWindowAccessor('screenY', () => 0, () => {});
    defineWindowAccessor('screenLeft', () => 0, () => {});
    defineWindowAccessor('screenTop', () => 0, () => {});
    defineWindowAccessor('scrollX', () => viewport.scrollX, () => {});
    defineWindowAccessor('scrollY', () => viewport.scrollY, () => {});
    defineWindowAccessor('pageXOffset', () => viewport.scrollX, () => {});
    defineWindowAccessor('pageYOffset', () => viewport.scrollY, () => {});
    const locationbar = makeBarProp(true);
    const menubar = makeBarProp(true);
    const personalbar = makeBarProp(true);
    const scrollbars = makeBarProp(true);
    const statusbar = makeBarProp(true);
    const toolbar = makeBarProp(true);
    const external = makeExternal();
    defineWindowAccessor('locationbar', () => locationbar, () => {});
    defineWindowAccessor('menubar', () => menubar, () => {});
    defineWindowAccessor('personalbar', () => personalbar, () => {});
    defineWindowAccessor('scrollbars', () => scrollbars, () => {});
    defineWindowAccessor('statusbar', () => statusbar, () => {});
    defineWindowAccessor('toolbar', () => toolbar, () => {});
    defineWindowAccessor('status', () => windowStatusValue, (value) => { windowStatusValue = String(value); });
    defineWindowAccessor('external', () => external, () => {});
    globalThis.scrollTo = scrollToVirtual;
    globalThis.scrollBy = scrollByVirtual;
    globalThis.scroll = makeWindowMethod('scroll', scrollToVirtual);
    globalThis.requestAnimationFrame = requestAnimationFrameVirtual;
    globalThis.cancelAnimationFrame = cancelAnimationFrameVirtual;
    Object.defineProperty(globalThis, 'webkitRequestAnimationFrame', { value: makeWindowMethod('webkitRequestAnimationFrame', requestAnimationFrameVirtual), enumerable: true, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'webkitCancelAnimationFrame', { value: makeWindowMethod('webkitCancelAnimationFrame', cancelAnimationFrameVirtual), enumerable: true, writable: true, configurable: true });
    globalThis.alert = makeNoopWindowMethod('alert');
    globalThis.blur = makeNoopWindowMethod('blur');
    globalThis.captureEvents = makeNoopWindowMethod('captureEvents');
    globalThis.close = makeNoopWindowMethod('close');
    globalThis.confirm = () => false;
    globalThis.find = () => false;
    globalThis.focus = makeNoopWindowMethod('focus');
    globalThis.moveBy = makeNoopWindowMethod('moveBy');
    globalThis.moveTo = makeNoopWindowMethod('moveTo');
    globalThis.open = () => null;
    globalThis.print = makeNoopWindowMethod('print');
    globalThis.prompt = () => null;
    globalThis.releaseEvents = makeNoopWindowMethod('releaseEvents');
    globalThis.reportError = makeNoopWindowMethod('reportError');
    globalThis.resizeBy = makeNoopWindowMethod('resizeBy');
    globalThis.resizeTo = makeNoopWindowMethod('resizeTo');
    globalThis.stop = makeNoopWindowMethod('stop');
    const postMessageMethod = (message, ...args) => postMessageVirtual(message, ...args);
    Object.defineProperty(postMessageMethod, 'name', { value: 'postMessage', configurable: true });
    globalThis.postMessage = postMessageMethod;
    globalThis.__zpDispatchNativeEvent = dispatchNativeEvent;
    globalThis.__zpUpdateViewport = updateViewport;
    globalThis.__zpFlushObservers = flushObservers;
  }

  function requestAnimationFrameVirtual(callback) {
    const id = rafId++;
    setTimeout(() => callback(viewport.now), 16);
    return id;
  }
  function cancelAnimationFrameVirtual(id) {
    clearTimeout(id);
  }

  function noopWindowMethod() {}

  function makeNoopWindowMethod(name) {
    return makeWindowMethod(name, noopWindowMethod);
  }

  function makeWindowMethod(name, handler) {
    const method = (...args) => handler(...args);
    Object.defineProperty(method, 'name', { value: name, configurable: true });
    return method;
  }

  function postMessageVirtual(message, targetOrigin = '/') {
    if (targetOrigin !== '*' && targetOrigin !== '/' && String(targetOrigin) !== String(globalThis.location?.origin || 'null')) {
      throw new DOMException("Failed to execute 'postMessage' on 'Window': target origin mismatch.", 'DataCloneError');
    }
    const MessageEventCtor = globalThis.MessageEvent;
    const event = typeof MessageEventCtor === 'function'
      ? new MessageEventCtor('message', { data: message, origin: String(globalThis.location?.origin || ''), source: globalThis, ports: [] })
      : new VirtualEvent('message');
    Promise.resolve().then(() => globalThis.dispatchEvent(event));
  }

  function dispatchNativeEvent(nodeId, type, init = {}) {
    const node = nodes.get(nodeId);
    if (!node) return false;
    return node.dispatchEvent(new VirtualEvent(type, { bubbles: true, cancelable: true, ...init }));
  }
  function updateViewport(next = {}) {
    const previous = viewport;
    viewport = makeViewport({ ...viewport, ...next });
    layoutRects = { ...layoutRects, ...(next.layout || {}) };
    syncViewportGlobals(previous);
    for (const query of [...mediaQueries]) refreshMediaQueryList(query);
    return flushObservers();
  }

  function syncViewportGlobals(previous = viewport) {
    globalThis.innerWidth = viewport.innerWidth;
    globalThis.innerHeight = viewport.innerHeight;
    globalThis.outerWidth = viewport.innerWidth;
    globalThis.outerHeight = viewport.innerHeight;
    globalThis.devicePixelRatio = viewport.devicePixelRatio;
    globalThis.screen = viewport.screen;
    globalThis.scrollX = viewport.scrollX;
    globalThis.scrollY = viewport.scrollY;
    globalThis.pageXOffset = viewport.scrollX;
    globalThis.pageYOffset = viewport.scrollY;
    const sizeChanged = previous.innerWidth !== viewport.innerWidth || previous.innerHeight !== viewport.innerHeight || previous.scale !== viewport.scale;
    const scrollChanged = previous.scrollX !== viewport.scrollX || previous.scrollY !== viewport.scrollY;
    if (sizeChanged && visualViewport) visualViewport.dispatchEvent(new VirtualEvent('resize'));
    if (scrollChanged) {
      globalThis.dispatchEvent(new VirtualEvent('scroll'));
      if (visualViewport) visualViewport.dispatchEvent(new VirtualEvent('scroll'));
    }
  }

  function scrollToVirtual(x = 0, y = 0) {
    const previous = viewport;
    viewport = makeViewport({ ...viewport, scrollX: scrollCoordinate(x), scrollY: scrollCoordinate(y) });
    syncViewportGlobals(previous);
  }

  function scrollByVirtual(x = 0, y = 0) {
    scrollToVirtual(viewport.scrollX + scrollCoordinate(x), viewport.scrollY + scrollCoordinate(y));
  }

  function scrollCoordinate(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : 0;
  }

  function innerTextForNode(node) {
    if (!node) return '';
    if (node.nodeType === 3 || node.nodeType === 4) return node.textContent || '';
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return '';
    if (innerTextHiddenElement(node)) return '';
    return (node.__zpChildren || []).map((child) => innerTextForNode(child)).join('');
  }

  function innerTextHiddenElement(node) {
    const localName = String(node.localName || '').toLowerCase();
    if (['head', 'script', 'style', 'title', 'noscript', 'template'].includes(localName)) return true;
    if (typeof node.hasAttribute === 'function' && node.hasAttribute('hidden')) return true;
    const style = typeof node.getAttribute === 'function' ? String(node.getAttribute('style') || '').toLowerCase() : '';
    return /display\\s*:\\s*none/.test(style);
  }

  function flushObservers() {
    for (const observer of [...resizeObservers]) deliverResizeObserver(observer);
    for (const observer of [...intersectionObservers]) deliverIntersectionObserver(observer);
    return true;
  }

  function coerceNode(value, ownerDocument) {
    if (value instanceof VirtualNode) return value;
    return new Text(String(value), ownerDocument || globalThis.document || null);
  }

  function appendNode(parent, child, shouldEmit) {
    return insertNode(parent, child, null, shouldEmit);
  }

  function insertNode(parent, child, before, shouldEmit) {
    if (child.parentNode) removeNode(child.parentNode, child, false);
    const children = parent.__zpChildren;

    const index = before ? children.indexOf(before) : -1;
    const insertionIndex = index >= 0 ? index : children.length;
    const previousSibling = children[insertionIndex - 1] || null;
    const nextSibling = index >= 0 ? before : null;
    if (index >= 0) children.splice(index, 0, child);
    else children.push(child);
    child.__zpParentNode = parent;
    if (shouldEmit) emit('dom.appendChild', serializeNode(child, parent));
    if (shouldEmit) notifyMutation({ type: 'childList', target: parent, addedNodes: [child], removedNodes: [], previousSibling, nextSibling });
    return child;
  }

  function removeNode(parent, child, shouldEmit) {
    const children = parent.__zpChildren;
    const index = children.indexOf(child);
    const previousSibling = index >= 0 ? children[index - 1] || null : null;
    const nextSibling = index >= 0 ? children[index + 1] || null : null;
    if (index >= 0) children.splice(index, 1);
    child.__zpParentNode = null;
    if (shouldEmit) emit('dom.removeChild', { nodeId: child.__zpNodeId, parentNodeId: parent.__zpNodeId });
    if (shouldEmit) notifyMutation({ type: 'childList', target: parent, addedNodes: [], removedNodes: [child], previousSibling, nextSibling });
    return child;
  }

  function setNodeText(node, text) {
    const oldChildren = node.__zpChildren.slice();
    node.__zpChildren = [new Text(text, node.ownerDocument)];
    node.__zpChildren[0].__zpParentNode = node;
    emit('dom.textContent', { nodeId: node.__zpNodeId, text });
    notifyMutation({ type: 'childList', target: node, addedNodes: node.__zpChildren.slice(), removedNodes: oldChildren });
  }

  function setAttr(element, namespaceURI, name, value, shouldEmit) {
    const ns = String(namespaceURI || '');
    const qualified = parseQualifiedName(name);
    const keyName = ns ? qualified.localName : String(name);
    const key = attrKey(ns, keyName);
    const old = element.__zpAttributes.get(key)?.value ?? null;
    const text = String(value ?? '');
    element.__zpAttributes.set(key, { namespaceURI: ns, name: String(name), localName: keyName, prefix: ns ? qualified.prefix : null, value: text });
    if (shouldEmit) emit('dom.attr', { nodeId: element.__zpNodeId, namespaceURI: ns, name: String(name), value: text });
    if (shouldEmit) notifyMutation({ type: 'attributes', target: element, attributeName: String(name), attributeNamespace: ns || null, oldValue: old, addedNodes: [], removedNodes: [] });
  }

  function attrValue(element, namespaceURI, name) {
    const attr = element.__zpAttributes.get(attrKey(namespaceURI, name));
    return attr ? attr.value : null;
  }

  function removeAttr(element, namespaceURI, name, shouldEmit) {
    const ns = String(namespaceURI || '');
    const key = attrKey(ns, ns ? parseQualifiedName(name).localName : name);
    element.__zpAttributes.delete(key);
    if (shouldEmit) emit('dom.removeAttr', { nodeId: element.__zpNodeId, namespaceURI: ns, name: String(name) });
  }

  function parseQualifiedName(name) {
    const text = String(name || '');
    const index = text.indexOf(':');
    return index > 0 ? { prefix: text.slice(0, index), localName: text.slice(index + 1) } : { prefix: null, localName: text };
  }

  function attrKey(namespaceURI, name) { return String(namespaceURI || '') + '|' + String(name); }

  function setNamedMapItem(element, attr, useNamespace) {
    const ns = useNamespace && attr.namespaceURI ? attr.namespaceURI : '';
    const old = element.__zpAttributes.get(attrKey(ns, useNamespace ? attr.localName || attr.name : attr.name)) || null;
    setAttr(element, ns, attr.name, attr.value, true);
    return old;
  }

  function removeNamedMapItem(element, namespaceURI, name) {
    const key = attrKey(namespaceURI, name);
    const attr = element.__zpAttributes.get(key);
    if (!attr) throw namedError('NotFoundError');
    removeAttr(element, namespaceURI, name, true);
    return attr;
  }

  function listenerBucket(target, type) {
    let byType = listeners.get(target);
    if (!byType) listeners.set(target, byType = new Map());
    let bucket = byType.get(String(type));
    if (!bucket) byType.set(String(type), bucket = []);
    return bucket;
  }

  function normalizeListenerOptions(options) {
    if (options === true || options === false) return { capture: Boolean(options), once: false, passive: false, signal: null };
    return { capture: Boolean(options?.capture), once: Boolean(options?.once), passive: Boolean(options?.passive), signal: options?.signal || null };
  }

  function invokePath(path, event, phase, capture) {
    for (const target of path) {
      setVirtualEventField(event, 'currentTarget', target);
      setVirtualEventField(event, 'eventPhase', phase);
      invokeTarget(target, event, capture);
      if (event.__zpStopped) return;
    }
  }

  function invokeTarget(target, event, capture) {
    const bucket = [...listenerBucket(target, event.type)];
    for (const entry of bucket) {
      if (entry.capture !== capture) continue;
      invokeListener(target, entry, event);
      if (event.__zpImmediateStopped) return;
    }
    if (!capture) invokeHandler(target, event);
  }

  function invokeListener(target, entry, event) {
    event.__zpPassive = entry.passive;
    if (typeof entry.callback === 'function') entry.callback.call(target, event);
    else entry.callback.handleEvent(event);
    event.__zpPassive = false;
    if (entry.once) target.removeEventListener(event.type, entry.callback, { capture: entry.capture });
  }

  function invokeHandler(target, event) {
    const handler = target['on' + event.type];
    if (typeof handler === 'function' && handler.call(target, event) === false) event.preventDefault();
  }

  function eventPath(target) {
    const path = [];
    for (let node = target; node; node = node.parentNode) path.push(node);
    return path;
  }

  function siblingOf(node, offset) {
    const list = node.parentNode?.__zpChildren || [];
    const index = list.indexOf(node);
    return index >= 0 ? list[index + offset] || null : null;
  }

  function descendants(root) {
    const out = [];
    for (const child of root.__zpChildren || []) collect(child, out);
    return out;
  }

  function collect(node, out) {
    if (node.nodeType === 1) out.push(node);
    for (const child of node.__zpChildren || []) collect(child, out);
  }

  function hasClass(node, name) {
    return node.nodeType === 1 && node.className.split(/\s+/).includes(String(name));
  }

  function tagsUnder(root, tag) {
    const wanted = String(tag || '');
    const htmlWanted = wanted.toLowerCase();
    return liveCollection(() => descendants(root).filter((node) => wanted === '*' || (node.namespaceURI === HTML_NS ? node.localName === htmlWanted : node.localName === wanted)), 'HTMLCollection');
  }

  function documentElementCollection(root, predicate) {
    return liveCollection(() => descendants(root).filter((node) => node.nodeType === 1 && predicate(node)), 'HTMLCollection');
  }

  function matchesSelector(node, selector) {
    const text = String(selector || '').trim();
    if (!text || node.nodeType !== 1) return false;
    return splitSelectorList(text).some((group) => matchesSelectorGroup(node, group));
  }

  function matchesSelectorGroup(node, selector) {
    const parts = splitDescendantSelectors(selector);
    if (parts.length === 0) return false;
    let current = node;
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      if (index === parts.length - 1) {
        if (!matchesSimpleSelector(current, parts[index])) return false;
        current = current.parentNode;
        continue;
      }
      current = closestAncestorMatching(current, parts[index]);
      if (!current) return false;
      current = current.parentNode;
    }
    return true;
  }

  function closestAncestorMatching(node, selector) {
    for (let current = node; current; current = current.parentNode) {
      if (current.nodeType === 1 && matchesSimpleSelector(current, selector)) return current;
    }
    return null;
  }

  function matchesSimpleSelector(node, selector) {
    const parsed = parseSimpleSelector(selector);
    if (!parsed || node.nodeType !== 1) return false;
    if (parsed.tag !== '*' && node.localName !== parsed.tag) return false;
    if (parsed.id !== null && node.id !== parsed.id) return false;
    for (const className of parsed.classes) if (!hasClass(node, className)) return false;
    for (const attrSelector of parsed.attrs) if (!matchesAttributeSelector(node, attrSelector)) return false;
    for (const negated of parsed.not) if (matchesSimpleSelector(node, negated)) return false;
    return true;
  }

  function splitSelectorList(selector) {
    return splitSelectorTopLevel(selector, ',').map((part) => part.trim()).filter(Boolean);
  }

  function splitDescendantSelectors(selector) {
    return splitSelectorTopLevel(selector, ' ').map((part) => part.trim()).filter(Boolean);
  }

  function splitSelectorTopLevel(selector, delimiter) {
    const out = [];
    let start = 0;
    let bracketDepth = 0;
    let parenDepth = 0;
    let quote = '';
    for (let index = 0; index < selector.length; index += 1) {
      const char = selector[index];
      if (quote) {
        if (char === quote && selector[index - 1] !== '\\') quote = '';
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === '[') bracketDepth += 1;
      else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (char === '(') parenDepth += 1;
      else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (bracketDepth === 0 && parenDepth === 0 && topLevelDelimiter(selector, index, delimiter)) {
        out.push(selector.slice(start, index));
        start = delimiter === ' ' ? skipSelectorWhitespace(selector, index) : index + 1;
        if (delimiter === ' ') index = start - 1;
      }
    }
    out.push(selector.slice(start));
    return out;
  }

  function topLevelDelimiter(selector, index, delimiter) {
    if (delimiter === ' ') return /\s/.test(selector[index]);
    return selector[index] === delimiter;
  }

  function skipSelectorWhitespace(selector, index) {
    let next = index;
    while (next < selector.length && /\s/.test(selector[next])) next += 1;
    return next;
  }

  function parseSimpleSelector(selector) {
    const text = String(selector || '').trim();
    if (!text) return null;
    const parsed = { tag: '*', id: null, classes: [], attrs: [], not: [] };
    let index = 0;
    if (text[index] === '*') index += 1;
    else if (isSelectorNameStart(text[index])) {
      const end = readSelectorName(text, index);
      parsed.tag = text.slice(index, end).toLowerCase();
      index = end;
    }
    while (index < text.length) {
      const char = text[index];
      if (char === '#') {
        const end = readSelectorName(text, index + 1);
        if (end === index + 1) return null;
        parsed.id = text.slice(index + 1, end);
        index = end;
      } else if (char === '.') {
        const end = readSelectorName(text, index + 1);
        if (end === index + 1) return null;
        parsed.classes.push(text.slice(index + 1, end));
        index = end;
      } else if (char === '[') {
        const end = findSelectorBlockEnd(text, index, '[', ']');
        if (end < 0) return null;
        const attrSelector = parseAttributeSelector('*' + text.slice(index, end + 1));
        if (!attrSelector) return null;
        parsed.attrs.push(attrSelector);
        index = end + 1;
      } else if (text.startsWith(':not(', index)) {
        const end = findSelectorBlockEnd(text, index + 4, '(', ')');
        if (end < 0) return null;
        parsed.not.push(text.slice(index + 5, end).trim());
        index = end + 1;
      } else {
        return null;
      }
    }
    return parsed;
  }

  function isSelectorNameStart(char) {
    return Boolean(char && /[A-Za-z_]/.test(char));
  }

  function readSelectorName(text, start) {
    let index = start;
    while (index < text.length && /[\w-]/.test(text[index])) index += 1;
    return index;
  }

  function findSelectorBlockEnd(text, start, open, close) {
    let depth = 0;
    let quote = '';
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (char === quote && text[index - 1] !== '\\') quote = '';
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  }

  function parseAttributeSelector(selector) {
    const match = String(selector || '').match(/^([A-Za-z][\w:-]*|\*)?\[([A-Za-z_][\w:.-]*)(?:\s*([*^$|~]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/);
    if (!match) return null;
    return {
      tag: match[1] || '*',
      name: match[2],
      op: match[3] || '',
      value: (match[4] ?? match[5] ?? match[6] ?? '').trim(),
    };
  }

  function matchesAttributeSelector(node, selector) {
    const tag = selector.tag === '*' ? '*' : selector.tag.toLowerCase();
    if (tag !== '*' && node.localName !== tag) return false;
    const actual = node.getAttribute(selector.name);
    if (actual === null) return false;
    if (!selector.op) return true;
    if (selector.op === '=') return actual === selector.value;
    if (selector.op === '*=') return actual.includes(selector.value);
    if (selector.op === '^=') return actual.startsWith(selector.value);
    if (selector.op === '$=') return actual.endsWith(selector.value);
    if (selector.op === '~=') return actual.split(/\s+/).includes(selector.value);
    if (selector.op === '|=') return actual === selector.value || actual.startsWith(selector.value + '-');
    return false;
  }

  function liveCollection(query, kind = 'NodeList') {
    const collection = {};
    Object.defineProperty(collection, collectionQuery, { value: query, configurable: true });
    Object.setPrototypeOf(collection, kind === 'HTMLCollection' ? VirtualHTMLCollection.prototype : VirtualNodeList.prototype);
    return new Proxy(collection, {
      get(target, prop, receiver) {
        if (isCollectionIndex(prop)) return collectionItem(target, prop);
        const value = Reflect.get(target, prop, receiver);
        if (value !== undefined || kind !== 'HTMLCollection' || typeof prop !== 'string') return value;
        return collectionNamedItem.call(target, prop) || undefined;
      },
      has(target, prop) {
        return (isCollectionIndex(prop) && collectionItem(target, prop) !== null) || (kind === 'HTMLCollection' && typeof prop === 'string' && collectionNamedItem.call(target, prop) !== null) || Reflect.has(target, prop);
      },
      ownKeys(target) {
        const keys = Reflect.ownKeys(target).filter((key) => key !== collectionQuery);
        const items = collectionItems(target);
        for (let i = 0; i < items.length; i += 1) keys.push(String(i));
        if (kind === 'HTMLCollection') keys.push(...collectionNamedKeys(items));
        return [...new Set(keys)];
      },
      getOwnPropertyDescriptor(target, prop) {
        if (isCollectionIndex(prop)) {
          const value = collectionItem(target, prop);
          return value ? { value, enumerable: true, configurable: true } : undefined;
        }
        if (kind === 'HTMLCollection' && typeof prop === 'string') {
          const value = collectionNamedItem.call(target, prop);
          if (value) return { value, enumerable: false, configurable: true };
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      }
    });
  }

  function collectionItems(collection) {
    const query = collection?.[collectionQuery];
    return typeof query === 'function' ? query() : [];
  }

  function collectionItem(collection, index) {
    const numeric = Number(index);
    return Number.isInteger(numeric) && numeric >= 0 ? collectionItems(collection)[numeric] || null : null;
  }

  function collectionLength() {
    return collectionItems(this).length;
  }

  function* collectionValues() {
    yield* collectionItems(this);
  }

  function* collectionKeys() {
    const items = collectionItems(this);
    for (let i = 0; i < items.length; i += 1) yield i;
  }

  function* collectionEntries() {
    const items = collectionItems(this);
    for (let i = 0; i < items.length; i += 1) yield [i, items[i]];
  }

  function collectionForEach(callback, ...rest) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const items = collectionItems(this);
    const thisArg = rest[0];
    for (let i = 0; i < items.length; i += 1) callback.call(thisArg, items[i], i, this);
  }

  function collectionNamedItem(name) {
    const key = String(name);
    return collectionItems(this).find((node) => node.id === key || node.getAttribute?.('name') === key) || null;
  }

  Object.defineProperties(collectionLength, { name: { value: 'get length', configurable: true } });
  Object.defineProperties(collectionValues, { name: { value: 'values', configurable: true } });
  Object.defineProperties(collectionKeys, { name: { value: 'keys', configurable: true } });
  Object.defineProperties(collectionEntries, { name: { value: 'entries', configurable: true } });
  Object.defineProperties(collectionForEach, { name: { value: 'forEach', configurable: true } });
  Object.defineProperties(collectionNamedItem, { name: { value: 'namedItem', configurable: true } });


  function collectionNamedKeys(items) {
    const keys = [];
    for (const node of items) {
      if (node.id) keys.push(node.id);
      const name = node.getAttribute?.('name');
      if (name) keys.push(name);
    }
    return keys;
  }
  function isCollectionIndex(prop) {
    return typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop);
  }

  function notifyMutation(record) {
    try { if (typeof __zpNotifyMutation === 'function') __zpNotifyMutation(record); } catch {}
  }

  function serializeNode(node, parent) {
    const record = { nodeId: node.__zpNodeId, parentNodeId: parent.__zpNodeId, nodeType: node.nodeType };
    if (node.nodeType === 1) {
      record.tag = node.localName;
      record.namespaceURI = node.namespaceURI;
    }
    if (node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 7 || node.nodeType === 8) record.text = node.textContent;
    return record;
  }

  function rectFor(nodeId) {
    const rect = layoutRects[nodeId] || {};
    return new DOMRect(rect.x, rect.y, rect.width, rect.height);
  }

  function rectNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function makeViewport(input) {
    const width = Number(input.innerWidth || input.width || 1024);
    const height = Number(input.innerHeight || input.height || 768);
    const ratio = Number(input.devicePixelRatio || 1);
    const now = Number(input.now || 0);
    const scale = Number(input.scale || 1);
    const scrollX = scrollCoordinate(input.scrollX ?? input.pageXOffset ?? 0);
    const scrollY = scrollCoordinate(input.scrollY ?? input.pageYOffset ?? 0);
    return { innerWidth: width, innerHeight: height, devicePixelRatio: ratio, now, scale, scrollX, scrollY, screen: createScreen(width, height) };
  }

  function evaluateMedia(query) {
    const text = String(query || '').toLowerCase();
    const min = /min-width\s*:\s*(\d+)px/.exec(text);
    const max = /max-width\s*:\s*(\d+)px/.exec(text);
    if (min && viewport.innerWidth < Number(min[1])) return false;
    if (max && viewport.innerWidth > Number(max[1])) return false;
    return true;
  }

  function isPotentiallyTrustworthyLocation(location) {
    const protocol = String(location?.protocol || '').toLowerCase();
    const hostname = String(location?.hostname || '').toLowerCase();
    return protocol === 'https:' || protocol === 'wss:' || protocol === 'file:' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  }

  function makeLocation(href) {
    let current = String(href || 'about:blank');
    let parts = parseLocation(current);
    const loc = {
      assign(url) { navigate(url, false); },
      replace(url) { navigate(url, true); },
      reload() { navigate(current, true); },
      toString() { return current; },
      __zpSetHref(url) { setHref(url); },
    };
    function navigate(url, replace) {
      const next = resolveLocationURL(url, current);
      if (sameDocumentLocation(current, next)) {
        setHref(next);
        return;
      }
      if (typeof __zpNavigate === 'function') __zpNavigate(next, Boolean(replace));
      else setHref(next);
    }
    function setHref(url) {
      current = resolveLocationURL(url, current);
      parts = parseLocation(current);
    }
    for (const key of ['origin', 'protocol', 'host', 'hostname', 'pathname', 'search', 'hash']) {
      const descriptor = { get: () => parts[key], enumerable: true, configurable: true };
      if (key !== 'origin') descriptor.set = (value) => navigate(updateLocationPart(current, key, value), false);
      Object.defineProperty(loc, key, descriptor);
    }
    Object.defineProperty(loc, 'href', { get: () => current, set: (url) => navigate(url, false), enumerable: true, configurable: true });
    Object.defineProperty(loc, Symbol.toStringTag, { value: 'Location', configurable: true });
    return loc;
  }

  function resolveLocationURL(url, baseHref) {
    const text = String(url || '');
    const base = parseLocation(baseHref);
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return text;
    if (text.startsWith('//')) return (base.protocol || 'https:') + text;
    if (text.startsWith('#')) return String(baseHref || '').replace(/#.*$/, '') + text;
    if (text.startsWith('?')) return String(baseHref || '').replace(/[?#].*$/, '') + text;
    if (text.startsWith('/')) return base.origin === 'null' ? text : base.origin + text;
    const prefix = String(baseHref || '').replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/');
    return prefix + text;
  }

  function sameDocumentLocation(before, after) {
    return String(before || '').replace(/#.*$/, '') === String(after || '').replace(/#.*$/, '');
  }

  function updateLocationPart(current, key, value) {
    const part = parseLocation(current);
    if (key === 'hash') part.hash = prefixedLocationPart(value, '#');
    else if (key === 'search') part.search = prefixedLocationPart(value, '?');
    else if (key === 'pathname') part.pathname = prefixedPathname(value);
    else if (key === 'protocol') part.protocol = String(value || '').replace(/:*$/, ':');
    else if (key === 'host') part.host = String(value || '');
    else if (key === 'hostname') part.host = replaceHostname(part.host, value);
    return locationHrefFromParts(part);
  }

  function prefixedLocationPart(value, prefix) {
    const text = String(value || '');
    return text ? (text.startsWith(prefix) ? text : prefix + text) : '';
  }

  function prefixedPathname(value) {
    const text = String(value || '');
    return text.startsWith('/') ? text : '/' + text;
  }

  function replaceHostname(host, hostname) {
    const port = /:\\d+$/.exec(String(host || ''))?.[0] || '';
    return String(hostname || '') + port;
  }

  function locationHrefFromParts(part) {
    if (!part.protocol || !part.host) return (part.pathname || '') + (part.search || '') + (part.hash || '');
    return part.protocol + '//' + part.host + (part.pathname || '/') + (part.search || '') + (part.hash || '');
  }

  function parseLocation(text) {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(String(text || 'about:blank'));
    const protocol = match?.[1] || '';
    const host = match?.[2] || '';
    return {
      origin: protocol && host ? protocol + '//' + host : 'null',
      protocol,
      host,
      hostname: host.split(':')[0] || '',
      pathname: match?.[3] || '',
      search: match?.[4] || '',
      hash: match?.[5] || '',
    };
  }

  function makeNodeId() { nextNodeId += 1; return 'v' + nextNodeId; }
  function emit(type, fields) { __zpDomMutation(JSON.stringify({ v: 1, type, seq: 0, ...fields })); }
  function dispatchNodeEvent(nodeId, type) {
    const node = nodes.get(String(nodeId || ''));
    if (node) node.dispatchEvent(new VirtualEvent(String(type || '')));
  }

  function syncNativeControl(nodeId, init = {}) {
    const node = nodes.get(String(nodeId || ''));
    if (!node || !init.__zpNativeControl) return;
    if (Object.prototype.hasOwnProperty.call(init, 'value')) node.__zpValue = String(init.value ?? '');
    if (Object.prototype.hasOwnProperty.call(init, 'checked')) node.__zpChecked = Boolean(init.checked);
  }
  globalThis.__zpLoadDocument = __zpLoadDocument;
  globalThis.__zpApplyDocumentRecords = __zpApplyDocumentRecords;
  globalThis.__zpDispatchNodeEvent = dispatchNodeEvent;
  globalThis.__zpSyncNativeControl = syncNativeControl;
})();
`;

export class NativeRenderer {
  constructor(root, options = {}) {
    if (!root) throw new TypeError('renderer root is required');
    this.root = root;
    this.nodes = new Map();
    this.resourceBindings = new Map();
    this.pendingChildren = new Map();
    this.pendingAttributes = new Map();
    this.pendingText = new Map();
    this.navigationTargets = new Map();
    this.lastSubmitter = null;
    this.styleElements = new Map();
    this.styleRecords = new Map();
    this.resourceBlobURLs = new Map();
    this.records = [];
    this.href = options.href || '';
    this.onNavigate = typeof options.onNavigate === 'function' ? options.onNavigate : null;
    this.dispatch = options.dispatch || null;
    this.bindNativeEvents();
  }

  render(records = []) {
    this.root.textContent = '';
    this.removeStyleElements();
    this.nodes.clear();
    this.resourceBindings.clear();
    this.pendingChildren.clear();
    this.pendingAttributes.clear();
    this.pendingText.clear();
    this.navigationTargets.clear();
    this.lastSubmitter = null;
    this.styleRecords.clear();
    this.resourceBlobURLs.clear();
    for (const record of records) this.applyRecord(record);
  }

  applyMutation(record) {
    this.records.push(record);
    this.applyRecord(record);
  }

  applyRecord(record) {
    switch (record.type) {
      case 'node.create':
        this.createElement(record);
        break;
      case 'node.text':
        this.createText(record);
        break;
      case 'node.attr':
      case 'dom.attr':
        this.setAttribute(record);
        break;
      case 'dom.appendChild':
        this.appendCreated(record);
        break;
      case 'dom.textContent':
      case 'dom.text':
        this.setText(record);
        break;
      case 'dom.removeChild':
        this.removeNode(record);
        break;
      case 'resource.discovered':
        this.trackResource(record);
        break;
      case 'resource.blob.ready':
        this.applyBlobResource(record);
        break;
      case 'style.inline':
        this.applyInlineStyle(record);
        break;
      case 'dom.removeAttr':
        this.removeAttribute(record);
        break;
      default:
        break;
    }
  }

  createElement(record) {
    const node = document.createElement(record.tag || 'div');
    node.dataset.zpNodeId = record.nodeId;
    this.nodes.set(record.nodeId, { node, tag: record.tag, parentNodeId: record.parentNodeId });
    this.flushPendingState(record.nodeId);
    this.appendToParent(record.nodeId, record.parentNodeId);
    this.flushPendingChildren(record.nodeId);
  }

  createText(record) {
    const node = document.createTextNode(record.text || '');
    const nodeId = `text-${record.seq}`;
    this.nodes.set(nodeId, { node, tag: '#text', parentNodeId: record.parentNodeId });
    this.appendToParent(nodeId, record.parentNodeId);
  }

  appendCreated(record) {
    if (!this.nodes.has(record.nodeId)) this.createDynamicNode(record);
    this.appendToParent(record.nodeId, record.parentNodeId);
  }

  createDynamicNode(record) {
    if (record.nodeType === 3 || record.nodeType === 4 || record.nodeType === 7) this.nodes.set(record.nodeId, { node: document.createTextNode(record.text || ''), tag: '#text' });
    else if (record.nodeType === 8) this.nodes.set(record.nodeId, { node: document.createComment(record.text || ''), tag: '#comment' });
    else {
      const node = document.createElement(record.tag || 'div');
      node.dataset.zpNodeId = record.nodeId;
      this.nodes.set(record.nodeId, { node, tag: record.tag || 'div', parentNodeId: record.parentNodeId });
    }
    this.flushPendingState(record.nodeId);
    this.flushPendingChildren(record.nodeId);
  }

  appendToParent(nodeId, parentNodeId) {
    const entry = this.nodes.get(nodeId);
    const parent = this.nativeParent(parentNodeId);
    if (!entry) return;
    if (!parent && parentNodeId) {
      const pending = this.pendingChildren.get(parentNodeId) || [];
      pending.push(nodeId);
      this.pendingChildren.set(parentNodeId, pending);
      return;
    }
    if (parent && this.shouldRender(entry)) parent.appendChild(entry.node);
  }

  flushPendingChildren(parentNodeId) {
    const pending = this.pendingChildren.get(parentNodeId);
    if (!pending) return;
    this.pendingChildren.delete(parentNodeId);
    for (const nodeId of pending) this.appendToParent(nodeId, parentNodeId);
  }

  queuePendingAttribute(record) {
    const pending = this.pendingAttributes.get(record.nodeId) || [];
    pending.push(record);
    this.pendingAttributes.set(record.nodeId, pending);
  }

  flushPendingState(nodeId) {
    const attrs = this.pendingAttributes.get(nodeId);
    if (attrs) {
      this.pendingAttributes.delete(nodeId);
      for (const attr of attrs) this.setAttribute(attr);
    }
    if (this.pendingText.has(nodeId)) {
      const text = this.pendingText.get(nodeId);
      this.pendingText.delete(nodeId);
      this.setText({ nodeId, text });
    }
    this.applyAvailableBlobBindings(nodeId);
  }

  applyAvailableBlobBindings(nodeId) {
    const entry = this.nodes.get(nodeId);
    if (!entry?.node?.setAttribute || !this.shouldRender(entry)) return;
    for (const [resourceId, binding] of this.resourceBindings) {
      if (binding.nodeId !== nodeId || !rendererBlobAttributeCanReplace(binding.name)) continue;
      const blobUrl = this.resourceBlobURLs.get(resourceId);
      if (blobUrl) entry.node.setAttribute(binding.name, blobUrl);
    }
  }

  nativeParent(parentNodeId) {
    if (!parentNodeId) return this.root;
    const parent = this.nodes.get(parentNodeId);
    if (!parent) return null;
    if (parent.tag === 'body') return this.root;
    if (parent.tag === 'head' || parent.tag === 'html') return null;
    return parent.node;
  }

  shouldRender(entry) {
    return !['html', 'head', 'body', 'script', 'link', 'title', 'style', 'noscript'].includes(entry.tag);
  }

  trackResource(record) {
    if (!record.resourceId || !record.initiatorNodeId || !record.attribute) return;
    this.resourceBindings.set(record.resourceId, { nodeId: record.initiatorNodeId, name: record.attribute });
    if (record.renderPolicy === 'virtual-navigation') {
      this.navigationTargets.set(navigationKey(record.initiatorNodeId, record.attribute), record.resolvedTargetUrl || record.rawValue || '');
      this.applyVirtualNavigationPlaceholder(record);
    }
  }

  applyVirtualNavigationPlaceholder(record) {
    const entry = this.nodes.get(record.initiatorNodeId);
    if (!entry?.node?.setAttribute || !this.shouldRender(entry)) return;
    entry.node.setAttribute(record.attribute, rendererURLAttributeFallback(record.attribute));
  }

  applyBlobResource(record) {
    if (record.resourceId && record.blobUrl) this.resourceBlobURLs.set(record.resourceId, record.blobUrl);
    const binding = this.resourceBindings.get(record.resourceId);
    const entry = binding && this.nodes.get(binding.nodeId);
    if (entry?.node?.setAttribute && this.shouldRender(entry) && record.blobUrl && rendererBlobAttributeCanReplace(binding.name)) entry.node.setAttribute(binding.name, record.blobUrl);
    if (this.styleReferencesResource(record.resourceId)) this.refreshInlineStyles();
  }

  setAttribute(record) {
    const entry = this.nodes.get(record.nodeId);
    if (!entry) {
      this.queuePendingAttribute(record);
      return;
    }
    if (entry.node?.setAttribute && this.shouldRender(entry)) entry.node.setAttribute(record.name, safeRendererAttributeValue(record.name, record.value));
  }

  removeAttribute(record) {
    const entry = this.nodes.get(record.nodeId);
    if (!entry) {
      const pending = this.pendingAttributes.get(record.nodeId);
      if (pending) this.pendingAttributes.set(record.nodeId, pending.filter((attr) => attr.name !== record.name));
      return;
    }
    if (entry.node?.removeAttribute) entry.node.removeAttribute(record.name);
  }

  applyInlineStyle(record) {
    const styleId = record.resourceId || record.nodeId || `style-${record.seq}`;
    this.styleRecords.set(styleId, String(record.css || ''));
    let node = this.styleElements.get(styleId);
    if (!node) {
      node = document.createElement('style');
      node.dataset.zpStyleId = styleId;
      this.styleElements.set(styleId, node);
      document.head.appendChild(node);
    }
    node.textContent = safeRendererCSS(this.styleRecords.get(styleId), this.resourceBlobURLs);
  }

  refreshInlineStyles() {
    for (const [styleId, css] of this.styleRecords) {
      const node = this.styleElements.get(styleId);
      if (node) node.textContent = safeRendererCSS(css, this.resourceBlobURLs);
    }
  }

  styleReferencesResource(resourceId) {
    const marker = `zp-internal://resource/${resourceId}`;
    for (const css of this.styleRecords.values()) {
      if (css.includes(marker)) return true;
    }
    return false;
  }

  removeStyleElements() {
    for (const node of this.styleElements.values()) node.remove();
    this.styleElements.clear();
    this.styleRecords.clear();
  }

  setText(record) {
    const entry = this.nodes.get(record.nodeId);
    if (!entry) {
      this.pendingText.set(record.nodeId, record.text || '');
      return;
    }
    if (entry.node) entry.node.textContent = record.text || '';
  }

  removeNode(record) {
    const entry = this.nodes.get(record.nodeId);
    entry?.node?.parentNode?.removeChild(entry.node);
  }

  bindNativeEvents() {
    for (const type of ['click', 'input', 'change', 'submit', 'keydown', 'keyup']) {
      this.root.addEventListener(type, (event) => this.dispatchNativeEvent(event, type));
    }
  }

  dispatchNativeEvent(event, type) {
    if (type === 'click') this.rememberSubmitter(event);
    const target = event.target?.closest?.('[data-zp-node-id]');
    if (target && this.dispatch) {
      const allowed = this.dispatch(target.dataset.zpNodeId, type, {
        bubbles: true,
        cancelable: true,
        key: event.key || '',
        ...this.nativeControlInit(target),
      });
      if (allowed === false) {
        event.preventDefault();
        return;
      }
    }
    this.handleDefaultNavigation(event, type);
  }


  nativeControlInit(target) {
    if (!target?.matches?.('input,textarea,select')) return {};
    return { __zpNativeControl: true, value: target.value || '', checked: Boolean(target.checked) };
  }
  handleDefaultNavigation(event, type) {
    if (type === 'click') this.handleClickNavigation(event);
    else if (type === 'submit') this.handleSubmitNavigation(event);
  }

  handleClickNavigation(event) {
    const anchor = event.target?.closest?.('a,area');
    const href = this.navigationTarget(anchor, 'href');
    if (!href) return;
    event.preventDefault();
    this.navigate(href);
  }

  handleSubmitNavigation(event) {
    const form = event.target?.closest?.('form');
    const submitter = event.submitter || this.lastSubmitter;
    const href = form && this.formNavigationTarget(form, submitter);
    this.lastSubmitter = null;
    if (!href) return;
    event.preventDefault();
    this.navigate(href);
  }

  formNavigationTarget(form, submitter) {
    const action = this.navigationTarget(submitter, 'formaction') || this.navigationTarget(form, 'action') || this.href;
    if (formMethod(form, submitter) !== 'get') return action;
    return appendFormQuery(action, form, submitter, this.href);
  }

  navigationTarget(node, attribute) {
    const nodeId = node?.dataset?.zpNodeId;
    return nodeId ? this.navigationTargets.get(navigationKey(nodeId, attribute)) || '' : '';
  }


  rememberSubmitter(event) {
    const control = event.target?.closest?.('button,input');
    this.lastSubmitter = isSubmitControl(control) ? control : null;
  }
  navigate(href) {
    if (this.onNavigate) void this.onNavigate(href);
  }
}

function navigationKey(nodeId, attribute) {
  return `${nodeId}:${String(attribute || '').toLowerCase()}`;
}

function formMethod(form, submitter) {
  return String(submitter?.getAttribute?.('formmethod') || form?.getAttribute?.('method') || 'get').toLowerCase();
}

function isSubmitControl(control) {
  if (!control?.matches?.('button,input')) return false;
  const type = String(control.getAttribute?.('type') || (control.localName === 'button' ? 'submit' : '')).toLowerCase();
  return type === 'submit' || type === 'image';
}

function appendFormQuery(action, form, submitter, baseHref) {
  const params = new URLSearchParams(formDataForSubmit(form, submitter));
  const url = new URL(action || baseHref || 'about:blank', baseHref || undefined);
  url.search = params.toString();
  return url.href;
}

function formDataForSubmit(form, submitter) {
  try {
    if (submitter) return new FormData(form, submitter);
  } catch {}
  return new FormData(form);
}

export function ensureRenderRoot(doc = document) {
  let root = doc.getElementById('zp-render-root');
  if (!root) {
    root = doc.createElement('main');
    root.id = 'zp-render-root';
    doc.body.appendChild(root);
  }
  return root;
}

export function installVirtualDOM(options = {}) {
  const { realm, records, renderer, state, href, viewport, onMutation, onNavigate } = options;
  if (!realm) throw new TypeError('QuickJS realm is required');
  realm.defineHostFunction('__zpDomMutation', (json) => {
    const record = JSON.parse(String(json || '{}'));
    if (state?.records) state.records.push(record);
    renderer?.applyMutation(record);
    if (typeof onMutation === 'function') onMutation(record);
    return null;
  });
  realm.defineHostFunction('__zpNavigate', (targetHref, replace) => {
    if (typeof onNavigate === 'function') onNavigate(String(targetHref || ''), Boolean(replace));
    return null;
  });
  realm.evalClassic(VIRTUAL_DOM_SOURCE, 'zeroproxy-dom.js');
  realm.evalClassic(`__zpLoadDocument([], ${JSON.stringify({ href, viewport })});`, 'zeroproxy-dom-load.js');
  for (const chunk of chunkRecordsForQuickJS(initialVirtualDOMRecords(records || []))) {
    realm.evalClassic(`__zpApplyDocumentRecords(${JSON.stringify(chunk)});`, 'zeroproxy-dom-load-chunk.js');
  }
  renderer?.render(initialNativeRenderRecords(records || []));
  if (renderer) renderer.dispatch = (nodeId, type, init) => dispatchVirtualEvent(realm, nodeId, type, init);
  return { renderer };
}

const QUICKJS_RECORD_CHUNK_BYTES = 128 * 1024;
const QUICKJS_INITIAL_RECORD_TYPES = new Set(['node.create', 'node.attr', 'node.text', 'event.inlineHandler']);
const NATIVE_RENDER_INITIAL_RECORD_TYPES = new Set(['node.create', 'node.attr', 'node.text', 'resource.discovered', 'resource.blob.ready', 'style.inline']);

function initialVirtualDOMRecords(records) {
  const out = [];
  for (const record of records || []) {
    if (QUICKJS_INITIAL_RECORD_TYPES.has(record?.type)) out.push(record);
    const attr = virtualResourceAttributeRecord(record);
    if (attr) out.push(attr);
  }
  return out;
}

function virtualResourceAttributeRecord(record) {
  if (record?.type !== 'resource.discovered' || !record.initiatorNodeId || !record.attribute) return null;
  const value = record.rawValue || record.resolvedTargetUrl || record.safeUrl || '';
  if (!value) return null;
  return {
    v: record.v || 1,
    type: 'node.attr',
    docId: record.docId,
    seq: record.seq,
    nodeId: record.initiatorNodeId,
    name: record.attribute,
    value,
  };
}

function initialNativeRenderRecords(records) {
  return records.filter((record) => NATIVE_RENDER_INITIAL_RECORD_TYPES.has(record?.type));
}

function chunkRecordsForQuickJS(records) {
  const chunks = [];
  let chunk = [];
  let size = 2;
  for (const record of records) {
    const recordSize = JSON.stringify(record).length + 1;
    if (chunk.length && size + recordSize > QUICKJS_RECORD_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = [];
      size = 2;
    }
    chunk.push(record);
    size += recordSize;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

const INTERNAL_RESOURCE_URL_GLOBAL_RE = /zp-internal:\/\/resource\/[A-Za-z0-9._:-]+/g;

function safeRendererAttributeValue(name, value) {
  const text = String(value || '');
  if (text.includes('zp-internal://resource/')) {
    if (attrNameIsSrcset(name)) return '';
    if (isInternalResourceURL(text)) return transparentPixelDataURL();
    return text.replace(INTERNAL_RESOURCE_URL_GLOBAL_RE, transparentPixelDataURL());
  }
  if (attrNameIsSrcset(name)) return rendererSafeSrcset(text) ? value : '';
  if (rendererURLAttributeName(name) && !rendererSafeURL(text)) return rendererURLAttributeFallback(name);
  return value;
}

function isInternalResourceURL(value) {
  const text = String(value || '');
  return text.startsWith('zp-internal://resource/') && !text.includes(' ') && !text.includes(',');
}

function safeRendererCSS(css, resourceBlobURLs) {
  const resolved = String(css || '').replace(INTERNAL_RESOURCE_URL_GLOBAL_RE, (url) => resourceBlobURLs?.get(resourceIdFromInternalURL(url)) || url);
  return stripUnresolvedFontFaces(resolved).replace(INTERNAL_RESOURCE_URL_GLOBAL_RE, transparentPixelDataURL());
}

function stripUnresolvedFontFaces(css) {
  return String(css || '').replace(/@font-face\s*{[^}]*zp-internal:\/\/resource\/[^}]*}/gi, '');
}

function resourceIdFromInternalURL(url) {
  return String(url || '').slice('zp-internal://resource/'.length);
}

function rendererURLAttributeName(name) {
  return ['action', 'data', 'formaction', 'href', 'poster', 'src', 'srcset'].includes(String(name || '').toLowerCase());
}

function rendererSafeURL(value) {
  const text = String(value || '').trim();
  return !text || text.startsWith('#') || text.startsWith('/zp/') || text.startsWith('blob:') || text.startsWith('data:') || text.startsWith('about:');
}


function rendererSafeSrcset(value) {
  return String(value || '').split(',').every((candidate) => {
    const url = candidate.trim().split(/\s+/, 1)[0] || '';
    return rendererSafeURL(url);
  });
}
function rendererURLAttributeFallback(name) {
  const attr = String(name || '').toLowerCase();
  if (attr === 'srcset') return '';
  if (attr === 'src' || attr === 'poster') return transparentPixelDataURL();
  return 'about:blank';
}


function rendererBlobAttributeCanReplace(name) {
  return ['href', 'poster', 'src'].includes(String(name || '').toLowerCase());
}
function attrNameIsSrcset(name) {
  return String(name || '').toLowerCase() === 'srcset';
}

function transparentPixelDataURL() {
  return 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
}
export function dispatchVirtualEvent(realm, nodeId, type, init = {}) {
  return realm.evalClassic(`__zpSyncNativeControl(${JSON.stringify(nodeId)}, ${JSON.stringify(init)}); __zpDispatchNativeEvent(${JSON.stringify(nodeId)}, ${JSON.stringify(type)}, ${JSON.stringify(init)});`, 'zeroproxy-dom-event.js');
}

export function syncVirtualViewport(realm, viewport) {
  return realm.evalClassic(`__zpUpdateViewport(${JSON.stringify(viewport || {})});`, 'zeroproxy-dom-viewport.js');
}
