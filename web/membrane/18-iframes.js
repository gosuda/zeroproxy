
  function installIframeHooks(w) {
    if (!w || !w.document || !w.Node || !w.Element) return;
    try {
      if (w[iframeHooksMarker]) return;
      Object.defineProperty(w, iframeHooksMarker, { value: true, enumerable: false, configurable: false });
    } catch {}
    const instrumentedWindows = new WeakSet();
    // Document level, capture phase: it runs before every listener the page adds
    // and before the element's own onload. NOT the window — a `load` event fired
    // at an element never propagates to the Window (DOM: a Document's parent is
    // null for `load`). Children have their own prelude.
    if (w === root) { try { root.document.addEventListener('load', swallowPlaceholderLoad, true); } catch {} }
    const nativeCreateElement = w === root ? Native.createElement : w.document.createElement.bind(w.document);
    const nativeCreateElementNS = w === root ? Native.createElementNS : w.document.createElementNS && w.document.createElementNS.bind(w.document);

    installFrameAccessors(w.HTMLIFrameElement && w.HTMLIFrameElement.prototype);
    installFrameAccessors(w.HTMLFrameElement && w.HTMLFrameElement.prototype);

    // Natively these live on Document.prototype, so defining them on the
    // document INSTANCE was both a fingerprint (own names a real document does
    // not have) and a coverage hole: a second document — from
    // document.implementation.createHTMLDocument() or DOMParser — kept the
    // untouched native and created script/iframe nodes with no instrumentation.
    //
    // Relocating needs `this`-correct dispatch. `nativeCreateElement` is BOUND
    // to w.document, so calling it for another document would put the element in
    // the wrong one; use the unbound prototype method with the real receiver
    // instead. Captured before we overwrite it.
    const docProtoForCreate = w.Document && w.Document.prototype;
    const rawCreateElement = docProtoForCreate && docProtoForCreate.createElement;
    const rawCreateElementNS = docProtoForCreate && docProtoForCreate.createElementNS;
    defineMethodOnProto(w.document, docProtoForCreate, 'createElement', function createElement(name, opts) {
      const n = String(name);
      if (/^(i?frame|script|worker|object|embed)$/i.test(n)) { try { zpTrace('createElement', n); } catch {} }
      const el = rawCreateElement ? rawCreateElement.call(this, n, opts) : nativeCreateElement(n, opts);
      if (/^i?frame$/i.test(n)) instrumentDescendantIframes(el);
      if (/^script$/i.test(n)) instrumentScriptElement(el);
      return el;
    });
    if (nativeCreateElementNS) defineMethodOnProto(w.document, docProtoForCreate, 'createElementNS', function createElementNS(ns, name, opts) {
      const el = rawCreateElementNS
        ? rawCreateElementNS.call(this, String(ns), String(name), opts)
        : nativeCreateElementNS(String(ns), String(name), opts);
      if (/^script$/i.test(String(name))) instrumentScriptElement(el);
      return el;
    });

    patchInsertion(w.Node.prototype, 'appendChild', w.Node.prototype.appendChild);
    patchInsertion(w.Node.prototype, 'insertBefore', w.Node.prototype.insertBefore);
    patchInsertion(w.Node.prototype, 'replaceChild', w.Node.prototype.replaceChild);
    for (const proto of [w.Element && w.Element.prototype, w.Document && w.Document.prototype, w.DocumentFragment && w.DocumentFragment.prototype]) {
      for (const method of ['append', 'prepend', 'before', 'after', 'replaceWith']) patchInsertion(proto, method, proto && proto[method]);
    }

    if (w.HTMLIFrameElement) { installFrameProp(w.HTMLIFrameElement.prototype, 'src'); installFrameProp(w.HTMLIFrameElement.prototype, 'srcdoc'); }
    if (w.HTMLFrameElement) installFrameProp(w.HTMLFrameElement.prototype, 'src');

    function patchInsertion(proto, name, nativeFn) {
      if (!proto || typeof nativeFn !== 'function') return;
      define(proto, name, function(...args) {
        prepareActivatingNodes(args);
        const frames = collectIframesFromArgs(args);
        const ret = nativeFn.apply(this, args);
        instrumentFrameList(frames);
        return ret;
      });
    }
    function installFrameAccessors(proto) {
      if (!proto) return;
      const win = frameDescriptor(proto, 'contentWindow');
      if (win && win.get) {
        try { defineMasked(proto, 'contentWindow', { get() { return containFrameWindow(win.get.call(this), this); }, configurable: false, enumerable: true }); } catch {}
      }
      const doc = frameDescriptor(proto, 'contentDocument');
      if (doc && doc.get) {
        try { defineMasked(proto, 'contentDocument', { get() { const childDoc = doc.get.call(this); if (childDoc && childDoc.defaultView) containFrameWindow(childDoc.defaultView, this); return childDoc; }, configurable: false, enumerable: true }); } catch {}
      }
    }
    function frameDescriptor(proto, prop) {
      for (let p = proto; p; p = Object.getPrototypeOf(p)) {
        const d = Object.getOwnPropertyDescriptor(p, prop);
        if (d) return d;
      }
      return null;
    }
    function containFrameWindow(childWin, frame) {
      if (!childWin) return childWin;
      try { if (childWin[networkContainmentMarker]) return childWin; } catch { if (instrumentedWindows.has(childWin)) return childWin; }
      instrumentedWindows.add(childWin);
      // 부모 쪽 `contentWindow.name` 은 iframe 의 name 속성이 초기값이다 —
      // 자식 realm 의 가상 스토어와는 별개로 부모 측 읽기 경로를 시드한다.
      try {
        const fn = frame && Native.getAttribute && Native.getAttribute.call(frame, 'name');
        if (fn) virtualFrameNames.set(childWin, fn);
      } catch {}
      // Its own prelude contains it, or is about to (ownsMembrane /
      // bootingProxiedDocument). Everything else is contained — including a
      // frame whose route is still pending: the old `data-zp-target-url`
      // exemption left that window, and every later one in the frame, raw.
      if (ownsMembrane(childWin)) return childWin;
      if (bootingProxiedDocument(childWin)) {
        // 자기 prelude 가 붙기 전 **사이 구간**에 부모가 `iframe.contentWindow
        // .postMessage(msg, 'https://<타깃>')` 를 쏘면 네이티브가 받는다 —
        // 수신 창의 실제 오리진이 프록시 오리진이라 타깃 오리진과 안 맞고
        // 메시지가 **조용히 버려진다**. naver 의 ndp-core 가 광고 슬롯에
        // 정확히 이걸 한다(로드당 9건). 매핑만은 미리 걸어 둔다.
        installEarlyPostMessage(childWin);
        return childWin;
      }
      try { installNetworkContainment(childWin); }
      catch (e) {
        try { let dg = root.__zp_diagnostics; try { if (root.top && root.top.__zp_diagnostics) dg = root.top.__zp_diagnostics; } catch {} if (dg && dg.length < 200) dg.push({ t: 'contain-fail', msg: String(e && (e.name + ':' + (e.message || e))).slice(0, 200), stack: String(e && e.stack || '').slice(0, 400) }); } catch {}
        instrumentedWindows.delete(childWin);
        try { frame && frame.remove && frame.remove(); } catch {}
        throw e;
      }
      // 여기가 SW-less 프레임을 발견하는 제자리다. 백스톱 타이머
      // (500/1500/3000ms)에만 기대면 그 뒤에 만들어지는 광고 프레임을 통째로
      // 놓친다 — 실측에서 같은 페이지가 로드마다 되기도 하고 안 되기도 했다.
      try { documentIsSWLess(childWin.document); } catch {}
      return childWin;
    }
    function installFrameProp(proto, prop) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) return;
      try {
        defineMasked(proto, prop, {
          get: prop === 'srcdoc'
            ? function () { return srcdocMeta.has(this) ? srcdocMeta.get(this) : d.get.call(this); }
            : function () {
              const raw = Native.getAttribute.call(this, prop);
              if (raw === null) return '';
              const known = urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url');
              return known || deproxyURL(d.get.call(this));
            },
          set(v) {
            if (prop === 'srcdoc') setInjectedSrcdoc(this, v);
            else this.setAttribute(prop, v);
            instrumentIframe(this);
          },
          configurable: false
        });
        // srcdoc 게터를 JS 함수로 갈아끼웠으므로 toString 위장을 같이 건다 —
        // 안 하면 "게터 소스를 읽어 본다" 는 흔한 검사에 우리만 튄다.
        const installed = Object.getOwnPropertyDescriptor(proto, prop);
        if (installed && typeof installed.get === 'function' && installed.get !== d.get) toStringMap.set(installed.get, nativeAccessorSource('get', prop));
        if (installed && typeof installed.set === 'function') toStringMap.set(installed.set, nativeAccessorSource('set', prop));
      } catch {}
    }
  }
  function prepareActivatingNodes(args) {
    for (const node of args || []) prepareActivatingNode(node);
  }
  function prepareActivatingNode(node) {
    if (!node || typeof node !== 'object') return;
    if ((node.nodeName || '').toUpperCase() === 'SCRIPT') prepareScriptElement(node);
    if (/^(IFRAME|FRAME)$/.test(node.nodeName || '')) sanitizeFrameSandbox(node);
    if (node.querySelectorAll) {
      const scripts = node.querySelectorAll('script');
      for (let i = 0; i < scripts.length; i++) prepareScriptElement(scripts[i]);
      const frames = node.querySelectorAll('iframe,frame');
      for (let i = 0; i < frames.length; i++) sanitizeFrameSandbox(frames[i]);
    }
  }
  function collectIframesFromArgs(args) {
    let frames = null;
    for (const node of args) frames = collectIframes(node, frames);
    return frames;
  }
  function collectIframes(node, frames) {
    if (!node || typeof node !== 'object') return frames;
    if (/^(IFRAME|FRAME)$/.test(node.nodeName || '')) {
      if (!frames) frames = [];
      frames.push(node);
    }
    if (node.querySelectorAll) {
      const descendants = node.querySelectorAll('iframe,frame');
      for (let i = 0; i < descendants.length; i++) {
        if (!frames) frames = [];
        frames.push(descendants[i]);
      }
    }
    return frames;
  }
  // ── routing a frame's `src` ─────────────────────────────────────────────
  // A frame's `src` can never hold the target URL — the browser would load it
  // directly — so it holds a proxy share route, and a route needs an async round
  // trip (encrypt, register with the service worker). The old code parked the
  // frame on an `about:blank` placeholder meanwhile, which cost the page one
  // extra `load` event and, for a frame already showing a document, one extra
  // joint-history entry per navigation (an inline onload on a parsed
  // `<iframe src>` ran three times; native: once).
  //
  // Now a frame that is attached and already shows a routed document keeps it
  // until the new route is ready — natively the old page stays until the new
  // one commits, too. Every other frame gets the placeholder: a detached one
  // may be inserted before the route is ready and must not load the raw URL,
  // and the `src` attribute has to EXIST synchronously — attachAttributeNode,
  // setAttributeNode and friends run the hooked setter and read the attribute
  // back. The placeholder's `load` is swallowed (swallowPlaceholderLoad).
  function frameShowsRoutedDocument(el, key) {
    let cur = null;
    try { cur = Native.getAttribute.call(el, key); } catch {}
    if (!cur) return false;
    try { const u = new Native.URL(cur, proxyOrigin); return u.origin === proxyOrigin && ZP.isSharePath(u.pathname); } catch { return false; }
  }
  // `keepDocument` is false for the mutation-observer backstop: there the
  // attribute was written without our hook and may hold the raw URL right now.
  function routeFrameSrc(el, key, target, keepDocument) {
    const seq = (frameRouteSeq.get(el) || 0) + 1;
    frameRouteSeq.set(el, seq);
    if (!(keepDocument && el.isConnected && frameShowsRoutedDocument(el, key))) {
      Native.setAttribute.call(el, key, 'about:blank');
      pendingFrameRoutes.add(el);
    }
    activatedFrameURL(target).then(u => {
      if (frameRouteSeq.get(el) !== seq) return;
      Native.setAttribute.call(el, key, u);
      rememberFrameOrigin(el);
    }).catch(() => {
      // No route, no document. Give the page the `load` it would have had so it
      // is not left waiting on a frame that stays blank.
      if (frameRouteSeq.get(el) !== seq) return;
      pendingFrameRoutes.delete(el);
      try { el.dispatchEvent(new Event('load')); } catch {}
    });
  }
  // A later `src` that is not a routed target (about:blank, javascript:) wins
  // over a route still in flight, as it does natively.
  function cancelFrameRoute(el) {
    frameRouteSeq.set(el, (frameRouteSeq.get(el) || 0) + 1);
    pendingFrameRoutes.delete(el);
  }
  // The placeholder page's `load` is not the frame's load. Frames still waiting
  // for their route — a placeholder set by routeFrameSrc, or a parsed frame
  // whose `src` htmltx moved to data-zp-frame-src — report a blank document; the
  // routed document's own load passes and ends the wait.
  function swallowPlaceholderLoad(ev) {
    const f = ev.target;
    try { if (!f || f.nodeType !== 1 || (f.localName !== 'iframe' && f.localName !== 'frame')) return; } catch { return; }
    let pending = pendingFrameRoutes.has(f);
    if (!pending) { try { pending = Native.hasAttribute.call(f, 'data-zp-frame-src'); } catch {} }
    if (!pending) return;
    let blank = false;
    try { const win = nativeFrameWindow(f); blank = !!win && String(Native.documentURLDesc.get.call(win.document)) === 'about:blank'; } catch {}
    if (blank) ev.stopImmediatePropagation();
    else pendingFrameRoutes.delete(f);
  }
  function instrumentFrameList(frames) { if (frames) for (const frame of frames) instrumentIframe(frame); }
  function instrumentDescendantIframes(node) { instrumentFrameList(collectIframes(node, null)); }
  function instrumentIframe(frame) {
    if (!frame || !/^(IFRAME|FRAME)$/.test(frame.nodeName || '')) return;
    try {
      const src = Native.getAttribute.call(frame, 'src');
      try { zpTrace('iframe', (src || 'about:blank').slice(0, 160)); } catch {}
      rememberFrameOrigin(frame);
      // The blank page in front of a pending route is contained too: Chrome
      // gives the routed document a fresh Window (measured 2026-10-01), so
      // nothing installed here reaches it — while skipping left the blank page
      // itself raw (see bootingProxiedDocument).
      if ((!src || /^about:blank$/i.test(src)) && frame.contentWindow) installNetworkContainment(frame.contentWindow);
      installSafeFrameResizeShim(frame);
    } catch { try { frame.remove(); } catch {} }
  }
  // NAVER GFP simple-bridge SafeFrame-emulation ads: iframe.name carries
  // {evtType:'sf-init', iFrameId, msgToken, adm, isFluid:true, ...} and the
  // host (gfp-nda.js handleMsgEvt) waits for {evtType:'sf-resized',
  // params:{frameHeight}} to apply iframe.style.height. But the non-SafeFrame
  // branch (forceSafeFrame=false) loads only gfp-bridge.js inside — pure
  // tracking, no ResizeObserver, no sf-resized sender. Result: ad body
  // renders inside but iframe stays height:0. Direct parent-side height
  // mirroring via ResizeObserver+MutationObserver fills the gap without
  // touching NAVER's message protocol — host's own update path is still
  // available when SF_RESIZED arrives by any other route.
  function installSafeFrameResizeShim(frame) {
    if (!frame || !frame.style || !Native.getAttribute) return;
    try { zpTrace('sfShim:enter'); } catch {}
    let init = null;
    try {
      const name = Native.getAttribute.call(frame, 'name');
      if (!name || name.length < 2 || name[0] !== '{') return;
      init = JSON.parse(name);
    } catch { return; }
    if (!init || init.evtType !== 'sf-init') return;
    try { if (frame[safeFrameShimMarker]) return; Object.defineProperty(frame, safeFrameShimMarker, { value: true, enumerable: false, configurable: false }); } catch {}
    let lastH = 0;
    const apply = () => {
      try {
        const doc = frame.contentDocument;
        if (!doc || !doc.body) return;
        // Body in non-SafeFrame iframe wraps a banner ad. Use max of common
        // height signals — images load late so we want largest stable size.
        const b = doc.body;
        const h = Math.max(b.scrollHeight || 0, b.offsetHeight || 0, doc.documentElement ? (doc.documentElement.scrollHeight || 0) : 0);
        if (h > 0 && h !== lastH) {
          lastH = h;
          frame.style.height = h + 'px';
        }
      } catch {}
    };
    let tries = 0;
    const start = () => {
      let doc = null;
      try { doc = frame.contentDocument; } catch {}
      if (!doc || !doc.body) {
        if (tries++ < 100) try { root.setTimeout(start, 50); } catch {}
        return;
      }
      // Poll: ResizeObserver across realms is unreliable for image-loaded
      // reflow in non-SafeFrame ads. Adaptive backoff — height 안 바뀌면
      // interval 점진 증가 (200→400→800→1600→2000ms cap), 바뀌면 reset.
      // Per-tick `scrollHeight`/`offsetHeight` 가 layout reflush 강제하므로
      // backoff 가 cumulative reflow cost 를 크게 줄임 (3-5 SafeFrame iframes
      // 가 영구 200ms polling 하면 reflow noise 누적). image load event 가
      // 별도 hook 으로 작동하므로 backoff 가 첫 안정화 후 reflow 누락 없음.
      try {
        let interval = 200;
        let stableTicks = 0;
        const tick = () => {
          const before = lastH;
          apply();
          if (lastH === before) {
            stableTicks++;
            if (stableTicks >= 3 && interval < 2000) interval = Math.min(interval * 2, 2000);
          } else {
            stableTicks = 0;
            interval = 200;
          }
          try { root.setTimeout(tick, interval); } catch {}
        };
        tick();
      } catch {}
      // Also hook image load events for instant snap after image arrival.
      try {
        const imgs = doc.querySelectorAll('img');
        for (let i = 0; i < imgs.length; i++) {
          try { imgs[i].addEventListener('load', apply, { once: true }); } catch {}
        }
      } catch {}
    };
    start();
  }