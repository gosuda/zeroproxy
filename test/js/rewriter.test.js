const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let bundle;
function loadRewriter() {
  if (!bundle) {
    const dist = path.resolve(process.env.ZP_E2E_DIST || 'dist');
    const ctx = { console, atob, btoa, TextEncoder, TextDecoder, Uint8Array, WebAssembly, FinalizationRegistry, URL };
    ctx.globalThis = ctx;
    ctx.self = ctx;
    vm.createContext(ctx);
    // Missing or invalid artifacts are errors, never a reason to skip CI.
    vm.runInContext(fs.readFileSync(path.join(dist, 'web/zp-page-bundle.js'), 'utf8'), ctx,
      { filename: 'zp-page-bundle.js' });
    bundle = ctx.ZPBundle;
  }
  return bundle;
}

function executionContext() {
  const location = { href: 'https://target.example/start', hash: 1 };
  const rawLocation = { href: 'https://proxy.example/zp/p/secret', hash: 100 };
  const window = { location: rawLocation };
  function WebSocket(url, protocols) { this.url = url; this.protocols = protocols; }
  window.WebSocket = WebSocket;
  const ctx = { window, location: rawLocation, document: { defaultView: window }, WebSocket };
  ctx.globalThis = ctx;
  let realmGlobal;
  ctx.__zp_get = (base, key) => {
    if ((base === ctx || base === realmGlobal || base === window) && key === 'location') return location;
    if (base === rawLocation) return location[key];
    return base[key];
  };
  ctx.__zp_set = (base, key, value) => {
    if ((base === ctx || base === realmGlobal || base === window) && key === 'location') location.href = String(value);
    else if ((base === location || base === rawLocation) && key === 'href') location.href = String(value);
    else base[key] = value;
    return value;
  };
  ctx.__zp_assign = (base, key, op, value) => {
    assert.equal(op, '+=');
    return ctx.__zp_set(base, key, ctx.__zp_get(base, key) + value);
  };
  ctx.__zp_update = (base, key, op, prefix) => {
    const previous = Number(ctx.__zp_get(base, key));
    const next = op === '++' ? previous + 1 : previous - 1;
    ctx.__zp_set(base, key, next);
    return prefix ? next : previous;
  };
  ctx.__zp_get.d = new Proxy({}, { set: (_, key, value) => { ctx.__zp_set(ctx, key, value); return true; } });
  ctx.__zp_call = (base, key, args) => Reflect.apply(base[key], base, args);
  vm.createContext(ctx);
  // Node contextifies the global object: code inside the VM sees a distinct
  // identity from the host sandbox, unlike ordinary objects passed through it.
  realmGlobal = vm.runInContext('globalThis', ctx);
  return { ctx, location };
}

function rewrite(source, kind = 'classic', target = 'https://target.example/app.js') {
  return loadRewriter().rewriteScript(source, kind, target, 'https://proxy.example');
}

test('built rewriter virtualizes globals and aliases without changing local bindings', () => {
  const { ctx } = executionContext();
  const code = rewrite(`
    const location = { href: 'local' };
    const w = window;
    window.result = [location.href, window.location.href, window['loca' + 'tion'].href,
      document.defaultView.location.href, w.location.href];
  `);
  vm.runInContext(code, ctx);
  assert.deepEqual(Array.from(ctx.window.result), ['local', ...Array(4).fill('https://target.example/start')]);
});

test('built rewriter rejects invalid programs rather than returning executable source', () => {
  assert.throws(() => rewrite('if ('));
  assert.throws(() => rewrite('export const = 1', 'module'));
  assert.throws(() => rewrite('window.location', 'unknown-kind'));
});

test('event handlers and dynamic function bodies retain return and parameter semantics', () => {
  const { ctx } = executionContext();
  vm.runInContext(rewrite('window.result = (function(event) { return event.type + location.href; })({type: "click:"});', 'event-handler'), ctx);
  assert.equal(ctx.window.result, 'click:https://target.example/start');
  vm.runInContext(rewrite('window.result = (function(location) { return location.href + window.location.href; })({href: "local:"});', 'function'), ctx);
  assert.equal(ctx.window.result, 'local:https://target.example/start');
});

