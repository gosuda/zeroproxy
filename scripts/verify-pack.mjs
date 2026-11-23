#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(repoRoot, 'dist');
const PAGE_BUNDLE_BUDGET_BYTES = 540 * 1024;

const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));

if (!pkg.repository || pkg.repository.url !== 'git+https://github.com/gosuda/zeroproxy.git') {
  throw new Error('package.json repository.url must equal git+https://github.com/gosuda/zeroproxy.git for npm OIDC provenance');
}

const exportTargets = new Set();
for (const [subpath, target] of Object.entries(pkg.exports || {})) {
  if (subpath.includes('*')) continue;
  if (typeof target === 'string') {
    exportTargets.add(target);
  } else if (target && typeof target === 'object') {
    for (const val of Object.values(target)) {
      if (typeof val === 'string') exportTargets.add(val);
    }
  }
}

for (const rel of exportTargets) {
  const full = path.resolve(repoRoot, rel);
  await assertExists(full, `Missing package export target ${rel}; run "npm run build:pkg" before packing`);
}

const requiredWebFiles = [
  'dist/web/index.html',
  'dist/web/sw.js',
  'dist/web/zp-core.js',
  'dist/web/runtime-prelude.js',
  'dist/web/worker-prelude.js',
  'dist/web/zp-page-bundle.js',
  'dist/web/Asset/zp-bundle.wasm',
  'dist/web/Asset/zp-kernel.wasm',
  'dist/web/Asset/zp-page-bundle-wbg.wasm',
  'dist/web/Asset/zp-rt.wasm',
];
for (const rel of requiredWebFiles) {
  await assertExists(path.join(repoRoot, rel), `Missing web runtime file ${rel}; run "npm run build:pkg" before packing`);
}

const manifestPath = path.join(distDir, 'wasm-manifest.json');
await assertExists(manifestPath, 'Missing dist/wasm-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length < 8) {
  throw new Error(`Expected 8 WASM artifacts (4 ESM + 4 web) in wasm-manifest.json, got ${manifest.artifacts?.length}`);
}

for (const entry of manifest.artifacts) {
  const wasmPath = path.join(distDir, entry.path);
  await assertExists(wasmPath, `Missing WASM artifact ${entry.path}`);
  const buf = await readFile(wasmPath);
  const actualSha = createHash('sha256').update(buf).digest('hex');
  if (buf.byteLength !== entry.bytes) {
    throw new Error(`Size mismatch for ${entry.path}: manifest=${entry.bytes}, actual=${buf.byteLength}`);
  }
  if (actualSha !== entry.sha256) {
    throw new Error(`SHA-256 mismatch for ${entry.path}: manifest=${entry.sha256}, actual=${actualSha}`);
  }
  if (entry.path.includes('zp-page-bundle') && entry.bytes > PAGE_BUNDLE_BUDGET_BYTES) {
    throw new Error(`${entry.path} (${entry.bytes} bytes) exceeds 540 KiB navigation budget`);
  }
}

const pkgFiles = new Set(pkg.files || []);
if (pkgFiles.has('dist') || pkgFiles.has('dist/zeroproxy-server') || pkgFiles.has('dist/zeroproxy-server.exe')) {
  throw new Error('package.json "files" must list dist/esm and dist/web explicitly so OS-specific Go binaries are excluded');
}

process.stderr.write(`Verified ${exportTargets.size} export targets and ${manifest.artifacts.length} WASM digests for ${pkg.name}@${pkg.version}\n`);

async function assertExists(filePath, message) {
  try {
    await access(filePath);
    const st = await stat(filePath);
    if (!st.isFile() || st.size === 0) {
      throw new Error(`${message} (empty or non-regular file)`);
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new Error(message);
    throw err;
  }
}
