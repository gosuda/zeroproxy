// ERRATA §O2 — runtime-prelude unit tests.
//
// The prelude is one giant closure, so the units are extracted verbatim from
// the source and exercised with their free variables injected — the same
// technique `static-policy.test.js` uses for `applyScriptPatches`. Stubs only
// replace the *boundary* (rewriter, natives); the logic under test is the
// real code path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { preludeSource } = require('./_prelude.cjs');
// zp-core 는 globalThis.ZP 를 설치한다 — 추출된 prelude 코드 안의
// `ZP.filterMetaCSP` 같은 free-var 참조가 실제 구현으로 해석되게 한다.
require('../../web/zp-core.js');

const SRC = preludeSource().split('\r\n').join('\n');

function slice(start, end) {
  const a = SRC.indexOf(start);
  assert.ok(a >= 0, `start marker missing: ${start}`);
  const b = SRC.indexOf(end, a);
  assert.ok(b > a, `end marker missing after ${start}: ${end}`);
  return SRC.slice(a, b);
}

function load(code, exports, deps) {
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, `${code}\nreturn { ${exports.join(', ')} };`);
  return factory(...names.map(n => deps[n]));
}

const normalizedError = name => { const e = new Error(name); e.name = name; return e; };

// ---------------------------------------------------------------------------
// Dynamic-code machinery: compileDynamic / nestedCall / dynamicEval.
// `rewriteDynamicFunctionBody` is stubbed to identity — what is verified here
// is the *wrapper* semantics (params, this, new.target, scope), which the
// stub does not touch.
// ---------------------------------------------------------------------------

const DYN_BLOCK = slice(
  '    function stringArgs(args) {',
  '    const dynamicFunction = function Function'
);

function dynEnv(overrides = {}) {
  const SCOPE = { __scope: true };
  const scopeVals = { location: { __vloc: true } };
  const withScope = new Proxy(scopeVals, {
    has() { return true; },
    get(t, p) { return t[p]; },
  });
  const calls = { global: [] };
  const toStringMap = new Map();
  const env = load(DYN_BLOCK,
    ['compileNested', 'nestedCall', 'compileDynamic', 'dynamicEval', 'isEvalExpressionCandidate', 'dynamicSource'],
    Object.assign({
      zpTrace() {},
      rewriteDynamicFunctionBody: (_params, body) => String(body || ''),
      Native: { FunctionCtor: Function, globalEval: code => { calls.global.push(code); return { globalResult: code }; } },
      toStringMap,
      scope: SCOPE,
      withScope,
      root: {},
      callPageRewriter: s => s,
      normalizedError,
      execGlobalScript: code => { calls.global.push(code); return { globalResult: code }; },
      // R1: dynamicEval 이 eval 렉시컬 환경 분리를 위해 읽는 슬롯 —
      // 추출 블록 밖 선언이라 dep 으로 주입해야 ReferenceError 가 안 난다.
      __zp_lex_env: null,
    }, overrides));
  return { env, SCOPE, withScope, calls, toStringMap };
}

test('compileDynamic: params, arguments object, return values', () => {
  const { env } = dynEnv();
  const fn = env.compileDynamic(Function, ['a', 'b', 'return a + b'], 'function');
  assert.equal(fn(2, 3), 5);
  const argc = env.compileDynamic(Function, ['return arguments.length'], 'function');
  assert.equal(argc(1, 2, 3), 3);
  const destr = env.compileDynamic(Function, ['{a}', 'return a.x'], 'function');
  assert.equal(destr({ a: { x: 7 } }), 7);
});

test('compileDynamic: sloppy nullish `this` lands on the scope facade', () => {
  const { env, SCOPE } = dynEnv();
  const fn = env.compileDynamic(Function, ['return this'], 'function');
  // Native sloppy `Function('return this').call(null)` yields the real
  // global — an escape. Ours must yield the scope facade instead.
  assert.equal(fn.call(null), SCOPE);
  assert.equal(fn.call(undefined), SCOPE);
  // A concrete thisArg still binds.
  const self = { s: 1 };
  assert.equal(fn.call(self), self);
});

test('compileDynamic: strict `this` passes through uncoerced', () => {
  const { env } = dynEnv();
  const fn = env.compileDynamic(Function, ["'use strict'; return this"], 'function');
  assert.equal(fn.call(null), null);
  assert.equal(fn.call(42), 42);
});

test('compileDynamic: new.target propagates through Reflect.construct', () => {
  const { env } = dynEnv();
  const fn = env.compileDynamic(Function, ['return new.target'], 'function');
  // Native: `new (new Function('return new.target'))()` → the constructor
  // itself. Plain call → undefined.
  assert.equal(fn(), undefined);
  assert.equal(new fn(), fn);
});

test('compileDynamic: free identifiers resolve through the with-scope proxy', () => {
  const { env, withScope } = dynEnv();
  const fn = env.compileDynamic(Function, ['return location'], 'function');
  assert.deepEqual(fn(), { __vloc: true });
  // `has` must cover EVERY name — the source-level invariant that keeps
  // unresolved identifiers from leaking to the real global.
  assert.ok(SRC.includes('has(_target, prop) { return prop !== Symbol.unscopables; }'),
    'withScope has-trap must return true for all names');
});

test('compileDynamic: async / generator kinds preserve the function species', async () => {
  const { env } = dynEnv();
  const afn = env.compileDynamic(Function, ['return 9'], 'async');
  const r = afn();
  assert.ok(r instanceof Promise, 'async dynamic function must return a Promise');
  assert.equal(await r, 9);
  const gfn = env.compileDynamic(Function, ['yield 1; yield 2'], 'generator');
  assert.deepEqual([...gfn()], [1, 2]);
});

test('compileDynamic: toStringMap masks the emitted source', () => {
  const { env, toStringMap } = dynEnv();
  const fn = env.compileDynamic(Function, ['a', 'return a * 2'], 'function');
  const masked = toStringMap.get(fn);
  assert.ok(masked.includes('function anonymous(a'), masked);
  assert.ok(masked.includes('return a * 2'), masked);
  // The rewritten internals (__zp_*) must never appear in the masked source.
  assert.ok(!masked.includes('__zp_'), masked);
});

