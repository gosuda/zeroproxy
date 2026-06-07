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
    URL = globalThis.URL,
    objectDefineProperty = globalThis.Object.defineProperty,
    objectFreeze = globalThis.Object.freeze,
  } = Native;

  function updateLocationProperty(prop, value) {
    try {
      const u = new URL(getVisibleURL().href);
      u[prop] = String(value);
      setVirtualLocation(u.href);
    } catch {}
  }

  const virtualLocation = {
    get href() { return getVisibleURL().href; },
    set href(v) { setVirtualLocation(v); },
    get protocol() { return getVisibleURL().protocol; },
    set protocol(v) { updateLocationProperty('protocol', v); },
    get host() { return getVisibleURL().host; },
    set host(v) { updateLocationProperty('host', v); },
    get hostname() { return getVisibleURL().hostname; },
    set hostname(v) { updateLocationProperty('hostname', v); },
    get port() { return getVisibleURL().port; },
    set port(v) { updateLocationProperty('port', v); },
    get pathname() { return getVisibleURL().pathname; },
    set pathname(v) { updateLocationProperty('pathname', v); },
    get search() { return getVisibleURL().search; },
    set search(v) { updateLocationProperty('search', v); },
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
    set protocol(_v) {},
    get host() { return getVirtualURL().host; },
    set host(_v) {},
    get hostname() { return getVirtualURL().hostname; },
    set hostname(_v) {},
    get port() { return getVirtualURL().port; },
    set port(_v) {},
    get pathname() { return getVirtualURL().pathname; },
    set pathname(_v) {},
    get search() { return getVirtualURL().search; },
    set search(_v) {},
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
