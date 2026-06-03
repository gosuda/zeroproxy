export function createArtifactMasking({ root, toStringMap, toStringMaskedPrototypes, origToString }) {
  function nativeFunctionSource(key) {
    const name = typeof key === 'symbol' ? '' : String(key);
    return `function ${name}() { [native code] }`;
  }
  function nativeAccessorSource(kind, key) {
    const name = typeof key === 'symbol' ? '' : String(key);
    return `function ${kind} ${name}() { [native code] }`;
  }
  function maskNativeFunction(fn, key) {
    if (typeof fn === 'function') toStringMap.set(fn, nativeFunctionSource(key));
  }
  function maskMethods(obj, keys) {
    for (const key of keys) maskNativeFunction(obj && obj[key], key);
  }
  function define(obj, key, value) {
    try {
      Object.defineProperty(obj, key, { value, enumerable: false, configurable: false, writable: true });
      maskNativeFunction(value, key);
      return true;
    } catch { return false; }
  }
  function defineAccessor(obj, key, get, set) {
    try {
      Object.defineProperty(obj, key, { get, set, enumerable: false, configurable: false });
      if (typeof get === 'function') toStringMap.set(get, nativeAccessorSource('get', key));
      if (typeof set === 'function') toStringMap.set(set, nativeAccessorSource('set', key));
      return true;
    } catch { return false; }
  }
  function installToStringMasking(w) {
    const proto = w && w.Function && w.Function.prototype;
    if (!proto || toStringMaskedPrototypes.has(proto)) return;
    const orig = w === root ? origToString : proto.toString;
    if (typeof orig !== 'function') return;
    const maskedToString = function toString() {
      if (typeof this === 'function' && toStringMap.has(this)) return toStringMap.get(this);
      return orig.call(this);
    };
    toStringMap.set(maskedToString, 'function toString() { [native code] }');
    try {
      Object.defineProperty(proto, 'toString', { value: maskedToString, enumerable: false, configurable: true, writable: true });
      toStringMaskedPrototypes.add(proto);
    } catch {}
  }
  return {
    nativeFunctionSource,
    nativeAccessorSource,
    maskNativeFunction,
    maskMethods,
    define,
    defineAccessor,
    installToStringMasking,
  };
}
