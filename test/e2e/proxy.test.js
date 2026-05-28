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
const JQUERY_SOURCE = fs.readFileSync(require.resolve('jquery'), 'utf8');

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

function isBenignSocketError(err) {
  return err && (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ERR_STREAM_PREMATURE_CLOSE');
}

function ignoreBenignSocketErrors(stream) {
  stream.on('error', err => {
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
  return new Promise(resolve => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
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
    ignoreBenignSocketErrors(req);
    ignoreBenignSocketErrors(res);
    requests.push({ url: req.url, method: req.method, host: req.headers.host || '', userAgent: req.headers['user-agent'] || '', cookie: req.headers.cookie || '', contentType: req.headers['content-type'] || '' });
    const url = new URL(req.url, 'http://target.local');
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>E2E Home</title><link rel="stylesheet" href="/site.css"></head><body>
        <main id="style-probe" class="root-stylesheet-probe"><h1>E2E Home</h1><img id="image-probe" src="/image-probe.png" alt=""><a id="next" href="/next">Next page</a></main>
        <script>
          window.__ua = navigator.userAgent;
          window.__platform = navigator.platform;
          window.__phase2Location = { href: location.href, windowHref: window.location.href };
          window.__phase2DynamicFunction = Function('return location.href')();
          window.__phase2EvalLocation = eval('location.href');
          window.__messageEvents = [];
          window.addEventListener('message', ev => {
            if (ev.data && ev.data.type) window.__messageEvents.push({ type: ev.data.type, origin: ev.origin, href: ev.data.href || '' });
          });
          (function(w,d,s,l,i){
            w[l]=w[l]||[];
            w[l].push({'gtm.start': Date.now(), event:'gtm.js'});
            var f=d.getElementsByTagName(s)[0], j=d.createElement(s), dl=l!='dataLayer'?'&l='+l:'';
            j.async=true;
            j.id='gtm-fixture';
            j.src='/gtm.js?id='+i+dl;
            f.parentNode.insertBefore(j,f || d.head.firstChild);
          })(window,document,'script','dataLayer','GTM-ZP');
          const dynamicScript = document.createElement('script');
          dynamicScript.id = 'dynamic-script-probe';
          dynamicScript.src = '/dynamic-script.js?from=createElement';
          document.head.appendChild(dynamicScript);
          try {
            const template = document.createElement('template');
            template.innerHTML = '<link rel="preconnect" href="https://preconnect.invalid">';
            const first = template.content.firstChild;
            const clone = first && first.cloneNode(true);
            if (clone) document.head.appendChild(clone);
            window.__templateLinkFixture = {
              childCount: template.content.childNodes.length,
              firstNode: first && first.localName,
              rel: first && first.getAttribute('rel'),
              href: first && first.getAttribute('href'),
              blockedRel: first && first.getAttribute('data-zp-blocked-rel'),
              blockedURL: first && first.getAttribute('data-zp-blocked-url'),
              cloneRel: clone && clone.getAttribute('rel'),
              cloneHref: clone && clone.getAttribute('href')
            };
          } catch (err) {
            window.__templateLinkFixture = { error: err && err.message || String(err) };
          }
        </script>
        <script src="/jquery.js"></script>
        <script src="/jquery-fixture.js"></script>
        <script src="/rewrite-fixture.js"></script>
        <script type="module" src="/module-worker.js"></script>
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
    if (url.pathname === '/site.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`.root-stylesheet-probe{border-top:7px solid rgb(12, 34, 56); padding-left:13px}`);
      return;
    }
    if (url.pathname === '/image-probe.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'));
      return;
    }
    if (url.pathname === '/gtm.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`window.__gtmFixture = {
        loaded: true,
        href: location.href,
        currentSrc: document.currentScript && document.currentScript.src,
        currentAttr: document.currentScript && document.currentScript.attributes.getNamedItem('src') && document.currentScript.attributes.getNamedItem('src').value
      };
      window.postMessage({ type: 'gtm-loaded', href: location.href }, location.origin);`);
      return;
    }
    if (url.pathname === '/jquery.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JQUERY_SOURCE);
      return;
    }
    if (url.pathname === '/jquery-fixture.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`(($) => {
        const root = $('<section id="jquery-fixture-root"><button class="trigger">Go</button><ul><li class="item">one</li><li class="item">two</li></ul></section>').appendTo(document.body);
        const found = root.find('.item');
        const ended = found.end();
        let delegated = 0;
        root.on('click', '.trigger', function() {
          delegated++;
          $(this).data('clicked', true).attr('data-clicked', 'yes');
        });
        root.find('.trigger').trigger('click');
        root.append($.parseHTML('<div class="parsed"><span>parsed</span></div>'));
        const emptyHtml = $('<div id="empty-html-probe"></div>').appendTo(root);
        emptyHtml.html('<span>filled</span>');
        const deferred = $.Deferred();
        const ajax = $.ajax({ url: '/jquery-ajax.json', dataType: 'json' });
        const script = $.getScript('/jquery-plugin.js');
        $.globalEval('window.__jqueryGlobalEvalHref = location.href;');
        deferred.resolve('resolved');
        $.when(deferred, ajax, script).done(function(deferredValue, ajaxValue) {
          const ajaxData = Array.isArray(ajaxValue) ? ajaxValue[0] : ajaxValue;
          window.__jqueryFixture = {
            ready: true,
            version: $.fn.jquery,
            selectorText: found.map(function(_, el) { return $(el).text(); }).get().join(','),
            endMatchesRoot: ended[0] === root[0],
            delegated,
            dataClicked: root.find('.trigger').data('clicked') === true,
            attrClicked: root.find('.trigger').attr('data-clicked'),
            parsedText: root.find('.parsed span').text(),
            param: $.param({ a: 1, b: ['x', 'y'] }),
            htmlProbeText: emptyHtml.find('span').text(),
            htmlProbeChildren: emptyHtml.children().length,
            ajaxData,
            plugin: window.__jqueryPlugin || null,
            globalEvalHref: window.__jqueryGlobalEvalHref || null,
            locationHref: window.location.href
          };
        }).fail(function(xhr, status, err) {
          window.__jqueryFixture = { ready: false, error: String(err || status || 'jquery-failed') };
        });
      })(jQuery);`);
      return;
    }
    if (url.pathname === '/jquery-ajax.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, path: '/jquery-ajax.json' }));
      return;
    }
    if (url.pathname === '/jquery-plugin.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`window.__jqueryPlugin = { loaded: true, href: location.href, jquery: !!window.jQuery };`);
      return;
    }
    if (url.pathname === '/dynamic-script.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`window.__dynamicScriptLoaded = {
        loaded: true,
        href: location.href,
        currentSrc: document.currentScript && document.currentScript.src,
        currentAttr: document.currentScript && document.currentScript.attributes.getNamedItem('src') && document.currentScript.attributes.getNamedItem('src').value
      };`);
      return;
    }
    if (url.pathname === '/module-worker.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`const worker = new Worker(new URL('/worker-fixture.js', import.meta.url).href, { name: 'module-worker-fixture' });
        worker.onmessage = ev => { window.__moduleWorkerFixture = ev.data; worker.terminate(); };
        worker.onerror = ev => { window.__moduleWorkerFixture = { error: ev && ev.message || 'worker-error' }; };`);
      return;
    }
    if (url.pathname === '/worker-fixture.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`postMessage({ loaded: true, href: location.href, userAgent: navigator.userAgent, platform: navigator.platform });`);
      return;
    }
    if (url.pathname === '/frame-child') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><html><body><p>frame child</p><script>
        parent.postMessage({ type: 'frame-child-ready', href: location.href, topOrigin: top.location.origin }, location.origin);
      </script></body></html>`);
      return;
    }
    if (url.pathname === '/rewrite-fixture.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`(() => {
        const NativeWebSocket = window.WebSocket;
        window.__rewriteAdvanced = { initialHref: window.location.href, constructorSource: NativeWebSocket.toString() };
        location.href += '#compound';
        window.location.hash += '-tail';
        window.__rewriteAdvanced.compoundHref = location.href;
        window.__rewriteAdvanced.compoundHash = location.hash;
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
          window.__rewriteAdvanced.constructorEscapeHref = ({}).constructor.constructor('return location.href')();
        } catch (err) {
          window.__rewriteAdvanced.constructorEscapeHref = 'error:' + (err && err.message || String(err));
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
    if (url.pathname === '/form-echo') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const kind = url.searchParams.get('kind') || '';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`<!doctype html><html><head><title>Form Echo ${kind}</title></head><body>
          <main id="form-result" data-method="${req.method}" data-kind="${kind}" data-content-type="${req.headers['content-type'] || ''}">
            <pre id="form-body">${body.replace(/[&<>]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch]))}</pre>
            <a id="next" href="/next">Next page</a>
          </main>
          <script>window.__formEcho=${JSON.stringify({ kind, method: req.method, contentType: req.headers['content-type'] || '', body })};</script>
        </body></html>`);
      });
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
  server.on('clientError', (err, socket) => {
    if (!socket.destroyed) {
      if (isBenignSocketError(err)) socket.destroy();
      else socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
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
  ignoreBenignSocketErrors(socket);
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
  socket.on('error', err => { if (!isBenignSocketError(err)) socket.destroy(err); });
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
  upstream.on('error', err => {
    if (!isBenignSocketError(err)) socket.destroy(err);
  });
  socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
  if (reader.buf.length) upstream.write(reader.buf);
  socket.pipe(upstream);
  upstream.pipe(socket);
}

test('browser traffic uses internal SOCKS5 mode and covers proxied runtime integrations', { timeout: 120000 }, async t => {
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
  const targetHost = 'localhost';

  const proxyPort = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.once('error', reject);
  });
  const proxy = childProcess.spawn(serverPath, ['-addr', `127.0.0.1:${proxyPort}`, '-web', webPath, '-kernel', kernelPath, '-socks', 'internal'], {
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
  await page.type('#url', `http://${targetHost}:${targetPort}/`);
  await page.click('button');
  try {
    await page.waitForFunction(() => document.title === 'E2E Home', { timeout: 30000 });
  } catch (err) {
    const state = await page.evaluate(() => ({ title: document.title, url: location.href, body: document.body && document.body.innerText, status: document.querySelector('#status')?.textContent || '' }));
    throw new Error(`${err.message}; nav state=${JSON.stringify(state)}; requests=${JSON.stringify(requests)}; proxy=${proxyLog}`);
  }

  const home = await page.evaluate(() => ({
    href: location.href,
    hash: location.hash,
    title: document.title,
    shellVisible: Boolean(document.querySelector('#open')),
    userAgent: navigator.userAgent,
    appVersion: navigator.appVersion,
    platform: navigator.platform,
    templateLink: window.__templateLinkFixture,
    phase2Location: window.__phase2Location,
    phase2DynamicFunction: window.__phase2DynamicFunction,
    phase2EvalLocation: window.__phase2EvalLocation,
    styleProbe: (() => {
      const el = document.getElementById('style-probe');
      const cs = el && getComputedStyle(el);
      return cs && { borderTopWidth: cs.borderTopWidth, borderTopColor: cs.borderTopColor, paddingLeft: cs.paddingLeft };
    })(),
    imageProbe: (() => {
      const el = document.getElementById('image-probe');
      return el && { complete: el.complete, naturalWidth: el.naturalWidth, src: el.getAttribute('src') };
    })(),
  }));
  assert.equal(home.title, 'E2E Home');
  assert.match(home.hash, /^#k=/);
  assert.equal(home.shellVisible, false);
  assert.equal(home.userAgent, TARGET_UA);
  assert.equal(home.appVersion, TARGET_UA.replace(/^Mozilla\//, ''));
  assert.deepEqual(home.templateLink, {
    childCount: 1,
    firstNode: 'link',
    rel: null,
    href: null,
    blockedRel: null,
    blockedURL: null,
    cloneRel: null,
    cloneHref: null,
  });
  assert.equal(home.platform, 'Win32');
  assert.match(home.href, new RegExp(`^http://proxy\\.localhost:${proxyPort}/zp/p/`));
  assert.deepEqual(home.phase2Location, { href: `http://${targetHost}:${targetPort}/`, windowHref: `http://${targetHost}:${targetPort}/` });
  assert.equal(home.phase2DynamicFunction, `http://${targetHost}:${targetPort}/`);
  assert.equal(home.phase2EvalLocation, `http://${targetHost}:${targetPort}/`);
  assert.deepEqual(home.styleProbe, { borderTopWidth: '7px', borderTopColor: 'rgb(12, 34, 56)', paddingLeft: '13px' });
  assert.ok(requests.some(r => r.url === '/site.css' && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  assert.equal(home.imageProbe.complete, true);
  assert.equal(home.imageProbe.naturalWidth, 1);
  assert.equal(home.imageProbe.src, `http://${targetHost}:${targetPort}/image-probe.png`);
  assert.ok(requests.some(r => r.url === '/image-probe.png' && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.url === '/' && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  const addressBarShare = page.url();
  const relayServerParam = new RegExp(`server=ws%3A%2F%2Fproxy\\.localhost%3A${proxyPort}%2Fzp%2Fws-pipe`);
  assert.match(addressBarShare, /#k=/);
  assert.match(addressBarShare, relayServerParam);
  const staticNextHref = await page.$eval('#next', el => el.getAttribute('href') || '');
  assert.match(staticNextHref, /^\/zp\/p\//);
  assert.match(staticNextHref, relayServerParam);
  const externalContext = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
  try {
    const externalPage = await externalContext.newPage();
    await externalPage.goto(addressBarShare, { waitUntil: 'domcontentloaded' });
    await externalPage.waitForFunction(() => document.title === 'E2E Home', { timeout: 30000 });
    assert.match(externalPage.url(), /#k=/);
    assert.match(externalPage.url(), relayServerParam);
  } finally {
    await externalContext.close();
  }
  await page.waitForFunction(() => window.__rewriteAdvanced && window.__rewriteAdvanced.wsMessage === 'echo:rewrite-script', { timeout: 30000 });
  const rewriteAdvanced = await page.evaluate(() => window.__rewriteAdvanced);
  assert.equal(rewriteAdvanced.initialHref, `http://${targetHost}:${targetPort}/`);
  assert.equal(rewriteAdvanced.wsURL, `ws://${targetHost}:${targetPort}/ws`);
  assert.equal(rewriteAdvanced.wsProtocol, 'zp-rewrite');
  assert.equal(rewriteAdvanced.wsMessage, 'echo:rewrite-script');
  assert.equal(rewriteAdvanced.wsError, undefined);
  assert.equal(rewriteAdvanced.jqueryConstructorLength, 0);
  assert.equal(rewriteAdvanced.constructorEscapeHref, `http://${targetHost}:${targetPort}/#compound-tail`);
  assert.equal(rewriteAdvanced.compoundHash, '#compound-tail');
  assert.equal(rewriteAdvanced.compoundHref, `http://${targetHost}:${targetPort}/#compound-tail`);
  assert.ok(requests.some(r => r.upgrade && r.url === '/ws' && r.protocol === 'zp-rewrite' && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  try {
    await page.waitForFunction(() => window.__gtmFixture && window.__gtmFixture.loaded && window.__dynamicScriptLoaded && window.__dynamicScriptLoaded.loaded && window.__moduleWorkerFixture && window.__moduleWorkerFixture.loaded, { timeout: 30000 });
  } catch (err) {
    const state = await page.evaluate(() => ({
      gtm: window.__gtmFixture || null,
      dynamic: window.__dynamicScriptLoaded || null,
      moduleWorker: window.__moduleWorkerFixture || null,
      scripts: Array.from(document.scripts).map(s => ({ id: s.id, src: s.attributes.getNamedItem('src')?.value || '', type: s.type || '', blocked: s.hasAttribute('data-zp-blocked-script') })),
      messages: window.__messageEvents || [],
    }));
    throw new Error(`${err.message}; dynamic state=${JSON.stringify(state)}; requests=${JSON.stringify(requests)}`);
  }
  const dynamicScripts = await page.evaluate(() => ({
    gtm: window.__gtmFixture,
    dynamic: window.__dynamicScriptLoaded,
    moduleWorker: window.__moduleWorkerFixture,
    gtmAttr: document.getElementById('gtm-fixture')?.attributes.getNamedItem('src')?.value || '',
    dynamicAttr: document.getElementById('dynamic-script-probe')?.attributes.getNamedItem('src')?.value || '',
    messages: window.__messageEvents || [],
  }));
  assert.ok(dynamicScripts.gtm.href.startsWith(`http://${targetHost}:${targetPort}/`), dynamicScripts.gtm.href);
  assert.ok(dynamicScripts.dynamic.href.startsWith(`http://${targetHost}:${targetPort}/`), dynamicScripts.dynamic.href);
  assert.match(dynamicScripts.gtm.currentAttr, /^\/zp\/api\/script\?/);
  assert.equal(dynamicScripts.moduleWorker.href, `http://${targetHost}:${targetPort}/worker-fixture.js`);
  assert.equal(dynamicScripts.moduleWorker.userAgent, TARGET_UA);
  assert.equal(dynamicScripts.moduleWorker.platform, 'Win32');
  assert.match(dynamicScripts.dynamic.currentAttr, /^\/zp\/api\/script\?/);
  assert.match(dynamicScripts.gtmAttr, /^\/zp\/api\/script\?/);
  assert.match(dynamicScripts.dynamicAttr, /^\/zp\/api\/script\?/);
  assert.ok(dynamicScripts.messages.some(m => m.type === 'gtm-loaded'), `messages: ${JSON.stringify(dynamicScripts.messages)}`);
  assert.ok(requests.some(r => r.url.startsWith('/gtm.js') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.url.startsWith('/dynamic-script.js') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.url.startsWith('/module-worker.js') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.url.startsWith('/worker-fixture.js') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);

  try {
    await page.waitForFunction(() => window.__jqueryFixture && window.__jqueryFixture.ready, { timeout: 30000 });
  } catch (err) {
    const state = await page.evaluate(() => ({
      jquery: window.__jqueryFixture || null,
      plugin: window.__jqueryPlugin || null,
      hasJQuery: Boolean(window.jQuery),
      scripts: Array.from(document.scripts).map(s => ({ id: s.id, src: s.attributes.getNamedItem('src')?.value || '', type: s.type || '', blocked: s.hasAttribute('data-zp-blocked-script') })),
    }));
    throw new Error(`${err.message}; jquery state=${JSON.stringify(state)}; requests=${JSON.stringify(requests)}`);
  }
  const jquery = await page.evaluate(() => window.__jqueryFixture);
  assert.match(jquery.version, /^3\./);
  assert.equal(jquery.selectorText, 'one,two');
  assert.equal(jquery.endMatchesRoot, true);
  assert.equal(jquery.delegated, 1);
  assert.equal(jquery.dataClicked, true);
  assert.equal(jquery.attrClicked, 'yes');
  assert.equal(jquery.parsedText, 'parsed');
  assert.equal(jquery.htmlProbeText, 'filled');
  assert.equal(jquery.htmlProbeChildren, 1);
  assert.equal(jquery.param, 'a=1&b%5B%5D=x&b%5B%5D=y');
  assert.deepEqual(jquery.ajaxData, { ok: true, path: '/jquery-ajax.json' });
  assert.equal(jquery.plugin && jquery.plugin.loaded, true);
  assert.equal(jquery.plugin && jquery.plugin.jquery, true);
  assert.ok(jquery.plugin.href.startsWith(`http://${targetHost}:${targetPort}/`), jquery.plugin.href);
  assert.ok(jquery.globalEvalHref.startsWith(`http://${targetHost}:${targetPort}/`), jquery.globalEvalHref);
  assert.ok(jquery.locationHref.startsWith(`http://${targetHost}:${targetPort}/`), jquery.locationHref);
  assert.ok(requests.some(r => r.url.startsWith('/jquery.js') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.url.startsWith('/jquery-fixture.js') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.url.startsWith('/jquery-ajax.json') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.url.startsWith('/jquery-plugin.js') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);

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
    const childFunctionShared = modern.contentWindow.Function === window.Function;
    const childFunctionHref = modern.contentWindow.Function('return location.href')();
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
        if (current.startsWith(location.origin + '/zp/p/')) { resolve(current); return; }
        if (Date.now() > deadline) { reject(new Error(`src not rewritten: ${current}`)); return; }
        setTimeout(poll, 25);
      })();
    });

    sync.remove();
    modern.remove();
    observed.remove();
    return { syncRTC, docRTC, modernRTC, websocketShared, websocketURL, childCanvasMask, childFunctionShared, childFunctionHref, rewrittenSrc };
  }, `http://${targetHost}:${targetPort}/next`);
  assert.equal(iframeIsolation.syncRTC, 'Blocked by ZeroProxy policy');
  assert.equal(iframeIsolation.docRTC, 'Blocked by ZeroProxy policy');
  assert.equal(iframeIsolation.modernRTC, 'Blocked by ZeroProxy policy');
  assert.equal(iframeIsolation.websocketShared, true);
  assert.equal(iframeIsolation.websocketURL, 'ws://evil.example/socket');
  assert.match(iframeIsolation.rewrittenSrc, new RegExp(`^http://proxy\\.localhost:${proxyPort}/zp/p/`));
  assert.equal(iframeIsolation.childCanvasMask, 'function toDataURL() { [native code] }');
  assert.equal(iframeIsolation.childFunctionShared, true);
  assert.equal(iframeIsolation.childFunctionHref, `http://${targetHost}:${targetPort}/#compound-tail`);

  const frameMessage = await page.evaluate(async target => {
    const before = location.href;
    const got = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('frame postMessage timed out')), 10000);
      window.addEventListener('message', function onMessage(ev) {
        if (!ev.data || ev.data.type !== 'frame-child-ready') return;
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        resolve({ origin: ev.origin, href: ev.data.href, topOrigin: ev.data.topOrigin });
      });
    });
    const frame = document.createElement('iframe');
    frame.src = target;
    document.body.appendChild(frame);
    const message = await got;
    frame.remove();
    return { before, after: location.href, message };
  }, `http://${targetHost}:${targetPort}/frame-child`);
  assert.equal(frameMessage.before, frameMessage.after);
  assert.equal(frameMessage.message.origin, `http://${targetHost}:${targetPort}`);
  assert.equal(frameMessage.message.href, `http://${targetHost}:${targetPort}/frame-child`);
  assert.equal(frameMessage.message.topOrigin, `http://${targetHost}:${targetPort}`);

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
        const ws = new WebSocket('ws://localhost:' + targetPort + '/ws', ['zp-test']);
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
    async function websocketStreamEcho() {
      const stream = new WebSocketStream('ws://localhost:' + targetPort + '/ws', { protocols: ['zp-stream'] });
      const opened = await stream.opened;
      const writer = opened.writable.getWriter();
      await writer.write('stream');
      const reader = opened.readable.getReader();
      const first = await reader.read();
      await writer.close();
      const closed = await stream.closed;
      return { protocol: opened.protocol, data: String(first.value), closeCode: closed.closeCode };
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
    const wsStream = await websocketStreamEcho();
    return { setCookieBody, serverCookie, visibleCookie, clientCookie, stream, ws, wsStream, post, redirectPost, oversized };
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
  assert.equal(runtimeIntegration.ws.url, `ws://${targetHost}:${targetPort}/ws`);
  assert.equal(runtimeIntegration.ws.data, '1,2,3');
  assert.equal(runtimeIntegration.ws.protocol, 'zp-test');
  assert.deepEqual(runtimeIntegration.wsStream, { protocol: 'zp-stream', data: 'echo:stream', closeCode: 1000 });
  assert.deepEqual(runtimeIntegration.post, { status: 200, text: 'small-upload' });
  assert.deepEqual(runtimeIntegration.redirectPost, { status: 200, text: 'redirect-body' });
  assert.equal(runtimeIntegration.oversized.status, 413);
  assert.match(runtimeIntegration.oversized.text, /REQUEST_BODY_TOO_LARGE/);
  assert.ok(requests.some(r => r.url.startsWith('/set-cookie') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.url.startsWith('/stream') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.upgrade && r.url === '/ws' && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.upgrade && r.url === '/ws' && r.protocol === 'zp-stream' && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.url.startsWith('/cookie-echo') && r.cookie.includes('target_server=from-target') && r.cookie.includes('client_runtime=from-runtime')), `target requests: ${JSON.stringify(requests)}`);

  const escapeMatrix = await page.evaluate(async targetPort => {
    const directBase = 'http://localhost:' + targetPort;
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
      const ws = new WebSocket('ws://localhost:' + targetPort + '/ws');
      const timer = setTimeout(() => reject(new Error('internal-mode websocket timed out')), 10000);
      ws.onerror = () => { clearTimeout(timer); reject(new Error('internal-mode websocket failed')); };
      ws.onopen = () => ws.send('direct');
      ws.onmessage = ev => { clearTimeout(timer); const value = String(ev.data); try { ws.close(); } catch {} resolve(value); };
    });
    out.stringTimer = await new Promise(resolve => {
      try {
        window.__timerRan = 0;
        setTimeout('window.__timerRan=1', 0);
        setTimeout(() => resolve(window.__timerRan === 1 ? 'ran' : 'not-ran'), 25);
      } catch (err) {
        resolve(err && err.message || String(err));
      }
    });
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
    const beforeSrcdoc = location.href;
    const evil = document.createElement('iframe');
    evil.srcdoc = `<script>top.location.href='https://evil.example/'; parent.postMessage({type:'evil-srcdoc'}, '*')<\/script>`;
    document.body.appendChild(evil);
    await new Promise(resolve => setTimeout(resolve, 100));
    out.afterSrcdocHref = location.href;
    out.afterSrcdocVirtualHref = loc.href;
    out.topOrigin = __zp_get(globalThis, 'top').location.origin;
    out.beforeSrcdoc = beforeSrcdoc;
    evil.remove();
    return out;
  }, targetPort);
  assert.equal(escapeMatrix.fetch, 'ok:404');
  assert.equal(escapeMatrix.xhr, 'ok:404');
  assert.equal(escapeMatrix.eventSource, 'ok:sse-ok');
  assert.equal(escapeMatrix.websocket, 'echo:direct');
  assert.equal(escapeMatrix.locationReplaceSource, 'function replace() { [native code] }');
  assert.equal(escapeMatrix.virtualHash, '#zp-fragment');
  assert.match(escapeMatrix.virtualHref, /#zp-fragment$/);
  assert.equal(escapeMatrix.afterSrcdocVirtualHref, escapeMatrix.virtualHref);
  assert.equal(escapeMatrix.topOrigin, `http://${targetHost}:${targetPort}`);
  assert.equal(page.url().startsWith(`http://proxy.localhost:${proxyPort}/`), true);
  assert.equal(escapeMatrix.stringTimer, 'ran');
  assert.notEqual(escapeMatrix.blobWorker, 'ran');
  assert.notEqual(escapeMatrix.dataWorker, 'ran');
  assert.ok(escapeMatrix.eventHandlerLocation === '' || escapeMatrix.eventHandlerLocation === `http://${targetHost}:${targetPort}/#compound-tail`, `event handler location: ${escapeMatrix.eventHandlerLocation}`);
  assert.equal(requests.filter(r => r.userAgent && r.userAgent !== TARGET_UA).length, 0, `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.url.startsWith('/direct-fetch') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);

  const serviceWorkerPolicy = await page.evaluate(async () => {
    const out = {
      exposed: 'serviceWorker' in navigator,
      controller: navigator.serviceWorker && navigator.serviceWorker.controller,
      registrationCount: null,
      registerError: '',
    };
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) out.registrationCount = (await navigator.serviceWorker.getRegistrations()).length;
    try { await navigator.serviceWorker.register('/target-sw.js'); }
    catch (err) { out.registerError = err && err.name || String(err); }
    return out;
  });
  assert.equal(serviceWorkerPolicy.exposed, true);
  assert.equal(serviceWorkerPolicy.controller, null);
  assert.equal(serviceWorkerPolicy.registrationCount, 0);
  assert.equal(serviceWorkerPolicy.registerError, 'NotSupportedError');
  const bootLeak = await page.evaluate(() => ({
    bootType: typeof window.__ZP_BOOT,
    scriptContainsRuntimeToken: Array.from(document.scripts).some(s => s.textContent.includes('runtimeToken')),
  }));
  assert.equal(bootLeak.bootType, 'undefined');
  assert.equal(bootLeak.scriptContainsRuntimeToken, false);


  async function submitFormFixture(kind) {
    await page.evaluate(kind => {
      const f = document.createElement('form');
      f.method = 'POST';
      f.enctype = kind === 'multipart' ? 'multipart/form-data' : kind === 'plain' ? 'text/plain' : 'application/x-www-form-urlencoded';
      f.action = '/form-echo?kind=wrong';
      const input = document.createElement('input');
      input.name = 'alpha';
      input.value = 'one';
      f.appendChild(input);
      if (kind === 'multipart') {
        const file = document.createElement('input');
        file.type = 'file';
        file.name = 'upload';
        const dt = new DataTransfer();
        dt.items.add(new File(['file-body'], 'hello.txt', { type: 'text/plain' }));
        file.files = dt.files;
        f.appendChild(file);
      }
      const button = document.createElement('button');
      button.type = 'submit';
      button.name = 'submitter';
      button.value = kind;
      button.setAttribute('formaction', '/form-echo?kind=' + kind);
      f.appendChild(button);
      document.body.appendChild(f);
      f.requestSubmit(button);
    }, kind);
    await page.waitForFunction(k => window.__formEcho && window.__formEcho.kind === k, { timeout: 30000 }, kind);
    return page.evaluate(() => { const loc = __zp_get(globalThis, 'location'); return { echo: window.__formEcho, virtualHref: loc.href, virtualHash: loc.hash, documentURL: __zp_get(document, 'URL'), baseURI: __zp_get(document, 'baseURI') }; });
  }
  const urlencodedForm = await submitFormFixture('urlencoded');
  assert.equal(urlencodedForm.echo.method, 'POST');
  assert.match(urlencodedForm.echo.contentType, /^application\/x-www-form-urlencoded/);
  assert.equal(urlencodedForm.echo.body, 'alpha=one&submitter=urlencoded');
  const plainForm = await submitFormFixture('plain');
  assert.match(plainForm.echo.contentType, /^text\/plain/);
  assert.match(plainForm.echo.body, /alpha=one/);
  assert.match(plainForm.echo.body, /submitter=plain/);
  const multipartForm = await submitFormFixture('multipart');
  assert.match(multipartForm.echo.contentType, /^multipart\/form-data; boundary=/);
  assert.match(multipartForm.echo.body, /name="upload"; filename="hello.txt"/);
  assert.match(multipartForm.echo.body, /file-body/);
  const rawAfterSubmit = page.url();
  const rawKey = new URL(rawAfterSubmit).hash ? new URLSearchParams(new URL(rawAfterSubmit).hash.slice(1)).get('k') : '';
  assert.match(rawAfterSubmit, /#k=/);
  assert.match(rawAfterSubmit, /\?zp_submit=/);
  for (const surface of [multipartForm.virtualHref, multipartForm.virtualHash, multipartForm.documentURL, multipartForm.baseURI]) {
    assert.equal(surface.includes('zp_submit='), false, surface);
    if (rawKey) assert.equal(surface.includes(rawKey), false, surface);
  }
  assert.ok(requests.some(r => r.url.startsWith('/form-echo?kind=urlencoded') && r.contentType.startsWith('application/x-www-form-urlencoded')), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.url.startsWith('/form-echo?kind=plain') && r.contentType.startsWith('text/plain')), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.url.startsWith('/form-echo?kind=multipart') && r.contentType.startsWith('multipart/form-data')), `target requests: ${JSON.stringify(requests)}`);
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
  assert.match(next.hash, /^#k=/);
  assert.equal(next.shellVisible, false);
  assert.equal(next.userAgent, TARGET_UA);
  assert.match(next.href, new RegExp(`^http://proxy\\.localhost:${proxyPort}/zp/p/`));
  assert.ok(requests.some(r => r.url === '/next' && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
});
