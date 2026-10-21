
  function installBeacon() { if (!navigator.sendBeacon || !Native.fetch || !Native.Request || !Native.Headers) return; defineMethodOnProto(navigator, root.Navigator && root.Navigator.prototype, 'sendBeacon', function sendBeacon(url, data) { try { fetchThroughRuntime(url, { method: 'POST', body: data, keepalive: true, credentials: 'include', mode: 'no-cors' }).catch(()=>{}); return true; } catch { return false; } }); }
  // Validate protocol-handler registration arguments per HTML spec rules
  // (scheme safelist or `web+` prefix, `%s` placeholder, and virtual same-origin
  // check) and return without invoking the native browser prompt, which would
  // expose the proxy origin to the user and register the proxy as an OS handler.
  function installProtocolHandlerFacade() {
    const proto = root.Navigator && root.Navigator.prototype;
    if (!proto || typeof navigator.registerProtocolHandler !== 'function') return;
    const SAFELIST = newSet(['bitcoin','geo','im','irc','ircs','magnet','mailto','matrix','mms','news','nntp','openpgp4fpr','sip','sms','smsto','ssh','tel','urn','webcal','wtai','xmpp']);
    const SCHEME_RE = /^[a-z][a-z0-9+\-.]*$/i;
    function validate(scheme, url) {
      const s = String(scheme).toLowerCase();
      if (!SCHEME_RE.test(s) || !(SAFELIST.has(s) || s.startsWith('web+'))) {
        throw new DOMException(`The scheme '${scheme}' is not allowed`, 'SecurityError');
      }
      const raw = String(url);
      if (!raw.includes('%s')) {
        throw new DOMException("The url provided does not contain '%s'", 'SyntaxError');
      }
      let u;
      try { u = new URL(raw, baseURL); } catch { throw new DOMException('Invalid URL', 'SyntaxError'); }
      if (u.origin !== virtualURL.origin) throw new DOMException('The url must be same-origin', 'SecurityError');
      return u;
    }
    defineMethodOnProto(navigator, proto, 'registerProtocolHandler', function registerProtocolHandler(scheme, url) {
      if (arguments.length < 2) throw new TypeError("Failed to execute 'registerProtocolHandler' on 'Navigator': 2 arguments required");
      validate(scheme, url);
    });
    defineMethodOnProto(navigator, proto, 'unregisterProtocolHandler', function unregisterProtocolHandler(scheme, url) {
      if (arguments.length < 2) throw new TypeError("Failed to execute 'unregisterProtocolHandler' on 'Navigator': 2 arguments required");
      validate(scheme, url);
    });
    if (typeof navigator.isProtocolHandlerRegistered === 'function') {
      defineMethodOnProto(navigator, proto, 'isProtocolHandlerRegistered', function isProtocolHandlerRegistered(scheme, url) {
        if (arguments.length < 2) throw new TypeError("Failed to execute 'isProtocolHandlerRegistered' on 'Navigator': 2 arguments required");
        validate(scheme, url);
        return 'new';
      });
    }
  }

  // HTML "get an element's target": a submitter's `formtarget`, else the
  // element's own `target`, else the first `<base target>` of its document.
  function navigationTarget(el, submitter) {
    let t = null;
    if (submitter && Native.hasAttribute.call(submitter, 'formtarget')) t = Native.getAttribute.call(submitter, 'formtarget');
    if (t === null) t = Native.getAttribute.call(el, 'target');
    if (t === null) {
      let base = null;
      try { base = Native.querySelector.call(el.ownerDocument || document, 'base[target]'); } catch {}
      t = base ? Native.getAttribute.call(base, 'target') : null;
    }
    t = t || '';
    // Dangling-markup mitigation per HTML spec.
    return /[\t\n\r]/.test(t) && t.includes('<') ? '_blank' : t;
  }
  // HTML "choosing a navigable". Names are searched in Chromium's order
  // (FrameTree::FindFrameForNavigation): this frame, its subtree, then the
  // whole page from the top. Proxied frames are physically same-origin,
  // so the real tree is walkable; a frame's name is its element's `name`
  // attribute because child `window.name` writes are virtualized.
  function chooseNavigable(target) {
    const t = String(target || '');
    const lower = t.toLowerCase();
    if (!t || lower === '_self') return { self: true };
    if (lower === '_blank') return { open: '_blank' };
    if (lower === '_top' || lower === '_parent') {
      let w = null;
      try { w = winGet(root, lower === '_top' ? 'top' : 'parent'); } catch {}
      return !w || w === root ? { self: true } : { win: w };
    }
    let own = null;
    try { own = winGet(root, 'name'); } catch {}
    if (own === t) return { self: true };
    let hit = frameNamed(document, t, 0);
    if (!hit) {
      let topDoc = null;
      try { if (root.top !== root) topDoc = root.top.document; } catch {}
      hit = frameNamed(topDoc, t, 0);
    }
    if (hit) return hit === root ? { self: true } : { frame: hit };
    return { open: t };
  }
  function frameNamed(doc, name, depth) {
    if (!doc || depth > 16) return null;
    let frames;
    try { frames = Native.querySelectorAll.call(doc, 'iframe,frame'); } catch { return null; }
    for (const f of frames) {
      const win = nativeFrameWindow(f);
      let n = null;
      try { n = Native.getAttribute.call(f, 'name'); } catch {}
      if (n === name) return win === root ? root : f;
      let sub = null;
      try { sub = win && win.document; } catch {}
      const hit = frameNamed(sub, name, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  function nativeFrameWindow(f) {
    const d = f.localName === 'frame' ? Native.frameContentWindow : Native.iframeContentWindow;
    try { return d && d.get ? d.get.call(f) : null; } catch { return null; }
  }
  // Return the frame's underlying document for internal membrane inspection.
  function nativeFrameDocument(f) {
    const w = nativeFrameWindow(f);
    try { return w ? w.document : null; } catch { return null; }
  }
  // Navigate a frame's Location to a routed share URL without mutating its `src` attribute.
  function navigateFrameTo(frame, href) {
    activatedFrameURL(href, undefined, () => frameIsOpaque(frame), frame).then(url => {
      const win = nativeFrameWindow(frame);
      if (win) win.location.assign(url);
    }).catch(() => {});
  }
  // Navigate an ancestor window through its own membrane `location` setter so
  // history and route state update in that window's realm.
  function navigateWindowTo(win, href) {
    const abs = targetURL(href);
    let get = null;
    try { get = win.__zp_get; } catch {}
    if (typeof get === 'function') {
      try { get(win, 'location').href = abs; return; } catch {}
    }
    try { win.location.assign(proxyViaURL(abs)); } catch {}
  }
  // Open a new top-level window for `_blank` or an unmatched target name.
  function openNavigation(url, name) {
    if (!Native.open) return;
    try { Native.open(url, name, name === '_blank' ? 'noopener' : ''); } catch {}
  }
  // Pre-register a popup's share route via `OPEN_SHARE` so the popup loads its
  // proxied document directly without exposing an uninstrumented launcher page.
  async function popupNavURL(raw, base = baseURL) {
    const target = targetURL(raw, base);
    const share = await ZP.encryptShareURL(target);
    rememberFrameRoute(share.encrypted, target);
    // Propagate the opener's opaque-origin sandbox state unless `allow-popups-to-escape-sandbox` is set.
    const flags = opaqueDocument ? sandboxFlags() : null;
    const opaque = opaqueDocument && !(flags && flags.has('allow-popups-to-escape-sandbox'));
    const reply = await ctx.bridge.send({ type: ZP.MSG.OPEN_SHARE, routeKey: share.encrypted, targetUrl: target, servers: activeServers, env: ZP.clientEnvOf(root), ...(opaque ? { opaque: true } : null) });
    return proxyOrigin + reply.path + shareFragmentForKey(share.key);
  }

  function installNavigationTraps() {
    // Execute `javascript:` URLs transformed into `data-zp-jsurl` attributes by htmltx
    // using the prelude-private `Native.FunctionCtor`.
    function runJSURL(el, ev) {
      if (!el || !el.getAttribute) return false;
      const code = el.getAttribute('data-zp-jsurl');
      if (!code) return false;
      try {
        // Execute the rewritten body in global scope.
        ttFunction(['"use strict";\n' + code]).call(globalThis);
      } catch {}
      if (ev) { ev.preventDefault(); ev.stopImmediatePropagation(); }
      return true;
    }
    // Dispatch `<a ping>` auditing requests stored in `data-zp-blocked-ping`
    // through `fetchThroughRuntime` so the browser does not send direct POSTs.
    function firePing(el, navHref) {
      const raw = el && Native.getAttribute.call(el, 'data-zp-blocked-ping');
      if (!raw) return;
      for (const tok of String(raw).split(/\s+/)) {
        if (!tok) continue;
        let u;
        try { u = new URL(tok, baseURL); } catch { continue; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        try {
          fetchThroughRuntime(u.href, {
            method: 'POST',
            body: 'PING',
            keepalive: true,
            credentials: 'include',
            referrerPolicy: 'no-referrer',
            headers: { 'Content-Type': 'text/ping', 'Ping-From': virtualURL.href, 'Ping-To': navHref || '' },
          }, { mode: 'no-cors' }).catch(() => {});
        } catch {}
      }
    }
    document.addEventListener('click', ev => {
      for (let el = ev.target; el && el !== document; el = el.parentElement) {
        if (el.hasAttribute && el.hasAttribute('data-zp-jsurl')) {
          if (runJSURL(el, ev)) return;
        }
      }
      const nav = clickNavigationTarget(ev);
      if (!nav) return;
      ev.preventDefault();
      if (nav.hash != null) {
        // Do not stop propagation on same-document hash navigation so delegated
        // click listeners on the document still fire.
        updateVirtualHash(nav.hash);
        return;
      }
      if ((nav.frame || nav.win) && nav.href) {
        // Navigating another browsing context leaves this document's click handlers running.
        firePing(nav.element, nav.href);
        if (nav.frame) navigateFrameTo(nav.frame, nav.href);
        else navigateWindowTo(nav.win, nav.href);
        return;
      }
      ev.stopImmediatePropagation();
      if (nav.href) { firePing(nav.element, nav.href); setVirtualLocation(nav.href); }
    }, true);
    document.addEventListener('submit', ev => {
      const f = ev.target;
      if (!f) return;
      if (f.hasAttribute && f.hasAttribute('data-zp-jsurl')) {
        if (runJSURL(f, ev)) return;
      }
      ev.preventDefault();
      submitForm(f, ev.submitter);
    }, true);
    if (Native.formSubmit) define(HTMLFormElement.prototype, 'submit', function() { submitForm(this); });
    if (Native.formRequestSubmit) define(HTMLFormElement.prototype, 'requestSubmit', function(submitter) { return Native.formRequestSubmit.apply(this, arguments); });
    if (Native.locationAssign) define(Location.prototype, 'assign', function(u) { setVirtualLocation(u); });
    if (Native.locationReplace) define(Location.prototype, 'replace', function(u) { setVirtualLocation(u, true); });
    if (Native.locationReload) define(Location.prototype, 'reload', function() { Native.locationReload(); });
    const histProto = root.History && root.History.prototype;
    defineMethodOnProto(history, histProto, 'pushState', function pushState(state, title, url) { return commitVirtualHistory(state, title, url, false); });
    defineMethodOnProto(history, histProto, 'replaceState', function replaceState(state, title, url) { return commitVirtualHistory(state, title, url, true); });
    window.addEventListener('popstate', () => { ctx.bridge.send({ type: ZP.MSG.RESOLVE_ENTRY, path: activeProxyPath }).then(reply => { activeEntryId = reply.entryId || activeEntryId; virtualURL = new URL(reply.targetUrl); baseURL = reply.baseUrl || virtualURL.href; explicitBaseURL = baseURL !== virtualURL.href ? baseURL : ''; if (typeof reply.scrollX === 'number' && typeof reply.scrollY === 'number') window.scrollTo(reply.scrollX, reply.scrollY); }).catch(()=>{}); }, true);
    let scrollTimer = 0;
    window.addEventListener('scroll', () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(() => ctx.bridge.send({ type: ZP.MSG.SCROLL_UPDATE, tabId: boot.tabId, entryId: activeEntryId, scrollX: window.scrollX, scrollY: window.scrollY }).catch(()=>{}), 100); }, { passive: true });
    function submitForm(form, submitter) { submitFormNavigation(form, submitter).catch(err => { const code = err && (err.code || err.message); if (code === 'REQUEST_BODY_TOO_LARGE') Native.locationAssign && Native.locationAssign(proxyAbsoluteURL(ZP.errorPath('REQUEST_BODY_TOO_LARGE'))); }); }
    // Resolve the form's target URL from `urlMeta` or `data-zp-target-url`, and
    // unwrap any proxy-origin `?via=` launcher URL on the raw attribute via
    // `deproxyURL` so GET submissions do not overwrite `?via=` with form query parameters.
    function submissionActionURL(form, submitter) {
      if (submitter && submitter.hasAttribute && submitter.hasAttribute('formaction')) {
        const fa = urlMeta.get(submitter)
          || Native.getAttribute.call(submitter, 'data-zp-target-url')
          || submitter.getAttribute('formaction');
        if (fa) return deproxyURL(fa, { fallback: 'any' });
      }
      const action = urlMeta.get(form)
        || Native.getAttribute.call(form, 'data-zp-target-url')
        || (form.getAttribute && form.getAttribute('action'));
      return (action && deproxyURL(action, { fallback: 'any' })) || virtualURL.href;
    }
    async function submitFormNavigation(form, submitter) {
      const raw = submissionActionURL(form, submitter);
      const method = String(submitter && submitter.getAttribute && submitter.getAttribute('formmethod') || form.getAttribute('method') || 'GET').toUpperCase();
      if (method === 'DIALOG') return;
      const target = new URL(targetURL(raw));
      urlMeta.set(form, target.href);
      // Resolve the target navigable from `formtarget`, `target`, or `<base target>`.
      const dest = chooseNavigable(navigationTarget(form, submitter));
      if (method === 'GET') {
        try {
          const data = submitter ? new Native.FormData(form, submitter) : new Native.FormData(form);
          const qs = new URLSearchParams();
          for (const [k, v] of data) qs.append(k, formEntryValue(v));
          const encoded = qs.toString();
          if (encoded) target.search = target.search ? target.search + '&' + encoded : encoded;
        } catch {}
        if (dest.frame) navigateFrameTo(dest.frame, target.href);
        else if (dest.win) navigateWindowTo(dest.win, target.href);
        else if (dest.open) openNavigation(proxyViaURL(target.href), dest.open);
        else navigateToTarget(target.href);
        return;
      }
      const serialized = await serializeFormSubmission(form, submitter, method, target.href);
      const share = await ZP.encryptShareURL(target.href);
      const entryId = 'e' + ZP.randomId();
      const reply = await ctx.bridge.send({ type: ZP.MSG.SUBMIT_PREPARE, tabId: boot.tabId, entryId, routeKey: share.encrypted, targetUrl: target.href, method, headers: serialized.headers, body: serialized.body, enctype: serialized.enctype, referrer: virtualURL.href });
      if (!dest.self) {
        // Route non-self submissions to the target window or frame while keeping this document in place.
        const sent = proxyAbsoluteURL(ZP.makeSharePath(share.encrypted) + '?zp_submit=' + nativeEncodeURIComponent(reply.submitId) + shareFragmentForKey(share.key));
        if (dest.open) { openNavigation(sent, dest.open); return; }
        rememberFrameRoute(share.encrypted, target.href);
        const w = dest.frame ? nativeFrameWindow(dest.frame) : dest.win;
        try { if (w) w.location.assign(sent); } catch {}
        return;
      }
      activeEntryId = entryId;
      activeProxyPath = ZP.makeSharePath(share.encrypted);
      activeRouteKey = share.encrypted;
      activeProxyFragment = shareFragmentForKey(share.key);
      // Use an absolute proxy URL so `<base href>` does not resolve the path against the target host.
      const submittedPath = proxyAbsoluteURL(activeProxyPath + '?zp_submit=' + nativeEncodeURIComponent(reply.submitId) + activeProxyFragment);
      if (Native.locationAssign) Native.locationAssign(submittedPath);
      else location.href = submittedPath;
    }
    async function serializeFormSubmission(form, submitter, method, targetHref) {
      const data = submitter ? new Native.FormData(form, submitter) : new Native.FormData(form);
      const enctype = normalizedFormEncoding(form, submitter);
      const headers = [];
      let bytes;
      if (enctype === 'multipart/form-data') {
        const req = new Native.Request(targetHref, { method, body: data });
        const ct = req.headers.get('content-type');
        if (ct) headers.push(['Content-Type', ct]);
        bytes = new Uint8Array(await req.arrayBuffer());
      } else {
        const text = enctype === 'text/plain' ? plainFormBody(data) : urlEncodedFormBody(data);
        const type = enctype === 'text/plain' ? 'text/plain;charset=UTF-8' : 'application/x-www-form-urlencoded;charset=UTF-8';
        headers.push(['Content-Type', type]);
        bytes = new TextEncoder().encode(text);
      }
      return { enctype, headers, body: ZP.bytesToBase64Url(bytes) };
    }
    function normalizedFormEncoding(form, submitter) {
      const raw = String(submitter && submitter.getAttribute && submitter.getAttribute('formenctype') || form.getAttribute('enctype') || 'application/x-www-form-urlencoded').toLowerCase();
      return raw === 'multipart/form-data' || raw === 'text/plain' ? raw : 'application/x-www-form-urlencoded';
    }
    function formEntryValue(v) { return v && typeof v === 'object' && typeof v.name === 'string' && typeof v.size === 'number' ? v.name : String(v); }
    function formLineEndings(value) { return String(value).replace(/\r\n|\r|\n/g, '\r\n'); }
    function urlEncodedFormBody(data) { const qs = new URLSearchParams(); for (const [k, v] of data) qs.append(formLineEndings(k), formLineEndings(formEntryValue(v))); return qs.toString(); }
    function plainFormBody(data) { const out = []; for (const [k, v] of data) out.push(formLineEndings(k) + '=' + formLineEndings(formEntryValue(v)) + '\r\n'); return out.join(''); }
    function clickNavigationTarget(ev) {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return null;
      for (let el = ev.target; el && el !== document; el = el.parentElement) {
        const isAnchor = el.matches && el.matches('a[href],area[href]');
        let frame = null, win = null;
        if (isAnchor) {
          if (el.hasAttribute('download')) return null;
          // Route named frames through the proxied frame route and ancestors through
          // their own membrane; only new top-level windows use the browser's `?via=` launcher.
          const dest = chooseNavigable(navigationTarget(el));
          if (dest.open) return null;
          frame = dest.frame || null;
          win = dest.win || null;
        }
        const raw = isAnchor ? Native.getAttribute.call(el, 'data-zp-target-url') || el.getAttribute('href') : typeof el.href === 'string' ? el.href : '';
        if (!raw) continue;
        // Leave bare `href="#"` anchors to the page's own click handlers;
        // non-empty hash fragments (`#section`) update the virtual hash.
        if (raw === '#') continue;
        if (raw[0] === '#' && !frame && !win) return { hash: raw, element: el };
        if (hasExecutableURLScheme(raw)) return { href: '', element: el };
        if (isHTTPURL(raw)) return { href: raw, element: el, frame, win };
      }
      return null;
    }
  }
  function installNavigatorIdentity(w) {
    const nav = w.navigator;
    if (!nav) return;
    const proto = w.Navigator && w.Navigator.prototype || Object.getPrototypeOf(nav);
    // Replace the native prototype accessor in place to preserve descriptor flags,
    // falling back to `defineOnProto` when the prototype lacks the property.
    const identity = (key, get) => { if (!replaceNativeAccessor(proto, key, get)) defineOnProto(nav, proto, key, get); };
    identity('userAgent', () => TARGET_USER_AGENT);
    identity('appVersion', () => TARGET_APP_VERSION);
    identity('platform', () => TARGET_PLATFORM);
    // Pin `navigator.webdriver` to `false` to match standard desktop Chrome.
    identity('webdriver', () => false);
    // Derive `navigator.userAgentData` from `ZP.TARGET_SEC_CH_UA` so JS brand
    // entries match the `Sec-CH-UA` HTTP request header and hide host WebView2 brands.
    identity('userAgentData', () => virtualUserAgentData(w));
    installChromeFingerprintFacade(w);
  }
  function targetBrandList() {
    if (cachedUADataBrands) return cachedUADataBrands;
    const out = [];
    const re = /"([^"]+)";v="([^"]+)"/g;
    let m;
    while ((m = re.exec(String(ZP.TARGET_SEC_CH_UA || '')))) out.push({ brand: m[1], version: m[2] });
    cachedUADataBrands = out;
    return out;
  }
  function virtualUserAgentData(w) {
    const real = w.navigator && Object.getPrototypeOf(w.navigator);
    // Construct a fresh object inheriting from `NavigatorUAData.prototype` via an
    // intermediate shim prototype so `instanceof NavigatorUAData`, `.constructor.name`,
    // and `Object.prototype.toString.call(...)` match native while own property count stays zero.
    const brands = targetBrandList().map(b => ({ brand: b.brand, version: b.version }));
    const uaProto = (w.NavigatorUAData && w.NavigatorUAData.prototype) || Object.prototype;
    const shim = Object.create(uaProto);
    const data = Object.create(shim);
    const shimValues = {
      brands,
      mobile: false,
      platform: TARGET_PLATFORM === 'Win32' ? 'Windows' : TARGET_PLATFORM,
      toJSON() { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; },
      // Return high-entropy values from the shared ZP helper used across page, worker, and Service Worker realms.
      getHighEntropyValues(hints) {
        return Promise.resolve(ZP.uaHighEntropyValues(hints, brands, data.platform));
      },
    };
    for (const k of Object.keys(shimValues)) {
      const v = shimValues[k];
      const desc = typeof v === 'function'
        ? { value: v, writable: true, enumerable: false, configurable: true }
        : { get: () => v, enumerable: true, configurable: true };
      try { Object.defineProperty(shim, k, desc); } catch {}
    }
    void real;
    return data;
  }

  // Replace `window.chrome` with a desktop Chrome facade (`csi`, `loadTimes`, `app`)
  // so host WebView2 properties such as `chrome.webview` are not exposed.
  function installChromeFingerprintFacade(w) {
    // Skip re-installation if the facade is already installed on this window.
    // When `window.chrome` is non-configurable but writable (as in WebView2),
    // fall back to direct assignment rather than `Object.defineProperty`.
    try {
      const cur = w.chrome;
      if (cur && typeof cur.csi === 'function' && !('webview' in cur)) return;
    } catch {}
    const locked = propertyLocked(w, 'chrome');
    let writableWhenLocked = false;
    if (locked) {
      try {
        const d = Object.getOwnPropertyDescriptor(w, 'chrome');
        writableWhenLocked = !!(d && d.writable);
      } catch {}
      if (!writableWhenLocked) return;
    }
    let virtualChrome;
    try {
      virtualChrome = buildChromeFingerprint(w);
    } catch { return; }
    if (!virtualChrome) return;
    if (locked) {
      try { w.chrome = virtualChrome; } catch {}
      return;
    }
    try { delete w.chrome; } catch {}
    try {
      defineMasked(w, 'chrome', {
        get() { return virtualChrome; },
        set() { /* swallow */ },
        enumerable: true,
        configurable: false,
      });
    } catch {}
  }

  function buildChromeFingerprint(w) {
    // Provide standard Chrome page-realm properties (`chrome.csi()`,
    // `chrome.loadTimes()`, `chrome.app`) without `chrome.runtime` or `chrome.webview`.
    const perf = w.performance;
    const baseT = perf && typeof perf.timeOrigin === 'number' ? perf.timeOrigin : Date.now();
    const navT = perf && perf.timing ? perf.timing : null;
    function chromeCsi() {
      const now = Date.now();
      return {
        startE: Math.floor(baseT),
        onloadT: navT && navT.loadEventEnd ? navT.loadEventEnd : Math.floor(baseT),
        pageT: now - Math.floor(baseT),
        tran: 15, // CLIENT_REDIRECT
      };
    }
    function chromeLoadTimes() {
      const rt = baseT / 1000;
      const lt = (navT && navT.loadEventEnd ? navT.loadEventEnd : Date.now()) / 1000;
      return {
        requestTime: rt,
        startLoadTime: rt,
        commitLoadTime: rt,
        finishDocumentLoadTime: lt,
        finishLoadTime: lt,
        firstPaintTime: lt,
        firstPaintAfterLoadTime: 0,
        navigationType: 'Other',
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
        npnNegotiatedProtocol: 'h2',
        wasAlternateProtocolAvailable: false,
        connectionInfo: 'h2',
      };
    }
    const app = Object.freeze({
      isInstalled: false,
      InstallState: Object.freeze({
        DISABLED: 'disabled',
        INSTALLED: 'installed',
        NOT_INSTALLED: 'not_installed',
      }),
      RunningState: Object.freeze({
        CANNOT_RUN: 'cannot_run',
        READY_TO_RUN: 'ready_to_run',
        RUNNING: 'running',
      }),
    });
    try { maskNativeFunction(chromeCsi, 'csi'); } catch {}
    try { maskNativeFunction(chromeLoadTimes, 'loadTimes'); } catch {}
    return Object.freeze({
      csi: chromeCsi,
      loadTimes: chromeLoadTimes,
      app,
    });
  }

  function installPopupHooks(w) {
    if (!Native.open) return;
    define(w, 'open', function(url = 'about:blank', target = '_blank', features) {
      const raw = String(url || 'about:blank');
      // Evaluate `open('javascript:...')` in the current realm after rewriting.
      const jsMatch = /^\s*javascript:/i.exec(raw);
      if (jsMatch) {
        try { execGlobalScript(callPageRewriter(raw.slice(jsMatch[0].length), 'classic')); } catch {}
        return null;
      }
      const noopener = /(^|[\s,])no(opener|referrer)\b/i.test(String(features || ''));
      // If `target` names an existing frame or ancestor and `noopener` is not set,
      // navigate that browsing context and return its origin-appropriate window handle.
      const destOrigin = isHTTPURL(raw) ? (() => { try { return new URL(targetURL(raw)).origin; } catch { return ''; } })() : '';
      const handleFor = win => (windowHandles ? windowHandles.forOrigin(win, destOrigin) : win);
      if (isHTTPURL(raw) && !noopener) {
        const dest = chooseNavigable(String(target));
        const win = dest.frame ? nativeFrameWindow(dest.frame) : dest.win || null;
        if (win) {
          if (dest.frame) navigateFrameTo(dest.frame, raw);
          else navigateWindowTo(win, raw);
          try { installNetworkContainment(win); } catch { return null; }
          return handleFor(win);
        }
      }
      // With `noopener`, open the routed URL directly and return `null` per spec.
      if (isHTTPURL(raw) && noopener) {
        popupNavURL(raw).then(u => { try { Native.open(u, target, features); } catch {} }).catch(() => {});
        return null;
      }
      let child;
      if (raw === 'about:blank' || raw === '') child = Native.open('about:blank', target, features);
      else if (isHTTPURL(raw)) { child = Native.open('about:blank', target, features); if (child) popupNavURL(raw).then(u => { child.location.href = u; }).catch(() => { try { child.close(); } catch {} }); }
      else child = Native.open('about:blank', target, features);
      // Contain the synchronous `about:blank` child window immediately so its
      // native APIs cannot be used as an escape hatch before its routed document boots.
      if (child) {
        try { installNetworkContainment(child); } catch { try { child.close(); } catch {} return null; }
      }
      return child ? handleFor(child) : child;
    });
  }

  function installPostMessageHooks(w) {
    if (!Native.windowAddEventListener || !Native.windowRemoveEventListener) return;
    function wrap(listener) {
      if (!listener || (typeof listener !== 'function' && typeof listener.handleEvent !== 'function')) return listener;
      if (messageListenerWrappers.has(listener)) return messageListenerWrappers.get(listener);
      const wrapped = function(ev) {
        const next = virtualizeMessageEvent(ev);
        return typeof listener === 'function' ? listener.call(this, next) : listener.handleEvent.call(listener, next);
      };
      messageListenerWrappers.set(listener, wrapped);
      return wrapped;
    }
    // Wrap `addEventListener` and `removeEventListener` on `EventTarget.prototype`
    // rather than as own properties on `window` so `Object.getOwnPropertyNames(window)`
    // matches native browsers.
    const ETProto = w.EventTarget && w.EventTarget.prototype;
    if (ETProto && !propertyLocked(ETProto, 'addEventListener')) {
      const rawAdd = ETProto.addEventListener;
      const rawRemove = ETProto.removeEventListener;
      if (typeof rawAdd === 'function' && typeof rawRemove === 'function') {
        // Treat an undefined or null receiver on a bare `addEventListener("message", fn)`
        // call as this realm's window.
        const forThisWindow = self => self === w || self === undefined || self === null;
        define(ETProto, 'addEventListener', function(type, listener, options) {
          if (forThisWindow(this) && String(type) === 'message') return rawAdd.call(w, String(type), wrap(listener), options);
          return rawAdd.apply(this, arguments);
        });
        define(ETProto, 'removeEventListener', function(type, listener, options) {
          if (forThisWindow(this) && String(type) === 'message') return rawRemove.call(w, String(type), messageListenerWrappers.get(listener) || listener, options);
          return rawRemove.apply(this, arguments);
        });
      }
    }
    // Keep the native `postMessage` on `w` rather than installing a parent-realm
    // wrapper as an own property. A parent-realm wrapper becomes the incumbent
    // function when a child frame calls `parent.postMessage(...)`, causing V8 to
    // set `MessageEvent.source` to the parent instead of the child. Page code still
    // receives the `targetOrigin`-mapping wrapper through the membrane get trap.
    void postMessageWrapperFor(w);
    restoreNativePostMessage(w);
    let onmessage = null;
    defineAccessor(w, 'onmessage', () => onmessage, value => {
      if (onmessage) Native.windowRemoveEventListener('message', messageListenerWrappers.get(onmessage) || onmessage);
      onmessage = typeof value === 'function' ? value : null;
      if (onmessage) Native.windowAddEventListener('message', wrap(onmessage));
    });
  }

  function usesRawURLAttribute(el, key, _localKey) {
    const tag = el && el.localName;
    const localKey = _localKey != null ? _localKey : attrLocalName(key);
    return localKey === 'href' && (tag === 'a' || tag === 'area') || localKey === 'action' && tag === 'form' || localKey === 'formaction' && (tag === 'input' || tag === 'button');
  }
  function installGetterMasking(w) {
    const locGet = p => () => new URL(virtualURL.href)[p];
    for (const p of ['href','protocol','host','hostname','port','pathname','search','hash','origin']) defineAccessor(w.Location && w.Location.prototype, p, locGet(p), p === 'href' ? v => { setVirtualLocation(v); } : p === 'hash' ? v => { updateVirtualHash(v); } : undefined);
    define(w.Location && w.Location.prototype, 'toString', function(){ return virtualURL.href; });
    defineAccessor(w.Document && w.Document.prototype, 'URL', () => virtualURL.href);
    defineAccessor(w.Document && w.Document.prototype, 'documentURI', () => virtualURL.href);
    // Define `baseURI` on `Node.prototype` where the DOM IDL declares it, rather than
    // adding an own property to `Document.prototype`.
    defineAccessor(w.Node && w.Node.prototype, 'baseURI', () => baseURL);
    defineAccessor(w.Document && w.Document.prototype, 'referrer', () => virtualReferrer());
    defineAccessor(w.Document && w.Document.prototype, 'cookie', () => { if (opaqueDocument) throw opaqueDenied("Failed to read the 'cookie' property from 'Document'"); return documentCookieString(); }, v => { if (opaqueDocument) throw opaqueDenied("Failed to set the 'cookie' property on 'Document'"); const s = String(v); setDocumentCookie(s); sendCookieSet(s); });
    installURLProp(w.HTMLAnchorElement && w.HTMLAnchorElement.prototype, 'href');
    installURLProp(w.HTMLAreaElement && w.HTMLAreaElement.prototype, 'href');
    installURLProp(w.HTMLFormElement && w.HTMLFormElement.prototype, 'action');
    // Stash `<a ping>` and `<area ping>` values in `data-zp-blocked-ping` and remove
    // the live `ping` attribute so the browser cannot send unproxied ping requests.
    for (const Ctor of [w.HTMLAnchorElement, w.HTMLAreaElement]) {
      const proto = Ctor && Ctor.prototype;
      if (!proto || propertyLocked(proto, 'ping')) continue;
      defineAccessor(proto, 'ping',
        function () { const v = Native.getAttribute.call(this, 'data-zp-blocked-ping'); return v == null ? '' : v; },
        function (v) {
          try { Native.setAttribute.call(this, 'data-zp-blocked-ping', String(v)); } catch {}
          try { Native.removeAttribute.call(this, 'ping'); } catch {}
        });
    }
    installURLProp(w.HTMLInputElement && w.HTMLInputElement.prototype, 'formAction');
    installURLProp(w.HTMLButtonElement && w.HTMLButtonElement.prototype, 'formAction');
    // Hook subresource URL IDL properties so direct property assignments route
    // through the `setAttribute` rewriter instead of writing raw target URLs to the DOM.
    installURLProp(w.HTMLLinkElement && w.HTMLLinkElement.prototype, 'href');
    installURLProp(w.HTMLImageElement && w.HTMLImageElement.prototype, 'src');
    installURLProp(w.HTMLSourceElement && w.HTMLSourceElement.prototype, 'src');
    installURLProp(w.HTMLTrackElement && w.HTMLTrackElement.prototype, 'src');
    installURLProp(w.HTMLMediaElement && w.HTMLMediaElement.prototype, 'src');
    installURLProp(w.HTMLVideoElement && w.HTMLVideoElement.prototype, 'poster');
    // Delegate `srcset` and `imageSrcset` property writes to `setAttribute` so
    // candidate URLs are rewritten and SW-less upgrades run; getters return the
    // author's original string.
    function installSrcsetProp(proto, prop, attrName) {
      if (!proto || propertyLocked(proto, prop)) return;
      defineAccessor(proto, prop,
        function () {
          const recalled = recalledSrcset(this, attrName);
          if (recalled !== undefined) return recalled;
          const raw = Native.getAttribute.call(this, attrName);
          return raw == null ? '' : raw;
        },
        function (v) { this.setAttribute(attrName, v == null ? '' : String(v)); });
    }
    installSrcsetProp(w.HTMLImageElement && w.HTMLImageElement.prototype, 'srcset', 'srcset');
    installSrcsetProp(w.HTMLSourceElement && w.HTMLSourceElement.prototype, 'srcset', 'srcset');
    installSrcsetProp(w.HTMLLinkElement && w.HTMLLinkElement.prototype, 'imageSrcset', 'imagesrcset');
    installURLProp(w.HTMLInputElement && w.HTMLInputElement.prototype, 'src');
    // `HTMLBodyElement.prototype.background` reflects as a plain string (`[LegacyNullToEmptyString]`), not a resolved URL.
    if (w.HTMLBodyElement && !propertyLocked(w.HTMLBodyElement.prototype, 'background')) {
      defineAccessor(w.HTMLBodyElement.prototype, 'background',
        function () { const v = this.getAttribute('background'); return v == null ? '' : v; },
        function (v) { this.setAttribute('background', v == null ? '' : String(v)); });
    }
    // Wrap `SVGAnimatedString` on SVG `href` getters in a per-element Proxy so
    // `baseVal` and `animVal` route through the hooked attribute methods while
    // preserving native brand checks.
    const svgHrefProxies = newWeakMap();
    const XLINK_NS = 'http://www.w3.org/1999/xlink';
    for (const Ctor of [w.SVGImageElement, w.SVGUseElement, w.SVGFEImageElement, w.SVGScriptElement, w.SVGAElement]) {
      const proto = Ctor && Ctor.prototype;
      const d = proto && Object.getOwnPropertyDescriptor(proto, 'href');
      if (!d || typeof d.get !== 'function' || !d.configurable) continue;
      const nativeHref = d.get;
      defineMasked(proto, 'href', {
        get() {
          const real = nativeHref.call(this);
          if (!real || typeof real !== 'object') return real;
          let p = svgHrefProxies.get(real);
          if (p) return p;
          const el = this;
          // Per SVG 2, `href` takes precedence over `xlink:href`.
          const read = () => {
            const v = Native.hasAttribute.call(el, 'href') ? el.getAttribute('href') : el.getAttributeNS(XLINK_NS, 'href');
            return v == null ? '' : v;
          };
          p = new Proxy(real, {
            get(t, k) { return k === 'baseVal' || k === 'animVal' ? read() : Reflect.get(t, k, t); },
            set(t, k, v) {
              if (k === 'baseVal') { el.setAttribute('href', v); return true; }
              return Reflect.set(t, k, v, t);
            },
          });
          svgHrefProxies.set(real, p);
          return p;
        },
        enumerable: d.enumerable, configurable: true,
      });
    }
    // Route `HTMLMetaElement.prototype.httpEquiv` and `content` property writes
    // through `setAttribute` so CSP neutralization and meta-refresh URL rewriting apply.
    if (w.HTMLMetaElement && !propertyLocked(w.HTMLMetaElement.prototype, 'httpEquiv')) {
      defineAccessor(w.HTMLMetaElement.prototype, 'httpEquiv',
        function () {
          const blocked = Native.getAttribute.call(this, 'data-zp-blocked-http-equiv');
          if (blocked !== null && blocked !== undefined) return blocked;
          return Native.getAttribute.call(this, 'http-equiv') || '';
        },
        function (v) { this.setAttribute('http-equiv', v == null ? '' : String(v)); });
    }
    if (w.HTMLMetaElement && !propertyLocked(w.HTMLMetaElement.prototype, 'content')) {
      defineAccessor(w.HTMLMetaElement.prototype, 'content',
        function () { return Native.getAttribute.call(this, 'content') || ''; },
        function (v) {
          const s = String(v);
          const eq = String(Native.getAttribute.call(this, 'http-equiv') || '').trim().toLowerCase();
          if (eq === 'refresh') { const next = proxiedRefreshContent(s); Native.setAttribute.call(this, 'content', next || s); return; }
          Native.setAttribute.call(this, 'content', s);
        });
    }
    // Leave `on*` IDL properties unhooked: WebIDL `[LegacyTreatNonObjectAsNull]`
    // converts string assignments to `null` without compiling them, while content
    // attribute writes (`setAttribute('onclick', ...)`) are rewritten by `Element.prototype.setAttribute`.
    installURLProp(w.HTMLObjectElement && w.HTMLObjectElement.prototype, 'data');
    installURLProp(w.HTMLEmbedElement && w.HTMLEmbedElement.prototype, 'src');
    // Derive `HTMLHyperlinkElementUtils` URL component accessors from the
    // virtualized `href` property so reading `a.hostname`, `a.pathname`, etc.
    // does not expose the underlying proxy-origin `?via=` launcher attribute.
    installURLComponents(w.HTMLAnchorElement && w.HTMLAnchorElement.prototype, 'href');
    installURLComponents(w.HTMLAreaElement && w.HTMLAreaElement.prototype, 'href');
    function installURLComponents(proto, prop) {
      if (!proto) return;
      const virt = (el) => {
        try {
          const h = el[prop];
          return h ? new Native.URL(h) : null;
        } catch { return null; }
      };
      // When no URL is set, WebIDL returns `''` for all components except `protocol`, which returns `':'`.
      for (const name of ['protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']) {
        defineAccessor(
          proto,
          name,
          function () { const u = virt(this); return u ? u[name] : (name === 'protocol' ? ':' : ''); },
          function (v) {
            const u = virt(this);
            if (!u) return;
            try { u[name] = v; } catch { return; }
            // Assign back through the `href` setter to preserve `?via=` rewriting and scheme checks.
            this[prop] = u.href;
          }
        );
      }
      // `origin` is readonly in WebIDL; `toString()` mirrors `href`.
      defineAccessor(proto, 'origin', function () { const u = virt(this); return u ? u.origin : 'null'; });
      define(proto, 'toString', function toString() { return this[prop]; });
    }
    function installURLProp(proto, prop) {
      if (!proto) return;
      const attrName = prop === 'formAction' ? 'formaction' : prop;
      defineAccessor(
        proto,
        prop,
        function () {
          const known = urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url');
          if (known) return known;
          const raw = this.getAttribute(attrName);
          // An absent attribute returns `''` natively, whereas an empty attribute (`<a href="">`)
          // resolves against the document URL.
          if (raw === null || raw === undefined) return '';
          const inert = nonHTTPAbsoluteURL(raw);
          if (inert !== null) return inert;
          return targetURL(raw || virtualURL.href);
        },
        // Delegate raw values to the hooked `Element.prototype.setAttribute` so
        // scheme checks, `urlMeta` stashing, and `?via=` / subresource rewriting
        // run once without double-wrapping.
        function (v) {
          this.setAttribute(attrName, v);
        }
      );
    }
  }