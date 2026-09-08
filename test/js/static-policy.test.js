const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { classifyTape } = require('../browser/hole-matrix/classify.cjs');
const CASE_ID = url => { const m = /\/img\/([a-z0-9-]+)__(same|cross)\./.exec(url); return m && m[1]; };
const DIRECT = 'http://127.0.0.1:18098/img/x1-case__cross.png';
const req = (id, url) => ({ kind: 'request', request_id: id, url });

test('fixedCSP options.challengeCompat adds CF host only to four directives', () => {
  const code = fs.readFileSync('web/zp-core.js', 'utf8');
  // Evaluate fixedCSP in a vm sandbox to assert the actual emit.
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
  assert.ok(on.includes("script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://challenges.cloudflare.com"));
  assert.ok(on.includes('frame-src \'self\' blob: data: https://challenges.cloudflare.com'));
  assert.ok(on.includes('child-src \'self\' blob: data: https://challenges.cloudflare.com'));
  assert.match(on, /connect-src [^;]*https:\/\/challenges\.cloudflare\.com/);
  // Untouched directives must NOT gain the host.
  assert.equal(/style-src[^;]*https:\/\/challenges\.cloudflare\.com/.test(on), false);
  assert.equal(/img-src[^;]*https:\/\/challenges\.cloudflare\.com/.test(on), false);
  assert.equal(/worker-src[^;]*https:\/\/challenges\.cloudflare\.com/.test(on), false);
});

test('applyScriptPatches behavior: empty patches, splice, malformed envelopes', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8').split('\r\n').join('\n');
  // Extract the applier verbatim so behavior is exercised, not just shape.
  // `\n}` (no trailing newline) tolerates both LF and CRLF line endings.
  const m = sw.match(/function applyScriptPatches\(source, envelopeJson\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'applyScriptPatches definition must be locatable');
  // eslint-disable-next-line no-new-func
  const apply = new Function(`${m[0]}\nreturn applyScriptPatches;`)();

  // Empty source + empty patches → original string passes through.
  assert.equal(apply('', JSON.stringify({ len: 0, patches: [] })), '');
  // No patches → caller gets the source verbatim (no allocation).
  assert.equal(apply('var x = 1;', JSON.stringify({ len: 10, patches: [] })), 'var x = 1;');
  // Single splice — replace `location` (chars 8..16) with `__zp_loc`.
  const src = 'var u = location.href;';
  const env = JSON.stringify({ len: src.length, patches: [{ start: 8, end: 16, replacement: '__zp_loc' }] });
  assert.equal(apply(src, env), 'var u = __zp_loc.href;');
  // Two non-overlapping splices in order.
  const env2 = JSON.stringify({
    len: src.length,
    patches: [
      { start: 8, end: 16, replacement: '__zp_loc' },
      { start: 17, end: 21, replacement: '__zp_href_str' },
    ],
  });
  assert.equal(apply(src, env2), 'var u = __zp_loc.__zp_href_str;');
  // Malformed JSON → null (caller falls back).
  assert.equal(apply(src, '{not json'), null);
  // Out-of-order patches (start < cursor) → null (defensive).
  const bad = JSON.stringify({
    len: src.length,
    patches: [
      { start: 8, end: 16, replacement: 'A' },
      { start: 4, end: 7, replacement: 'B' },
    ],
  });
  assert.equal(apply(src, bad), null);
  // end > source.length → null.
  const oob = JSON.stringify({ len: src.length, patches: [{ start: 0, end: 9999, replacement: 'X' }] });
  assert.equal(apply(src, oob), null);
  // Missing patches array → null.
  assert.equal(apply(src, JSON.stringify({ len: 10 })), null);
});

test('Referer follows the referrer policy (values pinned to a measured control run)', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8').split('\r\n').join('\n');
  const start = sw.indexOf('function refererForPolicy(');
  assert.ok(start > 0, 'refererForPolicy 가 sw.js 에 있어야 한다');
  const end = sw.indexOf('async function transportFetch', start);
  assert.ok(end > start, 'refererForPolicy 뒤에 transportFetch 가 와야 한다');
  const sandbox = {};
  new Function('exports', sw.slice(start, end) + '\nexports.refererForPolicy = refererForPolicy;')(sandbox);
  const f = sandbox.refererForPolicy;

  const doc = 'http://127.0.0.1:18202/page?tag=t';
  const same = 'http://127.0.0.1:18202/same.js';
  const cross = 'http://127.0.0.1:18203/static.js';
  // 대조군: same-origin 은 전체 URL, cross-origin 은 오리진만.
  assert.equal(f(doc, same, ''), doc);
  assert.equal(f(doc, cross, ''), 'http://127.0.0.1:18202/');
  assert.equal(f(doc, cross, 'strict-origin-when-cross-origin'), 'http://127.0.0.1:18202/');
  // 대조군: 정책별.
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
  // https → http 는 강등이다. http → https 는 강등이 아니다.
  assert.equal(f('https://a.example/p?q=1', 'http://b.example/x', ''), '');
  assert.equal(f('https://a.example/p?q=1', 'http://b.example/x', 'strict-origin'), '');
  assert.equal(f('https://a.example/p?q=1', 'http://a.example/x', 'no-referrer-when-downgrade'), '');
  assert.equal(f('http://a.example/p?q=1', 'https://b.example/x', ''), 'http://a.example/');
  // 전체 URL 이라도 프래그먼트와 자격증명은 절대 싣지 않는다(명세).
  assert.equal(f('https://u:pw@a.example/p?q=1#frag', 'https://a.example/x', ''), 'https://a.example/p?q=1');
  // 비 HTTP(S) 출처는 Referer 를 만들지 않는다.
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

  // 서브도메인은 하나의 jar 로 모인다 — 이게 로그인 유지의 핵심.
  assert.equal(registrableDomain('nid.naver.com'), 'naver.com');
  assert.equal(registrableDomain('www.naver.com'), 'naver.com');
  assert.equal(registrableDomain('mail.naver.com'), 'naver.com');
  // 다단계 접미사는 한 단계 더 내려간다.
  assert.equal(registrableDomain('shop.example.co.kr'), 'example.co.kr');
  assert.equal(registrableDomain('example.co.kr'), 'example.co.kr');
  // 무관한 사이트는 절대 합쳐지지 않는다.
  assert.notEqual(registrableDomain('a.example.com'), registrableDomain('a.example.net'));
  // IP literal 은 그대로.
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');

  // 공개 접미사를 Domain 으로 쓰는 쿠키는 거부 — 넓힌 키가 구멍이 되지 않게.
  assert.equal(isPublicSuffixDomain('com'), true);
  assert.equal(isPublicSuffixDomain('co.kr'), true);
  assert.equal(isPublicSuffixDomain('naver.com'), false);
  assert.equal(isPublicSuffixDomain('example.co.kr'), false);

});

test('proxied-document CSP is controlled from zp-shared (single golden, JS side)', () => {
  const golden = fs.readFileSync('crates/zp-shared/testdata/csp_proxied.golden', 'utf8').trim();
  const core = fs.readFileSync('web/zp-core.js', 'utf8');

  // zp-core 는 globalThis.ZP 에 붙는 IIFE — 골든과 같은 입력(호스트
  // proxy.example, https)을 주기 위해 location 을 세운 샌드박스에서 돌린다.
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

  // 표면이 달라도 절대 흔들리면 안 되는 것들.
  for (const invariant of ["default-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'"]) {
    assert.ok(golden.includes(invariant), 'proxied CSP lost ' + invariant);
  }
  assert.ok(!/connect-src [^;]*\*/.test(golden), 'connect-src must never wildcard');
  assert.ok(!/script-src [^;]*\*/.test(golden), 'script-src must never wildcard');
});

