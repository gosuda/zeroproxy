(() => {
  'use strict';
  const root = window;
  const nativeOwnKeys = Reflect.ownKeys;
  // Description-less Symbol so getOwnPropertySymbols(window) leaks no
  // "zeroproxy.*" tells. `Symbol.for` re-keys cross-realm, but each
  // realm gets its own prelude run anyway, so dropping the registry
  // is free. `marker.description === undefined` after this swap.
  const marker = Symbol();
  if (root[marker]) return;
  Object.defineProperty(root, marker, { value: true, enumerable: false, configurable: false });

  // Fingerprint hardening: capture the ZeroProxy runtime helpers into
  // closure-local bindings, then DELETE the named globals so a target
  // script's `Object.getOwnPropertyNames(window)` enumeration can't see
  // them. The named properties are the obvious tells — `window.ZP`,
  // `window.ZeroProxyRT` — that anti-bot probes (e.g. NAVER's warm-
  // session V8 wedge) check before deciding whether to enter their
  // probe-defense tight loop. The install-already-ran marker above is
  // a Symbol() (no description, not registered with Symbol.for) so
  // getOwnPropertySymbols(window) returns [Symbol()] — opaque noise
  // without a "zeroproxy.*" prefix anti-bot probes could match on.
  const ZP = globalThis.ZP;
  const ZeroProxyRTGlobal = globalThis.ZeroProxyRT;
  try { delete globalThis.ZP; } catch {}
  try { delete globalThis.ZeroProxyRT; } catch {}

  // Fingerprint hardening (2026-08-02). The rewriter emits BARE calls to
  // `__zp_get` / `__zp_call` / `__ZP_EXEC_INLINE_SCRIPT` …, so unlike `ZP`
  // above these must stay resolvable as globals — capture-and-delete is not an
  // option. They were therefore still fully visible to
  // `Object.getOwnPropertyNames(window)`: 25 names, measured 2026-08-02, on top
  // of a 1298-name baseline. That is precisely the enumeration the 2026-06-05
  // note identified as NAVER's anti-bot tell, and the WTM bundle
  // (wtm.pstatic.net/fce46da/*.js) still busy-loops the renderer when it is
  // allowed to run — see the ZP_TRACKER_BLOCKED block in web/sw.js.
  //
  // Since the bindings cannot go away, hide them from the enumeration surfaces
  // instead. `enumerable: false` does NOT help here: getOwnPropertyNames and
  // Reflect.ownKeys report non-enumerable own properties by spec.
  const ZP_HIDDEN_RE = /^(?:__zp_|__ZP_|ZPBundle$|ZPPageBundleWBG$|ZeroProxyRT$|ZP$)/;
  // ...but `for (k in window)` is a THIRD enumeration surface, and it is the one
  // the scrubbing above cannot reach: for-in is a language construct, not a
  // method we can wrap. It walks enumerable own+inherited keys directly.
  // 측정 당시: `for (k in window)` 가 ZPPageBundleWBG / __zp_diagnostics /
  // __zp_trace / __zp_trace_clear 를 그대로 내놨다 — 맨 `root.x = y` 대입은
  // ENUMERABLE 속성을 만들어 `define()` 도 스크럽도 안 탔기 때문이다.
  // enumerable:false 는 이 표면에만 맞는 도구이고(다른 둘에는 무용지물),
  // 그래서 두 장치는 대안이 아니라 보완이다.
  //
  // ★2026-08-22 정정 — 여기 원래 "getOwnPropertyNames(window) was correctly
  // clean" 이라고 적혀 있었다. **그 측정이 틀린 자리에서 이뤄졌다.** 리라이트를
  // 안 거친 프로브(devtools/exec-js)로 재면 깨끗한데, 리라이트된 타깃 코드가
  // 받는 것은 **가상 window(스코프 프록시)** 라 `isGlobalObj` 에 안 걸려
  // 스크럽이 통째로 비껴갔다. 실측: 같은 코드가 `eval()` 안에서 24개를 봤다.
  // 아래 isGlobalObj 의 오리 검사(`o.window === o`)가 그 구멍을 막는다.
  //
  // 그러니 이 근처의 "clean" 이라는 문장을 다시 쓰게 되거든, **어느 시점에서
  // 잰 clean 인지**를 같이 적을 것. 틀린 안심은 없는 방어보다 비싸다.
  const hideZPGlobalsFromForIn = () => {
    try {
      for (const name of Object.getOwnPropertyNames(root)) {
        if (!ZP_HIDDEN_RE.test(name)) continue;
        const d = Object.getOwnPropertyDescriptor(root, name);
        if (!d || !d.enumerable || !d.configurable) continue;
        try { Object.defineProperty(root, name, Object.assign({}, d, { enumerable: false })); } catch {}
      }
    } catch {}
  };
  // zp-core.js and zp-page-bundle.js both load BEFORE this prelude, so their
  // globals already exist and this first pass catches them.
  hideZPGlobalsFromForIn();
  try {
    // ★"전역 객체" 판정에 **가상 window 도** 포함해야 한다.
    //
    // 예전에는 `globalThis`/`root`/`self` 만 봤다. 그런데 리라이트된 타깃 코드가
    // 받는 `window` 는 **그 셋 중 무엇도 아니다** — 멤브레인이 주는 스코프
    // 프록시다. 그래서 스크러빙이 안 걸렸고, 실측(2026-08-22):
    //
    //   exec-js 로 그냥 실행 : getOwnPropertyNames(window) 에 __zp_* 0개
    //   eval 로 리라이트 경유 : 같은 코드가 **24개**
    //
    // 즉 방어는 **적이 서지 않는 자리**에 있었다. 원래 이 스크러버를 넣을 때
    // "measured clean" 이라고 적었는데, 그 측정이 리라이트를 안 거친 프로브였다.
    // 타깃 코드는 예외 없이 리라이트를 거치므로 사실상 아무도 못 막고 있었다.
    //
    // 스코프 프록시는 이 블록보다 **나중에** 만들어지므로 이름으로 참조할 수 없다.
    // 멤브레인 자신이 쓰는 오리 검사(`o.window === o`)를 쓴다 — 진짜 window 와
    // 가상 window 둘 다 이 성질을 만족하고, 다른 객체는 거의 만족하지 않는다.
    const isGlobalObj = o => {
      try {
        if (o === globalThis || o === root) return true;
        if (typeof self !== 'undefined' && o === self) return true;
        return !!o && typeof o === 'object' && o.window === o;
      } catch { return false; }
    };
    // Real Chrome exposes exactly `["constructor"]` on Location.prototype — every
    // Location member is an own, non-configurable property of the `location`
    // INSTANCE. Our virtual accessors therefore never fire (the own properties
    // shadow them; verified 2026-08-02: un-rewritten `location.href` still reads
    // the raw proxy URL) — they are pure fingerprint: 14 names vs 1. Rather than
    // delete membrane code late, hide them from enumeration; behaviour is
    // untouched because nothing ever reached them.
    const LOC_PROTO_OK = new Set(['constructor']);
    const isLocProto = o => { try { return typeof Location === 'function' && o === Location.prototype; } catch { return false; } };
    const scrub = (list, target) => list.filter(n => {
      if (typeof n !== 'string') return true;
      if (isLocProto(target)) return LOC_PROTO_OK.has(n);
      return !ZP_HIDDEN_RE.test(n);
    });
    const hideFrom = (owner, name) => {
      const orig = owner && owner[name];
      if (typeof orig !== 'function') return;
      const patched = function (target) {
        const out = orig.apply(this, arguments);
        if (!Array.isArray(out)) return out;
        return (isGlobalObj(target) || isLocProto(target)) ? scrub(out, target) : out;
      };
      // Keep `fn.toString()` / `fn.name` / `fn.length` indistinguishable from
      // native — a probe that diffs those would otherwise see the wrapper.
      try {
        Object.defineProperty(patched, 'name', { value: name, configurable: true });
        Object.defineProperty(patched, 'length', { value: orig.length, configurable: true });
      } catch {}
      nativeToStringSources.set(patched, orig);
      try { Object.defineProperty(owner, name, { value: patched, writable: true, configurable: true }); } catch {}
    };
    const nativeToStringSources = new WeakMap();
    const origToString = Function.prototype.toString;
    try {
      Object.defineProperty(Function.prototype, 'toString', {
        value: function () {
          const src = nativeToStringSources.get(this);
          return origToString.call(src || this);
        },
        writable: true, configurable: true
      });
    } catch {}
    hideFrom(Object, 'getOwnPropertyNames');
    hideFrom(Object, 'keys');
    hideFrom(Reflect, 'ownKeys');
    // A real `window` carries no own symbols (measured 2026-08-02: direct load
    // 0, proxied 4 — our install marker plus wasm-bindgen's). The count alone
    // is a one-line proxy check, so drop ours from the symbol surface too.
    // Only symbols we could have created are removed: no description at all
    // (the `Symbol()` install marker) or an explicitly ZeroProxy-ish one.
    const ours = s => { const d = s && s.description; return d === undefined || ZP_HIDDEN_RE.test(String(d)); };
    const origSyms = Object.getOwnPropertySymbols;
    const patchedSyms = function (target) {
      const out = origSyms.apply(this, arguments);
      return isGlobalObj(target) ? out.filter(s => !ours(s)) : out;
    };
    try {
      Object.defineProperty(patchedSyms, 'name', { value: 'getOwnPropertySymbols', configurable: true });
      Object.defineProperty(patchedSyms, 'length', { value: origSyms.length, configurable: true });
    } catch {}
    nativeToStringSources.set(patchedSyms, origSyms);
    try { Object.defineProperty(Object, 'getOwnPropertySymbols', { value: patchedSyms, writable: true, configurable: true }); } catch {}
  } catch {}

  const boot = Object.assign({ tabId: '', entryId: '', targetUrl: location.href, documentCookie: '' }, readBootConfig());
  const runtimeToken = String(boot.runtimeToken || '');
  // Single source of truth lives in zp-core (web/zp-core.js); the SW smuggles
  // the same UA via X-ZP-User-Agent so navigator.userAgent and outgoing HTTP
  // headers stay consistent and target servers can't fingerprint the mismatch.
  const TARGET_USER_AGENT = ZP.TARGET_USER_AGENT;
  const TARGET_APP_VERSION = TARGET_USER_AGENT.replace(/^Mozilla\//, '');
  const TARGET_PLATFORM = 'Win32';
  // ★여기 있어야 한다 — `targetBrandList()` 아래가 아니라(2026-08-24).
  //
  // `defineOnProto` 는 설치 직후 **그 게터를 읽어** 프로토타입 설치가 먹었는지
  // 확인한다(`instance[key] === get.call(instance)`). 그래서
  // `installNavigatorIdentity` 가 `userAgentData` 를 설치하는 순간
  // `virtualUserAgentData` → `targetBrandList()` 가 즉시 불린다. 이 선언이
  // 함수 옆(모듈 본문 뒤쪽)에 있으면 그 시점엔 아직 초기화 전이라 **TDZ**
  // (`ReferenceError: Cannot access ... before initialization`)가 난다.
  //
  // `try/catch` 가 그 예외를 삼켜서 조용히 폴백으로 빠졌고, 그 결과
  // `userAgentData` 만 **navigator 인스턴스에도** 정의됐다. 실측(대조군 대비):
  //   Object.getOwnPropertyNames(navigator).includes('userAgentData')
  //     직접 로드 false / 프록시 true   ← 한 줄짜리 탐지기
  // 같은 블록의 userAgent·appVersion·platform·languages 는 전부 정상이었다.
  // 던지는 게터 하나가 그 속성만 다른 경로로 보낸 것이다.
  let cachedUADataBrands = null;
  clearBootConfig();
  const Native = captureNative(root);
  // prelude 내부의 `new URL(...)` 은 항상 네이티브여야 한다 — 페이지-facing
  // `root.URL` 은 ZPURL 래퍼(installStorageFacades)로 교체되는데, 그 래퍼는
  // `/zp/p/<share>` 같은 우리 라우팅 어휘를 타깃으로 풀어 돌려준다. 그대로
  // 타면 `proxyAbsoluteURL(sharePath)` 조차 타깃 URL 이 된다(2026-09-22,
  // e2e `history.pushState` SecurityError 실측).
  const URL = Native.URL || root.URL;
  let decodeFetchResponse;


  // ★2026-08-22 — `new URL(location.href).origin` 을 그냥 쓰면 **`about:srcdoc`
  // / `about:blank` 프레임에서 문자열 `"null"` 이 된다**(불투명 오리진). 그
  // 프레임에도 프렐류드가 주입되므로(injectSrcdoc) 거기서 만든 프록시 URL 이
  // 전부 `null/zp/api/fetch?url=…` 이라는 **상대 경로**가 됐고, 문서 base 가
  // 가상 base(=타깃)라 `http://<target>/null/zp/api/fetch?…` 로 풀렸다.
  // 게다가 `cssProxyURL` 의 "이미 프록시 URL 이면 건드리지 않는다" 판정이
  // `startsWith(proxyOrigin)` 이라 `"null"` 로는 절대 안 맞아 **이중 프록시**까지
  // 났다(g6-realm-imageset 테이프에서 확인: `?url=` 안에 또 프록시 URL).
  // 구멍 매트릭스는 이걸 못 봤다 — 멤브레인이 나중에 원본 URL 을 주워 다시
  // 부르므로 **도착 축은 켜지기 때문**이다. 지문 축에서만 보였다.
  //
  // 이 엔진은 `location.origin` 도 srcdoc/blank 에서 `"null"` 을 준다(대조군
  // 직접 로드로 확인), 그래서 그쪽으로 갈아타는 것으로는 안 고쳐진다.
  // 부팅 설정에 부모가 자기 오리진을 실어 보내고(bootJSON), 그것도 없으면
  // 조상 프레임을 타고 올라가 읽는다.
  function resolveProxyOrigin(u, bootCfg, w) {
    const direct = u && u.origin;
    if (direct && direct !== 'null') return direct;
    const fromBoot = bootCfg && bootCfg.proxyOrigin;
    if (fromBoot && fromBoot !== 'null') return String(fromBoot);
    // 지금 실행 중인 스크립트가 바로 우리 프렉루드다 — 그 src 는 항상
    // 프록시 오리진이고, 이 시점에는 아직 가상 base 를 안 깔았으므로
    // 해석 결과도 진짜다(훅도 아직 안 깔렸다).
    try {
      const cs = w && w.document && w.document.currentScript;
      const src = cs && cs.src;
      if (src) {
        const o = new URL(String(src)).origin;
        if (o && o !== 'null') return o;
      }
    } catch {}
    // ★마지막 수단. 조상의 `location` 은 **멤브레인이 가상화해 둔 값**일 수
    // 있다 — 실측으로 부모 프레임에서 `location.origin` 이 타깃 오리진을
    // 돌려준다. 그래서 앞의 두 경로가 전부 실패했을 때만 쓴다.
    try {
      let f = w;
      for (let i = 0; i < 32 && f && f.parent && f.parent !== f; i++) {
        f = f.parent;
        const o = f.location && f.location.origin;
        if (o && o !== 'null') return String(o);
      }
    } catch { /* cross-origin 조상은 못 읽는다 */ }
    return direct;
  }

  const toStringMap = new WeakMap();
  const toStringMaskedPrototypes = new WeakSet();
  const origToString = root.Function && root.Function.prototype && root.Function.prototype.toString;
  const initialProxyURL = new URL(root.location.href);
  const proxyOrigin = resolveProxyOrigin(initialProxyURL, boot, root);
  const proxyHost = proxyOrigin ? proxyOrigin.replace(/^[a-z]+:\/\//i, '') : initialProxyURL.host;

  // ★2026-08-22 — 이 블록은 원래 proxyOrigin 보다 **위에** 있었고, 그래서
  // wasm URL 이 루트 상대 경로(`/__zp/…`)였다. 문서의 base 는 **가상
  // base(=타깃)** 라, SW 가 잡지 못하는 문서(srcdoc / blob 프레임)에서는
  // 그 요청이 그대로 **타깃 서버로** 나갔다. 실측: 프록시 로드 한 번에
  // 픽스처 서버가 `GET /__zp/zp_page_rt.wasm?v=<빌드 id>` 를 **18번** 받았다.
  // 타깃은 (a) 프록시를 쓰는다는 사실과 (b) 우리 빌드 id 를 공짜로 얻고,
  // 우린 그 프레임마다 rt 가속 경로를 통째로 잃었다(404 → JS 폴백).
  // 구멍 매트릭스는 이걸 못 봤다 — 도착 축이 `/img/<id>` 만 센다.
  // 그래서 반드시 **프록시 오리진 절대 URL** 이어야 하고, 그러려면 이 블록이
  // proxyOrigin 보다 아래에 있어야 한다.
  // zp-page-rt (raw WASM, shared memory) — async boot. Once loaded, hot
  // paths can use rt.classifyBatch (MutationObserver batch) and handle-only
  // classifications (urlMeta cache). Until loaded, code paths fall through
  // to the existing JS regex / new URL() path — zero regression.
  //
  // The glue (web/zp-rt.js) is bundled as a prefix to this prelude by
  // scripts/build.mjs, so globalThis.ZeroProxyRT is defined synchronously
  // before this IIFE runs. The wasm fetch is async; rt stays null until
  // instantiation completes (~10-50ms after page load on warm cache).
  let rt = null;
  // ★부모가 **이 realm 을 먼저 계측했는지** 를 본다. 그런 프레임에서는
  // `captureNative` 가 잡은 `Native.fetch` 가 사실 **부모 멤브레인의 래퍼**라,
  // 프록시 오리진 URL 을 넘겨도 가상 오리진(=타깃)으로 다시 매핑된다.
  // 실측(2026-08-22): 프록시 로드 한 번에 픽스처 서버가
  // `GET /__zp/zp_page_rt.wasm?v=<빌드 id>` 를 9번 받았다 — 그 9개가 정확히
  // 이 부류의 프레임이었다. rt 는 **분류 가속용 최적화**일 뿐이므로,
  // 진짜 네이티브 fetch 를 못 잡은 realm 에서는 그냥 JS 경로로 간다 —
  // 타깃에게 우리 존재와 빌드 id 를 알려 주는 것보다 그 편이 싸다.
  // (`__zp_get` 은 부모가 자식 창에 직접 심는 헬퍼라, 자기 프렉루드가
  // 돌기 전에 있다면 부모가 먼저 계측했다는 뜻이다.)
  const realmPreInstrumented = typeof root.__zp_get === 'function';
  if (!realmPreInstrumented && typeof ZeroProxyRTGlobal === 'object' && ZeroProxyRTGlobal) {
    try {
      // ★글루의 `load(url)` 은 **전역 `fetch`** 를 쓴다. 그 fetch 가 불리는 시점에는
      // 이미 멤브레인이 갈아끼운 버전이라, 프록시 오리진 절대 URL 을 넘겨도
      // 가상 오리진(=타깃)으로 다시 매핑돼 타깃 서버로 나간다. 바이트를 직접
      // 당겨 넘기면 멤브레인이 경로에서 아예 빠진다.
      Native.fetch(proxyOrigin + '/__zp/zp_page_rt.wasm?v=__ZP_BUILD_ID__')
        .then(r => r.arrayBuffer())
        .then(buf => ZeroProxyRTGlobal.load(buf))
        .then(instance => { rt = instance; })
        .catch(() => { /* fall back to JS path */ });
    } catch { /* defensive */ }
  }
  const activeServers = ZP.relayServersForShare(Array.isArray(boot.servers) ? boot.servers : [], { allowLoopbackWS: true });
  let activeProxyPath = initialProxyURL.pathname;
  let activeProxyFragment = preservedShareFragment(initialProxyURL.hash);
  let activeRouteKey = ZP.isSharePath(activeProxyPath) ? ZP.shareRouteKey(activeProxyPath) : '';
  let virtualURL = new URL(boot.targetUrl);
  let activeEntryId = boot.entryId;
  let baseURL = virtualURL.href;
  // customElements 네임스페이스가 설치되면 채워진다 — patchHTMLSetter·
  // insertAdjacentHTML·createContextualFragment 등 "파스된 마크업" 경로가
  // 삽입 후 정의된 커스텀 엘리먼트를 교체-업그레이 하는 데 쓴다.
  let ceUpgradeSubtree = null;
  let explicitBaseURL = '';
  let activeShareVersion = 0;
  let documentCookie = String(boot.documentCookie || '');
  const documentCookieRecords = [];
  // ── RealmCtx (REFACTOR.md §3.3) — 이 realm 의 ambient 상태를 한 핸들로
  // 응집. getter/setter 모두 위 모듈 바인딩의 라이브 뷰라 복사·동기화가 없다.
  // 임베더는 root.__zp_realm(설치 끝에서 노출)으로 realm 상태를 읽고 일부
  // 필드를 구동할 수 있다. 브리지는 R6 에서 ctx.bridge 로 붙는다.
  const ctx = {
    get boot() { return boot; },
    get runtimeToken() { return runtimeToken; },
    get proxyOrigin() { return proxyOrigin; },
    get proxyHost() { return proxyHost; },
    get activeServers() { return activeServers; },
    get virtualURL() { return virtualURL; }, set virtualURL(v) { virtualURL = v; },
    get baseURL() { return baseURL; }, set baseURL(v) { baseURL = v; },
    get explicitBaseURL() { return explicitBaseURL; }, set explicitBaseURL(v) { explicitBaseURL = v; },
    get activeEntryId() { return activeEntryId; }, set activeEntryId(v) { activeEntryId = v; },
    get activeRouteKey() { return activeRouteKey; }, set activeRouteKey(v) { activeRouteKey = v; },
    get activeProxyPath() { return activeProxyPath; }, set activeProxyPath(v) { activeProxyPath = v; },
    get activeProxyFragment() { return activeProxyFragment; }, set activeProxyFragment(v) { activeProxyFragment = v; },
    get activeShareVersion() { return activeShareVersion; }, set activeShareVersion(v) { activeShareVersion = v; },
    get documentCookie() { return documentCookie; }, set documentCookie(v) { documentCookie = v; },
  };
  initDocumentCookieRecords(documentCookie);
  const urlMeta = new WeakMap();
  // getAttribute 리터럴 parity — 네이티브는 작성자 원문을 그대로 돌려준다.
  // 우리가 속성을 프록시 URL 로 바꿔 쓰므로 원문은 따로 기억한다.
  // (요소 → Map(attrName → literal)). htmltx 가 심은 초기 마크업의 리터럴은
  // `data-zp-lit-*` 속성으로 전달된다 — 둘 다 getAttribute 훅이 읽는다.
  const urlLitMeta = new WeakMap();
  function litAttrName(key) { return 'data-zp-lit-' + String(key).toLowerCase(); }
  function litSet(el, key, value) { let m = urlLitMeta.get(el); if (!m) { m = new Map(); urlLitMeta.set(el, m); } m.set(String(key).toLowerCase(), String(value)); }
  function litGet(el, key) { const m = urlLitMeta.get(el); const k = String(key).toLowerCase(); if (m && m.has(k)) return m.get(k); return undefined; }
  function litDel(el, key) { const m = urlLitMeta.get(el); if (m) m.delete(String(key).toLowerCase()); }
  // 페이지가 되읽는 값은 자기가 쓴 원본이어야 한다. `urlMeta` 는 요소당 값
  // 하나라서 못 쓴다 — img 는 `src` 와 `srcset` 을 동시에 갖는 게 정상이고,
  // 그러면 둘이 서로를 덮는다. 그래서 (요소, 속성) 단위로 따로 기억한다.
  const srcsetMeta = new WeakMap();
  const messageListenerWrappers = new WeakMap();
  const frameWindowOrigins = new WeakMap();
  // Sandbox-virt backing store. Target sites that test for `iframe.sandbox`
  // containing both `allow-scripts` and `allow-same-origin` use that as a
  // detection-signal for hostile embedding (since browsers refuse to enforce
  // the sandbox when those two combine). Stripping the attribute would change
  // observable behavior; we virtualize: the WeakMap holds the SET value, the
  // real DOM attribute is removed, and the membrane's getAttribute/has/etc
  // accessors return the virtual value. Membrane already isolates the iframe
  // content, so the "escape" the sandbox would have prevented cannot actually
  // happen here.
  const frameSandboxMeta = new WeakMap();
  // ★여기서 선언해야 한다 — installBaseObserver 는 프레임 격리 시점에 불리는데,
  // prelude 설치 시점에 이미 존재하던 iframe 은 이 파일 아래쪽(선언부 원위치)이
  // 실행되기 **전에** 그 경로를 지난다. const 를 뒤에 두면 TDZ 로 던지고
  // `catch { return }` 이 삼켜서 그 문서는 base 옵저버(속성 정책 강제 +
  // base[href] 동기화)를 영영 못 받는다. 실측: 로드당 수백 회.
  // 우리가 `configurable: false` 로 심는 자리들은 두 번째 시도가 **무조건**
  // 던진다. 신원(WeakSet)으로 막으려 했더니 안 먹었다 — 멤브레인이 감싼 창은
  // `w.HTMLLinkElement.prototype` 을 읽을 때마다 다른 래퍼를 주므로 WeakSet 이
  // 매번 미스한다. 그래서 신원이 아니라 **디스크립터**로 판정한다.
  function propertyLocked(obj, prop) {
    try {
      const d = Object.getOwnPropertyDescriptor(obj, prop);
      return !!d && !d.configurable;
    } catch { return true; }
  }
  const crossWindowProxyCache = new WeakMap();
  const postMessageWrappers = new WeakMap();
  // V8 incumbent realm leak — cross-realm postMessage wrap function call 시 message
  // event 의 `e.source` 가 incumbent (caller realm 의 contentWindow) 가 아닌 wrap
  // function 의 realm (parent) 으로 corrupt 됨. NAVER GFP SafeFrame SDK 의 resize
  // handler 가 `e.source === iframe.contentWindow` 비교로 어느 광고 iframe 에서
  // resize 메시지 왔는지 식별 → source 가 parent 로 corrupt 되어 모든 광고 iframe
  // height=0 으로 collapse. Fix: 각 iframe 의 `parent`/`top` accessor 를 sender-aware
  // proxy 로 override + sender queue 로 message dispatch 시 source 정정.
  // Description-less Symbols: `Object.getOwnPropertySymbols(obj)` still
  // returns these, but `symbol.description === undefined` so anti-bot
  // probes don't see the "zeroproxy.*" prefix that used to be embedded
  // here. Cross-realm sharing isn't needed for these markers — each
  // realm gets its own prelude install — so dropping `Symbol.for` is
  // free. `listenersKey` was already description-less; pinning the
  // rest to match.
  const frameTargetOriginMarker = Symbol();
  const networkContainmentMarker = Symbol();
  const iframeHooksMarker = Symbol();
  const safeFrameShimMarker = Symbol();
  const stealthMarker = Symbol();
  const listenersKey = Symbol();
  const windowMethodBindings = new Map();
  const integrityBackupAttr = 'data-zp-integrity';
  const hiddenIconHref = 'data:application/x-zeroproxy-icon,1';
  const WINDOW_BOUND_METHODS = new Set(['addEventListener','removeEventListener','dispatchEvent','setTimeout','setInterval','clearTimeout','clearInterval','requestAnimationFrame','cancelAnimationFrame','requestIdleCallback','cancelIdleCallback','matchMedia','getComputedStyle','postMessage','atob','btoa','focus','blur','close','print','alert','confirm','prompt','scroll','scrollTo','scrollBy']);
  const canvasHookedWindows = new WeakSet();
  const audioHookedWindows = new WeakSet();
  const serviceWorkerFacades = new WeakMap();
  const storageMaps = new Map();
  const storageWindows = new Set();
  // The page-rewriter helpers live inside `installPhase2Membrane`'s scope, but
  // `installNetworkContainment` — a sibling top-level function — needs them to
  // build the child-realm script executors. Referencing them directly from
  // there is a guaranteed ReferenceError; it stayed hidden for a long time
  // because the child-realm classic-script path only runs when target code
  // writes a script into a friendly iframe (NAVER's ad SDK `insertAdm`, which
  // could not even load until static module specifiers were rewritten).
  // Published here so both scopes share one implementation.
  let pageRewriteHooks = null;

  // Non-zero while a child-realm script runs off the ordered pipeline instead of
  // straight off the parser (see `childEnqueue` in installNetworkContainment).
  // The only thing that reads it is the `document.write` closed-document guard:
  // outside a deferred run we must keep the native wipe semantics, because a
  // page doing a late `document.write` gets wiped in a real browser too.
  let deferredScriptDepth = 0;

  // Diagnostic ring buffer: capture target-script errors so we can introspect
  // hydration / runtime failures without instrumenting the page after-the-fact.
  // Exposed as the global __zp_diagnostics — read from devtools/taskweaver.
  try {
    if (!root.__zp_diagnostics) {
      const diag = [];
      const push = e => { if (diag.length < 200) diag.push(e); };
      // non-enumerable: keeps it out of `for (k in window)` (see ZP_HIDDEN_RE).
      Object.defineProperty(root, '__zp_diagnostics', { value: diag, writable: true, enumerable: false, configurable: true });
      root.addEventListener('error', e => {
        const ent = {
          t: 'error',
          msg: String(e.message || ''),
          src: e.filename ? String(e.filename).slice(0, 120) : '',
          line: e.lineno | 0,
          col: e.colno | 0,
          stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 800) : ''
        };
        push(ent);
        try { zpTrace('err', ent.msg.slice(0, 120) + '@' + ent.src + ':' + ent.line); } catch {}
      }, true);
      root.addEventListener('unhandledrejection', e => {
        const reason = (() => { try { return String(e.reason).slice(0, 300); } catch { return '???'; } })();
        push({ t: 'rejection', reason, stack: e.reason && e.reason.stack ? String(e.reason.stack).slice(0, 800) : '' });
        try { zpTrace('rej', reason.slice(0, 160)); } catch {}
      }, true);
      const oce = root.console && root.console.error;
      if (oce) {
        root.console.error = function(...args) {
          push({
            t: 'console.error',
            args: args.map(a => {
              if (a instanceof Error) return { err: true, msg: a.message, stack: a.stack && a.stack.slice(0, 500) };
              try { return String(a).slice(0, 300); } catch { return '???'; }
            })
          });
          return oce.apply(this, args);
        };
      }
    }
  } catch {}

  // Persistent trace: write checkpoints to proxy-origin localStorage so a
  // hang in target code can be post-mortem analyzed by restarting the
  // browser and inspecting __zp_trace_log/__zp_hb. Heartbeat overwrites a
  // single key (no churn); checkpoints append to a capped log (~100 entries).
  let __zpTraceSeq = 0;
  let __zpNativeStorage = null;
  try { __zpNativeStorage = root.localStorage; } catch {}

  // Pre-warm chain consumer lives in the SW-injected inline script (see
  // sw.js buildRuntimePrelude). State now travels in the URL fragment so
  // naver.com's anti-bot JS can't scrub it the way it scrubs proxy-origin
  // localStorage.
  function zpTrace(tag, extra) {
    if (!__zpNativeStorage) return;
    try {
      const key = '__zp_trace_log';
      let log;
      try { log = JSON.parse(__zpNativeStorage.getItem(key) || '[]'); } catch { log = []; }
      const entry = { n: ++__zpTraceSeq, t: Date.now(), tag: String(tag).slice(0, 80) };
      if (extra !== undefined) { try { entry.x = (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 200); } catch {} }
      log.push(entry);
      if (log.length > 100) log.splice(0, log.length - 100);
      __zpNativeStorage.setItem(key, JSON.stringify(log));
    } catch {}
  }
  try {
    const hidden = (name, value) => Object.defineProperty(root, name, { value, writable: true, enumerable: false, configurable: true });
    hidden('__zp_trace', zpTrace);
    hidden('__zp_trace_clear', () => { try { __zpNativeStorage && __zpNativeStorage.removeItem('__zp_trace_log'); __zpNativeStorage && __zpNativeStorage.removeItem('__zp_hb'); } catch {} });
  } catch {}
  try {
    let __zpBeats = 0;
    setInterval(() => {
      __zpBeats++;
      try { __zpNativeStorage && __zpNativeStorage.setItem('__zp_hb', JSON.stringify({ n: __zpBeats, t: Date.now() })); } catch {}
    }, 100);
  } catch {}
  zpTrace('prelude:start');
  try {
    root.document && root.document.addEventListener('load', e => {
      const t = e && e.target;
      if (t && t.tagName === 'SCRIPT') { try { zpTrace('script:load', (t.src || t.getAttribute && t.getAttribute('src') || '').slice(0,120)); } catch {} }
    }, true);
    root.document && root.document.addEventListener('error', e => {
      const t = e && e.target;
      if (t && t.tagName === 'SCRIPT') { try { zpTrace('script:error', (t.src || t.getAttribute && t.getAttribute('src') || '').slice(0,120)); } catch {} }
    }, true);
  } catch {}