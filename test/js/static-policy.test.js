const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { preludeSource } = require('./_prelude.cjs');

// The membrane's tables are built by closure factories of the prelude (newMap …). Tests that cut a function out of the
// prelude and run it with `new Function` run it in global scope, where plain built-ins stand in for them: no page here
// patches the prototypes.
Object.assign(globalThis, {
  newMap: e => new Map(e), newSet: e => new Set(e), newWeakMap: () => new WeakMap(), newWeakSet: () => new WeakSet(),
});

const { classifyTape } = require('../browser/hole-matrix/classify.cjs');
const CASE_ID = url => { const m = /\/img\/([a-z0-9-]+)__(same|cross)\./.exec(url); return m && m[1]; };
const DIRECT = 'http://127.0.0.1:18098/img/x1-case__cross.png';
const req = (id, url) => ({ kind: 'request', request_id: id, url });

test('fixedCSP options.challengeCompat adds CF host only to four directives', () => {
  const code = fs.readFileSync('web/zp-core.js', 'utf8');
  const vm = require('node:vm');
  const sandbox = {
    globalThis: undefined,
    crypto: { getRandomValues: () => new Uint8Array(12) },
    URL: URL,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    Set: Set,
    Map: Map,
    self: undefined,
    console: console,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code + '\n;this.__zp = self.ZP;', sandbox);
  const ZP = sandbox.__zp;

  const off = ZP.fixedCSP([]);
  const on = ZP.fixedCSP([], { challengeCompat: true });
  assert.equal(off.includes('https://challenges.cloudflare.com'), false, 'off path must not contain CF host');
  const cfCount = (on.match(/https:\/\/challenges\.cloudflare\.com/g) || []).length;
  assert.equal(cfCount, 4, `armed CSP must mention CF host exactly 4 times, got ${cfCount}:\n${on}`);
  assert.ok(on.includes("script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://challenges.cloudflare.com"));
  assert.ok(on.includes('frame-src \'self\' blob: data: https://challenges.cloudflare.com'));
  assert.ok(on.includes('child-src \'self\' blob: data: https://challenges.cloudflare.com'));
  assert.match(on, /connect-src [^;]*https:\/\/challenges\.cloudflare\.com/);
  assert.equal(/style-src[^;]*https:\/\/challenges\.cloudflare\.com/.test(on), false);
  assert.equal(/img-src[^;]*https:\/\/challenges\.cloudflare\.com/.test(on), false);
  assert.equal(/worker-src[^;]*https:\/\/challenges\.cloudflare\.com/.test(on), false);
});

test('applyScriptPatches behavior: empty patches, splice, malformed envelopes', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8').split('\r\n').join('\n');
  const m = sw.match(/function applyScriptPatches\(source, envelopeJson\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'applyScriptPatches definition must be locatable');
  // eslint-disable-next-line no-new-func
  const apply = new Function(`${m[0]}\nreturn applyScriptPatches;`)();

  assert.equal(apply('', JSON.stringify({ len: 0, patches: [] })), '');
  assert.equal(apply('var x = 1;', JSON.stringify({ len: 10, patches: [] })), 'var x = 1;');
  const src = 'var u = location.href;';
  const env = JSON.stringify({ len: src.length, patches: [{ start: 8, end: 16, replacement: '__zp_loc' }] });
  assert.equal(apply(src, env), 'var u = __zp_loc.href;');
  const env2 = JSON.stringify({
    len: src.length,
    patches: [
      { start: 8, end: 16, replacement: '__zp_loc' },
      { start: 17, end: 21, replacement: '__zp_href_str' },
    ],
  });
  assert.equal(apply(src, env2), 'var u = __zp_loc.__zp_href_str;');
  assert.equal(apply(src, '{not json'), null);
  const bad = JSON.stringify({
    len: src.length,
    patches: [
      { start: 8, end: 16, replacement: 'A' },
      { start: 4, end: 7, replacement: 'B' },
    ],
  });
  assert.equal(apply(src, bad), null);
  const oob = JSON.stringify({ len: src.length, patches: [{ start: 0, end: 9999, replacement: 'X' }] });
  assert.equal(apply(src, oob), null);
  assert.equal(apply(src, JSON.stringify({ len: 10 })), null);
});

test('Referer follows the referrer policy (values pinned to a measured control run)', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8').split('\r\n').join('\n');
  const start = sw.indexOf('function refererForPolicy(');
  assert.ok(start > 0, 'refererForPolicy must exist in sw.js');
  const end = sw.indexOf('async function transportFetch', start);
  assert.ok(end > start, 'transportFetch must follow refererForPolicy');
  const sandbox = {};
  new Function('exports', sw.slice(start, end) + '\nexports.refererForPolicy = refererForPolicy;')(sandbox);
  const f = sandbox.refererForPolicy;

  const doc = 'http://127.0.0.1:18202/page?tag=t';
  const same = 'http://127.0.0.1:18202/same.js';
  const cross = 'http://127.0.0.1:18203/static.js';
  assert.equal(f(doc, same, ''), doc);
  assert.equal(f(doc, cross, ''), 'http://127.0.0.1:18202/');
  assert.equal(f(doc, cross, 'strict-origin-when-cross-origin'), 'http://127.0.0.1:18202/');
  assert.equal(f(doc, same, 'no-referrer'), '');
  assert.equal(f(doc, cross, 'no-referrer'), '');
  assert.equal(f(doc, same, 'origin'), 'http://127.0.0.1:18202/');
  assert.equal(f(doc, cross, 'origin'), 'http://127.0.0.1:18202/');
  assert.equal(f(doc, same, 'unsafe-url'), doc);
  assert.equal(f(doc, cross, 'unsafe-url'), doc);
  assert.equal(f(doc, same, 'same-origin'), doc);
  assert.equal(f(doc, cross, 'same-origin'), '');
  assert.equal(f(doc, cross, 'origin-when-cross-origin'), 'http://127.0.0.1:18202/');
  assert.equal(f(doc, same, 'origin-when-cross-origin'), doc);
  // HTTPS to HTTP is a downgrade; HTTP to HTTPS is not.
  assert.equal(f('https://a.example/p?q=1', 'http://b.example/x', ''), '');
  assert.equal(f('https://a.example/p?q=1', 'http://b.example/x', 'strict-origin'), '');
  assert.equal(f('https://a.example/p?q=1', 'http://a.example/x', 'no-referrer-when-downgrade'), '');
  assert.equal(f('http://a.example/p?q=1', 'https://b.example/x', ''), 'http://a.example/');
  // Fragments and credentials are always stripped per spec.
  assert.equal(f('https://u:pw@a.example/p?q=1#frag', 'https://a.example/x', ''), 'https://a.example/p?q=1');
  assert.equal(f('data:text/html,x', 'https://a.example/x', 'unsafe-url'), '');
});

test('cookie jar is keyed by registrable domain, and public-suffix Domain is rejected', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8').split('\r\n').join('\n');
  const start = sw.indexOf('const SECOND_LEVEL_SUFFIX');
  const endMark = 'function originKeyForURL';
  const end = sw.indexOf(endMark);
  assert.ok(start > 0 && end > start, 'registrable-domain helpers must exist in sw.js');
  const sandbox = {};
  new Function('exports', sw.slice(start, end) + '\nexports.registrableDomain = registrableDomain;'
    + '\nexports.isPublicSuffixDomain = isPublicSuffixDomain;')(sandbox);
  const { registrableDomain, isPublicSuffixDomain } = sandbox;

  assert.equal(registrableDomain('nid.naver.com'), 'naver.com');
  assert.equal(registrableDomain('www.naver.com'), 'naver.com');
  assert.equal(registrableDomain('mail.naver.com'), 'naver.com');
  assert.equal(registrableDomain('shop.example.co.kr'), 'example.co.kr');
  assert.equal(registrableDomain('example.co.kr'), 'example.co.kr');
  assert.notEqual(registrableDomain('a.example.com'), registrableDomain('a.example.net'));
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');

  assert.equal(isPublicSuffixDomain('com'), true);
  assert.equal(isPublicSuffixDomain('co.kr'), true);
  assert.equal(isPublicSuffixDomain('naver.com'), false);
  assert.equal(isPublicSuffixDomain('example.co.kr'), false);
});

test('proxied-document CSP is controlled from zp-shared (single golden, JS side)', () => {
  const golden = fs.readFileSync('crates/zp-shared/testdata/csp_proxied.golden', 'utf8').trim();
  const core = fs.readFileSync('web/zp-core.js', 'utf8');

  const sandbox = {
    location: { protocol: 'https:', host: 'proxy.example', href: 'https://proxy.example/zp/' },
    crypto: globalThis.crypto,
    URL, URLSearchParams, TextEncoder, TextDecoder, console, Object,
  };
  sandbox.globalThis = sandbox;
  new Function('globalThis', 'location', 'crypto', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
    core)(sandbox, sandbox.location, sandbox.crypto, URL, URLSearchParams, TextEncoder, TextDecoder);

  assert.equal(sandbox.ZP.fixedCSP(), golden,
    'ZP.fixedCSP drifted from crates/zp-shared/testdata/csp_proxied.golden — edit csp.rs, regenerate the golden, and update zp-core together');

  for (const invariant of ["default-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'"]) {
    assert.ok(golden.includes(invariant), 'proxied CSP lost ' + invariant);
  }
  assert.ok(!/connect-src [^;]*\*/.test(golden), 'connect-src must never wildcard');
  assert.ok(!/script-src [^;]*\*/.test(golden), 'script-src must never wildcard');
});

test('classify: proxy-origin subresources from runtime CSS map to the target only when ctx is present', () => {
  // Browser CSS resolution resolves root-relative url(/img/bg.png) against the document
  // URL on the proxy origin; classify maps those requests back to the active tab's target.
  const sw = fs.readFileSync('web/sw.js', 'utf8').split('\r\n').join('\n');
  const grab = (name) => {
    const start = sw.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' must exist in sw.js');
    const next = sw.indexOf('\nfunction ', start + 1);
    return sw.slice(start, next < 0 ? undefined : next);
  };
  const src = [grab('classify'), grab('internalPath'), grab('isRuntimeAPIPath')].join('\n');
  const ZP = {
    CONTROL_PREFIX: '/zp/',
    controlPath: (p) => '/zp/' + p,
    apiPath: (p) => '/zp/api/' + p,
    assetPath: (n) => '/zp/' + n,
  };
  const core = fs.readFileSync('web/zp-core.js', 'utf8');
  ZP.isInternalPath = new Function(
    'assetPath', 'controlPath',
    core.slice(core.indexOf('  const INTERNAL_ASSET_SCRIPTS'), core.indexOf('  function apiPath('))
      + '\nreturn isInternalPath;'
  )(ZP.assetPath, ZP.controlPath);
  const ORIGIN = 'http://proxy.localhost:18080';
  const classifyWith = (ctx) => new Function(
    'ZP', 'ORIGIN', 'contextFor', 'parseSharePath', 'shareRoutes', 'self',
    src + '\nreturn classify;'
  )(ZP, ORIGIN, () => ctx, () => null, new Map(), {});
  const req = { mode: 'no-cors', destination: 'image', headers: { get: () => null } };
  const ctx = { tabId: 'tab-1', entryId: 'e1' };
  const at = (path) => new URL(ORIGIN + path);

  const mapped = classifyWith(ctx)(req, at('/img/bg.png'), 'client-1');
  assert.equal(mapped.kind, 'VIRTUAL_SUBRESOURCE', 'runtime CSS subresource must map to target');
  assert.equal(mapped.sameOriginURL.pathname, '/img/bg.png');

  assert.equal(classifyWith(null)(req, at('/img/bg.png'), '').kind, 'UNKNOWN',
    'guessing target without ctx leaks across tabs');

  for (const p of ['/__zp/zp_page_rt.wasm?v=abc', '/zp/zp-core.js', '/zp/runtime-prelude.js']) {
    assert.equal(classifyWith(ctx)(req, at(p), 'client-1').kind, 'INTERNAL_ASSET', p + ' must stay internal');
  }
  assert.equal(classifyWith(ctx)(req, at('/zp/api/fetch?url=x'), 'client-1').kind, 'RUNTIME_API');
  assert.equal(classifyWith(ctx)(req, at('/zp/api/v2/fetch?url=x'), 'client-1').kind, 'RUNTIME_API');
});

test('v2 fetch envelope codec: [u32le head][raw body] round-trip without wire expansion', () => {
  const code = fs.readFileSync('web/zp-core.js', 'utf8');
  const vm = require('node:vm');
  const sandbox = { URL, TextEncoder, TextDecoder, Set, Map, crypto: { getRandomValues: () => new Uint8Array(12) }, console };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code + '\n;this.__zp = self.ZP;', sandbox);
  const ZP = sandbox.__zp;
  const head = { tabId: 't', url: 'https://t.example/x', init: { method: 'POST', body: null } };
  const body = new Uint8Array([0, 159, 146, 150, 255, 60, 0]);
  const env = ZP.encodeEnvelope(head, body);
  const headLen = new TextEncoder().encode(JSON.stringify(head)).length;
  assert.equal(env.length, 4 + headLen + body.length, 'envelope must not have base64 expansion');
  const dec = ZP.decodeEnvelope(env.buffer);
  assert.equal(JSON.stringify(dec.head), JSON.stringify(head));
  assert.deepEqual(Array.from(dec.body), Array.from(body));
  const empty = ZP.decodeEnvelope(ZP.encodeEnvelope(head, null));
  assert.equal(empty.body.length, 0);
  assert.throws(() => ZP.decodeEnvelope(new Uint8Array([1, 2])), /BAD_ENVELOPE/);
  assert.throws(() => ZP.decodeEnvelope(ZP.encodeEnvelope(head, null).subarray(0, 2)), /BAD_ENVELOPE/);
});

