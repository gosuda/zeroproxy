import type { SyncWasmInitOptions, WasmInitOptions } from './rewriter.js';

export type UrlClassMap = Readonly<{
  INVALID: 0;
  HTTP: 1;
  WS: 2;
  BLOB: 3;
  DATA: 4;
  JAVASCRIPT: 5;
  VBSCRIPT: 6;
  ABOUT_BLANK: 7;
  ABOUT_OTHER: 8;
  RELATIVE: 9;
  OTHER: 10;
}>;

export type UrlClassValue = UrlClassMap[keyof UrlClassMap];

export interface UrlClassification {
  readonly handle: number;
  readonly class: UrlClassValue;
}

export interface UrlPoolStats {
  readonly entries: number;
  readonly bytes: number;
}

export interface UrlPolicyRuntime {
  readonly UrlClass: UrlClassMap;
  readonly EXECUTABLE_SCHEMES: ReadonlySet<number>;
  readonly DANGEROUS_SCHEMES: ReadonlySet<number>;
  readonly version: number;
  readonly scratchCap: number;
  internURL(url: string): number;
  classifyURL(handle: number): UrlClassValue;
  classify(url: string): UrlClassification;
  classOf(url: string): UrlClassValue;
  classifySchemeOnly(url: string): UrlClassValue;
  classifyBatch(urls: readonly string[]): Uint32Array | null;
  batchClass(packed: number): UrlClassValue;
  batchHandle(packed: number): number;
  viewURL(handle: number): string;
  reset(): void;
  stats(): UrlPoolStats;
}

export declare const UrlClass: UrlClassMap;
export declare function createUrlPolicy(options?: WasmInitOptions): Promise<UrlPolicyRuntime>;
export declare function createUrlPolicySync(options?: SyncWasmInitOptions): UrlPolicyRuntime;
