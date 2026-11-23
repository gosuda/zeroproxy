export async function resolveAsyncWasm(options, _defaultUrl, wasmName = 'zp-bundle.wasm') {
  if (options != null && typeof options === 'object') {
    if (options.wasmModule != null) return options.wasmModule;
    if (options.wasmBytes != null) return options.wasmBytes;
    if (options.wasmUrl != null) return options.wasmUrl;
  }
  throw new TypeError(
    `Edge/workerd runtimes disallow dynamic filesystem WASM reads; import wasmMod from "@gosuda/zeroproxy/wasm/${wasmName}" and pass { wasmModule: wasmMod }.`,
  );
}

export function resolveSyncWasm(options, _defaultUrl, wasmName = 'zp-bundle.wasm') {
  if (options != null && typeof options === 'object') {
    if (options.wasmModule != null) return options.wasmModule;
    if (options.wasmBytes != null) return options.wasmBytes;
  }
  throw new TypeError(
    `Edge/workerd runtimes require a pre-compiled WebAssembly.Module; import wasmMod from "@gosuda/zeroproxy/wasm/${wasmName}" and pass { wasmModule: wasmMod }.`,
  );
}
