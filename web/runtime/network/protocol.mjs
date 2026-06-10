/* ZeroProxy GoNetworkBackend protocol helpers. */

export const GO_NETWORK_PROTOCOL_VERSION = 1;
export const ARRAYBUFFER_CHUNKS = 'arraybuffer-chunks';
export const TRANSFERABLE_STREAMS = 'transferable-streams';
export const DEFAULT_MAX_CHUNK_SIZE = 64 * 1024;

export const GO_NETWORK_APIS = Object.freeze([
  'fetchRaw',
  'webSocket',
  'cookie',
  'timing',
  'abort',
  'sanitizeDocument',
  'sanitizeStylesheet',
]);

export const GO_NETWORK_STORAGE_APIS = Object.freeze([
  'indexedDBStore',
  'httpCache',
  'cacheAPI',
]);

export const GO_NETWORK_MESSAGE_TYPES = Object.freeze([
  'hello',
  'ready',
  'init',
  'init.ok',
  'init.error',
  'fetch.start',
  'fetch.body.chunk',
  'fetch.body.end',
  'fetch.response.start',
  'fetch.response.chunk',
  'fetch.response.end',
  'fetch.error',
  'fetch.cancel',
  'sanitize.document',
  'sanitize.document.result',
  'sanitize.stylesheet',
  'sanitize.stylesheet.result',
  'ws.open',
  'ws.accepted',
  'ws.send',
  'ws.message',
  'ws.close',
  'ws.error',
  'cookie.get',
  'cookie.get.result',
  'cookie.set',
  'cookie.set.result',
  'stream.credit',
  'stream.pause',
  'stream.resume',
  'stream.cancel',
  'health.ping',
  'health.pong',
  'cache.match',
  'cache.put',
  'cache.revalidate',
  'cache.evict',
  'cache.clearPartition',
  'cache.decision',
  'storage.get',
  'storage.set',
  'storage.delete',
  'storage.transaction',
  'shutdown',
]);

const ENVELOPE_KEYS = new Set(['v', 'type', 'id', 'tabId', 'parentId']);
const FETCH_DEFAULTS = Object.freeze({
  method: 'GET',
  referrer: '',
  referrerPolicy: '',
  mode: 'cors',
  credentials: 'same-origin',
  redirect: 'follow',
  cache: 'default',
  cacheMode: 'default',
  priority: 'auto',
  initiator: 'fetch',
});

let nextMessageSeq = 0;

export function createMessageId(prefix = 'msg') {
  nextMessageSeq += 1;
  return `${safeToken(prefix)}-${nextMessageSeq}`;
}

export function makeEnvelope(type, fields = {}) {
  if (!type) throw new TypeError('GoNetworkBackend message type is required');
  const id = fields.id == null ? createMessageId(type) : String(fields.id);
  const tabId = fields.tabId == null ? 'shell' : String(fields.tabId);
  const out = { v: GO_NETWORK_PROTOCOL_VERSION, type: String(type), id, tabId };
  if (fields.parentId != null) out.parentId = String(fields.parentId);
  copyUnknownFields(out, fields);
  return out;
}

export function assertEnvelope(message, required = []) {
  if (!message || typeof message !== 'object') throw new TypeError('message must be an object');
  if (message.v !== GO_NETWORK_PROTOCOL_VERSION) throw new TypeError('unsupported protocol version');
  for (const field of ['type', 'id', 'tabId', ...required]) {
    if (message[field] == null || message[field] === '') throw new TypeError(`missing ${field}`);
  }
  return message;
}

export function makeHello(options = {}) {
  return makeEnvelope('hello', {
    id: options.id,
    tabId: options.tabId,
    protocolVersion: GO_NETWORK_PROTOCOL_VERSION,
    supportedBinaryModes: normalizeStringList(options.supportedBinaryModes, [ARRAYBUFFER_CHUNKS]),
    maximumChunkSize: positiveInt(options.maximumChunkSize, DEFAULT_MAX_CHUNK_SIZE),
    supportedAPIs: normalizeStringList(options.supportedAPIs, GO_NETWORK_APIS),
    supportedStorageCacheAPIs: normalizeStringList(options.supportedStorageCacheAPIs, GO_NETWORK_STORAGE_APIS),
    backendKindRequested: String(options.backendKind || 'worker'),
    requiredFeatures: normalizeStringList(options.requiredFeatures),
    servers: normalizeStringList(options.servers),
  });
}