test('isEvalExpressionCandidate: statement starters vs expressions', () => {
  const { env } = dynEnv();
  for (const expr of ['1 + 2', 'x.y', '  a()', 'new Foo()', '[1,2].map(f)', '`t${x}`']) {
    assert.equal(env.isEvalExpressionCandidate(expr), true, expr);
  }
  for (const stmt of ['var q = 1', 'function f(){}', 'class A{}', 'let x = 2', 'if (x) y()', 'for (;;) {}', 'return 1', 'with(o){}', '  const c = 3']) {
    assert.equal(env.isEvalExpressionCandidate(stmt), false, stmt);
  }
});

test('dynamicEval: expression path evaluates in the with-scope', () => {
  const { env } = dynEnv();
  assert.equal(env.dynamicEval('1 + 2'), 3);
  // The expression resolves names through the scope proxy.
  assert.deepEqual(env.dynamicEval('location'), { __vloc: true });
  // No args → undefined (native eval() parity).
  assert.equal(env.dynamicEval(), undefined);
});

test('dynamicEval: statement path goes through the global executor', () => {
  const { env, calls } = dynEnv();
  const r = env.dynamicEval('var q = 1; q');
  assert.deepEqual(r, { globalResult: 'var q = 1; q' });
  assert.deepEqual(calls.global, ['var q = 1; q']);
});

test('dynamicEval: rewriter failures propagate — no silent fallback', () => {
  // NotSupportedError propagates on both paths — unrewritten code must not run.
  const { env: envNS } = dynEnv({ callPageRewriter() { throw normalizedError('NotSupportedError'); } });
  assert.throws(() => envNS.dynamicEval('1 + 2'), /NotSupportedError/);
  assert.throws(() => envNS.dynamicEval('var a = 1;'), /NotSupportedError/);
  // A parse failure surfaces as SyntaxError (native parity), and nothing runs.
  const { env: envSyn, calls } = dynEnv({ callPageRewriter() { throw new SyntaxError('Unexpected token'); } });
  assert.throws(() => envSyn.dynamicEval('if ('), SyntaxError);
  assert.deepEqual(calls.global, [], 'unrewritten code reached the executor');
});

test('dynamicEval: a runtime throw propagates and the code runs exactly once', () => {
  // A former `catch {}` + Function-body fallback re-ran statement code that
  // threw at runtime: side effects before the throw happened twice.
  let runs = 0;
  const { env } = dynEnv({ execGlobalScript: () => { runs++; throw new Error('boom'); } });
  assert.throws(() => env.dynamicEval('var n = 1; throw 1'), /boom/);
  assert.equal(runs, 1, 'statement code executed more than once');
});

test('dynamicEval: non-string input is returned without evaluation (native parity)', () => {
  const { env, calls } = dynEnv();
  let toStringCalls = 0;
  const o = { toString() { toStringCalls++; return '2+2'; } };
  assert.equal(env.dynamicEval(o), o);
  const strings = ['x'];
  assert.equal(env.dynamicEval(strings), strings); // what eval`x` passes
  assert.equal(env.dynamicEval(123), 123);
  assert.equal(toStringCalls, 0, 'toString() ran — the object was evaluated as code');
  assert.deepEqual(calls.global, []);
});

test('callPageRewriter: a parse failure is a SyntaxError built in virtual-URL-tagged code', () => {
  const block = slice('    function parseSyntaxError(message) {', '    function rewriteDynamicFunctionBody(');
  const parseErrors = new WeakSet();
  const mk = rewriteScript => load(block, ['callPageRewriter'], {
    Native: { globalEval: (0, eval) },
    virtualURL: { href: 'https://target.example/page' },
    root: { ZPBundle: { ready: true, rewriteScript } },
    normalizedError,
    parseErrors,
  });
  let err;
  try { mk(() => { throw new Error('parse failed: Unexpected token'); }).callPageRewriter('if (', 'classic'); } catch (e) { err = e; }
  assert.ok(err instanceof SyntaxError, `expected SyntaxError, got ${err && err.name}`);
  assert.equal(err.message, 'Unexpected token');
  assert.ok(parseErrors.has(err), 'parse error not tagged for the timer path');
  // Built inside the tagged eval, so its stack names the virtual URL — an
  // uncaught one must not report the prelude URL as ErrorEvent.filename.
  assert.match(String(err.stack), /https:\/\/target\.example\/page/);
  // Any other failure stays fail-closed NotSupportedError.
  assert.throws(() => mk(() => { throw new Error('wasm trap'); }).callPageRewriter('x', 'classic'), /NotSupportedError/);
  // Empty in, empty out is valid (native eval('') is undefined); empty out
  // for non-empty input is still a broken rewrite.
  assert.equal(mk(s => s).callPageRewriter('', 'classic'), '');
  assert.throws(() => mk(() => '').callPageRewriter('x', 'classic'), /NotSupportedError/);
});

// ---------------------------------------------------------------------------
// URL scheme helpers.
// ---------------------------------------------------------------------------

const SCHEME_BLOCK = slice(
  '  function isHTTPURL(raw) {',
  '  // ★스킴이 http(s) 가 아닌 **절대** URL 은'
) + slice(
  '  function nonHTTPAbsoluteURL(raw) {',
  '  // Single-parse equivalent of `isHTTPURL'
);

const NAV_BLOCK = slice(
  '  const NAV_EXTERNAL_SCHEMES = new Set(',
  '  function setVirtualLocation'
);

