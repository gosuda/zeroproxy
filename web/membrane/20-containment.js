  function installNetworkContainment(w) {
    if (!w) return;
    try { if (w[networkContainmentMarker]) return; } catch {}
    installToStringMasking(w);
    // OXC rewrite 결과는 `__zp_get/set/call/construct/...` 헬퍼를 호출한다.
    // about:blank ad iframe (NAVER GFP SafeFrame 등) 은 자체 prelude 가 안 돌고
    // 부모가 installNetworkContainment 만 깐다 → 이 헬퍼들이 부재하면 SW 가
    // rewrite 한 외부 스크립트가 `__zp_get is not defined` 로 즉시 throw,
    // window.onerror=()=>true 가 silence → 광고 미렌더. 부모 wrapper 를
    // 위임으로 노출해 멤브레인 의미를 보존한다 (location 가상화·dynamic ctor
    // wrap·dangerous-prop dispatch 모두 부모 closure 가 처리). 자식 native
    // global 접근은 base[prop] 으로 fall through.
    if (root.__zp_get && !define(w, '__zp_get', root.__zp_get)) throw normalizedError('SecurityError');
    if (root.__zp_set && !define(w, '__zp_set', root.__zp_set)) throw normalizedError('SecurityError');
    if (root.__zp_assign && !define(w, '__zp_assign', root.__zp_assign)) throw normalizedError('SecurityError');
    if (root.__zp_call && !define(w, '__zp_call', root.__zp_call)) throw normalizedError('SecurityError');
    if (root.__zp_update && !define(w, '__zp_update', root.__zp_update)) throw normalizedError('SecurityError');
    if (root.__zp_construct && !define(w, '__zp_construct', root.__zp_construct)) throw normalizedError('SecurityError');
    if (root.__zp_has && !define(w, '__zp_has', root.__zp_has)) throw normalizedError('SecurityError');
    if (root.__zp_getOwnPropertyDescriptor && !define(w, '__zp_getOwnPropertyDescriptor', root.__zp_getOwnPropertyDescriptor)) throw normalizedError('SecurityError');
    if (root.__zp_ownKeys && !define(w, '__zp_ownKeys', root.__zp_ownKeys)) throw normalizedError('SecurityError');
    if (root.__zp_module_url && !define(w, '__zp_module_url', root.__zp_module_url)) throw normalizedError('SecurityError');
    if (root.__zp_delete && !define(w, '__zp_delete', root.__zp_delete)) throw normalizedError('SecurityError');
    if (root.__zp_odelete && !define(w, '__zp_odelete', root.__zp_odelete)) throw normalizedError('SecurityError');
    if (root.__zp_oget && !define(w, '__zp_oget', root.__zp_oget)) throw normalizedError('SecurityError');
    if (root.__zp_ocall && !define(w, '__zp_ocall', root.__zp_ocall)) throw normalizedError('SecurityError');
    if (root.__zp_rget && !define(w, '__zp_rget', root.__zp_rget)) throw normalizedError('SecurityError');
    if (root.__zp_rset && !define(w, '__zp_rset', root.__zp_rset)) throw normalizedError('SecurityError');
    if (root.__zp_getOwnPropertyDescriptors && !define(w, '__zp_getOwnPropertyDescriptors', root.__zp_getOwnPropertyDescriptors)) throw normalizedError('SecurityError');
    if (root.__zp_getOwnPropertyNames && !define(w, '__zp_getOwnPropertyNames', root.__zp_getOwnPropertyNames)) throw normalizedError('SecurityError');
    if (root.__zp_okeys && !define(w, '__zp_okeys', root.__zp_okeys)) throw normalizedError('SecurityError');
    if (root.__zp_with_get && !define(w, '__zp_with_get', root.__zp_with_get)) throw normalizedError('SecurityError');
    if (root.__zp_with_set && !define(w, '__zp_with_set', root.__zp_with_set)) throw normalizedError('SecurityError');
    if (root.__zp_with_assign && !define(w, '__zp_with_assign', root.__zp_with_assign)) throw normalizedError('SecurityError');
    if (root.__zp_with_update && !define(w, '__zp_with_update', root.__zp_with_update)) throw normalizedError('SecurityError');
    if (root.__zp_with_delete && !define(w, '__zp_with_delete', root.__zp_with_delete)) throw normalizedError('SecurityError');
    if (root.__zp_with_d && !define(w, '__zp_with_d', root.__zp_with_d)) throw normalizedError('SecurityError');
    if (root.__zp_nav_assign && !define(w, '__zp_nav_assign', root.__zp_nav_assign)) throw normalizedError('SecurityError');
    if (root.__zp_nav_replace && !define(w, '__zp_nav_replace', root.__zp_nav_replace)) throw normalizedError('SecurityError');
    if (root.__zp_runClassic && !define(w, '__zp_runClassic', root.__zp_runClassic)) throw normalizedError('SecurityError');
    if (root.__zp_runEvent && !define(w, '__zp_runEvent', root.__zp_runEvent)) throw normalizedError('SecurityError');
    // 인라인 스크립트 wrapper. transformHTML 이 `<script>body</script>` 를
    // `<script>__ZP_EXEC_INLINE_SCRIPT("body")</script>` 로 바꿔서 부모/iframe
    // 모두에서 동기 rewrite + 실행. iframe 에 wrapper 부재면 ReferenceError →
    // SafeFrame iframe template 의 `window.onerror=()=>true` 같은 짧은 inline 도
    // 즉시 실패해서 error swallow 가 안 깔리고 후속 광고 코드 silent 실패.
    //
    // 부모 wrapper 를 그대로 위임하면 `Native.FunctionCtor(...).call(root)` 가
    // 부모 realm 에서 실행 → iframe 의 `window.X` 작성이 부모 window 에 가버린다.
    // SafeFrame 광고는 iframe.name JSON 의 adm 을 자기 window 에 접근해야 하므로
    // realm 분리가 깨지면 절대 안 됨. 자식 realm 의 native Function (overwrite 전
    // 캡처) 으로 새 함수를 만들어 child window 에서 실행하면 realm 보존.
    const childFunction = w.Function;
    let childFunctionFacade;
    if (childFunction) {
      // Same global-scope requirement as the parent realm's
      // `execGlobalScript` — classic script declarations must land on the
      // child's global object, not inside a Function-constructor scope, or
      // one inline script's `function foo(){}` is invisible to the next.
      // Capture the child executor before installing its own rewrite gate.
      const childEval = w.eval;
      const childExecGlobal = code => childEval ? childEval(code) : (new childFunction(code)).call(w);
      // `pageRewriteHooks` rather than the bare helpers: they are locals of
      // `installPhase2Membrane`, invisible from this function's scope.
      const childRewrite = (source, kind) => {
        const hooks = pageRewriteHooks;
        if (!hooks) throw normalizedError('InvalidStateError');
        return hooks.rewrite(hooks.decodeEntities(source), kind);
      };
      // A self-bootstrapping srcdoc may capture these guarded intrinsics before
      // installing its own runtime. They must still compile/execute in this
      // child: copying root.eval/Function moves listeners and globals to root.
      const childDynamicEval = function dynamicEval(value) {
        if (new.target) throw new TypeError('eval is not a constructor');
        return typeof value === 'string' ? childExecGlobal(pageRewriteHooks.rewrite(value, 'eval')) : value;
      };
      childFunctionFacade = function Function(...args) {
        // The native constructor validates/converts parameters exactly once;
        // creating the function does not execute its unrewritten body.
        const original = Reflect.construct(childFunction, args);
        const source = origToString.call(original);
        const compiled = childExecGlobal(pageRewriteHooks.rewrite('(' + source + ')', 'classic'));
        toStringMap.set(compiled, source);
        return compiled;
      };
      Object.defineProperty(childFunctionFacade, 'prototype', { value: childFunction.prototype });
      Object.defineProperty(childFunctionFacade, 'length', { value: 1 });
      maskNativeFunction(childDynamicEval, 'eval');
      maskNativeFunction(childFunctionFacade, 'Function');
      if (!define(w, 'eval', childDynamicEval) || !define(w, 'Function', childFunctionFacade)) throw normalizedError('SecurityError');
      // Ordered script pipeline for this child realm.
      //
      // A `<script src>` written by `document.write` is PARSER-BLOCKING: the
      // parser stops until it loads, so the next inline script sees the globals
      // it defined. Our external loader is a `fetch`, so without a queue the
      // following inline script wins the race — which is exactly the NAVER ad
      // failure (`bridge.createSdkBridge is not a function`,
      // `naver_corp_da is not defined`).
      //
      // Every executor below goes through `childEnqueue`, so execution order
      // matches document order regardless of how the code arrived. Downloads
      // still start the moment the loader is called, so scripts fetch in
      // parallel and only their EXECUTION is serialized — the same shape the
      // browser gives `<script defer>`.
      //
      // Fast path: with an empty queue the work runs synchronously, so a realm
      // that never loads an external script keeps today's exact semantics and
      // nothing becomes async that was not already.
      let childTail = null;
      let childPending = 0;
      const childReportError = err => {
        // Surface it the way a real script error would, without breaking the
        // chain — one failing creative must not stall the rest of the queue.
        try { (w.setTimeout || setTimeout)(() => { throw err; }, 0); } catch {}
      };
      const childSettle = () => { if (--childPending === 0) childTail = null; };
      // Ordering must never become a liveness risk. A real parser blocks forever
      // on a stalled `<script src>`, but a stall here is OUR failure (relay
      // hiccup, wedged transport), not the site's, and it would silently strand
      // every later script in this realm — an ad slot that never fills and no
      // error anywhere. So there is a cap; the stranded script still runs if it
      // eventually lands, just out of order.
      //
      // Two things about the cap are load-bearing, both learned the hard way
      // (the first version got them both wrong and regressed NAVER's ad bridge
      // straight back to `bridge.createSdkBridge is not a function`):
      //
      //  1. The deadline is PER ITEM, timed from when that item starts running.
      //     Capping the wait on the queue tail instead makes the deadline
      //     cumulative — every item's timer starts at ENQUEUE, which for a
      //     written chunk is all at once, so a realm whose scripts collectively
      //     exceed the cap loses ordering even though nothing stalled.
      //  2. It is a stall detector, not a slowness budget. Measured on NAVER,
      //     a 5 s cap fired 3 times per load — those were slow-but-live scripts,
      //     and firing broke exactly the ordering this queue exists to keep.
      const CHILD_STALL_MS = 30000;
      const childCapped = pending => new Promise(resolve => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(); } };
        // Report rejections here: `childCapped` resolves either way, so a
        // `.catch` downstream would never see them.
        Promise.resolve(pending).then(finish, err => { childReportError(err); finish(); });
        try { (w.setTimeout || setTimeout)(() => {
          // Record it: a firing cap means ordering was abandoned, and that is
          // otherwise invisible — no error, just an ad slot that misbehaves.
          if (!settled) try {
            const diag = root.__zp_diagnostics;
            if (diag && diag.length < 200) diag.push({ t: 'script-stall', ms: CHILD_STALL_MS });
          } catch {}
          finish();
        }, CHILD_STALL_MS); } catch { finish(); }
      });
      const childRunDeferred = work => {
        deferredScriptDepth++;
        try { return work(); } finally { deferredScriptDepth--; }
      };
      const childEnqueue = work => {
        if (!childTail) {
          let result;
          try { result = work(); } catch (err) { childReportError(err); return; }
          if (!result || typeof result.then !== 'function') return result;
          childPending++;
          // `childCapped` starts this item's stall timer now, i.e. when the
          // item itself started — see the per-item note above.
          childTail = childCapped(result).then(childSettle);
          return result;
        }
        childPending++;
        childTail = childTail.then(() => childCapped(childRunDeferred(work))).catch(childReportError).then(childSettle);
        return childTail;
      };
      // Record the offending source when a child script throws. These run in an
      // ad iframe's realm, so the console stack points at the prelude's eval and
      // nothing identifies WHICH creative failed — without this, diagnosing one
      // means guessing.
      const childRecordFailure = (err, source) => {
        try {
          const diag = root.__zp_diagnostics;
          if (diag && diag.length < 200) diag.push({
            t: 'child-script-error',
            msg: String(err && err.message || err).slice(0, 160),
            src: String(source || '').slice(0, 400)
          });
        } catch {}
      };
      const childExecInline = source => childEnqueue(() => {
        try { return childExecGlobal(childRewrite(source, 'classic')); }
        catch (err) { childRecordFailure(err, source); throw err; }
      });
      const childExecModule = source => childEnqueue(() => (new childFunction(childRewrite(source, 'module'))).call(w));
      // `_REWRITTEN` variants: code already rewritten by zp-htmltx — execute
      // directly in the child realm without going through the page rewriter.
      const childExecRewritten = code => childEnqueue(() => childExecGlobal(String(code || '')));
      const childRunRewrittenModule = code => {
        const blob = new (w.Blob || Blob)([String(code || '')], { type: 'text/javascript' });
        const url = (w.URL && w.URL.createObjectURL || URL.createObjectURL).call(w.URL || URL, blob);
        const p = w.eval ? w.eval('import(' + JSON.stringify(url) + ')') : import(url);
        Promise.resolve(p).finally(() => { try { (w.URL && w.URL.revokeObjectURL || URL.revokeObjectURL).call(w.URL || URL, url); } catch {} });
        return p;
      };
      const childExecRewrittenModule = code => childEnqueue(() => childRunRewrittenModule(code));
      // External script loader for iframe. SW only controls top-level (parent)
      // — `document.write` 가 iframe 의 about:blank document 를 reset 한 뒤에는
      // 자식이 SW client 자격을 잃어 `<script src=ext>` fetch 가 SW 우회 직행 → Go
      // 서버 403 POLICY_BLOCKED → 광고 미렌더. parent realm 의 native fetch 로
      // SW-routed 경로 (`/zp/api/script?u=...`) 를 fetch + child realm 에서 실행
      // 하여 SafeFrame loader 가 정상 실행되게 한다.
      // External script written into the child document.
      //
      // DEAD END (2026-07-30) — do NOT "fix" the ordering with synchronous XHR.
      // It looks like the obvious answer (the only way an inline script can
      // wait), but **the Service Worker does not intercept synchronous
      // XMLHttpRequest**: measured on one controlled page, the same URL returns
      // 403 from the Go server for sync XHR and 503 from the SW for `fetch`.
      // Sync XHR bypasses the whole transport, 403s, and silently degrades back
      // to the async path — one wasted request per script and no ordering
      // gained. The Go server cannot serve `/zp/api/script` either; the proxied
      // fetch lives in the browser kernel by design. Ordering is solved by
      // `childEnqueue` above instead: fetch in parallel, execute in order.
      const childLoadExternal = (url, kind) => {
        const dtype = String(kind || 'classic');
        // Start downloading NOW so N scripts in one written chunk fetch in
        // parallel; the queue only serializes their execution.
        const fetching = Native.fetch(scriptProxyPath(String(url || ''), dtype)).then(r => r.text());
        // `childRunDeferred` here as well as in `childEnqueue`: this body runs a
        // microtask after the fetch even on the empty-queue fast path, so the
        // `document.write` guard has to see the deferred flag either way.
        return childEnqueue(() => fetching.then(code => childRunDeferred(() => {
          if (dtype === 'module') return childRunRewrittenModule(code);
          childExecGlobal(code);
        })));
      };
      if (!define(w, '__ZP_EXEC_INLINE_SCRIPT', childExecInline)) throw normalizedError('SecurityError');
      if (!define(w, '__ZP_EXEC_INLINE_MODULE', childExecModule)) throw normalizedError('SecurityError');
      if (!define(w, '__ZP_EXEC_INLINE_REWRITTEN', childExecRewritten)) throw normalizedError('SecurityError');
      if (!define(w, '__ZP_EXEC_INLINE_REWRITTEN_MODULE', childExecRewrittenModule)) throw normalizedError('SecurityError');
      if (!define(w, '__ZP_LOAD_EXTERNAL_SCRIPT', childLoadExternal)) throw normalizedError('SecurityError');
    } else {
      throw normalizedError('SecurityError');
    }
    if (root.__ZP_EXEC_EVENT && !define(w, '__ZP_EXEC_EVENT', root.__ZP_EXEC_EVENT)) throw normalizedError('SecurityError');
    if (root.__ZP_SET_BASE && !define(w, '__ZP_SET_BASE', root.__ZP_SET_BASE)) throw normalizedError('SecurityError');
    if (childFunction && childFunction.prototype) try {
      // Constructor-chain compilation must use the same child-owned gate.
      const childConstructorOverrides = new WeakMap();
      defineMasked(childFunction.prototype, 'constructor', {
        get() { return childConstructorOverrides.get(this) || childFunctionFacade; },
        set(value) { try { childConstructorOverrides.set(this, value); } catch {} },
        enumerable: false, configurable: false
      });
    } catch {}
    if (root.fetch && !define(w, 'fetch', root.fetch.bind(root))) throw normalizedError('SecurityError');
    installNavigatorIdentity(w);
    installGetterMasking(w);
    installStorageFacades(w);
    installPostMessageHooks(w);
    if (root.XMLHttpRequest && !define(w, 'XMLHttpRequest', root.XMLHttpRequest)) throw normalizedError('SecurityError');
    if (root.EventSource && !define(w, 'EventSource', root.EventSource)) throw normalizedError('SecurityError');
    if (root.WebSocket && !define(w, 'WebSocket', root.WebSocket)) throw normalizedError('SecurityError');
    if (root.WebSocketStream && !define(w, 'WebSocketStream', root.WebSocketStream)) throw normalizedError('SecurityError');
    if (w.navigator && navigator.sendBeacon) define(w.navigator, 'sendBeacon', navigator.sendBeacon.bind(navigator));
    installDOMHooks(w);
    installStealthMembrane(w);
    installTargetServiceWorkerBlocker(w);
    installIframeHooks(w);
    installBlockers(w, true);
    installCanvasAntiFingerprinting(w);
    installAudioAntiFingerprinting(w);
    installNavigationBackstop(w, w.document && w.document.documentElement);
    try { Object.defineProperty(w, networkContainmentMarker, { value: true, enumerable: false, configurable: false }); } catch {}
  }

  function installBlockers(w, strict = false) {
    // D4 / D5: WebTransport, RTCPeerConnection, etc. expose a *virtual*
    // constructor surface so target code's feature detection succeeds and
    // its fallback flow (e.g., await wt.ready.catch(() => fallbackToWS()))
    // works cleanly. The gateway transport itself is still pending —
    // .ready rejects with a ZeroProxy-tagged error carrying the friendly
    // reason. This is strictly better than a hard ctor-throw because most
    // production sites detect WebTransport availability via the Promise.
    const gatewayMeta = {
      // D4: `WebTransport` slot prefers the real native-pass-through
      // virtual class when `boot.wtGateway` is set; otherwise the ctor
      // factory returns the legacy stub automatically.
      // D5: same shape for `RTCPeerConnection` /
      // `webkitRTCPeerConnection` — pass-through to a native PC with
      // signaling routed via `boot.rtcGateway` when set, else legacy
      // stub.
      'WebTransport': { code: 'WT_UNSUPPORTED', kind: 'WebTransport', ctor: makeWebTransportConstructor },
      'RTCPeerConnection': { code: 'RTC_GATEWAY_UNAVAILABLE', kind: 'WebRTC', ctor: () => makeRTCPeerConnectionConstructor('RTCPeerConnection') },
      'webkitRTCPeerConnection': { code: 'RTC_GATEWAY_UNAVAILABLE', kind: 'WebRTC', ctor: () => makeRTCPeerConnectionConstructor('webkitRTCPeerConnection') },
      // RTCDataChannel is not user-constructible; it's returned by
      // createDataChannel on the (now-virtual) PC. Keep the legacy stub
      // for direct construction attempts.
      'RTCDataChannel': { code: 'RTC_GATEWAY_UNAVAILABLE', kind: 'WebRTC' },
    };
    for (const name of Object.keys(gatewayMeta)) {
      const meta = gatewayMeta[name];
      const blockCtor = typeof meta.ctor === 'function' ? meta.ctor() : makeVirtualGateway(name, meta);
      try { Object.defineProperty(blockCtor, 'name', { value: name, configurable: true }); } catch {}
      maskNativeFunction(blockCtor, name);
      const ok = define(w, name, blockCtor);
      if (strict && name in w && !ok) throw normalizedError('SecurityError');
    }
    // B4 / EventSource: intentionally NOT wrapped. The Service Worker
    // intercepts all controlled-origin fetches including SSE, so the native
    // EventSource implementation is safe. Wrapping it would change the
    // observable interface unnecessarily. See compat-pipeline.test.js.
    // D6: physical hardware + permission-gated APIs pass through to native.
    // Browser user-consent prompt is the real boundary; they do not leak
    // target/proxy origin. Sensor noise injection / fingerprinting noise is
    // a future phase. The block list below is intentionally empty.
    const nav = w.navigator;
    if (nav) {
      for (const name of /* intentionally empty — see D6 in PHASE2 plan */ []) {
        const deny = function(){ throw normalizedError('NotSupportedError'); };
        toStringMap.set(deny, nativeAccessorSource('get', name));
        try { defineMasked(nav, name, { get: deny, configurable: false }); } catch {}
      }
      // D6: getUserMedia / getDisplayMedia / enumerateDevices pass through to
      // native. Browser permission prompt is the consent boundary, and these
      // do not leak target/proxy origin to external network.
    }
    if (w.speechSynthesis) {
      const voices = Object.freeze([
        Object.freeze({ name: 'Google US English', lang: 'en-US', default: true, localService: false, voiceURI: 'Google US English' }),
        Object.freeze({ name: 'Microsoft David - English (United States)', lang: 'en-US', default: false, localService: true, voiceURI: 'Microsoft David' })
      ]);
      const getVoices = function() { return voices.slice(); };
      if (!define(w.speechSynthesis, 'getVoices', getVoices)) {
        try { define(Object.getPrototypeOf(w.speechSynthesis), 'getVoices', getVoices); } catch {}
      }
    }
  }