import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const esmDir = path.dirname(fileURLToPath(import.meta.url));
export const distDir = path.resolve(esmDir, '..');
export const webDistDir = path.join(distDir, 'web');
export const wasmDistDir = path.join(esmDir, 'wasm');
export const wasmManifestPath = path.join(distDir, 'wasm-manifest.json');

export const ASSET_CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
});

export async function readWebAsset(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new TypeError('readWebAsset requires a non-empty relative path');
  }
  const normalized = relativePath.replace(/^\/+/, '');
  const resolved = path.resolve(webDistDir, normalized);
  const rel = path.relative(webDistDir, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new RangeError(`Web asset path escapes webDistDir: ${relativePath}`);
  }
  const buf = await readFile(resolved);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const ext = path.extname(resolved).toLowerCase();
  const contentType = ASSET_CONTENT_TYPES[ext] || 'application/octet-stream';
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, contentType, sha256 };
}

export async function readWasmManifest() {
  const raw = await readFile(wasmManifestPath, 'utf8');
  return JSON.parse(raw);
}