test('isHTTPURL / nonHTTPAbsoluteURL classification', () => {
  const { isHTTPURL, nonHTTPAbsoluteURL, hasExecutableURLScheme, hasDangerousURLScheme } = load(
    SCHEME_BLOCK,
    ['isHTTPURL', 'nonHTTPAbsoluteURL', 'hasExecutableURLScheme', 'hasDangerousURLScheme'],
    { baseURL: 'https://example.com/dir/' }
  );
  for (const v of ['https://t/x', 'http://t/', '/rel/path', '../up', 'rel', '?q=1', '#frag', '//cdn.x/y']) {
    assert.equal(isHTTPURL(v), true, v);
  }
  for (const v of ['mailto:a@b', 'data:text/plain,x', 'blob:https://t/id', 'javascript:1', 'tel:+1', 'about:blank']) {
    assert.equal(isHTTPURL(v), false, v);
  }
  // These resolve against the http base (empty → base itself, garbage → path).
  assert.equal(isHTTPURL(''), true);
  assert.equal(isHTTPURL('::bad'), true);
  // Non-HTTP absolute URLs come back normalized; HTTP + relative → null.
  assert.equal(nonHTTPAbsoluteURL('mailto:a@b'), 'mailto:a@b');
  assert.equal(nonHTTPAbsoluteURL('DATA:text/plain,x'), 'data:text/plain,x');
  assert.equal(nonHTTPAbsoluteURL('  tel:+82-1  '), 'tel:+82-1');
  assert.equal(nonHTTPAbsoluteURL('https://t/x'), null);
  assert.equal(nonHTTPAbsoluteURL('/rel'), null);
  assert.equal(nonHTTPAbsoluteURL('rel'), null);
  for (const v of ['javascript:alert(1)', '  JAVASCRIPT:x', 'data:text/html,x', 'vbscript:x']) {
    assert.equal(hasExecutableURLScheme(v), true, v);
  }
  assert.equal(hasDangerousURLScheme('data:x'), false);
  assert.equal(hasDangerousURLScheme('javascript:x'), true);
  assert.equal(hasExecutableURLScheme('https://t'), false);
});

test('delegatableExternalScheme: mailto-family yes, executable/inline no', () => {
  const { delegatableExternalScheme } = load(NAV_BLOCK, ['delegatableExternalScheme'], {});
  for (const v of ['mailto:a@b', 'tel:+1', 'sms:+1', 'skype:user', 'tg://resolve', 'webcal://x']) {
    assert.equal(delegatableExternalScheme(v), true, v);
  }
  // These stay in the jail — they can carry executable or inline content.
  for (const v of ['javascript:1', 'data:text/html,x', 'blob:https://t/id', 'about:blank', 'https://t/x', '/rel', 'ftp://f']) {
    assert.equal(delegatableExternalScheme(v), false, v);
  }
});

// ---------------------------------------------------------------------------
// Meta http-equiv policy.
// ---------------------------------------------------------------------------

const CSP_META_BLOCK = slice(
  '  const CSP_EQUIV = [',
  '  function isIntegrityBearing'
);
const REFRESH_BLOCK = slice(
  '  function proxiedRefreshContent(content) {',
  '  // Post-write meta enforcement for paths'
);
const META_POLICY_BLOCK = slice(
  '  function enforceMetaPolicy(el) {',
  '  function transformHTML(value, opts) {'
);

function fakeEl(attrs) {
  return { attrs, localName: 'meta' };
}
function fakeNative() {
  return {
    getAttribute: { call(el, k) { return k in el.attrs ? el.attrs[k] : null; } },
    setAttribute: { call(el, k, v) { el.attrs[k] = String(v); } },
    removeAttribute: { call(el, k) { delete el.attrs[k]; } },
  };
}

test('CSP-equiv list neutralizes CSP, report-only, and origin-trial', () => {
  const { isCSPHttpEquiv } = load(CSP_META_BLOCK, ['isCSPHttpEquiv'], { Native: fakeNative() });
  for (const v of ['content-security-policy', 'Content-Security-Policy', ' content-security-policy-report-only ', 'origin-trial', 'ORIGIN-TRIAL']) {
    assert.equal(isCSPHttpEquiv(v), true, v);
  }
  for (const v of ['refresh', 'x-ua-compatible', '', undefined]) {
    assert.equal(isCSPHttpEquiv(v), false, String(v));
  }
});

test('neutralizeCSPMeta removes the active equiv and keeps the original', () => {
  const Native = fakeNative();
  const { neutralizeCSPMeta } = load(CSP_META_BLOCK, ['neutralizeCSPMeta'], { Native });
  const el = fakeEl({ 'http-equiv': 'origin-trial', content: 'TOKEN123' });
  neutralizeCSPMeta(el, 'origin-trial');
  assert.equal(el.attrs['http-equiv'], undefined);
  assert.equal(el.attrs['data-zp-blocked-http-equiv'], 'origin-trial');
  assert.equal(el.attrs.content, 'TOKEN123', 'token must stay readable for forensics');
});

test('proxiedRefreshContent rewrites only the URL part', () => {
  const { proxiedRefreshContent } = load(REFRESH_BLOCK, ['proxiedRefreshContent'], {
    targetURLIfHTTP: v => (/^https?:/i.test(v) ? new URL(v).href : null),
    proxyViaURL: abs => 'VIA(' + abs + ')',
  });
  assert.equal(proxiedRefreshContent('5; url=https://t/x'), '5; url=VIA(https://t/x)');
  // The keyword is re-emitted lowercase regardless of input case.
  assert.equal(proxiedRefreshContent('0;URL="https://t/y?a=1"'), '0;url=VIA(https://t/y?a=1)');
  // Delay-only refresh (self reload) — nothing to proxy.
  assert.equal(proxiedRefreshContent('5'), '');
  // Executable / non-http targets fail closed.
  assert.equal(proxiedRefreshContent('0;url=javascript:alert(1)'), '');
  assert.equal(proxiedRefreshContent('0;url=data:text/html,x'), '');
});

test('enforceMetaPolicy handles CSP-equiv, refresh, and unrelated metas', () => {
  const Native = fakeNative();
  const { isCSPHttpEquiv, neutralizeCSPMeta } = load(CSP_META_BLOCK, ['isCSPHttpEquiv', 'neutralizeCSPMeta'], { Native });
  const { proxiedRefreshContent } = load(REFRESH_BLOCK, ['proxiedRefreshContent'], {
    targetURLIfHTTP: v => (/^https?:/i.test(v) ? new URL(v).href : null),
    proxyViaURL: abs => 'VIA(' + abs + ')',
  });
  const { enforceMetaPolicy } = load(META_POLICY_BLOCK, ['enforceMetaPolicy'], {
    Native, isCSPHttpEquiv, neutralizeCSPMeta, proxiedRefreshContent,
  });
  const cspEl = fakeEl({ 'http-equiv': 'Content-Security-Policy', content: "default-src *" });
  enforceMetaPolicy(cspEl);
  // E2: 필터가 남길 지시어가 있으면 meta 는 무장 상태로 산다 — 교집합
  // content 가 쓰이고 원문은 data-zp-blocked-content 에 stash.
  assert.equal(cspEl.attrs['http-equiv'], 'Content-Security-Policy');
  // The backup records the normalized (lowercased) equiv name.
  assert.equal(cspEl.attrs['data-zp-blocked-http-equiv'], 'content-security-policy');
  assert.equal(cspEl.attrs['data-zp-blocked-content'], 'default-src *');
  assert.match(cspEl.attrs.content, /^default-src \* /, `intersected content: ${cspEl.attrs.content}`);
  // 필터가 아무 지시어도 남기지 않는 meta 는 완전 무력화된다.
  const deadEl = fakeEl({ 'http-equiv': 'Content-Security-Policy', content: "bogus-src 'none'" });
  enforceMetaPolicy(deadEl);
  assert.equal(deadEl.attrs['http-equiv'], undefined, 'empty intersection must neutralize');
  assert.equal(deadEl.attrs['data-zp-blocked-http-equiv'], 'content-security-policy');
  const refreshEl = fakeEl({ 'http-equiv': 'refresh', content: '3; url=https://t/next' });
  enforceMetaPolicy(refreshEl);
  assert.equal(refreshEl.attrs.content, '3; url=VIA(https://t/next)');
  const other = fakeEl({ 'http-equiv': 'x-ua-compatible', content: 'IE=edge' });
  enforceMetaPolicy(other);
  assert.deepEqual(other.attrs, { 'http-equiv': 'x-ua-compatible', content: 'IE=edge' });
});