export function negotiateReady(hello, capabilities = {}) {
  assertEnvelope(hello, ['protocolVersion']);
  const supported = capabilitySet(capabilities);
  const unsupported = normalizeStringList(hello.requiredFeatures).filter((feature) => !supported.has(feature));
  const binaryModes = intersectStringLists(hello.supportedBinaryModes, capabilities.supportedBinaryModes || [ARRAYBUFFER_CHUNKS]);
  const ready = makeEnvelope('ready', {
    id: capabilities.id,
    parentId: hello.id,
    tabId: hello.tabId,
    backendKind: String(capabilities.backendKind || hello.backendKindRequested || 'worker'),
    protocolVersion: GO_NETWORK_PROTOCOL_VERSION,
    supportedBinaryModes: binaryModes.length ? binaryModes : [ARRAYBUFFER_CHUNKS],
    maximumChunkSize: Math.min(
      positiveInt(hello.maximumChunkSize, DEFAULT_MAX_CHUNK_SIZE),
      positiveInt(capabilities.maximumChunkSize, DEFAULT_MAX_CHUNK_SIZE),
    ),
    supportedAPIs: normalizeStringList(capabilities.supportedAPIs, GO_NETWORK_APIS),
    supportedStorageCacheAPIs: normalizeStringList(
      capabilities.supportedStorageCacheAPIs,
      GO_NETWORK_STORAGE_APIS,
    ),
    unsupportedRequiredFeatures: unsupported,
  });
  if (unsupported.length) ready.error = unsupportedFeatureError(unsupported);
  return ready;
}

export function unsupportedFeatureError(features) {
  const list = normalizeStringList(features);
  return {
    code: 'unsupported_feature',
    features: list,
    debug: `Unsupported required feature${list.length === 1 ? '' : 's'}: ${list.join(', ')}`,
  };
}

export function normalizeHeaders(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) return headersFromPairs(headers);
  if (typeof headers[Symbol.iterator] === 'function' && typeof headers !== 'string') return headersFromPairs(Array.from(headers));
  if (typeof headers.forEach === 'function') return headersFromForEach(headers);
  return Object.entries(headers).map(([name, value]) => [String(name), String(value)]);
}

export function normalizeFetchRequest(record = {}) {
  if (!record.url) throw new TypeError('fetch.start url is required');
  const requestId = String(record.requestId || record.id || createMessageId('fetch'));
  const method = String(record.method || FETCH_DEFAULTS.method).toUpperCase();
  return {
    requestId,
    method,
    url: String(record.url),
    documentUrl: String(record.documentUrl || record.url),
    referrer: String(record.referrer ?? FETCH_DEFAULTS.referrer),
    referrerPolicy: String(record.referrerPolicy ?? FETCH_DEFAULTS.referrerPolicy),
    mode: String(record.mode || FETCH_DEFAULTS.mode),
    credentials: String(record.credentials || FETCH_DEFAULTS.credentials),
    redirect: String(record.redirect || FETCH_DEFAULTS.redirect),
    cache: String(record.cache || FETCH_DEFAULTS.cache),
    cacheKey: String(record.cacheKey || record.url),
    cacheMode: String(record.cacheMode || record.cache || FETCH_DEFAULTS.cacheMode),
    priority: String(record.priority || FETCH_DEFAULTS.priority),
    headers: normalizeHeaders(record.headers),
    bodyStreamId: optionalString(record.bodyStreamId),
    rawMode: record.rawMode !== false,
    initiator: String(record.initiator || FETCH_DEFAULTS.initiator),
    navigationId: optionalString(record.navigationId),
    resourceId: optionalString(record.resourceId),
    tabId: String(record.tabId || 'tab'),
  };
}

