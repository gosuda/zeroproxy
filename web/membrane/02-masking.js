
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
  // Run internal DOM queries through captured native methods so page wrappers on
  // querySelectorAll cannot observe or filter membrane scans.
  function qsaOf(node, selector) {
    const t = node && node.nodeType;
    const f = t === 9 ? Native.querySelectorAll : t === 11 ? Native.fragmentQuerySelectorAll : t === 1 ? Native.elementQuerySelectorAll : null;
    return typeof f === 'function' ? Reflect.apply(f, node, [selector]) : [];
  }
  function nameLike(fn, name) {
    if (typeof fn !== 'function' || fn.name === name) return;
    try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch {}
  }
  function maskNativeFunction(fn, key) {
    if (typeof fn !== 'function') return;
    toStringMap.set(fn, nativeFunctionSource(key));
    if (typeof key === 'string') nameLike(fn, key);
  }
  function maskAccessorFn(fn, kind, key) {
    toStringMap.set(fn, nativeAccessorSource(kind, key));
    if (typeof key === 'string') nameLike(fn, kind + ' ' + key);
  }
  // Preserve the replaced native function's arity on the membrane wrapper.
  function lengthLike(ours, native) {
    if (typeof ours !== 'function' || typeof native !== 'function' || ours.length === native.length) return;
    try { Object.defineProperty(ours, 'length', { value: native.length, configurable: true }); } catch {}
  }
  function maskMethods(obj, keys) {
    for (const key of keys) maskNativeFunction(obj && obj[key], key);
  }
  // Inherit enumerability from the replaced property so WebIDL members stay
  // enumerable while membrane-internal helpers stay hidden.
  //
  // A method hook that replaces a native method in place keeps the native's `configurable` bit, so a page that wraps or redefines the method with `Object.defineProperty`
  // (Google redefines `setInterval`, and `Object.defineProperty(window, 'fetch', …)` is a common instrumentation) behaves as it does natively. The page could already replace
  // such a method by assignment (it is writable), so redefining or deleting it gives it nothing more; deleting exposes nothing, the native function is gone from the slot. A
  // hook stays non-configurable where something remains underneath it, because deleting it would uncover that: a new own property (the prototype's member shows through) and a
  // name an ancestor in the prototype chain also has. Accessor hooks (`innerHTML`, `cookie`, `contentWindow`, `src`, …) stay non-configurable: the membrane reads some of
  // them through the page-facing property, and a getter the page installs in their place would answer for them. The exceptions are listed in `REDEFINABLE_ACCESSORS`: accessors
  // the membrane never reads or writes through the page-facing property (it keeps the native descriptor from boot), so a page getter in their place answers for no one but the
  // page. Add one only after checking the membrane for `.name` reads, `[name]` reads and `Reflect.get`. `propertyLocked` knows hooks by this registry as well, since their
  // descriptors no longer tell them apart.
  //
  // `innerText` on `HTMLElement.prototype`: YouTube wraps it (`Object.defineProperty(HTMLElement.prototype, "innerText", { configurable: true, get: g.get, set: wrapper })`),
  // and the `TypeError` stopped its bundle.
  const REDEFINABLE_ACCESSORS = newSet(['innerText']);
  function registerHook(obj, key) {
    let keys = installedHooks.get(obj);
    if (!keys) { keys = newSet(); installedHooks.set(obj, keys); }
    keys.add(key);
  }
  function ancestorHasKey(obj, key) {
    try {
      for (let p = Reflect.getPrototypeOf(obj); p; p = Reflect.getPrototypeOf(p)) if (Reflect.getOwnPropertyDescriptor(p, key)) return true;
    } catch { return true; }
    return false;
  }
  function hookConfigurable(prev, obj, key) {
    return !!prev && prev.configurable === true && ('value' in prev || REDEFINABLE_ACCESSORS.has(key)) && !ancestorHasKey(obj, key);
  }
  // A descriptor that asks for `configurable: false` over a native method (or one of the listed accessors) that was configurable gets the native's bit back (and the hook is
  // registered), on the same terms.
  function nativeConfigurable(obj, key, desc) {
    if (!desc || desc.configurable !== false || !('value' in desc || REDEFINABLE_ACCESSORS.has(key)) || !hookConfigurable(Object.getOwnPropertyDescriptor(obj, key), obj, key)) return desc;
    registerHook(obj, key);
    return Object.assign({}, desc, { configurable: true });
  }
  function nativeEnumerability(obj, key) {
    try {
      const d = Object.getOwnPropertyDescriptor(obj, key);
      return !!(d && d.enumerable);
    } catch { return false; }
  }
  function define(obj, key, value) {
    try {
      const own = Object.getOwnPropertyDescriptor(obj, key);
      const prev = typeof value === 'function' ? own : null;
      // Capture the existing own or inherited function to copy its length and prototype.
      let inherited = null;
      if (typeof value === 'function' && !prev) { try { inherited = Reflect.get(obj, key); } catch {} }
      const configurable = hookConfigurable(own, obj, key);
      Object.defineProperty(obj, key, { value, enumerable: nativeEnumerability(obj, key), configurable, writable: true });
      if (configurable) registerHook(obj, key);
      if (prev && typeof prev.value === 'function') lengthLike(value, prev.value);
      else if (typeof inherited === 'function' && inherited !== value) lengthLike(value, inherited);
      // `maskNativeFunction` names the wrapper after its key, which the minifier would otherwise have renamed.
      maskNativeFunction(value, key);
      return true;
    } catch { return false; }
  }
  // Copy enumerability from `enumSrc` when defining accessors on a freshly
  // constructed replacement prototype.
  function defineAccessor(obj, key, get, set, enumSrc) {
    try {
      Object.defineProperty(obj, key, { get, set, enumerable: nativeEnumerability(enumSrc || obj, key), configurable: false });
      if (typeof get === 'function') maskAccessorFn(get, 'get', key);
      if (typeof set === 'function') maskAccessorFn(set, 'set', key);
      return true;
    } catch { return false; }
  }
  // Install a property descriptor while registering any function value, getter,
  // or setter in Function.prototype.toString masking.
  function defineMasked(obj, key, desc) {
    try { Object.defineProperty(obj, key, nativeConfigurable(obj, key, desc)); } catch { return false; }
    if (typeof desc.value === 'function' && typeof key === 'string') nameLike(desc.value, key);
    if (typeof desc.get === 'function') maskAccessorFn(desc.get, 'get', key);
    if (typeof desc.set === 'function') maskAccessorFn(desc.set, 'set', key);
    return true;
  }
  // Multi-property variant of defineMasked.
  function definePropertiesMasked(obj, descs) {
    try {
      const adjusted = {};
      for (const key of Reflect.ownKeys(descs)) adjusted[key] = descs[key] ? nativeConfigurable(obj, key, descs[key]) : descs[key];
      Object.defineProperties(obj, adjusted);
    } catch { return false; }
    for (const key of Object.getOwnPropertyNames(descs)) {
      const d = descs[key];
      if (!d) continue;
      if (typeof d.get === 'function') maskAccessorFn(d.get, 'get', key);
      if (typeof d.set === 'function') maskAccessorFn(d.set, 'set', key);
      if (typeof d.value === 'function') maskNativeFunction(d.value, key);
    }
    return true;
  }
  // Copy properties onto a replacement prototype and mask all methods and
  // accessors as native code.
  function assignMasked(proto, members) {
    Object.assign(proto, members);
    for (const key of Object.getOwnPropertyNames(members)) {
      if (key === 'constructor') continue;
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (!d) continue;
      if (typeof d.value === 'function') maskNativeFunction(d.value, key);
      if (typeof d.get === 'function') maskAccessorFn(d.get, 'get', key);
      if (typeof d.set === 'function') maskAccessorFn(d.set, 'set', key);
    }
    return proto;
  }
  // WebIDL interface members live on the prototype rather than the singleton
  // instance. Define the accessor on the prototype first and fall back to the
  // instance only if an own property shadows it.
  function defineOnProto(instance, proto, key, get, set) {
    if (proto && defineAccessor(proto, key, get, set)) {
      // Verify prototype installation via property descriptors rather than
      // invoking the getter, avoiding allocation comparison mismatches and
      // temporal dead zones during boot.
      try {
        const own = instance && Object.getOwnPropertyDescriptor(instance, key);
        const onProto = Object.getOwnPropertyDescriptor(proto, key);
        if (!instance || (!own && onProto && onProto.get === get)) return true;
      } catch {}
    }
    return defineAccessor(instance, key, get, set);
  }
  // Replace a native prototype accessor in place while preserving its native
  // setter, enumerability, and configurability.
  function replaceNativeAccessor(proto, key, getImpl) {
    const d = proto && Object.getOwnPropertyDescriptor(proto, key);
    if (!d || typeof d.get !== 'function') return false;
    const get = Object.getOwnPropertyDescriptor({ get [key]() { return getImpl.call(this); } }, key).get;
    return defineMasked(proto, key, { get, set: d.set, enumerable: d.enumerable, configurable: d.configurable });
  }
  // Define a method on the prototype first, falling back to the instance if shadowed.
  function defineMethodOnProto(instance, proto, key, value) {
    if (proto && define(proto, key, value)) {
      try { if (!instance || instance[key] === value) return true; } catch {}
    }
    return define(instance, key, value);
  }
  // Strip __zp_* and __ZP_EXEC_EVENT call wrappers from Function.prototype.toString
  // output on rewritten page functions. Re-compilation via new Function still
  // routes through compileNested and with(scope).
  function unrewriteSourceText(src) {
    if (typeof src !== 'string') return src;
    if (src.indexOf('__zp_') < 0 && src.indexOf('__ZP_EXEC_EVENT') < 0) return src;
    const ZP_SRC_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
    const ZP_SRC_SIMPLE = /^(this|[A-Za-z_$][A-Za-z0-9_$]*)(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
    // Elide only synthesized `globalThis` receivers; preserve explicit `window.`
    // or `self.` member accesses written by the author.
    const ZP_SRC_GLOBALS = newSet(['globalThis']);

    // Split a balanced argument list while ignoring delimiters inside string literals.
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

    // Unrewrite inline-guarded member reads, writes, and calls back to bracket syntax.
    function zpSrcGuard(s, i) {
      const sp = zpSrcSplitArgs(s, i);
      if (!sp) return null;
      const parts = sp[0], next = sp[1] + 1;
      // `(0,x)` prevents function or class expressions from adopting the temporary variable name.
      const temp = /^\s*__zp_t_\d+=\(0,([\s\S]*)\)\s*$/;
      const o = temp.exec(parts[0] || ''), k = temp.exec(parts[1] || '');
      if (!o || !k) return null;
      const member = unrewriteSource(o[1]).trim() + '[' + unrewriteSource(k[1]).trim() + ']';
      if (parts.length === 4) {
        const v = temp.exec(parts[2]);
        return v && /^__zp_fastset\(/.test(parts[3]) ? [member + '=' + unrewriteSource(v[1]).trim(), next] : null;
      }
      if (parts.length !== 3 || !/^__zp_fast\(/.test(parts[2])) return null;
      const call = /^__zp_fast\((__zp_t_\d+),(__zp_t_\d+)\)\?\1\[\2\]\(/.exec(parts[2]);
      if (!call) return [member, next];
      const args = zpSrcSplitArgs(parts[2], call[0].length - 1);
      return args ? [member + '(' + unrewriteSource(args[0].join(',')).trim() + ')', next] : null;
    }

    function zpSrcLiteral(a) {
      const t = a.trim();
      if (t.length < 2) return null;
      const q = t[0];
      if ((q !== '"' && q !== "'") || t[t.length - 1] !== q) return null;
      const body = t.slice(1, -1);
      if (body.indexOf(q) >= 0 || body.indexOf('\\') >= 0) return null;
      return body;
    }

    // Wrap non-simple base expressions in parentheses to preserve operator precedence.
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
        // Preserve string literals verbatim.
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
        // Recursively unrewrite expressions inside template literal `${...}` substitutions.
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
        // Strip the synthesized `with` block helper prologue.
        if (c === 'c' && s.startsWith(ZP_WITH_PROLOGUE, i)) { i += ZP_WITH_PROLOGUE.length; continue; }
        // Strip inline member guards and trailing temporary variable declarations.
        if (c === '(' && s.startsWith('(__zp_t_', i)) {
          const g = zpSrcGuard(s, i);
          if (g) { out += g[0]; i = g[1]; continue; }
        }
        if (c === '\n' && s.startsWith('\n;var __zp_t_', i)) {
          const tail = /^\n;var __zp_t_\d+(?:,__zp_t_\d+)*;/.exec(s.slice(i, i + 8192));
          if (tail) { i += tail[0].length; continue; }
        }
        // Recover original inline event handler source from the third argument of __ZP_EXEC_EVENT.
        const evHead = c === '(' && s.startsWith(ZP_EVENT_CALL_HEAD, i) ? ZP_EVENT_CALL_HEAD.length : 0;
        if (c !== '_' && !evHead) { out += c; i++; continue; }
        const prev = i > 0 ? s[i - 1] : '';
        if (!evHead && prev && /[A-Za-z0-9_$.]/.test(prev)) { out += c; i++; continue; }
        const ev = evHead ? [ZP_EVENT_CALL_HEAD] : /^__ZP_EXEC_EVENT\(/.exec(s.slice(i));
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
        // Restore loop-cap instrumentation (`__zp_lc_*`) to `for(;;)` or `while(true)`.
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
    // Cache unrewritten source strings by function reference and source text.
    const unrewrittenByFn = newWeakMap();
    const unrewrittenByText = newMap();
    let unrewrittenChars = 0;
    const maskedToString = function toString() {
      const isFn = typeof this === 'function';
      if (isFn) {
        const mapped = toStringMap.get(this);
        if (mapped !== undefined) return mapped;
        const kept = unrewrittenByFn.get(this);
        if (kept !== undefined) return kept;
      }
      const text = nativeApply(orig, this, []);
      if (typeof text !== 'string' || (text.indexOf('__zp_') < 0 && text.indexOf('__ZP_EXEC_EVENT') < 0)) return text;
      let out = unrewrittenByText.get(text);
      if (out === undefined) {
        out = unrewriteSourceText(text);
        if (text.length <= 262144) {
          if (unrewrittenChars + text.length > 8388608) { unrewrittenByText.clear(); unrewrittenChars = 0; }
          unrewrittenByText.set(text, out);
          unrewrittenChars += text.length;
        }
      }
      if (isFn) unrewrittenByFn.set(this, out);
      return out;
    };
    toStringMap.set(maskedToString, 'function toString() { [native code] }');
    nameLike(maskedToString, 'toString');
    try {
      Object.defineProperty(proto, 'toString', { value: maskedToString, enumerable: false, configurable: true, writable: true });
      toStringMaskedPrototypes.add(proto);
    } catch {}
  }
  // Expose replacement class state as prototype accessors backed by `_zp*`
  // instance slots to match native WebIDL prototype shapes.
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
  // Set constructor `.name`, `Symbol.toStringTag`, and static interface
  // constants to match native WebIDL class shapes.
  function brandLikeNative(ctor, proto, name) {
    nameLike(ctor, name);
    try { if (proto) Object.defineProperty(proto, Symbol.toStringTag, { value: name, configurable: true }); } catch {}
    adoptNativeShape(ctor, proto, name);
  }
  // Copy constructor arity, static constants, and method lengths from the
  // replaced native class.
  function adoptNativeShape(ctor, proto, name) {
    try {
      const d = Object.getOwnPropertyDescriptor(root, name);
      const nat = d && typeof d.value === 'function' ? d.value : null;
      if (!ctor || !nat || nat === ctor) return;
      lengthLike(ctor, nat);
      for (const key of Reflect.ownKeys(nat)) {
        if (key === 'prototype' || key === 'length' || key === 'name') continue;
        const nd = Object.getOwnPropertyDescriptor(nat, key);
        const od = Object.getOwnPropertyDescriptor(ctor, key);
        if (!od) {
          if (typeof nd.value === 'function') {
            const member = function () { return Reflect.apply(nd.value, nat, arguments); };
            if (typeof key === 'string') { nameLike(member, key); maskNativeFunction(member, key); }
            lengthLike(member, nd.value);
            Object.defineProperty(ctor, key, { value: member, writable: nd.writable, enumerable: nd.enumerable, configurable: nd.configurable });
          } else if ('value' in nd) {
            Object.defineProperty(ctor, key, nd);
          }
        } else if (typeof od.value === 'function' && typeof nd.value === 'function') {
          lengthLike(od.value, nd.value);
        }
      }
      if (proto && nat.prototype) {
        for (const key of Reflect.ownKeys(nat.prototype)) {
          if (key === 'constructor') continue;
          const nd = Object.getOwnPropertyDescriptor(nat.prototype, key);
          const od = Object.getOwnPropertyDescriptor(proto, key);
          if (od && typeof od.value === 'function' && typeof nd.value === 'function') lengthLike(od.value, nd.value);
        }
      }
    } catch {}
  }
  // Scope SharedWorker names by the FNV-1a hash of virtualURL.origin so
  // distinct target origins sharing the physical proxy origin do not attach to
  // the same SharedWorker instance.
  function sharedWorkerNamePrefix() {
    const key = virtualURL.origin;
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
    return 'zp:w:' + ('00000000' + (h >>> 0).toString(16)).slice(-8) + ':';
  }
  // Normalize the string or dictionary second argument of
  // `new SharedWorker(url, options)` and prepend the target-origin prefix.
  function prefixedSharedWorkerOptions(prefix, opts) {
    if (typeof opts === 'string') return { name: prefix + opts };
    const o = opts && typeof opts === 'object' ? Object.assign({}, opts) : {};
    o.name = prefix + (o.name === undefined ? '' : String(o.name));
    return o;
  }
  let sharedEventTargetProto = null;
  function eventTargetProto() {
    if (sharedEventTargetProto) return sharedEventTargetProto;
    // Inherit from EventTarget.prototype so `instanceof EventTarget` holds
    // while shadowing addEventListener, removeEventListener, and dispatchEvent
    // on a shared intermediate prototype.
    let base = Object.prototype;
    try { if (typeof EventTarget === 'function' && EventTarget.prototype) base = EventTarget.prototype; } catch {}
    const p = Object.create(base);
    define(p, 'addEventListener', function(type, fn) { if (!fn) return; const key = String(type); if (!this[listenersKey]) this[listenersKey] = newMap(); const list = this[listenersKey].get(key) || []; list.push(fn); this[listenersKey].set(key, list); });
    define(p, 'removeEventListener', function(type, fn) { const list = this[listenersKey] && this[listenersKey].get(String(type)); if (!list) return; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); });
    define(p, 'dispatchEvent', function(event) { const list = this[listenersKey] && this[listenersKey].get(event.type) || []; try { if (!event.target) Object.defineProperty(event, 'target', { value: this, configurable: true }); } catch {} const handler = this['on' + event.type]; if (typeof handler === 'function') handler.call(this, event); for (const fn of list.slice()) fn.call(this, event); return !event.defaultPrevented; });
    sharedEventTargetProto = p;
    return p;
  }
  function installEventMethods(proto) {
    if (!proto) return;
    try { Object.setPrototypeOf(proto, eventTargetProto()); } catch {}
  }