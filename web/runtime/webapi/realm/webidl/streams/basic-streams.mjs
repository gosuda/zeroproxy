const readableControllerToken = {};
const writableControllerToken = {};
const transformControllerToken = {};
const byobRequestToken = {};
const byteControllerToken = {};
const transformStreamSlots = new WeakMap();

export function createStreamFacades() {
  class ReadableStream {
    constructor(source = {}) {
      defineHidden(this, '__zpQueue', []);
      defineHidden(this, '__zpReadRequests', []);
      defineHidden(this, '__zpClosed', false);
      defineHidden(this, '__zpError', null);
      defineHidden(this, '__zpReader', null);
      const controller = source?.type === 'bytes' ? new ReadableByteStreamController(byteControllerToken, this) : new ReadableStreamDefaultController(readableControllerToken, this);
      defineHidden(this, '__zpController', controller);
      callStart(source, controller);
    }
    get locked() { return this.__zpReader !== null; }
    cancel(reason = undefined) { return cancelReadable(this, reason); }
    getReader(options = {}) { return options?.mode === 'byob' ? new ReadableStreamBYOBReader(this) : new ReadableStreamDefaultReader(this); }
    pipeThrough(transform) { this.pipeTo(transform.writable); return transform.readable; }
    pipeTo(destination) { return pipeReadableToWritable(this, destination); }
    tee() { return teeReadable(this); }
  }
  Object.defineProperty(ReadableStream.prototype, 'values', { value: readableStreamValues, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, { value: readableStreamValues, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(ReadableStream.prototype, Symbol.toStringTag, { value: 'ReadableStream', configurable: true });

  class ReadableStreamDefaultReader {
    constructor(stream) { attachReadableReader(this, stream, ReadableStream); }
    get closed() { return this.__zpStream?.__zpClosed ? Promise.resolve(undefined) : Promise.resolve(undefined); }
    cancel(reason = undefined) { return this.__zpStream ? this.__zpStream.cancel(reason) : Promise.reject(new TypeError('Reader has no stream.')); }
    read() { return this.__zpStream ? readFromStream(this.__zpStream) : Promise.reject(new TypeError('Reader has no stream.')); }
    releaseLock() { releaseReadableReader(this); }
  }
  Object.defineProperty(ReadableStreamDefaultReader.prototype, Symbol.toStringTag, { value: 'ReadableStreamDefaultReader', configurable: true });

  class ReadableStreamBYOBReader extends ReadableStreamDefaultReader {
    read(view) { return readIntoView(this.__zpStream, view); }
  }
  Object.defineProperty(ReadableStreamBYOBReader.prototype, Symbol.toStringTag, { value: 'ReadableStreamBYOBReader', configurable: true });

  class ReadableStreamDefaultController {
    constructor(token, stream) { if (token !== readableControllerToken) illegalConstructor('ReadableStreamDefaultController'); defineHidden(this, '__zpStream', stream); }
    get desiredSize() { return 1; }
    close() { closeReadable(this.__zpStream); }
    enqueue(chunk = undefined) { enqueueReadable(this.__zpStream, chunk); }
    error(reason = undefined) { errorReadable(this.__zpStream, reason); }
  }
  Object.defineProperty(ReadableStreamDefaultController.prototype, Symbol.toStringTag, { value: 'ReadableStreamDefaultController', configurable: true });

  class ReadableByteStreamController extends ReadableStreamDefaultController {
    constructor(token, stream) { if (token !== byteControllerToken) illegalConstructor('ReadableByteStreamController'); super(readableControllerToken, stream); }
    get byobRequest() { return null; }
  }
  Object.defineProperty(ReadableByteStreamController.prototype, Symbol.toStringTag, { value: 'ReadableByteStreamController', configurable: true });

  class ReadableStreamBYOBRequest {
    constructor(token, view) { if (token !== byobRequestToken) illegalConstructor('ReadableStreamBYOBRequest'); defineHidden(this, '__zpView', view); }
    get view() { return this.__zpView; }
    respond() {}
    respondWithNewView(view) { defineHidden(this, '__zpView', view); }
  }
  Object.defineProperty(ReadableStreamBYOBRequest.prototype, Symbol.toStringTag, { value: 'ReadableStreamBYOBRequest', configurable: true });

  class WritableStream {
    constructor(sink = {}) {
      defineHidden(this, '__zpSink', sink || {});
      defineHidden(this, '__zpWriter', null);
      defineHidden(this, '__zpClosed', false);
      defineHidden(this, '__zpController', new WritableStreamDefaultController(writableControllerToken, this));
      callStart(sink, this.__zpController);
    }
    get locked() { return this.__zpWriter !== null; }
    abort(reason = undefined) { return abortWritable(this, reason); }
    close() { return closeWritable(this); }
    getWriter() { return new WritableStreamDefaultWriter(this); }
  }
  Object.defineProperty(WritableStream.prototype, Symbol.toStringTag, { value: 'WritableStream', configurable: true });

  class WritableStreamDefaultWriter {
    constructor(stream) { attachWritableWriter(this, stream, WritableStream); }
    get closed() { return this.__zpStream?.__zpClosed ? Promise.resolve(undefined) : Promise.resolve(undefined); }
    get desiredSize() { return 1; }
    get ready() { return Promise.resolve(undefined); }
    abort(reason = undefined) { return this.__zpStream ? this.__zpStream.abort(reason) : Promise.reject(new TypeError('Writer has no stream.')); }
    close() { return this.__zpStream ? this.__zpStream.close() : Promise.reject(new TypeError('Writer has no stream.')); }
    releaseLock() { releaseWritableWriter(this); }
    write(chunk = undefined) { return this.__zpStream ? writeToStream(this.__zpStream, chunk) : Promise.reject(new TypeError('Writer has no stream.')); }
  }
  Object.defineProperty(WritableStreamDefaultWriter.prototype, Symbol.toStringTag, { value: 'WritableStreamDefaultWriter', configurable: true });

  class WritableStreamDefaultController {
    constructor(token, stream) { if (token !== writableControllerToken) illegalConstructor('WritableStreamDefaultController'); defineHidden(this, '__zpStream', stream); }
    error(reason = undefined) { this.__zpStream.__zpError = reason; }
  }
  Object.defineProperty(WritableStreamDefaultController.prototype, Symbol.toStringTag, { value: 'WritableStreamDefaultController', configurable: true });

  class TransformStream {
    constructor(transformer = {}) {
      const controller = new TransformStreamDefaultController(transformControllerToken);
      const readable = new ReadableStream({ start(readableController) { controller.__zpReadableController = readableController; } });
      const writable = new WritableStream({
        write(chunk) { return transformChunk(transformer, controller, chunk); },
        close() { return flushTransform(transformer, controller); },
        abort(reason) { controller.error(reason); },
      });
      transformStreamSlots.set(this, { controller, readable, writable });
      callStart(transformer, controller);
    }
    get readable() { return transformStreamState(this).readable; }
    get writable() { return transformStreamState(this).writable; }
  }
  Object.defineProperty(TransformStream.prototype, Symbol.toStringTag, { value: 'TransformStream', configurable: true });

  class TransformStreamDefaultController {
    constructor(token) { if (token !== transformControllerToken) illegalConstructor('TransformStreamDefaultController'); defineHidden(this, '__zpReadableController', null); }
    get desiredSize() { return 1; }
    enqueue(chunk = undefined) { this.__zpReadableController?.enqueue(chunk); }
    error(reason = undefined) { this.__zpReadableController?.error(reason); }
    terminate() { this.__zpReadableController?.close(); }
  }
  Object.defineProperty(TransformStreamDefaultController.prototype, Symbol.toStringTag, { value: 'TransformStreamDefaultController', configurable: true });

  return { ReadableByteStreamController, ReadableStream, ReadableStreamBYOBReader, ReadableStreamBYOBRequest, ReadableStreamDefaultController, ReadableStreamDefaultReader, TransformStream, TransformStreamDefaultController, WritableStream, WritableStreamDefaultController, WritableStreamDefaultWriter };
}

function readableStreamValues() {
  const reader = this.getReader();
  return {
    async next() {
      return reader.read();
    },
    async return() {
      reader.releaseLock();
      return { done: true };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
try { Object.defineProperty(readableStreamValues, 'name', { value: 'values', configurable: true }); } catch {}

function transformStreamState(stream) {
  const state = transformStreamSlots.get(stream);
  if (!state) throw new TypeError('Illegal invocation');
  return state;
}

export function makeStreamEndpoint(tag) {
  const Ctor = globalThis[tag];
  if (typeof Ctor === 'function') return new Ctor();
  const endpoint = {};
  Object.defineProperty(endpoint, Symbol.toStringTag, { value: tag, configurable: true });
  return Object.freeze(endpoint);
}

function attachReadableReader(reader, stream, ReadableStream) {
  if (!(stream instanceof ReadableStream)) throw new TypeError("Failed to construct 'ReadableStreamDefaultReader': parameter 1 is not a ReadableStream.");
  if (stream.locked) throw new TypeError('ReadableStream is locked.');
  defineHidden(reader, '__zpStream', stream);
  stream.__zpReader = reader;
}

function attachWritableWriter(writer, stream, WritableStream) {
  if (!(stream instanceof WritableStream)) throw new TypeError("Failed to construct 'WritableStreamDefaultWriter': parameter 1 is not a WritableStream.");
  if (stream.locked) throw new TypeError('WritableStream is locked.');
  defineHidden(writer, '__zpStream', stream);
  stream.__zpWriter = writer;
}

function releaseReadableReader(reader) { if (reader.__zpStream) reader.__zpStream.__zpReader = null; defineHidden(reader, '__zpStream', null); }

function releaseWritableWriter(writer) { if (writer.__zpStream) writer.__zpStream.__zpWriter = null; defineHidden(writer, '__zpStream', null); }

function enqueueReadable(stream, chunk) {
  if (stream.__zpClosed) throw new TypeError('ReadableStream is closed.');
  const request = stream.__zpReadRequests.shift();
  if (request) request.resolve({ value: chunk, done: false });
  else stream.__zpQueue.push(chunk);
}

function closeReadable(stream) {
  stream.__zpClosed = true;
  for (const request of stream.__zpReadRequests.splice(0)) request.resolve({ value: undefined, done: true });
}

function errorReadable(stream, reason) {
  stream.__zpError = reason;
  for (const request of stream.__zpReadRequests.splice(0)) request.reject(reason);
}

function readFromStream(stream) {
  if (stream.__zpError) return Promise.reject(stream.__zpError);
  if (stream.__zpQueue.length) return Promise.resolve({ value: stream.__zpQueue.shift(), done: false });
  if (stream.__zpClosed) return Promise.resolve({ value: undefined, done: true });
  return new Promise((resolve, reject) => stream.__zpReadRequests.push({ resolve, reject }));
}

function readIntoView(stream, view) {
  if (!ArrayBuffer.isView(view)) return Promise.reject(new TypeError("Failed to execute 'read' on 'ReadableStreamBYOBReader': parameter 1 is not an ArrayBuffer view."));
  return readFromStream(stream).then((result) => result.done ? result : copyIntoView(result.value, view));
}

function copyIntoView(value, view) {
  const bytes = ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value || []);
  const limit = Math.min(bytes.byteLength, view.byteLength);
  new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(bytes.slice(0, limit));
  return { value: view, done: false };
}

function cancelReadable(stream) {
  stream.__zpQueue.length = 0;
  closeReadable(stream);
  return Promise.resolve(undefined);
}

function writeToStream(stream, chunk) {
  if (stream.__zpClosed) return Promise.reject(new TypeError('WritableStream is closed.'));
  return typeof stream.__zpSink.write === 'function' ? Promise.resolve(stream.__zpSink.write(chunk, stream.__zpController)) : Promise.resolve(undefined);
}

function closeWritable(stream) {
  if (stream.__zpClosed) return Promise.resolve(undefined);
  stream.__zpClosed = true;
  return typeof stream.__zpSink.close === 'function' ? Promise.resolve(stream.__zpSink.close()) : Promise.resolve(undefined);
}

function abortWritable(stream, reason) {
  stream.__zpClosed = true;
  return typeof stream.__zpSink.abort === 'function' ? Promise.resolve(stream.__zpSink.abort(reason)) : Promise.resolve(undefined);
}

async function pipeReadableToWritable(readable, writable) {
  const reader = readable.getReader();
  const writer = writable.getWriter();
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    await writer.write(item.value);
  }
  await writer.close();
}

function teeReadable(stream) { return [stream, stream]; }

function transformChunk(transformer, controller, chunk) {
  if (typeof transformer?.transform === 'function') return Promise.resolve(transformer.transform(chunk, controller));
  controller.enqueue(chunk);
  return Promise.resolve(undefined);
}

function flushTransform(transformer, controller) {
  const flushed = typeof transformer?.flush === 'function' ? Promise.resolve(transformer.flush(controller)) : Promise.resolve(undefined);
  return flushed.then(() => controller.terminate());
}

function illegalConstructor(name) { throw new TypeError(`Failed to construct '${name}': Illegal constructor`); }

function defineHidden(target, key, value) { Object.defineProperty(target, key, { value, configurable: true, writable: true }); }

function callStart(underlying, controller) {
  if (typeof underlying?.start !== 'function') return;
  try { Promise.resolve(underlying.start(controller)).catch((error) => controller.error?.(error)); }
  catch (error) { controller.error?.(error); }
}