test('module imports are canonical same-origin proxy URLs and import.meta retains the target', async () => {
  const target = 'https://target.example/assets/main.js?version=1';
  const { ctx } = executionContext();
  const imported = [];
  const mod = new vm.SourceTextModule(rewrite('import value from "./dep.js"; window.result = [value, import.meta.url];', 'module', target), { context: ctx });
  await mod.link(async specifier => {
    imported.push(new URL(specifier));
    return new vm.SyntheticModule(['default'], function() { this.setExport('default', 'dependency'); }, { context: ctx });
  });
  await mod.evaluate();
  assert.equal(imported[0].origin, 'https://proxy.example');
  assert.equal(imported[0].pathname, '/zp/api/script');
  assert.equal(imported[0].searchParams.get('u'), 'https://target.example/assets/dep.js');
  assert.equal(imported[0].searchParams.get('kind'), 'module');
  assert.deepEqual(Array.from(ctx.window.result), ['dependency', target]);
});

test('target URLs with query strings and extensionless paths remain executable', () => {
  const { ctx, location } = executionContext();
  vm.runInContext(rewrite('window.location = "/next";', 'classic', 'https://target.example/app.js?ts=12#frag'), ctx);
  assert.equal(location.href, '/next');
  vm.runInContext(rewrite('window.result = location.href;', 'classic', 'https://target.example/challenge/v1?ray=abc'), ctx);
  assert.equal(ctx.window.result, '/next');
});

test('assignment results, compound writes and WebSocket constructors preserve observable values', () => {
  const { ctx, location } = executionContext();
  vm.runInContext(rewrite(`
    const assigned = (window.location = "https://google.com/");
    location.href += "#frag";
    const ws = new WebSocket("ws://example.test/socket", ["chat"]);
    const ws2 = new window.WebSocket("wss://example.test/secure");
    window.result = { assigned, href: location.href, wsURL: ws.url, ws2URL: ws2.url };
  `), ctx);
  assert.equal(location.href, 'https://google.com/#frag');
  assert.equal(ctx.window.result.assigned, 'https://google.com/');
  assert.equal(ctx.window.result.href, 'https://google.com/#frag');
  assert.equal(ctx.window.result.wsURL, 'ws://example.test/socket');
  assert.equal(ctx.window.result.ws2URL, 'wss://example.test/secure');
});

test('class fields, destructuring assignments, local loops and prefix/postfix updates remain executable', () => {
  const { ctx, location } = executionContext();
  vm.runInContext(rewrite(`
    class Boundary {
      static parent;
      parent;
      constructor(source) { ({ parent: this.parent, location } = source); }
      method() {
        let count = 0;
        for (let window = 0; window < 2; window++) count += window;
        return { location, current: this.parent, count };
      }
    }
    const boundary = new Boundary({ parent: "local-parent", location: "https://target.example/next" });
    const post = location.hash++;
    const pre = ++window.location.hash;
    window.result = { values: boundary.method(), post, pre };
  `), ctx);
  assert.equal(location.href, 'https://target.example/next');
  assert.equal(ctx.window.result.values.current, 'local-parent');
  assert.equal(ctx.window.result.values.location.href, 'https://target.example/next');
  assert.equal(ctx.window.result.values.count, 1);
  assert.equal(ctx.window.result.post, 1);
  assert.equal(ctx.window.result.pre, 3);
});

test('nested member writes retain global assignment RHS patches', () => {
  const { ctx, location } = executionContext();
  vm.runInContext(rewrite(`
    const receiver = { href: '' };
    receiver.href = (location = '/nested');
    window.result = receiver.href;
  `), ctx);
  assert.equal(location.href, '/nested');
  assert.equal(ctx.window.result, '/nested');
});

