const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

let builtRustAssetPromise = null;

function loadBuiltRustContext() {
  if (!builtRustAssetPromise) {
    builtRustAssetPromise = (async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-rust-unit-'));
      const result = childProcess.spawnSync(
        'node',
        ['scripts/build.mjs', '--web-only', '--out', outDir],
        {
          cwd: path.resolve(__dirname, '../..'),
          encoding: 'utf8',
        },
      );
      if (result.status !== 0) {
        throw new Error(
          `node scripts/build.mjs --web-only --out ${outDir} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }
      const ctx = {
        console,
        atob,
        btoa,
        TextEncoder,
        TextDecoder,
        Uint8Array,
        WebAssembly,
        FinalizationRegistry,
        URL,
        Promise,
        crypto: crypto.webcrypto,
        globalThis: null,
      };
      ctx.globalThis = ctx;
      const wasmPath = path.join(outDir, 'web', 'rust-rewriter.wasm');
      ctx.XMLHttpRequest = class FileXMLHttpRequest {
        open(method, url) {
          this.method = method;
          this.url = url;
        }
        overrideMimeType() {}
        send() {
          assert.equal(this.method, 'GET');
          assert.equal(this.url, '/zp/assets/rust-rewriter.wasm');
          const bytes = fs.readFileSync(wasmPath);
          this.status = 200;
          this.responseText = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
        }
      };
      vm.createContext(ctx);
      const initStart = process.hrtime.bigint();
      vm.runInContext(fs.readFileSync(path.join(outDir, 'web', 'rust-rewriter.js'), 'utf8'), ctx, {
        filename: 'rust-rewriter.js',
      });
      await ctx.ZPRewriter.init();
      const initMs = Number(process.hrtime.bigint() - initStart) / 1e6;
      Object.defineProperty(ctx, '__buildOutDir', { value: outDir });
      Object.defineProperty(ctx, '__rustRewriterInitMs', { value: initMs });
      assert.equal(fs.existsSync(path.join(outDir, 'web', 'js-rewriter.js')), false);
      assert.equal(fs.existsSync(path.join(outDir, 'web', 'rust-rewriter.wasm')), true);
      return ctx;
    })();
  }
  return builtRustAssetPromise;
}

async function loadRewriter() {
  const ctx = await loadBuiltRustContext();
  return ctx.ZPRewriter;
}

function elapsedMs(fn) {
  const start = process.hrtime.bigint();
  const value = fn();
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  return { value, elapsed };
}

function generatedRewriteSource(lines) {
  const out = [];
  for (let i = 0; i < lines; i++) {
    out.push(
      `window["slot${i}"] = location.href + document.defaultView.location.href; history.pushState({}, "", "#${i}");`,
    );
  }
  return out.join('\n');
}

function assertWithinBudget(name, elapsed, budget) {
  assert.ok(elapsed <= budget, `${name} took ${elapsed.toFixed(2)}ms, budget ${budget}ms`);
}

function compactCode(source) {
  return String(source).replace(/\s+/g, '');
}

function assertCodeIncludes(source, needle) {
  assert.ok(compactCode(source).includes(compactCode(needle)), `missing ${needle} in ${source}`);
}

function loadHTTPRewriterContext(zpRewriter) {
  const ctx = {
    DOMException,
    ZP: { CONTROL_PREFIX: '/zp/' },
    ZPRewriter: zpRewriter,
    globalThis: null,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    fs.readFileSync(path.resolve(__dirname, '../../web/http-rewriter.js'), 'utf8'),
    ctx,
    {
      filename: 'web/http-rewriter.js',
    },
  );
  return ctx;
}

test('Rust rewriter asset exposes the public rewriter API without JS fallback assets', async () => {
  const ctx = await loadBuiltRustContext();
  assert.equal(typeof ctx.ZPRustRewriter.rewriteScript, 'function');
  assert.equal(typeof ctx.ZPRustRewriter.rewriteImportMap, 'function');
  assert.equal(typeof ctx.ZPRewriter.rewriteScript, 'function');
  assert.equal(typeof ctx.ZPRewriter.rewriteImportMap, 'function');
  assert.equal(ctx.ZPRewriter.ready, true);
  assert.equal(ctx.ZPRewriter.initSync(), true);
  assert.equal(await ctx.ZPRewriter.init(), true);
  const out = ctx.ZPRewriter.rewriteScript('window.location.href', {
    kind: 'classic',
    targetUrl: 'https://example.com/app.js',
    controlPrefix: '/zp/',
  });
  assert.equal(out.ok, true);
  assertCodeIncludes(
    out.code,
    '__zp_get(__zp_get(__zp_get(globalThis,"window"),"location"),"href")',
  );
  assert.equal('wasm_bindgen' in ctx, false);
});

test('Rust rewriter initialization stays within a coarse budget', async () => {
  const ctx = await loadBuiltRustContext();
  assertWithinBudget('rust-rewriter initSync asset load', ctx.__rustRewriterInitMs, 1000);
});

test('Rust rewriter asset is idempotent in a single realm', async () => {
  const ctx = await loadBuiltRustContext();
  const rustRewriter = ctx.ZPRustRewriter;
  const publicRewriter = ctx.ZPRewriter;
  const rustDescriptor = Object.getOwnPropertyDescriptor(ctx, 'ZPRustRewriter');
  const publicDescriptor = Object.getOwnPropertyDescriptor(ctx, 'ZPRewriter');
  assert.equal(rustDescriptor.enumerable, false);
  assert.equal(rustDescriptor.configurable, false);
  assert.equal(rustDescriptor.writable, false);
  assert.equal(publicDescriptor.enumerable, false);
  assert.equal(publicDescriptor.configurable, false);
  assert.equal(publicDescriptor.writable, false);

  assert.doesNotThrow(() => {
    vm.runInContext(
      fs.readFileSync(path.join(ctx.__buildOutDir, 'web', 'rust-rewriter.js'), 'utf8'),
      ctx,
      { filename: 'rust-rewriter.js' },
    );
  });
  assert.equal(ctx.ZPRustRewriter, rustRewriter);
  assert.equal(ctx.ZPRewriter, publicRewriter);
});

test('Rust rewriter latency stays within coarse size-bucket budgets', async () => {
  const rewriter = await loadRewriter();
  const cases = [
    { name: 'small', lines: 8, budgetMs: 250 },
    { name: 'medium', lines: 128, budgetMs: 750 },
    { name: 'large', lines: 512, budgetMs: 2000 },
  ];

  for (const { name, lines, budgetMs } of cases) {
    const source = generatedRewriteSource(lines);
    const warm = rewriter.rewriteScript(source, {
      kind: 'classic',
      targetUrl: `https://example.com/${name}.js`,
      controlPrefix: '/zp/',
    });
    assert.equal(warm.ok, true, JSON.stringify(warm.diagnostics));

    const measured = elapsedMs(() =>
      rewriter.rewriteScript(source, {
        kind: 'classic',
        targetUrl: `https://example.com/${name}.js`,
        controlPrefix: '/zp/',
      }),
    );
    assert.equal(measured.value.ok, true, JSON.stringify(measured.value.diagnostics));
    assertWithinBudget(`rewriteScript ${name}`, measured.elapsed, budgetMs);
  }

  const dynamicLines = Array.from(
    { length: 128 },
    (_, i) => `const v${i} = location.href + window.location.href;`,
  ).join('\n');
  const dynamicBody = `${dynamicLines}\nreturn v127;`;
  const dynamic = elapsedMs(() =>
    rewriter.rewriteFunctionBody(dynamicBody, [], 'https://example.com/dynamic.js', '/zp/'),
  );
  assert.equal(dynamic.value.ok, true, JSON.stringify(dynamic.value.diagnostics));
  assertWithinBudget('rewriteFunctionBody dynamic', dynamic.elapsed, 750);
});

