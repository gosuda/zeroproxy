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
