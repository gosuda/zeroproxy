/* ZeroProxy Go WASM network worker. Classic worker asset. */
(() => {
  'use strict';

  const PROTOCOL_VERSION = 1;
  const CHUNK_SIZE = 64 * 1024;
  const ASSET_WASM_EXEC = '/zp/assets/wasm_exec.js';
  const KERNEL_WASM = '/zp/kernel.wasm';
  let bootPromise = null;
  let booted = false;
  const inflight = new Map();
  const webSockets = new Map();

  self.addEventListener('message', (event) => {
    handleMessage(event.data).catch((error) => {
      self.postMessage(errorMessage(event.data, 'TARGET_CONNECT_FAILED', String(error?.message || error)));
    });
  });

  async function handleMessage(message) {
    if (!message || message.v !== PROTOCOL_VERSION) return;
    switch (message.type) {
      case 'hello':
        self.postMessage(readyMessage(message));
        break;
      case 'init':
        await bootKernel(message.servers || []);
        self.postMessage(reply(message, 'init.ok', { backendKind: 'worker' }));
        break;
      case 'fetch.start':
        await handleFetchStart(message);
        break;
      case 'sanitize.document':
        await bootKernel(message.servers || []);
        self.postMessage(sanitizeDocument(message));
        break;
      case 'sanitize.stylesheet':
        await bootKernel(message.servers || []);
        self.postMessage(sanitizeStylesheet(message));
        break;
      case 'fetch.cancel':
      case 'stream.cancel':
        self.postMessage(cancelFetch(message));
        break;
      case 'cookie.set':
        self.postMessage(cookieSet(message));
        break;
      case 'ws.open':
        self.postMessage(await openWebSocket(message));
        break;
      case 'ws.send':
        self.postMessage(sendWebSocket(message));
        break;
      case 'ws.close':
        self.postMessage(closeWebSocket(message));
        break;
      case 'health.ping':
        self.postMessage(reply(message, 'health.pong', { backendKind: 'worker', booted }));
        break;
      case 'shutdown':
        self.postMessage(reply(message, 'shutdown', { complete: true }));
        self.close();
        break;
      default:
        self.postMessage(errorMessage(message, 'unsupported_feature', `Unsupported message type: ${message.type}`));
        break;
    }
  }

  async function bootKernel(servers) {
    if (!bootPromise) bootPromise = loadKernel(servers);
    await bootPromise;
    booted = true;
  }

  async function loadKernel(servers) {
    if (typeof self.Go !== 'function') importScripts(ASSET_WASM_EXEC);
    const go = new self.Go();
    const wasm = await WebAssembly.instantiateStreaming(fetch(KERNEL_WASM, { cache: 'no-store' }), go.importObject);
    go.run(wasm.instance);
    await waitForKernelExports();
    if (typeof self.__zp_kernel_init === 'function') await self.__zp_kernel_init({ servers });
  }

  function waitForKernelExports() {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const check = () => {
        if (self.__zp_kernel_ready && typeof self.__go_jshttp === 'function') {
          resolve(true);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error('KERNEL_BOOT_TIMEOUT'));
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
  }

  async function handleFetchStart(message) {
    const controller = new AbortController();
    inflight.set(message.requestId, controller);
    try {
      await bootKernel(message.servers || []);
      const response = await self.__go_jshttp(requestFromMessage(message, controller.signal));
      self.postMessage(responseStart(message, response));
      await postResponseBody(message, response);
    } catch (error) {
      const code = error?.name === 'AbortError' ? 'CANCELED' : error?.code || 'TARGET_CONNECT_FAILED';
      self.postMessage(errorMessage(message, code, String(error?.message || error)));
    } finally {
      inflight.delete(message.requestId);
    }
  }

  function requestFromMessage(message, signal) {
    const headers = new Headers(message.headers || []);
    headers.set('X-ZP-Raw-Mode', message.rawMode ? '1' : '0');
    headers.set('X-ZP-Tab-Id', message.tabId || 'tab');
    if (message.documentUrl) headers.set('X-ZP-Document-URL', message.documentUrl);
    return new Request(message.url, { method: message.method || 'GET', headers, signal });
  }

  function cancelFetch(message) {
    const requestId = String(message.requestId || message.id);
    const controller = inflight.get(requestId);
    if (controller) controller.abort();
    return errorMessage(message, 'CANCELED', controller ? 'Request canceled' : 'Request already complete');
  }

  function responseStart(message, response) {
    return reply(message, 'fetch.response.start', {
      requestId: message.requestId,
      resourceId: message.resourceId,
      navigationId: message.navigationId,
      url: message.url,
      finalUrl: response.headers.get('X-ZP-Response-URL') || response.url || message.url,
      redirected: response.redirected === true,
      status: response.status,
      statusText: response.statusText || '',
      headers: Array.from(response.headers.entries()),
      bodyMode: 'arraybuffer-chunks',
      bodyStreamId: `body-${message.requestId}`,
      networkBackend: 'worker',
    });
  }

  async function postResponseBody(message, response) {
    const bodyStreamId = `body-${message.requestId}`;
    const state = { seq: 0, bytesRead: 0 };
    if (response.body?.getReader) {
      await postReaderChunks(message, bodyStreamId, response.body.getReader(), state);
    } else {
      await postResponseBytes(message, bodyStreamId, await response.arrayBuffer(), state, true);
    }
    self.postMessage(reply(message, 'fetch.response.end', { bodyStreamId, bytesRead: state.bytesRead }));
  }

  async function postReaderChunks(message, bodyStreamId, reader, state) {
    for (;;) {
      const item = await reader.read();
      if (item.done) return;
      await postResponseBytes(message, bodyStreamId, item.value, state, false);
    }
  }

  async function postResponseBytes(message, bodyStreamId, value, state, finalSource) {
    const bytes = new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
      postOneChunk(message, bodyStreamId, bytes, offset, state, finalSource && offset + CHUNK_SIZE >= bytes.byteLength);
    }
  }

  function postOneChunk(message, bodyStreamId, bytes, offset, state, final) {
    const chunk = bytes.buffer.slice(offset, Math.min(offset + CHUNK_SIZE, bytes.byteLength));
    self.postMessage(reply(message, 'fetch.response.chunk', {
      bodyStreamId,
      seq: state.seq,
      bytes: chunk,
      byteOffset: state.bytesRead,
      byteLength: chunk.byteLength,
      final,
    }), [chunk]);
    state.seq += 1;
    state.bytesRead += chunk.byteLength;
  }


  function sanitizeDocument(message) {
    if (typeof self.__zp_sanitize_html !== 'function') {
      return errorMessage(message, 'unsupported_feature', 'HTML sanitizer unavailable');
    }
    return reply(message, 'sanitize.document.result', self.__zp_sanitize_html(message));
  }

  function sanitizeStylesheet(message) {
    if (typeof self.__zp_sanitize_css !== 'function') {
      return errorMessage(message, 'unsupported_feature', 'CSS sanitizer unavailable');
    }
    return reply(message, 'sanitize.stylesheet.result', self.__zp_sanitize_css(message));
  }
  function cookieSet(message) {
    const ok = typeof self.__zp_cookie_set === 'function' && self.__zp_cookie_set(message) !== false;
    return reply(message, 'cookie.set.result', { ok });
  }

  async function openWebSocket(message) {
    await bootKernel(message.servers || []);
    if (typeof self.__zp_stream !== 'function') return errorMessage(message, 'unsupported_feature', 'WebSocket stream unavailable');
    const stream = await self.__zp_stream(message);
    const wsId = message.wsId || message.id;
    const streamId = message.streamId || message.id;
    webSockets.set(wsId, { stream, openMessage: message, streamId });
    stream?.setHandlers?.({
      message: (data) => postWebSocketMessage(message, streamId, data),
      close: () => postWebSocketClose(message, streamId, 1000, '', true, 'remote'),
      error: (error) => postWebSocketError(message, streamId, error?.message || String(error || 'WebSocket error')),
    });
    return reply(message, 'ws.accepted', {
      wsId,
      streamId,
      selectedProtocol: stream?.protocol || '',
    });
  }

  function sendWebSocket(message) {
    const entry = webSockets.get(String(message.wsId || ''));
    if (!entry?.stream?.send) return errorMessage(message, 'TARGET_CONNECT_FAILED', 'WebSocket stream unavailable');
    entry.stream.send(webSocketPayload(message));
    return reply(message, 'ws.send', { wsId: message.wsId, streamId: entry.streamId, seq: message.seq });
  }

  function closeWebSocket(message) {
    const wsId = String(message.wsId || '');
    const entry = webSockets.get(wsId);
    if (!entry?.stream?.close) return errorMessage(message, 'TARGET_CONNECT_FAILED', 'WebSocket stream unavailable');
    entry.stream.close(message.code, message.reason);
    webSockets.delete(wsId);
    return reply(message, 'ws.close', { wsId, streamId: entry.streamId, code: message.code || 1000, reason: message.reason || '', clean: true, source: 'local' });
  }

  function postWebSocketMessage(openMessage, streamId, data) {
    const wsId = openMessage.wsId || openMessage.id;
    const entry = webSockets.get(wsId);
    if (!entry) return;
    self.postMessage(reply(openMessage, 'ws.message', { wsId, streamId, ...webSocketMessageFields(data) }), transferForWebSocketData(data));
  }

  function postWebSocketClose(openMessage, streamId, code, reason, clean, source) {
    const wsId = openMessage.wsId || openMessage.id;
    if (!webSockets.has(wsId)) return;
    webSockets.delete(wsId);
    self.postMessage(reply(openMessage, 'ws.close', { wsId, streamId, code, reason, clean, source }));
  }

  function postWebSocketError(openMessage, streamId, reason) {
    const wsId = openMessage.wsId || openMessage.id;
    if (!webSockets.has(wsId)) return;
    self.postMessage(reply(openMessage, 'ws.error', { wsId, streamId, reason }));
  }

  function webSocketPayload(message) {
    if (message.opcode === 'binary') return bytesToArrayBuffer(message.bytes);
    return String(message.bytes ?? '');
  }

  function webSocketMessageFields(data) {
    if (typeof data === 'string') return { opcode: 'text', bytes: data };
    return { opcode: 'binary', bytes: bytesToArrayBuffer(data) };
  }

  function transferForWebSocketData(data) {
    const bytes = data instanceof ArrayBuffer ? data : null;
    return bytes ? [bytes] : [];
  }

  function bytesToArrayBuffer(value) {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    if (Array.isArray(value)) return Uint8Array.from(value.map((item) => Number(item) & 255)).buffer;
    return new TextEncoder().encode(String(value || '')).buffer;
  }

  function readyMessage(message) {
    return reply(message, 'ready', {
      backendKind: 'worker',
      protocolVersion: PROTOCOL_VERSION,
      supportedBinaryModes: ['arraybuffer-chunks'],
      maximumChunkSize: CHUNK_SIZE,
      supportedAPIs: ['fetchRaw', 'webSocket', 'cookie', 'timing', 'abort', 'sanitizeDocument', 'sanitizeStylesheet'],
      supportedStorageCacheAPIs: ['indexedDBStore', 'httpCache', 'cacheAPI'],
      unsupportedRequiredFeatures: [],
    });
  }

  function reply(message, type, fields = {}) {
    return { v: PROTOCOL_VERSION, type, id: `${message.id}:${type}`, parentId: message.id, tabId: message.tabId || 'shell', ...fields };
  }

  function errorMessage(message, code, debug) {
    return reply(message || { id: 'unknown', tabId: 'shell' }, `${message?.type || 'message'}.error`, {
      error: { code, debug },
      code,
      debug,
    });
  }
})();
