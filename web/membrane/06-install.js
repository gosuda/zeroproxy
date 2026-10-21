
  function __zpStep(name, fn) {
    zpTrace('install:' + name + ':start');
    try { fn(); zpTrace('install:' + name + ':done'); }
    catch (e) { zpTrace('install:' + name + ':err', String(e && e.message || e).slice(0, 200)); throw e; }
  }
  ttPolicy();
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
  __zpStep('NavigationBackstop', () => installNavigationBackstop(root, root.document && root.document.documentElement));
  __zpStep('SurfaceGuards', () => installSurfaceGuards(root));
  zpTrace('install:all:done');
  // Synchronous modal dialogs (alert, confirm, prompt) and print block the main
  // thread until dismissed. In headless or automated sessions no shell dismisses
  // them, which wedges CDP evaluation. Log via zpTrace and return safe defaults.
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
  // Trace top-level WebAssembly compilation and instantiation for diagnostics.
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


  // V8 formats `.stack` lazily through Error.prepareStackTrace. Route every
  // URL-bearing frame accessor through deproxyURL so stack traces do not expose
  // proxy asset or share-path URLs. User-supplied prepareStackTrace hooks
  // receive wrapped frames so custom formatters see only sanitized URLs.
  function installStackSanitizer() {
    const E = root.Error;
    if (!E) return;
    let userPrepare = null;
    // Replace internal `__zp_*` wrapper identifiers with `<anonymous>` in addition to deproxying URLs.
    function sanitizeFrameText(v) {
      if (v == null) return v;
      return deproxyURL(String(v), { scan: true, fallback: 'share' }).replace(/\b__zp_[A-Za-z0-9_$]*/g, '<anonymous>');
    }
    // Strip proxy URLs while preserving `:line:col` suffixes, since deproxyURL's
    // scan mode would otherwise consume the trailing position as part of the URL.
    function sanitizeFrameWithPositions(text) {
      const cleaned = String(text).replace(/(https?:\/\/[^\s()]*?)(:\d+(?::\d+)?)(?=[)\s]|$)/g, (_m, url, pos) => sanitizeFrameText(url) + pos);
      return cleaned.replace(/\b__zp_[A-Za-z0-9_$]*/g, '<anonymous>');
    }
    // Identify frames originating from ZeroProxy prelude and bundle assets so
    // they can be omitted from page-visible stack traces.
    function isMembraneFrame(f) {
      try {
        const file = String(f.getFileName() || '');
        return /\/zp\/assets\/(?:runtime-prelude|worker-prelude|zp-core|zp-page-bundle)\.js/.test(file);
      } catch { return false; }
    }
    // Inline scripts execute via global eval with a sourceURL, which causes V8
    // to label the top-level frame `eval` and insert the eval builtin and
    // bootstrap script frames beneath it. Normalize these frames to match native
    // inline script stacks.
    function isOwnEvalFrame(f) {
      try {
        if (!f.isEval()) return false;
        const origin = f.getEvalOrigin(), script = f.getScriptNameOrSourceURL();
        return !!origin && String(origin) === String(script);
      } catch { return false; }
    }
    function isBuiltinEvalFrame(f) {
      try { return f.getFunctionName() === 'eval' && !f.isEval() && !f.getFileName(); } catch { return false; }
    }
    function isInlineBootstrapFrame(f) {
      try { return !f.isEval() && !f.getFunctionName() && /\/zp\/p\//.test(String(f.getFileName() || '')); } catch { return false; }
    }
    // Format a frame to match native browser script output: omit `eval` on top-level
    // inline script frames, hide `Proxy.` receivers on window facade calls, and
    // preserve receiver type names on method calls.
    function scriptFrameText(f) {
      // A builtin frame (`Function.prototype.toString`, `String`, ...) has no script and no position: V8 prints it as `(<anonymous>)`.
      const positionless = f.getLineNumber() == null && !(f.getScriptNameOrSourceURL() || f.getFileName());
      const loc = positionless ? '<anonymous>' : sanitizeFrameWithPositions(String(f.getScriptNameOrSourceURL() || f.getFileName() || '<anonymous>') + ':' + f.getLineNumber() + ':' + f.getColumnNumber());
      let fn = f.getFunctionName();
      if (fn === 'eval' && isOwnEvalFrame(f)) fn = null;
      // Hide internal membrane wrapper names (`__zp_dyn__`, etc.).
      if (fn && /^__zp_/.test(fn)) fn = null;
      let type = null;
      try { type = f.getTypeName(); } catch {}
      let method = f.getMethodName();
      if (method && /^__zp_/.test(method)) method = null;
      let s;
      if (f.isConstructor()) s = 'new ' + (fn || '<anonymous>') + ' (' + loc + ')';
      else if (!f.isToplevel() && type && type !== 'Proxy') s = type + '.' + (fn || '<anonymous>') + (method && fn && method !== fn ? ' [as ' + method + ']' : '') + ' (' + loc + ')';
      else s = fn ? fn + ' (' + loc + ')' : loc;
      return (((typeof f.isAsync === 'function' && f.isAsync()) ? 'async ' : '') + s).replace(/\b__zp_[A-Za-z0-9_$]*/g, '<anonymous>');
    }
    function needsScriptFormat(f) {
      try { return isOwnEvalFrame(f) || f.getTypeName() === 'Proxy'; } catch { return false; }
    }
    function frameFacade(f) {
      return new Proxy(f, {
        get(t, p) {
          const v = Reflect.get(t, p, t);
          if (typeof v !== 'function') return v;
          if (p === 'getFileName' || p === 'getScriptNameOrSourceURL' || p === 'getEvalOrigin') {
            return function () { return sanitizeFrameText(v.apply(t, arguments)); };
          }
          if (p === 'getFunctionName') return function () { const n = v.apply(t, arguments); return n === 'eval' && isOwnEvalFrame(t) ? null : n; };
          if (p === 'isEval') return function () { return isOwnEvalFrame(t) ? false : v.apply(t, arguments); };
          if (p === 'toString') return function () { return needsScriptFormat(t) ? scriptFrameText(t) : sanitizeFrameWithPositions(v.apply(t, arguments)); };
          return v.bind(t);
        }
      });
    }
    // Filter out membrane frames and, for inline scripts, the synthetic `eval`
    // builtin and bootstrap frames immediately beneath them (while keeping
    // genuine page-initiated `eval` frames intact).
    function pageFrames(frames) {
      const out = [];
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        if (isMembraneFrame(f)) continue;
        if (isBuiltinEvalFrame(f)) {
          let j = i + 1;
          while (j < frames.length && isMembraneFrame(frames[j])) j++;
          if (j < frames.length && isInlineBootstrapFrame(frames[j])) { i = j; continue; }
        }
        out.push(f);
      }
      return out;
    }
    // Because the getter always returns `zpPrepare`, saving and restoring
    // `Error.prepareStackTrace` in page code would assign `zpPrepare` back into
    // `userPrepare` and recurse indefinitely. Treat assigning `zpPrepare` as
    // clearing the user hook, and guard re-entry with `inUserPrepare`.
    let inUserPrepare = false;
    const zpPrepare = function (error, frames) {
      const wrapped = pageFrames(frames).map(frameFacade);
      if (userPrepare && !inUserPrepare) {
        inUserPrepare = true;
        try { return userPrepare(error, wrapped); } finally { inUserPrepare = false; }
      }
      let head;
      try { head = String(error); } catch { head = 'Error'; }
      let out = head;
      for (const f of wrapped) { try { out += '\n    at ' + f.toString(); } catch {} }
      return out;
    };
    // V8 always reads zpPrepare; the page's assigned hook is stored in pageStackHook
    // (00-head.js). Assigning makes the property enumerable and deleting hides it again.
    const listHook = enumerable => { try { Object.defineProperty(E, 'prepareStackTrace', { enumerable }); } catch {} };
    try {
      defineMasked(E, 'prepareStackTrace', {
        get() { return zpPrepare; },
        set(v) {
          pageStackHook.exists = true;
          pageStackHook.value = v;
          userPrepare = typeof v === 'function' && v !== zpPrepare ? v : null;
          listHook(true);
        },
        configurable: true, enumerable: false
      });
      pageStackHook.ctor = E;
      pageStackHook.forget = () => {
        pageStackHook.exists = false;
        pageStackHook.value = undefined;
        userPrepare = null;
        listHook(false);
      };
    } catch {}
  }