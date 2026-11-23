import type { RewriteScriptOptions, ScriptKind, ScriptRewriter } from './rewriter.js';

export type { RewriteScriptOptions, ScriptKind, ScriptRewriter };
export declare const SCRIPT_KINDS: readonly ScriptKind[];

export interface InlineRewriterOptions {
  proxyOrigin?: string;
}

export declare function createRewriter(options?: InlineRewriterOptions): Promise<ScriptRewriter>;
export declare function createRewriterSync(options?: InlineRewriterOptions): ScriptRewriter;
