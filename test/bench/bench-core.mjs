// Shared logic for Node and browser URL classification benchmarks.
// Contains no Node I/O imports so it can be loaded directly into a browser realm.

export const UrlClass = Object.freeze({
  INVALID: 0, HTTP: 1, WS: 2, BLOB: 3, DATA: 4,
  JAVASCRIPT: 5, VBSCRIPT: 6, ABOUT_BLANK: 7, ABOUT_OTHER: 8,
  RELATIVE: 9, OTHER: 10,
});

// JS regex baseline matching the WASM UrlClass enum.
const SCHEME_RE = /^[\s\x0c]*([A-Za-z][A-Za-z0-9+.\-]*):/;
export function classifyJsRegex(raw) {
  const s = String(raw);
  if (s.length === 0) return UrlClass.INVALID;
  const m = SCHEME_RE.exec(s);
  if (!m) {
    const trimmed = s.replace(/^[\s\x0c]+|[\s\x0c]+$/g, '');
    return trimmed.length === 0 ? UrlClass.INVALID : UrlClass.RELATIVE;
  }
  const scheme = m[1].toLowerCase();
  switch (scheme) {
    case 'http': case 'https': return UrlClass.HTTP;
    case 'ws': case 'wss': return UrlClass.WS;
    case 'blob': return UrlClass.BLOB;
    case 'data': return UrlClass.DATA;
    case 'javascript': return UrlClass.JAVASCRIPT;
    case 'vbscript': return UrlClass.VBSCRIPT;
    case 'about': {
      const rest = s.slice(m[0].length).replace(/^[\s\x0c]+|[\s\x0c]+$/g, '');
      return rest === 'blank' ? UrlClass.ABOUT_BLANK : UrlClass.ABOUT_OTHER;
    }
    default: return UrlClass.OTHER;
  }
}

// URL constructor baseline.
export function classifyJsURL(raw) {
  const s = String(raw);
  if (s.length === 0) return UrlClass.INVALID;
  try {
    const u = new URL(s, 'http://example.invalid/');
    switch (u.protocol) {
      case 'http:': case 'https:': return UrlClass.HTTP;
      case 'ws:': case 'wss:': return UrlClass.WS;
      case 'blob:': return UrlClass.BLOB;
      case 'data:': return UrlClass.DATA;
      case 'javascript:': return UrlClass.JAVASCRIPT;
      case 'vbscript:': return UrlClass.VBSCRIPT;
      case 'about:': return u.pathname === 'blank' ? UrlClass.ABOUT_BLANK : UrlClass.ABOUT_OTHER;
      default: return UrlClass.OTHER;
    }
  } catch { return UrlClass.INVALID; }
}

// Prefix startsWith chain baseline.
export function classifyJsStartsWith(raw) {
  const s = String(raw);
  if (s.length === 0) return UrlClass.INVALID;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) break;
    i++;
  }
  if (i === s.length) return UrlClass.INVALID;
  const head = (i === 0 ? s : s.slice(i)).slice(0, 12).toLowerCase();
  if (head.startsWith('https:')) return UrlClass.HTTP;
  if (head.startsWith('http:')) return UrlClass.HTTP;
  if (head.startsWith('javascript:')) return UrlClass.JAVASCRIPT;
  if (head.startsWith('blob:')) return UrlClass.BLOB;
  if (head.startsWith('data:')) return UrlClass.DATA;
  if (head.startsWith('wss:')) return UrlClass.WS;
  if (head.startsWith('ws:')) return UrlClass.WS;
  if (head.startsWith('vbscript:')) return UrlClass.VBSCRIPT;
  if (head.startsWith('about:')) {
    return s.slice(i + 6).trim() === 'blank' ? UrlClass.ABOUT_BLANK : UrlClass.ABOUT_OTHER;
  }
  return UrlClass.RELATIVE;
}

