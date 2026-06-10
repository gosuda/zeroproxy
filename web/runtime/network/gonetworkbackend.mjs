/* ZeroProxy GoNetworkBackend adapter. */

import {
  ARRAYBUFFER_CHUNKS,
  DEFAULT_MAX_CHUNK_SIZE,
  GO_NETWORK_APIS,
  GO_NETWORK_STORAGE_APIS,
  assertEnvelope,
  makeCacheMessage,
  makeCookieMessage,
  makeEnvelope,
  makeErrorMessage,
  makeFetchChunk,
  makeFetchEnd,
  makeFetchResponseStart,
  makeFetchStart,
  makeHello,
  makeStorageMessage,
  makeWebSocketMessage,
  negotiateReady,
  normalizeFetchRequest,
  normalizeHeaders,
  unsupportedFeatureError,
} from './protocol.mjs';
import { makeArrayBufferChunkMessages, makeStreamControl, toArrayBuffer } from './streams.mjs';

const DEFAULT_WORKER_URL = '/zp/assets/network-worker.js';
const DEFAULT_BOOT_TIMEOUT_MS = 15_000;
const READY_APIS = Object.freeze([...GO_NETWORK_APIS]);
const READY_STORAGE_APIS = Object.freeze([...GO_NETWORK_STORAGE_APIS]);

export class GoNetworkBackend {
  constructor(options = {}) {
    this.workerBackend = options.workerBackend || new WorkerBackend(options);
    this.foregroundBackend = options.foregroundBackend || new ForegroundBackend(options);
    this.preferWorker = options.preferWorker !== false;
    this.forceForeground = options.forceForeground === true;
    this.active = null;
  }

  async init(options = {}) {
    if (this.forceForeground || !this.preferWorker) return this.initForeground(options);
    try {
      return await this.initWorker(options);
    } catch (error) {
      if (options.disableFallback) throw error;
      return this.initForeground(options);
    }
  }

  async initWorker(options) {
    const result = await this.workerBackend.init(options);
    this.active = this.workerBackend;
    return result;
  }

  async initForeground(options) {
    const result = await this.foregroundBackend.init(options);
    this.active = this.foregroundBackend;
    return result;
  }

  fetchRaw(requestRecord) {
    return this.requireActive().fetchRaw(requestRecord);
  }

  sanitizeDocument(record) {
    return this.requireActive().sanitizeDocument(record);
  }

  sanitizeStylesheet(record) {
    return this.requireActive().sanitizeStylesheet(record);
  }

  openWebSocket(requestRecord) {
    return this.requireActive().openWebSocket(requestRecord);
  }

  sendWebSocket(messageRecord) {
    return this.requireActive().sendWebSocket(messageRecord);
  }

  closeWebSocket(messageRecord) {
    return this.requireActive().closeWebSocket(messageRecord);
  }

  addWebSocketListener(wsId, handler) {
    return this.requireActive().addWebSocketListener(wsId, handler);
  }

  setCookie(cookieRecord) {
    return this.requireActive().setCookie(cookieRecord);
  }

  getDocumentCookie(cookieRecord) {
    return this.requireActive().getDocumentCookie(cookieRecord);
  }

  cancel(requestId) {
    return this.requireActive().cancel(requestId);
  }

  health() {
    return this.requireActive().health();
  }

  shutdown() {
    return this.requireActive().shutdown();
  }

  requireActive() {
    if (!this.active) throw new Error('GoNetworkBackend is not initialized');
    return this.active;
  }
}


export class DispatcherBackend {
  constructor({ backendKind, dispatcher, request, bootTimeoutMs } = {}) {
    this.backendKind = backendKind || 'foreground';
    this.dispatcher = dispatcher || null;
    this.injectedRequest = request || null;
    this.bootTimeoutMs = bootTimeoutMs || DEFAULT_BOOT_TIMEOUT_MS;
    this.ready = null;
    this.servers = [];
    this.webSocketHandlers = new Map();
    this.webSocketStreams = new Map();
  }

