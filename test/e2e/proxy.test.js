const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const TARGET_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

function run(cmd, args, options = {}) {
  const result = childProcess.spawnSync(cmd, args, {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
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
  return new Promise(resolve => server.close(() => resolve()));
}

async function waitForHTTP(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, res => {
          res.resume();
          res.on('end', resolve);
        });
        req.setTimeout(1000, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
      });
      return;
    } catch (err) {
      last = err;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw last || new Error(`timed out waiting for ${url}`);
}

class SocketReader {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    socket.on('data', chunk => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.flush();
    });
    socket.on('error', err => this.fail(err));
    socket.on('close', () => this.fail(new Error('socket closed')));
  }
  read(n) {
    if (this.buf.length >= n) return Promise.resolve(this.take(n));
    return new Promise((resolve, reject) => {
      this.waiters.push({ n, resolve, reject });
      this.flush();
    });
  }
  take(n) {
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  flush() {
    while (this.waiters.length && this.buf.length >= this.waiters[0].n) {
      const waiter = this.waiters.shift();
      waiter.resolve(this.take(waiter.n));
    }
  }
  fail(err) {
    while (this.waiters.length) this.waiters.shift().reject(err);
  }
}

function createTargetServer(requests) {
  return http.createServer((req, res) => {
    requests.push({ url: req.url, userAgent: req.headers['user-agent'] || '' });
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>E2E Home</title></head><body>
        <main><h1>E2E Home</h1><a id="next" href="/next">Next page</a></main>
        <script>window.__ua = navigator.userAgent; window.__platform = navigator.platform;</script>
      </body></html>`);
      return;
    }
    if (req.url === '/next') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>E2E Next</title></head><body>
        <main><h1>E2E Next</h1><p id="ua"></p></main>
        <script>document.getElementById('ua').textContent = navigator.userAgent;</script>
      </body></html>`);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
}

function createSocks5Server(resolveHost) {
  return net.createServer(socket => {
    handleSocks(socket, resolveHost).catch(() => socket.destroy());
  });
}

async function handleSocks(socket, resolveHost) {
  const reader = new SocketReader(socket);
  const greeting = await reader.read(2);
  assert.equal(greeting[0], 0x05);
  const methods = await reader.read(greeting[1]);
  const method = methods.includes(0x02) ? 0x02 : 0x00;
  socket.write(Buffer.from([0x05, method]));
  if (method === 0x02) {
    const authHead = await reader.read(2);
    assert.equal(authHead[0], 0x01);
    await reader.read(authHead[1]);
    const passLen = await reader.read(1);
    await reader.read(passLen[0]);
    socket.write(Buffer.from([0x01, 0x00]));
  }
  const reqHead = await reader.read(4);
  assert.equal(reqHead[0], 0x05);
  assert.equal(reqHead[1], 0x01);
  let host;
  if (reqHead[3] === 0x03) {
    const len = await reader.read(1);
    host = (await reader.read(len[0])).toString('utf8');
  } else {
    throw new Error(`unsupported SOCKS address type ${reqHead[3]}`);
  }
  const portBuf = await reader.read(2);
  const port = portBuf.readUInt16BE(0);
  const upstream = net.connect(resolveHost(host, port));
  await new Promise((resolve, reject) => {
    upstream.once('connect', resolve);
    upstream.once('error', reject);
  });
  socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
  if (reader.buf.length) upstream.write(reader.buf);
  socket.pipe(upstream);
  upstream.pipe(socket);
}

test('browser traffic uses test SOCKS5, proxied /p navigation, and Chrome UA', { timeout: 120000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroproxy-e2e-'));
  const kernelPath = path.join(temp, 'kernel.wasm');
  const serverPath = path.join(temp, process.platform === 'win32' ? 'zeroproxy-server.exe' : 'zeroproxy-server');
  run('go', ['build', '-o', kernelPath, './cmd/wasm-kernel'], { env: { GOOS: 'js', GOARCH: 'wasm' } });
  run('go', ['build', '-o', serverPath, './cmd/zeroproxy-server']);

  const requests = [];
  const target = createTargetServer(requests);
  const targetPort = await listen(target);
  t.after(() => closeServer(target));

  const socks = createSocks5Server((host, port) => {
    assert.equal(host, 'e2e.test');
    assert.equal(port, targetPort);
    return { host: '127.0.0.1', port: targetPort };
  });
  const socksPort = await listen(socks);
  t.after(() => closeServer(socks));

  const proxyPort = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.once('error', reject);
  });
  const proxy = childProcess.spawn(serverPath, ['-addr', `127.0.0.1:${proxyPort}`, '-web', 'web', '-kernel', kernelPath, '-socks', `127.0.0.1:${socksPort}`], {
    cwd: path.resolve(__dirname, '../..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => proxy.kill('SIGTERM'));
  let proxyLog = '';
  proxy.stdout.on('data', chunk => { proxyLog += chunk; });
  proxy.stderr.on('data', chunk => { proxyLog += chunk; });
  await waitForHTTP(`http://127.0.0.1:${proxyPort}/`).catch(err => {
    throw new Error(`${err.message}\nproxy output:\n${proxyLog}`);
  });

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--host-resolver-rules=MAP proxy.localhost 127.0.0.1'],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://proxy.localhost:${proxyPort}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller && document.querySelector('#status')?.textContent === 'Ready.', { timeout: 30000 });
  await page.type('#url', `http://e2e.test:${targetPort}/`);
  await page.click('button');
  await page.waitForFunction(() => document.title === 'E2E Home', { timeout: 30000 });

  const home = await page.evaluate(() => ({
    href: location.href,
    hash: location.hash,
    title: document.title,
    shellVisible: Boolean(document.querySelector('#open')),
    userAgent: navigator.userAgent,
    appVersion: navigator.appVersion,
    platform: navigator.platform,
  }));
  assert.equal(home.title, 'E2E Home');
  assert.equal(home.hash, '');
  assert.equal(home.shellVisible, false);
  assert.equal(home.userAgent, TARGET_UA);
  assert.equal(home.appVersion, TARGET_UA.replace(/^Mozilla\//, ''));
  assert.equal(home.platform, 'Win32');
  assert.match(home.href, new RegExp(`^http://proxy\\.localhost:${proxyPort}/p/`));
  assert.ok(requests.some(r => r.url === '/' && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);

  await page.click('#next');
  await page.waitForFunction(() => document.title === 'E2E Next', { timeout: 30000 });
  const next = await page.evaluate(() => ({
    href: location.href,
    hash: location.hash,
    title: document.title,
    shellVisible: Boolean(document.querySelector('#open')),
    userAgent: navigator.userAgent,
  }));
  assert.equal(next.title, 'E2E Next');
  assert.equal(next.hash, '');
  assert.equal(next.shellVisible, false);
  assert.equal(next.userAgent, TARGET_UA);
  assert.match(next.href, new RegExp(`^http://proxy\\.localhost:${proxyPort}/p/`));
  assert.ok(requests.some(r => r.url === '/next' && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
});
