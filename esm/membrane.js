import { ZP } from './_core.js';

export const MSG = ZP.MSG;
export const configureBridge = ZP.configureBridge;

export function getRealm(win = globalThis) {
  if (!win || (typeof win !== 'object' && typeof win !== 'function')) return null;
  const realm = win.__zp_realm;
  if (!realm || typeof realm !== 'object' || typeof realm.getVirtualURL !== 'function') {
    return null;
  }
  return realm;
}
