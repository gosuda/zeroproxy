const SAME_WINDOW_KEYS = new Set(['window', 'self', 'globalThis', 'frames']);
const BOUNDARY_WINDOW_KEYS = new Set(['top', 'parent', 'opener']);
const NO_WINDOW_ALIAS = Symbol('zeroproxy.noWindowAlias');

function normalizeProperty(prop) {
  return typeof prop === 'symbol' ? prop : String(prop);
}

function assignmentValue(current, op, value) {
  if (op === '+=') return current + value;
  if (op === '-=') return current - value;
  if (op === '*=') return current * value;
  if (op === '/=') return current / value;
  if (op === '%=') return current % value;
  return value;
}

function defineChildValue(w, maskNativeFunction, key, value) {
  try {
    Object.defineProperty(w, key, { value, enumerable: false, configurable: true, writable: true });
    maskNativeFunction(value, key);
    return true;
  } catch {
    return false;
  }
}

function createChildLocation({ getVirtualURL, maskMethods, maskNativeFunction }) {
  const locationFacade = {
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
  try { Object.defineProperty(locationFacade, Symbol.toStringTag, { value: 'Location', enumerable: false, configurable: true }); } catch {}
  try { Object.freeze(locationFacade); } catch {}
  maskMethods(locationFacade, ['assign','replace','reload','toString','valueOf']);
  maskNativeFunction(locationFacade[Symbol.toPrimitive], Symbol.toPrimitive);
  return locationFacade;
}

function createRootHelpers(root) {
  const rootScope = () => {
    try { return root.__ZP_EVAL_SCOPE || root; } catch { return root; }
  };
  const isRootWindowLike = value => {
    const scope = rootScope();
    return value === root || value === scope;
  };
  return { rootScope, isRootWindowLike };
}

function childScopeValue(scope, w, prop, boundaryWindow, windowBoundMethods) {
  if (prop === Symbol.unscopables) return undefined;
  if (SAME_WINDOW_KEYS.has(prop)) return scope;
  if (BOUNDARY_WINDOW_KEYS.has(prop)) return boundaryWindow(w[prop]);
  const value = w[prop];
  return typeof value === 'function' && windowBoundMethods.has(prop) ? value.bind(w) : value;
}

function createChildScope(w, boundaryWindow, windowBoundMethods) {
  let scope;
  scope = new Proxy(w, {
    has(_target, prop) { return prop !== Symbol.unscopables; },
    get(_target, prop) { return childScopeValue(scope, w, prop, boundaryWindow, windowBoundMethods); },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    }
  });
  return scope;
}

function createRootAccessors(root, rootScope) {
  const rootGet = (base, prop) => {
    if (root.__zp_get) return root.__zp_get(base === root ? rootScope() : base, prop);
    return Reflect.get(Object(base), prop);
  };
  const rootSet = (base, prop, value) => {
    if (root.__zp_set) return root.__zp_set(base === root ? rootScope() : base, prop, value);
    Reflect.set(Object(base), prop, value);
    return value;
  };
  return { rootGet, rootSet };
}

function createWindowPredicates({ root, w, scope, isRootWindowLike }) {
  const isWindowLike = value => {
    try {
      return value === w || value === scope || isRootWindowLike(value) || value && value.window === value;
    } catch {
      return false;
    }
  };
  const rawWindowBase = base => base === scope ? w : base;
  const isRootBase = base => base === root || isRootWindowLike(base);
  return { isWindowLike, rawWindowBase, isRootBase };
}

function windowAliasValue({ base, prop, scope, w, rawWindowBase, boundaryWindow, postMessageWrapperFor }) {
  if (SAME_WINDOW_KEYS.has(prop)) return base === scope || base === w ? scope : base;
  if (BOUNDARY_WINDOW_KEYS.has(prop)) return boundaryWindow(rawWindowBase(base)[prop]);
  if (prop === 'postMessage') return postMessageWrapperFor(rawWindowBase(base));
  return NO_WINDOW_ALIAS;
}

function rootWindowValue({ base, prop, childLocation, getVirtualURL, rootGet }) {
  if (prop === 'location') return childLocation;
  if (prop === 'origin') return getVirtualURL().origin;
  return rootGet(base, prop);
}

function reflectChildValue(base, prop, wrapDynamicConstructor) {
  if (prop === 'constructor') return wrapDynamicConstructor(Reflect.get(Object(base), prop));
  const value = Reflect.get(Object(base), prop);
  return typeof value === 'function' && prop === 'postMessage' ? value.bind(base) : value;
}

