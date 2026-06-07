export function createEventTargetFacade({ Native, define, listenersKey }) {
  const {
    Map = globalThis.Map,
    String = globalThis.String,
    arrayFrom = globalThis.Array.from,
    objectDefineProperty = globalThis.Object.defineProperty,
    reflectApply = globalThis.Reflect.apply,
  } = Native;

  function installEventMethods(proto) {
    define(proto, 'addEventListener', function(type, fn) {
      if (!fn) return;
      const key = String(type);
      if (!this[listenersKey]) this[listenersKey] = new Map();
      const list = this[listenersKey].get(key) || [];
      list[list.length] = fn;
      this[listenersKey].set(key, list);
    });
    define(proto, 'removeEventListener', function(type, fn) {
      const list = this[listenersKey] && this[listenersKey].get(String(type));
      if (!list) return;
      for (let i = 0; i < list.length; i += 1) {
        if (list[i] !== fn) continue;
        for (let j = i + 1; j < list.length; j += 1) list[j - 1] = list[j];
        list.length -= 1;
        return;
      }
    });
    define(proto, 'dispatchEvent', function(event) {
      const list = (this[listenersKey] && this[listenersKey].get(event.type)) || [];
      try {
        if (!event.target) objectDefineProperty(event, 'target', { value: this, configurable: true });
      } catch {}
      const handler = this[`on${event.type}`];
      if (typeof handler === 'function') reflectApply(handler, this, [event]);
      for (const fn of arrayFrom(list)) reflectApply(fn, this, [event]);
      return !event.defaultPrevented;
    });
  }

  return { installEventMethods };
}
