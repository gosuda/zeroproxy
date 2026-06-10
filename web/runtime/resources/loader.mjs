const SCHEMA_VERSION = 1;
const DEFAULT_RESOURCE_TIMEOUT_MS = 10_000;

export class VirtualResourceLoader {
  constructor(options = {}) {
    if (!options.backend) throw new TypeError('backend is required');
    if (!options.realm) throw new TypeError('QuickJS realm is required');
    this.backend = options.backend;
    this.realm = options.realm;
    this.tabId = options.tabId || 'shell';
    this.servers = options.servers || [];
    this.createObjectURL = options.createObjectURL || defaultCreateObjectURL;
    this.revokeObjectURL = options.revokeObjectURL || defaultRevokeObjectURL;
    this.blobs = new Map();
    this.resourceTimeoutMs = Number.isFinite(Number(options.resourceTimeoutMs)) ? Math.max(0, Number(options.resourceTimeoutMs)) : DEFAULT_RESOURCE_TIMEOUT_MS;
    this.passiveConcurrency = Number.isFinite(Number(options.passiveConcurrency)) ? Math.max(1, Number(options.passiveConcurrency)) : 8;
    this.sequence = 0;
  }

  async loadDocument(options = {}) {
    const targetUrl = String(options.targetUrl || '');
    if (!targetUrl) throw new TypeError('targetUrl is required');
    this.revokeAll();
    const docId = options.docId || `doc-${Date.now().toString(36)}`;
    const response = await this.fetchResource({
      url: targetUrl,
      documentUrl: targetUrl,
      kind: 'document',
      resourceId: `${docId}:document`,
      navigationId: options.navigationId || docId,
      accept: 'text/html,application/xhtml+xml',
    });
    const sanitized = await this.sanitizeDocument(docId, targetUrl, response, options);
    const state = this.documentState(docId, targetUrl, response, sanitized);
    if (typeof options.beforeProcess === 'function') await options.beforeProcess(state);
    await this.processRecords(state);
    return state;
  }

  async sanitizeDocument(docId, targetUrl, response, options) {
    const result = await this.backend.sanitizeDocument({
      id: `${docId}:sanitize-html`,
      tabId: this.tabId,
      docId,
      targetUrl,
      finalUrl: response.finalUrl,
      html: response.text,
      charset: response.charset,
      controlPrefix: '/zp/',
      faviconMode: options.faviconMode || 'block',
      headers: response.headers,
      servers: this.servers,
    });
    return assertSanitizeResult(result, 'HTML_SANITIZE_FAILED');
  }

  documentState(docId, targetUrl, response, sanitized) {
    const records = Array.isArray(sanitized.records) ? [...sanitized.records] : [];
    this.sequence = records.reduce((max, record) => Math.max(max, Number(record.seq || 0)), 0);
    return {
      v: SCHEMA_VERSION,
      docId,
      targetUrl,
      finalUrl: sanitized.finalUrl || response.finalUrl,
      status: response.status,
      headers: response.headers,
      records,
      resources: new Map(records.filter((record) => record.type === 'resource.discovered').map((record) => [record.resourceId, record])),
      executedScripts: [],
      fetchedResources: [],
      errors: [],
      dynamicScripts: new Set(),
      dynamicResourceCounter: 0,
      dynamicResources: new Map(),
      dynamicStyles: new Map(),
      blobUrls: this.blobs,
      pendingPassiveResources: [],
      pendingPassiveResourceFetches: new Map(),
      passiveResourceQueue: [],
      passiveResourceActive: 0,
    };
  }

  async processRecords(state) {
    const deferredScripts = [];
    for (let index = 0; index < state.records.length; index++) await this.processRecord(state, state.records[index], deferredScripts);
    for (const record of deferredScripts) await this.executeExternalScript(state, record);
    this.realm.drainJobs();
  }

