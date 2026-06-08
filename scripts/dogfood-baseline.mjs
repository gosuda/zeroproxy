#!/usr/bin/env node
//
// Day 0 dogfood baseline capture (E4 Stage 1 helper).
//
// Drives the taskweaver `zp` instance through the launcher → opens
// gosuda.org as the canonical SPA baseline target, captures a screenshot,
// dumps console errors, and writes everything under
//   `.ai/dogfood/<YYYY-MM-DD>/`
// so the operator has a reproducible reference for the rest of the
// 5-7 day Stage 1 journal.
//
// Usage:
//   node scripts/dogfood-baseline.mjs                 # default: gosuda.org
//   node scripts/dogfood-baseline.mjs https://...     # custom target
//   node scripts/dogfood-baseline.mjs --label nact    # extra label in dir name
//
// Assumes: zeroproxy-server.exe listening on 127.0.0.1:18080 (per CLAUDE.md
// canonical command) and `taskweaver` on PATH. Re-uses the shared `zp`
// instance per the project's taskweaver policy.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
let target = 'https://gosuda.org';
let label = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--label') label = args[++i] || '';
  else if (args[i] === '--target') target = args[++i] || target;
  else if (!args[i].startsWith('--')) target = args[i];
}

const PROXY = 'http://proxy.localhost:18080/zp/';
const today = new Date().toISOString().slice(0, 10);
const stem = label ? `${today}-${label}` : today;
const outDir = path.resolve('.ai', 'dogfood', stem);
mkdirSync(outDir, { recursive: true });

function tw(...argv) {
  const result = spawnSync('taskweaver', argv, { encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.stderr) process.stderr.write(result.stderr);
  return { status: result.status, stdout: result.stdout || '' };
}

function ensureZpInstance() {
  const listed = tw('list');
  if (listed.status === 0 && listed.stdout.includes('"id": "zp"')) return true;
  process.stdout.write('zp instance missing; starting…\n');
  const started = tw('start', '--id', 'zp', '--width', '1200', '--height', '800');
  return started.status === 0;
}

function navigate(url) {
  return tw('navigate', '-i', 'zp', '--url', url);
}

function openTarget(targetUrl) {
  // Submit through the launcher form (input field + Open button).
  tw('fill-form', '-i', 'zp', '--selector', 'input', '--value', targetUrl);
  tw('click', '-i', 'zp', '--text', 'Open');
}

function probeUrl() {
  const { stdout } = tw('get-url', '-i', 'zp');
  try { return JSON.parse(stdout).url || ''; } catch { return stdout.trim(); }
}

function probeTitle() {
  const { stdout } = tw('get-url', '-i', 'zp');
  try { return JSON.parse(stdout).title || ''; } catch { return ''; }
}

function consoleErrors() {
  const { stdout } = tw('console-logs', '-i', 'zp', '--level', 'error', '--max', '100');
  try { return JSON.parse(stdout); } catch { return { raw: stdout }; }
}

function screenshot(filePath) {
  return tw('screenshot', '-i', 'zp', '--output', filePath);
}

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  if (!ensureZpInstance()) {
    process.stderr.write('failed to ensure taskweaver `zp` instance\n');
    process.exit(2);
  }

  process.stdout.write(`baseline target: ${target}\n`);
  process.stdout.write(`output dir:      ${outDir}\n`);

  navigate(PROXY);
  await wait(1500);

  openTarget(target);
  // Give the SW + first transportFetch + page bundle time to settle. The
  // first cold visit also pulls the lazy kernel wasm (split-bundle c.3).
  await wait(8000);

  const finalUrl = probeUrl();
  const title = probeTitle();
  process.stdout.write(`final url:       ${finalUrl}\n`);
  process.stdout.write(`final title:     ${title}\n`);

  const shotPath = path.join(outDir, 'baseline.png');
  const shotResult = screenshot(shotPath);
  process.stdout.write(`screenshot:      ${shotResult.status === 0 ? shotPath : 'FAILED'}\n`);

  const errs = consoleErrors();
  const errsPath = path.join(outDir, 'console-errors.json');
  writeFileSync(errsPath, JSON.stringify(errs, null, 2));
  const count = Array.isArray(errs.logs) ? errs.logs.length : 0;
  process.stdout.write(`console errors:  ${count} (see ${errsPath})\n`);

  const summary = [
    `# Dogfood baseline ${stem}`,
    '',
    `- target: ${target}`,
    `- proxy:  ${PROXY}`,
    `- final url: ${finalUrl}`,
    `- final title: ${title || '(empty)'}`,
    `- screenshot: \`${path.relative(process.cwd(), shotPath)}\``,
    `- console errors: ${count}`,
    '',
    '## Console error sample',
    '',
    '```json',
    JSON.stringify(errs, null, 2).slice(0, 2048),
    '```',
    '',
    '## Acceptance check (manual)',
    '',
    '- [ ] page renders without `MALFORMED_HTML` / `REWRITE_FAILED` / `SW_NOT_READY`',
    '- [ ] `/zp/p/` path preserved in final URL',
    '- [ ] only known-deferred console errors present',
    '',
  ].join('\n');
  const summaryPath = path.join(outDir, 'summary.md');
  writeFileSync(summaryPath, summary);
  process.stdout.write(`summary:         ${summaryPath}\n`);
})();
