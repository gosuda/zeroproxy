#!/usr/bin/env node
// Run test/e2e/real-site-regression.test.js with ZP_TARGETS=matrix by default
// to avoid shell-specific environment variable syntax in npm scripts.
//
// Usage:
//   node scripts/dogfood-matrix.mjs
//   ZP_TARGETS=wikipedia,example node scripts/dogfood-matrix.mjs

import { spawn } from 'node:child_process';
import process from 'node:process';

const env = { ...process.env };
if (!env.ZP_TARGETS) env.ZP_TARGETS = 'matrix';

const child = spawn(process.execPath, ['--test', 'test/e2e/real-site-regression.test.js'], {
  stdio: 'inherit',
  env,
});
child.on('exit', code => process.exit(code ?? 1));
