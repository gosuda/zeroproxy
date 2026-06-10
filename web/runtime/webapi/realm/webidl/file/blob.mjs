const blobSlots = new WeakMap();
const fileSlots = new WeakMap();

export function Blob(parts = [], options = {}) {
  if (!new.target) throw new TypeError("Failed to construct 'Blob': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
  const bytes = collectBlobParts(arguments.length === 0 ? [] : parts, 'Blob');
  return createBlobObject(Blob.prototype, bytes, normalizeBlobType(dictionary(options).type));
}
Object.defineProperty(Blob, 'name', { value: 'Blob', configurable: true });

const blobConstructorDescriptor = Object.getOwnPropertyDescriptor(Blob.prototype, 'constructor');
delete Blob.prototype.constructor;
Object.defineProperties(Blob.prototype, {
  size: { get() { return blobState(this).bytes.length; }, enumerable: true, configurable: true },
  type: { get() { return blobState(this).type; }, enumerable: true, configurable: true },
  arrayBuffer: { value: async function arrayBuffer() { return bytesToArrayBuffer(blobState(this).bytes); }, enumerable: true, writable: true, configurable: true },
  slice: { value: function slice(start = 0, end = this.size, type = '') {
    const state = blobState(this);
    const from = normalizeSliceIndex(start, state.bytes.length);
    const to = normalizeSliceIndex(end, state.bytes.length);
    return createBlobObject(Blob.prototype, to < from ? [] : state.bytes.slice(from, to), normalizeBlobType(type));
  }, enumerable: true, writable: true, configurable: true },
  stream: { value: function stream() { return createReadableStream(blobState(this).bytes); }, enumerable: true, writable: true, configurable: true },
  text: { value: async function text() { return decodeUTF8(blobState(this).bytes); }, enumerable: true, writable: true, configurable: true },
  bytes: { value: async function bytes() { return new Uint8Array(blobState(this).bytes); }, enumerable: true, writable: true, configurable: true },
  constructor: { ...blobConstructorDescriptor, value: Blob },
});
Object.defineProperty(Blob.prototype, Symbol.toStringTag, { value: 'Blob', configurable: true });

export function File(parts, name, options = {}) {
  if (!new.target) throw new TypeError("Failed to construct 'File': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
  if (arguments.length < 2) throw new TypeError(`Failed to construct 'File': 2 arguments required, but only ${arguments.length} present.`);
  const optionsRecord = dictionary(options);
  const lastModifiedValue = Object.prototype.hasOwnProperty.call(optionsRecord, 'lastModified') ? Number(optionsRecord.lastModified) : Date.now();
  const fileData = {
    name: String(name),
    lastModified: Number.isFinite(lastModifiedValue) ? Math.trunc(lastModifiedValue) : 0,
    webkitRelativePath: '',
  };
  const bytes = collectBlobParts(parts, 'File');
  return createBlobObject(File.prototype, bytes, normalizeBlobType(optionsRecord.type), fileData);
}
Object.defineProperty(File, 'name', { value: 'File', configurable: true });
Object.setPrototypeOf(File.prototype, Blob.prototype);
const fileConstructorDescriptor = Object.getOwnPropertyDescriptor(File.prototype, 'constructor');
delete File.prototype.constructor;
Object.defineProperties(File.prototype, {
  name: { get() { return fileState(this).name; }, enumerable: true, configurable: true },
  lastModified: { get() { return fileState(this).lastModified; }, enumerable: true, configurable: true },
  lastModifiedDate: { get() { return new Date(fileState(this).lastModified); }, enumerable: true, configurable: true },
  webkitRelativePath: { get() { return fileState(this).webkitRelativePath; }, enumerable: true, configurable: true },
  constructor: { ...fileConstructorDescriptor, value: File },
});
Object.defineProperty(File.prototype, Symbol.toStringTag, { value: 'File', configurable: true });

const fileListSlots = new WeakMap();

export function FileList() { throw new TypeError("Failed to construct 'FileList': Illegal constructor"); }
Object.defineProperty(FileList, 'name', { value: 'FileList', configurable: true });
const fileListConstructorDescriptor = Object.getOwnPropertyDescriptor(FileList.prototype, 'constructor');
delete FileList.prototype.constructor;
Object.defineProperties(FileList.prototype, {
  length: { get() { return fileListItems(this).length; }, enumerable: true, configurable: true },
  item: { value: function item(index) { return fileListItems(this)[Number(index)] || null; }, enumerable: true, writable: true, configurable: true },
  constructor: { ...fileListConstructorDescriptor, value: FileList },
});
Object.defineProperty(FileList.prototype, Symbol.iterator, { value: Array.prototype.values, writable: true, configurable: true });
Object.defineProperty(FileList.prototype, Symbol.toStringTag, { value: 'FileList', configurable: true });

export function makeFileList(files) {
  const items = [...(files || [])];
  const list = Object.create(FileList.prototype);
  fileListSlots.set(list, items);
  for (let index = 0; index < items.length; index += 1) {
    Object.defineProperty(list, index, { value: items[index] || null, enumerable: true, configurable: true });
  }
  return list;
}

function fileListItems(list) {
  const items = fileListSlots.get(list);
  if (!items) throw new TypeError('Illegal invocation');
  return items;
}

class BlobReadableStream {
  constructor(bytes) { this.__zpChunk = new Uint8Array(bytes); }
  getReader() { return new BlobStreamReader(this.__zpChunk); }
  async *[Symbol.asyncIterator]() { yield new Uint8Array(this.__zpChunk); }
}
Object.defineProperty(BlobReadableStream.prototype, Symbol.toStringTag, { value: 'ReadableStream', configurable: true });

class BlobStreamReader {
  constructor(chunk) { this.__zpChunk = chunk; this.__zpDone = false; }
  async read() {
    if (this.__zpDone) return { value: undefined, done: true };
    this.__zpDone = true;
    return { value: new Uint8Array(this.__zpChunk), done: false };
  }
  async cancel() { this.__zpDone = true; }
  releaseLock() {}
}

function createBlobObject(prototype, bytes, type, fileData = null) {
  const target = Object.create(prototype);
  const proxy = new Proxy(target, {
    get(inner, property, receiver) {
      if (property === '__zpBytes') return blobState(receiver).bytes;
      return Reflect.get(inner, property, receiver);
    },
    getOwnPropertyDescriptor(inner, property) {
      if (property === '__zpBytes') return undefined;
      return Reflect.getOwnPropertyDescriptor(inner, property);
    },
    has(inner, property) {
      if (property === '__zpBytes') return false;
      return Reflect.has(inner, property);
    },
    ownKeys(inner) { return Reflect.ownKeys(inner); },
  });
  blobSlots.set(proxy, { bytes, type });
  if (fileData) fileSlots.set(proxy, fileData);
  return proxy;
}

function blobState(blob) {
  const state = blobSlots.get(blob);
  if (!state) throw new TypeError('Illegal invocation');
  return state;
}

function fileState(file) {
  const state = fileSlots.get(file);
  if (!state) throw new TypeError('Illegal invocation');
  return state;
}

function createReadableStream(bytes) {
  const chunk = new Uint8Array(bytes);
  if (typeof globalThis.ReadableStream === 'function') {
    return new globalThis.ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
  }
  return new BlobReadableStream(chunk);
}

function collectBlobParts(parts, constructorName) {
  const sequence = blobPartSequence(parts, constructorName);
  const bytes = [];
  for (const part of sequence) appendBlobPart(bytes, part);
  return bytes;
}

function blobPartSequence(parts, constructorName) {
  if (parts === undefined) return [];
  if (parts === null || typeof parts[Symbol.iterator] !== 'function') throw new TypeError(`Failed to construct '${constructorName}': The provided value cannot be converted to a sequence.`);
  return parts;
}

function appendBlobPart(out, part) {
  if (part instanceof Blob) { out.push(...blobState(part).bytes); return; }
  if (part instanceof ArrayBuffer) { out.push(...new Uint8Array(part)); return; }
  if (ArrayBuffer.isView(part)) { out.push(...new Uint8Array(part.buffer, part.byteOffset, part.byteLength)); return; }
  out.push(...encodeUTF8(String(part)));
}

function dictionary(value) {
  if (value === null || value === undefined) return {};
  return Object(value);
}

function normalizeBlobType(type) {
  const text = String(type || '');
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return '';
  }
  return text.toLowerCase();
}

function normalizeSliceIndex(value, size) {
  const index = Number(value);
  if (!Number.isFinite(index)) return 0;
  if (index < 0) return Math.max(size + index, 0);
  return Math.min(index, size);
}

function bytesToArrayBuffer(bytes) {
  const out = new ArrayBuffer(bytes.length);
  const view = new Uint8Array(out);
  for (let i = 0; i < bytes.length; i += 1) view[i] = bytes[i] & 255;
  return out;
}

function encodeUTF8(text) {
  const out = [];
  for (let index = 0; index < text.length; index += 1) index += appendUTF8CodeUnit(out, text, index);
  return out;
}

function appendUTF8CodeUnit(out, text, index) {
  const code = text.charCodeAt(index);
  if (code < 0x80) { out.push(code); return 0; }
  if (code < 0x800) { out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f)); return 0; }
  if (code < 0xd800 || code > 0xdfff) { out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)); return 0; }
  if (code > 0xdbff) { appendReplacementCharacter(out); return 0; }
  const low = text.charCodeAt(index + 1);
  if (low < 0xdc00 || low > 0xdfff) { appendReplacementCharacter(out); return 0; }
  const point = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
  out.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
  return 1;
}

function appendReplacementCharacter(out) {
  out.push(0xef, 0xbf, 0xbd);
}

function decodeUTF8(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++];
    if (first < 0x80) { out += String.fromCharCode(first); continue; }
    if (first >= 0xc0 && first < 0xe0 && i < bytes.length) {
      out += String.fromCharCode(((first & 0x1f) << 6) | (bytes[i++] & 0x3f));
      continue;
    }
    if (first >= 0xe0 && first < 0xf0 && i + 1 < bytes.length) {
      out += String.fromCharCode(((first & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
      continue;
    }
    if (first >= 0xf0 && first < 0xf8 && i + 2 < bytes.length) {
      const point = ((first & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      const value = point - 0x10000;
      out += String.fromCharCode(0xd800 + (value >> 10), 0xdc00 + (value & 0x3ff));
      continue;
    }
    out += '\ufffd';
  }
  return out;
}
