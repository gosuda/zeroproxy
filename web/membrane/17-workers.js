
  function installWorkerHooks() {
    if (Native.Worker) {
      // Point ZPWorker.prototype at Native.Worker.prototype so instanceof Worker and prototype inspection match native.
      const ZPWorker = function (url, opts) {
        try { zpTrace('Worker', String(url).slice(0, 120)); } catch {}
        const w = new Native.Worker(ttScriptURL(workerBootstrapURL(ttCompliant('ScriptURL', 'Worker constructor', url), opts)), opts);
        // Relay __zp:'zp-broker' control messages from the worker to the service worker and hide them from target message listeners.
        try {
          w.addEventListener('message', ev => {
            const m = ev && ev.data;
            if (!m || m.__zp !== 'zp-broker') return;
            ev.stopImmediatePropagation();
            if (m.op === 'ws-open') {
              ctx.bridge.send({ type: ZP.MSG.WS_OPEN, url: m.url, protocols: Array.isArray(m.protocols) ? m.protocols : [], tabId: boot.tabId, entryId: activeEntryId }).then(reply => {
                try { w.postMessage({ __zp: 'zp-broker-reply', reqId: m.reqId, ok: true, protocol: String(reply.protocol || '') }, [reply.port]); }
                catch (e) { try { reply.port && reply.port.close(); } catch {} }
              }).catch(e => {
                try { w.postMessage({ __zp: 'zp-broker-reply', reqId: m.reqId, ok: false, error: String(e && (e.code || e.message) || 'NetworkError') }); } catch {}
              });
            } else if (m.op === 'stash') {
              // Stash blob: module worker source in the service worker so it can be imported via /zp/api/worker-script.
              ctx.bridge.send({ type: ZP.MSG.WORKER_STASH, src: m.src }).then(reply => {
                try { w.postMessage({ __zp: 'zp-broker-reply', reqId: m.reqId, ok: true, tok: String(reply && reply.tok || '') }); } catch {}
              }).catch(e => {
                try { w.postMessage({ __zp: 'zp-broker-reply', reqId: m.reqId, ok: false, error: String(e && (e.code || e.message) || 'NetworkError') }); } catch {}
              });
            }
          });
        } catch {}
        return w;
      };
      try { ZPWorker.prototype = Native.Worker.prototype; } catch {}
      brandLikeNative(ZPWorker, null, 'Worker');
      define(root, 'Worker', ZPWorker);
    }
    if (Native.SharedWorker) {
      // Preserve both the native SharedWorker.prototype and the per-target name prefix so targets do not share SharedWorker instances.
      const RealSW = root.__zp_realSW || Native.SharedWorker;
      const ZPSharedWorker = function(url, opts) {
        try { zpTrace('SharedWorker', String(url).slice(0, 120)); } catch {}
        return new RealSW(ttScriptURL(workerBootstrapURL(ttCompliant('ScriptURL', 'SharedWorker constructor', url), opts)), prefixedSharedWorkerOptions(sharedWorkerNamePrefix(), opts));
      };
      try { ZPSharedWorker.prototype = RealSW.prototype; } catch {}
      brandLikeNative(ZPSharedWorker, null, 'SharedWorker');
      define(root, 'SharedWorker', ZPSharedWorker);
    }
    if (navigator.serviceWorker && navigator.serviceWorker.register) define(navigator.serviceWorker, 'register', function() { return Promise.reject(normalizedError('NotSupportedError')); });
    for (const name of ['audioWorklet','paintWorklet','layoutWorklet','animationWorklet']) { const wk = root.CSS && root.CSS[name] || root[name]; if (wk && wk.addModule) define(wk, 'addModule', function(url, opts){ return wk.addModule(workerBootstrapURL(url, { type: 'module' }), opts); }); }
  }
  // D3: virtual SW facade that resolves serviceWorker registration and sync methods to inert stand-ins while keeping fetch interception and push closed.
  function installTargetServiceWorkerBlocker(w) {
    const nav = w && w.navigator;
    if (!nav) return;
    if (serviceWorkerFacades.has(w)) return;
    const facade = {};

    const fakeReg = {};
    const syncMgr = {};
    define(syncMgr, 'register', function register(tag) { return Promise.resolve(String(tag || '')); });
    define(syncMgr, 'getTags', function getTags() { return Promise.resolve([]); });
    const periodicSyncMgr = {};
    define(periodicSyncMgr, 'register', function register(tag, _opts) { return Promise.resolve(String(tag || '')); });
    define(periodicSyncMgr, 'unregister', function unregister(_tag) { return Promise.resolve(undefined); });
    define(periodicSyncMgr, 'getTags', function getTags() { return Promise.resolve([]); });
    const pushMgr = {};
    define(pushMgr, 'subscribe', function subscribe() { return Promise.reject(normalizedError('NotAllowedError')); });
    define(pushMgr, 'getSubscription', function getSubscription() { return Promise.resolve(null); });
    define(pushMgr, 'permissionState', function permissionState() { return Promise.resolve('denied'); });
    const navPreload = {};
    define(navPreload, 'enable', function enable() { return Promise.resolve(undefined); });
    define(navPreload, 'disable', function disable() { return Promise.resolve(undefined); });
    define(navPreload, 'setHeaderValue', function setHeaderValue() { return Promise.resolve(undefined); });
    define(navPreload, 'getState', function getState() { return Promise.resolve({ enabled: false, headerValue: '' }); });

    defineAccessor(fakeReg, 'scope', () => { try { return virtualURL.origin + '/'; } catch { return '/'; } });
    defineAccessor(fakeReg, 'active', () => null);
    defineAccessor(fakeReg, 'installing', () => null);
    defineAccessor(fakeReg, 'waiting', () => null);
    defineAccessor(fakeReg, 'updateViaCache', () => 'imports');
    defineAccessor(fakeReg, 'sync', () => syncMgr);
    defineAccessor(fakeReg, 'periodicSync', () => periodicSyncMgr);
    defineAccessor(fakeReg, 'pushManager', () => pushMgr);
    defineAccessor(fakeReg, 'navigationPreload', () => navPreload);
    define(fakeReg, 'update', function update() { return Promise.resolve(undefined); });
    define(fakeReg, 'unregister', function unregister() { return Promise.resolve(true); });
    define(fakeReg, 'showNotification', function showNotification() { return Promise.reject(normalizedError('NotAllowedError')); });
    define(fakeReg, 'getNotifications', function getNotifications() { return Promise.resolve([]); });
    define(fakeReg, 'addEventListener', function addEventListener() {});
    define(fakeReg, 'removeEventListener', function removeEventListener() {});

    const readyPromise = Promise.resolve(fakeReg);
    let oncontrollerchange = null;
    // Return fakeReg so target code sees an active registration without exposing the real proxy service worker.
    define(facade, 'register', function register() { return Promise.resolve(fakeReg); });
    define(facade, 'getRegistration', function getRegistration() { return Promise.resolve(fakeReg); });
    define(facade, 'getRegistrations', function getRegistrations() { return Promise.resolve([fakeReg]); });
    define(facade, 'startMessages', function startMessages() {});
    define(facade, 'addEventListener', function addEventListener() {});
    define(facade, 'removeEventListener', function removeEventListener() {});
    defineAccessor(facade, 'controller', () => null);
    defineAccessor(facade, 'ready', () => readyPromise);
    defineAccessor(facade, 'oncontrollerchange', () => oncontrollerchange, v => { oncontrollerchange = typeof v === 'function' ? v : null; });
    const existing = (() => { try { return nav.serviceWorker; } catch { return null; } })();
    if (existing && existing !== facade) {
      define(existing, 'register', facade.register);
      define(existing, 'getRegistration', facade.getRegistration);
      define(existing, 'getRegistrations', facade.getRegistrations);
      define(existing, 'startMessages', facade.startMessages);
      defineAccessor(existing, 'controller', () => null);
      defineAccessor(existing, 'ready', () => readyPromise);
      defineAccessor(existing, 'oncontrollerchange', () => oncontrollerchange, v => { oncontrollerchange = typeof v === 'function' ? v : null; });
    }
    serviceWorkerFacades.set(w, facade);
    const proto = w.Navigator && w.Navigator.prototype || Object.getPrototypeOf(nav);
    defineOnProto(nav, proto, 'serviceWorker', () => {
      if (opaqueDocument) throw opaqueDenied("Failed to read the 'serviceWorker' property from 'Navigator'", "Service worker is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag.");
      return facade;
    });
  }
  function workerBootstrapURL(url, opts) {
    const raw = String(url);
    const parsed = new URL(raw, virtualURL.href);
    if (parsed.protocol === 'blob:') {
      // Pass blob: worker URLs via `srcu` so the worker prelude reads and rewrites the source before execution.
      return srcWorkerBootstrapURL(parsed.href, opts, workerSourceCopy(parsed.href));
    }
    if (parsed.protocol === 'data:') {
      return srcWorkerBootstrapURL(parsed.href, opts);
    }
    const params = new URLSearchParams();
    params.set('u', requestTargetURL(raw));
    params.set('ref', virtualURL.href);
    params.set('tab', boot.tabId);
    if (opts && opts.type === 'module') params.set('mod', '1');
    workerGatewayParams(params);
    for (const server of activeServers) params.append('server', server);
    return proxyOrigin + ZP.controlPath('worker-bootstrap.js') + '#' + params.toString();
  }
  // Create a short-lived duplicate object URL for a page Blob so the worker bootstrap can still read it if the page revokes its URL immediately.
  function workerSourceCopy(href) {
    const blob = pageBlobURLs.get(href);
    if (!blob || !Native.createObjectURL) return null;
    try {
      const own = Native.createObjectURL(blob);
      setTimeout(() => { try { Native.revokeObjectURL(own); } catch {} }, 60000);
      return own;
    } catch { return null; }
  }
  function srcWorkerBootstrapURL(srcu, opts, readFrom) {
    const params = new URLSearchParams();
    params.set('u', srcu);
    params.set('ref', virtualURL.href);
    params.set('tab', boot.tabId);
    params.set('srcu', readFrom || srcu);
    if (opts && opts.type === 'module') params.set('mod', '1');
    workerGatewayParams(params);
    for (const server of activeServers) params.append('server', server);
    return proxyOrigin + ZP.controlPath('worker-bootstrap.js') + '#' + params.toString();
  }
  // Forward WebTransport and WebRTC gateway boot parameters to the worker bootstrap hash.
  function workerGatewayParams(params) {
    if (boot && typeof boot.wtGateway === 'string' && boot.wtGateway) params.set('wtg', boot.wtGateway);
    if (boot && Array.isArray(boot.wtGatewayCertHashes)) for (const h of boot.wtGatewayCertHashes) params.append('wtgh', String(h));
    if (boot && Array.isArray(boot.rtcICEServers) && boot.rtcICEServers.length) params.set('ice', JSON.stringify(boot.rtcICEServers));
  }