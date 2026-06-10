export function createWorkerFacades({
  root,
  Native,
  boot,
  runtimeToken,
  proxyOrigin,
  activeServers,
  currentVirtualURL,
  define,
  maskNativeFunction,
  normalizedError,
  requestTargetURL,
}) {
  const {
    Blob = globalThis.Blob,
    Map = globalThis.Map,
    Object = globalThis.Object,
    Promise = globalThis.Promise,
    Set = globalThis.Set,
    String = globalThis.String,
    URL = globalThis.URL,
    URLSearchParams = globalThis.URLSearchParams,
    WeakSet = globalThis.WeakSet,
    objectAssign = globalThis.Object.assign,
    objectDefineProperty = globalThis.Object.defineProperty,
    objectSetPrototypeOf = globalThis.Object.setPrototypeOf,
    reflectApply = globalThis.Reflect.apply,
    urlSearchParamsAppend = globalThis.URLSearchParams.prototype.append,
    urlSearchParamsSet = globalThis.URLSearchParams.prototype.set,
    urlSearchParamsToString = globalThis.URLSearchParams.prototype.toString,
  } = Native;
  const workerBlobURLs = new Set();
  const workerBlobURLMap = new Map();
  const blobURLRawMap = new Map();
  const deferredTerminateWorkers = new WeakSet();
  let workerTerminateHooked = false;




  function installWorkerTerminateHook() {
    if (workerTerminateHooked || !Native.Worker || !Native.Worker.prototype) return;
    const nativeTerminate = Native.Worker.prototype.terminate;
    if (typeof nativeTerminate !== 'function') return;
    const terminate = function terminate() {
      if (deferredTerminateWorkers.has(this)) {
        const callTerminate = () => reflectApply(nativeTerminate, this, []);
        try { (Native.setTimeout || setTimeout)(callTerminate, 250); }
        catch { callTerminate(); }
        return undefined;
      }
      return reflectApply(nativeTerminate, this, []);
    };
    try { objectDefineProperty(terminate, 'name', { value: 'terminate', configurable: true }); } catch {}
    maskNativeFunction(terminate, 'terminate');
    try {
      objectDefineProperty(Native.Worker.prototype, 'terminate', { value: terminate, enumerable: true, configurable: true, writable: true });
      workerTerminateHooked = true;
    } catch {}
  }

  function installWorkerHooks() {
    if (Native.Worker) installWorkerConstructor();
    if (Native.SharedWorker) installSharedWorkerConstructor();
    if (Native.createObjectURL) installCreateObjectURLHook();
    if (Native.revokeObjectURL) installRevokeObjectURLHook();
    installWorkletModuleHooks();
  }

  function installWorkerConstructor() {
    const ZPWorker = function Worker() {
      throw normalizedError('NotSupportedError');
    };
    try { objectSetPrototypeOf(ZPWorker, Native.Worker); } catch {}
    try { objectDefineProperty(ZPWorker, 'prototype', { value: Native.Worker.prototype, enumerable: false, configurable: false, writable: false }); } catch {}
    try { objectDefineProperty(Native.Worker.prototype, 'constructor', { value: ZPWorker, enumerable: false, configurable: true, writable: true }); } catch {}
    maskNativeFunction(ZPWorker, 'Worker');
    try { objectDefineProperty(root, 'Worker', { value: ZPWorker, enumerable: false, configurable: true, writable: true }); } catch {}
  }

  function installSharedWorkerConstructor() {
    const ZPSharedWorker = function SharedWorker() {
      throw normalizedError('NotSupportedError');
    };
    try { objectSetPrototypeOf(ZPSharedWorker, Native.SharedWorker); } catch {}
    try { objectDefineProperty(ZPSharedWorker, 'prototype', { value: Native.SharedWorker.prototype, enumerable: false, configurable: false, writable: false }); } catch {}
    try { objectDefineProperty(Native.SharedWorker.prototype, 'constructor', { value: ZPSharedWorker, enumerable: false, configurable: true, writable: true }); } catch {}
    maskNativeFunction(ZPSharedWorker, 'SharedWorker');
    try { objectDefineProperty(root, 'SharedWorker', { value: ZPSharedWorker, enumerable: false, configurable: true, writable: true }); } catch {}
  }

  function installCreateObjectURLHook() {
    const createObjectURL = function createObjectURL(blob) {
      return Native.createObjectURL(blob);
    };
    try { objectDefineProperty(createObjectURL, 'name', { value: 'createObjectURL', configurable: true }); } catch {}
    maskNativeFunction(createObjectURL, 'createObjectURL');
    try { objectDefineProperty(URL, 'createObjectURL', { value: createObjectURL, enumerable: true, configurable: true, writable: true }); } catch {}
  }

  function installRevokeObjectURLHook() {
    const revokeObjectURL = function revokeObjectURL(url) {
      const visible = String(url);
      const raw = blobURLRawMap.get(visible) || visible;
      const workerURL = workerBlobURLMap.get(visible) || workerBlobURLMap.get(raw);
      blobURLRawMap.delete(visible);
      workerBlobURLMap.delete(visible);
      workerBlobURLMap.delete(raw);
      if (workerURL) {
        const revokeWorkerURL = () => {
          workerBlobURLs.delete(workerURL);
          try { Native.revokeObjectURL(workerURL); } catch {}
          try { Native.revokeObjectURL(raw); } catch {}
        };
        try { (Native.setTimeout || setTimeout)(revokeWorkerURL, 30000); } catch { revokeWorkerURL(); }
        return undefined;
      }
      return Native.revokeObjectURL(raw);
    };
    try { objectDefineProperty(revokeObjectURL, 'name', { value: 'revokeObjectURL', configurable: true }); } catch {}
    maskNativeFunction(revokeObjectURL, 'revokeObjectURL');
    try { objectDefineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, enumerable: true, configurable: true, writable: true }); } catch {}
  }

  function installWorkletModuleHooks() {
    for (const name of ['audioWorklet','paintWorklet','layoutWorklet','animationWorklet']) {
      const wk = root.CSS && root.CSS[name] || root[name];
      if (wk && wk.addModule) {
        define(wk, 'addModule', function(){ return Promise.reject(normalizedError('NotSupportedError')); });
      }
    }
  }






  return { installWorkerHooks };
}
