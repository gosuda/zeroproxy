export function createWorkerPolicyFacades(DOMExceptionBase) {
  const EventTargetBase = typeof globalThis.EventTarget === 'function' ? globalThis.EventTarget : class {};
  class Worker extends EventTargetBase {
    constructor() {
      throw new DOMExceptionBase('Worker construction is disabled by policy.', 'NotSupportedError');
    }
    postMessage() { throw new DOMExceptionBase('Worker construction is disabled by policy.', 'NotSupportedError'); }
    terminate() {}
  }
  Object.defineProperty(Worker, 'name', { value: 'Worker', configurable: true });
  Object.defineProperty(Worker.prototype, Symbol.toStringTag, { value: 'Worker', configurable: true });

  class SharedWorker extends EventTargetBase {
    constructor() {
      throw new DOMExceptionBase('SharedWorker construction is disabled by policy.', 'NotSupportedError');
    }
  }
  Object.defineProperty(SharedWorker, 'name', { value: 'SharedWorker', configurable: true });
  Object.defineProperty(SharedWorker.prototype, Symbol.toStringTag, { value: 'SharedWorker', configurable: true });

  return { Worker, SharedWorker };
}