function createChildAccessors(config, w) {
  const { root, getVirtualURL, postMessageWrapperFor, windowBoundMethods } = config;
  const childLocation = createChildLocation(config);
  const { rootScope, isRootWindowLike } = createRootHelpers(root);
  const { rootGet, rootSet } = createRootAccessors(root, rootScope);
  const wrapDynamicConstructor = ctor => {
    try { return root.__zp_get ? root.__zp_get({ constructor: ctor }, 'constructor') : ctor; } catch { return ctor; }
  };
  let scope;
  const boundaryWindow = value => {
    if (!value) return value;
    if (value === w) return scope;
    if (isRootWindowLike(value)) return rootScope();
    return value;
  };
  scope = createChildScope(w, boundaryWindow, windowBoundMethods);
  const predicates = createWindowPredicates({ root, w, scope, isRootWindowLike });
  const get = (base, prop) => childGet({
    base,
    prop: normalizeProperty(prop),
    scope,
    w,
    childLocation,
    getVirtualURL,
    postMessageWrapperFor,
    wrapDynamicConstructor,
    boundaryWindow,
    rootGet,
    ...predicates,
  });
  const set = (base, prop, value) => childSet({ base, prop: normalizeProperty(prop), value, childLocation, rootSet, isRootBase: predicates.isRootBase });
  return {
    scope,
    get,
    set,
    assign(base, prop, op, value) {
      const next = assignmentValue(get(base, prop), op, value);
      set(base, prop, next);
      return next;
    },
    update(base, prop, op, prefix) {
      const current = get(base, prop);
      const next = op === '++' ? current + 1 : current - 1;
      set(base, prop, next);
      return prefix ? next : current;
    },
    wrapDynamicConstructor,
  };
}

function childGet(context) {
  if (context.isWindowLike(context.base)) {
    const value = windowAliasValue(context);
    if (value !== NO_WINDOW_ALIAS) return value;
  }
  if (context.isRootBase(context.base)) return rootWindowValue(context);
  return reflectChildValue(context.base, context.prop, context.wrapDynamicConstructor);
}

function childSet({ base, prop, value, childLocation, rootSet, isRootBase }) {
  if (base === childLocation) return value;
  if (isRootBase(base)) return rootSet(base, prop, value);
  Reflect.set(Object(base), prop, value);
  return value;
}

function defineChildABI(config, w, accessors) {
  const defineChild = (key, value) => defineChildValue(w, config.maskNativeFunction, key, value);
  defineChild('__zp_get', accessors.get);
  defineChild('__zp_set', accessors.set);
  defineChild('__zp_assign', accessors.assign);
  defineChild('__zp_call', (base, prop, args) => {
    const fn = accessors.get(base, prop);
    if (typeof fn !== 'function') return undefined;
    return Reflect.apply(fn, base === accessors.scope ? w : base, Array.isArray(args) ? args : []);
  });
  defineChild('__zp_update', accessors.update);
  defineChild('__zp_construct', (ctor, args) => Reflect.construct(accessors.wrapDynamicConstructor(ctor), Array.isArray(args) ? args : []));
  defineChild('__zp_has', (base, prop) => {
    const raw = base === accessors.scope ? w : base;
    return Reflect.has(Object(raw), normalizeProperty(prop));
  });
  defineChild('__zp_getOwnPropertyDescriptor', (base, prop) => Reflect.getOwnPropertyDescriptor(Object(base), prop));
  defineChild('__zp_ownKeys', base => Reflect.ownKeys(Object(base)));
  if (config.root.__zp_module_url) defineChild('__zp_module_url', config.root.__zp_module_url);
  defineChild('__zp_nav_assign', v => config.setVirtualLocation(v));
  defineChild('__zp_nav_replace', v => config.setVirtualLocation(v, true));
  defineChild('__zp_runClassic', fn => fn.call(w, accessors.scope));
  defineChild('__zp_runEvent', (selfValue, event, fn) => fn.call(selfValue, eventScope(accessors.scope, event)));
}

function eventScope(scope, event) {
  return new Proxy(scope, {
    get(target, prop, receiver) {
      if (prop === 'event') return event;
      return Reflect.get(target, prop, receiver);
    }
  });
}

export function createChildRewriteHelpers(config) {
  return {
    installChildRewriteHelpers(w) {
      if (!w) return;
      defineChildABI(config, w, createChildAccessors(config, w));
    }
  };
}
