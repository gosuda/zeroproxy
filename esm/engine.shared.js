import initBundle, {
  buildCSP,
  buildCSPWith,
  bundleVersion,
  composeSourceMap,
  composeSourceMapChained,
  HtmlTxn,
  initSync as initBundleSync,
  isChallengeDocument,
  rewriteCSS,
  rewriteScript,
  transformHtml,
} from './wbg/zp-bundle.js';
import { SCRIPT_KINDS } from './rewriter.shared.js';

export { SCRIPT_KINDS };

const DEFAULT_WASM_URL = new URL('./wasm/zp-bundle.wasm', import.meta.url);
const te = new TextEncoder();
let wasmInitialized = false;
let wasmInitPromise = null;

function toUtf8Bytes(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return te.encode(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  throw new TypeError('HtmlStreamSession.write expects a Uint8Array, ArrayBuffer, or string chunk');
}

function createHtmlStreamSessionInternal(defaultProxyOrigin, options) {
  if (!options || typeof options.targetUrl !== 'string' || options.targetUrl.length === 0) {
    throw new TypeError('HTML transform requires options.targetUrl');
  }
  const proxyOrigin = options.proxyOrigin != null ? String(options.proxyOrigin) : defaultProxyOrigin;
  const preludeHtml = options.preludeHtml != null ? String(options.preludeHtml) : '';
  let txn = new HtmlTxn(options.targetUrl, proxyOrigin, preludeHtml);
  let ended = false;

  function dispose() {
    if (txn !== null) {
      const current = txn;
      txn = null;
      ended = true;
      current.free();
    }
  }

  const session = {
    write(chunk) {
      if (ended || txn === null) {
        throw new Error('HtmlStreamSession: write called after end or dispose');
      }
      const bytes = toUtf8Bytes(chunk);
      try {
        return txn.write(bytes);
      } catch (err) {
        dispose();
        throw err;
      }
    },
    end() {
      if (ended || txn === null) {
        throw new Error('HtmlStreamSession: end called after end or dispose');
      }
      ended = true;
      try {
        return txn.end();
      } finally {
        dispose();
      }
    },
    dispose,
  };

  if (typeof Symbol.dispose === 'symbol') {
    session[Symbol.dispose] = dispose;
  }
  return Object.freeze(session);
}

function buildEngineHandle(options = {}) {
  const defaultProxyOrigin = options && options.proxyOrigin != null ? String(options.proxyOrigin) : '';
  const defaultControlPrefix = options && options.controlPrefix != null ? String(options.controlPrefix) : '/zp/';

  return Object.freeze({
    version: bundleVersion(),
    proxyOrigin: defaultProxyOrigin,
    controlPrefix: defaultControlPrefix,

    rewriteScript(source, callOptions) {
      if (!callOptions || typeof callOptions.targetUrl !== 'string' || callOptions.targetUrl.length === 0) {
        throw new TypeError('rewriteScript requires options.targetUrl');
      }
      const kind = callOptions.kind != null ? String(callOptions.kind) : 'classic';
      const proxyOrigin = callOptions.proxyOrigin != null ? String(callOptions.proxyOrigin) : defaultProxyOrigin;
      return rewriteScript(String(source), kind, callOptions.targetUrl, proxyOrigin);
    },

    transformHtml(html, callOptions) {
      if (!callOptions || typeof callOptions.targetUrl !== 'string' || callOptions.targetUrl.length === 0) {
        throw new TypeError('transformHtml requires options.targetUrl');
      }
      const proxyOrigin = callOptions.proxyOrigin != null ? String(callOptions.proxyOrigin) : defaultProxyOrigin;
      return transformHtml(String(html), callOptions.targetUrl, proxyOrigin);
    },

    createHtmlStreamSession(callOptions) {
      return createHtmlStreamSessionInternal(defaultProxyOrigin, callOptions);
    },

    createHtmlTransformStream(callOptions) {
      const session = createHtmlStreamSessionInternal(defaultProxyOrigin, callOptions);
      return new TransformStream({
        transform(chunk, controller) {
          const out = session.write(chunk);
          if (out.byteLength > 0) controller.enqueue(out);
        },
        flush(controller) {
          const tail = session.end();
          if (tail.byteLength > 0) controller.enqueue(tail);
        },
        cancel() {
          session.dispose();
        },
      });
    },

    rewriteCSS(source, callOptions) {
      if (!callOptions || typeof callOptions.baseUrl !== 'string' || callOptions.baseUrl.length === 0) {
        throw new TypeError('rewriteCSS requires options.baseUrl');
      }
      const controlPrefix = callOptions.controlPrefix != null ? String(callOptions.controlPrefix) : defaultControlPrefix;
      const proxyOrigin = callOptions.proxyOrigin != null ? String(callOptions.proxyOrigin) : defaultProxyOrigin;
      return rewriteCSS(String(source), callOptions.baseUrl, controlPrefix, proxyOrigin);
    },

    composeSourceMap(source, callOptions) {
      if (!callOptions || typeof callOptions.targetUrl !== 'string' || callOptions.targetUrl.length === 0) {
        throw new TypeError('composeSourceMap requires options.targetUrl');
      }
      const kind = callOptions.kind != null ? String(callOptions.kind) : 'classic';
      const proxyOrigin = callOptions.proxyOrigin != null ? String(callOptions.proxyOrigin) : defaultProxyOrigin;
      return composeSourceMap(String(source), kind, callOptions.targetUrl, proxyOrigin);
    },

    composeSourceMapChained(source, callOptions) {
      if (!callOptions || typeof callOptions.targetUrl !== 'string' || callOptions.targetUrl.length === 0) {
        throw new TypeError('composeSourceMapChained requires options.targetUrl');
      }
      const kind = callOptions.kind != null ? String(callOptions.kind) : 'classic';
      const originalMapJson = callOptions.originalMapJson != null ? String(callOptions.originalMapJson) : '';
      const proxyOrigin = callOptions.proxyOrigin != null ? String(callOptions.proxyOrigin) : defaultProxyOrigin;
      return composeSourceMapChained(String(source), kind, callOptions.targetUrl, originalMapJson, proxyOrigin);
    },

    buildCSP(callOptions) {
      if (!callOptions || typeof callOptions.wsOrigin !== 'string' || callOptions.wsOrigin.length === 0) {
        throw new TypeError('buildCSP requires options.wsOrigin');
      }
      if (callOptions.challengeCompat === true) {
        return buildCSPWith(callOptions.wsOrigin, true);
      }
      return buildCSP(callOptions.wsOrigin);
    },

    isChallengeDocument(input) {
      if (!input || typeof input !== 'object') {
        throw new TypeError('isChallengeDocument requires { cfMitigated, host, path }');
      }
      return isChallengeDocument(
        String(input.cfMitigated || ''),
        String(input.host || ''),
        String(input.path || ''),
      );
    },
  });
}

export function bindEngineLoaders(resolveAsyncWasm, resolveSyncWasm) {
  let loaderReady = false;

  async function createEngine(options = {}) {
    if (!loaderReady) {
      const moduleOrPath = await resolveAsyncWasm(options, DEFAULT_WASM_URL, 'zp-bundle.wasm');
      if (!wasmInitialized) {
        if (!wasmInitPromise) {
          const p = Promise.resolve(initBundle({ module_or_path: moduleOrPath })).then(() => {
            wasmInitialized = true;
          });
          p.catch(() => { wasmInitPromise = null; });
          wasmInitPromise = p;
        }
        await wasmInitPromise;
      }
      loaderReady = true;
    }
    return buildEngineHandle(options);
  }

  function createEngineSync(options = {}) {
    if (!loaderReady) {
      const moduleSource = resolveSyncWasm(options, DEFAULT_WASM_URL, 'zp-bundle.wasm');
      if (!wasmInitialized) {
        initBundleSync({ module: moduleSource });
        wasmInitialized = true;
      }
      loaderReady = true;
    }
    return buildEngineHandle(options);
  }

  return { createEngine, createEngineSync };
}