  async processRecord(state, record, deferredScripts) {
    if (record.type === 'script.inline') await this.executeInlineScript(state, record);
    else if (record.type === 'script.external' || record.type === 'module.external') await this.queueOrExecuteExternalScript(state, record, deferredScripts);
    else if (record.type === 'style.external') await this.fetchExternalStylesheetSafely(state, record);
    else if (record.type === 'resource.discovered') this.startPassiveResource(state, record);
  }
  startPassiveResource(state, record) {
    if (!shouldFetchDiscovered(record)) return Promise.resolve(false);
    const existing = state.pendingPassiveResourceFetches.get(record.resourceId);
    if (existing) return existing;
    const promise = new Promise((resolve) => {
      state.passiveResourceQueue.push({ record, resolve });
      this.pumpPassiveResources(state);
    });
    state.pendingPassiveResourceFetches.set(record.resourceId, promise);
    state.pendingPassiveResources.push(promise);
    return promise;
  }

  pumpPassiveResources(state) {
    while (state.passiveResourceActive < this.passiveConcurrency && state.passiveResourceQueue.length) {
      const item = state.passiveResourceQueue.shift();
      state.passiveResourceActive += 1;
      this.fetchPassiveResourceSafely(state, item.record)
        .finally(() => {
          state.passiveResourceActive -= 1;
          state.pendingPassiveResourceFetches.delete(item.record.resourceId);
          item.resolve(true);
          this.pumpPassiveResources(state);
        });
    }
  }

  async fetchPassiveResourceSafely(state, record) {
    try {
      await this.fetchPassiveResource(state, record);
    } catch (error) {
      state.errors.push(resourceError(record, error));
    }
  }

  async fetchExternalStylesheetSafely(state, record) {
    try {
      await this.fetchExternalStylesheet(state, record);
    } catch (error) {
      state.errors.push(resourceError(record, error));
    }
  }

  async queueOrExecuteExternalScript(state, record, deferredScripts) {
    if (record.dynamic) return;
    if (scriptIsDeferred(state, record)) deferredScripts.push(record);
    else await this.executeExternalScript(state, record);
  }

  async executeInlineScript(state, record) {
    try {
      this.realm.evalClassic(String(record.source || ''), record.filename || state.finalUrl);
      state.executedScripts.push({ type: 'inline', nodeId: record.nodeId });
      await this.drainScriptJobs(state);
    } catch (error) {
      state.errors.push(scriptError(record, error));
    }
  }

  async executeExternalScript(state, record) {
    const resource = state.resources.get(record.resourceId);
    if (!resource) return false;
    try {
      const response = await this.fetchDiscoveredResource(state, resource, 'text/javascript,application/javascript');
      if (record.type === 'module.external') this.realm.evalModule(response.text, response.finalUrl);
      else this.realm.evalClassic(response.text, response.finalUrl);
      state.executedScripts.push({ type: record.type, resourceId: record.resourceId, finalUrl: response.finalUrl });
      await this.drainScriptJobs(state);
      return true;
    } catch (error) {
      state.errors.push(scriptError(record, error));
      return false;
    }
  }

  async handleDOMMutation(state, record) {
    if (!state || !record?.nodeId) return;
    const tag = elementTag(state, record.nodeId, record);
    const styleNodeId = mutationStyleNodeId(state, record, tag);
    if (styleNodeId) await this.maybeApplyDynamicInlineStyle(state, styleNodeId);
    if (record.type === 'dom.appendChild') await this.handleDynamicAppend(state, record.nodeId, tag);
    else if (record.type === 'dom.attr') await this.handleDynamicAttribute(state, record.nodeId, tag, record.name);
  }

  async handleDynamicAppend(state, nodeId, tag) {
    if (tag === 'script') await this.maybeExecuteDynamicScript(state, nodeId);
    else await this.maybeFetchDynamicElementResources(state, nodeId, tag);
  }

