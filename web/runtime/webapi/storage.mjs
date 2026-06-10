const DEFAULT_DB_NAME = 'zeroproxy-virtual-browser';
const DB_VERSION = 1;
const STORE_NAMES = Object.freeze([
  'origins',
  'tabs',
  'cookies',
  'localStorage',
  'sessionStorage',
  'indexedDBCatalog',
  'indexedDBObjectData',
  'httpCacheEntries',
  'httpCacheBodies',
  'cacheApiMetadata',
  'cacheApiBodies',
  'blobRegistry',
  'quotaUsage',
  'schemaMeta',
]);
const STORAGE_AREAS = Object.freeze(['localStorage', 'sessionStorage']);
const DEFAULT_QUOTA_BYTES = 10 * 1024 * 1024;
const DEFAULT_BODY_CHUNK_BYTES = 64 * 1024;

export class VirtualStorageManager {
  constructor(options = {}) {
    this.adapter = options.adapter || new IndexedDBStorageAdapter(options);
    this.maxBytesPerPartition = Number(options.maxBytesPerPartition || DEFAULT_QUOTA_BYTES);
    this.bodyChunkBytes = Number(options.bodyChunkBytes || DEFAULT_BODY_CHUNK_BYTES);
    this.pending = new Set();
    this.listeners = new Map();
  }

  partitionFor(url, options = {}) {
    const origin = virtualOrigin(url);
    const tabId = String(options.tabId || 'shell');
    const contextId = String(options.contextId || 'top');
    const relayKey = String(options.relayKey || 'default');
    return `${origin}|tab=${tabId}|ctx=${contextId}|relay=${relayKey}`;
  }

  async loadSnapshot(partitionKey) {
    const [localStorage, sessionStorage, indexedDB, cacheAPI, httpCache] = await Promise.all([
      this.adapter.loadArea(partitionKey, 'localStorage'),
      this.adapter.loadArea(partitionKey, 'sessionStorage'),
      this.loadIndexedDBSnapshot(partitionKey),
      this.loadCacheAPISnapshot(partitionKey),
      this.loadHTTPCacheSnapshot(partitionKey),
    ]);
    return { localStorage, sessionStorage, indexedDB, cacheAPI, httpCache };
  }

  setItem(partitionKey, area, key, value, options = {}) {
    if (!validArea(area)) return Promise.resolve(false);
    const task = this.withQuota(partitionKey, this.adapter.setItem(partitionKey, area, String(key), String(value)));
    this.track(task.then(() => this.dispatchStorageEvent(partitionKey, area, key, value, options.sourceContextId)));
    return task;
  }

  removeItem(partitionKey, area, key, options = {}) {
    if (!validArea(area)) return Promise.resolve(false);
    const task = this.adapter.removeItem(partitionKey, area, String(key));
    this.track(task.then(() => this.dispatchStorageEvent(partitionKey, area, key, null, options.sourceContextId)));
    return task;
  }

  clear(partitionKey, area, options = {}) {
    if (!validArea(area)) return Promise.resolve(false);
    const task = this.adapter.clearArea(partitionKey, area);
    this.track(task.then(() => this.dispatchStorageEvent(partitionKey, area, null, null, options.sourceContextId)));
    return task;
  }

  addStorageListener(partitionKey, listener, options = {}) {
    const bucket = this.listeners.get(partitionKey) || new Set();
    const entry = { listener, contextId: String(options.contextId || '') };
    bucket.add(entry);
    this.listeners.set(partitionKey, bucket);
    return () => bucket.delete(entry);
  }

  async putIndexedDBDatabase(partitionKey, name, snapshot) {
    const databaseName = String(name || '');
    const record = {
      id: recordKey(partitionKey, databaseName),
      partitionKey,
      name: databaseName,
      snapshot: cloneJSON(snapshot || {}),
      updatedAt: Date.now(),
    };
    await this.withQuota(partitionKey, this.adapter.putRecord('indexedDBCatalog', record));
  }

  async deleteIndexedDBDatabase(partitionKey, name) {
    await this.adapter.deleteRecord('indexedDBCatalog', recordKey(partitionKey, String(name || '')));
  }

  async loadIndexedDBSnapshot(partitionKey) {
    const rows = await this.adapter.allByPartition('indexedDBCatalog', partitionKey);
    return rows.map((row) => [row.name, row.snapshot || {}]);
  }

