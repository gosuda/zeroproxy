
  function __zpStep(name, fn) {
    zpTrace('install:' + name + ':start');
    try { fn(); zpTrace('install:' + name + ':done'); }
    catch (e) { zpTrace('install:' + name + ':err', String(e && e.message || e).slice(0, 200)); throw e; }
  }
  __zpStep('ToStringMasking', () => installToStringMasking(root));
  define(root, '__ZP_SET_BASE', updateVirtualBase);
  __zpStep('Phase2Membrane', installPhase2Membrane);
  __zpStep('StackSanitizer', installStackSanitizer);

  __zpStep('WebSocket', installWebSocket);
  __zpStep('WebSocketStream', installWebSocketStream);
  __zpStep('HTTPAPIs', installHTTPAPIs);
  __zpStep('Beacon', installBeacon);
  __zpStep('ProtocolHandlerFacade', installProtocolHandlerFacade);
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
  __zpStep('SurfaceGuards', () => installSurfaceGuards(root));
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


  // ── Error.stack sanitizer ────────────────────────────────────────────
  // V8 formats `.stack` lazily through Error.prepareStackTrace — the one
  // interception point that exists for every error object. Without it,
  // `new Error().stack` hands the page frames whose file names are our
  // /zp/api/script / share-path URLs. Install a prepareStackTrace that
  // routes every URL-bearing frame accessor through deproxyURL; a page-
  // supplied prepareStackTrace still runs, but on SANITIZED frames so the
  // custom formatter can't recover the raw URLs either.
  function installStackSanitizer() {
    const E = root.Error;
    if (!E) return;
    let userPrepare = null;
    // 프레임 텍스트에는 URL 만이 아니라 **우리 내부 식별자**도 섞인다 —
    // `at Proxy.__zp_dyn__ (…)` 처럼. 페이지에는 원본 스크립트의 함수명만이
    // 의미가 있으니 `__zp_*` 이름은 중립 식별자로 지운다.
    function sanitizeFrameText(v) {
      if (v == null) return v;
      return deproxyURL(String(v), { scan: true, fallback: 'share' }).replace(/\b__zp_[A-Za-z0-9_$]*/g, '<anonymous>');
    }
    function frameFacade(f) {
      return new Proxy(f, {
        get(t, p) {
          const v = Reflect.get(t, p, t);
          if (typeof v !== 'function') return v;
          if (p === 'getFileName' || p === 'getScriptNameOrSourceURL' || p === 'getEvalOrigin') {
            return function () { return sanitizeFrameText(v.apply(t, arguments)); };
          }
          if (p === 'toString') return function () { return sanitizeFrameText(v.apply(t, arguments)); };
          return v.bind(t);
        }
      });
    }
    const zpPrepare = function (error, frames) {
      const wrapped = frames.map(frameFacade);
      if (userPrepare) return userPrepare(error, wrapped);
      let head;
      try { head = String(error); } catch { head = 'Error'; }
      let out = head;
      for (const f of wrapped) { try { out += '\n    at ' + f.toString(); } catch {} }
      return out;
    };
    try {
      defineMasked(E, 'prepareStackTrace', {
        get() { return zpPrepare; },
        set(v) { userPrepare = typeof v === 'function' ? v : null; },
        configurable: true, enumerable: false
      });
    } catch {}
  }