test('classify: 런타임 CSS 가 만든 프록시-오리진 서브리소스는 타깃으로 매핑된다 (ctx 가 있을 때만)', () => {
  // 정규식 핀이 아니라 실제로 실행한다. `style.textContent = 'url(/img/bg.png)'`
  // 처럼 브라우저 CSS 엔진이 문서 URL 기준으로 푼 경로는 프록시 오리진의
  // 평범한 `/img/bg.png` 로 도착하는데, 예전에는 `/zp/` 로 시작할 때만
  // 받아 줘서 UNKNOWN → Response.error() 로 죽었다 (실측: insertRule /
  // el.style / @font-face / adoptedStyleSheets / 루트상대 <style> 5종).
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
  // 내부 경로 판정은 zp-core 가 단일 소스다 — 스텁을 따로 쓰면 그 순간
  // **또 하나의 사본**이 된다. 진짜 구현을 뜯어 실행한다.
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
  assert.equal(mapped.kind, 'VIRTUAL_SUBRESOURCE', '런타임 CSS 서브리소스는 타깃으로 매핑돼야 한다');
  assert.equal(mapped.sameOriginURL.pathname, '/img/bg.png');

  // ctx 가 없으면 탭을 추측하지 않는다 (A2: multi-tab leak). 여전히 거절이다.
  assert.equal(classifyWith(null)(req, at('/img/bg.png'), '').kind, 'UNKNOWN',
    'ctx 없이 타깃을 추측하면 다른 탭으로 새는 경로가 열린다');

  // 넓힌 분기가 내부 에셋을 삼키면 안 된다 — 삼키는 순간 페이지가 통째로 죽는다.
  for (const p of ['/__zp/zp_page_rt.wasm?v=abc', '/zp/zp-core.js', '/zp/runtime-prelude.js']) {
    assert.equal(classifyWith(ctx)(req, at(p), 'client-1').kind, 'INTERNAL_ASSET', p + ' must stay internal');
  }
  assert.equal(classifyWith(ctx)(req, at('/zp/api/fetch?url=x'), 'client-1').kind, 'RUNTIME_API');
});