  async handleDynamicAttribute(state, nodeId, tag, name) {
    if (!nodeIsConnected(state, nodeId)) return;
    const attribute = String(name || '').toLowerCase();
    if (tag === 'script' && attribute === 'src') await this.maybeExecuteDynamicScript(state, nodeId);
    else await this.maybeFetchDynamicResource(state, nodeId, tag, attribute === 'rel' && tag === 'link' ? 'href' : attribute);
  }

  async maybeExecuteDynamicScript(state, nodeId) {
    if (!nodeIsConnected(state, nodeId) || state.dynamicScripts.has(nodeId)) return;
    const sourceURL = nodeAttr(state, nodeId, 'src');
    if (!sourceURL) return;
    state.dynamicScripts.add(nodeId);
    const resolvedTargetUrl = resolveURL(sourceURL, state.finalUrl || state.targetUrl);
    const type = nodeAttr(state, nodeId, 'type');
    const module = String(type || '').toLowerCase() === 'module';
    const resourceId = `dynamic-script-${++state.dynamicResourceCounter}`;
    const resource = this.record(state, 'resource.discovered', {
      resourceId,
      kind: module ? 'module' : 'script',
      element: 'script',
      attribute: 'src',
      rawValue: sourceURL,
      resolvedTargetUrl,
      fetchPolicy: 'backend',
      renderPolicy: 'internal',
      initiatorNodeId: nodeId,
      safeUrl: internalResourceURL(resourceId),
    });
    state.resources.set(resourceId, resource);
    const scriptRecord = this.record(state, module ? 'module.external' : 'script.external', { nodeId, resourceId, dynamic: true });
    const ok = await this.executeExternalScript(state, scriptRecord);
    this.dispatchNodeEvent(nodeId, ok ? 'load' : 'error');
  }

  async maybeFetchDynamicElementResources(state, nodeId, tag) {
    for (const attribute of dynamicResourceAttributes(tag)) await this.maybeFetchDynamicResource(state, nodeId, tag, attribute);
  }

  async maybeFetchDynamicResource(state, nodeId, tag, attribute) {
    const descriptor = dynamicResourceDescriptor(state, nodeId, tag, attribute);
    if (!descriptor) return;
    const rawValue = nodeAttr(state, nodeId, descriptor.attribute);
    if (!rawValue) return;
    if (!state.dynamicResources) state.dynamicResources = new Map();
    const key = `${nodeId}:${descriptor.attribute}`;
    if (state.dynamicResources.get(key) === rawValue) return;
    state.dynamicResources.set(key, rawValue);
    if (descriptor.kind === 'srcset') return this.finishDynamicSrcset(state, nodeId, tag, rawValue, descriptor);
    const resource = this.recordDynamicResource(state, nodeId, tag, rawValue, descriptor);
    const ok = await this.fetchDynamicDescriptorResource(state, nodeId, resource, descriptor);
    if (descriptor.dispatch) this.dispatchNodeEvent(nodeId, ok ? 'load' : 'error');
  }

  async finishDynamicSrcset(state, nodeId, tag, rawValue, descriptor) {
    const ok = await this.fetchDynamicSrcset(state, nodeId, tag, rawValue);
    if (descriptor.dispatch) this.dispatchNodeEvent(nodeId, ok ? 'load' : 'error');
  }

  recordDynamicResource(state, nodeId, tag, rawValue, descriptor) {
    const resourceId = `dynamic-${descriptor.kind}-${++state.dynamicResourceCounter}`;
    const resource = this.record(state, 'resource.discovered', {
      resourceId,
      kind: descriptor.kind,
      element: tag,
      attribute: descriptor.attribute,
      rawValue,
      resolvedTargetUrl: resolveURL(rawValue, state.finalUrl || state.targetUrl),
      fetchPolicy: 'backend',
      renderPolicy: descriptor.renderPolicy,
      initiatorNodeId: nodeId,
      safeUrl: internalResourceURL(resourceId),
    });
    state.resources.set(resourceId, resource);
    return resource;
  }

