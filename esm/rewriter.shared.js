import initPageBundle, {
  bundleVersion,
  initSync as initPageBundleSync,
  rewriteScript,
} from './wbg/zp-page-bundle.js';

export const SCRIPT_KINDS = Object.freeze([
  'classic',
  'classic-local',
  'module',
  'event-handler',
  'eval',
  'function',
  'worker',
]);

const DEFAULT_WASM_URL = new URL('./wasm/zp-page-bundle.wasm', import.meta.url);
let wasmInitialized = false;
let wasmInitPromise = null;

function buildRewriterHandle(options = {}) {
  const defaultProxyOrigin = options && options.proxyOrigin != null ? String(options.proxyOrigin) : '';
  return Object.freeze({
    version: bundleVersion(),
    proxyOrigin: defaultProxyOrigin,
    rewriteScript(source, callOptions) {
      if (!callOptions || typeof callOptions.targetUrl !== 'string' || callOptions.targetUrl.length === 0) {
        throw new TypeError('rewriteScript requires options.targetUrl');
      }
      const kind = callOptions.kind != null ? String(callOptions.kind) : 'classic';
      const proxyOrigin = callOptions.proxyOrigin != null ? String(callOptions.proxyOrigin) : defaultProxyOrigin;
      return rewriteScript(String(source), kind, callOptions.targetUrl, proxyOrigin);
    },
  });
}

export function bindRewriterLoaders(resolveAsyncWasm, resolveSyncWasm) {
  let loaderReady = false;

  async function createRewriter(options = {}) {
    if (!loaderReady) {
      const moduleOrPath = await resolveAsyncWasm(options, DEFAULT_WASM_URL, 'zp-page-bundle.wasm');
      if (!wasmInitialized) {
        if (!wasmInitPromise) {
          const p = Promise.resolve(initPageBundle({ module_or_path: moduleOrPath })).then(() => {
            wasmInitialized = true;
          });
          p.catch(() => { wasmInitPromise = null; });
          wasmInitPromise = p;
        }
        await wasmInitPromise;
      }
      loaderReady = true;
    }
    return buildRewriterHandle(options);
  }

  function createRewriterSync(options = {}) {
    if (!loaderReady) {
      const moduleSource = resolveSyncWasm(options, DEFAULT_WASM_URL, 'zp-page-bundle.wasm');
      if (!wasmInitialized) {
        initPageBundleSync({ module: moduleSource });
        wasmInitialized = true;
      }
      loaderReady = true;
    }
    return buildRewriterHandle(options);
  }

  return { createRewriter, createRewriterSync };
}
