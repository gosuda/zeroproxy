import { load, loadSync, UrlClass } from './_rt.js';
import { resolveAsyncWasm, resolveSyncWasm } from './wasm-loader.browser.js';

const DEFAULT_WASM_URL = new URL('./wasm/zp-rt.wasm', import.meta.url);

export { UrlClass };

export async function createUrlPolicy(options = {}) {
  const source = await resolveAsyncWasm(options, DEFAULT_WASM_URL, 'zp-rt.wasm');
  return load(source);
}

export function createUrlPolicySync(options = {}) {
  const source = resolveSyncWasm(options, DEFAULT_WASM_URL, 'zp-rt.wasm');
  return loadSync(source);
}
