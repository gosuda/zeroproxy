import { bindTransportLoaders } from './transport.shared.js';
import { resolveAsyncWasm, resolveSyncWasm } from './wasm-loader.browser.js';

export const { createTransportKernel, createTransportKernelSync } = bindTransportLoaders(
  resolveAsyncWasm,
  resolveSyncWasm,
);
