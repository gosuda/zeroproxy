import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('ESM imports leave globalThis completely unpolluted', async () => {
  assert.equal('ZP' in globalThis, false);
  assert.equal('__zp_internal' in globalThis, false);
  assert.equal('ZeroProxyRT' in globalThis, false);
  assert.equal('ZPBundle' in globalThis, false);

  const core = await import('@gosuda/zeroproxy');
  const engineMod = await import('@gosuda/zeroproxy/engine');
  const rewriterMod = await import('@gosuda/zeroproxy/rewriter');
  const inlineMod = await import('@gosuda/zeroproxy/rewriter/inline');
  const policyMod = await import('@gosuda/zeroproxy/url-policy');
  const transportMod = await import('@gosuda/zeroproxy/transport');
  const membraneMod = await import('@gosuda/zeroproxy/membrane');
  const assetsMod = await import('@gosuda/zeroproxy/assets');

  assert.equal(typeof core.makeShareURL, 'function');
  assert.equal(typeof engineMod.createEngine, 'function');
  assert.equal(typeof rewriterMod.createRewriter, 'function');
  assert.equal(typeof inlineMod.createRewriterSync, 'function');
  assert.equal(typeof policyMod.createUrlPolicy, 'function');
  assert.equal(typeof transportMod.createTransportKernel, 'function');
  assert.equal(typeof membraneMod.configureBridge, 'function');
  assert.equal(typeof assetsMod.readWebAsset, 'function');

  assert.equal('ZP' in globalThis, false);
  assert.equal('__zp_internal' in globalThis, false);
  assert.equal('ZeroProxyRT' in globalThis, false);
  assert.equal('ZPBundle' in globalThis, false);
});

