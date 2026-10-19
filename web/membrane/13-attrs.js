  function attrLocalName(key) {
    const s = String(key || '').toLowerCase();
    const i = s.indexOf(':');
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function tokenListContains(list, token) {
    return String(list || '').toLowerCase().split(/[\s,]+/).includes(token);
  }
  function isBlockedLinkRelValue(rel) {
    for (const token of ['modulepreload','preload','prefetch','preconnect','dns-prefetch','prerender','manifest']) {
      if (tokenListContains(rel, token)) return true;
    }
    return false;
  }
  function isIconLinkRelValue(rel) {
    for (const token of String(rel || '').toLowerCase().split(/[\s,]+/)) {
      if (token === 'icon' || token === 'mask-icon' || token === 'apple-touch-icon' || token === 'apple-touch-icon-precomposed' || token === 'apple-touch-startup-image' || token === 'fluid-icon') return true;
    }
    return false;
  }
  function isBlockedLink(el) { return el && el.localName === 'link' && isBlockedLinkRelValue(Native.getAttribute.call(el, 'rel') || ''); }
  function isIconLink(el) { return el && el.localName === 'link' && isIconLinkRelValue(Native.getAttribute.call(el, 'rel') || ''); }
  function hasSuppressedBlockedLinkRel(el) { return el && el.localName === 'link' && isBlockedLinkRelValue(Native.getAttribute.call(el, 'data-zp-blocked-rel') || ''); }
  function visibleLinkTarget(el) { return urlMeta.get(el) || Native.getAttribute.call(el, 'data-zp-target-url') || ''; }
  function suppressBlockedLinkRel(el, rawRel) {
    Native.setAttribute.call(el, 'data-zp-blocked-rel', String(rawRel));
    if (Native.removeAttribute) Native.removeAttribute.call(el, 'rel');
    blockLinkURL(el, Native.getAttribute.call(el, 'href') || '');
  }
  function blockLinkURL(el, raw) {
    if (raw != null && String(raw) !== '') Native.setAttribute.call(el, 'data-zp-blocked-url', String(raw));
    urlMeta.delete(el);
    if (Native.removeAttribute) Native.removeAttribute.call(el, 'href');
  }
  function suppressIconLinkHref(el, raw) {
    const value = raw == null ? '' : String(raw);
    let visible = value;
    if (value) {
      const t = targetURLForElement(el, value);
      if (t) visible = t;
    }
    const currentVisible = Native.getAttribute.call(el, 'data-zp-target-url') || '';
    const currentHref = Native.getAttribute.call(el, 'href') || '';
    if (visible) {
      urlMeta.set(el, visible);
      if (currentVisible !== visible) Native.setAttribute.call(el, 'data-zp-target-url', visible);
    } else {
      urlMeta.delete(el);
      if (currentVisible && Native.removeAttribute) Native.removeAttribute.call(el, 'data-zp-target-url');
    }
    if (currentHref !== hiddenIconHref) Native.setAttribute.call(el, 'href', hiddenIconHref);
  }
  function enforceLinkPolicy(el) {
    if (!el || el.localName !== 'link') return;
    const rel = Native.getAttribute.call(el, 'rel') || '';
    if (isBlockedLinkRelValue(rel)) {
      suppressBlockedLinkRel(el, rel);
      return;
    }
    if (rel && Native.removeAttribute) Native.removeAttribute.call(el, 'data-zp-blocked-rel');
    if (hasSuppressedBlockedLinkRel(el)) {
      blockLinkURL(el, Native.getAttribute.call(el, 'href') || '');
      return;
    }
    if (isIconLinkRelValue(rel)) {
      suppressIconLinkHref(el, visibleLinkTarget(el) || Native.getAttribute.call(el, 'href') || '');
      return;
    }
    if (Native.getAttribute.call(el, 'href') === hiddenIconHref) {
      const restored = visibleLinkTarget(el);
      if (restored) Native.setAttribute.call(el, 'href', restored);
      else if (Native.removeAttribute) Native.removeAttribute.call(el, 'href');
    }
    const href = Native.getAttribute.call(el, 'href') || '';
    if (href && !String(href).startsWith(proxyOrigin)) {
      const target = targetURLForElement(el, href);
      if (target) {
        const alreadyMapped = urlMeta.get(el) === target && Native.getAttribute.call(el, 'data-zp-target-url') === target && Native.getAttribute.call(el, 'href') === target;
        urlMeta.set(el, target);
        if (Native.getAttribute.call(el, 'data-zp-target-url') !== target) Native.setAttribute.call(el, 'data-zp-target-url', target);
        const proxied = subresourceProxyPath(target);
        if (!alreadyMapped && Native.getAttribute.call(el, 'href') !== proxied) Native.setAttribute.call(el, 'href', proxied);
      }
    }
  }
  function restoreVisibleLinkState(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.localName === 'link' && isIconLinkRelValue(Native.getAttribute.call(node, 'rel') || '')) {
      const target = Native.getAttribute.call(node, 'data-zp-target-url') || '';
      if (target) Native.setAttribute.call(node, 'href', target);
    }
  }
  function isFrameElement(el) {
    const tag = el && el.localName;
    return tag === 'iframe' || tag === 'frame';
  }
  // Virtualize sandbox="allow-scripts allow-same-origin" so target sites see the set attribute while the membrane isolates the frame.
  function frameSandboxAllowsEscape(raw) {
    const tokens = newSet(String(raw || '').toLowerCase().split(/\s+/).filter(Boolean));
    return tokens.has('allow-scripts') && tokens.has('allow-same-origin');
  }
  // Without allow-same-origin, the browser assigns the frame an opaque origin.
  function frameSandboxIsOpaque(raw) {
    return !newSet(String(raw || '').toLowerCase().split(/\s+/).filter(Boolean)).has('allow-same-origin');
  }
  // Reflect the page's sandbox attribute value on a detached shadow iframe so frame.sandbox returns a live DOMTokenList.
  function syncSandboxShadow(el, value) {
    const rec = sandboxShadows.get(el);
    if (!rec) return;
    if (value === null) { sandboxShadows.delete(el); return; }
    try { if (Native.getAttribute.call(rec.shadow, 'sandbox') !== value) Native.setAttribute.call(rec.shadow, 'sandbox', value); } catch {}
  }
  // Add allow-same-origin to the underlying attribute so the proxy can contain the frame while marking it as virtually opaque.
  function markFrameOpaque(el, value) {
    frameSandboxMeta.set(el, value);
    syncSandboxShadow(el, value);
    try { Native.setAttribute.call(el, OPAQUE_FRAME_ATTR, '1'); } catch {}
    // Stash the author's literal attribute value for serialization recovery.
    try { Native.setAttribute.call(el, litAttrName('sandbox'), value); } catch {}
    Native.setAttribute.call(el, 'sandbox', (value.trim() + ' allow-same-origin').trim());
  }
  function clearFrameOpaque(el) {
    // Inside an opaque document every child frame remains opaque regardless of its own attribute.
    try { if (!opaqueDocument && Native.hasAttribute.call(el, OPAQUE_FRAME_ATTR)) Native.removeAttribute.call(el, OPAQUE_FRAME_ATTR); } catch {}
    try { Native.removeAttribute.call(el, litAttrName('sandbox')); } catch {}
  }
  function setFrameSandboxAttribute(el, raw) {
    const value = String(raw == null ? '' : raw);
    if (frameSandboxAllowsEscape(value)) {
      clearFrameOpaque(el);
      frameSandboxMeta.set(el, value);
      syncSandboxShadow(el, value);
      if (Native.removeAttribute) Native.removeAttribute.call(el, 'sandbox');
      return;
    }
    if (frameSandboxIsOpaque(value)) { markFrameOpaque(el, value); return; }
    clearFrameOpaque(el);
    frameSandboxMeta.delete(el);
    sandboxShadows.delete(el);
    Native.setAttribute.call(el, 'sandbox', value);
  }
  // Compute the effective sandbox flags inherited from all enclosing frames up to the top window, or null when unsandboxed.
  let sandboxFlagsCache;
  function sandboxFlags() {
    if (sandboxFlagsCache !== undefined) return sandboxFlagsCache;
    let flags = null;
    try {
      let w = root;
      for (let i = 0; i < 32 && w !== winGet(w, 'parent'); i++) {
        const fe = winGet(w, 'frameElement');
        if (!fe) break;
        let text = Native.getAttribute.call(fe, litAttrName('sandbox'));
        if (text === null) text = Native.getAttribute.call(fe, 'sandbox');
        if (text !== null) {
          const mine = newSet(String(text).toLowerCase().split(/\s+/).filter(Boolean));
          flags = flags === null ? mine : newSet([...flags].filter(f => mine.has(f)));
        }
        w = winGet(w, 'parent');
      }
    } catch {}
    sandboxFlagsCache = flags;
    return flags;
  }
  // Virtualize dangerous or opaque sandbox attributes before the browser commits frame navigation.
  function sanitizeFrameSandbox(el) {
    if (!isFrameElement(el)) return;
    // Skip frames already rewritten by markFrameOpaque, or restore cloned frames from their literal stash.
    if (Native.hasAttribute.call(el, OPAQUE_FRAME_ATTR)) {
      if (frameSandboxMeta.has(el)) return;
      const lit = Native.getAttribute.call(el, litAttrName('sandbox'));
      if (lit !== null) { markFrameOpaque(el, lit); return; }
    }
    const raw = Native.getAttribute.call(el, 'sandbox');
    if (raw === null) return;
    if (frameSandboxAllowsEscape(raw)) {
      frameSandboxMeta.set(el, raw);
      if (Native.removeAttribute) Native.removeAttribute.call(el, 'sandbox');
    } else if (frameSandboxIsOpaque(raw)) {
      markFrameOpaque(el, raw);
    }
  }
  function isZPAttrName(name) { return String(name || '').toLowerCase().startsWith('data-zp-'); }
  function isZeroProxyAssetURL(raw) {
    if (!raw) return false;
    try {
      const u = new URL(String(raw), proxyOrigin);
      return u.origin === proxyOrigin && ZP.isInternalAssetScriptPath(u.pathname);
    } catch { return false; }
  }
  // Stash the author's original srcdoc string so attribute/property reads and serialization do not expose the injected prelude.
  const srcdocMeta = newWeakMap();
  function setInjectedSrcdoc(el, raw) {
    const s = String(raw == null ? '' : raw);
    let injected = null;
    try { injected = injectSrcdoc(s); }
    catch (e) { try { let dg = root.__zp_diagnostics; try { if (root.top && root.top.__zp_diagnostics) dg = root.top.__zp_diagnostics; } catch {} if (dg && dg.length < 200) dg.push({ t: 'srcdoc-fail', msg: String(e && (e.name + ':' + (e.message || e))).slice(0, 200), stack: String(e && e.stack || '').slice(0, 400) }); } catch {} try { console.warn('[ZP] srcdoc restore failed', String(e && (e.message || e))); } catch {} }
    if (injected == null) return false;
    srcdocMeta.set(el, s);
    Native.setAttribute.call(el, 'srcdoc', injected);
    return true;
  }
  function isZPAssetNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.id === '__zp-boot') return true;
    // Inline prelude scripts and CSP metas injected by the service worker are marked with data-zp-internal.
    if (Native.hasAttribute && Native.hasAttribute.call(node, 'data-zp-internal')) return true;
    return node.localName === 'script' && isZeroProxyAssetURL(Native.getAttribute.call(node, 'src'));
  }
  // Cache wrapped NamedNodeMap instances per raw map so el.attributes === el.attributes holds.
  const namedNodeMapCache = newWeakMap();
  const namedNodeMapOwners = newWeakMap();
  function filteredNamedNodeMap(raw, owner) {
    if (!raw) return raw;
    namedNodeMapOwners.set(raw, owner);
    const hit = namedNodeMapCache.get(raw);
    if (hit) return hit;
    const wrapped = filteredCollection(raw, attr => attr && !isZPAttrName(attr.name));
    namedNodeMapOwners.set(wrapped, owner);
    namedNodeMapCache.set(raw, wrapped);
    return wrapped;
  }
  function attachAttributeNode(el, attr, namespaced) {
    const attach = namespaced ? Native.setAttributeNodeNS : Native.setAttributeNode;
    if (!attr || attr.nodeType !== 2 || (attr.ownerElement && attr.ownerElement !== el)) return attach.call(el, attr);
    if (isZPAttrName(attr.name)) return null;
    const ns = attr.namespaceURI;
    const previous = namespaced ? Native.getAttributeNodeNS.call(el, ns, attr.localName) : Native.getAttributeNode.call(el, attr.name);
    if (previous === attr) return attr;
    const previousValue = previous && previous.value;
    // Route through setAttribute/setAttributeNS first so URL rewriting and policy hooks run before attaching the Attr node.
    const value = Native.attrValue.get.call(attr);
    if (ns) el.setAttributeNS(ns, attr.name, value);
    else el.setAttribute(attr.name, value);
    const mapped = Native.getAttributeNodeNS.call(el, ns, attr.localName);
    if (!mapped) return previous;
    Native.attrValue.set.call(attr, Native.attrValue.get.call(mapped));
    attach.call(el, attr);
    if (previous && previous.ownerElement === null) Native.attrValue.set.call(previous, previousValue);
    return previous;
  }
  // Hide the reserved data-zp-* attribute namespace across all DOM attribute, Attr node, and dataset surfaces.
  function datasetKeyToAttrName(key) {
    return 'data-' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase());
  }
  function isZPDatasetKey(key) {
    // Fast-path check for the 'zp' prefix before allocating the hyphenated attribute name.
    if (typeof key !== 'string' || key.charCodeAt(0) !== 122 || key.charCodeAt(1) !== 112) return false;
    return isZPAttrName(datasetKeyToAttrName(key));
  }
  const datasetCache = newWeakMap();
  function filteredDataset(raw) {
    if (!raw) return raw;
    const hit = datasetCache.get(raw);
    if (hit) return hit;
    const proxied = new Proxy(raw, {
      get(t, prop) { if (isZPDatasetKey(prop)) return undefined; const v = t[prop]; return typeof v === 'function' ? v.bind(t) : v; },
      has(t, prop) { return isZPDatasetKey(prop) ? false : prop in t; },
      set(t, prop, v) { if (isZPDatasetKey(prop)) return true; t[prop] = v; return true; },
      deleteProperty(t, prop) { if (isZPDatasetKey(prop)) return true; delete t[prop]; return true; },
      ownKeys(t) { return Reflect.ownKeys(t).filter(k => !isZPDatasetKey(k)); },
      getOwnPropertyDescriptor(t, prop) { return isZPDatasetKey(prop) ? undefined : Reflect.getOwnPropertyDescriptor(t, prop); },
    });
    datasetCache.set(raw, proxied);
    return proxied;
  }
  function installZPAttrNamespace(w) {
    const E = w.Element && w.Element.prototype;
    if (!E) return;
    // Delegate null-namespace lowercase calls to the non-NS hooks so both paths share identical rewriting.
    const plainNS = (ns, k, key) => (ns === null || ns === undefined || ns === '') && String(k) === key;
    if (Native.getAttributeNS) define(E, 'getAttributeNS', function(ns, k) {
      const key = String(k).toLowerCase();
      if (isZPAttrName(key)) return null;
      if (plainNS(ns, k, key)) return this.getAttribute(k);
      return Native.getAttributeNS.call(this, ns, k);
    });
    if (Native.hasAttributeNS) define(E, 'hasAttributeNS', function(ns, k) {
      const key = String(k).toLowerCase();
      if (isZPAttrName(key)) return false;
      if (plainNS(ns, k, key)) return this.hasAttribute(k);
      return Native.hasAttributeNS.call(this, ns, k);
    });
    if (Native.removeAttributeNS) define(E, 'removeAttributeNS', function(ns, k) {
      const key = String(k).toLowerCase();
      if (isZPAttrName(key)) return undefined;
      if (plainNS(ns, k, key)) return this.removeAttribute(k);
      return Native.removeAttributeNS.call(this, ns, k);
    });
    if (Native.getAttributeNode) define(E, 'getAttributeNode', function(k) {
      return isZPAttrName(k) ? null : Native.getAttributeNode.call(this, k);
    });
    if (Native.getAttributeNodeNS) define(E, 'getAttributeNodeNS', function(ns, k) {
      return isZPAttrName(k) ? null : Native.getAttributeNodeNS.call(this, ns, k);
    });
    if (Native.setAttributeNode) define(E, 'setAttributeNode', function(attr) {
      return attachAttributeNode(this, attr, false);
    });
    if (Native.setAttributeNodeNS) define(E, 'setAttributeNodeNS', function(attr) {
      return attachAttributeNode(this, attr, true);
    });
    if (Native.removeAttributeNode) define(E, 'removeAttributeNode', function(attr) {
      return attr && isZPAttrName(attr.name) ? attr : Native.removeAttributeNode.call(this, attr);
    });
    if (Native.toggleAttribute) define(E, 'toggleAttribute', function(k, force) {
      return isZPAttrName(k) ? false : Native.toggleAttribute.call(this, k, force);
    });
    if (Native.namedRemoveNamedItem && w.NamedNodeMap) define(w.NamedNodeMap.prototype, 'removeNamedItem', function(k) {
      // Throw NotFoundError for hidden data-zp-* attributes to match native NamedNodeMap behavior.
      if (isZPAttrName(k)) throw new w.DOMException("Failed to execute 'removeNamedItem' on 'NamedNodeMap': No item with name '" + String(k) + "' was found.", 'NotFoundError');
      return Native.namedRemoveNamedItem.call(this, k);
    });
    if (Native.htmlDataset && Native.htmlDataset.get && w.HTMLElement) installDatasetHook(w.HTMLElement.prototype, Native.htmlDataset);
    if (Native.svgDataset && Native.svgDataset.get && w.SVGElement) installDatasetHook(w.SVGElement.prototype, Native.svgDataset);
  }
  function installDatasetHook(proto, desc) {
    try { defineMasked(proto, 'dataset', { get() { return filteredDataset(desc.get.call(this)); }, enumerable: desc.enumerable, configurable: false }); } catch {}
  }
  function isIndexKey(prop) {
    return typeof prop !== 'symbol' && /^(?:0|[1-9]\d*)$/.test(String(prop));
  }
  function isFilterableItem(value) {
    return !!value && typeof value === 'object' && (value.nodeType !== undefined || value.ownerElement !== undefined);
  }
  function maskedBound(fn, key) {
    maskNativeFunction(fn, key);
    return fn;
  }
  function filteredCollection(raw, predicate) {
    // Materialize the filtered items once per raw collection length to avoid O(N^2) predicate scans during iteration.
    let cache = null;
    let cacheLen = -1;
    const items = () => {
      const rawLen = raw ? raw.length : 0;
      if (cache && cacheLen === rawLen) return cache;
      const out = [];
      for (let i = 0; i < rawLen; i++) {
        const item = raw[i];
        if (predicate(item)) out.push(item);
      }
      cache = out;
      cacheLen = rawLen;
      return out;
    };
    const nth = index => {
      const arr = items();
      return index >= 0 && index < arr.length ? arr[index] : null;
    };
    const length = () => items().length;
    // Expose only members present on the underlying collection (NodeList vs HTMLCollection vs NamedNodeMap).
    const inRaw = (prop) => { try { return !!raw && prop in raw; } catch { return false; } };
    // Cache bound methods so repeated property accesses return the same function reference.
    let itemFn = null;
    let getNamedItemFn = null;
    const boundFns = newMap();
    const collection = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'length') return length();
        if (prop === 'item' && inRaw('item')) return itemFn || (itemFn = maskedBound(index => nth(Number(index) || 0), 'item'));
        if (prop === 'getNamedItem' && inRaw('getNamedItem')) return getNamedItemFn || (getNamedItemFn = maskedBound(name => {
          const lower = String(name || '').toLowerCase();
          if (isZPAttrName(lower)) return null;
          for (let i = 0; raw && i < raw.length; i++) if (raw[i] && String(raw[i].name).toLowerCase() === lower && predicate(raw[i])) return raw[i];
          return null;
        }, 'getNamedItem'));
        // Return Array.prototype.values directly so iteration runs through the Proxy's length and index traps.
        if (prop === Symbol.iterator) return Array.prototype.values;
        if (isIndexKey(prop)) {
          const arr = items();
          const index = Number(prop);
          return index < arr.length ? arr[index] : undefined;
        }
        // Return unbound Array.prototype methods when present on raw so `this` remains the filtered Proxy.
        if (prop === 'forEach' || prop === 'values' || prop === 'keys' || prop === 'entries') {
          return inRaw(prop) ? Array.prototype[prop] : undefined;
        }
        const value = raw && raw[prop];
        // Filter WebIDL named-getter results through the predicate so hidden nodes or attributes cannot be accessed by name.
        if (isFilterableItem(value)) {
          try { return predicate(value) ? value : undefined; } catch { return undefined; }
        }
        if (typeof value !== 'function') return value;
        let bound = boundFns.get(prop);
        if (!bound) { bound = value.bind(raw); boundFns.set(prop, bound); }
        return bound;
      },
      has(_target, prop) {
        if (isIndexKey(prop)) return Number(prop) < length();
        try {
          if (prop === 'length') return true;
          if (!raw || !(prop in raw)) return false;
          const value = raw[prop];
          return isFilterableItem(value) ? !!predicate(value) : true;
        } catch { return prop === 'length'; }
      },
      // Report index keys as enumerable own properties to match native NodeList/NamedNodeMap ownKeys invariants.
      ownKeys() {
        const keys = [];
        for (let i = 0, n = length(); i < n; i++) keys.push(String(i));
        return keys;
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (isIndexKey(prop) && Number(prop) < length()) {
          return { value: nth(Number(prop)), writable: false, enumerable: true, configurable: true };
        }
        return undefined;
      }
    });
    return collection;
  }
  // Convert proxy URLs back to their underlying target URLs.
  // Options:
  //   scan: replace all proxy URLs embedded within a larger string (such as CSS url() or srcset).
  //   fallback: 'none' keeps unknown paths intact, 'share' maps internal /zp/ paths to virtualURL.href,
  //             and 'any' maps any proxy-origin URL to virtualURL.href.
  function deproxyURL(raw, opts) {
    const s = String(raw == null ? '' : raw);
    if (!s || s.indexOf(proxyOrigin) < 0) return s;
    const scan = !!(opts && opts.scan);
    const fallback = (opts && opts.fallback) || 'none';
    const one = (m) => {
      let u;
      try { u = new Native.URL(m); } catch { return m; }
      if (u.origin !== proxyOrigin) return m;
      const p = u.pathname;
      if (p === ZP.apiPath('fetch') || p === ZP.apiPath('v2/fetch')) return u.searchParams.get('url') || m;
      if (p === ZP.apiPath('script') || p === ZP.apiPath('worker-script') || p === ZP.apiPath('sourcemap')) return u.searchParams.get('u') || m;
      const via = u.searchParams.get('via');
      if (via) return via;
      if (fallback === 'any') return virtualURL.href;
      if (fallback === 'share' && (ZP.isSharePath(p) || p.startsWith('/zp/'))) return virtualURL.href;
      return m;
    };
    if (scan) return s.replace(proxyURLScanRE(), one);
    return s.lastIndexOf(proxyOrigin, 0) === 0 ? one(s) : s;
  }
  let proxyURLScanCache = null;
  function proxyURLScanRE() {
    if (!proxyURLScanCache) {
      const esc = proxyOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match only valid RFC 3986 URL characters so surrounding quotes or parentheses in CSS url() remain intact.
      proxyURLScanCache = new RegExp(esc + '[A-Za-z0-9\\-._~:/?#\\[\\]@!$&*+,;=%]*', 'g');
    }
    proxyURLScanCache.lastIndex = 0;
    return proxyURLScanCache;
  }
  // Stash the author's original text before rewriting <style> or inline <script> elements.
  const originalTextMeta = newWeakMap();
  // Always run deproxyURL even on stashed text in case server-rewritten CSS was later re-assigned and stashed.
  function originalStyleText(el, raw) {
    return deproxyURL(originalTextMeta.has(el) ? originalTextMeta.get(el) : raw, { scan: true });
  }
  const INLINE_WRAPPERS = ['__ZP_EXEC_INLINE_SCRIPT', '__ZP_EXEC_INLINE_MODULE'];
  function originalScriptText(el, raw) {
    if (originalTextMeta.has(el)) return deproxyURL(originalTextMeta.get(el), { scan: true });
    const s = String(raw == null ? '' : raw);
    for (const name of INLINE_WRAPPERS) {
      if (s.lastIndexOf(name + '(', 0) !== 0) continue;
      const body = s.slice(name.length + 1, s.lastIndexOf(')'));
      try { return deproxyURL(String(JSON.parse(body)), { scan: true }); } catch { return s; }
    }
    // Deproxy server-rewritten script bodies (importmap, speculationrules, or classic scripts) on read-back.
    return deproxyURL(s, { scan: true });
  }
  // Build the serialization scrub copy inside an inert document so restoring raw URLs does not trigger network fetches or custom-element constructors.
  let scrubDoc = null, scrubXmlDoc = null;
  // An XML node (a DOMParser 'application/xml' or 'image/svg+xml' result, an XHTML page) is serialized by the XML serializer, which keeps
  // `<br/>`, CDATA sections and `xmlns`. Its copy is therefore made in an inert XML document: the HTML serializer would write `<br></br>`,
  // lose the CDATA and drop the namespace attribute.
  function inertScrubDocument(node) {
    let xml = false;
    try { const od = node && node.ownerDocument; xml = !!(od && /xml/i.test(od.contentType)); } catch {}
    if (xml) {
      if (!scrubXmlDoc && Native.createXMLDocument) { try { scrubXmlDoc = Native.createXMLDocument(); } catch { scrubXmlDoc = null; } }
      return scrubXmlDoc;
    }
    if (!scrubDoc && Native.createHTMLDocument) { try { scrubDoc = Native.createHTMLDocument(''); } catch { scrubDoc = null; } }
    return scrubDoc;
  }
  function scrubbedClone(node) {
    let clone;
    try {
      const inert = node && node.nodeType !== 9 && typeof Native.importNode === 'function' ? inertScrubDocument(node) : null;
      clone = inert ? Native.importNode.call(inert, node, true) : node.cloneNode(true);
    } catch { clone = null; }
    if (!clone) return null;
    // Walk the clone and original tree in lockstep so WeakMap metadata keyed on original nodes can be read.
    const scrub = (el, origin) => {
      restoreVisibleLinkState(el);
      if (isZPAssetNode(el)) { try { el.remove(); } catch {} return; }
      const ln = el.localName;
      if (origin && (ln === 'style' || ln === 'script') && Native.nodeTextContent && Native.nodeTextContent.get) {
        const raw = String(Native.nodeTextContent.get.call(el) || '');
        const want = ln === 'style' ? originalStyleText(origin, raw) : originalScriptText(origin, raw);
        if (want !== raw && Native.nodeTextContent.set) { try { Native.nodeTextContent.set.call(el, want); } catch {} }
      }
      if (origin && srcdocMeta.has(origin)) {
        try { Native.setAttribute.call(el, 'srcdoc', srcdocMeta.get(origin)); } catch {}
      }
      if (origin && (ln === 'iframe' || ln === 'frame') && frameSandboxMeta.has(origin)) {
        try { Native.setAttribute.call(el, 'sandbox', frameSandboxMeta.get(origin)); } catch {}
      }
      // Restore literal or target URLs on attributes so outerHTML matches getAttribute.
      if (Native.getAttributeNames) {
        const tag = el.localName;
        for (const name of Native.getAttributeNames.call(el)) {
          if (isZPAttrName(name)) continue;
          const localKey = attrLocalName(name);
          let want;
          if (origin && (localKey === 'style' || localKey === 'srcset' || localKey === 'imagesrcset'
              || isURLBearing(el, name, localKey, tag) || (tag === 'script' && localKey === 'src'))) {
            const lit = litGet(origin, localKey);
            want = lit !== undefined ? lit
              : (Native.getAttribute.call(origin, litAttrName(name)) ?? Native.getAttribute.call(origin, litAttrName(localKey)) ?? undefined);
          }
          if (origin && localKey === 'src' && (tag === 'iframe' || tag === 'frame')) {
            const parked = Native.getAttribute.call(origin, 'data-zp-frame-src');
            if (parked !== null) want = parked;
          }
          if (want === undefined && origin && isURLBearing(el, name, localKey, tag) && !usesRawURLAttribute(el, name, localKey)) {
            const recalled = (localKey === 'srcset' || localKey === 'imagesrcset') ? recalledSrcset(origin, name) : undefined;
            want = recalled !== undefined ? recalled : (urlMeta.get(origin) || Native.getAttribute.call(origin, 'data-zp-target-url') || undefined);
          }
          const raw = Native.getAttribute.call(el, name);
          const base = want !== undefined && want !== null ? String(want) : raw;
          const out = deproxyURL(base, { scan: true });
          if (out !== raw) { try { Native.setAttribute.call(el, name, out); } catch {} }
        }
      }
      // Restore stashed ping attributes on the inert clone for serialization parity.
      if (ln === 'a' || ln === 'area') {
        const ping = Native.getAttribute.call(el, 'data-zp-blocked-ping');
        if (ping !== null) { try { Native.setAttribute.call(el, 'ping', ping); } catch {} }
      }
      if (Native.getAttributeNames) {
        for (const name of Native.getAttributeNames.call(el)) {
          if (isZPAttrName(name)) { try { Native.removeAttribute.call(el, name); } catch {} }
        }
      }
    };
    try {
      if (clone.nodeType === 1) scrub(clone, node);
      // Use native querySelectorAll so internal asset nodes hidden by the membrane's own selector hooks are found and removed.
      const all = (n) => {
        const nt = n && n.nodeType;
        const native = nt === 9 ? Native.querySelectorAll
          : nt === 11 ? Native.fragmentQuerySelectorAll
          : Native.elementQuerySelectorAll;
        if (native) { try { return native.call(n, '*'); } catch {} }
        return n && n.querySelectorAll ? n.querySelectorAll('*') : [];
      };
      // Recurse into <template> content fragments, which querySelectorAll does not traverse but HTML serialization outputs.
      const contentOf = (el) => {
        if (!el || el.localName !== 'template') return null;
        try {
          return Native.templateContent && Native.templateContent.get
            ? Native.templateContent.get.call(el) : el.content;
        } catch { return null; }
      };
      const walk = (cloneRoot, originRoot, depth) => {
        const cloned = all(cloneRoot);
        const origins = all(originRoot);
        const paired = origins.length === cloned.length;
        for (let i = 0; i < cloned.length; i++) {
          const origin = paired ? origins[i] : null;
          scrub(cloned[i], origin);
          if (depth < 8) {
            const cc = contentOf(cloned[i]);
            if (cc) walk(cc, contentOf(origin), depth + 1);
          }
        }
      };
      if (clone.nodeType === 1) {
        const cc = contentOf(clone);
        if (cc) walk(cc, contentOf(node), 1);
      }
      walk(clone, node, 0);
    } catch {}
    return clone;
  }
  function sanitizeSerializedNode(node, wantOuter) {
    const clone = scrubbedClone(node);
    if (!clone) return '';
    try {
      if (wantOuter) {
        return Native.elementOuterHTML && Native.elementOuterHTML.get
          ? Native.elementOuterHTML.get.call(clone) : clone.outerHTML;
      }
      return Native.elementInnerHTML && Native.elementInnerHTML.get
        ? Native.elementInnerHTML.get.call(clone) : clone.innerHTML;
    } catch { return ''; }
  }