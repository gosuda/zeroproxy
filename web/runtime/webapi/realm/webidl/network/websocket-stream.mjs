export function createWebSocketStreamFacades(DOMExceptionBase) {
  const webSocketErrorState = new WeakMap();
  class WebSocketError extends DOMExceptionBase {
    constructor(message = '', options = {}) {
      const closeCode = normalizeCloseCode(options.closeCode, DOMExceptionBase);
      super(String(message), 'WebSocketError');
      webSocketErrorState.set(this, {
        closeCode,
        reason: options.reason === undefined ? '' : String(options.reason),
      });
    }
  }
  Object.defineProperty(WebSocketError, 'name', { value: 'WebSocketError', configurable: true });
  Object.defineProperties(WebSocketError.prototype, {
    closeCode: { get() { return webSocketErrorValue(webSocketErrorState, this, 'closeCode'); }, enumerable: true, configurable: true },
    reason: { get() { return webSocketErrorValue(webSocketErrorState, this, 'reason'); }, enumerable: true, configurable: true },
  });
  Object.defineProperty(WebSocketError.prototype, Symbol.toStringTag, { value: 'WebSocketError', configurable: true });

  class WebSocketStream {
    constructor(url) {
      validateWebSocketStreamURL(url);
      throw new DOMExceptionBase('WebSocketStream is disabled by policy.', 'NotSupportedError');
    }
  }
  Object.defineProperty(WebSocketStream, 'name', { value: 'WebSocketStream', configurable: true });
  Object.defineProperty(WebSocketStream.prototype, Symbol.toStringTag, { value: 'WebSocketStream', configurable: true });

  return { WebSocketError, WebSocketStream };
}

function webSocketErrorValue(stateMap, value, key) {
  const state = stateMap.get(value);
  if (!state) throw new TypeError('Illegal invocation');
  return state[key];
}

function normalizeCloseCode(value, DOMExceptionBase) {
  if (value === undefined || value === null) return null;
  const closeCode = Number(value);
  if (closeCode === 1000 || (closeCode >= 3000 && closeCode <= 4999)) return closeCode;
  throw new DOMExceptionBase('The close code must be either 1000, or between 3000 and 4999.', 'InvalidAccessError');
}

function validateWebSocketStreamURL(url) {
  const parsed = new URL(String(url), globalThis.location?.href || 'https://example.invalid/');
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new SyntaxError("Failed to construct 'WebSocketStream': The URL protocol must be 'ws:' or 'wss:'.");
}