test('rewriteCSSText: 절대 cross-origin url() 만 프록시로 돌리고 주석/문자열은 건드리지 않는다', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8').split('\r\n').join('\n');
  const grab = (name) => {
    const start = rt.indexOf('  function ' + name + '(');
    assert.ok(start >= 0, name + ' 을 못 찾았다');
    const next = rt.indexOf('\n  function ', start + 1);
    return rt.slice(start, next < 0 ? undefined : next);
  };
  const rewriteCSSText = new Function(
    'proxyOrigin', 'subresourceProxyPath',
    grab('cssProxyURL') + '\n' + grab('rewriteCSSText') + '\nreturn rewriteCSSText;'
  )('http://proxy.localhost:18080', (u) => '/zp/api/fetch?url=' + encodeURIComponent(u));

  // 절대 URL 은 프록시 경로로.
  assert.match(rewriteCSSText('#a{background:url(https://cdn.example.com/x.png)}'), /url\("\/zp\/api\/fetch\?url=https%3A%2F%2Fcdn/);
  assert.match(rewriteCSSText("@import 'https://cdn.example.com/a.css';"), /@import '\/zp\/api\/fetch/);
  assert.match(rewriteCSSText('@import url("https://cdn.example.com/a.css");'), /@import url\("\/zp\/api\/fetch/);

  // 상대 URL 은 그대로 — 문서(프록시 공유 경로) 기준으로 풀려 SW 가 매핑한다.
  // 여기서 손대면 이중 매핑이 된다.
  assert.equal(rewriteCSSText('#a{background:url(/img/x.png)}'), '#a{background:url(/img/x.png)}');
  assert.equal(rewriteCSSText('#a{background:url("./x.png")}'), '#a{background:url("./x.png")}');
  // 이미 우리 오리진인 것도 그대로 (재진입 방지).
  const mine = '#a{background:url(http://proxy.localhost:18080/zp/api/fetch?url=x)}';
  assert.equal(rewriteCSSText(mine), mine);

  // ★주석과 문자열은 페이지 내용이다. 정규식으로 긁으면 여기가 조용히 바뀐다.
  const comment = '/* url(https://cdn.example.com/x.png) */#a{color:red}';
  assert.equal(rewriteCSSText(comment), comment);
  const content = '#a::before{content:"url(https://cdn.example.com/x.png)"}';
  assert.equal(rewriteCSSText(content), content);
});

test('containStyleDeclaration: 프로퍼티 대입을 리라이트하고 메서드 동일성을 지킨다', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8').split('\r\n').join('\n');
  const start = rt.indexOf('  function containStyleDeclaration(');
  assert.ok(start >= 0, 'containStyleDeclaration 을 못 찾았다');
  const next = rt.indexOf('\n  function ', start + 1);
  const src = rt.slice(start, next < 0 ? undefined : next);
  const contain = new Function(
    'styleDeclProxies', 'styleDeclMethods', 'rewriteCSSText',
    src + '\nreturn containStyleDeclaration;'
  )(new WeakMap(), new WeakMap(), (v) => String(v).replace('https://cdn.example.com', '/zp/api/fetch'));

  // CSS 프로퍼티는 이 엔진에서 **인스턴스의 own data property** 다. 프로토타입
  // 훅으로는 못 잡아서 프록시로 간다 — 그래서 여기 테스트도 평범한 객체다.
  const decl = { backgroundImage: '', setProperty(p, v) { this[p] = v; }, getPropertyValue(p) { return this[p]; } };
  const p = contain(decl);
  p.backgroundImage = 'url(https://cdn.example.com/x.png)';
  assert.equal(decl.backgroundImage, 'url(/zp/api/fetch/x.png)', '프로퍼티 대입이 리라이트를 안 탔다');
  p.setProperty('mask-image', 'url(https://cdn.example.com/m.png)');
  assert.equal(decl['mask-image'], 'url(/zp/api/fetch/m.png)', 'setProperty 가 리라이트를 안 탔다');

  // 같은 선언에는 같은 프록시 — `el.style === el.style` 가 깨지면 안 된다.
  assert.equal(contain(decl), p, '같은 선언에 다른 프록시를 주면 동일성 비교가 깨진다');
  // 바인딩된 메서드도 캐시돼야 한다 — 매번 새 함수면 기능 탐지가 깨진다.
  assert.equal(p.getPropertyValue, p.getPropertyValue, '메서드 동일성이 깨졌다');
  // 문자열이 아닌 값은 그대로 통과.
  p.zIndex = 3;
  assert.equal(decl.zIndex, 3);
});

test('compileNested: new Function 의 파라미터/arguments 가 with 스코프에 가려지지 않는다', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8').split('\r\n').join('\n');
  const grab = (name) => {
    const start = rt.indexOf('    function ' + name + '(');
    assert.ok(start >= 0, name + ' 을 못 찾았다');
    const next = rt.indexOf('\n    function ', start + 1);
    return rt.slice(start, next < 0 ? undefined : next);
  };
  const compileNested = new Function(
    'zpTrace', 'rewriteDynamicFunctionBody', 'Native',
    grab('functionPrefix') + '\n' + grab('compileNested') + '\nreturn compileNested;'
  )(() => {}, (params, body) => String(body), { FunctionCtor: Function });

  // `withScope` 의 has 트랩은 모든 이름에 true 다. 파라미터를 with **바깥**에
  // 선언하면 그 트랩이 파라미터까지 가려서 undefined 가 된다 — naver 메인의
  // 광고 safeframe(doT 템플릿 `new Function('o,tmpl', …)`)이 이걸로 죽었다.
  const scope = new Proxy({}, { has: () => true, get: () => undefined });
  const call = (compiled, args) => compiled.apply(null, [scope, args]);

  const params = compileNested(['o,tmpl'], 'return [typeof o, typeof tmpl].join()', 'function');
  assert.equal(call(params, [1, {}]), 'number,object', '파라미터가 with 스코프에 가려졌다');

  // `__zp_args` 도 결국 이름이라 with **안에서** 참조하면 같은 트랩에 걸린다.
  // apply 는 반드시 with 바깥에서 해야 한다.
  const args = compileNested([], 'return arguments.length + ":" + arguments[0]', 'function');
  assert.equal(call(args, [9]), '1:9', 'arguments 가 비어 있다 — apply 가 with 안에서 돌고 있다');

  // 자유 식별자는 여전히 with 를 거쳐야 한다(격리).
  const free = compileNested([], 'return typeof somethingGlobal', 'function');
  assert.equal(call(free, []), 'undefined');
});

test('필터링된 컬렉션은 진짜 NodeList 처럼 인덱스를 가진다', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8').split('\r\n').join('\n');

  // 실제 의미까지 고정한다 — 소스에서 두 함수를 뜯어 그대로 실행한다.
  const helperStart = rt.indexOf('function isIndexKey(prop)');
  assert.ok(helperStart > 0);
  // 경계는 다음 함수 선언이다. 예전에는 `sanitizeSerializedHTML` 을 경계로
  // 썼는데, 그 함수는 호출자가 0이 되어 지웠다 — 죽은 코드를 슬라이스 경계로
  // 쓰면 정리할 때마다 가드가 같이 깨진다.
  const helper = rt.slice(helperStart, rt.indexOf('\n  function deproxyURL(', helperStart));
  // 개행이 필수다 — 슬라이스가 `//` 주석 줄에서 끝나면 뒤에 붙인 `return` 이
  // 통째로 그 주석에 먹혀 `new Function` 이 undefined 를 돌려준다(한 번 밟았다).
  const make = new Function('isZPAttrName', helper + '\n; return filteredCollection;')(n => String(n || '').startsWith('data-zp-'));

  const raw = [{ name: 'a' }, { name: 'data-zp-x' }, { name: 'b' }, { name: 'c' }];
  const list = make(raw, item => !isZPName(item));
  function isZPName(item) { return String(item.name).startsWith('data-zp-'); }

  assert.strictEqual(list.length, 3, '필터된 항목은 길이에서 빠진다');
  assert.strictEqual(list[2].name, 'c', '인덱싱은 필터를 건너뛴 순서를 따른다');

  // ★핵심 회귀: `Array.prototype.map/filter/forEach` 는 인덱스를 읽기 전에
  // HasProperty 로 hole 을 판정한다. `has` 가 false 면 콜백이 아예 안 불리고
  // 배열에 구멍이 남아 사이트 코드는 `undefined` 를 집는다 — wikipedia 포털이
  // `l10n/undefined-<hash>.json` 을 8번 긁던 원인이 정확히 이것이었다.
  assert.strictEqual(1 in list, true);
  assert.deepStrictEqual(Array.prototype.map.call(list, e => e.name), ['a', 'b', 'c']);

  // 값은 있는데 키가 없으면 그 자기모순 자체가 지문이다.
  assert.deepStrictEqual(Object.keys(list), ['0', '1', '2']);

  // 순회 메서드를 raw 에 그냥 바인딩하면 **필터를 우회한다** —
  // `document.querySelectorAll('script').forEach(…)` 가 ZP 부트 스크립트를
  // 그대로 넘겨줬다. 인덱싱만 막고 순회를 안 막으면 소용없다.
  const seen = [];
  list.forEach(e => seen.push(e.name));
  assert.deepStrictEqual(seen, ['a', 'b', 'c'], 'forEach 도 필터를 지켜야 한다');
  assert.deepStrictEqual([...list].map(e => e.name), ['a', 'b', 'c']);
});

test('판정기: 응답을 받았으면 진짜 유출', () => {
  const v = classifyTape({ network: [req('1', DIRECT), { kind: 'response', request_id: '1', status: 200 }] }, CASE_ID);
  assert.deepEqual([...v.answered], ['x1-case']);
  assert.equal(v.blocked.size + v.unknown.size, 0);
});

test('판정기: failed 만 있으면 csp-only (차단됨)', () => {
  const v = classifyTape({ network: [req('1', DIRECT), { kind: 'failed', request_id: '1' }] }, CASE_ID);
  assert.deepEqual([...v.blocked], ['x1-case']);
  assert.equal(v.answered.size, 0);
});

test('판정기: 결말 이벤트가 없으면 csp-only 가 아니라 판정불가', () => {
  const v = classifyTape({ network: [req('1', DIRECT)] }, CASE_ID);
  assert.deepEqual([...v.unknown], ['x1-case']);
  assert.equal(v.blocked.size, 0, '결말을 모르는 것을 "막혔다" 로 세면 유출이 통과한다');
  assert.equal(v.answered.size, 0);
});

test('판정기: 여러 번 시도했으면 하나라도 응답받은 쪽이 이긴다', () => {
  const v = classifyTape({
    network: [
      req('1', DIRECT), { kind: 'failed', request_id: '1' },
      req('2', DIRECT), { kind: 'response', request_id: '2', status: 200 },
    ],
  }, CASE_ID);
  assert.deepEqual([...v.answered], ['x1-case']);
  assert.equal(v.blocked.size, 0, '한 번이라도 타깃과 말했으면 유출이다 — 다른 시도가 막혔다고 지워지지 않는다');
});

test('판정기: 응답 뒤에 failed 가 붙어도 유출이다', () => {
  const v = classifyTape({
    network: [req('1', DIRECT), { kind: 'response', request_id: '1', status: 200 }, { kind: 'failed', request_id: '1' }],
  }, CASE_ID);
  assert.deepEqual([...v.answered], ['x1-case'], '응답을 받은 뒤 스트림이 끊긴 것은 이미 말한 것이다');
});

test('판정기: 프록시 경유 요청은 직접 요청으로 세지 않는다', () => {
  const v = classifyTape({
    network: [
      { kind: 'request', request_id: '1', url: 'http://proxy.localhost:18080/zp/api/fetch?url=http%3A%2F%2F127.0.0.1%3A18098%2Fimg%2Fx1-case__cross.png' },
      { kind: 'response', request_id: '1', status: 200 },
    ],
  }, CASE_ID);
  assert.equal(v.attempted.size, 0, '우리가 대신 가져온 것은 유출이 아니다 — 이걸 세던 것이 원래 버그였다');
});

test('srcset 후보 분해가 Rust 와 같다 (data: 쉼표 포함)', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8').split('\r\n').join('\n');
  const grab = (name) => {
    const start = rt.indexOf('\n  function ' + name + '(');
    assert.ok(start >= 0, name + ' 을 못 찾았다');
    const next = rt.indexOf('\n  function ', start + 1);
    return rt.slice(start, next < 0 ? undefined : next);
  };
  const split = new Function(grab('splitSrcsetCandidates') + '\nreturn splitSrcsetCandidates;')();
  const fixture = JSON.parse(fs.readFileSync('crates/zp-shared/testdata/srcset_cases.json', 'utf8'));
  for (const c of fixture.cases) {
    const got = split(c.input).map(x => [x.lead, x.url, x.tail]);
    assert.deepEqual(got, c.candidates, c.id + ': 분해가 Rust 픽스처와 다르다');
    assert.equal(got.map(x => x.join('')).join(''), c.input, c.id + ': 왕복이 입력과 달라졌다');
  }
});

