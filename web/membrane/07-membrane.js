
  function installPhase2Membrane() {
    // ★네이티브 **메서드**는 window 수신자가 필요하다 — 목록이 아니라 규칙으로.
    //
    // 예전에는 WINDOW_BOUND_METHODS 라는 손수 고른 목록만 바인딩했다. 목록에
    // 없는 것은 스코프 프록시가 그대로 돌려주므로, 페이지가
    // `globalThis.structuredClone(x)` 처럼 부르면 수신자가 **프록시**가 되어
    // 브랜드 체크가 실패한다 → TypeError: Illegal invocation.
    //
    // GitHub 실측(2026-09-04): `sg-*.js` 의
    //   let t = "function" == typeof globalThis.structuredClone
    //         ? globalThis.structuredClone(e) : JSON.parse(JSON.stringify(e));
    // 이 렌더 도중 던져 React 가 에러 경계로 떨어졌고, GitHub 홈이 통째로
    // 자기 ErrorPage 를 그렸다. 목록에 없어서 뚫린 것이 structuredClone /
    // 마이크로태스크 큐 API / reportError / getSelection 넷이었다(실측).
    //
    // 판별 규칙: **prototype 이 없는 네이티브 함수**만 바인딩한다.
    //  - 네이티브 메서드(structuredClone, matchMedia, getSelection…)는 prototype 이 없다
    //  - 생성자/클래스(URL, Promise, Worker…)는 prototype 이 있다 — 바인딩하면 new 가 깨진다
    //  - 페이지가 window 에 얹은 자기 함수는 [native code] 가 아니므로 건드리지 않는다
    //    (그걸 바인딩하면 `obj.f = window.f; obj.f()` 의 this 가 바뀐다)
    function needsWindowReceiver(fn) {
      if (typeof fn !== 'function') return false;
      try { if (fn.prototype) return false; } catch { return false; }
      try { return /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(fn)); } catch { return false; }
    }
    function boundWindowMethod(target, prop) {
      const fn = target[prop];
      if (typeof fn !== 'function') return fn;
      if (windowMethodBindings.has(prop)) return windowMethodBindings.get(prop);
      const bound = fn.bind(target);
      maskNativeFunction(bound, prop);
      windowMethodBindings.set(prop, bound);
      return bound;
    }

    const NativeAsyncFunction = (async function(){}).constructor;
    const NativeGeneratorFunction = (function*(){}).constructor;
    const NativeAsyncGeneratorFunction = (async function*(){}).constructor;
    function stringArgs(args) {
      const out = new Array(args.length);
      for (let i = 0; i < args.length; i++) out[i] = String(args[i]);
      return out;
    }
    function scopedBody(body) { return 'with(__zp_scope){\n' + body + '\n}'; }
    function compileScoped(ctor, params, body) {
      try { zpTrace('compile', String(body || '').slice(0, 100)); } catch {}
      const argv = new Array(params.length + 2);
      argv[0] = '__zp_scope';
      for (let i = 0; i < params.length; i++) argv[i + 1] = params[i];
      argv[argv.length - 1] = scopedBody(rewriteDynamicFunctionBody(params, body));
      return Reflect.construct(ctor, argv);
    }
    function functionPrefix(kind) {
      return kind === 'async' ? 'async function' : kind === 'generator' ? 'function*' : kind === 'asyncGenerator' ? 'async function*' : 'function';
    }
    function dynamicSource(kind, params, body) {
      return functionPrefix(kind) + ' anonymous(' + params.join(',') + '\n) {\n' + body + '\n}';
    }
    // `withScope` 의 has 트랩은 **모든** 이름에 true 다 (해석되지 않은 식별자가
    // 진짜 전역으로 새지 않게 하려고). 그 대가로 컴파일된 함수의 파라미터와
    // `arguments` 까지 with 객체가 가려버린다: `new Function('x','return x')(1)`
    // 이 undefined 였다. naver 메인 광고 safeframe 이 정확히 여기서 죽었다 —
    // doT 템플릿 엔진의 `new Function('o,tmpl', "var _e=tmpl.encode…")` 에서
    // tmpl 이 undefined 라 "Failed to create ad markup" 으로 광고 프레임 전체가
    // 빈 채로 남았다 (프레임의 `window.onerror = () => true` 가 이걸 삼켜서
    // 콘솔에는 아무것도 안 뜬다).
    //
    // 파라미터를 with **안쪽** 중첩 함수에 선언하면 이름 파싱 없이 정확히
    // 해결된다 — 안쪽 함수 스코프가 with 객체보다 가깝다. 파라미터 텍스트를
    // 그대로 다시 쓰므로 디스트럭처링/기본값도 자동으로 따라온다. `arguments`
    // 와 body 안 `var` 의 스코프도 같이 제자리를 찾는다 (전에는 `var` 가
    // window 로 샜다). 자유 식별자는 여전히 with 를 거치므로 격리는 그대로다.
    //
    // `new.target` 도 살린다: 바깥 래퍼는 Reflect.construct 로 newTarget 을
    // 받을 수 있으므로, 그걸 그대로 안쪽 함수의 construct 호출에 전달한다.
    // `new (new Function('return new.target'))()` 가 자기 자신을 돌려주는
    // 네이티브 동작이 그대로 재현된다.
    function compileNested(params, body, kind) {
      try { zpTrace('compile', String(body || '').slice(0, 100)); } catch {}
      const inner = functionPrefix(kind) + ' __zp_dyn__(' + params.join(',') + '\n) {\n'
        + rewriteDynamicFunctionBody(params, body, kind) + '\n}';
      // 안쪽 함수는 with **안에서** 만들어야 자유 식별자가 스코프 프록시를
      // 거치고, `.apply` 는 with **바깥에서** 해야 한다: `__zp_args` 도 결국
      // 이름이라 with 안에서는 has 트랩에 가려져 undefined 가 된다 (이 함정을
      // 한 번 밟았다 — 파라미터는 살아났는데 arguments 가 비어 있었다).
      // IIFE 가 클로저째로 with 스코프를 들고 나온다.
      // `this` 는 파라미터로 전달한다 — 바깥 래퍼도 sloppy 라 apply(this=undefined)
      // 하면 래퍼 경계에서 진짜 globalThis 로 강제변환되어 strict inner 까지
      // 오염된다. 파라미터는 강제변환을 타지 않으므로 의도한 thisArg 가 그대로 간다.
      const src = 'var __zp_inner__ = (function(){\nwith(__zp_scope){\nreturn (' + inner + ');\n}\n})();\n'
        + 'if (new.target) return Reflect.construct(__zp_inner__, __zp_args, new.target);\n'
        + 'return __zp_inner__.apply(__zp_this, __zp_args);';
      return Reflect.construct(Native.FunctionCtor, ['__zp_scope', '__zp_args', '__zp_this', src]);
    }
    function nestedCall(compiled, thisArg, callArgs, newTarget, sloppy) {
      // Sloppy bodies coerce nullish `this` to the global object — here the
      // REAL window, which is an escape. Substitute the scope facade so
      // `this.location` virtualizes. `thisArg === root` counts as the global
      // too: a page-visible `window` facade is never the real root, so root
      // can only arrive from an unwrapped call site. Primitives still box
      // natively inside.
      const t = sloppy && (thisArg == null || thisArg === root) ? scope : thisArg;
      const argv = [withScope, callArgs, t];
      return newTarget ? Reflect.construct(compiled, argv, newTarget) : Reflect.apply(compiled, scope, argv);
    }
    function compileDynamic(ctor, args, kind) {
      const parts = stringArgs(args);
      const body = parts.length ? parts[parts.length - 1] : '';
      const params = new Array(parts.length > 0 ? parts.length - 1 : 0);
      for (let i = 0; i < params.length; i++) params[i] = parts[i];
      // 바깥 래퍼는 항상 plain function 이다 — 종류(async/generator)는 with
      // 안쪽 중첩 함수가 들고 있고, 페이지에 노출되는 `fn` 이 같은 종류로
      // 선언돼 있어 prototype 신원은 그대로 유지된다.
      const compiled = compileNested(params, body, kind);
      // Directive prologue decides the inner function's this-coercion —
      // sloppy nullish `this` must land on the scope facade, strict keeps
      // whatever was passed (including undefined).
      const sloppy = !/^\s*['"]use strict['"]/.test(body);
      let fn;
      // ★바깥 래퍼는 반드시 strict 여야 한다 — sloppy 래퍼는 `fn.call(null)` 의
      // this 를 **래퍼 경계에서** 진짜 globalThis 로 강제변환해, nestedCall 의
      // nullish 판정을 무력화하고 strict body 에도 real window 를 밀어 넣는다
      // (escape). strict 래퍼는 call-site thisArg 를 있는 그대로 전달한다.
      // rest 파라미터가 있으면 'use strict' 지시어가 불법이라 `arguments` 를 쓴다.
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
    function isEvalExpressionCandidate(text) {
      return !/^(?:function|class|var|let|const|if|for|while|do|switch|try|throw|return|break|continue|with|import|export|debugger)\b/.test(text.trimStart());
    }
    function dynamicEval(source) {
      // 네이티브 eval 은 생성자가 아니다 — `new eval()` 은 TypeError.
      if (new.target) throw new TypeError('eval is not a constructor');
      if (arguments.length === 0) return undefined;
      const text = String(source);
      let expr = null;
      if (isEvalExpressionCandidate(text)) {
        // 표현식도 리라이터를 거친다 — `with` 만 씌우면 computed member
        // (`x['location']`) 같은 중재 경로가 통째로 빠진다. 리라이트가
        // 실패하면 그대로 던져서 unrewritten 코드가 실행되지 않게 한다.
        try {
          const rewritten = callPageRewriter(text, 'classic');
          expr = Reflect.construct(Native.FunctionCtor, ['__zp_scope', 'with(__zp_scope){return (' + rewritten + '\n);}']);
        } catch (e) {
          if (e && e.name === 'NotSupportedError') throw e;
        }
      }
      if (expr) return Reflect.apply(expr, root, [withScope]);
      // 문(statement) 형태는 **전역 스코프**에서 실행해야 한다. indirect eval 의
      // 최상위 `var`/`function` 선언은 전역 객체의 프로퍼티가 되는데, Function
      // 래퍼 + `with` 로 감싸면 래퍼의 지역 선언이 되어 흔적 없이 사라진다.
      //
      // Cloudflare managed challenge 가 정확히 여기서 죽었다:
      //   eval("function jcLw7(s){…XOR 디코더…}")   ← 전역 헬퍼를 심는 목적
      // 뒤이어 난독화 VM 이 `window[<디코드된 이름>](…)` 로 그 헬퍼를 부르는데
      // 우리 환경에서는 undefined 라 `undefined.call` TypeError 가 터졌다.
      // 챌린지 스크립트가 죽으니 cf_clearance 를 영원히 못 받고 "Just a
      // moment…" 만 반복 — 지문이 아니라 **eval 스코프 시맨틱**이 원인이었다.
      //
      // 리라이터는 그대로 통과시키므로 격리 posture 는 인라인 `<script>` 와
      // 동일하다 (그쪽도 rewrite → globalEval 이다). `with` 스코프 프록시는
      // 동적 Function body 경로에 그대로 남는다 — 거기선 본문이 진짜 함수
      // 본문이라 전역 선언 시맨틱이 애초에 없다.
      try {
        const globalCode = callPageRewriter(text, 'classic');
        if (typeof globalCode === 'string' && globalCode.length) {
          // R1: eval 의 let/const/class 는 eval 렉시컬 환경과 함께 버려진다 —
          // 공유 zpLex 가 아닌 버리는 Map 에 등록한다.
          const prevLexEnv = __zp_lex_env;
          __zp_lex_env = new Map();
          try { return execGlobalScript(globalCode); }
          finally { __zp_lex_env = prevLexEnv; }
        }
      } catch {}
      return Reflect.apply(compileScoped(Native.FunctionCtor, [], text), root, [withScope]);
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
    // ── R2: direct `eval(x)` 호출자 스코프 ──
    // 리라이터가 `eval(x)` 를 `__zp_eval.call(this, src, desc)` 로 방출한다.
    // 문제: direct eval 은 "eval 이라는 이름으로 intrinsic 을 호출" 해야만
    // 호출자 환경을 본다 — `Native.globalEval(src)` 는 indirect(전역). prelude
    // 는 strict 라 `const eval` 바인딩도 불법. 탈출구: Function ctor 로 만든
    // sloppy 헬퍼의 **파라미터명** eval — `f(neval, src)` 안에서 `eval(src)`
    // 는 파라미터가 intrinsic 이라 진짜 direct eval 이 되고, eval 은 호출
    // 컨텍스트(헬퍼)의 this·lexenv 를 계승한다. with(desc)/with(scope) 가
    // eval 소스 안에서 그 헬퍼 파라미터로 해석된다.
    // desc 접근자 본문은 call-site 어휘 위치에서 실행되어 호출자 지역을
    // 읽고 쓴다; 호출자가 없는 이름은 scope 프록시로 떨어진다.
    // `var` — 부팅 중 get/set/has/del 이 선언문 도달 전에 호출돼도 TDZ 로
    // 죽지 않게 한다.
    var __zp_eval_desc = null;
    const zpDirectEvalRunner = Native.FunctionCtor(
      'eval', '__zp_env', '__zp_src',
      'return eval(__zp_src)');
    function zpDirectEval(callee, args, desc, callerStrict) {
      // 네이티브 eval 은 생성자가 아니다.
      if (new.target) throw new TypeError('eval is not a constructor');
      // `var eval = f` 등으로 eval 이름이 재바인딩됐으면 네이티브는 그 값을
      // 호출한다 — intrinsic 이 아닌 callee 는 ordinary call 로 위임
      // (thisValue undefined → sloppy 는 전역, strict 는 undefined).
      if (callee !== dynamicEval) {
        return Reflect.apply(callee, undefined, Array.isArray(args) ? args : []);
      }
      const src = args && args.length ? args[0] : undefined;
      // 네이티브 parity: 비문자열 인자는 평가 없이 그대로 반환.
      if (typeof src !== 'string') return src;
      const rewritten = callPageRewriter(src, 'classic');
      let d = {};
      if (desc && typeof desc === 'object') {
        // `delete x` 가 호출자 바인딩을 지우면 안 된다 — 접근자를
        // non-configurable 로 재정의해 네이티브의 false 반환을 흉낸다.
        const dd = Object.getOwnPropertyDescriptors(desc);
        for (const k of Object.keys(dd)) { dd[k].configurable = false; dd[k].enumerable = true; }
        d = Object.defineProperties({}, dd);
      }
      const prev = __zp_eval_desc;
      __zp_eval_desc = d;
      // R1: eval 의 let/const/class 는 eval 자체의 렉시컬 환경에 살고 함께
      // 버려진다 — 공유 zpLex 에 새지 않게 eval 마다 버리는 Map 을 둔다.
      const prevLexEnv = __zp_lex_env;
      __zp_lex_env = new Map();
      try {
        // strict 는 소스 지시어로 전달한다 — sloppy 헬퍼의 direct eval 에
        // `'use strict';` 프롤로그가 있으면 strict eval 이 된다 (strict
        // 헬퍼는 `eval` 파라미터명이 불법이라 별도 헬퍼를 못 만든다).
        // strict eval 소스는 `with` 를 못 쓰므로 raw 경로: plain 식별자는
        // 어휘 사슬(→전역)로, dangerous 이름은 __zp_get 의 desc consult 로
        // 호출자를 본다.
        const strictSrc = !!callerStrict || /^\s*['"]use strict['"]/.test(src);
        // 단일 합성 with: 스코프 프록시의 has 가 모든 이름에 true 라
        // `with(__zp_desc)` 같은 이중 래핑은 파라미터명까지 삼켜버린다.
        // desc 우선 → withScope 폴백을 한 프록시로 합성한다.
        const env = new Proxy(d, {
          has(_t, p) { return p !== Symbol.unscopables; },
          get(_t, p) {
            if (typeof p === 'string' && Object.prototype.hasOwnProperty.call(d, p)) return d[p];
            return Reflect.get(withScope, p);
          },
          set(_t, p, v) {
            if (typeof p === 'string' && Object.prototype.hasOwnProperty.call(d, p)) { d[p] = v; return true; }
            return Reflect.set(withScope, p, v);
          },
        });
        // sourceURL — eval 소스의 에러 filename 이 호출자 스크립트(가상
        // 문서 URL)를 가리키게 — 네이티브는 eval 소스 에러도 호출 스크립트
        // URL 을 reporting 한다.
        const body = strictSrc ? '"use strict";' + rewritten : 'with(__zp_env){' + rewritten + '\n}';
        return zpDirectEvalRunner.call(this, Native.globalEval, env, body + '\n//# sourceURL=' + virtualURL.href);
      } finally {
        __zp_eval_desc = prev;
        __zp_lex_env = prevLexEnv;
      }
    }
    define(root, '__zp_eval', zpDirectEval);
    const dynamicConstructorWrappers = new Map([
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
    // Inherit Location.prototype so `virtualLocation instanceof Location`
    // returns true. Without this, GitHub's React-Lib `instanceof Location`
    // check during hydration fails → React error #519 (multiple hydration
    // diffs in a pass) → ErrorPage fallback render. Other sites (Wikipedia,
    // NAVER) don't notice because they don't do this specific check.
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
    // Cache Proxy per native Location instance. Proxy preserves native
    // [[Class]] / instanceof Location identity (target is native Location)
    // while virtualizing path-level URL reads — required because the
    // foreground OXC rewriter wraps `o.pathname` member access only when
    // the prop name is in MEMBER_HELPER_PROPS; we narrow virtualization
    // to pathname/search/hash (what React Router needs) to avoid
    // breaking schema validators (zod) that compare href/origin to
    // SSR'd expected values.
    const wrappedLocationCache = new WeakMap();
    // Every URL component on a wrapped Location proxy must return the
    // virtual (target) value, not the proxy origin. The original Phase-2
    // set covered only `pathname / search / hash`, which left target
    // code reading `location.href`, `location.host`, `location.origin`,
    // etc. seeing `proxy.localhost:18080` — domain checks
    // (`if (location.host === 'naver.com')`), anti-bot scripts comparing
    // `location.href` against a marker, and OXC-bypassed inline reads
    // all leaked the proxy origin into the page. Bisected 2026-06-03
    // against Wikipedia anchor clicks: extending this set does NOT
    // affect anchor click navigation (the earlier suspicion was a flaky
    // test selector that hit `/wiki/Main_Page` self-link).
    const LOC_VIRT_PROPS = new Set(['href','protocol','host','hostname','port','pathname','search','hash','origin']);
    const LOC_ALL_URL_PROPS = new Set(['href','protocol','host','hostname','port','pathname','search','hash','origin']);
    // Hoist the 4 fixed Location methods outside wrappedLocationFor so each
    // call doesn't allocate a fresh closure set. They only capture
    // virtualURL/setVirtualLocation/Native (closure-scope invariants).
    const locToString = virtualLocation.toString;
    const locAssign = virtualLocation.assign;
    const locReplace = virtualLocation.replace;
    const locReload = virtualLocation.reload;
    // `location.ancestorOrigins` — a DOMStringList of every ancestor frame's
    // origin. The real one hands out PROXY origins (the actual ancestors).
    // Root → empty list; a contained frame → its embedder's target origin.
    function ancestorOriginsList(local) {
      const origins = local ? [] : [virtualURL.origin];
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
      // about:blank children share these helpers until their own prelude runs,
      // but their navigation must still target the child's native Location.
      const local = nativeLoc === root.location;
      const assignLocation = local ? locAssign : function assign(value) {
        activatedFrameURL(value).then(url => nativeLoc.assign(url));
      };
      const replaceLocation = local ? locReplace : function replace(value) {
        activatedFrameURL(value).then(url => nativeLoc.replace(url));
      };
      const reloadLocation = local ? locReload : function reload() { nativeLoc.reload(); };
      if (!local) {
        maskNativeFunction(assignLocation, 'assign');
        maskNativeFunction(replaceLocation, 'replace');
        maskNativeFunction(reloadLocation, 'reload');
      }
      // 자식 프레임의 Location 은 자기 URL 을 가져야 한다 — 부모 virtualURL 을
      // 그대로 돌려주면 `iframe.contentDocument.location.href` 가 부모 주소로
      // 보인다. `/zp/p/<token>` 은 클라이언트에서 못 푸니 프레임 엘리먼트에
      // 붙들어 둔 타깃(urlMeta/data-zp-target-url)을 역조회하고, `?via=` 같은
      // 평문 경로는 deproxy 로 복원한다. about:*/알 수 없는 것은 부모 계약 유지.
      function foreignVirtualURL() {
        try {
          const frames = document.querySelectorAll('iframe,frame');
          for (const el of frames) {
            try {
              const cw = el.contentWindow;
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
      const methodCache = new Map();
      const handler = {
        get(target, prop) {
          if (typeof prop === 'string' && LOC_VIRT_PROPS.has(prop)) {
            // about:blank/srcdoc 자식은 네이티브처럼 자기 주소가 아니라
            // 삽입자의 가상 URL 을 보여 주는 기존 계약을 유지한다.
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
        getOwnPropertyDescriptor(_t, prop) {
          // Virtualized URL props: live value, always configurable.
          if (typeof prop === 'string' && LOC_VIRT_PROPS.has(prop)) {
            const fv = local ? virtualURL : foreignVirtualURL() || virtualURL;
            return { value: fv[prop], writable: true, enumerable: true, configurable: true };
          }
          const d = Reflect.getOwnPropertyDescriptor(nativeLoc, prop);
          // Target is Object.create(nativeLoc) with NO own props, so the proxy
          // invariant forbids reporting a non-configurable descriptor that the
          // target doesn't actually have — force configurable so enumeration of
          // the real Location's keys still works.
          if (d) d.configurable = true;
          return d;
        },
        getPrototypeOf() { return Reflect.getPrototypeOf(nativeLoc); },
      };
      // Target is `Object.create(nativeLoc)`, NOT nativeLoc itself. The
      // unforgeable Location methods (reload/assign/replace) are OWN,
      // non-configurable, non-writable data properties on the real location, so
      // with nativeLoc as the proxy target the get-invariant ("must return the
      // property's actual value") makes returning our virtualized versions throw
      // `TypeError: 'get' on proxy: property 'reload'...` — which crashed NAVER
      // main.js during React render. Putting the real location one level up the
      // prototype chain leaves the target with no own props, so the invariant
      // never applies; instanceof Location and reflection still resolve through
      // the proto (forwarded to nativeLoc explicitly in every trap).
      const proxy = new Proxy(Object.create(nativeLoc), handler);
      wrappedLocationCache.set(nativeLoc, proxy);
      return proxy;
    }
    const crossWindowTargets = new WeakMap();
    const crossOriginLocations = new WeakMap();
    function crossWindowLocation(targetWindow) {
      // Location belongs to the destination realm: using this frame's facade
      // turns top.location writes into self-navigation (notably in srcdoc).
      const ownerGet = targetWindow.__zp_get;
      if (ownerGet === get) return wrappedLocationFor(targetWindow.location);
      if (typeof ownerGet !== 'function') throw normalizedError('SecurityError');
      const location = ownerGet(targetWindow, 'location');
      if (location.origin === virtualURL.origin) return location;
      // Same physical proxy origin is not permission to read another site's
      // Location. Cross-origin href writes/replace remain usable for navigation.
      let restricted = crossOriginLocations.get(targetWindow);
      if (!restricted) {
        const navigate = (value, replace) => {
          const owner = targetWindow.__zp_get(targetWindow, 'location');
          const absolute = targetURL(value);
          if (replace) owner.replace(absolute);
          else owner.href = absolute;
        };
        const replace = function replace(value) { navigate(value, true); };
        maskNativeFunction(replace, 'replace');
        restricted = new Proxy(Object.create(null), {
          get(_target, prop) {
            if (prop === 'replace') return replace;
            if (prop === 'then' || typeof prop === 'symbol') return undefined;
            throw normalizedError('SecurityError');
          },
          set(_target, prop, value) {
            if (prop !== 'href') throw normalizedError('SecurityError');
            navigate(value, false);
            return true;
          }
        });
        crossOriginLocations.set(targetWindow, restricted);
      }
      return restricted;
    }
    // ── VirtualNavigation facade ─────────────────────────────────────────
    // `window.navigation` is a live Navigation object: `currentEntry.url` and
    // `entries()` carry REAL proxy-origin URLs, and `navigate()` walks the
    // real session directly — a read leak AND a navigation escape in one
    // object. The facade reports virtualURL for every entry URL (real proxy
    // URLs can't be decrypted synchronously, and no target URL is lost that
    // way), routes navigate/reload through the virtual-location pipeline,
    // delegates back/forward/traverseTo to native (real session entries are
    // all proxy pages → contained), and wraps listener events so
    // `event.destination.url` can't leak the real URL either.
    const navFacadeCache = new WeakMap();
    function virtualNavigationFor(win) {
      if (!win) return null;
      // A prelude-booted child builds its own facade against ITS virtualURL —
      // delegate so `childWin.navigation.currentEntry.url` reports the
      // child's target, not ours.
      if (win !== root) {
        const ownerGet = win.__zp_get;
        if (typeof ownerGet === 'function' && ownerGet !== get) {
          try { return ownerGet(win, 'navigation'); } catch {}
        }
      }
      let cached = navFacadeCache.get(win);
      if (cached !== undefined) return cached;
      const native = win.navigation;
      if (!native) { navFacadeCache.set(win, null); return null; }
      const NavProtoBase = (win.Navigation && win.Navigation.prototype) || null;
      const NavEntryProtoBase = (win.NavigationHistoryEntry && win.NavigationHistoryEntry.prototype) || null;
      const entryFacades = new WeakMap();
      const listenerWrappers = new WeakMap();
      const handlerStore = Object.create(null);
      // All props non-enumerable: IDL attributes live on the prototype, so a
      // native `Object.keys(navigation)` is empty — ours must match.
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
        // href-write on the location facade: root → setVirtualLocation,
        // child → activatedFrameURL → proxied frame navigation.
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
    // 사슬 한 칸 위로. 못 읽거나 자기 자신이면 제자리에 머문다(끝에 도달한 것).
    function climbCrossWindow(targetWindow, prop, fallback) {
      try {
        const next = targetWindow[prop];
        if (next && next !== targetWindow) return safeCrossWindow(next);
      } catch {}
      return fallback;
    }
    // cross-window 파사드에 쓰기/읽기를 진짜 창으로 넘겨도 되는 이름인가.
    // 네이티브 같은-오리진 expando 의미를 복원하되 세 부류는 절대 진짜 창에
    // 심지 않는다: (1) __zp_* 내부명 — 부모 scopeGet 이 root[prop] 으로
    // 떨어지므로 `parent.__zp_set = evil` 이 헬퍼 탈취 통로, (2) MEMBER_DANGER
    // — 가상화 표면을 expando 로 덮어쓰는 우회, (3) 문자열 on* 핸들러 —
    // 브라우저가 미리라이트 코드로 컴파일한다.
    function crossExpandoProp(prop, value) {
      return typeof prop !== 'string'
        || (!ZP_HIDDEN_RE.test(prop) && !MEMBER_DANGER.has(prop)
            && !(prop.startsWith('on') && typeof value === 'string'));
    }
    function safeCrossWindow(targetWindow) {
      if (!targetWindow || targetWindow === root) return scope;
      if (crossWindowProxyCache.has(targetWindow)) return crossWindowProxyCache.get(targetWindow);
      const proxyTarget = {};
      // ★이 파사드는 **진짜 Proxy** 여야 한다 — 리라이터가 멤버 대입을
      // `__zp_get(parent).x = v` 같은 **날것의 프로퍼티 쓰기**로 방출한다
      // (__zp_set 을 거치지 않는다). plain 객체이면 쓰기가 더미에 흡수돼
      // `parent.__childSW = v` 류의 cross-frame 전달이 조용히 죽는다 — 실측:
      // srcdoc 자식의 SharedWorker 회신이 silent 였다(요청은 정상 송신).
      const proxy = new Proxy(proxyTarget, {
        get(t, prop) {
          if (Reflect.getOwnPropertyDescriptor(t, prop)) return Reflect.get(t, prop);
          // own expando 만 넘긴다 — 프로토타입 멤버(eval/Function/fetch 같은
          // 진짜 네이티브)를 돌려주면 자식에 미리라이트 실행 경로가 열린다.
          if (crossExpandoProp(prop)) {
            try {
              if (Reflect.getOwnPropertyDescriptor(targetWindow, prop)) return Reflect.get(targetWindow, prop);
            } catch {}
          }
          return undefined;
        },
        set(t, prop, value) {
          if (crossExpandoProp(prop, value)) {
            try { Reflect.set(targetWindow, prop, value); } catch {}
            return true;
          }
          return Reflect.set(t, prop, value);
        },
        has(t, prop) {
          if (Reflect.has(t, prop)) return true;
          if (crossExpandoProp(prop)) {
            try { return !!Reflect.getOwnPropertyDescriptor(targetWindow, prop); } catch { return false; }
          }
          return false;
        },
        deleteProperty(t, prop) {
          if (crossExpandoProp(prop)) {
            try { Reflect.deleteProperty(targetWindow, prop); } catch {}
            return true;
          }
          return Reflect.deleteProperty(t, prop);
        },
      });
      definePropertiesMasked(proxyTarget, {
        window: { get() { return proxy; }, enumerable: true },
        self: { get() { return proxy; }, enumerable: true },
        globalThis: { get() { return proxy; }, enumerable: true },
        // ★`top`/`parent` 가 **자기 자신**을 돌려주면 프레임 사슬이 끊긴다
        // (2026-08-24). 광고/동의(CMP) 코드는 거의 예외 없이 이렇게 올라간다:
        //
        //   while (!found) {
        //     try { if (w.frames.__cmpLocator) found = w; } catch {}
        //     if (w === window.top) break;      // ← 유일한 탈출구
        //     w = w.parent;
        //   }
        //
        // 손자 프레임(깊이 2 이상)에서는 `window.top` 과 `window.parent` 가
        // **서로 다른** 프록시다. 그런데 부모 프록시의 `.parent` 가 자기 자신을
        // 돌려주니 `w` 는 거기서 영원히 멈추고, `w === window.top` 은 영원히
        // false 다 — **무한 루프**. CNN 에서 렌더러가 통째로 멎은 원인이 이것이다
        // (CPU 샘플 실측: `get top` 4,181 / 우리 접근자 5,682).
        //
        // 진짜 사슬을 따라간다. `top`/`parent` 는 교차 출처에서도 읽을 수 있는
        // 몇 안 되는 속성이라 이 접근 자체는 막히지 않는다. 캐시가 실제 창을
        // 키로 쓰므로 위로 올라가면 결국 `window.top` 과 **같은 객체**에 닿는다.
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
    function virtualWindowProperty(target, prop) {
      if (prop === 'top' || prop === 'parent' || prop === 'opener') {
        try {
          const child = target[prop];
          if (prop === 'opener' && !isWindowLike(child)) return child;
          if (child && child !== target) return safeCrossWindow(child);
        } catch {}
      }
      return scope;
    }
    maskNativeFunction(virtualLocation[Symbol.toPrimitive], Symbol.toPrimitive);
    // 2026-08-13 — `has` 를 정직하게 만들었다. 예전에는 **모든 이름에 true** 를
    // 돌려줬다. 그건 아래 `withScope` 의 요구사항이지 페이지에 보여 줄 `window`
    // 의 동작이 아니다. 같은 프록시를 window/globalThis/self/frames 로 노출하고
    // 있었으므로, 페이지 입장에서 `'아무거나' in window` 가 항상 true 였다.
    //
    // 실제 피해: NAVER 장바구니가 통째로 안 뜬다. 번들의 싱글턴 초기화가
    //   var t = globalThis;
    //   KEY in t || (t[KEY] = new Beacon());
    //   return t[KEY];
    // 인데, `KEY in t` 가 늘 true 라 **대입이 아예 실행되지 않고** 되읽기는
    // undefined → `getInstance().recordExport` 에서 TypeError → 모듈 초기화가
    // 끊겨 스켈레톤만 남았다. `A in obj || (obj[A]=…)` 는 흔한 관용구다.
    // 부수적으로 `'__아무거나__' in window === true` 는 그 자체로 지문이었다.
    // A native Window's unforgeable location accessor cannot be replaced by a
    // Proxy descriptor trap. Keep the virtual accessor on the actual shadow
    // target, with the native flags; all other properties still live on root.
    const scopeTarget = Object.create(Object.getPrototypeOf(root));
    const nativeWindowLocation = Reflect.getOwnPropertyDescriptor(root, 'location');
    const scopeLocationGet = function () {
      if (this !== root && !isScopeProxy(this)) throw new TypeError('Illegal invocation');
      return wrappedLocationFor(root.location);
    };
    const scopeLocationSet = function (value) {
      if (this !== root && !isScopeProxy(this)) throw new TypeError('Illegal invocation');
      setVirtualLocation(value);
    };
    toStringMap.set(scopeLocationGet, nativeAccessorSource('get', 'location'));
    toStringMap.set(scopeLocationSet, nativeAccessorSource('set', 'location'));
    defineMasked(scopeTarget, 'location', {
      get: scopeLocationGet, set: scopeLocationSet,
      enumerable: nativeWindowLocation.enumerable,
      configurable: nativeWindowLocation.configurable
    });
    let scopeProtoOverride = null;
    // `hide` = 페이지-facing scope 프록시용 내부 이름 차단. `with(__zp_scope)`
    // 는 has 가 모든 이름을 잡으므로 `__zp_get` 같은 헬퍼까지 undefined 를
    // 돌리면 리라이트된 코드가 전부 죽는다 — withScope 는 hide=false.
    // Boot snapshot of native own accessors. Chrome keeps several built-ins
    // (`performance`, `crypto`, `indexedDB`, ...) as OWN configurable getters
    // on window — invoking them with the facade receiver throws
    // Illegal invocation. Only accessors the PAGE installs later
    // (defineProperty / __defineGetter__) run with `this` = scope, so
    // `this.location` inside the getter virtualizes.
    const bootOwnAccessors = new Map();
    for (const name of nativeOwnKeys(root)) {
      const d = Reflect.getOwnPropertyDescriptor(root, name);
      if (d && d.configurable && (d.get || d.set)) bootOwnAccessors.set(name, d);
    }
    function isPageInstalledAccessor(prop, own) {
      if (!own || !own.configurable || !(own.get || own.set)) return false;
      const boot = bootOwnAccessors.get(prop);
      return !boot || boot.get !== own.get || boot.set !== own.set;
    }
    // R1: classic script 의 top-level let/const/class 는 **스크립트를 넘어
    // 지속되는 공유 전역 렉시컬 환경**에 산다. 각 스크립트가 별도 indirect
    // eval 로 실행되면 그 렉시컬 환경은 버려지므로, 리라이터가 심은
    // `__zp_lex_decl`(등록+충돌검사)/`__zp_lex_bind`(accessor 클로저) 가
    // 살아있는 바인딩을 여기 보존한다.
    //   entry = { kind:'let'|'const'|'class', get, set } — set=null 이면
    //   const 의미(쓰기 시 TypeError), get=null 이면 선언만 되고 bind 가
    //   안 된 상태(초기화 throw 등) → 읽기 시 ReferenceError(TDZ parity).
    const zpLex = new Map();
    // 현재 렉시컬 환경 — 스크립트 실행 중엔 zpLex, eval/동적 코드 안에선
    // 그 eval 의 버려지는 환경(네이티브 eval 렉시컬 환경 의미 그대로).
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
      if (hide && typeof prop === 'string' && ZP_HIDDEN_RE.test(prop)) return undefined;
      if (prop === 'window' || prop === 'self' || prop === 'globalThis' || prop === 'frames') return scope;
      if (prop === 'top' || prop === 'parent' || prop === 'opener') return virtualWindowProperty(root, prop);
      if (prop === 'location') {
        return wrappedLocationFor(root.location);
      }
      if (prop === 'postMessage') return postMessageWrapperFor(root);
      if (prop === 'name') return virtualWindowNameFor(root);
      const dynamic = typeof prop === 'symbol' ? null : dynamicGlobal(String(prop));
      if (dynamic) return dynamic;
      // Page-installed own accessor → run it with the facade as `this`:
      // `this.location` inside the getter must virtualize, and
      // `this === root` would hand the real Location straight back to
      // page code. Native own accessors (unchanged since boot) fall
      // through to `root[prop]` — they brand-check `this`.
      const own = Reflect.getOwnPropertyDescriptor(root, prop);
      if (isPageInstalledAccessor(prop, own)) return Reflect.get(root, prop, scope);
      if (WINDOW_BOUND_METHODS.has(prop) || needsWindowReceiver(root[prop])) return boundWindowMethod(root, prop);
      return root[prop];
    }
    const scopeTraps = {
      has(_target, prop) {
        if (prop === Symbol.unscopables) return false;
        // Runtime internals (__zp_*/ZP*) are own props of the real window —
        // `'__zp_trace' in window` must not answer true for page code.
        if (typeof prop === 'string' && ZP_HIDDEN_RE.test(prop)) return false;
        return Reflect.has(root, prop);
      },
      get(_target, prop) { return scopeGet(prop, true); },
      set(_target, prop, value) {
        if (prop === 'location') { setVirtualLocation(value); return true; }
        if (prop === 'name') { setVirtualWindowName(root, value); return true; }
        // `window.onload = 'code'` — legacy string handlers compile through
        // the event-handler gate, same as element on* properties. Only for
        // props where a real on* setter exists (unknown on* names stay
        // plain data properties, matching native).
        if (typeof prop === 'string' && prop.length > 2 && prop.startsWith('on') && typeof value === 'string') {
          const d = Reflect.getOwnPropertyDescriptor(root, prop) || Reflect.getOwnPropertyDescriptor(Object.getPrototypeOf(root), prop);
          if (d && typeof d.set === 'function') {
            const body = rewriteWithPageRewriter(String(value), 'event-handler');
            const fn = Native.FunctionCtor('event', body);
            toStringMap.set(fn, 'function ' + prop + '(event) {\n' + String(value) + '\n}');
            return Reflect.set(root, prop, fn);
          }
        }
        // Page-installed accessor setters likewise run with `this` = scope.
        const own = Reflect.getOwnPropertyDescriptor(root, prop);
        if (isPageInstalledAccessor(prop, own)) {
          return Reflect.set(root, prop, value, scope);
        }
        return Reflect.set(root, prop, value);
      },
      getOwnPropertyDescriptor(target, prop) {
        if (prop === 'location') return Reflect.getOwnPropertyDescriptor(target, prop);
        if (typeof prop === 'string' && ZP_HIDDEN_RE.test(prop)) return undefined;
        if (typeof prop === 'string' && MEMBER_DANGER.has(prop)) {
          const native = Reflect.getOwnPropertyDescriptor(root, prop);
          return {
            get: membraneGetter(scope, prop),
            set: membraneSetter(scope, prop),
            enumerable: native ? native.enumerable : true,
            configurable: native ? native.configurable : false,
          };
        }
        const desc = Reflect.getOwnPropertyDescriptor(root, prop);
        // Preserve locked descriptors, not a blanket configurable:true mask.
        if (desc && !desc.configurable) Reflect.defineProperty(target, prop, desc);
        return desc;
      },
      ownKeys() { return nativeOwnKeys(root).filter(k => typeof k !== 'string' || !ZP_HIDDEN_RE.test(k)); },
      defineProperty(target, prop, desc) {
        if (prop === 'location') return Reflect.defineProperty(target, prop, desc);
        if (!Reflect.defineProperty(root, prop, desc)) return false;
        const installed = Reflect.getOwnPropertyDescriptor(root, prop);
        if (installed && !installed.configurable) Reflect.defineProperty(target, prop, installed);
        return true;
      },
      deleteProperty(target, prop) {
        if (prop === 'location') return false;
        if (!Reflect.deleteProperty(root, prop)) return false;
        return Reflect.deleteProperty(target, prop);
      },
      getPrototypeOf() { return scopeProtoOverride || Reflect.getPrototypeOf(root); },
      // `Reflect.setPrototypeOf(window, x)` must NOT mutate the real window's
      // prototype — that is persistent corruption of the host realm. Record
      // the override on the facade instead; traps already mediate every read.
      setPrototypeOf(_target, proto) {
        scopeProtoOverride = proto;
        return Reflect.setPrototypeOf(scopeTarget, proto);
      },
      preventExtensions() { return false; }
    };
    // 페이지에 window/globalThis/self/frames 로 노출되는 프록시.
    const scope = new Proxy(scopeTarget, scopeTraps);
    // `with(__zp_scope){…}` 의 피연산자 전용. 여기서는 has 가 **반드시** 모든
    // 이름에 true 여야 한다 — 그래야 블록 안의 모든 식별자가 이 객체를 거치고,
    // 해석되지 않은 이름이 진짜 전역 스코프로 새어나가 멤브레인을 우회하지
    // 못한다. 페이지 코드에 이 객체가 직접 새지는 않는다: get 트랩이
    // window/globalThis/self/frames 에 대해 `scope` 를 돌려주기 때문이다.
    const withScope = new Proxy(scopeTarget, Object.assign({}, scopeTraps, {
      has(_target, prop) { return prop !== Symbol.unscopables; },
      // has=true 와 짝을 이뤄야 하는 get — `__zp_*` 헬퍼가 with 본문에서
      // 반드시 해석되어야 한다 (페이지-facing scope 와 달리 숨기지 않는다).
      // R1: 전역 렉시컬 바인딩은 전역 객체 프로퍼티보다 **먼저** 보인다 —
      // 동적 코드의 bare 식별자도 다른 스크립트의 let/const 를 읽는다.
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
    // Names the rewriter marks as dangerous members. `Reflect.get/set` route
    // these through the membrane; any other name keeps native semantics.
    const MEMBER_DANGER = new Set([
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
    // 진짜 native Location 인스턴스인가. `instanceof` 로 보면 페이지가
    // `Symbol.hasInstance` 를 갈아 끼워 속일 수 있으므로, **네이티브 게터를
    // 직접 불러 보는 브랜드 체크**를 쓴다(Location 이 아니면 던진다).
    // ★1차 판정은 **던지지 않아야 한다.** 처음엔 네이티브 게터를 바로 불러
    // 성공/예외로 갈랐는데, 그러면 Location 이 **아닌** base 마다 예외가 하나씩
    // 난다. `href`/`origin`/`host`/… 는 앵커·URL·설정객체에서 흔한 이름이라
    // 이 경로가 통째로 뜨거워진다. 실측(200k 회): 진짜 Location 34ms vs
    // 앵커 734ms / 평범한 객체 796ms — 호출당 ~3.7µs. CNN 광고 스택에서
    // 렌더러가 굳었다.
    // 그래서 위조 불가능한 [[Class]] 태그로 먼저 값싸게 거른 뒤, 통과한 것만
    // 네이티브 게터로 확증한다. 페이지가 `Symbol.toStringTag` 로 태그를
    // 위조하면 확증 단계에서 걸러진다(그 경우에만 예외 비용을 낸다).
    const nativeObjToString = Object.prototype.toString;
    const knownLocations = new WeakSet();
    function isNativeLocation(value) {
      if (!value || typeof value !== 'object') return false;
      if (value === virtualLocation) return false;
      if (knownLocations.has(value)) return true;
      let tag;
      try { tag = nativeObjToString.call(value); } catch { return false; }
      if (tag !== '[object Location]') return false;
      const d = Native.locationHref;
      if (!d || !d.get) return false;
      try { d.get.call(value); knownLocations.add(value); return true; } catch { return false; }
    }
    function get(base, prop) {
      if (typeof prop !== 'symbol') prop = String(prop);
      // ★base 가 **진짜 Location** 이면 URL 성분은 가상값을 준다.
      // 리라이터는 `n.location.protocol` 에서 바깥 `.protocol` 만 감싸고
      // 안쪽 `n.location` 은 (수신자가 지역 변수라) 그대로 두므로, 멤브레인이
      // **진짜 Location 을 base 로** 받는 경로가 실제로 존재한다. 그때
      // Reflect.get 으로 떨어지면 own + non-configurable(unforgeable) 접근자가
      // 프록시 주소를 그대로 돌려준다 — 마스킹으로는 절대 못 막는 자리다.
      // CNN 실측(2026-08-25): 벤더 코드
      // `(n.location.protocol === "https:" ? "https://" : "http://") + host`
      // 가 `http:` 를 받아 `http://www.ugdturner.com/xd.sjs` 를 요청 → 502 →
      // 그 스크립트가 정의하는 `turner_getGuid` 부재 → FAVE/APS 체인 중단 →
      // 광고 프레임 다수 미생성. 기능 파손이자 격리 위반이다.
      if (typeof prop === 'string' && LOC_ALL_URL_PROPS.has(prop) && isNativeLocation(base)) return virtualURL[prop];
      // ★`document.location` 은 **실제 객체에 마스킹이 안 걸린다.** 측정(2026-08-25):
      // `document` 의 own `location` 접근자와 Location 인스턴스의 own
      // `href/protocol/host/…` 접근자가 전부 `configurable: false`(unforgeable)라
      // 프로토타입을 아무리 덮어도 인스턴스 own 이 그걸 가린다. 그래서 페이지가
      // `document.location.href` 한 줄만 읽으면 **프록시 주소·오리진·스킴이
      // 그대로 나갔다** — 격리 위반이면서 동시에 기능 파손이다.
      // CNN 실측: 벤더 코드가
      // `(document.location.protocol === "https:" ? "https://" : "http://") + host`
      // 로 URL 을 만든다. 우리가 `http:` 를 흘려서 `http://www.ugdturner.com/xd.sjs`
      // 를 받아 502 가 났고, 그 스크립트가 정의하는 `turner_getGuid` 가 없어져
      // FAVE/APS 체인이 통째로 끊겼다(광고 프레임 다수 미생성).
      // `URL`/`documentURI`/`baseURI`/`referrer` 는 이미 여기 있었는데
      // `location` 만 빠져 있었다 — 형제 표면 하나를 빠뜨린 전형이다.
      // Any Document, not just the root one: `iframe.contentDocument.location`,
      // DOMParser/implementation documents all hand out a raw native Location
      // otherwise — `childDoc.location.href = x` would navigate the frame
      // straight to the target off-proxy. wrappedLocationFor routes
      // assign/replace/href through activatedFrameURL.
      if (prop === 'location' && isDocumentLike(base)) {
        // Native invariant: `location === document.location`. Both must be
        // the same wrapped proxy instance (WeakMap-cached), not the internal
        // `virtualLocation` data object — React hydration checks and
        // fingerprint comparisons observe the identity.
        if (base === document) return wrappedLocationFor(root.location);
        try { const loc = Reflect.get(base, 'location'); return loc ? wrappedLocationFor(loc) : loc; } catch { return virtualLocation; }
      }
      if (base === document && (prop === 'URL' || prop === 'documentURI')) return virtualURL.href;
      if (base === document && prop === 'baseURI') return baseURL;
      if (base === document && prop === 'referrer') return '';
      if (isWindowLike(base)) {
        // R2: direct-eval 실행 중 desc(호출자 스코프)는 가상 전역보다
        // 우선한다 — eval'd 코드의 `__zp_get(g,'x')` 도 호출자 지역을 본다.
        {
          const d = __zp_eval_desc;
          if (d && (base === root || isScopeProxy(base)) && typeof prop === 'string'
              && Object.prototype.hasOwnProperty.call(d, prop)) return d[prop];
        }
        // R1: bare 식별자(`__zp_get(globalThis,"x")` — with 안에서
        // `globalThis` 가 진짜 root 로 해석된다)는 전역 렉시컬 환경이 전역
        // 객체보다 먼저다. 멤버 경로(base===scope 프록시)는 건너뛴다 —
        // `window.x` 는 렉시컬 바인딩을 보지 않는다(네이티브 의미).
        if (base === root) {
          const le = zpLexGetEntry(prop);
          if (le) return zpLexRead(le, prop);
        }
        if (prop === 'window' || prop === 'self' || prop === 'globalThis' || prop === 'frames') return isScopeProxy(base) || base === root ? scope : base;
        if (prop === 'top' || prop === 'parent' || prop === 'opener') return virtualWindowProperty(crossWindowTargets.get(base) || (isScopeProxy(base) ? root : base), prop);
        if (prop === 'location') {
          const baseWin = crossWindowTargets.get(base) || (isScopeProxy(base) ? root : base);
          if (baseWin !== root) return crossWindowLocation(baseWin);
          try { const n = baseWin.location; return n ? wrappedLocationFor(n) : virtualLocation; } catch { return virtualLocation; }
        }
        if (prop === 'postMessage') return postMessageWrapperFor(crossWindowTargets.get(base) || (isScopeProxy(base) ? root : base));
        if (prop === 'navigation') return virtualNavigationFor(crossWindowTargets.get(base) || (isScopeProxy(base) ? root : base));
        if (prop === 'name') return virtualWindowNameFor(crossWindowTargets.get(base) || (isScopeProxy(base) ? root : base));
        const dynamic = dynamicGlobal(prop);
        if (dynamic) return dynamic;
      }
      if (base === document && prop === 'defaultView') return scope;
      if (prop === 'postMessage') {
        const fn = Reflect.get(Object(base), prop);
        if (typeof fn === 'function') {
          const bound = fn.bind(base);
          maskNativeFunction(bound, prop);
          return bound;
        }
        return fn;
      }
      if (prop === 'constructor') {
        const ctor = Reflect.get(Object(base), prop);
        return dynamicWrapperFor(ctor) || ctor;
      }
      // ★cross-window 파사드의 own expando 읽기. `safeCrossWindow` 가 돌려주는
      // 건 더미 객체이므로, 부모가 `window.data = …` 로 심어 둔 공유값을 자식이
      // `parent.data` 로 못 읽는 역파손이 있었다(네이티브는 같은 오리진이라
      // 당연히 보인다). own 프로퍼티만 넘긴다 — 프로토타입 멤버(eval/Function/
      // fetch 같은 진짜 네이티브)를 넘기면 자식에 미리라이트 실행 경로가
      // 열린다. 내부명(__zp_*)·위험명(MEMBER_DANGER)도 절대 넘기지 않는다.
      {
        const crossWin = crossWindowTargets.get(base);
        if (crossWin && (typeof prop !== 'string' || (!ZP_HIDDEN_RE.test(prop) && !MEMBER_DANGER.has(prop)))) {
          try {
            if (Reflect.getOwnPropertyDescriptor(crossWin, prop)) return Reflect.get(crossWin, prop);
          } catch {}
        }
      }
      return Reflect.get(Object(base), prop);
    }
    function set(base, prop, value) {
      if (typeof prop !== 'symbol') prop = String(prop);
      // R2: eval 실행 중 호출자 바인딩 우선 — setter 가 호출자 스코프에서
      // 실행되어 const 쓰기 TypeError 도 네이티브 그대로 나온다.
      {
        const d = __zp_eval_desc;
        if (d && (base === root || isScopeProxy(base)) && typeof prop === 'string'
            && Object.prototype.hasOwnProperty.call(d, prop)) { d[prop] = value; return value; }
      }
      // R1: bare 식별자 쓰기는 전역 렉시컬 바인딩으로 라우팅 —
      // const 면 TypeError (zpLexWrite). 멤버 경로(scope 베이스)는 제외.
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
      // Non-root document: `doc.location = url` is PutForwards=href — forward
      // through the facade so the frame navigates via activatedFrameURL.
      if (prop === 'location' && isDocumentLike(base) && base !== document) {
        try { const loc = Reflect.get(base, 'location'); if (loc) wrappedLocationFor(loc).href = value; } catch {}
        return value;
      }
      if (((isWindowLike(base) || base === document) && prop === 'location') || (base === virtualLocation && prop === 'href')) { setVirtualLocation(value); return value; }
      if (base === virtualLocation && prop === 'hash') { updateVirtualHash(value); return value; }
      // ★cross-window 파사드에 대한 일반 expando 쓰기는 네이티브 같은-오리진
      // 의미 그대로 진짜 창에 기록한다. 더미 객체에 쓰면 `parent.__childSW = v`
      // 류의 cross-frame 전달이 조용히 죽는다(실측: srcdoc 자식의 SharedWorker
      // 회신 silent). 단 세 부류는 절대 진짜 창에 심지 않는다: (1) __zp_*
      // 내부명 — 부모 scopeGet 이 root[prop] 로 떨어지므로 헬퍼 탈취 통로,
      // (2) MEMBER_DANGER — 가상화 표면을 expando 로 덮어쓰는 우회,
      // (3) 문자열 on* — 브라우저가 미리라이트 코드로 컴파일한다.
      {
        const crossWin = crossWindowTargets.get(base);
        if (crossWin && (typeof prop !== 'string'
            || (!ZP_HIDDEN_RE.test(prop) && !MEMBER_DANGER.has(prop)
                && !(prop.startsWith('on') && typeof value === 'string')))) {
          try { Reflect.set(crossWin, prop, value); } catch {}
          return value;
        }
      }
      Reflect.set(Object(base), prop, value);
      return value;
    }
    function assign(base, prop, operator, value) {
      if (typeof prop !== 'symbol') prop = String(prop);
      const current = get(base, prop);
      // `value` is ALWAYS a thunk (rewriter emits `()=>(rhs)`): evaluated only
      // after the get — native get→RHS→set order — and only when the operator
      // actually writes (logical short-circuit stays lazy).
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
      return Reflect.apply(fn, isScopeProxy(base) ? root : base, Array.isArray(args) ? args : []);
    }
    function construct(ctor, args) {
      const dynamic = dynamicWrapperFor(ctor);
      return Reflect.construct(dynamic || ctor, Array.isArray(args) ? args : []);
    }
    function has(base, prop) {
      const d = __zp_eval_desc;
      if (d && (base === root || isScopeProxy(base)) && typeof prop === 'string'
          && Object.prototype.hasOwnProperty.call(d, prop)) return true;
      if ((isWindowLike(base) || isDocumentLike(base)) && prop === 'location') return true;
      return Reflect.has(Object(base), prop);
    }
    // Document-ness by nodeType 9: covers root document, iframe
    // contentDocument, DOMParser/implementation documents — including
    // cross-realm documents where `instanceof Document` fails.
    function isDocumentLike(base) {
      try { return !!base && base.nodeType === 9 && typeof base.implementation === 'object'; } catch { return false; }
    }
    // Bases whose dangerous-named members are membrane-backed: window-like
    // proxies, the document, native/wrapped Locations, and frame host
    // elements (contentWindow/contentDocument accessors are already masked
    // on their prototypes, so descriptor paths must match).
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
    // Accessor pair that reads/writes through the membrane — what a
    // virtualized descriptor hands out instead of the real native accessor.
    function membraneGetter(base, prop) {
      const g = function () { return get(base, prop); };
      toStringMap.set(g, nativeAccessorSource('get', prop));
      return g;
    }
    function membraneSetter(base, prop) {
      const s = function (v) { set(base, prop, v); };
      toStringMap.set(s, nativeAccessorSource('set', prop));
      return s;
    }
    function getOwnPropertyDescriptor(base, prop) {
      // 서술자로 우회해 진짜 게터를 꺼내 가는 길도 막는다 — 여기서 진짜 접근자를
      // 돌려주면 `gopd(document,'location').get.call(document)` 한 줄로 프록시
      // 주소가 새어 나간다.
      if (typeof prop === 'string' && MEMBER_DANGER.has(prop) && dangerousBase(base)) {
        if (prop === 'location' && (base === root || isScopeProxy(base))) {
          return Reflect.getOwnPropertyDescriptor(scopeTarget, prop);
        }
        const receiver = crossWindowTargets.get(base) || base;
        const native = Reflect.getOwnPropertyDescriptor(receiver, prop);
        return {
          get: membraneGetter(base, prop),
          set: membraneSetter(base, prop),
          enumerable: native ? native.enumerable : true,
          configurable: native ? native.configurable : false,
        };
      }
      return Reflect.getOwnPropertyDescriptor(Object(base), prop);
    }
    function ownKeys(base) { return Reflect.ownKeys(Object(base)); }
    function del(base, prop) {
      if (typeof prop !== 'symbol') prop = String(prop);
      // R2: eval 중 호출자 바인딩 delete → non-configurable 접근자라 false.
      {
        const d = __zp_eval_desc;
        if (d && (base === root || isScopeProxy(base)) && typeof prop === 'string'
            && Object.prototype.hasOwnProperty.call(d, prop)) { delete d[prop]; return false; }
      }
      // `delete window.location` — unforgeable, silently refuses. Returning
      // false mirrors native non-strict `delete` instead of a phantom success.
      if (prop === 'location' && (isWindowLike(base) || isDocumentLike(base))) return false;
      return Reflect.deleteProperty(Object(base), prop);
    }
    function odel(base, prop) { return base == null ? true : del(base, prop); }
    function oget(base, prop) { return base == null ? undefined : get(base, prop); }
    // `x?.m()` / `x?.m?.()` / `x.m?.()` — `flags` packs (baseOpt<<1)|callOpt:
    // bit1 guards a nullish base, bit0 guards a nullish member. `x.m?.()`
    // still throws when x is null — only the call is optional there. One
    // `get` only (accessors must not run twice).
    function ocall(base, prop, args, flags) {
      if (base == null) {
        if (flags & 2) return undefined;
        throw new TypeError("Cannot read properties of " + base + " (reading '" + String(prop) + "')");
      }
      const fn = get(base, prop);
      if (fn == null && (flags & 1)) return undefined;
      return Reflect.apply(fn, isScopeProxy(base) ? root : base, Array.isArray(args) ? args : []);
    }
    // Reflect.get/set with a `receiver` arg: route dangerous names through
    // the membrane, everything else through native Reflect with receiver
    // semantics intact.
    function rget(target, prop, receiver) {
      if (typeof prop !== 'symbol') prop = String(prop);
      if (MEMBER_DANGER.has(prop)) return get(target, prop);
      return Reflect.get(Object(target), prop, receiver === undefined ? target : receiver);
    }
    function rset(target, prop, value, receiver) {
      if (typeof prop !== 'symbol') prop = String(prop);
      if (MEMBER_DANGER.has(prop)) { set(target, prop, value); return true; }
      return Reflect.set(Object(target), prop, value, receiver === undefined ? target : receiver);
    }
    function getOwnPropertyDescriptors(base) {
      const out = {};
      for (const k of Reflect.ownKeys(Object(base))) out[k] = getOwnPropertyDescriptor(base, k);
      return out;
    }
    // Reflect.getOwnPropertyNames 는 없는 API 다 — 네이티브 Object 쪽을 써야
    // 한다. 패치된 Object.getOwnPropertyNames 는 전역 객체의 __zp_* 스크럽까지
    // 해 주므로 그대로 위임하면 누출 필터도 유지된다.
    function getOwnPropertyNames(base) { return Object.getOwnPropertyNames(Object(base)); }
    function okeys(base) { return Object.keys(Object(base)); }
    // `with(obj)` identifier resolution: the object's properties win over
    // outer scope unless the name is Symbol.unscopables-hidden. `fb` is the
    // outer-scope thunk — the rewriter chains these for nested `with`s and
    // threads values through so RHS side effects run exactly once.
    function unscopablesHidden(obj, prop) {
      const uns = obj == null ? null : obj[Symbol.unscopables];
      return uns != null && !!uns[prop];
    }
    function scopeHas(obj, prop) {
      return obj != null && prop in Object(obj) && !unscopablesHidden(obj, prop);
    }
    // `with` 의 객체 우선 조회에서도 위험명은 멤브레인 표면으로 — raw
    // `obj[prop]` 는 `with(document){location}` 에서 real Location(정체
    // 노출 + identity 위반), `with(realChildWin){location}` 에서 부모
    // 가상 URL 도 아닌 날 Location 을 내놓는다. `document.location = x` 는
    // PutForwards 인데 unforgeable 세터가 없어 raw 대입은 네비게이션을
    // 삼킨다 — membrane set 은 activatedFrameURL 로 보낸다.
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
    // Assignment-target sink inside `with`: returns an accessor object whose
    // `.v` resolves like a `with` reference (object-first, then `sink`).
    function withD(obj, prop, sink) {
      const viaMembrane = typeof prop === 'string' && MEMBER_DANGER.has(prop) && dangerousBase(obj);
      return {
        get v() { if (!scopeHas(obj, prop)) return sink[prop]; return viaMembrane ? get(obj, prop) : obj[prop]; },
        set v(x) { if (scopeHas(obj, prop)) { if (viaMembrane) set(obj, prop, x); else obj[prop] = x; } else sink[prop] = x; }
      };
    }
    // Legacy accessor hooks — `document.__lookupGetter__('location')` handed
    // out the REAL unforgeable accessor, and `.call(document)` then leaked the
    // real Location (proxy origin + href). Dangerous names on membrane bases
    // resolve to membrane-backed accessors; `__define*__` writes land on the
    // facade (or the element itself) instead of corrupting host intrinsics.
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
    // `window.__defineGetter__('x', fn)` === defineProperty(window,'x',{get:fn})
    // — it must land where every other page definition lands (root via the
    // proxy, the element itself otherwise), so `window.x` reads it back.
    // Unforgeable names fail defineProperty → TypeError, same as native.
    if (nativeDefineGetter) {
      defineMasked(Object.prototype, '__defineGetter__', {
        value: function __defineGetter__(prop, fn) {
          if (typeof fn !== 'function') throw normalizedError('TypeError');
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
          if (typeof fn !== 'function') throw normalizedError('TypeError');
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
    // `import('data:…')` / `import('blob:…')` — 소스를 읽어 이 realm 의
    // 재작성기로 재작성한 뒤 **재작성된** blob URL 을 돌린다. 재작성 코드가
    // 참조하는 `__zp_*` 는 같은 window 의 전역이라 그대로 풀린다. 읽기/
    // 재작성 실패는 fail-closed(NotSupportedError).
    //   - data: 는 동기 디코드.
    //   - blob: 은 same-origin blob 이라 네이티브 sync XHR 로 읽는다 —
    //     in-process 조회라 네트워크를 타지 않는다.
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
    define(root, '__zp_set', set);
    // Write-only sink for destructuring assignment targets.
    //
    // `({ location } = obj)` needs a *settable member expression*, not a call:
    // `({ __zp_set(globalThis,"location",…) } = obj)` is a SyntaxError, which
    // killed the whole script file. The rewriter instead emits
    // `({ location: __zp_get.d.location } = obj)` — valid syntax whose write
    // lands on this proxy's `set` trap and routes through the membrane setter,
    // so a destructured global write cannot escape the jail.
    //
    // Deliberately read-*less*: `get` always yields undefined and every other
    // trap is inert, so target code can never pull a raw native through it.
    // That is why we do NOT reuse the `with(__zp_scope)` proxy — its `get`
    // falls through to `target[prop]` and would hand out real natives.
    // Hung off `__zp_get` rather than a new global so the page's global
    // namespace gains nothing observable.
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
    define(root, '__zp_rget', rget);
    define(root, '__zp_rset', rset);
    define(root, '__zp_getOwnPropertyDescriptors', getOwnPropertyDescriptors);
    define(root, '__zp_getOwnPropertyNames', getOwnPropertyNames);
    define(root, '__zp_okeys', okeys);
    define(root, '__zp_with_get', withGet);
    define(root, '__zp_with_set', withSet);
    define(root, '__zp_with_assign', withAssign);
    define(root, '__zp_with_update', withUpdate);
    define(root, '__zp_with_delete', withDelete);
    define(root, '__zp_with_d', withD);
    define(root, '__zp_nav_assign', v => setVirtualLocation(v));
    define(root, '__zp_nav_replace', v => setVirtualLocation(v, true));
    define(root, '__zp_runClassic', fn => fn.call(root, withScope));
    define(root, '__zp_runEvent', (selfValue, event, fn) => fn.call(selfValue, new Proxy(withScope, { get(t, p, r) { if (p === 'event') return event; return Reflect.get(t, p, r); } })));
    // 2026-06-08 split-bundle (c.1) Step 2.4: page-realm primary swap.
    // `globalThis.ZPBundle` (loaded by `zp-page-bundle.js` per Step 2.3) is
    // now the primary rewriter; legacy ZPRewriter (rewriter-rs/, OXC 0.60)
    // survives only as the fallback if modern errors. Step 3 will drop
    // OXC from rewriter-rs entirely; Step 4 will delete the crate.
    //
    // ZPBundle's `rewriteScript` is positional `(source, kind, target_url)`
    // and either returns the rewritten string or throws a JsError. Legacy
    // ZPRewriter is options-object + returns `{ok, code, errorCode, …}`.
    // The helpers below normalize both shapes behind a single try/catch.
    // 2026-06-08 split-bundle (c.1) Step 3: legacy ZPRewriter.rewriteScript
    // fallback dropped — the rewriter-rs/ crate is now CSS-only. ZPBundle
    // is the single rewriter; on failure we surface NotSupportedError so
    // the calling __ZP_EXEC_* helper falls through to the strict-mode
    // block stub.
    function callPageRewriter(source, kind) {
      if (!root.ZPBundle || !root.ZPBundle.ready || typeof root.ZPBundle.rewriteScript !== 'function') {
        throw normalizedError('NotSupportedError');
      }
      try {
        const out = root.ZPBundle.rewriteScript(source, kind, virtualURL.href);
        if (typeof out === 'string' && out.length > 0) return out;
      } catch (e) { /* fall through */ }
      throw normalizedError('NotSupportedError');
    }
    function rewriteDynamicFunctionBody(params, body, kind) {
      const list = Array.isArray(params) ? params : [];
      // 래퍼의 종류가 body 와 맞아야 한다 — `new AsyncFunction('await x')` 의
      // body 를 plain function 으로 감싸면 파싱 자체가 실패한다.
      const prefix = functionPrefix(kind) + ' __zp_dynamic__(' + list.map(value => String(value)).join(',') + '){\n';
      const suffix = '\n}';
      const wrapped = prefix + String(body || '') + suffix;
      const code = callPageRewriter(wrapped, 'classic');
      const end = code.length - suffix.length;
      if (end < prefix.length) throw normalizedError('NotSupportedError');
      return code.slice(prefix.length, end);
    }
    function rewriteWithPageRewriter(source, kind) {
      return callPageRewriter(String(source || ''), kind);
    }
    // Share with `installNetworkContainment` (see `pageRewriteHooks`).
    pageRewriteHooks = {
      rewrite: rewriteWithPageRewriter,
      decodeEntities: decodeInlineEntities
    };
    // 인라인 <script> 본문은 브라우저가 raw text mode 로 토크나이즈하여 HTML
    // 엔티티를 디코딩하지 않는다. React `dangerouslySetInnerHTML` 가 JS 연산자
    // (`=>`/`&&`)를 `=&gt;`/`&amp;&amp;` 로 엔티티 인코딩해 박은 케이스는 우리가
    // 직접 디코딩해야 파서가 받아낸다. 단, 모든 스크립트에 unconditional
    // 디코드를 걸면 `encMap={"\"":"&quot;",...}` 같이 ENTITY 가 **데이터**로
    // 들어있는 외부 스크립트 (e.g. NAVER GFP SafeFrame) 가 파괴된다 — Rust
    // 측은 디코드 안 함, JS 측이 inline 경로에서만 적용. trap-notebook
    // rewriter.md 2026-05-30 entry 참조.
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
    //
    // A classic `<script>` puts its top-level `var` / `function` declarations
    // on the global object, so the next script can call them.
    // `new Function(body)` puts them in that function's own scope instead,
    // where they die when it returns. NAVER's search page declares
    // `urlencode` / `lcs_do` / `headerfooter_time_year_s` in one inline script
    // and calls them from another, which produced a ReferenceError storm and
    // broke the search-option widgets downstream.
    //
    // Indirect eval (member-expression call, not the `eval(...)` identifier
    // form) is the only executor that evaluates in global scope, and it is
    // sloppy-mode by default — matching classic script semantics exactly.
    // This does NOT weaken the jail: the body handed to us is already
    // membrane-rewritten (`__zp_get`/`__zp_set`), and the previous executor
    // did not install a `with(__zp_scope)` either — only the *lexical* home
    // of the declarations changes.
    //
    // R1: 리라이터가 classic top-level let/const/class 에 심은 등록/바인딩
    // 호출의 런타임 측. `__zp_lex_env` 는 현재 렉시컬 환경 — 스크립트 실행
    // 중엔 zpLex, eval/동적 코드 안에선 그 eval 의 버려지는 Map(네이티브가
    // eval 렉시컬 환경을 버리는 것과 같은 의미).
    // 충돌 이름을 반환(throw 는 방출 코드가 한다 — prelude 에서 던지면
    // 에러 이벤트 filename 이 prelude URL 을 새므로). 2-패스라 부분 등록
    // 없이 instantiate 실패 의미를 보존한다.
    define(root, '__zp_lex_decl', (lexMap, varNames) => {
      const env = __zp_lex_env || zpLex;
      for (const n of varNames) {
        // var 는 전역 객체가 아니라 전역 varEnv 에 간다 — 충돌 검사는 항상
        // 공유 zpLex(전역 렉시컬) 기준, eval 환경에도 같은 eval 안의
        // 선언과는 충돌한다.
        if (zpLex.has(n) || (env !== zpLex && env.has(n))) return n;
      }
      for (const n of Object.keys(lexMap)) {
        if (env.has(n) || varNames.includes(n)) return n;
        // 전역 렉시컬 선언은 비configurable 전역 프로퍼티(var 선언 결과물,
        // location/document 같은 unforgeable)와도 충돌한다. eval 환경은
        // 별도 선언 환경이라 이 검사를 건너뛴다.
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
    // sloppy classic script 실행용 식별자 환경 — has 가 **등록된 이름에만**
    // true 라 나머지 식별자는 진짜 전역으로 그대로 통과한다.
    const zpLexScope = new Proxy({}, {
      has(_t, prop) { return zpLexGetEntry(prop) !== undefined; },
      get(_t, prop) { const e = zpLexGetEntry(prop); return e ? zpLexRead(e, prop) : undefined; },
      set(_t, prop, value) { const e = zpLexGetEntry(prop); if (!e) return false; zpLexWrite(e, prop, value); return true; },
      deleteProperty() { return false; },
    });
    define(root, '__zp_lex_scope', zpLexScope);
    const ZP_STRICT_DIRECTIVE_RE = /^(\s|\/\*[^]*?\*\/|\/\/[^\n]*)*('use strict'|"use strict")/;
    function execGlobalScript(code) {
      const geval = Native.globalEval;
      // sourceURL — eval'd 코드의 에러 filename 이 prelude URL 을 새지
      // 않고 문서의 가상 URL 을 가리키게 한다 (네이티브 인라인 스크립트
      // 에러는 문서 URL 을 reporting 한다).
      const tagged = '\n//# sourceURL=' + virtualURL.href;
      if (geval) {
        // R1: sloppy classic 은 전역 렉시컬 환경을 with(lexScope) 로
        // 에뮬레이션 — 등록되지 않은 식별자는 has=false 로 진짜 전역 통과.
        // strict eval 에선 with 자체가 불법이라 지시자 소스는 래핑하지
        // 않는다 (strict 잔여 gap — 등록은 되지만 bare 식별자 읽기 불가).
        if (!ZP_STRICT_DIRECTIVE_RE.test(code)) return geval('with(__zp_lex_scope){' + code + '\n}' + tagged);
        return geval(code + tagged);
      }
      return Native.FunctionCtor(code).call(root);
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
    // `_REWRITTEN` variants take code that zp-htmltx already rewrote — they
    // skip the page-side rewriter entirely. NAVER ships ~200KB + ~150KB
    // EAGER-DATA inline scripts; rewriting them twice (SW + page) wedged the
    // main thread for tens of seconds. SW already pays the OXC cost during
    // HTML transform, so the page just executes the result.
    define(root, '__ZP_EXEC_INLINE_REWRITTEN', code => execGlobalScript(String(code || '')));
    define(root, '__ZP_EXEC_INLINE_REWRITTEN_MODULE', code => {
      const blob = new Blob([String(code || '')], { type: 'text/javascript' });
      const url = Native.createObjectURL ? Native.createObjectURL(blob) : URL.createObjectURL(blob);
      const promise = import(url);
      promise.finally(() => { try { (Native.revokeObjectURL || URL.revokeObjectURL).call(URL, url); } catch {} });
      return promise;
    });
    define(root, '__ZP_EXEC_EVENT', (selfValue, event, source) => Native.FunctionCtor('event', rewriteWithPageRewriter(source, 'event-handler')).call(selfValue, event));
    define(root, 'eval', dynamicEval);
    define(root, 'Function', dynamicFunction);
    // 인스턴스별 가짜 constructor 저장소.
    // - value+writable:false → NAVER vendor-common 의 `Object.extend`
    //   polyfill (`target.constructor = source.constructor`) 가 strict throw →
    //   React init 깨짐 → 페이지 빈 렌더.
    // - accessor + WeakMap 저장 → NAVER 정상 (set 이 throw 안 함, read 가 저장값
    //   반환). 보안: `__zp_get` 가 reading 시점에 `dynamicWrapperFor` 로
    //   normalise 하므로 target 이 저장한 native Function 도 wrapper 로 반환 →
    //   escape 면역. BBC bbcdotcom SDK 의 retry-loop 는 hang (alternate value
    //   기대) — `.ai/trap-notebook/membrane.md` 에 known regression 기록.
    //   사용자 priority: www.naver.com 호환성 우선.
    const constructorOverrides = new WeakMap();
    for (const [ctor, wrapper] of dynamicConstructorWrappers) {
      if (ctor && ctor.prototype) try {
        // `configurable: false` 로 심으므로 같은 프로토타입에 두 번 오면 무조건
        // 던진다. 삼켜지긴 하지만 실측에서 로드당 천 단위였다.
        if (propertyLocked(ctor.prototype, 'constructor')) continue;
        defineMasked(ctor.prototype, 'constructor', {
          get() { return constructorOverrides.get(this) || wrapper; },
          set(value) { try { constructorOverrides.set(this, value); } catch {} },
          enumerable: false, configurable: false
        });
      } catch {}
    }
    if (Native.setTimeout) define(root, 'setTimeout', function(handler, delay, ...args) { return Native.setTimeout(typeof handler === 'string' ? compileDynamic(Native.FunctionCtor, [handler], 'function') : handler, delay, ...args); });
    if (Native.setInterval) define(root, 'setInterval', function(handler, delay, ...args) { return Native.setInterval(typeof handler === 'string' ? compileDynamic(Native.FunctionCtor, [handler], 'function') : handler, delay, ...args); });
    // `document.write` / `writeln` wrap 은 installDOMHooks(w) 에서 모든 realm
    // (parent + iframe Document.prototype) 에 일관 적용. 본 위치는 비워둠.
    if (Native.DOMParserParseFromString && root.DOMParser) define(root.DOMParser.prototype, 'parseFromString', function(markup, type) { const out = Native.DOMParserParseFromString.call(this, String(type).toLowerCase() === 'text/html' ? transformHTML(String(markup)) : markup, type); try { if (ceUpgradeSubtree && out && out.documentElement) ceUpgradeSubtree(out.documentElement); } catch {} return out; });
    if (Native.rangeCreateContextualFragment && root.Range) define(root.Range.prototype, 'createContextualFragment', function(markup) { const out = Native.rangeCreateContextualFragment.call(this, transformHTML(String(markup))); try { if (ceUpgradeSubtree) ceUpgradeSubtree(out); } catch {} return out; });
  }