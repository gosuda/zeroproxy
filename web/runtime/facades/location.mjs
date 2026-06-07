export function createLocationFacades({
  Native,
  getVirtualURL,
  getVisibleURL = getVirtualURL,
  setVirtualLocation,
  updateVirtualHash,
  maskMethods,
  maskNativeFunction,
}) {
  const {
    Symbol = globalThis.Symbol,
    objectDefineProperty = globalThis.Object.defineProperty,
    objectFreeze = globalThis.Object.freeze,
  } = Native;
  const virtualLocation = {
    get href() { return getVisibleURL().href; },
    set href(v) { setVirtualLocation(v); },
    get protocol() { return getVisibleURL().protocol; },
    get host() { return getVisibleURL().host; },
    get hostname() { return getVisibleURL().hostname; },
    get port() { return getVisibleURL().port; },
    get pathname() { return getVisibleURL().pathname; },
    get search() { return getVisibleURL().search; },
    get hash() { return getVisibleURL().hash; },
    set hash(v) { updateVirtualHash(v); },
    get origin() { return getVisibleURL().origin; },
    assign(v) { setVirtualLocation(v); },
    replace(v) { setVirtualLocation(v, true); },
    reload() { Native.locationReload && Native.locationReload(); },
    toString() { return getVisibleURL().href; },
    valueOf() { return getVisibleURL().href; },
    [Symbol.toPrimitive]() { return getVisibleURL().href; }
  };
  const crossWindowLocation = {
    get href() { return getVirtualURL().href; },
    set href(_v) {},
    get protocol() { return getVirtualURL().protocol; },
    get host() { return getVirtualURL().host; },
    get hostname() { return getVirtualURL().hostname; },
    get port() { return getVirtualURL().port; },
    get pathname() { return getVirtualURL().pathname; },
    get search() { return getVirtualURL().search; },
    get hash() { return getVirtualURL().hash; },
    set hash(_v) {},
    get origin() { return getVirtualURL().origin; },
    assign(_v) {},
    replace(_v) {},
    reload() {},
    toString() { return getVirtualURL().href; },
    valueOf() { return getVirtualURL().href; },
    [Symbol.toPrimitive]() { return getVirtualURL().href; }
  };
  finalizeLocationFacade({ locationFacade: virtualLocation, maskMethods, maskNativeFunction, objectDefineProperty, objectFreeze, Symbol });
  finalizeLocationFacade({ locationFacade: crossWindowLocation, maskMethods, maskNativeFunction, objectDefineProperty, objectFreeze, Symbol });
  return objectFreeze({ virtualLocation, crossWindowLocation });
}

function finalizeLocationFacade({ locationFacade, maskMethods, maskNativeFunction, objectDefineProperty, objectFreeze, Symbol }) {
  try {
    objectDefineProperty(locationFacade, Symbol.toStringTag, {
      value: 'Location',
      enumerable: false,
      configurable: true
    });
  } catch {}
  try { objectFreeze(locationFacade); } catch {}
  maskMethods(locationFacade, ['assign','replace','reload','toString','valueOf']);
  maskNativeFunction(locationFacade[Symbol.toPrimitive], Symbol.toPrimitive);
}
