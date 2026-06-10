export function createMutationObserverController() {
  const mutationObservers = [];
  const mutationRecordState = new WeakMap();
  const staticNodeListState = new WeakMap();
  const staticNodeListPrototype = makeStaticNodeListPrototype(staticNodeListState);

  function MutationRecord() {
    if (new.target) throw new TypeError("Failed to construct 'MutationRecord': Illegal constructor");
    throw new TypeError('Illegal constructor');
  }
  Object.defineProperty(MutationRecord, 'name', { value: 'MutationRecord', configurable: true });
  installMutationRecordPrototype(MutationRecord, mutationRecordState);

  const mutationObserverState = new WeakMap();
  class MutationObserver {
    constructor(callback) {
      if (callback === undefined) throw new TypeError("Failed to construct 'MutationObserver': 1 argument required, but only 0 present.");
      if (typeof callback !== 'function') throw new TypeError("Failed to construct 'MutationObserver': callback must be a function.");
      mutationObserverState.set(this, {
        callback,
        records: [],
        target: null,
        options: {},
        scheduled: false,
      });
    }
    observe(target, options = {}) {
      const state = mutationObserverValue(mutationObserverState, this);
      state.target = target;
      state.options = normalizeMutationOptions(options);
      if (!mutationObservers.includes(this)) mutationObservers.push(this);
    }
    disconnect() {
      const state = mutationObserverValue(mutationObserverState, this);
      state.target = null;
      state.records = [];
      const index = mutationObservers.indexOf(this);
      if (index >= 0) mutationObservers.splice(index, 1);
    }
    takeRecords() {
      return takeMutationRecords(mutationObserverValue(mutationObserverState, this));
    }
  }
  Object.defineProperty(MutationObserver, 'name', { value: 'MutationObserver', configurable: true });
  installMutationObserverPrototype(MutationObserver);

  function notifyMutation(record) {
    for (const observer of [...mutationObservers]) {
      const observerState = mutationObserverValue(mutationObserverState, observer);
      if (!mutationObserverMatches(observerState, record)) continue;
      const next = mutationRecord(record, MutationRecord.prototype, mutationRecordState, staticNodeListPrototype, staticNodeListState);
      const nextState = mutationRecordState.get(next);
      if (nextState.type === 'attributes' && !observerState.options.attributeOldValue) nextState.oldValue = null;
      if (nextState.type === 'characterData' && !observerState.options.characterDataOldValue) nextState.oldValue = null;
      enqueueMutationRecord(observer, observerState, next);
    }
    return true;
  }

  return { MutationObserver, MutationRecord, notifyMutation };
}

const mutationRecordKeys = Object.freeze([
  'type',
  'target',
  'addedNodes',
  'removedNodes',
  'previousSibling',
  'nextSibling',
  'attributeName',
  'attributeNamespace',
  'oldValue',
]);

function installMutationRecordPrototype(Constructor, stateMap) {
  const proto = Constructor.prototype;
  const constructorDescriptor = Object.getOwnPropertyDescriptor(proto, 'constructor');
  delete proto.constructor;
  for (const key of mutationRecordKeys) {
    Object.defineProperty(proto, key, { get() { return mutationRecordValue(stateMap, this, key); }, enumerable: true, configurable: true });
  }
  Object.defineProperty(proto, 'constructor', constructorDescriptor);
  Object.defineProperty(proto, Symbol.toStringTag, { value: 'MutationRecord', configurable: true });
}

function mutationRecordValue(stateMap, record, key) {
  const state = stateMap.get(record);
  if (!state) throw new TypeError('Illegal invocation');
  return state[key];
}

function installMutationObserverPrototype(Constructor) {
  const proto = Constructor.prototype;
  const descriptors = Object.fromEntries(Object.getOwnPropertyNames(proto).map((name) => [name, Object.getOwnPropertyDescriptor(proto, name)]));
  for (const name of Object.keys(descriptors)) delete proto[name];
  for (const name of ['disconnect', 'observe', 'takeRecords', 'constructor']) {
    Object.defineProperty(proto, name, { ...descriptors[name], enumerable: name !== 'constructor', configurable: true });
  }
  Object.defineProperty(proto, Symbol.toStringTag, { value: 'MutationObserver', configurable: true });
}

function mutationObserverValue(stateMap, observer) {
  const state = stateMap.get(observer);
  if (!state) throw new TypeError('Illegal invocation');
  return state;
}

function enqueueMutationRecord(observer, observerState, record) {
  observerState.records.push(record);
  if (observerState.scheduled) return;
  observerState.scheduled = true;
  Promise.resolve().then(() => {
    observerState.scheduled = false;
    const records = takeMutationRecords(observerState);
    if (records.length) observerState.callback(records, observer);
  });
}

function takeMutationRecords(observerState) {
  const out = observerState.records;
  observerState.records = [];
  return out;
}

