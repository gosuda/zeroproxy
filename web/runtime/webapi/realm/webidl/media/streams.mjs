let nextMediaStreamId = 1;
let nextMediaTrackId = 1;

export function createMediaStreamFacades(EventTargetBase) {
  class MediaStream extends EventTargetBase {
    constructor(tracks = []) {
      super();
      defineHidden(this, '__zpMediaStreamId', 'zp-media-stream-' + nextMediaStreamId++);
      defineHidden(this, '__zpMediaStreamTracks', []);
      for (const track of tracks) addStreamTrack(this, track);
    }
    get id() { return this.__zpMediaStreamId; }
    get active() { return this.__zpMediaStreamTracks.some((track) => track.readyState !== 'ended'); }
    addTrack(track) {
      requireMediaStreamTrack(track, 'addTrack');
      addStreamTrack(this, track);
    }
    clone() { return new MediaStream(this.__zpMediaStreamTracks.map((track) => track.clone())); }
    getAudioTracks() { return this.__zpMediaStreamTracks.filter((track) => track.kind === 'audio'); }
    getTrackById(id) {
      const text = String(id);
      return this.__zpMediaStreamTracks.find((track) => track.id === text) ?? null;
    }
    getTracks() { return this.__zpMediaStreamTracks.slice(); }
    getVideoTracks() { return this.__zpMediaStreamTracks.filter((track) => track.kind === 'video'); }
    removeTrack(track) {
      requireMediaStreamTrack(track, 'removeTrack');
      const index = this.__zpMediaStreamTracks.indexOf(track);
      if (index !== -1) this.__zpMediaStreamTracks.splice(index, 1);
    }
  }
  Object.defineProperty(MediaStream.prototype, Symbol.toStringTag, { value: 'MediaStream', configurable: true });

  class MediaStreamTrack extends EventTargetBase {
    constructor(token) {
      if (token !== mediaStreamTrackToken) throw new TypeError("Failed to construct 'MediaStreamTrack': Illegal constructor");
      super();
      initMediaStreamTrack(this, {});
    }
    get kind() { return mediaTrackValue(this, '__zpKind', ''); }
    get id() { return mediaTrackValue(this, '__zpTrackId', ''); }
    get label() { return mediaTrackValue(this, '__zpLabel', ''); }
    get enabled() { return mediaTrackValue(this, '__zpEnabled', true); }
    set enabled(value) { defineHidden(this, '__zpEnabled', Boolean(value)); }
    get muted() { return mediaTrackValue(this, '__zpMuted', false); }
    get readyState() { return mediaTrackValue(this, '__zpReadyState', 'live'); }
    get contentHint() { return mediaTrackValue(this, '__zpContentHint', ''); }
    set contentHint(value) { defineHidden(this, '__zpContentHint', String(value)); }
    get stats() { return null; }
    applyConstraints() { return Promise.resolve(); }
    clone() { return createVirtualMediaStreamTrack(MediaStreamTrack, { kind: this.kind, label: this.label, enabled: this.enabled, muted: this.muted, readyState: this.readyState, contentHint: this.contentHint }); }
    getCapabilities() { return Object.freeze({}); }
    getConstraints() { return Object.freeze({}); }
    getSettings() { return Object.freeze({}); }
    stop() { defineHidden(this, '__zpReadyState', 'ended'); }
    getCaptureHandle() { return null; }
  }
  Object.defineProperty(MediaStreamTrack.prototype, Symbol.toStringTag, { value: 'MediaStreamTrack', configurable: true });

  function CanvasCaptureMediaStreamTrack() { throw new TypeError("Failed to construct 'CanvasCaptureMediaStreamTrack': Illegal constructor"); }
  Object.setPrototypeOf(CanvasCaptureMediaStreamTrack.prototype, MediaStreamTrack.prototype);
  Object.defineProperty(CanvasCaptureMediaStreamTrack.prototype, 'constructor', { value: CanvasCaptureMediaStreamTrack, writable: true, configurable: true });
  Object.defineProperty(CanvasCaptureMediaStreamTrack.prototype, 'canvas', { get() { return null; }, enumerable: true, configurable: true });
  Object.defineProperty(CanvasCaptureMediaStreamTrack.prototype, 'requestFrame', { value() {}, writable: true, configurable: true });
  Object.defineProperty(CanvasCaptureMediaStreamTrack.prototype, Symbol.toStringTag, { value: 'CanvasCaptureMediaStreamTrack', configurable: true });

  function BrowserCaptureMediaStreamTrack() { throw new TypeError("Failed to construct 'BrowserCaptureMediaStreamTrack': Illegal constructor"); }
  Object.setPrototypeOf(BrowserCaptureMediaStreamTrack.prototype, MediaStreamTrack.prototype);
  Object.defineProperty(BrowserCaptureMediaStreamTrack.prototype, 'constructor', { value: BrowserCaptureMediaStreamTrack, writable: true, configurable: true });
  Object.defineProperty(BrowserCaptureMediaStreamTrack.prototype, 'cropTo', { value() { return Promise.resolve(); }, writable: true, configurable: true });
  Object.defineProperty(BrowserCaptureMediaStreamTrack.prototype, 'restrictTo', { value() { return Promise.resolve(); }, writable: true, configurable: true });
  Object.defineProperty(BrowserCaptureMediaStreamTrack.prototype, Symbol.toStringTag, { value: 'BrowserCaptureMediaStreamTrack', configurable: true });

  function AudioSinkInfo() {
    if (new.target) throw new TypeError("Failed to construct 'AudioSinkInfo': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  delete AudioSinkInfo.prototype.constructor;
  Object.defineProperties(AudioSinkInfo.prototype, {
    type: { get() { return mediaTrackValue(this, '__zpType', 'none'); }, enumerable: true, configurable: true },
    constructor: { value: AudioSinkInfo, writable: true, configurable: true },
  });
  Object.defineProperty(AudioSinkInfo.prototype, Symbol.toStringTag, { value: 'AudioSinkInfo', configurable: true });

  function MediaStreamTrackAudioStats() {
    if (new.target) throw new TypeError("Failed to construct 'MediaStreamTrackAudioStats': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  delete MediaStreamTrackAudioStats.prototype.constructor;
  for (const key of ['deliveredFrames', 'deliveredFramesDuration', 'totalFrames', 'totalFramesDuration', 'latency', 'averageLatency', 'minimumLatency', 'maximumLatency']) {
    Object.defineProperty(MediaStreamTrackAudioStats.prototype, key, { get() { return mediaTrackValue(this, '__zp' + key, 0); }, enumerable: true, configurable: true });
  }
  Object.defineProperties(MediaStreamTrackAudioStats.prototype, {
    resetLatency: { value: function resetLatency() {}, enumerable: true, writable: true, configurable: true },
    toJSON: { value: function toJSON() { return { deliveredFrames: this.deliveredFrames, deliveredFramesDuration: this.deliveredFramesDuration, totalFrames: this.totalFrames, totalFramesDuration: this.totalFramesDuration, latency: this.latency, averageLatency: this.averageLatency, minimumLatency: this.minimumLatency, maximumLatency: this.maximumLatency }; }, enumerable: true, writable: true, configurable: true },
    constructor: { value: MediaStreamTrackAudioStats, writable: true, configurable: true },
  });
  Object.defineProperty(MediaStreamTrackAudioStats.prototype, Symbol.toStringTag, { value: 'MediaStreamTrackAudioStats', configurable: true });

  function MediaStreamTrackVideoStats() {
    if (new.target) throw new TypeError("Failed to construct 'MediaStreamTrackVideoStats': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  delete MediaStreamTrackVideoStats.prototype.constructor;
  for (const key of ['deliveredFrames', 'discardedFrames', 'totalFrames']) {
    Object.defineProperty(MediaStreamTrackVideoStats.prototype, key, { get() { return mediaTrackValue(this, '__zp' + key, 0); }, enumerable: true, configurable: true });
  }
  Object.defineProperties(MediaStreamTrackVideoStats.prototype, {
    toJSON: { value: function toJSON() { return { deliveredFrames: this.deliveredFrames, discardedFrames: this.discardedFrames, totalFrames: this.totalFrames }; }, enumerable: true, writable: true, configurable: true },
    constructor: { value: MediaStreamTrackVideoStats, writable: true, configurable: true },
  });
  Object.defineProperty(MediaStreamTrackVideoStats.prototype, Symbol.toStringTag, { value: 'MediaStreamTrackVideoStats', configurable: true });

  class MediaRecorder extends EventTargetBase {
    constructor(stream = missingMediaRecorderStream, options = {}) {
      if (stream === missingMediaRecorderStream) throw new TypeError("Failed to construct 'MediaRecorder': 1 argument required, but only 0 present.");
      if (!(stream instanceof MediaStream)) throw new TypeError("Failed to construct 'MediaRecorder': parameter 1 is not of type 'MediaStream'.");
      const mimeType = String(options.mimeType ?? '');
      if (!MediaRecorder.isTypeSupported(mimeType)) throw new DOMException("Failed to construct 'MediaRecorder': The MIME type provided ('" + mimeType + "') is not supported.", 'NotSupportedError');
      super();
      defineHidden(this, '__zpRecorderStream', stream);
      defineHidden(this, '__zpRecorderMimeType', mimeType);
      defineHidden(this, '__zpRecorderState', 'inactive');
      defineHidden(this, '__zpRecorderVideoBitsPerSecond', Number(options.videoBitsPerSecond ?? 0) || 0);
      defineHidden(this, '__zpRecorderAudioBitsPerSecond', Number(options.audioBitsPerSecond ?? 0) || 0);
      defineHidden(this, '__zpRecorderAudioBitrateMode', String(options.audioBitrateMode ?? 'variable'));
    }
    static isTypeSupported(type) {
      const text = String(type);
      return text === '' || /^audio\/(webm|ogg|mp4)/i.test(text) || /^video\/(webm|mp4)/i.test(text);
    }
    get stream() { return this.__zpRecorderStream; }
    get mimeType() { return this.__zpRecorderMimeType; }
    get state() { return this.__zpRecorderState; }
    get videoBitsPerSecond() { return this.__zpRecorderVideoBitsPerSecond; }
    get audioBitsPerSecond() { return this.__zpRecorderAudioBitsPerSecond; }
    get audioBitrateMode() { return this.__zpRecorderAudioBitrateMode; }
    start() {
      if (this.__zpRecorderState !== 'inactive') throw invalidRecorderState('start', this.__zpRecorderState);
      defineHidden(this, '__zpRecorderState', 'recording');
      queueRecorderEvent(this, 'start');
    }
    stop() {
      if (this.__zpRecorderState === 'inactive') throw invalidRecorderState('stop', this.__zpRecorderState);
      defineHidden(this, '__zpRecorderState', 'inactive');
      queueRecorderData(this);
      queueRecorderEvent(this, 'stop');
    }
    pause() {
      if (this.__zpRecorderState === 'inactive') throw invalidRecorderState('pause', this.__zpRecorderState);
      if (this.__zpRecorderState === 'recording') {
        defineHidden(this, '__zpRecorderState', 'paused');
        queueRecorderEvent(this, 'pause');
      }
    }
    resume() {
      if (this.__zpRecorderState === 'inactive') throw invalidRecorderState('resume', this.__zpRecorderState);
      if (this.__zpRecorderState === 'paused') {
        defineHidden(this, '__zpRecorderState', 'recording');
        queueRecorderEvent(this, 'resume');
      }
    }
    requestData() {
      if (this.__zpRecorderState === 'inactive') throw invalidRecorderState('requestData', this.__zpRecorderState);
      queueRecorderData(this);
    }
  }
  Object.defineProperty(MediaRecorder.prototype, Symbol.toStringTag, { value: 'MediaRecorder', configurable: true });
  for (const key of ['onstart', 'onstop', 'ondataavailable', 'onpause', 'onresume', 'onerror']) {
    Object.defineProperty(MediaRecorder.prototype, key, { value: null, writable: true, configurable: true });
  }

  return { MediaStream, MediaStreamTrack, CanvasCaptureMediaStreamTrack, BrowserCaptureMediaStreamTrack, AudioSinkInfo, MediaStreamTrackAudioStats, MediaStreamTrackVideoStats, MediaRecorder, createVirtualMediaStreamTrack: (init) => createVirtualMediaStreamTrack(MediaStreamTrack, init) };
}

const mediaStreamTrackToken = {};

const missingMediaRecorderStream = {};

function invalidRecorderState(method, state) {
  return new DOMException("Failed to execute '" + method + "' on 'MediaRecorder': The MediaRecorder's state is '" + state + "'.", 'InvalidStateError');
}

function queueRecorderEvent(recorder, type) {
  Promise.resolve().then(() => {
    recorder.dispatchEvent(new Event(type));
  });
}

function queueRecorderData(recorder) {
  Promise.resolve().then(() => {
    const blob = new Blob([], { type: recorder.mimeType });
    recorder.dispatchEvent(new BlobEvent('dataavailable', { data: blob }));
  });
}
function createVirtualMediaStreamTrack(MediaStreamTrack, init = {}) {
  const track = new MediaStreamTrack(mediaStreamTrackToken);
  initMediaStreamTrack(track, init);
  return track;
}

function initMediaStreamTrack(track, init) {
  defineHidden(track, '__zpKind', String(init.kind ?? ''));
  defineHidden(track, '__zpTrackId', String(init.id ?? 'zp-media-track-' + nextMediaTrackId++));
  defineHidden(track, '__zpLabel', String(init.label ?? ''));
  defineHidden(track, '__zpEnabled', init.enabled === undefined ? true : Boolean(init.enabled));
  defineHidden(track, '__zpMuted', Boolean(init.muted));
  defineHidden(track, '__zpReadyState', String(init.readyState ?? 'live'));
  defineHidden(track, '__zpContentHint', String(init.contentHint ?? ''));
}

function addStreamTrack(stream, track) {
  requireMediaStreamTrack(track, 'addTrack');
  if (!stream.__zpMediaStreamTracks.includes(track)) stream.__zpMediaStreamTracks.push(track);
}

function requireMediaStreamTrack(track, method) {
  if (!(track instanceof globalThis.MediaStreamTrack)) throw new TypeError("Failed to execute '" + method + "' on 'MediaStream': parameter 1 is not of type 'MediaStreamTrack'.");
}

function mediaTrackValue(target, key, fallback) {
  return Object.hasOwn(target, key) ? target[key] : fallback;
}

function defineHidden(target, key, value) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}
