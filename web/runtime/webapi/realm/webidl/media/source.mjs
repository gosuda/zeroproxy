const mediaSourceToken = {};
const sourceBufferToken = {};
const sourceBufferListToken = {};
const timeRangesToken = {};

export function createMediaSourceFacades(EventTargetBase) {
  class TimeRanges {
    constructor(token, ranges = []) {
      if (token !== timeRangesToken) throw new TypeError("Failed to construct 'TimeRanges': Illegal constructor");
      defineHidden(this, '__zpRanges', ranges.map((range) => [Number(range[0]) || 0, Number(range[1]) || 0]));
    }
    get length() { return this.__zpRanges.length; }
    start(index) { return rangeBoundary(this, index, 0); }
    end(index) { return rangeBoundary(this, index, 1); }
  }
  Object.defineProperty(TimeRanges.prototype, Symbol.toStringTag, { value: 'TimeRanges', configurable: true });

  class SourceBuffer extends EventTargetBase {
    constructor(token, mediaSource, mimeType) {
      if (token !== sourceBufferToken) throw new TypeError("Failed to construct 'SourceBuffer': Illegal constructor");
      super();
      defineHidden(this, '__zpMediaSource', mediaSource);
      defineHidden(this, '__zpMimeType', String(mimeType || ''));
      defineHidden(this, '__zpMode', 'segments');
      defineHidden(this, '__zpUpdating', false);
      defineHidden(this, '__zpTimestampOffset', 0);
      defineHidden(this, '__zpAppendWindowStart', 0);
      defineHidden(this, '__zpAppendWindowEnd', Infinity);
      defineHidden(this, '__zpBuffered', new TimeRanges(timeRangesToken));
      defineHidden(this, '__zpAudioTracks', []);
      defineHidden(this, '__zpVideoTracks', []);
      defineHidden(this, '__zpTextTracks', []);
    }
    get mode() { return this.__zpMode; }
    set mode(value) { defineHidden(this, '__zpMode', String(value)); }
    get updating() { return this.__zpUpdating; }
    get buffered() { return this.__zpBuffered; }
    get timestampOffset() { return this.__zpTimestampOffset; }
    set timestampOffset(value) { defineHidden(this, '__zpTimestampOffset', Number(value) || 0); }
    get audioTracks() { return this.__zpAudioTracks; }
    get videoTracks() { return this.__zpVideoTracks; }
    get textTracks() { return this.__zpTextTracks; }
    get appendWindowStart() { return this.__zpAppendWindowStart; }
    set appendWindowStart(value) { defineHidden(this, '__zpAppendWindowStart', Number(value) || 0); }
    get appendWindowEnd() { return this.__zpAppendWindowEnd; }
    set appendWindowEnd(value) { defineHidden(this, '__zpAppendWindowEnd', Number(value)); }
    appendBuffer() { dispatchSourceBufferUpdate(this); }
    appendBufferAsync(data) { this.appendBuffer(data); return Promise.resolve(); }
    remove() { dispatchSourceBufferUpdate(this); }
    removeAsync(start, end) { this.remove(start, end); return Promise.resolve(); }
    abort() { defineHidden(this, '__zpUpdating', false); }
    changeType(type) { defineHidden(this, '__zpMimeType', String(type)); }
  }
  Object.defineProperty(SourceBuffer.prototype, Symbol.toStringTag, { value: 'SourceBuffer', configurable: true });

  class SourceBufferList extends EventTargetBase {
    constructor(token, buffers = []) {
      if (token !== sourceBufferListToken) throw new TypeError("Failed to construct 'SourceBufferList': Illegal constructor");
      super();
      defineHidden(this, '__zpBuffers', buffers);
      refreshIndexes(this);
    }
    get length() { return this.__zpBuffers.length; }
    item(index) { return this.__zpBuffers[Number(index)] ?? null; }
    [Symbol.iterator]() { return this.__zpBuffers[Symbol.iterator](); }
  }
  Object.defineProperty(SourceBufferList.prototype, Symbol.toStringTag, { value: 'SourceBufferList', configurable: true });

  class MediaSource extends EventTargetBase {
    constructor() {
      super();
      defineHidden(this, '__zpReadyState', 'closed');
      defineHidden(this, '__zpDuration', Number.NaN);
      defineHidden(this, '__zpBuffers', []);
      defineHidden(this, '__zpHandle', new MediaSourceHandle(mediaSourceToken));
      defineHidden(this, '__zpLiveSeekableRange', null);
    }
    static isTypeSupported(type) { return mediaTypeSupported(type); }
    get sourceBuffers() { return new SourceBufferList(sourceBufferListToken, this.__zpBuffers); }
    get activeSourceBuffers() { return new SourceBufferList(sourceBufferListToken, this.__zpBuffers); }
    get readyState() { return this.__zpReadyState; }
    get duration() { return this.__zpDuration; }
    set duration(value) { defineHidden(this, '__zpDuration', Number(value)); }
    get handle() { return this.__zpHandle; }
    addSourceBuffer(type) {
      if (!mediaTypeSupported(type)) throw new DOMException('The type provided is unsupported.', 'NotSupportedError');
      const buffer = new SourceBuffer(sourceBufferToken, this, type);
      this.__zpBuffers.push(buffer);
      return buffer;
    }
    removeSourceBuffer(buffer) {
      const index = this.__zpBuffers.indexOf(buffer);
      if (index === -1) throw new DOMException('The SourceBuffer was not found in this MediaSource.', 'NotFoundError');
      this.__zpBuffers.splice(index, 1);
    }
    endOfStream() { defineHidden(this, '__zpReadyState', 'ended'); }
    setLiveSeekableRange(start, end) {
      const range = liveSeekableRange(start, end);
      defineHidden(this, '__zpLiveSeekableRange', range);
    }
    clearLiveSeekableRange() {
      defineHidden(this, '__zpLiveSeekableRange', null);
    }
  }
  Object.defineProperty(MediaSource.prototype, Symbol.toStringTag, { value: 'MediaSource', configurable: true });

  class MediaSourceHandle {
    constructor(token) {
      if (token !== mediaSourceToken) throw new TypeError("Failed to construct 'MediaSourceHandle': Illegal constructor");
    }
  }
  Object.defineProperty(MediaSourceHandle.prototype, Symbol.toStringTag, { value: 'MediaSourceHandle', configurable: true });

  return { MediaSource, MediaSourceHandle, SourceBuffer, SourceBufferList, TimeRanges };
}

