  function postMessageToSW(message, transfer) {
    const controller = Native.serviceWorkerController || Native.serviceWorker && Native.serviceWorker.controller;
    if (!controller || !runtimeToken) return Promise.reject(normalizedError('NetworkError'));
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const sealed = Object.assign({}, message, { runtimeToken });
      channel.port1.onmessage = ev => {
        const data = ev.data || {};
        if (data.ok) resolve(data);
        else { const err = new Error(data.error || 'NetworkError'); err.code = data.error || 'NetworkError'; reject(err); }
      };
      controller.postMessage(sealed, transfer ? [channel.port2, ...transfer] : [channel.port2]);
    });
  }
  // Page-to-orchestrator messaging channel. Uses postMessageToSW by default;
  // embedders can install `root.__zp_bridge_factory` before prelude evaluation
  // to supply a custom transport.
  const bridge = (() => {
    try {
      const factory = root.__zp_bridge_factory;
      if (typeof factory === 'function') {
        const b = factory(ctx);
        if (b && typeof b.send === 'function') return b;
      }
    } catch {}
    return { send: postMessageToSW };
  })();
  ctx.bridge = bridge;
  // Periodically ping the service worker controller so it does not idle out and
  // lose in-memory tab routing state during long-lived or streaming document loads.
  let __zpKeepAliveTimer = null;
  function startSWKeepAlive() {
    if (__zpKeepAliveTimer) return;
    __zpKeepAliveTimer = setInterval(() => {
      const controller = Native.serviceWorkerController || (Native.serviceWorker && Native.serviceWorker.controller);
      if (!controller) return;
      try { controller.postMessage({ type: '__zpKeepAlive' }); } catch {}
    }, 15000);
  }
  startSWKeepAlive();
  // Record upstream wire body sizes pushed by the service worker for
  // ResourceTiming encodedBodySize fidelity.
  const encodedSizes = newMap();
  const onBridgeMessage = (d) => {
    if (d && d.type === ZP.MSG.COOKIE_CHANGE) { applyCookieChanges(d.changes); return; }
    if (!d || d.type !== ZP.MSG.ENCODED_SIZE || !d.url) return;
    encodedSizes.set(String(d.url), Number(d.size) || 0);
  };
  try {
    const sw = Native.serviceWorker || (root.navigator && root.navigator.serviceWorker);
    if (sw && sw.addEventListener) {
      sw.addEventListener('message', (ev) => onBridgeMessage(ev && ev.data));
    }
  } catch {}
  // Subscribe to custom bridge inbound messages when present.
  if (typeof bridge.onMessage === 'function') {
    try { bridge.onMessage(onBridgeMessage); } catch {}
  }
  ctx.setBridge = function setBridge(nextBridge) {
    if (!nextBridge || typeof nextBridge.send !== 'function') {
      throw new TypeError('ctx.setBridge requires an object with send(msg)');
    }
    ctx.bridge = nextBridge;
    if (typeof nextBridge.onMessage === 'function') {
      try { nextBridge.onMessage(onBridgeMessage); } catch {}
    }
    return nextBridge;
  };
  ctx.dispose = function dispose() {
    if (realmDisposed) return;
    realmDisposed = true;
    if (__zpKeepAliveTimer !== null) {
      try { (Native.clearInterval || clearInterval)(__zpKeepAliveTimer); } catch {}
      __zpKeepAliveTimer = null;
    }
    if (__zpHeartbeatTimer !== null) {
      try { (Native.clearInterval || clearInterval)(__zpHeartbeatTimer); } catch {}
      __zpHeartbeatTimer = null;
    }
    for (const obs of activeObservers) {
      try { obs.disconnect(); } catch {}
    }
    activeObservers.clear();
    if (ctx.bridge && typeof ctx.bridge.dispose === 'function') {
      try { ctx.bridge.dispose(); } catch {}
    }
  };
  // Query the document's own encoded wire size after boot since navigation
  // responses complete before resultingClientId is bound.
  function askDocumentEncodedSize(attempt) {
    ctx.bridge.send({ type: ZP.MSG.ENCODED_SIZE_QUERY, url: virtualURL.href })
      .then(reply => {
        const size = reply && Number(reply.size);
        if (size) { encodedSizes.set(virtualURL.href, size); return; }
        if (attempt < 6) setTimeout(() => askDocumentEncodedSize(attempt + 1), 400);
      })
      .catch(() => { if (attempt < 6) setTimeout(() => askDocumentEncodedSize(attempt + 1), 400); });
  }
  try { setTimeout(() => askDocumentEncodedSize(0), 300); } catch {}
  // Register this client with the service worker's tab context so
  // non-navigational realms (`about:srcdoc`, `blob:`, `about:blank`) can issue
  // subresource fetches.
  (function bindClientToTab(attempt) {
    if (!boot.tabId) return;
    ctx.bridge.send({ type: ZP.MSG.BIND_CLIENT, tabId: boot.tabId, entryId: boot.entryId, env: ZP.clientEnvOf(root) })
      .catch(() => { if (attempt < 10) setTimeout(() => bindClientToTab(attempt + 1), 200); });
  })(0);
  // Expose the service worker's recorded subresource refusal log for diagnostics.
  define(root, '__zp_refusals', function __zp_refusals() {
    return new Promise((resolve) => {
      const controller = Native.serviceWorkerController || (Native.serviceWorker && Native.serviceWorker.controller);
      if (!controller) { resolve([]); return; }
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve([]), 3000);
      channel.port1.onmessage = ev => { clearTimeout(timer); resolve((ev.data && ev.data.refusals) || []); };
      try { controller.postMessage({ type: '__zpRefusalDump' }, [channel.port2]); }
      catch { clearTimeout(timer); resolve([]); }
    });
  });
  function updateVirtualBase(raw) {
    try {
      const next = targetURL(raw, baseURL);
      baseURL = next;
      explicitBaseURL = next;
      ctx.bridge.send({ type: ZP.MSG.BASE_UPDATE, tabId: boot.tabId, entryId: activeEntryId, baseUrl: next }).catch(()=>{});
      return next;
    } catch {
      return baseURL;
    }
  }
  // Read the effective `<meta name="referrer">` policy (last declaration wins)
  // and report changes to the service worker.
  function documentReferrerPolicy() {
    try {
      const metas = Native.querySelectorAll.call(document, 'meta[name="referrer" i]');
      let policy = '';
      for (const m of metas) {
        const v = String(Native.getAttribute.call(m, 'content') || '').trim().toLowerCase();
        if (v) policy = v;
      }
      return policy;
    } catch { return ''; }
  }
  let lastReportedReferrerPolicy = null;
  function reportMetaReferrerPolicy() {
    try {
      const policy = documentReferrerPolicy();
      if (!policy || policy === lastReportedReferrerPolicy) return;
      lastReportedReferrerPolicy = policy;
      ctx.bridge.send({ type: ZP.MSG.REFERRER_POLICY, tabId: boot.tabId, entryId: activeEntryId, policy }).catch(() => {});
    } catch {}
  }

  // Filter outgoing postMessage calls by comparing the destination window's
  // virtual origin against `targetOrigin`, since all proxied frames share one
  // physical origin.
  function postMessageTargetAccepts(target, wanted) {
    if (wanted === undefined || wanted === null) return true;
    const s = String(wanted);
    if (s === '*') return true;
    let dest = '';
    try { dest = windowHandles ? windowHandles.originOf(target) : ''; } catch {}
    if (!dest) return true;
    // "/" denotes the sender's own security origin.
    if (s === '/') return dest === securityOrigin() || notePostMessageDrop(s, dest, target);
    try {
      const u = new URL(s);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin === dest || notePostMessageDrop(u.origin, dest, target);
    } catch {}
    return true;
  }
  // Record dropped postMessage calls in `__zp_diagnostics` and return false.
  function notePostMessageDrop(wanted, dest, target) {
    try {
      let dg = root.__zp_diagnostics;
      try { if (root.top && root.top.__zp_diagnostics) dg = root.top.__zp_diagnostics; } catch {}
      if (dg && dg.length < 200) {
        const entry = { t: 'pm-drop', wanted: String(wanted).slice(0, 80), dest: String(displayOrigin(dest)).slice(0, 80), from: String(displayOrigin(securityOrigin())).slice(0, 80) };
        entry.to = postMessageTargetRole(target);
        try { entry.to += ' ' + String(target.location.href).slice(0, 100); } catch {}
        try { entry.at = String(new Error().stack).split('\n').slice(4, 7).map(l => l.trim()).join(' | ').slice(0, 300); } catch {}
        dg.push(entry);
      }
    } catch {}
    return false;
  }
  function postMessageTargetRole(target) {
    try {
      if (target === root) return 'self';
      if (target === winGet(root, 'parent')) return 'parent';
      if (target === winGet(root, 'top')) return 'top';
      if (target === winGet(root, 'opener')) return 'opener';
      for (let i = 0, n = winGet(root, 'length'); i < n; i++) if (root[i] === target) return 'child' + i;
    } catch {}
    return 'other';
  }
  function normalizePostMessageTargetOrigin(targetOrigin) {
    if (targetOrigin == null) return targetOrigin;
    const s = String(targetOrigin);
    if (s === '*' || s === '/') return s;
    try {
      const u = new URL(s);
      if (u.protocol === 'http:' || u.protocol === 'https:') return proxyOrigin;
    } catch {}
    return s;
  }
  // Install a configurable postMessage wrapper on unbooted child windows and
  // stash the native function on `earlyNativeKey` so the child prelude can
  // restore native postMessage once its own membrane boots.
  const earlyNativeKey = '__zpEarlyNativePostMessage';
  function installEarlyPostMessage(childWin) {
    if (!childWin) return;
    try {
      // Skip if the child window has already booted its own membrane.
      if (typeof childWin.__zp_get === "function") return;
      if (!Object.prototype.hasOwnProperty.call(childWin, '__zp_early_natives')) {
        const saved = Object.create(null);
        for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'Worker', 'SharedWorker', 'eval', 'Function', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport', 'RTCDataChannel']) {
          try {
            saved[k] = Object.getOwnPropertyDescriptor(childWin, k);
            if (root[k] !== undefined) {
              Object.defineProperty(childWin, k, { value: root[k], enumerable: false, configurable: true, writable: true });
            }
          } catch {}
        }
        try { Object.defineProperty(childWin, '__zp_early_natives', { value: saved, enumerable: false, configurable: true, writable: true }); } catch {}
      }
      const wrapped = postMessageWrapperFor(childWin);
      if (!wrapped) return;
      const cur = Object.getOwnPropertyDescriptor(childWin, 'postMessage');
      if (cur && !cur.configurable) return;
      if (cur && typeof cur.value === 'function') {
        try { Object.defineProperty(wrapped, earlyNativeKey, { value: cur.value, enumerable: false, configurable: true, writable: false }); } catch {}
      }
      Object.defineProperty(childWin, 'postMessage', { value: wrapped, enumerable: true, configurable: true, writable: true });
      maskNativeFunction(wrapped, 'postMessage');
    } catch {}
  }
  // Restore the native postMessage saved by installEarlyPostMessage so
  // cross-realm calls preserve the caller's incumbent realm as `event.source`.
  function restoreNativePostMessage(w) {
    try {
      const cur = Object.getOwnPropertyDescriptor(w, 'postMessage');
      const native = cur && typeof cur.value === 'function' ? cur.value[earlyNativeKey] : null;
      if (!native || !cur.configurable) return;
      Object.defineProperty(w, 'postMessage', { value: native, enumerable: true, configurable: true, writable: true });
    } catch {}
  }
  function postMessageWrapperFor(target) {
    if (!target || typeof target.postMessage !== 'function') return undefined;
    if (postMessageWrappers.has(target)) return postMessageWrappers.get(target);
    // Invoke the native postMessage via Reflect.apply rather than .bind() so V8
    // preserves the caller realm as the incumbent settings object and sets
    // `event.source` to the sender's window.
    const originalPm = target.postMessage;
    const wrapped = function postMessage(message, targetOrigin, transfer) {
      // Validate required argument count per WebIDL before reading targetOrigin.
      if (arguments.length < 1) throw new TypeError("Failed to execute 'postMessage' on 'Window': 1 argument required, but only 0 present.");
      // Support both `postMessage(msg, targetOrigin, transfer)` and `postMessage(msg, options)` overloads.
      const optionsForm = arguments.length >= 2 && targetOrigin !== null && typeof targetOrigin === 'object';
      const wanted = optionsForm ? (targetOrigin.targetOrigin === undefined ? '/' : targetOrigin.targetOrigin) : (arguments.length < 2 ? '/' : targetOrigin);
      if (!postMessageTargetAccepts(target, wanted)) return undefined;
      if (optionsForm) {
        const opts = { targetOrigin: arguments.length < 2 ? proxyOrigin : normalizePostMessageTargetOrigin(wanted) };
        if (targetOrigin.transfer !== undefined) opts.transfer = targetOrigin.transfer;
        return Reflect.apply(originalPm, target, [message, opts]);
      }
      const mapped = arguments.length < 2 ? proxyOrigin : normalizePostMessageTargetOrigin(targetOrigin);
      return arguments.length > 2 ? Reflect.apply(originalPm, target, [message, mapped, transfer]) : Reflect.apply(originalPm, target, [message, mapped]);
    };
    // Match native postMessage.length (1) and .name.
    try {
      Object.defineProperty(wrapped, 'length', { value: 1, configurable: true });
      Object.defineProperty(wrapped, 'name', { value: 'postMessage', configurable: true });
    } catch {}
    maskNativeFunction(wrapped, 'postMessage');
    try { const fp = Object.getPrototypeOf(originalPm); if (fp && Object.getPrototypeOf(wrapped) !== fp) Object.setPrototypeOf(wrapped, fp); } catch {}
    postMessageWrappers.set(target, wrapped);
    return wrapped;
  }
  function virtualOriginForMessage(ev) {
    if (!ev || ev.origin !== proxyOrigin || !ev.source) return '';
    // Resolve the sender's virtual origin through windowHandles across realms.
    try {
      const o = windowHandles ? windowHandles.originOf(ev.source) : '';
      if (o) return displayOrigin(o);
    } catch {}
    // Fall back to the frame route table when the sender frame has not booted a prelude.
    try {
      const routed = frameRouteTarget(ev.source.location.pathname);
      if (routed) return new URL(routed).origin;
    } catch {}
    try {
      const origin = frameWindowOrigins.get(ev.source) || ev.source[frameTargetOriginMarker];
      return origin || '';
    } catch {
      return '';
    }
  }
  // Virtualize MessageEvent.origin and MessageEvent.source for messages
  // arriving from the physical proxy origin.
  function virtualizeMessageEvent(ev) {
    if (ev.origin !== proxyOrigin) return ev;
    const origin = virtualOriginForMessage(ev);
    if (!origin) return ev;
    // Map event.source to the membrane window handle so `e.source === iframe.contentWindow` holds.
    let handle = ev.source;
    try { if (windowHandles && ev.source && typeof ev.source === 'object') handle = windowHandles.forWindow(ev.source); } catch {}
    // Redefine `origin` and `source` on the native MessageEvent instance to
    // preserve `isTrusted`, `target`, timestamps, and propagation methods.
    try {
      Object.defineProperty(ev, 'origin', { value: origin, enumerable: false, configurable: true });
      if (handle !== ev.source) Object.defineProperty(ev, 'source', { value: handle, enumerable: false, configurable: true });
      return ev;
    } catch {}
    try {
      if (handle !== ev.source) {
        // MessageEventInit rejects Proxy objects as `source`; attach the handle via Object.defineProperty instead.
        const e = new MessageEvent(ev.type, { data: ev.data, origin, lastEventId: ev.lastEventId || '', source: null, ports: ev.ports || [] });
        Object.defineProperty(e, 'source', { value: handle, enumerable: true, configurable: true });
        return e;
      }
      return new MessageEvent(ev.type, { data: ev.data, origin, lastEventId: ev.lastEventId || '', source: ev.source, ports: ev.ports || [] });
    } catch {
      try {
        const clone = Object.create(ev);
        Object.defineProperty(clone, 'origin', { value: origin, configurable: true });
        return clone;
      } catch {
        return ev;
      }
    }
  }
  function rememberFrameOrigin(frame) {
    if (!frame) return;
    let target = '';
    try { target = urlMeta.get(frame) || Native.getAttribute.call(frame, 'data-zp-target-url') || ''; } catch {}
    if (!target) return;
    try {
      const child = nativeFrameWindow(frame);
      if (child) frameWindowOrigins.set(child, new URL(target).origin);
    } catch {}
  }
  try { defineMasked(root, frameTargetOriginMarker, { get() { return displayOrigin(securityOrigin()); }, enumerable: false, configurable: false }); } catch {}

  // Virtualize `window.name` per target origin so values do not leak across
  // cross-origin navigations in the same browsing context. Declared before
  // install so early scope proxy accesses do not hit a temporal dead zone.
  const virtualFrameNames = newWeakMap();
  let rootWindowNameStore = null;
  function virtualWindowNameFor(win) {
    if (win === root) return rootWindowNameStore ? rootWindowNameStore.get() : '';
    try { return virtualFrameNames.get(win) || ''; } catch { return ''; }
  }
  function setVirtualWindowName(win, v) {
    const s = String(v);
    if (win === root) { if (rootWindowNameStore) rootWindowNameStore.set(s); return; }
    try { virtualFrameNames.set(win, s); } catch {}
  }