  async init(options = {}) {
    const hello = makeHello({
      id: options.id || `${this.backendKind}-hello`,
      tabId: options.tabId || 'shell',
      backendKind: this.backendKind,
      requiredFeatures: options.requiredFeatures,
      servers: options.servers,
    });
    const ready = await withTimeout(this.request(hello), this.bootTimeoutMs, 'BACKEND_BOOT_TIMEOUT');
    if (ready.error) throw typedError(ready.error);
    const init = makeEnvelope('init', {
      id: options.initId || `${this.backendKind}-init`,
      parentId: ready.id,
      tabId: hello.tabId,
      servers: hello.servers,
    });
    const result = await withTimeout(this.request(init), this.bootTimeoutMs, 'BACKEND_INIT_TIMEOUT');
    if (result.type === 'init.error' || result.error) throw typedError(result.error || result);
    this.ready = ready;
    this.servers = hello.servers;
    return { backend: this.backendKind, ready, init: result };
  }

  async request(message, transfer) {
    if (this.injectedRequest) return this.injectedRequest(message, transfer);
    if (!this.dispatcher) throw new Error('BACKEND_DISPATCHER_UNAVAILABLE');
    return this.dispatcher(message, transfer);
  }

  async fetchRaw(requestRecord) {
    const start = makeFetchStart({ ...requestRecord, rawMode: true });
    const messages = await this.request(start, transferForFetch(start));
    return normalizeMessageList(messages);
  }

  sanitizeDocument(record) {
    return this.request(makeEnvelope('sanitize.document', record));
  }

  sanitizeStylesheet(record) {
    return this.request(makeEnvelope('sanitize.stylesheet', record));
  }

  async openWebSocket(requestRecord) {
    const requestedWsId = optionalWebSocketId(requestRecord);
    if (requestedWsId && typeof requestRecord.onEvent === 'function') {
      this.addWebSocketListener(requestedWsId, requestRecord.onEvent);
    }
    const response = await this.request(makeWebSocketMessage('ws.open', requestRecord));
    const acceptedWsId = String(response.wsId || requestedWsId || response.id || '');
    if (acceptedWsId && acceptedWsId !== requestedWsId && typeof requestRecord.onEvent === 'function') {
      this.addWebSocketListener(acceptedWsId, requestRecord.onEvent);
    }
    this.attachWebSocketStream(acceptedWsId, response.stream, response);
    return response;
  }

  sendWebSocket(record) {
    const wsId = String(record?.wsId || '');
    const stream = this.webSocketStreams.get(wsId);
    if (stream && typeof stream.send === 'function') {
      stream.send(webSocketStreamPayload(record));
      return makeWebSocketMessage('ws.send', { parentId: record.id, tabId: record.tabId, wsId, streamId: record.streamId, seq: record.seq });
    }
    return this.request(makeWebSocketMessage('ws.send', record), transferForWebSocket(record));
  }

  closeWebSocket(record) {
    const wsId = String(record?.wsId || '');
    const stream = this.webSocketStreams.get(wsId);
    if (stream && typeof stream.close === 'function') {
      stream.close(record.code, record.reason);
      this.webSocketStreams.delete(wsId);
      const message = makeWebSocketMessage('ws.close', { parentId: record.id, tabId: record.tabId, wsId, code: record.code || 1000, reason: record.reason || '', clean: true, source: 'local' });
      this.emitWebSocketEvent(message);
      return message;
    }
    return this.request(makeWebSocketMessage('ws.close', record));
  }

  addWebSocketListener(wsId, handler) {
    const key = String(wsId || '');
    if (!key || typeof handler !== 'function') return () => {};
    this.webSocketHandlers.set(key, handler);
    return () => {
      if (this.webSocketHandlers.get(key) === handler) this.webSocketHandlers.delete(key);
    };
  }

  emitWebSocketEvent(message) {
    const key = String(message?.wsId || message?.parentId || message?.id || '');
    const handler = this.webSocketHandlers.get(key);
    if (handler) handler(message);
    if (message?.type === 'ws.close' || message?.type === 'ws.error') {
      this.webSocketStreams.delete(key);
      this.webSocketHandlers.delete(key);
    }
    return Boolean(handler);
  }