  async fetchDynamicDescriptorResource(state, nodeId, resource, descriptor) {
    try {
      if (descriptor.kind === 'style') await this.fetchExternalStylesheet(state, this.record(state, 'style.external', { nodeId, resourceId: resource.resourceId, dynamic: true }));
      else await this.fetchPassiveResource(state, resource);
      return true;
    } catch (error) {
      state.errors.push(resourceError(resource, error));
      return false;
    }
  }

  async fetchDynamicSrcset(state, nodeId, tag, rawValue) {
    const candidates = parseSrcset(rawValue);
    if (!candidates.length) return false;
    let ok = true;
    const renderedCandidates = [];
    for (const candidate of candidates) {
      const resourceId = `dynamic-srcset-${++state.dynamicResourceCounter}`;
      const resource = this.record(state, 'resource.discovered', {
        resourceId,
        kind: 'image',
        element: tag,
        attribute: 'srcset',
        rawValue: candidate.url,
        resolvedTargetUrl: resolveURL(candidate.url, state.finalUrl || state.targetUrl),
        fetchPolicy: 'backend',
        renderPolicy: 'blob',
        initiatorNodeId: nodeId,
        safeUrl: internalResourceURL(resourceId),
      });
      state.resources.set(resourceId, resource);
      try {
        const fetched = await this.fetchPassiveResource(state, resource);
        if (fetched?.blobUrl) renderedCandidates.push(joinSrcsetCandidate(fetched.blobUrl, candidate.descriptor));
        else ok = false;
      } catch (error) {
        ok = false;
        state.errors.push(resourceError(resource, error));
      }
    }
    if (renderedCandidates.length) this.record(state, 'dom.attr', { nodeId, name: 'srcset', value: renderedCandidates.join(', '), generated: true });
    return ok;
  }

  dispatchNodeEvent(nodeId, type) {
    try {
      this.realm.evalClassic(`globalThis.__zpDispatchNodeEvent && globalThis.__zpDispatchNodeEvent(${JSON.stringify(String(nodeId))}, ${JSON.stringify(String(type))})`, 'zeroproxy-dom-event.js');
    } catch {
      // Event dispatch is best-effort; the loader error was already recorded.
    }
  }

  async drainScriptJobs(state) {
    this.realm.drainJobs();
    if (state.network?.waitForIdle) await state.network.waitForIdle();
    this.realm.drainJobs();
  }


  async maybeApplyDynamicInlineStyle(state, nodeId) {
    const css = styleNodeText(state, nodeId);
    if (!css) return;
    if (!state.dynamicStyles) state.dynamicStyles = new Map();
    if (state.dynamicStyles.get(nodeId) === css) return;
    state.dynamicStyles.set(nodeId, css);
    const resourceId = `dynamic-style-inline-${nodeId}`;
    try {
      const result = await this.backend.sanitizeStylesheet({
        id: `${state.docId}:sanitize-inline-css:${nodeId}`,
        tabId: this.tabId,
        docId: state.docId,
        baseUrl: state.finalUrl || state.targetUrl,
        css,
        kind: 'inline-style',
        servers: this.servers,
      });
      const sanitized = assertSanitizeResult(result, 'CSS_SANITIZE_FAILED');
      const namespacedRecords = namespaceResourceRecords(sanitized.records, resourceId);
      appendRecords(state, namespacedRecords);
      for (const nested of namespacedRecords) {
        if (nested.type === 'resource.discovered') this.startPassiveResource(state, nested);
      }
      this.record(state, 'style.inline', {
        nodeId,
        resourceId,
        css: namespaceInternalResourceURLs(sanitized.css, resourceId),
        dynamic: true,
      });
    } catch (error) {
      state.errors.push(resourceError({ type: 'style.inline', resourceId }, error));
    }
  }
  async fetchExternalStylesheet(state, record) {
    const resource = state.resources.get(record.resourceId);
    if (!resource) return false;
    const response = await this.fetchDiscoveredResource(state, resource, 'text/css');
    const result = await this.backend.sanitizeStylesheet({
      id: `${state.docId}:sanitize-css:${record.resourceId}`,
      tabId: this.tabId,
      docId: state.docId,
      baseUrl: response.finalUrl,
      css: response.text,
      kind: 'stylesheet',
      servers: this.servers,
    });
    const sanitized = assertSanitizeResult(result, 'CSS_SANITIZE_FAILED');
    const namespacedRecords = namespaceResourceRecords(sanitized.records, record.resourceId);
    appendRecords(state, namespacedRecords);
    for (const nested of namespacedRecords) {
      if (nested.type === 'resource.discovered') this.startPassiveResource(state, nested);
    }
    this.record(state, 'style.inline', {
      resourceId: record.resourceId,
      css: namespaceInternalResourceURLs(sanitized.css, record.resourceId),
      external: true,
    });
    return true;
  }