test('core subpath encrypts share URLs, frames v2 envelopes, and derives site-isolated origins', async () => {
  const {
    decryptShareURL,
    decodeEnvelope,
    encodeEnvelope,
    encryptShareURL,
    makeShareURL,
    siteFrameOrigin,
  } = await import('@gosuda/zeroproxy/core');

  const link = await encryptShareURL('https://Example.com/docs/../start?x=1#top');
  assert.equal(await decryptShareURL(link.encrypted, link.key), 'https://example.com/start?x=1#top');

  const fullUrl = await makeShareURL('https://example.com/', 'https://proxy.example');
  assert.match(fullUrl, /^https:\/\/proxy\.example\/zp\/p\/[^#]+#k=[^&]+&server=/);

  const payload = new Uint8Array([10, 20, 30, 40]);
  const wire = encodeEnvelope({ method: 'POST', url: 'https://example.com/api' }, payload);
  const decoded = decodeEnvelope(wire);
  assert.deepEqual(decoded.head, { method: 'POST', url: 'https://example.com/api' });
  assert.deepEqual(Array.from(decoded.body), [10, 20, 30, 40]);

  assert.match(
    siteFrameOrigin('http://proxy.localhost:8080', 'https://sub.example.com/path'),
    /^http:\/\/s-example-com-[0-9a-f]{8}\.localhost:8080$/,
  );
});

test('engine subpath rewrites UTF-8 JS, CSS, source maps, CSP, and streaming HTML', async () => {
  const { createEngine, createEngineSync } = await import('@gosuda/zeroproxy/engine');
  const engine = await createEngine({
    proxyOrigin: 'https://proxy.example',
    controlPrefix: '/zp/',
  });
  const syncEngine = createEngineSync({ proxyOrigin: 'https://proxy.example' });
  assert.equal(syncEngine.version, engine.version);
  assert.match(engine.version, /^\d+\.\d+\.\d+/);

  const utf8Source = 'const label = "\u00e9\u2603\ud83d\ude80";\nexport const href = window.location.href;\n';
  const rewrittenJs = engine.rewriteScript(utf8Source, {
    kind: 'module',
    targetUrl: 'https://target.example/app.mjs',
  });
  assert.match(rewrittenJs, /__zp_get/);
  assert.ok(rewrittenJs.includes('\u00e9\u2603\ud83d\ude80'));
  assert.equal(/[\u0001-\u0008]/.test(rewrittenJs), false, 'rewritten JS must not leak internal AST markers');

  const rewrittenCss = engine.rewriteCSS('body { background: url("/hero.png"); }', {
    baseUrl: 'https://target.example/styles/main.css',
  });
  assert.ok(
    rewrittenCss.includes('https://proxy.example/zp/api/v2/fetch?url='),
    `unexpected CSS output: ${rewrittenCss}`,
  );

  const sm = JSON.parse(
    engine.composeSourceMap('const h = window.location.href;\n', {
      kind: 'classic',
      targetUrl: 'https://target.example/bundle.js',
    }),
  );
  assert.equal(sm.version, 3);

  const csp = engine.buildCSP({ wsOrigin: 'wss://proxy.example', challengeCompat: true });
  assert.ok(csp.includes('https://challenges.cloudflare.com'));

  const rawHtml = '<!doctype html><html><head><title>Hi</title></head><body><a href="https://target.example/next">Next</a><script>window.x = location.href;</script></body></html>';
  const oneShotHtml = engine.transformHtml(rawHtml, {
    targetUrl: 'https://target.example/index.html',
  });
  assert.ok(oneShotHtml.includes('data-zp-target-url="https://target.example/next"'));
  assert.ok(oneShotHtml.includes('__ZP_EXEC_INLINE_'), 'inline script must be wrapped by __ZP_EXEC_INLINE_*');

  // Split HTML across 7-byte chunks to exercise streaming boundary buffering.
  const rawBytes = new TextEncoder().encode(rawHtml);
  const chunks = [];
  for (let i = 0; i < rawBytes.length; i += 7) {
    chunks.push(rawBytes.subarray(i, i + 7));
  }
  const stream = ReadableStream.from(chunks).pipeThrough(
    engine.createHtmlTransformStream({
      targetUrl: 'https://target.example/index.html',
      preludeHtml: '<meta name="zp-prelude" content="1">',
    }),
  );
  const outParts = [];
  for await (const part of stream) {
    outParts.push(part);
  }
  const streamedHtml = new TextDecoder().decode(Buffer.concat(outParts));
  assert.ok(streamedHtml.includes('<meta name="zp-prelude" content="1">'));
  assert.ok(streamedHtml.includes('data-zp-target-url="https://target.example/next"'));
  assert.ok(streamedHtml.includes('__ZP_EXEC_INLINE_'));

  // Aborting an in-flight HTML transform stream disposes HtmlTxn cleanly without throwing.
  const abortable = engine.createHtmlTransformStream({
    targetUrl: 'https://target.example/cancel.html',
  });
  const writer = abortable.writable.getWriter();
  const reader = abortable.readable.getReader();
  const readPending = reader.read();
  await writer.write('<!doctype html><html><head>');
  await reader.cancel('client aborted');
  await readPending.catch(() => {});
});

test('rewriter and inline rewriter subpaths execute synchronously and reject invalid syntax', async () => {
  const { createRewriterSync: createNodeRewriterSync } = await import('@gosuda/zeroproxy/rewriter');
  const { createRewriterSync: createInlineRewriterSync } = await import('@gosuda/zeroproxy/rewriter/inline');

  for (const factory of [createNodeRewriterSync, createInlineRewriterSync]) {
    const rewriter = factory({ proxyOrigin: 'https://proxy.example' });
    const out = rewriter.rewriteScript('const topWin = window.top;', {
      kind: 'classic',
      targetUrl: 'https://target.example/inline.js',
    });
    assert.match(out, /__zp_get/);
    assert.throws(() => rewriter.rewriteScript('function (', { targetUrl: 'https://target.example/bad.js' }));
  }
});

test('url-policy subpath classifies individual and batched URLs synchronously and asynchronously', async () => {
  const { createUrlPolicy, createUrlPolicySync, UrlClass } = await import('@gosuda/zeroproxy/url-policy');
  const asyncPolicy = await createUrlPolicy();
  const syncPolicy = createUrlPolicySync();

  for (const policy of [asyncPolicy, syncPolicy]) {
    assert.equal(policy.classOf('https://example.com/a'), UrlClass.HTTP);
    assert.equal(policy.classOf('javascript:alert(1)'), UrlClass.JAVASCRIPT);
    assert.equal(policy.classifySchemeOnly('about:blank'), UrlClass.ABOUT_BLANK);

    const packed = policy.classifyBatch([
      'https://example.com/one',
      'wss://example.com/socket',
      'javascript:void(0)',
      '/relative/path',
    ]);
    assert.ok(packed instanceof Uint32Array);
    assert.equal(packed.length, 4);
    assert.equal(policy.batchClass(packed[0]), UrlClass.HTTP);
    assert.equal(policy.batchClass(packed[1]), UrlClass.WS);
    assert.equal(policy.batchClass(packed[2]), UrlClass.JAVASCRIPT);
    assert.equal(policy.batchClass(packed[3]), UrlClass.RELATIVE);
    assert.equal(policy.viewURL(policy.batchHandle(packed[0])), 'https://example.com/one');
  }
});

test('workerd conditional modules enforce explicit WebAssembly.Module injection and initialize cleanly', async () => {
  const workerdEngineUrl = new URL('../../dist/esm/engine.workerd.js', import.meta.url);
  const workerdEngine = await import(workerdEngineUrl.href);

  await assert.rejects(
    () => workerdEngine.createEngine(),
    /Edge\/workerd runtimes disallow dynamic filesystem WASM reads/,
  );

  const wasmBytes = await readFile(new URL('../../dist/esm/wasm/zp-bundle.wasm', import.meta.url));
  const wasmModule = await WebAssembly.compile(wasmBytes);
  const engine = await workerdEngine.createEngine({
    wasmModule,
    proxyOrigin: 'https://edge.example',
  });
  const out = engine.rewriteScript('location.href = "/login";', {
    targetUrl: 'https://target.example/',
  });
  assert.match(out, /__zp_set/);
});

test('transport, membrane, assets, and npm pack verification enforce strict boundaries', async () => {
  const { createTransportKernel } = await import('@gosuda/zeroproxy/transport');
  const { configureBridge, getRealm } = await import('@gosuda/zeroproxy/membrane');
  const { readWasmManifest, readWebAsset } = await import('@gosuda/zeroproxy/assets');

  const kernel = await createTransportKernel();
  assert.match(kernel.version, /^\d+\.\d+\.\d+/);
  assert.match(kernel.banner, /^zp-kernel v/);

  const fakeWin = {};
  assert.equal(getRealm(fakeWin), null);
  const deferred = configureBridge(fakeWin, () => ({ send: async () => ({ ok: true }) }));
  assert.equal(deferred, null);
  assert.equal(typeof fakeWin.__zp_bridge_factory, 'function');

  const swAsset = await readWebAsset('sw.js');
  assert.equal(swAsset.contentType, 'text/javascript; charset=utf-8');
  assert.ok(swAsset.bytes.byteLength > 1000);
  assert.match(swAsset.sha256, /^[0-9a-f]{64}$/);
  await assert.rejects(() => readWebAsset('../wasm-manifest.json'), RangeError);

  const manifest = await readWasmManifest();
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.artifacts.length, 8);

  const packJson = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const [packInfo] = JSON.parse(packJson);
  const packedPaths = new Set(packInfo.files.map(f => f.path));
  assert.equal(packInfo.name, '@gosuda/zeroproxy');
  assert.ok(packedPaths.has('dist/esm/index.js'));
  assert.ok(packedPaths.has('dist/esm/engine.node.js'));
  assert.ok(packedPaths.has('dist/esm/engine.workerd.js'));
  assert.ok(packedPaths.has('dist/esm/wasm/zp-bundle.wasm'));
  assert.ok(packedPaths.has('dist/web/sw.js'));
  assert.ok(packedPaths.has('dist/wasm-manifest.json'));
  assert.equal(packedPaths.has('dist/zeroproxy-server'), false);
  assert.equal(packedPaths.has('dist/zeroproxy-server.exe'), false);

  // Extract a packed tarball into an isolated consumer directory and execute imports across subpaths.
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'zp-esm-consumer-'));
  try {
    const tgzName = execFileSync('npm', ['pack', '--quiet', '--pack-destination', tmpDir], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim().split(/\r?\n/).pop();
    const pkgDir = path.join(tmpDir, 'node_modules', '@gosuda', 'zeroproxy');
    await mkdir(pkgDir, { recursive: true });
    execFileSync('tar', ['-xzf', path.join(tmpDir, tgzName), '--strip-components=1', '-C', pkgDir]);
    await writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'consumer-smoke', private: true, type: 'module' }),
    );
    const consumerOut = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import { makeShareURL } from '@gosuda/zeroproxy';
          import { createEngine } from '@gosuda/zeroproxy/engine';
          import { createRewriterSync } from '@gosuda/zeroproxy/rewriter/inline';
          import { createUrlPolicySync, UrlClass } from '@gosuda/zeroproxy/url-policy';
          const engine = await createEngine({ proxyOrigin: 'https://proxy.example' });
          const js = engine.rewriteScript('location.href = "/ok";', { targetUrl: 'https://a.test/' });
          const rw = createRewriterSync({ proxyOrigin: 'https://proxy.example' });
          const pol = createUrlPolicySync();
          const url = await makeShareURL('https://a.test/', 'https://proxy.example');
          process.stdout.write(JSON.stringify({
            jsOk: js.includes('__zp_set'),
            rwOk: rw.rewriteScript('window.top', { targetUrl: 'https://a.test/' }).includes('__zp_get'),
            cls: pol.classOf('https://a.test/'),
            httpCls: UrlClass.HTTP,
            shareOk: url.startsWith('https://proxy.example/zp/p/'),
          }));
        `,
      ],
      { cwd: tmpDir, encoding: 'utf8' },
    );
    assert.deepEqual(JSON.parse(consumerOut), {
      jsOk: true,
      rwOk: true,
      cls: 1,
      httpCls: 1,
      shareOk: true,
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
