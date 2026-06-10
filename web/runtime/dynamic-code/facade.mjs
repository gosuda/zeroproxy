
export function createDynamicCodeFacade({
  root,
  Native,
  dynamicCompileAllowed,
  normalizedError,
  getVirtualURL,
  define,
  defineReplacingNative,
  maskNativeFunction,
}) {
  const {
    objectDefineProperty = globalThis.Object.defineProperty,
    objectFreeze = globalThis.Object.freeze,
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


  function compileTimerString() {
    return function anonymous() { throw normalizedError('NotSupportedError'); };
  }

  function compileDynamic(_ctor, _args, _kind) {
    if (!dynamicCompileAllowed) throw normalizedError('SecurityError');
    throw normalizedError('NotSupportedError');
  }

  function runRewrittenNativeEval() {
    throw normalizedError('NotSupportedError');
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
