import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] || 'all';
if (!['all', 'js', 'e2e', 'e2e-ci', 'wasm-ci'].includes(mode) || process.argv.length > 3) {
  throw new Error('Usage: node scripts/test.mjs [all|js|e2e|e2e-ci|wasm-ci]');
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('npm_')));
const dist = path.resolve(repoRoot, env.ZP_E2E_DIST || 'dist');
const artifacts = path.resolve(repoRoot, env.ZP_E2E_ARTIFACTS || 'artifacts/e2e');
const jsTests = readdirSync(path.join(repoRoot, 'test/js'))
  .filter(name => name.endsWith('.test.js') && name !== 'rewriter.test.js')
  .sort().map(name => `test/js/${name}`);

function run(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env: { ...env, ...extraEnv },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`node ${args.join(' ')} failed (${result.signal || result.status})`);
  }
}

function runWasm() {
  run(['--experimental-vm-modules', '--test', '--test-concurrency=1', 'test/js/rewriter.test.js'], { ZP_E2E_DIST: dist });
}

function runE2E() {
  run(['--test', '--test-concurrency=1', 'test/e2e/proxy.test.js'], {
    ZP_E2E_PREBUILT: '1', ZP_E2E_DIST: dist, ZP_E2E_ARTIFACTS: artifacts,
  });
}

if (mode === 'js' || mode === 'all') {
  run(['--test', '--test-concurrency=1', ...jsTests]);
}
if (mode === 'all' || mode === 'e2e') {
  // The explicit local full/E2E modes build once, then share those artifacts.
  run(['scripts/build.mjs', '--out', dist]);
  if (mode === 'all') runWasm();
  runE2E();
} else if (mode === 'wasm-ci') {
  runWasm();
} else if (mode === 'e2e-ci') {
  runE2E();
}
