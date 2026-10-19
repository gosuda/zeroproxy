
  function installIframeHooks(w) {
    if (!w || !w.document || !w.Node || !w.Element) return;
    try {
      if (w[iframeHooksMarker]) return;
      Object.defineProperty(w, iframeHooksMarker, { value: true, enumerable: false, configurable: false });
    } catch {}
    const instrumentedWindows = newWeakSet();
    // Listen on document in capture phase so placeholder load events can be stopped before page listeners run (element load events do not bubble to Window).
    if (w === root) { try { root.document.addEventListener('load', swallowPlaceholderLoad, true); } catch {} }
    const nativeCreateElement = w === root ? Native.createElement : w.document.createElement.bind(w.document);
    const nativeCreateElementNS = w === root ? Native.createElementNS : w.document.createElementNS && w.document.createElementNS.bind(w.document);

    installFrameAccessors(w.HTMLIFrameElement && w.HTMLIFrameElement.prototype);
    installFrameAccessors(w.HTMLFrameElement && w.HTMLFrameElement.prototype);

    // Define createElement and createElementNS on Document.prototype rather than the document instance so secondary documents (DOMParser, createHTMLDocument) also instrument created elements.
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
    // Hook all DOM insertion methods so script and iframe nodes are prepared before reaching the live document.
    for (const proto of [w.Element && w.Element.prototype, w.Document && w.Document.prototype, w.DocumentFragment && w.DocumentFragment.prototype, w.CharacterData && w.CharacterData.prototype]) {
      for (const method of ['append', 'prepend', 'replaceChildren', 'before', 'after', 'replaceWith']) patchInsertion(proto, method, proto && proto[method]);
    }
    if (w.Element) patchInsertion(w.Element.prototype, 'insertAdjacentElement', w.Element.prototype.insertAdjacentElement);
    if (w.Range) patchInsertion(w.Range.prototype, 'insertNode', w.Range.prototype.insertNode);

    if (w.HTMLIFrameElement) { installFrameProp(w.HTMLIFrameElement.prototype, 'src'); installFrameProp(w.HTMLIFrameElement.prototype, 'srcdoc'); installFrameSandboxProp(w.HTMLIFrameElement.prototype); }
    if (w.HTMLFrameElement) installFrameProp(w.HTMLFrameElement.prototype, 'src');

    function patchInsertion(proto, name, nativeFn) {
      if (!proto || typeof nativeFn !== 'function') return;
      const hook = function(...args) {
        prepareActivatingNodes(args);
        const frames = collectIframesFromArgs(args);
        const ret = nativeFn.apply(this, args);
        // Restore frames whose src was parked while inside an inert document.
        if (frames) for (const frame of frames) restoreParkedFrame(frame);
        instrumentFrameList(frames);
        return ret;
      };
      define(proto, name, hook);
      try { Object.defineProperty(hook, 'length', { value: nativeFn.length, configurable: true }); } catch {}
    }
    function installFrameAccessors(proto) {
      if (!proto) return;
      const win = frameDescriptor(proto, 'contentWindow');
      if (win && win.get) {
        // Return a cross-origin Window handle when the frame's virtual origin differs from the embedder's.
        try {
          defineMasked(proto, 'contentWindow', {
            get() {
              const raw = containFrameWindow(win.get.call(this), this);
              return windowHandles ? windowHandles.forWindow(raw, this) : raw;
            },
            configurable: false, enumerable: true
          });
        } catch {}
      }
      const doc = frameDescriptor(proto, 'contentDocument');
      if (doc && doc.get) {
        try {
          defineMasked(proto, 'contentDocument', {
            get() {
              const childDoc = doc.get.call(this);
              const childWin = childDoc && childDoc.defaultView;
              if (childWin) {
                containFrameWindow(childWin, this);
                if (windowHandles && windowHandles.isCrossOrigin(childWin, this)) return null;
              }
              return childDoc;
            },
            configurable: false, enumerable: true
          });
        } catch {}
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
      // Leave opaque-origin frames uninstrumented; they either boot their own prelude or cannot run scripts.
      if (frame && frameHasOpaqueMark(frame)) return childWin;
      // A site frame lives at a real origin of its own: its window is cross-origin to the browser, boots its own membrane, and is none of
      // this realm's business.
      if (!windowReachable(childWin)) return childWin;
      try { if (childWin[networkContainmentMarker]) return childWin; } catch { if (instrumentedWindows.has(childWin)) return childWin; }
      instrumentedWindows.add(childWin);
      // Seed the parent-side virtual window.name store from the iframe's `name` attribute.
      try {
        const fn = frame && Native.getAttribute && Native.getAttribute.call(frame, 'name');
        if (fn) virtualFrameNames.set(childWin, fn);
      } catch {}
      if (ownsMembrane(childWin)) return childWin;
      if (bootingProxiedDocument(childWin)) {
        // Install an early postMessage targetOrigin mapper before the child's own prelude finishes booting.
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
      try { documentIsSWLess(childWin.document); } catch {}
      return childWin;
    }
    // Expose a live DOMTokenList backed by a detached shadow iframe when the frame's sandbox attribute was rewritten.
    function installFrameSandboxProp(proto) {
      const d = Object.getOwnPropertyDescriptor(proto, 'sandbox');
      if (!d || !d.get || !d.set) return;
      const MO = root.MutationObserver;
      try {
        defineMasked(proto, 'sandbox', {
          get() {
            if (!frameSandboxMeta.has(this)) return d.get.call(this);
            const value = frameSandboxMeta.get(this);
            let rec = sandboxShadows.get(this);
            if (!rec) {
              const shadow = Native.createElement('iframe');
              Native.setAttribute.call(shadow, 'sandbox', value);
              rec = { shadow, list: d.get.call(shadow) };
              const frame = this;
              try {
                const obs = new MO(() => {
                  const now = Native.getAttribute.call(shadow, 'sandbox');
                  if (now === null || sandboxShadows.get(frame) !== rec) return;
                  if (frameSandboxMeta.get(frame) !== now) setFrameSandboxAttribute(frame, now);
                });
                obs.observe(shadow, { attributes: true, attributeFilter: ['sandbox'] });
                activeObservers.add(obs);
              } catch {}
              sandboxShadows.set(this, rec);
            }
            return rec.list;
          },
          set(v) { setFrameSandboxAttribute(this, v); },
          enumerable: d.enumerable,
          configurable: false,
        });
        const installed = Object.getOwnPropertyDescriptor(proto, 'sandbox');
        if (installed && typeof installed.get === 'function') maskAccessorFn(installed.get, 'get', 'sandbox');
        if (installed && typeof installed.set === 'function') maskAccessorFn(installed.set, 'set', 'sandbox');
      } catch {}
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
        const installed = Object.getOwnPropertyDescriptor(proto, prop);
        if (installed && typeof installed.get === 'function' && installed.get !== d.get) maskAccessorFn(installed.get, 'get', prop);
        if (installed && typeof installed.set === 'function') maskAccessorFn(installed.set, 'set', prop);
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
      const scripts = qsaOf(node, 'script');
      for (let i = 0; i < scripts.length; i++) prepareScriptElement(scripts[i]);
      const frames = qsaOf(node, 'iframe,frame');
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
      const descendants = qsaOf(node, 'iframe,frame');
      for (let i = 0; i < descendants.length; i++) {
        if (!frames) frames = [];
        frames.push(descendants[i]);
      }
    }
    return frames;
  }
  // Route a frame's `src` through an asynchronously activated proxy share path.
  // Connected frames already showing a routed document keep that document until the new route commits;
  // other frames use an `about:blank` placeholder whose synthetic `load` event is swallowed.
  function frameShowsRoutedDocument(el, key) {
    let cur = null;
    try { cur = Native.getAttribute.call(el, key); } catch {}
    if (!cur) return false;
    try { const u = new Native.URL(cur, proxyOrigin); return u.origin === proxyOrigin && ZP.isSharePath(u.pathname); } catch { return false; }
  }
  // Park a frame's `src` in `data-zp-frame-src` and set `src="about:blank"` while the element resides in an inert document.
  function parkFrameSrc(el) {
    const src = Native.getAttribute.call(el, 'src');
    if (src === null) return;
    const t = src.trim();
    if (!t || /^about:/i.test(t)) return;
    Native.setAttribute.call(el, 'data-zp-frame-src', src);
    Native.setAttribute.call(el, 'src', 'about:blank');
  }
  function dropParkedFrameSrc(el) {
    try { Native.removeAttribute.call(el, 'data-zp-frame-src'); } catch {}
  }
  // `keepDocument` is false for the mutation-observer backstop: there the
  // attribute was written without our hook and may hold the raw URL right now.
  function routeFrameSrc(el, key, target, keepDocument) {
    sanitizeFrameSandbox(el);
    dropParkedFrameSrc(el);
    const seq = (frameRouteSeq.get(el) || 0) + 1;
    frameRouteSeq.set(el, seq);
    if (!(keepDocument && el.isConnected && frameShowsRoutedDocument(el, key))) {
      Native.setAttribute.call(el, key, 'about:blank');
      pendingFrameRoutes.add(el);
    }
    activatedFrameURL(target, undefined, () => frameIsOpaque(el), el).then(u => {
      if (frameRouteSeq.get(el) !== seq) return;
      Native.setAttribute.call(el, key, u);
      rememberFrameOrigin(el);
    }).catch(() => {
      if (frameRouteSeq.get(el) !== seq) return;
      pendingFrameRoutes.delete(el);
      try { el.dispatchEvent(new Event('load')); } catch {}
    });
  }
  function cancelFrameRoute(el) {
    frameRouteSeq.set(el, (frameRouteSeq.get(el) || 0) + 1);
    pendingFrameRoutes.delete(el);
    dropParkedFrameSrc(el);
  }
  // Suppress the `load` event of the `about:blank` placeholder while a frame's share route is still activating.
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
  function windowReachable(win) {
    try { void win.document; return true; } catch { return false; }
  }
  function frameHasOpaqueMark(frame) {
    try { return Native.hasAttribute.call(frame, OPAQUE_FRAME_ATTR); } catch { return false; }
  }
  function frameIsOpaque(frame) { return opaqueDocument || frameHasOpaqueMark(frame); }
  function windowIsOpaque(win) {
    try { const fe = winGet(win, 'frameElement'); if (fe) return frameIsOpaque(fe); } catch {}
    return opaqueDocument;
  }

  function instrumentFrameList(frames) { if (frames) for (const frame of frames) instrumentIframe(frame); }
  function instrumentDescendantIframes(node) { instrumentFrameList(collectIframes(node, null)); }
  function instrumentIframe(frame) {
    if (!frame || !/^(IFRAME|FRAME)$/.test(frame.nodeName || '')) return;
    try {
      const src = Native.getAttribute.call(frame, 'src');
      try { zpTrace('iframe', (src || 'about:blank').slice(0, 160)); } catch {}
      rememberFrameOrigin(frame);
      sanitizeFrameSandbox(frame);
      if (!srcdocMeta.has(frame) && Native.hasAttribute.call(frame, 'srcdoc')) {
        const kept = Native.getAttribute.call(frame, litAttrName('srcdoc'));
        if (kept !== null) srcdocMeta.set(frame, kept);
      }
      if (opaqueDocument && !frameHasOpaqueMark(frame)) { try { Native.setAttribute.call(frame, OPAQUE_FRAME_ATTR, '1'); } catch {} }
      const opaque = frameHasOpaqueMark(frame);
      const blankWin = (!src || /^about:blank$/i.test(src)) && !opaque ? nativeFrameWindow(frame) : null;
      if (blankWin) {
        if (windowReachable(blankWin)) installNetworkContainment(blankWin);
        else throw new Error('frame window cannot be contained');
      }
      installSafeFrameResizeShim(frame);
    } catch { try { frame.remove(); } catch {} }
  }
  // Mirror child document height onto SafeFrame-emulation ad iframes whose `name` JSON carries `{evtType: 'sf-init'}`.
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
        const doc = nativeFrameDocument(frame);
        if (!doc || !doc.body) return;
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
      try { doc = nativeFrameDocument(frame); } catch {}
      if (!doc || !doc.body) {
        if (tries++ < 100) try { root.setTimeout(start, 50); } catch {}
        return;
      }
      // Poll with adaptive backoff (200ms up to 2000ms) so stable ad frames do not force repeated layout flushes.
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
      try {
        const imgs = qsaOf(doc, 'img');
        for (let i = 0; i < imgs.length; i++) {
          try { imgs[i].addEventListener('load', apply, { once: true }); } catch {}
        }
      } catch {}
    };
    start();
  }