// ---------------------------------------------------------------------------
// importmap / speculationrules JSON rewriting.
// ---------------------------------------------------------------------------

const JSON_REWRITE_BLOCK = slice(
  '  function rewriteImportMapText(source) {',
  '  // `document.write` on a CLOSED document'
);

function jsonEnv() {
  return load(JSON_REWRITE_BLOCK, ['rewriteImportMapText', 'rewriteSpeculationRulesText'], {
    baseURL: 'https://example.com/dir/',
    scriptProxyPath: (u, kind) => `MOD[${kind}](${u})`,
    subresourceProxyPath: u => `SUB(${u})`,
    proxyViaURL: u => `VIA(${u})`,
    ZP: { errorPath: e => `ERR(${e})` },
  });
}

test('rewriteImportMapText rewrites imports/scopes, blocks non-http', () => {
  const { rewriteImportMapText } = jsonEnv();
  const out = JSON.parse(rewriteImportMapText(JSON.stringify({
    imports: { a: '/m.js', b: './rel.js', c: 'data:text/javascript,x', d: 'https://cdn.x/lib.js' },
    scopes: { '/pkg/': { e: '/e.js' } },
  })));
  assert.equal(out.imports.a, 'MOD[module](https://example.com/m.js)');
  assert.equal(out.imports.b, 'MOD[module](https://example.com/dir/rel.js)');
  assert.equal(out.imports.c, 'ERR(POLICY_BLOCKED)');
  assert.equal(out.imports.d, 'MOD[module](https://cdn.x/lib.js)');
  // Scope keys are rewritten as addresses too.
  assert.equal(Object.keys(out.scopes)[0], 'MOD[module](https://example.com/pkg/)');
  assert.equal(out.scopes['MOD[module](https://example.com/pkg/)'].e, 'MOD[module](https://example.com/e.js)');
  // Garbage in → empty map out (never raw passthrough).
  assert.equal(rewriteImportMapText('not json'), '{}');
  assert.equal(rewriteImportMapText('[1,2]'), '{}');
});

test('rewriteImportMapText escapes angle brackets in serialized JSON', () => {
  const { rewriteImportMapText } = jsonEnv();
  // A `<` inside a specifier KEY survives verbatim into the JSON — it must
  // be escaped so the map can sit inside an inline <script> safely.
  const raw = rewriteImportMapText(JSON.stringify({ imports: { '<x': '/m.js' } }));
  assert.ok(!raw.includes('<'), raw);
  assert.ok(raw.includes('\\u003c'), raw);
});

test('rewriteSpeculationRulesText routes prefetch→fetch, prerender→nav', () => {
  const { rewriteSpeculationRulesText } = jsonEnv();
  const out = JSON.parse(rewriteSpeculationRulesText(JSON.stringify({
    prefetch: [{ urls: ['/a', 'https://cdn.x/b', 'data:x', 'javascript:1'] }],
    prerender: [{ urls: ['/c'] }],
  })));
  assert.equal(out.prefetch[0].urls[0], 'SUB(https://example.com/a)');
  assert.equal(out.prefetch[0].urls[1], 'SUB(https://cdn.x/b)');
  // Non-http values pass through unchanged — they cannot trigger a fetch.
  assert.equal(out.prefetch[0].urls[2], 'data:x');
  assert.equal(out.prefetch[0].urls[3], 'javascript:1');
  assert.equal(out.prerender[0].urls[0], 'VIA(https://example.com/c)');
  assert.equal(rewriteSpeculationRulesText('{broken'), '{}');
});

// ---------------------------------------------------------------------------
// isNativeLocation — brand check against forged tags.
// ---------------------------------------------------------------------------

const LOC_BLOCK = slice(
  '    const nativeObjToString = Object.prototype.toString;',
  '    function get(base, prop) {'
);

test('isNativeLocation: tag pre-filter + native-getter brand check', () => {
  const realLoc = {};
  Object.defineProperty(realLoc, Symbol.toStringTag, { value: 'Location' });
  // Native.locationHref.get throws unless `this` is a real Location — emulate
  // the brand check with a WeakSet of "real" locations.
  const real = new WeakSet([realLoc]);
  const { isNativeLocation } = load(LOC_BLOCK, ['isNativeLocation'], {
    virtualLocation: { __vloc: true },
    Native: {
      locationHref: { get: { call(v) { if (!real.has(v)) throw new TypeError('brand check'); return 'https://p/'; } } },
    },
  });
  assert.equal(isNativeLocation(realLoc), true);
  // Forged Symbol.toStringTag alone must NOT pass — the getter brand check
  // rejects it.
  const forged = {};
  Object.defineProperty(forged, Symbol.toStringTag, { value: 'Location' });
  assert.equal(isNativeLocation(forged), false);
  assert.equal(isNativeLocation({}), false);
  assert.equal(isNativeLocation('https://t/x'), false);
  assert.equal(isNativeLocation(null), false);
  // The virtual location object must never classify as native.
  assert.equal(isNativeLocation({ __vloc: true }), false);
  // Cached positive: second call takes the WeakSet fast path.
  assert.equal(isNativeLocation(realLoc), true);
});

