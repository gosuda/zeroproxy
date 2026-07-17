import { createPublicError, normalizePublicError } from "../generated/errors.mjs";
const DEFAULT_TIMEOUT_MS = 10_000;

export function createCoordinatorClient({
  worker = new SharedWorker("/control/coordinator.mjs", { type: "module", name: "zeroproxy-v2-profile-coordinator" }),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const pending = new Map();
  let revision = null;
  worker.port.start();
  worker.port.onmessage = (event) => {
    const message = event.data;
    const slot = pending.get(message?.request_id);
    if (Number.isSafeInteger(message?.revision) && message.revision >= 0) {
      revision = Math.max(revision ?? 0, message.revision);
    }
    if (!slot) return;
    pending.delete(message.request_id);
    clearTimeout(slot.timer);
    if (message.ok) slot.resolve(message.result);
    else {
      let publicError;
      try {
        publicError = normalizePublicError(message.error);
        if (publicError.request_id !== message.request_id) throw new TypeError("mismatched error request ID");
      } catch {
        publicError = createPublicError("MESSAGE_SCHEMA", message.request_id);
      }
      const error = new DOMException(
        publicError.message_key,
        "InvalidStateError",
      );
      Object.defineProperty(error, "code", { configurable: true, value: publicError.code });
      error.revision = message.revision;
      slot.reject(error);
    }
  };
  return Object.freeze({
    command(operation, payload = {}) {
      const request_id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.delete(request_id)) reject(new DOMException("Coordinator timeout", "TimeoutError"));
        }, timeoutMs);
        pending.set(request_id, { resolve, reject, timer });
        worker.port.postMessage({ v: 2, request_id, operation, expected_revision: revision, payload });
      });
    },
    close() {
      for (const slot of pending.values()) {
        clearTimeout(slot.timer);
        slot.reject(new DOMException("Coordinator client closed", "AbortError"));
      }
      pending.clear();
      worker.port.close();
    },
  });
}

export function opaqueID() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
