import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const moduleCache = new Map();

export async function resolveAsyncWasm(options, defaultUrl) {
  if (options != null && typeof options === 'object') {
    if (options.wasmModule != null) return options.wasmModule;
    if (options.wasmBytes != null) return options.wasmBytes;
    if (options.wasmUrl != null) {
      const u = options.wasmUrl instanceof URL ? options.wasmUrl : new URL(String(options.wasmUrl), defaultUrl);
      if (u.protocol === 'file:') return readFile(u);
      return u;
    }
  }
  const key = defaultUrl.href;
  let cached = moduleCache.get(key);
  if (!cached) {
    cached = readFile(defaultUrl).then(bytes => WebAssembly.compile(bytes));
    cached.catch(() => moduleCache.delete(key));
    moduleCache.set(key, cached);
  }
  return cached;
}

export function resolveSyncWasm(options, defaultUrl) {
  if (options != null && typeof options === 'object') {
    if (options.wasmModule != null) return options.wasmModule;
    if (options.wasmBytes != null) return options.wasmBytes;
  }
  return new WebAssembly.Module(readFileSync(defaultUrl));
}