test('?url= 빌더가 Rust 와 바이트 단위로 같다', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8').split('\r\n').join('\n');
  const grab = (name) => {
    const start = rt.indexOf('\n  function ' + name + '(');
    assert.ok(start >= 0, name + ' 을 못 찾았다');
    const next = rt.indexOf('\n  function ', start + 1);
    return rt.slice(start, next < 0 ? undefined : next);
  };
  const fixture = JSON.parse(fs.readFileSync('crates/zp-shared/testdata/proxy_url_cases.json', 'utf8'));
  for (const c of fixture.cases) {
    const build = new Function(
      'proxyOrigin', 'ZP', 'boot',
      grab('encodeURLParam') + '\n' + grab('subresourceProxyPath') + '\nreturn subresourceProxyPath;'
    )('http://proxy.example', { apiPath: (n) => '/zp/api/' + n }, c.tab ? { tabId: c.tab } : null);
    assert.equal(build(c.url), c.want, c.id + ': 페이지 realm 출력이 Rust 와 다르다');
  }
});

test('공유 URL 수용/거부: 살아 있는 JS 구현이 공유 픽스처와 일치한다', () => {
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

  // 의도된 차이 하나. 픽스처는 Rust 의 엄격한 파서 기준이라 `https:/x` 를
  // Malformed 로 거부하는데, WHATWG URL 은 special scheme 의 슬래시 하나를
  // 허용한다. 실측: `new URL('https:/single-slash')` → `https://single-slash/`,
  // host=`single-slash` — **명시적 호스트로 풀리고** 프록시 오리진 기준 상대
  // 해석이 아니다. 즉 오리진 모호성이 없고, 사용자가 주소창에 같은 문자열을
  // 넣었을 때 브라우저가 하는 것과 동일하다. 격리에 영향이 없으므로 JS 의
  // 관대한 쪽을 유지하고 여기 이유와 함께 못 박는다.
  const INTENDED = new Map([['https:/single-slash', true]]);

  const mismatches = [];
  for (const c of cases) {
    let ok = true;
    try { sandbox.ZP.canonicalTargetURL(c.input); } catch { ok = false; }
    const want = INTENDED.has(c.input) ? INTENDED.get(c.input) : c.ok;
    if (ok !== want) mismatches.push(`${JSON.stringify(c.input)}: 기대 ok=${want}, JS ok=${ok}`);
  }
  assert.deepEqual(mismatches, [], '공유 픽스처와 JS 판정이 갈렸다:\n  ' + mismatches.join('\n  '));
});

test('불투명 오리진 프레임에서도 proxyOrigin 이 "null" 이 되지 않는다', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8').split('\r\n').join('\n');
  const start = rt.indexOf('function resolveProxyOrigin(');
  assert.ok(start > 0, 'resolveProxyOrigin 이 없다');
  const end = rt.indexOf('\n  const toStringMap', start);
  const fn = new Function(rt.slice(start, end) + '; return resolveProxyOrigin;')();

  const opaque = new URL('about:srcdoc');
  const real = new URL('http://proxy.localhost:18080/zp/p/tok');

  // 1) 정상 문서는 그대로.
  assert.strictEqual(fn(real, {}, {}), 'http://proxy.localhost:18080');

  // 2) 부팅 설정이 있으면 그걸 쓴다 (부모가 실어 보낸다).
  assert.strictEqual(fn(opaque, { proxyOrigin: 'http://proxy.localhost:18080' }, {}),
    'http://proxy.localhost:18080');

  // 3) 부팅 설정이 없으면 조상 프레임을 타고 올라가 읽는다. 중첩 srcdoc 이라
  //    한 단계 위도 "null" 일 수 있으므로 **끝까지** 올라가야 한다.
  const top = { location: { origin: 'http://proxy.localhost:18080' } };
  const mid = { location: { origin: 'null' } };
  mid.parent = top; top.parent = top;
  const leaf = { parent: mid, location: { origin: 'null' } };
  assert.strictEqual(fn(opaque, {}, leaf), 'http://proxy.localhost:18080');

  // 4) 아무 데서도 못 얻으면 "null" 을 그대로 돌려주되(무한루프 금지),
  //    적어도 조상 순회가 발산하지 않아야 한다.
  const lone = { parent: null };
  assert.strictEqual(fn(opaque, {}, lone), 'null');

});

test('프록시 URL 되돌리기는 한 벌이다 — 세 호출자의 표를 실행으로 고정', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8').split('\r\n').join('\n');
  const grab = (head) => {
    const start = rt.indexOf(head);
    assert.ok(start >= 0, head + ' 을 못 찾았다');
    const next = rt.indexOf('\n  function ', start + 1);
    return rt.slice(start, next < 0 ? undefined : next);
  };
  // deproxyURL 바로 뒤에 스캔 정규식 헬퍼가 붙어 있어 한 번에 딸려 온다.
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

  // 1) 세 호출자 **모두** 알아야 하는 모양 — 예전에 내비게이션판만 몰랐다.
  for (const opts of [{ fallback: 'any' }, { fallback: 'share' }, { scan: true }]) {
    assert.equal(f(PROXY + '/zp/api/fetch?url=' + enc + '&tab=x', opts), T,
      JSON.stringify(opts) + ': ?url= 를 못 푼다');
    assert.equal(f(PROXY + '/zp/api/script?kind=classic&u=' + enc, opts), T,
      JSON.stringify(opts) + ': &u= 를 못 푼다');
    assert.equal(f(PROXY + '/zp/?via=' + enc, opts), T,
      JSON.stringify(opts) + ': ?via= 를 못 푼다');
    // 우리 오리진이 아니면 손대지 않는다.
    assert.equal(f('https://other.example/x', opts), 'https://other.example/x');
  }

  // 2) 호출자별로 **달라야** 하는 것: 모르는 모양의 처리.
  //    폼 액션은 문서 타깃으로 떨어져야 하고(프록시를 다이얼하면 죽는다),
  //    타이밍은 공유 문서 경로일 때만, 직렬화는 없는 값을 지어내지 않는다.
  const unknown = PROXY + '/zp/whatever';
  assert.equal(f(unknown, { fallback: 'any' }), VIRT, "폼: 모르면 문서 타깃");
  assert.equal(f(unknown, { fallback: 'share' }), unknown, '타이밍: 공유 경로가 아니면 그대로');
  assert.equal(f(PROXY + '/zp/p/tok', { fallback: 'share' }), VIRT, '타이밍: 공유 경로는 문서 타깃');
  assert.equal(f(unknown, { scan: true }), unknown, '직렬화: 없는 값을 지어내지 않는다');

  // 3) scan 모드만 한 값 안의 **여럿**을 푼다 (style 의 url(…), srcset 목록).
  const two = 'url("' + PROXY + '/zp/api/fetch?url=' + enc + '"), url(\'' + PROXY + '/zp/api/fetch?url=' + encodeURIComponent('https://t.example/b.png') + '\')';
  assert.equal(f(two, { scan: true }), 'url("' + T + '"), url(\'https://t.example/b.png\')');
  // scan 이 아니면 값 전체가 하나의 URL 일 때만 푼다 — 중간에 박힌 건 안 건드린다.
  assert.equal(f(two, { fallback: 'share' }), two, 'scan 없이 값 안을 훑으면 안 된다');
});

