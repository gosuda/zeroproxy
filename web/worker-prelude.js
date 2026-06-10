// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: TODO(complexity): web-worker membrane prelude IIFE (cog 27); Biome attributes the aggregate of the module wrapper's guard plus its nested hook declarations to this top-level arrow. No single inner function exceeds 15. Splitting the module wrapper is risky membrane surgery; needs dedicated differential-harness decomposition.
(() => {
  'use strict';
  const NativeArray = Array;
  const NativeDOMException = DOMException;
  const NativeFunctionBind = Function.prototype.bind;
  const NativeObject = Object;
  const NativePromise = Promise;
  const NativeProxy = Proxy;
  const NativeReflect = Reflect;
  const NativeString = String;
  const NativeSymbol = Symbol;
  const NativeTypeError = TypeError;
  const NativeURL = URL;
  const NativeWeakMap = WeakMap;
  const nativeArrayFrom = NativeArray.from;
  const nativeArrayIsArray = NativeArray.isArray;
  const nativeObjectDefineProperty = NativeObject.defineProperty;
  const nativeObjectFreeze = NativeObject.freeze;
  const nativeObjectGetPrototypeOf = NativeObject.getPrototypeOf;
  const nativeObjectHasOwn = NativeObject.hasOwn;
  const nativeReflectApply = NativeReflect.apply;
  const nativeReflectConstruct = NativeReflect.construct;
  const nativeReflectGet = NativeReflect.get;
  const nativeReflectGetOwnPropertyDescriptor = NativeReflect.getOwnPropertyDescriptor;
  const nativeReflectHas = NativeReflect.has;
  const nativeReflectOwnKeys = NativeReflect.ownKeys;
  const nativeReflectSet = NativeReflect.set;
  {
  const Array = NativeArray;
  const DOMException = NativeDOMException;
  const Object = NativeObject;
  const Promise = NativePromise;
  const Proxy = NativeProxy;
  const _Reflect = NativeReflect;
  const String = NativeString;
  const Symbol = NativeSymbol;
  const TypeError = NativeTypeError;
  const URL = NativeURL;
  const WeakMap = NativeWeakMap;
  const arrayFrom = nativeArrayFrom;
  const arrayIsArray = nativeArrayIsArray;
  const objectDefineProperty = nativeObjectDefineProperty;
  const objectFreeze = nativeObjectFreeze;
  const objectGetPrototypeOf = nativeObjectGetPrototypeOf;
  const objectHasOwn = nativeObjectHasOwn;
  const reflectApply = nativeReflectApply;
  const reflectConstruct = nativeReflectConstruct;
  const reflectGet = nativeReflectGet;
  const reflectGetOwnPropertyDescriptor = nativeReflectGetOwnPropertyDescriptor;
  const reflectHas = nativeReflectHas;
  const reflectOwnKeys = nativeReflectOwnKeys;
  const reflectSet = nativeReflectSet;
  if (self.__ZP_WORKER_PRELUDE) return;
  objectDefineProperty(self, '__ZP_WORKER_PRELUDE', { value: true, enumerable: false, configurable: false });
  const FunctionCtor = self.Function;
  const originalLocation = self.location;
  const _proxyOrigin = String(self.__ZP_WORKER_PROXY_ORIGIN || originalLocation && originalLocation.origin || '');
  function _internalURL(path) {
    return _proxyOrigin ? new URL(path, _proxyOrigin).href : path;
  }
  const nativeFunctionToString = FunctionCtor?.prototype?.toString;
  const toStringMap = new WeakMap();
  function nativeFunctionSource(name) { return 'function ' + name + '() { [native code] }'; }
  function maskNativeFunction(fn, name) {
    if (typeof fn === 'function') toStringMap.set(fn, nativeFunctionSource(name));
  }
  function defineMasked(obj, key, value) {
    try {
      objectDefineProperty(obj, key, { value, enumerable: false, configurable: true, writable: true });
      maskNativeFunction(value, key);
    } catch {}
  }
  if (nativeFunctionToString) {
    const maskedToString = function toString() {
      if (toStringMap.has(this)) return toStringMap.get(this);
      return reflectApply(nativeFunctionToString, this, []);
    };
    toStringMap.set(maskedToString, nativeFunctionSource('toString'));
    try { objectDefineProperty(FunctionCtor.prototype, 'toString', { value: maskedToString, enumerable: false, configurable: true, writable: true }); } catch {}
  }
  const base = new URL(self.__ZP_WORKER_LOCATION || self.__ZP_WORKER_TARGET || 'https://invalid.local/');
  function makeWorkerLocationFacade(url) {
    const loc = {};
    for (const prop of ['href','origin','protocol','host','hostname','port','pathname','search','hash']) {
      objectDefineProperty(loc, prop, { get: () => url[prop], enumerable: false, configurable: true });
    }
    objectDefineProperty(loc, 'toString', { value: function toString() { return url.href; }, enumerable: false, configurable: true });
    objectDefineProperty(loc, Symbol.toStringTag, { value: 'WorkerLocation', enumerable: false, configurable: true });
    try { objectDefineProperty(loc, 'constructor', { value: originalLocation && originalLocation.constructor, enumerable: false, configurable: true }); } catch {}
    return loc;
  }
  const workerLocation = makeWorkerLocationFacade(base);
  try { objectDefineProperty(self, 'location', { value: workerLocation, enumerable: true, configurable: true }); } catch {}
  try { objectDefineProperty(self, 'origin', { value: base.origin, enumerable: true, configurable: true }); } catch {}
  const blockedDynamic = () => { throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError'); };
  const scope = new Proxy(self, {
    has(_target, prop) { return prop !== Symbol.unscopables; },
    get(target, prop) {
      if (prop === Symbol.unscopables) return undefined;
      if (prop === 'self' || prop === 'globalThis' || prop === 'window' || prop === 'top' || prop === 'parent' || prop === 'frames') return scope;
      if (prop === 'location') return workerLocation;
      return reflectGet(target, prop);
    },
    set(target, prop, value) { return reflectSet(target, prop, value); }
  });
  objectDefineProperty(self, '__zp_runClassic', { value: fn => fn(scope), enumerable: false, configurable: false });
  function expose(name, value) { objectDefineProperty(self, name, { value, enumerable: false, configurable: false }); }
  function isWorkerGlobal(value) { return value === self || value === scope; }
  function workerTarget(value) { return value === scope ? self : value; }
  function hiddenWorkerGlobalKey(key) {
    if (typeof key === 'symbol') {
      const desc = String(key.description || '').toLowerCase();
      return desc.includes('zeroproxy') || desc.startsWith('zp.');
    }
    const name = String(key || '');
    return name === 'ZP' || name.startsWith('__ZP_') || name.startsWith('__zp_');
  }
  function hiddenWorkerOwnKey(key) {
    return hiddenWorkerGlobalKey(key) || key === 'location' || key === 'fetch' || key === 'importScripts';
  }
  function visibleWorkerOwnKeys(value, keys) {
    if (!isWorkerGlobal(value)) return keys;
    const raw = arrayFrom(keys || []);
    const out = new Array(raw.length);
    let count = 0;
    for (const key of raw) if (!hiddenWorkerOwnKey(key)) {
      out[count] = key;
      count += 1;
    }
    out.length = count;
    return out;
  }
  function workerDescriptorKeys(out, Obj, Refl, reflectOwnKeys, getNames) {
    return reflectOwnKeys ? reflectApply(reflectOwnKeys, Refl, [out]) : reflectApply(getNames, Obj, [out]);
  }
  function scrubWorkerDescriptors(value, out, Obj, Refl, reflectOwnKeys, getNames) {
    if (!isWorkerGlobal(value)) return out;
    for (const key of workerDescriptorKeys(out, Obj, Refl, reflectOwnKeys, getNames)) {
      if (hiddenWorkerOwnKey(key)) delete out[key];
    }
    return out;
  }
  function installWorkerKeyMasking(Obj) {
    const keys = Obj.keys;
    const getNames = Obj.getOwnPropertyNames;
    const getSymbols = Obj.getOwnPropertySymbols;
    if (typeof keys === 'function') defineMasked(Obj, 'keys', function keys(value) {
      return visibleWorkerOwnKeys(value, reflectApply(keys, Obj, [value]));
    });
    if (typeof getNames === 'function') defineMasked(Obj, 'getOwnPropertyNames', function getOwnPropertyNames(value) {
      return visibleWorkerOwnKeys(value, reflectApply(getNames, Obj, [value]));
    });
    if (typeof getSymbols === 'function') defineMasked(Obj, 'getOwnPropertySymbols', function getOwnPropertySymbols(value) {
      return visibleWorkerOwnKeys(value, reflectApply(getSymbols, Obj, [value]));
    });
  }
  function installWorkerDescriptorMasking(Obj, Refl) {
    const getNames = Obj.getOwnPropertyNames;
    const getDescriptor = Obj.getOwnPropertyDescriptor;
    const getDescriptors = Obj.getOwnPropertyDescriptors;
    const reflectOwnKeys = Refl && Refl.ownKeys;
    if (typeof getDescriptor === 'function') defineMasked(Obj, 'getOwnPropertyDescriptor', function getOwnPropertyDescriptor(value, key) {
      if (isWorkerGlobal(value) && hiddenWorkerOwnKey(key)) return undefined;
      return reflectApply(getDescriptor, Obj, [value, key]);
    });
    if (typeof getDescriptors === 'function') defineMasked(Obj, 'getOwnPropertyDescriptors', function getOwnPropertyDescriptors(value) {
      return scrubWorkerDescriptors(value, reflectApply(getDescriptors, Obj, [value]), Obj, Refl, reflectOwnKeys, getNames);
    });
  }
  function installWorkerReflectMasking(Refl) {
    const reflectOwnKeys = Refl && Refl.ownKeys;
    if (Refl && typeof reflectOwnKeys === 'function') defineMasked(Refl, 'ownKeys', function ownKeys(value) {
      return visibleWorkerOwnKeys(value, reflectApply(reflectOwnKeys, Refl, [value]));
    });
  }
  function installWorkerOwnPropertyMasking() {
    const Obj = self.Object;
    const Refl = self.Reflect;
    if (!Obj) return;
    installWorkerKeyMasking(Obj);
    installWorkerDescriptorMasking(Obj, Refl);
    installWorkerReflectMasking(Refl);
  }
  function get(target, prop) {
    if (typeof prop !== 'symbol') prop = String(prop);
    if (isWorkerGlobal(target)) {
      if (prop === 'self' || prop === 'globalThis' || prop === 'window' || prop === 'top' || prop === 'parent' || prop === 'frames') return scope;
      if (prop === 'location') return workerLocation;
    }
    const actual = workerTarget(target);
    const value = reflectGet(Object(actual), prop);
    return prop === 'postMessage' && typeof value === 'function' ? reflectApply(NativeFunctionBind, value, [actual]) : value;
  }
  function optionalGet(target, prop) {
    if (target === null || target === undefined) return undefined;
    return get(target, prop);
  }
  function set(target, prop, value) {
    if (typeof prop !== 'symbol') prop = String(prop);
    if ((isWorkerGlobal(target) && prop === 'location') || target === workerLocation) blockedDynamic();
    reflectSet(Object(workerTarget(target)), prop, value);
    return value;
  }
  function assign(target, prop, operator, value) {
    const current = get(target, prop);
    let next;
    switch (operator) {
      case '+=': next = current + value; break;
      case '-=': next = current - value; break;
      case '*=': next = current * value; break;
      case '/=': next = current / value; break;
      case '%=': next = current % value; break;
      case '**=': next = current ** value; break;
      case '<<=': next = current << value; break;
      case '>>=': next = current >> value; break;
      case '>>>=': next = current >>> value; break;
      case '&=': next = current & value; break;
      case '^=': next = current ^ value; break;
      case '|=': next = current | value; break;
      case '&&=': if (!current) return current; next = value(); break;
      case '||=': if (current) return current; next = value(); break;
      case '??=': if (current !== null && current !== undefined) return current; next = value(); break;
      default: blockedDynamic();
    }
    return set(target, prop, next);
  }
  function update(target, prop, operator, prefix) {
    const current = get(target, prop);
    const next = operator === '++' ? current + 1 : current - 1;
    set(target, prop, next);
    return prefix ? next : current;
  }
  function call(target, prop, args) {
    const actual = workerTarget(target);
    return reflectApply(get(target, prop), actual, arrayIsArray(args) ? args : []);
  }
  function optionalCall(target, prop, args) {
    if (target === null || target === undefined) return undefined;
    const fn = optionalGet(target, prop);
    if (fn === null || fn === undefined) return undefined;
    return call(target, prop, args);
  }
  function construct(ctor, args) { return reflectConstruct(ctor, arrayIsArray(args) ? args : []); }
  function has(target, prop) { return isWorkerGlobal(target) && prop === 'location' || reflectHas(Object(workerTarget(target)), prop); }
  function getOwnPropertyDescriptor(target, prop) {
    if (isWorkerGlobal(target) && prop === 'location') return { value: workerLocation, configurable: true, enumerable: true, writable: false };
    return reflectGetOwnPropertyDescriptor(Object(workerTarget(target)), prop);
  }
  function ownKeys(target) { return reflectOwnKeys(Object(workerTarget(target))); }
  expose('__zp_get', get);
  expose('__zp_optionalGet', optionalGet);
  expose('__zp_set', set);
  expose('__zp_assign', assign);
  expose('__zp_call', call);
  expose('__zp_optionalCall', optionalCall);
  expose('__zp_update', update);
  expose('__zp_construct', construct);
  expose('__zp_has', has);
  expose('__zp_getOwnPropertyDescriptor', getOwnPropertyDescriptor);
  expose('__zp_ownKeys', ownKeys);
  expose('__zp_module_url', () => { throw blockedDynamic(); });
  installWorkerOwnPropertyMasking();
  const TARGET_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
  const TARGET_APP_VERSION = TARGET_USER_AGENT.replace(/^Mozilla\//, '');
  const TARGET_PLATFORM = 'Win32';
  const TARGET_UA_BRANDS = objectFreeze([
    objectFreeze({ brand: 'Chromium', version: '148' }),
    objectFreeze({ brand: 'Not:A-Brand', version: '24' }),
    objectFreeze({ brand: 'Google Chrome', version: '148' })
  ]);
  const TARGET_UA_FULL_VERSION_LIST = objectFreeze([
    objectFreeze({ brand: 'Chromium', version: '148.0.7778.217' }),
    objectFreeze({ brand: 'Not:A-Brand', version: '24.0.0.0' }),
    objectFreeze({ brand: 'Google Chrome', version: '148.0.7778.217' })
  ]);
  function userAgentBrandCopies(values) {
    const out = new Array(values.length);
    for (let i = 0; i < values.length; i += 1) out[i] = objectFreeze({ brand: values[i].brand, version: values[i].version });
    return out;
  }
  function makeUserAgentData() {
    return objectFreeze({
      brands: objectFreeze(userAgentBrandCopies(TARGET_UA_BRANDS)),
      mobile: false,
      platform: 'Windows',
      getHighEntropyValues(hints) {
        const values = {
          architecture: 'x86',
          bitness: '64',
          brands: userAgentBrandCopies(TARGET_UA_BRANDS),
          fullVersionList: userAgentBrandCopies(TARGET_UA_FULL_VERSION_LIST),
          mobile: false,
          model: '',
          platform: 'Windows',
          platformVersion: '15.0.0',
          uaFullVersion: '148.0.7778.217',
          fullVersion: '148.0.7778.217',
          wow64: false
        };
        const out = { brands: values.brands, mobile: false, platform: 'Windows' };
        for (const hint of arrayIsArray(hints) ? arrayFrom(hints, String) : []) if (objectHasOwn(values, hint)) out[hint] = values[hint];
        return Promise.resolve(out);
      },
      toJSON() { return { brands: this.brands, mobile: false, platform: 'Windows' }; }
    });
  }
  const nav = self.navigator;
  if (nav) {
    const proto = self.WorkerNavigator && self.WorkerNavigator.prototype || objectGetPrototypeOf(nav);
    for (const [key, value] of [['userAgent', TARGET_USER_AGENT], ['appVersion', TARGET_APP_VERSION], ['platform', TARGET_PLATFORM]]) {
      try { objectDefineProperty(proto, key, { get: () => value, enumerable: false, configurable: false }); } catch {}
      try { objectDefineProperty(nav, key, { get: () => value, enumerable: false, configurable: false }); } catch {}
    }
    const userAgentData = makeUserAgentData();
    try { objectDefineProperty(proto, 'userAgentData', { get: () => userAgentData, enumerable: false, configurable: false }); } catch {}
    try { objectDefineProperty(nav, 'userAgentData', { get: () => userAgentData, enumerable: false, configurable: false }); } catch {}
  }
  function blocked(){ throw new DOMException('Blocked by ZeroProxy policy','NotSupportedError'); }
  self.fetch = async function fetch() {
    throw new TypeError('ZeroProxy worker fetch is unavailable after QuickJS cutover');
  };
  maskNativeFunction(self.fetch, 'fetch');
  function blockedConstructor() { blocked(); }
  self.XMLHttpRequest = undefined;
  self.WebSocket = blockedConstructor;
  self.EventSource = blockedConstructor;
  self.RTCPeerConnection = self.webkitRTCPeerConnection = self.WebTransport = self.WebSocketStream = blockedConstructor;
  const nativeImportScripts = reflectApply(NativeFunctionBind, self.importScripts, [self]);
  function importScriptURL() {
    throw blockedDynamic();
  }
  self.importScripts = function importScripts(...urls) {
    const rewritten = new Array(urls.length);
    for (let i = 0; i < urls.length; i += 1) rewritten[i] = importScriptURL(urls[i]);
    return nativeImportScripts(...rewritten);
  };
  maskNativeFunction(self.importScripts, 'importScripts');
  }
})();
