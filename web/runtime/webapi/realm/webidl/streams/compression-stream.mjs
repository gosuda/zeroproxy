import { makeStreamEndpoint } from './basic-streams.mjs';
const supportedFormats = new Set(['deflate', 'deflate-raw', 'gzip']);
const compressionStreamSlots = new WeakMap();

export class CompressionStream {
  constructor(format) {
    installCompressionStreamSlots(this, 'CompressionStream', format, arguments.length);
  }
}
Object.defineProperties(CompressionStream.prototype, {
  readable: { get() { return compressionStreamState(this).readable; }, enumerable: true, configurable: true },
  writable: { get() { return compressionStreamState(this).writable; }, enumerable: true, configurable: true },
});
Object.defineProperty(CompressionStream.prototype, Symbol.toStringTag, { value: 'CompressionStream', configurable: true });

export class DecompressionStream {
  constructor(format) {
    installCompressionStreamSlots(this, 'DecompressionStream', format, arguments.length);
  }
}
Object.defineProperty(DecompressionStream.prototype, Symbol.toStringTag, { value: 'DecompressionStream', configurable: true });
Object.defineProperties(DecompressionStream.prototype, {
  readable: { get() { return compressionStreamState(this).readable; }, enumerable: true, configurable: true },
  writable: { get() { return compressionStreamState(this).writable; }, enumerable: true, configurable: true },
});

function installCompressionStreamSlots(target, name, format, argumentCount) {
  if (argumentCount < 1) throw new TypeError(`Failed to construct '${name}': 1 argument required, but only 0 present.`);
  const normalized = String(format);
  if (!supportedFormats.has(normalized)) throw new TypeError(`Failed to construct '${name}': The provided value '${normalized}' is not a valid enum value of type CompressionFormat.`);
  compressionStreamSlots.set(target, {
    format: normalized,
    readable: makeStreamEndpoint('ReadableStream'),
    writable: makeStreamEndpoint('WritableStream'),
  });
}

function compressionStreamState(stream) {
  const state = compressionStreamSlots.get(stream);
  if (!state) throw new TypeError('Illegal invocation');
  return state;
}

