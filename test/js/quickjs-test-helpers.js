const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let runtimePromise = null;

async function loadRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-quickjs-unit-'));
      const result = childProcess.spawnSync(
        'node',
        ['scripts/build.mjs', '--web-only', '--out', outDir],
        { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' },
      );
      if (result.status !== 0) {
        throw new Error(
          `node scripts/build.mjs --web-only --out ${outDir} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }
      const engine = await import(pathToFileURL(path.resolve('web/runtime/quickjs/engine.mjs')));
      const factory = (await import(pathToFileURL(path.join(outDir, 'web', 'quickjs-runtime.mjs'))))
        .default;
      assert.equal(fs.existsSync(path.join(outDir, 'web', 'quickjs-runtime.wasm')), true);
      return engine.createQuickJSRuntime({
        moduleFactory: factory,
        wasmURL: path.join(outDir, 'web', 'quickjs-runtime.wasm'),
      });
    })();
  }
  return runtimePromise;
}

module.exports = { loadRuntime };