export function makeFetchStart(record = {}) {
  const normalized = normalizeFetchRequest(record);
  return makeEnvelope('fetch.start', { id: normalized.requestId, tabId: normalized.tabId, ...normalized });
}

export function makeFetchResponseStart(record = {}) {
  const requestId = messageRequestId(record, 'fetch-response');
  return makeEnvelope('fetch.response.start', {
    id: requestId,
    tabId: record.tabId || 'tab',
    requestId,
    ...fetchResponseURLFields(record),
    ...fetchResponseMetaFields(record),
    ...fetchResponseBodyFields(record, requestId),
    ...fetchResponseCacheFields(record),
  });
}

function fetchResponseURLFields(record) {
  return {
    resourceId: optionalString(record.resourceId),
    navigationId: optionalString(record.navigationId),
    url: String(record.url || ''),
    finalUrl: String(record.finalUrl || record.url || ''),
    redirected: Boolean(record.redirected),
    redirectChain: redirectChain(record),
  };
}

function fetchResponseMetaFields(record) {
  return {
    status: Number(record.status || 0),
    statusText: String(record.statusText || ''),
    headers: normalizeHeaders(record.headers),
    mimeType: String(record.mimeType || ''),
    charset: String(record.charset || ''),
    timing: record.timing || {},
    policy: record.policy || null,
  };
}

function fetchResponseBodyFields(record, requestId) {
  return {
    contentLength: numberOrNull(record.contentLength),
    contentEncoding: String(record.contentEncoding || ''),
    bodyMode: String(record.bodyMode || ARRAYBUFFER_CHUNKS),
    bodyStreamId: String(record.bodyStreamId || `body-${requestId}`),
  };
}

function fetchResponseCacheFields(record) {
  return {
    cookieWriteSummary: record.cookieWriteSummary || null,
    cacheInfo: record.cacheInfo || null,
    cacheDecision: record.cacheDecision || null,
    cacheEntryId: optionalString(record.cacheEntryId),
    networkBackend: String(record.networkBackend || ''),
  };
}

export function makeFetchChunk(record = {}) {
  return makeEnvelope('fetch.response.chunk', {
    id: record.id || `${record.bodyStreamId || 'body'}-${record.seq || 0}`,
    tabId: record.tabId || 'tab',
    requestId: record.requestId,
    bodyStreamId: String(record.bodyStreamId || ''),
    seq: Number(record.seq || 0),
    bytes: record.bytes,
    byteOffset: Number(record.byteOffset || 0),
    byteLength: Number(record.byteLength || byteLength(record.bytes)),
    final: Boolean(record.final),
  });
}

export function makeFetchEnd(record = {}) {
  return makeEnvelope('fetch.response.end', {
    id: record.id || `${record.bodyStreamId || 'body'}-end`,
    tabId: record.tabId || 'tab',
    requestId: record.requestId,
    bodyStreamId: String(record.bodyStreamId || ''),
    bytesRead: Number(record.bytesRead || 0),
    timing: record.timing || {},
    trailerHeaders: normalizeHeaders(record.trailerHeaders),
    aborted: Boolean(record.aborted),
    checksum: optionalString(record.checksum),
  });
}

export function makeErrorMessage(type, record = {}) {
  return makeEnvelope(type, {
    id: record.id || record.requestId || createMessageId(type),
    tabId: record.tabId || 'tab',
    parentId: record.parentId,
    requestId: optionalString(record.requestId),
    code: String(record.code || 'TARGET_CONNECT_FAILED'),
    debug: String(record.debug || ''),
    timing: record.timing || {},
  });
}

