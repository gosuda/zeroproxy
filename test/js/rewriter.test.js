const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');

function buildWebOut() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-runtime-unit-'));
  const result = childProcess.spawnSync(
    'node',
    ['scripts/build.mjs', '--web-only', '--out', outDir],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `node scripts/build.mjs --web-only --out ${outDir} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return outDir;
}

test('build excludes browser-packaged Rust AST rewriter assets', () => {
  const outDir = buildWebOut();
  for (const asset of [
    'rust-rewriter.js',
    'rust-rewriter.wasm',
    'http-rewriter.js',
    'js-rewriter.js',
  ]) {
    assert.equal(
      fs.existsSync(path.join(outDir, 'web', asset)),
      false,
      `${asset} must not be emitted`,
    );
  }
  const runtimePrelude = fs.readFileSync(path.join(outDir, 'web', 'runtime-prelude.js'), 'utf8');
  assert.equal(runtimePrelude.includes('ZPRewriter'), false);
  assert.equal(runtimePrelude.includes('ZPRustRewriter'), false);
  assert.equal(runtimePrelude.includes('ZPHTTPRewriter'), false);
  assert.equal(runtimePrelude.includes('rewriteScriptSource'), false);
  assert.equal(runtimePrelude.includes('rewriteFunctionBody'), false);
});

test('active target script path executes source through QuickJS resource loader', () => {
  const loader = fs.readFileSync(path.join(repoRoot, 'web/runtime/resources/loader.mjs'), 'utf8');
  assert.ok(loader.includes("this.realm.evalClassic(String(record.source || '')"));
  assert.ok(loader.includes('this.realm.evalModule(response.text, response.finalUrl)'));
  assert.equal(loader.includes('/zp/api/'), false);
});

test('legacy native document transform fails closed without JS rewriter bridge', () => {
  const kernel = fs.readFileSync(path.join(repoRoot, 'cmd/wasm-kernel/main.go'), 'utf8');
  assert.ok(kernel.includes('legacyDocumentTransformBlocked'));
  assert.ok(kernel.includes('HTML_DOCUMENT_TRANSFORM_UNAVAILABLE'));
  assert.equal(kernel.includes('ZPRewriter'), false);
  assert.equal(kernel.includes('rewriteHTMLDocumentFromJS'), false);
});