test('rewriteCSSText: rewrites only absolute cross-origin url() tokens and leaves comments and strings untouched', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const grab = (name) => {
    const start = rt.indexOf('  function ' + name + '(');
    assert.ok(start >= 0, name + ' not found');
    const next = rt.indexOf('\n  function ', start + 1);
    return rt.slice(start, next < 0 ? undefined : next);
  };
  const rewriteCSSText = new Function(
    'proxyOrigin', 'subresourceProxyPath',
    grab('cssProxyURL') + '\n' + grab('rewriteCSSText') + '\nreturn rewriteCSSText;'
  )('http://proxy.localhost:18080', (u) => '/zp/api/fetch?url=' + encodeURIComponent(u));

  assert.match(rewriteCSSText('#a{background:url(https://cdn.example.com/x.png)}'), /url\("\/zp\/api\/fetch\?url=https%3A%2F%2Fcdn/);
  assert.match(rewriteCSSText("@import 'https://cdn.example.com/a.css';"), /@import '\/zp\/api\/fetch/);
  assert.match(rewriteCSSText('@import url("https://cdn.example.com/a.css");'), /@import url\("\/zp\/api\/fetch/);

  // Relative URLs resolve against the document share path and are mapped by the SW.
  assert.equal(rewriteCSSText('#a{background:url(/img/x.png)}'), '#a{background:url(/img/x.png)}');
  assert.equal(rewriteCSSText('#a{background:url("./x.png")}'), '#a{background:url("./x.png")}');
  const mine = '#a{background:url(http://proxy.localhost:18080/zp/api/fetch?url=x)}';
  assert.equal(rewriteCSSText(mine), mine);

  const comment = '/* url(https://cdn.example.com/x.png) */#a{color:red}';
  assert.equal(rewriteCSSText(comment), comment);
  const content = '#a::before{content:"url(https://cdn.example.com/x.png)"}';
  assert.equal(rewriteCSSText(content), content);
});

test('containStyleDeclaration: rewrites property assignments and preserves method identity', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const start = rt.indexOf('  function containStyleDeclaration(');
  assert.ok(start >= 0, 'containStyleDeclaration not found');
  const next = rt.indexOf('\n  function ', start + 1);
  const src = rt.slice(start, next < 0 ? undefined : next);
  const contain = new Function(
    'styleDeclProxies', 'styleDeclMethods', 'rewriteCSSText', 'deproxyURL', 'maskNativeFunction',
    src + '\nreturn containStyleDeclaration;'
  )(new WeakMap(), new WeakMap(), (v) => String(v).replace('https://cdn.example.com', '/zp/api/fetch'),
    (v) => String(v).replace('/zp/api/fetch', 'https://cdn.example.com'), () => {});

  // CSS properties on CSSStyleDeclaration are own data properties on the instance.
  const decl = { backgroundImage: '', setProperty(p, v) { this[p] = v; }, getPropertyValue(p) { return this[p]; } };
  const p = contain(decl);
  p.backgroundImage = 'url(https://cdn.example.com/x.png)';
  assert.equal(decl.backgroundImage, 'url(/zp/api/fetch/x.png)', 'property assignment bypassed CSS rewriter');
  p.setProperty('mask-image', 'url(https://cdn.example.com/m.png)');
  assert.equal(decl['mask-image'], 'url(/zp/api/fetch/m.png)', 'setProperty bypassed CSS rewriter');

  assert.equal(contain(decl), p, 'returning a distinct proxy for the same declaration breaks identity checks');
  assert.equal(p.getPropertyValue, p.getPropertyValue, 'method identity is not stable across accesses');
  p.zIndex = 3;
  assert.equal(decl.zIndex, 3);
});

test('compileNested: new Function parameters and arguments are not shadowed by the with scope', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const grab = (name) => {
    const start = rt.indexOf('    function ' + name + '(');
    assert.ok(start >= 0, name + ' not found');
    const next = rt.indexOf('\n    function ', start + 1);
    return rt.slice(start, next < 0 ? undefined : next);
  };
  const compileNested = new Function(
    'zpTrace', 'rewriteDynamicFunctionBody', 'Native', 'ttFunction', 'ZP_WITH_PROLOGUE',
    grab('functionPrefix') + '\n' + grab('compileNested') + '\nreturn compileNested;'
  )(() => {}, (params, body) => String(body), { FunctionCtor: Function }, args => Reflect.construct(Function, args),
    new Function(['  const ZP_WITH_HELPERS = [', '  const ZP_WITH_PROLOGUE = ']
      .map(start => rt.slice(rt.indexOf(start), rt.indexOf(';\n', rt.indexOf(start)) + 2)).join('') + 'return ZP_WITH_PROLOGUE;')());

  // The withScope `has` trap returns true for all names, so parameters and __zp_args
  // must be bound inside or applied outside the `with` block to avoid being shadowed.
  const scope = new Proxy({}, { has: () => true, get: () => undefined });
  const call = (compiled, args) => compiled.apply(null, [scope, args]);

  const params = compileNested(['o,tmpl'], 'return [typeof o, typeof tmpl].join()', 'function');
  assert.equal(call(params, [1, {}]), 'number,object', 'parameters were shadowed by the with scope');

  const args = compileNested([], 'return arguments.length + ":" + arguments[0]', 'function');
  assert.equal(call(args, [9]), '1:9', 'arguments is empty because apply ran inside the with block');

  const free = compileNested([], 'return typeof somethingGlobal', 'function');
  assert.equal(call(free, []), 'undefined');
});

test('filteredCollection exposes contiguous indices like a native NodeList', () => {
  const rt = preludeSource().split('\r\n').join('\n');

  const helperStart = rt.indexOf('function isIndexKey(prop)');
  assert.ok(helperStart > 0);
  const helper = rt.slice(helperStart, rt.indexOf('\n  function deproxyURL(', helperStart));
  // Leading newline prevents a trailing line comment in `helper` from swallowing `return`.
  const make = new Function('isZPAttrName', helper + '\n; return filteredCollection;')(n => String(n || '').startsWith('data-zp-'));

  const raw = [{ name: 'a' }, { name: 'data-zp-x' }, { name: 'b' }, { name: 'c' }];
  const list = make(raw, item => !isZPName(item));
  function isZPName(item) { return String(item.name).startsWith('data-zp-'); }

  assert.strictEqual(list.length, 3, 'filtered items must be excluded from length');
  assert.strictEqual(list[2].name, 'c', 'indexing must follow the filtered item sequence');

  // Array.prototype.map/filter/forEach check HasProperty before reading an index.
  assert.strictEqual(1 in list, true);
  assert.deepStrictEqual(Array.prototype.map.call(list, e => e.name), ['a', 'b', 'c']);

  assert.deepStrictEqual(Object.keys(list), ['0', '1', '2']);

  const seen = [];
  list.forEach(e => seen.push(e.name));
  assert.deepStrictEqual(seen, ['a', 'b', 'c'], 'forEach must respect the filter');
  assert.deepStrictEqual([...list].map(e => e.name), ['a', 'b', 'c']);
});

test('classifyTape: response event marks a confirmed leak', () => {
  const v = classifyTape({ network: [req('1', DIRECT), { kind: 'response', request_id: '1', status: 200 }] }, CASE_ID);
  assert.deepEqual([...v.answered], ['x1-case']);
  assert.equal(v.blocked.size + v.unknown.size, 0);
});

test('classifyTape: failed event without response marks csp-only (blocked)', () => {
  const v = classifyTape({ network: [req('1', DIRECT), { kind: 'failed', request_id: '1' }] }, CASE_ID);
  assert.deepEqual([...v.blocked], ['x1-case']);
  assert.equal(v.answered.size, 0);
});

test('classifyTape: missing terminal event marks unknown rather than csp-only', () => {
  const v = classifyTape({ network: [req('1', DIRECT)] }, CASE_ID);
  assert.deepEqual([...v.unknown], ['x1-case']);
  assert.equal(v.blocked.size, 0, 'counting an unresolved request as blocked would mask a leak');
  assert.equal(v.answered.size, 0);
});

test('classifyTape: any answered attempt takes precedence over blocked attempts', () => {
  const v = classifyTape({
    network: [
      req('1', DIRECT), { kind: 'failed', request_id: '1' },
      req('2', DIRECT), { kind: 'response', request_id: '2', status: 200 },
    ],
  }, CASE_ID);
  assert.deepEqual([...v.answered], ['x1-case']);
  assert.equal(v.blocked.size, 0, 'reaching the target once is a leak even if another attempt was blocked');
});

test('classifyTape: response followed by failed still counts as a leak', () => {
  const v = classifyTape({
    network: [req('1', DIRECT), { kind: 'response', request_id: '1', status: 200 }, { kind: 'failed', request_id: '1' }],
  }, CASE_ID);
  assert.deepEqual([...v.answered], ['x1-case'], 'stream failure after receiving a response still contacted the target');
});

test('classifyTape: proxy-routed requests are not counted as direct target attempts', () => {
  const v = classifyTape({
    network: [
      { kind: 'request', request_id: '1', url: 'http://proxy.localhost:18080/zp/api/fetch?url=http%3A%2F%2F127.0.0.1%3A18098%2Fimg%2Fx1-case__cross.png' },
      { kind: 'response', request_id: '1', status: 200 },
    ],
  }, CASE_ID);
  assert.equal(v.attempted.size, 0, 'proxy-routed requests must not be counted as direct leaks');
});

test('splitSrcsetCandidates matches the Rust implementation (including data: URLs with commas)', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const grab = (name) => {
    const start = rt.indexOf('\n  function ' + name + '(');
    assert.ok(start >= 0, name + ' not found');
    const next = rt.indexOf('\n  function ', start + 1);
    return rt.slice(start, next < 0 ? undefined : next);
  };
  const split = new Function(grab('splitSrcsetCandidates') + '\nreturn splitSrcsetCandidates;')();
  const fixture = JSON.parse(fs.readFileSync('crates/zp-shared/testdata/srcset_cases.json', 'utf8'));
  for (const c of fixture.cases) {
    const got = split(c.input).map(x => [x.lead, x.url, x.tail]);
    assert.deepEqual(got, c.candidates, c.id + ': candidate split differs from Rust fixture');
    assert.equal(got.map(x => x.join('')).join(''), c.input, c.id + ': round-trip does not match input');
  }
});

test('?url= builder matches the Rust implementation byte-for-byte', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const grab = (name) => {
    const start = rt.indexOf('\n  function ' + name + '(');
    assert.ok(start >= 0, name + ' not found');
    const next = rt.indexOf('\n  function ', start + 1);
    return rt.slice(start, next < 0 ? undefined : next);
  };
  const fixture = JSON.parse(fs.readFileSync('crates/zp-shared/testdata/proxy_url_cases.json', 'utf8'));
  for (const c of fixture.cases) {
    const build = new Function(
      'proxyOrigin', 'ZP', 'boot', 'nativeEncodeURIComponent',
      grab('encodeURLParam') + '\n' + grab('subresourceProxyPath') + '\nreturn subresourceProxyPath;'
    )('http://proxy.example', { apiPath: (n) => '/zp/api/' + n }, c.tab ? { tabId: c.tab } : null, encodeURIComponent);
    assert.equal(build(c.url), c.want, c.id + ': page-realm output differs from Rust fixture');
  }
});

test('shared URL acceptance policy: JS implementation matches the shared fixture', () => {
  const cases = JSON.parse(fs.readFileSync('crates/zp-shared/testdata/shareurl_cases.json', 'utf8'));

  const core = fs.readFileSync('web/zp-core.js', 'utf8');
  const sandbox = {
    location: { protocol: 'https:', host: 'proxy.example', href: 'https://proxy.example/zp/' },
    crypto: globalThis.crypto,
    URL, URLSearchParams, TextEncoder, TextDecoder, console, Object,
  };
  sandbox.globalThis = sandbox;
  new Function('globalThis', 'location', 'crypto', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
    core)(sandbox, sandbox.location, sandbox.crypto, URL, URLSearchParams, TextEncoder, TextDecoder);

  // WHATWG URL accepts a single slash after a special scheme (`https:/single-slash` resolves
  // to host `single-slash`), whereas the stricter Rust parser rejects it as Malformed.
  const INTENDED = new Map([['https:/single-slash', true]]);

  const mismatches = [];
  for (const c of cases) {
    let ok = true;
    try { sandbox.ZP.canonicalTargetURL(c.input); } catch { ok = false; }
    const want = INTENDED.has(c.input) ? INTENDED.get(c.input) : c.ok;
    if (ok !== want) mismatches.push(`${JSON.stringify(c.input)}: expected ok=${want}, got JS ok=${ok}`);
  }
  assert.deepEqual(mismatches, [], 'JS URL classifier diverged from shared fixture:\n  ' + mismatches.join('\n  '));
});

