// Embedder-facing surface of `zp-core.js`.
//
// `zp-core.js` installs two non-enumerable globals. `ZP` is the frozen contract below. The runtime table used by the
// Service Worker, the worker prelude, the page membrane, and the launcher page is published as `__zp_internal`;
// each consumer captures it into a closure binding and deletes the property, and none of it is promised to stay stable.

/** A request/response channel between a proxied page realm and the Service Worker. */
interface ZPBridge {
  /** Delivers one `ZP.MSG` message and resolves with the Service Worker's reply. */
  send(message: { type: string; [field: string]: unknown }): Promise<unknown>;
  /** Registers the callback for messages pushed from the Service Worker (such as cookie changes). */
  onMessage?(listener: (message: { type: string; [field: string]: unknown }) => void): void;
  /** Releases the bridge when the realm is disposed. */
  dispose?(): void;
}

/**
 * Frozen control handle published as `window.__zp_realm` in a proxied page realm. The realm's mutable state (cookie
 * jar, virtual location, history) stays private to the membrane.
 */
interface ZPRealmHandle {
  readonly tabId: string;
  /** The entry the realm currently shows; it changes on same-document navigation. */
  readonly entryId: string;
  /** The page's virtual (target) URL. */
  getVirtualURL(): string;
  /** The document base URL the page's relative references resolve against. */
  getBaseURL(): string;
  /** Replaces the transport to the Service Worker. Throws `TypeError` unless `bridge.send` is a function. */
  setBridge(bridge: unknown): void;
  /** Stops timers and observers and disposes the bridge. Calling it again does nothing. */
  dispose(): void;
}

interface ZPShareLink {
  /** URL-safe base64 of the encrypted target; it is the `/zp/p/<encrypted>` route key. */
  encrypted: string;
  /** URL-safe base64 decryption key; it travels only in the URL fragment. */
  key: string;
  /** The canonical target URL. */
  targetUrl: string;
}

interface ZPEnvelope {
  head: Record<string, unknown>;
  body: Uint8Array;
}

interface ZPRelayOptions {
  origin?: string;
  allowLoopbackWS?: boolean;
}

interface ZPApi {
  /** `/zp/`: the prefix of every proxy-owned route. */
  readonly CONTROL_PREFIX: string;
  /** Message type constants carried by `ZPBridge.send`. */
  readonly MSG: Readonly<{
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
  /** Content type of `/zp/api/v2/fetch` request bodies. */
  readonly ENVELOPE_MIME: 'application/zp-envelope';

  /** Builds `[u32 little-endian head length][JSON head][raw body]`. */
  encodeEnvelope(head: Record<string, unknown>, body?: Uint8Array | null): Uint8Array;
  /** Splits an envelope. Throws `Error('BAD_ENVELOPE')` on a truncated or inconsistent length. */
  decodeEnvelope(buffer: ArrayBuffer | Uint8Array): ZPEnvelope;

  /**
   * Installs `bridge` (an object with `send`) or a factory `(realm) => bridge` as the realm's transport. A realm that
   * is already running switches immediately; otherwise the factory is kept for the realm to pick up at boot. Returns
   * the new bridge, or `null` when it was deferred. Throws `TypeError` for anything else.
   */
  configureBridge(
    win: object | undefined,
    bridgeOrFactory: ZPBridge | ((realm: ZPRealmHandle) => ZPBridge),
  ): ZPBridge | null;

  encryptShareURL(targetUrl: string): Promise<ZPShareLink>;
  /** Rejects with `BAD_HMAC` when the ciphertext was modified. */
  decryptShareURL(encrypted: string, key: string): Promise<string>;
  /** Resolves with `<origin>/zp/p/<encrypted>#k=<key>&server=<relay>...`. */
  makeShareURL(targetUrl: string, origin?: string, servers?: string[]): Promise<string>;
  makeSharePath(encrypted: string): string;
  makeShareFragment(key: string, servers?: string[]): string;
  isSharePath(path: string): boolean;
  /** The `<encrypted>` part of a share path, or `''` for any other path. */
  shareRouteKey(path: string): string;

  /** `controlPath('x')` is `/zp/x`. */
  controlPath(path: string): string;
  /** Path of an asset under `/zp/Asset/`. */
  assetPath(name: string): string;
  /** `assetPath(name)` plus the build's `?v=` cache-busting query. */
  assetURL(name: string): string;
  /** `apiPath('v2/fetch')` is `/zp/api/v2/fetch`. */
  apiPath(name: string): string;
  /** `/zp/error/<code>`. */
  errorPath(code: string): string;

  /** Resolves and normalizes an http(s) target URL. Throws an error carrying a `code` such as `TARGET_PROTOCOL_BLOCKED`. */
  canonicalTargetURL(input: string, base?: string): URL;
  /** Same for ws(s) targets. */
  canonicalWebSocketURL(input: string, base?: string): URL;

  bytesToBase64Url(bytes: Uint8Array): string;
  base64UrlToBytes(encoded: string): Uint8Array;

  /** The relay WebSocket URL on `origin`: `ws(s)://<host>/zp/ws-pipe`. */
  defaultRelayServer(origin?: string): string;
  /** Normalizes `servers`, falling back to `defaultRelayServer`. */
  relayServersForShare(servers?: string[], options?: ZPRelayOptions): string[];
  /** Reads the `server` parameters of a share URL fragment. */
  parseRelayServersFromFragment(fragment: string, options?: ZPRelayOptions): string[];
}

declare const ZP: ZPApi;

interface Window {
  /** Present in a proxied page realm only. */
  readonly __zp_realm?: ZPRealmHandle;
}
