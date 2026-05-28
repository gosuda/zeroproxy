const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

let builtRustAssetPromise = null;

function loadBuiltRustContext() {
  if (!builtRustAssetPromise) {
    builtRustAssetPromise = (async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-rust-unit-'));
      const result = childProcess.spawnSync('node', ['scripts/build.mjs', '--web-only', '--out', outDir], {
        cwd: path.resolve(__dirname, '../..'),
        encoding: 'utf8',
      });
      if (result.status !== 0) {
        throw new Error(`node scripts/build.mjs --web-only --out ${outDir} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      }
      const ctx = { console, atob, btoa, TextEncoder, TextDecoder, Uint8Array, WebAssembly, FinalizationRegistry, URL, Promise, globalThis: null };
      ctx.globalThis = ctx;
      vm.createContext(ctx);
      vm.runInContext(fs.readFileSync(path.join(outDir, 'web', 'rust-rewriter.js'), 'utf8'), ctx, { filename: 'rust-rewriter.js' });
      assert.equal(fs.existsSync(path.join(outDir, 'web', 'js-rewriter.js')), false);
      assert.equal(fs.existsSync(path.join(outDir, 'web', 'oxc-parser.js')), false);
      assert.equal(fs.existsSync(path.join(outDir, 'web', 'oxc_parser_wasm_bg.wasm')), false);
      return ctx;
    })();
  }
  return builtRustAssetPromise;
}

async function loadRewriter() {
  const ctx = await loadBuiltRustContext();
  return ctx.ZPRewriter;
}

test('Rust rewriter asset exposes the public rewriter API without JS fallback assets', async () => {
  const ctx = await loadBuiltRustContext();
  assert.equal(typeof ctx.ZPRustRewriter.rewriteScript, 'function');
  assert.equal(typeof ctx.ZPRewriter.rewriteScript, 'function');
  assert.equal(ctx.ZPRewriter.ready, true);
  assert.equal(ctx.ZPRewriter.initSync(), true);
  assert.equal(await ctx.ZPRewriter.init(), true);
  const out = ctx.ZPRewriter.rewriteScript('window.location.href', { kind: 'classic', targetUrl: 'https://example.com/app.js', controlPrefix: '/zp/' });
  assert.equal(out.ok, true);
  assert.match(out.code, /__zp_get\(__zp_get\(globalThis,"window"\),"location"\)\.href/);
  assert.equal('OXCParser' in ctx, false);
});

test('Rust rewriter asset rewrites live code paths', async () => {
  const ctx = await loadBuiltRustContext();
  const assign = ctx.ZPRustRewriter.rewriteScript('window.location.hash += "-tail"; document.defaultView.location.href;', 'classic', 'https://example.com/app.js', '/zp/');
  const meta = ctx.ZPRustRewriter.rewriteScript('new URL("/worker-fixture.js", import.meta.url).href;', 'module', 'https://example.com/module-worker.js', '/zp/');
  const dynamic = ctx.ZPRustRewriter.rewriteScript('export async function load(name) { return import("./chunks/" + name + ".js"); }', 'module', 'https://example.com/assets/main.js', '/zp/');
  assert.equal(assign.ok, true);
  assert.ok(assign.code.includes('__zp_assign(__zp_get(__zp_get(globalThis,"window"),"location"),"hash"'));
  assert.ok(assign.code.includes('__zp_get(__zp_get(globalThis,"document"),"defaultView")'));
  assert.equal(meta.ok, true);
  assert.ok(meta.code.includes('https://example.com/module-worker.js'));
  assert.equal(dynamic.ok, true);
  assert.ok(dynamic.code.includes('__zp_module_url('));
  assert.ok(dynamic.code.includes('https://example.com/assets/main.js'));
});

test('Rust rewriter asset reports parse failures', async () => {
  const ctx = await loadBuiltRustContext();
  const out = ctx.ZPRustRewriter.rewriteScript('if (', 'classic', 'https://example.com/app.js', '/zp/');
  assert.equal(out.ok, false);
  assert.equal(out.error, 'PARSE_FAILED');
  const publicOut = ctx.ZPRewriter.rewriteScript('if (', { kind: 'classic', targetUrl: 'https://example.com/app.js' });
  assert.equal(publicOut.ok, false);
  assert.equal(publicOut.errorCode, 'PARSE_FAILED');
  assert.match(ctx.ZPRewriter.blockSource(), /Blocked by ZeroProxy rewrite policy/);
});

test('Rust rewriter supports event-handler and dynamic function body paths', async () => {
  const rewriter = await loadRewriter();
  const handler = rewriter.rewriteScript('return location.href', { kind: 'event-handler', targetUrl: 'https://example.com/' });
  assert.equal(handler.ok, true);
  assert.match(handler.code, /__zp_runEvent/);
  assert.ok(handler.code.includes('__zp_get(globalThis,"location").href'));

  const fnBody = rewriter.rewriteFunctionBody('return location.href + window.location.href;', ['location'], 'https://example.com/');
  assert.equal(fnBody.ok, true);
  assert.match(fnBody.code, /return location\.href \+ __zp_get\(__zp_get\(globalThis,"window"\),"location"\)\.href/);
});

test('Rust rewriter virtualizes dangerous globals without rewriting local bindings', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(`
    const location = { href: 'local' };
    const w = window;
    window.out = [location.href, window.location.href, window['loca' + 'tion'].href, document.defaultView.location.href, w.location.href];
    Function('return location.href')();
  `, { kind: 'classic' });
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.match(out.code, /const location = \{ href: 'local' \}/);
  assert.match(out.code, /location\.href/);
  assert.match(out.code, /__zp_get\(globalThis,"window"\)/);
  assert.match(out.code, /__zp_get\(__zp_get\(globalThis,"document"\),"defaultView"\)/);
  assert.match(out.code, /__zp_get\(globalThis,"Function"\)/);
});

test('Rust rewriter supports modules and fails closed on parse errors', async () => {
  const rewriter = await loadRewriter();
  const mod = rewriter.rewriteScript(`import x from './x.js'; export const y = window.location.href;`, {
    kind: 'module',
    targetUrl: 'https://example.com/app.js',
  });
  assert.equal(mod.ok, true, JSON.stringify(mod.diagnostics));
  assert.ok(mod.code.includes('import x from "/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fx.js"'));
  assert.match(mod.code, /__zp_get\(__zp_get\(globalThis,"window"\),"location"\)/);

  const bad = rewriter.rewriteScript(`if (`, { kind: 'classic' });
  assert.equal(bad.ok, false);
  assert.equal(bad.errorCode, 'PARSE_FAILED');
});

test('Rust rewriter launders module import specifiers through same-origin script API', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(`import "./dep.js"; export async function load() { return import("./chunk.js"); }`, {
    kind: 'module',
    targetUrl: 'https://example.com/assets/main.js',
  });
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.ok(out.code.includes('import "/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fassets%2Fdep.js"'));
  assert.ok(out.code.includes('import("/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fassets%2Fchunk.js")'));
});

test('Rust rewriter accepts target URLs with cache-busting query strings', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(`window.location = "/next";`, {
    kind: 'classic',
    targetUrl: 'https://ipleak.net/static/js/index.js?ts=20220812#frag',
  });
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.match(out.code, /__zp_set\(__zp_get\(globalThis,"window"\),"location","\/next"\)/);
});

test('Rust rewriter accepts extensionless target URLs', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(`window._cf_chl_opt = { ray: location.href };`, {
    kind: 'classic',
    targetUrl: 'https://2captcha.com/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=abc123',
  });
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.match(out.code, /__zp_get\(globalThis,"location"\)\.href/);
});

test('Rust rewriter preserves compound writes and constructor escapes through helpers', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(`location.href += '#x'; ({}).constructor.constructor('return location.href')();`, { kind: 'classic' });
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.doesNotMatch(out.code, /Blocked by ZeroProxy rewrite policy/);
  assert.ok(out.code.includes('__zp_assign(__zp_get(globalThis,"location"),"href","+=",' + "'#x'" + ')'));
  assert.match(out.code, /__zp_call\(__zp_get\(\(\{\}\),"constructor"\),"constructor"/);
});

test('Rust rewriter preserves valid syntax for assignment targets, property keys, classes, and updates', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(`
    class Boundary {
      static parent;
      parent;
      parent = window.parent;
      constructor(source) {
        this.parent = window.parent;
        ({ parent: this.parent, location } = source);
        for (location in source) {}
      }
      method({ x = location.href }, y = window.location) {
        for (let window = 0; window < 1; window++) { window; }
        for (const parent in { parent: true }) { parent; }
        return { location, window, parent, x, y, current: this.parent };
      }
    }
    window.__svelte ??= {};
    (window.__svelte ??= {}).uid ??= 1;
    const post = location.hash++;
    const pre = ++window.location.hash;
  `, { kind: 'classic' });

  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.doesNotThrow(() => new Function(out.code));
  assert.match(out.code, /static parent;/);
  assert.match(out.code, /parent;/);
  assert.match(out.code, /location: __zp_get\(globalThis,"location"\)/);
  assert.match(out.code, /window: __zp_get\(globalThis,"window"\)/);
  assert.match(out.code, /parent: __zp_get\(globalThis,"parent"\)/);
  assert.match(out.code, /__zp_get\(globalThis,"window"\)\.__svelte \?\?= \{\}/);
  assert.ok(out.code.includes('__zp_update(__zp_get(globalThis,"location"),"hash","++",false)'));
  assert.ok(out.code.includes('__zp_update(__zp_get(__zp_get(globalThis,"window"),"location"),"hash","++",true)'));
  assert.doesNotMatch(out.code, /__zp_get\(globalThis,"parent"\);/);
  assert.doesNotMatch(out.code, /__zp_get\(this,"parent"\)\s*=/);
});

test('Rust rewriter rewrites construction through virtualized expressions instead of blocking', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(`
    function updateHref() {
      return location.href += '#x';
    }
    const ctor = new ({}).constructor.constructor('return location.href');
  `, { kind: 'classic' });

  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.doesNotThrow(() => new Function(out.code));
  assert.ok(out.code.includes('return (__zp_assign(__zp_get(globalThis,"location"),"href","+=",' + "'#x'" + '))'));
  assert.match(out.code, /const ctor = \(__zp_construct\(__zp_get\(__zp_get\(\(\{\}\),"constructor"\),"constructor"\),\['return location.href'\]\)\)/);
  assert.doesNotMatch(out.code, /throw new DOMException/);
});

test('Rust rewriter routes location assignments and WebSocket construction through helpers', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(`
    const assigned = (window.location = "https://google.com/");
    location.href = window.location.href + "#frag";
    const ws = new WebSocket("ws://example.test/socket", ["chat"]);
    const ws2 = new window.WebSocket("wss://example.test/secure");
    window.result = { assigned, href: location.href, wsURL: ws.url, ws2URL: ws2.url };
  `, { kind: 'classic' });
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.match(out.code, /__zp_set\(__zp_get\(globalThis,"window"\),"location","https:\/\/google\.com\/"\)/);
  assert.match(out.code, /__zp_set\(__zp_get\(globalThis,"location"\),"href",__zp_get\(__zp_get\(globalThis,"window"\),"location"\)\.href \+ "#frag"\)/);
  assert.match(out.code, /__zp_construct\(__zp_get\(globalThis,"WebSocket"\),\["ws:\/\/example\.test\/socket",\["chat"\]\]\)/);
  assert.match(out.code, /__zp_construct\(__zp_get\(globalThis,"window"\)\.WebSocket,\["wss:\/\/example\.test\/secure"\]\)/);

  const loc = { href: 'https://origin.test/start', hash: '' };
  function FakeWebSocket(url, protocols) {
    this.url = url;
    this.protocols = protocols;
  }
  const ctx = {
    location: loc,
    window: { location: loc, WebSocket: FakeWebSocket },
    WebSocket: FakeWebSocket,
  };
  ctx.globalThis = ctx;
  ctx.__zp_get = (base, prop) => base[prop];
  ctx.__zp_set = (base, prop, value) => {
    if ((base === ctx.window && prop === 'location') || (base === loc && prop === 'href')) loc.href = String(value);
    else base[prop] = value;
    return value;
  };
  ctx.__zp_assign = (base, prop, op, value) => ctx.__zp_set(base, prop, base[prop] + value);
  ctx.__zp_update = (base, prop, op, prefix) => {
    const current = base[prop];
    const next = op === '++' ? current + 1 : current - 1;
    base[prop] = next;
    return prefix ? next : current;
  };
  ctx.__zp_construct = (ctor, args) => new ctor(...args);
  vm.runInNewContext(out.code, ctx);
  assert.equal(loc.href, 'https://google.com/#frag');
  assert.equal(ctx.window.result.assigned, 'https://google.com/');
  assert.equal(ctx.window.result.href, 'https://google.com/#frag');
  assert.equal(ctx.window.result.wsURL, 'ws://example.test/socket');
  assert.equal(ctx.window.result.ws2URL, 'wss://example.test/secure');
});