  async putCacheAPIEntry(partitionKey, cacheName, requestRecord, responseRecord) {
    const cache = String(cacheName || 'default');
    const request = normalizeRequestRecord(requestRecord);
    const response = normalizeResponseRecord(responseRecord);
    const entryId = recordKey(partitionKey, `${cache}\u0000${request.key}`);
    const chunks = chunkString(response.body || '', this.bodyChunkBytes);
    const bodyIds = chunks.map((_, index) => `${entryId}\u0000body\u0000${index}`);
    const metadata = {
      id: entryId,
      partitionKey,
      cacheName: cache,
      request,
      response: { ...response, body: undefined, bodyIds },
      bytes: byteLength(response.body || ''),
      updatedAt: Date.now(),
    };
    await this.withQuota(partitionKey, Promise.all([
      this.adapter.putRecord('cacheApiMetadata', metadata),
      ...chunks.map((body, index) =>
        this.adapter.putRecord('cacheApiBodies', {
          id: bodyIds[index],
          partitionKey,
          entryId,
          index,
          body,
          bytes: byteLength(body),
        }),
      ),
    ]));
  }

  async matchCacheAPIEntry(partitionKey, cacheName, requestRecord) {
    const cache = String(cacheName || 'default');
    const request = normalizeRequestRecord(requestRecord);
    const row = await this.adapter.getRecord('cacheApiMetadata', recordKey(partitionKey, `${cache}\u0000${request.key}`));
    if (!row) return null;
    const bodies = await Promise.all((row.response.bodyIds || []).map((id) => this.adapter.getRecord('cacheApiBodies', id)));
    return { request: row.request, response: { ...row.response, body: bodies.map((body) => body?.body || '').join('') } };
  }

  async deleteCacheAPIEntry(partitionKey, cacheName, requestRecord) {
    const cache = String(cacheName || 'default');
    const request = normalizeRequestRecord(requestRecord);
    const id = recordKey(partitionKey, `${cache}\u0000${request.key}`);
    const row = await this.adapter.getRecord('cacheApiMetadata', id);
    if (row) await Promise.all((row.response.bodyIds || []).map((bodyId) => this.adapter.deleteRecord('cacheApiBodies', bodyId)));
    await this.adapter.deleteRecord('cacheApiMetadata', id);
  }

  async deleteCacheAPI(partitionKey, cacheName) {
    const rows = await this.adapter.allByPartition('cacheApiMetadata', partitionKey);
    await Promise.all(
      rows
        .filter((row) => row.cacheName === String(cacheName || 'default'))
        .map((row) => this.deleteCacheAPIEntry(partitionKey, row.cacheName, row.request)),
    );
  }

  async loadCacheAPISnapshot(partitionKey) {
    const rows = await this.adapter.allByPartition('cacheApiMetadata', partitionKey);
    const out = [];
    for (const row of rows) {
      const bodies = await Promise.all((row.response.bodyIds || []).map((id) => this.adapter.getRecord('cacheApiBodies', id)));
      out.push({
        cacheName: row.cacheName,
        request: row.request,
        response: { ...row.response, body: bodies.map((body) => body?.body || '').join('') },
      });
    }
    return out;
  }

  async putHTTPCacheEntry(partitionKey, entry) {
    const normalized = normalizeHTTPCacheEntry(entry);
    const entryId = recordKey(partitionKey, normalized.key);
    const body = String(normalized.payload?.text || '');
    const chunks = chunkString(body, this.bodyChunkBytes);
    const bodyIds = chunks.map((_, index) => `${entryId}\u0000body\u0000${index}`);
    const metadata = {
      ...normalized,
      id: entryId,
      partitionKey,
      payload: { ...normalized.payload, text: undefined, bodyIds },
      bytes: byteLength(body),
      updatedAt: Date.now(),
    };
    await this.withQuota(partitionKey, Promise.all([
      this.adapter.putRecord('httpCacheEntries', metadata),
      ...chunks.map((chunk, index) =>
        this.adapter.putRecord('httpCacheBodies', {
          id: bodyIds[index],
          partitionKey,
          entryId,
          index,
          body: chunk,
          bytes: byteLength(chunk),
        }),
      ),
    ]));
  }

  async loadHTTPCacheSnapshot(partitionKey) {
    const rows = await this.adapter.allByPartition('httpCacheEntries', partitionKey);
    const out = [];
    for (const row of rows) {
      const bodies = await Promise.all((row.payload.bodyIds || []).map((id) => this.adapter.getRecord('httpCacheBodies', id)));
      out.push({ ...row, payload: { ...row.payload, text: bodies.map((body) => body?.body || '').join('') } });
    }
    return out;
  }