  async fetchPassiveResource(state, record) {
    if (!shouldFetchDiscovered(record)) return false;
    const existing = state.fetchedResources.find((item) => item.resourceId === record.resourceId);
    if (existing) return existing;
    return this.fetchDiscoveredResource(state, record, acceptForKind(record.kind));
  }

  async fetchDiscoveredResource(state, resource, accept) {
    this.record(state, 'resource.fetch.start', {
      resourceId: resource.resourceId,
      kind: resource.kind,
      resolvedTargetUrl: resource.resolvedTargetUrl,
    });
    const response = await this.fetchResource({
      url: resource.resolvedTargetUrl,
      documentUrl: state.finalUrl,
      kind: resource.kind,
      resourceId: resource.resourceId,
      accept,
    });
    const blobUrl = this.makeBlobURL(resource, response);
    const fetched = { resourceId: resource.resourceId, finalUrl: response.finalUrl, bytesRead: response.bytes.byteLength, blobUrl };
    state.fetchedResources.push(fetched);
    this.record(state, 'resource.blob.ready', {
      resourceId: resource.resourceId,
      kind: resource.kind,
      blobUrl,
      finalUrl: response.finalUrl,
      bytesRead: response.bytes.byteLength,
      mimeType: contentType(response.headers),
    });
    return { ...response, ...fetched };
  }

  async fetchResource(options) {
    const requestId = `${this.tabId}:${options.kind}:${options.resourceId}`;
    const messages = await this.fetchRawWithTimeout(requestId, {
      requestId,
      tabId: this.tabId,
      url: options.url,
      documentUrl: options.documentUrl || options.url,
      resourceId: options.resourceId,
      navigationId: options.navigationId,
      headers: [['Accept', options.accept || '*/*']],
      initiator: options.kind || 'resource',
      servers: this.servers,
    }, options.kind === 'document' ? 0 : this.resourceTimeoutMs);
    return decodeFetchMessages(messages);
  }

  async fetchRawWithTimeout(requestId, requestRecord, timeoutMs) {
    if (!timeoutMs) return this.backend.fetchRaw(requestRecord);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        this.backend.cancel?.(requestId)?.catch?.(() => {});
        reject(fetchTimeoutError(requestId, timeoutMs));
      }, timeoutMs);
    });
    return Promise.race([this.backend.fetchRaw(requestRecord), timeout]).finally(() => clearTimeout(timer));
  }

  makeBlobURL(resource, response) {
    const blobUrl = this.createObjectURL(response.bytes, contentType(response.headers), resource);
    this.blobs.set(resource.resourceId, blobUrl);
    return blobUrl;
  }

  revokeAll() {
    for (const url of this.blobs.values()) this.revokeObjectURL(url);
    this.blobs.clear();
  }

  record(state, type, fields) {
    this.sequence += 1;
    const record = { v: SCHEMA_VERSION, type, docId: state.docId, seq: this.sequence, ...fields };
    state.records.push(record);
    state.renderer?.applyMutation?.(record);
    return record;
  }
}

