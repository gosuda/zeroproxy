export async function resolveAsyncWasm(options, defaultUrl) {
  if (options != null && typeof options === 'object') {
    if (options.wasmModule != null) return options.wasmModule;
    if (options.wasmBytes != null) return options.wasmBytes;
    if (options.wasmUrl != null) return options.wasmUrl;
  }
  return defaultUrl;
}

export function resolveSyncWasm(options) {
  if (options != null && typeof options === 'object') {
    if (options.wasmModule != null) return options.wasmModule;
    if (options.wasmBytes != null) return options.wasmBytes;
  }
  throw new TypeError(
    'Synchronous WebAssembly initialization in browser runtimes requires { wasmModule } or { wasmBytes }; use the async factory or @gosuda/zeroproxy/rewriter/inline.',
  );
}
