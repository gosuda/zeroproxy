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

  function workerBootstrapBlobURL(sourceURL) {
    const params = new URLSearchParams();
    for (const server of activeServers) reflectApply(urlSearchParamsAppend, params, ['server', server]);
    const virtualURL = currentVirtualURL();
    const workerLocation = virtualBlobWorkerLocation(sourceURL);
    const body = [
      "const __zp_URLSearchParams=URLSearchParams;\n",
      "const __zp_native_importScripts=importScripts.bind(self);\n",
      "self.__ZP_WORKER_TARGET=", JSON.stringify(virtualURL.href), ";\n",
      "self.__ZP_WORKER_LOCATION=", JSON.stringify(workerLocation), ";\n",
      "self.__ZP_WORKER_TAB_ID=", JSON.stringify(boot.tabId), ";\n",
      "self.__ZP_WORKER_RUNTIME_TOKEN=", JSON.stringify(runtimeToken), ";\n",
      "self.__ZP_WORKER_PROXY_ORIGIN=", JSON.stringify(proxyOrigin), ";\n",
      "self.__ZP_WORKER_SERVERS=new __zp_URLSearchParams(", JSON.stringify(reflectApply(urlSearchParamsToString, params, [])), ").getAll('server');\n",
      "__zp_native_importScripts(", JSON.stringify(`${proxyOrigin}/zp/assets/worker-prelude.js`), ");\n",
      "__zp_native_importScripts(", JSON.stringify(sourceURL), ");\n"
    ];
    const wrapper = new Blob(body, { type: 'text/javascript' });
    const wrapperURL = Native.createObjectURL(wrapper);
    workerBlobURLs.add(wrapperURL);
    return wrapperURL;
  }

  function virtualBlobWorkerLocation(sourceURL) {
    const virtualURL = currentVirtualURL();
    try {
      const parsed = new URL(String(sourceURL));
      if (parsed.protocol === 'blob:') {
        const pathname = parsed.pathname || '';
        const id = pathname.slice(pathname.lastIndexOf('/') + 1);
        if (id) return `blob:${virtualURL.origin}/${id}`;
      }
    } catch {}
    return virtualURL.href;
  }

  function scriptBlobURLForPage(sourceURL, blob) {
    const type = String(blob && blob.type || '').toLowerCase();
    if (!type || (!/(?:^|[+/.-])(?:javascript|ecmascript)(?:$|[;])/i.test(type) && type !== 'text/javascript' && type !== 'application/javascript')) return String(sourceURL);
    return virtualBlobWorkerLocation(sourceURL);
  }

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
    if (root.navigator && root.navigator.serviceWorker && root.navigator.serviceWorker.register) define(root.navigator.serviceWorker, 'register', function() { return Promise.resolve(undefined); });
    if (Native.createObjectURL) installCreateObjectURLHook();
    if (Native.revokeObjectURL) installRevokeObjectURLHook();
    installWorkletModuleHooks();
  }

  function installWorkerConstructor() {
    installWorkerTerminateHook();
    const ZPWorker = function Worker(url) {
      const blobWorker = isBlobWorkerURL(url);
      const opts = arguments[1];
      const worker = new Native.Worker(workerBootstrapURL(url, workerKindForOptions(opts)), bootstrapWorkerOptions(opts));
      if (blobWorker) {
        try { deferredTerminateWorkers.add(worker); } catch {}
      }
      return worker;
    };
    try { objectSetPrototypeOf(ZPWorker, Native.Worker); } catch {}
    try { objectDefineProperty(ZPWorker, 'prototype', { value: Native.Worker.prototype, enumerable: false, configurable: false, writable: false }); } catch {}
    try { objectDefineProperty(Native.Worker.prototype, 'constructor', { value: ZPWorker, enumerable: false, configurable: true, writable: true }); } catch {}
    maskNativeFunction(ZPWorker, 'Worker');
    try { objectDefineProperty(root, 'Worker', { value: ZPWorker, enumerable: false, configurable: true, writable: true }); } catch {}
  }

  function installSharedWorkerConstructor() {
    const ZPSharedWorker = function SharedWorker(url) {
      const opts = arguments[1];
      return new Native.SharedWorker(workerBootstrapURL(url, workerKindForOptions(opts)), bootstrapWorkerOptions(opts));
    };
    try { objectSetPrototypeOf(ZPSharedWorker, Native.SharedWorker); } catch {}
    try { objectDefineProperty(ZPSharedWorker, 'prototype', { value: Native.SharedWorker.prototype, enumerable: false, configurable: false, writable: false }); } catch {}
    try { objectDefineProperty(Native.SharedWorker.prototype, 'constructor', { value: ZPSharedWorker, enumerable: false, configurable: true, writable: true }); } catch {}
    maskNativeFunction(ZPSharedWorker, 'SharedWorker');
    try { objectDefineProperty(root, 'SharedWorker', { value: ZPSharedWorker, enumerable: false, configurable: true, writable: true }); } catch {}
  }

  function installCreateObjectURLHook() {
    const createObjectURL = function createObjectURL(blob) {
      const url = Native.createObjectURL(blob);
      try {
        if (typeof Blob !== 'undefined' && blob instanceof Blob) {
          const virtual = scriptBlobURLForPage(url, blob);
          const wrapper = workerBootstrapBlobURL(url);
          workerBlobURLMap.set(url, wrapper);
          if (virtual !== url) {
            blobURLRawMap.set(virtual, url);
            workerBlobURLMap.set(virtual, wrapper);
            return virtual;
          }
        }
      } catch {}
      return url;
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
        const nativeAddModule = wk.addModule;
        define(wk, 'addModule', function(url, opts){ return reflectApply(nativeAddModule, wk, [workerBootstrapURL(url), opts]); });
      }
    }
  }

  function isBlobWorkerURL(url) {
    try { return new URL(String(url), currentVirtualURL().href).protocol === 'blob:'; } catch { return false; }
  }

  function workerKindForOptions(opts) {
    return opts && typeof opts === 'object' && String(opts.type || '').toLowerCase() === 'module' ? 'module' : 'worker';
  }

  function workerBootstrapURL(url, kind) {
    const raw = String(url);
    const parsed = new URL(raw, currentVirtualURL().href);
    if (parsed.protocol === 'blob:') {
      const wrapped = workerBlobURLMap.get(parsed.href) || parsed.href;
      if (!workerBlobURLs.has(wrapped)) throw normalizedError('NotSupportedError');
      return wrapped;
    }
    if (parsed.protocol === 'data:') return dataWorkerURL(parsed.href);
    const params = new URLSearchParams();
    reflectApply(urlSearchParamsSet, params, ['u', requestTargetURL(raw)]);
    reflectApply(urlSearchParamsSet, params, ['loc', requestTargetURL(raw)]);
    reflectApply(urlSearchParamsSet, params, ['tab', boot.tabId]);
    reflectApply(urlSearchParamsSet, params, ['rt', runtimeToken]);
    for (const server of activeServers) reflectApply(urlSearchParamsAppend, params, ['server', server]);
    const bootstrapKind = kind === 'module' ? '?kind=module' : '';
    return `${ZP.controlPath('worker-bootstrap.js')}${bootstrapKind}#${reflectApply(urlSearchParamsToString, params, [])}`;
  }

  function bootstrapWorkerOptions(opts) {
    if (!opts || typeof opts !== 'object') return opts;
    const out = objectAssign({}, opts);
    if (String(out.type || '').toLowerCase() === 'module') out.type = 'module';
    else delete out.type;
    return out;
  }

  function dataWorkerURL(raw) {
    const comma = raw.indexOf(',');
    if (comma < 0) throw normalizedError('NotSupportedError');
    const virtualURL = currentVirtualURL();
    const blocked = new Blob(["const __zp_DOMException=DOMException;\nconst __zp_importScripts=importScripts.bind(self);\nself.__ZP_WORKER_TARGET=", JSON.stringify(virtualURL.href), ";\nself.__ZP_WORKER_LOCATION=", JSON.stringify(raw), ";\nself.__ZP_WORKER_TAB_ID=", JSON.stringify(boot.tabId), ";\nself.__ZP_WORKER_PROXY_ORIGIN=", JSON.stringify(proxyOrigin), ";\n__zp_importScripts(", JSON.stringify(`${proxyOrigin}/zp/assets/worker-prelude.js`), ");\nthrow new __zp_DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');\n"], { type: 'text/javascript' });
    const safe = Native.createObjectURL(blocked);
    workerBlobURLs.add(safe);
    return safe;
  }

  return { installWorkerHooks };
}
