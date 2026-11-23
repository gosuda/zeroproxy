export type ScriptKind =
  | 'classic'
  | 'classic-local'
  | 'module'
  | 'event-handler'
  | 'eval'
  | 'function'
  | 'worker';

export declare const SCRIPT_KINDS: readonly ScriptKind[];

export interface WasmInitOptions {
  wasmModule?: WebAssembly.Module;
  wasmBytes?: BufferSource;
  wasmUrl?: string | URL;
}

export interface SyncWasmInitOptions {
  wasmModule?: WebAssembly.Module;
  wasmBytes?: BufferSource;
}

export interface RewriterOptions extends WasmInitOptions {
  proxyOrigin?: string;
}

export interface SyncRewriterOptions extends SyncWasmInitOptions {
  proxyOrigin?: string;
}

export interface RewriteScriptOptions {
  targetUrl: string;
  kind?: ScriptKind;
  proxyOrigin?: string;
}

export interface ScriptRewriter {
  readonly version: string;
  readonly proxyOrigin: string;
  rewriteScript(source: string, options: RewriteScriptOptions): string;
}

export declare function createRewriter(options?: RewriterOptions): Promise<ScriptRewriter>;
export declare function createRewriterSync(options?: SyncRewriterOptions): ScriptRewriter;
