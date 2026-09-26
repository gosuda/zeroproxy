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
      const gw = new URL(gateway);
      const params = gw.searchParams;
      params.set('target', target);
      if (boot && boot.tabId) params.set('tab', String(boot.tabId));
      // Build the gateway URL with our target injected. The native WT
      // ctor will throw SyntaxError if the gw URL isn't https.
      const native = new NativeWT(gw.toString(), opts);
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

  // D5: virtual RTCPeerConnection that wraps the *native* RTCPC and
  // routes all signaling (offer / answer / ICE candidates) through the
  // ZeroProxy gateway (`boot.rtcGateway`). Native RTCPC handles the
  // media/DTLS/SCTP stack locally; the gateway maintains a parallel
  // PeerConnection on its side and SFU-forwards tracks + data channels
  // to the target's real remote peer. The target never sees the page's
  // real IP because all candidates that reach the remote peer originate
  // from the gateway.
  //
  // When `boot.rtcGateway` is empty (operator hasn't enabled the D5
  // gateway) or native RTCPC is absent, we fall back to the legacy
  // rejected-promise stub (`makeVirtualGateway`).
  function makeRTCPeerConnectionConstructor(name) {
    const NativeRTC = root.RTCPeerConnection || root.webkitRTCPeerConnection;
    const gateway = (boot && typeof boot.rtcGateway === 'string' && boot.rtcGateway) ? boot.rtcGateway : '';
    if (!NativeRTC || !gateway) {
      return makeVirtualGateway(name, { code: 'RTC_GATEWAY_UNAVAILABLE', kind: 'WebRTC' });
    }
    let sessionCounter = 0;
    function ZPRTCPeerConnection(config) {
      if (!(this instanceof ZPRTCPeerConnection)) {
        throw new TypeError("Failed to construct '" + name + "': Please use the 'new' operator.");
      }
      // We don't trust the page-supplied iceServers — they'd point at
      // remote STUN/TURN that could leak IP. Replace with the
      // operator's embedded TURN cred tuple (from `boot.rtcICEServers`)
      // when present; otherwise force empty so the native PC only
      // generates host candidates the gateway signaling can route.
      const safeConfig = Object.assign({}, config || {});
      const issuedICEServers = (boot && Array.isArray(boot.rtcICEServers))
        ? boot.rtcICEServers
        : [];
      safeConfig.iceServers = issuedICEServers;
      safeConfig.iceTransportPolicy = 'all';
      const native = new NativeRTC(safeConfig);
      this._native = native;
      const sid = (boot && boot.tabId ? boot.tabId : 'sess') + '-' + (++sessionCounter) + '-' + Date.now().toString(36);
      this._sessionId = sid;
      // Forward locally-generated ICE candidates to the gateway.
      try {
        native.addEventListener('icecandidate', ev => {
          const cand = ev && ev.candidate;
          if (!cand) return;
          postSignal({ op: 'candidate', sessionId: sid, candidate: cand.toJSON ? cand.toJSON() : { candidate: cand.candidate, sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex } });
        });
      } catch {}
      // Start the long-poll loop to pull gateway-originated events.
      this._pollCtl = startSignalPoll(this, sid);
    }
    function postSignal(env) {
      try {
        return Native.fetch(gateway, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(env),
          credentials: 'same-origin',
        });
      } catch { return Promise.resolve(); }
    }
    function startSignalPoll(self, sid) {
      let stopped = false;
      (async function loop() {
        while (!stopped) {
          try {
            const r = await Native.fetch(gateway + '?session=' + encodeURIComponent(sid), { credentials: 'same-origin' });
            if (!r.ok) { await new Promise(res => setTimeout(res, 1000)); continue; }
            const envs = await r.json();
            if (!Array.isArray(envs)) continue;
            for (const env of envs) {
              try { await applyEnvelope(self, env); } catch {}
            }
          } catch {
            await new Promise(res => setTimeout(res, 1000));
          }
        }
      })();
      return { stop() { stopped = true; } };
    }
    async function applyEnvelope(self, env) {
      if (!env || typeof env !== 'object') return;
      if (env.op === 'answer' && env.sdp) {
        await self._native.setRemoteDescription(env.sdp);
      } else if (env.op === 'offer' && env.sdp) {
        await self._native.setRemoteDescription(env.sdp);
        const ans = await self._native.createAnswer();
        await self._native.setLocalDescription(ans);
        postSignal({ op: 'answer', sessionId: self._sessionId, sdp: self._native.localDescription });
      } else if (env.op === 'candidate' && env.candidate) {
        try { await self._native.addIceCandidate(env.candidate); } catch {}
      } else if (env.op === 'close') {
        try { self._native.close(); } catch {}
      }
    }
    // Forward every spec method/getter; intercept SDP-bearing ones so we
    // can route them through the gateway in addition to the native PC.
    function delegate(name) {
      defineMasked(ZPRTCPeerConnection.prototype, name, {
        configurable: true,
        get() { try { return this._native[name]; } catch { return undefined; } },
      });
    }
    ['localDescription', 'remoteDescription', 'pendingLocalDescription', 'pendingRemoteDescription',
     'currentLocalDescription', 'currentRemoteDescription',
     'signalingState', 'iceGatheringState', 'iceConnectionState', 'connectionState',
     'canTrickleIceCandidates', 'sctp']
      .forEach(delegate);
    ZPRTCPeerConnection.prototype.createOffer = function(opts) { return this._native.createOffer(opts); };
    ZPRTCPeerConnection.prototype.createAnswer = function(opts) { return this._native.createAnswer(opts); };
    ZPRTCPeerConnection.prototype.setLocalDescription = async function(desc) {
      const r = await this._native.setLocalDescription(desc);
      // After local SDP is finalized, forward it to the gateway so the
      // gateway's target-side PC can complete its half of the handshake.
      const local = this._native.localDescription;
      if (local && local.sdp) {
        postSignal({ op: local.type === 'offer' ? 'offer' : 'answer', sessionId: this._sessionId, sdp: { type: local.type, sdp: local.sdp } });
      }
      return r;
    };
    ZPRTCPeerConnection.prototype.setRemoteDescription = function(desc) { return this._native.setRemoteDescription(desc); };
    ZPRTCPeerConnection.prototype.addIceCandidate = function(cand) { return this._native.addIceCandidate(cand); };
    ZPRTCPeerConnection.prototype.addTrack = function(track, ...streams) { return this._native.addTrack(track, ...streams); };
    ZPRTCPeerConnection.prototype.removeTrack = function(sender) { return this._native.removeTrack(sender); };
    ZPRTCPeerConnection.prototype.getSenders = function() { return this._native.getSenders(); };
    ZPRTCPeerConnection.prototype.getReceivers = function() { return this._native.getReceivers(); };
    ZPRTCPeerConnection.prototype.getTransceivers = function() { return this._native.getTransceivers(); };
    ZPRTCPeerConnection.prototype.addTransceiver = function(...args) { return this._native.addTransceiver(...args); };
    ZPRTCPeerConnection.prototype.getStats = function(selector) { return this._native.getStats(selector); };
    ZPRTCPeerConnection.prototype.createDataChannel = function(label, opts) { return this._native.createDataChannel(label, opts); };
    ZPRTCPeerConnection.prototype.close = function() {
      try { this._pollCtl && this._pollCtl.stop(); } catch {}
      postSignal({ op: 'close', sessionId: this._sessionId });
      try { return this._native.close(); } catch { return undefined; }
    };
    ZPRTCPeerConnection.prototype.addEventListener = function(type, listener, opts) {
      try { return this._native.addEventListener(type, listener, opts); } catch {}
    };
    ZPRTCPeerConnection.prototype.removeEventListener = function(type, listener, opts) {
      try { return this._native.removeEventListener(type, listener, opts); } catch {}
    };
    ZPRTCPeerConnection.prototype.dispatchEvent = function(ev) {
      try { return this._native.dispatchEvent(ev); } catch { return true; }
    };
    // ★installEventMethods (공유 eventTargetProto) 는 여기 안 쓴다 — ZPWebTransport
    // 와 같은 이유: 이 클래스는 진짜 native RTCPeerConnection(_native) 을
    // 감싸고 그게 스스로 이벤트를 낸다. 가짜 리스너 맵으로 바꾸면 native 가
    // 내는 icecandidate/track/datachannel 이벤트가 안 닿는다.
    brandLikeNative(ZPRTCPeerConnection, ZPRTCPeerConnection.prototype, name);
    return ZPRTCPeerConnection;
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