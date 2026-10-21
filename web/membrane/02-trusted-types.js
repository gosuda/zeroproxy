
  // Trusted Types. A document whose CSP says `require-trusted-types-for 'script'` binds every string sink, the page's and the membrane's own.
  // The service worker carries the target's directives to the proxied document (and the HTML transformer does the same for a `<meta>` policy),
  // adding the name of a policy of ours to its `trusted-types` list. The membrane creates that policy first and gives the native sinks only
  // values it made; what the page gives a sink the membrane wraps is checked here first, as the engine would have checked it, because the
  // membrane rewrites it before the native sink sees it.
  //
  // A page's value is a Trusted* object (rewritten, then wrapped again), or a string. A string goes to the page's `default` policy, called the
  // way the engine calls it (`createX(string, 'TrustedX', sink)`); a document that enforces and has no such policy refuses it with the error the
  // engine throws. A document that does not enforce is left alone: its strings pass through exactly as before.
  const TT_KINDS = { HTML: 'TrustedHTML', Script: 'TrustedScript', ScriptURL: 'TrustedScriptURL' };
  // Sink name -> how the engine words the refusal. `set` is an attribute assignment, `execute` a method call, `construct` a constructor.
  const TT_SINKS = {
    'Element innerHTML': ['set', 'innerHTML', 'Element'], 'Element outerHTML': ['set', 'outerHTML', 'Element'],
    'ShadowRoot innerHTML': ['set', 'innerHTML', 'ShadowRoot'], 'HTMLIFrameElement srcdoc': ['set', 'srcdoc', 'HTMLIFrameElement'],
    'HTMLScriptElement text': ['set', 'text', 'HTMLScriptElement'], 'HTMLScriptElement innerText': ['set', 'innerText', 'HTMLScriptElement'],
    'HTMLScriptElement textContent': ['set', 'textContent', 'HTMLScriptElement'], 'HTMLScriptElement src': ['set', 'src', 'HTMLScriptElement'],
    'Element insertAdjacentHTML': ['execute', 'insertAdjacentHTML', 'Element'], 'Document write': ['execute', 'write', 'Document'],
    'Document writeln': ['execute', 'writeln', 'Document'], 'DOMParser parseFromString': ['execute', 'parseFromString', 'DOMParser'],
    'Range createContextualFragment': ['execute', 'createContextualFragment', 'Range'], 'Element setHTMLUnsafe': ['execute', 'setHTMLUnsafe', 'Element'],
    'ShadowRoot setHTMLUnsafe': ['execute', 'setHTMLUnsafe', 'ShadowRoot'], 'Document parseHTMLUnsafe': ['execute', 'parseHTMLUnsafe', 'Document'],
    'Window setTimeout': ['execute', 'setTimeout', 'Window'], 'Window setInterval': ['execute', 'setInterval', 'Window'],
    'Worker constructor': ['construct', 'Worker'], 'SharedWorker constructor': ['construct', 'SharedWorker'],
    'eval': ['eval'], 'Function': ['eval'],
  };
  // The refusal the engine throws for `sink` when the document enforces `kind` and there is no `default` policy.
  function ttViolation(kind, sink, via) {
    const how = TT_SINKS[sink];
    if (via) return new TypeError("Failed to execute '" + via + "' on 'Element': This document requires '" + TT_KINDS[kind] + "' assignment.");
    if (how && how[0] === 'eval') return new EvalError("Evaluating a string as JavaScript violates this document's Trusted Type assignment requirements.");
    const tail = "This document requires '" + TT_KINDS[kind] + "' assignment.";
    if (how && how[0] === 'set') return new TypeError("Failed to set the '" + how[1] + "' property on '" + how[2] + "': " + tail);
    if (how && how[0] === 'execute') return new TypeError("Failed to execute '" + how[1] + "' on '" + how[2] + "': " + tail);
    if (how && how[0] === 'construct') return new TypeError("Failed to construct '" + how[1] + "': " + tail);
    const m = /^(\S+) (\S+)$/.exec(String(sink));
    return new TypeError(m ? "Failed to set the '" + m[2] + "' property on '" + m[1] + "': " + tail : tail);
  }
  // The membrane's own policy, which turns the strings it builds into Trusted* values. Null where the browser has no Trusted Types or the
  // document's policy does not admit the name; then the membrane hands strings to the native sinks as it always did.
  let ttInternalPolicy;
  function ttPolicy() {
    if (ttInternalPolicy !== undefined) return ttInternalPolicy;
    ttInternalPolicy = null;
    if (!Native.trustedTypes || typeof Native.ttCreatePolicy !== 'function' || typeof Native.ttCreateHTML !== 'function') return null;
    try {
      ttInternalPolicy = nativeApply(Native.ttCreatePolicy, Native.trustedTypes, [ZP.TT_POLICY_NAME, { createHTML: s => s, createScript: s => s, createScriptURL: s => s }]);
    } catch { ttInternalPolicy = null; }
    return ttInternalPolicy;
  }
  const ttMake = (create, s) => { const p = ttPolicy(); return p ? nativeApply(create, p, [s]) : s; };
  // A Trusted* value for a string the membrane built. The native sink accepts it whether or not the document enforces Trusted Types.
  function ttHTML(s) { return ttMake(Native.ttCreateHTML, s); }
  function ttScript(s) { return ttMake(Native.ttCreateScript, s); }
  function ttScriptURL(s) { return ttMake(Native.ttCreateScriptURL, s); }
  // Whether the document enforces Trusted Types on script sinks: from the response header (the boot config) or from a `<meta>` policy,
  // re-read only when the number of `<meta>` elements changes.
  let ttMetaEnforced = false, ttMetaList = null, ttMetaCount = -1;
  function ttEnforced() {
    if (boot.trustedTypes === true || ttMetaEnforced) return true;
    try {
      const d = root.document;
      if (!d || !Native.documentGetElementsByTagName) return false;
      if (!ttMetaList) ttMetaList = nativeApply(Native.documentGetElementsByTagName, d, ['meta']);
      const n = ttMetaList.length;
      if (n === ttMetaCount) return false;
      ttMetaCount = n;
      for (let i = 0; i < n; i++) {
        const m = ttMetaList[i];
        const equiv = nativeApply(Native.getAttribute, m, ['http-equiv']);
        if (equiv && /^content-security-policy$/i.test(equiv) && ZP.requiresTrustedTypes(nativeApply(Native.getAttribute, m, ['content']))) { ttMetaEnforced = true; return true; }
      }
    } catch {}
    return false;
  }
  // The Trusted Types policies a blob or data worker started here inherits: those of the response header (the boot config) and of every
  // `<meta>` policy. The worker's bootstrap puts them in its own CSP.
  function ttInheritedPolicies() {
    const out = Array.isArray(boot.trustedTypesPolicies) ? boot.trustedTypesPolicies.slice() : [];
    try {
      const d = root.document;
      if (d && Native.documentGetElementsByTagName) {
        const metas = nativeApply(Native.documentGetElementsByTagName, d, ['meta']);
        for (let i = 0; i < metas.length; i++) {
          const equiv = nativeApply(Native.getAttribute, metas[i], ['http-equiv']);
          if (equiv && /^content-security-policy$/i.test(equiv)) for (const p of ZP.trustedTypesPolicies(nativeApply(Native.getAttribute, metas[i], ['content']))) out.push(p);
        }
      }
    } catch {}
    return out;
  }
  function ttIsTrusted(kind, v) {
    if (v === null || typeof v !== 'object') return false;
    const f = kind === 'HTML' ? Native.ttIsHTML : kind === 'Script' ? Native.ttIsScript : Native.ttIsScriptURL;
    try { return !!(f && nativeApply(f, Native.trustedTypes, [v])); } catch { return false; }
  }
  function ttText(kind, v) {
    const f = kind === 'HTML' ? Native.ttHTMLText : kind === 'Script' ? Native.ttScriptText : Native.ttScriptURLText;
    return nativeApply(f, v, []);
  }
  // The `default` policy of a realm's trustedTypes (the main realm's unless given), or null.
  function ttDefaultPolicy(tt) {
    try { return Native.ttDefaultPolicy ? nativeApply(Native.ttDefaultPolicy, tt || Native.trustedTypes, []) : null; } catch { return null; }
  }
  // What a sink of `kind` named `sink` receives for the page's `value`: a Trusted* value gives its string; in a document that enforces, a
  // string is passed through the page's `default` policy (refused, as natively, when there is none); otherwise `value` itself.
  function ttCompliant(kind, sink, value, via, tt) {
    if (ttIsTrusted(kind, value)) return ttText(kind, value);
    if (!ttEnforced()) return value;
    const dp = ttDefaultPolicy(tt);
    if (!dp) throw ttViolation(kind, sink, via);
    const create = kind === 'HTML' ? Native.ttCreateHTML : kind === 'Script' ? Native.ttCreateScript : Native.ttCreateScriptURL;
    const made = nativeApply(create, dp, [String(value), TT_KINDS[kind], sink]);
    if (made === null || made === undefined) throw ttViolation(kind, sink, via);
    const text = ttText(kind, made);
    // The engine refuses a compilation (`eval`, `Function`) whose text the policy changed; every other sink takes the policy's text. A policy that
    // answers null reads as an empty string here (the public API turns one into the other), which a compilation refuses the same way.
    if ((sink === 'eval' || sink === 'Function') && text !== String(value)) throw ttViolation(kind, sink, via);
    return text;
  }
  // `Reflect.construct(Function, args)` for source the membrane built itself. Chrome's Function constructor takes no Trusted* arguments, so in a
  // document that enforces Trusted Types the function is made by evaluating the source the constructor would have compiled as a TrustedScript.
  function ttFunction(args, evalFn, FunctionCtor) {
    if (!ttEnforced() || !ttPolicy()) return Reflect.construct(FunctionCtor || Native.FunctionCtor, args);
    const parts = new Array(args.length);
    for (let i = 0; i < args.length; i++) parts[i] = String(args[i]);
    const body = parts.length ? parts[parts.length - 1] : '';
    return nativeApply(evalFn || Native.globalEval, undefined, [ttScript('(function anonymous(' + parts.slice(0, -1).join(',') + '\n) {\n' + body + '\n})')]);
  }

  // Which attributes set through setAttribute / setAttributeNS are script or markup sinks: an event handler, an iframe's srcdoc, a script's src.
  function ttAttributeSink(el, key) {
    if (key.length > 2 && key.charCodeAt(0) === 111 && key.charCodeAt(1) === 110 && key in el) return ['Script', 'Element ' + key];
    if (key === 'srcdoc' && el.localName === 'iframe') return ['HTML', 'HTMLIFrameElement srcdoc'];
    if (key === 'src' && el.localName === 'script') return ['ScriptURL', 'HTMLScriptElement src'];
    return null;
  }
  // The value a page's setAttribute call gives such an attribute: checked the way its property would be.
  function ttAttributeValue(el, key, v, via, tt) {
    const sink = ttAttributeSink(el, key);
    return sink ? ttCompliant(sink[0], sink[1], v, via, tt) : v;
  }
  // The trustedTypes of the window a node belongs to (a frame has its own default policy), or of the given window.
  function ttOfWindow(w) { try { return w.trustedTypes; } catch { return undefined; } }
  function ttOfNode(node) { try { return ttOfWindow(node.ownerDocument.defaultView); } catch { return undefined; } }
  // The natives the membrane calls with strings it built itself take Trusted* values where the document enforces Trusted Types, and accept them
  // where it does not. What the page passes to the wrapped sinks is checked before it gets here (ttCompliant).
  function ttWrapNatives(N) {
    const arg = (fn, index, make) => typeof fn !== 'function' ? fn : function () {
      const n = arguments.length, args = new Array(n);
      for (let i = 0; i < n; i++) args[i] = arguments[i];
      if (n > index && typeof args[index] === 'string') args[index] = make(args[index]);
      return nativeApply(fn, this, args);
    };
    // setAttribute(name, value) and setAttributeNS(ns, name, value)
    const attr = (fn, valueIndex) => typeof fn !== 'function' ? fn : function () {
      const n = arguments.length, args = new Array(n);
      for (let i = 0; i < n; i++) args[i] = arguments[i];
      if (n > valueIndex && typeof args[valueIndex] === 'string') {
        const sink = ttAttributeSink(this, String(args[valueIndex - 1]).toLowerCase());
        if (sink) args[valueIndex] = sink[0] === 'HTML' ? ttHTML(args[valueIndex]) : sink[0] === 'Script' ? ttScript(args[valueIndex]) : ttScriptURL(args[valueIndex]);
      }
      return nativeApply(fn, this, args);
    };
    // A setter that takes TrustedHTML, or TrustedScript when its receiver is a script element.
    const setter = (d, make, onlyScript) => !d || typeof d.set !== 'function' ? d : {
      get: d.get, enumerable: d.enumerable, configurable: d.configurable,
      set(v) { return nativeApply(d.set, this, [typeof v === 'string' && (!onlyScript || this.localName === 'script') ? make(v) : v]); },
    };
    N.setAttribute = attr(N.setAttribute, 1);
    N.setAttributeNS = attr(N.setAttributeNS, 2);
    N.insertAdjacentHTML = arg(N.insertAdjacentHTML, 1, ttHTML);
    N.DOMParserParseFromString = arg(N.DOMParserParseFromString, 0, ttHTML);
    N.rangeCreateContextualFragment = arg(N.rangeCreateContextualFragment, 0, ttHTML);
    N.elementInnerHTML = setter(N.elementInnerHTML, ttHTML, false);
    N.elementOuterHTML = setter(N.elementOuterHTML, ttHTML, false);
    N.scriptText = setter(N.scriptText, ttScript, false);
    N.nodeTextContent = setter(N.nodeTextContent, ttScript, true);
  }

  // The source text `eval` runs for its argument in the realm whose trustedTypes is `tt`: a Trusted value's string, a string after the
  // page's default policy, or null for anything else (which `eval` returns as it is).
  function ttEvalSource(x, sink, tt) {
    if (typeof x === 'string') return ttCompliant('Script', sink || 'eval', x, '', tt);
    return ttIsTrusted('Script', x) ? ttText('Script', x) : null;
  }
