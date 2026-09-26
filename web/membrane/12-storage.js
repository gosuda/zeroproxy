
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
    if (w === root) {
      // window.name backing: same tab-session lifetime + origin scope as the
      // session facade. The REAL name is emptied — it would leak whatever the
      // launcher or a previous target wrote into every later document.
      const nameKey = 'zp:n:' + tabSessionId + ':' + originHash;
      let cachedName;
      rootWindowNameStore = {
        get() {
          if (cachedName === undefined) { try { cachedName = nativeSessionStorage.getItem(nameKey) || ''; } catch { cachedName = ''; } }
          return cachedName;
        },
        set(v) { cachedName = String(v); try { nativeSessionStorage.setItem(nameKey, cachedName); } catch {} },
      };
      // ★실명 삭제는 최상위 문서에만 적용한다. 프레임의 `window.name` 은
      // 곧 **브라우징 컨텍스트 이름**이라, 지우면 부모의 `window['nf']` /
      // `frames['nf']` / `<a target=name>` 명명 조회가 전부 깨진다(실측:
      // srcdoc 자식의 prelude 가 자기 이름을 지워 `frames['nf']` → undefined).
      // 자식의 실명은 읽기 표면이 전부 가상 스토어를 거치므로 유지해도 페이지에
      // 새지 않는다. 대신 초기 가상값을 실명으로 시드하고 쓰기도 실명에
      // 반영해, 타깃이 `window.name` 을 바꾸면 명명 조회도 따라가게 한다.
      const isTopFrame = (() => { try { return w.top === w; } catch { return true; } })();
      if (isTopFrame) { try { w.name = ''; } catch {} }
      else {
        try {
          const real = String(w.name || '');
          if (real && !(nativeSessionStorage && nativeSessionStorage.getItem(nameKey))) rootWindowNameStore.set(real);
        } catch {}
        const innerSet = rootWindowNameStore.set;
        rootWindowNameStore.set = v => { innerSet(v); try { w.name = String(v); } catch {} };
      }
    }
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
      // `webkitIndexedDB` bypasses the namespace entirely — alias it to the
      // facade. The rest of the webkitIDB* family are plain constructor
      // aliases with no open path; map them onto the real IDB* so nothing
      // reaches the un-namespaced factory.
      if (w.webkitIndexedDB) try { defineAccessor(w, 'webkitIndexedDB', () => virtualIDB); } catch {}
      for (const alias of ['IDBKeyRange','IDBRequest','IDBTransaction','IDBCursor','IDBCursorWithValue','IDBDatabase','IDBFactory','IDBObjectStore','IDBIndex','IDBOpenDBRequest','IDBVersionChangeEvent','IDBFileHandle','IDBMutableFile','IDBFileRequest','IDBLocaleAwareKeyRange']) {
        const webkit = 'webkit' + alias;
        if (w[webkit] !== undefined && w[alias] !== undefined) try { define(w, webkit, w[alias]); } catch {}
      }
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
    // cookieStore: same jar as document.cookie (documentCookieRecords).
    // The native object would expose REAL proxy-origin cookies.
    if (w.cookieStore) defineAccessor(w, 'cookieStore', () => virtualCookieStore());
    // OPFS — `navigator.storage.getDirectory()` returns the REAL proxy-origin
    // root, shared across targets. Hand out a per-target subdirectory handle;
    // every operation below it stays inside the namespace transparently.
    try {
      const storageMgr = w.navigator && w.navigator.storage;
      if (storageMgr && typeof storageMgr.getDirectory === 'function' && typeof storageMgr.getDirectory.__zpWrapped !== 'boolean') {
        const nativeGetDirectory = storageMgr.getDirectory.bind(storageMgr);
        // handle.name 은 페이지에 노출되므로 마커+오리진 원문 대신 해시를 쓴다.
        let oh = 0x811c9dc5;
        for (let i = 0; i < virtualURL.origin.length; i++) { oh ^= virtualURL.origin.charCodeAt(i); oh = Math.imul(oh, 16777619); }
        const opfsRoot = 'zp:o:' + ('00000000' + (oh >>> 0).toString(16)).slice(-8);
        const wrapped = function getDirectory() {
          return nativeGetDirectory().then(d => d.getDirectoryHandle(opfsRoot, { create: true }));
        };
        try { Object.defineProperty(wrapped, '__zpWrapped', { value: true }); } catch {}
        maskNativeFunction(wrapped, 'getDirectory');
        define(storageMgr, 'getDirectory', wrapped);
        if (storageMgr.estimate) {
          const nativeEstimate = storageMgr.estimate.bind(storageMgr);
          define(storageMgr, 'estimate', function estimate() { return nativeEstimate(); });
        }
      }
    } catch {}
    // Legacy webkit filesystem/quota APIs — real proxy-origin FS, no clean
    // virtualization. Remove the surface (feature detection falls back).
    for (const legacy of ['webkitRequestFileSystem','webkitResolveLocalFileSystemURL','webkitPersistentStorage','webkitTemporaryStorage','webkitStorageInfo','webkitRequestFileSystemSync','webkitResolveLocalFileSystemURLSync']) {
      try { if (w[legacy] !== undefined) define(w, legacy, undefined); } catch {}
    }
    // fetchLater — the real API schedules a fire-and-forget request at
    // document teardown. The raw URL cannot go direct (that is a leak), so
    // emulate over the /zp/api/fetch envelope with keepalive on
    // pagehide/visibilitychange→hidden — the same path fetch() takes.
    try {
      if (typeof w.fetchLater === 'function' && Native.fetch && Native.Request) {
        const fl = function fetchLater(input, init) {
          const opts = init || {};
          const result = { activated: false };
          let canceled = false, fired = false;
          const unlisten = [];
          const fire = () => {
            if (fired || canceled) return;
            fired = true;
            result.activated = true;
            for (const u of unlisten) u();
            try {
              const raw = input && typeof input === 'object' && typeof input.url === 'string' ? input.url : String(input);
              const target = requestTargetURL(raw);
              // fetchThroughRuntime 과 같은 패턴 — Request 입력이면 그것의
              // method/headers 를 유지하고 opts 로 덮어쓴다.
              const req = (input && typeof input === 'object' && typeof input.clone === 'function') ? new Native.Request(input, opts) : new Native.Request(target, opts);
              let bodyBytes = null;
              const b = opts.body;
              if (typeof b === 'string') bodyBytes = new TextEncoder().encode(b);
              else if (b instanceof ArrayBuffer) bodyBytes = new Uint8Array(b);
              else if (ArrayBuffer.isView(b)) bodyBytes = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
              else if (b instanceof URLSearchParams) bodyBytes = new TextEncoder().encode(String(b));
              const payload = {
                tabId: boot.tabId, entryId: activeEntryId, documentURL: virtualURL.href, url: target,
                init: { method: req.method, headers: Array.from(req.headers.entries()), body: null,
                        credentials: req.credentials, mode: req.mode, referrer: req.referrer,
                        referrerPolicy: req.referrerPolicy || documentReferrerPolicy(), redirect: req.redirect, cache: req.cache, integrity: req.integrity },
              };
              // keepalive 의 ~64KB 바디 상한에 v2(33% 작음)가 특히 잘 맞는다 —
              // 실패 시 v1 폴백은 postRuntimeEnvelope 안에서 한다.
              postRuntimeEnvelope(target, payload, bodyBytes, { keepalive: true }).catch(() => {});
            } catch {}
          };
          const onHide = () => fire();
          w.addEventListener('pagehide', onHide);
          unlisten.push(() => w.removeEventListener('pagehide', onHide));
          if (w.document) {
            const onVis = () => { if (w.document.visibilityState === 'hidden') fire(); };
            w.document.addEventListener('visibilitychange', onVis);
            unlisten.push(() => w.document.removeEventListener('visibilitychange', onVis));
          }
          if (opts.signal && typeof opts.signal.addEventListener === 'function') {
            const onAbort = () => { canceled = true; for (const u of unlisten) u(); };
            if (opts.signal.aborted) canceled = true; else opts.signal.addEventListener('abort', onAbort, { once: true });
          }
          return result;
        };
        maskNativeFunction(fl, 'fetchLater');
        define(w, 'fetchLater', fl);
      }
    } catch {}
    // URL constructor + canParse/parse: a base argument built from OUR
    // routing vocabulary (share path, /zp/ api URL, proxy-origin string)
    // must resolve against the VIRTUAL base — otherwise
    // `new URL(rel, leakedBase).href` hands the proxy origin back. An
    // absent base still throws natively (single-arg relative URLs are
    // invalid) — only the vocabulary leak is normalized.
    if (Native.URL) {
      const wrapURLBase = b => {
        const g = unleakedTargetRaw(String(b));
        return g === null ? baseURL : g;
      };
      const ZPURL = function URL(input, base) {
        const g = unleakedTargetRaw(String(input));
        const inp = g === null ? baseURL : g;
        // WebIDL: optional 인자의 `undefined` 는 **부재**와 같다 —
        // `new URL(x, undefined)` 는 base 없는 생성과 동일해야 한다.
        // `'undefined'` 문자열로 넘기면 절대 URL 에도 Invalid base URL 이 난다
        // (zp-core canonicalTargetURL 이 `base || undefined` 를 항상 넘긴다).
        return base !== undefined ? new Native.URL(inp, wrapURLBase(base)) : new Native.URL(inp);
      };
      try { ZPURL.prototype = Native.URL.prototype; } catch {}
      for (const sm of ['createObjectURL', 'revokeObjectURL', 'canParse', 'parse']) {
        const orig = Native.URL[sm];
        if (typeof orig !== 'function') continue;
        ZPURL[sm] = (sm === 'canParse' || sm === 'parse')
          ? function (u, b) { return b !== undefined ? orig.call(Native.URL, u, wrapURLBase(b)) : orig.call(Native.URL, u); }
          : orig.bind(Native.URL);
        try { Object.defineProperty(ZPURL[sm], 'name', { value: sm, configurable: true }); } catch {}
        maskNativeFunction(ZPURL[sm], sm);
      }
      brandLikeNative(ZPURL, null, 'URL');
      define(w, 'URL', ZPURL);
      // `webkitURL` is a live alias of the native constructor — unwrapped it
      // resolves relative input against the REAL document base (proxy URL).
      if (w.webkitURL) define(w, 'webkitURL', ZPURL);
    }
    // ★컨테인먼트가 자식 창에 먼저 심은 래퍼 위에 자식 prelude 가 다시 심으면
    // 이중 래핑이다 — SharedWorker 는 workerBootstrapURL 이 두 번 적용돼
    // `u=<bootstrap URL>` 자기재귀로 죽고(실측: srcdoc 자식의 SharedWorker
    // NetworkError), BroadcastChannel 은 접두어가 두 번 붙는다. 진짜 네이티브를
    // __zp_real* 에 붙들어 두고 재설치는 항상 그것을 감싸게 한다.
    function realCtor(w, stash, cur) {
      const real = w[stash] || cur;
      if (!w[stash]) { try { define(w, stash, real); } catch {} }
      return real;
    }
    // D7: BroadcastChannel must be origin-scoped. Wrap constructor to prefix
    // channel name with target origin hash; messages from another target
    // never reach this one.
    if (w.BroadcastChannel) {
      const NativeBC = realCtor(w, '__zp_realBC', w.BroadcastChannel);
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
      const NativeSW = realCtor(w, '__zp_realSW', w.SharedWorker);
      const SWWrap = function(url, opts) {
        const named = (opts && opts.name) ? Object.assign({}, opts, { name: sharedWorkerPrefix + String(opts.name) })
                                          : Object.assign({}, opts || {}, { name: sharedWorkerPrefix + 'default' });
        return new NativeSW(workerBootstrapURL(url), named);
      };
      try { SWWrap.prototype = NativeSW.prototype; } catch {}
      try { define(w, 'SharedWorker', SWWrap); } catch {}
    }
    // D7 (removed 2026-09-14): `document.origin` 가상화. 프로토타입 모양 축이
    // 처음 돌자마자 "Document 프록시에만: origin" 을 잡았는데, 실측해 보니 이
    // 엔진은 **document.origin 자체가 없다** — Document.prototype 도
    // Node.prototype 도 Window.prototype 도 own 이 아니고 `typeof
    // document.origin === 'undefined'`. 가상화할 실체가 없으니 지운다. 아래
    // 주석("origin 은 Document.prototype 에 산다")은 이번 실측 전 가정이었고
    // 틀렸다 — window.origin/location.origin 과 헷갈린 것으로 보인다.
    if (w.document) {
      const docProto = w.Document && w.Document.prototype;
      // document.domain getter/setter. Chrome M109+ 에서 setter 는 완전한
      // no-op 이다 — 던지지도 바꾸지도 않는다(deprecation 경고만). 이전엔
      // suffix 검사 후 virtualDomain 을 바꿨는데 그건 M109 이전 의미다.
      // 게터는 가상 호스트를 돌린다.
      const virtualDomain = virtualURL.hostname.toLowerCase();
      defineOnProto(
        w.document,
        docProto,
        'domain',
        () => virtualDomain,
        () => {}
      );
    }
    // window.origin / self.origin getters — point at virtual target origin.
    try { defineMasked(w, 'origin', { get() { return virtualURL.origin; }, configurable: true, enumerable: true }); } catch {}
    // isSecureContext — the proxy is served from localhost so the REAL value
    // is always `true`, but an http: target would be `false` natively.
    // Potentially-trustworthy = https/wss/file + localhost-family hosts.
    try {
      const vsc = virtualURL.protocol === 'https:' || virtualURL.protocol === 'wss:' || virtualURL.protocol === 'file:'
        || /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(virtualURL.hostname) || /\.localhost$/i.test(virtualURL.hostname);
      defineMasked(w, 'isSecureContext', { get() { return vsc; }, configurable: true, enumerable: true });
    } catch {}
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
        defineMasked(entryProto, 'name', {
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
            defineMasked(resProto, key, {
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
        try { defineMasked(ZPPerformanceObserver, 'supportedEntryTypes', { get: () => NativePO.supportedEntryTypes, configurable: true }); } catch {}
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
        defineMasked(NativeN, 'permission', {
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
    // D7: navigator.permissions.query — the real query resolves against the
    // PROXY origin's grants: a device permission granted to target A would
    // show 'granted' to target B. Track per-target grants for the device
    // permissions we can observe (camera/mic via getUserMedia, display via
    // getDisplayMedia, geolocation via success callback) and answer 'prompt'
    // for unrecorded names; other permission names fall through to native.
    const grantedPerms = new Set();
    try {
      const storedGrants = prefixedStorage(nativeLocalStorage, localPrefix).getItem('__zp_grants');
      if (storedGrants) for (const g of String(storedGrants).split(',')) if (g) grantedPerms.add(g);
    } catch {}
    const recordGrant = name => {
      grantedPerms.add(name);
      try { prefixedStorage(nativeLocalStorage, localPrefix).setItem('__zp_grants', Array.from(grantedPerms).join(',')); } catch {}
    };
    try {
      const md = w.navigator && w.navigator.mediaDevices;
      if (md && typeof md.getUserMedia === 'function') {
        const nativeGUM = md.getUserMedia.bind(md);
        const wrappedGUM = function getUserMedia(c) {
          return nativeGUM(c).then(s => {
            try { const kind = (s && s.getVideoTracks && s.getVideoTracks().length) ? 'camera' : 'microphone'; recordGrant(kind); if (s && s.getAudioTracks && s.getAudioTracks().length) recordGrant('microphone'); } catch {}
            return s;
          });
        };
        maskNativeFunction(wrappedGUM, 'getUserMedia');
        define(md, 'getUserMedia', wrappedGUM);
      }
      if (md && typeof md.getDisplayMedia === 'function') {
        const nativeGDM = md.getDisplayMedia.bind(md);
        const wrappedGDM = function getDisplayMedia(c) { return nativeGDM(c).then(s => { recordGrant('display-capture'); return s; }); };
        maskNativeFunction(wrappedGDM, 'getDisplayMedia');
        define(md, 'getDisplayMedia', wrappedGDM);
      }
      const geo = w.navigator && w.navigator.geolocation;
      if (geo && typeof geo.getCurrentPosition === 'function') {
        const nativeGeo = geo.getCurrentPosition.bind(geo);
        const wrappedGeo = function getCurrentPosition(ok, err, opts) { return nativeGeo(p => { recordGrant('geolocation'); if (ok) return ok(p); }, err, opts); };
        maskNativeFunction(wrappedGeo, 'getCurrentPosition');
        define(geo, 'getCurrentPosition', wrappedGeo);
      }
      if (geo && typeof geo.watchPosition === 'function') {
        const nativeWatch = geo.watchPosition.bind(geo);
        const wrappedWatch = function watchPosition(ok, err, opts) { return nativeWatch(p => { recordGrant('geolocation'); if (ok) return ok(p); }, err, opts); };
        maskNativeFunction(wrappedWatch, 'watchPosition');
        define(geo, 'watchPosition', wrappedWatch);
      }
    } catch {}
    if (w.navigator && w.navigator.permissions && w.navigator.permissions.query) {
      const nativeQuery = w.navigator.permissions.query.bind(w.navigator.permissions);
      const trackedPerms = new Set(['camera', 'microphone', 'display-capture', 'geolocation', 'speaker-selection']);
      define(w.navigator.permissions, 'query', function(desc) {
        const name = desc && desc.name;
        if (typeof name === 'string' && trackedPerms.has(name) && !grantedPerms.has(name)) {
          // 타깃이 이 권한을 얻은 기록이 없으면 'prompt' — 다른 타깃이 실제로
          // grant 받았어도 그 사실은 이 타깃에 새지 않는다.
          const StatusProto = w.PermissionStatus && w.PermissionStatus.prototype;
          const fake = StatusProto ? Object.create(StatusProto) : {};
          try { Object.defineProperty(fake, 'name', { value: name, enumerable: true }); } catch {}
          try { Object.defineProperty(fake, 'state', { value: 'prompt', enumerable: true }); } catch {}
          try { Object.defineProperty(fake, 'onchange', { value: null, writable: true, enumerable: true }); } catch {}
          return Promise.resolve(fake);
        }
        return nativeQuery(desc);
      });
    }
    // Privacy Sandbox — sharedStorage / Protected-Audience / Topics /
    // Private-State-Token are keyed to the REAL proxy origin, so data written
    // by one target is readable by every other target in the tab. That is an
    // isolation violation we cannot virtualise cheaply → fail closed.
    try {
      const nav = w.navigator;
      for (const pa of ['joinAdInterestGroup','leaveAdInterestGroup','runAdAuction','updateAdInterestGroups','createAuctionNonce','getInterestGroupAdAuctionData','clearOriginJoinedAdInterestGroups','createAuctionNonce']) {
        if (nav && typeof nav[pa] === 'function') {
          const deny = function() { return Promise.reject(normalizedError('NotSupportedError')); };
          maskNativeFunction(deny, pa);
          define(nav, pa, deny);
        }
      }
      if (w.sharedStorage !== undefined) try { define(w, 'sharedStorage', undefined); } catch {}
      if (nav && nav.privateAttribution) {
        for (const pa of ['measureImpression','saveImpression','measureConversion','saveConversion']) {
          if (typeof nav.privateAttribution[pa] === 'function') {
            const deny = function() { return Promise.reject(normalizedError('NotSupportedError')); };
            maskNativeFunction(deny, pa);
            try { define(nav.privateAttribution, pa, deny); } catch {}
          }
        }
      }
      // document.browsingTopics → empty topics (privacy-safe, non-throwing)
      const docProto2 = w.Document && w.Document.prototype;
      if (docProto2 && typeof docProto2.browsingTopics === 'function') {
        const noTopics = function browsingTopics() { return Promise.resolve([]); };
        maskNativeFunction(noTopics, 'browsingTopics');
        define(docProto2, 'browsingTopics', noTopics);
      }
      // document.privateToken / PrivateStateToken — gate to inert values.
      try {
        if (docProto2) {
          const dTok = Object.getOwnPropertyDescriptor(docProto2, 'privateToken');
          if (dTok) defineMasked(docProto2, 'privateToken', { get() { return { hasPrivateToken: () => Promise.resolve(false), hasRedemptionRecord: () => Promise.resolve(false), sendPrivateToken: () => Promise.reject(normalizedError('NotSupportedError')) }; }, configurable: true });
        }
      } catch {}
    } catch {}
    // customElements — the registry is keyed to the REAL proxy origin, so two
    // targets sharing one tab collide on names and observe each other's
    // registrations. Namespace every defined name with a per-target prefix.
    // createElement / `is` attribute / localName·tagName are translated so
    // the prefix stays invisible to page code. Static markup written before
    // define() is upgraded by element-replacement at define time (approximate
    // — native upgrade timing differs, but constructor + attrs + children
    // land in the right order).
    try {
      const registry = w.customElements;
      if (registry && typeof registry.define === 'function') {
        const cePrefix = 'zp' + originHash.replace(/[^a-z0-9]/g, '') + '-';
        const zname = name => cePrefix + String(name);
        const definedNames = new Set();
        const nativeDefine = registry.define.bind(registry);
        const nativeGet = registry.get && registry.get.bind(registry);
        const nativeWhenDefined = registry.whenDefined && registry.whenDefined.bind(registry);
        const nativeUpgrade = registry.upgrade && registry.upgrade.bind(registry);
        const nativeGetName = registry.getName && registry.getName.bind(registry);
        const doc = w.document;
        // Upgrade parsed elements carrying the UNprefixed tag by replacing
        // them with a prefixed element — constructor + attribute/connected
        // callbacks then run natively on the replacement.
        const upgradeElements = (rootEl, name) => {
          const zn = zname(name);
          // localName/tagName 게터가 접두어를 지워버리므로 "미접두 태그" 판정은
          // 생성자 instanceof 로 한다 — 이미 업그레이드된 노드는 건너뛴다.
          const ctor = nativeGet ? nativeGet(zn) : null;
          const needsUpgrade = el => !(ctor && el instanceof ctor);
          const list = [];
          try { if (rootEl.localName === name && needsUpgrade(rootEl)) list.push(rootEl); } catch {}
          // 파스된 미접두 태그를 찾아야 하므로 **네이티브** 탐색을 써야 한다 —
          // 페이지 대면 querySelectorAll/getElementsByTagName 은 이름을 접두어로
          // 번역해 이미 업그레이드된 노드만 찾는다.
          const nativeQsa = rootEl.nodeType === 9 ? Native.querySelectorAll
            : rootEl.nodeType === 11 ? (Native.fragmentQuerySelectorAll || null)
            : Native.elementQuerySelectorAll;
          try { if (nativeQsa) for (const el of Array.from(nativeQsa.call(rootEl, name))) if (!list.includes(el) && needsUpgrade(el)) list.push(el); } catch {}
          try { if (typeof rootEl.getElementsByTagName === 'function') for (const el of Array.from(rootEl.getElementsByTagName(name))) if (!list.includes(el) && needsUpgrade(el)) list.push(el); } catch {}
          for (const el of list) {
            try {
              const repl = doc.createElement(zn);
              for (const a of Array.from(el.attributes)) { try { repl.setAttribute(a.name, a.value); } catch {} }
              while (el.firstChild) repl.appendChild(el.firstChild);
              el.replaceWith(repl);
            } catch {}
          }
        };
        // 삽입 경로(innerHTML 등)에서 파스된 미접두 태그를 찾아 업그레이드한다.
        ceUpgradeSubtree = (rootEl) => {
          if (!rootEl || !definedNames.size) return;
          for (const n of definedNames) upgradeElements(rootEl, n);
        };
        define(registry, 'define', function(name, ctor, opts) {
          const n = String(name).toLowerCase();
          definedNames.add(n);
          const zn = zname(n);
          nativeDefine(zn, ctor, opts);
          upgradeElements(doc.documentElement || doc, n);
        });
        if (nativeGet) define(registry, 'get', function(name) { return nativeGet(zname(String(name))); });
        if (nativeGetName) define(registry, 'getName', function(ctor) { const n = nativeGetName(ctor); return n && n.startsWith(cePrefix) ? n.slice(cePrefix.length) : n; });
        if (nativeWhenDefined) define(registry, 'whenDefined', function(name) { return nativeWhenDefined(zname(String(name))); });
        if (nativeUpgrade) define(registry, 'upgrade', function(root2) { return nativeUpgrade(root2); });
        // createElement / createElementNS translate tag names; `is` option too.
        const docProto = w.Document && w.Document.prototype;
        if (docProto) {
          const nativeCreateElement = docProto.createElement;
          if (typeof nativeCreateElement === 'function') define(docProto, 'createElement', function(tag, opts) {
            const t = String(tag).toLowerCase();
            const zn = definedNames.has(t) ? zname(t) : t;
            const o = (opts && typeof opts === 'object' && opts.is && definedNames.has(String(opts.is).toLowerCase())) ? Object.assign({}, opts, { is: zname(String(opts.is).toLowerCase()) }) : opts;
            return nativeCreateElement.call(this, zn, o);
          });
          const nativeCreateElementNS = docProto.createElementNS;
          if (typeof nativeCreateElementNS === 'function') define(docProto, 'createElementNS', function(ns2, tag, opts) {
            const t = String(tag).toLowerCase();
            const zn = definedNames.has(t) ? zname(t) : tag;
            return nativeCreateElementNS.call(this, ns2, zn, opts);
          });
          // querySelector(All)/getElementsByTagName — translate defined tag
          // names inside selectors so `qsa('my-el')` finds the prefixed nodes.
          const translateSelector = sel => {
            if (!definedNames.size) return sel;
            let out = String(sel);
            for (const n of definedNames) {
              out = out.replace(new RegExp('(^|[\\s,>+~]|^)' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[\\s,>+~.\\[\\]#:)])', 'gi'), (m, p) => p + zname(n));
            }
            return out;
          };
          for (const m of ['querySelector', 'querySelectorAll']) {
            if (typeof docProto[m] === 'function' && typeof Element !== 'undefined' && w.Element && w.Element.prototype) {
              const nat = docProto[m];
              define(docProto, m, function(sel) { return nat.call(this, translateSelector(sel)); });
              const enat = w.Element.prototype[m];
              if (typeof enat === 'function' && !enat.__zpQsaWrapped) {
                const wrapped = function(sel) { return enat.call(this, translateSelector(sel)); };
                try { Object.defineProperty(wrapped, '__zpQsaWrapped', { value: true }); } catch {}
                define(w.Element.prototype, m, wrapped);
              }
            }
          }
          const nativeGetByTag = docProto.getElementsByTagName;
          if (typeof nativeGetByTag === 'function') define(docProto, 'getElementsByTagName', function(tag) {
            const t = String(tag).toLowerCase();
            return nativeGetByTag.call(this, definedNames.has(t) ? zname(t) : tag);
          });
        }
        // localName / tagName / nodeName — strip the prefix back off. The
        // prefix is lowercase alnum+dash; tagName/nodeName return uppercase
        // so a case-insensitive anchored strip covers all three.
        const elProto = w.Element && w.Element.prototype;
        if (elProto) {
          const cePrefixRe = new RegExp('^' + cePrefix, 'i');
          for (const prop of ['localName', 'tagName', 'nodeName']) {
            const d = Object.getOwnPropertyDescriptor(elProto, prop) || (w.Node && Object.getOwnPropertyDescriptor(w.Node.prototype, prop));
            if (!d || !d.get) continue;
            const nativeGetProp = d.get;
            try { defineMasked(elProto, prop, { get() { const v = nativeGetProp.call(this); return typeof v === 'string' ? v.replace(cePrefixRe, '') : v; }, configurable: true, enumerable: true }); } catch {}
          }
        }
      }
    } catch {}
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
    defineMasked(storageProto, 'length', {
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