test('resolveProxyOrigin does not return "null" inside opaque-origin frames', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const start = rt.indexOf('function resolveProxyOrigin(');
  assert.ok(start > 0, 'resolveProxyOrigin not found');
  const end = rt.indexOf('\n  const toStringMap', start);
  const fn = new Function('winGet', rt.slice(start, end) + '; return resolveProxyOrigin;')((w, n) => w[n]);

  const opaque = new URL('about:srcdoc');
  const real = new URL('http://proxy.localhost:18080/zp/p/tok');

  assert.strictEqual(fn(real, {}, {}), 'http://proxy.localhost:18080');

  assert.strictEqual(fn(opaque, { proxyOrigin: 'http://proxy.localhost:18080' }, {}),
    'http://proxy.localhost:18080');

  const top = { location: { origin: 'http://proxy.localhost:18080' } };
  const mid = { location: { origin: 'null' } };
  mid.parent = top; top.parent = top;
  const leaf = { parent: mid, location: { origin: 'null' } };
  assert.strictEqual(fn(opaque, {}, leaf), 'http://proxy.localhost:18080');

  const lone = { parent: null };
  assert.strictEqual(fn(opaque, {}, lone), 'null');
});

test('deproxyURL: unified table handles all three caller modes', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const grab = (head) => {
    const start = rt.indexOf(head);
    assert.ok(start >= 0, head + ' not found');
    const next = rt.indexOf('\n  function ', start + 1);
    return rt.slice(start, next < 0 ? undefined : next);
  };
  const src = rt.slice(rt.indexOf('  function deproxyURL(raw, opts) {'), rt.indexOf('  function scrubbedClone(node) {'));

  const PROXY = 'http://proxy.example';
  const VIRT = 'https://target.example/page';
  const make = () => new Function('proxyOrigin', 'ZP', 'Native', 'virtualURL',
    src + '\nreturn deproxyURL;'
  )(PROXY, {
    apiPath: (n) => '/zp/api/' + n,
    isSharePath: (p) => p.startsWith('/zp/p/'),
  }, { URL }, new URL(VIRT));
  const f = make();

  const T = 'https://t.example/a.png';
  const enc = encodeURIComponent(T);

  for (const opts of [{ fallback: 'any' }, { fallback: 'share' }, { scan: true }]) {
    assert.equal(f(PROXY + '/zp/api/fetch?url=' + enc + '&tab=x', opts), T,
      JSON.stringify(opts) + ': failed to unwrap ?url=');
    assert.equal(f(PROXY + '/zp/api/script?kind=classic&u=' + enc, opts), T,
      JSON.stringify(opts) + ': failed to unwrap &u=');
    assert.equal(f(PROXY + '/zp/?via=' + enc, opts), T,
      JSON.stringify(opts) + ': failed to unwrap ?via=');
    assert.equal(f('https://other.example/x', opts), 'https://other.example/x');
  }

  const unknown = PROXY + '/zp/whatever';
  assert.equal(f(unknown, { fallback: 'any' }), VIRT, 'form mode: unknown proxy URL falls back to document target');
  assert.equal(f(unknown, { fallback: 'share' }), VIRT, 'timing mode: internal /zp/ path falls back to document target');
  assert.equal(f(PROXY + '/zp/p/tok', { fallback: 'share' }), VIRT, 'timing mode: share path falls back to document target');
  assert.equal(f(unknown, { scan: true }), unknown, 'serialization mode: unknown URL is preserved');

  const two = 'url("' + PROXY + '/zp/api/fetch?url=' + enc + '"), url(\'' + PROXY + '/zp/api/fetch?url=' + encodeURIComponent('https://t.example/b.png') + '\')';
  assert.equal(f(two, { scan: true }), 'url("' + T + '"), url(\'https://t.example/b.png\')');
  assert.equal(f(two, { fallback: 'share' }), two, 'must not scan inside composite strings without scan: true');
});

test('safeCrossWindow: climbing .parent reaches window.top', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const start = rt.indexOf('    function climbCrossWindow(targetWindow, prop, fallback) {');
  assert.ok(start >= 0, 'climbCrossWindow not found');
  // The same-origin stand-in ends where the window-handle policy begins.
  const end = rt.indexOf('    // ── which windows a page may hold, and in what form');
  assert.ok(end > start && end > rt.indexOf('    function safeCrossWindow(targetWindow) {'), 'safeCrossWindow section not found');

  const src = rt.slice(start, end);
  const make = new Function('root', 'scope', 'postMessageWrapperFor', 'crossWindowProxyCache', 'crossWindowTargets',
    'definePropertiesMasked', 'windowHandleFor', 'get', 'ZP_HIDDEN_RE', 'MEMBER_DANGER', 'winGet',
    src + '\nreturn safeCrossWindow;');

  const top = { name: 'top' };
  const mid = { name: 'mid' };
  const leaf = { name: 'leaf' };
  top.top = top; top.parent = top;
  mid.top = top; mid.parent = top;
  leaf.top = top; leaf.parent = mid;

  const scope = { name: 'scope(leaf)' };
  // climbCrossWindow asks the handle policy for each step; for same-origin
  // windows the policy's answer IS this stand-in, so late-bind it.
  let safeRef = null;
  const safeCrossWindow = make(leaf, scope, () => () => {}, new WeakMap(), new WeakMap(), Object.defineProperties,
    w => safeRef(w), () => {}, /^__zp_/, new Set(), (w, n) => w[n]);
  safeRef = safeCrossWindow;

  const windowTop = safeCrossWindow(top);
  let w = scope;
  let steps = 0;
  let reached = false;
  while (steps < 30) {
    if (w === windowTop) { reached = true; break; }
    w = w === scope ? safeCrossWindow(leaf.parent) : w.parent;
    steps++;
  }
  assert.ok(reached,
    'climbing .parent from a grandchild frame did not reach window.top');
  assert.ok(steps <= 3, 'parent chain exceeded expected depth: ' + steps);

  assert.equal(safeCrossWindow(top), safeCrossWindow(top), 'cross-window proxy must be cached per target window');
  assert.equal(safeCrossWindow(mid).parent, safeCrossWindow(top), 'mid.parent must equal the top proxy');
  assert.equal(safeCrossWindow(mid).top, safeCrossWindow(top), 'mid.top must equal the top proxy');

  assert.equal(safeCrossWindow(top).parent, safeCrossWindow(top), 'top.parent must return itself');

  const hostile = { get parent() { throw new Error('cross-origin'); }, get top() { throw new Error('cross-origin'); } };
  const hp = safeCrossWindow(hostile);
  assert.equal(hp.parent, hp, 'throwing .parent getter must fall back to self');
});

test('filteredCollection exposes only properties present on the underlying collection', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const start = rt.indexOf('  function isIndexKey(prop) {');
  const end = rt.indexOf('\n  function ', rt.indexOf('  function filteredCollection(raw, predicate) {') + 1);
  assert.ok(start >= 0 && end > start, 'filteredCollection section not found');
  const make = new Function('isZPAttrName', 'maskNativeFunction',
    rt.slice(start, end) + '\nreturn filteredCollection;')(() => false, () => {});

  const nlRaw = [{ name: 'a' }, { name: 'b' }];
  nlRaw.item = (i) => nlRaw[i] || null;
  const nl = make(nlRaw, () => true);
  // HTMLCollection exposes @@iterator (Array.prototype.values) without forEach/values/keys/entries.
  const bare = { length: 2, 0: { name: 'a' }, 1: { name: 'b' }, item(i) { return this[i] || null; } };
  bare[Symbol.iterator] = Array.prototype.values;
  const hc = make(bare, () => true);

  for (const k of ['forEach', 'values', 'keys', 'entries']) {
    assert.equal(nl[k], Array.prototype[k], 'NodeList.' + k + ' must equal Array.prototype.' + k);
    assert.equal(typeof hc[k], 'undefined', 'HTMLCollection must not expose ' + k);
  }
  assert.equal(nl[Symbol.iterator], Array.prototype.values, '@@iterator must equal Array.prototype.values');
  assert.equal(hc[Symbol.iterator], Array.prototype.values, 'underlying @@iterator must be preserved');

  for (const k of ['forEach', 'values', 'keys', 'entries']) {
    assert.equal(typeof hc[k] === 'function', (k in bare), 'HTMLCollection: `in` operator disagrees with property read for ' + k);
    assert.equal(typeof nl[k] === 'function', (k in nlRaw), 'NodeList: `in` operator disagrees with property read for ' + k);
  }

  assert.equal(nl.item, nl.item, 'item method must be cached across accesses');
  assert.equal(hc.item, hc.item, 'item method must be cached across accesses on bare collection');
  const withNamed = { length: 0, item() { return null; }, namedItem() { return null; } };
  withNamed[Symbol.iterator] = Array.prototype.values;
  const wn = make(withNamed, () => true);
  assert.equal(typeof wn.namedItem, 'function', 'fallback method namedItem is missing');
  assert.equal(wn.namedItem, wn.namedItem, 'fallback method must be cached across accesses');

  const mixRaw = [{ name: 'keep1' }, { name: 'drop' }, { name: 'keep2' }];
  mixRaw.item = (i) => mixRaw[i] || null;
  const mixed = make(mixRaw, (x) => x && x.name !== 'drop');
  assert.equal(mixed.length, 2, 'filter did not exclude hidden items');
  assert.deepEqual([...mixed].map((x) => x.name), ['keep1', 'keep2'], '@@iterator bypassed the filter');
  const viaForEach = [];
  mixed.forEach((x) => viaForEach.push(x.name));
  assert.deepEqual(viaForEach, ['keep1', 'keep2'], 'forEach bypassed the filter');
  assert.deepEqual([...mixed.values()].map((x) => x.name), ['keep1', 'keep2'], 'values() bypassed the filter');
  assert.deepEqual(Array.prototype.map.call(mixed, (x) => x.name), ['keep1', 'keep2'], 'Array.prototype.map bypassed the filter');
  assert.deepEqual(Object.keys(mixed), ['0', '1'], 'Object.keys did not follow filtered indices');

  const liveRaw = [{ name: 'x' }];
  liveRaw.item = (i) => liveRaw[i] || null;
  const live = make(liveRaw, () => true);
  const walked = [];
  for (const it of live) {
    walked.push(it.name);
    if (walked.length === 1) liveRaw.push({ name: 'y' });
    if (walked.length > 4) break;
  }
  assert.deepEqual(walked, ['x', 'y'], 'live iteration did not observe mutations on the underlying collection');
});

test('filteredCollection iteration is O(N)', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const start = rt.indexOf('  function isIndexKey(prop) {');
  assert.ok(start >= 0, 'isIndexKey not found');
  const end = rt.indexOf('\n  function ', rt.indexOf('  function filteredCollection(raw, predicate) {') + 1);
  assert.ok(end > start, 'filteredCollection section not found');
  const src = rt.slice(start, end);
  const make = new Function('isZPAttrName',
    src + '\nreturn filteredCollection;')(() => false);

  const N = 500;
  const raw = [];
  for (let i = 0; i < N; i++) raw.push({ name: 'a' + i, nodeType: 1 });
  let calls = 0;
  const list = make(raw, () => { calls++; return true; });

  calls = 0;
  let seen = 0;
  for (const _ of list) seen++;
  assert.equal(seen, N, 'iteration did not visit all elements');
  assert.ok(calls <= N * 2, 'for-of is not O(N): predicate called ' + calls + ' times (N=' + N + ')');

  for (const how of ['forEach', 'values', 'entries']) {
    const l2 = make(raw, () => { calls++; return true; });
    calls = 0;
    if (how === 'forEach') l2.forEach(() => {});
    else { let c = 0; for (const _ of l2[how]()) c++; assert.equal(c, N, how + ' did not visit all elements'); }
    assert.ok(calls <= N * 2, how + ' is not O(N): predicate called ' + calls + ' times');
  }

  const l3 = make(raw, () => { calls++; return true; });
  calls = 0;
  for (let i = 0; i < N; i++) void l3[i];
  assert.ok(calls <= N * 2, 'index access is not O(N): predicate called ' + calls + ' times');

  const mixed = [{ name: 'keep1' }, { name: 'drop' }, { name: 'keep2' }];
  const filtered = make(mixed, (x) => x && x.name !== 'drop');
  assert.equal(filtered.length, 2, 'filter did not exclude hidden items');
  assert.deepEqual([...filtered].map((x) => x.name), ['keep1', 'keep2'], 'iteration bypassed the filter');
  assert.equal(filtered[1] && filtered[1].name, 'keep2', 'index access bypassed the filter');

  const live = [{ name: 'a' }];
  const lv = make(live, () => true);
  assert.equal(lv.length, 1);
  live.push({ name: 'b' });
  assert.equal(lv.length, 2, 'snapshot cache did not refresh after underlying length grew');
});

