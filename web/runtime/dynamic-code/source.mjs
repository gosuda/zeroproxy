export function stringArgs(args) {
  const out = new Array(args.length);
  for (let i = 0; i < args.length; i++) out[i] = String(args[i]);
  return out;
}

export function simpleDynamicValue(expr, virtualURL) {
  const text = String(expr || '')
    .trim()
    .replace(/;+\s*$/, '');
  if (
    text === 'location.href' ||
    text === 'window.location.href' ||
    text === 'self.location.href' ||
    text === 'globalThis.location.href'
  )
    return virtualURL.href;
  if (text === 'location.origin' || text === 'window.location.origin') return virtualURL.origin;
  if (text === 'location.hash' || text === 'window.location.hash') return virtualURL.hash;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const quoted = /^(['"])([\s\S]*)\1$/.exec(text);
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
  return `${prefix} anonymous(${params.join(',')}\n) {\n${body}\n}`;
}

export function isEvalExpressionCandidate(text) {
  return !/^(?:function|class|var|let|const|if|for|while|do|switch|try|throw|return|break|continue|with|import|export|debugger)\b/.test(
    text.trimStart(),
  );
}