test('browser build uses Vite without a direct esbuild build step', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const buildScript = fs.readFileSync(path.join(repoRoot, 'scripts', 'build.mjs'), 'utf8');

  assert.equal(packageJson.devDependencies.esbuild, undefined);
  assert.ok(packageJson.devDependencies.vite);
  assert.equal(lock.packages[''].devDependencies.esbuild, undefined);
  assert.equal(
    /from ['"]esbuild['"]|require\(['"]esbuild['"]\)|\besbuild\./.test(buildScript),
    false,
  );
  assert.match(buildScript, /await import\('vite'\)/);
});

test('Vite-built runtime prelude remains a classic bundled target asset', async () => {
  const ctx = await loadBuiltRustContext();
  const runtime = fs.readFileSync(
    path.join(ctx.__buildOutDir, 'web', 'runtime-prelude.js'),
    'utf8',
  );
  assert.match(runtime, /^\(function\(\) \{/);
  assert.equal(/^\s*import\s/m.test(runtime), false);
  assert.equal(/^\s*export\s/m.test(runtime), false);
  assert.ok(runtime.includes('SHARE_INFO_ENC'), 'runtime bundle should include zp-core');
  assert.ok(runtime.includes('defineHiddenAPI("ZPRustRewriter"'));
  assert.ok(runtime.includes('Object.defineProperty(globalThis, "ZPHTTPRewriter"'));
  for (const asset of ['zp-core', 'rust-rewriter', 'http-rewriter']) {
    assert.equal(runtime.includes(`<script nonce=zp src=/zp/assets/${asset}.js>`), false);
    assert.equal(runtime.includes(`<script nonce="zp" src="/zp/assets/${asset}.js">`), false);
  }
});

test('Vite-built runtime prelude bootstrap surface stays within coarse budgets', async () => {
  const ctx = await loadBuiltRustContext();
  const runtimePath = path.join(ctx.__buildOutDir, 'web', 'runtime-prelude.js');
  const runtime = fs.readFileSync(runtimePath, 'utf8');
  const bytes = fs.statSync(runtimePath).size;
  assert.ok(bytes <= 3_000_000, `runtime-prelude.js size ${bytes} exceeded 3000000 bytes`);
  assert.equal(runtime.includes('__zp_rust_b64'), false);
  assert.equal(runtime.includes('__ZP_RUST_WASM_BYTES'), false);
  assert.ok(runtime.includes('/zp/assets/rust-rewriter.wasm'));

  const measured = elapsedMs(() => new vm.Script(runtime, { filename: 'runtime-prelude.js' }));
  assertWithinBudget('runtime-prelude vm.Script compile', measured.elapsed, 750);
});

test('Vite-built worker prelude remains a classic bundled runtime asset', async () => {
  const ctx = await loadBuiltRustContext();
  const worker = fs.readFileSync(path.join(ctx.__buildOutDir, 'web', 'worker-prelude.js'), 'utf8');
  assert.match(worker, /^\(function\(\) \{/);
  assert.equal(/^\s*import\s/m.test(worker), false);
  assert.equal(/^\s*export\s/m.test(worker), false);
  assert.ok(worker.includes('SHARE_INFO_ENC'), 'worker bundle should include zp-core');
  assert.ok(worker.includes('__ZP_WORKER_PRELUDE'));
  assert.ok(worker.includes('maskNativeFunction(self.importScripts'));
  assert.equal(worker.includes("importScripts('/zp/assets/zp-core.js')"), false);
  assert.equal(worker.includes("importScripts(internalURL('/zp/assets/zp-core.js'))"), false);
});

test('Vite-built service worker remains a classic bundled runtime asset', async () => {
  const ctx = await loadBuiltRustContext();
  const sw = fs.readFileSync(path.join(ctx.__buildOutDir, 'web', 'sw.js'), 'utf8');
  assert.match(sw, /^\(function\(\) \{/);
  assert.equal(/^\s*import\s/m.test(sw), false);
  assert.equal(/^\s*export\s/m.test(sw), false);
  assert.ok(sw.includes('SHARE_INFO_ENC'), 'service worker bundle should include zp-core');
  assert.ok(sw.includes('defineHiddenAPI("ZPRustRewriter"'));
  assert.ok(sw.includes('Object.defineProperty(globalThis, "ZPHTTPRewriter"'));
  assert.ok(sw.includes('globalThis.Go = class'));
  assert.ok(sw.includes('const go = new Go()'));
  assert.ok(sw.includes('ZPSWResponses'));
  assert.ok(sw.includes('self.addEventListener("fetch"'));
  for (const asset of ['zp-core', 'rust-rewriter', 'http-rewriter', 'wasm_exec', 'sw-responses']) {
    assert.equal(sw.includes(`importScripts('/zp/assets/${asset}.js')`), false);
  }
});

test('Rust import-map rewriter rewrites import maps through the public API', async () => {
  const ctx = await loadBuiltRustContext();
  const source = JSON.stringify({
    imports: {
      a: '/a.js',
      b: './rel.js',
      bad: 'javascript:alert(1)',
      n: 123,
    },
    scopes: {
      '/s/': {
        c: '/c.js',
        n: 1,
      },
    },
  });

  const out = ctx.ZPRewriter.rewriteImportMap(source, {
    baseUrl: 'https://example.com/app/main.js',
    tabId: 'tab-1',
    runtimeToken: 'rt-1',
    controlPrefix: '/zp/',
  });

  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  const map = JSON.parse(out.code);
  assert.equal(
    map.imports.a,
    '/zp/api/script?kind=module&rt=rt-1&tab=tab-1&u=https%3A%2F%2Fexample.com%2Fa.js',
  );
  assert.equal(
    map.imports.b,
    '/zp/api/script?kind=module&rt=rt-1&tab=tab-1&u=https%3A%2F%2Fexample.com%2Fapp%2Frel.js',
  );
  assert.equal(map.imports.bad, '/zp/error/POLICY_BLOCKED');
  assert.equal(map.imports.n, 123);
  const scopeKey =
    '/zp/api/script?kind=module&rt=rt-1&tab=tab-1&u=https%3A%2F%2Fexample.com%2Fs%2F';
  assert.equal(
    map.scopes[scopeKey].c,
    '/zp/api/script?kind=module&rt=rt-1&tab=tab-1&u=https%3A%2F%2Fexample.com%2Fc.js',
  );
  assert.equal(Object.hasOwn(map.scopes[scopeKey], 'n'), false);

  const low = ctx.ZPRustRewriter.rewriteImportMap(
    'not json',
    'https://example.com/app/main.js',
    'tab-1',
    'rt-1',
    '/zp/',
  );
  assert.equal(low.ok, true);
  assert.equal(low.code, '{}');
  assert.equal(low.error, '');
});

test('Rust rewriter asset rewrites live code paths', async () => {
  const ctx = await loadBuiltRustContext();
  const assign = ctx.ZPRustRewriter.rewriteScript(
    'window.location.hash += "-tail"; document.defaultView.location.href;',
    'classic',
    'https://example.com/app.js',
    '/zp/',
  );
  const meta = ctx.ZPRustRewriter.rewriteScript(
    'new URL("/worker-fixture.js", import.meta.url).href;',
    'module',
    'https://example.com/module-worker.js',
    '/zp/',
  );
  const dynamic = ctx.ZPRustRewriter.rewriteScript(
    'export async function load(name) { return import("./chunks/" + name + ".js"); }',
    'module',
    'https://example.com/assets/main.js',
    '/zp/',
  );
  assert.equal(assign.ok, true);
  assert.ok(
    assign.code.includes('__zp_assign(__zp_get(__zp_get(globalThis,"window"),"location"),"hash"'),
  );
  assert.ok(assign.code.includes('__zp_get(__zp_get(globalThis,"document"),"defaultView")'));
  assert.equal(meta.ok, true);
  assert.ok(meta.code.includes('https://example.com/module-worker.js'));
  assert.equal(dynamic.ok, true);
  assert.ok(dynamic.code.includes('__zp_module_url('));
  assert.ok(dynamic.code.includes('https://example.com/assets/main.js'));
});

test('Rust rewriter asset can scope module graph URLs to a runtime context', async () => {
  const ctx = await loadBuiltRustContext();
  const out = ctx.ZPRewriter.rewriteScript(
    `import './dep.js'; export async function load() { return import('./chunk.js'); }`,
    {
      kind: 'module',
      targetUrl: 'https://example.com/assets/main.js',
      tabId: 'tab-1',
      runtimeToken: 'rt-1',
      controlPrefix: '/zp/',
    },
  );
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assertCodeIncludes(
    out.code,
    'import "/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fassets%2Fdep.js&tab=tab-1&rt=rt-1"',
  );
  assert.ok(
    out.code.includes(
      'import("/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fassets%2Fchunk.js&tab=tab-1&rt=rt-1")',
    ),
  );
});

test('Rust rewriter asset owns external script URL rewriting', async () => {
  const ctx = await loadBuiltRustContext();
  const classic = ctx.ZPRewriter.rewriteScriptURL('./app.js', {
    kind: 'classic',
    targetUrl: 'https://example.com/dir/page.html',
    tabId: 'tab-1',
    runtimeToken: 'rt-1',
    controlPrefix: '/zp/',
  });
  assert.equal(classic.ok, true, JSON.stringify(classic.diagnostics));
  assert.equal(classic.target, 'https://example.com/dir/app.js');
  assert.equal(
    classic.url,
    '/zp/api/script?kind=classic&u=https%3A%2F%2Fexample.com%2Fdir%2Fapp.js&tab=tab-1&rt=rt-1',
  );

  const module = ctx.ZPRewriter.rewriteScriptURL('/main.js', {
    kind: 'module',
    targetUrl: 'https://example.com/dir/page.html',
    tabId: 'tab-1',
    runtimeToken: 'rt-1',
    controlPrefix: '/zp/',
  });
  assert.equal(module.ok, true, JSON.stringify(module.diagnostics));
  assert.equal(
    module.url,
    '/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fmain.js&tab=tab-1&rt=rt-1',
  );

  const blocked = ctx.ZPRewriter.rewriteScriptURL('data:text/javascript,0', {
    kind: 'classic',
    targetUrl: 'https://example.com/dir/page.html',
    controlPrefix: '/zp/',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.url, '/zp/error/POLICY_BLOCKED');
});

test('Rust rewriter asset owns static fetch URL rewriting', async () => {
  const ctx = await loadBuiltRustContext();
  const fetched = ctx.ZPRewriter.rewriteFetchURL('/icons.svg#icon-a', {
    targetUrl: 'https://example.com/dir/page.html',
    controlPrefix: '/zp/',
  });
  assert.equal(fetched.ok, true, JSON.stringify(fetched.diagnostics));
  assert.equal(fetched.target, 'https://example.com/icons.svg#icon-a');
  assert.equal(fetched.url, '/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Ficons.svg#icon-a');

  const blocked = ctx.ZPRewriter.rewriteFetchURL('data:image/png,0', {
    targetUrl: 'https://example.com/dir/page.html',
    controlPrefix: '/zp/',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.url, '/zp/error/POLICY_BLOCKED');
});

test('Rust rewriter asset owns static srcset rewriting', async () => {
  const ctx = await loadBuiltRustContext();
  const rewritten = ctx.ZPRewriter.rewriteSrcset('/small.png 1x, ../large.png 2x', {
    targetUrl: 'https://example.com/dir/page.html',
    controlPrefix: '/zp/',
  });
  assert.equal(rewritten.ok, true, JSON.stringify(rewritten.diagnostics));
  assert.equal(
    rewritten.url,
    '/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fsmall.png 1x, /zp/api/fetch?url=https%3A%2F%2Fexample.com%2Flarge.png 2x',
  );
  assert.equal(
    rewritten.target,
    'https://example.com/small.png 1x, https://example.com/large.png 2x',
  );

  const unchanged = ctx.ZPRewriter.rewriteSrcset('data:image/png,AAAA 1x', {
    targetUrl: 'https://example.com/dir/page.html',
    controlPrefix: '/zp/',
  });
  assert.equal(unchanged.ok, false);
  assert.equal(unchanged.errorCode, 'UNCHANGED');
});

test('Rust rewriter asset owns streaming HTML document rewriting', async () => {
  const ctx = await loadBuiltRustContext();
  assert.equal(typeof ctx.ZPRewriter.rewriteHTMLDocument, 'function');
  assert.equal(typeof ctx.ZPRustRewriter.rewriteHTMLDocument, 'function');

  const source =
    '<head><meta http-equiv="refresh" content="0;url=https://evil.test/">' +
    '<link rel="preconnect" href="https://cdn.example/">' +
    '<link rel="icon" href="/favicon.ico">' +
    '<link rel="stylesheet" href="/app.css"></head>' +
    '<body><img src="/logo.png" srcset="/small.png 1x, ../large.png 2x">' +
    '<a href="/next">next</a><form action="submit"><button formaction="/alt">go</button></form>' +
    '<iframe src="/child"></iframe><object data="/movie.swf"></object>' +
    '<a href="javascript:alert(1)">bad</a></body>';
  const out = ctx.ZPRewriter.rewriteHTMLDocument(source, {
    targetUrl: 'https://example.com/app/page.html',
    controlPrefix: '/zp/',
    servers: ['wss://relay.example/ws'],
  });

  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  for (const want of [
    'href="/zp/p/',
    'action="/zp/p/',
    'formaction="/zp/p/',
    'src="/zp/p/',
    '#k=',
    'server=wss%3A%2F%2Frelay.example%2Fws',
    'data-zp-target-url="https://example.com/next"',
    'data-zp-target-url="https://example.com/app/submit"',
    'data-zp-target-url="https://example.com/alt"',
    'data-zp-target-url="https://example.com/child"',
    'src="/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Flogo.png"',
    'srcset="/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fsmall.png 1x, /zp/api/fetch?url=https%3A%2F%2Fexample.com%2Flarge.png 2x"',
    'href="data:application/x-zeroproxy-icon,1"',
    'href="/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fapp.css"',
    'data-zp-blocked-rel="preconnect"',
    'data-zp-blocked="object"',
    'ZeroProxy blocked object content',
    'href="#"',
    'data-zp-blocked-url="javascript:alert(1)"',
  ]) {
    assert.ok(out.code.includes(want), `missing ${want} in ${out.code}`);
  }
  for (const forbidden of [
    'http-equiv="refresh"',
    'href="https://cdn.example/"',
    'href="/favicon.ico"',
    'href="/app.css"',
    'src="/logo.png"',
    'href="/next"',
    'action="submit"',
    'formaction="/alt"',
    'src="/child"',
    '<object',
    'movie.swf',
  ]) {
    assert.equal(out.code.includes(forbidden), false, `raw fragment survived: ${forbidden}`);
  }

  const low = ctx.ZPRustRewriter.rewriteHTMLDocument(
    '<img src="/x.png">',
    'https://example.com/page.html',
    '/zp/',
    [],
  );
  assert.equal(low.ok, true);
  assert.ok(low.code.includes('/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fx.png'));
});

test('Rust rewriter asset owns static visible target URL resolution', async () => {
  const ctx = await loadBuiltRustContext();
  const resolved = ctx.ZPRewriter.rewriteTargetURL('touch.png', {
    targetUrl: 'https://example.com/dir/page.html',
    controlPrefix: '/zp/',
  });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  assert.equal(resolved.url, 'https://example.com/dir/touch.png');
  assert.equal(resolved.target, 'https://example.com/dir/touch.png');

  const blocked = ctx.ZPRewriter.rewriteTargetURL('javascript:alert(1)', {
    targetUrl: 'https://example.com/dir/page.html',
    controlPrefix: '/zp/',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.url, '/zp/error/POLICY_BLOCKED');
});

test('Rust rewriter asset owns static link rel policy classification', async () => {
  const ctx = await loadBuiltRustContext();
  assert.equal(ctx.ZPRewriter.classifyLinkRel('stylesheet'), 'stylesheet');
  assert.equal(ctx.ZPRewriter.classifyLinkRel('apple-touch-icon'), 'icon');
  assert.equal(ctx.ZPRewriter.classifyLinkRel('icon preconnect'), 'blocked');
  assert.equal(ctx.ZPRustRewriter.classifyLinkRel('canonical'), 'pass');
});

test('Rust rewriter asset owns blocked element policy classification', async () => {
  const ctx = await loadBuiltRustContext();
  assert.equal(ctx.ZPRewriter.classifyBlockedElement('object'), 'object');
  assert.equal(ctx.ZPRewriter.classifyBlockedElement('EMBED'), 'embed');
  assert.equal(ctx.ZPRustRewriter.classifyBlockedElement('iframe'), 'pass');
});

test('Rust rewriter asset owns static meta policy classification', async () => {
  const ctx = await loadBuiltRustContext();
  assert.equal(ctx.ZPRewriter.classifyMetaPolicy('refresh'), 'drop');
  assert.equal(ctx.ZPRewriter.classifyMetaPolicy('Content-Security-Policy'), 'drop');
  assert.equal(ctx.ZPRewriter.classifyMetaPolicy('content-security-policy-report-only'), 'drop');
  assert.equal(ctx.ZPRustRewriter.classifyMetaPolicy('viewport'), 'pass');
});

test('Rust rewriter asset owns static attribute URL policy classification', async () => {
  const ctx = await loadBuiltRustContext();
  assert.equal(ctx.ZPRewriter.classifyAttrPolicy('a', 'href'), 'navigation');
  assert.equal(ctx.ZPRewriter.classifyAttrPolicy('iframe', 'src'), 'navigation');
  assert.equal(ctx.ZPRewriter.classifyAttrPolicy('img', 'src'), 'passive');
  assert.equal(ctx.ZPRewriter.classifyAttrPolicy('image', 'xlink:href'), 'passive');
  assert.equal(ctx.ZPRewriter.classifyAttrPolicy('source', 'srcset'), 'srcset');
  assert.equal(ctx.ZPRewriter.classifyAttrPolicy('div', 'style'), 'style');
  assert.equal(ctx.ZPRustRewriter.classifyAttrPolicy('script', 'src'), 'pass');
});

test('Rust rewriter asset can mint encrypted share routes', async () => {
  const ctx = await loadBuiltRustContext();
  const out = ctx.ZPRewriter.makeShareURL('https://example.com/path', {
    servers: [
      'wss://relay.example:443/ws',
      'wss://relay.example/ws',
      'ws://proxy.localhost:8080/zp/ws-pipe',
    ],
  });
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.match(out.url, /^\/zp\/p\/[A-Za-z0-9_-]+#k=[A-Za-z0-9_-]+/);
  assert.ok(out.url.includes('server=wss%3A%2F%2Frelay.example%2Fws'));
  assert.ok(out.url.includes('server=ws%3A%2F%2Fproxy.localhost%3A8080%2Fzp%2Fws-pipe'));

  const blocked = ctx.ZPRewriter.makeShareURL('javascript:alert(1)');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errorCode, 'shareurl: unsupported target URL');
});

test('Rust rewriter asset owns static script type classification', async () => {
  const ctx = await loadBuiltRustContext();
  assert.equal(ctx.ZPRewriter.classifyScriptType(''), 'classic');
  assert.equal(ctx.ZPRewriter.classifyScriptType('text/javascript'), 'classic');
  assert.equal(ctx.ZPRewriter.classifyScriptType('module'), 'module');
  assert.equal(ctx.ZPRewriter.classifyScriptType('importmap'), 'importmap');
  assert.equal(ctx.ZPRewriter.classifyScriptType('speculationrules'), 'speculationrules');
  assert.equal(ctx.ZPRustRewriter.classifyScriptType('application/json'), 'pass');
});

test('Rust rewriter asset owns static event handler attr classification', async () => {
  const ctx = await loadBuiltRustContext();
  assert.equal(ctx.ZPRewriter.classifyEventHandlerAttr('onclick'), 'block');
  assert.equal(ctx.ZPRewriter.classifyEventHandlerAttr('onLoad'), 'block');
  assert.equal(ctx.ZPRewriter.classifyEventHandlerAttr('on'), 'pass');
  assert.equal(ctx.ZPRustRewriter.classifyEventHandlerAttr('data-onclick'), 'pass');
});

test('Rust rewriter asset reports parse failures', async () => {
  const ctx = await loadBuiltRustContext();
  const out = ctx.ZPRustRewriter.rewriteScript(
    'if (',
    'classic',
    'https://example.com/app.js',
    '/zp/',
  );
  assert.equal(out.ok, false);
  assert.equal(out.error, 'PARSE_FAILED');
  const publicOut = ctx.ZPRewriter.rewriteScript('if (', {
    kind: 'classic',
    targetUrl: 'https://example.com/app.js',
  });
  assert.equal(publicOut.ok, false);
  assert.equal(publicOut.errorCode, 'PARSE_FAILED');
  assert.match(ctx.ZPRewriter.blockSource(), /Blocked by ZeroProxy rewrite policy/);
});

test('HTTP script rewriter reports redacted fail-close classifications', () => {
  const secret = 'target-secret-token';
  const block =
    "throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');";
  const ctx = loadHTTPRewriterContext({
    ready: true,
    rewriteScript() {
      return { ok: false, errorCode: 'PARSE_FAILED', diagnostics: [{ message: secret }] };
    },
    blockSource() {
      return block;
    },
  });
  const outcome = ctx.ZPHTTPRewriter.rewriteScriptOutcome(`if (${secret}`, {
    kind: 'classic',
    contentType: 'application/javascript',
    charset: 'utf-8',
  });
  assert.deepEqual(Object.keys(outcome).sort(), [
    'blocked',
    'code',
    'errorCode',
    'failureTelemetry',
  ]);
  assert.equal(outcome.blocked, true);
  assert.equal(outcome.code, block);
  assert.equal(outcome.errorCode, 'PARSE_FAILED');
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.failureTelemetry)), {
    schema: 'zp.rewrite.failure.v1',
    rewriteKind: 'classic',
    sourceSizeBucket: '<1KiB',
    parserErrorKind: 'parse-failed',
    contentType: 'application/javascript',
    charset: 'utf-8',
    finalAction: 'block',
  });
  assert.equal(JSON.stringify(outcome).includes(secret), false);
  assert.equal(ctx.ZPHTTPRewriter.rewriteScriptOrBlock(secret), block);

  const unavailable = loadHTTPRewriterContext({ ready: false });
  const unavailableOutcome = unavailable.ZPHTTPRewriter.rewriteScriptOutcome(secret);
  assert.equal(unavailableOutcome.blocked, true);
  assert.equal(unavailableOutcome.errorCode, 'REWRITER_UNAVAILABLE');
  assert.equal(JSON.stringify(unavailableOutcome).includes(secret), false);
});

test('HTTP script rewriter retries safe parse-recovery variants before blocking', () => {
  const calls = [];
  const ctx = loadHTTPRewriterContext({
    ready: true,
    rewriteScript(source) {
      calls.push(source);
      if (String(source).startsWith('//<!--')) return { ok: true, code: 'location.href;' };
      return { ok: false, errorCode: 'PARSE_FAILED' };
    },
    blockSource() {
      return 'blocked();';
    },
  });
  const outcome = ctx.ZPHTTPRewriter.rewriteScriptOutcome('<!--\nlocation.href;', {
    kind: 'classic',
  });
  assert.equal(outcome.blocked, false);
  assert.equal(outcome.code, 'location.href;');
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.recovery)), {
    attempted: ['classic-html-comment'],
    used: 'classic-html-comment',
  });
  assert.equal(calls[0], '<!--\nlocation.href;');
  assert.equal(calls[1], '//<!--\nlocation.href;');
});

test('HTTP script rewriter retries classic-module classification mismatches safely', () => {
  const calls = [];
  const kinds = [];
  const ctx = loadHTTPRewriterContext({
    ready: true,
    rewriteScript(source, options = {}) {
      calls.push(String(source));
      kinds.push(String(options.kind || 'classic'));
      if (options.kind === 'module') return { ok: true, code: 'export default 1;' };
      return { ok: false, errorCode: 'PARSE_FAILED' };
    },
    blockSource() {
      return 'blocked();';
    },
  });
  const outcome = ctx.ZPHTTPRewriter.rewriteScriptOutcome('export default 1;', {
    kind: 'classic',
  });
  assert.equal(outcome.blocked, false);
  assert.equal(outcome.code, 'export default 1;');
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.recovery)), {
    attempted: ['classic-to-module'],
    used: 'classic-to-module',
  });
  assert.deepEqual(kinds, ['classic', 'module']);
  assert.deepEqual(calls, ['export default 1;', 'export default 1;']);
});