test('document encoded size is not evicted by subresource bursts', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8').split('\r\n').join('\n');
  const start = sw.indexOf('const docEncodedByUrl = new Map();');
  assert.ok(start >= 0, 'docEncodedByUrl not found');
  const end = sw.indexOf('function deliverStreamEncoded(');
  assert.ok(end > start, 'recordEncoded section not found');
  const src = 'const streamEncodedByUrl = new Map();\n' + sw.slice(start, end);
  const { recordEncoded, docEncodedByUrl, streamEncodedByUrl } =
    new Function(src + '\nreturn { recordEncoded, docEncodedByUrl, streamEncodedByUrl };')();

  const DOC = 'https://target.example/page';
  recordEncoded(DOC, 14010, true);
  for (let i = 0; i < 200; i++) recordEncoded('https://target.example/beacon/' + i, 20, false);

  assert.equal(docEncodedByUrl.get(DOC), 14010,
    '200 subresources evicted the document encoded-size entry');
  assert.ok(streamEncodedByUrl.size <= 32, 'subresource map exceeded its size cap');
  for (let i = 0; i < 50; i++) recordEncoded('https://target.example/doc/' + i, 1, true);
  assert.ok(docEncodedByUrl.size <= 8, 'document map exceeded its size cap');
});

test('trap notebook INDEX stays one line per entry, with a link that resolves', () => {
  const dir = '.ai/trap-notebook/';
  const lines = fs.readFileSync(dir + 'INDEX.md', 'utf8').split(/\r?\n/);
  const headers = lines.filter(l => /^\|\s*Date\s*\|/.test(l));
  assert.equal(headers.length, 1, 'expected exactly one table header in INDEX.md');
  const headerAt = lines.findIndex(l => /^\|\s*Date\s*\|/.test(l));
  const rows = lines.filter((l, i) => l.startsWith('|') && i > headerAt && !/^\|\s*-+/.test(l));

  const seenDates = [];
  const details = new Map();
  for (const row of rows) {
    const cells = row.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(s => s.trim());
    assert.equal(cells.length, 4, `expected 4 columns (date/category/summary/link): ${row.slice(0, 80)}`);
    const [date, cat, summary, link] = cells;
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/, `invalid date format: ${row.slice(0, 60)}`);
    assert.ok(cat.length > 0 && cat.length <= 60, `invalid category cell: ${row.slice(0, 60)}`);
    assert.ok(summary.length <= 160, `summary exceeds 160 chars (${summary.length}): ${summary.slice(0, 60)}…`);
    assert.match(link, /^[A-Za-z0-9-]+\.md#\S+$/, `link cell must match <file>.md#<anchor>: ${row.slice(0, 80)}`);
    const [file, anchor] = link.split('#');
    if (!details.has(file)) details.set(file, fs.readFileSync(dir + file, 'utf8'));
    const detail = details.get(file);
    assert.ok(detail, `linked file does not exist: ${file}`);
    assert.ok(detail.includes(anchor), `anchor does not exist: ${link} (expected {#${anchor}} on the section heading)`);
    seenDates.push(date);
  }
  const sorted = [...seenDates].sort().reverse();
  assert.deepEqual(seenDates, sorted, 'INDEX.md entries must be sorted in descending date order');
});

test('proxy navigation URLs are absolute so a target <base href> cannot retarget them', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const start = rt.indexOf('function proxyAbsoluteURL(');
  assert.ok(start > 0, 'proxyAbsoluteURL must exist');
  const end = rt.indexOf('\n  }', start) + 4;
  const make = new Function('proxyOrigin', rt.slice(start, end) + '\nreturn proxyAbsoluteURL;');
  const f = make('http://proxy.localhost:18080');
  assert.equal(f('/zp/p/tok#k=1'), 'http://proxy.localhost:18080/zp/p/tok#k=1');
  assert.equal(f('/zp/p/tok?zp_submit=9#k=1'), 'http://proxy.localhost:18080/zp/p/tok?zp_submit=9#k=1');
  assert.equal(f('http://proxy.localhost:18080/zp/p/tok'), 'http://proxy.localhost:18080/zp/p/tok');
});

test('transportFetch enforces a deadline on kernelFetch', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8').split('\r\n').join('\n');
  const fn = sw.slice(sw.indexOf('function withTransportDeadline('), sw.indexOf('async function transportFetch('));
  const make = new Function('TRANSPORT_DEADLINE_MS', 'logRefusal', fn + '; return withTransportDeadline;');
  const seen = [];
  const withDeadline = make(20, (code, status, url) => seen.push([code, status, url]));
  return (async () => {
    let err = null;
    try { await withDeadline(new Promise(() => {}), 'https://t/x', 'GET'); } catch (e) { err = e; }
    assert.ok(err && err.zpTransportTimeout, 'stalled request must reject with zpTransportTimeout');
    assert.deepEqual(seen[0], ['TRANSPORT_DEADLINE', 504, 'https://t/x']);
    const ok = await withDeadline(Promise.resolve('resp'), 'https://t/y', 'GET');
    assert.equal(ok, 'resp');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(seen.length, 1, 'timer for a completed request must not fire later');
  })();
});

test('SW response path does not await clients.get', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8').split('\r\n').join('\n');
  const src = sw.slice(sw.indexOf('async function reportEncodedSize('), sw.indexOf('function encodedSizeKey('));
  const make = new Function(
    'self', 'pendingStreamReports', 'isNavigationRequest', 'recordEncoded', 'encodedSizeKey', 'Response', 'Headers',
    src + '; return reportEncodedSize;'
  );
  const never = new Promise(() => {});
  const fakeSelf = { clients: { get: () => never } };
  const reported = [];
  const reportEncodedSize = make(
    fakeSelf, new Map(), () => true, (url, size) => reported.push([url, size]),
    (u) => u, Response, Headers
  );
  const resp = new Response('body', { headers: { 'X-ZP-Encoded-Size': '1234', 'X-ZP-Encoded-For': 'https://t/doc' } });
  const event = { clientId: '', resultingClientId: 'reserved-id', request: { url: 'http://proxy.localhost/zp/p/x' } };
  return Promise.race([
    reportEncodedSize(event, resp),
    new Promise((_, rej) => setTimeout(() => rej(new Error('response hung waiting for clients.get')), 500)),
  ]).then((out) => {
    assert.equal(out.status, 200, 'response must resolve even if clients.get never settles');
    assert.equal(out.headers.get('X-ZP-Encoded-Size'), null, 'internal X-ZP-Encoded-Size header must be stripped');
    assert.deepEqual(reported, [['https://t/doc', 1234]], 'pull path (recordEncoded) must remain intact');
  });
});

test('early child-window postMessage wrapper restores native postMessage on boot', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const from = rt.indexOf('  const earlyNativeKey =');
  const restoreAt = rt.indexOf('  function restoreNativePostMessage(w) {', from);
  assert.ok(from >= 0 && restoreAt > from, 'both install and restore functions must exist');
  const endMark = '\n  }\n';
  const to = rt.indexOf(endMark, restoreAt) + endMark.length;
  const body = rt.slice(from, to);
  const make = new Function('postMessageWrapperFor', 'maskNativeFunction',
    body + '; return { installEarlyPostMessage, restoreNativePostMessage };');

  const nativePm = function postMessage(m, t) { return [m, t]; };
  const wrapper = function postMessage(m, t, x) { return nativePm(m, t, x); };
  const api = make(() => wrapper, () => {});

  const fakeWin = {};
  Object.defineProperty(fakeWin, 'postMessage', { value: nativePm, enumerable: true, configurable: true, writable: true });
  api.installEarlyPostMessage(fakeWin);
  const booted = { __zp_get() {} };
  Object.defineProperty(booted, 'postMessage', { value: nativePm, enumerable: true, configurable: true, writable: true });
  api.installEarlyPostMessage(booted);
  assert.equal(booted.postMessage, nativePm, 'already-booted window must not receive the early wrapper');
  assert.equal(fakeWin.postMessage, wrapper, 'unbooted window must receive the early wrapper');
  api.restoreNativePostMessage(fakeWin);
  assert.equal(fakeWin.postMessage, nativePm, 'native postMessage must be restored after boot');

  const untouched = {};
  Object.defineProperty(untouched, 'postMessage', { value: nativePm, enumerable: true, configurable: true, writable: true });
  api.restoreNativePostMessage(untouched);
  assert.equal(untouched.postMessage, nativePm);
});

test('top-level document does not send its own URL as Referer when browser omits referrer', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8').split('\r\n').join('\n');
  const from = sw.indexOf('function referrerFromBrowserHeader(req) {');
  assert.ok(from >= 0);
  const endMark = '\n}\n';
  const to = sw.indexOf(endMark, from) + endMark.length;
  const make = new Function('ORIGIN', 'contextFromURL', sw.slice(from, to) + '; return referrerFromBrowserHeader;');
  const ORIGIN = 'http://proxy.localhost:18080';
  const routes = new Map([['/zp/p/AAA', { targetUrl: 'https://news.example/article', baseUrl: '' }]]);
  const fn = make(ORIGIN, (u) => routes.get(u.pathname) || null);
  const req = (ref) => ({ referrer: ref || '', headers: { get: () => null } });
  const reqHeaderOnly = (ref) => ({ referrer: 'about:client', headers: { get: (n) => (n === 'Referer' ? ref : null) } });

  assert.equal(fn(req(null)), '', 'must not synthesize Referer when browser omitted it');
  assert.equal(fn(req(ORIGIN + '/zp/p/AAA')), 'https://news.example/article');
  assert.equal(fn(req(ORIGIN + '/zp/')), '', 'non-route proxy URL must not leak as Referer');
  assert.equal(fn(req('https://other.example/page')), 'https://other.example/page');
  assert.equal(fn(reqHeaderOnly(ORIGIN + '/zp/p/AAA')), 'https://news.example/article');
  assert.equal(fn(reqHeaderOnly(null)), '');
});

test('page fetch reads meta referrer policy at request time', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const from = rt.indexOf('  function documentReferrerPolicy() {');
  assert.ok(from >= 0);
  const endMark = '\n  }\n';
  const to = rt.indexOf(endMark, from) + endMark.length;
  const make = new Function('Native', 'document', rt.slice(from, to) + '; return documentReferrerPolicy;');
  const metas = (...vals) => vals.map((v) => ({ content: v }));
  const Native = {
    querySelectorAll: { call: (_d, sel) => (/meta\[name="referrer" i\]/.test(sel) ? _d.__metas : []) },
    getAttribute: { call: (el, n) => (n === 'content' ? el.content : null) },
  };
  const fn = make(Native, { __metas: [] });
  assert.equal(fn(), '', 'returns empty string when no meta referrer is present');

  const fn2 = new Function('Native', 'document', rt.slice(from, to) + '; return documentReferrerPolicy;')(
    Native, { __metas: metas('origin', '  NO-REFERRER  ') }
  );
  assert.equal(fn2(), 'no-referrer', 'last meta declaration wins and whitespace/case are normalized');

  const fn3 = new Function('Native', 'document', rt.slice(from, to) + '; return documentReferrerPolicy;')(
    Native, { __metas: metas('same-origin', '') }
  );
  assert.equal(fn3(), 'same-origin', 'empty content attribute does not clear an earlier declaration');
});

test('dataset hides the data-zp namespace without blocking page-owned data', () => {
  const rt = preludeSource().split('\r\n').join('\n');

  const dsStart = rt.indexOf('  function datasetKeyToAttrName(key) {');
  const dsEnd = rt.indexOf('  function installZPAttrNamespace(w) {');
  assert.ok(dsStart > 0 && dsEnd > dsStart, 'dataset filter section not found');
  const filteredDataset = new Function('isZPAttrName',
    rt.slice(dsStart, dsEnd) + '\nreturn filteredDataset;')(n => String(n || '').startsWith('data-zp-'));
  const rawDs = { zpTargetUrl: 'https://target.example/', zpInternal: '1', pageOwn: 'keep' };
  const ds = filteredDataset(rawDs);
  assert.equal(ds.zpTargetUrl, undefined, 'target URL leaked through dataset');
  assert.equal('zpInternal' in ds, false, '`in` operator on dataset exposed internal zp key');
  assert.deepEqual(Object.keys(ds), ['pageOwn'], 'Object.keys(dataset) exposed internal zp key');
  assert.equal(ds.pageOwn, 'keep', 'page-owned dataset entry was corrupted');
  ds.zpInternal = 'forged';
  assert.equal(rawDs.zpInternal, '1', 'writing a reserved dataset key overwrote the underlying DOM attribute');
  delete ds.zpTargetUrl;
  assert.equal(rawDs.zpTargetUrl, 'https://target.example/', 'deleting via dataset removed the internal stash');
  ds.pageOwn = 'changed';
  assert.equal(rawDs.pageOwn, 'changed', 'page-owned dataset write was blocked');
  assert.equal(filteredDataset(rawDs), ds, 'dataset proxy must be cached per DOMStringMap');
});