  async estimateUsage(partitionKey) {
    const rows = await Promise.all(STORE_NAMES.map((store) => this.adapter.allByPartition(store, partitionKey).catch(() => [])));
    const bytes = rows.flat().reduce((sum, row) => sum + byteLength(JSON.stringify(row)), 0);
    await this.adapter.putRecord('quotaUsage', {
      id: recordKey(partitionKey, 'usage'),
      partitionKey,
      bytes,
      quota: this.maxBytesPerPartition,
      updatedAt: Date.now(),
    }).catch(() => {});
    return { partitionKey, bytes, quota: this.maxBytesPerPartition };
  }

  async explainDecision(partitionKey, requestRecord, responseRecord = null) {
    const usage = await this.estimateUsage(partitionKey);
    const request = normalizeRequestRecord(requestRecord);
    const response = responseRecord ? normalizeResponseRecord(responseRecord) : null;
    const noStore = /(?:^|[,\s])no-store(?:[,\s]|$)/i.test(String(response?.headers?.['cache-control'] || ''));
    return {
      partitionKey,
      requestKey: request.key,
      cacheable: Boolean(response) && !noStore && request.method === 'GET' && usage.bytes < usage.quota,
      reason: noStore ? 'response-no-store' : request.method !== 'GET' ? 'method' : usage.bytes >= usage.quota ? 'quota' : 'cacheable',
      usage,
    };
  }

  async flush() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  track(promise) {
    const task = Promise.resolve(promise).catch(() => {});
    this.pending.add(task);
    task.finally(() => this.pending.delete(task));
    return task;
  }

  async withQuota(partitionKey, promise) {
    const result = await promise;
    const usage = await this.estimateUsage(partitionKey);
    if (usage.bytes > usage.quota) throw quotaError();
    return result;
  }

  dispatchStorageEvent(partitionKey, area, key, value, sourceContextId = '') {
    const bucket = this.listeners.get(partitionKey);
    if (!bucket) return;
    const event = { partitionKey, area, key: key == null ? null : String(key), newValue: value == null ? null : String(value) };
    for (const entry of bucket) {
      if (entry.contextId && entry.contextId === String(sourceContextId || '')) continue;
      entry.listener(event);
    }
  }
}

export class MemoryStorageAdapter {
  constructor() {
    this.records = new Map(STORE_NAMES.map((store) => [store, new Map()]));
  }

  async loadArea(partitionKey, area) {
    return (await this.allByPartition(area, partitionKey)).map((row) => [row.key, row.value]);
  }

  async setItem(partitionKey, area, key, value) {
    await this.putRecord(area, { id: recordKey(partitionKey, key), partitionKey, key, value, updatedAt: Date.now() });
  }

  async removeItem(partitionKey, area, key) {
    await this.deleteRecord(area, recordKey(partitionKey, key));
  }

  async clearArea(partitionKey, area) {
    for (const row of await this.allByPartition(area, partitionKey)) await this.deleteRecord(area, row.id);
  }

  async putRecord(store, record) {
    this.store(store).set(String(record.id), cloneJSON(record));
  }

  async getRecord(store, id) {
    const record = this.store(store).get(String(id));
    return record ? cloneJSON(record) : null;
  }

  async deleteRecord(store, id) {
    return this.store(store).delete(String(id));
  }

  async allByPartition(store, partitionKey) {
    return [...this.store(store).values()].filter((row) => row.partitionKey === partitionKey).map(cloneJSON);
  }

  store(name) {
    if (!this.records.has(name)) this.records.set(name, new Map());
    return this.records.get(name);
  }
}

export class IndexedDBStorageAdapter {
  constructor(options = {}) {
    this.indexedDB = options.indexedDB || globalThis.indexedDB;
    this.databaseName = options.databaseName || DEFAULT_DB_NAME;
    this.openPromise = null;
  }

  async loadArea(partitionKey, area) {
    return (await this.allByPartition(area, partitionKey)).map((row) => [row.key, row.value]);
  }

  async setItem(partitionKey, area, key, value) {
    await this.putRecord(area, { id: recordKey(partitionKey, key), partitionKey, key, value, updatedAt: Date.now() });
  }

  async removeItem(partitionKey, area, key) {
    await this.deleteRecord(area, recordKey(partitionKey, key));
  }

