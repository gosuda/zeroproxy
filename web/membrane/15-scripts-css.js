  function installIntegrityProp(proto) {
    if (!proto) return;
    defineAccessor(proto, 'integrity', function() {
      const backed = backedIntegrity(this);
      return backed !== null ? backed : Native.getAttribute.call(this, 'integrity') || '';
    }, function(v) {
      setBackedIntegrity(this, v);
    });
  }
  function propertyDescriptor(proto, prop) {
    for (let p = proto; p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, prop);
      if (d) return d;
    }
    return null;
  }
  function executableScriptKindForElement(el) {
    const t = String(Native.getAttribute.call(el, 'type') || '').trim().toLowerCase();
    if (t === 'module') return 'module';
    if (t === '' || t === 'text/javascript' || t === 'application/javascript' || t === 'application/ecmascript' || t === 'text/ecmascript') return 'classic';
    return '';
  }
  function scriptProxyPath(target, kind) {
    // Emit proxy-origin-absolute URL. The page's virtual baseURI points at
    // the target host (e.g. https://www.naver.com/), so a root-relative
    // `/zp/api/script?...` would resolve to the target host and bypass our
    // SW. Dynamic scripts (createElement+appendChild, document.write…) hit
    // this path; naver loaded multiple tracker/SDK <script> tags this way and
    // each one 404'd against naver.com — silent breakage of veta/N/jindo etc.
    // 또한 CSP `script-src 'self'` 가 cross-origin raw URL 차단 → 반드시
    // proxy-origin 으로 라우팅.
    // `ref` = 요청 시점의 **가상 문서 URL**. SW 는 이걸 Referer 로 쓴다.
    // entry.baseUrl 만 쓰면 안 되는 이유(실측 2026-08-18, Cloudflare 챌린지):
    // 페이지가 `history.replaceState` 로 URL 을 바꾸고 **같은 틱에** 스크립트를
    // 붙이면, 우리 SW 통지는 postMessage 라 비동기여서 요청이 먼저 나간다.
    // CF 인터스티셜이 정확히 그 패턴이다 — replaceState 로 `?__cf_chl_rt_tk=…`
    // 를 심고 곧바로 챌린지 스크립트를 append 한 뒤 onload 에서 되돌린다.
    // 토큰이 빠진 Referer 로 받아 온 스크립트는 페이지 상태와 어긋나 VM 이
    // 엉뚱한 핸들러로 디스패치하고 `undefined.call` 로 죽는다.
    // ★모듈은 **URL 이 곧 정체성**이다 — `ref` 를 넣으면 안 된다 (2026-09-04).
    //
    // 정적 `import` 는 Rust 리라이터가 `?u=<타깃>&kind=module` 로 바꾸고(ref 없음,
    // 순서도 u→kind), 동적 경로는 여기서 `?kind=…&u=…&ref=<가상 URL>` 로 만들었다.
    // 같은 모듈이 **두 URL** 이 되니 모듈 맵에 두 벌이 올라간다.
    //
    // GitHub 실측: react-core / react-lib 을 포함해 15개 모듈이 두 벌씩 로드됐다.
    // React 가 두 개면 훅이 깨진다 — `Minified React error #321` 138건,
    // `Cannot destructure property 'routeContext' of 'undefined'` 12건이 뒤따르고,
    // 마지막에 GitHub 자신의 에러 경계가 ErrorPage 를 그린다. 문서 자체는 200 이고
    // `<title>` 도 그대로라 title/raw/csp/err 축이 전부 통과했다.
    //
    // `ref` 는 그대로 둘 값이 아니다: `withCurrentRef` 가 이걸 **현재 가상 URL 로
    // 계속 갱신**하므로, 문서 URL 이 바뀌면 같은 모듈이 또 새 URL 이 된다.
    // 시간에 따라 변하는 값은 모듈 식별자에 들어갈 수 없다.
    //
    // classic 스크립트는 모듈 맵이 없어 URL 정체성 문제가 없으므로 ref 를 유지한다
    // (CF 챌린지 타이밍 때문에 필요하다 — 아래 주석 참고). 모듈은 Rust 쪽과
    // **바이트 단위로 같은** 정규형을 쓰고, Referer 는 SW 가 요청의
    // `request.referrer` 에서 유도한다(referrerFromBrowserHeader).
    if (kind === 'module') return proxyOrigin + ZP.apiPath('script') + '?u=' + encodeURIComponent(target) + '&kind=module';
    return proxyOrigin + ZP.apiPath('script') + '?kind=' + encodeURIComponent(kind) + '&u=' + encodeURIComponent(target) + '&ref=' + encodeURIComponent(virtualURL.href);
  }
  // 프록시 api URL 의 `ref` 파라미터를 현재 가상 URL 로 바꿔 준다.
  function withCurrentRef(value) {
    try {
      const s = String(value);
      if (s.indexOf(ZP.apiPath('script')) < 0 || s.indexOf('ref=') < 0) return s;
      const u = new URL(s, proxyOrigin);
      u.searchParams.set('ref', virtualURL.href);
      return u.href;
    } catch { return String(value); }
  }
  function setScriptSource(el, raw) {
    try { zpTrace('scriptSrc', String(raw).slice(0,140)); } catch {}
    const kind = executableScriptKindForElement(el);
    // share 경로는 스크립트가 아니다 — 아래 CONTROL_PREFIX 분기가 이미
    // 프록시 URL 이라고 착각하고 그대로 두면 우리 문서를 JS 로 로드한다.
    // 여기서만 게이트를 태운다. 래퍼(/zp/api/script?…) 는 건드리지 않는다.
    const value = unleakedTargetRaw(raw) === null ? virtualURL.href : String(raw);
    const trimmed = value.trim();
    if (trimmed.startsWith(ZP.CONTROL_PREFIX) || trimmed.startsWith(proxyOrigin + ZP.CONTROL_PREFIX)) {
      // Keep proxy-origin-absolute URLs absolute. The page's virtual baseURI
      // points at the target host (e.g. https://www.naver.com/), so a
      // root-relative `/zp/...` path would resolve to the target host and the
      // request would miss our SW. zp-htmltx already emits absolute proxy
      // URLs for SW-routed subresources — preserve them here.
      // 삽입 직전에 다시 불릴 때(prepareScriptElement) `ref` 를 **지금** 값으로
      // 갱신한다. src 대입 시점과 DOM 삽입 시점 사이에 replaceState 가 끼면
      // 대입 때 박아 둔 ref 는 이미 낡았다.
      const refreshed = withCurrentRef(value);
      // ★이 분기는 **스태시 없이** 통과하고 있었다. 서버측 htmltx 가 고쳐 내려보낸
      // 정적 스크립트나 페이지가 복사해 재대입한 값이 여기로 들어오는데,
      // 그러면 `src` / `getAttribute('src')` 가 되돌릴 근거를 잃어 **프록시 URL 이
      // 그대로 보인다** — stackoverflow 에서 실측됐다(`/zp/api/script?u=…`).
      // 값 안에 타깃이 들어 있으므로 여기서 복구해 다른 모든 표면과 같은
      // 자리(`urlMeta` + `data-zp-target-url`)에 남긴다.
      const recovered = deproxyURL(refreshed, {});
      if (recovered && recovered !== refreshed) {
        urlMeta.set(el, recovered);
        Native.setAttribute.call(el, 'data-zp-target-url', recovered);
      }
      if (Native.getAttribute.call(el, 'src') === refreshed) return;
      return Native.setAttribute.call(el, 'src', refreshed);
    }
    if (!kind) {
      urlMeta.delete(el);
      return Native.setAttribute.call(el, 'src', value);
    }
    if (hasExecutableURLScheme(value)) return blockExecutableURL(el, 'src', value);
    const target = targetURLForElement(el, value);
    if (!target) return blockExecutableURL(el, 'src', value);
    urlMeta.set(el, target);
    litSet(el, 'src', raw);
    Native.setAttribute.call(el, 'data-zp-target-url', target);
    return Native.setAttribute.call(el, 'src', scriptProxyPath(target, kind));
  }
  // ── 런타임 CSS 의 url() / @import ────────────────────────────────────────
  //
  // **절대 http(s) URL 만 건드린다.** 상대 URL 은 브라우저가 문서(= 프록시 공유
  // 경로) 기준으로 풀어 프록시 오리진으로 오고, SW 가 ctx 로 타깃에 매핑한다
  // (3e76a32). 거기까지 손대면 이중 매핑이 된다 — 그래서 여기서 하는 일은
  // "브라우저가 우리를 거치지 않고 직접 갈 수 있는 URL" 만 프록시 경로로
  // 돌리는 것뿐이다.
  function cssProxyURL(raw) {
    const t = String(raw == null ? '' : raw).trim();
    if (!/^https?:\/\//i.test(t)) return null;
    if (t.startsWith(proxyOrigin)) return null;
    return subresourceProxyPath(t);
  }
  // 정규식이 아니라 스캐너인 이유: `url(` 를 정규식으로 찾으면 주석과 문자열
  // 안의 것까지 잡아 `content: "url(http://x)"` 같은 **페이지 텍스트를 조용히
  // 바꾼다**. 보안 프록시가 페이지 내용을 변조하면 안 된다.
  function rewriteCSSText(input) {
    const s = String(input == null ? '' : input);
    if (s.indexOf('(') < 0 && s.indexOf('@import') < 0) return s;
    const isIdentChar = (ch) => ch !== undefined && /[A-Za-z0-9_$-]/.test(ch);
    const n = s.length;
    let out = '';
    let i = 0;
    // `@import "x.css"` 는 url() 없이 문자열만 오는 형태다. 그 문자열 하나만
    // 리라이트 대상으로 표시해 둔다 — 다른 문자열은 건드리지 않는다.
    let pendingImport = false;
    // image-set(...) 안쪽인지. 0 이면 바깥이다.
    let imageSetDepth = 0;
    while (i < n) {
      const c = s[i];
      if (c === '/' && s[i + 1] === '*') {
        const e = s.indexOf('*/', i + 2);
        const stop = e < 0 ? n : e + 2;
        out += s.slice(i, stop);
        i = stop;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n) {
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] === c) break;
          j++;
        }
        const mapped = (pendingImport || imageSetDepth > 0) ? cssProxyURL(s.slice(i + 1, Math.min(j, n))) : null;
        out += mapped ? c + mapped + c : s.slice(i, Math.min(j + 1, n));
        i = Math.min(j + 1, n);
        pendingImport = false;
        continue;
      }
      if ((c === 'u' || c === 'U') && !isIdentChar(s[i - 1]) && /^url\(/i.test(s.slice(i, i + 4))) {
        let j = i + 4;
        while (j < n && /\s/.test(s[j])) j++;
        const q = s[j] === '"' || s[j] === "'" ? s[j] : '';
        let k = q ? j + 1 : j;
        while (k < n) {
          if (s[k] === '\\') { k += 2; continue; }
          if (q ? s[k] === q : s[k] === ')') break;
          k++;
        }
        const close = s.indexOf(')', k);
        const stop = close < 0 ? n : close + 1;
        const mapped = cssProxyURL(s.slice(q ? j + 1 : j, k));
        // 따옴표 없는 url() 토큰에도 프록시 경로에는 `?`/`&`/`%` 가 들어가므로
        // 항상 따옴표를 씌워 돌려준다.
        out += mapped ? 'url(' + (q || '"') + mapped + (q || '"') + ')' : s.slice(i, stop);
        i = stop;
        pendingImport = false;
        continue;
      }
      // `image-set("a.png" 1x, "a2.png" 2x)` — url() 없이 맨 문자열도 받는다.
      // Rust zp-css 에는 넣었는데(2026-08-20) 이 스캐너는 손으로 쓴 별도 구현이라
      // 갈라져 있었다. 구멍 매트릭스 g6-realm-imageset 이 csp-only 로 잡았다.
      if ((c === 'i' || c === 'I' || c === '-') && !isIdentChar(s[i - 1])) {
        const m = /^(-webkit-)?image-set\(/i.exec(s.slice(i, i + 18));
        if (m) {
          out += s.slice(i, i + m[0].length);
          i += m[0].length;
          imageSetDepth = 1;
          continue;
        }
      }
      if (imageSetDepth > 0) {
        if (c === '(') imageSetDepth++;
        else if (c === ')') imageSetDepth--;
      }
      if (c === '@' && /^@import\b/i.test(s.slice(i, i + 8))) {
        out += s.slice(i, i + 7);
        i += 7;
        pendingImport = true;
        continue;
      }
      if (!/\s/.test(c)) pendingImport = false;
      out += c;
      i++;
    }
    return out;
  }
  // 인라인 style 선언 하나당 프록시 하나. 같은 선언에 늘 같은 프록시를 줘야
  // `var` 다 — 이 파일에서 설치 시퀀스는 선언보다 **위**에서 돈다. `let`/`const`
  // 로 두면 TDZ ReferenceError 가 나고 그게 멤브레인 설치를 통째로 중단시킨다
  // (오늘 이 파일에서만 두 번 밟았다).
  var styleHookState = 'not-run';
  const styleDeclProxies = new WeakMap();
  const styleDeclMethods = new WeakMap();
  function containStyleDeclaration(decl) {
    if (!decl || typeof decl !== 'object') return decl;
    const cached = styleDeclProxies.get(decl);
    if (cached) return cached;
    let proxy;
    try {
      proxy = new Proxy(decl, {
        get(t, k) {
          const v = Reflect.get(t, k);
          // 쓰기에서 url() 을 프록시 URL 로 바꿨으니 읽기에서 되돌린다.
          // 이 트랩이 **모든** 프로퍼티를 지나므로 이름 목록이 필요 없다 —
          // 350개 IDL 세터는 인스턴스의 own data property 라 프로토타입
          // 훅으로는 애초에 닿지 않는다(실측).
          if (typeof v === 'string') return deproxyURL(v, { scan: true });
          if (typeof v !== 'function') return v;
          // 메서드는 네이티브 선언에 바인딩해야 한다 — 프록시를 receiver 로
          // 부르면 `Illegal invocation` 이 난다. 바인딩 결과는 캐시한다:
          // 매번 새 함수를 주면 `a.style.setProperty === a.style.setProperty`
          // 가 false 가 되어 라이브러리의 기능 탐지가 깨진다.
          let per = styleDeclMethods.get(t);
          if (!per) { per = new Map(); styleDeclMethods.set(t, per); }
          let bound = per.get(k);
          if (!bound) {
            bound = k === 'setProperty'
              ? function (p, val, pr) { return v.call(t, p, rewriteCSSText(val), pr); }
              : k === 'getPropertyValue'
                ? function (p) { return deproxyURL(v.call(t, p), { scan: true }); }
                : v.bind(t);
            // 프록시 트랩이 만드는 함수라 설치 시점 마스킹이 못 닿는다.
            maskNativeFunction(bound, k);
            per.set(k, bound);
          }
          return bound;
        },
        set(t, k, v) {
          try { t[k] = typeof v === 'string' ? rewriteCSSText(v) : v; } catch { return false; }
          return true;
        }
      });
    } catch { return decl; }
    styleDeclProxies.set(decl, proxy);
    return proxy;
  }
  // `style` 접근자를 가진 **모든** 인터페이스를 감싼다. 이름을 손으로 적지
  // 않는 것이 요점이라 순회는 이 함수 하나로 모아 둔다(테스트가 이 규칙을
  // 그대로 실행한다).
  function containEveryStyleAccessor(w) {
    let count = 0;
    let names = null;
    try { names = Object.getOwnPropertyNames(w); } catch { return 0; }
    for (const name of names) {
      // WebIDL 인터페이스는 대문자로 시작한다. 소문자 전역까지 읽으면 게터
      // 부작용을 건드릴 수 있어 좁힌다 — 이건 목록이 아니라 명명 규칙이다.
      const c0 = name.charCodeAt(0);
      if (c0 < 65 || c0 > 90) continue;
      let proto = null;
      try {
        const iface = w[name];
        if (typeof iface !== 'function') continue;
        proto = iface.prototype;
      } catch { continue; }
      if (!proto || typeof proto !== 'object') continue;
      // ★**own** 디스크립터만 본다. propertyDescriptor 는 프로토타입 체인을
      // 타므로 그걸 쓰면 상속된 style 을 서브클래스마다 own 으로 새로 만든다 —
      // 실측(2026-09-10): own style 을 가진 프로토타입이 대조군 13개 vs 우리
      // 157개가 되어, 고치려던 지문보다 훨씬 큰 지문을 만든다. 네이티브가
      // 선언한 13개만 감싸도 서브클래스는 상속으로 전부 덮인다.
      const sd = Object.getOwnPropertyDescriptor(proto, 'style');
      if (!sd || !sd.get) continue;
      try {
        defineMasked(proto, 'style', {
          get() { return containStyleDeclaration(sd.get.call(this)); },
          set: sd.set ? function (v) { return sd.set.call(this, rewriteCSSText(v)); } : undefined,
          enumerable: sd.enumerable,
          configurable: false
        });
        count++;
      } catch {}
    }
    return count;
  }
  // ★CSS Typed OM 은 별도 인터페이스 계열이라 style/cssText 훅이 전혀 닿지
  // 않는다. 실측(2026-09-10):
  //   ① 훅이 걸린 경로로 쓰고 Typed OM 으로 읽으면 **프록시 URL 이 그대로**
  //      보였다 — attributeStyleMap.get 과 computedStyleMap().get 둘 다.
  //   ② attributeStyleMap.set 으로 쓴 url() 은 재작성을 안 지났다.
  //
  // 읽기 메서드는 전부 StylePropertyMapReadOnly.prototype 에 있고
  // StylePropertyMap 이 그것을 상속한다(실측) — 한 곳만 훅하면 인라인
  // 스타일맵과 계산 스타일맵이 함께 덮인다.
  //
  // 되돌리기는 CSSStyleValue 를 문자열로 만들어 고친 뒤 다시 파싱한다.
  // `CSSStyleValue.parse(prop, String(v))` 왕복이 정확하고(실측), 네이티브도
  // 호출마다 **새 객체**를 주므로(get(x) !== get(x), 실측) 우리가 새로 만든
  // 값을 돌려줘도 동일성 지문이 생기지 않는다.
  //
  // ★읽기와 쓰기는 같이 가야 한다. 쓰기만 고치면 저장된 값이 프록시 URL 이
  // 되는데 읽기가 안 되돌리므로 ①번 누출이 오히려 늘어난다.
  function installTypedOM(w) {
    const RO = w.StylePropertyMapReadOnly && w.StylePropertyMapReadOnly.prototype;
    if (!RO) return 0;
    const SM = w.StylePropertyMap && w.StylePropertyMap.prototype;
    const CSV = w.CSSStyleValue;
    const canParse = CSV && typeof CSV.parse === 'function';
    let hooked = 0;

    // CSSStyleValue 하나를 되돌린다. 바뀐 게 없으면 **원래 객체 그대로** 준다.
    const back = (prop, v) => {
      if (!v || typeof v !== 'object' || !canParse) return v;
      let text;
      try { text = String(v); } catch { return v; }
      const fixed = deproxyURL(text, { scan: true });
      if (fixed === text) return v;
      try { return CSV.parse(String(prop), fixed); } catch { return v; }
    };
    const backAll = (prop, list) => {
      if (!list || typeof list.length !== 'number') return list;
      let changed = false;
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const next = back(prop, list[i]);
        if (next !== list[i]) changed = true;
        out.push(next);
      }
      return changed ? out : list;
    };
    // 쓰기 쪽: 문자열이면 그대로 재작성하고, CSSStyleValue 면 문자열로 만들어
    // 재작성한 뒤 다시 파싱한다.
    const fwd = (prop, v) => {
      if (typeof v === 'string') return rewriteCSSText(v);
      if (!v || typeof v !== 'object' || !canParse) return v;
      let text;
      try { text = String(v); } catch { return v; }
      const rewritten = rewriteCSSText(text);
      if (rewritten === text) return v;
      try { return CSV.parse(String(prop), rewritten); } catch { return v; }
    };

    const nativeGet = RO.get;
    if (typeof nativeGet === 'function') {
      define(RO, 'get', function get(prop) { return back(prop, nativeGet.call(this, prop)); });
      hooked++;
    }
    const nativeGetAll = RO.getAll;
    if (typeof nativeGetAll === 'function') {
      define(RO, 'getAll', function getAll(prop) { return backAll(prop, nativeGetAll.call(this, prop)); });
      hooked++;
    }
    const nativeEntries = RO.entries;
    const nativeIter = RO[Symbol.iterator];
    if (typeof nativeEntries === 'function') {
      const entries = function entries() {
        const src = nativeEntries.call(this);
        const pairs = [];
        for (const pair of src) pairs.push([pair[0], backAll(pair[0], pair[1])]);
        return pairs[Symbol.iterator]();
      };
      define(RO, 'entries', entries);
      hooked++;
      // `values()` 는 키를 안 주므로 되돌릴 때 프로퍼티 이름을 알 수 없다.
      // 명세대로 entries 에서 값만 떼어 낸다.
      if (typeof RO.values === 'function') {
        define(RO, 'values', function values() {
          const out = [];
          for (const pair of entries.call(this)) out.push(pair[1]);
          return out[Symbol.iterator]();
        });
        hooked++;
      }
      // maplike 는 @@iterator 가 entries 와 **같은 함수**다. 네이티브가
      // 그랬다면 우리도 같은 함수를 줘야 동일성이 맞는다.
      if (nativeIter === nativeEntries) {
        try { Object.defineProperty(RO, Symbol.iterator, { value: RO.entries, writable: true, enumerable: false, configurable: true }); } catch {}
      }
    }
    const nativeForEach = RO.forEach;
    if (typeof nativeForEach === 'function') {
      define(RO, 'forEach', function forEach(cb, thisArg) {
        if (typeof cb !== 'function') return nativeForEach.call(this, cb, thisArg);
        const map = this;
        return nativeForEach.call(this, function (values, prop, self) {
          return cb.call(thisArg, backAll(prop, values), prop, self || map);
        });
      });
      hooked++;
    }

    if (SM) {
      for (const m of ['set', 'append']) {
        const native = SM[m];
        if (typeof native !== 'function') continue;
        define(SM, m, function (prop) {
          const args = [prop];
          for (let i = 1; i < arguments.length; i++) args.push(fwd(prop, arguments[i]));
          return native.apply(this, args);
        });
        hooked++;
      }
    }
    return hooked;
  }
  function installStyleHooks(w) {
    try { installStyleHooksInner(w); } catch (e) {
      styleHookState = 'threw:' + String(e && (e.message || e)).slice(0, 60);
    }
    // 조용한 no-op 금지. 오늘 이 파일에서만 훅이 안 걸린 걸 모른 채 세 번
    // 헛짚었다. 페이지에서 읽을 수 있는 전역은 남기지 않는다(지문이 된다) —
    // 진단 링에만 남긴다.
    if (styleHookState !== 'ok') {
      try { root.__zp_diagnostics && root.__zp_diagnostics.push({ t: 'style-hooks', s: styleHookState }); } catch {}
    }
  }
  function installStyleHooksInner(w) {
    // ★프로퍼티 이름 목록은 없다. 예전에는 url() 을 실을 수 있는 CSS 프로퍼티
    // 19개를 손으로 골라 CSSStyleDeclaration.prototype 에 훅하려 했는데,
    // 이 엔진은 CSS 프로퍼티를 **인스턴스의 own data property** 로 노출하므로
    // 그 루프는 조용한 no-op 였다(실측: prototype 의 own 이름은 10개뿐).
    // 실제로 잡아 주는 것은 아래 containStyleDeclaration 프록시이고, 그것은
    // 이름을 열거하지 않으므로 목록이 필요 없다.
    //
    // **함수 안에 두는 이유**: 모듈 스코프 `const` 로 두면 TDZ 에 걸린다.
    // 이 함수는 설치 시퀀스(installGetterMasking 부근)에서 불리는데 그 지점은
    // 선언보다 **위**라 `Cannot access 'X' before initialization` 이 나고,
    // 그 예외가 뒤따르는 멤브레인 설치를 통째로 중단시킨다. 실제로 자식
    // 프레임의 fetch/img 컨테인먼트가 깨졌다(매트릭스 e2/e3 회귀로 잡았다).
    // ★HTMLStyleElement.prototype 가 아니라 브라우저가 실제로 두는 조상에
    // 심는다 — 실측(2026-09-14, 프로토타입 모양 축): innerHTML 은
    // Element.prototype, innerText 는 HTMLElement.prototype, textContent 는
    // Node.prototype 에 own 이고 HTMLStyleElement.prototype 은 셋 다 없다.
    // 예전엔 셋 다 HTMLStyleElement.prototype 에 own 으로 새로 정의해서, 그
    // own 자체가 대조군엔 없는 모양 지문이었다(같은 날 겪은 own `style` 13→157
    // 회귀와 동일한 부류). 조상에 심으면 전 요소가 대상이 되므로 훅 안에서
    // `<style>` 인지 갈라 나머지는 그대로 흘려보낸다.
    // innerHTML 은 `patchHTMLSetter` 가 Element.prototype 에 이미 세정용 훅을
    // 두므로 거기서 같이 처리한다(여기서 또 훅하면 나중 설치가 이긴다).
    for (const [prop, proto] of [
      ['textContent', w.Node && w.Node.prototype],
      ['innerText', w.HTMLElement && w.HTMLElement.prototype],
    ]) {
      if (!proto) continue;
      const d = Native[prop === 'textContent' ? 'nodeTextContent' : 'htmlInnerText'];
      if (!d || !d.set) continue;
      try {
        defineMasked(proto, prop, {
          get() {
            if (this.localName !== 'style') return d.get ? d.get.call(this) : undefined;
            return d.get ? originalStyleText(this, d.get.call(this)) : '';
          },
          set(v) {
            if (this.localName !== 'style') { d.set.call(this, v); return; }
            originalTextMeta.set(this, String(v == null ? '' : v));
            d.set.call(this, rewriteCSSText(v));
          },
          configurable: false
        });
      } catch {}
    }
    const sheetProto = w.CSSStyleSheet && w.CSSStyleSheet.prototype;
    if (sheetProto) {
      for (const m of ['insertRule', 'replaceSync', 'replace']) {
        const native = sheetProto[m];
        if (typeof native !== 'function') continue;
        // insertRule 만 두 번째 인자(index)를 받는다 — 나머지는 무시된다.
        define(sheetProto, m, function (text, idx) { return native.call(this, rewriteCSSText(text), idx); });
      }
    }
    // `link.sheet.href` / `document.styleSheets[i].href` 는 StyleSheet
    // 인터페이스의 getter 다 — 요소 href 훅과 무관하게 **프록시 절대 URL** 을
    // 그대로 돌려준다. 가상 타깃으로 되돌린다.
    const styleSheetProto = w.StyleSheet && w.StyleSheet.prototype;
    const dSheetHref = styleSheetProto && propertyDescriptor(styleSheetProto, 'href');
    if (dSheetHref && dSheetHref.get) try {
      defineMasked(styleSheetProto, 'href', {
        get() { return deproxyURL(dSheetHref.get.call(this), { scan: true }); },
        enumerable: dSheetHref.enumerable,
        configurable: false
      });
    } catch {}
    // `el.style.backgroundImage = 'url(…)'` 는 프로토타입 훅으로 못 잡는다.
    // 이 엔진은 CSS 프로퍼티를 **인스턴스의 own data property** 로 노출한다
    // (실측: `getOwnPropertyDescriptor(document.body.style,'backgroundImage')`
    // → `own:true, set:없음`, prototype 에는 아예 없다). 그래서 350개를
    // 프로토타입에서 훅하려던 시도는 조용한 no-op 였다.
    //
    // 대신 `style` 게터가 **containment proxy** 를 돌려주게 한다 — 프로퍼티
    // 이름을 열거할 필요 없이 모든 쓰기가 set 트랩 하나를 지난다.
    // ★`style` 접근자는 HTMLElement 에만 있는 게 아니다. SVGElement /
    // MathMLElement / CSSStyleRule / CSSKeyframeRule / CSSPageRule 이 각자
    // 자기 프로토타입에 갖고 있고, 그중 하나라도 놓치면 그 경로의 쓰기가
    // 컨테인먼트를 통째로 우회한다. 실측(2026-09-10): SVG / MathML /
    // CSSStyleRule / CSSKeyframeRule 네 경로가 url() 을 원본 그대로 실었다.
    //
    // 인터페이스를 **훑어서** 찾는다 — 이름을 손으로 적으면 반드시 또 뚫린다
    // (이 저장소에서 다섯 번째다: srcset 후보 / HTML 엔티티 / data-zp-* /
    // window 메서드, 그리고 이것).
    // 하나도 못 걸었으면 컨테인먼트가 없는 것과 같다 — 조용한 no-op 금지.
    styleHookState = containEveryStyleAccessor(w) > 0 ? 'ok' : 'no-style-accessor';

    // getComputedStyle 은 **해결된** 값을 돌려주므로 프록시 URL 이 그대로
    // 보인다. 읽기 전용이라 되돌리기만 필요하고, 같은 프록시가 해 준다.
    if (typeof w.getComputedStyle === 'function') {
      const nativeGCS = w.getComputedStyle;
      try {
        define(w, 'getComputedStyle', function (el, pe) {
          return containStyleDeclaration(nativeGCS.call(w, el, pe));
        });
      } catch {}
    }
    // `sheet.cssRules[0].cssText` 는 선언을 안 거치고 규칙 텍스트를 통째로
    // 돌려준다 — 여기도 되돌리지 않으면 프록시 URL 이 그대로 보인다.
    const ruleProto = w.CSSRule && w.CSSRule.prototype;
    const dRuleText = ruleProto && propertyDescriptor(ruleProto, 'cssText');
    if (dRuleText && dRuleText.get) try {
      defineMasked(ruleProto, 'cssText', {
        get() { return deproxyURL(dRuleText.get.call(this), { scan: true }); },
        set: dRuleText.set ? function (v) { return dRuleText.set.call(this, rewriteCSSText(v)); } : undefined,
        enumerable: dRuleText.enumerable,
        configurable: false
      });
    } catch {}
    installTypedOM(w);
    const declProto = w.CSSStyleDeclaration && w.CSSStyleDeclaration.prototype;
    if (declProto) {
      const nativeSet = declProto.setProperty;
      if (typeof nativeSet === 'function') {
        define(declProto, 'setProperty', function (p, v, pr) { return nativeSet.call(this, p, rewriteCSSText(v), pr); });
      }
      // cssText 는 프로토타입 접근자라 여기서 잡는다. 나머지 프로퍼티는
      // 인스턴스 own 이라 프록시가 맡는다(위 주석).
      const dText = propertyDescriptor(declProto, 'cssText');
      if (dText && dText.set) try {
        defineMasked(declProto, 'cssText', {
          get() { return deproxyURL(dText.get ? dText.get.call(this) : '', { scan: true }); },
          set(v) { dText.set.call(this, rewriteCSSText(v)); },
          configurable: false
        });
      } catch {}
    }
  }
  function installScriptTextProps(w) {
    const scriptProto = w.HTMLScriptElement && w.HTMLScriptElement.prototype;
    if (!scriptProto) return;
    for (const prop of ['text', 'textContent', 'innerText']) {
      const d = propertyDescriptor(scriptProto, prop) || propertyDescriptor(w.Node && w.Node.prototype, prop);
      if (!d || !d.set) continue;
      try {
        defineMasked(scriptProto, prop, {
          get() { return d.get ? originalScriptText(this, d.get.call(this)) : ''; },
          set(v) { d.set.call(this, v); if (this.isConnected) prepareScriptElement(this); },
          configurable: false
        });
      } catch {}
    }
  }
  function installScriptProp(proto) {
    if (!proto) return;
    const d = propertyDescriptor(proto, 'src');
    if (!d || !d.get) return;
    try {
      defineMasked(proto, 'src', {
        get() {
          // ★이미 프록시 URL 로 들어온 src 는 `setScriptSource` 의 CONTROL_PREFIX
          // 분기를 타며 **스태시 없이** 통과한다(서버측 htmltx 가 고쳐 내려보낸
          // 정적 태그가 그렇다). 그러면 되돌릴 근거가 없어 프록시 URL 이 그대로
          // 보인다 — stackoverflow 에서 실측됐다(`/zp/api/script?u=…`).
          // 값 안에 타깃이 들어 있으므로 장부 없이도 푸는다.
          const masked = urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url');
          if (!masked) return deproxyURL(d.get.call(this), { scan: true });
          // 2026-08-12 — wtm/ncpt 예외를 **제거**했다. 그 예외는 `.src` 로 프록시
          // URL 을 그대로 흘렸고, 그게 NAVER SDK 를 오작동시키는 실제 원인이었다:
          //   webpack 의 publicPath 유도부가 `currentScript.src` 의 디렉터리를 쓴다
          //   → `http://proxy.localhost:18080/zp/api/`
          //   → wasm 을 `<target>/zp/api/<hash>.wasm` 에서 찾아 404
          //   → SDK 가 순수 JS 프로버(두 번째 wtm 스크립트)로 폴백하고
          //     `ncpt/errorLog` 를 쏟아낸다.
          // 실브라우저는 wasm 을 받고 그 두 번째 스크립트를 **요청조차 하지 않는다**.
          // 예외를 없애면 프록시도 같은 시그니처가 된다 — 직접/프록시를 한 런에
          // 찍는 페어 런 2/2 에서 두 번째 스크립트 0건, errorLog 0건, wasm 은
          // 올바른 CDN 경로(`wtm.pstatic.net/<build>/…wasm`)로 로드(2026-08-12).
          //
          // 이 예외를 정당화하던 2026-08-08 `__zpStep` 이분탐색은 함정노트에서 이미
          // 무효화됐다(훅을 빼면 SDK 가 더 일찍 실패해 트리거가 로드되지 않았다).
          // 마스킹 값을 돌려주는 건 원래의 strict 동작이라 E1 상 탈출면도 줄어든다.
          return masked;
        },
        set(v) { setScriptSource(this, v); },
        configurable: true
      });
    } catch {}
  }
  function installLinkProp(proto) {
    if (!proto) return;
    // href / rel 둘 다 `configurable: false` 로 심는다 — 같은 프로토타입에
    // 두 번 오면 매번 던지므로 한 번만 건다.
    if (propertyLocked(proto, 'href')) return;
    const hrefDescriptor = propertyDescriptor(proto, 'href');
    if (hrefDescriptor && hrefDescriptor.get) try {
      defineMasked(proto, 'href', {
        get() { return urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url') || hrefDescriptor.get.call(this); },
        set(v) {
          if (isBlockedLink(this) || hasSuppressedBlockedLinkRel(this)) return blockLinkURL(this, v);
          if (isIconLink(this)) return suppressIconLinkHref(this, v);
          const value = String(v);
          if (shouldBlockURLAttribute(this, 'href', value)) return blockExecutableURL(this, 'href', value);
          const t = targetURLForElement(this, value);
          if (t) {
            urlMeta.set(this, t);
            Native.setAttribute.call(this, 'data-zp-target-url', t);
            return hrefDescriptor.set ? hrefDescriptor.set.call(this, t) : Native.setAttribute.call(this, 'href', t);
          }
          return hrefDescriptor.set ? hrefDescriptor.set.call(this, value) : Native.setAttribute.call(this, 'href', value);
        },
        configurable: false
      });
    } catch {}
    const relDescriptor = propertyDescriptor(proto, 'rel');
    if (relDescriptor && relDescriptor.get) try {
      defineMasked(proto, 'rel', {
        get() { return relDescriptor.get.call(this); },
        set(v) {
          const value = String(v);
          if (isBlockedLinkRelValue(value)) return suppressBlockedLinkRel(this, value);
          if (Native.removeAttribute) Native.removeAttribute.call(this, 'data-zp-blocked-rel');
          const ret = relDescriptor.set ? relDescriptor.set.call(this, value) : Native.setAttribute.call(this, 'rel', value);
          enforceLinkPolicy(this);
          return ret;
        },
        configurable: false
      });
    } catch {}
  }
  function getScriptText(el) {
    if (Native.scriptText && Native.scriptText.get) return String(Native.scriptText.get.call(el) || '');
    if (Native.nodeTextContent && Native.nodeTextContent.get) return String(Native.nodeTextContent.get.call(el) || '');
    return String(el.textContent || '');
  }
  function setScriptText(el, value) {
    const text = String(value || '');
    if (Native.scriptText && Native.scriptText.set) { Native.scriptText.set.call(el, text); return; }
    if (Native.nodeTextContent && Native.nodeTextContent.set) { Native.nodeTextContent.set.call(el, text); return; }
    el.textContent = text;
  }
  function inlineScriptWrapper(source, kind) {
    const payload = JSON.stringify(String(source || '')).replace(/</g, '\\u003c');
    return kind === 'module' ? '__ZP_EXEC_INLINE_MODULE(' + payload + ');' : '__ZP_EXEC_INLINE_SCRIPT(' + payload + ');';
  }
  function isPreparedInlineScript(text) {
    // `__ZP_LOAD_EXTERNAL_SCRIPT` belongs in this set: transformHTML rewrites a
    // child-realm `<script src>` into that call, and `appendWrittenHTML` has to
    // re-create the element for it to execute at all. Without it the loader call
    // gets wrapped a second time as `__ZP_EXEC_INLINE_SCRIPT("__ZP_LOAD_...")`,
    // which routes our own helper name through the membrane and never loads the
    // script — the ad SDK's bridge extension silently goes missing
    // (`bridge.createSdkBridge is not a function`).
    return /^__ZP_(?:EXEC_INLINE_(?:SCRIPT|MODULE|REWRITTEN|REWRITTEN_MODULE)|LOAD_EXTERNAL_SCRIPT)\(/.test(String(text || '').trim());
  }
  function prepareScriptElement(el) {
    if (!el || el.localName !== 'script') return;
    const dataType = executableScriptDataType(el);
    if (dataType === 'importmap') {
      if (!Native.getAttribute.call(el, 'src')) setScriptText(el, rewriteImportMapText(getScriptText(el)));
      return;
    }
    if (dataType === 'speculationrules') {
      if (!Native.getAttribute.call(el, 'src')) setScriptText(el, rewriteSpeculationRulesText(getScriptText(el)));
      return;
    }
    const raw = Native.getAttribute.call(el, 'src') || Native.getAttribute.call(el, 'href');
    if (raw) {
      setScriptSource(el, raw);
      return;
    }
    if (dataType) {
      const text = getScriptText(el);
      if (!text) return;
      if (isPreparedInlineScript(text)) return;
      originalTextMeta.set(el, text);
      setScriptText(el, inlineScriptWrapper(text, dataType));
    }
  }
  function instrumentScriptElement(el) { prepareScriptElement(el); }
  // ── URL 표면 판정 ────────────────────────────────────────────────────────
  //
  // 2026-08-21 — 손으로 쓴 목록을 걷어냈다. 이 목록은
  // `crates/zp-shared/testdata/url_surfaces.json` 이 단일 소스이고, 빌드가
  // `__ZP_URL_SURFACES__` 자리에 박아 넣는다. Rust htmltx 도 같은 파일과
  // 대조하는 테스트를 갖는다.
  //
  // 왜 이렇게 했나: 이 목록이 여기와 htmltx 두 곳에 손으로 있던 동안
  // `background` / SVG `feImage` / `image-set` 이 한쪽에만 들어가 csp-only 로
  // 남아 있었다(구멍 매트릭스 g4·g5·g6). 목록이 두 벌이면 반드시 갈라진다.
  //
  // 네임스페이스 구분을 버린 것은 의도적이다. 예전 판정은 SVG 전용 태그
  // (image/use/feImage/script)를 `namespaceURI` 로 걸렀는데, 평평한 집합으로
  // 바꾸면 HTML 네임스페이스의 같은 이름도 URL 로 본다. 실제로는 무해하다 —
  // HTML 파서는 `<image>` 를 `img` 로 만들고, HTML `<script href>` /
  // `<use href>` 같은 속성은 존재하지 않는다. 반대로 네임스페이스를 보려면
  // 판정마다 그 필드를 읽어야 하는데 이 함수는 속성 쓰기마다 불린다.
  const URL_SURFACES = new Set(__ZP_URL_SURFACES__);
  function isURLBearing(el, key, _localKey, _tag) {
    const tag = _tag != null ? _tag : (el && el.localName);
    if (!tag) return false;
    const localKey = _localKey != null ? _localKey : attrLocalName(key);
    // ★SVG 는 `localName` 의 대소문자가 보존된다 — `<feImage>` 는 그대로
    // `feImage` 다. 픽스처 키는 소문자이므로 눕혀서 조회하지 않으면 SVG 전용
    // 태그가 통째로 빠진다. 실제로 이 한 줄이 없어서 g5-realm-feimage 가
    // csp-only 로 떨어졌다(2026-08-21, 매트릭스가 잡았다).
    return URL_SURFACES.has(String(tag).toLowerCase() + ':' + localKey);
  }
  // srcset 은 URL 하나가 아니라 `url 1x, url 320w` 후보 목록이라 일반 경로로
  // 넘기면 문자열 전체를 URL 로 보고 망가진다. 서버측 htmltx 에는 이미
  // proxied_srcset 이 있는데 페이지 realm 워커에는 없어서, innerHTML /
  // document.write 로 들어온 srcset 은 **원본 타깃 URL 이 그대로 남았다**
  // (구멍 매트릭스 e5-adframe-srcset 이 csp-only 로 잡아냈다).
  // (예전 주석은 "프록시 URL 에는 쉼표가 없으니 split(',') 이 안전하다" 고
  //  적혀 있었다. 전제가 틀렸다 — 쉼표는 **아직 리라이트 안 된** data: 후보에
  //  들어 있다. splitSrcsetCandidates 를 쓴다.)
  // ★srcset 후보를 `split(',')` 로 자르면 안 된다.
  //
  // `data:` URL 은 본문에 쉼표를 담는다 — `data:image/svg+xml;utf8,<svg …>`,
  // `;base64,`. 쉼표로 자르면 데이터 URL 이 반토막 나고, 뒷조각(`<svg`)이
  // **상대 URL 로 오인돼** 프록시 경로로 치환된다. 2026-08-21 실측:
  //   입력 : data:image/svg+xml;utf8,<svg …></svg> 1x, /img/real.png 2x
  //   결과 : data:image/svg+xml;utf8,http://…/zp/api/fetch?url=…%253Csvg xmlns=…
  // 이 스캐너가 그 셋(enforceSrcsetAttribute / upgradeSWLessSrcset /
  // applySWLessRelay)의 유일한 분해기다. srcset URL 에는 공백이 못 들어가므로
  // "공백까지 읽는다" 가 URL 을 취하는 올바른 방법이고, 쉼표는 URL **뒤에서만**
  // 구분자로 동작한다. Rust `split_srcset_candidates` 와 같은 알고리즘이고
  // `crates/zp-shared/testdata/srcset_cases.json` 이 둘의 파리티를 잡는다.
  //
  // 반환: [{lead, url, tail}]. lead+url+tail 을 이어 붙이면 입력이 바이트
  // 단위로 복원된다 — 그래야 디스크립터(`1x`/`320w`)를 한 글자도 안 건드리고
  // URL 만 갈아끼울 수 있다.
  function splitSrcsetCandidates(raw) {
    const s = String(raw == null ? '' : raw);
    const list = [];
    let i = 0;
    const isSep = c => c === ',' || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
    const isWS = c => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
    while (i < s.length) {
      const leadStart = i;
      while (i < s.length && isSep(s[i])) i++;
      const lead = s.slice(leadStart, i);
      if (i >= s.length) {
        // 끝의 구분자 런도 후보로 남겨야 왕복이 바이트 단위로 맞는다.
        if (lead) list.push({ lead, url: '', tail: '' });
        break;
      }
      // ★URL 은 **공백까지의 비공백 런**이다. 쉼표는 URL **뒤에 붙었을 때만**
      // 구분자다(HTML srcset 문법). 예전에는 첫 쉼표에서 끊고 `data:` 만
      // 예외로 뒀는데, 그러면 **쿼리에 쉼표가 든 평범한 URL 이 반토막 난다.**
      // CNN 실측(2026-08-24): 이미지가 `?c=16x9&q=h_1080,w_1920,c_fill` 를
      // 달고 있어 URL 이 `…h_1080` 에서 잘렸고, 남은 조각이 다음 후보로
      // 오인돼 두 URL 이 이어 붙은 요청이 나갔다 — 이미지 **56건이 400**.
      // 위 주석은 이미 올바른 규칙을 적어 뒀는데 코드가 그걸 구현하지 않았다.
      const urlStart = i;
      while (i < s.length && !isWS(s[i])) i++;
      let urlEnd = i;
      while (urlEnd > urlStart && s[urlEnd - 1] === ',') urlEnd--;
      const url = s.slice(urlStart, urlEnd);
      i = urlEnd;
      const descStart = i;
      while (i < s.length && s[i] !== ',') i++;
      list.push({ lead, url, tail: s.slice(descStart, i) });
    }
    return list;
  }
  // 후보마다 URL 만 바꿔 다시 조립한다. `map` 이 원래 문자열을 그대로 돌려주면
  // 그 후보는 손대지 않은 것이다.
  function mapSrcsetCandidates(raw, fn) {
    let changed = false;
    const out = splitSrcsetCandidates(raw).map(c => {
      if (!c.url) return c.lead + c.tail;
      const next = fn(c.url);
      if (next != null && next !== c.url) { changed = true; return c.lead + next + c.tail; }
      return c.lead + c.url + c.tail;
    }).join('');
    return changed ? out : null;
  }
  function rememberSrcset(el, key, raw) {
    let m = srcsetMeta.get(el);
    if (!m) { m = new Map(); srcsetMeta.set(el, m); }
    m.set(String(key).toLowerCase(), String(raw));
  }
  function recalledSrcset(el, key) {
    const m = srcsetMeta.get(el);
    return m ? m.get(String(key).toLowerCase()) : undefined;
  }
  function enforceSrcsetAttribute(el, key, raw) {
    rememberSrcset(el, key, raw);
    // 후보 URL 은 요소 캐시(targetURLForElement)를 쓰지 않는다 — 그 캐시는
    // 요소당 마지막 raw 하나만 기억해서 후보가 여럿이면 서로를 밀어낸다.
    const out = mapSrcsetCandidates(raw, url => {
      if (url.indexOf(ZP.apiPath('fetch')) >= 0 || url.indexOf(ZP.apiPath('v2/fetch')) >= 0) return null;
      const t = targetURLIfHTTP(url);
      return t ? subresourceProxyPath(t) : null;
    });
    if (out == null) return;
    Native.setAttribute.call(el, key, out);
    // SW 를 못 거치는 프레임이면 후보마다 blob 으로 올려야 한다.
    upgradeSWLessURL(el, key, out);
  }
  function executableScriptDataType(el) {
    const kind = executableScriptKindForElement(el);
    if (kind) return kind;
    const t = String(Native.getAttribute.call(el, 'type') || '').trim().toLowerCase();
    return t === 'importmap' ? 'importmap' : t === 'speculationrules' ? 'speculationrules' : '';
  }
  function blockInlineScriptElement(el) {
    Native.setAttribute.call(el, 'type', 'application/x-zeroproxy-blocked');
    Native.setAttribute.call(el, 'data-zp-blocked-script', '1');
    setScriptText(el, '');
  }
  function rewriteImportMapText(source) {
    let map;
    try { map = JSON.parse(String(source || '{}')); } catch { return '{}'; }
    if (!map || typeof map !== 'object' || Array.isArray(map)) return '{}';
    const rewriteAddress = value => {
      if (typeof value !== 'string') return value;
      try {
        const u = new URL(value, baseURL);
        if (u.protocol === 'http:' || u.protocol === 'https:') return scriptProxyPath(u.href, 'module');
        return ZP.errorPath('POLICY_BLOCKED');
      } catch {
        return ZP.errorPath('POLICY_BLOCKED');
      }
    };
    if (map.imports && typeof map.imports === 'object' && !Array.isArray(map.imports)) {
      for (const key of Object.keys(map.imports)) map.imports[key] = rewriteAddress(map.imports[key]);
    }
    if (map.scopes && typeof map.scopes === 'object' && !Array.isArray(map.scopes)) {
      const nextScopes = {};
      for (const scope of Object.keys(map.scopes)) {
        let scopeKey = scope;
        try {
          const u = new URL(scope, baseURL);
          if (u.protocol === 'http:' || u.protocol === 'https:') scopeKey = scriptProxyPath(u.href, 'module');
        } catch {}
        const entries = map.scopes[scope];
        if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
          const out = {};
          for (const key of Object.keys(entries)) out[key] = rewriteAddress(entries[key]);
          nextScopes[scopeKey] = out;
        }
      }
      map.scopes = nextScopes;
    }
    return JSON.stringify(map).replace(/[<>&]/g, c => c === '<' ? '\\u003c' : c === '>' ? '\\u003e' : '\\u0026');
  }
  // `<script type="speculationrules">` — same shape as the Rust-side
  // rewrite (zp-htmltx::rewrite_speculationrules_json): `prefetch` urls
  // are subresource GETs → /zp/api/fetch, `prerender` urls are top
  // navigations → the ?via= launcher. Without it the browser prefetches /
  // prerenders straight from the target host.
  function rewriteSpeculationRulesText(source) {
    let doc;
    try { doc = JSON.parse(String(source || '{}')); } catch { return '{}'; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return '{}';
    const abs = v => {
      try {
        const u = new URL(v, baseURL);
        return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
      } catch { return null; }
    };
    for (const pair of [['prefetch', false], ['prerender', true]]) {
      const rules = doc[pair[0]];
      if (!Array.isArray(rules)) continue;
      for (const rule of rules) {
        if (!rule || !Array.isArray(rule.urls)) continue;
        rule.urls = rule.urls.map(v => {
          const a = abs(v);
          if (!a) return v;
          return pair[1] ? proxyViaURL(a) : subresourceProxyPath(a);
        });
      }
    }
    return JSON.stringify(doc).replace(/[<>&]/g, c => c === '<' ? '\\u003c' : c === '>' ? '\\u003e' : '\\u0026');
  }
  // `document.write` on a CLOSED document triggers an implicit
  // `document.open()` that wipes everything already there. That is correct
  // browser behaviour and we keep it — except for one case we created
  // ourselves: the child-realm ordered script pipeline can run an inline script
  // one microtask after the parser finished, and a creative writing into what it
  // believes is still-parsing markup would then erase the ad it just built.
  // Append the markup instead of wiping, and re-create every script element so
  // it actually executes (parser- and appendChild-inserted scripts run,
  // innerHTML/template-cloned ones never do).
  function documentIsClosed(doc) {
    try { return !!doc && doc.readyState !== 'loading'; } catch { return false; }
  }
  function appendWrittenHTML(doc, html) {
    const target = doc.body || doc.documentElement;
    if (!target) return;
    const template = doc.createElement('template');
    if (Native.elementInnerHTML && Native.elementInnerHTML.set) Native.elementInnerHTML.set.call(template, html);
    else template.innerHTML = html;
    const frag = template.content || template;
    const scripts = frag.querySelectorAll ? Array.prototype.slice.call(frag.querySelectorAll('script')) : [];
    target.appendChild(frag);
    for (const stale of scripts) {
      // Ordering across these is preserved by the pipeline itself: each body is
      // a `__ZP_EXEC_INLINE_SCRIPT` / `__ZP_LOAD_EXTERNAL_SCRIPT` call, and we
      // are inside a queued item, so every enqueue lands behind us in order.
      const fresh = doc.createElement('script');
      if (Native.getAttributeNames) {
        for (const name of Native.getAttributeNames.call(stale)) {
          try { Native.setAttribute.call(fresh, name, Native.getAttribute.call(stale, name) || ''); } catch {}
        }
      }
      setScriptText(fresh, getScriptText(stale));
      try { stale.replaceWith(fresh); } catch {}
    }
  }
  // `<meta http-equiv=refresh>` 의 content 에서 URL 부분만 프록시 내비게이션
  // 경로로 옮긴다. 같은 규칙이 세 곳에 있다 — Rust htmltx(문서 파싱 시점),
  // SW(`Refresh` 응답 헤더), 그리고 여기(페이지 realm 이 만드는 HTML).
  // **이 셋은 서로 다른 구현이고 실제로 갈라졌었다**: htmltx 에 넣었는데
  // `transformHTML` 은 JS 로 따로 걸어서 srcdoc 프레임의 meta refresh 가
  // 원본 URL 로 남아 있었다(2026-08-20, 프레임 축 매트릭스에서 csp-only 로 검출 —
  // `frame-src 'self'` 가 막고 있었을 뿐이다).
  function proxiedRefreshContent(content) {
    const s = String(content || '');
    if (!s) return '';
    const at = s.toLowerCase().indexOf('url=');
    if (at < 0) return ''; // delay-only — 자기 자신 재로드
    const head = s.slice(0, at);
    let v = s.slice(at + 4).trim();
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    v = v.trim();
    if (!v || /^javascript:/i.test(v)) return '';
    const abs = targetURLIfHTTP(v);
    if (!abs) return '';
    return head + 'url=' + proxyViaURL(abs);
  }
  // Post-write meta enforcement for paths that bypass the setAttribute hook:
  // MutationObserver records, Attr.value assignment, innerHTML insertions.
  // CSP equiv is neutralized; refresh rewrites `content` so the refresh timer
  // re-arms on the proxied URL instead of the raw target.
  function enforceMetaPolicy(el) {
    const eq = String(Native.getAttribute.call(el, 'http-equiv') || '').trim().toLowerCase();
    // http-equiv 가 먼저 지워진(무력화된) meta 에 content 가 나중에 오면
    // stash 마커로 원래 equiv 를 알아내 다시 건다 — 네이티브도 meta 는
    // attr 쌍이 갖춰진 시점에 적용된다.
    const blockedEq = String(Native.getAttribute.call(el, 'data-zp-blocked-http-equiv') || '').trim().toLowerCase();
    if (isCSPHttpEquiv(eq) || (!eq && isCSPHttpEquiv(blockedEq))) { neutralizeCSPMeta(el, eq || blockedEq); return; }
    if (eq !== 'refresh') return;
    const cur = Native.getAttribute.call(el, 'content');
    if (cur == null) return;
    const next = proxiedRefreshContent(cur);
    if (next && next !== cur) Native.setAttribute.call(el, 'content', next);
  }
  function transformHTML(value, opts) {
    const html = String(value);
    if (!html) return html;
    const inIframe = !!(opts && opts.inIframe);
    const swLessTarget = !!(opts && opts.swLess);
    const parserDoc = Native.createHTMLDocument ? Native.createHTMLDocument('') : document.implementation.createHTMLDocument('');
    const container = parserDoc.createElement('template');
    if (Native.elementInnerHTML && Native.elementInnerHTML.set) Native.elementInnerHTML.set.call(container, html);
    else container.innerHTML = html;
    const root = container.content || container;
    const walker = parserDoc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    for (const node of nodes) {
      const tag = node.localName;
      if (tag === 'meta') {
        const eq = String(Native.getAttribute.call(node, 'http-equiv') || '').trim().toLowerCase();
        if (isCSPHttpEquiv(eq)) { neutralizeCSPMeta(node, eq); continue; }
        if (eq === 'refresh') {
          const next = proxiedRefreshContent(Native.getAttribute.call(node, 'content') || '');
          if (next) Native.setAttribute.call(node, 'content', next);
        }
      }
      if (tag === 'base' && Native.getAttribute.call(node, 'href')) {
        const href = Native.getAttribute.call(node, 'href') || '';
        updateVirtualBase(href);
        const script = parserDoc.createElement('script');
        setScriptText(script, 'window.__ZP_SET_BASE&&window.__ZP_SET_BASE(' + JSON.stringify(href).replace(/</g, '\\\\u003c') + ');');
        node.replaceWith(script);
        continue;
      }
      if (tag === 'link') enforceLinkPolicy(node);
      // CSS 도 URL 을 실어 나른다. 서버측 htmltx 는 `style` 속성과 `<style>`
      // 본문을 모두 zp_css 로 통과시키는데 페이지 realm 의 이 walker 에는
      // 그게 없었다 — naver.com 실측에서 innerHTML 로 들어온 DIV 의
      // `style="background-image:url(https://s.pstatic.net/…)"` 가 원본
      // URL 로 남아 `img-src 'self'` 에 걸렸다. (오늘 네 번째 서버/런타임
      // 비대칭.)
      if (Native.hasAttribute.call(node, 'style')) {
        const raw = Native.getAttribute.call(node, 'style') || '';
        const mapped = rewriteCSSText(raw);
        if (mapped !== raw) Native.setAttribute.call(node, 'style', mapped);
      }
      if (tag === 'style') {
        const raw = Native.nodeTextContent && Native.nodeTextContent.get
          ? Native.nodeTextContent.get.call(node) : node.textContent;
        const mapped = rewriteCSSText(raw || '');
        if (mapped !== raw && Native.nodeTextContent && Native.nodeTextContent.set) {
          Native.nodeTextContent.set.call(node, mapped);
        }
      }
      // 2026-06-06 follow-up: navigation URL attribute rewrite. The
      // server-side zp-htmltx pass handles the initial document, but
      // every page-side HTML ingestion (innerHTML/outerHTML/
      // insertAdjacentHTML/document.write/Range.createContextualFragment/
      // DOMParser.parseFromString) routes through this walker — without
      // this branch, NAVER's autocomplete widget (atcmp_*) and similar
      // SDK-injected fragments leave raw target hrefs on the DOM,
      // surfacing them to hover / middle-click / copy-link.
      applyNavigationBackstop(node);
      // 서버측 htmltx 가 파싱 시점 `srcdoc` 을 `data-zp-srcdoc` 으로 옮겨 둔다
      // (멤브레인 없는 문서가 파서에서 바로 생기는 것을 막기 위해서다).
      // 여기서 되돌리면 아래 injectSrcdoc 분기가 프렐류드 주입 + URL 리라이트를
      // 해 준다.
      // 순서 주의: **먼저 만들고, 성공했을 때만 옮긴다.** 지우고 나서 만들면
      // injectSrcdoc 이 던졌을 때 원본까지 사라져 iframe 이 통째로 빈다
      // (한 번 밟았다). 실패하면 data-zp-srcdoc 을 그대로 둔다 — 내용은
      // 파싱되지 않으므로 fail-closed 다.
      if ((tag === 'iframe' || tag === 'frame') && Native.hasAttribute.call(node, 'data-zp-srcdoc')) {
        const pending = Native.getAttribute.call(node, 'data-zp-srcdoc') || '';
        if (setInjectedSrcdoc(node, pending)) {
          try { Native.removeAttribute.call(node, 'data-zp-srcdoc'); } catch {}
        }
      }
      if ((tag === 'iframe' || tag === 'frame') && Native.hasAttribute.call(node, 'srcdoc') && !srcdocMeta.has(node)) {
        setInjectedSrcdoc(node, Native.getAttribute.call(node, 'srcdoc') || '');
      }
      if (tag === 'script') {
        const dtype = executableScriptDataType(node);
        if (dtype === 'importmap') setScriptText(node, rewriteImportMapText(getScriptText(node)));
        else if (dtype) {
          // 외부 script (src 있음) 는 `setScriptSource` 가 scriptProxyPath 로
          // 라우팅 → SW intercept + OXC rewrite. 인라인 script 는
          // `__ZP_EXEC_INLINE_SCRIPT(JSON)` 으로 wrap → 페이지 prelude 가 동기
          // rewrite 후 실행. 양쪽 모두 멤브레인 의미 유지 + execution 가능.
          // (이전엔 blockInlineScriptElement 가 외부도 무조건 type=blocked 로
          // 차단 → NAVER GFP SafeFrame template 의 gfp-display-safeframe.js /
          // adm 안 ad bridge 가 절대 실행 안 됨 → 광고 미렌더.)
          //
          // iframe context: `document.write` 가 about:blank iframe document 를
          // reset 한 뒤 자식 client 가 SW 통제권 잃음. `<script src=ext>` 는 SW
          // 우회 직행 → Go 서버 403 → SafeFrame loader 미실행. 외부 script 를
          // `__ZP_LOAD_EXTERNAL_SCRIPT(url, kind)` 인라인 호출로 대체하여 부모
          // realm 의 native fetch (SW-controlled) 로 가져와 iframe realm 에서
          // 실행. 인라인 script 의 `__ZP_EXEC_INLINE_SCRIPT` wrap 은 그대로 유지
          // — installNetworkContainment 가 iframe 의 realm 보존 변형으로 install.
          const rawSrc = Native.getAttribute.call(node, 'src') || Native.getAttribute.call(node, 'href');
          if (inIframe && rawSrc) {
            const target = targetURLForElement(node, rawSrc);
            if (target) {
              if (Native.removeAttribute) {
                try { Native.removeAttribute.call(node, 'src'); } catch {}
                try { Native.removeAttribute.call(node, 'href'); } catch {}
              }
              const loaderCode = '__ZP_LOAD_EXTERNAL_SCRIPT(' + JSON.stringify(target).replace(/</g, '\\u003c') + ',' + JSON.stringify(dtype) + ');';
              setScriptText(node, loaderCode);
              continue;
            }
          }
          prepareScriptElement(node);
        }
      }
      if (Native.getAttributeNames) {
        for (const attrName of Native.getAttributeNames.call(node)) {
          const lowerAttr = String(attrName).toLowerCase();
          if (lowerAttr === 'integrity' && isIntegrityBearing(node)) setBackedIntegrity(node, Native.getAttribute.call(node, attrName) || '');
          if (lowerAttr.startsWith('on') && lowerAttr.length > 2) {
            const val = Native.getAttribute.call(node, attrName) || '';
            Native.setAttribute.call(node, 'data-zp-blocked-' + lowerAttr, val);
            Native.setAttribute.call(node, attrName, rewriteEventAttribute(val));
          }
          if (isURLBearing(node, lowerAttr)) enforceObservedAttribute(node, lowerAttr);
        }
      }
      // ★목적지 문서가 SW 클라이언트가 아니면 여기서 릴레이 경로로 옮긴다.
      // **파싱 전인 지금이 유일한 기회**다 — 이 HTML 이 문서에 들어가는 순간
      // 브라우저는 속성에 적힌 주소로 요청을 쏘고, 부모의 백스톱 스윕은 그
      // 뒤에야 요소를 만난다. 요소 훅 자리에서 고치려던 시도가 전부 실패한
      // 이유가 이것이다(파킹은 격리까지 퇴행시켰다).
      if (swLessTarget) applySWLessRelay(node);
    }
    return Native.elementInnerHTML && Native.elementInnerHTML.get ? Native.elementInnerHTML.get.call(container) : container.innerHTML;
  }
  // 리라이트가 끝난 노드의 URL 속성을 릴레이 경로로 옮긴다. 이미
  // `/zp/api/fetch?url=…` 형태가 된 값만 대상이라, 리라이트를 놓친 값이
  // 여기서 새로 통과하는 일은 없다 — 감옥 판정은 앞 단계 그대로다.
  function applySWLessRelay(node) {
    if (!Native.getAttributeNames) return;
    const tag = node.localName;
    for (const attrName of Native.getAttributeNames.call(node)) {
      const lowerAttr = String(attrName).toLowerCase();
      const colon = lowerAttr.indexOf(':');
      const localKey = colon < 0 ? lowerAttr : lowerAttr.slice(colon + 1);
      if (!isURLBearing(node, lowerAttr) || !swLessRelayable(tag, localKey)) continue;
      const raw = Native.getAttribute.call(node, attrName);
      if (!raw) continue;
      if (localKey === 'srcset' || localKey === 'imagesrcset') {
        // 후보 목록은 후보마다 옮긴다. 디스크립터(`1x`/`320w`)는 그대로 둬야
        // 브라우저의 후보 선택이 원본과 같다.
        const out = mapSrcsetCandidates(raw, url => relayFromProxyPath(url, ''));
        if (out != null) Native.setAttribute.call(node, attrName, out);
        continue;
      }
      const relay = relayFromProxyPath(raw, relayKindForElement(node, tag, localKey));
      if (relay) Native.setAttribute.call(node, attrName, relay);
    }
  }
  // srcdoc 문서에도 **버전이 붙은** URL 을 쓴다. 예전엔 세 개를 전부 맨 경로로
  // 박아서 (a) 로드마다 재검증 왕복이 남고, (b) 더 나쁘게는 부모가 immutable
  // 사본을 쓰는 동안 이 프레임만 `no-cache` 사본을 받아 **다른 빌드의 프렐류드**를
  // 실행할 여지가 있었다. `assetURL()` 이 emit 전용(쿼리 포함)이고
  // `assetPath()` 는 경로 비교 전용이다 — 섞으면 internalPath 가 불일치한다.
  function injectSrcdoc(s) { return '<script src="' + ZP.assetURL('zp-core.js') + '"><\/script><script src="' + ZP.assetURL('zp-page-bundle.js') + '"><\/script><script id="__zp-boot" type="application/json">' + bootJSON() + '<\/script><script src="' + ZP.assetURL('runtime-prelude.js') + '"><\/script>' + transformHTML(String(s)); }
  // `proxyOrigin` 을 실어 보내는 이유는 resolveProxyOrigin 주석에 있다 —
  // 자식이 `about:srcdoc` 이면 자기 힘으로는 오리진을 알 수 없다.
  function bootJSON() { return JSON.stringify(Object.assign({}, boot, { servers: activeServers, proxyOrigin })).replace(/[<>&]/g, c => c === '<' ? '\\u003c' : c === '>' ? '\\u003e' : '\\u0026'); }
  function rewriteEventAttribute(source) { return 'return __ZP_EXEC_EVENT(this,event,' + JSON.stringify(String(source || '')).replace(/</g, '\\u003c') + ')'; }
  function syncBaseElement(node) {
    if (!node) return;
    if (node.localName === 'base' && Native.getAttribute.call(node, 'href')) updateVirtualBase(Native.getAttribute.call(node, 'href'));
    if (node.querySelectorAll) node.querySelectorAll('base[href]').forEach(el => updateVirtualBase(Native.getAttribute.call(el, 'href')));
  }