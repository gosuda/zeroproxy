
  // Canvas and audio readbacks are farbled: a few low bits differ from the real rendering — the same bits every time, for
  // the same origin in this profile. A site sees a device that renders one drawing one way, and the hash does not follow
  // the user from site to site. (This used to paint a random pixel INTO the page's canvas on every toDataURL and nudge a
  // sample by a random amount on every getChannelData: two reads of one drawing differed and the page's canvas changed
  // under it. No browser does either, and reading twice is the first thing a bot check does.)
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
  // Which pixel or sample changes, and to what, is a function of the seed and its position only — never of when or how
  // often the page reads.
  function farbleMix(seed, i) {
    let x = Math.imul(seed ^ i, 0x9e3779b1);
    x ^= x >>> 15; x = Math.imul(x, 0x85ebca77);
    x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae3d);
    return (x ^ (x >>> 16)) >>> 0;
  }
  // Sets (not flips) the low bit of one channel of the painted pixels on a per-site lattice, one pixel in 32: canvas
  // position (X, Y) is on it when 7X + 13Y + seed ≡ 0 (mod 32). Setting is idempotent, so a readback written back and read
  // again (getImageData → putImageData → toDataURL) comes out as it went in, as natively. Transparent pixels stay as they
  // are: a blank canvas stays blank. Only lattice pixels are visited — a page reading a large canvas every frame pays for
  // 1/32 of it.
  function farblePixels(data, x0, y0, w, h, canvasWidth) {
    const seed = farbleSeed();
    for (let y = 0; y < h; y++) {
      const Y = y0 + y;
      // 23 is 7⁻¹ mod 32: the X on the lattice in this row are X ≡ 23·(−(13Y + seed)) (mod 32)
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
  // Replaces a prototype method with one shaped like the native: same name, length and descriptor flags, no `prototype`,
  // not a constructor.
  function replaceNativeMethod(proto, key, make) {
    const d = proto && Object.getOwnPropertyDescriptor(proto, key);
    if (!d || typeof d.value !== 'function') return;
    const orig = d.value;
    const fn = make(orig);
    try { Object.defineProperty(fn, 'name', { value: orig.name, configurable: true }); } catch {}
    try { Object.defineProperty(fn, 'length', { value: orig.length, configurable: true }); } catch {}
    maskNativeFunction(fn, key);
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
    // The 2d context of each canvas, noted as it is handed out — asking the canvas for one would make one where there was
    // none (and a later getContext('webgl') would then fail).
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
    // The page's canvas is never touched: the farbled pixels go to a scratch canvas, and that one is encoded.
    const farbledCopy = (canvas) => {
      const ctx = contexts.get(canvas);
      const width = canvas.width, height = canvas.height;
      if (!ctx || !width || !height) return null;
      const image = Reflect.apply(nativeGetImageData, ctx, [0, 0, width, height]);
      farblePixels(image.data, 0, 0, width, height, width);
      const copy = w.document.createElement('canvas');
      copy.width = width; copy.height = height;
      // the same alpha and color space as the page's, or an opaque canvas would encode with an alpha channel
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
    // A channel is farbled once, the first time it is handed out: getChannelData returns the same array every time, so
    // every later read — and copyFromChannel — sees the same samples.
    const farbled = newWeakSet();
    replaceNativeMethod(w.AudioBuffer.prototype, 'getChannelData', orig => ({ getChannelData(...args) {
      const f32 = Reflect.apply(orig, this, args);
      if (f32 && !farbled.has(f32)) {
        farbled.add(f32);
        // one sample in 16, over the whole buffer — a fingerprint typically sums a window deep into it (4500–5000)
        const seed = farbleSeed() ^ Math.imul(args[0] | 0, 0x27d4eb2d);
        for (let i = seed & 15; i < f32.length; i += 16) {
          if (f32[i] === 0) continue;
          f32[i] += (farbleMix(seed, i) / 0x100000000 - 0.5) * 1e-7;
        }
      }
      return f32;
    } }).getChannelData);
  }
  // 임베드 핸들 (REFACTOR.md §3.3) — 호스트가 realm ctx 를 읽을 수 있게
  // 노출. `__zp_` 접두라 ZP_HIDDEN_RE 스크럽이 열거 표면에서 지운다.
  try {
    Object.defineProperty(root, '__zp_realm', { value: ctx, enumerable: false, configurable: true, writable: false });
  } catch {}
  // The script elements the worker put in front of the page's first one — this one included — have run by now, and go.
  // Hidden from document.scripts and from serialization, they still stood in head.children, firstElementChild and
  // childNodes in front of the page's own first element. (A removed script keeps running.)
  try {
    for (const s of Array.from(Native.querySelectorAll.call(document, 'script'))) {
      if (isZPAssetNode(s)) s.remove();
    }
  } catch {}
})();