export function decodeFetchMessages(messages) {
  const list = Array.isArray(messages) ? messages : [messages];
  const error = list.find((message) => message.type === 'fetch.error' || message.error);
  if (error) throw Object.assign(new Error(error.debug || error.error?.debug || 'FETCH_FAILED'), { error });
  const start = list.find((message) => message.type === 'fetch.response.start');
  if (!start) throw new Error('FETCH_RESPONSE_START_MISSING');
  const chunks = list.filter((message) => message.type === 'fetch.response.chunk').sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
  const bytes = concatenateChunks(chunks);
  const charset = start.charset || charsetFromContentType(contentType(start.headers)) || 'utf-8';
  return {
    url: start.url,
    finalUrl: start.finalUrl || start.url,
    status: start.status,
    statusText: start.statusText || '',
    headers: start.headers || [],
    charset,
    bytes,
    text: new TextDecoder(charset).decode(bytes),
  };
}

function concatenateChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + Number(chunk.byteLength || chunk.bytes?.byteLength || 0), 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    const bytes = new Uint8Array(chunk.bytes || new ArrayBuffer(0));
    out.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return out;
}

function appendRecords(state, records) {
  if (!Array.isArray(records)) return;
  for (const record of records) {
    state.records.push(record);
    if (record.type === 'resource.discovered') state.resources.set(record.resourceId, record);
  }
}

function assertSanitizeResult(result, code) {
  if (!result || result.error) {
    throw Object.assign(new Error(result?.error?.debug || code), { code, result });
  }
  return result;
}

function namespaceResourceRecords(records, prefix) {
  if (!Array.isArray(records)) return [];
  return records.map((record) => {
    if (!record.resourceId) return record;
    const resourceId = `${prefix}:${record.resourceId}`;
    return {
      ...record,
      resourceId,
      safeUrl: record.safeUrl ? internalResourceURL(resourceId) : record.safeUrl,
    };
  });
}

function namespaceInternalResourceURLs(css, prefix) {
  return String(css || '').replace(/zp-internal:\/\/resource\/([A-Za-z0-9._:-]+)/g, (_match, resourceId) =>
    internalResourceURL(`${prefix}:${resourceId}`),
  );
}

function internalResourceURL(resourceId) {
  return `zp-internal://resource/${resourceId}`;
}

function shouldFetchDiscovered(record) {
  if (record.fetchPolicy !== 'backend') return false;
  return !['script', 'module', 'style', 'iframe', 'object', 'embed', 'form', 'anchor', 'favicon'].includes(record.kind);
}

function acceptForKind(kind) {
  switch (kind) {
    case 'image': return 'image/*';
    case 'font': return 'font/*';
    case 'media': return 'audio/*,video/*';
    case 'track': return 'text/vtt,text/plain';
    case 'css-url': return '*/*';
    default: return '*/*';
  }
}

function contentType(headers) {
  const found = (headers || []).find(([name]) => String(name).toLowerCase() === 'content-type');
  return found ? String(found[1]) : '';
}

function charsetFromContentType(value) {
  const match = String(value || '').match(/charset=([^;]+)/i);
  return match ? match[1].trim() : '';
}

function scriptError(record, error) {
  const envelope = error?.envelope || {};
  const out = { recordType: record.type, nodeId: record.nodeId, resourceId: record.resourceId, error: error?.message || String(error) };
  if (envelope.error) out.errorCode = envelope.error;
  if (envelope.name) out.errorName = envelope.name;
  if (envelope.message) out.errorMessage = envelope.message;
  if (envelope.stack) out.stack = String(envelope.stack).slice(0, 4096);
  return out;
}
function scriptIsDeferred(state, record) {
  if (record.type === 'module.external') return true;
  if (nodeAttr(state, record.nodeId, 'async') !== null) return false;
  return nodeAttr(state, record.nodeId, 'defer') !== null;
}

function nodeAttr(state, nodeId, name) {
  const lowerName = String(name || '').toLowerCase();
  for (let index = (state.records || []).length - 1; index >= 0; index -= 1) {
    const record = state.records[index];
    if (!record || record.nodeId !== nodeId || String(record.name || '').toLowerCase() !== lowerName) continue;
    if (record.type === 'dom.removeAttr') return null;
    if (record.type === 'node.attr' || record.type === 'dom.attr') return String(record.value ?? '');
  }
  return null;
}

