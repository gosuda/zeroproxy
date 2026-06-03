import {
  dynamicSource,
  isEvalExpressionCandidate,
  simpleDynamicValue,
  stringArgs,
} from './source.mjs';

export function createDynamicCodeFacade({
  root,
  Native,
  dynamicCompileAllowed,
  normalizedError,
  getVirtualURL,
  getScope,
  define,
  defineReplacingNative,
  maskNativeFunction,
  toStringMap,
}) {
  const NativeAsyncFunction = (async function(){}).constructor;
  const NativeGeneratorFunction = (function*(){}).constructor;
  const NativeAsyncGeneratorFunction = (async function*(){}).constructor;
  const dynamicFunction = function Function(...args) {
    return compileDynamic(Native.FunctionCtor, args, 'function');
  };
  const dynamicAsyncFunction = function AsyncFunction(...args) {
    return compileDynamic(NativeAsyncFunction, args, 'async');
  };
  const dynamicGeneratorFunction = function GeneratorFunction(...args) {
    return compileDynamic(NativeGeneratorFunction, args, 'generator');
  };
  const dynamicAsyncGeneratorFunction = function AsyncGeneratorFunction(...args) {
    return compileDynamic(NativeAsyncGeneratorFunction, args, 'asyncGenerator');
  };
  const dynamicConstructorWrappers = new Map([
    [Native.FunctionCtor, dynamicFunction],
    [dynamicFunction, dynamicFunction],
    [NativeAsyncFunction, dynamicAsyncFunction],
    [dynamicAsyncFunction, dynamicAsyncFunction],
    [NativeGeneratorFunction, dynamicGeneratorFunction],
    [dynamicGeneratorFunction, dynamicGeneratorFunction],
    [NativeAsyncGeneratorFunction, dynamicAsyncGeneratorFunction],
    [dynamicAsyncGeneratorFunction, dynamicAsyncGeneratorFunction],
  ]);

  function compileSimpleDynamic(params, body, kind) {
    if (params.length || kind !== 'function') return null;
    const m = /^return\s+([\s\S]*?);?$/.exec(String(body || '').trim());
    if (!m) return null;
    const fn = function anonymous() { return simpleDynamicValue(m[1], getVirtualURL()); };
    toStringMap.set(fn, dynamicSource(kind, params, body));
    return fn;
  }

  function compileTimerString(source) {
    const text = String(source || '');
    return function anonymous() { return runScopedNativeEval(text); };
  }

  function compileDynamic(ctor, args, kind) {
    const parts = stringArgs(args);
    const body = parts.length ? parts[parts.length - 1] : '';
    const params = parts.slice(0, -1);
    if (!dynamicCompileAllowed) throw normalizedError('SecurityError');
    const simple = compileSimpleDynamic(params, body, kind);
    if (simple) return simple;
    const rewritten = rewriteDynamicFunctionBody(params, body);
    const fn = Reflect.construct(ctor, params.concat(rewritten));
    toStringMap.set(fn, dynamicSource(kind, params, body));
    return fn;
  }

  function dynamicEval(source) {
    if (arguments.length === 0) return undefined;
    if (!dynamicCompileAllowed) throw normalizedError('SecurityError');
    return runScopedNativeEval(String(source));
  }

  function runScopedNativeEval(text) {
    if (typeof Native.eval !== 'function') throw normalizedError('NotSupportedError');
    const previous = root.__ZP_EVAL_SCOPE;
    const hadPrevious = Object.hasOwn(root, '__ZP_EVAL_SCOPE');
    Object.defineProperty(root, '__ZP_EVAL_SCOPE', {
      value: getScope(),
      enumerable: false,
      configurable: true,
      writable: true,
    });
    try {
      const expr = isEvalExpressionCandidate(text) ? `(${text})` : text;
      return (0, Native.eval)(`with(__ZP_EVAL_SCOPE){${expr}\n}`);
    } finally {
      restoreEvalScope(previous, hadPrevious);
    }
  }

  function restoreEvalScope(previous, hadPrevious) {
    try {
      if (hadPrevious) {
        Object.defineProperty(root, '__ZP_EVAL_SCOPE', {
          value: previous,
          enumerable: false,
          configurable: true,
          writable: true,
        });
      } else {
        delete root.__ZP_EVAL_SCOPE;
      }
    } catch {}
  }

  function setDynamicConstructorIdentity(fn, name, proto) {
    try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch {}
    try { Object.defineProperty(fn, 'length', { value: 1, configurable: true }); } catch {}
    if (proto) {
      try {
        Object.defineProperty(fn, 'prototype', {
          value: proto,
          enumerable: false,
          configurable: false,
          writable: false,
        });
      } catch {}
    }
    maskNativeFunction(fn, name);
  }

  function dynamicWrapperFor(value) {
    return dynamicConstructorWrappers.get(value) || null;
  }

  function dynamicGlobal(name) {
    if (name === 'eval') return dynamicEval;
    if (name === 'Function') return dynamicFunction;
    if (name === 'AsyncFunction') return dynamicAsyncFunction;
    if (name === 'GeneratorFunction') return dynamicGeneratorFunction;
    if (name === 'AsyncGeneratorFunction') return dynamicAsyncGeneratorFunction;
    if (name === 'origin') return getVirtualURL().origin;
    return null;
  }

  function isDynamicConstructor(ctor) {
    return (
      ctor === Native.FunctionCtor ||
      ctor === NativeAsyncFunction ||
      ctor === NativeGeneratorFunction ||
      ctor === NativeAsyncGeneratorFunction ||
      dynamicWrapperFor(ctor)
    );
  }

  function rewriteDynamicFunctionBody(params, body) {
    if (!root.ZPHTTPRewriter || typeof root.ZPHTTPRewriter.rewriteFunctionBody !== 'function') {
      throw normalizedError('NotSupportedError');
    }
    return root.ZPHTTPRewriter.rewriteFunctionBody(
      String(body || ''),
      params,
      getVirtualURL().href,
      root.ZP && root.ZP.CONTROL_PREFIX,
    );
  }

  function installDynamicCodeHooks() {
    setDynamicConstructorIdentity(
      dynamicFunction,
      'Function',
      Native.FunctionCtor && Native.FunctionCtor.prototype,
    );
    setDynamicConstructorIdentity(
      dynamicAsyncFunction,
      'AsyncFunction',
      NativeAsyncFunction && NativeAsyncFunction.prototype,
    );
    setDynamicConstructorIdentity(
      dynamicGeneratorFunction,
      'GeneratorFunction',
      NativeGeneratorFunction && NativeGeneratorFunction.prototype,
    );
    setDynamicConstructorIdentity(
      dynamicAsyncGeneratorFunction,
      'AsyncGeneratorFunction',
      NativeAsyncGeneratorFunction && NativeAsyncGeneratorFunction.prototype,
    );
    try { Object.defineProperty(dynamicEval, 'name', { value: 'eval', configurable: true }); } catch {}
    try { Object.defineProperty(dynamicEval, 'length', { value: 1, configurable: true }); } catch {}
    maskNativeFunction(dynamicEval, 'eval');
    defineReplacingNative(root, 'eval', dynamicEval);
    defineReplacingNative(root, 'Function', dynamicFunction);
    installDynamicConstructorBackrefs();
    if (Native.setTimeout) {
      defineReplacingNative(root, 'setTimeout', function(handler, delay, ...args) {
        return Native.setTimeout(typeof handler === 'string' ? compileTimerString(handler) : handler, delay, ...args);
      });
    }
    if (Native.setInterval) {
      defineReplacingNative(root, 'setInterval', function(handler, delay, ...args) {
        return Native.setInterval(typeof handler === 'string' ? compileTimerString(handler) : handler, delay, ...args);
      });
    }
  }

  function installDynamicConstructorBackrefs() {
    for (const [ctor, wrapper] of dynamicConstructorWrappers) {
      if (!ctor || !ctor.prototype) continue;
      try {
        Object.defineProperty(ctor.prototype, 'constructor', {
          value: wrapper,
          enumerable: false,
          configurable: true,
          writable: true
        });
      } catch {}
    }
  }

  return Object.freeze({
    dynamicFunction,
    dynamicGlobal,
    dynamicWrapperFor,
    installDynamicCodeHooks,
    isDynamicConstructor,
  });
}
