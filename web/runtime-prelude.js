(() => {
  'use strict';
  const root = window;
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
  let explicitBaseURL = '';
  let activeShareVersion = 0;
  let documentCookie = String(boot.documentCookie || '');
  const documentCookieRecords = [];
  initDocumentCookieRecords(documentCookie);
  const urlMeta = new WeakMap();
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
  const workerBlobURLs = new Set();
  // 페이지가 만든 blob URL 중 **스크립트가 될 수 있는** 것들. 워커 경로에서만
  // 본다 — 만드는 순간에는 아무것도 하지 않는다(아래 createObjectURL 참고).
  const scriptishBlobURLs = new Set();
  const SCRIPTISH_BLOB_TYPE = /javascript|ecmascript|text\/plain|application\/octet-stream|^$/i;
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

  function readBootConfig() {
    const d = root.document;
    const el = d && d.getElementById && d.getElementById('__zp-boot');
    if (el) {
      try {
        const parsed = JSON.parse(el.textContent || '{}');
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {}
    }
    return root.__ZP_BOOT || {};
  }

  function clearBootConfig() {
    const d = root.document;
    const el = d && d.getElementById && d.getElementById('__zp-boot');
    if (el) {
      try { el.remove(); } catch {}
    }
    try { delete root.__ZP_BOOT; } catch { try { Object.defineProperty(root, '__ZP_BOOT', { value: undefined, enumerable: false }); } catch {} }
  }
  function captureNative(w) {
    const d = w.document;
    return {
      fetch: w.fetch && w.fetch.bind(w),
      // 가상 URL 로 덮기 **전**의 진짜 document.URL. 자식 프레임이 SW 를 거칠
      // 수 있는지 판정하는 유일하게 정직한 신호다 — `doc.URL` 은 우리가
      // 가상 URL 을 돌려주도록 훅해 놨으므로 오라클로 못 쓴다.
      documentURLDesc: Object.getOwnPropertyDescriptor(w.Document && w.Document.prototype, 'URL'),
      XMLHttpRequest: w.XMLHttpRequest,
      WebSocket: w.WebSocket,
      // D4: native WebTransport for the virtual-class pass-through to
      // the ZeroProxy gateway. Captured here so target code that
      // overwrites `globalThis.WebTransport` later can't break our
      // shim. May be undefined on browsers that don't ship WT —
      // ZPWebTransport falls back to the rejected-promise stub.
      WebTransport: w.WebTransport,
      EventSource: w.EventSource,
      Worker: w.Worker,
      FunctionCtor: w.Function,
      // Native `eval`, captured before `define(root, 'eval', dynamicEval)`
      // swaps it for the scoped jail variant. Only used through
      // `execGlobalScript` to give inline <script> bodies real global scope —
      // site-called `eval()` still goes through `dynamicEval`.
      globalEval: w.eval,
      SharedWorker: w.SharedWorker,
      FormData: w.FormData,
      URL: w.URL,
      Blob: w.Blob,
      DOMException: w.DOMException,
      Request: w.Request,
      Response: w.Response,
      serviceWorkerController: w.navigator && w.navigator.serviceWorker && w.navigator.serviceWorker.controller,
      Headers: w.Headers,
      navigatorSendBeacon: w.navigator && w.navigator.sendBeacon && w.navigator.sendBeacon.bind(w.navigator),
      serviceWorker: w.navigator && w.navigator.serviceWorker,
      createElement: d.createElement.bind(d),
      createElementNS: d.createElementNS && d.createElementNS.bind(d),
      appendChild: w.Node.prototype.appendChild,
      insertBefore: w.Node.prototype.insertBefore,
      replaceChild: w.Node.prototype.replaceChild,
      setAttribute: w.Element.prototype.setAttribute,
      getAttribute: w.Element.prototype.getAttribute,
      removeAttribute: w.Element.prototype.removeAttribute,
      hasAttribute: w.Element.prototype.hasAttribute,
      getAttributeNames: w.Element.prototype.getAttributeNames,
      insertAdjacentHTML: w.Element.prototype.insertAdjacentHTML,
      elementInnerHTML: Object.getOwnPropertyDescriptor(w.Element.prototype, 'innerHTML'),
      elementOuterHTML: Object.getOwnPropertyDescriptor(w.Element.prototype, 'outerHTML'),
      elementAttributes: Object.getOwnPropertyDescriptor(w.Element.prototype, 'attributes'),
      setAttributeNS: w.Element.prototype.setAttributeNS,
      getAttributeNS: w.Element.prototype.getAttributeNS,
      hasAttributeNS: w.Element.prototype.hasAttributeNS,
      removeAttributeNS: w.Element.prototype.removeAttributeNS,
      getAttributeNode: w.Element.prototype.getAttributeNode,
      getAttributeNodeNS: w.Element.prototype.getAttributeNodeNS,
      setAttributeNode: w.Element.prototype.setAttributeNode,
      setAttributeNodeNS: w.Element.prototype.setAttributeNodeNS,
      removeAttributeNode: w.Element.prototype.removeAttributeNode,
      toggleAttribute: w.Element.prototype.toggleAttribute,
      namedRemoveNamedItem: w.NamedNodeMap && w.NamedNodeMap.prototype.removeNamedItem,
      htmlDataset: w.HTMLElement && Object.getOwnPropertyDescriptor(w.HTMLElement.prototype, 'dataset'),
      svgDataset: w.SVGElement && Object.getOwnPropertyDescriptor(w.SVGElement.prototype, 'dataset'),
      namedSetNamedItem: w.NamedNodeMap && w.NamedNodeMap.prototype.setNamedItem,
      attrValue: w.Attr && Object.getOwnPropertyDescriptor(w.Attr.prototype, 'value'),
      matches: w.Element.prototype.matches,
      closest: w.Element.prototype.closest,
      querySelector: w.Document.prototype.querySelector,
      querySelectorAll: w.Document.prototype.querySelectorAll,
      elementQuerySelectorAll: w.Element.prototype.querySelectorAll,
      elementQuerySelector: w.Element.prototype.querySelector,
      // `<template>` 의 내용은 **별도의 DocumentFragment** 라 어떤
      // querySelectorAll 로도 도달하지 않는다. 그런데 HTML 직렬화는 그 안을
      // 그대로 뱉는다 — 세정기가 못 걷는 곳을 직렬화기는 걷는다(reddit 실측).
      fragmentQuerySelectorAll: w.DocumentFragment && w.DocumentFragment.prototype.querySelectorAll,
      templateContent: w.HTMLTemplateElement
        && Object.getOwnPropertyDescriptor(w.HTMLTemplateElement.prototype, 'content'),
      documentGetElementsByTagName: w.Document.prototype.getElementsByTagName,
      elementGetElementsByTagName: w.Element.prototype.getElementsByTagName,
      documentScripts: Object.getOwnPropertyDescriptor(w.Document.prototype, 'scripts'),
      createNodeIterator: w.Document.prototype.createNodeIterator,
      createTreeWalker: w.Document.prototype.createTreeWalker,
      createHTMLDocument: d.implementation && d.implementation.createHTMLDocument && d.implementation.createHTMLDocument.bind(d.implementation),
      scriptText: w.HTMLScriptElement && Object.getOwnPropertyDescriptor(w.HTMLScriptElement.prototype, 'text'),
      nodeTextContent: Object.getOwnPropertyDescriptor(w.Node.prototype, 'textContent'),
      htmlInnerText: w.HTMLElement && Object.getOwnPropertyDescriptor(w.HTMLElement.prototype, 'innerText'),
      formSubmit: w.HTMLFormElement && w.HTMLFormElement.prototype.submit,
      formRequestSubmit: w.HTMLFormElement && w.HTMLFormElement.prototype.requestSubmit,
      documentOpen: d.open && d.open.bind(d),
      documentWrite: d.write && d.write.bind(d),
      documentWriteln: d.writeln && d.writeln.bind(d),
      documentClose: d.close && d.close.bind(d),
      historyPush: w.history.pushState.bind(w.history),
      historyReplace: w.history.replaceState.bind(w.history),
      locationAssign: w.location && w.location.assign && w.location.assign.bind(w.location),
      locationReplace: w.location && w.location.replace && w.location.replace.bind(w.location),
      locationHref: Object.getOwnPropertyDescriptor(w.Location && w.Location.prototype, 'href') || Object.getOwnPropertyDescriptor(w.location, 'href'),
      locationReload: w.location && w.location.reload && w.location.reload.bind(w.location),
      createObjectURL: w.URL && w.URL.createObjectURL && w.URL.createObjectURL.bind(w.URL),
      revokeObjectURL: w.URL && w.URL.revokeObjectURL && w.URL.revokeObjectURL.bind(w.URL),
      open: w.open && w.open.bind(w),
      setTimeout: w.setTimeout && w.setTimeout.bind(w),
      setInterval: w.setInterval && w.setInterval.bind(w),
      clearTimeout: w.clearTimeout && w.clearTimeout.bind(w),
      clearInterval: w.clearInterval && w.clearInterval.bind(w),
      DOMParserParseFromString: w.DOMParser && w.DOMParser.prototype && w.DOMParser.prototype.parseFromString,
      rangeCreateContextualFragment: w.Range && w.Range.prototype && w.Range.prototype.createContextualFragment,
      windowAddEventListener: w.addEventListener && w.addEventListener.bind(w),
      windowRemoveEventListener: w.removeEventListener && w.removeEventListener.bind(w),
    };
  }

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
  function installToStringMasking(w) {
    const proto = w && w.Function && w.Function.prototype;
    if (!proto || toStringMaskedPrototypes.has(proto)) return;
    const orig = w === root ? origToString : proto.toString;
    if (typeof orig !== 'function') return;
    const maskedToString = function toString() {
      if (typeof this === 'function' && toStringMap.has(this)) return toStringMap.get(this);
      return orig.call(this);
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
  function preservedShareFragment(hash) {
    if (!hash) return '';
    try {
      const raw = hash[0] === '#' ? hash.slice(1) : hash;
      const params = new URLSearchParams(raw);
      const key = params.get('k');
      return key ? ZP.makeShareFragment(key, activeServers) : '';
    } catch { return ''; }
  }
  function shareFragmentForKey(key) { return ZP.makeShareFragment(String(key), activeServers); }
  function proxyHistoryURL() { return activeProxyPath + activeProxyFragment; }
  // ★프록시 경로를 **상대 경로 그대로** 브라우저에 넘기면 안 된다.
  // `location.assign` / `location.replace` / `history.pushState` 는 인자를
  // **문서의 base URL** 로 푼다. 타깃이 `<base href="http://other/">` 를 두면
  // 우리 `/zp/p/<토큰>` 이 **그 오리진**에 붙어 문서째 프록시 밖으로 나간다.
  // nav-matrix `n3-base-href` 실측: 착지 주소가
  // `http://127.0.0.1:18086/zp/p/23YKGo…` — 우리 경로인데 오리진이 타깃이다.
  // 프레임 경로(`activatedFrameURL`)는 이미 절대 URL 을 쓰고 있었다. 여기만
  // 빠져 있었고, 그래서 이 탈출은 `<base href>` 한 줄이면 성립했다.
  function proxyAbsoluteURL(pathAndFragment) {
    const raw = String(pathAndFragment || '');
    try { return new URL(raw, proxyOrigin).href; } catch { return proxyOrigin + raw; }
  }
  function nativeLocationURL() {
    try {
      const href = Native.locationHref && Native.locationHref.get && Native.locationHref.get.call(root.location);
      if (href) return new URL(href);
    } catch {}
    try { return new URL(proxyHistoryURL(), proxyOrigin); } catch { return new URL(initialProxyURL.href); }
  }
  function visibleProxyURL() { const u = nativeLocationURL(); return u.pathname + u.search + u.hash; }
  function setActiveShareRoute(share) {
    activeProxyPath = ZP.makeSharePath(share.encrypted);
    activeRouteKey = share.encrypted;
    activeProxyFragment = shareFragmentForKey(share.key);
  }
  function replaceVisibleProxyURL() {
    const next = proxyHistoryURL();
    if (visibleProxyURL() !== next) {
      try { Native.historyReplace(root.history.state, '', proxyAbsoluteURL(next)); } catch {}
    }
  }
  function refreshVisibleShareRoute(entryId, target, base) {
    const version = ++activeShareVersion;
    ZP.encryptShareURL(target).then(share => {
      return postMessageToSW({ type: 'ZP_HISTORY_UPDATE', tabId: boot.tabId, routeKey: share.encrypted, entryId, targetUrl: target, baseUrl: base, replace: true }).then(() => share);
    }).then(share => {
      if (version !== activeShareVersion || entryId !== activeEntryId || target !== virtualURL.href) return;
      setActiveShareRoute(share);
      replaceVisibleProxyURL();
    }).catch(()=>{});
  }
  function isHTTPURL(raw) { try { const u = new URL(String(raw), baseURL); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } }
  function hasExecutableURLScheme(raw) { return /^(?:javascript|data|vbscript):/i.test(String(raw).trim()); }
  function hasDangerousURLScheme(raw) { return /^(?:javascript|vbscript):/i.test(String(raw).trim()); }
  // ★스킴이 http(s) 가 아닌 **절대** URL 은 그대로 돌려준다 (2026-08-26).
  //
  // URL 프로퍼티 게터가 값을 무조건 `targetURL()` 에 넣고 있었다. 그건
  // http(s) 만 받으므로 `blob:` / `data:` / `about:` / `mailto:` / `tel:` 은
  // 전부 **읽는 순간 TARGET_PROTOCOL_BLOCKED 를 던졌다**. 쓰기는 멀쩡히
  // 저장되므로(속성엔 원본이 그대로 있다) 증상이 "쓰고 나서 읽으면 폭발" 이다.
  //
  // CNN 실측: Max 플레이어가 `video.src = URL.createObjectURL(mediaSource)`
  // 뒤 `video.src` 를 읽다가 죽어 **비디오 세그먼트가 한 건도 안 나갔다**
  // (대조군 115건 vs 프록시 0건). `a.href` 가 `mailto:` 에서 던지는 것도
  // 같은 한 줄이다 — CNN 만의 문제가 아니다.
  //
  // 진짜 브라우저는 스킴이 있는 절대 URL 을 base 로 풀지 않고 파서 정규화만
  // 해서 돌려준다. 상대 URL(`/x`)과 조각(`#x`)은 여전히 타깃 기준으로
  // 풀어야 하므로 **스킴이 있을 때만** 이 경로를 탄다.
  function nonHTTPAbsoluteURL(raw) {
    const s = String(raw).trim();
    const m = /^([a-z][a-z0-9+.\-]*):/i.exec(s);
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https') return null;
    try { return new URL(s).href; } catch { return s; }
  }
  // Single-parse equivalent of `isHTTPURL(v) && targetURL(v)` — the previous
  // pattern parsed the URL twice (once for scheme check, once for canonical
  // form). For long URLs (signed CDN, encoded query) `new URL()` is ~1300ns
  // each, so the redundant parse doubled hot-path cost. targetURL throws
  // TARGET_PROTOCOL_BLOCKED on non-HTTP, so the catch covers both
  // "not http/https" and "malformed" cases.
  //
  // Consults tickURLCache when active (set during MutationObserver callback)
  // — same raw URL repeating within one tick parses once.
  function targetURLIfHTTP(raw) {
    const key = String(raw);
    if (tickURLCache) {
      const cached = tickURLCache.get(key);
      if (cached !== undefined) return cached;
    }
    let result;
    try { result = targetURL(key); }
    catch { result = null; }
    if (tickURLCache) tickURLCache.set(key, result);
    return result;
  }
  // Tick-local URL classification cache. Set by MO callback at tick start,
  // cleared at tick end. Pre-populated with `null` for non-HTTP URLs when
  // rt batch-classify is available, eliminating new URL() parse for those.
  // HTTP URLs are NOT pre-populated (would still need canonicalization).
  let tickURLCache = null;

  // Per-element raw → target cache. When React / Vue / similar reconciler
  // re-applies the same `src=...` to the same element across renders, we
  // skip the `new URL()` parse and return the cached canonical target.
  //
  // Distinct from tickURLCache:
  //   - tickURLCache  : dedup within a tick across all elements (by raw)
  //   - urlClassifyCache : dedup across ticks per element (raw → target)
  //
  // Stored as { lastRaw, target } per element. Overwritten on new raw.
  // WeakMap so GC removes entries when element is detached.
  const urlClassifyCache = new WeakMap();
  function targetURLForElement(el, raw) {
    const key = String(raw);
    const cached = urlClassifyCache.get(el);
    if (cached && cached.lastRaw === key) return cached.target;
    const target = targetURLIfHTTP(key);
    if (target) urlClassifyCache.set(el, { lastRaw: key, target });
    return target;
  }
  function shouldBlockURLAttribute(el, key, raw, _localKey, _tag) {
    const tag = _tag != null ? _tag : (el && el.localName);
    const localKey = _localKey != null ? _localKey : attrLocalName(key);
    const strict = localKey === 'src' && tag === 'script' || localKey === 'src' && (tag === 'iframe' || tag === 'frame') || usesRawURLAttribute(el, key, localKey);
    return strict ? hasExecutableURLScheme(raw) : hasDangerousURLScheme(raw);
  }
  // A3 hardening: blob: URLs are legitimate for <img>/<video>/<audio>/<source>
  // (target sites build them from Blob data) but must never feed <script>,
  // <iframe>, <frame>, or <embed>/<object> — those would bypass the
  // OXC rewrite pipeline and run unclassified target code.
  function hasContextBlockedScheme(el, raw) {
    const s = String(raw).trim();
    if (!/^blob:/i.test(s)) return false;
    const tag = el && el.localName;
    return tag === 'script' || tag === 'iframe' || tag === 'frame' || tag === 'embed' || tag === 'object';
  }
  function blockedURLValue(el, key) { const tag = el && el.localName; return key === 'src' && (tag === 'iframe' || tag === 'frame') ? 'about:blank' : key === 'src' && tag === 'script' ? ZP.errorPath('POLICY_BLOCKED') : '#'; }
  function blockExecutableURL(el, key, raw) { urlMeta.delete(el); Native.setAttribute.call(el, 'data-zp-target-url', ''); Native.setAttribute.call(el, 'data-zp-blocked-url', String(raw).trim()); Native.setAttribute.call(el, key, blockedURLValue(el, key)); if (key === 'src' && (el.localName === 'iframe' || el.localName === 'frame')) instrumentIframe(el); }
  // ★타깃이 페이지 realm 에서 `<meta http-equiv="Content-Security-Policy">` 를
  // 꽂으면 그 정책이 **우리 문서에 실제로 적용된다**(2026-08-21 실측: 주입 전
  // 이미지 LOADED → `img-src 'none'` 주입 후 BLOCKED). 서버측 htmltx 는 정적
  // HTML 의 같은 표면을 이미 무력화하는데 페이지 realm 에만 없었다.
  //
  // **탈출은 아니다** — 정책은 교집합이라 타깃이 느슨하게 만들 수 없고,
  // `report-uri` 는 브라우저가 meta 전달 시 무시한다(크롬이 직접 그렇게 찍는다:
  // "'report-uri' is ignored when delivered via a <meta> element"). 즉 릴레이를
  // 우회하는 보고 egress 도 안 열린다. 문제는 **우리 런타임을 죽일 수 있다는 것**
  // 이다 — `script-src 'none'` 이면 멤브레인이 붙인 스크립트가, `connect-src 'none'`
  // 이면 릴레이 트랜스포트가 막힌다. 그리고 정책이 먹히는지 여부 자체가 지문이다.
  //
  // htmltx 와 **같은 백업 속성**을 쓴다.
  const CSP_EQUIV = ['content-security-policy', 'content-security-policy-report-only'];
  function isCSPHttpEquiv(value) {
    return CSP_EQUIV.indexOf(String(value || '').trim().toLowerCase()) >= 0;
  }
  function neutralizeCSPMeta(el, value) {
    Native.setAttribute.call(el, 'data-zp-blocked-http-equiv', String(value));
    if (Native.removeAttribute) { try { Native.removeAttribute.call(el, 'http-equiv'); } catch {} }
  }
  function isIntegrityBearing(el) { const tag = el && el.localName; return tag === 'script' || tag === 'link'; }
  function backedIntegrity(el) { return isIntegrityBearing(el) ? Native.getAttribute.call(el, integrityBackupAttr) : null; }
  function setBackedIntegrity(el, value) { Native.setAttribute.call(el, integrityBackupAttr, String(value)); if (Native.removeAttribute) Native.removeAttribute.call(el, 'integrity'); }
  // ★프록시 정체가 페이지로 샌 값을 **소비 지점에서** 되돌리는 단일 게이트.
  //
  // 왜 원천 차단이 아니라 게이트인가: `location` 의 프로퍼티는
  // [LegacyUnforgeable] (own, `configurable:false`) 이라 멤브레인이 가릴 수
  // 없다. 게다가 동적/난독화 코드는 `eval("this")` 로 진짜 window 를 잡은 뒤
  // `w[decode("location")]` 같은 **computed access** 로 읽어서 리라이터도 그
  // 자리를 정적으로 볼 수 없다. 즉 이 누출은 원천 차단이 불가능하고,
  // **값이 타깃 URL 이 되는 지점**에서 되돌리는 것만이 가능하다.
  //
  // 페이지가 준 raw 가 타깃이 되는 입구는 딱 셋이다. 셋 다 여길 통과한다:
  //   targetURL()        — DOM URL 속성 / 네비게이션 / form action
  //   requestTargetURL() — fetch / XHR / EventSource
  //   targetWSURL()      — WebSocket
  //
  // 인식 대상은 **우리 라우팅 어휘뿐**이다. `/zp/` 로 시작한다고 무조건
  // 삼키면 타깃 사이트에 진짜 `/zp/…` 경로가 있을 때 그 사이트를 깨뜨린다.
  //
  // 반환값: 교체할 raw 문자열, 또는 `null` = "우리 것이다 — 현재 가상 문서
  // URL 로 대체하라". ws/wss 로 바꿔야 하는 쪽이 있어서 문자열 하나로
  // 뭉뚱그리지 않고 호출자가 스킴을 결정하게 둔다.
  function proxyLocalPath(raw) {
    const s = String(raw == null ? '' : raw);
    if (!s) return '';
    // 루트 상대 경로. `//host/x` 는 프로토콜 상대라 아래에서 따로 본다.
    if (s[0] === '/' && s[1] !== '/') { const h = s.indexOf('#'); return h < 0 ? s : s.slice(0, h); }
    const abs = s.slice(0, 2) === '//' ? 'http:' + s : s;
    // 스킴 없는 상대 경로(`foo.js`)를 프록시 오리진에 붙여 보면 안 된다 —
    // 전부 우리 것으로 오인한다.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(abs)) return '';
    let u;
    try { u = new URL(abs); } catch { return ''; }
    return u.host === proxyHost ? u.pathname + u.search : '';
  }
  function unleakedTargetRaw(raw) {
    const s = String(raw == null ? '' : raw);
    // 이미 **타깃 오리진에 붙어 버린** 우리 경로도 잡는다. 페이지가
    // `new URL(location.pathname, document.baseURI)` 로 만들면 호스트가
    // 타깃이라 아래 프록시-호스트 검사에 안 걸린다. 지금 share 경로와
    // **바이트가 같을 때만** 본다 — 그건 고엔트로피 암호 토큰이라 타깃
    // 사이트의 실제 경로와 겹칠 수 없다.
    if (activeProxyPath && s.indexOf(activeProxyPath) >= 0) {
      try { if (new URL(s, baseURL).pathname === activeProxyPath) return null; } catch {}
    }
    const local = proxyLocalPath(s);
    if (!local) return s;
    const qi = local.indexOf('?');
    const path = qi < 0 ? local : local.slice(0, qi);
    const params = qi < 0 ? null : new URLSearchParams(local.slice(qi + 1));
    // (a) 서브리소스 래퍼 — 진짜 타깃이 안에 들어 있다.
    if (path === ZP.apiPath('fetch') && params && params.get('url')) return params.get('url');
    // (b) 네비게이션 런처 — 마찬가지.
    if (path === ZP.controlPath('') && params && params.get('via')) return params.get('via');
    // (c) share 경로 — 암호화된 우리 라우팅 키다. 타깃에 실려 나가면 안 되고,
    //     타깃 오리진에 붙여 dial 해도 언제나 오답이다.
    //     Cloudflare 챌린지가 통과 직후 `form.action = location.pathname` 으로
    //     정확히 이 값을 심어 `https://<target>/zp/p/<token>` 을 POST 했다.
    if (ZP.isSharePath(path)) return null;
    return s;
  }
  function targetURL(raw, base = baseURL) {
    const g = unleakedTargetRaw(raw);
    return ZP.canonicalTargetURL(g === null ? virtualURL.href : g, base).href;
  }
  function targetWSURL(raw, base = baseURL) {
    const g = unleakedTargetRaw(raw);
    return ZP.canonicalWebSocketURL(g === null ? virtualURL.href.replace(/^http/, 'ws') : g, base.replace(/^http/, 'ws')).href;
  }
  function shareNavURL(raw, base = baseURL) { return ZP.makeShareURL(targetURL(raw, base), proxyOrigin, activeServers); }
  function sameOriginHistoryURL(url) { const next = new URL(targetURL(url)); if (next.origin !== virtualURL.origin) throw normalizedError('SecurityError'); return next; }
  function commitVirtualHistory(state, title, url, replace = false) {
    const next = url != null ? sameOriginHistoryURL(url) : new URL(virtualURL.href);
    virtualURL = next;
    if (!explicitBaseURL) baseURL = virtualURL.href;
    const entryId = replace && activeEntryId ? activeEntryId : 'e' + ZP.randomId();
    activeEntryId = entryId;
    postMessageToSW({ type: 'ZP_HISTORY_UPDATE', tabId: boot.tabId, routeKey: activeRouteKey, entryId, targetUrl: virtualURL.href, baseUrl: baseURL, replace }).catch(()=>{});
    const out = (replace ? Native.historyReplace : Native.historyPush)(state, title, proxyAbsoluteURL(proxyHistoryURL()));
    refreshVisibleShareRoute(entryId, virtualURL.href, baseURL);
    return out;
  }
  function updateVirtualHash(raw, replace = false) {
    const oldURL = virtualURL.href;
    const next = new URL(virtualURL.href);
    let hash = String(raw);
    if (hash && hash[0] !== '#') hash = '#' + hash;
    next.hash = hash;
    if (next.href === virtualURL.href) return;
    const out = commitVirtualHistory(null, '', next.href, replace);
    try { window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: virtualURL.href })); } catch { try { window.dispatchEvent(new Event('hashchange')); } catch {} }
    return out;
  }
  function setVirtualLocation(raw, replace = false) {
    const next = new URL(targetURL(raw));
    if (next.origin === virtualURL.origin && next.pathname === virtualURL.pathname && next.search === virtualURL.search) {
      updateVirtualHash(next.hash, replace);
      return;
    }
    navigateToTarget(next.href, replace);
  }
  async function activatedNavPath(raw, replace = false, base = baseURL) {
    const target = targetURL(raw, base);
    const share = await ZP.encryptShareURL(target);
    const path = ZP.makeSharePath(share.encrypted);
    const entryId = replace ? activeEntryId : 'e' + ZP.randomId();
    await postMessageToSW({ type: 'ZP_HISTORY_UPDATE', tabId: boot.tabId, routeKey: share.encrypted, entryId, targetUrl: target, baseUrl: target, replace });
    activeProxyPath = path;
    activeRouteKey = share.encrypted;
    activeProxyFragment = shareFragmentForKey(share.key);
    return path + activeProxyFragment;
  }
  async function activatedFrameURL(raw, base = baseURL) {
    const target = targetURL(raw, base);
    const share = await ZP.encryptShareURL(target);
    const entryId = 'e' + ZP.randomId();
    // parentTargetUrl carries the embedding page's virtual URL so the SW can
    // send the right Referer when fetching the iframe document. Without it
    // the iframe's own URL is used, and origin-aware endpoints (e.g. NAVER's
    // shopsquare.naver.com /newshopping) 404 because they expect the embedder
    // page's host in Referer.
    await postMessageToSW({ type: 'ZP_FRAME_ROUTE', tabId: boot.tabId, routeKey: share.encrypted, entryId, targetUrl: target, baseUrl: target, parentTargetUrl: virtualURL.href });
    return proxyOrigin + ZP.makeSharePath(share.encrypted) + shareFragmentForKey(share.key);
  }
  function navigateToTarget(raw, replace = false, base = baseURL) {
    activatedNavPath(raw, replace, base).then(path => {
      const href = proxyAbsoluteURL(path);
      if (replace && Native.locationReplace) Native.locationReplace(href);
      else if (!replace && Native.locationAssign) Native.locationAssign(href);
      else if (replace) location.replace(href);
      else location.href = href;
    }).catch(() => shareNavURL(raw, base).then(u => {
      if (replace && Native.locationReplace) Native.locationReplace(u);
      else if (!replace && Native.locationAssign) Native.locationAssign(u);
      else if (replace) location.replace(u);
      else location.href = u;
    }).catch(()=>{}));
  }
  function postMessageToSW(message, transfer) {
    const controller = Native.serviceWorkerController || Native.serviceWorker && Native.serviceWorker.controller;
    if (!controller || !runtimeToken) return Promise.reject(normalizedError('NetworkError'));
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const sealed = Object.assign({}, message, { runtimeToken });
      channel.port1.onmessage = ev => {
        const data = ev.data || {};
        if (data.ok) resolve(data);
        else { const err = new Error(data.error || 'NetworkError'); err.code = data.error || 'NetworkError'; reject(err); }
      };
      controller.postMessage(sealed, transfer ? [channel.port2, ...transfer] : [channel.port2]);
    });
  }
  // SW keepalive — the controller dies after ~30s idle, and a restarted SW
  // comes back with EMPTY in-memory state (tabs/shareRoutes/clientContext).
  // After that every /zp/api/* transport fetch fails `!tab` → 503
  // SW_NOT_READY → dynamic import()s + membrane fetch/XHR all reject →
  // hydration stalls (the "검색창만 뜨고 흰화면" symptom). The worst gap is the
  // streamed document staying open ~60s while NAVER withholds END_STREAM: no
  // fetch activity flows in that window, so the SW idles out mid-load exactly
  // when the page still needs it. A bare ~15s postMessage resets the SW idle
  // timer (any received event does) so its tab state survives the whole load.
  // Bare post (no port / no runtimeToken) — we only need the wake, not a reply.
  let __zpKeepAliveTimer = null;
  function startSWKeepAlive() {
    if (__zpKeepAliveTimer) return;
    __zpKeepAliveTimer = setInterval(() => {
      const controller = Native.serviceWorkerController || (Native.serviceWorker && Native.serviceWorker.controller);
      if (!controller) return;
      try { controller.postMessage({ type: '__zpKeepAlive' }); } catch {}
    }, 15000);
  }
  startSWKeepAlive();
  // ★2026-08-23 — 압축 크기 수신. SW 가 응답마다 **요청한 클라이언트에게만**
  // 상류의 와이어 바이트 수를 보낸다. 이게 없으면 `encodedBodySize` 가 항상
  // decoded 와 같아져 모든 응답이 비압축처럼 보인다(타이밍 축 참조).
  const encodedSizes = new Map();
  try {
    const sw = Native.serviceWorker || (root.navigator && root.navigator.serviceWorker);
    if (sw && sw.addEventListener) {
      sw.addEventListener('message', (ev) => {
        const d = ev && ev.data;
        if (!d || d.type !== 'ZP_ENCODED_SIZE' || !d.url) return;
        encodedSizes.set(String(d.url), Number(d.size) || 0);
      });
    }
  } catch {}
  // ★문서는 밀려오지 않는다 — 내비게이션은 `resultingClientId` 라 SW 가
  // 스트림이 끝나는 시점에 아직 클라이언트를 잡지 못한다(실측).
  // 그래서 페이지가 **자기 URL 로** 물어본다 — 경쟁도 없고 새로 알려주는
  // 정보도 없다(자기 URL 은 이미 안다).
  function askDocumentEncodedSize(attempt) {
    postMessageToSW({ type: 'ZP_ENCODED_SIZE_QUERY', url: virtualURL.href })
      .then(reply => {
        const size = reply && Number(reply.size);
        if (size) { encodedSizes.set(virtualURL.href, size); return; }
        if (attempt < 6) setTimeout(() => askDocumentEncodedSize(attempt + 1), 400);
      })
      .catch(() => { if (attempt < 6) setTimeout(() => askDocumentEncodedSize(attempt + 1), 400); });
  }
  try { setTimeout(() => askDocumentEncodedSize(0), 300); } catch {}
  // 2026-08-13 — 이 문서의 clientId 를 SW 의 탭 컨텍스트에 등록한다.
  //
  // 최상위 문서는 내비게이션 요청 자체가 바인딩을 만들어 주지만, `srcdoc` /
  // `blob:` / `about:blank` 문서는 내비게이션이 없어 SW 가 그 클라이언트를
  // 어느 탭 소속인지 알 수 없다. 그러면 **최상위에서는 잘 나가는 URL 이**
  // 그 문서에서만 거절당한다. 프렐류드는 이런 문서에도 주입되므로 여기서
  // 한 번 등록해 두면 그 계층 차이가 사라진다.
  // controller 는 부팅 직후 아직 null 일 수 있으므로 몇 번 재시도한다 —
  // 한 번 실패하고 마는 것과 달리, 여기서 놓치면 그 문서의 서브리소스가
  // 전부 거절당하므로 조용한 실패의 대가가 크다.
  (function bindClientToTab(attempt) {
    if (!boot.tabId) return;
    postMessageToSW({ type: 'ZP_BIND_CLIENT', tabId: boot.tabId, entryId: boot.entryId })
      .catch(() => { if (attempt < 10) setTimeout(() => bindClientToTab(attempt + 1), 200); });
  })(0);
  // SW 가 거절한 요청 목록. 서브리소스 실패는 페이지 콘솔에 아무 흔적을
  // 남기지 않으므로, 프록시가 못 살려 준 것을 눈이 아니라 목록으로 본다.
  define(root, '__zp_refusals', function __zp_refusals() {
    return new Promise((resolve) => {
      const controller = Native.serviceWorkerController || (Native.serviceWorker && Native.serviceWorker.controller);
      if (!controller) { resolve([]); return; }
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve([]), 3000);
      channel.port1.onmessage = ev => { clearTimeout(timer); resolve((ev.data && ev.data.refusals) || []); };
      try { controller.postMessage({ type: '__zpRefusalDump' }, [channel.port2]); }
      catch { clearTimeout(timer); resolve([]); }
    });
  });
  function updateVirtualBase(raw) {
    try {
      const next = targetURL(raw, baseURL);
      baseURL = next;
      explicitBaseURL = next;
      postMessageToSW({ type: 'ZP_BASE_UPDATE', tabId: boot.tabId, entryId: activeEntryId, baseUrl: next }).catch(()=>{});
      return next;
    } catch {
      return baseURL;
    }
  }
  // <meta name="referrer"> 를 SW 에 알린다.
  //
  // 문서의 참조 정책은 응답 헤더로도, 이 meta 로도 선언된다. 우리는 헤더만
  // 보고 있었다 — 페이지가 부른 fetch 의 `Request.referrerPolicy` 는 빈
  // 문자열이라(문서 정책은 요청 객체에 반영되지 않는다) meta 로만 정책을
  // 선언한 페이지는 우리 쪽에서 기본값으로 떨어졌다. 브라우저가 직접 내는
  // 요청(이미지/스크립트)은 정확한데 페이지 fetch 만 어긋나는 비대칭이었다.
  //
  // 파싱 중에 늦게 나타나거나 나중에 바뀔 수 있으므로 부팅 시 한 번 + 문서가
  // 준비되면 한 번 더 읽는다. 마지막에 선언된 것이 이긴다(HTML 파싱 순서).
  // 문서에 선언된 참조 정책(`<meta name=referrer>`). 마지막 선언이 이긴다.
  // 요청마다 읽는다 — meta 는 파싱 도중 나타나거나 나중에 바뀔 수 있고,
  // fetch 는 그렇게 잦은 호출이 아니다.
  function documentReferrerPolicy() {
    try {
      const metas = Native.querySelectorAll.call(document, 'meta[name="referrer" i]');
      let policy = '';
      for (const m of metas) {
        const v = String(Native.getAttribute.call(m, 'content') || '').trim().toLowerCase();
        if (v) policy = v;
      }
      return policy;
    } catch { return ''; }
  }
  let lastReportedReferrerPolicy = null;
  function reportMetaReferrerPolicy() {
    try {
      const policy = documentReferrerPolicy();
      if (!policy || policy === lastReportedReferrerPolicy) return;
      lastReportedReferrerPolicy = policy;
      postMessageToSW({ type: 'ZP_REFERRER_POLICY', tabId: boot.tabId, entryId: activeEntryId, policy }).catch(() => {});
    } catch {}
  }

  function normalizePostMessageTargetOrigin(targetOrigin) {
    if (targetOrigin == null) return targetOrigin;
    const s = String(targetOrigin);
    if (s === '*' || s === '/') return s;
    try {
      const u = new URL(s);
      if (u.protocol === 'http:' || u.protocol === 'https:') return proxyOrigin;
    } catch {}
    return s;
  }
  // 자식이 스스로 멤브레인을 깔기 전까지의 빈 구간을 메운다. `configurable:
  // true` 로 두는 게 핵심 — 자식 prelude 가 자기 래퍼로 갈아끼울 수 있어야
  // 한다(부모 래퍼는 부모 realm 의 함수라 자식의 incumbent realm 을 바꾼다).
  // ★이 래퍼는 **부모 realm 함수**라, 붙어 있는 동안은 그 창을 거치는 모든
  // postMessage 의 incumbent realm 이 부모가 된다(자식의 self-post 는 source 가
  // 부모로, 손자→자식 메시지도 마찬가지). 그래서 **자식 prelude 가 뜨는 즉시
  // 네이티브로 되돌린다** — 되돌릴 수 있도록 원본을 래퍼에 달아 둔다.
  // 삭제로는 못 되돌린다: postMessage 는 Window **인스턴스의 소유 속성**이고
  // (측정: `Window.prototype.postMessage` 는 undefined) 지우면 네이티브까지
  // 같이 사라진다.
  const earlyNativeKey = '__zpEarlyNativePostMessage';
  function installEarlyPostMessage(childWin) {
    if (!childWin) return;
    try {
      // 자식이 **이미 자기 멤브레인을 깔았으면 손대지 않는다.** 이 래퍼는 부모
      // realm 함수라, 부팅이 끝난 창에 뒤늦게 덮으면 그 창의 self-post 와
      // 손자→자식 메시지의 e.source 가 부모로 뒤집힌 채 영영 남는다 — 자식은
      // 이미 복구 단계를 지났으므로 걷어 낼 사람이 없다. 실측(CNN): 프레임
      // 25개 중 2개가 이 순서로 걸려 postMessage.length 가 3 으로 남았다.
      // __zp_get 은 문자열 키 전역이라 교차 realm 에서도 보인다.
      if (typeof childWin.__zp_get === "function") return;
      const wrapped = postMessageWrapperFor(childWin);
      if (!wrapped) return;
      const cur = Object.getOwnPropertyDescriptor(childWin, 'postMessage');
      if (cur && !cur.configurable) return;
      if (cur && typeof cur.value === 'function') {
        try { Object.defineProperty(wrapped, earlyNativeKey, { value: cur.value, enumerable: false, configurable: true, writable: false }); } catch {}
      }
      Object.defineProperty(childWin, 'postMessage', { value: wrapped, enumerable: true, configurable: true, writable: true });
      maskNativeFunction(wrapped, 'postMessage');
    } catch {}
  }
  // 부모가 남긴 조기 래퍼를 걷어 낸다. 자기 realm 이 뜬 뒤에는 멤브레인 get
  // 트랩이 targetOrigin 매핑을 맡으므로 창 자신은 네이티브여야 한다.
  function restoreNativePostMessage(w) {
    try {
      const cur = Object.getOwnPropertyDescriptor(w, 'postMessage');
      const native = cur && typeof cur.value === 'function' ? cur.value[earlyNativeKey] : null;
      if (!native || !cur.configurable) return;
      Object.defineProperty(w, 'postMessage', { value: native, enumerable: true, configurable: true, writable: true });
    } catch {}
  }
  function postMessageWrapperFor(target) {
    if (!target || typeof target.postMessage !== 'function') return undefined;
    if (postMessageWrappers.has(target)) return postMessageWrappers.get(target);
    // .bind() 가 BoundFunction 의 realm 을 install-time realm (parent) 으로
    // 고정 → V8 의 message source 결정이 incumbent 가 아닌 bound function 의
    // realm 사용 → child iframe 이 parent.postMessage 호출 시 `e.source` 가
    // child 의 contentWindow 가 아닌 parent.window 가 됨. NAVER GFP SafeFrame
    // SDK 는 source === iframe.contentWindow 비교로 어느 광고 iframe 에서
    // resize 메시지 왔는지 식별 → 모든 광고 iframe height=0 으로 collapse.
    // .bind 대신 Reflect.apply 로 native 직접 호출하면 caller realm (child) 이
    // incumbent 로 보존되어 source 가 정확히 dispatched 됨.
    const originalPm = target.postMessage;
    // mapped === '*' (caller 가 '*' 또는 변환 필요 없는 케이스) 면 source 보존을
    // 위해 wrap 우회 — caller 가 native postMessage 직접 호출하도록 return
    // origin pm 그대로. 단, mapped !== targetOrigin (virtual → real 변환됨)
    // 케이스만 wrap 통해 변환 + native call.
    const wrapped = function postMessage(message, targetOrigin, transfer) {
      const mapped = arguments.length < 2 ? proxyOrigin : normalizePostMessageTargetOrigin(targetOrigin);
      return arguments.length > 2 ? Reflect.apply(originalPm, target, [message, mapped, transfer]) : Reflect.apply(originalPm, target, [message, mapped]);
    };
    maskNativeFunction(wrapped, 'postMessage');
    postMessageWrappers.set(target, wrapped);
    return wrapped;
  }
  function virtualOriginForMessage(ev) {
    if (!ev || ev.origin !== proxyOrigin || !ev.source) return '';
    try {
      const origin = frameWindowOrigins.get(ev.source) || ev.source[frameTargetOriginMarker];
      return origin || '';
    } catch {
      return '';
    }
  }
  // source 는 **엔진이 준 것을 그대로 쓴다.** 예전에는 sender 큐로 정정했는데,
  // 그 정정이 필요했던 이유는 우리가 창의 postMessage 를 부모 realm 래퍼로
  // 갈아끼워 incumbent realm 을 망가뜨렸기 때문이다. 그 원인을 없앴으므로
  // (rewriter.md#postmessage-incumbent) 정정 장치도 함께 지운다 — 남겨 두면
  // 다음 사람이 "이미 처리돼 있네" 로 오해한다. 여기서 하는 일은 오리진
  // 가상화 하나뿐이다.
  function virtualizeMessageEvent(ev) {
    // Hot path fast-exit: 프록시 오리진이 아니면 virtualOriginForMessage 가
    // 어차피 '' 를 준다. 함수 호출 + 객체 alloc 회피.
    if (ev.origin !== proxyOrigin) return ev;
    const origin = virtualOriginForMessage(ev);
    if (!origin) return ev;
    try {
      return new MessageEvent(ev.type, { data: ev.data, origin, lastEventId: ev.lastEventId || '', source: ev.source, ports: ev.ports || [] });
    } catch {
      try {
        const clone = Object.create(ev);
        Object.defineProperty(clone, 'origin', { value: origin, configurable: true });
        return clone;
      } catch {
        return ev;
      }
    }
  }
  function rememberFrameOrigin(frame) {
    if (!frame) return;
    let target = '';
    try { target = urlMeta.get(frame) || Native.getAttribute.call(frame, 'data-zp-target-url') || ''; } catch {}
    if (!target) return;
    try {
      const child = frame.contentWindow;
      if (child) frameWindowOrigins.set(child, new URL(target).origin);
    } catch {}
  }
  try { Object.defineProperty(root, frameTargetOriginMarker, { get() { return virtualURL.origin; }, enumerable: false, configurable: false }); } catch {}
  function __zpStep(name, fn) {
    zpTrace('install:' + name + ':start');
    try { fn(); zpTrace('install:' + name + ':done'); }
    catch (e) { zpTrace('install:' + name + ':err', String(e && e.message || e).slice(0, 200)); throw e; }
  }
  __zpStep('ToStringMasking', () => installToStringMasking(root));
  define(root, '__ZP_SET_BASE', updateVirtualBase);
  __zpStep('Phase2Membrane', installPhase2Membrane);

  __zpStep('WebSocket', installWebSocket);
  __zpStep('WebSocketStream', installWebSocketStream);
  __zpStep('HTTPAPIs', installHTTPAPIs);
  __zpStep('Beacon', installBeacon);
  __zpStep('NavigationTraps', installNavigationTraps);
  __zpStep('PopupHooks', () => installPopupHooks(root));
  __zpStep('PostMessageHooks', () => installPostMessageHooks(root));
  __zpStep('NavigatorIdentity', () => installNavigatorIdentity(root));
  __zpStep('GetterMasking', () => installGetterMasking(root));
  __zpStep('StorageFacades', () => installStorageFacades(root));
  __zpStep('DOMHooks', () => installDOMHooks(root));
  __zpStep('StealthMembrane', () => installStealthMembrane(root));
  __zpStep('WorkerHooks', installWorkerHooks);
  __zpStep('TargetServiceWorkerBlocker', () => installTargetServiceWorkerBlocker(root));
  __zpStep('IframeHooks', () => installIframeHooks(root));
  __zpStep('Blockers', () => installBlockers(root));
  __zpStep('CanvasAntiFingerprinting', () => installCanvasAntiFingerprinting(root));
  __zpStep('AudioAntiFingerprinting', () => installAudioAntiFingerprinting(root));
  __zpStep('NavigationBackstop', () => installNavigationBackstop(root, root.document && root.document.documentElement));
  zpTrace('install:all:done');
  // Modal-dialog override — synchronous alert/confirm/prompt block the
  // main thread until the browser shell dismisses them. In headless /
  // automated contexts the shell never dismisses, so any site that fires
  // a modal mid-init wedges CDP itself (CPU 0% but every JS evaluate
  // times out). Log via zpTrace and return safe defaults instead of
  // calling native. Same treatment for window.print (also synchronous).
  try {
    if (typeof root.alert === 'function') {
      define(root, 'alert', function alert(msg) { try { zpTrace('alert', String(msg||'').slice(0,200)); } catch {} });
    }
    if (typeof root.confirm === 'function') {
      define(root, 'confirm', function confirm(msg) { try { zpTrace('confirm', String(msg||'').slice(0,200)); } catch {} return false; });
    }
    if (typeof root.prompt === 'function') {
      define(root, 'prompt', function prompt(msg, def) { try { zpTrace('prompt', String(msg||'').slice(0,200)); } catch {} return null; });
    }
    if (typeof root.print === 'function') {
      define(root, 'print', function print() { try { zpTrace('print'); } catch {} });
    }
  } catch {}
  // Diagnostic-only WebAssembly trace — wrap top-level WebAssembly.* methods
  // so we can see WTM/anti-bot WASM loads in the post-mortem trace.
  try {
    const WA = root.WebAssembly;
    if (WA) {
      const orig = {
        instantiate: WA.instantiate && WA.instantiate.bind(WA),
        instantiateStreaming: WA.instantiateStreaming && WA.instantiateStreaming.bind(WA),
        compile: WA.compile && WA.compile.bind(WA),
        compileStreaming: WA.compileStreaming && WA.compileStreaming.bind(WA),
      };
      if (orig.instantiate) WA.instantiate = function(...a) { try { zpTrace('wasm:instantiate', a[0] && a[0].byteLength ? 'buf:'+a[0].byteLength : typeof a[0]); } catch {} return orig.instantiate(...a).then(r => { try { zpTrace('wasm:instantiate:ok'); } catch {} return r; }, e => { try { zpTrace('wasm:instantiate:err', String(e).slice(0,120)); } catch {} throw e; }); };
      if (orig.instantiateStreaming) WA.instantiateStreaming = function(...a) { try { zpTrace('wasm:instStream', (a[0] && a[0].url) || 'src'); } catch {} return orig.instantiateStreaming(...a).then(r => { try { zpTrace('wasm:instStream:ok'); } catch {} return r; }, e => { try { zpTrace('wasm:instStream:err', String(e).slice(0,120)); } catch {} throw e; }); };
      if (orig.compileStreaming) WA.compileStreaming = function(...a) { try { zpTrace('wasm:compileStream'); } catch {} return orig.compileStreaming(...a).then(r => { try { zpTrace('wasm:compileStream:ok'); } catch {} return r; }, e => { try { zpTrace('wasm:compileStream:err', String(e).slice(0,120)); } catch {} throw e; }); };
    }
  } catch {}


  function installPhase2Membrane() {
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
    // 한계: body 안의 `new.target` 은 항상 undefined 다. 안쪽 함수를 apply 로
    // 부르기 때문. 동적 Function body 에서 new.target 을 읽는 코드는 실측한 적
    // 없어 이 대가를 받아들인다.
    function compileNested(params, body, kind) {
      try { zpTrace('compile', String(body || '').slice(0, 100)); } catch {}
      const inner = functionPrefix(kind) + ' __zp_dyn__(' + params.join(',') + '\n) {\n'
        + rewriteDynamicFunctionBody(params, body, kind) + '\n}';
      // 안쪽 함수는 with **안에서** 만들어야 자유 식별자가 스코프 프록시를
      // 거치고, `.apply` 는 with **바깥에서** 해야 한다: `__zp_args` 도 결국
      // 이름이라 with 안에서는 has 트랩에 가려져 undefined 가 된다 (이 함정을
      // 한 번 밟았다 — 파라미터는 살아났는데 arguments 가 비어 있었다).
      // IIFE 가 클로저째로 with 스코프를 들고 나온다.
      const src = 'return (function(){\nwith(__zp_scope){\nreturn (' + inner + ');\n}\n})().apply(this, __zp_args);';
      return Reflect.construct(Native.FunctionCtor, ['__zp_scope', '__zp_args', src]);
    }
    function nestedCall(compiled, thisArg, callArgs, newTarget) {
      const argv = [withScope, callArgs];
      return newTarget ? Reflect.construct(compiled, argv, newTarget) : Reflect.apply(compiled, thisArg, argv);
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
      let fn;
      if (kind === 'async') {
        fn = async function anonymous(...callArgs) { return nestedCall(compiled, this, callArgs); };
      } else if (kind === 'generator') {
        fn = function* anonymous(...callArgs) { return yield* nestedCall(compiled, this, callArgs); };
      } else if (kind === 'asyncGenerator') {
        fn = async function* anonymous(...callArgs) { return yield* nestedCall(compiled, this, callArgs); };
      } else {
        fn = function anonymous(...callArgs) { return nestedCall(compiled, this, callArgs, new.target); };
      }
      toStringMap.set(fn, dynamicSource(kind, params, body));
      return fn;
    }
    function isEvalExpressionCandidate(text) {
      return !/^(?:function|class|var|let|const|if|for|while|do|switch|try|throw|return|break|continue|with|import|export|debugger)\b/.test(text.trimStart());
    }
    function dynamicEval(source) {
      if (arguments.length === 0) return undefined;
      const text = String(source);
      let expr = null;
      if (isEvalExpressionCandidate(text)) {
        try { expr = Reflect.construct(Native.FunctionCtor, ['__zp_scope', 'with(__zp_scope){return (' + text + '\n);}']); } catch {}
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
        if (typeof globalCode === 'string' && globalCode.length) return execGlobalScript(globalCode);
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
      return null;
    }
    // Inherit Location.prototype so `virtualLocation instanceof Location`
    // returns true. Without this, GitHub's React-Lib `instanceof Location`
    // check during hydration fails → React error #519 (multiple hydration
    // diffs in a pass) → ErrorPage fallback render. Other sites (Wikipedia,
    // NAVER) don't notice because they don't do this specific check.
    const LocationProtoBase = (root.Location && root.Location.prototype) || null;
    const virtualLocation = LocationProtoBase ? Object.create(LocationProtoBase) : {};
    Object.defineProperties(virtualLocation, {
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
    const locToString = function(){ return virtualURL.href; };
    const locAssign = function(v){ setVirtualLocation(v); };
    const locReplace = function(v){ setVirtualLocation(v, true); };
    const locReload = function(){ Native.locationReload && Native.locationReload(); };
    function wrappedLocationFor(nativeLoc) {
      const cached = wrappedLocationCache.get(nativeLoc);
      if (cached) return cached;
      const methodCache = new Map();
      const handler = {
        get(target, prop) {
          if (typeof prop === 'string' && LOC_VIRT_PROPS.has(prop)) return virtualURL[prop];
          if (prop === 'toString') return locToString;
          if (prop === 'assign') return locAssign;
          if (prop === 'replace') return locReplace;
          if (prop === 'reload') return locReload;
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
          if (prop === 'href') { setVirtualLocation(value); return true; }
          if (prop === 'hash') { updateVirtualHash(value); return true; }
          if (typeof prop === 'string' && LOC_ALL_URL_PROPS.has(prop)) {
            try { const u = new URL(virtualURL.href); u[prop] = value; setVirtualLocation(u.href); } catch {}
            return true;
          }
          return Reflect.set(nativeLoc, prop, value, nativeLoc);
        },
        has(_t, prop) { return Reflect.has(nativeLoc, prop); },
        ownKeys() { return Reflect.ownKeys(nativeLoc); },
        getOwnPropertyDescriptor(_t, prop) {
          // Virtualized URL props: live value, always configurable.
          if (typeof prop === 'string' && LOC_VIRT_PROPS.has(prop)) {
            return { value: virtualURL[prop], writable: true, enumerable: true, configurable: true };
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
    // 사슬 한 칸 위로. 못 읽거나 자기 자신이면 제자리에 머문다(끝에 도달한 것).
    function climbCrossWindow(targetWindow, prop, fallback) {
      try {
        const next = targetWindow[prop];
        if (next && next !== targetWindow) return safeCrossWindow(next);
      } catch {}
      return fallback;
    }
    function safeCrossWindow(targetWindow) {
      if (!targetWindow || targetWindow === root) return scope;
      if (crossWindowProxyCache.has(targetWindow)) return crossWindowProxyCache.get(targetWindow);
      const proxy = {};
      Object.defineProperties(proxy, {
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
        location: { get() { return virtualLocation; }, enumerable: true },
        postMessage: { value: postMessageWrapperFor(targetWindow), enumerable: true }
      });
      crossWindowProxyCache.set(targetWindow, proxy);
      return proxy;
    }
    function virtualWindowProperty(target, prop) {
      if (prop === 'top' || prop === 'parent' || prop === 'opener') {
        try {
          const child = target[prop];
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
    const scopeTraps = {
      has(target, prop) {
        if (prop === Symbol.unscopables) return false;
        return Reflect.has(target, prop);
      },
      get(target, prop) {
        if (prop === Symbol.unscopables) return undefined;
        if (prop === 'window' || prop === 'self' || prop === 'globalThis' || prop === 'frames') return scope;
        if (prop === 'top' || prop === 'parent' || prop === 'opener') return virtualWindowProperty(target, prop);
        if (prop === 'location') {
          try { const n = target.location; return n ? wrappedLocationFor(n) : virtualLocation; } catch { return virtualLocation; }
        }
        if (prop === 'postMessage') return postMessageWrapperFor(target);
        const dynamic = typeof prop === 'symbol' ? null : dynamicGlobal(String(prop));
        if (dynamic) return dynamic;
        if (WINDOW_BOUND_METHODS.has(prop)) return boundWindowMethod(target, prop);
        return target[prop];
      },
      set(target, prop, value) {
        if (prop === 'location') { setVirtualLocation(value); return true; }
        target[prop] = value;
        return true;
      },
      getOwnPropertyDescriptor(target, prop) {
        if (prop === 'location') {
          try { return Reflect.getOwnPropertyDescriptor(target, prop); }
          catch { return { value: virtualLocation, configurable: true, enumerable: true, writable: false }; }
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      }
    };
    // 페이지에 window/globalThis/self/frames 로 노출되는 프록시.
    const scope = new Proxy(root, scopeTraps);
    // `with(__zp_scope){…}` 의 피연산자 전용. 여기서는 has 가 **반드시** 모든
    // 이름에 true 여야 한다 — 그래야 블록 안의 모든 식별자가 이 객체를 거치고,
    // 해석되지 않은 이름이 진짜 전역 스코프로 새어나가 멤브레인을 우회하지
    // 못한다. 페이지 코드에 이 객체가 직접 새지는 않는다: get 트랩이
    // window/globalThis/self/frames 에 대해 `scope` 를 돌려주기 때문이다.
    const withScope = new Proxy(root, Object.assign({}, scopeTraps, {
      has(_target, prop) { return prop !== Symbol.unscopables; },
    }));
    function isScopeProxy(value) { return value === scope || value === withScope; }
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
      if (base === document && prop === 'location') return virtualLocation;
      if (base === document && (prop === 'URL' || prop === 'documentURI')) return virtualURL.href;
      if (base === document && prop === 'baseURI') return baseURL;
      if (base === document && prop === 'referrer') return '';
      if (isWindowLike(base)) {
        if (prop === 'window' || prop === 'self' || prop === 'globalThis' || prop === 'frames') return isScopeProxy(base) || base === root ? scope : base;
        if (prop === 'top' || prop === 'parent' || prop === 'opener') return isScopeProxy(base) || base === root ? virtualWindowProperty(root, prop) : base;
        if (prop === 'location') {
          const baseWin = isScopeProxy(base) || base === root ? root : base;
          try { const n = baseWin.location; return n ? wrappedLocationFor(n) : virtualLocation; } catch { return virtualLocation; }
        }
        if (prop === 'postMessage') return postMessageWrapperFor(isScopeProxy(base) ? root : base);
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
      return Reflect.get(Object(base), prop);
    }
    function set(base, prop, value) {
      if (typeof prop !== 'symbol') prop = String(prop);
      if (((isWindowLike(base) || base === document) && prop === 'location') || (base === virtualLocation && prop === 'href')) { setVirtualLocation(value); return value; }
      if (base === virtualLocation && prop === 'hash') { updateVirtualHash(value); return value; }
      Reflect.set(Object(base), prop, value);
      return value;
    }
    function assign(base, prop, operator, value) {
      if (typeof prop !== 'symbol') prop = String(prop);
      const current = get(base, prop);
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
    function has(base, prop) { if ((isWindowLike(base) || base === document) && prop === 'location') return true; return Reflect.has(Object(base), prop); }
    function getOwnPropertyDescriptor(base, prop) {
      // 서술자로 우회해 진짜 게터를 꺼내 가는 길도 막는다 — 여기서 진짜 접근자를
      // 돌려주면 `gopd(document,'location').get.call(document)` 한 줄로 프록시
      // 주소가 새어 나간다.
      if ((isWindowLike(base) || base === document) && prop === 'location') return { value: virtualLocation, configurable: true, enumerable: true, writable: false };
      return Reflect.getOwnPropertyDescriptor(Object(base), prop);
    }
    function ownKeys(base) { return Reflect.ownKeys(Object(base)); }
    function moduleURL(specifier, referrer) {
      const spec = String(specifier);
      if (!spec.startsWith('/') && !spec.startsWith('./') && !spec.startsWith('../') && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec)) throw normalizedError('TypeError');
      const u = new URL(spec, referrer || baseURL);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw normalizedError('NotSupportedError');
      return scriptProxyPath(u.href, 'module');
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
    // Known remaining gap: top-level `let`/`const`/`class` land in the eval's
    // own lexical scope rather than the shared global lexical scope, so they
    // stay invisible to later scripts. Legacy cross-script globals are
    // `var`/`function`, which this covers.
    function execGlobalScript(code) {
      const geval = Native.globalEval;
      if (geval) return geval(code);
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
        Object.defineProperty(ctor.prototype, 'constructor', {
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
    if (Native.DOMParserParseFromString && root.DOMParser) define(root.DOMParser.prototype, 'parseFromString', function(markup, type) { return Native.DOMParserParseFromString.call(this, String(type).toLowerCase() === 'text/html' ? transformHTML(String(markup)) : markup, type); });
    if (Native.rangeCreateContextualFragment && root.Range) define(root.Range.prototype, 'createContextualFragment', function(markup) { return Native.rangeCreateContextualFragment.call(this, transformHTML(String(markup))); });
  }
  function requestTargetURL(input) {
    const raw = input && typeof input === 'object' && typeof input.url === 'string' ? input.url : String(input);
    const gated = unleakedTargetRaw(raw);
    if (gated === null) return virtualURL.href;
    const parsed = new URL(gated, baseURL);
    if (parsed.origin === proxyOrigin) return new URL(parsed.pathname + parsed.search + parsed.hash, baseURL).href;
    return ZP.canonicalTargetURL(parsed.href, baseURL).href;
  }
  async function requestBodyBase64(req) {
    if (req.method === 'GET' || req.method === 'HEAD') return null;
    const ab = await req.clone().arrayBuffer();
    return ZP.bytesToBase64Url(new Uint8Array(ab));
  }
  // blob: / data: 는 브라우저가 그 자리에서 푸는 **인라인 리소스**다. 타깃이
  // 없으니 프록시로 보낼 것도 없고, 보내면 페이지가 넣은 내용 대신 우리 응답이
  // 돌아온다 — 실측(2026-08-26): fetch(URL.createObjectURL(new Blob(["HELLO"])))
  // 이 HELLO 대신 프록시 HTML 을 돌려줬다. 페이지가 자기가 만든 데이터를 다시
  // 읽는 흔한 패턴(파일 미리보기, 워커 없는 파서, 캔버스 내보내기)이 통째로
  // 깨진다. 둘 다 인라인이라 우회 통로가 되지 않는다.
  function inlineSchemeFetchURL(input) {
    try {
      const href = typeof input === 'string' ? input
        : (input && typeof input === 'object' && typeof input.url === 'string') ? input.url
        : String(input);
      return /^(?:blob|data):/i.test(String(href).trim()) ? String(href).trim() : null;
    } catch { return null; }
  }
  async function fetchThroughRuntime(input, init = {}) {
    if (!Native.fetch || !Native.Request || !Native.Headers) throw normalizedError('NetworkError');
    // 인라인 스킴은 브라우저에게 그대로 넘긴다 (위 주석 참고).
    if (inlineSchemeFetchURL(input)) return Native.fetch(input, init);
    const target = requestTargetURL(input);
    try { zpTrace('fetch', target.slice(0, 180)); } catch {}
    const req = input && typeof input === 'object' && typeof input.url === 'string' && typeof input.clone === 'function' ? new Native.Request(input, init) : new Native.Request(target, init);
    // Capture before reading a body: history/base may change while that read awaits.
    const requestEntryId = activeEntryId;
    const documentURL = virtualURL.href;
    const referrerPolicy = req.referrerPolicy || documentReferrerPolicy();
    const payload = {
      tabId: boot.tabId,
      entryId: requestEntryId,
      documentURL,
      url: target,
      init: {
        method: req.method,
        headers: Array.from(req.headers.entries()),
        body: await requestBodyBase64(req),
        credentials: req.credentials,
        mode: req.mode,
        referrer: req.referrer,
        // 페이지가 `fetch(u, { referrerPolicy })` 로 명시한 값. SW 는
        // /zp/api/fetch 요청에 대해 브라우저가 계산한 정책을 볼 수 없으므로
        // (그 요청의 정책은 프록시 문서의 것이다) 여기서 넘겨준다.
        //
        // 명시가 없으면 **문서의 정책**을 여기서 읽어 채운다. `<meta
        // name=referrer>` 로만 선언한 문서가 그렇다 — 문서 정책은 Request
        // 객체에 반영되지 않으므로(`req.referrerPolicy` 가 빈 문자열) 이 자리를
        // 비워 두면 SW 는 기본값으로 떨어진다. 실측(로컬 픽스처): meta 가
        // no-referrer/origin 이어도 프록시만 전체 URL 을 보냈다.
        //
        // 메시지로 미리 알려 주는 경로(ZP_REFERRER_POLICY)만으로는 부족하다 —
        // 페이지의 첫 fetch 는 파싱 도중에 나가서 그 메시지보다 **빠르다.**
        referrerPolicy,
        redirect: req.redirect,
        cache: req.cache,
        integrity: req.integrity
      }
    };
    const apiInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
    if (req.signal) apiInit.signal = req.signal;
    // Absolute proxy URL — virtual baseURI resolves root-relative paths
    // against the target host. See scriptProxyPath for the companion bug.
    // The target also rides in the query string even though the SW reads it
    // from the JSON body. Without it every membrane fetch produced a resource
    // timing entry named exactly `<proxy>/zp/api/fetch`, which (a) is
    // indistinguishable between requests and (b) carries no target, so the
    // de-proxy getter on `PerformanceEntry.name` cannot recover one. NAVER's
    // ad SDK locates itself through resource timing and then resolved
    // `./gfp-display-sdk.js` against that bare path — producing a 404 on
    // `<proxy>/zp/api/gfp-display-sdk.js`. Routing is unaffected: the SW
    // matches on `url.pathname` only.
    // 인코더는 subresourceProxyPath 와 공유한다. 프래그먼트/`&tab=` 은 여기에
    // 없는 게 맞다 — 이 URL 은 **라벨**이고(SW 는 pathname 으로만 라우팅하고
    // 타깃은 JSON 바디에서 읽는다) fetch 는 프래그먼트를 어차피 버린다.
    const apiURL = proxyOrigin + ZP.apiPath('fetch') + '?url=' + encodeURLParam(target);
    return Native.fetch(apiURL, apiInit).then(r => {
      try { zpTrace('fetch:ok', target.slice(0,80) + ' s=' + r.status); } catch {}
      return decodeFetchResponse(r);
    }, e => { try { zpTrace('fetch:err', target.slice(0,80) + ' ' + String(e).slice(0,60)); } catch {} throw e; });
  }
  function fireEvent(target, type) {
    let ev;
    try { ev = new Event(type); } catch { ev = { type }; }
    return target.dispatchEvent(ev);
  }
  function installHTTPAPIs() {
    if (Native.Response) decodeFetchResponse = ZP.createFetchResponseAdapter(Native.Response, Native.Headers, defineAccessor, define);
    if (Native.fetch && Native.Request && Native.Headers) define(root, 'fetch', function fetch(input, init) { return fetchThroughRuntime(input, init); });
    if (Native.XMLHttpRequest && Native.fetch && Native.Request && Native.Headers) {
      const UNSENT = 0, OPENED = 1, HEADERS_RECEIVED = 2, LOADING = 3, DONE = 4;
      function ZPXMLHttpRequest() {
        this.readyState = UNSENT;
        this.response = this.responseText = '';
        // Native defaults are null, not undefined — the accessors added below
        // would otherwise report `undefined` for an untouched request.
        this.responseXML = null;
        this.onreadystatechange = null;
        this.responseType = '';
        this.responseURL = '';
        this.status = 0;
        this.statusText = '';
        this.timeout = 0;
        this.withCredentials = false;
        this.upload = {};
        this._headers = [];
        this._responseHeaders = null;
        this._method = 'GET';
        this._url = '';
        this._sent = false;
        this._controller = null;
        this._timer = 0;
      }
      function xhrReady(xhr, state) {
        xhr.readyState = state;
        fireEvent(xhr, 'readystatechange');
      }
      function xhrDone(xhr, type) {
        clearTimeout(xhr._timer);
        xhr._timer = 0;
        xhrReady(xhr, DONE);
        fireEvent(xhr, type);
        fireEvent(xhr, 'loadend');
      }
      installEventMethods(ZPXMLHttpRequest.prototype);
      // Native XHR exposes its state as PROTOTYPE accessors, not instance data
      // properties. We wrote them straight onto the instance, so
      // `XMLHttpRequest.prototype` carried 16 names where Chrome has 27
      // (measured 2026-08-02) — both a loud proxy tell and a real compat break:
      // `'readyState' in XMLHttpRequest.prototype` was false, and any library
      // that wraps `XMLHttpRequest.prototype.responseText` (analytics shims,
      // mocking libs) saw nothing to wrap.
      //
      // Backing them with `_zp`-prefixed fields keeps every existing
      // `this.readyState = …` write working — the assignment now routes through
      // the setter instead of creating an own property, so instance shape gets
      // closer to native too. defineAccessor masks the pair's toString.
      for (const _n of ['readyState', 'response', 'responseText', 'responseXML', 'responseType',
        'responseURL', 'status', 'statusText', 'timeout', 'withCredentials', 'upload',
        'onreadystatechange']) {
        const _k = '_zp' + _n;
        defineAccessor(ZPXMLHttpRequest.prototype, _n,
          function () { return this[_k]; },
          function (v) { this[_k] = v; },
          Native.XMLHttpRequest && Native.XMLHttpRequest.prototype);
      }
      // 동기 XHR 을 same-origin 중계로 보낸다.
      //
      // 네이티브 XHR 을 쓰되 **목적지는 우리 origin** 이다. 타깃 URL 은 쿼리로
      // 넘기고, Go 가 그 응답을 park 한 채 SW 에 일을 시킨다. 브라우저가 타깃으로
      // 직접 나가는 일이 없으므로 IP 가 새지 않는다(그게 원래 차단의 이유였다).
      // 쿠키는 여기서 다루지 않는다 — 기존 경로대로 커널의 jar 가 붙인다.
      function sendSyncThroughRelay(xhr, body) {
        xhr._sent = true;
        try {
          const rid = 'sx' + ZP.randomId();
          let u = proxyOrigin + ZP.apiPath('sync-fetch')
            + '?rid=' + encodeURIComponent(rid)
            + '&u=' + encodeURIComponent(xhr._url)
            + '&m=' + encodeURIComponent(xhr._method)
            + '&tab=' + encodeURIComponent(boot.tabId || '')
            + '&entry=' + encodeURIComponent(activeEntryId || '');
          for (const kv of xhr._headers) u += '&h=' + encodeURIComponent(kv[0] + ':' + kv[1]);

          const nx = new Native.XMLHttpRequest();
          nx.open(xhr._method, u, false);
          if (xhr.responseType === 'arraybuffer' || xhr.responseType === 'blob') {
            // 동기 XHR 은 responseType 을 못 바꾼다(스펙). 텍스트로 받고 아래에서 변환.
          }
          nx.send(body != null && xhr._method !== 'GET' && xhr._method !== 'HEAD' ? body : null);

          xhr.status = nx.status;
          xhr.statusText = nx.statusText || '';
          try {
            const h = new Native.Headers();
            String(nx.getAllResponseHeaders() || '').split(/\r?\n/).forEach(line => {
              const i = line.indexOf(':');
              if (i > 0) { try { h.append(line.slice(0, i).trim(), line.slice(i + 1).trim()); } catch {} }
            });
            xhr._responseHeaders = h;
          } catch {}
          xhrReady(xhr, HEADERS_RECEIVED);
          xhrReady(xhr, LOADING);
          xhr.responseText = nx.responseText || '';
          if (xhr.responseType === 'json') {
            try { xhr.response = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { xhr.response = null; }
          } else {
            xhr.response = xhr.responseText;
          }
          xhr._sent = false;
          xhrDone(xhr, 'load');
        } catch (e) {
          xhr._sent = false;
          xhr.status = 0;
          xhr.statusText = '';
          try {
            const diag = root.__zp_diagnostics;
            if (diag && diag.length < 200) diag.push({
              t: 'sync-xhr-relay-failed',
              url: String(xhr._url || '').slice(0, 160),
              msg: String((e && e.message) || e).slice(0, 120),
            });
          } catch {}
          xhrDone(xhr, 'error');
        }
      }
      // readyState 상수는 실제 브라우저에서 **쓰기도 재정의도 불가**하다
      // (`{value, enumerable: true, writable: false, configurable: false}`).
      // Object.assign 으로 얹으면 writable+configurable 이 되어 실제보다 무르고,
      // 디스크립터 모양 대조에 그대로 잡힌다(실측 2026-08-16: 직접 `D-e-` vs
      // 프록시 `Dcew`). 상수만 따로 심는다.
      for (const [k, v] of [['UNSENT', UNSENT], ['OPENED', OPENED], ['HEADERS_RECEIVED', HEADERS_RECEIVED], ['LOADING', LOADING], ['DONE', DONE]]) {
        try { Object.defineProperty(ZPXMLHttpRequest.prototype, k, { value: v, enumerable: true, writable: false, configurable: false }); } catch {}
        try { Object.defineProperty(ZPXMLHttpRequest, k, { value: v, enumerable: true, writable: false, configurable: false }); } catch {}
      }
      Object.assign(ZPXMLHttpRequest.prototype, {
        constructor: ZPXMLHttpRequest,
        // Chrome-only Privacy Sandbox hooks. We do not implement either — the
        // proxy never forwards attribution or private-token material — but
        // their ABSENCE is itself a fingerprint (XHR.prototype 25 vs 27), and
        // `xhr.setPrivateToken` throwing "not a function" reads differently
        // from a browser that has the method. Accept-and-ignore matches what a
        // browser does when the feature is disabled by policy.
        setAttributionReporting() {},
        setPrivateToken() {},
        open(method, url, async = true, user, password) {
          // 2026-08-13 — 동기 XHR 을 **감옥 안에서** 지원한다.
          //
          // Service Worker 는 동기 XHR 을 가로채지 못한다(실측: 같은 페이지·같은
          // URL 에서 동기 XHR 은 Go 까지 내려가 403, 비동기 fetch 는 SW 가 503).
          // 그래서 예전에는 그냥 막았는데, NAVER 캡차가 UI(`rcaptUi`)·문제
          // (`question`)·**JS 토큰 검증**(`verifyJs`)을 전부 동기 XHR 로 가져오는
          // 탓에 답이 맞아도 "틀렸다" 가 나왔다(진단 버퍼로 확인).
          //
          // 이제는 same-origin 중계 엔드포인트로 던진다. Go 는 그 응답을 park 한 채
          // SW 에 작업을 넘기고, 실제 전송은 기존 `transportFetch` 가 한다 —
          // 브라우저가 타깃으로 직접 나가지 않으므로 감옥은 그대로다.
          this._sync = (async === false);
          this.abort();
          this._method = String(method || 'GET').toUpperCase();
          const target = new URL(requestTargetURL(url));
          if (user != null) target.username = String(user);
          if (password != null) target.password = String(password);
          this._url = target.href;
          this.responseURL = this._url;
          this._headers = [];
          this._responseHeaders = null;
          this.status = 0;
          this.statusText = '';
          this.response = this.responseText = '';
          xhrReady(this, OPENED);
        },
        setRequestHeader(name, value) {
          if (this.readyState !== OPENED || this._sent) throw normalizedError('InvalidStateError');
          this._headers.push([String(name), String(value)]);
        },
        send(body = null) {
          if (this.readyState !== OPENED || this._sent) throw normalizedError('InvalidStateError');
          if (this._sync) return sendSyncThroughRelay(this, body);
          this._sent = true;
          this._controller = new AbortController();
          const init = { method: this._method, headers: this._headers, credentials: this.withCredentials ? 'include' : 'same-origin', signal: this._controller.signal };
          if (body != null && this._method !== 'GET' && this._method !== 'HEAD') init.body = body;
          if (this.timeout > 0) this._timer = setTimeout(() => { try { this._controller.abort(); } catch {} this._sent = false; xhrDone(this, 'timeout'); }, this.timeout);
          fetchThroughRuntime(this._url, init).then(async resp => {
            if (!this._sent) return;
            this.status = resp.status;
            this.statusText = resp.statusText;
            this.responseURL = resp.url || this._url;
            this._responseHeaders = resp.headers;
            xhrReady(this, HEADERS_RECEIVED);
            xhrReady(this, LOADING);
            if (this.responseType === 'arraybuffer') this.response = await resp.arrayBuffer();
            else if (this.responseType === 'blob') this.response = await resp.blob();
            else if (this.responseType === 'json') { const text = await resp.text(); try { this.response = text ? JSON.parse(text) : null; } catch { this.response = null; } }
            else { this.responseText = await resp.text(); this.response = this.responseText; }
            this._sent = false;
            xhrDone(this, 'load');
          }).catch(() => {
            if (!this._sent) return;
            this._sent = false;
            this.status = 0;
            this.statusText = '';
            xhrDone(this, 'error');
          });
        },
        abort() {
          if (this._controller) { try { this._controller.abort(); } catch {} }
          clearTimeout(this._timer);
          this._timer = 0;
          const active = this._sent;
          this._sent = false;
          this._controller = null;
          if (active) xhrDone(this, 'abort');
        },
        getResponseHeader(name) { return this._responseHeaders ? this._responseHeaders.get(String(name)) : null; },
        getAllResponseHeaders() { if (!this._responseHeaders) return ''; let out = ''; this._responseHeaders.forEach((v, k) => { out += k + ': ' + v + '\r\n'; }); return out; },
        overrideMimeType() {}
      });
      maskMethods(ZPXMLHttpRequest.prototype, ['open','setRequestHeader','send','abort','getResponseHeader','getAllResponseHeaders','overrideMimeType']);
      brandLikeNative(ZPXMLHttpRequest, ZPXMLHttpRequest.prototype, 'XMLHttpRequest');
      define(root, 'XMLHttpRequest', ZPXMLHttpRequest);
    }
    if (Native.EventSource && Native.fetch && Native.Request && Native.Headers) {
      // B4: EventSource fidelity. WHATWG HTML SSE §9.2 — auto-reconnect after
      // soft transport errors with the server-supplied `retry:` interval,
      // Last-Event-ID echo on reconnect, Content-Type enforcement, 204 clean
      // close, non-2xx hard fail (no reconnect).
      const CONNECTING = 0, OPEN = 1, CLOSED = 2;
      const DEFAULT_RECONNECT_MS = 3000;
      function ZPEventSource(url, init = {}) {
        this.url = requestTargetURL(url);
        this.withCredentials = !!(init && init.withCredentials);
        this.readyState = CONNECTING;
        this._closed = false;
        this._controller = new AbortController();
        this._lastEventId = '';
        this._reconnectMs = DEFAULT_RECONNECT_MS;
        this._reconnectTimer = 0;
        this._init = init || {};
        runEventSource(this);
      }
      installEventMethods(ZPEventSource.prototype);
      Object.assign(ZPEventSource.prototype, {
        constructor: ZPEventSource,
        CONNECTING, OPEN, CLOSED,
        close() {
          this._closed = true;
          this.readyState = CLOSED;
          if (this._reconnectTimer) { try { clearTimeout(this._reconnectTimer); } catch {} this._reconnectTimer = 0; }
          try { this._controller.abort(); } catch {}
        }
      });
      maskMethods(ZPEventSource.prototype, ['close']);
      mirrorNativeProto(ZPEventSource.prototype,
        ['url', 'withCredentials', 'readyState', 'onopen', 'onmessage', 'onerror'],
        Native.EventSource && Native.EventSource.prototype);
      brandLikeNative(ZPEventSource, ZPEventSource.prototype, 'EventSource');
      define(root, 'EventSource', ZPEventSource);

      function scheduleReconnect(es) {
        if (es._closed) return;
        es.readyState = CONNECTING;
        fireEvent(es, 'error');
        if (es._closed) return;
        es._reconnectTimer = setTimeout(() => {
          es._reconnectTimer = 0;
          if (es._closed) return;
          // New controller per attempt so prior abort doesn't poison next fetch.
          es._controller = new AbortController();
          runEventSource(es);
        }, es._reconnectMs);
      }

      function runEventSource(es) {
        const headers = [['Accept', 'text/event-stream'], ['Cache-Control', 'no-cache']];
        if (es._lastEventId) headers.push(['Last-Event-ID', es._lastEventId]);
        fetchThroughRuntime(es.url, { method: 'GET', headers, credentials: es._init.withCredentials ? 'include' : 'same-origin', cache: 'no-store', signal: es._controller.signal }).then(async resp => {
          if (es._closed) return;
          // 204 = end of stream, close cleanly (no reconnect).
          if (resp.status === 204) {
            es.readyState = CLOSED;
            return;
          }
          const ct = (resp.headers && resp.headers.get('Content-Type')) || '';
          // Per spec wrong MIME or non-2xx is a HARD fail — no reconnect.
          if (!resp.ok || !/^text\/event-stream\b/i.test(ct)) {
            es.readyState = CLOSED;
            fireEvent(es, 'error');
            return;
          }
          es.readyState = OPEN;
          fireEvent(es, 'open');
          if (!resp.body || !resp.body.getReader) {
            consumeSSE(es, await resp.text(), true);
            if (!es._closed) scheduleReconnect(es);
            return;
          }
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              buf = consumeSSE(es, buf + decoder.decode(part.value, { stream: true }), false);
            }
            consumeSSE(es, buf + decoder.decode(), true);
          } catch {}
          if (!es._closed) scheduleReconnect(es);
        }).catch(() => {
          if (es._closed) return;
          scheduleReconnect(es);
        });
      }
      function consumeSSE(es, text, final) {
        let buf = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          dispatchSSE(es, buf.slice(0, idx));
          buf = buf.slice(idx + 2);
        }
        if (final && buf) {
          dispatchSSE(es, buf);
          return '';
        }
        return buf;
      }
      function dispatchSSE(es, block) {
        if (es._closed) return;
        let data = '', eventType = 'message', eventLastId = null;
        for (const line of String(block).split('\n')) {
          if (!line || line[0] === ':') continue;
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? '' : line.slice(colon + 1);
          if (value[0] === ' ') value = value.slice(1);
          if (field === 'data') data += value + '\n';
          else if (field === 'event') eventType = value || 'message';
          else if (field === 'id') eventLastId = value;
          else if (field === 'retry') {
            // Per spec only digit-strings update reconnect interval.
            if (/^\d+$/.test(value)) es._reconnectMs = parseInt(value, 10);
          }
        }
        // Per spec the "last event ID buffer" updates on EVERY id field.
        if (eventLastId !== null) es._lastEventId = eventLastId;
        if (!data) return;
        data = data.slice(0, -1);
        let ev;
        const origin = new URL(es.url).origin;
        try { ev = new MessageEvent(eventType, { data, origin, lastEventId: es._lastEventId }); }
        catch { ev = new Event(eventType); try { Object.defineProperties(ev, { data: { value: data }, origin: { value: origin }, lastEventId: { value: es._lastEventId } }); } catch {} }
        es.dispatchEvent(ev);
      }
    }
  }
  function installWebSocket() {
    // C1: WebSocket boundary fidelity (RFC 6455). Sub-protocol selection
    // §4.2.2, close code/reason validation §7.4 (code: 1000 or [3000,4999];
    // reason ≤ 123 UTF-8 bytes), binaryType setter validation,
    // bufferedAmount accounting. The kernel transport is currently a stub
    // (TARGET_WS_NOT_REWIRED) so end-to-end can't be exercised, but
    // boundary-correct behavior prevents target scripts from tripping on
    // validation throws browsers would do.
    const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
    const tokenRE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
    function protocolList(protocols) {
      if (protocols == null) return [];
      const list = typeof protocols === 'string' ? [protocols] : Array.isArray(protocols) ? protocols.slice() : null;
      if (!list) throw normalizedError('SyntaxError');
      const out = [];
      const seen = new Set();
      for (const p of list) {
        const s = String(p);
        if (!s || !tokenRE.test(s) || seen.has(s)) throw normalizedError('SyntaxError');
        seen.add(s);
        out.push(s);
      }
      return out;
    }
    // RFC 6455 §7.4: close code must be 1000 or in [3000, 4999].
    function validateCloseCode(code) {
      if (code === undefined) return;
      const n = Number(code);
      if (!Number.isFinite(n) || (n !== 1000 && (n < 3000 || n > 4999))) {
        throw normalizedError('InvalidAccessError');
      }
    }
    // RFC 6455 §7.4.1: close reason ≤ 123 UTF-8 bytes.
    function validateReason(reason) {
      if (reason === undefined || reason === '') return;
      const enc = (typeof TextEncoder === 'function') ? new TextEncoder().encode(String(reason)) : null;
      const len = enc ? enc.length : String(reason).length;
      if (len > 123) throw normalizedError('SyntaxError');
    }
    function utf8ByteLength(s) {
      if (typeof TextEncoder === 'function') {
        try { return new TextEncoder().encode(s).length; } catch {}
      }
      return s.length;
    }
    function payloadByteLength(data) {
      if (typeof data === 'string') return utf8ByteLength(data);
      if (data instanceof ArrayBuffer) return data.byteLength;
      if (Native.Blob && data instanceof Native.Blob) return data.size;
      if (data && typeof data.byteLength === 'number') return data.byteLength;
      return 0;
    }
    function closeEvent(code, reason, wasClean) {
      try { return new CloseEvent('close', { code, reason, wasClean }); }
      catch { const ev = new Event('close'); try { Object.defineProperties(ev, { code: { value: code }, reason: { value: reason }, wasClean: { value: wasClean } }); } catch {} return ev; }
    }
    function finish(ws, code, reason, wasClean) {
      if (ws._closed) return;
      ws._closed = true;
      ws.readyState = CLOSED;
      if (ws._closeGuard) { try { clearTimeout(ws._closeGuard); } catch {} ws._closeGuard = null; }
      ws.dispatchEvent(closeEvent(code || 1000, reason || '', wasClean !== false));
    }
    function fail(ws) {
      if (ws._closed) return;
      ws.dispatchEvent(new Event('error'));
      // Preserve user-requested close code if they were mid-handshake.
      const code = ws._closingCode || 1006;
      const reason = ws._closingReason || '';
      finish(ws, code, reason, false);
    }
    function ZPWebSocket(url, protocols) {
      if (arguments.length < 1) throw new TypeError("Failed to construct 'WebSocket': 1 argument required, but only 0 present.");
      this.url = targetWSURL(url);
      this.protocol = '';
      this.extensions = '';
      this.readyState = CONNECTING;
      this._port = null;
      this._closed = false;
      this._bufferedAmount = 0;
      this._binaryType = 'blob';
      this._closingCode = 0;
      this._closingReason = '';
      const plist = protocolList(protocols);
      this._requestedProtocols = plist;
      postMessageToSW({ type: 'ZP_WS_OPEN', url: this.url, protocols: plist, tabId: boot.tabId }).then(reply => {
        if (this._closed) { try { reply.port && reply.port.postMessage({ type: 'close' }); } catch {} return; }
        const negotiated = String(reply.protocol || '');
        // RFC 6455 §4.2.2: server must pick from the offered list.
        if (negotiated && plist.length > 0 && plist.indexOf(negotiated) < 0) {
          fail(this);
          return;
        }
        this.protocol = negotiated;
        this._port = reply.port;
        this._port.onmessage = ev => {
          const m = ev.data || {};
          if (m.type === 'message') {
            let data = m.data;
            if (this._binaryType === 'blob' && data instanceof ArrayBuffer && Native.Blob) {
              data = new Native.Blob([data]);
            } else if (this._binaryType === 'arraybuffer' && Native.Blob && data instanceof Native.Blob) {
              data.arrayBuffer().then(buf => {
                if (this._closed) return;
                this.dispatchEvent(new MessageEvent('message', { data: buf, origin: new URL(this.url).origin }));
              }).catch(() => fail(this));
              return;
            }
            this.dispatchEvent(new MessageEvent('message', { data, origin: new URL(this.url).origin }));
          } else if (m.type === 'error') {
            fail(this);
          } else if (m.type === 'close') {
            finish(this, m.code || 1000, m.reason || '', true);
          } else if (m.type === 'senddrained' && typeof m.bytes === 'number') {
            // Best-effort backpressure (kernel emits once Rust WS lands).
            this._bufferedAmount = Math.max(0, this._bufferedAmount - m.bytes);
          }
        };
        this._port.start && this._port.start();
        this.readyState = OPEN;
        this.dispatchEvent(new Event('open'));
      }).catch(() => fail(this));
    }
    ZPWebSocket.CONNECTING = CONNECTING; ZPWebSocket.OPEN = OPEN; ZPWebSocket.CLOSING = CLOSING; ZPWebSocket.CLOSED = CLOSED;
    ZPWebSocket.prototype = { CONNECTING, OPEN, CLOSING, CLOSED };
    installEventMethods(ZPWebSocket.prototype);
    Object.assign(ZPWebSocket.prototype, {
      constructor: ZPWebSocket,
      send(data) {
        if (this.readyState === CONNECTING) throw normalizedError('InvalidStateError');
        if (this.readyState !== OPEN || !this._port) {
          // CLOSING/CLOSED: spec silently grows bufferedAmount and drops.
          this._bufferedAmount += payloadByteLength(data);
          return;
        }
        const bytes = payloadByteLength(data);
        this._bufferedAmount += bytes;
        if (Native.Blob && data instanceof Native.Blob) {
          data.arrayBuffer().then(buf => {
            if (this.readyState === OPEN && this._port) {
              this._port.postMessage({ type: 'send', data: buf, bytes });
            } else {
              this._bufferedAmount = Math.max(0, this._bufferedAmount - bytes);
            }
          }).catch(() => fail(this));
          return;
        }
        this._port.postMessage({ type: 'send', data, bytes });
      },
      close(code, reason) {
        validateCloseCode(code);
        validateReason(reason);
        if (this._closed || this.readyState === CLOSING || this.readyState === CLOSED) return;
        const finalCode = code === undefined ? 1000 : Number(code);
        const finalReason = reason === undefined ? '' : String(reason);
        this._closingCode = finalCode;
        this._closingReason = finalReason;
        this.readyState = CLOSING;
        if (!this._port) {
          // Mid-handshake close: no port yet, so the SW side will get a
          // close on the port from the open() resolve path. Settle now.
          finish(this, finalCode, finalReason, true);
          return;
        }
        // RFC 6455 §7.1.6: closing handshake — wait for the peer's close
        // echo before transitioning to CLOSED so in-flight messages drain
        // first. The port's {type:'close'} ack (line ~1531 above) calls
        // finish() with the remote-supplied code/reason once the Rust
        // ws_client surfaces it. As a defense against a hung transport
        // (e.g. server never echoes per §7.1.6 timeout window), fail
        // closed with 1006 after 30 s.
        this._port.postMessage({ type: 'close', code: finalCode, reason: finalReason });
        const ws = this;
        const guardMs = 30000;
        const guard = setTimeout(() => {
          if (!ws._closed) finish(ws, 1006, '', false);
        }, guardMs);
        // Browsers don't expose unref on setTimeout from JS; we just let
        // the guard fire if close never resolves. Caller cannot cancel.
        this._closeGuard = guard;
      }
    });
    // bufferedAmount: read-only per IDL.
    try {
      // ZPWebSocket.prototype is a fresh object literal, so unlike XHR/EventSource
      // (which reuse a function's default .prototype) it has no inherited
      // non-enumerable `constructor` slot — Object.assign created an enumerable
      // one, putting `constructor` into Object.keys where no browser has it.
      Object.defineProperty(ZPWebSocket.prototype, 'constructor', {
        value: ZPWebSocket, writable: true, enumerable: false, configurable: true,
      });
      Object.defineProperty(ZPWebSocket.prototype, 'bufferedAmount', {
        configurable: false,
        enumerable: true, // Web IDL attributes are enumerable; these two were the
                          // only members of the replaced classes still hiding.
        get() { return this._bufferedAmount | 0; },
      });
    } catch {}
    // binaryType: strict enum; invalid assignments silently dropped (browser-equivalent).
    try {
      Object.defineProperty(ZPWebSocket.prototype, 'binaryType', {
        configurable: false,
        enumerable: true,
        get() { return this._binaryType; },
        set(v) {
          const s = String(v);
          if (s === 'blob' || s === 'arraybuffer') this._binaryType = s;
        },
      });
    } catch {}
    mirrorNativeProto(ZPWebSocket.prototype,
      ['url', 'readyState', 'onopen', 'onerror', 'onclose', 'onmessage', 'extensions', 'protocol'],
      Native.WebSocket && Native.WebSocket.prototype);
    brandLikeNative(ZPWebSocket, ZPWebSocket.prototype, 'WebSocket');
    define(root, 'WebSocket', ZPWebSocket);
  }

  function installWebSocketStream() {
    if (!root.WebSocket || !root.ReadableStream || !root.WritableStream) return;
    function ZPWebSocketStream(url, options = {}) {
      if (!(this instanceof ZPWebSocketStream)) throw new TypeError("Failed to construct 'WebSocketStream': Please use the 'new' operator.");
      let closeResolve;
      this.closed = new Promise(resolve => { closeResolve = resolve; });
      this.opened = new Promise((resolve, reject) => {
        let ws;
        let settled = false;
        let controllerReadable = null;
        const failOpen = err => { if (!settled) { settled = true; reject(err); } };
        try {
          ws = new root.WebSocket(url, options && options.protocols);
          ws.binaryType = 'arraybuffer';
          const readable = new root.ReadableStream({
            start(controller) { controllerReadable = controller; },
            cancel() { try { ws.close(); } catch {} }
          });
          const writable = new root.WritableStream({
            write(chunk) { ws.send(chunk); },
            close() { ws.close(); },
            abort() { ws.close(); }
          });
          ws.onopen = () => { settled = true; resolve({ readable, writable, protocol: ws.protocol, extensions: ws.extensions || '' }); };
          ws.onmessage = event => { if (controllerReadable) controllerReadable.enqueue(event.data); };
          ws.onerror = err => { if (!settled) failOpen(err); else if (controllerReadable) { try { controllerReadable.error(err); } catch {} } };
          ws.onclose = event => {
            if (!settled) failOpen(normalizedError('NetworkError'));
            try { controllerReadable && controllerReadable.close(); } catch {}
            closeResolve({ closeCode: event.code, reason: event.reason });
          };
        } catch (err) {
          failOpen(err);
        }
      });
    }
    try { Object.defineProperty(ZPWebSocketStream, 'name', { value: 'WebSocketStream', configurable: true }); } catch {}
    ZPWebSocketStream.prototype.constructor = ZPWebSocketStream;
    maskNativeFunction(ZPWebSocketStream, 'WebSocketStream');
    define(root, 'WebSocketStream', ZPWebSocketStream);
  }

  function installBeacon() { if (!navigator.sendBeacon || !Native.fetch || !Native.Request || !Native.Headers) return; defineMethodOnProto(navigator, root.Navigator && root.Navigator.prototype, 'sendBeacon', function sendBeacon(url, data) { try { fetchThroughRuntime(url, { method: 'POST', body: data, keepalive: true, credentials: 'include' }).catch(()=>{}); return true; } catch { return false; } }); }

  function installNavigationTraps() {
    // D1: javascript: URL delegated handler. htmltx transforms target
    // `<a href="javascript:CODE">` etc. into `<a href="javascript:void(0)"
    // data-zp-jsurl="<rewritten>" data-zp-jsurl-kind="anchor">`. Here we
    // capture clicks/submits on those elements and execute the rewritten
    // body using prelude-private `Native.FunctionCtor` so target code
    // never sees the eval/Function constructor.
    function runJSURL(el, ev) {
      if (!el || !el.getAttribute) return false;
      const code = el.getAttribute('data-zp-jsurl');
      if (!code) return false;
      try {
        // Wrap in IIFE to give the rewritten body its own scope. The
        // rewriter has already routed dangerous globals through __zp_get,
        // which is exposed on globalThis by installPhase2Membrane.
        Native.FunctionCtor('"use strict";\n' + code).call(globalThis);
      } catch {}
      if (ev) { ev.preventDefault(); ev.stopImmediatePropagation(); }
      return true;
    }
    document.addEventListener('click', ev => {
      for (let el = ev.target; el && el !== document; el = el.parentElement) {
        if (el.hasAttribute && el.hasAttribute('data-zp-jsurl')) {
          if (runJSURL(el, ev)) return;
        }
      }
      const nav = clickNavigationTarget(ev);
      if (!nav) return;
      ev.preventDefault();
      if (nav.hash != null) {
        // 2026-08-13 — same-document hash 이동에서는 전파를 끊지 않는다.
        // 실제 브라우저도 해시 이동과 페이지 핸들러 실행을 둘 다 한다.
        // 여기서 stopImmediatePropagation 을 부르면 `<a href="#tab">` 을
        // 탭/토글로 쓰는 흔한 React 패턴이 통째로 죽는다 (클릭이 문서까지
        // 도달하지 못해 delegated onClick 이 안 걸린다).
        updateVirtualHash(nav.hash);
        return;
      }
      ev.stopImmediatePropagation();
      if (nav.href) setVirtualLocation(nav.href);
    }, true);
    document.addEventListener('submit', ev => {
      const f = ev.target;
      if (!f) return;
      if (f.hasAttribute && f.hasAttribute('data-zp-jsurl')) {
        if (runJSURL(f, ev)) return;
      }
      ev.preventDefault();
      submitForm(f, ev.submitter);
    }, true);
    if (Native.formSubmit) define(HTMLFormElement.prototype, 'submit', function() { submitForm(this); });
    if (Native.formRequestSubmit) define(HTMLFormElement.prototype, 'requestSubmit', function(submitter) { submitForm(this, submitter); });
    if (Native.locationAssign) define(Location.prototype, 'assign', function(u) { setVirtualLocation(u); });
    if (Native.locationReplace) define(Location.prototype, 'replace', function(u) { setVirtualLocation(u, true); });
    if (Native.locationReload) define(Location.prototype, 'reload', function() { Native.locationReload(); });
    const histProto = root.History && root.History.prototype;
    defineMethodOnProto(history, histProto, 'pushState', function pushState(state, title, url) { return commitVirtualHistory(state, title, url, false); });
    defineMethodOnProto(history, histProto, 'replaceState', function replaceState(state, title, url) { return commitVirtualHistory(state, title, url, true); });
    window.addEventListener('popstate', () => { postMessageToSW({ type: 'ZP_RESOLVE_ENTRY', path: activeProxyPath }).then(reply => { activeEntryId = reply.entryId || activeEntryId; virtualURL = new URL(reply.targetUrl); baseURL = reply.baseUrl || virtualURL.href; explicitBaseURL = baseURL !== virtualURL.href ? baseURL : ''; if (typeof reply.scrollX === 'number' && typeof reply.scrollY === 'number') window.scrollTo(reply.scrollX, reply.scrollY); }).catch(()=>{}); }, true);
    let scrollTimer = 0;
    window.addEventListener('scroll', () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(() => postMessageToSW({ type: 'ZP_SCROLL_UPDATE', tabId: boot.tabId, entryId: activeEntryId, scrollX: window.scrollX, scrollY: window.scrollY }).catch(()=>{}), 100); }, { passive: true });
    function submitForm(form, submitter) { submitFormNavigation(form, submitter).catch(err => { const code = err && (err.code || err.message); if (code === 'REQUEST_BODY_TOO_LARGE') Native.locationAssign && Native.locationAssign(proxyAbsoluteURL(ZP.errorPath('REQUEST_BODY_TOO_LARGE'))); }); }
    // Resolve the form's real absolute target, NOT the rewritten attribute.
    //
    // htmltx rewrites `action` / `formaction` to the proxy-origin launcher
    // `<proxy>/zp/?via=<target>` (proxied_navigation_url) so the browser's
    // native UI never sees the target host. Reading that attribute back here
    // is fatal for GET: per HTML, a GET submit REPLACES the action URL's
    // query string with the form data set, which destroys `via=` and leaves
    // the proxy origin itself as the navigation target — the search box then
    // navigates to `<proxy>/zp/?query=...` and resolves to TARGET_CONNECT_FAILED
    // against proxy.localhost. The absolute target is stashed in urlMeta /
    // `data-zp-target-url`, exactly as the anchor click path reads it
    // (clickNavigationTarget), so use that first and fall back to the raw
    // attribute only for forms we never rewrote (e.g. JS-built, relative).
    //
    // The raw-attribute fallback needs one more step: a proxy-origin action is
    // NOT a target. htmltx writes the launcher onto `action` but does not always
    // leave a `data-zp-target-url` stash beside it — NAVER's login form
    // (`frmNIDLogin`) is exactly that shape: `action` is
    // `<proxy>/zp/?via=<login url>` with no stash. Handing that back makes
    // `targetURL()` faithfully dial `proxy.localhost:18080` and the submit dies
    // as TARGET_CONNECT_FAILED — i.e. logging in was impossible. So unwrap the
    // launcher back to its target. 되돌리기 규칙은 `deproxyURL` 한 곳에 있다.
    function submissionActionURL(form, submitter) {
      if (submitter && submitter.hasAttribute && submitter.hasAttribute('formaction')) {
        const fa = urlMeta.get(submitter)
          || Native.getAttribute.call(submitter, 'data-zp-target-url')
          || submitter.getAttribute('formaction');
        if (fa) return deproxyURL(fa, { fallback: 'any' });
      }
      const action = urlMeta.get(form)
        || Native.getAttribute.call(form, 'data-zp-target-url')
        || (form.getAttribute && form.getAttribute('action'));
      return (action && deproxyURL(action, { fallback: 'any' })) || virtualURL.href;
    }
    async function submitFormNavigation(form, submitter) {
      const raw = submissionActionURL(form, submitter);
      const method = String(submitter && submitter.getAttribute && submitter.getAttribute('formmethod') || form.getAttribute('method') || 'GET').toUpperCase();
      if (method === 'DIALOG') return;
      const target = new URL(targetURL(raw));
      urlMeta.set(form, target.href);
      if (method === 'GET') {
        try {
          const data = submitter ? new Native.FormData(form, submitter) : new Native.FormData(form);
          const qs = new URLSearchParams();
          for (const [k, v] of data) qs.append(k, formEntryValue(v));
          const encoded = qs.toString();
          if (encoded) target.search = target.search ? target.search + '&' + encoded : encoded;
        } catch {}
        navigateToTarget(target.href);
        return;
      }
      const serialized = await serializeFormSubmission(form, submitter, method, target.href);
      const share = await ZP.encryptShareURL(target.href);
      const entryId = 'e' + ZP.randomId();
      const reply = await postMessageToSW({ type: 'ZP_SUBMIT_PREPARE', tabId: boot.tabId, entryId, routeKey: share.encrypted, targetUrl: target.href, method, headers: serialized.headers, body: serialized.body, enctype: serialized.enctype, referrer: virtualURL.href });
      activeEntryId = entryId;
      activeProxyPath = ZP.makeSharePath(share.encrypted);
      activeRouteKey = share.encrypted;
      activeProxyFragment = shareFragmentForKey(share.key);
      // 같은 이유로 절대 URL 이어야 한다 — `<base href>` 가 있으면 폼 제출이
      // 프록시 밖으로 나간다.
      const submittedPath = proxyAbsoluteURL(activeProxyPath + '?zp_submit=' + encodeURIComponent(reply.submitId) + activeProxyFragment);
      if (Native.locationAssign) Native.locationAssign(submittedPath);
      else location.href = submittedPath;
    }
    async function serializeFormSubmission(form, submitter, method, targetHref) {
      const data = submitter ? new Native.FormData(form, submitter) : new Native.FormData(form);
      const enctype = normalizedFormEncoding(form, submitter);
      const headers = [];
      let bytes;
      if (enctype === 'multipart/form-data') {
        const req = new Native.Request(targetHref, { method, body: data });
        const ct = req.headers.get('content-type');
        if (ct) headers.push(['Content-Type', ct]);
        bytes = new Uint8Array(await req.arrayBuffer());
      } else {
        const text = enctype === 'text/plain' ? plainFormBody(data) : urlEncodedFormBody(data);
        const type = enctype === 'text/plain' ? 'text/plain;charset=UTF-8' : 'application/x-www-form-urlencoded;charset=UTF-8';
        headers.push(['Content-Type', type]);
        bytes = new TextEncoder().encode(text);
      }
      return { enctype, headers, body: ZP.bytesToBase64Url(bytes) };
    }
    function normalizedFormEncoding(form, submitter) {
      const raw = String(submitter && submitter.getAttribute && submitter.getAttribute('formenctype') || form.getAttribute('enctype') || 'application/x-www-form-urlencoded').toLowerCase();
      return raw === 'multipart/form-data' || raw === 'text/plain' ? raw : 'application/x-www-form-urlencoded';
    }
    function formEntryValue(v) { return v && typeof v === 'object' && typeof v.name === 'string' && typeof v.size === 'number' ? v.name : String(v); }
    function urlEncodedFormBody(data) { const qs = new URLSearchParams(); for (const [k, v] of data) qs.append(k, formEntryValue(v)); return qs.toString(); }
    function plainFormBody(data) { const out = []; for (const [k, v] of data) out.push(String(k) + '=' + formEntryValue(v)); return out.join('\r\n'); }
    function clickNavigationTarget(ev) {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return null;
      for (let el = ev.target; el && el !== document; el = el.parentElement) {
        const isAnchor = el.matches && el.matches('a[href],area[href]');
        if (isAnchor) {
          if (el.hasAttribute('download')) return null;
          const target = el.getAttribute('target');
          if (target && target !== '_self') return null;
        }
        const raw = isAnchor ? Native.getAttribute.call(el, 'data-zp-target-url') || el.getAttribute('href') : typeof el.href === 'string' ? el.href : '';
        if (!raw) continue;
        // `href="#"` 또는 `href="#"` 단독은 NAVER 메뉴 같은 React onClick 핸들러
        // no-op anchor 패턴. preventDefault + stopImmediatePropagation 으로
        // 가로채면 React 가 onClick 받지 못해 메뉴 확장이 동작 안 함. skip 하여
        // 페이지가 처리하도록 위임. (실제 hash fragment 가 있는 `#section` 은
        // virtual hash update 유지.)
        if (raw === '#') continue;
        if (raw[0] === '#') return { hash: raw, element: el };
        if (hasExecutableURLScheme(raw)) return { href: '', element: el };
        if (isHTTPURL(raw)) return { href: raw, element: el };
      }
      return null;
    }
  }
  function installNavigatorIdentity(w) {
    const nav = w.navigator;
    if (!nav) return;
    const proto = w.Navigator && w.Navigator.prototype || Object.getPrototypeOf(nav);
    defineOnProto(nav, proto, 'userAgent', () => TARGET_USER_AGENT);
    defineOnProto(nav, proto, 'appVersion', () => TARGET_APP_VERSION);
    defineOnProto(nav, proto, 'platform', () => TARGET_PLATFORM);
    // navigator.webdriver: real Chrome 148 returns `false`. WebView2
    // and CDP-controlled instances return `true`, which every modern
    // anti-bot WAF flags as a robot signal. Pin to `false` so target
    // pages can't distinguish ZeroProxy from a hand-driven Chrome.
    defineOnProto(nav, proto, 'webdriver', () => false);
    // navigator.userAgentData — UA 는 Chrome 으로 가려 놓고 여기를 안 가려서
    // **브랜드 목록이 호스트 셸을 그대로 불었다**. 실측(2026-08-16, 프록시된
    // example.com):
    //   navigator.userAgent      → …Chrome/151.0.0.0 Safari/537.36   (가려짐)
    //   navigator.userAgentData  → Chromium 151, Not=A?Brand 99,
    //                              Microsoft Edge WebView2 151, Microsoft Edge 151
    // 게다가 HTTP 로는 sec-ch-ua 에 "Google Chrome" 을 보낸다. 헤더와 JS 가
    // 서로 다른 브라우저를 말하는 것은 단일 신호보다 강한 tell 이다.
    // ZP.TARGET_SEC_CH_UA 를 파싱해서 그 목록 그대로 되돌려 준다 — 값이 한
    // 군데서만 나오므로 다음에 버전을 올려도 갈라지지 않는다.
    defineOnProto(nav, proto, 'userAgentData', () => virtualUserAgentData(w));
    installChromeFingerprintFacade(w);
  }
  function targetBrandList() {
    if (cachedUADataBrands) return cachedUADataBrands;
    const out = [];
    const re = /"([^"]+)";v="([^"]+)"/g;
    let m;
    while ((m = re.exec(String(ZP.TARGET_SEC_CH_UA || '')))) out.push({ brand: m[1], version: m[2] });
    cachedUADataBrands = out;
    return out;
  }
  function virtualUserAgentData(w) {
    const real = w.navigator && Object.getPrototypeOf(w.navigator);
    // 실제 NavigatorUAData 인스턴스를 감싸지 않고 새로 만든다 — 감싸면 getter
    // 가 내부 슬롯을 요구해 Illegal invocation 이 난다.
    const brands = targetBrandList().map(b => ({ brand: b.brand, version: b.version }));
    // ★진짜 NavigatorUAData.prototype 을 상속시킨다(2026-08-24).
    // 값은 own 속성으로 덮으므로 내부 슬롯을 요구하는 프로토타입 게터는
    // 한 번도 불리지 않는다(그게 예전에 Illegal invocation 을 냈던 이유다).
    // 실측 — 대조군 대비 세 가지가 한 번에 맞는다:
    //   navigator.userAgentData instanceof NavigatorUAData   false → true
    //   .constructor.name                     Object → NavigatorUAData
    //   Object.prototype.toString.call(...)   [object Object] → [object NavigatorUAData]
    // 값은 **중간 프로토타입**에 접근자로 올린다. 인스턴스에 직접 얹으면
    // 실제 프로토타입의 읽기전용 접근자와 충돌해 던지고(측정: 'Cannot set
    // property brands of #<NavigatorUAData> which has only a getter'),
    // 무엇보다 진짜 인스턴스는 own 속성이 **0개**다(대조군 실측).
    const uaProto = (w.NavigatorUAData && w.NavigatorUAData.prototype) || Object.prototype;
    const shim = Object.create(uaProto);
    const data = Object.create(shim);
    const shimValues = {
      brands,
      mobile: false,
      platform: TARGET_PLATFORM === 'Win32' ? 'Windows' : TARGET_PLATFORM,
      toJSON() { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; },
      getHighEntropyValues(hints) {
        const full = {
          brands,
          mobile: false,
          platform: data.platform,
          platformVersion: '19.0.0',
          architecture: 'x86',
          bitness: '64',
          model: '',
          uaFullVersion: (brands.find(b => b.brand === 'Google Chrome') || brands[0] || {}).version + '.0.0.0',
          fullVersionList: brands.map(b => ({ brand: b.brand, version: b.version + '.0.0.0' })),
          wow64: false,
        };
        const picked = { brands: full.brands, mobile: full.mobile, platform: full.platform };
        for (const h of (hints || [])) if (h in full) picked[h] = full[h];
        return Promise.resolve(picked);
      },
    };
    for (const k of Object.keys(shimValues)) {
      const v = shimValues[k];
      const desc = typeof v === 'function'
        ? { value: v, writable: true, enumerable: false, configurable: true }
        : { get: () => v, enumerable: true, configurable: true };
      try { Object.defineProperty(shim, k, desc); } catch {}
    }
    void real;
    return data;
  }

  // chrome.* surface — present on real Chrome / Edge-Chromium and
  // checked by anti-bot WAFs (Cloudflare, NAVER, Akamai). Missing on
  // strict-headless Chrome ≈ bot signal; Edge WebView2 exposes
  // `chrome.webview` for Tauri ipc, which is a worse tell (it spells
  // out the host shell). Build a plausible Chrome-148 chrome object
  // and replace whatever WebView2 dropped in.
  function installChromeFingerprintFacade(w) {
    // 아래에서 `configurable: false` 로 심으므로 같은 창에 두 번 부르면
    // delete 와 defineProperty 가 **매번 둘 다 던진다**. try/catch 가 삼켜서
    // 조용하지만 공짜가 아니다 — 실측으로 로드당 수백 번 던지고 있었다.
    // ★2026-08-16: `propertyLocked` 만 보고 물러나면 **WebView2 에서는 영원히
    // 설치가 안 된다**. 실측: 프록시된 페이지에서 `window.chrome` 의 디스크립터가
    // `{value: object, configurable: false, writable: true}` 였고, 키는
    // `app,csi,loadTimes,webview` — 즉 우리 퍼사드가 아니라 **WebView2 의 진짜
    // 객체**가 그대로 남아 `chrome.webview` 로 호스트 셸을 불고 있었다.
    // configurable:false 라 defineProperty 는 던지지만 writable:true 라
    // **대입은 통한다**. 그래서 잠겨 있어도 쓰기 가능하면 대입으로 갈아끼운다.
    // 이미 우리 것으로 갈아끼운 창이면 다시 만들지 않는다 — 잠긴 자리를 대입으로
    // 덮는 경로는 던지지 않으므로 "던지면 멈춘다" 식 멱등성이 없다. 신원 대신
    // **모양**으로 판정한다(퍼사드에는 webview 가 없다).
    try {
      const cur = w.chrome;
      if (cur && typeof cur.csi === 'function' && !('webview' in cur)) return;
    } catch {}
    const locked = propertyLocked(w, 'chrome');
    let writableWhenLocked = false;
    if (locked) {
      try {
        const d = Object.getOwnPropertyDescriptor(w, 'chrome');
        writableWhenLocked = !!(d && d.writable);
      } catch {}
      if (!writableWhenLocked) return;
    }
    let virtualChrome;
    try {
      virtualChrome = buildChromeFingerprint(w);
    } catch { return; }
    if (!virtualChrome) return;
    if (locked) {
      try { w.chrome = virtualChrome; } catch {}
      return;
    }
    // Drop the existing object (Tauri / WebView2 may have planted
    // `chrome.webview`, `chrome.webview.hostObjects`, etc. which all
    // signal "not a real browser"). Reassign via accessor so a future
    // delete attempt doesn't unwedge our installation.
    try { delete w.chrome; } catch {}
    try {
      Object.defineProperty(w, 'chrome', {
        get() { return virtualChrome; },
        set() { /* swallow */ },
        enumerable: true, // real Chrome's window.chrome is enumerable
        configurable: false,
      });
    } catch {}
  }

  function buildChromeFingerprint(w) {
    // Reference: real Chrome 148 — `chrome.csi()`, `chrome.loadTimes()`,
    // `chrome.app = { isInstalled, InstallState, RunningState }`. Both
    // `csi` and `loadTimes` are deprecated for years but ALWAYS present
    // on a real Chrome page realm — checking their existence + return
    // shape is a cheap fingerprint probe.
    const perf = w.performance;
    const baseT = perf && typeof perf.timeOrigin === 'number' ? perf.timeOrigin : Date.now();
    const navT = perf && perf.timing ? perf.timing : null;
    function chromeCsi() {
      const now = Date.now();
      return {
        startE: Math.floor(baseT),
        onloadT: navT && navT.loadEventEnd ? navT.loadEventEnd : Math.floor(baseT),
        pageT: now - Math.floor(baseT),
        tran: 15, // CLIENT_REDIRECT — most common transition type
      };
    }
    function chromeLoadTimes() {
      const rt = baseT / 1000;
      const lt = (navT && navT.loadEventEnd ? navT.loadEventEnd : Date.now()) / 1000;
      return {
        requestTime: rt,
        startLoadTime: rt,
        commitLoadTime: rt,
        finishDocumentLoadTime: lt,
        finishLoadTime: lt,
        firstPaintTime: lt,
        firstPaintAfterLoadTime: 0,
        navigationType: 'Other',
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
        npnNegotiatedProtocol: 'h2',
        wasAlternateProtocolAvailable: false,
        connectionInfo: 'h2',
      };
    }
    const app = Object.freeze({
      isInstalled: false,
      InstallState: Object.freeze({
        DISABLED: 'disabled',
        INSTALLED: 'installed',
        NOT_INSTALLED: 'not_installed',
      }),
      RunningState: Object.freeze({
        CANNOT_RUN: 'cannot_run',
        READY_TO_RUN: 'ready_to_run',
        RUNNING: 'running',
      }),
    });
    try { maskNativeFunction(chromeCsi, 'csi'); } catch {}
    try { maskNativeFunction(chromeLoadTimes, 'loadTimes'); } catch {}
    return Object.freeze({
      csi: chromeCsi,
      loadTimes: chromeLoadTimes,
      app,
      // `runtime` is undefined off-extension on real Chrome — leaving
      // it out is the spec-correct stub. Probes that check
      // `typeof chrome.runtime === 'undefined'` see what they expect.
      // `webstore` legacy — also undefined.
      // `webview` — DELIBERATELY OMITTED. Tauri WebView2 plants this;
      // its presence is a strong host-shell tell. The accessor above
      // replaces the whole chrome object so the leak is gone.
    });
  }

  function installPopupHooks(w) {
    if (!Native.open) return;
    define(w, 'open', function(url = 'about:blank', target = '_blank', features) {
      const raw = String(url || 'about:blank');
      let child;
      if (raw === 'about:blank' || raw === '') child = Native.open('about:blank', target, features);
      else if (isHTTPURL(raw)) { child = Native.open('about:blank', target, features); if (child) shareNavURL(raw).then(u => { child.location.href = u; }).catch(() => { try { child.close(); } catch {} }); }
      else child = Native.open('about:blank', target, features);
      if (child && (raw === 'about:blank' || raw === '')) {
        try { installNetworkContainment(child); } catch { try { child.close(); } catch {} return null; }
      }
      return child;
    });
  }

  function installPostMessageHooks(w) {
    if (!Native.windowAddEventListener || !Native.windowRemoveEventListener) return;
    function wrap(listener) {
      if (!listener || (typeof listener !== 'function' && typeof listener.handleEvent !== 'function')) return listener;
      if (messageListenerWrappers.has(listener)) return messageListenerWrappers.get(listener);
      const wrapped = function(ev) {
        const next = virtualizeMessageEvent(ev);
        return typeof listener === 'function' ? listener.call(this, next) : listener.handleEvent.call(listener, next);
      };
      messageListenerWrappers.set(listener, wrapped);
      return wrapped;
    }
    // ★window 에 직접 심으면 안 된다 — 실제 브라우저의 `window` 에는
    // addEventListener/removeEventListener 가 **own 프로퍼티로 없다**
    // (EventTarget.prototype 에만 있다). 여기에 심었더니 프록시 realm 의
    // `Object.getOwnPropertyNames(window)` 가 직접 로드와 딱 이 둘만 달랐다
    // (실측 2026-08-16, 프록시된 example.com 대 직접 example.com: EXTRA =
    // addEventListener, removeEventListener). own/inherited 대조는 안티봇이
    // 실제로 보는 축이고, 이 프로젝트는 예전에도 여분 전역(`ZP`/`ZeroProxyRT`)
    // 때문에 네이버 프로버에 걸린 적이 있다.
    // 그래서 EventTarget.prototype 을 감싸고 **수신자가 이 창일 때만** message
    // 리스너를 래핑한다. 그러면 own 프로퍼티 집합이 진짜 브라우저와 같아진다.
    const ETProto = w.EventTarget && w.EventTarget.prototype;
    if (ETProto && !propertyLocked(ETProto, 'addEventListener')) {
      const rawAdd = ETProto.addEventListener;
      const rawRemove = ETProto.removeEventListener;
      if (typeof rawAdd === 'function' && typeof rawRemove === 'function') {
        define(ETProto, 'addEventListener', function(type, listener, options) {
          if (this === w && String(type) === 'message') return rawAdd.call(this, String(type), wrap(listener), options);
          return rawAdd.apply(this, arguments);
        });
        define(ETProto, 'removeEventListener', function(type, listener, options) {
          if (this === w && String(type) === 'message') return rawRemove.call(this, String(type), messageListenerWrappers.get(listener) || listener, options);
          return rawRemove.apply(this, arguments);
        });
      }
    }
    // ★창 자신의 `postMessage` 를 **소유 속성으로 갈아끼우면 안 된다.**
    //
    // 그 래퍼는 이 창의 realm 함수다. 자식 프레임이 `parent.postMessage(...)` 를
    // 부르면 마지막으로 실행된 사용자 함수가 그 래퍼이므로 V8 이 incumbent realm
    // 을 **부모**로 잡고, 도착한 이벤트의 `e.source` 가 자식이 아니라 **부모 자신**
    // 이 된다. 그러면 `frameWindowOrigins.get(e.source)` 도 실패해서 `e.origin`
    // 까지 부모의 타깃 오리진으로 뒤집힌다.
    //
    // 실측(2026-08-25, CNN): 대조군은 20개 프레임에서 부모로 오는 메시지 **59건**
    // (bcx_local_storage_frame → https://assets.bounceexchange.com 포함).
    // 프록시는 **0건** — 4,700여 건 전부 `source === window` 로 도착했다.
    // 최소 재현으로도 확인: 부모 realm 래퍼를 끼우면 source 가 부모가 되고,
    // 네이티브를 자식 realm 에서 apply 하면 자식이 된다.
    //
    // 이것이 bounce 의 저장소 프레임 핸드셰이크를 죽이고 있었다 —
    // `e.origin === "https://" + bouncex.website.biu` 가 영영 거짓이라
    // bouncex.cookie(did/vid) 가 안 생기고 state/js → sspConfig → APS 가 막힌다.
    // SafeFrame 의 `e.source === iframe.contentWindow` 식별도 같은 이유로 깨진다.
    //
    // 페이지 코드가 보는 `postMessage` 는 멤브레인 get 트랩이 계속 래퍼를
    // 돌려주므로 targetOrigin 매핑은 그대로 산다. 부수로 지문 하나도 사라진다 —
    // 래퍼는 `length: 3` / `configurable: false` 였고 진짜는 `1` / `true` 다.
    void postMessageWrapperFor(w);
    restoreNativePostMessage(w);
    let onmessage = null;
    defineAccessor(w, 'onmessage', () => onmessage, value => {
      if (onmessage) Native.windowRemoveEventListener('message', messageListenerWrappers.get(onmessage) || onmessage);
      onmessage = typeof value === 'function' ? value : null;
      if (onmessage) Native.windowAddEventListener('message', wrap(onmessage));
    });
  }

  function usesRawURLAttribute(el, key, _localKey) {
    const tag = el && el.localName;
    const localKey = _localKey != null ? _localKey : attrLocalName(key);
    return localKey === 'href' && (tag === 'a' || tag === 'area') || localKey === 'action' && tag === 'form' || localKey === 'formaction' && (tag === 'input' || tag === 'button');
  }
  function installGetterMasking(w) {
    const locGet = p => () => new URL(virtualURL.href)[p];
    for (const p of ['href','protocol','host','hostname','port','pathname','search','hash','origin']) defineAccessor(w.Location && w.Location.prototype, p, locGet(p), p === 'href' ? v => { setVirtualLocation(v); } : p === 'hash' ? v => { updateVirtualHash(v); } : undefined);
    define(w.Location && w.Location.prototype, 'toString', function(){ return virtualURL.href; });
    defineAccessor(w.Document && w.Document.prototype, 'URL', () => virtualURL.href);
    defineAccessor(w.Document && w.Document.prototype, 'documentURI', () => virtualURL.href);
    defineAccessor(w.Document && w.Document.prototype, 'baseURI', () => baseURL);
    defineAccessor(w.Document && w.Document.prototype, 'referrer', () => '');
    defineAccessor(w.Document && w.Document.prototype, 'cookie', () => documentCookieString(), v => { const s = String(v); setDocumentCookie(s); postMessageToSW({ type: 'ZP_COOKIE_SET', tabId: boot.tabId, targetUrl: virtualURL.href, cookie: s }).catch(err => { try { root.__zp_diagnostics && root.__zp_diagnostics.push({ t: 'cookie-set-failed', code: String((err && (err.code || err.message)) || err), ck: s.slice(0, 60) }); } catch {} }); });
    installURLProp(w.HTMLAnchorElement && w.HTMLAnchorElement.prototype, 'href');
    installURLProp(w.HTMLAreaElement && w.HTMLAreaElement.prototype, 'href');
    installURLProp(w.HTMLFormElement && w.HTMLFormElement.prototype, 'action');
    // `ping` 은 클릭 시 브라우저가 **직접** POST 하는 추적 비콘 목록이다.
    // 지원하지 않기로 한 표면인데(공백 구분 URL 목록이라 단일 URL 훅으로
    // 다룰 수 없고, 통과시키는 것 자체가 목적에 반한다), 지금까지는 리라이트가
    // 놓치고 **CSP 만** 막고 있었다 — 구멍 매트릭스의 유일한 `csp-only` 칸.
    // CSP 는 2선 방어다. 값을 삼켜서 브라우저가 요청을 만들지 못하게 한다.
    // 게터는 페이지가 되읽을 수 있게 저장값을 돌려준다(기능 감지 호환).
    const pingValues = new WeakMap();
    for (const Ctor of [w.HTMLAnchorElement, w.HTMLAreaElement]) {
      const proto = Ctor && Ctor.prototype;
      if (!proto || propertyLocked(proto, 'ping')) continue;
      defineAccessor(proto, 'ping',
        function () { return pingValues.get(this) || ''; },
        function (v) {
          pingValues.set(this, String(v));
          try { Native.setAttribute.call(this, 'data-zp-blocked-ping', String(v)); } catch {}
          try { Native.removeAttribute.call(this, 'ping'); } catch {}
        });
    }
    installURLProp(w.HTMLInputElement && w.HTMLInputElement.prototype, 'formAction');
    installURLProp(w.HTMLButtonElement && w.HTMLButtonElement.prototype, 'formAction');
    // 2026-08-13 — 수동 서브리소스의 **프로퍼티 쓰기**도 훅한다.
    //
    // 여기에는 내비게이션 속성만 있었다. script 는 `installScriptProp`,
    // iframe 은 `installFrameProp` 으로 프로퍼티까지 막혀 있었는데 수동
    // 리소스만 비어 있었다 — `img.src = url` 은 setAttribute 훅을 타지 않고
    // 네이티브로 바로 속성에 꽂히므로 리라이트가 통째로 건너뛰어졌다.
    // `img-src *` 아래에서는 SW 가 받아 주니 겉으로는 멀쩡해서 안 보였다.
    //
    // 실제 사례: NAVER GNB(`gnb_utf8.nhn`)가
    //   gnbGetElementsByClassName(...)[0].children[1].src = "https://ssl.pstatic.net/…/myInfo.gif"
    // 로 넣는다. 장바구니에서 끝까지 원본 URL 로 남던 이미지 2장이 이것이었다.
    // 원본 URL 이 하나라도 남으면 CSP 를 `img-src 'self'` 로 못 죈다.
    // `link.href = url` 도 같은 구멍이다 — 2026-08-14 naver.com 실측:
    // shopad 모듈이 스타일시트를 프로퍼티 대입으로 붙여 원본 URL 이 남고
    // `style-src 'self'` 에 걸려 10건이 차단됐다. img.src 와 같은 계열.
    installURLProp(w.HTMLLinkElement && w.HTMLLinkElement.prototype, 'href');
    installURLProp(w.HTMLImageElement && w.HTMLImageElement.prototype, 'src');
    installURLProp(w.HTMLSourceElement && w.HTMLSourceElement.prototype, 'src');
    installURLProp(w.HTMLTrackElement && w.HTMLTrackElement.prototype, 'src');
    installURLProp(w.HTMLMediaElement && w.HTMLMediaElement.prototype, 'src');
    installURLProp(w.HTMLVideoElement && w.HTMLVideoElement.prototype, 'poster');
    // ★`img.srcset = …` / `link.imageSrcset = …` 프로퍼티 쓰기.
    //
    // 위 installURLProp 계열과 같은 구멍인데 srcset 만 빠져 있었다 — 프로퍼티
    // 대입은 setAttribute 훅을 안 타므로 리라이트가 통째로 건너뛰어지고,
    // **원본 타깃 URL 이 그대로 DOM 에 남는다**(2026-08-21 실측: 상대 후보는
    // 프록시 오리진으로 잘못 풀리고, 절대 후보는 원본 그대로 남아 CSP 만이
    // 방어였다). 반응형 이미지를 JS 로 붙이는 사이트에서는 이쪽이 주경로다.
    //
    // 세터는 훅된 setAttribute 에 위임한다 — 거기 srcset 분기가 후보 단위
    // 리라이트와 SW-less 업그레이드를 이미 한다. 게터는 페이지가 쓴 원본을
    // 돌려준다(없으면 실제 속성).
    function installSrcsetProp(proto, prop, attrName) {
      if (!proto || propertyLocked(proto, prop)) return;
      defineAccessor(proto, prop,
        function () {
          const recalled = recalledSrcset(this, attrName);
          if (recalled !== undefined) return recalled;
          const raw = Native.getAttribute.call(this, attrName);
          return raw == null ? '' : raw;
        },
        function (v) { this.setAttribute(attrName, v == null ? '' : String(v)); });
    }
    installSrcsetProp(w.HTMLImageElement && w.HTMLImageElement.prototype, 'srcset', 'srcset');
    installSrcsetProp(w.HTMLSourceElement && w.HTMLSourceElement.prototype, 'srcset', 'srcset');
    installSrcsetProp(w.HTMLLinkElement && w.HTMLLinkElement.prototype, 'imageSrcset', 'imagesrcset');
    // ★`meta.httpEquiv = 'Content-Security-Policy'` — 프로퍼티 경로.
    //
    // 항목 7(srcset)에서 배운 것과 같은 자리다: 프로퍼티 대입은 setAttribute
    // 훅을 안 탄다. 위 분기만 두면 `m.setAttribute(...)` 는 막히는데
    // `m.httpEquiv = ...` 는 그대로 통과한다. 게터는 페이지가 쓴 값을 돌려준다.
    if (w.HTMLMetaElement && !propertyLocked(w.HTMLMetaElement.prototype, 'httpEquiv')) {
      defineAccessor(w.HTMLMetaElement.prototype, 'httpEquiv',
        function () {
          const blocked = Native.getAttribute.call(this, 'data-zp-blocked-http-equiv');
          if (blocked !== null && blocked !== undefined) return blocked;
          return Native.getAttribute.call(this, 'http-equiv') || '';
        },
        function (v) { this.setAttribute('http-equiv', v == null ? '' : String(v)); });
    }
    // 2026-08-14 — object/embed. 서버측 htmltx 목록에는 ("object","data") /
    // ("embed","src") 가 있는데 페이지 realm 에만 없었다(정적 HTML 은 통과,
    // 런타임 대입만 샜다 — 오늘 세 번째 서버/런타임 비대칭).
    //
    // **주의: 이 두 줄만으로는 아무것도 안 고쳐진다.** 세터는 raw 값을
    // 훅된 setAttribute 로 위임하는데, 그 훅의 판정자인 `isURLBearing` 에
    // object/embed 가 없으면 그대로 통과한다. 반대로 isURLBearing 만 고치면
    // `o.data = url` 은 프로퍼티 대입이라 setAttribute 를 아예 안 탄다.
    // 두 곳을 **같이** 고쳐야 닫힌다 — 각각 따로 시도해 본 결과 둘 다 무증상
    // 실패였다.
    installURLProp(w.HTMLObjectElement && w.HTMLObjectElement.prototype, 'data');
    installURLProp(w.HTMLEmbedElement && w.HTMLEmbedElement.prototype, 'src');
    // HTMLHyperlinkElementUtils: protocol/host/hostname/port/pathname/search/
    // hash/origin/username/password. Virtualizing only `href` left every one of
    // these reading the RAW attribute, which since the 2026-06-06 escape fix is
    // a proxy-origin "?via=" launcher. Measured: `a.href='https://example.com/
    // x?q=1#f'` then `a.hostname` -> "proxy.localhost", `.pathname` -> "/zp/",
    // `.search` -> "?via=...", `.protocol` -> "http:".
    //
    // Two costs. It breaks the single most common URL-parsing idiom in the wild
    // (`a.href = u; a.hostname`) — target code reads a hostname that is not the
    // one it just wrote. And it hands page code our origin through a surface the
    // membrane exists to close, which is the same leak the `href` getter fixed.
    // Derive every component from the already-virtualized href instead.
    installURLComponents(w.HTMLAnchorElement && w.HTMLAnchorElement.prototype, 'href');
    installURLComponents(w.HTMLAreaElement && w.HTMLAreaElement.prototype, 'href');
    function installURLComponents(proto, prop) {
      if (!proto) return;
      const virt = (el) => {
        try {
          const h = el[prop];
          return h ? new Native.URL(h) : null;
        } catch { return null; }
      };
      // With no URL the components are all '' except `protocol`, which reads
      // ':' — a Web IDL quirk worth matching exactly, since it is trivially
      // checkable and a wrong answer here is a fingerprint of its own.
      for (const name of ['protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']) {
        defineAccessor(
          proto,
          name,
          function () { const u = virt(this); return u ? u[name] : (name === 'protocol' ? ':' : ''); },
          function (v) {
            const u = virt(this);
            if (!u) return;
            try { u[name] = v; } catch { return; }
            // Route back through the href setter so the raw attribute keeps its
            // "?via=" form and the blocked-scheme checks still run.
            this[prop] = u.href;
          }
        );
      }
      // `origin` is readonly in Web IDL; `toString()` mirrors href.
      defineAccessor(proto, 'origin', function () { const u = virt(this); return u ? u.origin : 'null'; });
      define(proto, 'toString', function toString() { return this[prop]; });
    }
    function installURLProp(proto, prop) {
      if (!proto) return;
      const attrName = prop === 'formAction' ? 'formaction' : prop;
      defineAccessor(
        proto,
        prop,
        function () {
          const known = urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url');
          if (known) return known;
          const raw = this.getAttribute(attrName);
          // An ABSENT attribute reads '' natively; an EMPTY one (`<a href="">`)
          // really does resolve to the document URL. The old `getAttribute() ||
          // virtualURL.href` collapsed those two cases, so a bare
          // `document.createElement('a').href` returned the page URL where every
          // browser returns '' — and each component getter inherited it.
          if (raw === null || raw === undefined) return '';
          // http(s) 가 아닌 절대 URL 은 브라우저처럼 그대로 (위 주석 참고).
          const inert = nonHTTPAbsoluteURL(raw);
          if (inert !== null) return inert;
          return targetURL(raw || virtualURL.href);
        },
        // Delegate the RAW value to the hooked Element.prototype.setAttribute.
        //
        // This setter used to duplicate that hook's work and then hand it the
        // already-proxied result (`this.setAttribute(attrName, proxyViaURL(t))`).
        // Because `this.setAttribute` IS the membrane hook, the proxy URL went
        // through URL rewriting a second time, which broke both halves of the
        // round trip (measured in the page realm on naver.com):
        //   a.href = '/probe'
        //   a.href              -> http://<proxy>/zp/?via=...   (want the target)
        //   a.getAttribute()    -> ?via=...%3Fvia%3D...         (wrapped twice)
        // The hook re-derives `targetURLForElement(this, <proxy url>)` from the
        // proxy URL and overwrites `urlMeta` with it, which is why the getter —
        // whose first source is `urlMeta` — started returning our own origin to
        // page code. One re-entrancy bug, both symptoms.
        //
        // Delegating is also strictly safer than calling Native.setAttribute
        // here: the hook owns the javascript:/blocked-scheme checks
        // (shouldBlockURLAttribute / hasContextBlockedScheme), resolves via the
        // element-aware targetURLForElement, stashes data-zp-target-url, and
        // applies the same "?via=" raw-attribute rewrite that keeps the target
        // out of browser-native UI (hover / middle-click / copy-link). Bypassing
        // it to fix the double-wrap would have opened an E1 escape instead.
        function (v) {
          this.setAttribute(attrName, v);
        }
      );
    }
  }
  // Mirror of zp-htmltx::proxied_navigation_url. Build a proxy-origin
  // "go-via launcher" URL so dynamically-created anchor/form attributes
  // never expose the target host to browser-native UI. Inert URL schemes
  // (#fragment / javascript: / data: / blob: / about: / mailto: /
  // vbscript:) pass through unchanged.
  // 2026-08-13 — 런타임이 만드는 수동 서브리소스 URL 을 서버측 htmltx 와
  // 같은 모양으로 맞춘다.
  //
  // htmltx 는 초기 HTML 의 `img/source/video/audio/track/link` URL 을
  // `/zp/api/fetch?url=…` 로 리라이트한다("strict CSP would otherwise block
  // external origins before the SW gets to intercept"). 그런데 프렐류드는
  // 같은 속성에 **절대 타깃 URL 을 그대로** 써 왔다. 그래서 JS 가 만든
  // 이미지만 원본 URL 로 남고(실측: React 가 만든 `<img>` 는
  // `https://ssl.pstatic.net/…`, htmltx 가 처리한 `<link>` 는
  // `/zp/api/fetch?url=…`), 그게 두 가지를 낳았다:
  //   (a) CSP 를 `img-src 'self'` 로 못 죈다 — 죄면 전부 깨진다.
  //   (b) srcdoc / blob 문서에서는 SW 가 클라이언트를 탭에 귀속시키지 못해
  //       그 URL 이 통째로 거절된다 (UNCLASSIFIED).
  // `tab` 을 URL 에 실어 두면 (b) 는 귀속 자체가 필요 없어진다 —
  // `/zp/api/fetch` 는 이미 명시 `?tab=` 을 받는다.
  // ★`?url=` 파라미터 인코딩은 Rust `URL_PARAM_ENCODE` 와 **바이트 단위로**
  // 같아야 한다. `encodeURIComponent` 는 `!'()*` 를 남기는데 Rust 쪽은
  // (RFC 3986 unreserved 만 남기므로) 인코딩한다. SW 는 `URLSearchParams` 로
  // 읽어서 둘 다 풀리지만, 출력이 다르면 **같은 리소스에 캐시 키가 둘** 생기고
  // `alreadyMapped` 단축이 어긋난다. 그래서 남는 다섯 글자를 마저 인코딩한다.
  function encodeURLParam(s) {
    return encodeURIComponent(String(s)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }
  function subresourceProxyPath(absolute) {
    const s = String(absolute || '');
    if (!s || s[0] === '#') return s;
    if (!/^https?:/i.test(s)) return s;
    // ★프래그먼트는 파라미터 **밖**에 둔다. 안으로 넣으면 `#` 가 `%23` 이 돼
    // 브라우저가 조각을 못 고르고, 외부 SVG 스프라이트를 참조하는 `<use>` 와
    // CSS `url(sprite.svg#icon)` 이 빈 채로 렌더된다. 서버측 htmltx 는 이미
    // 이렇게 하고 있었는데 페이지 realm 만 삼키고 있었다 — 같은 규칙의
    // 구현이 갈라진 자리다. 프래그먼트는 요청에 실리지 않으므로 SW 가 받는
    // URL 은 그대로다.
    const hash = s.indexOf('#');
    const head = hash < 0 ? s : s.slice(0, hash);
    const frag = hash < 0 ? '' : s.slice(hash);
    let out = proxyOrigin + ZP.apiPath('fetch') + '?url=' + encodeURLParam(head);
    if (boot && boot.tabId) out += '&tab=' + encodeURLParam(boot.tabId);
    return out + frag;
  }
  // ★SW-less 문서용 서브리소스 경로.
  //
  // `/zp/api/fetch` 는 **SW 안에서만 존재하는 가상 경로**다 — Go 에는 핸들러가
  // 없어서 default 로 떨어져 403 이다. 그러니 SW 클라이언트가 아닌 문서에 그
  // 경로를 박는 것은 애초에 잘못된 리라이트다. 없는 주소를 적어 주고 브라우저가
  // 403 을 받아 오는 걸 지켜보는 셈이고, 지금까지는 그걸 blob 으로 뒤늦게
  // 덮어써 왔다(그래서 로드마다 403 이 쌓였다).
  //
  // 대신 동기 XHR 이 쓰던 릴레이를 그대로 쓴다. 그 엔드포인트는 Go 가 응답을
  // park 해 두고 **SW 에 일을 넘기는** 구조라, 실제 전송은 여전히 SW 의
  // `transportFetch` 하나뿐이다 — 새 egress 도, 새 TLS 지문도 안 생긴다.
  // 동기 XHR 도 "SW 가 가로채지 못하는 요청" 이라는 점에서 같은 범주였고,
  // 그때 이미 blob 우회가 아니라 경로 교체로 푼 전례가 있다.
  function swLessRelayURL(absolute, kind) {
    const s = String(absolute || '');
    if (!/^https?:/i.test(s)) return '';
    let u = proxyOrigin + ZP.apiPath('sync-fetch')
      + '?rid=' + encodeURIComponent('sr' + ZP.randomId())
      + '&u=' + encodeURIComponent(s)
      + '&m=GET'
      + '&tab=' + encodeURIComponent((boot && boot.tabId) || '')
      + '&entry=' + encodeURIComponent(activeEntryId || '');
    if (kind) u += '&kind=' + encodeURIComponent(kind);
    return u;
  }
  // 이미 `/zp/api/fetch?url=…` 로 리라이트된 값을 릴레이 경로로 옮긴다.
  // 리라이트 단계에서 목적지 문서가 SW-less 임을 알 때만 부른다.
  function relayFromProxyPath(proxied, kind) {
    const s = String(proxied || '');
    const at = s.indexOf(ZP.apiPath('fetch') + '?url=');
    if (at < 0) return '';
    let target = '';
    try { target = new URL(s, proxyOrigin).searchParams.get('url') || ''; } catch { return ''; }
    return target ? swLessRelayURL(target, kind) : '';
  }
  // ★릴레이로 보낼 수 있는 것은 **서브리소스뿐**이다. 내비게이션(`a`/`area`/
  // `form`/`iframe`/`frame`)은 절대 여기 오면 안 된다 — 그것들은 share URL 로
  // 항해해야 하고, 릴레이는 문서가 아니라 바이트를 돌려주는 자리다.
  // `object`/`embed` 는 정책상 이미 막혀 있으므로 굳이 열지 않는다.
  // ★이미지까지 릴레이로 보내면 안 된다 — 실측으로 확인했다. 릴레이는 본문을
  // base64 로 실어 나르고 SW 가 잡을 하나씩 폴링해 처리하는 구조라, 이미지
  // 수십 건을 태우면 15초 안에 스타일시트가 못 붙는다(naver 19회 중 8회에서
  // `deadSheets` 2~4, 30초를 주면 0). blob 경로는 부모가 바이트를 바로 받아
  // 넘기므로 대량 이미지에 훨씬 유리하다.
  //
  // 그래서 역할을 나눈다: **적고 치명적인 것(스타일시트)은 릴레이**,
  // 많고 가벼운 것(이미지)은 기존 blob. 스타일시트는 403 이 text/html 본문을
  // 돌려주는 탓에 "Refused to apply style" 까지 나서 blob 으로 덮기 전까지
  // 사실상 깨진 시트였다.
  // ★이미지를 릴레이로 보내면 안 된다 — **HTTP/1.1 커넥션 한계** 때문이다.
  // 릴레이 요청은 Go 가 park 한 채 SW 가 답할 때까지 커넥션을 붙잡는다. 호스트당
  // ~6개뿐이라 이미지 수십 건이 그 자리를 채우면 스타일시트 요청이 브라우저
  // 큐에서 줄을 선다. 실측으로 확인했다: 이미지 포함 릴레이는 `deadSheets` 가
  // 6회 중 5회(1~4), `<link>` 한정은 6회 모두 0.
  //
  // base64 를 바이너리로 바꾸고 폴링을 배치로 묶어도 그대로였다 — 페이로드나
  // 왕복 수가 아니라 **점유된 커넥션 수**가 병목이라는 뜻이다. 이 벽은 프록시
  // 오리진이 HTTP/2 를 말하기 전에는 안 없어진다(멀티플렉싱이 필요하다).
  function swLessRelayable(tag, localKey) {
    return tag === 'link' && localKey === 'href';
  }
  function relayKindForElement(node, tag, localKey) {
    if (tag === 'link' && localKey === 'href') {
      const rel = String(Native.getAttribute.call(node, 'rel') || '').toLowerCase();
      // stylesheet 일 때만 CSS 리라이트를 요구한다. icon/manifest 는 원본 바이트다.
      return /(^|\s)stylesheet(\s|$)/.test(rel) ? 'style' : '';
    }
    if (tag === 'script' && localKey === 'src') return 'script';
    return '';
  }
  // ── SW 를 못 거치는 프레임의 서브리소스 (e1/e4) ────────────────────────
  // `document.write` 로 만들어진 iframe 의 document 는 SW 클라이언트가 아니다.
  // 그래서 그 안의 `/zp/api/fetch?url=…` 요청은 SW 를 지나쳐 Go 서버로 직행하고
  // 403 POLICY_BLOCKED 로 죽는다. 실측(naver 메인): safeframe 광고 프레임 6개의
  // 이미지 8건이 전부 403 인데 **같은 URL 이 최상위 문서에서는 200** 이다.
  //
  // 해결: 부모 realm 의 native fetch 로 받아서 blob URL 을 물려준다. 이미
  // `__ZP_LOAD_EXTERNAL_SCRIPT` 가 자식 스크립트에 쓰는 것과 같은 수법이고,
  // 나가는 요청은 여전히 부모의 SW 한 곳만 지난다 — 출구는 하나로 유지된다.
  // (`img-src 'self' blob:` 이라 CSP 도 그대로 통과한다.)
  const swLessDocs = new WeakMap();
  function documentIsSWLess(doc) {
    if (!doc || doc === document) return false;
    let cached = swLessDocs.get(doc);
    if (cached !== undefined) return cached;
    let url = null;
    const desc = Native.documentURLDesc;
    if (desc && desc.get) { try { url = String(desc.get.call(doc) || ''); } catch { url = null; } }
    // 판정할 수 없으면 기존 동작(직접 프록시 경로)을 쓴다 — 모르는 채로
    // blob 경로에 태우면 멀쩡한 프레임까지 느려진다.
    // 실측(naver 메인): `document.write` 로 만들어진 프레임의 document URL 은
    // **최상위 문서의 URL 그대로**다 — 자기 navigation 이 없었으니 부모 URL 을
    // 상속한다. 반대로 src 를 타고 실제로 내비게이션한 프레임은 각자 다른
    // `/zp/p/<share>` 를 갖고, 그것들은 SW 클라이언트라 지금도 200 이 온다.
    // 그래서 "내 URL 이 최상위와 같다"가 SW 클라이언트가 아니라는 신호다.
    // 프래그먼트는 떼고 비교한다 — 최상위 문서 URL 에는 `#k=…&server=…` 가
    // 붙어 있고 상속된 프레임 URL 에는 없다. 이걸 빼먹어서 한 번 헛짚었다.
    const bare = s => { const i = s.indexOf('#'); return i < 0 ? s : s.slice(0, i); };
    let topURL = null;
    if (desc && desc.get) { try { topURL = String(desc.get.call(document) || ''); } catch {} }
    const value = url === null ? false
      : (!url || url === 'about:blank' || (!!topURL && bare(url) === bare(topURL)));
    swLessDocs.set(doc, value);
    if (value) installSWLessObserver(doc);
    return value;
  }
  const swLessBlobs = new Map();
  // kind='style' 은 CSS 리라이트가 **반드시** 걸려야 한다. 부모가 대신 받는
  // 이 fetch 는 destination 이 'empty' 라 SW 의 `req.destination === 'style'`
  // 판정을 못 탄다 — 그대로 두면 `url(../../res/x.png)` 가 상대경로로 남고,
  // blob: 을 base 로 해석돼 배경이 통째로 깨진다. 문서 요청의
  // `X-ZP-Document-Request` 와 같은 방식으로 명시 신호를 준다.
  function swLessBlobURL(proxied, kind) {
    const ck = (kind || '') + '\n' + proxied;
    const hit = swLessBlobs.get(ck);
    if (hit) return hit;
    const make = Native.createObjectURL || (blob => URL.createObjectURL(blob));
    const init = kind === 'style' ? { headers: { 'X-ZP-Style-Request': '1' } } : undefined;
    let p;
    try {
      p = Promise.resolve(init ? Native.fetch(proxied, init) : Native.fetch(proxied))
        .then(r => (r && r.ok) ? r.blob() : Promise.reject(new Error('status ' + (r && r.status))))
        .then(b => make(b))
        .catch(err => { swLessBlobError = String(err && err.message || err).slice(0, 120); reportSWLessError(); return null; });
    } catch (err) {
      swLessBlobError = 'sync ' + String(err && err.message || err).slice(0, 110);
      p = Promise.resolve(null);
    }
    // 상한선 — 광고 프레임 몇 개가 만드는 양은 수십 건이다. 넘치면 캐시만
    // 포기하고 계속 동작한다.
    if (swLessBlobs.size < 400) swLessBlobs.set(ck, p);
    return p;
  }
  // 실패는 페이지가 볼 수 있는 곳에 남기지 않는다 — DOM 속성으로 찍으면
  // 그 자체가 지문이다.
  var swLessBlobError = null;
  function reportSWLessError() {
    if (!swLessBlobError) return;
    try {
      const diag = root.__zp_diagnostics;
      if (diag && diag.length < 200) diag.push({ t: 'swless-blob', msg: swLessBlobError });
    } catch {}
  }
  // 한 요소가 src 와 srcset 을 동시에 갖는 게 정상이므로 요소 단위가 아니라
  // (요소, 속성) 단위로 기억한다.
  const swLessUpgraded = new WeakMap();
  function markSWLessUpgraded(el, key) {
    let keys = swLessUpgraded.get(el);
    if (!keys) { keys = new Set(); swLessUpgraded.set(el, keys); }
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  }
  function upgradeSWLessURL(el, key, raw) {
    if (raw.indexOf(ZP.apiPath('fetch')) < 0) return;
    let doc = null;
    try { doc = el.ownerDocument; } catch {}
    if (!documentIsSWLess(doc)) return;
    if (!markSWLessUpgraded(el, key)) return;
    if (key === 'srcset' || key === 'imagesrcset') return upgradeSWLessSrcset(el, key, raw);
    swLessBlobURL(raw, key === 'href' ? 'style' : '').then(u => { if (u) try { Native.setAttribute.call(el, key, u); } catch {} });
  }
  // srcset 은 URL 하나가 아니라 `url 1x, url 2x` 후보 목록이다. 후보마다
  // 따로 blob 을 받아 URL 부분만 갈아끼운다 — 디스크립터(`1x`/`320w`)는
  // 그대로 둬야 브라우저의 후보 선택이 원본과 같다. 프록시 URL 은 타깃을
  // (예전 주석은 "프록시 URL 에는 쉼표가 없으니 split(',') 이 안전하다" 고
  //  적혀 있었다. 전제가 틀렸다 — 쉼표는 **아직 리라이트 안 된** data: 후보에
  //  들어 있다. splitSrcsetCandidates 를 쓴다.)
  function upgradeSWLessSrcset(el, key, raw) {
    const parts = splitSrcsetCandidates(raw);
    const jobs = parts.map(c => {
      if (!c.url || c.url.indexOf(ZP.apiPath('fetch')) < 0) return Promise.resolve(c.lead + c.url + c.tail);
      return swLessBlobURL(c.url, '').then(u => c.lead + (u || c.url) + c.tail);
    });
    Promise.all(jobs).then(list => { try { Native.setAttribute.call(el, key, list.join('')); } catch {} });
  }
  // `document.write` 로 만들어진 프레임 안의 서브리소스는 요소 훅도 서브트리
  // 스윕도 안 탄다 — 그 문서에 우리 MutationObserver 가 없고, adm 은 HTML
  // 문자열 단계에서 리라이트되므로 요소 경로를 아예 지나간다. 부모 쪽 백스톱
  // 스윕이 같은 오리진 자식 문서까지 훑는 것이 이들을 만나는 유일한 지점이다.
  function sweepSWLessFrames(w) {
    let frames = null;
    try { frames = (w || window).document.querySelectorAll('iframe,frame'); } catch { return; }
    if (!frames) return;
    for (const f of frames) {
      let d = null;
      try { d = f.contentDocument; } catch { continue; }
      // 분류만 해 두면 된다 — SW-less 로 판정되는 순간 옵저버가 붙는다.
      if (d) documentIsSWLess(d);
    }
  }
  function sweepSWLessDoc(doc) {
    let els = null;
    try { els = doc.querySelectorAll('img[src],img[srcset],source[src],source[srcset],video[poster],input[src],embed[src],link[rel~="stylesheet"][href]'); } catch { return; }
    for (const el of els) {
      // `<link>` 가 403 을 받으면 광고 프레임이 스타일 없이 남는다 — naver
      // 메인의 timeboard / rollingboard 크리에이티브가 정확히 이 경로였다.
      // img/source 는 src 와 srcset 을 **동시에** 가질 수 있고, 반응형
      // 크리에이티브는 srcset 만 쓰기도 한다.
      const tag = el.localName;
      const keys = tag === 'video' ? ['poster']
        : tag === 'link' ? ['href']
        : (tag === 'img' || tag === 'source') ? ['src', 'srcset']
        : ['src'];
      for (const key of keys) {
        let raw = null;
        try { raw = Native.getAttribute.call(el, key); } catch {}
        if (raw) upgradeSWLessURL(el, key, String(raw));
      }
    }
  }
  // 광고 프레임은 **비어 있는 채로 먼저 생기고** 크리에이티브는 몇 초 뒤에
  // 들어온다. 타이머 스윕(500/1500/3000ms)으로는 못 잡아서 옵저버가 필요했다.
  // 최상위 문서에 MutationObserver 를 달았다가 NAVER 하이드레이션 폭풍에
  // 렌더러가 멎은 전례가 있으므로(위 installNavigationBackstop 주석) **SW-less
  // 로 판정된 문서에만** 단다 — 광고 프레임 몇 개, 노드 수십 개짜리다.
  function installSWLessObserver(doc) {
    try {
      // ★반드시 Document 노드를 관찰한다. `document.write` 는 documentElement
      // 를 **통째로 갈아치우므로** 초기 about:blank 의 `<html>` 에 붙여 두면
      // 그 뒤 광고 마크업이 들어가는 새 트리를 하나도 못 본다 — 실측에서
      // 옵저버 16개가 붙었는데 콜백은 한 번도 안 돌았다.
      const obs = new MutationObserver(() => sweepSWLessDoc(doc));
      obs.observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'poster', 'href'] });
    } catch {}
    sweepSWLessDoc(doc);
  }
  // SW-less 문서의 이미지 자리끼우개. **네트워크 요청을 아예 안 내는** 1×1
  // 투명 PNG 다 — 그래서 원본 오리진으로 나갈 길이 없다(fail-closed 유지).
  const SWLESS_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  // 자리끼우개를 써도 되는 자리 = **이미지뿐**이다. script/link 는 src 를 나중에
  // 바꿔도 다시 실행/적용되지 않거나 별도 경로(릴레이, __ZP_LOAD_EXTERNAL_SCRIPT)
  // 가 이미 담당하므로 건드리지 않는다.
  function swLessPixelable(el, key) {
    const tag = el && el.localName;
    if (key === 'poster') return tag === 'video';
    if (key !== 'src') return false;
    return tag === 'img' || tag === 'image' || tag === 'input';
  }
  function setSubresourceAttribute(el, key, proxied) {
    let doc = null;
    try { doc = el.ownerDocument; } catch {}
    if (!documentIsSWLess(doc)) { Native.setAttribute.call(el, key, proxied); return; }
    // ★2026-08-20 — 여기에 프록시 경로를 박으면 **반드시 403 이 한 번 난다.**
    // `/zp/api/fetch` 는 SW 안에만 있는 가상 경로이고 이 문서는 SW 클라이언트가
    // 아니다. 지금까지는 그 403 을 blob 으로 뒤늦게 덮어써 왔다 — 그림은 결국
    // 뜨지만(실측: broken 0) 로드마다 헛왕복과 콘솔 에러가 쌓였다
    // (naver 메인 1회에 6건).
    //
    // 원래 프록시 경로를 박아 둔 이유는 fail-closed 였다 — blob 이 늦거나
    // 실패해도 브라우저가 타깃 오리진으로 직접 나가면 안 된다. 그 요구는
    // **요청을 아예 안 내는 값**으로 더 강하게 만족된다. 그래서 이미지에는
    // 1×1 투명 PNG 를 먼저 넣고 blob 이 오면 교체한다. 실패해도 1×1 로 남고,
    // 어느 쪽이든 밖으로 나가는 요청은 0 이다.
    const placeholder = swLessPixelable(el, key);
    Native.setAttribute.call(el, key, placeholder ? SWLESS_PIXEL : proxied);
    swLessBlobURL(proxied).then(u => { if (u) try { Native.setAttribute.call(el, key, u); } catch {} });
  }
  function proxyViaURL(absolute) {
    const s = String(absolute || '');
    if (!s) return s;
    if (s[0] === '#') return s;
    if (/^(?:javascript|mailto|data|blob|about|vbscript):/i.test(s)) return s;
    if (!/^https?:/i.test(s)) return s;
    const prefix = (typeof ZP !== 'undefined' && ZP && ZP.CONTROL_PREFIX) || '/zp/';
    return proxyOrigin + prefix + '?via=' + encodeURIComponent(s);
  }
  // 2026-06-06 backstop: NAVER / GitHub / other SPA sites use code paths
  // outside `installURLProp` setter + `setAttribute` wrap to put raw target
  // hrefs on the DOM — e.g. `cloneNode(true)` on a server-rendered template,
  // `DocumentFragment` building via direct DOM APIs that don't trip our
  // setter wraps, or strips of `data-zp-*` attributes post-load (NAVER's
  // anti-bot scrubber, see trap-notebook 2026-06-02 NAVER fingerprint
  // hide). MutationObserver re-checks every anchor / form attribute change
  // and re-applies the proxy `?via=` URL. `urlMeta` is the authoritative
  // source the click handler reads, so even if the page later strips
  // `data-zp-target-url`, the click still routes via the proxy.
  function applyNavigationBackstop(el) {
    if (!el || el.nodeType !== 1) return;
    const ln = el.localName;
    let attrName;
    if (ln === 'a' || ln === 'area') attrName = 'href';
    else if (ln === 'form') attrName = 'action';
    else if (ln === 'input' || ln === 'button') {
      if (!el.hasAttribute || !el.hasAttribute('formaction')) return;
      attrName = 'formaction';
    } else return;
    const raw = Native.getAttribute.call(el, attrName);
    if (!raw) return;
    if (raw.indexOf(proxyOrigin) === 0) return; // already proxied
    if (raw[0] === '#') return;
    if (/^(?:javascript|mailto|data|blob|about|vbscript):/i.test(raw)) return;
    let abs;
    if (/^https?:/i.test(raw)) abs = raw;
    else if (raw.indexOf('//') === 0) abs = 'https:' + raw;
    else { try { abs = new URL(raw, virtualURL.href).href; } catch { return; } }
    if (!/^https?:/i.test(abs)) return;
    urlMeta.set(el, abs);
    try { Native.setAttribute.call(el, 'data-zp-target-url', abs); } catch {}
    try { Native.setAttribute.call(el, attrName, proxyViaURL(abs)); } catch {}
  }
  // 서버측 htmltx 가 파싱 시점 `srcdoc` 을 `data-zp-srcdoc` 으로 옮겨 둔 것을
  // 되돌린다. 되돌리는 순간 후킹된 경로가 프렐류드 주입 + URL 리라이트를 한다.
  //
  // ★왜 별도 스윕이 필요한가: 최초 파싱 문서에는 MutationObserver 가 안 걸린다
  // (이 파일의 `observedDocuments` TDZ 주석 참조 — 고치면 이중 계측으로 더 크게
  // 깨진다). 그리고 기존 즉시 스윕은 `a/form/input/button/style` 만 훑는다.
  // 그래서 iframe 은 아무도 보지 않았고, 되돌리기가 영영 실행되지 않았다.
  //
  // 순서 주의: **먼저 만들고, 성공했을 때만 옮긴다.** 지우고 나서 만들면
  // injectSrcdoc 이 던졌을 때 원본까지 사라져 iframe 이 통째로 빈다.
  // 실패하면 data-zp-srcdoc 을 그대로 둔다 — 파싱되지 않으므로 fail-closed 다.
  // htmltx 가 이름만 옮겨 둔 `<iframe src>` 를 되돌린다.
  //
  // 되돌릴 때 네이티브 세터를 쓰면 안 된다 — 그러면 원본 URL 이 그대로 박혀
  // 처음 문제로 돌아간다. **후킹된 setAttribute** 를 타야 iframe 전용 경로
  // (about:blank 로 먼저 세우고 activatedFrameURL 로 share 경로를 물리는)가
  // 돈다. 실패하면 data 속성을 남겨 둔다(fail-closed): 지우고 나서 던지면
  // 프레임이 영영 빈 채로 남는다.
  function restorePendingFrameSrc(el) {
    if (!el || !Native.hasAttribute.call(el, 'data-zp-frame-src')) return;
    const pending = Native.getAttribute.call(el, 'data-zp-frame-src') || '';
    if (!pending) { try { Native.removeAttribute.call(el, 'data-zp-frame-src'); } catch {} return; }
    try {
      el.setAttribute('src', pending);
      try { Native.removeAttribute.call(el, 'data-zp-frame-src'); } catch {}
    } catch (e) {
      try { console.warn('[ZP] frame src restore failed', String(e && (e.message || e))); } catch {}
    }
  }
  function restorePendingSrcdoc(el) {
    if (!el || !Native.hasAttribute.call(el, 'data-zp-srcdoc')) return;
    const pending = Native.getAttribute.call(el, 'data-zp-srcdoc') || '';
    if (!setInjectedSrcdoc(el, pending)) return;
    try { Native.removeAttribute.call(el, 'data-zp-srcdoc'); } catch {}
  }
  function scanNavigationBackstop(root) {
    if (!root || !root.querySelectorAll) return;
    try {
      root.querySelectorAll(
        'a[href], area[href], form[action], input[formaction], button[formaction]'
      ).forEach(applyNavigationBackstop);
    } catch {}
    // iframe 은 위 목록에 없다 — 되돌리기를 여기서 같이 돈다.
    try {
      // ★우리 자신의 스텔스 멤브레인이 이 스윕을 가린다: 후킹된
      // querySelectorAll 은 `data-zp-*` 를 페이지에서 숨기려고 걸러내므로
      // 셀렉터가 **0개**를 돌려준다(실측: iframe 1개, 매칭 0). 내부 스윕은
      // 반드시 네이티브 쪽으로 물어야 한다.
      const qsa = Native.elementQuerySelectorAll || root.querySelectorAll;
      const found = qsa.call(root, 'iframe[data-zp-srcdoc], frame[data-zp-srcdoc]');
      Array.prototype.forEach.call(found, restorePendingSrcdoc);
      const pendingSrc = qsa.call(root, 'iframe[data-zp-frame-src], frame[data-zp-frame-src]');
      Array.prototype.forEach.call(pendingSrc, restorePendingFrameSrc);
    } catch {}
    // `<style>` 도 같은 백스톱이 필요하다. 두 가지가 새기 때문이다:
    // (a) 파서가 넣은 style 은 MutationObserver 가 붙기 **전**에 이미 문서에
    //     있어서 childList 로 안 잡힌다,
    // (b) 서버측 htmltx 는 zp_css 파싱이 실패하면 **원본을 그대로** 돌려준다
    //     (조용한 폴백) — 큰 시트 하나가 통째로 원본으로 남을 수 있다.
    // 실제로 naver 장바구니의 GNB 시트(39 KB, 원본 URL 25개)가 이 상태로
    // 남아 스프라이트가 `img-src 'self'` 에 걸렸다.
    try { root.querySelectorAll('style').forEach(enforceStyleElementCSS); } catch {}
  }
  function installNavigationBackstop(w, docEl) {
    if (!w || !docEl) return;
    // Single deferred sweep. Earlier draft also installed a
    // MutationObserver — that wedged the renderer on NAVER (Tauri/WebView2
    // can't drain the storm of attribute mutations a SPA emits during
    // hydration, even with `attributeFilter`). Setter / setAttribute wraps
    // already cover the JS hydration path; this sweep catches whatever the
    // server-side zp-htmltx rewrite missed on the initial document.
    scanNavigationBackstop(docEl);
    if (typeof w.requestIdleCallback === 'function') {
      try { w.requestIdleCallback(() => scanNavigationBackstop(docEl), { timeout: 2000 }); } catch {}
    } else if (typeof w.setTimeout === 'function') {
      try { w.setTimeout(() => scanNavigationBackstop(docEl), 1000); } catch {}
    }
    // 스타일시트는 위 두 번으로 부족하다. GNB 처럼 **로드 이후** 큰 `<style>`
    // 을 주입하는 모듈이 흔해서, 문서 생애주기 이벤트에 한 번씩 더 건다.
    // 이미 프록시 URL 인 시트는 `cssProxyURL` 이 걸러내므로 재실행은 무해하다.
    // 파싱 시점에 이름만 옮겨 둔 프레임 속성(`data-zp-frame-src` /
    // `data-zp-srcdoc`)을 되돌린다.
    //
    // 위의 백스톱은 "즉시 1회 + requestIdleCallback 1회" 인데 **스트리밍 문서에서
    // 그 두 번으로는 부족하다**: 즉시 스윕은 프렐류드가 문서 맨 앞에서 도는
    // 시점이라 body 가 아직 파싱되기 전이고, rIC 는 이 환경에서 안 도는 것으로
    // 보였다(실측: readyState=complete 인데 pending 이 그대로 남고 실패 경고도
    // 없다 = 아예 호출되지 않았다). 그래서 문서 생애주기 이벤트 + 타이머에
    // 얹어 다섯 번 더 기회를 준다. 이미 되돌아간 요소는 속성이 없어 재실행이
    // 무해하다.
    const sweepPendingFrames = () => {
      try {
        const qsa = Native.elementQuerySelectorAll || docEl.querySelectorAll;
        Array.prototype.forEach.call(
          qsa.call(docEl, 'iframe[data-zp-frame-src], frame[data-zp-frame-src]'),
          restorePendingFrameSrc,
        );
        Array.prototype.forEach.call(
          qsa.call(docEl, 'iframe[data-zp-srcdoc], frame[data-zp-srcdoc]'),
          restorePendingSrcdoc,
        );
      } catch {}
    };
    const sweepStyles = () => {
      try { docEl.querySelectorAll('style').forEach(enforceStyleElementCSS); } catch {}
      sweepSWLessFrames(w);
      sweepPendingFrames();
      // meta 는 파싱 도중에 늦게 나타날 수 있다 — 같은 청소 주기에 얹는다.
      reportMetaReferrerPolicy();
    };
    try { w.document.addEventListener('DOMContentLoaded', sweepStyles); } catch {}
    try { w.addEventListener('load', sweepStyles); } catch {}
    if (typeof w.setTimeout === 'function') {
      for (const ms of [500, 1500, 3000]) { try { w.setTimeout(sweepStyles, ms); } catch {} }
    }
  }
  function initDocumentCookieRecords(cookieString) {
    for (const part of String(cookieString || '').split(/;\s*/)) {
      const eq = part.indexOf('=');
      if (eq > 0) documentCookieRecords.push({ name: part.slice(0, eq), value: part.slice(eq + 1), domain: virtualURL.hostname.toLowerCase(), hostOnly: true, path: '/', secure: virtualURL.protocol === 'https:', expires: Infinity });
    }
    documentCookie = documentCookieString();
  }
  function setDocumentCookie(line) {
    const parts = String(line).split(';').map(p => p.trim()).filter(Boolean);
    if (!parts.length) return;
    const eq = parts[0].indexOf('=');
    if (eq <= 0) return;
    const rec = { name: parts[0].slice(0, eq), value: parts[0].slice(eq + 1), domain: virtualURL.hostname.toLowerCase(), hostOnly: true, path: defaultCookiePath(), secure: false, expires: Infinity };
    for (let i = 1; i < parts.length; i++) {
      const [rawK, ...rest] = parts[i].split('=');
      const k = rawK.toLowerCase();
      const v = rest.join('=');
      if (k === 'domain' && v) { const d = v.replace(/^\./, '').toLowerCase(); if (virtualURL.hostname.toLowerCase() === d || virtualURL.hostname.toLowerCase().endsWith('.' + d)) { rec.domain = d; rec.hostOnly = false; } }
      else if (k === 'path' && v && v[0] === '/') rec.path = v;
      else if (k === 'secure') rec.secure = true;
      else if (k === 'max-age') rec.expires = Date.now() + Math.max(0, Number(v) || 0) * 1000;
      else if (k === 'expires') { const ts = Date.parse(v); if (!Number.isNaN(ts)) rec.expires = ts; }
    }
    const idx = documentCookieRecords.findIndex(r => r.name === rec.name && r.domain === rec.domain && r.path === rec.path);
    if (rec.expires <= Date.now()) { if (idx >= 0) documentCookieRecords.splice(idx, 1); }
    else if (idx >= 0) documentCookieRecords[idx] = rec;
    else documentCookieRecords.push(rec);
    documentCookie = documentCookieString();
  }
  function documentCookieString() {
    const now = Date.now();
    const host = virtualURL.hostname.toLowerCase();
    const path = virtualURL.pathname || '/';
    return documentCookieRecords.filter(r => r.expires > now && (!r.secure || virtualURL.protocol === 'https:') && (r.hostOnly ? r.domain === host : host === r.domain || host.endsWith('.' + r.domain)) && (path === r.path || (path.startsWith(r.path) && (r.path.endsWith('/') || path[r.path.length] === '/')))).sort((a, b) => b.path.length - a.path.length).map(r => r.name + '=' + r.value).join('; ');
  }
  function defaultCookiePath() { const p = virtualURL.pathname || '/'; const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }

  function installStorageFacades(w) {
    // D7 hardening: every target-origin gets an isolated namespace inside the
    // proxy-origin's real storage. Persistence is preserved (key-prefixed
    // wrappers backed by native storage), and target A's keys are invisible
    // to target B. localStorage persists across reloads; sessionStorage is
    // per-tab session (additionally scoped by tabId).
    const targetOriginKey = virtualURL.origin;
    // sha1-ish short hash (FNV-1a) of origin to keep keys compact + collision-resistant for our scale.
    const originHash = (() => {
      let h = 0x811c9dc5;
      for (let i = 0; i < targetOriginKey.length; i++) { h ^= targetOriginKey.charCodeAt(i); h = Math.imul(h, 16777619); }
      return ('00000000' + (h >>> 0).toString(16)).slice(-8);
    })();
    const localPrefix = 'zp:l:' + originHash + ':';
    const cachePrefix = 'zp:c:' + originHash + ':';
    const idbPrefix = 'zp:i:' + originHash + ':';
    const bcPrefix = 'zp:b:' + originHash + ':';
    const sharedWorkerPrefix = 'zp:w:' + originHash + ':';
    // Capture native storage refs BEFORE defining the accessor: the getter
    // would otherwise recurse into itself (`w.localStorage` re-triggers the
    // accessor, causing a stack overflow that breaks every page that touches
    // storage — observed on naver.com home widgets). Cache the wrapper too
    // so repeated reads don't allocate a fresh proxy each access.
    const nativeLocalStorage = w.localStorage;
    const nativeSessionStorage = w.sessionStorage;
    // ★sessionStorage 는 **브라우저 탭 세션**에 묶여야 한다.
    //
    // 예전 접두는 `boot.tabId` 를 썼는데 그건 런처에서 Open 할 때마다 새로
    // 발급된다. 그래서 같은 탭에서 A → B → A 로 돌아오면 A 의 sessionStorage 가
    // 사라졌다. 대조군(프록시 없이 같은 순서)은 **남는다** — 실측으로 확인한
    // 재현성 결함이다(2026-08-22).
    //
    // 진짜 탭 세션의 수명을 가진 것은 **네이티브 sessionStorage 자신**이다
    // (탭마다 다르고 탭 안 내비게이션에는 살아남는다). 거기 id 를 한 번 심어
    // 두고 그걸 쓰면 브라우저 의미와 정확히 같아진다. 타깃별 격리는 originHash
    // 가 계속 담당한다.
    const tabSessionKey = '__zp_sid';
    let tabSessionId = '';
    try {
      tabSessionId = nativeSessionStorage && nativeSessionStorage.getItem(tabSessionKey);
      if (!tabSessionId) {
        tabSessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
        if (nativeSessionStorage) nativeSessionStorage.setItem(tabSessionKey, tabSessionId);
      }
    } catch { tabSessionId = boot.tabId; }
    const sessionPrefix = 'zp:s:' + tabSessionId + ':' + originHash + ':';
    let wrappedLocalStorage = null;
    let wrappedSessionStorage = null;
    defineAccessor(w, 'localStorage', () => {
      if (!wrappedLocalStorage) wrappedLocalStorage = prefixedStorage(nativeLocalStorage, localPrefix);
      return wrappedLocalStorage;
    });
    defineAccessor(w, 'sessionStorage', () => {
      if (!wrappedSessionStorage) wrappedSessionStorage = prefixedStorage(nativeSessionStorage, sessionPrefix);
      return wrappedSessionStorage;
    });
    if (w.indexedDB) {
      const nativeIDB = w.indexedDB;
      // 접근자로 심는다 — 실제 브라우저의 `window.indexedDB` 는 **접근자**이고
      // 데이터 프로퍼티로 바꿔 놓으면 디스크립터 모양만 봐도 티가 난다
      // (실측 2026-08-16: 직접 `Ace.` vs 프록시 `D-ew`).
      const virtualIDB = {
        open(name, version) { return nativeIDB.open(idbPrefix + String(name), version); },
        deleteDatabase(name) { return nativeIDB.deleteDatabase(idbPrefix + String(name)); },
        cmp: nativeIDB.cmp ? nativeIDB.cmp.bind(nativeIDB) : undefined,
        databases: nativeIDB.databases ? () => nativeIDB.databases().then(list => list.filter(db => db.name && db.name.startsWith(idbPrefix)).map(db => Object.assign({}, db, { name: db.name.slice(idbPrefix.length) }))) : undefined
      };
      defineAccessor(w, 'indexedDB', () => virtualIDB);
    }
    if (w.caches) {
      const nativeCaches = w.caches;
      // indexedDB 와 같은 이유로 접근자 — 실제 `window.caches` 는 접근자다.
      const virtualCaches = {
        open(name) { return nativeCaches.open(cachePrefix + String(name)); },
        delete(name) { return nativeCaches.delete(cachePrefix + String(name)); },
        has(name) { return nativeCaches.has(cachePrefix + String(name)); },
        keys() { return nativeCaches.keys().then(keys => keys.filter(k => k.startsWith(cachePrefix)).map(k => k.slice(cachePrefix.length))); },
        match(request, opts) { return nativeCaches.keys().then(keys => keys.filter(k => k.startsWith(cachePrefix))).then(async keys => { for (const k of keys) { const hit = await (await nativeCaches.open(k)).match(request, opts); if (hit) return hit; } return undefined; }); }
      };
      defineAccessor(w, 'caches', () => virtualCaches);
    }
    // D7: BroadcastChannel must be origin-scoped. Wrap constructor to prefix
    // channel name with target origin hash; messages from another target
    // never reach this one.
    if (w.BroadcastChannel) {
      const NativeBC = w.BroadcastChannel;
      const BCWrap = function(name) {
        const requested = String(name);
        const native = new NativeBC(bcPrefix + requested);
        // Mask `.name` so target code observes the un-prefixed channel name
        // it requested; the proxy-origin scoping must stay invisible.
        try { Object.defineProperty(native, 'name', { value: requested, configurable: true, enumerable: true }); } catch {}
        return native;
      };
      try { BCWrap.prototype = NativeBC.prototype; } catch {}
      try { define(w, 'BroadcastChannel', BCWrap); } catch {}
    }
    // D7: SharedWorker — name + URL prefix so two targets never share a worker.
    if (w.SharedWorker) {
      const NativeSW = w.SharedWorker;
      const SWWrap = function(url, opts) {
        const named = (opts && opts.name) ? Object.assign({}, opts, { name: sharedWorkerPrefix + String(opts.name) })
                                          : Object.assign({}, opts || {}, { name: sharedWorkerPrefix + 'default' });
        return new NativeSW(workerBootstrapURL(url), named);
      };
      try { SWWrap.prototype = NativeSW.prototype; } catch {}
      try { define(w, 'SharedWorker', SWWrap); } catch {}
    }
    // D7: document.origin getter returns the virtual target origin so
    // target code identifying its own origin sees its world, not the proxy.
    // `origin` was defined on Document.prototype AND on the document instance —
    // the same redundant double-define we removed from navigator/history. Only
    // `location` is genuinely an own property of a native document
    // ([LegacyUnforgeable]); origin/domain/createElement/createElementNS all
    // live on Document.prototype, so instance copies are pure fingerprint.
    if (w.document) {
      const docProto = w.Document && w.Document.prototype;
      defineOnProto(w.document, docProto, 'origin', () => virtualURL.origin);
      // document.domain getter/setter — setter accepts only target eTLD+1.
      let virtualDomain = virtualURL.hostname.toLowerCase();
      defineOnProto(
        w.document,
        docProto,
        'domain',
        () => virtualDomain,
        (v) => {
          const d = String(v).replace(/^\./, '').toLowerCase();
          const host = virtualURL.hostname.toLowerCase();
          // Allow only setting to a suffix of target host (mirror native semantics).
          if (host === d || host.endsWith('.' + d)) virtualDomain = d;
          else throw normalizedError('SecurityError');
        }
      );
    }
    // window.origin / self.origin getters — point at virtual target origin.
    try { Object.defineProperty(w, 'origin', { get() { return virtualURL.origin; }, configurable: true, enumerable: true }); } catch {}
    // D7 (removed): we used to redefine `performance.timeOrigin` to a
    // "target navigation" baseline. `boot.navigationStart` is never assigned
    // anywhere in the tree, so the baseline was always `Date.now()` at prelude
    // time — it virtualized nothing and bought us three fingerprints:
    //   1. timeOrigin + performance.now() - Date.now() = +388ms measured.
    //      Natively that skew is sub-millisecond; it is the cheapest clock
    //      consistency check there is.
    //   2. timeOrigin !== performance.timing.navigationStart. Those two are
    //      the same instant in every real browser; ours disagreed by exactly
    //      the prelude's startup cost.
    //   3. `timeOrigin` became an OWN property of the performance instance.
    //      Natively it is an accessor on Performance.prototype and the
    //      instance has no own names at all.
    // Native timeOrigin leaks nothing a target could not already get from
    // Date.now(): it is when the proxy page navigated, which is when the user
    // opened the target. Keeping native is strictly better on every axis.
    // Performance Resource Timing leaked raw proxy URLs. Entry names were the
    // only URL surface the membrane never virtualized, so
    // `performance.getEntriesByType('resource')[i].name` came back as
    // `http://<proxy>/zp/api/fetch?url=<target>`.
    //
    // Two problems, one cause:
    //   1. Locating your own script through resource timing is the standard
    //      idiom when `currentScript` is unavailable (async callbacks). NAVER's
    //      ad SDK does exactly that, then resolves `./gfp-display-sdk.js`
    //      against what it found — producing a request for
    //      `<proxy>/zp/api/gfp-display-sdk.js`, which 404s. `script.src` was
    //      already virtualized, which is why every URL-emitting path we
    //      audited looked correct: the wrong base came from here.
    //   2. It hands target code our origin and internal API paths, which the
    //      membrane exists to keep hidden.
    //
    // The target is recoverable with no bookkeeping — our proxy URLs carry it
    // in the query string (`?url=` / `?u=`), and `/zp/p/<token>` documents map
    // to the virtual URL.
    try {
      const entryProto = w.PerformanceEntry && w.PerformanceEntry.prototype;
      const nameDesc = entryProto && Object.getOwnPropertyDescriptor(entryProto, 'name');
      if (nameDesc && typeof nameDesc.get === 'function') {
        const nativeName = nameDesc.get;
        Object.defineProperty(entryProto, 'name', {
          get() { return deproxyURL(nativeName.call(this), { fallback: 'share' }); },
          configurable: true,
          enumerable: nameDesc.enumerable
        });
        // `toJSON()` serialises from internal slots, bypassing the getter, so
        // structured-clone / JSON paths would still leak the proxy URL.
        const nativeToJSON = entryProto.toJSON;
        if (typeof nativeToJSON === 'function') {
          define(entryProto, 'toJSON', function toJSON() {
            const out = nativeToJSON.call(this);
            try { if (out && typeof out === 'object' && 'name' in out) out.name = deproxyURL(out.name, { fallback: 'share' }); } catch {}
            return out;
          });
        }
        // Lookup by name receives a TARGET url from page code, which no longer
        // matches what the native index stores — resolve it ourselves.
        const perfProto = w.Performance && w.Performance.prototype;
        const nativeByName = perfProto && perfProto.getEntriesByName;
        if (typeof nativeByName === 'function') {
          define(perfProto, 'getEntriesByName', function getEntriesByName(name, type) {
            const wanted = String(name);
            const direct = nativeByName.call(this, wanted, type);
            if (direct && direct.length) return direct;
            const all = type ? this.getEntriesByType(type) : this.getEntries();
            return Array.prototype.filter.call(all, e => {
              try { return e.name === wanted; } catch { return false; }
            });
          });
        }
      }
      // ★이름만 고치고 **타이밍 필드는 그대로 둔** 것이 모순이 됐다
      // (2026-08-22 타이밍 축 신설, github 대조군 대비 실측).
      //
      //   대조군(직접) : workerStart>0  0/140,  nextHopProtocol h2/h3
      //   프록시        : workerStart>0  **196/196**, nextHopProtocol 전부 ''
      //
      // 명세상 `workerStart` 는 **서비스 워커를 지난 요청에만** 붙는다.
      // 그런데 우리는 페이지에게 `navigator.serviceWorker.controller === null` 을
      // 말해 둔다(실측 확인). 즉 **우리가 하는 말과 타이밍이 서로 모순**이고,
      // 그 모순은 한 줄로 검사된다:
      //   !navigator.serviceWorker.controller &&
      //   performance.getEntriesByType('resource').every(e => e.workerStart > 0)
      //
      // 그래서 타이밍을 우리가 이미 하고 있는 말에 맞춘다. 지어내는 게 아니라
      // **이미 한 진술과 일치시키는** 것이다 — 어긋난 값을 지어내면 새 tell 이 된다.
      const resProto = w.PerformanceResourceTiming && w.PerformanceResourceTiming.prototype;
      const timingOverrides = {
        // SW 가 없다고 말했으므로 워커 단계도 없어야 한다.
        workerStart: () => 0,
        // SW 합성 응답은 빈 문자열이 된다. 이름의 스킴으로 그럴듯한 값을 넣는다.
        nextHopProtocol: (e, raw) => {
          if (raw) return raw;
          try { return new Native.URL(e.name).protocol === 'https:' ? 'h2' : 'http/1.1'; }
          catch { return 'h2'; }
        },
        // 'cache' 는 우리 SW 가 준 것이라는 뜻이다. 페이지에겐 SW 가 없다.
        deliveryType: () => '',
        // transferSize 0 + 큰 encodedBodySize = 캡시 적중이라는 주장이다.
        // deliveryType 을 비우기로 했으니 전송량도 그에 맞춰야 한다
        // (헤더 분을 더하는 것이 브라우저의 셀셈이다).
        // 압축 크기를 아는 것만 바꿀다 — 모르면 손대지 않는다(지어내기 금지).
        encodedBodySize: (e, raw) => {
          const known = encodedSizes.get(e.name);
          return known && known < raw ? known : raw;
        },
        transferSize: (e, raw) => {
          if (raw) return raw;
          const known = encodedSizes.get(e.name);
          if (known) return known + 300;
          return e.encodedBodySize ? e.encodedBodySize + 300 : raw;
        },
        // https 리소스인데 TLS 피그가 아예 없으면 — 우리 오리진이 http 라서다.
        // 대조군은 140개 중 136개가 0 이 아니다. 재사용된 연결의 명세 모양은
        // connectStart == secureConnectionStart == connectEnd 이므로 그 값을 쓴다 —
        // 없는 숫자를 지어내는 게 아니라 **이미 있는 타임라인과 일치시킨다**.
        // http 타깃은 0 이 맞다(진짜로 TLS 가 없다).
        secureConnectionStart: (e, raw) => {
          if (raw) return raw;
          try { if (new Native.URL(e.name).protocol !== 'https:') return raw; } catch { return raw; }
          return e.connectStart || raw;
        },
      };
      if (resProto) {
        for (const key of Object.keys(timingOverrides)) {
          const desc = Object.getOwnPropertyDescriptor(resProto, key);
          if (!desc || typeof desc.get !== 'function') continue;
          const nativeGet = desc.get;
          const fix = timingOverrides[key];
          try {
            Object.defineProperty(resProto, key, {
              get() { try { return fix(this, nativeGet.call(this)); } catch { return nativeGet.call(this); } },
              configurable: true,
              enumerable: desc.enumerable,
            });
            toStringMap.set(Object.getOwnPropertyDescriptor(resProto, key).get, nativeAccessorSource('get', key));
          } catch {}
        }
        // toJSON 은 내부 슬롯에서 직렬화해 게터를 건너뛴다 — 이름과 같은 문제다.
        const nativeResToJSON = resProto.toJSON;
        if (typeof nativeResToJSON === 'function') {
          define(resProto, 'toJSON', function toJSON() {
            const out = nativeResToJSON.call(this);
            try {
              for (const key of Object.keys(timingOverrides)) {
                if (out && typeof out === 'object' && key in out) out[key] = this[key];
              }
            } catch {}
            return out;
          });
        }
      }

      // De-proxying a name only helps entries that HAVE a target behind them.
      // Our own infrastructure — /zp/assets/zp-core.js, zp-page-bundle.js,
      // runtime-prelude.js, /__zp/zp_page_rt.wasm — has none, so those four fell
      // through `return s` and sat in the list under their real names. Measured
      // on naver.com: 4 of 250 resource entries spelled out the membrane. That
      // is not a statistical tell a fingerprinter has to reason about; it is our
      // product name, readable in one call to getEntriesByType('resource').
      //
      // The right shape is absence, not renaming: a browser loading naver.com
      // directly has no such entries. Rule — if a name STILL points at the proxy
      // after de-proxying, it is infrastructure and gets dropped. That stays
      // correct as new internal routes appear, because anything we can map to a
      // target survives on its own.
      const isInfraEntry = (e) => {
        try {
          const n = e && e.name;
          return typeof n === 'string' && n.lastIndexOf(proxyOrigin, 0) === 0;
        } catch { return false; }
      };
      const perfProtoForList = w.Performance && w.Performance.prototype;
      if (perfProtoForList) {
        for (const method of ['getEntries', 'getEntriesByType', 'getEntriesByName']) {
          const native = perfProtoForList[method];
          if (typeof native !== 'function') continue;
          define(perfProtoForList, method, function (...args) {
            const out = native.apply(this, args);
            try { return Array.prototype.filter.call(out, e => !isInfraEntry(e)); } catch { return out; }
          });
        }
      }
      // PerformanceObserver is the push-based twin of the same list; without
      // this it re-leaks every name the pull path now hides.
      const NativePO = w.PerformanceObserver;
      if (typeof NativePO === 'function') {
        const ZPPerformanceObserver = function PerformanceObserver(cb) {
          const wrapped = typeof cb !== 'function' ? cb : function (list, obs) {
            const filtered = {
              getEntries: () => Array.prototype.filter.call(list.getEntries(), e => !isInfraEntry(e)),
              getEntriesByType: (t) => Array.prototype.filter.call(list.getEntriesByType(t), e => !isInfraEntry(e)),
              getEntriesByName: (n, t) => Array.prototype.filter.call(list.getEntriesByName(n, t), e => !isInfraEntry(e)),
            };
            try { Object.setPrototypeOf(filtered, Object.getPrototypeOf(list)); } catch {}
            return cb.call(this, filtered, obs);
          };
          return Reflect.construct(NativePO, [wrapped], new.target || ZPPerformanceObserver);
        };
        try { ZPPerformanceObserver.prototype = NativePO.prototype; } catch {}
        try { Object.defineProperty(ZPPerformanceObserver, 'supportedEntryTypes', { get: () => NativePO.supportedEntryTypes, configurable: true }); } catch {}
        define(w, 'PerformanceObserver', ZPPerformanceObserver);
      }
    } catch {}
    // D7: Notification permission state must be per-target-origin. Wrap the
    // static permission getter; granting is still gated by the native browser
    // UI but target code seeing 'default'/'denied' will react in its own
    // origin namespace.
    if (w.Notification) {
      const NativeN = w.Notification;
      // We cannot fully isolate native notification permissions, but we can
      // override the static getter to return per-origin state held in
      // localStorage namespace. Setter via requestPermission still calls
      // native (browser UI consent gate).
      try {
        const permKey = '__zp_notif_perm';
        // 2026-08-12 — **네이티브 게터를 먼저 잡아 둔다.**
        // 예전 코드는 폴백으로 `NativeN.permission` 을 읽었는데, `NativeN` 이
        // 바로 이 프로퍼티를 정의하는 객체라 **자기 자신을 무한 재귀 호출**했다.
        // 저장값이 없을 때(= 권한을 건드린 적 없는 보통 경우)만 터지므로 오래
        // 숨어 있었고, 실제로 NAVER anti-bot 이 `Notification.permission` 을 읽는
        // 순간 스택 오버플로 폭풍(`Maximum call stack size exceeded` 3,2xx건)이
        // 나면서 렌더러가 수십 초 멈췄다. `clear-site-data` 로 저장값이 지워지면
        // 재현되고 남아 있으면 안 나서, 증상이 간헐적으로 보였다.
        const nativePermDesc = Object.getOwnPropertyDescriptor(NativeN, 'permission');
        const nativePerm = nativePermDesc && nativePermDesc.get
          ? nativePermDesc.get.bind(NativeN)
          : () => (nativePermDesc ? nativePermDesc.value : 'default');
        Object.defineProperty(NativeN, 'permission', {
          get() {
            try {
              const stored = prefixedStorage(nativeLocalStorage, localPrefix).getItem(permKey);
              if (stored) return stored;
            } catch {}
            try { return nativePerm(); } catch { return 'default'; }
          },
          configurable: true,
        });
        const nativeRP = NativeN.requestPermission ? NativeN.requestPermission.bind(NativeN) : null;
        if (nativeRP) {
          define(NativeN, 'requestPermission', function(callback) {
            return Promise.resolve(nativeRP()).then(result => {
              try { prefixedStorage(nativeLocalStorage, localPrefix).setItem(permKey, String(result)); } catch {}
              if (typeof callback === 'function') try { callback(result); } catch {}
              return result;
            });
          });
        }
      } catch {}
    }
    // D7: navigator.permissions.query — record target-origin state, return
    // virtualised state if known, else fall through to native (which still
    // resolves against the proxy origin's grants).
    if (w.navigator && w.navigator.permissions && w.navigator.permissions.query) {
      const nativeQuery = w.navigator.permissions.query.bind(w.navigator.permissions);
      define(w.navigator.permissions, 'query', function(desc) {
        return nativeQuery(desc).then(status => {
          // Best-effort: target code observes the proxy-origin permission
          // state but cross-target inference cannot tell who else has the
          // grant (since SW + storage isolation hide it). Future phase:
          // synthesize PermissionStatus from per-target storage namespace.
          return status;
        });
      });
    }
  }
  function prefixedStorage(native, prefix) {
    // Wrap native localStorage/sessionStorage with a fixed key prefix. All
    // reads/writes/iteration are scoped to the target origin namespace.
    if (!native) return null;
    // ★우리 진단 키(`__zp_hb`, `__zp_trace_log`)를 페이지에서 숨긴다.
    //
    // 실측(2026-08-22): 페이지가 `localStorage.key(i)` 로 열거하면 저 둘이
    // 그대로 보였다 = **프록시라는 지문**. 네이티브 저장소를 보니 접두 없는
    // 사본과 `zp:l:<hash>:` 접두가 붙은 사본이 **둘 다** 있었다 — 즉 어떤
    // 경로는 네이티브로, 어떤 경로는 파사드를 타고 타깃 네임스페이스로 들어갔다
    // (프렐류드가 자식 realm 에서 다시 평가될 때 캡처 순서가 뒤집힌다).
    //
    // 캡처 순서를 realm 마다 맞추는 것보다 **파사드에서 거르는 쪽**이 확실하다 —
    // 어느 경로로 들어오든 페이지에는 안 보인다. 타깃이 `__zp_` 로 시작하는 키를
    // 쓸 확률은 무시할 만하고, 쓴다면 어차피 우리와 충돌한다.
    const hidden = (name) => String(name).startsWith('__zp_');
    const facade = {
      get length() {
        let n = 0;
        for (let i = 0; i < native.length; i++) {
          const k = native.key(i);
          if (k && k.startsWith(prefix) && !hidden(k.slice(prefix.length))) n++;
        }
        return n;
      },
      key(i) {
        i = Number(i);
        let seen = 0;
        for (let j = 0; j < native.length; j++) {
          const k = native.key(j);
          if (k && k.startsWith(prefix) && !hidden(k.slice(prefix.length))) {
            if (seen === i) return k.slice(prefix.length);
            seen++;
          }
        }
        return null;
      },
      getItem(k) { return hidden(k) ? null : native.getItem(prefix + String(k)); },
      setItem(k, v) { native.setItem(prefix + String(k), String(v)); },
      removeItem(k) { native.removeItem(prefix + String(k)); },
      clear() {
        const toDelete = [];
        for (let i = 0; i < native.length; i++) {
          const k = native.key(i);
          if (k && k.startsWith(prefix)) toDelete.push(k);
        }
        for (const k of toDelete) native.removeItem(k);
      },
    };
    // ★진짜 Storage 는 **이름 기반 접근**을 지원한다: `localStorage.token = 'x'`
    // 로 쓰고 `localStorage.token` 으로 읽으며 `'token' in localStorage` 가
    // true 다. 아주 흔한 관용구인데, 여섯 멤버만 가진 frozen 평범한 객체는
    // 그 쓰기를 **조용히 삼킨다**(비엄격 모드라 throw 도 없다) → 사이트의
    // 저장이 통째로 사라진다. 게다가 `Object.keys(localStorage)` 가 저장된
    // 키가 아니라 **메서드 이름**을 돌려줘서 그 자체로 지문이었다
    // (length 는 4인데 키는 6개로 자기모순).
    //
    // 그래서 멤버는 프로토타입에 non-enumerable 로 두고(= 자체 own 속성 0),
    // 항목 접근은 Proxy 로 위임한다. own 속성이 없어야 frozen target 의
    // ownKeys 불변식에 걸리지 않는다.
    const RESERVED = new Set(['length', 'key', 'getItem', 'setItem', 'removeItem', 'clear']);
    const storageProto = Object.create(
      (typeof Storage === 'function' && Storage.prototype) ? Storage.prototype : Object.prototype
    );
    Object.defineProperty(storageProto, 'length', {
      get() { return facade.length; }, enumerable: false, configurable: true,
    });
    for (const name of ['key', 'getItem', 'setItem', 'removeItem', 'clear']) {
      const fn = function() { return facade[name].apply(facade, arguments); };
      maskNativeFunction(fn, name);
      Object.defineProperty(storageProto, name, { value: fn, enumerable: false, writable: true, configurable: true });
    }
    const storedKeys = () => {
      const out = [];
      for (let i = 0; i < native.length; i++) {
        const k = native.key(i);
        if (k && k.startsWith(prefix) && !hidden(k.slice(prefix.length))) out.push(k.slice(prefix.length));
      }
      return out;
    };
    const namedStorage = new Proxy(Object.create(storageProto), {
      get(t, p, r) {
        if (typeof p === 'symbol' || RESERVED.has(p)) return Reflect.get(t, p, r);
        const v = facade.getItem(p);
        return v === null ? undefined : v;
      },
      set(t, p, v) {
        if (typeof p === 'symbol' || RESERVED.has(p)) return Reflect.set(t, p, v, t);
        facade.setItem(p, v);
        return true;
      },
      has(t, p) {
        if (typeof p === 'symbol' || RESERVED.has(p)) return Reflect.has(t, p);
        return facade.getItem(p) !== null;
      },
      deleteProperty(t, p) {
        if (typeof p === 'symbol' || RESERVED.has(p)) return Reflect.deleteProperty(t, p);
        facade.removeItem(p);
        return true;
      },
      ownKeys() { return storedKeys(); },
      getOwnPropertyDescriptor(t, p) {
        if (typeof p === 'symbol' || RESERVED.has(p)) return Reflect.getOwnPropertyDescriptor(t, p);
        const v = facade.getItem(p);
        return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
      },
      defineProperty(t, p, desc) {
        if (typeof p === 'symbol' || RESERVED.has(p)) return Reflect.defineProperty(t, p, desc);
        if ('value' in desc) facade.setItem(p, desc.value);
        return true;
      },
    });
    // Root the facade at Storage.prototype BEFORE freezing: a frozen object is
    // non-extensible, so a later setPrototypeOf throws (tried 2026-08-03 at the
    // call sites — silently no-op). Safe because the facade owns all six
    // Storage members, so the native implementations stay shadowed and never
    // receive an unbranded `this`. Without this,
    // `localStorage instanceof Storage` is false and
    // `Object.prototype.toString.call(localStorage)` is "[object Object]"
    // instead of "[object Storage]" — a fingerprint, and a break for code that
    // type-checks a Storage argument.
    try {
      if (typeof Storage === 'function' && Storage.prototype) Object.setPrototypeOf(facade, Storage.prototype);
    } catch {}
    Object.freeze(facade);
    return namedStorage;
  }
  function dispatchStorageEvents(namespaceKey, sourceWindow, key, oldValue, newValue) {
    for (const rec of Array.from(storageWindows)) {
      const w = rec.w;
      if (!w || w === sourceWindow || (rec.localKey !== namespaceKey && rec.sessionKey !== namespaceKey)) continue;
      try {
        const ev = new w.StorageEvent('storage', { key, oldValue, newValue, url: virtualURL.href });
        w.dispatchEvent(ev);
      } catch { try { w.dispatchEvent(new Event('storage')); } catch {} }
    }
  }
  function attrLocalName(key) {
    const s = String(key || '').toLowerCase();
    const i = s.indexOf(':');
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function tokenListContains(list, token) {
    return String(list || '').toLowerCase().split(/[\s,]+/).includes(token);
  }
  function isBlockedLinkRelValue(rel) {
    for (const token of ['modulepreload','preload','prefetch','preconnect','dns-prefetch','prerender','manifest']) {
      if (tokenListContains(rel, token)) return true;
    }
    return false;
  }
  function isIconLinkRelValue(rel) {
    for (const token of String(rel || '').toLowerCase().split(/[\s,]+/)) {
      if (token === 'icon' || token === 'mask-icon' || token === 'apple-touch-icon' || token === 'apple-touch-icon-precomposed' || token === 'apple-touch-startup-image' || token === 'fluid-icon') return true;
    }
    return false;
  }
  function isBlockedLink(el) { return el && el.localName === 'link' && isBlockedLinkRelValue(Native.getAttribute.call(el, 'rel') || ''); }
  function isIconLink(el) { return el && el.localName === 'link' && isIconLinkRelValue(Native.getAttribute.call(el, 'rel') || ''); }
  function hasSuppressedBlockedLinkRel(el) { return el && el.localName === 'link' && isBlockedLinkRelValue(Native.getAttribute.call(el, 'data-zp-blocked-rel') || ''); }
  function visibleLinkTarget(el) { return urlMeta.get(el) || Native.getAttribute.call(el, 'data-zp-target-url') || ''; }
  function suppressBlockedLinkRel(el, rawRel) {
    Native.setAttribute.call(el, 'data-zp-blocked-rel', String(rawRel));
    if (Native.removeAttribute) Native.removeAttribute.call(el, 'rel');
    blockLinkURL(el, Native.getAttribute.call(el, 'href') || '');
  }
  function blockLinkURL(el, raw) {
    if (raw != null && String(raw) !== '') Native.setAttribute.call(el, 'data-zp-blocked-url', String(raw));
    urlMeta.delete(el);
    if (Native.removeAttribute) Native.removeAttribute.call(el, 'href');
  }
  function suppressIconLinkHref(el, raw) {
    const value = raw == null ? '' : String(raw);
    let visible = value;
    if (value) {
      const t = targetURLForElement(el, value);
      if (t) visible = t;
    }
    const currentVisible = Native.getAttribute.call(el, 'data-zp-target-url') || '';
    const currentHref = Native.getAttribute.call(el, 'href') || '';
    if (visible) {
      urlMeta.set(el, visible);
      if (currentVisible !== visible) Native.setAttribute.call(el, 'data-zp-target-url', visible);
    } else {
      urlMeta.delete(el);
      if (currentVisible && Native.removeAttribute) Native.removeAttribute.call(el, 'data-zp-target-url');
    }
    if (currentHref !== hiddenIconHref) Native.setAttribute.call(el, 'href', hiddenIconHref);
  }
  function enforceLinkPolicy(el) {
    if (!el || el.localName !== 'link') return;
    const rel = Native.getAttribute.call(el, 'rel') || '';
    if (isBlockedLinkRelValue(rel)) {
      suppressBlockedLinkRel(el, rel);
      return;
    }
    if (rel && Native.removeAttribute) Native.removeAttribute.call(el, 'data-zp-blocked-rel');
    if (hasSuppressedBlockedLinkRel(el)) {
      blockLinkURL(el, Native.getAttribute.call(el, 'href') || '');
      return;
    }
    if (isIconLinkRelValue(rel)) {
      suppressIconLinkHref(el, visibleLinkTarget(el) || Native.getAttribute.call(el, 'href') || '');
      return;
    }
    if (Native.getAttribute.call(el, 'href') === hiddenIconHref) {
      const restored = visibleLinkTarget(el);
      if (restored) Native.setAttribute.call(el, 'href', restored);
      else if (Native.removeAttribute) Native.removeAttribute.call(el, 'href');
    }
    const href = Native.getAttribute.call(el, 'href') || '';
    if (href && !String(href).startsWith(proxyOrigin)) {
      const target = targetURLForElement(el, href);
      if (target) {
        const alreadyMapped = urlMeta.get(el) === target && Native.getAttribute.call(el, 'data-zp-target-url') === target && Native.getAttribute.call(el, 'href') === target;
        urlMeta.set(el, target);
        if (Native.getAttribute.call(el, 'data-zp-target-url') !== target) Native.setAttribute.call(el, 'data-zp-target-url', target);
        const proxied = subresourceProxyPath(target);
        if (!alreadyMapped && Native.getAttribute.call(el, 'href') !== proxied) Native.setAttribute.call(el, 'href', proxied);
      }
    }
  }
  function visibleIconAttrValue(attr) {
    const owner = attr && attr.ownerElement;
    if (!owner || owner.localName !== 'link' || String(attr.name || '').toLowerCase() !== 'href' || !isIconLinkRelValue(Native.getAttribute.call(owner, 'rel') || '')) return null;
    return visibleLinkTarget(owner) || Native.getAttribute.call(owner, 'href') || '';
  }
  function restoreVisibleLinkState(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.localName === 'link' && isIconLinkRelValue(Native.getAttribute.call(node, 'rel') || '')) {
      const target = Native.getAttribute.call(node, 'data-zp-target-url') || '';
      if (target) Native.setAttribute.call(node, 'href', target);
    }
  }
  function isNavigationTargetElement(el) {
    const tag = el && el.localName;
    return tag === 'a' || tag === 'area' || tag === 'form' || tag === 'button' || tag === 'input';
  }
  function isFrameElement(el) {
    const tag = el && el.localName;
    return tag === 'iframe' || tag === 'frame';
  }
  // The dangerous combination: with both tokens together browsers refuse to
  // enforce the sandbox at all, so target sites use this as a hostile-embed
  // detection signal. Membrane already isolates the iframe; we virtualize the
  // attribute so the detection sees its set value while the DOM remains clean.
  function frameSandboxAllowsEscape(raw) {
    const tokens = new Set(String(raw || '').toLowerCase().split(/\s+/).filter(Boolean));
    return tokens.has('allow-scripts') && tokens.has('allow-same-origin');
  }
  function setFrameSandboxAttribute(el, raw) {
    const value = String(raw == null ? '' : raw);
    if (frameSandboxAllowsEscape(value)) {
      frameSandboxMeta.set(el, value);
      if (Native.removeAttribute) Native.removeAttribute.call(el, 'sandbox');
      return;
    }
    frameSandboxMeta.delete(el);
    Native.setAttribute.call(el, 'sandbox', value);
  }
  // Called from insertion / srcdoc / src enforcement paths: if the element
  // already carries a dangerous sandbox attribute when it appears in the DOM,
  // virtualize it before the browser commits the sandbox enforcement.
  function sanitizeFrameSandbox(el) {
    if (!isFrameElement(el)) return;
    const raw = Native.getAttribute.call(el, 'sandbox');
    if (raw !== null && frameSandboxAllowsEscape(raw)) {
      frameSandboxMeta.set(el, raw);
      if (Native.removeAttribute) Native.removeAttribute.call(el, 'sandbox');
    }
  }
  function setSafeNavigationTarget(el, attrName, value) {
    const raw = String(value || '');
    if (raw && raw !== '_self') Native.setAttribute.call(el, 'data-zp-blocked-target', raw);
    return Native.setAttribute.call(el, attrName, '_self');
  }
  function isZPAttrName(name) { return String(name || '').toLowerCase().startsWith('data-zp-'); }
  function isZeroProxyAssetURL(raw) {
    if (!raw) return false;
    try {
      const u = new URL(String(raw), proxyOrigin);
      // 목록은 zp-core 단일 소스다. 예전에는 여기가 sw.js 목록의
      // **부분집합**(3/7)이라 빠진 자산은 직렬화 세정에서 안 지워졌다.
      return u.origin === proxyOrigin && ZP.isInternalAssetScriptPath(u.pathname);
    } catch { return false; }
  }
  // ★2026-08-22 — `iframe.srcdoc` 은 우리가 프렐류드 주입 + URL 리라이트를 한
  // 결과로 **덮어쓴다**. 그래서 페이지가 그 값을 다시 읽으면(속성 / 프로퍼티 /
  // 직렬화) 주입한 스크립트 태그와 `data-zp-*` 가 통째로 보인다. 지문 측정에서
  // 남은 9건이 전부 여기였다 — 살아 있는 속성은 세정기가 훑지만 **속성 값 안의
  // 중첩 마크업**까지는 안 들어갔다. 값을 사후에 문자열로 씻는 대신 페이지가
  // 준 원본을 붙들어 두고 읽기 표면이 그것을 돌려주게 한다(재현성도 같이 맞다).
  const srcdocMeta = new WeakMap();
  function setInjectedSrcdoc(el, raw) {
    const s = String(raw == null ? '' : raw);
    let injected = null;
    try { injected = injectSrcdoc(s); }
    catch (e) { try { console.warn('[ZP] srcdoc restore failed', String(e && (e.message || e))); } catch {} }
    if (injected == null) return false;
    srcdocMeta.set(el, s);
    Native.setAttribute.call(el, 'srcdoc', injected);
    return true;
  }
  function isZPAssetNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.id === '__zp-boot') return true;
    // SW 가 문서 앞에 박는 인라인 스크립트 / CSP meta 는 src 가 없어
    // URL 로 못 알아본다 — 표식을 보고 떼어낸다.
    if (Native.hasAttribute && Native.hasAttribute.call(node, 'data-zp-internal')) return true;
    return node.localName === 'script' && isZeroProxyAssetURL(Native.getAttribute.call(node, 'src'));
  }
  // 진짜 DOM 은 `el.attributes === el.attributes` 가 true 다. 접근마다 새
  // 프록시를 만들면 그 자체가 후킹을 드러낸다(컬렉션 메서드 동일성과 같은 이유).
  const namedNodeMapCache = new WeakMap();
  function filteredNamedNodeMap(raw) {
    if (!raw) return raw;
    const hit = namedNodeMapCache.get(raw);
    if (hit) return hit;
    const wrapped = filteredCollection(raw, attr => attr && !isZPAttrName(attr.name));
    namedNodeMapCache.set(raw, wrapped);
    return wrapped;
  }
  // ★`data-zp-*` 이름공간을 **규칙으로** 닫는다(2026-08-26).
  //
  // 예전에는 훅이 `getAttribute`/`hasAttribute`/`getAttributeNames`/
  // `attributes` **네 개뿐**이었다. 손으로 고른 목록이라 나머지가 전부
  // 뚫려 있었다 — 실측(example.com, 프록시):
  //
  //   읽기  el.attributes['data-zp-target-url']   → Attr (named getter 폴백)
  //         'data-zp-target-url' in el.attributes → true
  //         el.getAttributeNode / getAttributeNodeNS → Attr
  //         el.getAttributeNS / hasAttributeNS       → 값 / true
  //         el.dataset.zpTargetUrl                   → 값
  //   쓰기  setAttribute / setAttributeNS / toggleAttribute /
  //         setAttributeNode / attributes.setNamedItem / dataset → 전부 씀
  //   삭제  removeAttribute / removeAttributeNS → 우리 스태시가 실제로 지워졌다
  //
  // 링크의 진짜 타깃 URL 이 그대로 새어 나오고, `data-zp-internal` 을 심으면
  // 자기 노드를 컬렉션에서 지울 수 있었다(1건 → 0건) — 진짜 브라우저가
  // 재현하지 못하는 **한 줄짜리 ZeroProxy 탐지기**다.
  //
  // 그래서 표면을 나열하지 않고 **한 규칙**으로 닫는다: 이름이 `data-zp-` 로
  // 시작하면 읽기는 "없음", 쓰기·삭제는 no-op. 이 저장소가 srcset·엔티티·
  // 컬렉션에서 이미 세 번 배운 것과 같은 교훈이다 — 목록으로 따라가는 자리는
  // 결국 뚫린다.
  function datasetKeyToAttrName(key) {
    return 'data-' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase());
  }
  function isZPDatasetKey(key) {
    // dataset 은 사이트가 초당 수백 번 읽는 자리다 — 우리 접두사가 아니면
    // 문자열을 만들기 전에 두 글자 비교로 빠져나간다.
    if (typeof key !== 'string' || key.charCodeAt(0) !== 122 || key.charCodeAt(1) !== 112) return false;
    return isZPAttrName(datasetKeyToAttrName(key));
  }
  const datasetCache = new WeakMap();
  function filteredDataset(raw) {
    if (!raw) return raw;
    const hit = datasetCache.get(raw);
    if (hit) return hit;
    const proxied = new Proxy(raw, {
      get(t, prop) { if (isZPDatasetKey(prop)) return undefined; const v = t[prop]; return typeof v === 'function' ? v.bind(t) : v; },
      has(t, prop) { return isZPDatasetKey(prop) ? false : prop in t; },
      set(t, prop, v) { if (isZPDatasetKey(prop)) return true; t[prop] = v; return true; },
      deleteProperty(t, prop) { if (isZPDatasetKey(prop)) return true; delete t[prop]; return true; },
      ownKeys(t) { return Reflect.ownKeys(t).filter(k => !isZPDatasetKey(k)); },
      getOwnPropertyDescriptor(t, prop) { return isZPDatasetKey(prop) ? undefined : Reflect.getOwnPropertyDescriptor(t, prop); },
    });
    datasetCache.set(raw, proxied);
    return proxied;
  }
  function installZPAttrNamespace(w) {
    const E = w.Element && w.Element.prototype;
    if (!E) return;
    // NS 변종은 `setAttributeNS` 훅이 이미 그러듯 **같은 뜻이면 같은 코드로**
    // 보낸다 — 부분집합 훅이 다시 생기지 않게.
    const plainNS = (ns, k, key) => (ns === null || ns === undefined || ns === '') && String(k) === key;
    if (Native.getAttributeNS) define(E, 'getAttributeNS', function(ns, k) {
      const key = String(k).toLowerCase();
      if (isZPAttrName(key)) return null;
      if (plainNS(ns, k, key)) return this.getAttribute(k);
      return Native.getAttributeNS.call(this, ns, k);
    });
    if (Native.hasAttributeNS) define(E, 'hasAttributeNS', function(ns, k) {
      const key = String(k).toLowerCase();
      if (isZPAttrName(key)) return false;
      if (plainNS(ns, k, key)) return this.hasAttribute(k);
      return Native.hasAttributeNS.call(this, ns, k);
    });
    if (Native.removeAttributeNS) define(E, 'removeAttributeNS', function(ns, k) {
      const key = String(k).toLowerCase();
      if (isZPAttrName(key)) return undefined;
      if (plainNS(ns, k, key)) return this.removeAttribute(k);
      return Native.removeAttributeNS.call(this, ns, k);
    });
    if (Native.getAttributeNode) define(E, 'getAttributeNode', function(k) {
      return isZPAttrName(k) ? null : Native.getAttributeNode.call(this, k);
    });
    if (Native.getAttributeNodeNS) define(E, 'getAttributeNodeNS', function(ns, k) {
      return isZPAttrName(k) ? null : Native.getAttributeNodeNS.call(this, ns, k);
    });
    // Attr 노드를 통한 쓰기도 같은 규칙. 진짜 브라우저는 교체된 Attr 이나 null
    // 을 돌려주므로 null 이 정직한 "없었다" 다.
    if (Native.setAttributeNode) define(E, 'setAttributeNode', function(attr) {
      return attr && isZPAttrName(attr.name) ? null : Native.setAttributeNode.call(this, attr);
    });
    if (Native.setAttributeNodeNS) define(E, 'setAttributeNodeNS', function(attr) {
      return attr && isZPAttrName(attr.name) ? null : Native.setAttributeNodeNS.call(this, attr);
    });
    if (Native.removeAttributeNode) define(E, 'removeAttributeNode', function(attr) {
      return attr && isZPAttrName(attr.name) ? attr : Native.removeAttributeNode.call(this, attr);
    });
    if (Native.toggleAttribute) define(E, 'toggleAttribute', function(k, force) {
      // 읽기가 "없음" 이므로 토글 결과도 "없음"(false)이어야 한다.
      return isZPAttrName(k) ? false : Native.toggleAttribute.call(this, k, force);
    });
    if (Native.namedRemoveNamedItem && w.NamedNodeMap) define(w.NamedNodeMap.prototype, 'removeNamedItem', function(k) {
      // 진짜 브라우저는 없는 이름에 NotFoundError 를 던진다 — 읽기와 같은
      // 그림을 유지하려면 여기서도 던져야 한다.
      if (isZPAttrName(k)) throw new w.DOMException("Failed to execute 'removeNamedItem' on 'NamedNodeMap': No item with name '" + String(k) + "' was found.", 'NotFoundError');
      return Native.namedRemoveNamedItem.call(this, k);
    });
    if (Native.htmlDataset && Native.htmlDataset.get && w.HTMLElement) installDatasetHook(w.HTMLElement.prototype, Native.htmlDataset);
    if (Native.svgDataset && Native.svgDataset.get && w.SVGElement) installDatasetHook(w.SVGElement.prototype, Native.svgDataset);
  }
  function installDatasetHook(proto, desc) {
    try { Object.defineProperty(proto, 'dataset', { get() { return filteredDataset(desc.get.call(this)); }, enumerable: desc.enumerable, configurable: false }); } catch {}
  }
  function isIndexKey(prop) {
    return typeof prop !== 'symbol' && /^(?:0|[1-9]\d*)$/.test(String(prop));
  }
  // 컬렉션의 **항목**인가 (Node 이거나 Attr). 술어는 항목에만 뜻이 있다.
  function isFilterableItem(value) {
    return !!value && typeof value === 'object' && (value.nodeType !== undefined || value.ownerElement !== undefined);
  }
  function filteredCollection(raw, predicate) {
    // ★2026-08-24 — 예전에는 `nth`/`length` 가 **호출될 때마다 원본 전체를
    // 다시 훑었다.** 그리고 순회는 `for (i = 0; i < length(); i++) yield nth(i)`
    // 라 걸음마다 두 번씩 훑었다 — 즉 **한 번 순회가 O(N²)** 이고, 술어
    // (`isZPAssetNode`)는 script 마다 `getAttribute` 를 부른다.
    //
    // CNN 에서 렌더러가 통째로 멎었다. GPT(`pubads_impl.js`)가
    // `querySelectorAll('script')` 결과를 for-of 로 도는데, 스크립트가 ~900개라
    // 900 × 1800 ≈ 1.6M 번의 술어 평가 = **getAttribute 1,733,614회**(실측).
    // 대조군(직접 로드)의 같은 계수기는 **2,087** 이었다 — 830배. 페이지 코드가
    // 아니라 **우리가 만든 호출**이다.
    //
    // 한 번만 훑어 배열로 만들어 둔다. 원본 길이가 변하면 다시 만든다 —
    // `querySelectorAll` 결과는 정적이라 한 번으로 끝나고, live 컬렉션
    // (`attributes`/`document.scripts`)은 항목이 늘거나 줄 때 길이가 바뀐다.
    let cache = null;
    let cacheLen = -1;
    const items = () => {
      const rawLen = raw ? raw.length : 0;
      if (cache && cacheLen === rawLen) return cache;
      const out = [];
      for (let i = 0; i < rawLen; i++) {
        const item = raw[i];
        if (predicate(item)) out.push(item);
      }
      cache = out;
      cacheLen = rawLen;
      return out;
    };
    const nth = index => {
      const arr = items();
      return index >= 0 && index < arr.length ? arr[index] : null;
    };
    const length = () => items().length;
    // ★표면은 **raw 가 실제로 가진 것만** 노출한다(2026-08-24).
    //
    // 예전에는 여섯 호출처에 한 벌의 가짜 표면을 씌웠다. 실브라우저 실측:
    //   NodeList        forEach/values/keys/entries 있음
    //   HTMLCollection  넷 다 undefined   (document.scripts, getElementsByTagName)
    //   NamedNodeMap    넷 다 undefined   (attributes)
    // 그래서 `'forEach' in c === false` 인데 `typeof c.forEach === 'function'` 인
    // **자기모순**이 났다 — 사이트와 무관한 한 줄짜리 탐지기다(실측: 어느 사이트든
    // 똑같이 15건).
    //
    // `prop in raw` 로 게이트하면 live/static 구분이 저절로 맞고, 유지할 목록이
    // 따로 없다 — 감싼 대상이 곧 명세다.
    const inRaw = (prop) => { try { return !!raw && prop in raw; } catch { return false; } };
    // 실제 DOM 은 `nl.forEach === nl.forEach`, `hc.item === hc.item` 이 true 다.
    // `get` 트랩에서 매번 새로 만들면 그 자체가 후킹을 드러낸다.
    let itemFn = null;
    let getNamedItemFn = null;
    const boundFns = new Map();
    const collection = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'length') return length();
        if (prop === 'item' && inRaw('item')) return itemFn || (itemFn = index => nth(Number(index) || 0));
        if (prop === 'getNamedItem' && inRaw('getNamedItem')) return getNamedItemFn || (getNamedItemFn = name => {
          const lower = String(name || '').toLowerCase();
          if (isZPAttrName(lower)) return null;
          for (let i = 0; raw && i < raw.length; i++) if (raw[i] && String(raw[i].name).toLowerCase() === lower && predicate(raw[i])) return raw[i];
          return null;
        });
        // 순회는 **실제 DOM 이 쓰는 바로 그 함수**를 돌려준다. 셋 다 @@iterator 가
        // `Array.prototype.values` 이고(측정), 그 함수들에는 브랜드 체크가 없어
        // `this` 의 `length`/인덱스만 읽는다 — 즉 프록시를 `this` 로 받으면
        // 우리 트랩을 타므로 **필터가 그대로 유지된다**(측정 확인).
        // 덤으로 live 컬렉션이 순회 중 원본 변화를 다시 본다(스냅샷은 못 봤다).
        // @@iterator 만은 게이트하지 않는다 — NodeList·HTMLCollection·NamedNodeMap
        // **셋 다** 가지고 있고(측정), 빈 결과로 쓰는 배열도 가진다. 게이트를 달아
        // 뒀더니 변이로 떼어도 아무 가드가 안 물었다 = 한 번도 발화하지 않는
        // 조건이었다. 안 쓰이는 분기는 남기지 않는다.
        if (prop === Symbol.iterator) return Array.prototype.values;
        if (isIndexKey(prop)) {
          const arr = items();
          const index = Number(prop);
          return index < arr.length ? arr[index] : undefined;
        }
        // 이것들을 raw 에 **바인딩**하면 필터를 우회한다 —
        // `document.querySelectorAll('script').forEach(…)` 가 ZP 부트 스크립트를
        // 그대로 넘겨줬다. 바인딩하지 않고 `Array.prototype.*` 를 그대로 주면
        // `this` 가 프록시라 필터를 지나면서 동일성까지 맞는다.
        if (prop === 'forEach' || prop === 'values' || prop === 'keys' || prop === 'entries') {
          return inRaw(prop) ? Array.prototype[prop] : undefined;
        }
        const value = raw && raw[prop];
        // ★이름 기반 접근(WebIDL named getter)도 **항목을 돌려준다** —
        // `el.attributes['data-zp-target-url']` 이 Attr 를 그대로 내줬다.
        // 인덱스 경로만 거르고 여기를 안 걸렀던 것이라, 값이 노드면 술어를
        // 지나게 한다. 함수/스칼라 폴백은 그대로 둔다.
        if (isFilterableItem(value)) {
          try { return predicate(value) ? value : undefined; } catch { return undefined; }
        }
        if (typeof value !== 'function') return value;
        // 바인딩한 것도 접근마다 같은 객체여야 한다.
        let bound = boundFns.get(prop);
        if (!bound) { bound = value.bind(raw); boundFns.set(prop, bound); }
        return bound;
      },
      // 2026-08-15 — `has` 의 인덱스 정규식이 `\\d` 로 이중 이스케이프되어 있었다.
      // 정규식 리터럴 안에서 `\\d` 는 "역슬래시 + d" 라, `[1-9]` 뒤에 역슬래시를
      // 요구하는 셈이 되어 **"0" 말고는 어떤 인덱스도 매치되지 않았다**.
      // `get` 은 올바른 `\d` 를 쓰니 `list[3]` 은 멀쩡했고, 그래서 오래 안 보였다.
      //
      // 그런데 `Array.prototype.map/filter/forEach/…` 는 인덱스를 읽기 전에
      // **HasProperty 로 hole 을 판정**한다. 그래서 `Array.prototype.map.call(
      // nodeList, fn)` 이 0번만 돌고 나머지는 전부 hole 이 됐다 — 배열에는
      // 구멍이 남고 사이트 코드는 `undefined` 를 집는다. wikipedia 포털이
      // `l10n/undefined-<hash>.json` 을 8번 긁던 것이 바로 이것이다.
      has(_target, prop) {
        if (isIndexKey(prop)) return Number(prop) < length();
        // 인덱스가 아닌 이름은 진짜 컬렉션의 판정을 그대로 쓴다. `'item' in list`,
        // `'forEach' in list`, `Symbol.iterator in list` 가 전부 true 여야 한다.
        try {
          if (prop === 'length') return true;
          if (!raw || !(prop in raw)) return false;
          // `in` 도 named getter 를 본다 — 걸러 낸 항목이 여기서 true 로
          // 되살아나면 이름 목록에 없는 것이 `in` 만 true 인 자기모순이 된다.
          const value = raw[prop];
          return isFilterableItem(value) ? !!predicate(value) : true;
        } catch { return prop === 'length'; }
      },
      // 진짜 NodeList/NamedNodeMap 은 인덱스를 **열거 가능한 own 속성**으로 가진다.
      // 이 두 트랩이 없으면 `Object.keys(list)` 가 `[]` 라, 값이 있는데 키가 없는
      // 자기모순이 그대로 지문이 된다. target 은 own 속성이 없는 `{}` 이므로
      // 반드시 `configurable: true` 로 보고해야 불변식 위반이 나지 않는다.
      ownKeys() {
        const keys = [];
        for (let i = 0, n = length(); i < n; i++) keys.push(String(i));
        return keys;
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (isIndexKey(prop) && Number(prop) < length()) {
          return { value: nth(Number(prop)), writable: false, enumerable: true, configurable: true };
        }
        return undefined;
      }
    });
    return collection;
  }
  // ★직렬화 세정은 **복제본**에 한다. 예전에는 문자열을 `div.innerHTML` 에 넣고
  // 다시 뽑았는데, HTML 파서가 `<html>/<head>/<body>` 껍데기를 벗긴다. 그래서
  // `document.documentElement.outerHTML` 이 `<html …>` 로 **시작하지 않았다** —
  // 대조군(프록시 없이)은 시작한다(2026-08-22 실측). 재현성 결함이면서 동시에
  // 한 줄로 끝나는 지문이다(`/^<html/.test(...)`).
  //
  // 복제본을 훑어 우리 속성만 떼고 네이티브 게터로 직렬화하면 구조가 그대로다.
  // 재파싱도 없어져 긴 문서에서 더 싸다.
  // 복제 + 세정만 떼어 둔다 — `XMLSerializer.serializeToString` 도 같은
  // 복제본이 필요한데 거기엔 outerHTML 이 없다(Document 를 받는다).
  // 프록시 URL 을 그 안에 실린 타깃으로 되돌린다. 한 값에 여럿이 들어있을 수
  // 있으므로(style 의 url(…), srcset 목록) 전역 치환이다.
  // ★프록시 URL → 타깃 되돌리기는 **구현이 세 벌이었고 표가 서로 달랐다**
  // (2026-08-22 정리). 내비게이션판은 `?url=`/`&u=` 를 몰라서 'virtualURL'
  // 을 돌려줬다 — 틀렸는데 그럴듯한 값이라 조용히 지나간다. 한 벌로 묶고
  // 호출자별 차이를 **옵션으로만** 남긴다.
  //
  //   scan     : 한 값 안에 여럿이 들어 있을 수 있다(style 의 url(…), srcset 목록).
  //   fallback : 모르는 모양을 만났을 때 무엇을 돌려줄 것인가.
  //              'none'  — 원본 그대로(직렬화: 없는 값을 지어내지 않는다)
  //              'share' — 공유 문서 경로면 현재 가상 URL(리소스 타이밍)
  //              'any'   — 프록시 오리진이면 무조건 현재 가상 URL(폼 액션)
  function deproxyURL(raw, opts) {
    const s = String(raw == null ? '' : raw);
    if (!s || s.indexOf(proxyOrigin) < 0) return s;
    const scan = !!(opts && opts.scan);
    const fallback = (opts && opts.fallback) || 'none';
    const one = (m) => {
      let u;
      try { u = new Native.URL(m); } catch { return m; }
      if (u.origin !== proxyOrigin) return m;
      const p = u.pathname;
      if (p === ZP.apiPath('fetch')) return u.searchParams.get('url') || m;
      if (p === ZP.apiPath('script') || p === ZP.apiPath('worker-script') || p === ZP.apiPath('sourcemap')) return u.searchParams.get('u') || m;
      // 런처(`/zp/?via=<target>`) 와 문서 경로(`/zp/p/<token>`) 는 둘 다 페이지 URL
      // 을 대신한다. 토큰은 암호화돼 있어 클라이언트에서 풀 수 없다.
      const via = u.searchParams.get('via');
      if (via) return via;
      if (fallback === 'any') return virtualURL.href;
      if (fallback === 'share' && ZP.isSharePath(p)) return virtualURL.href;
      return m;
    };
    if (scan) return s.replace(proxyURLScanRE(), one);
    return s.lastIndexOf(proxyOrigin, 0) === 0 ? one(s) : s;
  }
  let proxyURLScanCache = null;
  function proxyURLScanRE() {
    if (!proxyURLScanCache) {
      const esc = proxyOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // URL 로 허용되는 문자만 이어 붙인다. 따옴표/공백/괄호로 끊는 방식보다
      // 이쪽이 `style` 안의 `url("…")` 같은 자리에서 덜 위험하다.
      proxyURLScanCache = new RegExp(esc + '[A-Za-z0-9\\-._~:/?#\\[\\]@!$&*+,;=%]*', 'g');
    }
    proxyURLScanCache.lastIndex = 0;
    return proxyURLScanCache;
  }
  // ★2026-08-22 — `<style>` 와 인라인 `<script>` 의 **텍스트**는 우리가
  // 덮어쓴다(CSS URL 리라이트 / 실행 래퍼). 그런데 읽기를 안 고쳤어서
  // 페이지가 자기 스타일/스크립트를 다시 읽으면 그대로 보였다. 실측:
  // 픽스처에서 style 8개 중 4개가 `zp/api` 를, script 2개 중 1개가
  // 래퍼를 노출했다 — 직렬화만의 문제가 아니다.
  //
  // 우리가 덮어쓸 때 원본을 붙들어 둔다. srcdoc 과 같은 방식이고, 마찬가지로
  // 재현성도 같이 맞는다(페이지가 쓴 값을 그대로 돌려주는 게 원래 옴다).
  const originalTextMeta = new WeakMap();
  // 서버측 htmltx 가 고친 것은 WeakMap 이 없다 — 그때는 값 안의 프록시
  // URL 만이라도 푸는다(CSS 는 URL 만 바뀌므로 사실상 원본이 된다).
  // ★되돌리기는 **보관한 값에도** 태운다. 기억해 둔 ‘원본’ 이 이미 프록시
  // URL 일 수 있기 때문이다 — 서버가 고쳐 내려보낸 CSS 를 멤브레인이
  // 나중에 다시 심으면 그 순간의 값을 원본으로 기억한다. 위키피디아의
  // 120KB 스타일 하나가 정확히 그랬다(2026-08-22 실측, 픽스처는 재현 못 함).
  // srcset 에서 같은 함정을 밟았다 — 규칙은 하나다: **마지막에 항상 한 번 더.**
  function originalStyleText(el, raw) {
    return deproxyURL(originalTextMeta.has(el) ? originalTextMeta.get(el) : raw, { scan: true });
  }
  // 페이지가 만든 인라인 스크립트는 래퍼 페이로드가 **원본 그대로**라
  // 되돌리기가 정확하다. 서버가 미리 리라이트한 것
  // (`__ZP_EXEC_INLINE_REWRITTEN`)은 페이로드가 **리라이트된 코드**라 원본을
  // 복구할 수 없다 — 그 경계는 함정노트에 측정값과 함께 적어 됀다.
  const INLINE_WRAPPERS = ['__ZP_EXEC_INLINE_SCRIPT', '__ZP_EXEC_INLINE_MODULE'];
  function originalScriptText(el, raw) {
    // 위와 같은 이유로 보관한 값에도 되돌리기를 태운다. 원본 소스에",
    // 우리 프록시 URL 이 들어 있다면 그건 우리가 넣은 것이다.",
    if (originalTextMeta.has(el)) return deproxyURL(originalTextMeta.get(el), { scan: true });
    const s = String(raw == null ? '' : raw);
    for (const name of INLINE_WRAPPERS) {
      if (s.lastIndexOf(name + '(', 0) !== 0) continue;
      const body = s.slice(name.length + 1, s.lastIndexOf(')'));
      try { return deproxyURL(String(JSON.parse(body)), { scan: true }); } catch { return s; }
    }
    return s;
  }
  function scrubbedClone(node) {
    let clone;
    try { clone = node.cloneNode(true); } catch { clone = null; }
    if (!clone) return null;
    // `origin` 은 복제본에 대응하는 **원본** 요소다. WeakMap 에 매달아 둔 것
    // (srcdoc 원본)은 복제본으로는 못 찾으므로 두 트리를 나란히 걷는다 —
    // cloneNode(true) 는 순서를 보존하므로 인덱스가 그대로 맞는다.
    const scrub = (el, origin) => {
      restoreVisibleLinkState(el);
      if (isZPAssetNode(el)) { try { el.remove(); } catch {} return; }
      // 직렬화도 같은 복구를 거친다 — 게터만 고치면 `outerHTML` 과
      // `getAttribute` 가 서로 다른 말을 하고, 그 불일치가 다시 탐지기다.
      const ln = el.localName;
      if (origin && (ln === 'style' || ln === 'script') && Native.nodeTextContent && Native.nodeTextContent.get) {
        const raw = String(Native.nodeTextContent.get.call(el) || '');
        const want = ln === 'style' ? originalStyleText(origin, raw) : originalScriptText(origin, raw);
        if (want !== raw && Native.nodeTextContent.set) { try { Native.nodeTextContent.set.call(el, want); } catch {} }
      }
      if (origin && srcdocMeta.has(origin)) {
        try { Native.setAttribute.call(el, 'srcdoc', srcdocMeta.get(origin)); } catch {}
      }
      // ★직렬화는 URL 도 되돌려야 한다. `getAttribute('src')` 는 타깃 URL 을
      // 돌려주는데 `outerHTML` 은 프록시 URL 을 그대로 보여 줬다 — 그
      // 불일치 자체가 한 줄짜리 탐지기다(둘을 비교하면 끝).
      //
      // 서버측 htmltx 가 고친 값에는 `data-zp-target-url` 이 **없다**(실측: 41개
      // 전부 null). 그래서 원본을 기억해 둔 것이 있으면 그걸 쓰고, 없으면
      // **값 안에 박힌 프록시 URL 을 그자리에서 푸는다** — `?url=` 에 타깃이
      // 들어 있으므로 별도 장부가 필요 없다. `style` 의 url(…) 과 srcset
      // 목록처럼 한 값에 여럿이 들어있는 경우까지 같은 규칙으로 덩는다.
      if (Native.getAttributeNames) {
        const tag = el.localName;
        for (const name of Native.getAttributeNames.call(el)) {
          if (isZPAttrName(name)) continue;
          const localKey = attrLocalName(name);
          let want;
          if (origin && isURLBearing(el, name, localKey, tag) && !usesRawURLAttribute(el, name, localKey)) {
            const recalled = (localKey === 'srcset' || localKey === 'imagesrcset') ? recalledSrcset(origin, name) : undefined;
            want = recalled !== undefined ? recalled : (urlMeta.get(origin) || Native.getAttribute.call(origin, 'data-zp-target-url') || undefined);
          }
          // ★되돌리기는 **마지막에 항상** 태운다. 기억해 둔 ‘원본’ 이 이미
          // 프록시 URL 일 수 있기 때문이다 — 서버가 고쳐 내려보낸 정적 srcset 을
          // 멤브레인이 나중에 스윗하면 그 순간의 값(=프록시 URL)을 원본으로
          // 기억한다. 그걸 그대로 돌려주면 원본을 복원한 것처럼 보이면서 샐다.
          const raw = Native.getAttribute.call(el, name);
          const base = want !== undefined && want !== null ? String(want) : raw;
          const out = deproxyURL(base, { scan: true });
          if (out !== raw) { try { Native.setAttribute.call(el, name, out); } catch {} }
        }
      }
      if (Native.getAttributeNames) {
        for (const name of Native.getAttributeNames.call(el)) {
          if (isZPAttrName(name)) { try { Native.removeAttribute.call(el, name); } catch {} }
        }
      }
    };
    try {
      if (clone.nodeType === 1) scrub(clone, node);
      // ★말려든 자리: 멤브레인의 `querySelectorAll` 은 **우리 에셋
      // 스크립트를 숨긴다**. 그걸 그대로 쓰면 세정기가 그 노드를
      // 못 보고 복제본에 그대로 남긴다 — 즉 자기 은폐에 자기가 눈이
      // 멀었다. 실측: `outerHTML` 에 zp-core.js / zp-page-bundle.js 태그가
      // 그대로 남아 있었다. 네이티브로 훑어야 한다.
      // Document(9) 와 Element(1) 은 같은 메서드가 아니다 — XMLSerializer 는
      // Document 를 받을 수 있으므로 틀리면 던져서 세정이 통째로 생략된다.
      const all = (n) => {
        const nt = n && n.nodeType;
        const native = nt === 9 ? Native.querySelectorAll
          : nt === 11 ? Native.fragmentQuerySelectorAll
          : Native.elementQuerySelectorAll;
        if (native) { try { return native.call(n, '*'); } catch {} }
        return n && n.querySelectorAll ? n.querySelectorAll('*') : [];
      };
      // ★`<template>` 안은 어떤 querySelectorAll 로도 안 걸린다 — 내용이
      // 문서 트리의 자식이 아니라 별도 DocumentFragment 이기 때문이다.
      // 그런데 **직렬화는 그 안을 그대로 뱉는다.** 즉 세정기가 못 보는 곳을
      // 직렬화기는 본다. reddit 실측: 라이트 DOM 의 zp 속성 241 / 프록시 URL
      // 293 은 전부 세정됐는데, 템플릿 14개 안의 1 / 2 가 그대로 나갔다.
      // 템플릿은 중첩될 수 있으므로 재귀한다.
      const contentOf = (el) => {
        if (!el || el.localName !== 'template') return null;
        try {
          return Native.templateContent && Native.templateContent.get
            ? Native.templateContent.get.call(el) : el.content;
        } catch { return null; }
      };
      const walk = (cloneRoot, originRoot, depth) => {
        const cloned = all(cloneRoot);
        const origins = all(originRoot);
        const paired = origins.length === cloned.length;
        for (let i = 0; i < cloned.length; i++) {
          const origin = paired ? origins[i] : null;
          scrub(cloned[i], origin);
          if (depth < 8) {
            const cc = contentOf(cloned[i]);
            if (cc) walk(cc, contentOf(origin), depth + 1);
          }
        }
      };
      if (clone.nodeType === 1) {
        const cc = contentOf(clone);
        if (cc) walk(cc, contentOf(node), 1);
      }
      walk(clone, node, 0);
    } catch {}
    return clone;
  }
  function sanitizeSerializedNode(node, wantOuter) {
    const clone = scrubbedClone(node);
    if (!clone) return '';
    try {
      if (wantOuter) {
        return Native.elementOuterHTML && Native.elementOuterHTML.get
          ? Native.elementOuterHTML.get.call(clone) : clone.outerHTML;
      }
      return Native.elementInnerHTML && Native.elementInnerHTML.get
        ? Native.elementInnerHTML.get.call(clone) : clone.innerHTML;
    } catch { return ''; }
  }

  function installStealthMembrane(w) {
    if (!w || !w.Document || !w.Element) return;
    try { if (w[stealthMarker]) return; Object.defineProperty(w, stealthMarker, { value: true, enumerable: false, configurable: false }); } catch {}
    const docGetTags = w.Document.prototype.getElementsByTagName;
    const elemGetTags = w.Element.prototype.getElementsByTagName;
    if (typeof docGetTags === 'function') define(w.Document.prototype, 'getElementsByTagName', function(tag) {
      const raw = docGetTags.apply(this, arguments);
      return shouldFilterTag(tag) ? filteredCollection(raw, node => !isZPAssetNode(node)) : raw;
    });
    if (typeof elemGetTags === 'function') define(w.Element.prototype, 'getElementsByTagName', function(tag) {
      const raw = elemGetTags.apply(this, arguments);
      return shouldFilterTag(tag) ? filteredCollection(raw, node => !isZPAssetNode(node)) : raw;
    });
    const scriptsDesc = Object.getOwnPropertyDescriptor(w.Document.prototype, 'scripts') || Native.documentScripts;
    if (scriptsDesc && scriptsDesc.get) try { Object.defineProperty(w.Document.prototype, 'scripts', { get() { return filteredCollection(scriptsDesc.get.call(this), node => !isZPAssetNode(node)); }, configurable: false }); } catch {}
    const docQS = w.Document.prototype.querySelector;
    const docQSA = w.Document.prototype.querySelectorAll;
    const elemQS = w.Element.prototype.querySelector;
    const elemQSA = w.Element.prototype.querySelectorAll;
    if (typeof docQS === 'function') define(w.Document.prototype, 'querySelector', function(sel) { return selectorTargetsZP(sel) ? null : filterSelectorOne(docQS.apply(this, arguments)); });
    if (typeof elemQS === 'function') define(w.Element.prototype, 'querySelector', function(sel) { return selectorTargetsZP(sel) ? null : filterSelectorOne(elemQS.apply(this, arguments)); });
    // ★표면이 raw 를 따라가므로 **빈 결과에도 진짜 NodeList** 를 줘야 한다.
    // 빈 배열을 감싸면 `item` 이 없고 `forEach` 는 있는, NodeList 도
    // HTMLCollection 도 아닌 잡종이 나온다. 분리된 요소에 네이티브 qSA 를 걸면
    // 언제나 비어 있는 진짜 NodeList 다.
    let emptyList = null;
    const emptyNodeList = () => {
      if (!emptyList) {
        try { emptyList = Native.elementQuerySelectorAll.call(w.document.createElement('i'), '*'); }
        catch { emptyList = []; }
      }
      return emptyList;
    };
    if (typeof docQSA === 'function') define(w.Document.prototype, 'querySelectorAll', function(sel) { return selectorTargetsZP(sel) ? filteredCollection(emptyNodeList(), () => false) : filteredCollection(docQSA.apply(this, arguments), node => !isZPAssetNode(node)); });
    if (typeof elemQSA === 'function') define(w.Element.prototype, 'querySelectorAll', function(sel) { return selectorTargetsZP(sel) ? filteredCollection(emptyNodeList(), () => false) : filteredCollection(elemQSA.apply(this, arguments), node => !isZPAssetNode(node)); });
    const matches = w.Element.prototype.matches;
    const closest = w.Element.prototype.closest;
    if (typeof matches === 'function') define(w.Element.prototype, 'matches', function(sel) { return selectorTargetsZP(sel) ? false : matches.apply(this, arguments); });
    if (typeof closest === 'function') define(w.Element.prototype, 'closest', function(sel) { return selectorTargetsZP(sel) ? null : filterSelectorOne(closest.apply(this, arguments)); });
    const nodeIterator = w.Document.prototype.createNodeIterator;
    if (typeof nodeIterator === 'function') define(w.Document.prototype, 'createNodeIterator', function() { return filteredTraversal(nodeIterator.apply(this, arguments)); });
    const treeWalker = w.Document.prototype.createTreeWalker;
    if (typeof treeWalker === 'function') define(w.Document.prototype, 'createTreeWalker', function() { return filteredTraversal(treeWalker.apply(this, arguments)); });
  }
  function shouldFilterTag(tag) {
    const t = String(tag || '').toLowerCase();
    return t === '*' || t === 'script' || t === 'meta' || t === 'link';
  }
  function selectorTargetsZP(selector) {
    const s = String(selector || '').toLowerCase();
    return s.includes('data-zp-') || s.includes('#__zp-boot') || s.includes('/zp/assets/') || s.includes('x-zeroproxy-icon');
  }
  function filterSelectorOne(node) { return isZPAssetNode(node) ? null : node; }
  function filteredTraversal(raw) {
    return new Proxy(raw, {
      get(target, prop) {
        if (prop === 'nextNode' || prop === 'previousNode') return function() {
          let node;
          do { node = target[prop](); } while (node && isZPAssetNode(node));
          return node;
        };
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
      // ★receiver 를 기본값(=이 프록시)으로 두면 안 된다. 기본 set 트랩은
      // 프로토타입의 **네이티브 세터**를 receiver 로 호출하는데, 프록시에는
      // 내부 슬롯이 없어 `Illegal invocation` 으로 거부된다. 읽기는 get 트랩이
      // 언랩해 주므로 멀쩡해 보이고 쓰기만 조용히 죽는다.
      // Lit 의 템플릿 생성 경로가 모듈 스코프 워커를 재사용하며
      // `walker.currentNode = tpl.content` 를 쓴다 → Lit 기반 사이트가 통째로
      // 깨진다(developer.mozilla.org 실측: 로드당 Illegal invocation 77건,
      // 직접 로드에서는 0건).
      set(target, prop, value) { return Reflect.set(target, prop, value, target); }
    });
  }


  function installDOMHooks(w) {
    const inIframeRealm = (w !== root);
    const transformHTMLOpts = inIframeRealm ? { inIframe: true } : undefined;
    // `document.write` 는 **목적지 문서를 인자로 들고 있는 유일한 지점**이다
    // (`this`). 그 문서가 SW 클라이언트가 아니면 서브리소스 경로를 릴레이로
    // 바꿔야 하는데, 그 판정을 할 수 있는 곳이 여기뿐이다.
    const writeOptsFor = doc => {
      let swLess = false;
      try { swLess = documentIsSWLess(doc); } catch {}
      if (!swLess) return transformHTMLOpts;
      return inIframeRealm ? { inIframe: true, swLess: true } : { swLess: true };
    };
    define(w.Element.prototype, 'setAttribute', function(k, v) {
      // Hot path: cache `this.localName` (10× read across branches → 1 DOM getter)
      // and inline `attrLocalName` since `key` is already lowercase (avoids
      // redundant String/toLowerCase inside attrLocalName).
      const key = String(k).toLowerCase();
      const colon = key.indexOf(':');
      const localKey = colon < 0 ? key : key.slice(colon + 1);
      const ln = this.localName;
      // ★`data-zp-*` 는 **닫힌 이름공간**이다 — 읽기가 이미 null 이므로 쓰기도
      // 없던 일로 해야 앞뒤가 맞는다. 안 막았더니 페이지가 `data-zp-internal`
      // 을 자기 노드에 심어 **자기 자신을 querySelectorAll 에서 지울 수** 있었다
      // (실측: 1건 → 0건).
      if (isZPAttrName(key)) return undefined;
      // `ping` 은 프로퍼티뿐 아니라 속성으로도 들어온다. 여기서도 삼킨다
      // (위 프로퍼티 훅과 같은 이유 — CSP 가 아니라 우리가 막아야 한다).
      if (localKey === 'ping' && (ln === 'a' || ln === 'area')) {
        try { Native.setAttribute.call(this, 'data-zp-blocked-ping', String(v)); } catch {}
        try { Native.removeAttribute.call(this, 'ping'); } catch {}
        return;
      }
      // meta 로 실려 온 CSP 는 무력화한다(htmltx 와 같은 처리).
      if (ln === 'meta' && localKey === 'http-equiv' && isCSPHttpEquiv(v)) return neutralizeCSPMeta(this, v);
      if (key === 'integrity' && isIntegrityBearing(this)) return setBackedIntegrity(this, v);
      if (localKey === 'sandbox' && isFrameElement(this)) return setFrameSandboxAttribute(this, v);
      if (localKey === 'target' && isNavigationTargetElement(this)) return setSafeNavigationTarget(this, k, v);
      if (ln === 'link' && localKey === 'rel') {
        const value = String(v);
        if (isBlockedLinkRelValue(value)) return suppressBlockedLinkRel(this, value);
        if (Native.removeAttribute) Native.removeAttribute.call(this, 'data-zp-blocked-rel');
        const ret = Native.setAttribute.call(this, k, v);
        enforceLinkPolicy(this);
        return ret;
      }
      if (ln === 'link' && localKey === 'href' && (isBlockedLink(this) || hasSuppressedBlockedLinkRel(this))) return blockLinkURL(this, v);
      if (ln === 'link' && localKey === 'href' && isIconLink(this)) return suppressIconLinkHref(this, v);
      if (key.startsWith('on') && key.length > 2) return Native.setAttribute.call(this, k, rewriteEventAttribute(String(v)));
      if (ln === 'base' && localKey === 'href') {
        updateVirtualBase(v);
        return Native.setAttribute.call(this, k, v);
      }
      if (ln === 'script' && (localKey === 'src' || localKey === 'href')) return setScriptSource(this, v);
      // `style` 속성도 url() 을 실어 나른다 — CSSStyleDeclaration 훅은 프로퍼티
      // 경로만 덮으므로 여기서 따로 잡는다.
      if (localKey === 'style' && v != null) return Native.setAttribute.call(this, k, rewriteCSSText(v));
      if (isURLBearing(this, key, localKey, ln)) {
        // ★srcset 은 URL 하나가 아니다 — 여기 분기가 **없어서** 아래 단일 URL
        // 경로가 후보 목록 전체를 한 덩어리 URL 로 삼켰다. 2026-08-21 실측:
        //   img.setAttribute('srcset', '/a.png 1x, /b.png 2x')
        //   → ?url=…%2Fa.png%25201x%2C%2520%2Fb.png%25202x  (후보 둘 다 사망)
        // 서브트리 스윕에는 이 분기가 있었는데 요소 훅에는 없었다 — 또 같은
        // "한쪽 경로에만 넣은" 사고다.
        if (localKey === 'srcset' || localKey === 'imagesrcset') {
          Native.setAttribute.call(this, k, v == null ? '' : String(v));
          enforceSrcsetAttribute(this, k, String(v == null ? '' : v));
          return;
        }
        // 2026-08-13 — fragment-only URL (`#`, `#tab`) 은 same-document 앵커다.
        // 절대 URL 로 풀어 "?via=" launcher 로 바꾸면 두 가지가 깨진다:
        // (a) 문서 내 이동이 전체 내비게이션처럼 보이고,
        // (b) clickNavigationTarget 의 `raw === '#'` 위임 경로가 무력화된다 —
        //     raw 가 더 이상 '#' 이 아니라 절대 URL 이므로. 그 결과 클릭이
        //     preventDefault + stopImmediatePropagation 으로 삼켜져 페이지의
        //     onClick 이 영영 실행되지 않는다. NAVER 로그인 후 MY 패널의
        //     메일/카페 **탭**(`<a href="#" role="tab">`)이 정확히 이 케이스로
        //     죽어 있었다. fragment 는 origin 을 벗어나지 않으므로 그대로
        //     둬도 탈출 위험이 없다.
        const rawURLValue = v == null ? '' : String(v);
        if (rawURLValue.charCodeAt(0) === 35 /* '#' */) {
          urlMeta.delete(this);
          if (Native.removeAttribute) { try { Native.removeAttribute.call(this, 'data-zp-target-url'); } catch {} }
          return Native.setAttribute.call(this, k, rawURLValue);
        }
        if (shouldBlockURLAttribute(this, localKey, v, localKey, ln) || hasContextBlockedScheme(this, v)) return blockExecutableURL(this, localKey, v);
        const t = targetURLForElement(this, v);
        if (t) {
          const usesRaw = usesRawURLAttribute(this, key, localKey);
          urlMeta.set(this, t);
          // 2026-06-06 escape vector fix: always stash absolute target on
          // data-zp-target-url + write a proxy-origin "?via=" URL on the raw
          // attribute for anchor/area href / form action / formaction.
          // Previously `usesRaw ? v : t` put the absolute target on the DOM
          // attribute (leaking to hover/middle-click/copy-link).
          Native.setAttribute.call(this, 'data-zp-target-url', t);
          if ((ln === 'iframe' || ln === 'frame') && localKey === 'src') {
            Native.setAttribute.call(this, k, 'about:blank');
            activatedFrameURL(t).then(u => { Native.setAttribute.call(this, k, u); rememberFrameOrigin(this); }).catch(()=>{});
            return;
          }
          if (ln === 'link' && localKey === 'href' && isIconLink(this)) return suppressIconLinkHref(this, t);
          if (usesRaw) return Native.setAttribute.call(this, k, proxyViaURL(t));
          return setSubresourceAttribute(this, k, subresourceProxyPath(t));
        }
      }
      if ((ln === 'iframe' || ln === 'frame') && localKey === 'srcdoc') { setInjectedSrcdoc(this, v); return undefined; }
      return Native.setAttribute.call(this, k, v);
    });
    if (Native.setAttributeNS) define(w.Element.prototype, 'setAttributeNS', function(ns, k, v) {
      const key = String(k).toLowerCase();
      const colon = key.indexOf(':');
      const localKey = colon < 0 ? key : key.slice(colon + 1);
      const ln = this.localName;
      // `setAttributeNS(null, name, v)` 는 명세상 HTML 요소에서 `setAttribute`
      // 와 같은 속성을 만든다. 그런데 여기 로직은 위 setAttribute 훅의 **부분
      // 집합**이라 같은 호출이 다른 결과를 냈다 — 실측: `img.setAttribute` 는
      // 프록시 경로를 쓰는데 `img.setAttributeNS(null,'src',…)` 는 타깃 절대
      // URL 을 그대로 써서 원본 요청이 그대로 나갔다(CSP 만 막고 있었다).
      // ping/srcdoc/iframe/base/style/fragment 처리도 전부 여기엔 없다.
      // 그래서 **같은 뜻이면 같은 코드로 보낸다**: 이름이 이미 소문자이고
      // (setAttribute 는 HTML 요소에서 이름을 소문자화하므로 그때만 등가다)
      // 네임스페이스가 없으면 setAttribute 훅에 위임한다. xlink:href 같은
      // 진짜 네임스페이스 속성만 아래 경로로 남는다.
      if ((ns === null || ns === undefined || ns === '') && String(k) === key) {
        return this.setAttribute(k, v);
      }
      if (key === 'integrity' && isIntegrityBearing(this)) return setBackedIntegrity(this, v);
      if (localKey === 'sandbox' && isFrameElement(this)) return setFrameSandboxAttribute(this, v);
      if (ln === 'script' && (localKey === 'src' || localKey === 'href')) return setScriptSource(this, v);
      if (ln === 'link' && localKey === 'href' && isIconLink(this)) return suppressIconLinkHref(this, v);
      if (isURLBearing(this, key, localKey, ln)) {
        if (shouldBlockURLAttribute(this, localKey, v, localKey, ln)) return blockExecutableURL(this, localKey, v);
        const t = targetURLForElement(this, v);
        if (t) {
          const usesRaw = usesRawURLAttribute(this, key, localKey);
          urlMeta.set(this, t);
          // 2026-06-06 escape vector fix: same rationale as setAttribute
          // path above — anchor/area href / form action / formaction must
          // not leak the absolute target URL through the raw DOM attribute.
          Native.setAttribute.call(this, 'data-zp-target-url', t);
          // 서브리소스는 **프록시 경로**를 쓴다. 예전엔 `t`(타깃 절대 URL)를
          // 그대로 썼는데, 그러면 브라우저가 타깃으로 직접 나간다.
          return Native.setAttributeNS.call(this, ns, k, usesRaw ? proxyViaURL(t) : subresourceProxyPath(t));
        }
      }
      return Native.setAttributeNS.call(this, ns, k, key.startsWith('on') && key.length > 2 ? rewriteEventAttribute(String(v)) : v);
    });
    if (Native.namedSetNamedItem && w.NamedNodeMap) define(w.NamedNodeMap.prototype, 'setNamedItem', function(attr) { if (attr && isZPAttrName(attr.name)) return null; if (attr && String(attr.name || '').toLowerCase().startsWith('on')) attr.value = rewriteEventAttribute(String(attr.value || '')); return Native.namedSetNamedItem.call(this, attr); });
    if (Native.attrValue && Native.attrValue.set && w.Attr) try { Object.defineProperty(w.Attr.prototype, 'value', { get() { const masked = visibleIconAttrValue(this); return masked === null ? Native.attrValue.get.call(this) : masked; }, set(v) { Native.attrValue.set.call(this, String(this.name || '').toLowerCase().startsWith('on') ? rewriteEventAttribute(String(v)) : v); }, configurable: false }); } catch {}
    define(w.Element.prototype, 'getAttribute', function(k) {
      const key = String(k).toLowerCase();
      if (isZPAttrName(key)) return null;
      if (key === 'integrity' && isIntegrityBearing(this)) {
        const backed = backedIntegrity(this);
        return backed !== null ? backed : Native.getAttribute.call(this, k);
      }
      if (key === 'sandbox' && isFrameElement(this) && frameSandboxMeta.has(this)) return frameSandboxMeta.get(this);
      const colon = key.indexOf(':');
      const localKey = colon < 0 ? key : key.slice(colon + 1);
      const ln = this.localName;
      if ((ln === 'iframe' || ln === 'frame') && localKey === 'srcdoc' && srcdocMeta.has(this)) return srcdocMeta.get(this);
      const raw = Native.getAttribute.call(this, k);
      // URL decoding consumes strings; DOM absence must stay null, and an empty
      // attribute must not pick up a stale URL stash from an earlier value.
      if (raw === null || raw === '') return raw;
      if (localKey === 'srcset' || localKey === 'imagesrcset') {
        // 기억한 값이 이미 프록시 URL 일 수 있다(위 주석과 같은 이유).
        const recalled = recalledSrcset(this, key);
        return deproxyURL(recalled !== undefined ? recalled : raw, { scan: true });
      }
      // `script:src` 는 URL 표면 목록에 없다(전용 경로로 다룬다) — 그래서
      // 아래 isURLBearing 분기가 안 먹고 원시 값이 나간다. 프로퍼티는 가려지는데
      // 속성은 안 가려지는 비대칭은 이 저장소가 이미 한 번 밟은 함정이다
      // (NAVER 폼 제출, real-site-compat 2026-06-xx).
      if (ln === 'script' && localKey === 'src') {
        const stashed = urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url');
        if (stashed) return stashed;
        return deproxyURL(raw, { scan: true });
      }
      // 같은 이유로 여기도 마지막에 한 번 더 되돌린다(이 세션 네 번째 같은 부류).
      if (isURLBearing(this, key, localKey, ln)) return usesRawURLAttribute(this, key, localKey) ? raw : urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url') || deproxyURL(raw, { scan: true });
      return raw;
    });
    if (Native.hasAttribute) define(w.Element.prototype, 'hasAttribute', function(k) {
      const key = String(k).toLowerCase();
      if (isZPAttrName(key)) return false;
      if (key === 'integrity' && isIntegrityBearing(this)) return backedIntegrity(this) !== null || Native.hasAttribute.call(this, k);
      if (key === 'sandbox' && isFrameElement(this) && frameSandboxMeta.has(this)) return true;
      return Native.hasAttribute.call(this, k);
    });
    if (Native.removeAttribute) define(w.Element.prototype, 'removeAttribute', function(k) {
      const key = String(k).toLowerCase();
      const colon = key.indexOf(':');
      const localKey = colon < 0 ? key : key.slice(colon + 1);
      const ln = this.localName;
      // 없는 속성을 지우는 것은 진짜 브라우저에서도 no-op 이다. 읽기가 null 인
      // 이상 여기서도 no-op 이어야 한다 — 안 막았을 때 페이지가 앵커의
      // `data-zp-target-url` 스태시를 실제로 **지워** 버렸다(실측).
      if (isZPAttrName(key)) return undefined;
      if (key === 'integrity' && isIntegrityBearing(this)) {
        Native.removeAttribute.call(this, integrityBackupAttr);
        return Native.removeAttribute.call(this, k);
      }
      if (localKey === 'sandbox' && isFrameElement(this)) frameSandboxMeta.delete(this);
      if (ln === 'link' && localKey === 'href' && isIconLink(this)) {
        urlMeta.delete(this);
        if (Native.removeAttribute) Native.removeAttribute.call(this, 'data-zp-target-url');
        return Native.removeAttribute.call(this, k);
      }
      if (ln === 'link' && localKey === 'rel') {
        const ret = Native.removeAttribute.call(this, k);
        enforceLinkPolicy(this);
        return ret;
      }
      return Native.removeAttribute.call(this, k);
    });
    if (Native.getAttributeNames) define(w.Element.prototype, 'getAttributeNames', function() {
      const names = Native.getAttributeNames.call(this).filter(name => !isZPAttrName(name));
      if (isIntegrityBearing(this) && backedIntegrity(this) !== null && !names.some(name => String(name).toLowerCase() === 'integrity')) names.push('integrity');
      if (isFrameElement(this) && frameSandboxMeta.has(this) && !names.some(name => String(name).toLowerCase() === 'sandbox')) names.push('sandbox');
      return names;
    });
    if (Native.elementAttributes && Native.elementAttributes.get) try { Object.defineProperty(w.Element.prototype, 'attributes', { get() { return filteredNamedNodeMap(Native.elementAttributes.get.call(this)); }, configurable: false }); } catch {}
    installZPAttrNamespace(w);
    installIntegrityProp(w.HTMLScriptElement && w.HTMLScriptElement.prototype);
    installIntegrityProp(w.HTMLLinkElement && w.HTMLLinkElement.prototype);
    installScriptProp(w.HTMLScriptElement && w.HTMLScriptElement.prototype);
    installScriptTextProps(w);
    installStyleHooks(w);
    installLinkProp(w.HTMLLinkElement && w.HTMLLinkElement.prototype);
    patchHTMLSetter(w.Element.prototype, 'innerHTML');
    patchHTMLSetter(w.Element.prototype, 'outerHTML');
    // ★2026-08-22 — `innerHTML`/`outerHTML` 만 세정하고 있었다.
    // `new XMLSerializer().serializeToString(document.documentElement)` 은 훅이
    // 아예 없어서 같은 문서에서 **38건**의 흔적이 그대로 나왔다(실측). 직렬화는
    // 표면이 하나가 아니다 — 세정을 게터가 아니라 **복제본**에 걸어 둔 덕에
    // 여기서는 그 복제본을 그대로 재사용하면 된다.
    if (w.XMLSerializer && w.XMLSerializer.prototype && typeof w.XMLSerializer.prototype.serializeToString === 'function') {
      const nativeSerialize = w.XMLSerializer.prototype.serializeToString;
      define(w.XMLSerializer.prototype, 'serializeToString', function(node) {
        const clone = node && typeof node.cloneNode === 'function' ? scrubbedClone(node) : null;
        return nativeSerialize.call(this, clone || node);
      });
    }
    define(w.Element.prototype, 'insertAdjacentHTML', function(pos, html) { const ret = Native.insertAdjacentHTML.call(this, pos, transformHTML(String(html), transformHTMLOpts)); syncBaseElement(this); enforceSubtreePolicies(this); return ret; });
    // Document.prototype.write / writeln wrap. 인스턴스 레벨이 아니라 proto
    // 레벨이라 같은 realm 의 모든 Document 인스턴스에 적용. 부모 install 시
    // 부모 Document.prototype, iframe install 시 iframe Document.prototype.
    // NAVER GFP SafeFrame ad iframe 이 부모 ad code 의 `iframe.contentDocument.write(template)`
    // 와 자신의 `document.write(adm)` 모두 transformHTML 통과시켜 외부 스크립트
    // src 가 scriptProxyPath 로 라우팅됨.
    if (w.Document && w.Document.prototype) {
      const docProto = w.Document.prototype;
      if (docProto.write) {
        const protoWrite = docProto.write;
        define(docProto, 'write', function(...parts) {
          const html = parts.map(p => transformHTML(String(p), writeOptsFor(this))).join('');
          if (deferredScriptDepth > 0 && documentIsClosed(this)) return appendWrittenHTML(this, html);
          return protoWrite.apply(this, [html]);
        });
      }
      if (docProto.writeln) {
        const protoWriteln = docProto.writeln;
        define(docProto, 'writeln', function(...parts) {
          const html = parts.map(p => transformHTML(String(p), writeOptsFor(this))).join('') + '\n';
          if (deferredScriptDepth > 0 && documentIsClosed(this)) return appendWrittenHTML(this, html);
          return protoWriteln.apply(this, [html]);
        });
      }
    }
    // installBaseObserver 가 doc 인자를 받아 부모/iframe 양쪽 호환. iframe
    // 경로는 installNetworkContainment 가 별도로 호출 (w.document 전달).
    installBaseObserver(w.document || document);
    function patchHTMLSetter(proto, prop) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) return;
      try {
        Object.defineProperty(proto, prop, {
          get() { return d.get ? sanitizeSerializedNode(this, prop === 'outerHTML') : ''; },
          set(v) {
            if (this && this.localName === 'template' && prop === 'innerHTML') {
              d.set.call(this, String(v));
              enforceSubtreePolicies(this.content);
              instrumentDescendantIframes(this.content);
              return;
            }
            d.set.call(this, transformHTML(String(v), transformHTMLOpts));
            syncBaseElement(this);
            instrumentDescendantIframes(this);
            enforceSubtreePolicies(this);
          },
          configurable: false
        });
      } catch {}
    }
  }
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
  // Worker 로 실행될 JS blob 은 정책상 차단한다. 차단 스텁 안에서 prelude 를
  // **절대 URL** 로 가져오는 게 핵심: blob: worker 안의 상대 URL 은 blob URL
  // 기준으로 풀려 그냥 invalid 다. 실제로 `SyntaxError: The URL
  // '/zp/assets/worker-prelude.js' is invalid` 로 죽어서 그 뒤의 DOMException
  // (= 의도한 차단 신호) 이 아예 실행되지 않았다 — 차단은 됐지만 이유가
  // 엉뚱한 에러로 보고됐다.
  //
  // 같은 blob 을 만드는 곳이 두 군데였고 둘 다 같은 버그를 갖고 있었다.
  // (오늘 srcset·isURLBearing 에 이어 세 번째 "목록/코드 복제" 사고다.)
  function blockedWorkerBlob() {
    return new Blob([
      'self.__ZP_WORKER_TARGET=', JSON.stringify(virtualURL.href),
      ';\nself.__ZP_WORKER_TAB_ID=', JSON.stringify(boot.tabId),
      ';\nimportScripts(', JSON.stringify(proxyOrigin + '/zp/assets/worker-prelude.js'), ');\n',
      "throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');\n",
    ], { type: 'text/javascript' });
  }
  // 인라인 style 선언 하나당 프록시 하나. 같은 선언에 늘 같은 프록시를 줘야
  // `el.style === el.style` 같은 페이지 코드의 동일성 비교가 깨지지 않는다.
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
              : v.bind(t);
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
    // url() 을 실을 수 있는 CSS 프로퍼티만 훅한다 — CSSStyleDeclaration 의
    // setter 는 350개가 넘어서 전수 훅은 부팅 비용이 크다.
    //
    // **함수 안에 두는 이유**: 모듈 스코프 `const` 로 두면 TDZ 에 걸린다.
    // 이 함수는 설치 시퀀스(installGetterMasking 부근)에서 불리는데 그 지점은
    // 선언보다 **위**라 `Cannot access 'X' before initialization` 이 나고,
    // 그 예외가 뒤따르는 멤브레인 설치를 통째로 중단시킨다. 실제로 자식
    // 프레임의 fetch/img 컨테인먼트가 깨졌다(매트릭스 e2/e3 회귀로 잡았다).
    const CSS_URL_PROPS = [
      'background', 'backgroundImage', 'borderImage', 'borderImageSource',
      'listStyle', 'listStyleImage', 'content', 'cursor', 'src',
      'mask', 'maskImage', 'webkitMask', 'webkitMaskImage', 'webkitMaskBoxImage',
      'shapeOutside', 'clipPath', 'offsetPath', 'filter', 'backdropFilter',
    ];
    const styleProto = w.HTMLStyleElement && w.HTMLStyleElement.prototype;
    if (styleProto) {
      for (const prop of ['textContent', 'innerText', 'innerHTML']) {
        const d = propertyDescriptor(styleProto, prop)
          || propertyDescriptor(w.Element && w.Element.prototype, prop)
          || propertyDescriptor(w.Node && w.Node.prototype, prop);
        if (!d || !d.set) continue;
        try {
          Object.defineProperty(styleProto, prop, {
            get() { return d.get ? originalStyleText(this, d.get.call(this)) : ''; },
            set(v) { originalTextMeta.set(this, String(v == null ? '' : v)); d.set.call(this, rewriteCSSText(v)); },
            configurable: false
          });
        } catch {}
      }
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
    // `el.style.backgroundImage = 'url(…)'` 는 프로토타입 훅으로 못 잡는다.
    // 이 엔진은 CSS 프로퍼티를 **인스턴스의 own data property** 로 노출한다
    // (실측: `getOwnPropertyDescriptor(document.body.style,'backgroundImage')`
    // → `own:true, set:없음`, prototype 에는 아예 없다). 그래서 350개를
    // 프로토타입에서 훅하려던 시도는 조용한 no-op 였다.
    //
    // 대신 `style` 게터가 **containment proxy** 를 돌려주게 한다 — 프로퍼티
    // 이름을 열거할 필요 없이 모든 쓰기가 set 트랩 하나를 지난다.
    const styleGetterProto = (w.HTMLElement && w.HTMLElement.prototype)
      || (w.Element && w.Element.prototype);
    const styleDesc = styleGetterProto && propertyDescriptor(styleGetterProto, 'style');
    if (styleDesc && styleDesc.get) {
      try {
        Object.defineProperty(styleGetterProto, 'style', {
          get() { return containStyleDeclaration(styleDesc.get.call(this)); },
          set: styleDesc.set ? function (v) { return styleDesc.set.call(this, rewriteCSSText(v)); } : undefined,
          enumerable: styleDesc.enumerable,
          configurable: false
        });
        styleHookState = 'ok';
      } catch (e) {
        styleHookState = 'failed:' + String(e && (e.message || e)).slice(0, 60);
      }
    } else {
      styleHookState = 'no-desc:' + (styleDesc ? 'nogetter' : 'null')
        + ':' + (styleGetterProto ? 'proto' : 'noproto');
    }
    const declProto = w.CSSStyleDeclaration && w.CSSStyleDeclaration.prototype;
    if (declProto) {
      const nativeSet = declProto.setProperty;
      if (typeof nativeSet === 'function') {
        define(declProto, 'setProperty', function (p, v, pr) { return nativeSet.call(this, p, rewriteCSSText(v), pr); });
      }
      for (const prop of ['cssText'].concat(CSS_URL_PROPS)) {
        const d = propertyDescriptor(declProto, prop);
        if (!d || !d.set) continue;
        try {
          Object.defineProperty(declProto, prop, {
            get() { return d.get ? d.get.call(this) : ''; },
            set(v) { d.set.call(this, rewriteCSSText(v)); },
            configurable: false
          });
        } catch {}
      }
    }
  }
  function installScriptTextProps(w) {
    const scriptProto = w.HTMLScriptElement && w.HTMLScriptElement.prototype;
    if (!scriptProto) return;
    for (const prop of ['text', 'textContent', 'innerText']) {
      const d = propertyDescriptor(scriptProto, prop) || propertyDescriptor(w.Node && w.Node.prototype, prop);
      if (!d || !d.set) continue;
      try {
        Object.defineProperty(scriptProto, prop, {
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
      Object.defineProperty(proto, 'src', {
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
      Object.defineProperty(proto, 'href', {
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
      Object.defineProperty(proto, 'rel', {
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
      if (url.indexOf(ZP.apiPath('fetch')) >= 0) return null;
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
    return t === 'importmap' ? 'importmap' : '';
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
  // ★★ 이 `const` 를 위(선언 블록)로 올리지 말 것 — "명백한 TDZ 버그" 처럼
  // 보이지만, 올리면 더 크게 깨진다. 실제로 올려서 측정했다(2026-08-16):
  //  - 지금은 prelude 초기화 중 installNetworkContainment → installBaseObserver
  //    호출이 TDZ 로 던지고 아래 `catch { return }` 가 삼켜서, **최초 문서에는
  //    이 옵저버가 안 걸린다**. (Cloudflare 인터스티셜에서 pause-on-exception
  //    으로 `ReferenceError: Cannot access 'bn' before initialization` 확인.)
  //  - 선언을 올려 그 호출이 성공하게 만들면 옵저버가 곧바로
  //    enforceSubtreePolicies / instrumentDescendantIframes 를 돌리는데, 이미
  //    계측된 창을 **두 번째로** 계측하면서 `TypeError: Cannot redefine
  //    property: <userAgent|href|innerHTML|serviceWorker|…>` 가 로드당 85건
  //    쏟아진다(= 위 "두 번째 시도는 무조건 던진다" 그 자리들).
  //    구멍 매트릭스 회귀: c5-beacon, c6-beacon-cross, e4-blank-iframe-img 가
  //    새로 깨진다(6건 → 9건). 나머지 축(진짜 유출 0)은 유지.
  // 즉 TDZ 가 **이중 계측 버그를 가려 주고 있다**. 순서를 고치려면 계측
  // 멱등성부터 고쳐야 한다 — 그건 별건이다.
  const observedDocuments = new WeakSet();
  function installBaseObserver(doc) {
    doc = doc || document;
    try { if (observedDocuments.has(doc)) return; } catch { return; }
    syncBaseElement(doc);
    // iframe Document 도 root.MutationObserver 로 관찰 가능 (cross-realm —
    // observer 는 부모 realm 의 MO 라도 child doc 을 정상 observe 한다).
    const MO = (doc.defaultView && doc.defaultView.MutationObserver) || root.MutationObserver;
    if (!MO || !doc.documentElement) return;
    try {
      new MO(records => {
        try { zpTrace('mo', 'n=' + records.length); } catch {}
        // Tick-scoped URL canonicalization cache — eliminates duplicate
        // `new URL()` parses for the same raw URL appearing across multiple
        // records (targetURLIfHTTP consults this cache; cached null short-
        // circuits the parse for definitively non-HTTP URLs).
        //
        // Pre-classify URL-attribute mutations with rt.classifySchemeOnly
        // when available — its ASCII fast path (~120-140 ns/op, beats JS
        // regex 153-200 ns) is cheap per call. Bench (Q round): schemeOnly
        // N times beats classifyBatch 2.1× because the batch ABI carries
        // ~280 ns/item production overhead (lens write, result view, scratch
        // layout) and does intern work the MO callback doesn't need.
        //
        // No threshold gate — the per-call cost is small enough that even
        // a single-mutation tick benefits when the URL turns out to be
        // non-HTTP (saves the 1300 ns new URL throw cost). For HTTP URLs
        // the ~120 ns is overhead but dwarfed by the main loop's parse.
        // Keep this cache scoped to one mutation batch; DOM bases may change later.
        tickURLCache = new Map();
        try {
          if (rt) {
            const HTTP = rt.UrlClass.HTTP, WS = rt.UrlClass.WS;
            for (const r of records) {
              if (r.type !== 'attributes') continue;
              const raw = Native.getAttribute.call(r.target, String(r.attributeName || ''));
              if (!raw || tickURLCache.has(raw)) continue;
              try {
                const cls = rt.classifySchemeOnly(raw);
                if (cls !== HTTP && cls !== WS) tickURLCache.set(raw, null);
              } catch { /* WASM hiccup — fall through to per-record main loop */ }
            }
          }
          for (const r of records) {
            if (r.type === 'attributes') enforceObservedAttribute(r.target, String(r.attributeName || '').toLowerCase());
            else for (const n of r.addedNodes || []) { syncBaseElement(n); enforceSubtreePolicies(n); instrumentDescendantIframes(n); }
          }
        } finally {
          tickURLCache = null;
        }
      }).observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'xlink:href', 'src', 'srcdoc', 'action', 'formaction', 'poster', 'integrity', 'type', 'rel', 'target', 'data'] });
      observedDocuments.add(doc);
    } catch {}
  }
  function enforceObservedAttribute(el, key) {
    if (!el || !key) return;
    const localKey = attrLocalName(key);
    const tag = el.localName;
    if (tag === 'base' && localKey === 'href') { syncBaseElement(el); return; }
    if (tag === 'link' && (localKey === 'rel' || localKey === 'href')) { enforceLinkPolicy(el); return; }
    if (localKey === 'sandbox' && isFrameElement(el)) { sanitizeFrameSandbox(el); return; }
    if (localKey === 'target' && isNavigationTargetElement(el)) { const raw = Native.getAttribute.call(el, key); if (raw && raw !== '_self') setSafeNavigationTarget(el, key, raw); return; }
    if (tag === 'script' && (localKey === 'src' || localKey === 'href' || localKey === 'type')) {
      const target = urlMeta.get(el) || Native.getAttribute.call(el, 'data-zp-target-url') || '';
      if (target && Native.getAttribute.call(el, 'src') === scriptProxyPath(target, executableScriptKindForElement(el) || 'classic')) return;
      const raw = target || Native.getAttribute.call(el, 'src') || Native.getAttribute.call(el, 'href');
      if (raw) setScriptSource(el, raw);
      return;
    }
    if (localKey === 'integrity' && isIntegrityBearing(el)) {
      const raw = Native.getAttribute.call(el, 'integrity');
      if (raw !== null) setBackedIntegrity(el, raw);
      return;
    }
    if ((tag === 'iframe' || tag === 'frame') && localKey === 'srcdoc') {
      const raw = Native.getAttribute.call(el, 'srcdoc');
      // 재주입 방지는 이제 WeakMap 이 본다. 문자열 접두 비교는 `?v=` 버전
      // 쿼리를 달고 다녀서 늘 아슬아슬했다 — 뒤의 비교는 남은 안전망이다.
      if (raw && !srcdocMeta.has(el) && !raw.startsWith(injectSrcdoc(''))) setInjectedSrcdoc(el, raw);
      instrumentIframe(el);
      return;
    }
    if (!isURLBearing(el, key, localKey, tag)) return;
    if (localKey === 'srcset' || localKey === 'imagesrcset') {
      const list = Native.getAttribute.call(el, key);
      if (list) enforceSrcsetAttribute(el, key, String(list));
      return;
    }
    const raw = Native.getAttribute.call(el, key);
    if (shouldBlockURLAttribute(el, localKey, raw, localKey, tag) || hasContextBlockedScheme(el, raw)) { blockExecutableURL(el, localKey, raw); return; }
    if (!raw) return;
    // 이미 프록시 경로인 값도 그냥 지나치면 안 된다: SW 를 못 거치는 프레임
    // 안이면 그 경로가 Go 서버로 직행해 403 이 된다. HTML 워커가 문자열
    // 단계에서 리라이트한 URL 은 요소 훅을 아예 안 타므로, 여기(서브트리
    // 스윕)가 그것들을 만나는 유일한 지점이다.
    if (String(raw).startsWith(proxyOrigin)) { upgradeSWLessURL(el, key, String(raw)); return; }
    // ★blob: 은 그냥 둔다. 위험한 태그(script/iframe/embed/object)는 바로 위
    // hasContextBlockedScheme 이 이미 막았고, 남은 건 봉인된 값이다 — SW-less
    // 프레임에 우리가 물려준 것이거나 페이지가 자기 Blob 으로 만든 것이고
    // 어느 쪽이든 밖으로 못 나간다. 여기서 target 을 다시 계산해 프록시
    // 경로로 덮으면 방금 넣은 blob 이 되돌려져 403 이 나고, 그 403 이 또
    // blob 업그레이드를 불러 왕복이 된다. e4-blank-iframe-img 가 이것 때문에
    // 간헐적으로 깨졌다.
    if (/^blob:/i.test(String(raw))) return;
    // 자리끼우개도 같은 이유로 그냥 둔다 — 여기서 프록시 경로로 되돌리면
    // 방금 없앤 403 왕복이 그대로 되살아난다.
    if (String(raw) === SWLESS_PIXEL) return;
    const target = targetURLForElement(el, raw);
    if (!target) return;
    const usesRaw = usesRawURLAttribute(el, key, localKey);
    const alreadyMapped = urlMeta.get(el) === target && (!usesRaw ? Native.getAttribute.call(el, 'data-zp-target-url') === target : true);
    urlMeta.set(el, target);
    if (!usesRaw) Native.setAttribute.call(el, 'data-zp-target-url', target);
    if ((tag === 'iframe' || tag === 'frame') && localKey === 'src') {
      Native.setAttribute.call(el, key, 'about:blank');
      activatedFrameURL(target).then(u => { Native.setAttribute.call(el, key, u); rememberFrameOrigin(el); }).catch(()=>{});
      instrumentIframe(el);
      return;
    }
    if (alreadyMapped) return;
    // 수동 서브리소스는 프록시 경로로 (htmltx 와 동일). navigation 속성은
    // usesRaw 쪽에서 이미 '?via=' 형태로 처리된다.
    if (!usesRaw) setSubresourceAttribute(el, key, subresourceProxyPath(target));
  }
  // `<style>` 의 텍스트가 **자식 텍스트 노드로** 들어오는 경로. prelude 의
  // textContent/innerHTML 훅은 프로퍼티 쓰기만 덮으므로
  //   s = createElement('style'); head.appendChild(s);
  //   s.appendChild(document.createTextNode(css));
  // 는 통째로 새어 나간다. jQuery 계열이 쓰는 아주 흔한 관용구다 —
  // naver.com 장바구니의 GNB 스프라이트가 정확히 이 경로로 원본 URL 을
  // 유지한 채 `img-src 'self'` 에 걸려 아이콘이 통째로 안 떴다.
  function enforceStyleElementCSS(el) {
    if (!el || el.localName !== 'style') return;
    const get = Native.nodeTextContent && Native.nodeTextContent.get;
    const raw = (get ? get.call(el) : el.textContent) || '';
    if (!raw) return;
    const mapped = rewriteCSSText(raw);
    if (mapped === raw) return;
    // 프로퍼티 훅(`HTMLStyleElement.prototype.textContent`)을 **일부러** 탄다.
    // 네이티브 setter 를 직접 부르는 판이 실측에서 이 시트를 안 고쳤다.
    // 훅 경로는 같은 시트를 25/25 고치는 것이 확인됐고, 이미 프록시 URL 인
    // 값은 `cssProxyURL` 이 걸러내므로 재진입해도 idempotent 다.
    try { el.textContent = mapped; } catch {}
  }
  function enforceSubtreePolicies(node) {
    if (!node || typeof node !== 'object') return;
    // 추가된 것이 텍스트 노드면 그 자체는 정책 대상이 아니지만, 부모가
    // `<style>` 이면 방금 CSS 가 주입된 것이다.
    if (node.nodeType === 3 && node.parentNode) enforceStyleElementCSS(node.parentNode);
    if (node.nodeType === 1) enforceElementPolicy(node);
    if (node.querySelectorAll) {
      node.querySelectorAll('script,link,iframe,frame,a,area,form,input,button,img,source,audio,video,track,object,embed,svg a,svg image,svg use').forEach(enforceElementPolicy);
      node.querySelectorAll('style').forEach(enforceStyleElementCSS);
    }
  }
  function enforceElementPolicy(el) {
    if (!el || !el.localName) return;
    if (el.localName === 'style') enforceStyleElementCSS(el);
    if (el.localName === 'script') instrumentScriptElement(el);
    if (el.localName === 'link') enforceLinkPolicy(el);
    if (el.localName === 'iframe' || el.localName === 'frame') instrumentIframe(el);
    if (Native.getAttributeNames) {
      for (const name of Native.getAttributeNames.call(el)) enforceObservedAttribute(el, String(name).toLowerCase());
    }
  }

  function installWorkerHooks() {
    if (Native.Worker) {
      // The wrapper returns a REAL Worker, so its own `.prototype` was never on
      // the returned object's chain: `Worker.prototype` showed just
      // `["constructor"]` (5 names natively) and — worse — `new Worker(u)
      // instanceof Worker` was FALSE, since instanceof walks the wrapper's
      // prototype. Point the wrapper at the native prototype to fix both.
      const ZPWorker = function (url, opts) {
        try { zpTrace('Worker', String(url).slice(0, 120)); } catch {}
        return new Native.Worker(workerBootstrapURL(url), opts);
      };
      try { ZPWorker.prototype = Native.Worker.prototype; } catch {}
      // Only the constructor name — the prototype is the native one, which
      // already carries the correct Symbol.toStringTag.
      brandLikeNative(ZPWorker, null, 'Worker');
      define(root, 'Worker', ZPWorker);
    }
    if (Native.SharedWorker) define(root, 'SharedWorker', function(url, opts) { try { zpTrace('SharedWorker', String(url).slice(0,120)); } catch {} return new Native.SharedWorker(workerBootstrapURL(url), opts); });
    if (navigator.serviceWorker && navigator.serviceWorker.register) define(navigator.serviceWorker, 'register', function() { return Promise.reject(normalizedError('NotSupportedError')); });
    // 갈아치우기는 **쓸 때** 한다 — 만들 때가 아니다 (2026-08-26).
    //
    // 예전에는 여기서 MIME 을 보고 스크립트성이면 그 자리에서 차단 blob 으로
    // 바꿔 URL 을 돌려줬다. 그런데 new MediaSource() 에는 type 이 아예 없어서
    // 빈 문자열이 되고 정규식의 ^$ 에 걸린다. 즉 **MSE 핸들이 HTML 한 조각으로
    // 바뀌었고**, 붙이는 순간 DEMUXER_ERROR_COULD_NOT_OPEN 이 났다.
    // CNN 실측: Max 플레이어가 통째로 죽어 비디오 세그먼트가 0건이었다
    // (대조군 akm.*.media.max.com 115건 vs 프록시 0건). text/plain 이나 타입
    // 없는 평범한 Blob 도 같이 죽었다 — fetch(blobURL) 이 페이지가 넣은 내용
    // 대신 우리 HTML 을 돌려줬다.
    //
    // 보안 경계는 여기가 아니라 workerBootstrapURL 이다: 우리가 만든 것이
    // 아닌 blob URL 을 워커로 쓰면 이미 거부한다. 그러니 만드는 것은 그대로
    // 두고 **워커로 쓰려 할 때만** 차단 blob 으로 바꾼다 — 페이지가 보는
    // 모양은 예전과 같고(생성자에서 안 던진다), 무관한 blob 은 산다.
    if (Native.createObjectURL) define(URL, 'createObjectURL', function(blob) {
      const url = Native.createObjectURL(blob);
      try { if (blob && SCRIPTISH_BLOB_TYPE.test(blob.type || '')) scriptishBlobURLs.add(String(url)); } catch {}
      return url;
    });
    if (Native.revokeObjectURL) define(URL, 'revokeObjectURL', function(url) {
      const key = String(url);
      scriptishBlobURLs.delete(key);
      workerBlobURLs.delete(key);
      return Native.revokeObjectURL(url);
    });
    for (const name of ['audioWorklet','paintWorklet','layoutWorklet','animationWorklet']) { const wk = root.CSS && root.CSS[name] || root[name]; if (wk && wk.addModule) define(wk, 'addModule', function(url, opts){ return wk.addModule(workerBootstrapURL(url), opts); }); }
  }
  // D3: virtual SW facade. The original behavior was a hard
  // `NotSupportedError` reject, which made every site gating feature init
  // on `serviceWorker.register(...).then(...)` go down the
  // unhandled-rejection path. The full plan (run target SW code in an
  // isolated ZP_VIRTUAL_SW realm + dispatch sync/periodicsync/push events)
  // is out of scope for Phase 2; we provide a "fail soft" stand-in:
  //   - register/ready/getRegistration[s] resolve to a fake registration
  //   - SyncManager / PeriodicSyncManager register cleanly + never fire
  //     (matches native — browsers may delay sync indefinitely)
  //   - PushManager.subscribe rejects NotAllowedError (denied-permission shape)
  //   - navigationPreload is a no-op shim
  // Egress invariants stay closed: target JS can't intercept fetch, can't
  // schedule a real background sync, can't push from outside our origin.
  function installTargetServiceWorkerBlocker(w) {
    const nav = w && w.navigator;
    if (!nav) return;
    if (serviceWorkerFacades.has(w)) return;
    const facade = {};

    const fakeReg = {};
    const syncMgr = {};
    define(syncMgr, 'register', function register(tag) { return Promise.resolve(String(tag || '')); });
    define(syncMgr, 'getTags', function getTags() { return Promise.resolve([]); });
    const periodicSyncMgr = {};
    define(periodicSyncMgr, 'register', function register(tag, _opts) { return Promise.resolve(String(tag || '')); });
    define(periodicSyncMgr, 'unregister', function unregister(_tag) { return Promise.resolve(undefined); });
    define(periodicSyncMgr, 'getTags', function getTags() { return Promise.resolve([]); });
    const pushMgr = {};
    define(pushMgr, 'subscribe', function subscribe() { return Promise.reject(normalizedError('NotAllowedError')); });
    define(pushMgr, 'getSubscription', function getSubscription() { return Promise.resolve(null); });
    define(pushMgr, 'permissionState', function permissionState() { return Promise.resolve('denied'); });
    const navPreload = {};
    define(navPreload, 'enable', function enable() { return Promise.resolve(undefined); });
    define(navPreload, 'disable', function disable() { return Promise.resolve(undefined); });
    define(navPreload, 'setHeaderValue', function setHeaderValue() { return Promise.resolve(undefined); });
    define(navPreload, 'getState', function getState() { return Promise.resolve({ enabled: false, headerValue: '' }); });

    defineAccessor(fakeReg, 'scope', () => { try { return virtualURL.origin + '/'; } catch { return '/'; } });
    defineAccessor(fakeReg, 'active', () => null);
    defineAccessor(fakeReg, 'installing', () => null);
    defineAccessor(fakeReg, 'waiting', () => null);
    defineAccessor(fakeReg, 'updateViaCache', () => 'imports');
    defineAccessor(fakeReg, 'sync', () => syncMgr);
    defineAccessor(fakeReg, 'periodicSync', () => periodicSyncMgr);
    defineAccessor(fakeReg, 'pushManager', () => pushMgr);
    defineAccessor(fakeReg, 'navigationPreload', () => navPreload);
    define(fakeReg, 'update', function update() { return Promise.resolve(undefined); });
    define(fakeReg, 'unregister', function unregister() { return Promise.resolve(true); });
    define(fakeReg, 'showNotification', function showNotification() { return Promise.reject(normalizedError('NotAllowedError')); });
    define(fakeReg, 'getNotifications', function getNotifications() { return Promise.resolve([]); });
    define(fakeReg, 'addEventListener', function addEventListener() {});
    define(fakeReg, 'removeEventListener', function removeEventListener() {});

    const readyPromise = Promise.resolve(fakeReg);
    let oncontrollerchange = null;
    define(facade, 'register', function register() { return Promise.resolve(fakeReg); });
    define(facade, 'getRegistration', function getRegistration() { return Promise.resolve(fakeReg); });
    define(facade, 'getRegistrations', function getRegistrations() { return Promise.resolve([fakeReg]); });
    define(facade, 'startMessages', function startMessages() {});
    define(facade, 'addEventListener', function addEventListener() {});
    define(facade, 'removeEventListener', function removeEventListener() {});
    // controller stays null — no SW actually controls the target realm.
    defineAccessor(facade, 'controller', () => null);
    defineAccessor(facade, 'ready', () => readyPromise);
    defineAccessor(facade, 'oncontrollerchange', () => oncontrollerchange, v => { oncontrollerchange = typeof v === 'function' ? v : null; });
    const existing = (() => { try { return nav.serviceWorker; } catch { return null; } })();
    if (existing && existing !== facade) {
      define(existing, 'register', facade.register);
      define(existing, 'getRegistration', facade.getRegistration);
      define(existing, 'getRegistrations', facade.getRegistrations);
      define(existing, 'startMessages', facade.startMessages);
      defineAccessor(existing, 'controller', () => null);
      defineAccessor(existing, 'ready', () => readyPromise);
      defineAccessor(existing, 'oncontrollerchange', () => oncontrollerchange, v => { oncontrollerchange = typeof v === 'function' ? v : null; });
    }
    serviceWorkerFacades.set(w, facade);
    const proto = w.Navigator && w.Navigator.prototype || Object.getPrototypeOf(nav);
    defineOnProto(nav, proto, 'serviceWorker', () => facade);
  }
  function workerBootstrapURL(url) {
    const raw = String(url);
    const parsed = new URL(raw, virtualURL.href);
    if (parsed.protocol === 'blob:') {
      // 우리가 이미 만들어 둔 차단 blob 이면 그대로 쓴다.
      if (workerBlobURLs.has(parsed.href)) return parsed.href;
      // 페이지가 만든 스크립트성 blob 을 워커로 쓰려는 **바로 그 순간**에만
      // 갈아치운다. 리라이터를 안 거친 코드가 워커로 도는 일은 없다.
      if (scriptishBlobURLs.has(parsed.href) && Native.createObjectURL) {
        const raw = String(Native.createObjectURL(blockedWorkerBlob()));
        workerBlobURLs.add(raw);
        return raw;
      }
      throw normalizedError('NotSupportedError');
    }
    if (parsed.protocol === 'data:') return dataWorkerURL(parsed.href);
    const params = new URLSearchParams();
    params.set('u', requestTargetURL(raw));
    params.set('tab', boot.tabId);
    for (const server of activeServers) params.append('server', server);
    // Absolute proxy URL — Worker resolves the URL relative to the page's
    // baseURI, which is virtualised to the target host.
    return proxyOrigin + ZP.controlPath('worker-bootstrap.js') + '#' + params.toString();
  }
  function dataWorkerURL(raw) {
    const comma = raw.indexOf(',');
    if (comma < 0) throw normalizedError('NotSupportedError');
    const blocked = blockedWorkerBlob();
    const safe = Native.createObjectURL(blocked);
    workerBlobURLs.add(safe);
    return safe;
  }

  function installIframeHooks(w) {
    if (!w || !w.document || !w.Node || !w.Element) return;
    try {
      if (w[iframeHooksMarker]) return;
      Object.defineProperty(w, iframeHooksMarker, { value: true, enumerable: false, configurable: false });
    } catch {}
    const instrumentedWindows = new WeakSet();
    const nativeCreateElement = w === root ? Native.createElement : w.document.createElement.bind(w.document);
    const nativeCreateElementNS = w === root ? Native.createElementNS : w.document.createElementNS && w.document.createElementNS.bind(w.document);

    installFrameAccessors(w.HTMLIFrameElement && w.HTMLIFrameElement.prototype);
    installFrameAccessors(w.HTMLFrameElement && w.HTMLFrameElement.prototype);

    // Natively these live on Document.prototype, so defining them on the
    // document INSTANCE was both a fingerprint (own names a real document does
    // not have) and a coverage hole: a second document — from
    // document.implementation.createHTMLDocument() or DOMParser — kept the
    // untouched native and created script/iframe nodes with no instrumentation.
    //
    // Relocating needs `this`-correct dispatch. `nativeCreateElement` is BOUND
    // to w.document, so calling it for another document would put the element in
    // the wrong one; use the unbound prototype method with the real receiver
    // instead. Captured before we overwrite it.
    const docProtoForCreate = w.Document && w.Document.prototype;
    const rawCreateElement = docProtoForCreate && docProtoForCreate.createElement;
    const rawCreateElementNS = docProtoForCreate && docProtoForCreate.createElementNS;
    defineMethodOnProto(w.document, docProtoForCreate, 'createElement', function createElement(name, opts) {
      const n = String(name);
      if (/^(i?frame|script|worker|object|embed)$/i.test(n)) { try { zpTrace('createElement', n); } catch {} }
      const el = rawCreateElement ? rawCreateElement.call(this, n, opts) : nativeCreateElement(n, opts);
      if (/^i?frame$/i.test(n)) instrumentDescendantIframes(el);
      if (/^script$/i.test(n)) instrumentScriptElement(el);
      return el;
    });
    if (nativeCreateElementNS) defineMethodOnProto(w.document, docProtoForCreate, 'createElementNS', function createElementNS(ns, name, opts) {
      const el = rawCreateElementNS
        ? rawCreateElementNS.call(this, String(ns), String(name), opts)
        : nativeCreateElementNS(String(ns), String(name), opts);
      if (/^script$/i.test(String(name))) instrumentScriptElement(el);
      return el;
    });

    patchInsertion(w.Node.prototype, 'appendChild', w.Node.prototype.appendChild);
    patchInsertion(w.Node.prototype, 'insertBefore', w.Node.prototype.insertBefore);
    patchInsertion(w.Node.prototype, 'replaceChild', w.Node.prototype.replaceChild);
    for (const proto of [w.Element && w.Element.prototype, w.Document && w.Document.prototype, w.DocumentFragment && w.DocumentFragment.prototype]) {
      for (const method of ['append', 'prepend', 'before', 'after', 'replaceWith']) patchInsertion(proto, method, proto && proto[method]);
    }

    if (w.HTMLIFrameElement) { installFrameProp(w.HTMLIFrameElement.prototype, 'src'); installFrameProp(w.HTMLIFrameElement.prototype, 'srcdoc'); }
    if (w.HTMLFrameElement) installFrameProp(w.HTMLFrameElement.prototype, 'src');

    function patchInsertion(proto, name, nativeFn) {
      if (!proto || typeof nativeFn !== 'function') return;
      define(proto, name, function(...args) {
        prepareActivatingNodes(args);
        const frames = collectIframesFromArgs(args);
        const ret = nativeFn.apply(this, args);
        instrumentFrameList(frames);
        return ret;
      });
    }
    function installFrameAccessors(proto) {
      if (!proto) return;
      const win = frameDescriptor(proto, 'contentWindow');
      if (win && win.get) {
        try { Object.defineProperty(proto, 'contentWindow', { get() { return containFrameWindow(win.get.call(this), this); }, configurable: false, enumerable: true }); } catch {}
      }
      const doc = frameDescriptor(proto, 'contentDocument');
      if (doc && doc.get) {
        try { Object.defineProperty(proto, 'contentDocument', { get() { const childDoc = doc.get.call(this); if (childDoc && childDoc.defaultView) containFrameWindow(childDoc.defaultView, this); return childDoc; }, configurable: false, enumerable: true }); } catch {}
      }
    }
    function frameDescriptor(proto, prop) {
      for (let p = proto; p; p = Object.getPrototypeOf(p)) {
        const d = Object.getOwnPropertyDescriptor(p, prop);
        if (d) return d;
      }
      return null;
    }
    function containFrameWindow(childWin, frame) {
      if (!childWin) return childWin;
      try { if (childWin[networkContainmentMarker]) return childWin; } catch { if (instrumentedWindows.has(childWin)) return childWin; }
      // Skip parent's containment if the frame is queued to navigate to its
      // own target URL. installNetworkContainment closes over the parent's
      // `virtualURL`; same-origin navigation reuses the iframe Window object,
      // so the installed origin/document.origin getters persist on
      // iframe.Document.prototype AND the iframe.document instance. The
      // iframe's own runtime-prelude can't override the document-instance
      // wrap that was bound before navigation. Letting the iframe install
      // its own membrane fresh after load is the correct path.
      try {
        if (frame && Native.getAttribute && Native.getAttribute.call(frame, 'data-zp-target-url')) {
          // 이 프레임은 자기 prelude 가 붙을 때까지 부모가 손대지 않는다.
          // 다만 그 **사이 구간**에 부모가 `iframe.contentWindow.postMessage(
          // msg, 'https://<타깃>')` 를 쏘면 네이티브가 받는다 — 프록시에서는
          // 수신 창의 실제 오리진이 프록시 오리진이라 타깃 오리진과 안 맞고
          // 메시지가 **조용히 버려진다**. naver 의 ndp-core 가 광고 슬롯에
          // 정확히 이걸 한다(로드당 9건). 매핑만은 미리 걸어 둔다.
          installEarlyPostMessage(childWin);
          return childWin;
        }
      } catch {}
      instrumentedWindows.add(childWin);
      try { installNetworkContainment(childWin); }
      catch (e) {
        instrumentedWindows.delete(childWin);
        try { frame && frame.remove && frame.remove(); } catch {}
        throw e;
      }
      // 여기가 SW-less 프레임을 발견하는 제자리다. 백스톱 타이머
      // (500/1500/3000ms)에만 기대면 그 뒤에 만들어지는 광고 프레임을 통째로
      // 놓친다 — 실측에서 같은 페이지가 로드마다 되기도 하고 안 되기도 했다.
      try { documentIsSWLess(childWin.document); } catch {}
      return childWin;
    }
    function installFrameProp(proto, prop) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) return;
      try {
        Object.defineProperty(proto, prop, {
          get: prop === 'srcdoc'
            ? function () { return srcdocMeta.has(this) ? srcdocMeta.get(this) : d.get.call(this); }
            : d.get,
          set(v) {
            if (prop === 'srcdoc') setInjectedSrcdoc(this, v);
            else {
              const t = String(v).startsWith(proxyOrigin) ? null : targetURLForElement(this, v);
              if (t) {
                urlMeta.set(this, t);
                Native.setAttribute.call(this, 'data-zp-target-url', t);
                d.set.call(this, 'about:blank');
                activatedFrameURL(t).then(u => { d.set.call(this, u); rememberFrameOrigin(this); }).catch(()=>{});
              } else d.set.call(this, v);
            }
            instrumentIframe(this);
          },
          configurable: false
        });
        // srcdoc 게터를 JS 함수로 갈아끼웠으므로 toString 위장을 같이 건다 —
        // 안 하면 "게터 소스를 읽어 본다" 는 흔한 검사에 우리만 튄다.
        const installed = Object.getOwnPropertyDescriptor(proto, prop);
        if (installed && typeof installed.get === 'function' && installed.get !== d.get) toStringMap.set(installed.get, nativeAccessorSource('get', prop));
        if (installed && typeof installed.set === 'function') toStringMap.set(installed.set, nativeAccessorSource('set', prop));
      } catch {}
    }
  }
  function prepareActivatingNodes(args) {
    for (const node of args || []) prepareActivatingNode(node);
  }
  function prepareActivatingNode(node) {
    if (!node || typeof node !== 'object') return;
    if ((node.nodeName || '').toUpperCase() === 'SCRIPT') prepareScriptElement(node);
    if (/^(IFRAME|FRAME)$/.test(node.nodeName || '')) sanitizeFrameSandbox(node);
    if (node.querySelectorAll) {
      const scripts = node.querySelectorAll('script');
      for (let i = 0; i < scripts.length; i++) prepareScriptElement(scripts[i]);
      const frames = node.querySelectorAll('iframe,frame');
      for (let i = 0; i < frames.length; i++) sanitizeFrameSandbox(frames[i]);
    }
  }
  function collectIframesFromArgs(args) {
    let frames = null;
    for (const node of args) frames = collectIframes(node, frames);
    return frames;
  }
  function collectIframes(node, frames) {
    if (!node || typeof node !== 'object') return frames;
    if (/^(IFRAME|FRAME)$/.test(node.nodeName || '')) {
      if (!frames) frames = [];
      frames.push(node);
    }
    if (node.querySelectorAll) {
      const descendants = node.querySelectorAll('iframe,frame');
      for (let i = 0; i < descendants.length; i++) {
        if (!frames) frames = [];
        frames.push(descendants[i]);
      }
    }
    return frames;
  }
  function instrumentFrameList(frames) { if (frames) for (const frame of frames) instrumentIframe(frame); }
  function instrumentDescendantIframes(node) { instrumentFrameList(collectIframes(node, null)); }
  function instrumentIframe(frame) {
    if (!frame || !/^(IFRAME|FRAME)$/.test(frame.nodeName || '')) return;
    try {
      const src = Native.getAttribute.call(frame, 'src');
      try { zpTrace('iframe', (src || 'about:blank').slice(0, 160)); } catch {}
      rememberFrameOrigin(frame);
      // If the frame already has a target URL queued (will navigate to a
      // share URL momentarily via activatedFrameURL), do NOT install the
      // parent's containment on the temporary about:blank window. The
      // installation closes over the parent's `virtualURL`; when the iframe
      // navigates same-origin, the Window object is reused and parent's
      // getters (origin/document.origin/window.origin) persist on iframe's
      // Document.prototype — making the iframe think its origin is the
      // parent's URL. The iframe's own runtime-prelude installs the right
      // membrane (with the iframe's virtualURL) after navigation.
      const willNavigate = !!Native.getAttribute.call(frame, 'data-zp-target-url');
      if ((!src || /^about:blank$/i.test(src)) && frame.contentWindow && !willNavigate) installNetworkContainment(frame.contentWindow);
      installSafeFrameResizeShim(frame);
    } catch { try { frame.remove(); } catch {} }
  }
  // NAVER GFP simple-bridge SafeFrame-emulation ads: iframe.name carries
  // {evtType:'sf-init', iFrameId, msgToken, adm, isFluid:true, ...} and the
  // host (gfp-nda.js handleMsgEvt) waits for {evtType:'sf-resized',
  // params:{frameHeight}} to apply iframe.style.height. But the non-SafeFrame
  // branch (forceSafeFrame=false) loads only gfp-bridge.js inside — pure
  // tracking, no ResizeObserver, no sf-resized sender. Result: ad body
  // renders inside but iframe stays height:0. Direct parent-side height
  // mirroring via ResizeObserver+MutationObserver fills the gap without
  // touching NAVER's message protocol — host's own update path is still
  // available when SF_RESIZED arrives by any other route.
  function installSafeFrameResizeShim(frame) {
    if (!frame || !frame.style || !Native.getAttribute) return;
    try { zpTrace('sfShim:enter'); } catch {}
    let init = null;
    try {
      const name = Native.getAttribute.call(frame, 'name');
      if (!name || name.length < 2 || name[0] !== '{') return;
      init = JSON.parse(name);
    } catch { return; }
    if (!init || init.evtType !== 'sf-init') return;
    try { if (frame[safeFrameShimMarker]) return; Object.defineProperty(frame, safeFrameShimMarker, { value: true, enumerable: false, configurable: false }); } catch {}
    let lastH = 0;
    const apply = () => {
      try {
        const doc = frame.contentDocument;
        if (!doc || !doc.body) return;
        // Body in non-SafeFrame iframe wraps a banner ad. Use max of common
        // height signals — images load late so we want largest stable size.
        const b = doc.body;
        const h = Math.max(b.scrollHeight || 0, b.offsetHeight || 0, doc.documentElement ? (doc.documentElement.scrollHeight || 0) : 0);
        if (h > 0 && h !== lastH) {
          lastH = h;
          frame.style.height = h + 'px';
        }
      } catch {}
    };
    let tries = 0;
    const start = () => {
      let doc = null;
      try { doc = frame.contentDocument; } catch {}
      if (!doc || !doc.body) {
        if (tries++ < 100) try { root.setTimeout(start, 50); } catch {}
        return;
      }
      // Poll: ResizeObserver across realms is unreliable for image-loaded
      // reflow in non-SafeFrame ads. Adaptive backoff — height 안 바뀌면
      // interval 점진 증가 (200→400→800→1600→2000ms cap), 바뀌면 reset.
      // Per-tick `scrollHeight`/`offsetHeight` 가 layout reflush 강제하므로
      // backoff 가 cumulative reflow cost 를 크게 줄임 (3-5 SafeFrame iframes
      // 가 영구 200ms polling 하면 reflow noise 누적). image load event 가
      // 별도 hook 으로 작동하므로 backoff 가 첫 안정화 후 reflow 누락 없음.
      try {
        let interval = 200;
        let stableTicks = 0;
        const tick = () => {
          const before = lastH;
          apply();
          if (lastH === before) {
            stableTicks++;
            if (stableTicks >= 3 && interval < 2000) interval = Math.min(interval * 2, 2000);
          } else {
            stableTicks = 0;
            interval = 200;
          }
          try { root.setTimeout(tick, interval); } catch {}
        };
        tick();
      } catch {}
      // Also hook image load events for instant snap after image arrival.
      try {
        const imgs = doc.querySelectorAll('img');
        for (let i = 0; i < imgs.length; i++) {
          try { imgs[i].addEventListener('load', apply, { once: true }); } catch {}
        }
      } catch {}
    };
    start();
  }
  // D4: virtual WebTransport that proxies through the ZeroProxy
  // gateway when one is configured (`boot.wtGateway` set by the server
  // via `/zp/api/config`). The virtual class wraps the *native*
  // WebTransport: the page calls `new WebTransport(targetUrl)`, we
  // build a gateway URL `gw?target=<encoded>&tab=<id>` and instantiate
  // the native class against the gateway. Everything else
  // (`ready`, `closed`, streams, datagrams) is delegated directly to
  // the native instance, so the IDL surface stays identical without
  // re-implementing stream wrappers.
  //
  // When `boot.wtGateway` is empty (operator hasn't set `-wt-public-url`)
  // or the browser lacks native WT, we fall back to the rejected-
  // promise stub so target code's `.ready.catch(...)` branch fires
  // cleanly. The stub path also covers the legacy WebSocketStream slot.
  function makeWebTransportConstructor() {
    const NativeWT = Native.WebTransport;
    const gateway = (boot && typeof boot.wtGateway === 'string' && boot.wtGateway) ? boot.wtGateway : '';
    if (!NativeWT || !gateway) {
      return makeVirtualGateway('WebTransport', { code: 'WT_UNSUPPORTED', kind: 'WebTransport' });
    }
    function ZPWebTransport(targetUrl, opts) {
      if (!(this instanceof ZPWebTransport)) {
        throw new TypeError("Failed to construct 'WebTransport': Please use the 'new' operator.");
      }
      const target = String(targetUrl == null ? '' : targetUrl);
      // Validate the target URL minimally — browsers throw SyntaxError for
      // invalid URLs and TypeError for wrong schemes; we mirror to keep
      // feature-detection of "WT throws on bad URL" working.
      let parsed;
      try { parsed = new URL(target); } catch { throw normalizedError('SyntaxError'); }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'wt:') {
        throw normalizedError('SyntaxError');
      }
      const gw = new URL(gateway);
      const params = gw.searchParams;
      params.set('target', target);
      if (boot && boot.tabId) params.set('tab', String(boot.tabId));
      // Build the gateway URL with our target injected. The native WT
      // ctor will throw SyntaxError if the gw URL isn't https.
      const native = new NativeWT(gw.toString(), opts);
      // Delegate every property via a Proxy so target code that does
      // `wt.ready.then(...)` or `wt.createBidirectionalStream()` etc.
      // sees the native object's IDL surface byte-for-byte. We override
      // only `close` so we can record local state if needed; everything
      // else falls through.
      this._native = native;
    }
    // Expose the same readonly properties as the native WT spec by
    // forwarding to the underlying instance. We can't use a Proxy as the
    // class identity (target code may do `wt instanceof WebTransport`
    // against our class object), so we define instance accessors.
    function forward(name) {
      Object.defineProperty(ZPWebTransport.prototype, name, {
        configurable: true,
        get() { try { return this._native[name]; } catch { return undefined; } },
      });
    }
    forward('ready');
    forward('closed');
    forward('datagrams');
    forward('incomingBidirectionalStreams');
    forward('incomingUnidirectionalStreams');
    forward('reliability');
    forward('congestionControl');
    forward('protocol');
    ZPWebTransport.prototype.createBidirectionalStream = function(opts) {
      return this._native.createBidirectionalStream(opts);
    };
    ZPWebTransport.prototype.createUnidirectionalStream = function(opts) {
      return this._native.createUnidirectionalStream(opts);
    };
    ZPWebTransport.prototype.close = function(closeInfo) {
      try { return this._native.close(closeInfo); } catch { return undefined; }
    };
    ZPWebTransport.prototype.addEventListener = function(type, listener, opts) {
      try { return this._native.addEventListener(type, listener, opts); } catch {}
    };
    ZPWebTransport.prototype.removeEventListener = function(type, listener, opts) {
      try { return this._native.removeEventListener(type, listener, opts); } catch {}
    };
    ZPWebTransport.prototype.dispatchEvent = function(ev) {
      try { return this._native.dispatchEvent(ev); } catch { return true; }
    };
    return ZPWebTransport;
  }

  // D5: virtual RTCPeerConnection that wraps the *native* RTCPC and
  // routes all signaling (offer / answer / ICE candidates) through the
  // ZeroProxy gateway (`boot.rtcGateway`). Native RTCPC handles the
  // media/DTLS/SCTP stack locally; the gateway maintains a parallel
  // PeerConnection on its side and SFU-forwards tracks + data channels
  // to the target's real remote peer. The target never sees the page's
  // real IP because all candidates that reach the remote peer originate
  // from the gateway.
  //
  // When `boot.rtcGateway` is empty (operator hasn't enabled the D5
  // gateway) or native RTCPC is absent, we fall back to the legacy
  // rejected-promise stub (`makeVirtualGateway`).
  function makeRTCPeerConnectionConstructor(name) {
    const NativeRTC = root.RTCPeerConnection || root.webkitRTCPeerConnection;
    const gateway = (boot && typeof boot.rtcGateway === 'string' && boot.rtcGateway) ? boot.rtcGateway : '';
    if (!NativeRTC || !gateway) {
      return makeVirtualGateway(name, { code: 'RTC_GATEWAY_UNAVAILABLE', kind: 'WebRTC' });
    }
    let sessionCounter = 0;
    function ZPRTCPeerConnection(config) {
      if (!(this instanceof ZPRTCPeerConnection)) {
        throw new TypeError("Failed to construct '" + name + "': Please use the 'new' operator.");
      }
      // We don't trust the page-supplied iceServers — they'd point at
      // remote STUN/TURN that could leak IP. Replace with the
      // operator's embedded TURN cred tuple (from `boot.rtcICEServers`)
      // when present; otherwise force empty so the native PC only
      // generates host candidates the gateway signaling can route.
      const safeConfig = Object.assign({}, config || {});
      const issuedICEServers = (boot && Array.isArray(boot.rtcICEServers))
        ? boot.rtcICEServers
        : [];
      safeConfig.iceServers = issuedICEServers;
      safeConfig.iceTransportPolicy = 'all';
      const native = new NativeRTC(safeConfig);
      this._native = native;
      const sid = (boot && boot.tabId ? boot.tabId : 'sess') + '-' + (++sessionCounter) + '-' + Date.now().toString(36);
      this._sessionId = sid;
      // Forward locally-generated ICE candidates to the gateway.
      try {
        native.addEventListener('icecandidate', ev => {
          const cand = ev && ev.candidate;
          if (!cand) return;
          postSignal({ op: 'candidate', sessionId: sid, candidate: cand.toJSON ? cand.toJSON() : { candidate: cand.candidate, sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex } });
        });
      } catch {}
      // Start the long-poll loop to pull gateway-originated events.
      this._pollCtl = startSignalPoll(this, sid);
    }
    function postSignal(env) {
      try {
        return Native.fetch(gateway, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(env),
          credentials: 'same-origin',
        });
      } catch { return Promise.resolve(); }
    }
    function startSignalPoll(self, sid) {
      let stopped = false;
      (async function loop() {
        while (!stopped) {
          try {
            const r = await Native.fetch(gateway + '?session=' + encodeURIComponent(sid), { credentials: 'same-origin' });
            if (!r.ok) { await new Promise(res => setTimeout(res, 1000)); continue; }
            const envs = await r.json();
            if (!Array.isArray(envs)) continue;
            for (const env of envs) {
              try { await applyEnvelope(self, env); } catch {}
            }
          } catch {
            await new Promise(res => setTimeout(res, 1000));
          }
        }
      })();
      return { stop() { stopped = true; } };
    }
    async function applyEnvelope(self, env) {
      if (!env || typeof env !== 'object') return;
      if (env.op === 'answer' && env.sdp) {
        await self._native.setRemoteDescription(env.sdp);
      } else if (env.op === 'offer' && env.sdp) {
        await self._native.setRemoteDescription(env.sdp);
        const ans = await self._native.createAnswer();
        await self._native.setLocalDescription(ans);
        postSignal({ op: 'answer', sessionId: self._sessionId, sdp: self._native.localDescription });
      } else if (env.op === 'candidate' && env.candidate) {
        try { await self._native.addIceCandidate(env.candidate); } catch {}
      } else if (env.op === 'close') {
        try { self._native.close(); } catch {}
      }
    }
    // Forward every spec method/getter; intercept SDP-bearing ones so we
    // can route them through the gateway in addition to the native PC.
    function delegate(name) {
      Object.defineProperty(ZPRTCPeerConnection.prototype, name, {
        configurable: true,
        get() { try { return this._native[name]; } catch { return undefined; } },
      });
    }
    ['localDescription', 'remoteDescription', 'pendingLocalDescription', 'pendingRemoteDescription',
     'currentLocalDescription', 'currentRemoteDescription',
     'signalingState', 'iceGatheringState', 'iceConnectionState', 'connectionState',
     'canTrickleIceCandidates', 'sctp']
      .forEach(delegate);
    ZPRTCPeerConnection.prototype.createOffer = function(opts) { return this._native.createOffer(opts); };
    ZPRTCPeerConnection.prototype.createAnswer = function(opts) { return this._native.createAnswer(opts); };
    ZPRTCPeerConnection.prototype.setLocalDescription = async function(desc) {
      const r = await this._native.setLocalDescription(desc);
      // After local SDP is finalized, forward it to the gateway so the
      // gateway's target-side PC can complete its half of the handshake.
      const local = this._native.localDescription;
      if (local && local.sdp) {
        postSignal({ op: local.type === 'offer' ? 'offer' : 'answer', sessionId: this._sessionId, sdp: { type: local.type, sdp: local.sdp } });
      }
      return r;
    };
    ZPRTCPeerConnection.prototype.setRemoteDescription = function(desc) { return this._native.setRemoteDescription(desc); };
    ZPRTCPeerConnection.prototype.addIceCandidate = function(cand) { return this._native.addIceCandidate(cand); };
    ZPRTCPeerConnection.prototype.addTrack = function(track, ...streams) { return this._native.addTrack(track, ...streams); };
    ZPRTCPeerConnection.prototype.removeTrack = function(sender) { return this._native.removeTrack(sender); };
    ZPRTCPeerConnection.prototype.getSenders = function() { return this._native.getSenders(); };
    ZPRTCPeerConnection.prototype.getReceivers = function() { return this._native.getReceivers(); };
    ZPRTCPeerConnection.prototype.getTransceivers = function() { return this._native.getTransceivers(); };
    ZPRTCPeerConnection.prototype.addTransceiver = function(...args) { return this._native.addTransceiver(...args); };
    ZPRTCPeerConnection.prototype.getStats = function(selector) { return this._native.getStats(selector); };
    ZPRTCPeerConnection.prototype.createDataChannel = function(label, opts) { return this._native.createDataChannel(label, opts); };
    ZPRTCPeerConnection.prototype.close = function() {
      try { this._pollCtl && this._pollCtl.stop(); } catch {}
      postSignal({ op: 'close', sessionId: this._sessionId });
      try { return this._native.close(); } catch { return undefined; }
    };
    ZPRTCPeerConnection.prototype.addEventListener = function(type, listener, opts) {
      try { return this._native.addEventListener(type, listener, opts); } catch {}
    };
    ZPRTCPeerConnection.prototype.removeEventListener = function(type, listener, opts) {
      try { return this._native.removeEventListener(type, listener, opts); } catch {}
    };
    ZPRTCPeerConnection.prototype.dispatchEvent = function(ev) {
      try { return this._native.dispatchEvent(ev); } catch { return true; }
    };
    return ZPRTCPeerConnection;
  }

  // D4/D5 virtual gateway constructor. Returns an object whose `.ready` /
  // `.closed` promises reject with a structured ZeroProxy error so target
  // code can fall back gracefully. Methods on the object also reject.
  // When the real gateway (HTTP/3 for WT, pion SFU for RTC) lands, this
  // wrapper will dispatch through SW message channels instead.
  function makeVirtualGateway(name, meta) {
    return function VirtualGateway() {
      const reason = name + ' requires the ZeroProxy ' + meta.kind +
        ' gateway, which is not yet provisioned (' + meta.code + ').';
      const err = normalizedError('NotSupportedError');
      try { err.zpCode = meta.code; err.zpReason = reason; } catch {}
      const rejected = Promise.reject(err);
      // Swallow the unhandled-rejection by attaching a noop catch — target
      // code that awaits this will still observe the rejection.
      try { rejected.catch(() => {}); } catch {}
      const proxy = {
        ready: rejected,
        closed: rejected,
        close() { return undefined; },
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      };
      // WebTransport-specific surface.
      if (name === 'WebTransport') {
        proxy.createBidirectionalStream = () => rejected;
        proxy.createUnidirectionalStream = () => rejected;
        proxy.incomingBidirectionalStreams = makeEmptyReadableStream();
        proxy.incomingUnidirectionalStreams = makeEmptyReadableStream();
        proxy.datagrams = {
          readable: makeEmptyReadableStream(),
          writable: makeRejectedWritableStream(err),
          maxDatagramSize: 0,
        };
      }
      // RTCPeerConnection-specific surface.
      if (name === 'RTCPeerConnection' || name === 'webkitRTCPeerConnection') {
        proxy.createOffer = () => rejected;
        proxy.createAnswer = () => rejected;
        proxy.setLocalDescription = () => rejected;
        proxy.setRemoteDescription = () => rejected;
        proxy.addIceCandidate = () => rejected;
        proxy.createDataChannel = () => { throw err; };
        proxy.addTrack = () => { throw err; };
        proxy.getSenders = () => [];
        proxy.getReceivers = () => [];
        proxy.getStats = () => rejected;
      }
      return proxy;
    };
  }
  function makeEmptyReadableStream() {
    if (typeof ReadableStream !== 'function') return null;
    return new ReadableStream({ start(c) { c.close(); } });
  }
  function makeRejectedWritableStream(err) {
    if (typeof WritableStream !== 'function') return null;
    return new WritableStream({ start(c) { c.error(err); } });
  }
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
    if (childFunction) {
      // Same global-scope requirement as the parent realm's
      // `execGlobalScript` — classic script declarations must land on the
      // child's global object, not inside a Function-constructor scope, or
      // one inline script's `function foo(){}` is invisible to the next.
      // Captured before this function swaps the child's `eval` for the
      // parent's scoped variant (below).
      const childEval = w.eval;
      const childExecGlobal = code => childEval ? childEval(code) : (new childFunction(code)).call(w);
      // `pageRewriteHooks` rather than the bare helpers: they are locals of
      // `installPhase2Membrane`, invisible from this function's scope.
      const childRewrite = (source, kind) => {
        const hooks = pageRewriteHooks;
        if (!hooks) throw normalizedError('InvalidStateError');
        return hooks.rewrite(hooks.decodeEntities(source), kind);
      };
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
      if (root.__ZP_EXEC_INLINE_SCRIPT && !define(w, '__ZP_EXEC_INLINE_SCRIPT', root.__ZP_EXEC_INLINE_SCRIPT)) throw normalizedError('SecurityError');
      if (root.__ZP_EXEC_INLINE_MODULE && !define(w, '__ZP_EXEC_INLINE_MODULE', root.__ZP_EXEC_INLINE_MODULE)) throw normalizedError('SecurityError');
      if (root.__ZP_EXEC_INLINE_REWRITTEN && !define(w, '__ZP_EXEC_INLINE_REWRITTEN', root.__ZP_EXEC_INLINE_REWRITTEN)) throw normalizedError('SecurityError');
      if (root.__ZP_EXEC_INLINE_REWRITTEN_MODULE && !define(w, '__ZP_EXEC_INLINE_REWRITTEN_MODULE', root.__ZP_EXEC_INLINE_REWRITTEN_MODULE)) throw normalizedError('SecurityError');
    }
    if (root.__ZP_EXEC_EVENT && !define(w, '__ZP_EXEC_EVENT', root.__ZP_EXEC_EVENT)) throw normalizedError('SecurityError');
    if (root.__ZP_SET_BASE && !define(w, '__ZP_SET_BASE', root.__ZP_SET_BASE)) throw normalizedError('SecurityError');
    if (root.eval && !define(w, 'eval', root.eval)) throw normalizedError('SecurityError');
    if (root.Function && !define(w, 'Function', root.Function)) throw normalizedError('SecurityError');
    if (childFunction && childFunction.prototype) try {
      // iframe child Function — root.Function 은 우리 dynamicFunction wrapper.
      // 메인 realm 과 동일한 WeakMap 정책 적용.
      const childConstructorOverrides = new WeakMap();
      Object.defineProperty(childFunction.prototype, 'constructor', {
        get() { return childConstructorOverrides.get(this) || root.Function; },
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
      'WebSocketStream': { code: 'WT_UNSUPPORTED', kind: 'WebSocketStream' },
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
        try { Object.defineProperty(nav, name, { get: deny, configurable: false }); } catch {}
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

  function installCanvasAntiFingerprinting(w) {
    if (!w || canvasHookedWindows.has(w) || !w.CanvasRenderingContext2D || !w.HTMLCanvasElement) return;
    canvasHookedWindows.add(w);
    const ctxProto = w.CanvasRenderingContext2D.prototype;
    const canvasProto = w.HTMLCanvasElement.prototype;
    const origGetImageData = ctxProto && ctxProto.getImageData;
    if (typeof origGetImageData === 'function') {
      define(ctxProto, 'getImageData', function(...args) {
        const imageData = origGetImageData.apply(this, args);
        const data = imageData && imageData.data;
        if (data && data.length > 1) {
          data[0] = data[0] ^ 1;
          data[data.length - 2] = data[data.length - 2] ^ 1;
        }
        return imageData;
      });
    }
    const origToDataURL = canvasProto && canvasProto.toDataURL;
    if (typeof origToDataURL === 'function') {
      define(canvasProto, 'toDataURL', function(...args) {
        const width = this.width >>> 0;
        const height = this.height >>> 0;
        if (width && height) {
          const ctx = this.getContext && this.getContext('2d');
          if (ctx) {
            const fillStyle = ctx.fillStyle;
            const globalAlpha = ctx.globalAlpha;
            try {
              ctx.globalAlpha = 1;
              ctx.fillStyle = 'rgba(' + ((Math.random() * 256) | 0) + ',' + ((Math.random() * 256) | 0) + ',' + ((Math.random() * 256) | 0) + ',0.01)';
              ctx.fillRect((Math.random() * Math.min(width, 8)) | 0, (Math.random() * Math.min(height, 8)) | 0, 1, 1);
            } finally {
              try { ctx.fillStyle = fillStyle; } catch {}
              try { ctx.globalAlpha = globalAlpha; } catch {}
            }
          }
        }
        return origToDataURL.apply(this, args);
      });
    }
  }

  function installAudioAntiFingerprinting(w) {
    if (!w || audioHookedWindows.has(w) || !w.AudioBuffer) return;
    audioHookedWindows.add(w);
    const proto = w.AudioBuffer.prototype;
    const origGetChannelData = proto && proto.getChannelData;
    if (typeof origGetChannelData !== 'function') return;
    define(proto, 'getChannelData', function(channel) {
      const f32 = origGetChannelData.call(this, channel);
      const limit = Math.min(f32.length, 100);
      for (let i = 0; i < limit; i++) {
        if (f32[i] !== 0) {
          f32[i] += (Math.random() - 0.5) * 1e-7;
          break;
        }
      }
      return f32;
    });
  }
  try { const current = document.currentScript; if (current && /\/__zp\/runtime-prelude\.js(?:$|\?)/.test(current.src || '')) current.remove(); } catch {}
})();
