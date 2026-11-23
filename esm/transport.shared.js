import initKernel, {
  initSync as initKernelSync,
  kernelFetch,
  kernelInit,
  kernelSetCapturedSpec,
  kernelStream,
  kernelVersion,
} from './wbg/zp-kernel.js';

const DEFAULT_WASM_URL = new URL('./wasm/zp-kernel.wasm', import.meta.url);
let wasmInitialized = false;
let wasmInitPromise = null;

function buildKernelHandle(options = {}) {
  const banner = kernelInit();
  if (options && typeof options.capturedClientHelloSpec === 'string' && options.capturedClientHelloSpec.length > 0) {
    kernelSetCapturedSpec(options.capturedClientHelloSpec);
  }
  return Object.freeze({
    version: kernelVersion(),
    banner,
    setCapturedClientHello(base64JsonSpec) {
      kernelSetCapturedSpec(String(base64JsonSpec || ''));
    },
    fetch(request) {
      if (!request || typeof request !== 'object') {
        return Promise.reject(new TypeError('TransportKernel.fetch requires a Request or descriptor object'));
      }
      return kernelFetch(request);
    },
    openWebSocket(streamOptions) {
      if (!streamOptions || typeof streamOptions !== 'object') {
        return Promise.reject(new TypeError('TransportKernel.openWebSocket requires an options object'));
      }
      return kernelStream(streamOptions);
    },
  });
}

export function bindTransportLoaders(resolveAsyncWasm, resolveSyncWasm) {
  let loaderReady = false;

  async function createTransportKernel(options = {}) {
    if (!loaderReady) {
      const moduleOrPath = await resolveAsyncWasm(options, DEFAULT_WASM_URL, 'zp-kernel.wasm');
      if (!wasmInitialized) {
        if (!wasmInitPromise) {
          const p = Promise.resolve(initKernel({ module_or_path: moduleOrPath })).then(() => {
            wasmInitialized = true;
          });
          p.catch(() => { wasmInitPromise = null; });
          wasmInitPromise = p;
        }
        await wasmInitPromise;
      }
      loaderReady = true;
    }
    return buildKernelHandle(options);
  }

  function createTransportKernelSync(options = {}) {
    if (!loaderReady) {
      const moduleSource = resolveSyncWasm(options, DEFAULT_WASM_URL, 'zp-kernel.wasm');
      if (!wasmInitialized) {
        initKernelSync({ module: moduleSource });
        wasmInitialized = true;
      }
      loaderReady = true;
    }
    return buildKernelHandle(options);
  }

  return { createTransportKernel, createTransportKernelSync };
}
