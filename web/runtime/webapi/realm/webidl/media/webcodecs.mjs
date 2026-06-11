const encodedChunkState = new WeakMap();
const videoColorSpaceState = new WeakMap();

export function createWebCodecsFacades() {
  class EncodedAudioChunk {
    constructor(init) { initEncodedChunk(this, 'EncodedAudioChunk', 'EncodedAudioChunkType', init, ['key', 'delta']); }
  }
  defineEncodedChunkPrototype(EncodedAudioChunk, 'EncodedAudioChunk', ['type', 'timestamp', 'byteLength', 'duration']);

  class EncodedVideoChunk {
    constructor(init) { initEncodedChunk(this, 'EncodedVideoChunk', 'EncodedVideoChunkType', init, ['key', 'delta']); }
  }
  defineEncodedChunkPrototype(EncodedVideoChunk, 'EncodedVideoChunk', ['type', 'timestamp', 'duration', 'byteLength']);

  class AudioData {
    constructor(init) {
      if (!init || typeof init !== 'object') throw new TypeError("Failed to construct 'AudioData': 1 argument required, but only 0 present.");
      defineHidden(this, '__zpFormat', String(init.format ?? 'f32'));
      defineHidden(this, '__zpSampleRate', Number(init.sampleRate ?? 0) || 0);
      defineHidden(this, '__zpNumberOfFrames', Number(init.numberOfFrames ?? 0) || 0);
      defineHidden(this, '__zpNumberOfChannels', Number(init.numberOfChannels ?? 0) || 0);
      defineHidden(this, '__zpDuration', nullableNumber(init.duration));
      defineHidden(this, '__zpTimestamp', Number(init.timestamp ?? 0) || 0);
      defineHidden(this, '__zpData', bytesFrom(init.data));
      defineHidden(this, '__zpClosed', false);
    }
    get format() { return closedValue(this, this.__zpFormat, null); }
    get sampleRate() { return closedValue(this, this.__zpSampleRate, 0); }
    get numberOfFrames() { return closedValue(this, this.__zpNumberOfFrames, 0); }
    get numberOfChannels() { return closedValue(this, this.__zpNumberOfChannels, 0); }
    get duration() { return closedValue(this, this.__zpDuration, null); }
    get timestamp() { return closedValue(this, this.__zpTimestamp, 0); }
    allocationSize(options) { void options; return this.__zpClosed ? 0 : this.__zpData.byteLength; }
    copyTo(destination, options) { void options; if (!this.__zpClosed) copyBytes(this.__zpData, destination); }
    clone() { return new AudioData({ format: this.format, sampleRate: this.sampleRate, numberOfFrames: this.numberOfFrames, numberOfChannels: this.numberOfChannels, duration: this.duration, timestamp: this.timestamp, data: this.__zpData }); }
    close() { defineHidden(this, '__zpClosed', true); }
  }
  Object.defineProperty(AudioData.prototype, Symbol.toStringTag, { value: 'AudioData', configurable: true });

  class VideoColorSpace {
    constructor(init = {}) {
      initVideoColorSpace(this, init);
    }
  }
  defineVideoColorSpacePrototype(VideoColorSpace);

  class VideoFrame {
    constructor(source, init = {}) {
      if (source === undefined) throw new TypeError("Failed to construct 'VideoFrame': 1 argument required, but only 0 present.");
      const width = frameSourceDimension(init.codedWidth, source.width);
      const height = frameSourceDimension(init.codedHeight, source.height);
      defineHidden(this, '__zpFormat', init.format ?? null);
      defineHidden(this, '__zpCodedWidth', width);
      defineHidden(this, '__zpCodedHeight', height);
      defineHidden(this, '__zpDisplayWidth', frameSourceDimension(init.displayWidth, width));
      defineHidden(this, '__zpDisplayHeight', frameSourceDimension(init.displayHeight, height));
      defineHidden(this, '__zpDuration', nullableNumber(init.duration));
      defineHidden(this, '__zpTimestamp', Number(init.timestamp ?? 0) || 0);
      defineHidden(this, '__zpColorSpace', videoColorSpaceFrom(init.colorSpace, VideoColorSpace));
      defineHidden(this, '__zpClosed', false);
    }
    get format() { return closedValue(this, this.__zpFormat, null); }
    get codedWidth() { return closedValue(this, this.__zpCodedWidth, 0); }
    get codedHeight() { return closedValue(this, this.__zpCodedHeight, 0); }
    get displayWidth() { return closedValue(this, this.__zpDisplayWidth, 0); }
    get displayHeight() { return closedValue(this, this.__zpDisplayHeight, 0); }
    get duration() { return closedValue(this, this.__zpDuration, null); }
    get timestamp() { return closedValue(this, this.__zpTimestamp, 0); }
    get colorSpace() { return this.__zpColorSpace; }
    allocationSize() { return this.__zpClosed ? 0 : this.__zpCodedWidth * this.__zpCodedHeight * 4; }
    copyTo(destination) { if (!this.__zpClosed) copyBytes(new Uint8Array(this.allocationSize()), destination); }
    clone() { return new VideoFrame({ width: this.codedWidth, height: this.codedHeight }, { format: this.format, duration: this.duration, timestamp: this.timestamp, colorSpace: this.colorSpace }); }
    close() { defineHidden(this, '__zpClosed', true); }
  }
  Object.defineProperty(VideoFrame.prototype, Symbol.toStringTag, { value: 'VideoFrame', configurable: true });

  return { AudioData, EncodedAudioChunk, EncodedVideoChunk, VideoColorSpace, VideoFrame };
}
function frameSourceDimension(value, fallback) {
  return Math.max(0, Math.floor(Number(value ?? fallback ?? 0) || 0));
}