test('HTTP script rewriter passes runtime context into module script rewriting', async () => {
  const ctx = loadHTTPRewriterContext(await loadRewriter());
  const outcome = ctx.ZPHTTPRewriter.rewriteScriptOutcome(
    `import './dep.js'; export const href = location.href;`,
    {
      kind: 'module',
      targetUrl: 'https://example.com/app.js',
      tabId: 'tab-1',
      runtimeToken: 'rt-1',
    },
  );
  assert.equal(outcome.blocked, false);
  assertCodeIncludes(
    outcome.code,
    'import "/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fdep.js&tab=tab-1&rt=rt-1"',
  );
});

test('Rust CSS rewriter rewrites only AST URL resources', async () => {
  const rewriter = await loadRewriter();
  const source = `
    /* url("https://comment.invalid/leak.png") */
    @import "/css/theme.css" screen;
    .hero {
      background-image: url(/img/hero.png);
      list-style-image: url(/img/symbols.svg#icon-star);
      cursor: url("https://cdn.example/cursor.cur"), pointer;
      content: "url(https://string.invalid/not-a-request.png)";
      mask-image: url(data:image/png;base64,AAAA);
    }
  `;
  const out = rewriter.rewriteCSS(source, {
    baseUrl: 'https://example.com/app/site.css',
    controlPrefix: '/zp/',
  });
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.ok(
    out.code.includes('@import "/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fcss%2Ftheme.css"'),
  );
  assert.ok(
    out.code.includes('url("/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fimg%2Fhero.png")'),
  );
  assert.ok(
    out.code.includes(
      'url("/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fimg%2Fsymbols.svg#icon-star")',
    ),
  );
  assert.ok(out.code.includes('url("/zp/api/fetch?url=https%3A%2F%2Fcdn.example%2Fcursor.cur")'));
  assert.ok(out.code.includes('/* url("https://comment.invalid/leak.png") */'));
  assert.ok(out.code.includes('"url(https://string.invalid/not-a-request.png)"'));
  assert.ok(out.code.includes('url(data:image/png;base64,AAAA)'));

  const attr = rewriter.rewriteCSS(`background:url('../attr.png'); color:red`, {
    baseUrl: 'https://example.com/a/b/page.html',
    controlPrefix: '/zp/',
  });
  assert.equal(attr.ok, true, JSON.stringify(attr.diagnostics));
  assert.ok(
    attr.code.includes('url("/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fa%2Fattr.png")'),
  );
});

