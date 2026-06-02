export function createEventTargetFacade({ define, listenersKey }) {
  function installEventMethods(proto) {
    define(proto, 'addEventListener', function(type, fn) {
      if (!fn) return;
      const key = String(type);
      if (!this[listenersKey]) this[listenersKey] = new Map();
      const list = this[listenersKey].get(key) || [];
      list.push(fn);
      this[listenersKey].set(key, list);
    });
    define(proto, 'removeEventListener', function(type, fn) {
      const list = this[listenersKey] && this[listenersKey].get(String(type));
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    });
    define(proto, 'dispatchEvent', function(event) {
      const list = (this[listenersKey] && this[listenersKey].get(event.type)) || [];
      try {
        if (!event.target) Object.defineProperty(event, 'target', { value: this, configurable: true });
      } catch {}
      const handler = this['on' + event.type];
      if (typeof handler === 'function') handler.call(this, event);
      for (const fn of list.slice()) fn.call(this, event);
      return !event.defaultPrevented;
    });
  }

  return { installEventMethods };
}
