const pluginState = new WeakMap();
const mimeTypeState = new WeakMap();
const missingDOMErrorName = {};
const missingOverconstrainedConstraint = {};
const domErrorState = new WeakMap();
const overconstrainedState = new WeakMap();
const quotaExceededState = new WeakMap();


export function createLegacyBrowserFacades(DOMExceptionBase) {
  function Plugin() { throw new TypeError("Failed to construct 'Plugin': Illegal constructor"); }
  definePluginPrototype(Plugin.prototype);
  Object.defineProperty(Plugin.prototype, Symbol.toStringTag, { value: 'Plugin', configurable: true });
  Object.defineProperty(Plugin.prototype, Symbol.iterator, { value: Array.prototype[Symbol.iterator], writable: true, configurable: true });

  function MimeType() { throw new TypeError("Failed to construct 'MimeType': Illegal constructor"); }
  defineMimeTypePrototype(MimeType.prototype);
  Object.defineProperty(MimeType.prototype, Symbol.toStringTag, { value: 'MimeType', configurable: true });

  const createMimeType = (record) => {
    const mimeType = Object.create(MimeType.prototype);
    mimeTypeState.set(mimeType, {
      type: String(record.type || ''),
      suffixes: String(record.suffixes || ''),
      description: String(record.description || ''),
      enabledPlugin: record.enabledPlugin || null,
    });
    return mimeType;
  };

  const createPlugin = (record) => {
    const plugin = Object.create(Plugin.prototype);
    const mimeTypes = (record.mimeTypes || []).map((mimeRecord) => createMimeType({ ...mimeRecord, enabledPlugin: plugin }));
    pluginState.set(plugin, {
      name: String(record.name || ''),
      filename: String(record.filename || ''),
      description: String(record.description || ''),
      mimeTypes,
    });
    defineIndexedNamedProperties(plugin, mimeTypes, (mimeType) => mimeTypeValue(mimeType, 'type'));
    return plugin;
  };
  function DOMError(name = missingDOMErrorName, message = '') {
    if (!new.target) throw new TypeError("Failed to construct 'DOMError': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (name === missingDOMErrorName) throw new TypeError("Failed to construct 'DOMError': 1 argument required, but only 0 present.");
    domErrorState.set(this, { name: String(name), message: String(message) });
  }
  Object.defineProperty(DOMError, 'name', { value: 'DOMError', configurable: true });
  Object.defineProperty(DOMError, 'length', { value: 1, configurable: true });
  Object.defineProperty(DOMError.prototype, 'name', { get() { return domErrorValue(this, 'name'); }, enumerable: true, configurable: true });
  Object.defineProperty(DOMError.prototype, 'message', { get() { return domErrorValue(this, 'message'); }, enumerable: true, configurable: true });
  Object.defineProperty(DOMError.prototype, Symbol.toStringTag, { value: 'DOMError', configurable: true });
  function OverconstrainedError(constraint = missingOverconstrainedConstraint, message = '') {
    if (!new.target) throw new TypeError("Failed to construct 'OverconstrainedError': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (constraint === missingOverconstrainedConstraint) throw new TypeError("Failed to construct 'OverconstrainedError': 1 argument required, but only 0 present.");
    const instance = Reflect.construct(DOMExceptionBase, [String(message), 'OverconstrainedError'], new.target);
    overconstrainedState.set(instance, String(constraint));
    return instance;
  }
  Object.setPrototypeOf(OverconstrainedError.prototype, DOMExceptionBase.prototype);
  Object.defineProperty(OverconstrainedError, 'name', { value: 'OverconstrainedError', configurable: true });
  Object.defineProperty(OverconstrainedError, 'length', { value: 1, configurable: true });
  Object.defineProperty(OverconstrainedError.prototype, 'constructor', { value: OverconstrainedError, writable: true, configurable: true });
  Object.defineProperty(OverconstrainedError.prototype, 'constraint', { get() { return overconstrainedValue(this); }, enumerable: true, configurable: true });
  Object.defineProperty(OverconstrainedError.prototype, Symbol.toStringTag, { value: 'OverconstrainedError', configurable: true });

  function QuotaExceededError(message = '', options = null) {
    if (!new.target) throw new TypeError("Failed to construct 'QuotaExceededError': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    const instance = Reflect.construct(DOMExceptionBase, [String(message), 'QuotaExceededError'], new.target);
    quotaExceededState.set(instance, { quota: finiteOption(options, 'quota'), requested: finiteOption(options, 'requested') });
    return instance;
  }
  Object.setPrototypeOf(QuotaExceededError.prototype, DOMExceptionBase.prototype);
  Object.defineProperty(QuotaExceededError, 'name', { value: 'QuotaExceededError', configurable: true });
  Object.defineProperty(QuotaExceededError, 'length', { value: 0, configurable: true });
  Object.defineProperty(QuotaExceededError.prototype, 'constructor', { value: QuotaExceededError, writable: true, configurable: true });
  Object.defineProperty(QuotaExceededError.prototype, 'quota', { get() { return quotaExceededValue(this, 'quota'); }, enumerable: true, configurable: true });
  Object.defineProperty(QuotaExceededError.prototype, 'requested', { get() { return quotaExceededValue(this, 'requested'); }, enumerable: true, configurable: true });
  Object.defineProperty(QuotaExceededError.prototype, Symbol.toStringTag, { value: 'QuotaExceededError', configurable: true });

  return { Plugin, MimeType, DOMError, OverconstrainedError, QuotaExceededError, createPlugin, createMimeType };
}

function definePluginPrototype(proto) {
  for (const name of ['name', 'filename', 'description']) Object.defineProperty(proto, name, { get() { return pluginValue(this, name); }, enumerable: true, configurable: true });
  Object.defineProperty(proto, 'length', { get() { return pluginMimeTypes(this).length; }, enumerable: true, configurable: true });
  Object.defineProperty(proto, 'item', { value: function item(index) { return indexedItem(pluginMimeTypes(this), index); }, enumerable: true, configurable: true, writable: true });
  Object.defineProperty(proto, 'namedItem', { value: function namedItem(name) { return namedCollectionItem(pluginMimeTypes(this), name, (mimeType) => mimeTypeValue(mimeType, 'type')); }, enumerable: true, configurable: true, writable: true });
}

function defineMimeTypePrototype(proto) {
  for (const name of ['type', 'suffixes', 'description', 'enabledPlugin']) Object.defineProperty(proto, name, { get() { return mimeTypeValue(this, name); }, enumerable: true, configurable: true });
}

function defineIndexedNamedProperties(target, items, nameForItem) {
  items.forEach((item, index) => {
    Object.defineProperty(target, String(index), { value: item, enumerable: true, configurable: true });
    const name = nameForItem(item);
    if (name && !Object.prototype.hasOwnProperty.call(target, name)) Object.defineProperty(target, name, { value: item, enumerable: false, configurable: true });
  });
}

function indexedItem(items, index) {
  return items[Number(index) >>> 0] || null;
}

function namedCollectionItem(items, name, nameForItem) {
  const key = String(name);
  return items.find((item) => nameForItem(item) === key) || null;
}

function pluginValue(target, key) {
  const state = pluginState.get(target);
  if (!state) throw new TypeError('Illegal invocation');
  return state[key];
}

function pluginMimeTypes(target) {
  const state = pluginState.get(target);
  if (!state) throw new TypeError('Illegal invocation');
  return state.mimeTypes;
}

function mimeTypeValue(target, key) {
  const state = mimeTypeState.get(target);
  if (!state) throw new TypeError('Illegal invocation');
  return state[key];
}



function domErrorValue(target, key) {
  const state = domErrorState.get(target);
  if (!state) throw new TypeError('Illegal invocation');
  return state[key];
}

function overconstrainedValue(target) {
  if (!overconstrainedState.has(target)) throw new TypeError('Illegal invocation');
  return overconstrainedState.get(target);
}

function quotaExceededValue(target, key) {
  const state = quotaExceededState.get(target);
  if (!state) throw new TypeError('Illegal invocation');
  return state[key];
}



function finiteOption(options, key) {
  if (options === null || options === undefined) return null;
  if (typeof options !== 'object' && typeof options !== 'function') throw new TypeError("Failed to construct 'QuotaExceededError': The provided value is not of type 'QuotaExceededErrorOptions'.");
  if (options[key] === undefined || options[key] === null) return null;
  const value = Number(options[key]);
  if (!Number.isFinite(value)) throw new TypeError(`Failed to construct 'QuotaExceededError': Failed to read the '${key}' property from 'QuotaExceededErrorOptions': The provided double value is non-finite.`);
  return value;
}
