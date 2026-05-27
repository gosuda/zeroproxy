import { execSync } from 'node:child_process';

const mode = process.argv[2] || 'all';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('npm_')));

function run(cmd, allowRetry = false) {
  try {
    execSync(cmd, {
      cwd: process.cwd(),
      stdio: 'inherit',
      env,
      shell: '/bin/bash',
    });
  } catch (err) {
    const msg = String(err && err.message || err || '');
    if (allowRetry && /ECONNRESET/.test(msg)) {
      execSync(cmd, {
        cwd: process.cwd(),
        stdio: 'inherit',
        env,
        shell: '/bin/bash',
      });
      return;
    }
    throw err;
  }
}

if (mode === 'js') {
  run('node --test test/js/*.test.js');
} else if (mode === 'e2e') {
  run('node --test test/e2e/proxy.test.js', true);
} else {
  run('node --test test/js/*.test.js');
  run('node --test test/e2e/proxy.test.js', true);
}
