import { makeStreamEndpoint } from '../streams/basic-streams.mjs';
const textEncoderStreamState = new WeakMap();
const textDecoderStreamState = new WeakMap();

export function createTextEncodingFacades(hostBridge = {}) {
  const textEncoderHandles = new WeakMap();
  const textDecoderState = new WeakMap();
  class TextEncoder {
    constructor() {
      const bridged = hostBridge.construct?.('TextEncoder', Array.from(arguments));
      if (bridged?.handled) textEncoderHandles.set(this, bridged.value.handle || '');
    }
    get encoding() { return 'utf-8'; }
    encode(input = '') {
      const handle = textEncoderHandles.get(this);
      const bridged = handle ? hostBridge.method?.(handle, 'TextEncoder', 'encode', [String(input)]) : null;
      if (bridged?.handled) return new Uint8Array(bridgeBytes(bridged.value));
      return new Uint8Array(encodeUTF8(String(input)));
    }
    encodeInto(source, destination) {
      if (!(destination instanceof Uint8Array)) throw new TypeError("Failed to execute 'encodeInto' on 'TextEncoder': parameter 2 is not of type 'Uint8Array'.");
      const text = String(source === undefined ? '' : source);
      const handle = textEncoderHandles.get(this);
      const bridged = handle ? hostBridge.method?.(handle, 'TextEncoder', 'encodeInto', [text, Array.from(destination)]) : null;
      if (bridged?.handled) {
        copyBridgeBytes(destination, bridgeBytes(bridged.mutatedArgs?.['1']));
        return bridged.value;
      }
      return writeUTF8Into(text, destination);
    }
  }
  Object.defineProperty(TextEncoder.prototype, Symbol.toStringTag, { value: 'TextEncoder', configurable: true });
  Object.defineProperty(TextEncoder, 'name', { value: 'TextEncoder', configurable: true });
  for (const key of ['encoding', 'encode', 'encodeInto']) {
    const descriptor = Object.getOwnPropertyDescriptor(TextEncoder.prototype, key);
    if (descriptor) Object.defineProperty(TextEncoder.prototype, key, { ...descriptor, enumerable: true });
  }

  class TextDecoder {
    constructor(label = 'utf-8', options = {}) {
      const bridged = hostBridge.construct?.('TextDecoder', Array.from(arguments));
      if (bridged?.handled) {
        const fields = bridged.value.fields || {};
        textDecoderState.set(this, {
          handle: bridged.value.handle || '',
          encoding: String(fields.encoding || 'utf-8'),
          fatal: Boolean(fields.fatal),
          ignoreBOM: Boolean(fields.ignoreBOM),
        });
        return;
      }
      const normalized = normalizeEncoding(label);
      if (normalized !== 'utf-8') throw new RangeError("Failed to construct 'TextDecoder': The encoding label provided ('" + label + "') is invalid.");
      textDecoderState.set(this, {
        handle: '',
        encoding: 'utf-8',
        fatal: Boolean(options.fatal),
        ignoreBOM: Boolean(options.ignoreBOM),
      });
    }
    get encoding() { return textDecoderState.get(this)?.encoding || 'utf-8'; }
    get fatal() { return Boolean(textDecoderState.get(this)?.fatal); }
    get ignoreBOM() { return Boolean(textDecoderState.get(this)?.ignoreBOM); }
    decode(input = new Uint8Array(), options = {}) {
      const bytes = bytesFrom(input);
      const state = textDecoderState.get(this) || {};
      const bridged = state.handle ? hostBridge.method?.(state.handle, 'TextDecoder', 'decode', [bytes, options]) : null;
      if (bridged?.handled) return String(bridged.value);
      return decodeUTF8(bytes, this.fatal, this.ignoreBOM);
    }
  }
  Object.defineProperty(TextDecoder.prototype, Symbol.toStringTag, { value: 'TextDecoder', configurable: true });
  Object.defineProperty(TextDecoder, 'name', { value: 'TextDecoder', configurable: true });
  for (const key of ['encoding', 'fatal', 'ignoreBOM', 'decode']) {
    const descriptor = Object.getOwnPropertyDescriptor(TextDecoder.prototype, key);
    if (descriptor) Object.defineProperty(TextDecoder.prototype, key, { ...descriptor, enumerable: true });
  }

  class TextEncoderStream {
    constructor() {
      const transform = makeTextEncoderTransformStream();
      textEncoderStreamState.set(this, { encoding: 'utf-8', readable: transform.readable, writable: transform.writable });
    }
  }
  defineEncodingStreamPrototype(TextEncoderStream, textEncoderStreamState, ['encoding', 'readable', 'writable']);
  Object.defineProperty(TextEncoderStream.prototype, Symbol.toStringTag, { value: 'TextEncoderStream', configurable: true });

  class TextDecoderStream {
    constructor(label = 'utf-8', options = {}) {
      let decoder;
      try {
        decoder = new TextDecoder(label, options);
      } catch (error) {
        if (error instanceof RangeError) throw new RangeError(`Failed to construct 'TextDecoderStream': The encoding label provided ('${label}') is invalid.`);
        throw error;
      }
      const state = {
        encoding: decoder.encoding,
        fatal: decoder.fatal,
        ignoreBOM: decoder.ignoreBOM,
        decoder,
        pending: [],
        bomSeen: false,
        readable: null,
        writable: null,
      };
      const transform = makeTextDecoderTransformStream(state);
      state.readable = transform.readable;
      state.writable = transform.writable;
      textDecoderStreamState.set(this, state);
    }
  }
  defineEncodingStreamPrototype(TextDecoderStream, textDecoderStreamState, ['encoding', 'fatal', 'ignoreBOM', 'readable', 'writable']);
  Object.defineProperty(TextDecoderStream.prototype, Symbol.toStringTag, { value: 'TextDecoderStream', configurable: true });

  return { TextDecoder, TextDecoderStream, TextEncoder, TextEncoderStream };
}

