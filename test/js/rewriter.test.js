const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const oxc = require('@oxc-parser/wasm');

async function loadRewriter() {
  if (!globalThis.ZPRewriter) vm.runInThisContext(fs.readFileSync('web/js-rewriter.js', 'utf8'), { filename: 'web/js-rewriter.js' });
  await globalThis.ZPRewriter.init({ parser: oxc });
  return globalThis.ZPRewriter;
}
test('rewriter prefers Rust engine when available', async () => {
  vm.runInThisContext(fs.readFileSync('web/js-rewriter.js', 'utf8'), { filename: 'web/js-rewriter.js' });
  globalThis.ZPRustRewriter = { rewriteScript(source, kind, targetUrl, controlPrefix) { return { ok: true, code: `/*rust:${kind}:${targetUrl}:${controlPrefix}*/`, error: '' }; } };
  const out = globalThis.ZPRewriter.rewriteScript('window.location.href', { kind: 'classic', targetUrl: 'https://example.com/app.js', controlPrefix: '/zp/' });
  delete globalThis.ZPRustRewriter;
  assert.equal(out.ok, true);
  assert.equal(out.code, '/*rust:classic:https://example.com/app.js:/zp/*/');
});
test('built Rust rewriter asset rewrites live code paths', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-rust-unit-'));
  childProcess.execFileSync('node', ['scripts/build.mjs', '--web-only', '--out', outDir], { cwd: path.resolve(__dirname, '../..'), stdio: 'ignore' });
  const ctx = { console, atob, btoa, TextEncoder, TextDecoder, Uint8Array, WebAssembly, FinalizationRegistry, URL, globalThis: null };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(outDir, 'web', 'rust-rewriter.js'), 'utf8'), ctx, { filename: 'rust-rewriter.js' });
  const assign = ctx.ZPRustRewriter.rewriteScript('window.location.hash += \"-tail\";', 'classic', 'https://example.com/app.js', '/zp/');
  const meta = ctx.ZPRustRewriter.rewriteScript('new URL(\"/worker-fixture.js\", import.meta.url).href;', 'module', 'https://example.com/module-worker.js', '/zp/');
  assert.equal(assign.ok, true);
  assert.ok(assign.code.includes('__zp_assign(__zp_get(__zp_get(globalThis,\"window\"),\"location\"),\"hash\"'));
  assert.equal(meta.ok, true);
  assert.ok(meta.code.includes('\"https://example.com/module-worker.js\"'));
});

test('OXC rewriter virtualizes dangerous globals without rewriting local bindings', async () => {
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

test('OXC rewriter supports modules and fails closed on parse errors', async () => {
  const rewriter = await loadRewriter();
  const mod = rewriter.rewriteScript(`import x from './x.js'; export const y = window.location.href;`, { kind: 'module' });
  assert.equal(mod.ok, true, JSON.stringify(mod.diagnostics));
  assert.match(mod.code, /import x from/);
  assert.match(mod.code, /__zp_get\(__zp_get\(globalThis,"window"\),"location"\)/);

  const bad = rewriter.rewriteScript(`if (`, { kind: 'classic' });
  assert.equal(bad.ok, false);
  assert.equal(bad.errorCode, 'PARSE_FAILED');
  assert.match(rewriter.blockSource(), /Blocked by ZeroProxy rewrite policy/);
});

test('OXC rewriter launders module import specifiers through same-origin script API', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(`import "./dep.js"; export async function load() { return import("./chunk.js"); }`, {
    kind: 'module',
    targetUrl: 'https://example.com/assets/main.js',
  });
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.ok(out.code.includes('import "/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fassets%2Fdep.js"'));
  assert.ok(out.code.includes('import("/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fassets%2Fchunk.js")'));
});
test('OXC rewriter accepts target URLs with cache-busting query strings', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(`window.location = "/next";`, {
    kind: 'classic',
    targetUrl: 'https://ipleak.net/static/js/index.js?ts=20220812#frag',
  });
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.match(out.code, /__zp_set\(__zp_get\(globalThis,"window"\),"location","\/next"\)/);
});

test('OXC rewriter accepts extensionless target URLs', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(`window._cf_chl_opt = { ray: location.href };`, {
    kind: 'classic',
    targetUrl: 'https://2captcha.com/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=abc123',
  });
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.match(out.code, /__zp_get\(globalThis,"location"\)\.href/);
});

test('OXC rewriter preserves compound writes through virtual location helpers', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(`location.href += '#x'; ({}).constructor.constructor('return location.href')();`, { kind: 'classic' });
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.doesNotMatch(out.code, /Blocked by ZeroProxy rewrite policy/);
  assert.ok(out.code.includes('__zp_assign(__zp_get(globalThis,"location"),"href","+=",' + "'#x'" + ')'));
  assert.match(out.code, /__zp_call\(__zp_get\(\(\{\}\),\"constructor\"\),\"constructor\"/);
});

test('OXC rewriter preserves valid syntax for assignment targets and property keys', async () => {
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
  `, { kind: 'classic' });

  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.doesNotThrow(() => new Function(out.code));
  assert.match(out.code, /static parent;/);
  assert.match(out.code, /parent;/);
  assert.match(out.code, /location: __zp_get\(globalThis,"location"\)/);
  assert.match(out.code, /window: __zp_get\(globalThis,"window"\)/);
  assert.match(out.code, /parent: __zp_get\(globalThis,"parent"\)/);
  assert.match(out.code, /__zp_get\(globalThis,"window"\)\.__svelte \?\?= \{\}/);
  assert.doesNotMatch(out.code, /__zp_get\(globalThis,"parent"\);/);
  assert.doesNotMatch(out.code, /__zp_get\(this,"parent"\)\s*=/);
  assert.doesNotMatch(out.code, /throw new DOMException\('Blocked by ZeroProxy rewrite policy'/);
});

test('OXC rewriter emits expression-safe blocks for forbidden expression contexts', async () => {
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
  assert.match(out.code, /const ctor = \(\(\)=>\{throw new DOMException/);
});

test('OXC rewriter routes location assignments and WebSocket construction through helpers', async () => {
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

  const loc = { href: 'https://origin.test/start' };
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
  ctx.__zp_construct = (ctor, args) => new ctor(...args);
  vm.runInNewContext(out.code, ctx);
  assert.equal(loc.href, 'https://google.com/#frag');
  assert.equal(ctx.window.result.assigned, 'https://google.com/');
  assert.equal(ctx.window.result.href, 'https://google.com/#frag');
  assert.equal(ctx.window.result.wsURL, 'ws://example.test/socket');
  assert.equal(ctx.window.result.ws2URL, 'wss://example.test/secure');
});
