import type {
  RewriteScriptOptions,
  ScriptKind,
  SyncWasmInitOptions,
  WasmInitOptions,
} from './rewriter.js';

export type { RewriteScriptOptions, ScriptKind, SyncWasmInitOptions, WasmInitOptions };
export declare const SCRIPT_KINDS: readonly ScriptKind[];

export interface EngineOptions extends WasmInitOptions {
  proxyOrigin?: string;
  controlPrefix?: string;
}

export interface SyncEngineOptions extends SyncWasmInitOptions {
  proxyOrigin?: string;
  controlPrefix?: string;
}

export interface TransformHtmlOptions {
  targetUrl: string;
  proxyOrigin?: string;
}

export interface HtmlStreamOptions {
  targetUrl: string;
  proxyOrigin?: string;
  preludeHtml?: string;
}

export interface HtmlStreamSession {
  write(chunk: Uint8Array | ArrayBuffer | ArrayBufferView | string): Uint8Array;
  end(): Uint8Array;
  dispose(): void;
  [Symbol.dispose]?: () => void;
}

export interface RewriteCssOptions {
  baseUrl: string;
  controlPrefix?: string;
  proxyOrigin?: string;
}

export interface ComposeSourceMapOptions {
  targetUrl: string;
  kind?: ScriptKind;
  proxyOrigin?: string;
}

export interface ComposeChainedSourceMapOptions extends ComposeSourceMapOptions {
  originalMapJson?: string;
}

export interface BuildEngineCspOptions {
  wsOrigin: string;
  challengeCompat?: boolean;
}

export interface ChallengeDocumentInput {
  cfMitigated?: string;
  host: string;
  path: string;
}

export interface TransformEngine {
  readonly version: string;
  readonly proxyOrigin: string;
  readonly controlPrefix: string;
  rewriteScript(source: string, options: RewriteScriptOptions): string;
  transformHtml(html: string, options: TransformHtmlOptions): string;
  createHtmlStreamSession(options: HtmlStreamOptions): HtmlStreamSession;
  createHtmlTransformStream(options: HtmlStreamOptions): TransformStream<Uint8Array | string, Uint8Array>;
  rewriteCSS(source: string, options: RewriteCssOptions): string;
  composeSourceMap(source: string, options: ComposeSourceMapOptions): string;
  composeSourceMapChained(source: string, options: ComposeChainedSourceMapOptions): string;
  buildCSP(options: BuildEngineCspOptions): string;
  isChallengeDocument(input: ChallengeDocumentInput): boolean;
}

export declare function createEngine(options?: EngineOptions): Promise<TransformEngine>;
export declare function createEngineSync(options?: SyncEngineOptions): TransformEngine;
