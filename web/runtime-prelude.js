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
  // Measured: getOwnPropertyNames(window) was correctly clean while
  // `for (k in window)` still handed out ZPPageBundleWBG, __zp_diagnostics,
  // __zp_trace and __zp_trace_clear — plain `root.x = y` assignments create
  // ENUMERABLE properties, so they bypassed both `define()` and the scrub.
  // enumerable:false is exactly the right tool for this surface (and useless for
  // the other two), so the two mechanisms are complements, not alternatives.
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
    const isGlobalObj = o => o === globalThis || o === root || (typeof self !== 'undefined' && o === self);
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
  clearBootConfig();
  const Native = captureNative(root);

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
  if (typeof ZeroProxyRTGlobal === 'object' && ZeroProxyRTGlobal) {
    try {
      ZeroProxyRTGlobal.load('/__zp/zp_page_rt.wasm?v=__ZP_BUILD_ID__')
        .then(instance => { rt = instance; })
        .catch(() => { /* fall back to JS path */ });
    } catch { /* defensive */ }
  }

  const toStringMap = new WeakMap();
  const toStringMaskedPrototypes = new WeakSet();
  const origToString = root.Function && root.Function.prototype && root.Function.prototype.toString;
  const initialProxyURL = new URL(root.location.href);
  const proxyOrigin = initialProxyURL.origin;
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
  const crossWindowProxyCache = new WeakMap();
  const postMessageWrappers = new WeakMap();
  const postMessageOriginals = new WeakMap();
  // V8 incumbent realm leak — cross-realm postMessage wrap function call 시 message
  // event 의 `e.source` 가 incumbent (caller realm 의 contentWindow) 가 아닌 wrap
  // function 의 realm (parent) 으로 corrupt 됨. NAVER GFP SafeFrame SDK 의 resize
  // handler 가 `e.source === iframe.contentWindow` 비교로 어느 광고 iframe 에서
  // resize 메시지 왔는지 식별 → source 가 parent 로 corrupt 되어 모든 광고 iframe
  // height=0 으로 collapse. Fix: 각 iframe 의 `parent`/`top` accessor 를 sender-aware
  // proxy 로 override + sender queue 로 message dispatch 시 source 정정.
  const parentPostMessageSenderQueue = [];
  const parentRedirectFacades = new WeakMap();
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
      namedSetNamedItem: w.NamedNodeMap && w.NamedNodeMap.prototype.setNamedItem,
      attrValue: w.Attr && Object.getOwnPropertyDescriptor(w.Attr.prototype, 'value'),
      matches: w.Element.prototype.matches,
      closest: w.Element.prototype.closest,
      querySelector: w.Document.prototype.querySelector,
      querySelectorAll: w.Document.prototype.querySelectorAll,
      elementQuerySelector: w.Element.prototype.querySelector,
      elementQuerySelectorAll: w.Element.prototype.querySelectorAll,
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
      try { if (!instance || instance[key] === get.call(instance)) return true; } catch {}
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
      try { Native.historyReplace(root.history.state, '', next); } catch {}
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
  function isIntegrityBearing(el) { const tag = el && el.localName; return tag === 'script' || tag === 'link'; }
  function backedIntegrity(el) { return isIntegrityBearing(el) ? Native.getAttribute.call(el, integrityBackupAttr) : null; }
  function setBackedIntegrity(el, value) { Native.setAttribute.call(el, integrityBackupAttr, String(value)); if (Native.removeAttribute) Native.removeAttribute.call(el, 'integrity'); }
  function targetURL(raw, base = baseURL) { return ZP.canonicalTargetURL(String(raw), base).href; }
  function targetWSURL(raw, base = baseURL) { return ZP.canonicalWebSocketURL(String(raw), base.replace(/^http/, 'ws')).href; }
  function shareNavURL(raw, base = baseURL) { return ZP.makeShareURL(targetURL(raw, base), proxyOrigin, activeServers); }
  function sameOriginHistoryURL(url) { const next = new URL(targetURL(url)); if (next.origin !== virtualURL.origin) throw normalizedError('SecurityError'); return next; }
  function commitVirtualHistory(state, title, url, replace = false) {
    const next = url != null ? sameOriginHistoryURL(url) : new URL(virtualURL.href);
    virtualURL = next;
    if (!explicitBaseURL) baseURL = virtualURL.href;
    const entryId = replace && activeEntryId ? activeEntryId : 'e' + ZP.randomId();
    activeEntryId = entryId;
    postMessageToSW({ type: 'ZP_HISTORY_UPDATE', tabId: boot.tabId, routeKey: activeRouteKey, entryId, targetUrl: virtualURL.href, baseUrl: baseURL, replace }).catch(()=>{});
    const out = (replace ? Native.historyReplace : Native.historyPush)(state, title, proxyHistoryURL());
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
      if (replace && Native.locationReplace) Native.locationReplace(path);
      else if (!replace && Native.locationAssign) Native.locationAssign(path);
      else if (replace) location.replace(path);
      else location.href = path;
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
    postMessageOriginals.set(target, originalPm);
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
  function virtualizeMessageEvent(ev, isRootRealm) {
    // Sender queue 로 source 정정 — wrap function 의 V8 incumbent realm leak 보정.
    // wrap 호출 시점에 sender (iframe.contentWindow) 가 queue 에 push 됨. dispatch
    // 가 동일 task 내 FIFO 라 queue.shift() 가 해당 메시지의 실제 sender. 단 sender
    // 가 root (self-postMessage) 인 경우엔 정정 안 함. isRootRealm 만 queue pop —
    // child realm 의 listener 가 부모→자식 메시지 처리 시 queue 잘못 소비 방지.
    let actualSource = ev.source;
    if (isRootRealm && actualSource === root && parentPostMessageSenderQueue.length > 0) {
      const candidate = parentPostMessageSenderQueue.shift();
      if (candidate && candidate !== root) actualSource = candidate;
    }
    // Hot path fast-exit: source 안 바뀌고 origin 이 proxyOrigin 아니면
    // virtualOriginForMessage 가 어차피 '' 반환. 함수 호출 + 객체 alloc 회피.
    // 대부분의 cross-frame postMessage 가 여기로 빠짐.
    if (actualSource === ev.source && ev.origin !== proxyOrigin) return ev;
    const origin = virtualOriginForMessage(ev.source === actualSource ? ev : { origin: ev.origin, source: actualSource });
    if (!origin && actualSource === ev.source) return ev;
    try {
      return new MessageEvent(ev.type, { data: ev.data, origin: origin || ev.origin, lastEventId: ev.lastEventId || '', source: actualSource, ports: ev.ports || [] });
    } catch {
      try {
        const clone = Object.create(ev);
        if (origin) Object.defineProperty(clone, 'origin', { value: origin, configurable: true });
        if (actualSource !== ev.source) Object.defineProperty(clone, 'source', { value: actualSource, configurable: true });
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
    function scopedCallArgs(args) {
      const argv = new Array(args.length + 1);
      argv[0] = withScope;
      for (let i = 0; i < args.length; i++) argv[i + 1] = args[i];
      return argv;
    }
    function dynamicSource(kind, params, body) {
      const prefix = kind === 'async' ? 'async function' : kind === 'generator' ? 'function*' : kind === 'asyncGenerator' ? 'async function*' : 'function';
      return prefix + ' anonymous(' + params.join(',') + '\n) {\n' + body + '\n}';
    }
    function compileDynamic(ctor, args, kind) {
      const parts = stringArgs(args);
      const body = parts.length ? parts[parts.length - 1] : '';
      const params = new Array(parts.length > 0 ? parts.length - 1 : 0);
      for (let i = 0; i < params.length; i++) params[i] = parts[i];
      const compiled = compileScoped(ctor, params, body);
      let fn;
      if (kind === 'async') {
        fn = async function anonymous(...callArgs) { return Reflect.apply(compiled, this, scopedCallArgs(callArgs)); };
      } else if (kind === 'generator') {
        fn = function* anonymous(...callArgs) { return yield* Reflect.apply(compiled, this, scopedCallArgs(callArgs)); };
      } else if (kind === 'asyncGenerator') {
        fn = async function* anonymous(...callArgs) { return yield* Reflect.apply(compiled, this, scopedCallArgs(callArgs)); };
      } else {
        fn = function anonymous(...callArgs) {
          const argv = scopedCallArgs(callArgs);
          return new.target ? Reflect.construct(compiled, argv, new.target) : Reflect.apply(compiled, this, argv);
        };
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
    function safeCrossWindow(targetWindow) {
      if (!targetWindow || targetWindow === root) return scope;
      if (crossWindowProxyCache.has(targetWindow)) return crossWindowProxyCache.get(targetWindow);
      const proxy = {};
      Object.defineProperties(proxy, {
        window: { get() { return proxy; }, enumerable: true },
        self: { get() { return proxy; }, enumerable: true },
        globalThis: { get() { return proxy; }, enumerable: true },
        top: { get() { return proxy; }, enumerable: true },
        parent: { get() { return proxy; }, enumerable: true },
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
    function get(base, prop) {
      if (typeof prop !== 'symbol') prop = String(prop);
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
      if ((isWindowLike(base) && prop === 'location') || (base === virtualLocation && prop === 'href')) { setVirtualLocation(value); return value; }
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
    function has(base, prop) { if (isWindowLike(base) && prop === 'location') return true; return Reflect.has(Object(base), prop); }
    function getOwnPropertyDescriptor(base, prop) { if (isWindowLike(base) && prop === 'location') return { value: virtualLocation, configurable: true, enumerable: true, writable: false }; return Reflect.getOwnPropertyDescriptor(Object(base), prop); }
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
    function rewriteDynamicFunctionBody(params, body) {
      const list = Array.isArray(params) ? params : [];
      const prefix = 'function __zp_dynamic__(' + list.map(value => String(value)).join(',') + '){\n';
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
    const parsed = new URL(raw, baseURL);
    if (parsed.origin === proxyOrigin) return new URL(parsed.pathname + parsed.search + parsed.hash, baseURL).href;
    return ZP.canonicalTargetURL(parsed.href, baseURL).href;
  }
  async function requestBodyBase64(req) {
    if (req.method === 'GET' || req.method === 'HEAD') return null;
    const ab = await req.clone().arrayBuffer();
    return ZP.bytesToBase64Url(new Uint8Array(ab));
  }
  async function fetchThroughRuntime(input, init = {}) {
    if (!Native.fetch || !Native.Request || !Native.Headers) throw normalizedError('NetworkError');
    const target = requestTargetURL(input);
    try { zpTrace('fetch', target.slice(0, 180)); } catch {}
    const req = input && typeof input === 'object' && typeof input.url === 'string' && typeof input.clone === 'function' ? new Native.Request(input, init) : new Native.Request(String(input), init);
    const payload = {
      tabId: boot.tabId,
      url: target,
      init: {
        method: req.method,
        headers: Array.from(req.headers.entries()),
        body: await requestBodyBase64(req),
        credentials: req.credentials,
        mode: req.mode,
        referrer: req.referrer,
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
    const apiURL = proxyOrigin + ZP.apiPath('fetch') + '?url=' + encodeURIComponent(target);
    return Native.fetch(apiURL, apiInit).then(r => { try { zpTrace('fetch:ok', target.slice(0,80) + ' s=' + r.status); } catch {} return r; }, e => { try { zpTrace('fetch:err', target.slice(0,80) + ' ' + String(e).slice(0,60)); } catch {} throw e; });
  }
  function fireEvent(target, type) {
    let ev;
    try { ev = new Event(type); } catch { ev = { type }; }
    return target.dispatchEvent(ev);
  }
  function installHTTPAPIs() {
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
      Object.assign(ZPXMLHttpRequest.prototype, {
        constructor: ZPXMLHttpRequest,
        UNSENT, OPENED, HEADERS_RECEIVED, LOADING, DONE,
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
    function submitForm(form, submitter) { submitFormNavigation(form, submitter).catch(err => { const code = err && (err.code || err.message); if (code === 'REQUEST_BODY_TOO_LARGE') Native.locationAssign && Native.locationAssign(ZP.errorPath('REQUEST_BODY_TOO_LARGE')); }); }
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
    // launcher back to its target, the same shapes `deproxyEntryName` handles
    // for resource-timing names.
    function deproxyNavigationURL(raw) {
      const s = String(raw == null ? '' : raw);
      if (!s || s.lastIndexOf(proxyOrigin, 0) !== 0) return s;
      let u;
      try { u = new Native.URL(s); } catch { return s; }
      const via = u.searchParams.get('via');
      if (via) return via;
      // `/zp/p/<token>` is encrypted — nothing to decode client-side. The current
      // document's target is the only sane guess and is right for the common
      // case (a form posting back to its own page). Any other proxy-origin
      // action gets the same treatment: it is certainly not a dialable host.
      return virtualURL.href;
    }
    function submissionActionURL(form, submitter) {
      if (submitter && submitter.hasAttribute && submitter.hasAttribute('formaction')) {
        const fa = urlMeta.get(submitter)
          || Native.getAttribute.call(submitter, 'data-zp-target-url')
          || submitter.getAttribute('formaction');
        if (fa) return deproxyNavigationURL(fa);
      }
      const action = urlMeta.get(form)
        || Native.getAttribute.call(form, 'data-zp-target-url')
        || (form.getAttribute && form.getAttribute('action'));
      return (action && deproxyNavigationURL(action)) || virtualURL.href;
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
      const submittedPath = activeProxyPath + '?zp_submit=' + encodeURIComponent(reply.submitId) + activeProxyFragment;
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
    installChromeFingerprintFacade(w);
  }

  // chrome.* surface — present on real Chrome / Edge-Chromium and
  // checked by anti-bot WAFs (Cloudflare, NAVER, Akamai). Missing on
  // strict-headless Chrome ≈ bot signal; Edge WebView2 exposes
  // `chrome.webview` for Tauri ipc, which is a worse tell (it spells
  // out the host shell). Build a plausible Chrome-148 chrome object
  // and replace whatever WebView2 dropped in.
  function installChromeFingerprintFacade(w) {
    let virtualChrome;
    try {
      virtualChrome = buildChromeFingerprint(w);
    } catch { return; }
    if (!virtualChrome) return;
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
    const isRootRealm = (w === root);
    function wrap(listener) {
      if (!listener || (typeof listener !== 'function' && typeof listener.handleEvent !== 'function')) return listener;
      if (messageListenerWrappers.has(listener)) return messageListenerWrappers.get(listener);
      const wrapped = function(ev) {
        const next = virtualizeMessageEvent(ev, isRootRealm);
        return typeof listener === 'function' ? listener.call(this, next) : listener.handleEvent.call(listener, next);
      };
      messageListenerWrappers.set(listener, wrapped);
      return wrapped;
    }
    define(w, 'addEventListener', function(type, listener, options) {
      return Native.windowAddEventListener(String(type), String(type) === 'message' ? wrap(listener) : listener, options);
    });
    define(w, 'removeEventListener', function(type, listener, options) {
      return Native.windowRemoveEventListener(String(type), String(type) === 'message' ? messageListenerWrappers.get(listener) || listener : listener, options);
    });
    const wrappedPostMessage = postMessageWrapperFor(w);
    if (wrappedPostMessage) define(w, 'postMessage', wrappedPostMessage);
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
  function subresourceProxyPath(absolute) {
    const s = String(absolute || '');
    if (!s || s[0] === '#') return s;
    if (!/^https?:/i.test(s)) return s;
    let out = proxyOrigin + ZP.apiPath('fetch') + '?url=' + encodeURIComponent(s);
    if (boot && boot.tabId) out += '&tab=' + encodeURIComponent(boot.tabId);
    return out;
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
  function scanNavigationBackstop(root) {
    if (!root || !root.querySelectorAll) return;
    try {
      root.querySelectorAll(
        'a[href], area[href], form[action], input[formaction], button[formaction]'
      ).forEach(applyNavigationBackstop);
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
    const sweepStyles = () => { try { docEl.querySelectorAll('style').forEach(enforceStyleElementCSS); } catch {} };
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
    const sessionPrefix = 'zp:s:' + boot.tabId + ':' + originHash + ':';
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
      define(w, 'indexedDB', {
        open(name, version) { return nativeIDB.open(idbPrefix + String(name), version); },
        deleteDatabase(name) { return nativeIDB.deleteDatabase(idbPrefix + String(name)); },
        cmp: nativeIDB.cmp ? nativeIDB.cmp.bind(nativeIDB) : undefined,
        databases: nativeIDB.databases ? () => nativeIDB.databases().then(list => list.filter(db => db.name && db.name.startsWith(idbPrefix)).map(db => Object.assign({}, db, { name: db.name.slice(idbPrefix.length) }))) : undefined
      });
    }
    if (w.caches) {
      const nativeCaches = w.caches;
      define(w, 'caches', {
        open(name) { return nativeCaches.open(cachePrefix + String(name)); },
        delete(name) { return nativeCaches.delete(cachePrefix + String(name)); },
        has(name) { return nativeCaches.has(cachePrefix + String(name)); },
        keys() { return nativeCaches.keys().then(keys => keys.filter(k => k.startsWith(cachePrefix)).map(k => k.slice(cachePrefix.length))); },
        match(request, opts) { return nativeCaches.keys().then(keys => keys.filter(k => k.startsWith(cachePrefix))).then(async keys => { for (const k of keys) { const hit = await (await nativeCaches.open(k)).match(request, opts); if (hit) return hit; } return undefined; }); }
      });
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
      const deproxyEntryName = (raw) => {
        const s = String(raw == null ? '' : raw);
        if (!s || s.lastIndexOf(proxyOrigin, 0) !== 0) return s;
        let u;
        try { u = new Native.URL(s); } catch { return s; }
        const p = u.pathname;
        if (p === ZP.apiPath('fetch')) return u.searchParams.get('url') || s;
        if (p === ZP.apiPath('script') || p === ZP.apiPath('worker-script') || p === ZP.apiPath('sourcemap')) {
          return u.searchParams.get('u') || s;
        }
        // Navigation launcher (`/zp/?via=<target>`) and the document route
        // (`/zp/p/<token>`) both stand in for a page URL.
        const via = u.searchParams.get('via');
        if (via) return via;
        if (/^\/zp\/p\//.test(p)) return virtualURL.href;
        return s;
      };
      const entryProto = w.PerformanceEntry && w.PerformanceEntry.prototype;
      const nameDesc = entryProto && Object.getOwnPropertyDescriptor(entryProto, 'name');
      if (nameDesc && typeof nameDesc.get === 'function') {
        const nativeName = nameDesc.get;
        Object.defineProperty(entryProto, 'name', {
          get() { return deproxyEntryName(nativeName.call(this)); },
          configurable: true,
          enumerable: nameDesc.enumerable
        });
        // `toJSON()` serialises from internal slots, bypassing the getter, so
        // structured-clone / JSON paths would still leak the proxy URL.
        const nativeToJSON = entryProto.toJSON;
        if (typeof nativeToJSON === 'function') {
          define(entryProto, 'toJSON', function toJSON() {
            const out = nativeToJSON.call(this);
            try { if (out && typeof out === 'object' && 'name' in out) out.name = deproxyEntryName(out.name); } catch {}
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
    const facade = {
      get length() {
        let n = 0;
        for (let i = 0; i < native.length; i++) {
          const k = native.key(i);
          if (k && k.startsWith(prefix)) n++;
        }
        return n;
      },
      key(i) {
        i = Number(i);
        let seen = 0;
        for (let j = 0; j < native.length; j++) {
          const k = native.key(j);
          if (k && k.startsWith(prefix)) {
            if (seen === i) return k.slice(prefix.length);
            seen++;
          }
        }
        return null;
      },
      getItem(k) { return native.getItem(prefix + String(k)); },
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
    return Object.freeze(facade);
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
  function sanitizeSerializedHTML(html) {
    const parserDoc = Native.createHTMLDocument ? Native.createHTMLDocument('') : document.implementation.createHTMLDocument('');
    const container = parserDoc.createElement('div');
    if (Native.elementInnerHTML && Native.elementInnerHTML.set) Native.elementInnerHTML.set.call(container, String(html || ''));
    else container.innerHTML = String(html || '');
    const nodes = Array.from(container.querySelectorAll('*'));
    for (const node of nodes) {
      restoreVisibleLinkState(node);
      if (isZPAssetNode(node)) { node.remove(); continue; }
      if (Native.getAttributeNames) for (const name of Native.getAttributeNames.call(node)) if (isZPAttrName(name)) Native.removeAttribute.call(node, name);
    }
    return Native.elementInnerHTML && Native.elementInnerHTML.get ? Native.elementInnerHTML.get.call(container) : container.innerHTML;
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
      return u.origin === proxyOrigin && (u.pathname === ZP.assetPath('zp-core.js') || u.pathname === ZP.assetPath('runtime-prelude.js') || u.pathname === ZP.assetPath('zp-page-bundle.js'));
    } catch { return false; }
  }
  function isZPAssetNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.id === '__zp-boot') return true;
    return node.localName === 'script' && isZeroProxyAssetURL(Native.getAttribute.call(node, 'src'));
  }
  function filteredNamedNodeMap(raw) {
    return filteredCollection(raw, attr => attr && !isZPAttrName(attr.name));
  }
  function filteredCollection(raw, predicate) {
    const nth = index => {
      let seen = 0;
      for (let i = 0; raw && i < raw.length; i++) {
        const item = raw[i];
        if (predicate(item)) {
          if (seen === index) return item;
          seen++;
        }
      }
      return null;
    };
    const length = () => {
      let n = 0;
      for (let i = 0; raw && i < raw.length; i++) if (predicate(raw[i])) n++;
      return n;
    };
    return new Proxy({}, {
      get(_target, prop) {
        if (prop === 'length') return length();
        if (prop === 'item') return index => nth(Number(index) || 0);
        if (prop === 'getNamedItem') return name => {
          const lower = String(name || '').toLowerCase();
          if (isZPAttrName(lower)) return null;
          for (let i = 0; raw && i < raw.length; i++) if (raw[i] && String(raw[i].name).toLowerCase() === lower && predicate(raw[i])) return raw[i];
          return null;
        };
        if (prop === Symbol.iterator) return function*(){ for (let i = 0; i < length(); i++) yield nth(i); };
        if (/^(?:0|[1-9]\d*)$/.test(String(prop))) {
          const index = Number(prop);
          return index < length() ? nth(index) : undefined;
        }
        const value = raw && raw[prop];
        return typeof value === 'function' ? value.bind(raw) : value;
      },
      has(_target, prop) { return prop === 'length' || (/^(?:0|[1-9]\\d*)$/.test(String(prop)) && Number(prop) < length()); }
    });
  }
  function sanitizeSerializedHTML(html) {
    const parserDoc = Native.createHTMLDocument ? Native.createHTMLDocument('') : document.implementation.createHTMLDocument('');
    const container = parserDoc.createElement('div');
    if (Native.elementInnerHTML && Native.elementInnerHTML.set) Native.elementInnerHTML.set.call(container, String(html || ''));
    else container.innerHTML = String(html || '');
    const nodes = Array.from(container.querySelectorAll('*'));
    for (const node of nodes) {
      restoreVisibleLinkState(node);
      if (isZPAssetNode(node)) { node.remove(); continue; }
      if (Native.getAttributeNames) for (const name of Native.getAttributeNames.call(node)) if (isZPAttrName(name)) Native.removeAttribute.call(node, name);
    }
    return Native.elementInnerHTML && Native.elementInnerHTML.get ? Native.elementInnerHTML.get.call(container) : container.innerHTML;
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
    if (typeof docQSA === 'function') define(w.Document.prototype, 'querySelectorAll', function(sel) { return selectorTargetsZP(sel) ? filteredCollection([], () => false) : filteredCollection(docQSA.apply(this, arguments), node => !isZPAssetNode(node)); });
    if (typeof elemQSA === 'function') define(w.Element.prototype, 'querySelectorAll', function(sel) { return selectorTargetsZP(sel) ? filteredCollection([], () => false) : filteredCollection(elemQSA.apply(this, arguments), node => !isZPAssetNode(node)); });
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
      }
    });
  }


  function installDOMHooks(w) {
    const inIframeRealm = (w !== root);
    const transformHTMLOpts = inIframeRealm ? { inIframe: true } : undefined;
    define(w.Element.prototype, 'setAttribute', function(k, v) {
      // Hot path: cache `this.localName` (10× read across branches → 1 DOM getter)
      // and inline `attrLocalName` since `key` is already lowercase (avoids
      // redundant String/toLowerCase inside attrLocalName).
      const key = String(k).toLowerCase();
      const colon = key.indexOf(':');
      const localKey = colon < 0 ? key : key.slice(colon + 1);
      const ln = this.localName;
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
          return Native.setAttribute.call(this, k, usesRaw ? proxyViaURL(t) : subresourceProxyPath(t));
        }
      }
      if ((ln === 'iframe' || ln === 'frame') && localKey === 'srcdoc') return Native.setAttribute.call(this, k, injectSrcdoc(String(v)));
      return Native.setAttribute.call(this, k, v);
    });
    if (Native.setAttributeNS) define(w.Element.prototype, 'setAttributeNS', function(ns, k, v) {
      const key = String(k).toLowerCase();
      const colon = key.indexOf(':');
      const localKey = colon < 0 ? key : key.slice(colon + 1);
      const ln = this.localName;
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
          return Native.setAttributeNS.call(this, ns, k, usesRaw ? proxyViaURL(t) : t);
        }
      }
      return Native.setAttributeNS.call(this, ns, k, key.startsWith('on') && key.length > 2 ? rewriteEventAttribute(String(v)) : v);
    });
    if (Native.namedSetNamedItem && w.NamedNodeMap) define(w.NamedNodeMap.prototype, 'setNamedItem', function(attr) { if (attr && String(attr.name || '').toLowerCase().startsWith('on')) attr.value = rewriteEventAttribute(String(attr.value || '')); return Native.namedSetNamedItem.call(this, attr); });
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
      if (isURLBearing(this, key, localKey, ln)) return usesRawURLAttribute(this, key, localKey) ? Native.getAttribute.call(this, k) : urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url') || Native.getAttribute.call(this, k);
      return Native.getAttribute.call(this, k);
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
    installIntegrityProp(w.HTMLScriptElement && w.HTMLScriptElement.prototype);
    installIntegrityProp(w.HTMLLinkElement && w.HTMLLinkElement.prototype);
    installScriptProp(w.HTMLScriptElement && w.HTMLScriptElement.prototype);
    installScriptTextProps(w);
    installStyleHooks(w);
    installLinkProp(w.HTMLLinkElement && w.HTMLLinkElement.prototype);
    patchHTMLSetter(w.Element.prototype, 'innerHTML');
    patchHTMLSetter(w.Element.prototype, 'outerHTML');
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
          const html = parts.map(p => transformHTML(String(p), transformHTMLOpts)).join('');
          if (deferredScriptDepth > 0 && documentIsClosed(this)) return appendWrittenHTML(this, html);
          return protoWrite.apply(this, [html]);
        });
      }
      if (docProto.writeln) {
        const protoWriteln = docProto.writeln;
        define(docProto, 'writeln', function(...parts) {
          const html = parts.map(p => transformHTML(String(p), transformHTMLOpts)).join('') + '\n';
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
          get() { return d.get ? sanitizeSerializedHTML(d.get.call(this)) : ''; },
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
    return proxyOrigin + ZP.apiPath('script') + '?kind=' + encodeURIComponent(kind) + '&u=' + encodeURIComponent(target);
  }
  function setScriptSource(el, raw) {
    try { zpTrace('scriptSrc', String(raw).slice(0,140)); } catch {}
    const kind = executableScriptKindForElement(el);
    const value = String(raw);
    const trimmed = value.trim();
    if (trimmed.startsWith(ZP.CONTROL_PREFIX) || trimmed.startsWith(proxyOrigin + ZP.CONTROL_PREFIX)) {
      // Keep proxy-origin-absolute URLs absolute. The page's virtual baseURI
      // points at the target host (e.g. https://www.naver.com/), so a
      // root-relative `/zp/...` path would resolve to the target host and the
      // request would miss our SW. zp-htmltx already emits absolute proxy
      // URLs for SW-routed subresources — preserve them here.
      if (Native.getAttribute.call(el, 'src') === value) return;
      return Native.setAttribute.call(el, 'src', value);
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
        const mapped = pendingImport ? cssProxyURL(s.slice(i + 1, Math.min(j, n))) : null;
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
            get() { return d.get ? d.get.call(this) : ''; },
            set(v) { d.set.call(this, rewriteCSSText(v)); },
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
          get() { return d.get ? d.get.call(this) : ''; },
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
          const masked = urlMeta.get(this) || Native.getAttribute.call(this, 'data-zp-target-url');
          if (!masked) return d.get.call(this);
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
      setScriptText(el, inlineScriptWrapper(text, dataType));
    }
  }
  function instrumentScriptElement(el) { prepareScriptElement(el); }
  function isSVGURLBearing(el, key, _localKey) { return el && el.namespaceURI === 'http://www.w3.org/2000/svg' && (_localKey != null ? _localKey === 'href' : attrLocalName(key) === 'href') && /^(a|image|use|script)$/.test(el.localName || ''); }
  function isURLBearing(el, key, _localKey, _tag) { const tag = _tag != null ? _tag : el.localName; const localKey = _localKey != null ? _localKey : attrLocalName(key); return localKey === 'href' && (tag === 'a' || tag === 'area' || tag === 'link' || isSVGURLBearing(el, key, localKey)) || localKey === 'action' && tag === 'form' || localKey === 'formaction' && (tag === 'input' || tag === 'button') || localKey === 'src' && (tag === 'iframe' || tag === 'frame' || tag === 'script' || tag === 'img' || tag === 'source' || tag === 'audio' || tag === 'video' || tag === 'track' || tag === 'input' || tag === 'embed') || localKey === 'data' && tag === 'object' || localKey === 'poster' && tag === 'video'; }
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
  function transformHTML(value, opts) {
    const html = String(value);
    if (!html) return html;
    const inIframe = !!(opts && opts.inIframe);
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
      if ((tag === 'iframe' || tag === 'frame') && Native.hasAttribute.call(node, 'srcdoc')) {
        Native.setAttribute.call(node, 'srcdoc', injectSrcdoc(Native.getAttribute.call(node, 'srcdoc') || ''));
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
    }
    return Native.elementInnerHTML && Native.elementInnerHTML.get ? Native.elementInnerHTML.get.call(container) : container.innerHTML;
  }
  function injectSrcdoc(s) { return '<script src="/zp/assets/zp-core.js"><\/script><script src="/zp/assets/zp-page-bundle.js"><\/script><script id="__zp-boot" type="application/json">' + bootJSON() + '<\/script><script src="/zp/assets/runtime-prelude.js"><\/script>' + transformHTML(String(s)); }
  function bootJSON() { return JSON.stringify(Object.assign({}, boot, { servers: activeServers })).replace(/[<>&]/g, c => c === '<' ? '\\u003c' : c === '>' ? '\\u003e' : '\\u0026'); }
  function rewriteEventAttribute(source) { return 'return __ZP_EXEC_EVENT(this,event,' + JSON.stringify(String(source || '')).replace(/</g, '\\u003c') + ')'; }
  function syncBaseElement(node) {
    if (!node) return;
    if (node.localName === 'base' && Native.getAttribute.call(node, 'href')) updateVirtualBase(Native.getAttribute.call(node, 'href'));
    if (node.querySelectorAll) node.querySelectorAll('base[href]').forEach(el => updateVirtualBase(Native.getAttribute.call(el, 'href')));
  }
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
        // See .ai/zp-page-rt-bench-report.md §3.7.
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
      if (raw && !raw.startsWith(injectSrcdoc(''))) Native.setAttribute.call(el, 'srcdoc', injectSrcdoc(String(raw)));
      instrumentIframe(el);
      return;
    }
    if (!isURLBearing(el, key, localKey, tag)) return;
    const raw = Native.getAttribute.call(el, key);
    if (shouldBlockURLAttribute(el, localKey, raw, localKey, tag) || hasContextBlockedScheme(el, raw)) { blockExecutableURL(el, localKey, raw); return; }
    if (!raw || String(raw).startsWith(proxyOrigin)) return;
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
    if (!usesRaw) Native.setAttribute.call(el, key, subresourceProxyPath(target));
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
    if (Native.createObjectURL) define(URL, 'createObjectURL', function(blob) { if (blob && /javascript|ecmascript|text\/plain|application\/octet-stream|^$/i.test(blob.type || '')) { const blocked = blockedWorkerBlob(); const raw = Native.createObjectURL(blocked); workerBlobURLs.add(raw); return raw; } return Native.createObjectURL(blob); });
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
      if (!workerBlobURLs.has(parsed.href)) throw normalizedError('NotSupportedError');
      return parsed.href;
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
      return childWin;
    }
    function installFrameProp(proto, prop) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) return;
      try {
        Object.defineProperty(proto, prop, {
          get: d.get,
          set(v) {
            if (prop === 'srcdoc') d.set.call(this, injectSrcdoc(String(v)));
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
      } catch {}
    }
  }
  function installParentSenderRedirect(w) {
    if (!w || w === root) return;
    if (parentRedirectFacades.has(w)) return;
    const originalRootPm = postMessageOriginals.get(root);
    if (!originalRootPm) return;
    // Sender-aware postMessage for child→parent direction. Pushes sender (w)
    // onto queue before invoking native parent.postMessage so that
    // virtualizeMessageEvent at root realm can rewrite ev.source from root
    // (corrupted by V8 incumbent realm leak across our wrap function call)
    // back to w. NAVER GFP SafeFrame SDK 의 resize handler 가
    // `e.source === iframe.contentWindow` 으로 어느 광고 iframe 인지 식별 →
    // source 정정 없으면 모든 광고 iframe height=0 으로 collapse.
    const senderAwarePm = function postMessage(message, targetOrigin, transfer) {
      const mapped = arguments.length < 2 ? proxyOrigin : normalizePostMessageTargetOrigin(targetOrigin);
      parentPostMessageSenderQueue.push(w);
      try {
        return arguments.length > 2
          ? Reflect.apply(originalRootPm, root, [message, mapped, transfer])
          : Reflect.apply(originalRootPm, root, [message, mapped]);
      } catch (e) {
        const idx = parentPostMessageSenderQueue.lastIndexOf(w);
        if (idx >= 0) parentPostMessageSenderQueue.splice(idx, 1);
        throw e;
      }
    };
    maskNativeFunction(senderAwarePm, 'postMessage');
    // Window 객체에 대한 Proxy 는 Chromium 보안 모델 제약 (cross-realm, IDL
    // bindings) 으로 get trap 이 작동 안 함 — facade.postMessage access 시
    // senderAwarePm 가 아닌 native postMessage 반환 → queue push 안 됨. 대신
    // null-prototype 객체에 우리 senderAwarePm + 주요 Window properties 수동
    // delegate 한 facade 사용.
    const facade = Object.create(null);
    Object.defineProperty(facade, 'postMessage', { value: senderAwarePm, enumerable: true, configurable: false, writable: false });
    // Forward common Window properties / methods used by ad code
    const FWD_PROPS = ['top','parent','self','window','globalThis','opener','frames','length','name','closed','origin','location','document','history','navigator','screen','localStorage','sessionStorage','indexedDB','caches','crypto','performance','console','frameElement','innerWidth','innerHeight','outerWidth','outerHeight','devicePixelRatio'];
    for (const p of FWD_PROPS) {
      try {
        Object.defineProperty(facade, p, { get: () => root[p], enumerable: true, configurable: false });
      } catch {}
    }
    parentRedirectFacades.set(w, facade);
    try { defineAccessor(w, 'parent', () => facade); } catch {}
    try { defineAccessor(w, 'top', () => facade); } catch {}
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
