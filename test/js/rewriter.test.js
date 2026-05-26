const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const oxc = require('@oxc-parser/wasm');

async function loadRewriter() {
  if (!globalThis.ZPRewriter) vm.runInThisContext(fs.readFileSync('web/js-rewriter.js', 'utf8'), { filename: 'web/js-rewriter.js' });
  await globalThis.ZPRewriter.init({ parser: oxc });
  return globalThis.ZPRewriter;
}

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

test('OXC rewriter blocks constructor escape compound writes', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(`location.href += '#x'; ({}).constructor.constructor('return location.href')();`, { kind: 'classic' });
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.match(out.code, /Blocked by ZeroProxy rewrite policy/);
  assert.match(out.code, /__zp_call\(__zp_get\(\(\{\}\),\"constructor\"\),\"constructor\"/);
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