// ---------------------------------------------------------------------------
// decodeInlineEntities — inline-script entity decoding.
// ---------------------------------------------------------------------------

const ENTITIES_BLOCK = slice(
  '    function decodeInlineEntities(src) {',
  '    // Execute a classic script body with real *global* scope'
);

test('decodeInlineEntities decodes the raw-text entity set', () => {
  const { decodeInlineEntities } = load(ENTITIES_BLOCK, ['decodeInlineEntities'], {});
  assert.equal(decodeInlineEntities('a &lt; b && c &gt; d'), 'a < b && c > d');
  assert.equal(decodeInlineEntities('x =&gt; y'), 'x => y');
  assert.equal(decodeInlineEntities('&quot;q&quot; &#39;s&#39; &#x27;t&#x27;'), '"q" \'s\' \'t\'');
  // `&nbsp;` decodes to U+00A0 (native HTML parity), not ASCII space.
  assert.equal(decodeInlineEntities('a&nbsp;b'), 'a b');
  assert.equal(decodeInlineEntities('plain'), 'plain');
  assert.equal(decodeInlineEntities(''), '');
});

// ---------------------------------------------------------------------------
// Error.stack sanitizer — page (06-install.js) and worker copies.
//
// GitHub 실측(2026-09-29): React 의 describeNativeComponentFrame 은
// `const p = Error.prepareStackTrace; Error.prepareStackTrace = undefined; …;
// Error.prepareStackTrace = p` 로 저장/복원한다. 게터가 준 값은 우리 zpPrepare
// 라서 복원이 `userPrepare = zpPrepare` 가 되고, 그 뒤 모든 `.stack` 이
// zpPrepare → zpPrepare → … 로 스택을 터뜨렸다. react-partial 6개가 전부
// "Maximum call stack size exceeded" 로 죽었다. 이전 값을 부르는 체이닝 훅도
// 같은 고리다. Node 는 V8 처럼 realm 의 `Error.prepareStackTrace` 를 부르므로
// vm realm 에 설치해 실제 포맷 경로로 검증한다.
// ---------------------------------------------------------------------------

const vm = require('node:vm');
const WORKER_SRC = fs.readFileSync(require.resolve('../../web/worker-prelude.js'), 'utf8').split('\r\n').join('\n');

function sanitizerRealm(install) {
  const ctx = vm.createContext({});
  install(vm.runInContext('globalThis', ctx));
  return code => vm.runInContext(code, ctx);
}

const STACK_SANITIZERS = {
  page: realm => load(
    slice('  function installStackSanitizer() {', '  function installPhase2Membrane() {'),
    ['installStackSanitizer'],
    { root: realm, deproxyURL: s => s, defineMasked: (o, p, d) => Object.defineProperty(o, p, d) },
  ).installStackSanitizer(),
  worker: realm => {
    const a = WORKER_SRC.indexOf('  (function installStackSanitizer() {');
    const b = WORKER_SRC.indexOf('  })();', a);
    assert.ok(a >= 0 && b > a, 'worker stack sanitizer markers missing');
    load(WORKER_SRC.slice(a, b + '  })();'.length), [], {
      self: realm, realProxyOrigin: 'http://proxy.localhost:18080', NativeURLCtor: URL, base: new URL('https://t.example/'),
    });
  },
};

for (const [name, install] of Object.entries(STACK_SANITIZERS)) {
  test(`${name} stack sanitizer survives save/restore and chaining of prepareStackTrace`, () => {
    const run = sanitizerRealm(install);
    // React describeNativeComponentFrame — 저장/비움/복원 뒤에도 기본 포맷.
    assert.match(run("const p = Error.prepareStackTrace; Error.prepareStackTrace = undefined; Error.prepareStackTrace = p; new Error('x').stack"), /^Error: x\n    at /);
    // 이전 값을 부르는 체이닝 훅 — 한 번 감싸고 기본 포맷으로 끝난다.
    assert.match(run("{ const prev = Error.prepareStackTrace; Error.prepareStackTrace = (e, f) => 'W:' + prev(e, f); const s = new Error('y').stack; Error.prepareStackTrace = prev; s }"), /^W:Error: y\n    at /);
    // 페이지 훅은 프레임을 받고 그 결과가 `.stack` 이 된다.
    assert.equal(run("Error.prepareStackTrace = (e, f) => 'n:' + (f.length > 0); const s2 = new Error('z').stack; Error.prepareStackTrace = undefined; s2"), 'n:true');
  });
}

// ---------------------------------------------------------------------------
// D4 — WebTransport through the gateway (ZP.webTransportGatewayRequest).
// The page's `serverCertificateHashes` pin the TARGET: they must move to the
// gateway (which pins its dial) — on the native connection they would pin the
// gateway's certificate and fail. The gateway's own dev-cert pin comes from
// the server config.
// ---------------------------------------------------------------------------

test('WebTransport gateway request moves target pins to the gateway', () => {
  const hash = new Uint8Array(32).fill(7);
  const gwPin = ZP.bytesToBase64Url(new Uint8Array(32).fill(9));
  const { url, options } = ZP.webTransportGatewayRequest(
    'https://proxy.localhost:18443/__zp/wt', 'https://t.example:4433/echo', 'tab1',
    { serverCertificateHashes: [{ algorithm: 'SHA-256', value: hash.buffer }, { algorithm: 'md5', value: new Uint8Array(16) }], congestionControl: 'throughput', bogus: 1 },
    [gwPin]);
  const u = new URL(url);
  assert.equal(u.searchParams.get('target'), 'https://t.example:4433/echo');
  assert.equal(u.searchParams.get('tab'), 'tab1');
  assert.equal(u.searchParams.get('pinned'), '1');
  assert.deepEqual(u.searchParams.getAll('certhash'), [ZP.bytesToBase64Url(hash)]);
  assert.equal(options.congestionControl, 'throughput');
  assert.equal('bogus' in options, false);
  assert.equal(options.serverCertificateHashes.length, 1);
  assert.equal(options.serverCertificateHashes[0].algorithm, 'sha-256');
  assert.deepEqual(Array.from(options.serverCertificateHashes[0].value), Array(32).fill(9));

  // Present but empty still pins — the gateway must not fall back to CA roots.
  const empty = new URL(ZP.webTransportGatewayRequest('https://gw/w', 'https://t/x', '', { serverCertificateHashes: [] }, []).url);
  assert.equal(empty.searchParams.get('pinned'), '1');
  // No pins at all → neither flag nor gateway pin.
  const plain = ZP.webTransportGatewayRequest('https://gw/w', 'https://t/x', '', undefined, []);
  assert.equal(new URL(plain.url).searchParams.has('pinned'), false);
  assert.equal('serverCertificateHashes' in plain.options, false);
  // A non-BufferSource value throws like the native constructor.
  assert.throws(() => ZP.webTransportGatewayRequest('https://gw/w', 'https://t/x', '', { serverCertificateHashes: [{ algorithm: 'sha-256', value: 'x' }] }, []), TypeError);
});