function defineEncodingStreamPrototype(Ctor, stateMap, keys) {
  const constructorDescriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, 'constructor');
  delete Ctor.prototype.constructor;
  for (const key of keys) Object.defineProperty(Ctor.prototype, key, { get() { return encodingStreamValue(stateMap, this, key); }, enumerable: true, configurable: true });
  Object.defineProperty(Ctor.prototype, 'constructor', constructorDescriptor);
}

function encodingStreamValue(stateMap, target, key) {
  const state = stateMap.get(target);
  if (!state) throw new TypeError('Illegal invocation');
  return state[key];
}

function makeTextEncoderTransformStream() {
  if (typeof TransformStream !== 'function') return { readable: makeStreamEndpoint('ReadableStream'), writable: makeStreamEndpoint('WritableStream') };
  const encoder = new TextEncoder();
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(encoder.encode(String(chunk)));
    },
  });
}

function makeTextDecoderTransformStream(state) {
  if (typeof TransformStream !== 'function') return { readable: makeStreamEndpoint('ReadableStream'), writable: makeStreamEndpoint('WritableStream') };
  return new TransformStream({
    transform(chunk, controller) {
      const decoded = decodeTextDecoderStreamChunk(state, bytesFrom(chunk), false);
      if (decoded) controller.enqueue(decoded);
    },
    flush(controller) {
      const decoded = decodeTextDecoderStreamChunk(state, [], true);
      if (decoded) controller.enqueue(decoded);
    },
  });
}

function decodeTextDecoderStreamChunk(state, chunk, flush) {
  if (state.encoding !== 'utf-8') return decodeTextDecoderStreamThroughDecoder(state, chunk, flush);
  return decodeUTF8TextDecoderStreamChunk(state, chunk, flush);
}

function decodeTextDecoderStreamThroughDecoder(state, chunk, flush) {
  const decoded = state.decoder.decode(new Uint8Array(chunk), { stream: !flush });
  if (flush) {
    const suffix = state.decoder.decode(new Uint8Array(), {});
    return decoded + suffix;
  }
  return decoded;
}

function decodeUTF8TextDecoderStreamChunk(state, chunk, flush) {
  const bytes = state.pending.length ? state.pending.concat(chunk) : chunk;
  const completeLength = flush ? bytes.length : completeUTF8PrefixLength(bytes);
  state.pending = bytes.slice(completeLength);
  if (completeLength === 0) return '';
  const ignoreBOM = state.ignoreBOM || state.bomSeen;
  const decoded = decodeUTF8(bytes.slice(0, completeLength), state.fatal, ignoreBOM);
  state.bomSeen = true;
  return decoded;
}

function completeUTF8PrefixLength(bytes) {
  const length = bytes.length;
  const limit = Math.min(3, length);
  for (let tailLength = 1; tailLength <= limit; tailLength += 1) {
    const start = length - tailLength;
    const sequenceLength = utf8SequenceLength(bytes[start]);
    if (sequenceLength > tailLength && hasOnlyContinuationBytes(bytes, start + 1)) return start;
    if (sequenceLength > 1) break;
  }
  return length;
}

