  // Encode `?url=` query parameters identically to Rust `URL_PARAM_ENCODE`
  // (RFC 3986 unreserved characters only, encoding `!'()*` in addition to
  // `encodeURIComponent`) so client and server produce identical cache keys.
  function encodeURLParam(s) {
    return nativeEncodeURIComponent(String(s)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }
  function subresourceProxyPath(absolute) {
    const s = String(absolute || '');
    if (!s || s[0] === '#') return s;
    if (!/^https?:/i.test(s)) return s;
    // Keep the URL fragment outside the `?url=` query parameter so the browser
    // can resolve fragment identifiers (such as SVG `<use>` and CSS `url(sprite.svg#icon)`).
    const hash = s.indexOf('#');
    const head = hash < 0 ? s : s.slice(0, hash);
    const frag = hash < 0 ? '' : s.slice(hash);
    let out = proxyOrigin + ZP.apiPath('fetch') + '?url=' + encodeURLParam(head);
    if (boot && boot.tabId) out += '&tab=' + encodeURLParam(boot.tabId);
    return out + frag;
  }
  // Subresource relay URL for documents that are not Service Worker clients
  // (such as `document.write` iframes). Because `/zp/api/fetch` only exists inside
  // the Service Worker, requests from SW-less documents route through the Go
  // `/zp/api/sync-fetch` relay, which parks the HTTP response while the worker fetches.
  function swLessRelayURL(absolute, kind, cors) {
    const s = String(absolute || '');
    if (!/^https?:/i.test(s)) return '';
    let u = proxyOrigin + ZP.apiPath('sync-fetch')
      + '?rid=' + nativeEncodeURIComponent('sr' + ZP.randomId())
      + '&u=' + nativeEncodeURIComponent(s)
      + '&m=GET'
      + '&tab=' + nativeEncodeURIComponent((boot && boot.tabId) || '')
      + '&entry=' + nativeEncodeURIComponent(activeEntryId || '');
    if (kind) u += '&kind=' + nativeEncodeURIComponent(kind);
    if (cors) u += '&cors=' + nativeEncodeURIComponent(cors);
    return u;
  }
  // Extract the target URL from a `/zp/api/sync-fetch` relay URL, or return `''`
  // if `url` is not a relay URL.
  function relayTargetOf(url) {
    const s = String(url || '');
    if (s.indexOf(ZP.apiPath('sync-fetch') + '?') < 0) return '';
    try { return new URL(s, proxyOrigin).searchParams.get('u') || ''; } catch { return ''; }
  }
  // Convert an already-rewritten `/zp/api/fetch?url=...` path into a relay URL
  // when the destination document is known to be SW-less.
  function relayFromProxyPath(proxied, kind, cors) {
    const s = String(proxied || '');
    const at = s.indexOf(ZP.apiPath('fetch') + '?url=');
    if (at < 0) return '';
    let target = '';
    try { target = new URL(s, proxyOrigin).searchParams.get('url') || ''; } catch { return ''; }
    return target ? swLessRelayURL(target, kind, cors) : '';
  }
  // Only route `<link href>` subresources through the synchronous HTTP/1.1 relay;
  // images use asynchronous parent-fetched `blob:` URLs to avoid exhausting per-origin
  // HTTP/1.1 connection limits while relay requests are parked.
  function swLessRelayable(tag, localKey) {
    return tag === 'link' && localKey === 'href';
  }
  function relayKindForElement(node, tag, localKey) {
    if (tag === 'link' && localKey === 'href') {
      const rel = String(Native.getAttribute.call(node, 'rel') || '').toLowerCase();
      // Only request CSS rewriting for stylesheet links.
      return /(^|\s)stylesheet(\s|$)/.test(rel) ? 'style' : '';
    }
    if (tag === 'script' && localKey === 'src') return 'script';
    return '';
  }
  // Subresource handling for SW-less frames (`about:blank` or `document.write` frames
  // that inherit the top document's URL without a dedicated navigation).
  const swLessDocs = newWeakMap();
  function documentIsSWLess(doc) {
    if (!doc || doc === document) return false;
    // A document with no window (a `<template>`'s content, `DOMParser`, `createHTMLDocument`) loads nothing, and natively nothing is requested for what the page puts in it
    // (FAST's templates hold `fast-x{…}fast-x` placeholders in `src` attributes). Its attributes get the proxy path like a live document's; if its nodes are adopted into a
    // document, the proxy path is what that document loads (or, in a SW-less frame, upgrades).
    try { if (!doc.defaultView) return false; } catch { return false; }
    let cached = swLessDocs.get(doc);
    if (cached !== undefined) return cached;
    let url = null;
    const desc = Native.documentURLDesc;
    if (desc && desc.get) { try { url = String(desc.get.call(doc) || ''); } catch { url = null; } }
    // A frame created via `document.write` inherits the parent document's URL
    // (minus fragment) instead of navigating to its own `/zp/p/<share>` route,
    // so it is not registered as a Service Worker client.
    const bare = s => { const i = s.indexOf('#'); return i < 0 ? s : s.slice(0, i); };
    let topURL = null;
    if (desc && desc.get) { try { topURL = String(desc.get.call(document) || ''); } catch {} }
    const value = url === null ? false
      : (!url || url === 'about:blank' || (!!topURL && bare(url) === bare(topURL)));
    swLessDocs.set(doc, value);
    if (value) installSWLessObserver(doc);
    return value;
  }
  const swLessBlobs = newMap();
  // Fetch a subresource through the parent realm's Service Worker and wrap the
  // response in a `blob:` URL. Pass `X-ZP-Style-Request: 1` for stylesheets so the
  // worker rewrites relative `url(...)` references even though `fetch()` has an
  // `'empty'` destination, and pass `X-ZP-Element-CORS` when `crossorigin` is set.
  function swLessBlobURL(proxied, kind, cors) {
    const ck = (kind || '') + '\n' + (cors || '') + '\n' + proxied;
    const hit = swLessBlobs.get(ck);
    if (hit) return hit;
    const make = Native.createObjectURL || (blob => URL.createObjectURL(blob));
    const headers = {};
    if (kind === 'style') headers['X-ZP-Style-Request'] = '1';
    if (cors) headers['X-ZP-Element-CORS'] = cors;
    const init = Object.keys(headers).length ? { headers } : undefined;
    let p;
    try {
      p = Promise.resolve(init ? Native.fetch(proxied, init) : Native.fetch(proxied))
        .then(r => (r && r.ok) ? r.blob() : Promise.reject(new Error('status ' + (r && r.status))))
        .then(b => make(b))
        .catch(err => { swLessBlobError = String(err && err.message || err).slice(0, 120); reportSWLessError(); return null; });
    } catch (err) {
      swLessBlobError = 'sync ' + String(err && err.message || err).slice(0, 110);
      p = Promise.resolve(null);
    }
    if (swLessBlobs.size < 400) swLessBlobs.set(ck, p);
    return p;
  }
  var swLessBlobError = null;
  function reportSWLessError() {
    if (!swLessBlobError) return;
    try {
      const diag = root.__zp_diagnostics;
      if (diag && diag.length < 200) diag.push({ t: 'swless-blob', msg: swLessBlobError });
    } catch {}
  }
  // Track upgraded attributes per `(element, attribute)` pair so elements with both
  // `src` and `srcset` upgrade each attribute independently.
  const swLessUpgraded = newWeakMap();
  function markSWLessUpgraded(el, key) {
    let keys = swLessUpgraded.get(el);
    if (!keys) { keys = newSet(); swLessUpgraded.set(el, keys); }
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  }
  // If an element in a live document still holds `SWLESS_PIXEL` from an inert parse
  // pass (where the async blob replacement targeted the detached parser node),
  // recover the target URL from `data-zp-target-url` and complete the upgrade.
  function healSWLessPlaceholder(el, key) {
    let doc = null;
    try { doc = el.ownerDocument; } catch {}
    if (!doc || !doc.defaultView) return;
    if (key !== 'src' || !markSWLessUpgraded(el, 'heal')) return;
    let target = null;
    try { target = Native.getAttribute.call(el, 'data-zp-target-url'); } catch {}
    if (!target) return;
    const proxied = subresourceProxyPath(target);
    if (!documentIsSWLess(doc)) { try { Native.setAttribute.call(el, key, proxied); } catch {} return; }
    const cors = swLessCORSMode(el);
    swLessBlobURL(proxied, '', cors).then(u => {
      try {
        if (u) Native.setAttribute.call(el, key, u);
        else if (cors) Native.setAttribute.call(el, key, SWLESS_ERROR);
      } catch {}
    });
  }
  // Return the element's requested CORS mode: `''`, `'anonymous'`, or `'use-credentials'`.
  function swLessCORSMode(el) {
    let attr = null;
    try { attr = Native.getAttribute.call(el, 'crossorigin'); } catch {}
    if (attr === null || attr === undefined) return '';
    return String(attr).toLowerCase() === 'use-credentials' ? 'use-credentials' : 'anonymous';
  }
  function upgradeSWLessURL(el, key, raw) {
    if (String(raw) === SWLESS_PIXEL) return healSWLessPlaceholder(el, key);
    if (raw.indexOf(ZP.apiPath('fetch')) < 0) return;
    let doc = null;
    try { doc = el.ownerDocument; } catch {}
    if (!documentIsSWLess(doc)) return;
    if (!markSWLessUpgraded(el, key)) return;
    const cors = swLessCORSMode(el);
    if (key === 'srcset' || key === 'imagesrcset') return upgradeSWLessSrcset(el, key, raw, cors);
    swLessBlobURL(raw, key === 'href' ? 'style' : '', cors).then(u => { if (u) try { Native.setAttribute.call(el, key, u); } catch {} });
  }
  // Upgrade each candidate URL in a `srcset` attribute to a `blob:` URL while
  // preserving width/density descriptors (`1x`, `320w`).
  function upgradeSWLessSrcset(el, key, raw, cors) {
    const parts = splitSrcsetCandidates(raw);
    const jobs = parts.map(c => {
      if (!c.url || c.url.indexOf(ZP.apiPath('fetch')) < 0) return Promise.resolve(c.lead + c.url + c.tail);
      return swLessBlobURL(c.url, '', cors).then(u => c.lead + (u || c.url) + c.tail);
    });
    Promise.all(jobs).then(list => { try { Native.setAttribute.call(el, key, list.join('')); } catch {} });
  }
  // Classify same-origin child frame documents so SW-less frames receive a MutationObserver.
  function sweepSWLessFrames(w) {
    let frames = null;
    try { frames = qsaOf((w || window).document, 'iframe,frame'); } catch { return; }
    if (!frames) return;
    for (const f of frames) {
      let d = null;
      try { d = nativeFrameDocument(f); } catch { continue; }
      if (d) documentIsSWLess(d);
    }
  }
  function sweepSWLessDoc(doc) {
    let els = null;
    try { els = qsaOf(doc, 'img[src],img[srcset],source[src],source[srcset],video[poster],input[src],embed[src],link[rel~="stylesheet"][href],meta[http-equiv]'); } catch { return; }
    for (const el of els) {
      // Rewrite meta refresh inside SW-less frames to use the `?via=` URL.
      if (el.localName === 'meta') { try { enforceMetaPolicy(el); } catch {} continue; }
      const tag = el.localName;
      const keys = tag === 'video' ? ['poster']
        : tag === 'link' ? ['href']
        : (tag === 'img' || tag === 'source') ? ['src', 'srcset']
        : ['src'];
      for (const key of keys) {
        let raw = null;
        try { raw = Native.getAttribute.call(el, key); } catch {}
        if (raw) upgradeSWLessURL(el, key, String(raw));
      }
    }
  }
  // Attach a MutationObserver only to SW-less child documents (such as ad frames)
  // rather than the top-level document.
  function installSWLessObserver(doc) {
    try {
      // Observe the Document node itself because `document.write` replaces `documentElement`.
      const obs = new MutationObserver(() => sweepSWLessDoc(doc));
      obs.observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'poster', 'href', 'http-equiv', 'content'] });
    } catch {}
    sweepSWLessDoc(doc);
  }
  // 1x1 transparent PNG placeholder for images in SW-less documents so no network
  // request is issued before the parent-fetched `blob:` URL resolves.
  const SWLESS_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
  // Invalid data URL assigned when a CORS-enabled image request fails in a SW-less
  // document so the element fires an `error` event instead of `load`.
  const SWLESS_ERROR = 'data:,';
  function swLessPixelable(el, key) {
    const tag = el && el.localName;
    if (key === 'poster') return tag === 'video';
    if (key !== 'src') return false;
    return tag === 'img' || tag === 'image' || tag === 'input';
  }
  // Track when markup is being rewritten for a `srcdoc` frame, which boots its
  // own prelude and should not receive SW-less placeholders from the parent.
  let srcdocMarkupDepth = 0;
  function forSrcdocMarkup(fn) {
    srcdocMarkupDepth++;
    try { return fn(); } finally { srcdocMarkupDepth--; }
  }
  function setSubresourceAttribute(el, key, proxied) {
    let doc = null;
    try { doc = el.ownerDocument; } catch {}
    if (srcdocMarkupDepth || !documentIsSWLess(doc)) { Native.setAttribute.call(el, key, proxied); return; }
    // In SW-less documents, `/zp/api/fetch` would bypass the Service Worker and 403
    // on the Go server. Set a non-network 1x1 transparent PNG placeholder first and
    // swap in the `blob:` URL once the parent fetch resolves.
    const placeholder = swLessPixelable(el, key);
    Native.setAttribute.call(el, key, placeholder ? SWLESS_PIXEL : proxied);
    swLessBlobURL(proxied, '', swLessCORSMode(el)).then(u => { if (u) try { Native.setAttribute.call(el, key, u); } catch {} });
  }
  function proxyViaURL(absolute) {
    const s = String(absolute || '');
    if (!s) return s;
    if (s[0] === '#') return s;
    if (/^(?:javascript|mailto|data|blob|about|vbscript):/i.test(s)) return s;
    if (!/^https?:/i.test(s)) return s;
    const prefix = (typeof ZP !== 'undefined' && ZP && ZP.CONTROL_PREFIX) || '/zp/';
    return proxyOrigin + prefix + '?via=' + nativeEncodeURIComponent(s);
  }
  // Ensure anchor and form elements populated via `cloneNode` or `DocumentFragment`
  // carry a proxy `?via=` attribute and a `urlMeta` entry.
  function applyNavigationBackstop(el) {
    if (!el || el.nodeType !== 1) return;
    const ln = el.localName;
    let attrName;
    if (ln === 'a' || ln === 'area') attrName = 'href';
    else if (ln === 'form') attrName = 'action';
    else if (ln === 'input' || ln === 'button') {
      if (!el.hasAttribute || !el.hasAttribute('formaction')) return;
      attrName = 'formaction';
    } else return;
    const raw = Native.getAttribute.call(el, attrName);
    if (!raw) return;
    if (raw.indexOf(proxyOrigin) === 0) return; // already proxied
    if (raw[0] === '#') return;
    if (/^(?:javascript|mailto|data|blob|about|vbscript):/i.test(raw)) return;
    let abs;
    if (/^https?:/i.test(raw)) abs = raw;
    else if (raw.indexOf('//') === 0) abs = 'https:' + raw;
    else { try { abs = new URL(raw, virtualURL.href).href; } catch { return; } }
    if (!/^https?:/i.test(abs)) return;
    urlMeta.set(el, abs);
    try { Native.setAttribute.call(el, 'data-zp-target-url', abs); } catch {}
    try { Native.setAttribute.call(el, attrName, proxyViaURL(abs)); } catch {}
  }
  // Restore `<iframe data-zp-frame-src>` parked by htmltx or `transformHTML` through
  // the hooked `setAttribute('src', ...)` path so the frame routes via `activatedFrameURL`.
  function restorePendingFrameSrc(el) {
    if (!el || !Native.hasAttribute.call(el, 'data-zp-frame-src')) return;
    // Sanitize `sandbox` before starting navigation so the browser commits the updated flags.
    sanitizeFrameSandbox(el);
    const pending = Native.getAttribute.call(el, 'data-zp-frame-src') || '';
    if (!pending) { try { Native.removeAttribute.call(el, 'data-zp-frame-src'); } catch {} return; }
    try {
      // Suppress the parser's initial `about:blank` load event while the routed navigation is pending.
      pendingFrameRoutes.add(el);
      el.setAttribute('src', pending);
      try { Native.removeAttribute.call(el, 'data-zp-frame-src'); } catch {}
    } catch (e) {
      try { console.warn('[ZP] frame src restore failed', String(e && (e.message || e))); } catch {}
    }
  }
  function restorePendingSrcdoc(el) {
    if (!el || !Native.hasAttribute.call(el, 'data-zp-srcdoc')) return;
    sanitizeFrameSandbox(el);
    const pending = Native.getAttribute.call(el, 'data-zp-srcdoc') || '';
    if (!setInjectedSrcdoc(el, pending)) return;
    try { Native.removeAttribute.call(el, 'data-zp-srcdoc'); } catch {}
  }
  // Return true when `el` belongs to an inert document without a browsing context
  // (such as a template content fragment or `DOMParser` document).
  function inertFrameDocument(el) {
    try { const d = el.ownerDocument; return !!d && !d.defaultView; } catch { return false; }
  }
  function restoreParkedFrame(el) {
    if (inertFrameDocument(el)) return;
    restorePendingSrcdoc(el);
    restorePendingFrameSrc(el);
  }
  function markupHasFrames(markup) { return /<i?frame\b/i.test(String(markup)); }
  // Activate parked `data-zp-srcdoc` and `data-zp-frame-src` attributes on `node`
  // and its descendants using native `querySelectorAll` (since the membrane filters `data-zp-*`).
  function restoreParkedFrames(node) {
    if (!node || typeof node !== 'object') return;
    try {
      const nt = node.nodeType;
      if (nt === 1 && /^(IFRAME|FRAME)$/.test(node.nodeName || '')) restoreParkedFrame(node);
      const qsa = nt === 9 ? Native.querySelectorAll : nt === 11 ? Native.fragmentQuerySelectorAll : nt === 1 ? Native.elementQuerySelectorAll : null;
      if (!qsa) return;
      Array.prototype.forEach.call(qsa.call(node, 'iframe[data-zp-srcdoc], frame[data-zp-srcdoc], iframe[data-zp-frame-src], frame[data-zp-frame-src]'), restoreParkedFrame);
    } catch {}
  }
  function scanNavigationBackstop(root) {
    if (!root || !root.querySelectorAll) return;
    try {
      qsaOf(root,
        'a[href], area[href], form[action], input[formaction], button[formaction]'
      ).forEach(applyNavigationBackstop);
    } catch {}
    try {
      // Use `Native.elementQuerySelectorAll` so the stealth membrane does not filter out `data-zp-*` selectors.
      const qsa = Native.elementQuerySelectorAll || root.querySelectorAll;
      const found = qsa.call(root, 'iframe[data-zp-srcdoc], frame[data-zp-srcdoc]');
      Array.prototype.forEach.call(found, restorePendingSrcdoc);
      const pendingSrc = qsa.call(root, 'iframe[data-zp-frame-src], frame[data-zp-frame-src]');
      Array.prototype.forEach.call(pendingSrc, restorePendingFrameSrc);
    } catch {}
    // Rewrite `<style>` elements that were parsed before the observer attached or fell back in server-side `zp_css`.
    try { qsaOf(root, 'style').forEach(enforceStyleElementCSS); } catch {}
  }
  function installNavigationBackstop(w, docEl) {
    if (!w || !docEl) return;
    // Run an initial and idle sweep rather than a top-level attribute MutationObserver
    // to avoid renderer contention during SPA hydration.
    scanNavigationBackstop(docEl);
    if (typeof w.requestIdleCallback === 'function') {
      try { w.requestIdleCallback(() => scanNavigationBackstop(docEl), { timeout: 2000 }); } catch {}
    } else if (typeof w.setTimeout === 'function') {
      try { w.setTimeout(() => scanNavigationBackstop(docEl), 1000); } catch {}
    }
    // Re-sweep `<style>`, SW-less frames, parked frames, and `<meta name="referrer">`
    // on lifecycle events and delayed timers to cover streaming HTML parsing.
    const sweepPendingFrames = () => {
      try {
        const qsa = Native.elementQuerySelectorAll || docEl.querySelectorAll;
        Array.prototype.forEach.call(
          qsa.call(docEl, 'iframe[data-zp-frame-src], frame[data-zp-frame-src]'),
          restorePendingFrameSrc,
        );
        Array.prototype.forEach.call(
          qsa.call(docEl, 'iframe[data-zp-srcdoc], frame[data-zp-srcdoc]'),
          restorePendingSrcdoc,
        );
      } catch {}
    };
    const sweepStyles = () => {
      try { qsaOf(docEl, 'style').forEach(enforceStyleElementCSS); } catch {}
      sweepSWLessFrames(w);
      sweepPendingFrames();
      reportMetaReferrerPolicy();
    };
    try { w.document.addEventListener('DOMContentLoaded', sweepStyles); } catch {}
    try { w.addEventListener('load', sweepStyles); } catch {}
    if (typeof w.setTimeout === 'function') {
      for (const ms of [500, 1500, 3000]) { try { w.setTimeout(sweepStyles, ms); } catch {} }
    }
  }