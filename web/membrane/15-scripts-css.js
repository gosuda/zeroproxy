  function installIntegrityProp(proto) {
    if (!proto) return;
    defineAccessor(proto, 'integrity', function() {
      const backed = backedIntegrity(this);
      return backed !== null ? backed : Native.getAttribute.call(this, 'integrity') || '';
    }, function(v) {
      setBackedIntegrity(this, v);
    });
  }
  function propertyDescriptor(proto, prop) {
    for (let p = proto; p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, prop);
      if (d) return d;
    }
    return null;
  }
  function executableScriptKindForElement(el) {
    const t = String(Native.getAttribute.call(el, 'type') || '').trim().toLowerCase();
    if (t === 'module') return 'module';
    if (t === '' || t === 'text/javascript' || t === 'application/javascript' || t === 'application/ecmascript' || t === 'text/ecmascript') return 'classic';
    return '';
  }
  function scriptProxyPath(target, kind) {
    // Emit proxy-origin-absolute URLs so dynamic scripts do not resolve against the virtual target baseURI.
    // Classic scripts include `ref` so the service worker sends the current virtual URL as Referer even after synchronous history.replaceState.
    // Module scripts omit `ref` so static and dynamic imports share a canonical module map URL.
    const whose = (srcdocMarkupDepth || (boot && boot.proxyOrigin)) ? '&tab=' + nativeEncodeURIComponent(boot.tabId || '') + '&entry=' + nativeEncodeURIComponent(activeEntryId || '') : '';
    if (kind === 'module') return proxyOrigin + ZP.apiPath('script') + '?u=' + nativeEncodeURIComponent(target) + '&kind=module' + whose;
    return proxyOrigin + ZP.apiPath('script') + '?kind=' + nativeEncodeURIComponent(kind) + '&u=' + nativeEncodeURIComponent(target) + '&ref=' + nativeEncodeURIComponent(virtualURL.href) + whose;
  }
  // Align the `kind` parameter of a proxied script URL with the element's current `type` attribute at preparation time.
  function withCurrentKind(value, kind) {
    if (!kind) return value;
    try {
      const u = new URL(value, proxyOrigin);
      if (u.pathname !== ZP.apiPath('script')) return value;
      const target = u.searchParams.get('u');
      if (!target || (u.searchParams.get('kind') || 'classic') === kind) return value;
      return scriptProxyPath(target, kind);
    } catch { return value; }
  }
  // Update the `ref` parameter of a proxied script URL to the current virtual document URL.
  function withCurrentRef(value) {
    try {
      const s = String(value);
      if (s.indexOf(ZP.apiPath('script')) < 0 || s.indexOf('ref=') < 0) return s;
      const u = new URL(s, proxyOrigin);
      u.searchParams.set('ref', virtualURL.href);
      return u.href;
    } catch { return String(value); }
  }
  // Route classic scripts in SW-less frames through the synchronous relay so they do not bypass the service worker.
  function swLessScriptURL(el, target, kind) {
    if (!target || kind === 'module') return '';
    let doc = null;
    try { doc = el.ownerDocument; } catch {}
    if (!doc || !doc.defaultView || !documentIsSWLess(doc)) return '';
    // Reuse an existing relay URL for the same target to avoid triggering an infinite MutationObserver loop.
    const current = Native.getAttribute.call(el, 'src');
    if (current && relayTargetOf(current) === target) return current;
    return swLessRelayURL(target, 'script', swLessCORSMode(el));
  }
  function setScriptSource(el, raw) {
    try { zpTrace('scriptSrc', String(raw).slice(0,140)); } catch {}
    const kind = executableScriptKindForElement(el);
    const value = unleakedTargetRaw(raw) === null ? virtualURL.href : String(raw);
    const trimmed = value.trim();
    if (trimmed.startsWith(ZP.CONTROL_PREFIX) || trimmed.startsWith(proxyOrigin + ZP.CONTROL_PREFIX)) {
      const refreshed = withCurrentRef(withCurrentKind(value, kind));
      // Recover and stash the underlying target URL when a pre-rewritten proxy script URL is assigned.
      const recovered = deproxyURL(refreshed, {});
      if (recovered && recovered !== refreshed) {
        urlMeta.set(el, recovered);
        Native.setAttribute.call(el, 'data-zp-target-url', recovered);
      }
      if (refreshed.indexOf(ZP.apiPath('sync-fetch')) >= 0) return;
      const finalSrc = swLessScriptURL(el, recovered, kind) || refreshed;
      if (Native.getAttribute.call(el, 'src') === finalSrc) return;
      return Native.setAttribute.call(el, 'src', finalSrc);
    }
    if (!kind) {
      urlMeta.delete(el);
      return Native.setAttribute.call(el, 'src', value);
    }
    if (hasExecutableURLScheme(value)) return blockExecutableURL(el, 'src', value);
    const target = targetURLForElement(el, value);
    if (!target) return blockExecutableURL(el, 'src', value);
    urlMeta.set(el, target);
    litSet(el, 'src', raw);
    Native.setAttribute.call(el, 'data-zp-target-url', target);
    const finalSrc = swLessScriptURL(el, target, kind) || scriptProxyPath(target, kind);
    // Skip redundant attribute writes to avoid emitting extra MutationObserver records.
    if (Native.getAttribute.call(el, 'src') === finalSrc) return;
    return Native.setAttribute.call(el, 'src', finalSrc);
  }
  // Rewrite only absolute http(s) URLs in runtime CSS; relative URLs resolve against the proxy origin and are routed by the service worker.
  function cssProxyURL(raw) {
    const t = String(raw == null ? '' : raw).trim();
    if (!/^https?:\/\//i.test(t)) return null;
    if (t.startsWith(proxyOrigin)) return null;
    return subresourceProxyPath(t);
  }
  // Tokenize CSS so url(), @import, and image-set() are rewritten without altering string literals such as content: "url(...)".
  function rewriteCSSText(input) {
    const s = String(input == null ? '' : input);
    if (s.indexOf('(') < 0 && s.indexOf('@import') < 0) return s;
    const isIdentChar = (ch) => ch !== undefined && /[A-Za-z0-9_$-]/.test(ch);
    const n = s.length;
    let out = '';
    let i = 0;
    let pendingImport = false;
    let imageSetDepth = 0;
    while (i < n) {
      const c = s[i];
      if (c === '/' && s[i + 1] === '*') {
        const e = s.indexOf('*/', i + 2);
        const stop = e < 0 ? n : e + 2;
        out += s.slice(i, stop);
        i = stop;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n) {
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] === c) break;
          j++;
        }
        const mapped = (pendingImport || imageSetDepth > 0) ? cssProxyURL(s.slice(i + 1, Math.min(j, n))) : null;
        out += mapped ? c + mapped + c : s.slice(i, Math.min(j + 1, n));
        i = Math.min(j + 1, n);
        pendingImport = false;
        continue;
      }
      if ((c === 'u' || c === 'U') && !isIdentChar(s[i - 1]) && /^url\(/i.test(s.slice(i, i + 4))) {
        let j = i + 4;
        while (j < n && /\s/.test(s[j])) j++;
        const q = s[j] === '"' || s[j] === "'" ? s[j] : '';
        let k = q ? j + 1 : j;
        while (k < n) {
          if (s[k] === '\\') { k += 2; continue; }
          if (q ? s[k] === q : s[k] === ')') break;
          k++;
        }
        const close = s.indexOf(')', k);
        const stop = close < 0 ? n : close + 1;
        const mapped = cssProxyURL(s.slice(q ? j + 1 : j, k));
        // Quote rewritten proxy URLs because query strings contain characters invalid in unquoted url() tokens.
        out += mapped ? 'url(' + (q || '"') + mapped + (q || '"') + ')' : s.slice(i, stop);
        i = stop;
        pendingImport = false;
        continue;
      }
      if ((c === 'i' || c === 'I' || c === '-') && !isIdentChar(s[i - 1])) {
        const m = /^(-webkit-)?image-set\(/i.exec(s.slice(i, i + 18));
        if (m) {
          out += s.slice(i, i + m[0].length);
          i += m[0].length;
          imageSetDepth = 1;
          continue;
        }
      }
      if (imageSetDepth > 0) {
        if (c === '(') imageSetDepth++;
        else if (c === ')') imageSetDepth--;
      }
      if (c === '@' && /^@import\b/i.test(s.slice(i, i + 8))) {
        out += s.slice(i, i + 7);
        i += 7;
        pendingImport = true;
        continue;
      }
      if (!/\s/.test(c)) pendingImport = false;
      out += c;
      i++;
    }
    return out;
  }
  // Declare styleHookState with var because installStyleHooks runs before this point during boot initialization.
  var styleHookState = 'not-run';
  const styleDeclProxies = newWeakMap();
  const styleDeclMethods = newWeakMap();
  function containStyleDeclaration(decl) {
    if (!decl || typeof decl !== 'object') return decl;
    const cached = styleDeclProxies.get(decl);
    if (cached) return cached;
    let proxy;
    try {
      proxy = new Proxy(decl, {
        get(t, k) {
          const v = Reflect.get(t, k);
          // Deproxy CSS property values on read-back; Blink exposes CSS properties as own data properties on the instance.
          if (typeof v === 'string') return deproxyURL(v, { scan: true });
          if (typeof v !== 'function') return v;
          // Bind and cache methods against the underlying CSSStyleDeclaration so WebIDL brand checks and function identity hold.
          let per = styleDeclMethods.get(t);
          if (!per) { per = newMap(); styleDeclMethods.set(t, per); }
          let bound = per.get(k);
          if (!bound) {
            bound = k === 'setProperty'
              ? function (p, val, pr) { return v.call(t, p, rewriteCSSText(val), pr); }
              : k === 'getPropertyValue'
                ? function (p) { return deproxyURL(v.call(t, p), { scan: true }); }
                : v.bind(t);
            maskNativeFunction(bound, k);
            per.set(k, bound);
          }
          return bound;
        },
        set(t, k, v) {
          try { t[k] = typeof v === 'string' ? rewriteCSSText(v) : v; } catch { return false; }
          return true;
        }
      });
    } catch { return decl; }
    styleDeclProxies.set(decl, proxy);
    return proxy;
  }
  // Wrap the own `style` accessor on every WebIDL interface prototype in the realm.
  function containEveryStyleAccessor(w) {
    let count = 0;
    let names = null;
    try { names = Object.getOwnPropertyNames(w); } catch { return 0; }
    for (const name of names) {
      const c0 = name.charCodeAt(0);
      if (c0 < 65 || c0 > 90) continue;
      let proto = null;
      try {
        const iface = w[name];
        if (typeof iface !== 'function') continue;
        proto = iface.prototype;
      } catch { continue; }
      if (!proto || typeof proto !== 'object') continue;
      // Only wrap own `style` descriptors so subclasses continue to inherit rather than gaining extra own properties.
      const sd = Object.getOwnPropertyDescriptor(proto, 'style');
      if (!sd || !sd.get) continue;
      try {
        defineMasked(proto, 'style', {
          get() { return containStyleDeclaration(sd.get.call(this)); },
          set: sd.set ? function (v) { return sd.set.call(this, rewriteCSSText(v)); } : undefined,
          enumerable: sd.enumerable,
          configurable: false
        });
        count++;
      } catch {}
    }
    return count;
  }
  // Hook CSS Typed OM (StylePropertyMapReadOnly and StylePropertyMap) so url() values are rewritten on write and deproxied on read.
  function installTypedOM(w) {
    const RO = w.StylePropertyMapReadOnly && w.StylePropertyMapReadOnly.prototype;
    if (!RO) return 0;
    const SM = w.StylePropertyMap && w.StylePropertyMap.prototype;
    const CSV = w.CSSStyleValue;
    const canParse = CSV && typeof CSV.parse === 'function';
    let hooked = 0;

    const back = (prop, v) => {
      if (!v || typeof v !== 'object' || !canParse) return v;
      let text;
      try { text = String(v); } catch { return v; }
      const fixed = deproxyURL(text, { scan: true });
      if (fixed === text) return v;
      try { return CSV.parse(String(prop), fixed); } catch { return v; }
    };
    const backAll = (prop, list) => {
      if (!list || typeof list.length !== 'number') return list;
      let changed = false;
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const next = back(prop, list[i]);
        if (next !== list[i]) changed = true;
        out.push(next);
      }
      return changed ? out : list;
    };
    const fwd = (prop, v) => {
      if (typeof v === 'string') return rewriteCSSText(v);
      if (!v || typeof v !== 'object' || !canParse) return v;
      let text;
      try { text = String(v); } catch { return v; }
      const rewritten = rewriteCSSText(text);
      if (rewritten === text) return v;
      try { return CSV.parse(String(prop), rewritten); } catch { return v; }
    };

    const nativeGet = RO.get;
    if (typeof nativeGet === 'function') {
      define(RO, 'get', function get(prop) { return back(prop, nativeGet.call(this, prop)); });
      hooked++;
    }
    const nativeGetAll = RO.getAll;
    if (typeof nativeGetAll === 'function') {
      define(RO, 'getAll', function getAll(prop) { return backAll(prop, nativeGetAll.call(this, prop)); });
      hooked++;
    }
    const nativeEntries = RO.entries;
    const nativeIter = RO[Symbol.iterator];
    if (typeof nativeEntries === 'function') {
      const entries = function entries() {
        const src = nativeEntries.call(this);
        const pairs = [];
        for (const pair of src) pairs.push([pair[0], backAll(pair[0], pair[1])]);
        return pairs[Symbol.iterator]();
      };
      define(RO, 'entries', entries);
      hooked++;
      // Derive values() from entries() because CSSStyleValue.parse requires the property name.
      if (typeof RO.values === 'function') {
        define(RO, 'values', function values() {
          const out = [];
          for (const pair of entries.call(this)) out.push(pair[1]);
          return out[Symbol.iterator]();
        });
        hooked++;
      }
      // Preserve @@iterator === entries identity on maplike interfaces.
      if (nativeIter === nativeEntries) {
        try { Object.defineProperty(RO, Symbol.iterator, { value: RO.entries, writable: true, enumerable: false, configurable: true }); } catch {}
      }
    }
    const nativeForEach = RO.forEach;
    if (typeof nativeForEach === 'function') {
      define(RO, 'forEach', function forEach(cb, thisArg) {
        if (typeof cb !== 'function') return nativeForEach.call(this, cb, thisArg);
        const map = this;
        return nativeForEach.call(this, function (values, prop, self) {
          return cb.call(thisArg, backAll(prop, values), prop, self || map);
        });
      });
      hooked++;
    }

    if (SM) {
      for (const m of ['set', 'append']) {
        const native = SM[m];
        if (typeof native !== 'function') continue;
        define(SM, m, function (prop) {
          const args = [prop];
          for (let i = 1; i < arguments.length; i++) args.push(fwd(prop, arguments[i]));
          return native.apply(this, args);
        });
        hooked++;
      }
    }
    return hooked;
  }
  function installStyleHooks(w) {
    try { installStyleHooksInner(w); } catch (e) {
      styleHookState = 'threw:' + String(e && (e.message || e)).slice(0, 60);
    }
    if (styleHookState !== 'ok') {
      try { root.__zp_diagnostics && root.__zp_diagnostics.push({ t: 'style-hooks', s: styleHookState }); } catch {}
    }
  }
  function installStyleHooksInner(w) {
    // Hook textContent on Node.prototype and innerText on HTMLElement.prototype where they natively reside, branching on `<style>` elements.
    for (const [prop, proto] of [
      ['textContent', w.Node && w.Node.prototype],
      ['innerText', w.HTMLElement && w.HTMLElement.prototype],
    ]) {
      if (!proto) continue;
      const d = Native[prop === 'textContent' ? 'nodeTextContent' : 'htmlInnerText'];
      if (!d || !d.set) continue;
      try {
        defineMasked(proto, prop, {
          get() {
            if (this.localName !== 'style') return d.get ? d.get.call(this) : undefined;
            return d.get ? originalStyleText(this, d.get.call(this)) : '';
          },
          set(v) {
            if (this.localName !== 'style') { d.set.call(this, v); return; }
            originalTextMeta.set(this, String(v == null ? '' : v));
            d.set.call(this, rewriteCSSText(v));
          },
          configurable: false
        });
      } catch {}
    }
    const sheetProto = w.CSSStyleSheet && w.CSSStyleSheet.prototype;
    if (sheetProto) {
      for (const m of ['insertRule', 'replaceSync', 'replace']) {
        const native = sheetProto[m];
        if (typeof native !== 'function') continue;
        define(sheetProto, m, function (text, idx) { return native.call(this, rewriteCSSText(text), idx); });
      }
    }
    // Rewrite url() sources passed to the FontFace constructor so font fetches route through the proxy.
    const NativeFontFace = w.FontFace;
    if (typeof NativeFontFace === 'function') {
      const ZPFontFace = function FontFace(family, source) {
        const args = Array.prototype.slice.call(arguments);
        if (typeof args[1] === 'string') args[1] = rewriteCSSText(args[1]);
        return Reflect.construct(NativeFontFace, args, new.target || ZPFontFace);
      };
      try { ZPFontFace.prototype = NativeFontFace.prototype; } catch {}
      brandLikeNative(ZPFontFace, null, 'FontFace');
      define(w, 'FontFace', ZPFontFace);
    }
    // Deproxy StyleSheet.prototype.href on read-back.
    const styleSheetProto = w.StyleSheet && w.StyleSheet.prototype;
    const dSheetHref = styleSheetProto && propertyDescriptor(styleSheetProto, 'href');
    if (dSheetHref && dSheetHref.get) try {
      defineMasked(styleSheetProto, 'href', {
        get() { return deproxyURL(dSheetHref.get.call(this), { scan: true }); },
        enumerable: dSheetHref.enumerable,
        configurable: false
      });
    } catch {}
    styleHookState = containEveryStyleAccessor(w) > 0 ? 'ok' : 'no-style-accessor';

    if (typeof w.getComputedStyle === 'function') {
      const nativeGCS = w.getComputedStyle;
      try {
        define(w, 'getComputedStyle', function (el, pe) {
          return containStyleDeclaration(nativeGCS.call(w, el, pe));
        });
      } catch {}
    }
    const ruleProto = w.CSSRule && w.CSSRule.prototype;
    const dRuleText = ruleProto && propertyDescriptor(ruleProto, 'cssText');
    if (dRuleText && dRuleText.get) try {
      defineMasked(ruleProto, 'cssText', {
        get() { return deproxyURL(dRuleText.get.call(this), { scan: true }); },
        set: dRuleText.set ? function (v) { return dRuleText.set.call(this, rewriteCSSText(v)); } : undefined,
        enumerable: dRuleText.enumerable,
        configurable: false
      });
    } catch {}
    installTypedOM(w);
    const declProto = w.CSSStyleDeclaration && w.CSSStyleDeclaration.prototype;
    if (declProto) {
      const nativeSet = declProto.setProperty;
      if (typeof nativeSet === 'function') {
        define(declProto, 'setProperty', function (p, v, pr) { return nativeSet.call(this, p, rewriteCSSText(v), pr); });
      }
      const dText = propertyDescriptor(declProto, 'cssText');
      if (dText && dText.set) try {
        defineMasked(declProto, 'cssText', {
          get() { return deproxyURL(dText.get ? dText.get.call(this) : '', { scan: true }); },
          set(v) { dText.set.call(this, rewriteCSSText(v)); },
          configurable: false
        });
      } catch {}
    }
  }
  function installScriptTextProps(w) {
    const scriptProto = w.HTMLScriptElement && w.HTMLScriptElement.prototype;
    if (!scriptProto) return;
    for (const prop of ['text', 'textContent', 'innerText']) {
      const d = propertyDescriptor(scriptProto, prop) || propertyDescriptor(w.Node && w.Node.prototype, prop);
      if (!d || !d.set) continue;
      try {
        defineMasked(scriptProto, prop, {
          get() { return d.get ? originalScriptText(this, d.get.call(this)) : ''; },
          set(v) {
            const c = ttCompliant('Script', 'HTMLScriptElement ' + prop, v, '', ttOfNode(this));
            d.set.call(this, typeof c === 'string' ? ttScript(c) : c);
            if (this.isConnected) prepareScriptElement(this);
          },
          configurable: false
        });
      } catch {}
    }
  }
  function installScriptProp(proto) {
    if (!proto) return;
    const d = propertyDescriptor(proto, 'src');
    if (!d || !d.get) return;
    try {
      defineMasked(proto, 'src', {
        get() {
          // Deproxy pre-rewritten script URLs when no stashed target metadata exists on the element.
          const masked = urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url');
          if (!masked) return deproxyURL(d.get.call(this), { scan: true });
          return masked;
        },
        set(v) { setScriptSource(this, ttCompliant('ScriptURL', 'HTMLScriptElement src', v, '', ttOfNode(this))); },
        configurable: true
      });
    } catch {}
  }
  function installLinkProp(proto) {
    if (!proto) return;
    if (propertyLocked(proto, 'href')) return;
    const hrefDescriptor = propertyDescriptor(proto, 'href');
    if (hrefDescriptor && hrefDescriptor.get) try {
      defineMasked(proto, 'href', {
        get() { return urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url') || hrefDescriptor.get.call(this); },
        set(v) {
          if (isBlockedLink(this) || hasSuppressedBlockedLinkRel(this)) return blockLinkURL(this, v);
          if (isIconLink(this)) return suppressIconLinkHref(this, v);
          const value = String(v);
          if (shouldBlockURLAttribute(this, 'href', value)) return blockExecutableURL(this, 'href', value);
          const t = targetURLForElement(this, value);
          if (t) {
            urlMeta.set(this, t);
            Native.setAttribute.call(this, 'data-zp-target-url', t);
            return hrefDescriptor.set ? hrefDescriptor.set.call(this, t) : Native.setAttribute.call(this, 'href', t);
          }
          return hrefDescriptor.set ? hrefDescriptor.set.call(this, value) : Native.setAttribute.call(this, 'href', value);
        },
        configurable: false
      });
    } catch {}
    const relDescriptor = propertyDescriptor(proto, 'rel');
    if (relDescriptor && relDescriptor.get) try {
      defineMasked(proto, 'rel', {
        get() { return relDescriptor.get.call(this); },
        set(v) {
          const value = String(v);
          if (isBlockedLinkRelValue(value)) return suppressBlockedLinkRel(this, value);
          if (Native.removeAttribute) Native.removeAttribute.call(this, 'data-zp-blocked-rel');
          const ret = relDescriptor.set ? relDescriptor.set.call(this, value) : Native.setAttribute.call(this, 'rel', value);
          enforceLinkPolicy(this);
          return ret;
        },
        configurable: false
      });
    } catch {}
  }
  function getScriptText(el) {
    if (Native.scriptText && Native.scriptText.get) return String(Native.scriptText.get.call(el) || '');
    if (Native.nodeTextContent && Native.nodeTextContent.get) return String(Native.nodeTextContent.get.call(el) || '');
    return String(el.textContent || '');
  }
  function setScriptText(el, value) {
    const text = String(value || '');
    if (Native.scriptText && Native.scriptText.set) { Native.scriptText.set.call(el, text); return; }
    if (Native.nodeTextContent && Native.nodeTextContent.set) { Native.nodeTextContent.set.call(el, text); return; }
    el.textContent = text;
  }
  function inlineScriptWrapper(source, kind) {
    const payload = JSON.stringify(String(source || '')).replace(/</g, '\\u003c');
    return kind === 'module' ? '__ZP_EXEC_INLINE_MODULE(' + payload + ');' : '__ZP_EXEC_INLINE_SCRIPT(' + payload + ');';
  }
  function isPreparedInlineScript(text) {
    // Include __ZP_LOAD_EXTERNAL_SCRIPT so child-realm external script loaders are not double-wrapped by appendWrittenHTML.
    return /^__ZP_(?:EXEC_INLINE_(?:SCRIPT|MODULE|REWRITTEN|REWRITTEN_MODULE)|LOAD_EXTERNAL_SCRIPT)\(/.test(String(text || '').trim());
  }
  function prepareScriptElement(el) {
    if (!el || el.localName !== 'script') return;
    const dataType = executableScriptDataType(el);
    if (dataType === 'importmap') {
      if (!Native.getAttribute.call(el, 'src')) setScriptText(el, rewriteImportMapText(getScriptText(el)));
      return;
    }
    if (dataType === 'speculationrules') {
      if (!Native.getAttribute.call(el, 'src')) setScriptText(el, rewriteSpeculationRulesText(getScriptText(el)));
      return;
    }
    const raw = Native.getAttribute.call(el, 'src') || Native.getAttribute.call(el, 'href');
    if (raw) {
      setScriptSource(el, raw);
      return;
    }
    if (dataType) {
      const text = getScriptText(el);
      if (!text) return;
      if (isPreparedInlineScript(text)) return;
      originalTextMeta.set(el, text);
      setScriptText(el, inlineScriptWrapper(text, dataType));
    }
  }
  function instrumentScriptElement(el) { prepareScriptElement(el); }
  // URL_SURFACES is populated at build time from crates/zp-shared/testdata/url_surfaces.json.
  const URL_SURFACES = newSet(__ZP_URL_SURFACES__);
  function isURLBearing(el, key, _localKey, _tag) {
    const tag = _tag != null ? _tag : (el && el.localName);
    if (!tag) return false;
    const localKey = _localKey != null ? _localKey : attrLocalName(key);
    // Lowercase tag because SVG elements preserve mixed-case localName values such as feImage.
    return URL_SURFACES.has(String(tag).toLowerCase() + ':' + localKey);
  }
  // Parse srcset into [{lead, url, tail}] segments so URLs containing commas (such as data: URLs or query strings) are not split mid-URL.
  function splitSrcsetCandidates(raw) {
    const s = String(raw == null ? '' : raw);
    const list = [];
    let i = 0;
    const isSep = c => c === ',' || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
    const isWS = c => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
    while (i < s.length) {
      const leadStart = i;
      while (i < s.length && isSep(s[i])) i++;
      const lead = s.slice(leadStart, i);
      if (i >= s.length) {
        if (lead) list.push({ lead, url: '', tail: '' });
        break;
      }
      // Read the URL as a contiguous non-whitespace run and strip only trailing commas.
      const urlStart = i;
      while (i < s.length && !isWS(s[i])) i++;
      let urlEnd = i;
      while (urlEnd > urlStart && s[urlEnd - 1] === ',') urlEnd--;
      const url = s.slice(urlStart, urlEnd);
      i = urlEnd;
      const descStart = i;
      while (i < s.length && s[i] !== ',') i++;
      list.push({ lead, url, tail: s.slice(descStart, i) });
    }
    return list;
  }
  function mapSrcsetCandidates(raw, fn) {
    let changed = false;
    const out = splitSrcsetCandidates(raw).map(c => {
      if (!c.url) return c.lead + c.tail;
      const next = fn(c.url);
      if (next != null && next !== c.url) { changed = true; return c.lead + next + c.tail; }
      return c.lead + c.url + c.tail;
    }).join('');
    return changed ? out : null;
  }
  function rememberSrcset(el, key, raw) {
    let m = srcsetMeta.get(el);
    if (!m) { m = newMap(); srcsetMeta.set(el, m); }
    m.set(String(key).toLowerCase(), String(raw));
  }
  function recalledSrcset(el, key) {
    const m = srcsetMeta.get(el);
    return m ? m.get(String(key).toLowerCase()) : undefined;
  }
  function enforceSrcsetAttribute(el, key, raw) {
    rememberSrcset(el, key, raw);
    const out = mapSrcsetCandidates(raw, url => {
      if (url.indexOf(ZP.apiPath('fetch')) >= 0 || url.indexOf(ZP.apiPath('v2/fetch')) >= 0) return null;
      const t = targetURLIfHTTP(url);
      return t ? subresourceProxyPath(t) : null;
    });
    if (out == null) return;
    Native.setAttribute.call(el, key, out);
    upgradeSWLessURL(el, key, out);
  }
  function executableScriptDataType(el) {
    const kind = executableScriptKindForElement(el);
    if (kind) return kind;
    const t = String(Native.getAttribute.call(el, 'type') || '').trim().toLowerCase();
    return t === 'importmap' ? 'importmap' : t === 'speculationrules' ? 'speculationrules' : '';
  }
  function blockInlineScriptElement(el) {
    Native.setAttribute.call(el, 'type', 'application/x-zeroproxy-blocked');
    Native.setAttribute.call(el, 'data-zp-blocked-script', '1');
    setScriptText(el, '');
  }
  function rewriteImportMapText(source) {
    let map;
    try { map = JSON.parse(String(source || '{}')); } catch { return '{}'; }
    if (!map || typeof map !== 'object' || Array.isArray(map)) return '{}';
    const rewriteAddress = value => {
      if (typeof value !== 'string') return value;
      try {
        const u = new URL(value, baseURL);
        if (u.protocol === 'http:' || u.protocol === 'https:') return scriptProxyPath(u.href, 'module');
        return ZP.errorPath('POLICY_BLOCKED');
      } catch {
        return ZP.errorPath('POLICY_BLOCKED');
      }
    };
    if (map.imports && typeof map.imports === 'object' && !Array.isArray(map.imports)) {
      for (const key of Object.keys(map.imports)) map.imports[key] = rewriteAddress(map.imports[key]);
    }
    if (map.scopes && typeof map.scopes === 'object' && !Array.isArray(map.scopes)) {
      const nextScopes = {};
      for (const scope of Object.keys(map.scopes)) {
        let scopeKey = scope;
        try {
          const u = new URL(scope, baseURL);
          if (u.protocol === 'http:' || u.protocol === 'https:') scopeKey = scriptProxyPath(u.href, 'module');
        } catch {}
        const entries = map.scopes[scope];
        if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
          const out = {};
          for (const key of Object.keys(entries)) out[key] = rewriteAddress(entries[key]);
          nextScopes[scopeKey] = out;
        }
      }
      map.scopes = nextScopes;
    }
    return JSON.stringify(map).replace(/[<>&]/g, c => c === '<' ? '\\u003c' : c === '>' ? '\\u003e' : '\\u0026');
  }
  // Rewrite speculationrules JSON so prefetch URLs use subresourceProxyPath and prerender URLs use proxyViaURL.
  function rewriteSpeculationRulesText(source) {
    let doc;
    try { doc = JSON.parse(String(source || '{}')); } catch { return '{}'; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return '{}';
    const abs = v => {
      try {
        const u = new URL(v, baseURL);
        return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
      } catch { return null; }
    };
    for (const pair of [['prefetch', false], ['prerender', true]]) {
      const rules = doc[pair[0]];
      if (!Array.isArray(rules)) continue;
      for (const rule of rules) {
        if (!rule || !Array.isArray(rule.urls)) continue;
        rule.urls = rule.urls.map(v => {
          const a = abs(v);
          if (!a) return v;
          return pair[1] ? proxyViaURL(a) : subresourceProxyPath(a);
        });
      }
    }
    return JSON.stringify(doc).replace(/[<>&]/g, c => c === '<' ? '\\u003c' : c === '>' ? '\\u003e' : '\\u0026');
  }
  // `document.write` on a CLOSED document triggers an implicit document.open() unless deferred child-realm scripts are still draining.
  function documentIsClosed(doc) {
    try { return !!doc && doc.readyState !== 'loading'; } catch { return false; }
  }
  function appendWrittenHTML(doc, html) {
    const target = doc.body || doc.documentElement;
    if (!target) return;
    const template = Reflect.apply(Native.documentCreateElement, doc, ['template']);
    if (Native.elementInnerHTML && Native.elementInnerHTML.set) Native.elementInnerHTML.set.call(template, html);
    else template.innerHTML = html;
    const frag = template.content || template;
    const scripts = Array.prototype.slice.call(qsaOf(frag, 'script'));
    target.appendChild(frag);
    for (const stale of scripts) {
      // Recreate each script element so the browser executes it after template fragment insertion.
      const fresh = doc.createElement('script');
      if (Native.getAttributeNames) {
        for (const name of Native.getAttributeNames.call(stale)) {
          try { Native.setAttribute.call(fresh, name, Native.getAttribute.call(stale, name) || ''); } catch {}
        }
      }
      setScriptText(fresh, getScriptText(stale));
      try { stale.replaceWith(fresh); } catch {}
    }
  }
  // Rewrite the URL portion of `<meta http-equiv="refresh" content="...">` to a proxy navigation URL.
  function proxiedRefreshContent(content) {
    const s = String(content || '');
    if (!s) return '';
    const at = s.toLowerCase().indexOf('url=');
    if (at < 0) return '';
    const head = s.slice(0, at);
    let v = s.slice(at + 4).trim();
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    v = v.trim();
    if (!v || /^javascript:/i.test(v)) return '';
    const abs = targetURLIfHTTP(v);
    if (!abs) return '';
    return head + 'url=' + proxyViaURL(abs);
  }
  // Post-write meta enforcement for paths that bypass the setAttribute hook:
  // MutationObserver records, Attr.value assignment, innerHTML insertions.
  // CSP equiv is neutralized; refresh rewrites `content` so the refresh timer
  // re-arms on the proxied URL instead of the raw target.
  function enforceMetaPolicy(el) {
    const eq = String(Native.getAttribute.call(el, 'http-equiv') || '').trim().toLowerCase();
    const blockedEq = String(Native.getAttribute.call(el, 'data-zp-blocked-http-equiv') || '').trim().toLowerCase();
    if (isCSPHttpEquiv(eq) || (!eq && isCSPHttpEquiv(blockedEq))) { neutralizeCSPMeta(el, eq || blockedEq); return; }
    if (eq !== 'refresh') return;
    const cur = Native.getAttribute.call(el, 'content');
    if (cur == null) return;
    const next = proxiedRefreshContent(cur);
    if (next && next !== cur) Native.setAttribute.call(el, 'content', next);
  }
  function transformHTML(value, opts) {
    const html = String(value);
    if (!html) return html;
    const inIframe = !!(opts && opts.inIframe);
    const swLessTarget = !!(opts && opts.swLess);
    // Parse complete documents (srcdoc, DOMParser, parseHTMLUnsafe) with DOMParser so doctype, html, head, and body attributes survive.
    const asDocument = !!(opts && opts.document) && !!Native.DOMParserParseFromString && !!root.DOMParser;
    let container = null;
    let parserDoc;
    let walkRoot;
    if (asDocument) {
      parserDoc = Native.DOMParserParseFromString.call(new root.DOMParser(), html, 'text/html');
      walkRoot = parserDoc;
    } else {
      parserDoc = Native.createHTMLDocument ? Native.createHTMLDocument('') : document.implementation.createHTMLDocument('');
      container = Reflect.apply(Native.documentCreateElement, parserDoc, ['template']);
      if (Native.elementInnerHTML && Native.elementInnerHTML.set) Native.elementInnerHTML.set.call(container, html);
      else container.innerHTML = html;
      walkRoot = container.content || container;
    }
    const walker = Reflect.apply(Native.createTreeWalker, parserDoc, [walkRoot, NodeFilter.SHOW_ELEMENT]);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    // Snapshot author attribute literals before rewriting so data-zp-lit-* stashes can be recorded for modified attributes.
    const literals = newMap();
    if (Native.getAttributeNames) {
      for (const node of nodes) {
        let m = null;
        for (const name of Native.getAttributeNames.call(node)) {
          if (isZPAttrName(name)) continue;
          const lk = attrLocalName(name);
          if (lk === 'style' || lk === 'srcset' || lk === 'imagesrcset' || isURLBearing(node, name, lk, node.localName)) {
            (m || (m = newMap())).set(name, Native.getAttribute.call(node, name));
          }
        }
        if (m) literals.set(node, m);
      }
    }
    for (const node of nodes) {
      const tag = node.localName;
      if (tag === 'meta') {
        const eq = String(Native.getAttribute.call(node, 'http-equiv') || '').trim().toLowerCase();
        if (isCSPHttpEquiv(eq)) { neutralizeCSPMeta(node, eq); continue; }
        if (eq === 'refresh') {
          const next = proxiedRefreshContent(Native.getAttribute.call(node, 'content') || '');
          if (next) Native.setAttribute.call(node, 'content', next);
        }
      }
      if (tag === 'base' && Native.getAttribute.call(node, 'href')) {
        const href = Native.getAttribute.call(node, 'href') || '';
        updateVirtualBase(href);
        const script = parserDoc.createElement('script');
        setScriptText(script, 'window.__ZP_SET_BASE&&window.__ZP_SET_BASE(' + JSON.stringify(href).replace(/</g, '\\\\u003c') + ');');
        node.replaceWith(script);
        continue;
      }
      if (tag === 'link') enforceLinkPolicy(node);
      if (Native.hasAttribute.call(node, 'style')) {
        const raw = Native.getAttribute.call(node, 'style') || '';
        const mapped = rewriteCSSText(raw);
        if (mapped !== raw) Native.setAttribute.call(node, 'style', mapped);
      }
      if (tag === 'style') {
        const raw = Native.nodeTextContent && Native.nodeTextContent.get
          ? Native.nodeTextContent.get.call(node) : node.textContent;
        const mapped = rewriteCSSText(raw || '');
        if (mapped !== raw && Native.nodeTextContent && Native.nodeTextContent.set) {
          Native.nodeTextContent.set.call(node, mapped);
        }
      }
      applyNavigationBackstop(node);
      if (tag === 'iframe' || tag === 'frame') {
        const sandbox = Native.getAttribute.call(node, 'sandbox');
        if (sandbox !== null && frameSandboxIsOpaque(sandbox)) sanitizeFrameSandbox(node);
      }
      if ((tag === 'iframe' || tag === 'frame') && Native.hasAttribute.call(node, 'data-zp-srcdoc')) {
        const pending = Native.getAttribute.call(node, 'data-zp-srcdoc') || '';
        if (setInjectedSrcdoc(node, pending)) {
          try { Native.removeAttribute.call(node, 'data-zp-srcdoc'); } catch {}
        }
      }
      if ((tag === 'iframe' || tag === 'frame') && Native.hasAttribute.call(node, 'srcdoc') && !srcdocMeta.has(node)) {
        setInjectedSrcdoc(node, Native.getAttribute.call(node, 'srcdoc') || '');
      }
      if (tag === 'script') {
        const dtype = executableScriptDataType(node);
        if (dtype === 'importmap') setScriptText(node, rewriteImportMapText(getScriptText(node)));
        else if (dtype) {
          // In child iframes, rewrite external scripts to __ZP_LOAD_EXTERNAL_SCRIPT so the parent's SW-controlled fetch loads them.
          const rawSrc = Native.getAttribute.call(node, 'src') || Native.getAttribute.call(node, 'href');
          if (inIframe && rawSrc) {
            const target = targetURLForElement(node, rawSrc);
            if (target) {
              if (Native.removeAttribute) {
                try { Native.removeAttribute.call(node, 'src'); } catch {}
                try { Native.removeAttribute.call(node, 'href'); } catch {}
              }
              const corsMode = swLessCORSMode(node);
              const loaderCode = '__ZP_LOAD_EXTERNAL_SCRIPT(' + JSON.stringify(target).replace(/</g, '\\u003c') + ',' + JSON.stringify(dtype) + (corsMode ? ',' + JSON.stringify(corsMode) : '') + ');';
              setScriptText(node, loaderCode);
              continue;
            }
          }
          prepareScriptElement(node);
        }
      }
      if (Native.getAttributeNames) {
        for (const attrName of Native.getAttributeNames.call(node)) {
          const lowerAttr = String(attrName).toLowerCase();
          if (lowerAttr === 'integrity' && isIntegrityBearing(node)) setBackedIntegrity(node, Native.getAttribute.call(node, attrName) || '');
          if (lowerAttr.startsWith('on') && lowerAttr.length > 2) {
            const val = Native.getAttribute.call(node, attrName) || '';
            Native.setAttribute.call(node, 'data-zp-blocked-' + lowerAttr, val);
            Native.setAttribute.call(node, attrName, rewriteEventAttribute(val));
          }
          if (isURLBearing(node, lowerAttr)) enforceObservedAttribute(node, lowerAttr);
        }
      }
      if (swLessTarget) applySWLessRelay(node);
    }
    for (const [node, m] of literals) {
      for (const [name, lit] of m) {
        if (lit === null) continue;
        let now;
        try { now = Native.getAttribute.call(node, name); } catch { continue; }
        if (now === lit || Native.hasAttribute.call(node, litAttrName(name))) continue;
        try { Native.setAttribute.call(node, litAttrName(name), lit); } catch {}
      }
    }
    if (!container) {
      const dt = parserDoc.doctype;
      const doctype = dt
        ? '<!DOCTYPE ' + dt.name + (dt.publicId ? ' PUBLIC "' + dt.publicId + '"' + (dt.systemId ? ' "' + dt.systemId + '"' : '') : (dt.systemId ? ' SYSTEM "' + dt.systemId + '"' : '')) + '>'
        : '';
      const de = parserDoc.documentElement;
      return doctype + (Native.elementOuterHTML && Native.elementOuterHTML.get ? Native.elementOuterHTML.get.call(de) : de.outerHTML);
    }
    return Native.elementInnerHTML && Native.elementInnerHTML.get ? Native.elementInnerHTML.get.call(container) : container.innerHTML;
  }
  // Parse document.write chunks starting with html/head/body tags as full documents so doctype and body attributes are preserved.
  const WRITTEN_DOCUMENT_RE = /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype[^>]*>\s*)?<(?:html|head|body)(?=[\s>\/])/i;
  const WRITTEN_DOCTYPE_RE = /^\s*(?:<!--[\s\S]*?-->\s*)*(<!doctype[^>]*>)/i;
  function transformWrittenHTML(value, opts) {
    const s = String(value);
    if (WRITTEN_DOCUMENT_RE.test(s)) return transformHTML(s, Object.assign({}, opts, { document: true }));
    const doctype = WRITTEN_DOCTYPE_RE.exec(s);
    return (doctype ? doctype[1] : '') + transformHTML(s, opts);
  }
  function applySWLessRelay(node) {
    if (!Native.getAttributeNames) return;
    const tag = node.localName;
    for (const attrName of Native.getAttributeNames.call(node)) {
      const lowerAttr = String(attrName).toLowerCase();
      const colon = lowerAttr.indexOf(':');
      const localKey = colon < 0 ? lowerAttr : lowerAttr.slice(colon + 1);
      if (!isURLBearing(node, lowerAttr) || !swLessRelayable(tag, localKey)) continue;
      const raw = Native.getAttribute.call(node, attrName);
      if (!raw) continue;
      if (localKey === 'srcset' || localKey === 'imagesrcset') {
        const out = mapSrcsetCandidates(raw, url => relayFromProxyPath(url, ''));
        if (out != null) Native.setAttribute.call(node, attrName, out);
        continue;
      }
      const relay = relayFromProxyPath(raw, relayKindForElement(node, tag, localKey), swLessCORSMode(node));
      if (relay) Native.setAttribute.call(node, attrName, relay);
    }
  }
  function srcdocPrelude(extraBoot) { return '<script src="' + ZP.assetURL('zp-core.js') + '"><\/script><script src="' + ZP.assetURL('zp-page-bundle.js') + '"><\/script><script id="__zp-boot" type="application/json">' + bootJSON(extraBoot) + '<\/script><script src="' + ZP.assetURL('runtime-prelude.js') + '"><\/script>'; }
  // The policy that refuses string evaluation for a srcdoc document: the one it inherits from this document, else one of its own `<meta>` tags.
  // The membrane booted inside the frame cannot read the originals the transformer keeps (the natives it captured are this realm's wrappers),
  // so it is told here, in its boot config.
  function srcdocEvalBlock(markup) {
    const inherited = cspEvalBlock(root.document);
    if (inherited) return inherited;
    for (const tag of String(markup).match(/<meta\b[^>]*>/gi) || []) {
      if (!/http-equiv\s*=\s*["']?content-security-policy["'\s>\/]/i.test(tag)) continue;
      const m = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      if (!m) continue;
      const value = (m[1] !== undefined ? m[1] : m[2]).replace(/&#0*39;|&#x0*27;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/&amp;/gi, '&');
      const block = ZP.evalBlockingPolicy(value);
      if (block) return block;
    }
    return '';
  }
  // Keep any leading doctype ahead of the injected prelude scripts so the srcdoc frame does not fall into quirks mode.
  function injectSrcdoc(s) {
    const markup = forSrcdocMarkup(() => transformHTML(String(s), { document: true }));
    const doctype = /^<!DOCTYPE[^>]*>/i.exec(markup);
    const block = srcdocEvalBlock(s);
    return (doctype ? doctype[0] : '') + srcdocPrelude(block ? { cspEvalBlock: block } : null) + (doctype ? markup.slice(doctype[0].length) : markup);
  }
  function bootJSON(extra) { return JSON.stringify(Object.assign({}, boot, { servers: activeServers, proxyOrigin }, extra)).replace(/[<>&]/g, c => c === '<' ? '\\u003c' : c === '>' ? '\\u003e' : '\\u0026'); }
  function rewriteEventAttribute(source) { return 'return ' + ZP_EVENT_CALL_HEAD + 'this,event,' + JSON.stringify(String(source || '')).replace(/</g, '\\u003c') + ')'; }
  function syncBaseElement(node) {
    if (!node) return;
    if (node.localName === 'base' && Native.getAttribute.call(node, 'href')) updateVirtualBase(Native.getAttribute.call(node, 'href'));
    if (node.querySelectorAll) qsaOf(node, 'base[href]').forEach(el => updateVirtualBase(Native.getAttribute.call(el, 'href')));
  }