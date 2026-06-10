const GLOBAL_PROPERTY_NAME = /^[A-Za-z_$][\w$]*$/u;

export function manifestSurfaceNames(manifest) {
  return (manifest.entries || [])
    .filter((entry) => entry.status !== 'out-of-scope')
    .map((entry) => String(entry.name))
    .filter((name) => GLOBAL_PROPERTY_NAME.test(name))
    .sort();
}

export function surfaceShapeSource() {
  return `(() => {
    const keyName = (key) => {
      if (typeof key !== 'symbol') return String(key);
      const registered = Symbol.keyFor(key);
      if (registered) return '@@' + registered;
      return 'Symbol(' + (key.description || '') + ')';
    };
    const objectToString = (value) => {
      try { return Object.prototype.toString.call(value); } catch { return ''; }
    };
    const safeConstructorName = (value) => {
      try { return value?.constructor?.name || ''; } catch { return ''; }
    };
    const functionSnapshot = (fn) => ({
      name: typeof fn === 'function' ? String(fn.name || '') : '',
      length: typeof fn === 'function' ? Number(fn.length || 0) : 0,
    });
    const valueSnapshot = (value) => {
      const type = typeof value;
      if (value === null) return { type: 'null' };
      if (type === 'undefined') return { type: 'undefined' };
      if (type === 'function') return { type, ...functionSnapshot(value) };
      if (type === 'string' || type === 'boolean') return { type, value };
      if (type === 'number') return { type, value: Number.isFinite(value) ? value : String(value) };
      if (type === 'bigint') return { type, value: String(value) };
      if (type === 'symbol') return { type, value: keyName(value) };
      return { type, tag: objectToString(value), constructorName: safeConstructorName(value) };
    };
    const descriptorSnapshot = (owner, key) => {
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(owner, key); } catch { return null; }
      if (!descriptor) return null;
      const out = {
        configurable: Boolean(descriptor.configurable),
        enumerable: Boolean(descriptor.enumerable),
      };
      if ('writable' in descriptor) {
        out.kind = 'data';
        out.writable = Boolean(descriptor.writable);
        out.value = valueSnapshot(descriptor.value);
      } else {
        out.kind = 'accessor';
        out.get = descriptor.get ? functionSnapshot(descriptor.get) : null;
        out.set = descriptor.set ? functionSnapshot(descriptor.set) : null;
      }
      return out;
    };
    const safeOwnKeys = (owner) => {
      try { return Reflect.ownKeys(owner || {}); } catch { return []; }
    };
    const sortedKeyNames = (keys) => keys.map(keyName).sort();
    const descriptorMap = (owner, keys) => {
      const out = {};
      for (const key of keys) {
        const descriptor = descriptorSnapshot(owner, key);
        if (descriptor) out[keyName(key)] = descriptor;
      }
      return out;
    };
    const prototypeChain = (prototype) => {
      const names = [];
      let current = prototype;
      for (let depth = 0; current && depth < 8; depth += 1, current = Object.getPrototypeOf(current)) {
        names.push(safeConstructorName(current));
      }
      return names;
    };
    const functionShape = (value) => {
      const staticKeys = safeOwnKeys(value);
      const prototype = value.prototype;
      const out = {
        constructor: functionSnapshot(value),
        staticOwnKeys: sortedKeyNames(staticKeys),
        staticDescriptors: descriptorMap(value, staticKeys),
      };
      if (prototype && (typeof prototype === 'object' || typeof prototype === 'function')) {
        const prototypeKeys = safeOwnKeys(prototype);
        out.prototypeOwnKeys = sortedKeyNames(prototypeKeys);
        out.prototypeDescriptors = descriptorMap(prototype, prototypeKeys);
        out.prototypeToString = objectToString(prototype);
        out.prototypeChain = prototypeChain(prototype);
      }
      return out;
    };
    const objectShape = (value) => {
      const ownKeys = safeOwnKeys(value);
      return {
        ownKeys: sortedKeyNames(ownKeys),
        ownDescriptors: descriptorMap(value, ownKeys),
        objectToString: objectToString(value),
        constructorName: safeConstructorName(value),
      };
    };
    const globalShape = (name) => {
      const descriptor = descriptorSnapshot(globalThis, name);
      if (!descriptor) return { exists: false };
      let value;
      try { value = globalThis[name]; } catch (error) {
        return { exists: true, globalDescriptor: descriptor, type: 'throws', errorName: String(error?.name || 'Error') };
      }
      const type = typeof value;
      const shape = {
        exists: true,
        type,
        globalDescriptor: descriptor,
        valueToString: objectToString(value),
        constructorName: safeConstructorName(value),
      };
      if (type === 'function') return { ...shape, ...functionShape(value) };
      if (value && (type === 'object' || type === 'function')) return { ...shape, ...objectShape(value) };
      return shape;
    };
    const snapshotSurfaceShapes = (names) => {
      const out = {};
      for (const name of names || []) out[String(name)] = globalShape(String(name));
      return out;
    };
    return { snapshotSurfaceShapes };
  })()`;
}

