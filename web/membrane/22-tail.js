  // Deterministic per-origin canvas and audio readback farbling. Low-order bits
  // are perturbed using a seed derived from `farbleSecret` and `securityOrigin()`,
  // so repeated readbacks within the same origin return identical values while
  // hashes differ across origins.
  const farbleSeeds = newMap();
  function farbleSeed() {
    const origin = securityOrigin();
    let h = farbleSeeds.get(origin);
    if (h === undefined) {
      const s = farbleSecret + '|' + origin;
      h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
      farbleSeeds.set(origin, h);
    }
    return h;
  }
  function farbleMix(seed, i) {
    let x = Math.imul(seed ^ i, 0x9e3779b1);
    x ^= x >>> 15; x = Math.imul(x, 0x85ebca77);
    x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae3d);
    return (x ^ (x >>> 16)) >>> 0;
  }
  // Set (rather than flip) the low bit of one RGB channel on a 1-in-32 pixel
  // lattice (`7X + 13Y + seed === 0 (mod 32)`). Setting is idempotent so a
  // `getImageData` / `putImageData` / `toDataURL` round-trip produces the same
  // pixels, and transparent pixels (`alpha === 0`) are left untouched.
  function farblePixels(data, x0, y0, w, h, canvasWidth) {
    const seed = farbleSeed();
    for (let y = 0; y < h; y++) {
      const Y = y0 + y;
      // 23 is the modular inverse of 7 mod 32.
      const lx = (23 * ((-(13 * Y + seed)) & 31)) & 31;
      for (let x = (lx - x0) & 31; x < w; x += 32) {
        const o = (y * w + x) * 4;
        if (data[o + 3] === 0) continue;
        const m = farbleMix(seed, Y * canvasWidth + x0 + x);
        const c = o + (m % 3);
        data[c] = (data[c] & 0xfe) | ((m >>> 2) & 1);
      }
    }
  }
  // Replace a prototype method with a non-constructor wrapper preserving the
  // native method's name, length, descriptor flags, and `[[Prototype]]`.
  function replaceNativeMethod(proto, key, make) {
    const d = proto && Object.getOwnPropertyDescriptor(proto, key);
    if (!d || typeof d.value !== 'function') return;
    const orig = d.value;
    const fn = make(orig);
    try { Object.defineProperty(fn, 'name', { value: orig.name, configurable: true }); } catch {}
    try { Object.defineProperty(fn, 'length', { value: orig.length, configurable: true }); } catch {}
    maskNativeFunction(fn, key);
    try { const fp = Object.getPrototypeOf(orig); if (fp && Object.getPrototypeOf(fn) !== fp) Object.setPrototypeOf(fn, fp); } catch {}
    try { Object.defineProperty(proto, key, { value: fn, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable }); } catch {}
  }

  function installCanvasAntiFingerprinting(w) {
    if (!w || canvasHookedWindows.has(w) || !w.CanvasRenderingContext2D || !w.HTMLCanvasElement) return;
    canvasHookedWindows.add(w);
    const Ctx2D = w.CanvasRenderingContext2D;
    const ctxProto = Ctx2D.prototype;
    const canvasProto = w.HTMLCanvasElement.prototype;
    const nativeGetImageData = ctxProto.getImageData;
    const nativeAttributes = ctxProto.getContextAttributes;
    // Record 2D contexts as they are created; calling `getContext('2d')` on an
    // uninitialized canvas during `toDataURL` would lock out a subsequent
    // `getContext('webgl')`.
    const contexts = newWeakMap();
    replaceNativeMethod(canvasProto, 'getContext', orig => ({ getContext(...args) {
      const ctx = Reflect.apply(orig, this, args);
      if (ctx instanceof Ctx2D) contexts.set(this, ctx);
      return ctx;
    } }).getContext);
    replaceNativeMethod(ctxProto, 'getImageData', orig => ({ getImageData(...args) {
      const image = Reflect.apply(orig, this, args);
      try {
        const sx = args[0] | 0, sy = args[1] | 0, sw = args[2] | 0, sh = args[3] | 0;
        farblePixels(image.data, sw < 0 ? sx + sw : sx, sh < 0 ? sy + sh : sy, image.width, image.height, this.canvas.width);
      } catch {}
      return image;
    } }).getImageData);
    // Encode from a scratch canvas so the page's visible canvas buffer is not mutated.
    const farbledCopy = (canvas) => {
      const ctx = contexts.get(canvas);
      const width = canvas.width, height = canvas.height;
      if (!ctx || !width || !height) return null;
      const image = Reflect.apply(nativeGetImageData, ctx, [0, 0, width, height]);
      farblePixels(image.data, 0, 0, width, height, width);
      const copy = w.document.createElement('canvas');
      copy.width = width; copy.height = height;
      // Preserve the original context attributes (alpha, colorSpace) when encoding.
      copy.getContext('2d', Reflect.apply(nativeAttributes, ctx, [])).putImageData(image, 0, 0);
      return copy;
    };
    replaceNativeMethod(canvasProto, 'toDataURL', orig => ({ toDataURL(...args) {
      let copy = null;
      try { copy = farbledCopy(this); } catch {}
      return Reflect.apply(orig, copy || this, args);
    } }).toDataURL);
    replaceNativeMethod(canvasProto, 'toBlob', orig => ({ toBlob(...args) {
      let copy = null;
      try { copy = farbledCopy(this); } catch {}
      return Reflect.apply(orig, copy || this, args);
    } }).toBlob);
  }

  function installAudioAntiFingerprinting(w) {
    if (!w || audioHookedWindows.has(w) || !w.AudioBuffer) return;
    audioHookedWindows.add(w);
    // Farble each channel's Float32Array once on first access because
    // `getChannelData` returns the same backing array on subsequent calls.
    const farbled = newWeakSet();
    replaceNativeMethod(w.AudioBuffer.prototype, 'getChannelData', orig => ({ getChannelData(...args) {
      const f32 = Reflect.apply(orig, this, args);
      if (f32 && !farbled.has(f32)) {
        farbled.add(f32);
        // Perturb 1 sample in 16 across the full buffer.
        const seed = farbleSeed() ^ Math.imul(args[0] | 0, 0x27d4eb2d);
        for (let i = seed & 15; i < f32.length; i += 16) {
          if (f32[i] === 0) continue;
          f32[i] += (farbleMix(seed, i) / 0x100000000 - 0.5) * 1e-7;
        }
      }
      return f32;
    } }).getChannelData);
  }
  // Expose the realm context on `__zp_realm` for host inspection; scrubbed from
  // enumeration by `ZP_HIDDEN_RE`.
  try {
    Object.defineProperty(root, '__zp_realm', { value: ctx, enumerable: false, configurable: true, writable: false });
  } catch {}
  // Remove injected prelude `<script>` elements now that they have executed so
  // `head.children`, `firstElementChild`, and `childNodes` match the target's DOM.
  try {
    for (const s of Array.from(Native.querySelectorAll.call(document, 'script'))) {
      if (isZPAssetNode(s)) s.remove();
    }
  } catch {}
})();
