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