test('Rust rewriter supports event-handler and dynamic function body paths', async () => {
  const rewriter = await loadRewriter();
  const handler = rewriter.rewriteScript('return location.href', {
    kind: 'event-handler',
    targetUrl: 'https://example.com/',
  });
  assert.equal(handler.ok, true);
  assert.match(handler.code, /__zp_runEvent/);
  assertCodeIncludes(handler.code, '__zp_get(__zp_get(globalThis,"location"),"href")');

  const fnBody = rewriter.rewriteFunctionBody(
    'return location.href + window.location.href;',
    ['location'],
    'https://example.com/',
  );
  assert.equal(fnBody.ok, true);
  assertCodeIncludes(
    fnBody.code,
    'return location.href+__zp_get(__zp_get(__zp_get(globalThis,"window"),"location"),"href")',
  );

  const evalBody = rewriter.rewriteScript('return (this);', {
    kind: 'function',
    targetUrl: 'https://example.com/',
  });
  assert.equal(evalBody.ok, true, JSON.stringify(evalBody.diagnostics));
  assertCodeIncludes(evalBody.code, 'return(this);');
});

test('Rust rewriter virtualizes dangerous globals without rewriting local bindings', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(
    `
    const location = { href: 'local' };
    const w = window;
    window.out = [origin, location.href, window.location.href, window['loca' + 'tion'].href, document.defaultView.location.href, w.location.href];
    Function('return location.href')();
  `,
    { kind: 'classic' },
  );
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assertCodeIncludes(out.code, 'const location={href:"local"}');
  assert.match(out.code, /location\.href/);
  assert.match(out.code, /__zp_get\(globalThis,"window"\)/);
  assert.match(out.code, /__zp_get\(globalThis,"origin"\)/);
  assert.match(out.code, /__zp_get\(__zp_get\(globalThis,"document"\),"defaultView"\)/);
  assert.match(out.code, /__zp_get\(globalThis,"Function"\)/);
});

