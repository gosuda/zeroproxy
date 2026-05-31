// Shared helpers for the Puppeteer e2e suites (proxy.test.js,
// turnstile-compat.test.js). Extracted verbatim from byte-identical copies that
// previously lived in both files; behavior must stay identical to those originals.
const childProcess = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

function run(cmd, args, options = {}) {
  const result = childProcess.spawnSync(cmd, args, {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

function isBenignSocketError(err) {
  return (
    err &&
    (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ERR_STREAM_PREMATURE_CLOSE')
  );
}

function ignoreBenignSocketErrors(stream) {
  stream.on('error', (err) => {
    if (!isBenignSocketError(err)) throw err;
  });
}

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    server.close(done);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    setTimeout(done, 1000);
  });
}

async function waitForHTTP(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
          res.resume();
          res.on('end', resolve);
        });
        req.setTimeout(1000, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
      });
      return;
    } catch (err) {
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw last || new Error(`timed out waiting for ${url}`);
}

async function waitForPage(page, predicate, args = [], timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(predicate, ...args)) return;
    } catch (err) {
      last = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw last || new Error('timed out waiting for page condition');
}

module.exports = {
  run,
  isBenignSocketError,
  ignoreBenignSocketErrors,
  listen,
  closeServer,
  waitForHTTP,
  waitForPage,
};
