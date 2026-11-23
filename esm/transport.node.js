import { bindTransportLoaders } from './transport.shared.js';
import { resolveAsyncWasm, resolveSyncWasm } from './wasm-loader.node.js';

export const { createTransportKernel, createTransportKernelSync } = bindTransportLoaders(
  resolveAsyncWasm,
  resolveSyncWasm,
);
