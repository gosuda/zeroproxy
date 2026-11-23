import { bindEngineLoaders, SCRIPT_KINDS } from './engine.shared.js';
import { resolveAsyncWasm, resolveSyncWasm } from './wasm-loader.browser.js';

const { createEngine, createEngineSync } = bindEngineLoaders(resolveAsyncWasm, resolveSyncWasm);
export { createEngine, createEngineSync, SCRIPT_KINDS };
