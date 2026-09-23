(() => {
  'use strict';
  if (self.__ZP_WORKER_PRELUDE) return;
  Object.defineProperty(self, '__ZP_WORKER_PRELUDE', { value: true, enumerable: false, configurable: false });
  // module 워커에서 importScripts 는 "없음"이 아니라 **던지는 스텁**으로
  // 존재한다(Chrome: 호출 시 TypeError) — `typeof` 가드로는 못 걸러서
  // bootstrap 해시의 mod=1 로 명시 판정한다. 그쪽 부트스트랩이 zp-core 를
  // import() 로 먼저 싣고 온다(이 줄은 classic 경로 전용).
  // 실제 워커 location 은 부트스트랩 URL 이다 — prelude 내부가 프록시 오리진/
  // 해시를 읽을 때 쓰는 진짜 핸들. 끝에서 `self.location` 을 가상 `base` 로
  // 재정의하므로 내부 경로는 이 캡처값을 써야 한다.
  const realLocation = self.location;
  const realProxyOrigin = realLocation.origin;
  const isModuleWorker = new URLSearchParams(realLocation.hash.slice(1)).get('mod') === '1';
  if (!isModuleWorker) importScripts('/zp/assets/zp-core.js');
  const nativeFetch = self.fetch.bind(self);
  const base = new URL(self.__ZP_WORKER_TARGET || 'https://invalid.local/');
  const tabId = String(self.__ZP_WORKER_TAB_ID || '');
  const blockedDynamic = function(){ try { throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError'); } catch(e) { throw e; } };
  // ── 워커 재작성기 (W1/W2) ─────────────────────────────────────────────
  // 부트스트랩이 `/zp/assets/zp-page-bundle.js` 를 싣는다 — self-contained
  // (wasm 인라인 + initSync) 라 워커에서 `self.ZPBundle` 로 바로 선다. 부재
  // 시 모든 동적 코드 경로는 기존처럼 fail-closed 다.
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
  // expression/statement 구분은 페이지 dynamicEval 과 같은 휴리스틱.
  const EXPR_STMT_RE = /^(?:function|class|var|let|const|if|for|while|do|switch|try|throw|return|break|continue|with|import|export|debugger)\b/;
  function workerDynamicEval(source) {
    // 네이티브 eval 은 생성자가 아니다 — `new eval()` 은 TypeError.
    if (new.target) throw new TypeError('eval is not a constructor');
    if (arguments.length === 0) return undefined;
    const text = String(source);
    if (!EXPR_STMT_RE.test(text.trimStart())) {
      try {
        const rw = zpRewrite(text);
        const expr = Reflect.construct(NativeFunctionCtor, ['__zp_scope', 'with(__zp_scope){return (' + rw + '\n);}']);
        return Reflect.apply(expr, self, [scope]);
      } catch (e) { if (e && e.name === 'NotSupportedError') throw e; }
    }
    // 문 형태는 전역(indirect) eval — top-level var/function 이 워커 전역에
    // 살아야 한다 (페이지 execGlobalScript 와 같은 이유). eval 렉시컬
    // 환경은 버려지므로 isEval=true.
    return workerExecGlobal(zpRewrite(text), true);
  }
  function workerDynamicFunction(ctor, args) {
    const parts = args.map(String);
    const body = parts.length ? parts.pop() : '';
    const kind = ctor === NativeAsyncFunctionCtor ? 'async function'
      : ctor === NativeGeneratorFunctionCtor ? 'function*'
      : ctor === NativeAsyncGeneratorFunctionCtor ? 'async function*' : 'function';
    const wrapped = kind + ' __zp_dynamic__(' + parts.join(',') + '){\n' + body + '\n}';
    const code = zpRewrite(wrapped);
    const open = code.indexOf('{'), close = code.lastIndexOf('}');
    if (open < 0 || close <= open) blockedDynamic();
    const inner = code.slice(open + 1, close);
    const compiled = Reflect.construct(ctor, parts.concat([inner]));
    // sloppy body 의 nullish this 는 진짜 globalThis 로 강제변환되어
    // `this.location` 이 부트스트랩 URL 을 새게 한다 — scope 파사드로 대체.
    const sloppy = !/^\s*['"]use strict['"]/.test(body);
    const fn = function anonymous() {
      'use strict';
      const t = sloppy && (this == null || this === self) ? scope : this;
      return new.target ? Reflect.construct(compiled, arguments, new.target) : Reflect.apply(compiled, t, arguments);
    };
    try { Object.defineProperty(fn, 'prototype', { value: ctor.prototype, enumerable: false, configurable: false, writable: false }); } catch {}
    return fn;
  }
  // strict 모드에서는 `function eval` 선언이 불법 — 이름은 디스크립터로 심는다.
  const workerEval = function (s) { if (new.target) throw new TypeError('eval is not a constructor'); return workerDynamicEval.apply(this, arguments); };
  // ── R2: direct `eval(x)` 호출자 스코프 (페이지 zpDirectEval 와 동형) ──
  // sloppy Function-ctor 헬퍼의 `eval` 파라미터가 intrinsic 이라
  // `eval(__zp_src)` 가 진짜 direct eval 이 된다. desc 접근자는 call-site
  // 어휘 위치에서 실행되어 호출자 지역을 노출하고, `.call(this)` 가 thisEnv
  // 를 전달한다.
  const zpDirectEvalRunner = Reflect.construct(NativeFunctionCtor, ['eval', '__zp_env', '__zp_src', 'return eval(__zp_src)']);
  var __zp_eval_desc = null;
  function workerDirectEval(callee, args, desc, callerStrict) {
    if (new.target) throw new TypeError('eval is not a constructor');
    if (callee !== workerEval) return Reflect.apply(callee, undefined, Array.isArray(args) ? args : []);
    const src = args && args.length ? args[0] : undefined;
    if (typeof src !== 'string') return src;
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
    __zp_lex_env = new Map();
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
      // sourceURL — eval 소스 에러 filename 을 가상 워커 URL 로 태깅.
      const body = strictSrc ? '"use strict";' + rewritten : 'with(__zp_env){' + rewritten + '\n}';
      return zpDirectEvalRunner.call(this, nativeEval, env, body + '\n//# sourceURL=' + base.href);
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
  // `.constructor` 로 native ctor 를 꺼내는 우회를 닫는다 —
  // `({}).constructor.constructor === Function` 이 페이지와 같이 wrapper 를
  // 가리키게 각 intrinsic prototype 의 constructor 를 바꿔 친다.
  for (const [ctor, wrapper] of [
    [NativeFunctionCtor, workerFunction],
    [NativeAsyncFunctionCtor, workerAsyncFunction],
    [NativeGeneratorFunctionCtor, workerGeneratorFunction],
    [NativeAsyncGeneratorFunctionCtor, workerAsyncGeneratorFunction],
  ]) {
    try { Object.defineProperty(ctor.prototype, 'constructor', { value: wrapper, enumerable: false, configurable: false, writable: true }); } catch {}
    try { Object.defineProperty(wrapper, 'name', { value: ctor.prototype.constructor.name || 'Function', configurable: true }); } catch {}
  }
  // R1: 워커 스크립트의 top-level let/const/class 도 공유 전역 렉시컬
  // 환경에 산다 — 페이지 zpLex 와 동형. eval 렉시컬 환경은 버려지므로
  // 리라이터가 심은 __zp_lex_decl/__zp_lex_bind 가 accessor 클로저를
  // 여기 보존하고, scope 프록시가 식별자 해석 시 먼저 consult 한다.
  const zpLex = new Map();
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
  // 충돌 이름을 반환(throw 는 방출 코드 — 페이지와 같은 이유: prelude
  // 에서 던지면 에러 filename 이 prelude URL 을 샌다). 2-패스 부분 등록
  // 방지.
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
  // 전역-스크립트 위치의 재작성 코드 실행 — sloppy 는 렉시컬 환경을
  // with(lexScope) 로 에뮬레이션. isEval 면 버리는 환경(네이티브 eval
  // 렉시컬 환경 의미). strict 소스는 with 불가 — 래핑 생략(잔여 gap).
  const ZP_STRICT_DIRECTIVE_RE = /^(\s|\/\*[^]*?\*\/|\/\/[^\n]*)*('use strict'|"use strict")/;
  const workerExecGlobal = (code, isEval) => {
    const prevLexEnv = __zp_lex_env;
    if (isEval) __zp_lex_env = new Map();
    // sourceURL — eval'd 코드의 에러 filename 이 가상 워커 URL 을 가리키게.
    const tagged = '\n//# sourceURL=' + base.href;
    try {
      if (ZP_STRICT_DIRECTIVE_RE.test(code)) return nativeEval.call(self, code + tagged);
      return nativeEval.call(self, 'with(__zp_lex_scope){' + code + '\n}' + tagged);
    } finally {
      __zp_lex_env = prevLexEnv;
    }
  };
  const scope = new Proxy(self, {
    has(_target, prop) { return prop !== Symbol.unscopables; },
    get(target, prop) {
      if (prop === Symbol.unscopables) return undefined;
      const le = zpLexEntry(prop);
      if (le) return zpLexRead(le, prop);
      if (prop === 'self' || prop === 'globalThis' || prop === 'window' || prop === 'top' || prop === 'parent' || prop === 'frames') return scope;
      if (prop === 'location') return base;
      if (prop === 'eval') return workerEval;
      if (prop === 'Function') return workerFunction;
      return Reflect.get(target, prop);
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
  function get(target, prop) {
    if (typeof prop !== 'symbol') prop = String(prop);
    {
      const d = __zp_eval_desc;
      if (d && isWorkerGlobal(target) && typeof prop === 'string'
          && Object.prototype.hasOwnProperty.call(d, prop)) return d[prop];
    }
    if (isWorkerGlobal(target)) {
      // R1: bare 식별자 경로는 전역 렉시컬 우선 — `self.x` 멤버 읽기가
      // 렉시컬을 보는 잔여 divergence 는 허용(동형 이름 let 선언 필요).
      const le = zpLexEntry(prop);
      if (le) return zpLexRead(le, prop);
      if (prop === 'self' || prop === 'globalThis' || prop === 'window' || prop === 'top' || prop === 'parent' || prop === 'frames') return scope;
      if (prop === 'location') return base;
      if (prop === 'eval') return workerEval;
      if (prop === 'Function') return workerFunction;
    }
    const actual = workerTarget(target);
    const value = Reflect.get(Object(actual), prop);
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
    return isWorkerGlobal(target) && prop === 'location' || Reflect.has(Object(workerTarget(target)), prop);
  }
  function getOwnPropertyDescriptor(target, prop) {
    if (isWorkerGlobal(target) && prop === 'location') return { value: base, configurable: true, enumerable: true, writable: false };
    return Reflect.getOwnPropertyDescriptor(Object(workerTarget(target)), prop);
  }
  function ownKeys(target) { return Reflect.ownKeys(Object(workerTarget(target))); }
  expose('__zp_get', get);
  expose('__zp_set', set);
  expose('__zp_assign', assign);
  expose('__zp_call', call);
  expose('__zp_update', update);
  expose('__zp_construct', construct);
  expose('__zp_has', has);
  expose('__zp_getOwnPropertyDescriptor', getOwnPropertyDescriptor);
  expose('__zp_ownKeys', ownKeys);
  expose('__zp_module_url', (specifier, referrer) => {
    const spec = String(specifier);
    if (!spec.startsWith('/') && !spec.startsWith('./') && !spec.startsWith('../') && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec)) throw new TypeError('Blocked by ZeroProxy rewrite policy');
    const u = new URL(spec, referrer || base.href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw blockedDynamic();
    // Proxy-origin ABSOLUTE. A root-relative path resolves against the
    // worker's virtualized base (the target origin), so the request would be
    // sent to the target host and 404. `realLocation` here is the real worker
    // script URL on the proxy origin — captured before any virtualization.
    // `tab=` 도 싣는다 — 워커 클라이언트는 referrer 문맥이 없어 ctx 해석이
    // 안 되므로, 바인딩이 어긴 경로에서도 명시 탭 파라미터로 탭을 찾게 한다.
    return realProxyOrigin + '/zp/api/script?kind=module&tab=' + encodeURIComponent(tabId) + '&u=' + encodeURIComponent(u.href);
  });
  // eval/Function 은 rewrite-then-execute — ZPBundle 부재 시 zpRewrite 가
  // NotSupportedError 로 fail-closed 된다 (기존 blockedDynamic 과 같은 답).
  try { self.eval = workerEval; } catch {}
  try { self.Function = workerFunction; } catch {}
  // Keep in lockstep with ZP.TARGET_USER_AGENT (web/zp-core.js) and the
  // captured Chrome 148 TLS spec. A Worker reporting a different Chrome version
  // (was 134) than the main realm (148) is a cross-context inconsistency an
  // anti-bot can profile — every realm must claim the SAME Chrome build.
  // zp-core.js 의 TARGET_USER_AGENT 와 반드시 같은 값 (여기는 워커라 ZP 가 없다).
  const TARGET_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
  const TARGET_APP_VERSION = TARGET_USER_AGENT.replace(/^Mozilla\//, '');
  const TARGET_PLATFORM = 'Win32';
  const nav = self.navigator;
  if (nav) {
    const proto = self.WorkerNavigator && self.WorkerNavigator.prototype || Object.getPrototypeOf(nav);
    for (const [key, value] of [['userAgent', TARGET_USER_AGENT], ['appVersion', TARGET_APP_VERSION], ['platform', TARGET_PLATFORM]]) {
      try { Object.defineProperty(proto, key, { get: () => value, enumerable: false, configurable: false }); } catch {}
      try { Object.defineProperty(nav, key, { get: () => value, enumerable: false, configurable: false }); } catch {}
    }
  }
  function blocked(){ try { throw new DOMException('Blocked by ZeroProxy policy','NotSupportedError'); } catch(e) { throw e; } }
  const NativeRequest = self.Request;
  const decodeFetchResponse = ZP.createFetchResponseAdapter(self.Response, self.Headers);
  self.fetch = async (input, init = {}) => {
    const raw = input && typeof input.url === 'string' ? input.url : String(input);
    if (/^(?:blob|data):/i.test(raw.trim())) return nativeFetch(input, init);
    const target = ZP.canonicalTargetURL(raw, base.href).href;
    const req = input instanceof NativeRequest ? new NativeRequest(input, init) : new NativeRequest(target, init);
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : ZP.bytesToBase64Url(new Uint8Array(await req.clone().arrayBuffer()));
    const response = await nativeFetch('/zp/api/fetch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: req.signal,
      body: JSON.stringify({ tabId, documentURL: base.href, url: target, init: {
        method: req.method, headers: Array.from(req.headers.entries()), body,
        credentials: req.credentials, mode: req.mode, referrer: req.referrer,
        referrerPolicy: req.referrerPolicy, redirect: req.redirect,
      } }),
    });
    return decodeFetchResponse(response);
  };
  // ── XHR-over-fetch shim ──────────────────────────────────────────────
  // Workers have no in-realm rewriter, but they DO have the proxied
  // self.fetch above — an async XHR emulation on top of it restores
  // axios/pdf.js/emscripten-style loaders without opening a new egress.
  //
  // Synchronous XHR (W3): 네이티브 sync XHR 은 워커에서 합법이다 — 같은
  // 오리진(프록시)의 `/zp/api/sync-fetch` 로 던지면 Go 가 park 하고 SW 가
  // transportFetch 로 실제 전송한다 (페이지 sendSyncThroughRelay 와 같은
  // 릴레이). 진짜 블로킹 의미가 보존되고 egress 는 여전히 프록시 경유다.
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
      const parsed = new URL(String(url), base.href);
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
    // 동기 경로 — `/zp/api/sync-fetch` 로 park-릴레이 (페이지와 같은 봉투).
    // 네이티브 sync XHR 은 dedicated worker 에서 합법이라 진짜로 블로킹된다.
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
  // ── Storage namespacing ──────────────────────────────────────────────
  // Real indexedDB/caches live on the PROXY origin — two targets would
  // read each other's databases. Namespace every key by the virtual
  // target origin so each target sees only its own store.
  const ns = 'ZP|' + base.origin + '|';
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
    // `indexedDB` 는 worker 전역의 getter-only 접근자 — 모듈(strict) 워커에서
    // `self.indexedDB = …` 대입은 TypeError 로 부팅이 죽는다. 접근자를
    // 프로퍼티로 갈아 끼운다 (네이티브는 configurable 이라 허용).
    Object.defineProperty(self, 'indexedDB', { value: idb, writable: true, enumerable: true, configurable: true });
  }
  if (self.caches) {
    const nativeCaches = self.caches;
    const cs = Object.create(nativeCaches);
    cs.open = name => nativeCaches.open(nsOf(name));
    cs.has = name => nativeCaches.has(nsOf(name));
    cs.delete = name => nativeCaches.delete(nsOf(name));
    cs.keys = () => nativeCaches.keys().then(list => list.filter(k => k.startsWith(ns)).map(unNs));
    // match() opens every cache looking for the request — restrict to
    // our namespace by iterating keys() instead of the global index.
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
  // cookieStore: in workers the real store reads PROXY-origin cookies —
  // a cross-target bleed. Give each worker an in-memory jar with the
  // CookieStore surface; there is no page-realm channel to sync against.
  {
    const jar = new Map();
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
  // ── String timers: rewrite-then-schedule (W6) ───────────────────────
  // setTimeout('code') 는 발화 시점에 전역 스코프에서 평가된다 — 미리라이트
  // 컴파일은 우회이므로 ZPBundle 로 재작성한 뒤 indirect eval 로 감싼다.
  // ZPBundle 부재 시 zpRewrite 가 fail-closed(NotSupportedError) — 기존과
  // 같은 답이다. 문자열 핸들러에는 timeout 인자가 안 넘어간다(네이티브 의미).
  const nativeSetTimeout = self.setTimeout.bind(self);
  const nativeSetInterval = self.setInterval.bind(self);
  const compileTimerString = code => {
    const rw = zpRewrite(code);
    return () => workerExecGlobal(rw, true);
  };
  self.setTimeout = (handler, timeout, ...args) => {
    if (typeof handler === 'string') return nativeSetTimeout(compileTimerString(handler), timeout);
    return nativeSetTimeout(handler, timeout, ...args);
  };
  self.setInterval = (handler, timeout, ...args) => {
    if (typeof handler === 'string') return nativeSetInterval(compileTimerString(handler), timeout);
    return nativeSetInterval(handler, timeout, ...args);
  };
  // ── EventSource over proxied fetch ───────────────────────────────────
  // SSE is a streaming GET — our fetch pipes the transport body through,
  // so events arrive as the stream delivers them. WebSocket stays
  // blocked: the yamux kernel lives in the service worker and a dedicated
  // worker has no SW message channel, so there is no transport to hook.
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
  // ── W4: 워커 WebSocket — 페이지 중계 SW 스트림 ─────────────────────
  // 워커에는 navigator.serviceWorker 가 없어 SW 와 직접 통신할 수 없다.
  // 페이지가 브로커다: `__zp:'zp-broker'` 메시지를 postMessage 하면 페이지의
  // 워커 훅이 SW 에 ZP_WS_OPEN 을 보내고, 스트림 MessagePort 를
  // `__zp:'zp-broker-reply'` 로 되돌려 준다(포트는 worker 로 transfer).
  // prelude 가 타깃 스크립트보다 먼저 실행되므로 이 리스너가 먼저 등록되고,
  // 제어 메시지는 stopImmediatePropagation 으로 타깃의 onmessage 에 숨긴다.
  const brokerPending = new Map();
  let brokerSeq = 0;
  const canBroker = typeof self.postMessage === 'function'; // SharedWorker 는 port 기반 — 미지원 유지
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
    // RFC 6455 경계 parity — 페이지 installWebSocket 과 같은 검증 규칙.
    const WS_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
    const wsProtocolList = protocols => {
      if (protocols == null) return [];
      const list = typeof protocols === 'string' ? [protocols] : Array.isArray(protocols) ? protocols.slice() : null;
      if (!list) throw new DOMException('Invalid protocols', 'SyntaxError');
      const out = []; const seen = new Set();
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
        // 네이티브는 상대 URL 을 베이스로 풀고 http→ws/https→wss 를 매핑한다 —
        // ws-스킴 베이스로 resolve 해서 같은 결과를 얻는다. ws/wss 외 스킴과
        // 파싱 실패는 SyntaxError parity.
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
                  this._fire('message', new MessageEvent('message', { data: buf, origin: new URL(this._url.replace(/^ws/, 'http')).origin }));
                }).catch(() => wsFail(this));
                return;
              }
              this._fire('message', new MessageEvent('message', { data, origin: new URL(this._url.replace(/^ws/, 'http')).origin }));
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
  // ── W5: WebTransport / RTCPeerConnection — 페이지와 같은 게이트웨이 정책 ──
  // 부트스트랩 해시(wtg/rtcg/ice)로 전달된 게이트웨이가 있으면 네이티브
  // 인스턴스를 게이트웨이 URL 로 래핑하고, 없으면 rejected stub.
  // 네이티브 자체가 없으면(RTCPeerConnection 은 워커에 [Exposed=Window] 라
  // 오늘의 Chrome 에선 부재) 네이티브 parity 대로 undefined 를 둔다 —
  // undefined 표면에는 fail-close 할 것이 없다.
  const wtGateway = String(self.__ZP_WORKER_WT_GATEWAY || '');
  const rtcGateway = String(self.__ZP_WORKER_RTC_GATEWAY || '');
  const rtcICEServers = Array.isArray(self.__ZP_WORKER_RTC_ICE) ? self.__ZP_WORKER_RTC_ICE : [];
  function workerGatewayStub(name, code, kind) {
    // 페이지 makeVirtualGateway 의 워커 축약판 — 생성은 되고 메서드는
    // 같은 의미로 reject/throw 한다.
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
          try { parsed = new URL(target); } catch { throw new DOMException('Invalid URL', 'SyntaxError'); }
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'wt:') throw new DOMException('Invalid URL scheme', 'SyntaxError');
          const gw = new URL(wtGateway);
          gw.searchParams.set('target', target);
          if (tabId) gw.searchParams.set('tab', tabId);
          this._native = new NativeWT(gw.toString(), opts);
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
  // RTCPeerConnection: 네이티브가 있는 워커만 래핑 — 없으면 undefined.
  if (typeof self.RTCPeerConnection === 'function') {
    const NativeRTC = self.RTCPeerConnection;
    if (rtcGateway) {
      let rtcSessionCounter = 0;
      self.RTCPeerConnection = class ZPWorkerRTCPeerConnection {
        constructor(config) {
          const safeConfig = Object.assign({}, config || {});
          safeConfig.iceServers = rtcICEServers;
          safeConfig.iceTransportPolicy = 'all';
          this._native = new NativeRTC(safeConfig);
          const sid = (tabId || 'wsess') + '-' + (++rtcSessionCounter) + '-' + Date.now().toString(36);
          this._sessionId = sid;
          const postSignal = env => {
            try { return nativeFetch(rtcGateway, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(env), credentials: 'same-origin' }); }
            catch { return Promise.resolve(); }
          };
          this._postSignal = postSignal;
          try {
            this._native.addEventListener('icecandidate', ev => {
              const cand = ev && ev.candidate;
              if (!cand) return;
              postSignal({ op: 'candidate', sessionId: sid, candidate: cand.toJSON ? cand.toJSON() : { candidate: cand.candidate, sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex } });
            });
          } catch {}
          let stopped = false;
          this._pollCtl = { stop() { stopped = true; } };
          const self2 = this;
          (async function loop() {
            while (!stopped) {
              try {
                const r = await nativeFetch(rtcGateway + '?session=' + encodeURIComponent(sid), { credentials: 'same-origin' });
                if (!r.ok) { await new Promise(res => setTimeout(res, 1000)); continue; }
                const envs = await r.json();
                if (!Array.isArray(envs)) continue;
                for (const env of envs) {
                  try {
                    if (env && env.op === 'answer' && env.sdp) {
                      await self2._native.setRemoteDescription(env.sdp);
                    } else if (env && env.op === 'offer' && env.sdp) {
                      await self2._native.setRemoteDescription(env.sdp);
                      const ans = await self2._native.createAnswer();
                      await self2._native.setLocalDescription(ans);
                      postSignal({ op: 'answer', sessionId: sid, sdp: self2._native.localDescription });
                    } else if (env && env.op === 'candidate' && env.candidate) {
                      try { await self2._native.addIceCandidate(env.candidate); } catch {}
                    } else if (env && env.op === 'close') {
                      try { self2._native.close(); } catch {}
                    }
                  } catch {}
                }
              } catch { await new Promise(res => setTimeout(res, 1000)); }
            }
          })();
        }
        get localDescription() { try { return this._native.localDescription; } catch { return undefined; } }
        get remoteDescription() { try { return this._native.remoteDescription; } catch { return undefined; } }
        get pendingLocalDescription() { try { return this._native.pendingLocalDescription; } catch { return undefined; } }
        get pendingRemoteDescription() { try { return this._native.pendingRemoteDescription; } catch { return undefined; } }
        get currentLocalDescription() { try { return this._native.currentLocalDescription; } catch { return undefined; } }
        get currentRemoteDescription() { try { return this._native.currentRemoteDescription; } catch { return undefined; } }
        get signalingState() { try { return this._native.signalingState; } catch { return undefined; } }
        get iceGatheringState() { try { return this._native.iceGatheringState; } catch { return undefined; } }
        get iceConnectionState() { try { return this._native.iceConnectionState; } catch { return undefined; } }
        get connectionState() { try { return this._native.connectionState; } catch { return undefined; } }
        get canTrickleIceCandidates() { try { return this._native.canTrickleIceCandidates; } catch { return undefined; } }
        get sctp() { try { return this._native.sctp; } catch { return undefined; } }
        createOffer(opts) { return this._native.createOffer(opts); }
        createAnswer(opts) { return this._native.createAnswer(opts); }
        async setLocalDescription(desc) {
          const r = await this._native.setLocalDescription(desc);
          const local = this._native.localDescription;
          if (local && local.sdp) this._postSignal({ op: local.type === 'offer' ? 'offer' : 'answer', sessionId: this._sessionId, sdp: { type: local.type, sdp: local.sdp } });
          return r;
        }
        setRemoteDescription(desc) { return this._native.setRemoteDescription(desc); }
        addIceCandidate(cand) { return this._native.addIceCandidate(cand); }
        addTrack(track, ...streams) { return this._native.addTrack(track, ...streams); }
        removeTrack(sender) { return this._native.removeTrack(sender); }
        getSenders() { return this._native.getSenders(); }
        getReceivers() { return this._native.getReceivers(); }
        getTransceivers() { return this._native.getTransceivers(); }
        addTransceiver(...args) { return this._native.addTransceiver(...args); }
        getStats(selector) { return this._native.getStats(selector); }
        createDataChannel(label, opts) { return this._native.createDataChannel(label, opts); }
        close() {
          try { this._pollCtl && this._pollCtl.stop(); } catch {}
          this._postSignal({ op: 'close', sessionId: this._sessionId });
          try { return this._native.close(); } catch { return undefined; }
        }
        addEventListener(type, listener, opts) { try { return this._native.addEventListener(type, listener, opts); } catch {} }
        removeEventListener(type, listener, opts) { try { return this._native.removeEventListener(type, listener, opts); } catch {} }
        dispatchEvent(ev) { try { return this._native.dispatchEvent(ev); } catch { return true; } }
      };
      if (typeof self.webkitRTCPeerConnection === 'function') self.webkitRTCPeerConnection = self.RTCPeerConnection;
    } else {
      self.RTCPeerConnection = workerGatewayStub('RTCPeerConnection', 'RTC_GATEWAY_UNAVAILABLE', 'WebRTC');
      if (typeof self.webkitRTCPeerConnection === 'function') self.webkitRTCPeerConnection = self.RTCPeerConnection;
    }
  }
  // ── 잔여 표면 가드 (페이지 realm 의 installSurfaceGuards 와 같은 정책) ──
  // ShadowRealm: evaluate()/importValue() 가 미리라이트 JS 를 realm 에서
  // 실행한다 — 이 워커에는 재작성기가 없으므로 fail-closed. 생성자/typeof
  // parity 는 남긴다.
  try {
    if (typeof self.ShadowRealm === 'function' && self.ShadowRealm.prototype) {
      const denyEval = function evaluate() { blocked(); };
      const denyImport = function importValue() { return Promise.reject(new DOMException('Blocked by ZeroProxy policy', 'NotSupportedError')); };
      Object.defineProperty(self.ShadowRealm.prototype, 'evaluate', { value: denyEval, enumerable: true, configurable: false });
      Object.defineProperty(self.ShadowRealm.prototype, 'importValue', { value: denyImport, enumerable: true, configurable: false });
    }
  } catch {}
  // navigator.credentials: 저장소는 프록시 오리진 키라 타깃 간 공유된다 —
  // get/store 는 NotAllowedError, WebAuthn 가용성 질의는 "인증기 없음".
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
  // navigator.locks: 실오리진 단위 잠금 공간 — 타깃별 프리픽스로 격리.
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
  // ── Error.stack sanitizer ────────────────────────────────────────────
  // 워커 에러 프레임의 파일명은 `/zp/api/worker-script?u=…`·bootstrap·prelude
  // 라우트라 그대로 새어 나간다(ERRATA G). 페이지 realm 과 같은 방식으로
  // prepareStackTrace 를 감싸 프레임 텍스트를 타깃 URL 로 되돌린다.
  (function installStackSanitizer() {
    const E = self.Error;
    if (!E) return;
    const proxyOrigin = realProxyOrigin;
    const scanRE = new RegExp(proxyOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[A-Za-z0-9\\-._~:/?#\\[\\]@!$&*+,;=%]*', 'g');
    function deproxyOne(m) {
      try {
        const u = new URL(m);
        if (u.origin !== proxyOrigin) return m;
        if (u.pathname === '/zp/api/worker-script' || u.pathname === '/zp/api/script') return u.searchParams.get('u') || m;
        if (u.pathname.startsWith('/zp/')) return base.href;
      } catch {}
      return m;
    }
    // URL 만이 아니라 프레임 함수명(`at Proxy.__zp_dyn__`)도 `__zp_` 를 샌다 —
    // 페이지 realm 과 같이 중립 식별자로 지운다.
    const sanitize = v => v == null ? v : String(v).replace(scanRE, deproxyOne).replace(/\b__zp_[A-Za-z0-9_$]*/g, '<anonymous>');
    let userPrepare = null;
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
      if (userPrepare) return userPrepare(error, wrapped);
      let head;
      try { head = String(error); } catch { head = 'Error'; }
      let out = head;
      for (const f of wrapped) { try { out += '\n    at ' + f.toString(); } catch {} }
      return out;
    };
    try {
      Object.defineProperty(E, 'prepareStackTrace', {
        get() { return zpPrepare; },
        set(v) { userPrepare = typeof v === 'function' ? v : null; },
        configurable: true, enumerable: false
      });
    } catch {}
  })();

  // module 워커에는 네이티브 importScripts 가 없다 — 대입 자체가
  // WorkerGlobalScope 에 새 프로퍼티를 만들 뿐이니 가드 없이 두면 .bind 에서
  // 부팅이 죽는다. 없는 환경에서는 프록시 경유 셈만 심어 둔다(호출하면 네이티브와
  // 같이 모듈 워커 부재 오류가 아니라 우리 경로로 프록시된다 — importScripts 를
  // 지원하지 않는 워커에서 호출돼도 fail-open 은 아니다).
  const nativeImportScripts = typeof self.importScripts === 'function' ? self.importScripts.bind(self) : null;
  // blob: URL → Blob 레지스트리. 워커의 createObjectURL 은 네이티브라
  // SW 에도 blob 본문이 없다 — importScripts(blob:) 는 이 맵으로만 풀린다.
  const blobURLObjects = new Map();
  try {
    const NativeURL = self.URL;
    const nativeCreateObjectURL = NativeURL && NativeURL.createObjectURL;
    if (typeof nativeCreateObjectURL === 'function') {
      Object.defineProperty(NativeURL, 'createObjectURL', {
        value: function createObjectURL(obj) {
          const u = nativeCreateObjectURL.call(NativeURL, obj);
          try { blobURLObjects.set(new URL(u).href, obj); } catch {}
          return u;
        },
        writable: true, enumerable: true, configurable: false,
      });
      const nativeRevoke = NativeURL.revokeObjectURL;
      if (typeof nativeRevoke === 'function') {
        Object.defineProperty(NativeURL, 'revokeObjectURL', {
          value: function revokeObjectURL(u) { try { blobURLObjects.delete(new URL(String(u)).href); } catch {} return nativeRevoke.call(NativeURL, u); },
          writable: true, enumerable: true, configurable: false,
        });
      }
    }
  } catch {}
  // data:/blob: 소스를 읽어 재작성 후 전역 스코프에서 동기 실행한다 —
  // importScripts 의 네이티브 의미(전역 스코프·동기·실패 시 throw)와 같다.
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
      // 페이지 realm 이 만든 blob — 이 워커의 레지스트리엔 없지만 같은
      // 오리진이면 워커 sync XHR 로 읽힌다(D5 blob: Worker 소스 경로).
      try {
        const nx = new NativeWorkerXHR();
        nx.open('GET', parsed.href, false);
        nx.send();
        if (nx.status === 200 || nx.status === 0) return nx.responseText;
      } catch {}
      blockedDynamic();  // 출처 불명 blob — 읽을 수 없으니 fail-closed
    }
    blockedDynamic();
  }
  function importScriptURL(raw) {
    const value = String(raw);
    const internal = new URL(value, realLocation.href);
    if (internal.origin === realProxyOrigin && internal.pathname === '/zp/api/worker-script') return internal.pathname + internal.search + internal.hash;
    const parsed = new URL(value, base.href);
    return '/zp/api/worker-script?tab=' + encodeURIComponent(tabId) + '&u=' + encodeURIComponent(ZP.canonicalTargetURL(parsed.href, base.href).href);
  }
  self.importScripts = (...urls) => {
    if (!nativeImportScripts) blocked();
    for (const raw of urls) {
      // 프록시 내부 경로는 타깃 기준으로 풀기 **전에** 통과시킨다 — 부트스트랩의
      // `importScripts('/zp/assets/zp-page-bundle.js')` 와 `/zp/api/worker-script`
      // 가 이 경로를 탄다. srcu/src 워커는 base 가 blob:/data: 라 상대경로가
      // 그쪽으로 풀려 스크립트 라우트를 통째로 삼키는 함정이 있었다.
      let internal = null;
      try { internal = new URL(String(raw), realLocation.href); } catch {}
      if (internal && internal.origin === realProxyOrigin &&
          (internal.pathname === '/zp/api/worker-script' || internal.pathname === '/zp/api/script' ||
           internal.pathname.startsWith('/zp/assets/') || internal.pathname.startsWith('/__zp/'))) {
        nativeImportScripts(internal.pathname + internal.search + internal.hash);
        continue;
      }
      const parsed = new URL(String(raw), base.href);
      // module 워커는 네이티브가 TypeError 를 던진다 — 우회하지 않고 그대로 위임.
      if (!isModuleWorker && (parsed.protocol === 'data:' || parsed.protocol === 'blob:')) {
        workerExecGlobal(zpRewrite(readVirtualScriptSource(parsed)), false);
      } else {
        nativeImportScripts(importScriptURL(raw));
      }
    }
  };
  // 워커의 `self.location` 은 가상 타깃이다 — 네이티브는 워커 URL(여기선
  // `u`, 즉 타깃/blob:/data:)을 보여주고 우리도 그것을 보여준다. with-scope
  // 파사드의 `location` 조회(위 getOwnPropertyDescriptor/get 트랩)와 같은
  // `base` 객체를 써서 `location === self.location` 이 성립한다.
  try {
    Object.defineProperty(self, 'location', { value: base, writable: false, enumerable: true, configurable: true });
  } catch {}
  // D5: srcu 워커 — blob:/data: 소스는 네트워크 요청이 없으므로 부트스트랩이
  // worker-script import 를 싣지 않는다. 여기서 소스를 읽어 재작성 후 실행한다.
  const srcuSource = String(self.__ZP_WORKER_SRC_URL || '');
  if (srcuSource) {
    if (!isModuleWorker) {
      // classic 워커는 부트스트랩이 prelude → zp-page-bundle 순으로 동기
      // importScripts 한다 — prelude 본문이 끝난 시점엔 번들이 아직 없다.
      // 실행 함수만 노출하고 부트스트랩의 후미 호출이 번들 로드 후 돌린다.
      self.__zp_runSrcu = function () {
        try { workerExecGlobal(zpRewrite(readVirtualScriptSource(new URL(srcuSource))), false); }
        catch (e) { setTimeout(() => { throw e; }, 0); }
      };
    } else {
      // module 워커는 import/export 문법 때문에 eval 이 안 된다 — 소스를 읽어
      // 페이지 브로커로 SW stash 에 넣고 srctok 라우트를 import 한다.
      (async () => {
        const r = await nativeFetch(srcuSource);
        const src = await r.text();
        const reply = await brokerToPage({ op: 'stash', src });
        if (!reply || !reply.tok) throw new Error('stash failed');
        await import('/zp/api/worker-script?srctok=' + encodeURIComponent(reply.tok) + '&tab=' + encodeURIComponent(tabId) + '&u=' + encodeURIComponent(srcuSource) + '&kind=module');
      })().catch(e => { setTimeout(() => { throw e; }, 0); });
    }
  }
})();