test('교차창 프록시의 parent 를 타고 올라가면 top 에 닿는다', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8').split('\r\n').join('\n');
  const start = rt.indexOf('    function climbCrossWindow(targetWindow, prop, fallback) {');
  assert.ok(start >= 0, 'climbCrossWindow 를 못 찾았다');
  const end = rt.indexOf('\n    function ', rt.indexOf('    function safeCrossWindow(targetWindow) {') + 1);
  assert.ok(end > start, 'safeCrossWindow 구간을 못 찾았다');

  // 실제 구현을 뜯어 실행한다 — 창 3단을 흉내 내고 그 위에서 CMP 루프를 돈다.
  const src = rt.slice(start, end);
  const make = new Function('root', 'scope', 'postMessageWrapperFor', 'crossWindowProxyCache', 'crossWindowTargets',
    src + '\nreturn safeCrossWindow;');

  const top = { name: 'top' };
  const mid = { name: 'mid' };
  const leaf = { name: 'leaf' };
  top.top = top; top.parent = top;
  mid.top = top; mid.parent = top;
  leaf.top = top; leaf.parent = mid;

  // leaf 실행 컨텍스트: root=leaf, scope=leaf 의 가상 window
  const scope = { name: 'scope(leaf)' };
  const safeCrossWindow = make(leaf, scope, () => () => {}, new WeakMap(), new WeakMap());

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
    '손자 프레임에서 parent 를 타고 올라가도 window.top 에 못 닿는다 — CMP 루프가 무한히 돈다');
  assert.ok(steps <= 3, '사슬이 필요 이상으로 길다: ' + steps);

  // 같은 실제 창에는 **같은 프록시**가 나와야 한다. 이게 아니면 `===` 비교가
  // 성립하지 않아 위 루프는 영원히 안 끝난다.
  assert.equal(safeCrossWindow(top), safeCrossWindow(top), '교차창 프록시가 캐시되지 않는다');
  assert.equal(safeCrossWindow(mid).parent, safeCrossWindow(top), 'mid.parent 가 top 프록시가 아니다');
  assert.equal(safeCrossWindow(mid).top, safeCrossWindow(top), 'mid.top 이 top 프록시가 아니다');

  // 끝(자기 자신을 가리키는 창)에서는 제자리에 머문다 — 무한 재귀가 아니라 종료다.
  assert.equal(safeCrossWindow(top).parent, safeCrossWindow(top), 'top 의 parent 는 자기 자신이어야 한다');

  // 못 읽는 조상(교차 출처로 던지는 경우)에서도 던지지 않고 제자리에 머문다.
  const hostile = { get parent() { throw new Error('cross-origin'); }, get top() { throw new Error('cross-origin'); } };
  const hp = safeCrossWindow(hostile);
  assert.equal(hp.parent, hp, '읽기가 던지면 제자리에 머물러야 한다');
});

test('필터 컬렉션 표면은 감싼 대상이 가진 것만 노출한다', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8').split('\r\n').join('\n');
  const start = rt.indexOf('  function isIndexKey(prop) {');
  const end = rt.indexOf('\n  function ', rt.indexOf('  function filteredCollection(raw, predicate) {') + 1);
  assert.ok(start >= 0 && end > start, 'filteredCollection 구간을 못 찾았다');
  const make = new Function('isZPAttrName',
    rt.slice(start, end) + '\nreturn filteredCollection;')(() => false);

  // NodeList 흉내 — 순회 메서드와 item 을 가진 대상.
  const nlRaw = [{ name: 'a' }, { name: 'b' }];
  nlRaw.item = (i) => nlRaw[i] || null;
  const nl = make(nlRaw, () => true);
  // HTMLCollection 흉내 — @@iterator 는 있고(=Array.prototype.values)
  // forEach/values/keys/entries 는 **없는** 대상. 실측한 모양 그대로다.
  const bare = { length: 2, 0: { name: 'a' }, 1: { name: 'b' }, item(i) { return this[i] || null; } };
  bare[Symbol.iterator] = Array.prototype.values;
  const hc = make(bare, () => true);

  // ① 있으면 노출, 없으면 undefined — 두 방향 다.
  for (const k of ['forEach', 'values', 'keys', 'entries']) {
    assert.equal(nl[k], Array.prototype[k], 'NodeList 쪽 ' + k + ' 는 Array.prototype.' + k + ' 여야 한다');
    assert.equal(typeof hc[k], 'undefined', 'HTMLCollection 쪽에 ' + k + ' 가 있으면 안 된다');
  }
  assert.equal(nl[Symbol.iterator], Array.prototype.values, '@@iterator 가 Array.prototype.values 가 아니다');
  assert.equal(hc[Symbol.iterator], Array.prototype.values, 'raw 에 @@iterator 가 있으면 그대로 줘야 한다');

  // ② `in` 과 값이 어긋나면 그 자체가 탐지기다.
  for (const k of ['forEach', 'values', 'keys', 'entries']) {
    assert.equal(typeof hc[k] === 'function', (k in bare), 'HTMLCollection: `in` 과 값이 어긋난다 — ' + k);
    assert.equal(typeof nl[k] === 'function', (k in nlRaw), 'NodeList: `in` 과 값이 어긋난다 — ' + k);
  }

  // ③ 메서드 동일성이 접근마다 흔들리면 안 된다. 실제 DOM 은
  //    `hc.item === hc.item`, `hc.namedItem === hc.namedItem` 이 전부 true 다.
  assert.equal(nl.item, nl.item, 'item 이 접근마다 새 함수다');
  assert.equal(hc.item, hc.item, 'item 이 접근마다 새 함수다(bare)');
  //    우리가 따로 안 다루고 raw 로 넘기는 메서드(`namedItem` 등)도 마찬가지다 —
  //    폴백에서 매번 새로 bind 하면 그 자리만 동일성이 깨진다.
  const withNamed = { length: 0, item() { return null; }, namedItem() { return null; } };
  withNamed[Symbol.iterator] = Array.prototype.values;
  const wn = make(withNamed, () => true);
  assert.equal(typeof wn.namedItem, 'function', '폴백 메서드가 사라졌다');
  assert.equal(wn.namedItem, wn.namedItem, '폴백 메서드가 접근마다 새 함수다');

  // ④ ★그래도 필터는 살아 있어야 한다 — Array.prototype.* 는 this=프록시로
  //    length/인덱스를 읽으므로 우리 트랩을 지난다. 이게 이 설계의 전제다.
  const mixRaw = [{ name: 'keep1' }, { name: 'drop' }, { name: 'keep2' }];
  mixRaw.item = (i) => mixRaw[i] || null;
  const mixed = make(mixRaw, (x) => x && x.name !== 'drop');
  assert.equal(mixed.length, 2, '필터가 안 먹는다');
  assert.deepEqual([...mixed].map((x) => x.name), ['keep1', 'keep2'], '@@iterator 가 필터를 우회한다');
  const viaForEach = [];
  mixed.forEach((x) => viaForEach.push(x.name));
  assert.deepEqual(viaForEach, ['keep1', 'keep2'], 'forEach 가 필터를 우회한다');
  assert.deepEqual([...mixed.values()].map((x) => x.name), ['keep1', 'keep2'], 'values 가 필터를 우회한다');
  assert.deepEqual(Array.prototype.map.call(mixed, (x) => x.name), ['keep1', 'keep2'], 'map 이 필터를 우회한다');
  assert.deepEqual(Object.keys(mixed), ['0', '1'], '키가 필터를 안 따른다');

  // ⑤ live 컬렉션은 순회 중 원본이 자라면 **그걸 본다**(실브라우저 측정과 같게).
  //    스냅샷 순회는 못 봤다 — Array.prototype.values 는 매 next() 마다 length 를
  //    읽으므로 우리 length 트랩(원본 길이 변화 시 캐시 재생성)을 다시 탄다.
  const liveRaw = [{ name: 'x' }];
  liveRaw.item = (i) => liveRaw[i] || null;
  const live = make(liveRaw, () => true);
  const walked = [];
  for (const it of live) {
    walked.push(it.name);
    if (walked.length === 1) liveRaw.push({ name: 'y' });
    if (walked.length > 4) break;
  }
  assert.deepEqual(walked, ['x', 'y'], 'live 순회가 원본 변화를 못 본다');
});