test('Rust rewriter preserves bare eval as lexical direct eval', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(
    `
    (function() {
      var localCollector = function(root) { return root.items.length; };
      var source = "(function(root) { return localCollector(root); })";
      eval("var compiledSelector = " + source + ";");
      window.__maskedSelectorEval = compiledSelector({ items: [1, 2, 3] });
    })();
    window.__maskedEvalOrigin = eval('location.origin');
    window.__maskedWindowEvalOrigin = window.eval('location.origin');
    var maskedIndirectEval = window.eval;
    window.__maskedIndirectEvalOrigin = maskedIndirectEval('location.origin');
  `,
    { kind: 'classic' },
  );
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.match(out.code, /\beval\(__zp_eval_source\("var compiledSelector = "\+source\+";"\)\)/);
  assert.match(out.code, /\beval\(__zp_eval_source\("location.origin"\)\)/);
  assert.match(
    out.code,
    /__zp_call\(__zp_get\(globalThis,"window"\),"eval",\["location.origin"\]\)/,
  );
  assert.match(out.code, /maskedIndirectEval=__zp_get\(__zp_get\(globalThis,"window"\),"eval"\)/);
  assert.doesNotMatch(out.code, /__zp_get\(globalThis,"eval"\)/);
});

test('Rust rewriter supports modules and fails closed on parse errors', async () => {
  const rewriter = await loadRewriter();
  const mod = rewriter.rewriteScript(
    `import x from './x.js'; export const y = window.location.href;`,
    {
      kind: 'module',
      targetUrl: 'https://example.com/app.js',
    },
  );
  assert.equal(mod.ok, true, JSON.stringify(mod.diagnostics));
  assertCodeIncludes(
    mod.code,
    'import x from "/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fx.js"',
  );
  assertCodeIncludes(
    mod.code,
    '__zp_get(__zp_get(__zp_get(globalThis,"window"),"location"),"href")',
  );

  const bad = rewriter.rewriteScript(`if (`, { kind: 'classic' });
  assert.equal(bad.ok, false);
  assert.equal(bad.errorCode, 'PARSE_FAILED');
});