test('member references evaluate once, read before the RHS, and retain native numeric updates', () => {
  const { ctx } = executionContext();
  vm.runInContext(rewrite(`
    const trace = [];
    let value = '2';
    const receiver = {
      get href() { trace.push(['get', this === receiver]); return value; },
      set href(next) { trace.push(['set', this === receiver, next]); value = next; }
    };
    function base() { trace.push(['base']); return receiver; }
    function rhs() { trace.push(['rhs']); value = 'changed'; return '3'; }
    const assigned = (base().href += rhs());
    const post = base().href++;
    const pre = --base().href;
    value = 7n;
    const bigPost = base().href++;
    const bigPre = ++base().href;
    window.result = { assigned, post, pre, bigPost, bigPre, value, trace };
  `), ctx);
  const result = ctx.window.result;
  assert.equal(result.assigned, '23');
  assert.equal(result.post, 23);
  assert.equal(result.pre, 23);
  assert.equal(result.bigPost, 7n);
  assert.equal(result.bigPre, 9n);
  assert.equal(result.value, 9n);
  assert.deepEqual(Array.from(result.trace, row => Array.from(row)), [
    ['base'], ['get', true], ['rhs'], ['set', true, '23'],
    ['base'], ['get', true], ['set', true, 24],
    ['base'], ['get', true], ['set', true, 23],
    ['base'], ['get', true], ['set', true, 8n],
    ['base'], ['get', true], ['set', true, 9n]
  ]);
});

test('member logical writes preserve short circuiting and await/yield in the enclosing scope', async () => {
  const { ctx } = executionContext();
  await vm.runInContext(rewrite(`
    window.result = (async () => {
      const trace = [];
      let value = 0;
      const receiver = {
        get href() { trace.push('get'); return value; },
        set href(next) { trace.push('set'); value = next; }
      };
      function rhs() { trace.push('rhs'); return 5; }
      const skippedAnd = (receiver.href &&= rhs());
      const skippedNullish = (receiver.href ??= rhs());
      const assigned = (receiver.href ||= await rhs());
      const skippedOr = (receiver.href ||= rhs());
      function* update() { return receiver.href += yield 'pause'; }
      const iterator = update();
      const suspended = iterator.next();
      value = 100;
      const resumed = iterator.next(2);
      return { skippedAnd, skippedNullish, assigned, skippedOr, suspended, resumed, value, trace };
    })();
  `), ctx);
  const result = await ctx.window.result;
  assert.deepEqual([result.skippedAnd, result.skippedNullish, result.assigned, result.skippedOr], [0, 0, 5, 5]);
  assert.equal(result.suspended.value, 'pause');
  assert.equal(result.suspended.done, false);
  assert.equal(result.resumed.value, 7);
  assert.equal(result.resumed.done, true);
  assert.equal(result.value, 7);
  assert.deepEqual(Array.from(result.trace), ['get', 'get', 'get', 'rhs', 'set', 'get', 'get', 'set']);
});

test('nested member destructuring, defaults and loop targets keep write order without target reads', () => {
  const { ctx } = executionContext();
  vm.runInContext(rewrite(`
    const trace = [];
    const receiver = {
      get parent() { throw new Error('write-only target was read'); },
      set parent(value) { trace.push(['set', this === receiver, value]); }
    };
    function base() { trace.push(['base']); return receiver; }
    const source = { get nested() { trace.push(['source']); return [undefined, 'rest']; } };
    function fallback() { trace.push(['default']); return 'fallback'; }
    const assigned = ({ nested: [base().parent = fallback(), ...base().parent] } = source);
    for (base().parent of ['loop']) {}
    for (base().parent in { entry: true }) {}
    window.result = { sameSource: assigned === source, trace };
  `), ctx);
  assert.equal(ctx.window.result.sameSource, true);
  assert.deepEqual(Array.from(ctx.window.result.trace, row =>
    Array.from(row, value => Array.isArray(value) ? Array.from(value) : value)), [
    ['source'], ['base'], ['default'], ['set', true, 'fallback'],
    ['base'], ['set', true, ['rest']],
    ['base'], ['set', true, 'loop'], ['base'], ['set', true, 'entry']
  ]);
});

test('member target wrappers retain automatic semicolon insertion and conditional statement boundaries', () => {
  const { ctx } = executionContext();
  vm.runInContext(rewrite(`
    const receiver = { href: 1 }
    receiver.href += 2
    if (false) receiver.href++
    else receiver.href *= 3
    window.result = receiver.href
  `), ctx);
  assert.equal(ctx.window.result, 9);
});
