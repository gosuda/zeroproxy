const voiceToken = {};
const speechSynthesisToken = {};

export function createSpeechFacades(EventBase, EventTargetBase) {
  class SpeechSynthesisVoice {
    constructor(token, init = {}) {
      if (token !== voiceToken) throw new TypeError("Failed to construct 'SpeechSynthesisVoice': Illegal constructor");
      defineHidden(this, '__zpVoiceURI', String(init.voiceURI ?? ''));
      defineHidden(this, '__zpName', String(init.name ?? ''));
      defineHidden(this, '__zpLang', String(init.lang ?? ''));
      defineHidden(this, '__zpLocalService', Boolean(init.localService));
      defineHidden(this, '__zpDefault', Boolean(init.default));
    }
    get voiceURI() { return this.__zpVoiceURI; }
    get name() { return this.__zpName; }
    get lang() { return this.__zpLang; }
    get localService() { return this.__zpLocalService; }
    get default() { return this.__zpDefault; }
  }
  Object.defineProperty(SpeechSynthesisVoice.prototype, Symbol.toStringTag, { value: 'SpeechSynthesisVoice', configurable: true });

  class SpeechSynthesisUtterance extends EventTargetBase {
    constructor(text = '') {
      super();
      defineHidden(this, '__zpText', String(text));
      defineHidden(this, '__zpLang', '');
      defineHidden(this, '__zpVoice', null);
      defineHidden(this, '__zpVolume', 1);
      defineHidden(this, '__zpRate', 1);
      defineHidden(this, '__zpPitch', 1);
    }
    get text() { return this.__zpText; }
    set text(value) { defineHidden(this, '__zpText', String(value)); }
    get lang() { return this.__zpLang; }
    set lang(value) { defineHidden(this, '__zpLang', String(value)); }
    get voice() { return this.__zpVoice; }
    set voice(value) { defineHidden(this, '__zpVoice', value); }
    get volume() { return this.__zpVolume; }
    set volume(value) { defineHidden(this, '__zpVolume', Number(value)); }
    get rate() { return this.__zpRate; }
    set rate(value) { defineHidden(this, '__zpRate', Number(value)); }
    get pitch() { return this.__zpPitch; }
    set pitch(value) { defineHidden(this, '__zpPitch', Number(value)); }
  }
  Object.defineProperty(SpeechSynthesisUtterance.prototype, Symbol.toStringTag, { value: 'SpeechSynthesisUtterance', configurable: true });

  const speechSynthesisEventState = new WeakMap();
  function SpeechSynthesisEvent(type, init) {
    if (!new.target) throw new TypeError("Failed to construct 'SpeechSynthesisEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (arguments.length < 2) throw new TypeError(`Failed to construct 'SpeechSynthesisEvent': 2 arguments required, but only ${arguments.length} present.`);
    const state = speechSynthesisEventInit('SpeechSynthesisEvent', init);
    const event = Reflect.construct(EventBase, [type, init], new.target);
    speechSynthesisEventState.set(event, state);
    return event;
  }
  SpeechSynthesisEvent.prototype = Object.create(EventBase.prototype);
  Object.defineProperties(SpeechSynthesisEvent.prototype, {
    utterance: { get() { return speechSynthesisEventValue(this).utterance; }, enumerable: true, configurable: true },
    charIndex: { get() { return speechSynthesisEventValue(this).charIndex; }, enumerable: true, configurable: true },
    charLength: { get() { return speechSynthesisEventValue(this).charLength; }, enumerable: true, configurable: true },
    elapsedTime: { get() { return speechSynthesisEventValue(this).elapsedTime; }, enumerable: true, configurable: true },
    name: { get() { return speechSynthesisEventValue(this).name; }, enumerable: true, configurable: true },
    constructor: { value: SpeechSynthesisEvent, writable: true, configurable: true },
  });
  Object.defineProperty(SpeechSynthesisEvent.prototype, Symbol.toStringTag, { value: 'SpeechSynthesisEvent', configurable: true });

  const speechSynthesisErrorEventState = new WeakMap();
  function SpeechSynthesisErrorEvent(type, init) {
    if (!new.target) throw new TypeError("Failed to construct 'SpeechSynthesisErrorEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (arguments.length < 2) throw new TypeError(`Failed to construct 'SpeechSynthesisErrorEvent': 2 arguments required, but only ${arguments.length} present.`);
    const state = speechSynthesisEventInit('SpeechSynthesisErrorEvent', init);
    const event = Reflect.construct(SpeechSynthesisEvent, [type, init], new.target);
    speechSynthesisErrorEventState.set(event, { error: String(init.error ?? 'canceled') });
    speechSynthesisEventState.set(event, state);
    return event;
  }
  SpeechSynthesisErrorEvent.prototype = Object.create(SpeechSynthesisEvent.prototype);
  Object.defineProperties(SpeechSynthesisErrorEvent.prototype, {
    error: { get() { return speechSynthesisErrorEventValue(this).error; }, enumerable: true, configurable: true },
    constructor: { value: SpeechSynthesisErrorEvent, writable: true, configurable: true },
  });
  Object.defineProperty(SpeechSynthesisErrorEvent.prototype, Symbol.toStringTag, { value: 'SpeechSynthesisErrorEvent', configurable: true });

  class SpeechSynthesis extends EventTargetBase {
    constructor(token) {
      if (token !== speechSynthesisToken) throw new TypeError("Failed to construct 'SpeechSynthesis': Illegal constructor");
      super();
      defineHidden(this, '__zpPending', false);
      defineHidden(this, '__zpSpeaking', false);
      defineHidden(this, '__zpPaused', false);
      defineHidden(this, '__zpVoices', []);
    }
    get pending() { return this.__zpPending; }
    get speaking() { return this.__zpSpeaking; }
    get paused() { return this.__zpPaused; }
    speak(utterance) {
      if (!(utterance instanceof SpeechSynthesisUtterance)) throw new TypeError("Failed to execute 'speak' on 'SpeechSynthesis': parameter 1 is not of type 'SpeechSynthesisUtterance'.");
      defineHidden(this, '__zpSpeaking', true);
      utterance.dispatchEvent(new SpeechSynthesisEvent('start', { utterance }));
      utterance.dispatchEvent(new SpeechSynthesisErrorEvent('error', { utterance, error: 'not-allowed' }));
      defineHidden(this, '__zpSpeaking', false);
      utterance.dispatchEvent(new SpeechSynthesisEvent('end', { utterance, charIndex: utterance.text.length }));
    }
    cancel() { defineHidden(this, '__zpPending', false); defineHidden(this, '__zpSpeaking', false); }
    pause() { defineHidden(this, '__zpPaused', true); }
    resume() { defineHidden(this, '__zpPaused', false); }
    getVoices() { return this.__zpVoices.slice(); }
  }
  Object.defineProperty(SpeechSynthesis.prototype, Symbol.toStringTag, { value: 'SpeechSynthesis', configurable: true });

  const speechGrammarState = new WeakMap();
  function SpeechGrammar() {
    if (!new.target) throw new TypeError("Failed to construct 'SpeechGrammar': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    speechGrammarState.set(this, { src: '', weight: 1 });
  }
  delete SpeechGrammar.prototype.constructor;
  Object.defineProperties(SpeechGrammar.prototype, {
    src: {
      get() { return speechGrammarValue(this).src; },
      set(value) { speechGrammarValue(this).src = speechGrammarURL(value, "Failed to set the 'src' property on 'SpeechGrammar': "); },
      enumerable: true,
      configurable: true,
    },
    weight: {
      get() { return speechGrammarValue(this).weight; },
      set(value) { speechGrammarValue(this).weight = speechGrammarWeight(value); },
      enumerable: true,
      configurable: true,
    },
    constructor: { value: SpeechGrammar, writable: true, configurable: true },
  });
  Object.defineProperty(SpeechGrammar.prototype, Symbol.toStringTag, { value: 'SpeechGrammar', configurable: true });
  Object.defineProperty(SpeechGrammar, 'prototype', { writable: false });

  const speechGrammarListState = new WeakMap();
  function SpeechGrammarList() {
    if (!new.target) throw new TypeError("Failed to construct 'SpeechGrammarList': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    speechGrammarListState.set(this, []);
  }
  delete SpeechGrammarList.prototype.constructor;
  Object.defineProperties(SpeechGrammarList.prototype, {
    length: { get() { return speechGrammarListValue(this).length; }, enumerable: true, configurable: true },
    addFromString: {
      value: function addFromString(string, weight = 1) {
        if (arguments.length < 1) throw new TypeError("Failed to execute 'addFromString' on 'SpeechGrammarList': 1 argument required, but only 0 present.");
        const grammar = new SpeechGrammar();
        speechGrammarState.set(grammar, {
          src: `data:application/xml,${encodeURIComponent(speechGrammarDOMString(string, "Failed to execute 'addFromString' on 'SpeechGrammarList': "))}`,
          weight: speechGrammarWeight(weight),
        });
        appendSpeechGrammar(this, grammar);
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    addFromUri: {
      value: function addFromUri(src, weight = 1) {
        if (arguments.length < 1) throw new TypeError("Failed to execute 'addFromUri' on 'SpeechGrammarList': 1 argument required, but only 0 present.");
        const grammar = new SpeechGrammar();
        speechGrammarState.set(grammar, {
          src: speechGrammarURL(src, "Failed to execute 'addFromUri' on 'SpeechGrammarList': "),
          weight: speechGrammarWeight(weight),
        });
        appendSpeechGrammar(this, grammar);
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    item: { value: function item(index) { return speechGrammarListValue(this)[Number(index)] ?? null; }, enumerable: true, writable: true, configurable: true },
    constructor: { value: SpeechGrammarList, writable: true, configurable: true },
  });
  Object.defineProperty(SpeechGrammarList.prototype, Symbol.toStringTag, { value: 'SpeechGrammarList', configurable: true });
  Object.defineProperty(SpeechGrammarList.prototype, Symbol.iterator, { value: function values() { return speechGrammarListValue(this)[Symbol.iterator](); }, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(SpeechGrammarList, 'prototype', { writable: false });

function speechGrammarValue(grammar) {
  const state = speechGrammarState.get(grammar);
  if (!state) throw new TypeError('Illegal invocation');
  return state;
}

function speechGrammarListValue(list) {
  const state = speechGrammarListState.get(list);
  if (!state) throw new TypeError('Illegal invocation');
  return state;
}

function speechGrammarDOMString(value, prefix) {
  if (typeof value === 'symbol') throw new TypeError(`${prefix}Cannot convert a Symbol value to a string`);
  return String(value);
}

function speechGrammarURL(value, prefix) {
  const text = speechGrammarDOMString(value, prefix);
  try {
    return new URL(text, String(globalThis.location?.href || 'about:blank')).href;
  } catch {
    throw new TypeError(`${prefix}'${text}' is not a valid URL.`);
  }
}

function speechGrammarWeight(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function appendSpeechGrammar(list, grammar) {
  const grammars = speechGrammarListValue(list);
  const index = grammars.length;
  grammars.push(grammar);
  Object.defineProperty(list, index, { value: grammar, enumerable: true, configurable: true, writable: false });
}

  class SpeechRecognition extends EventTargetBase {
    constructor() {
      super();
      defineHidden(this, '__zpGrammars', new SpeechGrammarList());
      defineHidden(this, '__zpLang', '');
      defineHidden(this, '__zpContinuous', false);
      defineHidden(this, '__zpInterimResults', false);
      defineHidden(this, '__zpMaxAlternatives', 1);
    }
    get grammars() { return this.__zpGrammars; }
    set grammars(value) { defineHidden(this, '__zpGrammars', value); }
    get lang() { return this.__zpLang; }
    set lang(value) { defineHidden(this, '__zpLang', String(value)); }
    get continuous() { return this.__zpContinuous; }
    set continuous(value) { defineHidden(this, '__zpContinuous', Boolean(value)); }
    get interimResults() { return this.__zpInterimResults; }
    set interimResults(value) { defineHidden(this, '__zpInterimResults', Boolean(value)); }
    get maxAlternatives() { return this.__zpMaxAlternatives; }
    set maxAlternatives(value) { defineHidden(this, '__zpMaxAlternatives', Number(value) || 0); }
    start() { this.dispatchEvent(new SpeechRecognitionErrorEvent('error', { error: 'not-allowed', message: 'Speech recognition is disabled by policy.' })); this.dispatchEvent(new EventBase('end')); }
    stop() { this.dispatchEvent(new EventBase('end')); }
    abort() { this.dispatchEvent(new EventBase('end')); }
  }
  Object.defineProperty(SpeechRecognition.prototype, Symbol.toStringTag, { value: 'SpeechRecognition', configurable: true });

  class SpeechRecognitionEvent extends EventBase {
    constructor(type, init = {}) {
      super(type, init);
      defineHidden(this, '__zpResultIndex', Number(init.resultIndex ?? 0) || 0);
      defineHidden(this, '__zpResults', init.results ?? []);
      defineHidden(this, '__zpInterpretation', init.interpretation ?? null);
      defineHidden(this, '__zpEmma', init.emma ?? null);
    }
    get resultIndex() { return this.__zpResultIndex; }
    get results() { return this.__zpResults; }
    get interpretation() { return this.__zpInterpretation; }
    get emma() { return this.__zpEmma; }
  }
  Object.defineProperty(SpeechRecognitionEvent.prototype, Symbol.toStringTag, { value: 'SpeechRecognitionEvent', configurable: true });

function speechSynthesisEventInit(eventName, init) {
  if (!init || typeof init !== 'object' || !Object.prototype.hasOwnProperty.call(init, 'utterance')) {
    throw new TypeError(`Failed to construct '${eventName}': Failed to read the 'utterance' property from 'SpeechSynthesisEventInit': Required member is undefined.`);
  }
  if (!(init.utterance instanceof globalThis.SpeechSynthesisUtterance)) {
    throw new TypeError(`Failed to construct '${eventName}': Failed to read the 'utterance' property from 'SpeechSynthesisEventInit': Failed to convert value to 'SpeechSynthesisUtterance'.`);
  }
  return {
    utterance: init.utterance,
    charIndex: Number(init.charIndex ?? 0) || 0,
    charLength: Number(init.charLength ?? 0) || 0,
    elapsedTime: Number(init.elapsedTime ?? 0) || 0,
    name: String(init.name ?? ''),
  };
}

function speechSynthesisEventValue(event) {
  const state = speechSynthesisEventState.get(event);
  if (!state) throw new TypeError('Illegal invocation');
  return state;
}

function speechSynthesisErrorEventValue(event) {
  const state = speechSynthesisErrorEventState.get(event);
  if (!state) throw new TypeError('Illegal invocation');
  return state;
}

  const speechRecognitionErrorEventState = new WeakMap();
  function SpeechRecognitionErrorEvent(type, init = {}) {
    if (!new.target) throw new TypeError("Failed to construct 'SpeechRecognitionErrorEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    const eventType = speechRecognitionErrorEventType(arguments);
    const eventInit = init === null || init === undefined ? {} : Object(init);
    const event = Reflect.construct(EventBase, [eventType, eventInit], new.target);
    speechRecognitionErrorEventState.set(event, {
      error: speechRecognitionErrorEventString(eventInit.error, 'error'),
      message: speechRecognitionErrorEventString(eventInit.message, 'message'),
    });
    return event;
  }
  SpeechRecognitionErrorEvent.prototype = Object.create(EventBase.prototype);
  Object.defineProperties(SpeechRecognitionErrorEvent.prototype, {
    error: { get() { return speechRecognitionErrorEventValue(this).error; }, enumerable: true, configurable: true },
    message: { get() { return speechRecognitionErrorEventValue(this).message; }, enumerable: true, configurable: true },
    constructor: { value: SpeechRecognitionErrorEvent, writable: true, configurable: true },
  });
  Object.defineProperty(SpeechRecognitionErrorEvent.prototype, Symbol.toStringTag, { value: 'SpeechRecognitionErrorEvent', configurable: true });
  Object.defineProperty(SpeechRecognitionErrorEvent, 'prototype', { writable: false });

function speechRecognitionErrorEventType(args) {
  if (args.length < 1) throw new TypeError("Failed to construct 'SpeechRecognitionErrorEvent': 1 argument required, but only 0 present.");
  if (typeof args[0] === 'symbol') throw new TypeError("Failed to construct 'SpeechRecognitionErrorEvent': Cannot convert a Symbol value to a string");
  return String(args[0]);
}

function speechRecognitionErrorEventString(value, key) {
  if (value === undefined) return '';
  if (typeof value === 'symbol') throw new TypeError(`Failed to construct 'SpeechRecognitionErrorEvent': Failed to read the '${key}' property from 'SpeechRecognitionErrorEventInit': Cannot convert a Symbol value to a string`);
  return String(value);
}

function speechRecognitionErrorEventValue(event) {
  const state = speechRecognitionErrorEventState.get(event);
  if (!state) throw new TypeError('Illegal invocation');
  return state;
}

  return { SpeechSynthesis, SpeechSynthesisUtterance, SpeechSynthesisEvent, SpeechSynthesisErrorEvent, SpeechSynthesisVoice, SpeechGrammar, SpeechGrammarList, SpeechRecognition, SpeechRecognitionEvent, SpeechRecognitionErrorEvent, speechSynthesis: new SpeechSynthesis(speechSynthesisToken) };
}

function defineHidden(target, key, value) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}
