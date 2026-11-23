#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPO = 'gosuda/zeroproxy';
const SIGNER_WORKFLOW = `${DEFAULT_REPO}/.github/workflows/slsa-wasm-builder.yml`;

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  process.stdout.write(
    `Usage: node scripts/fetch-prebuilt-wasm.mjs [--tag vX.Y.Z] [--out dist] [--repo owner/name]\n\nDownloads SLSA Build Level 3 attested WebAssembly and web bundles from GitHub Releases,\nverifies provenance with "gh attestation verify", checks SHA-256 digests, and populates dist/.\n`,
  );
  process.exit(0);
}

const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
const tag = opts.tag || `v${pkg.version}`;
const version = tag.startsWith('v') ? tag.slice(1) : tag;
const repo = opts.repo || DEFAULT_REPO;
const signerWorkflow = opts.signerWorkflow || `${repo}/.github/workflows/slsa-wasm-builder.yml`;
const outDir = path.resolve(repoRoot, opts.out || 'dist');

const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'zp-wasm-pull-'));
try {
  const wasmArchive = `zeroproxy-wasm-${version}.tar.gz`;
  const webArchive = `zeroproxy-web-${version}.tar.gz`;
  run('gh', [
    'release', 'download', tag,
    '--repo', repo,
    '--dir', tmpDir,
    '--pattern', wasmArchive,
    '--pattern', webArchive,
    '--pattern', 'SHA256SUMS.txt',
  ]);

  for (const name of [wasmArchive, webArchive]) {
    const archivePath = path.join(tmpDir, name);
    run('gh', [
      'attestation', 'verify', archivePath,
      '--repo', repo,
      '--signer-workflow', signerWorkflow,
    ]);
  }

  await verifyChecksums(tmpDir, [wasmArchive, webArchive]);
  await mkdir(outDir, { recursive: true });
  run('tar', ['-xzf', path.join(tmpDir, wasmArchive), '-C', outDir]);
  run('tar', ['-xzf', path.join(tmpDir, webArchive), '-C', outDir]);
  await verifyExtractedManifest(outDir);

  process.stdout.write(`Verified SLSA Build Level 3 provenance and unpacked prebuilt WASM (${tag}) into ${path.relative(repoRoot, outDir) || '.'}\n`);
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--tag':
        parsed.tag = argv[++i];
        break;
      case '--out':
        parsed.out = argv[++i];
        break;
      case '--repo':
        parsed.repo = argv[++i];
        break;
      case '--signer-workflow':
        parsed.signerWorkflow = argv[++i];
        break;
      case '--help':
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function verifyChecksums(dir, expectedFiles) {
  const sumsText = await readFile(path.join(dir, 'SHA256SUMS.txt'), 'utf8');
  const table = new Map();
  for (const line of sumsText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(trimmed);
    if (match) table.set(path.basename(match[2]), match[1].toLowerCase());
  }
  for (const name of expectedFiles) {
    const expected = table.get(name);
    if (!expected) throw new Error(`SHA256SUMS.txt missing entry for ${name}`);
    const actual = createHash('sha256').update(await readFile(path.join(dir, name))).digest('hex');
    if (actual !== expected) {
      throw new Error(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
    }
  }
}

async function verifyExtractedManifest(targetDist) {
  const manifest = JSON.parse(await readFile(path.join(targetDist, 'wasm-manifest.json'), 'utf8'));
  for (const entry of manifest.artifacts || []) {
    const buf = await readFile(path.join(targetDist, entry.path));
    const actual = createHash('sha256').update(buf).digest('hex');
    if (actual !== entry.sha256) {
      throw new Error(`Extracted WASM digest mismatch for ${entry.path}: expected ${entry.sha256}, got ${actual}`);
    }
  }
}

function run(cmd, argv) {
  process.stdout.write(`${cmd} ${argv.join(' ')}\n`);
  const res = spawnSync(cmd, argv, { cwd: repoRoot, stdio: 'inherit' });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${cmd} ${argv.join(' ')} exited with status ${res.status}`);
  }
}
