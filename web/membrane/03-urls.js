  function preservedShareFragment(hash) {
    if (!hash) return '';
    try {
      const raw = hash[0] === '#' ? hash.slice(1) : hash;
      const params = new URLSearchParams(raw);
      const key = params.get('k');
      return key ? ZP.makeShareFragment(key, activeServers) : '';
    } catch { return ''; }
  }
  function shareFragmentForKey(key) { return ZP.makeShareFragment(String(key), activeServers); }
  function proxyHistoryURL() { return activeProxyPath + activeProxyFragment; }
  // Resolve proxy route paths against proxyOrigin so a target <base href>
  // element cannot redirect history.pushState or location navigations to the
  // target origin.
  function proxyAbsoluteURL(pathAndFragment) {
    const raw = String(pathAndFragment || '');
    try { return new URL(raw, proxyOrigin).href; } catch { return proxyOrigin + raw; }
  }
  function nativeLocationURL() {
    try {
      const href = Native.locationHref && Native.locationHref.get && Native.locationHref.get.call(root.location);
      if (href) return new URL(href);
    } catch {}
    try { return new URL(proxyHistoryURL(), proxyOrigin); } catch { return new URL(initialProxyURL.href); }
  }
  function visibleProxyURL() { const u = nativeLocationURL(); return u.pathname + u.search + u.hash; }
  function setActiveShareRoute(share) {
    activeProxyPath = ZP.makeSharePath(share.encrypted);
    activeRouteKey = share.encrypted;
    activeProxyFragment = shareFragmentForKey(share.key);
  }
  function replaceVisibleProxyURL() {
    const next = proxyHistoryURL();
    if (visibleProxyURL() !== next) {
      try { Native.historyReplace(winGet(root, 'history').state, '', proxyAbsoluteURL(next)); } catch {}
    }
  }
  function refreshVisibleShareRoute(entryId, target, base) {
    const version = ++activeShareVersion;
    ZP.encryptShareURL(target).then(share => {
      return ctx.bridge.send({ type: ZP.MSG.HISTORY_UPDATE, tabId: boot.tabId, routeKey: share.encrypted, entryId, targetUrl: target, baseUrl: base, replace: true, ...(opaqueDocument ? { opaque: true } : null) }).then(() => share);
    }).then(share => {
      if (version !== activeShareVersion || entryId !== activeEntryId || target !== virtualURL.href) return;
      setActiveShareRoute(share);
      replaceVisibleProxyURL();
    }).catch(()=>{});
  }
  function isHTTPURL(raw) { try { const u = new URL(String(raw), baseURL); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } }
  function hasExecutableURLScheme(raw) { return /^(?:javascript|data|vbscript):/i.test(String(raw).trim()); }
  function hasDangerousURLScheme(raw) { return /^(?:javascript|vbscript):/i.test(String(raw).trim()); }
  // Non-http(s) absolute URLs pass through unchanged.
  // Relative URLs and fragments require resolution against the target `baseURL`.
  function nonHTTPAbsoluteURL(raw) {
    const s = String(raw).trim();
    const m = /^([a-z][a-z0-9+.\-]*):/i.exec(s);
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https') return null;
    try { return new URL(s).href; } catch { return s; }
  }
  // Single-parse equivalent of `isHTTPURL(v) && targetURL(v)`. Consults
  // tickURLCache when active during a MutationObserver batch.
  function targetURLIfHTTP(raw) {
    const key = String(raw);
    if (tickURLCache) {
      const cached = tickURLCache.get(key);
      if (cached !== undefined) return cached;
    }
    let result;
    try { result = targetURL(key); }
    catch { result = null; }
    if (tickURLCache) tickURLCache.set(key, result);
    return result;
  }
  // Tick-local URL classification cache active during MutationObserver callbacks.
  let tickURLCache = null;

  // Per-element raw-to-target URL cache so repeated attribute writes with
  // identical values skip URL parsing.
  const urlClassifyCache = newWeakMap();
  function targetURLForElement(el, raw) {
    const key = String(raw);
    const cached = urlClassifyCache.get(el);
    if (cached && cached.lastRaw === key) return cached.target;
    const target = targetURLIfHTTP(key);
    if (target) urlClassifyCache.set(el, { lastRaw: key, target });
    return target;
  }
  function shouldBlockURLAttribute(el, key, raw, _localKey, _tag) {
    const tag = _tag != null ? _tag : (el && el.localName);
    const localKey = _localKey != null ? _localKey : attrLocalName(key);
    const strict = localKey === 'src' && tag === 'script' || localKey === 'src' && (tag === 'iframe' || tag === 'frame') || usesRawURLAttribute(el, key, localKey);
    return strict ? hasExecutableURLScheme(raw) : hasDangerousURLScheme(raw);
  }
  // Block blob: URLs on script, frame, and plugin elements so unrewritten code
  // cannot execute from a Blob. A script is the exception for the copies this file made itself (`routeBlobScript`).
  function hasContextBlockedScheme(el, raw) {
    const s = String(raw).trim();
    if (!/^blob:/i.test(s)) return false;
    const tag = el && el.localName;
    if (tag === 'script') return !rewrittenScriptBlobs.has(s);
    return tag === 'iframe' || tag === 'frame' || tag === 'embed' || tag === 'object';
  }
  // Blob URLs of rewritten copies of a page's blob scripts, and the copy each script element points at.
  const rewrittenScriptBlobs = newSet();
  const blobScriptCopies = newWeakMap();
  // A script the page points at its own blob (es-module-shims feature-detects `import`, import maps and JSON modules with `<script type=module src=blob:…>`; without them it
  // takes the browser for one that has none) cannot run as it is: the code was never rewritten. Read the blob (a same-origin synchronous request, as `import(blob:)` does),
  // rewrite it for the element's kind and point the element at a copy of the result; `src` still reads back as the page's blob. Anything that cannot be read or rewritten stays blocked.
  function routeBlobScript(el, raw) {
    const kind = executableScriptKindForElement(el);
    if (!kind || !pageRewriteHooks || !Native.createObjectURL || !Native.XMLHttpRequest) return false;
    // Preparing the element at insertion and the observer read the attribute this function wrote: a copy is already rewritten, and the same blob and kind keep their copy.
    if (rewrittenScriptBlobs.has(raw)) return true;
    const made = blobScriptCopies.get(el);
    if (made && made.raw === raw && made.kind === kind) {
      if (Native.getAttribute.call(el, 'src') !== made.copy) Native.setAttribute.call(el, 'src', made.copy);
      return true;
    }
    let copy;
    try {
      const req = new Native.XMLHttpRequest();
      req.open('GET', raw, false);
      req.send();
      if (req.status !== 200 && req.status !== 0) return false;
      copy = Native.createObjectURL(new Blob([pageRewriteHooks.rewrite(req.responseText, kind)], { type: 'text/javascript' }));
    } catch { return false; }
    rewrittenScriptBlobs.add(copy);
    blobScriptCopies.set(el, { raw, kind, copy });
    urlMeta.set(el, raw);
    litSet(el, 'src', raw);
    Native.setAttribute.call(el, 'src', copy);
    return true;
  }
  function blockedURLValue(el, key) { const tag = el && el.localName; return key === 'src' && (tag === 'iframe' || tag === 'frame') ? 'about:blank' : key === 'src' && tag === 'script' ? ZP.errorPath('POLICY_BLOCKED') : '#'; }
  function blockExecutableURL(el, key, raw) {
    // Rewrite javascript: URLs on <a href>, <area href>, and <form action> and
    // stash the rewritten code in data-zp-jsurl for delegated execution.
    const tag = el && el.localName;
    const s = String(raw).trim();
    if (tag === 'script' && key === 'src' && /^blob:/i.test(s) && routeBlobScript(el, s)) return;
    const colon = s.indexOf(':');
    if (/^javascript:/i.test(s) && ((key === 'href' && (tag === 'a' || tag === 'area')) || (key === 'action' && tag === 'form'))) {
      try {
        const code = callPageRewriter(s.slice(colon + 1), 'classic');
        Native.setAttribute.call(el, 'data-zp-jsurl', code);
        Native.setAttribute.call(el, 'data-zp-jsurl-kind', tag === 'form' ? 'form' : 'anchor');
        Native.setAttribute.call(el, key, 'javascript:void(0)');
        return;
      } catch {}
    }
    urlMeta.delete(el); Native.setAttribute.call(el, 'data-zp-target-url', ''); Native.setAttribute.call(el, 'data-zp-blocked-url', s); Native.setAttribute.call(el, key, blockedURLValue(el, key)); if (key === 'src' && (el.localName === 'iframe' || el.localName === 'frame')) instrumentIframe(el);
  }
  // Intercept <meta http-equiv> for Content-Security-Policy and Origin-Trial so
  // page-injected meta tags cannot break proxy runtime plumbing or activate
  // origin trials on the proxy origin.
  const CSP_EQUIV = ['content-security-policy', 'content-security-policy-report-only', 'origin-trial'];
  function isCSPHttpEquiv(value) {
    return CSP_EQUIV.indexOf(String(value || '').trim().toLowerCase()) >= 0;
  }
  // Intersect meta CSP directives with proxy required sources via
  // ZP.filterMetaCSP; remove http-equiv if no directives remain or if the tag
  // is origin-trial.
  function neutralizeCSPMeta(el, value) {
    Native.setAttribute.call(el, 'data-zp-blocked-http-equiv', String(value));
    const eq = String(value || '').trim().toLowerCase();
    if (eq === 'content-security-policy' || eq === 'content-security-policy-report-only') {
      const content = Native.getAttribute ? Native.getAttribute.call(el, 'content') : null;
      const filtered = content != null ? ZP.filterMetaCSP(content, ZP.siteFrameSource(proxyOrigin)) : '';
      if (filtered) {
        // Avoid overwriting data-zp-blocked-content when MutationObserver
        // re-observes the filtered attribute write.
        if (content !== filtered) {
          try { Native.setAttribute.call(el, 'data-zp-blocked-content', String(content)); } catch {}
          try { Native.setAttribute.call(el, 'content', filtered); } catch {}
        }
        // Restore http-equiv if it was stripped before the content attribute arrived.
        if (Native.getAttribute.call(el, 'http-equiv') == null) {
          try { Native.setAttribute.call(el, 'http-equiv', eq); } catch {}
        }
        return;
      }
    }
    if (Native.removeAttribute) { try { Native.removeAttribute.call(el, 'http-equiv'); } catch {} }
  }
  function isIntegrityBearing(el) { const tag = el && el.localName; return tag === 'script' || tag === 'link'; }
  function backedIntegrity(el) { return isIntegrityBearing(el) ? Native.getAttribute.call(el, integrityBackupAttr) : null; }
  function setBackedIntegrity(el, value) { Native.setAttribute.call(el, integrityBackupAttr, String(value)); if (Native.removeAttribute) Native.removeAttribute.call(el, 'integrity'); }
  // Recover the underlying target URL when a leaked physical proxy URL (from
  // unforgeable location properties or dynamic computed reads) is passed back
  // into targetURL, requestTargetURL, or targetWSURL. Returns null when the
  // input is an encrypted share path that must resolve to the current virtual
  // document URL.
  function proxyLocalPath(raw) {
    const s = String(raw == null ? '' : raw);
    if (!s) return '';
    // Root-relative path (excluding protocol-relative `//host/path`).
    if (s[0] === '/' && s[1] !== '/') { const h = s.indexOf('#'); return h < 0 ? s : s.slice(0, h); }
    const abs = s.slice(0, 2) === '//' ? 'http:' + s : s;
    // Relative paths without a scheme are not proxy-origin URLs.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(abs)) return '';
    let u;
    try { u = new URL(abs); } catch { return ''; }
    return u.host === proxyHost ? u.pathname + u.search : '';
  }
  function unleakedTargetRaw(raw) {
    const s = String(raw == null ? '' : raw);
    // Match the active encrypted share path even if resolved against the target baseURL.
    if (activeProxyPath && s.indexOf(activeProxyPath) >= 0) {
      try { if (new URL(s, baseURL).pathname === activeProxyPath) return null; } catch {}
    }
    const local = proxyLocalPath(s);
    if (!local) return s;
    const qi = local.indexOf('?');
    const path = qi < 0 ? local : local.slice(0, qi);
    const params = qi < 0 ? null : new URLSearchParams(local.slice(qi + 1));
    // Subresource fetch wrapper carrying the target URL in `?url=`.
    if ((path === ZP.apiPath('fetch') || path === ZP.apiPath('v2/fetch')) && params && params.get('url')) return params.get('url');
    // Navigation launcher carrying the target URL in `?via=`.
    if (path === ZP.controlPath('') && params && params.get('via')) return params.get('via');
    // Encrypted share path.
    if (ZP.isSharePath(path)) return null;
    return s;
  }
  function targetURL(raw, base = baseURL) {
    const g = unleakedTargetRaw(raw);
    return ZP.canonicalTargetURL(g === null ? virtualURL.href : g, base).href;
  }
  function targetWSURL(raw, base = baseURL) {
    const g = unleakedTargetRaw(raw);
    return ZP.canonicalWebSocketURL(g === null ? virtualURL.href.replace(/^http/, 'ws') : g, base.replace(/^http/, 'ws')).href;
  }
  function shareNavURL(raw, base = baseURL) { return ZP.makeShareURL(targetURL(raw, base), proxyOrigin, activeServers); }
  // Enforce same-origin URL constraints on history.pushState and
  // history.replaceState against the virtual document URL, throwing a
  // native-formatted SecurityError on mismatch.
  function sameOriginHistoryURL(url, verb) {
    let parsed = null;
    try { parsed = new URL(String(url), baseURL); } catch {}
    const doc = virtualURL;
    if (!parsed || parsed.protocol !== doc.protocol || parsed.username !== doc.username || parsed.password !== doc.password || parsed.host !== doc.host) {
      const shown = parsed ? parsed.href : String(url);
      throw new Native.DOMException("Failed to execute '" + (verb || 'pushState') + "' on 'History': A history state object with URL '" + shown
        + "' cannot be created in a document with origin '" + displayOrigin(securityOrigin()) + "' and URL '" + doc.href + "'.", 'SecurityError');
    }
    return new URL(targetURL(parsed.href));
  }