export function makeWebSocketMessage(type, record = {}) {
  return makeEnvelope(type, {
    id: record.id || record.wsId || createMessageId(type),
    tabId: record.tabId || 'tab',
    parentId: record.parentId,
    wsId: optionalString(record.wsId),
    streamId: optionalString(record.streamId),
    seq: record.seq == null ? undefined : Number(record.seq),
    url: optionalString(record.url),
    protocols: normalizeStringList(record.protocols),
    origin: optionalString(record.origin),
    documentUrl: optionalString(record.documentUrl),
    selectedProtocol: optionalString(record.selectedProtocol),
    headers: normalizeHeaders(record.headers),
    opcode: optionalString(record.opcode),
    bytes: record.bytes,
    code: record.code == null ? undefined : Number(record.code),
    reason: optionalString(record.reason),
    clean: record.clean == null ? undefined : Boolean(record.clean),
    source: optionalString(record.source),
    timing: record.timing || {},
  });
}

export function makeCookieMessage(type, record = {}) {
  return makeEnvelope(type, {
    id: record.id || createMessageId(type),
    tabId: record.tabId || 'tab',
    parentId: record.parentId,
    targetUrl: String(record.targetUrl || ''),
    documentUrl: String(record.documentUrl || record.targetUrl || ''),
    cookie: optionalString(record.cookie),
    cookieString: optionalString(record.cookieString),
    cookieRecords: Array.isArray(record.cookieRecords) ? record.cookieRecords.slice() : [],
    streamIsolationKey: optionalString(record.streamIsolationKey),
    ok: record.ok == null ? undefined : Boolean(record.ok),
  });
}

export function makeCacheMessage(type, record = {}) {
  return makeEnvelope(type, {
    id: record.id || createMessageId(type),
    tabId: record.tabId || 'tab',
    parentId: record.parentId,
    cacheKey: optionalString(record.cacheKey),
    cacheName: optionalString(record.cacheName),
    partitionKey: optionalString(record.partitionKey),
    request: record.request || null,
    response: record.response || null,
    bodyStreamId: optionalString(record.bodyStreamId),
    decision: record.decision || null,
    policy: record.policy || null,
  });
}

export function makeStorageMessage(type, record = {}) {
  return makeEnvelope(type, {
    id: record.id || createMessageId(type),
    tabId: record.tabId || 'tab',
    parentId: record.parentId,
    store: optionalString(record.store),
    key: optionalString(record.key),
    value: record.value,
    transactionId: optionalString(record.transactionId),
    partitionKey: optionalString(record.partitionKey),
  });
}

export function normalizeStringList(value, fallback = []) {
  if (value == null) return fallback.slice();
  const source = Array.isArray(value) ? value : Array.from(value || []);
  return source.map((item) => String(item)).filter((item) => item.length > 0);
}

function capabilitySet(capabilities) {
  return new Set([
    ...normalizeStringList(capabilities.supportedBinaryModes, [ARRAYBUFFER_CHUNKS]),
    ...normalizeStringList(capabilities.supportedAPIs, GO_NETWORK_APIS),
    ...normalizeStringList(capabilities.supportedStorageCacheAPIs, GO_NETWORK_STORAGE_APIS),
  ]);
}

function copyUnknownFields(out, fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (!ENVELOPE_KEYS.has(key) && value !== undefined) out[key] = value;
  }
}

function headersFromForEach(headers) {
  const out = [];
  headers.forEach((value, name) => out.push([String(name), String(value)]));
  return out;
}

function headersFromPairs(pairs) {
  return pairs.map((pair) => [String(pair[0]), String(pair[1])]);
}

function intersectStringLists(left, right) {
  const r = new Set(normalizeStringList(right));
  return normalizeStringList(left).filter((value) => r.has(value));
}

function messageRequestId(record, prefix) {
  return String(record.requestId || record.id || createMessageId(prefix));
}

function redirectChain(record) {
  return Array.isArray(record.redirectChain) ? record.redirectChain.slice() : [];
}

function optionalString(value) {
  return value == null ? undefined : String(value);
}

function numberOrNull(value) {
  return value == null ? null : Number(value);
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function byteLength(bytes) {
  return bytes && typeof bytes.byteLength === 'number' ? bytes.byteLength : 0;
}

function safeToken(value) {
  return String(value || 'msg').replace(/[^a-z0-9_.-]+/gi, '-');
}
