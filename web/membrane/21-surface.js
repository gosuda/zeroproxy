
  // ── 잔여 표면 가드 (P0) ────────────────────────────────────────────
  //
  // audit 에서 드러난 미처리 표면을 한 곳에서 다룬다:
  //
  //   ShadowRealm        — evaluate()/importValue() 가 **미리라이트 JS** 를
  //                        새 realm 에서 실행하고, importValue 의 절대 specifier
  //                        는 프록시를 우회하는 직접 egress 가 된다. realm 안에는
  //                        멤브레인이 없으므로 충실한 가상화는 별도 멤브레인을
  //                        realm 에 이식해야 가능하다 — 미출시 API 에 그 공수를
  //                        쓰기보다 실행 가능한 두 멤버를 fail-closed 한다.
  //                        생성자/`typeof` parity 는 남겨 기능 감지 코드를 깨지
  //                        않는다.
  //   navigator.credentials — 자격증명 저장소는 **실제 오리진**(프록시) 키라
  //                        모든 타깃이 한 저장소를 공유하고, WebAuthn 은 RP 가
  //                        proxy 호스트에 묶여 타깃 간 credential 이 섞인다.
  //                        get/store 는 NotAllowedError 로 거절한다 — 자격이
  //                        없는 오리진에 대한 네이티브 응답과 같은 모양이다.
  //   navigator.locks    — LockManager 는 실제 오리진 단위라 타깃 간 잠금 이름이
  //                        충돌한다. 타깃 해시 프리픽스로 네임스페이스하고
  //                        query() 결과에서는 프리픽스를 벗겨 돌려준다.
  //   Notification/MediaSession — icon/badge/artwork URL 은 브라우저가 직접
  //                        fetch 한다. 타깃 절대 URL 이 그대로 나가면 직접
  //                        egress — 서브리소스 프록시 경로로 재작성한다.
  function installSurfaceGuards(w) {
    // ShadowRealm — 생성자는 살리고 실행 진입점만 봉인한다.
    try {
      const SR = w.ShadowRealm;
      if (typeof SR === 'function' && SR.prototype) {
        const denyEval = function evaluate() { throw normalizedError('NotSupportedError'); };
        const denyImport = function importValue() { return Promise.reject(normalizedError('NotSupportedError')); };
        define(SR.prototype, 'evaluate', denyEval);
        define(SR.prototype, 'importValue', denyImport);
      }
    } catch {}
    // navigator.credentials — 저장소 접근 자체를 거절한다. PublicKeyCredential
    // 의 정적 가용성 질의는 "인증기 없음" 답으로 둬 기능 감지를 유지한다.
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
    // navigator.locks — 타깃별 잠금 네임스페이스.
    try {
      const nav = w.navigator;
      const lm = nav && nav.locks;
      if (lm && typeof lm.request === 'function') {
        const LMProto = (w.LockManager && w.LockManager.prototype) || Object.getPrototypeOf(lm);
        const h = (() => { let x = 0x811c9dc5; const s = String(virtualURL.origin); for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return ('00000000' + (x >>> 0).toString(16)).slice(-8); })();
        const pfx = 'zp:lk:' + h + ':';
        const nativeRequest = LMProto.request;
        const nativeQuery = LMProto.query;
        const stripInfo = info => (info && typeof info === 'object' && typeof info.name === 'string' && info.name.indexOf(pfx) === 0)
          ? Object.assign({}, info, { name: info.name.slice(pfx.length) }) : info;
        if (typeof nativeRequest === 'function') {
          define(LMProto, 'request', function request(name, ...rest) {
            return nativeRequest.call(this, pfx + String(name), ...rest);
          });
        }
        if (typeof nativeQuery === 'function') {
          define(LMProto, 'query', function query() {
            return nativeQuery.call(this).then(r => ({
              held: (r && r.held || []).map(stripInfo),
              pending: (r && r.pending || []).map(stripInfo),
            }));
          });
        }
      }
    } catch {}
    // Notification — icon/badge/image/actions[].icon 은 브라우저가 직접
    // fetch 한다. 타깃 URL 을 프록시 서브리소스 경로로 재작성해 egress 를 막는다.
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
        try { Object.defineProperty(ZPNotification, 'name', { value: 'Notification', configurable: true }); } catch {}
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
    // MediaSession — metadata.artwork[].src 재작성.
    try {
      const ms = w.navigator && w.navigator.mediaSession;
      if (ms) {
        const MSProto = (w.MediaSession && w.MediaSession.prototype) || Object.getPrototypeOf(ms);
        const nativeSetMetadata = Object.getOwnPropertyDescriptor(MSProto, 'metadata');
        if (nativeSetMetadata && nativeSetMetadata.set) {
          defineMasked(MSProto, 'metadata', {
            get: nativeSetMetadata.get ? function get() { return nativeSetMetadata.get.call(this); } : undefined,
            set: function set(meta) {
              try {
                if (meta && meta.artwork && Array.isArray(meta.artwork)) {
                  meta = Object.assign({}, meta, {
                    artwork: meta.artwork.map(a => (a && typeof a.src === 'string' && /^https?:/i.test(a.src))
                      ? Object.assign({}, a, { src: subresourceProxyPath(targetURL(a.src)) }) : a),
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