export function compareEntryShapes(entries, hostShapes = {}, quickjsShapes = {}) {
  return entries
    .filter(
      (entry) => entry.status !== 'out-of-scope' && GLOBAL_PROPERTY_NAME.test(String(entry.name)),
    )
    .filter((entry) => hostShapes[entry.name]?.exists || quickjsShapes[entry.name]?.exists)
    .map((entry) => compareEntryShape(entry, hostShapes[entry.name], quickjsShapes[entry.name]))
    .filter(Boolean);
}

function compareEntryShape(entry, host, quickjs) {
  const missing = missingShapeMismatches(entry, host, quickjs);
  if (missing) return missing.length ? shapeMismatch(entry, missing, host, quickjs) : null;
  const mismatches = [];

  compareScalar(mismatches, 'type', host.type, quickjs.type);
  compareDescriptor(
    mismatches,
    'globalDescriptor',
    host.globalDescriptor,
    quickjs.globalDescriptor,
  );
  if (host.type === 'function' && quickjs.type === 'function')
    compareFunctionShape(mismatches, host, quickjs);
  if (host.type === 'object' && quickjs.type === 'object')
    compareObjectShape(mismatches, host, quickjs);
  return mismatches.length ? shapeMismatch(entry, mismatches, host, quickjs) : null;
}

function missingShapeMismatches(entry, host, quickjs) {
  const expected = new Set(entry.expectedShapeDeltas || []);
  const mismatches = [];
  if (!host?.exists) mismatches.push('host-missing');
  if (!quickjs?.exists) mismatches.push('quickjs-missing');
  if (!mismatches.length) return null;
  return mismatches.filter((mismatch) => !expected.has(mismatch));
}

function compareFunctionShape(mismatches, host, quickjs) {
  compareScalar(mismatches, 'constructor.name', host.constructor?.name, quickjs.constructor?.name);
  compareScalar(
    mismatches,
    'constructor.length',
    host.constructor?.length,
    quickjs.constructor?.length,
  );
  compareKeySet(mismatches, 'staticOwnKeys', host.staticOwnKeys, quickjs.staticOwnKeys);
  compareKeySet(mismatches, 'prototypeOwnKeys', host.prototypeOwnKeys, quickjs.prototypeOwnKeys);
  comparePrototypeChain(mismatches, host.prototypeChain, quickjs.prototypeChain);
  compareDescriptorMap(
    mismatches,
    'staticDescriptors',
    host.staticDescriptors,
    quickjs.staticDescriptors,
  );
  compareDescriptorMap(
    mismatches,
    'prototypeDescriptors',
    host.prototypeDescriptors,
    quickjs.prototypeDescriptors,
  );
}

