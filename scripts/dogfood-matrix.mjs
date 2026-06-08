#!/usr/bin/env node
//
// E4 dogfood matrix runner — drives the puppeteer real-site harness
// (`test/e2e/real-site-regression.test.js`) across the full no-CF
// target list (wikipedia + example + mdn + hackernews) in one pass.
//
// Why a wrapper instead of inlining `ZP_TARGETS=matrix` in the npm
// script: cross-platform env-var syntax is annoying (sh `VAR=x cmd`
// vs cmd.exe `set VAR=x && cmd`) and `cross-env` would add an npm
// dependency for one line. Pure Node spawn keeps the dep surface
// at zero and reuses the existing harness as-is.
//
// Usage:
//   node scripts/dogfood-matrix.mjs              # full matrix
//   ZP_TARGETS=wikipedia,example node scripts/dogfood-matrix.mjs
//                                                # caller can override

import { spawn } from 'node:child_process';
import process from 'node:process';

const env = { ...process.env };
if (!env.ZP_TARGETS) env.ZP_TARGETS = 'matrix';

const child = spawn(process.execPath, ['--test', 'test/e2e/real-site-regression.test.js'], {
  stdio: 'inherit',
  env,
});
child.on('exit', code => process.exit(code ?? 1));