function nodeIsConnected(state, nodeId, seen = new Set()) {
  if (!nodeId || seen.has(nodeId)) return false;
  seen.add(nodeId);
  const record = latestNodeLifecycleRecord(state, nodeId);
  if (!record) return false;
  if (record.type === 'dom.removeChild') return false;
  if (record.type === 'dom.appendChild') return true;
  if (!record.parentNodeId) return String(record.tag || '').toLowerCase() === 'html';
  return nodeIsConnected(state, record.parentNodeId, seen);
}

function latestNodeLifecycleRecord(state, nodeId) {
  for (let index = (state.records || []).length - 1; index >= 0; index -= 1) {
    const record = state.records[index];
    if (record?.nodeId === nodeId && (record.type === 'dom.removeChild' || record.type === 'dom.appendChild' || record.type === 'node.create')) return record;
  }
  return null;
}

function elementTag(state, nodeId, fallback = {}) {
  if (fallback.tag) return String(fallback.tag).toLowerCase();
  for (let index = (state.records || []).length - 1; index >= 0; index -= 1) {
    const record = state.records[index];
    if (!record || record.nodeId !== nodeId || !record.tag) continue;
    if (record.type === 'node.create' || record.type === 'dom.appendChild') return String(record.tag).toLowerCase();
  }
  return '';
}

function mutationStyleNodeId(state, record, tag) {
  if (tag === 'style' && nodeIsConnected(state, record.nodeId)) return record.nodeId;
  if (record.parentNodeId && elementTag(state, record.parentNodeId) === 'style' && nodeIsConnected(state, record.parentNodeId)) return record.parentNodeId;
  return '';
}

function styleNodeText(state, nodeId) {
  let text = '';
  const textParents = new Map();
  for (const record of state.records || []) {
    const resetText = styleTextReset(record, nodeId);
    if (resetText !== null) text = resetText;
    text += styleTextAppend(record, nodeId, textParents);
  }
  return text;
}

function styleTextReset(record, nodeId) {
  return record.nodeId === nodeId && record.type === 'dom.textContent' ? String(record.text || '') : null;
}

function styleTextAppend(record, nodeId, textParents) {
  if (record.parentNodeId === nodeId && (record.type === 'node.text' || record.type === 'dom.appendChild')) return appendStyleChildText(record, nodeId, textParents);
  if (textParents.get(record.nodeId) === nodeId && (record.type === 'dom.text' || record.type === 'dom.textContent')) return String(record.text || '');
  return '';
}

function appendStyleChildText(record, nodeId, textParents) {
  if (record.nodeId) textParents.set(record.nodeId, nodeId);
  return String(record.text || '');
}

function dynamicResourceAttributes(tag) {
  switch (tag) {
    case 'img':
      return ['src', 'srcset'];
    case 'input':
      return ['src'];
    case 'source':
      return ['src', 'srcset'];
    case 'audio':
    case 'track':
      return ['src'];
    case 'video':
      return ['src', 'poster'];
    case 'link':
      return ['href'];
    default:
      return [];
  }
}

function dynamicResourceDescriptor(state, nodeId, tag, attribute) {
  const name = String(attribute || '').toLowerCase();
  return linkResourceDescriptor(state, nodeId, tag, name) || sourceResourceDescriptor(state, nodeId, tag, name) || mediaResourceDescriptor(tag, name);
}

function linkResourceDescriptor(state, nodeId, tag, name) {
  if (tag !== 'link') return null;
  if (name !== 'href' || !relListContains(nodeAttr(state, nodeId, 'rel'), 'stylesheet')) return null;
  return { kind: 'style', attribute: 'href', renderPolicy: 'blob', dispatch: true };
}