test('Rust rewriter launders module import specifiers through same-origin script API', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(
    `import "./dep.js"; export async function load() { return import("./chunk.js"); }`,
    {
      kind: 'module',
      targetUrl: 'https://example.com/assets/main.js',
    },
  );
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assertCodeIncludes(
    out.code,
    'import "/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fassets%2Fdep.js"',
  );
  assert.ok(
    out.code.includes(
      'import("/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fassets%2Fchunk.js")',
    ),
  );
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
  const out = rewriter.rewriteScript(`window.__probe_opt = { ray: location.href };`, {
    kind: 'classic',
    targetUrl: 'https://example.com/extensionless/loader/v1?ray=abc123',
  });
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assertCodeIncludes(out.code, '__zp_get(__zp_get(globalThis,"location"),"href")');
});

test('Rust rewriter routes in-operator checks on virtual windows through helper', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(`if ("widget" in window) window.widget.render();`, {
    kind: 'classic',
    targetUrl: 'https://widgets.example/assets/api.js',
  });
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.ok(out.code.includes('(__zp_has(__zp_get(globalThis,"window"),"widget"))'));
  assert.equal(out.code.includes('"widget" in __zp_get(globalThis,"window")'), false);
});

test('Rust rewriter routes delete and typeof checks on virtual globals through helpers', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(
    `delete window.location; typeof window.location; typeof location;`,
    {
      kind: 'classic',
      targetUrl: 'https://widgets.example/assets/api.js',
    },
  );
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assertCodeIncludes(out.code, '__zp_delete(__zp_get(globalThis,"window"),"location")');
  assertCodeIncludes(out.code, '__zp_typeof(__zp_get(globalThis,"window"),"location")');
  assertCodeIncludes(out.code, '__zp_typeof(globalThis,"location")');
});

