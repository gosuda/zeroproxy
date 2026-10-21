  function installPhase2Membrane() {
    // Native Window methods require the real `window` receiver to pass WebIDL
    // brand checks; calling them on the `scope` proxy throws `Illegal invocation`.
    // Bind only prototype-less native functions (`structuredClone`, `matchMedia`,
    // `getSelection`, etc.) to `target`, leaving constructors (`URL`, `Promise`)
    // and page-defined functions unbound.
    const NATIVE_CODE_RE = sealRegExp(/\{\s*\[native code\]\s*\}/);
    const STRICT_PROLOGUE_RE = sealRegExp(/^\s*['"]use strict['"]/);
    function needsWindowReceiver(fn) {
      if (typeof fn !== 'function') return false;
      try { if (fn.prototype) return false; } catch { return false; }
      try { return NATIVE_CODE_RE.test(nativeApply(nativeFnToString, fn, [])); } catch { return false; }
    }
    function boundWindowMethod(target, prop) {
      const fn = target[prop];
      if (typeof fn !== 'function') return fn;
      if (windowMethodBindings.has(prop)) return windowMethodBindings.get(prop);
      const bound = fn.bind(target);
      maskNativeFunction(bound, prop);
      // Copy own static properties (such as `Proxy.revocable`) that `Function.prototype.bind` omits.
      for (const key of nativeOwnKeys(fn)) {
        if (key === 'length' || key === 'name' || key === 'prototype') continue;
        try { nativeReflectDefineProperty(bound, key, nativeReflectGOPD(fn, key)); } catch {}
      }
      windowMethodBindings.set(prop, bound);
      return bound;
    }

    const NativeAsyncFunction = (async function(){}).constructor;
    const NativeGeneratorFunction = (function*(){}).constructor;
    const NativeAsyncGeneratorFunction = (async function*(){}).constructor;
    // Declare before functions that reference them so initialization order cannot hit a TDZ.
    const NativeSyntaxError = root.SyntaxError;
    const parseErrors = newWeakSet();
    function stringArgs(args) {
      const out = new Array(args.length);
      for (let i = 0; i < args.length; i++) out[i] = String(args[i]);
      return out;
    }
    function functionPrefix(kind) {
      return kind === 'async' ? 'async function' : kind === 'generator' ? 'function*' : kind === 'asyncGenerator' ? 'async function*' : 'function';
    }
    function dynamicSource(kind, params, body) {
      return functionPrefix(kind) + ' anonymous(' + params.join(',') + '\n) {\n' + body + '\n}';
    }
    // `withScope`'s `has` trap returns `true` for every identifier so unresolved
    // names do not escape to the physical global object, which would otherwise
    // shadow parameters and `arguments` declared on the outer function. Declare
    // parameters on an inner function nested inside `with(__zp_scope)` so
    // parameters, `arguments`, and `var` bindings resolve before the `with` object,
    // and forward `new.target` via `Reflect.construct`.
    function compileNested(params, body, kind) {
      try { zpTrace('compile', String(body || '').slice(0, 100)); } catch {}
      const inner = functionPrefix(kind) + ' __zp_dyn__(' + params.join(',') + '\n) {\n'
        + rewriteDynamicFunctionBody(params, body, kind) + '\n}';
      // Define the inner function inside `with(__zp_scope)` so free identifiers
      // route through the scope proxy, and invoke `.apply` outside `with` so
      // `__zp_args` is not shadowed by the `has` trap. Pass `this` via `__zp_self`
      // so a sloppy outer boundary does not coerce it to the raw global object.
      const src = 'var __zp_inner__ = (function(){\n' + 'with(__zp_scope){' + ZP_WITH_PROLOGUE + '\nreturn (' + inner + ');\n}\n})();\n'
        + 'if (new.target) return Reflect.construct(__zp_inner__, __zp_args, new.target);\n'
        + 'return __zp_inner__.apply(__zp_self, __zp_args);';
      // Use `__zp_self` rather than a rewriter helper name because in a child frame sharing a reused
      // window, `Native.FunctionCtor` may already be a parent facade that rewrites the wrapper.
      return ttFunction(['__zp_scope', '__zp_args', '__zp_self', src]);
    }
    function nestedCall(compiled, thisArg, callArgs, newTarget, sloppy) {
      // Sloppy functions coerce nullish `this` (or raw `root` from unwrapped callers)
      // to the global object; substitute the `scope` facade so `this.location` virtualizes.
      const t = sloppy && (thisArg == null || thisArg === root) ? scope : thisArg;
      const argv = [withScope, callArgs, t];
      return newTarget ? Reflect.construct(compiled, argv, newTarget) : Reflect.apply(compiled, scope, argv);
    }
    function compileDynamic(ctor, args, kind) {
      const parts = stringArgs(args);
      const body = parts.length ? parts[parts.length - 1] : '';
      const params = new Array(parts.length > 0 ? parts.length - 1 : 0);
      for (let i = 0; i < params.length; i++) params[i] = parts[i];
      // The `default` policy sees the source the engine would compile; one that changes it is a refusal (thrown by `ttCompliant`).
      if (ttEnforced()) ttCompliant('Script', 'Function', '(' + dynamicSource(kind, params, body) + ')');
      // Match the outer `fn` wrapper's function kind (`async`, `generator`, `asyncGenerator`)
      // to the inner function to preserve prototype identity.
      const compiled = compileNested(params, body, kind);
      // Determine from the directive prologue whether nullish `this` should coerce
      // to `scope` (sloppy) or remain untouched (strict).
      const sloppy = !/^\s*['"]use strict['"]/.test(body);
      let fn;
      // Declare the outer wrapper in strict mode so `fn.call(null)` does not coerce
      // `this` to the physical `globalThis` at the wrapper boundary.
      if (kind === 'async') {
        fn = async function anonymous() { 'use strict'; return nestedCall(compiled, this, arguments, undefined, sloppy); };
      } else if (kind === 'generator') {
        fn = function* anonymous() { 'use strict'; return yield* nestedCall(compiled, this, arguments, undefined, sloppy); };
      } else if (kind === 'asyncGenerator') {
        fn = async function* anonymous() { 'use strict'; return yield* nestedCall(compiled, this, arguments, undefined, sloppy); };
      } else {
        fn = function anonymous() { 'use strict'; return nestedCall(compiled, this, arguments, new.target, sloppy); };
      }
      toStringMap.set(fn, dynamicSource(kind, params, body));
      return fn;
    }
    // Extract source text for `eval`: either a string or a TrustedScript instance,
    // which Chrome evaluates even when Trusted Types are not enforced by CSP.
    function evalSource(x, sink) { return ttEvalSource(x, sink); }
    function isEvalExpressionCandidate(text) {
      return !/^(?:function|class|var|let|const|if|for|while|do|switch|try|throw|return|break|continue|with|import|export|debugger)\b/.test(text.trimStart());
    }
    const evalExpressionCache = newMap();
    function dynamicEval(source) {
      // Native `eval` is not a constructor (`new eval()` throws TypeError).
      if (new.target) throw new TypeError('eval is not a constructor');
      if (arguments.length === 0) return undefined;
      // Per PerformEval step 1, non-string arguments (other than TrustedScript) are returned as-is without evaluation.
      const text = evalSource(source);
      if (text === null) return source;
      let expr = null;
      if (isEvalExpressionCandidate(text)) {
        // Run expression candidates through the rewriter so computed member accesses (`x['location']`) are mediated.
        try {
          const rewritten = callPageRewriter(text, 'classic');
          // Cache compiled expression wrappers per rewritten source string.
          const cacheable = rewritten.length <= 65536;
          expr = cacheable ? evalExpressionCache.get(rewritten) : undefined;
          if (expr === undefined) {
            expr = ttFunction(['__zp_scope', 'with(__zp_scope){' + ZP_WITH_PROLOGUE + 'return (' + rewritten + '\n);}']);
            if (cacheable) {
              evalExpressionCache.set(rewritten, expr);
              if (evalExpressionCache.size > 256) evalExpressionCache.delete(evalExpressionCache.keys().next().value);
            }
          }
        } catch (e) {
          if (e && e.name === 'NotSupportedError') throw e;
        }
      }
      // Evaluate expression candidates with `this` bound to the `scope` facade.
      if (expr) return Reflect.apply(expr, scope, [withScope]);
      // Statement-form indirect eval must bind top-level `var` and `function` declarations
      // on the global object, so rewrite and execute via `execGlobalScript`.
      const globalCode = callPageRewriter(text, 'classic');
      // Isolate `let`, `const`, and `class` declarations inside `eval` to a disposable lexical Map.
      const prevLexEnv = __zp_lex_env;
      __zp_lex_env = newMap();
      try { return execGlobalScript(globalCode); }
      finally { __zp_lex_env = prevLexEnv; }
    }
    const dynamicFunction = function Function(...args) { return compileDynamic(Native.FunctionCtor, args, 'function'); };
    const dynamicAsyncFunction = function AsyncFunction(...args) { return compileDynamic(NativeAsyncFunction, args, 'async'); };
    const dynamicGeneratorFunction = function GeneratorFunction(...args) { return compileDynamic(NativeGeneratorFunction, args, 'generator'); };
    const dynamicAsyncGeneratorFunction = function AsyncGeneratorFunction(...args) { return compileDynamic(NativeAsyncGeneratorFunction, args, 'asyncGenerator'); };
    function setDynamicConstructorIdentity(fn, name, proto) {
      try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch {}
      try { Object.defineProperty(fn, 'length', { value: 1, configurable: true }); } catch {}
      if (proto) try { Object.defineProperty(fn, 'prototype', { value: proto, enumerable: false, configurable: false, writable: false }); } catch {}
      maskNativeFunction(fn, name);
    }
    setDynamicConstructorIdentity(dynamicFunction, 'Function', Native.FunctionCtor && Native.FunctionCtor.prototype);
    setDynamicConstructorIdentity(dynamicAsyncFunction, 'AsyncFunction', NativeAsyncFunction && NativeAsyncFunction.prototype);
    setDynamicConstructorIdentity(dynamicGeneratorFunction, 'GeneratorFunction', NativeGeneratorFunction && NativeGeneratorFunction.prototype);
    setDynamicConstructorIdentity(dynamicAsyncGeneratorFunction, 'AsyncGeneratorFunction', NativeAsyncGeneratorFunction && NativeAsyncGeneratorFunction.prototype);
    try { Object.defineProperty(dynamicEval, 'name', { value: 'eval', configurable: true }); } catch {}
    try { Object.defineProperty(dynamicEval, 'length', { value: 1, configurable: true }); } catch {}
    maskNativeFunction(dynamicEval, 'eval');
    // Caller-scope support for direct `eval(x)` rewritten to `__zp_eval.call(this, callee, [x], desc, ...)`.
    // A sloppy helper constructed via `Function` with first parameter named `eval` makes `eval(__zp_src)`
    // inside it act as a native direct eval over an environment combining caller local accessors (`desc`)
    // and `withScope`. Declared with `var` to avoid a TDZ before initialization completes.
    var __zp_eval_desc = null;
    const zpDirectEvalRunner = ttFunction([
      'eval', '__zp_env', '__zp_src',
      'return eval(__zp_src)']);
    // Strict direct eval cannot contain a `with` statement inside the evaluated source,
    // so the runner wraps a strict arrow function inside an outer `with(__zp_env)` block.
    // Built lazily and falls back to `null` if `Native.FunctionCtor` rejects `with`.
    let zpDirectEvalStrictRunner;
    const strictRunnerOrNull = () => {
      if (zpDirectEvalStrictRunner === undefined) {
        try {
          zpDirectEvalStrictRunner = ttFunction([
            '__zp_self', '__zp_env', '__zp_src',
            'with(__zp_env){const eval=__zp_self;' + ZP_WITH_PROLOGUE + 'return (()=>{"use strict";return eval(__zp_src)})()}']);
        } catch { zpDirectEvalStrictRunner = null; }
      }
      return zpDirectEvalStrictRunner;
    };
    function zpDirectEval(callee, args, desc, callerStrict, globalSite) {
      // Native `eval` is not a constructor.
      if (new.target) throw new TypeError('eval is not a constructor');
      // If `eval` was rebound to another function, invoke it as an ordinary call.
      if (callee !== dynamicEval) {
        return nativeApply(callee, undefined, Array.isArray(args) ? args : []);
      }
      const arg = args && args.length ? args[0] : undefined;
      // Return non-string arguments (other than TrustedScript) unchanged without evaluation.
      const src = evalSource(arg);
      if (src === null) return arg;
      // Top-level sloppy direct eval runs as global code so `this` is the global facade;
      // inside a function, preserve the caller's `this`.
      const asGlobal = globalSite === 1 && !callerStrict && !STRICT_PROLOGUE_RE.test(src);
      const rewritten = callPageRewriter(src, asGlobal ? 'classic' : 'classic-local');
      // Sloppy direct eval at the top level of a classic script declares `var` and `function`
      // bindings on the global object, so execute it via `execGlobalScript`.
      if (asGlobal) {
        const prevLexEnv = __zp_lex_env;
        __zp_lex_env = newMap();
        try { return execGlobalScript(rewritten); } finally { __zp_lex_env = prevLexEnv; }
      }
      let d = {};
      if (desc && typeof desc === 'object') {
        // Mark caller local binding accessors non-configurable so `delete` on a local returns `false`.
        const dd = Object.getOwnPropertyDescriptors(desc);
        for (const k of Object.keys(dd)) { dd[k].configurable = false; dd[k].enumerable = true; }
        d = Object.defineProperties({}, dd);
      }
      const prev = __zp_eval_desc;
      __zp_eval_desc = d;
      // Isolate `let`, `const`, and `class` declarations inside `eval` to a disposable Map rather than `zpLex`.
      const prevLexEnv = __zp_lex_env;
      __zp_lex_env = newMap();
      try {
        // Use the strict runner when either the caller or the evaluated source is strict.
        const strictSrc = !!callerStrict || STRICT_PROLOGUE_RE.test(src);
        // Single proxy that checks caller locals (`d`) first and falls back to `withScope`.
        const env = new Proxy(d, Object.assign(Object.create(null), {
          // Exclude internal runner parameter names from `has`. Sloppy mode claims all other
          // names to prevent global escapes; strict mode claims only existing bindings so
          // undeclared reads throw ReferenceError.
          has(_t, p) {
            if (p === Symbol.unscopables || p === '__zp_self' || p === '__zp_src' || p === '__zp_env') return false;
            if (!strictSrc) return true;
            return typeof p !== 'string' || nativeHasOwn.call(d, p) || zpLexGetEntry(p) !== undefined || nativeReflectHas(root, p);
          },
          get(_t, p) {
            if (typeof p === 'string' && nativeHasOwn.call(d, p)) return d[p];
            return nativeReflectGet(withScope, p);
          },
          set(_t, p, v) {
            if (typeof p === 'string' && nativeHasOwn.call(d, p)) { d[p] = v; return true; }
            return nativeReflectSet(withScope, p, v);
          },
        }));
        // Append `sourceURL` so stack frames attribute evaluated code to the virtual document URL.
        const tag = '\n//# sourceURL=' + virtualURL.href;
        // Coerce raw `root` receiver to the `scope` facade.
        const that = this === root ? scope : this;
        if (strictSrc) {
          const strictRunner = strictRunnerOrNull();
          if (strictRunner) return strictRunner.call(that, Native.globalEval, env, ttScript(rewritten + tag));
          return zpDirectEvalRunner.call(that, Native.globalEval, env, ttScript('"use strict";' + rewritten + tag));
        }
        return zpDirectEvalRunner.call(that, Native.globalEval, env, ttScript('with(__zp_env){' + ZP_WITH_PROLOGUE + rewritten + '\n}' + tag));
      } finally {
        __zp_eval_desc = prev;
        __zp_lex_env = prevLexEnv;
      }
    }
    define(root, '__zp_eval', zpDirectEval);
    const dynamicConstructorWrappers = newMap([
      [Native.FunctionCtor, dynamicFunction],
      [dynamicFunction, dynamicFunction],
      [NativeAsyncFunction, dynamicAsyncFunction],
      [dynamicAsyncFunction, dynamicAsyncFunction],
      [NativeGeneratorFunction, dynamicGeneratorFunction],
      [dynamicGeneratorFunction, dynamicGeneratorFunction],
      [NativeAsyncGeneratorFunction, dynamicAsyncGeneratorFunction],
      [dynamicAsyncGeneratorFunction, dynamicAsyncGeneratorFunction]
    ]);
    function dynamicWrapperFor(value) { return dynamicConstructorWrappers.get(value) || null; }
    function dynamicGlobal(name) {
      if (name === 'eval') return dynamicEval;
      if (name === 'Function') return dynamicFunction;
      if (name === 'AsyncFunction') return dynamicAsyncFunction;
      if (name === 'GeneratorFunction') return dynamicGeneratorFunction;
      if (name === 'AsyncGeneratorFunction') return dynamicAsyncGeneratorFunction;
      if (name === 'navigation') return virtualNavigationFor(root);
      return null;
    }
    // Inherit from `Location.prototype` so `virtualLocation instanceof Location` holds.
    const LocationProtoBase = (root.Location && root.Location.prototype) || null;
    const virtualLocation = LocationProtoBase ? Object.create(LocationProtoBase) : {};
    definePropertiesMasked(virtualLocation, {
      href: { get: () => virtualURL.href, set: (v) => setVirtualLocation(v), enumerable: true, configurable: false },
      protocol: { get: () => virtualURL.protocol, enumerable: true, configurable: false },
      host: { get: () => virtualURL.host, enumerable: true, configurable: false },
      hostname: { get: () => virtualURL.hostname, enumerable: true, configurable: false },
      port: { get: () => virtualURL.port, enumerable: true, configurable: false },
      pathname: { get: () => virtualURL.pathname, enumerable: true, configurable: false },
      search: { get: () => virtualURL.search, enumerable: true, configurable: false },
      hash: { get: () => virtualURL.hash, set: (v) => updateVirtualHash(v), enumerable: true, configurable: false },
      origin: { get: () => virtualURL.origin, enumerable: true, configurable: false },
      assign: { value: function assign(v) { setVirtualLocation(v); }, enumerable: false, configurable: false, writable: false },
      replace: { value: function replace(v) { setVirtualLocation(v, true); }, enumerable: false, configurable: false, writable: false },
      reload: { value: function reload() { Native.locationReload && Native.locationReload(); }, enumerable: false, configurable: false, writable: false },
      toString: { value: function toString() { return virtualURL.href; }, enumerable: false, configurable: false, writable: false },
      valueOf: { value: function valueOf() { return virtualURL.href; }, enumerable: false, configurable: false, writable: false },
      [Symbol.toPrimitive]: { value: function() { return virtualURL.href; }, enumerable: false, configurable: false, writable: false },
      ancestorOrigins: { get: () => ancestorOriginsList(true), enumerable: true, configurable: false },
    });
    Object.freeze(virtualLocation);
    maskMethods(virtualLocation, ['assign','replace','reload','toString','valueOf']);
    // Cache a Proxy per native Location instance to preserve `instanceof Location`
    // and brand identity while virtualizing URL properties and navigation methods.
    const wrappedLocationCache = newWeakMap();
    // Track Location facade proxies so `isNativeLocation` can reject them without invoking native brand checks.
    const wrappedLocationProxies = newWeakSet();
    // Virtualize all URL component properties on wrapped Location proxies so target code
    // never observes the physical proxy origin.
    const LOC_VIRT_PROPS = newSet(['href','protocol','host','hostname','port','pathname','search','hash','origin']);
    const LOC_ALL_URL_PROPS = newSet(['href','protocol','host','hostname','port','pathname','search','hash','origin']);
    // Reuse shared Location method closures across `wrappedLocationFor` instances.
    const locToString = virtualLocation.toString;
    const locAssign = virtualLocation.assign;
    const locReplace = virtualLocation.replace;
    const locReload = virtualLocation.reload;
    // Build a virtual `DOMStringList` for `location.ancestorOrigins` using virtual origins
    // instead of the physical proxy origins reported by the browser.
    function ancestorOriginsList(local) {
      const origins = local ? embedderOrigins() : [displayOrigin(securityOrigin())];
      const proto = (root.DOMStringList && root.DOMStringList.prototype) || null;
      const list = proto ? Object.create(proto) : {};
      for (let i = 0; i < origins.length; i++) {
        const idx = i;
        defineAccessor(list, idx, () => origins[idx]);
      }
      defineAccessor(list, 'length', () => origins.length);
      define(list, 'item', function item(i) { return i >= 0 && i < origins.length ? origins[i] : null; });
      define(list, 'contains', function contains(s) { return origins.indexOf(String(s)) >= 0; });
      maskMethods(list, ['item', 'contains']);
      return list;
    }
    function wrappedLocationFor(nativeLoc) {
      const cached = wrappedLocationCache.get(nativeLoc);
      if (cached) return cached;
      // Child frames at `about:blank` share these helpers before their own prelude runs,
      // but their navigation methods must still act on the child's native Location.
      const local = nativeLoc === root.location;
      const recordForeignTarget = value => {
        try {
          const abs = targetURL(value);
          const frames = qsaOf(document, 'iframe,frame');
          for (const el of frames) {
            try {
              const cw = nativeFrameWindow(el);
              if (cw && cw.location === nativeLoc) urlMeta.set(el, abs);
            } catch {}
          }
        } catch {}
      };
      const assignLocation = local ? locAssign : function assign(value) {
        recordForeignTarget(value);
        activatedFrameURL(value).then(url => nativeLoc.assign(url));
      };
      const replaceLocation = local ? locReplace : function replace(value) {
        recordForeignTarget(value);
        activatedFrameURL(value).then(url => nativeLoc.replace(url));
      };
      const reloadLocation = local ? locReload : function reload() { nativeLoc.reload(); };
      if (!local) {
        maskNativeFunction(assignLocation, 'assign');
        maskNativeFunction(replaceLocation, 'replace');
        maskNativeFunction(reloadLocation, 'reload');
      }
      // Resolve a child frame's Location to its own virtual target URL via the frame route table,
      // frame element metadata (`urlMeta` or `data-zp-target-url`), or `deproxyURL`, falling back
      // to `null` (and then `virtualURL`) for `about:blank` or `srcdoc`.
      function foreignVirtualURL() {
        try {
          const routed = frameRouteTarget(nativeLoc.pathname);
          if (routed) return new URL(routed);
        } catch {}
        try {
          const frames = qsaOf(document, 'iframe,frame');
          for (const el of frames) {
            try {
              const cw = nativeFrameWindow(el);
              if (cw && cw.location === nativeLoc) {
                const t = urlMeta.get(el) || Native.getAttribute.call(el, 'data-zp-target-url');
                if (t && /^https?:/i.test(t)) return new URL(t);
              }
            } catch {}
          }
        } catch {}
        try {
          const raw = deproxyURL(nativeLoc.href, { scan: true });
          if (/^https?:/i.test(raw) && new URL(raw).origin !== proxyOrigin) return new URL(raw);
        } catch {}
        return null;
      }
      const methodCache = newMap();
      const handler = {
        get(target, prop) {
          if (typeof prop === 'string' && LOC_VIRT_PROPS.has(prop)) {
            // Fall back to the embedder's `virtualURL` for `about:blank` and `srcdoc` child frames.
            if (local) return virtualURL[prop];
            const fv = foreignVirtualURL();
            return (fv || virtualURL)[prop];
          }
          if (prop === 'toString') return locToString;
          if (prop === 'assign') return assignLocation;
          if (prop === 'replace') return replaceLocation;
          if (prop === 'reload') return reloadLocation;
          if (prop === 'ancestorOrigins') return ancestorOriginsList(local);
          if (typeof prop === 'string' && methodCache.has(prop)) return methodCache.get(prop);
          const value = Reflect.get(nativeLoc, prop, nativeLoc);
          if (typeof value === 'function') {
            const bound = value.bind(nativeLoc);
            if (typeof prop === 'string') methodCache.set(prop, bound);
            return bound;
          }
          return value;
        },
        set(target, prop, value) {
          if (prop === 'href') { assignLocation(value); return true; }
          if (prop === 'hash' && local) { updateVirtualHash(value); return true; }
          if (typeof prop === 'string' && LOC_ALL_URL_PROPS.has(prop)) {
            try {
              const u = new URL((local ? virtualURL : foreignVirtualURL() || virtualURL).href);
              u[prop] = value; assignLocation(u.href);
            } catch {}
            return true;
          }
          return Reflect.set(nativeLoc, prop, value, nativeLoc);
        },
        has(_t, prop) { return Reflect.has(nativeLoc, prop); },
        ownKeys() { return Reflect.ownKeys(nativeLoc); },
        getOwnPropertyDescriptor(t, prop) {
          // Report virtualized URL properties using the non-configurable native-shaped accessors
          // defined on `locTarget` to satisfy Proxy descriptor invariants.
          if (typeof prop === 'string' && LOC_VIRT_PROPS.has(prop)) return Reflect.getOwnPropertyDescriptor(t, prop);
          const d = Reflect.getOwnPropertyDescriptor(nativeLoc, prop);
          // `locTarget` has no other own properties, so mark forwarded descriptors configurable
          // to satisfy Proxy invariants during property enumeration.
          if (d) d.configurable = true;
          return d;
        },
        getPrototypeOf() { return Reflect.getPrototypeOf(nativeLoc); },
      };
      // Use `Object.create(nativeLoc)` as the Proxy target instead of `nativeLoc` directly.
      // Native Location methods (`reload`, `assign`, `replace`) and URL accessors are own,
      // non-configurable properties on `nativeLoc`, which would cause Proxy `get` traps
      // returning virtualized replacements to throw a Proxy invariant TypeError.
      const locTarget = Object.create(nativeLoc);
      const proxy = new Proxy(locTarget, handler);
      // Install non-configurable accessors on `locTarget` for `LOC_VIRT_PROPS` so
      // `getOwnPropertyDescriptor` can report native-shaped descriptors without violating Proxy invariants.
      for (const prop of LOC_VIRT_PROPS) {
        const nd = Reflect.getOwnPropertyDescriptor(nativeLoc, prop);
        // Use object-literal accessors so getters/setters have no `prototype` and are not constructors.
        const pair = Object.getOwnPropertyDescriptor({ get [prop]() { return proxy[prop]; }, set [prop](v) { proxy[prop] = v; } }, prop);
        defineMasked(locTarget, prop, { get: pair.get, set: !nd || nd.set ? pair.set : undefined, enumerable: nd ? nd.enumerable : true, configurable: false });
      }
      wrappedLocationCache.set(nativeLoc, proxy);
      wrappedLocationProxies.add(proxy);
      return proxy;
    }
    const crossWindowTargets = newWeakMap();
    const crossOriginLocations = newWeakMap();
    // Check whether sandbox flags on this document forbid navigating `win`.
    // A frame may always navigate itself and its descendants, and may navigate `top`
    // only with `allow-top-navigation` (or `allow-top-navigation-by-user-activation` when active).
    function sandboxNavigationDenied(win, prefix) {
      const flags = opaqueDocument ? sandboxFlags() : null;
      if (!flags) return null;
      let text;
      try {
        if (win === root) return null;
        for (let w = win, i = 0; i < 32 && w && w !== winGet(w, 'parent'); i++) { w = winGet(w, 'parent'); if (w === root) return null; }
        const isTop = win === winGet(root, 'top');
        if (isTop && (flags.has('allow-top-navigation')
            || (flags.has('allow-top-navigation-by-user-activation') && root.navigator.userActivation && root.navigator.userActivation.isActive))) return null;
        text = isTop
          ? "The frame attempting navigation of the top-level window is sandboxed, but the flag of 'allow-top-navigation' or 'allow-top-navigation-by-user-activation' is not set."
          : 'The frame attempting navigation is sandboxed, and is therefore disallowed from navigating its ancestors.';
      } catch { text = 'The frame attempting navigation is sandboxed.'; }
      try { root.console.error("Unsafe attempt to initiate navigation for frame from frame with URL '" + virtualURL.href + "'. " + text); } catch {}
      return opaqueDenied(prefix, text);
    }
    function crossWindowLocation(targetWindow) {
      // Delegate to the target window's own Location facade so cross-frame writes navigate the target frame.
      let ownerGet;
      try { ownerGet = targetWindow.__zp_get; } catch { ownerGet = undefined; }
      if (ownerGet === get && (virtualOriginOfWindow(targetWindow) || securityOrigin()) === securityOrigin()) {
        return wrappedLocationFor(targetWindow.location);
      }
      if (typeof ownerGet === 'function' && ownerGet !== get) {
        const location = ownerGet(targetWindow, 'location');
        if (virtualOriginOfWindow(targetWindow) === securityOrigin()) return location;
      } else if (virtualOriginOfWindow(targetWindow) === securityOrigin()) {
        // Same-origin document without a booted membrane (such as a text or image document).
        return wrappedLocationFor(targetWindow.location);
      }
      // Cross-origin windows expose a restricted Location facade that permits `href` writes
      // and `replace()` for navigation while throwing `SecurityError` on reads.
      let restricted = crossOriginLocations.get(targetWindow);
      if (!restricted) {
        const navigate = (value, replace) => {
          const denied = sandboxNavigationDenied(targetWindow, replace ? "Failed to execute 'replace' on 'Location'" : "Failed to set the 'href' property on 'Location'");
          if (denied) throw denied;
          const absolute = targetURL(value);
          try { const fe = winGet(targetWindow, 'frameElement'); if (fe) urlMeta.set(fe, absolute); } catch {}
          let g;
          try { g = targetWindow.__zp_get; } catch { g = undefined; }
          if (typeof g === 'function' && g !== get) {
            const owner = g(targetWindow, 'location');
            if (replace) owner.replace(absolute);
            else owner.href = absolute;
            return;
          }
          // Target window has no membrane; route frame navigation directly.
          activatedFrameURL(absolute, undefined, () => windowIsOpaque(targetWindow)).then(u => {
            if (replace) targetWindow.location.replace(u);
            else if (windowReachable(targetWindow)) targetWindow.location.assign(u);
            else targetWindow.location.href = u; // the one navigation a cross-origin Location allows besides replace()
          }).catch(() => {});
        };
        const replace = function replace(value) { navigate(value, true); };
        maskNativeFunction(replace, 'replace');
        const deny = () => { throw crossOriginDenied('refuse', undefined, 'Location'); };
        const denyRead = prop => { throw crossOriginDenied('read a named property', prop, 'Location'); };
        const hrefAccessor = () => {
          const s = function (v) { navigate(v, false); };
          maskAccessorFn(s, 'set', 'href');
          return { get: undefined, set: s, enumerable: false, configurable: true };
        };
        // Match Chrome's cross-origin Location property surface (`href`, `replace`, `then`, and cross-origin symbols).
        restricted = new Proxy(Object.create(null), {
          get(_target, prop) {
            if (prop === 'replace') return replace;
            if (prop === 'then' || CROSS_ORIGIN_SYMBOLS.includes(prop)) return undefined;
            return denyRead(prop);
          },
          set(_target, prop, value) {
            if (prop !== 'href') throw crossOriginDenied('set a named property', prop, 'Location');
            navigate(value, false);
            return true;
          },
          has(_target, prop) { if (prop === 'href' || prop === 'replace') return true; return deny(); },
          ownKeys() { return ['href', 'replace', 'then', Symbol.toStringTag, Symbol.hasInstance, Symbol.isConcatSpreadable]; },
          getOwnPropertyDescriptor(_target, prop) {
            if (prop === 'href') return hrefAccessor();
            if (prop === 'replace') return { value: replace, writable: false, enumerable: false, configurable: true };
            if (prop === 'then' || prop === Symbol.toStringTag || prop === Symbol.hasInstance || prop === Symbol.isConcatSpreadable) {
              return { value: undefined, writable: false, enumerable: false, configurable: true };
            }
            return denyRead(prop);
          },
          deleteProperty: deny,
          defineProperty: deny,
          setPrototypeOf: deny,
          preventExtensions: deny,
        });
        crossOriginLocations.set(targetWindow, restricted);
      }
      return restricted;
    }
    // Virtualize `window.navigation`: report `virtualURL.href` for entry and destination
    // URLs, route `navigate()` and `reload()` through the virtual Location facade, and
    // delegate history traversal (`back`, `forward`, `traverseTo`) to native session entries.
    const navFacadeCache = newWeakMap();
    function virtualNavigationFor(win) {
      if (!win) return null;
      // Delegate to a prelude-booted child's own Navigation facade so entry URLs reflect the child's target.
      if (win !== root) {
        const ownerGet = win.__zp_get;
        if (typeof ownerGet === 'function' && ownerGet !== get) {
          try { return ownerGet(win, 'navigation'); } catch {}
        }
      }
      let cached = navFacadeCache.get(win);
      if (cached !== undefined) return cached;
      const native = winGet(win, 'navigation');
      if (!native) { navFacadeCache.set(win, null); return null; }
      const NavProtoBase = (win.Navigation && win.Navigation.prototype) || null;
      const NavEntryProtoBase = (win.NavigationHistoryEntry && win.NavigationHistoryEntry.prototype) || null;
      const entryFacades = newWeakMap();
      const listenerWrappers = newWeakMap();
      const handlerStore = Object.create(null);
      // Keep properties non-enumerable so `Object.keys(navigation)` is empty, matching native IDL attributes.
      function facadeEntry(real) {
        if (!real) return null;
        let e = entryFacades.get(real);
        if (e) return e;
        e = NavEntryProtoBase ? Object.create(NavEntryProtoBase) : {};
        definePropertiesMasked(e, {
          url: { get: () => virtualURL.href, enumerable: false, configurable: true },
          key: { get: () => real.key, enumerable: false, configurable: true },
          id: { get: () => real.id, enumerable: false, configurable: true },
          index: { get: () => real.index, enumerable: false, configurable: true },
          sameDocument: { get: () => real.sameDocument, enumerable: false, configurable: true },
          getState: { value: function getState() { return real.getState(); }, enumerable: false, configurable: true, writable: true },
        });
        maskMethods(e, ['getState']);
        entryFacades.set(real, e);
        return e;
      }
      function navResult(real) {
        return {
          committed: real && real.committed ? real.committed.then(facadeEntry) : Promise.resolve(null),
          finished: real && real.finished ? real.finished.then(facadeEntry) : Promise.resolve(null),
        };
      }
      function navigate(raw, opts) {
        const url = targetURL(String(raw), baseURL);
        if (!isHTTPURL(url)) throw normalizedError('NotSupportedError');
        // Route navigation through the Location facade (`setVirtualLocation` for root, `activatedFrameURL` for child frames).
        wrappedLocationFor(win.location).href = url;
        if (opts && typeof opts === 'object' && 'state' in opts && native.updateCurrentEntry) {
          try { native.updateCurrentEntry({ state: opts.state }); } catch {}
        }
        const e = facadeEntry(native.currentEntry);
        return { committed: Promise.resolve(e), finished: Promise.resolve(e) };
      }
      function reloadNav() {
        try { wrappedLocationFor(win.location).reload(); } catch {}
        const e = facadeEntry(native.currentEntry);
        return { committed: Promise.resolve(e), finished: Promise.resolve(e) };
      }
      function destinationFacade(d) {
        if (!d) return d;
        return Object.freeze({
          url: virtualURL.href, key: d.key, id: d.id, index: d.index,
          sameDocument: d.sameDocument, getState: () => d.getState(),
        });
      }
      function navEventFacade(ev) {
        return new Proxy(ev, {
          get(t, p) {
            if (p === 'destination') return destinationFacade(ev.destination);
            if (p === 'from') return facadeEntry(ev.from);
            if (p === 'target' || p === 'currentTarget' || p === 'srcElement') return facade;
            const v = Reflect.get(t, p, t);
            return typeof v === 'function' ? v.bind(t) : v;
          }
        });
      }
      function addNavListener(type, listener, opts) {
        if (listener && (typeof listener === 'function' || typeof listener.handleEvent === 'function')) {
          let w = listenerWrappers.get(listener);
          if (!w) {
            w = function (ev) { return typeof listener === 'function' ? listener.call(this, navEventFacade(ev)) : listener.handleEvent.call(listener, navEventFacade(ev)); };
            listenerWrappers.set(listener, w);
          }
          listener = w;
        }
        return native.addEventListener(type, listener, opts);
      }
      function removeNavListener(type, listener, opts) {
        return native.removeEventListener(type, listenerWrappers.get(listener) || listener, opts);
      }
      const descs = {
        currentEntry: { get: () => facadeEntry(native.currentEntry), enumerable: false, configurable: true },
        canGoBack: { get: () => !!native.canGoBack, enumerable: false, configurable: true },
        canGoForward: { get: () => !!native.canGoForward, enumerable: false, configurable: true },
        entries: { value: function entries() { return native.entries().map(facadeEntry); }, enumerable: false, configurable: true, writable: true },
        navigate: { value: navigate, enumerable: false, configurable: true, writable: true },
        reload: { value: function reload() { return reloadNav(); }, enumerable: false, configurable: true, writable: true },
        back: { value: function back() { return navResult(native.back()); }, enumerable: false, configurable: true, writable: true },
        forward: { value: function forward() { return navResult(native.forward()); }, enumerable: false, configurable: true, writable: true },
        traverseTo: { value: function traverseTo(key) { return navResult(native.traverseTo(key)); }, enumerable: false, configurable: true, writable: true },
        updateCurrentEntry: { value: function updateCurrentEntry(o) { return native.updateCurrentEntry(o); }, enumerable: false, configurable: true, writable: true },
        addEventListener: { value: addNavListener, enumerable: false, configurable: true, writable: true },
        removeEventListener: { value: removeNavListener, enumerable: false, configurable: true, writable: true },
        dispatchEvent: { value: function dispatchEvent(e) { return native.dispatchEvent(e); }, enumerable: false, configurable: true, writable: true },
        transition: {
          get: () => {
            const t = native.transition;
            return t ? Object.freeze({ from: facadeEntry(t.from), navigationType: t.navigationType }) : t;
          }, enumerable: false, configurable: true
        },
        activation: {
          get: () => {
            const a = native.activation;
            return a ? Object.freeze({ entry: facadeEntry(a.entry), from: facadeEntry(a.from), navigationType: a.navigationType }) : a;
          }, enumerable: false, configurable: true
        },
      };
      for (const t of ['navigate', 'navigatesuccess', 'navigateerror', 'currententrychange']) {
        const key = 'on' + t;
        descs[key] = {
          get: () => handlerStore[key] || null,
          set: (v) => {
            handlerStore[key] = v;
            let wrapped = null;
            if (typeof v === 'function') {
              wrapped = listenerWrappers.get(v);
              if (!wrapped) { wrapped = function (ev) { return v.call(this, navEventFacade(ev)); }; listenerWrappers.set(v, wrapped); }
            }
            try { native[key] = wrapped; } catch {}
          },
          enumerable: false, configurable: true
        };
      }
      const facade = NavProtoBase ? Object.create(NavProtoBase) : {};
      definePropertiesMasked(facade, descs);
      maskMethods(facade, ['entries','navigate','reload','back','forward','traverseTo','updateCurrentEntry','addEventListener','removeEventListener','dispatchEvent']);
      navFacadeCache.set(win, facade);
      return facade;
    }
    // Step up the frame hierarchy (`parent` or `top`), returning `fallback` on failure or at the top.
    function climbCrossWindow(targetWindow, prop, fallback) {
      try {
        // Read the native ancestor via `winGet` rather than a child membrane's hooked accessor
        // so `iframe.contentWindow.parent === window` and `.top === window` preserve identity.
        const next = winGet(targetWindow, prop);
        if (next && next !== targetWindow) return windowHandleFor(next, 'ancestor');
      } catch {}
      return fallback;
    }
    // Check whether `prop` is a safe expando property to forward to a same-origin window,
    // excluding `__zp_*` helpers, `MEMBER_DANGER` properties, and string `on*` handlers.
    function crossExpandoProp(prop, value) {
      return typeof prop !== 'string'
        || (!ZP_HIDDEN_RE.test(prop) && !MEMBER_DANGER.has(prop)
            && !(prop.startsWith('on') && typeof value === 'string'));
    }
    // Return the page-facing `window` facade of another realm's booted membrane so same-origin
    // ancestor properties (`document`, storage, timers) resolve through that realm's virtualization.
    function ownerScopeOf(win) {
      try {
        const g = win.__zp_get;
        if (typeof g === 'function' && g !== get) return g(win, 'window') || null;
      } catch {}
      return null;
    }
    function safeCrossWindow(targetWindow) {
      if (!targetWindow || targetWindow === root) return scope;
      if (crossWindowProxyCache.has(targetWindow)) return crossWindowProxyCache.get(targetWindow);
      const proxyTarget = {};
      // Wrap the cross-window facade in a Proxy so property reads and assignments
      // emitted by the rewriter (`__zp_get(parent).x = v`) forward to `targetWindow`.
      const proxy = new Proxy(proxyTarget, {
        get(t, prop) {
          if (Reflect.getOwnPropertyDescriptor(t, prop)) return Reflect.get(t, prop);
          // Forward reads on a same-origin ancestor to its own `window` facade.
          if (typeof prop !== 'string' || !ZP_HIDDEN_RE.test(prop)) {
            const owner = ownerScopeOf(targetWindow);
            if (owner) return Reflect.get(owner, prop);
          }
          // Forward only own expando properties so unpatched prototype builtins (`eval`, `Function`, `fetch`) are not exposed.
          if (crossExpandoProp(prop)) {
            try {
              if (Reflect.getOwnPropertyDescriptor(targetWindow, prop)) return Reflect.get(targetWindow, prop);
            } catch {}
          }
          return undefined;
        },
        set(t, prop, value) {
          if (crossExpandoProp(prop, value)) {
            const owner = ownerScopeOf(targetWindow);
            try { Reflect.set(owner || targetWindow, prop, value); } catch {}
            return true;
          }
          return Reflect.set(t, prop, value);
        },
        has(t, prop) {
          if (Reflect.has(t, prop)) return true;
          if (typeof prop !== 'string' || !ZP_HIDDEN_RE.test(prop)) {
            const owner = ownerScopeOf(targetWindow);
            if (owner) return Reflect.has(owner, prop);
          }
          if (crossExpandoProp(prop)) {
            try { return !!Reflect.getOwnPropertyDescriptor(targetWindow, prop); } catch { return false; }
          }
          return false;
        },
        deleteProperty(t, prop) {
          if (crossExpandoProp(prop)) {
            const owner = ownerScopeOf(targetWindow);
            try { Reflect.deleteProperty(owner || targetWindow, prop); } catch {}
            return true;
          }
          return Reflect.deleteProperty(t, prop);
        },
      });
      definePropertiesMasked(proxyTarget, {
        window: { get() { return proxy; }, enumerable: true },
        self: { get() { return proxy; }, enumerable: true },
        globalThis: { get() { return proxy; }, enumerable: true },
        // Resolve `top` and `parent` along the actual ancestor chain via `climbCrossWindow`
        // so frame-tree traversals (`while (w !== w.top) w = w.parent`) terminate normally.
        top: { get() { return climbCrossWindow(targetWindow, 'top', proxy); }, enumerable: true },
        parent: { get() { return climbCrossWindow(targetWindow, 'parent', proxy); }, enumerable: true },
        frames: { get() { return proxy; }, enumerable: true },
        location: { get() { return crossWindowLocation(targetWindow); }, set(value) { crossWindowLocation(targetWindow).href = value; }, enumerable: true },
        postMessage: { value: postMessageWrapperFor(targetWindow), enumerable: true }
      });
      crossWindowProxyCache.set(targetWindow, proxy);
      crossWindowTargets.set(proxy, targetWindow);
      return proxy;
    }
    // ── which windows a page may hold, and in what form
    // Because all proxied frames share one physical origin, the membrane enforces
    // cross-origin window isolation based on virtual origins. Windows with a different
    // virtual origin are wrapped in a restricted Proxy matching HTML cross-origin window
    // semantics (exposing only `CROSS_ORIGIN_WINDOW_NAMES` and throwing `SecurityError`
    // on all other reads, writes, prototype lookups, and descriptor mutations).
    // Same-origin ancestors resolve to their own page-facing window facade.
    const CROSS_ORIGIN_WINDOW_NAMES = ['window', 'self', 'location', 'closed', 'frames', 'length', 'top', 'opener', 'parent', 'blur', 'close', 'focus', 'postMessage'];
    const CROSS_ORIGIN_WINDOW_NAME_SET = newSet(CROSS_ORIGIN_WINDOW_NAMES);
    const CROSS_ORIGIN_SYMBOLS = [Symbol.toStringTag, Symbol.hasInstance, Symbol.isConcatSpreadable];
    const crossOriginFacadeSet = newWeakSet();
    const crossOriginFacades = newWeakMap();
    const crossOriginMethods = newWeakMap();
    // Return the virtual security origin reported by `win`'s own membrane, or `''` if none is booted.
    function ownMembraneOrigin(win) {
      try {
        // Prefer `__zp_origin` so sandboxed opaque documents report their unique security origin token.
        const stated = win.__zp_origin;
        if (typeof stated === 'function') {
          const o = stated();
          if (typeof o === 'string' && o) return o;
        }
        const g = win.__zp_get;
        if (typeof g === 'function' && g !== get) {
          const o = g(win, 'location').origin;
          if (typeof o === 'string') return o;
        }
      } catch {}
      return '';
    }
    function virtualOriginOfWindow(win) {
      if (win === root) return securityOrigin();
      const own = ownMembraneOrigin(win);
      if (own) return own;
      // A window the browser holds as cross-origin has no membrane to ask: the page that embeds this one was described in the boot
      // configuration, and a site frame this document embeds was recorded when its route was set.
      if (siteFrameBoot) {
        try {
          if (winGet(root, 'parent') === win) return new URL(siteFrameBoot.parentUrl).origin;
          if (winGet(root, 'top') === win) return new URL(siteFrameBoot.topUrl).origin;
        } catch {}
      }
      try { const remembered = frameRealOrigins.has(win) ? frameWindowOrigins.get(win) : ''; if (remembered) return remembered; } catch {}
      // Before a child frame boots its own membrane, check its host frame element's intended origin.
      try {
        const fe = winGet(win, 'frameElement');
        if (fe) {
          const intended = frameIntendedOrigin(fe);
          if (intended) return intended;
        }
      } catch {}
      // Inherit this realm's security origin for blank, `srcdoc`, or `document.write` frames contained by this realm.
      try { if (win.__zp_get === get) return securityOrigin(); } catch {}
      // Fall back to the target URL recorded in the frame route table.
      try { const routed = frameRouteTarget(win.location.pathname); if (routed) return new URL(routed).origin; } catch {}
      return '';
    }
    // Determine the intended target origin of a frame element before its document finishes booting.
    function frameIntendedOrigin(frame) {
      // Frames marked opaque (sandboxed without `allow-same-origin`) have a unique opaque origin.
      try { if (Native.hasAttribute.call(frame, OPAQUE_FRAME_ATTR)) return OPAQUE_PENDING_ORIGIN; } catch {}
      try {
        const t = urlMeta.get(frame) || Native.getAttribute.call(frame, 'data-zp-target-url');
        if (t && /^https?:/i.test(t)) return new URL(t).origin;
      } catch {}
      return '';
    }
    function isAncestorWindow(win) {
      try {
        const raw = crossWindowTargets.get(win) || win;
        let w = root;
        for (let i = 0; i < 32; i++) {
          const p = winGet(w, 'parent');
          if (!p || p === w) break;
          if (p === raw) return true;
          w = p;
        }
        const o = winGet(root, 'opener');
        if (o && o === raw) return true;
      } catch {}
      return false;
    }
    function sameOriginAncestor(win) {
      return safeCrossWindow(crossWindowTargets.get(win) || win);
    }
    function containSameOriginChildWindow(win) {
      try {
        const raw = crossWindowTargets.get(win) || win;
        if (!raw || raw === root || isScopeProxy(raw) || isAncestorWindow(raw) || ownsMembrane(raw)) return;
        if (bootingProxiedDocument(raw)) installEarlyPostMessage(raw);
        else if (!raw[networkContainmentMarker]) installNetworkContainment(raw);
      } catch {}
    }
    // Resolve `win` to the appropriate facade (`scope`, `sameOriginAncestor`, or `crossOriginWindow`).
    function windowHandleFor(win, hint) {
      if (!win || typeof win !== 'object') return win;
      if (win === root || isScopeProxy(win)) return scope;
      if (crossOriginFacadeSet.has(win)) return win;
      const raw = crossWindowTargets.get(win) || win;
      if (raw === root) return scope;
      let origin = ownMembraneOrigin(raw);
      if (!origin && hint && typeof hint === 'object') origin = frameIntendedOrigin(hint);
      if (!origin) origin = virtualOriginOfWindow(raw);
      if (origin && origin !== securityOrigin()) return crossOriginWindow(raw);
      if (hint === 'ancestor' || (hint === undefined && isAncestorWindow(raw))) return sameOriginAncestor(raw);
      containSameOriginChildWindow(raw);
      return win;
    }
    // Construct a `SecurityError` DOMException matching Chrome's cross-origin Window and Location error messages.
    const INDEX_NAME_RE = /^(?:0|[1-9]\d*)$/;
    function crossOriginDenied(verb, prop, iface) {
      const face = iface || 'Window';
      const indexed = typeof prop === 'string' && INDEX_NAME_RE.test(prop);
      // Format symbol names in brackets, omitting `Symbol.toPrimitive` and descriptionless symbols.
      const nameText = typeof prop === 'symbol'
        ? (prop === Symbol.toPrimitive || !prop.description ? '' : " '[" + prop.description + "]'")
        : " '" + String(prop) + "'";
      let lead = '';
      if (verb === 'read a named property' || (verb === 'check a named property' && indexed)) {
        lead = indexed ? 'Failed to read an indexed property [' + prop + "] from '" + face + "': "
          : 'Failed to read a named property' + nameText + " from '" + face + "': ";
      } else if (verb === 'set a named property') {
        lead = indexed ? 'Failed to set an indexed property [' + prop + "] on '" + face + "': "
          : 'Failed to set a named property' + nameText + " on '" + face + "': ";
      }
      try {
        return new Native.DOMException(lead + 'Blocked a frame with origin "' + displayOrigin(securityOrigin()) + '" from accessing a cross-origin frame.', 'SecurityError');
      } catch { return normalizedError('SecurityError'); }
    }
    // Cache one stable wrapper per cross-origin window method (`close`, `focus`, `blur`).
    function crossOriginMethod(win, name) {
      let m = crossOriginMethods.get(win);
      if (!m) { m = Object.create(null); crossOriginMethods.set(win, m); }
      if (!m[name]) {
        const fn = function () { return Reflect.apply(win[name], win, []); };
        try {
          Object.defineProperty(fn, 'name', { value: name, configurable: true });
          Object.defineProperty(fn, 'length', { value: 0, configurable: true });
        } catch {}
        maskNativeFunction(fn, name);
        m[name] = fn;
      }
      return m[name];
    }
    function crossOriginWindow(win) {
      let facade = crossOriginFacades.get(win);
      if (facade) return facade;
      const childCount = () => { try { return winGet(win, 'length') >>> 0; } catch { return 0; } };
      const isIndex = p => typeof p === 'string' && /^(?:0|[1-9]\d*)$/.test(p) && Number(p) < childCount();
      // Expose named child frames on cross-origin windows via `get` and `getOwnPropertyDescriptor`
      // (while still throwing on `in`), matching HTML cross-origin named access semantics.
      const namedChild = p => {
        if (typeof p !== 'string' || p === '') return null;
        if (!windowReachable(win)) {
          // Names live in that window's own realm; natively a cross-origin window still answers for its children's names.
          try { const v = win[p]; return v && typeof v === 'object' ? v : null; } catch { return null; }
        }
        try {
          for (let i = 0, n = childCount(); i < n; i++) {
            const child = win[i];
            if (child && String(winGet(child, 'name')) === p) return child;
          }
        } catch {}
        return null;
      };
      const read = name => {
        switch (name) {
          case 'window': case 'self': case 'frames': return facade;
          case 'location': return crossWindowLocation(win);
          case 'closed': return winGet(win, 'closed');
          case 'length': return winGet(win, 'length');
          case 'top': case 'parent': case 'opener': { const h = winGet(win, name); return h ? windowHandleFor(h, 'ancestor') : h; }
          case 'postMessage': return postMessageWrapperFor(win);
          default: return crossOriginMethod(win, name);
        }
      };
      const accessor = (name, setter) => {
        const g = function () { return read(name); };
        maskAccessorFn(g, 'get', name);
        let s;
        if (setter) { s = function (v) { setter(v); }; maskAccessorFn(s, 'set', name); }
        return { get: g, set: s, enumerable: false, configurable: true };
      };
      const denyMutation = (verb, prop) => { throw crossOriginDenied(verb, prop); };
      // Use an extensible null-prototype target so Proxy traps are unconstrained by target invariants.
      facade = new Proxy(Object.create(null), {
        get(_t, prop) {
          if (typeof prop === 'symbol') {
            if (CROSS_ORIGIN_SYMBOLS.includes(prop)) return undefined;
            throw crossOriginDenied('read a named property', prop);
          }
          if (prop === 'then') return undefined;
          if (CROSS_ORIGIN_WINDOW_NAME_SET.has(prop)) return read(prop);
          if (isIndex(prop)) return windowHandleFor(win[prop]);
          const named = namedChild(prop);
          if (named) return windowHandleFor(named);
          throw crossOriginDenied('read a named property', prop);
        },
        set(_t, prop, value) {
          if (prop === 'location') { crossWindowLocation(win).href = value; return true; }
          throw crossOriginDenied('set a named property', prop);
        },
        has(_t, prop) {
          if (typeof prop === 'string' && (CROSS_ORIGIN_WINDOW_NAME_SET.has(prop) || isIndex(prop))) return true;
          throw crossOriginDenied('check a named property', prop);
        },
        deleteProperty(_t, prop) { return denyMutation('delete a named property', prop); },
        defineProperty(_t, prop) { return denyMutation('define a named property', prop); },
        setPrototypeOf() { return denyMutation('set the prototype', 'prototype'); },
        preventExtensions() { return denyMutation('prevent extensions', 'extensions'); },
        isExtensible() { return true; },
        getPrototypeOf() { return null; },
        getOwnPropertyDescriptor(_t, prop) {
          if (typeof prop === 'symbol') {
            if (CROSS_ORIGIN_SYMBOLS.includes(prop)) return { value: undefined, writable: false, enumerable: false, configurable: true };
            throw crossOriginDenied('read a named property', prop);
          }
          if (prop === 'then') return { value: undefined, writable: false, enumerable: false, configurable: true };
          switch (prop) {
            case 'location': return accessor('location', v => { crossWindowLocation(win).href = v; });
            case 'blur': case 'close': case 'focus': case 'postMessage':
              return { value: read(prop), writable: false, enumerable: false, configurable: true };
            case 'window': case 'self': case 'closed': case 'frames': case 'length': case 'top': case 'opener': case 'parent':
              return accessor(prop);
          }
          if (isIndex(prop)) return { value: windowHandleFor(win[prop]), writable: false, enumerable: true, configurable: true };
          const named = namedChild(prop);
          if (named) return { value: windowHandleFor(named), writable: false, enumerable: false, configurable: true };
          throw crossOriginDenied('read a named property', prop);
        },
        ownKeys() {
          const keys = [];
          for (let i = 0, n = childCount(); i < n; i++) keys.push(String(i));
          return keys.concat(CROSS_ORIGIN_WINDOW_NAMES, ['then'], CROSS_ORIGIN_SYMBOLS);
        },
      });
      crossOriginFacades.set(win, facade);
      crossOriginFacadeSet.add(facade);
      crossWindowTargets.set(facade, win);
      return facade;
    }
    // Return `null` for `frameElement` when the embedding parent has a different virtual origin,
    // preventing cross-origin traversal into the embedder's DOM.
    function virtualFrameElement(w) {
      let el = null;
      try { el = winGet(w, 'frameElement'); } catch {}
      if (!el) return el;
      try {
        const up = winGet(w, 'parent');
        if (up && up !== w) {
          const mine = virtualOriginOfWindow(w);
          const theirs = virtualOriginOfWindow(up);
          if (mine && theirs && mine !== theirs) return null;
        }
      } catch {}
      return el;
    }
    function virtualWindowProperty(target, prop) {
      if (prop === 'top' || prop === 'parent' || prop === 'opener') {
        try {
          const child = winGet(target, prop);
          if (prop === 'opener' && !isWindowLike(child)) return child;
          if (child && child !== target) return windowHandleFor(child, target === root ? 'ancestor' : undefined);
          if (child === target && target !== root) return windowHandleFor(target);
        } catch {}
      }
      return scope;
    }
    maskNativeFunction(virtualLocation[Symbol.toPrimitive], Symbol.toPrimitive);
    // Install a virtual `location` accessor on `scopeTarget` because `window.location` is
    // unforgeable (`configurable: false`) on the native Window and cannot be overridden
    // solely by a Proxy trap without matching the shadow target descriptor.
    const scopeTarget = Object.create(nativeReflectGetPrototypeOf(root));
    const nativeWindowLocation = nativeReflectGOPD(root, 'location');
    const scopeLocationGet = function () {
      if (this !== root && !isScopeProxy(this)) throw new TypeError('Illegal invocation');
      return wrappedLocationFor(root.location);
    };
    const scopeLocationSet = function (value) {
      if (this !== root && !isScopeProxy(this)) throw new TypeError('Illegal invocation');
      setVirtualLocation(value);
    };
    maskAccessorFn(scopeLocationGet, 'get', 'location');
    maskAccessorFn(scopeLocationSet, 'set', 'location');
    defineMasked(scopeTarget, 'location', {
      get: scopeLocationGet, set: scopeLocationSet,
      enumerable: nativeWindowLocation.enumerable,
      configurable: nativeWindowLocation.configurable
    });
    // Snapshot native configurable own accessors on `window` (`performance`, `crypto`, `indexedDB`, etc.)
    // at boot so they continue to run with the real `root` receiver (passing WebIDL brand checks),
    // while accessors installed later by page code run with `scope` as `this`.
    const bootOwnAccessors = newMap();
    for (const name of nativeOwnKeys(root)) {
      const d = nativeReflectGOPD(root, name);
      if (d && d.configurable && (d.get || d.set)) bootOwnAccessors.set(name, d);
    }
    function isPageInstalledAccessor(prop, own) {
      if (!own || !own.configurable || !(own.get || own.set)) return false;
      const boot = bootOwnAccessors.get(prop);
      return !boot || boot.get !== own.get || boot.set !== own.set;
    }
    function isPrototypeAccessor(prop) {
      if (prop === '__proto__') return false;
      for (let p = nativeReflectGetPrototypeOf(root); p; p = nativeReflectGetPrototypeOf(p)) {
        const d = nativeReflectGOPD(p, prop);
        if (d) return !!(d.get || d.set);
      }
      return false;
    }
    // Allow page code to redefine replaceable or configurable window properties (`self`, `frames`,
    // `parent`, `opener`, `frameElement`, `name`, `navigation`, `history`) and observe its own
    // definitions and descriptors, running page-supplied getters with `scope` as `this`.
    const PAGE_DEFINABLE = newSet(['self', 'frames', 'parent', 'opener', 'frameElement', 'name', 'navigation', 'history']);
    const bootDefinable = newMap();
    for (const name of ['self', 'frames', 'parent', 'opener', 'frameElement', 'name', 'navigation', 'history']) {
      const d = nativeReflectGOPD(root, name);
      if (d) bootDefinable.set(name, d);
    }
    const NO_PAGE_DEFINITION = {};
    function pageDefined(prop) {
      const boot = bootDefinable.get(prop);
      if (!boot) return null;
      const own = nativeReflectGOPD(root, prop);
      if (!own) return null;
      if (own.get === boot.get && own.set === boot.set && own.value === boot.value) return null;
      // If only the setter was replaced, continue answering reads through the membrane.
      if (own.get && own.get === boot.get) return null;
      return own;
    }
    function pageDefinedMember(prop) {
      const own = pageDefined(prop);
      if (!own) return NO_PAGE_DEFINITION;
      return own.get ? nativeApply(own.get, scope, []) : own.value;
    }
    // Shared global lexical environment preserving top-level `let`, `const`, and `class`
    // bindings across classic scripts executed via separate indirect `eval` calls (`set === null`
    // indicates `const`; `get === null` indicates TDZ before initialization).
    const zpLex = newMap();
    // Active lexical environment (`zpLex` for top-level scripts, or a disposable Map inside `eval`).
    var __zp_lex_env = null;
    __zp_lex_env = zpLex;
    function zpLexGetEntry(prop) {
      return typeof prop === 'string' ? zpLex.get(prop) : undefined;
    }
    function zpLexRead(e, prop) {
      if (!e.get) throw new ReferenceError(`Cannot access '${prop}' before initialization`);
      return e.get();
    }
    function zpLexWrite(e, prop, value) {
      if (!e.set) throw new TypeError('Assignment to constant variable.');
      e.set(value);
      return value;
    }
    function scopeGet(prop, hide) {
      if (prop === Symbol.unscopables) return undefined;
      if (prop === 'document') return document;
      if (hide && typeof prop === 'string' && (prop.charCodeAt(0) === 95 || prop.charCodeAt(0) === 90) && ZP_HIDDEN_RE.test(prop)) return undefined;
      if (typeof prop === 'string' && PAGE_DEFINABLE.has(prop)) { const v = pageDefinedMember(prop); if (v !== NO_PAGE_DEFINITION) return v; }
      if (prop === 'window' || prop === 'self' || prop === 'globalThis' || prop === 'frames') return scope;
      if (prop === 'top' || prop === 'parent' || prop === 'opener') return virtualWindowProperty(root, prop);
      if (prop === 'frameElement') return virtualFrameElement(root);
      if (prop === 'location') {
        return wrappedLocationFor(root.location);
      }
      if (prop === 'postMessage') return postMessageWrapperFor(root);
      if (prop === 'name') return virtualWindowNameFor(root);
      const dynamic = typeof prop === 'symbol' ? null : dynamicGlobal(String(prop));
      if (dynamic) return dynamic;
      // Invoke page-installed own accessors and prototype accessors with `scope` as `this`
      // so `this.location` inside the getter is virtualized; native boot accessors read from `root`.
      const own = nativeReflectGOPD(root, prop);
      if (isPageInstalledAccessor(prop, own) || (!own && isPrototypeAccessor(prop))) return nativeReflectGet(root, prop, scope);
      const value = root[prop];
      if (WINDOW_BOUND_METHODS.has(prop) || needsWindowReceiver(value)) return boundWindowMethod(root, prop);
      // Wrap named child frame windows accessed via `window[name]` or bare identifiers,
      // which exist as non-own properties on the Window.
      if (!own && typeof prop === 'string' && value !== null && typeof value === 'object') {
        let isWindow = false;
        try { isWindow = value.window === value; } catch {}
        if (isWindow) return windowHandleFor(value);
      }
      return value;
    }
    const scopeTraps = Object.assign(Object.create(null), {
      has(_target, prop) {
        if (prop === Symbol.unscopables) return false;
        // Hide `__zp_*` and `ZP*` runtime internals from `'prop' in window` checks.
        if (typeof prop === 'string' && ZP_HIDDEN_RE.test(prop)) return false;
        return nativeReflectHas(root, prop);
      },
      get(_target, prop) { return scopeGet(prop, true); },
      set(_target, prop, value) {
        if (prop === 'location') { setVirtualLocation(value); return true; }
        // Ignore writes to reserved `__zp_*` helper names on the window facade.
        if (typeof prop === 'string' && ZP_RESERVED_NAME_RE.test(prop)) return true;
        if (prop === 'name') { setVirtualWindowName(root, value); return true; }
        // Run page-installed and prototype accessor setters with `scope` as `this`.
        const own = nativeReflectGOPD(root, prop);
        if (isPageInstalledAccessor(prop, own) || (!own && isPrototypeAccessor(prop))) {
          return nativeReflectSet(root, prop, value, scope);
        }
        return nativeReflectSet(root, prop, value);
      },
      getOwnPropertyDescriptor(target, prop) {
        if (prop === 'location') return nativeReflectGOPD(target, prop);
        if (typeof prop === 'string' && ZP_HIDDEN_RE.test(prop)) return undefined;
        if (typeof prop === 'string' && MEMBER_DANGER.has(prop) && !(PAGE_DEFINABLE.has(prop) && pageDefined(prop))) {
          // Mirror non-configurable (`[LegacyUnforgeable]`) descriptors onto `target` before
          // returning them so Proxy descriptor invariants hold during `Object.keys(window)`.
          const locked = nativeReflectGOPD(target, prop);
          if (locked) return locked;
          const native = nativeReflectGOPD(root, prop);
          const d = {
            get: membraneGetter(scope, prop),
            // Omit `set` for natively read-only attributes (`frameElement`, `history`, `top`, `window`, `document`).
            set: native && !native.set ? undefined : membraneSetter(scope, prop),
            enumerable: native ? native.enumerable : true,
            configurable: native ? native.configurable : false,
          };
          if (!d.configurable) nativeReflectDefineProperty(target, prop, d);
          return d;
        }
        const desc = nativeReflectGOPD(root, prop);
        // Mirror non-configurable descriptors onto `target` to satisfy Proxy invariants.
        if (desc && !desc.configurable) nativeReflectDefineProperty(target, prop, desc);
        return desc;
      },
      ownKeys() { return nativeOwnKeys(root).filter(k => typeof k !== 'string' || !ZP_HIDDEN_RE.test(k)); },
      defineProperty(target, prop, desc) {
        if (prop === 'location') return nativeReflectDefineProperty(target, prop, desc);
        if (typeof prop === 'string' && ZP_RESERVED_NAME_RE.test(prop)) return false;
        if (!nativeReflectDefineProperty(root, prop, desc)) return false;
        const installed = nativeReflectGOPD(root, prop);
        if (installed && !installed.configurable) nativeReflectDefineProperty(target, prop, installed);
        return true;
      },
      deleteProperty(target, prop) {
        if (prop === 'location') return false;
        if (typeof prop === 'string' && ZP_RESERVED_NAME_RE.test(prop)) return true;
        if (!nativeReflectDeleteProperty(root, prop)) return false;
        return nativeReflectDeleteProperty(target, prop);
      },
      getPrototypeOf() { return nativeReflectGetPrototypeOf(root); },
      // Window is an immutable-prototype exotic object: `setPrototypeOf` succeeds only when
      // `proto` is already the current prototype, and returns `false` otherwise.
      setPrototypeOf(_target, proto) {
        return proto === nativeReflectGetPrototypeOf(root);
      },
      preventExtensions() { return false; }
    });
    // Page-facing proxy exposed as `window`, `globalThis`, `self`, and `frames`.
    const scope = new Proxy(scopeTarget, scopeTraps);
    // Operand proxy for `with(__zp_scope){...}`. `has` returns `true` for every identifier
    // so all names inside the block route through this proxy rather than escaping to the
    // physical global scope (`get` still returns `scope` for `window`/`globalThis`/`self`/`frames`).
    const withScope = new Proxy(scopeTarget, Object.assign(Object.create(null), scopeTraps, {
      has(_target, prop) { return prop !== Symbol.unscopables; },
      // Expose `__zp_*` helpers inside `with` bodies and check global lexical bindings (`zpLex`)
      // before global object properties.
      get(_target, prop) {
        const le = zpLexGetEntry(prop);
        if (le) return zpLexRead(le, prop);
        return scopeGet(prop, false);
      },
      set(_target, prop, value) {
        const le = zpLexGetEntry(prop);
        if (le) { zpLexWrite(le, prop, value); return true; }
        return scopeTraps.set(_target, prop, value);
      },
    }));
    function isScopeProxy(value) { return value === scope || value === withScope; }
    // Property names mediated by the membrane during `Reflect.get`, `Reflect.set`, and descriptor lookups.
    const MEMBER_DANGER = newSet([
      'location', 'contentWindow', 'contentDocument', 'defaultView',
      'frameElement', 'parent', 'top', 'opener', 'frames',
      'href', 'protocol', 'host', 'hostname', 'port', 'pathname',
      'search', 'hash', 'origin',
      'window', 'document', 'history', 'self', 'globalThis', 'navigation',
      'assign', 'replace', 'open', 'postMessage', 'pushState', 'replaceState'
    ]);
    function isWindowLike(value) {
      try { return value === root || value === scope || value === withScope || value && value.window === value; } catch { return false; }
    }
    function crossOriginHandle(base) {
      if (crossOriginFacadeSet.has(base)) return base;
      if (base !== root && !isScopeProxy(base) && isWindowLike(base)) {
        const h = windowHandleFor(base);
        if (crossOriginFacadeSet.has(h)) return h;
      }
      return null;
    }
    // Check whether `value` is a genuine native `Location` instance. Filter by
    // `Object.prototype.toString` tag first to avoid throwing on ordinary objects,
    // then verify brand identity via the native `location.href` getter so
    // `Symbol.hasInstance` spoofing cannot bypass the check.
    const nativeObjToString = Object.prototype.toString;
    const knownLocations = newWeakSet();
    function isNativeLocation(value) {
      if (!value || typeof value !== 'object') return false;
      if (value === virtualLocation) return false;
      if (knownLocations.has(value)) return true;
      if (wrappedLocationProxies.has(value)) return false;
      let tag;
      try { tag = nativeObjToString.call(value); } catch { return false; }
      if (tag !== '[object Location]') return false;
      const d = Native.locationHref;
      if (!d || !d.get) return false;
      try { d.get.call(value); knownLocations.add(value); return true; } catch { return false; }
    }
    // Throw a native-matching `TypeError` when a property or key operation is performed
    // on a `null` or `undefined` receiver. Execute the failing operation inside an `eval`
    // helper tagged with `virtualURL.href` so `ErrorEvent.filename` reports the virtual
    // document URL rather than the prelude asset.
    let nullishOps = null;
    function nullishFail(op, base, prop) {
      try {
        const diag = root.__zp_diagnostics;
        if (diag && diag.length < 200) diag.push({ t: 'nullish', op, base: String(base), prop: typeof prop === 'symbol' ? 'symbol' : String(prop).slice(0, 40) });
      } catch {}
      if (nullishOps === null) {
        try {
          nullishOps = Native.globalEval(ttScript('({ get: (b, p) => b[p], set: (b, p) => { b[p] = 0; }, has: (b, p) => Reflect.has(b, p), rget: (b, p) => Reflect.get(b, p), rset: (b, p) => Reflect.set(b, p, 0), del: (b, p) => delete b[p], keys: b => Object.keys(b), own: b => Reflect.ownKeys(b) })\n//# sourceURL=' + virtualURL.href));
        } catch { nullishOps = false; }
      }
      if (nullishOps && nullishOps[op]) nullishOps[op](base, prop);
      // Fallback if the eval helper is unavailable.
      throw new TypeError(op === 'set' ? "Cannot set properties of " + base + " (setting '" + String(prop) + "')"
        : op === 'get' ? "Cannot read properties of " + base + " (reading '" + String(prop) + "')"
        : op === 'has' || op === 'rget' || op === 'rset' || op === 'own' ? 'Reflect.' + (op === 'own' ? 'ownKeys' : op === 'has' ? 'has' : op.slice(1)) + ' called on non-object'
        : "Cannot convert undefined or null to object");
    }
    // `Reflect.*` requires an object target (throwing on primitives), whereas `Object.*` throws only on nullish values.
    function isObjectLike(v) { return (typeof v === 'object' && v !== null) || typeof v === 'function'; }
    // Check whether a property access targets `Error.prepareStackTrace`.
    const isStackHook = (base, prop) => prop === 'prepareStackTrace' && base === pageStackHook.ctor && base != null;
    // Fast path for non-DOM data carriers (strings, functions, arrays, typed arrays, and plain objects),
    // which are never Window, Document, Location, or cross-window facade instances.
    // Capture `Array.isArray` and `ArrayBuffer.isView` at boot so page overrides cannot spoof the check.
    const nativeIsArray = Array.isArray, nativeIsView = ArrayBuffer.isView;
    // Identify plain objects (whose prototype is `Object.prototype` or `null` and which are not
    // cross-window facades or Window-like objects) for the property-access fast path.
    const BOOT_OBJECT_PROTO = Object.prototype, nativeGetPrototypeOf = Object.getPrototypeOf;
    function isPlainData(base) {
      if (typeof base !== 'object' || base === null) return false;
      let proto;
      try { proto = nativeGetPrototypeOf(base); } catch { return false; }
      if ((proto !== BOOT_OBJECT_PROTO && proto !== null) || crossWindowTargets.has(base)) return false;
      try { return base.window !== base; } catch { return false; }
    }
    function fastDataBase(base) {
      return typeof base === 'string' || typeof base === 'function' || nativeIsArray(base) || nativeIsView(base) || isPlainData(base);
    }
    // Fast path for writes to arrays, typed arrays, and plain objects on non-mediated keys.
    function fastSet(base, prop) {
      return base != null && (nativeIsArray(base) || nativeIsView(base) || isPlainData(base))
        && (typeof prop === 'number' || (typeof prop === 'string' && prop !== 'location' && prop !== 'name'));
    }
    function fastDataKey(prop) {
      return typeof prop === 'number' || (typeof prop === 'string' && prop !== 'constructor' && prop !== 'prepareStackTrace'
        && prop !== 'postMessage' && prop !== 'location');
    }
    function get(base, prop) {
      if (base != null && fastDataKey(prop) && fastDataBase(base)) return base[prop];
      // Fast-path `window.document` reads when no direct-eval local scope (`__zp_eval_desc`) is active.
      if (prop === 'document' && __zp_eval_desc === null && (base === root || base === scope || base === withScope)) return document;
      if (base == null) return nullishFail('get', base, prop);
      if (typeof prop !== 'symbol') prop = String(prop);
      if (isStackHook(base, prop)) return pageStackHook.value;
      // Return virtual URL components when `base` is a raw native `Location` instance
      // so unforgeable native accessors cannot expose the physical proxy URL.
      if (typeof prop === 'string' && LOC_ALL_URL_PROPS.has(prop) && isNativeLocation(base)) return virtualURL[prop];
      // Wrap `document.location` and child/DOMParser document `location` values via `wrappedLocationFor`
      // to prevent physical proxy URL leaks and unproxied navigations.
      if (prop === 'location' && isDocumentLike(base)) {
        // Preserve the `window.location === document.location` identity invariant via `wrappedLocationFor`.
        if (base === document) return wrappedLocationFor(root.location);
        try { const loc = Reflect.get(base, 'location'); return loc ? wrappedLocationFor(loc) : loc; } catch { return virtualLocation; }
      }
      if (base === document && (prop === 'URL' || prop === 'documentURI')) return virtualURL.href;
      if (base === document && prop === 'baseURI') return baseURL;
      if (base === document && prop === 'referrer') return virtualReferrer();
      if (isWindowLike(base)) {
        // Enforce HTML cross-origin window access rules for windows from another virtual origin.
        const cross = crossOriginHandle(base);
        if (cross) return nativeReflectGet(cross, prop);
        // During direct `eval`, check the caller's local scope (`__zp_eval_desc`) before the global object.
        {
          const d = __zp_eval_desc;
          if (d && (base === root || isScopeProxy(base)) && typeof prop === 'string'
              && nativeHasOwn.call(d, prop)) return d[prop];
        }
        // Bare identifier reads (`base === root`) check the shared global lexical environment (`zpLex`)
        // before global object properties (explicit member reads like `window.x` pass `base === scope`).
        if (base === root) {
          const le = zpLexGetEntry(prop);
          if (le) return zpLexRead(le, prop);
        }
        if ((base === root || isScopeProxy(base)) && typeof prop === 'string' && PAGE_DEFINABLE.has(prop)) { const v = pageDefinedMember(prop); if (v !== NO_PAGE_DEFINITION) return v; }
        if (prop === 'window' || prop === 'self' || prop === 'globalThis' || prop === 'frames') return isScopeProxy(base) || base === root ? scope : windowHandleFor(base);
        if (prop === 'top' || prop === 'parent' || prop === 'opener') return virtualWindowProperty(crossWindowTargets.get(base) || (isScopeProxy(base) ? root : base), prop);
        if (prop === 'location') {
          const baseWin = crossWindowTargets.get(base) || (isScopeProxy(base) ? root : base);
          if (baseWin !== root) return crossWindowLocation(baseWin);
          try { const n = baseWin.location; return n ? wrappedLocationFor(n) : virtualLocation; } catch { return virtualLocation; }
        }
        if (prop === 'postMessage') return postMessageWrapperFor(crossWindowTargets.get(base) || (isScopeProxy(base) ? root : base));
        if (prop === 'navigation') return virtualNavigationFor(crossWindowTargets.get(base) || (isScopeProxy(base) ? root : base));
        if (prop === 'name') return virtualWindowNameFor(crossWindowTargets.get(base) || (isScopeProxy(base) ? root : base));
        if (prop === 'frameElement') return virtualFrameElement(crossWindowTargets.get(base) || (isScopeProxy(base) ? root : base));
        const dynamic = dynamicGlobal(prop);
        if (dynamic) {
          // Return a same-origin child window's own `eval` or `Function` wrapper so code compiled
          // through it executes in the child's realm rather than the parent's.
          if ((prop === 'eval' || prop === 'Function') && typeof prop === 'string') {
            const owner = crossWindowTargets.get(base) || (isScopeProxy(base) ? root : base);
            if (owner !== root) {
              containSameOriginChildWindow(owner);
              if (ownsMembrane(owner) || owner[networkContainmentMarker] || owner.__zp_early_natives) {
                try { const own = nativeReflectGet(owner, prop); if (typeof own === 'function') return own; } catch {}
              }
            }
          }
          return dynamic;
        }
      }
      if (prop === 'defaultView' && isDocumentLike(base)) {
        if (base === document) return scope;
        try { const v = nativeReflectGet(base, 'defaultView'); return v ? windowHandleFor(v) : v; } catch { return null; }
      }
      if (prop === 'postMessage') {
        const fn = nativeReflectGet(Object(base), prop);
        if (typeof fn === 'function') {
          const bound = fn.bind(base);
          maskNativeFunction(bound, prop);
          return bound;
        }
        return fn;
      }
      if (prop === 'constructor') {
        const ctor = nativeReflectGet(Object(base), prop);
        return dynamicWrapperFor(ctor) || ctor;
      }
      // Forward own expando property reads on a same-origin cross-window facade,
      // excluding prototype builtins (`eval`, `Function`, `fetch`), `__zp_*` names, and `MEMBER_DANGER`.
      {
        const crossWin = crossWindowTargets.get(base);
        if (crossWin && (typeof prop !== 'string' || (!ZP_HIDDEN_RE.test(prop) && !MEMBER_DANGER.has(prop)))) {
          try {
            if (nativeReflectGOPD(crossWin, prop)) return nativeReflectGet(crossWin, prop);
          } catch {}
        }
      }
      const value = nativeReflectGet(Object(base), prop);
      // Wrap child windows accessed via `frames[i]`, `window[i]`, or named frame properties.
      if (value !== null && typeof value === 'object' && value !== base && isWindowLike(base)) {
        let isWindow = false;
        try { isWindow = value.window === value; } catch {}
        if (isWindow) return windowHandleFor(value);
      }
      return value;
    }
    function set(base, prop, value) {
      // Fast path for writes to arrays, typed arrays, and plain objects.
      if (fastSet(base, prop)) {
        nativeReflectSet(base, prop, value);
        return value;
      }
      if (base == null) return nullishFail('set', base, prop);
      if (typeof prop !== 'symbol') prop = String(prop);
      // Cross-origin windows permit `location` navigation writes and reject all other writes.
      const cross = crossOriginHandle(base);
      if (cross) { nativeReflectSet(cross, prop, value); return value; }
      // During direct `eval`, write to matching caller local bindings (`__zp_eval_desc`) first.
      {
        const d = __zp_eval_desc;
        if (d && (base === root || isScopeProxy(base)) && typeof prop === 'string'
            && nativeHasOwn.call(d, prop)) { d[prop] = value; return value; }
      }
      // Bare identifier assignments update matching global lexical bindings (`zpLex`) before the global object.
      if (base === root) {
        const le = zpLexGetEntry(prop);
        if (le) return zpLexWrite(le, prop, value);
      }
      if (prop === 'location' && isWindowLike(base) && !isScopeProxy(base) && base !== root) {
        crossWindowLocation(crossWindowTargets.get(base) || base).href = value;
        return value;
      }
      if (prop === 'name' && isWindowLike(base)) {
        setVirtualWindowName(crossWindowTargets.get(base) || (isScopeProxy(base) ? root : base), value);
        return value;
      }
      // Forward `doc.location = url` on non-root documents through `wrappedLocationFor` (`[PutForwards=href]`).
      if (prop === 'location' && isDocumentLike(base) && base !== document) {
        try { const loc = nativeReflectGet(base, 'location'); if (loc) wrappedLocationFor(loc).href = value; } catch {}
        return value;
      }
      if (((isWindowLike(base) || base === document) && prop === 'location') || (base === virtualLocation && prop === 'href')) { setVirtualLocation(value); return value; }
      if (base === virtualLocation && prop === 'hash') { updateVirtualHash(value); return value; }
      // Forward safe expando writes on a same-origin cross-window facade to the underlying window,
      // excluding `__zp_*` names, `MEMBER_DANGER` properties, and string `on*` handlers.
      {
        const crossWin = crossWindowTargets.get(base);
        if (crossWin && (typeof prop !== 'string'
            || (!ZP_HIDDEN_RE.test(prop) && !MEMBER_DANGER.has(prop)
                && !(prop.startsWith('on') && typeof value === 'string')))) {
          try { nativeReflectSet(crossWin, prop, value); } catch {}
          return value;
        }
      }
      nativeReflectSet(Object(base), prop, value);
      return value;
    }
    function assign(base, prop, operator, value) {
      if (typeof prop !== 'symbol') prop = String(prop);
      const current = get(base, prop);
      // `value` is a lazy thunk (`() => rhs`) evaluated only after reading `current`,
      // preserving native evaluation order and logical assignment short-circuiting.
      let next;
      switch (operator) {
        case '+=': next = current + value(); break;
        case '-=': next = current - value(); break;
        case '*=': next = current * value(); break;
        case '/=': next = current / value(); break;
        case '%=': next = current % value(); break;
        case '**=': next = current ** value(); break;
        case '<<=': next = current << value(); break;
        case '>>=': next = current >> value(); break;
        case '>>>=': next = current >>> value(); break;
        case '&=': next = current & value(); break;
        case '^=': next = current ^ value(); break;
        case '|=': next = current | value(); break;
        case '&&=': if (!current) return current; next = value(); break;
        case '||=': if (current) return current; next = value(); break;
        case '??=': if (current !== null && current !== undefined) return current; next = value(); break;
        default: throw normalizedError('NotSupportedError');
      }
      return set(base, prop, next);
    }
    function update(base, prop, operator, prefix) {
      if (typeof prop !== 'symbol') prop = String(prop);
      const current = get(base, prop);
      const next = operator === '++' ? current + 1 : current - 1;
      set(base, prop, next);
      return prefix ? next : current;
    }
    function call(base, prop, args) {
      const fn = get(base, prop);
      return nativeApply(fn, isScopeProxy(base) ? root : base, Array.isArray(args) ? args : []);
    }
    function construct(ctor, args) {
      const dynamic = dynamicWrapperFor(ctor);
      return nativeReflectConstruct(dynamic || ctor, Array.isArray(args) ? args : []);
    }
    function has(base, prop) {
      if (!isObjectLike(base)) return nullishFail('has', base, prop);
      const cross = crossOriginHandle(base);
      if (cross) return nativeReflectHas(cross, prop);
      const d = __zp_eval_desc;
      if (d && (base === root || isScopeProxy(base)) && typeof prop === 'string'
          && nativeHasOwn.call(d, prop)) return true;
      if ((isWindowLike(base) || isDocumentLike(base)) && prop === 'location') return true;
      if (isStackHook(base, prop)) return pageStackHook.exists;
      return nativeReflectHas(Object(base), prop);
    }
    // Check `nodeType === 9` to match Document instances across realms where `instanceof Document` would fail.
    function isDocumentLike(base) {
      try { return !!base && base.nodeType === 9 && typeof base.implementation === 'object'; } catch { return false; }
    }
    // Identify objects whose `MEMBER_DANGER` properties are virtualized by the membrane
    // (windows, documents, Locations, and frame host elements).
    function dangerousBase(base) {
      try {
        return isWindowLike(base) || isDocumentLike(base) || isScopeProxy(base)
          || isNativeLocation(base) || base === virtualLocation
          || (typeof HTMLIFrameElement === 'function' && base instanceof HTMLIFrameElement)
          || (typeof HTMLFrameElement === 'function' && base instanceof HTMLFrameElement)
          || (typeof HTMLObjectElement === 'function' && base instanceof HTMLObjectElement)
          || (typeof HTMLEmbedElement === 'function' && base instanceof HTMLEmbedElement);
      } catch { return false; }
    }
    // Build masked getter and setter functions that route through the membrane for virtualized descriptors.
    function membraneGetter(base, prop) {
      const g = function () { return get(base, prop); };
      nativeReflectDefineProperty(g, 'name', { value: 'get ' + String(prop), configurable: true });
      maskAccessorFn(g, 'get', prop);
      return g;
    }
    function membraneSetter(base, prop) {
      const s = function (v) { set(base, prop, v); };
      nativeReflectDefineProperty(s, 'name', { value: 'set ' + String(prop), configurable: true });
      maskAccessorFn(s, 'set', prop);
      return s;
    }
    function getOwnPropertyDescriptor(base, prop) {
      if (base == null) return nullishFail('keys', base, prop);
      const cross = crossOriginHandle(base);
      if (cross) return nativeReflectGOPD(cross, prop);
      // Present `Error.prepareStackTrace` as a standard data descriptor when assigned by page code.
      if (isStackHook(base, prop)) {
        return pageStackHook.exists ? { value: pageStackHook.value, writable: true, enumerable: true, configurable: true } : undefined;
      }
      // Return membrane wrapper accessor descriptors for `MEMBER_DANGER` properties so callers
      // cannot extract and invoke raw native getters via `Object.getOwnPropertyDescriptor`.
      if (typeof prop === 'string' && MEMBER_DANGER.has(prop) && dangerousBase(base)) {
        if (prop === 'location' && (base === root || isScopeProxy(base))) {
          return nativeReflectGOPD(scopeTarget, prop);
        }
        if ((base === root || isScopeProxy(base)) && PAGE_DEFINABLE.has(prop)) { const own = pageDefined(prop); if (own) return own; }
        const receiver = crossWindowTargets.get(base) || base;
        const native = nativeReflectGOPD(receiver, prop);
        return {
          get: membraneGetter(base, prop),
          set: native && !native.set ? undefined : membraneSetter(base, prop),
          enumerable: native ? native.enumerable : true,
          configurable: native ? native.configurable : false,
        };
      }
      return nativeReflectGOPD(Object(base), prop);
    }
    function ownKeys(base) {
      if (!isObjectLike(base)) return nullishFail('own', base);
      return nativeOwnKeys(crossOriginHandle(base) || Object(base));
    }
    function del(base, prop) {
      if (base == null) return nullishFail('del', base, prop);
      if (typeof prop !== 'symbol') prop = String(prop);
      const cross = crossOriginHandle(base);
      if (cross) return nativeReflectDeleteProperty(cross, prop);
      // `delete` on a caller local binding inside direct `eval` returns `false`.
      {
        const d = __zp_eval_desc;
        if (d && (base === root || isScopeProxy(base)) && typeof prop === 'string'
            && nativeHasOwn.call(d, prop)) { delete d[prop]; return false; }
      }
      // `window.location` and `document.location` are unforgeable and cannot be deleted.
      if (prop === 'location' && (isWindowLike(base) || isDocumentLike(base))) return false;
      // Deleting `Error.prepareStackTrace` clears the page's hook while keeping the stack sanitizer active.
      if (isStackHook(base, prop)) { pageStackHook.forget(); return true; }
      return nativeReflectDeleteProperty(Object(base), prop);
    }
    function odel(base, prop) { return base == null ? true : del(base, prop); }
    function oget(base, prop) { return base == null ? undefined : get(base, prop); }
    // Optional call helper (`x?.m()`, `x?.m?.()`, `x.m?.()`). `flags` encodes `(baseOpt << 1) | callOpt`
    // so `base` and `fn` are evaluated once while preserving `TypeError` when `base` is non-optional and nullish.
    function ocall(base, prop, args, flags) {
      if (base == null) {
        if (flags & 2) return undefined;
        throw new TypeError("Cannot read properties of " + base + " (reading '" + String(prop) + "')");
      }
      const fn = get(base, prop);
      if (fn == null && (flags & 1)) return undefined;
      return nativeApply(fn, isScopeProxy(base) ? root : base, Array.isArray(args) ? args : []);
    }
    // Short-circuit optional chaining helper (`a?.[k].b`) when `base` is nullish.
    function ochain(base, cont) { return base == null ? undefined : cont(base); }
    // Optional method call helper (`obj.m?.(...)`): look up the method once, bind `obj`, and short-circuit to `undefined` if nullish.
    function ocallv(base, prop) {
      if (base == null) throw new TypeError("Cannot read properties of " + base + " (reading '" + String(prop) + "')");
      const fn = get(base, prop);
      if (fn == null) return undefined;
      const self = isScopeProxy(base) ? root : base;
      return function () { return nativeApply(fn, self, arguments); };
    }
    // Route `Reflect.get` and `Reflect.set` through the membrane for `MEMBER_DANGER` properties,
    // while forwarding other properties to native `Reflect` with the caller's `receiver`.
    function rget(target, prop, receiver) {
      if (!isObjectLike(target)) return nullishFail('rget', target, prop);
      if (typeof prop !== 'symbol') prop = String(prop);
      const cross = crossOriginHandle(target);
      if (cross) return nativeReflectGet(cross, prop);
      if (MEMBER_DANGER.has(prop) || isStackHook(target, prop)) return get(target, prop);
      return nativeReflectGet(Object(target), prop, receiver === undefined ? target : receiver);
    }
    function rset(target, prop, value, receiver) {
      if (!isObjectLike(target)) return nullishFail('rset', target, prop);
      if (typeof prop !== 'symbol') prop = String(prop);
      const cross = crossOriginHandle(target);
      if (cross) return nativeReflectSet(cross, prop, value);
      if (MEMBER_DANGER.has(prop)) { set(target, prop, value); return true; }
      return nativeReflectSet(Object(target), prop, value, receiver === undefined ? target : receiver);
    }
    function getOwnPropertyDescriptors(base) {
      if (base == null) return nullishFail('keys', base);
      const target = crossOriginHandle(base) || base;
      const out = {};
      for (const k of nativeOwnKeys(Object(target))) {
        const d = getOwnPropertyDescriptor(target, k);
        if (d !== undefined) out[k] = d;
      }
      return out;
    }
    // Delegate to the patched `Object.getOwnPropertyNames` so `__zp_*` filtering on global objects is preserved.
    function getOwnPropertyNames(base) { if (base == null) return nullishFail('keys', base); return Object.getOwnPropertyNames(crossOriginHandle(base) || Object(base)); }
    function okeys(base) { if (base == null) return nullishFail('keys', base); return Object.keys(crossOriginHandle(base) || Object(base)); }
    // Resolve identifiers inside `with(obj)` blocks: properties on `obj` take precedence over
    // the outer scope thunk `fb` unless hidden by `Symbol.unscopables`.
    function unscopablesHidden(obj, prop) {
      const uns = obj == null ? null : obj[Symbol.unscopables];
      return uns != null && !!uns[prop];
    }
    function scopeHas(obj, prop) {
      return obj != null && prop in Object(obj) && !unscopablesHidden(obj, prop);
    }
    // Route `MEMBER_DANGER` property accesses on `with` target objects through the membrane
    // so `with(document){ location }` does not expose the raw native `Location`.
    function withGet(obj, prop, fb) {
      if (!scopeHas(obj, prop)) return fb();
      if (typeof prop === 'string' && MEMBER_DANGER.has(prop) && dangerousBase(obj)) return get(obj, prop);
      return obj[prop];
    }
    function withSet(obj, prop, value, fb) {
      if (scopeHas(obj, prop)) {
        if (typeof prop === 'string' && MEMBER_DANGER.has(prop) && dangerousBase(obj)) set(obj, prop, value);
        else obj[prop] = value;
        return value;
      }
      return fb(value);
    }
    function withAssign(obj, prop, op, value, fb) {
      if (scopeHas(obj, prop)) return assign(obj, prop, op, value);
      return fb();
    }
    function withUpdate(obj, prop, op, prefix, fb) {
      if (scopeHas(obj, prop)) return update(obj, prop, op, prefix);
      return fb();
    }
    function withDelete(obj, prop, fb) {
      if (scopeHas(obj, prop)) return del(obj, prop);
      return fb();
    }
    // Return an `{ v }` accessor target for destructuring and complex assignments inside `with` blocks.
    function withD(obj, prop, sink) {
      const viaMembrane = typeof prop === 'string' && MEMBER_DANGER.has(prop) && dangerousBase(obj);
      return {
        get v() { if (!scopeHas(obj, prop)) return sink[prop]; return viaMembrane ? get(obj, prop) : obj[prop]; },
        set v(x) { if (scopeHas(obj, prop)) { if (viaMembrane) set(obj, prop, x); else obj[prop] = x; } else sink[prop] = x; }
      };
    }
    // Wrap legacy `Object.prototype.__lookupGetter__`, `__lookupSetter__`, `__defineGetter__`,
    // and `__defineSetter__` so `MEMBER_DANGER` properties on membrane bases cannot extract
    // raw unforgeable native accessors or bypass the window facade.
    const nativeLookupGetter = Object.prototype.__lookupGetter__;
    const nativeLookupSetter = Object.prototype.__lookupSetter__;
    const nativeDefineGetter = Object.prototype.__defineGetter__;
    const nativeDefineSetter = Object.prototype.__defineSetter__;
    if (nativeLookupGetter) {
      defineMasked(Object.prototype, '__lookupGetter__', {
        value: function __lookupGetter__(prop) {
          if (typeof prop === 'string' && MEMBER_DANGER.has(prop) && dangerousBase(this)) {
            return membraneGetter(this, prop);
          }
          return nativeLookupGetter.call(this, prop);
        },
        writable: true, enumerable: false, configurable: true
      });
    }
    if (nativeLookupSetter) {
      defineMasked(Object.prototype, '__lookupSetter__', {
        value: function __lookupSetter__(prop) {
          if (typeof prop === 'string' && MEMBER_DANGER.has(prop) && dangerousBase(this)) {
            return membraneSetter(this, prop);
          }
          return nativeLookupSetter.call(this, prop);
        },
        writable: true, enumerable: false, configurable: true
      });
    }
    // Route `__defineGetter__` and `__defineSetter__` on the window facade to `root` so
    // page-defined accessors are observable on `window` while unforgeable properties still throw `TypeError`.
    if (nativeDefineGetter) {
      defineMasked(Object.prototype, '__defineGetter__', {
        value: function __defineGetter__(prop, fn) {
          if (typeof fn !== 'function') return nativeDefineGetter.call(this, prop, fn);
          const host = isScopeProxy(this) || this === root ? root : this;
          if (typeof prop === 'string' && MEMBER_DANGER.has(prop) && dangerousBase(this)) {
            if (!Reflect.defineProperty(host, prop, { get: fn, enumerable: true, configurable: true })) {
              throw normalizedError('TypeError');
            }
            return undefined;
          }
          return nativeDefineGetter.call(this, prop, fn);
        },
        writable: true, enumerable: false, configurable: true
      });
    }
    if (nativeDefineSetter) {
      defineMasked(Object.prototype, '__defineSetter__', {
        value: function __defineSetter__(prop, fn) {
          if (typeof fn !== 'function') return nativeDefineSetter.call(this, prop, fn);
          const host = isScopeProxy(this) || this === root ? root : this;
          if (typeof prop === 'string' && MEMBER_DANGER.has(prop) && dangerousBase(this)) {
            if (!Reflect.defineProperty(host, prop, { set: fn, enumerable: true, configurable: true })) {
              throw normalizedError('TypeError');
            }
            return undefined;
          }
          return nativeDefineSetter.call(this, prop, fn);
        },
        writable: true, enumerable: false, configurable: true
      });
    }
    function moduleURL(specifier, referrer) {
      const spec = String(specifier);
      if (!spec.startsWith('/') && !spec.startsWith('./') && !spec.startsWith('../') && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec)) throw normalizedError('TypeError');
      const u = new URL(spec, referrer || baseURL);
      if (u.protocol === 'data:' || u.protocol === 'blob:') return virtualModuleURL(u);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw normalizedError('NotSupportedError');
      return scriptProxyPath(u.href, 'module');
    }
    // Handle dynamic `import('data:...')` and `import('blob:...')` module specifiers by decoding
    // `data:` URLs synchronously or reading same-origin `blob:` URLs via synchronous XHR, rewriting
    // the module source through the current realm's rewriter, and returning a new `blob:` URL.
    function virtualModuleURL(u) {
      let src;
      try {
        if (u.protocol === 'data:') {
          const href = u.href;
          const comma = href.indexOf(',');
          if (comma < 0) throw 0;
          const meta = href.slice(5, comma), dataStr = href.slice(comma + 1);
          if (/;base64/i.test(meta)) {
            const bin = atob(dataStr);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            src = new TextDecoder().decode(bytes);
          } else {
            src = decodeURIComponent(dataStr);
          }
        } else {
          const nx = new Native.XMLHttpRequest();
          nx.open('GET', u.href, false);
          nx.send();
          if (nx.status !== 200 && nx.status !== 0) throw 0;
          src = nx.responseText;
        }
      } catch { throw normalizedError('NotSupportedError'); }
      if (typeof src !== 'string' || !src.length) throw normalizedError('NotSupportedError');
      let code;
      try { code = callPageRewriter(src, 'module'); } catch (e) { throw normalizedError('NotSupportedError'); }
      const blob = new Blob([code], { type: 'text/javascript' });
      return (Native.createObjectURL || URL.createObjectURL).call(URL, blob);
    }
    define(root, '__zp_get', get);
    // Fast-path predicates called by inline rewriter guards (`zp-rewriter` `guard_claim`).
    define(root, '__zp_fast', (base, prop) => base != null && fastDataKey(prop) && fastDataBase(base));
    define(root, '__zp_fastset', fastSet);
    define(root, '__zp_set', set);
    // Expose this document's virtual security origin to its embedder and child frames.
    define(root, '__zp_origin', function () { return securityOrigin(); });
    // Expose this document's virtual URL to child frames for `document.referrer`.
    define(root, '__zp_url', function () { return virtualURL.href; });
    // Report whether a child frame element is marked opaque (`OPAQUE_FRAME_ATTR`).
    define(root, '__zp_frame_opaque', function (frame) { try { return frameHasOpaqueMark(frame); } catch { return false; } });
    // Write-only sink (`__zp_get.d`) for destructuring assignment targets such as `({ location } = obj)`.
    // Destructuring requires a valid assignment target expression rather than a function call, so the
    // rewriter emits `__zp_get.d.<prop>`, whose `set` trap forwards to the membrane setter while all
    // read and inspection traps return inert defaults.
    try {
      const globalWriteSink = new Proxy(Object.create(null), {
        get() { return undefined; },
        set(_target, prop, value) { set(root, prop, value); return true; },
        has() { return false; },
        ownKeys() { return []; },
        getOwnPropertyDescriptor() { return undefined; },
        getPrototypeOf() { return null; },
        defineProperty() { return false; },
        deleteProperty() { return true; }
      });
      Object.defineProperty(get, 'd', {
        value: globalWriteSink,
        writable: false,
        enumerable: false,
        configurable: false
      });
    } catch {}
    define(root, '__zp_assign', assign);
    define(root, '__zp_call', call);
    define(root, '__zp_update', update);
    define(root, '__zp_construct', construct);
    define(root, '__zp_has', has);
    define(root, '__zp_getOwnPropertyDescriptor', getOwnPropertyDescriptor);
    define(root, '__zp_ownKeys', ownKeys);
    define(root, '__zp_module_url', moduleURL);
    define(root, '__zp_delete', del);
    define(root, '__zp_odelete', odel);
    define(root, '__zp_oget', oget);
    define(root, '__zp_ocall', ocall);
    define(root, '__zp_ochain', ochain);
    define(root, '__zp_ocallv', ocallv);
    define(root, '__zp_rget', rget);
    define(root, '__zp_rset', rset);
    define(root, '__zp_getOwnPropertyDescriptors', getOwnPropertyDescriptors);
    define(root, '__zp_getOwnPropertyNames', getOwnPropertyNames);
    define(root, '__zp_okeys', okeys);
    define(root, '__zp_with_get', withGet);
    // Coerce raw `root` (`this` in plain sloppy function calls) to the `scope` facade.
    define(root, '__zp_this', function (t) { return t === root ? scope : t; });
    define(root, '__zp_with_set', withSet);
    define(root, '__zp_with_assign', withAssign);
    define(root, '__zp_with_update', withUpdate);
    define(root, '__zp_with_delete', withDelete);
    define(root, '__zp_with_d', withD);
    define(root, '__zp_nav_assign', v => setVirtualLocation(v));
    define(root, '__zp_nav_replace', v => setVirtualLocation(v, true));
    define(root, '__zp_runClassic', fn => fn.call(root, withScope));
    define(root, '__zp_runEvent', (selfValue, event, fn) => fn.call(selfValue, new Proxy(withScope, { get(t, p, r) { if (p === 'event') return event; return Reflect.get(t, p, r); } })));
    // Construct a `SyntaxError` for script parse failures inside an eval helper tagged with
    // `virtualURL.href` so uncaught syntax errors do not leak the prelude asset URL via
    // `ErrorEvent.filename`, while preserving `instanceof SyntaxError` for feature-detection code.
    function parseSyntaxError(message) {
      let err = null;
      try {
        const make = Native.globalEval(ttScript('(function (m) { return new SyntaxError(m); })\n//# sourceURL=' + virtualURL.href));
        err = make(String(message));
      } catch {}
      if (!err || typeof err !== 'object') err = normalizedError('NotSupportedError');
      parseErrors.add(err);
      return err;
    }
    // Cache rewritten script strings keyed by `(source, kind, virtualURL.href)` with bounded
    // entry count and total character size (evicting least-recently-used entries first).
    const rewriteCache = newMap();
    let rewriteCacheChars = 0;
    const REWRITE_CACHE_ENTRIES = 512, REWRITE_CACHE_CHARS = 32 << 20, REWRITE_CACHE_ONE = 8 << 20;
    // Strip leading and trailing whitespace on large scripts before invoking the WASM rewriter
    // and reattach it afterward to avoid copying megabytes of padding while preserving source offsets.
    function callPageRewriter(source, kind) {
      if (typeof source === 'string' && source.length > 65536) {
        const core = source.trimStart();
        const lead = source.length - core.length;
        const end = lead + core.trimEnd().length;
        if (lead + (source.length - end) > 4096) {
          return source.slice(0, lead) + rewriteCore(source.slice(lead, end), kind) + source.slice(end);
        }
      }
      return rewriteCore(source, kind);
    }
    function rewriteCore(source, kind) {
      if (!root.ZPBundle || !root.ZPBundle.ready || typeof root.ZPBundle.rewriteScript !== 'function') {
        throw normalizedError('NotSupportedError');
      }
      const href = virtualURL.href;
      const cacheable = typeof source === 'string' && source.length <= REWRITE_CACHE_ONE;
      if (cacheable) {
        const hit = rewriteCache.get(source);
        if (hit !== undefined && hit.kind === kind && hit.href === href) {
          rewriteCache.delete(source);
          rewriteCache.set(source, hit);
          return hit.out;
        }
      }
      let parseFailure = null;
      try {
        const out = root.ZPBundle.rewriteScript(source, kind, href);
        // Preserve empty-string rewrites (`eval('')` evaluates to `undefined`).
        if (typeof out === 'string' && (out.length > 0 || source === '')) {
          if (cacheable) {
            const old = rewriteCache.get(source);
            if (old !== undefined) rewriteCacheChars -= source.length + old.out.length;
            rewriteCache.delete(source);
            rewriteCache.set(source, { kind, href, out });
            rewriteCacheChars += source.length + out.length;
            for (const [k, v] of rewriteCache) {
              if (rewriteCache.size <= REWRITE_CACHE_ENTRIES && rewriteCacheChars <= REWRITE_CACHE_CHARS) break;
              rewriteCache.delete(k);
              rewriteCacheChars -= k.length + v.out.length;
            }
          }
          return out;
        }
      } catch (e) {
        const msg = String(e && e.message || '');
        if (msg.startsWith('parse failed:')) parseFailure = msg.slice('parse failed:'.length).trim();
      }
      if (parseFailure !== null) throw parseSyntaxError(parseFailure || 'Invalid or unexpected token');
      throw normalizedError('NotSupportedError');
    }
    function rewriteDynamicFunctionBody(params, body, kind) {
      const list = Array.isArray(params) ? params : [];
      // Wrap the body in a function matching `kind` so `await` or `yield` parses validly.
      const prefix = functionPrefix(kind) + ' __zp_dynamic__(' + list.map(value => String(value)).join(',') + '){\n';
      const suffix = '\n}';
      const wrapped = prefix + String(body || '') + suffix;
      const code = callPageRewriter(wrapped, 'classic');
      // The closing brace may follow temporary variable declarations appended by inline guards.
      if (!code.startsWith(prefix) || !code.endsWith('}')) {
        // Propagate reserved-name violations emitted by the rewriter as `SyntaxError`.
        const refused = /^throw new SyntaxError\("([^"]*)"\);$/.exec(code);
        if (refused) throw parseSyntaxError(refused[1]);
        throw normalizedError('NotSupportedError');
      }
      return code.slice(prefix.length, code.length - (code.endsWith(suffix) ? suffix.length : 1));
    }
    function rewriteWithPageRewriter(source, kind) {
      return callPageRewriter(String(source || ''), kind);
    }
    // Expose page rewriter hooks for `installNetworkContainment`.
    pageRewriteHooks = {
      rewrite: rewriteWithPageRewriter,
      decodeEntities: decodeInlineEntities
    };
    // Expose window handle helpers for frame accessors, `MessageEvent.source`, and popup hooks.
    windowHandles = {
      forWindow: (win, hint) => windowHandleFor(win, hint),
      isCrossOrigin: (win, hint) => { try { return crossOriginFacadeSet.has(windowHandleFor(win, hint)); } catch { return false; } },
      // Wrap a window about to navigate to a known target origin (such as a popup).
      forOrigin: (win, origin) => (origin && origin !== securityOrigin() ? crossOriginWindow(win) : windowHandleFor(win)),
      originOf: win => virtualOriginOfWindow(win),
    };
    // Decode HTML entities inside inline `<script>` bodies (such as `=&gt;` or `&amp;&amp;`
    // inserted via `dangerouslySetInnerHTML`) without altering external script string literals.
    function decodeInlineEntities(src) {
      const s = String(src || '');
      if (s.indexOf('&') < 0) return s;
      return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&nbsp;/g, ' ');
    }
    // Execute a classic script body with real *global* scope semantics.
    // Classic `<script>` top-level `var` and `function` declarations must bind on the global
    // object via indirect `eval`, while top-level `let`, `const`, and `class` declarations
    // register in the shared global lexical environment (`zpLex`, or a disposable Map inside `eval`).
    // `__zp_lex_decl` returns the first conflicting binding name so the rewritten script can
    // throw the `SyntaxError` from its own source URL rather than the prelude.
    define(root, '__zp_lex_decl', (lexMap, varNames) => {
      const env = __zp_lex_env || zpLex;
      for (const n of varNames) {
        // Check `var` declarations for conflicts with global `zpLex` and the active `eval` lexical environment.
        if (zpLex.has(n) || (env !== zpLex && env.has(n))) return n;
      }
      for (const n of Object.keys(lexMap)) {
        if (env.has(n) || varNames.includes(n)) return n;
        // Global lexical declarations (`env === zpLex`) also conflict with non-configurable global properties.
        if (env === zpLex) {
          const d = Reflect.getOwnPropertyDescriptor(root, n);
          if (d && !d.configurable) return n;
        }
      }
      for (const n of Object.keys(lexMap)) env.set(n, { kind: lexMap[n], get: null, set: null });
      return undefined;
    });
    define(root, '__zp_lex_bind', (name, get, set) => {
      const env = __zp_lex_env || zpLex;
      const e = env.get(name);
      if (e) { e.get = get; e.set = typeof set === 'function' ? set : null; }
    });
    // `with` environment for sloppy classic scripts: `has` claims only registered global
    // lexical bindings and named frame windows, passing all other names through to the global object.
    function namedFrameWindow(prop) {
      if (typeof prop !== 'string' || prop === '' || (prop.charCodeAt(0) === 95 || prop.charCodeAt(0) === 90) && ZP_HIDDEN_RE.test(prop)) return null;
      if (nativeReflectGOPD(root, prop) || !(prop in root) || isPrototypeAccessor(prop)) return null;
      try {
        const v = root[prop];
        if (v && typeof v === 'object' && v !== root && v.window === v) return windowHandleFor(v);
      } catch {}
      return null;
    }
    const zpLexScope = new Proxy(Object.create(null), Object.assign(Object.create(null), {
      has(_t, prop) { return zpLexGetEntry(prop) !== undefined || namedFrameWindow(prop) !== null; },
      get(_t, prop) { const e = zpLexGetEntry(prop); return e ? zpLexRead(e, prop) : namedFrameWindow(prop); },
      set(_t, prop, value) {
        const e = zpLexGetEntry(prop);
        if (e) { zpLexWrite(e, prop, value); return true; }
        return nativeReflectSet(root, prop, value);
      },
      deleteProperty() { return false; },
    }));
    define(root, '__zp_lex_scope', zpLexScope);
    const ZP_STRICT_DIRECTIVE_RE = sealRegExp(/^(\s|\/\*[^]*?\*\/|\/\/[^\n]*)*('use strict'|"use strict")/);
    function execGlobalScript(code) {
      const geval = Native.globalEval;
      // Append `sourceURL` so stack traces attribute script frames to the virtual document URL.
      const tagged = '\n//# sourceURL=' + virtualURL.href;
      if (geval) {
        // Wrap sloppy classic scripts in `with(__zp_lex_scope)` to bind the global lexical environment
        // (strict scripts cannot sit inside a top-level `with` and run directly).
        if (!ZP_STRICT_DIRECTIVE_RE.test(code)) return geval(ttScript('with(__zp_lex_scope){' + ZP_WITH_PROLOGUE + code + '\n}' + tagged));
        return geval(ttScript(code + tagged));
      }
      return ttFunction([code]).call(root);
    }
    define(root, '__ZP_EXEC_INLINE_SCRIPT', source => execGlobalScript(rewriteWithPageRewriter(decodeInlineEntities(source), 'classic')));
    define(root, '__ZP_EXEC_INLINE_MODULE', source => {
      const code = rewriteWithPageRewriter(decodeInlineEntities(source), 'module');
      const blob = new Blob([code], { type: 'text/javascript' });
      const url = Native.createObjectURL ? Native.createObjectURL(blob) : URL.createObjectURL(blob);
      const promise = import(url);
      promise.finally(() => { try { (Native.revokeObjectURL || URL.revokeObjectURL).call(URL, url); } catch {} });
      return promise;
    });
    // Execute inline scripts that were already rewritten during HTML transformation in the service worker.
    define(root, '__ZP_EXEC_INLINE_REWRITTEN', code => execGlobalScript(String(code || '')));
    define(root, '__ZP_EXEC_INLINE_REWRITTEN_MODULE', code => {
      const blob = new Blob([String(code || '')], { type: 'text/javascript' });
      const url = Native.createObjectURL ? Native.createObjectURL(blob) : URL.createObjectURL(blob);
      const promise = import(url);
      promise.finally(() => { try { (Native.revokeObjectURL || URL.revokeObjectURL).call(URL, url); } catch {} });
      return promise;
    });
    define(root, '__ZP_EXEC_EVENT', (selfValue, event, source) => ttFunction(['event', rewriteWithPageRewriter(source, 'event-handler')]).call(selfValue, event));
    define(root, 'eval', dynamicEval);
    define(root, 'Function', dynamicFunction);
    // Virtualize `.constructor` on function prototypes: record per-instance overrides in a
    // WeakMap so `fn.constructor = ...` succeeds in strict mode, and return the override or
    // dynamic constructor wrapper on reads.
    const constructorOverrides = newWeakMap();
    for (const [ctor, wrapper] of dynamicConstructorWrappers) {
      if (ctor && ctor.prototype) try {
        // Skip prototypes whose `constructor` property is already non-configurable.
        if (propertyLocked(ctor.prototype, 'constructor')) continue;
        defineMasked(ctor.prototype, 'constructor', {
          get() { return constructorOverrides.get(this) || wrapper; },
          set(value) { try { constructorOverrides.set(this, value); } catch {} },
          enumerable: false, configurable: false
        });
      } catch {}
    }
    // Wrap non-function timer handlers (`setTimeout("code")`) so they compile and execute via
    // `dynamicEval` when the timer fires rather than in the unrewritten native global scope,
    // surfacing any `SyntaxError` at fire time to match native browser behavior.
    function timerHandler(handler, sink) {
      if (typeof handler === 'function') return handler;
      // Coerce non-function handlers (strings, `TrustedScript`, or objects with `toString()`) to source text.
      const text = ttIsTrusted('Script', handler) ? ttText('Script', handler) : ttCompliant('Script', sink, String(handler));
      // Evaluate as global code via indirect `dynamicEval` when the timer fires.
      return function () { return dynamicEval.call(undefined, ttScript(text)); };
    }
    if (Native.setTimeout) define(root, 'setTimeout', function(handler, delay, ...args) { return Native.setTimeout(timerHandler(handler, 'Window setTimeout'), delay, ...args); });
    if (Native.setInterval) define(root, 'setInterval', function(handler, delay, ...args) { return Native.setInterval(timerHandler(handler, 'Window setInterval'), delay, ...args); });
    // `document.write` and `document.writeln` are installed per-realm in `installDOMHooks`.
    if (Native.DOMParserParseFromString && root.DOMParser) define(root.DOMParser.prototype, 'parseFromString', function(markup, type) { const m = ttCompliant('HTML', 'DOMParser parseFromString', markup); return Native.DOMParserParseFromString.call(this, String(type).toLowerCase() === 'text/html' ? transformHTML(String(m), { document: true }) : m, type); });
    if (Native.rangeCreateContextualFragment && root.Range) define(root.Range.prototype, 'createContextualFragment', function(markup) { return Native.rangeCreateContextualFragment.call(this, transformHTML(String(ttCompliant('HTML', 'Range createContextualFragment', markup)))); });
    installEventWindowIdentity();
    // Window identity across events. The page's `window` is the membrane's facade (`scope`), but the native event surface speaks of the real
    // window: an event's `view`, `target`, `currentTarget`, `srcElement` and `composedPath()` hand it out, and the UI event constructors and
    // their legacy `init*Event` methods take a real Window for `view`. Natively `e.currentTarget === window` and
    // `new MouseEvent('click', { view: window })` are plain facts; here the first read the real window and the second threw. The page gets the
    // facade back from what the browser hands out, and the browser gets the real window for what the page hands in.
    function installEventWindowIdentity() {
      const realWindowOf = v => (v === scope || v === withScope ? root : (v && typeof v === 'object' && crossWindowTargets.get(v)) || v);
      const eventProto = root.Event && root.Event.prototype;
      if (eventProto) {
        for (const key of ['target', 'currentTarget', 'srcElement']) {
          const d = Object.getOwnPropertyDescriptor(eventProto, key);
          if (!d || typeof d.get !== 'function') continue;
          const nativeGet = d.get;
          defineMasked(eventProto, key, { get() { const v = Reflect.apply(nativeGet, this, []); return v === root ? scope : v; }, set: d.set, configurable: true, enumerable: d.enumerable });
        }
        const nativePath = eventProto.composedPath;
        if (typeof nativePath === 'function') {
          define(eventProto, 'composedPath', function composedPath() {
            const path = Reflect.apply(nativePath, this, []);
            for (let i = 0; i < path.length; i++) if (path[i] === root) path[i] = scope;
            return path;
          });
        }
      }
      const uiProto = root.UIEvent && root.UIEvent.prototype;
      const viewDesc = uiProto && Object.getOwnPropertyDescriptor(uiProto, 'view');
      if (viewDesc && typeof viewDesc.get === 'function') {
        const nativeView = viewDesc.get;
        defineMasked(uiProto, 'view', { get() { const v = Reflect.apply(nativeView, this, []); return v ? windowHandleFor(v) : v; }, set: viewDesc.set, configurable: true, enumerable: viewDesc.enumerable });
      }
      // The constructors: a class that reads `view` from its init dictionary gets the real window. A Proxy keeps everything else native
      // (`new.target` and subclassing, statics, `length`, `name`), with `prototype.constructor` and the parent link pointing at the replacements.
      const replacements = newWeakMap();
      for (const name of ['UIEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'FocusEvent', 'InputEvent', 'CompositionEvent', 'WheelEvent', 'TouchEvent', 'DragEvent']) {
        const Native_ = root[name];
        if (typeof Native_ !== 'function') continue;
        const replacement = new Proxy(Native_, {
          construct(target, args, newTarget) {
            const init = args.length > 1 ? args[1] : undefined;
            if (init !== null && typeof init === 'object') {
              let view;
              try { view = init.view; } catch { view = undefined; }
              const real = view === undefined || view === null ? view : realWindowOf(view);
              if (real !== view) {
                // Everything else in the dictionary is read from the page's own object, so its getters still run once each.
                const copy = Object.create(init);
                Object.defineProperty(copy, 'view', { value: real, writable: true, enumerable: true, configurable: true });
                args = [args[0], copy].concat(Array.prototype.slice.call(args, 2));
              }
            }
            return Reflect.construct(target, args, newTarget === replacement ? target : newTarget);
          },
          getPrototypeOf(target) { const parent = Reflect.getPrototypeOf(target); return replacements.get(parent) || parent; },
        });
        replacements.set(Native_, replacement);
        try { Object.defineProperty(Native_.prototype, 'constructor', { value: replacement, writable: true, enumerable: false, configurable: true }); } catch {}
        maskNativeFunction(replacement, name);
        try { Object.defineProperty(root, name, { value: replacement, writable: true, enumerable: false, configurable: true }); } catch {}
      }
      // The legacy initializers take the window as their fourth argument.
      for (const [name, method] of [['UIEvent', 'initUIEvent'], ['MouseEvent', 'initMouseEvent'], ['KeyboardEvent', 'initKeyboardEvent'], ['CompositionEvent', 'initCompositionEvent']]) {
        const proto = root[name] && root[name].prototype;
        const nativeInit = proto && Object.getOwnPropertyDescriptor(proto, method);
        if (!nativeInit || typeof nativeInit.value !== 'function') continue;
        const original = nativeInit.value;
        define(proto, method, { [method](type) {
          const args = Array.prototype.slice.call(arguments);
          if (args.length > 3) args[3] = realWindowOf(args[3]);
          return Reflect.apply(original, this, args);
        } }[method]);
      }
    }
  }