function sourceResourceDescriptor(state, nodeId, tag, name) {
  if (name === 'src' && (tag === 'img' || tag === 'input')) return { kind: 'image', attribute: 'src', renderPolicy: 'blob', dispatch: true };
  if (name === 'srcset' && (tag === 'img' || tag === 'source')) return { kind: 'srcset', attribute: 'srcset', renderPolicy: 'blob', dispatch: nodeAttr(state, nodeId, 'src') === null };
  return null;
}

function mediaResourceDescriptor(tag, name) {
  if (tag === 'video' && name === 'poster') return { kind: 'image', attribute: 'poster', renderPolicy: 'blob', dispatch: false };
  if (name === 'src' && (tag === 'audio' || tag === 'video' || tag === 'source')) return { kind: 'media', attribute: 'src', renderPolicy: 'blob', dispatch: true };
  if (tag === 'track' && name === 'src') return { kind: 'track', attribute: 'src', renderPolicy: 'blob', dispatch: true };
  return null;
}

function relListContains(value, token) {
  return String(value || '').toLowerCase().split(/\s+/).includes(token);
}

function parseSrcset(raw) {
  let rest = String(raw || '').trim();
  const out = [];
  while (rest) {
    const result = nextSrcsetCandidate(rest);
    if (result.candidate.raw) out.push(result.candidate);
    if (!result.more) break;
    rest = trimHTMLSpace(result.next);
  }
  return out;
}

function nextSrcsetCandidate(input) {
  const urlEnd = srcsetURLEnd(input);
  const candidateEnd = srcsetCandidateEnd(input, urlEnd);
  const candidate = {
    raw: input.slice(0, candidateEnd).trim(),
    url: input.slice(0, urlEnd).trim(),
    descriptor: input.slice(urlEnd, candidateEnd).trim(),
  };
  return candidateEnd >= input.length ? { candidate, next: '', more: false } : { candidate, next: input.slice(candidateEnd + 1), more: true };
}

function srcsetCandidateEnd(input, urlEnd) {
  const commaOffset = input.slice(urlEnd).indexOf(',');
  return commaOffset < 0 ? input.length : urlEnd + commaOffset;
}

function fetchTimeoutError(requestId, timeoutMs) {
  const error = new Error(`FETCH_TIMEOUT: ${requestId} exceeded ${timeoutMs}ms`);
  error.code = 'FETCH_TIMEOUT';
  return error;
}

function srcsetURLEnd(input) {
  if (input.toLowerCase().startsWith('data:')) return dataURLSrcsetEnd(input);
  for (let index = 0; index < input.length; index += 1) {
    if (isHTMLSpace(input[index]) || input[index] === ',') return index;
  }
  return input.length;
}

function dataURLSrcsetEnd(input) {
  for (let index = 0; index < input.length; index += 1) {
    if (isHTMLSpace(input[index])) return index;
  }
  return input.length;
}

function trimHTMLSpace(input) {
  return String(input || '').replace(/^[ \n\t\r\f]+/, '');
}

function isHTMLSpace(ch) {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f';
}

function joinSrcsetCandidate(urlPart, descriptor) {
  const text = String(descriptor || '').trim();
  return text ? `${urlPart} ${text}` : urlPart;
}

function resourceError(record, error) {
  return { recordType: record.type, resourceId: record.resourceId, error: error?.message || String(error) };
}

function resolveURL(value, base) {
  try {
    return new URL(String(value || ''), String(base || 'about:blank')).href;
  } catch {
    return String(value || '');
  }
}

function defaultCreateObjectURL(bytes, type) {
  if (typeof Blob === 'function' && typeof globalThis.URL?.createObjectURL === 'function') {
    return globalThis.URL.createObjectURL(new Blob([bytes], { type: type || 'application/octet-stream' }));
  }
  return `zp-internal://blob/${bytes.byteLength}`;
}

function defaultRevokeObjectURL(url) {
  if (typeof globalThis.URL?.revokeObjectURL === 'function' && String(url).startsWith('blob:')) globalThis.URL.revokeObjectURL(url);
}