test('Rust rewriter preserves inert strings comments regexes and property keys', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(
    `
    // window.location.href in a comment must stay inert
    const text = "window.location.href";
    const pattern = /window\\.location\\.href/;
    const object = { location: "key", window() { return "method"; } };
    const executable = window.location.href;
    window.__probe = { text, pattern, object, executable };
  `,
    {
      kind: 'classic',
      targetUrl: 'https://widgets.example/assets/api.js',
    },
  );
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assertCodeIncludes(out.code, '"window.location.href"');
  assertCodeIncludes(out.code, '/window\\.location\\.href/');
  assertCodeIncludes(out.code, 'location:"key"');
  assertCodeIncludes(out.code, 'window(){');
  assertCodeIncludes(
    out.code,
    '__zp_get(__zp_get(__zp_get(globalThis,"window"),"location"),"href")',
  );
});

test('Rust rewriter preserves optional access semantics for guarded probes', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(
    `
    const href = maybeWindow?.location?.href;
    const desc = Object.getOwnPropertyDescriptors?.(window);
    const keys = Reflect.ownKeys?.(window);
    const sent = frame?.contentWindow?.postMessage?.({ ok: true }, location.origin);
  `,
    {
      kind: 'classic',
      targetUrl: 'https://widgets.example/assets/api.js',
    },
  );
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.ok(out.code.includes('__zp_optionalGet'));
  assert.ok(out.code.includes('__zp_optionalCall'));
  assert.ok(out.code.includes('__zp_optionalCall(Object,"getOwnPropertyDescriptors"'));
  assert.ok(out.code.includes('__zp_optionalCall(Reflect,"ownKeys"'));
  assert.ok(
    out.code.includes('__zp_optionalCall(__zp_optionalGet(frame,"contentWindow"),"postMessage"'),
  );
  assert.equal(
    out.code.includes('__zp_optionalGet(__zp_optionalGet(frame,"contentWindow"),"postMessage")('),
    false,
  );
});

test('Rust rewriter preserves spread call arguments passed through helpers', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(
    `
    const sources = [{ reducer: 1 }, { middleware() { return 'ok'; } }];
    const target = {};
    Object.assign(target, ...sources);
    window.result = [target.reducer, typeof target.middleware, target.middleware()];
  `,
    {
      kind: 'classic',
      targetUrl: 'https://widgets.example/assets/api.js',
    },
  );
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assertCodeIncludes(out.code, '__zp_call(Object,"assign",[target,...sources])');

  const ctx = {
    Object,
    window: {},
    globalThis: null,
    __zp_get: (base, prop) => base[prop],
    __zp_set: (base, prop, value) => {
      base[prop] = value;
      return value;
    },
    __zp_call: (base, prop, args) => Reflect.apply(base[prop], base, args),
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(out.code, ctx);
  assert.equal(ctx.window.result[0], 1);
  assert.equal(ctx.window.result[1], 'function');
  assert.equal(ctx.window.result[2], 'ok');
});