  attachWebSocketStream(wsId, stream, accepted = {}) {
    const key = String(wsId || '');
    if (!key || !stream) return;
    this.webSocketStreams.set(key, stream);
    if (typeof stream.setHandlers !== 'function') return;
    stream.setHandlers({
      message: (data) => this.emitWebSocketEvent(makeWebSocketMessage('ws.message', { tabId: accepted.tabId, wsId: key, streamId: accepted.streamId, ...webSocketMessageFields(data) })),
      close: () => this.emitWebSocketEvent(makeWebSocketMessage('ws.close', { tabId: accepted.tabId, wsId: key, streamId: accepted.streamId, code: 1000, reason: '', clean: true, source: 'remote' })),
      error: (error) => this.emitWebSocketEvent(makeWebSocketMessage('ws.error', { tabId: accepted.tabId, wsId: key, streamId: accepted.streamId, reason: error?.message || String(error || 'WebSocket error') })),
    });
  }

  setCookie(cookieRecord) {
    return this.request(makeCookieMessage('cookie.set', cookieRecord));
  }

  getDocumentCookie(cookieRecord) {
    return this.request(makeCookieMessage('cookie.get', cookieRecord));
  }

  cancel(requestId) {
    return this.request(makeEnvelope('fetch.cancel', { id: String(requestId), requestId: String(requestId) }));
  }

  health() {
    return this.request(makeEnvelope('health.ping', { id: `${this.backendKind}-health` }));
  }

  shutdown() {
    return this.request(makeEnvelope('shutdown', { id: `${this.backendKind}-shutdown` }));
  }

  cache(type, record) {
    return this.request(makeCacheMessage(type, record));
  }

  storage(type, record) {
    return this.request(makeStorageMessage(type, record));
  }

  streamControl(type, record) {
    return this.request(makeStreamControl(type, record));
  }
}

export class ForegroundBackend extends DispatcherBackend {
  constructor(options = {}) {
    super({
      backendKind: 'foreground',
      dispatcher: options.dispatcher || createKernelDispatcher(options),
      request: options.request,
      bootTimeoutMs: options.bootTimeoutMs,
    });
  }
}

export class WorkerBackend extends DispatcherBackend {
  constructor(options = {}) {
    const workerURL = options.workerURL || DEFAULT_WORKER_URL;
    super({
      backendKind: 'worker',
      dispatcher: options.dispatcher,
      request: options.request,
      bootTimeoutMs: options.bootTimeoutMs,
    });
    this.WorkerCtor = options.WorkerCtor || globalThis.Worker;
    this.workerURL = workerURL;
    this.workerOptions = options.workerOptions || { name: 'zeroproxy-network' };
    this.rpc = null;
  }

  async request(message, transfer) {
    if (this.injectedRequest) return this.injectedRequest(message, transfer);
    const rpc = await this.ensureRPC();
    return rpc.request(message, transfer);
  }

  async ensureRPC() {
    if (this.rpc) return this.rpc;
    if (typeof this.WorkerCtor !== 'function') throw new Error('WORKER_UNAVAILABLE');
    const worker = new this.WorkerCtor(this.workerURL, this.workerOptions);
    this.rpc = new PostMessageRPC(worker, {
      terminate: () => worker.terminate?.(),
      onUnmatchedMessage: (message) => this.emitWebSocketEvent(message),
    });
    return this.rpc;
  }

  async shutdown() {
    const result = await super.shutdown();
    this.rpc?.close();
    this.rpc = null;
    return result;
  }
}

export class PostMessageRPC {
  constructor(target, options = {}) {
    this.target = target;
    this.pending = new Map();
    this.terminate = options.terminate || null;
    this.onUnmatchedMessage = options.onUnmatchedMessage || null;
    this.onMessage = (event) => this.handleMessage(event.data ?? event);
    if (typeof target.addEventListener === 'function') target.addEventListener('message', this.onMessage);
    else target.onmessage = this.onMessage;
  }

