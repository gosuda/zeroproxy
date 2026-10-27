  // Surface guards for APIs that would otherwise bypass the membrane or leak
  // cross-target state:
  //   - ShadowRealm: `evaluate()` and `importValue()` execute unrewritten code
  //     or fetch module specifiers directly; seal both entry points while
  //     keeping the constructor intact for feature detection.
  //   - navigator.credentials: credential storage and WebAuthn RP IDs are bound
  //     to the physical proxy origin; reject `get`/`store`/`create` with
  //     `NotAllowedError`.
  //   - navigator.locks: `LockManager` is shared across the physical origin;
  //     prefix lock names with a target-origin hash and strip the prefix from
  //     `query()` results.
  //   - Notification / MediaSession: rewrite icon, badge, image, and artwork
  //     URLs through the subresource proxy path so browser-initiated fetches do
  //     not egress directly to the target.
  function installSurfaceGuards(w) {
    try {
      const SR = w.ShadowRealm;
      if (typeof SR === 'function' && SR.prototype) {
        const denyEval = function evaluate() { throw normalizedError('NotSupportedError'); };
        const denyImport = function importValue() { return Promise.reject(normalizedError('NotSupportedError')); };
        define(SR.prototype, 'evaluate', denyEval);
        define(SR.prototype, 'importValue', denyImport);
      }
    } catch {}
    try {
      const nav = w.navigator;
      if (nav && nav.credentials) {
        const CCProto = (w.CredentialsContainer && w.CredentialsContainer.prototype) || Object.getPrototypeOf(nav.credentials);
        const denyGet = function get() { return Promise.reject(normalizedError('NotAllowedError')); };
        const denyStore = function store() { return Promise.reject(normalizedError('NotAllowedError')); };
        const denyCreate = function create() { return Promise.reject(normalizedError('NotAllowedError')); };
        const allowPrevent = function preventSilentAccess() { return Promise.resolve(undefined); };
        if (CCProto) {
          define(CCProto, 'get', denyGet);
          define(CCProto, 'store', denyStore);
          define(CCProto, 'create', denyCreate);
          define(CCProto, 'preventSilentAccess', allowPrevent);
        } else {
          define(nav.credentials, 'get', denyGet);
          define(nav.credentials, 'store', denyStore);
          define(nav.credentials, 'create', denyCreate);
          define(nav.credentials, 'preventSilentAccess', allowPrevent);
        }
        const PKC = w.PublicKeyCredential;
        if (typeof PKC === 'function') {
          define(PKC, 'isUserVerifyingPlatformAuthenticator', function isUserVerifyingPlatformAuthenticator() { return Promise.resolve(false); });
          define(PKC, 'isConditionalMediationAvailable', function isConditionalMediationAvailable() { return Promise.resolve(false); });
        }
      }
    } catch {}
    try {
      const nav = w.navigator;
      const lm = nav && nav.locks;
      if (lm && typeof lm.request === 'function') {
        const LMProto = (w.LockManager && w.LockManager.prototype) || Object.getPrototypeOf(lm);
        const h = (() => { let x = 0x811c9dc5; const s = String(securityOrigin()); for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return ('00000000' + (x >>> 0).toString(16)).slice(-8); })();
        const pfx = 'zp:lk:' + h + ':';
        const nativeRequest = LMProto.request;
        const nativeQuery = LMProto.query;
        const stripInfo = info => (info && typeof info === 'object' && typeof info.name === 'string' && info.name.indexOf(pfx) === 0)
          ? Object.assign({}, info, { name: info.name.slice(pfx.length) }) : info;
        if (typeof nativeRequest === 'function') {
          define(LMProto, 'request', function request(name, ...rest) {
            if (opaqueDocument) return Promise.reject(opaqueDenied("Failed to execute 'request' on 'LockManager'", 'Access to the Locks API is denied in this context.'));
            return nativeRequest.call(this, pfx + String(name), ...rest);
          });
        }
        if (typeof nativeQuery === 'function') {
          // Return only locks belonging to this virtual origin with the namespace prefix stripped.
          const ours = info => !!info && typeof info === 'object' && typeof info.name === 'string' && info.name.indexOf(pfx) === 0;
          define(LMProto, 'query', function query() {
            if (opaqueDocument) return Promise.reject(opaqueDenied("Failed to execute 'query' on 'LockManager'", 'Access to the Locks API is denied in this context.'));
            return nativeQuery.call(this).then(r => ({
              held: (r && r.held || []).filter(ours).map(stripInfo),
              pending: (r && r.pending || []).filter(ours).map(stripInfo),
            }));
          });
        }
      }
    } catch {}
    try {
      if (typeof w.Notification === 'function') {
        const NativeNotification = w.Notification;
        const rewriteIconOpts = o => {
          if (!o || typeof o !== 'object') return o;
          const out = Object.assign({}, o);
          for (const k of ['icon', 'badge', 'image']) {
            if (typeof out[k] === 'string' && /^https?:/i.test(out[k])) out[k] = subresourceProxyPath(targetURL(out[k]));
          }
          if (Array.isArray(out.actions)) {
            out.actions = out.actions.map(a => (a && typeof a.icon === 'string' && /^https?:/i.test(a.icon))
              ? Object.assign({}, a, { icon: subresourceProxyPath(targetURL(a.icon)) }) : a);
          }
          return out;
        };
        const ZPNotification = function Notification(title, opts) { return new NativeNotification(title, rewriteIconOpts(opts)); };
        ZPNotification.prototype = NativeNotification.prototype;
        try { Object.defineProperty(ZPNotification, 'length', { value: NativeNotification.length, configurable: true }); } catch {}
        maskNativeFunction(ZPNotification, 'Notification');
        for (const k of ['permission', 'maxActions']) {
          try { defineAccessor(ZPNotification, k, () => NativeNotification[k]); } catch {}
        }
        if (typeof NativeNotification.requestPermission === 'function') {
          define(ZPNotification, 'requestPermission', function requestPermission(cb) {
            const p = NativeNotification.requestPermission(cb);
            return p && typeof p.then === 'function' ? p : Promise.resolve(p);
          });
        }
        define(w, 'Notification', ZPNotification);
      }
    } catch {}
    try {
      const ms = w.navigator && w.navigator.mediaSession;
      if (ms) {
        const MSProto = (w.MediaSession && w.MediaSession.prototype) || Object.getPrototypeOf(ms);
        const nativeSetMetadata = Object.getOwnPropertyDescriptor(MSProto, 'metadata');
        const NativeMediaMetadata = w.MediaMetadata;
        if (nativeSetMetadata && nativeSetMetadata.set) {
          defineMasked(MSProto, 'metadata', {
            get: nativeSetMetadata.get ? function get() { return nativeSetMetadata.get.call(this); } : undefined,
            set: function set(meta) {
              // The browser's media UI fetches artwork itself, so a target URL has to be the proxy's by the time the metadata reaches it. The setter takes a `MediaMetadata` (or
              // null) and refuses any other object, so the rewritten copy is a native `MediaMetadata` built from the same fields: a plain object here made every assignment with
              // artwork throw `Failed to convert value to 'MediaMetadata'` (the Twitch player stopped on it).
              try {
                // A relative address was resolved against the proxy's own origin when the `MediaMetadata` was made; the service worker maps that back, so only a target address is rewritten.
                const isTarget = a => !!a && typeof a.src === 'string' && /^https?:/i.test(a.src) && !a.src.startsWith(proxyOrigin);
                if (meta && typeof NativeMediaMetadata === 'function' && Array.isArray(meta.artwork) && meta.artwork.some(isTarget)) {
                  meta = new NativeMediaMetadata({
                    title: meta.title, artist: meta.artist, album: meta.album,
                    artwork: meta.artwork.map(a => (isTarget(a) ? { src: subresourceProxyPath(targetURL(a.src)), sizes: a.sizes, type: a.type } : a)),
                  });
                }
              } catch {}
              return nativeSetMetadata.set.call(this, meta);
            },
            enumerable: true, configurable: false,
          });
        }
      }
    } catch {}
  }