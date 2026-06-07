export function createEventTargetFacade({ Native, define, listenersKey }) {
  const {
    Map = globalThis.Map,
    String = globalThis.String,
    arrayFrom = globalThis.Array.from,
    objectDefineProperty = globalThis.Object.defineProperty,
    reflectApply = globalThis.Reflect.apply,
  } = Native;

  function parseOptions(options) {
    if (options && typeof options === 'object') {
      return {
        capture: !!options.capture,
        once: !!options.once,
        signal: options.signal || null
      };
    }
    return {
      capture: !!options,
      once: false,
      signal: null
    };
  }

  function setupSignal(self, type, fn, options, signal) {
    if (!signal) return null;
    const abortHandler = () => {
      try { self.removeEventListener(type, fn, options); } catch {}
    };
    try {
      signal.addEventListener('abort', abortHandler, { once: true });
    } catch {}
    return abortHandler;
  }

  function addEventListenerHelper(self, type, fn, options) {
    if (!fn) return;
    const key = String(type);
    const opt = parseOptions(options);
    if (opt.signal && opt.signal.aborted) return;

    if (!self[listenersKey]) self[listenersKey] = new Map();
    let list = self[listenersKey].get(key);
    if (!list) {
      list = [];
      self[listenersKey].set(key, list);
    }

    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      if (item.fn === fn && item.capture === opt.capture) return;
    }

    const abortHandler = setupSignal(self, key, fn, options, opt.signal);
    list[list.length] = { fn, capture: opt.capture, once: opt.once, signal: opt.signal, abortHandler };
  }

  function cleanupSignal(item) {
    if (item.signal && item.abortHandler) {
      try {
        item.signal.removeEventListener('abort', item.abortHandler);
      } catch {}
    }
  }

  function removeEventListenerHelper(self, type, fn, options) {
    const list = self[listenersKey] && self[listenersKey].get(String(type));
    if (!list) return;

    const opt = parseOptions(options);

    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      if (item.fn === fn && item.capture === opt.capture) {
        cleanupSignal(item);
        list.splice(i, 1);
        return;
      }
    }
  }

  function invokeListener(self, event, item) {
    const fn = item.fn;
    if (item.once) {
      try { self.removeEventListener(event.type, fn, { capture: item.capture }); } catch {}
    }
    try {
      if (typeof fn === 'function') {
        reflectApply(fn, self, [event]);
      } else if (fn && typeof fn.handleEvent === 'function') {
        reflectApply(fn.handleEvent, fn, [event]);
      }
    } catch {}
  }

  function initializeEventAndRunHandler(self, event) {
    try {
      if (!event.target) objectDefineProperty(event, 'target', { value: self, configurable: true });
    } catch {}
    const handler = self[`on${event.type}`];
    if (typeof handler === 'function') {
      try { reflectApply(handler, self, [event]); } catch {}
    }
  }

  function dispatchEventHelper(self, event) {
    const list = (self[listenersKey] && self[listenersKey].get(event.type)) || [];
    initializeEventAndRunHandler(self, event);

    const snapshot = arrayFrom(list);
    for (const item of snapshot) {
      const currentList = self[listenersKey] && self[listenersKey].get(event.type);
      if (currentList && currentList.includes(item)) {
        invokeListener(self, event, item);
      }
    }
    return !event.defaultPrevented;
  }

  function installEventMethods(proto) {
    define(proto, 'addEventListener', function(type, fn, options) {
      addEventListenerHelper(this, type, fn, options);
    });

    define(proto, 'removeEventListener', function(type, fn, options) {
      removeEventListenerHelper(this, type, fn, options);
    });

    define(proto, 'dispatchEvent', function(event) {
      return dispatchEventHelper(this, event);
    });
  }

  return { installEventMethods };
}
