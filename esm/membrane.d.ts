import type { ZPBridge, ZPBridgeMessage, ZPMessageTypeMap, ZPRealmHandle } from './core.js';

export type { ZPBridge, ZPBridgeMessage, ZPMessageTypeMap, ZPRealmHandle };
export declare const MSG: ZPMessageTypeMap;
export declare function configureBridge(
  win: object | undefined,
  bridgeOrFactory: ZPBridge | ((realm: ZPRealmHandle) => ZPBridge),
): ZPBridge | null;
export declare function getRealm(win?: object): ZPRealmHandle | null;
