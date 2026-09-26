
  function normalizedError(name = 'NotSupportedError') {
    try { return new Native.DOMException('Blocked by ZeroProxy policy', name); } catch { const e = new Error('Blocked by ZeroProxy policy'); e.name = name; return e; }
  }
  function nativeFunctionSource(key) {
    const name = typeof key === 'symbol' ? '' : String(key);
    return 'function ' + name + '() { [native code] }';
  }
  function nativeAccessorSource(kind, key) {
    const name = typeof key === 'symbol' ? '' : String(key);
    return 'function ' + kind + ' ' + name + '() { [native code] }';
  }
  function maskNativeFunction(fn, key) {
    if (typeof fn === 'function') toStringMap.set(fn, nativeFunctionSource(key));
  }
  function maskMethods(obj, keys) {
    for (const key of keys) maskNativeFunction(obj && obj[key], key);
  }
  // Web IDL members are enumerable; ours were not, so every property the
  // membrane touched flipped a bit the page can read. Measured on
  // Navigator.prototype: 76 members enumerable, and exactly the 6 we replaced
  // were not — `Object.keys(Navigator.prototype).includes('userAgent')` and
  // `for (k in navigator)` both disagreed with every real browser.
  //
  // A blanket `enumerable: true` would be wrong in the other direction: our own
  // `__zp_*` helpers must stay invisible, and for-in is NOT covered by the
  // getOwnPropertyNames/keys/ownKeys scrubbing. So inherit the flag from
  // whatever we are replacing — native members keep their enumerability,
  // membrane-only additions stay hidden. `configurable` stays false either way:
  // that is the E1 lock that stops a page deleting our accessor to reach the
  // native one, and it is the one axis we knowingly trade for the jail.
  //
  // ── 2026-08-18 결정 (닫힘). 이 자리를 "지문이니까" 로 다시 열지 말 것 ──
  // 실측: 후킹한 DOM 멤버 116곳이 `configurable:false` 이고 진짜 브라우저는
  // 전부 `true` 다. 프로토타입을 한 번 훑어 세기만 해도 멤브레인이 드러난다.
  // 그럼에도 이 값을 유지한다. 세 가지 선택지를 다 재 봤다:
  //  (a) `true` 로 푼다 — **측정해 보니 얻는 게 0 이다**. Cloudflare 판정은
  //      그대로였다(2026-08-16, stackoverflow 2회). 대신 페이지가 훅을 걷어낼
  //      여지가 생긴다. 비용만 있고 이득이 없다.
  //  (b) 디스크립터를 위장한다(`getOwnPropertyDescriptor` 가 true 로 보고) —
  //      **우리 코드가 먼저 깨진다.** `propertyLocked()` 는 바로 이 비트로
  //      "이미 설치됨" 을 판정한다(신원/WeakSet 은 멤브레인이 창을 감싸며 매번
  //      새 래퍼를 주기 때문에 못 쓴다). 위장하면 재설치로 들어가 던진다.
  //      게다가 `delete` 는 여전히 false 를 돌려주므로 **디스크립터와 실제
  //      동작이 모순**되어, 수동적인 인구조사 신호를 능동적 탐침 신호로 바꿀
  //      뿐이다.
  //  (c) 유지한다 ← 선택. 지문은 남지만 감옥이 감옥으로 남는다.
  // 되열려면 (a) 의 측정을 다시 해서 "이번엔 판정이 바뀐다" 를 먼저 보일 것.
  function nativeEnumerability(obj, key) {
    try {
      const d = Object.getOwnPropertyDescriptor(obj, key);
      return !!(d && d.enumerable);
    } catch { return false; }
  }
  function define(obj, key, value) {
    try {
      Object.defineProperty(obj, key, { value, enumerable: nativeEnumerability(obj, key), configurable: false, writable: true });
      // A native method's `.name` equals its property key. Ours came out of the
      // minifier as "" or a one-letter token, so `setTimeout.name`,
      // `window.addEventListener.name` and `navigator.serviceWorker.register
      // .name` all read "" where a browser reports the method name (measured
      // 2026-08-03). maskNativeFunction already fixes `.toString()`, which is
      // why this stayed invisible — the two are separate surfaces.
      if (typeof value === 'function' && value.name !== key) {
        try { Object.defineProperty(value, 'name', { value: key, configurable: true }); } catch {}
      }
      maskNativeFunction(value, key);
      return true;
    } catch { return false; }
  }
  // `enumSrc` names the object to copy enumerability FROM when `obj` itself has
  // nothing to inherit — the replaced classes (XHR/WebSocket/EventSource) build
  // a fresh prototype, so their only reference for the native flag is the
  // native prototype we are standing in for. `configurable: false` means the
  // flag cannot be corrected after the fact, so it has to be right here.
  function defineAccessor(obj, key, get, set, enumSrc) {
    try {
      Object.defineProperty(obj, key, { get, set, enumerable: nativeEnumerability(enumSrc || obj, key), configurable: false });
      if (typeof get === 'function') toStringMap.set(get, nativeAccessorSource('get', key));
      if (typeof set === 'function') toStringMap.set(set, nativeAccessorSource('set', key));
      return true;
    } catch { return false; }
  }
  // ★훅의 **소스**를 가린다. `define`/`defineAccessor` 는 이미 가리는데, 날
  // `Object.defineProperty` 로 접근자를 심은 자리가 31곳 남아 있었다.
  // 실측(2026-09-10): 그 자리들 때문에 74개 함수의 소스가 페이지에 그대로
  // 보였다 — `HTMLScriptElement.src` 게터는 `data-zp-target-url` 이라는
  // 내부 속성 이름까지 노출했다.
  //
  // 전수 스윕으로 뒤늦게 가리는 방법도 재 봤지만 창마다 5~7ms 라 프레임이
  // 많은 페이지에서 100ms 를 넘는다. 설치 지점에서 가리는 것이 맞다.
  //
  // defineAccessor 와 달리 디스크립터를 **그대로** 넘긴다 — configurable 이나
  // enumerable 을 일부러 다르게 둔 자리가 있어서 의미를 바꾸면 안 된다.
  function defineMasked(obj, key, desc) {
    try { Object.defineProperty(obj, key, desc); } catch { return false; }
    if (typeof desc.get === 'function') toStringMap.set(desc.get, nativeAccessorSource('get', key));
    if (typeof desc.set === 'function') toStringMap.set(desc.set, nativeAccessorSource('set', key));
    return true;
  }
  // 복수형도 같은 규칙이다 — 한 번에 여러 접근자를 심는 자리가 다섯 곳 있다.
  function definePropertiesMasked(obj, descs) {
    try { Object.defineProperties(obj, descs); } catch { return false; }
    for (const key of Object.getOwnPropertyNames(descs)) {
      const d = descs[key];
      if (!d) continue;
      if (typeof d.get === 'function') toStringMap.set(d.get, nativeAccessorSource('get', key));
      if (typeof d.set === 'function') toStringMap.set(d.set, nativeAccessorSource('set', key));
      if (typeof d.value === 'function') maskNativeFunction(d.value, key);
    }
    return true;
  }
  // 대체 클래스는 프로토타입을 Object.assign 으로 채운다. 그 멤버들도 전부
  // 네이티브인 척해야 한다 — `WebSocket.prototype.send` 의 소스가 그대로
  // 보이면 우리 구현이 통째로 읽힌다(실측).
  function assignMasked(proto, members) {
    Object.assign(proto, members);
    for (const key of Object.getOwnPropertyNames(members)) {
      if (key === 'constructor') continue;
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (!d) continue;
      if (typeof d.value === 'function') maskNativeFunction(d.value, key);
      if (typeof d.get === 'function') toStringMap.set(d.get, nativeAccessorSource('get', key));
      if (typeof d.set === 'function') toStringMap.set(d.set, nativeAccessorSource('set', key));
    }
    return proto;
  }
  // Web IDL puts interface members on the PROTOTYPE; a native singleton like
  // `navigator` / `history` / `performance` has zero own property names. When
  // we defined an accessor on both the prototype and the instance "to be
  // safe", the instance copy was pure fingerprint:
  // `Object.getOwnPropertyNames(navigator)` came back with our 6 names where
  // every real browser returns []. Define on the prototype, then verify the
  // instance actually reads through it, and only fall back to shadowing the
  // instance if something else is in the way. Normal case: no own props.
  function defineOnProto(instance, proto, key, get, set) {
    if (proto && defineAccessor(proto, key, get, set)) {
      // ★확인은 **게터를 부르지 않고** 한다(2026-08-24).
      //
      // 예전에는 `instance[key] === get.call(instance)` 로 값을 비교했다.
      // 그런데 게터가 **객체를 돌려주면** 두 호출이 서로 다른 객체라 이 비교는
      // 영원히 false 다 — `userAgentData` 가 정확히 그랬고, 그래서 매번
      // 폴백으로 빠져 **그 속성만 navigator 인스턴스에 정의**됐다. 실측:
      //   Object.getOwnPropertyNames(navigator).includes('userAgentData')
      //     직접 로드 false / 프록시 true   ← 한 줄짜리 탐지기
      // (같은 블록의 userAgent·platform 등은 문자열을 돌려주니 멀쩡했다.
      //  즉 "대부분 맞으니 맞겠지" 가 통하지 않는 자리였다.)
      //
      // 게터를 부르는 것 자체도 부작용이었다 — 설치 시점에 게터가 참조하는
      // 모듈 변수가 아직 초기화 전이면 TDZ 가 나고, `catch` 가 그걸 삼켰다.
      //
      // 우리가 확인하려는 것은 "프로토타입에 우리 접근자가 놓였고, 인스턴스에
      // 그걸 가리는 own 속성이 없다" 뿐이다. 둘 다 서술자로 알 수 있다.
      try {
        const own = instance && Object.getOwnPropertyDescriptor(instance, key);
        const onProto = Object.getOwnPropertyDescriptor(proto, key);
        if (!instance || (!own && onProto && onProto.get === get)) return true;
      } catch {}
    }
    return defineAccessor(instance, key, get, set);
  }
  // Same idea for methods (navigator.sendBeacon, history.pushState/replaceState).
  function defineMethodOnProto(instance, proto, key, value) {
    if (proto && define(proto, key, value)) {
      try { if (!instance || instance[key] === value) return true; } catch {}
    }
    return define(instance, key, value);
  }
  // ★리라이트된 **페이지 코드**가 자기 소스를 문자열로 만들면 우리 호출이
  // 그대로 보인다. 실측(2026-09-10): naver 8,490개 중 17개, github 8,655개
  // 중 89개가 `__zp_get(globalThis,"window")` 같은 텍스트를 노출했다.
  // 전역 **이름** 노출은 예전에 스크러버로 막았지만(LOG.md) 함수 **소스**는
  // 아무도 안 보고 있었다.
  //
  // 그래서 우리 호출을 되돌려서 돌려준다. 목적은 완벽한 원본 복구가 아니라
  // `__zp_` 라는 표식을 없애는 것이고, **되돌릴 수 없는 모양은 손대지 않는다**
  // — 망친 소스가 더 큰 티다.
  //
  // 감옥은 유지된다: 되돌린 소스를 페이지가 다시 컴파일해도
  // (`new Function(String(fn))`) 그 경로는 compileNested 의 `with(scope)` 를
  // 지나므로 자유 식별자가 스코프 프록시로 해석된다. 리라이트가 아니라
  // 스코프가 컨테인먼트를 지고 있다.
  function unrewriteSourceText(src) {
    // 빠른 탈출 — 대부분의 호출은 우리와 무관하다. 아래 정의를 만들기 전에 끊는다.
    if (typeof src !== 'string') return src;
    if (src.indexOf('__zp_') < 0 && src.indexOf('__ZP_EXEC_EVENT') < 0) return src;
    const ZP_SRC_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
    const ZP_SRC_SIMPLE = /^(this|[A-Za-z_$][A-Za-z0-9_$]*)(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
    // ★리라이터가 **합성해 넣은** 기본형만 생략한다. 자유 식별자를 감쌀 때
    // 쓰는 이름은 globalThis 하나다(리라이터 소스 확인). window/self 를 여기
    // 넣으면 페이지가 직접 쓴 `window.open(x)` 이 `open(x)` 으로 줄어
    // **원본과 다른 텍스트**가 된다 — 되돌리기의 목적에 어긋난다.
    const ZP_SRC_GLOBALS = new Set(['globalThis']);

    // 균형 잡힌 인자 목록을 자른다. 문자열 안의 괄호는 세지 않는다.
    function zpSrcSplitArgs(s, i) {
      const args = [];
      let depth = 0, start = i + 1, j = i;
      for (; j < s.length; j++) {
        const c = s[j];
        if (c === '"' || c === "'" || c === '`') {
          const q = c;
          j++;
          while (j < s.length) {
            if (s[j] === '\\') { j += 2; continue; }
            if (s[j] === q) break;
            j++;
          }
          if (j >= s.length) return null;
          continue;
        }
        if (c === '(' || c === '[' || c === '{') { depth++; continue; }
        if (c === ')' || c === ']' || c === '}') {
          depth--;
          if (depth === 0) { args.push(s.slice(start, j)); return [args, j]; }
          continue;
        }
        if (c === ',' && depth === 1) { args.push(s.slice(start, j)); start = j + 1; }
      }
      return null;
    }

    // "abc" / 'abc' 리터럴이면 그 값을, 아니면 null.
    function zpSrcLiteral(a) {
      const t = a.trim();
      if (t.length < 2) return null;
      const q = t[0];
      if ((q !== '"' && q !== "'") || t[t.length - 1] !== q) return null;
      const body = t.slice(1, -1);
      if (body.indexOf(q) >= 0 || body.indexOf('\\') >= 0) return null;
      return body;
    }

    // 단순한 기본형이 아니면 괄호로 감싼다. 안 감싸면
    // `__zp_get(a||b,"k")` 가 `a||b.k` 가 되어 뜻이 바뀐다.
    function zpSrcBaseText(src) {
      const t = unrewriteSource(src).trim();
      if (ZP_SRC_SIMPLE.test(t)) return t;
      if (t[0] === '(' && t[t.length - 1] === ')') return t;
      return '(' + t + ')';
    }

    function zpSrcMember(baseSrc, keyArg) {
      const base = zpSrcBaseText(baseSrc);
      const key = zpSrcLiteral(keyArg);
      const isGlobal = ZP_SRC_GLOBALS.has(base);
      if (key !== null && ZP_SRC_IDENT.test(key)) return isGlobal ? key : base + '.' + key;
      const k = unrewriteSource(keyArg).trim();
      return isGlobal ? 'globalThis[' + k + ']' : base + '[' + k + ']';
    }

    function unrewriteSource(src) {
      const s = String(src == null ? '' : src);
      if (s.indexOf('__zp_') < 0 && s.indexOf('__ZP_EXEC_EVENT') < 0) return s;
      let out = '';
      let i = 0;
      while (i < s.length) {
        const c = s[i];
        // 보통 문자열은 통째로 넘긴다 — 안의 `__zp_` 는 페이지 자신의 텍스트일 수 있다.
        if (c === '"' || c === "'") {
          const q = c;
          let j = i + 1;
          while (j < s.length) {
            if (s[j] === '\\') { j += 2; continue; }
            if (s[j] === q) break;
            j++;
          }
          out += s.slice(i, Math.min(j + 1, s.length));
          i = Math.min(j + 1, s.length);
          continue;
        }
        // ★템플릿 리터럴은 통째로 넘기면 안 된다. `${…}` 안은 **코드**라
        // 리라이트가 그대로 들어 있다 — github 실측에서 남은 8건이 전부 여기였다
        // (`` `${__zp_get(globalThis,"window").innerWidth}px` ``). 리터럴 텍스트는
        // 건드리지 않고 치환식 안쪽만 재귀로 되돌린다.
        if (c === '`') {
          let j = i + 1;
          let buf = '`';
          while (j < s.length) {
            if (s[j] === '\\') { buf += s.slice(j, j + 2); j += 2; continue; }
            if (s[j] === '`') { buf += '`'; j++; break; }
            if (s[j] === '$' && s[j + 1] === '{') {
              const sub = zpSrcSplitArgs(s, j + 1);
              if (!sub) { buf += s[j]; j++; continue; }
              buf += '${' + unrewriteSource(sub[0].join(',')) + '}';
              j = sub[1] + 1;
              continue;
            }
            buf += s[j];
            j++;
          }
          out += buf;
          i = j;
          continue;
        }
        if (c !== '_') { out += c; i++; continue; }
        const prev = i > 0 ? s[i - 1] : '';
        if (prev && /[A-Za-z0-9_$.]/.test(prev)) { out += c; i++; continue; }
        // ★인라인 이벤트 핸들러(`<a onclick="…">`)는 래퍼로 감싸 두는데, 그
        // 래퍼의 세 번째 인자가 **원본 속성 본문 그대로**다(리라이트는 호출
        // 시점에 한다). 그래서 여기서는 정확한 복구가 된다. 래퍼가 붙인
        // `return ` 도 같이 걷어낸다 — 브라우저가 보여 주는 본문에는 없다.
        const ev = /^__ZP_EXEC_EVENT\(/.exec(s.slice(i));
        if (ev) {
          const sub = zpSrcSplitArgs(s, i + ev[0].length - 1);
          let body = null;
          if (sub && sub[0].length === 3) {
            try { body = JSON.parse(sub[0][2].trim()); } catch { body = null; }
          }
          if (typeof body === 'string') {
            out = out.replace(/return[ \t]+$/, '');
            out += body;
            i = sub[1] + 1;
            continue;
          }
        }
        // ★루프 캡. `for(;;)` 와 `while(true)` 는 **둘 다** 계수기 붙은 for 로
        // 바뀌므로 어느 쪽이 원본이었는지 알 수 없다. `for(;;)` 로 되돌린다 —
        // 뜻은 같고, 표식은 사라진다. do-while 은 계수기 선언이 `do` 앞에
        // 붙고 test 가 계수기 검사로 바뀌므로 그 둘을 각각 되돌린다.
        const lcFor = /^__zp_lc_(\d+)=0;__zp_lc_\1\+\+<10000000;\)/.exec(s.slice(i));
        if (lcFor && /for\(let $/.test(out)) {
          out = out.replace(/for\(let $/, 'for(;;)');
          i += lcFor[0].length;
          continue;
        }
        const lcDecl = /^__zp_lc_\d+=0;/.exec(s.slice(i));
        if (lcDecl && /let $/.test(out)) {
          out = out.replace(/let $/, '');
          i += lcDecl[0].length;
          continue;
        }
        const lcTest = /^__zp_lc_\d+\+\+<10000000/.exec(s.slice(i));
        if (lcTest) {
          out += 'true';
          i += lcTest[0].length;
          continue;
        }
        const m = /^__zp_(get|set|call|assign|update)\(/.exec(s.slice(i));
        if (!m) { out += c; i++; continue; }
        const kind = m[1];
        const parsed = zpSrcSplitArgs(s, i + m[0].length - 1);
        if (!parsed) { out += c; i++; continue; }
        const args = parsed[0];
        const end = parsed[1];
        let rep = null;
        if (kind === 'get' && args.length === 2) rep = zpSrcMember(args[0], args[1]);
        else if (kind === 'set' && args.length === 3) rep = zpSrcMember(args[0], args[1]) + '=' + unrewriteSource(args[2]).trim();
        else if (kind === 'call' && args.length === 3) {
          const inner = args[2].trim();
          if (inner[0] === '[' && inner[inner.length - 1] === ']') {
            rep = zpSrcMember(args[0], args[1]) + '(' + unrewriteSource(inner.slice(1, -1)).trim() + ')';
          }
        } else if (kind === 'assign' && args.length === 4) {
          const op = zpSrcLiteral(args[2]);
          if (op) rep = zpSrcMember(args[0], args[1]) + op + unrewriteSource(args[3]).trim();
        } else if (kind === 'update' && args.length === 4) {
          const op = zpSrcLiteral(args[2]);
          const pre = args[3].trim();
          if (op && (pre === 'true' || pre === '!0')) rep = op + zpSrcMember(args[0], args[1]);
          else if (op && (pre === 'false' || pre === '!1')) rep = zpSrcMember(args[0], args[1]) + op;
        }
        if (rep === null) { out += c; i++; continue; }
        out += rep;
        i = end + 1;
      }
      return out;
    }
    return unrewriteSource(src);
  }
  function installToStringMasking(w) {
    const proto = w && w.Function && w.Function.prototype;
    if (!proto || toStringMaskedPrototypes.has(proto)) return;
    const orig = w === root ? origToString : proto.toString;
    if (typeof orig !== 'function') return;
    const maskedToString = function toString() {
      if (typeof this === 'function' && toStringMap.has(this)) return toStringMap.get(this);
      // 우리가 가린 훅이 아니면 페이지 자신의 코드다 — 리라이트 흔적을 되돌린다.
      return unrewriteSourceText(orig.call(this));
    };
    toStringMap.set(maskedToString, 'function toString() { [native code] }');
    try {
      Object.defineProperty(proto, 'toString', { value: maskedToString, enumerable: false, configurable: true, writable: true });
      toStringMaskedPrototypes.add(proto);
    } catch {}
  }
  // Move replaced-class state from instance data properties onto PROTOTYPE
  // accessors, the shape every native counterpart has. Writing `this.readyState
  // = …` in a constructor then routes through the setter instead of creating an
  // own property, so no call site changes. Two things break without this:
  //   * `'readyState' in WebSocket.prototype` is false, and any library that
  //     wraps `WebSocket.prototype.send` / patches an accessor silently no-ops;
  //   * the prototype name count differs from a real browser (measured
  //     2026-08-03: WebSocket 12 vs 17, EventSource 8 vs 11), a free proxy tell.
  function mirrorNativeProto(proto, names, nativeProto) {
    if (!proto) return;
    for (const name of names) {
      const key = '_zp' + name;
      defineAccessor(proto, name,
        function () { return this[key]; },
        function (v) { this[key] = v; },
        nativeProto);
    }
  }
  // Native XHR / WebSocket / EventSource INHERIT addEventListener,
  // removeEventListener and dispatchEvent from EventTarget — they are not own
  // properties of the class prototype. Defining them directly on each class
  // prototype pushed every one of ours 3 names past the native count (measured
  // 2026-08-03: XHR 28 vs 27, WebSocket 20 vs 17, EventSource 14 vs 11). Hang
  // them off a single shared intermediate prototype and splice that into each
  // class's chain instead: same lookup, same behaviour, and the own-property
  // count now matches a real browser.
  //
  // `class X extends EventTarget` would be the exact native shape, but native
  // dispatchEvent needs a branded EventTarget instance — that means
  // Reflect.construct inside three constructors, a refactor with real breakage
  // risk. This gets the observable shape right without touching event delivery.
  // Give each replaced class the two brands a real Web IDL interface carries:
  //   * `Ctor.name` — the build minifier renamed our constructors, so
  //     `XMLHttpRequest.name` read "c" (WebSocket "f", EventSource "o",
  //     Worker "t") where every browser reports the interface name. A one-token
  //     equality check catches that; `String(ctor)` was already masked, which
  //     made the mismatch easy to miss.
  //   * `Symbol.toStringTag` — without it `Object.prototype.toString.call(xhr)`
  //     returned "[object Object]" instead of "[object XMLHttpRequest]". That
  //     is a fingerprint AND a functional break: type-dispatch helpers in the
  //     wild switch on exactly this string.
  function brandLikeNative(ctor, proto, name) {
    try { if (ctor) Object.defineProperty(ctor, 'name', { value: name, configurable: true }); } catch {}
    try { if (proto) Object.defineProperty(proto, Symbol.toStringTag, { value: name, configurable: true }); } catch {}
  }
  // D7: 타깃 오리진마다 SharedWorker 이름을 이 접두어로 스코프한다 — 없으면
  // 프록시 오리진 하나를 공유하는 서로 다른 타깃 두 개가 **같은** SharedWorker
  // 인스턴스를 붙잡는다(SharedWorker 는 realm 안에서 origin+name+url 로
  // dedup). installStorageFacades 의 계산과 별개 함수지만 같은 FNV-1a 를
  // virtualURL.origin 에 돌리므로 항상 같은 문자열이 나온다.
  function sharedWorkerNamePrefix() {
    const key = virtualURL.origin;
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
    return 'zp:w:' + ('00000000' + (h >>> 0).toString(16)).slice(-8) + ':';
  }
  let sharedEventTargetProto = null;
  function eventTargetProto() {
    if (sharedEventTargetProto) return sharedEventTargetProto;
    // Rooted at EventTarget.prototype so `xhr instanceof EventTarget` is true,
    // as it is natively (it was false). Our own methods below shadow the native
    // ones, so nothing reaches the branded native implementations.
    let base = Object.prototype;
    try { if (typeof EventTarget === 'function' && EventTarget.prototype) base = EventTarget.prototype; } catch {}
    const p = Object.create(base);
    define(p, 'addEventListener', function(type, fn) { if (!fn) return; const key = String(type); if (!this[listenersKey]) this[listenersKey] = new Map(); const list = this[listenersKey].get(key) || []; list.push(fn); this[listenersKey].set(key, list); });
    define(p, 'removeEventListener', function(type, fn) { const list = this[listenersKey] && this[listenersKey].get(String(type)); if (!list) return; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); });
    define(p, 'dispatchEvent', function(event) { const list = this[listenersKey] && this[listenersKey].get(event.type) || []; try { if (!event.target) Object.defineProperty(event, 'target', { value: this, configurable: true }); } catch {} const handler = this['on' + event.type]; if (typeof handler === 'function') handler.call(this, event); for (const fn of list.slice()) fn.call(this, event); return !event.defaultPrevented; });
    sharedEventTargetProto = p;
    return p;
  }
  function installEventMethods(proto) {
    if (!proto) return;
    try { Object.setPrototypeOf(proto, eventTargetProto()); } catch {}
  }