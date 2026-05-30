import { spawnSync } from 'node:child_process';

const mode = process.argv[2] || 'all';
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('npm_')),
);

function run(cmd, allowRetry = false) {
  const first = runOnce(cmd);
  if (first.status === 0) return;
  if (allowRetry && /\bECONNRESET\b/.test(resultText(first))) {
    process.stderr.write(
      '\nRetrying after transient ECONNRESET from browser/relay test transport...\n',
    );
    const second = runOnce(cmd);
    if (second.status === 0) return;
    throw commandError(cmd, second);
  }
  throw commandError(cmd, first);
}

function runOnce(cmd) {
  const result = spawnSync(cmd, {
    cwd: process.cwd(),
    env,
    shell: '/bin/bash',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  return result;
}

function resultText(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function commandError(cmd, result) {
  const err = new Error(`Command failed: ${cmd}`);
  err.status = result.status;
  err.signal = result.signal;
  err.output = [null, result.stdout, result.stderr];
  err.stdout = result.stdout;
  err.stderr = result.stderr;
  return err;
}

if (mode === 'js') {
  run('node --test test/js/*.test.js');
} else if (mode === 'e2e') {
  run('node --test test/e2e/*.test.js', true);
} else {
  run('node --test test/js/*.test.js');
  run('node --test test/e2e/*.test.js', true);
}