function compareObjectShape(mismatches, host, quickjs) {
  compareScalar(mismatches, 'objectToString', host.objectToString, quickjs.objectToString);
  compareKeySet(mismatches, 'ownKeys', host.ownKeys, quickjs.ownKeys);
  compareDescriptorMap(mismatches, 'ownDescriptors', host.ownDescriptors, quickjs.ownDescriptors);
}

function compareDescriptorMap(mismatches, label, host = {}, quickjs = {}) {
  for (const key of intersection(Object.keys(host || {}), Object.keys(quickjs || {}))) {
    compareDescriptor(mismatches, `${label}.${key}`, host[key], quickjs[key]);
  }
}

function compareDescriptor(mismatches, label, host, quickjs) {
  if (!host || !quickjs) return;
  compareScalar(mismatches, `${label}.kind`, host.kind, quickjs.kind);
  compareScalar(mismatches, `${label}.configurable`, host.configurable, quickjs.configurable);
  compareScalar(mismatches, `${label}.enumerable`, host.enumerable, quickjs.enumerable);
  if (host.kind === 'data' && quickjs.kind === 'data') {
    compareScalar(mismatches, `${label}.writable`, host.writable, quickjs.writable);
    compareValueShape(mismatches, `${label}.value`, host.value, quickjs.value);
  } else if (host.kind === 'accessor' && quickjs.kind === 'accessor') {
    compareFunctionDescriptor(mismatches, `${label}.get`, host.get, quickjs.get);
    compareFunctionDescriptor(mismatches, `${label}.set`, host.set, quickjs.set);
  }
}

function compareValueShape(mismatches, label, host, quickjs) {
  if (!host || !quickjs) return;
  compareScalar(mismatches, `${label}.type`, host.type, quickjs.type);
  if (host.type === 'function' && quickjs.type === 'function')
    compareFunctionDescriptor(mismatches, label, host, quickjs);
  else if (
    ['string', 'number', 'boolean', 'bigint', 'symbol', 'null', 'undefined'].includes(host.type)
  )
    compareScalar(mismatches, `${label}.value`, host.value, quickjs.value);
}

function compareFunctionDescriptor(mismatches, label, host, quickjs) {
  if (!host && !quickjs) return;
  if (!host || !quickjs) {
    mismatches.push(`${label}:presence`);
    return;
  }
  compareScalar(mismatches, `${label}.name`, host.name, quickjs.name);
  compareScalar(mismatches, `${label}.length`, host.length, quickjs.length);
}

function comparePrototypeChain(mismatches, host = [], quickjs = []) {
  const hostPrefix = (host || []).slice(0, 3);
  const quickPrefix = (quickjs || []).slice(0, 3);
  if (JSON.stringify(hostPrefix) !== JSON.stringify(quickPrefix)) mismatches.push('prototypeChain');
}

function compareKeySet(mismatches, label, host = [], quickjs = []) {
  const missing = difference(host || [], quickjs || []);
  const extra = difference(quickjs || [], host || []);
  if (missing.length || extra.length)
    mismatches.push(
      `${label}:missing=${missing.slice(0, 12).join('|')}:extra=${extra.slice(0, 12).join('|')}`,
    );
}

function compareScalar(mismatches, label, host, quickjs) {
  if (host !== quickjs) mismatches.push(`${label}:${String(host)}!=${String(quickjs)}`);
}

function shapeMismatch(entry, mismatches, host, quickjs) {
  return {
    name: entry.name,
    status: entry.status,
    implementationStrategy: entry.implementationStrategy || 'direct-shim',
    mismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, 24),
    hostType: host?.type || 'missing',
    quickJSType: quickjs?.type || 'missing',
  };
}

function difference(left, right) {
  const rightSet = new Set(right || []);
  return (left || []).filter((item) => !rightSet.has(item));
}

function intersection(left, right) {
  const rightSet = new Set(right || []);
  return (left || []).filter((item) => rightSet.has(item));
}
