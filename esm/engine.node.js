import { bindEngineLoaders, SCRIPT_KINDS } from './engine.shared.js';
import { resolveAsyncWasm, resolveSyncWasm } from './wasm-loader.node.js';

const { createEngine, createEngineSync } = bindEngineLoaders(resolveAsyncWasm, resolveSyncWasm);
export { createEngine, createEngineSync, SCRIPT_KINDS };