test('filteredCollection preserves filtering on named property access', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const start = rt.indexOf('  function isIndexKey(prop) {');
  const end = rt.indexOf('\n  function ', rt.indexOf('  function filteredCollection(raw, predicate) {') + 1);
  assert.ok(start >= 0 && end > start, 'filteredCollection section not found');
  const make = new Function('isZPAttrName', 'maskNativeFunction',
    rt.slice(start, end) + '\nreturn filteredCollection;')(n => String(n || '').startsWith('data-zp-'), () => {});

  const hidden = { name: 'data-zp-target-url', value: 'https://target.example/', ownerElement: {} };
  const shown = { name: 'href', value: '/x', ownerElement: {} };
  const raw = { length: 2, 0: shown, 1: hidden, 'href': shown, 'data-zp-target-url': hidden,
    getNamedItem(n) { return this[n] || null; } };
  raw[Symbol.iterator] = Array.prototype.values;
  const nn = make(raw, attr => attr && !String(attr.name).startsWith('data-zp-'));

  assert.equal(nn['data-zp-target-url'], undefined, 'hidden item leaked via named property read');
  assert.equal('data-zp-target-url' in nn, false, '`in` operator exposed hidden named item');
  assert.equal(nn['href'], shown, 'visible item was hidden on named property read');
  assert.equal('href' in nn, true, 'visible item was hidden from `in` operator');
  raw.someScalar = 7;
  assert.equal(nn.someScalar, 7, 'non-item scalar property was filtered out');
  assert.equal(typeof nn.getNamedItem, 'function', 'method fallback was lost');
  assert.equal(nn.length, 1);
  assert.deepEqual(Array.prototype.map.call(nn, a => a.name), ['href']);

  const nnmStart = rt.indexOf('  const namedNodeMapCache = newWeakMap();');
  assert.ok(nnmStart > 0, 'attributes cache not found');
  const nnmEnd = rt.indexOf('\n  function ', rt.indexOf('  function filteredNamedNodeMap(', nnmStart) + 1);
  const wrap = new Function('isZPAttrName',
    rt.slice(nnmStart, nnmEnd) + '\n' + rt.slice(start, end) + '\nreturn filteredNamedNodeMap;')(
    n => String(n || '').startsWith('data-zp-'));
  assert.equal(wrap(raw), wrap(raw), 'el.attributes must return a cached proxy instance');
});

test('non-HTTP(S) absolute URLs are returned verbatim by attribute getters', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const from = rt.indexOf('  function nonHTTPAbsoluteURL(raw) {');
  assert.ok(from > 0, 'nonHTTPAbsoluteURL not found');
  const to = rt.indexOf('\n  }', from) + 4;
  const fn = new Function(rt.slice(from, to) + '\nreturn nonHTTPAbsoluteURL;')();

  for (const v of ['blob:http://proxy.localhost:18080/abc-123', 'data:video/mp4;base64,AAAA',
    'about:blank', 'mailto:a@b.c', 'tel:+1', 'javascript:void 0', 'ws://x/y']) {
    const got = fn(v);
    assert.ok(got !== null, v + ' still routes through targetURL and throws on read');
    assert.equal(typeof got, 'string');
  }
  assert.equal(fn('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(fn('about:blank'), 'about:blank');
  assert.equal(fn('blob:http://p/1'), 'blob:http://p/1');

  for (const v of ['https://x/y', 'HTTP://x/y', '//x/y', '/rel', 'rel', '#frag', '', '?q=1']) {
    assert.equal(fn(v), null, v + ' matched nonHTTPAbsoluteURL and would bypass rewriting');
  }
});

test('blob: and data: worker URLs always route through the srcu rewrite bootstrap regardless of MIME', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const from = rt.indexOf('  function workerBootstrapURL(url, opts) {');
  assert.ok(from > 0, 'workerBootstrapURL not found');
  const body = rt.slice(from, rt.indexOf('\n  function ', from + 10));

  const blobIdx = body.indexOf("parsed.protocol === 'blob:'");
  const dataIdx = body.indexOf("parsed.protocol === 'data:'");
  assert.ok(blobIdx > 0 && dataIdx > blobIdx, 'blob:/data: branch not found');
  const segment = body.slice(blobIdx, body.indexOf('const params', blobIdx));
  assert.ok(segment.includes('srcWorkerBootstrapURL'), 'blob:/data: did not route to srcWorkerBootstrapURL');
  assert.ok(!/return\s+parsed\.href/.test(segment), 'blob:/data: returned raw parsed.href and bypassed rewriting');
});

test('fetch passes inline schemes directly to the browser', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const from = rt.indexOf('  function inlineSchemeFetchURL(input) {');
  assert.ok(from > 0, 'inlineSchemeFetchURL not found');
  const fn = new Function(rt.slice(from, rt.indexOf('\n  }', from) + 4) + '\nreturn inlineSchemeFetchURL;')();

  for (const v of ['blob:http://p/1', 'data:text/plain,x', 'BLOB:http://p/2', '  data:x,y  ']) {
    assert.ok(fn(v), v + ' was routed through the proxy instead of inline fetch');
  }
  for (const v of ['https://x/y', '/rel', 'about:blank', 'mailto:a@b']) {
    assert.equal(fn(v), null, v + ' was treated as an inline scheme and bypassed the proxy');
  }
  assert.ok(fn({ url: 'blob:http://p/3' }), 'Request object with blob: URL was not recognized');
  assert.equal(fn({ url: 'https://x/y' }), null);
});

const L_STUB = [
  'const log = { contained: [], rewrote: [], masked: [] };',
  'function propertyDescriptor(o, k) { for (let p = o; p; p = Object.getPrototypeOf(p)) { const d = Object.getOwnPropertyDescriptor(p, k); if (d) return d; } return null; }',
  'function containStyleDeclaration(d) { log.contained.push(d); return { contained: d }; }',
  'function rewriteCSSText(v) { log.rewrote.push(v); return \'REWROTE:\' + v; }',
  'function defineMasked(obj, key, desc) {',
  '  try { Object.defineProperty(obj, key, desc); } catch (e) { return false; }',
  '  if (typeof desc.get === \'function\') log.masked.push(\'get \' + key);',
  '  if (typeof desc.set === \'function\') log.masked.push(\'set \' + key);',
  '  return true;',
  '}',
].join('\n');

test('CSS: wraps every interface prototype with an own style accessor by rule', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const from = rt.indexOf('  function containEveryStyleAccessor(w) {');
  assert.ok(from > 0, 'containEveryStyleAccessor not found');
  const src = rt.slice(from, rt.indexOf('\n  }', from) + 4);

  const mk = () => new Function(L_STUB + src + '\nreturn { containEveryStyleAccessor, log };')();
  const { containEveryStyleAccessor, log } = mk();

  const styleDesc = (withSetter) => ({
    get() { return this.__decl; },
    set: withSetter ? function (v) { this.__written = v; } : undefined,
    enumerable: false, configurable: true,
  });
  function HTMLElementish() {} Object.defineProperty(HTMLElementish.prototype, 'style', styleDesc(true));
  function CSSRuleish() {} Object.defineProperty(CSSRuleish.prototype, 'style', styleDesc(false));
  function FutureStyledThing() {} Object.defineProperty(FutureStyledThing.prototype, 'style', styleDesc(true));
  function NoStyle() {}
  function DataStyle() {}
  DataStyle.prototype.style = 'plain-value';
  function Subclassish() {}
  Subclassish.prototype = Object.create(HTMLElementish.prototype);
  const w = { HTMLElementish, CSSRuleish, FutureStyledThing, NoStyle, DataStyle, Subclassish, NotAFunction: 42 };
  let lowerRead = 0;
  Object.defineProperty(w, 'documentish', { get() { lowerRead++; return {}; }, enumerable: true, configurable: true });
  Object.defineProperty(w, 'Boom', { get() { throw new Error('boom'); }, enumerable: true, configurable: true });

  const count = containEveryStyleAccessor(w);
  assert.equal(count, 3, 'all 3 interfaces with an own style accessor must be wrapped');
  assert.equal(lowerRead, 0, 'lowercase global was read and could trigger getter side effects');
  assert.equal(DataStyle.prototype.style, 'plain-value', 'data property style was wrapped as an accessor');
  assert.equal(Object.getOwnPropertyDescriptor(Subclassish.prototype, 'style'), undefined,
    'installed own style property on a prototype that only inherited style');

  const el = new HTMLElementish();
  el.__decl = 'DECL';
  assert.deepEqual(el.style, { contained: 'DECL' }, 'style getter did not pass through containment');
  el.style = 'url(x)';
  assert.equal(el.__written, 'REWROTE:url(x)', 'style setter did not pass through CSS rewriter');
  assert.equal(Object.getOwnPropertyDescriptor(CSSRuleish.prototype, 'style').set, undefined,
    'read-only style accessor gained a setter');
  assert.ok(log.contained.includes('DECL') && log.rewrote.includes('url(x)'));
  assert.ok(log.masked.includes('get style'), 'style accessor was installed without source masking');
});

test('CSS: no hardcoded CSS property name list in style declaration proxy', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  assert.ok(!rt.includes('CSS_URL_PROPS'),
    'hardcoded CSS property list returned; proxy must intercept all properties generically');
});

test('CSS: rewritten URLs are deproxied across all style read paths', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const must = [
    ['inline style attribute', "if (localKey === 'style') return deproxyURL(raw, { scan: true });"],
    ['style declaration string read', "if (typeof v === 'string') return deproxyURL(v, { scan: true });"],
    ['getPropertyValue', "function (p) { return deproxyURL(v.call(t, p), { scan: true }); }"],
    ['CSSStyleDeclaration.cssText', "get() { return deproxyURL(dText.get ? dText.get.call(this) : '', { scan: true }); },"],
    ['CSSRule.cssText', 'get() { return deproxyURL(dRuleText.get.call(this), { scan: true }); },'],
    ['getComputedStyle', 'return containStyleDeclaration(nativeGCS.call(w, el, pe));'],
  ];
  for (const [what, needle] of must) {
    assert.ok(rt.includes(needle), what + ' read path is missing deproxyURL');
  }
});

// Page-realm Wasm loads on every navigation, so its size is capped separately from SW bundles.
test('E3 size guard: zp_page_bundle_bg.wasm is at most 540 KB', (t) => {
  const wasmPath = 'dist/web/__zp/zp_page_bundle_bg.wasm';
  if (!fs.existsSync(wasmPath)) {
    t.skip('dist missing: run `npm run build` first');
    return;
  }
  const size = fs.statSync(wasmPath).size;
  assert.ok(size <= 540 * 1024,
    'zp_page_bundle_bg.wasm = ' + size + ' bytes (' + (size / 1024).toFixed(1) + ' KB) > 540 KB');
});

