const HOST_FRAME_PATH = "/_zp/target-worker-host";
const READY_OPERATION = "TARGET_WORKER_HOST_READY";
const CONFIGURE_OPERATION = "CONFIGURE_TARGET_WORKER_HOST";
const DEFAULT_TIMEOUT_MS = 15_000;

function securityError(message) {
  return new DOMException(message, "SecurityError");
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function exactReadyMessage(value, binding) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 6
    && value.v === 2
    && value.operation === READY_OPERATION
    && value.profile_id === binding.profile_id
    && value.synthetic_origin === binding.synthetic_origin
    && value.client_epoch === binding.client_epoch
    && value.capability === binding.capability;
}

export class TargetWorkerHostFrames {
  #clearTimeout;
  #crypto;
  #document;
  #eventTarget;
  #frames = new Map();
  #setTimeout;
  #timeoutMS;

  constructor({
    clearTimeout: clear = value => globalThis.clearTimeout(value),
    crypto: cryptoPort = globalThis.crypto,
    document: documentPort = globalThis.document,
    eventTarget = globalThis,
    setTimeout: set = (handler, milliseconds) => globalThis.setTimeout(handler, milliseconds),
    timeoutMS = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (!documentPort || typeof documentPort.createElement !== "function"
      || !documentPort.documentElement || typeof documentPort.documentElement.append !== "function"
      || !eventTarget || typeof eventTarget.addEventListener !== "function"
      || typeof eventTarget.removeEventListener !== "function"
      || !cryptoPort || typeof cryptoPort.getRandomValues !== "function"
      || typeof clear !== "function" || typeof set !== "function"
      || !Number.isSafeInteger(timeoutMS) || timeoutMS < 1) {
      throw new TypeError("invalid target worker host frame dependencies");
    }
    this.#clearTimeout = clear;
    this.#crypto = cryptoPort;
    this.#document = documentPort;
    this.#eventTarget = eventTarget;
    this.#setTimeout = set;
    this.#timeoutMS = timeoutMS;
  }

  ensure({ destination, profile_id: profileID, client_epoch: clientEpoch }) {
    const target = new URL(destination);
    if (target.protocol !== "https:" || target.username || target.password
      || typeof profileID !== "string" || profileID.length === 0 || profileID.length > 256
      || !Number.isSafeInteger(clientEpoch) || clientEpoch < 1) {
      return Promise.reject(securityError("Target worker host binding rejected"));
    }
    const syntheticOrigin = target.origin;
    const existing = this.#frames.get(syntheticOrigin);
    if (existing?.binding.profile_id === profileID && existing.binding.client_epoch === clientEpoch) {
      return existing.ready;
    }
    if (existing) this.#remove(syntheticOrigin, existing);

    const capability = base64url(this.#crypto.getRandomValues(new Uint8Array(32)));
    if (!/^[A-Za-z0-9_-]{43}$/u.test(capability)) {
      return Promise.reject(securityError("Target worker host capability unavailable"));
    }
    const binding = Object.freeze({
      profile_id: profileID,
      synthetic_origin: syntheticOrigin,
      client_epoch: clientEpoch,
      capability,
    });
    const frame = this.#document.createElement("iframe");
    frame.hidden = true;
    frame.referrerPolicy = "no-referrer";
    frame.src = `${syntheticOrigin}${HOST_FRAME_PATH}`;

    let cleanup = () => {};
    const ready = new Promise((resolve, reject) => {
      const fail = error => {
        cleanup();
        reject(error);
      };
      const receive = event => {
        if (event.source !== frame.contentWindow || event.origin !== syntheticOrigin) return;
        if (!exactReadyMessage(event.data, binding)) {
          fail(securityError("Target worker host readiness rejected"));
          return;
        }
        cleanup();
        resolve(Object.freeze({ ...binding, frame }));
      };
      const timer = this.#setTimeout(() => {
        fail(new DOMException("Target worker host frame timed out", "TimeoutError"));
      }, this.#timeoutMS);
      cleanup = () => {
        this.#clearTimeout(timer);
        this.#eventTarget.removeEventListener("message", receive);
      };
      this.#eventTarget.addEventListener("message", receive);
      frame.addEventListener("error", () => {
        fail(new DOMException("Target worker host frame unavailable", "NetworkError"));
      }, { once: true });
      frame.addEventListener("load", () => {
        frame.contentWindow.postMessage(Object.freeze({
          v: 2,
          operation: CONFIGURE_OPERATION,
          ...binding,
        }), syntheticOrigin);
      }, { once: true });
    });
    const record = { binding, frame, ready };
    this.#frames.set(syntheticOrigin, record);
    ready.catch(() => {
      if (this.#frames.get(syntheticOrigin) === record) this.#remove(syntheticOrigin, record);
    });
    this.#document.documentElement.append(frame);
    return ready;
  }

  #remove(origin, record) {
    if (this.#frames.get(origin) === record) this.#frames.delete(origin);
    record.frame.remove();
  }
}
