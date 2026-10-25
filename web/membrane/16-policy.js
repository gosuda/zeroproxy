  // Keep observedDocuments declared here so initial boot calls before initialization are skipped by the catch block below, avoiding duplicate instrumentation of the root window.
  const observedDocuments = newWeakSet();
  function installBaseObserver(doc) {
    doc = doc || document;
    try { if (observedDocuments.has(doc)) return; } catch { return; }
    syncBaseElement(doc);
    const MO = (doc.defaultView && doc.defaultView.MutationObserver) || root.MutationObserver;
    if (!MO || !doc.documentElement) return;
    try {
      const obs = new MO(records => {
        try { zpTrace('mo', 'n=' + records.length); } catch {}
        // Cache URL classification and canonicalization within a single MutationObserver batch.
        tickURLCache = newMap();
        try {
          if (rt) {
            const HTTP = rt.UrlClass.HTTP, WS = rt.UrlClass.WS;
            for (const r of records) {
              if (r.type !== 'attributes') continue;
              const raw = Native.getAttribute.call(r.target, String(r.attributeName || ''));
              if (!raw || tickURLCache.has(raw)) continue;
              try {
                const cls = rt.classifySchemeOnly(raw);
                if (cls !== HTTP && cls !== WS) tickURLCache.set(raw, null);
              } catch { /* Fall through to per-record main loop */ }
            }
          }
          for (const r of records) {
            if (r.type === 'attributes') enforceObservedAttribute(r.target, String(r.attributeName || '').toLowerCase());
            else for (const n of r.addedNodes || []) { syncBaseElement(n); enforceSubtreePolicies(n); instrumentDescendantIframes(n); }
          }
        } finally {
          tickURLCache = null;
        }
      });
      obs.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'xlink:href', 'src', 'srcdoc', 'action', 'formaction', 'poster', 'integrity', 'type', 'rel', 'target', 'data', 'http-equiv', 'content', 'ping'] });
      activeObservers.add(obs);
      observedDocuments.add(doc);
    } catch {}
  }
  function enforceObservedAttribute(el, key) {
    if (!el || !key) return;
    const localKey = attrLocalName(key);
    const tag = el.localName;
    if (tag === 'base' && localKey === 'href') { syncBaseElement(el); return; }
    if (tag === 'link' && (localKey === 'rel' || localKey === 'href')) { enforceLinkPolicy(el); return; }
    if (tag === 'meta' && (localKey === 'http-equiv' || localKey === 'content')) { enforceMetaPolicy(el); return; }
    // Stash and remove ping attributes on parser-inserted anchors so native click beacons do not fire directly.
    if (localKey === 'ping' && (tag === 'a' || tag === 'area')) {
      const raw = Native.getAttribute.call(el, key);
      if (raw != null) { Native.setAttribute.call(el, 'data-zp-blocked-ping', raw); Native.removeAttribute.call(el, key); }
      return;
    }
    if (localKey === 'sandbox' && isFrameElement(el)) { sanitizeFrameSandbox(el); return; }
    if (tag === 'script' && (localKey === 'src' || localKey === 'href' || localKey === 'type')) {
      const target = urlMeta.get(el) || Native.getAttribute.call(el, 'data-zp-target-url') || '';
      const current = Native.getAttribute.call(el, 'src');
      if (target && (current === scriptProxyPath(target, executableScriptKindForElement(el) || 'classic') || (current && relayTargetOf(current) === target))) return;
      const raw = target || Native.getAttribute.call(el, 'src') || Native.getAttribute.call(el, 'href');
      if (raw) setScriptSource(el, raw);
      return;
    }
    if (localKey === 'integrity' && isIntegrityBearing(el)) {
      const raw = Native.getAttribute.call(el, 'integrity');
      if (raw !== null) setBackedIntegrity(el, raw);
      return;
    }
    if ((tag === 'iframe' || tag === 'frame') && localKey === 'srcdoc') {
      const raw = Native.getAttribute.call(el, 'srcdoc');
      if (raw && !srcdocMeta.has(el) && !srcdocHasPrelude(raw)) setInjectedSrcdoc(el, raw);
      instrumentIframe(el);
      return;
    }
    if (!isURLBearing(el, key, localKey, tag)) return;
    if (localKey === 'srcset' || localKey === 'imagesrcset') {
      const list = Native.getAttribute.call(el, key);
      if (list) enforceSrcsetAttribute(el, key, String(list));
      return;
    }
    const raw = Native.getAttribute.call(el, key);
    if (shouldBlockURLAttribute(el, localKey, raw, localKey, tag) || hasContextBlockedScheme(el, raw)) { blockExecutableURL(el, localKey, raw); return; }
    if (!raw) return;
    // Upgrade already-proxied subresource URLs to blob URLs when inside an SW-less frame.
    if (String(raw).startsWith(proxyOrigin)) { upgradeSWLessURL(el, key, String(raw)); return; }
    // The address of a frame we already routed to a site-frame host is our own write, not a URL of the page's: routed again as a target it is
    // wrapped once more, its new address is observed, and so on, every round a third longer.
    if ((tag === 'iframe' || tag === 'frame') && localKey === 'src' && isSiteFrameAddress(raw)) return;
    // Leave safe blob: URLs and SW-less placeholders untouched so they are not re-proxied in a loop.
    if (/^blob:/i.test(String(raw))) return;
    if (String(raw) === SWLESS_ERROR) return;
    if (String(raw) === SWLESS_PIXEL) { upgradeSWLessURL(el, key, String(raw)); return; }
    const target = targetURLForElement(el, raw);
    if (!target) return;
    // Park frame src attributes while inside inert documents (such as template fragments).
    if ((tag === 'iframe' || tag === 'frame') && localKey === 'src' && inertFrameDocument(el)) {
      urlMeta.set(el, target);
      Native.setAttribute.call(el, 'data-zp-target-url', target);
      parkFrameSrc(el);
      return;
    }
    const usesRaw = usesRawURLAttribute(el, key, localKey);
    const alreadyMapped = urlMeta.get(el) === target && (!usesRaw ? Native.getAttribute.call(el, 'data-zp-target-url') === target : true);
    urlMeta.set(el, target);
    if (!usesRaw) Native.setAttribute.call(el, 'data-zp-target-url', target);
    if ((tag === 'iframe' || tag === 'frame') && localKey === 'src') {
      routeFrameSrc(el, key, target, false);
      instrumentIframe(el);
      return;
    }
    if (alreadyMapped) return;
    if (!usesRaw) setSubresourceAttribute(el, key, subresourceProxyPath(target));
  }
  // Rewrite CSS in <style> elements populated via child text nodes (such as appendChild(createTextNode(css))).
  function enforceStyleElementCSS(el) {
    if (!el || el.localName !== 'style') return;
    const get = Native.nodeTextContent && Native.nodeTextContent.get;
    const raw = (get ? get.call(el) : el.textContent) || '';
    if (!raw) return;
    const mapped = rewriteCSSText(raw);
    if (mapped === raw) return;
    try { el.textContent = mapped; } catch {}
  }
  // CSS the page puts into a <style> through the tree (`appendChild(createTextNode(css))`, `append(css)`, a style built elsewhere and then inserted) is parsed as it goes in, and its url()s are
  // fetched at the next style recalculation, which a layout read can bring forward of the MutationObserver: rewrite the text before it goes in. It is rewritten in place, so the page's text
  // node is still the node that is inserted (a library that later `removeChild`s it, as styled-components does, finds it) and a stylesheet built rule by rule is not re-read each time.
  function rewriteStyleTextNode(text) {
    const d = text.data;
    if (!d || (d.indexOf('(') < 0 && d.indexOf('@import') < 0)) return;
    const mapped = rewriteCSSText(d);
    if (mapped !== d) text.data = mapped;
  }
  function rewriteStyleChildren(style) {
    for (let c = style.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) rewriteStyleTextNode(c);
  }
  function rewriteStyleTextForInsertion(self, args) {
    try {
      const intoStyle = !!self && (self.localName === 'style' || (self.nodeType === 3 && !!self.parentNode && self.parentNode.localName === 'style'));
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (typeof a === 'string') { if (intoStyle) args[i] = rewriteCSSText(a); continue; }
        if (!a || typeof a !== 'object') continue;
        if (a.nodeType === 3) { if (intoStyle) rewriteStyleTextNode(a); }
        else if (a.nodeType === 1 && a.localName === 'style') rewriteStyleChildren(a);
        else if (a.nodeType === 11 && a.querySelectorAll) qsaOf(a, 'style').forEach(rewriteStyleChildren);
      }
    } catch {}
  }
  function enforceSubtreePolicies(node) {
    if (!node || typeof node !== 'object') return;
    if (node.nodeType === 3 && node.parentNode) enforceStyleElementCSS(node.parentNode);
    if (node.nodeType === 1) enforceElementPolicy(node);
    if (node.querySelectorAll) {
      qsaOf(node, 'script,link,iframe,frame,a,area,form,input,button,img,source,audio,video,track,object,embed,svg a,svg image,svg use').forEach(enforceElementPolicy);
      qsaOf(node, 'style').forEach(enforceStyleElementCSS);
    }
  }
  function enforceElementPolicy(el) {
    if (!el || !el.localName) return;
    if (el.localName === 'style') enforceStyleElementCSS(el);
    if (el.localName === 'script') instrumentScriptElement(el);
    if (el.localName === 'link') enforceLinkPolicy(el);
    if (el.localName === 'iframe' || el.localName === 'frame') instrumentIframe(el);
    if (Native.getAttributeNames) {
      for (const name of Native.getAttributeNames.call(el)) enforceObservedAttribute(el, String(name).toLowerCase());
    }
  }