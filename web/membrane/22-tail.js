  // Replace a prototype method with a non-constructor wrapper preserving the
  // native method's name, length, descriptor flags, and `[[Prototype]]`.
  function replaceNativeMethod(proto, key, make) {
    const d = proto && Object.getOwnPropertyDescriptor(proto, key);
    if (!d || typeof d.value !== 'function') return;
    const orig = d.value;
    const fn = guardMethod(proto, key, make(orig), orig);
    try { Object.defineProperty(fn, 'name', { value: orig.name, configurable: true }); } catch {}
    try { Object.defineProperty(fn, 'length', { value: orig.length, configurable: true }); } catch {}
    maskNativeFunction(fn, key);
    try { const fp = Object.getPrototypeOf(orig); if (fp && Object.getPrototypeOf(fn) !== fp) Object.setPrototypeOf(fn, fp); } catch {}
    try { Object.defineProperty(proto, key, { value: fn, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable }); } catch {}
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