test('필터 컬렉션 순회는 O(N) 이다', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8').split('\r\n').join('\n');
  const start = rt.indexOf('  function isIndexKey(prop) {');
  assert.ok(start >= 0, 'isIndexKey 를 못 찾았다');
  const end = rt.indexOf('\n  function ', rt.indexOf('  function filteredCollection(raw, predicate) {') + 1);
  assert.ok(end > start, 'filteredCollection 구간을 못 찾았다');
  const src = rt.slice(start, end);
  const make = new Function('isZPAttrName',
    src + '\nreturn filteredCollection;')(() => false);

  const N = 500;
  const raw = [];
  for (let i = 0; i < N; i++) raw.push({ name: 'a' + i, nodeType: 1 });
  let calls = 0;
  const list = make(raw, () => { calls++; return true; });

  // ① for-of — 이게 CNN 을 세운 경로다.
  calls = 0;
  let seen = 0;
  for (const _ of list) seen++;
  assert.equal(seen, N, '순회가 전부를 안 돌려준다');
  assert.ok(calls <= N * 2, 'for-of 가 O(N) 이 아니다 — 술어 ' + calls + '회 (N=' + N + ')');

  // ② forEach / values / entries 도 같은 자리다.
  for (const how of ['forEach', 'values', 'entries']) {
    const l2 = make(raw, () => { calls++; return true; });
    calls = 0;
    if (how === 'forEach') l2.forEach(() => {});
    else { let c = 0; for (const _ of l2[how]()) c++; assert.equal(c, N, how + ' 가 전부를 안 돈다'); }
    assert.ok(calls <= N * 2, how + ' 가 O(N) 이 아니다 — 술어 ' + calls + '회');
  }

  // ③ 인덱스 접근 한 번이 전체를 두 번 훑으면 안 된다
  //    (`Array.prototype.map.call(list, …)` 이 정확히 이 경로다).
  const l3 = make(raw, () => { calls++; return true; });
  calls = 0;
  for (let i = 0; i < N; i++) void l3[i];
  assert.ok(calls <= N * 2, '인덱스 접근이 O(N) 이 아니다 — 술어 ' + calls + '회');

  // ④ 그래도 **필터는 살아 있어야** 한다 — 숨기는 게 이 Proxy 의 존재 이유다.
  const mixed = [{ name: 'keep1' }, { name: 'drop' }, { name: 'keep2' }];
  const filtered = make(mixed, (x) => x && x.name !== 'drop');
  assert.equal(filtered.length, 2, '필터가 안 먹는다');
  assert.deepEqual([...filtered].map((x) => x.name), ['keep1', 'keep2'], '순회가 필터를 우회한다');
  assert.equal(filtered[1] && filtered[1].name, 'keep2', '인덱스가 필터를 우회한다');

  // ⑤ live 컬렉션에서 항목이 늘면 캐시를 다시 만든다.
  const live = [{ name: 'a' }];
  const lv = make(live, () => true);
  assert.equal(lv.length, 1);
  live.push({ name: 'b' });
  assert.equal(lv.length, 2, '원본이 자랐는데 캐시가 안 갱신된다');
});

test('문서 인코딩 크기는 서브리소스 폭주에 축출되지 않는다', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8').split('\r\n').join('\n');
  const start = sw.indexOf('const docEncodedByUrl = new Map();');
  assert.ok(start >= 0, 'docEncodedByUrl 을 못 찾았다 — 문서 칸이 없다');
  const end = sw.indexOf('function deliverStreamEncoded(');
  assert.ok(end > start, 'recordEncoded 구간을 못 찾았다');
  const src = 'const streamEncodedByUrl = new Map();\n' + sw.slice(start, end);
  const { recordEncoded, docEncodedByUrl, streamEncodedByUrl } =
    new Function(src + '\nreturn { recordEncoded, docEncodedByUrl, streamEncodedByUrl };')();

  const DOC = 'https://target.example/page';
  recordEncoded(DOC, 14010, true);
  // 문서 하나 뒤로 서브리소스 200개가 쏟아진다 (MDN 의 텔레메트리 비컨 패턴).
  for (let i = 0; i < 200; i++) recordEncoded('https://target.example/beacon/' + i, 20, false);

  assert.equal(docEncodedByUrl.get(DOC), 14010,
    '서브리소스 200개에 문서 기록이 밀려났다 — 첫 방문마다 "압축 안 됨" 으로 보인다');
  assert.ok(streamEncodedByUrl.size <= 32, '서브리소스 칸의 상한이 안 먹는다');
  // 문서 칸도 무한히 자라면 안 된다.
  for (let i = 0; i < 50; i++) recordEncoded('https://target.example/doc/' + i, 1, true);
  assert.ok(docEncodedByUrl.size <= 8, '문서 칸에 상한이 없다');

});

test('trap notebook INDEX stays one line per entry, with a link that resolves', () => {
  const dir = '.ai/trap-notebook/';
  const lines = fs.readFileSync(dir + 'INDEX.md', 'utf8').split(/\r?\n/);
  const headers = lines.filter(l => /^\|\s*Date\s*\|/.test(l));
  assert.equal(headers.length, 1, '표 헤더는 파일에 하나뿐이어야 한다(정리 전에는 행들이 헤더 위에 쌓여 있었다)');
  const headerAt = lines.findIndex(l => /^\|\s*Date\s*\|/.test(l));
  const rows = lines.filter((l, i) => l.startsWith('|') && i > headerAt && !/^\|\s*-+/.test(l));

  const seenDates = [];
  const details = new Map();
  for (const row of rows) {
    const cells = row.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(s => s.trim());
    assert.equal(cells.length, 4, `4칸(날짜/분류/요약/링크)이어야 한다: ${row.slice(0, 80)}`);
    const [date, cat, summary, link] = cells;
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/, `날짜 형식: ${row.slice(0, 60)}`);
    assert.ok(cat.length > 0 && cat.length <= 60, `분류 칸: ${row.slice(0, 60)}`);
    // ★상한을 넘기면 그건 본문이다. 본문은 카테고리 .md 로.
    assert.ok(summary.length <= 160, `요약이 160자를 넘는다(${summary.length}자) — 본문은 상세 파일로: ${summary.slice(0, 60)}…`);
    assert.match(link, /^[A-Za-z0-9-]+\.md#\S+$/, `링크 칸이 <파일>.md#<앵커> 여야 한다: ${row.slice(0, 80)}`);
    const [file, anchor] = link.split('#');
    if (!details.has(file)) details.set(file, fs.readFileSync(dir + file, 'utf8'));
    const detail = details.get(file);
    assert.ok(detail, `링크 대상 파일이 없다: ${file}`);
    assert.ok(detail.includes(anchor), `앵커가 실재하지 않는다: ${link} (절 제목 끝에 {#${anchor}} 를 달아라)`);
    seenDates.push(date);
  }
  // 최신이 위 — 훑을 때 head 만 봐도 되게.
  const sorted = [...seenDates].sort().reverse();
  assert.deepEqual(seenDates, sorted, 'INDEX 는 최신 항목이 위에 오도록 정렬되어 있어야 한다');
});

test('proxy navigation URLs are absolute so a target <base href> cannot retarget them', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8').split('\r\n').join('\n');
  // ① 헬퍼가 프록시 오리진 기준으로 푼다 — 동작으로 확인한다.
  const start = rt.indexOf('function proxyAbsoluteURL(');
  assert.ok(start > 0, 'proxyAbsoluteURL 이 있어야 한다');
  const end = rt.indexOf('\n  }', start) + 4;
  const make = new Function('proxyOrigin', rt.slice(start, end) + '\nreturn proxyAbsoluteURL;');
  const f = make('http://proxy.localhost:18080');
  assert.equal(f('/zp/p/tok#k=1'), 'http://proxy.localhost:18080/zp/p/tok#k=1');
  assert.equal(f('/zp/p/tok?zp_submit=9#k=1'), 'http://proxy.localhost:18080/zp/p/tok?zp_submit=9#k=1');
  // 이미 절대면 그대로. (프레임 경로가 절대 URL 을 만들어 넘겨도 안전해야 한다.)
  assert.equal(f('http://proxy.localhost:18080/zp/p/tok'), 'http://proxy.localhost:18080/zp/p/tok');

});

