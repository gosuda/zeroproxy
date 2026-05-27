const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
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
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, host: req.headers.host || '', userAgent: req.headers['user-agent'] || '', cookie: req.headers.cookie || '' });
    const url = new URL(req.url, 'http://target.local');
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>E2E Home</title></head><body>
        <main><h1>E2E Home</h1><a id="next" href="/next">Next page</a></main>
        <script>window.__ua = navigator.userAgent; window.__platform = navigator.platform; window.__phase2Location = { href: location.href, windowHref: window.location.href }; try { Function('return location.href')(); window.__phase2FunctionBlocked = ''; } catch (err) { window.__phase2FunctionBlocked = err && err.message || String(err); }</script>
        <script src="/rewrite-fixture.js"></script>
      </body></html>`);
      return;
    }
    if (url.pathname === '/next') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>E2E Next</title></head><body>
        <main><h1>E2E Next</h1><p id="ua"></p></main>
        <script>document.getElementById('ua').textContent = navigator.userAgent;</script>
      </body></html>`);
      return;
    }
    if (url.pathname === '/rewrite-fixture.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`(() => {
        const NativeWebSocket = window.WebSocket;
        window.__rewriteAdvanced = { initialHref: window.location.href, constructorSource: NativeWebSocket.toString() };
        const ws = new NativeWebSocket('/ws', ['zp-rewrite']);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => ws.send('rewrite-script');
        ws.onmessage = ev => {
          window.__rewriteAdvanced.wsURL = ws.url;
          window.__rewriteAdvanced.wsProtocol = ws.protocol;
          window.__rewriteAdvanced.wsMessage = String(ev.data);
          ws.close(1000, 'done');
        };
        ws.onerror = () => { window.__rewriteAdvanced.wsError = true; };
        function JQueryLike() { return { length: 0 }; }
        JQueryLike.prototype = {
          constructor: JQueryLike,
          pushStack() { return this.constructor(); }
        };
        window.__rewriteAdvanced.jqueryConstructorLength = Object.create(JQueryLike.prototype).pushStack().length;
        try {
          ({}).constructor.constructor('return location.href')();
          window.__rewriteAdvanced.constructorEscapeBlocked = '';
        } catch (err) {
          window.__rewriteAdvanced.constructorEscapeBlocked = err && err.message || String(err);
        }
      })();`);
      return;
    }
    if (url.pathname === '/set-cookie') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': 'target_server=from-target; Path=/; SameSite=Lax',
      });
      res.end('set-cookie-ok');
      return;
    }
    if (url.pathname === '/cookie-echo') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.headers.cookie || '');
      return;
    }
    if (url.pathname === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.write('chunk-one\n');
      setTimeout(() => res.end('chunk-two\n'), 600);
      return;
    }
    if (url.pathname === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.end('data: sse-ok\n\n');
      return;
    }
    if (url.pathname === '/post-echo') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(Buffer.concat(chunks).toString('utf8'));
      });
      return;
    }
    if (url.pathname === '/redirect307') {
      res.writeHead(307, { 'Location': '/post-echo', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  server.on('upgrade', (req, socket) => handleWebSocketUpgrade(req, socket, requests));
  return server;
}

function handleWebSocketUpgrade(req, socket, requests) {
  requests.push({ url: req.url, method: req.method, host: req.headers.host || '', userAgent: req.headers['user-agent'] || '', cookie: req.headers.cookie || '', protocol: req.headers['sec-websocket-protocol'] || '', upgrade: true });
  if (new URL(req.url, 'http://target.local').pathname !== '/ws') {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const requestedProtocol = String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim()).filter(Boolean)[0] || '';
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + (requestedProtocol ? '\r\nSec-WebSocket-Protocol: ' + requestedProtocol : '') + '\r\n\r\n');
  let buffered = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 2) {
      const frame = readWebSocketFrame(buffered);
      if (!frame) break;
      buffered = buffered.subarray(frame.consumed);
      if (frame.opcode === 0x8) {
        writeWebSocketFrame(socket, 0x8);
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        writeWebSocketFrame(socket, 0xA, frame.payload);
        continue;
      }
      if (frame.opcode === 0x1) writeWebSocketFrame(socket, 0x1, Buffer.from('echo:' + frame.payload.toString('utf8')));
      if (frame.opcode === 0x2) writeWebSocketFrame(socket, 0x2, frame.payload);
    }
  });
}

function readWebSocketFrame(buffer) {
  const b0 = buffer[0];
  const b1 = buffer[1];
  const masked = (b1 & 0x80) !== 0;
  let length = b1 & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { opcode: b0 & 0x0f, payload, consumed: offset + length };
}

function writeWebSocketFrame(socket, opcode, data = Buffer.alloc(0)) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
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

test('browser traffic uses test SOCKS5 and covers proxied runtime integrations', { timeout: 120000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zeroproxy-e2e-'));
  const buildOut = path.join(temp, 'dist');
  run('node', ['scripts/build.mjs', '--out', buildOut]);
  const kernelPath = path.join(buildOut, 'kernel.wasm');
  const serverPath = path.join(buildOut, process.platform === 'win32' ? 'zeroproxy-server.exe' : 'zeroproxy-server');
  const webPath = path.join(buildOut, 'web');

  const requests = [];
  const target = createTargetServer(requests);
  const targetPort = await listen(target);
  t.after(() => closeServer(target));

  const socksHosts = [];
  const socks = createSocks5Server((host, port) => {
    socksHosts.push(host);
    assert.ok(host === 'e2e.test' || host === 'direct-egress.test', `unexpected SOCKS host ${host}`);
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
  const proxy = childProcess.spawn(serverPath, ['-addr', `127.0.0.1:${proxyPort}`, '-web', webPath, '-kernel', kernelPath, '-socks', `127.0.0.1:${socksPort}`], {
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
    phase2Location: window.__phase2Location,
    phase2FunctionBlocked: window.__phase2FunctionBlocked,
  }));
  assert.equal(home.title, 'E2E Home');
  assert.equal(home.hash, '');
  assert.equal(home.shellVisible, false);
  assert.equal(home.userAgent, TARGET_UA);
  assert.equal(home.appVersion, TARGET_UA.replace(/^Mozilla\//, ''));
  assert.equal(home.platform, 'Win32');
  assert.match(home.href, new RegExp(`^http://proxy\\.localhost:${proxyPort}/p/`));
  assert.deepEqual(home.phase2Location, { href: `http://e2e.test:${targetPort}/`, windowHref: `http://e2e.test:${targetPort}/` });
  assert.equal(home.phase2FunctionBlocked, 'Blocked by ZeroProxy policy');
  assert.ok(requests.some(r => r.url === '/' && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  await page.waitForFunction(() => window.__rewriteAdvanced && window.__rewriteAdvanced.wsMessage === 'echo:rewrite-script', { timeout: 30000 });
  const rewriteAdvanced = await page.evaluate(() => window.__rewriteAdvanced);
  assert.equal(rewriteAdvanced.initialHref, `http://e2e.test:${targetPort}/`);
  assert.equal(rewriteAdvanced.wsURL, `ws://e2e.test:${targetPort}/ws`);
  assert.equal(rewriteAdvanced.wsProtocol, 'zp-rewrite');
  assert.equal(rewriteAdvanced.wsMessage, 'echo:rewrite-script');
  assert.equal(rewriteAdvanced.wsError, undefined);
  assert.equal(rewriteAdvanced.jqueryConstructorLength, 0);
  assert.equal(rewriteAdvanced.constructorEscapeBlocked, 'Blocked by ZeroProxy policy');
  assert.ok(requests.some(r => r.upgrade && r.url === '/ws' && r.protocol === 'zp-rewrite' && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);

  const iframeIsolation = await page.evaluate(async target => {
    const blockedByPolicy = fn => {
      try { fn(); return ''; }
      catch (err) { return err && err.message || String(err); }
    };

    const sync = document.createElement('iframe');
    document.body.appendChild(sync);
    const syncRTC = blockedByPolicy(() => new sync.contentWindow.RTCPeerConnection());
    const docRTC = blockedByPolicy(() => new sync.contentDocument.defaultView.RTCPeerConnection());

    const modern = document.createElement('iframe');
    document.body.append(modern);
    const modernRTC = blockedByPolicy(() => new modern.contentWindow.RTCPeerConnection());
    const websocketShared = modern.contentWindow.WebSocket === window.WebSocket;
    const ws = new modern.contentWindow.WebSocket('ws://evil.example/socket');
    const websocketURL = ws.url;
    const childCanvasMask = modern.contentWindow.HTMLCanvasElement.prototype.toDataURL.toString();
    try { ws.close(); } catch {}

    const observed = document.createElement('iframe');
    document.body.appendChild(observed);
    const attr = document.createAttribute('src');
    attr.value = target;
    observed.attributes.setNamedItem(attr);
    const rewrittenSrc = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      (function poll() {
        const current = observed.attributes.getNamedItem('src')?.value || '';
        if (current.startsWith(location.origin + '/p/')) { resolve(current); return; }
        if (Date.now() > deadline) { reject(new Error(`src not rewritten: ${current}`)); return; }
        setTimeout(poll, 25);
      })();
    });

    sync.remove();
    modern.remove();
    observed.remove();
    return { syncRTC, docRTC, modernRTC, websocketShared, websocketURL, childCanvasMask, rewrittenSrc };
  }, `http://e2e.test:${targetPort}/next`);
  assert.equal(iframeIsolation.syncRTC, 'Blocked by ZeroProxy policy');
  assert.equal(iframeIsolation.docRTC, 'Blocked by ZeroProxy policy');
  assert.equal(iframeIsolation.modernRTC, 'Blocked by ZeroProxy policy');
  assert.equal(iframeIsolation.websocketShared, true);
  assert.equal(iframeIsolation.websocketURL, 'ws://evil.example/socket');
  assert.match(iframeIsolation.rewrittenSrc, new RegExp(`^http://proxy\\.localhost:${proxyPort}/p/`));
  assert.equal(iframeIsolation.childCanvasMask, 'function toDataURL() { [native code] }');

  const fingerprintMasking = await page.evaluate(() => {
    const canvasMask = HTMLCanvasElement.prototype.toDataURL.toString();
    const voicesMask = speechSynthesis.getVoices.toString();

    const canvasA = document.createElement('canvas');
    canvasA.width = 16;
    canvasA.height = 16;
    const ctxA = canvasA.getContext('2d');
    ctxA.fillStyle = '#123456';
    ctxA.fillRect(0, 0, 16, 16);
    const urlA = canvasA.toDataURL();

    const canvasB = document.createElement('canvas');
    canvasB.width = 16;
    canvasB.height = 16;
    const ctxB = canvasB.getContext('2d');
    ctxB.fillStyle = '#123456';
    ctxB.fillRect(0, 0, 16, 16);
    const urlB = canvasB.toDataURL();

    const pixelCanvas = document.createElement('canvas');
    pixelCanvas.width = 1;
    pixelCanvas.height = 1;
    const pixelCtx = pixelCanvas.getContext('2d');
    pixelCtx.fillStyle = 'rgba(0,0,0,1)';
    pixelCtx.fillRect(0, 0, 1, 1);
    const pixel = Array.from(pixelCtx.getImageData(0, 0, 1, 1).data);

    let audioDelta = null;
    if (window.AudioBuffer) {
      const buffer = new AudioBuffer({ length: 128, numberOfChannels: 1, sampleRate: 44100 });
      const channel = buffer.getChannelData(0);
      channel[0] = 0.01;
      for (let i = 0; i < 5; i++) buffer.getChannelData(0);
      audioDelta = buffer.getChannelData(0)[0] - 0.01;
    }

    const voices = speechSynthesis.getVoices();
    return {
      canvasMask,
      voicesMask,
      canvasVaries: urlA !== urlB,
      pixel,
      audioDelta,
      voiceCount: voices.length,
      voiceNames: voices.map(v => v.name),
    };
  });
  assert.equal(fingerprintMasking.canvasMask, 'function toDataURL() { [native code] }');
  assert.equal(fingerprintMasking.voicesMask, 'function getVoices() { [native code] }');
  assert.equal(fingerprintMasking.canvasVaries, true);
  assert.deepEqual(fingerprintMasking.pixel.slice(0, 4), [1, 0, 1, 255]);
  assert.ok(fingerprintMasking.audioDelta === null || Math.abs(fingerprintMasking.audioDelta) > 0);
  assert.equal(fingerprintMasking.voiceCount, 2);
  assert.deepEqual(fingerprintMasking.voiceNames, ['Google US English', 'Microsoft David - English (United States)']);

  const runtimeIntegration = await page.evaluate(async targetPort => {
    async function readText(path) {
      const resp = await fetch(path, { cache: 'no-store' });
      return resp.text();
    }
    async function waitForCookieHeader(needle) {
      let last = '';
      for (let i = 0; i < 30; i++) {
        last = await readText('/cookie-echo?needle=' + encodeURIComponent(needle) + '&i=' + i);
        if (last.includes(needle)) return last;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('cookie header never contained ' + needle + ': ' + last);
    }
    async function readStream() {
      const started = performance.now();
      const resp = await fetch('/stream?ts=' + Date.now(), { cache: 'no-store' });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      const first = await reader.read();
      const firstMs = performance.now() - started;
      let body = first.value ? decoder.decode(first.value, { stream: true }) : '';
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        body += decoder.decode(next.value, { stream: true });
      }
      body += decoder.decode();
      return { status: resp.status, contentType: resp.headers.get('content-type') || '', firstText: first.value ? decoder.decode(first.value) : '', firstMs, body };
    }
    async function postText(path, body) {
      const resp = await fetch(path, { method: 'POST', body, cache: 'no-store' });
      return { status: resp.status, text: await resp.text() };
    }
    function websocketEcho() {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket('ws://e2e.test:' + targetPort + '/ws', ['zp-test']);
        let settled = false;
        const finish = fn => value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(value);
        };
        const timer = setTimeout(() => finish(reject)(new Error('websocket echo timed out')), 10000);
        ws.onerror = () => finish(reject)(new Error('websocket error'));
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => ws.send(new Uint8Array([1, 2, 3]).buffer);
        ws.onmessage = ev => {
          const data = ev.data instanceof ArrayBuffer ? Array.from(new Uint8Array(ev.data)).join(',') : String(ev.data);
          const result = { url: ws.url, data, protocol: ws.protocol, readyState: ws.readyState };
          try { ws.close(1000, 'done'); } catch {}
          finish(resolve)(result);
        };
      });
    }

    const setCookieBody = await readText('/set-cookie?ts=' + Date.now());
    const serverCookie = await waitForCookieHeader('target_server=from-target');
    document.cookie = 'client_runtime=from-runtime; Path=/';
    const visibleCookie = document.cookie;
    const clientCookie = await waitForCookieHeader('client_runtime=from-runtime');
    const stream = await readStream();
    const post = await postText('/post-echo', 'small-upload');
    const redirectPost = await postText('/redirect307', 'redirect-body');
    const oversized = await postText('/post-echo', 'x'.repeat(8 * 1024 * 1024 + 1));
    const ws = await websocketEcho();
    return { setCookieBody, serverCookie, visibleCookie, clientCookie, stream, ws, post, redirectPost, oversized };
  }, targetPort);
  assert.equal(runtimeIntegration.setCookieBody, 'set-cookie-ok');
  assert.match(runtimeIntegration.serverCookie, /target_server=from-target/);
  assert.match(runtimeIntegration.visibleCookie, /client_runtime=from-runtime/);
  assert.match(runtimeIntegration.clientCookie, /target_server=from-target/);
  assert.match(runtimeIntegration.clientCookie, /client_runtime=from-runtime/);
  assert.equal(runtimeIntegration.stream.status, 200);
  assert.match(runtimeIntegration.stream.contentType, /^text\/plain/);
  assert.equal(runtimeIntegration.stream.firstText, 'chunk-one\n');
  assert.equal(runtimeIntegration.stream.body, 'chunk-one\nchunk-two\n');
  assert.ok(runtimeIntegration.stream.firstMs < 500, `stream first chunk was buffered for ${runtimeIntegration.stream.firstMs}ms`);
  assert.equal(runtimeIntegration.ws.url, `ws://e2e.test:${targetPort}/ws`);
  assert.equal(runtimeIntegration.ws.data, '1,2,3');
  assert.equal(runtimeIntegration.ws.protocol, 'zp-test');
  assert.deepEqual(runtimeIntegration.post, { status: 200, text: 'small-upload' });
  assert.deepEqual(runtimeIntegration.redirectPost, { status: 200, text: 'redirect-body' });
  assert.equal(runtimeIntegration.oversized.status, 413);
  assert.match(runtimeIntegration.oversized.text, /REQUEST_BODY_TOO_LARGE/);
  assert.ok(requests.some(r => r.url.startsWith('/set-cookie') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.url.startsWith('/stream') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.upgrade && r.url === '/ws' && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.url.startsWith('/cookie-echo') && r.cookie.includes('target_server=from-target') && r.cookie.includes('client_runtime=from-runtime')), `target requests: ${JSON.stringify(requests)}`);

  const escapeMatrix = await page.evaluate(async targetPort => {
    const directBase = 'http://direct-egress.test:' + targetPort;
    const out = {};
    out.fetch = await fetch(directBase + '/direct-fetch', { cache: 'no-store' }).then(r => 'ok:' + r.status).catch(err => 'blocked:' + (err && err.name || 'Error'));
    out.xhr = await new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.onload = () => resolve('ok:' + xhr.status);
      xhr.onerror = () => resolve('blocked:error');
      try { xhr.open('GET', directBase + '/direct-xhr'); xhr.send(); } catch (err) { resolve('blocked:' + (err && err.name || 'Error')); }
    });
    out.eventSource = await new Promise(resolve => {
      let settled = false;
      const finish = value => { if (!settled) { settled = true; try { es.close(); } catch {} resolve(value); } };
      let es;
      try {
        es = new EventSource(directBase + '/sse');
        es.onmessage = ev => finish('ok:' + ev.data);
        es.onerror = () => finish('blocked:error');
        setTimeout(() => finish('blocked:timeout'), 1000);
      } catch (err) { resolve('blocked:' + (err && err.name || 'Error')); }
    });
    out.websocket = await new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://direct-egress.test:' + targetPort + '/ws');
      const timer = setTimeout(() => reject(new Error('direct-egress websocket timed out')), 10000);
      ws.onerror = () => { clearTimeout(timer); reject(new Error('direct-egress websocket failed')); };
      ws.onopen = () => ws.send('direct');
      ws.onmessage = ev => { clearTimeout(timer); const value = String(ev.data); try { ws.close(); } catch {} resolve(value); };
    });
    out.stringTimer = (() => { try { setTimeout('window.__timerRan=1', 0); return 'scheduled'; } catch (err) { return err && err.message || String(err); } })();
    out.blobWorker = await new Promise(resolve => {
      let worker;
      try {
        const url = URL.createObjectURL(new Blob([`postMessage('ran')`], { type: '' }));
        worker = new Worker(url);
        const timer = setTimeout(() => { try { worker.terminate(); } catch {} resolve('no-message'); }, 500);
        worker.onmessage = ev => { clearTimeout(timer); resolve(String(ev.data)); };
        worker.onerror = () => { clearTimeout(timer); resolve('error'); };
      } catch (err) { resolve('throw:' + (err && err.message || String(err))); }
    });
    out.dataWorker = await new Promise(resolve => {
      let worker;
      try {
        worker = new Worker('data:text/javascript,postMessage(%22ran%22)');
        const timer = setTimeout(() => { try { worker.terminate(); } catch {} resolve('no-message'); }, 500);
        worker.onmessage = ev => { clearTimeout(timer); resolve(String(ev.data)); };
        worker.onerror = () => { clearTimeout(timer); resolve('error'); };
      } catch (err) { resolve('throw:' + (err && err.message || String(err))); }
    });
    const button = document.createElement('button');
    button.setAttribute('onclick', 'window.__eventHandlerLocation = location.href');
    document.body.appendChild(button);
    button.click();
    out.eventHandlerLocation = window.__eventHandlerLocation || '';
    button.remove();
    const loc = __zp_get(globalThis, 'window').location;
    out.locationReplaceSource = loc.replace.toString();
    loc.hash = '#zp-fragment';
    out.virtualHash = loc.hash;
    out.virtualHref = loc.href;
    return out;
  }, targetPort);
  assert.equal(escapeMatrix.fetch, 'ok:404');
  assert.equal(escapeMatrix.xhr, 'ok:404');
  assert.equal(escapeMatrix.eventSource, 'ok:sse-ok');
  assert.equal(escapeMatrix.websocket, 'echo:direct');
  assert.equal(escapeMatrix.locationReplaceSource, 'function replace() { [native code] }');
  assert.equal(escapeMatrix.virtualHash, '#zp-fragment');
  assert.match(escapeMatrix.virtualHref, /#zp-fragment$/);
  assert.equal(escapeMatrix.stringTimer, 'Blocked by ZeroProxy policy');
  assert.notEqual(escapeMatrix.blobWorker, 'ran');
  assert.notEqual(escapeMatrix.dataWorker, 'ran');
  assert.ok(escapeMatrix.eventHandlerLocation === '' || escapeMatrix.eventHandlerLocation === `http://e2e.test:${targetPort}/`, `event handler location: ${escapeMatrix.eventHandlerLocation}`);
  assert.ok(socksHosts.includes('direct-egress.test'), `SOCKS hosts: ${JSON.stringify(socksHosts)}`);
  assert.ok(requests.some(r => r.upgrade && r.host === `direct-egress.test:${targetPort}` && r.url === '/ws'), `target requests: ${JSON.stringify(requests)}`);

  const forgedMessage = await page.evaluate(() => new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve({ timeout: true }), 3000);
    channel.port1.onmessage = ev => {
      clearTimeout(timer);
      resolve(ev.data || null);
    };
    navigator.serviceWorker.controller.postMessage({ type: 'ZP_RESOLVE_ENTRY', path: location.pathname }, [channel.port2]);
  }));
  assert.deepEqual(forgedMessage, { ok: false, error: 'POLICY_BLOCKED' });
  const bootLeak = await page.evaluate(() => ({
    bootType: typeof window.__ZP_BOOT,
    scriptContainsRuntimeToken: Array.from(document.scripts).some(s => s.textContent.includes('runtimeToken')),
  }));
  assert.equal(bootLeak.bootType, 'undefined');
  assert.equal(bootLeak.scriptContainsRuntimeToken, false);

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