function mediaTypeSupported(type) {
  const text = String(type || '').toLowerCase();
  return text === '' || text.startsWith('video/mp4') || text.startsWith('audio/mp4') || text.startsWith('video/webm') || text.startsWith('audio/webm');
}

function dispatchSourceBufferUpdate(buffer) {
  defineHidden(buffer, '__zpUpdating', true);
  buffer.dispatchEvent(new Event('updatestart'));
  defineHidden(buffer, '__zpUpdating', false);
  buffer.dispatchEvent(new Event('update'));
  buffer.dispatchEvent(new Event('updateend'));
}

function liveSeekableRange(start, end) {
  const startTime = Number(start);
  const endTime = Number(end);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime < startTime) {
    throw new DOMException('The live seekable range is not valid.', 'InvalidAccessError');
  }
  return [startTime, endTime];
}

function rangeBoundary(ranges, index, side) {
  const range = ranges.__zpRanges[Number(index)];
  if (!range) throw new DOMException('The index is not in the allowed range.', 'IndexSizeError');
  return range[side];
}

function refreshIndexes(list) {
  for (let index = 0; index < list.__zpBuffers.length; index += 1) {
    Object.defineProperty(list, index, { get() { return this.__zpBuffers[index]; }, configurable: true });
  }
}

function defineHidden(target, key, value) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}
