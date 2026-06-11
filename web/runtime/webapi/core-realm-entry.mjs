import { Blob, File, FileList, makeFileList } from './realm/webidl/file/blob.mjs';
import { createDOMParsing } from './realm/webidl/dom/parsing.mjs';
import { createMutationObserverController } from './realm/webidl/dom/mutation-observer.mjs';
import { createXPathFacades } from './realm/webidl/dom/xpath.mjs';
import { Attr, installElementAttrNodeReflections } from './realm/webidl/dom/attr.mjs';
import { createDOMImplementationSupport } from './realm/webidl/dom/implementation.mjs';
import { createHTMLWebIDL } from './realm/webidl/html/elements.mjs';
import { createSVGWebIDL } from './realm/webidl/dom/svg-elements.mjs';
import { createSVGValueFacades } from './realm/webidl/dom/svg-values.mjs';
import { createLongTailEventConstructors } from './realm/events/long-tail-events.mjs';
import { createStreamFacades } from './realm/webidl/streams/basic-streams.mjs';
import { ByteLengthQueuingStrategy, CountQueuingStrategy } from './realm/webidl/streams/queuing-strategy.mjs';
import { CompressionStream, DecompressionStream } from './realm/webidl/streams/compression-stream.mjs';
import { createTextEncodingFacades } from './realm/webidl/encoding/text-encoding.mjs';
import { createHighlightSupport } from './realm/webidl/css/highlight.mjs';
import { createLegacyBrowserFacades } from './realm/webidl/misc/legacy-facades.mjs';
import { createEmergingGlobalFacades, installEmergingGlobalSingletons } from './realm/webidl/misc/emerging-globals.mjs';
import { createIntlFacade } from './realm/webidl/misc/intl.mjs';
import { createRTCBasicFacades } from './realm/webidl/rtc/basic.mjs';
import { createWorkerPolicyFacades } from './realm/webidl/workers/policy.mjs';
import { createWebSocketStreamFacades } from './realm/webidl/network/websocket-stream.mjs';
import { createBackgroundServiceFacades } from './realm/webidl/service-worker/background-sync.mjs';
import { createMediaStreamFacades } from './realm/webidl/media/streams.mjs';
import { createCSSOMRuleFacades } from './realm/webidl/css/rules.mjs';
import { createCSSTypedOMFacades } from './realm/webidl/css/typed-om.mjs';
import { createCanvasFacades } from './realm/webidl/canvas/basic.mjs';
import { createWebGLFacades } from './realm/webidl/canvas/webgl.mjs';
import { createWebCodecsFacades } from './realm/webidl/media/webcodecs.mjs';
import { createMediaSourceFacades } from './realm/webidl/media/source.mjs';
import { createTextTrackFacades } from './realm/webidl/media/text-tracks.mjs';
import { createSpeechFacades } from './realm/webidl/media/speech.mjs';
import { createAudioFacades } from './realm/webidl/media/audio.mjs';
import { createNavigationFacades } from './realm/webidl/navigation/basic.mjs';

  const storageMaps = { localStorage: new Map(), sessionStorage: new Map() };
  const idbDatabases = new Map();
  const cacheMaps = new Map();
  const DEFAULT_STORAGE_QUOTA_BYTES = 50 * 1024 * 1024;
  const storageToken = {};
  const permissionStatusToken = {};
  const permissionsToken = {};
  const wakeLockSentinelToken = {};
  const storageManagerToken = {};
  const idbCursorToken = {};
  const idbKeyRangeToken = {};
  const idbRequestToken = {};
  const idbInternalToken = {};
  const customElementRegistryToken = {};
  const elementInternalsToken = {};
  const customStateSetToken = {};
  const treeWalkerToken = {};
  const navigatorSlots = new WeakMap();
  const navigatorPrototypeInstallSet = new WeakSet();
  const historyPrototypeInstallSet = new WeakSet();
  let virtualNavigatorPrototype = null;
  const nodeIteratorToken = {};
  let storageQuotaBytes = DEFAULT_STORAGE_QUOTA_BYTES;
  const blobURLRegistry = new Map();
  const classListCache = new WeakMap();
  const relListCache = new WeakMap();
  const datasetCache = new WeakMap();
  const remotePlaybackCache = new WeakMap();
  const templateContentCache = new WeakMap();
  const slotAssignmentCache = new WeakMap();
  const elementStyleSheetCache = new WeakMap();
  const staticRangeSlots = new WeakMap();
  const treeWalkerSlots = new WeakMap();
  const storageManagerSlots = new WeakMap();
  const keyboardSlots = new WeakMap();
  const keyboardLayoutMapSlots = new WeakMap();
  const wakeLockSlots = new WeakMap();
  const credentialSlots = new WeakMap();
  const credentialsContainerSlots = new WeakMap();
  const mediaCapabilitiesSlots = new WeakMap();
  const inputDeviceCapabilitiesSlots = new WeakMap();
  const gamepadSlots = new WeakMap();
  const gamepadButtonSlots = new WeakMap();
  const wakeLockSentinelSlots = new WeakMap();
  const notificationSlots = new WeakMap();
  const nodeIteratorSlots = new WeakMap();
  let nextBlobURLID = 1;
  let createTextEventInstanceImpl = null;
  const historyStack = [{ state: null, url: String(globalThis.location?.href || 'about:blank') }];
  const NodeFilter = () => {
    throw new TypeError('Illegal constructor');
  };
  Object.defineProperties(NodeFilter, {
    FILTER_ACCEPT: { value: 1, enumerable: true },
    FILTER_REJECT: { value: 2, enumerable: true },
    FILTER_SKIP: { value: 3, enumerable: true },
    SHOW_ALL: { value: 0xffffffff, enumerable: true },
    SHOW_ELEMENT: { value: 1, enumerable: true },
    SHOW_ATTRIBUTE: { value: 2, enumerable: true },
    SHOW_TEXT: { value: 4, enumerable: true },
    SHOW_CDATA_SECTION: { value: 8, enumerable: true },
    SHOW_ENTITY_REFERENCE: { value: 16, enumerable: true },
    SHOW_ENTITY: { value: 32, enumerable: true },
    SHOW_PROCESSING_INSTRUCTION: { value: 64, enumerable: true },
    SHOW_COMMENT: { value: 128, enumerable: true },
    SHOW_DOCUMENT: { value: 256, enumerable: true },
    SHOW_DOCUMENT_TYPE: { value: 512, enumerable: true },
    SHOW_DOCUMENT_FRAGMENT: { value: 1024, enumerable: true },
    SHOW_NOTATION: { value: 2048, enumerable: true },
  });
  const colorKeywords = Object.freeze({
    red: 'rgb(255, 0, 0)',
    blue: 'rgb(0, 0, 255)',
    green: 'rgb(0, 128, 0)',
    black: 'rgb(0, 0, 0)',
    white: 'rgb(255, 255, 255)',
    transparent: 'rgba(0, 0, 0, 0)',
  });
  const supportedCSSProperties = new Set(['background-color', 'background-image', 'color', 'display', 'float', 'height', 'margin-left', 'width']);
  let historyIndex = 0;
  let historyScrollRestoration = 'auto';
  const { svgElementConstructors, elementToStringTag: svgElementToStringTag, interfaceNameForTag: svgInterfaceNameForTag } = createSVGWebIDL();
  const svgValueFacades = createSVGValueFacades();
  const { htmlElementConstructors, HTMLFormControlsCollection, HTMLOptionsCollection, RadioNodeList, elementToStringTag, isElement } = createHTMLWebIDL({ svgElementToStringTag });
  installHTMLFormControlsCollectionPrototype();
  installHTMLOptionsCollectionPrototype();
  installRadioNodeListPrototype();
  const { DOMParser, XMLSerializer, serializeNode, serializeChildren, createHTMLDocument, replaceChildrenFromHTML, replaceOuterHTML, appendHTML, fragmentFromHTML } = createDOMParsing({ childArray });
  const { MutationObserver, MutationRecord, notifyMutation } = createMutationObserverController();
  const { DOMImplementation, DocumentType, installDocumentImplementation } = createDOMImplementationSupport(createHTMLDocument);
  const { XPathEvaluator, XPathExpression, XPathResult } = createXPathFacades();
  const { Plugin, MimeType, DOMError, OverconstrainedError, QuotaExceededError, createPlugin, createMimeType } = createLegacyBrowserFacades(globalThis.DOMException);
  const { RTCIceCandidate, RTCSessionDescription, RTCError, RTCPeerConnection, RTCDataChannel, RTCDtlsTransport, RTCIceTransport, RTCSctpTransport, RTCDTMFSender, RTCRtpReceiver, RTCRtpSender, RTCRtpTransceiver, RTCStatsReport, RTCCertificate, RTCEncodedAudioFrame, RTCEncodedVideoFrame, RTCRtpScriptTransform } = createRTCBasicFacades(globalThis.DOMException);
  const workerPolicyFacades = createWorkerPolicyFacades(globalThis.DOMException);
  const webSocketStreamFacades = createWebSocketStreamFacades(globalThis.DOMException);
  const emergingGlobalFacades = createEmergingGlobalFacades(globalThis.Event || class Event {}, globalThis.EventTarget, globalThis.DOMException);
  const backgroundServiceFacades = createBackgroundServiceFacades();
  const streamFacades = createStreamFacades();
  const { MediaStream, MediaStreamTrack, CanvasCaptureMediaStreamTrack, BrowserCaptureMediaStreamTrack, AudioSinkInfo, MediaStreamTrackAudioStats, MediaStreamTrackVideoStats, MediaRecorder } = createMediaStreamFacades(globalThis.EventTarget);
  const { CanvasGradient, CanvasPattern, CanvasRenderingContext2D, createImageBitmap, ImageBitmap, ImageBitmapRenderingContext, ImageData, OffscreenCanvas, OffscreenCanvasRenderingContext2D, Path2D, TextMetrics, installCanvasElementReflections } = createCanvasFacades();
  const webGLFacades = createWebGLFacades(globalThis.Event || class Event {});
  const { AudioData, EncodedAudioChunk, EncodedVideoChunk, VideoColorSpace, VideoFrame } = createWebCodecsFacades();
  const { MediaSource, MediaSourceHandle, SourceBuffer, SourceBufferList, TimeRanges } = createMediaSourceFacades(globalThis.EventTarget);
  const { TextTrack, TextTrackCue, TextTrackCueList, TextTrackList, VTTCue } = createTextTrackFacades(globalThis.EventTarget, globalThis.DocumentFragment || class DocumentFragment {});
  const speechFacades = createSpeechFacades(globalThis.Event || class Event {}, globalThis.EventTarget);
  const audioFacades = createAudioFacades(globalThis.EventTarget);
  const textEncodingFacades = createTextEncodingFacades({
    construct: (globalName, args) => hostBridgeConstruct(globalName, args),
    method: (handle, globalName, method, args) => hostBridgeCall({ op: 'method', globalName, method, handle, args }),
  });
  const navigationFacades = createNavigationFacades({
    EventBase: globalThis.Event,
    EventTargetBase: globalThis.EventTarget,
    cloneState: (value) => cloneValue(value, new Map()),
    getRecords: () => historyStack,
    getIndex: () => historyIndex,
    pushState: (state, url) => globalThis.history.pushState(state, '', url),
    replaceState: (state, url) => globalThis.history.replaceState(state, '', url),
    traverse: (delta) => globalThis.history.go(delta),
    currentURL: () => String(globalThis.location?.href || historyStack[historyIndex]?.url || 'about:blank'),
    resolveURL: (url) => validateHistoryURL('navigate', url),
  });
  const { Navigation, NavigationActivation, NavigationCurrentEntryChangeEvent, NavigationDestination, NavigationHistoryEntry, NavigationPrecommitController, NavigationTransition, NavigateEvent, makeNavigation } = navigationFacades;
  const IntlFacade = createIntlFacade();

  class Storage {
    constructor(token, area, map) {
      if (token !== storageToken) throw new TypeError("Failed to construct 'Storage': Illegal constructor");
      this.__zpArea = area;
      this.__zpMap = map;
    }
    get length() { return this.__zpMap.size; }
    key(index) { return [...this.__zpMap.keys()][Number(index)] || null; }
    getItem(key) { const text = String(key); return this.__zpMap.has(text) ? this.__zpMap.get(text) : null; }
    setItem(key, value) {
      const text = String(key);
      const hadValue = this.__zpMap.has(text);
      const oldValue = this.getItem(text);
      const stored = String(value);
      this.__zpMap.set(text, stored);
      enforceVirtualStorageQuota(() => {
        if (hadValue) this.__zpMap.set(text, oldValue);
        else this.__zpMap.delete(text);
      });
      persistStorageSet(this.__zpArea, text, stored);
      dispatchStorageEvent(this.__zpArea, text, oldValue, stored);
    }
    removeItem(key) { const text = String(key); const oldValue = this.getItem(text); this.__zpMap.delete(text); persistStorageRemove(this.__zpArea, text); dispatchStorageEvent(this.__zpArea, text, oldValue, null); }
    clear() { this.__zpMap.clear(); persistStorageClear(this.__zpArea); dispatchStorageEvent(this.__zpArea, null, null, null); }
  }
  Object.defineProperty(Storage.prototype, Symbol.toStringTag, { value: 'Storage', configurable: true });

  function defineStateBackedEventPayload(Ctor, stateMap, keys, options = {}) {
    const constructorDescriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, 'constructor');
    const methodDescriptors = (options.methods || []).map((name) => [name, Object.getOwnPropertyDescriptor(Ctor.prototype, name)]);
    delete Ctor.prototype.constructor;
    for (const [name] of methodDescriptors) delete Ctor.prototype[name];
    for (const key of keys) {
      const descriptor = { get() {
        const state = stateMap.get(this);
        if (!state) throw new TypeError('Illegal invocation');
        return state[key];
      }, enumerable: true, configurable: true };
      if (options.writable) descriptor.set = function setEventPayloadValue(value) {
        const state = stateMap.get(this);
        if (!state) throw new TypeError('Illegal invocation');
        state[key] = String(value);
      };
      Object.defineProperty(Ctor.prototype, key, descriptor);
    }
    for (const [name, descriptor] of methodDescriptors) {
      if (descriptor) Object.defineProperty(Ctor.prototype, name, { ...descriptor, enumerable: true, configurable: true, writable: true });
    }
    Object.defineProperty(Ctor.prototype, 'constructor', constructorDescriptor);
  }

  function nullableEventString(value) {
    return value === null || value === undefined ? null : String(value);
  }

  function eventString(value, fallback = '') {
    return value === undefined ? fallback : String(value);
  }

  function eventFiniteNumber(value, fallback = 0, label = 'value') {
    if (value === undefined) return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError(`Failed to read the '${label}' property from event init: The provided double value is non-finite.`);
    return number;
  }

  function eventFiniteNumberOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function eventUnsignedShort(value) {
    return Math.trunc(eventFiniteNumberOrZero(value)) & 0xffff;
  }

  function requiredEventInit(name, init, actual) {
    if (actual < 2) throw new TypeError(`Failed to construct '${name}': 2 arguments required, but only ${actual} present.`);
    if (init === null || typeof init !== 'object') return {};
    return init;
  }

  const storageEventState = new WeakMap();
  class StorageEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      storageEventState.set(this, storageEventPayload(init));
    }
    initStorageEvent(type, bubbles = false, cancelable = false, key = null, oldValue = null, newValue = null, url = '', storageArea = null) {
      this.initEvent(type, bubbles, cancelable);
      storageEventState.set(this, {
        key: nullableEventString(key),
        oldValue: nullableEventString(oldValue),
        newValue: nullableEventString(newValue),
        url: String(url || ''),
        storageArea,
      });
    }
  }
  defineStateBackedEventPayload(StorageEvent, storageEventState, ['key', 'oldValue', 'newValue', 'url', 'storageArea'], { methods: ['initStorageEvent'] });
  function storageEventPayload(init = {}) {
    return {
      key: nullableEventString(init.key),
      oldValue: nullableEventString(init.oldValue),
      newValue: nullableEventString(init.newValue),
      url: eventString(init.url, ''),
      storageArea: init.storageArea || null,
    };
  }
  Object.defineProperty(StorageEvent.prototype, Symbol.toStringTag, { value: 'StorageEvent', configurable: true });

  const formDataSlots = new WeakMap();
  function FormData(...args) {
    if (!new.target) throw new TypeError("Failed to construct 'FormData': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    const data = createFormDataInstance();
    if (args.length > 0 && args[0] !== undefined) {
      if (!isElement(args[0], 'form')) throw new TypeError("Failed to construct 'FormData': parameter 1 is not of type 'HTMLFormElement'.");
      const submitter = args.length > 1 && args[1] !== undefined ? validatedFormDataSubmitter(args[0], args[1]) : null;
      appendFormEntries(data, args[0], submitter);
      dispatchFormDataEvent(args[0], data);
    }
    return data;
  }
  Object.defineProperty(FormData, 'name', { value: 'FormData', configurable: true });
  const formDataConstructorDescriptor = Object.getOwnPropertyDescriptor(FormData.prototype, 'constructor');
  delete FormData.prototype.constructor;
  const formDataDelete = {
    delete(name) {
      requireFormDataArguments('delete', 1, arguments.length);
      deleteFormDataEntries(this, String(name));
    },
  }.delete;
  Object.defineProperties(FormData.prototype, {
    append: { value: function append(name, value) {
      requireFormDataArguments('append', 2, arguments.length);
      formDataEntries(this).push([String(name), formDataValue(value, arguments[2], arguments.length >= 3, 'append')]);
    }, enumerable: true, writable: true, configurable: true },
    delete: { value: formDataDelete, enumerable: true, writable: true, configurable: true },
    get: { value: function get(name) {
      requireFormDataArguments('get', 1, arguments.length);
      const key = String(name);
      const found = formDataEntries(this).find(([entry]) => entry === key);
      return found ? found[1] : null;
    }, enumerable: true, writable: true, configurable: true },
    getAll: { value: function getAll(name) {
      requireFormDataArguments('getAll', 1, arguments.length);
      const key = String(name);
      return formDataEntries(this).filter(([entry]) => entry === key).map(([, value]) => value);
    }, enumerable: true, writable: true, configurable: true },
    has: { value: function has(name) {
      requireFormDataArguments('has', 1, arguments.length);
      const key = String(name);
      return formDataEntries(this).some(([entry]) => entry === key);
    }, enumerable: true, writable: true, configurable: true },
    set: { value: function set(name, value) {
      requireFormDataArguments('set', 2, arguments.length);
      const key = String(name);
      deleteFormDataEntries(this, key);
      formDataEntries(this).push([key, formDataValue(value, arguments[2], arguments.length >= 3, 'set')]);
    }, enumerable: true, writable: true, configurable: true },
    entries: { value: function* entries() { for (const [name, value] of formDataEntries(this)) yield [name, value]; }, enumerable: true, writable: true, configurable: true },
    forEach: { value: function forEach(callback) {
      if (typeof callback !== 'function') throw new TypeError("Failed to execute 'forEach' on 'FormData': parameter 1 is not of type 'Function'.");
      for (const [name, value] of formDataEntries(this)) callback.call(arguments[1], value, name, this);
    }, enumerable: true, writable: true, configurable: true },
    keys: { value: function* keys() { for (const [name] of formDataEntries(this)) yield name; }, enumerable: true, writable: true, configurable: true },
    values: { value: function* values() { for (const [, value] of formDataEntries(this)) yield value; }, enumerable: true, writable: true, configurable: true },
    constructor: { ...formDataConstructorDescriptor, value: FormData },
  });
  Object.defineProperty(FormData.prototype, Symbol.iterator, { value: FormData.prototype.entries, writable: true, configurable: true });
  Object.defineProperty(FormData.prototype, Symbol.toStringTag, { value: 'FormData', configurable: true });

  const validityStateSlots = new WeakMap();
  const validityStateKeys = [
    'valueMissing',
    'typeMismatch',
    'patternMismatch',
    'tooLong',
    'tooShort',
    'rangeUnderflow',
    'rangeOverflow',
    'stepMismatch',
    'badInput',
    'customError',
    'valid',
  ];
  function ValidityState() { throw new TypeError("Failed to construct 'ValidityState': Illegal constructor"); }
  for (const key of validityStateKeys) {
    Object.defineProperty(ValidityState.prototype, key, {
      get() {
        const state = validityStateSlots.get(this);
        if (!state) throw new TypeError('Illegal invocation');
        return state[key];
      },
      enumerable: true,
      configurable: true,
    });
  }
  Object.defineProperty(ValidityState.prototype, Symbol.toStringTag, { value: 'ValidityState', configurable: true });

  const dataTransferItemSlots = new WeakMap();
  const dataTransferItemListSlots = new WeakMap();
  const dataTransferSlots = new WeakMap();
  const dataTransferItemListToken = {};

  function DataTransferItem() { throw new TypeError("Failed to construct 'DataTransferItem': Illegal constructor"); }
  delete DataTransferItem.prototype.constructor;
  Object.defineProperties(DataTransferItem.prototype, {
    kind: { get() { return dataTransferItemValue(this).kind; }, enumerable: true, configurable: true },
    type: { get() { return dataTransferItemValue(this).type; }, enumerable: true, configurable: true },
    getAsFile: { value: function getAsFile() { const item = dataTransferItemValue(this); return item.kind === 'file' ? item.value : null; }, enumerable: true, writable: true, configurable: true },
    getAsString: {
      value: function getAsString(callback) {
        const item = dataTransferItemValue(this);
        if (typeof callback === 'function') setTimeout(() => callback(item.kind === 'string' ? item.value : null), 0);
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    webkitGetAsEntry: { value: function webkitGetAsEntry() { dataTransferItemValue(this); return null; }, enumerable: true, writable: true, configurable: true },
    getAsFileSystemHandle: { value: function getAsFileSystemHandle() { dataTransferItemValue(this); return Promise.resolve(undefined); }, enumerable: true, writable: true, configurable: true },
    constructor: { value: DataTransferItem, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(DataTransferItem.prototype, Symbol.toStringTag, { value: 'DataTransferItem', configurable: true });

  class DataTransferItemList {
    constructor(token, items = []) {
      if (token !== dataTransferItemListToken) throw new TypeError("Failed to construct 'DataTransferItemList': Illegal constructor");
      dataTransferItemListSlots.set(this, { items, indexedLength: 0 });
      syncTransferItemIndexes(this);
    }
    get length() { return dataTransferItemListValue(this).items.length; }
    add(data, type = '') {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'add' on 'DataTransferItemList': 1 argument required, but only 0 present.");
      const state = dataTransferItemListValue(this);
      if (data instanceof File) {
        const item = makeTransferItem('file', data.type, data);
        state.items.push(item);
        syncTransferItemIndexes(this);
        return item;
      }
      if (arguments.length < 2) throw new TypeError("Failed to execute 'add' on 'DataTransferItemList': parameter 1 is not of type 'File'.");
      const itemType = String(type);
      if (state.items.some((item) => item.kind === 'string' && dataTransferItemValue(item).type === itemType)) {
        throw namedError('NotSupportedError', `Failed to execute 'add' on 'DataTransferItemList': An item already exists for type '${itemType}'.`);
      }
      const item = makeTransferItem('string', itemType, String(data));
      state.items.push(item);
      syncTransferItemIndexes(this);
      return item;
    }
    clear() {
      dataTransferItemListValue(this).items.length = 0;
      syncTransferItemIndexes(this);
    }
    remove(index) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'remove' on 'DataTransferItemList': 1 argument required, but only 0 present.");
      const offset = Number(index);
      const items = dataTransferItemListValue(this).items;
      if (offset >= 0 && offset < items.length) items.splice(offset, 1);
      syncTransferItemIndexes(this);
    }
  }
  Object.defineProperty(DataTransferItemList, 'length', { value: 0, configurable: true });
  delete DataTransferItemList.prototype.constructor;
  Object.defineProperties(DataTransferItemList.prototype, {
    length: { ...Object.getOwnPropertyDescriptor(DataTransferItemList.prototype, 'length'), enumerable: true },
    add: { ...Object.getOwnPropertyDescriptor(DataTransferItemList.prototype, 'add'), enumerable: true },
    clear: { ...Object.getOwnPropertyDescriptor(DataTransferItemList.prototype, 'clear'), enumerable: true },
    remove: { ...Object.getOwnPropertyDescriptor(DataTransferItemList.prototype, 'remove'), enumerable: true },
    constructor: { value: DataTransferItemList, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(DataTransferItemList.prototype, Symbol.iterator, { value: function values() { return dataTransferItemListValue(this).items[Symbol.iterator](); }, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(DataTransferItemList.prototype, Symbol.toStringTag, { value: 'DataTransferItemList', configurable: true });

  function dataTransferItemValue(item) {
    const state = dataTransferItemSlots.get(item);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function dataTransferItemListValue(list) {
    const state = dataTransferItemListSlots.get(list);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function syncTransferItemIndexes(list) {
    const state = dataTransferItemListValue(list);
    for (let i = 0; i < state.indexedLength; i += 1) delete list[i];
    for (let i = 0; i < state.items.length; i += 1) Object.defineProperty(list, i, { value: state.items[i], enumerable: true, configurable: true });
    state.indexedLength = state.items.length;
  }

  class DataTransfer {
    constructor() {
      const items = [];
      dataTransferSlots.set(this, {
        dropEffect: 'none',
        effectAllowed: 'none',
        items,
        itemList: new DataTransferItemList(dataTransferItemListToken, items),
      });
    }
    get dropEffect() { return dataTransferValue(this).dropEffect; }
    set dropEffect(_value) { dataTransferValue(this); }
    get effectAllowed() { return dataTransferValue(this).effectAllowed; }
    set effectAllowed(_value) { dataTransferValue(this); }
    get items() { return dataTransferValue(this).itemList; }
    get files() { return makeFileList(transferFiles(dataTransferValue(this).items)); }
    get types() { return Object.freeze(transferTypes(dataTransferValue(this).items)); }
    clearData() {
      const state = dataTransferValue(this);
      const key = arguments.length === 0 ? '' : normalizeDataTransferFormat(arguments[0]);
      replaceTransferItems(state, key ? state.items.filter((item) => item.kind !== 'string' || dataTransferItemValue(item).type !== key) : state.items.filter((item) => item.kind !== 'string'));
    }
    getData(format) {
      requireDataTransferArguments('getData', 'DataTransfer', 1, arguments.length);
      const key = normalizeDataTransferFormat(format);
      const found = dataTransferValue(this).items.find((item) => item.kind === 'string' && dataTransferItemValue(item).type === key);
      return found ? dataTransferItemValue(found).value : '';
    }
    setData(format, data) {
      requireDataTransferArguments('setData', 'DataTransfer', 2, arguments.length);
      const state = dataTransferValue(this);
      const key = normalizeDataTransferFormat(format);
      replaceTransferItems(state, state.items.filter((item) => item.kind !== 'string' || dataTransferItemValue(item).type !== key));
      state.items.push(makeTransferItem('string', key, String(data)));
      syncTransferItemIndexes(state.itemList);
    }
    setDragImage(element, _x, _y) {
      requireDataTransferArguments('setDragImage', 'DataTransfer', 3, arguments.length);
      dataTransferValue(this);
      if (!element || element.nodeType !== 1) throw new TypeError("Failed to execute 'setDragImage' on 'DataTransfer': parameter 1 is not of type 'Element'.");
    }
  }
  const dataTransferFilesDescriptor = Object.getOwnPropertyDescriptor(DataTransfer.prototype, 'files');
  const dataTransferTypesDescriptor = Object.getOwnPropertyDescriptor(DataTransfer.prototype, 'types');
  const dataTransferClearDataDescriptor = Object.getOwnPropertyDescriptor(DataTransfer.prototype, 'clearData');
  const dataTransferGetDataDescriptor = Object.getOwnPropertyDescriptor(DataTransfer.prototype, 'getData');
  const dataTransferSetDataDescriptor = Object.getOwnPropertyDescriptor(DataTransfer.prototype, 'setData');
  const dataTransferSetDragImageDescriptor = Object.getOwnPropertyDescriptor(DataTransfer.prototype, 'setDragImage');
  delete DataTransfer.prototype.constructor;
  delete DataTransfer.prototype.files;
  delete DataTransfer.prototype.types;
  delete DataTransfer.prototype.clearData;
  delete DataTransfer.prototype.getData;
  delete DataTransfer.prototype.setData;
  delete DataTransfer.prototype.setDragImage;
  Object.defineProperties(DataTransfer.prototype, {
    dropEffect: { ...Object.getOwnPropertyDescriptor(DataTransfer.prototype, 'dropEffect'), enumerable: true },
    effectAllowed: { ...Object.getOwnPropertyDescriptor(DataTransfer.prototype, 'effectAllowed'), enumerable: true },
    items: { ...Object.getOwnPropertyDescriptor(DataTransfer.prototype, 'items'), enumerable: true },
    types: { ...dataTransferTypesDescriptor, enumerable: true },
    files: { ...dataTransferFilesDescriptor, enumerable: true },
    clearData: { ...dataTransferClearDataDescriptor, enumerable: true },
    getData: { ...dataTransferGetDataDescriptor, enumerable: true },
    setData: { ...dataTransferSetDataDescriptor, enumerable: true },
    setDragImage: { ...dataTransferSetDragImageDescriptor, enumerable: true },
    constructor: { value: DataTransfer, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(DataTransfer.prototype, Symbol.toStringTag, { value: 'DataTransfer', configurable: true });

  function dataTransferValue(dataTransfer) {
    const state = dataTransferSlots.get(dataTransfer);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function requireDataTransferArguments(methodName, ownerName, required, actual) {
    if (actual < required) {
      const noun = required === 1 ? 'argument' : 'arguments';
      throw new TypeError(`Failed to execute '${methodName}' on '${ownerName}': ${required} ${noun} required, but only ${actual} present.`);
    }
  }

  function normalizeDataTransferFormat(format) {
    const key = String(format || '').toLowerCase();
    if (key === 'text') return 'text/plain';
    if (key === 'url') return 'text/uri-list';
    return key;
  }
  function replaceTransferItems(state, nextItems) {
    state.items.length = 0;
    state.items.push(...nextItems);
    syncTransferItemIndexes(state.itemList);
  }

  function makeTransferItem(kind, type, value) {
    const item = Object.create(DataTransferItem.prototype);
    dataTransferItemSlots.set(item, { kind, type: String(type ?? ''), value });
    return item;
  }

  function transferFiles(items) {
    return items.filter((item) => item.kind === 'file').map((item) => dataTransferItemValue(item).value);
  }

  function transferTypes(items) {
    const types = [];
    let hasFiles = false;
    for (const item of items) {
      if (item.kind === 'file') {
        hasFiles = true;
        continue;
      }
      const value = dataTransferItemValue(item).type;
      if (!types.includes(value)) types.push(value);
    }
    if (hasFiles && !types.includes('Files')) types.push('Files');
    return types;
  }

  const progressEventState = new WeakMap();
  class ProgressEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      progressEventState.set(this, {
        lengthComputable: Boolean(init.lengthComputable),
        loaded: progressValue(init.loaded, 'loaded'),
        total: progressValue(init.total, 'total'),
      });
    }
  }
  defineStateBackedEventPayload(ProgressEvent, progressEventState, ['lengthComputable', 'loaded', 'total']);
  Object.defineProperty(ProgressEvent.prototype, Symbol.toStringTag, { value: 'ProgressEvent', configurable: true });

  const fileReaderState = new WeakMap();
  function FileReader() {
    if (!new.target) throw new TypeError("Failed to construct 'FileReader': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    fileReaderState.set(this, {
      error: null,
      result: null,
      readyState: 0,
      total: 0,
      handlers: Object.create(null),
    });
  }
  Object.setPrototypeOf(FileReader.prototype, EventTarget.prototype);
  delete FileReader.prototype.constructor;
  Object.defineProperty(FileReader, 'name', { value: 'FileReader', configurable: true });
  for (const [name, value] of [['EMPTY', 0], ['LOADING', 1], ['DONE', 2]]) {
    Object.defineProperty(FileReader, name, { value, enumerable: true });
  }
  Object.defineProperties(FileReader.prototype, {
    readyState: { get() { return fileReaderRecord(this).readyState; }, enumerable: true, configurable: true },
    result: { get() { return fileReaderRecord(this).result; }, enumerable: true, configurable: true },
    error: { get() { return fileReaderRecord(this).error; }, enumerable: true, configurable: true },
    onloadstart: fileReaderHandler('onloadstart'),
    onprogress: fileReaderHandler('onprogress'),
    onload: fileReaderHandler('onload'),
    onabort: fileReaderHandler('onabort'),
    onerror: fileReaderHandler('onerror'),
    onloadend: fileReaderHandler('onloadend'),
    EMPTY: { value: 0, enumerable: true },
    LOADING: { value: 1, enumerable: true },
    DONE: { value: 2, enumerable: true },
    abort: { value: function abort() {
      const state = fileReaderRecord(this);
      if (state.readyState !== FileReader.LOADING) {
        state.result = null;
        return;
      }
      state.readyState = FileReader.DONE;
      state.result = null;
      state.error = namedError('AbortError');
      fireReaderEvent(this, 'abort');
      fireReaderEvent(this, 'loadend');
    }, enumerable: true, writable: true, configurable: true },
    readAsArrayBuffer: { value: function readAsArrayBuffer(blob) { requireFileReaderReadArgument('readAsArrayBuffer', arguments.length); readBlobWith(this, blob, (value) => value.arrayBuffer()); }, enumerable: true, writable: true, configurable: true },
    readAsBinaryString: { value: function readAsBinaryString(blob) { requireFileReaderReadArgument('readAsBinaryString', arguments.length); readBlobWith(this, blob, async (value) => binaryStringFromBuffer(await value.arrayBuffer())); }, enumerable: true, writable: true, configurable: true },
    readAsDataURL: { value: function readAsDataURL(blob) { requireFileReaderReadArgument('readAsDataURL', arguments.length); readBlobWith(this, blob, async (value) => 'data:' + (value.type || '') + ';base64,' + base64Encode(binaryStringFromBuffer(await value.arrayBuffer()))); }, enumerable: true, writable: true, configurable: true },
    readAsText: { value: function readAsText(blob) { requireFileReaderReadArgument('readAsText', arguments.length); readBlobWith(this, blob, (value) => readBlobText(value, arguments.length > 1 ? arguments[1] : undefined)); }, enumerable: true, writable: true, configurable: true },
    constructor: { value: FileReader, writable: true, configurable: true },
  });
  Object.defineProperty(FileReader.prototype, Symbol.toStringTag, { value: 'FileReader', configurable: true });

  function fileReaderRecord(reader) {
    const state = fileReaderState.get(reader);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function fileReaderHandler(name) {
    return {
      get() { return fileReaderRecord(this).handlers[name] || null; },
      set(value) { fileReaderRecord(this).handlers[name] = typeof value === 'function' ? value : null; },
      enumerable: true,
      configurable: true,
    };
  }

  function requireFileReaderReadArgument(methodName, actual) {
    if (actual < 1) throw new TypeError(`Failed to execute '${methodName}' on 'FileReader': 1 argument required, but only 0 present.`);
  }

  async function readBlobText(blob, encoding) {
    if (encoding === undefined) return blob.text();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const label = String(encoding || 'utf-8');
    if (isLatin1EncodingLabel(label)) return decodeWindows1252(bytes);
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }

  function isLatin1EncodingLabel(label) {
    const normalized = label.trim().toLowerCase().replace(/_/g, '-');
    return normalized === 'iso-8859-1' || normalized === 'latin1' || normalized === 'latin-1' || normalized === 'windows-1252' || normalized === 'cp1252';
  }

  function decodeWindows1252(bytes) {
    let out = '';
    for (const byte of bytes) out += String.fromCodePoint(windows1252CodePoint(byte));
    return out;
  }

  const windows1252ControlCodePoints = [
    0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
    0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
    0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
    0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
  ];

  function windows1252CodePoint(byte) {
    return byte >= 0x80 && byte <= 0x9f ? windows1252ControlCodePoints[byte - 0x80] : byte;
  }

  function readBlobWith(reader, blob, operation) {
    if (!(blob instanceof Blob)) throw new TypeError("Failed to execute read on 'FileReader': parameter 1 is not of type 'Blob'.");
    const state = fileReaderRecord(reader);
    if (state.readyState === FileReader.LOADING) throw namedError('InvalidStateError');
    state.error = null;
    state.result = null;
    state.readyState = FileReader.LOADING;
    state.total = progressValue(blob.size);
    fireReaderEvent(reader, 'loadstart', 0, state.total);
    Promise.resolve()
      .then(() => operation(blob))
      .then((result) => finishFileRead(reader, result))
      .catch((error) => failFileRead(reader, error));
  }

  function finishFileRead(reader, result) {
    const state = fileReaderRecord(reader);
    if (state.readyState !== FileReader.LOADING) return;
    state.result = result;
    state.readyState = FileReader.DONE;
    fireReaderEvent(reader, 'progress', state.total, state.total);
    fireReaderEvent(reader, 'load', state.total, state.total);
    fireReaderEvent(reader, 'loadend', state.total, state.total);
  }

  function failFileRead(reader, error) {
    const state = fileReaderRecord(reader);
    if (state.readyState !== FileReader.LOADING) return;
    state.error = error;
    state.readyState = FileReader.DONE;
    fireReaderEvent(reader, 'error', 0, state.total);
    fireReaderEvent(reader, 'loadend', 0, state.total);
  }

  function fireReaderEvent(reader, type, loaded = 0, total = 0) {
    reader.dispatchEvent(new ProgressEvent(type, { lengthComputable: true, loaded, total }));
  }

  function progressValue(value, label) {
    return eventFiniteNumber(value, 0, label);
  }

  function binaryStringFromBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
    return out;
  }


  const permissionStatusSlots = new WeakMap();
  class PermissionStatus extends EventTarget {
    constructor(token, name = '', state = 'prompt') {
      if (token !== permissionStatusToken) throw new TypeError("Failed to construct 'PermissionStatus': Illegal constructor");
      super();
      permissionStatusSlots.set(this, { name: String(name || ''), state: String(state || 'prompt') });
    }
    get name() { return permissionStatusValue(this).name; }
    get state() { return permissionStatusValue(this).state; }
    get onchange() { return this.__zp_onchange || null; }
    set onchange(value) { this.__zp_onchange = typeof value === 'function' ? value : null; }
  }
  defineTraversalPrototype(PermissionStatus.prototype, PermissionStatus, ['name', 'state', 'onchange']);
  Object.defineProperty(PermissionStatus.prototype, Symbol.toStringTag, { value: 'PermissionStatus', configurable: true });

  const permissionsSlots = new WeakMap();
  class Permissions {
    constructor(token, states = {}) {
      if (token !== permissionsToken) throw new TypeError("Failed to construct 'Permissions': Illegal constructor");
      permissionsSlots.set(this, normalizePermissionStates(states));
    }
    async query(descriptor) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'query' on 'Permissions': 1 argument required, but only 0 present.");
      const name = String(descriptor?.name || '');
      if (!permissionNameValid(name))
        throw new TypeError(`Failed to execute 'query' on 'Permissions': Failed to read the 'name' property from 'PermissionDescriptor': The provided value '${name}' is not a valid enum value of type PermissionName.`);
      return new PermissionStatus(permissionStatusToken, name, permissionState(name, permissionsValue(this)));
    }
  }
  defineTraversalPrototype(Permissions.prototype, Permissions, ['query']);
  Object.defineProperty(Permissions.prototype, Symbol.toStringTag, { value: 'Permissions', configurable: true });

  function permissionStatusValue(value) {
    const state = permissionStatusSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function permissionsValue(value) {
    const states = permissionsSlots.get(value);
    if (!states) throw new TypeError('Illegal invocation');
    return states;
  }

  class NavigatorStorageManager {
    constructor(token, quota) {
      if (token !== storageManagerToken) throw new TypeError("Failed to construct 'StorageManager': Illegal constructor");
      const normalizedQuota = Number(quota || DEFAULT_STORAGE_QUOTA_BYTES);
      storageManagerSlots.set(this, { quota: normalizedQuota, persisted: false });
      storageQuotaBytes = normalizedQuota;
    }
    async estimate() { const state = storageManagerValue(this); return { usage: storageUsageBytes(), quota: state.quota }; }
    async persisted() { return storageManagerValue(this).persisted; }
    async getDirectory() { throw namedError('SecurityError'); }
    async persist() { storageManagerValue(this).persisted = true; return true; }
  }
  defineStorageManagerPrototype(NavigatorStorageManager.prototype, NavigatorStorageManager);
  Object.defineProperty(NavigatorStorageManager.prototype, Symbol.toStringTag, { value: 'StorageManager', configurable: true });
  function storageManagerValue(value) {
    const state = storageManagerSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }
  function defineStorageManagerPrototype(proto, constructor) {
    const descriptors = new Map(['estimate', 'persisted', 'getDirectory', 'persist'].map((name) => [name, Object.getOwnPropertyDescriptor(proto, name)]));
    delete proto.constructor;
    for (const name of descriptors.keys()) delete proto[name];
    Object.defineProperty(proto, 'estimate', { ...descriptors.get('estimate'), enumerable: true });
    Object.defineProperty(proto, 'persisted', { ...descriptors.get('persisted'), enumerable: true });
    Object.defineProperty(proto, 'constructor', { value: constructor, enumerable: false, writable: true, configurable: true });
    Object.defineProperty(proto, 'getDirectory', { ...descriptors.get('getDirectory'), enumerable: true });
    Object.defineProperty(proto, 'persist', { ...descriptors.get('persist'), enumerable: true });
  }

  class CustomElementRegistry {
    constructor(token) {
      if (token !== customElementRegistryToken) throw new TypeError("Failed to construct 'CustomElementRegistry': Illegal constructor");
      this.__zpDefinitions = new Map();
      this.__zpConstructors = new Map();
      this.__zpWaiters = new Map();
    }
    define(name, constructor, options = {}) {
      const localName = validCustomElementName(name);
      if (typeof constructor !== 'function') throw new TypeError("Failed to execute 'define' on 'CustomElementRegistry': parameter 2 is not a constructor.");
      if (this.__zpDefinitions.has(localName) || this.__zpConstructors.has(constructor)) throw namedError('NotSupportedError');
      const extendsName = options?.extends === undefined ? undefined : String(options.extends);
      this.__zpDefinitions.set(localName, { constructor, extends: extendsName });
      this.__zpConstructors.set(constructor, localName);
      const waiter = this.__zpWaiters.get(localName);
      if (waiter) waiter.resolve(constructor);
    }
    get(name) { return this.__zpDefinitions.get(String(name))?.constructor; }
    getName(constructor) { return this.__zpConstructors.get(constructor) || null; }
    upgrade(root) { void root; }
    initialize(root) { void root; }
    whenDefined(name) {
      const localName = validCustomElementName(name);
      const defined = this.__zpDefinitions.get(localName);
      if (defined) return Promise.resolve(defined.constructor);
      let waiter = this.__zpWaiters.get(localName);
      if (!waiter) {
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        waiter = { promise, resolve };
        this.__zpWaiters.set(localName, waiter);
      }
      return waiter.promise;
    }
  }
  Object.defineProperty(CustomElementRegistry.prototype, Symbol.toStringTag, { value: 'CustomElementRegistry', configurable: true });

  function validCustomElementName(name) {
    const localName = String(name || '');
    if (!/^[a-z][.0-9_a-z-]*-[.0-9_a-z-]*$/.test(localName)) throw new SyntaxError("Failed to execute 'define' on 'CustomElementRegistry': '" + localName + "' is not a valid custom element name.");
    return localName;
  }

  class CustomStateSet extends Set {
    constructor(token, values = []) {
      if (token !== customStateSetToken) throw new TypeError("Failed to construct 'CustomStateSet': Illegal constructor");
      super(values);
    }
  }
  function customStateSetValues() { return Set.prototype.values.call(this); }
  Object.defineProperty(customStateSetValues, 'name', { value: 'values', configurable: true });
  Object.defineProperties(CustomStateSet.prototype, {
    size: Object.getOwnPropertyDescriptor(Set.prototype, 'size'),
    add: { value: Set.prototype.add, writable: true, configurable: true },
    clear: { value: Set.prototype.clear, writable: true, configurable: true },
    delete: { value: Set.prototype.delete, writable: true, configurable: true },
    entries: { value: Set.prototype.entries, writable: true, configurable: true },
    forEach: { value: Set.prototype.forEach, writable: true, configurable: true },
    has: { value: Set.prototype.has, writable: true, configurable: true },
    keys: { value: customStateSetValues, writable: true, configurable: true },
    values: { value: Set.prototype.values, writable: true, configurable: true },
    [Symbol.iterator]: { value: Set.prototype[Symbol.iterator], writable: true, configurable: true },
  });
  Object.setPrototypeOf(CustomStateSet.prototype, Object.prototype);
  Object.defineProperty(CustomStateSet.prototype, Symbol.toStringTag, { value: 'CustomStateSet', configurable: true });

  class ElementInternals {
    constructor(token, target) {
      if (token !== elementInternalsToken) throw new TypeError("Failed to construct 'ElementInternals': Illegal constructor");
      Object.defineProperty(this, '__zpTarget', { value: target, configurable: true });
      Object.defineProperty(this, 'states', { value: new CustomStateSet(customStateSetToken), enumerable: true, configurable: true });
      this.role = '';
      this.ariaLabel = '';
      this.ariaHidden = null;
      this.__zpFormValue = null;
      this.__zpValidityFlags = {};
      this.__zpValidationMessage = '';
    }
    get form() { return this.__zpTarget?.form || null; }
    get labels() { return this.__zpTarget?.labels || null; }
    get shadowRoot() { return null; }
    get validationMessage() { return this.__zpValidationMessage; }
    get validity() { return validityState(this.__zpTarget); }
    get willValidate() { return Boolean(this.__zpTarget?.willValidate); }
    checkValidity() { return this.__zpTarget?.checkValidity?.() ?? true; }
    reportValidity() { return this.__zpTarget?.reportValidity?.() ?? true; }
    setFormValue(value = null) { this.__zpFormValue = value; }
    setValidity(flags = {}, message = '') { this.__zpValidityFlags = { ...flags }; this.__zpValidationMessage = String(message || ''); }
  }
  function elementInternalsAccessor(name, fallback = '') {
    return {
      get() { return Object.prototype.hasOwnProperty.call(this, '__zp_' + name) ? this['__zp_' + name] : fallback; },
      set(value) { Object.defineProperty(this, '__zp_' + name, { value, configurable: true, writable: true }); },
      enumerable: true,
      configurable: true,
    };
  }
  for (const name of [
    'ariaActiveDescendantElement', 'ariaAtomic', 'ariaAutoComplete', 'ariaBrailleLabel',
    'ariaBrailleRoleDescription', 'ariaBusy', 'ariaChecked', 'ariaColCount', 'ariaColIndex',
    'ariaColIndexText', 'ariaColSpan', 'ariaControlsElements', 'ariaCurrent',
    'ariaDescribedByElements', 'ariaDescription', 'ariaDetailsElements', 'ariaDisabled',
    'ariaErrorMessageElements', 'ariaExpanded', 'ariaFlowToElements', 'ariaHasPopup',
    'ariaHidden', 'ariaInvalid', 'ariaKeyShortcuts', 'ariaLabel', 'ariaLabelledByElements',
    'ariaLevel', 'ariaLive', 'ariaModal', 'ariaMultiLine', 'ariaMultiSelectable',
    'ariaOrientation', 'ariaPlaceholder', 'ariaPosInSet', 'ariaPressed', 'ariaReadOnly',
    'ariaRelevant', 'ariaRequired', 'ariaRoleDescription', 'ariaRowCount', 'ariaRowIndex',
    'ariaRowIndexText', 'ariaRowSpan', 'ariaSelected', 'ariaSetSize', 'ariaSort',
    'ariaValueMax', 'ariaValueMin', 'ariaValueNow', 'ariaValueText', 'role',
  ]) {
    Object.defineProperty(ElementInternals.prototype, name, elementInternalsAccessor(name, null));
  }
  Object.defineProperty(ElementInternals.prototype, 'states', { get() { return Object.getOwnPropertyDescriptor(this, 'states')?.value ?? null; }, enumerable: true, configurable: true });
  Object.defineProperties(ElementInternals.prototype, {
    setFormValue: { value: function setFormValue(value) { this.__zpFormValue = arguments.length > 0 ? value : null; }, writable: true, configurable: true },
    setValidity: { value: function setValidity(flags) { const message = arguments.length > 1 ? arguments[1] : ''; this.__zpValidityFlags = { ...(flags || {}) }; this.__zpValidationMessage = String(message || ''); }, writable: true, configurable: true },
  });
  Object.defineProperty(ElementInternals.prototype, Symbol.toStringTag, { value: 'ElementInternals', configurable: true });

  class CSSStyleDeclaration {
    constructor() {
      this.__zp = Object.create(null);
      this.__zpPriority = Object.create(null);
      this.__zpOrder = [];
      for (const prop of ['color', 'backgroundColor', 'backgroundImage', 'marginLeft', 'width', 'height', 'display']) defineStyleProperty(this, prop);
    }
    get parentRule() { return null; }
    get cssFloat() { return this.getPropertyValue('float'); }
    set cssFloat(value) { this.setProperty('float', value); }
    get length() { return this.__zpOrder.length; }
    get cssText() { return this.__zpOrder.map((key) => key + ': ' + this.__zp[key] + (this.__zpPriority[key] ? ' !' + this.__zpPriority[key] : '') + ';').join(' '); }
    set cssText(value) {
      this.__zp = Object.create(null);
      this.__zpPriority = Object.create(null);
      this.__zpOrder = [];
      parseStyleDeclarations(String(value || ''), (name, text, priority) => this.setProperty(name, text, priority));
    }
    item(index) { return this.__zpOrder[Number(index)] || ''; }
    getPropertyValue(name) { return this.__zp[styleName(name)] || ''; }
    getPropertyPriority(name) { return this.__zpPriority[styleName(name)] || ''; }
    setProperty(name, value, priority = '') {
      const key = styleName(name);
      if (!key) return;
      if (!this.__zpOrder.includes(key)) this.__zpOrder.push(key);
      this.__zp[key] = String(value ?? '').trim();
      const priorityText = String(priority || '').trim().toLowerCase();
      if (priorityText) this.__zpPriority[key] = priorityText === 'important' ? 'important' : priorityText;
      else delete this.__zpPriority[key];
    }
    removeProperty(name) {
      const key = styleName(name);
      const old = this.__zp[key] || '';
      delete this.__zp[key];
      delete this.__zpPriority[key];
      this.__zpOrder = this.__zpOrder.filter((item) => item !== key);
      return old;
    }
  }
  Object.defineProperty(CSSStyleDeclaration.prototype, Symbol.toStringTag, { value: 'CSSStyleDeclaration', configurable: true });
  Object.defineProperty(CSSStyleDeclaration.prototype, Symbol.iterator, { value: function values() { return styleMapKeys(this)[Symbol.iterator](); }, writable: true, configurable: true });
  const { StyleSheet, CSSStyleSheet, CSSRule, CSSRuleList, CSSGroupingRule, CSSConditionRule, CSSStyleRule, CSSMediaRule, CSSSupportsRule, CSSImportRule, CSSFontFaceRule, CSSPageRule, CSSMarginRule, CSSKeyframesRule, CSSKeyframeRule, CSSNamespaceRule, CSSLayerBlockRule, CSSLayerStatementRule, CSSContainerRule, CSSScopeRule, CSSStartingStyleRule, CSSNestedDeclarations, CSSCounterStyleRule, CSSFontFeatureValuesRule, CSSFontPaletteValuesRule, CSSPropertyRule, CSSPositionTryRule, CSSViewTransitionRule, MediaList, StyleSheetList, makeStyleSheetList } = createCSSOMRuleFacades(CSSStyleDeclaration);
  const cssTypedOMFacades = createCSSTypedOMFacades();
  const stylePropertyMapToken = {};
  class StylePropertyMapReadOnly {
    constructor(token, style = null, mutable = false) {
      if (token !== stylePropertyMapToken) throw new TypeError("Failed to construct 'StylePropertyMapReadOnly': Illegal constructor");
      Object.defineProperty(this, '__zpStyle', { value: style, configurable: true });
      Object.defineProperty(this, '__zpMutable', { value: Boolean(mutable), configurable: true });
    }
    get size() { return this.__zpStyle?.length || 0; }
    get(name) {
      const value = styleMapRawValue(this.__zpStyle, name);
      return value === '' ? undefined : cssTypedOMFacades.CSSStyleValue.parse(styleName(name), value);
    }
    getAll(name) {
      const value = this.get(name);
      return value === undefined ? [] : [value];
    }
    has(name) { return styleMapRawValue(this.__zpStyle, name) !== ''; }
    entries() { return styleMapEntries(this.__zpStyle)[Symbol.iterator](); }
    keys() { return styleMapKeys(this.__zpStyle)[Symbol.iterator](); }
    values() { return styleMapValues(this.__zpStyle)[Symbol.iterator](); }
    forEach(callback, thisArg = undefined) {
      for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
    }
    [Symbol.iterator]() { return this.entries(); }
  }
  Object.defineProperty(StylePropertyMapReadOnly.prototype, Symbol.iterator, { value: StylePropertyMapReadOnly.prototype.entries, writable: true, configurable: true });
  Object.defineProperty(StylePropertyMapReadOnly.prototype, Symbol.toStringTag, { value: 'StylePropertyMapReadOnly', configurable: true });

  class StylePropertyMap extends StylePropertyMapReadOnly {
    constructor(token, style = null) {
      if (token !== stylePropertyMapToken) throw new TypeError("Failed to construct 'StylePropertyMap': Illegal constructor");
      super(token, style, true);
    }
    set(name, ...values) { this.__zpStyle.setProperty(name, styleMapSerialize(values)); }
    append(name, ...values) {
      const prior = styleMapRawValue(this.__zpStyle, name);
      this.__zpStyle.setProperty(name, [prior, styleMapSerialize(values)].filter(Boolean).join(' '));
    }
    delete(name) { this.__zpStyle.removeProperty(name); }
    clear() { for (const key of [...styleMapKeys(this.__zpStyle)]) this.__zpStyle.removeProperty(key); }
  }
  Object.defineProperty(StylePropertyMap.prototype, Symbol.toStringTag, { value: 'StylePropertyMap', configurable: true });

  function stylePropertyMapFor(style) {
    if (!style.__zpAttributeStyleMap) Object.defineProperty(style, '__zpAttributeStyleMap', { value: new StylePropertyMap(stylePropertyMapToken, style), configurable: true });
    return style.__zpAttributeStyleMap;
  }

  function styleMapRawValue(style, name) {
    return style?.getPropertyValue(styleName(name)) || '';
  }

  function styleMapKeys(style) {
    const keys = [];
    for (let index = 0; index < (style?.length || 0); index += 1) keys.push(style.item(index));
    return keys;
  }

  function styleMapEntries(style) {
    return styleMapKeys(style).map((key) => [key, cssTypedOMFacades.CSSStyleValue.parse(key, style.getPropertyValue(key))]);
  }

  function styleMapValues(style) {
    return styleMapEntries(style).map((entry) => entry[1]);
  }

  function styleMapSerialize(values) {
    return values.map((value) => value instanceof cssTypedOMFacades.CSSStyleValue ? value.toString() : String(value ?? '')).join(' ').trim();
  }
  const CSSNamespace = {
    escape: cssEscape,
    supports: cssSupports,
  };
  installCSSNamespaceFactories(CSSNamespace);
  Object.defineProperty(CSSNamespace, Symbol.toStringTag, { value: 'CSS', configurable: true });
  function installCSSNamespaceFactories(namespace) {
    try { Object.defineProperty(cssEscape, 'name', { value: 'escape', configurable: true }); } catch {}
    try { Object.defineProperty(cssSupports, 'name', { value: 'supports', configurable: true }); } catch {}
    try { Object.defineProperty(cssRegisterProperty, 'name', { value: 'registerProperty', configurable: true }); } catch {}
    for (const [name, unit] of cssUnitFactoryEntries()) {
      Object.defineProperty(namespace, name, { value: cssUnitFactory(name, unit), enumerable: true, writable: true, configurable: true });
    }
    Object.defineProperty(namespace, 'registerProperty', { value: cssRegisterProperty, enumerable: true, writable: true, configurable: true });
  }
  function cssUnitFactoryEntries() {
    return [
      ['Hz', 'hz'], ['Q', 'q'], ['cap', 'cap'], ['ch', 'ch'], ['cm', 'cm'], ['cqb', 'cqb'], ['cqh', 'cqh'], ['cqi', 'cqi'], ['cqmax', 'cqmax'], ['cqmin', 'cqmin'], ['cqw', 'cqw'], ['deg', 'deg'], ['dpcm', 'dpcm'], ['dpi', 'dpi'], ['dppx', 'dppx'], ['dvb', 'dvb'], ['dvh', 'dvh'], ['dvi', 'dvi'], ['dvmax', 'dvmax'], ['dvmin', 'dvmin'], ['dvw', 'dvw'], ['em', 'em'], ['ex', 'ex'], ['fr', 'fr'], ['grad', 'grad'], ['ic', 'ic'], ['in', 'in'], ['kHz', 'khz'], ['lh', 'lh'], ['lvb', 'lvb'], ['lvh', 'lvh'], ['lvi', 'lvi'], ['lvmax', 'lvmax'], ['lvmin', 'lvmin'], ['lvw', 'lvw'], ['mm', 'mm'], ['ms', 'ms'], ['number', 'number'], ['pc', 'pc'], ['percent', 'percent'], ['pt', 'pt'], ['px', 'px'], ['rad', 'rad'], ['rcap', 'rcap'], ['rch', 'rch'], ['rem', 'rem'], ['rex', 'rex'], ['ric', 'ric'], ['rlh', 'rlh'], ['s', 's'], ['svb', 'svb'], ['svh', 'svh'], ['svi', 'svi'], ['svmax', 'svmax'], ['svmin', 'svmin'], ['svw', 'svw'], ['turn', 'turn'], ['vb', 'vb'], ['vh', 'vh'], ['vi', 'vi'], ['vmax', 'vmax'], ['vmin', 'vmin'], ['vw', 'vw'], ['x', 'x'],
    ];
  }
  function cssUnitFactory(name, unit) {
    const factory = function cssUnit(value) { return new cssTypedOMFacades.CSSUnitValue(value, unit); };
    try { Object.defineProperty(factory, 'name', { value: name, configurable: true }); } catch {}
    return factory;
  }
  function cssRegisterProperty(definition) {
    if (!definition || typeof definition !== 'object') throw new TypeError("Failed to execute 'registerProperty' on 'CSS': parameter 1 is not an object.");
    const name = String(definition.name || '');
    if (!name.startsWith('--')) throw namedError('SyntaxError', "Failed to execute 'registerProperty' on 'CSS': Custom property names must start with '--'.");
    return undefined;
  }

  function rangeCollapsed(range) { return range.startContainer === range.endContainer && range.startOffset === range.endOffset; }
  function abstractRangeValue(range) {
    return staticRangeSlots.get(range) || range;
  }
  class AbstractRange {
    constructor() { throw new TypeError("Failed to construct 'AbstractRange': Illegal constructor"); }
    get startContainer() { return abstractRangeValue(this).__zpStartContainer; }
    get startOffset() { return abstractRangeValue(this).__zpStartOffset; }
    get endContainer() { return abstractRangeValue(this).__zpEndContainer; }
    get endOffset() { return abstractRangeValue(this).__zpEndOffset; }
    get collapsed() { return rangeCollapsed(this); }
  }
  delete AbstractRange.prototype.constructor;
  Object.defineProperties(AbstractRange.prototype, {
    startContainer: { ...Object.getOwnPropertyDescriptor(AbstractRange.prototype, 'startContainer'), enumerable: true },
    startOffset: { ...Object.getOwnPropertyDescriptor(AbstractRange.prototype, 'startOffset'), enumerable: true },
    endContainer: { ...Object.getOwnPropertyDescriptor(AbstractRange.prototype, 'endContainer'), enumerable: true },
    endOffset: { ...Object.getOwnPropertyDescriptor(AbstractRange.prototype, 'endOffset'), enumerable: true },
    collapsed: { ...Object.getOwnPropertyDescriptor(AbstractRange.prototype, 'collapsed'), enumerable: true },
    constructor: { value: AbstractRange, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(AbstractRange.prototype, Symbol.toStringTag, { value: 'AbstractRange', configurable: true });

  class Range {
    constructor(root = globalThis.document || null) {
      this.__zpStartContainer = root;
      this.__zpStartOffset = 0;
      this.__zpEndContainer = root;
      this.__zpEndOffset = 0;
    }
    get collapsed() { return rangeCollapsed(this); }
    get commonAncestorContainer() { return commonAncestor(this.startContainer, this.endContainer); }
    setStart(node, offset) { this.__zpStartContainer = node; this.__zpStartOffset = Number(offset) || 0; }
    setEnd(node, offset) { this.__zpEndContainer = node; this.__zpEndOffset = Number(offset) || 0; }
    setStartBefore(node) { this.setStart(node.parentNode, nodeIndex(node)); }
    setStartAfter(node) { this.setStart(node.parentNode, nodeIndex(node) + 1); }
    setEndBefore(node) { this.setEnd(node.parentNode, nodeIndex(node)); }
    setEndAfter(node) { this.setEnd(node.parentNode, nodeIndex(node) + 1); }
    selectNode(node) { this.setStartBefore(node); this.setEndAfter(node); }
    selectNodeContents(node) { this.setStart(node, 0); this.setEnd(node, rangeNodeLength(node)); }
    collapse(toStart = false) { if (toStart) this.setEnd(this.startContainer, this.startOffset); else this.setStart(this.endContainer, this.endOffset); }
    cloneRange() { const next = new Range(this.startContainer); next.setStart(this.startContainer, this.startOffset); next.setEnd(this.endContainer, this.endOffset); return next; }
    detach() {}
    compareBoundaryPoints(how, sourceRange) { return compareRangeBoundaryPoint(this, how, sourceRange); }
    comparePoint(node, offset) { return comparePointInRange(this, node, offset); }
    isPointInRange(node, offset) { return this.comparePoint(node, offset) === 0; }
    expand() {}
    intersectsNode(node) { return rangeIntersectsNode(this, node); }
    cloneContents() { return rangeCloneContents(this); }
    extractContents() { const fragment = this.cloneContents(); this.deleteContents(); return fragment; }
    deleteContents() { rangeDeleteContents(this); }
    insertNode(node) { rangeInsertNode(this, node); }
    surroundContents(newParent) { rangeSurroundContents(this, newParent); }
    createContextualFragment(markup) { return rangeCreateContextualFragment(this, markup); }
    getClientRects() { return rectListFromRects(rangeClientRects(this)); }
    getBoundingClientRect() { return boundingRectFromRects(rangeClientRects(this)); }
    toString() { return rangeText(this); }
  }


  function compareRangeBoundaryPoint(range, how, sourceRange) {
    if (!sourceRange) throw new TypeError("Failed to execute 'compareBoundaryPoints' on 'Range': parameter 2 is not of type 'Range'.");
    const kind = Number(how);
    if (kind === Range.START_TO_START) return compareBoundary(range.startContainer, range.startOffset, sourceRange.startContainer, sourceRange.startOffset);
    if (kind === Range.START_TO_END) return compareBoundary(range.endContainer, range.endOffset, sourceRange.startContainer, sourceRange.startOffset);
    if (kind === Range.END_TO_END) return compareBoundary(range.endContainer, range.endOffset, sourceRange.endContainer, sourceRange.endOffset);
    if (kind === Range.END_TO_START) return compareBoundary(range.startContainer, range.startOffset, sourceRange.endContainer, sourceRange.endOffset);
    throw namedError('NotSupportedError');
  }

  function comparePointInRange(range, node, offset = 0) {
    const pointOffset = Number(offset) || 0;
    if (compareBoundary(node, pointOffset, range.startContainer, range.startOffset) < 0) return -1;
    if (compareBoundary(node, pointOffset, range.endContainer, range.endOffset) > 0) return 1;
    return 0;
  }

  function rangeIntersectsNode(range, node) {
    if (!node?.parentNode) return false;
    const parent = node.parentNode;
    const start = nodeIndex(node);
    return compareBoundary(range.endContainer, range.endOffset, parent, start) > 0 && compareBoundary(range.startContainer, range.startOffset, parent, start + 1) < 0;
  }

  function rangeCloneContents(range) {
    const fragment = rangeDocument(range).createDocumentFragment();
    if (rangeCollapsed(range)) return fragment;
    if (appendSameTextRange(fragment, range)) return fragment;
    const children = sameContainerRangeChildren(range);
    if (children) for (const child of children) fragment.appendChild(cloneRangeNode(child, rangeDocument(range)));
    else appendRangeTextFallback(fragment, range);
    return fragment;
  }

  function rangeDeleteContents(range) {
    if (rangeCollapsed(range)) return;
    if (deleteSameTextRange(range)) return;
    const children = sameContainerRangeChildren(range);
    if (children) {
      for (const child of [...children]) child.parentNode?.removeChild(child);
      range.setEnd(range.startContainer, range.startOffset);
      return;
    }
    deleteRangeTextFallback(range);
  }

  function rangeInsertNode(range, node) {
    if (!node) throw new TypeError("Failed to execute 'insertNode' on 'Range': parameter 1 is not of type 'Node'.");
    const point = rangeInsertionPoint(range.startContainer, range.startOffset);
    if (!point.parent) throw namedError('HierarchyRequestError');
    insertRangeNodeAt(point.parent, node, point.before);
  }

  function rangeSurroundContents(range, newParent) {
    if (!newParent) throw new TypeError("Failed to execute 'surroundContents' on 'Range': parameter 1 is not of type 'Node'.");
    const fragment = range.extractContents();
    while (newParent.firstChild) newParent.removeChild(newParent.firstChild);
    while (fragment.firstChild) newParent.appendChild(fragment.firstChild);
    range.insertNode(newParent);
    range.selectNode(newParent);
  }

  function rangeCreateContextualFragment(range, markup) {
    const fragment = rangeDocument(range).createDocumentFragment();
    appendHTML(fragment, String(markup ?? ''));
    return fragment;
  }

  function appendSameTextRange(fragment, range) {
    if (range.startContainer !== range.endContainer || range.startContainer?.nodeType !== 3) return false;
    fragment.appendChild(rangeDocument(range).createTextNode(String(range.startContainer.textContent || '').slice(range.startOffset, range.endOffset)));
    return true;
  }

  function deleteSameTextRange(range) {
    if (range.startContainer !== range.endContainer || range.startContainer?.nodeType !== 3) return false;
    const text = String(range.startContainer.textContent || '');
    range.startContainer.textContent = text.slice(0, range.startOffset) + text.slice(range.endOffset);
    range.setEnd(range.startContainer, range.startOffset);
    return true;
  }

  function sameContainerRangeChildren(range) {
    if (range.startContainer !== range.endContainer || !range.startContainer?.childNodes) return null;
    return childArray(range.startContainer).slice(range.startOffset, range.endOffset);
  }

  function appendRangeTextFallback(fragment, range) {
    const text = rangeText(range);
    if (text) fragment.appendChild(rangeDocument(range).createTextNode(text));
  }

  function deleteRangeTextFallback(range) {
    const root = range.commonAncestorContainer;
    if (!root) return;
    const text = String(root.textContent || '');
    const start = textOffset(root, range.startContainer, range.startOffset);
    const end = textOffset(root, range.endContainer, range.endOffset);
    root.textContent = text.slice(0, Math.min(start, end)) + text.slice(Math.max(start, end));
    range.setStart(root, Math.min(start, end));
    range.collapse(true);
  }

  function rangeInsertionPoint(container, offset) {
    if (container?.nodeType === 3) {
      const index = Math.max(0, Math.min(Number(offset) || 0, String(container.textContent || '').length));
      const tail = container.splitText ? container.splitText(index) : null;
      return { parent: container.parentNode, before: tail };
    }
    const children = childArray(container);
    return { parent: container, before: children[Math.max(0, Number(offset) || 0)] || null };
  }

  function insertRangeNodeAt(parent, node, before) {
    if (node.nodeType === 11) {
      while (node.firstChild) parent.insertBefore(node.firstChild, before);
      return;
    }
    parent.insertBefore(node, before);
  }

  function cloneRangeNode(node, doc) {
    const clone = cloneRangeNodeShallow(node, doc);
    for (const child of childArray(node)) clone.appendChild(cloneRangeNode(child, doc));
    return clone;
  }

  function cloneRangeNodeShallow(node, doc) {
    if (node?.nodeType === 3) return doc.createTextNode(node.textContent || '');
    if (node?.nodeType === 8) return doc.createComment(node.textContent || '');
    if (node?.nodeType === 11) return doc.createDocumentFragment();
    const clone = node?.namespaceURI ? doc.createElementNS(node.namespaceURI, node.localName || node.nodeName) : doc.createElement(node?.localName || 'span');
    copyRangeNodeAttributes(node, clone);
    return clone;
  }

  function copyRangeNodeAttributes(source, target) {
    for (const attr of source?.attributes?.values?.() || []) {
      if (attr.namespaceURI) target.setAttributeNS(attr.namespaceURI, attr.name, attr.value || '');
      else target.setAttribute(attr.name, attr.value || '');
    }
  }

  function compareBoundary(aNode, aOffset, bNode, bOffset) {
    if (aNode === bNode) return numberCompare(Number(aOffset) || 0, Number(bOffset) || 0);
    const root = commonAncestor(aNode, bNode);
    const textOrder = numberCompare(textOffset(root, aNode, aOffset), textOffset(root, bNode, bOffset));
    return textOrder || compareNodePath(aNode, bNode, root) || numberCompare(Number(aOffset) || 0, Number(bOffset) || 0);
  }

  function compareNodePath(aNode, bNode, root) {
    const aPath = nodePath(aNode, root);
    const bPath = nodePath(bNode, root);
    for (let index = 0; index < Math.min(aPath.length, bPath.length); index += 1) {
      const order = numberCompare(aPath[index], bPath[index]);
      if (order) return order;
    }
    return numberCompare(aPath.length, bPath.length);
  }

  function nodePath(node, root) {
    const path = [];
    for (let current = node; current && current !== root; current = current.parentNode) path.unshift(nodeIndex(current));
    return path;
  }

  function numberCompare(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

  function rangeDocument(range) {
    return range.startContainer?.ownerDocument || range.endContainer?.ownerDocument || globalThis.document;
  }
  function rangeClientRects(range) {
    return rangeRectElements(range).map((element) => element.getBoundingClientRect?.() || new DOMRect(0, 0, 0, 0));
  }

  function rangeRectElements(range) {
    if (rangeCollapsed(range)) return [];
    if (range.startContainer === range.endContainer && range.startContainer?.nodeType === 1) {
      const children = childArray(range.startContainer).slice(range.startOffset, range.endOffset).filter((node) => node?.nodeType === 1);
      return children.length ? children : [range.startContainer];
    }
    const start = elementForRangeNode(range.startContainer);
    const end = elementForRangeNode(range.endContainer);
    if (start && start === end) return [start];
    const ancestor = elementForRangeNode(commonAncestor(range.startContainer, range.endContainer));
    return ancestor ? [ancestor] : [];
  }

  function elementForRangeNode(node) {
    if (node?.nodeType === 1) return node;
    if (node?.parentElement) return node.parentElement;
    if (node?.documentElement) return node.documentElement;
    return node?.ownerDocument?.documentElement || null;
  }

  function rectListFromRects(rects) {
    const ListCtor = globalThis.DOMRectList;
    const list = ListCtor?.prototype ? Object.create(ListCtor.prototype) : {};
    Object.defineProperty(list, '__zpDOMRectList', { value: true, configurable: true });
    Object.defineProperty(list, 'length', { value: rects.length, configurable: true });
    list.item = (index) => rects[Number(index)] || null;
    list[Symbol.iterator] = function* iterator() { yield* rects; };
    for (let index = 0; index < rects.length; index += 1) Object.defineProperty(list, index, { value: rects[index], enumerable: true, configurable: true });
    return list;
  }

  function boundingRectFromRects(rects) {
    if (!rects.length) return new DOMRect(0, 0, 0, 0);
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return new DOMRect(left, top, right - left, bottom - top);
  }
  Object.defineProperty(Range.prototype, Symbol.toStringTag, { value: 'Range', configurable: true });
  Object.setPrototypeOf(Range.prototype, AbstractRange.prototype);
  Object.defineProperty(Range.prototype, 'constructor', { value: Range, configurable: true, writable: true });
  delete Range.prototype.collapsed;
  Object.defineProperties(Range, {
    START_TO_START: { value: 0, enumerable: true },
    START_TO_END: { value: 1, enumerable: true },
    END_TO_END: { value: 2, enumerable: true },
    END_TO_START: { value: 3, enumerable: true },
  });
  Object.defineProperties(Range.prototype, {
    START_TO_START: { value: 0, enumerable: true },
    START_TO_END: { value: 1, enumerable: true },
    END_TO_END: { value: 2, enumerable: true },
    END_TO_START: { value: 3, enumerable: true },
  });

  class StaticRange {
    constructor(init) {
      if (arguments.length < 1) throw new TypeError("Failed to construct 'StaticRange': 1 argument required, but only 0 present.");
      const endContainer = staticRangeNodeMember(init, 'endContainer');
      const endOffset = staticRangeOffsetMember(init, 'endOffset');
      const startContainer = staticRangeNodeMember(init, 'startContainer');
      const startOffset = staticRangeOffsetMember(init, 'startOffset');
      staticRangeSlots.set(this, {
        __zpStartContainer: startContainer,
        __zpStartOffset: startOffset,
        __zpEndContainer: endContainer,
        __zpEndOffset: endOffset,
      });
    }
  }
  function staticRangeMember(init, name) {
    const value = init?.[name];
    if (value === undefined) throw new TypeError(`Failed to construct 'StaticRange': Failed to read the '${name}' property from 'StaticRangeInit': Required member is undefined.`);
    return value;
  }
  function staticRangeNodeMember(init, name) {
    const value = staticRangeMember(init, name);
    if (!(value instanceof Node)) throw new TypeError(`Failed to construct 'StaticRange': Failed to read the '${name}' property from 'StaticRangeInit': Failed to convert value to 'Node'.`);
    return value;
  }
  function staticRangeOffsetMember(init, name) {
    return Number(staticRangeMember(init, name)) >>> 0;
  }
  Object.setPrototypeOf(StaticRange.prototype, AbstractRange.prototype);
  Object.defineProperty(StaticRange.prototype, 'constructor', { value: StaticRange, configurable: true, writable: true });
  Object.defineProperty(StaticRange.prototype, Symbol.toStringTag, { value: 'StaticRange', configurable: true });
  const { Highlight, HighlightRegistry, highlightRegistry } = createHighlightSupport(AbstractRange);
  const cssHighlightsDescriptor = Object.getOwnPropertyDescriptor({ get highlights() { return highlightRegistry; } }, 'highlights');
  Object.defineProperty(CSSNamespace, 'highlights', { ...cssHighlightsDescriptor, enumerable: true, configurable: true });

  const selectionSlots = new WeakMap();
  function emptySelectionState() {
    return { range: null, anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, direction: 'none' };
  }
  function selectionState(selection) {
    const state = selectionSlots.get(selection);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }
  function clearSelection(selection) {
    Object.assign(selectionState(selection), emptySelectionState());
  }
  function setSelectionFromRange(selection, range, direction = 'none') {
    const state = selectionState(selection);
    state.range = range;
    state.anchorNode = range.startContainer;
    state.anchorOffset = range.startOffset;
    state.focusNode = range.endContainer;
    state.focusOffset = range.endOffset;
    state.direction = direction;
  }
  function setSelectionFromPoints(selection, anchorNode, anchorOffset, focusNode, focusOffset) {
    const anchor = Number(anchorOffset) || 0;
    const focus = Number(focusOffset) || 0;
    const order = compareBoundary(anchorNode, anchor, focusNode, focus);
    const range = new Range(anchorNode?.ownerDocument || focusNode?.ownerDocument || globalThis.document || anchorNode || focusNode);
    if (order > 0) {
      range.setStart(focusNode, focus);
      range.setEnd(anchorNode, anchor);
    } else {
      range.setStart(anchorNode, anchor);
      range.setEnd(focusNode, focus);
    }
    const state = selectionState(selection);
    state.range = range;
    state.anchorNode = anchorNode;
    state.anchorOffset = anchor;
    state.focusNode = focusNode;
    state.focusOffset = focus;
    state.direction = order > 0 ? 'backward' : (order < 0 ? 'forward' : 'none');
  }
  class Selection {
    constructor() { selectionSlots.set(this, emptySelectionState()); }
    get rangeCount() { return selectionState(this).range ? 1 : 0; }
    get anchorNode() { return selectionState(this).anchorNode; }
    get anchorOffset() { return selectionState(this).anchorOffset; }
    get focusNode() { return selectionState(this).focusNode; }
    get focusOffset() { return selectionState(this).focusOffset; }
    get isCollapsed() { return !selectionState(this).range || selectionState(this).range.collapsed; }
    get type() { const range = selectionState(this).range; return range ? (range.collapsed ? 'Caret' : 'Range') : 'None'; }
    get direction() { return selectionState(this).range ? selectionState(this).direction : 'none'; }
    get baseNode() { return this.anchorNode; }
    get baseOffset() { return this.anchorOffset; }
    get extentNode() { return this.focusNode; }
    get extentOffset() { return this.focusOffset; }
    addRange(range) { setSelectionFromRange(this, range); }
    removeRange(range) { if (selectionState(this).range === range) clearSelection(this); }
    removeAllRanges() { clearSelection(this); }
    empty() { this.removeAllRanges(); }
    getRangeAt(index) { const range = selectionState(this).range; if (!range || Number(index) !== 0) throw namedError('IndexSizeError'); return range; }
    collapse(node, offset = 0) {
      if (node == null) { this.removeAllRanges(); return; }
      const range = new Range(node?.ownerDocument || globalThis.document || node);
      range.setStart(node, offset);
      range.collapse(true);
      setSelectionFromRange(this, range);
    }
    collapseToStart() { const range = selectionState(this).range; if (!range) throw namedError('InvalidStateError'); this.collapse(range.startContainer, range.startOffset); }
    collapseToEnd() { const range = selectionState(this).range; if (!range) throw namedError('InvalidStateError'); this.collapse(range.endContainer, range.endOffset); }
    setPosition(node, offset = 0) { this.collapse(node, offset); }
    extend(node, offset = 0) {
      const state = selectionState(this);
      if (!state.range) this.collapse(node, offset);
      else setSelectionFromPoints(this, state.anchorNode, state.anchorOffset, node, offset);
    }
    setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
      setSelectionFromPoints(this, anchorNode, anchorOffset, focusNode, focusOffset);
    }
    selectAllChildren(node) {
      const range = new Range(node?.ownerDocument || globalThis.document || node);
      range.selectNodeContents(node);
      setSelectionFromRange(this, range, 'forward');
    }
    deleteFromDocument() {
      const range = selectionState(this).range;
      range?.deleteContents();
      if (range) setSelectionFromRange(this, range);
    }
    containsNode(node, allowPartialContainment = false) {
      const range = selectionState(this).range;
      if (!range || !node) return false;
      if (allowPartialContainment) return range.intersectsNode(node);
      const probe = new Range(node?.ownerDocument || globalThis.document || node);
      probe.selectNode(node);
      return compareBoundary(probe.startContainer, probe.startOffset, range.startContainer, range.startOffset) >= 0 && compareBoundary(probe.endContainer, probe.endOffset, range.endContainer, range.endOffset) <= 0;
    }
    getComposedRanges() {
      const range = selectionState(this).range;
      return range ? [new StaticRange({ startContainer: range.startContainer, startOffset: range.startOffset, endContainer: range.endContainer, endOffset: range.endOffset })] : [];
    }
    modify(alter = 'move', direction = 'forward', granularity = 'character') {
      void alter; void direction; void granularity;
    }
    toString() { const range = selectionState(this).range; return range ? range.toString() : ''; }
  }
  Object.defineProperty(Selection.prototype, Symbol.toStringTag, { value: 'Selection', configurable: true });

  function TreeWalker(token, root, whatToShow = 0xffffffff, filter = null) {
    if (!new.target) throw new TypeError('Illegal constructor');
    if (token !== treeWalkerToken) throw new TypeError("Failed to construct 'TreeWalker': Illegal constructor");
    treeWalkerSlots.set(this, {
      root,
      whatToShow: Number(whatToShow) >>> 0,
      filter: filter || null,
      currentNode: root,
    });
  }
  Object.defineProperties(TreeWalker.prototype, {
    root: { get() { return treeWalkerValue(this).root; }, configurable: true },
    whatToShow: { get() { return treeWalkerValue(this).whatToShow; }, configurable: true },
    filter: { get() { return treeWalkerValue(this).filter; }, configurable: true },
    currentNode: { get() { return treeWalkerValue(this).currentNode; }, set(value) { treeWalkerValue(this).currentNode = value; }, configurable: true },
    parentNode: { value: function parentNode() { return setWalkerNode(this, acceptedAncestor(this.currentNode, this)); }, writable: true, configurable: true },
    firstChild: { value: function firstChild() { return setWalkerNode(this, acceptedChild(this.currentNode, this, false)); }, writable: true, configurable: true },
    lastChild: { value: function lastChild() { return setWalkerNode(this, acceptedChild(this.currentNode, this, true)); }, writable: true, configurable: true },
    nextSibling: { value: function nextSibling() { return setWalkerNode(this, acceptedSibling(this.currentNode, this, false)); }, writable: true, configurable: true },
    previousSibling: { value: function previousSibling() { return setWalkerNode(this, acceptedSibling(this.currentNode, this, true)); }, writable: true, configurable: true },
    nextNode: { value: function nextNode() { return setWalkerNode(this, acceptedRelative(this.currentNode, this, 1, false)); }, writable: true, configurable: true },
    previousNode: { value: function previousNode() { return setWalkerNode(this, acceptedRelative(this.currentNode, this, -1, false)); }, writable: true, configurable: true },
  });
  function treeWalkerValue(value) {
    const state = treeWalkerSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }
  defineTraversalPrototype(TreeWalker.prototype, TreeWalker, ['root', 'whatToShow', 'filter', 'currentNode', 'firstChild', 'lastChild', 'nextNode', 'nextSibling', 'parentNode', 'previousNode', 'previousSibling']);
  Object.defineProperty(TreeWalker.prototype, Symbol.toStringTag, { value: 'TreeWalker', configurable: true });


  function NodeIterator(token, root, whatToShow = 0xffffffff, filter = null) {
    if (!new.target) throw new TypeError('Illegal constructor');
    if (token !== nodeIteratorToken) throw new TypeError("Failed to construct 'NodeIterator': Illegal constructor");
    nodeIteratorSlots.set(this, {
      root,
      whatToShow: Number(whatToShow) >>> 0,
      filter: filter || null,
      referenceNode: root,
      pointerBeforeReferenceNode: true,
    });
  }
  Object.defineProperties(NodeIterator.prototype, {
    root: { get() { return nodeIteratorValue(this).root; }, configurable: true },
    referenceNode: { get() { return nodeIteratorValue(this).referenceNode; }, configurable: true },
    pointerBeforeReferenceNode: { get() { return nodeIteratorValue(this).pointerBeforeReferenceNode; }, configurable: true },
    whatToShow: { get() { return nodeIteratorValue(this).whatToShow; }, configurable: true },
    filter: { get() { return nodeIteratorValue(this).filter; }, configurable: true },
    detach: { value: function detach() {}, writable: true, configurable: true },
    nextNode: { value: function nextNode() { return iterateNode(this, 1); }, writable: true, configurable: true },
    previousNode: { value: function previousNode() { return iterateNode(this, -1); }, writable: true, configurable: true },
  });
  function nodeIteratorValue(value) {
    const state = nodeIteratorSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }
  defineTraversalPrototype(NodeIterator.prototype, NodeIterator, ['root', 'referenceNode', 'pointerBeforeReferenceNode', 'whatToShow', 'filter', 'detach', 'nextNode', 'previousNode']);
  Object.defineProperty(NodeIterator.prototype, Symbol.toStringTag, { value: 'NodeIterator', configurable: true });
  function defineTraversalPrototype(proto, constructor, names) {
    const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(proto, name)]));
    delete proto.constructor;
    for (const name of names) delete proto[name];
    for (const name of names) Object.defineProperty(proto, name, { ...descriptors.get(name), enumerable: true });
    Object.defineProperty(proto, 'constructor', { value: constructor, enumerable: false, writable: true, configurable: true });
  }

  class VirtualCache {
    constructor(name, entries) { this.name = String(name); this.map = entries || new Map(); }
    async match(request) { const record = this.map.get(cacheKey(request)); return record ? responseFromCacheRecord(record) : undefined; }
    async put(request, response) {
      const key = cacheKey(request);
      const body = await response.clone().text();
      const record = {
        request: requestRecordFromInput(request),
        response: responseRecordFromInput(response, body),
      };
      const previous = this.map.has(key) ? this.map.get(key) : undefined;
      this.map.set(key, record);
      enforceVirtualStorageQuota(() => {
        if (previous) this.map.set(key, previous);
        else this.map.delete(key);
      });
      persistCachePut(this.name, record.request, record.response);
    }
    async add(request) {
      const response = await fetch(request);
      if (!response || !response.ok) throw new TypeError('Cache.add() encountered a network error');
      await this.put(request, response);
    }
    async addAll(requests) {
      await Promise.all(Array.from(requests || [], (request) => this.add(request)));
    }
    async delete(request) { const key = cacheKey(request); const deleted = this.map.delete(key); if (deleted) persistCacheDelete(this.name, requestRecordFromInput(request)); return deleted; }
    async keys() { return [...this.map.values()].map((record) => new Request(record.request.url, record.request)); }
  }
  Object.defineProperty(VirtualCache.prototype, Symbol.toStringTag, { value: 'Cache', configurable: true });


  class CacheStorage {
    constructor() { this.caches = cacheMaps; }
    async open(name) { const key = String(name); if (!this.caches.has(key)) this.caches.set(key, new Map()); return new VirtualCache(key, this.caches.get(key)); }
    async has(name) { return this.caches.has(String(name)); }
    async delete(name) { const key = String(name); const deleted = this.caches.delete(key); if (deleted) persistCacheClear(key); return deleted; }
    async keys() { return [...this.caches.keys()]; }
    async match(request) { for (const name of this.caches.keys()) { const match = await (await this.open(name)).match(request); if (match) return match; } return undefined; }
  }
  Object.defineProperty(CacheStorage.prototype, Symbol.toStringTag, { value: 'CacheStorage', configurable: true });
  const idbVersionChangeEventState = new WeakMap();
  const idbUnsignedLongLongModulo = 2 ** 64;
  function IDBVersionChangeEvent(type, init = {}) {
    if (!new.target) throw new TypeError("Failed to construct 'IDBVersionChangeEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (arguments.length < 1) throw new TypeError("Failed to construct 'IDBVersionChangeEvent': 1 argument required, but only 0 present.");
    const event = Reflect.construct(Event, [idbVersionChangeEventType(type)], new.target);
    idbVersionChangeEventState.set(event, idbVersionChangeEventPayload(init));
    return event;
  }
  Object.setPrototypeOf(IDBVersionChangeEvent, Event);
  IDBVersionChangeEvent.prototype = Object.create(Event.prototype);
  Object.defineProperties(IDBVersionChangeEvent.prototype, {
    oldVersion: { get() { return idbVersionChangeEventValue(this).oldVersion; }, enumerable: true, configurable: true },
    newVersion: { get() { return idbVersionChangeEventValue(this).newVersion; }, enumerable: true, configurable: true },
    dataLoss: { get() { return idbVersionChangeEventValue(this).dataLoss; }, enumerable: true, configurable: true },
    dataLossMessage: { get() { return idbVersionChangeEventValue(this).dataLossMessage; }, enumerable: true, configurable: true },
    constructor: { value: IDBVersionChangeEvent, writable: true, configurable: true },
  });
  Object.defineProperty(IDBVersionChangeEvent.prototype, Symbol.toStringTag, { value: 'IDBVersionChangeEvent', configurable: true });
  Object.defineProperty(IDBVersionChangeEvent, 'prototype', { writable: false });

  function idbVersionChangeEventValue(event) {
    const state = idbVersionChangeEventState.get(event);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function idbVersionChangeEventPayload(init) {
    const source = init === null || init === undefined ? {} : Object(init);
    return {
      oldVersion: idbUnsignedLongLong(source.oldVersion, 'oldVersion', 0),
      newVersion: source.newVersion === null || source.newVersion === undefined ? null : idbUnsignedLongLong(source.newVersion, 'newVersion', 0),
      dataLoss: idbDataLossAmount(source.dataLoss),
      dataLossMessage: '',
    };
  }

  function idbVersionChangeEventType(value) {
    if (typeof value === 'symbol') throw new TypeError("Failed to construct 'IDBVersionChangeEvent': Cannot convert a Symbol value to a string");
    return String(value);
  }

  function idbVersionChangeEventString(value, label) {
    if (typeof value === 'symbol') throw new TypeError(`Failed to construct 'IDBVersionChangeEvent': Failed to read the '${label}' property from 'IDBVersionChangeEventInit': Cannot convert a Symbol value to a string`);
    return String(value);
  }

  function idbDataLossAmount(value) {
    if (value === undefined) return 'none';
    const text = idbVersionChangeEventString(value, 'dataLoss');
    if (text === 'none' || text === 'total') return text;
    throw new TypeError(`Failed to construct 'IDBVersionChangeEvent': Failed to read the 'dataLoss' property from 'IDBVersionChangeEventInit': The provided value '${text}' is not a valid enum value of type IDBDataLossAmount.`);
  }

  function idbUnsignedLongLong(value, label, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'symbol') throw new TypeError(`Failed to construct 'IDBVersionChangeEvent': Failed to read the '${label}' property from 'IDBVersionChangeEventInit': Cannot convert a Symbol value to a number`);
    if (typeof value === 'bigint') throw new TypeError(`Failed to construct 'IDBVersionChangeEvent': Failed to read the '${label}' property from 'IDBVersionChangeEventInit': Cannot convert a BigInt value to a number`);
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    let converted = Math.trunc(number) % idbUnsignedLongLongModulo;
    if (converted < 0) converted += idbUnsignedLongLongModulo;
    return converted;
  }



  class IDBRequest {
    constructor(token) {
      if (token !== idbRequestToken) throw new TypeError("Failed to construct 'IDBRequest': Illegal constructor");
      Object.defineProperties(this, {
        result: { value: undefined, writable: true, configurable: true },
        error: { value: null, writable: true, configurable: true },
        source: { value: null, writable: true, configurable: true },
        transaction: { value: null, writable: true, configurable: true },
        readyState: { value: 'pending', writable: true, configurable: true },
        onsuccess: { value: null, writable: true, configurable: true },
        onerror: { value: null, writable: true, configurable: true },
        listeners: { value: new Map(), configurable: true },
        addEventListener: { value: function addEventListener(type, callback) { const key = String(type); const bucket = this.listeners.get(key) || []; bucket.push(callback); this.listeners.set(key, bucket); }, configurable: true },
        removeEventListener: { value: function removeEventListener(type, callback) { const key = String(type); const bucket = this.listeners.get(key) || []; const index = bucket.indexOf(callback); if (index >= 0) bucket.splice(index, 1); }, configurable: true },
        __dispatch: { value: function __dispatch(type, init = {}) { const event = { type, target: this, currentTarget: this, ...init }; const handler = this['on' + type]; if (typeof handler === 'function') handler.call(this, event); for (const callback of [...(this.listeners.get(type) || [])]) callback.call(this, event); }, configurable: true },
      });
    }
  }

  class IDBOpenDBRequest extends IDBRequest { constructor(token) { if (token !== idbRequestToken) throw new TypeError("Failed to construct 'IDBOpenDBRequest': Illegal constructor"); super(token); Object.defineProperties(this, { onupgradeneeded: { value: null, writable: true, configurable: true }, onblocked: { value: null, writable: true, configurable: true } }); } }
  const domStringListToken = {};
  const domStringListSlots = new WeakMap();
  class DOMStringList {
    constructor(token, values = []) {
      if (token !== domStringListToken) throw new TypeError("Failed to construct 'DOMStringList': Illegal constructor");
      const strings = [...values].map(String);
      domStringListSlots.set(this, strings);
      for (let index = 0; index < strings.length; index += 1) {
        Object.defineProperty(this, index, { get: () => domStringListValues(this)[index], enumerable: true, configurable: true });
      }
    }
    get length() { return domStringListValues(this).length; }
    item(index) { return domStringListValues(this)[Number(index)] ?? null; }
    contains(value) { return domStringListValues(this).includes(String(value)); }
    [Symbol.iterator]() { return domStringListValues(this)[Symbol.iterator](); }
  }
  Object.defineProperties(DOMStringList.prototype, {
    length: { ...Object.getOwnPropertyDescriptor(DOMStringList.prototype, 'length'), enumerable: true },
    item: { ...Object.getOwnPropertyDescriptor(DOMStringList.prototype, 'item'), enumerable: true },
    contains: { ...Object.getOwnPropertyDescriptor(DOMStringList.prototype, 'contains'), enumerable: true },
  });
  Object.defineProperty(DOMStringList.prototype, Symbol.toStringTag, { value: 'DOMStringList', configurable: true });
  Object.defineProperty(DOMStringList.prototype[Symbol.iterator], 'name', { value: 'values', configurable: true });
  function domStringListValues(list) {
    const values = domStringListSlots.get(list);
    if (!values) throw new TypeError('Illegal invocation');
    return values;
  }


  class IDBDatabase {
    constructor(token, record) {
      if (token !== idbInternalToken) throw new TypeError("Failed to construct 'IDBDatabase': Illegal constructor");
      this.__zpRecord = record; Object.defineProperties(this, { name: { value: record.name, configurable: true }, version: { value: record.version, configurable: true }, objectStoreNames: { value: nameList(Object.keys(record.stores)), configurable: true } });
    }
    createObjectStore(name, options = {}) { const key = String(name); if (this.__zpRecord.stores[key]) throw namedError('ConstraintError'); this.__zpRecord.stores[key] = { keyPath: options.keyPath || null, autoIncrement: Boolean(options.autoIncrement), nextKey: 1, records: {}, indexes: {} }; Object.defineProperty(this, 'objectStoreNames', { value: nameList(Object.keys(this.__zpRecord.stores)), configurable: true }); persistIndexedDB(this.__zpRecord.name, this.__zpRecord); return new IDBObjectStore(idbInternalToken, this.__zpRecord, key); }
    deleteObjectStore(name) { delete this.__zpRecord.stores[String(name)]; Object.defineProperty(this, 'objectStoreNames', { value: nameList(Object.keys(this.__zpRecord.stores)), configurable: true }); persistIndexedDB(this.__zpRecord.name, this.__zpRecord); }
    transaction(storeNames, mode = 'readonly') { return new IDBTransaction(idbInternalToken, this.__zpRecord, Array.isArray(storeNames) ? storeNames : [storeNames], mode); }
    close() {}
  }

  class IDBTransaction {
    constructor(token, database, storeNames, mode) {
      if (token !== idbInternalToken) throw new TypeError("Failed to construct 'IDBTransaction': Illegal constructor");
      this.__zpDatabase = database;
      this.__zpPending = 0;
      this.__zpFinished = false;
      this.__zpListeners = new Map();
      Object.defineProperties(this, {
        db: { value: new IDBDatabase(idbInternalToken, database), configurable: true },
        durability: { value: 'default', configurable: true },
        mode: { value: String(mode || 'readonly'), configurable: true, writable: true },
        objectStoreNames: { value: nameList(storeNames.map(String)), configurable: true, writable: true },
        error: { value: null, configurable: true, writable: true },
        oncomplete: { value: null, configurable: true, writable: true },
        onerror: { value: null, configurable: true, writable: true },
        onabort: { value: null, configurable: true, writable: true },
        addEventListener: { value: function addEventListener(type, callback) { const key = String(type); const bucket = this.__zpListeners.get(key) || []; bucket.push(callback); this.__zpListeners.set(key, bucket); }, configurable: true },
        removeEventListener: { value: function removeEventListener(type, callback) { const key = String(type); const bucket = this.__zpListeners.get(key) || []; const index = bucket.indexOf(callback); if (index >= 0) bucket.splice(index, 1); }, configurable: true },
        __zpTrack: { value: function __zpTrack(request) { if (this.__zpFinished) return request; this.__zpPending += 1; request.transaction = this; request.addEventListener('success', () => this.__zpRequestDone()); request.addEventListener('error', () => this.__zpRequestError(request.error)); return request; }, configurable: true },
        __zpHold: { value: function __zpHold() { if (!this.__zpFinished) this.__zpPending += 1; }, configurable: true },
        __zpRequestDone: { value: function __zpRequestDone() { this.__zpPending = Math.max(0, this.__zpPending - 1); this.__zpMaybeComplete(); }, configurable: true },
        __zpRequestError: { value: function __zpRequestError(error) { this.error = error || namedError('UnknownError'); this.__zpDispatch('error'); this.__zpRequestDone(); }, configurable: true },
        __zpMaybeComplete: { value: function __zpMaybeComplete() { if (this.__zpFinished || this.__zpPending > 0) return; Promise.resolve().then(() => { if (!this.__zpFinished && this.__zpPending === 0) { this.__zpFinished = true; this.__zpDispatch('complete'); } }); }, configurable: true },
        __zpDispatch: { value: function __zpDispatch(type) { const event = { type, target: this, currentTarget: this }; const handler = this['on' + type]; if (typeof handler === 'function') handler.call(this, event); for (const callback of [...(this.__zpListeners.get(type) || [])]) callback.call(this, event); }, configurable: true },
      });
      Promise.resolve().then(() => this.__zpMaybeComplete());
    }
    objectStore(name) { const key = String(name); if (!this.__zpDatabase.stores[key]) throw namedError('NotFoundError'); return new IDBObjectStore(idbInternalToken, this.__zpDatabase, key, this); }
    abort() { if (this.__zpFinished) return; this.__zpFinished = true; this.__zpDispatch('abort'); }
    commit() { this.__zpMaybeComplete(); }
  }

  class IDBObjectStore {
    constructor(token, database, name, transaction = null) { if (token !== idbInternalToken) throw new TypeError("Failed to construct 'IDBObjectStore': Illegal constructor"); this.__zpDatabase = database; this.__zpStoreName = String(name); const store = database.stores[this.__zpStoreName]; Object.defineProperties(this, { transaction: { value: transaction, configurable: true }, name: { value: this.__zpStoreName, configurable: true }, keyPath: { value: store.keyPath, configurable: true }, autoIncrement: { value: store.autoIncrement, configurable: true }, indexNames: { value: nameList(Object.keys(store.indexes || {})), configurable: true } }); }
    put(value) { return trackIDBRequest(this.transaction, storeMutation(this.__zpDatabase, this.__zpStoreName, value, arguments[1], false)); }
    add(value) { return trackIDBRequest(this.transaction, storeMutation(this.__zpDatabase, this.__zpStoreName, value, arguments[1], true)); }
    get(key) { return trackIDBRequest(this.transaction, storeLookup(this.__zpDatabase, this.__zpStoreName, key, 'value')); }
    getAll() { return trackIDBRequest(this.transaction, storeLookup(this.__zpDatabase, this.__zpStoreName, arguments[0], 'values')); }
    getKey(query) { return trackIDBRequest(this.transaction, storeLookup(this.__zpDatabase, this.__zpStoreName, query, 'key')); }
    getAllKeys() { return trackIDBRequest(this.transaction, storeLookup(this.__zpDatabase, this.__zpStoreName, arguments[0], 'keys')); }
    getAllRecords() { return trackIDBRequest(this.transaction, storeLookup(this.__zpDatabase, this.__zpStoreName, arguments[0], 'records')); }
    count() { return trackIDBRequest(this.transaction, storeLookup(this.__zpDatabase, this.__zpStoreName, arguments[0], 'count')); }
    openCursor() { return cursorRequest(this, objectStoreCursorEntries(this.__zpDatabase.stores[this.__zpStoreName], arguments[0]), this.transaction, arguments[1]); }
    openKeyCursor() { return cursorRequest(this, objectStoreCursorEntries(this.__zpDatabase.stores[this.__zpStoreName], arguments[0]), this.transaction, arguments[1]); }
    createIndex(name, keyPath, options = {}) { const store = this.__zpDatabase.stores[this.__zpStoreName]; const key = String(name); if (store.indexes?.[key]) throw namedError('ConstraintError'); store.indexes ||= {}; store.indexes[key] = { name: key, keyPath, unique: Boolean(options.unique), multiEntry: Boolean(options.multiEntry) }; validateExistingIndex(store, store.indexes[key]); Object.defineProperty(this, 'indexNames', { value: nameList(Object.keys(store.indexes)), configurable: true }); persistIndexedDB(this.__zpDatabase.name, this.__zpDatabase); return new IDBIndex(idbInternalToken, this.__zpDatabase, this.__zpStoreName, key, this.transaction); }
    deleteIndex(name) { const store = this.__zpDatabase.stores[this.__zpStoreName]; delete store.indexes?.[String(name)]; Object.defineProperty(this, 'indexNames', { value: nameList(Object.keys(store.indexes || {})), configurable: true }); persistIndexedDB(this.__zpDatabase.name, this.__zpDatabase); }
    index(name) { const key = String(name); if (!this.__zpDatabase.stores[this.__zpStoreName].indexes?.[key]) throw namedError('NotFoundError'); return new IDBIndex(idbInternalToken, this.__zpDatabase, this.__zpStoreName, key, this.transaction); }
    delete(key) { const request = new IDBRequest(idbRequestToken); Promise.resolve().then(() => { delete this.__zpDatabase.stores[this.__zpStoreName].records[String(key)]; persistIndexedDB(this.__zpDatabase.name, this.__zpDatabase); queueSuccess(request, undefined); }); return trackIDBRequest(this.transaction, request); }
    clear() { const request = new IDBRequest(idbRequestToken); Promise.resolve().then(() => { this.__zpDatabase.stores[this.__zpStoreName].records = {}; persistIndexedDB(this.__zpDatabase.name, this.__zpDatabase); queueSuccess(request, undefined); }); return trackIDBRequest(this.transaction, request); }
  }

  class IDBIndex {
    constructor(token, database, storeName, name, transaction = null) { if (token !== idbInternalToken) throw new TypeError("Failed to construct 'IDBIndex': Illegal constructor"); const index = database.stores[storeName].indexes[name]; this.__zpDatabase = database; this.__zpStoreName = storeName; this.__zpIndexName = name; Object.defineProperties(this, { transaction: { value: transaction, configurable: true }, name: { value: index.name, configurable: true }, keyPath: { value: index.keyPath, configurable: true }, unique: { value: index.unique, configurable: true }, multiEntry: { value: index.multiEntry, configurable: true }, objectStore: { value: new IDBObjectStore(idbInternalToken, database, storeName, transaction), configurable: true } }); }
    get(query) { return trackIDBRequest(this.transaction, indexLookup(this.__zpDatabase, this.__zpStoreName, this.__zpIndexName, query, 'value')); }
    getAll() { return trackIDBRequest(this.transaction, indexLookup(this.__zpDatabase, this.__zpStoreName, this.__zpIndexName, arguments[0], 'values')); }
    getKey(query) { return trackIDBRequest(this.transaction, indexLookup(this.__zpDatabase, this.__zpStoreName, this.__zpIndexName, query, 'key')); }
    getAllKeys() { return trackIDBRequest(this.transaction, indexLookup(this.__zpDatabase, this.__zpStoreName, this.__zpIndexName, arguments[0], 'keys')); }
    getAllRecords() { return trackIDBRequest(this.transaction, indexLookup(this.__zpDatabase, this.__zpStoreName, this.__zpIndexName, arguments[0], 'records')); }
    count() { return trackIDBRequest(this.transaction, indexLookup(this.__zpDatabase, this.__zpStoreName, this.__zpIndexName, arguments[0], 'count')); }
    openCursor() { const store = this.__zpDatabase.stores[this.__zpStoreName]; return cursorRequest(this, indexCursorEntries(store, store.indexes[this.__zpIndexName], arguments[0]), this.transaction, arguments[1]); }
    openKeyCursor() { const store = this.__zpDatabase.stores[this.__zpStoreName]; return cursorRequest(this, indexCursorEntries(store, store.indexes[this.__zpIndexName], arguments[0]), this.transaction, arguments[1]); }
  }

  class IDBRecord {
    constructor(token, key, primaryKey, value) {
      if (token !== idbInternalToken) throw new TypeError("Failed to construct 'IDBRecord': Illegal constructor");
      Object.defineProperties(this, {
        key: { value: key, configurable: true },
        primaryKey: { value: primaryKey, configurable: true },
        value: { value, configurable: true },
      });
    }
  }

  class IDBKeyRange {
    constructor(token, lower, upper, lowerOpen = false, upperOpen = false) {
      if (token !== idbKeyRangeToken) throw new TypeError("Failed to construct 'IDBKeyRange': Illegal constructor");
      Object.defineProperties(this, {
        lower: { value: lower, configurable: true },
        upper: { value: upper, configurable: true },
        lowerOpen: { value: Boolean(lowerOpen), configurable: true },
        upperOpen: { value: Boolean(upperOpen), configurable: true },
      });
    }
    includes(key) { return keyInRange(key, this); }
    static only(value) { return new IDBKeyRange(idbKeyRangeToken, value, value, false, false); }
    static lowerBound(lower, open = false) { return new IDBKeyRange(idbKeyRangeToken, lower, undefined, open, true); }
    static upperBound(upper, open = false) { return new IDBKeyRange(idbKeyRangeToken, undefined, upper, true, open); }
    static bound(lower, upper, lowerOpen = false, upperOpen = false) { if (compareIDBKey(lower, upper) > 0 || (compareIDBKey(lower, upper) === 0 && (lowerOpen || upperOpen))) throw namedError('DataError'); return new IDBKeyRange(idbKeyRangeToken, lower, upper, lowerOpen, upperOpen); }
  }
  if (globalThis.EventTarget?.prototype) {
    Object.setPrototypeOf(IDBRequest.prototype, globalThis.EventTarget.prototype);
    Object.setPrototypeOf(IDBTransaction.prototype, globalThis.EventTarget.prototype);
  }
  if (globalThis.EventTarget?.prototype) Object.setPrototypeOf(IDBDatabase.prototype, globalThis.EventTarget.prototype);

  function IDBCursor() { throw new TypeError("Failed to construct 'IDBCursor': Illegal constructor"); }
  Object.defineProperty(IDBCursor.prototype, Symbol.toStringTag, { value: 'IDBCursor', configurable: true });

  class IDBCursorWithValue {
    constructor(token, request, source, entries, position, direction) { if (token !== idbCursorToken) throw new TypeError("Failed to construct 'IDBCursorWithValue': Illegal constructor"); const entry = entries[position]; this.__zpRequest = request; this.__zpSource = source; this.__zpEntries = entries; this.__zpPosition = position; Object.defineProperties(this, { source: { value: source, configurable: true }, direction: { value: direction, configurable: true }, key: { value: entry.key, configurable: true }, primaryKey: { value: entry.primaryKey, configurable: true }, value: { value: cloneValue(entry.value, new Map()), configurable: true } }); }
  }
  Object.defineProperty(IDBRequest.prototype, Symbol.toStringTag, { value: 'IDBRequest', configurable: true });
  Object.defineProperty(IDBOpenDBRequest.prototype, Symbol.toStringTag, { value: 'IDBOpenDBRequest', configurable: true });
  Object.defineProperty(IDBDatabase.prototype, Symbol.toStringTag, { value: 'IDBDatabase', configurable: true });
  Object.defineProperty(IDBTransaction.prototype, Symbol.toStringTag, { value: 'IDBTransaction', configurable: true });
  Object.defineProperty(IDBObjectStore.prototype, Symbol.toStringTag, { value: 'IDBObjectStore', configurable: true });
  Object.defineProperty(IDBIndex.prototype, Symbol.toStringTag, { value: 'IDBIndex', configurable: true });
  Object.defineProperty(IDBRecord.prototype, Symbol.toStringTag, { value: 'IDBRecord', configurable: true });
  Object.defineProperty(IDBKeyRange.prototype, Symbol.toStringTag, { value: 'IDBKeyRange', configurable: true });
  Object.defineProperty(IDBCursorWithValue.prototype, Symbol.toStringTag, { value: 'IDBCursorWithValue', configurable: true });
  Object.setPrototypeOf(IDBCursorWithValue.prototype, IDBCursor.prototype);
  Object.defineProperty(IDBCursorWithValue.prototype, 'constructor', { value: IDBCursorWithValue, configurable: true, writable: true });
  Object.defineProperties(IDBRequest.prototype, {
    result: idbReadonlyOwnAccessor('result'),
    error: idbReadonlyOwnAccessor('error'),
    source: idbReadonlyOwnAccessor('source'),
    transaction: idbReadonlyOwnAccessor('transaction'),
    readyState: idbReadonlyOwnAccessor('readyState'),
    onsuccess: idbEventHandlerAccessor('onsuccess'),
    onerror: idbEventHandlerAccessor('onerror'),
  });
  Object.defineProperties(IDBOpenDBRequest.prototype, {
    onblocked: idbEventHandlerAccessor('onblocked'),
    onupgradeneeded: idbEventHandlerAccessor('onupgradeneeded'),
  });
  Object.defineProperties(IDBTransaction.prototype, {
    db: idbReadonlyOwnAccessor('db'),
    durability: idbReadonlyOwnAccessor('durability'),
    mode: idbReadonlyOwnAccessor('mode'),
    objectStoreNames: idbReadonlyOwnAccessor('objectStoreNames'),
    error: idbReadonlyOwnAccessor('error'),
    onabort: idbEventHandlerAccessor('onabort'),
    oncomplete: idbEventHandlerAccessor('oncomplete'),
    onerror: idbEventHandlerAccessor('onerror'),
  });
  Object.defineProperties(IDBDatabase.prototype, {
    name: idbReadonlyOwnAccessor('name'),
    version: idbReadonlyOwnAccessor('version'),
    objectStoreNames: idbReadonlyOwnAccessor('objectStoreNames'),
    onabort: idbEventHandlerAccessor('onabort'),
    onclose: idbEventHandlerAccessor('onclose'),
    onerror: idbEventHandlerAccessor('onerror'),
    onversionchange: idbEventHandlerAccessor('onversionchange'),
  });
  Object.defineProperties(IDBCursor.prototype, {
    source: idbCursorAccessor('source'),
    direction: idbCursorAccessor('direction'),
    key: idbCursorAccessor('key'),
    primaryKey: idbCursorAccessor('primaryKey'),
    request: { get() { return this.__zpRequest || null; }, enumerable: true, configurable: true },
    advance: { value: function advance(count) { cursorContinue(this, Math.max(1, Number(count) || 1)); }, enumerable: true, writable: true, configurable: true },
    continue: { value: { continue() { cursorContinue(this, 1); } }.continue, enumerable: true, writable: true, configurable: true },
    continuePrimaryKey: { value: function continuePrimaryKey(key, primaryKey) { void key; void primaryKey; cursorContinue(this, 1); }, enumerable: true, writable: true, configurable: true },
    update: { value: function update(value) { return cursorStore(this).put(value, this.primaryKey); }, enumerable: true, writable: true, configurable: true },
    delete: { value: { delete() { return cursorStore(this).delete(this.primaryKey); } }.delete, enumerable: true, writable: true, configurable: true },
  });
  Object.defineProperty(IDBCursorWithValue.prototype, 'value', idbCursorAccessor('value'));
  Object.defineProperties(IDBObjectStore.prototype, {
    name: idbMutableOwnAccessor('name'),
    keyPath: idbReadonlyOwnAccessor('keyPath'),
    indexNames: idbReadonlyOwnAccessor('indexNames'),
    transaction: idbReadonlyOwnAccessor('transaction'),
    autoIncrement: idbReadonlyOwnAccessor('autoIncrement'),
  });
  Object.defineProperties(IDBIndex.prototype, {
    name: idbMutableOwnAccessor('name'),
    objectStore: idbReadonlyOwnAccessor('objectStore'),
    keyPath: idbReadonlyOwnAccessor('keyPath'),
    multiEntry: idbReadonlyOwnAccessor('multiEntry'),
    unique: idbReadonlyOwnAccessor('unique'),
  });
  Object.defineProperties(IDBRecord.prototype, {
    key: idbReadonlyOwnAccessor('key'),
    primaryKey: idbReadonlyOwnAccessor('primaryKey'),
    value: idbReadonlyOwnAccessor('value'),
  });
  Object.defineProperties(IDBKeyRange.prototype, {
    lower: idbReadonlyOwnAccessor('lower'),
    upper: idbReadonlyOwnAccessor('upper'),
    lowerOpen: idbReadonlyOwnAccessor('lowerOpen'),
    upperOpen: idbReadonlyOwnAccessor('upperOpen'),
  });


  function installHTMLAudioPrototypeChain() {
    if (globalThis.HTMLElement?.prototype && globalThis.Element?.prototype && globalThis.HTMLElement.prototype !== globalThis.Element.prototype && Object.getPrototypeOf(globalThis.HTMLElement.prototype) !== globalThis.Element.prototype) {
      Object.setPrototypeOf(globalThis.HTMLElement.prototype, globalThis.Element.prototype);
    }
    if (globalThis.HTMLMediaElement?.prototype && globalThis.HTMLElement?.prototype && globalThis.HTMLMediaElement.prototype !== globalThis.HTMLElement.prototype && Object.getPrototypeOf(globalThis.HTMLMediaElement.prototype) !== globalThis.HTMLElement.prototype) {
      Object.setPrototypeOf(globalThis.HTMLMediaElement.prototype, globalThis.HTMLElement.prototype);
    }
    if (globalThis.HTMLAudioElement?.prototype && globalThis.HTMLMediaElement?.prototype && globalThis.HTMLAudioElement.prototype !== globalThis.HTMLMediaElement.prototype && Object.getPrototypeOf(globalThis.HTMLAudioElement.prototype) !== globalThis.HTMLMediaElement.prototype) {
      Object.setPrototypeOf(globalThis.HTMLAudioElement.prototype, globalThis.HTMLMediaElement.prototype);
    }
  }

  function installGlobalPrototypeChains() {
    for (const name of ['WebGLBuffer', 'WebGLFramebuffer', 'WebGLProgram', 'WebGLRenderbuffer', 'WebGLShader', 'WebGLTexture', 'WebGLVertexArrayObject', 'WebGLSampler', 'WebGLQuery', 'WebGLSync', 'WebGLTransformFeedback']) {
      if (globalThis[name]?.prototype && globalThis.WebGLObject?.prototype && Object.getPrototypeOf(globalThis[name].prototype) !== globalThis.WebGLObject.prototype) {
        Object.setPrototypeOf(globalThis[name].prototype, globalThis.WebGLObject.prototype);
      }
    }
    for (const name of ['SharedStorageAppendMethod', 'SharedStorageClearMethod', 'SharedStorageDeleteMethod', 'SharedStorageSetMethod']) {
      if (globalThis[name]?.prototype && globalThis.SharedStorageModifierMethod?.prototype && Object.getPrototypeOf(globalThis[name].prototype) !== globalThis.SharedStorageModifierMethod.prototype) {
        Object.setPrototypeOf(globalThis[name].prototype, globalThis.SharedStorageModifierMethod.prototype);
      }
    }
  }

  function installSchedulerTaskShapes() {
    const eventTargetProto = globalThis.EventTarget?.prototype || Object.prototype;
    if (globalThis.TaskController?.prototype) {
      delete globalThis.TaskController.prototype.abort;
      if (globalThis.AbortController?.prototype && Object.getPrototypeOf(globalThis.TaskController.prototype) !== globalThis.AbortController.prototype) {
        Object.setPrototypeOf(globalThis.TaskController.prototype, globalThis.AbortController.prototype);
      }
    }
    if (globalThis.TaskSignal?.prototype) {
      delete globalThis.TaskSignal.prototype.addEventListener;
      delete globalThis.TaskSignal.prototype.dispatchEvent;
      delete globalThis.TaskSignal.prototype.removeEventListener;
      delete globalThis.TaskSignal.prototype.throwIfAborted;
      const signalProto = globalThis.AbortSignal?.prototype || eventTargetProto;
      if (Object.getPrototypeOf(globalThis.TaskSignal.prototype) !== signalProto) {
        Object.setPrototypeOf(globalThis.TaskSignal.prototype, signalProto);
      }
      Object.defineProperties(globalThis.TaskSignal.prototype, {
        priority: { get() { return this?.__zpPriority || 'user-visible'; }, enumerable: true, configurable: true },
        onprioritychange: idbEventHandlerAccessor('onprioritychange'),
      });
      if (!Object.prototype.hasOwnProperty.call(globalThis.TaskSignal, 'any')) {
        Object.defineProperty(globalThis.TaskSignal, 'any', { value: function any(signals) { return Array.from(signals || [])[0] || Object.create(globalThis.TaskSignal.prototype); }, enumerable: true, writable: true, configurable: true });
      }
    }
    if (globalThis.TaskPriorityChangeEvent?.prototype) {
      if (globalThis.Event?.prototype && Object.getPrototypeOf(globalThis.TaskPriorityChangeEvent.prototype) !== globalThis.Event.prototype) {
        Object.setPrototypeOf(globalThis.TaskPriorityChangeEvent.prototype, globalThis.Event.prototype);
      }
      Object.defineProperty(globalThis.TaskPriorityChangeEvent.prototype, 'previousPriority', { get() { return this?.__zpPreviousPriority || ''; }, enumerable: true, configurable: true });
    }
    if (globalThis.Scheduling?.prototype) {
      Object.defineProperty(globalThis.Scheduling.prototype, 'isInputPending', { value: function isInputPending() { return false; }, enumerable: true, writable: true, configurable: true });
    }
  }

  function installElementReflections() {
    if (!globalThis.Element?.prototype) return;
    const proto = globalThis.Element.prototype;
    installElementCoreReflections(proto);
    installElementFormReflections(proto);
    installElementURLReflections(proto);
    installElementMarkupReflections(proto);
    installElementLayoutReflections(proto);
    installElementTableReflections(proto);
    installElementMediaReflections(proto);
    installElementDialogReflections(proto);
  }

  function installElementCoreReflections(proto) {
    defineElementGetter(proto, 'dataset', function dataset() { return datasetFor(this); });
    defineElementGetter(proto, 'classList', function classList() { return classListFor(this); });
    Object.defineProperty(proto, 'classList', { get: Object.getOwnPropertyDescriptor(proto, 'classList')?.get, set(_) {}, configurable: true });
    defineElementGetter(proto, 'relList', function relList() { return relListFor(this); });
    defineElementGetter(proto, 'style', function style() { return styleFor(this); });
    defineElementGetter(proto, 'attributeStyleMap', function attributeStyleMap() { return stylePropertyMapFor(styleFor(this)); });
    defineElementGetter(proto, 'assignedSlot', function assignedSlot() { return assignedSlotFor(this); });

    if (!Object.getOwnPropertyDescriptor(proto, 'assignedNodes')) Object.defineProperty(proto, 'assignedNodes', { value(options = undefined) { return isSlotElement(this) ? assignedNodesForSlot(this, options) : []; }, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'assignedElements')) Object.defineProperty(proto, 'assignedElements', { value(options = undefined) { return assignedNodesForSlot(this, options).filter((node) => node.nodeType === 1); }, configurable: true });
    defineElementGetter(proto, 'sheet', function sheet() { return isStyleSheetOwner(this) ? styleSheetForElement(this) : null; });

    if (!Object.getOwnPropertyDescriptor(proto, 'assign')) Object.defineProperty(proto, 'assign', { value(...nodes) { if (isSlotElement(this)) assignSlotNodes(this, nodes); }, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'attachInternals')) Object.defineProperty(proto, 'attachInternals', { value() { return elementInternalsFor(this); }, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'attachShadow')) Object.defineProperty(proto, 'attachShadow', { value(init) { return attachShadowRoot(this, init || {}); }, writable: true, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'shadowRoot')) Object.defineProperty(proto, 'shadowRoot', { get() { return this.__zpOpenShadowRoot || null; }, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'requestFullscreen')) Object.defineProperty(proto, 'requestFullscreen', { value() { return requestFullscreenFor(this, arguments[0] || {}); }, writable: true, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'focus')) Object.defineProperty(proto, 'focus', { value() { focusElement(this); }, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'blur')) Object.defineProperty(proto, 'blur', { value() { blurElement(this); }, configurable: true });
    installElementAttrNodeReflections(proto);
    if (!Object.getOwnPropertyDescriptor(proto, Symbol.toStringTag)) Object.defineProperty(proto, Symbol.toStringTag, { get() { return elementToStringTag(this); }, configurable: true });
  }


  function installSVGElementPrototypeAssignment() {
    const proto = globalThis.Document?.prototype;
    const original = proto?.createElementNS;
    if (!original || original.__zpSVGPrototypeWrapped) return;
    const createElementNS = function createElementNS(namespaceURI, qualifiedName) {
      const element = original.call(this, namespaceURI, qualifiedName, arguments[2]);
      assignSVGElementPrototype(element);
      return element;
    };
    Object.defineProperty(createElementNS, '__zpSVGPrototypeWrapped', { value: true });
    Object.defineProperty(proto, 'createElementNS', { value: createElementNS, writable: true, configurable: true });
  }

  function assignSVGElementPrototype(element) {
    if (element?.nodeType !== 1 || element.namespaceURI !== 'http://www.w3.org/2000/svg') return;
    const ctor = globalThis[svgInterfaceNameForTag(element.localName)];
    if (ctor?.prototype && Object.getPrototypeOf(element) !== ctor.prototype) Object.setPrototypeOf(element, ctor.prototype);
  }

  function installSVGElementBaseReflection() {
    const proto = globalThis.SVGElement?.prototype;
    if (!proto || Object.prototype.hasOwnProperty.call(proto, 'blur')) return;
    for (const name of ['attributeStyleMap', 'className', 'dataset', 'ownerSVGElement', 'viewportElement']) {
      Object.defineProperty(proto, name, { get() { return this?.['__zp_' + name] ?? null; }, enumerable: true, configurable: true });
    }
    for (const name of ['autofocus', 'nonce', 'style', 'tabIndex']) {
      Object.defineProperty(proto, name, { get() { return this?.['__zp_' + name] ?? ''; }, set(value) { Object.defineProperty(this, '__zp_' + name, { value, configurable: true, writable: true }); }, enumerable: true, configurable: true });
    }
    for (const name of ['onabort', 'onanimationcancel', 'onanimationend', 'onanimationiteration', 'onanimationstart', 'onauxclick', 'onbeforeinput', 'onbeforematch', 'onbeforetoggle', 'onbeforexrselect', 'onblur', 'oncancel', 'oncanplay', 'oncanplaythrough', 'onchange', 'onclick', 'onclose', 'oncommand', 'oncontentvisibilityautostatechange', 'oncontextlost', 'oncontextmenu', 'oncontextrestored', 'oncopy', 'oncuechange', 'oncut', 'ondblclick', 'ondrag', 'ondragend', 'ondragenter', 'ondragleave', 'ondragover', 'ondragstart', 'ondrop', 'ondurationchange', 'onemptied', 'onended', 'onerror', 'onfocus', 'onformdata', 'ongotpointercapture', 'oninput', 'oninvalid', 'onkeydown', 'onkeypress', 'onkeyup', 'onload', 'onloadeddata', 'onloadedmetadata', 'onloadstart', 'onlostpointercapture', 'onmousedown', 'onmouseenter', 'onmouseleave', 'onmousemove', 'onmouseout', 'onmouseover', 'onmouseup', 'onmousewheel', 'onpaste', 'onpause', 'onplay', 'onplaying', 'onpointercancel', 'onpointerdown', 'onpointerenter', 'onpointerleave', 'onpointermove', 'onpointerout', 'onpointerover', 'onpointerup', 'onprogress', 'onratechange', 'onreset', 'onresize', 'onscroll', 'onscrollend', 'onscrollsnapchange', 'onscrollsnapchanging', 'onsecuritypolicyviolation', 'onseeked', 'onseeking', 'onselect', 'onselectionchange', 'onselectstart', 'onslotchange', 'onstalled', 'onsubmit', 'onsuspend', 'ontimeupdate', 'ontoggle', 'ontransitioncancel', 'ontransitionend', 'ontransitionrun', 'ontransitionstart', 'onvolumechange', 'onwaiting', 'onwebkitanimationend', 'onwebkitanimationiteration', 'onwebkitanimationstart', 'onwebkittransitionend', 'onwheel']) {
      Object.defineProperty(proto, name, { get() { return this?.['__zp_' + name] ?? null; }, set(value) { Object.defineProperty(this, '__zp_' + name, { value: typeof value === 'function' ? value : null, configurable: true, writable: true }); }, enumerable: true, configurable: true });
    }
    Object.defineProperties(proto, {
      blur: { value: function blur() {}, enumerable: true, writable: true, configurable: true },
      focus: { value: function focus() {}, enumerable: true, writable: true, configurable: true },
    });
  }


  function elementInternalsFor(element) {
    if (!element.__zpElementInternals) Object.defineProperty(element, '__zpElementInternals', { value: new ElementInternals(elementInternalsToken, element), configurable: true });
    return element.__zpElementInternals;
  }

  function installElementFormReflections(proto) {
    defineElementProperty(proto, 'name', (element) => element.getAttribute?.('name') || '', (element, value) => element.setAttribute?.('name', String(value)));
    defineElementProperty(proto, 'type', inputType, setInputType);
    defineElementProperty(proto, 'defaultValue', defaultInputValue, setDefaultInputValue);
    defineElementProperty(proto, 'value', elementValue, setElementValue);
    if (!Object.getOwnPropertyDescriptor(proto, 'setPointerCapture')) Object.defineProperty(proto, 'setPointerCapture', { value(pointerId) { setPointerCaptureFor(this, pointerId); }, writable: true, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'releasePointerCapture')) Object.defineProperty(proto, 'releasePointerCapture', { value(pointerId) { releasePointerCaptureFor(this, pointerId); }, writable: true, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'hasPointerCapture')) Object.defineProperty(proto, 'hasPointerCapture', { value(pointerId) { return pointerCaptureSet(this).has(toPointerId(pointerId)); }, writable: true, configurable: true });
    defineElementProperty(proto, 'max', elementMax, setElementMax);
    defineElementProperty(proto, 'min', elementMin, setElementMin);
    defineElementProperty(proto, 'low', elementLow, setElementLow);
    defineElementProperty(proto, 'high', elementHigh, setElementHigh);
    defineElementProperty(proto, 'optimum', elementOptimum, setElementOptimum);
    defineElementProperty(proto, 'position', elementPosition, undefined);
    defineElementProperty(proto, 'dateTime', elementDateTime, setElementDateTime);
    defineElementProperty(proto, 'cite', elementCite, setElementCite);
    defineElementProperty(proto, 'htmlFor', labelHtmlFor, setLabelHtmlFor);
    defineElementProperty(proto, 'control', labelControl, undefined);
    defineElementProperty(proto, 'labels', elementLabels, undefined);
    defineElementProperty(proto, 'defaultChecked', defaultInputChecked, setDefaultInputChecked);
    defineElementProperty(proto, 'checked', inputChecked, setInputChecked);
    defineElementProperty(proto, 'selected', optionSelected, setOptionSelected);
    defineElementProperty(proto, 'defaultSelected', defaultOptionSelected, setDefaultOptionSelected);
    defineElementProperty(proto, 'multiple', (element) => element.hasAttribute?.('multiple') || false, (element, value) => value ? element.setAttribute?.('multiple', '') : element.removeAttribute?.('multiple'));
    defineElementProperty(proto, 'options', (element) => isElement(element, 'select') ? optionsCollection(element) : undefined, undefined);
    defineElementProperty(proto, 'selectedIndex', selectedIndex, setSelectedIndex);

    defineElementProperty(proto, 'required', (element) => element.hasAttribute?.('required') || false, (element, value) => value ? element.setAttribute?.('required', '') : element.removeAttribute?.('required'));
    defineElementProperty(proto, 'disabled', elementDisabledValue, setElementDisabled);
    defineElementProperty(proto, 'media', elementMediaValue, setElementMedia);
    defineElementProperty(proto, 'rel', (element) => relAttributeElement(element) ? (element.getAttribute?.('rel') || '') : '', (element, value) => { if (relAttributeElement(element)) element.setAttribute?.('rel', String(value)); });
    defineElementProperty(proto, 'srcset', (element) => srcsetAttributeElement(element) ? (element.getAttribute?.('srcset') || '') : '', (element, value) => { if (srcsetAttributeElement(element)) element.setAttribute?.('srcset', String(value)); });
    defineElementProperty(proto, 'sizes', (element) => srcsetAttributeElement(element) ? (element.getAttribute?.('sizes') || '') : '', (element, value) => { if (srcsetAttributeElement(element)) element.setAttribute?.('sizes', String(value)); });
    defineElementProperty(proto, 'willValidate', (element) => willValidate(element), undefined);
    defineElementProperty(proto, 'validity', (element) => validityState(element), undefined);
    defineElementProperty(proto, 'validationMessage', (element) => validationMessage(element), undefined);
    if (!proto.checkValidity) proto.checkValidity = function checkValidity() { return runValidityCheck(this, true); };
    if (!proto.reportValidity) proto.reportValidity = function reportValidity() { return runValidityCheck(this, true); };
    if (!proto.setCustomValidity) proto.setCustomValidity = function setCustomValidity(message) { this.__zpCustomValidity = String(message || ''); };
    defineElementProperty(proto, 'files', inputFiles, setInputFiles);
    defineElementProperty(proto, 'form', (element) => formOwner(element), undefined);
    defineElementProperty(proto, 'elements', (element) => (isElement(element, 'form') || isElement(element, 'fieldset')) ? formControlsCollection(element) : undefined, undefined);
  }

  function pointerCaptureSet(element) {
    if (!element.__zpPointerCaptureIds) Object.defineProperty(element, '__zpPointerCaptureIds', { value: new Set(), configurable: true });
    return element.__zpPointerCaptureIds;
  }

  function setPointerCaptureFor(element, pointerId) {
    const id = toPointerId(pointerId);
    pointerCaptureSet(element).add(id);
    dispatchPointerCaptureEvent(element, 'gotpointercapture', id);
  }

  function releasePointerCaptureFor(element, pointerId) {
    const id = toPointerId(pointerId);
    const captures = pointerCaptureSet(element);
    if (!captures.delete(id)) return;
    dispatchPointerCaptureEvent(element, 'lostpointercapture', id);
  }

  function toPointerId(pointerId) {
    return Number(pointerId) || 0;
  }

  function dispatchPointerCaptureEvent(element, type, pointerId) {
    const EventCtor = globalThis.PointerEvent || globalThis.Event;
    element.dispatchEvent(new EventCtor(type, { bubbles: false, cancelable: false, pointerId }));
  }


  function focusElement(element) {
    const doc = element.ownerDocument || globalThis.document;
    const previous = doc?.__zpActiveElement || null;
    if (!doc || previous === element) return;
    if (previous) dispatchFocusEvent(previous, 'blur');
    Object.defineProperty(doc, '__zpActiveElement', { value: element, writable: true, configurable: true });
    dispatchFocusEvent(element, 'focus');
  }

  function blurElement(element) {
    const doc = element.ownerDocument || globalThis.document;
    if (!doc || doc.__zpActiveElement !== element) return;
    Object.defineProperty(doc, '__zpActiveElement', { value: null, writable: true, configurable: true });
    dispatchFocusEvent(element, 'blur');
  }

  function dispatchFocusEvent(element, type) {
    const EventCtor = globalThis.FocusEvent || globalThis.Event;
    element.dispatchEvent?.(new EventCtor(type, { bubbles: false, cancelable: false }));
  }

  function activeElementFor(doc) {
    return doc?.__zpActiveElement || doc?.body || doc?.documentElement || null;
  }

  function activeElementIn(root) {
    const active = activeElementFor(root?.ownerDocument);
    return root?.contains?.(active) ? active : null;
  }
  function requestFullscreenFor(element, options = {}) {
    const doc = element.ownerDocument || globalThis.document;
    setFullscreenElement(doc, element);
    element.__zpFullscreenOptions = { navigationUI: options?.navigationUI || 'auto' };
    dispatchFullscreenEvent(element);
    if (doc && doc !== element) dispatchFullscreenEvent(doc);
    return Promise.resolve();
  }

  function exitFullscreenFor(doc) {
    const element = doc?.__zpFullscreenElement || null;
    if (!element) return Promise.resolve();
    setFullscreenElement(doc, null);
    dispatchFullscreenEvent(element);
    dispatchFullscreenEvent(doc);
    return Promise.resolve();
  }

  function setFullscreenElement(doc, element) {
    if (!doc) return;
    Object.defineProperty(doc, '__zpFullscreenElement', { value: element, configurable: true, writable: true });
  }

  function dispatchFullscreenEvent(target) {
    const EventCtor = globalThis.Event;
    target?.dispatchEvent?.(new EventCtor('fullscreenchange', { bubbles: true }));
  }

  function installElementURLReflections(proto) {
    defineElementProperty(proto, 'href', (element) => isURLAttributeElement(element, 'href') ? resolvedURLAttribute(element, 'href') : undefined, (element, value) => { if (isURLAttributeElement(element, 'href')) element.setAttribute?.('href', String(value)); });
    defineElementProperty(proto, 'src', (element) => isURLAttributeElement(element, 'src') ? resolvedURLAttribute(element, 'src') : undefined, (element, value) => { if (isURLAttributeElement(element, 'src')) element.setAttribute?.('src', String(value)); });
    defineElementProperty(proto, 'origin', (element) => anchorURLPart(element, 'origin'), undefined);
    for (const part of ['protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']) defineElementProperty(proto, part, (element) => anchorURLPart(element, part), (element, value) => setAnchorURLPart(element, part, value));
  }

  function installElementMarkupReflections(proto) {
    if (!Object.getOwnPropertyDescriptor(proto, 'innerHTML')) Object.defineProperty(proto, 'innerHTML', { get() { return serializeChildren(elementMarkupChildren(this)); }, set(value) { replaceElementMarkupChildren(this, String(value || '')); }, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'outerHTML')) Object.defineProperty(proto, 'outerHTML', { get() { return serializeNode(this); }, set(value) { replaceOuterHTML(this, String(value || '')); }, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'setHTMLUnsafe')) Object.defineProperty(proto, 'setHTMLUnsafe', { value(value) { replaceElementMarkupChildren(this, String(value || '')); }, writable: true, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'setHTML')) Object.defineProperty(proto, 'setHTML', { value(value) { replaceElementMarkupChildren(this, String(value || ''), (records) => sanitizeHTMLRecords(records, sanitizerPolicyFromOptions(arguments[1]))); }, writable: true, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'content')) Object.defineProperty(proto, 'content', { get() { return isTemplateElement(this) ? templateContentFor(this) : undefined; }, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'insertAdjacentHTML')) Object.defineProperty(proto, 'insertAdjacentHTML', { value(position, html) { insertAdjacentFragment(this, position, fragmentFromHTML(this, String(html ?? ''))); }, writable: true, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'insertAdjacentElement')) Object.defineProperty(proto, 'insertAdjacentElement', { value(position, element) { if (element?.nodeType !== 1) throw new TypeError("Failed to execute 'insertAdjacentElement' on 'Element': parameter 2 is not of type 'Element'."); return insertAdjacentNode(this, position, element); }, writable: true, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'insertAdjacentText')) Object.defineProperty(proto, 'insertAdjacentText', { value(position, text) { insertAdjacentNode(this, position, this.ownerDocument.createTextNode(String(text ?? ''))); }, writable: true, configurable: true });
  }

  function elementMarkupChildren(element) {
    return isTemplateElement(element) ? templateContentFor(element) : element;
  }

  function replaceElementMarkupChildren(element, html, transformRecords = null) {
    if (!isTemplateElement(element)) {
      replaceChildrenFromHTML(element, html, transformRecords);
      return;
    }
    const content = templateContentFor(element);
    const scratch = element.ownerDocument.createElement('div');
    replaceChildrenFromHTML(scratch, html, transformRecords);
    while (content.firstChild) content.removeChild(content.firstChild);
    while (scratch.firstChild) content.appendChild(scratch.firstChild);
  }

  function templateContentFor(element) {
    let content = templateContentCache.get(element);
    if (!content) {
      content = element.ownerDocument.createDocumentFragment();
      templateContentCache.set(element, content);
      while (element.firstChild) content.appendChild(element.firstChild);
    }
    return content;
  }

  function isTemplateElement(element) {
    return element?.localName === 'template' && element?.namespaceURI === 'http://www.w3.org/1999/xhtml';
  }

  function insertAdjacentFragment(target, position, fragment) {
    const point = adjacentInsertionPoint(target, position);
    while (fragment.firstChild) point.parent.insertBefore(fragment.firstChild, point.before);
  }

  function insertAdjacentNode(target, position, node) {
    const point = adjacentInsertionPoint(target, position);
    point.parent.insertBefore(node, point.before);
    return node;
  }

  function adjacentInsertionPoint(target, position) {
    switch (String(position).toLowerCase()) {
      case 'beforebegin':
        if (!target.parentNode) throw namedError('NoModificationAllowedError');
        return { parent: target.parentNode, before: target };
      case 'afterbegin':
        return { parent: target, before: target.firstChild };
      case 'beforeend':
        return { parent: target, before: null };
      case 'afterend':
        if (!target.parentNode) throw namedError('NoModificationAllowedError');
        return { parent: target.parentNode, before: target.nextSibling };
      default:
        throw namedError('SyntaxError');
    }
  }

  function sanitizeHTMLRecords(records, policy = sanitizerPolicyFromOptions()) {
    const sanitized = [];
    for (const record of records || []) {
      if (!record || record.type !== 'element') {
        if (record?.type !== 'comment' || policy.comments) sanitized.push(record);
        continue;
      }
      const name = lowerName(record.name);
      if (policy.removeElements.has(name) || disallowedElement(name, policy)) continue;
      const children = sanitizeHTMLRecords(record.children, policy);
      if (policy.replaceWithChildrenElements.has(name)) {
        sanitized.push(...children);
        continue;
      }
      sanitized.push({ ...record, attributes: sanitizeHTMLAttributes(record.attributes, policy, name), children });
    }
    return sanitized;
  }

  function sanitizerPolicyFromOptions(options = undefined) {
    const input = sanitizerConfigFromOptions(options);
    return {
      comments: input.comments !== false,
      dataAttributes: input.dataAttributes !== false,
      removeUnsafe: input.removeUnsafe !== false,
      allowElements: nameSet(input.elements),
      hasElementAllowList: Array.isArray(input.elements) && input.elements.length > 0,
      removeElements: nameSet(['script', ...(input.removeElements || [])]),
      replaceWithChildrenElements: nameSet(input.replaceWithChildrenElements),
      allowAttributes: attributePolicy(input.attributes),
      hasAttributeAllowList: Array.isArray(input.attributes) && input.attributes.length > 0,
      removeAttributes: attributePolicy(input.removeAttributes),
    };
  }

  function sanitizerConfigFromOptions(options = undefined) {
    const sanitizer = options?.sanitizer ?? (typeof options?.get === 'function' ? options : undefined);
    if (!sanitizer || sanitizer === 'default') return { removeUnsafe: true };
    return typeof sanitizer.get === 'function' ? sanitizer.get() : sanitizer;
  }

  function disallowedElement(name, policy) {
    return policy.hasElementAllowList && !policy.allowElements.has(name);
  }

  function sanitizeHTMLAttributes(attributes, policy, elementName) {
    return (attributes || []).filter((attr) => attrAllowed(attr, policy, elementName));
  }

  function attrAllowed(attr, policy, elementName) {
    const name = lowerName(attr?.name);
    if (!name) return false;
    if (policy.removeUnsafe && name.startsWith('on')) return false;
    if (!policy.dataAttributes && name.startsWith('data-')) return false;
    if (matchesAttributePolicy(policy.removeAttributes, name, elementName)) return false;
    return !policy.hasAttributeAllowList || matchesAttributePolicy(policy.allowAttributes, name, elementName);
  }

  function nameSet(values = []) {
    return new Set((values || []).map(lowerName).filter(Boolean));
  }

  function attributePolicy(entries = []) {
    const pairs = [];
    for (const entry of entries || []) pairs.push(normalizeAttributePolicyEntry(entry));
    return pairs.filter((entry) => entry[0]);
  }

  function normalizeAttributePolicyEntry(entry) {
    if (Array.isArray(entry)) return [lowerName(entry[0]), lowerName(entry[1] || '*') || '*'];
    if (typeof entry === 'string') return [lowerName(entry), '*'];
    return [lowerName(entry?.name || entry?.attribute), lowerName(entry?.element || '*') || '*'];
  }

  function matchesAttributePolicy(pairs, attributeName, elementName) {
    return pairs.some(([attribute, element]) => matchesPolicyName(attribute, attributeName) && matchesPolicyName(element, elementName));
  }

  function matchesPolicyName(pattern, name) {
    return pattern === '*' || pattern === name || (pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1)));
  }

  function lowerName(value) {
    return String(value || '').toLowerCase();
  }

  function installElementLayoutReflections(proto) {
    defineElementProperty(proto, 'scrollLeft', elementScrollLeft, setElementScrollLeft);
    defineElementProperty(proto, 'scrollTop', elementScrollTop, setElementScrollTop);
    for (const prop of ['clientWidth', 'offsetWidth', 'scrollWidth']) Object.defineProperty(proto, prop, { get() { return this.getBoundingClientRect?.().width || 0; }, configurable: true });
    for (const prop of ['clientHeight', 'offsetHeight', 'scrollHeight']) Object.defineProperty(proto, prop, { get() { return this.getBoundingClientRect?.().height || 0; }, configurable: true });
    proto.scrollTo = function scrollTo(...args) { scrollElementTo(this, scrollToOptions(args)); };
    proto.scroll = function scroll(...args) { scrollElementTo(this, scrollToOptions(args)); };
    proto.scrollBy = function scrollBy(...args) { scrollElementBy(this, scrollDeltaOptions(args)); };
    if (!Object.getOwnPropertyDescriptor(proto, 'scrollIntoView')) Object.defineProperty(proto, 'scrollIntoView', { value() { scrollIntoViewFor(this, arguments.length ? arguments[0] : true); }, writable: true, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'getBoxQuads')) Object.defineProperty(proto, 'getBoxQuads', { value(options = {}) { return boxQuadsFor(this, options); }, configurable: true });
  }


  function elementScrollLeft(element) {
    return Number(element.__zpScrollLeft || 0);
  }

  function elementScrollTop(element) {
    return Number(element.__zpScrollTop || 0);
  }

  function setElementScrollLeft(element, value) {
    scrollElementTo(element, { left: value });
  }

  function setElementScrollTop(element, value) {
    scrollElementTo(element, { top: value });
  }

  function scrollToOptions(args) {
    const first = args[0];
    if (first && typeof first === 'object') return { left: first.left, top: first.top };
    return { left: args.length > 0 ? first : 0, top: args.length > 1 ? args[1] : 0 };
  }

  function scrollDeltaOptions(args) {
    const first = args[0];
    if (first && typeof first === 'object') return { left: first.left ?? 0, top: first.top ?? 0 };
    return { left: args.length > 0 ? first : 0, top: args.length > 1 ? args[1] : 0 };
  }

  function scrollElementBy(element, options) {
    scrollElementTo(element, { left: elementScrollLeft(element) + scrollDeltaValue(options.left), top: elementScrollTop(element) + scrollDeltaValue(options.top) });
  }

  function scrollDeltaValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function scrollElementTo(element, options) {
    const nextLeft = options.left === undefined ? elementScrollLeft(element) : scrollValue(options.left);
    const nextTop = options.top === undefined ? elementScrollTop(element) : scrollValue(options.top);
    const changed = nextLeft !== elementScrollLeft(element) || nextTop !== elementScrollTop(element);
    Object.defineProperty(element, '__zpScrollLeft', { value: nextLeft, writable: true, configurable: true });
    Object.defineProperty(element, '__zpScrollTop', { value: nextTop, writable: true, configurable: true });
    if (changed) element.dispatchEvent?.(new Event('scroll'));
  }

  function scrollValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : 0;
  }

  function scrollIntoViewFor(element, options = true) {
    const rect = element.getBoundingClientRect?.() || new DOMRect(0, 0, 0, 0);
    const align = scrollIntoViewAlignment(options);
    const left = alignedScrollOffset(globalThis.scrollX || 0, rect.x, rect.width, globalThis.innerWidth || 0, align.inline);
    const top = alignedScrollOffset(globalThis.scrollY || 0, rect.y, rect.height, globalThis.innerHeight || 0, align.block);
    globalThis.scrollTo?.(left, top);
  }

  function scrollIntoViewAlignment(options) {
    if (options === false) return { block: 'end', inline: 'nearest' };
    if (!options || options === true) return { block: 'start', inline: 'nearest' };
    return { block: scrollAlignment(options.block, 'start'), inline: scrollAlignment(options.inline, 'nearest') };
  }

  function scrollAlignment(value, fallback) {
    return ['start', 'center', 'end', 'nearest'].includes(value) ? value : fallback;
  }

  function alignedScrollOffset(current, start, size, viewportSize, alignment) {
    if (alignment === 'center') return current + start - Math.max(0, (viewportSize - size) / 2);
    if (alignment === 'end') return current + start + size - viewportSize;
    if (alignment === 'nearest' && start >= 0 && start + size <= viewportSize) return current;
    if (alignment === 'nearest' && Math.abs(start) > Math.abs(start + size - viewportSize)) return current + start + size - viewportSize;
    return current + start;
  }

  function boxQuadsFor(element, options = {}) {
    const rect = relativeRect(element.getBoundingClientRect?.() || new DOMRect(0, 0, 0, 0), options?.relativeTo);
    return [DOMQuad.fromRect(rect)];
  }

  function relativeRect(rect, relativeTo) {
    const relative = relativeTo?.getBoundingClientRect?.();
    if (!relative) return rect;
    return { x: rect.x - relative.x, y: rect.y - relative.y, width: rect.width, height: rect.height };
  }
  function installElementTableReflections(proto) {
    installTableMethods(proto);
    installTableGetters(proto);
  }

  function installTableMethods(proto) {
    proto.createCaption = function createCaption() { return tableDirectChild(this, 'caption', true); };
    proto.deleteCaption = function deleteCaption() { removeTableDirectChild(this, 'caption'); };
    proto.createTHead = function createTHead() { return tableDirectChild(this, 'thead', true); };
    proto.deleteTHead = function deleteTHead() { removeTableDirectChild(this, 'thead'); };
    proto.createTBody = function createTBody() { return createTableBody(this); };
    proto.createTFoot = function createTFoot() { return tableDirectChild(this, 'tfoot', true); };
    proto.deleteTFoot = function deleteTFoot() { removeTableDirectChild(this, 'tfoot'); };
    proto.insertRow = function insertRow(index = -1) { return insertTableRow(this, index); };
    proto.deleteRow = function deleteRow(index) { deleteTableRow(this, index); };
    proto.insertCell = function insertCell(index = -1) { return insertTableCell(this, index); };
    proto.deleteCell = function deleteCell(index) { deleteTableCell(this, index); };
  }

  function installTableGetters(proto) {
    defineTableGetter(proto, 'caption', function caption() { return tableDirectChild(this, 'caption', false); });
    defineTableGetter(proto, 'tHead', function tHead() { return tableDirectChild(this, 'thead', false); });
    defineTableGetter(proto, 'tFoot', function tFoot() { return tableDirectChild(this, 'tfoot', false); });
    defineTableGetter(proto, 'tBodies', function tBodies() { return liveArray(tableBodies(this)); });
    defineTableGetter(proto, 'rows', function rows() { return liveArray(tableRows(this)); });
    defineTableGetter(proto, 'cells', function cells() { return liveArray(rowCells(this)); });
    defineTableGetter(proto, 'rowIndex', function rowIndex() { return tableRowIndex(this); });
    defineTableGetter(proto, 'sectionRowIndex', function sectionRowIndexGetter() { return sectionRowIndex(this); });
    defineTableGetter(proto, 'cellIndex', function cellIndex() { return tableCellIndex(this); });
  }

  function defineTableGetter(proto, name, get) {
    if (!Object.getOwnPropertyDescriptor(proto, name)) Object.defineProperty(proto, name, { get, configurable: true });
  }

  const videoPlaybackQualityToken = {};
  class VideoPlaybackQuality {
    constructor(token, init = {}) {
      if (token !== videoPlaybackQualityToken) throw new TypeError("Failed to construct 'VideoPlaybackQuality': Illegal constructor");
      this.creationTime = Number(init.creationTime || 0);
      this.totalVideoFrames = Number(init.totalVideoFrames || 0);
      this.droppedVideoFrames = Number(init.droppedVideoFrames || 0);
      this.corruptedVideoFrames = Number(init.corruptedVideoFrames || 0);
    }
  }
  Object.defineProperty(VideoPlaybackQuality.prototype, Symbol.toStringTag, { value: 'VideoPlaybackQuality', configurable: true });

  function makeVideoPlaybackQuality() {
    return new VideoPlaybackQuality(videoPlaybackQualityToken, { creationTime: globalThis.performance?.now?.() || 0 });
  }

  function installElementMediaReflections(proto) {
    defineElementGetter(proto, 'remote', function remote() {
      return isMediaElement(this) ? remotePlaybackFor(this) : undefined;
    });
    defineElementProperty(
      proto,
      'disablePictureInPicture',
      (element) => isElement(element, 'video') && Boolean(element.hasAttribute?.('disablepictureinpicture')),
      (element, value) => {
        if (!isElement(element, 'video')) return;
        if (value) element.setAttribute?.('disablepictureinpicture', '');
        else element.removeAttribute?.('disablepictureinpicture');
      },
    );
    if (!Object.getOwnPropertyDescriptor(proto, 'requestPictureInPicture')) {
      Object.defineProperty(proto, 'requestPictureInPicture', {
        value() {
          if (!isElement(this, 'video')) return Promise.reject(new TypeError("Failed to execute 'requestPictureInPicture': receiver is not a video element."));
          return Promise.reject(namedError('NotAllowedError'));
        },
        configurable: true,
      });
    }
    if (!Object.getOwnPropertyDescriptor(proto, 'getVideoPlaybackQuality')) {
      Object.defineProperty(proto, 'getVideoPlaybackQuality', {
        value() {
          if (!isElement(this, 'video')) throw new TypeError("Failed to execute 'getVideoPlaybackQuality': receiver is not a video element.");
          return makeVideoPlaybackQuality();
        },
        configurable: true,
      });
    }
  }

  function installElementDialogReflections(proto) {
    defineElementProperty(
      proto,
      'open',
      (element) => isOpenAttributeElement(element) ? Boolean(element.hasAttribute?.('open')) : undefined,
      (element, value) => {
        if (!isOpenAttributeElement(element)) return;
        if (value) element.setAttribute?.('open', '');
        else element.removeAttribute?.('open');
      },
    );
    defineElementProperty(
      proto,
      'returnValue',
      (element) => isElement(element, 'dialog') ? String(element.__zpDialogReturnValue || '') : undefined,
      (element, value) => {
        if (isElement(element, 'dialog')) setDialogReturnValue(element, value);
      },
    );
    if (!Object.getOwnPropertyDescriptor(proto, 'show')) Object.defineProperty(proto, 'show', { value() { requireDialogElement(this, 'show'); this.open = true; }, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'showModal')) Object.defineProperty(proto, 'showModal', { value() { requireDialogElement(this, 'showModal'); this.open = true; Object.defineProperty(this, '__zpDialogModal', { value: true, configurable: true, writable: true }); }, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'close')) Object.defineProperty(proto, 'close', { value(returnValue = '') { requireDialogElement(this, 'close'); setDialogReturnValue(this, returnValue); this.open = false; this.dispatchEvent?.(new Event('close')); }, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'requestClose')) {
      Object.defineProperty(proto, 'requestClose', {
        value(returnValue = '') {
          requireDialogElement(this, 'requestClose');
          const event = new Event('cancel', { cancelable: true });
          if (this.dispatchEvent?.(event) !== false) this.close(returnValue);
        },
        configurable: true,
      });
    }
  }

  function requireDialogElement(element, method) {
    if (!isElement(element, 'dialog')) throw new TypeError("Failed to execute '" + method + "' on 'HTMLDialogElement': The element is not a dialog.");
  }

  function setDialogReturnValue(element, value) {
    Object.defineProperty(element, '__zpDialogReturnValue', { value: String(value), configurable: true, writable: true });
  }

  function isOpenAttributeElement(element) {
    return isElement(element, 'details') || isElement(element, 'dialog');
  }

  function isMediaElement(element) {
    return isElement(element, 'audio') || isElement(element, 'video');
  }

  function remotePlaybackFor(element) {
    let remote = remotePlaybackCache.get(element);
    if (!remote) {
      remote = new VirtualRemotePlayback(element);
      remotePlaybackCache.set(element, remote);
    }
    return remote;
  }

  function RemotePlayback() { throw new TypeError("Failed to construct 'RemotePlayback': Illegal constructor"); }
  Object.defineProperty(RemotePlayback, Symbol.hasInstance, { value: (value) => Boolean(value?.__zpRemotePlayback), configurable: true });

  const mediaErrorState = new WeakMap();
  function MediaError() {
    if (new.target) throw new TypeError("Failed to construct 'MediaError': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  delete MediaError.prototype.constructor;
  Object.defineProperties(MediaError.prototype, {
    code: { get() { return mediaErrorValue(this).code; }, enumerable: true, configurable: true },
    message: { get() { return mediaErrorValue(this).message; }, enumerable: true, configurable: true },
    constructor: { value: MediaError, writable: true, configurable: true },
  });
  defineMediaErrorConstant(MediaError, 'MEDIA_ERR_ABORTED', 1);
  defineMediaErrorConstant(MediaError, 'MEDIA_ERR_NETWORK', 2);
  defineMediaErrorConstant(MediaError, 'MEDIA_ERR_DECODE', 3);
  defineMediaErrorConstant(MediaError, 'MEDIA_ERR_SRC_NOT_SUPPORTED', 4);
  defineMediaErrorConstant(MediaError.prototype, 'MEDIA_ERR_ABORTED', 1);
  defineMediaErrorConstant(MediaError.prototype, 'MEDIA_ERR_NETWORK', 2);
  defineMediaErrorConstant(MediaError.prototype, 'MEDIA_ERR_DECODE', 3);
  defineMediaErrorConstant(MediaError.prototype, 'MEDIA_ERR_SRC_NOT_SUPPORTED', 4);
  movePrototypeConstructorToTail(MediaError);
  Object.defineProperty(MediaError.prototype, Symbol.toStringTag, { value: 'MediaError', configurable: true });
  Object.defineProperty(MediaError, 'prototype', { writable: false });

  function mediaErrorValue(value) {
    const state = mediaErrorState.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function defineMediaErrorConstant(owner, name, value) {
    Object.defineProperty(owner, name, { value, enumerable: true });
  }

  function movePrototypeConstructorToTail(Ctor) {
    const descriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, 'constructor');
    delete Ctor.prototype.constructor;
    Object.defineProperty(Ctor.prototype, 'constructor', descriptor);
  }

  function MediaDeviceInfo() {
    throw new TypeError('Illegal constructor');
  }
  Object.defineProperty(MediaDeviceInfo.prototype, Symbol.toStringTag, { value: 'MediaDeviceInfo', configurable: true });

  function InputDeviceInfo() {
    if (new.target) throw new TypeError("Failed to construct 'InputDeviceInfo': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  Object.setPrototypeOf(InputDeviceInfo.prototype, MediaDeviceInfo.prototype);
  delete InputDeviceInfo.prototype.constructor;
  Object.defineProperties(InputDeviceInfo.prototype, {
    getCapabilities: { value: function getCapabilities() { return Object.freeze({}); }, enumerable: true, writable: true, configurable: true },
    constructor: { value: InputDeviceInfo, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(InputDeviceInfo.prototype, Symbol.toStringTag, { value: 'InputDeviceInfo', configurable: true });

  const chapterInformationState = new WeakMap();
  function ChapterInformation() {
    if (new.target) throw new TypeError("Failed to construct 'ChapterInformation': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  delete ChapterInformation.prototype.constructor;
  Object.defineProperties(ChapterInformation.prototype, {
    title: { get() { return chapterInformationValue(this).title; }, enumerable: true, configurable: true },
    startTime: { get() { return chapterInformationValue(this).startTime; }, enumerable: true, configurable: true },
    artwork: { get() { return Object.freeze(chapterInformationValue(this).artwork.slice()); }, enumerable: true, configurable: true },
    constructor: { value: ChapterInformation, writable: true, configurable: true },
  });
  Object.defineProperty(ChapterInformation.prototype, Symbol.toStringTag, { value: 'ChapterInformation', configurable: true });
  Object.defineProperty(ChapterInformation, 'prototype', { writable: false });

  function chapterInformationValue(value) {
    const state = chapterInformationState.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function CropTarget() { throw new TypeError("Failed to construct 'CropTarget': Illegal constructor"); }
  CropTarget.fromElement = function fromElement(element) { void element; return Promise.reject(namedError('InvalidStateError')); };
  Object.defineProperty(CropTarget.prototype, Symbol.toStringTag, { value: 'CropTarget', configurable: true });

  function RestrictionTarget() { throw new TypeError("Failed to construct 'RestrictionTarget': Illegal constructor"); }
  RestrictionTarget.fromElement = function fromElement(element) { void element; return Promise.reject(namedError('InvalidStateError')); };
  Object.defineProperty(RestrictionTarget.prototype, Symbol.toStringTag, { value: 'RestrictionTarget', configurable: true });

  function DelegatedInkTrailPresenter() { throw new TypeError("Failed to construct 'DelegatedInkTrailPresenter': Illegal constructor"); }
  Object.defineProperty(DelegatedInkTrailPresenter.prototype, 'presentationArea', { get() { return null; }, configurable: true });
  DelegatedInkTrailPresenter.prototype.updateInkTrailStartPoint = function updateInkTrailStartPoint(point, style) { void point; void style; return undefined; };
  Object.defineProperty(DelegatedInkTrailPresenter.prototype, Symbol.toStringTag, { value: 'DelegatedInkTrailPresenter', configurable: true });

  class VirtualRemotePlayback extends EventTarget {
    constructor(element) {
      super();
      this.__zpRemotePlayback = true;
      this.__zpElement = element;
      this.state = 'disconnected';
      this.__zpNextWatchId = 1;
      this.__zpWatchers = new Map();
    }
    watchAvailability(callback) {
      if (typeof callback !== 'function') throw new TypeError("Failed to execute 'watchAvailability' on 'RemotePlayback': parameter 1 is not a function.");
      const id = this.__zpNextWatchId++;
      this.__zpWatchers.set(id, callback);
      Promise.resolve().then(() => {
        if (this.__zpWatchers.has(id)) callback(false);
      });
      return Promise.resolve(id);
    }
    cancelWatchAvailability(id = undefined) {
      if (id === undefined) this.__zpWatchers.clear();
      else this.__zpWatchers.delete(Number(id));
      return Promise.resolve();
    }
    prompt() { return Promise.reject(namedError('NotAllowedError')); }
  }
  Object.defineProperty(VirtualRemotePlayback.prototype, Symbol.toStringTag, { value: 'RemotePlayback', configurable: true });

  const viewTransitionToken = {};
  const viewTransitionTypeSetToken = {};
  class ViewTransition {
    constructor(token, init = {}) {
      if (token !== viewTransitionToken) throw new TypeError("Failed to construct 'ViewTransition': Illegal constructor");
      Object.defineProperty(this, '__zpUpdateCallbackDone', { value: init.updateCallbackDone || Promise.resolve(), configurable: true });
      Object.defineProperty(this, '__zpReady', { value: init.ready || Promise.resolve(), configurable: true });
      Object.defineProperty(this, '__zpFinished', { value: init.finished || Promise.resolve(), configurable: true });
      Object.defineProperty(this, '__zpTypes', { value: new ViewTransitionTypeSet(viewTransitionTypeSetToken, init.types || []), configurable: true });
    }
    get updateCallbackDone() { return this.__zpUpdateCallbackDone; }
    get ready() { return this.__zpReady; }
    get finished() { return this.__zpFinished; }
    get types() { return this.__zpTypes; }
    skipTransition() {}
  }
  Object.defineProperty(ViewTransition.prototype, Symbol.toStringTag, { value: 'ViewTransition', configurable: true });

  class ViewTransitionTypeSet {
    constructor(token, values = []) {
      if (token !== viewTransitionTypeSetToken) throw new TypeError("Failed to construct 'ViewTransitionTypeSet': Illegal constructor");
      Object.defineProperty(this, '__zpValues', { value: new Set(Array.from(values, (value) => String(value))), configurable: true });
    }
    get size() { return this.__zpValues.size; }
    add(value) { this.__zpValues.add(String(value)); return this; }
    clear() { this.__zpValues.clear(); }
    delete(value) { return this.__zpValues.delete(String(value)); }
    has(value) { return this.__zpValues.has(String(value)); }
    entries() { return this.__zpValues.entries(); }
    keys() { return this.__zpValues.keys(); }
    values() { return this.__zpValues.values(); }
    forEach(callback, thisArg = undefined) { this.__zpValues.forEach((value) => callback.call(thisArg, value, value, this)); }
    [Symbol.iterator]() { return this.values(); }
  }
  Object.defineProperty(ViewTransitionTypeSet.prototype, Symbol.toStringTag, { value: 'ViewTransitionTypeSet', configurable: true });

  function startViewTransition(update = undefined) {
    const callback = typeof update === 'function' ? update : update?.update;
    const types = typeof update === 'object' && update ? update.types || [] : [];
    const updateCallbackDone = Promise.resolve().then(() => typeof callback === 'function' ? callback() : undefined);
    const ready = updateCallbackDone.then(() => undefined);
    const finished = ready.then(() => undefined);
    return new ViewTransition(viewTransitionToken, { updateCallbackDone, ready, finished, types });
  }

  function installDocumentHelpers() {
    if (!globalThis.Document?.prototype) return;
    const proto = globalThis.Document.prototype;
    proto.createDocumentFragment = function createDocumentFragment() { return new DocumentFragment(this); };
    proto.createRange = function createRange() { return new Range(); };
    proto.createEvent = function createEvent(type) { return createLegacyDocumentEvent(type); };
    if (!Object.getOwnPropertyDescriptor(proto, 'styleSheets')) Object.defineProperty(proto, 'styleSheets', { get() { return styleSheetListForRoot(this); }, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'adoptedStyleSheets')) Object.defineProperty(proto, 'adoptedStyleSheets', { get() { return adoptedStyleSheetsFor(this); }, set(value) { setAdoptedStyleSheets(this, value); }, configurable: true });
    proto.getSelection = function getSelection() { return globalThis.getSelection(); };
    proto.createTreeWalker = function createTreeWalker(root, whatToShow = 0xffffffff, filter = null) { return new TreeWalker(treeWalkerToken, root, whatToShow, filter); };
    proto.createNodeIterator = function createNodeIterator(root, whatToShow = 0xffffffff, filter = null) { return new NodeIterator(nodeIteratorToken, root, whatToShow, filter); };
    proto.createExpression = function createExpression(expression, resolver = null) { return new XPathEvaluator().createExpression(expression, resolver); };
    proto.createNSResolver = function createNSResolver(nodeResolver) { return new XPathEvaluator().createNSResolver(nodeResolver); };
    proto.evaluate = function evaluate(expression, contextNode, resolver = null, type = 0, result = null) { return new XPathEvaluator().evaluate(expression, contextNode, resolver, type, result); };
    proto.elementFromPoint = function elementFromPoint(x, y) { return elementAtPoint(this, x, y); };
    proto.elementsFromPoint = function elementsFromPoint(x, y) { return elementsAtPoint(this, x, y); };
    proto.caretPositionFromPoint = function caretPositionFromPoint(x, y) {
      const element = elementAtPoint(this, x, y);
      return element ? globalThis.CaretPosition?.__zpCreate(element, 0) || null : null;
    };
    proto.caretRangeFromPoint = function caretRangeFromPoint() {
      const element = elementAtPoint(this, arguments[0], arguments[1]);
      if (!element) return null;
      const range = this.createRange();
      range.setStart(element, 0);
      range.collapse(true);
      return range;
    };

  function createLegacyDocumentEvent(type) {
    const key = String(type || '').toLowerCase();
    if (key === 'textevent') return createTextEventInstance();
    const ctor = legacyEventConstructor(key);
    if (!ctor) throw namedError('NotSupportedError');
    return new ctor('');
  }

  function createTextEventInstance() {
    if (typeof createTextEventInstanceImpl === 'function') return createTextEventInstanceImpl();
    const event = new globalThis.UIEvent('');
    Object.setPrototypeOf(event, globalThis.TextEvent.prototype);
    return event;
  }

  function legacyEventConstructor(key) {
    if (key === 'event' || key === 'events' || key === 'htmlevents') return globalThis.Event;
    if (key === 'customevent') return globalThis.CustomEvent;
    if (key === 'uievent' || key === 'uievents') return globalThis.UIEvent;
    if (key === 'mouseevent' || key === 'mouseevents') return globalThis.MouseEvent;
    if (key === 'keyboardevent' || key === 'keyboardevents') return globalThis.KeyboardEvent;
    return null;
  }
    if (!Object.getOwnPropertyDescriptor(globalThis.Document, 'parseHTMLUnsafe')) Object.defineProperty(globalThis.Document, 'parseHTMLUnsafe', { value: function parseHTMLUnsafe(html) { return new DOMParser().parseFromString(String(html || ''), 'text/html'); }, writable: true, configurable: true });
    if (!Object.getOwnPropertyDescriptor(globalThis.Document, 'parseHTML')) Object.defineProperty(globalThis.Document, 'parseHTML', { value: function parseHTML(html) { return sanitizeDocument(new DOMParser().parseFromString(String(html || ''), 'text/html'), arguments[1]); }, writable: true, configurable: true });
    proto.write = function write() { if (this.body) appendHTML(this.body, String(arguments[0] || '')); };
    if (!Object.getOwnPropertyDescriptor(proto, 'pictureInPictureEnabled')) Object.defineProperty(proto, 'pictureInPictureEnabled', { get: () => false, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'pictureInPictureElement')) Object.defineProperty(proto, 'pictureInPictureElement', { get: () => null, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'all')) Object.defineProperty(proto, 'all', { get() { return makeHTMLAllCollection(this); }, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'activeElement')) Object.defineProperty(proto, 'activeElement', { get() { return activeElementFor(this); }, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'hasFocus')) Object.defineProperty(proto, 'hasFocus', { value() { return Boolean(this.__zpActiveElement); }, writable: true, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'exitPictureInPicture')) Object.defineProperty(proto, 'exitPictureInPicture', { value: () => Promise.reject(namedError('InvalidStateError')), writable: true, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'fullscreenElement')) Object.defineProperty(proto, 'fullscreenElement', { get() { return this.__zpFullscreenElement || null; }, set(_) {}, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'fullscreenEnabled')) Object.defineProperty(proto, 'fullscreenEnabled', { get() { return true; }, set(_) {}, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'exitFullscreen')) Object.defineProperty(proto, 'exitFullscreen', { value() { return exitFullscreenFor(this); }, writable: true, configurable: true });
    if (!Object.getOwnPropertyDescriptor(proto, 'startViewTransition')) Object.defineProperty(proto, 'startViewTransition', { value: startViewTransition, writable: true, configurable: true });
    installDocumentImplementation(proto);
  }
  function HTMLAllCollection() { throw new TypeError("Failed to construct 'HTMLAllCollection': Illegal constructor"); }
  Object.defineProperty(HTMLAllCollection, Symbol.hasInstance, { value: (value) => Boolean(value?.__zpHTMLAllCollection), configurable: true });
  Object.defineProperty(HTMLAllCollection.prototype, Symbol.toStringTag, { value: 'HTMLAllCollection', configurable: true });

  function makeHTMLAllCollection(doc) {
    const collection = Object.create(HTMLAllCollection.prototype);
    Object.defineProperty(collection, '__zpHTMLAllCollection', { value: true, configurable: true });
    Object.defineProperty(collection, 'length', { get() { return allDocumentElements(doc).length; }, configurable: true });
    collection.item = (nameOrIndex = undefined) => htmlAllItem(doc, nameOrIndex);
    collection.namedItem = (name = '') => htmlAllNamedItem(doc, name);
    collection[Symbol.iterator] = function* iterator() { yield* allDocumentElements(doc); };
    return collection;
  }

  function allDocumentElements(doc) {
    return Array.from(doc?.getElementsByTagName?.('*') || []);
  }

  function htmlAllItem(doc, nameOrIndex) {
    if (nameOrIndex === undefined) return null;
    const index = Number(nameOrIndex);
    if (Number.isInteger(index) && String(nameOrIndex).trim() !== '') return allDocumentElements(doc)[index] || null;
    return htmlAllNamedItem(doc, nameOrIndex);
  }

  function htmlAllNamedItem(doc, name) {
    const key = String(name);
    return allDocumentElements(doc).find((element) => element.id === key || element.getAttribute?.('name') === key) || null;
  }

  function sanitizeDocument(doc, options = undefined) {
    const policy = sanitizerPolicyFromOptions(options);
    sanitizeNodeChildren(doc.head, policy);
    sanitizeNodeChildren(doc.body, policy);
    return doc;
  }

  function sanitizeNodeChildren(parent, policy) {
    if (!parent?.childNodes) return;
    for (const child of [...parent.childNodes]) sanitizeChildNode(parent, child, policy);
  }

  function sanitizeChildNode(parent, child, policy) {
    if (child.nodeType === 8 && !policy.comments) {
      parent.removeChild(child);
      return;
    }
    if (child.nodeType !== 1) return;
    const name = lowerName(child.localName);
    if (policy.removeElements.has(name) || disallowedElement(name, policy)) {
      parent.removeChild(child);
      return;
    }
    sanitizeNodeAttributes(child, policy, name);
    sanitizeNodeChildren(child, policy);
    if (policy.replaceWithChildrenElements.has(name)) replaceElementWithChildren(parent, child);
  }

  function sanitizeNodeAttributes(element, policy, elementName) {
    for (const attr of [...(element.attributes || [])]) if (!attrAllowed(attr, policy, elementName)) element.removeAttribute(attr.name);
  }

  function replaceElementWithChildren(parent, element) {
    while (element.firstChild) parent.insertBefore(element.firstChild, element);
    parent.removeChild(element);
  }

  function elementAtPoint(doc, x, y) {
    if (!pointInsideViewport(x, y)) return null;
    const elements = allDocumentElements(doc);
    return elements[elements.length - 1] || doc?.documentElement || null;
  }

  function elementsAtPoint(doc, x, y) {
    const element = elementAtPoint(doc, x, y);
    if (!element) return liveArray([]);
    const stack = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) stack.push(node);
    return liveArray(stack);
  }

  function pointInsideViewport(x, y) {
    const px = Number(x);
    const py = Number(y);
    return Number.isFinite(px) && Number.isFinite(py) && px >= 0 && py >= 0 && px < Number(globalThis.innerWidth || 0) && py < Number(globalThis.innerHeight || 0);
  }


  class DocumentFragment extends Node {
    constructor(ownerDocument = globalThis.document || null) {
      super(11, '#document-fragment', ownerDocument);
      Object.defineProperty(this, Symbol.toStringTag, { value: 'DocumentFragment', configurable: true });
    }
    get children() { return liveArray(Array.from(this.childNodes || []).filter((node) => node.nodeType === 1)); }
    get firstElementChild() { return this.children.item(0); }
    get lastElementChild() { const children = this.children; return children.item(children.length - 1); }
    get childElementCount() { return this.children.length; }
    getElementById(id) { return fragmentElementDescendants(this).find((node) => node.id === String(id)) || null; }
    querySelector(selector) { return this.querySelectorAll(selector).item(0); }
    querySelectorAll(selector) { const query = String(selector); return liveArray(fragmentElementDescendants(this).filter((node) => node.matches?.(query))); }
    append(...values) { for (const node of values.map((value) => fragmentNode(value, this.ownerDocument))) this.appendChild(node); }
    prepend(...values) {
      const before = this.firstChild;
      for (const node of values.map((value) => fragmentNode(value, this.ownerDocument))) this.insertBefore(node, before);
    }
    replaceChildren(...values) {
      for (const child of Array.from(this.childNodes || [])) this.removeChild(child);
      this.append(...values);
    }
  }
  Object.defineProperties(DocumentFragment.prototype, {
    moveBefore: { value: function moveBefore(node, child) { return this.insertBefore(node, child); }, enumerable: true, writable: true, configurable: true },
    [Symbol.toStringTag]: { value: 'DocumentFragment', configurable: true },
    [Symbol.unscopables]: { value: Object.freeze({ append: true, prepend: true, replaceChildren: true, moveBefore: true }), configurable: true },
  });


  function fragmentElementDescendants(root) {
    const elements = [];
    for (const child of childArray(root)) {
      if (child.nodeType !== 1) continue;
      elements.push(child);
      elements.push(...fragmentElementDescendants(child));
    }
    return elements;
  }

  const shadowRootToken = {};
  class ShadowRoot extends DocumentFragment {
    constructor(token, host, init = {}) {
      if (token !== shadowRootToken) throw new TypeError("Failed to construct 'ShadowRoot': Illegal constructor");
      super(host?.ownerDocument || globalThis.document || null);
      Object.defineProperty(this, '__zpHost', { value: host, configurable: true });
      Object.defineProperty(this, Symbol.toStringTag, { value: 'ShadowRoot', configurable: true });
      this.mode = String(init.mode);
      this.delegatesFocus = Boolean(init.delegatesFocus);
      this.slotAssignment = init.slotAssignment === 'manual' ? 'manual' : 'named';
      setAdoptedStyleSheets(this, []);
    }
    get host() { return this.__zpHost; }
    get activeElement() { return activeElementIn(this); }
    get styleSheets() { return styleSheetListForRoot(this); }
    get adoptedStyleSheets() { return adoptedStyleSheetsFor(this); }
    set adoptedStyleSheets(value) { setAdoptedStyleSheets(this, value); }
  }

  function attachShadowRoot(host, init = {}) {
    const mode = String(init?.mode || '');
    if (mode !== 'open' && mode !== 'closed') throw new TypeError("Failed to execute 'attachShadow' on 'Element': The 'mode' member of ShadowRootInit must be either 'open' or 'closed'.");
    if (host.__zpShadowRoot) throw namedError('NotSupportedError');
    const root = new ShadowRoot(shadowRootToken, host, { ...init, mode });
    Object.defineProperty(host, '__zpShadowRoot', { value: root, configurable: true });
    if (mode === 'open') Object.defineProperty(host, '__zpOpenShadowRoot', { value: root, configurable: true });
    return root;
  }


  function styleSheetListForRoot(root) {
    return makeStyleSheetList(ownedStyleSheetsFor(root));
  }

  function ownedStyleSheetsFor(root) {
    return fragmentElementDescendants(root).filter(isStyleSheetOwner).map(styleSheetForElement);
  }

  function isStyleSheetOwner(element) {
    if (element?.localName === 'style') return true;
    return element?.localName === 'link' && /\bstylesheet\b/i.test(element.getAttribute?.('rel') || '');
  }

  function styleSheetForElement(element) {
    let sheet = elementStyleSheetCache.get(element);
    if (!sheet) {
      sheet = new CSSStyleSheet();
      Object.defineProperty(sheet, '__zpSheetOwnerNode', { value: element, configurable: true, writable: true });
      elementStyleSheetCache.set(element, sheet);
    }
    syncElementStyleSheet(element, sheet);
    return sheet;
  }

  function syncElementStyleSheet(element, sheet) {
    Object.defineProperty(sheet, '__zpSheetHref', { value: styleSheetHref(element), configurable: true, writable: true });
    Object.defineProperty(sheet, '__zpSheetTitle', { value: element.getAttribute?.('title') || null, configurable: true, writable: true });
    sheet.media.mediaText = element.getAttribute?.('media') || '';
    if (element.localName === 'style') sheet.replaceSync(element.textContent || '');
  }

  function elementMediaValue(element) {
    return isStyleSheetOwner(element) ? element.getAttribute?.('media') || '' : undefined;
  }

  function setElementMedia(element, value) {
    if (!isStyleSheetOwner(element)) return;
    element.setAttribute?.('media', String(value));
    styleSheetForElement(element);
  }

  function styleSheetHref(element) {
    return element.localName === 'link' ? resolvedURLAttribute(element, 'href') : null;
  }


  function elementDisabledValue(element) {
    return isStyleSheetOwner(element) ? styleSheetForElement(element).disabled : element.hasAttribute?.('disabled') || false;
  }

  function setElementDisabled(element, value) {
    if (isStyleSheetOwner(element)) {
      styleSheetForElement(element).disabled = value;
    } else if (value) element.setAttribute?.('disabled', '');
    else element.removeAttribute?.('disabled');
  }
  function adoptedStyleSheetsFor(root) {
    if (!Object.prototype.hasOwnProperty.call(root, '__zpAdoptedStyleSheets')) setAdoptedStyleSheets(root, []);
    return root.__zpAdoptedStyleSheets;
  }

  function setAdoptedStyleSheets(root, value) {
    const sheets = Array.from(value || []);
    for (const sheet of sheets) {
      if (!(sheet instanceof CSSStyleSheet)) throw new TypeError(`Failed to set the 'adoptedStyleSheets' property on '${root instanceof ShadowRoot ? 'ShadowRoot' : 'Document'}': Failed to convert value to 'CSSStyleSheet'.`);
    }
    Object.defineProperty(root, '__zpAdoptedStyleSheets', { value: sheets, configurable: true, writable: true });
  }
  function assignedSlotFor(node) {
    const root = node?.parentNode?.__zpShadowRoot;
    if (!root) return null;
    if (root.slotAssignment === 'manual') return manualSlotForNode(root, node);
    return shadowSlotFor(root, node.getAttribute?.('slot') || '');
  }

  function assignedNodesForSlot(slot, options = undefined) {
    const root = slot.getRootNode?.();
    if (!(root instanceof ShadowRoot)) return [];
    const assigned = root.slotAssignment === 'manual' ? manualSlotNodes(slot) : automaticSlotNodes(root, slot);
    if (assigned.length || !options?.flatten) return assigned;
    return childArray(slot);
  }

  function assignSlotNodes(slot, nodes) {
    slotAssignmentCache.set(slot, nodes.filter((node) => node instanceof Node));
  }

  function manualSlotNodes(slot) {
    return slotAssignmentCache.get(slot)?.slice() || [];
  }

  function manualSlotForNode(root, node) {
    return fragmentElementDescendants(root).find((element) => isSlotElement(element) && manualSlotNodes(element).includes(node)) || null;
  }

  function automaticSlotNodes(root, slot) {
    return childArray(root.host).filter((node) => (node.getAttribute?.('slot') || '') === (slot.getAttribute?.('name') || ''));
  }

  function shadowSlotFor(root, name) {
    return fragmentElementDescendants(root).find((element) => isSlotElement(element) && (element.getAttribute?.('name') || '') === name) || null;
  }

  function isSlotElement(element) {
    return element?.localName === 'slot' && element?.namespaceURI === 'http://www.w3.org/1999/xhtml';
  }
  function fragmentNode(value, ownerDocument) {
    if (value instanceof Node) return value;
    return new Text(String(value), ownerDocument || globalThis.document || null);
  }
  const domTokenListToken = {};
  const domTokenListSlots = new WeakMap();
  class DOMTokenList {
    constructor(token, element, attribute = 'class') {
      if (token !== domTokenListToken) throw new TypeError("Failed to construct 'DOMTokenList': Illegal constructor");
      domTokenListSlots.set(this, { element, attribute: String(attribute), indexedLength: 0 });
      syncDOMTokenList(this);
    }
    get length() { return domTokenValues(this).length; }
    get value() {
      const state = domTokenListState(this);
      return state.element.getAttribute?.(state.attribute) || '';
    }
    set value(value) { writeDOMTokenValues(this, domTokenValuesFromString(value)); }
    item(index) { return domTokenValues(this)[Number(index)] || null; }
    contains(token) { return domTokenValues(this).includes(validateDOMToken(token)); }
    add(...tokens) {
      const next = domTokenValues(this);
      for (const token of tokens.map(validateDOMToken)) if (!next.includes(token)) next.push(token);
      writeDOMTokenValues(this, next);
    }
    remove(...tokens) {
      const removals = tokens.map(validateDOMToken);
      writeDOMTokenValues(this, domTokenValues(this).filter((token) => !removals.includes(token)));
    }
    toggle(token, force) {
      const key = validateDOMToken(token);
      const next = domTokenValues(this);
      const has = next.includes(key);
      if (force === true || (!has && force !== false)) {
        if (!has) next.push(key);
        writeDOMTokenValues(this, next);
        return true;
      }
      if (has) writeDOMTokenValues(this, next.filter((entry) => entry !== key));
      return false;
    }
    replace(token, newToken) {
      const oldKey = validateDOMToken(token);
      const newKey = validateDOMToken(newToken);
      const next = domTokenValues(this);
      const index = next.indexOf(oldKey);
      if (index < 0) return false;
      if (next.includes(newKey)) next.splice(index, 1);
      else next[index] = newKey;
      writeDOMTokenValues(this, next);
      return true;
    }
    supports(token) {
      const state = domTokenListState(this);
      if (state.attribute !== 'rel' || !isRelListElement(state.element)) throw new TypeError("Failed to execute 'supports' on 'DOMTokenList': DOMTokenList has no supported tokens.");
      return relListSupports(state.element, token);
    }
    entries() { return domTokenValues(this).entries(); }
    keys() { return domTokenValues(this).keys(); }
    values() { return domTokenValues(this).values(); }
    forEach(callback, thisArg = undefined) { domTokenValues(this).forEach((value, index) => callback.call(thisArg, value, index, this)); }
    toString() { return this.value; }
    [Symbol.iterator]() { return this.values(); }
  }
  Object.defineProperties(DOMTokenList.prototype, {
    length: { ...Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'length'), enumerable: true },
    value: { ...Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'value'), enumerable: true },
    add: { ...Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'add'), enumerable: true },
    contains: { ...Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'contains'), enumerable: true },
    item: { ...Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'item'), enumerable: true },
    remove: { ...Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'remove'), enumerable: true },
    replace: { ...Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'replace'), enumerable: true },
    supports: { ...Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'supports'), enumerable: true },
    toggle: { ...Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'toggle'), enumerable: true },
    entries: { ...Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'entries'), enumerable: true },
    keys: { ...Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'keys'), enumerable: true },
    values: { ...Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'values'), enumerable: true },
    forEach: { ...Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'forEach'), enumerable: true },
    toString: { ...Object.getOwnPropertyDescriptor(DOMTokenList.prototype, 'toString'), enumerable: true },
  });
  Object.defineProperty(DOMTokenList.prototype, Symbol.toStringTag, { value: 'DOMTokenList', configurable: true });
  Object.defineProperty(DOMTokenList.prototype.toggle, 'length', { value: 1, configurable: true });
  Object.defineProperty(DOMTokenList.prototype[Symbol.iterator], 'name', { value: 'values', configurable: true });


  function DOMStringMap() { throw new TypeError("Failed to construct 'DOMStringMap': Illegal constructor"); }
  Object.defineProperty(DOMStringMap.prototype, Symbol.toStringTag, { value: 'DOMStringMap', configurable: true });

  function datasetFor(element) {
    let dataset = datasetCache.get(element);
    if (dataset) return dataset;
    const target = {};
    Object.setPrototypeOf(target, DOMStringMap.prototype);
    dataset = new Proxy(target, {
      get(target, prop, receiver) {
        if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);
        if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
        const value = element.getAttribute?.(datasetAttrName(prop));
        return value === null ? undefined : value;
      },
      set(_target, prop, value) {
        if (typeof prop !== 'string') return false;
        element.setAttribute?.(datasetAttrName(prop), value);
        return true;
      },
      deleteProperty(_target, prop) {
        if (typeof prop !== 'string') return false;
        element.removeAttribute?.(datasetAttrName(prop));
        return true;
      },
      defineProperty(_target, prop, descriptor) {
        if (typeof prop !== 'string' || !descriptor || !('value' in descriptor)) return false;
        element.setAttribute?.(datasetAttrName(prop), descriptor.value);
        return true;
      },
      preventExtensions() {
        return false;
      },
      has(target, prop) {
        return typeof prop === 'string' && element.hasAttribute?.(datasetAttrName(prop)) || Reflect.has(target, prop);
      },
      ownKeys(target) {
        return [...new Set([...Reflect.ownKeys(target), ...datasetKeys(element)])];
      },
      getOwnPropertyDescriptor(target, prop) {
        if (typeof prop !== 'string') return Reflect.getOwnPropertyDescriptor(target, prop);
        const value = element.getAttribute?.(datasetAttrName(prop));
        if (value === null) return Reflect.getOwnPropertyDescriptor(target, prop);
        return { value, enumerable: true, configurable: true, writable: true };
      },
    });
    datasetCache.set(element, dataset);
    return dataset;
  }
  function datasetAttrName(prop) { return 'data-' + dash(prop); }
  function datasetKeys(element) {
    const keys = [];
    for (const attr of Array.from(element.attributes || [])) {
      const name = String(attr.name || '');
      if (name.startsWith('data-')) keys.push(datasetPropName(name));
    }
    return keys;
  }
  function datasetPropName(name) { return String(name).slice(5).replace(/-([a-z])/g, (_match, ch) => ch.toUpperCase()); }
  function classListFor(element) {
    let list = classListCache.get(element);
    if (!list) {
      list = new DOMTokenList(domTokenListToken, element, 'class');
      classListCache.set(element, list);
    }
    syncDOMTokenList(list);
    return list;
  }

  function relListFor(element) {
    if (!isRelListElement(element)) return undefined;
    let list = relListCache.get(element);
    if (!list) {
      list = new DOMTokenList(domTokenListToken, element, 'rel');
      relListCache.set(element, list);
    }
    syncDOMTokenList(list);
    return list;
  }

  function isRelListElement(element) {
    return isElement(element, 'a') || isElement(element, 'area') || isElement(element, 'link');
  }

  const linkRelTokens = new Set(['alternate', 'author', 'canonical', 'compression-dictionary', 'dns-prefetch', 'expect', 'help', 'icon', 'license', 'manifest', 'modulepreload', 'next', 'pingback', 'preconnect', 'prefetch', 'preload', 'prerender', 'prev', 'search', 'stylesheet']);
  const anchorRelTokens = new Set(['alternate', 'author', 'bookmark', 'external', 'help', 'license', 'next', 'nofollow', 'noopener', 'noreferrer', 'opener', 'prev', 'privacy-policy', 'search', 'tag', 'terms-of-service']);

  function relListSupports(element, token) {
    const value = String(token || '').toLowerCase();
    if (!value || /\s/.test(value)) return false;
    return (isElement(element, 'link') ? linkRelTokens : anchorRelTokens).has(value);
  }

  function domTokenListState(list) {
    const state = domTokenListSlots.get(list);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function domTokenValues(list) {
    return domTokenValuesFromString(list.value);
  }

  function domTokenValuesFromString(value) {
    return String(value || '').trim().split(/\s+/).filter(Boolean);
  }

  function validateDOMToken(token) {
    const text = String(token);
    if (!text) throw namedError('SyntaxError');
    if (/\s/.test(text)) throw namedError('InvalidCharacterError');
    return text;
  }

  function writeDOMTokenValues(list, values) {
    const state = domTokenListState(list);
    state.element.setAttribute?.(state.attribute, values.join(' '));
    syncDOMTokenList(list);
  }

  function syncDOMTokenList(list) {
    const state = domTokenListState(list);
    for (let i = 0; i < state.indexedLength; i += 1) delete list[i];
    const values = domTokenValues(list);
    for (let i = 0; i < values.length; i += 1) Object.defineProperty(list, i, { value: values[i], enumerable: true, configurable: true });
    state.indexedLength = values.length;
  }


  function createFormDataInstance() {
    const target = Object.create(FormData.prototype);
    const proxy = new Proxy(target, {
      get(inner, property, receiver) {
        if (property === '__zpEntries') return formDataEntries(receiver);
        return Reflect.get(inner, property, receiver);
      },
      getOwnPropertyDescriptor(inner, property) {
        if (property === '__zpEntries') return undefined;
        return Reflect.getOwnPropertyDescriptor(inner, property);
      },
      has(inner, property) {
        if (property === '__zpEntries') return false;
        return Reflect.has(inner, property);
      },
    });
    formDataSlots.set(proxy, []);
    return proxy;
  }

  function formDataEntries(data) {
    const entries = formDataSlots.get(data);
    if (!entries) throw new TypeError('Illegal invocation');
    return entries;
  }

  function requireFormDataArguments(methodName, required, actual) {
    if (actual < required) throw new TypeError(`Failed to execute '${methodName}' on 'FormData': ${required} arguments required, but only ${actual} present.`);
  }

  function deleteFormDataEntries(data, key) {
    const entries = formDataEntries(data);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index][0] === key) entries.splice(index, 1);
    }
  }

  function formDataValue(value, filename, hasFilename = false, methodName = 'append') {
    if (value instanceof Blob) return hasFilename ? new File([value], String(filename), { type: value.type }) : value;
    if (hasFilename) throw new TypeError(`Failed to execute '${methodName}' on 'FormData': parameter 2 is not of type 'Blob'.`);
    return String(value);
  }
  function validatedFormDataSubmitter(form, submitter) {
    if (!isSubmitButton(submitter)) throw new TypeError("Failed to construct 'FormData': The specified element is not a submit button.");
    if (formOwner(submitter) !== form) throw namedError('NotFoundError', "Failed to construct 'FormData': The specified element is not owned by this form element.");
    return submitter;
  }

  function appendFormEntries(data, form, submitter = null) {
    if (!isElement(form, 'form')) return;
    for (const control of formControls(form)) appendControlEntry(data, control, submitter);
  }

  function dispatchFormDataEvent(form, data) {
    if (typeof form?.dispatchEvent !== 'function' || typeof globalThis.FormDataEvent !== 'function') return;
    form.dispatchEvent(new globalThis.FormDataEvent('formdata', { bubbles: true, formData: data }));
  }

  function appendControlEntry(data, control, submitter = null) {
    const name = control.name || '';
    if (skipFormControl(control, submitter)) return;
    if (isImageSubmitter(control, submitter)) {
      appendImageSubmitterEntries(data, name);
      return;
    }
    if (!isSubmittableFormControl(control)) return;
    if (!name) return;
    if (isFileInput(control)) {
      appendFileEntries(data, name, control.files);
      return;
    }
    if (isElement(control, 'select')) {
      appendSelectEntries(data, name, control);
      return;
    }
    data.append(name, elementValue(control) ?? '');
    appendDirnameEntry(data, control);
  }

  function appendSelectEntries(data, name, select) {
    for (const option of selectedOptions(select)) data.append(name, optionValue(option));
  }

  function appendDirnameEntry(data, control) {
    if (!isDirnameControl(control)) return;
    const dirname = control.getAttribute?.('dirname') || '';
    if (dirname) data.append(dirname, controlTextDirection(control));
  }

  function isDirnameControl(control) {
    if (!control?.hasAttribute?.('dirname')) return false;
    if (isElement(control, 'textarea')) return true;
    return isElement(control, 'input') && ['text', 'search', 'url', 'tel', 'email'].includes(inputType(control));
  }

  function controlTextDirection(control) {
    const dir = String(control.getAttribute?.('dir') || '').toLowerCase();
    if (dir === 'ltr' || dir === 'rtl') return dir;
    if (dir === 'auto') return inferredTextDirection(elementValue(control) || '');
    return 'ltr';
  }

  function inferredTextDirection(text) {
    for (const char of String(text)) {
      if (/[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/.test(char)) return 'rtl';
      if (/[A-Za-z\u00c0-\u024f]/.test(char)) return 'ltr';
    }
    return 'ltr';
  }

  function skipFormControl(control, submitter = null) {
    if (control.hasAttribute?.('disabled') || isDisabledByFieldset(control)) return true;
    if (isButtonControl(control)) return control !== submitter;
    if (!isElement(control, 'input')) return false;
    const type = control.type;
    return (type === 'checkbox' || type === 'radio') && !control.checked;
  }

  function isDisabledByFieldset(control) {
    for (let node = control?.parentNode; node; node = node.parentNode) {
      if (!isElement(node, 'fieldset') || !node.hasAttribute?.('disabled')) continue;
      const legend = firstLegendChild(node);
      return !(legend && containsNode(legend, control));
    }
    return false;
  }

  function firstLegendChild(fieldset) {
    return childArray(fieldset).find((child) => isElement(child, 'legend')) || null;
  }

  function containsNode(root, node) {
    for (let current = node; current; current = current.parentNode) if (current === root) return true;
    return false;
  }

  function isButtonControl(control) {
    if (isElement(control, 'button')) return ['submit', 'button', 'reset'].includes(buttonType(control));
    return isElement(control, 'input') && ['submit', 'button', 'reset', 'image'].includes(inputType(control));
  }

  function isSubmitButton(control) {
    if (isElement(control, 'button')) return buttonType(control) === 'submit';
    return isElement(control, 'input') && ['submit', 'image'].includes(inputType(control));
  }

  function isImageSubmitter(control, submitter) {
    return control === submitter && isElement(control, 'input') && inputType(control) === 'image';
  }

  function appendImageSubmitterEntries(data, name) {
    if (name) {
      data.append(`${name}.x`, '0');
      data.append(`${name}.y`, '0');
      return;
    }
    data.append('x', '0');
    data.append('y', '0');
  }

  function buttonType(button) {
    const type = String(button.getAttribute?.('type') || 'submit').toLowerCase();
    return ['submit', 'button', 'reset'].includes(type) ? type : 'submit';
  }

  function appendFileEntries(data, name, files) {
    for (let i = 0; i < files.length; i += 1) data.append(name, files.item(i));
  }

  function defineElementGetter(proto, name, get) {
    const existing = Object.getOwnPropertyDescriptor(proto, name);
    if (existing && existing.configurable === false) return;
    Object.defineProperty(proto, name, { get, configurable: true });
  }

  function defineElementProperty(proto, name, get, set) {
    const existing = Object.getOwnPropertyDescriptor(proto, name);
    if (existing && existing.configurable === false) return;
    const descriptor = { get() { return get(this); }, configurable: true };
    if (set) descriptor.set = function setElementProperty(value) { set(this, value); };
    Object.defineProperty(proto, name, descriptor);
  }

  function isFileInput(element) { return isElement(element, 'input') && element.type === 'file'; }

  function styleFor(element) {
    if (!element.__zpStyle) {
      element.__zpStyle = new CSSStyleDeclaration();
      const attr = element.getAttribute?.('style');
      if (attr) element.__zpStyle.cssText = attr;
    }
    return element.__zpStyle;
  }

  function inputType(element) {
    if (isElement(element, 'fieldset')) return 'fieldset';
    if (isElement(element, 'button')) return buttonType(element);
    if (isElement(element, 'input')) return (element.getAttribute?.('type') || 'text').toLowerCase();
    return typeAttributeElement(element) ? (element.getAttribute?.('type') || '') : '';
  }
  function setInputType(element, value) {
    if (isElement(element, 'input') || isElement(element, 'button')) element.setAttribute?.('type', String(value).toLowerCase());
    else if (typeAttributeElement(element)) element.setAttribute?.('type', String(value));
  }

  function typeAttributeElement(element) {
    return ['script', 'link', 'style', 'source', 'object', 'embed'].some((localName) => isElement(element, localName));
  }

  function relAttributeElement(element) {
    return ['a', 'area', 'link'].some((localName) => isElement(element, localName));
  }

  function srcsetAttributeElement(element) {
    return ['img', 'source'].some((localName) => isElement(element, localName));
  }

  function defaultInputValue(element) {
    return isElement(element, 'input') ? element.getAttribute?.('value') || '' : '';
  }

  function setDefaultInputValue(element, value) {
    if (isElement(element, 'input')) element.setAttribute?.('value', String(value));
  }

  function defaultInputChecked(element) {
    return isElement(element, 'input') ? element.hasAttribute?.('checked') || false : false;
  }

  function setDefaultInputChecked(element, value) {
    if (!isElement(element, 'input')) return;
    if (value) element.setAttribute?.('checked', '');
    else element.removeAttribute?.('checked');
  }

  function inputChecked(element) {
    return isElement(element, 'input') ? (element.__zpChecked !== undefined ? Boolean(element.__zpChecked) : element.hasAttribute?.('checked') || false) : false;
  }

  function setInputChecked(element, value) {
    if (isElement(element, 'input')) element.__zpChecked = Boolean(value);
  }

  function inputFiles(element) {
    return isFileInput(element) ? (element.__zpFiles ||= makeFileList([])) : null;
  }

  function setInputFiles(element, value) {
    if (!isFileInput(element)) return;
    if (value === null) {
      element.__zpFiles = makeFileList([]);
      return;
    }
    const files = filesFromList(value);
    if (!files) throw namedError('TypeError');
    element.__zpFiles = makeFileList(files);
  }

  function filesFromList(value) {
    if (!value || typeof value.length !== 'number') return null;
    const out = [];
    for (let i = 0; i < value.length; i += 1) {
      const file = typeof value.item === 'function' ? value.item(i) : value[i];
      if (!(file instanceof File)) return null;
      out.push(file);
    }
    return out;
  }

  function elementValue(element) {
    switch (String(element?.localName || '')) {
      case 'input':
        return inputValue(element);
      case 'textarea':
        return textareaValue(element);
      case 'option':
        return optionValue(element);
      case 'select':
        return selectValue(element);
      case 'button':
        return element.getAttribute?.('value') || '';
      case 'data':
        return element.getAttribute?.('value') || '';
      case 'output':
        return outputValue(element);
      case 'progress':
        return progressElementValue(element);
      case 'meter':
        return meterValue(element);
      default:
        return '';
    }
  }

  function textareaValue(element) {
    return element.__zpValue !== undefined ? String(element.__zpValue) : String(element.textContent || '');
  }

  function selectValue(element) {
    const option = selectedOptions(element)[0] || null;
    return option ? optionValue(option) : '';
  }

  function setElementValue(element, value) {
    if (isElement(element, 'input')) {
      setInputValue(element, value);
      return;
    }
    if (isElement(element, 'textarea')) {
      element.__zpValue = String(value ?? '');
      element.textContent = element.__zpValue;
      return;
    }
    if (isElement(element, 'option')) {
      element.setAttribute?.('value', String(value ?? ''));
      return;
    }
    if (isElement(element, 'select')) {
      setSelectValue(element, value);
      return;
    }
    if (isElement(element, 'data')) {
      element.setAttribute?.('value', String(value ?? ''));
      return;
    }
    if (isElement(element, 'output')) {
      element.__zpValue = String(value ?? '');
      element.textContent = element.__zpValue;
      return;
    }
    if (isElement(element, 'progress') || isElement(element, 'meter')) element.setAttribute?.('value', String(Number(value) || 0));
  }

  function outputValue(element) {
    return element.__zpValue !== undefined ? String(element.__zpValue) : String(element.textContent || '');
  }

  function numericAttr(element, attr, fallback) {
    const value = Number.parseFloat(element.getAttribute?.(attr) ?? '');
    return Number.isFinite(value) ? value : fallback;
  }

  function setNumericAttr(element, attr, value) {
    element.setAttribute?.(attr, String(Number(value) || 0));
  }

  function progressMax(element) {
    const max = numericAttr(element, 'max', 1);
    return max > 0 ? max : 1;
  }

  function progressElementValue(element) {
    const max = progressMax(element);
    return Math.min(Math.max(numericAttr(element, 'value', 0), 0), max);
  }

  function progressPosition(element) {
    return element.hasAttribute?.('value') ? progressElementValue(element) / progressMax(element) : -1;
  }

  function meterValue(element) { return numericAttr(element, 'value', 0); }

  function meterMin(element) { return numericAttr(element, 'min', 0); }

  function meterMax(element) { return numericAttr(element, 'max', 1); }

  function elementMax(element) {
    if (isElement(element, 'progress')) return progressMax(element);
    if (isElement(element, 'meter')) return meterMax(element);
    return element.getAttribute?.('max') || '';
  }

  function setElementMax(element, value) {
    if (isElement(element, 'progress') || isElement(element, 'meter')) setNumericAttr(element, 'max', value);
    else element.setAttribute?.('max', String(value));
  }

  function elementMin(element) {
    if (isElement(element, 'meter')) return meterMin(element);
    return element.getAttribute?.('min') || '';
  }

  function setElementMin(element, value) {
    if (isElement(element, 'meter')) setNumericAttr(element, 'min', value);
    else element.setAttribute?.('min', String(value));
  }

  function elementLow(element) {
    return isElement(element, 'meter') ? numericAttr(element, 'low', meterMin(element)) : 0;
  }

  function setElementLow(element, value) {
    if (isElement(element, 'meter')) setNumericAttr(element, 'low', value);
  }

  function elementHigh(element) {
    return isElement(element, 'meter') ? numericAttr(element, 'high', meterMax(element)) : 0;
  }

  function setElementHigh(element, value) {
    if (isElement(element, 'meter')) setNumericAttr(element, 'high', value);
  }

  function elementOptimum(element) {
    return isElement(element, 'meter') ? numericAttr(element, 'optimum', (meterMin(element) + meterMax(element)) / 2) : 0;
  }

  function setElementOptimum(element, value) {
    if (isElement(element, 'meter')) setNumericAttr(element, 'optimum', value);
  }

  function elementPosition(element) {
    return isElement(element, 'progress') ? progressPosition(element) : undefined;
  }

  function elementDateTime(element) {
    return isDateTimeElement(element) ? element.getAttribute?.('datetime') || '' : '';
  }

  function setElementDateTime(element, value) {
    if (isDateTimeElement(element)) element.setAttribute?.('datetime', String(value));
  }

  function isDateTimeElement(element) {
    return isElement(element, 'time') || isElement(element, 'del') || isElement(element, 'ins');
  }

  function elementCite(element) {
    return isCiteElement(element) ? element.getAttribute?.('cite') || '' : '';
  }

  function setElementCite(element, value) {
    if (isCiteElement(element)) element.setAttribute?.('cite', String(value));
  }

  function isCiteElement(element) {
    return isDateTimeElement(element) || isElement(element, 'q') || isElement(element, 'blockquote');
  }

  function inputValue(element) {
    if (!isElement(element, 'input')) return '';
    if (isFileInput(element)) {
      const file = inputFiles(element).item(0);
      return file ? 'C:\\fakepath\\' + file.name : '';
    }
    if (element.type === 'checkbox' || element.type === 'radio') return element.getAttribute?.('value') || 'on';
    return element.__zpValue !== undefined ? String(element.__zpValue) : element.getAttribute?.('value') || '';
  }

  function setInputValue(element, value) {
    if (!isElement(element, 'input')) return;
    if (isFileInput(element)) {
      if (String(value || '') !== '') throw namedError('InvalidStateError');
      element.__zpFiles = makeFileList([]);
      return;
    }
    element.__zpValue = String(value ?? '');
  }

  function optionValue(option) {
    return option.getAttribute?.('value') ?? String(option.textContent || '');
  }

  function optionSelected(option) {
    return isElement(option, 'option') ? (option.__zpSelected !== undefined ? Boolean(option.__zpSelected) : option.hasAttribute?.('selected') || false) : false;
  }

  function setOptionSelected(option, value) {
    if (!isElement(option, 'option')) return;
    option.__zpSelected = Boolean(value);
    const select = parentSelect(option);
    if (select && !select.multiple && value) deselectOtherOptions(select, option);
  }

  function defaultOptionSelected(option) {
    return isElement(option, 'option') ? option.hasAttribute?.('selected') || false : false;
  }

  function setDefaultOptionSelected(option, value) {
    if (!isElement(option, 'option')) return;
    if (value) option.setAttribute?.('selected', '');
    else option.removeAttribute?.('selected');
  }

  function optionsCollection(select) {
    const collection = {
      __zpOptionsSelect: select,
      item: (index) => selectOptions(select)[Number(index)] || null,
      namedItem: (name) => optionNamedItem(select, name),
      [Symbol.iterator]: function* iterator() { yield* selectOptions(select); },
    };
    Object.defineProperty(collection, '__zpOptionsSelect', { value: select, configurable: true });
    Object.setPrototypeOf(collection, HTMLOptionsCollection.prototype);
    return new Proxy(collection, {
      get(target, prop, receiver) {
        const dynamic = optionsCollectionValue(select, prop);
        return dynamic === undefined ? Reflect.get(target, prop, receiver) : dynamic;
      },
      has(target, prop) {
        return optionsCollectionValue(select, prop) !== undefined || prop in target;
      },
      ownKeys() {
        return optionsOwnKeys(select);
      },
      getOwnPropertyDescriptor(_target, prop) {
        const value = optionsCollectionValue(select, prop);
        if (value === undefined) return undefined;
        const key = String(prop);
        return { value, enumerable: true, configurable: true, writable: /^\d+$/.test(key) };
      },
    });
  }

  function htmlCollectionValues() {
    const length = Number(this?.length) || 0;
    let index = 0;
    return {
      next: () => {
        if (index >= length) return { value: undefined, done: true };
        const value = this.item?.(index) ?? this[index] ?? null;
        index += 1;
        return { value, done: false };
      },
      [Symbol.iterator]() { return this; },
    };
  }
  Object.defineProperty(htmlCollectionValues, 'name', { value: 'values', configurable: true });

  function installHTMLOptionsCollectionPrototype() {
    const constructorDescriptor = Object.getOwnPropertyDescriptor(HTMLOptionsCollection.prototype, 'constructor') || { value: HTMLOptionsCollection, writable: true, configurable: true };
    delete HTMLOptionsCollection.prototype.constructor;
    Object.defineProperties(HTMLOptionsCollection.prototype, {
      length: { get() { return selectOptions(optionsCollectionSelect(this)).length; }, set(value) { setOptionsLength(optionsCollectionSelect(this), value); }, enumerable: true, configurable: true },
      selectedIndex: { get() { return selectedIndex(optionsCollectionSelect(this)); }, set(value) { setSelectedIndex(optionsCollectionSelect(this), value); }, enumerable: true, configurable: true },
      add: { value: function add(element, before = null) { addOptionElement(optionsCollectionSelect(this), element, before); }, enumerable: true, writable: true, configurable: true },
      remove: { value: function remove(index) { removeOptionElement(optionsCollectionSelect(this), index); }, enumerable: true, writable: true, configurable: true },
      constructor: { ...constructorDescriptor, value: HTMLOptionsCollection },
    });
    Object.defineProperty(HTMLOptionsCollection.prototype, Symbol.iterator, { value: htmlCollectionValues, writable: true, configurable: true });
    if (globalThis.HTMLCollection?.prototype) Object.setPrototypeOf(HTMLOptionsCollection.prototype, globalThis.HTMLCollection.prototype);
  }

  function optionsCollectionSelect(collection) {
    const select = collection?.__zpOptionsSelect;
    if (!isElement(select, 'select')) throw new TypeError("Illegal invocation");
    return select;
  }

  function optionNamedItem(select, name) {
    const key = String(name);
    return selectOptions(select).find((option) => option.id === key || option.name === key) || null;
  }

  function optionsCollectionValue(select, prop) {
    const key = String(prop);
    if (/^\d+$/.test(key)) return selectOptions(select)[Number(key)] || undefined;
    if (optionsSupportedNames(select).includes(key)) return optionNamedItem(select, key) || undefined;
    return undefined;
  }

  function optionsOwnKeys(select) {
    return selectOptions(select).map((_option, index) => String(index)).concat(optionsSupportedNames(select));
  }

  function optionsSupportedNames(select) {
    const keys = [];
    for (const option of selectOptions(select)) {
      appendFormControlsNameKey(keys, option.id);
      appendFormControlsNameKey(keys, option.name);
    }
    return keys;
  }

  function setOptionsLength(select, value) {
    const length = Math.max(0, Math.trunc(Number(value) || 0));
    for (const option of selectOptions(select).slice(length)) option.remove?.();
    while (selectOptions(select).length < length) select.appendChild(new Option());
  }

  function addOptionElement(select, element, before) {
    if (!isElement(element, 'option') && !isElement(element, 'optgroup')) throw new TypeError("Failed to execute 'add' on 'HTMLOptionsCollection': The element provided is not an HTMLOptionElement or HTMLOptGroupElement.");
    const reference = optionReferenceNode(select, before);
    if (reference) select.insertBefore(element, reference);
    else select.appendChild(element);
  }

  function optionReferenceNode(select, before) {
    if (before === null || before === undefined) return null;
    if (typeof before === 'number') return selectOptions(select)[before] || null;
    return selectOptions(select).includes(before) ? before : null;
  }

  function removeOptionElement(select, index) {
    selectOptions(select)[Number(index)]?.remove?.();
  }

  function selectOptions(select) {
    const out = [];
    collectOptions(select, out);
    return out;
  }

  function collectOptions(node, out) {
    for (const child of node?.childNodes || []) {
      if (isElement(child, 'option')) out.push(child);
      else collectOptions(child, out);
    }
  }

  function selectedOptions(select) {
    const options = selectOptions(select);
    const selected = options.filter((option) => optionSelected(option));
    if (select.multiple || selected.length > 0) return selected;
    return options.length ? [options[0]] : [];
  }

  function selectedIndex(select) {
    if (!isElement(select, 'select')) return -1;
    const options = selectOptions(select);
    return options.findIndex((option) => selectedOptions(select).includes(option));
  }

  function setSelectedIndex(select, value) {
    if (!isElement(select, 'select')) return;
    const index = Number(value);
    const options = selectOptions(select);
    for (let i = 0; i < options.length; i += 1) options[i].__zpSelected = i === index;
  }

  function setSelectValue(select, value) {
    const text = String(value ?? '');
    let matched = false;
    for (const option of selectOptions(select)) {
      const isMatch = !matched && optionValue(option) === text;
      option.__zpSelected = isMatch;
      matched ||= isMatch;
    }
  }

  function parentSelect(option) {
    for (let node = option.parentNode; node; node = node.parentNode) if (isElement(node, 'select')) return node;
    return null;
  }

  function deselectOtherOptions(select, keep) {
    for (const option of selectOptions(select)) if (option !== keep) option.__zpSelected = false;
  }

  function formOwner(element) {
    if (isElement(element, 'label')) return formOwner(labelControl(element)) || closestForm(element);
    const explicit = explicitFormOwner(element);
    return explicit !== undefined ? explicit : closestForm(element);
  }

  function explicitFormOwner(element) {
    if (!element?.hasAttribute?.('form')) return undefined;
    const id = element.getAttribute('form') || '';
    if (!id) return null;
    const owner = (element.ownerDocument || globalThis.document)?.getElementById?.(id) || null;
    return isElement(owner, 'form') ? owner : null;
  }

  function closestForm(element) {
    for (let node = element?.parentNode; node; node = node.parentNode) if (isElement(node, 'form')) return node;
    return null;
  }

  function formControls(container) {
    const out = [];
    if (!isElement(container, 'form')) {
      collectContainedFormControls(container, out);
      return out;
    }
    collectFormControls(container, out, container);
    collectExternalFormControls(container, out);
    return out;
  }

  function collectExternalFormControls(form, out) {
    const id = form.getAttribute?.('id') || form.id || '';
    if (!id) return;
    const seen = new Set(out);
    for (const element of descendantElements(form.ownerDocument || globalThis.document)) {
      if (seen.has(element) || !isFormControl(element) || element.getAttribute?.('form') !== id) continue;
      if (formOwner(element) === form) out.push(element);
    }
  }

  function childArray(node) {
    return Array.from(node?.childNodes || []);
  }

  function descendantElements(node, out = []) {
    for (const child of childArray(node)) {
      if (child.nodeType === 1) out.push(child);
      descendantElements(child, out);
    }
    return out;
  }

  function collectFormControls(node, out, ownerForm = node) {
    for (const child of node?.childNodes || []) {
      if (isFormControl(child) && formOwner(child) === ownerForm) out.push(child);
      collectFormControls(child, out, ownerForm);
    }
  }

  function collectContainedFormControls(node, out) {
    for (const child of node?.childNodes || []) {
      if (isFormControl(child)) out.push(child);
      collectContainedFormControls(child, out);
    }
  }

  function isFormControl(node) { return ['button', 'fieldset', 'input', 'object', 'output', 'select', 'textarea'].includes(String(node?.localName || '')); }

  function isSubmittableFormControl(node) { return ['button', 'input', 'select', 'textarea'].includes(String(node?.localName || '')); }

  function isLabelableElement(node) {
    return ['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea'].includes(String(node?.localName || '')) && !(isElement(node, 'input') && node.type === 'hidden');
  }

  function labelHtmlFor(element) {
    return isElement(element, 'label') ? element.getAttribute?.('for') || '' : '';
  }

  function setLabelHtmlFor(element, value) {
    if (isElement(element, 'label')) element.setAttribute?.('for', String(value));
  }

  function labelControl(label) {
    if (!isElement(label, 'label')) return null;
    const targetId = label.getAttribute?.('for') || '';
    if (targetId) {
      const target = label.ownerDocument?.getElementById?.(targetId) || null;
      return isLabelableElement(target) ? target : null;
    }
    return firstLabelableDescendant(label);
  }

  function firstLabelableDescendant(node) {
    for (const child of childArray(node)) {
      if (isLabelableElement(child)) return child;
      const found = firstLabelableDescendant(child);
      if (found) return found;
    }
    return null;
  }

  function elementLabels(element) {
    if (!isLabelableElement(element)) return null;
    const doc = element.ownerDocument;
    if (!doc) return [];
    return staticNodeList(descendantElements(doc).filter((node) => isElement(node, 'label') && labelControl(node) === element));
  }

  function staticNodeList(nodes) {
    const list = {
      item: (index) => nodes[Number(index)] || null,
      entries: function* entries() { yield* nodes.entries(); },
      keys: function* keys() { yield* nodes.keys(); },
      values: function* values() { yield* nodes.values(); },
      [Symbol.iterator]: function* iterator() { yield* nodes; },
    };
    Object.defineProperty(list, 'length', { value: nodes.length, configurable: true });
    if (globalThis.NodeList?.prototype) Object.setPrototypeOf(list, globalThis.NodeList.prototype);
    return new Proxy(list, { get(target, prop) { return /^\d+$/.test(String(prop)) ? nodes[Number(prop)] : target[prop]; } });
  }

  function willValidate(element) {
    if (!isFormControl(element) || element.hasAttribute?.('disabled')) return false;
    if (isElement(element, 'input')) return !['hidden', 'button', 'reset', 'submit', 'image'].includes(element.type);
    return true;
  }

  function validityState(element) {
    const flags = validityFlags(element);
    const state = Object.create(ValidityState.prototype);
    validityStateSlots.set(state, { ...flags, valid: !Object.values(flags).some(Boolean) });
    return state;
  }

  function validityFlags(element) {
    const flags = {
      valueMissing: false,
      typeMismatch: false,
      patternMismatch: false,
      tooLong: false,
      tooShort: false,
      rangeUnderflow: false,
      rangeOverflow: false,
      stepMismatch: false,
      badInput: false,
      customError: false,
    };
    if (!willValidate(element)) return flags;
    const value = formControlValue(element);
    flags.customError = Boolean(element.__zpCustomValidity);
    flags.valueMissing = element.hasAttribute?.('required') && requiredValueMissing(element, value);
    flags.typeMismatch = inputTypeMismatch(element, value);
    flags.patternMismatch = inputPatternMismatch(element, value);
    flags.tooShort = lengthUnderflow(element, value);
    flags.tooLong = lengthOverflow(element, value);
    const range = rangeValidity(element, value);
    flags.rangeUnderflow = range.underflow;
    flags.rangeOverflow = range.overflow;
    flags.stepMismatch = inputStepMismatch(element, value);
    return flags;
  }

  function formControlValue(element) {
    return isElement(element, 'input') ? inputValue(element) : String(element.value ?? '');
  }

  function requiredValueMissing(element, value) {
    if (isFileInput(element)) return inputFiles(element).length === 0;
    if (isElement(element, 'input') && (element.type === 'checkbox' || element.type === 'radio')) return !element.checked;
    return String(value || '') === '';
  }

  function inputTypeMismatch(element, value) {
    if (!isElement(element, 'input') || !value) return false;
    if (element.type === 'email') return !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value));
    if (element.type !== 'url') return false;
    const parsed = hostParseURL(String(value), 'about:blank');
    return !parsed || parsed.origin === 'null';
  }

  function inputPatternMismatch(element, value) {
    const pattern = element.getAttribute?.('pattern');
    if (!pattern || !value) return false;
    try { return !(new RegExp('^(?:' + pattern + ')$', 'u')).test(String(value)); } catch { return false; }
  }

  function lengthUnderflow(element, value) {
    const min = numericAttribute(element, 'minlength');
    return min >= 0 && String(value).length > 0 && String(value).length < min;
  }

  function lengthOverflow(element, value) {
    const max = numericAttribute(element, 'maxlength');
    return max >= 0 && String(value).length > max;
  }

  function inputStepMismatch(element, value) {
    if (!isElement(element, 'input') || element.type !== 'number' || value === '') return false;
    const stepText = element.getAttribute?.('step');
    if (!stepText || String(stepText).toLowerCase() === 'any') return false;
    const step = Number(stepText);
    const number = Number(value);
    if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(number)) return false;
    const min = Number(element.getAttribute?.('min'));
    const base = Number.isFinite(min) ? min : 0;
    const quotient = (number - base) / step;
    return Math.abs(quotient - Math.round(quotient)) > 1e-9;
  }

  function rangeValidity(element, value) {
    const number = isElement(element, 'input') && element.type === 'number' && value !== '' ? Number(value) : NaN;
    if (!Number.isFinite(number)) return { underflow: false, overflow: false };
    const min = Number(element.getAttribute?.('min'));
    const max = Number(element.getAttribute?.('max'));
    return {
      underflow: Number.isFinite(min) && number < min,
      overflow: Number.isFinite(max) && number > max,
    };
  }

  function numericAttribute(element, name) {
    if (!element.hasAttribute?.(name)) return -1;
    const value = Number(element.getAttribute?.(name));
    return Number.isInteger(value) && value >= 0 ? value : -1;
  }

  function validationMessage(element) {
    const key = firstValidityFlag(validityFlags(element));
    if (!key) return '';
    if (key === 'customError') return String(element.__zpCustomValidity || '');
    return defaultValidationMessage(element, key);
  }

  function firstValidityFlag(flags) {
    for (const key of ['customError', 'valueMissing', 'typeMismatch', 'patternMismatch', 'tooShort', 'tooLong', 'rangeUnderflow', 'rangeOverflow', 'stepMismatch', 'badInput']) {
      if (flags[key]) return key;
    }
    return '';
  }

  function defaultValidationMessage(element, key) {
    const messages = {
      valueMissing: 'Please fill out this field.',
      patternMismatch: 'Please match the requested format.',
      tooShort: 'Please lengthen this text.',
      tooLong: 'Please shorten this text.',
      stepMismatch: 'Please enter a valid value.',
      badInput: 'Please enter a valid value.',
    };
    if (key === 'typeMismatch') return element.type === 'url' ? 'Please enter a URL.' : 'Please enter an email address.';
    if (key === 'rangeUnderflow') return 'Value must be greater than or equal to ' + element.getAttribute('min') + '.';
    if (key === 'rangeOverflow') return 'Value must be less than or equal to ' + element.getAttribute('max') + '.';
    return messages[key] || 'Please enter a valid value.';
  }

  function runValidityCheck(element, fireInvalid) {
    if (isElement(element, 'form')) {
      let valid = true;
      for (const control of formControls(element)) if (!runValidityCheck(control, fireInvalid)) valid = false;
      return valid;
    }
    const valid = validityState(element).valid;
    if (!valid && fireInvalid) element.dispatchEvent?.(new Event('invalid', { bubbles: false, cancelable: true }));
    return valid;
  }
  function installHTMLFormControlsCollectionPrototype() {
    const constructorDescriptor = Object.getOwnPropertyDescriptor(HTMLFormControlsCollection.prototype, 'constructor') || { value: HTMLFormControlsCollection, writable: true, configurable: true };
    delete HTMLFormControlsCollection.prototype.constructor;
    Object.defineProperties(HTMLFormControlsCollection.prototype, {
      namedItem: { value: function namedItem(name) { return formControlsNamedItem(formControlsCollectionForm(this), name); }, enumerable: true, writable: true, configurable: true },
      constructor: { ...constructorDescriptor, value: HTMLFormControlsCollection },
      [Symbol.iterator]: { value: htmlCollectionValues, writable: true, configurable: true },
    });
    if (globalThis.HTMLCollection?.prototype) Object.setPrototypeOf(HTMLFormControlsCollection.prototype, globalThis.HTMLCollection.prototype);
  }

  function formControlsCollectionForm(collection) {
    const form = collection?.__zpForm;
    if (!isElement(form, 'form') && !isElement(form, 'fieldset')) throw new TypeError("Illegal invocation");
    return form;
  }

  function formControlsCollection(form) {
    const collection = {
      item: (index) => formControls(form)[Number(index)] || null,
    };
    Object.defineProperty(collection, '__zpForm', { value: form, configurable: true });
    Object.setPrototypeOf(collection, HTMLFormControlsCollection.prototype);
    return new Proxy(collection, {
      get(target, prop, receiver) {
        if (String(prop) === 'length') return formControls(form).length;
        const dynamic = formControlsCollectionValue(form, prop);
        return dynamic === undefined ? Reflect.get(target, prop, receiver) : dynamic;
      },
      has(target, prop) {
        return formControlsCollectionValue(form, prop) !== undefined || prop in target;
      },
      ownKeys() {
        return formControlsOwnKeys(form);
      },
      getOwnPropertyDescriptor(_target, prop) {
        const value = formControlsCollectionValue(form, prop);
        return value === undefined ? undefined : { value, enumerable: true, configurable: true, writable: false };
      },
    });
  }

  function formControlsNamedItem(form, name) {
    const key = String(name);
    const matches = formControlsNamedMatches(form, key);
    if (matches.length > 1 && matches.every((control) => isElement(control, 'input') && control.type === 'radio')) return radioNodeList(() => formControlsNamedMatches(form, key));
    return matches[0] || null;
  }

  function formControlsNamedMatches(form, key) {
    return formControls(form).filter((control) => control.id === key || control.name === key);
  }

  function formControlsCollectionValue(form, prop) {
    const key = String(prop);
    if (/^\d+$/.test(key)) return formControls(form)[Number(key)] || undefined;
    if (formControlsSupportedNames(form).includes(key)) return formControlsNamedItem(form, key) || undefined;
    return undefined;
  }

  function formControlsOwnKeys(form) {
    return formControls(form).map((_control, index) => String(index)).concat(formControlsSupportedNames(form));
  }

  function formControlsSupportedNames(form) {
    const keys = [];
    for (const control of formControls(form)) {
      appendFormControlsNameKey(keys, control.id);
      appendFormControlsNameKey(keys, control.name);
    }
    return keys;
  }

  function appendFormControlsNameKey(keys, value) {
    const key = String(value || '');
    if (key && !keys.includes(key)) keys.push(key);
  }

  function getRadioNodeListValue() {
    return radioNodes(this).find((node) => node.checked)?.value || '';
  }
  Object.defineProperty(getRadioNodeListValue, 'name', { value: 'get value', configurable: true });

  function setRadioNodeListValue(value) {
    const text = String(value);
    for (const node of radioNodes(this)) node.checked = node.value === text;
  }
  Object.defineProperty(setRadioNodeListValue, 'name', { value: 'set value', configurable: true });

  function radioNodeListValues() {
    const iterator = globalThis.NodeList?.prototype?.[Symbol.iterator];
    if (typeof iterator !== 'function') throw new TypeError('Illegal invocation');
    return iterator.call(this);
  }
  Object.defineProperty(radioNodeListValues, 'name', { value: 'values', configurable: true });

  function installRadioNodeListPrototype() {
    const constructorDescriptor = Object.getOwnPropertyDescriptor(RadioNodeList.prototype, 'constructor') || { value: RadioNodeList, writable: true, configurable: true };
    delete RadioNodeList.prototype.constructor;
    Object.defineProperties(RadioNodeList.prototype, {
      value: { get: getRadioNodeListValue, set: setRadioNodeListValue, enumerable: true, configurable: true },
      constructor: { ...constructorDescriptor, value: RadioNodeList },
      [Symbol.iterator]: { value: radioNodeListValues, enumerable: false, writable: true, configurable: true },
    });
    if (globalThis.NodeList?.prototype) Object.setPrototypeOf(RadioNodeList.prototype, globalThis.NodeList.prototype);
  }

  function radioNodes(list) {
    const query = list?.__zpRadioQuery;
    if (typeof query !== 'function') throw new TypeError("Illegal invocation");
    return query();
  }

  function radioNodeList(query) {
    const list = {
      item(index) { return radioNodes(this)[Number(index)] || null; },
      [Symbol.iterator]: function* iterator() { yield* radioNodes(this); },
    };
    Object.defineProperty(list, '__zpRadioQuery', { value: query, configurable: true });
    Object.setPrototypeOf(list, RadioNodeList.prototype);
    return new Proxy(list, {
      get(target, prop, receiver) {
        const nodes = radioNodes(target);
        const key = String(prop);
        if (key === 'length') return nodes.length;
        if (/^\d+$/.test(key)) return nodes[Number(key)] || undefined;
        return Reflect.get(target, prop, receiver);
      },
      ownKeys(target) {
        return radioNodes(target).map((_node, index) => String(index));
      },
      getOwnPropertyDescriptor(target, prop) {
        const nodes = radioNodes(target);
        const key = String(prop);
        if (!/^\d+$/.test(key) || Number(key) >= nodes.length) return undefined;
        return { value: nodes[Number(key)], enumerable: true, configurable: true, writable: false };
      },
    });
  }

  function isURLAttributeElement(element, attr) {
    const local = String(element?.localName || '');
    return attr === 'href' ? (local === 'a' || local === 'link') : (local === 'img' || local === 'script' || local === 'iframe' || local === 'audio' || local === 'video' || local === 'source' || local === 'track' || local === 'embed');
  }

  function resolvedURLAttribute(element, attr) {
    const value = element.getAttribute?.(attr) || '';
    return value ? resolveURL(value) : '';
  }

  function anchorURLPart(element, part) {
    if (!isElement(element, 'a')) return '';
    return parsedURL(element.href)[part] || '';
  }

  function setAnchorURLPart(element, part, value) {
    if (!isElement(element, 'a')) return;
    const href = setURLPart(element.href, part, value);
    if (href) element.setAttribute?.('href', href);
  }

  function parsedURL(input, base = currentURLBase()) {
    return hostParseURL(input || '', base) || emptyURLRecord(input);
  }

  function setURLPart(href, part, value, base = currentURLBase()) {
    try {
      if (typeof __zpSetURLPart === 'function') return __zpSetURLPart(href, part, value, base);
    } catch {}
    return '';
  }

  function hostParseURL(input, base) {
    try {
      if (typeof __zpParseURL === 'function') return base === undefined ? __zpParseURL(input) : __zpParseURL(input, base);
    } catch {}
    return null;
  }

  function currentURLBase() {
    return globalThis.location?.href || 'about:blank';
  }

  function emptyURLRecord(input) {
    const href = String(input || '');
    return { href, origin: '', protocol: '', username: '', password: '', host: '', hostname: '', port: '', pathname: '', search: '', hash: '' };
  }

  const cloneNoMatch = {};
  const structuredClone = (value) => cloneValue(value, new Map());
  function cloneValue(value, seen) {
    if (typeof value === 'function' || typeof value === 'symbol') throw dataCloneError(value);
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    const special = cloneSpecialValue(value, seen);
    return special === cloneNoMatch ? clonePlainValue(value, seen) : special;
  }
  function cloneSpecialValue(value, seen) {
    if (uncloneableStructuredObject(value)) throw dataCloneError(value);
    if (ArrayBuffer.isView(value)) return new value.constructor(value);
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof RegExp) return cloneRegExp(value);
    if (typeof DOMException === 'function' && value instanceof DOMException) return cloneDOMException(value);
    if (value instanceof Error) return cloneError(value);
    if (value instanceof Map) return cloneMap(value, seen);
    if (value instanceof Set) return cloneSet(value, seen);
    if (typeof Blob === 'function' && value instanceof Blob && typeof value.slice === 'function') return value.slice(0, value.size, value.type);
    return cloneNoMatch;
  }
  function uncloneableStructuredObject(value) {
    return value instanceof WeakMap || value instanceof WeakSet || value instanceof Promise || (typeof URL === 'function' && value instanceof URL) || (typeof URLSearchParams === 'function' && value instanceof URLSearchParams);
  }
  function dataCloneError(value) {
    const description = structuredCloneErrorDescription(value);
    return namedError('DataCloneError', `Failed to execute 'structuredClone' on 'Window': ${description} could not be cloned.`);
  }
  function structuredCloneErrorDescription(value) {
    if (typeof value === 'symbol') return String(value);
    if (typeof value === 'function') return String(value);
    if (typeof URL === 'function' && value instanceof URL) return 'URL object';
    return Object.prototype.toString.call(value).slice(8, -1) ? `#<${Object.prototype.toString.call(value).slice(8, -1)}>` : String(value);
  }
  function cloneRegExp(value) {
    const clone = new RegExp(value.source, value.flags);
    clone.lastIndex = value.lastIndex;
    return clone;
  }
  function cloneError(value) {
    const ctor = typeof value.constructor === 'function' ? value.constructor : Error;
    const clone = new ctor(value.message);
    if ('stack' in value) clone.stack = value.stack;
    return clone;
  }
  function cloneDOMException(value) {
    const clone = new DOMException(value.message);
    try { Object.defineProperty(clone, 'name', { value: value.name, configurable: true }); } catch {}
    try { Object.defineProperty(clone, 'message', { value: value.message, configurable: true }); } catch {}
    try { Object.defineProperty(clone, 'code', { value: value.code, configurable: true }); } catch {}
    return clone;
  }
  function cloneMap(value, seen) {
    const out = new Map();
    seen.set(value, out);
    for (const [key, entryValue] of value) out.set(cloneValue(key, seen), cloneValue(entryValue, seen));
    return out;
  }
  function cloneSet(value, seen) {
    const out = new Set();
    seen.set(value, out);
    for (const entryValue of value) out.add(cloneValue(entryValue, seen));
    return out;
  }
  function clonePlainValue(value, seen) {
    const out = Array.isArray(value) ? [] : {};
    seen.set(value, out);
    for (const key of Object.keys(value)) out[key] = cloneValue(value[key], seen);
    return out;
  }

  function getRandomValues(view) {
    if (!integerTypedArray(view)) throw new TypeError("Failed to execute 'getRandomValues' on 'Crypto': parameter 1 is not an integer TypedArray.");
    if (view.byteLength > 65536) throw namedError('QuotaExceededError');
    const bytes = __zpRandomBytes(view.byteLength);
    const target = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (let i = 0; i < target.length; i++) target[i] = bytes[i] || 0;
    return view;
  }
  function integerTypedArray(view) {
    return view instanceof Int8Array || view instanceof Uint8Array || view instanceof Uint8ClampedArray || view instanceof Int16Array || view instanceof Uint16Array || view instanceof Int32Array || view instanceof Uint32Array || (typeof BigInt64Array === 'function' && view instanceof BigInt64Array) || (typeof BigUint64Array === 'function' && view instanceof BigUint64Array);
  }
  function randomUUID() {
    const bytes = new Uint8Array(16);
    getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return uuidBytes(bytes);
  }
  function uuidBytes(bytes) {
    const hex = [];
    for (let index = 0; index < bytes.length; index += 1) hex.push(bytes[index].toString(16).padStart(2, '0'));
    return [hex.slice(0, 4).join(''), hex.slice(4, 6).join(''), hex.slice(6, 8).join(''), hex.slice(8, 10).join(''), hex.slice(10, 16).join('')].join('-');
  }

  function Crypto() { throw new TypeError("Failed to construct 'Crypto': Illegal constructor"); }
  const cryptoConstructorDescriptor = Object.getOwnPropertyDescriptor(Crypto.prototype, 'constructor');
  delete Crypto.prototype.constructor;
  Object.defineProperty(Crypto.prototype, 'getRandomValues', { value: getRandomValues, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(Crypto.prototype, 'constructor', cryptoConstructorDescriptor);
  Object.defineProperty(Crypto.prototype, Symbol.toStringTag, { value: 'Crypto', configurable: true });
  function makeCrypto() {
    const crypto = Object.create(Crypto.prototype);
    Object.defineProperty(crypto, '__zpCrypto', { value: true, configurable: true });
    Object.defineProperty(crypto, 'randomUUID', { value: randomUUID, writable: true, configurable: true });
    return Object.freeze(crypto);
  }

  function makeWindowFunction(name, fn) {
    const bound = fn.bind(undefined);
    try { Object.defineProperty(bound, 'name', { value: name, configurable: true }); } catch {}
    return bound;
  }

  function btoaImpl(input) {
    const bridged = hostBridgeGlobalFunction('btoa', arguments);
    if (bridged.handled) return bridged.value;
    if (arguments.length < 1) throw new TypeError("Failed to execute 'btoa' on 'Window': 1 argument required, but only 0 present.");
    const text = String(input);
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) > 255) throw namedError('InvalidCharacterError');
    }
    return base64Encode(text);
  }
  function atobImpl(input) {
    const bridged = hostBridgeGlobalFunction('atob', arguments);
    if (bridged.handled) return bridged.value;
    if (arguments.length < 1) throw new TypeError("Failed to execute 'atob' on 'Window': 1 argument required, but only 0 present.");
    return base64Decode(String(input));
  }
  const btoa = makeWindowFunction('btoa', btoaImpl);
  const atob = makeWindowFunction('atob', atobImpl);
  function base64Encode(input) { const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; let out = ''; for (let i = 0; i < input.length; i += 3) { const a = input.charCodeAt(i) & 255; const b = input.charCodeAt(i + 1) & 255; const c = input.charCodeAt(i + 2) & 255; out += chars[a >> 2] + chars[((a & 3) << 4) | (b >> 4)] + (i + 1 < input.length ? chars[((b & 15) << 2) | (c >> 6)] : '=') + (i + 2 < input.length ? chars[c & 63] : '='); } return out; }
  function base64Decode(input) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const clean = input.replace(/[\t\n\f\r ]/g, '');
    if (clean.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(clean) || /=.*[^=]/.test(clean) || clean.indexOf('===') >= 0) throw namedError('InvalidCharacterError');
    const normalized = clean.replace(/=+$/, '');
    let out = '';
    let buffer = 0;
    let bits = 0;
    for (const ch of normalized) {
      const value = chars.indexOf(ch);
      buffer = (buffer << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((buffer >> bits) & 255);
      }
    }
    return out;
  }

  function nodeIndex(node) { return childArray(node?.parentNode).indexOf(node); }
  function rangeNodeLength(node) { return node?.nodeType === 3 ? String(node.textContent || '').length : (node?.childNodes?.length || 0); }
  function commonAncestor(a, b) {
    if (!a || !b) return a || b || null;
    const seen = new Set();
    for (let node = a; node; node = node.parentNode) seen.add(node);
    for (let node = b; node; node = node.parentNode) if (seen.has(node)) return node;
    return a.ownerDocument || b.ownerDocument || globalThis.document || null;
  }
  function rangeText(range) {
    if (!range.startContainer || !range.endContainer || range.collapsed) return '';
    const root = range.commonAncestorContainer;
    const start = textOffset(root, range.startContainer, range.startOffset);
    const end = textOffset(root, range.endContainer, range.endOffset);
    return String(root?.textContent || '').slice(Math.min(start, end), Math.max(start, end));
  }
  function textOffset(root, container, offset) {
    let count = 0;
    let done = false;
    visitTextOffset(root, container, Number(offset) || 0, () => { done = true; }, (amount) => { count += amount; }, () => done);
    return count;
  }
  function visitTextOffset(node, container, offset, finish, add, isDone) {
    if (!node || isDone()) return;
    if (node === container) { add(textBeforeOffset(node, offset)); finish(); return; }
    if (node.nodeType === 3) { add(String(node.textContent || '').length); return; }
    for (const child of node.childNodes || []) visitTextOffset(child, container, offset, finish, add, isDone);
  }
  function textBeforeOffset(node, offset) {
    if (node.nodeType === 3) return String(node.textContent || '').slice(0, Math.max(0, offset)).length;
    return childArray(node).slice(0, Math.max(0, offset)).map((child) => child.textContent || '').join('').length;
  }
  function setWalkerNode(walker, node) { if (node) treeWalkerValue(walker).currentNode = node; return node || null; }
  function iterateNode(iterator, direction) {
    const state = nodeIteratorValue(iterator);
    const nodes = acceptedNodes(state.root, iterator, true);
    let index = nodes.indexOf(state.referenceNode);
    if (direction > 0) index = state.pointerBeforeReferenceNode ? index : index + 1;
    else index = state.pointerBeforeReferenceNode ? index - 1 : index;
    const node = nodes[index];
    if (!node) return null;
    state.referenceNode = node;
    state.pointerBeforeReferenceNode = direction < 0;
    return node;
  }
  function acceptedRelative(node, walker, direction) {
    const nodes = acceptedNodes(walker.root, walker, false);
    const index = nodes.indexOf(node);
    if (index < 0) return direction > 0 ? nodes[0] || null : null;
    return nodes[index + direction] || null;
  }
  function acceptedAncestor(node, walker) {
    for (let parent = node?.parentNode; parent; parent = parent.parentNode) {
      if (nodeFilterResult(parent, walker) === NodeFilter.FILTER_ACCEPT) return parent;
      if (parent === walker.root) return null;
    }
    return null;
  }
  function acceptedChild(node, walker, reverse) {
    const children = [...(node?.childNodes || [])];
    if (reverse) children.reverse();
    for (const child of children) {
      const found = acceptedSelfOrDescendant(child, walker, reverse);
      if (found) return found;
    }
    return null;
  }
  function acceptedSibling(node, walker, reverse) {
    const parent = node?.parentNode;
    if (!parent) return null;
    const siblings = parent.childNodes || [];
    for (let index = nodeIndex(node) + (reverse ? -1 : 1); index >= 0 && index < siblings.length; index += reverse ? -1 : 1) {
      const found = acceptedSelfOrDescendant(siblings[index], walker, reverse);
      if (found) return found;
    }
    return null;
  }
  function acceptedSelfOrDescendant(node, walker, reverse) {
    const result = nodeFilterResult(node, walker);
    if (result === NodeFilter.FILTER_ACCEPT) return node;
    if (result === NodeFilter.FILTER_REJECT) return null;
    return acceptedChild(node, walker, reverse);
  }
  function acceptedNodes(root, walker, includeRoot) {
    return traversalNodes(root, includeRoot).filter((node) => nodeFilterResult(node, walker) === NodeFilter.FILTER_ACCEPT);
  }
  function traversalNodes(root, includeRoot) {
    const out = [];
    visitTraversal(root, includeRoot, out);
    return out;
  }
  function visitTraversal(node, include, out) {
    if (!node) return;
    if (include) out.push(node);
    for (const child of node.childNodes || []) visitTraversal(child, true, out);
  }
  function defineStyleProperty(style, prop) {
    Object.defineProperty(style, prop, {
      get() { return this.getPropertyValue(styleName(prop)); },
      set(value) { this.setProperty(styleName(prop), value); },
      enumerable: true,
      configurable: true,
    });
  }
  function styleName(name) {
    const text = String(name || '').trim();
    return text.startsWith('--') ? text : dash(text).toLowerCase();
  }
  function cssSupports(conditionOrProperty) {
    const args = Array.from(arguments);
    const bridged = hostBridgeStatic('CSS', 'supports', args);
    if (bridged.handled) return Boolean(bridged.value);
    if (args.length === 1) return cssSupportsCondition(conditionOrProperty);
    return cssSupportsDeclaration(conditionOrProperty, args[1]);
  }
  function cssSupportsCondition(conditionText) {
    const text = String(conditionText || '').trim();
    if (!text) return false;
    if (text.startsWith('(') && text.endsWith(')')) return cssSupportsCondition(text.slice(1, -1));
    const colon = text.indexOf(':');
    return colon > 0 && cssSupportsDeclaration(text.slice(0, colon), text.slice(colon + 1));
  }
  function cssSupportsDeclaration(property, value) {
    const key = styleName(property);
    const text = String(value ?? '').trim();
    return Boolean(text) && (key.startsWith('--') || supportedCSSProperties.has(key));
  }
  function cssEscape(value) {
    const bridged = hostBridgeStatic('CSS', 'escape', Array.from(arguments));
    if (bridged.handled) return String(bridged.value);
    const text = String(value);
    let out = '';
    for (let index = 0; index < text.length; index += 1) out += cssEscapeChar(text, index);
    return out;
  }
  function cssEscapeChar(text, index) {
    const code = text.charCodeAt(index);
    if (code === 0) return '\uFFFD';
    if (cssEscapeAsCodePoint(text, index, code)) return '\\' + code.toString(16) + ' ';
    if (index === 0 && code === 45 && text.length === 1) return '\\-';
    return cssSafeIdentCode(code) ? text[index] : '\\' + text[index];
  }
  function cssEscapeAsCodePoint(text, index, code) {
    return (code >= 1 && code <= 31) || code === 127 || (index === 0 && cssDigitCode(code)) || (index === 1 && text.charCodeAt(0) === 45 && cssDigitCode(code));
  }
  function cssSafeIdentCode(code) {
    return code >= 128 || code === 45 || code === 95 || cssDigitCode(code) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  }
  function cssDigitCode(code) { return code >= 48 && code <= 57; }
  function parseStyleDeclarations(cssText, emit) {
    const declarations = hostParseStyleDeclarations(cssText);
    for (const declaration of declarations) {
      if (!declaration?.name) continue;
      emit(declaration.name, declaration.value || '', declaration.priority || '');
    }
  }
  function hostParseStyleDeclarations(cssText) {
    try {
      if (typeof __zpHostParseStyleDeclarations === 'function') {
        const declarations = __zpHostParseStyleDeclarations(String(cssText || ''));
        if (Array.isArray(declarations)) return declarations;
      }
    } catch {}
    return [];
  }
  function computedStyle(element) {
    const out = new CSSStyleDeclaration();
    if (!element?.style) return out;
    applyAuthorStyleRules(out, element);
    const source = element.style;
    for (let i = 0; i < source.length; i++) {
      const name = source.item(i);
      out.setProperty(name, computedStyleValue(name, source.getPropertyValue(name)), source.getPropertyPriority(name));
    }
    return out;
  }

  function applyAuthorStyleRules(out, element) {
    const doc = element.ownerDocument || globalThis.document;
    const sheets = doc?.styleSheets || [];
    for (let i = 0; i < sheets.length; i++) {
      applyStyleSheetRules(out, element, sheets.item ? sheets.item(i) : sheets[i]);
    }
    const adopted = doc?.adoptedStyleSheets || [];
    for (let i = 0; i < adopted.length; i++) {
      applyStyleSheetRules(out, element, adopted[i]);
    }
    const styles = doc?.getElementsByTagName?.('style') || [];
    for (let i = 0; i < styles.length; i++) {
      applyStyleSheetText(out, element, styles.item ? styles.item(i)?.textContent : styles[i]?.textContent);
    }
    const bodyStyles = doc?.body?.getElementsByTagName?.('style') || [];
    for (let i = 0; i < bodyStyles.length; i++) {
      applyStyleSheetText(out, element, bodyStyles.item ? bodyStyles.item(i)?.textContent : bodyStyles[i]?.textContent);
    }
    const headStyles = doc?.head?.getElementsByTagName?.('style') || [];
    for (let i = 0; i < headStyles.length; i++) {
      applyStyleSheetText(out, element, headStyles.item ? headStyles.item(i)?.textContent : headStyles[i]?.textContent);
    }
  }

  function applyStyleSheetRules(out, element, sheet) {
    const rules = sheet?.cssRules || [];
    for (let i = 0; i < rules.length; i++) {
      const rule = rules.item ? rules.item(i) : rules[i];
      if (!rule?.selectorText || !rule.style) continue;
      for (const selector of String(rule.selectorText).split(',')) {
        const query = selector.trim();
        if (!query || !styleRuleMatchesElement(element, query)) continue;
        if (rule.style.length) {
          for (let index = 0; index < rule.style.length; index++) {
            const name = rule.style.item(index);
            out.setProperty(name, computedStyleValue(name, rule.style.getPropertyValue(name)), rule.style.getPropertyPriority(name));
          }
        } else {
          const cssText = rule.style.cssText || String(rule.cssText || '').replace(/^[^{]*\{|\}\s*$/g, '');
          parseStyleDeclarations(cssText, (name, value, priority) => {
            out.setProperty(name, computedStyleValue(name, value), priority);
          });
        }
        break;
      }
    }
  }

  function applyStyleSheetText(out, element, text) {
    const css = String(text || '');
    const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
    for (let match; (match = rulePattern.exec(css));) {
      const selectorText = match[1].trim();
      const declarations = match[2];
      for (const selector of selectorText.split(',')) {
        const query = selector.trim();
        if (!query || !styleRuleMatchesElement(element, query)) continue;
        parseStyleDeclarations(declarations, (name, value, priority) => {
          out.setProperty(name, computedStyleValue(name, value), priority);
        });
        break;
      }
    }
  }

  function styleRuleMatchesElement(element, selector) {
    try {
      if (element.matches?.(selector)) return true;
    } catch {
      return false;
    }
    const text = String(selector || '').trim();
    if (!text || /[\s>+~:[\],]/.test(text)) return false;
    if (text[0] === '#') return element.id === text.slice(1);
    if (text[0] === '.') return String(element.className || '').split(/\s+/).includes(text.slice(1));
    return String(element.localName || '').toLowerCase() === text.toLowerCase();
  }
  function computedStyleValue(name, value) {
    const key = styleName(name);
    if (key === 'color' || key === 'background-color') return colorValue(value);
    return value;
  }
  function colorValue(value) {
    const text = String(value || '').trim().toLowerCase();
    return colorKeywords[text] || text;
  }
  function nodeFilterResult(node, walker) {
    if (!(nodeMask(node) & walker.whatToShow)) return NodeFilter.FILTER_SKIP;
    const filter = walker.filter;
    if (!filter) return NodeFilter.FILTER_ACCEPT;
    if (typeof filter === 'function') return Number(filter(node)) || NodeFilter.FILTER_ACCEPT;
    if (typeof filter.acceptNode === 'function') return Number(filter.acceptNode(node)) || NodeFilter.FILTER_ACCEPT;
    return NodeFilter.FILTER_ACCEPT;
  }
  function nodeMask(node) {
    if (node?.nodeType === 1) return NodeFilter.SHOW_ELEMENT;
    if (node?.nodeType === 3) return NodeFilter.SHOW_TEXT;
    if (node?.nodeType === 8) return NodeFilter.SHOW_COMMENT;
    if (node?.nodeType === 9) return NodeFilter.SHOW_DOCUMENT;
    if (node?.nodeType === 11) return NodeFilter.SHOW_DOCUMENT_FRAGMENT;
    return 0;
  }
  function cacheKey(request) { return typeof request === 'string' ? resolveURL(request) : request.url; }
  function dash(prop) { return String(prop).replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase()); }


  function tableDirectChild(table, tag, create) {
    if (table.localName !== 'table') { if (create) throw namedError('InvalidStateError'); return null; }
    const existing = childArray(table).find((node) => node.localName === tag) || null;
    if (existing || !create) return existing;
    const child = table.ownerDocument.createElement(tag);
    const before = tag === 'caption' ? table.firstChild : null;
    table.insertBefore(child, before);
    return child;
  }

  function removeTableDirectChild(table, tag) {
    const child = tableDirectChild(table, tag, false);
    if (child?.parentNode) child.parentNode.removeChild(child);
  }

  function createTableBody(table) {
    if (table.localName !== 'table') throw namedError('InvalidStateError');
    const body = table.ownerDocument.createElement('tbody');
    table.appendChild(body);
    return body;
  }

  function tableBodies(table) {
    if (table?.localName !== 'table') return [];
    return childArray(table).filter((node) => node.localName === 'tbody');
  }

  function insertTableRow(container, index = -1) {
    const target = container.localName === 'table' ? tableRowTarget(container) : container;
    if (!tableRowContainer(target)) throw namedError('InvalidStateError');
    const row = target.ownerDocument.createElement('tr');
    const rows = tableRowsForContainer(target);
    const insertAt = normalizedInsertIndex(index, rows.length);
    target.insertBefore(row, rows[insertAt] || null);
    return row;
  }

  function deleteTableRow(container, index) {
    const rows = container.localName === 'table' ? tableRows(container) : tableRowsForContainer(container);
    const row = rows[normalizedExistingIndex(index, rows.length)];
    if (row?.parentNode) row.parentNode.removeChild(row);
  }

  function insertTableCell(row, index = -1) {
    if (row.localName !== 'tr') throw namedError('InvalidStateError');
    const cell = row.ownerDocument.createElement('td');
    const cells = rowCells(row);
    const insertAt = normalizedInsertIndex(index, cells.length);
    row.insertBefore(cell, cells[insertAt] || null);
    return cell;
  }

  function deleteTableCell(row, index) {
    const cell = rowCells(row)[normalizedExistingIndex(index, rowCells(row).length)];
    if (cell?.parentNode) cell.parentNode.removeChild(cell);
  }

  function tableRowTarget(table) {
    return tableBodies(table)[0] || createTableBody(table);
  }

  function tableRowContainer(element) {
    return ['table', 'thead', 'tbody', 'tfoot', 'tr'].includes(element?.localName);
  }

  function tableRowsForContainer(element) {
    if (element?.localName === 'table') return tableRows(element);
    if (['thead', 'tbody', 'tfoot'].includes(element?.localName)) return childArray(element).filter((node) => node.localName === 'tr');
    return [];
  }

  function rowCells(row) {
    if (row?.localName !== 'tr') return [];
    return childArray(row).filter((node) => node.localName === 'td' || node.localName === 'th');
  }

  function tableRowIndex(row) {
    if (row?.localName !== 'tr') return -1;
    const table = closestTable(row);
    return table ? tableRows(table).indexOf(row) : -1;
  }

  function sectionRowIndex(row) {
    if (row?.localName !== 'tr' || !row.parentNode) return -1;
    return tableRowsForContainer(row.parentNode).indexOf(row);
  }

  function tableCellIndex(cell) {
    if ((cell?.localName !== 'td' && cell?.localName !== 'th') || !cell.parentNode) return -1;
    return rowCells(cell.parentNode).indexOf(cell);
  }

  function closestTable(node) {
    for (let current = node; current; current = current.parentNode) {
      if (current.localName === 'table') return current;
    }
    return null;
  }

  function normalizedInsertIndex(index, length) {
    const numeric = Number(index);
    if (!Number.isInteger(numeric) || numeric < -1 || numeric > length) throw namedError('IndexSizeError');
    return numeric === -1 ? length : numeric;
  }

  function normalizedExistingIndex(index, length) {
    const numeric = Number(index);
    if (numeric === -1) return length - 1;
    if (!Number.isInteger(numeric) || numeric < 0 || numeric >= length) throw namedError('IndexSizeError');
    return numeric;
  }

  function tableRows(table) {
    if (table?.nodeType !== 1) return [];
    const out = [];
    collectRows(table, out);
    return out;
  }

  function collectRows(node, out) {
    for (const child of node.childNodes || []) {
      if (child.localName === 'tr') out.push(child);
      collectRows(child, out);
    }
  }

  function liveArray(items) {
    const list = [...items];
    list.item = (index) => list[Number(index)] || null;
    return list;
  }
  function loadStorageSnapshot(snapshot) {
    loadStorageAreas(snapshot);
    loadIndexedDBSnapshot(snapshot);
    loadCacheAPISnapshot(snapshot);
  }

  function loadStorageAreas(snapshot) {
    for (const area of ['localStorage', 'sessionStorage']) {
      storageMaps[area].clear();
      for (const pair of snapshot?.[area] || []) loadStoragePair(area, pair);
    }
  }

  function loadStoragePair(area, pair) {
    if (Array.isArray(pair) && pair.length >= 2) storageMaps[area].set(String(pair[0]), String(pair[1]));
  }

  function loadIndexedDBSnapshot(snapshot) {
    idbDatabases.clear();
    for (const pair of snapshot?.indexedDB || []) loadIndexedDBPair(pair);
  }

  function loadIndexedDBPair(pair) {
    if (Array.isArray(pair) && pair.length >= 2) idbDatabases.set(String(pair[0]), normalizeDatabaseRecord(String(pair[0]), pair[1]));
  }

  function loadCacheAPISnapshot(snapshot) {
    cacheMaps.clear();
    for (const entry of snapshot?.cacheAPI || []) loadCacheAPIEntry(entry);
  }

  function loadCacheAPIEntry(entry) {
    const name = String(entry.cacheName || 'default');
    if (!cacheMaps.has(name)) cacheMaps.set(name, new Map());
    cacheMaps.get(name).set(entry.request.key || cacheKey(entry.request.url), entry);
  }

  function storageUsageBytes() {
    return jsonByteLength(JSON.stringify({
      localStorage: [...storageMaps.localStorage.entries()],
      sessionStorage: [...storageMaps.sessionStorage.entries()],
      indexedDB: [...idbDatabases.entries()],
      cacheAPI: cacheAPISnapshot(),
    }));
  }

  function enforceVirtualStorageQuota(rollback) {
    if (storageUsageBytes() <= storageQuotaBytes) return;
    rollback();
    throw namedError('QuotaExceededError');
  }

  function cacheAPISnapshot() {
    const out = [];
    for (const [cacheName, entries] of cacheMaps) for (const entry of entries.values()) out.push({ cacheName, ...entry });
    return out;
  }

  function jsonByteLength(text) {
    let bytes = 0;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i += 1; }
      else bytes += 3;
    }
    return bytes;
  }


  const urlSearchParamsEntries = new WeakMap();
  const urlSearchParamsUpdate = new WeakMap();
  function getURLSearchParamsEntries(params) { return urlSearchParamsEntries.get(params) || []; }
  function setURLSearchParamsEntries(params, entries) { urlSearchParamsEntries.set(params, entries); }

  class URLSearchParams {
    constructor(init = '') {
      setURLSearchParamsEntries(this, urlSearchParamsInit(init));
      urlSearchParamsUpdate.set(this, null);
    }
    get size() { return getURLSearchParamsEntries(this).length; }
    append(name, value) { getURLSearchParamsEntries(this).push([String(name), String(value)]); commitURLSearchParams(this); }
    delete(name, ...values) {
      const key = String(name);
      const hasValue = values.length > 0;
      const expected = hasValue ? String(values[0]) : '';
      setURLSearchParamsEntries(this, getURLSearchParamsEntries(this).filter((entry) => entry[0] !== key || (hasValue && entry[1] !== expected)));
      commitURLSearchParams(this);
    }
    entries() { return getURLSearchParamsEntries(this)[Symbol.iterator](); }
    forEach(callback, thisArg = undefined) { for (const [key, value] of getURLSearchParamsEntries(this)) callback.call(thisArg, value, key, this); }
    get(name) {
      const key = String(name);
      const found = getURLSearchParamsEntries(this).find((entry) => entry[0] === key);
      return found ? found[1] : null;
    }
    getAll(name) {
      const key = String(name);
      return getURLSearchParamsEntries(this).filter((entry) => entry[0] === key).map((entry) => entry[1]);
    }
    has(name, ...values) {
      const key = String(name);
      if (values.length > 0) {
        const expected = String(values[0]);
        return getURLSearchParamsEntries(this).some((entry) => entry[0] === key && entry[1] === expected);
      }
      return getURLSearchParamsEntries(this).some((entry) => entry[0] === key);
    }
    keys() { return getURLSearchParamsEntries(this).map((entry) => entry[0])[Symbol.iterator](); }
    set(name, value) {
      const key = String(name);
      const next = [];
      let replaced = false;
      for (const entry of getURLSearchParamsEntries(this)) {
        if (entry[0] !== key) next.push(entry);
        else if (!replaced) { next.push([key, String(value)]); replaced = true; }
      }
      if (!replaced) next.push([key, String(value)]);
      setURLSearchParamsEntries(this, next);
      commitURLSearchParams(this);
    }
    sort() {
      setURLSearchParamsEntries(this, getURLSearchParamsEntries(this).map((entry, index) => ({ entry, index })).sort((a, b) => a.entry[0] < b.entry[0] ? -1 : a.entry[0] > b.entry[0] ? 1 : a.index - b.index).map((item) => item.entry));
      commitURLSearchParams(this);
    }
    toString() { return serializeURLSearchParams(getURLSearchParamsEntries(this)); }
    values() { return getURLSearchParamsEntries(this).map((entry) => entry[1])[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
  }
  for (const key of ['append', 'delete', 'get', 'getAll', 'has', 'set', 'sort', 'entries', 'forEach', 'keys', 'toString', 'values']) {
    const descriptor = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, key);
    Object.defineProperty(URLSearchParams.prototype, key, { ...descriptor, enumerable: true });
  }
  Object.defineProperty(URLSearchParams.prototype, Symbol.iterator, { value: URLSearchParams.prototype.entries, writable: true, configurable: true });
  Object.defineProperty(URLSearchParams.prototype, 'size', { get: Object.getOwnPropertyDescriptor(URLSearchParams.prototype, 'size').get, enumerable: true, configurable: true });
  Object.defineProperty(URLSearchParams.prototype, Symbol.toStringTag, { value: 'URLSearchParams', configurable: true });

  function makeURLSearchParams(init, update) {
    const params = new URLSearchParams(init);
    urlSearchParamsUpdate.set(params, update);
    return params;
  }

  function urlSearchParamsInit(init) {
    if (init instanceof URLSearchParams) return getURLSearchParamsEntries(init).map((entry) => [entry[0], entry[1]]);
    if (typeof init === 'string') return parseURLSearchParams(init);
    if (init && typeof init[Symbol.iterator] === 'function') return urlSearchParamsSequence(init);
    if (init && typeof init === 'object') return Object.keys(init).map((key) => [String(key), String(init[key])]);
    return [];
  }

  function urlSearchParamsSequence(init) {
    const out = [];
    for (const pair of init) {
      if (!pair || pair.length !== 2) throw new TypeError("Failed to construct 'URLSearchParams': Failed to construct 'URLSearchParams': Sequence initializer must only contain pair elements");
      out.push([String(pair[0]), String(pair[1])]);
    }
    return out;
  }

  function parseURLSearchParams(source) {
    try {
      if (typeof __zpParseURLSearchParams === 'function') return __zpParseURLSearchParams(String(source ?? '')).map((entry) => [String(entry[0]), String(entry[1])]);
    } catch {}
    return [];
  }

  function serializeURLSearchParams(entries) {
    try {
      if (typeof __zpSerializeURLSearchParams === 'function') return String(__zpSerializeURLSearchParams(JSON.stringify(entries)));
    } catch {}
    return entries.map((entry) => encodeURIComponent(entry[0]) + '=' + encodeURIComponent(entry[1])).join('&');
  }

  function commitURLSearchParams(params) {
    const update = urlSearchParamsUpdate.get(params);
    if (typeof update === 'function') update(params.toString());
  }

  function installObjectURLSupport() {
    const URLCtor = typeof globalThis.URL === 'function' ? globalThis.URL : VirtualURL;
    Object.defineProperty(URLCtor, 'canParse', { value: urlCanParse, writable: true, enumerable: true, configurable: true });
    Object.defineProperty(URLCtor, 'parse', { value: urlParse, writable: true, enumerable: true, configurable: true });
    Object.defineProperty(URLCtor, 'createObjectURL', { value: createObjectURL, writable: true, enumerable: true, configurable: true });
    if (typeof globalThis.URLSearchParams !== 'function') Object.defineProperty(globalThis, 'URLSearchParams', { value: URLSearchParams, writable: true, configurable: true });
    globalThis.URLPattern = URLPattern;
    Object.defineProperty(URLCtor, 'revokeObjectURL', { value: revokeObjectURL, writable: true, enumerable: true, configurable: true });
    globalThis.URL = URLCtor;
    globalThis.webkitURL = URLCtor;
    Object.defineProperty(globalThis, '__zpResolveBlobURL', { value: resolveBlobURL, configurable: true });
  }

  const virtualURLHref = new WeakMap();
  const virtualURLSearchParams = new WeakMap();
  function getVirtualURLHref(url) { return virtualURLHref.get(url) || ''; }
  function setVirtualURLHref(url, href) {
    virtualURLHref.set(url, href);
    syncVirtualURLSearchParams(url);
  }
  function syncVirtualURLSearchParams(url) {
    const params = virtualURLSearchParams.get(url);
    if (params) setURLSearchParamsEntries(params, parseURLSearchParams(parsedURL(getVirtualURLHref(url)).search));
  }

  function VirtualURL(value, base) {
    const record = requiredURLRecord(value, base, arguments.length);
    setVirtualURLHref(this, record.href);
  }
  Object.defineProperties(VirtualURL.prototype, {
    href: { get() { return getVirtualURLHref(this); }, set(value) { const record = hostParseURL(String(value), undefined); if (!record) throw new TypeError("Failed to set the 'href' property on 'URL': Invalid URL"); setVirtualURLHref(this, record.href); }, enumerable: true, configurable: true },
    origin: { get() { return parsedURL(getVirtualURLHref(this)).origin; }, enumerable: true, configurable: true },
    protocol: { get() { return parsedURL(getVirtualURLHref(this)).protocol; }, set(value) { setVirtualURLPart(this, 'protocol', value); }, enumerable: true, configurable: true },
    username: { get() { return parsedURL(getVirtualURLHref(this)).username; }, set(value) { setVirtualURLPart(this, 'username', value); }, enumerable: true, configurable: true },
    password: { get() { return parsedURL(getVirtualURLHref(this)).password; }, set(value) { setVirtualURLPart(this, 'password', value); }, enumerable: true, configurable: true },
    host: { get() { return parsedURL(getVirtualURLHref(this)).host; }, set(value) { setVirtualURLPart(this, 'host', value); }, enumerable: true, configurable: true },
    hostname: { get() { return parsedURL(getVirtualURLHref(this)).hostname; }, set(value) { setVirtualURLPart(this, 'hostname', value); }, enumerable: true, configurable: true },
    port: { get() { return parsedURL(getVirtualURLHref(this)).port; }, set(value) { setVirtualURLPart(this, 'port', value); }, enumerable: true, configurable: true },
    pathname: { get() { return parsedURL(getVirtualURLHref(this)).pathname; }, set(value) { setVirtualURLPart(this, 'pathname', value); }, enumerable: true, configurable: true },
    search: { get() { return parsedURL(getVirtualURLHref(this)).search; }, set(value) { setVirtualURLPart(this, 'search', value); }, enumerable: true, configurable: true },
    searchParams: { get() { let params = virtualURLSearchParams.get(this); if (!params) { params = makeURLSearchParams(this.search, (query) => setVirtualURLPart(this, 'search', query ? '?' + query : '')); virtualURLSearchParams.set(this, params); } return params; }, enumerable: true, configurable: true },
    hash: { get() { return parsedURL(getVirtualURLHref(this)).hash; }, set(value) { setVirtualURLPart(this, 'hash', value); }, enumerable: true, configurable: true },
  });
  const virtualURLPrototypeMethods = {
    toString() { return this.href; },
    toJSON() { return this.href; },
  };
  Object.defineProperty(VirtualURL.prototype, 'toString', { value: virtualURLPrototypeMethods.toString, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(VirtualURL.prototype, 'toJSON', { value: virtualURLPrototypeMethods.toJSON, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(VirtualURL.prototype, Symbol.toStringTag, { value: 'URL', configurable: true });
  try {
    Object.defineProperty(VirtualURL, 'name', { value: 'URL', configurable: true });
    Object.defineProperty(VirtualURL, 'length', { value: 1, configurable: true });
  } catch {}

  const urlCanParse = (...args) => {
    if (args.length < 1) throw new TypeError("Failed to execute 'canParse' on 'URL': 1 argument required, but only 0 present.");
    return hostParseURL(String(args[0]), args.length >= 2 ? String(args[1]) : undefined) !== null;
  };
  const urlParse = (...args) => {
    if (args.length < 1) throw new TypeError("Failed to execute 'parse' on 'URL': 1 argument required, but only 0 present.");
    const record = hostParseURL(String(args[0]), args.length >= 2 ? String(args[1]) : undefined);
    return record ? new VirtualURL(record.href) : null;
  };
  try {
    Object.defineProperty(urlCanParse, 'name', { value: 'canParse', configurable: true });
    Object.defineProperty(urlCanParse, 'length', { value: 1, configurable: true });
    Object.defineProperty(urlParse, 'name', { value: 'parse', configurable: true });
    Object.defineProperty(urlParse, 'length', { value: 1, configurable: true });
  } catch {}

  function requiredURLRecord(value, base, argumentCount) {
    if (argumentCount < 1) throw new TypeError("Failed to construct 'URL': 1 argument required, but only 0 present.");
    const baseProvided = argumentCount >= 2;
    const record = hostParseURL(String(value), baseProvided ? String(base) : undefined);
    if (record) return record;
    if (baseProvided && hostParseURL(String(base), undefined) === null) throw new TypeError("Failed to construct 'URL': Invalid base URL");
    throw new TypeError("Failed to construct 'URL': Invalid URL");
  }

  class URLPattern {
    constructor(input = {}, baseURL = undefined) {
      const bridged = hostBridgeConstruct('URLPattern', Array.from(arguments));
      if (bridged.handled) {
        urlPatternState.set(this, { handle: bridged.value.handle || '', fields: bridged.value.fields || {} });
        return;
      }
      const init = normalizeURLPatternInit(input, baseURL);
      urlPatternState.set(this, { fields: {
        protocol: init.protocol,
        username: init.username,
        password: init.password,
        hostname: init.hostname,
        port: init.port,
        pathname: init.pathname,
        search: init.search,
        hash: init.hash,
        hasRegExpGroups: false,
      } });
    }
    test(input = {}, baseURL = undefined) {
      const bridged = hostBridgeMethod(this, 'URLPattern', 'test', Array.from(arguments));
      if (bridged.handled) return Boolean(bridged.value);
      return Boolean(this.exec(input, baseURL));
    }
    exec(input = {}, baseURL = undefined) {
      const bridged = hostBridgeMethod(this, 'URLPattern', 'exec', Array.from(arguments));
      if (bridged.handled) return bridged.value;
      const candidate = normalizeURLPatternCandidate(input, baseURL);
      if (!candidate) return null;
      for (const part of urlPatternParts) {
        if (!matchURLPatternComponent(this[part], candidate[part])) return null;
      }
      const result = { inputs: [input], protocol: componentResult(candidate.protocol), username: componentResult(candidate.username), password: componentResult(candidate.password), hostname: componentResult(candidate.hostname), port: componentResult(candidate.port), pathname: componentResult(candidate.pathname), search: componentResult(candidate.search), hash: componentResult(candidate.hash) };
      return result;
    }
  }
  Object.defineProperty(URLPattern.prototype, Symbol.toStringTag, { value: 'URLPattern', configurable: true });
  const urlPatternAccessorDescriptors = Object.getOwnPropertyDescriptors({
    get protocol() { return urlPatternField(this, 'protocol'); },
    get username() { return urlPatternField(this, 'username'); },
    get password() { return urlPatternField(this, 'password'); },
    get hostname() { return urlPatternField(this, 'hostname'); },
    get port() { return urlPatternField(this, 'port'); },
    get pathname() { return urlPatternField(this, 'pathname'); },
    get search() { return urlPatternField(this, 'search'); },
    get hash() { return urlPatternField(this, 'hash'); },
    get hasRegExpGroups() { return Boolean(urlPatternField(this, 'hasRegExpGroups')); },
  });
  for (const key of ['protocol', 'username', 'password', 'hostname', 'port', 'pathname', 'search', 'hash', 'hasRegExpGroups']) {
    Object.defineProperty(URLPattern.prototype, key, { ...urlPatternAccessorDescriptors[key], enumerable: true, configurable: true });
  }

  const urlPatternState = new WeakMap();
  const autoHostBridgeState = new WeakMap();
  const urlPatternParts = ['protocol', 'username', 'password', 'hostname', 'port', 'pathname', 'search', 'hash'];

  function urlPatternField(pattern, field) {
    return urlPatternState.get(pattern)?.fields?.[field] ?? '';
  }

  function hostBridgeGlobalFunction(globalName, args) {
    const list = [];
    for (let index = 0; index < args.length; index += 1) list.push(args[index]);
    return hostBridgeCall({ op: 'call', globalName, args: list });
  }

  function hostBridgeConstruct(globalName, args) {
    return hostBridgeCall({ op: 'construct', globalName, args });
  }

  function hostBridgeStatic(globalName, method, args) {
    return hostBridgeCall({ op: 'static', globalName, method, args });
  }

  function hostBridgeMethod(target, globalName, method, args) {
    const handle = target?.__zpHostBridge || urlPatternState.get(target)?.handle;
    if (!handle) return { handled: false, value: undefined };
    return hostBridgeCall({ op: 'method', globalName, method, handle, args });
  }

  function hostBridgeCall(payload) {
    try {
      if (typeof __zpHostWebAPIBridge !== 'function') return { handled: false, value: undefined };
      const response = __zpHostWebAPIBridge(JSON.stringify(payload));
      if (!response || response.unavailable) return { handled: false, value: undefined };
      if (response.ok === true) return { handled: true, value: response.value, mutatedArgs: response.mutatedArgs || {} };
      throwHostBridgeError(response.error);
    } catch (error) {
      if (error?.__zpHostBridgeThrown) throw error.cause;
      return { handled: false, value: undefined };
    }
    return { handled: false, value: undefined };
  }

  function throwHostBridgeError(error) {
    const name = String(error?.name || 'Error');
    const message = String(error?.message || name);
    let thrown;
    const Ctor = globalThis[name];
    try {
      thrown = typeof Ctor === 'function' ? new Ctor(message) : new Error(message);
    } catch {
      thrown = new Error(message);
    }
    thrown.name = name;
    const wrapper = new Error(message);
    wrapper.cause = thrown;
    wrapper.__zpHostBridgeThrown = true;
    throw wrapper;
  }

  function normalizeURLPatternInit(input, baseURL) {
    if (typeof input === 'string') return urlPatternInitFromURL(input, baseURL);
    if (!input || typeof input !== 'object') return urlPatternInitFromURL(String(input), baseURL);
    return {
      protocol: patternComponent(input.protocol, '*', ':'),
      username: patternComponent(input.username, ''),
      password: patternComponent(input.password, ''),
      hostname: patternComponent(input.hostname, '*'),
      port: patternComponent(input.port, ''),
      pathname: patternComponent(input.pathname, '*'),
      search: patternComponent(input.search, '*', '?'),
      hash: patternComponent(input.hash, '*', '#'),
    };
  }

  function urlPatternInitFromURL(input, baseURL) {
    const parsed = parsedURL(input, baseURL || currentURLBase());
    return {
      protocol: parsed.protocol.replace(/:$/, ''),
      username: parsed.username || '',
      password: parsed.password || '',
      hostname: parsed.hostname || '',
      port: parsed.port || '',
      pathname: parsed.pathname,
      search: parsed.search.replace(/^\?/, ''),
      hash: parsed.hash.replace(/^#/, ''),
    };
  }

  function normalizeURLPatternCandidate(input, baseURL) {
    try {
      if (input && typeof input === 'object' && typeof input.href !== 'string') return normalizeURLPatternInit(input, baseURL);
      const parsed = parsedURL(input && typeof input === 'object' ? input.href : input, baseURL || currentURLBase());
      return {
        protocol: parsed.protocol.replace(/:$/, ''),
        username: parsed.username || '',
        password: parsed.password || '',
        hostname: parsed.hostname || '',
        port: parsed.port || '',
        pathname: parsed.pathname,
        search: parsed.search.replace(/^\?/, ''),
        hash: parsed.hash.replace(/^#/, ''),
      };
    } catch {
      return null;
    }
  }

  function patternComponent(value, fallback, prefix = '') {
    if (value === undefined || value === null) return fallback;
    let out = String(value);
    if (prefix && out.startsWith(prefix)) out = out.slice(1);
    return out;
  }

  function matchURLPatternComponent(pattern, value) {
    if (pattern === '*') return true;
    if (pattern === '') return value === '';
    const source = '^' + String(pattern).split('*').map(escapeURLPatternRegex).join('.*') + '$';
    return new RegExp(source).test(String(value));
  }

  function escapeURLPatternRegex(value) {
    return String(value).replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }

  function componentResult(input) {
    return { input: String(input), groups: {} };
  }

  function setVirtualURLPart(url, part, value) {
    const href = setURLPart(getVirtualURLHref(url), part, value);
    if (href) setVirtualURLHref(url, href);
  }

  function createObjectURL(value) {
    if (!(value instanceof Blob)) throw new TypeError("Failed to execute 'createObjectURL' on 'URL': Overload resolution failed.");
    const url = 'blob:' + (parsedURL(currentURLBase()).origin || 'null') + '/zp-' + nextBlobURLID++;
    blobURLRegistry.set(url, value);
    return url;
  }

  function revokeObjectURL(url) {
    blobURLRegistry.delete(String(url));
  }

  function resolveBlobURL(url) {
    const blob = blobURLRegistry.get(String(url));
    if (!blob) throw new TypeError('Failed to fetch');
    return blob;
  }
  function installWindowEventTarget() {
    if (typeof globalThis.addEventListener === 'function' && typeof globalThis.dispatchEvent === 'function') return;
    const bus = new EventTarget();
    globalThis.addEventListener = bus.addEventListener.bind(bus);
    globalThis.removeEventListener = bus.removeEventListener.bind(bus);
    globalThis.dispatchEvent = bus.dispatchEvent.bind(bus);
  }

  function InputDeviceCapabilities(init = {}) {
    if (!new.target) throw new TypeError("Failed to construct 'InputDeviceCapabilities': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    inputDeviceCapabilitiesSlots.set(this, { firesTouchEvents: Boolean(init.firesTouchEvents) });
  }
  delete InputDeviceCapabilities.prototype.constructor;
  Object.defineProperties(InputDeviceCapabilities.prototype, {
    firesTouchEvents: { get() {
      const state = inputDeviceCapabilitiesSlots.get(this);
      if (!state) throw new TypeError('Illegal invocation');
      return state.firesTouchEvents;
    }, enumerable: true, configurable: true },
    constructor: { value: InputDeviceCapabilities, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(InputDeviceCapabilities.prototype, Symbol.toStringTag, { value: 'InputDeviceCapabilities', configurable: true });

  const trustedHTMLSlots = new WeakMap();
  const trustedScriptSlots = new WeakMap();
  const trustedScriptURLSlots = new WeakMap();
  const trustedPolicySlots = new WeakMap();
  const trustedFactorySlots = new WeakMap();

  function TrustedHTML() {
    if (new.target) throw new TypeError("Failed to construct 'TrustedHTML': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  function TrustedScript() {
    if (new.target) throw new TypeError("Failed to construct 'TrustedScript': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  function TrustedScriptURL() {
    if (new.target) throw new TypeError("Failed to construct 'TrustedScriptURL': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  function TrustedTypePolicy() {
    if (new.target) throw new TypeError("Failed to construct 'TrustedTypePolicy': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  function TrustedTypePolicyFactory() {
    if (new.target) throw new TypeError("Failed to construct 'TrustedTypePolicyFactory': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }

  function trustedValueSlots(value) {
    return trustedHTMLSlots.get(value) || trustedScriptSlots.get(value) || trustedScriptURLSlots.get(value);
  }
  function trustedValue(value) {
    const state = trustedValueSlots(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state.value;
  }
  const trustedValueToJSON = function toJSON() { return trustedValue(this); };
  const trustedValueToString = function toString() { return trustedValue(this); };
  function makeTrustedValue(Constructor, slots, value) {
    const trustedValueObject = Object.create(Constructor.prototype);
    slots.set(trustedValueObject, { value: String(value || '') });
    return trustedValueObject;
  }
  function missingTrustedPolicyMember(policyName, methodName) {
    return new TypeError(`Failed to execute '${methodName}' on 'TrustedTypePolicy': Policy ${policyName}'s TrustedTypePolicyOptions did not specify a '${methodName}' member.`);
  }
  function trustedPolicyValue(policy, method) {
    const state = trustedPolicySlots.get(policy);
    if (!state) throw new TypeError(`Failed to execute '${method}' on 'TrustedTypePolicy': Illegal invocation`);
    return state;
  }
  function makeTrustedPolicy(policyName, options = {}) {
    const name = String(policyName);
    const policy = Object.create(TrustedTypePolicy.prototype);
    trustedPolicySlots.set(policy, { name, options: options || {} });
    return policy;
  }
  function trustedFactoryValue(factory, method) {
    const state = trustedFactorySlots.get(factory);
    if (!state) throw new TypeError(`Failed to execute '${method}' on 'TrustedTypePolicyFactory': Illegal invocation`);
    return state;
  }
  function makeTrustedTypePolicyFactory() {
    const factory = Object.create(TrustedTypePolicyFactory.prototype);
    trustedFactorySlots.set(factory, {
      emptyHTML: makeTrustedValue(TrustedHTML, trustedHTMLSlots, ''),
      emptyScript: makeTrustedValue(TrustedScript, trustedScriptSlots, ''),
      defaultPolicy: null,
    });
    return factory;
  }

  for (const Constructor of [TrustedHTML, TrustedScript, TrustedScriptURL]) {
    delete Constructor.prototype.constructor;
    Object.defineProperties(Constructor.prototype, {
      toJSON: { value: trustedValueToJSON, enumerable: true, writable: true, configurable: true },
      toString: { value: trustedValueToString, enumerable: true, writable: true, configurable: true },
      constructor: { value: Constructor, enumerable: false, writable: true, configurable: true },
    });
  }
  Object.defineProperty(TrustedHTML.prototype, Symbol.toStringTag, { value: 'TrustedHTML', configurable: true });
  Object.defineProperty(TrustedScript.prototype, Symbol.toStringTag, { value: 'TrustedScript', configurable: true });
  Object.defineProperty(TrustedScriptURL.prototype, Symbol.toStringTag, { value: 'TrustedScriptURL', configurable: true });
  delete TrustedTypePolicy.prototype.constructor;
  Object.defineProperties(TrustedTypePolicy.prototype, {
    name: { get() { return trustedPolicyValue(this, 'name').name; }, enumerable: true, configurable: true },
    createHTML: {
      value: function createHTML(input) {
        const state = trustedPolicyValue(this, 'createHTML');
        if (typeof state.options.createHTML !== 'function') throw missingTrustedPolicyMember(state.name, 'createHTML');
        return makeTrustedValue(TrustedHTML, trustedHTMLSlots, state.options.createHTML(String(input)));
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    createScript: {
      value: function createScript(input) {
        const state = trustedPolicyValue(this, 'createScript');
        if (typeof state.options.createScript !== 'function') throw missingTrustedPolicyMember(state.name, 'createScript');
        return makeTrustedValue(TrustedScript, trustedScriptSlots, state.options.createScript(String(input)));
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    createScriptURL: {
      value: function createScriptURL(input) {
        const state = trustedPolicyValue(this, 'createScriptURL');
        if (typeof state.options.createScriptURL !== 'function') throw missingTrustedPolicyMember(state.name, 'createScriptURL');
        return makeTrustedValue(TrustedScriptURL, trustedScriptURLSlots, state.options.createScriptURL(String(input)));
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    constructor: { value: TrustedTypePolicy, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(TrustedTypePolicy.prototype, Symbol.toStringTag, { value: 'TrustedTypePolicy', configurable: true });
  delete TrustedTypePolicyFactory.prototype.constructor;
  Object.defineProperties(TrustedTypePolicyFactory.prototype, {
    emptyHTML: { get() { return trustedFactoryValue(this, 'emptyHTML').emptyHTML; }, enumerable: true, configurable: true },
    emptyScript: { get() { return trustedFactoryValue(this, 'emptyScript').emptyScript; }, enumerable: true, configurable: true },
    defaultPolicy: { get() { return trustedFactoryValue(this, 'defaultPolicy').defaultPolicy; }, enumerable: true, configurable: true },
    createPolicy: {
      value: function createPolicy(policyName, options = {}) {
        trustedFactoryValue(this, 'createPolicy');
        if (arguments.length < 1) throw new TypeError("Failed to execute 'createPolicy' on 'TrustedTypePolicyFactory': 1 argument required, but only 0 present.");
        return makeTrustedPolicy(policyName, options || {});
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    getAttributeType: { value: function getAttributeType(element, attribute) { void element; void attribute; trustedFactoryValue(this, 'getAttributeType'); return null; }, enumerable: true, writable: true, configurable: true },
    getPropertyType: { value: function getPropertyType(element, property) { void element; void property; trustedFactoryValue(this, 'getPropertyType'); return null; }, enumerable: true, writable: true, configurable: true },
    getTypeMapping: { value: function getTypeMapping() { trustedFactoryValue(this, 'getTypeMapping'); return null; }, enumerable: true, writable: true, configurable: true },
    isHTML: { value: function isHTML(value) { trustedFactoryValue(this, 'isHTML'); return trustedHTMLSlots.has(value); }, enumerable: true, writable: true, configurable: true },
    isScript: { value: function isScript(value) { trustedFactoryValue(this, 'isScript'); return trustedScriptSlots.has(value); }, enumerable: true, writable: true, configurable: true },
    isScriptURL: { value: function isScriptURL(value) { trustedFactoryValue(this, 'isScriptURL'); return trustedScriptURLSlots.has(value); }, enumerable: true, writable: true, configurable: true },
    constructor: { value: TrustedTypePolicyFactory, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(TrustedTypePolicyFactory.prototype, Symbol.toStringTag, { value: 'TrustedTypePolicyFactory', configurable: true });


  function installEventConstructors() {
    const BaseEvent = globalThis.Event || class Event {};

    function requiredEventType(name, args) {
      if (args.length < 1) throw new TypeError(`Failed to construct '${name}': 1 argument required, but only 0 present.`);
      return String(args[0]);
    }

    function eventInitDictionary(args) {
      const init = args.length > 1 ? args[1] : {};
      return init === null || init === undefined ? {} : Object(init);
    }

    function requiredEventDictionary(name, args, dictionaryName) {
      if (args.length < 1 || args[0] === null || typeof args[0] !== 'object') throw new TypeError(`Failed to construct '${name}': The provided value is not of type '${dictionaryName}'.`);
      return args[0];
    }

    function requiredDictionaryMember(name, dictionaryName, init, key) {
      if (init[key] === undefined) throw new TypeError(`Failed to construct '${name}': Failed to read the '${key}' property from '${dictionaryName}': Required member is undefined.`);
      return init[key];
    }

    function saveEventMethodDescriptors(proto, entries) {
      const descriptors = new Map();
      for (const entry of entries) {
        if (!entry?.method) continue;
        descriptors.set(entry.method, Object.getOwnPropertyDescriptor(proto, entry.method));
        delete proto[entry.method];
      }
      return descriptors;
    }

    function eventPayloadGetter(stateMap, key) {
      return function getEventPayloadValue() {
        const state = stateMap.get(this);
        if (!state) throw new TypeError('Illegal invocation');
        return state[key];
      };
    }

    function defineEventPayloadGetter(proto, stateMap, key) {
      Object.defineProperty(proto, key, {
        get: eventPayloadGetter(stateMap, key),
        enumerable: true,
        configurable: true,
      });
    }

    function defineEventMethod(proto, methodDescriptors, methodName) {
      const descriptor = methodDescriptors.get(methodName);
      if (!descriptor) return;
      Object.defineProperty(proto, methodName, {
        ...descriptor,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }

    function defineEventConstant(Ctor, name, value) {
      const descriptor = { value, enumerable: true, configurable: false };
      Object.defineProperty(Ctor, name, descriptor);
      Object.defineProperty(Ctor.prototype, name, descriptor);
    }

    function defineEventPrototypeEntry(Ctor, stateMap, methodDescriptors, entry) {
      if (typeof entry === 'string') {
        defineEventPayloadGetter(Ctor.prototype, stateMap, entry);
        return;
      }
      if (entry?.method) {
        defineEventMethod(Ctor.prototype, methodDescriptors, entry.method);
        return;
      }
      if (entry?.constant) defineEventConstant(Ctor, entry.constant, entry.value);
    }

    function defineEventPrototype(Ctor, stateMap, entries) {
      const proto = Ctor.prototype;
      const constructorDescriptor = Object.getOwnPropertyDescriptor(proto, 'constructor');
      delete proto.constructor;
      const methodDescriptors = saveEventMethodDescriptors(proto, entries);
      for (const entry of entries) defineEventPrototypeEntry(Ctor, stateMap, methodDescriptors, entry);
      Object.defineProperty(proto, 'constructor', constructorDescriptor);
    }

    function eventTargetOrNull(value) {
      return value === null || value === undefined ? null : value;
    }

    const customEventState = new WeakMap();
    class CustomEvent extends BaseEvent {
      constructor(type, init = {}) {
        const eventType = requiredEventType('CustomEvent', arguments);
        const eventInit = eventInitDictionary(arguments);
        super(eventType, eventInit);
        customEventState.set(this, { detail: eventInit.detail ?? null });
      }
      initCustomEvent(type, bubbles = false, cancelable = false, detail = null) {
        this.initEvent(type, bubbles, cancelable);
        customEventState.set(this, { detail });
      }
    }
    defineEventPrototype(CustomEvent, customEventState, ['detail', { method: 'initCustomEvent' }]);

    const uiEventState = new WeakMap();
    class UIEvent extends BaseEvent {
      constructor(type, init = {}) {
        const eventType = requiredEventType('UIEvent', arguments);
        const eventInit = eventInitDictionary(arguments);
        super(eventType, eventInit);
        uiEventState.set(this, uiEventPayload(eventInit));
      }
      initUIEvent(type, bubbles = false, cancelable = false, view = null, detail = 0) {
        this.initEvent(type, bubbles, cancelable);
        uiEventState.set(this, uiEventPayload({ view, detail }));
      }
    }
    function uiEventPayload(init = {}) {
      return {
        view: init.view ?? null,
        detail: eventFiniteNumber(init.detail, 0, 'detail'),
        sourceCapabilities: init.sourceCapabilities ?? null,
        which: eventFiniteNumber(init.which, 0, 'which'),
      };
    }
    function updateUIEventWhich(event, value) {
      const state = uiEventState.get(event);
      if (state) state.which = value;
    }
    defineEventPrototype(UIEvent, uiEventState, ['view', 'detail', 'sourceCapabilities', 'which', { method: 'initUIEvent' }]);

    const mouseEventState = new WeakMap();
    class MouseEvent extends UIEvent {
      constructor(type, init = {}) {
        const eventType = requiredEventType('MouseEvent', arguments);
        const eventInit = eventInitDictionary(arguments);
        super(eventType, eventInit);
        const payload = mouseEventPayload(eventInit);
        mouseEventState.set(this, payload);
        updateUIEventWhich(this, payload.button + 1);
      }
      getModifierState(keyArg) { return eventModifierState(this, keyArg); }
      initMouseEvent(type, bubbles = false, cancelable = false, view = null, detail = 0, screenX = 0, screenY = 0, clientX = 0, clientY = 0, ctrlKey = false, altKey = false, shiftKey = false, metaKey = false, button = 0, relatedTarget = null) {
        this.initUIEvent(type, bubbles, cancelable, view, detail);
        const payload = mouseEventPayload({ screenX, screenY, clientX, clientY, ctrlKey, altKey, shiftKey, metaKey, button, relatedTarget });
        mouseEventState.set(this, payload);
        updateUIEventWhich(this, payload.button + 1);
      }
    }
    function mouseEventPayload(init = {}) {
      const clientX = eventFiniteNumber(init.clientX, 0, 'clientX');
      const clientY = eventFiniteNumber(init.clientY, 0, 'clientY');
      const button = eventFiniteNumber(init.button, 0, 'button');
      const relatedTarget = eventTargetOrNull(init.relatedTarget);
      return {
        screenX: eventFiniteNumber(init.screenX, 0, 'screenX'),
        screenY: eventFiniteNumber(init.screenY, 0, 'screenY'),
        clientX,
        clientY,
        ctrlKey: Boolean(init.ctrlKey),
        shiftKey: Boolean(init.shiftKey),
        altKey: Boolean(init.altKey),
        metaKey: Boolean(init.metaKey),
        button,
        buttons: eventFiniteNumber(init.buttons, 0, 'buttons'),
        relatedTarget,
        pageX: clientX,
        pageY: clientY,
        x: clientX,
        y: clientY,
        offsetX: clientX,
        offsetY: clientY,
        movementX: eventFiniteNumber(init.movementX, 0, 'movementX'),
        movementY: eventFiniteNumber(init.movementY, 0, 'movementY'),
        fromElement: relatedTarget,
        toElement: null,
        layerX: clientX,
        layerY: clientY,
      };
    }
    defineEventPrototype(MouseEvent, mouseEventState, ['screenX', 'screenY', 'clientX', 'clientY', 'ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'button', 'buttons', 'relatedTarget', 'pageX', 'pageY', 'x', 'y', 'offsetX', 'offsetY', 'movementX', 'movementY', 'fromElement', 'toElement', 'layerX', 'layerY', { method: 'getModifierState' }, { method: 'initMouseEvent' }]);

    const pointerEventState = new WeakMap();
    class PointerEvent extends MouseEvent {
      constructor(type, init = {}) {
        const eventType = requiredEventType('PointerEvent', arguments);
        const eventInit = eventInitDictionary(arguments);
        super(eventType, eventInit);
        pointerEventState.set(this, {
          pointerId: eventFiniteNumber(eventInit.pointerId, 0, 'pointerId'),
          width: eventFiniteNumber(eventInit.width, 1, 'width'),
          height: eventFiniteNumber(eventInit.height, 1, 'height'),
          pressure: eventFiniteNumber(eventInit.pressure, 0, 'pressure'),
          tiltX: eventFiniteNumber(eventInit.tiltX, 0, 'tiltX'),
          tiltY: eventFiniteNumber(eventInit.tiltY, 0, 'tiltY'),
          azimuthAngle: eventFiniteNumber(eventInit.azimuthAngle, 0, 'azimuthAngle'),
          altitudeAngle: eventFiniteNumber(eventInit.altitudeAngle, Math.PI / 2, 'altitudeAngle'),
          tangentialPressure: eventFiniteNumber(eventInit.tangentialPressure, 0, 'tangentialPressure'),
          twist: eventFiniteNumber(eventInit.twist, 0, 'twist'),
          pointerType: String(eventInit.pointerType || ''),
          isPrimary: Boolean(eventInit.isPrimary),
          persistentDeviceId: eventFiniteNumber(eventInit.persistentDeviceId, 0, 'persistentDeviceId'),
        });
      }
      getPredictedEvents() { return []; }
    }
    defineEventPrototype(PointerEvent, pointerEventState, ['pointerId', 'width', 'height', 'pressure', 'tiltX', 'tiltY', 'azimuthAngle', 'altitudeAngle', 'tangentialPressure', 'twist', 'pointerType', 'isPrimary', { method: 'getPredictedEvents' }, 'persistentDeviceId']);

    const touchState = new WeakMap();
    class Touch {
      constructor(init = {}) {
        const eventInit = requiredEventDictionary('Touch', arguments, 'TouchInit');
        const identifier = requiredDictionaryMember('Touch', 'TouchInit', eventInit, 'identifier');
        const target = requiredDictionaryMember('Touch', 'TouchInit', eventInit, 'target');
        touchState.set(this, {
          identifier: eventFiniteNumber(identifier, 0, 'identifier'),
          target,
          screenX: eventFiniteNumber(eventInit.screenX, 0, 'screenX'),
          screenY: eventFiniteNumber(eventInit.screenY, 0, 'screenY'),
          clientX: eventFiniteNumber(eventInit.clientX, 0, 'clientX'),
          clientY: eventFiniteNumber(eventInit.clientY, 0, 'clientY'),
          pageX: eventFiniteNumber(eventInit.pageX, eventInit.clientX === undefined ? 0 : Number(eventInit.clientX), 'pageX'),
          pageY: eventFiniteNumber(eventInit.pageY, eventInit.clientY === undefined ? 0 : Number(eventInit.clientY), 'pageY'),
          radiusX: eventFiniteNumber(eventInit.radiusX, 0, 'radiusX'),
          radiusY: eventFiniteNumber(eventInit.radiusY, 0, 'radiusY'),
          rotationAngle: eventFiniteNumber(eventInit.rotationAngle, 0, 'rotationAngle'),
          force: eventFiniteNumber(eventInit.force, 0, 'force'),
        });
      }
    }
    defineEventPrototype(Touch, touchState, ['identifier', 'target', 'screenX', 'screenY', 'clientX', 'clientY', 'pageX', 'pageY', 'radiusX', 'radiusY', 'rotationAngle', 'force']);

    const touchListToken = {};
    const touchListState = new WeakMap();
    class TouchList {
      constructor(token, items = []) {
        if (token !== touchListToken) throw new TypeError("Failed to construct 'TouchList': Illegal constructor");
        const list = Array.from(items || []);
        touchListState.set(this, list);
        let index = 0;
        for (const touch of list) Object.defineProperty(this, index++, { value: touch, enumerable: true, configurable: true });
      }
      item(index) { return touchListState.get(this)?.[Number(index)] ?? null; }
      *[Symbol.iterator]() {
        const list = touchListState.get(this);
        if (!list) throw new TypeError('Illegal invocation');
        for (const touch of list) yield touch;
      }
    }
    defineEventPrototype(TouchList, touchListState, ['length', { method: 'item' }]);
    function* touchListValues() {
      const list = touchListState.get(this);
      if (!list) throw new TypeError('Illegal invocation');
      for (const touch of list) yield touch;
    }
    Object.defineProperty(touchListValues, 'name', { value: 'values', configurable: true });
    Object.defineProperty(TouchList.prototype, Symbol.iterator, { value: touchListValues, writable: true, configurable: true });
    function makeTouchList(items) { return new TouchList(touchListToken, Array.from(items || [])); }

    const focusEventState = new WeakMap();
    class FocusEvent extends UIEvent {
      constructor(type, init = {}) {
        const eventType = requiredEventType('FocusEvent', arguments);
        const eventInit = eventInitDictionary(arguments);
        super(eventType, eventInit);
        focusEventState.set(this, { relatedTarget: eventTargetOrNull(eventInit.relatedTarget) });
      }
    }
    defineEventPrototype(FocusEvent, focusEventState, ['relatedTarget']);

    const keyboardEventState = new WeakMap();
    class KeyboardEvent extends UIEvent {
      constructor(type, init = {}) {
        const eventType = requiredEventType('KeyboardEvent', arguments);
        const eventInit = eventInitDictionary(arguments);
        super(eventType, eventInit);
        keyboardEventState.set(this, keyboardEventPayload(eventInit));
      }
      getModifierState(keyArg) { return eventModifierState(this, keyArg); }
      initKeyboardEvent(type, bubbles = false, cancelable = false, view = null, key = '', location = 0, ctrlKey = false, altKey = false, shiftKey = false, metaKey = false) {
        this.initUIEvent(type, bubbles, cancelable, view, 0);
        keyboardEventState.set(this, keyboardEventPayload({ key, location, ctrlKey, altKey, shiftKey, metaKey }));
      }
    }
    function keyboardEventPayload(init = {}) {
      return {
        key: String(init.key || ''),
        code: String(init.code || ''),
        location: eventFiniteNumber(init.location, 0, 'location'),
        ctrlKey: Boolean(init.ctrlKey),
        shiftKey: Boolean(init.shiftKey),
        altKey: Boolean(init.altKey),
        metaKey: Boolean(init.metaKey),
        repeat: Boolean(init.repeat),
        isComposing: Boolean(init.isComposing),
        charCode: eventFiniteNumber(init.charCode, 0, 'charCode'),
        keyCode: eventFiniteNumber(init.keyCode, 0, 'keyCode'),
      };
    }
    function eventModifierState(event, keyArg) {
      switch (String(keyArg || '')) {
        case 'Control':
          return Boolean(event.ctrlKey);
        case 'Shift':
          return Boolean(event.shiftKey);
        case 'Alt':
          return Boolean(event.altKey);
        case 'Meta':
          return Boolean(event.metaKey);
        default:
          return false;
      }
    }
    defineEventPrototype(KeyboardEvent, keyboardEventState, [
      'key', 'code', 'location', 'ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'repeat', 'isComposing', 'charCode', 'keyCode',
      { constant: 'DOM_KEY_LOCATION_STANDARD', value: 0 },
      { constant: 'DOM_KEY_LOCATION_LEFT', value: 1 },
      { constant: 'DOM_KEY_LOCATION_RIGHT', value: 2 },
      { constant: 'DOM_KEY_LOCATION_NUMPAD', value: 3 },
      { method: 'getModifierState' },
      { method: 'initKeyboardEvent' },
    ]);

    const inputEventState = new WeakMap();
    class InputEvent extends UIEvent {
      constructor(type, init = {}) {
        const eventType = requiredEventType('InputEvent', arguments);
        const eventInit = eventInitDictionary(arguments);
        super(eventType, eventInit);
        inputEventState.set(this, {
          data: nullableEventString(eventInit.data),
          isComposing: Boolean(eventInit.isComposing),
          inputType: String(eventInit.inputType || ''),
          dataTransfer: eventInit.dataTransfer ?? null,
          targetRanges: targetRangesFromInit(eventInit.targetRanges),
        });
      }
      getTargetRanges() { return inputEventState.get(this)?.targetRanges.slice() || []; }
    }
    defineEventPrototype(InputEvent, inputEventState, ['data', 'isComposing', 'inputType', 'dataTransfer', { method: 'getTargetRanges' }]);

    function targetRangesFromInit(targetRanges) {
      if (!targetRanges) return [];
      return Array.from(targetRanges, (range) => range instanceof StaticRange ? range : new StaticRange(range));
    }

    const compositionEventState = new WeakMap();
    class CompositionEvent extends UIEvent {
      constructor(type, init = {}) {
        const eventType = requiredEventType('CompositionEvent', arguments);
        const eventInit = eventInitDictionary(arguments);
        super(eventType, eventInit);
        compositionEventState.set(this, { data: String(eventInit.data || '') });
      }
      initCompositionEvent(type, bubbles = false, cancelable = false, view = null, data = '') {
        this.initUIEvent(type, bubbles, cancelable, view, 0);
        compositionEventState.set(this, { data: String(data || '') });
      }
    }
    defineEventPrototype(CompositionEvent, compositionEventState, ['data', { method: 'initCompositionEvent' }]);

    const clipboardEventState = new WeakMap();
    class ClipboardEvent extends BaseEvent {
      constructor(type, init = {}) {
        const eventType = requiredEventType('ClipboardEvent', arguments);
        const eventInit = eventInitDictionary(arguments);
        super(eventType, eventInit);
        clipboardEventState.set(this, { clipboardData: eventInit.clipboardData ?? null });
      }
    }
    defineEventPrototype(ClipboardEvent, clipboardEventState, ['clipboardData']);

    const dragEventState = new WeakMap();
    class DragEvent extends MouseEvent {
      constructor(type, init = {}) {
        const eventType = requiredEventType('DragEvent', arguments);
        const eventInit = eventInitDictionary(arguments);
        super(eventType, eventInit);
        dragEventState.set(this, { dataTransfer: eventInit.dataTransfer ?? null });
      }
    }
    defineEventPrototype(DragEvent, dragEventState, ['dataTransfer']);

    const wheelEventState = new WeakMap();
    class WheelEvent extends MouseEvent {
      constructor(type, init = {}) {
        const eventType = requiredEventType('WheelEvent', arguments);
        const eventInit = eventInitDictionary(arguments);
        super(eventType, eventInit);
        const deltaX = eventFiniteNumber(eventInit.deltaX, 0, 'deltaX');
        const deltaY = eventFiniteNumber(eventInit.deltaY, 0, 'deltaY');
        wheelEventState.set(this, {
          deltaX,
          deltaY,
          deltaZ: eventFiniteNumber(eventInit.deltaZ, 0, 'deltaZ'),
          deltaMode: eventFiniteNumber(eventInit.deltaMode, 0, 'deltaMode'),
          wheelDeltaX: deltaX,
          wheelDeltaY: deltaY,
          wheelDelta: deltaY,
        });
      }
    }
    defineEventPrototype(WheelEvent, wheelEventState, ['deltaX', 'deltaY', 'deltaZ', 'deltaMode', 'wheelDeltaX', 'wheelDeltaY', 'wheelDelta', { constant: 'DOM_DELTA_PIXEL', value: 0 }, { constant: 'DOM_DELTA_LINE', value: 1 }, { constant: 'DOM_DELTA_PAGE', value: 2 }]);

    const touchEventState = new WeakMap();
    class TouchEvent extends UIEvent {
      constructor(type, init = {}) {
        const eventType = requiredEventType('TouchEvent', arguments);
        const eventInit = eventInitDictionary(arguments);
        super(eventType, eventInit);
        touchEventState.set(this, {
          touches: makeTouchList(eventInit.touches),
          targetTouches: makeTouchList(eventInit.targetTouches),
          changedTouches: makeTouchList(eventInit.changedTouches),
          altKey: Boolean(eventInit.altKey),
          metaKey: Boolean(eventInit.metaKey),
          ctrlKey: Boolean(eventInit.ctrlKey),
          shiftKey: Boolean(eventInit.shiftKey),
        });
      }
    }
    defineEventPrototype(TouchEvent, touchEventState, ['touches', 'targetTouches', 'changedTouches', 'altKey', 'metaKey', 'ctrlKey', 'shiftKey']);

    const animationEventState = new WeakMap();
    class AnimationEvent extends BaseEvent {
      constructor(type, init = {}) {
        const eventType = requiredEventType('AnimationEvent', arguments);
        const eventInit = eventInitDictionary(arguments);
        super(eventType, eventInit);
        animationEventState.set(this, {
          animationName: String(eventInit.animationName || ''),
          elapsedTime: eventFiniteNumber(eventInit.elapsedTime, 0, 'elapsedTime'),
          pseudoElement: String(eventInit.pseudoElement || ''),
        });
      }
    }
    defineEventPrototype(AnimationEvent, animationEventState, ['animationName', 'elapsedTime', 'pseudoElement']);

    const transitionEventState = new WeakMap();
    class TransitionEvent extends BaseEvent {
      constructor(type, init = {}) {
        const eventType = requiredEventType('TransitionEvent', arguments);
        const eventInit = eventInitDictionary(arguments);
        super(eventType, eventInit);
        transitionEventState.set(this, {
          propertyName: String(eventInit.propertyName || ''),
          elapsedTime: eventFiniteNumber(eventInit.elapsedTime, 0, 'elapsedTime'),
          pseudoElement: String(eventInit.pseudoElement || ''),
        });
      }
    }
    defineEventPrototype(TransitionEvent, transitionEventState, ['propertyName', 'elapsedTime', 'pseudoElement']);

    function nullableEventNumber(value) { return value === null || value === undefined ? null : eventFiniteNumber(value); }
    const animationPlaybackEventState = new WeakMap();
    class AnimationPlaybackEvent extends BaseEvent {
      constructor(type, init = {}) {
        super(type, init);
        animationPlaybackEventState.set(this, {
          currentTime: nullableEventNumber(init.currentTime),
          timelineTime: nullableEventNumber(init.timelineTime),
        });
      }
    }
    defineStateBackedEventPayload(AnimationPlaybackEvent, animationPlaybackEventState, ['currentTime', 'timelineTime']);
    const blobEventState = new WeakMap();
    class BlobEvent extends BaseEvent {
      constructor(type, init) {
        const eventInit = requiredEventInit('BlobEvent', init, arguments.length);
        super(type, eventInit);
        if (eventInit.data === undefined) throw new TypeError("Failed to construct 'BlobEvent': Failed to read the 'data' property from 'BlobEventInit': Required member is undefined.");
        if (!(eventInit.data instanceof Blob)) throw new TypeError("Failed to construct 'BlobEvent': Failed to read the 'data' property from 'BlobEventInit'.");
        blobEventState.set(this, { data: eventInit.data, timecode: eventFiniteNumber(eventInit.timecode, 0, 'timecode') });
      }
    }
    Object.defineProperty(BlobEvent, 'name', { value: 'BlobEvent', configurable: true });
    defineStateBackedEventPayload(BlobEvent, blobEventState, ['data', 'timecode']);
    function eventElementPayload(value, eventName, fieldName) {
      if (value === null || value === undefined) return null;
      if (value?.nodeType !== 1 || value?.namespaceURI !== 'http://www.w3.org/1999/xhtml') throw new TypeError(`Failed to construct '${eventName}': Failed to read the '${fieldName}' property from '${eventName}Init': Failed to convert value to 'HTMLElement'.`);
      return value;
    }
    const toggleEventState = new WeakMap();
    class ToggleEvent extends BaseEvent {
      constructor(type, init = {}) {
        super(type, init);
        toggleEventState.set(this, {
          oldState: String(init.oldState || ''),
          newState: String(init.newState || ''),
          source: eventElementPayload(init.source, 'ToggleEvent', 'source'),
        });
      }
    }
    defineStateBackedEventPayload(ToggleEvent, toggleEventState, ['oldState', 'newState', 'source']);
    const commandEventState = new WeakMap();
    class CommandEvent extends BaseEvent {
      constructor(type, init = {}) {
        super(type, init);
        commandEventState.set(this, {
          source: eventElementPayload(init.source, 'CommandEvent', 'source'),
          command: String(init.command || ''),
        });
      }
    }
    defineStateBackedEventPayload(CommandEvent, commandEventState, ['source', 'command']);
    const contentVisibilityAutoStateChangeEventState = new WeakMap();
    class ContentVisibilityAutoStateChangeEvent extends BaseEvent {
      constructor(type, init = {}) {
        super(type, init);
        contentVisibilityAutoStateChangeEventState.set(this, { skipped: Boolean(init.skipped) });
      }
    }
    defineStateBackedEventPayload(ContentVisibilityAutoStateChangeEvent, contentVisibilityAutoStateChangeEventState, ['skipped']);
    const fontFaceSetLoadEventState = new WeakMap();
    class FontFaceSetLoadEvent extends BaseEvent {
      constructor(type, init = {}) {
        const eventType = requiredEventType('FontFaceSetLoadEvent', arguments);
        const eventInit = eventInitDictionary(arguments);
        super(eventType, eventInit);
        fontFaceSetLoadEventState.set(this, { fontfaces: fontFacesFromEventInit(eventInit.fontfaces) });
      }
    }
    function fontFacesFromEventInit(fontfaces) {
      if (!fontfaces) return [];
      return Array.from(fontfaces, (fontFace) => {
        if (!(fontFace instanceof FontFace)) throw new TypeError("Failed to construct 'FontFaceSetLoadEvent': Failed to read the 'fontfaces' property from 'FontFaceSetLoadEventInit': Failed to convert value to 'FontFace'.");
        return fontFace;
      });
    }
    const fontFaceSetLoadEventConstructorDescriptor = Object.getOwnPropertyDescriptor(FontFaceSetLoadEvent.prototype, 'constructor');
    delete FontFaceSetLoadEvent.prototype.constructor;
    Object.defineProperty(FontFaceSetLoadEvent.prototype, 'fontfaces', { get() {
      const state = fontFaceSetLoadEventState.get(this);
      if (!state) throw new TypeError('Illegal invocation');
      return Object.freeze(state.fontfaces.slice());
    }, enumerable: true, configurable: true });
    Object.defineProperty(FontFaceSetLoadEvent.prototype, 'constructor', fontFaceSetLoadEventConstructorDescriptor);
    const gamepadEventState = new WeakMap();
    function GamepadEvent(type, init) {
      if (!new.target) throw new TypeError("Failed to construct 'GamepadEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
      if (arguments.length < 1) throw new TypeError("Failed to construct 'GamepadEvent': 1 argument required, but only 0 present.");
      const eventInit = init === null || init === undefined ? {} : Object(init);
      const gamepad = gamepadEventGamepad(eventInit);
      const event = Reflect.construct(BaseEvent, [gamepadEventType(type), eventInit], new.target);
      gamepadEventState.set(event, { gamepad });
      return event;
    }
    Object.setPrototypeOf(GamepadEvent, BaseEvent);
    GamepadEvent.prototype = Object.create(BaseEvent.prototype);
    Object.defineProperties(GamepadEvent.prototype, {
      gamepad: { get() { return gamepadEventValue(this).gamepad; }, enumerable: true, configurable: true },
      constructor: { value: GamepadEvent, writable: true, configurable: true },
    });
    Object.defineProperty(GamepadEvent.prototype, Symbol.toStringTag, { value: 'GamepadEvent', configurable: true });
    Object.defineProperty(GamepadEvent, 'prototype', { writable: false });

    function gamepadEventType(value) {
      if (typeof value === 'symbol') throw new TypeError("Failed to construct 'GamepadEvent': Cannot convert a Symbol value to a string");
      return String(value);
    }

    function gamepadEventGamepad(init) {
      const gamepad = init.gamepad;
      if (gamepad === null || gamepad === undefined) return null;
      if (gamepadSlots.has(gamepad)) return gamepad;
      throw new TypeError("Failed to construct 'GamepadEvent': Failed to read the 'gamepad' property from 'GamepadEventInit': Failed to convert value to 'Gamepad'.");
    }

    function gamepadEventValue(event) {
      const state = gamepadEventState.get(event);
      if (!state) throw new TypeError('Illegal invocation');
      return state;
    }
    class PictureInPictureEvent extends BaseEvent {
      constructor(type, init = {}) {
        super(type, init);
        this.pictureInPictureWindow = init.pictureInPictureWindow ?? null;
      }
    }
    const documentPictureInPictureEventState = new WeakMap();
    function DocumentPictureInPictureEvent(type, init) {
      if (!new.target) throw new TypeError("Failed to construct 'DocumentPictureInPictureEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
      if (arguments.length < 2) throw new TypeError(`Failed to construct 'DocumentPictureInPictureEvent': 2 arguments required, but only ${arguments.length} present.`);
      if (!init || typeof init !== 'object' || !Object.prototype.hasOwnProperty.call(init, 'window')) throw new TypeError("Failed to construct 'DocumentPictureInPictureEvent': Failed to read the 'window' property from 'DocumentPictureInPictureEventInit': Required member is undefined.");
      const eventWindow = init.window;
      if (eventWindow !== globalThis) throw new TypeError("Failed to construct 'DocumentPictureInPictureEvent': Failed to read the 'window' property from 'DocumentPictureInPictureEventInit': Failed to convert value to 'Window'.");
      const event = Reflect.construct(BaseEvent, [type, init], new.target);
      documentPictureInPictureEventState.set(event, { window: eventWindow });
      return event;
    }
    DocumentPictureInPictureEvent.prototype = Object.create(BaseEvent.prototype);
    Object.defineProperties(DocumentPictureInPictureEvent.prototype, {
      window: { get() {
        const state = documentPictureInPictureEventState.get(this);
        if (!state) throw new TypeError('Illegal invocation');
        return state.window;
      }, enumerable: true, configurable: true },
      constructor: { value: DocumentPictureInPictureEvent, writable: true, configurable: true },
    });
    Object.defineProperty(DocumentPictureInPictureEvent.prototype, Symbol.toStringTag, { value: 'DocumentPictureInPictureEvent', configurable: true });
    function PictureInPictureWindow() { throw new TypeError("Failed to construct 'PictureInPictureWindow': Illegal constructor"); }
    Object.defineProperty(PictureInPictureWindow, Symbol.hasInstance, { value: (value) => Boolean(value?.__zpPictureInPictureWindow), configurable: true });
    const deviceMotionAccelerationState = new WeakMap();
    const deviceMotionRotationRateState = new WeakMap();
    const deviceMotionEventState = new WeakMap();
    const deviceOrientationEventState = new WeakMap();
    const deviceMotionAccelerationPrototype = {};
    Object.defineProperties(deviceMotionAccelerationPrototype, {
      x: { get() { return deviceMotionAccelerationValue(this).x; }, enumerable: true, configurable: true },
      y: { get() { return deviceMotionAccelerationValue(this).y; }, enumerable: true, configurable: true },
      z: { get() { return deviceMotionAccelerationValue(this).z; }, enumerable: true, configurable: true },
    });
    Object.defineProperty(deviceMotionAccelerationPrototype, Symbol.toStringTag, { value: 'DeviceMotionEventAcceleration', configurable: true });
    const deviceMotionRotationRatePrototype = {};
    Object.defineProperties(deviceMotionRotationRatePrototype, {
      alpha: { get() { return deviceMotionRotationRateValue(this).alpha; }, enumerable: true, configurable: true },
      beta: { get() { return deviceMotionRotationRateValue(this).beta; }, enumerable: true, configurable: true },
      gamma: { get() { return deviceMotionRotationRateValue(this).gamma; }, enumerable: true, configurable: true },
    });
    Object.defineProperty(deviceMotionRotationRatePrototype, Symbol.toStringTag, { value: 'DeviceMotionEventRotationRate', configurable: true });

    function DeviceMotionEvent(type, init) {
      if (!new.target) throw new TypeError("Failed to construct 'DeviceMotionEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
      if (arguments.length < 1) throw new TypeError("Failed to construct 'DeviceMotionEvent': 1 argument required, but only 0 present.");
      const eventInit = init === null || init === undefined ? {} : Object(init);
      const event = Reflect.construct(BaseEvent, [deviceEventType('DeviceMotionEvent', type), eventInit], new.target);
      deviceMotionEventState.set(event, {
        acceleration: makeDeviceMotionAcceleration(eventInit.acceleration, 'acceleration', 'DeviceMotionEventAccelerationInit', ['x', 'y', 'z']),
        accelerationIncludingGravity: makeDeviceMotionAcceleration(eventInit.accelerationIncludingGravity, 'accelerationIncludingGravity', 'DeviceMotionEventAccelerationInit', ['x', 'y', 'z']),
        rotationRate: makeDeviceMotionRotationRate(eventInit.rotationRate),
        interval: deviceEventFiniteNumber('DeviceMotionEvent', 'DeviceMotionEventInit', 'interval', eventInit.interval, 0),
      });
      return event;
    }
    Object.setPrototypeOf(DeviceMotionEvent, BaseEvent);
    DeviceMotionEvent.prototype = Object.create(BaseEvent.prototype);
    Object.defineProperties(DeviceMotionEvent.prototype, {
      acceleration: { get() { return deviceMotionEventValue(this).acceleration; }, enumerable: true, configurable: true },
      accelerationIncludingGravity: { get() { return deviceMotionEventValue(this).accelerationIncludingGravity; }, enumerable: true, configurable: true },
      rotationRate: { get() { return deviceMotionEventValue(this).rotationRate; }, enumerable: true, configurable: true },
      interval: { get() { return deviceMotionEventValue(this).interval; }, enumerable: true, configurable: true },
      constructor: { value: DeviceMotionEvent, writable: true, configurable: true },
    });
    Object.defineProperty(DeviceMotionEvent.prototype, Symbol.toStringTag, { value: 'DeviceMotionEvent', configurable: true });
    Object.defineProperty(DeviceMotionEvent, 'prototype', { writable: false });

    function DeviceOrientationEvent(type, init) {
      if (!new.target) throw new TypeError("Failed to construct 'DeviceOrientationEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
      if (arguments.length < 1) throw new TypeError("Failed to construct 'DeviceOrientationEvent': 1 argument required, but only 0 present.");
      const eventInit = init === null || init === undefined ? {} : Object(init);
      const event = Reflect.construct(BaseEvent, [deviceEventType('DeviceOrientationEvent', type), eventInit], new.target);
      deviceOrientationEventState.set(event, {
        alpha: deviceEventNullableFiniteNumber('DeviceOrientationEvent', 'DeviceOrientationEventInit', 'alpha', eventInit.alpha),
        beta: deviceEventNullableFiniteNumber('DeviceOrientationEvent', 'DeviceOrientationEventInit', 'beta', eventInit.beta),
        gamma: deviceEventNullableFiniteNumber('DeviceOrientationEvent', 'DeviceOrientationEventInit', 'gamma', eventInit.gamma),
        absolute: Boolean(eventInit.absolute),
      });
      return event;
    }
    Object.setPrototypeOf(DeviceOrientationEvent, BaseEvent);
    DeviceOrientationEvent.prototype = Object.create(BaseEvent.prototype);
    Object.defineProperties(DeviceOrientationEvent.prototype, {
      alpha: { get() { return deviceOrientationEventValue(this).alpha; }, enumerable: true, configurable: true },
      beta: { get() { return deviceOrientationEventValue(this).beta; }, enumerable: true, configurable: true },
      gamma: { get() { return deviceOrientationEventValue(this).gamma; }, enumerable: true, configurable: true },
      absolute: { get() { return deviceOrientationEventValue(this).absolute; }, enumerable: true, configurable: true },
      constructor: { value: DeviceOrientationEvent, writable: true, configurable: true },
    });
    Object.defineProperty(DeviceOrientationEvent.prototype, Symbol.toStringTag, { value: 'DeviceOrientationEvent', configurable: true });
    Object.defineProperty(DeviceOrientationEvent, 'prototype', { writable: false });

    function deviceEventType(name, value) {
      if (typeof value === 'symbol') throw new TypeError(`Failed to construct '${name}': Cannot convert a Symbol value to a string`);
      return String(value);
    }

    function makeDeviceMotionAcceleration(value, field, dictName, keys) {
      if (value === null || value === undefined) return null;
      const state = {};
      const source = Object(value);
      for (const key of keys) state[key] = deviceEventNullableFiniteNumber('DeviceMotionEvent', dictName, key, source[key], field);
      const acceleration = Object.create(deviceMotionAccelerationPrototype);
      deviceMotionAccelerationState.set(acceleration, state);
      return acceleration;
    }

    function makeDeviceMotionRotationRate(value) {
      if (value === null || value === undefined) return null;
      const state = {};
      const source = Object(value);
      for (const key of ['alpha', 'beta', 'gamma']) state[key] = deviceEventNullableFiniteNumber('DeviceMotionEvent', 'DeviceMotionEventRotationRateInit', key, source[key], 'rotationRate');
      const rotationRate = Object.create(deviceMotionRotationRatePrototype);
      deviceMotionRotationRateState.set(rotationRate, state);
      return rotationRate;
    }

    function deviceEventFiniteNumber(eventName, dictName, field, value, defaultValue, parentField = '') {
      if (value === null || value === undefined) return defaultValue;
      if (typeof value === 'symbol') throw new TypeError(deviceEventNumberError(eventName, dictName, field, 'Cannot convert a Symbol value to a number', parentField));
      const number = Number(value);
      if (!Number.isFinite(number)) throw new TypeError(deviceEventNumberError(eventName, dictName, field, 'The provided double value is non-finite.', parentField));
      return number;
    }

    function deviceEventNullableFiniteNumber(eventName, dictName, field, value, parentField = '') {
      if (value === null || value === undefined) return null;
      return deviceEventFiniteNumber(eventName, dictName, field, value, null, parentField);
    }

    function deviceEventNumberError(eventName, dictName, field, detail, parentField) {
      const prefix = parentField ? `Failed to read the '${parentField}' property from '${eventName}Init': ` : '';
      return `Failed to construct '${eventName}': ${prefix}Failed to read the '${field}' property from '${dictName}': ${detail}`;
    }

    function deviceMotionAccelerationValue(value) {
      const state = deviceMotionAccelerationState.get(value);
      if (!state) throw new TypeError('Illegal invocation');
      return state;
    }

    function deviceMotionRotationRateValue(value) {
      const state = deviceMotionRotationRateState.get(value);
      if (!state) throw new TypeError('Illegal invocation');
      return state;
    }

    function deviceMotionEventValue(event) {
      const state = deviceMotionEventState.get(event);
      if (!state) throw new TypeError('Illegal invocation');
      return state;
    }

    function deviceOrientationEventValue(event) {
      const state = deviceOrientationEventState.get(event);
      if (!state) throw new TypeError('Illegal invocation');
      return state;
    }
    const securityPolicyViolationEventState = new WeakMap();
    class SecurityPolicyViolationEvent extends BaseEvent {
      constructor(type, init = {}) {
        super(type, init);
        securityPolicyViolationEventState.set(this, {
          documentURI: String(init.documentURI || ''),
          referrer: String(init.referrer || ''),
          blockedURI: String(init.blockedURI || ''),
          violatedDirective: String(init.violatedDirective || ''),
          effectiveDirective: String(init.effectiveDirective || ''),
          originalPolicy: String(init.originalPolicy || ''),
          disposition: String(init.disposition || 'enforce'),
          sourceFile: String(init.sourceFile || ''),
          statusCode: eventUnsignedShort(init.statusCode),
          lineNumber: eventFiniteNumberOrZero(init.lineNumber),
          columnNumber: eventFiniteNumberOrZero(init.columnNumber),
          sample: String(init.sample || ''),
        });
      }
    }
    defineStateBackedEventPayload(SecurityPolicyViolationEvent, securityPolicyViolationEventState, ['documentURI', 'referrer', 'blockedURI', 'violatedDirective', 'effectiveDirective', 'originalPolicy', 'disposition', 'sourceFile', 'statusCode', 'lineNumber', 'columnNumber', 'sample']);
    const errorEventState = new WeakMap();
    class ErrorEvent extends BaseEvent {
      constructor(type, init = {}) {
        super(type, init);
        errorEventState.set(this, {
          message: String(init.message || ''),
          filename: String(init.filename || ''),
          lineno: eventFiniteNumberOrZero(init.lineno),
          colno: eventFiniteNumberOrZero(init.colno),
          error: init.error,
        });
      }
    }
    defineStateBackedEventPayload(ErrorEvent, errorEventState, ['message', 'filename', 'lineno', 'colno', 'error']);
    const hashChangeEventState = new WeakMap();
    class HashChangeEvent extends BaseEvent {
      constructor(type, init = {}) {
        const eventType = requiredEventType('HashChangeEvent', arguments);
        const eventInit = eventInitDictionary(arguments);
        super(eventType, eventInit);
        hashChangeEventState.set(this, { oldURL: String(eventInit.oldURL || ''), newURL: String(eventInit.newURL || '') });
      }
    }
    defineStateBackedEventPayload(HashChangeEvent, hashChangeEventState, ['oldURL', 'newURL']);
    const popStateEventState = new WeakMap();
    class PopStateEvent extends BaseEvent {
      constructor(type, init = {}) {
        const eventType = requiredEventType('PopStateEvent', arguments);
        const eventInit = eventInitDictionary(arguments);
        super(eventType, eventInit);
        popStateEventState.set(this, { state: eventInit.state ?? null, hasUAVisualTransition: Boolean(eventInit.hasUAVisualTransition) });
      }
    }
    defineStateBackedEventPayload(PopStateEvent, popStateEventState, ['state', 'hasUAVisualTransition']);
    const promiseRejectionEventState = new WeakMap();
    class PromiseRejectionEvent extends BaseEvent {
      constructor(type, init) {
        const eventInit = requiredEventInit('PromiseRejectionEvent', init, arguments.length);
        super(type, eventInit);
        if (eventInit.promise === undefined) throw new TypeError("Failed to construct 'PromiseRejectionEvent': Failed to read the 'promise' property from 'PromiseRejectionEventInit': Required member is undefined.");
        promiseRejectionEventState.set(this, { promise: Promise.resolve(eventInit.promise), reason: eventInit.reason });
      }
    }
    defineStateBackedEventPayload(PromiseRejectionEvent, promiseRejectionEventState, ['promise', 'reason']);
    const pageTransitionEventState = new WeakMap();
    class PageTransitionEvent extends BaseEvent {
      constructor(type, init = {}) {
        const eventType = requiredEventType('PageTransitionEvent', arguments);
        const eventInit = eventInitDictionary(arguments);
        super(eventType, eventInit);
        pageTransitionEventState.set(this, { persisted: Boolean(eventInit.persisted) });
      }
    }
    defineStateBackedEventPayload(PageTransitionEvent, pageTransitionEventState, ['persisted']);
    const beforeUnloadEventState = new WeakMap();
    const beforeUnloadEventToken = {};
    class BeforeUnloadEvent extends BaseEvent {
      constructor(token, type, init = {}) {
        if (token !== beforeUnloadEventToken) throw new TypeError("Failed to construct 'BeforeUnloadEvent': Illegal constructor");
        super(type, init);
        beforeUnloadEventState.set(this, { returnValue: String(init.returnValue || '') });
      }
    }
    defineStateBackedEventPayload(BeforeUnloadEvent, beforeUnloadEventState, ['returnValue'], { writable: true });
    const beforeInstallPromptEventState = new WeakMap();
    function BeforeInstallPromptEvent(type, init = {}) {
      if (!new.target) throw new TypeError("Failed to construct 'BeforeInstallPromptEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
      if (arguments.length < 1) throw new TypeError("Failed to construct 'BeforeInstallPromptEvent': 1 argument required, but only 0 present.");
      if (typeof type === 'symbol') throw new TypeError("Failed to construct 'BeforeInstallPromptEvent': Cannot convert a Symbol value to a string");
      const eventInit = init === null || init === undefined ? {} : Object(init);
      const platforms = beforeInstallPromptPlatforms(eventInit.platforms);
      const event = Reflect.construct(BaseEvent, [String(type), eventInit], new.target);
      beforeInstallPromptEventState.set(event, { platforms });
      return event;
    }
    BeforeInstallPromptEvent.prototype = Object.create(BaseEvent.prototype);
    Object.defineProperties(BeforeInstallPromptEvent.prototype, {
      platforms: { get() { return Object.freeze(beforeInstallPromptEventValue(this).platforms.slice()); }, enumerable: true, configurable: true },
      userChoice: { get() { beforeInstallPromptEventValue(this); return Promise.reject(beforeInstallPromptInvalidState("Failed to read the 'userChoice' property from 'BeforeInstallPromptEvent': userChoice cannot be accessed on this event.")); }, enumerable: true, configurable: true },
      prompt: { value: function prompt() { beforeInstallPromptEventValue(this); return Promise.reject(beforeInstallPromptInvalidState("Failed to execute 'prompt' on 'BeforeInstallPromptEvent': The prompt() method cannot be called.")); }, enumerable: true, writable: true, configurable: true },
      constructor: { value: BeforeInstallPromptEvent, writable: true, configurable: true },
    });
    Object.defineProperty(BeforeInstallPromptEvent.prototype, Symbol.toStringTag, { value: 'BeforeInstallPromptEvent', configurable: true });
    Object.defineProperty(BeforeInstallPromptEvent, 'prototype', { writable: false });
    function beforeInstallPromptEventValue(event) {
      const state = beforeInstallPromptEventState.get(event);
      if (!state) throw new TypeError('Illegal invocation');
      return state;
    }
    function beforeInstallPromptPlatforms(value) {
      if (value === undefined || value === null) return [];
      if (typeof value === 'string' || typeof value?.[Symbol.iterator] !== 'function') throw new TypeError("Failed to construct 'BeforeInstallPromptEvent': Failed to read the 'platforms' property from 'BeforeInstallPromptEventInit': The provided value cannot be converted to a sequence.");
      return Array.from(value, (platform) => {
        if (typeof platform === 'symbol') throw new TypeError("Failed to construct 'BeforeInstallPromptEvent': Failed to read the 'platforms' property from 'BeforeInstallPromptEventInit': Cannot convert a Symbol value to a string");
        return String(platform);
      });
    }
    function beforeInstallPromptInvalidState(message) {
      return new DOMException(message, 'InvalidStateError');
    }
    const submitEventState = new WeakMap();
    class SubmitEvent extends BaseEvent {
      constructor(type, init = {}) {
        super(type, init);
        submitEventState.set(this, { submitter: eventElementPayload(init.submitter, 'SubmitEvent', 'submitter') });
      }
    }
    defineStateBackedEventPayload(SubmitEvent, submitEventState, ['submitter']);
    const formDataEventState = new WeakMap();
    class FormDataEvent extends BaseEvent {
      constructor(type, init) {
        const eventInit = requiredEventInit('FormDataEvent', init, arguments.length);
        super(type, eventInit);
        if (eventInit.formData === undefined) throw new TypeError("Failed to construct 'FormDataEvent': Failed to read the 'formData' property from 'FormDataEventInit': Required member is undefined.");
        if (!(eventInit.formData instanceof FormData)) throw new TypeError("Failed to construct 'FormDataEvent': Failed to read the 'formData' property from 'FormDataEventInit': Failed to convert value to 'FormData'.");
        formDataEventState.set(this, { formData: eventInit.formData });
      }
    }
    defineStateBackedEventPayload(FormDataEvent, formDataEventState, ['formData']);
    const windowControlsOverlayGeometryChangeEventState = new WeakMap();
    function WindowControlsOverlayGeometryChangeEvent(type, init) {
      if (!new.target) throw new TypeError("Failed to construct 'WindowControlsOverlayGeometryChangeEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
      if (arguments.length < 2) throw new TypeError(`Failed to construct 'WindowControlsOverlayGeometryChangeEvent': 2 arguments required, but only ${arguments.length} present.`);
      if (init === null || typeof init !== 'object') throw new TypeError("Failed to construct 'WindowControlsOverlayGeometryChangeEvent': The provided value is not of type 'WindowControlsOverlayGeometryChangeEventInit'.");
      if (init.titlebarAreaRect === undefined) throw new TypeError("Failed to construct 'WindowControlsOverlayGeometryChangeEvent': Failed to read the 'titlebarAreaRect' property from 'WindowControlsOverlayGeometryChangeEventInit': Required member is undefined.");
      if (!(init.titlebarAreaRect instanceof DOMRect)) throw new TypeError("Failed to construct 'WindowControlsOverlayGeometryChangeEvent': Failed to read the 'titlebarAreaRect' property from 'WindowControlsOverlayGeometryChangeEventInit': Failed to convert value to 'DOMRect'.");
      if (init.visible === undefined) throw new TypeError("Failed to construct 'WindowControlsOverlayGeometryChangeEvent': Failed to read the 'visible' property from 'WindowControlsOverlayGeometryChangeEventInit': Required member is undefined.");
      const event = Reflect.construct(BaseEvent, [type], new.target);
      windowControlsOverlayGeometryChangeEventState.set(event, { titlebarAreaRect: null, visible: false });
      return event;
    }
    WindowControlsOverlayGeometryChangeEvent.prototype = Object.create(BaseEvent.prototype);
    Object.defineProperty(WindowControlsOverlayGeometryChangeEvent.prototype, 'constructor', { value: WindowControlsOverlayGeometryChangeEvent, writable: true, configurable: true });
    defineStateBackedEventPayload(WindowControlsOverlayGeometryChangeEvent, windowControlsOverlayGeometryChangeEventState, ['titlebarAreaRect', 'visible']);
    Object.defineProperty(WindowControlsOverlayGeometryChangeEvent, 'prototype', { writable: false });
    function VirtualKeyboardGeometryChangeEvent(type, _init = {}) {
      if (!new.target) throw new TypeError("Failed to construct 'VirtualKeyboardGeometryChangeEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
      if (arguments.length < 1) throw new TypeError("Failed to construct 'VirtualKeyboardGeometryChangeEvent': 1 argument required, but only 0 present.");
      return Reflect.construct(BaseEvent, [type], new.target);
    }
    VirtualKeyboardGeometryChangeEvent.prototype = Object.create(BaseEvent.prototype);
    Object.defineProperty(VirtualKeyboardGeometryChangeEvent.prototype, 'constructor', { value: VirtualKeyboardGeometryChangeEvent, writable: true, configurable: true });
    Object.defineProperty(VirtualKeyboardGeometryChangeEvent, 'prototype', { writable: false });
    const broadcastChannels = new Map();
    const messageEventState = new WeakMap();
    class MessageEvent extends BaseEvent {
      constructor(type, init = {}) {
        super(type, init);
        messageEventState.set(this, messageEventPayload(init));
      }
      initMessageEvent(type, bubbles = false, cancelable = false, data = null, origin = '', lastEventId = '', source = null, ports = []) {
        this.initEvent(type, bubbles, cancelable);
        messageEventState.set(this, messageEventPayload({ data, origin, lastEventId, source, ports }));
      }
    }
    defineStateBackedEventPayload(MessageEvent, messageEventState, ['data', 'origin', 'lastEventId', 'source', 'ports', 'userActivation'], { methods: ['initMessageEvent'] });
    function messageEventPayload(init = {}) {
      return {
        data: init.data ?? null,
        origin: String(init.origin || ''),
        lastEventId: String(init.lastEventId || ''),
        source: init.source ?? null,
        ports: Object.freeze(Array.from(init.ports || [])),
        userActivation: init.userActivation ?? null,
      };
    }
    class MessagePort extends EventTarget {
      constructor() {
        super();
        this.__zpClosed = false;
        this.__zpEntangled = null;
      }
      postMessage(message, transfer = []) {
        const target = this.__zpEntangled;
        if (!target || this.__zpClosed || target.__zpClosed) return;
        const data = structuredClone(message);
        const ports = Array.from(transfer || []);
        Promise.resolve().then(() => {
          if (!target.__zpClosed) target.dispatchEvent(new MessageEvent('message', { data, ports }));
        });
      }
      start() {}
      close() {
        this.__zpClosed = true;
        if (this.__zpEntangled) this.__zpEntangled.__zpEntangled = null;
        this.__zpEntangled = null;
      }
    }
    class MessageChannel {
      constructor() {
        Object.defineProperties(this, {
          port1: { value: new MessagePort(), configurable: true },
          port2: { value: new MessagePort(), configurable: true },
        });
        this.port1.__zpEntangled = this.port2;
        this.port2.__zpEntangled = this.port1;
      }
    }
    class BroadcastChannel extends EventTarget {
      constructor(name) {
        super();
        Object.defineProperty(this, 'name', { value: String(name), configurable: true });
        this.__zpClosed = false;
        const bucket = broadcastChannels.get(this.name) || new Set();
        bucket.add(this);
        broadcastChannels.set(this.name, bucket);
      }
      postMessage(message) {
        const bucket = broadcastChannels.get(this.name);
        if (!bucket || this.__zpClosed) return;
        const origin = String(globalThis.location?.origin || '');
        for (const channel of [...bucket]) {
          if (channel === this || channel.__zpClosed) continue;
          const data = structuredClone(message);
          Promise.resolve().then(() => {
            if (!channel.__zpClosed) channel.dispatchEvent(new MessageEvent('message', { data, origin }));
          });
        }
      }
      close() {
        if (this.__zpClosed) return;
        this.__zpClosed = true;
        const bucket = broadcastChannels.get(this.name);
        if (!bucket) return;
        bucket.delete(this);
        if (bucket.size === 0) broadcastChannels.delete(this.name);
      }
    }
    Object.defineProperty(Touch.prototype, Symbol.toStringTag, { value: 'Touch', configurable: true });
    Object.defineProperty(TouchList.prototype, Symbol.toStringTag, { value: 'TouchList', configurable: true });
    globalThis.Touch = Touch;
    globalThis.TouchList = TouchList;
    const eventConstructors = {
      CustomEvent,
      UIEvent,
      MouseEvent,
      PointerEvent,
      FocusEvent,
      KeyboardEvent,
      InputEvent,
      CompositionEvent,
      ClipboardEvent,
      DragEvent,
      TouchEvent,
      WheelEvent,
      AnimationEvent,
      TransitionEvent,
      AnimationPlaybackEvent,
      BlobEvent,
      ToggleEvent,
      CommandEvent,
      ContentVisibilityAutoStateChangeEvent,
      FontFaceSetLoadEvent,
      GamepadEvent,
      PictureInPictureEvent,
      DocumentPictureInPictureEvent,
      PictureInPictureWindow,
      Gamepad,
      GamepadButton,
      Credential,
      CredentialsContainer,
      PaymentRequest,
      PaymentResponse,
      PaymentAddress,
      ContactsManager,
      ContactAddress,
      DeviceMotionEvent,
      DeviceOrientationEvent,
      SecurityPolicyViolationEvent,
      ErrorEvent,
      HashChangeEvent,
      PopStateEvent,
      PromiseRejectionEvent,
      PageTransitionEvent,
      BeforeUnloadEvent,
      BeforeInstallPromptEvent,
      SubmitEvent,
      FormDataEvent,
      WindowControlsOverlayGeometryChangeEvent,
      VirtualKeyboardGeometryChangeEvent,
      MessageEvent,
    };
    const longTailEventConstructors = createLongTailEventConstructors(BaseEvent, UIEvent);
    createTextEventInstanceImpl = longTailEventConstructors.createTextEventInstance;
    delete longTailEventConstructors.createTextEventInstance;
    Object.assign(eventConstructors, longTailEventConstructors);
    for (const [name, ctor] of Object.entries(eventConstructors)) {
      Object.defineProperty(ctor.prototype, Symbol.toStringTag, { value: name, configurable: true });
      Object.defineProperty(globalThis, name, { value: ctor, writable: true, configurable: true });
    }
    Object.defineProperty(MessagePort.prototype, Symbol.toStringTag, { value: 'MessagePort', configurable: true });
    Object.defineProperties(MessagePort.prototype, {
      onmessage: idbEventHandlerAccessor('onmessage'),
      onmessageerror: idbEventHandlerAccessor('onmessageerror'),
    });
    Object.defineProperties(MessageChannel.prototype, {
      port1: idbReadonlyOwnAccessor('port1'),
      port2: idbReadonlyOwnAccessor('port2'),
    });
    Object.defineProperty(MessageChannel.prototype, Symbol.toStringTag, { value: 'MessageChannel', configurable: true });
    globalThis.MessagePort = MessagePort;
    globalThis.MessageChannel = MessageChannel;
    Object.defineProperty(BroadcastChannel.prototype, Symbol.toStringTag, { value: 'BroadcastChannel', configurable: true });
    Object.defineProperties(BroadcastChannel.prototype, {
      name: idbReadonlyOwnAccessor('name'),
      onmessage: idbEventHandlerAccessor('onmessage'),
      onmessageerror: idbEventHandlerAccessor('onmessageerror'),
    });
    globalThis.BroadcastChannel = BroadcastChannel;
  }

  class FontFace {
    constructor(family, source, descriptors = {}) {
      if (arguments.length < 2) throw new TypeError("Failed to construct 'FontFace': 2 arguments required, but only " + arguments.length + ' present.');
      this.family = String(family);
      Object.defineProperty(this, '__zpSource', { value: source, configurable: true, writable: true });
      this.style = String(descriptors.style || 'normal');
      this.weight = String(descriptors.weight || 'normal');
      this.stretch = String(descriptors.stretch || 'normal');
      this.unicodeRange = String(descriptors.unicodeRange || 'U+0-10FFFF');
      this.variant = String(descriptors.variant || 'normal');
      this.featureSettings = String(descriptors.featureSettings || 'normal');
      this.variationSettings = String(descriptors.variationSettings || 'normal');
      this.display = String(descriptors.display || 'auto');
      this.status = 'unloaded';
      let resolveLoaded;
      this.loaded = new Promise((resolve) => { resolveLoaded = resolve; });
      Object.defineProperty(this, '__zpResolveLoaded', { value: resolveLoaded, configurable: true });
    }
    load() {
      if (this.status === 'unloaded') this.status = 'loading';
      this.status = 'loaded';
      this.__zpResolveLoaded(this);
      return this.loaded;
    }
  }
  Object.defineProperty(FontFace.prototype, Symbol.toStringTag, { value: 'FontFace', configurable: true });

  const fontFaceSetToken = {};
  class FontFaceSet extends globalThis.EventTarget {
    constructor(token, values = []) {
      if (token !== fontFaceSetToken) throw new TypeError("Failed to construct 'FontFaceSet': Illegal constructor");
      super();
      Object.defineProperty(this, '__zpFontFaces', { value: new Set(), configurable: true });
      this.ready = Promise.resolve(this);
      for (const value of values) this.add(value);
    }
    get size() { return this.__zpFontFaces.size; }
    get status() { return Array.from(this.__zpFontFaces).some((face) => face.status === 'loading') ? 'loading' : 'loaded'; }
    add(face) {
      if (!(face instanceof FontFace)) throw new TypeError("Failed to execute 'add' on 'FontFaceSet': parameter 1 is not of type 'FontFace'.");
      this.__zpFontFaces.add(face);
      return this;
    }
    clear() { this.__zpFontFaces.clear(); }
    delete(face) { return this.__zpFontFaces.delete(face); }
    has(face) { return this.__zpFontFaces.has(face); }
    load() { return Promise.all(Array.from(this.__zpFontFaces, (face) => face.load())).then((faces) => faces); }
    check() { return true; }
    values() { return this.__zpFontFaces.values(); }
    keys() { return this.values(); }
    entries() { return Array.from(this.__zpFontFaces, (face) => [face, face]).values(); }
    forEach(callback, thisArg = undefined) { this.__zpFontFaces.forEach((face) => callback.call(thisArg, face, face, this)); }
    [Symbol.iterator]() { return this.values(); }
  }
  Object.defineProperty(FontFaceSet.prototype, Symbol.toStringTag, { value: 'FontFaceSet', configurable: true });

  function makeFontFaceSet() { return new FontFaceSet(fontFaceSetToken); }
  function installDocumentFontSet() {
    if (globalThis.document && !Object.getOwnPropertyDescriptor(globalThis.document, 'fonts')) Object.defineProperty(globalThis.document, 'fonts', { value: makeFontFaceSet(), configurable: true });
  }

  function makeImageConstructor() {
    function Image(width = undefined, height = undefined) {
      const image = globalThis.document.createElement('img');
      if (arguments.length > 0) Object.defineProperty(image, 'width', { value: Number(width), configurable: true, writable: true });
      if (arguments.length > 1) Object.defineProperty(image, 'height', { value: Number(height), configurable: true, writable: true });
      return image;
    }
    if (globalThis.HTMLImageElement?.prototype) Object.defineProperty(Image, 'prototype', { value: globalThis.HTMLImageElement.prototype, configurable: false, writable: false });
    return Image;
  }

  function makeAudioConstructor() {
    function Audio(src = '') {
      const audio = globalThis.document.createElement('audio');
      if (arguments.length > 0) audio.src = String(src);
      return audio;
    }
    if (globalThis.HTMLAudioElement?.prototype) Object.defineProperty(Audio, 'prototype', { value: globalThis.HTMLAudioElement.prototype, configurable: false, writable: false });
    return Audio;
  }

  function makeOptionConstructor() {
    function Option(text = '', value = undefined, defaultSelected = false, selected = false) {
      const option = globalThis.document.createElement('option');
      option.textContent = String(text);
      if (arguments.length > 1) option.value = String(value);
      option.defaultSelected = Boolean(defaultSelected);
      option.selected = Boolean(selected);
      return option;
    }
    if (globalThis.HTMLOptionElement?.prototype) Object.defineProperty(Option, 'prototype', { value: globalThis.HTMLOptionElement.prototype, configurable: false, writable: false });
    return Option;
  }

  function makeIllegalBrandConstructor(name, predicate) {
    function BrandConstructor() { throw new TypeError("Failed to construct '" + name + "': Illegal constructor"); }
    Object.defineProperty(BrandConstructor, 'name', { value: name, configurable: true });
    Object.defineProperty(BrandConstructor, Symbol.hasInstance, { value: predicate, configurable: true });
    Object.defineProperty(BrandConstructor.prototype, Symbol.toStringTag, { value: name, configurable: true });
    return BrandConstructor;
  }

  function hasObjectTag(value, name) {
    return Object.prototype.toString.call(value) === '[object ' + name + ']';
  }

  function installGlobalFacades(facades) {
    for (const [name, value] of Object.entries(facades)) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  const ECMASCRIPT_NATIVE_CONSTRUCTOR_GLOBALS = new Set([
    'AggregateError',
    'Array',
    'ArrayBuffer',
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
    'Int16Array',
    'Int32Array',
    'Int8Array',
    'Map',
    'Number',
    'Object',
    'Promise',
    'Proxy',
    'RangeError',
    'ReferenceError',
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

  const WEBIDL_CONSTRUCTOR_LENGTHS = new Map([
    ['Attr', 0],
    ['BeforeUnloadEvent', 0],
    ['CSSRuleList', 0],
    ['DOMStringList', 0],
    ['DOMParser', 0],
    ['DOMTokenList', 0],
    ['Document', 0],
    ['Element', 0],
    ['GeolocationCoordinates', 0],
    ['GeolocationPosition', 0],
    ['GeolocationPositionError', 0],
    ['Headers', 0],
    ['MediaList', 0],
    ['NavigatorUAData', 0],
    ['Node', 0],
    ['GamepadEvent', 1],
    ['NodeIterator', 0],
    ['PerformanceEntry', 0],
    ['PerformanceNavigationTiming', 0],
    ['PerformanceObserverEntryList', 0],
    ['PermissionStatus', 0],
    ['Permissions', 0],
    ['PerformanceServerTiming', 0],
    ['PerformanceTimingConfidence', 0],
    ['Touch', 1],
    ['RTCError', 1],
    ['TouchList', 0],
    ['TreeWalker', 0],
    ['StyleSheetList', 0],
    ['TransformStream', 0],
    ['XPathEvaluator', 0],
    ['XPathExpression', 0],
    ['XPathResult', 0],
  ]);

  const WEBIDL_REMOVE_HAS_INSTANCE = new Set([
    'AbortSignal',
    'FragmentDirective',
    'History',
    'Navigator',
    'IDBFactory',
    'NetworkInformation',
    'Screen',
    'SVGElement',
    'UserActivation',
    'VisualViewport',
  ]);

  const WEBIDL_CONSTRUCTOR_NAMES = new Map([
    ['AudioSinkInfo', 'AudioSinkInfo'],
    ['CSSRuleList', 'CSSRuleList'],
    ['Document', 'Document'],
    ['DOMParser', 'DOMParser'],
    ['Element', 'Element'],
    ['EncodedAudioChunk', 'EncodedAudioChunk'],
    ['EncodedVideoChunk', 'EncodedVideoChunk'],
    ['ImageData', 'ImageData'],
    ['MediaList', 'MediaList'],
    ['MimeType', 'MimeType'],
    ['Node', 'Node'],
    ['Plugin', 'Plugin'],
    ['RTCIceCandidate', 'RTCIceCandidate'],
    ['RTCError', 'RTCError'],
    ['RTCSessionDescription', 'RTCSessionDescription'],
    ['StyleSheetList', 'StyleSheetList'],
    ['TransformStream', 'TransformStream'],
    ['XPathEvaluator', 'XPathEvaluator'],
    ['XPathExpression', 'XPathExpression'],
    ['XPathResult', 'XPathResult'],
    ['VideoColorSpace', 'VideoColorSpace'],
  ]);




  const WEBKIT_CONSTRUCTOR_GLOBALS = new Set([
    'webkitMediaStream',
    'webkitRTCPeerConnection',
    'webkitSpeechGrammar',
    'webkitSpeechGrammarList',
    'webkitSpeechRecognition',
    'webkitSpeechRecognitionError',
    'webkitSpeechRecognitionEvent',
    'webkitURL',
  ]);

  function isConstructorGlobalName(name) {
    return /^[A-Z]/.test(name) || WEBKIT_CONSTRUCTOR_GLOBALS.has(name);
  }

  function normalizeFunctionGlobalDescriptors() {
    for (const name of Object.getOwnPropertyNames(globalThis)) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue;
      if (typeof descriptor.value !== 'function' || !isConstructorGlobalName(name)) continue;
      try {
        Object.defineProperty(globalThis, name, {
          value: descriptor.value,
          writable: descriptor.writable !== false,
          enumerable: false,
          configurable: descriptor.configurable !== false,
        });
      } catch {}
      normalizeWebIDLConstructorReflection(name, descriptor.value);
    }
  }

  function normalizeWebIDLConstructorReflection(name, constructor) {
    if (ECMASCRIPT_NATIVE_CONSTRUCTOR_GLOBALS.has(name)) return;
    normalizeConstructorName(name, constructor);
    normalizeConstructorLength(name, constructor);
    normalizeConstructorStaticKeys(name, constructor);
    normalizeWebIDLMemberEnumerability(constructor, new Set(['length', 'name', 'prototype']));
    normalizeMethodFunctionNames(constructor, new Set(['length', 'name', 'prototype']));
    normalizeConstructorPrototypeSlot(constructor);
    normalizePrototypeAccessorNames(constructor.prototype);
    normalizeWebIDLMemberEnumerability(constructor.prototype, new Set(['constructor']));
    normalizeMethodFunctionNames(constructor.prototype, new Set(['constructor']));
  }

  function normalizeWebIDLMemberEnumerability(owner, skipKeys) {
    if (!owner || (typeof owner !== 'object' && typeof owner !== 'function')) return;
    for (const key of Object.getOwnPropertyNames(owner)) {
      if (skipKeys.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (!descriptor || descriptor.enumerable === true || descriptor.configurable === false) continue;
      try { Object.defineProperty(owner, key, enumerableDescriptorCopy(descriptor)); } catch {}
    }
  }

  function enumerableDescriptorCopy(descriptor) {
    if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return { value: descriptor.value, writable: Boolean(descriptor.writable), enumerable: true, configurable: true };
    }
    return { get: descriptor.get, set: descriptor.set, enumerable: true, configurable: true };
  }

  function normalizeMethodFunctionNames(owner, skipKeys) {
    if (!canNormalizeOwnerMethods(owner)) return;
    const keys = methodCandidateKeys(owner, skipKeys);
    const counts = methodFunctionCounts(owner, keys);
    for (const key of keys) normalizeMethodFunctionName(owner, key, counts);
  }

  function canNormalizeOwnerMethods(owner) {
    return owner && (typeof owner === 'object' || typeof owner === 'function');
  }

  function methodCandidateKeys(owner, skipKeys) {
    const keys = [];
    for (const key of Object.getOwnPropertyNames(owner)) {
      if (!skipKeys.has(key)) keys.push(key);
    }
    return keys;
  }

  function methodFunctionCounts(owner, keys) {
    const counts = new Map();
    for (const key of keys) {
      const value = methodFunctionValue(owner, key);
      if (value) counts.set(value, (counts.get(value) || 0) + 1);
    }
    return counts;
  }

  function methodFunctionValue(owner, key) {
    const value = Object.getOwnPropertyDescriptor(owner, key)?.value;
    return typeof value === 'function' ? value : null;
  }

  function normalizeMethodFunctionName(owner, key, counts) {
    const value = methodFunctionValue(owner, key);
    if (!value || value.name === key || counts.get(value) !== 1) return;
    try { Object.defineProperty(value, 'name', { value: key, configurable: true }); } catch {}
  }

  function normalizeConstructorName(name, constructor) {
    const reflectedName = reflectedConstructorName(name, constructor);
    if (!reflectedName || constructor.name === reflectedName) return;
    try { Object.defineProperty(constructor, 'name', { value: reflectedName, configurable: true }); } catch {}
  }

  function reflectedConstructorName(name, constructor) {
    if (WEBIDL_CONSTRUCTOR_NAMES.has(name)) return WEBIDL_CONSTRUCTOR_NAMES.get(name);
    const current = String(constructor?.name || '');
    const deconflicted = current.replace(/\d+$/u, '');
    if (deconflicted && deconflicted !== current) return deconflicted;
    if (current === `Virtual${name}`) return String(name);
    return '';
  }

  function normalizeConstructorStaticKeys(name, constructor) {
    if (!WEBIDL_REMOVE_HAS_INSTANCE.has(name)) return;
    try { delete constructor[Symbol.hasInstance]; } catch {}
  }

  function normalizeConstructorLength(name, constructor) {
    if (!WEBIDL_CONSTRUCTOR_LENGTHS.has(name)) return;
    try { Object.defineProperty(constructor, 'length', { value: WEBIDL_CONSTRUCTOR_LENGTHS.get(name), configurable: true }); } catch {}
  }

  function normalizePrototypeAccessorNames(prototype) {
    if (!prototype || (typeof prototype !== 'object' && typeof prototype !== 'function')) return;
    for (const key of Reflect.ownKeys(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (!descriptor || Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue;
      const get = browserNamedAccessor(descriptor.get, browserAccessorName('get', key), false);
      const set = browserNamedAccessor(descriptor.set, browserAccessorName('set', key), true);
      if (get === descriptor.get && set === descriptor.set) continue;
      try {
        Object.defineProperty(prototype, key, {
          get,
          set,
          enumerable: Boolean(descriptor.enumerable),
          configurable: descriptor.configurable !== false,
        });
      } catch {}
    }
  }

  function browserAccessorName(prefix, key) {
    return `${prefix} ${typeof key === 'symbol' ? String(key) : key}`;
  }

  function browserNamedAccessor(fn, name, acceptsValue) {
    if (typeof fn !== 'function' || fn.name === name) return fn;
    const wrapped = acceptsValue
      ? function set(value) { return fn.call(this, value); }
      : function get() { return fn.call(this); };
    try { Object.defineProperty(wrapped, 'name', { value: name, configurable: true }); } catch {}
    return wrapped;
  }

  function normalizeConstructorPrototypeSlot(constructor) {
    const descriptor = Object.getOwnPropertyDescriptor(constructor, 'prototype');
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return;
    if (descriptor.writable === false) return;
    try {
      Object.defineProperty(constructor, 'prototype', {
        value: descriptor.value,
        writable: false,
        enumerable: Boolean(descriptor.enumerable),
        configurable: descriptor.configurable !== false,
      });
    } catch {}
  }

  function installWebAPICore(config = {}) {
    installElementReflections();
    installDocumentHelpers();
    installDocumentFontSet();
    installWindowEventTarget();
    installEventConstructors();
    Object.defineProperty(globalThis, 'Gamepad', { value: Gamepad, enumerable: false, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'GamepadButton', { value: GamepadButton, enumerable: false, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'Credential', { value: Credential, enumerable: false, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'CredentialsContainer', { value: CredentialsContainer, enumerable: false, writable: true, configurable: true });
    installEmergingGlobalSingletons();
    globalThis.Intl = globalThis.Intl || IntlFacade;
    loadStorageSnapshot(config.storageSnapshot || {});
    globalThis.HTMLElement = globalThis.HTMLElement || globalThis.Element;
    globalThis.Text = globalThis.Text || function Text() {};
    globalThis.Comment = globalThis.Comment || function Comment() {};
    globalThis.DocumentFragment = DocumentFragment;
    globalThis.ShadowRoot = ShadowRoot;
    if (globalThis.Node?.prototype) Object.setPrototypeOf(Attr.prototype, globalThis.Node.prototype);
    globalThis.Attr = Attr;
    globalThis.DOMTokenList = DOMTokenList;
    Object.defineProperty(globalThis, 'DOMStringMap', { value: DOMStringMap, writable: true, configurable: true });
    globalThis.DOMStringList = DOMStringList;
    globalThis.HTMLCollection = globalThis.HTMLCollection || Array;
    globalThis.HTMLAllCollection = HTMLAllCollection;
    globalThis.History = makeIllegalBrandConstructor('History', (value) => hasObjectTag(value, 'History'));
    globalThis.Location = makeIllegalBrandConstructor('Location', (value) => hasObjectTag(value, 'Location'));
    globalThis.Navigator = makeIllegalBrandConstructor('Navigator', (value) => hasObjectTag(value, 'Navigator'));
    installGlobalFacades(htmlElementConstructors);
    installHTMLAudioPrototypeChain();
    installGlobalFacades(svgElementConstructors);
    installSVGElementPrototypeAssignment();
    installGlobalFacades(svgValueFacades);
    globalThis.Image = makeImageConstructor();
    globalThis.Audio = makeAudioConstructor();
    globalThis.Option = makeOptionConstructor();
    installCanvasElementReflections(globalThis.Element?.prototype || globalThis.HTMLElement?.prototype);
    globalThis.CanvasGradient = CanvasGradient;
    globalThis.CanvasPattern = CanvasPattern;
    globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;
    globalThis.createImageBitmap = createImageBitmap;
    globalThis.ImageBitmap = ImageBitmap;
    globalThis.ImageBitmapRenderingContext = ImageBitmapRenderingContext;
    globalThis.ImageData = ImageData;
    globalThis.OffscreenCanvas = OffscreenCanvas;
    globalThis.OffscreenCanvasRenderingContext2D = OffscreenCanvasRenderingContext2D;
    globalThis.Path2D = Path2D;
    installSVGElementBaseReflection();
    globalThis.TextMetrics = TextMetrics;
    installGlobalFacades(webGLFacades);
    globalThis.AudioData = AudioData;
    globalThis.EncodedAudioChunk = EncodedAudioChunk;
    globalThis.EncodedVideoChunk = EncodedVideoChunk;
    globalThis.VideoColorSpace = VideoColorSpace;
    globalThis.VideoFrame = VideoFrame;
    globalThis.MediaSource = MediaSource;
    globalThis.MediaSourceHandle = MediaSourceHandle;
    globalThis.SourceBuffer = SourceBuffer;
    globalThis.SourceBufferList = SourceBufferList;
    globalThis.TimeRanges = TimeRanges;
    globalThis.TextTrack = TextTrack;
    globalThis.TextTrackCue = TextTrackCue;
    globalThis.TextTrackCueList = TextTrackCueList;
    globalThis.TextTrackList = TextTrackList;
    globalThis.XPathEvaluator = XPathEvaluator;
    globalThis.XPathExpression = XPathExpression;
    globalThis.XPathResult = XPathResult;
    globalThis.VTTCue = VTTCue;
    installGlobalFacades(speechFacades);
    globalThis.webkitSpeechGrammar = speechFacades.SpeechGrammar;
    globalThis.webkitSpeechGrammarList = speechFacades.SpeechGrammarList;
    globalThis.webkitSpeechRecognition = speechFacades.SpeechRecognition;
    globalThis.webkitSpeechRecognitionError = speechFacades.SpeechRecognitionErrorEvent;
    globalThis.webkitSpeechRecognitionEvent = speechFacades.SpeechRecognitionEvent;
    installGlobalFacades(audioFacades);
    globalThis.StyleSheet = StyleSheet;
    globalThis.CSSStyleSheet = CSSStyleSheet;
    globalThis.ElementInternals = ElementInternals;
    globalThis.CustomStateSet = CustomStateSet;
    globalThis.CSSRule = CSSRule;
    globalThis.CSSRuleList = CSSRuleList;
    globalThis.CSSGroupingRule = CSSGroupingRule;
    globalThis.CSSConditionRule = CSSConditionRule;
    globalThis.CSSStyleRule = CSSStyleRule;
    globalThis.CSSMediaRule = CSSMediaRule;
    globalThis.CSSSupportsRule = CSSSupportsRule;
    globalThis.CSSImportRule = CSSImportRule;
    globalThis.CSSFontFaceRule = CSSFontFaceRule;
    globalThis.CSSPageRule = CSSPageRule;
    globalThis.CSSMarginRule = CSSMarginRule;
    globalThis.CSSKeyframesRule = CSSKeyframesRule;
    globalThis.CSSKeyframeRule = CSSKeyframeRule;
    globalThis.CSSNamespaceRule = CSSNamespaceRule;
    globalThis.CSSLayerBlockRule = CSSLayerBlockRule;
    globalThis.CSSLayerStatementRule = CSSLayerStatementRule;
    globalThis.CSSContainerRule = CSSContainerRule;
    globalThis.CSSScopeRule = CSSScopeRule;
    globalThis.CSSStartingStyleRule = CSSStartingStyleRule;
    globalThis.CSSNestedDeclarations = CSSNestedDeclarations;
    globalThis.CSSCounterStyleRule = CSSCounterStyleRule;
    globalThis.CSSFontFeatureValuesRule = CSSFontFeatureValuesRule;
    globalThis.CSSFontPaletteValuesRule = CSSFontPaletteValuesRule;
    globalThis.CSSPropertyRule = CSSPropertyRule;
    globalThis.CSSPositionTryRule = CSSPositionTryRule;
    globalThis.CSSViewTransitionRule = CSSViewTransitionRule;
    globalThis.MediaList = MediaList;
    globalThis.StyleSheetList = StyleSheetList;
    globalThis.StylePropertyMapReadOnly = StylePropertyMapReadOnly;
    globalThis.StylePropertyMap = StylePropertyMap;
    globalThis.HTMLFormControlsCollection = HTMLFormControlsCollection;
    globalThis.HTMLOptionsCollection = HTMLOptionsCollection;
    globalThis.RadioNodeList = RadioNodeList;
    globalThis.CSSStyleDeclaration = CSSStyleDeclaration;
    installGlobalFacades(cssTypedOMFacades);
    Object.defineProperty(globalThis, 'CSS', { value: CSSNamespace, writable: true, configurable: true });
    globalThis.Highlight = Highlight;
    globalThis.HighlightRegistry = HighlightRegistry;
    globalThis.DOMParser = DOMParser;
    globalThis.CustomElementRegistry = CustomElementRegistry;
    globalThis.customElements = new CustomElementRegistry(customElementRegistryToken);
    globalThis.XMLSerializer = XMLSerializer;
    Object.defineProperty(globalThis, 'AbstractRange', { value: AbstractRange, writable: true, configurable: true });
    globalThis.Range = Range;
    globalThis.StaticRange = StaticRange;
    globalThis.Selection = Selection;
    globalThis.ProgressEvent = ProgressEvent;
    globalThis.MutationObserver = MutationObserver;
    globalThis.WebKitMutationObserver = MutationObserver;
    Object.defineProperty(globalThis, 'MutationRecord', { value: MutationRecord, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'TreeWalker', { value: TreeWalker, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'NodeIterator', { value: NodeIterator, writable: true, configurable: true });
    globalThis.DOMImplementation = DOMImplementation;
    globalThis.DocumentType = DocumentType;
    Object.defineProperty(globalThis, 'NodeFilter', { value: NodeFilter, writable: true, configurable: true });
    globalThis.Storage = Storage;
    globalThis.StorageEvent = StorageEvent;
    Object.defineProperty(globalThis, 'Blob', { value: Blob, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'File', { value: File, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'FileList', { value: FileList, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'FileReader', { value: FileReader, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'FormData', { value: FormData, writable: true, configurable: true });
    globalThis.ValidityState = ValidityState;
    globalThis.DataTransfer = DataTransfer;
    globalThis.DataTransferItem = DataTransferItem;
    globalThis.DataTransferItemList = DataTransferItemList;
    Object.defineProperty(globalThis, 'PermissionStatus', { value: PermissionStatus, writable: true, configurable: true });
    installObjectURLSupport();
    globalThis.FontFace = FontFace;
    globalThis.FontFaceSet = FontFaceSet;
    globalThis.IDBRequest = IDBRequest;
    globalThis.IDBFactory = IDBFactory;
    Object.defineProperty(globalThis, 'IDBVersionChangeEvent', { value: IDBVersionChangeEvent, writable: true, configurable: true });
    globalThis.IDBOpenDBRequest = IDBOpenDBRequest;
    globalThis.IDBDatabase = IDBDatabase;
    globalThis.IDBTransaction = IDBTransaction;
    globalThis.IDBObjectStore = IDBObjectStore;
    globalThis.IDBIndex = IDBIndex;
    globalThis.IDBCursor = IDBCursor;
    globalThis.IDBCursorWithValue = IDBCursorWithValue;
    globalThis.IDBKeyRange = IDBKeyRange;
    globalThis.IDBRecord = IDBRecord;
    Object.defineProperty(globalThis, 'Permissions', { value: Permissions, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'StorageManager', { value: NavigatorStorageManager, writable: true, configurable: true });
    globalThis.PluginArray = PluginArray;
    globalThis.MimeTypeArray = MimeTypeArray;
    globalThis.Plugin = Plugin;
    globalThis.MimeType = MimeType;
    globalThis.NavigatorUAData = NavigatorUAData;
    globalThis.Navigation = Navigation;
    globalThis.NavigationActivation = NavigationActivation;
    globalThis.NavigationCurrentEntryChangeEvent = NavigationCurrentEntryChangeEvent;
    globalThis.NavigationDestination = NavigationDestination;
    globalThis.NavigationHistoryEntry = NavigationHistoryEntry;
    globalThis.NavigationPrecommitController = NavigationPrecommitController;
    globalThis.NavigationTransition = NavigationTransition;
    globalThis.NavigateEvent = NavigateEvent;
    globalThis.ViewTransition = ViewTransition;
    globalThis.ViewTransitionTypeSet = ViewTransitionTypeSet;
    globalThis.VideoPlaybackQuality = VideoPlaybackQuality;
    Object.defineProperty(globalThis, 'Geolocation', { value: Geolocation, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'GeolocationPosition', { value: GeolocationPosition, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'GeolocationCoordinates', { value: GeolocationCoordinates, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'GeolocationPositionError', { value: GeolocationPositionError, writable: true, configurable: true });
    globalThis.NetworkInformation = NetworkInformation;
    Object.defineProperty(globalThis, 'Lock', { value: Lock, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'LockManager', { value: LockManager, writable: true, configurable: true });
    globalThis.UserActivation = UserActivation;
    globalThis.BluetoothUUID = BluetoothUUID;
    Object.defineProperty(globalThis, 'Keyboard', { value: Keyboard, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'KeyboardLayoutMap', { value: KeyboardLayoutMap, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'MediaCapabilities', { value: MediaCapabilities, writable: true, configurable: true });
    globalThis.MediaMetadata = MediaMetadata;
    globalThis.MediaSession = MediaSession;
    globalThis.WindowControlsOverlay = WindowControlsOverlay;
    Object.defineProperty(globalThis, 'LaunchParams', { value: LaunchParams, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'WakeLock', { value: WakeLock, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'WakeLockSentinel', { value: WakeLockSentinel, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'LaunchQueue', { value: LaunchQueue, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'Notification', { value: Notification, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'ReportBody', { value: ReportBody, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'CSPViolationReportBody', { value: CSPViolationReportBody, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'IntegrityViolationReportBody', { value: IntegrityViolationReportBody, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'ReportingObserver', { value: ReportingObserver, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'CrashReportContext', { value: CrashReportContext, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'FeaturePolicy', { value: FeaturePolicy, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'InputDeviceCapabilities', { value: InputDeviceCapabilities, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'InputDeviceInfo', { value: InputDeviceInfo, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'DOMError', { value: DOMError, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'OverconstrainedError', { value: OverconstrainedError, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'QuotaExceededError', { value: QuotaExceededError, writable: true, configurable: true });
    globalThis.RTCIceCandidate = RTCIceCandidate;
    globalThis.RTCSessionDescription = RTCSessionDescription;
    globalThis.RTCError = RTCError;
    globalThis.RTCPeerConnection = RTCPeerConnection;
    globalThis.webkitRTCPeerConnection = RTCPeerConnection;
    globalThis.RTCDataChannel = RTCDataChannel;
    globalThis.RTCDtlsTransport = RTCDtlsTransport;
    globalThis.RTCIceTransport = RTCIceTransport;
    globalThis.RTCSctpTransport = RTCSctpTransport;
    globalThis.RTCDTMFSender = RTCDTMFSender;
    globalThis.RTCRtpReceiver = RTCRtpReceiver;
    globalThis.RTCRtpSender = RTCRtpSender;
    globalThis.RTCRtpTransceiver = RTCRtpTransceiver;
    globalThis.RTCStatsReport = RTCStatsReport;
    globalThis.RTCCertificate = RTCCertificate;
    globalThis.RTCEncodedAudioFrame = RTCEncodedAudioFrame;
    globalThis.RTCEncodedVideoFrame = RTCEncodedVideoFrame;
    globalThis.RTCRtpScriptTransform = RTCRtpScriptTransform;
    installGlobalFacades(emergingGlobalFacades);
    installGlobalPrototypeChains();
    installSchedulerTaskShapes();
    globalThis.IDBRecord = IDBRecord;
    installGlobalFacades(backgroundServiceFacades);
    globalThis.MediaStream = MediaStream;
    globalThis.webkitMediaStream = MediaStream;
    globalThis.MediaStreamTrack = MediaStreamTrack;
    globalThis.CanvasCaptureMediaStreamTrack = CanvasCaptureMediaStreamTrack;
    globalThis.BrowserCaptureMediaStreamTrack = BrowserCaptureMediaStreamTrack;
    Object.defineProperty(globalThis, 'AudioSinkInfo', { value: AudioSinkInfo, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'MediaStreamTrackAudioStats', { value: MediaStreamTrackAudioStats, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'MediaStreamTrackVideoStats', { value: MediaStreamTrackVideoStats, writable: true, configurable: true });
    globalThis.MediaRecorder = MediaRecorder;
    Object.defineProperty(globalThis, 'TrustedHTML', { value: TrustedHTML, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'TrustedScript', { value: TrustedScript, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'TrustedScriptURL', { value: TrustedScriptURL, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'TrustedTypePolicy', { value: TrustedTypePolicy, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'TrustedTypePolicyFactory', { value: TrustedTypePolicyFactory, writable: true, configurable: true });
    globalThis.WakeLock = WakeLock;
    globalThis.WakeLockSentinel = WakeLockSentinel;
    globalThis.RemotePlayback = RemotePlayback;
    Object.defineProperty(globalThis, 'MediaError', { value: MediaError, writable: true, configurable: true });
    installGlobalFacades(streamFacades);
    installGlobalFacades(workerPolicyFacades);
    installGlobalFacades(webSocketStreamFacades);
    Object.defineProperty(globalThis, 'ByteLengthQueuingStrategy', { value: ByteLengthQueuingStrategy, writable: true, configurable: true });
    Object.defineProperty(globalThis, 'CountQueuingStrategy', { value: CountQueuingStrategy, writable: true, configurable: true });
    globalThis.CompressionStream = CompressionStream;
    globalThis.DecompressionStream = DecompressionStream;
    globalThis.TextDecoder = textEncodingFacades.TextDecoder;
    globalThis.TextDecoderStream = textEncodingFacades.TextDecoderStream;
    globalThis.TextEncoder = textEncodingFacades.TextEncoder;
    globalThis.TextEncoderStream = textEncodingFacades.TextEncoderStream;
    Object.defineProperty(globalThis, 'ChapterInformation', { value: ChapterInformation, writable: true, configurable: true });
    globalThis.CropTarget = CropTarget;
    globalThis.RestrictionTarget = RestrictionTarget;
    globalThis.DelegatedInkTrailPresenter = DelegatedInkTrailPresenter;
    globalThis.structuredClone = structuredClone;
    Object.defineProperty(globalThis, 'atob', { value: atob, writable: true, enumerable: true, configurable: true });
    Object.defineProperty(globalThis, 'btoa', { value: btoa, writable: true, enumerable: true, configurable: true });
    globalThis.Crypto = Crypto;
    globalThis.crypto = makeCrypto();
    globalThis.caches = new CacheStorage();
    const indexedDBValue = makeIndexedDBFactory();
    const indexedDBDescriptor = Object.getOwnPropertyDescriptor({ get indexedDB() { return indexedDBValue; } }, 'indexedDB');
    Object.defineProperty(globalThis, 'indexedDB', { get: indexedDBDescriptor.get, enumerable: true, configurable: true });
    globalThis.localStorage = new Storage(storageToken, 'localStorage', storageMaps.localStorage);
    globalThis.sessionStorage = new Storage(storageToken, 'sessionStorage', storageMaps.sessionStorage);
    globalThis.getSelection = () => (globalThis.__zpSelection ||= new Selection());
    globalThis.getComputedStyle = (element) => computedStyle(element);
    globalThis.launchQueue = makeLaunchQueue(config);
    globalThis.crashReport = makeCrashReportContext();
    const trustedTypesValue = makeTrustedTypePolicyFactory();
    const trustedTypesAccessor = Object.getOwnPropertyDescriptor({ get trustedTypes() { return trustedTypesValue; } }, 'trustedTypes');
    Object.defineProperty(globalThis, 'trustedTypes', { get: trustedTypesAccessor.get, enumerable: true, configurable: true });
    installFeaturePolicy(config);
    const navigatorValue = makeNavigator(config);
    const navigatorDescriptor = Object.getOwnPropertyDescriptor({ get navigator() { return navigatorValue; } }, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { get: navigatorDescriptor.get, enumerable: true, configurable: true });
    const clientInformationDescriptor = Object.getOwnPropertyDescriptor({ get clientInformation() { return globalThis.navigator; }, set clientInformation(value) { void value; } }, 'clientInformation');
    Object.defineProperty(globalThis, 'clientInformation', { ...clientInformationDescriptor, enumerable: true, configurable: true });
    const historyValue = makeHistory();
    const historyDescriptor = Object.getOwnPropertyDescriptor({ get history() { return historyValue; } }, 'history');
    Object.defineProperty(globalThis, 'history', { get: historyDescriptor.get, enumerable: true, configurable: true });
    globalThis.navigation = makeNavigation();
    const originDescriptor = Object.getOwnPropertyDescriptor({ get origin() { return globalThis.location?.origin || 'null'; }, set origin(value) { void value; } }, 'origin');
    Object.defineProperty(globalThis, 'origin', { ...originDescriptor, enumerable: true, configurable: true });
    globalThis.__zpDispatchStorageEvent = (payload) => { const data = typeof payload === 'string' ? JSON.parse(payload) : payload; dispatchStorageEvent(data.area, data.key, data.oldValue, data.newValue); return true; };
    globalThis.__zpNotifyMutation = notifyMutation;
    installHostWebAPIReflection(config.hostWebAPIShapes || {});
    normalizeFunctionGlobalDescriptors();
    return true;
  }

  function installHostWebAPIReflection(shapes) {
    for (const [globalName, shape] of Object.entries(shapes || {})) {
      if (shape?.bridge?.autoFacade) installAutoHostWebAPIFacade(globalName, shape);
      const target = globalThis[globalName];
      if (!target || (typeof target !== 'object' && typeof target !== 'function')) continue;
      applyOwnerDescriptors(target, shape.staticDescriptors);
      if (typeof target === 'function' && shape.constructorDescriptor) {
        applyFunctionReflection(target, shape.constructorDescriptor);
        applyOwnerDescriptors(target.prototype, shape.prototypeDescriptors);
        applyToStringTagReflection(target.prototype, shape.prototypeToStringTag);
      } else {
        applyToStringTagReflection(target, shape.objectToStringTag);
      }
      applyGlobalDescriptor(globalName, target, shape.globalDescriptor);
    }
  }

  function installAutoHostWebAPIFacade(globalName, shape) {
    if (!shape?.constructorDescriptor) return;
    const ctor = makeAutoHostBridgeConstructor(globalName, shape);
    if (typeof ctor === 'function') globalThis[globalName] = ctor;
  }

  function makeAutoHostBridgeConstructor(globalName, shape) {
    const bridge = shape.bridge || {};
    const AutoHostBridgeConstructor = function AutoHostBridgeConstructor(...args) {
      if (!new.target) throw new TypeError("Failed to construct '" + globalName + "': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
      const bridged = hostBridgeConstruct(globalName, args);
      if (!bridged.handled) throw new TypeError("Failed to construct '" + globalName + "': host Web API bridge is unavailable.");
      const fields = bridged.value?.fields || {};
      const instance = autoHostBridgeInstance(this, new.target, bridge, fields, globalName);
      autoHostBridgeState.set(instance, {
        globalName,
        handle: String(bridged.value?.handle || ''),
        fields: { ...fields },
      });
      return instance;
    };
    applyFunctionReflection(AutoHostBridgeConstructor, shape.constructorDescriptor);
    const proto = AutoHostBridgeConstructor.prototype;
    const base = autoHostBridgeBasePrototype(bridge.baseClass);
    if (base) Object.setPrototypeOf(proto, base);
    Object.defineProperty(proto, 'constructor', { value: AutoHostBridgeConstructor, writable: true, configurable: true });
    installAutoHostBridgeStatics(AutoHostBridgeConstructor, globalName, shape.staticDescriptors || {});
    installAutoHostBridgePrototype(proto, globalName, bridge, shape.prototypeDescriptors || {});
    applyToStringTagReflection(proto, shape.prototypeToStringTag);
    return AutoHostBridgeConstructor;
  }

  function autoHostBridgeInstance(current, newTarget, bridge, fields, globalName) {
    if (bridge.baseClass === 'DOMException' && typeof globalThis.DOMException === 'function') {
      return Reflect.construct(globalThis.DOMException, [String(fields.message ?? ''), String(fields.name ?? globalName)], newTarget);
    }
    return current;
  }

  function autoHostBridgeBasePrototype(baseClass) {
    const ctor = baseClass ? globalThis[String(baseClass)] : null;
    return typeof ctor === 'function' && ctor.prototype ? ctor.prototype : null;
  }

  function installAutoHostBridgeStatics(ctor, globalName, descriptors) {
    for (const [method, descriptor] of Object.entries(descriptors || {})) {
      if (!descriptor?.value) continue;
      const fn = function autoHostBridgeStatic(...args) {
        const bridged = hostBridgeStatic(globalName, method, args);
        if (bridged.handled) return bridged.value;
        throw new TypeError("Failed to execute '" + method + "' on '" + globalName + "': host Web API bridge is unavailable.");
      };
      applyFunctionReflection(fn, descriptor.value);
      Object.defineProperty(ctor, method, { value: fn, writable: true, configurable: true });
    }
  }

  function installAutoHostBridgePrototype(proto, globalName, bridge, descriptors) {
    const getters = new Set(bridge.prototypeGetters || []);
    const setters = new Set(bridge.prototypeSetters || []);
    for (const property of getters) {
      const descriptor = descriptors[property] || {};
      const get = function autoHostBridgeGet() { return autoHostBridgeGetProperty(this, globalName, property); };
      applyFunctionReflection(get, descriptor.get);
      const propertyDescriptor = { get, enumerable: true, configurable: true };
      if (setters.has(property)) {
        const set = function autoHostBridgeSet(value) { autoHostBridgeSetProperty(this, globalName, property, value); };
        applyFunctionReflection(set, descriptor.set);
        propertyDescriptor.set = set;
      }
      Object.defineProperty(proto, property, propertyDescriptor);
    }
    for (const method of bridge.prototypeMethods || []) {
      const descriptor = descriptors[method] || {};
      const fn = function autoHostBridgeMethod(...args) {
        const state = autoHostBridgeStateFor(this, globalName);
        const bridged = hostBridgeCall({ op: 'method', globalName, method, handle: state.handle, args });
        if (bridged.handled) return bridged.value;
        throw new TypeError("Failed to execute '" + method + "' on '" + globalName + "': host Web API bridge is unavailable.");
      };
      applyFunctionReflection(fn, descriptor.value);
      Object.defineProperty(proto, method, { value: fn, writable: true, enumerable: true, configurable: true });
    }
  }

  function autoHostBridgeGetProperty(target, globalName, property) {
    const state = autoHostBridgeStateFor(target, globalName);
    const bridged = hostBridgeCall({ op: 'get', globalName, property, handle: state.handle });
    if (bridged.handled) {
      state.fields[property] = bridged.value;
      return bridged.value;
    }
    return state.fields[property];
  }

  function autoHostBridgeSetProperty(target, globalName, property, value) {
    const state = autoHostBridgeStateFor(target, globalName);
    const bridged = hostBridgeCall({ op: 'set', globalName, property, handle: state.handle, value });
    state.fields[property] = bridged.handled ? bridged.value : value;
  }

  function autoHostBridgeStateFor(target, globalName) {
    const state = autoHostBridgeState.get(target);
    if (!state || state.globalName !== globalName) throw new TypeError('Illegal invocation');
    return state;
  }

  function applyGlobalDescriptor(name, value, descriptor) {
    if (!descriptor) return;
    try {
      if (descriptor.kind === 'accessor') {
        let currentValue = value;
        const get = function get() { return currentValue; };
        const set = descriptor.set ? function set(nextValue) { currentValue = nextValue; } : undefined;
        applyFunctionReflection(get, descriptor.get);
        applyFunctionReflection(set, descriptor.set);
        Object.defineProperty(globalThis, name, {
          get,
          set,
          enumerable: Boolean(descriptor.enumerable),
          configurable: descriptor.configurable !== false,
        });
        return;
      }
      Object.defineProperty(globalThis, name, {
        value,
        writable: descriptor.writable !== false,
        enumerable: Boolean(descriptor.enumerable),
        configurable: descriptor.configurable !== false,
      });
    } catch {}
  }

  function applyOwnerDescriptors(owner, descriptors) {
    if (!owner) return;
    for (const [key, descriptor] of Object.entries(descriptors || {})) {
      if (key === 'constructor' && typeof owner[key] === 'function') applyFunctionReflection(owner[key], descriptor.value);
      applyPropertyDescriptorReflection(owner, key, descriptor);
    }
  }

  function applyPropertyDescriptorReflection(owner, key, descriptor) {
    if (!descriptor) return;
    const current = Object.getOwnPropertyDescriptor(owner, key);
    if (!current) return;
    try {
      if ('value' in current) {
        if (typeof current.value === 'function') applyFunctionReflection(current.value, descriptor.value);
        Object.defineProperty(owner, key, {
          value: current.value,
          writable: descriptor.writable !== false,
          enumerable: Boolean(descriptor.enumerable),
          configurable: descriptor.configurable !== false,
        });
      } else {
        if (typeof current.get === 'function') applyFunctionReflection(current.get, descriptor.get);
        if (typeof current.set === 'function') applyFunctionReflection(current.set, descriptor.set);
        Object.defineProperty(owner, key, {
          get: current.get,
          set: current.set,
          enumerable: Boolean(descriptor.enumerable),
          configurable: descriptor.configurable !== false,
        });
      }
    } catch {}
  }

  function applyFunctionReflection(fn, descriptor) {
    if (typeof fn !== 'function' || !descriptor) return;
    try { Object.defineProperty(fn, 'name', { value: String(descriptor.name || fn.name || ''), configurable: true }); } catch {}
    try { Object.defineProperty(fn, 'length', { value: Number(descriptor.length || 0), configurable: true }); } catch {}
  }

  function applyToStringTagReflection(proto, descriptor) {
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return;
    try {
      Object.defineProperty(proto, Symbol.toStringTag, {
        value: String(descriptor.value),
        enumerable: Boolean(descriptor.enumerable),
        configurable: descriptor.configurable !== false,
      });
    } catch {}
  }

  const navigatorUADataToken = {};
  const navigatorUADataSlots = new WeakMap();
  class NavigatorUAData {
    constructor(token, config = {}) {
      if (token !== navigatorUADataToken) throw new TypeError("Failed to construct 'NavigatorUAData': Illegal constructor");
      const brand = String(config.uaBrand || 'ZeroProxy');
      const version = String(config.uaVersion || '1');
      const fullVersion = String(config.uaFullVersion || version);
      navigatorUADataSlots.set(this, {
        brands: [{ brand, version }],
        mobile: Boolean(config.mobile),
        platform: String(config.uaPlatform || config.platform || 'ZeroProxy'),
        highEntropy: {
          architecture: String(config.architecture || ''),
          bitness: String(config.bitness || ''),
          fullVersionList: [{ brand, version: fullVersion }],
          model: String(config.model || ''),
          platformVersion: String(config.platformVersion || ''),
          uaFullVersion: fullVersion,
          wow64: Boolean(config.wow64),
        },
      });
    }
    get brands() { return frozenNavigatorBrands(navigatorUADataValue(this).brands); }
    get mobile() { return navigatorUADataValue(this).mobile; }
    get platform() { return navigatorUADataValue(this).platform; }
    getHighEntropyValues(hints) {
      if (arguments.length === 0) throw new TypeError("Failed to execute 'getHighEntropyValues' on 'NavigatorUAData': 1 argument required, but only 0 present.");
      const state = navigatorUADataValue(this);
      const result = { brands: this.brands, mobile: state.mobile, platform: state.platform };
      for (const hint of navigatorUADataHints(hints)) {
        if (Object.hasOwn(state.highEntropy, hint)) result[hint] = hint === 'fullVersionList' ? frozenNavigatorBrands(state.highEntropy[hint]) : state.highEntropy[hint];
      }
      return Promise.resolve(result);
    }
    toJSON() { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; }
  }
  Object.defineProperties(NavigatorUAData.prototype, {
    brands: { ...Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'brands'), enumerable: true },
    mobile: { ...Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'mobile'), enumerable: true },
    platform: { ...Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'platform'), enumerable: true },
    getHighEntropyValues: { ...Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'getHighEntropyValues'), enumerable: true },
    toJSON: { ...Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'toJSON'), enumerable: true },
  });
  Object.defineProperty(NavigatorUAData.prototype, Symbol.toStringTag, { value: 'NavigatorUAData', configurable: true });

  function navigatorUADataValue(value) {
    const state = navigatorUADataSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function frozenNavigatorBrands(brands) {
    return Object.freeze(brands.map(({ brand, version }) => ({ brand, version })));
  }

  function navigatorUADataHints(hints) {
    if (!hints || typeof hints === 'string' || typeof hints[Symbol.iterator] !== 'function') throw new TypeError("Failed to execute 'getHighEntropyValues' on 'NavigatorUAData': The provided value cannot be converted to a sequence.");
    const values = [];
    for (const hint of hints) {
      if (typeof hint === 'symbol') throw new TypeError("Failed to execute 'getHighEntropyValues' on 'NavigatorUAData': Cannot convert a Symbol value to a string");
      values.push(String(hint));
    }
    return values;
  }

  const geolocationToken = {};
  let nextGeolocationWatchId = 1;

  const geolocationSlots = new WeakMap();
  function Geolocation() {
    if (new.target) throw new TypeError("Failed to construct 'Geolocation': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  function makeGeolocation() {
    const geolocation = Object.create(Geolocation.prototype);
    geolocationSlots.set(geolocation, { watches: new Set() });
    return geolocation;
  }
  delete Geolocation.prototype.constructor;
  Object.defineProperties(Geolocation.prototype, {
    clearWatch: {
      value: function clearWatch(watchId) { geolocationValue(this).watches.delete(Number(watchId)); },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    getCurrentPosition: {
      value: function getCurrentPosition(successCallback) {
        const errorCallback = arguments[1];
        if (typeof successCallback !== 'function') throw new TypeError("Failed to execute 'getCurrentPosition' on 'Geolocation': parameter 1 is not a function.");
        queueGeolocationDenied(errorCallback);
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    watchPosition: {
      value: function watchPosition(successCallback) {
        const errorCallback = arguments[1];
        if (typeof successCallback !== 'function') throw new TypeError("Failed to execute 'watchPosition' on 'Geolocation': parameter 1 is not a function.");
        const watchId = nextGeolocationWatchId++;
        geolocationValue(this).watches.add(watchId);
        Promise.resolve().then(() => {
          if (geolocationValue(this).watches.has(watchId)) queueGeolocationDenied(errorCallback);
        });
        return watchId;
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    constructor: { value: Geolocation, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(Geolocation.prototype, Symbol.toStringTag, { value: 'Geolocation', configurable: true });

  const geolocationCoordinatesSlots = new WeakMap();
  function GeolocationCoordinates(token, init = {}) {
    if (token !== geolocationToken) {
      if (new.target) throw new TypeError("Failed to construct 'GeolocationCoordinates': Illegal constructor");
      throw new TypeError('Illegal constructor');
    }
    geolocationCoordinatesSlots.set(this, {
      latitude: Number(init.latitude ?? 0),
      longitude: Number(init.longitude ?? 0),
      accuracy: Number(init.accuracy ?? 0),
      altitude: init.altitude ?? null,
      altitudeAccuracy: init.altitudeAccuracy ?? null,
      heading: init.heading ?? null,
      speed: init.speed ?? null,
    });
  }
  const geolocationCoordinatesToJSON = function toJSON() {
    const state = geolocationCoordinatesValue(this);
    return { latitude: state.latitude, longitude: state.longitude, altitude: state.altitude, accuracy: state.accuracy, altitudeAccuracy: state.altitudeAccuracy, heading: state.heading, speed: state.speed };
  };
  delete GeolocationCoordinates.prototype.constructor;
  Object.defineProperties(GeolocationCoordinates.prototype, {
    latitude: { get() { return geolocationCoordinatesValue(this).latitude; }, enumerable: true, configurable: true },
    longitude: { get() { return geolocationCoordinatesValue(this).longitude; }, enumerable: true, configurable: true },
    altitude: { get() { return geolocationCoordinatesValue(this).altitude; }, enumerable: true, configurable: true },
    accuracy: { get() { return geolocationCoordinatesValue(this).accuracy; }, enumerable: true, configurable: true },
    altitudeAccuracy: { get() { return geolocationCoordinatesValue(this).altitudeAccuracy; }, enumerable: true, configurable: true },
    heading: { get() { return geolocationCoordinatesValue(this).heading; }, enumerable: true, configurable: true },
    speed: { get() { return geolocationCoordinatesValue(this).speed; }, enumerable: true, configurable: true },
    toJSON: { value: geolocationCoordinatesToJSON, enumerable: true, writable: true, configurable: true },
    constructor: { value: GeolocationCoordinates, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(GeolocationCoordinates.prototype, Symbol.toStringTag, { value: 'GeolocationCoordinates', configurable: true });

  const geolocationPositionSlots = new WeakMap();
  function GeolocationPosition(token, coords, timestamp = Date.now()) {
    if (token !== geolocationToken) {
      if (new.target) throw new TypeError("Failed to construct 'GeolocationPosition': Illegal constructor");
      throw new TypeError('Illegal constructor');
    }
    geolocationPositionSlots.set(this, { coords, timestamp: Number(timestamp) });
  }
  const geolocationPositionToJSON = function toJSON() {
    const state = geolocationPositionValue(this);
    return { coords: state.coords.toJSON?.() || state.coords, timestamp: state.timestamp };
  };
  delete GeolocationPosition.prototype.constructor;
  Object.defineProperties(GeolocationPosition.prototype, {
    coords: { get() { return geolocationPositionValue(this).coords; }, enumerable: true, configurable: true },
    timestamp: { get() { return geolocationPositionValue(this).timestamp; }, enumerable: true, configurable: true },
    toJSON: { value: geolocationPositionToJSON, enumerable: true, writable: true, configurable: true },
    constructor: { value: GeolocationPosition, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(GeolocationPosition.prototype, Symbol.toStringTag, { value: 'GeolocationPosition', configurable: true });

  const geolocationPositionErrorSlots = new WeakMap();
  function GeolocationPositionError(token, code, message) {
    if (token !== geolocationToken) {
      if (new.target) throw new TypeError("Failed to construct 'GeolocationPositionError': Illegal constructor");
      throw new TypeError('Illegal constructor');
    }
    geolocationPositionErrorSlots.set(this, { code: Number(code), message: String(message || '') });
  }
  delete GeolocationPositionError.prototype.constructor;
  Object.defineProperties(GeolocationPositionError.prototype, {
    code: { get() { return geolocationPositionErrorValue(this).code; }, enumerable: true, configurable: true },
    message: { get() { return geolocationPositionErrorValue(this).message; }, enumerable: true, configurable: true },
  });
  for (const [name, code] of Object.entries({ PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 })) {
    Object.defineProperty(GeolocationPositionError, name, { value: code, enumerable: true });
    Object.defineProperty(GeolocationPositionError.prototype, name, { value: code, enumerable: true });
  }
  Object.defineProperty(GeolocationPositionError.prototype, 'constructor', { value: GeolocationPositionError, writable: true, configurable: true });
  Object.defineProperty(GeolocationPositionError.prototype, Symbol.toStringTag, { value: 'GeolocationPositionError', configurable: true });

  function geolocationValue(value) {
    const state = geolocationSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function geolocationCoordinatesValue(value) {
    const state = geolocationCoordinatesSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function geolocationPositionValue(value) {
    const state = geolocationPositionSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function geolocationPositionErrorValue(value) {
    const state = geolocationPositionErrorSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function queueGeolocationDenied(errorCallback) {
    if (typeof errorCallback !== 'function') return;
    Promise.resolve().then(() => errorCallback(new GeolocationPositionError(geolocationToken, GeolocationPositionError.PERMISSION_DENIED, 'User denied Geolocation')));
  }

  const networkInformationSlots = new WeakMap();
  function NetworkInformation() { throw new TypeError("Failed to construct 'NetworkInformation': Illegal constructor"); }
  Object.defineProperty(NetworkInformation, Symbol.hasInstance, { value: (value) => networkInformationSlots.has(value), configurable: true });

  class VirtualNetworkInformation extends EventTarget {
    constructor(config = {}) {
      super();
      networkInformationSlots.set(this, {
        effectiveType: String(config.effectiveType || '4g'),
        downlink: Number(config.downlink ?? 10),
        rtt: Number(config.rtt ?? 50),
        saveData: Boolean(config.saveData),
      });
    }
    get onchange() { return this.__zp_onchange || null; }
    set onchange(value) { this.__zp_onchange = typeof value === 'function' ? value : null; }
    get effectiveType() { return networkInformationValue(this).effectiveType; }
    get rtt() { return networkInformationValue(this).rtt; }
    get downlink() { return networkInformationValue(this).downlink; }
    get saveData() { return networkInformationValue(this).saveData; }
  }
  Object.defineProperty(VirtualNetworkInformation.prototype, Symbol.toStringTag, { value: 'NetworkInformation', configurable: true });
  Object.defineProperty(NetworkInformation, 'prototype', { value: VirtualNetworkInformation.prototype });
  Object.defineProperty(VirtualNetworkInformation.prototype, 'constructor', { value: NetworkInformation, writable: true, configurable: true });
  Object.defineProperties(VirtualNetworkInformation.prototype, {
    onchange: { ...Object.getOwnPropertyDescriptor(VirtualNetworkInformation.prototype, 'onchange'), enumerable: true },
    effectiveType: { ...Object.getOwnPropertyDescriptor(VirtualNetworkInformation.prototype, 'effectiveType'), enumerable: true },
    rtt: { ...Object.getOwnPropertyDescriptor(VirtualNetworkInformation.prototype, 'rtt'), enumerable: true },
    downlink: { ...Object.getOwnPropertyDescriptor(VirtualNetworkInformation.prototype, 'downlink'), enumerable: true },
    saveData: { ...Object.getOwnPropertyDescriptor(VirtualNetworkInformation.prototype, 'saveData'), enumerable: true },
  });

  function networkInformationValue(value) {
    const state = networkInformationSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  const userActivationSlots = new WeakMap();
  function UserActivation() { throw new TypeError("Failed to construct 'UserActivation': Illegal constructor"); }
  Object.defineProperty(UserActivation, Symbol.hasInstance, { value: (value) => userActivationSlots.has(value), configurable: true });
  Object.defineProperties(UserActivation.prototype, {
    isActive: {
      get() {
        const state = userActivationSlots.get(this);
        if (!state) throw new TypeError('Illegal invocation');
        return state.isActive;
      },
      enumerable: true,
      configurable: true,
    },
    hasBeenActive: {
      get() {
        const state = userActivationSlots.get(this);
        if (!state) throw new TypeError('Illegal invocation');
        return state.hasBeenActive;
      },
      enumerable: true,
      configurable: true,
    },
    [Symbol.toStringTag]: { value: 'UserActivation', configurable: true },
  });
  function makeUserActivation() {
    const activation = Object.create(UserActivation.prototype);
    userActivationSlots.set(activation, { isActive: false, hasBeenActive: false });
    return activation;
  }

  const bluetoothUUIDBase = '-0000-1000-8000-00805f9b34fb';
  const bluetoothUUIDServices = new Map([
    ['generic_access', 0x1800],
    ['generic_attribute', 0x1801],
    ['device_information', 0x180a],
    ['heart_rate', 0x180d],
    ['battery_service', 0x180f],
  ]);
  const bluetoothUUIDCharacteristics = new Map([
    ['gap.device_name', 0x2a00],
    ['gatt.service_changed', 0x2a05],
    ['manufacturer_name_string', 0x2a29],
    ['heart_rate_measurement', 0x2a37],
    ['battery_level', 0x2a19],
  ]);
  const bluetoothUUIDDescriptors = new Map([
    ['gatt.client_characteristic_configuration', 0x2902],
    ['gatt.characteristic_user_description', 0x2901],
  ]);

  class BluetoothUUID {
    constructor() { throw new TypeError("Failed to construct 'BluetoothUUID': Illegal constructor"); }
    static canonicalUUID(alias) {
      const bridged = hostBridgeStatic('BluetoothUUID', 'canonicalUUID', Array.from(arguments));
      if (bridged.handled) return bridged.value;
      return canonicalBluetoothUUID(alias);
    }
    static getService(name) {
      const bridged = hostBridgeStatic('BluetoothUUID', 'getService', Array.from(arguments));
      if (bridged.handled) return bridged.value;
      return canonicalBluetoothUUID(resolveBluetoothUUIDName(name, bluetoothUUIDServices, 'service'));
    }
    static getCharacteristic(name) {
      const bridged = hostBridgeStatic('BluetoothUUID', 'getCharacteristic', Array.from(arguments));
      if (bridged.handled) return bridged.value;
      return canonicalBluetoothUUID(resolveBluetoothUUIDName(name, bluetoothUUIDCharacteristics, 'characteristic'));
    }
    static getDescriptor(name) {
      const bridged = hostBridgeStatic('BluetoothUUID', 'getDescriptor', Array.from(arguments));
      if (bridged.handled) return bridged.value;
      return canonicalBluetoothUUID(resolveBluetoothUUIDName(name, bluetoothUUIDDescriptors, 'descriptor'));
    }
  }
  Object.defineProperty(BluetoothUUID.prototype, Symbol.toStringTag, { value: 'BluetoothUUID', configurable: true });

  function resolveBluetoothUUIDName(value, map, kind) {
    if (typeof value === 'number') return value;
    const key = String(value);
    if (map.has(key)) return map.get(key);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) return key;
    throw new TypeError('Unknown Bluetooth UUID ' + kind + ': ' + key);
  }

  function canonicalBluetoothUUID(alias) {
    if (typeof alias === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(alias)) return alias.toLowerCase();
    const value = Number(alias);
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new TypeError('Bluetooth UUID alias must be a 32-bit unsigned integer.');
    return value.toString(16).padStart(8, '0') + bluetoothUUIDBase;
  }

  function KeyboardLayoutMap() {
    if (new.target) throw new TypeError("Failed to construct 'KeyboardLayoutMap': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }

  function makeKeyboardLayoutMap(entries = []) {
    const layout = Object.create(KeyboardLayoutMap.prototype);
    keyboardLayoutMapSlots.set(layout, new Map(entries));
    return layout;
  }
  delete KeyboardLayoutMap.prototype.constructor;
  Object.defineProperties(KeyboardLayoutMap.prototype, {
    size: { get() { return keyboardLayoutMapValue(this).size; }, enumerable: true, configurable: true },
    entries: { value: function entries() { return keyboardLayoutMapValue(this).entries(); }, enumerable: true, writable: true, configurable: true },
    forEach: { value: function forEach(callback) {
      if (typeof callback !== 'function') throw new TypeError("Failed to execute 'forEach' on 'KeyboardLayoutMap': parameter 1 is not of type 'Function'.");
      const thisArg = arguments.length > 1 ? arguments[1] : undefined;
      return keyboardLayoutMapValue(this).forEach((value, key) => callback.call(thisArg, value, key, this));
    }, enumerable: true, writable: true, configurable: true },
    get: { value: function get(key) { return keyboardLayoutMapValue(this).get(String(key)); }, enumerable: true, writable: true, configurable: true },
    has: { value: function has(key) { return keyboardLayoutMapValue(this).has(String(key)); }, enumerable: true, writable: true, configurable: true },
    keys: { value: function keys() { return keyboardLayoutMapValue(this).keys(); }, enumerable: true, writable: true, configurable: true },
    values: { value: function values() { return keyboardLayoutMapValue(this).values(); }, enumerable: true, writable: true, configurable: true },
  });
  Object.defineProperty(KeyboardLayoutMap.prototype, 'constructor', { value: KeyboardLayoutMap, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(KeyboardLayoutMap.prototype, Symbol.toStringTag, { value: 'KeyboardLayoutMap', configurable: true });
  Object.defineProperty(KeyboardLayoutMap.prototype, Symbol.iterator, { value: KeyboardLayoutMap.prototype.entries, writable: true, configurable: true });
  function keyboardLayoutMapValue(value) {
    const data = keyboardLayoutMapSlots.get(value);
    if (!data) throw new TypeError('Illegal invocation');
    return data;
  }

  function Keyboard() {
    if (new.target) throw new TypeError("Failed to construct 'Keyboard': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }

  function makeKeyboard(config = {}) {
    const keyboard = Object.create(Keyboard.prototype);
    keyboardSlots.set(keyboard, { layoutEntries: Object.entries(config.layout || {}) });
    return keyboard;
  }
  delete Keyboard.prototype.constructor;
  Object.defineProperties(Keyboard.prototype, {
    getLayoutMap: { value: function getLayoutMap() { return Promise.resolve(makeKeyboardLayoutMap(keyboardValue(this).layoutEntries)); }, enumerable: true, writable: true, configurable: true },
    lock: { value: function lock() { keyboardValue(this); return Promise.resolve(); }, enumerable: true, writable: true, configurable: true },
    unlock: { value: function unlock() { keyboardValue(this); return undefined; }, enumerable: true, writable: true, configurable: true },
  });
  Object.defineProperty(Keyboard.prototype, 'constructor', { value: Keyboard, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(Keyboard.prototype, Symbol.toStringTag, { value: 'Keyboard', configurable: true });
  function keyboardValue(value) {
    const state = keyboardSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function WindowControlsOverlay() { throw new TypeError("Failed to construct 'WindowControlsOverlay': Illegal constructor"); }
  Object.defineProperty(WindowControlsOverlay, Symbol.hasInstance, { value: (value) => Boolean(value?.__zpWindowControlsOverlay), configurable: true });

  function makeWindowControlsOverlayRect() {
    return new DOMRect(0, 0, 0, 0);
  }

  class VirtualWindowControlsOverlay extends EventTarget {
    constructor() {
      super();
      this.__zpWindowControlsOverlay = true;
      this.visible = false;
    }
    getTitlebarAreaRect() {
      return makeWindowControlsOverlayRect();
    }
  }
  Object.defineProperty(VirtualWindowControlsOverlay.prototype, Symbol.toStringTag, { value: 'WindowControlsOverlay', configurable: true });

  function makeWindowControlsOverlay() {
    return new VirtualWindowControlsOverlay();
  }

  function WakeLockSentinel(token, type) {
    if (!new.target) throw new TypeError('Illegal constructor');
    if (token !== wakeLockSentinelToken) throw new TypeError("Failed to construct 'WakeLockSentinel': Illegal constructor");
    const sentinel = Reflect.construct(EventTarget, [], new.target);
    wakeLockSentinelSlots.set(sentinel, { type, released: false, onrelease: null });
    return sentinel;
  }
  WakeLockSentinel.prototype = Object.create(EventTarget.prototype);
  Object.defineProperties(WakeLockSentinel.prototype, {
    onrelease: {
      get() { return wakeLockSentinelValue(this).onrelease; },
      set(value) { wakeLockSentinelValue(this).onrelease = typeof value === 'function' ? value : null; },
      enumerable: true,
      configurable: true,
    },
    released: { get() { return wakeLockSentinelValue(this).released; }, enumerable: true, configurable: true },
    type: { get() { return wakeLockSentinelValue(this).type; }, enumerable: true, configurable: true },
    release: {
      value: async function release() {
        const state = wakeLockSentinelValue(this);
        if (!state.released) {
          state.released = true;
          const event = new Event('release');
          this.dispatchEvent(event);
        }
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    constructor: { value: WakeLockSentinel, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(WakeLockSentinel.prototype, Symbol.toStringTag, { value: 'WakeLockSentinel', configurable: true });
  function wakeLockSentinelValue(value) {
    const state = wakeLockSentinelSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function WakeLock() {
    if (new.target) throw new TypeError("Failed to construct 'WakeLock': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }

  function makeWakeLock() {
    const wakeLock = Object.create(WakeLock.prototype);
    wakeLockSlots.set(wakeLock, {});
    return wakeLock;
  }
  delete WakeLock.prototype.constructor;
  Object.defineProperties(WakeLock.prototype, {
    request: { value: function request(type = 'screen') {
      wakeLockValue(this);
      const requested = String(type);
      if (requested !== 'screen') return Promise.reject(new TypeError(`Failed to execute 'request' on 'WakeLock': The provided value '${requested}' is not a valid enum value of type WakeLockType.`));
      return Promise.resolve(new WakeLockSentinel(wakeLockSentinelToken, requested));
    }, enumerable: true, writable: true, configurable: true },
    constructor: { value: WakeLock, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(WakeLock.prototype, Symbol.toStringTag, { value: 'WakeLock', configurable: true });
  function wakeLockValue(value) {
    const state = wakeLockSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function Gamepad() {
    if (new.target) throw new TypeError("Failed to construct 'Gamepad': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  delete Gamepad.prototype.constructor;
  Object.defineProperties(Gamepad.prototype, {
    id: { get() { return gamepadValue(this).id; }, enumerable: true, configurable: true },
    index: { get() { return gamepadValue(this).index; }, enumerable: true, configurable: true },
    connected: { get() { return gamepadValue(this).connected; }, enumerable: true, configurable: true },
    timestamp: { get() { return gamepadValue(this).timestamp; }, enumerable: true, configurable: true },
    mapping: { get() { return gamepadValue(this).mapping; }, enumerable: true, configurable: true },
    axes: { get() { return gamepadValue(this).axes; }, enumerable: true, configurable: true },
    buttons: { get() { return gamepadValue(this).buttons; }, enumerable: true, configurable: true },
    vibrationActuator: { get() { return gamepadValue(this).vibrationActuator; }, enumerable: true, configurable: true },
    constructor: { value: Gamepad, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(Gamepad.prototype, Symbol.toStringTag, { value: 'Gamepad', configurable: true });
  function gamepadValue(value) {
    const state = gamepadSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function GamepadButton() {
    if (new.target) throw new TypeError("Failed to construct 'GamepadButton': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  delete GamepadButton.prototype.constructor;
  Object.defineProperties(GamepadButton.prototype, {
    pressed: { get() { return gamepadButtonValue(this).pressed; }, enumerable: true, configurable: true },
    touched: { get() { return gamepadButtonValue(this).touched; }, enumerable: true, configurable: true },
    value: { get() { return gamepadButtonValue(this).value; }, enumerable: true, configurable: true },
    constructor: { value: GamepadButton, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(GamepadButton.prototype, Symbol.toStringTag, { value: 'GamepadButton', configurable: true });
  function gamepadButtonValue(value) {
    const state = gamepadButtonSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function emptyGamepads() { return [null, null, null, null]; }

  function Credential() {
    if (new.target) throw new TypeError("Failed to construct 'Credential': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  delete Credential.prototype.constructor;
  Object.defineProperties(Credential.prototype, {
    id: { get() { return credentialValue(this).id; }, enumerable: true, configurable: true },
    type: { get() { return credentialValue(this).type; }, enumerable: true, configurable: true },
    constructor: { value: Credential, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(Credential.prototype, Symbol.toStringTag, { value: 'Credential', configurable: true });
  Object.defineProperty(Credential, 'isConditionalMediationAvailable', {
    value: function isConditionalMediationAvailable() { return Promise.resolve(false); },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  function credentialValue(value) {
    const state = credentialSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function CredentialsContainer() {
    if (new.target) throw new TypeError("Failed to construct 'CredentialsContainer': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }

  function makeCredentialsContainer() {
    const container = Object.create(CredentialsContainer.prototype);
    credentialsContainerSlots.set(container, {});
    return container;
  }
  delete CredentialsContainer.prototype.constructor;
  Object.defineProperties(CredentialsContainer.prototype, {
    create: { value: function create(options = {}) {
      credentialsContainerValue(this);
      if (!Object.keys(Object(options)).length) return Promise.reject(namedError('NotSupportedError', "Only exactly one of 'password', 'federated', and 'publicKey' credential types are currently supported."));
      return Promise.resolve(null);
    }, enumerable: true, writable: true, configurable: true },
    get: { value: function get(options = {}) {
      credentialsContainerValue(this);
      if (!Object.keys(Object(options)).length) return Promise.reject(namedError('NotSupportedError', 'No credential type was specified in the request.'));
      return Promise.resolve(null);
    }, enumerable: true, writable: true, configurable: true },
    preventSilentAccess: { value: function preventSilentAccess() { credentialsContainerValue(this); return Promise.resolve(); }, enumerable: true, writable: true, configurable: true },
    store: { value: function store(credential) {
      credentialsContainerValue(this);
      if (arguments.length < 1) return Promise.reject(new TypeError("Failed to execute 'store' on 'CredentialsContainer': 1 argument required, but only 0 present."));
      if (!(credential instanceof Credential)) return Promise.reject(new TypeError("Failed to execute 'store' on 'CredentialsContainer': parameter 1 is not of type 'Credential'."));
      return Promise.resolve(credential);
    }, enumerable: true, writable: true, configurable: true },
    constructor: { value: CredentialsContainer, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(CredentialsContainer.prototype, Symbol.toStringTag, { value: 'CredentialsContainer', configurable: true });
  function credentialsContainerValue(value) {
    const state = credentialsContainerSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function PaymentResponse() { throw new TypeError("Failed to construct 'PaymentResponse': Illegal constructor"); }
  Object.defineProperty(PaymentResponse, Symbol.hasInstance, { value: (value) => Boolean(value?.__zpPaymentResponse), configurable: true });
  Object.defineProperty(PaymentResponse.prototype, Symbol.toStringTag, { value: 'PaymentResponse', configurable: true });

  function PaymentAddress() { throw new TypeError("Failed to construct 'PaymentAddress': Illegal constructor"); }
  Object.defineProperty(PaymentAddress, Symbol.hasInstance, { value: (value) => Boolean(value?.__zpPaymentAddress), configurable: true });
  Object.defineProperty(PaymentAddress.prototype, Symbol.toStringTag, { value: 'PaymentAddress', configurable: true });

  class PaymentRequest extends EventTarget {
    constructor(methodData, details = {}, options = {}) {
      super();
      if (!Array.isArray(methodData) || methodData.length === 0) throw new TypeError("Failed to construct 'PaymentRequest': methodData must be a non-empty sequence.");
      this.id = String(details.id || 'payment-request');
      this.shippingAddress = null;
      this.shippingOption = null;
      this.shippingType = options.shippingType || null;
    }
    canMakePayment() { return Promise.resolve(false); }
    hasEnrolledInstrument() { return Promise.resolve(false); }
    show() { return Promise.reject(namedError('NotAllowedError')); }
    abort() { return Promise.resolve(undefined); }
  }
  Object.defineProperty(PaymentRequest.prototype, Symbol.toStringTag, { value: 'PaymentRequest', configurable: true });

  function ContactAddress() { throw new TypeError("Failed to construct 'ContactAddress': Illegal constructor"); }
  Object.defineProperty(ContactAddress, Symbol.hasInstance, { value: (value) => Boolean(value?.__zpContactAddress), configurable: true });
  Object.defineProperty(ContactAddress.prototype, Symbol.toStringTag, { value: 'ContactAddress', configurable: true });

  function ContactsManager() { throw new TypeError("Failed to construct 'ContactsManager': Illegal constructor"); }
  Object.defineProperty(ContactsManager, Symbol.hasInstance, { value: (value) => Boolean(value?.__zpContactsManager), configurable: true });

  function makeContactsManager() {
    const contacts = Object.create(ContactsManager.prototype);
    Object.defineProperty(contacts, '__zpContactsManager', { value: true, configurable: true });
    contacts.getProperties = () => Promise.resolve(Object.freeze(['name', 'email', 'tel', 'address', 'icon']));
    contacts.select = () => Promise.reject(namedError('NotAllowedError'));
    return Object.freeze(contacts);
  }
  Object.defineProperty(ContactsManager.prototype, Symbol.toStringTag, { value: 'ContactsManager', configurable: true });

  const launchParamsSlots = new WeakMap();
  function LaunchParams() {
    if (new.target) throw new TypeError("Failed to construct 'LaunchParams': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  function launchParamsValue(params) {
    const state = launchParamsSlots.get(params);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }
  delete LaunchParams.prototype.constructor;
  Object.defineProperties(LaunchParams.prototype, {
    targetURL: { get() { return launchParamsValue(this).targetURL; }, enumerable: true, configurable: true },
    files: { get() { return launchParamsValue(this).files; }, enumerable: true, configurable: true },
    constructor: { value: LaunchParams, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(LaunchParams.prototype, Symbol.toStringTag, { value: 'LaunchParams', configurable: true });

  function makeLaunchParams(init = {}) {
    const params = Object.create(LaunchParams.prototype);
    launchParamsSlots.set(params, {
      targetURL: init.targetURL == null ? null : String(init.targetURL),
      files: Object.freeze(Array.from(init.files || [])),
    });
    return params;
  }

  const launchQueueSlots = new WeakMap();
  function LaunchQueue() {
    if (new.target) throw new TypeError("Failed to construct 'LaunchQueue': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  function launchQueueValue(queue) {
    const state = launchQueueSlots.get(queue);
    if (!state) throw new TypeError("Failed to execute 'setConsumer' on 'LaunchQueue': Illegal invocation");
    return state;
  }
  function makeLaunchQueue(config = {}) {
    const queue = Object.create(LaunchQueue.prototype);
    const pending = Array.isArray(config.launchParams) ? [...config.launchParams] : (config.launchParams ? [config.launchParams] : []);
    launchQueueSlots.set(queue, { pending, consumer: null });
    return queue;
  }
  delete LaunchQueue.prototype.constructor;
  Object.defineProperties(LaunchQueue.prototype, {
    setConsumer: {
      value: function setConsumer(nextConsumer) {
        if (typeof nextConsumer !== 'function') throw new TypeError("Failed to execute 'setConsumer' on 'LaunchQueue': parameter 1 is not of type 'Function'.");
        const state = launchQueueValue(this);
        state.consumer = nextConsumer;
        for (const init of state.pending.splice(0)) {
          Promise.resolve().then(() => {
            if (state.consumer === nextConsumer) state.consumer(makeLaunchParams(init));
          });
        }
        return undefined;
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    constructor: { value: LaunchQueue, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(LaunchQueue.prototype, Symbol.toStringTag, { value: 'LaunchQueue', configurable: true });

  class Notification extends EventTarget {
    constructor(title, options = {}) {
      if (arguments.length < 1) throw new TypeError("Failed to construct 'Notification': 1 argument required, but only 0 present.");
      super();
      const actions = Array.isArray(options.actions) ? options.actions : [];
      if (actions.length) throw new TypeError("Failed to construct 'Notification': Actions are only supported for persistent notifications shown using ServiceWorkerRegistration.showNotification().");
      const vibrate = Array.isArray(options.vibrate) ? Array.from(options.vibrate, Number) : [];
      if (options.silent === true && vibrate.length) throw new TypeError("Failed to construct 'Notification': Silent notifications must not specify vibration patterns.");
      notificationSlots.set(this, {
        onclick: null,
        onshow: null,
        onerror: null,
        onclose: null,
        title: String(title),
        dir: ['auto', 'ltr', 'rtl'].includes(options.dir) ? options.dir : 'auto',
        lang: String(options.lang || ''),
        body: String(options.body || ''),
        tag: String(options.tag || ''),
        icon: String(options.icon || ''),
        badge: String(options.badge || ''),
        vibrate: Object.freeze(vibrate),
        timestamp: Number(options.timestamp ?? Date.now()),
        renotify: Boolean(options.renotify),
        silent: options.silent === undefined ? null : Boolean(options.silent),
        requireInteraction: Boolean(options.requireInteraction),
        data: options.data === undefined ? null : options.data,
        actions: Object.freeze([]),
      });
    }
    static get permission() { return 'denied'; }
    static get maxActions() { return 0; }
    static requestPermission(callback) {
      const result = Promise.resolve('denied');
      if (typeof callback === 'function') result.then(callback);
      return result;
    }
    close() {}
  }
  delete Notification.prototype.constructor;
  delete Notification.prototype.close;
  for (const name of ['onclick', 'onshow', 'onerror', 'onclose']) {
    Object.defineProperty(Notification.prototype, name, {
      get() { return notificationValue(this)[name]; },
      set(value) { notificationValue(this)[name] = typeof value === 'function' ? value : null; },
      enumerable: true,
      configurable: true,
    });
  }
  for (const name of ['title', 'dir', 'lang', 'body', 'tag', 'icon', 'badge', 'vibrate', 'timestamp', 'renotify', 'silent', 'requireInteraction', 'data', 'actions']) {
    Object.defineProperty(Notification.prototype, name, {
      get() { return notificationValue(this)[name]; },
      enumerable: true,
      configurable: true,
    });
  }
  Object.defineProperty(Notification.prototype, 'close', { value: Notification.prototype.close, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(Notification.prototype, 'constructor', { value: Notification, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(Notification.prototype, Symbol.toStringTag, { value: 'Notification', configurable: true });
  for (const name of ['permission', 'maxActions']) {
    const descriptor = Object.getOwnPropertyDescriptor(Notification, name);
    Object.defineProperty(Notification, name, { ...descriptor, enumerable: true, configurable: true });
  }
  Object.defineProperty(Notification, 'requestPermission', { value: Notification.requestPermission, enumerable: true, writable: true, configurable: true });
  function notificationValue(value) {
    const state = notificationSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  const reportBodySlots = new WeakMap();
  function ReportBody() {
    if (new.target) throw new TypeError("Failed to construct 'ReportBody': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  function reportBodyValue(value) {
    const body = reportBodySlots.get(value);
    if (!body) throw new TypeError('Illegal invocation');
    return body;
  }
  function reportBodyToJSON() { return { ...reportBodyValue(this) }; }
  delete ReportBody.prototype.constructor;
  Object.defineProperties(ReportBody.prototype, {
    toJSON: { value: reportBodyToJSON, enumerable: true, writable: true, configurable: true },
    constructor: { value: ReportBody, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(reportBodyToJSON, 'name', { value: 'toJSON', configurable: true });
  Object.defineProperty(ReportBody.prototype, Symbol.toStringTag, { value: 'ReportBody', configurable: true });

  function CSPViolationReportBody() {
    if (new.target) throw new TypeError("Failed to construct 'CSPViolationReportBody': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  function reportGetter(key) { return function getReportValue() { return reportBodyValue(this)[key]; }; }
  function defineReportGetters(proto, keys) {
    for (const key of keys) Object.defineProperty(proto, key, { get: reportGetter(key), enumerable: true, configurable: true });
  }
  delete CSPViolationReportBody.prototype.constructor;
  Object.setPrototypeOf(CSPViolationReportBody.prototype, ReportBody.prototype);
  defineReportGetters(CSPViolationReportBody.prototype, ['documentURL', 'referrer', 'blockedURL', 'effectiveDirective', 'originalPolicy', 'sourceFile', 'sample', 'disposition', 'statusCode', 'lineNumber', 'columnNumber']);
  Object.defineProperties(CSPViolationReportBody.prototype, {
    toJSON: { value: reportBodyToJSON, enumerable: true, writable: true, configurable: true },
    constructor: { value: CSPViolationReportBody, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(CSPViolationReportBody.prototype, Symbol.toStringTag, { value: 'CSPViolationReportBody', configurable: true });

  function IntegrityViolationReportBody() {
    if (new.target) throw new TypeError("Failed to construct 'IntegrityViolationReportBody': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  delete IntegrityViolationReportBody.prototype.constructor;
  Object.setPrototypeOf(IntegrityViolationReportBody.prototype, ReportBody.prototype);
  defineReportGetters(IntegrityViolationReportBody.prototype, ['documentURL', 'blockedURL', 'destination', 'reportOnly']);
  Object.defineProperties(IntegrityViolationReportBody.prototype, {
    toJSON: { value: reportBodyToJSON, enumerable: true, writable: true, configurable: true },
    constructor: { value: IntegrityViolationReportBody, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(IntegrityViolationReportBody.prototype, Symbol.toStringTag, { value: 'IntegrityViolationReportBody', configurable: true });

  const reportingObserverSlots = new WeakMap();
  function ReportingObserver(callback, options = {}) {
    if (!new.target) throw new TypeError("Failed to construct 'ReportingObserver': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (arguments.length < 1) throw new TypeError("Failed to construct 'ReportingObserver': 1 argument required, but only 0 present.");
    if (typeof callback !== 'function') throw new TypeError("Failed to construct 'ReportingObserver': parameter 1 is not of type 'Function'.");
    reportingObserverSlots.set(this, {
      callback,
      types: options?.types === undefined ? null : new Set(Array.from(options.types || []).map(String)),
      buffered: Boolean(options?.buffered),
      records: [],
      observing: false,
    });
  }
  function reportingObserverValue(observer, method) {
    const state = reportingObserverSlots.get(observer);
    if (!state) throw new TypeError(`Failed to execute '${method}' on 'ReportingObserver': Illegal invocation`);
    return state;
  }
  delete ReportingObserver.prototype.constructor;
  Object.defineProperties(ReportingObserver.prototype, {
    disconnect: {
      value: function disconnect() {
        const state = reportingObserverValue(this, 'disconnect');
        state.observing = false;
        state.records = [];
        return undefined;
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    observe: {
      value: function observe() {
        reportingObserverValue(this, 'observe').observing = true;
        return undefined;
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    takeRecords: {
      value: function takeRecords() {
        const state = reportingObserverValue(this, 'takeRecords');
        const records = state.records.slice();
        state.records.length = 0;
        return records;
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    constructor: { value: ReportingObserver, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(ReportingObserver.prototype, Symbol.toStringTag, { value: 'ReportingObserver', configurable: true });

  const crashReportSlots = new WeakMap();
  function CrashReportContext() {
    if (new.target) throw new TypeError("Failed to construct 'CrashReportContext': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  function makeCrashReportContext() {
    const context = Object.create(CrashReportContext.prototype);
    crashReportSlots.set(context, { initialized: false, limit: 0, values: new Map() });
    return context;
  }
  function crashReportValue(context, method) {
    const state = crashReportSlots.get(context);
    if (!state) throw new TypeError(`Failed to execute '${method}' on 'CrashReportContext': Illegal invocation`);
    return state;
  }
  function crashReportInitialized(context, method) {
    const state = crashReportValue(context, method);
    if (!state.initialized) throw namedError('InvalidStateError', `Failed to execute '${method}' on 'CrashReportContext': CrashReportContext is not initialized. Call initialize() and wait for it to resolve.`);
    return state;
  }
  const crashReportMethods = {
    delete(key) {
      crashReportInitialized(this, 'delete').values.delete(String(key));
      return undefined;
    },
    initialize(length) {
      const state = crashReportValue(this, 'initialize');
      if (state.initialized) return Promise.reject(namedError('InvalidStateError', "Failed to execute 'initialize' on 'CrashReportContext': The initialize() method has already been called."));
      state.limit = Math.max(0, Number(length) || 0);
      state.values.clear();
      state.initialized = true;
      return Promise.resolve(undefined);
    },
    set(key, value) {
      const state = crashReportInitialized(this, 'set');
      const recordKey = String(key);
      const recordValue = String(value);
      if (state.limit > 0 && recordKey.length + recordValue.length > state.limit) throw namedError('QuotaExceededError');
      state.values.set(recordKey, recordValue);
      return undefined;
    },
  };
  delete CrashReportContext.prototype.constructor;
  Object.defineProperties(CrashReportContext.prototype, {
    delete: { value: crashReportMethods.delete, enumerable: true, writable: true, configurable: true },
    initialize: { value: crashReportMethods.initialize, enumerable: true, writable: true, configurable: true },
    set: { value: crashReportMethods.set, enumerable: true, writable: true, configurable: true },
    constructor: { value: CrashReportContext, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(CrashReportContext.prototype, Symbol.toStringTag, { value: 'CrashReportContext', configurable: true });

  const featurePolicySlots = new WeakMap();
  function FeaturePolicy() {
    if (new.target) throw new TypeError("Failed to construct 'FeaturePolicy': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }

  function installFeaturePolicy(config = {}) {
    if (!globalThis.document || globalThis.document.featurePolicy) return;
    Object.defineProperty(globalThis.document, 'featurePolicy', {
      value: makeFeaturePolicy(config.featurePolicy || config.permissionsPolicy || {}),
      enumerable: true,
      configurable: true,
    });
  }

  function makeFeaturePolicy(policy = {}) {
    const configuredFeatures = Array.isArray(policy.features) ? policy.features : [];
    const configuredAllowed = Array.isArray(policy.allowedFeatures) ? policy.allowedFeatures : [];
    const features = Object.freeze(Array.from(new Set(configuredFeatures.map(String))).sort());
    const allowed = new Set(configuredAllowed.map(String).filter((feature) => features.includes(feature) || features.length === 0));
    const featurePolicy = Object.create(FeaturePolicy.prototype);
    featurePolicySlots.set(featurePolicy, { features, allowed });
    return featurePolicy;
  }
  function featurePolicyValue(policy, method) {
    const state = featurePolicySlots.get(policy);
    if (!state) throw new TypeError(`Failed to execute '${method}' on 'FeaturePolicy': Illegal invocation`);
    return state;
  }
  delete FeaturePolicy.prototype.constructor;
  Object.defineProperties(FeaturePolicy.prototype, {
    allowedFeatures: {
      value: function allowedFeatures() { return Array.from(featurePolicyValue(this, 'allowedFeatures').allowed).sort(); },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    allowsFeature: {
      value: function allowsFeature(feature) {
        const state = featurePolicyValue(this, 'allowsFeature');
        if (arguments.length < 1) throw new TypeError("Failed to execute 'allowsFeature' on 'FeaturePolicy': 1 argument required, but only 0 present.");
        return state.allowed.has(String(feature));
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    features: {
      value: function features() { return Array.from(featurePolicyValue(this, 'features').features); },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    getAllowlistForFeature: {
      value: function getAllowlistForFeature(feature) {
        const state = featurePolicyValue(this, 'getAllowlistForFeature');
        if (arguments.length < 1) throw new TypeError("Failed to execute 'getAllowlistForFeature' on 'FeaturePolicy': 1 argument required, but only 0 present.");
        return state.allowed.has(String(feature)) ? ['self'] : [];
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    constructor: { value: FeaturePolicy, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(FeaturePolicy.prototype, Symbol.toStringTag, { value: 'FeaturePolicy', configurable: true });

  function MediaCapabilities() {
    if (new.target) throw new TypeError("Failed to construct 'MediaCapabilities': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }

  function makeMediaCapabilities() {
    const capabilities = Object.create(MediaCapabilities.prototype);
    mediaCapabilitiesSlots.set(capabilities, {});
    return capabilities;
  }
  delete MediaCapabilities.prototype.constructor;
  Object.defineProperties(MediaCapabilities.prototype, {
    decodingInfo: { value: function decodingInfo(configuration) {
      mediaCapabilitiesValue(this);
      if (arguments.length < 1) return Promise.reject(new TypeError("Failed to execute 'decodingInfo' on 'MediaCapabilities': 1 argument required, but only 0 present."));
      return Promise.resolve({ supported: false, smooth: false, powerEfficient: false, keySystemAccess: null });
    }, enumerable: true, writable: true, configurable: true },
    encodingInfo: { value: function encodingInfo(configuration) {
      mediaCapabilitiesValue(this);
      if (arguments.length < 1) return Promise.reject(new TypeError("Failed to execute 'encodingInfo' on 'MediaCapabilities': 1 argument required, but only 0 present."));
      if (configuration?.type && configuration.type !== 'webrtc') return Promise.reject(new TypeError(`Failed to execute 'encodingInfo' on 'MediaCapabilities': Failed to read the 'type' property from 'MediaEncodingConfiguration': The provided value '${String(configuration.type)}' is not a valid enum value of type MediaEncodingType.`));
      return Promise.resolve({ supported: false, smooth: false, powerEfficient: false, keySystemAccess: null });
    }, enumerable: true, writable: true, configurable: true },
    constructor: { value: MediaCapabilities, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(MediaCapabilities.prototype, Symbol.toStringTag, { value: 'MediaCapabilities', configurable: true });
  function mediaCapabilitiesValue(value) {
    const state = mediaCapabilitiesSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  const mediaMetadataState = new WeakMap();
  function MediaMetadata(init = {}) {
    if (!new.target) throw new TypeError("Failed to construct 'MediaMetadata': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    const source = init == null ? {} : Object(init);
    mediaMetadataState.set(this, {
      title: webIDLDOMString(source.title, ''),
      artist: webIDLDOMString(source.artist, ''),
      album: webIDLDOMString(source.album, ''),
      artwork: source.artwork === undefined ? Object.freeze([]) : mediaMetadataArtwork(source.artwork, "Failed to construct 'MediaMetadata': Failed to read the 'artwork' property from 'MediaMetadataInit': "),
    });
  }
  Object.defineProperties(MediaMetadata.prototype, {
    title: { get() { return mediaMetadataValue(this).title; }, set(value) { mediaMetadataValue(this).title = webIDLDOMString(value, '', "Failed to set the 'title' property on 'MediaMetadata': "); }, enumerable: true, configurable: true },
    artist: { get() { return mediaMetadataValue(this).artist; }, set(value) { mediaMetadataValue(this).artist = webIDLDOMString(value, '', "Failed to set the 'artist' property on 'MediaMetadata': "); }, enumerable: true, configurable: true },
    album: { get() { return mediaMetadataValue(this).album; }, set(value) { mediaMetadataValue(this).album = webIDLDOMString(value, '', "Failed to set the 'album' property on 'MediaMetadata': "); }, enumerable: true, configurable: true },
    artwork: { get() { return mediaMetadataValue(this).artwork; }, set(value) { mediaMetadataValue(this).artwork = mediaMetadataArtwork(value, "Failed to set the 'artwork' property on 'MediaMetadata': "); }, enumerable: true, configurable: true },
    chapterInfo: { get() { mediaMetadataValue(this); return Object.freeze([]); }, enumerable: true, configurable: true },
  });
  Object.defineProperty(MediaMetadata.prototype, Symbol.toStringTag, { value: 'MediaMetadata', configurable: true });

  function mediaMetadataValue(value) {
    const state = mediaMetadataState.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function webIDLDOMString(value, fallback = '', prefix = '') {
    if (value === undefined) return fallback;
    if (typeof value === 'symbol') throw new TypeError(prefix + 'Cannot convert a Symbol value to a string');
    return String(value);
  }

  function mediaMetadataArtwork(value, prefix) {
    if (!value || typeof value[Symbol.iterator] !== 'function') throw new TypeError(prefix + 'The provided value cannot be converted to a sequence.');
    return Object.freeze(Array.from(value, (item) => mediaMetadataImage(item, prefix)));
  }

  function mediaMetadataImage(item, prefix) {
    if (!item || typeof item !== 'object') throw new TypeError(prefix + "The provided value is not of type 'MediaImage'.");
    if (item.src === undefined) throw new TypeError(prefix + "Failed to read the 'src' property from 'MediaImage': Required member is undefined.");
    const src = webIDLDOMString(item.src, '', prefix);
    const parsed = hostParseURL(src, currentURLBase());
    if (!parsed) throw new TypeError(prefix + "'" + src + "' can't be resolved to a valid URL.");
    return Object.freeze({
      sizes: webIDLDOMString(item.sizes, ''),
      src: parsed.href,
      type: webIDLDOMString(item.type, ''),
    });
  }

  function MediaSession() { throw new TypeError("Failed to construct 'MediaSession': Illegal constructor"); }
  Object.defineProperty(MediaSession, Symbol.hasInstance, { value: (value) => Boolean(value?.__zpMediaSession), configurable: true });

  const mediaSessionPlaybackStates = new Set(['none', 'paused', 'playing']);
  const mediaSessionActions = new Set(['play', 'pause', 'seekbackward', 'seekforward', 'previoustrack', 'nexttrack', 'skipad', 'stop', 'seekto', 'togglemicrophone', 'togglecamera', 'hangup', 'previousslide', 'nextslide', 'enterpictureinpicture', 'voiceactivity']);
  function makeMediaSession() {
    const session = Object.create(MediaSession.prototype);
    const handlers = new Map();
    let metadata = null;
    let playbackState = 'none';
    Object.defineProperty(session, '__zpMediaSession', { value: true, configurable: true });
    Object.defineProperty(session, 'metadata', {
      get() { return metadata; },
      set(value) { metadata = value === null ? null : value; },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(session, 'playbackState', {
      get() { return playbackState; },
      set(value) {
        const state = String(value);
        if (!mediaSessionPlaybackStates.has(state)) throw new TypeError("Failed to set the 'playbackState' property on 'MediaSession': The provided value is not a valid enum value.");
        playbackState = state;
      },
      enumerable: true,
      configurable: true,
    });
    session.setActionHandler = (action, handler) => {
      const key = String(action);
      if (!mediaSessionActions.has(key)) throw new TypeError("Failed to execute 'setActionHandler' on 'MediaSession': The provided value is not a valid enum value.");
      if (handler !== null && typeof handler !== 'function') throw new TypeError("Failed to execute 'setActionHandler' on 'MediaSession': parameter 2 is not a function.");
      if (handler === null) handlers.delete(key);
      else handlers.set(key, handler);
      return undefined;
    };
    session.setPositionState = () => undefined;
    return Object.freeze(session);
  }
  Object.defineProperty(MediaSession.prototype, Symbol.toStringTag, { value: 'MediaSession', configurable: true });
  const lockSlots = new WeakMap();
  const lockManagerSlots = new WeakMap();

  function Lock() {
    if (new.target) throw new TypeError("Failed to construct 'Lock': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  function lockValue(lock) {
    const value = lockSlots.get(lock);
    if (!value) throw new TypeError('Illegal invocation');
    return value;
  }
  delete Lock.prototype.constructor;
  Object.defineProperties(Lock.prototype, {
    name: { get() { return lockValue(this).name; }, enumerable: true, configurable: true },
    mode: { get() { return lockValue(this).mode; }, enumerable: true, configurable: true },
    constructor: { value: Lock, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(Lock.prototype, Symbol.toStringTag, { value: 'Lock', configurable: true });

  function makeLock(name, mode) {
    const lock = Object.create(Lock.prototype);
    lockSlots.set(lock, { name, mode });
    return Object.freeze(lock);
  }

  function LockManager() {
    if (new.target) throw new TypeError("Failed to construct 'LockManager': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }

  function makeLockManager() {
    const manager = Object.create(LockManager.prototype);
    lockManagerSlots.set(manager, { active: new Map(), queue: [], draining: false });
    return manager;
  }

  function lockManagerValue(manager) {
    const value = lockManagerSlots.get(manager);
    if (!value) return null;
    return value;
  }

  function lockRequestError(message) {
    return new TypeError("Failed to execute 'request' on 'LockManager': " + message);
  }

  function lockRequestOptions(args) {
    if (args.length < 2) return { error: lockRequestError(`2 arguments required, but only ${args.length} present.`) };
    const rawOptions = args[1];
    const callback = typeof rawOptions === 'function' ? rawOptions : args[2];
    if (typeof callback !== 'function') {
      const index = rawOptions && typeof rawOptions === 'object' && args.length > 2 ? 3 : 2;
      return { error: lockRequestError(`parameter ${index} is not of type 'Function'.`) };
    }
    const options = rawOptions && typeof rawOptions === 'object' && typeof rawOptions !== 'function' ? rawOptions : {};
    const mode = options.mode === undefined ? 'exclusive' : String(options.mode);
    if (mode !== 'exclusive' && mode !== 'shared') return { error: lockRequestError(`Failed to read the 'mode' property from 'LockOptions': The provided value '${mode}' is not a valid enum value of type LockMode.`) };
    const ifAvailable = Boolean(options.ifAvailable);
    const steal = Boolean(options.steal);
    if (ifAvailable && steal) return { error: namedError('NotSupportedError', "Failed to execute 'request' on 'LockManager': The 'steal' and 'ifAvailable' options cannot be used together.") };
    return { callback, mode, ifAvailable, steal, signal: options.signal || null };
  }

  function lockCanGrant(state, job, blockedNames = new Set()) {
    if (blockedNames.has(job.name)) return false;
    const active = state.active.get(job.name) || [];
    if (active.length === 0) return true;
    return job.mode === 'shared' && active.every((entry) => entry.mode === 'shared');
  }

  function removeLockJob(state, job) {
    const index = state.queue.indexOf(job);
    if (index >= 0) state.queue.splice(index, 1);
  }

  function settleLockJob(state, job, callbackLock) {
    if (job.abortHandler && job.signal?.removeEventListener) job.signal.removeEventListener('abort', job.abortHandler);
    Promise.resolve()
      .then(() => job.callback(callbackLock))
      .then(job.resolve, job.reject)
      .finally(() => {
        const active = state.active.get(job.name);
        if (active) {
          const index = active.indexOf(job);
          if (index >= 0) active.splice(index, 1);
          if (active.length === 0) state.active.delete(job.name);
        }
        lockDrain(state);
      });
  }

  function grantLockJob(state, job) {
    const lock = makeLock(job.name, job.mode);
    const active = state.active.get(job.name) || [];
    active.push(job);
    state.active.set(job.name, active);
    settleLockJob(state, job, lock);
  }

  function stealLockJobs(state, name) {
    const active = state.active.get(name) || [];
    state.active.delete(name);
    for (const job of active) job.reject(namedError('AbortError', "Lock broken by another request with the 'steal' option."));
  }

  function lockDrain(state) {
    if (state.draining) return;
    state.draining = true;
    try {
      const blockedNames = new Set();
      for (let index = 0; index < state.queue.length; index += 1) {
        const job = state.queue[index];
        if (job.signal?.aborted) {
          state.queue.splice(index, 1);
          index -= 1;
          job.reject(job.signal.reason);
          continue;
        }
        if (job.steal) stealLockJobs(state, job.name);
        if (!lockCanGrant(state, job, blockedNames)) {
          if (job.ifAvailable) {
            state.queue.splice(index, 1);
            index -= 1;
            settleLockJob(state, job, null);
          } else {
            blockedNames.add(job.name);
          }
          continue;
        }
        state.queue.splice(index, 1);
        index -= 1;
        grantLockJob(state, job);
      }
    } finally {
      state.draining = false;
    }
  }

  delete LockManager.prototype.constructor;
  Object.defineProperties(LockManager.prototype, {
    query: {
      value: function query() {
        const state = lockManagerValue(this);
        if (!state) return Promise.reject(new TypeError("Failed to execute 'query' on 'LockManager': Illegal invocation"));
        const held = [];
        for (const [name, locks] of state.active.entries()) {
          for (const lock of locks) held.push({ name, mode: lock.mode, clientId: '' });
        }
        const pending = state.queue.map((job) => ({ name: job.name, mode: job.mode, clientId: '' }));
        return Promise.resolve({ held, pending });
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    request: {
      value: function request(name, options) {
        const state = lockManagerValue(this);
        if (!state) return Promise.reject(new TypeError("Failed to execute 'request' on 'LockManager': Illegal invocation"));
        const parsed = lockRequestOptions(arguments);
        if (parsed.error) return Promise.reject(parsed.error);
        if (parsed.signal?.aborted) return Promise.reject(parsed.signal.reason);
        return new Promise((resolve, reject) => {
          const job = {
            name: String(name),
            mode: parsed.mode,
            ifAvailable: parsed.ifAvailable,
            steal: parsed.steal,
            callback: parsed.callback,
            resolve,
            reject,
            signal: parsed.signal,
            abortHandler: null,
          };
          if (parsed.signal?.addEventListener) {
            job.abortHandler = () => {
              removeLockJob(state, job);
              reject(parsed.signal.reason);
            };
            parsed.signal.addEventListener('abort', job.abortHandler, { once: true });
          }
          state.queue.push(job);
          lockDrain(state);
        });
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    constructor: { value: LockManager, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(LockManager.prototype, Symbol.toStringTag, { value: 'LockManager', configurable: true });

  function makeNavigator(config) {
    const prototype = navigatorInstancePrototype(globalThis.Navigator?.prototype);
    const userAgent = config.userAgent || 'ZeroProxy Virtual Browser';
    const languages = Array.isArray(config.languages) && config.languages.length ? config.languages.map(String) : ['en-US', 'en'];
    const navigatorPluginData = makeNavigatorPluginData();
    const navigator = Object.create(prototype);
    navigatorSlots.set(navigator, {
      userAgent,
      appVersion: userAgent,
      appName: 'Netscape',
      appCodeName: 'Mozilla',
      platform: config.platform || 'ZeroProxy',
      vendor: config.vendor || 'Google Inc.',
      vendorSub: '',
      product: 'Gecko',
      productSub: '20030107',
      language: languages[0],
      languages,
      keyboard: makeKeyboard(config.keyboard || {}),
      windowControlsOverlay: makeWindowControlsOverlay(),
      wakeLock: makeWakeLock(),
      contacts: makeContactsManager(),
      mediaCapabilities: makeMediaCapabilities(),
      mediaSession: makeMediaSession(),
      credentials: makeCredentialsContainer(),
      onLine: true,
      cookieEnabled: true,
      doNotTrack: null,
      hardwareConcurrency: Number(config.hardwareConcurrency || 4),
      deviceMemory: Number(config.deviceMemory || 4),
      maxTouchPoints: Number(config.maxTouchPoints || 0),
      webdriver: false,
      pdfViewerEnabled: true,
      plugins: navigatorPluginData.plugins,
      mimeTypes: navigatorPluginData.mimeTypes,
      userAgentData: new NavigatorUAData(navigatorUADataToken, config),
      permissions: new Permissions(permissionsToken, config.permissions || config.permissionStates || {}),
      storage: new NavigatorStorageManager(storageManagerToken, config.storageQuota),
      geolocation: makeGeolocation(),
      connection: new VirtualNetworkInformation(config.networkInformation || config.connection || {}),
      locks: makeLockManager(),
      userActivation: makeUserActivation(),
      clipboard: { readText: async () => '', writeText: async () => undefined },
      serviceWorker: { register: async () => { throw new Error('ServiceWorkerUnsupported'); }, getRegistration: async () => undefined, getRegistrations: async () => [] },
      ink: null,
      scheduling: null,
      webkitPersistentStorage: null,
      webkitTemporaryStorage: null,
    });
    return Object.freeze(navigator);
  }

  function installNavigatorPrototype(proto) {
    if (!proto || navigatorPrototypeInstallSet.has(proto)) return;
    Object.defineProperties(proto, {
      appCodeName: navigatorGetter('appCodeName'),
      appName: navigatorGetter('appName'),
      appVersion: navigatorGetter('appVersion'),
      connection: navigatorGetter('connection'),
      cookieEnabled: navigatorGetter('cookieEnabled'),
      doNotTrack: navigatorGetter('doNotTrack'),
      geolocation: navigatorGetter('geolocation'),
      hardwareConcurrency: navigatorGetter('hardwareConcurrency'),
      ink: navigatorGetter('ink'),
      language: navigatorGetter('language'),
      languages: navigatorGetter('languages'),
      maxTouchPoints: navigatorGetter('maxTouchPoints'),
      mediaCapabilities: navigatorGetter('mediaCapabilities'),
      mediaSession: navigatorGetter('mediaSession'),
      mimeTypes: navigatorGetter('mimeTypes'),
      onLine: navigatorGetter('onLine'),
      pdfViewerEnabled: navigatorGetter('pdfViewerEnabled'),
      permissions: navigatorGetter('permissions'),
      platform: navigatorGetter('platform'),
      plugins: navigatorGetter('plugins'),
      product: navigatorGetter('product'),
      productSub: navigatorGetter('productSub'),
      scheduling: navigatorGetter('scheduling'),
      userActivation: navigatorGetter('userActivation'),
      userAgent: navigatorGetter('userAgent'),
      vendor: navigatorGetter('vendor'),
      vendorSub: navigatorGetter('vendorSub'),
      webdriver: navigatorGetter('webdriver'),
      webkitPersistentStorage: navigatorGetter('webkitPersistentStorage'),
      webkitTemporaryStorage: navigatorGetter('webkitTemporaryStorage'),
      windowControlsOverlay: navigatorGetter('windowControlsOverlay'),
      getGamepads: { value: function getGamepads() { return emptyGamepads(); }, enumerable: true, configurable: true, writable: true },
      javaEnabled: { value: function javaEnabled() { return false; }, enumerable: true, configurable: true, writable: true },
      sendBeacon: { value: function sendBeacon(url) { try { fetch(url, { method: 'POST', body: arguments.length > 1 ? arguments[1] : '', keepalive: true }); return true; } catch { return false; } }, enumerable: true, configurable: true, writable: true },
      vibrate: { value: function vibrate(pattern) { void pattern; return false; }, enumerable: true, configurable: true, writable: true },
    });
    navigatorPrototypeInstallSet.add(proto);
  }


  function navigatorInstancePrototype(basePrototype) {
    installNavigatorPrototype(basePrototype);
    if (!basePrototype) return Object.prototype;
    if (virtualNavigatorPrototype && Object.getPrototypeOf(virtualNavigatorPrototype) === basePrototype) return virtualNavigatorPrototype;
    virtualNavigatorPrototype = Object.create(basePrototype);
    Object.defineProperties(virtualNavigatorPrototype, {
      keyboard: navigatorGetter('keyboard'),
      wakeLock: navigatorGetter('wakeLock'),
      contacts: navigatorGetter('contacts'),
      credentials: navigatorGetter('credentials'),
      deviceMemory: navigatorGetter('deviceMemory'),
      userAgentData: navigatorGetter('userAgentData'),
      storage: navigatorGetter('storage'),
      locks: navigatorGetter('locks'),
      clipboard: navigatorGetter('clipboard'),
      serviceWorker: navigatorGetter('serviceWorker'),
      canShare: { value: function canShare() { return false; }, enumerable: true, configurable: true, writable: true },
      share: { value: function share() { return Promise.reject(namedError('NotAllowedError')); }, enumerable: true, configurable: true, writable: true },
    });
    return virtualNavigatorPrototype;
  }
  function navigatorGetter(name) {
    const descriptor = Object.getOwnPropertyDescriptor({ get [name]() { return navigatorState(this)[name]; } }, name);
    return { get: descriptor.get, enumerable: true, configurable: true };
  }

  function navigatorState(value) {
    const state = navigatorSlots.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  const pdfPluginMimeTypes = Object.freeze([
    Object.freeze({ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }),
    Object.freeze({ type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' }),
  ]);
  const pdfPluginNames = Object.freeze(['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF']);

  const pluginArrayState = new WeakMap();
  function PluginArray() { throw new TypeError("Failed to construct 'PluginArray': Illegal constructor"); }
  function MimeTypeArray() { throw new TypeError("Failed to construct 'MimeTypeArray': Illegal constructor"); }
  definePluginArrayPrototype(PluginArray.prototype, 'PluginArray', true);
  definePluginArrayPrototype(MimeTypeArray.prototype, 'MimeTypeArray', false);

  function definePluginArrayPrototype(proto, tag, refresh) {
    Object.defineProperty(proto, 'length', { get() { return pluginArrayItems(this).length; }, enumerable: true, configurable: true });
    Object.defineProperty(proto, 'item', { value: function item(index) { return pluginArrayItems(this)[Number(index) >>> 0] || null; }, enumerable: true, configurable: true, writable: true });
    Object.defineProperty(proto, 'namedItem', { value: function namedItem(name) { return namedPluginArrayItem(pluginArrayItems(this), name); }, enumerable: true, configurable: true, writable: true });
    if (refresh) Object.defineProperty(proto, 'refresh', { value: function refresh() {}, enumerable: true, configurable: true, writable: true });
    Object.defineProperty(proto, Symbol.toStringTag, { value: tag, configurable: true });
    Object.defineProperty(proto, Symbol.iterator, { value: Array.prototype[Symbol.iterator], writable: true, configurable: true });
  }

  function makeNavigatorPluginData() {
    const plugins = pdfPluginNames.map((name) => createPlugin({ name, filename: 'internal-pdf-viewer', description: 'Portable Document Format', mimeTypes: pdfPluginMimeTypes }));
    const mimeTypes = pdfPluginMimeTypes.map((mimeType) => createMimeType({ ...mimeType, enabledPlugin: plugins[0] }));
    return {
      plugins: makePluginArray(PluginArray.prototype, plugins, (plugin) => plugin.name),
      mimeTypes: makePluginArray(MimeTypeArray.prototype, mimeTypes, (mimeType) => mimeType.type),
    };
  }

  function makePluginArray(proto, items, nameForItem) {
    const array = Object.create(proto);
    pluginArrayState.set(array, items);
    items.forEach((item, index) => {
      Object.defineProperty(array, String(index), { value: item, enumerable: true, configurable: true });
      const name = nameForItem(item);
      if (name && !Object.prototype.hasOwnProperty.call(array, name)) Object.defineProperty(array, name, { value: item, enumerable: false, configurable: true });
    });
    return array;
  }

  function pluginArrayItems(target) {
    const items = pluginArrayState.get(target);
    if (!items) throw new TypeError('Illegal invocation');
    return items;
  }

  function namedPluginArrayItem(items, name) {
    const key = String(name);
    return items.find((item) => item.name === key || item.type === key) || null;
  }

  const validPermissionNames = new Set(['geolocation', 'notifications', 'push', 'midi', 'camera', 'microphone', 'speaker-selection', 'device-info', 'background-sync', 'bluetooth', 'persistent-storage', 'ambient-light-sensor', 'accelerometer', 'gyroscope', 'magnetometer', 'clipboard-read', 'clipboard-write', 'display-capture', 'nfc', 'payment-handler', 'idle-detection', 'storage-access', 'window-management', 'local-fonts', 'top-level-storage-access']);
  function permissionNameValid(name) { return validPermissionNames.has(String(name)); }
  function permissionState(name, states) { return states.get(String(name)) || 'prompt'; }
  function normalizePermissionStates(states) {
    const out = new Map();
    for (const [name, value] of Object.entries(states || {})) {
      const key = String(name);
      const state = String(value);
      if (permissionNameValid(key) && (state === 'granted' || state === 'denied' || state === 'prompt')) out.set(key, state);
    }
    return out;
  }

  function makeHistory() {
    installHistoryPrototype(globalThis.History?.prototype);
    return Object.create(globalThis.History?.prototype || Object.prototype);
  }

  function installHistoryPrototype(proto) {
    if (!proto || historyPrototypeInstallSet.has(proto)) return;
    Object.defineProperties(proto, {
      length: {
        get() { return historyStack.length; },
        enumerable: true,
        configurable: true,
      },
      state: {
        get() { return cloneValue(historyStack[historyIndex]?.state ?? null, new Map()); },
        enumerable: true,
        configurable: true,
      },
      scrollRestoration: {
        get() { return historyScrollRestoration; },
        set(value) { historyScrollRestoration = String(value) === 'manual' ? 'manual' : 'auto'; },
        enumerable: true,
        configurable: true,
      },
      pushState: { value: function pushState(state, unused) { void unused; validateHistoryArgs('pushState', arguments); historyPushState(state, arguments[2]); }, enumerable: true, configurable: true, writable: true },
      replaceState: { value: function replaceState(state, unused) { void unused; validateHistoryArgs('replaceState', arguments); historyReplaceState(state, arguments[2]); }, enumerable: true, configurable: true, writable: true },
      back: { value: function back() { historyGo(-1); }, enumerable: true, configurable: true, writable: true },
      forward: { value: function forward() { historyGo(1); }, enumerable: true, configurable: true, writable: true },
      go: { value: function go(delta = 0) { historyGo(delta); }, enumerable: true, configurable: true, writable: true },
    });
    historyPrototypeInstallSet.add(proto);
  }

  function historyPushState(state, url) {
    const nextURL = validateHistoryURL('pushState', url);
    historyStack.splice(historyIndex + 1);
    historyIndex += 1;
    historyStack.push({ state: cloneValue(state, new Map()), url: nextURL });
    updateLocation(nextURL);
  }

  function historyReplaceState(state, url) {
    const nextURL = validateHistoryURL('replaceState', url);
    historyStack[historyIndex] = { state: cloneValue(state, new Map()), url: nextURL };
    updateLocation(nextURL);
  }

  function historyGo(delta = 0) {
    const next = Math.max(0, Math.min(historyStack.length - 1, historyIndex + Number(delta || 0)));
    if (next === historyIndex) return;
    historyIndex = next;
    updateLocation(historyStack[historyIndex].url);
    dispatchPopState(historyStack[historyIndex].state);
  }

  function IDBFactory() { throw new TypeError("Failed to construct 'IDBFactory': Illegal constructor"); }
  Object.defineProperty(IDBFactory, Symbol.hasInstance, { value: (value) => Boolean(value?.__zpIDBFactory), configurable: true });
  Object.defineProperty(IDBFactory.prototype, Symbol.toStringTag, { value: 'IDBFactory', configurable: true });

  function makeIndexedDBFactory() {
    installIDBFactoryPrototype();
    return Object.create(IDBFactory.prototype);
  }

  function installIDBFactoryPrototype() {
    if (Object.prototype.hasOwnProperty.call(IDBFactory.prototype, 'open')) return;
    Object.defineProperties(IDBFactory.prototype, {
      open: { value: function open(name) { const request = new IDBOpenDBRequest(idbRequestToken); Promise.resolve().then(() => openIDBRequest(request, name, arguments[1])); return request; }, enumerable: true, configurable: true, writable: true },
      deleteDatabase: { value: function deleteDatabase(name) { const request = new IDBOpenDBRequest(idbRequestToken); Promise.resolve().then(() => { idbDatabases.delete(String(name)); persistIndexedDBDelete(String(name)); queueSuccess(request, undefined); }); return request; }, enumerable: true, configurable: true, writable: true },
      cmp: { value: function cmp(first, second) { return Math.sign(compareIDBKey(first, second)); }, enumerable: true, configurable: true, writable: true },
      databases: { value: function databases() { return Promise.resolve([...idbDatabases.values()].map((record) => ({ name: record.name, version: record.version }))); }, enumerable: true, configurable: true, writable: true },
    });
  }

  function openIDBRequest(request, name, version) {
    try {
      const databaseName = String(name || '');
      const existing = idbDatabases.get(databaseName);
      const oldVersion = existing?.version || 0;
      const nextVersion = Number(version || existing?.version || 1);
      if (oldVersion && nextVersion < oldVersion) throw namedError('VersionError');
      const record = existing || { name: databaseName, version: nextVersion, stores: {} };
      record.version = nextVersion;
      idbDatabases.set(databaseName, record);
      const database = new IDBDatabase(idbInternalToken, record);
      request.result = database;
      if (oldVersion < nextVersion) { request.__dispatch('upgradeneeded', { oldVersion, newVersion: nextVersion }); persistIndexedDB(databaseName, record); }
      queueSuccess(request, database);
    } catch (error) { queueError(request, error); }
  }

  function storeMutation(database, storeName, value, key, noOverwrite) {
    const request = new IDBRequest(idbRequestToken);
    Promise.resolve().then(() => {
      try {
        const store = database.stores[storeName];
        const nextKey = deriveStoreKey(store, value, key);
        if (noOverwrite && recordHasKey(store.records, nextKey)) throw namedError('ConstraintError');
        validateUniqueIndexes(store, value, nextKey);
        const id = String(nextKey);
        const hadRecord = recordHasKey(store.records, nextKey);
        const previous = hadRecord ? store.records[id] : undefined;
        store.records[id] = cloneValue(value, new Map());
        enforceVirtualStorageQuota(() => {
          if (hadRecord) store.records[id] = previous;
          else delete store.records[id];
        });
        persistIndexedDB(database.name, database);
        queueSuccess(request, nextKey);
      } catch (error) { queueError(request, error); }
    });
    return request;
  }
  function recordHasKey(records, key) { return Object.getOwnPropertyDescriptor(records, String(key)) !== undefined; }
  function storeLookup(database, storeName, query, mode) {
    const request = new IDBRequest(idbRequestToken);
    Promise.resolve().then(() => {
      try {
        const entries = objectStoreCursorEntries(database.stores[storeName], query);
        queueSuccess(request, idbLookupResult(entries, mode));
      } catch (error) { queueError(request, error); }
    });
    return request;
  }
  function indexLookup(database, storeName, indexName, query, mode) { const request = new IDBRequest(idbRequestToken); Promise.resolve().then(() => { try { const store = database.stores[storeName]; const entries = indexCursorEntries(store, store.indexes[indexName], query); queueSuccess(request, idbLookupResult(entries, mode)); } catch (error) { queueError(request, error); } }); return request; }
  function idbLookupResult(entries, mode) {
    if (mode === 'count') return entries.length;
    if (mode === 'key') return cloneValue(entries[0]?.primaryKey, new Map());
    if (mode === 'keys') return entries.map((entry) => cloneValue(entry.primaryKey, new Map()));
    if (mode === 'records') return entries.map((entry) => ({ key: cloneValue(entry.key, new Map()), primaryKey: cloneValue(entry.primaryKey, new Map()), value: cloneValue(entry.value, new Map()) }));
    if (mode === 'values') return entries.map((entry) => cloneValue(entry.value, new Map()));
    return cloneValue(entries[0]?.value, new Map());
  }
  function idbEventHandlerAccessor(name) {
    return { get() { return this?.['__zp_' + name] ?? null; }, set(value) { Object.defineProperty(this, '__zp_' + name, { value: typeof value === 'function' ? value : null, configurable: true, writable: true }); }, enumerable: true, configurable: true };
  }
  function cursorRequest(source, entries, transaction = null, direction = 'next') { const request = new IDBRequest(idbRequestToken); const cursorDirection = cursorDirectionName(direction); const cursorEntries = cursorEntriesForDirection(entries, cursorDirection); request.source = source; Promise.resolve().then(() => queueCursor(request, source, cursorEntries, 0, cursorDirection)); return trackIDBRequest(transaction, request); }
  function queueCursor(request, source, entries, position, direction) { queueSuccess(request, position < entries.length ? new IDBCursorWithValue(idbCursorToken, request, source, entries, position, direction) : null); }
  function trackIDBRequest(transaction, request) { return transaction ? transaction.__zpTrack(request) : request; }
  function objectStoreCursorEntries(store, query) { return Object.entries(store.records).map(([primaryKey, value]) => ({ key: primaryKey, primaryKey, value })).filter((entry) => keyMatchesQuery(entry.primaryKey, query)).sort(compareIDBEntries); }
  function indexCursorEntries(store, index, query) { const out = []; for (const [primaryKey, value] of Object.entries(store.records)) { for (const key of indexKeys(index, value)) { if (keyMatchesQuery(key, query)) out.push({ key, primaryKey, value }); } } return out.sort(compareIDBEntries); }
  function cursorDirectionName(direction) { const text = String(direction || 'next'); return ['next', 'nextunique', 'prev', 'prevunique'].includes(text) ? text : 'next'; }
  function cursorEntriesForDirection(entries, direction) { const sorted = direction.startsWith('prev') ? [...entries].reverse() : [...entries]; return direction.endsWith('unique') ? uniqueCursorEntries(sorted) : sorted; }
  function idbReadonlyOwnAccessor(name) {
    return { get() { return Object.prototype.hasOwnProperty.call(this, name) ? Object.getOwnPropertyDescriptor(this, name).value : undefined; }, enumerable: true, configurable: true };
  }
  function idbMutableOwnAccessor(name) {
    return { get() { return Object.prototype.hasOwnProperty.call(this, name) ? Object.getOwnPropertyDescriptor(this, name).value : undefined; }, set(value) { Object.defineProperty(this, name, { value: String(value), configurable: true }); }, enumerable: true, configurable: true };
  }
  function idbCursorAccessor(name) {
    return { get() { return this?.[name]; }, enumerable: true, configurable: true };
  }
  function cursorContinue(cursor, step) {
    cursor.__zpRequest?.transaction?.__zpHold?.();
    queueCursor(cursor.__zpRequest, cursor.__zpSource, cursor.__zpEntries, cursor.__zpPosition + step, cursor.direction);
  }
  function cursorStore(cursor) {
    return cursor.source instanceof IDBIndex ? cursor.source.objectStore : cursor.source;
  }
  function uniqueCursorEntries(entries) { const seen = new Set(); const out = []; for (const entry of entries) { const id = idbKeyID(entry.key); if (seen.has(id)) continue; seen.add(id); out.push(entry); } return out; }
  function validateExistingIndex(store, index) { if (!index.unique) return; const seen = new Set(); for (const value of Object.values(store.records)) { for (const key of indexKeys(index, value)) { const id = idbKeyID(key); if (seen.has(id)) throw namedError('ConstraintError'); seen.add(id); } } }
  function validateUniqueIndexes(store, value, primaryKey) { for (const index of Object.values(store.indexes || {})) { if (!index.unique) continue; for (const key of indexKeys(index, value)) validateUniqueIndexKey(store, index, key, primaryKey); } }
  function validateUniqueIndexKey(store, index, key, primaryKey) { const id = idbKeyID(key); for (const [existingPrimaryKey, existingValue] of Object.entries(store.records)) { if (sameIDBKey(existingPrimaryKey, primaryKey)) continue; for (const existingKey of indexKeys(index, existingValue)) if (idbKeyID(existingKey) === id) throw namedError('ConstraintError'); } }
  function indexKeys(index, value) { const key = keyPathValue(value, index.keyPath); if (key === undefined) return []; return index.multiEntry && Array.isArray(key) ? key : [key]; }
  function keyPathValue(value, keyPath) { if (!keyPath) return undefined; if (Array.isArray(keyPath)) return keyPath.map((part) => keyPathValue(value, part)); return String(keyPath).split('.').reduce((cursor, part) => cursor == null ? undefined : cursor[part], value); }
  function keyMatchesQuery(key, query) { if (query === undefined || query === null) return true; return query instanceof IDBKeyRange ? query.includes(key) : sameIDBKey(key, query); }
  function keyInRange(key, range) { if (range.lower !== undefined) { const cmp = compareIDBKey(key, range.lower); if (cmp < 0 || (cmp === 0 && range.lowerOpen)) return false; } if (range.upper !== undefined) { const cmp = compareIDBKey(key, range.upper); if (cmp > 0 || (cmp === 0 && range.upperOpen)) return false; } return true; }
  function sameIDBKey(left, right) { return compareIDBKey(left, right) === 0; }
  function compareIDBKey(left, right) { if (typeof left === 'number' && typeof right === 'number') return left - right; const a = idbKeyID(left); const b = idbKeyID(right); if (a < b) return -1; if (a > b) return 1; return 0; }
  function idbKeyID(key) { return JSON.stringify(key); }
  function compareIDBEntries(left, right) { const byKey = compareIDBKey(left.key, right.key); return byKey || compareIDBKey(left.primaryKey, right.primaryKey); }
  function deriveStoreKey(store, value, key) { if (key !== undefined) return key; if (store.keyPath && value && value[store.keyPath] !== undefined) return value[store.keyPath]; if (store.autoIncrement) return store.nextKey++; throw namedError('DataError'); }
  function normalizeDatabaseRecord(name, input) { const record = { name, version: Number(input?.version || 1), stores: {} }; for (const [storeName, store] of Object.entries(input?.stores || {})) record.stores[storeName] = { keyPath: store.keyPath || null, autoIncrement: Boolean(store.autoIncrement), nextKey: Number(store.nextKey || 1), records: cloneValue(store.records || {}, new Map()), indexes: cloneValue(store.indexes || {}, new Map()) }; return record; }
  function nameList(values) { return new DOMStringList(domStringListToken, values); }
  function queueSuccess(request, result) { Promise.resolve().then(() => { request.result = result; request.readyState = 'done'; request.__dispatch('success'); }); }
  function queueError(request, error) { Promise.resolve().then(() => { request.error = error; request.readyState = 'done'; request.__dispatch('error'); }); }
  function namedError(name, message = name) { return typeof DOMException === 'function' ? new DOMException(message, name) : Object.assign(new Error(message), { name }); }

  function requestRecordFromInput(input) { const request = input instanceof Request ? input : new Request(input); return { key: cacheKey(request), url: request.url, method: request.method || 'GET', headers: request.headers?.toJSON?.() || [], credentials: request.credentials || 'same-origin' }; }
  function responseRecordFromInput(response, body) { return { status: response.status, statusText: response.statusText, headers: response.headers?.toJSON?.() || [], url: response.url || '', body: String(body || '') }; }
  function responseFromCacheRecord(record) { const response = record.response || {}; return new Response(response.body || '', { status: response.status, statusText: response.statusText, headers: response.headers || [], url: response.url || '' }); }
  function persistStorageSet(area, key, value) { try { if (typeof __zpStorageSet === 'function') __zpStorageSet(area, key, value); } catch {} }
  function persistStorageRemove(area, key) { try { if (typeof __zpStorageRemove === 'function') __zpStorageRemove(area, key); } catch {} }
  function persistStorageClear(area) { try { if (typeof __zpStorageClear === 'function') __zpStorageClear(area); } catch {} }
  function persistIndexedDB(name, record) { try { if (typeof __zpIndexedDBPut === 'function') __zpIndexedDBPut(name, JSON.stringify(record)); } catch {} }
  function persistIndexedDBDelete(name) { try { if (typeof __zpIndexedDBDelete === 'function') __zpIndexedDBDelete(name); } catch {} }
  function persistCachePut(cacheName, request, response) { try { if (typeof __zpCachePut === 'function') __zpCachePut(cacheName, JSON.stringify(request), JSON.stringify(response)); } catch {} }
  function persistCacheDelete(cacheName, request) { try { if (typeof __zpCacheDelete === 'function') __zpCacheDelete(cacheName, JSON.stringify(request)); } catch {} }
  function persistCacheClear(cacheName) { try { if (typeof __zpCacheClear === 'function') __zpCacheClear(cacheName); } catch {} }
  function dispatchStorageEvent(area, key, oldValue, newValue) { try { globalThis.dispatchEvent?.(new StorageEvent('storage', { key, oldValue, newValue, url: String(globalThis.location?.href || ''), storageArea: globalThis[area] || null })); } catch {} }
  function validateHistoryArgs(method, args) {
    if (args.length < 2) throw new TypeError("Failed to execute '" + method + "' on 'History': 2 arguments required, but only " + args.length + ' present.');
  }
  function validateHistoryURL(method, url) {
    const href = resolveHistoryURL(url);
    const nextOrigin = historyOrigin(href);
    const currentOrigin = globalThis.location?.origin || historyOrigin(globalThis.location?.href || '');
    if (nextOrigin !== currentOrigin) throw securityError("Failed to execute '" + method + "' on 'History': A history state object with URL '" + href + "' cannot be created in a document with origin '" + currentOrigin + "' and URL '" + (globalThis.location?.href || '') + "'.");
    return href;
  }
  function dispatchPopState(state) {
    try {
      const event = new Event('popstate');
      event.state = cloneValue(state, new Map());
      globalThis.dispatchEvent?.(event);
    } catch {}
  }
  function historyOrigin(href) {
    return parsedURL(href).origin || 'null';
  }
  function resolveHistoryURL(url) {
    const base = currentURLBase();
    if (url === undefined || url === null || url === '') return base;
    return hostParseURL(String(url), base)?.href || String(url);
  }
  function resolveURL(url) { return resolveHistoryURL(url); }
  function updateLocation(url) { if (globalThis.location?.__zpSetHref) globalThis.location.__zpSetHref(String(url)); else if (globalThis.location) globalThis.location.href = String(url); }
  function securityError(message) { const error = new Error(message); error.name = 'SecurityError'; return error; }

  globalThis.__zpInstallWebAPICore = installWebAPICore;