  async clearArea(partitionKey, area) {
    for (const row of await this.allByPartition(area, partitionKey)) await this.deleteRecord(area, row.id);
  }

  async putRecord(store, record) {
    const db = await this.open();
    await requestDone(transactionStore(db, store, 'readwrite').put(cloneJSON(record)));
  }

  async getRecord(store, id) {
    const db = await this.open();
    return requestDone(transactionStore(db, store, 'readonly').get(String(id)));
  }

  async deleteRecord(store, id) {
    const db = await this.open();
    await requestDone(transactionStore(db, store, 'readwrite').delete(String(id)));
  }

  async allByPartition(store, partitionKey) {
    const db = await this.open();
    const rows = await requestDone(transactionStore(db, store, 'readonly').getAll());
    return (Array.isArray(rows) ? rows : []).filter((row) => row.partitionKey === partitionKey);
  }

  open() {
    if (!this.indexedDB) return Promise.reject(new Error('INDEXEDDB_UNAVAILABLE'));
    if (!this.openPromise) this.openPromise = openDatabase(this.indexedDB, this.databaseName);
    return this.openPromise;
  }
}

export function storageSchema() {
  return { databaseName: DEFAULT_DB_NAME, version: DB_VERSION, stores: [...STORE_NAMES] };
}

export function applyStorageSchema(db) {
  for (const store of STORE_NAMES) {
    if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
  }
  return [...STORE_NAMES];
}

function openDatabase(indexedDB, name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => applyStorageSchema(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('INDEXEDDB_OPEN_FAILED'));
  });
}

function transactionStore(db, store, mode) {
  if (!STORE_NAMES.includes(store)) throw new Error('INVALID_STORAGE_STORE');
  return db.transaction(store, mode).objectStore(store);
}

function requestDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('INDEXEDDB_REQUEST_FAILED'));
  });
}

function validArea(area) {
  return STORAGE_AREAS.includes(area);
}

function recordKey(partitionKey, key) {
  return `${partitionKey}\u0000${key}`;
}

function virtualOrigin(url) {
  try {
    return new URL(String(url || 'about:blank')).origin;
  } catch {
    return 'null';
  }
}

function normalizeRequestRecord(record) {
  const url = String(record?.url || record || '');
  const method = String(record?.method || 'GET').toUpperCase();
  const headers = Array.isArray(record?.headers) ? record.headers : [];
  const credentials = String(record?.credentials || 'same-origin');
  return { key: `${method} ${url} ${credentials}`, url, method, headers, credentials };
}

function normalizeResponseRecord(record) {
  const headerList = Array.isArray(record?.headers) ? record.headers : [];
  const headers = Object.fromEntries(headerList.map(([name, value]) => [String(name).toLowerCase(), String(value)]));
  return {
    status: Number(record?.status || 200),
    statusText: String(record?.statusText || ''),
    headers,
    headerList,
    url: String(record?.url || record?.finalUrl || ''),
    body: String(record?.body || ''),
  };
}

function normalizeHTTPCacheEntry(entry) {
  const method = String(entry?.method || 'GET').toUpperCase();
  const url = String(entry?.url || entry?.payload?.url || '');
  const varyValues = Array.isArray(entry?.varyValues) ? entry.varyValues : [...(entry?.varyValues || new Map())];
  const cacheControl = Array.isArray(entry?.cacheControl) ? entry.cacheControl : [...(entry?.cacheControl || new Map())];
  const vary = Array.isArray(entry?.vary) ? entry.vary.map(String) : [];
  return {
    key: `${method} ${url} ${JSON.stringify(varyValues)}`,
    method,
    url,
    payload: cloneJSON(entry?.payload || {}),
    storedAt: Number(entry?.storedAt || Date.now()),
    cacheControl,
    vary,
    varyValues,
  };
}

function chunkString(text, size) {
  const out = [];
  const value = String(text || '');
  const chunkSize = Math.max(1, Number(size || DEFAULT_BODY_CHUNK_BYTES));
  for (let index = 0; index < value.length; index += chunkSize) out.push(value.slice(index, index + chunkSize));
  if (!out.length) out.push('');
  return out;
}

function byteLength(text) {
  return new TextEncoder().encode(String(text || '')).byteLength;
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function quotaError() {
  const error = new Error('QuotaExceededError');
  error.name = 'QuotaExceededError';
  return error;
}
