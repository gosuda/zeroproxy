import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const biomeBin = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'biome.cmd' : 'biome',
);

export function formatJSONForFile(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (!fs.existsSync(biomeBin)) return text;
  const result = spawnSync(biomeBin, ['format', '--stdin-file-path', filePath], {
    cwd: repoRoot,
    input: text,
    encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout) return text;
  return result.stdout;
}

export function writeJSONFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, formatJSONForFile(filePath, value));
}