function utf8SequenceLength(first) {
  if (first >= 0xc2 && first < 0xe0) return 2;
  if (first >= 0xe0 && first < 0xf0) return 3;
  if (first >= 0xf0 && first < 0xf5) return 4;
  return 1;
}

function hasOnlyContinuationBytes(bytes, start) {
  for (let index = start; index < bytes.length; index += 1) if ((bytes[index] & 0xc0) !== 0x80) return false;
  return true;
}

function bridgeBytes(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.bytes)) return value.bytes;
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value)
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => Number(value[key]) & 255);
}

function copyBridgeBytes(destination, bytes) {
  const limit = Math.min(destination.length, bytes.length);
  for (let index = 0; index < limit; index += 1) destination[index] = bytes[index];
}

function normalizeEncoding(label) {
  return String(label || 'utf-8').trim().toLowerCase().replace(/_/g, '-');
}

function bytesFrom(input) {
  if (input == null) return [];
  if (input instanceof ArrayBuffer) return Array.from(new Uint8Array(input));
  if (ArrayBuffer.isView(input)) return Array.from(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
  return Array.from(input, (value) => Number(value) & 255);
}

function encodeUTF8(text) {
  const out = [];
  for (let index = 0; index < text.length; index += 1) index += pushUTF8CodeUnit(out, text, index);
  return out;
}

function pushUTF8CodeUnit(out, text, index) {
  const code = text.charCodeAt(index);
  if (code < 0x80) { out.push(code); return 0; }
  if (code < 0x800) { out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f)); return 0; }
  if (code >= 0xd800 && code <= 0xdbff) return pushUTF8Surrogate(out, text, index, code);
  if (code >= 0xdc00 && code <= 0xdfff) { pushReplacement(out); return 0; }
  out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  return 0;
}

function pushUTF8Surrogate(out, text, index, code) {
  const low = text.charCodeAt(index + 1);
  if (!(low >= 0xdc00 && low <= 0xdfff)) { pushReplacement(out); return 0; }
  const point = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
  out.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
  return 1;
}

function decodeUTF8(bytes, fatal, ignoreBOM) {
  let out = '';
  for (let index = 0; index < bytes.length;) {
    const decoded = readUTF8CodePoint(bytes, index, fatal);
    out += codePointToString(decoded.point);
    index = decoded.next;
  }
  return !ignoreBOM && out.charCodeAt(0) === 0xfeff ? out.slice(1) : out;
}

function readUTF8CodePoint(bytes, index, fatal) {
  const first = bytes[index];
  if (first < 0x80) return { point: first, next: index + 1 };
  if (first >= 0xc2 && first < 0xe0 && index + 1 < bytes.length) return { point: ((first & 0x1f) << 6) | continuation(bytes[index + 1], fatal), next: index + 2 };
  if (first >= 0xe0 && first < 0xf0 && index + 2 < bytes.length) return { point: ((first & 0x0f) << 12) | (continuation(bytes[index + 1], fatal) << 6) | continuation(bytes[index + 2], fatal), next: index + 3 };
  if (first >= 0xf0 && first < 0xf5 && index + 3 < bytes.length) return { point: ((first & 0x07) << 18) | (continuation(bytes[index + 1], fatal) << 12) | (continuation(bytes[index + 2], fatal) << 6) | continuation(bytes[index + 3], fatal), next: index + 4 };
  if (fatal) throw new TypeError('The encoded data was not valid UTF-8.');
  return { point: -1, next: index + 1 };
}

function codePointToString(point) {
  if (point < 0 || point > 0x10ffff) return '\ufffd';
  if (point <= 0xffff) return String.fromCharCode(point);
  const value = point - 0x10000;
  return String.fromCharCode(0xd800 + (value >> 10), 0xdc00 + (value & 0x3ff));
}

function pushReplacement(out) {
  out.push(0xef, 0xbf, 0xbd);
}

function continuation(value, fatal) {
  if ((value & 0xc0) === 0x80) return value & 0x3f;
  if (fatal) throw new TypeError('The encoded data was not valid UTF-8.');
  return 0x3f;
}

function writeUTF8Into(source, destination) {
  const capacity = Number(destination.length ?? destination.byteLength ?? 0);
  let read = 0;
  let written = 0;
  for (let index = 0; index < source.length;) {
    const bytes = [];
    const consumedCodeUnits = 1 + pushUTF8CodeUnit(bytes, source, index);
    if (written + bytes.length > capacity) break;
    for (let offset = 0; offset < bytes.length; offset += 1) destination[written + offset] = bytes[offset];
    written += bytes.length;
    read += consumedCodeUnits;
    index += consumedCodeUnits;
  }
  return { read, written };
}

