  // D4: virtual WebTransport that proxies through the ZeroProxy
  // gateway when one is configured (`boot.wtGateway` set by the server
  // via `/zp/api/config`). The virtual class wraps the *native*
  // WebTransport: the page calls `new WebTransport(targetUrl)`, we
  // build a gateway URL `gw?target=<encoded>&tab=<id>` and instantiate
  // the native class against the gateway. Everything else
  // (`ready`, `closed`, streams, datagrams) is delegated directly to
  // the native instance, so the IDL surface stays identical without
  // re-implementing stream wrappers.
  //
  // When `boot.wtGateway` is empty (operator hasn't set `-wt-public-url`)
  // or the browser lacks native WT, we fall back to the rejected-
  // promise stub so target code's `.ready.catch(...)` branch fires
  // cleanly.
  function makeWebTransportConstructor() {
    const NativeWT = Native.WebTransport;
    const gateway = (boot && typeof boot.wtGateway === 'string' && boot.wtGateway) ? boot.wtGateway : '';
    if (!NativeWT || !gateway) {
      return makeVirtualGateway('WebTransport', { code: 'WT_UNSUPPORTED', kind: 'WebTransport' });
    }
    function ZPWebTransport(targetUrl, opts) {
      if (!(this instanceof ZPWebTransport)) {
        throw new TypeError("Failed to construct 'WebTransport': Please use the 'new' operator.");
      }
      const target = String(targetUrl == null ? '' : targetUrl);
      // Validate the target URL minimally — browsers throw SyntaxError for
      // invalid URLs and TypeError for wrong schemes; we mirror to keep
      // feature-detection of "WT throws on bad URL" working.
      let parsed;
      try { parsed = new URL(target); } catch { throw normalizedError('SyntaxError'); }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'wt:') {
        throw normalizedError('SyntaxError');
      }
      // Target-side options (certificate pins) go to the gateway, the
      // gateway's own pin comes from the server config — see
      // ZP.webTransportGatewayRequest.
      const req = ZP.webTransportGatewayRequest(gateway, target, boot && boot.tabId, opts, boot && boot.wtGatewayCertHashes);
      const native = new NativeWT(req.url, req.options);
      // Delegate every property via a Proxy so target code that does
      // `wt.ready.then(...)` or `wt.createBidirectionalStream()` etc.
      // sees the native object's IDL surface byte-for-byte. We override
      // only `close` so we can record local state if needed; everything
      // else falls through.
      this._native = native;
    }
    // Expose the same readonly properties as the native WT spec by
    // forwarding to the underlying instance. We can't use a Proxy as the
    // class identity (target code may do `wt instanceof WebTransport`
    // against our class object), so we define instance accessors.
    function forward(name) {
      defineMasked(ZPWebTransport.prototype, name, {
        configurable: true,
        get() { try { return this._native[name]; } catch { return undefined; } },
      });
    }
    forward('ready');
    forward('closed');
    forward('datagrams');
    forward('incomingBidirectionalStreams');
    forward('incomingUnidirectionalStreams');
    forward('reliability');
    forward('congestionControl');
    forward('protocol');
    ZPWebTransport.prototype.createBidirectionalStream = function(opts) {
      return this._native.createBidirectionalStream(opts);
    };
    ZPWebTransport.prototype.createUnidirectionalStream = function(opts) {
      return this._native.createUnidirectionalStream(opts);
    };
    ZPWebTransport.prototype.close = function(closeInfo) {
      try { return this._native.close(closeInfo); } catch { return undefined; }
    };
    // ★공유 eventTargetProto() (installEventMethods) 는 여기 안 맞는다 — 그건
    // XHR/WebSocket 처럼 우리가 상태를 통째로 재구현한 클래스용 가짜
    // 리스너-맵이다. ZPWebTransport 는 **진짜** 네이티브 인스턴스(_native)를
    // 감싸고 그 인스턴스가 스스로 이벤트를 낸다 — addEventListener 를 가짜로
    // 바꾸면 `_native` 가 내는 진짜 이벤트가 리스너에 영영 안 닿는다(등록은
    // this 에, 발생은 _native 에 생기므로). own 3개가 대조군보다 많은 채로
    // 둔다 — 이 클래스는 게이트웨이가 설정된 배포에서만 살아나므로 지금
    // 측정되는 6개 모양차이에는 어차피 안 걸린다.
    ZPWebTransport.prototype.addEventListener = function(type, listener, opts) {
      try { return this._native.addEventListener(type, listener, opts); } catch {}
    };
    ZPWebTransport.prototype.removeEventListener = function(type, listener, opts) {
      try { return this._native.removeEventListener(type, listener, opts); } catch {}
    };
    ZPWebTransport.prototype.dispatchEvent = function(ev) {
      try { return this._native.dispatchEvent(ev); } catch { return true; }
    };
    brandLikeNative(ZPWebTransport, ZPWebTransport.prototype, 'WebTransport');
    return ZPWebTransport;
  }

  // D5 — WebRTC runs **relay-only through the operator's TURN server**
  // (2026-09-30). The page keeps a genuine native RTCPeerConnection — native
  // prototype, events, `on*` handlers, subclassing — and negotiates with its
  // remote peer through its own signaling as usual. Only the ICE configuration
  // is forced (ZP.relayOnlyRTCConfiguration): the TURN credentials the server
  // minted (`boot.rtcICEServers`) and `iceTransportPolicy: 'relay'`. The
  // browser gathers relay candidates only, so the remote peer sees the relay
  // and never the user (measured: its selected remote candidate is `relay`),
  // and DTLS/SRTP stay end to end — the relay carries ciphertext only.
  //
  // The previous design routed signaling through a pion bridge, but page code
  // still received the native connection's own SDP and candidates and handed
  // them to its peer: with D5 enabled the peer connected to the user directly
  // (host↔host, measured), and the bridge's target side was never negotiated.
  // Without TURN credentials there is no safe way to connect — stub.
  function makeRTCPeerConnectionConstructor(w, name) {
    const NativeRTC = w.RTCPeerConnection || w.webkitRTCPeerConnection;
    const ice = (boot && Array.isArray(boot.rtcICEServers)) ? boot.rtcICEServers.filter(s => s && s.urls) : [];
    if (typeof NativeRTC !== 'function' || !ice.length) {
      return makeVirtualGateway(name, { code: 'RTC_GATEWAY_UNAVAILABLE', kind: 'WebRTC' });
    }
    // What the page asked for — getConfiguration() reads it back instead of
    // our TURN credentials and relay policy.
    const requested = new WeakMap();
    const remember = (pc, config) => {
      const c = config == null ? {} : config;
      requested.set(pc, {
        iceServers: c.iceServers === undefined ? [] : c.iceServers,
        iceTransportPolicy: c.iceTransportPolicy === undefined ? 'all' : c.iceTransportPolicy,
      });
    };
    const RTCPeerConnection = function RTCPeerConnection(config) {
      if (!new.target) {
        throw new TypeError("Failed to construct '" + name + "': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
      }
      // new.target keeps page subclasses (`class X extends RTCPeerConnection`).
      const pc = Reflect.construct(NativeRTC, [ZP.relayOnlyRTCConfiguration(config, ice)], new.target);
      remember(pc, config);
      return pc;
    };
    const proto = NativeRTC.prototype;
    try { Object.defineProperty(RTCPeerConnection, 'prototype', { value: proto, writable: false, enumerable: false, configurable: false }); } catch {}
    try { Object.defineProperty(RTCPeerConnection, 'length', { value: 0, configurable: true }); } catch {}
    try { Object.setPrototypeOf(RTCPeerConnection, Object.getPrototypeOf(NativeRTC)); } catch {}
    for (const key of Reflect.ownKeys(NativeRTC)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue;
      try { Object.defineProperty(RTCPeerConnection, key, Object.getOwnPropertyDescriptor(NativeRTC, key)); } catch {}
    }
    try { Object.defineProperty(proto, 'constructor', { value: RTCPeerConnection, writable: true, enumerable: false, configurable: true }); } catch {}
    // setConfiguration is the other way in: the same forcing applies.
    const nativeSet = proto.setConfiguration;
    if (typeof nativeSet === 'function') {
      defineMasked(proto, 'setConfiguration', {
        value: function setConfiguration(config) {
          const r = nativeSet.call(this, ZP.relayOnlyRTCConfiguration(config, ice));
          remember(this, config);
          return r;
        },
        writable: true, enumerable: true, configurable: true,
      });
    }
    const nativeGet = proto.getConfiguration;
    if (typeof nativeGet === 'function') {
      defineMasked(proto, 'getConfiguration', {
        value: function getConfiguration() {
          const c = nativeGet.call(this);
          const r = requested.get(this);
          if (r && c) { c.iceServers = r.iceServers; c.iceTransportPolicy = r.iceTransportPolicy; }
          return c;
        },
        writable: true, enumerable: true, configurable: true,
      });
    }
    return RTCPeerConnection;
  }

  // D4/D5 virtual gateway constructor. `.ready`/`.closed` (WebTransport) and
  // every async method reject with a structured ZeroProxy error so target
  // code's fallback flow (e.g. `await wt.ready.catch(() => fallback())`)
  // fires cleanly. When the real gateway (HTTP/3 for WT, pion SFU for RTC)
  // lands, this wrapper will dispatch through SW message channels instead.
  //
  // ★목록이 아니라 규칙이다 (2026-09-14, 프로토타입 모양 축). 예전엔 인터페이스별로
  // 손으로 고른 메서드 몇 개만 인스턴스에 심었다 — `proxy = {ready, closed,
  // close, addEventListener, ...}` 리터럴이라 프로토타입에는 아예 안 얹혔다.
  // 실측: RTCPeerConnection 45개, RTCDataChannel 20개, WebTransport 9개가
  // 대조군에만 있는 프로토타입이 됐다 — 오늘 CSS URL 프로퍼티 손목록에서 이미
  // 겪은 "손으로 고른 목록은 열린 표면을 못 따라간다" 를 세 번 더 한 것.
  // 지금은 **진짜 네이티브 프로토타입의 own 이름을 그대로 베껴** 프로토타입에
  // 심는다 — 이름(=모양)은 여기서 나오고, 동기/비동기 구분과 초기값만 아래
  // 작은 표에서 나온다. 표에 없는 이름이 나와도(스펙이 늘어나도) 모양은
  // 여전히 맞는다 — 값이 `null`/reject 로 떨어질 뿐 이름 자체가 빠지진 않는다.
  function makeVirtualGateway(name, meta) {
    // 비동기(Promise 반환) — 실측(2026-09-14, 각 인터페이스 스펙).
    const ASYNC_REJECT = new Set([
      'createOffer', 'createAnswer', 'setLocalDescription', 'setRemoteDescription',
      'addIceCandidate', 'getStats', 'createBidirectionalStream', 'createUnidirectionalStream',
    ]);
    // 동기인데 실제 자원(트랙/채널/트랜시버/전송)을 만들어야 해서 던진다.
    const SYNC_THROW = new Set(['createDataChannel', 'createDTMFSender', 'addTrack', 'addTransceiver', 'send']);
    const SYNC_ARRAY = new Set(['getSenders', 'getReceivers', 'getTransceivers', 'getLocalStreams', 'getRemoteStreams']);
    const SYNC_OBJECT = new Set(['getConfiguration']);
    // 나머지 동기 메서드(close 포함)는 no-op — 실제로 아무 상태도 없으니
    // undefined 반환이 스펙 위반이 아니다.
    const STATE_DEFAULTS = {
      signalingState: 'stable', iceConnectionState: 'new', iceGatheringState: 'new', connectionState: 'new',
      readyState: 'closed', binaryType: 'blob', bufferedAmount: 0, bufferedAmountLowThreshold: 0,
      negotiated: false, ordered: true, reliable: true, label: '', protocol: '',
    };
    const reason = name + ' requires the ZeroProxy ' + meta.kind +
      ' gateway, which is not yet provisioned (' + meta.code + ').';
    function gatewayError() {
      const err = normalizedError('NotSupportedError');
      try { err.zpCode = meta.code; err.zpReason = reason; } catch {}
      return err;
    }
    function rejected() {
      const p = Promise.reject(gatewayError());
      // Swallow the unhandled-rejection by attaching a noop catch — target
      // code that awaits this will still observe the rejection.
      try { p.catch(() => {}); } catch {}
      return p;
    }
    function VirtualGateway() {
      if (!(this instanceof VirtualGateway)) {
        throw new TypeError("Failed to construct '" + name + "': Please use the 'new' operator.");
      }
    }
    // 진짜 EventTarget 상속 모양(own 3개 안 늘어남) — 이 스텁엔 감쌀 네이티브
    // 인스턴스가 없으니(ZPWebTransport/ZPRTCPeerConnection 과 달리) XHR/WebSocket
    // 과 같은 가짜 리스너-맵을 그대로 써도 안전하다.
    installEventMethods(VirtualGateway.prototype);
    const sourceProto = name === 'webkitRTCPeerConnection'
      ? (root.RTCPeerConnection && root.RTCPeerConnection.prototype)
      : (root[name] && root[name].prototype);
    if (sourceProto) {
      const backing = new WeakMap();
      for (const propName of Object.getOwnPropertyNames(sourceProto)) {
        if (propName === 'constructor') continue;
        const d = Object.getOwnPropertyDescriptor(sourceProto, propName);
        try {
          if (typeof d.value === 'function') {
            let impl;
            if (ASYNC_REJECT.has(propName)) impl = rejected;
            else if (SYNC_THROW.has(propName)) impl = function () { throw gatewayError(); };
            else if (SYNC_ARRAY.has(propName)) impl = function () { return []; };
            else if (SYNC_OBJECT.has(propName)) impl = function () { return {}; };
            else impl = function () {};
            defineMasked(VirtualGateway.prototype, propName, { configurable: true, value: impl });
          } else if (/^on[a-z]/.test(propName) && d.get && d.set) {
            // 이벤트 핸들러 IDL 속성 — 인스턴스별 로컬 백업.
            defineMasked(VirtualGateway.prototype, propName, {
              configurable: true,
              get() { const m = backing.get(this); return (m && m.get(propName)) || null; },
              set(v) { let m = backing.get(this); if (!m) backing.set(this, m = new Map()); m.set(propName, typeof v === 'function' ? v : null); },
            });
          } else if (d.get && d.set) {
            // 일반 settable (예: RTCDataChannel.binaryType) — 쓴 값을 그대로 반사.
            const initial = Object.prototype.hasOwnProperty.call(STATE_DEFAULTS, propName) ? STATE_DEFAULTS[propName] : null;
            defineMasked(VirtualGateway.prototype, propName, {
              configurable: true,
              get() { const m = backing.get(this); return m && m.has(propName) ? m.get(propName) : initial; },
              set(v) { let m = backing.get(this); if (!m) backing.set(this, m = new Map()); m.set(propName, v); },
            });
          } else if (d.get) {
            const value = Object.prototype.hasOwnProperty.call(STATE_DEFAULTS, propName) ? STATE_DEFAULTS[propName] : null;
            defineMasked(VirtualGateway.prototype, propName, { configurable: true, get() { return value; } });
          }
        } catch {}
      }
    }
    // WebTransport: `.ready`/`.closed` 는 그 자체가 reject 다(target 코드가
    // `await wt.ready.catch(fallback)` 을 한다). 스트림/데이터그램은 비어
    // 있어도 **진짜** 객체여야 `for await` 리더가 매달리지 않고 끝난다.
    // 인스턴스당 동일 객체(네이티브 동일성: `wt.datagrams === wt.datagrams`).
    if (name === 'WebTransport') {
      const readyCache = new WeakMap(), closedCache = new WeakMap(), bidiCache = new WeakMap(), uniCache = new WeakMap(), dgCache = new WeakMap();
      const cached = (map, build) => function () { if (!map.has(this)) map.set(this, build()); return map.get(this); };
      defineMasked(VirtualGateway.prototype, 'ready', { configurable: true, get: cached(readyCache, rejected) });
      defineMasked(VirtualGateway.prototype, 'closed', { configurable: true, get: cached(closedCache, rejected) });
      defineMasked(VirtualGateway.prototype, 'incomingBidirectionalStreams', { configurable: true, get: cached(bidiCache, makeEmptyReadableStream) });
      defineMasked(VirtualGateway.prototype, 'incomingUnidirectionalStreams', { configurable: true, get: cached(uniCache, makeEmptyReadableStream) });
      defineMasked(VirtualGateway.prototype, 'datagrams', {
        configurable: true,
        get: cached(dgCache, () => ({ readable: makeEmptyReadableStream(), writable: makeRejectedWritableStream(gatewayError()), maxDatagramSize: 0 })),
      });
    }
    brandLikeNative(VirtualGateway, VirtualGateway.prototype, name);
    return VirtualGateway;
  }
  function makeEmptyReadableStream() {
    if (typeof ReadableStream !== 'function') return null;
    return new ReadableStream({ start(c) { c.close(); } });
  }
  function makeRejectedWritableStream(err) {
    if (typeof WritableStream !== 'function') return null;
    return new WritableStream({ start(c) { c.error(err); } });
  }