// Function.prototype.toString masking only registers functions installed through
// define/defineAccessor/defineMasked; raw Object.defineProperty leaks hook source.
test('hooks mask function source at installation sites (no raw defineProperty accessors)', () => {
  const lines = preludeSource().split('\r\n').join('\n').split('\n');
  const strip = (l) => l.replace(/\/\/.*$/, '');
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/Object\.defineProperty\(|Object\.defineProperties\(/.test(lines[i])) continue;
    const rest = [];
    for (let j = i; j < Math.min(i + 10, lines.length); j++) {
      if (j > i && /Object\.definePropert|defineMasked\(|definePropertiesMasked\(/.test(lines[j])) break;
      rest.push(strip(lines[j]));
    }
    const win = rest.join(' ');
    if (!/[{,]\s*(get|set)\s*[(:]/.test(win)) continue;
    if (win.includes('toStringMap.set(') || win.includes('maskAccessorFn(')) continue;
    offenders.push((i + 1) + ': ' + lines[i].trim().slice(0, 90));
  }
  assert.deepEqual(offenders, [],
    'accessors installed via raw defineProperty/defineProperties without source masking:\n  ' + offenders.join('\n  '));
});

test('replacement class prototypes mask method sources via assignMasked', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  for (const cls of ['ZPXMLHttpRequest', 'ZPEventSource', 'ZPWebSocket']) {
    assert.ok(rt.includes('assignMasked(' + cls + '.prototype, {'),
      cls + '.prototype populated with raw Object.assign instead of assignMasked');
  }
  assert.ok(!/Object\.assign\([A-Za-z_$][\w$]*\.prototype,/.test(rt),
    'unmasked Object.assign(...prototype) call remains');
});

test('source-masking helpers register getters, setters, and methods as native code', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const from = rt.indexOf('  function defineMasked(obj, key, desc) {');
  const to = rt.indexOf('  function defineOnProto(', from);
  assert.ok(from > 0 && to > from, 'masking helper section not found');
  const masked = new Map();
  const api = new Function(
    'toStringMap', 'nativeAccessorSource', 'maskNativeFunction', 'maskAccessorFn', 'nameLike', 'guardedDescriptor',
    rt.slice(from, to) + '\nreturn { defineMasked, definePropertiesMasked, assignMasked };')(
    masked,
    (kind, key) => 'function ' + kind + ' ' + String(key) + '() { [native code] }',
    (fn, key) => { if (typeof fn === 'function') masked.set(fn, 'function ' + String(key) + '() { [native code] }'); },
    (fn, kind, key) => { if (typeof fn === 'function') masked.set(fn, 'function ' + kind + ' ' + String(key) + '() { [native code] }'); },
    () => {},
    (_obj, _key, desc) => desc, // the receiver/arity guard has its own tests
  );

  const NATIVE = /\{\s*\[native code\]\s*\}/;
  const src = (fn) => masked.get(fn) || 'NOT MASKED: ' + String(fn);

  const o1 = {};
  const g = function () { return 1; };
  const st = function (v) { void v; };
  api.defineMasked(o1, 'thing', { get: g, set: st, configurable: true });
  assert.equal(o1.thing, 1, 'defineMasked did not install the accessor');
  assert.match(src(g), NATIVE, 'defineMasked did not mask getter source');
  assert.match(src(st), NATIVE, 'defineMasked did not mask setter source');

  const o2 = {};
  const g2 = function () { return 2; };
  const v2 = function m() {};
  api.definePropertiesMasked(o2, { a: { get: g2, configurable: true }, b: { value: v2, configurable: true } });
  assert.equal(o2.a, 2);
  assert.match(src(g2), NATIVE, 'definePropertiesMasked did not mask getter source');
  assert.match(src(v2), NATIVE, 'definePropertiesMasked did not mask method source');

  const proto = {};
  function ctor() {}
  const send = function send() {};
  api.assignMasked(proto, { constructor: ctor, send });
  assert.equal(proto.send, send, 'assignMasked did not copy method');
  assert.match(src(send), NATIVE, 'assignMasked did not mask method source');
  assert.equal(masked.has(ctor), false, 'constructor must not be masked by assignMasked');
});

test('unrewriteSourceText restores original source semantics', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const from = rt.indexOf('  function unrewriteSourceText(src) {');
  assert.ok(from > 0, 'unrewriteSourceText not found');
  const src = rt.slice(from, rt.indexOf('\n  }', from) + 4);
  const head = ['  const ZP_WITH_HELPERS = [', '  const ZP_WITH_PROLOGUE = ', '  const ZP_EVENT_CALL_HEAD = ']
    .map(start => { const at = rt.indexOf(start); assert.ok(at > 0, start.trim() + ' not found'); return rt.slice(at, rt.indexOf(';\n', at) + 2); })
    .join('');
  const unrewrite = new Function(head + src + '\nreturn unrewriteSourceText;')();
  const prologue = new Function(head + 'return ZP_WITH_PROLOGUE;')();

  const helpers = () => ({
    __zp_get: (b, k) => b[k],
    __zp_set: (b, k, v) => (b[k] = v),
    __zp_call: (b, k, a) => b[k](...a),
    __zp_assign: (b, k, op, v) => (b[k] = op === '+=' ? b[k] + v : b[k]),
    __zp_update: (b, k, op, pre) => { const p0 = b[k]; b[k] = op === '++' ? p0 + 1 : p0 - 1; return pre ? b[k] : p0; },
  });
  const cases = [
    ['__zp_get(globalThis,"A")', 'A', () => ({ A: 7 })],
    ['__zp_get(o,"k")', 'o.k', () => ({ o: { k: 3 } })],
    ['__zp_get(o,"a-b")', 'o["a-b"]', () => ({ o: { 'a-b': 5 } })],
    ['__zp_set(o,"k",9)', 'o.k=9', () => ({ o: {} })],
    ['__zp_call(__zp_get(globalThis,"M"),"max",[1,4,2])', 'M.max(1,4,2)', () => ({ M: Math })],
    ['__zp_assign(o,"k","+=",2)', 'o.k+=2', () => ({ o: { k: 1 } })],
    ['__zp_update(o,"k","++",true)', '++o.k', () => ({ o: { k: 1 } })],
    ['__zp_update(o,"k","++",false)', 'o.k++', () => ({ o: { k: 1 } })],
    ['__zp_get(a||b,"k")', '(a||b).k', () => ({ a: null, b: { k: 42 } })],
    ['__zp_call(a?b:c,"f",[])', '(a?b:c).f()', () => ({ a: 0, b: null, c: { f: () => 11 } })],
    [`'__zp_get(o,"k")'`, `'__zp_get(o,"k")'`, () => ({})],
    ['__zp_module("x")', '__zp_module("x")', () => ({})],
    ['__zp_get(o)', '__zp_get(o)', () => ({})],
  ];
  // Use a vm context so `globalThis` inside rewritten expressions resolves against `env`.
  const vm = require('node:vm');
  const run = (code, env) => {
    const ctx = vm.createContext(Object.assign(env, helpers()));
    try { return JSON.stringify(vm.runInContext('(' + code + ')', ctx)); }
    catch (e) { return 'THREW:' + e.message; }
  };
  for (const [rew, want, mkEnv] of cases) {
    const got = unrewrite(rew);
    assert.equal(got, want, 'unrewriteSourceText produced wrong source for: ' + rew);
    const envA = mkEnv();
    const envB = mkEnv();
    assert.equal(run(got, envB), run(rew, envA), 'unrewriteSourceText changed evaluation result for: ' + rew);
  }

  const tpl = [
    ['var x=`${__zp_get(globalThis,"window").innerWidth}px`', 'var x=`${window.innerWidth}px`'],
    ['`${__zp_get(o,"k")}-${__zp_get(p,"q")}`', '`${o.k}-${p.q}`'],
    ['`a__zp_get b`', '`a__zp_get b`'],
  ];
  for (const [inp, want] of tpl) {
    assert.equal(unrewrite(inp), want, 'template literal unrewrite failed: ' + inp);
  }

  assert.equal(
    unrewrite('function onclick(event) { return __ZP_EXEC_EVENT(this,event,"return tCR(1);") }'),
    'function onclick(event) { return tCR(1); }',
    'inline event handler wrapper leaked in source text');
  assert.equal(
    unrewrite('function onclick(event) { return (function(){return this})().__ZP_EXEC_EVENT(this,event,"return tCR(1);") }'),
    'function onclick(event) { return tCR(1); }',
    'unnamed event handler wrapper leaked in source text');
  assert.equal(
    unrewrite('function f(o){ with(o){' + prologue + ' g(__zp_get(globalThis,"window")) } }'),
    'function f(o){ with(o){ g(window) } }',
    'with-body helper bindings leaked in source text');
  assert.equal(
    unrewrite('function f(a,b,i){return (__zp_t_4=(0,a),__zp_t_5=(0,(__zp_t_1=(0,b),__zp_t_2=(0,i),__zp_fast(__zp_t_1,__zp_t_2)?__zp_t_1[__zp_t_2]:__zp_get(__zp_t_1,__zp_t_2))),__zp_fast(__zp_t_4,__zp_t_5)?__zp_t_4[__zp_t_5]:__zp_get(__zp_t_4,__zp_t_5))\n;var __zp_t_1,__zp_t_2,__zp_t_3,__zp_t_4,__zp_t_5,__zp_t_6;}'),
    'function f(a,b,i){return a[b[i]]}',
    'guarded read helper leaked in source text');
  assert.equal(
    unrewrite('function f(a,i,v){0,(__zp_t_1=(0,a),__zp_t_2=(0,i),__zp_t_3=(0,v+1),__zp_fastset(__zp_t_1,__zp_t_2)?__zp_t_1[__zp_t_2]=__zp_t_3:__zp_set(__zp_t_1,__zp_t_2,__zp_t_3))\n;var __zp_t_1,__zp_t_2,__zp_t_3;}'),
    'function f(a,i,v){0,a[i]=v+1}',
    'guarded write helper leaked in source text');
  assert.equal(
    unrewrite('function f(o,k){return (__zp_t_1=(0,o),__zp_t_2=(0,k),__zp_fast(__zp_t_1,__zp_t_2)?__zp_t_1[__zp_t_2](1, "x,y"):__zp_call(__zp_t_1,__zp_t_2,[1, "x,y"]))\n;var __zp_t_1,__zp_t_2,__zp_t_3;}'),
    'function f(o,k){return o[k](1, "x,y")}',
    'guarded call helper leaked in source text');
  const lc = [
    ['for(let __zp_lc_7=0;__zp_lc_7++<10000000;){x()}', 'for(;;){x()}'],
    ['let __zp_lc_3=0;do{x()}while(__zp_lc_3++<10000000);', 'do{x()}while(true);'],
    ['let a=0;for(let __zp_lc_1=0;__zp_lc_1++<10000000;)y()', 'let a=0;for(;;)y()'],
  ];
  for (const [inp, want] of lc) {
    assert.equal(unrewrite(inp), want, 'loop cap unrewrite failed: ' + inp);
  }

  const real = 'function f(a){return __zp_call(__zp_get(globalThis,"window"),"open",[a,"_blank"])}';
  const out = unrewrite(real);
  assert.equal(out, 'function f(a){return window.open(a,"_blank")}');
  assert.doesNotThrow(() => new Function('return ' + out), 'unrewritten source does not parse');

  assert.ok(rt.includes('out = unrewriteSourceText(text);'),
    'Function.prototype.toString does not call unrewriteSourceText');
});

test('CSS Typed OM: deproxies reads and rewrites writes', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const from = rt.indexOf('  function installTypedOM(w) {');
  assert.ok(from > 0, 'installTypedOM not found');
  const src = rt.slice(from, rt.indexOf('\n  }', from) + 4);

  const install = new Function(
    'deproxyURL', 'rewriteCSSText', 'define',
    src + '\nreturn installTypedOM;')(
    (t) => String(t).split('PROXY/').join('TARGET/'),
    (t) => String(t).split('TARGET/').join('PROXY/'),
    (o, k, v) => { Object.defineProperty(o, k, { value: v, writable: true, configurable: true }); return true; },
  );

  function FakeValue(text) { this.text = String(text); }
  FakeValue.prototype.toString = function () { return this.text; };
  const CSSStyleValue = { parse: (prop, text) => new FakeValue(text) };
  function RO() {}
  RO.prototype.get = function (p) { return this._d[p] ? this._d[p][0] : null; };
  RO.prototype.getAll = function (p) { return this._d[p] || []; };
  RO.prototype.entries = function () {
    return Object.keys(this._d).map((k) => [k, this._d[k]])[Symbol.iterator]();
  };
  RO.prototype.values = function () {
    return Object.keys(this._d).map((k) => this._d[k])[Symbol.iterator]();
  };
  RO.prototype.forEach = function (cb) { for (const k of Object.keys(this._d)) cb(this._d[k], k, this); };
  RO.prototype[Symbol.iterator] = RO.prototype.entries;
  function SM() {}
  SM.prototype = Object.create(RO.prototype);
  const store = (v) => (v && typeof v === 'object' ? v : new FakeValue(v));
  SM.prototype.set = function (p) { this._d[p] = Array.prototype.slice.call(arguments, 1).map(store); };
  SM.prototype.append = function (p) { this._d[p] = (this._d[p] || []).concat(Array.prototype.slice.call(arguments, 1).map(store)); };

  assert.ok(rt.includes('installTypedOM(w);'),
    'installTypedOM is never called');

  const hooked = install({ StylePropertyMapReadOnly: RO, StylePropertyMap: SM, CSSStyleValue });
  assert.ok(hooked >= 6, 'too few Typed OM hooks installed: ' + hooked);

  const map = new SM();
  map._d = { 'background-image': [new FakeValue('url(PROXY/x.png)')], color: [new FakeValue('red')] };
  assert.equal(String(map.get('background-image')), 'url(TARGET/x.png)', 'get() returned proxied URL without deproxying');
  assert.equal(String(map.getAll('background-image')[0]), 'url(TARGET/x.png)', 'getAll() did not deproxy');
  assert.equal(map.get('color'), map._d.color[0], 'get() allocated a new object when value was unchanged');

  const seen = {};
  for (const [prop, vals] of map.entries()) seen[prop] = String(vals[0]);
  assert.equal(seen['background-image'], 'url(TARGET/x.png)', 'entries() did not deproxy');
  const viaValues = [];
  for (const vals of map.values()) viaValues.push(String(vals[0]));
  assert.ok(viaValues.includes('url(TARGET/x.png)'), 'values() did not deproxy');
  const viaForEach = {};
  map.forEach((vals, prop) => { viaForEach[prop] = String(vals[0]); });
  assert.equal(viaForEach['background-image'], 'url(TARGET/x.png)', 'forEach() did not deproxy');
  assert.equal(RO.prototype[Symbol.iterator], RO.prototype.entries,
    '@@iterator and entries must be the same function reference');

  const w1 = new SM(); w1._d = {};
  w1.set('background-image', 'url(TARGET/y.png)');
  assert.equal(String(w1._d['background-image'][0]), 'url(PROXY/y.png)', 'set(string) bypassed CSS rewriter');
  const w2 = new SM(); w2._d = {};
  w2.set('background-image', new FakeValue('url(TARGET/z.png)'));
  assert.equal(String(w2._d['background-image'][0]), 'url(PROXY/z.png)', 'set(CSSStyleValue) bypassed CSS rewriter');
  const w3 = new SM(); w3._d = {};
  w3.append('background-image', 'url(TARGET/a.png)');
  assert.equal(String(w3._d['background-image'][0]), 'url(PROXY/a.png)', 'append() bypassed CSS rewriter');

  const rt2 = new SM(); rt2._d = {};
  rt2.set('background-image', 'url(TARGET/round.png)');
  assert.equal(String(rt2.get('background-image')), 'url(TARGET/round.png)',
    'Typed OM write/read round-trip mismatch');
});

test('baseURI is installed on Node.prototype rather than Document.prototype', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  assert.ok(rt.includes("defineAccessor(w.Node && w.Node.prototype, 'baseURI', () => baseURL);"),
    'baseURI is missing on Node.prototype; non-Document nodes would leak the proxy baseURI');
  assert.ok(!/defineAccessor\(w\.Document && w\.Document\.prototype, 'baseURI'/.test(rt),
    'baseURI remains an own property on Document.prototype');
});

test('document.origin is not virtualized because modern browsers do not define it', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  assert.ok(!/defineOnProto\(w\.document, docProto, 'origin'/.test(rt),
    'document.origin hook reappeared as an own property');
});

test('HTMLStyleElement innerHTML/innerText/textContent hooks live on ancestor prototypes and branch on <style>', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  assert.ok(!/HTMLStyleElement.*\.prototype;[\s\S]{0,80}for \(const prop of \['textContent', 'innerText', 'innerHTML'\]/.test(rt),
    'innerHTML/innerText/textContent were installed as own properties on HTMLStyleElement.prototype');
  assert.ok(rt.includes("['textContent', w.Node && w.Node.prototype]") && rt.includes("['innerText', w.HTMLElement && w.HTMLElement.prototype]"),
    'textContent/innerText hooks are missing from Node.prototype / HTMLElement.prototype');
  assert.ok(/this\.localName === 'style'.*originalStyleText/.test(rt.replace(/\n\s*/g, ' ')),
    'ancestor prototype hooks are missing the <style> tag check');
});

test('SharedWorker replacement preserves native prototype and applies per-target name prefix', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const from = rt.indexOf('  function installWorkerHooks() {');
  assert.ok(from > 0, 'installWorkerHooks not found');
  const to = rt.indexOf('\n  // D3: virtual SW facade', from);
  assert.ok(to > from, 'end of installWorkerHooks not found');
  const body = rt.slice(from, to);
  assert.ok(/const RealSW = root\.__zp_realSW \|\| Native\.SharedWorker/.test(body),
    'SharedWorker replacement does not use __zp_realSW stash');
  assert.ok(/ZPSharedWorker\.prototype = RealSW\.prototype/.test(body),
    'SharedWorker replacement does not inherit native SharedWorker.prototype');
  assert.ok(/new RealSW\([^;]*prefixedSharedWorkerOptions\(sharedWorkerNamePrefix\(\), opts\)\)/.test(body),
    'SharedWorker constructor does not apply per-target name prefix');
  assert.ok(/new NativeSW\([^;]*prefixedSharedWorkerOptions\(sharedWorkerPrefix, opts\)\)/.test(rt),
    'frame-side SharedWorker wrapper no longer prefixes names');
});

