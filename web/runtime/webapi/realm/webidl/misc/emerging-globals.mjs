const illegalInterfaceNames = Object.freeze([
  'AnimationTrigger',
  'CSSFunctionDeclarations',
  'CSSFunctionDescriptors',
  'CSSFunctionRule',
  'CSSPositionTryDescriptors',
  'Fence',
  'FencedFrameConfig',
  'GamepadHapticActuator',
  'IDBRecord',
  'Ink',
  'NotRestoredReasonDetails',
  'NotRestoredReasons',
  'Scheduling',
  'SharedStorage',
  'SharedStorageAppendMethod',
  'SharedStorageClearMethod',
  'SharedStorageDeleteMethod',
  'SharedStorageModifierMethod',
  'SharedStorageSetMethod',
  'SharedStorageWorklet',
  'SnapEvent',
  'Subscriber',
  'TimelineTriggerRange',
  'TimelineTriggerRangeList',
  'WebGLObject',
  'Viewport',
]);

export function createEmergingGlobalFacades(EventBase, EventTargetBase, DOMExceptionBase) {
  const facades = Object.fromEntries(illegalInterfaceNames.map((name) => [name, makeIllegalConstructor(name)]));
  facades.CaretPosition = makeCaretPosition();
  facades.EditContext = makeEditContext(EventTargetBase);
  facades.InterestEvent = makeInterestEvent(EventBase);
  facades.MediaStreamTrackGenerator = makeMediaStreamTrackGenerator(DOMExceptionBase);
  facades.MediaStreamTrackProcessor = makeMediaStreamTrackProcessor(DOMExceptionBase);
  facades.Subscriber = makeSubscriber();
  facades.Observable = makeObservable(facades.Subscriber);
  facades.Origin = makeOrigin();
  facades.Profiler = makeProfiler(EventTargetBase);
  facades.Sanitizer = makeSanitizer();
  facades.TimelineTrigger = makeTimelineTrigger();
  return facades;
}

export function installEmergingGlobalSingletons() {
  globalThis.chrome = Object.freeze({ app: Object.freeze({}), csi: () => ({}), loadTimes: () => ({}) });
  globalThis.event = undefined;
  globalThis.fence = null;
  globalThis.styleMedia = Object.freeze({
    type: 'screen',
    matchMedium(query = '') { return Boolean(globalThis.matchMedia?.(String(query)).matches); },
    [Symbol.toStringTag]: 'StyleMedia',
  });
  globalThis.viewport = Object.freeze({ [Symbol.toStringTag]: 'Viewport' });
  globalThis.webkitRequestFileSystem = webkitRequestFileSystem;
  globalThis.webkitResolveLocalFileSystemURL = webkitResolveLocalFileSystemURL;
}

function makeIllegalConstructor(name) {
  const ctor = function EmergingIllegalConstructor() {
    throw new TypeError(`Failed to construct '${name}': Illegal constructor`);
  };
  Object.defineProperty(ctor, 'name', { value: name, configurable: true });
  Object.defineProperty(ctor.prototype, Symbol.toStringTag, { value: name, configurable: true });
  return ctor;
}

function makeCaretPosition() {
  const token = {};
  class CaretPosition {
    constructor(internalToken, offsetNode = null, offset = 0) {
      if (internalToken !== token) throw new TypeError("Failed to construct 'CaretPosition': Illegal constructor");
      this.offsetNode = offsetNode;
      this.offset = Math.max(0, Number(offset) || 0);
    }
    getClientRect() { return this.offsetNode?.getBoundingClientRect?.() || new DOMRect(0, 0, 0, 0); }
  }
  Object.defineProperty(CaretPosition, '__zpCreate', { value: (offsetNode, offset) => new CaretPosition(token, offsetNode, offset), configurable: true });
  Object.defineProperty(CaretPosition.prototype, Symbol.toStringTag, { value: 'CaretPosition', configurable: true });
  return CaretPosition;
}

function makeEditContext(EventTargetBase) {
  class EditContext extends EventTargetBase {
    constructor() {
      super();
      this.text = '';
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.characterBoundsRangeStart = 0;
      this.ontextupdate = null;
      this.ontextformatupdate = null;
      this.oncharacterboundsupdate = null;
      this.oncompositionstart = null;
      this.oncompositionend = null;
    }
    updateText(rangeStart = 0, rangeEnd = 0, text = '') {
      const start = Math.max(0, Number(rangeStart) || 0);
      const end = Math.max(start, Number(rangeEnd) || start);
      this.text = this.text.slice(0, start) + String(text) + this.text.slice(end);
    }
    updateSelection(start = 0, end = start) {
      this.selectionStart = Math.max(0, Number(start) || 0);
      this.selectionEnd = Math.max(this.selectionStart, Number(end) || this.selectionStart);
    }
    updateControlBounds() {}
    updateSelectionBounds() {}
    updateCharacterBounds(rangeStart = 0) { this.characterBoundsRangeStart = Math.max(0, Number(rangeStart) || 0); }
    attachedElements() { return []; }
  }
  Object.defineProperty(EditContext.prototype, Symbol.toStringTag, { value: 'EditContext', configurable: true });
  return EditContext;
}