test('transportFetch 는 kernelFetch 에 데드라인을 건다', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8').split('\r\n').join('\n');
  const fn = sw.slice(sw.indexOf('function withTransportDeadline('), sw.indexOf('async function transportFetch('));
  const make = new Function('TRANSPORT_DEADLINE_MS', 'logRefusal', fn + '; return withTransportDeadline;');
  const seen = [];
  const withDeadline = make(20, (code, status, url) => seen.push([code, status, url]));
  return (async () => {
    // ① 영영 안 끝나는 promise 는 데드라인에 걸려 거절된다.
    let err = null;
    try { await withDeadline(new Promise(() => {}), 'https://t/x', 'GET'); } catch (e) { err = e; }
    assert.ok(err && err.zpTransportTimeout, '멈춘 요청은 타임아웃으로 거절돼야 한다');
    assert.deepEqual(seen[0], ['TRANSPORT_DEADLINE', 504, 'https://t/x']);
    // ② 제때 온 응답은 그대로 통과하고 거절 로그를 남기지 않는다.
    const ok = await withDeadline(Promise.resolve('resp'), 'https://t/y', 'GET');
    assert.equal(ok, 'resp');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(seen.length, 1, '성공한 요청의 타이머가 뒤늦게 발화하면 안 된다');
  })();
});

test('SW 는 응답 경로에서 clients.get 을 기다리지 않는다', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8').split('\r\n').join('\n');
  // 동작으로도 고정한다: 절대 resolve 하지 않는 clients.get 을 물려도
  // 응답은 제때 나와야 한다.
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
    new Promise((_, rej) => setTimeout(() => rej(new Error('응답이 clients.get 을 기다리다 멈췄다')), 500)),
  ]).then((out) => {
    assert.equal(out.status, 200, '응답은 클라이언트와 무관하게 돌아와야 한다');
    assert.equal(out.headers.get('X-ZP-Encoded-Size'), null, '내부 헤더는 제거된다');
    assert.deepEqual(reported, [['https://t/doc', 1234]], 'pull 경로(recordEncoded)는 그대로 남아야 한다');
  });
});

test('자식 창의 조기 postMessage 래퍼는 부팅 즉시 네이티브로 되돌린다', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8').split('\r\n').join('\n');
  // 두 함수만 정확히 떼어 낸다 — 뒤 코드를 같이 물면 엉뚱한 참조로 터진다.
  const from = rt.indexOf('  const earlyNativeKey =');
  const restoreAt = rt.indexOf('  function restoreNativePostMessage(w) {', from);
  assert.ok(from >= 0 && restoreAt > from, '두 함수가 있어야 한다');
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
  // 이미 자기 멤브레인을 깐 창에는 심지 않는다 — 덮으면 걷어 낼 사람이 없다.
  const booted = { __zp_get() {} };
  Object.defineProperty(booted, 'postMessage', { value: nativePm, enumerable: true, configurable: true, writable: true });
  api.installEarlyPostMessage(booted);
  assert.equal(booted.postMessage, nativePm, '부팅이 끝난 창에는 조기 래퍼를 심지 않는다');
  assert.equal(fakeWin.postMessage, wrapper, '부팅 전에는 래퍼가 걸린다');
  api.restoreNativePostMessage(fakeWin);
  assert.equal(fakeWin.postMessage, nativePm, '부팅 뒤에는 네이티브가 돌아와야 한다');

  // 원본을 못 찾으면 손대지 않는다(엉뚱한 창을 망가뜨리지 않는다).
  const untouched = {};
  Object.defineProperty(untouched, 'postMessage', { value: nativePm, enumerable: true, configurable: true, writable: true });
  api.restoreNativePostMessage(untouched);
  assert.equal(untouched.postMessage, nativePm);
});

test('최상위 문서는 자기 자신을 Referer 로 보내지 않는다', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8').split('\r\n').join('\n');
  const from = sw.indexOf('function referrerFromBrowserHeader(req) {');
  assert.ok(from >= 0);
  const endMark = '\n}\n';
  const to = sw.indexOf(endMark, from) + endMark.length;
  const make = new Function('ORIGIN', 'contextFromURL', sw.slice(from, to) + '; return referrerFromBrowserHeader;');
  const ORIGIN = 'http://proxy.localhost:18080';
  const routes = new Map([['/zp/p/AAA', { targetUrl: 'https://news.example/article', baseUrl: '' }]]);
  const fn = make(ORIGIN, (u) => routes.get(u.pathname) || null);
  // 내비게이션은 헤더가 아니라 request.referrer 로 온다. 둘 다 재현한다.
  const req = (ref) => ({ referrer: ref || '', headers: { get: () => null } });
  const reqHeaderOnly = (ref) => ({ referrer: 'about:client', headers: { get: (n) => (n === 'Referer' ? ref : null) } });

  // ① 브라우저가 아무것도 안 줬으면 우리도 없다 — 주소창/북마크/첫 로드.
  assert.equal(fn(req(null)), '', '브라우저가 안 보냈으면 우리도 보내지 않는다');
  // ② 프록시 URL 은 그 라우트의 타깃으로 되돌린다.
  assert.equal(fn(req(ORIGIN + '/zp/p/AAA')), 'https://news.example/article');
  // ③ 못 푸는 프록시 경로(우리 랜딩 페이지 등)는 아무것도 보내지 않는다.
  assert.equal(fn(req(ORIGIN + '/zp/')), '', '라우트가 아니면 프록시 주소를 흘리면 안 된다');
  // ④ 프록시 밖에서 온 참조는 그대로 쓴다.
  assert.equal(fn(req('https://other.example/page')), 'https://other.example/page');
  // ⑤ 'about:client' 는 URL 이 아니라 "기본값" 이라는 뜻이다 — 헤더로 넘어간다.
  assert.equal(fn(reqHeaderOnly(ORIGIN + '/zp/p/AAA')), 'https://news.example/article');
  assert.equal(fn(reqHeaderOnly(null)), '');
});

test('페이지 fetch 는 meta 로 선언된 참조 정책을 요청 시점에 읽는다', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8').split('\r\n').join('\n');
  // 동작: 마지막에 선언된 meta 가 이기고, 빈 content 는 무시한다.
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
  assert.equal(fn(), '', '선언이 없으면 빈 문자열');

  const fn2 = new Function('Native', 'document', rt.slice(from, to) + '; return documentReferrerPolicy;')(
    Native, { __metas: metas('origin', '  NO-REFERRER  ') }
  );
  assert.equal(fn2(), 'no-referrer', '마지막 선언이 이기고 공백/대소문자는 정규화한다');

  const fn3 = new Function('Native', 'document', rt.slice(from, to) + '; return documentReferrerPolicy;')(
    Native, { __metas: metas('same-origin', '') }
  );
  assert.equal(fn3(), 'same-origin', '빈 content 는 앞선 선언을 지우지 않는다');
});

