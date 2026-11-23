import { bindRewriterLoaders, SCRIPT_KINDS } from './rewriter.shared.js';
import { resolveAsyncWasm, resolveSyncWasm } from './wasm-loader.browser.js';

const { createRewriter, createRewriterSync } = bindRewriterLoaders(resolveAsyncWasm, resolveSyncWasm);
export { createRewriter, createRewriterSync, SCRIPT_KINDS };