  request(message, transfer) {
    assertEnvelope(message);
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject, requestType: message.type, messages: [] });
      try {
        this.target.postMessage(message, transfer || []);
      } catch (error) {
        this.pending.delete(message.id);
        reject(error);
      }
    });
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (Array.isArray(message)) {
      this.resolveMessageArray(message);
      return;
    }
    const key = message.parentId || message.requestId || message.id;
    const pending = this.pending.get(key);
    if (!pending) {
      this.onUnmatchedMessage?.(message);
      return;
    }
    if (message.error) {
      this.pending.delete(key);
      pending.reject(typedError(message.error));
      return;
    }
    if (pending.requestType === 'fetch.start') {
      pending.messages.push(message);
      if (message.type !== 'fetch.response.end' && message.type !== 'fetch.error') return;
      this.pending.delete(key);
      pending.resolve(pending.messages);
      return;
    }
    this.pending.delete(key);
    pending.resolve(message);
  }

  resolveMessageArray(messages) {
    const first = messages[0];
    const key = first?.parentId || first?.requestId || first?.id;
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    pending.resolve(messages);
  }

  close() {
    for (const pending of this.pending.values()) pending.reject(new Error('BACKEND_CLOSED'));
    this.pending.clear();
    if (typeof this.target.removeEventListener === 'function') {
      this.target.removeEventListener('message', this.onMessage);
    }
    this.terminate?.();
  }
}

export function createKernelDispatcher(options = {}) {
  const kernel = options.kernelExports || globalThis;
  const backendKind = options.backendKind || 'foreground';
  const maxChunkSize = options.maximumChunkSize || DEFAULT_MAX_CHUNK_SIZE;
  const inflight = new Map();
  return async function dispatch(message) {
    assertEnvelope(message);
    switch (message.type) {
      case 'hello':
        return negotiateReady(message, readyCapabilities(backendKind, maxChunkSize));
      case 'init':
        return initKernel(kernel, message, backendKind);
      case 'fetch.start':
        return fetchThroughKernel(kernel, message, backendKind, maxChunkSize, inflight);
      case 'sanitize.document':
        return sanitizeKernelDocument(kernel, message);
      case 'sanitize.stylesheet':
        return sanitizeKernelStylesheet(kernel, message);
      case 'cookie.set':
        return setKernelCookie(kernel, message);
      case 'cookie.get':
        return getKernelCookie(kernel, message);
      case 'ws.open':
        return openKernelWebSocket(kernel, message);
      case 'fetch.cancel':
      case 'stream.cancel':
        return cancelFetch(inflight, message);
      case 'health.ping':
        return makeEnvelope('health.pong', { parentId: message.id, backendKind });
      case 'shutdown':
        return makeEnvelope('shutdown', { parentId: message.id, backendKind, complete: true });
      default:
        return makeErrorMessage(`${message.type}.error`, {
          parentId: message.id,
          code: 'unsupported_feature',
          debug: `Unsupported message type: ${message.type}`,
        });
    }
  };
}

export function readyCapabilities(backendKind, maximumChunkSize = DEFAULT_MAX_CHUNK_SIZE) {
  return {
    backendKind,
    supportedBinaryModes: [ARRAYBUFFER_CHUNKS],
    maximumChunkSize,
    supportedAPIs: READY_APIS,
    supportedStorageCacheAPIs: READY_STORAGE_APIS,
  };
}

async function initKernel(kernel, message, backendKind) {
  try {
    const init = kernel.init || kernel.__zp_kernel_init;
    if (typeof init === 'function') await init({ servers: message.servers || [] });
    return makeEnvelope('init.ok', { parentId: message.id, tabId: message.tabId, backendKind });
  } catch (error) {
    return makeEnvelope('init.error', {
      parentId: message.id,
      tabId: message.tabId,
      error: { code: 'TARGET_CONNECT_FAILED', debug: String(error?.message || error) },
    });
  }
}

