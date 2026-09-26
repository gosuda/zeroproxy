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
  // ── BridgeAdapter (REFACTOR.md §3.3, R6) — page↔orchestrator 채널.
  // 기본 구현은 위 postMessageToSW (SW controller + runtimeToken 봉인 +
  // {ok,error} reply 계약). 임베더는 prelude 평가 전에
  // `root.__zp_bridge_factory = ctx => ({ send, onMessage? })` 를 심어
  // SW 없는 채널(MessagePort/인프로세스/CDP)로 교체한다 — 커스텀 브리지는
  // 미봉인 메시지를 받고 자체 인증을 책임진다.
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
  // SW keepalive — the controller dies after ~30s idle, and a restarted SW
  // comes back with EMPTY in-memory state (tabs/shareRoutes/clientContext).
  // After that every /zp/api/* transport fetch fails `!tab` → 503
  // SW_NOT_READY → dynamic import()s + membrane fetch/XHR all reject →
  // hydration stalls (the "검색창만 뜨고 흰화면" symptom). The worst gap is the
  // streamed document staying open ~60s while NAVER withholds END_STREAM: no
  // fetch activity flows in that window, so the SW idles out mid-load exactly
  // when the page still needs it. A bare ~15s postMessage resets the SW idle
  // timer (any received event does) so its tab state survives the whole load.
  // Bare post (no port / no runtimeToken) — we only need the wake, not a reply.
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
  // ★2026-08-23 — 압축 크기 수신. SW 가 응답마다 **요청한 클라이언트에게만**
  // 상류의 와이어 바이트 수를 보낸다. 이게 없으면 `encodedBodySize` 가 항상
  // decoded 와 같아져 모든 응답이 비압축처럼 보인다(타이밍 축 참조).
  const encodedSizes = new Map();
  const onBridgeMessage = (d) => {
    if (!d || d.type !== ZP.MSG.ENCODED_SIZE || !d.url) return;
    encodedSizes.set(String(d.url), Number(d.size) || 0);
  };
  try {
    const sw = Native.serviceWorker || (root.navigator && root.navigator.serviceWorker);
    if (sw && sw.addEventListener) {
      sw.addEventListener('message', (ev) => onBridgeMessage(ev && ev.data));
    }
  } catch {}
  // 커스텀 브리지의 인바운드 채널 — SW 와 병행 구독 (기본 브리지에는 없음).
  if (typeof bridge.onMessage === 'function') {
    try { bridge.onMessage(onBridgeMessage); } catch {}
  }
  // ★문서는 밀려오지 않는다 — 내비게이션은 `resultingClientId` 라 SW 가
  // 스트림이 끝나는 시점에 아직 클라이언트를 잡지 못한다(실측).
  // 그래서 페이지가 **자기 URL 로** 물어본다 — 경쟁도 없고 새로 알려주는
  // 정보도 없다(자기 URL 은 이미 안다).
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
  // 2026-08-13 — 이 문서의 clientId 를 SW 의 탭 컨텍스트에 등록한다.
  //
  // 최상위 문서는 내비게이션 요청 자체가 바인딩을 만들어 주지만, `srcdoc` /
  // `blob:` / `about:blank` 문서는 내비게이션이 없어 SW 가 그 클라이언트를
  // 어느 탭 소속인지 알 수 없다. 그러면 **최상위에서는 잘 나가는 URL 이**
  // 그 문서에서만 거절당한다. 프렐류드는 이런 문서에도 주입되므로 여기서
  // 한 번 등록해 두면 그 계층 차이가 사라진다.
  // controller 는 부팅 직후 아직 null 일 수 있으므로 몇 번 재시도한다 —
  // 한 번 실패하고 마는 것과 달리, 여기서 놓치면 그 문서의 서브리소스가
  // 전부 거절당하므로 조용한 실패의 대가가 크다.
  (function bindClientToTab(attempt) {
    if (!boot.tabId) return;
    ctx.bridge.send({ type: ZP.MSG.BIND_CLIENT, tabId: boot.tabId, entryId: boot.entryId })
      .catch(() => { if (attempt < 10) setTimeout(() => bindClientToTab(attempt + 1), 200); });
  })(0);
  // SW 가 거절한 요청 목록. 서브리소스 실패는 페이지 콘솔에 아무 흔적을
  // 남기지 않으므로, 프록시가 못 살려 준 것을 눈이 아니라 목록으로 본다.
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
  // <meta name="referrer"> 를 SW 에 알린다.
  //
  // 문서의 참조 정책은 응답 헤더로도, 이 meta 로도 선언된다. 우리는 헤더만
  // 보고 있었다 — 페이지가 부른 fetch 의 `Request.referrerPolicy` 는 빈
  // 문자열이라(문서 정책은 요청 객체에 반영되지 않는다) meta 로만 정책을
  // 선언한 페이지는 우리 쪽에서 기본값으로 떨어졌다. 브라우저가 직접 내는
  // 요청(이미지/스크립트)은 정확한데 페이지 fetch 만 어긋나는 비대칭이었다.
  //
  // 파싱 중에 늦게 나타나거나 나중에 바뀔 수 있으므로 부팅 시 한 번 + 문서가
  // 준비되면 한 번 더 읽는다. 마지막에 선언된 것이 이긴다(HTML 파싱 순서).
  // 문서에 선언된 참조 정책(`<meta name=referrer>`). 마지막 선언이 이긴다.
  // 요청마다 읽는다 — meta 는 파싱 도중 나타나거나 나중에 바뀔 수 있고,
  // fetch 는 그렇게 잦은 호출이 아니다.
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
  // 자식이 스스로 멤브레인을 깔기 전까지의 빈 구간을 메운다. `configurable:
  // true` 로 두는 게 핵심 — 자식 prelude 가 자기 래퍼로 갈아끼울 수 있어야
  // 한다(부모 래퍼는 부모 realm 의 함수라 자식의 incumbent realm 을 바꾼다).
  // ★이 래퍼는 **부모 realm 함수**라, 붙어 있는 동안은 그 창을 거치는 모든
  // postMessage 의 incumbent realm 이 부모가 된다(자식의 self-post 는 source 가
  // 부모로, 손자→자식 메시지도 마찬가지). 그래서 **자식 prelude 가 뜨는 즉시
  // 네이티브로 되돌린다** — 되돌릴 수 있도록 원본을 래퍼에 달아 둔다.
  // 삭제로는 못 되돌린다: postMessage 는 Window **인스턴스의 소유 속성**이고
  // (측정: `Window.prototype.postMessage` 는 undefined) 지우면 네이티브까지
  // 같이 사라진다.
  const earlyNativeKey = '__zpEarlyNativePostMessage';
  function installEarlyPostMessage(childWin) {
    if (!childWin) return;
    try {
      // 자식이 **이미 자기 멤브레인을 깔았으면 손대지 않는다.** 이 래퍼는 부모
      // realm 함수라, 부팅이 끝난 창에 뒤늦게 덮으면 그 창의 self-post 와
      // 손자→자식 메시지의 e.source 가 부모로 뒤집힌 채 영영 남는다 — 자식은
      // 이미 복구 단계를 지났으므로 걷어 낼 사람이 없다. 실측(CNN): 프레임
      // 25개 중 2개가 이 순서로 걸려 postMessage.length 가 3 으로 남았다.
      // __zp_get 은 문자열 키 전역이라 교차 realm 에서도 보인다.
      if (typeof childWin.__zp_get === "function") return;
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
  // 부모가 남긴 조기 래퍼를 걷어 낸다. 자기 realm 이 뜬 뒤에는 멤브레인 get
  // 트랩이 targetOrigin 매핑을 맡으므로 창 자신은 네이티브여야 한다.
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
    // .bind() 가 BoundFunction 의 realm 을 install-time realm (parent) 으로
    // 고정 → V8 의 message source 결정이 incumbent 가 아닌 bound function 의
    // realm 사용 → child iframe 이 parent.postMessage 호출 시 `e.source` 가
    // child 의 contentWindow 가 아닌 parent.window 가 됨. NAVER GFP SafeFrame
    // SDK 는 source === iframe.contentWindow 비교로 어느 광고 iframe 에서
    // resize 메시지 왔는지 식별 → 모든 광고 iframe height=0 으로 collapse.
    // .bind 대신 Reflect.apply 로 native 직접 호출하면 caller realm (child) 이
    // incumbent 로 보존되어 source 가 정확히 dispatched 됨.
    const originalPm = target.postMessage;
    // mapped === '*' (caller 가 '*' 또는 변환 필요 없는 케이스) 면 source 보존을
    // 위해 wrap 우회 — caller 가 native postMessage 직접 호출하도록 return
    // origin pm 그대로. 단, mapped !== targetOrigin (virtual → real 변환됨)
    // 케이스만 wrap 통해 변환 + native call.
    const wrapped = function postMessage(message, targetOrigin, transfer) {
      const mapped = arguments.length < 2 ? proxyOrigin : normalizePostMessageTargetOrigin(targetOrigin);
      return arguments.length > 2 ? Reflect.apply(originalPm, target, [message, mapped, transfer]) : Reflect.apply(originalPm, target, [message, mapped]);
    };
    maskNativeFunction(wrapped, 'postMessage');
    postMessageWrappers.set(target, wrapped);
    return wrapped;
  }
  function virtualOriginForMessage(ev) {
    if (!ev || ev.origin !== proxyOrigin || !ev.source) return '';
    try {
      const origin = frameWindowOrigins.get(ev.source) || ev.source[frameTargetOriginMarker];
      return origin || '';
    } catch {
      return '';
    }
  }
  // source 는 **엔진이 준 것을 그대로 쓴다.** 예전에는 sender 큐로 정정했는데,
  // 그 정정이 필요했던 이유는 우리가 창의 postMessage 를 부모 realm 래퍼로
  // 갈아끼워 incumbent realm 을 망가뜨렸기 때문이다. 그 원인을 없앴으므로
  // (rewriter.md#postmessage-incumbent) 정정 장치도 함께 지운다 — 남겨 두면
  // 다음 사람이 "이미 처리돼 있네" 로 오해한다. 여기서 하는 일은 오리진
  // 가상화 하나뿐이다.
  function virtualizeMessageEvent(ev) {
    // Hot path fast-exit: 프록시 오리진이 아니면 virtualOriginForMessage 가
    // 어차피 '' 를 준다. 함수 호출 + 객체 alloc 회피.
    if (ev.origin !== proxyOrigin) return ev;
    const origin = virtualOriginForMessage(ev);
    if (!origin) return ev;
    try {
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
      const child = frame.contentWindow;
      if (child) frameWindowOrigins.set(child, new URL(target).origin);
    } catch {}
  }
  try { defineMasked(root, frameTargetOriginMarker, { get() { return virtualURL.origin; }, enumerable: false, configurable: false }); } catch {}

  // ── virtual window.name ───────────────────────────────────────────────
  // The real `window.name` persists across EVERY document this browsing
  // context ever loads — cross-target and cross-proxy leaks in one slot.
  // Page code sees a per-target virtual value instead: the root's is backed
  // by native sessionStorage under the same tab+origin prefix as the
  // session facade (name survives the target's own tab navigations, dies
  // with the tab — native semantics). Child windows get in-memory names.
  // NOTE: 이 블록은 install 시퀀스보다 먼저 있어야 한다 — scope 프록시의
  // `name` 게터가 부팅 중에도 발사될 수 있어 `let` 을 아래로 내리면 TDZ.
  const virtualFrameNames = new WeakMap();
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