function videoColorSpaceFrom(value, VideoColorSpace) {
  return value instanceof VideoColorSpace ? value : new VideoColorSpace(value || {});
}


function defineEncodedChunkPrototype(Ctor, tag, keys) {
  const constructorDescriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, 'constructor');
  delete Ctor.prototype.constructor;
  for (const key of keys) Object.defineProperty(Ctor.prototype, key, { get() { return encodedChunkValue(this, key); }, enumerable: true, configurable: true });
  Object.defineProperty(Ctor.prototype, 'copyTo', { value: function copyTo(destination) { copyEncodedChunkTo(this, tag, destination); }, enumerable: true, configurable: true, writable: true });
  Object.defineProperty(Ctor.prototype, 'constructor', constructorDescriptor);
  Object.defineProperty(Ctor.prototype, Symbol.toStringTag, { value: tag, configurable: true });
}

const videoColorPrimaries = new Set(['bt709', 'bt470bg', 'smpte170m', 'bt2020', 'smpte432']);
const videoTransferCharacteristics = new Set(['bt709', 'smpte170m', 'iec61966-2-1', 'linear', 'pq', 'hlg']);
const videoMatrixCoefficients = new Set(['rgb', 'bt709', 'bt470bg', 'smpte170m', 'bt2020-ncl']);

function defineVideoColorSpacePrototype(Ctor) {
  const constructorDescriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, 'constructor');
  delete Ctor.prototype.constructor;
  for (const key of ['primaries', 'transfer', 'matrix', 'fullRange']) Object.defineProperty(Ctor.prototype, key, { get() { return videoColorSpaceValue(this, key); }, enumerable: true, configurable: true });
  Object.defineProperty(Ctor.prototype, 'toJSON', { value: function toJSON() { return { fullRange: this.fullRange, matrix: this.matrix, primaries: this.primaries, transfer: this.transfer }; }, enumerable: true, configurable: true, writable: true });
  Object.defineProperty(Ctor.prototype, 'constructor', constructorDescriptor);
  Object.defineProperty(Ctor.prototype, Symbol.toStringTag, { value: 'VideoColorSpace', configurable: true });
}

