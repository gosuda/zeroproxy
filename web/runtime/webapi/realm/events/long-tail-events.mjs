export function createLongTailEventConstructors(BaseEvent, UIEvent) {
  const textEventState = new WeakMap();
  const textFormatState = new WeakMap();
  const textFormatUpdateEventState = new WeakMap();

  function TextEvent() {
    if (new.target) throw new TypeError("Failed to construct 'TextEvent': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  Object.setPrototypeOf(TextEvent, UIEvent);
  TextEvent.prototype = Object.create(UIEvent.prototype);
  Object.defineProperties(TextEvent.prototype, {
    data: { get() { return textEventValue(this).data; }, enumerable: true, configurable: true },
    initTextEvent: { value: function initTextEvent(type) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'initTextEvent' on 'TextEvent': 1 argument required, but only 0 present.");
      this.initUIEvent(textEventString(type), Boolean(arguments[1]), Boolean(arguments[2]), arguments.length > 3 ? arguments[3] : null, 0);
      textEventState.set(this, { data: textEventString(arguments.length > 4 ? arguments[4] : undefined) });
    }, writable: true, enumerable: true, configurable: true },
    constructor: { value: TextEvent, writable: true, configurable: true },
  });
  Object.defineProperty(TextEvent, 'prototype', { writable: false });

  function createTextEventInstance() {
    const event = Reflect.construct(UIEvent, [''], TextEvent);
    textEventState.set(event, { data: '' });
    return event;
  }

  function textEventValue(event) {
    const state = textEventState.get(event);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function textEventString(value) {
    if (typeof value === 'symbol') throw new TypeError("Failed to execute 'initTextEvent' on 'TextEvent': Cannot convert a Symbol value to a string");
    return String(value);
  }

  const characterBoundsUpdateEventState = new WeakMap();
  class CharacterBoundsUpdateEvent extends BaseEvent {
    constructor(type, init = {}) {
      super(type, init);
      characterBoundsUpdateEventState.set(this, {
        rangeStart: finiteEventNumber(init.rangeStart),
        rangeEnd: finiteEventNumber(init.rangeEnd),
      });
    }
  }
  definePayloadGetters(CharacterBoundsUpdateEvent, characterBoundsUpdateEventState, ['rangeStart', 'rangeEnd']);

  class TextFormat {
    constructor(init = {}) {
      textFormatState.set(this, {
        rangeStart: finiteEventNumber(init.rangeStart),
        rangeEnd: finiteEventNumber(init.rangeEnd),
        underlineStyle: String(init.underlineStyle ?? 'none'),
        underlineThickness: String(init.underlineThickness ?? 'none'),
      });
    }
  }
  definePayloadGetters(TextFormat, textFormatState, ['rangeStart', 'rangeEnd', 'underlineStyle', 'underlineThickness']);

  class TextFormatUpdateEvent extends BaseEvent {
    constructor(type, init = {}) {
      super(type, init);
      textFormatUpdateEventState.set(this, { textFormats: Array.from(init.textFormats ?? []) });
    }
    getTextFormats() { return payloadValue(textFormatUpdateEventState, this).textFormats.slice(); }
  }
  definePayloadGetters(TextFormatUpdateEvent, textFormatUpdateEventState, [], { methods: ['getTextFormats'] });

  const textUpdateEventState = new WeakMap();
  class TextUpdateEvent extends BaseEvent {
    constructor(type, init = {}) {
      super(type, init);
      textUpdateEventState.set(this, {
        updateRangeStart: finiteEventNumber(init.updateRangeStart),
        updateRangeEnd: finiteEventNumber(init.updateRangeEnd),
        text: String(init.text ?? ''),
        selectionStart: finiteEventNumber(init.selectionStart),
        selectionEnd: finiteEventNumber(init.selectionEnd),
      });
    }
  }
  definePayloadGetters(TextUpdateEvent, textUpdateEventState, ['updateRangeStart', 'updateRangeEnd', 'text', 'selectionStart', 'selectionEnd']);

  const trackEventState = new WeakMap();
  function TrackEvent(type, init = {}) {
    if (!new.target) throw new TypeError("Failed to construct 'TrackEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (arguments.length < 1) throw new TypeError("Failed to construct 'TrackEvent': 1 argument required, but only 0 present.");
    const track = validateTrackEventTrack(init?.track ?? null);
    const event = Reflect.construct(BaseEvent, [type, init], new.target);
    trackEventState.set(event, { track });
    return event;
  }
  TrackEvent.prototype = Object.create(BaseEvent.prototype);
  Object.defineProperty(TrackEvent.prototype, 'constructor', { value: TrackEvent, writable: true, configurable: true });
  definePayloadGetters(TrackEvent, trackEventState, ['track']);
  const mediaStreamTrackEventState = new WeakMap();
  function MediaStreamTrackEvent(type, init) {
    if (!new.target) throw new TypeError("Failed to construct 'MediaStreamTrackEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (arguments.length < 2) throw new TypeError(`Failed to construct 'MediaStreamTrackEvent': 2 arguments required, but only ${arguments.length} present.`);
    const track = validateMediaStreamTrackEventTrack(init);
    const event = Reflect.construct(BaseEvent, [type, init], new.target);
    mediaStreamTrackEventState.set(event, { track });
    return event;
  }
  MediaStreamTrackEvent.prototype = Object.create(BaseEvent.prototype);
  Object.defineProperty(MediaStreamTrackEvent.prototype, 'constructor', { value: MediaStreamTrackEvent, writable: true, configurable: true });
  definePayloadGetters(MediaStreamTrackEvent, mediaStreamTrackEventState, ['track']);

  const mediaEncryptedEventState = new WeakMap();
  class MediaEncryptedEvent extends BaseEvent {
    constructor(type, init = {}) {
      super(type, init);
      mediaEncryptedEventState.set(this, {
        initDataType: String(init.initDataType ?? ''),
        initData: init.initData ?? null,
      });
    }
  }
  definePayloadGetters(MediaEncryptedEvent, mediaEncryptedEventState, ['initDataType', 'initData']);

  const pageRevealEventState = new WeakMap();
  class PageRevealEvent extends BaseEvent {
    constructor(type, init = {}) {
      super(type, init);
      pageRevealEventState.set(this, { viewTransition: init.viewTransition ?? null });
    }
  }
  definePayloadGetters(PageRevealEvent, pageRevealEventState, ['viewTransition']);

  const pageSwapEventState = new WeakMap();
  class PageSwapEvent extends BaseEvent {
    constructor(type, init = {}) {
      super(type, init);
      pageSwapEventState.set(this, {
        viewTransition: init.viewTransition ?? null,
        activation: init.activation ?? null,
      });
    }
  }
  definePayloadGetters(PageSwapEvent, pageSwapEventState, ['viewTransition', 'activation']);

  const mediaStreamEventState = new WeakMap();
  class MediaStreamEvent extends BaseEvent {
    constructor(type, init = {}) {
      super(type, init);
      mediaStreamEventState.set(this, { stream: init.stream ?? null });
    }
  }
  definePayloadGetters(MediaStreamEvent, mediaStreamEventState, ['stream']);

  const rtcPeerConnectionIceEventState = new WeakMap();
  class RTCPeerConnectionIceEvent extends BaseEvent {
    constructor(type, init = {}) {
      super(type, init);
      rtcPeerConnectionIceEventState.set(this, { candidate: init.candidate ?? null });
    }
  }
  definePayloadGetters(RTCPeerConnectionIceEvent, rtcPeerConnectionIceEventState, ['candidate']);

  const rtcPeerConnectionIceErrorEventState = new WeakMap();
  class RTCPeerConnectionIceErrorEvent extends BaseEvent {
    constructor(type, init) {
      const eventInit = requiredInit('RTCPeerConnectionIceErrorEvent', init, arguments.length);
      super(type, eventInit);
      rtcPeerConnectionIceErrorEventState.set(this, {
        address: eventInit.address ?? null,
        port: eventInit.port === undefined || eventInit.port === null ? null : finiteEventNumber(eventInit.port),
        hostCandidate: String(eventInit.hostCandidate ?? ''),
        url: String(eventInit.url ?? ''),
        errorCode: finiteEventNumber(eventInit.errorCode),
        errorText: String(eventInit.errorText ?? ''),
      });
    }
  }
  definePayloadGetters(RTCPeerConnectionIceErrorEvent, rtcPeerConnectionIceErrorEventState, ['address', 'port', 'hostCandidate', 'url', 'errorCode', 'errorText']);

  class RTCTrackEvent extends BaseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.receiver = init.receiver ?? null;
      this.track = init.track ?? null;
      this.streams = Array.from(init.streams ?? []);
      this.transceiver = init.transceiver ?? null;
    }
  }

  const rtcErrorEventState = new WeakMap();
  function RTCErrorEvent(type, init) {
    if (!new.target) throw new TypeError("Failed to construct 'RTCErrorEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (arguments.length < 2) throw new TypeError(`Failed to construct 'RTCErrorEvent': 2 arguments required, but only ${arguments.length} present.`);
    const error = validateRequiredEventPayload('RTCErrorEvent', 'RTCErrorEventInit', init, 'error', 'RTCError', globalThis.RTCError);
    const event = Reflect.construct(BaseEvent, [type, init], new.target);
    rtcErrorEventState.set(event, { error });
    return event;
  }
  RTCErrorEvent.prototype = Object.create(BaseEvent.prototype);
  Object.defineProperty(RTCErrorEvent.prototype, 'constructor', { value: RTCErrorEvent, writable: true, configurable: true });
  definePayloadGetters(RTCErrorEvent, rtcErrorEventState, ['error']);

  const rtcDataChannelEventState = new WeakMap();
  function RTCDataChannelEvent(type, init) {
    if (!new.target) throw new TypeError("Failed to construct 'RTCDataChannelEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (arguments.length < 2) throw new TypeError(`Failed to construct 'RTCDataChannelEvent': 2 arguments required, but only ${arguments.length} present.`);
    const channel = validateRequiredEventPayload('RTCDataChannelEvent', 'RTCDataChannelEventInit', init, 'channel', 'RTCDataChannel', globalThis.RTCDataChannel);
    const event = Reflect.construct(BaseEvent, [type, init], new.target);
    rtcDataChannelEventState.set(event, { channel });
    return event;
  }
  RTCDataChannelEvent.prototype = Object.create(BaseEvent.prototype);
  Object.defineProperty(RTCDataChannelEvent.prototype, 'constructor', { value: RTCDataChannelEvent, writable: true, configurable: true });
  definePayloadGetters(RTCDataChannelEvent, rtcDataChannelEventState, ['channel']);

  const rtcDTMFToneChangeEventState = new WeakMap();
  class RTCDTMFToneChangeEvent extends BaseEvent {
    constructor(type, init) {
      const eventInit = requiredInit('RTCDTMFToneChangeEvent', init, arguments.length);
      super(type, eventInit);
      rtcDTMFToneChangeEventState.set(this, { tone: String(eventInit.tone ?? '') });
    }
  }
  definePayloadGetters(RTCDTMFToneChangeEvent, rtcDTMFToneChangeEventState, ['tone']);

  return {
    TextEvent,
    createTextEventInstance,
    CharacterBoundsUpdateEvent,
    TextFormat,
    TextFormatUpdateEvent,
    TextUpdateEvent,
    TrackEvent,
    MediaStreamTrackEvent,
    MediaEncryptedEvent,
    PageRevealEvent,
    PageSwapEvent,
    MediaStreamEvent,
    RTCPeerConnectionIceEvent,
    RTCPeerConnectionIceErrorEvent,
    RTCTrackEvent,
    RTCErrorEvent,
    RTCDataChannelEvent,
    RTCDTMFToneChangeEvent,
  };
}

function definePayloadGetters(Ctor, stateMap, keys, options = {}) {
  const constructorDescriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, 'constructor');
  const methodDescriptors = (options.methods || []).map((name) => [name, Object.getOwnPropertyDescriptor(Ctor.prototype, name)]);
  delete Ctor.prototype.constructor;
  for (const [name] of methodDescriptors) delete Ctor.prototype[name];
  for (const key of keys) {
    Object.defineProperty(Ctor.prototype, key, {
      get() {
        return payloadValue(stateMap, this)[key];
      },
      enumerable: true,
      configurable: true,
    });
  }
  for (const [name, descriptor] of methodDescriptors) {
    if (descriptor) Object.defineProperty(Ctor.prototype, name, { ...descriptor, enumerable: true, configurable: true, writable: true });
  }
  Object.defineProperty(Ctor.prototype, 'constructor', constructorDescriptor);
}

function payloadValue(stateMap, value) {
  const state = stateMap.get(value);
  if (!state) throw new TypeError('Illegal invocation');
  return state;
}

function validateTrackEventTrack(track) {
  if (track === null) return null;
  const audioTrack = globalThis.AudioTrack;
  const textTrack = globalThis.TextTrack;
  const videoTrack = globalThis.VideoTrack;
  if ((typeof audioTrack === 'function' && track instanceof audioTrack) || (typeof textTrack === 'function' && track instanceof textTrack) || (typeof videoTrack === 'function' && track instanceof videoTrack)) return track;
  throw new TypeError("Failed to construct 'TrackEvent': Failed to read the 'track' property from 'TrackEventInit': The provided value is not of type '(AudioTrack or TextTrack or VideoTrack)'.");
}

function validateMediaStreamTrackEventTrack(init) {
  if (!init || typeof init !== 'object' || !Object.prototype.hasOwnProperty.call(init, 'track')) {
    throw new TypeError("Failed to construct 'MediaStreamTrackEvent': Failed to read the 'track' property from 'MediaStreamTrackEventInit': Required member is undefined.");
  }
  const mediaStreamTrack = globalThis.MediaStreamTrack;
  if (typeof mediaStreamTrack === 'function' && init.track instanceof mediaStreamTrack) return init.track;
  throw new TypeError("Failed to construct 'MediaStreamTrackEvent': Failed to read the 'track' property from 'MediaStreamTrackEventInit': Failed to convert value to 'MediaStreamTrack'.");
}

function validateRequiredEventPayload(eventName, initName, init, key, valueTypeName, Ctor) {
  if (!init || typeof init !== 'object' || !Object.prototype.hasOwnProperty.call(init, key)) {
    throw new TypeError(`Failed to construct '${eventName}': Failed to read the '${key}' property from '${initName}': Required member is undefined.`);
  }
  if (typeof Ctor === 'function' && init[key] instanceof Ctor) return init[key];
  throw new TypeError(`Failed to construct '${eventName}': Failed to read the '${key}' property from '${initName}': Failed to convert value to '${valueTypeName}'.`);
}


function finiteEventNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function requiredInit(name, init, actual) {
  if (actual < 2) throw new TypeError(`Failed to construct '${name}': 2 arguments required, but only ${actual} present.`);
  if (init === null || typeof init !== 'object') return {};
  return init;
}