test('proxied CSP admits the WebTransport gateway only when one is configured', () => {
  const connect = csp => csp.match(/connect-src [^;]*/)[0];
  assert.equal(connect(ZP.fixedCSP([])).includes('18443'), false);
  assert.equal(connect(ZP.fixedCSP([], { extraConnect: ['https://proxy.localhost:18443/__zp/wt'] })).includes(' https://proxy.localhost:18443 '), true);
});

// D5 — the only RTCConfiguration a proxied RTCPeerConnection gets.
test('relay-only RTC configuration replaces the ICE servers and the policy', () => {
  const ice = [{ urls: ['turn:192.0.2.1:3478'], username: 'u', credential: 'c' }];
  const page = { iceServers: [{ urls: 'stun:stun.example:3478' }], iceTransportPolicy: 'all', bundlePolicy: 'max-bundle' };
  const c = ZP.relayOnlyRTCConfiguration(page, ice);
  assert.deepEqual(c.iceServers, ice);
  assert.equal(c.iceTransportPolicy, 'relay');
  assert.equal(c.bundlePolicy, 'max-bundle', 'other members pass through');
  assert.equal(page.iceTransportPolicy, 'all', 'the page dictionary is not mutated');
  assert.equal(ZP.relayOnlyRTCConfiguration(undefined, ice).iceTransportPolicy, 'relay');
});

// ---------------------------------------------------------------------------
// postMessage: a message addressed to an origin the destination window does not
// have is dropped — and both signatures work. Every proxied window shares one
// physical origin, so the browser's filter never fires; the wrapper compares
// VIRTUAL origins. Expected values are Chrome's (measured, native).
// ---------------------------------------------------------------------------

const PM_BLOCK = slice('  function postMessageTargetAccepts(target, wanted) {', '  function virtualOriginForMessage(ev) {');

function pmEnv(destOrigin) {
  const sent = [];
  const diag = [];
  const target = { postMessage: (...a) => { sent.push(a); } };
  const env = load(PM_BLOCK, ['postMessageWrapperFor', 'postMessageTargetAccepts', 'normalizePostMessageTargetOrigin'], {
    proxyOrigin: 'http://proxy.test:18080',
    virtualURL: new URL('http://a.test:3000/page'),
    windowHandles: { originOf: () => destOrigin },
    root: { __zp_diagnostics: diag },
    postMessageWrappers: new WeakMap(),
    maskNativeFunction() {},
    defineMasked() {},
    restoreNativePostMessage() {},
    installEarlyPostMessage() {},
    URL,
  });
  return { env, target, sent, diag, wrapped: env.postMessageWrapperFor(target) };
}

test('postMessage target origin: a mismatch is dropped, a match is delivered', () => {
  const { wrapped, sent, diag } = pmEnv('http://b.test:3000');
  wrapped('m', 'http://b.test:3000');          // exact
  wrapped('m', '*');                            // anything
  assert.equal(sent.length, 2);
  wrapped('m', 'http://example.invalid');      // wrong site
  wrapped('m', 'http://a.test:3000');          // the sender's own origin, to another site's window
  wrapped('m', '/');                            // "/" is the sender's origin too
  wrapped('m');                                 // default target origin is "/"
  assert.equal(sent.length, 2, 'every mismatch was dropped silently');
  assert.deepEqual(diag.map(d => d.t), ['pm-drop', 'pm-drop', 'pm-drop', 'pm-drop'], 'and each one left a diagnostic');
  assert.deepEqual({ t: diag[0].t, wanted: diag[0].wanted, dest: diag[0].dest, from: diag[0].from },
    { t: 'pm-drop', wanted: 'http://example.invalid', dest: 'http://b.test:3000', from: 'http://a.test:3000' });
  // The record also says which window the message was aimed at, and where it was sent from.
  assert.match(diag[0].to, /^(self|parent|top|opener|child\d+|other)\b/, 'and names the destination by its role');
  assert.equal(typeof diag[0].at, 'string', 'and the call site');
  // Delivered messages carry the proxy origin the browser can match.
  assert.deepEqual(sent.map(a => a[1]), ['http://proxy.test:18080', '*']);
});

test('postMessage target origin: "/" and the default reach a same-origin window', () => {
  const { wrapped, sent } = pmEnv('http://a.test:3000');
  wrapped('m', '/');
  wrapped('m');
  wrapped('m', 'http://a.test:3000');
  wrapped('m', 'http://b.test:3000');
  assert.equal(sent.length, 3);
});

test('postMessage target origin: an unknown destination is left to the browser', () => {
  const { wrapped, sent } = pmEnv('');
  wrapped('m', 'http://b.test:3000');
  wrapped('m', '/');
  assert.equal(sent.length, 2);
});

test('postMessage: the options form is honored, filtered and keeps transfer', () => {
  const { wrapped, sent } = pmEnv('http://b.test:3000');
  const transfer = [];
  wrapped('m', { targetOrigin: '*' });
  wrapped('m', { targetOrigin: 'http://b.test:3000', transfer });
  assert.equal(sent.length, 2, 'the options form used to throw a SyntaxError (the object was stringified)');
  assert.deepEqual(sent[0][1], { targetOrigin: '*' });
  assert.equal(sent[1][1].targetOrigin, 'http://proxy.test:18080');
  assert.equal(sent[1][1].transfer, transfer);
  wrapped('m', { targetOrigin: 'http://example.invalid' });
  wrapped('m', {});                              // targetOrigin defaults to "/" = the sender's
  assert.equal(sent.length, 2);
});

test('postMessage wrapper looks like the native method', () => {
  const { wrapped } = pmEnv('http://b.test:3000');
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped.name, 'postMessage');
});

