(() => {
  'use strict';
  const root = window;
  const nativeOwnKeys = Reflect.ownKeys;
  // Capture native encodeURIComponent before page scripts run so page wrappers
  // cannot observe URLs, tab IDs, or entry IDs encoded by the membrane.
  const nativeEncodeURIComponent = encodeURIComponent;
  // Internal collections use a null-rooted copy of the built-in prototype
  // descriptors captured before page scripts run. Calling table.get(key)
  // invokes the sealed native method rather than a page-patched
  // Map.prototype.get, preventing leaks of internal handles and infinite
  // recursion during with(__zp_lex_scope) free-variable lookups.
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
    const s = sealedSetProto(new Set(), SEALED_SET);
    if (items) for (let i = 0; i < items.length; i++) s.add(items[i]);
    return s;
  };
  const newWeakMap = () => sealedSetProto(new WeakMap(), SEALED_WEAKMAP);
  const newWeakSet = () => sealedSetProto(new WeakSet(), SEALED_WEAKSET);
  // Capture native Window accessors (parent, frameElement, opener, length, etc.)
  // before page scripts run. Reading w.frameElement directly would invoke
  // page-defined getters with the raw Window as `this`. These native getters
  // perform WebIDL brand checks independent of realm.
  const nativeApply = Reflect.apply;
  const nativeReflectGet = Reflect.get;
  const nativeReflectSet = Reflect.set;
  const nativeReflectHas = Reflect.has;
  const nativeReflectGOPD = Reflect.getOwnPropertyDescriptor;
  const nativeReflectDefineProperty = Reflect.defineProperty;
  const nativeReflectDeleteProperty = Reflect.deleteProperty;
  const nativeReflectGetPrototypeOf = Reflect.getPrototypeOf;
  const nativeReflectConstruct = Reflect.construct;
  const nativeHasOwn = Object.prototype.hasOwnProperty;
  const nativeFnToString = Function.prototype.toString;
  const nativeRegExpExec = RegExp.prototype.exec;
  const sealRegExp = re => {
    nativeReflectDefineProperty(re, 'exec', { value: nativeRegExpExec, writable: false, enumerable: false, configurable: false });
    nativeReflectDefineProperty(re, 'test', { value: s => nativeApply(nativeRegExpExec, re, [s]) !== null, writable: false, enumerable: false, configurable: false });
    return re;
  };
  const WINDOW_ACCESSORS = Object.create(null);
  for (const name of ['parent', 'top', 'opener', 'frameElement', 'self', 'frames', 'name', 'length', 'closed', 'history', 'navigation']) {
    const d = nativeReflectGOPD(root, name);
    if (d && (d.get || d.set)) WINDOW_ACCESSORS[name] = d;
  }
  function winGet(w, name) {
    const d = WINDOW_ACCESSORS[name];
    return d && d.get ? nativeApply(d.get, w, []) : w[name];
  }
  function winSet(w, name, value) {
    const d = WINDOW_ACCESSORS[name];
    if (d && d.set) nativeApply(d.set, w, [value]); else w[name] = value;
  }
  // Use an undescribed Symbol so Object.getOwnPropertySymbols(window) exposes
  // no identifying description string.
  const marker = Symbol();
  if (root[marker]) return;
  Object.defineProperty(root, marker, { value: true, enumerable: false, configurable: false });

  // Capture ZeroProxy runtime helpers into closure bindings and delete the
  // global properties so Object.getOwnPropertyNames(window) cannot enumerate
  // them.
  const ZP = globalThis.ZP;
  const ZeroProxyRTGlobal = globalThis.ZeroProxyRT;
  try { delete globalThis.ZP; } catch {}
  try { delete globalThis.ZeroProxyRT; } catch {}

  // Rewritten code emits bare calls to __zp_* and __ZP_* helpers, so those
  // bindings must remain on the global object. Scrub them from
  // Object.getOwnPropertyNames, Object.keys, and Reflect.ownKeys instead;
  // setting enumerable: false alone does not hide own properties from
  // getOwnPropertyNames or Reflect.ownKeys.
  const ZP_HIDDEN_RE = sealRegExp(/^(?:__zp_|__ZP_|ZPBundle$|ZPPageBundleWBG$|ZeroProxyRT$|ZP$)/);
  // Reserved runtime global names rejected on page writes (matching
  // zp-rewriter is_reserved_name). Rewritten call sites pass the real global
  // object to these helpers, so page overwrites would leak the raw window.
  // Excludes compiler temporaries and wrapper parameter names.
  const ZP_RESERVED_NAME_RE = sealRegExp(/^(?:__ZP_|__zp_(?!(?:(?:w|lc|lbl|vdcl|dp|sk|t)_\d+|bad|oc|dynamic__|dyn__|inner__|scope|args|self|env|src)$))/);
  // Runtime helpers bound as block constants at the top of every `with` block
  // (matching zp-rewriter RUNTIME_HELPERS order). Binding them in a lexical
  // block resolves helper identifiers statically instead of triggering the
  // `with` proxy trap on every helper call.
  const ZP_WITH_HELPERS = ['__zp_get', '__zp_set', '__zp_call', '__zp_this', '__zp_assign', '__zp_update', '__zp_delete',
    '__zp_eval', '__zp_has', '__zp_oget', '__zp_ocall', '__zp_ocallv', '__zp_ochain', '__zp_odelete', '__zp_okeys',
    '__zp_rget', '__zp_rset', '__zp_ownKeys', '__zp_getOwnPropertyDescriptor', '__zp_getOwnPropertyDescriptors',
    '__zp_getOwnPropertyNames', '__zp_module_url', '__zp_with_get', '__zp_with_set', '__zp_with_assign',
    '__zp_with_update', '__zp_with_delete', '__zp_with_d', '__zp_lex_decl', '__zp_lex_bind', '__zp_fast', '__zp_fastset'];
  const ZP_WITH_PROLOGUE = 'const{' + ZP_WITH_HELPERS.join(',') + '}=(function(){return this})();';
  // Prefix for inline on* event attribute bodies. Reads __ZP_EXEC_EVENT off a
  // sloppy function's default `this` (the raw window) so element, form, or
  // document expandos in the event handler scope chain cannot shadow it.
  const ZP_EVENT_CALL_HEAD = '(function(){return this})().__ZP_EXEC_EVENT(';
  // Page-facing state for Error.prepareStackTrace (see 06-install.js). V8 invokes
  // the membrane's stack sanitizer via the native accessor while page code
  // reads and writes this record through routed member helpers.
  const pageStackHook = { ctor: null, exists: false, value: undefined, forget: null };
  // Mark __zp_* globals non-enumerable so `for (const k in window)` cannot
  // observe them; `for..in` is a language construct that bypasses method wrappers.
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
  // Hide globals installed by zp-core.js and zp-page-bundle.js prior to prelude boot.
  hideZPGlobalsFromForIn();
  try {
    // Treat both the raw global object and the membrane's window scope proxy as
    // global objects during key enumeration scrubbing. Because the scope proxy is
    // constructed later in boot, identify it via the self-referential `o.window === o`
    // invariant.
    const isGlobalObj = o => {
      try {
        if (o === globalThis || o === root) return true;
        if (typeof self !== 'undefined' && o === self) return true;
        return !!o && typeof o === 'object' && o.window === o;
      } catch { return false; }
    };
    // Chrome exposes only ["constructor"] on Location.prototype; all other
    // Location members are unforgeable own properties on the location instance.
    // Hide membrane accessors installed on Location.prototype from enumeration.
    const LOC_PROTO_OK = newSet(['constructor']);
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
        if (target === pageStackHook.ctor && target != null && !pageStackHook.exists) return out.filter(n => n !== 'prepareStackTrace');
        return (isGlobalObj(target) || isLocProto(target)) ? scrub(out, target) : out;
      };
      // Preserve native fn.toString(), fn.name, and fn.length on wrapped methods.
      try {
        Object.defineProperty(patched, 'name', { value: name, configurable: true });
        Object.defineProperty(patched, 'length', { value: orig.length, configurable: true });
      } catch {}
      nativeToStringSources.set(patched, orig);
      try { Object.defineProperty(owner, name, { value: patched, writable: true, configurable: true }); } catch {}
    };
    const nativeToStringSources = newWeakMap();
    const origToString = Function.prototype.toString;
    try {
      const patchedToString = function () {
        const src = nativeToStringSources.get(this);
        return origToString.call(src || this);
      };
      Object.defineProperty(patchedToString, 'name', { value: 'toString', configurable: true });
      Object.defineProperty(patchedToString, 'length', { value: origToString.length, configurable: true });
      Object.defineProperty(Function.prototype, 'toString', { value: patchedToString, writable: true, configurable: true });
    } catch {}
    hideFrom(Object, 'getOwnPropertyNames');
    hideFrom(Object, 'keys');
    hideFrom(Reflect, 'ownKeys');
    // Filter undescribed and internal symbols from Object.getOwnPropertySymbols(window).
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
  // Read the canonical User-Agent from zp-core so navigator.userAgent matches
  // outgoing HTTP headers injected by the service worker.
  const TARGET_USER_AGENT = ZP.TARGET_USER_AGENT;
  const TARGET_APP_VERSION = TARGET_USER_AGENT.replace(/^Mozilla\//, '');
  const TARGET_PLATFORM = 'Win32';
  // Declare cachedUADataBrands before captureNative and prototype installation
  // so early calls to targetBrandList() do not hit a temporal dead zone.
  let cachedUADataBrands = null;
  clearBootConfig();
  const Native = captureNative(root);
  // Bind the native URL constructor before installStorageFacades replaces
  // root.URL with the virtualizing ZPURL wrapper.
  const URL = Native.URL || root.URL;
  let decodeFetchResponse;


  // Resolve the physical proxy origin. In `about:srcdoc` and `about:blank`
  // frames, `new URL(location.href).origin` and `location.origin` return `"null"`.
  // Fall back to boot config, the prelude script's own `currentScript.src`, or
  // ancestor frames.
  function resolveProxyOrigin(u, bootCfg, w) {
    const direct = u && u.origin;
    if (direct && direct !== 'null') return direct;
    const fromBoot = bootCfg && bootCfg.proxyOrigin;
    if (fromBoot && fromBoot !== 'null') return String(fromBoot);
    // `currentScript.src` points to the proxy-hosted prelude before any virtual
    // <base> element or attribute hook is installed.
    try {
      const cs = w && w.document && w.document.currentScript;
      const src = cs && cs.src;
      if (src) {
        const o = new URL(String(src)).origin;
        if (o && o !== 'null') return o;
      }
    } catch {}
    // Last resort: walk ancestor frames if boot config and currentScript are unavailable.
    try {
      let f = w;
      for (let i = 0; i < 32 && f && winGet(f, 'parent') && winGet(f, 'parent') !== f; i++) {
        f = winGet(f, 'parent');
        const o = f.location && f.location.origin;
        if (o && o !== 'null') return String(o);
      }
    } catch { /* cross-origin ancestor */ }
    return direct;
  }

  const toStringMap = newWeakMap();
  const toStringMaskedPrototypes = newWeakSet();
  const origToString = root.Function && root.Function.prototype && root.Function.prototype.toString;
  const initialProxyURL = new URL(root.location.href);
  const proxyOrigin = resolveProxyOrigin(initialProxyURL, boot, root);
  const proxyHost = proxyOrigin ? proxyOrigin.replace(/^[a-z]+:\/\//i, '') : initialProxyURL.host;

  // Load zp-page-rt WASM asynchronously using an absolute proxy-origin URL so
  // frames with a virtual target <base> (such as srcdoc or blob frames) do not
  // request the WASM binary from the target origin. Until instantiation
  // completes, URL classification falls back to the JS path.
  let rt = null;
  // Skip WASM fetch if a parent frame already instrumented this realm; in that
  // case `Native.fetch` is the parent membrane's wrapper and would rewrite the
  // proxy-origin WASM URL to the target origin.
  const realmPreInstrumented = typeof root.__zp_get === 'function';
  if (!realmPreInstrumented && typeof ZeroProxyRTGlobal === 'object' && ZeroProxyRTGlobal) {
    try {
      // Fetch the raw WASM bytes via Native.fetch and pass the buffer to
      // ZeroProxyRTGlobal.load so the glue does not call the membrane-wrapped global fetch.
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
  // Map page-created blob: URLs to their underlying Blob objects so Worker
  // bootstrap can read the script source even if the page calls
  // URL.revokeObjectURL immediately after `new Worker(u)`.
  const pageBlobURLs = newMap();
  let explicitBaseURL = '';
  let activeShareVersion = 0;
  let documentCookie = String(boot.documentCookie || '');
  const documentCookieRecords = [];
  const activeObservers = newSet();
  let realmDisposed = false;
  let __zpHeartbeatTimer = null;
  // Live view of realm state exposed via root.__zp_realm for embedder inspection
  // and bridge attachment.
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
    get disposed() { return realmDisposed; },
  };
  initDocumentCookieRecords(documentCookie);
  const urlMeta = newWeakMap();
  // Preserve author-written attribute strings for getAttribute parity after the
  // membrane rewrites DOM attributes to proxy URLs. Initial HTML literals arrive
  // via `data-zp-lit-*` attributes from htmltx.
  const urlLitMeta = newWeakMap();
  function litAttrName(key) { return 'data-zp-lit-' + String(key).toLowerCase(); }
  function litSet(el, key, value) { let m = urlLitMeta.get(el); if (!m) { m = newMap(); urlLitMeta.set(el, m); } m.set(String(key).toLowerCase(), String(value)); }
  function litGet(el, key) { const m = urlLitMeta.get(el); const k = String(key).toLowerCase(); if (m && m.has(k)) return m.get(k); return undefined; }
  function litDel(el, key) { const m = urlLitMeta.get(el); if (m) m.delete(String(key).toLowerCase()); }
  // Store original srcset strings separately from urlMeta so elements with both
  // `src` and `srcset` (such as <img>) do not overwrite each other.
  const srcsetMeta = newWeakMap();
  const messageListenerWrappers = newWeakMap();
  const frameWindowOrigins = newWeakMap();
  // Track frames with in-flight routed navigations so placeholder about:blank
  // loads can be suppressed and stale async routes cannot overwrite newer ones.
  const pendingFrameRoutes = newWeakSet();
  const frameRouteSeq = newWeakMap();
  // Backing store for virtualized iframe `sandbox` attributes. The membrane
  // strips the physical attribute when needed and serves the author-specified
  // token string through getAttribute/hasAttribute and the sandbox DOMTokenList.
  const frameSandboxMeta = newWeakMap();
  // Map frame elements to their virtualized `sandbox` DOMTokenList state.
  const sandboxShadows = newWeakMap();
  // Frames sandboxed without `allow-same-origin` receive a physical same-origin
  // sandbox so the service worker and prelude can operate, while `data-zp-opaque`
  // instructs the membrane to enforce opaque-origin restrictions (null origin,
  // storage/cookie SecurityErrors, and cross-origin isolation).
  const OPAQUE_FRAME_ATTR = 'data-zp-opaque';
  // Query the parent realm before child-realm hooks are installed.
  const opaqueDocument = (() => {
    // Popups opened from an opaque document inherit opacity via boot config.
    try { if (boot.opaque === true) return true; } catch {}
    try {
      const fe = winGet(root, 'frameElement');
      if (!fe) return false;
      const ask = winGet(root, 'parent').__zp_frame_opaque;
      return typeof ask === 'function' && ask(fe) === true;
    } catch { return false; }
  })();
  // Each opaque document receives a unique internal token so two opaque realms
  // never compare same-origin, while displayOrigin serializes it as "null".
  const opaqueOriginToken = opaqueDocument ? 'null#' + Math.random().toString(36).slice(2) + Date.now().toString(36) : '';
  const OPAQUE_PENDING_ORIGIN = 'null#pending';
  function securityOrigin() { return opaqueDocument ? opaqueOriginToken : virtualURL.origin; }
  function displayOrigin(o) { return typeof o === 'string' && o.indexOf('null#') === 0 ? 'null' : o; }
  // Collect virtual origins of ancestor frames (nearest first) to back
  // `location.ancestorOrigins`.
  function embedderOrigins() {
    const out = [];
    try {
      let w = root;
      for (let depth = 0; depth < 32; depth++) {
        const p = winGet(w, 'parent');
        if (!p || p === w) break;
        let o = '';
        try { o = typeof p.__zp_origin === 'function' ? p.__zp_origin() : ''; } catch {}
        if (typeof o === 'string' && o) out.push(displayOrigin(o));
        w = p;
      }
    } catch {}
    return out;
  }
  // Compute `document.referrer` from the boot config or, for unfetched frames
  // (about:blank, srcdoc), from the parent's virtual URL under
  // strict-origin-when-cross-origin.
  function virtualReferrer() {
    if (typeof boot.referrer === 'string') return boot.referrer;
    try {
      const p = winGet(root, 'parent');
      if (!p || p === root) return '';
      const parentURL = typeof p.__zp_url === 'function' ? p.__zp_url() : '';
      if (!parentURL) return '';
      const from = new URL(parentURL);
      if (from.protocol !== 'http:' && from.protocol !== 'https:') return '';
      if (from.protocol === 'https:' && virtualURL.protocol === 'http:') return '';
      from.hash = '';
      from.username = '';
      from.password = '';
      return from.origin === virtualURL.origin ? from.href : from.origin + '/';
    } catch { return ''; }
  }
  // Construct the SecurityError thrown when an opaque origin accesses storage APIs.
  const OPAQUE_FLAG_TEXT = "The document is sandboxed and lacks the 'allow-same-origin' flag.";
  function opaqueDenied(prefix, text) {
    // Empty `text` indicates `prefix` is the complete error message.
    try { return new Native.DOMException(text === '' ? prefix : prefix + ': ' + (text || OPAQUE_FLAG_TEXT), 'SecurityError'); } catch { return normalizedError('SecurityError'); }
  }
  // Declare opaqueDocument helpers before realm bootstrap.
  // `installBaseObserver` runs during early frame containment before later
  // declarations execute; check descriptor configurability directly.
  function propertyLocked(obj, prop) {
    try {
      const d = Object.getOwnPropertyDescriptor(obj, prop);
      return !!d && !d.configurable;
    } catch { return true; }
  }
  const crossWindowProxyCache = newWeakMap();
  const postMessageWrappers = newWeakMap();
  // Undescribed Symbols avoid exposing identifying description strings through
  // Object.getOwnPropertySymbols.
  const frameTargetOriginMarker = Symbol();
  const networkContainmentMarker = Symbol();
  const iframeHooksMarker = Symbol();
  const safeFrameShimMarker = Symbol();
  const stealthMarker = Symbol();
  const listenersKey = Symbol();
  const windowMethodBindings = newMap();
  const integrityBackupAttr = 'data-zp-integrity';
  const hiddenIconHref = 'data:application/x-zeroproxy-icon,1';
  const WINDOW_BOUND_METHODS = newSet(['addEventListener','removeEventListener','dispatchEvent','setTimeout','setInterval','clearTimeout','clearInterval','requestAnimationFrame','cancelAnimationFrame','requestIdleCallback','cancelIdleCallback','matchMedia','getComputedStyle','postMessage','atob','btoa','focus','blur','close','print','alert','confirm','prompt','scroll','scrollTo','scrollBy']);
  const serviceWorkerFacades = newWeakMap();
  const storageMaps = newMap();
  // Shared hook table populated by installPhase2Membrane so sibling functions
  // (such as installNetworkContainment) can invoke the script rewriter for
  // child realms.
  let pageRewriteHooks = null;
  // Shared policy table populated by installPhase2Membrane for wrapping window
  // references across frame accessors, message events, and popups.
  let windowHandles = null;

  // Tracks active deferred child-realm script executions so `document.write`
  // does not wipe a closed document during ordered pipeline playback.
  let deferredScriptDepth = 0;

  // Bounded diagnostic ring buffer capturing runtime errors and unhandled
  // rejections on root.__zp_diagnostics.
  try {
    if (!root.__zp_diagnostics) {
      const diag = [];
      const push = e => { if (diag.length < 200) diag.push(e); };
      // Non-enumerable so `for (const k in window)` skips it.
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

  // Persist bounded trace checkpoints and heartbeat timestamps to proxy-origin
  // localStorage for post-mortem hang analysis.
  let __zpTraceSeq = 0;
  let __zpNativeStorage = null;
  try { __zpNativeStorage = root.localStorage; } catch {}

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
    __zpHeartbeatTimer = setInterval(() => {
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