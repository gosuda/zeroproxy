/* ZeroProxy page runtime (raw WASM glue, no wasm-bindgen).
 *
 * Loads crates/zp-page-rt cdylib and exposes a thin handle-based API to
 * runtime-prelude.js. See .ai/zp-page-rt-design.md for the contract.
 *
 * Exposes `globalThis.ZeroProxyRT.load(urlOrBuffer)` → Promise<RT>.
 * The returned RT object is callable like:
 *
 *   const rt = await ZeroProxyRT.load('/__zp/zp_page_rt.wasm');
 *   const handle = rt.internURL(rawString);
 *   if (rt.classifyURL(handle) === rt.UrlClass.JAVASCRIPT) { ... }
 *
 * Browser (fetch) and Node (Buffer) loaders both supported so the bench
 * harness can exercise the same surface as the page prelude.
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

  // Aliases the prelude wants to ask. Single decision via enum dispatch.
  // Kept tiny on purpose — the caller does the table lookup.
  const EXECUTABLE_SCHEMES = new Set([UrlClass.JAVASCRIPT, UrlClass.VBSCRIPT, UrlClass.DATA]);
  const DANGEROUS_SCHEMES = new Set([UrlClass.JAVASCRIPT, UrlClass.VBSCRIPT]);

  async function instantiate(source) {
    // Accept: URL string (fetch), ArrayBuffer/Uint8Array (raw bytes),
    // or { module, imports } for advanced cases.
    if (typeof source === 'string') {
      if (typeof fetch === 'function' && typeof WebAssembly.instantiateStreaming === 'function') {
        const resp = fetch(source);
        try {
          return await WebAssembly.instantiateStreaming(resp, {});
        } catch (e) {
          // Fall through to non-streaming if the server didn't send
          // application/wasm MIME (some dev servers don't).
          const buf = await (await fetch(source)).arrayBuffer();
          return await WebAssembly.instantiate(buf, {});
        }
      }
      // Node path — read file.
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

    // Sanity: required exports present.
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
    // View accessors. memory.grow creates a new ArrayBuffer; we detect that
    // by reference-comparing ex.memory.buffer and only rebuild the view on
    // change. Bench shows this saves ~145ns per hot call vs new-per-call.
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

    // Encode a JS string into scratchpad. Returns byte length actually
    // written. encodeInto truncates on overflow; we reject up-front because
    // returning a truncated URL would silently misclassify.
    //
    // ASCII fast path: bench shows TextEncoder.encodeInto carries 2.37×
    // overhead in Chrome (Blink string buffer cross-realm cost). URLs are
    // almost always ASCII (RFC 3986) so a charCodeAt loop wins big in the
    // common case. The non-ASCII fallback uses encodeInto since a manual
    // UTF-8 encoder would lose to V8's native implementation on real
    // multi-byte input. See .ai/zp-page-rt-bench-report.md §encoder-isolation.
    function writeScratch(str) {
      const len = str.length;
      if (len > SCRATCH_CAP) {
        // Worst case (all ASCII): even 1B/char overflows. Reject.
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
      // Non-ASCII fallback. Worst-case expansion 3B/char (BMP), 4B/char
      // for surrogate pairs — both still ≤ 3×len for BMP and 2×len for
      // surrogates (paired). Pre-check cheap upper bound.
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

    // One-shot: intern + classify. Returns packed { handle, class }.
    // Avoids the extra wasm call for callers that only need the class.
    function classify(str) {
      const n = writeScratch(String(str));
      if (n < 0) return { handle: 0, class: 0 };
      const packed = ex.url_intern_and_classify(SCRATCH, n);
      // BigInt unpacking. Two Number() ops; both fit in u32 so no precision loss.
      const handle = Number(packed >> 32n) >>> 0;
      const cls = Number(packed & 0xffffffffn) >>> 0;
      return { handle, class: cls };
    }

    // Fast path the bench cares about most: just the class, no handle.
    function classOf(str) {
      const n = writeScratch(String(str));
      if (n < 0) return 0;
      // Same packed return — extract class only.
      const packed = ex.url_intern_and_classify(SCRATCH, n);
      return Number(packed & 0xffffffffn) >>> 0;
    }

    // Scheme-only classification: encode only the first ~SCHEME_PROBE bytes,
    // skip intern entirely. For long URLs (data: / signed URLs / encoded
    // query strings) this avoids the length-linear encodeInto cost. Schemes
    // are ASCII (RFC 3986) so 16 bytes covers every well-known scheme plus
    // margin. about:blank vs about:other differentiation needs ~12 bytes;
    // truncated about: classifies as AboutOther which is policy-equivalent
    // (both block).
    const SCHEME_PROBE = 16;
    function classifySchemeOnly(str) {
      const s = String(str);
      const len = s.length;
      if (len === 0) return UrlClass.INVALID;
      // ASCII fast path. Bench (Chrome): schemeOnly + encodeAsciiFast =
      // 188ns vs schemeOnly + encodeInto = 600ns (3.19× faster) → beats
      // JS regex 197ns. Node: 178 vs 312, beats regex 207ns.
      const view = scratchView();
      const probeLen = len < SCHEME_PROBE ? len : SCHEME_PROBE;
      let allAscii = true;
      for (let i = 0; i < probeLen; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0x80) { allAscii = false; break; }
        view[i] = c;
      }
      if (allAscii) return ex.url_classify_scheme_only(SCRATCH, probeLen) >>> 0;
      // Non-ASCII in scheme region (RFC 3986 says ASCII only, so this is
      // either a malformed input or pre-relative — encode whatever fits).
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

    // Batch classify N URLs in a single wasm call. Returns Uint32Array of
    // length N where each entry is (class << 16) | (handle & 0xFFFF). The
    // caller can extract: cls = result[i] >> 16, handle_low = result[i] & 0xFFFF.
    //
    // Bench measured (Node, warm): 120 ns/item at N=16, 117 at N=64, 121 at
    // N=256 — beats JS regex (134 ns/item) for N>=16. Chrome batch wins are
    // larger (~145 ns/item vs 183 for js-regex).
    //
    // Returns null if input is empty or the layout would exceed SCRATCH_CAP.
    // SCRATCH layout (atomic — must not be interrupted by other wasm calls
    // that touch scratch):
    //   [0 .. 4N)              : u32 lens table
    //   [4N .. 4N + bytesTotal): concatenated UTF-8 bytes
    //   [4N + bytesTotal ..)   : output u32[N]
    // Cached lens buffer — grown on demand. Avoids per-call allocation in
    // the hot MO callback path. Single-threaded so reuse is safe.
    let batchLensU32 = new Uint32Array(64);
    function classifyBatch(strings) {
      const N = strings.length | 0;
      if (N === 0) return new Uint32Array(0);
      // Single-pass: encode each string DIRECTLY into scratch with ASCII
      // fast path, track lens inline. No per-string tmp allocation.
      //
      // Layout — lens + out at the start so they're 4-byte aligned (Uint32Array
      // view requires aligned offset):
      //   [0       .. 4N)   : u32 lens table
      //   [4N      .. 8N)   : u32 out table
      //   [8N      .. ?  )  : concatenated UTF-8 bytes
      // SCRATCH itself is 8-byte aligned (declared #[repr(C, align(8))] in
      // crates/zp-page-rt/src/lib.rs) so SCRATCH+4N and SCRATCH+8N are both
      // 4-byte aligned.
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
        // ASCII fast path — bench: Chrome 2× faster than encodeInto for ASCII.
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
          // Non-ASCII fallback. Worst case 3×len. encodeInto rewrites from
          // dst[0..] so partial ASCII write above is discarded automatically.
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
      // Write lens table at offset 0 as little-endian u32. Manual byte-level
      // write avoids the `new Uint8Array(lensU32.buffer, ...)` allocation
      // per call (the view creation alone is ~30ns in Node) and matches the
      // wasm-side u32 read (wasm32 is little-endian).
      for (let i = 0; i < N; i++) {
        const l = lensU32[i];
        const off = i * 4;
        view[off]     = l & 0xFF;
        view[off + 1] = (l >>> 8) & 0xFF;
        view[off + 2] = (l >>> 16) & 0xFF;
        view[off + 3] = (l >>> 24) & 0xFF;
      }
      // Call bulk wasm. May grow memory if pool reallocates — raw pointers
      // remain valid, only JS-side views detach (memU8() below refreshes).
      ex.bulk_intern_and_classify(lensPtr, N, bytesPtr, outPtr);
      // Return a view into scratch — NOT a copy. Caller MUST consume before
      // any subsequent wasm call that could touch scratch or grow memory.
      // The MO callback consumes immediately in a tight for-loop so this
      // contract is safe in practice; tests that exercise classifyBatch
      // alone should also drain before reuse.
      return new Uint32Array(memU8().buffer, outPtr, N);
    }

    // Extract the class from a packed batch result entry.
    function batchClass(packed) { return (packed >>> 16) & 0xFFFF; }
    // Extract the low-16-bit handle. Sufficient for re-classification within
    // a small pool; full handle (with bench-confirmed O(1) HashMap) requires
    // the 32-bit form which the bulk export does not currently return.
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
      // Raw exports — bench harness wants direct timing without the JS
      // wrapper overhead, and the migration path may need more endpoints.
      raw: ex,
    });
  }

  const api = Object.freeze({ load, UrlClass });
  Object.defineProperty(globalThis, 'ZeroProxyRT', {
    value: api,
    enumerable: false,
    configurable: false,
    writable: false,
  });
})();