async function fetchThroughKernel(kernel, message, backendKind, maximumChunkSize, inflight) {
  const controller = new AbortController();
  inflight.set(message.requestId, controller);
  try {
    const response = await callKernelFetch(kernel, message, controller.signal);
    return responseToMessages(response, message, backendKind, maximumChunkSize);
  } catch (error) {
    return [makeErrorMessage('fetch.error', {
      parentId: message.id,
      requestId: message.requestId,
      code: error?.name === 'AbortError' ? 'CANCELED' : error?.code || 'TARGET_CONNECT_FAILED',
      debug: String(error?.message || error),
    })];
  } finally {
    inflight.delete(message.requestId);
  }
}

function sanitizeKernelDocument(kernel, message) {
  const sanitizer = kernel.sanitizeDocument || kernel.__zp_sanitize_html;
  if (typeof sanitizer !== 'function') {
    return makeErrorMessage('sanitize.document.error', {
      parentId: message.id,
      code: 'unsupported_feature',
      debug: 'HTML sanitizer unavailable',
    });
  }
  return makeEnvelope('sanitize.document.result', {
    parentId: message.id,
    tabId: message.tabId,
    ...sanitizer(message),
  });
}

function sanitizeKernelStylesheet(kernel, message) {
  const sanitizer = kernel.sanitizeStylesheet || kernel.__zp_sanitize_css;
  if (typeof sanitizer !== 'function') {
    return makeErrorMessage('sanitize.stylesheet.error', {
      parentId: message.id,
      code: 'unsupported_feature',
      debug: 'CSS sanitizer unavailable',
    });
  }
  return makeEnvelope('sanitize.stylesheet.result', {
    parentId: message.id,
    tabId: message.tabId,
    ...sanitizer(message),
  });
}

async function callKernelFetch(kernel, message, signal) {
  if (typeof kernel.fetchRaw === 'function') {
    return kernel.fetchRaw({ ...normalizeFetchRequest(message), signal });
  }
  if (typeof kernel.__go_jshttp !== 'function') throw new Error('KERNEL_FETCH_UNAVAILABLE');
  const RequestCtor = kernel.Request || globalThis.Request;
  const request = new RequestCtor(message.url, {
    method: message.method,
    headers: message.headers,
    body: message.body,
    signal,
  });
  stampKernelHeaders(request.headers, message);
  return kernel.__go_jshttp(request);
}

function cancelFetch(inflight, message) {
  const requestId = String(message.requestId || message.id);
  const controller = inflight.get(requestId);
  if (controller) controller.abort();
  return makeErrorMessage('fetch.error', {
    parentId: message.id,
    requestId,
    code: 'CANCELED',
    debug: controller ? 'Request canceled' : 'Request already complete',
  });
}

async function responseToMessages(response, request, backendKind, maximumChunkSize) {
  if (Array.isArray(response)) return response;
  const bodyStreamId = `body-${request.requestId}`;
  const start = makeFetchResponseStart({
    requestId: request.requestId,
    tabId: request.tabId,
    resourceId: request.resourceId,
    navigationId: request.navigationId,
    url: request.url,
    finalUrl: headerValue(response.headers, 'X-ZP-Response-URL') || response.url || request.url,
    redirected: response.redirected,
    status: response.status,
    statusText: response.statusText,
    headers: normalizeHeaders(response.headers),
    contentLength: contentLength(response.headers),
    bodyStreamId,
    networkBackend: backendKind,
  });
  return [start, ...(await responseBodyMessages(response, {
    bodyStreamId,
    requestId: request.requestId,
    tabId: request.tabId,
    chunkSize: maximumChunkSize,
  }))];
}

async function responseBodyMessages(response, options) {
  const reader = response?.body?.getReader?.();
  if (!reader) return makeArrayBufferChunkMessages({ bytes: await responseBytes(response), ...options });
  return readBodyMessages(reader, options);
}

async function readBodyMessages(reader, options) {
  const state = { messages: [], seq: 0, bytesRead: 0 };
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    appendBodyChunkMessages(state, item.value, options);
  }
  state.messages.push(makeFetchEnd({ ...options, bytesRead: state.bytesRead }));
  return state.messages;
}

