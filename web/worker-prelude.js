(() => {
  'use strict';
  if (self.__ZP_WORKER_PRELUDE) return;
  Object.defineProperty(self, '__ZP_WORKER_PRELUDE', { value: true, enumerable: false, configurable: false });
  // The worker prelude's own tables: real Map/Set/WeakMap/WeakSet whose prototype is a copy of the built-in's taken before
  // any worker script ran (see the same factories in web/membrane/00-head.js). A worker script that wraps
  // `Map.prototype.get` neither sees what the prelude keeps there nor sends the free-name lookup of its own code into
  // a loop (`with(__zp_lex_scope)` reads a table).
  const sealProtoOf = proto => Object.create(null, Object.getOwnPropertyDescriptors(proto));
  const SEALED_MAP = sealProtoOf(Map.prototype);
  const SEALED_SET = sealProtoOf(Set.prototype);
  const SEALED_WEAKMAP = sealProtoOf(WeakMap.prototype);
  const SEALED_WEAKSET = sealProtoOf(WeakSet.prototype);
  const sealedSetProto = Object.setPrototypeOf;
  const newMap = entries => {
    const m = sealedSetProto(new Map(), SEALED_MAP);
    if (entries) for (let i = 0; i < entries.length; i++) m.set(entries[i][0], entries[i][1]);
    return m;
  };
  const newSet = items => {
    const t = sealedSetProto(new Set(), SEALED_SET);
    if (items) for (let i = 0; i < items.length; i++) t.add(items[i]);
    return t;
  };
  const newWeakMap = () => sealedSetProto(new WeakMap(), SEALED_WEAKMAP);
  const newWeakSet = () => sealedSetProto(new WeakSet(), SEALED_WEAKSET);
  // Snapshot of the worker realm's native globals and prototype members before installing hooks. Most worker globals
  // (`fetch`, `setTimeout`, `importScripts`, `location`, `origin`) live on `WorkerGlobalScope.prototype` rather than
  // `self`; `settleNatives` restores each hook to the native owner object with matching descriptor flags, `name`,
  // `length`, and `toString` output so prototype calls cannot bypass hooks.
  const ZP_HIDDEN_RE = /^(?:__zp_|__ZP_|ZPBundle$|ZPPageBundleWBG$|ZeroProxyRT$|ZP$)/;
  // Runtime helpers referenced by rewritten code (`zp-rewriter` RUNTIME_HELPERS). Every `with` block binds these as
  // block constants read off the global object so the `with` target proxy is not queried for helper names on each lookup.
  const ZP_WITH_HELPERS = ['__zp_get', '__zp_set', '__zp_call', '__zp_this', '__zp_assign', '__zp_update', '__zp_delete',
    '__zp_eval', '__zp_has', '__zp_oget', '__zp_ocall', '__zp_ocallv', '__zp_ochain', '__zp_odelete', '__zp_okeys',
    '__zp_rget', '__zp_rset', '__zp_ownKeys', '__zp_getOwnPropertyDescriptor', '__zp_getOwnPropertyDescriptors',
    '__zp_getOwnPropertyNames', '__zp_module_url', '__zp_with_get', '__zp_with_set', '__zp_with_assign',
    '__zp_with_update', '__zp_with_delete', '__zp_with_d', '__zp_lex_decl', '__zp_lex_bind', '__zp_fast', '__zp_fastset'];
  const ZP_WITH_PROLOGUE = 'const{' + ZP_WITH_HELPERS.join(',') + '}=(function(){return this})();';
  const origFnToString = Function.prototype.toString;
  // Maps each wrapper function to the `toString()` text of the native function it replaces.
  const maskedSource = newWeakMap();
  const nativeSnapshot = (() => {
    const global = newMap();
    for (let o = self; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const k of Object.getOwnPropertyNames(o)) {
        if (!global.has(k) && !ZP_HIDDEN_RE.test(k)) global.set(k, { owner: o, desc: Object.getOwnPropertyDescriptor(o, k) });
      }
    }
    const members = newMap();
    const take = o => {
      if (!o || (typeof o !== 'object' && typeof o !== 'function') || members.has(o)) return;
      const m = newMap();
      for (const k of Object.getOwnPropertyNames(o)) { try { m.set(k, Object.getOwnPropertyDescriptor(o, k)); } catch {} }
      members.set(o, m);
    };
    for (const { desc } of global.values()) {
      const v = desc.value;
      if (typeof v === 'function') { take(v); try { if (v.prototype) take(v.prototype); } catch {} }
      else if (v && typeof v === 'object') take(v);
    }
    return { global, members };
  })();
  // In module workers, `importScripts` exists on `WorkerGlobalScope` but throws a TypeError when called; detect module
  // workers via `mod=1` in the bootstrap URL fragment (the module bootstrap loads `zp-core.js` beforehand).
  // Capture the real bootstrap `location` before redefining `self.location` to the virtual target URL.
  const realLocation = self.location;
  const realProxyOrigin = realLocation.origin;
  const isModuleWorker = new URLSearchParams(realLocation.hash.slice(1)).get('mod') === '1';
  // A worker that enforces Trusted Types takes `importScripts` URLs only as `TrustedScriptURL`: the bootstrap made the policy to load them with.
  if (!isModuleWorker) { const early = self.__ZP_WORKER_TP; importScripts(early ? early.createScriptURL('/zp/assets/zp-core.js') : '/zp/assets/zp-core.js'); }
  const nativeFetch = self.fetch.bind(self);
  // Capture the native URL constructor before replacing `self.URL` with the virtualizing wrapper.
  const NativeURLCtor = self.URL;
  const base = new NativeURLCtor(self.__ZP_WORKER_TARGET || 'https://invalid.local/');
  const tabId = String(self.__ZP_WORKER_TAB_ID || '');
  // `blob:` and `data:` workers inherit origin, secure-context state, and storage partitioning from their creator
  // document (`__ZP_WORKER_REF`), restricted to `http:` and `https:` URLs.
  const creatorRef = (() => { try { const r = new NativeURLCtor(String(self.__ZP_WORKER_REF || '')); return r.protocol === 'http:' || r.protocol === 'https:' ? r : null; } catch { return null; } })();
  const contextURL = ((base.protocol === 'blob:' || base.protocol === 'data:') && creatorRef) ? creatorRef : base;
  const workerOrigin = base.protocol === 'data:' ? 'null' : contextURL.origin;
  // Partition storage and BroadcastChannel by the creator's origin when `workerOrigin` is opaque `'null'` (`data:`).
  const storageOrigin = (workerOrigin === 'null' && creatorRef) ? creatorRef.origin : workerOrigin;
  const blockedDynamic = function(){ try { throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError'); } catch(e) { throw e; } };
  // Dynamic code rewriting via `self.ZPBundle` (loaded by the worker bootstrap); fails closed when unavailable.
  const nativeEval = self.eval;
  const NativeFunctionCtor = self.Function;
  const NativeAsyncFunctionCtor = (async function(){}).constructor;
  const NativeGeneratorFunctionCtor = (function*(){}).constructor;
  const NativeAsyncGeneratorFunctionCtor = (async function*(){}).constructor;
  function zpRewrite(source) {
    const B = self.ZPBundle;
    if (!B || !B.ready || typeof B.rewriteScript !== 'function') blockedDynamic();
    try {
      const out = B.rewriteScript(String(source), 'classic', base.href, realProxyOrigin);
      if (typeof out === 'string' && out.length) return out;
    } catch {}
    blockedDynamic();
  }
  const EXPR_STMT_RE = /^(?:function|class|var|let|const|if|for|while|do|switch|try|throw|return|break|continue|with|import|export|debugger)\b/;
  // Trusted Types. A blob or data worker inherits the policies of the document that started it: its bootstrap put them in its CSP (`__ZP_WORKER_TT`)
  // and made the policy of ours that this prelude hands Trusted values from (`__ZP_WORKER_TP`). Where the worker enforces them, the strings the
  // prelude gives eval, Function and importScripts are Trusted values of that policy, and the strings a page gives them go to the worker's `default`
  // policy as the engine calls it, or are refused as the engine refuses. A worker that does not enforce them is left alone.
  const nativeTT = (() => {
    try {
      const F = TrustedTypePolicyFactory.prototype, P = TrustedTypePolicy.prototype;
      return {
        f: self.trustedTypes, is: F.isScript, isURL: F.isScriptURL, defaultPolicy: Object.getOwnPropertyDescriptor(F, 'defaultPolicy').get,
        createScript: P.createScript, createScriptURL: P.createScriptURL, text: TrustedScript.prototype.toString, urlText: TrustedScriptURL.prototype.toString,
      };
    } catch { return null; }
  })();
  const ttPolicies = Array.isArray(self.__ZP_WORKER_TT) ? self.__ZP_WORKER_TT : [];
  const ttInternal = (() => { const p = self.__ZP_WORKER_TP; try { delete self.__ZP_WORKER_TP; delete self.__ZP_WORKER_TT; } catch {} return p || null; })();
  const ttEnforced = !!(nativeTT && ttPolicies.length && ZP.requiresTrustedTypes(ttPolicies.join(', ')));
  // Whether the prelude can hand Trusted values to the native sinks (it can where the worker enforces and the bootstrap made the policy).
  const ttActive = ttEnforced && !!ttInternal;
  const ttScript = s => ttActive ? Reflect.apply(nativeTT.createScript, ttInternal, [s]) : s;
  const ttScriptURL = s => ttActive ? Reflect.apply(nativeTT.createScriptURL, ttInternal, [s]) : s;
  const ttIsTrusted = (kind, v) => {
    try { return !!(nativeTT && v !== null && typeof v === 'object' && Reflect.apply(kind === 'Script' ? nativeTT.is : nativeTT.isURL, nativeTT.f, [v])); } catch { return false; }
  };
  const ttText = (kind, v) => Reflect.apply(kind === 'Script' ? nativeTT.text : nativeTT.urlText, v, []);
  // The refusal the engine throws for `sink` when the worker enforces `kind` and there is no `default` policy.
  const TT_WORKER_SINKS = { 'WorkerGlobalScope setTimeout': 'setTimeout', 'WorkerGlobalScope setInterval': 'setInterval', 'WorkerGlobalScope importScripts': 'importScripts' };
  function ttViolation(kind, sink) {
    if (sink === 'eval' || sink === 'Function') return new EvalError("Evaluating a string as JavaScript violates this document's Trusted Type assignment requirements.");
    const name = TT_WORKER_SINKS[sink];
    const tail = "This document requires 'Trusted" + kind + "' assignment.";
    return new TypeError(name ? "Failed to execute '" + name + "' on 'WorkerGlobalScope': " + tail : tail);
  }
  // What a sink of `kind` named `sink` receives for the page's `value`: a Trusted value gives its string; where the worker enforces, a string goes
  // through the worker's `default` policy (refused, as natively, when there is none); otherwise `value` itself.
  function ttCompliant(kind, sink, value) {
    if (ttIsTrusted(kind, value)) return ttText(kind, value);
    if (!ttEnforced) return value;
    let dp = null;
    try { dp = Reflect.apply(nativeTT.defaultPolicy, nativeTT.f, []); } catch {}
    if (!dp) throw ttViolation(kind, sink);
    const made = Reflect.apply(kind === 'Script' ? nativeTT.createScript : nativeTT.createScriptURL, dp, [String(value), 'Trusted' + kind, sink]);
    if (made === null || made === undefined) throw ttViolation(kind, sink);
    const text = ttText(kind, made);
    // A compilation (`eval`, `Function`) whose text the policy changed is refused; every other sink takes the policy's text.
    if ((sink === 'eval' || sink === 'Function') && text !== String(value)) throw ttViolation(kind, sink);
    return text;
  }
  // `new Function(...)` for source the prelude built itself. The Function constructor takes no Trusted value, so where the worker enforces Trusted Types
  // the function is made by evaluating the source the constructor would have compiled, as a Trusted script of the prelude's own policy.
  function workerBuildFunction(ctor, args, kindWord) {
    if (!ttActive) return Reflect.construct(ctor, args);
    const parts = args.map(String);
    const body = parts.length ? parts[parts.length - 1] : '';
    return nativeEval.call(self, ttScript('(' + (kindWord || 'function') + ' anonymous(' + parts.slice(0, -1).join(',') + '\n) {\n' + body + '\n})'));
  }
  // `eval` compiles strings and `TrustedScript` instances; all other argument types are returned unchanged (ECMA-262 PerformEval step 2).
  function evalSource(x, sink) {
    if (typeof x === 'string') return ttCompliant('Script', sink || 'eval', x);
    return ttIsTrusted('Script', x) ? ttText('Script', x) : null;
  }
  function workerDynamicEval(source) {
    if (new.target) throw new TypeError('eval is not a constructor');
    if (arguments.length === 0) return undefined;
    const text = evalSource(source);
    if (text === null) return source;
    if (!EXPR_STMT_RE.test(text.trimStart())) {
      try {
        const rw = zpRewrite(text);
        const expr = workerBuildFunction(NativeFunctionCtor, ['__zp_scope', 'with(__zp_scope){' + ZP_WITH_PROLOGUE + 'return (' + rw + '\n);}']);
        return Reflect.apply(expr, self, [scope]);
      } catch (e) { if (e && e.name === 'NotSupportedError') throw e; }
    }
    // Execute statements via global indirect `eval` so top-level `var` and `function` declarations bind on `self`
    // while `let`/`const`/`class` remain scoped to a per-eval lexical map (`isEval = true`).
    return workerExecGlobal(zpRewrite(text), true);
  }
  function workerDynamicFunction(ctor, args) {
    const parts = args.map(String);
    const body = parts.length ? parts.pop() : '';
    const kind = ctor === NativeAsyncFunctionCtor ? 'async function'
      : ctor === NativeGeneratorFunctionCtor ? 'function*'
      : ctor === NativeAsyncGeneratorFunctionCtor ? 'async function*' : 'function';
    // Where the worker enforces Trusted Types, the `default` policy sees the source the engine would have compiled (and decides what is).
    // The `default` policy sees the source the engine would compile; one that changes it is a refusal (thrown by `ttCompliant`).
    if (ttEnforced) ttCompliant('Script', 'Function', '(' + kind + ' anonymous(' + parts.join(',') + '\n) {\n' + body + '\n})');
    const wrapped = kind + ' __zp_dynamic__(' + parts.join(',') + '){\n' + body + '\n}';
    const code = zpRewrite(wrapped);
    const open = code.indexOf('{'), close = code.lastIndexOf('}');
    if (open < 0 || close <= open) blockedDynamic();
    const inner = code.slice(open + 1, close);
    const compiled = workerBuildFunction(ctor, parts.concat([inner]), kind);
    // Sloppy functions coerce nullish `this` to the real global object; substitute `scope` so `this.location` stays virtualized.
    const sloppy = !/^\s*['"]use strict['"]/.test(body);
    const fn = function anonymous() {
      'use strict';
      const t = sloppy && (this == null || this === self) ? scope : this;
      return new.target ? Reflect.construct(compiled, arguments, new.target) : Reflect.apply(compiled, t, arguments);
    };
    try { Object.defineProperty(fn, 'prototype', { value: ctor.prototype, enumerable: false, configurable: false, writable: false }); } catch {}
    return fn;
  }
  // Define `workerEval` as a concise method so it has no `.prototype` and throws a TypeError on `new eval()`.
  const workerEval = ({ ['eval'](s) { return workerDynamicEval.apply(this, arguments); } })['eval'];
  // Direct `eval(x)` helper: `zpDirectEvalRunner` is a sloppy function whose `eval` parameter receives the native
  // `eval` intrinsic, making `eval(__zp_src)` a real direct eval. Call-site accessors on `desc` expose the caller's
  // local bindings, and `.call(this)` preserves `this`.
  const zpDirectEvalRunner = workerBuildFunction(NativeFunctionCtor, ['eval', '__zp_env', '__zp_src', 'return eval(__zp_src)']);
  var __zp_eval_desc = null;
  function workerDirectEval(callee, args, desc, callerStrict) {
    if (new.target) throw new TypeError('eval is not a constructor');
    if (callee !== workerEval) return Reflect.apply(callee, undefined, Array.isArray(args) ? args : []);
    const arg = args && args.length ? args[0] : undefined;
    const src = evalSource(arg);
    if (src === null) return arg;
    const rewritten = zpRewrite(src);
    let d = {};
    if (desc && typeof desc === 'object') {
      const dd = Object.getOwnPropertyDescriptors(desc);
      for (const k of Object.keys(dd)) { dd[k].configurable = false; dd[k].enumerable = true; }
      d = Object.defineProperties({}, dd);
    }
    const prev = __zp_eval_desc;
    __zp_eval_desc = d;
    const prevLexEnv = __zp_lex_env;
    __zp_lex_env = newMap();
    try {
      const strictSrc = !!callerStrict || /^\s*['"]use strict['"]/.test(src);
      const env = new Proxy(d, {
        has(_t, p) { return p !== Symbol.unscopables; },
        get(_t, p) {
          if (typeof p === 'string' && Object.prototype.hasOwnProperty.call(d, p)) return d[p];
          return Reflect.get(scope, p);
        },
        set(_t, p, v) {
          if (typeof p === 'string' && Object.prototype.hasOwnProperty.call(d, p)) { d[p] = v; return true; }
          return Reflect.set(scope, p, v);
        },
      });
      const body = strictSrc ? '"use strict";' + rewritten : 'with(__zp_env){' + ZP_WITH_PROLOGUE + rewritten + '\n}';
      return zpDirectEvalRunner.call(this, nativeEval, env, ttScript(body + '\n//# sourceURL=' + base.href));
    } finally {
      __zp_eval_desc = prev;
      __zp_lex_env = prevLexEnv;
    }
  }
  expose('__zp_eval', workerDirectEval);
  try { Object.defineProperty(workerEval, 'name', { value: 'eval', configurable: true }); } catch {}
  const workerFunction = function Function() { return workerDynamicFunction(NativeFunctionCtor, Array.prototype.slice.call(arguments)); };
  const workerAsyncFunction = function AsyncFunction() { return workerDynamicFunction(NativeAsyncFunctionCtor, Array.prototype.slice.call(arguments)); };
  const workerGeneratorFunction = function GeneratorFunction() { return workerDynamicFunction(NativeGeneratorFunctionCtor, Array.prototype.slice.call(arguments)); };
  const workerAsyncGeneratorFunction = function AsyncGeneratorFunction() { return workerDynamicFunction(NativeAsyncGeneratorFunctionCtor, Array.prototype.slice.call(arguments)); };
  // Point each function prototype's `.constructor` at the rewriting wrapper so `fn.constructor` cannot reach the
  // unrewritten native constructor, while keeping `.prototype` set to the real intrinsic prototype.
  for (const [ctor, wrapper] of [
    [NativeFunctionCtor, workerFunction],
    [NativeAsyncFunctionCtor, workerAsyncFunction],
    [NativeGeneratorFunctionCtor, workerGeneratorFunction],
    [NativeAsyncGeneratorFunctionCtor, workerAsyncGeneratorFunction],
  ]) {
    try { Object.defineProperty(ctor.prototype, 'constructor', { value: wrapper, enumerable: false, configurable: false, writable: true }); } catch {}
    try { Object.defineProperty(wrapper, 'name', { value: ctor.prototype.constructor.name || 'Function', configurable: true }); } catch {}
    try { Object.defineProperty(wrapper, 'prototype', { value: ctor.prototype, writable: false, enumerable: false, configurable: false }); } catch {}
  }
  // Shared global lexical environment for top-level `let`, `const`, and `class` declarations across worker scripts.
  const zpLex = newMap();
  var __zp_lex_env = zpLex;
  const zpLexEntry = prop => (typeof prop === 'string' ? zpLex.get(prop) : undefined);
  const zpLexRead = (e, prop) => {
    if (!e.get) throw new ReferenceError(`Cannot access '${prop}' before initialization`);
    return e.get();
  };
  const zpLexWrite = (e, prop, value) => {
    if (!e.set) throw new TypeError('Assignment to constant variable.');
    e.set(value);
  };
  // Returns any conflicting identifier name so the caller throws the SyntaxError from rewritten target code rather
  // than exposing the prelude URL in the error stack. Validates all declarations before registering any entry.
  expose('__zp_lex_decl', (lexMap, varNames) => {
    const env = __zp_lex_env || zpLex;
    for (const n of varNames) {
      if (zpLex.has(n) || (env !== zpLex && env.has(n))) return n;
    }
    for (const n of Object.keys(lexMap)) {
      if (env.has(n) || varNames.includes(n)) return n;
      if (env === zpLex) {
        const d = Reflect.getOwnPropertyDescriptor(self, n);
        if (d && !d.configurable) return n;
      }
    }
    for (const n of Object.keys(lexMap)) env.set(n, { kind: lexMap[n], get: null, set: null });
    return undefined;
  });
  expose('__zp_lex_bind', (name, get, set) => {
    const env = __zp_lex_env || zpLex;
    const e = env.get(name);
    if (e) { e.get = get; e.set = typeof set === 'function' ? set : null; }
  });
  const zpLexScope = new Proxy({}, {
    has(_t, prop) { return zpLexEntry(prop) !== undefined; },
    get(_t, prop) { const e = zpLexEntry(prop); return e ? zpLexRead(e, prop) : undefined; },
    set(_t, prop, value) { const e = zpLexEntry(prop); if (!e) return false; zpLexWrite(e, prop, value); return true; },
    deleteProperty() { return false; },
  });
  expose('__zp_lex_scope', zpLexScope);
  // Executes rewritten global worker code, wrapping non-strict code in `with(__zp_lex_scope)` to expose shared
  // top-level lexical bindings.
  const ZP_STRICT_DIRECTIVE_RE = /^(\s|\/\*[^]*?\*\/|\/\/[^\n]*)*('use strict'|"use strict")/;
  const workerExecGlobal = (code, isEval) => {
    const prevLexEnv = __zp_lex_env;
    if (isEval) __zp_lex_env = newMap();
    const tagged = '\n//# sourceURL=' + base.href;
    try {
      if (ZP_STRICT_DIRECTIVE_RE.test(code)) return nativeEval.call(self, ttScript(code + tagged));
      return nativeEval.call(self, ttScript('with(__zp_lex_scope){' + ZP_WITH_PROLOGUE + code + '\n}' + tagged));
    } finally {
      __zp_lex_env = prevLexEnv;
    }
  };
  // Native methods read off `self` or `globalThis` must be bound to the real `WorkerGlobalScope` (`self`) so WebIDL
  // brand checks do not fail with `Illegal invocation` when called on the `scope` proxy. Constructors (which have
  // `.prototype`) and non-native functions remain unbound.
  const globalMethodBindings = newWeakMap();
  const nativeFnToString = NativeFunctionCtor.prototype.toString;
  function globalReceiverValue(value) {
    if (typeof value !== 'function') return value;
    const hit = globalMethodBindings.get(value);
    if (hit) return hit;
    try { if (value.prototype) return value; } catch { return value; }
    try { if (!/\{\s*\[native code\]\s*\}/.test(nativeFnToString.call(value))) return value; } catch { return value; }
    const bound = value.bind(self);
    try { Object.defineProperty(bound, 'name', { value: value.name, configurable: true }); } catch {}
    // Preserve the unbound method's `toString()` text instead of `function () { [native code] }`.
    try { maskedSource.set(bound, nativeFnToString.call(value)); } catch {}
    globalMethodBindings.set(value, bound);
    return bound;
  }
  // A worker global exposes `self` and `globalThis` without `window`, `top`, `parent`, `frames`, or `document`.
  // `scope` answers only for properties present on `WorkerGlobalScope` or in `zpLex` so `typeof window` evaluates
  // to `'undefined'` as in a native worker.
  const scope = new Proxy(self, {
    has(target, prop) {
      if (prop === Symbol.unscopables) return false;
      if (typeof prop === 'symbol') return Reflect.has(target, prop);
      return zpLexEntry(prop) !== undefined || Reflect.has(target, prop);
    },
    get(target, prop) {
      if (prop === Symbol.unscopables) return undefined;
      const le = zpLexEntry(prop);
      if (le) return zpLexRead(le, prop);
      if (prop === 'self' || prop === 'globalThis') return scope;
      if (prop === 'location') return base;
      if (prop === 'eval') return workerEval;
      if (prop === 'Function') return workerFunction;
      return globalReceiverValue(Reflect.get(target, prop));
    },
    set(target, prop, value) {
      const le = zpLexEntry(prop);
      if (le) { zpLexWrite(le, prop, value); return true; }
      return Reflect.set(target, prop, value);
    }
  });
  Object.defineProperty(self, '__zp_runClassic', { value: fn => fn(scope), enumerable: false, configurable: false });
  function expose(name, value) { Object.defineProperty(self, name, { value, enumerable: false, configurable: false }); }
  function isWorkerGlobal(value) { return value === self || value === scope; }
  function workerTarget(value) { return value === scope ? self : value; }
  // Tracks target code assignments to Error.prepareStackTrace while V8 reads our stack-sanitizing accessor.
  const stackHook = { ctor: null, exists: false, value: undefined, forget: null };
  const isStackHook = (target, prop) => prop === 'prepareStackTrace' && target === stackHook.ctor && target != null;
  const stackHookDesc = () => stackHook.exists ? { value: stackHook.value, writable: true, enumerable: true, configurable: true } : undefined;
  const withoutStackHook = (target, keys) => isStackHook(target, 'prepareStackTrace') && !stackHook.exists ? keys.filter(k => k !== 'prepareStackTrace') : keys;
  function get(target, prop) {
    if (typeof prop !== 'symbol') prop = String(prop);
    if (isStackHook(target, prop)) return stackHook.value;
    {
      const d = __zp_eval_desc;
      if (d && isWorkerGlobal(target) && typeof prop === 'string'
          && Object.prototype.hasOwnProperty.call(d, prop)) return d[prop];
    }
    if (isWorkerGlobal(target)) {
      const le = zpLexEntry(prop);
      if (le) return zpLexRead(le, prop);
      if (prop === 'self' || prop === 'globalThis') return scope;
      if (prop === 'location') return base;
      if (prop === 'eval') return workerEval;
      if (prop === 'Function') return workerFunction;
    }
    const actual = workerTarget(target);
    const value = Reflect.get(Object(actual), prop);
    if (isWorkerGlobal(target)) return globalReceiverValue(value);
    return prop === 'postMessage' && typeof value === 'function' ? value.bind(actual) : value;
  }
  function set(target, prop, value) {
    if (typeof prop !== 'symbol') prop = String(prop);
    {
      const d = __zp_eval_desc;
      if (d && isWorkerGlobal(target) && typeof prop === 'string'
          && Object.prototype.hasOwnProperty.call(d, prop)) { d[prop] = value; return value; }
    }
    if (isWorkerGlobal(target)) {
      const le = zpLexEntry(prop);
      if (le) { zpLexWrite(le, prop, value); return value; }
    }
    if ((isWorkerGlobal(target) && prop === 'location') || target === base) blockedDynamic();
    Reflect.set(Object(workerTarget(target)), prop, value);
    return value;
  }
  function assign(target, prop, operator, value) {
    const current = get(target, prop);
    let next;
    switch (operator) {
      case '+=': next = current + value; break;
      case '-=': next = current - value; break;
      case '*=': next = current * value; break;
      case '/=': next = current / value; break;
      case '%=': next = current % value; break;
      case '**=': next = current ** value; break;
      case '<<=': next = current << value; break;
      case '>>=': next = current >> value; break;
      case '>>>=': next = current >>> value; break;
      case '&=': next = current & value; break;
      case '^=': next = current ^ value; break;
      case '|=': next = current | value; break;
      case '&&=': if (!current) return current; next = value(); break;
      case '||=': if (current) return current; next = value(); break;
      case '??=': if (current !== null && current !== undefined) return current; next = value(); break;
      default: blockedDynamic();
    }
    return set(target, prop, next);
  }
  function update(target, prop, operator, prefix) {
    const current = get(target, prop);
    const next = operator === '++' ? current + 1 : current - 1;
    set(target, prop, next);
    return prefix ? next : current;
  }
  function call(target, prop, args) {
    const actual = workerTarget(target);
    return Reflect.apply(get(target, prop), actual, Array.isArray(args) ? args : []);
  }
  function construct(ctor, args) { return Reflect.construct(ctor, Array.isArray(args) ? args : []); }
  function has(target, prop) {
    const d = __zp_eval_desc;
    if (d && isWorkerGlobal(target) && typeof prop === 'string'
        && Object.prototype.hasOwnProperty.call(d, prop)) return true;
    if (isStackHook(target, prop)) return stackHook.exists;
    return isWorkerGlobal(target) && prop === 'location' || Reflect.has(Object(workerTarget(target)), prop);
  }
  function getOwnPropertyDescriptor(target, prop) {
    if (isWorkerGlobal(target) && prop === 'location') return { value: base, configurable: true, enumerable: true, writable: false };
    if (isStackHook(target, prop)) return stackHookDesc();
    return Reflect.getOwnPropertyDescriptor(Object(workerTarget(target)), prop);
  }
  function ownKeys(target) { return withoutStackHook(target, Reflect.ownKeys(Object(workerTarget(target)))); }
  // Membrane helpers emitted by zp-rewriter for property deletion, optional chaining, Reflect traps, and with-scopes.
  function del(target, prop) {
    if (typeof prop !== 'symbol') prop = String(prop);
    {
      const d = __zp_eval_desc;
      if (d && isWorkerGlobal(target) && typeof prop === 'string'
          && Object.prototype.hasOwnProperty.call(d, prop)) { delete d[prop]; return false; }
    }
    if (isStackHook(target, prop)) { stackHook.forget(); return true; }
    return Reflect.deleteProperty(Object(workerTarget(target)), prop);
  }
  function odel(target, prop) { return target == null ? true : del(target, prop); }
  function oget(target, prop) { return target == null ? undefined : get(target, prop); }
  function ocall(target, prop, args, flags) {
    if (target == null) {
      if (flags & 2) return undefined;
      throw new TypeError("Cannot read properties of " + target + " (reading '" + String(prop) + "')");
    }
    const fn = get(target, prop);
    if (fn == null && (flags & 1)) return undefined;
    return Reflect.apply(fn, workerTarget(target), Array.isArray(args) ? args : []);
  }
  function ochain(target, cont) { return target == null ? undefined : cont(target); }
  function ocallv(target, prop) {
    if (target == null) throw new TypeError("Cannot read properties of " + target + " (reading '" + String(prop) + "')");
    const fn = get(target, prop);
    if (fn == null) return undefined;
    const self = workerTarget(target);
    return function () { return Reflect.apply(fn, self, arguments); };
  }
  function rget(target, prop, receiver) {
    if (receiver === undefined || receiver === target) return get(target, prop);
    if (isWorkerGlobal(receiver)) return get(receiver, prop);
    return Reflect.get(Object(workerTarget(target)), prop, receiver);
  }
  function rset(target, prop, value, receiver) {
    if (isWorkerGlobal(target) || isWorkerGlobal(receiver) || target === base) {
      set(isWorkerGlobal(receiver) ? receiver : target, prop, value);
      return true;
    }
    return Reflect.set(Object(target), prop, value, receiver === undefined ? target : receiver);
  }
  function okeys(target) { return Object.keys(Object(workerTarget(target))); }
  function getOwnPropertyNames(target) { return withoutStackHook(target, Object.getOwnPropertyNames(Object(workerTarget(target)))); }
  function getOwnPropertyDescriptors(target) {
    const out = {};
    for (const k of ownKeys(target)) out[k] = getOwnPropertyDescriptor(target, k);
    return out;
  }
  function unscopablesHidden(obj, prop) {
    const uns = obj == null ? null : obj[Symbol.unscopables];
    return uns != null && !!uns[prop];
  }
  function scopeHas(obj, prop) { return obj != null && prop in Object(obj) && !unscopablesHidden(obj, prop); }
  function withGet(obj, prop, fb) {
    if (!scopeHas(obj, prop)) return fb();
    return isWorkerGlobal(obj) ? get(obj, prop) : obj[prop];
  }
  function withSet(obj, prop, value, fb) {
    if (!scopeHas(obj, prop)) return fb(value);
    if (isWorkerGlobal(obj)) set(obj, prop, value); else obj[prop] = value;
    return value;
  }
  function withAssign(obj, prop, op, value, fb) { return scopeHas(obj, prop) ? assign(obj, prop, op, value) : fb(); }
  function withUpdate(obj, prop, op, prefix, fb) { return scopeHas(obj, prop) ? update(obj, prop, op, prefix) : fb(); }
  function withDelete(obj, prop, fb) { return scopeHas(obj, prop) ? del(obj, prop) : fb(); }
  function withD(obj, prop, sink) {
    const viaGlobal = isWorkerGlobal(obj);
    return {
      get v() { if (!scopeHas(obj, prop)) return sink[prop]; return viaGlobal ? get(obj, prop) : obj[prop]; },
      set v(x) { if (scopeHas(obj, prop)) { if (viaGlobal) set(obj, prop, x); else obj[prop] = x; } else sink[prop] = x; }
    };
  }
  expose('__zp_get', get);
  // The rewriter's inline guards (zp-rewriter `guard_claim`, web/membrane/07-membrane.js): an array, a typed array, a
  // string or a function is never the worker's global, its location or a facade, so outside a few names its member is
  // the native one.
  const nativeIsArray = Array.isArray, nativeIsView = ArrayBuffer.isView;
  expose('__zp_fast', (base, prop) => base != null
    && (typeof prop === 'number' || (typeof prop === 'string' && prop !== 'constructor' && prop !== 'prepareStackTrace'
      && prop !== 'postMessage' && prop !== 'location'))
    && (typeof base === 'string' || typeof base === 'function' || nativeIsArray(base) || nativeIsView(base)));
  expose('__zp_fastset', (base, prop) => base != null && (nativeIsArray(base) || nativeIsView(base))
    && (typeof prop === 'number' || (typeof prop === 'string' && prop !== 'location' && prop !== 'name')));
  // `this` of a plain call in sloppy code: the engine gives the real global, worker code knows `self` as the facade
  // (natively `(function () { return this; })() === self`)
  expose('__zp_this', function (t) { return t === self ? scope : t; });
  expose('__zp_set', set);
  expose('__zp_assign', assign);
  expose('__zp_call', call);
  expose('__zp_update', update);
  expose('__zp_construct', construct);
  expose('__zp_has', has);
  expose('__zp_getOwnPropertyDescriptor', getOwnPropertyDescriptor);
  expose('__zp_ownKeys', ownKeys);
  expose('__zp_delete', del);
  expose('__zp_odelete', odel);
  expose('__zp_oget', oget);
  expose('__zp_ocall', ocall);
  expose('__zp_ochain', ochain);
  expose('__zp_ocallv', ocallv);
  expose('__zp_rget', rget);
  expose('__zp_rset', rset);
  expose('__zp_okeys', okeys);
  expose('__zp_getOwnPropertyNames', getOwnPropertyNames);
  expose('__zp_getOwnPropertyDescriptors', getOwnPropertyDescriptors);
  expose('__zp_with_get', withGet);
  expose('__zp_with_set', withSet);
  expose('__zp_with_assign', withAssign);
  expose('__zp_with_update', withUpdate);
  expose('__zp_with_delete', withDelete);
  expose('__zp_with_d', withD);
  expose('__zp_module_url', (specifier, referrer) => {
    const spec = String(specifier);
    if (!spec.startsWith('/') && !spec.startsWith('./') && !spec.startsWith('../') && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec)) throw new TypeError('Blocked by ZeroProxy rewrite policy');
    const u = new NativeURLCtor(spec, referrer || base.href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw blockedDynamic();
    // Return a proxy-origin absolute URL (with explicit tab ID) because root-relative URLs in a worker resolve
    // against the virtualized target base.
    return realProxyOrigin + '/zp/api/script?kind=module&tab=' + encodeURIComponent(tabId) + '&u=' + encodeURIComponent(u.href);
  });
  try { self.eval = workerEval; } catch {}
  try { self.Function = workerFunction; } catch {}
  // Must match ZP.TARGET_USER_AGENT in web/zp-core.js so worker and window realms report identical User-Agent strings.
  const TARGET_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
  const TARGET_APP_VERSION = TARGET_USER_AGENT.replace(/^Mozilla\//, '');
  const TARGET_PLATFORM = 'Win32';
  const nav = self.navigator;
  if (nav) {
    // Define navigator getters on WorkerNavigator.prototype rather than the instance so Object.getOwnPropertyNames(navigator) stays empty.
    const proto = self.WorkerNavigator && self.WorkerNavigator.prototype || Object.getPrototypeOf(nav);
    const getterOf = (key, value) => Object.getOwnPropertyDescriptor({ get [key]() { return value; } }, key).get;
    for (const [key, value] of [['userAgent', TARGET_USER_AGENT], ['appVersion', TARGET_APP_VERSION], ['platform', TARGET_PLATFORM]]) {
      try { Object.defineProperty(proto, key, { get: getterOf(key, value), enumerable: true, configurable: true }); } catch {}
    }
    // Install a NavigatorUAData shim when the host browser's brand list differs from the target Chrome persona.
    try {
      const persona = [];
      const re = /"([^"]+)";v="([^"]+)"/g;
      for (let m; (m = re.exec(String(ZP.TARGET_SEC_CH_UA || '')));) persona.push({ brand: m[1], version: m[2] });
      const realData = nav.userAgentData;
      const realBrands = realData ? Array.from(realData.brands, b => ({ brand: b.brand, version: b.version })) : null;
      if (realData && persona.length && JSON.stringify(realBrands) !== JSON.stringify(persona)) {
        const uaProto = (self.NavigatorUAData && self.NavigatorUAData.prototype) || Object.prototype;
        const shim = Object.create(uaProto);
        const data = Object.create(shim);
        const platform = TARGET_PLATFORM === 'Win32' ? 'Windows' : TARGET_PLATFORM;
        const values = {
          brands: persona, mobile: false, platform,
          toJSON() { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; },
          getHighEntropyValues(hints) { return Promise.resolve(ZP.uaHighEntropyValues(hints, persona, platform)); },
        };
        for (const k of Object.keys(values)) {
          const v = values[k];
          Object.defineProperty(shim, k, typeof v === 'function'
            ? { value: v, writable: true, enumerable: false, configurable: true }
            : { get: getterOf(k, v), enumerable: true, configurable: true });
        }
        Object.defineProperty(proto, 'userAgentData', { get: getterOf('userAgentData', data), enumerable: true, configurable: true });
      }
    } catch {}
  }
  function blocked(){ try { throw new DOMException('Blocked by ZeroProxy policy','NotSupportedError'); } catch(e) { throw e; } }
  const NativeRequest = self.Request;
  const decodeFetchResponse = ZP.createFetchResponseAdapter(self.Response, self.Headers);
  // Prefer the binary `/zp/api/v2/fetch` envelope and fall back to JSON `/zp/api/fetch` on 404.
  let v2FetchOK = true;
  self.fetch = async (input, init = {}) => {
    const raw = input && typeof input.url === 'string' ? input.url : String(input);
    if (/^(?:blob|data):/i.test(raw.trim())) return nativeFetch(input, init);
    const target = ZP.canonicalTargetURL(raw, base.href).href;
    const req = input instanceof NativeRequest ? new NativeRequest(input, init) : new NativeRequest(target, init);
    const bodyBytes = req.method === 'GET' || req.method === 'HEAD' ? null : new Uint8Array(await req.clone().arrayBuffer());
    const payload = { tabId, documentURL: base.href, url: target, init: {
      method: req.method, headers: Array.from(req.headers.entries()), body: null,
      credentials: req.credentials, mode: req.mode, referrer: req.referrer,
      referrerPolicy: req.referrerPolicy, redirect: req.redirect,
    } };
    if (v2FetchOK) {
      try {
        const r = await nativeFetch('/zp/api/v2/fetch', {
          method: 'POST', headers: { 'Content-Type': ZP.ENVELOPE_MIME }, signal: req.signal,
          body: ZP.encodeEnvelope(payload, bodyBytes),
        });
        if (r.status === 404 && !r.headers.get('X-ZP-Fetch-Meta')) { v2FetchOK = false; try { r.arrayBuffer().catch(() => {}); } catch {} }
        else return decodeFetchResponse(r);
      } catch (e) {}
    }
    payload.init.body = bodyBytes ? ZP.bytesToBase64Url(bodyBytes) : null;
    const response = await nativeFetch('/zp/api/fetch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: req.signal,
      body: JSON.stringify(payload),
    });
    v2FetchOK = false;
    return decodeFetchResponse(response);
  };
  // Worker XMLHttpRequest shim backed by proxied `self.fetch` for async requests and `/zp/api/sync-fetch` for synchronous requests.
  const NativeWorkerXHR = self.XMLHttpRequest;
  const XHR_EVENTS = ['readystatechange', 'loadstart', 'progress', 'load', 'error', 'timeout', 'abort', 'loadend'];
  class WorkerXHRUpload extends EventTarget {}
  class WorkerXHR extends EventTarget {
    constructor() {
      super();
      this.readyState = 0;
      this.responseType = '';
      this.response = null;
      this.responseText = '';
      this.responseURL = '';
      this.status = 0;
      this.statusText = '';
      this.timeout = 0;
      this.withCredentials = false;
      this.upload = new WorkerXHRUpload();
      this._method = 'GET';
      this._url = '';
      this._headers = [];
      this._responseHeaders = null;
      this._controller = null;
      this._aborted = false;
      this._timer = null;
      this._mime = null;
    }
    open(method, url, async = true, user = undefined, password = undefined) {
      this._sync = (async === false);
      this._method = String(method || 'GET').toUpperCase();
      const parsed = new NativeURLCtor(String(url), base.href);
      if (user != null) parsed.username = String(user);
      if (password != null) parsed.password = String(password);
      this._url = ZP.canonicalTargetURL(parsed.href, base.href).href;
      this._headers = [];
      this._responseHeaders = null;
      this._aborted = false;
      this._controller = null;
      this.status = 0; this.statusText = ''; this.response = null; this.responseText = ''; this.responseURL = '';
      this._changeState(1);
    }
    setRequestHeader(name, value) {
      if (this.readyState !== 1) { try { throw new DOMException('InvalidStateError', 'InvalidStateError'); } catch (e) { throw e; } }
      const n = String(name).toLowerCase();
      for (const h of this._headers) if (h[0].toLowerCase() === n) { h[1] += ', ' + String(value); return; }
      this._headers.push([String(name), String(value)]);
    }
    overrideMimeType(mime) { this._mime = String(mime); }
    getResponseHeader(name) {
      if (!this._responseHeaders) return null;
      return this._responseHeaders.get(String(name));
    }
    getAllResponseHeaders() {
      if (!this._responseHeaders) return '';
      let out = '';
      for (const [k, v] of this._responseHeaders.entries()) out += k + ': ' + v + '\r\n';
      return out;
    }
    abort() {
      this._aborted = true;
      try { this._controller && this._controller.abort(); } catch {}
      this.readyState = 0;
      this._fire('abort');
      this._fire('loadend');
    }
    _changeState(s) { this.readyState = s; this._fire('readystatechange'); }
    _fire(type) {
      try { this.dispatchEvent(new Event(type)); } catch {}
      const h = this['on' + type];
      if (typeof h === 'function') { try { h.call(this, new Event(type)); } catch {} }
    }
    send(body = null) {
      if (this.readyState !== 1) { try { throw new DOMException('InvalidStateError', 'InvalidStateError'); } catch (e) { throw e; } }
      if (this._sync) return this._sendSyncRelay(body);
      this._controller = new AbortController();
      const init = { method: this._method, headers: this._headers, signal: this._controller.signal, credentials: this.withCredentials ? 'include' : 'same-origin' };
      if (body != null && this._method !== 'GET' && this._method !== 'HEAD') init.body = body;
      this._fire('loadstart');
      if (this.timeout > 0) {
        this._timer = setTimeout(() => {
          try { this._controller.abort(); } catch {}
          this._aborted = true;
          this._fire('timeout');
          this._fire('loadend');
        }, this.timeout);
      }
      self.fetch(this._url, init).then(async resp => {
        if (this._aborted) return;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        this.status = resp.status;
        this.statusText = resp.statusText;
        this.responseURL = resp.url || '';
        this._responseHeaders = resp.headers;
        this._changeState(2);
        this._changeState(3);
        let out;
        const t = this.responseType;
        if (t === 'arraybuffer') out = await resp.arrayBuffer();
        else if (t === 'blob') out = await resp.blob();
        else if (t === 'json') { const text = await resp.text(); try { out = JSON.parse(text); } catch { out = null; } }
        else { const text = await resp.text(); out = text; this.responseText = text; }
        this.response = out;
        this._changeState(4);
        this._fire('load');
        this._fire('loadend');
      }).catch(() => {
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        if (this._aborted) return; // abort/timeout already fired
        this._fire('error');
        this._fire('loadend');
      });
    }
    _sendSyncRelay(body) {
      this._fire('loadstart');
      try {
        if (!NativeWorkerXHR) throw new DOMException('Synchronous XMLHttpRequest is not supported in this worker', 'InvalidStateError');
        const rid = 'sx' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        let u = realProxyOrigin + '/zp/api/sync-fetch'
          + '?rid=' + encodeURIComponent(rid)
          + '&u=' + encodeURIComponent(this._url)
          + '&m=' + encodeURIComponent(this._method)
          + '&tab=' + encodeURIComponent(tabId)
          + '&entry=';
        for (const kv of this._headers) u += '&h=' + encodeURIComponent(kv[0] + ':' + kv[1]);
        const nx = new NativeWorkerXHR();
        nx.open(this._method, u, false);
        nx.send(body != null && this._method !== 'GET' && this._method !== 'HEAD' ? body : null);
        this.status = nx.status;
        this.statusText = nx.statusText || '';
        const h = new self.Headers();
        String(nx.getAllResponseHeaders() || '').split(/\r?\n/).forEach(line => {
          const i = line.indexOf(':');
          if (i > 0) { try { h.append(line.slice(0, i).trim(), line.slice(i + 1).trim()); } catch {} }
        });
        this._responseHeaders = h;
        this._changeState(2);
        this._changeState(3);
        this.responseText = nx.responseText || '';
        if (this.responseType === 'json') {
          try { this.response = this.responseText ? JSON.parse(this.responseText) : null; } catch { this.response = null; }
        } else if (this.responseType === 'arraybuffer') {
          this.response = new TextEncoder().encode(this.responseText).buffer;
        } else {
          this.response = this.responseText;
        }
        this._changeState(4);
        this._fire('load');
        this._fire('loadend');
      } catch (e) {
        this.status = 0; this.statusText = '';
        this._fire('error');
        this._fire('loadend');
      }
    }
  }
  for (const [n, v] of [['UNSENT', 0], ['OPENED', 1], ['HEADERS_RECEIVED', 2], ['LOADING', 3], ['DONE', 4]]) {
    WorkerXHR[n] = v; WorkerXHR.prototype[n] = v;
  }
  for (const e of XHR_EVENTS) WorkerXHR.prototype['on' + e] = null;
  self.XMLHttpRequest = WorkerXHR;
  // Namespace IndexedDB and Cache Storage keys by target origin so targets sharing the proxy origin cannot read each other's data.
  const ns = 'ZP|' + storageOrigin + '|';
  const nsOf = name => ns + String(name);
  const unNs = name => name.startsWith(ns) ? name.slice(ns.length) : name;
  if (self.indexedDB) {
    const nativeIDB = self.indexedDB;
    const idb = Object.create(nativeIDB);
    idb.open = (name, version) => version === undefined ? nativeIDB.open(nsOf(name)) : nativeIDB.open(nsOf(name), version);
    idb.deleteDatabase = name => nativeIDB.deleteDatabase(nsOf(name));
    if (nativeIDB.databases) {
      idb.databases = () => nativeIDB.databases().then(list =>
        list.filter(d => typeof d.name === 'string' && d.name.startsWith(ns))
            .map(d => ({ name: unNs(d.name), version: d.version })));
    }
    // `self.indexedDB` is a getter-only accessor on WorkerGlobalScope; replace it via Object.defineProperty.
    Object.defineProperty(self, 'indexedDB', { value: idb, writable: true, enumerable: true, configurable: true });
  }
  if (self.caches) {
    const nativeCaches = self.caches;
    const cs = Object.create(nativeCaches);
    cs.open = name => nativeCaches.open(nsOf(name));
    cs.has = name => nativeCaches.has(nsOf(name));
    cs.delete = name => nativeCaches.delete(nsOf(name));
    cs.keys = () => nativeCaches.keys().then(list => list.filter(k => k.startsWith(ns)).map(unNs));
    // Restrict `caches.match` to caches within the current target's namespace.
    cs.match = (request, options) => cs.keys().then(async keys => {
      for (const k of keys) {
        const c = await nativeCaches.open(nsOf(k));
        const hit = await c.match(request, options);
        if (hit) return hit;
      }
      return undefined;
    });
    Object.defineProperty(self, 'caches', { value: cs, writable: true, enumerable: true, configurable: true });
  }
  // Replace `cookieStore` (when exposed on the global scope) with an isolated in-memory store so proxy-origin cookies do not leak.
  if ('cookieStore' in self) {
    const jar = newMap();
    const parseExpires = o => o && o.expires ? Number(o.expires) : null;
    const sweep = () => { const now = Date.now(); for (const [k, v] of jar) if (v.expires && v.expires <= now) jar.delete(k); };
    const fire = changes => { try { cookieStore.dispatchEvent(Object.assign(new Event('change'), { changed: changes, deleted: [] })); } catch {} };
    const cookieStore = new EventTarget();
    cookieStore.get = async (name, options) => {
      sweep();
      const n = typeof name === 'object' && name ? name.name : name;
      if (n == null) { const first = jar.values().next().value; return first || null; }
      return jar.get(String(n)) || null;
    };
    cookieStore.getAll = async (name, options) => { sweep(); const n = typeof name === 'object' && name ? name.name : name; if (n == null) return [...jar.values()]; const c = jar.get(String(n)); return c ? [c] : []; };
    cookieStore.set = async (name, value, options) => {
      const opts = typeof name === 'object' && name ? name : (options || {});
      const n = String(opts.name !== undefined ? opts.name : name);
      const v = String(opts.value !== undefined ? opts.value : value);
      const rec = { name: n, value: v, domain: null, path: opts.path || '/', expires: parseExpires(opts), sameSite: opts.sameSite || 'strict', partitioned: !!opts.partitioned };
      jar.set(n, rec);
      fire([Object.assign({}, rec)]);
    };
    cookieStore.delete = async (name, options) => { const n = String(typeof name === 'object' && name ? name.name : name); jar.delete(n); };
    cookieStore.onchange = null;
    Object.defineProperty(self, 'cookieStore', { value: cookieStore, writable: true, enumerable: true, configurable: true });
  }
  // Rewrite non-function timer handlers (`setTimeout(code)` / `setInterval(code)`) through `ZPBundle` before scheduling.
  const nativeSetTimeout = self.setTimeout.bind(self);
  const nativeSetInterval = self.setInterval.bind(self);
  // Coerce non-function handlers (strings, TrustedScript, or arbitrary objects) to source text before rewriting.
  const compileTimerString = (handler, sink) => {
    // A Trusted value gives its string; any other value is a string for the worker's `default` policy (an object by its string form).
    const code = ttIsTrusted('Script', handler) ? ttText('Script', handler) : ttCompliant('Script', sink, typeof handler === 'string' ? handler : String(handler));
    const rw = zpRewrite(code);
    return () => workerExecGlobal(rw, true);
  };
  self.setTimeout = (handler, timeout, ...args) => {
    if (typeof handler !== 'function') return nativeSetTimeout(compileTimerString(handler, 'WorkerGlobalScope setTimeout'), timeout);
    return nativeSetTimeout(handler, timeout, ...args);
  };
  self.setInterval = (handler, timeout, ...args) => {
    if (typeof handler !== 'function') return nativeSetInterval(compileTimerString(handler, 'WorkerGlobalScope setInterval'), timeout);
    return nativeSetInterval(handler, timeout, ...args);
  };
  // EventSource implementation backed by streaming proxied `self.fetch`.
  class WorkerEventSource extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 0;
      this.withCredentials = false;
      this.onopen = null; this.onmessage = null; this.onerror = null;
      this._controller = new AbortController();
      this._run();
    }
    close() { this.readyState = 2; try { this._controller.abort(); } catch {} }
    _fire(type, event) { try { this.dispatchEvent(event); } catch {} const h = this['on' + type]; if (typeof h === 'function') { try { h.call(this, event); } catch {} } }
    async _run() {
      try {
        const resp = await self.fetch(this.url, { headers: [['Accept', 'text/event-stream']] });
        if (!resp.ok || !resp.body) throw new Error('bad sse');
        this.readyState = 1;
        this._fire('open', new Event('open'));
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '', data = '', eventName = '', lastId = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done || this.readyState === 2) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, ''); buf = buf.slice(idx + 1);
            if (line === '') {
              if (data !== '') {
                const type = eventName || 'message';
                const ev = new MessageEvent(type, { data: data.replace(/\n$/, ''), lastEventId: lastId });
                try { this.dispatchEvent(ev); } catch {}
                if (type === 'message' && typeof this.onmessage === 'function') { try { this.onmessage.call(this, ev); } catch {} }
              }
              data = ''; eventName = '';
            } else if (line.startsWith(':')) { /* comment/heartbeat */ }
            else {
              const c = line.indexOf(':');
              const field = c < 0 ? line : line.slice(0, c);
              const v = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
              if (field === 'data') data += v + '\n';
              else if (field === 'event') eventName = v;
              else if (field === 'id') lastId = v;
            }
          }
        }
        if (this.readyState !== 2) { this.readyState = 0; this._fire('error', new Event('error')); }
      } catch {
        if (this.readyState !== 2) { this.readyState = 0; this._fire('error', new Event('error')); }
      }
    }
  }
  WorkerEventSource.CONNECTING = 0; WorkerEventSource.OPEN = 1; WorkerEventSource.CLOSED = 2;
  WorkerEventSource.prototype.CONNECTING = 0; WorkerEventSource.prototype.OPEN = 1; WorkerEventSource.prototype.CLOSED = 2;
  self.EventSource = WorkerEventSource;
  // Workers lack direct `navigator.serviceWorker` access, so WebSocket connections broker through the parent page via
  // `__zp: 'zp-broker'` messages and receive a transferred `MessagePort`. Registering the reply listener in the
  // prelude before target scripts run lets `stopImmediatePropagation()` hide control replies from target `onmessage` handlers.
  const brokerPending = newMap();
  let brokerSeq = 0;
  const canBroker = typeof self.postMessage === 'function'; // Dedicated workers only; SharedWorker uses MessagePort.
  if (canBroker) {
    self.addEventListener('message', ev => {
      const m = ev && ev.data;
      if (!m || m.__zp !== 'zp-broker-reply') return;
      try { ev.stopImmediatePropagation(); } catch {}
      const p = brokerPending.get(m.reqId);
      if (!p) return;
      brokerPending.delete(m.reqId);
      const port = ev.ports && ev.ports.length ? ev.ports[0] : null;
      if (m.ok) { m.port = port; p.resolve(m); }
      else { const err = new Error(m.error || 'NetworkError'); err.code = m.error || 'NetworkError'; p.reject(err); }
    });
  }
  function brokerToPage(payload) {
    const reqId = 'b' + (++brokerSeq);
    return new Promise((resolve, reject) => {
      brokerPending.set(reqId, { resolve, reject });
      try { self.postMessage(Object.assign({ __zp: 'zp-broker', reqId }, payload)); }
      catch (e) { brokerPending.delete(reqId); reject(e); }
    });
  }
  if (canBroker) {
    // RFC 6455 subprotocol token and close-frame validation.
    const WS_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
    const wsProtocolList = protocols => {
      if (protocols == null) return [];
      const list = typeof protocols === 'string' ? [protocols] : Array.isArray(protocols) ? protocols.slice() : null;
      if (!list) throw new DOMException('Invalid protocols', 'SyntaxError');
      const out = []; const seen = newSet();
      for (const p of list) {
        const s = String(p);
        if (!s || !WS_TOKEN_RE.test(s) || seen.has(s)) throw new DOMException('Invalid protocols', 'SyntaxError');
        seen.add(s); out.push(s);
      }
      return out;
    };
    const wsValidateClose = (code, reason) => {
      if (code !== undefined) {
        const n = Number(code);
        if (!Number.isFinite(n) || (n !== 1000 && (n < 3000 || n > 4999))) throw new DOMException('Invalid close code', 'InvalidAccessError');
      }
      if (reason !== undefined && reason !== '') {
        const len = new TextEncoder().encode(String(reason)).length;
        if (len > 123) throw new DOMException('Close reason too long', 'SyntaxError');
      }
    };
    const wsByteLen = data => typeof data === 'string' ? new TextEncoder().encode(data).length
      : data instanceof ArrayBuffer ? data.byteLength
      : (typeof Blob !== 'undefined' && data instanceof Blob) ? data.size
      : (data && typeof data.byteLength === 'number') ? data.byteLength : 0;
    const wsCloseEvent = (code, reason, wasClean) => {
      try { return new CloseEvent('close', { code, reason, wasClean }); }
      catch { const ev = new Event('close'); try { Object.defineProperties(ev, { code: { value: code }, reason: { value: reason }, wasClean: { value: wasClean } }); } catch {} return ev; }
    };
    const wsFinish = (ws, code, reason, wasClean) => {
      if (ws._closed) return;
      ws._closed = true; ws._readyState = 3;
      if (ws._closeGuard != null) { clearTimeout(ws._closeGuard); ws._closeGuard = null; }
      if (ws._port) { ws._port.onmessage = null; try { ws._port.close(); } catch {} ws._port = null; }
      ws._fire('close', wsCloseEvent(code, reason, wasClean));
    };
    const wsAbort = ws => { try { if (ws._port) ws._port.postMessage({ type: 'abort' }); } catch {} };
    const wsFail = ws => {
      if (ws._closed) return;
      wsAbort(ws);
      ws._fire('error', new Event('error'));
      wsFinish(ws, 1006, '', false);
    };
    class ZPWorkerWebSocket extends EventTarget {
      constructor(url, protocols) {
        super();
        if (arguments.length < 1) throw new TypeError("Failed to construct 'WebSocket': 1 argument required, but only 0 present.");
        let u;
        // Resolve relative URLs against the worker base and map http(s) schemes to ws(s).
        try { u = ZP.canonicalWebSocketURL(String(url), base.href.replace(/^http/, 'ws')); }
        catch (e) { throw new DOMException(String(e && e.message || e), 'SyntaxError'); }
        this._url = u.href;
        this._protocol = ''; this.extensions = '';
        this._readyState = 0;
        this._port = null; this._closed = false; this._closeGuard = null;
        this._bufferedAmount = 0; this._binaryType = 'blob';
        const plist = wsProtocolList(protocols);
        brokerToPage({ op: 'ws-open', url: this._url, protocols: plist, tabId }).then(reply => {
          if (this._closed || this._readyState === 2) {
            try { if (reply.port) reply.port.postMessage({ type: 'abort' }); } finally { if (reply.port) reply.port.close(); }
            return;
          }
          const negotiated = String(reply.protocol || '');
          if (negotiated && plist.indexOf(negotiated) < 0) { wsFail(this); return; }
          this._protocol = negotiated;
          this._port = reply.port;
          this._port.onmessage = ev => {
            if (this._closed) return;
            const m = ev.data || {};
            if (m.type === 'message') {
              let data = m.data;
              if (this._binaryType === 'blob' && data instanceof ArrayBuffer && typeof Blob !== 'undefined') {
                data = new Blob([data]);
              } else if (this._binaryType === 'arraybuffer' && typeof Blob !== 'undefined' && data instanceof Blob) {
                data.arrayBuffer().then(buf => {
                  if (this._closed) return;
                  this._fire('message', new MessageEvent('message', { data: buf, origin: new NativeURLCtor(this._url.replace(/^ws/, 'http')).origin }));
                }).catch(() => wsFail(this));
                return;
              }
              this._fire('message', new MessageEvent('message', { data, origin: new NativeURLCtor(this._url.replace(/^ws/, 'http')).origin }));
            } else if (m.type === 'error') {
              wsFail(this);
            } else if (m.type === 'close') {
              wsFinish(this, m.code, m.reason || '', m.code !== 1006);
            } else if (m.type === 'senddrained' && typeof m.bytes === 'number') {
              this._bufferedAmount = Math.max(0, this._bufferedAmount - m.bytes);
            }
          };
          if (this._port.start) this._port.start();
          this._readyState = 1;
          this._fire('open', new Event('open'));
        }).catch(() => wsFail(this));
      }
      _fire(type, ev) {
        try { this.dispatchEvent(ev); } catch {}
        const h = this['on' + type];
        if (typeof h === 'function') { try { h.call(this, ev); } catch {} }
      }
      get url() { return this._url; }
      get protocol() { return this._protocol; }
      get readyState() { return this._readyState; }
      get bufferedAmount() { return this._bufferedAmount | 0; }
      get binaryType() { return this._binaryType; }
      set binaryType(v) { const s = String(v); if (s === 'blob' || s === 'arraybuffer') this._binaryType = s; }
      send(data) {
        if (this._readyState === 0) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
        if (this._readyState !== 1 || this._closed || !this._port) return;
        const bytes = wsByteLen(data);
        this._bufferedAmount += bytes;
        if (typeof Blob !== 'undefined' && data instanceof Blob) {
          data.arrayBuffer().then(buf => {
            if (this._readyState === 1 && this._port) this._port.postMessage({ type: 'send', data: buf, bytes });
            else this._bufferedAmount = Math.max(0, this._bufferedAmount - bytes);
          }).catch(() => wsFail(this));
          return;
        }
        this._port.postMessage({ type: 'send', data, bytes });
      }
      close(code, reason) {
        wsValidateClose(code, reason);
        if (this._closed || this._readyState === 2 || this._readyState === 3) return;
        const finalCode = code === undefined ? 1000 : Number(code);
        const finalReason = reason === undefined ? '' : String(reason);
        this._readyState = 2;
        if (!this._port) { this._closeGuard = setTimeout(() => wsFail(this), 0); return; }
        this._closeGuard = setTimeout(() => {
          if (this._closed) return;
          wsAbort(this);
          wsFinish(this, 1006, '', false);
        }, 30000);
        try { this._port.postMessage({ type: 'close', code: finalCode, reason: finalReason }); }
        catch { wsFail(this); }
      }
    }
    ZPWorkerWebSocket.CONNECTING = 0; ZPWorkerWebSocket.OPEN = 1; ZPWorkerWebSocket.CLOSING = 2; ZPWorkerWebSocket.CLOSED = 3;
    try { Object.defineProperties(ZPWorkerWebSocket.prototype, { CONNECTING: { value: 0 }, OPEN: { value: 1 }, CLOSING: { value: 2 }, CLOSED: { value: 3 } }); } catch {}
    self.WebSocket = ZPWorkerWebSocket;
  } else {
    self.WebSocket = function(){ blocked(); };
  }
  self.WebSocketStream = function(){ blocked(); };
  // Route WebTransport and RTCPeerConnection through the configured gateway or TURN relay when provisioned; otherwise
  // install a stub that rejects connection attempts without exposing the client IP.
  const wtGateway = String(self.__ZP_WORKER_WT_GATEWAY || '');
  const rtcICEServers = Array.isArray(self.__ZP_WORKER_RTC_ICE) ? self.__ZP_WORKER_RTC_ICE : [];
  function workerGatewayStub(name, code, kind) {
    const reason = name + ' requires the ZeroProxy ' + kind + ' gateway, which is not yet provisioned (' + code + ').';
    const gwErr = () => { const e = new DOMException(reason, 'NotSupportedError'); try { e.zpCode = code; e.zpReason = reason; } catch {} return e; };
    const rejected = () => { const p = Promise.reject(gwErr()); try { p.catch(() => {}); } catch {} return p; };
    return class extends EventTarget {
      get signalingState() { return 'stable'; }
      get iceConnectionState() { return 'new'; }
      get iceGatheringState() { return 'new'; }
      get connectionState() { return 'new'; }
      get readyState() { return 'closed'; }
      get bufferedAmount() { return 0; }
      get bufferedAmountLowThreshold() { return 0; }
      get negotiated() { return false; }
      get ordered() { return true; }
      get reliable() { return true; }
      get label() { return ''; }
      get protocol() { return ''; }
      createOffer() { return rejected(); }
      createAnswer() { return rejected(); }
      setLocalDescription() { return rejected(); }
      setRemoteDescription() { return rejected(); }
      addIceCandidate() { return rejected(); }
      getStats() { return rejected(); }
      createBidirectionalStream() { return rejected(); }
      createUnidirectionalStream() { return rejected(); }
      createDataChannel() { throw gwErr(); }
      addTrack() { throw gwErr(); }
      createDTMFSender() { throw gwErr(); }
      addTransceiver() { throw gwErr(); }
      getSenders() { return []; }
      getReceivers() { return []; }
      getTransceivers() { return []; }
      getLocalStreams() { return []; }
      getRemoteStreams() { return []; }
      getConfiguration() { return {}; }
      send() { throw gwErr(); }
      close() {}
    };
  }
  if (typeof self.WebTransport === 'function') {
    const NativeWT = self.WebTransport;
    if (wtGateway) {
      self.WebTransport = class ZPWorkerWebTransport {
        constructor(targetUrl, opts) {
          const target = String(targetUrl == null ? '' : targetUrl);
          let parsed;
          try { parsed = new NativeURLCtor(target); } catch { throw new DOMException('Invalid URL', 'SyntaxError'); }
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'wt:') throw new DOMException('Invalid URL scheme', 'SyntaxError');
          const req = ZP.webTransportGatewayRequest(wtGateway, target, tabId, opts, self.__ZP_WORKER_WT_GATEWAY_HASHES || []);
          this._native = new NativeWT(req.url, req.options);
        }
        get ready() { try { return this._native.ready; } catch { return undefined; } }
        get closed() { try { return this._native.closed; } catch { return undefined; } }
        get datagrams() { try { return this._native.datagrams; } catch { return undefined; } }
        get incomingBidirectionalStreams() { try { return this._native.incomingBidirectionalStreams; } catch { return undefined; } }
        get incomingUnidirectionalStreams() { try { return this._native.incomingUnidirectionalStreams; } catch { return undefined; } }
        get reliability() { try { return this._native.reliability; } catch { return undefined; } }
        get congestionControl() { try { return this._native.congestionControl; } catch { return undefined; } }
        get protocol() { try { return this._native.protocol; } catch { return undefined; } }
        createBidirectionalStream(opts) { return this._native.createBidirectionalStream(opts); }
        createUnidirectionalStream(opts) { return this._native.createUnidirectionalStream(opts); }
        close(closeInfo) { try { return this._native.close(closeInfo); } catch { return undefined; } }
        addEventListener(type, listener, opts) { try { return this._native.addEventListener(type, listener, opts); } catch {} }
        removeEventListener(type, listener, opts) { try { return this._native.removeEventListener(type, listener, opts); } catch {} }
        dispatchEvent(ev) { try { return this._native.dispatchEvent(ev); } catch { return true; } }
      };
    } else {
      self.WebTransport = workerGatewayStub('WebTransport', 'WT_UNSUPPORTED', 'WebTransport');
    }
  }
  if (typeof self.RTCPeerConnection === 'function') {
    const NativeRTC = self.RTCPeerConnection;
    const ice = rtcICEServers.filter(x => x && x.urls);
    if (ice.length) {
      const RTCPeerConnection = function RTCPeerConnection(config) {
        if (!new.target) throw new TypeError("Failed to construct 'RTCPeerConnection': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
        return Reflect.construct(NativeRTC, [ZP.relayOnlyRTCConfiguration(config, ice)], new.target);
      };
      try { Object.defineProperty(RTCPeerConnection, 'prototype', { value: NativeRTC.prototype, writable: false }); } catch {}
      const nativeSet = NativeRTC.prototype.setConfiguration;
      if (typeof nativeSet === 'function') {
        try { Object.defineProperty(NativeRTC.prototype, 'setConfiguration', { value: function setConfiguration(config) { return nativeSet.call(this, ZP.relayOnlyRTCConfiguration(config, ice)); }, writable: true, configurable: true }); } catch {}
      }
      self.RTCPeerConnection = RTCPeerConnection;
    } else {
      self.RTCPeerConnection = workerGatewayStub('RTCPeerConnection', 'RTC_GATEWAY_UNAVAILABLE', 'WebRTC');
    }
    if (typeof self.webkitRTCPeerConnection === 'function') self.webkitRTCPeerConnection = self.RTCPeerConnection;
  }
  // Fail closed on `ShadowRealm.prototype.evaluate` and `importValue` to prevent unrewritten code execution.
  try {
    if (typeof self.ShadowRealm === 'function' && self.ShadowRealm.prototype) {
      const denyEval = function evaluate() { blocked(); };
      const denyImport = function importValue() { return Promise.reject(new DOMException('Blocked by ZeroProxy policy', 'NotSupportedError')); };
      Object.defineProperty(self.ShadowRealm.prototype, 'evaluate', { value: denyEval, enumerable: true, configurable: false });
      Object.defineProperty(self.ShadowRealm.prototype, 'importValue', { value: denyImport, enumerable: true, configurable: false });
    }
  } catch {}
  // Block `navigator.credentials` access because the browser credential store is keyed by the proxy origin.
  try {
    const nav = self.navigator;
    if (nav && nav.credentials) {
      const CCProto = (self.CredentialsContainer && self.CredentialsContainer.prototype) || Object.getPrototypeOf(nav.credentials);
      const denyGet = function get() { return Promise.reject(new DOMException('Blocked by ZeroProxy policy', 'NotAllowedError')); };
      const denyStore = function store() { return Promise.reject(new DOMException('Blocked by ZeroProxy policy', 'NotAllowedError')); };
      const denyCreate = function create() { return Promise.reject(new DOMException('Blocked by ZeroProxy policy', 'NotAllowedError')); };
      const allowPrevent = function preventSilentAccess() { return Promise.resolve(undefined); };
      const t = CCProto || nav.credentials;
      Object.defineProperty(t, 'get', { value: denyGet, enumerable: true, configurable: false });
      Object.defineProperty(t, 'store', { value: denyStore, enumerable: true, configurable: false });
      Object.defineProperty(t, 'create', { value: denyCreate, enumerable: true, configurable: false });
      Object.defineProperty(t, 'preventSilentAccess', { value: allowPrevent, enumerable: true, configurable: false });
      if (typeof self.PublicKeyCredential === 'function') {
        Object.defineProperty(self.PublicKeyCredential, 'isUserVerifyingPlatformAuthenticator', { value: function(){ return Promise.resolve(false); }, enumerable: true, configurable: false });
        Object.defineProperty(self.PublicKeyCredential, 'isConditionalMediationAvailable', { value: function(){ return Promise.resolve(false); }, enumerable: true, configurable: false });
      }
    }
  } catch {}
  // Prefix `navigator.locks` names with the target origin namespace to isolate lock scopes across targets.
  try {
    const nav = self.navigator;
    const lm = nav && nav.locks;
    if (lm && typeof lm.request === 'function') {
      const LMProto = (self.LockManager && self.LockManager.prototype) || Object.getPrototypeOf(lm);
      const pfx = ns + 'lk:';
      const nativeRequest = LMProto.request && LMProto.request.bind ? LMProto.request : null;
      const nativeQuery = LMProto.query;
      const strip = i => (i && typeof i === 'object' && typeof i.name === 'string' && i.name.indexOf(pfx) === 0) ? Object.assign({}, i, { name: i.name.slice(pfx.length) }) : i;
      if (typeof nativeRequest === 'function') {
        Object.defineProperty(LMProto, 'request', { value: function request(name, ...rest) { return nativeRequest.call(this, pfx + String(name), ...rest); }, enumerable: true, configurable: false });
      }
      if (typeof nativeQuery === 'function') {
        Object.defineProperty(LMProto, 'query', { value: function query() { return nativeQuery.call(this).then(r => ({ held: (r && r.held || []).map(strip), pending: (r && r.pending || []).map(strip) })); }, enumerable: true, configurable: false });
      }
    }
  } catch {}
  // Sanitize `Error.stack` and `CallSite` filenames so proxy worker routes (`/zp/api/worker-script?u=...`) and
  // internal `__zp_` helper names are replaced with virtual target URLs and `<anonymous>`.
  (function installStackSanitizer() {
    const E = self.Error;
    if (!E) return;
    const proxyOrigin = realProxyOrigin;
    const scanRE = new RegExp(proxyOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[A-Za-z0-9\\-._~:/?#\\[\\]@!$&*+,;=%]*', 'g');
    function deproxyOne(m) {
      try {
        const u = new NativeURLCtor(m);
        if (u.origin !== proxyOrigin) return m;
        if (u.pathname === '/zp/api/worker-script' || u.pathname === '/zp/api/script') return u.searchParams.get('u') || m;
        if (u.pathname.startsWith('/zp/')) return base.href;
      } catch {}
      return m;
    }
    const sanitize = v => v == null ? v : String(v).replace(scanRE, deproxyOne).replace(/\b__zp_[A-Za-z0-9_$]*/g, '<anonymous>');
    let userPrepare = null;
    let inUserPrepare = false;
    const zpPrepare = function (error, frames) {
      const wrapped = frames.map(f => new Proxy(f, {
        get(t, p) {
          const v = Reflect.get(t, p, t);
          if (typeof v !== 'function') return v;
          if (p === 'getFileName' || p === 'getScriptNameOrSourceURL' || p === 'getEvalOrigin' || p === 'toString') {
            return function () { return sanitize(v.apply(t, arguments)); };
          }
          return v.bind(t);
        }
      }));
      if (userPrepare && !inUserPrepare) {
        inUserPrepare = true;
        try { return userPrepare(error, wrapped); } finally { inUserPrepare = false; }
      }
      let head;
      try { head = String(error); } catch { head = 'Error'; }
      let out = head;
      for (const f of wrapped) { try { out += '\n    at ' + f.toString(); } catch {} }
      return out;
    };
    const listHook = enumerable => { try { Object.defineProperty(E, 'prepareStackTrace', { enumerable }); } catch {} };
    try {
      Object.defineProperty(E, 'prepareStackTrace', {
        get() { return zpPrepare; },
        set(v) {
          stackHook.exists = true;
          stackHook.value = v;
          userPrepare = typeof v === 'function' && v !== zpPrepare ? v : null;
          listHook(true);
        },
        configurable: true, enumerable: false
      });
      stackHook.ctor = E;
      stackHook.forget = () => { stackHook.exists = false; stackHook.value = undefined; userPrepare = null; listHook(false); };
    } catch {}
  })();

  // Guard `.bind` when `self.importScripts` is absent in module workers.
  const nativeImportScripts = typeof self.importScripts === 'function' ? self.importScripts.bind(self) : null;
  // Track `Blob` objects created in this worker realm so `importScripts(blob:)` can read their source synchronously.
  const blobURLObjects = newMap();
  try {
    const NativeURL = self.URL;
    const nativeCreateObjectURL = NativeURL && NativeURL.createObjectURL;
    if (typeof nativeCreateObjectURL === 'function') {
      Object.defineProperty(NativeURL, 'createObjectURL', {
        value: function createObjectURL(obj) {
          const u = nativeCreateObjectURL.call(NativeURL, obj);
          try { blobURLObjects.set(new NativeURLCtor(u).href, obj); } catch {}
          return u;
        },
        writable: true, enumerable: true, configurable: false,
      });
      const nativeRevoke = NativeURL.revokeObjectURL;
      if (typeof nativeRevoke === 'function') {
        Object.defineProperty(NativeURL, 'revokeObjectURL', {
          value: function revokeObjectURL(u) { try { blobURLObjects.delete(new NativeURLCtor(String(u)).href); } catch {} return nativeRevoke.call(NativeURL, u); },
          writable: true, enumerable: true, configurable: false,
        });
      }
    }
  } catch {}
  function readVirtualScriptSource(parsed) {
    if (parsed.protocol === 'data:') {
      const href = parsed.href;
      const comma = href.indexOf(',');
      if (comma < 0) blockedDynamic();
      const meta = href.slice(5, comma);
      const dataStr = href.slice(comma + 1);
      if (/;base64/i.test(meta)) {
        const bin = atob(dataStr);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder().decode(bytes);
      }
      return decodeURIComponent(dataStr);
    }
    if (parsed.protocol === 'blob:') {
      const blob = blobURLObjects.get(parsed.href);
      if (blob) return new FileReaderSync().readAsText(blob);
      // Fall back to a synchronous XHR for same-origin `blob:` URLs minted in the parent page realm.
      try {
        const nx = new NativeWorkerXHR();
        nx.open('GET', parsed.href, false);
        nx.send();
        if (nx.status === 200 || nx.status === 0) return nx.responseText;
      } catch {}
      blockedDynamic();
    }
    blockedDynamic();
  }
  function importScriptURL(raw) {
    const value = String(raw);
    const internal = new NativeURLCtor(value, realLocation.href);
    if (internal.origin === realProxyOrigin && internal.pathname === '/zp/api/worker-script') return internal.pathname + internal.search + internal.hash;
    const parsed = new NativeURLCtor(value, base.href);
    return '/zp/api/worker-script?tab=' + encodeURIComponent(tabId) + '&u=' + encodeURIComponent(ZP.canonicalTargetURL(parsed.href, base.href).href);
  }
  self.importScripts = (...urls) => {
    if (!nativeImportScripts) blocked();
    // Where the worker enforces Trusted Types every argument is checked before any script loads, as the engine does.
    const given = urls.map(u => ttCompliant('ScriptURL', 'WorkerGlobalScope importScripts', u));
    for (const raw of given) {
      // Pass internal proxy routes directly to `nativeImportScripts` before resolving relative to a `blob:` or `data:` worker base URL.
      let internal = null;
      try { internal = new NativeURLCtor(String(raw), realLocation.href); } catch {}
      if (internal && internal.origin === realProxyOrigin &&
          (internal.pathname === '/zp/api/worker-script' || internal.pathname === '/zp/api/script' ||
           internal.pathname.startsWith('/zp/assets/') || internal.pathname.startsWith('/__zp/'))) {
        nativeImportScripts(ttScriptURL(internal.pathname + internal.search + internal.hash));
        continue;
      }
      const parsed = new NativeURLCtor(String(raw), base.href);
      // Delegate to `nativeImportScripts` in module workers so the browser throws its native `TypeError`.
      if (!isModuleWorker && (parsed.protocol === 'data:' || parsed.protocol === 'blob:')) {
        workerExecGlobal(zpRewrite(readVirtualScriptSource(parsed)), false);
      } else {
        nativeImportScripts(ttScriptURL(importScriptURL(raw)));
      }
    }
  };
  // Share the same `base` object with the `with`-scope facade so `location === self.location` holds.
  try {
    Object.defineProperty(self, 'location', { value: base, writable: false, enumerable: true, configurable: true });
  } catch {}
  // Derive `isSecureContext` from `contextURL` (`creatorRef` for `blob:`/`data:` workers) rather than the proxy origin.
  const workerSecureContext = contextURL.protocol === 'https:' || contextURL.protocol === 'wss:' || contextURL.protocol === 'file:'
    || /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(contextURL.hostname) || /\.localhost$/i.test(contextURL.hostname);
  try { Object.defineProperty(self, 'origin', { get: () => workerOrigin, enumerable: true, configurable: true }); } catch {}
  try { Object.defineProperty(self, 'isSecureContext', { get: () => workerSecureContext, enumerable: true, configurable: true }); } catch {}
  // Strip the internal `zp:w:<hash>:` partition prefix from `self.name` in `SharedWorker` realms.
  try {
    const realName = self.name;
    const stripped = /^zp:w:[0-9a-f]{8}:/.test(realName) ? realName.replace(/^zp:w:[0-9a-f]{8}:/, '') : realName;
    if (stripped !== realName) Object.defineProperty(self, 'name', { value: stripped, writable: false, enumerable: true, configurable: true });
  } catch {}
  // Unwrap proxy routing URLs passed to `new URL(...)` and synthesize a virtual-origin `blob:` base for `blob:` workers.
  try {
    const NativeURLCtor = self.URL;
    const urlBase = (() => {
      if (base.protocol === 'blob:' && creatorRef) {
        try { const inner = new NativeURLCtor(base.href.slice(5)); return 'blob:' + creatorRef.origin + inner.pathname; } catch {}
      }
      return base.href;
    })();
    const unleashed = raw => {
      const s = String(raw);
      let u = null; try { u = new NativeURLCtor(s, realLocation.href); } catch { return s; }
      if (u.origin !== realProxyOrigin) return s;
      if (u.pathname === '/zp/api/worker-script' || u.pathname === '/zp/api/script') { const t = u.searchParams.get('u'); if (t) return t; }
      if (u.pathname.startsWith('/zp/')) return urlBase;
      return s;
    };
    const ZPWorkerURL = function URL(input, b) {
      const inp = unleashed(input);
      return b !== undefined ? new NativeURLCtor(inp, unleashed(b)) : new NativeURLCtor(inp);
    };
    try { ZPWorkerURL.prototype = NativeURLCtor.prototype; } catch {}
    for (const sm of ['createObjectURL', 'revokeObjectURL', 'canParse', 'parse']) {
      const orig = NativeURLCtor[sm];
      if (typeof orig !== 'function') continue;
      ZPWorkerURL[sm] = (sm === 'canParse' || sm === 'parse')
        ? function (u, b) { return b !== undefined ? orig.call(NativeURLCtor, unleashed(u), unleashed(b)) : orig.call(NativeURLCtor, unleashed(u)); }
        : orig.bind(NativeURLCtor);
      try { Object.defineProperty(ZPWorkerURL[sm], 'name', { value: sm, configurable: true }); } catch {}
    }
    Object.defineProperty(self, 'URL', { value: ZPWorkerURL, writable: true, enumerable: true, configurable: true });
    if (self.webkitURL) try { Object.defineProperty(self, 'webkitURL', { value: ZPWorkerURL, writable: true, enumerable: true, configurable: true }); } catch {}
  } catch {}
  // Partition `BroadcastChannel` names by virtual origin (`zp:b:<fnv(origin)>:`) to match the page realm.
  try {
    const NativeBC = self.BroadcastChannel;
    if (NativeBC) {
      let h = 0x811c9dc5;
      for (let i = 0; i < storageOrigin.length; i++) { h ^= storageOrigin.charCodeAt(i); h = Math.imul(h, 16777619); }
      const bcPrefix = 'zp:b:' + ('00000000' + (h >>> 0).toString(16)).slice(-8) + ':';
      const ZPWorkerBC = function BroadcastChannel(name) {
        const requested = String(name);
        const ch = new NativeBC(bcPrefix + requested);
        try { Object.defineProperty(ch, 'name', { value: requested, configurable: true, enumerable: true }); } catch {}
        return ch;
      };
      try { ZPWorkerBC.prototype = NativeBC.prototype; } catch {}
      Object.defineProperty(self, 'BroadcastChannel', { value: ZPWorkerBC, writable: true, enumerable: true, configurable: true });
    }
  } catch {}
  try {
    if (self.webkitIndexedDB && self.indexedDB) {
      Object.defineProperty(self, 'webkitIndexedDB', { value: self.indexedDB, writable: true, enumerable: true, configurable: true });
    }
  } catch {}
  // Scope `navigator.storage.getDirectory()` to a per-target-origin OPFS subdirectory and mask its `.name` as `""`.
  try {
    const storageMgr = self.navigator && self.navigator.storage;
    if (storageMgr && typeof storageMgr.getDirectory === 'function') {
      const nativeGetDirectory = storageMgr.getDirectory.bind(storageMgr);
      let oh = 0x811c9dc5;
      for (let i = 0; i < storageOrigin.length; i++) { oh ^= storageOrigin.charCodeAt(i); oh = Math.imul(oh, 16777619); }
      const opfsRoot = 'zp:o:' + ('00000000' + (oh >>> 0).toString(16)).slice(-8);
      storageMgr.getDirectory = function getDirectory() {
        return nativeGetDirectory().then(d => d.getDirectoryHandle(opfsRoot, { create: true }));
      };
      const FSH = self.FileSystemHandle && self.FileSystemHandle.prototype;
      const nameDesc = FSH && Object.getOwnPropertyDescriptor(FSH, 'name');
      if (nameDesc && typeof nameDesc.get === 'function' && nameDesc.configurable) {
        const nativeName = nameDesc.get;
        Object.defineProperty(FSH, 'name', {
          get: function name() { const n = nativeName.call(this); return n === opfsRoot ? '' : n; },
          enumerable: nameDesc.enumerable, configurable: true,
        });
      }
    }
  } catch {}
  // Block legacy WebKit filesystem and quota APIs that bypass OPFS origin partitioning.
  for (const legacy of ['webkitRequestFileSystem', 'webkitResolveLocalFileSystemURL', 'webkitRequestFileSystemSync', 'webkitResolveLocalFileSystemURLSync']) {
    try { if (self[legacy]) Object.defineProperty(self, legacy, { value: function() { throw new DOMException('Blocked by ZeroProxy policy', 'NotSupportedError'); }, writable: true, enumerable: true, configurable: true }); } catch {}
  }
  for (const legacy of ['webkitPersistentStorage', 'webkitTemporaryStorage']) {
    try { if (self[legacy]) Object.defineProperty(self, legacy, { value: undefined, writable: true, enumerable: true, configurable: true }); } catch {}
  }
  // Execute or import `blob:`/`data:` worker entrypoints passed via `__ZP_WORKER_SRC_URL`.
  const srcuSource = String(self.__ZP_WORKER_SRC_URL || '');
  if (srcuSource) {
    if (!isModuleWorker) {
      self.__zp_runSrcu = function () {
        try { workerExecGlobal(zpRewrite(readVirtualScriptSource(new NativeURLCtor(srcuSource))), false); }
        catch (e) { setTimeout(() => { throw e; }, 0); }
      };
    } else {
      // Module workers cannot evaluate module syntax via `eval`, so stash the source in the SW via the page broker and `import()` the `srctok` route.
      (async () => {
        const r = await nativeFetch(srcuSource);
        const src = await r.text();
        const reply = await brokerToPage({ op: 'stash', src });
        if (!reply || !reply.tok) throw new Error('stash failed');
        await import('/zp/api/worker-script?srctok=' + encodeURIComponent(reply.tok) + '&tab=' + encodeURIComponent(tabId) + '&u=' + encodeURIComponent(srcuSource) + '&kind=module');
      })().catch(e => { setTimeout(() => { throw e; }, 0); });
    }
  }
  // Rewrite proxy resource timing entry names back to virtual target URLs and filter out internal proxy infrastructure entries.
  try {
    const entryProto = self.PerformanceEntry && self.PerformanceEntry.prototype;
    const nameDesc = entryProto && Object.getOwnPropertyDescriptor(entryProto, 'name');
    const perfProto = self.Performance && self.Performance.prototype;
    if (nameDesc && typeof nameDesc.get === 'function' && perfProto) {
      const rawName = e => Reflect.apply(nameDesc.get, e, []);
      const targetOf = n => {
        if (typeof n !== 'string') return n;
        if (n.lastIndexOf('blob:' + realProxyOrigin, 0) === 0) return null;
        if (n.lastIndexOf(realProxyOrigin, 0) !== 0) return n;
        let u; try { u = new NativeURLCtor(n); } catch { return null; }
        if (u.pathname === '/zp/api/fetch' || u.pathname === '/zp/api/v2/fetch') return u.searchParams.get('url') || null;
        if (u.pathname === '/zp/api/script') return u.searchParams.get('u') || null;
        return null;
      };
      const isInfra = e => { try { return targetOf(rawName(e)) === null; } catch { return false; } };
      const shown = list => Array.prototype.filter.call(list, e => !isInfra(e));
      Object.defineProperty(entryProto, 'name', {
        get: Object.getOwnPropertyDescriptor({ get name() { const n = rawName(this); const t = targetOf(n); return t === null ? n : t; } }, 'name').get,
        enumerable: nameDesc.enumerable, configurable: true,
      });
      for (const proto of [entryProto, self.PerformanceResourceTiming && self.PerformanceResourceTiming.prototype]) {
        const nativeToJSON = proto && Object.prototype.hasOwnProperty.call(proto, 'toJSON') ? proto.toJSON : null;
        if (typeof nativeToJSON !== 'function') continue;
        proto.toJSON = ({ toJSON() { const out = Reflect.apply(nativeToJSON, this, []); try { if (out && 'name' in out) out.name = this.name; } catch {} return out; } }).toJSON;
      }
      const nativeGetEntries = perfProto.getEntries, nativeByType = perfProto.getEntriesByType;
      perfProto.getEntries = ({ getEntries() { return shown(Reflect.apply(nativeGetEntries, this, [])); } }).getEntries;
      perfProto.getEntriesByType = ({ getEntriesByType(type) { return shown(Reflect.apply(nativeByType, this, [type])); } }).getEntriesByType;
      perfProto.getEntriesByName = ({ getEntriesByName(name, type) {
        const wanted = String(name);
        const all = type === undefined ? Reflect.apply(nativeGetEntries, this, []) : Reflect.apply(nativeByType, this, [type]);
        return Array.prototype.filter.call(shown(all), e => e.name === wanted);
      } }).getEntriesByName;
      const NativePO = self.PerformanceObserver;
      if (typeof NativePO === 'function') {
        const ZPPerformanceObserver = function PerformanceObserver(cb) {
          const wrapped = typeof cb !== 'function' ? cb : function (list, obs) {
            const filtered = {
              getEntries: () => shown(list.getEntries()),
              getEntriesByType: t => shown(list.getEntriesByType(t)),
              getEntriesByName: (n, t) => shown(list.getEntriesByName(n, t)),
            };
            try { Object.setPrototypeOf(filtered, Object.getPrototypeOf(list)); } catch {}
            return cb.call(this, filtered, obs);
          };
          return Reflect.construct(NativePO, [wrapped], new.target || ZPPerformanceObserver);
        };
        ZPPerformanceObserver.prototype = NativePO.prototype;
        try { Object.defineProperty(ZPPerformanceObserver, 'supportedEntryTypes', Object.getOwnPropertyDescriptor(NativePO, 'supportedEntryTypes')); } catch {}
        self.PerformanceObserver = ZPPerformanceObserver;
      }
    }
  } catch {}
  // Hide internal `__ZP_WORKER_*`, `__zp_*`, and `ZP` globals from key enumeration and descriptor queries.
  const nativeGOPN = Object.getOwnPropertyNames, nativeOwnKeys = Reflect.ownKeys, nativeGOPDs = Object.getOwnPropertyDescriptors;
  const isGlobalTarget = t => t === self || t === scope;
  const visibleKey = k => typeof k !== 'string' || !ZP_HIDDEN_RE.test(k);
  const hideZPNames = () => {
    for (const k of Reflect.apply(nativeGOPN, Object, [self])) {
      if (!ZP_HIDDEN_RE.test(k)) continue;
      const d = Object.getOwnPropertyDescriptor(self, k);
      if (d && d.enumerable && d.configurable) try { Object.defineProperty(self, k, { enumerable: false }); } catch {}
    }
  };
  try {
    Object.getOwnPropertyNames = ({ getOwnPropertyNames(o) { const out = Reflect.apply(nativeGOPN, Object, [o]); return isGlobalTarget(o) ? out.filter(visibleKey) : out; } }).getOwnPropertyNames;
    Reflect.ownKeys = ({ ownKeys(o) { const out = Reflect.apply(nativeOwnKeys, Reflect, [o]); return isGlobalTarget(o) ? out.filter(visibleKey) : out; } }).ownKeys;
    Object.getOwnPropertyDescriptors = ({ getOwnPropertyDescriptors(o) {
      const out = Reflect.apply(nativeGOPDs, Object, [o]);
      if (isGlobalTarget(o)) for (const k of Reflect.apply(nativeOwnKeys, Reflect, [out])) if (!visibleKey(k)) delete out[k];
      return out;
    } }).getOwnPropertyDescriptors;
  } catch {}
  hideZPNames();
  // Restore pre-prelude prototype placement, descriptor flags, `name`, `length`, and `Function.prototype.toString` output on wrapped globals.
  (function settleNatives() {
    const toStringHook = ({ toString() { const m = maskedSource.get(this); return m !== undefined ? m : Reflect.apply(origFnToString, this, []); } }).toString;
    try { Object.defineProperty(Function.prototype, 'toString', { value: toStringHook, writable: true, enumerable: false, configurable: true }); } catch {}
    const mirror = (fn, nat) => {
      if (typeof fn !== 'function' || typeof nat !== 'function' || fn === nat) return;
      try { maskedSource.set(fn, Reflect.apply(origFnToString, nat, [])); } catch {}
      try { Object.defineProperty(fn, 'name', { value: nat.name, configurable: true }); } catch {}
      try { Object.defineProperty(fn, 'length', { value: nat.length, configurable: true }); } catch {}
    };
    const settle = (obj, key, nat) => {
      const cur = Object.getOwnPropertyDescriptor(obj, key);
      if (!cur || !nat) return;
      if (cur.value === nat.value && cur.get === nat.get && cur.set === nat.set && cur.enumerable === nat.enumerable
          && cur.configurable === nat.configurable && cur.writable === nat.writable) return;
      mirror(cur.value, nat.value); mirror(cur.get, nat.get); mirror(cur.set, nat.set);
      if (!cur.configurable) return;
      const next = 'value' in cur
        ? { value: cur.value, writable: 'writable' in nat ? nat.writable : true, enumerable: nat.enumerable, configurable: nat.configurable }
        : { get: cur.get, set: cur.set, enumerable: nat.enumerable, configurable: nat.configurable };
      try { Object.defineProperty(obj, key, next); } catch {}
    };
    const settleMembers = (obj, natMap) => {
      if (!obj || !natMap) return;
      for (const [k, nat] of natMap) if (Object.prototype.hasOwnProperty.call(obj, k)) settle(obj, k, nat);
    };
    for (const [key, { owner, desc: nat }] of nativeSnapshot.global) {
      const own = owner === self ? null : Object.getOwnPropertyDescriptor(self, key);
      if (own && own.configurable) {
        let moved;
        if ('get' in nat && 'value' in own) {
          const v = own.value;
          moved = { get: Object.getOwnPropertyDescriptor({ get [key]() { return v; } }, key).get, set: undefined, enumerable: nat.enumerable, configurable: nat.configurable };
        } else if ('get' in own) {
          moved = { get: own.get, set: own.set, enumerable: nat.enumerable, configurable: nat.configurable };
        } else {
          moved = { value: own.value, writable: nat.writable, enumerable: nat.enumerable, configurable: nat.configurable };
        }
        try { delete self[key]; Object.defineProperty(owner, key, moved); } catch {}
      }
      settle(owner, key, nat);
      const cur = Object.getOwnPropertyDescriptor(owner, key);
      const natV = nat.value, curV = cur && cur.value;
      if (typeof natV === 'function' && typeof curV === 'function' && curV !== natV) {
        settleMembers(curV, nativeSnapshot.members.get(natV));
        try { if (curV.prototype && natV.prototype && curV.prototype !== natV.prototype) settleMembers(curV.prototype, nativeSnapshot.members.get(natV.prototype)); } catch {}
      }
    }
    for (const [obj, natMap] of nativeSnapshot.members) settleMembers(obj, natMap);
    mirror(toStringHook, origFnToString);
  })();
  // Re-run `hideZPNames` after the bootstrap loads `zp-page-bundle.js` so `ZPBundle` is also non-enumerable.
  expose('__zp_settle', hideZPNames);
})();

