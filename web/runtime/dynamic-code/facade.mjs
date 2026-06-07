import {
  dynamicSource,
  simpleDynamicValue,
  stringArgs,
} from './source.mjs';

export function createDynamicCodeFacade({
  root,
  Native,
  dynamicCompileAllowed,
  normalizedError,
  getVirtualURL,
  rewriteScriptSource,
  define,
  defineReplacingNative,
  maskNativeFunction,
  toStringMap,
}) {
  const {
    Array = globalThis.Array,
    Map = globalThis.Map,
    String = globalThis.String,
    objectDefineProperty = globalThis.Object.defineProperty,
    objectFreeze = globalThis.Object.freeze,
    reflectConstruct = globalThis.Reflect && globalThis.Reflect.construct,
  } = Native;
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
    return function anonymous() { return runRewrittenNativeEval(text); };
  }

  function compileDynamic(ctor, args, kind) {
    const parts = stringArgs(args);
    const body = parts.length ? parts[parts.length - 1] : '';
    const params = parts.slice(0, -1);
    if (!dynamicCompileAllowed) throw normalizedError('SecurityError');
    const simple = compileSimpleDynamic(params, body, kind);
    if (simple) return simple;
    const rewritten = rewriteDynamicFunctionBody(params, body);
    const ctorArgs = new Array(params.length + 1);
    for (let i = 0; i < params.length; i += 1) ctorArgs[i] = params[i];
    ctorArgs[params.length] = rewritten;
    const fn = reflectConstruct(ctor, ctorArgs);
    toStringMap.set(fn, dynamicSource(kind, params, body));
    return fn;
  }

  function runRewrittenNativeEval(text) {
    if (typeof Native.eval !== 'function') throw normalizedError('NotSupportedError');
    if (typeof rewriteScriptSource !== 'function') throw normalizedError('NotSupportedError');
    return (0, Native.eval)(rewriteScriptSource(String(text || ''), 'classic'));
  }

  function setDynamicConstructorIdentity(fn, name, proto) {
    try { objectDefineProperty(fn, 'name', { value: name, configurable: true }); } catch {}
    try { objectDefineProperty(fn, 'length', { value: 1, configurable: true }); } catch {}
    if (proto) {
      try {
        objectDefineProperty(fn, 'prototype', {
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
        objectDefineProperty(ctor.prototype, 'constructor', {
          value: wrapper,
          enumerable: false,
          configurable: true,
          writable: true
        });
      } catch {}
    }
  }

  return objectFreeze({
    dynamicFunction,
    dynamicGlobal,
    dynamicWrapperFor,
    installDynamicCodeHooks,
    isDynamicConstructor,
  });
}