test('dataset hides the data-zp namespace without blocking page-owned data', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8').split('\r\n').join('\n');

  // ③ dataset 필터는 동작으로 고정한다.
  const dsStart = rt.indexOf('  function datasetKeyToAttrName(key) {');
  const dsEnd = rt.indexOf('  function installZPAttrNamespace(w) {');
  assert.ok(dsStart > 0 && dsEnd > dsStart, 'dataset 필터 구간을 못 찾았다');
  const filteredDataset = new Function('isZPAttrName',
    rt.slice(dsStart, dsEnd) + '\nreturn filteredDataset;')(n => String(n || '').startsWith('data-zp-'));
  const rawDs = { zpTargetUrl: 'https://target.example/', zpInternal: '1', pageOwn: 'keep' };
  const ds = filteredDataset(rawDs);
  assert.equal(ds.zpTargetUrl, undefined, 'dataset 으로 타깃 URL 이 샌다');
  assert.equal('zpInternal' in ds, false, 'dataset 의 in 이 우리 키를 인정한다');
  assert.deepEqual(Object.keys(ds), ['pageOwn'], 'dataset 키 열거가 우리 것을 보여 준다');
  assert.equal(ds.pageOwn, 'keep', '페이지 자신의 dataset 을 망가뜨렸다');
  ds.zpInternal = 'forged';
  assert.equal(rawDs.zpInternal, '1', 'dataset 쓰기가 실제 DOM 에 박힌다');
  delete ds.zpTargetUrl;
  assert.equal(rawDs.zpTargetUrl, 'https://target.example/', 'dataset 삭제가 우리 스태시를 지운다');
  ds.pageOwn = 'changed';
  assert.equal(rawDs.pageOwn, 'changed', '페이지 자신의 dataset 쓰기가 막혔다');
  // 접근마다 같은 객체여야 한다(진짜 DOM 은 el.dataset === el.dataset).
  assert.equal(filteredDataset(rawDs), ds, 'dataset 프록시가 접근마다 새로 만들어진다');
});

test('필터 컬렉션은 이름 기반 접근에서도 필터를 유지한다', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8').split('\r\n').join('\n');
  const start = rt.indexOf('  function isIndexKey(prop) {');
  const end = rt.indexOf('\n  function ', rt.indexOf('  function filteredCollection(raw, predicate) {') + 1);
  assert.ok(start >= 0 && end > start, 'filteredCollection 구간을 못 찾았다');
  const make = new Function('isZPAttrName',
    rt.slice(start, end) + '\nreturn filteredCollection;')(n => String(n || '').startsWith('data-zp-'));

  // NamedNodeMap 흉내 — named getter 가 이름으로 Attr 를 돌려준다.
  const hidden = { name: 'data-zp-target-url', value: 'https://target.example/', ownerElement: {} };
  const shown = { name: 'href', value: '/x', ownerElement: {} };
  const raw = { length: 2, 0: shown, 1: hidden, 'href': shown, 'data-zp-target-url': hidden,
    getNamedItem(n) { return this[n] || null; } };
  raw[Symbol.iterator] = Array.prototype.values;
  const nn = make(raw, attr => attr && !String(attr.name).startsWith('data-zp-'));

  assert.equal(nn['data-zp-target-url'], undefined, '이름 접근으로 숨긴 항목이 되돌아 나온다');
  assert.equal('data-zp-target-url' in nn, false, '`in` 이 숨긴 항목을 인정한다');
  assert.equal(nn['href'], shown, '보이는 항목까지 이름 접근에서 사라졌다');
  assert.equal('href' in nn, true, '보이는 항목이 `in` 에서 사라졌다');
  // 항목이 아닌 폴백(스칼라/함수)은 그대로여야 한다.
  raw.someScalar = 7;
  assert.equal(nn.someScalar, 7, '항목이 아닌 폴백까지 걸렀다');
  assert.equal(typeof nn.getNamedItem, 'function', '메서드 폴백이 사라졌다');
  // 열거/길이는 여전히 필터를 따른다.
  assert.equal(nn.length, 1);
  assert.deepEqual(Array.prototype.map.call(nn, a => a.name), ['href']);

  // 진짜 DOM 은 `el.attributes === el.attributes` 다. 접근마다 새 프록시를
  // 만들면 그 자체가 후킹을 드러낸다(메서드 동일성과 같은 이유).
  const nnmStart = rt.indexOf('  const namedNodeMapCache = new WeakMap();');
  assert.ok(nnmStart > 0, 'attributes 캐시가 없다');
  const nnmEnd = rt.indexOf('\n  function ', rt.indexOf('  function filteredNamedNodeMap(', nnmStart) + 1);
  const wrap = new Function('isZPAttrName',
    rt.slice(nnmStart, nnmEnd) + '\n' + rt.slice(start, end) + '\nreturn filteredNamedNodeMap;')(
    n => String(n || '').startsWith('data-zp-'));
  assert.equal(wrap(raw), wrap(raw), 'el.attributes 가 접근마다 새 객체다');
});

test('http(s) 가 아닌 절대 URL 은 게터가 그대로 돌려준다', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8').split('\r\n').join('\n');
  const from = rt.indexOf('  function nonHTTPAbsoluteURL(raw) {');
  assert.ok(from > 0, 'nonHTTPAbsoluteURL 이 없다');
  const to = rt.indexOf('\n  }', from) + 4;
  const fn = new Function(rt.slice(from, to) + '\nreturn nonHTTPAbsoluteURL;')();

  // ① 스킴이 있는 비-HTTP 는 그대로(파서 정규화만) 돌려준다.
  for (const v of ['blob:http://proxy.localhost:18080/abc-123', 'data:video/mp4;base64,AAAA',
    'about:blank', 'mailto:a@b.c', 'tel:+1', 'javascript:void 0', 'ws://x/y']) {
    const got = fn(v);
    assert.ok(got !== null, v + ' 를 게터가 여전히 targetURL 로 보낸다 — 읽으면 던진다');
    assert.equal(typeof got, 'string');
  }
  assert.equal(fn('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(fn('about:blank'), 'about:blank');
  assert.equal(fn('blob:http://p/1'), 'blob:http://p/1');

  // ② http(s) 와 상대 URL·조각은 **반드시** 기존 경로로 가야 한다 —
  //    그래야 타깃 기준 해석과 디프록시가 유지된다.
  for (const v of ['https://x/y', 'HTTP://x/y', '//x/y', '/rel', 'rel', '#frag', '', '?q=1']) {
    assert.equal(fn(v), null, v + ' 가 통과 경로로 새면 리라이트를 건너뛴다');
  }

});

test('script-capable blob MIME types are distinguished from media and JSON', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8').split('\r\n').join('\n');

  // ④ 규칙 자체는 그대로여야 한다 — 타입 없는 blob 도 스크립트가 될 수 있다.
  const reStr = /const SCRIPTISH_BLOB_TYPE = (\/.+\/i);/.exec(rt);
  assert.ok(reStr, 'SCRIPTISH_BLOB_TYPE 규칙이 없다');
  const re = new Function('return ' + reStr[1])();
  for (const t of ['', 'text/javascript', 'application/ecmascript', 'text/plain', 'application/octet-stream']) {
    assert.equal(re.test(t), true, JSON.stringify(t) + ' 는 스크립트성으로 봐야 한다');
  }
  for (const t of ['video/mp4', 'image/png', 'application/json']) {
    assert.equal(re.test(t), false, t + ' 까지 스크립트성으로 보면 과잉이다');
  }
});

test('fetch 는 인라인 스킴을 브라우저에 그대로 넘긴다', () => {
  const rt = fs.readFileSync('web/runtime-prelude.js', 'utf8').split('\r\n').join('\n');
  const from = rt.indexOf('  function inlineSchemeFetchURL(input) {');
  assert.ok(from > 0, 'inlineSchemeFetchURL 이 없다');
  const fn = new Function(rt.slice(from, rt.indexOf('\n  }', from) + 4) + '\nreturn inlineSchemeFetchURL;')();

  for (const v of ['blob:http://p/1', 'data:text/plain,x', 'BLOB:http://p/2', '  data:x,y  ']) {
    assert.ok(fn(v), v + ' 를 프록시로 보내고 있다');
  }
  for (const v of ['https://x/y', '/rel', 'about:blank', 'mailto:a@b']) {
    assert.equal(fn(v), null, v + ' 까지 인라인으로 보면 프록시를 건너뛴다');
  }
  // Request 객체로 와도 알아봐야 한다.
  assert.ok(fn({ url: 'blob:http://p/3' }), 'Request 형태의 blob 을 놓친다');
  assert.equal(fn({ url: 'https://x/y' }), null);

});

