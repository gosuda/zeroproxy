export interface ZPBridgeMessage {
  type: string;
  [field: string]: unknown;
}

export interface ZPBridge {
  send(message: ZPBridgeMessage): Promise<unknown>;
  onMessage?(listener: (message: ZPBridgeMessage) => void): void;
  dispose?(): void;
}

export interface ZPRealmHandle {
  readonly tabId: string;
  readonly entryId: string;
  getVirtualURL(): string;
  getBaseURL(): string;
  setBridge(bridge: ZPBridge): void;
  dispose(): void;
}

export interface ZPShareLink {
  encrypted: string;
  key: string;
  targetUrl: string;
}

export interface ZPEnvelope {
  head: Record<string, unknown>;
  body: Uint8Array;
}

export interface ZPRelayOptions {
  origin?: string;
  allowLoopbackWS?: boolean;
}

export interface ZPCspOptions {
  challengeCompat?: boolean;
  siteFrames?: boolean;
  extraConnect?: readonly string[];
}

export interface ZPErrorDetail {
  readonly title: string;
  readonly desc: string;
}

export type ZPMessageTypeMap = Readonly<{
  BASE_UPDATE: 'ZP_BASE_UPDATE';
  BIND_CLIENT: 'ZP_BIND_CLIENT';
  COOKIE_SET: 'ZP_COOKIE_SET';
  COOKIE_CHANGE: 'ZP_COOKIE_CHANGE';
  FLUSH_COOKIES: 'ZP_FLUSH_COOKIES';
  FRAME_ROUTE: 'ZP_FRAME_ROUTE';
  HISTORY_UPDATE: 'ZP_HISTORY_UPDATE';
  OPEN_SHARE: 'ZP_OPEN_SHARE';
  REFERRER_POLICY: 'ZP_REFERRER_POLICY';
  RESOLVE_ENTRY: 'ZP_RESOLVE_ENTRY';
  SCROLL_UPDATE: 'ZP_SCROLL_UPDATE';
  SUBMIT_PREPARE: 'ZP_SUBMIT_PREPARE';
  WORKER_STASH: 'ZP_WORKER_STASH';
  WS_OPEN: 'ZP_WS_OPEN';
}>;

export interface ZPApi {
  readonly CONTROL_PREFIX: string;
  readonly MSG: ZPMessageTypeMap;
  readonly ENVELOPE_MIME: 'application/zp-envelope';
  encodeEnvelope(head: Record<string, unknown>, body?: Uint8Array | null): Uint8Array;
  decodeEnvelope(buffer: ArrayBuffer | Uint8Array): ZPEnvelope;
  configureBridge(
    win: object | undefined,
    bridgeOrFactory: ZPBridge | ((realm: ZPRealmHandle) => ZPBridge),
  ): ZPBridge | null;
  encryptShareURL(targetUrl: string): Promise<ZPShareLink>;
  decryptShareURL(encrypted: string, key: string): Promise<string>;
  makeShareURL(targetUrl: string, origin?: string, servers?: readonly string[]): Promise<string>;
  makeSharePath(encrypted: string): string;
  makeShareFragment(key: string, servers?: readonly string[]): string;
  isSharePath(path: string): boolean;
  shareRouteKey(path: string): string;
  controlPath(path: string): string;
  assetPath(name: string): string;
  assetURL(name: string): string;
  apiPath(name: string): string;
  errorPath(code: string): string;
  canonicalTargetURL(input: string, base?: string): URL;
  canonicalWebSocketURL(input: string, base?: string): URL;
  bytesToBase64Url(bytes: Uint8Array): string;
  base64UrlToBytes(encoded: string): Uint8Array;
  defaultRelayServer(origin?: string): string;
  relayServersForShare(servers?: readonly string[], options?: ZPRelayOptions): string[];
  parseRelayServersFromFragment(fragment: string, options?: ZPRelayOptions): string[];
}

export declare const ZP: ZPApi;
export declare const CONTROL_PREFIX: string;
export declare const MSG: ZPMessageTypeMap;
export declare const ENVELOPE_MIME: 'application/zp-envelope';
export declare function encodeEnvelope(head: Record<string, unknown>, body?: Uint8Array | null): Uint8Array;
export declare function decodeEnvelope(buffer: ArrayBuffer | Uint8Array): ZPEnvelope;
export declare function configureBridge(
  win: object | undefined,
  bridgeOrFactory: ZPBridge | ((realm: ZPRealmHandle) => ZPBridge),
): ZPBridge | null;
export declare function encryptShareURL(targetUrl: string): Promise<ZPShareLink>;
export declare function decryptShareURL(encrypted: string, key: string): Promise<string>;
export declare function makeShareURL(targetUrl: string, origin?: string, servers?: readonly string[]): Promise<string>;
export declare function makeSharePath(encrypted: string): string;
export declare function makeShareFragment(key: string, servers?: readonly string[]): string;
export declare function isSharePath(path: string): boolean;
export declare function shareRouteKey(path: string): string;
export declare function controlPath(path: string): string;
export declare function assetPath(name: string): string;
export declare function assetURL(name: string): string;
export declare function apiPath(name: string): string;
export declare function errorPath(code: string): string;
export declare function canonicalTargetURL(input: string, base?: string): URL;
export declare function canonicalWebSocketURL(input: string, base?: string): URL;
export declare function bytesToBase64Url(bytes: Uint8Array): string;
export declare function base64UrlToBytes(encoded: string): Uint8Array;
export declare function defaultRelayServer(origin?: string): string;
export declare function relayServersForShare(servers?: readonly string[], options?: ZPRelayOptions): string[];
export declare function parseRelayServersFromFragment(fragment: string, options?: ZPRelayOptions): string[];

export declare const ERRORS: readonly string[];
export declare function errorInfo(code: string): ZPErrorDetail;
export declare function fixedCSP(servers?: readonly string[], options?: ZPCspOptions): string;
export declare function filterMetaCSP(content: string, siteFrameSrc?: string): string;
export declare function siteOf(targetUrl: string): string;
export declare function sameSite(a: string, b: string): boolean;
export declare function siteFrameCapable(proxyOrigin: string): boolean;
export declare function siteFrameOrigin(proxyOrigin: string, targetUrl: string): string;
export declare function isSiteFrameOrigin(proxyOrigin: string, origin: string): boolean;
export declare function siteFrameSource(proxyOrigin: string): string;
