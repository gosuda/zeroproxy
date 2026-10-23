  // Virtual WebTransport that proxies through the ZeroProxy gateway when
  // `boot.wtGateway` is configured. Wraps the native WebTransport against the
  // gateway URL while delegating `ready`, `closed`, streams, and datagrams to
  // the underlying native instance. Falls back to the rejected-promise stub
  // when `boot.wtGateway` is empty or the browser lacks native WebTransport.
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
      // Mirror native URL validation so feature-detection of invalid URLs throws SyntaxError.
      let parsed;
      try { parsed = new URL(target); } catch { throw normalizedError('SyntaxError'); }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'wt:') {
        throw normalizedError('SyntaxError');
      }
      // Target-side certificate pins go to the gateway; the gateway's own pin
      // comes from the server configuration.
      const req = ZP.webTransportGatewayRequest(gateway, target, boot && boot.tabId, opts, boot && boot.wtGatewayCertHashes);
      const native = new NativeWT(req.url, req.options);
      this._native = native;
    }
    // Forward readonly properties from the prototype to the native instance so
    // `wt instanceof WebTransport` succeeds against our constructor.
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
    // Delegate EventTarget methods directly to `_native` because events fire on
    // the underlying native WebTransport instance rather than a synthetic map.
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

  // WebRTC runs relay-only through the operator's TURN server. The page keeps a
  // genuine native RTCPeerConnection while ICE configuration is forced through
  // `ZP.relayOnlyRTCConfiguration` (`boot.rtcICEServers` and
  // `iceTransportPolicy: 'relay'`), so only relay candidates are gathered and
  // DTLS/SRTP stay end-to-end. Without TURN credentials the connection is
  // configured with no ICE servers at all, so it gathers no candidate and sends
  // no packet: `createOffer`, `createDataChannel` and the rest of the local API
  // work as in a browser (a page that builds an offer to read its codecs gets
  // one) but nothing connects. The virtual gateway stub remains for a browser
  // without `RTCPeerConnection`.
  function makeRTCPeerConnectionConstructor(w, name) {
    const NativeRTC = w.RTCPeerConnection || w.webkitRTCPeerConnection;
    const ice = (boot && Array.isArray(boot.rtcICEServers)) ? boot.rtcICEServers.filter(s => s && s.urls) : [];
    if (typeof NativeRTC !== 'function') {
      return makeVirtualGateway(name, { code: 'RTC_GATEWAY_UNAVAILABLE', kind: 'WebRTC' });
    }
    // Preserve the page-supplied configuration so `getConfiguration()` returns
    // what the caller requested rather than our TURN credentials and relay policy.
    const requested = newWeakMap();
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
      // `new.target` preserves page subclasses (`class X extends RTCPeerConnection`).
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

  // Virtual gateway constructor used when a WebTransport or WebRTC gateway is
  // not provisioned. Copies own property names from the native prototype so the
  // prototype shape matches the browser's IDL surface while rejecting async
  // methods and throwing on resource-allocating sync methods.
  function makeVirtualGateway(name, meta) {
    const ASYNC_REJECT = newSet([
      'createOffer', 'createAnswer', 'setLocalDescription', 'setRemoteDescription',
      'addIceCandidate', 'getStats', 'createBidirectionalStream', 'createUnidirectionalStream',
    ]);
    const SYNC_THROW = newSet(['createDataChannel', 'createDTMFSender', 'addTrack', 'addTransceiver', 'send']);
    const SYNC_ARRAY = newSet(['getSenders', 'getReceivers', 'getTransceivers', 'getLocalStreams', 'getRemoteStreams']);
    const SYNC_OBJECT = newSet(['getConfiguration']);
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
      // Attach a no-op catch handler to suppress unhandled-rejection noise while
      // keeping the promise rejected for callers that await it.
      try { p.catch(() => {}); } catch {}
      return p;
    }
    function VirtualGateway() {
      if (!(this instanceof VirtualGateway)) {
        throw new TypeError("Failed to construct '" + name + "': Please use the 'new' operator.");
      }
    }
    installEventMethods(VirtualGateway.prototype);
    const sourceProto = name === 'webkitRTCPeerConnection'
      ? (root.RTCPeerConnection && root.RTCPeerConnection.prototype)
      : (root[name] && root[name].prototype);
    if (sourceProto) {
      const backing = newWeakMap();
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
            defineMasked(VirtualGateway.prototype, propName, {
              configurable: true,
              get() { const m = backing.get(this); return (m && m.get(propName)) || null; },
              set(v) { let m = backing.get(this); if (!m) backing.set(this, m = newMap()); m.set(propName, typeof v === 'function' ? v : null); },
            });
          } else if (d.get && d.set) {
            const initial = Object.prototype.hasOwnProperty.call(STATE_DEFAULTS, propName) ? STATE_DEFAULTS[propName] : null;
            defineMasked(VirtualGateway.prototype, propName, {
              configurable: true,
              get() { const m = backing.get(this); return m && m.has(propName) ? m.get(propName) : initial; },
              set(v) { let m = backing.get(this); if (!m) backing.set(this, m = newMap()); m.set(propName, v); },
            });
          } else if (d.get) {
            const value = Object.prototype.hasOwnProperty.call(STATE_DEFAULTS, propName) ? STATE_DEFAULTS[propName] : null;
            defineMasked(VirtualGateway.prototype, propName, { configurable: true, get() { return value; } });
          }
        } catch {}
      }
    }
    // For WebTransport, `.ready` and `.closed` return per-instance rejected
    // promises and stream getters return closed streams so `for await` readers
    // terminate cleanly and preserve reference identity (`wt.datagrams === wt.datagrams`).
    if (name === 'WebTransport') {
      const readyCache = newWeakMap(), closedCache = newWeakMap(), bidiCache = newWeakMap(), uniCache = newWeakMap(), dgCache = newWeakMap();
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