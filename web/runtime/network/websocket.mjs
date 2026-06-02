export function createWebSocketFacades({
  root,
  Native,
  boot,
  define,
  installEventMethods,
  maskNativeFunction,
  normalizedError,
  targetWSURL,
  postMessageToSW,
  currentDocumentURL,
}) {
  function installWebSocket() {
    const CONNECTING = 0,
      OPEN = 1,
      CLOSING = 2,
      CLOSED = 3;
    const tokenRE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
    function protocolList(protocols) {
      if (protocols == null) return [];
      const list = protocolArray(protocols);
      if (!list) throw normalizedError('SyntaxError');
      const seen = new Set();
      return list.map((p) => checkedProtocol(p, seen, tokenRE, normalizedError));
    }
    function protocolArray(protocols) {
      if (typeof protocols === 'string') return [protocols];
      return Array.isArray(protocols) ? protocols.slice() : null;
    }
    function checkedProtocol(protocol, seen, tokenRE, normalizedError) {
      const s = String(protocol);
      if (invalidProtocol(s, seen, tokenRE)) throw normalizedError('SyntaxError');
      seen.add(s);
      return s;
    }
    function invalidProtocol(protocol, seen, tokenRE) {
      return !protocol || !tokenRE.test(protocol) || seen.has(protocol);
    }
    function closeEvent(code, reason, wasClean) {
      try {
        return new CloseEvent('close', { code, reason, wasClean });
      } catch {
        const ev = new Event('close');
        try {
          Object.defineProperties(ev, {
            code: { value: code },
            reason: { value: reason },
            wasClean: { value: wasClean },
          });
        } catch {}
        return ev;
      }
    }
    function finish(ws, code, reason, wasClean) {
      if (ws._closed) return;
      ws._closed = true;
      ws.readyState = CLOSED;
      ws.dispatchEvent(closeEvent(code || 1000, reason || '', wasClean !== false));
    }
    function fail(ws) {
      if (ws._closed) return;
      ws.dispatchEvent(new Event('error'));
      finish(ws, 1006, '', false);
    }
    function ZPWebSocket(url, protocols) {
      if (arguments.length < 1)
        throw new TypeError("Failed to construct 'WebSocket': 1 argument required, but only 0 present.");
      this.url = targetWSURL(url);
      this.protocol = '';
      this.extensions = '';
      this.readyState = CONNECTING;
      this.bufferedAmount = 0;
      this.binaryType = 'blob';
      this._port = null;
      this._closed = false;
      const plist = protocolList(protocols);
      postMessageToSW({
        type: 'ZP_WS_OPEN',
        url: this.url,
        protocols: plist,
        tabId: boot.tabId,
        documentUrl: currentDocumentURL(),
      })
        .then((reply) => attachSocketPort(this, reply, OPEN, finish, fail))
        .catch(() => fail(this));
    }
    function attachSocketPort(ws, reply, openState, finish, fail) {
      if (closePendingSocket(ws, reply)) return;
      ws.protocol = String(reply.protocol || '');
      ws._port = reply.port;
      ws._port.onmessage = (ev) => handleSocketPortMessage(ws, ev.data || {}, finish, fail);
      ws._port.start && ws._port.start();
      ws.readyState = openState;
      ws.dispatchEvent(new Event('open'));
    }
    function closePendingSocket(ws, reply) {
      if (!ws._closed) return false;
      try {
        reply.port && reply.port.postMessage({ type: 'close' });
      } catch {}
      return true;
    }
    function handleSocketPortMessage(ws, m, finish, fail) {
      if (m.type === 'message') {
        dispatchSocketMessage(ws, m.data);
      } else if (m.type === 'error') {
        fail(ws);
      } else if (m.type === 'close') {
        finish(ws, m.code || 1000, m.reason || '', true);
      }
    }
    function dispatchSocketMessage(ws, data) {
      const payload = socketMessageData(ws, data);
      ws.dispatchEvent(new MessageEvent('message', { data: payload, origin: new URL(ws.url).origin }));
    }
    function socketMessageData(ws, data) {
      if (ws.binaryType === 'blob' && data instanceof ArrayBuffer && Native.Blob) return new Native.Blob([data]);
      return data;
    }
    ZPWebSocket.CONNECTING = CONNECTING;
    ZPWebSocket.OPEN = OPEN;
    ZPWebSocket.CLOSING = CLOSING;
    ZPWebSocket.CLOSED = CLOSED;
    ZPWebSocket.prototype = { CONNECTING, OPEN, CLOSING, CLOSED };
    installEventMethods(ZPWebSocket.prototype);
    Object.assign(ZPWebSocket.prototype, {
      constructor: ZPWebSocket,
      send(data) {
        if (this.readyState !== OPEN || !this._port) throw normalizedError('InvalidStateError');
        if (Native.Blob && data instanceof Native.Blob) {
          data
            .arrayBuffer()
            .then((buf) => {
              if (this.readyState === OPEN && this._port) this._port.postMessage({ type: 'send', data: buf });
            })
            .catch(() => fail(this));
          return;
        }
        this._port.postMessage({ type: 'send', data });
      },
      close(code = 1000, reason = '') {
        if (this._closed || this.readyState === CLOSING || this.readyState === CLOSED) return;
        this.readyState = CLOSING;
        if (this._port) this._port.postMessage({ type: 'close', code, reason });
        finish(this, code, reason, true);
      },
    });
    define(root, 'WebSocket', ZPWebSocket);
  }

  function installWebSocketStream() {
    if (!root.WebSocket || !root.ReadableStream || !root.WritableStream) return;
    function ZPWebSocketStream(url, options = {}) {
      if (!(this instanceof ZPWebSocketStream))
        throw new TypeError("Failed to construct 'WebSocketStream': Please use the 'new' operator.");
      let closeResolve;
      this.closed = new Promise((resolve) => {
        closeResolve = resolve;
      });
      this.opened = new Promise((resolve, reject) => {
        let ws;
        let settled = false;
        let controllerReadable = null;
        const failOpen = (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        };
        try {
          ws = new root.WebSocket(url, options && options.protocols);
          ws.binaryType = 'arraybuffer';
          const readable = new root.ReadableStream({
            start(controller) {
              controllerReadable = controller;
            },
            cancel() {
              try {
                ws.close();
              } catch {}
            },
          });
          const writable = new root.WritableStream({
            write(chunk) {
              ws.send(chunk);
            },
            close() {
              ws.close();
            },
            abort() {
              ws.close();
            },
          });
          ws.onopen = () => {
            settled = true;
            resolve({ readable, writable, protocol: ws.protocol, extensions: ws.extensions || '' });
          };
          ws.onmessage = (event) => {
            if (controllerReadable) controllerReadable.enqueue(event.data);
          };
          ws.onerror = (err) => {
            if (!settled) failOpen(err);
            else errorReadable(controllerReadable, err);
          };
          ws.onclose = (event) => {
            if (!settled) failOpen(normalizedError('NetworkError'));
            try {
              controllerReadable && controllerReadable.close();
            } catch {}
            closeResolve({ closeCode: event.code, reason: event.reason });
          };
        } catch (err) {
          failOpen(err);
        }
      });
    }
    try {
      Object.defineProperty(ZPWebSocketStream, 'name', {
        value: 'WebSocketStream',
        configurable: true,
      });
    } catch {}
    ZPWebSocketStream.prototype.constructor = ZPWebSocketStream;
    maskNativeFunction(ZPWebSocketStream, 'WebSocketStream');
    define(root, 'WebSocketStream', ZPWebSocketStream);
  }

  function errorReadable(controllerReadable, err) {
    if (!controllerReadable) return;
    try {
      controllerReadable.error(err);
    } catch {}
  }

  return { installWebSocket, installWebSocketStream };
}