test('prefixedSharedWorkerOptions: every WorkerOptions form keeps its name, namespaced', () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const start = rt.indexOf('  function prefixedSharedWorkerOptions(prefix, opts) {');
  assert.ok(start > 0, 'prefixedSharedWorkerOptions missing');
  const f = new Function(rt.slice(start, rt.indexOf('\n  }', start) + 4) + '\nreturn prefixedSharedWorkerOptions;')();
  const P = 'zp:w:0000beef:';
  assert.deepEqual(f(P, undefined), { name: P }, 'no options → name must be the prefix + "" (native default "")');
  assert.deepEqual(f(P, 'chat'), { name: P + 'chat' }, 'legacy string form lost its name');
  assert.deepEqual(f(P, { type: 'module' }), { type: 'module', name: P }, 'options without a name');
  assert.deepEqual(f(P, { name: 'n', credentials: 'omit' }), { name: P + 'n', credentials: 'omit' });
  assert.deepEqual(f(P, { name: 0 }), { name: P + '0' }, 'name is ToString-ed natively');
  assert.notDeepEqual(f(P, undefined), f(P, { name: 'default' }), 'no-name and "default" must stay distinct workers');
});

const GATEWAY_STUB = [
  'function normalizedError(n) { const e = new Error(n); e.name = n; return e; }',
  'function defineMasked(obj, key, desc) { try { Object.defineProperty(obj, key, desc); return true; } catch (e) { return false; } }',
  'function installEventMethods(proto) {',
  '  const et = Object.create(null);',
  "  et.addEventListener = function () {};",
  "  et.removeEventListener = function () {};",
  "  et.dispatchEvent = function () { return true; };",
  '  Object.setPrototypeOf(proto, et);',
  '}',
  'function brandLikeNative(ctor, proto, name) { try { Object.defineProperty(ctor, "name", { value: name, configurable: true }); } catch (e) {} }',
  'function makeEmptyReadableStream() { return { __emptyStream: true }; }',
  'function makeRejectedWritableStream(err) { return { __rejectedStream: true, err }; }',
].join('\n');

test('makeVirtualGateway: copies native prototype own keys by rule and separates sync vs async methods', async () => {
  const rt = preludeSource().split('\r\n').join('\n');
  const from = rt.indexOf('  function makeVirtualGateway(name, meta) {');
  assert.ok(from > 0, 'makeVirtualGateway rule not found');
  const src = rt.slice(from, rt.indexOf('\n  }', from) + 4);
  assert.ok(!/proxy\.createOffer = |proxy\.getSenders = /.test(src),
    'hardcoded per-interface method list (proxy.xxx = ...) reappeared');

  function FakeNative() {}
  Object.defineProperties(FakeNative.prototype, {
    createOffer: { value: function () { return this.__marker; }, configurable: true },
    createDataChannel: { value: function () {}, configurable: true },
    getSenders: { value: function () {}, configurable: true },
    getConfiguration: { value: function () {}, configurable: true },
    close: { value: function () {}, configurable: true },
    signalingState: { get() { return 'REAL-NATIVE-LEAK'; }, configurable: true },
    binaryType: { get() { return 'REAL'; }, set() {}, configurable: true },
    onicecandidate: { get() { return this.__h; }, set(v) { this.__h = v; }, configurable: true },
  });
  const root = { RTCPeerConnection: FakeNative };
  const mk = () => new Function('root', GATEWAY_STUB + src + '\nreturn makeVirtualGateway;')(root);
  const makeVirtualGateway = mk();

  const Ctor = makeVirtualGateway('RTCPeerConnection', { code: 'X_UNAVAILABLE', kind: 'WebRTC' });
  const names = Object.getOwnPropertyNames(Ctor.prototype).filter(n => n !== 'constructor').sort();
  assert.deepEqual(names, [
    'binaryType', 'close', 'createDataChannel', 'createOffer',
    'getConfiguration', 'getSenders', 'onicecandidate', 'signalingState',
  ], 'failed to copy native prototype own property names');

  const inst = new Ctor();
  assert.ok(typeof inst.createOffer().then === 'function', 'async method did not return a Promise');
  await inst.createOffer().catch(() => {});
  let threw = false;
  try { inst.createDataChannel(); } catch (e) { threw = true; }
  assert.ok(threw, 'sync method must throw when gateway is unavailable');
  assert.deepEqual(inst.getSenders(), [], 'sync array method did not return an empty array');
  assert.deepEqual(inst.getConfiguration(), {}, 'sync object method did not return an empty object');
  assert.equal(inst.close(), undefined, 'no-op method did not return undefined');
  assert.equal(inst.signalingState, 'stable',
    'state accessor returned live native value instead of virtual initial state');

  const f = () => {};
  inst.onicecandidate = f;
  assert.equal(inst.onicecandidate, f, 'event handler getter/setter round-trip failed');
  const inst2 = new Ctor();
  assert.equal(inst2.onicecandidate, null, 'event handler state leaked across instances');

  assert.equal(inst.binaryType, 'blob', 'settable accessor initial value does not match default');
  inst.binaryType = 'arraybuffer';
  assert.equal(inst.binaryType, 'arraybuffer', 'settable accessor did not reflect assigned value');
  assert.equal(inst2.binaryType, 'blob', 'settable accessor state leaked across instances');
});

function parseCSP(header) {
  const map = new Map();
  for (const seg of header.trim().split(';')) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    map.set(toks[0], new Set(toks.slice(1)));
  }
  return map;
}
const KEYWORDS = new Set(["'self'", "'none'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'"]);
const SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:', 'mediastream:', 'filesystem:', 'javascript:', 'file:', 'ftp:']);
function cspTokens(map, directive) { return map.get(directive) || new Set(); }
function schemeTokens(map, directive) {
  return [...cspTokens(map, directive)].filter(t => SCHEMES.has(t));
}
function hostTokens(map, directive) {
  return [...cspTokens(map, directive)].filter(t => !KEYWORDS.has(t) && !SCHEMES.has(t));
}

test('CSP matrix: proxied golden — every directive x every scheme is explicit', () => {
  const golden = fs.readFileSync('crates/zp-shared/testdata/csp_proxied.golden', 'utf8').trim();
  const m = parseCSP(golden);

  const allowed = {
    'script-src': new Set(['blob:']),
    'style-src': new Set(['blob:', 'data:']),
    'img-src': new Set(['blob:', 'data:']),
    'font-src': new Set(['blob:', 'data:']),
    'media-src': new Set(['blob:', 'data:']),
    'connect-src': new Set(['blob:', 'data:']),
    'frame-src': new Set(['blob:', 'data:']),
    'child-src': new Set(['blob:', 'data:']),
    'worker-src': new Set(['blob:']),
  };
  for (const [dir, sources] of m) {
    if (dir === 'report-uri') continue;
    const schemes = new Set(schemeTokens(m, dir));
    assert.deepEqual(schemes, allowed[dir] || new Set(),
      dir + ' scheme sources differ from expected table: ' + [...schemes].join(' '));
  }
  for (const dir of ['default-src', 'object-src', 'base-uri']) {
    assert.deepEqual(cspTokens(m, dir), new Set(["'none'"]), dir + ' must be none');
  }
  for (const dir of ['form-action', 'manifest-src']) {
    assert.deepEqual(cspTokens(m, dir), new Set(["'self'"]), dir + ' must be self');
  }
  const selfDirs = ['script-src', 'style-src', 'img-src', 'font-src', 'media-src', 'connect-src',
    'frame-src', 'child-src', 'worker-src', 'form-action', 'manifest-src'];
  for (const dir of selfDirs) assert.ok(cspTokens(m, dir).has("'self'"), dir + ' is missing self');

  assert.deepEqual([...m.keys()].filter(d => cspTokens(m, d).has("'unsafe-eval'")), ['script-src']);
  assert.deepEqual([...m.keys()].filter(d => cspTokens(m, d).has("'wasm-unsafe-eval'")), ['script-src']);
  assert.deepEqual([...m.keys()].filter(d => cspTokens(m, d).has("'unsafe-inline'")).sort(),
    ['script-src', 'style-src']);
  for (const [dir] of m) {
    const hosts = hostTokens(m, dir).filter(t => dir !== 'report-uri');
    if (dir === 'connect-src') assert.deepEqual(hosts, ['wss://proxy.example'], 'unexpected connect-src host source');
    else assert.deepEqual(hosts, [], dir + ' has unexpected host sources: ' + hosts.join(' '));
  }
  assert.deepEqual(cspTokens(m, 'report-uri'), new Set(['/zp/api/csp-report']));
  for (const tok of ['*', 'javascript:', 'file:', 'http:', 'https:', 'ws:', 'wss:']) {
    for (const [dir] of m) {
      assert.ok(!cspTokens(m, dir).has(tok), dir + ' contains forbidden token ' + tok);
    }
  }
});

test('CSP matrix: control golden — stricter than proxied, framing forbids self', () => {
  const golden = fs.readFileSync('crates/zp-shared/testdata/csp.golden', 'utf8').trim();
  const m = parseCSP(golden);

  const allowed = {
    'img-src': new Set(['blob:', 'data:']),
    'font-src': new Set(['data:']),
    'media-src': new Set(['blob:']),
    'frame-src': new Set(['blob:']),
    'child-src': new Set(['blob:']),
    'worker-src': new Set(['blob:']),
  };
  for (const [dir, sources] of m) {
    const schemes = new Set(schemeTokens(m, dir));
    assert.deepEqual(schemes, allowed[dir] || new Set(),
      dir + ' scheme sources differ from expected table: ' + [...schemes].join(' '));
  }
  assert.deepEqual([...cspTokens(m, 'script-src')].sort(),
    ["'self'", "'unsafe-eval'", "'unsafe-inline'", "'wasm-unsafe-eval'"].sort());
  assert.deepEqual(schemeTokens(m, 'connect-src'), [], 'control connect-src must not allow blob: or data:');
  assert.deepEqual([...hostTokens(m, 'connect-src')], ['wss://proxy.example']);
  assert.deepEqual(cspTokens(m, 'frame-ancestors'), new Set(["'none'"]));
  assert.deepEqual(cspTokens(m, 'base-uri'), new Set(["'self'"]));
  assert.ok(!m.has('report-uri'), 'control CSP must not include report-uri');
  for (const tok of ['*', 'javascript:', 'http:', 'https:', 'ws:', 'wss:']) {
    for (const [dir] of m) assert.ok(!cspTokens(m, dir).has(tok), dir + ' contains forbidden token ' + tok);
  }
});