test('Rust rewriter routes computed global-alias member access through runtime membrane', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(
    `let G; G = this || self; const k = decode(); const v = G[k]; G[k] = v + 1; G[k](); G[k][k](); const local = obj[k];`,
    {
      kind: 'classic',
      targetUrl: 'https://example.com/app.js',
    },
  );
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assertCodeIncludes(out.code, 'G=__zp_get(globalThis,"window")||__zp_get(globalThis,"self")');
  assert.ok(out.code.includes('__zp_get(G,k)'));
  assert.ok(out.code.includes('__zp_set(G,k,v+1)'));
  assert.ok(out.code.includes('__zp_call(G,k,[])'));
  assert.ok(out.code.includes('__zp_call(__zp_get(G,k),k,[])'));
  assertCodeIncludes(out.code, 'const local=obj[k]');
});

test('Rust rewriter tracks computed document aliases from global aliases', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(
    `let G = window; let D = G[name]; const host = D[loc].hostname; D[loc].replace('/next');`,
    {
      kind: 'classic',
      targetUrl: 'https://example.com/extensionless/orchestrate/v1?ray=abc',
    },
  );
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assertCodeIncludes(out.code, 'let D=__zp_get(G,name)');
  assert.ok(out.code.includes('__zp_get(D,loc).hostname'));
  assert.ok(out.code.includes('__zp_call(__zp_get(D,loc),"replace"'));
});

test('Rust rewriter preserves compound writes and constructor escapes through helpers', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(
    `location.href += '#x'; ({}).constructor.constructor('return location.href')();`,
    { kind: 'classic' },
  );
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.doesNotMatch(out.code, /Blocked by ZeroProxy rewrite policy/);
  assertCodeIncludes(out.code, '__zp_assign(__zp_get(globalThis,"location"),"href","+=","#x")');
  assert.match(out.code, /__zp_call\(__zp_get\(\(\{\}\),"constructor"\),"constructor"/);
});

test('Rust rewriter preserves valid syntax for assignment targets, property keys, classes, and updates', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(
    `
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
  `,
    { kind: 'classic' },
  );

  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.doesNotThrow(() => new Function(out.code));
  assert.match(out.code, /static parent;/);
  assert.match(out.code, /parent;/);
  assertCodeIncludes(out.code, 'location:__zp_get(globalThis,"location")');
  assertCodeIncludes(out.code, 'window:__zp_get(globalThis,"window")');
  assertCodeIncludes(out.code, 'parent:__zp_get(globalThis,"parent")');
  assertCodeIncludes(out.code, 'window.__svelte??={}');
  assert.ok(out.code.includes('__zp_update(__zp_get(globalThis,"location"),"hash","++",false)'));
  assert.ok(
    out.code.includes(
      '__zp_update(__zp_get(__zp_get(globalThis,"window"),"location"),"hash","++",true)',
    ),
  );
  assert.doesNotMatch(out.code, /__zp_get\(globalThis,"parent"\);/);
  assert.doesNotMatch(out.code, /__zp_get\(this,"parent"\)\s*=/);
});

test('Rust rewriter preserves ASI between rewritten assignment statements', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(
    `
    window["EAGER-DATA"] = window["EAGER-DATA"] || {}
    window["EAGER-DATA"]["PC-FEED-WRAPPER"] = { ok: true }
    window["EAGER-DATA"]["NEXT"] = { ok: true }
  `,
    { kind: 'classic' },
  );

  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.doesNotThrow(() => new Function(out.code));
  assert.match(out.code, /__zp_set\(__zp_get\(globalThis,"window"\),"EAGER-DATA",[\s\S]*\);/);
  const ctx = { window: {}, globalThis: null };
  ctx.globalThis = ctx;
  ctx.__zp_get = (base, prop) => base[prop];
  ctx.__zp_set = (base, prop, value) => {
    base[prop] = value;
    return value;
  };
  vm.createContext(ctx);
  assert.doesNotThrow(() => vm.runInContext(out.code, ctx));
  assert.equal(ctx.window['EAGER-DATA'].NEXT.ok, true);
});

test('Rust rewriter rewrites construction through virtualized expressions instead of blocking', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(
    `
    function updateHref() {
      return location.href += '#x';
    }
    const ctor = new ({}).constructor.constructor('return location.href');
  `,
    { kind: 'classic' },
  );

  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.doesNotThrow(() => new Function(out.code));
  assertCodeIncludes(
    out.code,
    'return __zp_assign(__zp_get(globalThis,"location"),"href","+=","#x")',
  );
  assertCodeIncludes(
    out.code,
    'const ctor=__zp_construct(__zp_get(__zp_get(({}),"constructor"),"constructor"),["return location.href"])',
  );
  assert.doesNotMatch(out.code, /throw new DOMException/);
});

test('Rust rewriter routes location assignments and WebSocket construction through helpers', async () => {
  const rewriter = await loadRewriter();
  const out = rewriter.rewriteScript(
    `
    const assigned = (window.location = "https://google.com/");
    location.href = window.location.href + "#frag";
    const ws = new WebSocket("ws://example.test/socket", ["chat"]);
    const ws2 = new window.WebSocket("wss://example.test/secure");
    window.result = { assigned, href: location.href, wsURL: ws.url, ws2URL: ws2.url };
  `,
    { kind: 'classic' },
  );
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
  assert.match(
    out.code,
    /__zp_set\(__zp_get\(globalThis,"window"\),"location","https:\/\/google\.com\/"\)/,
  );
  assertCodeIncludes(
    out.code,
    '__zp_set(__zp_get(globalThis,"location"),"href",__zp_get(__zp_get(__zp_get(globalThis,"window"),"location"),"href")+"#frag")',
  );
  assert.match(
    out.code,
    /__zp_construct\(__zp_get\(globalThis,"WebSocket"\),\["ws:\/\/example\.test\/socket",\["chat"\]\]\)/,
  );
  assert.match(
    out.code,
    /__zp_construct\(__zp_get\(globalThis,"window"\)\.WebSocket,\["wss:\/\/example\.test\/secure"\]\)/,
  );

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
    if ((base === ctx.window && prop === 'location') || (base === loc && prop === 'href'))
      loc.href = String(value);
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
