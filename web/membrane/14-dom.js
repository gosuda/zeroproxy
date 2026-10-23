
  function installStealthMembrane(w) {
    if (!w || !w.Document || !w.Element) return;
    try { if (w[stealthMarker]) return; Object.defineProperty(w, stealthMarker, { value: true, enumerable: false, configurable: false }); } catch {}
    const docGetTags = w.Document.prototype.getElementsByTagName;
    const elemGetTags = w.Element.prototype.getElementsByTagName;
    if (typeof docGetTags === 'function') define(w.Document.prototype, 'getElementsByTagName', function(tag) {
      const raw = docGetTags.apply(this, arguments);
      return shouldFilterTag(tag) ? filteredCollection(raw, node => !isZPAssetNode(node)) : raw;
    });
    if (typeof elemGetTags === 'function') define(w.Element.prototype, 'getElementsByTagName', function(tag) {
      const raw = elemGetTags.apply(this, arguments);
      return shouldFilterTag(tag) ? filteredCollection(raw, node => !isZPAssetNode(node)) : raw;
    });
    const scriptsDesc = Object.getOwnPropertyDescriptor(w.Document.prototype, 'scripts') || Native.documentScripts;
    if (scriptsDesc && scriptsDesc.get) try { defineMasked(w.Document.prototype, 'scripts', { get() { return filteredCollection(scriptsDesc.get.call(this), node => !isZPAssetNode(node)); }, configurable: false }); } catch {}
    const docQS = w.Document.prototype.querySelector;
    const docQSA = w.Document.prototype.querySelectorAll;
    const elemQS = w.Element.prototype.querySelector;
    const elemQSA = w.Element.prototype.querySelectorAll;
    if (typeof docQS === 'function') define(w.Document.prototype, 'querySelector', function(sel) { return selectorTargetsZP(sel) ? null : filterSelectorOne(docQS.apply(this, arguments)); });
    if (typeof elemQS === 'function') define(w.Element.prototype, 'querySelector', function(sel) { return selectorTargetsZP(sel) ? null : filterSelectorOne(elemQS.apply(this, arguments)); });
    // Wrap a real NodeList from a detached element so empty querySelectorAll results still expose NodeList methods.
    let emptyList = null;
    const emptyNodeList = () => {
      if (!emptyList) {
        try { emptyList = Native.elementQuerySelectorAll.call(w.document.createElement('i'), '*'); }
        catch { emptyList = []; }
      }
      return emptyList;
    };
    if (typeof docQSA === 'function') define(w.Document.prototype, 'querySelectorAll', function(sel) { return selectorTargetsZP(sel) ? filteredCollection(emptyNodeList(), () => false) : filteredCollection(docQSA.apply(this, arguments), node => !isZPAssetNode(node)); });
    if (typeof elemQSA === 'function') define(w.Element.prototype, 'querySelectorAll', function(sel) { return selectorTargetsZP(sel) ? filteredCollection(emptyNodeList(), () => false) : filteredCollection(elemQSA.apply(this, arguments), node => !isZPAssetNode(node)); });
    const matches = w.Element.prototype.matches;
    const closest = w.Element.prototype.closest;
    if (typeof matches === 'function') define(w.Element.prototype, 'matches', function(sel) { return selectorTargetsZP(sel) ? false : matches.apply(this, arguments); });
    if (typeof closest === 'function') define(w.Element.prototype, 'closest', function(sel) { return selectorTargetsZP(sel) ? null : filterSelectorOne(closest.apply(this, arguments)); });
    const nodeIterator = w.Document.prototype.createNodeIterator;
    if (typeof nodeIterator === 'function') define(w.Document.prototype, 'createNodeIterator', function() { return filteredTraversal(nodeIterator.apply(this, arguments)); });
    const treeWalker = w.Document.prototype.createTreeWalker;
    if (typeof treeWalker === 'function') define(w.Document.prototype, 'createTreeWalker', function() { return filteredTraversal(treeWalker.apply(this, arguments)); });
  }
  function shouldFilterTag(tag) {
    const t = String(tag || '').toLowerCase();
    return t === '*' || t === 'script' || t === 'meta' || t === 'link';
  }
  function selectorTargetsZP(selector) {
    const s = String(selector || '').toLowerCase();
    return s.includes('data-zp-') || s.includes('#__zp-boot') || s.includes('/zp/assets/') || s.includes('x-zeroproxy-icon');
  }
  function filterSelectorOne(node) { return isZPAssetNode(node) ? null : node; }
  function filteredTraversal(raw) {
    return new Proxy(raw, {
      get(target, prop) {
        if (prop === 'nextNode' || prop === 'previousNode') return function() {
          let node;
          do { node = target[prop](); } while (node && isZPAssetNode(node));
          return node;
        };
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
      // Pass target as the receiver so native setters like TreeWalker.prototype.currentNode pass WebIDL brand checks.
      set(target, prop, value) { return Reflect.set(target, prop, value, target); }
    });
  }


  function installDOMHooks(w) {
    const inIframeRealm = (w !== root);
    const wtt = ttOfWindow(w);
    const transformHTMLOpts = inIframeRealm ? { inIframe: true } : undefined;
    // Enable SW-less subresource relay rewriting when document.write targets a document not controlled by the service worker.
    const writeOptsFor = doc => {
      let swLess = false;
      try { swLess = documentIsSWLess(doc); } catch {}
      if (!swLess) return transformHTMLOpts;
      return inIframeRealm ? { inIframe: true, swLess: true } : { swLess: true };
    };
    define(w.Element.prototype, 'setAttribute', function(k, v) {
      const key = String(k).toLowerCase();
      const colon = key.indexOf(':');
      const localKey = colon < 0 ? key : key.slice(colon + 1);
      const ln = this.localName;
      v = ttAttributeValue(this, key, v, 'setAttribute', wtt);
      if (isZPAttrName(key)) return undefined;
      if (localKey === 'ping' && (ln === 'a' || ln === 'area')) {
        try { Native.setAttribute.call(this, 'data-zp-blocked-ping', String(v)); } catch {}
        try { Native.removeAttribute.call(this, 'ping'); } catch {}
        return;
      }
      if (ln === 'meta' && localKey === 'http-equiv' && isCSPHttpEquiv(v)) return neutralizeCSPMeta(this, v);
      // Rewrite meta refresh URLs synchronously regardless of the order http-equiv and content are set.
      if (ln === 'meta' && localKey === 'http-equiv' && String(v).trim().toLowerCase() === 'refresh') {
        const cur = Native.getAttribute.call(this, 'content');
        if (cur != null) { const next = proxiedRefreshContent(cur); if (next) Native.setAttribute.call(this, 'content', next); }
        return Native.setAttribute.call(this, k, v);
      }
      if (ln === 'meta' && localKey === 'content' && String(Native.getAttribute.call(this, 'http-equiv') || '').trim().toLowerCase() === 'refresh') {
        const next = proxiedRefreshContent(v);
        return Native.setAttribute.call(this, k, next || v);
      }
      // Re-run CSP meta neutralization synchronously when content is set after http-equiv.
      if (ln === 'meta' && localKey === 'content') {
        const eqLive = String(Native.getAttribute.call(this, 'http-equiv') || '').trim().toLowerCase();
        const eqStash = String(Native.getAttribute.call(this, 'data-zp-blocked-http-equiv') || '').trim().toLowerCase();
        const cspEq = isCSPHttpEquiv(eqLive) ? eqLive : isCSPHttpEquiv(eqStash) ? eqStash : '';
        if (cspEq) {
          try { Native.setAttribute.call(this, k, v); } catch {}
          neutralizeCSPMeta(this, cspEq);
          return;
        }
      }
      if (key === 'integrity' && isIntegrityBearing(this)) return setBackedIntegrity(this, v);
      if (localKey === 'sandbox' && isFrameElement(this)) return setFrameSandboxAttribute(this, v);
      if (ln === 'link' && localKey === 'rel') {
        const value = String(v);
        if (isBlockedLinkRelValue(value)) return suppressBlockedLinkRel(this, value);
        if (Native.removeAttribute) Native.removeAttribute.call(this, 'data-zp-blocked-rel');
        const ret = Native.setAttribute.call(this, k, v);
        enforceLinkPolicy(this);
        return ret;
      }
      if (ln === 'link' && localKey === 'href' && (isBlockedLink(this) || hasSuppressedBlockedLinkRel(this))) return blockLinkURL(this, v);
      if (ln === 'link' && localKey === 'href' && isIconLink(this)) return suppressIconLinkHref(this, v);
      if (key.startsWith('on') && key.length > 2) return Native.setAttribute.call(this, k, rewriteEventAttribute(String(v)));
      if (ln === 'base' && localKey === 'href') {
        updateVirtualBase(v);
        return Native.setAttribute.call(this, k, v);
      }
      if (ln === 'script' && (localKey === 'src' || localKey === 'href')) return setScriptSource(this, v);
      if (localKey === 'style' && v != null) { litSet(this, 'style', v); return Native.setAttribute.call(this, k, rewriteCSSText(v)); }
      // srcdoc is on the URL surface list for the parser path, but its value is markup: resolving it as a URL would make the frame's document the proxy address.
      if ((ln === 'iframe' || ln === 'frame') && localKey === 'srcdoc') { setInjectedSrcdoc(this, v); return undefined; }
      if (isURLBearing(this, key, localKey, ln)) {
        if (localKey === 'srcset' || localKey === 'imagesrcset') {
          litSet(this, localKey, v == null ? '' : v);
          Native.setAttribute.call(this, k, v == null ? '' : String(v));
          enforceSrcsetAttribute(this, k, String(v == null ? '' : v));
          return;
        }
        // Leave same-document fragment URLs (#, #tab) untouched so native anchor and click handlers work without navigation rewriting.
        const rawURLValue = v == null ? '' : String(v);
        if (rawURLValue.charCodeAt(0) === 35 /* '#' */) {
          urlMeta.delete(this);
          litDel(this, localKey);
          if (Native.removeAttribute) { try { Native.removeAttribute.call(this, 'data-zp-target-url'); } catch {} }
          return Native.setAttribute.call(this, k, rawURLValue);
        }
        if (shouldBlockURLAttribute(this, localKey, v, localKey, ln) || hasContextBlockedScheme(this, v)) return blockExecutableURL(this, localKey, v);
        const t = targetURLForElement(this, v);
        if (t) {
          const usesRaw = usesRawURLAttribute(this, key, localKey);
          urlMeta.set(this, t);
          litSet(this, localKey, rawURLValue);
          // Stash the absolute target URL on data-zp-target-url and write a proxy ?via= URL on navigation attributes.
          Native.setAttribute.call(this, 'data-zp-target-url', t);
          if ((ln === 'iframe' || ln === 'frame') && localKey === 'src') {
            routeFrameSrc(this, k, t, true);
            return;
          }
          if (ln === 'link' && localKey === 'href' && isIconLink(this)) return suppressIconLinkHref(this, t);
          if (usesRaw) return Native.setAttribute.call(this, k, proxyViaURL(t));
          return setSubresourceAttribute(this, k, subresourceProxyPath(t));
        }
        // Clear stashed target metadata when a frame navigates to a non-HTTP URL such as about:blank.
        if ((ln === 'iframe' || ln === 'frame') && localKey === 'src') {
          cancelFrameRoute(this);
          urlMeta.delete(this);
          litDel(this, localKey);
          if (Native.removeAttribute) { try { Native.removeAttribute.call(this, 'data-zp-target-url'); } catch {} }
        }
      }
      return Native.setAttribute.call(this, k, v);
    });
    if (Native.setAttributeNS) define(w.Element.prototype, 'setAttributeNS', function(ns, k, v) {
      const key = String(k).toLowerCase();
      const colon = key.indexOf(':');
      const localKey = colon < 0 ? key : key.slice(colon + 1);
      const ln = this.localName;
      v = ttAttributeValue(this, key, v, 'setAttributeNS', wtt);
      // Delegate null-namespace lowercase attribute writes to setAttribute so all policy and URL hooks apply uniformly.
      if ((ns === null || ns === undefined || ns === '') && String(k) === key) {
        return this.setAttribute(k, v);
      }
      if (key === 'integrity' && isIntegrityBearing(this)) return setBackedIntegrity(this, v);
      if (localKey === 'sandbox' && isFrameElement(this)) return setFrameSandboxAttribute(this, v);
      if (ln === 'script' && (localKey === 'src' || localKey === 'href')) return setScriptSource(this, v);
      if (ln === 'link' && localKey === 'href' && isIconLink(this)) return suppressIconLinkHref(this, v);
      if (isURLBearing(this, key, localKey, ln)) {
        if (shouldBlockURLAttribute(this, localKey, v, localKey, ln)) return blockExecutableURL(this, localKey, v);
        const t = targetURLForElement(this, v);
        if (t) {
          const usesRaw = usesRawURLAttribute(this, key, localKey);
          urlMeta.set(this, t);
          litSet(this, localKey, v);
          Native.setAttribute.call(this, 'data-zp-target-url', t);
          return Native.setAttributeNS.call(this, ns, k, usesRaw ? proxyViaURL(t) : subresourceProxyPath(t));
        }
      }
      return Native.setAttributeNS.call(this, ns, k, key.startsWith('on') && key.length > 2 ? rewriteEventAttribute(String(v)) : v);
    });
    if (Native.namedSetNamedItem && w.NamedNodeMap) define(w.NamedNodeMap.prototype, 'setNamedItem', function(attr) {
      const owner = namedNodeMapOwners.get(this);
      return owner ? attachAttributeNode(owner, attr, false) : Native.namedSetNamedItem.call(this, attr);
    });
    if (Native.namedSetNamedItemNS && w.NamedNodeMap) define(w.NamedNodeMap.prototype, 'setNamedItemNS', function(attr) {
      const owner = namedNodeMapOwners.get(this);
      return owner ? attachAttributeNode(owner, attr, true) : Native.namedSetNamedItemNS.call(this, attr);
    });
    if (Native.attrValue && Native.attrValue.set && w.Attr) try { defineMasked(w.Attr.prototype, 'value', {
      get() {
        const owner = this.ownerElement;
        if (!owner) return Native.attrValue.get.call(this);
        return this.namespaceURI ? owner.getAttributeNS(this.namespaceURI, this.localName) : owner.getAttribute(this.name);
      },
      set(v) {
        const owner = this.ownerElement;
        if (!owner) return Native.attrValue.set.call(this, v);
        if (this.namespaceURI) return owner.setAttributeNS(this.namespaceURI, this.name, v);
        return owner.setAttribute(this.name, v);
      },
      configurable: false
    }); } catch {}
    // Return stashed ping attribute values across read surfaces while keeping native browser ping requests disabled.
    const blockedPing = el => {
      const ln = el && el.localName;
      return ln === 'a' || ln === 'area' ? Native.getAttribute.call(el, 'data-zp-blocked-ping') : null;
    };
    define(w.Element.prototype, 'getAttribute', function(k) {
      const key = String(k).toLowerCase();
      if (isZPAttrName(key)) return null;
      if (key === 'ping') { const p = blockedPing(this); if (p !== null) return p; }
      if (key === 'integrity' && isIntegrityBearing(this)) {
        const backed = backedIntegrity(this);
        return backed !== null ? backed : Native.getAttribute.call(this, k);
      }
      if (key === 'sandbox' && isFrameElement(this) && frameSandboxMeta.has(this)) return frameSandboxMeta.get(this);
      const colon = key.indexOf(':');
      const localKey = colon < 0 ? key : key.slice(colon + 1);
      const ln = this.localName;
      if ((ln === 'iframe' || ln === 'frame') && localKey === 'srcdoc' && srcdocMeta.has(this)) return srcdocMeta.get(this);
      if (localKey === 'src' && (ln === 'iframe' || ln === 'frame')) {
        const parked = Native.getAttribute.call(this, 'data-zp-frame-src');
        if (parked !== null) return parked;
      }
      const raw = Native.getAttribute.call(this, k);
      if (raw === null || raw === '') return raw;
      // Return the author's original literal attribute text when stashed by runtime writes or server HTML rewriting.
      if (localKey === 'style' || localKey === 'srcset' || localKey === 'imagesrcset'
          || isURLBearing(this, key, localKey, ln) || (ln === 'script' && localKey === 'src')) {
        const lit = litGet(this, localKey);
        if (lit !== undefined) return lit;
        const stashed = Native.getAttribute.call(this, litAttrName(key)) ?? Native.getAttribute.call(this, litAttrName(localKey));
        if (stashed !== null) return stashed;
      }
      if (localKey === 'style') return deproxyURL(raw, { scan: true });
      if (localKey === 'srcset' || localKey === 'imagesrcset') {
        const recalled = recalledSrcset(this, key);
        return deproxyURL(recalled !== undefined ? recalled : raw, { scan: true });
      }
      if (ln === 'script' && localKey === 'src') {
        const stashed = urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url');
        if (stashed) return stashed;
        return deproxyURL(raw, { scan: true });
      }
      if (isURLBearing(this, key, localKey, ln)) return urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url') || deproxyURL(raw, { scan: true });
      return raw;
    });
    if (Native.hasAttribute) define(w.Element.prototype, 'hasAttribute', function(k) {
      const key = String(k).toLowerCase();
      if (isZPAttrName(key)) return false;
      if (key === 'integrity' && isIntegrityBearing(this)) return backedIntegrity(this) !== null || Native.hasAttribute.call(this, k);
      if (key === 'sandbox' && isFrameElement(this) && frameSandboxMeta.has(this)) return true;
      if (key === 'ping' && blockedPing(this) !== null) return true;
      return Native.hasAttribute.call(this, k);
    });
    if (Native.removeAttribute) define(w.Element.prototype, 'removeAttribute', function(k) {
      const key = String(k).toLowerCase();
      const colon = key.indexOf(':');
      const localKey = colon < 0 ? key : key.slice(colon + 1);
      const ln = this.localName;
      if (isZPAttrName(key)) return undefined;
      if (key === 'integrity' && isIntegrityBearing(this)) {
        Native.removeAttribute.call(this, integrityBackupAttr);
        return Native.removeAttribute.call(this, k);
      }
      if (localKey === 'sandbox' && isFrameElement(this)) { frameSandboxMeta.delete(this); sandboxShadows.delete(this); clearFrameOpaque(this); }
      if (key === 'ping' && (ln === 'a' || ln === 'area')) Native.removeAttribute.call(this, 'data-zp-blocked-ping');
      if (ln === 'link' && localKey === 'href' && isIconLink(this)) {
        urlMeta.delete(this);
        if (Native.removeAttribute) Native.removeAttribute.call(this, 'data-zp-target-url');
        return Native.removeAttribute.call(this, k);
      }
      if (ln === 'link' && localKey === 'rel') {
        const ret = Native.removeAttribute.call(this, k);
        enforceLinkPolicy(this);
        return ret;
      }
      litDel(this, localKey);
      urlMeta.delete(this);
      try { Native.removeAttribute.call(this, litAttrName(key)); } catch {}
      try { Native.removeAttribute.call(this, litAttrName(localKey)); } catch {}
      return Native.removeAttribute.call(this, k);
    });
    if (Native.getAttributeNames) define(w.Element.prototype, 'getAttributeNames', function() {
      const names = Native.getAttributeNames.call(this).filter(name => !isZPAttrName(name));
      if (isIntegrityBearing(this) && backedIntegrity(this) !== null && !names.some(name => String(name).toLowerCase() === 'integrity')) names.push('integrity');
      if (isFrameElement(this) && frameSandboxMeta.has(this) && !names.some(name => String(name).toLowerCase() === 'sandbox')) names.push('sandbox');
      if (blockedPing(this) !== null && !names.some(name => String(name).toLowerCase() === 'ping')) names.push('ping');
      return names;
    });
    if (Native.elementAttributes && Native.elementAttributes.get) try { defineMasked(w.Element.prototype, 'attributes', { get() { return filteredNamedNodeMap(Native.elementAttributes.get.call(this), this); }, configurable: false }); } catch {}
    installZPAttrNamespace(w);
    installIntegrityProp(w.HTMLScriptElement && w.HTMLScriptElement.prototype);
    installIntegrityProp(w.HTMLLinkElement && w.HTMLLinkElement.prototype);
    installScriptProp(w.HTMLScriptElement && w.HTMLScriptElement.prototype);
    installScriptTextProps(w);
    installStyleHooks(w);
    installLinkProp(w.HTMLLinkElement && w.HTMLLinkElement.prototype);
    // Elements whose content is parsed as raw text or RCDATA rather than markup during fragment parsing.
    const RAW_TEXT_CONTEXTS = newSet(['script', 'textarea', 'title', 'xmp', 'plaintext', 'noembed', 'noframes', 'noscript']);
    patchHTMLSetter(w.Element.prototype, 'innerHTML');
    patchHTMLSetter(w.Element.prototype, 'outerHTML');
    // Scrub serialized markup at the string level for roots that cannot be cloned (such as ShadowRoot).
    const scrubSerialized = out => {
      if (typeof out !== 'string') return out;
      const withLiterals = out.indexOf('data-zp-lit-') < 0 ? out
        : out.replace(/<([a-zA-Z][^\s/>]*)((?:\s+[^\s"'>/=]+(?:="[^"]*")?)*)(\s*\/?)>/g, (tag, name, attrs, tail) => {
          if (attrs.indexOf('data-zp-lit-') < 0) return tag;
          const lits = Object.create(null);
          attrs.replace(/\sdata-zp-lit-([^\s"'>/=]+)="([^"]*)"/g, (_, n, v) => { lits[n.toLowerCase()] = v; return ''; });
          const next = attrs.replace(/(\s)([^\s"'>/=]+)="([^"]*)"/g, (m, sp, n, v) => {
            const key = n.toLowerCase();
            return key.indexOf('data-zp-') !== 0 && key in lits ? sp + n + '="' + lits[key] + '"' : m;
          });
          return '<' + name + next + tail + '>';
        });
      return deproxyURL(withLiterals.replace(/\sdata-zp-[a-z-]+(?::[a-z-]+)?="[^"]*"/g, ''), { scan: true, fallback: 'share' });
    };
    if (w.ShadowRoot && w.ShadowRoot.prototype) {
      patchHTMLSetter(w.ShadowRoot.prototype, 'innerHTML');
      if (typeof w.ShadowRoot.prototype.setHTMLUnsafe === 'function') {
        const nativeSetHTML = w.ShadowRoot.prototype.setHTMLUnsafe;
        define(w.ShadowRoot.prototype, 'setHTMLUnsafe', function(html) {
          const markup = transformHTML(String(ttCompliant('HTML', 'ShadowRoot setHTMLUnsafe', html, '', wtt)), transformHTMLOpts);
          const ret = nativeSetHTML.call(this, ttHTML(markup));
          if (markupHasFrames(markup)) restoreParkedFrames(this);
          return ret;
        });
      }
      if (typeof w.ShadowRoot.prototype.getHTML === 'function') {
        const nativeGetHTML = w.ShadowRoot.prototype.getHTML;
        define(w.ShadowRoot.prototype, 'getHTML', function(opts) {
          return scrubSerialized(nativeGetHTML.call(this, opts));
        });
      }
    }
    if (typeof w.Element.prototype.setHTMLUnsafe === 'function') {
      const nativeElSetHTML = w.Element.prototype.setHTMLUnsafe;
      define(w.Element.prototype, 'setHTMLUnsafe', function(html) {
        const markup = transformHTML(String(ttCompliant('HTML', 'Element setHTMLUnsafe', html, '', wtt)), transformHTMLOpts);
        const ret = nativeElSetHTML.call(this, ttHTML(markup));
        if (markupHasFrames(markup)) restoreParkedFrames(this);
        return ret;
      });
    }
    // Transform markup before passing it to Sanitizer API methods (setHTML / parseHTMLUnsafe).
    if (typeof w.Element.prototype.setHTML === 'function') {
      const nativeElSetHTML = w.Element.prototype.setHTML;
      define(w.Element.prototype, 'setHTML', function(html, opts) {
        const markup = transformHTML(String(html), transformHTMLOpts);
        const ret = nativeElSetHTML.call(this, markup, opts);
        if (markupHasFrames(markup)) restoreParkedFrames(this);
        return ret;
      });
    }
    if (typeof w.ShadowRoot !== 'undefined' && w.ShadowRoot.prototype && typeof w.ShadowRoot.prototype.setHTML === 'function') {
      const nativeShadowSetHTML = w.ShadowRoot.prototype.setHTML;
      define(w.ShadowRoot.prototype, 'setHTML', function(html, opts) {
        const markup = transformHTML(String(html), transformHTMLOpts);
        const ret = nativeShadowSetHTML.call(this, markup, opts);
        if (markupHasFrames(markup)) restoreParkedFrames(this);
        return ret;
      });
    }
    if (typeof w.Document.parseHTMLUnsafe === 'function') {
      const nativeParseUnsafe = w.Document.parseHTMLUnsafe;
      define(w.Document, 'parseHTMLUnsafe', function(html) {
        return nativeParseUnsafe.call(w.Document, ttHTML(transformHTML(String(ttCompliant('HTML', 'Document parseHTMLUnsafe', html, '', wtt)), Object.assign({}, transformHTMLOpts, { document: true }))));
      });
    }
    // Scrub getHTML and getHTMLUnsafe via an inert clone when shadow roots are not requested, or at the string level otherwise.
    for (const [proto, m] of [[w.Element && w.Element.prototype, 'getHTML'], [w.Element && w.Element.prototype, 'getHTMLUnsafe'], [w.ShadowRoot && w.ShadowRoot.prototype, 'getHTMLUnsafe']]) {
      if (!proto || typeof proto[m] !== 'function') continue;
      const nativeGet = proto[m];
      define(proto, m, function(opts) {
        const wantsShadow = !!opts && typeof opts === 'object'
          && (opts.serializableShadowRoots || (opts.shadowRoots && opts.shadowRoots.length));
        if (!wantsShadow && this && this.nodeType === 1) {
          const clone = scrubbedClone(this);
          if (clone) return nativeGet.call(clone, opts);
        }
        return scrubSerialized(nativeGet.call(this, opts));
      });
    }
    if (w.XMLSerializer && w.XMLSerializer.prototype && typeof w.XMLSerializer.prototype.serializeToString === 'function') {
      const nativeSerialize = w.XMLSerializer.prototype.serializeToString;
      define(w.XMLSerializer.prototype, 'serializeToString', function(node) {
        const clone = node && typeof node.cloneNode === 'function' ? scrubbedClone(node) : null;
        return nativeSerialize.call(this, clone || node);
      });
    }
    define(w.Element.prototype, 'insertAdjacentHTML', function(pos, html) {
      const markup = transformHTML(String(ttCompliant('HTML', 'Element insertAdjacentHTML', html, '', wtt)), transformHTMLOpts);
      const ret = Native.insertAdjacentHTML.call(this, pos, markup);
      syncBaseElement(this); enforceSubtreePolicies(this);
      if (markupHasFrames(markup)) {
        // beforebegin and afterend insert siblings on parentNode rather than children of this element.
        const holder = /^(beforebegin|afterend)$/i.test(String(pos)) ? this.parentNode : this;
        restoreParkedFrames(holder);
        instrumentDescendantIframes(holder);
      }
      return ret;
    });
    // Hook write and writeln on Document.prototype so all Document instances in this realm rewrite written markup.
    if (w.Document && w.Document.prototype) {
      const docProto = w.Document.prototype;
      if (docProto.write) {
        const protoWrite = docProto.write;
        define(docProto, 'write', function(...parts) {
          const html = parts.map(p => transformWrittenHTML(String(ttCompliant('HTML', 'Document write', p, '', wtt)), writeOptsFor(this))).join('');
          if (deferredScriptDepth > 0 && documentIsClosed(this)) return appendWrittenHTML(this, html);
          const ret = protoWrite.apply(this, [ttHTML(html)]);
          if (html.indexOf('data-zp-frame-src') !== -1) restoreParkedFrames(this);
          return ret;
        });
      }
      if (docProto.writeln) {
        const protoWriteln = docProto.writeln;
        define(docProto, 'writeln', function(...parts) {
          const html = parts.map(p => transformWrittenHTML(String(ttCompliant('HTML', 'Document writeln', p, '', wtt)), writeOptsFor(this))).join('') + '\n';
          if (deferredScriptDepth > 0 && documentIsClosed(this)) return appendWrittenHTML(this, html);
          const ret = protoWriteln.apply(this, [ttHTML(html)]);
          if (html.indexOf('data-zp-frame-src') !== -1) restoreParkedFrames(this);
          return ret;
        });
      }
    }
    installBaseObserver(w.document || document);
    function patchHTMLSetter(proto, prop) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) return;
      const sink = (w.ShadowRoot && proto === w.ShadowRoot.prototype ? 'ShadowRoot ' : 'Element ') + prop;
      try {
        defineMasked(proto, prop, {
          get() {
            // Handle <style>.innerHTML on Element.prototype rather than defining an extra own property on HTMLStyleElement.prototype.
            if (prop === 'innerHTML' && this && this.localName === 'style') {
              return d.get ? originalStyleText(this, d.get.call(this)) : '';
            }
            if (this && this.nodeType === 11) {
              const out = d.get ? String(d.get.call(this)) : '';
              return deproxyURL(out.replace(/\sdata-zp-[a-z-]+="[^"]*"/g, ''), { scan: true, fallback: 'share' });
            }
            return d.get ? sanitizeSerializedNode(this, prop === 'outerHTML') : '';
          },
          set(v) {
            // innerHTML and outerHTML take null as the empty string; a Trusted value or, in a document that enforces, the default policy decides the rest.
            v = ttCompliant('HTML', sink, v === null ? '' : v, '', wtt);
            if (this && this.localName === 'template' && prop === 'innerHTML') {
              d.set.call(this, ttHTML(String(v)));
              enforceSubtreePolicies(this.content);
              instrumentDescendantIframes(this.content);
              return;
            }
            if (prop === 'innerHTML' && this && this.localName === 'style') {
              originalTextMeta.set(this, String(v == null ? '' : v));
              d.set.call(this, ttHTML(rewriteCSSText(v)));
              return;
            }
            // Do not run HTML markup transformation on raw-text elements (such as <script> or <textarea>) whose content is a single text node.
            if (prop === 'innerHTML' && this && RAW_TEXT_CONTEXTS.has(this.localName)) {
              d.set.call(this, ttHTML(String(v)));
              return;
            }
            const holder = prop === 'outerHTML' ? this.parentNode : this;
            const markup = transformHTML(String(v), transformHTMLOpts);
            d.set.call(this, ttHTML(markup));
            if (markupHasFrames(markup)) restoreParkedFrames(holder);
            syncBaseElement(this);
            instrumentDescendantIframes(this);
            enforceSubtreePolicies(this);
          },
          configurable: false
        });
      } catch {}
    }
  }