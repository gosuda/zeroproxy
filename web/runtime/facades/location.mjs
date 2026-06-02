export function createLocationFacades({
  Native,
  getVirtualURL,
  setVirtualLocation,
  updateVirtualHash,
  maskMethods,
  maskNativeFunction,
}) {
  const virtualLocation = {
    get href() { return getVirtualURL().href; },
    set href(v) { setVirtualLocation(v); },
    get protocol() { return getVirtualURL().protocol; },
    get host() { return getVirtualURL().host; },
    get hostname() { return getVirtualURL().hostname; },
    get port() { return getVirtualURL().port; },
    get pathname() { return getVirtualURL().pathname; },
    get search() { return getVirtualURL().search; },
    get hash() { return getVirtualURL().hash; },
    set hash(v) { updateVirtualHash(v); },
    get origin() { return getVirtualURL().origin; },
    assign(v) { setVirtualLocation(v); },
    replace(v) { setVirtualLocation(v, true); },
    reload() { Native.locationReload && Native.locationReload(); },
    toString() { return getVirtualURL().href; },
    valueOf() { return getVirtualURL().href; },
    [Symbol.toPrimitive]() { return getVirtualURL().href; }
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
  finalizeLocationFacade(virtualLocation, maskMethods, maskNativeFunction);
  finalizeLocationFacade(crossWindowLocation, maskMethods, maskNativeFunction);
  return Object.freeze({ virtualLocation, crossWindowLocation });
}

function finalizeLocationFacade(locationFacade, maskMethods, maskNativeFunction) {
  try {
    Object.defineProperty(locationFacade, Symbol.toStringTag, {
      value: 'Location',
      enumerable: false,
      configurable: true
    });
  } catch {}
  try { Object.freeze(locationFacade); } catch {}
  maskMethods(locationFacade, ['assign','replace','reload','toString','valueOf']);
  maskNativeFunction(locationFacade[Symbol.toPrimitive], Symbol.toPrimitive);
}