// Deterministic URL corpus generator.
// lengthMode: 'mixed' | 'short' (~30B) | 'medium' (~100B) | 'long' (~500B)
export function makeCorpus(n, lengthMode = 'mixed') {
  const corpus = [];
  const httpHosts = ['cdn.example.com', 'static.foo.io', 'api.bar.org', 'images.baz.net'];
  for (let i = 0; i < n; i++) {
    const r = (i * 2654435761) >>> 0;
    const bucket = r % 100;
    let s;
    if (bucket < 50) {
      const host = httpHosts[r % httpHosts.length];
      s = `https://${host}/path/${r}/file${r % 200}.png?v=${r & 0xff}`;
    } else if (bucket < 65) {
      s = `blob:https://${httpHosts[r % httpHosts.length]}/${r}-${r * 7}`;
    } else if (bucket < 70) {
      s = `data:image/png;base64,iVBORw0KGgo${'A'.repeat(40 + (r % 80))}`;
    } else if (bucket < 80) {
      s = `javascript:void(0)/*${r}*/`;
    } else if (bucket < 90) {
      s = `/relative/path/${r}/asset.css`;
    } else if (bucket < 93) {
      s = `wss://relay.example.com/${r}`;
    } else if (bucket < 95) {
      s = 'about:blank';
    } else if (bucket < 97) {
      s = `vbscript:bad(${r})`;
    } else {
      s = `mailto:user${r}@example.com`;
    }
    if (lengthMode === 'short' && s.length > 30) s = s.slice(0, 30);
    if (lengthMode === 'medium' && s.length < 100) s = s + '#' + 'x'.repeat(100 - s.length - 1);
    if (lengthMode === 'medium' && s.length > 100) s = s.slice(0, 100);
    if (lengthMode === 'long' && s.length < 500) s = s + '?' + 'q='.repeat((500 - s.length) / 2);
    if (lengthMode === 'long' && s.length > 500) s = s.slice(0, 500);
    corpus.push(s);
  }
  return corpus;
}

export function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'G';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(2);
}

// Measure `fn(i)` over `iters` calls after warmup using caller-injected `now()`.
export function timed(now, label, iters, fn) {
  const warm = Math.max(1000, iters / 10) | 0;
  for (let i = 0; i < warm; i++) fn(i);
  const t0 = now();
  let sink = 0;
  for (let i = 0; i < iters; i++) sink ^= fn(i);
  const dt = now() - t0;
  const opsPerSec = (iters / dt) * 1000;
  const nsPerOp = (dt * 1e6) / iters;
  return { label, iters, dt, opsPerSec, nsPerOp, sink };
}

export const PARITY_SAMPLES = Object.freeze([
  'https://example.com/', 'http://x.y/z?a=b#c',
  'javascript:alert(1)', '  JAVASCRIPT:alert(2)',
  'vbscript:foo', 'data:text/html,<x>', 'blob:https://a.b/c',
  'ws://r/', 'wss://r/', 'about:blank', 'about:srcdoc',
  '/relative/path', './foo', '../bar', '?query', '#hash',
  'mailto:a@b', '', 'http:',
]);

// UTF-8 encoder alternatives returning the byte length written to dst (capped at dst.length).

export function encodeManual(str, dst) {
  const cap = dst.length;
  const len = str.length;
  let j = 0;
  for (let i = 0; i < len; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      if (j >= cap) return j;
      dst[j++] = c;
    } else if (c < 0x800) {
      if (j + 2 > cap) return j;
      dst[j++] = 0xC0 | (c >> 6);
      dst[j++] = 0x80 | (c & 0x3F);
    } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < len) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c & 0x3FF) << 10) + (c2 & 0x3FF);
      if (j + 4 > cap) return j;
      dst[j++] = 0xF0 | (cp >> 18);
      dst[j++] = 0x80 | ((cp >> 12) & 0x3F);
      dst[j++] = 0x80 | ((cp >> 6) & 0x3F);
      dst[j++] = 0x80 | (cp & 0x3F);
    } else {
      if (j + 3 > cap) return j;
      dst[j++] = 0xE0 | (c >> 12);
      dst[j++] = 0x80 | ((c >> 6) & 0x3F);
      dst[j++] = 0x80 | (c & 0x3F);
    }
  }
  return j;
}

// ASCII-only fast path returning -1 on any non-ASCII code unit.
export function encodeAsciiFast(str, dst) {
  const cap = dst.length;
  const len = str.length;
  if (len > cap) return -1;
  for (let i = 0; i < len; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0x80) return -1;
    dst[i] = c;
  }
  return len;
}

export function encodeViaTextEncoder(enc, str, dst) {
  const { written } = enc.encodeInto(str, dst);
  return written | 0;
}