function appendBodyChunkMessages(state, value, options) {
  const bytes = new Uint8Array(toArrayBuffer(value));
  for (let offset = 0; offset < bytes.byteLength; offset += options.chunkSize) {
    const chunk = bytes.buffer.slice(offset, Math.min(offset + options.chunkSize, bytes.byteLength));
    state.messages.push(makeFetchChunk({
      ...options,
      seq: state.seq,
      bytes: chunk,
      byteOffset: state.bytesRead,
      byteLength: chunk.byteLength,
      final: false,
    }));
    state.seq += 1;
    state.bytesRead += chunk.byteLength;
  }
}

function setKernelCookie(kernel, message) {
  const setter = kernel.cookieSet || kernel.__zp_cookie_set;
  const ok = typeof setter === 'function' ? setter(message) !== false : false;
  return makeCookieMessage('cookie.set.result', { parentId: message.id, tabId: message.tabId, ok });
}

function getKernelCookie(kernel, message) {
  if (typeof kernel.cookieGet === 'function') return kernel.cookieGet(message);
  return makeCookieMessage('cookie.get.result', {
    parentId: message.id,
    tabId: message.tabId,
    targetUrl: message.targetUrl,
    cookieString: '',
    cookieRecords: [],
  });
}

async function openKernelWebSocket(kernel, message) {
  const opener = kernel.openWebSocket || kernel.__zp_stream;
  if (typeof opener !== 'function') throw typedError(unsupportedFeatureError(['webSocket']));
  const stream = await opener(message);
  const accepted = makeWebSocketMessage('ws.accepted', {
    parentId: message.id,
    tabId: message.tabId,
    wsId: message.wsId || message.id,
    streamId: stream?.streamId || message.streamId || message.id,
    selectedProtocol: stream?.protocol || '',
  });
  if (stream) Object.defineProperty(accepted, 'stream', { value: stream, enumerable: false });
  return accepted;
}

function optionalWebSocketId(record) {
  return record?.wsId == null ? '' : String(record.wsId);
}

function webSocketStreamPayload(record = {}) {
  if (record.opcode === 'binary') return bytesToArrayBuffer(record.bytes);
  return String(record.bytes ?? '');
}

function webSocketMessageFields(data) {
  if (typeof data === 'string') return { opcode: 'text', bytes: data };
  return { opcode: 'binary', bytes: bytesToArrayBuffer(data) };
}

function bytesToArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value.map((item) => Number(item) & 255)).buffer;
  return toArrayBuffer(value || '');
}

function stampKernelHeaders(headers, message) {
  headers.set('X-ZP-Raw-Mode', message.rawMode ? '1' : '0');
  if (message.tabId) headers.set('X-ZP-Tab-Id', message.tabId);
  if (message.documentUrl) headers.set('X-ZP-Document-URL', message.documentUrl);
  if (message.referrerPolicy) headers.set('X-ZP-Referrer-Policy', message.referrerPolicy);
}

function transferForFetch(message) {
  return message.body instanceof ArrayBuffer ? [message.body] : [];
}

function transferForWebSocket(message) {
  return message?.bytes instanceof ArrayBuffer ? [message.bytes] : [];
}

function normalizeMessageList(messages) {
  return Array.isArray(messages) ? messages : [messages];
}

function withTimeout(promise, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function typedError(errorRecord) {
  const err = new Error(errorRecord?.debug || errorRecord?.code || 'BACKEND_ERROR');
  err.code = errorRecord?.code || 'BACKEND_ERROR';
  err.features = errorRecord?.features || [];
  return err;
}

function headerValue(headers, name) {
  return headers && typeof headers.get === 'function' ? headers.get(name) : '';
}

function contentLength(headers) {
  const raw = headerValue(headers, 'Content-Length');
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function responseBytes(response) {
  if (!response) return new ArrayBuffer(0);
  if (typeof response.arrayBuffer === 'function') return response.arrayBuffer();
  if (response.body instanceof ArrayBuffer) return response.body;
  if (ArrayBuffer.isView(response.body)) return toArrayBuffer(response.body);
  if (typeof response.body === 'string') return toArrayBuffer(response.body);
  return new ArrayBuffer(0);
}
