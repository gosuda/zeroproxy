
  function installStorageFacades(w) {
    // Isolate each target origin in its own key-prefixed namespace inside the
    // proxy origin's native storage. `localStorage` is scoped by origin hash;
    // `sessionStorage` is scoped by both tab session ID and origin hash.
    const targetOriginKey = securityOrigin();
    // Compute a compact FNV-1a 32-bit hash of the target origin.
    const originHash = (() => {
      let h = 0x811c9dc5;
      for (let i = 0; i < targetOriginKey.length; i++) { h ^= targetOriginKey.charCodeAt(i); h = Math.imul(h, 16777619); }
      return ('00000000' + (h >>> 0).toString(16)).slice(-8);
    })();
    const localPrefix = 'zp:l:' + originHash + ':';
    const cachePrefix = 'zp:c:' + originHash + ':';
    const idbPrefix = 'zp:i:' + originHash + ':';
    const bcPrefix = 'zp:b:' + originHash + ':';
    const sharedWorkerPrefix = 'zp:w:' + originHash + ':';
    // Capture native storage references before defining the accessors so the
    // getters do not recurse into themselves, and cache the wrapped facades so
    // repeated reads return the same instance.
    const nativeLocalStorage = w.localStorage;
    const nativeSessionStorage = w.sessionStorage;
    // Persist the tab-session identifier inside `nativeSessionStorage` itself so
    // `sessionStorage` survives cross-site navigations within the same browser tab.
    const tabSessionKey = '__zp_sid';
    let tabSessionId = '';
    try {
      tabSessionId = nativeSessionStorage && nativeSessionStorage.getItem(tabSessionKey);
      if (!tabSessionId) {
        tabSessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
        if (nativeSessionStorage) nativeSessionStorage.setItem(tabSessionKey, tabSessionId);
      }
    } catch { tabSessionId = boot.tabId; }
    const sessionPrefix = 'zp:s:' + tabSessionId + ':' + originHash + ':';
    if (w === root) {
      // Back `window.name` for the top window with tab-session + origin-scoped
      // storage and clear the underlying native `window.name` so values do not
      // leak across cross-origin navigations.
      const nameKey = 'zp:n:' + tabSessionId + ':' + originHash;
      let cachedName;
      rootWindowNameStore = {
        get() {
          if (cachedName === undefined) { try { cachedName = nativeSessionStorage.getItem(nameKey) || ''; } catch { cachedName = ''; } }
          return cachedName;
        },
        set(v) { cachedName = String(v); try { nativeSessionStorage.setItem(nameKey, cachedName); } catch {} },
      };
      // Only clear the native `window.name` on the top window; a child frame's
      // `window.name` is its browsing-context name used by `frames[name]` and `<a target>`.
      const isTopFrame = (() => { try { return w.top === w; } catch { return true; } })();
      if (isTopFrame) { try { winSet(w, 'name', ''); } catch {} }
      else {
        rootWindowNameStore = {
          get() { try { return String(winGet(w, 'name') || ''); } catch { return ''; } },
          set(v) { try { winSet(w, 'name', String(v)); } catch {} },
        };
      }
    }
    let wrappedLocalStorage = null;
    let wrappedSessionStorage = null;
    defineAccessor(w, 'localStorage', () => {
      if (opaqueDocument) throw opaqueDenied("Failed to read the 'localStorage' property from 'Window'");
      if (!wrappedLocalStorage) wrappedLocalStorage = prefixedStorage(nativeLocalStorage, localPrefix);
      return wrappedLocalStorage;
    });
    defineAccessor(w, 'sessionStorage', () => {
      if (opaqueDocument) throw opaqueDenied("Failed to read the 'sessionStorage' property from 'Window'");
      if (!wrappedSessionStorage) wrappedSessionStorage = prefixedStorage(nativeSessionStorage, sessionPrefix);
      return wrappedSessionStorage;
    });
    // Filter and translate native `storage` events in capture phase so the page
    // only observes writes belonging to its own origin namespace, with the prefix
    // stripped from `key` and its own facade as `storageArea`.
    try {
      const hasOwn = Object.prototype.hasOwnProperty;
      w.addEventListener('storage', ev => {
        if (!ev.isTrusted || hasOwn.call(ev, 'storageArea')) return;
        if (opaqueDocument) { ev.stopImmediatePropagation(); return; }
        const area = ev.storageArea;
        const key = ev.key;
        let prefix = null;
        let pageArea = null;
        if (nativeLocalStorage && area === nativeLocalStorage) { prefix = localPrefix; pageArea = w.localStorage; }
        else if (nativeSessionStorage && area === nativeSessionStorage) { prefix = sessionPrefix; pageArea = w.sessionStorage; }
        // Suppress events from other namespaces, internal `__zp_` keys, or native `clear()` (`key === null`).
        if (prefix === null || typeof key !== 'string' || !key.startsWith(prefix) || key.startsWith(prefix + '__zp_')) {
          ev.stopImmediatePropagation();
          return;
        }
        const view = { key: key.slice(prefix.length), storageArea: pageArea, url: deproxyURL(ev.url, { fallback: 'share' }) };
        for (const name of Object.keys(view)) Object.defineProperty(ev, name, { value: view[name], enumerable: false, configurable: true, writable: false });
      }, true);
    } catch {}
    if (w.indexedDB) {
      const nativeIDB = w.indexedDB;
      // Expose `indexedDB` via an accessor to match the native property descriptor shape.
      const virtualIDB = {
        open(name, version) {
          if (opaqueDocument) throw opaqueDenied("Failed to execute 'open' on 'IDBFactory'", 'access to the Indexed Database API is denied in this context.');
          return nativeIDB.open(idbPrefix + String(name), version);
        },
        deleteDatabase(name) {
          if (opaqueDocument) throw opaqueDenied("Failed to execute 'deleteDatabase' on 'IDBFactory'", 'access to the Indexed Database API is denied in this context.');
          return nativeIDB.deleteDatabase(idbPrefix + String(name));
        },
        cmp: nativeIDB.cmp ? nativeIDB.cmp.bind(nativeIDB) : undefined,
        databases: nativeIDB.databases ? () => opaqueDocument ? Promise.reject(opaqueDenied("Failed to execute 'databases' on 'IDBFactory'", 'Access to the IndexedDB API is denied in this context.')) : nativeIDB.databases().then(list => list.filter(db => db.name && db.name.startsWith(idbPrefix)).map(db => Object.assign({}, db, { name: db.name.slice(idbPrefix.length) }))) : undefined
      };
      defineAccessor(w, 'indexedDB', () => virtualIDB);
      // Alias `webkitIndexedDB` to the namespaced facade so legacy callers cannot bypass origin isolation.
      if (w.webkitIndexedDB) try { defineAccessor(w, 'webkitIndexedDB', () => virtualIDB); } catch {}
      for (const alias of ['IDBKeyRange','IDBRequest','IDBTransaction','IDBCursor','IDBCursorWithValue','IDBDatabase','IDBFactory','IDBObjectStore','IDBIndex','IDBOpenDBRequest','IDBVersionChangeEvent','IDBFileHandle','IDBMutableFile','IDBFileRequest','IDBLocaleAwareKeyRange']) {
        const webkit = 'webkit' + alias;
        if (w[webkit] !== undefined && w[alias] !== undefined) try { define(w, webkit, w[alias]); } catch {}
      }
    }
    if (w.caches) {
      const nativeCaches = w.caches;
      const virtualCaches = {
        open(name) { return nativeCaches.open(cachePrefix + String(name)); },
        delete(name) { return nativeCaches.delete(cachePrefix + String(name)); },
        has(name) { return nativeCaches.has(cachePrefix + String(name)); },
        keys() { return nativeCaches.keys().then(keys => keys.filter(k => k.startsWith(cachePrefix)).map(k => k.slice(cachePrefix.length))); },
        match(request, opts) { return nativeCaches.keys().then(keys => keys.filter(k => k.startsWith(cachePrefix))).then(async keys => { for (const k of keys) { const hit = await (await nativeCaches.open(k)).match(request, opts); if (hit) return hit; } return undefined; }); }
      };
      defineAccessor(w, 'caches', () => {
        if (opaqueDocument) throw opaqueDenied("Failed to read the 'caches' property from 'Window'", "Cache storage is disabled because the document is sandboxed and lacks the 'allow-same-origin' flag.");
        return virtualCaches;
      });
    }
    // Back `cookieStore` with the virtual cookie jar (`documentCookieRecords`) so
    // native proxy-origin cookies are not exposed.
    if (w.cookieStore) {
      let deniedCookieStore = null;
      const denyCookieStore = () => {
        if (deniedCookieStore) return deniedCookieStore;
        deniedCookieStore = {};
        for (const m of ['get', 'getAll', 'set', 'delete']) {
          define(deniedCookieStore, m, function () { return Promise.reject(opaqueDenied("Failed to execute '" + m + "' on 'CookieStore'", 'Access to the CookieStore API is denied in this context.')); });
        }
        define(deniedCookieStore, 'addEventListener', function addEventListener() {});
        define(deniedCookieStore, 'removeEventListener', function removeEventListener() {});
        return deniedCookieStore;
      };
      defineAccessor(w, 'cookieStore', () => (opaqueDocument ? denyCookieStore() : virtualCookieStore()));
    }
    // Scope OPFS (`navigator.storage.getDirectory()`) to a per-target-origin subdirectory.
    try {
      const storageMgr = w.navigator && w.navigator.storage;
      if (storageMgr && typeof storageMgr.getDirectory === 'function' && typeof storageMgr.getDirectory.__zpWrapped !== 'boolean') {
        const nativeGetDirectory = storageMgr.getDirectory.bind(storageMgr);
        let oh = 0x811c9dc5;
        const opfsKey = securityOrigin();
        for (let i = 0; i < opfsKey.length; i++) { oh ^= opfsKey.charCodeAt(i); oh = Math.imul(oh, 16777619); }
        const opfsRoot = 'zp:o:' + ('00000000' + (oh >>> 0).toString(16)).slice(-8);
        const wrapped = function getDirectory() {
          if (opaqueDocument) return Promise.reject(opaqueDenied("Storage directory access is denied because the context is sandboxed and lacks the 'allow-same-origin' flag.", ''));
          return nativeGetDirectory().then(d => d.getDirectoryHandle(opfsRoot, { create: true }));
        };
        try { Object.defineProperty(wrapped, '__zpWrapped', { value: true }); } catch {}
        maskNativeFunction(wrapped, 'getDirectory');
        define(storageMgr, 'getDirectory', wrapped);
        // Mask the per-target subdirectory's `.name` as `''` to match the native OPFS root handle.
        const FSH = w.FileSystemHandle && w.FileSystemHandle.prototype;
        const nameDesc = FSH && Object.getOwnPropertyDescriptor(FSH, 'name');
        if (nameDesc && typeof nameDesc.get === 'function' && nameDesc.configurable) {
          const nativeName = nameDesc.get;
          defineMasked(FSH, 'name', {
            get() { const n = nativeName.call(this); return n === opfsRoot ? '' : n; },
            enumerable: nameDesc.enumerable, configurable: true,
          });
        }
        if (storageMgr.estimate) {
          const nativeEstimate = storageMgr.estimate.bind(storageMgr);
          define(storageMgr, 'estimate', function estimate() {
            if (opaqueDocument) return Promise.reject(normalizedError('TypeError'));
            return nativeEstimate();
          });
        }
      }
    } catch {}
    // Hide unvirtualized legacy webkit quota and sync filesystem globals.
    for (const legacy of ['webkitPersistentStorage','webkitTemporaryStorage','webkitStorageInfo','webkitRequestFileSystemSync','webkitResolveLocalFileSystemURLSync']) {
      try { if (w[legacy] !== undefined) define(w, legacy, undefined); } catch {}
    }
    // Keep `webkitRequestFileSystem` and `webkitResolveLocalFileSystemURL` as functions
    // that asynchronously invoke their error callback with `SecurityError`, matching
    // Chrome's behavior when storage access is denied.
    for (const [legacy, errorIndex, length] of [['webkitRequestFileSystem', 3, 3], ['webkitResolveLocalFileSystemURL', 2, 2]]) {
      try {
        if (typeof w[legacy] !== 'function') continue;
        const denied = function () {
          const onError = arguments[errorIndex];
          if (typeof onError === 'function') Native.setTimeout(() => { try { onError(normalizedError('SecurityError')); } catch {} }, 0);
        };
        Object.defineProperty(denied, 'name', { value: legacy, configurable: true });
        Object.defineProperty(denied, 'length', { value: length, configurable: true });
        maskNativeFunction(denied, legacy);
        define(w, legacy, denied);
      } catch {}
    }
    // Emulate `fetchLater` over `postRuntimeEnvelope` with `keepalive: true` on
    // `pagehide` or `visibilitychange` to `'hidden'`.
    try {
      if (typeof w.fetchLater === 'function' && Native.fetch && Native.Request) {
        const fl = function fetchLater(input, init) {
          const opts = init || {};
          const result = { activated: false };
          let canceled = false, fired = false;
          const unlisten = [];
          const fire = () => {
            if (fired || canceled) return;
            fired = true;
            result.activated = true;
            for (const u of unlisten) u();
            try {
              const raw = input && typeof input === 'object' && typeof input.url === 'string' ? input.url : String(input);
              const target = requestTargetURL(raw);
              const req = (input && typeof input === 'object' && typeof input.clone === 'function') ? new Native.Request(input, opts) : new Native.Request(target, opts);
              let bodyBytes = null;
              const b = opts.body;
              if (typeof b === 'string') bodyBytes = new TextEncoder().encode(b);
              else if (b instanceof ArrayBuffer) bodyBytes = new Uint8Array(b);
              else if (ArrayBuffer.isView(b)) bodyBytes = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
              else if (b instanceof URLSearchParams) bodyBytes = new TextEncoder().encode(String(b));
              const payload = {
                tabId: boot.tabId, entryId: activeEntryId, documentURL: virtualURL.href, url: target,
                init: { method: req.method, headers: Array.from(req.headers.entries()), body: null,
                        credentials: req.credentials, mode: req.mode, referrer: req.referrer,
                        referrerPolicy: req.referrerPolicy || documentReferrerPolicy(), redirect: req.redirect, cache: req.cache, integrity: req.integrity },
              };
              postRuntimeEnvelope(target, payload, bodyBytes, { keepalive: true }).catch(() => {});
            } catch {}
          };
          const onHide = () => fire();
          w.addEventListener('pagehide', onHide);
          unlisten.push(() => w.removeEventListener('pagehide', onHide));
          if (w.document) {
            const onVis = () => { if (w.document.visibilityState === 'hidden') fire(); };
            w.document.addEventListener('visibilitychange', onVis);
            unlisten.push(() => w.document.removeEventListener('visibilitychange', onVis));
          }
          if (opts.signal && typeof opts.signal.addEventListener === 'function') {
            const onAbort = () => { canceled = true; for (const u of unlisten) u(); };
            if (opts.signal.aborted) canceled = true; else opts.signal.addEventListener('abort', onAbort, { once: true });
          }
          return result;
        };
        maskNativeFunction(fl, 'fetchLater');
        define(w, 'fetchLater', fl);
      }
    } catch {}
    // Normalize proxy-origin URLs passed to `new URL()`, `URL.canParse()`, and
    // `URL.parse()` against `baseURL` so proxy routing paths do not leak.
    if (Native.URL) {
      const wrapURLBase = b => {
        const g = unleakedTargetRaw(String(b));
        return g === null ? baseURL : g;
      };
      const ZPURL = function URL(input, base) {
        // The engine words a missing `new` and a missing argument; the native constructor says it.
        if (!new.target) return nativeApply(Native.URL, this, arguments);
        if (arguments.length < 1) return nativeReflectConstruct(Native.URL, []);
        const g = unleakedTargetRaw(String(input));
        const inp = g === null ? baseURL : g;
        // Per WebIDL, an explicit `undefined` optional argument is treated as omitted.
        return base !== undefined ? new Native.URL(inp, wrapURLBase(base)) : new Native.URL(inp);
      };
      try { ZPURL.prototype = Native.URL.prototype; } catch {}
      // Only record `Blob` instances in `pageBlobURLs` (not `MediaSource` or `MediaStream`).
      const blobSize = w.Blob && Object.getOwnPropertyDescriptor(w.Blob.prototype, 'size');
      const isBlob = o => { try { blobSize.get.call(o); return true; } catch { return false; } };
      for (const sm of ['createObjectURL', 'revokeObjectURL', 'canParse', 'parse']) {
        const orig = Native.URL[sm];
        if (typeof orig !== 'function') continue;
        ZPURL[sm] = (sm === 'canParse' || sm === 'parse')
          ? function (u, b) { return b !== undefined ? orig.call(Native.URL, u, wrapURLBase(b)) : orig.call(Native.URL, u); }
          : sm === 'createObjectURL'
            ? function (obj) {
              const u = orig.call(Native.URL, obj);
              if (blobSize && isBlob(obj)) pageBlobURLs.set(u, obj);
              return u;
            }
            : function (u) {
              try { pageBlobURLs.delete(String(u)); } catch {}
              return orig.call(Native.URL, u);
            };
        ZPURL[sm] = guardMethod(ZPURL, sm, ZPURL[sm], orig, () => true);
        try { Object.defineProperty(ZPURL[sm], 'name', { value: sm, configurable: true }); } catch {}
        maskNativeFunction(ZPURL[sm], sm);
      }
      brandLikeNative(ZPURL, null, 'URL');
      define(w, 'URL', ZPURL);
      // Alias `webkitURL` to `ZPURL` via `Object.defineProperty` so `ZPURL.name` stays `"URL"`.
      if (w.webkitURL) { try { Object.defineProperty(w, 'webkitURL', { value: ZPURL, enumerable: nativeEnumerability(w, 'webkitURL'), configurable: false, writable: true }); } catch {} }
    }
    // Stash the original native constructor on `w[stash]` so re-installation on a
    // pre-contained child window wraps the native constructor rather than double-wrapping.
    function realCtor(w, stash, cur) {
      const real = w[stash] || cur;
      if (!w[stash]) { try { Object.defineProperty(w, stash, { value: real, enumerable: false, configurable: false, writable: true }); } catch {} }
      return real;
    }
    // Prefix `BroadcastChannel` names with the target origin hash so messages do
    // not cross target origins, while masking `.name` with the requested channel name.
    if (w.BroadcastChannel) {
      const NativeBC = realCtor(w, '__zp_realBC', w.BroadcastChannel);
      const BCWrap = function(name) {
        const requested = String(name);
        const native = new NativeBC(bcPrefix + requested);
        try { Object.defineProperty(native, 'name', { value: requested, configurable: true, enumerable: true }); } catch {}
        return native;
      };
      try { BCWrap.prototype = NativeBC.prototype; } catch {}
      try { define(w, 'BroadcastChannel', BCWrap); } catch {}
    }
    // Scope `SharedWorker` instances by target origin hash and bootstrap URL.
    if (w.SharedWorker) {
      const NativeSW = realCtor(w, '__zp_realSW', w.SharedWorker);
      const SWWrap = function(url, opts) {
        return new NativeSW(workerBootstrapURL(url), prefixedSharedWorkerOptions(sharedWorkerPrefix, opts));
      };
      try { SWWrap.prototype = NativeSW.prototype; } catch {}
      try { define(w, 'SharedWorker', SWWrap); } catch {}
    }
    if (w.document) {
      const docProto = w.Document && w.Document.prototype;
      // `document.domain` returns the virtual hostname (or `''` in an opaque document);
      // the setter is a no-op matching modern Chrome behavior.
      const virtualDomain = virtualURL.hostname.toLowerCase();
      defineOnProto(
        w.document,
        docProto,
        'domain',
        () => (opaqueDocument ? '' : virtualDomain),
        () => {}
      );
    }
    // Virtualize `window.origin` / `self.origin` and `isSecureContext` for the target URL.
    try { defineMasked(w, 'origin', { get() { return displayOrigin(securityOrigin()); }, configurable: true, enumerable: true }); } catch {}
    try {
      const vsc = virtualURL.protocol === 'https:' || virtualURL.protocol === 'wss:' || virtualURL.protocol === 'file:'
        || /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(virtualURL.hostname) || /\.localhost$/i.test(virtualURL.hostname);
      defineMasked(w, 'isSecureContext', { get() { return vsc; }, configurable: true, enumerable: true });
    } catch {}
    // Virtualize PerformanceEntry `.name` and `toJSON()` so resource timing entries
    // report target URLs rather than `/zp/api/fetch?url=...` proxy paths.
    try {
      const entryProto = w.PerformanceEntry && w.PerformanceEntry.prototype;
      const nameDesc = entryProto && Object.getOwnPropertyDescriptor(entryProto, 'name');
      if (nameDesc && typeof nameDesc.get === 'function') {
        const nativeName = nameDesc.get;
        // Capture the initial virtual URL for the `'navigation'` entry so later
        // `location.hash` or `pushState` updates do not mutate its `.name`.
        const bootVirtualHref = virtualURL.href;
        const typeDesc = Object.getOwnPropertyDescriptor(entryProto, 'entryType');
        const isNavigationEntry = e => { try { return !!typeDesc && typeDesc.get.call(e) === 'navigation'; } catch { return false; } };
        defineMasked(entryProto, 'name', {
          get() {
            if (isNavigationEntry(this)) return bootVirtualHref;
            return deproxyURL(nativeName.call(this), { fallback: 'share' });
          },
          configurable: true,
          enumerable: nameDesc.enumerable
        });
        // Override `toJSON()` as well because native serialization reads internal slots directly.
        const nativeToJSON = entryProto.toJSON;
        if (typeof nativeToJSON === 'function') {
          define(entryProto, 'toJSON', function toJSON() {
            const out = nativeToJSON.call(this);
            try { if (out && typeof out === 'object' && 'name' in out) out.name = isNavigationEntry(this) ? bootVirtualHref : deproxyURL(out.name, { fallback: 'share' }); } catch {}
            return out;
          });
        }
        // Match `getEntriesByName` against virtualized entry names when the native lookup finds no direct match.
        const perfProto = w.Performance && w.Performance.prototype;
        const nativeByName = perfProto && perfProto.getEntriesByName;
        if (typeof nativeByName === 'function') {
          define(perfProto, 'getEntriesByName', function getEntriesByName(name, type) {
            const wanted = String(name);
            const direct = nativeByName.call(this, wanted, type);
            if (direct && direct.length) return direct;
            const all = type ? this.getEntriesByType(type) : this.getEntries();
            return Array.prototype.filter.call(all, e => {
              try { return e.name === wanted; } catch { return false; }
            });
          });
        }
      }
      // Align `PerformanceResourceTiming` attributes with the virtualized network environment
      // (where `navigator.serviceWorker.controller === null` and HTTPS targets report TLS/H2 metadata).
      const resProto = w.PerformanceResourceTiming && w.PerformanceResourceTiming.prototype;
      const timingOverrides = {
        workerStart: () => 0,
        nextHopProtocol: (e, raw) => {
          if (raw) return raw;
          try { return new Native.URL(e.name).protocol === 'https:' ? 'h2' : 'http/1.1'; }
          catch { return 'h2'; }
        },
        deliveryType: () => '',
        encodedBodySize: (e, raw) => {
          const known = encodedSizes.get(e.name);
          return known && known < raw ? known : raw;
        },
        transferSize: (e, raw) => {
          if (raw) return raw;
          const known = encodedSizes.get(e.name);
          if (known) return known + 300;
          return e.encodedBodySize ? e.encodedBodySize + 300 : raw;
        },
        secureConnectionStart: (e, raw) => {
          if (raw) return raw;
          try { if (new Native.URL(e.name).protocol !== 'https:') return raw; } catch { return raw; }
          return e.connectStart || raw;
        },
      };
      if (resProto) {
        for (const key of Object.keys(timingOverrides)) {
          const desc = Object.getOwnPropertyDescriptor(resProto, key);
          if (!desc || typeof desc.get !== 'function') continue;
          const nativeGet = desc.get;
          const fix = timingOverrides[key];
          try {
            defineMasked(resProto, key, {
              get() { try { return fix(this, nativeGet.call(this)); } catch { return nativeGet.call(this); } },
              configurable: true,
              enumerable: desc.enumerable,
            });
            maskAccessorFn(Object.getOwnPropertyDescriptor(resProto, key).get, 'get', key);
          } catch {}
        }
        const nativeResToJSON = resProto.toJSON;
        if (typeof nativeResToJSON === 'function') {
          define(resProto, 'toJSON', function toJSON() {
            const out = nativeResToJSON.call(this);
            try {
              for (const key of Object.keys(timingOverrides)) {
                if (out && typeof out === 'object' && key in out) out[key] = this[key];
              }
            } catch {}
            return out;
          });
        }
      }

      // Filter out internal proxy infrastructure assets (`/zp/assets/*`, `/__zp/*`,
      // worker bootstrap scripts, and `blob:` URLs) that do not map to a target URL.
      const rawEntryName = e => (nameDesc && nameDesc.get ? Reflect.apply(nameDesc.get, e, []) : e.name);
      const isInfraEntry = (e) => {
        try {
          const n = rawEntryName(e);
          if (typeof n !== 'string') return false;
          if (n.lastIndexOf(proxyOrigin, 0) === 0) {
            // Keep `/zp/p/<token>` frame document entries (`initiatorType === "iframe"`).
            try { if (ZP.isSharePath(new Native.URL(n).pathname)) return false; } catch {}
            return deproxyURL(n).lastIndexOf(proxyOrigin, 0) === 0;
          }
          return n.lastIndexOf('blob:' + proxyOrigin, 0) === 0;
        } catch { return false; }
      };
      const perfProtoForList = w.Performance && w.Performance.prototype;
      if (perfProtoForList) {
        for (const method of ['getEntries', 'getEntriesByType', 'getEntriesByName']) {
          const native = perfProtoForList[method];
          if (typeof native !== 'function') continue;
          define(perfProtoForList, method, function (...args) {
            const out = native.apply(this, args);
            try { return Array.prototype.filter.call(out, e => !isInfraEntry(e)); } catch { return out; }
          });
        }
      }
      // Apply the same infrastructure-entry filter to `PerformanceObserver` callbacks.
      const NativePO = w.PerformanceObserver;
      if (typeof NativePO === 'function') {
        const ZPPerformanceObserver = function PerformanceObserver(cb) {
          const wrapped = typeof cb !== 'function' ? cb : function (list, obs) {
            const filtered = {
              getEntries: () => Array.prototype.filter.call(list.getEntries(), e => !isInfraEntry(e)),
              getEntriesByType: (t) => Array.prototype.filter.call(list.getEntriesByType(t), e => !isInfraEntry(e)),
              getEntriesByName: (n, t) => Array.prototype.filter.call(list.getEntriesByName(n, t), e => !isInfraEntry(e)),
            };
            try { Object.setPrototypeOf(filtered, Object.getPrototypeOf(list)); } catch {}
            return cb.call(this, filtered, obs);
          };
          return Reflect.construct(NativePO, [wrapped], new.target || ZPPerformanceObserver);
        };
        try { ZPPerformanceObserver.prototype = NativePO.prototype; } catch {}
        try { defineMasked(ZPPerformanceObserver, 'supportedEntryTypes', { get: () => NativePO.supportedEntryTypes, configurable: true }); } catch {}
        define(w, 'PerformanceObserver', ZPPerformanceObserver);
      }
      // `toJSON()` reads the same entry as `name` does, so it must give the same name: a resource entry's own `toJSON` shadows the generic one above,
      // and a navigation entry has one of its own. A script that sends its timeline (`JSON.stringify(performance.getEntries())`) would otherwise
      // send the proxy's URL (and the share fragment of the document's) where a browser sends the target's.
      const entryTypeGet = entryProto && (Object.getOwnPropertyDescriptor(entryProto, 'entryType') || {}).get;
      const timelineBootHref = virtualURL.href;
      const timelineName = (entry, raw) => {
        try { return entryTypeGet && entryTypeGet.call(entry) === 'navigation' ? timelineBootHref : deproxyURL(raw, { fallback: 'share' }); } catch { return raw; }
      };
      for (const protoName of ['PerformanceResourceTiming', 'PerformanceNavigationTiming']) {
        const proto = w[protoName] && w[protoName].prototype;
        if (!proto || !Object.prototype.hasOwnProperty.call(proto, 'toJSON')) continue;
        const nativeToJSON = proto.toJSON;
        if (typeof nativeToJSON !== 'function') continue;
        define(proto, 'toJSON', function toJSON() {
          const out = nativeToJSON.call(this);
          try {
            if (out && typeof out === 'object') {
              if ('name' in out) out.name = timelineName(this, out.name);
              for (const key of Object.keys(timingOverrides)) if (key in out) out[key] = this[key];
            }
          } catch {}
          return out;
        });
      }
      // Long-animation-frame script attribution: a script's `sourceURL` names the target script (as an entry's `name` does), and the membrane's own
      // handlers (the prelude's `message` listener, its promise reactions) are left out, as natively only the page's scripts are listed.
      const scriptProto = w.PerformanceScriptTiming && w.PerformanceScriptTiming.prototype;
      const loafProto = w.PerformanceLongAnimationFrameTiming && w.PerformanceLongAnimationFrameTiming.prototype;
      const sourceURLGet = scriptProto && (Object.getOwnPropertyDescriptor(scriptProto, 'sourceURL') || {}).get;
      const loafScriptsDesc = loafProto && Object.getOwnPropertyDescriptor(loafProto, 'scripts');
      if (sourceURLGet && loafScriptsDesc && loafScriptsDesc.get) {
        const isInfraScriptURL = u => {
          try {
            if (typeof u !== 'string' || u.lastIndexOf(proxyOrigin, 0) !== 0) return false;
            const p = new Native.URL(u).pathname;
            return p.indexOf('/zp/assets/') === 0 || p.indexOf('/__zp/') === 0 || p.indexOf('/zp/worker-bootstrap') === 0;
          } catch { return false; }
        };
        defineMasked(scriptProto, 'sourceURL', {
          get() { const raw = sourceURLGet.call(this); try { return typeof raw === 'string' && raw ? deproxyURL(raw, { fallback: 'share' }) : raw; } catch { return raw; } },
          configurable: true, enumerable: true,
        });
        // `invoker` is the script's URL for a classic script or module (and a name such as `Window.onload` otherwise).
        const invokerDesc = Object.getOwnPropertyDescriptor(scriptProto, 'invoker');
        if (invokerDesc && typeof invokerDesc.get === 'function') {
          const invokerGet = invokerDesc.get;
          defineMasked(scriptProto, 'invoker', {
            get() { const raw = invokerGet.call(this); try { return typeof raw === 'string' && /^https?:/i.test(raw) ? deproxyURL(raw, { fallback: 'share' }) : raw; } catch { return raw; } },
            configurable: true, enumerable: invokerDesc.enumerable,
          });
        }
        const nativeScripts = loafScriptsDesc.get;
        const visibleScripts = newWeakMap();
        defineMasked(loafProto, 'scripts', {
          get() {
            // The same frozen array on every read, as natively.
            let list = visibleScripts.get(this);
            if (!list) {
              list = Object.freeze(Array.prototype.filter.call(nativeScripts.call(this), s => !isInfraScriptURL(sourceURLGet.call(s))));
              visibleScripts.set(this, list);
            }
            return list;
          },
          configurable: true, enumerable: loafScriptsDesc.enumerable,
        });
        const nativeScriptJSON = scriptProto.toJSON;
        if (typeof nativeScriptJSON === 'function') {
          define(scriptProto, 'toJSON', function toJSON() {
            const out = nativeScriptJSON.call(this);
            try { if (out && typeof out === 'object') { if ('sourceURL' in out) out.sourceURL = this.sourceURL; if ('invoker' in out) out.invoker = this.invoker; } } catch {}
            return out;
          });
        }
        const nativeLoafJSON = loafProto.toJSON;
        if (typeof nativeLoafJSON === 'function') {
          define(loafProto, 'toJSON', function toJSON() {
            const out = nativeLoafJSON.call(this);
            try { if (out && typeof out === 'object' && 'scripts' in out) out.scripts = Array.prototype.map.call(this.scripts, s => s.toJSON()); } catch {}
            return out;
          });
        }
      }
    } catch {}
    // Virtualize FeaturePolicy, Notification.permission, and Permissions.query
    // for frames that are virtually cross-origin to their embedder. A
    // cross-origin frame retains a policy-controlled feature only when its
    // embedder allows the feature for the frame's virtual origin or delegates
    // it via the iframe `allow` attribute.
    const crossOriginFrame = (() => {
      try {
        const p = winGet(root, 'parent');
        if (!p || p === root || opaqueDocument) return false;
        const o = typeof p.__zp_origin === 'function' ? p.__zp_origin() : '';
        return typeof o === 'string' && o !== '' && o !== securityOrigin();
      } catch { return false; }
    })();
    const ownOrigin = () => displayOrigin(securityOrigin());
    const toVirtualAllowlist = list => Array.from(list || [], o => (o === proxyOrigin ? ownOrigin() : o));
    // `allow="camera; fullscreen 'src'; geolocation https://a.example"`: does it delegate `feature` to `origin`?
    function allowAttributeGrants(el, feature, origin) {
      let raw = '';
      try { raw = el ? String(Native.getAttribute.call(el, 'allow') || '') : ''; } catch {}
      for (const part of raw.split(';')) {
        const tokens = part.trim().split(/\s+/).filter(Boolean);
        if (!tokens.length || tokens[0].toLowerCase() !== feature) continue;
        const list = tokens.slice(1);
        if (!list.length) return true; // 'src' by default: the frame's own origin
        for (const t of list) {
          const v = t.replace(/^'|'$/g, '').toLowerCase();
          if (v === '*' || v === 'src') return true;
          if (v === 'none') return false;
          try { if (new URL(t).origin === origin) return true; } catch {}
        }
      }
      return false;
    }
    const fpProto = w.FeaturePolicy && w.FeaturePolicy.prototype;
    if (fpProto) {
      const nativeAllowed = fpProto.allowedFeatures;
      const nativeAllowlist = fpProto.getAllowlistForFeature;
      const nativeAllows = fpProto.allowsFeature;
      // Record which document or iframe element a policy object answers for.
      const owners = newWeakMap();
      const hookOwner = (proto, kind) => {
        const d = proto && Object.getOwnPropertyDescriptor(proto, 'featurePolicy');
        if (!d || typeof d.get !== 'function') return;
        const get = d.get;
        replaceNativeAccessor(proto, 'featurePolicy', function () {
          const policy = Reflect.apply(get, this, []);
          if (policy && typeof policy === 'object') owners.set(policy, { kind, node: this });
          return policy;
        });
      };
      hookOwner(w.Document && w.Document.prototype, 'document');
      hookOwner(w.HTMLIFrameElement && w.HTMLIFrameElement.prototype, 'frame');
      // Check whether the embedder's virtual policy grants a feature to a cross-origin frame.
      function embedderGrants(parentDoc, el, feature, origin) {
        try {
          const pp = parentDoc && parentDoc.featurePolicy;
          if (!pp) return true;
          if (!pp.allowsFeature(feature)) return false;
          return pp.allowsFeature(feature, origin) || allowAttributeGrants(el, feature, origin);
        } catch { return true; }
      }
      // Filter the native policy query through the virtual cross-origin delegation check.
      function virtuallyAllows(policy, feature) {
        const own = owners.get(policy);
        if (!own) return true;
        if (own.kind === 'document') {
          if (own.node !== w.document || !crossOriginFrame) return true;
          let parentDoc = null;
          try { parentDoc = winGet(root, 'parent').document; } catch {}
          return embedderGrants(parentDoc, winGet(root, 'frameElement'), feature, ownOrigin());
        }
        // Evaluate an iframe's container policy against its virtual src origin.
        let src = '';
        try { src = new URL(targetURLForElement(own.node, Native.getAttribute.call(own.node, 'src') || '') || 'about:blank').origin; } catch {}
        if (!src || src === 'null' || src === ownOrigin()) return true;
        return embedderGrants(w.document, own.node, feature, src);
      }
      replaceNativeMethod(fpProto, 'allowedFeatures', orig => ({ allowedFeatures() {
        const real = Reflect.apply(orig, this, []);
        return owners.has(this) ? real.filter(f => virtuallyAllows(this, f)) : real;
      } }).allowedFeatures);
      replaceNativeMethod(fpProto, 'getAllowlistForFeature', orig => ({ getAllowlistForFeature(...args) {
        const real = Reflect.apply(orig, this, args);
        if (!owners.has(this)) return real;
        if (!virtuallyAllows(this, String(args[0]))) return [];
        return toVirtualAllowlist(real);
      } }).getAllowlistForFeature);
      replaceNativeMethod(fpProto, 'allowsFeature', orig => ({ allowsFeature(...args) {
        const real = Reflect.apply(orig, this, args);
        if (!owners.has(this)) return real;
        const feature = String(args[0]);
        if (!virtuallyAllows(this, feature)) return false;
        if (args.length < 2 || args[1] === undefined) return real;
        let origin;
        try { origin = new URL(String(args[1])).origin; } catch { return false; }
        const list = toVirtualAllowlist(Reflect.apply(nativeAllowlist, this, [feature]));
        return list.includes('*') || list.includes(origin);
      } }).allowsFeature);
      void nativeAllowed; void nativeAllows;
    }
    // A permission backed by a policy-controlled feature is denied when the feature is disallowed.
    function featureDeniedHere(name) {
      try {
        const policy = w.document.featurePolicy;
        if (!policy || !policy.features().includes(name)) return false;
        return !policy.allowsFeature(name);
      } catch { return false; }
    }
    // screen.isExtended is false when window-management is disallowed in a cross-origin frame.
    if (w.Screen && w.Screen.prototype) {
      const ied = Object.getOwnPropertyDescriptor(w.Screen.prototype, 'isExtended');
      if (ied && typeof ied.get === 'function') {
        replaceNativeAccessor(w.Screen.prototype, 'isExtended', function () {
          const v = Reflect.apply(ied.get, this, []);
          return v && featureDeniedHere('window-management') ? false : v;
        });
      }
    }
    // Policy-gated APIs in a frame that is cross-origin to its embedder.
    // Underneath, every frame is the proxy origin, so the browser's own policy check lets a cross-origin frame use what only a
    // same-origin one may: each feature whose default allowlist is 'self' and that the embedder did not delegate with `allow`.
    // Natively these APIs refuse there at once, with the browser's own error, and verification widgets (Turnstile) read how
    // they answer: the built-in AI must say "unavailable" immediately, not "downloadable" after a delay.
    // The table is what Chrome 154 answered in a cross-origin frame. "Denied here" is the virtual policy above (an `allow` that
    // delegates the feature, or the document's own Permissions-Policy header, is the same question the browser asks), so a
    // call the browser would have let through still runs natively.
    const policyError = (name, message) => (name === 'TypeError'
      ? new (w.TypeError || TypeError)(message)
      : new (w.DOMException || Native.DOMException)(message, name));
    const rejects = (name, message) => () => (w.Promise || Promise).reject(policyError(name, message));
    const resolves = value => () => (w.Promise || Promise).resolve(value);
    const filePickerRefusal = member => rejects('SecurityError', `Failed to execute '${member}' on 'Window': Cross origin sub frames aren't allowed to show a file picker.`);
    const refusal = (api, member, feature) => rejects('SecurityError', `Failed to execute '${member}' on '${api}': Access to the feature "${feature}" is disallowed by permissions policy.`);
    const gatedMembers = [
      // [interface, member, feature, answer]; 'Window' members sit on the window itself, a static one on the constructor (static: true)
      ['Keyboard', 'getLayoutMap', 'keyboard-map', rejects('SecurityError', 'getLayoutMap() must be called from a top-level browsing context or allowed by the permission policy.')],
      ['Navigator', 'requestMIDIAccess', 'midi', rejects('SecurityError', `Failed to execute 'requestMIDIAccess' on 'Navigator': Midi has been disabled in this document by permissions policy.`)],
      ['Navigator', 'requestMediaKeySystemAccess', 'encrypted-media', rejects('SecurityError', `Failed to execute 'requestMediaKeySystemAccess' on 'Navigator': requestMediaKeySystemAccess is disabled by permissions policy.`)],
      ['MediaDevices', 'getDisplayMedia', 'display-capture', rejects('NotAllowedError', `Failed to execute 'getDisplayMedia' on 'MediaDevices': Access to the feature "display-capture" is disallowed by permissions policy.`)],
      ['USB', 'getDevices', 'usb', refusal('USB', 'getDevices', 'usb')],
      ['HID', 'getDevices', 'hid', refusal('HID', 'getDevices', 'hid')],
      ['Serial', 'getPorts', 'serial', refusal('Serial', 'getPorts', 'serial')],
      ['Bluetooth', 'getAvailability', 'bluetooth', resolves(false)],
      ['WakeLock', 'request', 'screen-wake-lock', rejects('NotAllowedError', `Failed to execute 'request' on 'WakeLock': Access to Screen Wake Lock features is disallowed by permissions policy`)],
      ['Window', 'getScreenDetails', 'window-management', rejects('NotAllowedError', 'Permission denied.')],
      ['Window', 'queryLocalFonts', 'local-fonts', rejects('SecurityError', `Failed to execute 'queryLocalFonts' on 'Window': Access to the feature "local-fonts" is disallowed by Permissions Policy`)],
      // not policy: the browser refuses these in any frame cross-origin to the top (feature null)
      ['Navigator', 'share', null, rejects('NotAllowedError', `Failed to execute 'share' on 'Navigator': Permission denied`)],
      ['Navigator', 'canShare', null, () => false],
      ['Window', 'showOpenFilePicker', null, filePickerRefusal('showOpenFilePicker')],
      ['Window', 'showSaveFilePicker', null, filePickerRefusal('showSaveFilePicker')],
      ['Window', 'showDirectoryPicker', null, filePickerRefusal('showDirectoryPicker')],
      ['XRSystem', 'isSessionSupported', 'xr-spatial-tracking', refusal('XRSystem', 'isSessionSupported', 'xr')],
      ['PressureObserver', 'observe', 'compute-pressure', rejects('NotAllowedError', `Failed to execute 'observe' on 'PressureObserver': Access to the feature "compute pressure" is disallowed by permissions policy.`)],
      ['Element', 'requestFullscreen', 'fullscreen', rejects('TypeError', 'Disallowed by permissions policy')],
    ];
    // the built-in AI: `availability()` is "unavailable" at once and `create()` is refused
    for (const [apiName, feature] of [['Translator', 'translator'], ['LanguageDetector', 'language-detector'], ['Summarizer', 'summarizer'],
      ['LanguageModel', 'language-model'], ['Writer', 'writer'], ['Rewriter', 'rewriter'], ['Proofreader', 'proofreader']]) {
      gatedMembers.push([apiName, 'availability', feature, resolves('unavailable'), true]);
      gatedMembers.push([apiName, 'create', feature, rejects('NotAllowedError', 'Access denied because the Permission Policy is not enabled.'), true]);
    }
    // A site frame is cross-origin to its embedder for the browser too, which refuses these calls itself, with its own sentences.
    const browserDecidesPolicy = !!siteFrameBoot;
    for (const [apiName, member, feature, answer, isStatic] of gatedMembers) {
      if (browserDecidesPolicy) break;
      let holder;
      try { holder = apiName === 'Window' ? w : (isStatic ? w[apiName] : w[apiName] && w[apiName].prototype); } catch { holder = null; }
      if (!holder || (apiName !== 'Window' && typeof w[apiName] !== 'function')) continue;
      replaceNativeMethod(holder, member, orig => ({ [member](...args) {
        if (feature === null ? crossOriginFrame : featureDeniedHere(feature)) return answer();
        return Reflect.apply(orig, this, args);
      } })[member]);
    }
    // Constructors that refuse the same way (a sensor, a payment request): a Proxy of the native, which keeps its prototype and
    // statics; the prototype's `constructor` names the Proxy, so `new Gyroscope().constructor === Gyroscope` holds.
    const gatedConstructors = [
      ['Accelerometer', ['accelerometer']], ['LinearAccelerationSensor', ['accelerometer']], ['GravitySensor', ['accelerometer']],
      ['Gyroscope', ['gyroscope']], ['Magnetometer', ['magnetometer']], ['AmbientLightSensor', ['ambient-light-sensor']],
      ['AbsoluteOrientationSensor', ['accelerometer', 'gyroscope', 'magnetometer']], ['RelativeOrientationSensor', ['accelerometer', 'gyroscope']],
    ];
    for (const [ctorName, features] of gatedConstructors) {
      if (browserDecidesPolicy) break;
      const Orig = w[ctorName];
      if (typeof Orig !== 'function') continue;
      const wrapped = new Proxy(Orig, {
        construct(target, args, newTarget) {
          if (features.some(featureDeniedHere)) throw policyError('SecurityError', `Failed to construct '${ctorName}': Access to sensor features is disallowed by permissions policy`);
          return Reflect.construct(target, args, newTarget === wrapped ? target : newTarget);
        },
      });
      try { maskNativeFunction(wrapped, ctorName); } catch {}
      try { Object.defineProperty(Orig.prototype, 'constructor', { value: wrapped, writable: true, configurable: true }); } catch {}
      define(w, ctorName, wrapped);
    }
    if (typeof w.PaymentRequest === 'function' && !browserDecidesPolicy) {
      const Orig = w.PaymentRequest;
      const wrapped = new Proxy(Orig, {
        construct(target, args, newTarget) {
          if (featureDeniedHere('payment')) throw policyError('SecurityError', `Failed to construct 'PaymentRequest': Must be in a top-level browsing context or an iframe needs to specify allow="payment" explicitly`);
          return Reflect.construct(target, args, newTarget === wrapped ? target : newTarget);
        },
      });
      try { maskNativeFunction(wrapped, 'PaymentRequest'); } catch {}
      try { Object.defineProperty(Orig.prototype, 'constructor', { value: wrapped, writable: true, configurable: true }); } catch {}
      define(w, 'PaymentRequest', wrapped);
    }
    // a camera or a microphone is refused before any prompt
    if (w.MediaDevices && w.MediaDevices.prototype && !browserDecidesPolicy) {
      replaceNativeMethod(w.MediaDevices.prototype, 'getUserMedia', orig => ({ getUserMedia(...args) {
        let audio = false, video = false;
        try { const c = args[0]; audio = !!(c && c.audio); video = !!(c && c.video); } catch {}
        if ((audio && featureDeniedHere('microphone')) || (video && featureDeniedHere('camera'))) return rejects('NotAllowedError', 'Permission denied')();
        return Reflect.apply(orig, this, args);
      } }).getUserMedia);
    }
    // `document.fullscreenEnabled` is false where 'fullscreen' is not allowed
    for (const key of browserDecidesPolicy ? [] : ['fullscreenEnabled', 'webkitFullscreenEnabled']) {
      const fd = w.Document && Object.getOwnPropertyDescriptor(w.Document.prototype, key);
      if (fd && typeof fd.get === 'function') {
        replaceNativeAccessor(w.Document.prototype, key, function () {
          const v = Reflect.apply(fd.get, this, []);
          return v && featureDeniedHere('fullscreen') ? false : v;
        });
      }
    }
    // A WebGL context made in a cross-origin frame is on the low-power GPU whatever it asked for: natively the attribute reads
    // "low-power" for a request of "default", "high-performance" and "low-power" alike, on WebGL and WebGL2, canvas and
    // OffscreenCanvas, while the top frame honours the request. Turnstile's widget reads the attribute.
    if (crossOriginFrame) {
      for (const Ctor of [w.HTMLCanvasElement, w.OffscreenCanvas]) {
        replaceNativeMethod(Ctor && Ctor.prototype, 'getContext', orig => ({ getContext(...args) {
          try {
            if (/^(experimental-)?webgl2?$/.test(String(args[0]))) {
              const given = args[1];
              if (given === undefined || given === null || typeof given === 'object' || typeof given === 'function') {
                args = [args[0], Object.create(given || null, { powerPreference: { value: 'low-power', enumerable: true } }), ...args.slice(2)];
              }
            }
          } catch {}
          return Reflect.apply(orig, this, args);
        } }).getContext);
      }
    }
    // Scope Notification.permission per target origin while keeping the native consent prompt.
    if (w.Notification) {
      const NativeN = w.Notification;
      try {
        const permKey = '__zp_notif_perm';
        // Capture the native getter before redefining Notification.permission to avoid self-recursion.
        const nativePermDesc = Object.getOwnPropertyDescriptor(NativeN, 'permission');
        const nativePerm = nativePermDesc && nativePermDesc.get
          ? nativePermDesc.get.bind(NativeN)
          : () => (nativePermDesc ? nativePermDesc.value : 'default');
        defineMasked(NativeN, 'permission', {
          get() {
            // Notification permission is denied in opaque documents and cross-origin frames.
            if (opaqueDocument || crossOriginFrame) return 'denied';
            try {
              const stored = prefixedStorage(nativeLocalStorage, localPrefix).getItem(permKey);
              if (stored) return stored;
            } catch {}
            try { return nativePerm(); } catch { return 'default'; }
          },
          configurable: true,
        });
        const nativeRP = NativeN.requestPermission ? NativeN.requestPermission.bind(NativeN) : null;
        if (nativeRP) {
          define(NativeN, 'requestPermission', function(callback) {
            // Cross-origin frames are denied immediately without prompting on the proxy origin's behalf.
            if (opaqueDocument || crossOriginFrame) {
              if (typeof callback === 'function') try { callback('denied'); } catch {}
              return Promise.resolve('denied');
            }
            return Promise.resolve(nativeRP()).then(result => {
              try { prefixedStorage(nativeLocalStorage, localPrefix).setItem(permKey, String(result)); } catch {}
              if (typeof callback === 'function') try { callback(result); } catch {}
              return result;
            });
          });
        }
      } catch {}
    }
    // Track per-target device permission grants so one target's grant does not leak to another.
    const grantedPerms = newSet();
    try {
      const storedGrants = prefixedStorage(nativeLocalStorage, localPrefix).getItem('__zp_grants');
      if (storedGrants) for (const g of String(storedGrants).split(',')) if (g) grantedPerms.add(g);
    } catch {}
    const recordGrant = name => {
      grantedPerms.add(name);
      try { prefixedStorage(nativeLocalStorage, localPrefix).setItem('__zp_grants', Array.from(grantedPerms).join(',')); } catch {}
    };
    try {
      const md = w.navigator && w.navigator.mediaDevices;
      if (md && typeof md.getUserMedia === 'function') {
        const nativeGUM = md.getUserMedia.bind(md);
        const wrappedGUM = function getUserMedia(c) {
          return nativeGUM(c).then(s => {
            try { const kind = (s && s.getVideoTracks && s.getVideoTracks().length) ? 'camera' : 'microphone'; recordGrant(kind); if (s && s.getAudioTracks && s.getAudioTracks().length) recordGrant('microphone'); } catch {}
            return s;
          });
        };
        maskNativeFunction(wrappedGUM, 'getUserMedia');
        define(md, 'getUserMedia', wrappedGUM);
      }
      if (md && typeof md.getDisplayMedia === 'function') {
        const nativeGDM = md.getDisplayMedia.bind(md);
        const wrappedGDM = function getDisplayMedia(c) { return nativeGDM(c).then(s => { recordGrant('display-capture'); return s; }); };
        maskNativeFunction(wrappedGDM, 'getDisplayMedia');
        define(md, 'getDisplayMedia', wrappedGDM);
      }
      const geo = w.navigator && w.navigator.geolocation;
      if (geo && typeof geo.getCurrentPosition === 'function') {
        const nativeGeo = geo.getCurrentPosition.bind(geo);
        const wrappedGeo = function getCurrentPosition(ok, err, opts) { return nativeGeo(p => { recordGrant('geolocation'); if (ok) return ok(p); }, err, opts); };
        maskNativeFunction(wrappedGeo, 'getCurrentPosition');
        define(geo, 'getCurrentPosition', wrappedGeo);
      }
      if (geo && typeof geo.watchPosition === 'function') {
        const nativeWatch = geo.watchPosition.bind(geo);
        const wrappedWatch = function watchPosition(ok, err, opts) { return nativeWatch(p => { recordGrant('geolocation'); if (ok) return ok(p); }, err, opts); };
        maskNativeFunction(wrappedWatch, 'watchPosition');
        define(geo, 'watchPosition', wrappedWatch);
      }
    } catch {}
    // Return the native PermissionStatus instance while overriding its state getter with the virtual origin's permission state.
    const permProto = w.Permissions && w.Permissions.prototype;
    const statusProto = w.PermissionStatus && w.PermissionStatus.prototype;
    if (permProto && typeof permProto.query === 'function' && statusProto) {
      const trackedPerms = newSet(['camera', 'microphone', 'display-capture', 'geolocation', 'speaker-selection']);
      const stateOverride = newWeakMap();
      const stateDesc = Object.getOwnPropertyDescriptor(statusProto, 'state');
      if (stateDesc && typeof stateDesc.get === 'function') {
        const nativeState = stateDesc.get;
        replaceNativeAccessor(statusProto, 'state', function () {
          return stateOverride.has(this) ? stateOverride.get(this) : Reflect.apply(nativeState, this, []);
        });
      }
      const virtualState = name => {
        if (typeof name !== 'string') return null;
        if (opaqueDocument) return 'denied';
        if (crossOriginFrame && (name === 'notifications' || name === 'push')) return 'denied';
        if (name !== 'accelerometer' && name !== 'gyroscope' && name !== 'magnetometer' && featureDeniedHere(name)) return 'denied';
        if (trackedPerms.has(name) && !grantedPerms.has(name)) return 'prompt';
        return null;
      };
      replaceNativeMethod(permProto, 'query', orig => ({ query(...args) {
        const answer = Reflect.apply(orig, this, args);
        let name;
        try { name = args[0] && args[0].name; } catch {}
        const v = virtualState(name);
        if (v === null) return answer;
        return answer.then(status => { try { stateOverride.set(status, v); } catch {} return status; });
      } }).query);
    }
    // Fail closed on Privacy Sandbox APIs keyed to the physical proxy origin.
    try {
      const nav = w.navigator;
      const navProto = w.Navigator && w.Navigator.prototype;
      for (const pa of ['joinAdInterestGroup','leaveAdInterestGroup','runAdAuction','updateAdInterestGroups','createAuctionNonce','getInterestGroupAdAuctionData','clearOriginJoinedAdInterestGroups']) {
        if (nav && typeof nav[pa] === 'function') {
          // Define stubs on Navigator.prototype so navigator owns no extra property names.
          if (navProto && Object.getOwnPropertyDescriptor(navProto, pa)) {
            replaceNativeMethod(navProto, pa, () => ({ [pa]() { return Promise.reject(normalizedError('NotSupportedError')); } })[pa]);
          } else {
            const deny = function() { return Promise.reject(normalizedError('NotSupportedError')); };
            maskNativeFunction(deny, pa);
            define(nav, pa, deny);
          }
        }
      }
      if (w.sharedStorage !== undefined) try { define(w, 'sharedStorage', undefined); } catch {}
      if (nav && nav.privateAttribution) {
        for (const pa of ['measureImpression','saveImpression','measureConversion','saveConversion']) {
          if (typeof nav.privateAttribution[pa] === 'function') {
            const deny = function() { return Promise.reject(normalizedError('NotSupportedError')); };
            maskNativeFunction(deny, pa);
            try { define(nav.privateAttribution, pa, deny); } catch {}
          }
        }
      }
      // Return an empty topics list from document.browsingTopics.
      const docProto2 = w.Document && w.Document.prototype;
      if (docProto2 && typeof docProto2.browsingTopics === 'function') {
        const noTopics = function browsingTopics() { return Promise.resolve([]); };
        maskNativeFunction(noTopics, 'browsingTopics');
        define(docProto2, 'browsingTopics', noTopics);
      }
      // Stub document.privateToken with inert values.
      try {
        if (docProto2) {
          const dTok = Object.getOwnPropertyDescriptor(docProto2, 'privateToken');
          if (dTok) defineMasked(docProto2, 'privateToken', { get() { return { hasPrivateToken: () => Promise.resolve(false), hasRedemptionRecord: () => Promise.resolve(false), sendPrivateToken: () => Promise.reject(normalizedError('NotSupportedError')) }; }, configurable: true });
        }
      } catch {}
    } catch {}
    // Leave customElements on the native per-Window registry.
  }
  function prefixedStorage(native, prefix) {
    // Scope localStorage and sessionStorage keys to the target origin prefix.
    if (!native) return null;
    // Hide internal __zp_ keys from enumeration and direct reads.
    const hidden = (name) => String(name).startsWith('__zp_');
    const facade = {
      get length() {
        let n = 0;
        for (let i = 0; i < native.length; i++) {
          const k = native.key(i);
          if (k && k.startsWith(prefix) && !hidden(k.slice(prefix.length))) n++;
        }
        return n;
      },
      key(i) {
        i = Number(i);
        let seen = 0;
        for (let j = 0; j < native.length; j++) {
          const k = native.key(j);
          if (k && k.startsWith(prefix) && !hidden(k.slice(prefix.length))) {
            if (seen === i) return k.slice(prefix.length);
            seen++;
          }
        }
        return null;
      },
      getItem(k) { return hidden(k) ? null : native.getItem(prefix + String(k)); },
      setItem(k, v) { native.setItem(prefix + String(k), String(v)); },
      removeItem(k) { native.removeItem(prefix + String(k)); },
      clear() {
        const toDelete = [];
        for (let i = 0; i < native.length; i++) {
          const k = native.key(i);
          if (k && k.startsWith(prefix)) toDelete.push(k);
        }
        for (const k of toDelete) native.removeItem(k);
      },
    };
    // Keep Storage methods non-enumerable on a prototype and delegate named property access through a Proxy.
    const RESERVED = newSet(['length', 'key', 'getItem', 'setItem', 'removeItem', 'clear']);
    const storageProto = Object.create(
      (typeof Storage === 'function' && Storage.prototype) ? Storage.prototype : Object.prototype
    );
    defineMasked(storageProto, 'length', {
      get() { return facade.length; }, enumerable: false, configurable: true,
    });
    for (const name of ['key', 'getItem', 'setItem', 'removeItem', 'clear']) {
      const fn = function() { return facade[name].apply(facade, arguments); };
      maskNativeFunction(fn, name);
      Object.defineProperty(storageProto, name, { value: fn, enumerable: false, writable: true, configurable: true });
    }
    const storedKeys = () => {
      const out = [];
      for (let i = 0; i < native.length; i++) {
        const k = native.key(i);
        if (k && k.startsWith(prefix) && !hidden(k.slice(prefix.length))) out.push(k.slice(prefix.length));
      }
      return out;
    };
    const namedStorage = new Proxy(Object.create(storageProto), {
      get(t, p, r) {
        if (typeof p === 'symbol' || RESERVED.has(p)) return Reflect.get(t, p, r);
        const v = facade.getItem(p);
        return v === null ? undefined : v;
      },
      set(t, p, v) {
        if (typeof p === 'symbol' || RESERVED.has(p)) return Reflect.set(t, p, v, t);
        facade.setItem(p, v);
        return true;
      },
      has(t, p) {
        if (typeof p === 'symbol' || RESERVED.has(p)) return Reflect.has(t, p);
        return facade.getItem(p) !== null;
      },
      deleteProperty(t, p) {
        if (typeof p === 'symbol' || RESERVED.has(p)) return Reflect.deleteProperty(t, p);
        facade.removeItem(p);
        return true;
      },
      ownKeys() { return storedKeys(); },
      getOwnPropertyDescriptor(t, p) {
        if (typeof p === 'symbol' || RESERVED.has(p)) return Reflect.getOwnPropertyDescriptor(t, p);
        const v = facade.getItem(p);
        return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
      },
      defineProperty(t, p, desc) {
        if (typeof p === 'symbol' || RESERVED.has(p)) return Reflect.defineProperty(t, p, desc);
        if ('value' in desc) facade.setItem(p, desc.value);
        return true;
      },
    });
    // Set Storage.prototype before freezing so instanceof Storage and Object.prototype.toString match native.
    try {
      if (typeof Storage === 'function' && Storage.prototype) Object.setPrototypeOf(facade, Storage.prototype);
    } catch {}
    Object.freeze(facade);
    return namedStorage;
  }
