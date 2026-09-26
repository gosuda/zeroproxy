
  function installWorkerHooks() {
    if (Native.Worker) {
      // The wrapper returns a REAL Worker, so its own `.prototype` was never on
      // the returned object's chain: `Worker.prototype` showed just
      // `["constructor"]` (5 names natively) and — worse — `new Worker(u)
      // instanceof Worker` was FALSE, since instanceof walks the wrapper's
      // prototype. Point the wrapper at the native prototype to fix both.
      const ZPWorker = function (url, opts) {
        try { zpTrace('Worker', String(url).slice(0, 120)); } catch {}
        const w = new Native.Worker(workerBootstrapURL(url, opts), opts);
        // W4: 워커에는 navigator.serviceWorker 가 없어 SW 스트림을 스스로 못
        // 연다. 워커가 `__zp:'zp-broker'` 제어 메시지를내면 여기서 SW 에
        // 중계하고 스트림 port 를 워커로 transfer 한다. 제어 메시지는 이
        // 리스너(생성자에서 첫 등록)가 먼저 받아 stopImmediatePropagation 으로
        // 타깃의 onmessage 에서 숨긴다.
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
              // D5: module 워커가 직접 읽은 blob: 소스를 SW stash 에 넣는다.
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
      // Only the constructor name — the prototype is the native one, which
      // already carries the correct Symbol.toStringTag.
      brandLikeNative(ZPWorker, null, 'Worker');
      define(root, 'Worker', ZPWorker);
    }
    if (Native.SharedWorker) {
      // ★Worker 세 줄 위(7340/7343)와 같은 병(own-count 불일치)인데 형제
      // 훅이 빠뜨렸다 — 실측(2026-09-14, 프로토타입 모양 축): SharedWorker
      // 프로토타입에 onerror/port 가 없었다. 게다가 이 훅은
      // installStorageFacades(root) 가 먼저 심어 둔 타깃-스코프 name 접두어
      // (sharedWorkerNamePrefix) 를 **부트 순서상 나중에 실행되며 조용히
      // 지웠다** — 프로토타입 문제를 좇다가 발견한, 별개의 격리 회귀. 접두어가
      // 없으면 같은 프록시 오리진을 쓰는 서로 다른 타깃 두 개가 이름+URL 이
      // 겹칠 때 **같은 SharedWorker 인스턴스**를 공유한다.
      // Native.SharedWorker 는 부모 컨테인먼트가 먼저 심은 래퍼일 수 있다 —
      // installStorageFacades 가 스태시해 둔 진짜 네이티브를 우선 쓴다.
      const RealSW = root.__zp_realSW || Native.SharedWorker;
      const ZPSharedWorker = function(url, opts) {
        try { zpTrace('SharedWorker', String(url).slice(0, 120)); } catch {}
        const prefix = sharedWorkerNamePrefix();
        const named = (opts && opts.name) ? Object.assign({}, opts, { name: prefix + String(opts.name) })
                                           : Object.assign({}, opts || {}, { name: prefix + 'default' });
        return new RealSW(workerBootstrapURL(url, opts), named);
      };
      try { ZPSharedWorker.prototype = RealSW.prototype; } catch {}
      brandLikeNative(ZPSharedWorker, null, 'SharedWorker');
      define(root, 'SharedWorker', ZPSharedWorker);
    }
    if (navigator.serviceWorker && navigator.serviceWorker.register) define(navigator.serviceWorker, 'register', function() { return Promise.reject(normalizedError('NotSupportedError')); });
    // 갈아치우기는 **쓸 때** 한다 — 만들 때가 아니다 (2026-08-26).
    //
    // 예전에는 여기서 MIME 을 보고 스크립트성이면 그 자리에서 차단 blob 으로
    // 바꿔 URL 을 돌려줬다. 그런데 new MediaSource() 에는 type 이 아예 없어서
    // 빈 문자열이 되고 정규식의 ^$ 에 걸린다. 즉 **MSE 핸들이 HTML 한 조각으로
    // 바뀌었고**, 붙이는 순간 DEMUXER_ERROR_COULD_NOT_OPEN 이 났다.
    // CNN 실측: Max 플레이어가 통째로 죽어 비디오 세그먼트가 0건이었다
    // (대조군 akm.*.media.max.com 115건 vs 프록시 0건). text/plain 이나 타입
    // 없는 평범한 Blob 도 같이 죽었다 — fetch(blobURL) 이 페이지가 넣은 내용
    // 대신 우리 HTML 을 돌려줬다.
    //
    // createObjectURL 은 감싸지 않는다 — 보안 경계는 URL 생성이 아니라
    // workerBootstrapURL(워커 소스 srcu 재작성)과 import/module 경로다.
    // 우리가 만들지 않은 blob 은 워커의 읽기 단계에서 자연히 fail-closed.
    for (const name of ['audioWorklet','paintWorklet','layoutWorklet','animationWorklet']) { const wk = root.CSS && root.CSS[name] || root[name]; if (wk && wk.addModule) define(wk, 'addModule', function(url, opts){ return wk.addModule(workerBootstrapURL(url, { type: 'module' }), opts); }); }
  }
  // D3: virtual SW facade. The original behavior was a hard
  // `NotSupportedError` reject, which made every site gating feature init
  // on `serviceWorker.register(...).then(...)` go down the
  // unhandled-rejection path. The full plan (run target SW code in an
  // isolated ZP_VIRTUAL_SW realm + dispatch sync/periodicsync/push events)
  // is out of scope for Phase 2; we provide a "fail soft" stand-in:
  //   - register/ready/getRegistration[s] resolve to a fake registration
  //   - SyncManager / PeriodicSyncManager register cleanly + never fire
  //     (matches native — browsers may delay sync indefinitely)
  //   - PushManager.subscribe rejects NotAllowedError (denied-permission shape)
  //   - navigationPreload is a no-op shim
  // Egress invariants stay closed: target JS can't intercept fetch, can't
  // schedule a real background sync, can't push from outside our origin.
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
    // 항상 fakeReg 하나 — 진짜 ZP SW 는 절대 노출하지 않으면서,
    // "등록이 있다" 는 모양은 유지한다 (e2e 가 이 계약을 핀다).
    define(facade, 'register', function register() { return Promise.resolve(fakeReg); });
    define(facade, 'getRegistration', function getRegistration() { return Promise.resolve(fakeReg); });
    define(facade, 'getRegistrations', function getRegistrations() { return Promise.resolve([fakeReg]); });
    define(facade, 'startMessages', function startMessages() {});
    define(facade, 'addEventListener', function addEventListener() {});
    define(facade, 'removeEventListener', function removeEventListener() {});
    // controller stays null — no SW actually controls the target realm.
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
    defineOnProto(nav, proto, 'serviceWorker', () => facade);
  }
  function workerBootstrapURL(url, opts) {
    const raw = String(url);
    const parsed = new URL(raw, virtualURL.href);
    if (parsed.protocol === 'blob:') {
      // D5: 페이지가 만든 blob 을 워커로 쓰는 경우 — 소스는 **워커가**
      // 읽는다(페이지 sync XHR 은 blob: 에 동작하지 않는다). `srcu`
      // 파라미터로 원본 URL 을 넘기면 워커 prelude 가 읽어서 재작성한다 —
      // 리라이터를 안 거친 코드가 워커로 도는 일은 없다. MIME 게이트는 두지
      // 않는다: Worker 생성자에 온 blob 은 이미 스크립트로 쓸 의도이고,
      // 다른 오리진/미등록 blob 은 워커의 읽기 단계에서 자연히 fail-closed.
      return srcWorkerBootstrapURL(parsed.href, opts);
    }
    if (parsed.protocol === 'data:') {
      // D5: data: 워커 소스 — 같은 srcu 경로(워커가 디코드한다).
      return srcWorkerBootstrapURL(parsed.href, opts);
    }
    const params = new URLSearchParams();
    params.set('u', requestTargetURL(raw));
    params.set('ref', virtualURL.href);
    params.set('tab', boot.tabId);
    // module 워커는 importScripts 가 없다 — 부트스트랩을 import() 체인으로
    // 바꿔야 하므로 SW 쪽에 표시를 남긴다(worklet addModule 도 module).
    if (opts && opts.type === 'module') params.set('mod', '1');
    workerGatewayParams(params);
    for (const server of activeServers) params.append('server', server);
    // Absolute proxy URL — Worker resolves the URL relative to the page's
    // baseURI, which is virtualised to the target host.
    return proxyOrigin + ZP.controlPath('worker-bootstrap.js') + '#' + params.toString();
  }
  // D5: blob:/data: 워커 소스 부트스트랩. `u` 에 원본 URL 을 유지해 워커의
  // location 이 네이티브와 같이 보인다. 소스는 워커가 직접 읽는다 —
  // `srcu` 는 "워커가 읽을 가상 URL" 이고, prelude 가 data: 디코드/blob
  // sync-XHR 을 거쳐 재작성 후 실행한다. module 워커는 import() 가 필요해
  // prelude 가 fetch→브로커 stash→/zp/api/worker-script?srctok 로 돈다.
  function srcWorkerBootstrapURL(srcu, opts) {
    const params = new URLSearchParams();
    params.set('u', srcu);
    params.set('ref', virtualURL.href);
    params.set('tab', boot.tabId);
    params.set('srcu', srcu);
    if (opts && opts.type === 'module') params.set('mod', '1');
    workerGatewayParams(params);
    for (const server of activeServers) params.append('server', server);
    return proxyOrigin + ZP.controlPath('worker-bootstrap.js') + '#' + params.toString();
  }
  // W5: 워커의 WebTransport/RTCPeerConnection 게이트웨이 래핑은 페이지의
  // boot 설정이 필요하다 — 부트스트랩 해시로 전달해 worker-prelude 가 같은
  // 정책(게이트웨이 없으면 rejected stub)을 적용하게 한다.
  function workerGatewayParams(params) {
    if (boot && typeof boot.wtGateway === 'string' && boot.wtGateway) params.set('wtg', boot.wtGateway);
    if (boot && typeof boot.rtcGateway === 'string' && boot.rtcGateway) params.set('rtcg', boot.rtcGateway);
    if (boot && Array.isArray(boot.rtcICEServers) && boot.rtcICEServers.length) params.set('ice', JSON.stringify(boot.rtcICEServers));
  }