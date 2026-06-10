const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const storageModuleURL = pathToFileURL(path.resolve('web/runtime/webapi/storage.mjs')).href;

async function storageModule() {
  return import(storageModuleURL);
}

test('virtual storage manager partitions local and session storage by origin tab context and relay', async () => {
  const { MemoryStorageAdapter, VirtualStorageManager } = await storageModule();
  const manager = new VirtualStorageManager({ adapter: new MemoryStorageAdapter() });
  const first = manager.partitionFor('https://target.example/app', {
    tabId: 'tab-a',
    contextId: 'top',
    relayKey: 'relay-a',
  });
  const otherTab = manager.partitionFor('https://target.example/app', {
    tabId: 'tab-b',
    contextId: 'top',
    relayKey: 'relay-a',
  });
  const otherOrigin = manager.partitionFor('https://other.example/app', {
    tabId: 'tab-a',
    contextId: 'top',
    relayKey: 'relay-a',
  });

  manager.setItem(first, 'localStorage', 'k', 'v');
  manager.setItem(first, 'sessionStorage', 's', 't');
  await manager.flush();

  assert.deepEqual(await manager.loadSnapshot(first), {
    localStorage: [['k', 'v']],
    sessionStorage: [['s', 't']],
    indexedDB: [],
    cacheAPI: [],
    httpCache: [],
  });
  assert.deepEqual(await manager.loadSnapshot(otherTab), {
    localStorage: [],
    sessionStorage: [],
    indexedDB: [],
    cacheAPI: [],
    httpCache: [],
  });
  assert.deepEqual(await manager.loadSnapshot(otherOrigin), {
    localStorage: [],
    sessionStorage: [],
    indexedDB: [],
    cacheAPI: [],
    httpCache: [],
  });

  manager.removeItem(first, 'localStorage', 'k');
  manager.clear(first, 'sessionStorage');
  await manager.flush();
  assert.deepEqual(await manager.loadSnapshot(first), {
    localStorage: [],
    sessionStorage: [],
    indexedDB: [],
    cacheAPI: [],
    httpCache: [],
  });
});

test('storage schema names the IndexedDB durable stores required by the plan', async () => {
  const { storageSchema } = await storageModule();
  const schema = storageSchema();
  assert.equal(schema.databaseName, 'zeroproxy-virtual-browser');
  for (const store of [
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
  ]) {
    assert.ok(schema.stores.includes(store), store);
  }
});

test('storage manager persists IndexedDB snapshots cache bodies quota and storage events', async () => {
  const { MemoryStorageAdapter, VirtualStorageManager, applyStorageSchema } = await storageModule();
  const manager = new VirtualStorageManager({
    adapter: new MemoryStorageAdapter(),
    maxBytesPerPartition: 64 * 1024,
    bodyChunkBytes: 4,
  });
  const partition = manager.partitionFor('https://target.example/app', { tabId: 'tab-a' });
  const seen = [];
  manager.addStorageListener(partition, (event) => seen.push(event), { contextId: 'other' });

  await manager.setItem(partition, 'localStorage', 'k', 'v', { sourceContextId: 'source' });
  await manager.putIndexedDBDatabase(partition, 'app-db', {
    version: 1,
    stores: {
      items: { keyPath: 'id', autoIncrement: false, nextKey: 1, records: { a: { id: 'a' } } },
    },
  });
  await manager.putCacheAPIEntry(
    partition,
    'v1',
    {
      url: 'https://target.example/app/data.json',
      method: 'GET',
      headers: [],
      credentials: 'same-origin',
    },
    {
      status: 200,
      statusText: 'OK',
      headers: [['Cache-Control', 'max-age=60']],
      body: 'chunked-body',
    },
  );

  const cacheMatch = await manager.matchCacheAPIEntry(partition, 'v1', {
    url: 'https://target.example/app/data.json',
    method: 'GET',
    headers: [],
    credentials: 'same-origin',
  });
  assert.equal(cacheMatch.response.body, 'chunked-body');
  assert.ok((await manager.estimateUsage(partition)).bytes > 0);
  assert.equal(
    (await manager.explainDecision(partition, cacheMatch.request, cacheMatch.response)).cacheable,
    true,
  );
  assert.deepEqual(seen.at(-1), {
    partitionKey: partition,
    area: 'localStorage',
    key: 'k',
    newValue: 'v',
  });

  const snapshot = await manager.loadSnapshot(partition);
  assert.equal(Object.fromEntries(snapshot.indexedDB)['app-db'].stores.items.records.a.id, 'a');
  assert.equal(snapshot.cacheAPI[0].response.body, 'chunked-body');

  const createdStores = [];
  applyStorageSchema({
    objectStoreNames: { contains: (name) => name === 'origins' },
    createObjectStore(name) {
      createdStores.push(name);
    },
  });
  assert.ok(createdStores.includes('schemaMeta'));
});
