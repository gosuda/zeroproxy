  function initDocumentCookieRecords(cookieString) {
    for (const part of String(cookieString || '').split(/;\s*/)) {
      const eq = part.indexOf('=');
      if (eq > 0) documentCookieRecords.push({ name: part.slice(0, eq), value: part.slice(eq + 1), domain: virtualURL.hostname.toLowerCase(), hostOnly: true, path: '/', secure: virtualURL.protocol === 'https:', expires: Infinity });
    }
    documentCookie = documentCookieString();
  }
  // The document's own write: `document.cookie = …`, `cookieStore.set`.
  function setDocumentCookie(line) {
    const scope = virtualURL;
    const parts = String(line).split(';').map(p => p.trim()).filter(Boolean);
    if (!parts.length) return;
    const eq = parts[0].indexOf('=');
    if (eq <= 0) return;
    const rec = { name: parts[0].slice(0, eq), value: parts[0].slice(eq + 1), domain: scope.hostname.toLowerCase(), hostOnly: true, path: defaultCookiePath(scope), secure: false, expires: Infinity };
    for (let i = 1; i < parts.length; i++) {
      const [rawK, ...rest] = parts[i].split('=');
      const k = rawK.toLowerCase();
      const v = rest.join('=');
      if (k === 'domain' && v) { const d = v.replace(/^\./, '').toLowerCase(); if (scope.hostname.toLowerCase() === d || scope.hostname.toLowerCase().endsWith('.' + d)) { rec.domain = d; rec.hostOnly = false; } }
      else if (k === 'path' && v && v[0] === '/') rec.path = v;
      else if (k === 'secure') rec.secure = true;
      else if (k === 'samesite' && v) rec.sameSite = v.toLowerCase();
      else if (k === 'max-age') rec.expires = Date.now() + Math.max(0, Number(v) || 0) * 1000;
      else if (k === 'expires') { const ts = Date.parse(v); if (!Number.isNaN(ts)) rec.expires = ts; }
    }
    storeCookieRecord(rec);
  }
  // One cookie in the page's copy, and what it means for `document.cookie` and
  // `cookieStore`'s `change`. `expires` in the past is a deletion.
  function storeCookieRecord(rec) {
    const idx = documentCookieRecords.findIndex(r => r.name === rec.name && r.domain === rec.domain && r.path === rec.path);
    const deleted = rec.expires <= Date.now();
    if (deleted) { if (idx >= 0) documentCookieRecords.splice(idx, 1); }
    else if (idx >= 0) documentCookieRecords[idx] = rec;
    else documentCookieRecords.push(rec);
    documentCookie = documentCookieString();
    // cookieStore's `change` event observes the same jar as document.cookie.
    const item = cookieItemFromRec(rec);
    fireCookieChange(deleted ? [] : [item], deleted ? [item] : []);
  }
  function cookieRecordVisible(r, now, host, path) {
    return r.expires > now && (!r.secure || virtualURL.protocol === 'https:') && (r.hostOnly ? r.domain === host : host === r.domain || host.endsWith('.' + r.domain)) && (path === r.path || (path.startsWith(r.path) && (r.path.endsWith('/') || path[r.path.length] === '/')));
  }
  function visibleCookieRecords() {
    const now = Date.now();
    const host = virtualURL.hostname.toLowerCase();
    const path = virtualURL.pathname || '/';
    return documentCookieRecords.filter(r => cookieRecordVisible(r, now, host, path));
  }
  function documentCookieString() {
    return visibleCookieRecords().sort((a, b) => b.path.length - a.path.length).map(r => r.name + '=' + r.value).join('; ');
  }
  function defaultCookiePath(scope = virtualURL) { const p = scope.pathname || '/'; const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
  // Cookies the service worker's jar changed, as records (see `changeFor` there): from
  // the response of the page's own fetch / XHR (applied before the promise resolves),
  // and pushed to every document that can see them — a frame's navigation, an image or a
  // script, a sibling frame, another tab. The jar is the truth; this document keeps a
  // copy that `document.cookie` and `cookieStore` read. HttpOnly changes never arrive.
  // The same change can come twice (response and push): each id is applied once.
  const appliedCookieChanges = new Set();
  function applyCookieChanges(changes) {
    if (!Array.isArray(changes)) return;
    const host = virtualURL.hostname.toLowerCase();
    for (const c of changes) {
      try {
        if (!c || typeof c.name !== 'string' || typeof c.domain !== 'string') continue;
        if (c.id) {
          if (appliedCookieChanges.has(c.id)) continue;
          appliedCookieChanges.add(c.id);
          if (appliedCookieChanges.size > 512) appliedCookieChanges.delete(appliedCookieChanges.values().next().value);
        }
        // Only what this document could ever read: its own host, or a parent domain.
        if (!(c.hostOnly ? c.domain === host : host === c.domain || host.endsWith('.' + c.domain))) continue;
        const rec = {
          name: c.name, value: String(c.value), domain: c.domain, hostOnly: !!c.hostOnly,
          path: typeof c.path === 'string' && c.path[0] === '/' ? c.path : '/', secure: !!c.secure,
          expires: c.deleted ? 0 : (c.expires == null ? Infinity : Number(c.expires)),
        };
        if (c.sameSite) rec.sameSite = String(c.sameSite);
        storeCookieRecord(rec);
      } catch {}
    }
  }

  // ── virtual cookieStore ────────────────────────────────────────────────
  // CookieStore and document.cookie share one cookie jar natively; the raw
  // `window.cookieStore` would read/write REAL proxy-origin cookies (leak +
  // cross-target pollution). The facade is backed by documentCookieRecords.
  let virtualCookieStoreSingleton = null;
  const cookieStoreListeners = new Set();
  let cookieStoreOnChange = null;
  function cookieItemFromRec(r) {
    return Object.freeze({
      name: r.name, value: r.value,
      domain: r.hostOnly ? null : r.domain,
      path: r.path,
      expires: r.expires === Infinity ? null : r.expires,
      secure: !!r.secure, sameSite: r.sameSite || 'lax', partitioned: false,
    });
  }
  function fireCookieChange(changed, deleted) {
    if (!cookieStoreListeners.size && !cookieStoreOnChange) return;
    const ev = {
      type: 'change',
      changed: Object.freeze(changed.slice()),
      deleted: Object.freeze(deleted.slice()),
      target: virtualCookieStoreSingleton,
      currentTarget: virtualCookieStoreSingleton,
      srcElement: virtualCookieStoreSingleton,
      timeStamp: Date.now(),
    };
    for (const l of cookieStoreListeners) {
      try { typeof l === 'function' ? l.call(virtualCookieStoreSingleton, ev) : l.handleEvent.call(l, ev); } catch {}
    }
    if (cookieStoreOnChange) { try { cookieStoreOnChange.call(virtualCookieStoreSingleton, ev); } catch {} }
  }
  function virtualCookieStore() {
    if (virtualCookieStoreSingleton) return virtualCookieStoreSingleton;
    const CookieStoreProto = (root.CookieStore && root.CookieStore.prototype) || null;
    const facade = CookieStoreProto ? Object.create(CookieStoreProto) : {};
    function nameOf(arg) { return typeof arg === 'string' ? arg : (arg && arg.name); }
    definePropertiesMasked(facade, {
      get: { value: function get(arg) {
        const name = nameOf(arg);
        const rec = visibleCookieRecords().find(r => name == null || r.name === name);
        return Promise.resolve(rec ? cookieItemFromRec(rec) : null);
      }, enumerable: false, configurable: true, writable: true },
      getAll: { value: function getAll(arg) {
        const name = nameOf(arg);
        return Promise.resolve(visibleCookieRecords().filter(r => name == null || r.name === name).map(cookieItemFromRec));
      }, enumerable: false, configurable: true, writable: true },
      set: { value: function set(arg, value) {
        let name, val, opts = {};
        if (typeof arg === 'string') { name = arg; val = String(value); }
        else { opts = arg || {}; name = opts.name; val = String(opts.value); }
        if (name == null || name === '') return Promise.reject(normalizedError('TypeError'));
        let line = String(name) + '=' + val;
        if (opts.expires != null) line += '; expires=' + new Date(Number(opts.expires)).toUTCString();
        if (opts.domain) line += '; domain=' + String(opts.domain);
        if (opts.path) line += '; path=' + String(opts.path);
        if (opts.secure) line += '; secure';
        if (opts.sameSite) line += '; samesite=' + String(opts.sameSite);
        setDocumentCookie(line);
        ctx.bridge.send({ type: ZP.MSG.COOKIE_SET, tabId: boot.tabId, targetUrl: virtualURL.href, cookie: line }).catch(() => {});
        return Promise.resolve();
      }, enumerable: false, configurable: true, writable: true },
      delete: { value: function del(arg) {
        const name = nameOf(arg);
        if (name == null || name === '') return Promise.reject(normalizedError('TypeError'));
        let line = String(name) + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
        if (arg && typeof arg === 'object' && arg.path) line += '; path=' + String(arg.path);
        setDocumentCookie(line);
        ctx.bridge.send({ type: ZP.MSG.COOKIE_SET, tabId: boot.tabId, targetUrl: virtualURL.href, cookie: line }).catch(() => {});
        return Promise.resolve();
      }, enumerable: false, configurable: true, writable: true },
      addEventListener: { value: function addEventListener(type, listener) {
        if (type === 'change' && listener) cookieStoreListeners.add(listener);
      }, enumerable: false, configurable: true, writable: true },
      removeEventListener: { value: function removeEventListener(type, listener) {
        if (type === 'change') cookieStoreListeners.delete(listener);
      }, enumerable: false, configurable: true, writable: true },
      dispatchEvent: { value: function dispatchEvent(ev) {
        if (ev && ev.type === 'change') {
          for (const l of cookieStoreListeners) { try { typeof l === 'function' ? l.call(facade, ev) : l.handleEvent.call(l, ev); } catch {} }
          if (cookieStoreOnChange) { try { cookieStoreOnChange.call(facade, ev); } catch {} }
        }
        return true;
      }, enumerable: false, configurable: true, writable: true },
      onchange: {
        get() { return cookieStoreOnChange; },
        set(v) { cookieStoreOnChange = typeof v === 'function' ? v : null; },
        enumerable: false, configurable: true
      },
    });
    maskMethods(facade, ['get', 'getAll', 'set', 'delete', 'addEventListener', 'removeEventListener', 'dispatchEvent']);
    virtualCookieStoreSingleton = facade;
    return facade;
  }