// ---------------------------------------------------------------------------
// Which windows a page may hold. A window of another virtual origin is handed
// out only as a stand-in that follows the HTML cross-origin rules; the facts
// below were measured against Chrome 148.
// ---------------------------------------------------------------------------

const XORIGIN_BLOCK = slice('    const CROSS_ORIGIN_WINDOW_NAMES = [', '    function virtualWindowProperty(target, prop) {');

function xoriginEnv() {
  const get = () => {};
  const scope = { __scope: true };
  const safe = new WeakMap();
  const ownerScope = { __ownerScope: true };
  const root = { parent: null, opener: null, __zp_get: get };
  root.parent = root;
  const urlMeta = new Map();
  const env = load(XORIGIN_BLOCK, ['windowHandleFor', 'crossOriginWindow', 'virtualOriginOfWindow'], {
    get, root, scope,
    virtualURL: new URL('http://a.test:3000/'),
    urlMeta,
    Native: { getAttribute: { call: () => null }, DOMException },
    frameRouteTarget: () => '',
    isScopeProxy: v => v === scope,
    safeCrossWindow: w => { if (!safe.has(w)) safe.set(w, { safeFor: w }); return safe.get(w); },
    crossWindowLocation: w => ({ locationOf: w }),
    postMessageWrapperFor: w => function postMessage() {},
    maskNativeFunction() {},
    toStringMap: new Map(),
    nativeAccessorSource: () => 'function () { [native code] }',
    normalizedError,
    crossWindowTargets: new WeakMap(),
    URL,
  });
  const win = (origin, extra = {}) => Object.assign({
    length: 0, closed: false, top: null, parent: null, opener: null,
    close() {}, focus() {}, blur() {}, postMessage() {},
    __zp_get: origin ? (w, prop) => (prop === 'location' ? { origin } : prop === 'window' ? ownerScope : undefined) : undefined,
  }, extra);
  return { env, root, scope, urlMeta, win, ownerScope };
}
const isSecurityError = e => e && e.name === 'SecurityError';

test('window handles: own window → page-facing scope, same-origin window as it is, nothing else touched', () => {
  const { env, root, scope, win } = xoriginEnv();
  assert.equal(env.windowHandleFor(root), scope);
  assert.equal(env.windowHandleFor(null), null);
  const same = win('http://a.test:3000');
  assert.equal(env.windowHandleFor(same), same, 'a same-origin window is handed out raw');
  assert.equal(env.windowHandleFor('str'), 'str');
});

test('window handles: a window of another origin is a stand-in, stable per window', () => {
  const { env, win } = xoriginEnv();
  const other = win('http://b.test:3000');
  const handle = env.windowHandleFor(other);
  assert.notEqual(handle, other);
  assert.equal(env.windowHandleFor(other), handle, 'natively `iframe.contentWindow === iframe.contentWindow`');
  assert.equal(env.windowHandleFor(handle), handle, 'a handle passed through again is itself');
});

test('cross-origin window: the allowed names answer, everything else is SecurityError', () => {
  const { env, win, root, scope } = xoriginEnv();
  const w = win('http://b.test:3000', { top: root, parent: root });
  const h = env.windowHandleFor(w);
  assert.equal(h.closed, false);
  assert.equal(h.length, 0);
  assert.equal(h.window, h); assert.equal(h.self, h); assert.equal(h.frames, h);
  assert.equal(typeof h.postMessage, 'function');
  assert.equal(h.top, scope, 'the opener chain leads back to OUR window');
  assert.equal(h.parent, scope);
  assert.equal(h.opener, null);
  assert.deepEqual(h.location, { locationOf: w });
  for (const name of ['document', 'localStorage', 'eval', 'name', 'origin', 'navigator', 'constructor', 'zpExpando', 'frameElement']) {
    assert.throws(() => h[name], isSecurityError, `reading ${name}`);
  }
  assert.equal(h.then, undefined, '`then` reads undefined, so a promise resolution does not throw');
});

test('cross-origin window: every mutation throws SecurityError (not false)', () => {
  const { env, win } = xoriginEnv();
  const h = env.windowHandleFor(win('http://b.test:3000'));
  assert.throws(() => { h.x = 1; }, isSecurityError);
  assert.throws(() => { h.postMessage = 1; }, isSecurityError);
  assert.throws(() => { delete h.x; }, isSecurityError);
  assert.throws(() => Reflect.deleteProperty(h, 'location'), isSecurityError);
  assert.throws(() => Reflect.defineProperty(h, 'x', { value: 1 }), isSecurityError);
  assert.throws(() => Reflect.setPrototypeOf(h, {}), isSecurityError);
  assert.throws(() => Reflect.preventExtensions(h), isSecurityError);
  assert.equal(Reflect.isExtensible(h), true);
});

test('cross-origin window: reflection matches Chrome', () => {
  const { env, win } = xoriginEnv();
  const h = env.windowHandleFor(win('http://b.test:3000'));
  assert.deepEqual(Object.keys(h), [], 'nothing is enumerable');
  assert.equal(Object.getPrototypeOf(h), null);
  assert.deepEqual(Object.getOwnPropertyNames(h), ['window', 'self', 'location', 'closed', 'frames', 'length', 'top', 'opener', 'parent', 'blur', 'close', 'focus', 'postMessage', 'then']);
  assert.equal('location' in h, true);
  assert.equal('postMessage' in h, true);
  assert.throws(() => 'document' in h, isSecurityError);
  assert.throws(() => 'then' in h, isSecurityError, '`then` is a key but not "in"');
  assert.equal(Object.prototype.toString.call(h), '[object Object]');
  assert.throws(() => String(h), isSecurityError);
  assert.throws(() => JSON.stringify(h), isSecurityError);
  assert.equal(h instanceof Object, false, 'a null prototype: no `instanceof Window` either');
  const pm = Object.getOwnPropertyDescriptor(h, 'postMessage');
  assert.deepEqual({ w: pm.writable, e: pm.enumerable, c: pm.configurable, t: typeof pm.value }, { w: false, e: false, c: true, t: 'function' });
  const loc = Object.getOwnPropertyDescriptor(h, 'location');
  assert.equal(typeof loc.get, 'function'); assert.equal(typeof loc.set, 'function'); assert.equal(loc.enumerable, false);
  const closed = Object.getOwnPropertyDescriptor(h, 'closed');
  assert.equal(typeof closed.get, 'function'); assert.equal(closed.set, undefined);
  assert.throws(() => Object.getOwnPropertyDescriptor(h, 'document'), isSecurityError);
});