test('dist signature: zp-page-bundle carries the WBG self-registration', (t) => {
  const p = 'dist/web/zp-page-bundle.js';
  if (!fs.existsSync(p)) { t.skip('dist missing: run `npm run build` first'); return; }
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(/ZPPageBundleWBG\s*=/.test(src),
    'missing self.ZPPageBundleWBG=wasm_bindgen registration in bundle wrapper');
  assert.ok(/ZP_PAGE_BUNDLE_BOOT_FAILED/.test(src), 'missing ZP_PAGE_BUNDLE_BOOT_FAILED boot guard');
  assert.ok(/Object\.defineProperty\(globalThis,"?ZPBundle"?/.test(src), 'missing ZPBundle API registration');
});

test('dist signature: sw bundle registers transport and runtime API', (t) => {
  const p = 'dist/web/sw.js';
  if (!fs.existsSync(p)) { t.skip('dist missing: run `npm run build` first'); return; }
  const src = fs.readFileSync(p, 'utf8');
  for (const marker of ['transportFetch', 'addEventListener']) {
    assert.ok(src.includes(marker), 'sw.js is missing ' + marker);
  }
});

// Strip comments, string literals, and regex literals while preserving line numbers
// so forbidden-pattern checks only inspect executable tokens.
function stripNonCode(src) {
  let out = '', state = 'code', quote = '', lastSig = '', lastWord = '';
  const RE_PREV = /[([{,;:=!&|?+\-*%^~<>]/;
  const RE_WORD = /^(?:return|typeof|case|in|of|new|delete|void|instanceof|throw|yield|await|do|else)$/;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; i++; continue; }
      if (c === '/' && d === '*') { state = 'block'; i++; continue; }
      if (c === '/' && (lastSig === '' || RE_PREV.test(lastSig) || RE_WORD.test(lastWord))) { state = 'regex'; lastWord = ''; continue; }
      if (c === '"' || c === "'" || c === '`') { state = 'str'; quote = c; lastWord = ''; continue; }
      out += c;
      if (/\w/.test(c)) lastWord += c;
      else lastWord = '';
      if (!/\s/.test(c)) lastSig = c;
    } else if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; }
    } else if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; i++; }
      else if (c === '\n') out += '\n';
    } else if (state === 'str') {
      if (c === '\\') i++;
      else if (c === quote) { state = 'code'; lastSig = 'x'; lastWord = ''; }
      else if (c === '\n') out += '\n';
    } else if (state === 'regex') {
      if (c === '\\') i++;
      else if (c === '[') state = 'regexclass';
      else if (c === '/') { state = 'code'; lastSig = 'x'; lastWord = ''; }
      else if (c === '\n') { state = 'code'; out += '\n'; }
    } else {
      if (c === '\\') i++;
      else if (c === ']') state = 'regex';
      else if (c === '\n') { state = 'code'; out += '\n'; }
    }
  }
  return out;
}
test('prelude forbidden patterns: no raw eval/Function/string-timer/document.write', () => {
  const files = ['web/worker-prelude.js', 'web/sw.js', 'web/zp-core.js'];
  const rules = [
    { re: /\bnew Function\s*\(/, why: 'direct new Function call; route through compileNested or Native.FunctionCtor' },
    { re: /\bset(?:Timeout|Interval)\s*\(\s*['"`]/, why: 'string timer bypasses compilation path' },
    { re: /\bdocument\.write(?:ln)?\s*\(/, why: 'direct document.write call; route through appendWrittenHTML' },
    { re: /(^|[^\w$.])eval\s*\(/, why: 'bare eval() call; use named reference such as geval or w.eval' },
    { re: /\bFunction\.prototype\.constructor\s*\(/, why: 'direct Function.prototype.constructor call bypasses rewriter' },
  ];
  for (const file of files.concat(['web/membrane/*'])) {
    const src = stripNonCode(file === 'web/membrane/*' ? preludeSource() : fs.readFileSync(file, 'utf8'));
    for (const { re, why } of rules) {
      assert.ok(!re.test(src), file + ' forbidden pattern: ' + why);
    }
  }
});

test('prelude forbidden patterns: every raw innerHTML assignment is a Native-setter fallback', () => {
  const src = stripNonCode(preludeSource());
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/\w+\.innerHTML\s*=/.test(lines[i])) continue;
    assert.ok(/^\s*else\s+\w+\.innerHTML\s*=/.test(lines[i]),
      'web/runtime-prelude.js:' + (i + 1) + ': raw innerHTML assignment outside else fallback: ' + lines[i].trim());
  }
});

test('getHTML string scrub restores literal attribute text and drops our stash', () => {
  // Shadow-root serializations cannot use the clone scrub, so they scrub the
  // string: each rewritten attribute takes its data-zp-lit-* author text back.
  const rt = preludeSource().split('\r\n').join('\n');
  const start = rt.indexOf('    const scrubSerialized = out => {');
  assert.ok(start > 0, 'scrubSerialized missing');
  const end = rt.indexOf('\n    };\n', start) + '\n    };\n'.length;
  const f = new Function('deproxyURL', rt.slice(start, end) + '\nreturn scrubSerialized;')(s => s);
  assert.equal(
    f('<a href="http://p/zp/?via=x" data-zp-target-url="http://t/x" data-zp-lit-href="/x">t</a>'),
    '<a href="/x">t</a>');
  assert.equal(
    f('<img data-zp-lit-src="i.png?a=1&amp;b=2" alt="k" src="http://p/zp/api/fetch?url=u">'),
    '<img alt="k" src="i.png?a=1&amp;b=2">');
  assert.equal(
    f('<image href="http://p/x" data-zp-lit-xlink:href="/svg.png"></image>'),
    '<image href="http://p/x"></image>');
  assert.equal(
    f('<div data-zp-internal="1" class="c"><script>if (a<b && b>c) x()</script></div>'),
    '<div class="c"><script>if (a<b && b>c) x()</script></div>');
});

test('every helper the rewriter emits is defined in page and worker realms', () => {
  const rs = fs.readFileSync('crates/zp-rewriter/src/lib.rs', 'utf8');
  const names = new Set();
  for (const lit of rs.match(/"(?:[^"\\\n]|\\.)*"/g) || []) {
    for (const m of lit.matchAll(/__zp_([A-Za-z0-9_]+)\(/g)) names.add('__zp_' + m[1]);
    const whole = /^"(__zp_[A-Za-z0-9_]+)"$/.exec(lit);
    // `__zp_`, `__zp_lc_`, `__zp_lc_1` are temporary variable prefixes/counters
    // and `__zp_oc` is the optional-chaining continuation parameter, not a runtime helper.
    if (whole && !/(_|_\d+)$/.test(whole[1]) && whole[1] !== '__zp_oc') names.add(whole[1]);
  }
  assert.ok(names.size >= 20, `helper scan found too few names: ${[...names]}`);
  const page = fs.readdirSync('web/membrane').map(f => fs.readFileSync(`web/membrane/${f}`, 'utf8')).join('\n');
  const worker = fs.readFileSync('web/worker-prelude.js', 'utf8');
  const child = fs.readFileSync('web/membrane/20-containment.js', 'utf8');
  const missing = [];
  for (const n of [...names].sort()) {
    if (!page.includes(`define(root, '${n}'`)) missing.push(`page:${n}`);
    if (!worker.includes(`expose('${n}'`)) missing.push(`worker:${n}`);
    if (!child.includes(`define(w, '${n}'`)) missing.push(`child:${n}`);
  }
  assert.deepEqual(missing, [], `rewriter emits helpers a realm does not define: ${missing.join(', ')}`);
});

// Every `with(o)` body starts by binding runtime helpers as block constants so free-name
// lookups in `o` cannot intercept or shadow helper calls.
test('the runtime helper list is the same in the rewriter, the page prelude and the worker prelude', () => {
  const rs = fs.readFileSync('crates/zp-rewriter/src/lib.rs', 'utf8');
  const rsList = /pub const RUNTIME_HELPERS: &\[&str\] = &\[([^\]]*)\];/.exec(rs);
  assert.ok(rsList, 'RUNTIME_HELPERS not found');
  const rust = [...rsList[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  const listIn = (file) => {
    const text = fs.readFileSync('web/' + file, 'utf8');
    const m = /const ZP_WITH_HELPERS = \[([^\]]*)\];/.exec(text);
    assert.ok(m, file + ' is missing ZP_WITH_HELPERS');
    return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  };
  assert.deepEqual(listIn('membrane/00-head.js'), rust, 'page prelude list differs from RUNTIME_HELPERS');
  assert.deepEqual(listIn('worker-prelude.js'), rust, 'worker prelude list differs from RUNTIME_HELPERS');
  const code = rs.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n').split('#[cfg(test)]')[0];
  const emitted = new Set([...code.matchAll(/(__zp_[A-Za-z_]+)[(.]/g)].map(m => m[1]));
  for (const name of emitted) assert.ok(rust.includes(name), name + ' is emitted but not in RUNTIME_HELPERS');
  const rt = preludeSource();
  const worker = fs.readFileSync('web/worker-prelude.js', 'utf8');
  for (const [where, text] of [['page prelude', rt], ['worker prelude', worker]]) {
    for (const m of text.matchAll(/'with\((__zp_[a-z_]+)\)\{(?:\\n)?'( \+ ([A-Z_]+))?/g)) {
      assert.equal(m[3], 'ZP_WITH_PROLOGUE', where + ': with(' + m[1] + ') does not start with the helper bindings');
    }
  }
});

// Membrane tables use sealed prototypes (newMap/newSet/newWeakMap/newWeakSet) so page
// patches to Map.prototype.get etc. cannot observe internal state or re-enter free-name lookup.
test('every table of the membrane, the worker prelude and the shared core is built by a sealing factory', () => {
  const files = [
    ...require('node:fs').readdirSync('web/membrane').filter(f => f.endsWith('.js')).map(f => 'web/membrane/' + f),
    'web/worker-prelude.js', 'web/zp-core.js',
  ];
  const offenders = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (!/\bnew (Map|Set|WeakMap|WeakSet)\(/.test(code)) return;
      if (/sealedSetProto\(new (Map|Set|WeakMap|WeakSet)\(\), SEALED_/.test(code)) return;
      offenders.push(f + ':' + (i + 1) + ': ' + line.trim().slice(0, 90));
    });
  }
  assert.deepEqual(offenders, [], 'a table built with the page-patchable built-in:\n  ' + offenders.join('\n  '));
});

test('the sealed tables are what they claim: methods that survive a patched built-in prototype', () => {
  const src = require('node:fs').readFileSync('web/membrane/00-head.js', 'utf8').replace(/\r\n/g, '\n');
  const a = src.indexOf('  const sealProtoOf = ');
  const b = src.indexOf('const newWeakSet = ');
  const end = src.indexOf('\n', b);
  assert.ok(a > 0 && b > a, 'the factories moved');
  const { newMap, newSet, newWeakMap, newWeakSet } = new Function(src.slice(a, end) + '\nreturn { newMap, newSet, newWeakMap, newWeakSet };')();
  const seen = [];
  const saved = [];
  for (const [proto, names] of [[Map.prototype, ['get', 'set', 'has', 'delete']], [Set.prototype, ['add', 'has', 'delete']], [WeakMap.prototype, ['get', 'set', 'has', 'delete']], [WeakSet.prototype, ['add', 'has', 'delete']]]) {
    for (const n of names) {
      const orig = proto[n];
      saved.push([proto, n, orig]);
      proto[n] = function (...args) { seen.push(n); return orig.apply(this, args); };
    }
  }
  try {
    const key = {};
    const m = newMap([['a', 1]]); m.set(key, 2);
    const s = newSet(['x']); s.add(key);
    const wm = newWeakMap(); wm.set(key, 3);
    const ws = newWeakSet(); ws.add(key);
    assert.equal(m.get('a'), 1); assert.equal(m.get(key), 2); assert.equal(m.has(key), true); assert.equal(m.size, 2);
    assert.equal(s.has('x'), true); assert.equal(s.has(key), true); assert.equal(s.size, 2);
    assert.equal(wm.get(key), 3); assert.equal(wm.has(key), true);
    assert.equal(ws.has(key), true);
    m.delete(key); s.delete(key); wm.delete(key); ws.delete(key);
    assert.equal(m.has(key), false); assert.equal(ws.has(key), false);
    assert.deepEqual([...m], [['a', 1]], 'iteration');
    assert.deepEqual(seen, [], 'a patched built-in saw the membrane\'s tables: ' + seen.join(','));
    new Map().set(1, 2);
    assert.ok(seen.length > 0, 'the patch does not take, so this test proves nothing');
  } finally {
    for (const [proto, n, orig] of saved) proto[n] = orig;
  }
});
