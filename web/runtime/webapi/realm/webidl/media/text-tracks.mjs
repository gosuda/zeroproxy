const cueListToken = {};

export function createTextTrackFacades(EventTargetBase, DocumentFragmentBase) {
  class TextTrackCue extends EventTargetBase {
    constructor(token) { if (token !== vttCueToken) throw new TypeError("Failed to construct 'TextTrackCue': Illegal constructor"); super(); }
    get track() { return trackValue(this, '__zpTrack', null); }
    get id() { return trackValue(this, '__zpId', ''); }
    set id(value) { defineHidden(this, '__zpId', String(value)); }
    get startTime() { return trackValue(this, '__zpStartTime', 0); }
    set startTime(value) { defineHidden(this, '__zpStartTime', Number(value) || 0); }
    get endTime() { return trackValue(this, '__zpEndTime', 0); }
    set endTime(value) { defineHidden(this, '__zpEndTime', Number(value) || 0); }
    get pauseOnExit() { return trackValue(this, '__zpPauseOnExit', false); }
    set pauseOnExit(value) { defineHidden(this, '__zpPauseOnExit', Boolean(value)); }
  }
  Object.defineProperty(TextTrackCue.prototype, Symbol.toStringTag, { value: 'TextTrackCue', configurable: true });

  class VTTCue extends TextTrackCue {
    constructor(startTime, endTime, text) {
      super(vttCueToken);
      defineHidden(this, '__zpStartTime', Number(startTime) || 0);
      defineHidden(this, '__zpEndTime', Number(endTime) || 0);
      defineHidden(this, '__zpText', String(text ?? ''));
      defineHidden(this, '__zpId', '');
      defineHidden(this, '__zpPauseOnExit', false);
      defineHidden(this, '__zpTrack', null);
      defineHidden(this, '__zpRegion', null);
      defineHidden(this, '__zpVertical', '');
      defineHidden(this, '__zpSnapToLines', true);
      defineHidden(this, '__zpLine', 'auto');
      defineHidden(this, '__zpLineAlign', 'start');
      defineHidden(this, '__zpPosition', 'auto');
      defineHidden(this, '__zpPositionAlign', 'auto');
      defineHidden(this, '__zpSize', 100);
      defineHidden(this, '__zpAlign', 'center');
    }
    get region() { return this.__zpRegion; }
    set region(value) { defineHidden(this, '__zpRegion', value ?? null); }
    get vertical() { return this.__zpVertical; }
    set vertical(value) { defineHidden(this, '__zpVertical', String(value)); }
    get snapToLines() { return this.__zpSnapToLines; }
    set snapToLines(value) { defineHidden(this, '__zpSnapToLines', Boolean(value)); }
    get line() { return this.__zpLine; }
    set line(value) { defineHidden(this, '__zpLine', value === 'auto' ? 'auto' : Number(value)); }
    get lineAlign() { return this.__zpLineAlign; }
    set lineAlign(value) { defineHidden(this, '__zpLineAlign', String(value)); }
    get position() { return this.__zpPosition; }
    set position(value) { defineHidden(this, '__zpPosition', value === 'auto' ? 'auto' : Number(value)); }
    get positionAlign() { return this.__zpPositionAlign; }
    set positionAlign(value) { defineHidden(this, '__zpPositionAlign', String(value)); }
    get size() { return this.__zpSize; }
    set size(value) { defineHidden(this, '__zpSize', Number(value) || 0); }
    get align() { return this.__zpAlign; }
    set align(value) { defineHidden(this, '__zpAlign', String(value)); }
    get text() { return this.__zpText; }
    set text(value) { defineHidden(this, '__zpText', String(value)); }
    getCueAsHTML() { return typeof globalThis.DocumentFragment === 'function' ? new globalThis.DocumentFragment() : new DocumentFragmentBase(); }
  }
  Object.defineProperty(VTTCue.prototype, Symbol.toStringTag, { value: 'VTTCue', configurable: true });

  class TextTrackCueList {
    constructor(token, cues = []) {
      if (token !== cueListToken) throw new TypeError("Failed to construct 'TextTrackCueList': Illegal constructor");
      defineHidden(this, '__zpCues', cues);
      refreshIndexes(this);
    }
    get length() { return this.__zpCues.length; }
    item(index) { return this.__zpCues[Number(index)] ?? null; }
    getCueById(id) { return this.__zpCues.find((cue) => cue.id === String(id)) ?? null; }
    [Symbol.iterator]() { return this.__zpCues[Symbol.iterator](); }
  }
  Object.defineProperty(TextTrackCueList.prototype, Symbol.toStringTag, { value: 'TextTrackCueList', configurable: true });

  class TextTrack extends EventTargetBase {
    constructor() { throw new TypeError("Failed to construct 'TextTrack': Illegal constructor"); }
    get kind() { return trackValue(this, '__zpKind', 'subtitles'); }
    get label() { return trackValue(this, '__zpLabel', ''); }
    get language() { return trackValue(this, '__zpLanguage', ''); }
    get id() { return trackValue(this, '__zpId', ''); }
    get inBandMetadataTrackDispatchType() { return trackValue(this, '__zpDispatchType', ''); }
    get mode() { return trackValue(this, '__zpMode', 'disabled'); }
    set mode(value) { defineHidden(this, '__zpMode', String(value)); }
    get cues() { return new TextTrackCueList(cueListToken, trackValue(this, '__zpCues', [])); }
    get activeCues() { return new TextTrackCueList(cueListToken, trackValue(this, '__zpActiveCues', trackValue(this, '__zpCues', []))); }
    addCue(cue) {
      if (!(cue instanceof TextTrackCue)) throw new TypeError("Failed to execute 'addCue' on 'TextTrack': parameter 1 is not of type 'TextTrackCue'.");
      const cues = ensureTrackArray(this, '__zpCues');
      if (!cues.includes(cue)) cues.push(cue);
      defineHidden(cue, '__zpTrack', this);
    }
    removeCue(cue) {
      if (!(cue instanceof TextTrackCue)) throw new TypeError("Failed to execute 'removeCue' on 'TextTrack': parameter 1 is not of type 'TextTrackCue'.");
      const cues = ensureTrackArray(this, '__zpCues');
      const index = cues.indexOf(cue);
      if (index === -1) throw new DOMException('The cue is not listed in the TextTrack.', 'NotFoundError');
      cues.splice(index, 1);
      defineHidden(cue, '__zpTrack', null);
    }
  }
  Object.defineProperty(TextTrack.prototype, Symbol.toStringTag, { value: 'TextTrack', configurable: true });

  class TextTrackList extends EventTargetBase {
    constructor() { throw new TypeError("Failed to construct 'TextTrackList': Illegal constructor"); }
    get length() { return trackValue(this, '__zpTracks', []).length; }
    item(index) { return trackValue(this, '__zpTracks', [])[Number(index)] ?? null; }
    getTrackById(id) { return trackValue(this, '__zpTracks', []).find((track) => track.id === String(id)) ?? null; }
    [Symbol.iterator]() { return trackValue(this, '__zpTracks', [])[Symbol.iterator](); }
  }
  Object.defineProperty(TextTrackList.prototype, Symbol.toStringTag, { value: 'TextTrackList', configurable: true });

  return { TextTrack, TextTrackCue, TextTrackCueList, TextTrackList, VTTCue };
}

const vttCueToken = {};

function ensureTrackArray(target, key) {
  if (!Object.hasOwn(target, key)) defineHidden(target, key, []);
  return target[key];
}

function refreshIndexes(list) {
  for (let index = 0; index < list.__zpCues.length; index += 1) {
    Object.defineProperty(list, index, { get() { return this.__zpCues[index]; }, configurable: true });
  }
}

function trackValue(target, key, fallback) {
  return Object.hasOwn(target, key) ? target[key] : fallback;
}

function defineHidden(target, key, value) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}
