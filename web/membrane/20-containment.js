  // True if `w` already booted its own membrane prelude (`__zp_get` belongs to
  // another realm). Containment applies only to documents without their own
  // membrane (`about:blank`, `srcdoc`, `document.write`, `text/plain`);
  // overwriting a booted realm's helpers would replace its virtual location and
  // storage with the parent's.
  function ownsMembrane(w) {
    try { const g = w.__zp_get; return typeof g === 'function' && g !== root.__zp_get; } catch { return false; }
  }
  // True if `w` is a proxied HTML document still loading its own injected
  // prelude. Containing the window before its prelude runs would bind its
  // fetch/XHR and non-configurable accessors to the parent realm. Once loading
  // completes (`readyState === 'complete'`), any document that failed to boot a
  // prelude is contained as a fallback.
  function bootingProxiedDocument(w) {
    try {
      const doc = w.document;
      if (!doc || doc.readyState === 'complete') return false;
      const u = new Native.URL(String(Native.documentURLDesc.get.call(doc)));
      // The SW serves every transformed document as `text/html`.
      return u.origin === proxyOrigin && ZP.isSharePath(u.pathname) && String(doc.contentType || '') === 'text/html';
    } catch { return false; }
  }
  function installNetworkContainment(w) {
    const prevFP = realmInstallFP;
    try {
      realmInstallFP = w && w !== root && w.Function ? w.Function.prototype : null;
      return installNetworkContainmentBody(w);
    } finally { realmInstallFP = prevFP; }
  }
  function installNetworkContainmentBody(w) {
    if (!w) return;
    try { if (w[networkContainmentMarker]) return; } catch {}
    if (w !== root && (ownsMembrane(w) || bootingProxiedDocument(w))) return;
    restoreEarlyNatives(w);
    installToStringMasking(w);
    // Expose the parent's `__zp_*` runtime helpers on `about:blank` child realms
    // so SW-rewritten scripts loaded into unbooted iframes can execute against
    // the membrane while falling through to the child's native globals.
    if (root.__zp_get && !define(w, '__zp_get', root.__zp_get)) throw normalizedError('SecurityError');
    if (root.__zp_fast && !define(w, '__zp_fast', root.__zp_fast)) throw normalizedError('SecurityError');
    if (root.__zp_fastset && !define(w, '__zp_fastset', root.__zp_fastset)) throw normalizedError('SecurityError');
    // Unqualified calls in the child receive the child's own global receiver.
    if (root.__zp_get && !define(w, '__zp_this', t => t === w ? root.__zp_get(w, 'window') : root.__zp_this(t))) throw normalizedError('SecurityError');
    if (root.__zp_origin && !define(w, '__zp_origin', root.__zp_origin)) throw normalizedError('SecurityError');
    if (root.__zp_url && !define(w, '__zp_url', root.__zp_url)) throw normalizedError('SecurityError');
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
    if (root.__zp_ochain && !define(w, '__zp_ochain', root.__zp_ochain)) throw normalizedError('SecurityError');
    if (root.__zp_ocallv && !define(w, '__zp_ocallv', root.__zp_ocallv)) throw normalizedError('SecurityError');
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
    // Capture the child realm's native `Function` and `eval` before installing
    // rewrite gates so inline scripts execute in the child's global scope
    // rather than leaking declarations into the parent window.
    const childFunction = w.Function;
    let childFunctionFacade;
    if (childFunction) {
      const childEval = w.eval;
      // The child frame has its own trustedTypes (and its own default policy); its document inherits the parent's CSP.
      let childTT; try { childTT = w.trustedTypes; } catch { childTT = undefined; }
      // Per-realm lexical declaration table (`let`/`const`/`class`) isolated
      // from the parent realm so top-level lexical bindings survive across
      // indirect-eval scripts within the child without colliding with the parent.
      const childLexShared = newMap();
      let childLex = childLexShared;
      const childLexEntry = prop => (typeof prop === 'string' ? childLex.get(prop) : undefined);
      const childLexRead = (e, prop) => {
        if (!e.get) throw new ReferenceError(`Cannot access '${prop}' before initialization`);
        return e.get();
      };
      if (!define(w, '__zp_lex_decl', (lexMap, varNames) => {
        for (const n of varNames) if (childLex.has(n)) return n;
        for (const n of Object.keys(lexMap)) {
          if (childLex.has(n) || varNames.includes(n)) return n;
          const d = Reflect.getOwnPropertyDescriptor(w, n);
          if (d && !d.configurable) return n;
        }
        for (const n of Object.keys(lexMap)) childLex.set(n, { kind: lexMap[n], get: null, set: null });
        return undefined;
      })) throw normalizedError('SecurityError');
      if (!define(w, '__zp_lex_bind', (name, get, set) => {
        const e = childLex.get(name);
        if (e) { e.get = get; e.set = typeof set === 'function' ? set : null; }
      })) throw normalizedError('SecurityError');
      if (!define(w, '__zp_lex_scope', new Proxy({}, {
        has(_t, prop) { return childLexEntry(prop) !== undefined; },
        get(_t, prop) { const e = childLexEntry(prop); return e ? childLexRead(e, prop) : undefined; },
        set(_t, prop, value) {
          const e = childLexEntry(prop);
          if (!e) return false;
          if (!e.set) throw new TypeError('Assignment to constant variable.');
          e.set(value);
          return true;
        },
        deleteProperty() { return false; },
      }))) throw normalizedError('SecurityError');
      const childStrictRE = /^(\s|\/\*[^]*?\*\/|\/\/[^\n]*)*('use strict'|"use strict")/;
      const childExecGlobal = code => {
        if (!childEval) return (new childFunction(code)).call(w);
        return childEval(ttScript(childStrictRE.test(code) ? code : 'with(__zp_lex_scope){' + ZP_WITH_PROLOGUE + code + '\n}'));
      };
      const childRewrite = (source, kind) => {
        const hooks = pageRewriteHooks;
        if (!hooks) throw normalizedError('InvalidStateError');
        return hooks.rewrite(hooks.decodeEntities(source), kind);
      };
      // Guard `eval` and `Function` in the child realm so dynamic compilation
      // stays within the child's global scope.
      const childEvalText = text => childExecGlobal(pageRewriteHooks.rewrite(text, 'eval'));
      const childDynamicEval = function dynamicEval(value) {
        if (new.target) throw new TypeError('eval is not a constructor');
        const text = ttEvalSource(value, 'eval', childTT);
        return text === null ? value : childEvalText(text);
      };
      childFunctionFacade = function Function(...args) {
        // Validate and convert parameters via the native constructor without
        // executing the unrewritten body.
        if (ttEnforced()) {
          const parts = new Array(args.length);
          for (let i = 0; i < args.length; i++) parts[i] = String(args[i]);
          const wanted = '(function anonymous(' + parts.slice(0, -1).join(',') + '\n) {\n' + (parts.length ? parts[parts.length - 1] : '') + '\n})';
          const made = ttCompliant('Script', 'Function', wanted, '', childTT);
          if (made !== wanted) return childEvalText(made);
        }
        const original = ttFunction(args, childEval, childFunction);
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
      // Direct `eval(x)` support for the child realm. Compiles sloppy and strict
      // runners lazily using the child's `Function` constructor so `eval` inside
      // `with(__zp_env)` resolves caller locals and shared child lexical bindings.
      let childRunSloppy;
      let childRunStrict;
      const childRunners = () => {
        if (childRunSloppy === undefined) {
          try {
            childRunSloppy = ttFunction(['eval', '__zp_env', '__zp_src', 'return eval(__zp_src)'], childEval, childFunction);
            childRunStrict = ttFunction(['__zp_self', '__zp_env', '__zp_src',
              'with(__zp_env){const eval=__zp_self;' + ZP_WITH_PROLOGUE + 'return (()=>{"use strict";return eval(__zp_src)})()}'], childEval, childFunction);
          } catch { childRunSloppy = null; childRunStrict = null; }
        }
        return childRunSloppy ? { sloppy: childRunSloppy, strict: childRunStrict } : null;
      };
      const childEvalEnv = d => {
        const own = k => typeof k === 'string' && Object.prototype.hasOwnProperty.call(d, k);
        const shared = k => typeof k === 'string' && childLexShared.has(k);
        return new Proxy(d, {
          has(_t, k) { return own(k) || shared(k); },
          get(_t, k) {
            if (own(k)) return d[k];
            const e = shared(k) ? childLexShared.get(k) : undefined;
            return e ? childLexRead(e, k) : undefined;
          },
          set(_t, k, v) {
            if (own(k)) { d[k] = v; return true; }
            const e = shared(k) ? childLexShared.get(k) : undefined;
            if (!e) return false;
            if (!e.set) throw new TypeError('Assignment to constant variable.');
            e.set(v);
            return true;
          },
        });
      };
      const childDirectEval = function (callee, args, desc, callerStrict, globalSite) {
        if (new.target) throw new TypeError('eval is not a constructor');
        const list = Array.isArray(args) ? args : [];
        if (callee !== childDynamicEval && callee !== root.eval) return Reflect.apply(callee, undefined, list);
        const arg = list[0];
        const src = ttEvalSource(arg, 'eval', childTT);
        if (src === null) return arg;
        const directive = childStrictRE.test(src);
        if (!childEval || (globalSite === 1 && !callerStrict && !directive)) return childEvalText(src);
        const runners = childRunners();
        if (!runners) return childEvalText(src);
        const rewritten = pageRewriteHooks.rewrite(src, 'classic-local');
        let d = {};
        if (desc && typeof desc === 'object') {
          // Make caller binding accessors non-configurable so `delete x` does not remove them.
          const dd = Object.getOwnPropertyDescriptors(desc);
          for (const k of Object.keys(dd)) { dd[k].configurable = false; dd[k].enumerable = true; }
          d = Object.defineProperties({}, dd);
        }
        const env = childEvalEnv(d);
        const prevLex = childLex;
        childLex = newMap();
        try {
          const that = this;
          if (callerStrict || directive) return runners.strict.call(that, childEval, env, ttScript(rewritten));
          return runners.sloppy.call(that, childEval, env, ttScript('with(__zp_env){' + ZP_WITH_PROLOGUE + rewritten + '\n}'));
        } finally {
          childLex = prevLex;
        }
      };
      if (!define(w, '__zp_eval', childDirectEval)) throw normalizedError('SecurityError');
      // Ordered script queue for the child realm. `<script src>` written via
      // `document.write` is natively parser-blocking; because external scripts
      // are fetched asynchronously through `/zp/api/script`, `childEnqueue`
      // serializes execution in document order while letting downloads start in
      // parallel. When the queue is empty, inline scripts run synchronously.
      let childTail = null;
      let childPending = 0;
      const childReportError = err => {
        try { (w.setTimeout || setTimeout)(() => { throw err; }, 0); } catch {}
      };
      const childSettle = () => { if (--childPending === 0) childTail = null; };
      // Per-item stall timeout so a wedged external script fetch does not block
      // subsequent scripts in the child realm indefinitely. Timed from when the
      // item begins waiting rather than enqueue time.
      const CHILD_STALL_MS = 30000;
      const childCapped = pending => new Promise(resolve => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(); } };
        Promise.resolve(pending).then(finish, err => { childReportError(err); finish(); });
        try { (w.setTimeout || setTimeout)(() => {
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
          childTail = childCapped(result).then(childSettle);
          return result;
        }
        childPending++;
        childTail = childTail.then(() => childCapped(childRunDeferred(work))).catch(childReportError).then(childSettle);
        return childTail;
      };
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
      const childExecRewritten = code => childEnqueue(() => childExecGlobal(String(code || '')));
      const childRunRewrittenModule = code => {
        const blob = new (w.Blob || Blob)([String(code || '')], { type: 'text/javascript' });
        const url = (w.URL && w.URL.createObjectURL || URL.createObjectURL).call(w.URL || URL, blob);
        const p = w.eval ? w.eval(ttScript('import(' + JSON.stringify(url) + ')')) : import(url);
        Promise.resolve(p).finally(() => { try { (w.URL && w.URL.revokeObjectURL || URL.revokeObjectURL).call(w.URL || URL, url); } catch {} });
        return p;
      };
      const childExecRewrittenModule = code => childEnqueue(() => childRunRewrittenModule(code));
      // Fetch external scripts via the parent realm's SW-controlled `Native.fetch`
      // (`/zp/api/script`) and serialize execution through `childEnqueue`.
      const childLoadExternal = (url, kind, cors) => {
        const dtype = String(kind || 'classic');
        const asked = cors === 'anonymous' || cors === 'use-credentials' ? cors : '';
        const path = scriptProxyPath(String(url || ''), dtype);
        let fetching = (asked ? Native.fetch(path, { headers: { 'X-ZP-Element-CORS': asked } }) : Native.fetch(path)).then(r => r.text());
        if (asked) fetching = fetching.then(code => code, () => '');
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
      // Route `Function.prototype.constructor` in the child realm to `childFunctionFacade`.
      const childConstructorOverrides = newWeakMap();
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
    if (root.XMLHttpRequest && !define(w, 'XMLHttpRequest', realmCopyOf(w, root.XMLHttpRequest))) throw normalizedError('SecurityError');
    if (root.EventSource && !define(w, 'EventSource', realmCopyOf(w, root.EventSource))) throw normalizedError('SecurityError');
    if (root.WebSocket && !define(w, 'WebSocket', realmCopyOf(w, root.WebSocket))) throw normalizedError('SecurityError');
    if (root.WebSocketStream && !define(w, 'WebSocketStream', realmCopyOf(w, root.WebSocketStream))) throw normalizedError('SecurityError');
    if (w.navigator && navigator.sendBeacon) define(w.navigator, 'sendBeacon', navigator.sendBeacon.bind(navigator));
    installDOMHooks(w);
    hideInternalNamesInRealm(w);
    installStealthMembrane(w);
    installTargetServiceWorkerBlocker(w);
    installIframeHooks(w);
    installBlockers(w, true);
    installNavigationBackstop(w, w.document && w.document.documentElement);
    try { Object.defineProperty(w, networkContainmentMarker, { value: true, enumerable: false, configurable: false }); } catch {}
  }

  // Create a per-realm constructor wrapper sharing `rootCtor.prototype` while
  // inheriting from the child realm's interface prototype or `Function.prototype`,
  // so `frame.XMLHttpRequest instanceof frame.Function` is true and
  // `frame.XMLHttpRequest !== XMLHttpRequest`.
  function realmCopyOf(w, rootCtor) {
    try {
      const name = rootCtor.name;
      const copy = function () {
        if (!new.target) throw new TypeError("Failed to construct '" + name + "': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
        return Reflect.construct(rootCtor, arguments, new.target);
      };
      Object.defineProperty(copy, 'prototype', { value: rootCtor.prototype, writable: false, enumerable: false, configurable: false });
      for (const key of Reflect.ownKeys(rootCtor)) {
        if (key === 'prototype' || key === 'length' || key === 'name') continue;
        const d = Object.getOwnPropertyDescriptor(rootCtor, key);
        try { Object.defineProperty(copy, key, d); } catch {}
      }
      lengthLike(copy, rootCtor);
      nameLike(copy, name);
      maskNativeFunction(copy, name);
      let native = null;
      try { const d = Object.getOwnPropertyDescriptor(w, name); native = d && typeof d.value === 'function' ? d.value : null; } catch {}
      const fp = (native && Object.getPrototypeOf(native)) || (w.Function && w.Function.prototype);
      if (fp) Object.setPrototypeOf(copy, fp);
      return copy;
    } catch { return rootCtor; }
  }
  // Filter `__zp_*` properties out of `Object.getOwnPropertyNames`,
  // `Reflect.ownKeys`, and `Object.getOwnPropertyDescriptors` in a contained
  // child realm when inspecting global window objects.
  function hideInternalNamesInRealm(w) {
    const isHidden = k => typeof k === 'string' && ZP_HIDDEN_RE.test(k);
    const isGlobal = t => { try { return t === w || (!!t && typeof t === 'object' && t.window === t); } catch { return false; } };
    const patch = (owner, name, filter) => {
      try {
        if (!owner || typeof owner[name] !== 'function') return;
        const orig = owner[name];
        const patched = ({ [name](target) { const out = Reflect.apply(orig, this, arguments); return isGlobal(target) ? filter(out) : out; } })[name];
        lengthLike(patched, orig);
        maskNativeFunction(patched, name);
        try { Object.setPrototypeOf(patched, Object.getPrototypeOf(orig)); } catch {}
        Object.defineProperty(owner, name, { value: patched, writable: true, enumerable: false, configurable: true });
      } catch {}
    };
    const names = out => (Array.isArray(out) ? out.filter(k => !isHidden(k)) : out);
    const descriptors = out => { if (out && typeof out === 'object') for (const k of Reflect.ownKeys(out)) if (isHidden(k)) delete out[k]; return out; };
    patch(w.Object, 'getOwnPropertyNames', names);
    patch(w.Reflect, 'ownKeys', names);
    patch(w.Object, 'getOwnPropertyDescriptors', descriptors);
  }

  function installBlockers(w, strict = false) {
    // Install virtual gateway constructors for WebTransport and WebRTC so
    // feature detection succeeds and fallback flows run cleanly when no gateway
    // is configured.
    const gatewayMeta = {
      'WebTransport': { code: 'WT_UNSUPPORTED', kind: 'WebTransport', ctor: makeWebTransportConstructor },
      'RTCPeerConnection': { code: 'RTC_GATEWAY_UNAVAILABLE', kind: 'WebRTC', ctor: () => makeRTCPeerConnectionConstructor(w, 'RTCPeerConnection') },
      'RTCDataChannel': { code: 'RTC_GATEWAY_UNAVAILABLE', kind: 'WebRTC' },
    };
    const hadWebkitRTC = 'webkitRTCPeerConnection' in w;
    for (const name of Object.keys(gatewayMeta)) {
      const meta = gatewayMeta[name];
      const blockCtor = typeof meta.ctor === 'function' ? meta.ctor() : makeVirtualGateway(name, meta);
      try { Object.defineProperty(blockCtor, 'name', { value: name, configurable: true }); } catch {}
      maskNativeFunction(blockCtor, name);
      const ok = define(w, name, blockCtor);
      if (strict && name in w && !ok) throw normalizedError('SecurityError');
    }
    // Alias `webkitRTCPeerConnection` to the same function without renaming `RTCPeerConnection.name`.
    if (hadWebkitRTC) {
      let aliased = false;
      try { Object.defineProperty(w, 'webkitRTCPeerConnection', { value: w.RTCPeerConnection, enumerable: nativeEnumerability(w, 'webkitRTCPeerConnection'), configurable: false, writable: true }); aliased = true; } catch {}
      if (!aliased && strict) throw normalizedError('SecurityError');
    }
    // Permission-gated hardware and media APIs pass through to native because
    // the browser user-consent prompt serves as the boundary and does not leak
    // the proxy origin.
    const nav = w.navigator;
    if (nav) {
      for (const name of /* intentionally empty */ []) {
        const deny = function(){ throw normalizedError('NotSupportedError'); };
        maskAccessorFn(deny, 'get', name);
        try { defineMasked(nav, name, { get: deny, configurable: false }); } catch {}
      }
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