const NativeArray = Array;
const NativeNumber = Number;
const NativeRegExp = RegExp;
const NativeReflectApply = Reflect.apply;
const NativeString = String;
const nativeArrayJoin = Array.prototype.join;
const nativeStringReplace = String.prototype.replace;
const nativeStringTrim = String.prototype.trim;
const nativeStringTrimStart = String.prototype.trimStart;

export function stringArgs(args) {
  const out = new NativeArray(args.length);
  for (let i = 0; i < args.length; i++) out[i] = NativeString(args[i]);
  return out;
}

export function simpleDynamicValue(expr, virtualURL) {
  const text = NativeReflectApply(nativeStringReplace, NativeReflectApply(nativeStringTrim, NativeString(expr || ''), []), [/;+\s*$/, '']);
  if (
    text === 'location.href' ||
    text === 'window.location.href' ||
    text === 'self.location.href' ||
    text === 'globalThis.location.href'
  )
    return virtualURL.href;
  if (text === 'location.origin' || text === 'window.location.origin') return virtualURL.origin;
  if (text === 'location.hash' || text === 'window.location.hash') return virtualURL.hash;
  if (new NativeRegExp('^-?\\d+(?:\\.\\d+)?$').test(text)) return NativeNumber(text);
  const quoted = new NativeRegExp("^(['\"])([\\s\\S]*)\\1$").exec(text);
  if (quoted) return quoted[2];
  return undefined;
}

export function dynamicSource(kind, params, body) {
  const prefix =
    kind === 'async'
      ? 'async function'
      : kind === 'generator'
        ? 'function*'
        : kind === 'asyncGenerator'
          ? 'async function*'
          : 'function';
  return `${prefix} anonymous(${NativeReflectApply(nativeArrayJoin, params, [','])}\n) {\n${body}\n}`;
}

export function isEvalExpressionCandidate(text) {
  return !new NativeRegExp('^(?:function|class|var|let|const|if|for|while|do|switch|try|throw|return|break|continue|with|import|export|debugger)\\b').test(
    NativeReflectApply(nativeStringTrimStart, text, []),
  );
}