test('cross-origin window: child frames are reachable by index only up to length', () => {
  const { env, win } = xoriginEnv();
  const grandSame = win('http://a.test:3000');
  const grandCross = win('http://c.test:3000');
  const w = win('http://b.test:3000', { length: 2, 0: grandSame, 1: grandCross });
  const h = env.windowHandleFor(w);
  assert.equal(h[0], grandSame, 'a child of the SAME origin as us is ours to use');
  assert.notEqual(h[1], grandCross);
  assert.throws(() => h[1].document, isSecurityError);
  assert.throws(() => h[2], isSecurityError, 'past the last child natively throws');
  assert.deepEqual(Object.keys(h), ['0', '1']);
});

test("window handles: a frame's intended origin speaks for a window with no membrane yet", () => {
  const { env, win, urlMeta } = xoriginEnv();
  const blank = win('');                     // not booted: no __zp_get of its own
  const frame = {};
  assert.equal(env.windowHandleFor(blank, frame), blank, 'no route known: it is ours');
  urlMeta.set(frame, 'http://b.test:3000/page');
  const handle = env.windowHandleFor(blank, frame);
  assert.notEqual(handle, blank, 'sent to another site: restricted from the start');
  assert.throws(() => handle.document, isSecurityError);
});

test('window handles: a same-origin ancestor gets the ancestor stand-in, a cross-origin one the restricted one', () => {
  const { env, win, root } = xoriginEnv();
  const parentSame = win('http://a.test:3000');
  parentSame.parent = parentSame;
  root.parent = parentSame;
  const h = env.windowHandleFor(parentSame, 'ancestor');
  assert.deepEqual(Object.keys(h), ['safeFor']);
  const parentCross = win('http://b.test:3000');
  parentCross.parent = parentCross;
  root.parent = parentCross;
  const c = env.windowHandleFor(parentCross, 'ancestor');
  assert.throws(() => c.document, isSecurityError);
});

// ---------------------------------------------------------------------------
// The page's copy of the cookie jar. The service worker's jar is the truth; what
// it changes reaches each document as records (a response to the page's own fetch,
// and a push to every document that can see the cookie). A record is applied once
// per id, only if this document could read it, and a deletion removes.
// ---------------------------------------------------------------------------

const COOKIE_BLOCK = slice('  function initDocumentCookieRecords(cookieString) {', '  // ── virtual cookieStore');

function cookieEnv(href = 'http://app.a.test:3000/dir/page') {
  const events = [];
  const records = [];
  const env = load('let documentCookie = "";\n' + COOKIE_BLOCK,
    ['applyCookieChanges', 'setDocumentCookie', 'documentCookieString'],
    {
      virtualURL: new URL(href),
      documentCookieRecords: records,
      fireCookieChange: (changed, deleted) => events.push({ changed: changed.map(c => c.name), deleted: deleted.map(c => c.name) }),
      cookieItemFromRec: r => ({ name: r.name, value: r.value }),
    });
  return { env, events, records };
}
const change = (over = {}) => Object.assign({ id: 'e:1', name: 'tok', value: 'v1', domain: 'app.a.test', hostOnly: true, path: '/', secure: false, expires: null, deleted: false }, over);

test('cookie changes: a record is applied once per id, whether it came with the response or by push', () => {
  const { env, events } = cookieEnv();
  env.applyCookieChanges([change()]);
  env.applyCookieChanges([change()]);                      // the same change again (the push after the response)
  assert.equal(env.documentCookieString(), 'tok=v1');
  assert.equal(events.length, 1, 'one change event, not two');
  env.applyCookieChanges([change({ id: 'e:2', value: 'v2' })]);
  assert.equal(env.documentCookieString(), 'tok=v2', 'a new id updates');
  assert.equal(events.length, 2);
});

test('cookie changes: only what this document could read is kept', () => {
  const { env, records } = cookieEnv();
  env.applyCookieChanges([
    change({ id: 'x:1', name: 'other', domain: 'b.test' }),                                  // another site
    change({ id: 'x:2', name: 'sibling', domain: 'www.a.test' }),                            // host-only for a sibling host
    change({ id: 'x:3', name: 'wide', domain: 'a.test', hostOnly: false }),                  // Domain=a.test: this host reads it
    change({ id: 'x:4', name: 'narrow', domain: 'deep.app.a.test', hostOnly: false }),       // a subdomain's
  ]);
  assert.deepEqual(records.map(r => r.name), ['wide']);
  assert.equal(env.documentCookieString(), 'wide=v1');
});

test('cookie changes: a deletion removes, a session cookie never expires, a path scopes', () => {
  const { env, events } = cookieEnv('http://app.a.test:3000/dir/page');
  env.applyCookieChanges([change({ id: 'd:1', name: 'gone' }), change({ id: 'd:2', name: 'admin', path: '/admin' }), change({ id: 'd:3', name: 'dir', path: '/dir' })]);
  assert.equal(env.documentCookieString(), 'dir=v1; gone=v1', 'the longer path first; /admin is not this page\'s');
  env.applyCookieChanges([change({ id: 'd:4', name: 'gone', deleted: true, expires: 0 })]);
  assert.equal(env.documentCookieString(), 'dir=v1');
  assert.deepEqual(events.at(-1), { changed: [], deleted: ['gone'] }, 'cookieStore hears the deletion');
  env.applyCookieChanges([change({ id: 'd:5', name: 'past', expires: Date.now() - 1000 })]);
  assert.equal(env.documentCookieString(), 'dir=v1', 'an expiry in the past is not stored');
});

test('cookie changes: junk is ignored, the document\'s own write is unaffected', () => {
  const { env } = cookieEnv();
  env.applyCookieChanges(undefined);
  env.applyCookieChanges([null, {}, { name: 5, domain: 'app.a.test' }, change({ id: undefined, name: 'noid' })]);
  assert.equal(env.documentCookieString(), 'noid=v1', 'a record without an id is still applied');
  env.setDocumentCookie('mine=1; Path=/');
  assert.match(env.documentCookieString(), /mine=1/);
});
