
  function installBeacon() { if (!navigator.sendBeacon || !Native.fetch || !Native.Request || !Native.Headers) return; defineMethodOnProto(navigator, root.Navigator && root.Navigator.prototype, 'sendBeacon', function sendBeacon(url, data) { try { fetchThroughRuntime(url, { method: 'POST', body: data, keepalive: true, credentials: 'include', mode: 'no-cors' }).catch(()=>{}); return true; } catch { return false; } }); }
  // E4: registerProtocolHandler 계열. 실제로 네이티브에 넘기면 브라우저
  // 등록 UI 에 **프록시 오리진**이 노출되고 OS 핸들러가 프록시를 가리킨다.
  // 그렇다고 SecurityError 를 던지면 타깃이 같은 오리진 URL 로 등록하는
  // 정상 경로까지 죽는다. 네이티브 검증 규칙(스킴 safelist/web+ 접두, %s
  // 포함, 가상 오리진 동일성)은 그대로 적용하고, 통과하면 **아무 일 없이**
  // 성공 반환한다 — 사용자가 브라우저 프롬프트를 아직 안 누른 상태와 같은
  // 모양. isProtocolHandlerRegistered 는 영원히 'new' 를 돌린다.
  function installProtocolHandlerFacade() {
    const proto = root.Navigator && root.Navigator.prototype;
    if (!proto || typeof navigator.registerProtocolHandler !== 'function') return;
    const SAFELIST = new Set(['bitcoin','geo','im','irc','ircs','magnet','mailto','matrix','mms','news','nntp','openpgp4fpr','sip','sms','smsto','ssh','tel','urn','webcal','wtai','xmpp']);
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
      // 등록하지 않는다 — 브라우저 프롬프트에 프록시 오리진이 뜨는 것을 막는다.
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
  // element's own `target`, else the first `<base target>` of its document
  // (htmltx keeps `<base>`; only its href is neutralized, by CSP base-uri).
  // The attribute is read as written: nothing rewrites `target` any more.
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
    // Dangling-markup mitigation, as the spec has it.
    return /[\t\n\r]/.test(t) && t.includes('<') ? '_blank' : t;
  }
  // HTML "choosing a navigable". Names are searched in Chromium's order
  // (FrameTree::FindFrameForNavigation): this frame, its subtree, then the
  // whole page from the top. Proxied frames are all physically same-origin,
  // so the real tree is walkable; a window we cannot read is skipped. A
  // frame's name is its element's `name` attribute — a child's `window.name`
  // writes are virtual and never move the real browsing-context name.
  //   { self } · { frame: <iframe> } · { win: <ancestor> } · { open: name } (a new window)
  function chooseNavigable(target) {
    const t = String(target || '');
    const lower = t.toLowerCase();
    if (!t || lower === '_self') return { self: true };
    if (lower === '_blank') return { open: '_blank' };
    if (lower === '_top' || lower === '_parent') {
      let w = null;
      try { w = lower === '_top' ? root.top : root.parent; } catch {}
      return !w || w === root ? { self: true } : { win: w };
    }
    let own = null;
    try { own = root.name; } catch {}
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
  // The frame's real document — for membrane code. The page-facing
  // `contentDocument` is null for a frame of another site.
  function nativeFrameDocument(f) {
    const w = nativeFrameWindow(f);
    try { return w ? w.document : null; } catch { return null; }
  }
  // The same route `iframe.src = url` takes (activatedFrameURL), but the
  // frame's own Location moves, not its `src` attribute — natively a named
  // navigation leaves `src` alone. The incoming document boots its own
  // membrane; until then reads resolve through frameRouteTarget.
  function navigateFrameTo(frame, href) {
    activatedFrameURL(href, undefined, () => frameIsOpaque(frame)).then(url => {
      const win = nativeFrameWindow(frame);
      if (win) win.location.assign(url);
    }).catch(() => {});
  }
  // An ancestor navigates through ITS OWN membrane, exactly as page code's
  // `top.location = url` does (crossWindowLocation) — its history and route
  // land in its own state. The launcher at top level is the fallback.
  function navigateWindowTo(win, href) {
    const abs = targetURL(href);
    let get = null;
    try { get = win.__zp_get; } catch {}
    if (typeof get === 'function') {
      try { get(win, 'location').href = abs; return; } catch {}
    }
    try { win.location.assign(proxyViaURL(abs)); } catch {}
  }
  // A new window: `_blank` (with its implicit noopener) or a name no frame
  // carries. The opening page gets no handle, so the URL may be the launcher.
  function openNavigation(url, name) {
    if (!Native.open) return;
    try { Native.open(url, name, name === '_blank' ? 'noopener' : ''); } catch {}
  }
  // A popup's document, routed up front. OPEN_SHARE is what the launcher sends
  // after decrypting a share link; sent from here, the popup loads its document
  // directly — it used to run the launcher first, a page with no membrane that
  // the opener's handle could reach while it redirected.
  async function popupNavURL(raw, base = baseURL) {
    const target = targetURL(raw, base);
    const share = await ZP.encryptShareURL(target);
    rememberFrameRoute(share.encrypted, target);
    // A popup keeps the sandbox its opener lives under — and so its opaque origin — unless the page allowed
    // popups to escape it (the browser applies the flags either way; the origin is what we emulate).
    const flags = opaqueDocument ? sandboxFlags() : null;
    const opaque = opaqueDocument && !(flags && flags.has('allow-popups-to-escape-sandbox'));
    const reply = await ctx.bridge.send({ type: ZP.MSG.OPEN_SHARE, routeKey: share.encrypted, targetUrl: target, servers: activeServers, ...(opaque ? { opaque: true } : null) });
    return proxyOrigin + reply.path + shareFragmentForKey(share.key);
  }

  function installNavigationTraps() {
    // D1: javascript: URL delegated handler. htmltx transforms target
    // `<a href="javascript:CODE">` etc. into `<a href="javascript:void(0)"
    // data-zp-jsurl="<rewritten>" data-zp-jsurl-kind="anchor">`. Here we
    // capture clicks/submits on those elements and execute the rewritten
    // body using prelude-private `Native.FunctionCtor` so target code
    // never sees the eval/Function constructor.
    function runJSURL(el, ev) {
      if (!el || !el.getAttribute) return false;
      const code = el.getAttribute('data-zp-jsurl');
      if (!code) return false;
      try {
        // Wrap in IIFE to give the rewritten body its own scope. The
        // rewriter has already routed dangerous globals through __zp_get,
        // which is exposed on globalThis by installPhase2Membrane.
        Native.FunctionCtor('"use strict";\n' + code).call(globalThis);
      } catch {}
      if (ev) { ev.preventDefault(); ev.stopImmediatePropagation(); }
      return true;
    }
    // E1: `<a ping>` hyperlink auditing. htmltx/속성 훅은 ping 목록을
    // `data-zp-blocked-ping` 에 옮겨 브라우저의 직접 POST 를 끊는다 —
    // 그러면 네이티브와 달리 ping 이 아예 안 날아간다. 네이티브 의미를
    // 복원하되 transport 만 프록시로: 클릭 시 각 URL 로 POST 'PING'
    // (Content-Type: text/ping, Ping-From/Ping-To 헤더, keepalive)을
    // fetchThroughRuntime 으로 보낸다. 실패는 무시 — ping 은 fire-and-forget.
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
        // 2026-08-13 — same-document hash 이동에서는 전파를 끊지 않는다.
        // 실제 브라우저도 해시 이동과 페이지 핸들러 실행을 둘 다 한다.
        // 여기서 stopImmediatePropagation 을 부르면 `<a href="#tab">` 을
        // 탭/토글로 쓰는 흔한 React 패턴이 통째로 죽는다 (클릭이 문서까지
        // 도달하지 못해 delegated onClick 이 안 걸린다).
        updateVirtualHash(nav.hash);
        return;
      }
      if ((nav.frame || nav.win) && nav.href) {
        // Another browsing context navigates and this document stays (an
        // ancestor's: until that commits), so its own click handlers keep
        // running, as they do natively.
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
    // Resolve the form's real absolute target, NOT the rewritten attribute.
    //
    // htmltx rewrites `action` / `formaction` to the proxy-origin launcher
    // `<proxy>/zp/?via=<target>` (proxied_navigation_url) so the browser's
    // native UI never sees the target host. Reading that attribute back here
    // is fatal for GET: per HTML, a GET submit REPLACES the action URL's
    // query string with the form data set, which destroys `via=` and leaves
    // the proxy origin itself as the navigation target — the search box then
    // navigates to `<proxy>/zp/?query=...` and resolves to TARGET_CONNECT_FAILED
    // against proxy.localhost. The absolute target is stashed in urlMeta /
    // `data-zp-target-url`, exactly as the anchor click path reads it
    // (clickNavigationTarget), so use that first and fall back to the raw
    // attribute only for forms we never rewrote (e.g. JS-built, relative).
    //
    // The raw-attribute fallback needs one more step: a proxy-origin action is
    // NOT a target. htmltx writes the launcher onto `action` but does not always
    // leave a `data-zp-target-url` stash beside it — NAVER's login form
    // (`frmNIDLogin`) is exactly that shape: `action` is
    // `<proxy>/zp/?via=<login url>` with no stash. Handing that back makes
    // `targetURL()` faithfully dial `proxy.localhost:18080` and the submit dies
    // as TARGET_CONNECT_FAILED — i.e. logging in was impossible. So unwrap the
    // launcher back to its target. 되돌리기 규칙은 `deproxyURL` 한 곳에 있다.
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
      // Where the result loads: `formtarget`/`target`/`<base target>`. This
      // used to be ignored — every submission replaced THIS document, so a
      // form posting into an iframe (3-D Secure, embedded checkouts) took the
      // whole page with it.
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
        // The body rides the same pending submission; only the window that
        // loads `?zp_submit=` differs, and this document stays.
        const sent = proxyAbsoluteURL(ZP.makeSharePath(share.encrypted) + '?zp_submit=' + encodeURIComponent(reply.submitId) + shareFragmentForKey(share.key));
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
      // 같은 이유로 절대 URL 이어야 한다 — `<base href>` 가 있으면 폼 제출이
      // 프록시 밖으로 나간다.
      const submittedPath = proxyAbsoluteURL(activeProxyPath + '?zp_submit=' + encodeURIComponent(reply.submitId) + activeProxyFragment);
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
          // ★The raw href is the `?via=` launcher. Left to the browser, a named
          // frame loaded the LAUNCHER — the parent's sweep then contained it,
          // its URL facade decoded `via=`, and it redirected to
          // `proxy.localhost:<target port>`: CSP-blocked. The frame never
          // reached the target (2026-10-01). Frames take the proxied frame
          // route and ancestors navigate through their own membrane; only a
          // NEW window is left to the browser — the launcher works at top level.
          const dest = chooseNavigable(navigationTarget(el));
          if (dest.open) return null;
          frame = dest.frame || null;
          win = dest.win || null;
        }
        const raw = isAnchor ? Native.getAttribute.call(el, 'data-zp-target-url') || el.getAttribute('href') : typeof el.href === 'string' ? el.href : '';
        if (!raw) continue;
        // `href="#"` 또는 `href="#"` 단독은 NAVER 메뉴 같은 React onClick 핸들러
        // no-op anchor 패턴. preventDefault + stopImmediatePropagation 으로
        // 가로채면 React 가 onClick 받지 못해 메뉴 확장이 동작 안 함. skip 하여
        // 페이지가 처리하도록 위임. (실제 hash fragment 가 있는 `#section` 은
        // virtual hash update 유지.)
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
    defineOnProto(nav, proto, 'userAgent', () => TARGET_USER_AGENT);
    defineOnProto(nav, proto, 'appVersion', () => TARGET_APP_VERSION);
    defineOnProto(nav, proto, 'platform', () => TARGET_PLATFORM);
    // navigator.webdriver: real Chrome 148 returns `false`. WebView2
    // and CDP-controlled instances return `true`, which every modern
    // anti-bot WAF flags as a robot signal. Pin to `false` so target
    // pages can't distinguish ZeroProxy from a hand-driven Chrome.
    defineOnProto(nav, proto, 'webdriver', () => false);
    // navigator.userAgentData — UA 는 Chrome 으로 가려 놓고 여기를 안 가려서
    // **브랜드 목록이 호스트 셸을 그대로 불었다**. 실측(2026-08-16, 프록시된
    // example.com):
    //   navigator.userAgent      → …Chrome/151.0.0.0 Safari/537.36   (가려짐)
    //   navigator.userAgentData  → Chromium 151, Not=A?Brand 99,
    //                              Microsoft Edge WebView2 151, Microsoft Edge 151
    // 게다가 HTTP 로는 sec-ch-ua 에 "Google Chrome" 을 보낸다. 헤더와 JS 가
    // 서로 다른 브라우저를 말하는 것은 단일 신호보다 강한 tell 이다.
    // ZP.TARGET_SEC_CH_UA 를 파싱해서 그 목록 그대로 되돌려 준다 — 값이 한
    // 군데서만 나오므로 다음에 버전을 올려도 갈라지지 않는다.
    defineOnProto(nav, proto, 'userAgentData', () => virtualUserAgentData(w));
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
    // 실제 NavigatorUAData 인스턴스를 감싸지 않고 새로 만든다 — 감싸면 getter
    // 가 내부 슬롯을 요구해 Illegal invocation 이 난다.
    const brands = targetBrandList().map(b => ({ brand: b.brand, version: b.version }));
    // ★진짜 NavigatorUAData.prototype 을 상속시킨다(2026-08-24).
    // 값은 own 속성으로 덮으므로 내부 슬롯을 요구하는 프로토타입 게터는
    // 한 번도 불리지 않는다(그게 예전에 Illegal invocation 을 냈던 이유다).
    // 실측 — 대조군 대비 세 가지가 한 번에 맞는다:
    //   navigator.userAgentData instanceof NavigatorUAData   false → true
    //   .constructor.name                     Object → NavigatorUAData
    //   Object.prototype.toString.call(...)   [object Object] → [object NavigatorUAData]
    // 값은 **중간 프로토타입**에 접근자로 올린다. 인스턴스에 직접 얹으면
    // 실제 프로토타입의 읽기전용 접근자와 충돌해 던지고(측정: 'Cannot set
    // property brands of #<NavigatorUAData> which has only a getter'),
    // 무엇보다 진짜 인스턴스는 own 속성이 **0개**다(대조군 실측).
    const uaProto = (w.NavigatorUAData && w.NavigatorUAData.prototype) || Object.prototype;
    const shim = Object.create(uaProto);
    const data = Object.create(shim);
    const shimValues = {
      brands,
      mobile: false,
      platform: TARGET_PLATFORM === 'Win32' ? 'Windows' : TARGET_PLATFORM,
      toJSON() { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; },
      getHighEntropyValues(hints) {
        const full = {
          brands,
          mobile: false,
          platform: data.platform,
          platformVersion: '19.0.0',
          architecture: 'x86',
          bitness: '64',
          model: '',
          uaFullVersion: (brands.find(b => b.brand === 'Google Chrome') || brands[0] || {}).version + '.0.0.0',
          fullVersionList: brands.map(b => ({ brand: b.brand, version: b.version + '.0.0.0' })),
          wow64: false,
        };
        const picked = { brands: full.brands, mobile: full.mobile, platform: full.platform };
        for (const h of (hints || [])) if (h in full) picked[h] = full[h];
        return Promise.resolve(picked);
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

  // chrome.* surface — present on real Chrome / Edge-Chromium and
  // checked by anti-bot WAFs (Cloudflare, NAVER, Akamai). Missing on
  // strict-headless Chrome ≈ bot signal; Edge WebView2 exposes
  // `chrome.webview` for Tauri ipc, which is a worse tell (it spells
  // out the host shell). Build a plausible Chrome-148 chrome object
  // and replace whatever WebView2 dropped in.
  function installChromeFingerprintFacade(w) {
    // 아래에서 `configurable: false` 로 심으므로 같은 창에 두 번 부르면
    // delete 와 defineProperty 가 **매번 둘 다 던진다**. try/catch 가 삼켜서
    // 조용하지만 공짜가 아니다 — 실측으로 로드당 수백 번 던지고 있었다.
    // ★2026-08-16: `propertyLocked` 만 보고 물러나면 **WebView2 에서는 영원히
    // 설치가 안 된다**. 실측: 프록시된 페이지에서 `window.chrome` 의 디스크립터가
    // `{value: object, configurable: false, writable: true}` 였고, 키는
    // `app,csi,loadTimes,webview` — 즉 우리 퍼사드가 아니라 **WebView2 의 진짜
    // 객체**가 그대로 남아 `chrome.webview` 로 호스트 셸을 불고 있었다.
    // configurable:false 라 defineProperty 는 던지지만 writable:true 라
    // **대입은 통한다**. 그래서 잠겨 있어도 쓰기 가능하면 대입으로 갈아끼운다.
    // 이미 우리 것으로 갈아끼운 창이면 다시 만들지 않는다 — 잠긴 자리를 대입으로
    // 덮는 경로는 던지지 않으므로 "던지면 멈춘다" 식 멱등성이 없다. 신원 대신
    // **모양**으로 판정한다(퍼사드에는 webview 가 없다).
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
    // Drop the existing object (Tauri / WebView2 may have planted
    // `chrome.webview`, `chrome.webview.hostObjects`, etc. which all
    // signal "not a real browser"). Reassign via accessor so a future
    // delete attempt doesn't unwedge our installation.
    try { delete w.chrome; } catch {}
    try {
      defineMasked(w, 'chrome', {
        get() { return virtualChrome; },
        set() { /* swallow */ },
        enumerable: true, // real Chrome's window.chrome is enumerable
        configurable: false,
      });
    } catch {}
  }

  function buildChromeFingerprint(w) {
    // Reference: real Chrome 148 — `chrome.csi()`, `chrome.loadTimes()`,
    // `chrome.app = { isInstalled, InstallState, RunningState }`. Both
    // `csi` and `loadTimes` are deprecated for years but ALWAYS present
    // on a real Chrome page realm — checking their existence + return
    // shape is a cheap fingerprint probe.
    const perf = w.performance;
    const baseT = perf && typeof perf.timeOrigin === 'number' ? perf.timeOrigin : Date.now();
    const navT = perf && perf.timing ? perf.timing : null;
    function chromeCsi() {
      const now = Date.now();
      return {
        startE: Math.floor(baseT),
        onloadT: navT && navT.loadEventEnd ? navT.loadEventEnd : Math.floor(baseT),
        pageT: now - Math.floor(baseT),
        tran: 15, // CLIENT_REDIRECT — most common transition type
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
      // `runtime` is undefined off-extension on real Chrome — leaving
      // it out is the spec-correct stub. Probes that check
      // `typeof chrome.runtime === 'undefined'` see what they expect.
      // `webstore` legacy — also undefined.
      // `webview` — DELIBERATELY OMITTED. Tauri WebView2 plants this;
      // its presence is a strong host-shell tell. The accessor above
      // replaces the whole chrome object so the leak is gone.
    });
  }

  function installPopupHooks(w) {
    if (!Native.open) return;
    define(w, 'open', function(url = 'about:blank', target = '_blank', features) {
      const raw = String(url || 'about:blank');
      // D4: `open('javascript:…')` — 네이티브는 새 창의 컨텍스트에서 평가한다.
      // containment 가 걸린 about:blank 자식을 먼저 열고, 재작성된 코드를 그
      // 창의 realm 에서 실행하는 것이 정확하지만, 자식 쪽 globalEval 핸들을
      // 거기까지 끌고 가는 비용 대신 현재 realm 실행으로 근접시킨다 —
      // 평가가 아예 안 되는 것보다 의미적으로 가깝다.
      const jsMatch = /^\s*javascript:/i.exec(raw);
      if (jsMatch) {
        try { execGlobalScript(callPageRewriter(raw.slice(jsMatch[0].length), 'classic')); } catch {}
        return null;
      }
      const noopener = /(^|[\s,])no(opener|referrer)\b/i.test(String(features || ''));
      // A frame of this page or an ancestor, by name: it navigates as a link's
      // target does (clickNavigationTarget) and open() returns its window.
      // Native.open would park the share launcher in it. With noopener the
      // browser picks a new window instead.
      // Where the window is going decides what the page may hold: another
      // site's window is a restricted stand-in even while it is still blank.
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
      // noopener returns null natively and the page never holds the window, so
      // the routed URL can be opened directly once it exists. (It used to open
      // about:blank, get null back, and never navigate at all.)
      if (isHTTPURL(raw) && noopener) {
        popupNavURL(raw).then(u => { try { Native.open(u, target, features); } catch {} }).catch(() => {});
        return null;
      }
      let child;
      if (raw === 'about:blank' || raw === '') child = Native.open('about:blank', target, features);
      else if (isHTTPURL(raw)) { child = Native.open('about:blank', target, features); if (child) popupNavURL(raw).then(u => { child.location.href = u; }).catch(() => { try { child.close(); } catch {} }); }
      else child = Native.open('about:blank', target, features);
      // Every branch returns a live same-origin about:blank handle — without
      // containment, `child.fetch`/`child.eval`/`child.document` are raw
      // escape hatches until the routed document's own prelude boots. The http
      // branch navigates via `child.location.href` which containment leaves
      // untouched (it never masks `location`), so ordering is safe.
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
    // ★window 에 직접 심으면 안 된다 — 실제 브라우저의 `window` 에는
    // addEventListener/removeEventListener 가 **own 프로퍼티로 없다**
    // (EventTarget.prototype 에만 있다). 여기에 심었더니 프록시 realm 의
    // `Object.getOwnPropertyNames(window)` 가 직접 로드와 딱 이 둘만 달랐다
    // (실측 2026-08-16, 프록시된 example.com 대 직접 example.com: EXTRA =
    // addEventListener, removeEventListener). own/inherited 대조는 안티봇이
    // 실제로 보는 축이고, 이 프로젝트는 예전에도 여분 전역(`ZP`/`ZeroProxyRT`)
    // 때문에 네이버 프로버에 걸린 적이 있다.
    // 그래서 EventTarget.prototype 을 감싸고 **수신자가 이 창일 때만** message
    // 리스너를 래핑한다. 그러면 own 프로퍼티 집합이 진짜 브라우저와 같아진다.
    const ETProto = w.EventTarget && w.EventTarget.prototype;
    if (ETProto && !propertyLocked(ETProto, 'addEventListener')) {
      const rawAdd = ETProto.addEventListener;
      const rawRemove = ETProto.removeEventListener;
      if (typeof rawAdd === 'function' && typeof rawRemove === 'function') {
        // A bare `addEventListener("message", f)` has an undefined receiver, which
        // the browser takes to mean the window. It used to miss this wrapper, so
        // the handler saw the proxy's own origin in `e.origin` (a widget checking
        // its embedder's origin rejected every message) and a raw `e.source`.
        // (Each realm wraps its own EventTarget.prototype, so an undefined receiver
        // is always that realm's global.)
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
    // ★창 자신의 `postMessage` 를 **소유 속성으로 갈아끼우면 안 된다.**
    //
    // 그 래퍼는 이 창의 realm 함수다. 자식 프레임이 `parent.postMessage(...)` 를
    // 부르면 마지막으로 실행된 사용자 함수가 그 래퍼이므로 V8 이 incumbent realm
    // 을 **부모**로 잡고, 도착한 이벤트의 `e.source` 가 자식이 아니라 **부모 자신**
    // 이 된다. 그러면 `frameWindowOrigins.get(e.source)` 도 실패해서 `e.origin`
    // 까지 부모의 타깃 오리진으로 뒤집힌다.
    //
    // 실측(2026-08-25, CNN): 대조군은 20개 프레임에서 부모로 오는 메시지 **59건**
    // (bcx_local_storage_frame → https://assets.bounceexchange.com 포함).
    // 프록시는 **0건** — 4,700여 건 전부 `source === window` 로 도착했다.
    // 최소 재현으로도 확인: 부모 realm 래퍼를 끼우면 source 가 부모가 되고,
    // 네이티브를 자식 realm 에서 apply 하면 자식이 된다.
    //
    // 이것이 bounce 의 저장소 프레임 핸드셰이크를 죽이고 있었다 —
    // `e.origin === "https://" + bouncex.website.biu` 가 영영 거짓이라
    // bouncex.cookie(did/vid) 가 안 생기고 state/js → sspConfig → APS 가 막힌다.
    // SafeFrame 의 `e.source === iframe.contentWindow` 식별도 같은 이유로 깨진다.
    //
    // 페이지 코드가 보는 `postMessage` 는 멤브레인 get 트랩이 계속 래퍼를
    // 돌려주므로 targetOrigin 매핑은 그대로 산다. 부수로 지문 하나도 사라진다 —
    // 래퍼는 `length: 3` / `configurable: false` 였고 진짜는 `1` / `true` 다.
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
    // ★Document.prototype 가 아니라 Node.prototype 이다 — 실측(2026-09-14,
    // 프로토타입 모양 축): 브라우저는 baseURI 를 Node 인터페이스에 두고
    // Document/Element/Text 등이 상속한다. Document.prototype 에 own 으로
    // 심었더니 그 own 자체가 지문이었다(대조군엔 없음). 문서당 값 하나뿐이라
    // this 를 안 봐도 되는 건 그대로다 — 어떤 노드에서 읽어도 같은 문서 기준.
    defineAccessor(w.Node && w.Node.prototype, 'baseURI', () => baseURL);
    defineAccessor(w.Document && w.Document.prototype, 'referrer', () => virtualReferrer());
    defineAccessor(w.Document && w.Document.prototype, 'cookie', () => { if (opaqueDocument) throw opaqueDenied("Failed to read the 'cookie' property from 'Document'"); return documentCookieString(); }, v => { if (opaqueDocument) throw opaqueDenied("Failed to set the 'cookie' property on 'Document'"); const s = String(v); setDocumentCookie(s); sendCookieSet(s); });
    installURLProp(w.HTMLAnchorElement && w.HTMLAnchorElement.prototype, 'href');
    installURLProp(w.HTMLAreaElement && w.HTMLAreaElement.prototype, 'href');
    installURLProp(w.HTMLFormElement && w.HTMLFormElement.prototype, 'action');
    // `ping` 은 클릭 시 브라우저가 **직접** POST 하는 추적 비콘 목록이다.
    // 지원하지 않기로 한 표면인데(공백 구분 URL 목록이라 단일 URL 훅으로
    // 다룰 수 없고, 통과시키는 것 자체가 목적에 반한다), 지금까지는 리라이트가
    // 놓치고 **CSP 만** 막고 있었다 — 구멍 매트릭스의 유일한 `csp-only` 칸.
    // CSP 는 2선 방어다. 값을 삼켜서 브라우저가 요청을 만들지 못하게 한다.
    // 게터는 페이지가 되읽을 수 있게 저장값을 돌려준다(기능 감지 호환).
    // The stash attribute is the single source of truth for both the
    // property and setAttribute paths (a WeakMap here used to miss values
    // written with setAttribute, so `a.ping` read '' after them).
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
    // 2026-08-13 — 수동 서브리소스의 **프로퍼티 쓰기**도 훅한다.
    //
    // 여기에는 내비게이션 속성만 있었다. script 는 `installScriptProp`,
    // iframe 은 `installFrameProp` 으로 프로퍼티까지 막혀 있었는데 수동
    // 리소스만 비어 있었다 — `img.src = url` 은 setAttribute 훅을 타지 않고
    // 네이티브로 바로 속성에 꽂히므로 리라이트가 통째로 건너뛰어졌다.
    // `img-src *` 아래에서는 SW 가 받아 주니 겉으로는 멀쩡해서 안 보였다.
    //
    // 실제 사례: NAVER GNB(`gnb_utf8.nhn`)가
    //   gnbGetElementsByClassName(...)[0].children[1].src = "https://ssl.pstatic.net/…/myInfo.gif"
    // 로 넣는다. 장바구니에서 끝까지 원본 URL 로 남던 이미지 2장이 이것이었다.
    // 원본 URL 이 하나라도 남으면 CSP 를 `img-src 'self'` 로 못 죈다.
    // `link.href = url` 도 같은 구멍이다 — 2026-08-14 naver.com 실측:
    // shopad 모듈이 스타일시트를 프로퍼티 대입으로 붙여 원본 URL 이 남고
    // `style-src 'self'` 에 걸려 10건이 차단됐다. img.src 와 같은 계열.
    installURLProp(w.HTMLLinkElement && w.HTMLLinkElement.prototype, 'href');
    installURLProp(w.HTMLImageElement && w.HTMLImageElement.prototype, 'src');
    installURLProp(w.HTMLSourceElement && w.HTMLSourceElement.prototype, 'src');
    installURLProp(w.HTMLTrackElement && w.HTMLTrackElement.prototype, 'src');
    installURLProp(w.HTMLMediaElement && w.HTMLMediaElement.prototype, 'src');
    installURLProp(w.HTMLVideoElement && w.HTMLVideoElement.prototype, 'poster');
    // ★`img.srcset = …` / `link.imageSrcset = …` 프로퍼티 쓰기.
    //
    // 위 installURLProp 계열과 같은 구멍인데 srcset 만 빠져 있었다 — 프로퍼티
    // 대입은 setAttribute 훅을 안 타므로 리라이트가 통째로 건너뛰어지고,
    // **원본 타깃 URL 이 그대로 DOM 에 남는다**(2026-08-21 실측: 상대 후보는
    // 프록시 오리진으로 잘못 풀리고, 절대 후보는 원본 그대로 남아 CSP 만이
    // 방어였다). 반응형 이미지를 JS 로 붙이는 사이트에서는 이쪽이 주경로다.
    //
    // 세터는 훅된 setAttribute 에 위임한다 — 거기 srcset 분기가 후보 단위
    // 리라이트와 SW-less 업그레이드를 이미 한다. 게터는 페이지가 쓴 원본을
    // 돌려준다(없으면 실제 속성).
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
    // IDL writes that set a url_surfaces attribute WITHOUT going through the
    // setAttribute hook. Measured against every url_surfaces.json pair in
    // Chrome 152 (reflecting setter → content attribute); these three were the
    // unhooked ones. `inp.src = url` reached the target directly (CSP blocked
    // it, so the image just failed — e2e wire, 2026-09-29).
    installURLProp(w.HTMLInputElement && w.HTMLInputElement.prototype, 'src');
    // body.background is a PLAIN string reflection (not [URL]): natively it
    // reads back the raw text, and null becomes '' ([LegacyNullToEmptyString]).
    if (w.HTMLBodyElement && !propertyLocked(w.HTMLBodyElement.prototype, 'background')) {
      defineAccessor(w.HTMLBodyElement.prototype, 'background',
        function () { const v = this.getAttribute('background'); return v == null ? '' : v; },
        function (v) { this.setAttribute('background', v == null ? '' : String(v)); });
    }
    // SVG `href` is an SVGAnimatedString: `el.href.baseVal = url` writes the
    // attribute internally. Hand out a per-element Proxy of the real object
    // whose baseVal/animVal go through the hooked attribute path; every other
    // member reaches the real object as its own receiver, so brand checks,
    // `instanceof SVGAnimatedString` and `el.href === el.href` all hold.
    const svgHrefProxies = new WeakMap();
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
          // SVG2: `href` wins over `xlink:href` for both reading and baseVal.
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
    // ★`meta.httpEquiv = 'Content-Security-Policy'` — 프로퍼티 경로.
    //
    // 항목 7(srcset)에서 배운 것과 같은 자리다: 프로퍼티 대입은 setAttribute
    // 훅을 안 탄다. 위 분기만 두면 `m.setAttribute(...)` 는 막히는데
    // `m.httpEquiv = ...` 는 그대로 통과한다. 게터는 페이지가 쓴 값을 돌려준다.
    if (w.HTMLMetaElement && !propertyLocked(w.HTMLMetaElement.prototype, 'httpEquiv')) {
      defineAccessor(w.HTMLMetaElement.prototype, 'httpEquiv',
        function () {
          const blocked = Native.getAttribute.call(this, 'data-zp-blocked-http-equiv');
          if (blocked !== null && blocked !== undefined) return blocked;
          return Native.getAttribute.call(this, 'http-equiv') || '';
        },
        function (v) { this.setAttribute('http-equiv', v == null ? '' : String(v)); });
    }
    // `meta.content = '0;url=…'` — property writes bypass the setAttribute
    // hook entirely (reflection writes the attr internally). Route refresh
    // contents through the same proxied rewrite.
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
    // `el.onclick = 'code'` is deliberately NOT hooked. Modern browsers treat
    // a string assigned to an on* IDL property as null ([LegacyTreatNonObjectAsNull])
    // and never compile it — measured in Chrome 152: `d.onclick = 'x=9'` leaves
    // `d.onclick === null` and nothing runs. A hook that compiled the string
    // made the proxy run code no real browser runs (and was a one-line
    // detector). The native setter already does the right thing. Only the
    // content attribute (`setAttribute('onclick', …)`) compiles, and that path
    // goes through `__ZP_EXEC_EVENT`. ERRATA §E, 2026-09-29.
    // 2026-08-14 — object/embed. 서버측 htmltx 목록에는 ("object","data") /
    // ("embed","src") 가 있는데 페이지 realm 에만 없었다(정적 HTML 은 통과,
    // 런타임 대입만 샜다 — 오늘 세 번째 서버/런타임 비대칭).
    //
    // **주의: 이 두 줄만으로는 아무것도 안 고쳐진다.** 세터는 raw 값을
    // 훅된 setAttribute 로 위임하는데, 그 훅의 판정자인 `isURLBearing` 에
    // object/embed 가 없으면 그대로 통과한다. 반대로 isURLBearing 만 고치면
    // `o.data = url` 은 프로퍼티 대입이라 setAttribute 를 아예 안 탄다.
    // 두 곳을 **같이** 고쳐야 닫힌다 — 각각 따로 시도해 본 결과 둘 다 무증상
    // 실패였다.
    installURLProp(w.HTMLObjectElement && w.HTMLObjectElement.prototype, 'data');
    installURLProp(w.HTMLEmbedElement && w.HTMLEmbedElement.prototype, 'src');
    // HTMLHyperlinkElementUtils: protocol/host/hostname/port/pathname/search/
    // hash/origin/username/password. Virtualizing only `href` left every one of
    // these reading the RAW attribute, which since the 2026-06-06 escape fix is
    // a proxy-origin "?via=" launcher. Measured: `a.href='https://example.com/
    // x?q=1#f'` then `a.hostname` -> "proxy.localhost", `.pathname` -> "/zp/",
    // `.search` -> "?via=...", `.protocol` -> "http:".
    //
    // Two costs. It breaks the single most common URL-parsing idiom in the wild
    // (`a.href = u; a.hostname`) — target code reads a hostname that is not the
    // one it just wrote. And it hands page code our origin through a surface the
    // membrane exists to close, which is the same leak the `href` getter fixed.
    // Derive every component from the already-virtualized href instead.
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
      // With no URL the components are all '' except `protocol`, which reads
      // ':' — a Web IDL quirk worth matching exactly, since it is trivially
      // checkable and a wrong answer here is a fingerprint of its own.
      for (const name of ['protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']) {
        defineAccessor(
          proto,
          name,
          function () { const u = virt(this); return u ? u[name] : (name === 'protocol' ? ':' : ''); },
          function (v) {
            const u = virt(this);
            if (!u) return;
            try { u[name] = v; } catch { return; }
            // Route back through the href setter so the raw attribute keeps its
            // "?via=" form and the blocked-scheme checks still run.
            this[prop] = u.href;
          }
        );
      }
      // `origin` is readonly in Web IDL; `toString()` mirrors href.
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
          // An ABSENT attribute reads '' natively; an EMPTY one (`<a href="">`)
          // really does resolve to the document URL. The old `getAttribute() ||
          // virtualURL.href` collapsed those two cases, so a bare
          // `document.createElement('a').href` returned the page URL where every
          // browser returns '' — and each component getter inherited it.
          if (raw === null || raw === undefined) return '';
          // http(s) 가 아닌 절대 URL 은 브라우저처럼 그대로 (위 주석 참고).
          const inert = nonHTTPAbsoluteURL(raw);
          if (inert !== null) return inert;
          return targetURL(raw || virtualURL.href);
        },
        // Delegate the RAW value to the hooked Element.prototype.setAttribute.
        //
        // This setter used to duplicate that hook's work and then hand it the
        // already-proxied result (`this.setAttribute(attrName, proxyViaURL(t))`).
        // Because `this.setAttribute` IS the membrane hook, the proxy URL went
        // through URL rewriting a second time, which broke both halves of the
        // round trip (measured in the page realm on naver.com):
        //   a.href = '/probe'
        //   a.href              -> http://<proxy>/zp/?via=...   (want the target)
        //   a.getAttribute()    -> ?via=...%3Fvia%3D...         (wrapped twice)
        // The hook re-derives `targetURLForElement(this, <proxy url>)` from the
        // proxy URL and overwrites `urlMeta` with it, which is why the getter —
        // whose first source is `urlMeta` — started returning our own origin to
        // page code. One re-entrancy bug, both symptoms.
        //
        // Delegating is also strictly safer than calling Native.setAttribute
        // here: the hook owns the javascript:/blocked-scheme checks
        // (shouldBlockURLAttribute / hasContextBlockedScheme), resolves via the
        // element-aware targetURLForElement, stashes data-zp-target-url, and
        // applies the same "?via=" raw-attribute rewrite that keeps the target
        // out of browser-native UI (hover / middle-click / copy-link). Bypassing
        // it to fix the double-wrap would have opened an E1 escape instead.
        function (v) {
          this.setAttribute(attrName, v);
        }
      );
    }
  }