/* ZeroProxy page runtime WASM loader.
 * Loads crates/zp-page-rt and exposes `globalThis.ZeroProxyRT.load(source)`.
 * See crates/zp-page-rt/src/lib.rs for the ABI specification.
 */
(() => {
  'use strict';
  if (globalThis.ZeroProxyRT) return;

  const UrlClass = Object.freeze({
    INVALID: 0,
    HTTP: 1,
    WS: 2,
    BLOB: 3,
    DATA: 4,
    JAVASCRIPT: 5,
    VBSCRIPT: 6,
    ABOUT_BLANK: 7,
    ABOUT_OTHER: 8,
    RELATIVE: 9,
    OTHER: 10,
  });

  const EXECUTABLE_SCHEMES = new Set([UrlClass.JAVASCRIPT, UrlClass.VBSCRIPT, UrlClass.DATA]);
  const DANGEROUS_SCHEMES = new Set([UrlClass.JAVASCRIPT, UrlClass.VBSCRIPT]);

  async function instantiate(source) {
    if (typeof source === 'string') {
      if (typeof fetch === 'function' && typeof WebAssembly.instantiateStreaming === 'function') {
        const resp = fetch(source);
        try {
          return await WebAssembly.instantiateStreaming(resp, {});
        } catch (e) {
          // Fall back to ArrayBuffer instantiation if the server omits the application/wasm MIME type.
          const buf = await (await fetch(source)).arrayBuffer();
          return await WebAssembly.instantiate(buf, {});
        }
      }
      const { readFile } = await import('node:fs/promises');
      const buf = await readFile(source);
      return await WebAssembly.instantiate(buf, {});
    }
    if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
      return await WebAssembly.instantiate(source, {});
    }
    throw new TypeError('ZeroProxyRT.load: unsupported source');
  }

  async function load(source) {
    const { instance } = await instantiate(source);
    const ex = instance.exports;

    for (const name of ['memory', 'version', 'scratch_ptr', 'scratch_cap',
      'url_intern', 'url_classify', 'url_view', 'url_intern_and_classify',
      'pool_reset', 'pool_stats']) {
      if (typeof ex[name] !== 'function' && name !== 'memory') {
        throw new Error('ZeroProxyRT: missing export ' + name);
      }
    }

    const enc = new TextEncoder();
    const dec = new TextDecoder('utf-8');
    const SCRATCH = ex.scratch_ptr();
    const SCRATCH_CAP = ex.scratch_cap();
    // `memory.grow` detaches the previous ArrayBuffer; rebuild the views only when `ex.memory.buffer` changes.
    let cachedBuf = ex.memory.buffer;
    let cachedView = new Uint8Array(cachedBuf);
    let cachedScratch = cachedView.subarray(SCRATCH, SCRATCH + SCRATCH_CAP);
    function memU8() {
      if (ex.memory.buffer !== cachedBuf) {
        cachedBuf = ex.memory.buffer;
        cachedView = new Uint8Array(cachedBuf);
        cachedScratch = cachedView.subarray(SCRATCH, SCRATCH + SCRATCH_CAP);
      }
      return cachedView;
    }
    function scratchView() {
      if (ex.memory.buffer !== cachedBuf) memU8();
      return cachedScratch;
    }

    // Encodes a string into the WASM scratchpad and returns the byte length written, or -1 on overflow so truncated
    // URLs cannot misclassify. Uses a direct charCodeAt loop for ASCII strings to avoid TextEncoder.encodeInto call
    // overhead, falling back to TextEncoder for non-ASCII input.
    function writeScratch(str) {
      const len = str.length;
      if (len > SCRATCH_CAP) {
        return -1;
      }
      const view = scratchView();
      let allAscii = true;
      for (let i = 0; i < len; i++) {
        const c = str.charCodeAt(i);
        if (c >= 0x80) { allAscii = false; break; }
        view[i] = c;
      }
      if (allAscii) return len;
      // UTF-8 expansion is at most 3 bytes per UTF-16 code unit; check the upper bound before calling encodeInto.
      if (len * 3 > SCRATCH_CAP) {
        const probe = enc.encode(str);
        if (probe.length > SCRATCH_CAP) return -1;
        memU8().set(probe, SCRATCH);
        return probe.length;
      }
      const { written } = enc.encodeInto(str, view);
      return written | 0;
    }

    function internURL(str) {
      const n = writeScratch(String(str));
      if (n < 0) return 0;
      return ex.url_intern(SCRATCH, n) >>> 0;
    }

    function classifyURL(handle) {
      return ex.url_classify(handle >>> 0) >>> 0;
    }

    // Interns and classifies in a single WASM call, unpacking the 64-bit `(handle << 32) | class` return value.
    function classify(str) {
      const n = writeScratch(String(str));
      if (n < 0) return { handle: 0, class: 0 };
      const packed = ex.url_intern_and_classify(SCRATCH, n);
      const handle = Number(packed >> 32n) >>> 0;
      const cls = Number(packed & 0xffffffffn) >>> 0;
      return { handle, class: cls };
    }

    function classOf(str) {
      const n = writeScratch(String(str));
      if (n < 0) return 0;
      const packed = ex.url_intern_and_classify(SCRATCH, n);
      return Number(packed & 0xffffffffn) >>> 0;
    }

    // Classifies the URL scheme from the first 16 bytes without interning. 16 ASCII bytes cover all recognized
    // schemes including `about:blank` vs `about:other`.
    const SCHEME_PROBE = 16;
    function classifySchemeOnly(str) {
      const s = String(str);
      const len = s.length;
      if (len === 0) return UrlClass.INVALID;
      const view = scratchView();
      const probeLen = len < SCHEME_PROBE ? len : SCHEME_PROBE;
      let allAscii = true;
      for (let i = 0; i < probeLen; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0x80) { allAscii = false; break; }
        view[i] = c;
      }
      if (allAscii) return ex.url_classify_scheme_only(SCRATCH, probeLen) >>> 0;
      const { written } = enc.encodeInto(s, view.subarray(0, SCHEME_PROBE));
      return ex.url_classify_scheme_only(SCRATCH, written) >>> 0;
    }

    function viewURL(handle) {
      const packed = ex.url_view(handle >>> 0);
      if (packed === 0n) return '';
      const ptr = Number(packed >> 32n);
      const len = Number(packed & 0xffffffffn);
      return dec.decode(memU8().subarray(ptr, ptr + len));
    }

    // Classifies N URLs in a single WASM call. Returns a Uint32Array view into scratch memory where each entry is
    // `(class << 16) | (handle & 0xFFFF)`, or null if the batch exceeds SCRATCH_CAP.
    // Scratch layout (8-byte aligned base):
    //   [0  .. 4N) : little-endian u32 lengths
    //   [4N .. 8N) : output u32[N]
    //   [8N ..   ) : concatenated UTF-8 bytes
    // Callers must consume the returned view before the next WASM call mutates scratch or grows memory.
    let batchLensU32 = new Uint32Array(64);
    function classifyBatch(strings) {
      const N = strings.length | 0;
      if (N === 0) return new Uint32Array(0);
      const view = scratchView();
      if (N > batchLensU32.length) batchLensU32 = new Uint32Array(N);
      const lensU32 = batchLensU32;
      const bytesStart = 8 * N;
      const byteBudget = SCRATCH_CAP - bytesStart;
      if (byteBudget <= 0) return null;
      let cur = bytesStart;
      for (let i = 0; i < N; i++) {
        const s = String(strings[i] || '');
        const len = s.length;
        if (cur + len > SCRATCH_CAP) return null;
        let allAscii = true;
        for (let j = 0; j < len; j++) {
          const c = s.charCodeAt(j);
          if (c >= 0x80) { allAscii = false; break; }
          view[cur + j] = c;
        }
        let written;
        if (allAscii) {
          written = len;
        } else {
          const maxFit = Math.min(len * 3, SCRATCH_CAP - cur);
          if (maxFit < len) return null;
          const dst = view.subarray(cur, cur + maxFit);
          const r = enc.encodeInto(s, dst);
          written = r.written | 0;
        }
        lensU32[i] = written;
        cur += written;
      }
      const lensPtr = SCRATCH;
      const outPtr = SCRATCH + 4 * N;
      const bytesPtr = SCRATCH + bytesStart;
      for (let i = 0; i < N; i++) {
        const l = lensU32[i];
        const off = i * 4;
        view[off]     = l & 0xFF;
        view[off + 1] = (l >>> 8) & 0xFF;
        view[off + 2] = (l >>> 16) & 0xFF;
        view[off + 3] = (l >>> 24) & 0xFF;
      }
      ex.bulk_intern_and_classify(lensPtr, N, bytesPtr, outPtr);
      return new Uint32Array(memU8().buffer, outPtr, N);
    }

    function batchClass(packed) { return (packed >>> 16) & 0xFFFF; }
    function batchHandleLow(packed) { return packed & 0xFFFF; }

    function reset() { ex.pool_reset(); }

    function stats() {
      const packed = ex.pool_stats();
      return {
        entries: Number(packed >> 32n),
        bytes: Number(packed & 0xffffffffn),
      };
    }

    return Object.freeze({
      UrlClass,
      EXECUTABLE_SCHEMES,
      DANGEROUS_SCHEMES,
      version: ex.version() >>> 0,
      scratchCap: SCRATCH_CAP,
      internURL,
      classifyURL,
      classify,
      classOf,
      classifySchemeOnly,
      classifyBatch,
      batchClass,
      batchHandleLow,
      viewURL,
      reset,
      stats,
      raw: ex,
    });
  }

  const api = Object.freeze({ load, UrlClass });
  // `configurable: true` lets the page prelude delete `globalThis.ZeroProxyRT` after capturing it into a closure,
  // hiding the symbol from `Object.getOwnPropertyNames(window)`.
  Object.defineProperty(globalThis, 'ZeroProxyRT', {
    value: api,
    enumerable: false,
    configurable: true,
    writable: false,
  });
})();
