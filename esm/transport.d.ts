import type { SyncWasmInitOptions, WasmInitOptions } from './rewriter.js';

export interface TransportKernelOptions extends WasmInitOptions {
  capturedClientHelloSpec?: string;
}

export interface SyncTransportKernelOptions extends SyncWasmInitOptions {
  capturedClientHelloSpec?: string;
}

export interface KernelFetchDescriptor {
  url: string;
  method?: string;
  headerEntries?: ReadonlyArray<readonly [string, string]>;
  headers?: Headers;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}

export interface KernelWebSocketOptions {
  url: string;
  origin: string;
  userAgent: string;
  protocols?: readonly string[];
  cookie?: string;
  isolationKey?: string;
}

export interface KernelWebSocketHandlers {
  onMessage?: (payload: string | Uint8Array) => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (reason: string) => void;
}

export interface KernelWebSocketClient {
  readonly protocol: string;
  readonly bufferedAmount: number;
  send(payload: string | Uint8Array): void;
  setHandlers(handlers: KernelWebSocketHandlers): void;
  close(code?: number, reason?: string): void;
  abort(): void;
}

export interface TransportKernel {
  readonly version: string;
  readonly banner: string;
  setCapturedClientHello(base64JsonSpec: string): void;
  fetch(request: Request | KernelFetchDescriptor): Promise<Response>;
  openWebSocket(options: KernelWebSocketOptions): Promise<KernelWebSocketClient>;
}

export declare function createTransportKernel(options?: TransportKernelOptions): Promise<TransportKernel>;
export declare function createTransportKernelSync(options?: SyncTransportKernelOptions): TransportKernel;
