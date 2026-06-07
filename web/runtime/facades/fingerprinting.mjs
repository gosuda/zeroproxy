export function createFingerprintingFacades({
  define,
  Native,
  ZP,
  proxyOrigin,
  normalizedError,
  getVirtualURL,
  isZeroProxyAssetURL,
  scriptProxyPath,
  resourceProxyPath,
}) {
  const {
    Array = globalThis.Array,
    Math = globalThis.Math,
    Number = globalThis.Number,
    Proxy = globalThis.Proxy,
    Set = globalThis.Set,
    String = globalThis.String,
    URL = globalThis.URL,
    WeakSet = globalThis.WeakSet,
    arrayFrom = globalThis.Array.from,
    arrayIsArray = globalThis.Array.isArray,
    functionBind = globalThis.Function.prototype.bind,
    objectAssign = globalThis.Object.assign,
    objectDefineProperty = globalThis.Object.defineProperty,
    objectGetPrototypeOf = globalThis.Object.getPrototypeOf,
    objectKeys = globalThis.Object.keys,
    objectSetPrototypeOf = globalThis.Object.setPrototypeOf,
    reflectApply = globalThis.Reflect.apply,
    reflectGet = globalThis.Reflect.get,
  } = Native;
  const global = Native.globalThis || globalThis;
  const document = global.document;
  const performance = global.performance;
  const canvasHookedWindows = new WeakSet();
  const audioHookedWindows = new WeakSet();

  function installCanvasAntiFingerprinting(w) {
    if (!w || canvasHookedWindows.has(w) || !w.CanvasRenderingContext2D || !w.HTMLCanvasElement) return;
    canvasHookedWindows.add(w);
    installCanvasGetImageDataNoise(w.CanvasRenderingContext2D.prototype);
    installCanvasToDataURLNoise(w.HTMLCanvasElement.prototype);
  }
  function installCanvasGetImageDataNoise(ctxProto) {
    const origGetImageData = ctxProto && ctxProto.getImageData;
    if (typeof origGetImageData !== 'function') return;
    define(ctxProto, 'getImageData', function(...args) {
      const imageData = reflectApply(origGetImageData, this, args);
      const data = imageData && imageData.data;
      if (data && data.length > 1) {
        data[0] = data[0] ^ 1;
        data[data.length - 2] = data[data.length - 2] ^ 1;
      }
      return imageData;
    });
  }
  function installCanvasToDataURLNoise(canvasProto) {
    const origToDataURL = canvasProto && canvasProto.toDataURL;
    if (typeof origToDataURL !== 'function') return;
    define(canvasProto, 'toDataURL', function(...args) {
      perturbCanvasForExport(this);
      return reflectApply(origToDataURL, this, args);
    });
  }
  function perturbCanvasForExport(canvas) {
    const width = canvas.width >>> 0;
    const height = canvas.height >>> 0;
    if (!width || !height) return;
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;
    const fillStyle = ctx.fillStyle;
    const globalAlpha = ctx.globalAlpha;
    try {
      const r = (Math.random() * 256) | 0;
      const g = (Math.random() * 256) | 0;
      const b = (Math.random() * 256) | 0;
      const x = (Math.random() * Math.min(width, 8)) | 0;
      const y = (Math.random() * Math.min(height, 8)) | 0;
      ctx.globalAlpha = 1;
      ctx.fillStyle = `rgba(${r},${g},${b},0.01)`;
      ctx.fillRect(x, y, 1, 1);
    } finally {
      try { ctx.fillStyle = fillStyle; } catch {}
      try { ctx.globalAlpha = globalAlpha; } catch {}
    }
  }

  function installAudioAntiFingerprinting(w) {
    if (!w || audioHookedWindows.has(w) || !w.AudioBuffer) return;
    audioHookedWindows.add(w);
    const proto = w.AudioBuffer.prototype;
    const origGetChannelData = proto && proto.getChannelData;
    if (typeof origGetChannelData !== 'function') return;
    define(proto, 'getChannelData', function(channel) {
      const f32 = reflectApply(origGetChannelData, this, [channel]);
      const limit = Math.min(f32.length, 100);
      for (let i = 0; i < limit; i++) {
        if (f32[i] !== 0) {
          f32[i] += (Math.random() - 0.5) * 1e-7;
          break;
        }
      }
      return f32;
    });
  }

  function visibleResourceEntryName(raw) {
    const fallback = String(raw || '');
    try {
      return visibleURLName(new URL(fallback, proxyOrigin), fallback);
    } catch {}
    return fallback;
  }
  function visibleURLName(u, fallback) {
    if (u.pathname === ZP.assetPath('rust-rewriter.wasm')) return '';
    if (u.origin !== proxyOrigin) return fallback;
    return visibleProxyPathName(u, fallback);
  }
  function visibleProxyPathName(u, fallback) {
    if (u.pathname === ZP.apiPath('fetch')) return visibleQueryTargetName(u, 'url', fallback);
    if (u.pathname === ZP.apiPath('script')) return visibleQueryTargetName(u, 'u', fallback);
    if (u.pathname === ZP.apiPath('worker-script')) return visibleQueryTargetName(u, 'u', fallback);
    if (u.pathname === '/favicon.ico') return new URL('/favicon.ico', getVirtualURL().href).href;
    return isZeroProxyAssetURL(u.href) ? '' : fallback;
  }
  function visibleQueryTargetName(u, param, fallback) {
    const visible = visibleInternalTargetName(u.searchParams.get(param));
    return visible == null ? fallback : visible;
  }
  function visibleInternalTargetName(raw) {
    if (!raw) return null;
    try {
      const u = new URL(String(raw), proxyOrigin);
      if (u.pathname === ZP.assetPath('rust-rewriter.wasm')) return '';
    } catch {}
    return String(raw);
  }
  function visibleDocumentURLFor(w) {
    try { return w && w.document && w.document.URL || getVirtualURL().href; } catch { return getVirtualURL().href; }
  }
  function visibleNameForEntry(entry, documentURL) {
    if (entry && entry.entryType === 'navigation') return documentURL || getVirtualURL().href;
    return visibleResourceEntryName(entry && entry.name);
  }
  function wrapPerformanceEntry(entry, documentURL) {
    const visible = visibleNameForEntry(entry, documentURL);
    if (!visible) return null;
    if (!entry || visible === entry.name) return entry;
    return new Proxy(entry, {
      get(target, prop) {
        return performanceEntryValue(target, prop, visible);
      }
    });
  }
  function performanceEntryValue(target, prop, visible) {
    if (prop === 'name') return visible;
    if (prop === 'transferSize') return visibleTransferSize(target);
    if (prop === 'toJSON') return () => performanceEntryJSON(target, visible);
    const value = target[prop];
    return typeof value === 'function' ? reflectApply(functionBind, value, [target]) : value;
  }
  function visibleTransferSize(entry) {
    const transfer = Number(entry.transferSize || 0);
    if (transfer > 0) return transfer;
    const size = Math.max(Number(entry.encodedBodySize || 0), Number(entry.decodedBodySize || 0));
    return size > 0 ? size + 300 : 0;
  }
  function performanceEntryJSON(target, visible) {
    const out = objectAssign({}, target.toJSON ? target.toJSON() : target, { name: visible });
    if (Number(out.transferSize || 0) <= 0) out.transferSize = visibleTransferSize(out);
    return out;
  }
  function maskPerformanceList(list, documentURL) {
    const raw = arrayFrom(list || []);
    const out = [];
    for (const entry of raw) {
      const wrapped = wrapPerformanceEntry(entry, documentURL);
      if (wrapped) out[out.length] = wrapped;
    }
    return out;
  }
  function mergedPerformanceEntries(entries, documentURL, doc) {
    const list = arrayFrom(entries || []);
    return maskPerformanceList(list, documentURL)
      .concat(transportTimingEntries())
      .concat(syntheticScriptTimings(doc, list));
  }
  function performanceObserverListFacade(list, documentURL, doc) {
    return new Proxy(list, {
      get(target, prop) {
        if (prop === 'getEntries') return () => mergedPerformanceEntries(target.getEntries(), documentURL, doc);
        if (prop === 'getEntriesByType') return type => visibleObservedEntriesByType(target, String(type), documentURL, doc);
        if (prop === 'getEntriesByName') return (name, type) => visibleObservedEntriesByName(target, String(name), type, documentURL, doc);
        const value = reflectGet(target, prop, target);
        return typeof value === 'function' ? reflectApply(functionBind, value, [target]) : value;
      }
    });
  }
  function syntheticResourceTiming(name, initiatorType = 'script') {
    const now = (() => { try { return Math.max(0, performance.now()); } catch { return 0; } })();
    const entry = {
      name, entryType: 'resource', startTime: 0, duration: now, initiatorType,
      deliveryType: '', nextHopProtocol: '', renderBlockingStatus: 'non-blocking',
      contentType: '', contentEncoding: '', workerStart: 0,
      workerRouterEvaluationStart: 0, workerCacheLookupStart: 0,
      workerMatchedSourceType: '', workerFinalSourceType: '',
      redirectStart: 0, redirectEnd: 0, fetchStart: 0, domainLookupStart: 0,
      domainLookupEnd: 0, connectStart: 0, secureConnectionStart: 0,
      connectEnd: 0, requestStart: 0, responseStart: 0,
      firstInterimResponseStart: 0, finalResponseHeadersStart: 0,
      responseEnd: now, transferSize: 0, encodedBodySize: 0,
      decodedBodySize: 0, responseStatus: 0, serverTiming: []
    };
    entry.toJSON = function() {
      const out = {};
      for (const key of objectKeys(entry)) if (key !== 'toJSON') out[key] = entry[key];
      return out;
    };
    return entry;
  }

  function transportTimingEntries() {
    const rows = arrayIsArray(global.__zpPerformanceTimings) ? global.__zpPerformanceTimings : [];
    const out = [];
    for (const row of rows) {
      const entry = transportTimingEntry(row);
      if (entry) out[out.length] = entry;
    }
    return out;
  }
  function transportTimingEntry(row) {
    const name = visibleResourceEntryName(row && row.targetUrl);
    if (!name) return null;
    const queue = nonNegativeNumber(row.queueWaitMs);
    const acquire = nonNegativeNumber(row.connectionAcquisitionMs);
    const firstByte = nonNegativeNumber(row.timeToFirstByteMs);
    const body = nonNegativeNumber(row.bodyDurationMs);
    const headerEnd = queue + acquire + firstByte;
    const total = Math.max(nonNegativeNumber(row.totalMs), headerEnd + body);
    const entry = {
      name, entryType: 'resource', startTime: 0, duration: total, initiatorType: 'fetch',
      deliveryType: '', nextHopProtocol: String(row.negotiatedProtocol || ''), renderBlockingStatus: 'non-blocking',
      contentType: '', contentEncoding: '', workerStart: 0,
      workerRouterEvaluationStart: 0, workerCacheLookupStart: 0,
      workerMatchedSourceType: '', workerFinalSourceType: '',
      redirectStart: 0, redirectEnd: 0, fetchStart: 0, domainLookupStart: 0,
      domainLookupEnd: 0, connectStart: queue, secureConnectionStart: queue + nonNegativeNumber(row.socksConnectMs),
      connectEnd: queue + acquire, requestStart: queue + acquire,
      responseStart: Math.min(total, headerEnd),
      firstInterimResponseStart: 0, finalResponseHeadersStart: Math.min(total, headerEnd),
      responseEnd: total, transferSize: 0, encodedBodySize: 0,
      decodedBodySize: 0, responseStatus: 0, serverTiming: transportServerTiming(row)
    };
    entry.toJSON = function() {
      const out = {};
      for (const key of objectKeys(entry)) if (key !== 'toJSON') out[key] = entry[key];
      return out;
    };
    return entry;
  }
  function transportServerTiming(row) {
    const metrics = [
      serverTimingMetric('zp-queue', row.queueWaitMs),
      serverTimingMetric('zp-connect', row.connectionAcquisitionMs),
      serverTimingMetric('zp-socks', row.socksConnectMs),
      serverTimingMetric('zp-tls', row.tlsHandshakeMs),
      serverTimingMetric('zp-first-byte', row.timeToFirstByteMs),
      serverTimingMetric('zp-body', row.bodyDurationMs),
    ];
    const out = [];
    for (const metric of metrics) if (metric) out[out.length] = metric;
    return out;
  }
  function serverTimingMetric(name, duration) {
    duration = nonNegativeNumber(duration);
    return duration ? { name, duration, description: '' } : null;
  }
  function nonNegativeNumber(value) {
    value = Number(value);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  function syntheticScriptTimingFor(name, doc) {
    try {
      for (const script of documentTargetScripts(doc || document)) {
        if ((Native.getAttribute.call(script, 'data-zp-target-url') || '') === name) return [syntheticResourceTiming(name, 'script')];
      }
    } catch {}
    return [];
  }
  function syntheticScriptTimings(doc, existing) {
    const seen = new Set();
    for (const entry of arrayFrom(existing || [])) seen.add(visibleResourceEntryName(entry && entry.name));
    const out = [];
    try {
      for (const script of documentTargetScripts(doc || document)) {
        const target = targetScriptTimingName(script);
        if (!target || seen.has(target)) continue;
        seen.add(target);
        out.push(syntheticResourceTiming(target, 'script'));
      }
      if (out.length) syntheticTimingGapStore().script += out.length;
    } catch {}
    return out;
  }
  function syntheticTimingGapStore() {
    if (!global.__zpSyntheticTimingGaps) {
      try {
        objectDefineProperty(global, '__zpSyntheticTimingGaps', {
          value: { script: 0, resource: 0 },
          enumerable: false,
          configurable: false,
        });
      } catch {
        global.__zpSyntheticTimingGaps = { script: 0, resource: 0 };
      }
    }
    return global.__zpSyntheticTimingGaps;
  }
  function documentTargetScripts(doc) {
    if (Native.querySelectorAll) return Native.querySelectorAll.call(doc, 'script[data-zp-target-url]');
    if (Native.documentScripts && Native.documentScripts.get) return Native.documentScripts.get.call(doc);
    return [];
  }
  function targetScriptTimingName(script) {
    const target = Native.getAttribute.call(script, 'data-zp-target-url') || '';
    return visibleResourceEntryName(target) ? target : '';
  }
  function installPerformanceMasking(w) {
    const perf = w && w.performance;
    if (!perf) return;
    const visibleDocumentURL = () => visibleDocumentURLFor(w);
    installPerformanceObserver(w, visibleDocumentURL);
    installPerformanceGetEntries(perf, w, visibleDocumentURL);
    installPerformanceGetEntriesByType(perf, w, visibleDocumentURL);
    installPerformanceGetEntriesByName(perf, w, visibleDocumentURL);
  }
  function installPerformanceObserver(w, visibleDocumentURL) {
    if (typeof w.PerformanceObserver !== 'function') return;
    const NativePerformanceObserver = w.PerformanceObserver;
    const ZPPerformanceObserver = createPerformanceObserver(NativePerformanceObserver, visibleDocumentURL, w);
    try { objectSetPrototypeOf(ZPPerformanceObserver, NativePerformanceObserver); } catch {}
    try { ZPPerformanceObserver.prototype = NativePerformanceObserver.prototype; } catch {}
    try { objectDefineProperty(ZPPerformanceObserver, 'supportedEntryTypes', { get() { return NativePerformanceObserver.supportedEntryTypes; }, enumerable: true, configurable: true }); } catch {}
    define(w, 'PerformanceObserver', ZPPerformanceObserver);
  }
  function createPerformanceObserver(NativePerformanceObserver, visibleDocumentURL, w) {
    return function PerformanceObserver(callback) {
      if (typeof callback !== 'function') throw normalizedError('TypeError');
      let observer;
      let facade;
      const doc = w && w.document;
      observer = new NativePerformanceObserver(list => reflectApply(callback, facade, [performanceObserverListFacade(list, visibleDocumentURL(), doc), facade]));
      facade = performanceObserverFacade(observer, visibleDocumentURL, doc);
      return facade;
    };
  }
  function performanceObserverFacade(observer, visibleDocumentURL, doc) {
    return new Proxy(observer, {
      get(target, prop) {
        if (prop === 'takeRecords') return () => mergedPerformanceEntries(target.takeRecords(), visibleDocumentURL(), doc);
        const value = reflectGet(target, prop, target);
        return typeof value === 'function' ? reflectApply(functionBind, value, [target]) : value;
      }
    });
  }
  function installPerformanceGetEntries(perf, w, visibleDocumentURL) {
    if (typeof perf.getEntries !== 'function') return;
    const native = reflectApply(functionBind, perf.getEntries, [perf]);
    define(perf, 'getEntries', function() {
      return mergedPerformanceEntries(native(), visibleDocumentURL(), w.document);
    });
  }
  function installPerformanceGetEntriesByType(perf, w, visibleDocumentURL) {
    if (typeof perf.getEntriesByType !== 'function') return;
    const native = perf.getEntriesByType;
    const maskedGetEntriesByType = function(type) {
      const self = this && this !== w ? this : perf;
      return visibleEntriesByType(native, self, String(type), w, visibleDocumentURL);
    };
    define(perf, 'getEntriesByType', maskedGetEntriesByType);
    try {
      const proto = objectGetPrototypeOf(perf);
      if (proto) define(proto, 'getEntriesByType', maskedGetEntriesByType);
    } catch {}
  }
  function visibleEntriesByType(native, self, type, w, visibleDocumentURL) {
    if (type === 'navigation') return maskPerformanceList(reflectApply(native, self, [type]), visibleDocumentURL());
    if (type !== 'resource') return reflectApply(native, self, [type]);
    const entries = reflectApply(native, self, [type]);
    return mergedPerformanceEntries(entries, visibleDocumentURL(), w.document);
  }
  function visibleObservedEntriesByType(list, type, documentURL, doc) {
    if (type === 'navigation') return maskPerformanceList(list.getEntriesByType(type), documentURL);
    if (type !== 'resource') return maskPerformanceList(list.getEntriesByType(type), documentURL);
    return mergedPerformanceEntries(list.getEntriesByType(type), documentURL, doc);
  }
  function installPerformanceGetEntriesByName(perf, w, visibleDocumentURL) {
    if (typeof perf.getEntriesByName !== 'function') return;
    const native = reflectApply(functionBind, perf.getEntriesByName, [perf]);
    define(perf, 'getEntriesByName', function(name, type) {
      return visibleEntriesByName(native, String(name), type, w.document, visibleDocumentURL);
    });
  }
  function visibleEntriesByName(native, text, type, doc, visibleDocumentURL) {
    const direct = reflectApply(native, performance, [text, type]);
    if (direct && direct.length) return maskPerformanceList(direct, visibleDocumentURL());
    const transport = visibleTransportEntriesByName(text, type);
    if (transport.length) return transport;
    const proxied = proxiedTimingEntries(native, text, type, visibleDocumentURL);
    if (proxied) return proxied;
    return wantsResourceEntries(type) ? syntheticScriptTimingFor(text, doc) : [];
  }
  function visibleObservedEntriesByName(list, text, type, documentURL, doc) {
    const out = [];
    for (const entry of mergedPerformanceEntries(list.getEntries(), documentURL, doc)) {
      if (matchesEntryNameAndType(entry, text, type)) out[out.length] = entry;
    }
    return out;
  }
  function visibleTransportEntriesByName(text, type) {
    const out = [];
    if (!wantsResourceEntries(type)) return out;
    for (const entry of transportTimingEntries()) {
      if (entry.name === text) out[out.length] = entry;
    }
    return out;
  }
  function wantsResourceEntries(type) {
    return type == null || String(type) === 'resource';
  }
  function matchesEntryNameAndType(entry, text, type) {
    return entry && entry.name === text && (type == null || String(type) === String(entry.entryType));
  }
  function proxiedTimingEntries(native, text, type, visibleDocumentURL) {
    const candidates = [scriptProxyPath(text, 'classic'), scriptProxyPath(text, 'module'), resourceProxyPath(text)];
    const all = new Array(candidates.length * 2);
    for (let i = 0; i < candidates.length; i += 1) {
      all[i] = candidates[i];
      all[i + candidates.length] = proxyOrigin + candidates[i];
    }
    for (const candidate of all) {
      const entries = reflectApply(native, performance, [candidate, type]);
      if (entries && entries.length) return maskPerformanceList(entries, visibleDocumentURL());
    }
    return null;
  }

  return {
    installCanvasAntiFingerprinting,
    installAudioAntiFingerprinting,
    installPerformanceMasking,
  };
}
