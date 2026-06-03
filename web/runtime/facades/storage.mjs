export function createStorageFacades({
  Native,
  define,
  defineAccessor,
  normalizedError,
  getVirtualURL,
}) {
  const storageMaps = new Map();
  const storageWindows = new Set();
  const storageDirtyKeys = new Map();
  let storageDBPromise = null;

  function installStorageFacades(w) {
    const prefix = storagePrefixForVirtualOrigin();
    const localKey = `${prefix}local`;
    const sessionKey = `${prefix}session`;
    const local = storageObject(localKey, w);
    const session = storageObject(sessionKey, w);
    storageWindows.add({ w, localKey, sessionKey });
    defineAccessor(w, 'localStorage', () => local);
    defineAccessor(w, 'sessionStorage', () => session);
    installIndexedDBFacade(w, prefix);
    installCachesFacade(w, prefix);
  }

  function installIndexedDBFacade(w, prefix) {
    if (!w.indexedDB) return;
    const nativeIDB = w.indexedDB;
    const idbPrefix = `${prefix}idb:`;
    define(w, 'indexedDB', {
      open(name, version) { return nativeIDB.open(idbPrefix + String(name), version); },
      deleteDatabase(name) { return nativeIDB.deleteDatabase(idbPrefix + String(name)); },
      cmp: nativeIDB.cmp ? nativeIDB.cmp.bind(nativeIDB) : undefined,
      databases: nativeIDB.databases
        ? () => nativeIDB.databases().then(list => list
          .filter(db => db.name && db.name.startsWith(idbPrefix))
          .map(db => Object.assign({}, db, { name: db.name.slice(idbPrefix.length) })))
        : undefined
    });
  }

  function installCachesFacade(w, prefix) {
    if (!w.caches) return;
    const nativeCaches = w.caches;
    const cachePrefix = `${prefix}cache:`;
    define(w, 'caches', {
      open(name) { return nativeCaches.open(cachePrefix + String(name)); },
      delete(name) { return nativeCaches.delete(cachePrefix + String(name)); },
      has(name) { return nativeCaches.has(cachePrefix + String(name)); },
      keys() { return nativeCaches.keys().then(keys => keys.filter(k => k.startsWith(cachePrefix)).map(k => k.slice(cachePrefix.length))); },
      match(request, opts) { return matchVirtualCache(nativeCaches, cachePrefix, request, opts); }
    });
  }

  function matchVirtualCache(nativeCaches, cachePrefix, request, opts) {
    return nativeCaches.keys()
      .then(keys => keys.filter(k => k.startsWith(cachePrefix)))
      .then(async keys => {
        for (const k of keys) {
          const hit = await (await nativeCaches.open(k)).match(request, opts);
          if (hit) return hit;
        }
        return undefined;
      });
  }

  function storagePrefixForVirtualOrigin() {
    return `zp:${getVirtualURL().origin}:`;
  }

  function storageMap(key) {
    let map = storageMaps.get(key);
    if (!map) {
      map = new Map();
      storageMaps.set(key, map);
      loadStorageMirror(key, map);
      loadPersistentStorage(key, map).then(() => saveStorageMirror(key, map)).catch(()=>{});
    }
    return map;
  }

  function storageObject(namespaceKey, ownerWindow) {
    const map = storageMap(namespaceKey);
    return Object.freeze({
      get length() { return map.size; },
      key(i) { return Array.from(map.keys())[Number(i)] || null; },
      getItem(k) { k = String(k); return map.has(k) ? map.get(k) : null; },
      setItem(k, v) {
        k = String(k);
        v = String(v);
        const oldValue = map.has(k) ? map.get(k) : null;
        map.set(k, v);
        markStorageDirty(namespaceKey, k);
        saveStorageMirror(namespaceKey, map);
        persistStorageValue(namespaceKey, k, v).catch(()=>{});
        dispatchStorageEvents(namespaceKey, ownerWindow, k, oldValue, v);
      },
      removeItem(k) {
        k = String(k);
        const oldValue = map.has(k) ? map.get(k) : null;
        map.delete(k);
        markStorageDirty(namespaceKey, k);
        saveStorageMirror(namespaceKey, map);
        deletePersistentStorageValue(namespaceKey, k).catch(()=>{});
        dispatchStorageEvents(namespaceKey, ownerWindow, k, oldValue, null);
      },
      clear() {
        if (!map.size) return;
        map.clear();
        markStorageDirty(namespaceKey, '*');
        saveStorageMirror(namespaceKey, map);
        clearPersistentStorage(namespaceKey).catch(()=>{});
        dispatchStorageEvents(namespaceKey, ownerWindow, null, null, null);
      }
    });
  }

  function storageMirrorKey(namespace) {
    return `zp:idb-mirror:${namespace}`;
  }

  function loadStorageMirror(namespace, map) {
    const store = Native.localStorage;
    if (!store) return;
    try {
      const raw = store.getItem(storageMirrorKey(namespace));
      const items = raw && JSON.parse(raw);
      if (!Array.isArray(items)) return;
      for (const pair of items) {
        if (Array.isArray(pair) && typeof pair[0] === 'string') map.set(pair[0], String(pair[1]));
      }
    } catch {}
  }

  function saveStorageMirror(namespace, map) {
    const store = Native.localStorage;
    if (!store) return;
    try {
      store.setItem(storageMirrorKey(namespace), JSON.stringify(Array.from(map.entries())));
    } catch {}
  }

  function markStorageDirty(namespace, key) {
    let keys = storageDirtyKeys.get(namespace);
    if (!keys) {
      keys = new Set();
      storageDirtyKeys.set(namespace, keys);
    }
    keys.add(String(key));
  }

  function isStorageDirty(namespace, key) {
    const keys = storageDirtyKeys.get(namespace);
    return !!keys && (keys.has('*') || keys.has(String(key)));
  }

  function storageDB() {
    if (!Native.indexedDB) return Promise.reject(normalizedError('NotSupportedError'));
    if (storageDBPromise) return storageDBPromise;
    storageDBPromise = new Promise((resolve, reject) => {
      const req = Native.indexedDB.open('zeroproxy-storage-v1', 1);
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore('kv', { keyPath: ['namespace', 'key'] }); } catch {}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || normalizedError('UnknownError'));
    });
    return storageDBPromise;
  }

  async function loadPersistentStorage(namespace, map) {
    const db = await storageDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const store = tx.objectStore('kv');
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const rec = cursor.value;
        if (rec && rec.namespace === namespace && typeof rec.key === 'string' && !isStorageDirty(namespace, rec.key)) {
          map.set(rec.key, String(rec.value));
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || normalizedError('UnknownError'));
    });
  }

  async function persistStorageValue(namespace, key, value) {
    const db = await storageDB();
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put({ namespace, key, value });
  }

  async function deletePersistentStorageValue(namespace, key) {
    const db = await storageDB();
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete([namespace, key]);
  }

  async function clearPersistentStorage(namespace) {
    const db = await storageDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        if (cursor.value && cursor.value.namespace === namespace) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || normalizedError('UnknownError'));
    });
  }

  function dispatchStorageEvents(namespaceKey, sourceWindow, key, oldValue, newValue) {
    for (const rec of Array.from(storageWindows)) {
      const w = rec.w;
      if (!w || w === sourceWindow || (rec.localKey !== namespaceKey && rec.sessionKey !== namespaceKey)) continue;
      try {
        const ev = new w.StorageEvent('storage', { key, oldValue, newValue, url: getVirtualURL().href });
        w.dispatchEvent(ev);
      } catch {
        try { w.dispatchEvent(new w.Event('storage')); } catch {}
      }
    }
  }

  return Object.freeze({ installStorageFacades });
}