function makeInterestEvent(EventBase) {
  const interestEventState = new WeakMap();
  function InterestEvent(type, init = {}) {
    if (!new.target) throw new TypeError("Failed to construct 'InterestEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (arguments.length < 1) throw new TypeError("Failed to construct 'InterestEvent': 1 argument required, but only 0 present.");
    const eventInit = init === null || init === undefined ? {} : Object(init);
    const source = interestEventSource(eventInit.source);
    const event = Reflect.construct(EventBase, [type, eventInit], new.target);
    interestEventState.set(event, { source });
    return event;
  }
  InterestEvent.prototype = Object.create(EventBase.prototype);
  Object.defineProperties(InterestEvent.prototype, {
    source: {
      get() {
        const state = interestEventState.get(this);
        if (!state) throw new TypeError('Illegal invocation');
        return state.source;
      },
      enumerable: true,
      configurable: true,
    },
    constructor: { value: InterestEvent, enumerable: false, writable: true, configurable: true },
  });
  Object.defineProperty(InterestEvent.prototype, Symbol.toStringTag, { value: 'InterestEvent', configurable: true });
  Object.defineProperty(InterestEvent, 'prototype', { writable: false });
  return InterestEvent;
}

function interestEventSource(value) {
  if (value === null || value === undefined) return null;
  if (value?.nodeType !== 1) {
    throw new TypeError("Failed to construct 'InterestEvent': Failed to read the 'source' property from 'InterestEventInit': Failed to convert value to 'Element'.");
  }
  return value;
}

function makeMediaStreamTrackGenerator(DOMExceptionBase) {
  class MediaStreamTrackGenerator {
    constructor(init = undefined) {
      if (init === undefined) throw new TypeError("Failed to construct 'MediaStreamTrackGenerator': 1 argument required, but only 0 present.");
      const kind = String(init?.kind || '');
      if (kind !== 'audio' && kind !== 'video') throw new TypeError("Failed to construct 'MediaStreamTrackGenerator': kind must be 'audio' or 'video'.");
      this.kind = kind;
      this.writable = typeof globalThis.WritableStream === 'function' ? new globalThis.WritableStream() : {};
      this.muted = false;
      this.readyState = 'ended';
    }
    stop() { this.readyState = 'ended'; }
    clone() { throw new DOMExceptionBase('MediaStreamTrackGenerator cloning is disabled by policy.', 'NotSupportedError'); }
  }
  Object.defineProperty(MediaStreamTrackGenerator.prototype, Symbol.toStringTag, { value: 'MediaStreamTrackGenerator', configurable: true });
  return MediaStreamTrackGenerator;
}

function makeMediaStreamTrackProcessor() {
  class MediaStreamTrackProcessor {
    constructor(init = undefined) {
      if (init === undefined) throw new TypeError("Failed to construct 'MediaStreamTrackProcessor': 1 argument required, but only 0 present.");
      if (!init?.track) throw new TypeError("Failed to construct 'MediaStreamTrackProcessor': track is required.");
      this.readable = typeof globalThis.ReadableStream === 'function' ? new globalThis.ReadableStream() : {};
    }
  }
  Object.defineProperty(MediaStreamTrackProcessor.prototype, Symbol.toStringTag, { value: 'MediaStreamTrackProcessor', configurable: true });
  return MediaStreamTrackProcessor;
}

function makeSubscriber() {
  const token = {};
  class Subscriber {
    constructor(internalToken, observer = {}) {
      if (internalToken !== token) throw new TypeError("Failed to construct 'Subscriber': Illegal constructor");
      this.__zpObserver = typeof observer === 'function' ? { next: observer } : observer || {};
      this.__zpCleanup = null;
      this.__zpClosed = false;
    }
    get closed() { return this.__zpClosed; }
    next(value) { if (!this.__zpClosed) this.__zpObserver.next?.(value); }
    error(error) {
      if (this.__zpClosed) return;
      this.__zpClosed = true;
      this.__zpObserver.error?.(error);
      this.__zpRunCleanup();
    }
    complete() {
      if (this.__zpClosed) return;
      this.__zpClosed = true;
      this.__zpObserver.complete?.();
      this.__zpRunCleanup();
    }
    unsubscribe() {
      if (this.__zpClosed) return;
      this.__zpClosed = true;
      this.__zpRunCleanup();
    }
    __zpSetCleanup(cleanup) {
      this.__zpCleanup = typeof cleanup === 'function' ? cleanup : cleanup?.unsubscribe?.bind(cleanup) || null;
      if (this.__zpClosed) this.__zpRunCleanup();
    }
    __zpRunCleanup() {
      const cleanup = this.__zpCleanup;
      this.__zpCleanup = null;
      cleanup?.();
    }
  }
  Object.defineProperty(Subscriber, '__zpCreate', { value: (observer) => new Subscriber(token, observer), configurable: true });
  Object.defineProperty(Subscriber.prototype, Symbol.toStringTag, { value: 'Subscriber', configurable: true });
  return Subscriber;
}

function makeObservable(Subscriber) {
  class Observable {
    constructor(subscribe) {
      if (typeof subscribe !== 'function') throw new TypeError("Failed to construct 'Observable': parameter 1 is not a function.");
      this.__zpSubscribe = subscribe;
    }
    subscribe(observer = {}) {
      const subscriber = Subscriber.__zpCreate(observer);
      try {
        subscriber.__zpSetCleanup(this.__zpSubscribe(subscriber));
      } catch (error) {
        subscriber.error(error);
      }
      return subscriber;
    }
    map(callback) { return new Observable((subscriber) => this.subscribe({ next: (value) => subscriber.next(callback(value)), error: (error) => subscriber.error(error), complete: () => subscriber.complete() })); }
    filter(callback) { return new Observable((subscriber) => this.subscribe({ next: (value) => { if (callback(value)) subscriber.next(value); }, error: (error) => subscriber.error(error), complete: () => subscriber.complete() })); }
    forEach(callback) { return new Promise((resolve, reject) => this.subscribe({ next: callback, error: reject, complete: resolve })); }
    static of(...values) { return new Observable((subscriber) => { for (const value of values) subscriber.next(value); subscriber.complete(); }); }
  }
  Object.defineProperty(Observable.prototype, Symbol.toStringTag, { value: 'Observable', configurable: true });
  return Observable;
}

function makeOrigin() {
  class Origin {
    constructor(value = globalThis.location?.origin || 'null') { this.value = String(value); }
    toString() { return this.value; }
    toJSON() { return this.value; }
  }
  Object.defineProperty(Origin.prototype, Symbol.toStringTag, { value: 'Origin', configurable: true });
  return Origin;
}

function makeProfiler(EventTargetBase) {
  class Profiler extends EventTargetBase {
    constructor(init = undefined) {
      if (init === undefined) throw new TypeError("Failed to construct 'Profiler': 1 argument required, but only 0 present.");
      super();
      this.sampleInterval = Number(init?.sampleInterval ?? 10);
      this.stopped = false;
    }
    stop() { this.stopped = true; return Promise.resolve({ samples: [], resources: [] }); }
  }
  Object.defineProperty(Profiler.prototype, Symbol.toStringTag, { value: 'Profiler', configurable: true });
  return Profiler;
}

function makeSanitizer() {
  class Sanitizer {
    constructor(config = {}) { this.__zpConfig = { ...config }; }
    get() { return { ...this.__zpConfig }; }
    allowElement(name) { this.__zpConfig.elements = [...(this.__zpConfig.elements || []), String(name)]; return this; }
    removeElement(name) { this.__zpConfig.removeElements = [...(this.__zpConfig.removeElements || []), String(name)]; return this; }
    replaceElementWithChildren(name) { this.__zpConfig.replaceWithChildrenElements = [...(this.__zpConfig.replaceWithChildrenElements || []), String(name)]; return this; }
    allowAttribute(attribute, element = '*') { this.__zpConfig.attributes = [...(this.__zpConfig.attributes || []), [String(attribute), String(element)]]; return this; }
    removeAttribute(attribute, element = '*') { this.__zpConfig.removeAttributes = [...(this.__zpConfig.removeAttributes || []), [String(attribute), String(element)]]; return this; }
    removeUnsafe() { this.__zpConfig.removeUnsafe = true; return this; }
    setComments(allow = true) { this.__zpConfig.comments = Boolean(allow); return this; }
    setDataAttributes(allow = true) { this.__zpConfig.dataAttributes = Boolean(allow); return this; }
  }
  Object.defineProperty(Sanitizer.prototype, Symbol.toStringTag, { value: 'Sanitizer', configurable: true });
  return Sanitizer;
}

function makeTimelineTrigger() {
  class TimelineTrigger {
    constructor(init = {}) {
      this.timeline = init.timeline ?? null;
      this.rangeStart = init.rangeStart ?? null;
      this.rangeEnd = init.rangeEnd ?? null;
      this.exitRangeStart = init.exitRangeStart ?? null;
      this.exitRangeEnd = init.exitRangeEnd ?? null;
    }
  }
  Object.defineProperty(TimelineTrigger.prototype, Symbol.toStringTag, { value: 'TimelineTrigger', configurable: true });
  return TimelineTrigger;
}

function webkitRequestFileSystem(_type, _size, successCallback = undefined, errorCallback = undefined) {
  if (typeof errorCallback === 'function') queueMicrotask(() => errorCallback(new DOMException('FileSystem API is disabled by policy.', 'NotSupportedError')));
  else if (typeof successCallback !== 'function') throw new TypeError("Failed to execute 'webkitRequestFileSystem': successCallback must be a function.");
}

function webkitResolveLocalFileSystemURL(_url, _successCallback = undefined, errorCallback = undefined) {
  if (typeof errorCallback === 'function') queueMicrotask(() => errorCallback(new DOMException('FileSystem API is disabled by policy.', 'NotSupportedError')));
}