function mutationRecord(record, prototype, recordState, nodeListPrototype, nodeListState) {
  const next = Object.create(prototype);
  recordState.set(next, {
    type: String(record?.type || ''),
    target: record?.target || null,
    addedNodes: staticNodeList(record?.addedNodes || [], nodeListPrototype, nodeListState),
    removedNodes: staticNodeList(record?.removedNodes || [], nodeListPrototype, nodeListState),
    previousSibling: record?.previousSibling || null,
    nextSibling: record?.nextSibling || null,
    attributeName: record?.attributeName ?? null,
    attributeNamespace: record?.attributeNamespace ?? null,
    oldValue: record?.oldValue ?? null,
  });
  return next;
}

function makeStaticNodeListPrototype(stateMap) {
  const basePrototype = globalThis.NodeList?.prototype || Object.prototype;
  const proto = Object.create(basePrototype);
  Object.defineProperties(proto, {
    entries: { value: function* entries() { yield* staticNodeListEntries(this, stateMap); }, enumerable: true, configurable: true, writable: true },
    keys: { value: function* keys() { yield* staticNodeListKeys(this, stateMap); }, enumerable: true, configurable: true, writable: true },
    values: { value: function* values() { yield* staticNodeListValues(this, stateMap); }, enumerable: true, configurable: true, writable: true },
    forEach: {
      value: function forEach(callback, ...rest) {
        if (typeof callback !== 'function') throw new TypeError('callback must be a function');
        const items = staticNodeListItems(this, stateMap);
        const thisArg = rest[0];
        for (let i = 0; i < items.length; i += 1) callback.call(thisArg, items[i], i, this);
      },
      enumerable: true,
      configurable: true,
      writable: true,
    },
    length: { get() { return staticNodeListItems(this, stateMap).length; }, enumerable: true, configurable: true },
    item: { value: function item(index) { return staticNodeListItem(this, stateMap, index); }, enumerable: true, configurable: true, writable: true },
    constructor: { value: globalThis.NodeList || function NodeList() {}, configurable: true, writable: true },
    [Symbol.iterator]: { value: function* values() { yield* staticNodeListValues(this, stateMap); }, configurable: true, writable: true },
    [Symbol.toStringTag]: { value: 'NodeList', configurable: true },
  });
  return proto;
}

function staticNodeList(nodes, prototype, stateMap) {
  const list = Object.create(prototype);
  const items = Array.from(nodes || []);
  stateMap.set(list, items);
  for (let i = 0; i < items.length; i += 1) {
    Object.defineProperty(list, String(i), { value: items[i], enumerable: true, configurable: true });
  }
  return list;
}

function staticNodeListItems(list, stateMap) {
  const items = stateMap.get(list);
  if (!items) throw new TypeError('Illegal invocation');
  return items;
}

function staticNodeListItem(list, stateMap, index) {
  const numeric = Number(index);
  return Number.isInteger(numeric) && numeric >= 0 ? staticNodeListItems(list, stateMap)[numeric] || null : null;
}

function* staticNodeListValues(list, stateMap) {
  yield* staticNodeListItems(list, stateMap);
}

function* staticNodeListKeys(list, stateMap) {
  const items = staticNodeListItems(list, stateMap);
  for (let i = 0; i < items.length; i += 1) yield i;
}

function* staticNodeListEntries(list, stateMap) {
  const items = staticNodeListItems(list, stateMap);
  for (let i = 0; i < items.length; i += 1) yield [i, items[i]];
}

function normalizeMutationOptions(options = {}) {
  const hasAttributeFilter = Array.isArray(options.attributeFilter);
  if (options.attributes === false && (options.attributeOldValue || hasAttributeFilter)) {
    throw new TypeError('attribute options require attributes to be true');
  }
  if (options.characterData === false && options.characterDataOldValue) {
    throw new TypeError('characterDataOldValue requires characterData to be true');
  }
  const attributes = options.attributes === undefined ? Boolean(options.attributeOldValue || hasAttributeFilter) : Boolean(options.attributes);
  const characterData = options.characterData === undefined ? Boolean(options.characterDataOldValue) : Boolean(options.characterData);
  const normalized = {
    attributes,
    childList: Boolean(options.childList),
    subtree: Boolean(options.subtree),
    attributeOldValue: Boolean(options.attributeOldValue),
    attributeFilter: hasAttributeFilter ? options.attributeFilter.map((name) => String(name)) : null,
    characterData,
    characterDataOldValue: Boolean(options.characterDataOldValue),
  };
  if (!normalized.attributes && !normalized.childList && !normalized.characterData) {
    throw new TypeError('MutationObserver options must enable attributes, childList, or characterData');
  }
  return normalized;
}

function mutationObserverMatches(observerState, record) {
  if (!observerState.target) return false;
  if (!mutationTypeEnabled(observerState.options, record)) return false;
  return mutationTargetMatches(observerState, record.target);
}

function mutationTypeEnabled(options, record) {
  if (record.type === 'attributes') return attributeMutationEnabled(options, record);
  if (record.type === 'childList') return options.childList;
  if (record.type === 'characterData') return options.characterData;
  return false;
}

function attributeMutationEnabled(options, record) {
  if (!options.attributes) return false;
  const filter = options.attributeFilter;
  return !filter || filter.includes(String(record.attributeName || ''));
}

function mutationTargetMatches(observerState, target) {
  return target === observerState.target || (observerState.options.subtree && observerState.target.contains?.(target));
}