function initVideoColorSpace(target, init) {
  if (init === null || (typeof init !== 'object' && typeof init !== 'function')) throw new TypeError("Failed to construct 'VideoColorSpace': The provided value is not of type 'VideoColorSpaceInit'.");
  videoColorSpaceState.set(target, {
    primaries: nullableEnum(init.primaries, videoColorPrimaries, 'VideoColorSpace', 'VideoColorSpaceInit', 'primaries', 'VideoColorPrimaries'),
    transfer: nullableEnum(init.transfer, videoTransferCharacteristics, 'VideoColorSpace', 'VideoColorSpaceInit', 'transfer', 'VideoTransferCharacteristics'),
    matrix: nullableEnum(init.matrix, videoMatrixCoefficients, 'VideoColorSpace', 'VideoColorSpaceInit', 'matrix', 'VideoMatrixCoefficients'),
    fullRange: init.fullRange === undefined ? null : init.fullRange === null ? null : Boolean(init.fullRange),
  });
}

function nullableEnum(value, validValues, constructorName, initName, memberName, enumName) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (!validValues.has(text)) throw new TypeError(`Failed to construct '${constructorName}': Failed to read the '${memberName}' property from '${initName}': The provided value '${text}' is not a valid enum value of type ${enumName}.`);
  return text;
}

function videoColorSpaceValue(target, key) {
  const state = videoColorSpaceState.get(target);
  if (!state) throw new TypeError('Illegal invocation');
  return state[key];
}

function initEncodedChunk(target, name, enumName, init, validTypes) {
  if (!init || typeof init !== 'object') throw new TypeError(`Failed to construct '${name}': The provided value is not of type '${name}Init'.`);
  if (init.timestamp === undefined) throw new TypeError(`Failed to construct '${name}': Failed to read the 'timestamp' property from '${name}Init': Required member is undefined.`);
  if (init.data === undefined) throw new TypeError(`Failed to construct '${name}': Failed to read the 'data' property from '${name}Init': Required member is undefined.`);
  const type = String(init.type ?? '');
  if (!validTypes.includes(type)) throw new TypeError(`Failed to construct '${name}': Failed to read the 'type' property from '${name}Init': The provided value '${type}' is not a valid enum value of type ${enumName}.`);
  encodedChunkState.set(target, {
    type,
    timestamp: Number(init.timestamp),
    duration: nullableNumber(init.duration),
    data: bytesFromRequired(name, init.data),
  });
}

function encodedChunkValue(target, key) {
  const state = encodedChunkState.get(target);
  if (!state) throw new TypeError('Illegal invocation');
  return key === 'byteLength' ? state.data.byteLength : state[key];
}

function copyEncodedChunkTo(target, name, destination) {
  if (arguments.length < 3) throw new TypeError(`Failed to execute 'copyTo' on '${name}': 1 argument required, but only 0 present.`);
  const state = encodedChunkState.get(target);
  if (!state) throw new TypeError('Illegal invocation');
  copyBytes(state.data, destination, name);
}

function bytesFromRequired(name, data) {
  if (data === null || data === undefined || (typeof data !== 'object' && typeof data !== 'function')) throw new TypeError(`Failed to construct '${name}': Failed to read the 'data' property from '${name}Init': The provided value is not of type '([AllowShared] ArrayBuffer or [AllowShared] ArrayBufferView)'.`);
  return bytesFrom(data);
}

function bytesFrom(data) {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  throw new TypeError("The provided value is not of type '([AllowShared] ArrayBuffer or [AllowShared] ArrayBufferView)'.");
}

function copyBytes(source, destination, name = 'EncodedAudioChunk') {
  if (destination === undefined) throw new TypeError(`Failed to execute 'copyTo' on '${name}': 1 argument required, but only 0 present.`);
  const target = ArrayBuffer.isView(destination) ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength) : new Uint8Array(destination);
  if (target.byteLength < source.byteLength) throw new TypeError(`Failed to execute 'copyTo' on '${name}': destination is not large enough.`);
  target.set(source);
}

function nullableNumber(value) {
  return value === undefined || value === null ? null : Number(value);
}

function closedValue(owner, value, fallback) {
  return owner.__zpClosed ? fallback : value;
}

function defineHidden(target, key, value) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}
