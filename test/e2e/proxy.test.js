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
const { brotliCompressSync, gzipSync } = require('node:zlib');

const { handleRequestContract, runRequestContract } = require('./request-contract');
const { openThroughLauncher } = require('./launcher');
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

// A page that reports — by postMessage to its embedder or opener — how ITS view
// of that window behaves: a native Chrome frame of another site may use a short
// fixed list and gets SecurityError for everything else.
function xsiteReporter(kind, viaOpener) {
  const w = viaOpener ? 'opener' : 'parent';
  const prefix = viaOpener ? 'opener' : 'parent';
  const ops = viaOpener
    ? [['openerType', 'window.opener'], ['openerDocument', 'opener.document'], ['openerStorage', 'opener.localStorage'], ['openerEval', 'opener.eval'],
       ['openerLocationHref', 'opener.location.href'], ['openerClosed', 'opener.closed'], ['openerSelf', 'opener.self === opener'], ['openerTop', 'opener.top === opener'],
       ['openerIn', '"document" in opener'], ['frameElement', 'window.frameElement'], ['parentIsSelf', 'parent === window']]
    : [['parentDocument', 'parent.document'], ['parentStorage', 'parent.localStorage'], ['parentEval', 'parent.eval'], ['parentName', 'parent.name'],
       ['parentLocationHref', 'parent.location.href'], ['parentLocationType', 'parent.location'], ['topDocument', 'top.document'], ['frameElement', 'window.frameElement'],
       ['parentIsTop', 'parent === top'], ['parentSelf', 'parent.self === parent'], ['parentLength', 'parent.length'], ['parentClosed', 'parent.closed'],
       ['parentPostMessage', 'parent.postMessage'], ['parentFrames', 'parent.frames'], ['parentIn', '"document" in parent'],
       ['parentProto', 'Object.getPrototypeOf(parent)'], ['parentSetProp', '(parent.zpProbe = 1, "set")'], ['opener', 'window.opener']];
  let body = 'var R = {};' +
    'function op(k, f) { try { var v = f(); R[k] = v === null ? "null" : (typeof v === "object" || typeof v === "function") ? typeof v : (typeof v === "string" ? "string" : String(v)); } catch (e) { R[k] = "threw:" + (e && e.name); } }';
  for (const [k, expr] of ops) body += 'op(' + JSON.stringify(k) + ', function () { return ' + expr + '; });';
  body += w + '.postMessage(JSON.stringify({ kind: ' + JSON.stringify(kind) + ', R: R }), "*");';
  return '<!doctype html><title>x</title><script>' + body + '<\/script>';
}

// A solid-color PNG of the given size: a test image that is not the 1x1 of a placeholder.
function solidPNG(size) {
  const zlib = require('node:zlib');
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, 'latin1');
    data.copy(b, 8);
    b.writeUInt32BE(zlib.crc32(b.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { raw[y * stride + 1 + x * 4 + 1] = 160; raw[y * stride + 1 + x * 4 + 3] = 255; }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// A minimal valid TrueType font (one empty glyph), built byte by byte: enough for Chrome's sanitizer to accept it, so a
// font load can succeed or be refused in a test without a binary file in the repository.
function miniTrueTypeFont() {
  const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff); return b; };
  const i16 = n => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
  const pad4 = b => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
  const sum = b => { let s = 0; const p = pad4(b); for (let i = 0; i < p.length; i += 4) s = (s + p.readUInt32BE(i)) >>> 0; return s; };
  const head = Buffer.concat([u32(0x00010000), u32(0x00010000), u32(0), u32(0x5f0f3cf5), u16(0), u16(1000), Buffer.alloc(16),
    i16(0), i16(0), i16(0), i16(0), u16(0), u16(8), i16(2), i16(0), i16(0)]);
  const hhea = Buffer.concat([u32(0x00010000), i16(800), i16(-200), i16(0), u16(1000), i16(0), i16(0), i16(0), i16(1), i16(0), i16(0),
    Buffer.alloc(8), i16(0), u16(1)]);
  const maxp = Buffer.concat([u32(0x00010000), u16(1), Buffer.alloc(26)]);
  const hmtx = Buffer.concat([u16(1000), i16(0)]);
  const seg = Buffer.concat([u16(4), u16(24), u16(0), u16(2), u16(2), u16(0), u16(0), u16(0xffff), u16(0), u16(0xffff), i16(1), u16(0)]);
  const cmap = Buffer.concat([u16(0), u16(1), u16(3), u16(1), u32(12), seg]);
  const glyf = Buffer.alloc(4);
  const loca = Buffer.concat([u16(0), u16(0)]);
  const names = [[1, 'F'], [2, 'Regular'], [4, 'F'], [6, 'F']].map(([id, s]) => [id, Buffer.from(s, 'utf16le').swap16()]);
  let strings = Buffer.alloc(0);
  const records = names.map(([id, s]) => { const r = Buffer.concat([u16(3), u16(1), u16(0x409), u16(id), u16(s.length), u16(strings.length)]); strings = Buffer.concat([strings, s]); return r; });
  const name = Buffer.concat([u16(0), u16(names.length), u16(6 + 12 * names.length), ...records, strings]);
  const os2 = Buffer.concat([u16(4), i16(500), u16(400), u16(5), u16(0), i16(650), i16(600), i16(0), i16(75), i16(650), i16(600), i16(0), i16(350), i16(50), i16(300),
    i16(0), Buffer.alloc(10), u32(1), u32(0), u32(0), u32(0), Buffer.from('NONE'), u16(0x40), u16(0x20), u16(0xffff), i16(800), i16(-200), i16(0), u16(800), u16(200),
    u32(1), u32(0), i16(500), i16(700), u16(0), u16(32), u16(1)]);
  const post = Buffer.concat([u32(0x00030000), u32(0), i16(-100), i16(50), u32(0), u32(0), u32(0), u32(0), u32(0)]);
  const tables = { 'OS/2': os2, cmap, glyf, head, hhea, hmtx, loca, maxp, name, post };
  const tags = Object.keys(tables).sort();
  const dirLen = 12 + 16 * tags.length;
  let offset = dirLen;
  const dir = [];
  const bodies = [];
  let headOffset = 0;
  for (const tag of tags) {
    const data = tables[tag];
    if (tag === 'head') headOffset = offset;
    dir.push(Buffer.concat([Buffer.from(tag, 'latin1'), u32(sum(data)), u32(offset), u32(data.length)]));
    const padded = pad4(data);
    bodies.push(padded);
    offset += padded.length;
  }
  const n = tags.length;
  let pow = 1, log = 0;
  while (pow * 2 <= n) { pow *= 2; log++; }
  const header = Buffer.concat([u32(0x00010000), u16(n), u16(pow * 16), u16(log), u16(n * 16 - pow * 16)]);
  const font = Buffer.concat([header, ...dir, ...bodies]);
  font.writeUInt32BE((0xb1b0afba - sum(font)) >>> 0, headOffset + 8);
  return font;
}

function createTargetServer(requests, pendingResponses) {
  // tag → the names of the cookies the request that carried it had (see /xck-echo)
  const xckSeen = new Map();
  // tag → what each request the cross-origin API (/xcors-api) saw under it looked like
  const corsLog = new Map();
  const server = http.createServer((req, res) => {
    ignoreBenignSocketErrors(req);
    ignoreBenignSocketErrors(res);
    if (handleRequestContract(req, res, requests)) return;
    requests.push({ url: req.url, method: req.method, host: req.headers.host || '', userAgent: req.headers['user-agent'] || '', cookie: req.headers.cookie || '', contentType: req.headers['content-type'] || '' });
    const url = new URL(req.url, 'http://target.local');
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>E2E Home</title><link rel="stylesheet" href="/site.css"><link id="icon-link" rel="icon" href="/site-icon.png"></head><body>
        <main id="style-probe" class="root-stylesheet-probe"><h1>E2E Home</h1><img id="image-probe" src="/image-probe.png" alt=""><a id="next" href="/next">Next page</a></main>
        <script>
          window.__submitFormFixture = kind => {
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
          };
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
            const rowTemplate = document.createElement('template');
            rowTemplate.innerHTML = '<tr><td>cell</td></tr>';
            const row = rowTemplate.content.firstChild;
            window.__templateLinkFixture = {
              childCount: template.content.childNodes.length,
              firstNode: first && first.localName,
              rel: first && first.getAttribute('rel'),
              href: first && first.getAttribute('href'),
              blockedRel: first && first.getAttribute('data-zp-blocked-rel'),
              blockedURL: first && first.getAttribute('data-zp-blocked-url'),
              cloneRel: clone && clone.getAttribute('rel'),
              cloneHref: clone && clone.getAttribute('href'),
              tableRowNode: row && row.nodeName,
              tableRowText: row && row.textContent
            };
          } catch (err) {
            window.__templateLinkFixture = { error: err && err.message || String(err) };
          }
          window.__urlAttributeFixture = [['link', 'href'], ['img', 'srcset'], ['script', 'src']].map(([tag, key]) => {
            try {
              const el = document.createElement(tag);
              const snapshot = () => [el.getAttribute(key), el.getAttributeNS(null, key), el.hasAttribute(key)];
              const absent = snapshot();
              el.toggleAttribute(key, true);
              const empty = snapshot();
              el.removeAttribute(key);
              const removed = snapshot();
              el.setAttribute(key, '/image-probe.png');
              el.removeAttribute(key);
              const removedAfterURL = snapshot();
              el.toggleAttribute(key, true);
              const emptyAfterURL = snapshot();
              return { absent, empty, removed, removedAfterURL, emptyAfterURL };
            } catch (err) { return { error: err && err.message || String(err) }; }
          });
        </script>
        <script src="/jquery.js"></script>
        <script src="/jquery-fixture.js"></script>
        <script src="/rewrite-fixture.js"></script>
        <script type="module" src="/module-worker.js"></script>
      </body></html>`);
      return;
    }
    if (url.pathname === '/regressions') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><html><head><title>Compatibility Regressions</title></head><body>
        <h1 id="regressions">Compatibility Regressions</h1>
        <script src="/regression-fixture.js"></script>
        <script type="module" src="/module-identity-entry.js"></script>
      </body></html>`);
      return;
    }
    if (url.pathname === '/module-singleton.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`export const evaluationCount = window.__moduleEvaluations = (window.__moduleEvaluations || 0) + 1;
        export const singleton = { evaluationCount };
        window.__moduleSingleton = singleton;`);
      return;
    }
    if (url.pathname === '/module-identity-entry.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`import { singleton, evaluationCount } from './module-singleton.js';
        const snapshot = () => ({ evaluations: window.__moduleEvaluations, evaluationCount,
          sameSingleton: singleton === window.__moduleSingleton, href: location.href });
        const load = (src, type) => new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.type = type;
          script.src = src;
          script.onload = () => { script.remove(); resolve(); };
          script.onerror = () => { script.remove(); reject(new Error('script load failed: ' + src)); };
          document.head.appendChild(script);
        });
        (async () => {
          const initial = snapshot();
          await load('/module-singleton.js', 'module');
          const dynamic = snapshot();
          await load('/classic-ref.js', 'text/javascript');
          history.pushState({}, '', '/regressions/changed?view=2');
          await load('/module-singleton.js', 'module');
          const afterHistory = snapshot();
          await load('/module-singleton.js', 'module');
          const repeated = snapshot();
          await load('/classic-ref.js', 'text/javascript');
          window.__moduleIdentityFixture = { initial, dynamic, afterHistory, repeated, classic: window.__classicRefs };
        })().catch(error => { window.__moduleIdentityFixture = { error: error.stack || String(error) }; });`);
      return;
    }
    if (url.pathname === '/classic-ref.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`(window.__classicRefs || (window.__classicRefs = [])).push(location.href);`);
      return;
    }
    if (url.pathname === '/regression-fixture.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`(async () => {
          const original = { nested: { value: 7 } };
          original.self = original;
          const cloned = globalThis.structuredClone(original);
          const order = [];
          globalThis.queueMicrotask(() => order.push('microtask'));
          order.push('sync');
          await Promise.resolve();
          const pageMethod = { method() { return this.value; } }.method;
          globalThis.pageReceiverFixture = pageMethod;
          class PageConstructor { constructor(value) { this.value = value; } }
          globalThis.PageConstructorFixture = PageConstructor;
          const instance = new globalThis.PageConstructorFixture(11);
          const nativeURL = new globalThis.URL('/receiver-child', location.href);
          window.__receiverFixture = {
            clonedValue: cloned.nested.value, cycle: cloned.self === cloned,
            independent: cloned !== original && cloned.nested !== original.nested, order,
            pageFunctionSame: globalThis.pageReceiverFixture === pageMethod,
            pageReceiver: globalThis.pageReceiverFixture.call({ value: 'custom-receiver' }),
            constructorSame: globalThis.PageConstructorFixture === PageConstructor,
            constructed: instance instanceof PageConstructor && Object.getPrototypeOf(instance) === PageConstructor.prototype,
            constructedValue: instance.value, nativeURL: nativeURL.href, nativeInstance: nativeURL instanceof globalThis.URL
          };
        })().catch(error => { window.__receiverFixture = { error: error.stack || String(error) }; });
        window.__startSilentCloseFixture = () => {
          const ws = new WebSocket('/ws?silent-close=1', ['zp-silent-close']);
          const result = window.__silentCloseFixture = { opened: false, closes: [] };
          let closingAt;
          ws.onopen = () => {
            result.opened = true;
            closingAt = performance.now();
            ws.close(3001, 'unanswered');
            result.closingState = ws.readyState;
          };
          ws.onclose = event => result.closes.push({ code: event.code, reason: event.reason,
            wasClean: event.wasClean, readyState: ws.readyState, elapsed: performance.now() - closingAt });
        };
        window.__startReservedFetchFixture = mode => {
          const result = window.__reservedFetchFixture = { body: '', done: false };
          (async () => {
            const response = await fetch('/reserved-headers?mode=' + mode, { cache: 'no-store' });
            result.status = response.status;
            result.headers = Array.from(response.headers.entries());
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              result.body += decoder.decode(next.value, { stream: true });
            }
            result.body += decoder.decode();
            result.done = true;
          })().catch(error => { result.error = error && error.name || String(error); });
        };
        window.__startReservedHTMLFixture = () => {
          const frame = document.createElement('iframe');
          frame.id = 'reserved-frame';
          frame.src = '/reserved-headers?mode=html';
          document.body.appendChild(frame);
        };`);
      return;
    }
    if (url.pathname === '/reserved-headers') {
      const mode = url.searchParams.get('mode');
      const headers = {
        'Content-Type': mode === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-zP-BodY-StReAm': '0',
        'x-Zp-sTrEaM': mode === 'html' ? '0' : '1',
        'X-Fixture': 'preserved',
      };
      if (mode === 'buffered') {
        // Brotli uses the real bounded-buffering path, without changing kernel policy.
        res.writeHead(200, { ...headers, 'Content-Encoding': 'br' });
        res.end(brotliCompressSync('buffered-complete\n'));
      } else if (mode === 'truncated') {
        req.socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 20\r\nX-zP-BodY-StReAm: 0\r\nx-Zp-sTrEaM: 1\r\nConnection: close\r\n\r\nshort');
      } else {
        pendingResponses.set(mode, res);
        res.once('close', () => pendingResponses.delete(mode));
        res.writeHead(200, headers);
        res.write(mode === 'html'
          ? '<!doctype html><html><head><title>Reserved Header HTML</title></head><body><p id="reserved-first">html-first</p>'
          : '<!doctype html><p>raw-first</p>\n');
      }
      return;
    }
    if (url.pathname === '/next') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>E2E Next</title></head><body>
        <main><h1>E2E Next</h1><p id="ua"></p></main>
        <script>document.getElementById('ua').textContent = navigator.userAgent; window.__nextHref = location.href;</script>
      </body></html>`);
      return;
    }
    if (url.pathname === '/site-icon.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'));
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
    if (url.pathname === '/fragment-echo') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ href: url.searchParams.get('href'), userAgent: req.headers['user-agent'] }));
      return;
    }
    // O4: A-section escape probes executed in a REWRITTEN document — the
    // inline script exercises real rewriter + membrane semantics (evaluate()
    // would bypass the rewriter entirely).
    if (url.pathname === '/escape-probes') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>E2E Escape Probes</title><body><script>
        (async () => {
          const out = {};
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          out.virtual = location.href;
          out.varShadow = (function(){ var location = 'v-shadow'; return location; })();
          out.letShadow = (function(){ let location = 'l-shadow'; return location; })();
          out.fnDeclShadow = (function(){ function location(){ return 'f-shadow'; } return location(); })();
          try { out.thisComputed = (function(){ return this['location'] && this['location'].href; }).call(undefined); }
          catch (e) { out.thisComputed = 'throw:' + (e && e.name || e); }
          try { out.globalComputed = globalThis['loc' + 'ation'].href; } catch (e) { out.globalComputed = 'throw:' + (e && e.name || e); }
          try { out.fnThis = new Function('return this.location.href')(); } catch (e) { out.fnThis = 'throw:' + (e && e.name || e); }
          try { out.fnThisNull = new Function('return this.location.href').call(null); } catch (e) { out.fnThisNull = 'throw:' + (e && e.name || e); }
          try { out.evalHref = eval('location.href'); } catch (e) { out.evalHref = 'throw:' + (e && e.name || e); }
          try { out.evalArith = eval('40+2'); } catch (e) { out.evalArith = 'throw:' + (e && e.name || e); }
          try { const d = Object.getOwnPropertyDescriptor(window, 'location'); out.gopdHref = d && d.get ? d.get.call(window).href : 'no-getter'; }
          catch (e) { out.gopdHref = 'throw:' + (e && e.name || e); }
          try { const g = window.__lookupGetter__('location'); out.lookupGetter = g ? g.call(window).href : 'no-getter'; }
          catch (e) { out.lookupGetter = 'throw:' + (e && e.name || e); }
          try {
            const f = document.createElement('iframe');
            document.body.appendChild(f);
            out.contentDocLocation = f.contentDocument.location.href;
            f.remove();
          } catch (e) { out.contentDocLocation = 'throw:' + (e && e.name || e); }
          try { navigation.navigate('javascript:window.__navEsc=1'); out.navigationJs = 'returned'; }
          catch (e) { out.navigationJs = 'blocked:' + (e && e.name || e); }
          out.navEscaped = window.__navEsc === 1 ? 'escaped' : 'clean';
          out.navCurrentEntry = navigation && navigation.currentEntry ? navigation.currentEntry.url : 'no-entry';
          try {
            const c = open('javascript:window.opener.__openEsc=1', '_blank');
            if (!c) out.openJs = 'null-return';
            else { try { out.openJs = String(c.location && c.location.href); } catch (e2) { out.openJs = 'inner:' + (e2 && e2.name || e2); } try { c.close(); } catch {} }
          } catch (e) { out.openJs = 'throw:' + (e && e.name || e); }
          out.openEscaped = window.__openEsc === 1 ? 'escaped' : 'clean';
          try {
            const f2 = document.createElement('iframe');
            document.body.appendChild(f2);
            await new Promise(r => { f2.addEventListener('load', r); setTimeout(r, 3000); });
            try { out.framesIndex = frames[0].location.href; } catch (e) { out.framesIndex = 'throw:' + (e && e.name || e); }
            f2.remove();
          } catch (e) { out.framesIndex = 'outer:' + (e && e.name || e); }
          try {
            const m = document.createElement('meta');
            m.setAttribute('http-equiv', 'refresh');
            m.setAttribute('content', '0;url=javascript:window.__metaEsc=1');
            document.head.appendChild(m);
            await sleep(250);
            out.metaRefresh = window.__metaEsc === 1 ? 'escaped' : 'neutralized';
            m.remove();
          } catch (e) { out.metaRefresh = 'throw:' + (e && e.name || e); }
          out.diagnostics = Array.isArray(window.__zp_diagnostics) ? window.__zp_diagnostics.length : -1;
          window.__escapeProbes = out;
        })();
      </script></body>`);
      return;
    }
    if (url.pathname === '/compat-probes') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      // Same source served directly AND through the proxy — every probe must
      // produce identical results unless ERRATA documents a divergence.
      res.end(`<!doctype html><title>ZP Compat Probes</title><body><div id="compat-dom"><a id="ca" href="/x">x</a></div><script>
        (async () => {
          const out = {};
          const P = (k, f) => { try { out[k] = 'v:' + String(f()); } catch (e) { out[k] = 'e:' + (e && e.name || e); } };
          const PA = async (k, f) => { try { out[k] = 'v:' + String(await f()); } catch (e) { out[k] = 'e:' + (e && e.name || e); } };
          // B — formerly syntax-killed assignment-target / catch / label forms
          P('forOf', () => { var location; const s = []; for (location of [1, 2, 3]) s.push(location); return s.join(''); });
          P('forIn', () => { var location; const s = []; for (location in { a: 1, b: 2 }) s.push(location); return s.join(''); });
          P('arrayTarget', () => { var location; [location] = [42]; return location; });
          P('objTarget', () => { var location; ({ a: location } = { a: 7 }); return location; });
          P('nestedTarget', () => { var location; ({ a: { b: location } } = { a: { b: 9 } }); return location; });
          P('forOfArr', () => { var location; for ([location] of [[5]]) return location; });
          P('forOfObj', () => { var location; for ({ a: location } of [{ a: 6 }]) return location; });
          P('defaultTarget', () => { var location; ({ location = 3 } = {}); return location; });
          P('restTarget', () => { var location; var x; [x, ...location] = [1, 2, 3]; return location.join(''); });
          P('memberTarget', () => { var location = { x: 0 }; [location.x] = [8]; return location.x; });
          P('catchParam', () => { try { throw 11 } catch (location) { return location; } });
          P('switchTarget', () => { var location; switch (1) { case 1: [location] = [8]; break; } return location; });
          PA('forAwait', async () => { var location; const s = []; for await (location of [Promise.resolve(4), Promise.resolve(5)]) s.push(location); return s.join(''); });
          P('labelLoop', () => { var n = 0; outer: for (;;) { n++; if (n > 2) break outer; } return 'label:' + n; });
          // C — scope/binding semantics that must match native
          P('superProp', () => new (class extends Object { m() { return super.location; } })().m());
          P('optMemberNull', () => { var x = null; return x?.location; });
          P('optChainNull', () => { var x = null; return x?.location?.href; });
          P('optCallNull', () => { var x = null; return x?.location?.(); });
          P('plainOptCall', () => { var x = { m() { return 3; } }; return x?.m(); });
          P('computedKey', () => Object.keys({ [location]: 1 })[0] === String(location));
          P('nullishAssign', () => { var y; y ??= 'k'; location ??= 'z'; return y + '|' + location.hostname; });
          P('evalDirectLocal', function () { var y = 5; return eval('y'); });
          P('evalDirectGlobal', () => eval('1+1'));
          P('hoistedVar', function () { var r; try { r = String(location.href); } catch (e) { r = 'e:' + (e && e.name || e); } var location; return r; });
          P('deleteMember', () => { var o = { location: 1 }; delete o.location; return 'location' in o; });
          P('paramDefault', function () { function f(location = location) { return typeof location; } return f(); });
          P('newTargetFn', () => new Function('return new.target')());
          P('argumentsAlias', function () { return (function f(a) { arguments[0] = 2; return a; })(1); });
          // A5 — window object semantics (native: immutable prototype,
          // unforgeable location). The facade used to "succeed" here.
          P('setProtoReflect', () => Reflect.setPrototypeOf(window, {}));
          P('setProtoSame', () => Reflect.setPrototypeOf(window, Object.getPrototypeOf(window)));
          P('setProtoObject', () => { Object.setPrototypeOf(window, {}); return 'no-throw'; });
          P('protoIsWindow', () => Object.getPrototypeOf(window) === Window.prototype);
          P('defPropLocReflect', () => Reflect.defineProperty(window, 'location', { value: 1 }));
          P('defPropLocObject', () => { Object.defineProperty(window, 'location', { value: 1 }); return 'no-throw'; });
          P('preventExtWindow', () => Reflect.preventExtensions(window));
          // I — URL / navigation semantics
          P('locEqDocLoc', () => location === document.location);
          P('locHrefEqDocURL', () => location.href === document.URL);
          P('baseURI', () => document.baseURI);
          P('locHashWrite', () => { location.hash = 'ch1'; return location.hash; });
          P('urlCtorRel', () => new URL('p?q=1', location.href).href);
          P('urlCtorAbs', () => new URL('https://ex.com/a').host);
          P('urlStatics', () => (typeof URL.canParse) + '|' + (typeof URL.parse));
          P('winName', () => { window.name = 'nm1'; return window.name; });
          P('docCookie', () => { document.cookie = 'zpk=zpv'; return document.cookie.includes('zpk=zpv'); });
          P('anchorProp', () => { var a = document.getElementById('ca'); a.href = '/r?x=1'; return a.href; });
          P('anchorAttr', () => document.getElementById('ca').getAttribute('href'));
          P('anchorPing', () => { var a = document.createElement('a'); a.ping = 'http://p.example/x'; return a.ping; });
          P('domCount', () => document.getElementById('compat-dom').childElementCount);
          PA('fetchEcho', async () => (await fetch('/compat-echo?n=1')).status);
          // J — every URL-bearing attribute / CSS form must LOAD through the
          // proxy exactly when it loads natively. A missed rewrite is caught by
          // CSP (no escape) but the resource silently fails — that is the
          // divergence this measures. Evidence: resource-timing entries,
          // which the membrane reports under target URLs.
          {
            const O = location.origin;
            const img = k => O + '/image-probe.png?j=' + k;
            const host = document.createElement('div');
            host.style.cssText = 'position:absolute;left:0;top:0;width:40px;height:40px;overflow:hidden';
            document.body.appendChild(host);
            const add = h => { const d = document.createElement('div'); d.innerHTML = h; host.appendChild(d); return d.firstElementChild; };
            const vid = document.createElement('video'); vid.poster = img('poster'); host.appendChild(vid);
            const inp = document.createElement('input'); inp.type = 'image'; inp.src = img('inputsrc'); host.appendChild(inp);
            add('<table><tr><td background="' + img('tdbg') + '">x</td></tr></table>');
            const pre = document.createElement('link'); pre.rel = 'preload'; pre.as = 'image'; pre.imageSrcset = img('imagesrcset') + ' 1x'; document.head.appendChild(pre);
            add('<svg width="4" height="4"><image href="' + img('svgimage') + '" width="4" height="4"></image></svg>');
            const st = document.createElement('style');
            st.textContent = '#jset{width:4px;height:4px;background-image:image-set(url("' + img('imageset') + '") 1x)}'
              + '#jmask{width:4px;height:4px;-webkit-mask-image:url("' + img('mask') + '");mask-image:url("' + img('mask') + '")}'
              + '#jbefore::before{content:url("' + img('before') + '")}'
              + '#jshape{float:left;width:4px;height:4px;shape-outside:url("' + img('shape') + '")}';
            document.head.appendChild(st);
            add('<div id="jset"></div>'); add('<div id="jmask"></div>'); add('<div id="jbefore"></div>'); add('<div id="jshape"></div>');
            const imp = document.createElement('style'); imp.textContent = '@import url("' + O + '/site.css?j=import");'; document.head.appendChild(imp);
            const q = document.createElement('q'); q.cite = O + '/j/cite';
            const btn = document.createElement('button'); btn.formAction = O + '/j/fa';
            const area = document.createElement('area'); area.href = O + '/j/area';
            // Serialization keeps the author's literal URL text natively.
            P('serInner', () => { const d = document.createElement('div'); const a = document.createElement('a'); a.setAttribute('href', '/ser-a'); const i = document.createElement('img'); i.setAttribute('src', 'ser-i.png'); d.appendChild(a); d.appendChild(i); return d.innerHTML; });
            P('serOuterProp', () => { const a = document.createElement('a'); a.href = 'ser-p'; return a.outerHTML; });
            P('serParsed', () => { const d = document.createElement('div'); d.innerHTML = '<a href="/ser-x">x</a><img src="/image-probe.png?j=ser">'; return d.innerHTML; });
            P('serXML', () => { const d = document.createElement('div'); d.innerHTML = '<a href="/ser-y">y</a>'; return new XMLSerializer().serializeToString(d.firstChild); });
            P('serStyle', () => { const d = document.createElement('div'); d.setAttribute('style', 'background:url(/ser-s.png)'); return d.outerHTML; });
            P('jCiteProp', () => q.cite + '|' + q.getAttribute('cite'));
            P('jFormactionProp', () => btn.formAction + '|' + btn.getAttribute('formaction'));
            P('jAreaProp', () => area.href + '|' + area.getAttribute('href'));
            P('jPosterProp', () => vid.poster);
            P('jInputSrcProp', () => inp.src);
            // IDL write paths that skip the setAttribute hook (measured list).
            const bodyBgBefore = document.body.getAttribute('background');
            document.body.background = img('bodybg');
            P('jBodyBgProp', () => document.body.background);
            const svgNS = 'http://www.w3.org/2000/svg';
            const svg2 = document.createElementNS(svgNS, 'svg');
            const im2 = document.createElementNS(svgNS, 'image');
            im2.setAttribute('width', '4'); im2.setAttribute('height', '4');
            im2.href.baseVal = img('svgbaseval');
            svg2.appendChild(im2); host.appendChild(svg2);
            P('jSvgBaseVal', () => im2.href.baseVal + '|' + im2.href.animVal + '|' + im2.getAttribute('href'));
            P('jSvgHrefShape', () => (im2.href === im2.href) + '|' + (im2.href instanceof SVGAnimatedString) + '|' + Object.prototype.toString.call(im2.href));
            // Loads are judged server-side (the test compares the target's
            // request log for the native and proxied runs): resource-timing
            // entries exist even for CSP-blocked fetches, so they cannot tell.
            await new Promise(r => setTimeout(r, 1500));
            if (bodyBgBefore === null) document.body.removeAttribute('background'); else document.body.setAttribute('background', bodyBgBefore);
            host.remove(); pre.remove(); st.remove(); imp.remove();
          }
          // history.pushState last — it mutates the document URL
          P('historyPush', () => { history.pushState({}, '', '?pq=1'); return location.search; });
          window.__compatProbes = out;
        })();
      </script></body>`);
      return;
    }
    if (url.pathname === '/iframe-probes') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>ZP Iframe Probes</title><body><script>
        (async () => {
          const out = { messages: [] };
          window.addEventListener('message', ev => {
            try {
              const rec = { data: ev.data, origin: ev.origin };
              // ev.source 는 직렬화 불가라 열거 불가 프로퍼티로 보관한다.
              Object.defineProperty(rec, 'src', { value: ev.source, enumerable: false });
              out.messages.push(rec);
            } catch (e) { out.messages.push({ data: String(ev.data), origin: 'err' }); }
          });
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          const P = async (k, f) => { window.__probeStage = k; try { out[k] = 'v:' + String(await f()); } catch (e) { out[k] = 'e:' + (e && e.name || e); } };
          const mk = () => { const f = document.createElement('iframe'); document.body.appendChild(f); window.__lastFrameCW = f.contentWindow; return f; };
          const load = f => new Promise(r => { f.addEventListener('load', r, { once: true }); setTimeout(r, 5000); });
          // creation/insertion + ownerDocument + identity
          await P('createBlank', () => {
            const f = mk();
            return [!!f.contentWindow, !!f.contentDocument, f.ownerDocument === document].join(',');
          });
          await P('identityStable', () => {
            const f = mk();
            // 이전 프로브의 프레임이 body 에 남아 있으므로 frames[0] 가 f 가
            // 아닐 수 있다 — 컬렉션 멤버십으로 확인한다.
            let inFrames = false;
            for (let i = 0; i < window.frames.length; i++) if (window.frames[i] === f.contentWindow) inFrames = true;
            return [f.contentWindow === f.contentWindow, inFrames, f.contentWindow.parent === window].join(',');
          });
          // navigation through frame src — src is set to about:blank first,
          // then swapped to the share URL async, so the first load event is
          // about:blank. Poll for the real content instead.
          const waitText = async (f, want, ms) => {
            const end = Date.now() + (ms || 6000);
            while (Date.now() < end) {
              try { const t = (f.contentDocument && f.contentDocument.body && f.contentDocument.body.textContent || '').trim(); if (t.includes(want)) return t; } catch {}
              await sleep(120);
            }
            return (f.contentDocument && f.contentDocument.body && f.contentDocument.body.textContent || '').trim();
          };
          await P('srcLoad', async () => {
            const f = mk();
            f.src = '/frame-child';
            // textContent 는 script 요소의 리라이트된 소스까지 포함하므로
            // 본문 마커 존재 여부만 본다.
            return (await waitText(f, 'frame child')).includes('frame child');
          });
          await P('srcVirtual', async () => {
            const f = mk();
            f.src = '/frame-child';
            await waitText(f, 'frame child');
            return f.contentDocument.location.href;
          });
          // postMessage identity/origin (frame-child posts frame-child-ready)
          await P('postMessage', async () => {
            const f = mk();
            f.src = '/frame-child';
            await sleep(1500);
            // 이전 프레임들도 같은 메시지를 보내므로 발신 창으로 식별한다.
            const m = out.messages.find(m => m.data && m.data.type === 'frame-child-ready' && m.src === f.contentWindow);
            return m ? [m.data.href, m.data.topOrigin, m.origin, true].join('|') : 'no-message';
          });
          // srcdoc — injected prelude + rewritten script
          await P('srcdocLoad', async () => {
            const f = mk(); const done = load(f);
            f.srcdoc = '<p>inner sd</p>';
            await done;
            return (f.contentDocument.body.textContent || '').trim();
          });
          await P('srcdocScript', async () => {
            const f = mk(); const done = load(f);
            f.srcdoc = '<scr' + 'ipt>window.__sd = "sd-ran";</scr' + 'ipt>';
            await done;
            await sleep(300);
            return f.contentWindow.__sd;
          });
          await P('srcdocLocation', async () => {
            const f = mk(); const done = load(f);
            f.srcdoc = '<p>x</p>';
            await done;
            return f.contentDocument.location.href;
          });
          // blob: src must be blocked (fail-closed)
          await P('blobBlocked', async () => {
            const f = mk();
            f.src = URL.createObjectURL(new Blob(['<b>blobbed</b>'], { type: 'text/html' }));
            await sleep(700);
            const txt = f.contentDocument && f.contentDocument.body ? f.contentDocument.body.textContent : '';
            return txt.includes('blobbed') ? 'LOADED-BLOB' : 'contained:' + f.contentDocument.location.href;
          });
          // sandbox allow-scripts → opaque origin, script still runs
          await P('sandboxOpaque', async () => {
            const f = mk();
            f.setAttribute('sandbox', 'allow-scripts');
            f.srcdoc = '<scr' + 'ipt>parent.postMessage("sb-ran","*");</scr' + 'ipt>';
            let docAccess = 'ok';
            await sleep(1200);
            try { void f.contentDocument.body; } catch (e) { docAccess = 'e:' + (e && e.name || e); }
            const ran = out.messages.some(m => m.data === 'sb-ran');
            // sandbox opaque-origin 프레임은 네이티브에서 contentDocument 가
            // null 을 돌려준다 — 던지는 게 아니라 null 이 정답.
            const cd = (() => { try { return f.contentDocument === null ? 'null-doc' : (f.contentDocument ? 'doc' : String(f.contentDocument)); } catch (e) { return 'e:' + (e && e.name || e); } })();
            return [ran ? 'ran' : 'silent', cd].join('|');
          });
          // nested srcdoc → grandchild prelude. 임의 프로퍼티는 cross-window
          // 파사드가 삼키므로 마커는 postMessage 로 보낸다.
          window.__probeStage = 'nested';
          await P('nested', async () => {
            const f = mk(); const done = load(f);
            // 자식 srcdoc HTML 안에 script 종료 태그가 들어가면 파서가 조기
            // 종료하므로 손자 페이로드는 textarea 에 담아 .value 로 꺼낸다.
            const inner = '<scr' + 'ipt>top.postMessage("gc-ran","*");</scr' + 'ipt>';
            f.srcdoc = '<textarea id=t hidden>' + inner + '</textarea><scr' + 'ipt>try{var n=document.createElement("iframe");n.srcdoc=document.getElementById("t").value;document.body.appendChild(n);parent.postMessage("child-did-set","*")}catch(e){parent.postMessage("child-err:"+(e&&(e.name+":"+e.message)||e),"*")}</scr' + 'ipt>';
            await done;
            await sleep(1500);
            let nfo = '';
            try {
              const n = f.contentDocument && f.contentDocument.querySelector('iframe');
              nfo = n ? 'n-scripts=' + (n.contentDocument ? n.contentDocument.scripts.length : 'nodoc') : 'n-absent';
            } catch (e) { nfo = 'inspect-e:' + (e && e.name || e); }
            const childMsg = out.messages.map(m => m.data).find(d => typeof d === 'string' && (d === 'child-did-set' || d.startsWith('child-err')));
            return [out.messages.some(m => m.data === 'gc-ran') ? 'grandchild-ran' : 'no-mark', nfo, String(childMsg || 'no-child-msg')].join('|');
          });
          // insert→remove race then clean load
          await P('removeRace', async () => {
            const f = mk();
            f.src = '/frame-child';
            f.remove();
            await sleep(300);
            const f2 = mk();
            f2.src = '/frame-child';
            return (await waitText(f2, 'frame child')).includes('frame child');
          });
          window.__probeStage = 'done';
          window.__iframeProbes = out;
        })().catch(e => { window.__iframeProbes = { __fatal: String(e && (e.stack || e)), __stage: window.__probeStage }; });
      </script></body>`);
      return;
    }
    if (url.pathname === '/compat-echo') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('echo');
      return;
    }
    // O7: worker suite — dedicated/module/shared × fetch/importScripts/
    // timers/eval(blocked)/location/storage isolation. The page collects
    // each worker's postMessage into window.__workerProbes.
    if (url.pathname === '/worker-echo') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('worker-echo');
      return;
    }
    if (url.pathname === '/worker-imported.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`self.__imported = 'imp-ok';`);
      return;
    }
    if (url.pathname === '/probe-module-dep.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`export const marker = 'dep-ok';`);
      return;
    }
    if (url.pathname === '/probe-worker.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`(async () => {
        const out = {};
        const P = async (k, f) => { try { out[k] = 'v:' + String(await f()); } catch (e) { out[k] = 'e:' + (e && e.name || e); } };
        await P('href', () => location.href);
        await P('locProps', () => [location.protocol, location.host, location.pathname].join('|'));
        await P('locMethods', () => [typeof location.assign, typeof location.reload, typeof location.toString].join(','));
        await P('ua', () => navigator.userAgent);
        await P('platform', () => navigator.platform);
        await P('fetchEcho', async () => (await fetch('/worker-echo?w=d')).status);
        await P('xhrShim', async () => {
          const x = new XMLHttpRequest();
          return await new Promise(res => { x.onload = () => res(x.status); x.onerror = () => res('xhr-err'); x.open('GET', '/worker-echo?w=x'); x.send(); });
        });
        await P('xhrSync', () => { const x = new XMLHttpRequest(); try { x.open('GET', '/worker-echo?w=sync', false); x.send(); return 'status:' + x.status + '|' + String(x.responseText).slice(0, 20); } catch (e) { return 'e:' + (e && e.name || e); } });
        await P('wsCtor', () => { try { new WebSocket('ws://nonexistent.invalid/'); return 'constructed'; } catch (e) { return 'e:' + (e && e.name || e); } });
        // W4: 페이지 중계 SW 스트림 — 실제 WS 라운드트립.
        await P('wsRoundtrip', () => new Promise(res => {
          try {
            const ws = new WebSocket('/ws?w=worker');
            const to = setTimeout(() => { try { ws.close(); } catch (_) {} res('timeout'); }, 6000);
            ws.onopen = () => { try { ws.send('ping'); } catch (e) { clearTimeout(to); res('send-e:' + (e && e.name || e)); } };
            ws.onmessage = ev => { clearTimeout(to); try { ws.close(); } catch (_) {} res('msg:' + ev.data); };
            ws.onerror = () => { clearTimeout(to); res('err'); };
          } catch (e) { res('e:' + (e && e.name || e)); }
        }));
        await P('rtcCtor', () => { try { new RTCPeerConnection(); return 'constructed'; } catch (e) { return 'e:' + (e && e.name || e); } });
        await P('wtCtor', () => { try { const w = new WebTransport('https://nonexistent.invalid/'); return 'constructed:' + String(w.readyState); } catch (e) { return 'e:' + (e && e.name || e); } });
        // WorkerEventSource — 프록시 fetch 경유 SSE 가 실제로 이벤트를 받는가.
        await P('esRoundtrip', () => new Promise(res => {
          try {
            const es = new EventSource('/sse?w=es');
            const to = setTimeout(() => { try { es.close(); } catch (_) {} res('timeout'); }, 4000);
            es.onmessage = ev => { clearTimeout(to); es.close(); res('msg:' + ev.data); };
            es.onerror = () => { clearTimeout(to); es.close(); res('err'); };
          } catch (e) { res('e:' + (e && e.name || e)); }
        }));
        await P('evalCode', () => eval('1+1'));
        await P('funcCtor', () => new Function('return 7')());
        await P('timerFn', () => new Promise(r => setTimeout(() => r('fired'), 10)));
        await P('timerStr', () => new Promise(r => {
          try { setTimeout('self.__st=7', 10); setTimeout(() => r(typeof self.__st === 'undefined' ? 'not-ran' : 'ran'), 120); }
          catch (e) { r('e:' + (e && e.name || e)); }
        }));
        await P('importScriptsOK', () => { importScripts('/worker-imported.js'); return self.__imported; });
        await P('importScriptsData', () => { importScripts('data:text/javascript,self.__di=1'); return 'imported'; });
        await P('importScriptsBlob', () => { const u = URL.createObjectURL(new Blob(['self.__bi=1'], { type: 'text/javascript' })); importScripts(u); return 'imported'; });
        await P('idb', () => typeof indexedDB);
        await P('idbRoundtrip', async () => {
          const db = await new Promise((res, rej) => { const r = indexedDB.open('wprobe'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
          const dbs = indexedDB.databases ? await indexedDB.databases() : [];
          db.close();
          return dbs.some(d => d.name === 'wprobe') ? 'listed-virtual' : 'list=' + JSON.stringify(dbs.map(d => d.name));
        });
        await P('cachesRoundtrip', async () => {
          if (typeof caches === 'undefined') return 'no-caches';
          const c = await caches.open('wc');
          const keys = await caches.keys();
          await caches.delete('wc');
          return c ? 'open+keys=' + keys.length : 'no';
        });
        await P('cookieStore', () => typeof cookieStore);
        await P('errorStack', () => { try { throw new Error('x'); } catch (e) { return /proxy\\.localhost|zp\\//i.test(e.stack || '') ? 'LEAK' : 'clean'; } });
        // ── W8–W12: WorkerGlobalScope 가상 표면 ──
        await P('origin', () => self.origin);
        await P('secureCtx', () => String(self.isSecureContext));
        await P('urlResolve', () => new URL('/w-abs', location.href).href);
        await P('webkitURLAlias', () => typeof webkitURL === 'function' ? new webkitURL('/wk', location.href).href : 'absent:' + typeof webkitURL);
        await P('webkitIDB', () => typeof webkitIndexedDB !== 'undefined' && webkitIndexedDB === indexedDB ? 'alias' : 'not-alias:' + typeof webkitIndexedDB);
        await P('bcName', () => { const c = new BroadcastChannel('wp1'); const n = c.name; c.close(); return n; });
        await P('opfsName', async () => {
          if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') return 'absent';
          const d = await navigator.storage.getDirectory();
          return 'name:' + d.name;
        });
        await P('webkitFS', () => {
          const t = typeof self.webkitRequestFileSystem;
          if (t !== 'function') return t;
          try { self.webkitRequestFileSystem(0, 0, () => {}, () => {}); return 'fn:ran'; }
          catch (e) { return 'fn:e:' + (e && e.name || e); }
        });
        await P('sharedStorageW', () => typeof self.sharedStorage);
        postMessage(out);
      })().catch(e => postMessage({ __fatal: String(e && (e.stack || e)) }));`);
      return;
    }
    if (url.pathname === '/probe-module-worker.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`import { marker } from './probe-module-dep.js';
      (async () => {
        const out = {};
        const P = async (k, f) => { try { out[k] = 'v:' + String(await f()); } catch (e) { out[k] = 'e:' + (e && e.name || e); } };
        await P('href', () => location.href);
        await P('importMetaUrl', () => import.meta.url);
        await P('staticImport', () => marker);
        await P('fetchEcho', async () => (await fetch('/worker-echo?w=m')).status);
        await P('evalCode', () => eval('1'));
        await P('funcCtor', () => new Function('return 1')());
        // 모듈 워커 importScripts — 네이티브는 부재(TypeError), 우리는 차단 스텁.
        await P('importScriptsStub', () => {
          if (typeof importScripts !== 'function') return 'absent';
          try { importScripts('/worker-imported.js'); return 'imported'; } catch (e) { return 'e:' + (e && e.name || e); }
        });
        postMessage(out);
      })().catch(e => postMessage({ __fatal: String(e && (e.stack || e)) }));`);
      return;
    }
    if (url.pathname === '/probe-shared-worker.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`self.onconnect = ev => {
        const port = ev.ports[0];
        const out = {};
        try { out.name = String(self.name); out.href = location.href; out.ua = navigator.userAgent; }
        catch (e) { out.err = String(e && (e.name + ':' + e.message) || e); }
        port.postMessage(out);
      };`);
      return;
    }
    if (url.pathname === '/worker-probes') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>ZP Worker Probes</title><body><script>
        (async () => {
          const out = {};
          const collect = mkw => new Promise(r => {
            let w;
            try { w = mkw(); } catch (e) { r({ __ctor: (e && e.name || '') + ':' + (e && e.message || '') }); return; }
            const t = setTimeout(() => r({ __timeout: 1 }), 10000);
            w.onmessage = ev => { clearTimeout(t); r(ev.data); };
            // module 워커의 그래프 로드 실패는 빈 message 의 error 이벤트로만
            // 표면한다 — 부팅 체인이 진단 postMessage 를 먼저 보낼 수 있도록
            // 에러 해결을 조금 지연시킨다.
            w.onerror = ev => { const em = String(ev && ev.message || 'err'); setTimeout(() => { clearTimeout(t); r({ __error: em }); }, 600); };
          });
          out.dedicated = await collect(() => new Worker('/probe-worker.js'));
          out.module = await collect(() => new Worker('/probe-module-worker.js', { type: 'module' }));
          out.shared = await new Promise(r => {
            try {
              const sw = new SharedWorker('/probe-shared-worker.js', { name: 'swprobe' });
              const t = setTimeout(() => r({ __timeout: 1 }), 10000);
              sw.port.onmessage = ev => { clearTimeout(t); r(ev.data); };
              sw.port.start();
            } catch (e) { r({ __error: (e && e.name || '') + ':' + (e && e.message || '') }); }
          });
          window.__workerProbes = out;
        })().catch(e => { window.__workerProbes = { __fatal: String(e && (e.stack || e)) }; });
      </script></body>`);
      return;
    }
    if (url.pathname === '/csp-probes') {
      // O8: CSP suite — §K two-sided matrix. Allowed resources must load,
      // missed/intentional blocks must fire securitypolicyviolation (and land
      // at /zp/api/csp-report). The inline <script type=module> marker is the
      // top-priority check: it only executes if `blob:` is in script-src
      // (the __ZP_EXEC_INLINE_MODULE path) — without it every inline module
      // dies silently at CSP.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>ZP CSP Probes</title><body><script type="module">
        // 클래식 프로브가 먼저 객체를 만들 수 있다 — 덮어쓰면 그쪽 수집이 날아가므로 머지.
        (window.__cspProbes = window.__cspProbes || { violations: [] }).inlineModule = 'ran';
      <\/script><script>
        (async () => {
          const out = window.__cspProbes = window.__cspProbes || { violations: [] };
          const violations = out.violations;
          document.addEventListener('securitypolicyviolation', e => {
            violations.push(e.effectiveDirective + '|' + String(e.blockedURI).slice(0, 60));
          });
          const P = async (k, fn) => { try { out[k] = await fn(); } catch (e) { out[k] = 'e:' + (e && (e.name || e.message) || e); } };
          const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
          const waitFor = (re, ms) => new Promise(r => setTimeout(() => {
            const hit = violations.find(v => re.test(v));
            r(hit ? 'spv:' + hit.split('|')[0] : 'no-spv');
          }, ms));

          // ── connect-src blob:/data: — CSP 통과 후 fetch 심이 실제 처리 ──
          await P('fetchData', async () => { const r = await fetch('data:text/plain,hi'); return r.status + ':' + (await r.text()); });
          await P('fetchBlob', async () => { const r = await fetch(URL.createObjectURL(new Blob(['bl']))); return r.status + ':' + (await r.text()); });

          // ── img/style/font/media-src — data:/blob: 허용 (로드 시도 자체가 통과) ──
          await P('imgData', () => new Promise(r => {
            const i = new Image(); const t = setTimeout(() => r('timeout'), 3000);
            i.onload = () => { clearTimeout(t); r('loaded'); };
            i.onerror = () => { clearTimeout(t); r('load-err'); };
            i.src = PNG;
          }));
          await P('styleData', () => new Promise(r => {
            const l = document.createElement('link'); const t = setTimeout(() => r('timeout'), 3000);
            l.rel = 'stylesheet'; l.onload = () => { clearTimeout(t); r('loaded'); };
            l.onerror = () => { clearTimeout(t); r('err'); };
            l.href = 'data:text/css,body%7B%7D'; document.head.appendChild(l);
          }));
          // 폰트/미디어는 디코드 실패가 정상 — CSP 통과 여부는 SPV 부재로 판정
          await P('fontData', async () => {
            try { const f = new FontFace('zpf', 'url(data:font/woff2;base64,AAAA)'); await f.load(); return 'loaded'; }
            catch (e) { return 'font-err:' + (e && e.name || e); }
          });
          await P('mediaData', () => new Promise(r => {
            const v = document.createElement('video'); const t = setTimeout(() => r('settled'), 1500);
            v.onerror = () => { clearTimeout(t); r('media-err'); };
            v.onloadeddata = () => { clearTimeout(t); r('loaded'); };
            v.src = 'data:video/mp4;base64,AAAA';
          }));

          // ── 차단 측 — 각 디렉티브가 SPV 를 발사해야 한다 ──
          await P('objectBlocked', () => {
            const o = document.createElement('object');
            o.data = '/csp-payload'; document.body.appendChild(o);
            return waitFor(/^object-src/, 1200);
          });
          await P('baseBlocked', () => {
            const b = document.createElement('base'); b.href = 'https://evil.invalid/';
            document.head.appendChild(b); return waitFor(/^base-uri/, 800);
          });
          await P('prefetchBlocked', () => {
            const l = document.createElement('link'); l.rel = 'prefetch'; l.href = '/x';
            document.head.appendChild(l); return waitFor(/prefetch-src|default-src/, 800);
          });
          await P('manifestBlocked', () => {
            const l = document.createElement('link'); l.rel = 'manifest'; l.href = 'data:application/json,%7B%7D';
            document.head.appendChild(l); return waitFor(/manifest-src/, 800);
          });

          // ── CSP 는 허용하지만 속성 정책이 봉인하는 경로 — divergence 핀 ──
          await P('frameDataSrc', () => {
            const f = document.createElement('iframe');
            try { f.src = 'data:text/html,<b>x</b>'; document.body.appendChild(f); return 'set:' + String(f.src).slice(0, 40); }
            catch (e) { return 'blocked:' + (e && e.name || e); }
          });
          await P('workerBlob', () => {
            try {
              const w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })));
              return 'created';
            } catch (e) { return 'blocked:' + (e && e.name || e); }
          });

          // ── 'unsafe-inline'/'unsafe-eval' 정면 경로 ──
          await P('inlineHandler', () => new Promise(r => {
            const b = document.createElement('button');
            b.setAttribute('onclick', 'window.__cspHandlerRan = 1');
            document.body.appendChild(b); b.click();
            setTimeout(() => r(window.__cspHandlerRan ? 'ran' : 'silent'), 400);
          }));
          await P('evalPath', () => { try { return 'v:' + eval('40+2'); } catch (e) { return 'e:' + (e && e.name || e); } });

          // ── CSP <meta> 주입 — 교집합 적용: 배관은 유지, 엄격화는 존중 ──
          await P('metaNeutralized', () => {
            const m = document.createElement('meta');
            m.setAttribute('http-equiv', 'Content-Security-Policy');
            m.setAttribute('content', "default-src 'none'");
            document.head.appendChild(m);
            return new Promise(r => {
              const i = new Image(); const t = setTimeout(() => r('timeout'), 3000);
              i.onload = () => { clearTimeout(t); r('img-loaded-after-meta'); };
              i.onerror = () => { clearTimeout(t); r('img-blocked-after-meta'); };
              i.src = PNG;
            });
          });
          // E2: 타깃이 더 엄격한 리소스 지시어를 선언하면 그건 지켜진다 —
          // img-src 'none' 은 배관을 안 건드리므로 verbatim 적용.
          // (마지막에 놓는다 — meta CSP 는 지워지지 않고 이후 로드를 계속 묶는다.)
          await P('metaStricter', () => {
            const m = document.createElement('meta');
            m.setAttribute('http-equiv', 'Content-Security-Policy');
            m.setAttribute('content', "img-src 'none'");
            document.head.appendChild(m);
            return new Promise(r => {
              const i = new Image(); const t = setTimeout(() => r('timeout'), 3000);
              i.onload = () => { clearTimeout(t); r('img-loaded'); };
              i.onerror = () => { clearTimeout(t); r('img-blocked'); };
              i.src = PNG;
            });
          });
          out.done = true;
        })().catch(e => { (window.__cspProbes = window.__cspProbes || { violations: [] }).__fatal = String(e && (e.stack || e)); });
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/dyn-mod.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('export const m = 1; export const meta = import.meta.url;');
      return;
    }
    if (/^\/lex-mod-[abc]\.js$/.test(url.pathname)) {
      // import/export 없는 모듈 — GitHub high-contrast-cookie /
      // global-banner-disable 의 모양. 셋 다 top-level `let e` 를 갖는다.
      const tag = url.pathname.charAt(9);
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`let e = '${tag}'; window.__lexMod${tag.toUpperCase()} = e;`);
      return;
    }
    if (url.pathname === '/dyn-probes') {
      // O9: dynamic code suite — §E eval/Function/timers/event handlers/DOM
      // insertion paths. Three assertion kinds per case: success (runs through
      // the mediated path), exception (correct error surfaces), source-leak
      // (no __zp_* / /zp/ internals visible to page JS).
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>ZP Dynamic Probes</title><body>
      <button id="staticHandler" onclick="window.__staticHandlerRan = 1"></button>
      <script type="module" src="/lex-mod-a.js"><\/script>
      <script type="module" src="/lex-mod-b.js"><\/script>
      <script>
        // document.write during parse — inserts into the live pipeline.
        document.write('<span id="dw">wrote</span>');
      <\/script>
      <script>
        (async () => {
          const out = window.__dynProbes = {};
          const P = async (k, fn) => { try { out[k] = await fn(); } catch (e) { out[k] = 'e:' + (e && (e.name || e.message) || e); } };
          const sleep = ms => new Promise(r => setTimeout(r, ms));

          // ── eval — 성공/스코프/예외/완료값 ──
          await P('evalBasic', () => 'v:' + eval('1+1'));
          await P('evalLocation', () => 'v:' + eval('location.href'));
          await P('evalVarVisible', () => {
            eval('var __evv = 42');
            return 'v:' + (typeof __evv !== 'undefined' ? __evv : 'undefined');
          });
          await P('evalStrict', () => 'v:' + eval('"use strict"; location.origin'));
          await P('evalSyntaxError', () => { try { eval('@@@not code@@@'); return 'no-throw'; } catch (e) { return 'threw:' + (e && e.name || e); } });
          await P('evalNonString', () => 'v:' + JSON.stringify([eval(123), eval(undefined), eval(null)]));
          await P('evalIndirect', () => 'v:' + (0, eval)('location.origin'));
          await P('evalCall', () => { try { return 'v:' + eval.call(null, '2+3'); } catch (e) { return 'threw:' + (e && e.name || e); } });
          await P('evalAsCtor', () => { try { return 'v:' + (new eval()); } catch (e) { return 'threw:' + (e && e.name || e); } });
          await P('evalTagged', () => 'v:' + typeof eval\`x\`);

          // ── Function — 파라미터 파싱/this/new.target/중첩 동적코드 ──
          await P('fnBasic', () => 'v:' + new Function('return 40+2')());
          await P('fnParams', () => 'v:' + new Function('a', 'b', 'return a*b')(6, 7));
          await P('fnDefaultParam', () => 'v:' + new Function('a = 5', 'return a')());
          await P('fnCommentParam', () => 'v:' + new Function('/*c*/x', 'return x')(9));
          await P('fnThis', () => { const t = new Function('return this')(); return 'v:' + (t && t.location && t.location.href ? t.location.href.slice(0, 30) : typeof t); });
          await P('fnThisIsWindow', () => { const t = new Function('return this')(); return 'v:' + (t === window); });
          await P('fnLocation', () => 'v:' + new Function('return location.origin')());
          await P('fnWith', () => { try { return 'v:' + new Function('with({a:1}) return a')(); } catch (e) { return 'threw:' + (e && e.name || e); } });
          await P('fnNestedEval', () => 'v:' + new Function('return eval("3*3")')());
          await P('asyncFnCtor', () => new Function('return 1').constructor === Function ? 'v:ctor-same' : 'v:ctor-diff');
          await P('asyncFn', async () => 'v:' + await (Object.getPrototypeOf(async function(){}).constructor)('return 8')());

          // ── string timers — 실행/가상 스코프/예외 표면 ──
          await P('timerString', () => new Promise(r => { setTimeout('window.__tStr = 7', 0); setTimeout(() => r('v:' + window.__tStr), 300); }));
          await P('timerVirtual', () => new Promise(r => { setTimeout('window.__tVirt = location.origin', 0); setTimeout(() => r('v:' + window.__tVirt), 300); }));
          await P('timerThis', () => new Promise(r => { try { setTimeout('window.__tThis = String(this["location"] && this["location"].href).slice(0,30)', 0); } catch (e) { return r('ctor:' + (e && e.name || e)); } setTimeout(() => r('v:' + String(window.__tThis)), 400); }));
          await P('timerBad', () => new Promise(r => {
            const errs = [];
            window.addEventListener('error', h => errs.push(String(h.message || h.type)), { once: true });
            setTimeout('@@@timer bad@@@', 0);
            setTimeout(() => r(errs.length ? 'v:error-surfaced' : 'v:silent'), 400);
          }));
          await P('intervalString', () => new Promise(r => {
            const id = setInterval('window.__tInt = (window.__tInt || 0) + 1', 20);
            setTimeout(() => { clearInterval(id); r('v:' + window.__tInt); }, 300);
          }));

          // ── event handlers — 정적 속성/프로퍼티 문자열/addEventListener ──
          await P('handlerStatic', () => { document.getElementById('staticHandler').click(); return 'v:' + (window.__staticHandlerRan || 'silent'); });
          await P('handlerPropString', () => {
            const b = document.createElement('button');
            b.onclick = 'window.__propStr = 9';
            document.body.appendChild(b); b.click();
            return 'v:' + (window.__propStr || 'silent');
          });
          await P('handlerPropFn', () => {
            const b = document.createElement('button');
            b.onclick = function() { window.__propFn = location.origin; };
            document.body.appendChild(b); b.click();
            return 'v:' + (window.__propFn || 'silent');
          });

          // ── DOM 삽입 — transformHTML 경로로 들어온 스크립트 실행 ──
          await P('innerHTMLScript', () => {
            const d = document.createElement('div');
            d.innerHTML = '<scr' + 'ipt>window.__ihScr = 5</scr' + 'ipt>';
            document.body.appendChild(d);
            return 'v:' + (window.__ihScr || 'silent');
          });
          await P('adjacentScript', () => {
            const d = document.createElement('div');
            document.body.appendChild(d);
            d.insertAdjacentHTML('beforeend', '<scr' + 'ipt>window.__adjScr = 6</scr' + 'ipt>');
            return 'v:' + (window.__adjScr || 'silent');
          });
          await P('domParserScript', () => {
            const doc = new DOMParser().parseFromString('<scr' + 'ipt>window.__dpScr = 1</scr' + 'ipt><b>x</b>', 'text/html');
            document.body.appendChild(doc.body.firstElementChild || doc.body);
            return 'v:' + (window.__dpScr || 'silent');
          });
          await P('docWrite', () => 'v:' + (document.getElementById('dw') ? 'wrote' : 'missing'));

          // ── import() — 경로별 성공/차단 ──
          await P('importHttp', async () => { const m = await import('/dyn-mod.js'); return 'v:' + m.m + '|' + m.meta; });
          // D2/D3: plain page code — the rewriter turns these into
          // import(__zp_module_url(…)). They used to call that helper by hand,
          // which made the probe proxy-only (ReferenceError natively) and hid
          // it from the direct-vs-proxy differential.
          await P('importData', async () => { try { const m = await import('data:text/javascript,export%20default%201'); return 'v:' + (m && m.default); } catch (e) { return 'threw:' + (e && e.name || e); } });
          await P('importBlob', async () => { try { const u = URL.createObjectURL(new Blob(['export default 3'], { type: 'text/javascript' })); const m = await import(u); return 'v:' + (m && m.default); } catch (e) { return 'threw:' + (e && e.name || e); } });

          // ── 소스 누출 — __zp_*/프록시 경로가 페이지 JS 에 보이면 안 된다 ──
          // 주의: 픽스처 안 regex 리터럴의 backslash-slash 는 바깥 템플릿
          // 리터럴이 한 번 풀어 regex 를 조기 종료시킨다 — substring 검사로 쓴다.
          const leaked = s => s.includes('__zp_') || s.includes('/zp/api') || s.includes('proxy.localhost') || s.includes('worker-script');
          await P('leakFnToString', () => leaked(new Function('return 1').toString()) ? 'LEAK' : 'v:clean');
          await P('leakCallee', () => leaked((function(){ return arguments.callee.toString(); })()) ? 'LEAK' : 'v:clean');
          await P('leakDynStack', () => {
            let s = '';
            try { eval('throw new Error("stk")'); } catch (e) { s = String(e.stack || ''); }
            return leaked(s) ? 'LEAK:' + s.slice(0, 80) : 'v:clean';
          });
          await P('leakFnStack', () => {
            let s = '';
            try { new Function('throw new Error("fstk")')(); } catch (e) { s = String(e.stack || ''); }
            return leaked(s) ? 'LEAK:' + s.slice(0, 80) : 'v:clean';
          });

          // ── ERRATA §E parity found by the native differential (2026-09-29) ──
          // A runtime throw inside indirect eval must not re-run the code
          // (an old Function-body fallback executed it twice).
          await P('evalRuntimeOnce', () => { window.__ero = 0; try { (0, eval)('window.__ero++; throw new Error("x")'); } catch (e) {} return 'v:' + window.__ero; });
          await P('evalReturnStmt', () => { try { return 'v:' + (0, eval)('return 1'); } catch (e) { return 'threw:' + (e && e.name || e); } });
          await P('evalObjectArg', () => { window.__ets = 0; const o = { toString() { window.__ets = 1; return '2+2'; } }; const r = (0, eval)(o); return 'v:' + (r === o) + '|' + window.__ets; });
          await P('evalEmpty', () => 'v:' + typeof eval('') + '|' + typeof (0, eval)(''));
          await P('evalSyntaxInstance', () => { try { eval('@@@'); return 'no-throw'; } catch (e) { return 'v:' + (e instanceof SyntaxError); } });
          await P('fnSyntaxError', () => { try { new Function('if('); return 'no-throw'; } catch (e) { return 'threw:' + (e && e.name || e) + '|' + (e instanceof SyntaxError); } });
          await P('fnParamSyntax', () => { try { new Function('a b', 'return 1'); return 'no-throw'; } catch (e) { return 'threw:' + (e && e.name || e); } });
          await P('winHandlerString', () => { window.onmessageerror = 'window.__whs = 1'; const r = 'v:' + window.onmessageerror; window.onmessageerror = null; return r; });

          // ── 모듈 kind — import/export 가 없어도 모듈이다 (2026-09-29, GitHub) ──
          // 정적 모듈 둘이 각자 top-level let e 를 갖는다. 모듈 스코프는 따로라
          // 네이티브에선 둘 다 돈다. classic 으로 리라이트되면 R1 레지스트리가
          // 둘째를 "already declared" 로 죽였다.
          await P('staticModuleLex', async () => { for (let i = 0; i < 60 && !(window.__lexModA && window.__lexModB); i++) await sleep(50); return 'v:' + window.__lexModA + '|' + window.__lexModB; });
          // src 를 type 보다 먼저 넣는 순서 — kind 는 삽입 시점의 type 이 정한다.
          // 뒤의 classic let e 는 모듈이 레지스트리에 잘못 올라갔을 때만 충돌한다.
          await P('dynModuleTypeAfterSrc', async () => {
            const s = document.createElement('script');
            Object.assign(s, { src: '/lex-mod-c.js', type: 'module' });
            await new Promise(res => { s.onload = s.onerror = res; document.head.appendChild(s); });
            const k = document.createElement('script');
            k.textContent = "let e = 'k'; window.__lexClassicE = e;";
            document.head.appendChild(k);
            return 'v:' + window.__lexModC + '|' + window.__lexClassicE;
          });
          // blob 워커 소스는 생성 시점에 확정된다 — 곧바로 해제해도 돈다
          // (CNN Permutive SDK 의 순서). 워커 쪽 헬퍼(Object.keys)도 함께 본다.
          await P('blobWorkerRevoked', () => new Promise((res) => {
            const u = URL.createObjectURL(new Blob(['postMessage(self.location.protocol + Object.keys({ a: 1 }).join())'], { type: 'text/javascript' }));
            const w = new Worker(u);
            URL.revokeObjectURL(u);
            const t = setTimeout(() => res('timeout'), 8000);
            w.onmessage = (e) => { clearTimeout(t); w.terminate(); res('v:' + e.data); };
            w.onerror = (e) => { clearTimeout(t); e.preventDefault(); res('error:' + e.message); };
          }));
          // 워커에서 self 로 부른 네이티브 메서드 — 수신자가 스코프 프록시면
          // Illegal invocation 이었다(CNN Permutive 워커의 self.addEventListener).
          // 래퍼 Function.prototype 이 빈 객체라 toString 판별도 어긋났었다.
          await P('workerSelfMethods', () => new Promise((res) => {
            const src = "self.addEventListener('message', function () { postMessage([self.atob('YQ=='), typeof self.setTimeout(function () {}, 1), self.addEventListener === self.addEventListener, Function.prototype.toString.call(self.atob).indexOf('native code') > 0].join()); });";
            const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
            const t = setTimeout(() => res('timeout'), 8000);
            w.onmessage = (e) => { clearTimeout(t); w.terminate(); res('v:' + e.data); };
            w.onerror = (e) => { clearTimeout(t); e.preventDefault(); res('error:' + e.message); };
            w.postMessage(1);
          }));
          out.done = true;
        })().catch(e => { (window.__dynProbes = window.__dynProbes || {}).__fatal = String(e && (e.stack || e)); });
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/perf-probes') {
      // O10: perf suite — 10M 루프캡 경계, async-poll 수명, bulk DOM,
      // iframe 수×로드시간. 시간은 계측해서 기록하고 단언은 상한만 잡는다
      // (머신 분산 방어).
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Perf Probes</title><body><script>
        (async () => {
          const out = window.__perfProbes = {};
          const P = async (k, fn) => { try { out[k] = 'v:' + (await fn()); } catch (e) { out[k] = 'threw:' + (e && e.name || e); } };

          // ── 10M 루프캡 경계 ──
          // 미만 루프는 캡이 발화하지 않고 정상 완료돼야 한다.
          await P('underCap', () => {
            let i = 0;
            while (true) { i++; if (i >= 5000000) break; }
            return i;
          });
          // 초과 루프는 hang 이 아니라 캡(10M)에서 종료돼야 한다.
          await P('cappedWhile', () => {
            let j = 0;
            while (true) { j++; }
            return j;
          });
          // ERRATA §L: 'for(let i=0;;i++)' uncapped 예측 — 12M 에 break 를
          // 걸어 두면 capped=10M, uncapped=12000001 로 판별된다.
          await P('cappedFor', () => {
            let m = 0;
            for (m = 0;; m++) { if (m > 12000000) break; }
            return m;
          });
          await P('cappedDo', () => {
            let d = 0;
            do { d++; } while (true);
            return d;
          });
          // negative control — 일반 루프는 카운터가 끼면 안 된다.
          await P('normalLoop', () => {
            let n = 0;
            for (n = 0; n < 3; n++) {}
            return n;
          });
          // 중첩 루프 — 내부 캡이 외부 카운터와 충돌하면 안 된다.
          await P('nestedLoops', () => {
            let outer = 0, inner = 0;
            while (true) { outer++; if (outer >= 100) break; while (true) { inner++; if (inner >= outer * 100) break; } }
            return outer + '|' + inner;
          });

          // ── async-poll 수명 ──
          // while(true){await;break} 는 캡 prefix 가 붙어도 break 가 살아야
          // 하고, 종료 후 폴러가 정말 죽어야 한다.
          await P('asyncPollBreak', async () => {
            let ap = 0;
            while (true) {
              ap++;
              await new Promise(r => setTimeout(r, 1));
              if (ap >= 20) break;
            }
            return ap;
          });
          await P('asyncPollFlag', async () => {
            let polls = 0, flag = false;
            setTimeout(() => { flag = true; }, 30);
            while (!flag) {
              polls++;
              await new Promise(r => setTimeout(r, 1));
              if (polls > 5000) break;
            }
            const atExit = polls;
            await new Promise(r => setTimeout(r, 20));
            return flag + '|' + (atExit === polls) + '|' + (polls <= 5000);
          });

          // ── bulk DOM 삽입 ──
          await P('bulkDom', () => {
            const t = performance.now();
            const frag = document.createDocumentFragment();
            for (let i = 0; i < 5000; i++) {
              const d = document.createElement('div');
              d.textContent = 'x' + i;
              frag.appendChild(d);
            }
            document.body.appendChild(frag);
            const ms = performance.now() - t;
            return document.querySelectorAll('div').length + '|' + Math.round(ms);
          });

          // ── iframe 수 × 로드시간 ──
          await P('iframes', async () => {
            const N = 5;
            const t = performance.now();
            const results = await Promise.all([...Array(N)].map((_, idx) => new Promise(res => {
              const f = document.createElement('iframe');
              f.srcdoc = '<p>f' + idx + '</p>';
              document.body.appendChild(f);
              const deadline = setTimeout(() => res('timeout'), 15000);
              (function poll() {
                try {
                  if (f.contentDocument && f.contentDocument.body && f.contentDocument.body.textContent.includes('f' + idx)) {
                    clearTimeout(deadline); res('loaded'); return;
                  }
                } catch {}
                setTimeout(poll, 20);
              })();
            })));
            const ms = performance.now() - t;
            return results.join(',') + '|' + Math.round(ms);
          });

          // ── T5-3: 멤브레인 hot-loop 비용 ──
          // __zp_get 경유 location.href 읽기 20만 회 — 상한이 아니라 측정값
          // 보고용 (회귀하면 ms 가 튄다).
          await P('membraneRead', () => {
            const t = performance.now();
            let s = 0;
            for (let i = 0; i < 200000; i++) s += location.href.length;
            return Math.round(performance.now() - t) + 'ms|' + s;
          });
          // MutationObserver 전체 DOM 감시 비용 — 2000개 연속 삽입.
          await P('moOverhead', async () => {
            const t = performance.now();
            for (let i = 0; i < 2000; i++) {
              const d = document.createElement('div');
              d.setAttribute('data-mo', i);
              document.body.appendChild(d);
              d.remove();
            }
            await new Promise(r => setTimeout(r, 30));
            return Math.round(performance.now() - t) + 'ms';
          });
          out.done = true;
        })().catch(e => { (window.__perfProbes = window.__perfProbes || {}).__fatal = String(e && (e.stack || e)); });
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/frame-html') {
      // A routed frame that reports what its OWN code sees, now and later — the
      // late read catches a parent that installs its containment over it.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>fh</title><script>parent.__fhSaw = String(location.href); setTimeout(function () { parent.__fhLate = String(location.href); }, 300);<\/script>');
      return;
    }
    if (url.pathname === '/xsite-echo') {
      // Answers a ping from its embedder: the test counts what arrives.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      // A BARE addEventListener (undefined receiver) and a reply through e.source:
      // the combination ad and widget SDKs use. The proxy used to hand such a
      // listener its own origin as e.origin and a raw e.source.
      res.end('<!doctype html><title>echo</title><script>addEventListener("message", function (e) { if (e.data === "ping") parent.postMessage("pong", "*"); else if (e.data === "who") e.source.postMessage("who:" + JSON.stringify({ srcIsParent: e.source === parent, srcIsTop: e.source === top, origin: e.origin, trusted: e.isTrusted }), "*"); });<\/script>');
      return;
    }
    if (url.pathname === '/xsite-child' || url.pathname === '/xsite-same' || url.pathname === '/xsite-pop') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(xsiteReporter(url.pathname, url.pathname === '/xsite-pop'));
      return;
    }
    if (url.pathname === '/xsite') {
      // Window access across sites, both directions, frames and a popup. Every
      // value is a type or an error name — never page content.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Cross-site access</title><body><script>
        window.__xsite = null;
        (async function () {
          var out = {};
          var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
          var other = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
          var got = {}, pop = null, cross = null, same = null;
          window.addEventListener('message', function (e) {
            try {
              var d = JSON.parse(e.data);
              var handle = d.kind === '/xsite-child' ? cross && cross.contentWindow : d.kind === '/xsite-same' ? same && same.contentWindow : pop;
              got[d.kind] = { R: d.R, sourceIsHandle: !!handle && e.source === handle };
            } catch (x) {}
          });
          var mk = function (src) { var f = document.createElement('iframe'); f.src = src; document.body.appendChild(f); return f; };
          var op = function (f) {
            try { var v = f(); return v === null ? 'null' : (typeof v === 'object' || typeof v === 'function') ? typeof v : (typeof v === 'string' ? 'string' : String(v)); }
            catch (e) { return 'threw:' + (e && e.name); }
          };
          cross = mk('http://' + other + ':' + location.port + '/xsite-child');
          same = mk('/xsite-same');
          var t0 = Date.now();
          while (Date.now() - t0 < 8000 && !(got['/xsite-child'] && got['/xsite-same'])) await sleep(50);
          await sleep(300);
          var frameTable = function (label, f, index) {
            var w = f.contentWindow;
            var T = {
              document: function () { return w.document; }, localStorage: function () { return w.localStorage; }, eval: function () { return w.eval; },
              name: function () { return w.name; }, origin: function () { return w.origin; }, navigator: function () { return w.navigator; },
              expando: function () { return w.zpChildVar; }, window: function () { return w.window === w; }, self: function () { return w.self === w; },
              postMessage: function () { return w.postMessage; }, close: function () { return w.close; }, focus: function () { return w.focus; },
              closed: function () { return w.closed; }, length: function () { return w.length; }, frames: function () { return w.frames; },
              top: function () { return w.top === top; }, parent: function () { return w.parent === window; }, opener: function () { return w.opener; },
              locationType: function () { return w.location; }, locationHref: function () { return w.location.href; }, locationReplace: function () { return w.location.replace; },
              inDocument: function () { return 'document' in w; }, inPostMessage: function () { return 'postMessage' in w; },
              proto: function () { return Object.getPrototypeOf(w); }, gopdDocument: function () { return Object.getOwnPropertyDescriptor(w, 'document'); },
              setProp: function () { w.zpParentSet = 1; return 'set'; }, deleteProp: function () { return delete w.zpParentSet; },
              contentDocument: function () { return f.contentDocument; }, identity: function () { return f.contentWindow === f.contentWindow; },
              framesIndex: function () { return window.frames[index] === f.contentWindow; }, windowIndex: function () { return window[index] === f.contentWindow; },
              stringOf: function () { return String(w); }
            };
            for (var k in T) out['p2c.' + label + '.' + k] = op(T[k]);
          };
          frameTable('cross', cross, 0);
          frameTable('same', same, 1);
          for (var kind in got) {
            var label = kind === '/xsite-child' ? 'cross' : 'same';
            for (var k in got[kind].R) out['c2p.' + label + '.' + k] = got[kind].R[k];
            out['source.' + label] = String(got[kind].sourceIsHandle);
          }
          // A popup on another site: its handle, and its view of this window.
          pop = window.open('http://' + other + ':' + location.port + '/xsite-pop', 'xsitepop');
          out['pop.opened'] = String(pop !== null);
          t0 = Date.now();
          while (pop && Date.now() - t0 < 8000 && !got['/xsite-pop']) await sleep(50);
          await sleep(300);
          if (pop) {
            var PT = {
              document: function () { return pop.document; }, localStorage: function () { return pop.localStorage; }, eval: function () { return pop.eval; },
              name: function () { return pop.name; }, closed: function () { return pop.closed; }, postMessage: function () { return pop.postMessage; },
              locationType: function () { return pop.location; }, locationHref: function () { return pop.location.href; }, inDocument: function () { return 'document' in pop; },
              setProp: function () { pop.zpX = 1; return 'set'; }, opener: function () { return pop.opener; }, top: function () { return pop.top === pop; },
              identity: function () { return pop === pop && pop.self === pop; }
            };
            for (var pk in PT) out['pop.handle.' + pk] = op(PT[pk]);
            if (got['/xsite-pop']) {
              for (var rk in got['/xsite-pop'].R) out['pop.opener.' + rk] = got['/xsite-pop'].R[rk];
              out['pop.source'] = String(got['/xsite-pop'].sourceIsHandle);
            }
            try { pop.close(); } catch (x) {}
          }
          // postMessage: a message addressed to an origin the window does not have is
          // dropped (the proxy rewrote every http(s) target origin to its own).
          var pongs = 0;
          window.addEventListener('message', function (e) { if (typeof e.data === 'string' && e.data.indexOf('pong') === 0) pongs++; });
          var mkNamed = function (src, name) { var f = document.createElement('iframe'); f.name = name; f.src = src; document.body.appendChild(f); return f; };
          var echoCross = mkNamed('http://' + other + ':' + location.port + '/xsite-echo', 'xechocross');
          var echoSame = mkNamed('/xsite-echo', 'xechosame');
          await sleep(1800);
          var send = async function (w, fn) {
            var before = pongs, err = '';
            try { fn(w); } catch (e) { err = 'threw:' + (e && e.name); }
            await sleep(450);
            return err || (pongs > before ? 'delivered' : 'dropped');
          };
          var crossOrigin = 'http://' + other + ':' + location.port;
          out['pm.cross.exact'] = await send(echoCross.contentWindow, function (w) { w.postMessage('ping', crossOrigin); });
          out['pm.cross.wrong'] = await send(echoCross.contentWindow, function (w) { w.postMessage('ping', 'http://example.invalid'); });
          out['pm.cross.ownOrigin'] = await send(echoCross.contentWindow, function (w) { w.postMessage('ping', location.origin); });
          out['pm.cross.slash'] = await send(echoCross.contentWindow, function (w) { w.postMessage('ping', '/'); });
          out['pm.cross.star'] = await send(echoCross.contentWindow, function (w) { w.postMessage('ping', '*'); });
          out['pm.cross.oneArg'] = await send(echoCross.contentWindow, function (w) { w.postMessage('ping'); });
          out['pm.cross.invalid'] = await send(echoCross.contentWindow, function (w) { w.postMessage('ping', 'not a url'); });
          out['pm.cross.optionsStar'] = await send(echoCross.contentWindow, function (w) { w.postMessage('ping', { targetOrigin: '*' }); });
          out['pm.cross.optionsExact'] = await send(echoCross.contentWindow, function (w) { w.postMessage('ping', { targetOrigin: crossOrigin }); });
          out['pm.cross.optionsWrong'] = await send(echoCross.contentWindow, function (w) { w.postMessage('ping', { targetOrigin: 'http://example.invalid' }); });
          out['pm.same.exact'] = await send(echoSame.contentWindow, function (w) { w.postMessage('ping', location.origin); });
          out['pm.same.wrong'] = await send(echoSame.contentWindow, function (w) { w.postMessage('ping', crossOrigin); });
          out['pm.same.optionsExact'] = await send(echoSame.contentWindow, function (w) { w.postMessage('ping', { targetOrigin: location.origin }); });
          // The child's view of a message from its parent, and its reply through
          // e.source; the parent sees the reply come from the very handle it holds.
          var whoGot = {};
          window.addEventListener('message', function (e) {
            if (typeof e.data === 'string' && e.data.indexOf('who:') === 0) {
              whoGot[e.source === echoCross.contentWindow ? 'cross' : e.source === echoSame.contentWindow ? 'same' : 'other'] = e.data.slice(4);
            }
          });
          echoCross.contentWindow.postMessage('who', '*');
          echoSame.contentWindow.postMessage('who', '*');
          await sleep(800);
          out['reply.cross'] = whoGot.cross || 'none';
          out['reply.same'] = whoGot.same || 'none';
          out['reply.sources'] = Object.keys(whoGot).sort().join(',');
          // A frame reached by name is the same handle as its contentWindow.
          out['named.cross.bracket'] = op(function () { return window.frames['xechocross'].document; });
          out['named.cross.windowBracket'] = op(function () { return window['xechocross'].document; });
          out['named.cross.dot'] = op(function () { return window.frames.xechocross.document; });
          out['named.cross.identity'] = op(function () { return window.frames['xechocross'] === echoCross.contentWindow && window['xechocross'] === echoCross.contentWindow; });
          out['named.same.identity'] = op(function () { return window.frames['xechosame'] === echoSame.contentWindow; });
          out['named.same.document'] = op(function () { return window.frames['xechosame'].document; });
          window.__xsite = out;
        })().catch(function (e) { window.__xsite = { __fatal: String(e && (e.stack || e)) }; });
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/xtab') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>tab</title><p>tab</p>');
      return;
    }
    if (url.pathname === '/xcookie2-child') {
      // A frame that writes a cookie when asked and reports the ck2_ cookies it can read.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>cookie child</title><script>' +
        'function names() { return document.cookie.split("; ").filter(Boolean).map(function (c) { return c.split("=")[0]; }).filter(function (n) { return n.indexOf("ck2_") === 0; }).sort().join(","); }' +
        'addEventListener("message", function (m) {' +
        '  if (m.data === "set") { document.cookie = "ck2_child=1; Path=/"; parent.postMessage("cookie2:" + JSON.stringify({ set: names() }), "*"); }' +
        '  else if (m.data === "read") parent.postMessage("cookie2:" + JSON.stringify({ read: names() }), "*");' +
        '});' +
        '<\/script>');
      return;
    }
    if (url.pathname === '/xcookie2') {
      // Cookies the page's copy of the jar learns from OTHER places: a frame's own
      // navigation, an image, a script, a synchronous XHR, a sibling frame's write.
      // The jar is shared; each document keeps a copy. Names are the fixture's own.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Cookies from elsewhere</title><body><script>
        window.__xcookie2 = null;
        (async function () {
          var out = {};
          var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
          var other = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
          var names = function () { return document.cookie.split('; ').filter(Boolean).map(function (c) { return c.split('=')[0]; }).filter(function (n) { return n.indexOf('ck2_') === 0; }).sort().join(','); };
          var changes = [];
          cookieStore.addEventListener('change', function (e) {
            (e.changed || []).forEach(function (c) { if (c.name.indexOf('ck2_') === 0) changes.push('set:' + c.name); });
            (e.deleted || []).forEach(function (c) { if (c.name.indexOf('ck2_') === 0) changes.push('del:' + c.name); });
          });
          var got = {}, same = null, cross = null;
          window.addEventListener('message', function (e) {
            if (typeof e.data === 'string' && e.data.indexOf('cookie2:') === 0) {
              var who = same && e.source === same.contentWindow ? 'same' : cross && e.source === cross.contentWindow ? 'cross' : 'other';
              got[who] = Object.assign(got[who] || {}, JSON.parse(e.data.slice(8)));
            }
          });
          var mk = function (src) { var f = document.createElement('iframe'); f.src = src; document.body.appendChild(f); return f; };
          same = mk('/xcookie2-child');
          cross = mk('http://' + other + ':' + location.port + '/xcookie2-child');
          await sleep(2200);
          // The browser starts delivering change events a moment after the first listener
          // is added — a cookie set before that is not reported natively.
          await sleep(500);
          // 1. a frame's own navigation (the response sets a cookie)
          await new Promise(function (res) { var f = mk('/xsetcookie?n=ck2_frame'); f.addEventListener('load', function () { res(); }); });
          await sleep(700);
          out['frame.navigation'] = names();
          // 2. an image whose response sets a cookie
          await new Promise(function (res) { var i = new Image(); i.onload = i.onerror = function () { res(); }; i.src = '/xsetcookie?n=ck2_img'; });
          await sleep(700);
          out['image'] = names();
          // 3. a script whose response sets a cookie
          await new Promise(function (res) { var sc = document.createElement('script'); sc.onload = sc.onerror = function () { res(); }; sc.src = '/xsetcookie?n=ck2_script'; document.head.appendChild(sc); });
          await sleep(700);
          out['script'] = names();
          // 4. a synchronous XHR: its caller reads document.cookie the moment it returns
          var x = new XMLHttpRequest(); x.open('GET', '/xsetcookie?n=ck2_sync', false); x.send();
          out['sync.xhr.immediately'] = names();
          // 5. a same-site frame writes; this document and the other site's frame
          same.contentWindow.postMessage('set', '*');
          await sleep(900);
          out['sibling.write.parent'] = names();
          // 6. this document writes; the same-site frame reads it, the other site's frame does not
          document.cookie = 'ck2_parent=1; Path=/';
          await sleep(900);
          same.contentWindow.postMessage('read', '*');
          cross.contentWindow.postMessage('read', '*');
          await sleep(900);
          out['child.same.reads'] = got.same && got.same.read || 'none';
          out['child.cross.reads'] = got.cross && got.cross.read !== undefined ? got.cross.read : 'none';
          out['changes'] = changes.slice().sort().join(',');
          window.__xcookie2 = out;
        })().catch(function (e) { window.__xcookie2 = { __fatal: String(e && (e.stack || e)) }; });
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/xnames-child') {
      // A frame that reports its own window.name and the locks it can see, when asked.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>names child</title><script>' +
        'addEventListener("message", function (m) {' +
        '  if (m.data === "rename") { window.name = "renamed_by_child"; parent.postMessage("names:" + JSON.stringify({ renamed: window.name }), "*"); return; }' +
        '  if (m.data !== "report") return;' +
        '  var R = { name: window.name };' +
        '  navigator.locks.query().then(function (q) { R.held = (q.held || []).map(function (l) { return l.name; }).sort().join(","); R.pending = (q.pending || []).length; })' +
        '    .catch(function (e) { R.held = "threw:" + e.name; })' +
        '    .then(function () { parent.postMessage("names:" + JSON.stringify(R), "*"); });' +
        '});' +
        '<\/script>');
      return;
    }
    if (url.pathname === '/xnames') {
      // window.name belongs to a browsing context, not to an origin; the lock manager
      // lists an origin's locks, not every site's. Values are the fixture's own strings.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Names and locks</title><body><script>
        window.__xnames = null;
        (async function () {
          var out = {};
          var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
          var other = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
          var got = {}, plain = null, cross = null, named = null;
          var who = function (e) { return plain && e.source === plain.contentWindow ? 'plain' : cross && e.source === cross.contentWindow ? 'cross' : named && e.source === named.contentWindow ? 'named' : 'other'; };
          window.addEventListener('message', function (e) {
            if (typeof e.data === 'string' && e.data.indexOf('names:') === 0) got[who(e)] = JSON.parse(e.data.slice(6));
          });
          window.name = 'parent_window_name';
          var mk = function (src, name) { var f = document.createElement('iframe'); if (name) f.name = name; f.src = src; document.body.appendChild(f); return f; };
          plain = mk('/xnames-child');
          cross = mk('http://' + other + ':' + location.port + '/xnames-child');
          named = mk('/xnames-child', 'child_named');
          await sleep(2200);
          var release, held = new Promise(function (r) { release = r; });
          navigator.locks.request('zp_names_lock', function () { return held; });
          await sleep(400);
          [plain, cross, named].forEach(function (f) { f.contentWindow.postMessage('report', '*'); });
          await sleep(1500);
          var show = function (r) { return r ? 'name=' + r.name + ' held=' + r.held + ' pending=' + r.pending : 'none'; };
          out['child.plain'] = show(got.plain);
          out['child.cross'] = show(got.cross);
          out['child.named'] = show(got.named);
          out['parent.name'] = window.name;
          out['parent.readsChildName'] = named.contentWindow.name;
          // A frame that names itself does not rename its parent.
          plain.contentWindow.postMessage('rename', '*');
          await sleep(600);
          out['afterChildRename.parent'] = window.name;
          out['afterChildRename.child'] = got.plain && got.plain.renamed || 'none';
          release();
          window.__xnames = out;
        })().catch(function (e) { window.__xnames = { __fatal: String(e && (e.stack || e)) }; });
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/xframe-title') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>frame ready</title><p>frame</p>');
      return;
    }
    if (url.pathname === '/xmarkup') {
      // Frames that come out of markup — innerHTML and its kin, a fragment, a template, a parsed
      // document, document.write — load as frames made by script do, and read back as written.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Markup frames</title><body><script>
        window.__xmarkup = null;
        (async function () {
          var out = {};
          var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
          var title = function (f) { try { return f.contentDocument.title; } catch (e) { return 'threw:' + e.name; } };
          var settle = async function (f) { for (var i = 0; i < 100 && title(f) !== 'frame ready'; i++) await sleep(100); return title(f); };
          var holder = function () { var h = document.createElement('div'); document.body.appendChild(h); return h; };
          var MARK = '<iframe src="/xframe-title" name="m"></iframe>';
          var h = holder(); h.innerHTML = MARK;
          out['innerHTML.title'] = await settle(h.firstChild);
          out['innerHTML.src'] = h.firstChild.getAttribute('src');
          out['innerHTML.read'] = h.innerHTML;
          // The page's srcdoc text comes back as written, not as the document the proxy made of it.
          h = holder(); h.innerHTML = '<iframe srcdoc="<p id=x>from srcdoc</p>"></iframe>';
          var sd = h.firstChild;
          out['innerHTML.srcdoc.prop'] = sd.srcdoc;
          out['innerHTML.srcdoc.attr'] = sd.getAttribute('srcdoc');
          await sleep(1500);
          out['innerHTML.srcdoc.body'] = (function () { try { return sd.contentDocument.body.innerHTML; } catch (e) { return 'threw:' + e.name; } })();
          h = holder(); h.insertAdjacentHTML('beforeend', MARK);
          out['insertAdjacentHTML.beforeend'] = await settle(h.firstChild);
          h = holder(); var mid = document.createElement('i'); h.appendChild(mid); mid.insertAdjacentHTML('afterend', MARK);
          out['insertAdjacentHTML.afterend'] = await settle(h.lastChild);
          h = holder(); mid = document.createElement('i'); h.appendChild(mid); mid.insertAdjacentHTML('beforebegin', MARK);
          out['insertAdjacentHTML.beforebegin'] = await settle(h.firstChild);
          h = holder(); h.setHTMLUnsafe(MARK);
          out['setHTMLUnsafe'] = await settle(h.firstChild);
          h = holder(); var old = document.createElement('i'); h.appendChild(old); old.outerHTML = MARK;
          out['outerHTML'] = await settle(h.firstChild);
          var tpl = document.createElement('template'); tpl.innerHTML = MARK;
          h = holder(); h.appendChild(document.importNode(tpl.content, true));
          out['template.import'] = await settle(h.firstChild);
          out['template.src'] = tpl.content.firstChild.getAttribute('src');
          h = holder(); var clone = tpl.content.firstChild.cloneNode(true); h.appendChild(clone);
          out['template.clone'] = await settle(clone);
          h = holder(); h.appendChild(document.createRange().createContextualFragment(MARK));
          out['createContextualFragment'] = await settle(h.firstChild);
          h = holder(); var doc = new DOMParser().parseFromString('<body>' + MARK + '</body>', 'text/html');
          h.appendChild(document.adoptNode(doc.body.firstChild));
          out['DOMParser.adopt'] = await settle(h.firstChild);
          h = holder(); var blank = document.createElement('iframe'); h.appendChild(blank);
          var bd = blank.contentDocument; bd.open(); bd.write('<body>' + MARK + '</body>'); bd.close();
          out['document.write'] = await settle(bd.querySelector('iframe'));
          // Late: the document's own sweeps for parked frames (the first seconds after load) are over, so only
          // the hook on the setter itself can start this one.
          await sleep(4000);
          h = holder(); h.innerHTML = MARK;
          out['innerHTML.late'] = await settle(h.firstChild);
          window.__xmarkup = out;
        })().catch(function (e) { window.__xmarkup = { __fatal: String(e && (e.stack || e)) }; });
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/xinsert') {
      // A script put into the document by every door a node can come through asks where it runs. Through the
      // membrane it reads the page's own URL; raw, the proxy's (and could assign the real location).
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Insertion doors</title><body><script>
        window.__xinsert = null;
        (async function () {
          var out = {};
          var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
          var trial = async function (name, insert) {
            window.__ins = undefined;
            var s = document.createElement('script');
            s.textContent = 'window.__ins = location.href;';
            var h = document.createElement('div'); document.body.appendChild(h);
            try { insert(h, s); } catch (e) { out[name] = 'threw:' + e.name; return; }
            await sleep(250);
            out[name] = window.__ins === undefined ? 'did not run' : window.__ins === location.href ? 'virtual' : 'raw';
          };
          var mid = function (h) { var m = document.createElement('i'); h.appendChild(m); return m; };
          var text = function (h) { var t = document.createTextNode('t'); h.appendChild(t); return t; };
          await trial('appendChild', function (h, s) { h.appendChild(s); });
          await trial('insertBefore', function (h, s) { h.insertBefore(s, null); });
          await trial('replaceChild', function (h, s) { h.replaceChild(s, mid(h)); });
          await trial('append', function (h, s) { h.append(s); });
          await trial('prepend', function (h, s) { h.prepend(s); });
          await trial('replaceChildren', function (h, s) { h.replaceChildren(s); });
          await trial('insertAdjacentElement', function (h, s) { h.insertAdjacentElement('beforeend', s); });
          await trial('Range.insertNode', function (h, s) { var r = document.createRange(); r.selectNodeContents(h); r.insertNode(s); });
          await trial('before', function (h, s) { mid(h).before(s); });
          await trial('after', function (h, s) { mid(h).after(s); });
          await trial('replaceWith', function (h, s) { mid(h).replaceWith(s); });
          await trial('text.before', function (h, s) { text(h).before(s); });
          await trial('text.after', function (h, s) { text(h).after(s); });
          await trial('text.replaceWith', function (h, s) { text(h).replaceWith(s); });
          await trial('DocumentFragment', function (h, s) { var f = document.createDocumentFragment(); f.appendChild(s); h.appendChild(f); });
          await trial('ShadowRoot.append', function (h, s) { h.attachShadow({ mode: 'open' }).append(s); });
          await trial('ShadowRoot.replaceChildren', function (h, s) { h.attachShadow({ mode: 'open' }).replaceChildren(s); });
          await trial('importNode+append', function (h, s) { h.appendChild(document.importNode(s, true)); });
          await trial('cloneNode+append', function (h, s) { h.appendChild(s.cloneNode(true)); });
          window.__xinsert = out;
        })().catch(function (e) { window.__xinsert = { __fatal: String(e && (e.stack || e)) }; });
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/xsyncck') {
      // A synchronous XHR blocks the thread: it cannot wait for the cookie write to reach the worker. Thirty
      // rounds of write-then-send, with a cookie of its own each time and one overwritten each time.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Sync XHR cookies</title><body><script>
        window.__xsyncck = null;
        (function () {
          var out = { rounds: 30, uniqueMissed: [], sharedWrong: [], heldSent: null, heldAfter: null };
          var echo = function () { var x = new XMLHttpRequest(); x.open('GET', '/cookie-echo?n=' + Math.random(), false); x.send(); return x.responseText; };
          for (var i = 0; i < out.rounds; i++) {
            document.cookie = 'su_' + i + '=' + i;
            if (echo().indexOf('su_' + i + '=' + i) < 0) out.uniqueMissed.push(i);
            document.cookie = 'sshared=' + i;
            if (echo().split('; ').indexOf('sshared=' + i) < 0) out.sharedWrong.push(i);
          }
          // The same, made certain: the worker is not told of the write until the request is gone. (Natively there
          // is no worker and nothing to hold.)
          var proto = typeof ServiceWorker === 'function' ? ServiceWorker.prototype : null;
          var real = proto && proto.postMessage, held = [];
          if (proto) proto.postMessage = function (m) { if (m && m.type === 'ZP_COOKIE_SET') { held.push([this, arguments]); return; } return real.apply(this, arguments); };
          document.cookie = 'sheld=1';
          out.heldSent = echo().split('; ').indexOf('sheld=1') >= 0;
          if (proto) { proto.postMessage = real; held.forEach(function (h) { real.apply(h[0], h[1]); }); }
          // ...and what the late message does to a cookie already sent: nothing.
          out.heldAfter = document.cookie.split('; ').filter(function (c) { return c.indexOf('sheld=') === 0; }).join('|') + '/' + echo().split('; ').filter(function (c) { return c.indexOf('sheld=') === 0; }).join('|');
          window.__xsyncck = out;
        })();
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/xsamesite' || url.pathname === '/xsamesite-img') {
      // Sets the cookie n with the SameSite given (ss=None|Lax|Strict, absent: none stated) and Secure with secure=1.
      const ss = url.searchParams.get('ss');
      const cookie = url.searchParams.get('n') + '=1; Path=/' + (ss ? '; SameSite=' + ss : '') + (url.searchParams.get('secure') ? '; Secure' : '');
      if (url.pathname === '/xsamesite-img') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Set-Cookie': cookie });
        res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': cookie });
        res.end('ok');
      }
      return;
    }
    if (url.pathname === '/xck-echo') {
      // Remembers which cookies the request carried, under the tag it was given; answers an image (or the names, json=1).
      // Only this test's own cookies: the proxied session's jar also holds what earlier subtests set.
      const names = (req.headers.cookie || '').split('; ').filter(Boolean).map(c => c.split('=')[0]).filter(n => /^(ss|op)_/.test(n)).sort().join(',');
      xckSeen.set(url.searchParams.get('tag') || '', names);
      if (url.searchParams.get('json')) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(names);
      } else {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'));
      }
      return;
    }
    if (url.pathname === '/xck-seen') {
      const out = {};
      for (const tag of (url.searchParams.get('tags') || '').split(',')) out[tag] = xckSeen.has(tag) ? xckSeen.get(tag) : null;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out));
      return;
    }
    if (url.pathname === '/xopck-static') {
      // A sandboxed document that cannot run a script: every subresource it loads is cross-site natively.
      const rid = url.searchParams.get('rid');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>static</title><body>' +
        '<img src="/xck-echo?tag=' + rid + ':img">' +
        '<link rel="stylesheet" href="/xck-echo?tag=' + rid + ':css">' +
        '<img src="/xck-echo?tag=' + rid + ':last"></body>');
      return;
    }
    if (url.pathname === '/xopck-set') {
      // What an opaque document's responses set: only the SameSite=None one may stick.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>set</title><body>' +
        '<img src="/xsamesite-img?n=op_lax&ss=Lax">' +
        '<img src="/xsamesite-img?n=op_none&ss=None&secure=1">' +
        '<img src="/xsamesite-img?n=op_def"></body>');
      return;
    }
    if (url.pathname === '/xopck-child') {
      const rid = url.searchParams.get('rid');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      // The <script src> is here, where scripts run: a scriptless document does not fetch it the same way in the proxy.
      res.end('<!doctype html><title>script child</title><script src="/xck-echo?tag=' + rid + ':script"></script><script>' +
        'var rid = ' + JSON.stringify(rid) + ';' +
        'Promise.all([fetch("/xck-echo?tag=" + rid + ":fetch-default&json=1").catch(function () {}), fetch("/xck-echo?tag=" + rid + ":fetch-include&json=1", { credentials: "include" }).catch(function () {})])' +
        '.then(function () { parent.postMessage("xopck-child-done", "*"); });' +
        '<\/script>');
      return;
    }
    if (url.pathname === '/xopck') {
      // What an opaque document's requests carry and keep. Natively a sandboxed document without
      // allow-same-origin is cross-site to everything: only SameSite=None cookies go with its requests,
      // and only those may be set by its responses.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Opaque cookies</title><body><script>
        window.__xopck = null;
        (async function () {
          var out = {};
          var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
          var rid = Math.random().toString(36).slice(2, 10);
          await fetch('/xsamesite?n=ss_none&ss=None&secure=1');
          await fetch('/xsamesite?n=ss_lax&ss=Lax');
          await fetch('/xsamesite?n=ss_strict&ss=Strict');
          await fetch('/xsamesite?n=ss_def');
          out.jarHere = await (await fetch('/xck-echo?tag=' + rid + ':here&json=1')).text();
          var childDone = false;
          addEventListener('message', function (e) { if (e.data === 'xopck-child-done') childDone = true; });
          var f1 = document.createElement('iframe'); f1.setAttribute('sandbox', ''); f1.src = '/xopck-static?rid=' + rid; document.body.appendChild(f1);
          var f2 = document.createElement('iframe'); f2.setAttribute('sandbox', 'allow-scripts'); f2.src = '/xopck-child?rid=' + rid; document.body.appendChild(f2);
          var tags = ['img', 'css', 'script', 'last', 'fetch-default', 'fetch-include'].map(function (t) { return rid + ':' + t; });
          var seen = {};
          for (var i = 0; i < 250; i++) {
            seen = await (await fetch('/xck-seen?tags=' + tags.join(','))).json();
            if (tags.every(function (t) { return seen[t] !== null; }) && childDone) break;
            await sleep(100);
          }
          await sleep(1500);
          for (var k in seen) out[k.split(':')[1]] = seen[k];
          var f3 = document.createElement('iframe'); f3.setAttribute('sandbox', ''); f3.src = '/xopck-set'; document.body.appendChild(f3);
          await sleep(3000);
          out.jarAfter = await (await fetch('/xck-echo?tag=' + rid + ':after&json=1')).text();
          window.__xopck = out;
        })().catch(function (e) { window.__xopck = { __fatal: String(e && (e.stack || e)) }; });
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/xcors-log') {
      const prefix = url.searchParams.get('prefix') || '';
      const out = {};
      for (const [tag, entries] of corsLog) if (tag.startsWith(prefix)) out[tag.slice(prefix.length)] = entries;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out));
      return;
    }
    if (url.pathname === '/xcors-api') {
      // A cross-origin API whose answer to the page is picked by `case`: what it allows (ACAO/ACAC/ACEH, and for the
      // OPTIONS preflight ACAM/ACAH/Max-Age), what it redirects to. It logs what each request looked like.
      const q = url.searchParams;
      const tag = q.get('tag') || '';
      const name = q.get('case') || '';
      const po = q.get('po') || '';
      const names = (req.headers.cookie || '').split('; ').filter(Boolean).map(c => c.split('=')[0]).filter(n => n === (q.get('cn') || 'xc')).sort().join(',');
      if (!corsLog.has(tag)) corsLog.set(tag, []);
      corsLog.get(tag).push({
        m: req.method,
        origin: req.headers.origin || null,
        acrm: req.headers['access-control-request-method'] || null,
        acrh: req.headers['access-control-request-headers'] || null,
        cookies: names,
        custom: req.headers['x-custom'] || null,
        auth: req.headers.authorization ? 'yes' : null,
        ct: (req.headers['content-type'] || '').split(';')[0] || null,
        // nothing of the worker's own (X-ZP-*) ever reaches a target
        zp: Object.keys(req.headers).filter(h => h.startsWith('x-zp')).join(','),
      });
      const ACAO = 'Access-Control-Allow-Origin', ACAC = 'Access-Control-Allow-Credentials', ACEH = 'Access-Control-Expose-Headers';
      const ACAM = 'Access-Control-Allow-Methods', ACAH = 'Access-Control-Allow-Headers', MAXAGE = 'Access-Control-Max-Age';
      const plain = {
        'acao-origin': { [ACAO]: po },
        'acao-star': { [ACAO]: '*' },
        'acao-null': { [ACAO]: 'null' },
        'acao-other': { [ACAO]: 'http://example.invalid' },
        'acao-missing': {},
        'acao-origin-creds': { [ACAO]: po, [ACAC]: 'true' },
        'acao-star-creds': { [ACAO]: '*', [ACAC]: 'true' },
        'expose-none': { [ACAO]: po },
        'expose-listed': { [ACAO]: po, [ACEH]: 'X-Secret, x-other' },
        'expose-star': { [ACAO]: po, [ACEH]: '*' },
        'expose-star-creds': { [ACAO]: po, [ACAC]: 'true', [ACEH]: '*' },
        'setcookie': { [ACAO]: po, [ACAC]: 'true', 'Set-Cookie': (q.get('cn') || 'xc') + '=1; Path=/; SameSite=None; Secure' },
        'same': {},
      };
      const preflight = {
        'pf-put-ok': { [ACAO]: po, [ACAM]: 'PUT' },
        'pf-put-no-acam': { [ACAO]: po },
        'pf-put-wrong-method': { [ACAO]: po, [ACAM]: 'DELETE' },
        'pf-put-lower': { [ACAO]: po, [ACAM]: 'put' },
        'pf-header-ok': { [ACAO]: po, [ACAH]: 'X-Custom' },
        'pf-header-list': { [ACAO]: po, [ACAH]: 'x-other, x-custom' },
        'pf-header-missing': { [ACAO]: po, [ACAM]: 'GET' },
        'pf-header-star': { [ACAO]: po, [ACAH]: '*' },
        'pf-header-star-creds': { [ACAO]: po, [ACAC]: 'true', [ACAH]: '*' },
        'pf-auth-star': { [ACAO]: po, [ACAH]: '*' },
        'pf-auth-listed': { [ACAO]: po, [ACAH]: 'authorization' },
        'pf-json-ok': { [ACAO]: po, [ACAH]: 'content-type' },
        'pf-json-no': { [ACAO]: po },
        'pf-status-403': { [ACAO]: po, [ACAM]: 'PUT' },
        'pf-no-acao': { [ACAM]: 'PUT' },
        'pf-methods-star': { [ACAO]: po, [ACAM]: '*' },
        'pf-methods-star-creds': { [ACAO]: po, [ACAC]: 'true', [ACAM]: '*' },
        'pf-maxage': { [ACAO]: po, [ACAM]: 'PUT', [MAXAGE]: '60' },
      };
      const base = { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'X-Secret': '1', 'X-Other': '2' };
      if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
        if (name === 'pf-redirect') {
          res.writeHead(302, Object.assign({}, base, { Location: q.get('loc') || '/', [ACAO]: po }));
        } else {
          res.writeHead(name === 'pf-status-403' ? 403 : 204, Object.assign({}, base, preflight[name] || {}));
        }
        res.end();
        return;
      }
      if (name === 'redir') {
        const headers = Object.assign({}, base, { Location: q.get('loc') || '/' });
        if (!q.get('noacao')) Object.assign(headers, { [ACAO]: po, [ACAC]: 'true' });
        res.writeHead(302, headers);
        res.end();
        return;
      }
      const allow = name.startsWith('pf-') ? { [ACAO]: po, [ACAC]: 'true' } : (plain[name] || {});
      const as = q.get('as');
      if (as === 'img' || as === 'js' || as === 'css' || as === 'font') {
        const kinds = {
          img: ['image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')],
          js: ['text/javascript', '(window.__xcel = window.__xcel || {})[' + JSON.stringify(tag) + '] = 1;'],
          css: ['text/css', '.xcel { color: red; }'],
          font: ['font/ttf', miniTrueTypeFont()],
        };
        res.writeHead(200, Object.assign({}, base, allow, { 'Content-Type': kinds[as][0] }));
        res.end(kinds[as][1]);
        return;
      }
      res.writeHead(200, Object.assign({}, base, allow));
      res.end('ok:' + name + ':' + req.method);
      return;
    }
    if (url.pathname === '/xcors') {
      // What a page may do with a response from another origin, and when the browser even sends the request:
      // fetch(), async XHR and sync XHR against /xcors-api on the other host (localhost <-> 127.0.0.1).
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>CORS</title><body><script>
        window.__xcors = null;
        (async function () {
          var out = {};
          var rid = Math.random().toString(36).slice(2, 10);
          var po = location.origin;
          var other = location.protocol + '//' + (location.hostname === 'localhost' ? '127.0.0.1' : 'localhost') + ':' + location.port;
          var nl = String.fromCharCode(10);
          function api(base, name, cs, extra) {
            return base + '/xcors-api?tag=' + encodeURIComponent(rid + ':' + name) + '&case=' + cs + '&po=' + encodeURIComponent(po) + (extra || '');
          }
          function names(h) {
            var a = [];
            h.forEach(function (v, k) { if (['content-length', 'connection', 'keep-alive', 'transfer-encoding', 'date'].indexOf(k) < 0) a.push(k); });
            return a.sort();
          }
          async function f(name, cs, init, extra, base) {
            try {
              var r = await fetch(api(base || other, name, cs, extra), init);
              var text = await r.text();
              out[name] = { type: r.type, status: r.status, redirected: r.redirected, text: text.slice(0, 40), hdr: r.type === 'cors' ? names(r.headers) : undefined };
            } catch (e) { out[name] = 'threw:' + (e && e.name) + ':' + (e && e.message); }
          }
          function xhr(name, cs, opts) {
            opts = opts || {};
            return new Promise(function (resolve) {
              var x = new XMLHttpRequest();
              var done = function (kind) {
                var all = x.getAllResponseHeaders().split(nl).map(function (l) { return l.split(':')[0].trim().toLowerCase(); }).filter(function (k) { return k && ['content-length', 'connection', 'keep-alive', 'transfer-encoding', 'date'].indexOf(k) < 0; }).sort();
                out[name] = { kind: kind, status: x.status, text: kind === 'load' ? x.responseText.slice(0, 40) : '', secret: x.getResponseHeader('x-secret'), other: x.getResponseHeader('x-other'), all: all };
                resolve();
              };
              x.onload = function () { done('load'); };
              x.onerror = function () { done('error'); };
              x.open(opts.method || 'GET', api(other, name, cs), true);
              if (opts.wc) x.withCredentials = true;
              if (opts.headers) for (var k in opts.headers) x.setRequestHeader(k, opts.headers[k]);
              x.send(opts.body || null);
            });
          }
          function xhrSync(name, cs, opts) {
            opts = opts || {};
            var x = new XMLHttpRequest();
            try {
              x.open(opts.method || 'GET', api(other, name, cs), false);
              if (opts.wc) x.withCredentials = true;
              if (opts.headers) for (var k in opts.headers) x.setRequestHeader(k, opts.headers[k]);
              x.send(opts.body || null);
              out[name] = { status: x.status, text: x.responseText.slice(0, 40), secret: x.getResponseHeader('x-secret'), state: x.readyState };
            } catch (e) { out[name] = { threw: e && e.name, state: x.readyState, status: x.status }; }
          }
          // who may read what
          await f('acao-origin', 'acao-origin');
          await f('acao-star', 'acao-star');
          await f('acao-null', 'acao-null');
          await f('acao-other', 'acao-other');
          await f('acao-missing', 'acao-missing');
          await f('star-creds', 'acao-star', { credentials: 'include' });
          await f('star-creds-acac', 'acao-star-creds', { credentials: 'include' });
          await f('creds-ok', 'acao-origin-creds', { credentials: 'include' });
          await f('creds-no-acac', 'acao-origin', { credentials: 'include' });
          await f('set-cookie', 'setcookie', { credentials: 'include' });
          await f('cookie-include', 'acao-origin-creds', { credentials: 'include' });
          await f('cookie-default', 'acao-origin');
          await f('cookie-omit', 'acao-origin', { credentials: 'omit' });
          await f('expose-none', 'expose-none');
          await f('expose-listed', 'expose-listed');
          await f('expose-star', 'expose-star');
          await f('expose-star-creds', 'expose-star-creds', { credentials: 'include' });
          // when the browser asks first
          await f('pf-put-ok', 'pf-put-ok', { method: 'PUT' });
          await f('pf-put-no-acam', 'pf-put-no-acam', { method: 'PUT' });
          await f('pf-put-wrong-method', 'pf-put-wrong-method', { method: 'PUT' });
          await f('pf-put-lower', 'pf-put-lower', { method: 'PUT' });
          await f('pf-header-ok', 'pf-header-ok', { headers: { 'X-Custom': '1' } });
          await f('pf-header-list', 'pf-header-list', { headers: { 'X-Custom': '1' } });
          await f('pf-header-missing', 'pf-header-missing', { headers: { 'X-Custom': '1' } });
          await f('pf-header-star', 'pf-header-star', { headers: { 'X-Custom': '1' } });
          await f('pf-header-star-creds', 'pf-header-star-creds', { headers: { 'X-Custom': '1' }, credentials: 'include' });
          await f('pf-auth-star', 'pf-auth-star', { headers: { Authorization: 'Bearer x' } });
          await f('pf-auth-listed', 'pf-auth-listed', { headers: { Authorization: 'Bearer x' } });
          await f('pf-json-ok', 'pf-json-ok', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          await f('pf-json-no', 'pf-json-no', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          await f('pf-status-403', 'pf-status-403', { method: 'PUT' });
          await f('pf-no-acao', 'pf-no-acao', { method: 'PUT' });
          await f('pf-methods-star', 'pf-methods-star', { method: 'PUT' });
          await f('pf-methods-star-creds', 'pf-methods-star-creds', { method: 'PUT', credentials: 'include' });
          await f('pf-redirect', 'pf-redirect', { method: 'PUT' }, '&loc=' + encodeURIComponent(api(other, 'pf-redirect:b', 'acao-origin')));
          await f('pf-maxage', 'pf-maxage', { method: 'PUT' });
          await f('pf-maxage', 'pf-maxage', { method: 'PUT' });
          await f('simple-text-plain', 'acao-origin', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
          await f('simple-range', 'acao-origin', { headers: { Range: 'bytes=0-5' } });
          // no preflight, and no check, for the document's own origin
          await f('same-put', 'same', { method: 'PUT', headers: { 'X-Custom': '1' } }, '', po);
          await f('same-origin-mode', 'acao-origin', { mode: 'same-origin' });
          await f('no-cors-get', 'acao-missing', { mode: 'no-cors' });
          await f('no-cors-post', 'acao-missing', { mode: 'no-cors', method: 'POST', body: 'x' });
          // redirects: every hop is checked, and between two other origins the origin is no longer told
          await f('redir-cross', 'redir', {}, '&loc=' + encodeURIComponent(api(other, 'redir-cross:b', 'acao-origin')));
          await f('redir-no-acao', 'redir', {}, '&noacao=1&loc=' + encodeURIComponent(api(other, 'redir-no-acao:b', 'acao-origin')));
          await f('redir-self-star', 'redir', {}, '&loc=' + encodeURIComponent(api(po, 'redir-self-star:b', 'acao-star')));
          await f('redir-self-origin', 'redir', {}, '&loc=' + encodeURIComponent(api(po, 'redir-self-origin:b', 'acao-origin')));
          await f('redir-self-null', 'redir', {}, '&loc=' + encodeURIComponent(api(po, 'redir-self-null:b', 'acao-null')));
          await f('redir-from-same', 'redir', {}, '&loc=' + encodeURIComponent(api(other, 'redir-from-same:b', 'acao-origin')), po);
          await f('redir-userinfo', 'redir', {}, '&loc=' + encodeURIComponent(api(other.replace('//', '//u:p@'), 'redir-userinfo:b', 'acao-origin')));
          // XMLHttpRequest, async and sync
          await xhr('x-ok', 'acao-origin');
          await xhr('x-fail', 'acao-missing');
          await xhr('x-expose', 'expose-listed');
          await xhr('x-hidden', 'expose-none');
          await xhr('x-creds', 'acao-origin-creds', { wc: true });
          await xhr('x-nocreds', 'acao-origin-creds');
          await xhr('x-preflight', 'pf-put-ok', { method: 'PUT', body: 'x' });
          await xhr('x-preflight-fail', 'pf-put-no-acam', { method: 'PUT', body: 'x' });
          xhrSync('sx-ok', 'expose-listed');
          xhrSync('sx-fail', 'acao-missing');
          xhrSync('sx-wc', 'acao-origin-creds', { wc: true });
          xhrSync('sx-nowc', 'acao-origin-creds');
          xhrSync('sx-preflight', 'pf-header-ok', { headers: { 'X-Custom': '1' } });
          xhrSync('sx-preflight-fail', 'pf-header-missing', { headers: { 'X-Custom': '1' } });
          out.__log = await (await fetch('/xcors-log?prefix=' + encodeURIComponent(rid + ':'))).json();
          window.__xcors = out;
        })().catch(function (e) { window.__xcors = { __fatal: String(e && (e.stack || e)) }; });
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/xph-img.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(solidPNG(8));
      return;
    }
    if (url.pathname === '/xph') {
      // Images that arrive as markup in a frame the worker does not control (an ad frame written with
      // document.write, a srcdoc frame) or in a plain document, from another origin: how big do they end up?
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>placeholders</title><body><div id="top"></div><script>
        window.__xph = null;
        (async function () {
          var other = location.protocol + '//' + (location.hostname === 'localhost' ? '127.0.0.1' : 'localhost') + ':' + location.port;
          var src = function (t) { return other + '/xph-img.png?tag=' + t; };
          var markup = function (t) { return '<body><img id="i" width="40" height="40" src="' + src(t) + '">'; };
          var written = document.createElement('iframe');
          document.body.appendChild(written);
          var d = written.contentDocument;
          d.open(); d.write(markup('written')); d.close();
          var srcdoc = document.createElement('iframe');
          srcdoc.srcdoc = markup('srcdoc');
          document.body.appendChild(srcdoc);
          document.getElementById('top').innerHTML = markup('top');
          var nested = document.createElement('iframe');
          document.body.appendChild(nested);
          var inner = nested.contentDocument;
          inner.open(); inner.write('<body><div id="slot"></div>'); inner.close();
          inner.getElementById('slot').innerHTML = markup('nested');
          await new Promise(function (r) { setTimeout(r, 5000); });
          var size = function (doc) { var i = doc && doc.getElementById('i'); return i ? i.naturalWidth + 'x' + i.naturalHeight : 'none'; };
          window.__xph = { written: size(written.contentDocument), srcdoc: size(srcdoc.contentDocument), top: size(document), nested: size(nested.contentDocument) };
        })().catch(function (e) { window.__xph = { __fatal: String(e && (e.stack || e)) }; });
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/xnullish') {
      // The rewritten member operations on a null or undefined receiver throw what the engine throws.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>nullish</title><body><script>
        window.__xnullish = null;
        var uncaught = [];
        addEventListener('error', function (e) { uncaught.push([e.message, e.filename === location.href ? 'page' : e.filename, typeof e.lineno]); });
        var cases = {
          'get location': function (n) { return n.location; },
          'get href': function (n) { return n.href; },
          'get document': function (n) { return n.document.title; },
          'get top': function (n) { return n.top; },
          'chain': function (n) { return n.location.href; },
          'set href': function (n) { n.href = 'x'; return 'ok'; },
          'set location': function (n) { n.location = 'x'; return 'ok'; },
          'update href': function (n) { n.href++; return 'ok'; },
          'compound href': function (n) { n.href += 'x'; return 'ok'; },
          'logical href': function (n) { n.href ||= 'x'; return 'ok'; },
          'call postMessage': function (n) { return n.postMessage('x', '*'); },
          'call open': function (n) { return n.open(); },
          'delete location': function (n) { return delete n.location; },
          'in location': function (n) { return 'location' in n; },
          'keys': function (n) { return Object.keys(n); },
          'names': function (n) { return Object.getOwnPropertyNames(n); },
          'descriptor': function (n) { return Object.getOwnPropertyDescriptor(n, 'location'); },
          'ownKeys': function (n) { return Reflect.ownKeys(n); },
          'Reflect.has': function (n) { return Reflect.has(n, 'location'); },
          'Reflect.get plain': function (n) { return Reflect.get(n, 'foo'); },
          'Reflect.set plain': function (n) { return Reflect.set(n, 'foo', 'x'); },
          'Reflect.get computed': function (n) { var k = 'x'; return Reflect.get(n, k); },
          'Reflect.set computed': function (n) { var k = 'x'; return Reflect.set(n, k, 1); },
          'optional get': function (n) { return n?.location; },
          'optional chain': function (n) { return n?.href.x; },
          'optional call': function (n) { return n?.postMessage('x'); },
          'optional delete': function (n) { return delete n?.location; },
          'plain prop': function (n) { return n.foo; },
          'plain call': function (n) { return n.foo(); }
        };
        var out = {};
        [['null', null], ['undefined', undefined], ['object', {}], ['number', 5]].forEach(function (rec) {
          Object.keys(cases).forEach(function (name) {
            var key = rec[0] + ' / ' + name;
            if (rec[0] === 'number' && !/^Reflect/.test(name)) return; // primitives are fine for member operations; only Reflect.* refuses them
            if (rec[0] === 'object' && /call/.test(name)) return; // the message V8 gives for calling a non-function differs by the helper's name (ERRATA residual)
            try { var r = cases[name](rec[1]); out[key] = 'ok:' + (typeof r === 'object' && r !== null ? 'object' : String(r)).slice(0, 24); }
            catch (e) { out[key] = (e && e.name) + ': ' + (e && e.message) + ' | ' + (e instanceof TypeError); }
          });
        });
        setTimeout(function () { var n = null; n.href; }, 0);
        setTimeout(function () { var u; u.location = 'x'; }, 10);
        setTimeout(function () { window.__xnullish = { out: out, uncaught: uncaught }; }, 400);
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/xscr-probe.js') {
      xckSeen.set('scr:' + url.searchParams.get('run') + ':' + url.searchParams.get('tag'), 'seen');
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      res.end('/* probe */');
      return;
    }
    if (url.pathname === '/xscr-seen') {
      const prefix = 'scr:' + url.searchParams.get('run') + ':';
      const out = [];
      for (const k of xckSeen.keys()) if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out.sort()));
      return;
    }
    if (url.pathname === '/xscr-frame') {
      // A document that asks for a script and an image; whether each is requested depends on the frame's sandbox.
      const q = 'run=' + url.searchParams.get('run') + '&tag=' + url.searchParams.get('tag');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>f</title><body><script src="/xscr-probe.js?' + q + '-script"></script><img src="/xscr-probe.js?' + q + '-img">');
      return;
    }
    if (url.pathname === '/xscr') {
      // Which requests a frame's document makes under each sandbox: scripts that may not run are still requested.
      const run = url.searchParams.get('run');
      const variants = [['m-empty', 'sandbox=""'], ['m-same', 'sandbox="allow-same-origin"'], ['m-forms', 'sandbox="allow-forms"'], ['m-scripts', 'sandbox="allow-scripts"'], ['m-scripts-same', 'sandbox="allow-scripts allow-same-origin"'], ['m-none', '']];
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>scriptless frames</title><body>' +
        variants.map(v => '<iframe ' + v[1] + ' src="/xscr-frame?run=' + run + '&tag=' + v[0] + '"></iframe>').join('') +
        '<div id="host"></div><script>(function () {' +
        ' [["d-empty", ""], ["d-same", "allow-same-origin"], ["d-scripts", "allow-scripts"]].forEach(function (v) {' +
        '  var f = document.createElement("iframe"); f.setAttribute("sandbox", v[1]); f.src = "/xscr-frame?run=' + run + '&tag=" + v[0]; document.body.appendChild(f); });' +
        ' document.getElementById("host").innerHTML = \'<iframe sandbox="" src="/xscr-frame?run=' + run + '&tag=h-empty"></iframe>\';' +
        ' })();<\/script></body>');
      return;
    }
    if (url.pathname === '/xcorsel-child') {
      // A sandboxed document without allow-same-origin: its origin is opaque, so its crossorigin images say `Origin: null`.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>opaque</title><body><script>
        (async function () {
          var q = new URLSearchParams(location.search);
          var other = q.get('other'), rid = q.get('rid'), po = q.get('po');
          var out = {};
          function load(name, cs) {
            return new Promise(function (resolve) {
              var i = new Image();
              i.crossOrigin = 'anonymous';
              var t = setTimeout(function () { out[name] = 'timeout'; resolve(); }, 15000);
              i.onload = function () { clearTimeout(t); out[name] = 'load'; resolve(); };
              i.onerror = function () { clearTimeout(t); out[name] = 'error'; resolve(); };
              i.src = other + '/xcors-api?tag=' + encodeURIComponent(rid + ':' + name) + '&case=' + cs + '&po=' + encodeURIComponent(po) + '&as=img';
            });
          }
          await load('o-origin', 'acao-origin');
          await load('o-star', 'acao-star');
          await load('o-null', 'acao-null');
          await load('o-missing', 'acao-missing');
          parent.postMessage('xcorsel:' + JSON.stringify(out), '*');
        })();
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/xcorsel') {
      // The same rules for what the page does not fetch() itself: images, scripts, modules, stylesheets and fonts
      // that ask for CORS (crossorigin, module scripts, FontFace and @font-face), the credentials they ask for,
      // redirects, a srcdoc frame and an opaque frame.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>CORS elements</title><body><script>
        window.__xcorsel = null;
        window.__xcel = {};
        (async function () {
          var out = {};
          var rid = Math.random().toString(36).slice(2, 10);
          var po = location.origin;
          var other = location.protocol + '//' + (location.hostname === 'localhost' ? '127.0.0.1' : 'localhost') + ':' + location.port;
          function api(base, name, cs, as, extra) {
            return base + '/xcors-api?tag=' + encodeURIComponent(rid + ':' + name) + '&case=' + cs + '&po=' + encodeURIComponent(po) + '&as=' + as + '&cn=xce' + (extra || '');
          }
          function settle(el) {
            return new Promise(function (resolve) {
              var t = setTimeout(function () { resolve('timeout'); }, 15000);
              el.onload = function () { clearTimeout(t); resolve('load'); };
              el.onerror = function () { clearTimeout(t); resolve('error'); };
            });
          }
          async function img(name, cs, attr, extra) {
            var i = new Image();
            if (attr !== null) i.crossOrigin = attr;
            var p = settle(i);
            i.src = api(other, name, cs, 'img', extra);
            out[name] = await p;
          }
          async function script(name, cs, attr, module, extra) {
            var s = document.createElement('script');
            if (module) s.type = 'module';
            if (attr !== null) s.crossOrigin = attr;
            var p = settle(s);
            s.src = api(other, name, cs, 'js', extra);
            document.head.appendChild(s);
            var r = await p;
            out[name] = r + (window.__xcel[rid + ':' + name] ? '+ran' : '');
          }
          async function css(name, cs, attr) {
            var l = document.createElement('link');
            l.rel = 'stylesheet';
            if (attr !== null) l.crossOrigin = attr;
            var p = settle(l);
            l.href = api(other, name, cs, 'css');
            document.head.appendChild(l);
            out[name] = await p;
          }
          async function font(name, cs, base) {
            try {
              var f = new FontFace('f' + name.replace(/[^a-z0-9]/gi, ''), 'url(' + api(base || other, name, cs, 'font') + ')');
              await f.load();
              out[name] = 'loaded';
            } catch (e) { out[name] = 'err:' + e.name; }
          }
          async function fontCSS(name, cs) {
            var fam = 'g' + name.replace(/[^a-z0-9]/gi, '');
            var st = document.createElement('style');
            st.textContent = '@font-face{font-family:"' + fam + '";src:url("' + api(other, name, cs, 'font') + '")}';
            document.head.appendChild(st);
            try { var r = await document.fonts.load('12px "' + fam + '"'); out[name] = 'loaded:' + r.length; }
            catch (e) { out[name] = 'err:' + e.name; }
          }
          await (await fetch(api(other, 'set-cookie', 'setcookie', 'txt'), { credentials: 'include' })).text();
          // images
          await img('i-anon-acao', 'acao-origin', 'anonymous');
          await img('i-anon-star', 'acao-star', 'anonymous');
          await img('i-anon-missing', 'acao-missing', 'anonymous');
          await img('i-anon-null', 'acao-null', 'anonymous');
          await img('i-anon-other', 'acao-other', 'anonymous');
          await img('i-plain-missing', 'acao-missing', null);
          await img('i-creds-ok', 'acao-origin-creds', 'use-credentials');
          await img('i-creds-star', 'acao-star', 'use-credentials');
          await img('i-creds-noacac', 'acao-origin', 'use-credentials');
          await img('i-anon-cookie', 'acao-origin', 'anonymous');
          await img('i-plain-cookie', 'acao-missing', null);
          await img('i-redir-ok', 'redir', 'anonymous', '&loc=' + encodeURIComponent(api(other, 'i-redir-ok:b', 'acao-origin', 'img')));
          await img('i-redir-noacao', 'redir', 'anonymous', '&noacao=1&loc=' + encodeURIComponent(api(other, 'i-redir-noacao:b', 'acao-origin', 'img')));
          await img('i-redir-self-star', 'redir', 'anonymous', '&loc=' + encodeURIComponent(api(po, 'i-redir-self-star:b', 'acao-star', 'img')));
          await img('i-redir-self-origin', 'redir', 'anonymous', '&loc=' + encodeURIComponent(api(po, 'i-redir-self-origin:b', 'acao-origin', 'img')));
          // the document's own origin: nothing to check, whatever the target says
          async function same(name, as, make) {
            var u = api(po, name, 'same', as);
            out[name] = await make(u);
          }
          await same('i-same', 'img', function (u) { var i = new Image(); i.crossOrigin = 'anonymous'; var p = settle(i); i.src = u; return p; });
          await same('s-same', 'js', function (u) { var s = document.createElement('script'); s.crossOrigin = 'anonymous'; var p = settle(s); s.src = u; document.head.appendChild(s); return p; });
          await same('m-same', 'js', function (u) { var s = document.createElement('script'); s.type = 'module'; var p = settle(s); s.src = u; document.head.appendChild(s); return p; });
          await same('c-same', 'css', function (u) { var l = document.createElement('link'); l.rel = 'stylesheet'; l.crossOrigin = 'anonymous'; var p = settle(l); l.href = u; document.head.appendChild(l); return p; });
          // scripts and modules
          await script('s-anon-acao', 'acao-origin', 'anonymous', false);
          await script('s-anon-missing', 'acao-missing', 'anonymous', false);
          await script('s-plain-missing', 'acao-missing', null, false);
          await script('s-creds-ok', 'acao-origin-creds', 'use-credentials', false);
          await script('s-creds-star', 'acao-star', 'use-credentials', false);
          await script('m-acao', 'acao-origin', null, true);
          await script('m-star', 'acao-star', null, true);
          await script('m-missing', 'acao-missing', null, true);
          // stylesheets
          await css('c-anon-acao', 'acao-origin', 'anonymous');
          await css('c-anon-missing', 'acao-missing', 'anonymous');
          await css('c-plain-missing', 'acao-missing', null);
          // fonts: the FontFace API and an @font-face rule
          await font('f-acao', 'acao-origin');
          await font('f-star', 'acao-star');
          await font('f-missing', 'acao-missing');
          await font('f-same', 'same', po);
          await fontCSS('fc-acao', 'acao-origin');
          await fontCSS('fc-missing', 'acao-missing');
          // an opaque frame: Origin is "null"
          var got = null;
          addEventListener('message', function (e) { if (typeof e.data === 'string' && e.data.indexOf('xcorsel:') === 0) got = JSON.parse(e.data.slice(8)); });
          var fr = document.createElement('iframe');
          fr.setAttribute('sandbox', 'allow-scripts');
          fr.src = '/xcorsel-child?rid=' + encodeURIComponent(rid) + '&other=' + encodeURIComponent(other) + '&po=' + encodeURIComponent(po);
          document.body.appendChild(fr);
          for (var k = 0; k < 300 && !got; k++) await new Promise(function (r) { setTimeout(r, 100); });
          out.opaque = got || 'no report';
          out.__log = await (await fetch('/xcors-log?prefix=' + encodeURIComponent(rid + ':'))).json();
          window.__xcorsel = out;
        })().catch(function (e) { window.__xcorsel = { __fatal: String(e && (e.stack || e)) }; });
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/xpopop-popup') {
      // A popup of a sandboxed frame says what it is.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>popup</title><script>' +
        'var R = {};' +
        'function op(k, f) { try { var v = f(); R[k] = v === null ? "null" : (typeof v === "object" || typeof v === "function") ? typeof v : String(v).slice(0, 60); } catch (e) { R[k] = "threw:" + (e && e.name); } }' +
        'op("self.origin", function () { return self.origin; });' +
        'op("location.pathname", function () { return location.pathname; });' +
        'op("localStorage", function () { localStorage.setItem("zpop", "1"); return localStorage.getItem("zpop"); });' +
        'op("sessionStorage", function () { return sessionStorage.length; });' +
        'op("document.cookie", function () { return document.cookie.split("; ").filter(function (c) { return c.indexOf("xpopck=") === 0; }).join("; "); });' +
        'op("indexedDB.open", function () { return indexedDB.open("x"); });' +
        'op("caches", function () { return caches; });' +
        'op("serviceWorker", function () { return navigator.serviceWorker; });' +
        'op("document.domain", function () { return document.domain; });' +
        'op("opener.document", function () { return opener.document; });' +
        'op("opener.location.href", function () { return opener.location.href; });' +
        'op("opener is parent", function () { return parent === window && top === window; });' +
        'op("frameElement", function () { return frameElement; });' +
        'try { opener.postMessage("xpop:" + JSON.stringify(R), "*"); } catch (e) {}' +
        '<\/script>');
      return;
    }
    if (url.pathname === '/xpopop-child') {
      const flags = url.searchParams.get('flags') || '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>popup opener</title><script>' +
        'var got = null;' +
        'addEventListener("message", function (e) { if (typeof e.data === "string" && e.data.indexOf("xpop:") === 0 && !got) { got = JSON.parse(e.data.slice(5)); } });' +
        'var w = null; try { w = open("/xpopop-popup"); } catch (e) {}' +
        'function after(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }' +
        'function poll(n) { return got || n <= 0 ? Promise.resolve() : after(100).then(function () { return poll(n - 1); }); }' +
        '(w ? poll(150) : Promise.resolve()).then(function () { return after(500); }).then(function () {' +
        '  var H = {};' +
        '  H.opened = w ? "yes" : "no";' +
        '  try { H.handleDocument = typeof w.document; } catch (e) { H.handleDocument = "threw:" + e.name; }' +
        '  try { H.handleLocation = w ? String(w.location.href).slice(0, 5) : "null"; } catch (e) { H.handleLocation = "threw:" + e.name; }' +
        '  try { H.handleClosed = String(w.closed); } catch (e) { H.handleClosed = "threw:" + e.name; }' +
        '  try { w.close(); } catch (e) {}' +
        '  parent.postMessage("xpopop:" + JSON.stringify({ report: got, handle: H }), "*");' +
        '});' +
        '<\/script>');
      return;
    }
    if (url.pathname === '/xpopop') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Popups of sandboxed frames</title><body><script>
        window.__xpopop = null;
        (async function () {
          var out = {};
          document.cookie = 'xpopck=1; path=/';
          var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
          var variants = [['opaque popup', 'allow-scripts allow-popups'], ['escaping popup', 'allow-scripts allow-popups allow-popups-to-escape-sandbox'], ['no popups', 'allow-scripts']];
          for (var v = 0; v < variants.length; v++) {
            var got = null;
            var handler = function (e) { if (typeof e.data === 'string' && e.data.indexOf('xpopop:') === 0) got = JSON.parse(e.data.slice(7)); };
            addEventListener('message', handler);
            var f = document.createElement('iframe'); f.setAttribute('sandbox', variants[v][1]); f.src = '/xpopop-child'; document.body.appendChild(f);
            for (var i = 0; i < 300 && !got; i++) await sleep(100);
            removeEventListener('message', handler);
            out[variants[v][0]] = got || 'no report';
            f.remove();
          }
          window.__xpopop = out;
        })().catch(function (e) { window.__xpopop = { __fatal: String(e && (e.stack || e)) }; });
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/xsbchild') {
      // A sandboxed document (no allow-same-origin) tells what it can touch and what it can reach. One
      // page for every way of making the frame; ?egress=1 also tries the network.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>sandbox child</title><body><script>
        var R = {}, jobs = [];
        var show = function (v) { return v === null ? 'null' : v === undefined ? 'undefined' : (typeof v === 'object' || typeof v === 'function') ? typeof v : String(v).slice(0, 60); };
        var op = function (k, fn, into) {
          var o = into || R;
          try {
            var v = fn();
            if (v && typeof v.then === 'function') jobs.push(v.then(function (x) { o[k] = 'resolved:' + show(x); }, function (e) { o[k] = 'rejected:' + (e && e.name); }));
            else o[k] = show(v);
          } catch (e) { o[k] = 'threw:' + (e && e.name); }
        };
        op('self.origin', function () { return self.origin; });
        op('location.origin', function () { return location.origin; });
        op('location.pathname', function () { return location.pathname; });
        op('isSecureContext', function () { return self.isSecureContext; });
        op('localStorage', function () { return localStorage; });
        op('sessionStorage', function () { return sessionStorage; });
        op('document.cookie', function () { return document.cookie; });
        op('document.cookie=', function () { document.cookie = 'sb=1'; return 'no throw'; });
        op('indexedDB.open', function () { return indexedDB.open('x'); });
        op('indexedDB.databases', function () { return indexedDB.databases(); });
        op('caches', function () { return caches; });
        op('cookieStore.getAll', function () { return cookieStore.getAll(); });
        op('storage.estimate', function () { return navigator.storage.estimate(); });
        op('storage.getDirectory', function () { return navigator.storage.getDirectory(); });
        op('locks.request', function () { return navigator.locks.request('x', function () { return 1; }); });
        op('locks.query', function () { return navigator.locks.query(); });
        op('serviceWorker', function () { return navigator.serviceWorker; });
        op('Notification.permission', function () { return Notification.permission; });
        op('permissions.query', function () { return navigator.permissions.query({ name: 'geolocation' }).then(function (s) { return s.state; }); });
        op('document.domain', function () { return document.domain; });
        op('window.name', function () { return window.name; });
        op('parent.document', function () { return parent.document; });
        op('parent.location.href', function () { return parent.location.href; });
        op('top.location.href', function () { return top.location.href; });
        op('top.document', function () { return top.document; });
        op('frameElement', function () { return frameElement; });
        op('window.frameElement', function () { return window.frameElement; });
        op('self.frameElement', function () { return self.frameElement; });
        op('globalThis.frameElement', function () { return globalThis.frameElement; });
        op('alias.frameElement', function () { var w = window; return w.frameElement; });
        op('typeof frameElement', function () { return typeof frameElement; });
        op('opener', function () { return opener; });
        op('window.open', function () { var w = window.open('about:blank'); try { if (w) w.close(); } catch (e) {} return w; });
        op('alert', function () { return alert('x'); });
        op('top.location.assign', function () { top.location.assign('http://example.invalid/'); return 'no throw'; });
        if (location.search.indexOf('egress=1') >= 0) op('history.pushState', function () { history.pushState({}, '', '#x'); return location.hash; });
        op('createElement iframe sandbox length', function () { return document.createElement('iframe').sandbox.length; });
        op('postMessage parent', function () { parent.postMessage('hello', '*'); return 'ok'; });
        op('own blank frame contentDocument', function () { var f = document.createElement('iframe'); document.body.appendChild(f); return f.contentDocument === null ? 'null' : 'object'; });
        op('own blank frame contentWindow.document', function () { var f = document.createElement('iframe'); document.body.appendChild(f); return typeof f.contentWindow.document; });
        op('own srcdoc frame', function () { var f = document.createElement('iframe'); f.srcdoc = '<p>x</p>'; document.body.appendChild(f); return f.contentDocument === null ? 'null' : 'object'; });
        op('sibling frame document', function () { var s = parent.frames[parent.frames.length - 1]; return s === window ? 'self' : typeof s.document; });
        if (location.search.indexOf('egress=1') >= 0) {
          jobs.push(new Promise(function (r) {
            var i = new Image();
            i.onload = function () { R['egress.img'] = 'load'; r(); };
            i.onerror = function () { R['egress.img'] = 'error'; r(); };
            i.src = '/image-probe.png?sb=' + Math.random().toString(36).slice(2);
          }));
          jobs.push(new Promise(function (r) {
            try {
              var w = new WebSocket('ws://' + location.host + '/ws?sb=1');
              w.onopen = function () { R['egress.ws'] = 'open'; w.close(); r(); };
              w.onerror = function () { R['egress.ws'] = 'error'; r(); };
              setTimeout(function () { if (!R['egress.ws']) { R['egress.ws'] = 'timeout'; r(); } }, 6000);
            } catch (e) { R['egress.ws'] = 'threw:' + e.name; r(); }
          }));
          op('egress.beacon', function () { return navigator.sendBeacon('/xsb-beacon', 'x'); });
          // What the sandbox's own rules allow, tried by every route a script has. Natively several of these
          // fail on CORS grounds (the origin is "null"); what matters here is where they go — the
          // upstream sees each one only if it came through the proxy, and the suite's last test fails the
          // run if anything left for another origin. Outcomes are not compared.
          jobs.push(fetch('/xsb-egress-fetch').then(function () {}, function () {}));
          jobs.push(new Promise(function (r) { try { var x = new XMLHttpRequest(); x.open('GET', '/xsb-egress-xhr'); x.onloadend = function () { r(); }; x.send(); } catch (e) { r(); } }));
          jobs.push(new Promise(function (r) { var s = document.createElement('script'); s.onload = s.onerror = function () { r(); }; s.src = '/xsb-egress-script.js'; document.head.appendChild(s); }));
          jobs.push(new Promise(function (r) { var l = document.createElement('link'); l.rel = 'stylesheet'; l.onload = l.onerror = function () { r(); }; l.href = '/xsb-egress-style.css'; document.head.appendChild(l); }));
          jobs.push(import('/xsb-egress-module.js').then(function () {}, function () {}));
          jobs.push(new Promise(function (r) {
            try {
              var wu = URL.createObjectURL(new Blob(['fetch("/xsb-egress-worker").then(function () {}, function () {}); postMessage("ran");']));
              var wk = new Worker(wu);
              wk.onmessage = function () { r(); };
              wk.onerror = function () { r(); };
              setTimeout(r, 6000);
            } catch (e) { r(); }
          }));
        }
        var send = function () { parent.postMessage('sb:' + JSON.stringify(R), '*'); };
        Promise.all(jobs).then(function () { setTimeout(send, 400); });
        addEventListener('message', function (m) {
          if (m.data !== 'go') return;
          var N = {};
          op('top.location.href=', function () { top.location.href = '/xsb-nav-top'; return 'no throw'; }, N);
          op('top.location.replace', function () { top.location.replace('/xsb-nav-top2'); return 'no throw'; }, N);
          op('parent.location.href=', function () { parent.location.href = '/xsb-nav-parent'; return 'no throw'; }, N);
          op('self.location.hash=', function () { location.hash = '#self'; return location.hash; }, N);
          setTimeout(function () { parent.postMessage('sbnav:' + JSON.stringify(N), '*'); }, 600);
        });
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/xsandbox') {
      // Sandboxed frames, made every way a page can make one. Each reports from inside; the page
      // reads what it can of them. Values are the fixture's own strings.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Sandboxed frames</title><body><script>
        window.__xsandbox = null;
        (async function () {
          var out = {};
          var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
          var got = [];
          addEventListener('message', function (e) {
            if (typeof e.data === 'string' && e.data.indexOf('sb:') === 0) got.push({ source: e.source, origin: e.origin, data: JSON.parse(e.data.slice(3)) });
          });
          var norm = function (o) { return Object.keys(o).sort().map(function (k) { return k + '=' + o[k]; }).join('\\n'); };
          var reportOf = function (f) {
            var r = got.filter(function (g) { try { return g.source === f.contentWindow; } catch (e) { return false; } })[0];
            return r ? 'origin=' + r.origin + '\\n' + norm(r.data) : 'no report';
          };
          var wait = async function (f, ms) {
            for (var t0 = Date.now(); Date.now() - t0 < ms && reportOf(f) === 'no report'; ) await sleep(100);
            await sleep(300);
          };
          var variant = async function (name, build, ms) {
            var h = document.createElement('div'); document.body.appendChild(h);
            var f = build(h);
            await wait(f, ms === undefined ? 15000 : ms);
            out[name + '.connected'] = String(f.isConnected);
            out[name + '.contentDocument'] = f.contentDocument === null ? 'null' : typeof f.contentDocument;
            out[name + '.report'] = reportOf(f);
            return f;
          };
          var mk = function (setup) { return function (h) { var f = document.createElement('iframe'); setup(f); h.appendChild(f); return f; }; };
          var CHILD = '/xsbchild';
          var a = await variant('attr', mk(function (f) { f.setAttribute('sandbox', 'allow-scripts'); f.src = CHILD + '?egress=1'; }));
          out['attr.sandbox'] = a.getAttribute('sandbox') + '|' + a.sandbox.value + '|' + a.sandbox.length + '|' + a.sandbox.contains('allow-same-origin') + '|' + a.sandbox.contains('allow-scripts');
          out['attr.outerHTML'] = a.outerHTML;
          out['attr.contentWindow.document'] = (function () { try { return typeof a.contentWindow.document; } catch (e) { return 'threw:' + e.name; } })();
          out['attr.contentWindow.location'] = (function () { try { return String(a.contentWindow.location.href); } catch (e) { return 'threw:' + e.name; } })();
          out['attr.contentWindow.length'] = (function () { try { return String(a.contentWindow.length); } catch (e) { return 'threw:' + e.name; } })();
          await variant('property', mk(function (f) { f.sandbox = 'allow-scripts'; f.src = CHILD; }));
          await variant('tokens', mk(function (f) { f.sandbox.add('allow-scripts'); f.src = CHILD; }));
          await variant('src first', mk(function (f) { f.src = CHILD; f.setAttribute('sandbox', 'allow-scripts'); }));
          await variant('parsed', function (h) { h.innerHTML = '<iframe sandbox="allow-scripts" src="' + CHILD + '"></iframe>'; return h.firstChild; });
          await variant('insertAdjacentHTML', function (h) { h.insertAdjacentHTML('beforeend', '<iframe sandbox="allow-scripts" src="' + CHILD + '"></iframe>'); return h.firstChild; });
          await variant('srcdoc', mk(function (f) {
            f.setAttribute('sandbox', 'allow-scripts');
            f.srcdoc = '<script>parent.postMessage("sb:" + JSON.stringify({ ran: "srcdoc", origin: self.origin }), "*")<\\/script>';
          }));
          await variant('parsed srcdoc', function (h) {
            // The attribute value is built, not written: an inline script's text is entity-decoded by the
            // membrane (a documented trade-off), so no entity may stand in this source.
            var inner = '<script>parent.postMessage("sb:" + JSON.stringify({ ran: "parsed srcdoc", origin: self.origin }), "*")<\\/script>';
            var attr = inner.replace(/&/g, '&' + 'amp;').replace(/"/g, '&' + 'quot;');
            h.innerHTML = '<iframe sandbox="allow-scripts" srcdoc="' + attr + '"></iframe>';
            return h.firstChild;
          });
          await variant('inert', mk(function (f) { f.setAttribute('sandbox', ''); f.src = CHILD; }), 2500);
          await variant('forms and popups', mk(function (f) { f.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups'); f.src = CHILD; }));
          var h2 = document.createElement('div'); document.body.appendChild(h2);
          var s1 = document.createElement('iframe'); s1.setAttribute('sandbox', 'allow-scripts'); s1.src = CHILD; h2.appendChild(s1);
          var s2 = document.createElement('iframe'); s2.setAttribute('sandbox', 'allow-scripts'); s2.src = CHILD; h2.appendChild(s2);
          await wait(s1, 15000); await wait(s2, 15000);
          out['sibling.first'] = reportOf(s1);
          out['sibling.second'] = reportOf(s2);
          // Navigating the top window or the embedder is the sandbox's to refuse.
          var run = async function (flags) {
            var nf = document.createElement('iframe'); nf.setAttribute('sandbox', flags); nf.src = CHILD; document.body.appendChild(nf);
            await wait(nf, 15000);
            var navGot = null;
            var onNav = function (e) { if (typeof e.data === 'string' && e.data.indexOf('sbnav:') === 0 && e.source === nf.contentWindow) navGot = e.data.slice(6); };
            addEventListener('message', onNav);
            nf.contentWindow.postMessage('go', '*');
            for (var t1 = Date.now(); !navGot && Date.now() - t1 < 8000; ) await sleep(100);
            removeEventListener('message', onNav);
            return navGot ? norm(JSON.parse(navGot)) : 'none';
          };
          out['nav.scripts'] = await run('allow-scripts');
          out['nav.userActivation'] = await run('allow-scripts allow-top-navigation-by-user-activation');
          out['nav.pathAfter'] = location.pathname;
          window.__xsandbox = out;
        })().catch(function (e) { window.__xsandbox = { __fatal: String(e && (e.stack || e)) }; });
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/xsetcookie') {
      // Answers with a Set-Cookie for the name in ?n=: ?httponly=1, ?maxage=0 and
      // ?redirect=1 (the cookie rides on the redirect, the final page sets none).
      const n = url.searchParams.get('n') || 'xsrf';
      const attrs = 'Path=/' + (url.searchParams.get('httponly') ? '; HttpOnly' : '') + (url.searchParams.get('maxage') !== null ? '; Max-Age=' + url.searchParams.get('maxage') : '');
      if (url.searchParams.get('redirect')) {
        res.writeHead(302, { 'Location': '/xsetcookie-final', 'Set-Cookie': n + '=tok; ' + attrs, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': n + '=' + (url.searchParams.get('v') || 'tok') + '; ' + attrs });
      res.end('ok');
      return;
    }
    if (url.pathname === '/xsetcookie-final') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('final');
      return;
    }
    if (url.pathname === '/xcookie') {
      // Cookies a SERVER sets in answer to the page's own fetch / XHR: a script reads
      // them (an anti-forgery token, a session marker) the moment the promise
      // resolves. Cookie names are the fixture's own; nothing else is read.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Server-set cookies</title><body><script>
        window.__xcookie = null;
        (async function () {
          var out = {};
          var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
          var names = function () { return document.cookie.split('; ').filter(Boolean).map(function (c) { return c.split('=')[0]; }).filter(function (n) { return n.indexOf('ck_') === 0; }).sort().join(','); };
          var val = function (n) { var m = document.cookie.split('; ').filter(function (c) { return c.split('=')[0] === n; })[0]; return m ? m.slice(n.length + 1) : 'absent'; };
          var changes = [];
          if (self.cookieStore) cookieStore.addEventListener('change', function (e) { (e.changed || []).forEach(function (c) { changes.push('set:' + c.name); }); (e.deleted || []).forEach(function (c) { changes.push('del:' + c.name); }); });
          // The browser starts delivering change events a moment after the first listener
          // is added — a cookie set before that is not reported natively.
          await sleep(500);
          await fetch('/xsetcookie?n=ck_fetch');
          out['fetch.visible'] = val('ck_fetch');
          await fetch('/xsetcookie?n=ck_fetch_ho&httponly=1');
          out['fetch.httpOnly.visible'] = val('ck_fetch_ho');
          out['xhr.visible'] = await new Promise(function (res) { var x = new XMLHttpRequest(); x.open('GET', '/xsetcookie?n=ck_xhr'); x.onloadend = function () { res(val('ck_xhr')); }; x.send(); });
          await fetch('/xsetcookie?n=ck_redirect&redirect=1');
          out['redirect.visible'] = val('ck_redirect');
          await fetch('/xsetcookie?n=ck_omit', { credentials: 'omit' });
          out['omit.visible'] = val('ck_omit');
          await fetch('/xsetcookie?n=ck_update&v=one');
          await fetch('/xsetcookie?n=ck_update&v=two');
          out['update.value'] = val('ck_update');
          await fetch('/xsetcookie?n=ck_gone');
          out['gone.before'] = val('ck_gone');
          await fetch('/xsetcookie?n=ck_gone&maxage=0');
          out['gone.after'] = val('ck_gone');
          out['store.get'] = self.cookieStore ? ((await cookieStore.get('ck_fetch')) ? 'present' : 'absent') : 'n/a';
          document.cookie = 'ck_script=1';
          var echoed = await (await fetch('/cookie-echo')).text();
          out['sent.back'] = ['ck_fetch', 'ck_xhr', 'ck_redirect', 'ck_update', 'ck_script'].every(function (n) { return echoed.indexOf(n + '=') >= 0; }) && echoed.indexOf('ck_omit=') < 0 && echoed.indexOf('ck_gone=') < 0 ? 'as expected' : 'unexpected';
          await sleep(300);
          out['names'] = names();
          out['changes'] = changes.slice().sort().join(',');
          window.__xcookie = out;
        })().catch(function (e) { window.__xcookie = { __fatal: String(e && (e.stack || e)) }; });
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/xstore-child') {
      // A frame that writes storage when asked and reports every storage event it hears.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>store child</title><script>' +
        'var ev = [];' +
        'addEventListener("storage", function (e) { ev.push({ k: e.key, o: e.oldValue, n: e.newValue, area: e.storageArea === localStorage ? "local" : e.storageArea === sessionStorage ? "session" : "other", trusted: e.isTrusted, sameSiteUrl: !!e.url && new URL(e.url).origin === location.origin }); });' +
        'addEventListener("message", function (m) {' +
        '  var d = m.data;' +
        '  if (d === "write") { localStorage.setItem("k_child", "v1"); sessionStorage.setItem("s_child", "v1"); }' +
        '  else if (d === "rewrite") { localStorage.setItem("k_child", "v1"); }' +
        '  else if (d === "update") { localStorage.setItem("k_child", "v2"); }' +
        '  else if (d === "remove") { localStorage.removeItem("k_child"); }' +
        '  else if (d === "report") parent.postMessage("store:" + JSON.stringify(ev), "*");' +
        '});' +
        '<\/script>');
      return;
    }
    if (url.pathname === '/xstore') {
      // Storage events across sites. Every proxied site shares one physical origin,
      // so the browser's own storage event reaches every frame of every site — with
      // the physical (prefixed) key and the other site's value. Values here are the
      // fixture's own keys and strings, nothing else.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Storage events</title><body><script>
        window.__xstore = null;
        (async function () {
          var out = {};
          var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
          var other = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
          var mine = [], viaHandler = [], got = {}, same = null, cross = null;
          var describe = function (e) {
            return [String(e.key), String(e.oldValue), String(e.newValue), e.storageArea === localStorage ? 'local' : e.storageArea === sessionStorage ? 'session' : 'other', String(e.isTrusted)].join('|');
          };
          window.addEventListener('storage', function (e) { mine.push(describe(e)); });
          window.onstorage = function (e) { viaHandler.push(e.key); };
          window.addEventListener('message', function (e) {
            if (typeof e.data === 'string' && e.data.indexOf('store:') === 0) {
              got[same && e.source === same.contentWindow ? 'same' : cross && e.source === cross.contentWindow ? 'cross' : 'other'] = e.data.slice(6);
            }
          });
          var mk = function (src) { var f = document.createElement('iframe'); f.src = src; document.body.appendChild(f); return f; };
          same = mk('/xstore-child');
          cross = mk('http://' + other + ':' + location.port + '/xstore-child');
          await sleep(1800);
          // The two areas deliver in no fixed order: compare a sorted snapshot.
          var snap = function () { var r = mine.slice().sort().join(','); mine.length = 0; return r; };
          mine.length = 0; viaHandler.length = 0;
          cross.contentWindow.postMessage('write', '*');
          await sleep(800);
          out['cross.write'] = snap();
          same.contentWindow.postMessage('write', '*');
          await sleep(800);
          out['same.write'] = snap();
          same.contentWindow.postMessage('rewrite', '*');
          await sleep(800);
          out['same.rewrite'] = snap();
          same.contentWindow.postMessage('update', '*');
          await sleep(800);
          out['same.update'] = snap();
          same.contentWindow.postMessage('remove', '*');
          await sleep(800);
          out['same.remove'] = snap();
          out['onstorage.keys'] = viaHandler.slice().sort().join(',');
          localStorage.setItem('k_parent', 'p1');
          sessionStorage.setItem('s_parent', 'p1');
          await sleep(800);
          same.contentWindow.postMessage('report', '*');
          cross.contentWindow.postMessage('report', '*');
          await sleep(900);
          var norm = function (json) { try { return JSON.parse(json).map(function (e) { return [String(e.k), String(e.o), String(e.n), e.area, String(e.trusted), String(e.sameSiteUrl)].join('|'); }).sort().join(','); } catch (x) { return 'none'; } };
          out['child.same.heard'] = norm(got.same);
          out['child.cross.heard'] = norm(got.cross);
          // An event the page builds and dispatches itself is its own business.
          var synth = '';
          window.addEventListener('storage', function once(e) { if (!e.isTrusted) { synth = e.key + '|' + e.newValue + '|' + String(e.storageArea); window.removeEventListener('storage', once); } });
          window.dispatchEvent(new StorageEvent('storage', { key: 'synthetic', newValue: 'x' }));
          out['synthetic'] = synth;
          window.__xstore = out;
        })().catch(function (e) { window.__xstore = { __fatal: String(e && (e.stack || e)) }; });
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/frame-loads') {
      // Frame load events and joint history. The proxy parks a frame on a blank
      // page while its route is prepared; the page must still see ONE load per
      // navigation and ONE history entry per change, as natively (2026-10-01:
      // an inline onload on a parsed iframe ran three times).
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Frame Loads</title><body>
      <iframe id="s1" src="/frame-plain" onload="window.__statOnload = (window.__statOnload || 0) + 1"></iframe>
      <iframe id="s2" src="/frame-plain?two"></iframe>
      <script>
        window.__frameLoads = null;
        var __l2 = 0;
        document.getElementById('s2').addEventListener('load', function () { __l2++; });
        (async function () {
          var out = {};
          var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
          var title = function (f) { try { var d = f.contentDocument; return d && d.readyState === 'complete' ? d.title : ''; } catch (e) { return '?'; } };
          // Wait for the destination, then a little longer: a stray late load is the bug.
          var settle = async function (f, want) {
            var t0 = Date.now();
            while (Date.now() - t0 < 8000 && title(f) !== want) await sleep(50);
            await sleep(500);
          };
          var counted = function () {
            var ev = []; var f = document.createElement('iframe');
            f.addEventListener('load', function () { ev.push('L'); });
            f.onload = function () { ev.push('o'); };
            return { f: f, ev: ev };
          };
          await settle(document.getElementById('s1'), 'fp');
          await settle(document.getElementById('s2'), 'fp');
          out.staticOnload = String(window.__statOnload || 0);
          out.staticListener = String(__l2);
          var a = counted(); a.f.src = '/frame-plain'; document.body.appendChild(a.f);
          await settle(a.f, 'fp'); out.srcBeforeAppend = a.ev.join('');
          var b = counted(); document.body.appendChild(b.f); b.f.src = '/frame-plain';
          await settle(b.f, 'fp'); out.srcAfterAppend = b.ev.join('');
          var c = counted(); document.body.appendChild(c.f); c.f.src = '/frame-plain'; c.f.src = '/frame-html';
          await settle(c.f, 'fh'); out.rapidSwap = c.ev.join('') + '|' + title(c.f);
          var d = counted(); d.f.src = '/frame-plain'; document.body.appendChild(d.f);
          await settle(d.f, 'fp');
          var h0 = history.length; d.f.src = '/frame-html';
          await settle(d.f, 'fh');
          out.srcChange = d.ev.join(''); out.historyDelta = String(history.length - h0);
          window.__frameLoads = out;
        })().catch(function (e) { window.__frameLoads = { __fatal: String(e && (e.stack || e)) }; });
      <\/script></body>`);
      return;
    }
    if (url.pathname === '/frame-outer') {
      // A frame holding a frame: the inner link targets _parent, so the OUTER
      // frame navigates — never the page around it.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>fo</title><iframe srcdoc="<a id=up href=\'/frame-plain\' target=_parent>up</a>"></iframe>');
      return;
    }
    if (url.pathname === '/frame-plain') {
      // None of html/head/body/script: the streaming transform had no anchor for
      // the prelude, so this document ran with no membrane at all.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>fp</title><p>plain</p>');
      return;
    }
    if (url.pathname === '/surface-probes') {
      // T1: 미검증 표면 실측 — transformer 잔여(importmap/speculationrules/
      // shadow DOM/SVG), transferable 누출, 명명 프레임 접근, 레거시 접근자,
      // 에러 이벤트 인자, a.ping, document.write 두 번째 문서, iframe 잔여.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Surface Probes</title><head>
      <script type="importmap">{"imports":{"x-mod":"/dyn-mod.js"}}<\/script>
      <script type="speculationrules">{"prefetch":[{"source":"list","urls":["/dyn-mod.js"]}]}<\/script>
      <link rel="stylesheet" href="/site.css">
      </head><body>
      <div id="sdhost"><template shadowrootmode="open"><img src="/dyn-mod.js" id="sdimg"><p>sd</p></template></div>
      <svg><image id="svgimg" href="/dyn-mod.js"/><a id="svga" xlink:href="/dyn-mod.js"></a></svg>
      <script>
        window.__surfaceProbes = {};
        window.__surfaceErrs = [];
        window.addEventListener('error', e => { window.__surfaceErrs.push('err:' + e.filename + '|' + e.lineno + '|' + e.message); });
        window.addEventListener('unhandledrejection', e => { window.__surfaceErrs.push('rej:' + String(e.reason && e.reason.stack || e.reason)); });
        let ZXC7 = 7;   // cross-script lexical — 다음 스크립트에서 보이는가
        var ZXC8 = 8;   // cross-script var — 전역 프로퍼티로 지속되어야 함
        const ZXC9 = 9; // cross-script const — 지속 + 쓰기 TypeError
        class ZXC10 {}  // cross-script class — 지속
      <\/script>
      <script>
        (async () => {
          const out = window.__surfaceProbes;
          const P = async (k, fn) => { try { out[k] = 'v:' + (await fn()); } catch (e) { out[k] = 'threw:' + (e && e.name || e) + ':' + String(e && e.message || '').slice(0, 80); } };
          const tick = () => new Promise(r => setTimeout(r, 30));
          const leaked = s => s.includes('__zp_') || s.includes('/zp/api') || s.includes('proxy.localhost') || s.includes('worker-script');

          // ── T1-1: transformer 잔여 ──
          await P('importmapText', () => {
            const t = document.querySelector('script[type=importmap]').textContent;
            return t.includes('/zp/') ? 'rewritten' : 'raw';
          });
          await P('specrulesText', () => {
            const t = document.querySelector('script[type=speculationrules]').textContent;
            return t.includes('/zp/') ? 'rewritten' : 'raw';
          });
          await P('shadowDom', () => {
            const host = document.querySelector('#sdhost');
            if (!host.shadowRoot) return 'no-shadowroot';
            const img = host.shadowRoot.getElementById('sdimg');
            return img ? 'shadow-img:' + (leaked(img.getAttribute('src') || '') ? 'LEAK' : 'clean') : 'no-img';
          });
          await P('svgImage', () => {
            const a = document.querySelector('#svgimg').getAttribute('href');
            return leaked(a || '') ? 'LEAK:' + a : 'clean:' + a;
          });
          await P('svgAnchor', () => {
            const a = document.querySelector('#svga').getAttribute('xlink:href');
            return leaked(a || '') ? 'LEAK:' + a : 'clean:' + a;
          });

          // ── T1-2: transferable/clone 누출 ──
          await P('cloneLocation', () => {
            try { const c = structuredClone(location); return 'cloned:' + String(c && c.href || c); }
            catch (e) { return 'threw:' + e.name; }
          });
          await P('weakRefLocation', () => {
            const w = new WeakRef(location);
            const d = w.deref();
            return d === location ? 'same-proxy' : 'other:' + String(d && d.href);
          });
          await P('portMsgLocation', async () => {
            const c = new MessageChannel();
            const got = new Promise(r => { c.port2.onmessage = e => r(e.data); });
            try { c.port1.postMessage(location); } catch (e) { return 'threw:' + e.name; }
            const v = await Promise.race([got, tick().then(() => 'timeout')]);
            if (v === 'timeout') return 'timeout';
            return v === location ? 'same-proxy' : 'other:' + (v && v.href ? String(v.href) : typeof v);
          });
          await P('cloneDocument', () => {
            try { structuredClone(document); return 'cloned'; } catch (e) { return 'threw:' + e.name; }
          });
          await P('cloneWindow', () => {
            try { structuredClone(window); return 'cloned'; } catch (e) { return 'threw:' + e.name; }
          });

          // ── T1-3: 명명/인덱스 프레임 접근 ──
          const nf = document.createElement('iframe');
          nf.name = 'nf'; nf.srcdoc = '<p>nfx</p>';
          document.body.appendChild(nf);
          await (async () => { for (let i = 0; i < 100; i++) { try { if (nf.contentDocument && nf.contentDocument.body && nf.contentDocument.body.textContent.includes('nfx')) return; } catch {} await new Promise(r => setTimeout(r, 20)); } })();
          await P('framesByName', () => {
            const d = '|attr:' + nf.getAttribute('name') + '|cw:' + (nf.contentWindow ? 'y' : 'n');
            const w = frames['nf'];
            if (!w) return 'undefined' + d;
            return (leaked(String(w.location.href)) ? 'LEAK:' + w.location.href : 'clean:' + w.location.href) + d;
          });
          await P('framesItem', () => {
            const w = frames.item(0);
            if (!w) return 'undefined';
            return leaked(String(w.location.href)) ? 'LEAK' : 'clean';
          });
          await P('selfIndex', () => {
            const w = self[0];
            if (!w) return 'undefined';
            return leaked(String(w.location.href)) ? 'LEAK' : 'clean';
          });
          await P('thisIndex', () => {
            const w = this[0];
            if (!w) return 'undefined';
            return leaked(String(w.location.href)) ? 'LEAK' : 'clean';
          });
          await P('windowByName', () => {
            const w = window['nf'];
            if (!w) return 'undefined';
            return leaked(String(w.location.href)) ? 'LEAK:' + w.location.href : 'clean:' + w.location.href;
          });

          // ── T1-4: 레거시 접근자 ──
          await P('defineGetterLoc', () => {
            try { window.__defineGetter__('location', () => 'fake'); return 'installed|href:' + location.href.slice(0, 40); }
            catch (e) { return 'threw:' + e.name; }
          });
          await P('defineSetterLoc', () => {
            try { window.__defineSetter__('location', v => { window.__setterTrap = v; }); return 'installed'; }
            catch (e) { return 'threw:' + e.name; }
          });
          await P('lookupGetterLoc', () => {
            const g = window.__lookupGetter__('location');
            if (g === undefined) return 'none';
            return leaked(String(g)) ? 'LEAK' : 'fn';
          });
          await P('lookupSetterLoc', () => {
            const s = window.__lookupSetter__('location');
            if (s === undefined) return 'none';
            return leaked(String(s)) ? 'LEAK' : 'fn';
          });

          // ── T1-5: 에러 인자/ownKeys ──
          await P('ownKeysLeak', () => {
            // Harness bindings Puppeteer injects into the page it drives are not ours.
            const ks = Object.getOwnPropertyNames(window).filter(k => !/^(__aria|puppeteer)/.test(k));
            const bad = ks.filter(k => k.indexOf('zp') === 0 || k.includes('__zp'));
            return bad.length ? 'LEAK:' + bad.slice(0, 5).join(',') : 'clean:' + ks.length;
          });
          try { eval('nonexistent_xyz()'); } catch {}
          Promise.reject(new Error('surf-rej'));
          setTimeout(() => { throw new Error('surf-uncaught'); }, 10);
          await new Promise(r => setTimeout(r, 120));

          // ── T1-6: a.ping + import.meta.resolve ──
          // ping setter 는 값을 WeakMap 에 삼키고 실속성을 지운다 — 클릭할
          // 필요 없이 속성 상태로 검증한다 (클릭은 페이지를 네비게이션시킨다).
          await P('anchorPing', () => {
            const a = document.createElement('a');
            a.href = '/ping-dest';
            a.ping = 'https://evil.example/track';
            document.body.appendChild(a);
            const attr = a.getAttribute('ping');
            const marker = a.getAttribute('data-zp-blocked-ping');
            const prop = a.ping;
            return 'attr:' + attr + '|marker:' + (marker || 'none') + '|prop:' + prop;
          });

          // ── T1-7: document.write 두 번째 문서 ──
          await P('docWriteFrame', async () => {
            const f = document.createElement('iframe');
            document.body.appendChild(f);
            await new Promise(r => setTimeout(r, 100));
            f.contentDocument.open();
            f.contentDocument.write('<scr' + 'ipt>window.__dwLoc = String(location.href); parent.__dwChild = window.__dwLoc;</scr' + 'ipt><p>dwx</p>');
            f.contentDocument.close();
            await new Promise(r => setTimeout(r, 200));
            const v = window.__dwChild;
            if (v === undefined) return 'script-inert';
            return leaked(String(v)) ? 'LEAK:' + v : 'clean:' + v;
          });

          // ── T1-8: iframe 잔여 ──
          await P('iframeCspAttr', () => {
            const f = document.createElement('iframe');
            f.setAttribute('csp', "default-src 'none'");
            f.srcdoc = '<p>c</p>';
            document.body.appendChild(f);
            return 'attr:' + (f.getAttribute('csp') || 'stripped');
          });
          await P('iframeCredentialless', () => {
            const f = document.createElement('iframe');
            f.credentialless = true;
            f.srcdoc = '<p>cl</p>';
            document.body.appendChild(f);
            return 'set';
          });
          // ── 명명 타깃 내비게이션 (2026-10-01) ──
          // A named target used to load the '?via=' LAUNCHER into the proxied
          // frame, which never reached the target. Reading only the frame's URL
          // passed anyway — 'via=' decodes to the target — so every probe here
          // waits for the destination DOCUMENT (/frame-dest is a text/plain 404).
          const frameDoc = f => { try { const d = f.contentDocument; return d && d.readyState === 'complete' && d.body ? d : null; } catch { return null; } };
          const landed = async (f, path) => {
            const t0 = Date.now();
            let href = 'none';
            while (Date.now() - t0 < 8000) {
              try { href = f.contentWindow && f.contentWindow.location ? String(f.contentWindow.location.href) : 'none'; }
              catch (e) { return 'threw:' + e.name; }
              const d = href.includes(path) ? frameDoc(f) : null;
              if (d) return 'navigated:' + href + '|' + d.body.textContent.trim();
              await new Promise(r => setTimeout(r, 100));
            }
            return 'not-navigated:' + href;
          };
          const namedFrame = name => { const f = document.createElement('iframe'); f.name = name; document.body.appendChild(f); return f; };
          await P('targetFramename', async () => {
            const f = document.createElement('iframe');
            f.name = 'tfn'; f.srcdoc = '<p>home</p>';
            document.body.appendChild(f);
            const a = document.createElement('a');
            a.href = '/frame-dest'; a.target = 'tfn'; a.textContent = 'go';
            document.body.appendChild(a);
            a.click();
            return landed(f, '/frame-dest');
          });
          // setAttribute('target') used to be rewritten to '_self' (name stashed):
          // the link navigated the whole page and read back '_self'.
          await P('targetFramenameAttr', async () => {
            const f = namedFrame('tfn2');
            const a = document.createElement('a');
            a.setAttribute('href', '/frame-dest'); a.setAttribute('target', 'tfn2'); a.textContent = 'go';
            document.body.appendChild(a);
            a.click();
            return (await landed(f, '/frame-dest')) + '|' + a.getAttribute('target') + '|' + a.target;
          });
          await P('targetAttrReadback', () => {
            const a = document.createElement('a');
            a.setAttribute('target', '_blank');
            const area = document.createElement('area');
            area.setAttribute('target', '_top');
            const form = document.createElement('form');
            form.setAttribute('target', 'x');
            return [a.getAttribute('target'), a.target, area.target, form.target].join('|');
          });
          // A link in a nested frame targeting _parent moves the OUTER frame
          // (the inner frame's ancestor), through that frame's own membrane.
          await P('parentTargetLink', async () => {
            const outer = document.createElement('iframe');
            outer.src = '/frame-outer';
            document.body.appendChild(outer);
            const t0 = Date.now();
            let link = null;
            while (Date.now() - t0 < 8000 && !link) {
              try {
                const inner = frameDoc(outer) && frameDoc(outer).querySelector('iframe');
                const d = inner && inner.contentDocument;
                link = d && d.readyState === 'complete' ? d.getElementById('up') : null;
              } catch {}
              if (!link) await new Promise(r => setTimeout(r, 50));
            }
            if (!link) return 'no-link';
            link.click();
            return landed(outer, '/frame-plain');
          });
          // Forms honor target too: the result loads in the frame and this page
          // stays. They used to replace THIS document whatever the target.
          const targetForm = (name, method, action, field, value) => {
            const form = document.createElement('form');
            form.method = method; form.action = action; form.target = name;
            const i = document.createElement('input'); i.name = field; i.value = value;
            form.appendChild(i); document.body.appendChild(form);
            return form;
          };
          await P('formTargetGet', async () => {
            const f = namedFrame('ftg');
            targetForm('ftg', 'get', '/frame-plain', 'q', 'one two').submit();
            return landed(f, '/frame-plain');
          });
          await P('formTargetPost', async () => {
            const f = namedFrame('ftp');
            targetForm('ftp', 'post', '/post-echo', 'a', 'b c').submit();
            return landed(f, '/post-echo');
          });
          // A popup's final document matches native; the launcher it used to run
          // first is gone (raw while it redirected — see ERRATA item 27).
          await P('popupRouted', async () => {
            const w = window.open('/frame-plain', 'zp-popup-probe');
            if (!w) return 'blocked';
            const t0 = Date.now();
            let title = '';
            while (Date.now() - t0 < 8000 && title !== 'fp') {
              try { title = w.document && w.document.readyState === 'complete' ? w.document.title : ''; } catch (e) { title = 'threw:' + e.name; break; }
              await new Promise(r => setTimeout(r, 50));
            }
            let href = '', ev = '';
            try { href = String(w.location.href); } catch (e) { href = 'threw:' + e.name; }
            try { ev = String(w.eval('location.href')); } catch (e) { ev = 'threw:' + e.name; }
            try { w.close(); } catch {}
            return title + '|' + href + '|' + (leaked(ev) ? 'LEAK:' + ev : ev);
          });
          await P('baseTargetFrame', async () => {
            const f = namedFrame('btf');
            const b = document.createElement('base');
            b.setAttribute('target', 'btf');
            document.head.appendChild(b);
            const a = document.createElement('a');
            a.href = '/frame-dest'; a.textContent = 'go';
            document.body.appendChild(a);
            a.click();
            b.remove();
            return landed(f, '/frame-dest');
          });
          await P('namedOpen', async () => {
            const f = namedFrame('tfn3');
            const w = window.open('/frame-dest', 'tfn3');
            return (await landed(f, '/frame-dest')) + '|' + (w === f.contentWindow);
          });
          // A frame sent by contentWindow.location boots its own membrane. The
          // parent's next contentWindow read used to install ITS containment over
          // it, so the child's code read the parent's URL from then on.
          await P('childLocAssign', async () => {
            const f = document.createElement('iframe');
            document.body.appendChild(f);
            window.__fhSaw = ''; window.__fhLate = '';
            f.contentWindow.location.href = '/frame-html';
            const t0 = Date.now();
            while (!window.__fhLate && Date.now() - t0 < 8000) { void f.contentWindow; await new Promise(r => setTimeout(r, 50)); }
            let seen = 'none';
            try { seen = String(f.contentWindow.location.href); } catch (e) { seen = 'threw:' + e.name; }
            return window.__fhSaw + '|' + window.__fhLate + '|' + seen;
          });
          // Escapes (2026-10-01): each of these child windows used to run page
          // code RAW at the proxy origin — 'location' came back as the real
          // /zp/p/ URL or a bare about:blank.
          const plainFrame = async () => {
            const f = document.createElement('iframe');
            f.src = '/frame-plain';
            document.body.appendChild(f);
            const t0 = Date.now();
            while (Date.now() - t0 < 8000 && !(frameDoc(f) && frameDoc(f).title === 'fp')) await new Promise(r => setTimeout(r, 50));
            return f;
          };
          await P('routedPlainEval', async () => {
            const f = await plainFrame();
            const v = String(f.contentWindow.eval('location.href'));
            return leaked(v) ? 'LEAK:' + v : v;
          });
          await P('staleBlankEval', async () => {
            const f = await plainFrame();
            f.src = 'about:blank';
            const t0 = Date.now();
            while (Date.now() - t0 < 8000 && (!frameDoc(f) || frameDoc(f).title === 'fp')) await new Promise(r => setTimeout(r, 50));
            return String(f.contentWindow.eval('location.href'));
          });
          await P('pendingRouteEval', async () => {
            const f = document.createElement('iframe');
            f.src = '/frame-plain';
            document.body.appendChild(f);
            return String(f.contentWindow.eval('location.href'));
          });
          // ── explicit resource management: 'using' is a declaration the rewriter
          // must keep intact (it was an unverified ERRATA row until 2026-10-01).
          await P('usingDecl', () => { const log = []; { using r = { [Symbol.dispose]() { log.push('d'); } }; log.push('in'); } return log.join(','); });
          await P('awaitUsing', async () => { const log = []; { await using r = { async [Symbol.asyncDispose]() { log.push('ad'); } }; log.push('in'); } return log.join(','); });
          await P('usingEval', () => (0, eval)('{ const log = []; { using r = { [Symbol.dispose]() { log.push("d"); } }; log.push("in"); } log.join(","); }'));
          await P('usingFunction', () => new Function('const log = []; { using r = { [Symbol.dispose]() { log.push("d"); } }; } return log.join(",");')());
          await P('disposableStack', () => { const s = new DisposableStack(); const log = []; s.defer(() => log.push('x')); s.dispose(); return log.join(',') + '|' + s.disposed; });
          await P('childSharedWorker', async () => {
            const f = document.createElement('iframe');
            f.srcdoc = '<scr' + 'ipt>try{ parent.__childSW = "wrote"; const w = new SharedWorker("/sw-shared.js?name=child"); w.port.onmessage = e => parent.__childSW = String(e.data); w.onerror = e => parent.__childSW = "err:" + e.message; }catch(e){ parent.__childSW = "threw:" + e.name; }</scr' + 'ipt>';
            document.body.appendChild(f);
            await new Promise(r => setTimeout(r, 4000));
            const v = window.__childSW;
            return v === undefined ? 'silent' : (leaked(String(v)) ? 'LEAK:' + v : 'clean:' + v);
          });
          // ── T2-1: with(obj) 의미 — own dangerous name 이 obj 우선 ──
          await P('withShadow', () => {
            const fake = { href: 'fake-marker' };
            let r; with ({ location: fake }) r = location;
            return r === fake ? 'obj-first' : 'wrong:' + String(r && r.href);
          });
          await P('withDocIdentity', () => {
            let r; with (document) r = (location === window.location);
            return r ? 'identity-ok' : 'identity-broken';
          });
          await P('withDocWrite', () => {
            // document.location = '#frag' — PutForwards: 해시만 바뀌어야 한다.
            let r;
            with (document) { location = '#withfrag'; }
            r = location.hash === '#withfrag' ? 'forwarded' : 'swallowed:' + location.hash;
            return r;
          });
          await P('withEvalScope', () => {
            // eval 은 with 오브젝트를 못 본다 — 핀 divergence.
            let r; with ({ location: 'WITHOBJ' }) r = eval('typeof location === "string" ? location : "virtual"');
            return r;
          });
          // ── T2-2: 스코프 모델 — 선언이 있으면 로컬 바인딩 우선 ──
          await P('scopeHoistVar', () => {
            // var location 이 함수 끝에 선언돼도 호이스트 → 첫 읽기는 로컬 undefined.
            const f = function () { let x; try { x = location.href; var location; return 'read:' + x; } catch (e) { return 'threw:' + e.name; } };
            return f();
          });
          await P('scopeTDZ', () => {
            try { let r; { r = location.href; let location; } return 'read:' + r; } catch (e) { return 'threw:' + e.name; }
          });
          await P('scopeCatch', () => {
            try { throw 42; } catch (location) { return 'bound:' + location; }
          });
          await P('scopeDestructParam', () => {
            const f = function ({ location }) { return location; };
            return f({ location: 'dp' }) === 'dp' ? 'bound' : 'leaked';
          });
          // cross-script 바인딩 — 앞 스크립트의 let/var 지속성
          await P('crossScriptLet', () => typeof ZXC7);
          await P('crossScriptVar', () => typeof ZXC8 + ':' + ZXC8);
          // R1: let/const/class 도 공유 전역 렉시컬 환경에 지속된다.
          await P('crossScriptConst', () => ZXC9);
          await P('crossScriptClass', () => typeof ZXC10);
          await P('crossScriptLetWrite', () => { ZXC7 = 42; return ZXC7; });
          await P('crossScriptConstWrite', () => { ZXC9 = 1; return 'no-throw'; });
          await P('lexRedeclare', () => __surfaceErrs.filter(e => e.includes('has already been declared')).length);
          // direct eval 이 호출자 스코프의 로컬을 읽는가 (ERRATA: global만)
          await P('evalCallerScope', () => { const lc = 'LOCAL'; return eval('typeof lc === "string" ? lc : "global-only"'); });
          // R2 — direct eval 호출자 스코프 parity.
          await P('evalCallerWrite', () => { let w = 1; eval('w = 7'); return w; });
          await P('evalCallerVar', () => { const g = function () { var v = 'VV'; return eval('v'); }; return g(); });
          await P('evalCallerConst', () => { const g = function () { const c = 'C'; try { eval('c = 9'); return 'no-throw:' + c; } catch (e) { return e.name + ':' + c; } }; return g(); });
          await P('evalThis', () => { const o = { m: function () { return eval('this === this.__zp_sentinel ? "obj" : (this.marker || "other")'); }, marker: 'OBJMARK', __zp_sentinel: null }; o.__zp_sentinel = o; return o.m(); });
          await P('evalArgs', () => { const g = function () { return eval('arguments.length'); }; return g(1, 2, 3); });
          await P('evalNonString', () => JSON.stringify([eval(42), eval(null), eval({}) instanceof Object, eval()]));
          await P('evalVirtual', () => { const g = function () { const location = 'LOCALLOC'; return eval('location'); }; return g(); });
          await P('evalVirtualGlobal', () => eval('typeof location === "string" ? location : (location && location.hostname)'));
          // indirect 형태는 여전히 전역 — 로컬 lc 가 보이면 안 된다.
          await P('evalIndirectNoScope', () => { const lc = 'LOCAL'; const e = eval; return e('typeof lc === "string" ? lc : "global-only"'); });
          await P('evalOptionalNoScope', () => { const lc = 'LOCAL'; return eval?.('typeof lc === "string" ? lc : "global-only"'); });
          await P('evalShadowed', () => { const g = function () { const eval = s => 'shadow:' + s; return eval('x'); }; return g(); });
          // 함수 내부 sloppy Annex B / labeled 함수 선언 — strict 의미로 처리되어
          // 참조가 virtual 로 간다 (네이티브 sloppy 는 'function') — pinned divergence.
          await P('annexBSloppy', () => { const g = function () { if (1) { function location() { return 'fn'; } } return typeof location; }; return g(); });
          await P('labeledFnDecl', () => { const g = function () { lbl: function location() {} return typeof location; }; return g(); });
          // R3: sloppy eval 의 var 는 호출자 varEnv 에 생긴다 — 'number'.
          await P('evalVarLocal', () => { const g = function () { eval('var history = 1'); return typeof history; }; return g(); });
          // strict-mode with — 리라이터가 with 를 보존하므로 네이티브와
          // 동일하게 파스 시점 SyntaxError (silent rewrite 면 'no-error').
          await P('strictWith', () => { try { new Function('"use strict"; with({}){}'); return 'no-error'; } catch (e) { return e.name; } });
          // ── T2-8: CSS 잔여 — sheet.href 디프록시 + insertRule url() ──
          await P('sheetHref', () => {
            const s = document.styleSheets[0];
            return s ? String(s.href) : 'no-sheet';
          });
          await P('insertRuleUrl', async () => {
            const sh = new CSSStyleSheet();
            sh.replaceSync('#zpcssx{background:url(http://css-leak.example/a.png)}');
            // 매칭 엘리먼트가 있어야 브라우저가 실제 fetch 를 낸다 — wire 로
            // 프록시 경유 여부를 검증한다 (read-back 만으로는 미리라이트와
            // 구분이 안 된다).
            const d = document.createElement('div'); d.id = 'zpcssx';
            document.body.appendChild(d);
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, sh];
            await new Promise(r => setTimeout(r, 300));
            const css = sh.cssRules[0].cssText;
            document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== sh);
            d.remove();
            return css;
          });
          await P('styleAttrUrl', async () => {
            const d = document.createElement('div');
            d.style.cssText = 'background-image:url(http://css-leak.example/b.png)';
            document.body.appendChild(d);
            await new Promise(r => setTimeout(r, 200));
            const got = d.style.backgroundImage;
            d.remove();
            return got;
          });
          // ── T3-1: sealing — 외부 스킴/다이얼로그/동적 base ──
          await P('mailtoNav', () => {
            try { location.assign('mailto:probe@example.invalid'); return 'no-throw'; }
            catch (e) { return 'e:' + (e && e.name || e); }
          });
          await P('dialogStubs', () => {
            const a = alert('x'), c = confirm('x'), p = prompt('x', 'd');
            return 'alert:' + a + '|confirm:' + c + '|prompt:' + p;
          });
          await P('webAuthn', async () => {
            if (typeof PublicKeyCredential !== 'function' || !navigator.credentials) return 'absent';
            try {
              // headless 에서 authenticator 프롬프트가 멈출 수 있어 race 로 묶는다.
              const r = await Promise.race([
                navigator.credentials.create({ publicKey: {
                  challenge: new Uint8Array(32), rp: { name: 'x' },
                  user: { id: new Uint8Array(16), name: 'x', displayName: 'x' },
                  pubKeyCredParams: [{ type: 'public-key', alg: -7 }]
                }}).then(() => 'created').catch(e => 'e:' + (e && e.name || e)),
                new Promise(res => setTimeout(() => res('pending'), 2500))
              ]);
              return r;
            } catch (e) { return 'e:' + (e && e.name || e); }
          });
          await P('dynamicBase', () => {
            const b = document.createElement('base');
            b.href = 'http://evil-base.invalid/';
            document.head.appendChild(b);
            const r = document.baseURI;
            b.remove();
            return r;
          });
          // ── T3-2: identity/semantic parity ──
          await P('locIdentity', () => location === document.location);
          await P('optCallChain', () => String(({})?.location?.()) + '|' + String(null?.location?.()));
          await P('deleteLoc', () => String(delete window.location) + '|' + String(delete location));
          await P('newEval', () => { try { new eval(); return 'obj'; } catch (e) { return 'e:' + (e && e.name || e); } });
          await P('anchorLiteral', () => {
            const a = document.createElement('a');
            a.setAttribute('href', '/rel-x');
            return a.getAttribute('href');
          });
          // ── T4-1: 지문 잔여 표면 ──
          await P('consoleString', () => String(location));
          await P('perfNavEntry', () => {
            const e = performance.getEntriesByType('navigation')[0];
            return e ? e.name : 'none';
          });
          await P('realProps', () => [
            typeof performance.memory === 'object' ? 'mem' : 'no-mem',
            navigator.hardwareConcurrency, navigator.deviceMemory,
            document.characterSet, document.lastModified.slice(-4)
          ].join('|'));
          await P('swRegs', async () => {
            if (!navigator.serviceWorker) return 'no-sw';
            const rs = await navigator.serviceWorker.getRegistrations();
            return 'count:' + rs.length;
          });
          await P('registerPH', () => {
            if (typeof navigator.registerProtocolHandler !== 'function') return 'absent';
            try { navigator.registerProtocolHandler('web+zptest', 'http://localhost/x?u=%s'); return 'ok'; }
            catch (e) { return 'e:' + (e && e.name || e); }
          });
          // E4: 가상 오리진과 같은 URL 은 네이티브 검증을 통과한다 — 등록은
          // 브라우저 프롬프트에 프록시 오리진을 노출하므로 silent-success.
          await P('registerPHSameOrigin', () => {
            if (typeof navigator.registerProtocolHandler !== 'function') return 'absent';
            try { navigator.registerProtocolHandler('web+zptest', location.origin + '/x?u=%s'); return 'ok'; }
            catch (e) { return 'e:' + (e && e.name || e); }
          });
          // ── P0: 미감사 표면 — ShadowRealm/credentials/wasm/locks ──
          await P('shadowRealmEval', () => {
            if (typeof ShadowRealm !== 'function') return 'absent';
            try {
              const r = new ShadowRealm();
              // evaluate 내부에서 가상 location 을 건드릴 수 있는지 — 리라이트
              // 우회 여부가 핵심 (그냥 1+1 이 아니라 탈출 경로 실측).
              const v = r.evaluate('typeof location');
              return 'evaluated:' + v;
            } catch (e) { return 'e:' + (e && e.name || e); }
          });
          await P('shadowRealmImport', async () => {
            if (typeof ShadowRealm !== 'function') return 'absent';
            try {
              const r = new ShadowRealm();
              const v = await Promise.race([
                r.importValue('https://sr-leak.invalid/mod.js', 'x').then(() => 'imported').catch(e => 'e:' + (e && e.name || e)),
                new Promise(res => setTimeout(() => res('timeout'), 2500))
              ]);
              return v;
            } catch (e) { return 'e:' + (e && e.name || e); }
          });
          await P('credGet', async () => {
            if (!navigator.credentials || typeof navigator.credentials.get !== 'function') return 'absent';
            try {
              const c = await Promise.race([
                navigator.credentials.get({ password: true }),
                new Promise(res => setTimeout(() => res('pending'), 2500))
              ]);
              return 'got:' + (c ? (c.type || 'cred') : 'null');
            } catch (e) { return 'e:' + (e && e.name || e); }
          });
          await P('wasmStreamUrl', async () => {
            if (typeof WebAssembly === 'undefined' || typeof WebAssembly.instantiateStreaming !== 'function') return 'absent';
            try {
              const v = await Promise.race([
                WebAssembly.instantiateStreaming('https://wasm-leak.invalid/x.wasm').then(() => 'compiled').catch(e => 'e:' + (e && e.name || e)),
                new Promise(res => setTimeout(() => res('timeout'), 2500))
              ]);
              return v;
            } catch (e) { return 'e:' + (e && e.name || e); }
          });
          await P('navLocks', async () => {
            if (!navigator.locks || typeof navigator.locks.request !== 'function') return 'absent';
            try {
              const r = await navigator.locks.request('zp-lock-probe', () => 'held');
              return 'got:' + r;
            } catch (e) { return 'e:' + (e && e.name || e); }
          });
          // ── P4–P13: 가상 표면 감사 항목 ──
          await P('secureCtx', () => String(self.isSecureContext));
          await P('webkitURLAlias', () => typeof webkitURL === 'function' ? new webkitURL('/wk-page', location.href).href : 'absent:' + typeof webkitURL);
          await P('webkitIDB', () => typeof webkitIndexedDB !== 'undefined' && webkitIndexedDB === indexedDB ? 'alias' : 'not-alias:' + typeof webkitIndexedDB);
          await P('webkitFS', () => [typeof self.webkitRequestFileSystem, typeof self.webkitResolveLocalFileSystemURL, typeof self.webkitPersistentStorage, typeof self.webkitTemporaryStorage].join('|'));
          await P('fetchLaterType', () => typeof self.fetchLater);
          await P('fetchLaterCall', async () => {
            if (typeof self.fetchLater !== 'function') return 'absent';
            try {
              const r = await self.fetchLater('/compat-echo', { method: 'GET' });
              return 'activated:' + String(r && r.activated);
            } catch (e) { return 'e:' + (e && e.name || e); }
          });
          await P('opfsName', async () => {
            if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') return 'absent';
            const d = await navigator.storage.getDirectory();
            return 'name:' + d.name;
          });
          await P('customEl', async () => {
            if (typeof customElements === 'undefined') return 'absent';
            class XProbeEl extends HTMLElement {}
            customElements.define('x-probe-el', XProbeEl);
            const el = document.createElement('x-probe-el');
            document.body.appendChild(el);
            const found = document.querySelector('x-probe-el');
            const sameCtor = customElements.get('x-probe-el') === XProbeEl;
            const upgraded = el instanceof XProbeEl;
            const names = el.localName + '|' + el.tagName;
            const byTag = document.getElementsByTagName('x-probe-el').length;
            el.remove();
            return 'ctor:' + sameCtor + '|up:' + upgraded + '|names:' + names + '|qs:' + (found === el) + '|tag:' + byTag;
          });
          // P11b: 파스된 요소의 업그레이드 — GitHub catalyst 패턴 (2026-09-29).
          // define 전에 잡아 둔 요소가 그 자리에서 업그레이드되고(정체성 유지),
          // connectedCallback 의 closest(tag) 타깃 탐색·matches·CSS 타입 선택자가
          // 네이티브처럼 맞아야 한다. 타깃별 접두 레지스트리는 넷 다 깼다.
          await P('customElUpgrade', async () => {
            if (typeof customElements === 'undefined') return 'absent';
            const host = document.createElement('div');
            host.innerHTML = '<style>x-cat-el{display:block;width:7px}</style><x-cat-el><scr' + 'ipt type="application/json" data-target="x-cat-el.embeddedData">{"ok":1}</scr' + 'ipt></x-cat-el>';
            document.body.appendChild(host);
            const pre = host.querySelector('x-cat-el');
            let target = 'none';
            class XCatEl extends HTMLElement {
              connectedCallback() {
                const tag = this.tagName.toLowerCase();
                for (const t of this.querySelectorAll('[data-target~="' + tag + '.embeddedData"]')) if (t.closest(tag) === this) { target = t.textContent; break; }
              }
            }
            customElements.define('x-cat-el', XCatEl);
            const now = host.querySelector('x-cat-el');
            const r = 'same:' + (pre === now) + '|up:' + (pre instanceof XCatEl) + '|target:' + target + '|matches:' + now.matches('x-cat-el') + '|w:' + getComputedStyle(now).width;
            host.remove();
            return r;
          });
          await P('permGeo', async () => {
            if (!navigator.permissions || typeof navigator.permissions.query !== 'function') return 'absent';
            try { const s = await navigator.permissions.query({ name: 'geolocation' }); return 'state:' + s.state; }
            catch (e) { return 'e:' + (e && e.name || e); }
          });
          await P('paSurfaces', async () => [
            typeof self.sharedStorage,
            // browsingTopics 는 존재해도 빈 배열로 게이트된다(비차단 + 무자료).
            typeof document.browsingTopics === 'function' ? 'fn:' + JSON.stringify(await document.browsingTopics()) : typeof document.browsingTopics,
            typeof self.runAdAuction,
            typeof self.joinAdInterestGroup,
            typeof self.privateToken,
            typeof self.queryLocalFonts === 'function' ? 'fn-gated' : typeof self.queryLocalFonts
          ].join('|'));
          await P('setHTMLHook', () => {
            // 기본 Sanitizer 가 img 를 지우므로 a[href] 로 검증 — .href 게터는
            // 가상 베이스로 풀어야 변환이 먹힌 것.
            if (typeof document.createElement('div').setHTML !== 'function') return 'absent';
            const d = document.createElement('div');
            d.setHTML('<a href="/set-html-probe.png">x</a>');
            const a = d.querySelector('a');
            return a ? String(a.href) : 'no-a';
          });
          await P('parseHTMLUnsafeHook', () => {
            if (typeof Document.parseHTMLUnsafe !== 'function') return 'absent';
            const doc2 = Document.parseHTMLUnsafe('<a href="/parse-unsafe.png">x</a>');
            const a = doc2.querySelector('a');
            return a ? String(a.href) : 'no-a';
          });
          await P('getHTMLClean', () => {
            const d = document.createElement('div');
            const a = document.createElement('a');
            a.setAttribute('href', '/get-html-x');
            d.appendChild(a);
            if (typeof d.getHTML !== 'function') return 'absent';
            const ser = d.getHTML();
            return leaked(ser) ? 'LEAK:' + ser : 'clean:' + ser;
          });
          out.done = true;
        })().catch(e => { (window.__surfaceProbes = window.__surfaceProbes || {}).__fatal = String(e && (e.stack || e)); });
      <\/script>
      <script>let ZXC7 = 99; window.__redecl1 = true;<\/script>
      <script>var ZXC9 = 1; window.__redecl2 = true;<\/script>
      <script type="module">
        (window.__surfaceProbes = window.__surfaceProbes || {}).moduleRan = 'v:yes';
        try { const m = await import('x-mod'); window.__surfaceProbes.importmapBare = 'v:' + m.m + '|' + m.meta; }
        catch (e) { window.__surfaceProbes.importmapBare = 'threw:' + (e && e.name || e); }
        try { window.__surfaceProbes.importMetaResolve = 'v:' + String(import.meta.resolve('./x')); }
        catch (e) { window.__surfaceProbes.importMetaResolve = 'threw:' + (e && e.name || e) + ':' + String(e && e.message || '').slice(0, 80); }
        window.__surfaceProbes.moduleDone = true;
      <\/script>
      </body>`);
      return;
    }
    if (url.pathname === '/err-doc') {
      // T1-9: 500 에러 문서도 transformer 가 적용돼야 한다 — 인라인 스크립트가
      // 원문 그대로면 location 이 프록시를 찌른다.
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>err</title><body><script>window.__errDoc = String(location.href);<\/script></body>`);
      return;
    }
    if (url.pathname === '/trunc-doc') {
      // 잘린 HTML — 닫힘 태그 없이 끊겨도 transformer 결과여야 한다.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>trunc</title><body><script>window.__truncDoc = String(location.href);<\/script><div>`);
      return;
    }
    if (url.pathname === '/sw-shared.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      res.end(`self.onconnect = e => { e.ports[0].postMessage('sw:' + self.name + ':' + self.location.href); };`);
      return;
    }
    if (url.pathname === '/cross-origin-location-probe') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Cross-origin Location</title><script>
        let read;
        try { read = top.location.href; } catch (error) { read = error.name; }
        parent.postMessage({ type: 'cross-origin-location', read, replace: typeof top.location.replace }, '*');
      <\/script>`);
      return;
    }
    if (url.pathname === '/srcdoc-probe') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Srcdoc Probe</title><button id="navigate">Navigate top</button><script>
        const child = document.createElement('iframe');
        window.__srcdocProgress = [];
        window.addEventListener('message', event => {
          if (event.data && event.data.type === 'srcdoc-ready') window.__srcdocProbe = event.data;
          if (event.data && event.data.type === 'srcdoc-navigation') window.__srcdocProgress.push(event.data);
        });
        child.srcdoc = ${JSON.stringify(`<script>
          parent.postMessage({ type: 'srcdoc-ready', href: top.location.href, origin: top.location.origin }, '*');
          window.addEventListener('message', event => {
            if (event.data !== 'navigate-top') return;
            parent.postMessage({ type: 'srcdoc-navigation', stage: 'received' }, '*');
            try {
              top.location.href = 'http://127.0.0.1:${server.address().port}/next';
              parent.postMessage({ type: 'srcdoc-navigation', stage: 'requested' }, '*');
            } catch (error) {
              parent.postMessage({ type: 'srcdoc-navigation', stage: 'error', error: error.stack || String(error) }, '*');
            }
          });
        </script>`).replace(/</g, '\\u003c')};
        document.body.appendChild(child);
        document.querySelector('#navigate').addEventListener('click', () => {
          window.__srcdocSent = true;
          child.contentWindow.postMessage('navigate-top', '*');
        });
      </script>`);
      return;
    }
    if (url.pathname === '/rewrite-fixture.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`(() => {
        const NativeWebSocket = window.WebSocket;
        window.__rewriteAdvanced = { initialHref: window.location.href, constructorSource: NativeWebSocket.toString() };
        window.__runFragmentProbe = async () => {
          delete window.__rangeFragmentResult;
          const range = document.createRange();
          range.selectNodeContents(document.body);
          const fragment = range.createContextualFragment(${JSON.stringify(`<script>
            window.__rangeFragmentResult = fetch(new URL('/fragment-echo?href=' + encodeURIComponent(location.href), location.href))
              .then(response => response.json())
              .then(echo => ({ href: location.href, origin: location.origin, echo }));
          </script>`)});
          const beforeInsertion = window.__rangeFragmentResult === undefined;
          document.body.appendChild(fragment);
          return { beforeInsertion, result: await window.__rangeFragmentResult };
        };
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
    if (url.pathname === '/stream-trailers') {
      res.writeHead(200, { 'Content-Type': 'text/plain', Trailer: 'X-Stream-End' });
      res.write('payload');
      res.addTrailers({ 'X-Stream-End': 'yes' });
      res.end();
      return;
    }
    if (url.pathname === '/stream-bodyless') {
      const status = Number(url.searchParams.get('status') || 200);
      res.writeHead(status, status === 204 ? {} : { 'Content-Length': '123' });
      res.end();
      return;
    }
    if (url.pathname === '/stream-truncated') {
      req.socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 20\r\nConnection: close\r\n\r\nshort');
      return;
    }
    if (url.pathname === '/stream-gzip-truncated') {
      const compressed = gzipSync('gzip-payload');
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
      res.end(compressed.subarray(0, compressed.length - 4));
      return;
    }
    if (url.pathname === '/stream-cancel') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('first');
      req.socket.once('close', () => requests.push({ url: '/stream-cancel', canceled: true }));
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
  requests.push({ url: req.url, method: req.method, host: req.headers.host || '', userAgent: req.headers['user-agent'] || '', origin: req.headers.origin || '', cookie: req.headers.cookie || '', protocol: req.headers['sec-websocket-protocol'] || '', upgrade: true });
  const url = new URL(req.url, 'http://target.local');
  if (url.pathname !== '/ws') {
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
  const silentClose = url.searchParams.get('silent-close') === '1';
  if (silentClose) {
    // Upgraded HTTP sockets allow half-open TCP. Receiving FIN alone cannot
    // emit close until this peer also ends its writable half.
    socket.once('end', () => {
      requests.push({ url: req.url, socketEnded: true, at: Date.now() });
      socket.end();
    });
    socket.once('close', () => requests.push({ url: req.url, socketClosed: true, at: Date.now() }));
  }
  let buffered = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 2) {
      const frame = readWebSocketFrame(buffered);
      if (!frame) break;
      buffered = buffered.subarray(frame.consumed);
      if (frame.opcode === 0x8) {
        if (silentClose) {
          requests.push({ url: req.url, closeCode: frame.payload.readUInt16BE(0), closeReason: frame.payload.subarray(2).toString('utf8'), at: Date.now() });
          return;
        }
        writeWebSocketFrame(socket, 0x8, frame.payload);
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

test('built proxy browser contracts and E1 escape matrix', { timeout: 600000, concurrency: false }, async t => {
  const prebuilt = process.env.ZP_E2E_PREBUILT === '1' || Boolean(process.env.CI);
  const temp = prebuilt ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'zeroproxy-e2e-'));
  const buildOut = path.resolve(process.env.ZP_E2E_DIST || (prebuilt ? 'dist' : path.join(temp, 'dist')));
  const artifacts = path.resolve(process.env.ZP_E2E_ARTIFACTS || 'artifacts/e2e');
  fs.mkdirSync(artifacts, { recursive: true });
  let browser;
  let proxy;
  let proxyLog = '';
  const browserLog = [];
  const wireRequests = [];
  const responseHeaders = new Map();
  const sessions = new Map();
  const saveArtifacts = async (name, page) => {
    if (page && !page.isClosed()) {
      try { await page.screenshot({ path: path.join(artifacts, name + '.png') }); }
      catch (error) { browserLog.push('screenshot: ' + error.message); }
    }
    fs.writeFileSync(path.join(artifacts, 'browser.log'), browserLog.join('\n'));
    fs.writeFileSync(path.join(artifacts, 'server.log'), proxyLog);
    fs.writeFileSync(path.join(artifacts, 'browser-network.json'), JSON.stringify(wireRequests, null, 2));
  };
  t.after(async () => {
    try { await saveArtifacts('final', browser && (await browser.pages())[0]); }
    finally {
      try { if (browser) await browser.close(); }
      finally {
        if (proxy && proxy.pid && proxy.exitCode === null && proxy.signalCode === null) {
          await new Promise(resolve => {
            const timer = setTimeout(() => proxy.kill('SIGKILL'), 3000);
            proxy.once('exit', () => { clearTimeout(timer); resolve(); });
            proxy.kill('SIGTERM');
          });
        }
        if (temp) fs.rmSync(temp, { recursive: true, force: true });
      }
    }
  });
  if (!prebuilt) run('node', ['scripts/build.mjs', '--out', buildOut]);
  const serverPath = path.join(buildOut, process.platform === 'win32' ? 'zeroproxy-server.exe' : 'zeroproxy-server');
  const webPath = path.join(buildOut, 'web');
  for (const file of [serverPath, ...['index.html', 'sw.js', 'runtime-prelude.js', 'worker-prelude.js', 'zp-page-bundle.js', '__zp/zp_bundle_sw.js', '__zp/zp_bundle_sw_bg.wasm', '__zp/zp_kernel_sw.js', '__zp/zp_kernel_sw_bg.wasm', '__zp/zp_page_rt.wasm'].map(name => path.join(webPath, name))]) {
    assert.ok(fs.existsSync(file) && fs.statSync(file).size > 0, `required built artifact missing: ${file}; prebuilt mode never rebuilds`);
  }

  const requests = [];
  const pendingResponses = new Map();
  const target = createTargetServer(requests, pendingResponses);
  const targetPort = await listen(target);
  t.after(() => closeServer(target));
  t.after(() => fs.writeFileSync(path.join(artifacts, 'upstream.json'), JSON.stringify(requests, null, 2)));
  const targetHost = 'localhost';

  const proxyPort = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.once('error', reject);
  });
  proxy = childProcess.spawn(serverPath, ['-addr', `127.0.0.1:${proxyPort}`, '-web', webPath, '-socks', 'internal'], {
    cwd: path.resolve(__dirname, '../..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proxy.stdout.on('data', chunk => { proxyLog += chunk; });
  proxy.stderr.on('data', chunk => { proxyLog += chunk; });
  proxy.on('error', error => { proxyLog += '\nspawn: ' + error.message; });
  await waitForHTTP(`http://127.0.0.1:${proxyPort}/`).catch(err => {
    throw new Error(`${err.message}\nproxy output:\n${proxyLog}`);
  });

  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 30000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--host-resolver-rules=MAP proxy.localhost 127.0.0.1'],
  });
  const observeTarget = target => {
    if (sessions.has(target)) return sessions.get(target);
    const pending = (async () => {
      if (!['page', 'service_worker', 'shared_worker', 'worker'].includes(target.type())) return;
      const session = await target.createCDPSession();
      const reqUrls = new Map();
      session.on('Network.requestWillBeSent', event => { reqUrls.set(event.requestId, event.request.url); wireRequests.push(event.request.url); });
      session.on('Network.responseReceived', event => { if (event.response && event.response.headers) responseHeaders.set(event.response.url, event.response.headers); });
      session.on('Network.webSocketCreated', event => wireRequests.push(event.url));
      session.on('Network.loadingFailed', event => browserLog.push(`${target.type()} netfail ${reqUrls.get(event.requestId) || event.requestId} ${event.errorText} blocked=${event.blockedReason || ''} cors=${event.corsErrorStatus ? JSON.stringify(event.corsErrorStatus) : ''}`));
      session.on('Runtime.consoleAPICalled', event => browserLog.push(`${target.type()} ${event.type}: ${event.args.map(arg => arg.value ?? arg.description ?? '').join(' ')}`));
      session.on('Runtime.exceptionThrown', event => browserLog.push(JSON.stringify(event.exceptionDetails)));
      await session.send('Network.enable');
      await session.send('Runtime.enable');
    })();
    sessions.set(target, pending);
    return pending;
  };
  browser.on('targetcreated', target => { observeTarget(target).catch(error => browserLog.push('CDP: ' + error.message)); });
  await Promise.all(browser.targets().map(observeTarget));
  const proxyOrigin = `http://proxy.localhost:${proxyPort}`;
  await t.test('target-authored request compatibility', async t => {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    try {
      await observeTarget(page.target());
      await page.goto(proxyOrigin + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => navigator.serviceWorker?.controller && document.querySelector('#status')?.textContent === 'Ready.', { timeout: 30000 });
      await Promise.all(browser.targets().map(observeTarget));
      await page.type('#url', `http://${targetHost}:${targetPort}/compat/index`);
      await page.click('button');
      await page.waitForSelector('#methods', { visible: true, timeout: 30000 });
      await runRequestContract(t, page, `http://${targetHost}:${targetPort}`, requests, wireRequests, proxyOrigin, saveArtifacts);
    } finally {
      await saveArtifacts('request-final', page);
      await context.close();
    }
  });
  await t.test('rewritten module, receiver and transport regressions', { timeout: 150000 }, async t => {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const targetOrigin = `http://${targetHost}:${targetPort}`;
    const assertPublicHeaders = headers => {
      assert.equal(headers['x-zp-body-stream'], undefined);
      assert.equal(headers['x-zp-stream'], undefined);
      assert.equal(headers['x-fixture'], 'preserved');
    };
    try {
      await observeTarget(page.target());
      await page.goto(proxyOrigin + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => navigator.serviceWorker?.controller && document.querySelector('#status')?.textContent === 'Ready.', { timeout: 30000 });
      await page.type('#url', targetOrigin + '/regressions');
      await page.click('button');
      await page.waitForSelector('#regressions', { timeout: 30000 });

      await t.test('static imports and inserted modules share one evaluation across history changes', async () => {
        await page.waitForFunction(() => window.__moduleIdentityFixture, { timeout: 30000 });
        const result = await page.evaluate(() => window.__moduleIdentityFixture);
        const initial = { evaluations: 1, evaluationCount: 1, sameSingleton: true, href: targetOrigin + '/regressions' };
        const changed = { ...initial, href: targetOrigin + '/regressions/changed?view=2' };
        assert.deepEqual(result, { initial, dynamic: initial, afterHistory: changed, repeated: changed, classic: [initial.href, changed.href] });
        const scripts = wireRequests.map(value => new URL(value)).filter(url => url.pathname === '/zp/api/script');
        const dependencyURLs = scripts.filter(url => url.searchParams.get('u') === targetOrigin + '/module-singleton.js');
        assert.deepEqual([...new Set(dependencyURLs.map(url => url.href))], [proxyOrigin + '/zp/api/script?u=' + encodeURIComponent(targetOrigin + '/module-singleton.js') + '&kind=module']);
        assert.equal(requests.filter(request => request.url === '/module-singleton.js').length, 1);
        const classicURLs = scripts.filter(url => url.searchParams.get('u') === targetOrigin + '/classic-ref.js');
        assert.deepEqual([...new Set(classicURLs.map(url => url.searchParams.get('ref')))], [initial.href, changed.href]);
      });

      await t.test('native Window receivers work without binding page functions or constructors', async () => {
        await page.waitForFunction(() => window.__receiverFixture, { timeout: 30000 });
        assert.deepEqual(await page.evaluate(() => window.__receiverFixture), {
          clonedValue: 7, cycle: true, independent: true, order: ['sync', 'microtask'],
          pageFunctionSame: true, pageReceiver: 'custom-receiver', constructorSame: true,
          constructed: true, constructedValue: 11, nativeURL: targetOrigin + '/receiver-child', nativeInstance: true,
        });
      });

      await t.test('silent peer close deadline closes the upstream socket exactly once', { timeout: 70000 }, async () => {
        // Invoke target-authored, rewritten code; polling never holds a CDP call
        // across the real 30-second SW deadline or changes the production timer.
        await page.evaluate(() => window.__startSilentCloseFixture());
        const deadline = Date.now() + 60000;
        let result;
        do {
          result = await page.evaluate(() => window.__silentCloseFixture);
          if (result.closes.length && requests.some(request => request.url === '/ws?silent-close=1' && request.socketClosed)) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        assert.equal(result.opened, true);
        assert.equal(result.closingState, 2);
        assert.equal(result.closes.length, 1, JSON.stringify(result));
        const { elapsed, ...closed } = result.closes[0];
        assert.deepEqual(closed, { code: 1006, reason: '', wasClean: false, readyState: 3 });
        assert.ok(elapsed >= 29000 && elapsed < 60000, `close deadline elapsed ${elapsed}ms`);
        const peerCloses = requests.filter(request => request.url === '/ws?silent-close=1' && request.closeCode);
        assert.equal(peerCloses.length, 1);
        assert.equal(peerCloses[0].closeCode, 3001);
        assert.equal(peerCloses[0].closeReason, 'unanswered');
        const peerEOFs = requests.filter(request => request.url === '/ws?silent-close=1' && request.socketEnded);
        assert.equal(peerEOFs.length, 1, 'the proxy must deliver TCP EOF before the fixture closes its half');
        assert.ok(peerEOFs[0].at - peerCloses[0].at >= 29000, 'upstream EOF arrived before the close-handshake deadline');
        const physicalCloses = requests.filter(request => request.url === '/ws?silent-close=1' && request.socketClosed);
        assert.equal(physicalCloses.length, 1, 'deadline must close the upstream socket, not only the page facade');
        assert.ok(physicalCloses[0].at - peerCloses[0].at >= 29000, 'upstream closed before allowing the peer its close-handshake deadline');
        await new Promise(resolve => setTimeout(resolve, 250));
        assert.equal((await page.evaluate(() => window.__silentCloseFixture.closes)).length, 1);
      });

      await t.test('hostile markers cannot escape a buffered non-HTML response', async () => {
        await page.evaluate(() => window.__startReservedFetchFixture('buffered'));
        await page.waitForFunction(() => window.__reservedFetchFixture.done || window.__reservedFetchFixture.error, { timeout: 30000 });
        const result = await page.evaluate(() => window.__reservedFetchFixture);
        assert.equal(result.error, undefined);
        assert.equal(result.status, 200);
        assert.equal(result.done, true);
        assert.equal(result.body, 'buffered-complete\n');
        assertPublicHeaders(Object.fromEntries(result.headers));
      });

      await t.test('hostile markers preserve progressive raw bytes and terminal EOF', async () => {
        try {
          await page.evaluate(() => window.__startReservedFetchFixture('raw'));
          await page.waitForFunction(() => window.__reservedFetchFixture.body.endsWith('</p>\n') || window.__reservedFetchFixture.error, { timeout: 30000 });
          const first = await page.evaluate(() => window.__reservedFetchFixture);
          assert.equal(first.error, undefined);
          assert.equal(first.status, 200);
          assert.equal(first.body, '<!doctype html><p>raw-first</p>\n');
          assert.equal(first.done, false, 'first bytes must arrive while the upstream body is still open');
          assertPublicHeaders(Object.fromEntries(first.headers));
          assert.ok(pendingResponses.has('raw'));
          pendingResponses.get('raw').end('raw-last\n');
          await page.waitForFunction(() => window.__reservedFetchFixture.done || window.__reservedFetchFixture.error, { timeout: 30000 });
          const finished = await page.evaluate(() => window.__reservedFetchFixture);
          assert.equal(finished.error, undefined);
          assert.equal(finished.done, true);
          assert.equal(finished.body, '<!doctype html><p>raw-first</p>\nraw-last\n');
        } finally {
          pendingResponses.get('raw')?.destroy();
        }
      });

      await t.test('hostile markers do not turn a truncated body into successful EOF', async () => {
        await page.evaluate(() => window.__startReservedFetchFixture('truncated'));
        await page.waitForFunction(() => window.__reservedFetchFixture.done || window.__reservedFetchFixture.error, { timeout: 30000 });
        const result = await page.evaluate(() => window.__reservedFetchFixture);
        assert.equal(result.done, false);
        assert.ok(result.error, 'truncated body must reject its reader');
      });

      await t.test('hostile markers preserve progressive HTML rendering and completion', async () => {
        try {
          const responsePromise = page.waitForResponse(response => response.request().isNavigationRequest() && response.frame()?.parentFrame() === page.mainFrame(), { timeout: 30000 });
          await page.evaluate(() => window.__startReservedHTMLFixture());
          const response = await responsePromise;
          assert.equal(response.status(), 200);
          assertPublicHeaders(response.headers());
          await page.waitForFunction(() => {
            const first = document.querySelector('#reserved-frame')?.contentDocument?.getElementById('reserved-first');
            return first?.textContent === 'html-first' && first.getBoundingClientRect().height > 0;
          }, { timeout: 30000 });
          const first = await page.evaluate(() => {
            const doc = document.querySelector('#reserved-frame').contentDocument;
            return { last: doc.getElementById('reserved-last')?.textContent || null, readyState: doc.readyState };
          });
          assert.deepEqual(first, { last: null, readyState: 'loading' });
          assert.ok(pendingResponses.has('html'));
          pendingResponses.get('html').end('<p id="reserved-last">html-last</p></body></html>');
          await page.waitForFunction(() => document.querySelector('#reserved-frame')?.contentDocument?.readyState === 'complete', { timeout: 30000 });
          assert.deepEqual(await page.evaluate(() => {
            const doc = document.querySelector('#reserved-frame').contentDocument;
            return [doc.getElementById('reserved-first')?.textContent, doc.getElementById('reserved-last')?.textContent];
          }), ['html-first', 'html-last']);
        } finally {
          pendingResponses.get('html')?.destroy();
        }
      });
    } finally {
      await saveArtifacts('compatibility-regressions', page);
      await context.close();
    }
  });
  // The budget only caps a hang. It was 180 s while the matrix took ~110 s
  // unloaded, so a busy machine (a toolchain upgrade running beside it took the
  // suite 3-5x longer) failed the whole block on time alone.
  await t.test('E1 escape matrix and runtime integrations', { timeout: 420000 }, async t => {
  const page = await browser.newPage();
  t.after(async () => { await saveArtifacts('e1', page); await page.close(); });
  await observeTarget(page.target());
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
    urlAttributes: window.__urlAttributeFixture,
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
    faviconProbe: (() => {
      const el = document.getElementById('icon-link');
      const hrefAttr = el && el.attributes.getNamedItem('href');
      return el && {
        rel: el.getAttribute('rel'),
        href: el.getAttribute('href'),
        hrefProp: el.href,
        hrefAttrValue: hrefAttr && hrefAttr.value,
        outerHTML: el.outerHTML,
      };
    })(),
  }));
  fs.writeFileSync(path.join(artifacts, 'e1-home.json'), JSON.stringify(home, null, 2));
  const TARGET_UA = home.userAgent;
  const homeProxyURL = page.url();
  await t.test('home navigation and fingerprint identity', () => {
  assert.equal(home.title, 'E2E Home');
  assert.match(home.hash, /^#k=/);
  assert.equal(home.shellVisible, false);
  assert.match(TARGET_UA, /^Mozilla\/5\.0 .*Chrome\/\d+\.0\.0\.0 Safari\//);
  assert.doesNotMatch(TARGET_UA, /HeadlessChrome|proxy\.localhost/);
  assert.equal(home.appVersion, TARGET_UA.replace(/^Mozilla\//, ''));
  assert.equal(home.platform, 'Win32');
  assert.match(home.href, new RegExp(`^http://proxy\\.localhost:${proxyPort}/zp/p/`));
  });
  await t.test('template link suppression preserves DOM absence', () => {
  assert.deepEqual(home.templateLink, {
    childCount: 1,
    firstNode: 'link',
    rel: null,
    href: null,
    blockedRel: null,
    blockedURL: null,
    cloneRel: null,
    cloneHref: null,
    tableRowNode: 'TR',
    tableRowText: 'cell',
  });
  });
  for (const [index, name] of ['link href', 'image srcset', 'script src'].entries()) {
    await t.test(name + ' distinguishes absent, empty and removed attributes', () => {
      assert.deepEqual(home.urlAttributes[index], {
        absent: [null, null, false],
        empty: ['', '', true],
        removed: [null, null, false],
        removedAfterURL: [null, null, false],
        emptyAfterURL: ['', '', true],
      });
    });
  }
  await t.test('favicon masking without upstream fetch', () => {
  // R6 parity: getAttribute/Attr.value return the author-written literal;
  // only the IDL property resolves to the absolute target URL.
  assert.deepEqual(home.faviconProbe && {
    rel: home.faviconProbe.rel,
    href: home.faviconProbe.href,
    hrefProp: home.faviconProbe.hrefProp,
    hrefAttrValue: home.faviconProbe.hrefAttrValue,
  }, {
    rel: 'icon',
    href: '/site-icon.png',
    hrefProp: `http://${targetHost}:${targetPort}/site-icon.png`,
    hrefAttrValue: '/site-icon.png',
  });
  assert.doesNotMatch(home.faviconProbe.outerHTML, /x-zeroproxy-icon|data-zp-target-url/);
  assert.equal(requests.some(r => r.url === '/site-icon.png'), false, `favicon must not be fetched: ${JSON.stringify(requests)}`);
  });
  await t.test('target-authored virtual location and dynamic compilation', () => {
  assert.deepEqual(home.phase2Location, { href: `http://${targetHost}:${targetPort}/`, windowHref: `http://${targetHost}:${targetPort}/` });
  assert.equal(home.phase2DynamicFunction, `http://${targetHost}:${targetPort}/`);
  assert.equal(home.phase2EvalLocation, `http://${targetHost}:${targetPort}/`);
  });
  await t.test('stylesheet rendering and upstream identity', () => {
  assert.deepEqual(home.styleProbe, { borderTopWidth: '7px', borderTopColor: 'rgb(12, 34, 56)', paddingLeft: '13px' });
  assert.ok(requests.some(r => r.url === '/site.css' && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  });
  await t.test('image rendering and upstream identity', () => {
  assert.equal(home.imageProbe.complete, true);
  assert.equal(home.imageProbe.naturalWidth, 1);
  assert.equal(home.imageProbe.src, '/image-probe.png');
  assert.ok(requests.some(r => r.url === '/image-probe.png' && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.url === '/' && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  });
  const addressBarShare = page.url();
  const relayServerParam = new RegExp(`server=ws%3A%2F%2Fproxy\\.localhost%3A${proxyPort}%2Fzp%2Fws-pipe`);
  await t.test('share URL round-trip in a fresh browser context', async () => {
  assert.match(addressBarShare, /#k=/);
  assert.match(addressBarShare, relayServerParam);
  const staticNextHref = await page.$eval('#next', el => el.href);
  assert.equal(staticNextHref, `http://${targetHost}:${targetPort}/next`);
  const externalContext = await browser.createBrowserContext();
  try {
    const externalPage = await externalContext.newPage();
    await externalPage.goto(addressBarShare, { waitUntil: 'domcontentloaded' });
    await externalPage.waitForFunction(() => document.title === 'E2E Home', { timeout: 30000 });
    assert.match(externalPage.url(), /#k=/);
    assert.match(externalPage.url(), relayServerParam);
  } finally {
    await externalContext.close();
  }
  });
  await t.test('rewritten assignment and WebSocket integration', async () => {
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
  });
  await t.test('dynamic scripts and module worker integration', async () => {
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
  assert.equal(dynamicScripts.moduleWorker.href, `http://${targetHost}:${targetPort}/worker-fixture.js`);
  assert.equal(dynamicScripts.moduleWorker.userAgent, TARGET_UA);
  assert.equal(dynamicScripts.moduleWorker.platform, 'Win32');
  assert.ok(dynamicScripts.messages.some(m => m.type === 'gtm-loaded'), `messages: ${JSON.stringify(dynamicScripts.messages)}`);
  assert.ok(requests.some(r => r.url.startsWith('/gtm.js') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.url.startsWith('/dynamic-script.js') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.url.startsWith('/module-worker.js') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  assert.ok(requests.some(r => r.url.startsWith('/worker-fixture.js') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`);
  });
  await t.test('jQuery integration', async () => {

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
  });

  await t.test('synchronous and navigated iframe isolation', async () => {
  const iframeIsolation = await page.evaluate(async target => {
    const blockedChannel = win => {
      let pc;
      try { pc = new win.RTCPeerConnection(); pc.createDataChannel('escape-probe'); return 'allowed'; }
      catch (err) { return err.name; }
      finally { if (pc) pc.close(); }
    };

    const sync = document.createElement('iframe');
    document.body.appendChild(sync);
    const syncRTC = blockedChannel(sync.contentWindow);
    const docRTC = blockedChannel(sync.contentDocument.defaultView);

    const modern = document.createElement('iframe');
    document.body.append(modern);
    const modernRTC = blockedChannel(modern.contentWindow);
    const ws = new modern.contentWindow.WebSocket('ws://evil.example/socket');
    const websocketURL = ws.url;
    const childCanvasMask = modern.contentWindow.HTMLCanvasElement.prototype.toDataURL.toString();
    const childFunctionHref = modern.contentWindow.Function('return location.href')();
    try { ws.close(); } catch {}

    const observed = document.createElement('iframe');
    document.body.appendChild(observed);
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('attribute iframe navigation timed out')), 30000);
      observed.addEventListener('load', () => {
        if (observed.contentDocument?.title !== 'E2E Next') return;
        clearTimeout(timer);
        resolve(observed.contentDocument.querySelector('h1')?.textContent);
      });
    });
    const attr = document.createAttribute('src');
    attr.value = target;
    observed.attributes.setNamedItem(attr);
    const frameTitle = await loaded;
    const visibleSrc = observed.src;
    const visibleAttribute = observed.getAttribute('src');
    const visibleNodeValue = attr.value;
    const attachedNode = observed.getAttributeNode('src') === attr && attr.ownerElement === observed;
    const marker = document.createAttribute('data-marker');
    marker.value = 'before';
    observed.setAttributeNode(marker);
    const replacement = document.createAttribute('data-marker');
    replacement.value = 'after';
    const replaced = NamedNodeMap.prototype.setNamedItemNS.call(observed.attributes, replacement);
    const replacedNode = replaced === marker && marker.ownerElement === null && marker.value === 'before' && replacement.ownerElement === observed && observed.getAttribute('data-marker') === 'after';
    observed.removeAttribute('src');
    const removedSrc = observed.src;
    sync.remove();
    modern.remove();
    observed.remove();
    return { syncRTC, docRTC, modernRTC, websocketURL, childCanvasMask, childFunctionHref, frameTitle, visibleSrc, visibleAttribute, visibleNodeValue, removedSrc, attachedNode, replacedNode };
  }, `http://${targetHost}:${targetPort}/next`);
  assert.equal(iframeIsolation.syncRTC, 'NotSupportedError');
  assert.equal(iframeIsolation.docRTC, 'NotSupportedError');
  assert.equal(iframeIsolation.modernRTC, 'NotSupportedError');
  assert.equal(iframeIsolation.websocketURL, 'ws://evil.example/socket');
  assert.equal(iframeIsolation.frameTitle, 'E2E Next');
  assert.equal(iframeIsolation.visibleSrc, `http://${targetHost}:${targetPort}/next`);
  assert.equal(iframeIsolation.visibleAttribute, `http://${targetHost}:${targetPort}/next`);
  assert.equal(iframeIsolation.visibleNodeValue, `http://${targetHost}:${targetPort}/next`);
  assert.equal(iframeIsolation.removedSrc, '');
  assert.equal(iframeIsolation.attachedNode, true);
  assert.equal(iframeIsolation.replacedNode, true);
  assert.equal(iframeIsolation.childCanvasMask, 'function toDataURL() { [native code] }');
  assert.equal(iframeIsolation.childFunctionHref, `http://${targetHost}:${targetPort}/#compound-tail`);
  });

  await t.test('child frame messaging preserves parent navigation', async () => {
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
  });

  await t.test('canvas audio and speech fingerprint masking', async () => {
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
  });

  await t.test('runtime transport integration', async t => {
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
      const end = await reader.read();
      const explicit = new WebSocketStream('ws://localhost:' + targetPort + '/ws', { protocols: ['zp-stream-close'] });
      await explicit.opened;
      explicit.close({ closeCode: 3001, reason: 'finished' });
      const explicitClosed = await explicit.closed;
      return { protocol: opened.protocol, data: String(first.value), closeCode: closed.closeCode, done: end.done, explicitClosed };
    }


    // Keep a failed transport visible in its own assertion without preventing
    // the remaining independent transports from being exercised.
    async function observe(run) {
      try { return await run(); }
      catch (error) { return { error: error && error.stack || String(error) }; }
    }
    const setCookieBody = await observe(() => readText('/set-cookie?ts=' + Date.now()));
    const serverCookie = await observe(() => waitForCookieHeader('target_server=from-target'));
    const visibleCookie = await observe(() => {
      document.cookie = 'client_runtime=from-runtime; Path=/';
      return document.cookie;
    });
    const clientCookie = await observe(() => waitForCookieHeader('client_runtime=from-runtime'));
    const stream = await observe(readStream);
    const post = await observe(() => postText('/post-echo', 'small-upload'));
    const redirectPost = await observe(() => postText('/redirect307', 'redirect-body'));
    const oversized = await observe(() => postText('/post-echo', 'x'.repeat(8 * 1024 * 1024 + 1)));
    const ws = await observe(websocketEcho);
    const wsStream = await observe(websocketStreamEcho);
    return { setCookieBody, serverCookie, visibleCookie, clientCookie, stream, ws, wsStream, post, redirectPost, oversized };
  }, targetPort);
  fs.writeFileSync(path.join(artifacts, 'e1-runtime.json'), JSON.stringify(runtimeIntegration, null, 2));
  await t.test('setCookieBody', () => { assert.equal(runtimeIntegration.setCookieBody, 'set-cookie-ok'); });
  await t.test('serverCookie', () => { assert.match(runtimeIntegration.serverCookie, /target_server=from-target/); });
  await t.test('visibleCookie', () => { assert.match(runtimeIntegration.visibleCookie, /client_runtime=from-runtime/); });
  await t.test('clientCookie', () => { assert.match(runtimeIntegration.clientCookie, /target_server=from-target/); });
  await t.test('clientCookie', () => { assert.match(runtimeIntegration.clientCookie, /client_runtime=from-runtime/); });
  await t.test('stream.status', () => { assert.equal(runtimeIntegration.stream.status, 200); });
  await t.test('stream.contentType', () => { assert.match(runtimeIntegration.stream.contentType, /^text\/plain/); });
  await t.test('stream.firstText', () => { assert.equal(runtimeIntegration.stream.firstText, 'chunk-one\n'); });
  await t.test('stream.body', () => { assert.equal(runtimeIntegration.stream.body, 'chunk-one\nchunk-two\n'); });
  await t.test('stream.firstMs', () => { assert.ok(runtimeIntegration.stream.firstMs < 500, `stream first chunk was buffered for ${runtimeIntegration.stream.firstMs}ms`); });
  await t.test('ws.url', () => { assert.equal(runtimeIntegration.ws.url, `ws://${targetHost}:${targetPort}/ws`); });
  await t.test('ws.data', () => { assert.equal(runtimeIntegration.ws.data, '1,2,3'); });
  await t.test('ws.protocol', () => { assert.equal(runtimeIntegration.ws.protocol, 'zp-test'); });
  await t.test('wsStream', () => { assert.deepEqual(runtimeIntegration.wsStream, { protocol: 'zp-stream', data: 'echo:stream', closeCode: 1000, done: true, explicitClosed: { closeCode: 3001, reason: 'finished' } }); });
  await t.test('opening WebSocket cancellation is unclean and streams settle', async () => {
    const canceled = await page.evaluate(async targetPort => {
      const url = 'ws://localhost:' + targetPort + '/ws';
      const ws = new WebSocket(url);
      const early = new Promise(resolve => {
        ws.onclose = event => resolve({ code: event.code, reason: event.reason, wasClean: event.wasClean });
      });
      ws.close(3001, 'not a peer close');
      const stream = new WebSocketStream(url);
      stream.close({ closeCode: 3001, reason: 'not a peer close' });
      const controller = new AbortController();
      const aborted = new WebSocketStream(url, { signal: controller.signal });
      controller.abort();
      const settlements = await Promise.allSettled([stream.opened, stream.closed, aborted.opened, aborted.closed]);
      return { early: await early, settlements: settlements.map(result => ({ status: result.status, error: result.reason?.name })) };
    }, targetPort);
    assert.deepEqual(canceled, {
      early: { code: 1006, reason: '', wasClean: false },
      settlements: [
        { status: 'rejected', error: 'NetworkError' }, { status: 'rejected', error: 'NetworkError' },
        { status: 'rejected', error: 'AbortError' }, { status: 'rejected', error: 'AbortError' }
      ]
    });
  });
  await t.test('post', () => { assert.deepEqual(runtimeIntegration.post, { status: 200, text: 'small-upload' }); });
  await t.test('redirectPost', () => { assert.deepEqual(runtimeIntegration.redirectPost, { status: 200, text: 'redirect-body' }); });
  await t.test('oversized.status', () => { assert.equal(runtimeIntegration.oversized.status, 413); });
  await t.test('oversized.text', () => { assert.match(runtimeIntegration.oversized.text, /REQUEST_BODY_TOO_LARGE/); });
  await t.test('upstream request identity', () => { assert.ok(requests.some(r => r.url.startsWith('/set-cookie') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`); });
  await t.test('upstream request identity', () => { assert.ok(requests.some(r => r.url.startsWith('/stream') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`); });
  await t.test('upstream request identity', () => { assert.ok(requests.some(r => r.upgrade && r.url === '/ws' && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`); });
  await t.test('upstream request identity', () => { assert.ok(requests.some(r => r.upgrade && r.url === '/ws' && r.protocol === 'zp-stream' && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`); });
  await t.test('websocket initiating origin and cookie identity', () => {
    for (const protocol of ['zp-test', 'zp-stream', 'zp-stream-close']) {
      const request = requests.find(r => r.upgrade && r.protocol === protocol);
      assert.ok(request, protocol);
      assert.equal(request.origin, `http://${targetHost}:${targetPort}`);
      assert.match(request.cookie, /target_server=from-target/);
      assert.match(request.cookie, /client_runtime=from-runtime/);
      assert.equal(request.userAgent, TARGET_UA);
    }
  });
  await t.test('upstream request identity', () => { assert.ok(requests.some(r => r.url.startsWith('/cookie-echo') && r.cookie.includes('target_server=from-target') && r.cookie.includes('client_runtime=from-runtime')), `target requests: ${JSON.stringify(requests)}`); });
  });

  await t.test('response framing and cancellation', async t => {
    await t.test('chunk trailers are not response body bytes', async () => {
      assert.equal(await page.evaluate(async () => (await fetch('/stream-trailers')).text()), 'payload');
    });
    for (const [method, status] of [['HEAD', 200], ['GET', 204], ['GET', 304]]) {
      await t.test(`${method} ${status} has no body`, async () => {
        const result = await page.evaluate(async ({ method, status }) => {
          const response = await fetch('/stream-bodyless?status=' + status, { method });
          return { status: response.status, body: await response.text() };
        }, { method, status });
        assert.deepEqual(result, { status, body: '' });
      });
    }
    for (const endpoint of ['/stream-truncated', '/stream-gzip-truncated']) {
      await t.test(`${endpoint} rejects incomplete body`, async () => {
        const result = await page.evaluate(async endpoint => {
          try { const response = await fetch(endpoint); await response.text(); return 'accepted'; }
          catch { return 'rejected'; }
        }, endpoint);
        assert.equal(result, 'rejected');
      });
    }
    await t.test('cancel closes an idle upstream stream', async () => {
      const first = await page.evaluate(async () => {
        const response = await fetch('/stream-cancel');
        const reader = response.body.getReader();
        const first = await reader.read();
        await reader.cancel();
        return new TextDecoder().decode(first.value);
      });
      assert.equal(first, 'first');
      for (let i = 0; i < 100 && !requests.some(r => r.url === '/stream-cancel' && r.canceled); i++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(requests.some(r => r.url === '/stream-cancel' && r.canceled), 'cancellation did not close the upstream socket');
    });
  });

  await t.test('escape matrix', async t => {
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
    }).catch(err => 'blocked:' + (err && err.message || String(err)));
    out.stringTimer = await new Promise(resolve => {
      try {
        window.__timerRan = 0;
        setTimeout('window.__timerRan=1', 0);
        setTimeout(() => resolve(window.__timerRan === 1 ? 'ran' : 'not-ran'), 25);
      } catch (err) {
        resolve(err && err.message || String(err));
      }
    });
    // D5: blob:/data: 워커 소스는 재작성 후 실행된다 — 실행 자체는 네이티브
    // parity, 검증 포인트는 워커의 location 이 blob:/data: 로 보이는 것
    // (멤브레인 활성 + 가상 location) 과 코드가 돈다는 것이다.
    out.blobWorker = await new Promise(resolve => {
      let worker;
      try {
        const url = URL.createObjectURL(new Blob([`postMessage('ran:' + self.location.protocol)`], { type: '' }));
        worker = new Worker(url);
        const timer = setTimeout(() => { try { worker.terminate(); } catch {} resolve('no-message'); }, 1500);
        worker.onmessage = ev => { clearTimeout(timer); resolve(String(ev.data)); };
        worker.onerror = () => { clearTimeout(timer); resolve('error'); };
      } catch (err) { resolve('throw:' + (err && err.message || String(err))); }
    });
    out.dataWorker = await new Promise(resolve => {
      let worker;
      try {
        worker = new Worker('data:text/javascript,postMessage(%22ran:%22%2Bself.location.protocol)');
        const timer = setTimeout(() => { try { worker.terminate(); } catch {} resolve('no-message'); }, 1500);
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
    out.topOrigin = __zp_get(globalThis, 'top').location.origin;
    // Dynamic compilation remains usable, but must never expose proxy location.
    out.functionEscape = (() => {
      try { const v = (new Function('return location.href'))(); return 'ran:' + String(v); }
      catch (err) { return 'blocked:' + (err && err.name || 'Error'); }
    })();
    out.constructorEscape = (() => {
      try { const v = ({}).constructor.constructor('return location.href')(); return 'ran:' + String(v); }
      catch (err) { return 'blocked:' + (err && err.name || 'Error'); }
    })();
    out.asyncFunctionEscape = await (async () => {
      try { const Async = (async function(){}).constructor; const v = await new Async('return location.href')(); return 'ran:' + String(v); }
      catch (err) { return 'blocked:' + (err && err.name || 'Error'); }
    })();
    // A3 hardening: <script src=blob:...> must be neutralised by setAttribute observer.
    out.scriptBlobSrc = await new Promise(resolve => {
      try {
        window.__scriptBlobRan = false;
        const blobURL = URL.createObjectURL(new Blob(['window.__scriptBlobRan = true;'], { type: 'text/javascript' }));
        const s = document.createElement('script');
        s.src = blobURL;
        document.head.appendChild(s);
        setTimeout(() => {
          const ran = window.__scriptBlobRan === true;
          try { document.head.removeChild(s); } catch {}
          try { URL.revokeObjectURL(blobURL); } catch {}
          resolve(ran ? 'ran' : 'blocked');
        }, 200);
      } catch (err) { resolve('throw:' + (err && err.message || err)); }
    });

    // Reflect.get(window, 'location') → must hit membrane, not native.
    out.reflectGetLocation = (() => {
      try {
        const loc = Reflect.get(__zp_get(globalThis, 'window'), 'location');
        return typeof loc?.href === 'string' && String(loc.href).startsWith(directBase) ? 'virtual' : 'native:' + (loc && loc.href);
      } catch (err) { return 'throw:' + (err && err.message || err); }
    })();

    // top.location / parent.location / opener: all dangerous globals must
    // route through the membrane (no clean realm access to native location).
    out.topLocation = (() => {
      try {
        const href = __zp_get(globalThis, 'top').location.href;
        return String(href).startsWith(directBase) ? 'virtual' : 'native:' + href;
      } catch (err) { return 'throw:' + (err && err.message || err); }
    })();
    out.parentLocation = (() => {
      try {
        const href = __zp_get(globalThis, 'parent').location.href;
        return String(href).startsWith(directBase) ? 'virtual' : 'native:' + href;
      } catch (err) { return 'throw:' + (err && err.message || err); }
    })();
    out.opener = (() => {
      try {
        const op = __zp_get(globalThis, 'opener');
        return op === null || op === undefined ? 'empty' : 'leaked:' + typeof op;
      } catch (err) { return 'throw:' + (err && err.message || err); }
    })();

    // D7 storage isolation: facade returns un-prefixed keys to target code,
    // and writes land in the underlying proxy-origin store under a hashed
    // prefix (so other targets cannot see them). We can only probe the
    // facade from inside the target realm; verify it reports unprefixed
    // keys via key(i) enumeration and consistent get/set/remove semantics.
    out.storagePrefix = (() => {
      try {
        const w = __zp_get(globalThis, 'window');
        const ls = w.localStorage;
        ls.setItem('zp-probe', 'v1');
        const got = ls.getItem('zp-probe');
        // Enumerate via key(i) and ensure the bare key appears, not a prefixed one.
        const keys = [];
        for (let i = 0; i < ls.length; i++) keys.push(ls.key(i));
        ls.removeItem('zp-probe');
        const removed = ls.getItem('zp-probe');
        const leaked = keys.some(k => /^__zp:/.test(k));
        return got === 'v1' && removed === null && !leaked ? 'isolated' : 'leak:' + JSON.stringify({got, removed, leaked, keys});
      } catch (err) { return 'throw:' + (err && err.message || err); }
    })();

    // D7 document.domain virtualization: setter must be a no-op visible to
    // native, but the virtual getter returns the target host.
    out.documentDomainSetter = (() => {
      try {
        const d = __zp_get(globalThis, 'document');
        const initial = d.domain;
        try { d.domain = 'evil.example'; } catch {}
        const after = d.domain;
        // M109+ parity: setter 는 유효 suffix 에도 no-op 다.
        try { d.domain = initial; } catch {}
        const afterValid = d.domain;
        return (after === initial && afterValid === initial) ? 'unchanged:' + initial : 'changed:' + after + '|' + afterValid;
      } catch (err) { return 'throw:' + (err && err.message || err); }
    })();

    // D7 document.origin must be the virtual target origin, never proxy —
    // *if the property exists at all*. Real-browser control (2026-09-14,
    // Chrome 152 + Edge/WebView2 153, both headless and headed): neither
    // has `document.origin` any more (own on Document.prototype: false,
    // value: undefined). It used to be a real non-standard Chromium
    // property; this assertion predates its removal. Nothing to virtualize
    // means nothing to leak, so `undefined` is the correct, safe outcome —
    // but if some engine still has it, the old invariant (must read as the
    // target origin, never the proxy's) still applies.
    out.documentOrigin = (() => {
      try {
        const d = __zp_get(globalThis, 'document');
        if (d.origin === undefined) return 'absent-natively:ok';
        return String(d.origin || '').startsWith(directBase) ? 'virtual:' + d.origin : 'native:' + d.origin;
      } catch (err) { return 'throw:' + (err && err.message || err); }
    })();

    // D7 BroadcastChannel: target name must be prefixed at native layer.
    out.broadcastChannelName = (() => {
      try {
        const w = __zp_get(globalThis, 'window');
        const bc = new w.BroadcastChannel('zp-test');
        const nm = bc.name;
        try { bc.close(); } catch {}
        // Facade reports the un-prefixed name to target code.
        return nm === 'zp-test' ? 'unprefixed-facade' : 'leaked-prefix:' + nm;
      } catch (err) { return 'throw:' + (err && err.message || err); }
    })();

    // E1: Indirect eval `(0,eval)('location.href')` must hit prelude's
    // dynamicEval (virtual URL), not native realm's eval.
    out.indirectEval = (() => {
      try {
        const v = (0, eval)('location.href');
        return String(String(v)).startsWith(directBase) ? 'virtual:' + v : 'native:' + v;
      } catch (err) { return 'throw:' + (err && err.name || String(err)); }
    })();

    // E1: globalThis.eval — same routing requirement.
    out.globalThisEval = (() => {
      try {
        const v = globalThis.eval('location.href');
        return String(String(v)).startsWith(directBase) ? 'virtual:' + v : 'native:' + v;
      } catch (err) { return 'throw:' + (err && err.name || String(err)); }
    })();

    // E1: Computed property access `window['loca'+'tion']` — must route
    // through the membrane like any other property access.
    out.computedAccess = (() => {
      try {
        const w = __zp_get(globalThis, 'window');
        const loc = w['loca' + 'tion'];
        const href = loc && loc.href;
        return String(href || '').startsWith(directBase) ? 'virtual' : 'native:' + href;
      } catch (err) { return 'throw:' + (err && err.name || String(err)); }
    })();

    // E1: Destructuring `const { location } = window` — the unpacked
    // reference must still be the virtual surface.
    out.destructuringAccess = (() => {
      try {
        const w = __zp_get(globalThis, 'window');
        const { location } = w;
        return String(location.href).startsWith(directBase) ? 'virtual' : 'native:' + location.href;
      } catch (err) { return 'throw:' + (err && err.name || String(err)); }
    })();

    // E1: Optional chaining `window?.location?.href`.
    out.optionalChainAccess = (() => {
      try {
        const w = __zp_get(globalThis, 'window');
        const href = w?.location?.href;
        return String(href || '').startsWith(directBase) ? 'virtual' : 'native:' + href;
      } catch (err) { return 'throw:' + (err && err.name || String(err)); }
    })();

    // E1: `Object.getOwnPropertyDescriptor(window, 'location')` — if it
    // hands back a getter, that getter must yield the virtual surface.
    out.locationDescriptor = (() => {
      try {
        const w = __zp_get(globalThis, 'window');
        const desc = Object.getOwnPropertyDescriptor(w, 'location');
        if (!desc) return 'no-desc';
        const v = desc.get ? desc.get.call(w) : desc.value;
        out.locationDescriptorFlags = {
          configurable: desc.configurable, enumerable: desc.enumerable,
          getter: typeof desc.get, setter: typeof desc.set,
          stable: desc.get === Reflect.getOwnPropertyDescriptor(w, 'location').get,
          sameLocation: v === w.location,
          redefinable: Reflect.defineProperty(w, 'location', { configurable: true }),
          deletable: Reflect.deleteProperty(w, 'location')
        };
        const href = v && v.href;
        return String(String(href || '')).startsWith(directBase) ? 'virtual' : 'native:' + href;
      } catch (err) { return 'throw:' + (err && err.name || String(err)); }
    })();

    // E1: DOMParser.parseFromString — per HTML5 spec, inline <script>s
    // inside the parsed document must NOT execute. Verify no regression.
    out.domParserScript = (() => {
      try {
        window.__domParserRan = false;
        const doc = new DOMParser().parseFromString(
          '<html><body><script>window.__domParserRan = true<\/script></body></html>',
          'text/html'
        );
        // Adopting the parsed node into the live document must not run the
        // inline script either (it's parser-inserted, not inserted-while-parsed).
        document.body.appendChild(document.importNode(doc.body, true));
        return window.__domParserRan ? 'ran' : 'blocked';
      } catch (err) { return 'throw:' + (err && err.name || String(err)); }
    })();

    // HTML createContextualFragment uses Fragment scripting mode, unlike
    // innerHTML/DOMParser: insertion executes scripts. The authored consumer
    // must run with virtual URLs and route its fetch through the proxy.
    // https://html.spec.whatwg.org/multipage/dynamic-markup-insertion.html#dom-range-createcontextualfragment
    try { out.rangeFragmentScript = await window.__runFragmentProbe(); }
    catch (err) { out.rangeFragmentScript = { error: err && err.name || String(err) }; }

    // E1: innerHTML inline <script> never executes (HTML5 spec), regression guard.
    out.innerHTMLScript = (() => {
      try {
        window.__innerHTMLRan = false;
        const d = document.createElement('div');
        d.innerHTML = '<script>window.__innerHTMLRan = true<\/script>';
        document.body.appendChild(d);
        return window.__innerHTMLRan ? 'ran' : 'blocked';
      } catch (err) { return 'throw:' + (err && err.name || String(err)); }
    })();

    // E1 D7: sessionStorage isolation parity with localStorage.
    out.sessionStoragePrefix = (() => {
      try {
        const w = __zp_get(globalThis, 'window');
        const ss = w.sessionStorage;
        ss.setItem('zp-sess-probe', 'v2');
        const got = ss.getItem('zp-sess-probe');
        const keys = [];
        for (let i = 0; i < ss.length; i++) keys.push(ss.key(i));
        ss.removeItem('zp-sess-probe');
        const removed = ss.getItem('zp-sess-probe');
        // Bare key visible to target — internal `zp:s:...` prefix must not leak.
        const leaked = keys.some(k => /^zp:/.test(k));
        return got === 'v2' && removed === null && !leaked
          ? 'isolated'
          : 'leak:' + JSON.stringify({ got, removed, leaked, keys });
      } catch (err) { return 'throw:' + (err && err.name || String(err)); }
    })();

    // E1 D7: caches (CacheStorage) origin prefix — target-visible names
    // are un-prefixed, internal namespace is hidden.
    out.cachesAPI = await (async () => {
      try {
        const w = __zp_get(globalThis, 'window');
        if (!w.caches) return 'missing';
        await w.caches.open('zp-probe-cache');
        const keys = await w.caches.keys();
        const leaked = keys.some(k => /^zp:/.test(k));
        try { await w.caches.delete('zp-probe-cache'); } catch {}
        return !leaked ? 'isolated' : 'leak:' + JSON.stringify(keys);
      } catch (err) { return 'throw:' + (err && err.name || String(err)); }
    })();

    // E1 D7: performance.timeOrigin must be numeric (virtualized to navigation
    // baseline). The exact value depends on prelude state but it must not be
    // missing or stringified.
    out.performanceTimeOrigin = (() => {
      try {
        const w = __zp_get(globalThis, 'window');
        const to = w.performance && w.performance.timeOrigin;
        return typeof to === 'number' && to > 0 ? 'numeric' : 'missing:' + typeof to;
      } catch (err) { return 'throw:' + (err && err.name || String(err)); }
    })();

    // E1 D4/D5: WebTransport / RTCPeerConnection virtual gateway stubs —
    // construction succeeds (feature detection works) but `.ready` rejects.
    out.webTransport = await (async () => {
      try {
        const WT = __zp_get(globalThis, 'WebTransport');
        if (typeof WT !== 'function') return 'absent';
        const wt = new WT('https://evil.example/');
        try { await wt.ready; return 'allowed:resolved'; }
        catch (err) { return 'gateway-stub:' + (err && err.name || String(err)); }
      } catch (err) { return 'throw:' + (err && err.name || String(err)); }
    })();
    out.rtcPeerConnection = (() => {
      try {
        const RTC = __zp_get(globalThis, 'RTCPeerConnection');
        if (typeof RTC !== 'function') return 'absent';
        const pc = new RTC();
        // The gateway stub must refuse data channels (and other surface)
        // synchronously — `.createDataChannel()` throws our NotSupportedError.
        try { pc.createDataChannel('chan'); return 'allowed:dc'; }
        catch (err) { return 'gateway-stub:' + (err && err.name || String(err)); }
      } catch (err) { return 'throw:' + (err && err.name || String(err)); }
    })();

    return out;
  }, targetPort);
  fs.writeFileSync(path.join(artifacts, 'e1-escape.json'), JSON.stringify(escapeMatrix, null, 2));
  await t.test('fetch', () => { assert.equal(escapeMatrix.fetch, 'ok:404'); });
  await t.test('xhr', () => { assert.equal(escapeMatrix.xhr, 'ok:404'); });
  await t.test('eventSource', () => { assert.equal(escapeMatrix.eventSource, 'ok:sse-ok'); });
  await t.test('websocket', () => { assert.equal(escapeMatrix.websocket, 'echo:direct'); });
  await t.test('locationReplaceSource', () => { assert.equal(escapeMatrix.locationReplaceSource, 'function replace() { [native code] }'); });
  await t.test('virtualHash', () => { assert.equal(escapeMatrix.virtualHash, '#zp-fragment'); });
  await t.test('virtualHref', () => { assert.match(escapeMatrix.virtualHref, /#zp-fragment$/); });
  await t.test('topOrigin', () => { assert.equal(escapeMatrix.topOrigin, `http://${targetHost}:${targetPort}`); });
  await t.test('proxy-origin navigation', () => { assert.equal(page.url().startsWith(`http://proxy.localhost:${proxyPort}/`), true); });
  await t.test('stringTimer', () => { assert.equal(escapeMatrix.stringTimer, 'ran'); });
  // D5: blob:/data: 워커 소스는 rewrite-then-execute — 실행되되 워커의
  // location.protocol 이 blob:/data: 로 보여야 한다(멤브레인 가상 location).
  await t.test('blobWorker', () => { assert.equal(escapeMatrix.blobWorker, 'ran:blob:'); });
  await t.test('dataWorker', () => { assert.equal(escapeMatrix.dataWorker, 'ran:data:'); });
  await t.test('eventHandlerLocation', () => { assert.ok(escapeMatrix.eventHandlerLocation === '' || escapeMatrix.eventHandlerLocation === `http://${targetHost}:${targetPort}/#compound-tail`, `event handler location: ${escapeMatrix.eventHandlerLocation}`); });
  await t.test('upstream request identity', () => { assert.equal(requests.filter(r => r.userAgent && r.userAgent !== TARGET_UA).length, 0, `target requests: ${JSON.stringify(requests)}`); });
  await t.test('upstream request identity', () => { assert.ok(requests.some(r => r.url.startsWith('/direct-fetch') && r.userAgent === TARGET_UA), `target requests: ${JSON.stringify(requests)}`); });
  // Successful dynamic compilation must still execute in the virtual realm.
  await t.test('functionEscape', () => { assert.equal(escapeMatrix.functionEscape, 'ran:' + escapeMatrix.virtualHref); });
  await t.test('constructorEscape', () => { assert.equal(escapeMatrix.constructorEscape, 'ran:' + escapeMatrix.virtualHref); });
  await t.test('asyncFunctionEscape', () => { assert.equal(escapeMatrix.asyncFunctionEscape, 'ran:' + escapeMatrix.virtualHref); });
  // A3 hardening: <script src=blob:...> must be neutralised.
  await t.test('scriptBlobSrc', () => { assert.equal(escapeMatrix.scriptBlobSrc, 'blocked', `<script src=blob:...> must not execute, got: ${escapeMatrix.scriptBlobSrc}`); });
  // B-extra: Reflect.get(window,'location') routed through membrane.
  await t.test('reflectGetLocation', () => { assert.equal(escapeMatrix.reflectGetLocation, 'virtual', `Reflect.get must hit membrane, got: ${escapeMatrix.reflectGetLocation}`); });
  // top/parent must not leak the proxy realm.
  await t.test('topLocation', () => { assert.equal(escapeMatrix.topLocation, 'virtual', `top.location escape: ${escapeMatrix.topLocation}`); });
  await t.test('parentLocation', () => { assert.equal(escapeMatrix.parentLocation, 'virtual', `parent.location escape: ${escapeMatrix.parentLocation}`); });
  await t.test('opener', () => { assert.equal(escapeMatrix.opener, 'empty', `opener leak: ${escapeMatrix.opener}`); });
  // D7 storage isolation must hold (no raw target key on proxy origin).
  await t.test('storagePrefix', () => { assert.equal(escapeMatrix.storagePrefix, 'isolated', `storage prefix leak: ${escapeMatrix.storagePrefix}`); });
  // D7 document.domain setter is virtualised (no real native change).
  await t.test('documentDomainSetter', () => { assert.match(escapeMatrix.documentDomainSetter, /^unchanged:/, `document.domain leak: ${escapeMatrix.documentDomainSetter}`); });
  // D7 document.origin reports the virtual target origin when the property
  // exists at all; current real browsers no longer have it (measured), so
  // 'absent-natively:ok' is the expected — not just tolerated — outcome.
  await t.test('documentOrigin', () => { assert.match(escapeMatrix.documentOrigin, /^(virtual:|absent-natively:ok)/, `document.origin leak: ${escapeMatrix.documentOrigin}`); });
  // D7 BroadcastChannel facade returns un-prefixed name (target-visible truth).
  await t.test('broadcastChannelName', () => { assert.equal(escapeMatrix.broadcastChannelName, 'unprefixed-facade', `BroadcastChannel: ${escapeMatrix.broadcastChannelName}`); });
  // E1 indirect eval / globalThis.eval / computed / destructuring / optional
  // chaining / descriptor — every location read path lands on the virtual surface.
  await t.test('indirectEval', () => { assert.match(escapeMatrix.indirectEval, /^virtual:/, `indirect eval: ${escapeMatrix.indirectEval}`); });
  await t.test('globalThisEval', () => { assert.match(escapeMatrix.globalThisEval, /^virtual:/, `globalThis.eval: ${escapeMatrix.globalThisEval}`); });
  await t.test('computedAccess', () => { assert.equal(escapeMatrix.computedAccess, 'virtual', `computed access: ${escapeMatrix.computedAccess}`); });
  await t.test('destructuringAccess', () => { assert.equal(escapeMatrix.destructuringAccess, 'virtual', `destructuring: ${escapeMatrix.destructuringAccess}`); });
  await t.test('optionalChainAccess', () => { assert.equal(escapeMatrix.optionalChainAccess, 'virtual', `optional chain: ${escapeMatrix.optionalChainAccess}`); });
  await t.test('locationDescriptor', () => { assert.equal(escapeMatrix.locationDescriptor, 'virtual', `descriptor leak: ${escapeMatrix.locationDescriptor}`); });
  await t.test('locationDescriptorFlags', () => { assert.deepEqual(escapeMatrix.locationDescriptorFlags, { configurable: false, enumerable: true, getter: 'function', setter: 'function', stable: true, sameLocation: true, redefinable: false, deletable: false }); });
  // Inert HTML ingestion stays inert; executable fragments retain confinement.
  await t.test('domParserScript', () => { assert.equal(escapeMatrix.domParserScript, 'blocked', `DOMParser script: ${escapeMatrix.domParserScript}`); });
  await t.test('rangeFragmentScript', () => {
    assert.deepEqual(escapeMatrix.rangeFragmentScript, { beforeInsertion: true, result: { href: escapeMatrix.virtualHref, origin: `http://${targetHost}:${targetPort}`, echo: { href: escapeMatrix.virtualHref, userAgent: TARGET_UA } } });
  });
  await t.test('innerHTMLScript', () => { assert.equal(escapeMatrix.innerHTMLScript, 'blocked', `innerHTML script: ${escapeMatrix.innerHTMLScript}`); });
  // D7 parity: sessionStorage / caches / performance.timeOrigin virtualized.
  await t.test('sessionStoragePrefix', () => { assert.equal(escapeMatrix.sessionStoragePrefix, 'isolated', `sessionStorage leak: ${escapeMatrix.sessionStoragePrefix}`); });
  await t.test('cachesAPI', () => { assert.equal(escapeMatrix.cachesAPI, 'isolated', `caches leak: ${escapeMatrix.cachesAPI}`); });
  await t.test('performanceTimeOrigin', () => { assert.equal(escapeMatrix.performanceTimeOrigin, 'numeric', `timeOrigin: ${escapeMatrix.performanceTimeOrigin}`); });
  // D4 / D5 gateway stubs — construction succeeds but operations fail-closed.
  await t.test('webTransport', () => { assert.match(escapeMatrix.webTransport, /^(?:gateway-stub|absent)/, `WebTransport leak: ${escapeMatrix.webTransport}`); });
  await t.test('rtcPeerConnection', () => { assert.match(escapeMatrix.rtcPeerConnection, /^(?:gateway-stub|absent)/, `RTCPeerConnection leak: ${escapeMatrix.rtcPeerConnection}`); });
  });

  // O4: A-section escape verification in a REWRITTEN document. Every probe
  // must either return a virtual surface or fail closed — a proxy-origin URL
  // or a real-global leak anywhere is a regression.
  await t.test('A-section escapes stay virtual or fail closed', async t => {
    await page.evaluate(target => { __zp_get(globalThis, 'location').href = target; }, `http://${targetHost}:${targetPort}/escape-probes`);
    await page.waitForFunction(() => window.__escapeProbes, { timeout: 30000 });
    const probes = await page.evaluate(() => window.__escapeProbes);
    fs.writeFileSync(path.join(artifacts, 'e1-escape-probes.json'), JSON.stringify(probes, null, 2));
    const virtual = probes.virtual;
    const virtualURLRe = /^https?:\/\//;
    const noProxy = v => typeof v === 'string' && !v.includes('proxy.localhost') && !v.includes('/zp/');
    await t.test('var/function shadowing keeps local binding', () => {
      assert.equal(probes.varShadow, 'v-shadow');
      assert.equal(probes.letShadow, 'l-shadow');
      assert.equal(probes.fnDeclShadow, 'f-shadow');
    });
    await t.test('computed members on this/globalThis virtualize', () => {
      assert.equal(probes.thisComputed, virtual, `this['location']: ${probes.thisComputed}`);
      assert.equal(probes.globalComputed, virtual, `globalThis['loc'+'ation']: ${probes.globalComputed}`);
    });
    await t.test('dynamic Function this maps to virtual global', () => {
      assert.equal(probes.fnThis, virtual, `Function this: ${probes.fnThis}`);
      assert.equal(probes.fnThisNull, virtual, `Function.call(null) this: ${probes.fnThisNull}`);
    });
    await t.test('eval expression resolves virtual location', () => {
      assert.equal(probes.evalHref, virtual, `eval location.href: ${probes.evalHref}`);
      assert.equal(probes.evalArith, 42);
    });
    await t.test('GOPD and __lookupGetter__ return membrane getters', () => {
      assert.equal(probes.gopdHref, virtual, `GOPD get(): ${probes.gopdHref}`);
      assert.equal(probes.lookupGetter, virtual, `__lookupGetter__: ${probes.lookupGetter}`);
    });
    await t.test('iframe contentDocument.location exposes no proxy URL', () => {
      assert.match(probes.contentDocLocation, virtualURLRe, `contentDocument.location: ${probes.contentDocLocation}`);
      assert.ok(noProxy(probes.contentDocLocation), `contentDocument.location leaked proxy: ${probes.contentDocLocation}`);
    });
    await t.test('navigation.navigate refuses javascript:', () => {
      // Either the URL classifier (TARGET_PROTOCOL_BLOCKED → plain Error) or
      // the facade's isHTTPURL gate (NotSupportedError DOMException) blocks —
      // both are fail-closed; what matters is it threw and nothing executed.
      assert.match(probes.navigationJs, /^blocked:/, `navigation.navigate: ${probes.navigationJs}`);
      assert.equal(probes.navEscaped, 'clean');
      assert.equal(probes.navCurrentEntry, virtual, `navigation.currentEntry.url: ${probes.navCurrentEntry}`);
    });
    await t.test('open() does not execute javascript: URLs', () => {
      assert.equal(probes.openEscaped, 'clean');
      assert.ok(noProxy(probes.openJs) || probes.openJs === 'null-return' || probes.openJs === 'throw:NotSupportedError', `open() child leak: ${probes.openJs}`);
    });
    await t.test('frames[i] surfaces a contained window', () => {
      assert.ok(noProxy(probes.framesIndex) || probes.framesIndex === 'throw:SecurityError', `frames[0].location leak: ${probes.framesIndex}`);
    });
    await t.test('dynamic meta refresh with javascript: is neutralized', () => {
      assert.equal(probes.metaRefresh, 'neutralized', `meta refresh: ${probes.metaRefresh}`);
    });
    await t.test('diagnostics surface exists but stays hidden from page scope', async () => {
      // The fixture read returns -1 — `__zp_diagnostics` is ZP_HIDDEN_RE-
      // filtered on the scope proxy, as intended. The real surface is on the
      // real window, reachable from CDP but not from page code.
      assert.equal(probes.diagnostics, -1);
      assert.ok(await page.evaluate(() => Array.isArray(window.__zp_diagnostics)), '__zp_diagnostics missing on real window');
    });
    assert.equal(new URL(page.url()).origin, proxyOrigin, `page escaped proxy: ${page.url()}`);
  });

  // O5: direct-vs-proxy differential. The SAME fixture source runs once
  // against the raw target server and once through the rewriter+membrane.
  // Every probe must produce identical results; divergences are allowed only
  // where ERRATA documents a semantic limit — each is pinned to the exact
  // documented proxy-side value so a silent behavior change can't hide.
  await t.test('direct-vs-proxy compatibility differential', async t => {
    const targetBase = `http://${targetHost}:${targetPort}`;
    // Separate browser instance — `browser.on('targetcreated')` observes every
    // target in `browser`, so a direct-target page there would poison the
    // suite-wide "all network stays on proxy origin" assertion at the end.
    const directBrowser = await puppeteer.launch({
      headless: true,
      protocolTimeout: 30000,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    let direct;
    try {
      const directPage = await directBrowser.newPage();
      await directPage.goto(`${targetBase}/compat-probes`, { waitUntil: 'domcontentloaded' });
      await directPage.waitForFunction(() => window.__compatProbes, { timeout: 15000 });
      direct = await directPage.evaluate(() => window.__compatProbes);
    } finally {
      await directBrowser.close();
    }
    const expectedDivergences = {
      // Documented limits — proxy value pinned so a silent change can't hide.
      // R2: direct eval caller scope is now native-parity (desc-accessor +
      // real direct eval), so evalDirectLocal is no longer divergent.
    };
    const wireBefore = wireRequests.length;
    await page.evaluate(u => { __zp_get(globalThis, 'location').href = u; }, `${targetBase}/compat-probes`);
    await page.waitForFunction(() => window.__compatProbes, { timeout: 30000 });
    const proxied = await page.evaluate(() => window.__compatProbes);
    fs.writeFileSync(path.join(artifacts, 'compat-differential.json'), JSON.stringify({ direct, proxied }, null, 2));
    assert.deepEqual(Object.keys(proxied).sort(), Object.keys(direct).sort(), 'probe key sets differ between direct and proxied runs');
    const divergent = Object.fromEntries(Object.entries(direct).filter(([k]) => proxied[k] !== direct[k]));
    fs.writeFileSync(path.join(artifacts, 'compat-divergences.json'), JSON.stringify(divergent, null, 2));
    await t.test('B/C/I positive cases match native exactly', () => {
      const unexpected = Object.keys(divergent).filter(k => !(k in expectedDivergences));
      assert.deepEqual(unexpected, [], `unexpected divergences: ${JSON.stringify(divergent)}`);
    });
    await t.test('documented divergences match ERRATA exactly', () => {
      for (const [k, proxyValue] of Object.entries(expectedDivergences)) {
        if (!(k in divergent)) {
          assert.fail(`${k}: expected divergence but results matched — behavior changed, re-audit ERRATA (both=${direct[k]})`);
        }
        assert.equal(proxied[k], proxyValue, `${k}: proxy=${proxied[k]} direct=${direct[k]}`);
      }
    });
    await t.test('proxied page used proxy transport for all target traffic', () => {
      const newWire = wireRequests.slice(wireBefore);
      assert.ok(newWire.some(u => u.startsWith(proxyOrigin + '/')), 'no proxy-origin wire request observed');
      assert.ok(!newWire.some(u => u.startsWith(`${targetBase}/`)), `page issued direct-target requests: ${JSON.stringify(newWire.filter(u => u.startsWith(targetBase)))}`);
      assert.ok(requests.some(r => r.url.startsWith('/compat-echo')), 'upstream never saw /compat-echo');
    });
    // ERRATA J: each URL-bearing attribute / IDL write / CSS form must load
    // through the proxy exactly when it loads natively. Judged from the
    // target's own request log — native requests carry the browser UA,
    // proxied ones TARGET_UA. (A missed rewrite is CSP-blocked, so it shows
    // up here as "native loaded, proxy never asked".)
    await t.test('J: every URL form loads through the proxy exactly when it loads natively', () => {
      const keys = ['poster', 'inputsrc', 'tdbg', 'imagesrcset', 'svgimage', 'imageset', 'mask', 'before', 'shape', 'import', 'bodybg', 'svgbaseval'];
      const seen = (k, proxied) => requests.some(r => r.url.includes('j=' + k) && ((r.userAgent === TARGET_UA) === proxied));
      const table = keys.map(k => [k, seen(k, false), seen(k, true)]);
      fs.writeFileSync(path.join(artifacts, 'compat-j-loads.json'), JSON.stringify(table, null, 2));
      const diverged = table.filter(([, nat, prox]) => nat !== prox).map(([k, nat, prox]) => `${k}: native=${nat} proxy=${prox}`);
      assert.deepEqual(diverged, [], diverged.join('; '));
      assert.ok(table.filter(([, nat]) => nat).length >= 8, `native run loaded too few probes to mean anything: ${JSON.stringify(table)}`);
    });
  });

  // O6: iframe suite — creation/insertion/navigation/srcdoc/blob(blocked)/
  // sandbox/nested/remove-race/postMessage/identity/ownerDocument, all in a
  // rewritten document so the membrane + rewriter paths are what run.
  await t.test('iframe suite', async t => {
    await page.evaluate(u => { __zp_get(globalThis, 'location').href = u; }, `http://${targetHost}:${targetPort}/iframe-probes`);
    try {
      await page.waitForFunction(() => window.__iframeProbes, { timeout: 45000 });
    } catch (e) {
      const stage = await page.evaluate(() => ({ stage: window.__probeStage, partial: window.__iframeProbes || null })).catch(() => null);
      console.log('iframe probes wait failed; stage =', JSON.stringify(stage));
      throw e;
    }
    const probes = await page.evaluate(() => window.__iframeProbes);
    probes.__diag = await page.evaluate(() => window.__zp_diagnostics || null);
    fs.writeFileSync(path.join(artifacts, 'iframe-probes.json'), JSON.stringify(probes, null, 2));
    const targetBase = `http://${targetHost}:${targetPort}`;
    await t.test('creation/insertion/ownerDocument', () => {
      assert.equal(probes.createBlank, 'v:true,true,true', `createBlank: ${probes.createBlank}`);
    });
    await t.test('identity surfaces', () => {
      // contentWindow facade stability + frames[i]/parent mapping — pin exact.
      assert.equal(probes.identityStable, 'v:true,true,true', `identityStable: ${probes.identityStable}`);
    });
    await t.test('navigation via src + virtual child location', () => {
      assert.equal(probes.srcLoad, 'v:true', `srcLoad: ${probes.srcLoad}`);
      assert.equal(probes.srcVirtual, `v:${targetBase}/frame-child`, `srcVirtual: ${probes.srcVirtual}`);
    });
    await t.test('postMessage carries virtual origin and stable source', () => {
      assert.equal(probes.postMessage, `v:${targetBase}/frame-child|${targetBase}|${targetBase}|true`, `postMessage: ${probes.postMessage}`);
    });
    await t.test('srcdoc loads with injected prelude', () => {
      assert.equal(probes.srcdocLoad, 'v:inner sd', `srcdocLoad: ${probes.srcdocLoad}`);
      assert.equal(probes.srcdocScript, 'v:sd-ran', `srcdocScript: ${probes.srcdocScript}`);
      assert.equal(probes.srcdocLocation, `v:${targetBase}/iframe-probes`, `srcdocLocation: ${probes.srcdocLocation}`);
    });
    await t.test('blob: iframe src is fail-closed', () => {
      assert.match(probes.blobBlocked, /^v:contained:/, `blobBlocked: ${probes.blobBlocked}`);
    });
    await t.test('sandbox allow-scripts runs opaque-origin child', () => {
      // opaque-origin 자식의 contentDocument 는 네이티브처럼 null 이어야 한다.
      assert.match(probes.sandboxOpaque, /^v:ran\|(null-doc|e:)/, `sandboxOpaque: ${probes.sandboxOpaque}`);
    });
    await t.test('nested srcdoc grandchild gets prelude', () => {
      assert.match(probes.nested, /^v:grandchild-ran\|/, `nested: ${probes.nested}`);
    });
    await t.test('insert/remove race stays clean', () => {
      assert.equal(probes.removeRace, 'v:true', `removeRace: ${probes.removeRace}`);
    });
    assert.equal(new URL(page.url()).origin, proxyOrigin, `page escaped proxy: ${page.url()}`);
  });

  // O7: worker suite — dedicated/module/shared × fetch/importScripts/timers/
  // eval(blocked)/location/storage isolation. Worker scripts are served from
  // the target and rewritten by the SW worker-script path, so the probes
  // exercise real worker-prelude semantics.
  await t.test('worker suite', async t => {
    await page.evaluate(u => { __zp_get(globalThis, 'location').href = u; }, `http://${targetHost}:${targetPort}/worker-probes`);
    try {
      await page.waitForFunction(() => window.__workerProbes, { timeout: 45000 });
    } catch (e) {
      console.log('worker probes wait failed');
      throw e;
    }
    const probes = await page.evaluate(() => window.__workerProbes);
    fs.writeFileSync(path.join(artifacts, 'worker-probes.json'), JSON.stringify(probes, null, 2));
    const targetBase = `http://${targetHost}:${targetPort}`;
    const d = probes.dedicated || {};
    await t.test('dedicated worker location is virtual', () => {
      assert.equal(d.href, `v:${targetBase}/probe-worker.js`, `href: ${d.href}`);
      assert.equal(d.locProps, `v:http:|${targetHost}:${targetPort}|/probe-worker.js`, `locProps: ${d.locProps}`);
      // WorkerLocation natively has no assign/replace — shape is pinned.
      assert.match(d.locMethods, /^v:(undefined|function),(undefined|function),function$/, `locMethods: ${d.locMethods}`);
    });
    await t.test('dedicated worker network surface', () => {
      assert.equal(d.fetchEcho, 'v:200', `fetchEcho: ${d.fetchEcho}`);
      assert.equal(d.xhrShim, 'v:200', `xhrShim: ${d.xhrShim}`);
      // W3: 동기 XHR 은 /zp/api/sync-fetch park-릴레이 — 진짜 블로킹 + 프록시 전송.
      assert.equal(d.xhrSync, 'v:status:200|worker-echo', `xhrSync: ${d.xhrSync}`);
      // W4: 워커 WebSocket — 페이지 중계 SW 스트림으로 실제 라운드트립.
      // 생성자는 성공하고 연결 실패는 비동기로 표면한다(네이티브 parity).
      assert.equal(d.wsCtor, 'v:constructed', `wsCtor: ${d.wsCtor}`);
      assert.equal(d.wsRoundtrip, 'v:msg:echo:ping', `wsRoundtrip: ${d.wsRoundtrip}`);
      assert.ok(requests.some(r => r.upgrade && String(r.url).startsWith('/ws?w=worker')), `upstream never saw worker /ws upgrade: ${JSON.stringify(requests.filter(r => r.upgrade).map(r => r.url))}`);
      // W5: RTCPeerConnection 은 워커에 [Exposed=Window] — 네이티브 부재라
      // ReferenceError parity. WebTransport 는 워커에 있지만 게이트웨이
      // 미설정 → stub 생성 성공(메서드만 reject, 페이지와 같은 의미).
      assert.equal(d.rtcCtor, 'v:e:ReferenceError', `rtcCtor: ${d.rtcCtor}`);
      assert.equal(d.wtCtor, 'v:constructed:closed', `wtCtor: ${d.wtCtor}`);
      // WorkerEventSource — 프록시 fetch 경유 SSE 라운드트립.
      assert.equal(d.esRoundtrip, 'v:msg:sse-ok', `esRoundtrip: ${d.esRoundtrip}`);
      assert.ok(requests.some(r => r.url.startsWith('/worker-echo')), `upstream never saw /worker-echo: ${JSON.stringify(requests.map(r => r.url))}`);
    });
    await t.test('dedicated worker dynamic code is rewrite-then-execute', () => {
      // W1/W2: zp-page-bundle 이 워커에 실려 eval/Function 이 재작성 경유 실행된다.
      assert.equal(d.evalCode, 'v:2', `evalCode: ${d.evalCode}`);
      assert.equal(d.funcCtor, 'v:7', `funcCtor: ${d.funcCtor}`);
    });
    await t.test('dedicated worker timers', () => {
      assert.equal(d.timerFn, 'v:fired', `timerFn: ${d.timerFn}`);
      // W6: 문자열 타이머는 재작성 후 전역 eval 로 스케줄된다.
      assert.equal(d.timerStr, 'v:ran', `timerStr: ${d.timerStr}`);
    });
    await t.test('dedicated worker importScripts', () => {
      assert.equal(d.importScriptsOK, 'v:imp-ok', `importScriptsOK: ${d.importScriptsOK}`);
      // W7: data:/blob: 소스는 읽어서 재작성 후 전역 실행한다.
      assert.equal(d.importScriptsData, 'v:imported', `importScriptsData: ${d.importScriptsData}`);
      assert.equal(d.importScriptsBlob, 'v:imported', `importScriptsBlob: ${d.importScriptsBlob}`);
      assert.ok(requests.some(r => r.url.startsWith('/worker-imported.js')), 'upstream never saw /worker-imported.js');
    });
    await t.test('dedicated worker storage isolation + fingerprint', () => {
      assert.equal(d.ua, `v:${TARGET_UA}`, `ua: ${d.ua}`);
      assert.equal(d.platform, 'v:Win32', `platform: ${d.platform}`);
      assert.equal(d.idb, 'v:object', `idb: ${d.idb}`);
      assert.equal(d.idbRoundtrip, 'v:listed-virtual', `idbRoundtrip: ${d.idbRoundtrip}`);
      assert.equal(d.cachesRoundtrip, 'v:open+keys=1', `cachesRoundtrip: ${d.cachesRoundtrip}`);
      assert.equal(d.errorStack, 'v:clean', `errorStack: ${d.errorStack}`);
    });
    await t.test('worker virtual surfaces (W8-W12)', () => {
      // self.origin 은 가상 타깃 오리진 — 프록시 오리진 누출 없음.
      assert.equal(d.origin, `v:${targetBase}`, `origin: ${d.origin}`);
      // http://localhost 타깃은 네이티브도 potentially-trustworthy → true.
      // 비-localhost http 타깃이면 가상화 게터가 false 를 돌린다.
      assert.equal(d.secureCtx, 'v:true', `secureCtx: ${d.secureCtx}`);
      // new URL(rel, base) 의 명시 base 는 가상 URL 로 푼다 — 프록시
      // bootstrap URL 이 아니다. 단일 인자 relative 는 네이티브도 TypeError.
      assert.equal(d.urlResolve, `v:${targetBase}/w-abs`, `urlResolve: ${d.urlResolve}`);
      // webkitURL/webkitIndexedDB 는 이 Chrome 워커에 네이티브로 없다 —
      // absent 가 parity. 탑재 브라우저에서는 파사드 별칭이어야 한다.
      assert.equal(d.webkitURLAlias, 'v:absent:undefined', `webkitURLAlias: ${d.webkitURLAlias}`);
      assert.match(d.webkitIDB, /^v:(alias|not-alias:undefined)$/, `webkitIDB: ${d.webkitIDB}`);
      // BroadcastChannel.name 은 페이지가 요청한 이름만 보인다(실제 채널은
      // 타깃 해시 프리픽스로 격리).
      assert.equal(d.bcName, 'v:wp1', `bcName: ${d.bcName}`);
      // OPFS — a per-target subdirectory, but the root handle's name reads ''
      // exactly like the native root (the namespace itself stays invisible).
      assert.equal(d.opfsName, 'v:name:', `opfsName: ${d.opfsName}`);
      // 레거시 FS — 이 Chrome 워커엔 webkitRequestFileSystem 이 실재한다 —
      // 우리는 NotSupportedError 게이트로 fail-closed (프록시 오리진 FS 차단).
      assert.match(d.webkitFS, /^v:(undefined|fn:e:NotSupportedError)$/, `webkitFS: ${d.webkitFS}`);
      assert.equal(d.sharedStorageW, 'v:undefined', `sharedStorageW: ${d.sharedStorageW}`);
    });
    const m = probes.module || {};
    await t.test('module worker imports + meta', () => {
      assert.equal(m.staticImport, 'v:dep-ok', `staticImport: ${m.staticImport}`);
      assert.equal(m.href, `v:${targetBase}/probe-module-worker.js`, `href: ${m.href}`);
      assert.equal(m.fetchEcho, 'v:200', `fetchEcho: ${m.fetchEcho}`);
      assert.equal(m.evalCode, 'v:1', `evalCode: ${m.evalCode}`);
      assert.equal(m.funcCtor, 'v:1', `funcCtor: ${m.funcCtor}`);
      // 모듈 워커 importScripts — Chrome 은 함수 자체는 노출하고 호출 시
      // TypeError("module worker")를 던진다. 스텁이 네이티브로 위임돼 같은
      // TypeError 가 나온다 — 네이티브 parity.
      assert.equal(m.importScriptsStub, 'v:e:TypeError', `importScriptsStub: ${m.importScriptsStub}`);
      assert.ok(requests.some(r => r.url.startsWith('/probe-module-dep.js')), 'upstream never saw module dep');
    });
    const s = probes.shared || {};
    await t.test('shared worker isolation + messaging', () => {
      assert.equal(s.href, `${targetBase}/probe-shared-worker.js`, `href: ${s.href}`);
      assert.equal(s.ua, TARGET_UA, `ua: ${s.ua}`);
      // 실제 SharedWorker 이름은 `zp:w:<hash>:` 접두어로 타깃 격리되지만,
      // 워커 안에서 보이는 self.name 은 페이지가 요청한 이름으로 마스킹된다
      // (네이티브 parity — 네이티브도 인자 이름을 돌려준다).
      assert.equal(s.name, 'swprobe', `name: ${s.name}`);
    });
    assert.equal(new URL(page.url()).origin, proxyOrigin, `page escaped proxy: ${page.url()}`);
  });

  // O8: CSP suite — §K two-sided matrix in a real browser. The proxied
  // document CSP (build_proxied_csp) is asserted on the response header,
  // allowed resources must load, intentional blocks must fire
  // securitypolicyviolation AND land at /zp/api/csp-report (server log).
  await t.test('csp suite', async t => {
    await page.evaluate(u => { __zp_get(globalThis, 'location').href = u; }, `http://${targetHost}:${targetPort}/csp-probes`);
    try {
      await page.waitForFunction(() => window.__cspProbes && window.__cspProbes.done, { timeout: 30000 });
    } catch (e) {
      console.log('csp probes wait failed');
      throw e;
    }
    const probes = await page.evaluate(() => window.__cspProbes);
    fs.writeFileSync(path.join(artifacts, 'csp-probes.json'), JSON.stringify(probes, null, 2));
    const v = probes.violations || [];
    await t.test('inline module executes via blob: script-src', () => {
      // §K top-priority: script-src 에 blob: 가 없으면 __ZP_EXEC_INLINE_MODULE
      // 경로 전체가 죽어 모든 인라인 모듈이 무음 사망한다.
      assert.equal(probes.inlineModule, 'ran', `inlineModule: ${probes.inlineModule}`);
    });
    await t.test('connect-src allows data: and blob: fetch', () => {
      assert.equal(probes.fetchData, '200:hi', `fetchData: ${probes.fetchData}`);
      assert.equal(probes.fetchBlob, '200:bl', `fetchBlob: ${probes.fetchBlob}`);
    });
    await t.test('img/style/font/media allow data: sources', () => {
      assert.equal(probes.imgData, 'loaded', `imgData: ${probes.imgData}`);
      assert.equal(probes.styleData, 'loaded', `styleData: ${probes.styleData}`);
      // 디코드 실패는 허용 — CSP 통과의 판정은 해당 디렉티브 SPV 부재.
      assert.ok(!v.some(x => /^font-src/.test(x)), `font-src violation: ${v}`);
      assert.ok(!v.some(x => /^media-src/.test(x)), `media-src violation: ${v}`);
    });
    await t.test('blocked resources fire securitypolicyviolation', () => {
      assert.equal(probes.objectBlocked, 'spv:object-src', `objectBlocked: ${probes.objectBlocked}`);
      assert.equal(probes.baseBlocked, 'spv:base-uri', `baseBlocked: ${probes.baseBlocked}`);
      // manifest 는 headless Chrome 이 삽입 시점에 fetch 하지 않는다 — 요청이
      // 없으니 SPV 도 없다. 디렉티브 존재 자체는 응답 헤더 단언이 검증한다.
      assert.equal(probes.manifestBlocked, 'no-spv', `manifestBlocked: ${probes.manifestBlocked}`);
      // prefetch 도 headless 에서는 fetch 자체가 안 나간다 — §K 의 "prefetch
      // 막힘" 손실은 유효하나 SPV 관측은 불가. 디렉티브 부재는 헤더 단언이 커버.
      assert.equal(probes.prefetchBlocked, 'no-spv', `prefetchBlocked: ${probes.prefetchBlocked}`);
    });
    await t.test('sealed paths fail before CSP (divergence pins)', () => {
      // frame-src data:/worker-src blob: 는 CSP 상 허용이지만 속성/훅 정책이
      // 먼저 봉인한다 — 어느 쪽이든 네트워크 도달 없이 차단돼야 한다.
      assert.match(probes.frameDataSrc, /^(blocked:|set:(about:|http:\/\/proxy))/,
        `frameDataSrc: ${probes.frameDataSrc}`);
      assert.ok(!v.some(x => /^frame-src|^child-src/.test(x)), `frame violation leaked: ${v}`);
      assert.match(probes.workerBlob, /^(blocked:|created)/, `workerBlob: ${probes.workerBlob}`);
    });
    await t.test('unsafe-inline/unsafe-eval paths work', () => {
      assert.equal(probes.inlineHandler, 'ran', `inlineHandler: ${probes.inlineHandler}`);
      assert.equal(probes.evalPath, 'v:42', `evalPath: ${probes.evalPath}`);
    });
    await t.test('CSP meta injection is intersected, not dropped', () => {
      // default-src 'none' meta — 필터 후 data: img 허용이 남아 로드된다.
      assert.equal(probes.metaNeutralized, 'img-loaded-after-meta', `metaNeutralized: ${probes.metaNeutralized}`);
      // img-src 'none' — 배관과 무관한 순수 엄격화는 verbatim 으로 지켜진다.
      assert.equal(probes.metaStricter, 'img-blocked', `metaStricter: ${probes.metaStricter}`);
    });
    await t.test('response CSP matches proxied policy contract', () => {
      // 네비게이션 응답 헤더 — share URL 응답의 CSP 를 CDP 로 읽는다.
      // /zp/api/* 응답도 CSP 를 싣지만 그건 control-surface 정책(build_csp)
      // 이라 문서 정책과 다르다 — pathname 이 정확히 share 경로인 것만 본다.
      // 같은 /zp/ 경로라도 Go 서버의 공유-엔드포인트 응답은 control CSP 를 싣는다
      // — 프록시드 문서 정책(build_proxied_csp)만 report-uri 를 포함하므로 그걸로 식별.
      const docHeaders = [...responseHeaders.entries()]
        .filter(([u]) => { try { const p = new URL(u); return p.origin === proxyOrigin && (p.pathname === '/zp/' || p.pathname.startsWith('/zp/p/')); } catch { return false; } })
        .map(([, h]) => h['content-security-policy'] || h['Content-Security-Policy'])
        .find(csp => csp && /report-uri/.test(String(csp)));
      assert.ok(docHeaders, 'proxied document CSP header not captured');
      const csp = String(docHeaders);
      assert.match(csp, /default-src 'none'/, 'default-src');
      assert.match(csp, /script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:/, 'script-src must carry blob: for inline modules');
      assert.match(csp, /connect-src [^;]*blob: data:/, 'connect-src must carry blob:/data:');
      assert.match(csp, /media-src 'self' blob: data:/, 'media-src');
      assert.match(csp, /worker-src 'self' blob:/, 'worker-src');
      assert.match(csp, /object-src 'none'/, 'object-src');
      assert.match(csp, /base-uri 'none'/, 'base-uri');
      assert.match(csp, /form-action 'self'/, 'form-action');
      assert.match(csp, /manifest-src 'self'/, 'manifest-src');
      assert.match(csp, /report-uri \/zp\/api\/csp-report/, 'report-uri');
      // 프록시 문서에는 frame-ancestors 없음(우리가 프레임에 싣는다) +
      // 모방 방지 지시어 부재 (§K correctly-absent 목록).
      assert.ok(!/frame-ancestors/.test(csp), 'frame-ancestors must be absent on proxied docs');
      for (const absent of ['trusted-types', 'require-trusted-types-for', 'sandbox', 'upgrade-insecure-requests', 'block-all-mixed-content']) {
        assert.ok(!csp.includes(absent), `${absent} must be absent`);
      }
    });
    await t.test('violation reports reach the server log', async () => {
      // report-uri → /zp/api/csp-report → Go 서버 [CSP] 로그 라인.
      // 브라우저 리포트는 비동기 — 잠깐 기다린 뒤 로그를 확인한다.
      await new Promise(r => setTimeout(r, 1500));
      assert.match(proxyLog, /\[CSP\] blocked=.*directive=object-src/, `no object-src report in server log`);
      assert.match(proxyLog, /\[CSP\] blocked=.*directive=base-uri/, `no base-uri report in server log`);
    });
    assert.equal(new URL(page.url()).origin, proxyOrigin, `page escaped proxy: ${page.url()}`);
  });

  // O9: dynamic code suite — §E eval/Function/timers/event handlers/DOM
  // insertion × success/exception/source-leak.
  await t.test('dynamic code suite', async t => {
    await page.evaluate(u => { __zp_get(globalThis, 'location').href = u; }, `http://${targetHost}:${targetPort}/dyn-probes`);
    try {
      await page.waitForFunction(() => window.__dynProbes && window.__dynProbes.done, { timeout: 30000 });
    } catch (e) {
      console.log('dyn probes wait failed');
      throw e;
    }
    const probes = await page.evaluate(() => window.__dynProbes);
    fs.writeFileSync(path.join(artifacts, 'dyn-probes.json'), JSON.stringify(probes, null, 2));
    const targetBase = `http://${targetHost}:${targetPort}`;

    // The pins below were once written from proxy-only runs, and four of them
    // encoded divergences as "designed" (onclick strings executing, eval parse
    // errors as NotSupportedError, …). Run the same fixture natively and hold
    // the proxy to it — a pin that disagrees with Chrome is a bug, not a spec.
    await t.test('dyn probes match native Chrome (direct-vs-proxy)', async () => {
      const directBrowser = await puppeteer.launch({
        headless: true,
        protocolTimeout: 30000,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      let direct;
      try {
        const directPage = await directBrowser.newPage();
        await directPage.goto(`${targetBase}/dyn-probes`, { waitUntil: 'domcontentloaded' });
        await directPage.waitForFunction(() => window.__dynProbes && window.__dynProbes.done, { timeout: 30000 });
        direct = await directPage.evaluate(() => window.__dynProbes);
      } finally {
        await directBrowser.close();
      }
      fs.writeFileSync(path.join(artifacts, 'dyn-differential.json'), JSON.stringify({ direct, proxied: probes }, null, 2));
      assert.deepEqual(Object.keys(probes).sort(), Object.keys(direct).sort(), 'dyn probe key sets differ');
      const divergent = Object.fromEntries(Object.keys(direct)
        .filter(k => probes[k] !== direct[k])
        .map(k => [k, { direct: direct[k], proxied: probes[k] }]));
      assert.deepEqual(divergent, {}, `dyn probes diverge from native: ${JSON.stringify(divergent)}`);
    });

    await t.test('eval success and virtual scope', () => {
      assert.equal(probes.evalBasic, 'v:2', `evalBasic: ${probes.evalBasic}`);
      assert.equal(probes.evalLocation, `v:${targetBase}/dyn-probes`, `evalLocation: ${probes.evalLocation}`);
      assert.equal(probes.evalStrict, `v:${targetBase}`, `evalStrict: ${probes.evalStrict}`);
      assert.equal(probes.evalNonString, 'v:[123,null,null]', `evalNonString: ${probes.evalNonString}`);
    });
    await t.test('eval exceptions and edge forms', () => {
      // 파스 불가 eval 은 네이티브처럼 SyntaxError — 어느 쪽이든 한 줄도 실행되지
      // 않는다. (예전 NotSupportedError 핀은 네이티브 대조 없이 적은 것이었다.)
      assert.equal(probes.evalSyntaxError, 'threw:SyntaxError', `evalSyntaxError: ${probes.evalSyntaxError}`);
      assert.equal(probes.evalIndirect, `v:${targetBase}`, `evalIndirect: ${probes.evalIndirect}`);
      assert.equal(probes.evalCall, 'v:5', `evalCall: ${probes.evalCall}`);
      // R5 parity — 네이티브 eval 은 non-constructor, `new eval()` 은 TypeError.
      assert.equal(probes.evalAsCtor, 'threw:TypeError', `evalAsCtor: ${probes.evalAsCtor}`);
      // tagged eval`x` 는 문자열 배열(비문자열)을 받아 평가 없이 그대로 돌려준다.
      assert.equal(probes.evalTagged, 'v:object', `evalTagged: ${probes.evalTagged}`);
      // eval 이 만든 var 는 다음 접근에서 보인다(네이티브 parity).
      assert.equal(probes.evalVarVisible, 'v:42', `evalVarVisible: ${probes.evalVarVisible}`);
    });
    await t.test('Function paths', () => {
      assert.equal(probes.fnBasic, 'v:42', `fnBasic: ${probes.fnBasic}`);
      assert.equal(probes.fnParams, 'v:42', `fnParams: ${probes.fnParams}`);
      assert.equal(probes.fnDefaultParam, 'v:5', `fnDefaultParam: ${probes.fnDefaultParam}`);
      assert.equal(probes.fnCommentParam, 'v:9', `fnCommentParam: ${probes.fnCommentParam}`);
      assert.equal(probes.fnLocation, `v:${targetBase}`, `fnLocation: ${probes.fnLocation}`);
      assert.equal(probes.asyncFn, 'v:8', `asyncFn: ${probes.asyncFn}`);
      // A3 fix 검증 — dynamic Function 의 this 는 가상 글로벌이다.
      assert.equal(probes.fnThisIsWindow, 'v:true', `fnThisIsWindow: ${probes.fnThisIsWindow}`);
      assert.ok(String(probes.fnThis).startsWith(`v:${targetBase}`), `fnThis: ${probes.fnThis}`);
      assert.equal(probes.fnWith, 'v:1', `fnWith: ${probes.fnWith}`);
      assert.equal(probes.fnNestedEval, 'v:9', `fnNestedEval: ${probes.fnNestedEval}`);
      assert.equal(probes.asyncFnCtor, 'v:ctor-same', `asyncFnCtor: ${probes.asyncFnCtor}`);
    });
    await t.test('string timers', () => {
      assert.equal(probes.timerString, 'v:7', `timerString: ${probes.timerString}`);
      assert.equal(probes.timerVirtual, `v:${targetBase}`, `timerVirtual: ${probes.timerVirtual}`);
      assert.ok(probes.intervalString && probes.intervalString.startsWith('v:') && +probes.intervalString.slice(2) >= 1, `intervalString: ${probes.intervalString}`);
      // 타이머 문자열 안의 this["location"] 도 가상화된다(A2 연동).
      assert.ok(String(probes.timerThis).startsWith(`v:${targetBase}`), `timerThis: ${probes.timerThis}`);
      // 타이머 문자열의 문법 오류는 네이티브처럼 발화 시점에 비동기 에러로
      // 보고된다 — 등록(setTimeout)은 던지지 않는다.
      assert.equal(probes.timerBad, 'v:error-surfaced', `timerBad: ${probes.timerBad}`);
    });
    await t.test('event handlers', () => {
      assert.equal(probes.handlerStatic, 'v:1', `handlerStatic: ${probes.handlerStatic}`);
      assert.equal(probes.handlerPropFn, `v:${targetBase}`, `handlerPropFn: ${probes.handlerPropFn}`);
      // onclick 프로퍼티에 문자열을 넣으면 네이티브는 null 로 무시한다 —
      // 컴파일/실행하지 않는다(content attribute 만 컴파일된다).
      assert.equal(probes.handlerPropString, 'v:silent', `handlerPropString: ${probes.handlerPropString}`);
    });
    await t.test('module kind survives import/export-free modules', () => {
      // 네이티브 값. classic 리라이트면 'v:a|undefined' / 'v:c|undefined'.
      assert.equal(probes.staticModuleLex, 'v:a|b', `staticModuleLex: ${probes.staticModuleLex}`);
      assert.equal(probes.dynModuleTypeAfterSrc, 'v:c|k', `dynModuleTypeAfterSrc: ${probes.dynModuleTypeAfterSrc}`);
    });
    await t.test('blob worker source is fixed at construction', () => {
      // 네이티브 값. 구 빌드는 워커가 해제된 URL 을 읽다가 fail-closed 했다.
      assert.equal(probes.blobWorkerRevoked, 'v:blob:a', `blobWorkerRevoked: ${probes.blobWorkerRevoked}`);
      assert.equal(probes.workerSelfMethods, 'v:a,number,true,true', `workerSelfMethods: ${probes.workerSelfMethods}`);
    });
    await t.test('DOM insertion', () => {
      assert.equal(probes.docWrite, 'v:wrote', `docWrite: ${probes.docWrite}`);
      // native parity — innerHTML/insertAdjacentHTML/DOMParser 스크립트는
      // 실행되지 않는다(어느 쪽이든 unrewritten 실행은 안 된다).
      assert.equal(probes.innerHTMLScript, 'v:silent', `innerHTMLScript: ${probes.innerHTMLScript}`);
      assert.equal(probes.adjacentScript, 'v:silent', `adjacentScript: ${probes.adjacentScript}`);
      assert.equal(probes.domParserScript, 'v:silent', `domParserScript: ${probes.domParserScript}`);
    });
    await t.test('dynamic import()', () => {
      assert.equal(probes.importHttp, `v:1|${targetBase}/dyn-mod.js`, `importHttp: ${probes.importHttp}`);
      // D2/D3: data:/blob: 모듈은 디코드·읽기 → 페이지 재작성기 → 재작성된
      // blob URL 로 import 한다 — 네이티브와 같이 모듈이 실행된다.
      assert.equal(probes.importData, 'v:1', `importData: ${probes.importData}`);
      assert.equal(probes.importBlob, 'v:3', `importBlob: ${probes.importBlob}`);
    });
    await t.test('no source or path leaks', () => {
      for (const k of ['leakFnToString', 'leakCallee', 'leakDynStack', 'leakFnStack']) {
        assert.equal(probes[k], 'v:clean', `${k}: ${probes[k]}`);
      }
    });
    assert.equal(new URL(page.url()).origin, proxyOrigin, `page escaped proxy: ${page.url()}`);
  });

  // O10: perf suite — 10M 루프캡 경계, async-poll 수명, bulk DOM,
  // iframe 수×로드시간 (`/perf-probes` fixture, window.__perfProbes).
  await t.test('perf suite', async t => {
    await page.evaluate(u => { __zp_get(globalThis, 'location').href = u; }, `http://${targetHost}:${targetPort}/perf-probes`);
    try {
      await page.waitForFunction(() => window.__perfProbes && window.__perfProbes.done, { timeout: 60000 });
    } catch (e) {
      console.log('perf probes wait failed');
      throw e;
    }
    const probes = await page.evaluate(() => window.__perfProbes);
    fs.writeFileSync(path.join(artifacts, 'perf-probes.json'), JSON.stringify(probes, null, 2));
    assert.ok(!probes.__fatal, `perf fixture died: ${probes.__fatal}`);

    await t.test('10M loop-cap boundary', () => {
      // 미만 루프는 캡 미발화로 정상 완료.
      assert.equal(probes.underCap, 'v:5000000', `underCap: ${probes.underCap}`);
      // 초과 루프는 hang 대신 캡에서 종료 — 카운터 값이 정확히 10M.
      assert.equal(probes.cappedWhile, 'v:10000000', `cappedWhile: ${probes.cappedWhile}`);
      // ERRATA §L 의 `for(i=0;;i++)` uncapped 예측 — 캡됨이면 10M,
      // 우회면 12000001 에서 멈췄을 것이다.
      assert.equal(probes.cappedFor, 'v:10000000', `cappedFor (uncapped 우회면 12000001): ${probes.cappedFor}`);
      // do{}while 는 post-test — 바디가 카운터 검사보다 한 번 먼저 도니
      // 경계는 10M+1 (캡 자체는 유효, hang 아님).
      assert.equal(probes.cappedDo, 'v:10000001', `cappedDo: ${probes.cappedDo}`);
      // negative control — 일반 루프에 카운터가 끼면 n>3 이 된다.
      assert.equal(probes.normalLoop, 'v:3', `normalLoop: ${probes.normalLoop}`);
      // outer=100 에서 break 가 inner 보다 먼저 발화 — inner 는 99×100.
      assert.equal(probes.nestedLoops, 'v:100|9900', `nestedLoops: ${probes.nestedLoops}`);
    });

    await t.test('async-poll lifetime', () => {
      // 캡 prefix 가 붙은 async while(true) 도 break 가 정상 발화.
      assert.equal(probes.asyncPollBreak, 'v:20', `asyncPollBreak: ${probes.asyncPollBreak}`);
      // 조건 폴러는 flag 설정까지 살아 있다가 break 후 완전히 죽는다
      // (atExit === polls → 좀비 폴러 없음).
      assert.equal(probes.asyncPollFlag, 'v:true|true|true', `asyncPollFlag: ${probes.asyncPollFlag}`);
    });

    await t.test('bulk DOM insertion', () => {
      const m = /^v:(\d+)\|(\d+)$/.exec(probes.bulkDom || '');
      assert.ok(m, `bulkDom: ${probes.bulkDom}`);
      assert.ok(+m[1] >= 5000, `bulkDom count: ${probes.bulkDom}`);
      // 상한만 잡는다 — 멤브레인 직렬화가 재앙급이면 여기서 걸린다.
      assert.ok(+m[2] < 15000, `bulkDom ms: ${probes.bulkDom}`);
    });

    await t.test('iframe count x load time', () => {
      const m = /^v:([^|]+)\|(\d+)$/.exec(probes.iframes || '');
      assert.ok(m, `iframes: ${probes.iframes}`);
      assert.equal(m[1], 'loaded,loaded,loaded,loaded,loaded', `iframe results: ${probes.iframes}`);
      // 5개 srcdoc 프레임 병렬 — 프레임당 프렐루드 주입이 있어도 상한 안.
      assert.ok(+m[2] < 30000, `iframe ms: ${probes.iframes}`);
    });

    await t.test('membrane hot-loop cost (T5-3)', () => {
      // 측정값 리포트 — 재앙급 회귀만 상한으로 잡는다.
      const mm = /^v:(\d+)ms\|(\d+)$/.exec(probes.membraneRead || '');
      assert.ok(mm, `membraneRead: ${probes.membraneRead}`);
      assert.ok(+mm[1] < 20000, `membrane read 200k too slow: ${probes.membraneRead}`);
      const mo = /^v:(\d+)ms$/.exec(probes.moOverhead || '');
      assert.ok(mo, `moOverhead: ${probes.moOverhead}`);
      assert.ok(+mo[1] < 15000, `MutationObserver overhead too high: ${probes.moOverhead}`);
      console.log(`[perf] membraneRead=${mm[1]}ms moOverhead=${mo[1]}ms`);
    });
    assert.equal(new URL(page.url()).origin, proxyOrigin, `page escaped proxy: ${page.url()}`);
  });

  // Windows of another site. Every proxied frame shares one physical origin, so
  // the browser's same-origin policy cannot separate them; the membrane has to.
  // Native Chrome lets a cross-origin window be used through a short fixed list
  // (postMessage, closed, frames, location navigation, …) and throws
  // SecurityError for everything else — in both directions, and for popups.
  await t.test('cross-site frame and popup access matches native', async () => {
    const targetBase = `http://${targetHost}:${targetPort}`;
    const directBrowser = await puppeteer.launch({ headless: true, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let direct;
    try {
      const directPage = await directBrowser.newPage();
      await directPage.goto(`${targetBase}/xsite`, { waitUntil: 'domcontentloaded' });
      await directPage.waitForFunction(() => window.__xsite, { timeout: 45000, polling: 100 });
      direct = await directPage.evaluate(() => window.__xsite);
    } finally {
      await directBrowser.close();
    }
    await page.evaluate(u => { __zp_get(globalThis, 'location').href = u; }, `${targetBase}/xsite`);
    await page.waitForFunction(() => window.__xsite, { timeout: 60000, polling: 100 });
    const proxied = await page.evaluate(() => window.__xsite);
    fs.writeFileSync(path.join(artifacts, 'xsite-differential.json'), JSON.stringify({ direct, proxied }, null, 2));
    assert.ok(!direct.__fatal, `native reference died: ${direct.__fatal}`);
    assert.ok(!proxied.__fatal, `proxied fixture died: ${proxied.__fatal}`);
    // The reference itself: the facts the comparison stands on.
    assert.equal(direct['p2c.cross.document'], 'threw:SecurityError');
    assert.equal(direct['p2c.cross.localStorage'], 'threw:SecurityError');
    assert.equal(direct['p2c.cross.contentDocument'], 'null');
    assert.equal(direct['p2c.cross.postMessage'], 'function');
    assert.equal(direct['p2c.same.document'], 'object');
    assert.equal(direct['c2p.cross.frameElement'], 'null');
    assert.equal(direct['c2p.cross.parentDocument'], 'threw:SecurityError');
    assert.equal(direct['c2p.same.parentDocument'], 'object');
    assert.equal(direct['pop.handle.document'], 'threw:SecurityError');
    assert.equal(direct['pop.opener.openerDocument'], 'threw:SecurityError');
    assert.equal(direct['pm.cross.wrong'], 'dropped');
    assert.equal(direct['pm.cross.ownOrigin'], 'dropped');
    assert.equal(direct['pm.cross.optionsStar'], 'delivered');
    assert.equal(direct['named.cross.bracket'], 'threw:SecurityError');
    assert.equal(direct['reply.sources'], 'cross,same');
    assert.match(direct['reply.cross'], /"srcIsParent":true,"srcIsTop":true,"origin":"http:\/\/[^"]+","trusted":true/);
    assert.ok(Object.keys(direct).length >= 130, `too few probes ran natively: ${Object.keys(direct).length}`);
    assert.deepEqual(Object.keys(proxied).sort(), Object.keys(direct).sort(), 'probe key sets differ');
    // Documented divergence: a same-site child's `top`/`parent` read through a
    // local alias are the raw windows (the rewriter leaves window-chain members
    // on aliases unwrapped — hot path), so they are not identical to the page's
    // own window object. ERRATA, cross-site frames section.
    const expected = new Set(['p2c.same.top', 'p2c.same.parent']);
    const unexpected = Object.keys(direct).filter(k => proxied[k] !== direct[k] && !expected.has(k))
      .map(k => `${k}: native=${direct[k]} proxy=${proxied[k]}`);
    assert.deepEqual(unexpected, [], unexpected.join('\n'));
    const healed = [...expected].filter(k => proxied[k] === direct[k]);
    assert.deepEqual(healed, [], `now match native — update ERRATA and this list: ${healed.join(', ')}`);
  });

  // The page's copy of the cookie jar must learn what happens elsewhere: another
  // document's response, an image or script, a synchronous XHR, a sibling frame.
  await t.test('cookies reach every document that can see them, and no other (matches native)', async () => {
    const targetBase = `http://${targetHost}:${targetPort}`;
    const directBrowser = await puppeteer.launch({ headless: true, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let direct;
    try {
      const directPage = await directBrowser.newPage();
      await directPage.goto(`${targetBase}/xcookie2`, { waitUntil: 'domcontentloaded' });
      await directPage.waitForFunction(() => window.__xcookie2, { timeout: 60000, polling: 100 });
      direct = await directPage.evaluate(() => window.__xcookie2);
    } finally {
      await directBrowser.close();
    }
    await page.evaluate(u => { __zp_get(globalThis, 'location').href = u; }, `${targetBase}/xcookie2`);
    await page.waitForFunction(() => window.__xcookie2, { timeout: 90000, polling: 100 });
    const proxied = await page.evaluate(() => window.__xcookie2);
    fs.writeFileSync(path.join(artifacts, 'cookies-from-elsewhere.json'), JSON.stringify({ direct, proxied }, null, 2));
    assert.ok(!direct.__fatal, `native reference died: ${direct.__fatal}`);
    assert.ok(!proxied.__fatal, `proxied fixture died: ${proxied.__fatal}`);
    // The reference itself: what the comparison stands on.
    assert.equal(direct['frame.navigation'], 'ck2_frame');
    assert.equal(direct['image'], 'ck2_frame,ck2_img');
    assert.equal(direct['script'], 'ck2_frame,ck2_img,ck2_script');
    assert.equal(direct['sync.xhr.immediately'], 'ck2_frame,ck2_img,ck2_script,ck2_sync', 'a synchronous XHR returns with its cookies already readable');
    assert.equal(direct['sibling.write.parent'], 'ck2_child,ck2_frame,ck2_img,ck2_script,ck2_sync');
    assert.equal(direct['child.same.reads'], 'ck2_child,ck2_frame,ck2_img,ck2_parent,ck2_script,ck2_sync');
    assert.equal(direct['child.cross.reads'], '', 'another site reads none of them');
    assert.deepEqual(proxied, direct);
  });

  // The jar is shared between tabs of one site, natively and here — so a cookie written
  // in one tab, or set by a response to another, must reach the other tab's copy.
  await t.test('a cookie reaches the other tab of the same site (matches native)', async () => {
    const targetBase = `http://${targetHost}:${targetPort}`;
    const names = p => p.evaluate(() => document.cookie.split('; ').filter(Boolean).map(c => c.split('=')[0]).filter(n => n.indexOf('ck3_') === 0).sort().join(','));
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const scenario = async (a, b) => {
      const out = {};
      await a.evaluate(() => { document.cookie = 'ck3_written=1; Path=/'; });
      await wait(900);
      out['written in A: A'] = await names(a);
      out['written in A: B'] = await names(b);
      await b.evaluate(() => fetch('/xsetcookie?n=ck3_response').then(r => r.text()));
      await wait(900);
      out['set by a response in B: A'] = await names(a);
      out['set by a response in B: B'] = await names(b);
      return out;
    };
    const directBrowser = await puppeteer.launch({ headless: true, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let direct;
    try {
      const a = await directBrowser.newPage();
      const b = await directBrowser.newPage();
      await a.goto(`${targetBase}/xtab`, { waitUntil: 'domcontentloaded' });
      await b.goto(`${targetBase}/xtab`, { waitUntil: 'domcontentloaded' });
      direct = await scenario(a, b);
    } finally {
      await directBrowser.close();
    }
    const a = await browser.newPage();
    const b = await browser.newPage();
    let proxied;
    try {
      assert.ok(await openThroughLauncher(a, proxyOrigin, `${targetBase}/xtab`), 'tab A reached the target');
      assert.ok(await openThroughLauncher(b, proxyOrigin, `${targetBase}/xtab`), 'tab B reached the target');
      proxied = await scenario(a, b);
    } finally {
      await a.close().catch(() => {});
      await b.close().catch(() => {});
    }
    fs.writeFileSync(path.join(artifacts, 'cookies-across-tabs.json'), JSON.stringify({ direct, proxied }, null, 2));
    assert.equal(direct['written in A: B'], 'ck3_written', 'natively the other tab reads it');
    assert.equal(direct['set by a response in B: A'], 'ck3_response,ck3_written');
    assert.deepEqual(proxied, direct);
  });

  // window.name belongs to a browsing context and the lock manager to an origin. Every
  // proxied site shares one physical origin, and the name store was keyed by tab and
  // origin: a same-site frame read its parent's name; lock queries listed every site's.
  await t.test('window.name stays with its own frame and lock queries stay inside the site', async () => {
    const targetBase = `http://${targetHost}:${targetPort}`;
    const directBrowser = await puppeteer.launch({ headless: true, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let direct;
    try {
      const directPage = await directBrowser.newPage();
      await directPage.goto(`${targetBase}/xnames`, { waitUntil: 'domcontentloaded' });
      await directPage.waitForFunction(() => window.__xnames, { timeout: 60000, polling: 100 });
      direct = await directPage.evaluate(() => window.__xnames);
    } finally {
      await directBrowser.close();
    }
    await page.evaluate(u => { __zp_get(globalThis, 'location').href = u; }, `${targetBase}/xnames`);
    await page.waitForFunction(() => window.__xnames, { timeout: 90000, polling: 100 });
    const proxied = await page.evaluate(() => window.__xnames);
    fs.writeFileSync(path.join(artifacts, 'names-and-locks.json'), JSON.stringify({ direct, proxied }, null, 2));
    assert.ok(!direct.__fatal, `native reference died: ${direct.__fatal}`);
    assert.ok(!proxied.__fatal, `proxied fixture died: ${proxied.__fatal}`);
    // The reference itself: what the comparison stands on.
    assert.equal(direct['child.plain'], 'name= held=zp_names_lock pending=0', 'a frame starts unnamed and sees its own site\'s lock');
    assert.equal(direct['child.cross'], 'name= held= pending=0', 'another site sees neither');
    assert.equal(direct['child.named'], 'name=child_named held=zp_names_lock pending=0');
    assert.equal(direct['parent.name'], 'parent_window_name');
    assert.equal(direct['parent.readsChildName'], 'child_named');
    assert.equal(direct['afterChildRename.parent'], 'parent_window_name', 'a frame naming itself does not rename its parent');
    assert.deepEqual(proxied, direct);
  });

  // Cookies the server sets in answer to a page's fetch / XHR. The page's copy of the
  // jar was a snapshot taken at load: document.cookie and cookieStore never saw them.
  await t.test('cookies set by fetch and XHR responses are visible to the page and match native', async () => {
    const targetBase = `http://${targetHost}:${targetPort}`;
    const directBrowser = await puppeteer.launch({ headless: true, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let direct;
    try {
      const directPage = await directBrowser.newPage();
      await directPage.goto(`${targetBase}/xcookie`, { waitUntil: 'domcontentloaded' });
      await directPage.waitForFunction(() => window.__xcookie, { timeout: 60000, polling: 100 });
      direct = await directPage.evaluate(() => window.__xcookie);
    } finally {
      await directBrowser.close();
    }
    await page.evaluate(u => { __zp_get(globalThis, 'location').href = u; }, `${targetBase}/xcookie`);
    await page.waitForFunction(() => window.__xcookie, { timeout: 90000, polling: 100 });
    const proxied = await page.evaluate(() => window.__xcookie);
    fs.writeFileSync(path.join(artifacts, 'server-set-cookies.json'), JSON.stringify({ direct, proxied }, null, 2));
    assert.ok(!direct.__fatal, `native reference died: ${direct.__fatal}`);
    assert.ok(!proxied.__fatal, `proxied fixture died: ${proxied.__fatal}`);
    // The reference itself: what the comparison stands on.
    assert.equal(direct['fetch.visible'], 'tok');
    assert.equal(direct['fetch.httpOnly.visible'], 'absent', 'a script never reads an HttpOnly cookie');
    assert.equal(direct['xhr.visible'], 'tok');
    assert.equal(direct['redirect.visible'], 'tok', 'a cookie set on a redirect hop is stored');
    assert.equal(direct['omit.visible'], 'absent', 'credentials: omit stores nothing');
    assert.equal(direct['update.value'], 'two');
    assert.equal(direct['gone.before'], 'tok');
    assert.equal(direct['gone.after'], 'absent', 'Max-Age=0 deletes');
    assert.equal(direct['store.get'], 'present');
    assert.equal(direct['sent.back'], 'as expected');
    assert.deepEqual(proxied, direct);
  });

  // Storage events across sites. The browser fires its own storage event in every
  // frame of the shared physical origin — one site heard another's writes (key
  // with our prefix, the other site's new value) and our own bookkeeping keys.
  await t.test('storage events stay inside the writing site and match native', async () => {
    const targetBase = `http://${targetHost}:${targetPort}`;
    const directBrowser = await puppeteer.launch({ headless: true, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let direct;
    try {
      const directPage = await directBrowser.newPage();
      await directPage.goto(`${targetBase}/xstore`, { waitUntil: 'domcontentloaded' });
      await directPage.waitForFunction(() => window.__xstore, { timeout: 60000, polling: 100 });
      direct = await directPage.evaluate(() => window.__xstore);
    } finally {
      await directBrowser.close();
    }
    await page.evaluate(u => { __zp_get(globalThis, 'location').href = u; }, `${targetBase}/xstore`);
    await page.waitForFunction(() => window.__xstore, { timeout: 90000, polling: 100 });
    const proxied = await page.evaluate(() => window.__xstore);
    fs.writeFileSync(path.join(artifacts, 'storage-events.json'), JSON.stringify({ direct, proxied }, null, 2));
    assert.ok(!direct.__fatal, `native reference died: ${direct.__fatal}`);
    assert.ok(!proxied.__fatal, `proxied fixture died: ${proxied.__fatal}`);
    // The reference itself: what the comparison stands on.
    assert.equal(direct['cross.write'], '', 'another site writing is not heard natively');
    assert.equal(direct['same.write'], 'k_child|null|v1|local|true,s_child|null|v1|session|true');
    assert.equal(direct['same.rewrite'], '', 'an unchanged value fires nothing');
    assert.equal(direct['same.update'], 'k_child|v1|v2|local|true');
    assert.equal(direct['same.remove'], 'k_child|v2|null|local|true');
    assert.equal(direct['onstorage.keys'], 'k_child,k_child,k_child,s_child', 'the onstorage handler hears the same-site events');
    assert.equal(direct['child.cross.heard'], '', 'the other site hears nothing of this one');
    assert.match(direct['child.same.heard'], /k_parent\|null\|p1\|local\|true\|true/);
    assert.equal(direct['synthetic'], 'synthetic|x|null');
    assert.deepEqual(proxied, direct);
  });

  // The two tests below build many frames — a joint-history entry each, which capped the shared page's
  // history at 50 and made the history-counting test after them read a delta of 0 — and open popups.
  // They get a page of their own.
  const openProxiedPage = async url => {
    const fresh = await browser.newPage();
    await observeTarget(fresh.target());
    assert.ok(await openThroughLauncher(fresh, proxyOrigin, url), `the launcher did not reach ${url}`);
    return fresh;
  };
  // Frames that come out of markup. The page-side HTML walker used to route a frame on its inert
  // parser copy, so a frame made by innerHTML, insertAdjacentHTML, a template or document.write stayed
  // blank for ever.
  await t.test('frames made from markup load and read back as natively', async () => {
    const targetBase = `http://${targetHost}:${targetPort}`;
    const directBrowser = await puppeteer.launch({ headless: true, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let direct;
    try {
      const directPage = await directBrowser.newPage();
      await directPage.goto(`${targetBase}/xmarkup`, { waitUntil: 'domcontentloaded' });
      await directPage.waitForFunction(() => window.__xmarkup, { timeout: 60000, polling: 100 });
      direct = await directPage.evaluate(() => window.__xmarkup);
    } finally {
      await directBrowser.close();
    }
    const fresh = await openProxiedPage(`${targetBase}/xmarkup`);
    let proxied;
    try {
      await fresh.waitForFunction(() => window.__xmarkup, { timeout: 120000, polling: 100 });
      proxied = await fresh.evaluate(() => window.__xmarkup);
    } finally {
      await fresh.close();
    }
    fs.writeFileSync(path.join(artifacts, 'markup-frames.json'), JSON.stringify({ direct, proxied }, null, 2));
    assert.ok(!direct.__fatal, `native reference died: ${direct.__fatal}`);
    assert.ok(!proxied.__fatal, `proxied fixture died: ${proxied.__fatal}`);
    // The reference itself: every way of making the frame ends with the document loaded.
    for (const k of ['innerHTML.title', 'insertAdjacentHTML.beforeend', 'insertAdjacentHTML.afterend', 'insertAdjacentHTML.beforebegin', 'setHTMLUnsafe', 'outerHTML', 'template.import', 'template.clone', 'createContextualFragment', 'DOMParser.adopt', 'document.write', 'innerHTML.late']) {
      assert.equal(direct[k], 'frame ready', `${k}: the native reference changed`);
    }
    assert.equal(direct['innerHTML.src'], '/xframe-title', 'the author\'s text, not the resolved URL');
    assert.equal(direct['innerHTML.read'], '<iframe src="/xframe-title" name="m"></iframe>');
    assert.equal(direct['template.src'], '/xframe-title');
    assert.equal(direct['innerHTML.srcdoc.prop'], '<p id=x>from srcdoc</p>', 'the page\'s text, not the document the proxy made of it');
    assert.equal(direct['innerHTML.srcdoc.attr'], '<p id=x>from srcdoc</p>');
    assert.equal(direct['innerHTML.srcdoc.body'], '<p id="x">from srcdoc</p>', 'and the document it shows');
    assert.deepEqual(proxied, direct);
  });

  // A script put into the document by an unhooked door reached the browser un-rewritten and ran raw —
  // `location` read the proxy's URL and assigning it left for the real target. Every door a node can come
  // through is hooked now.
  await t.test('scripts put in by every insertion door run through the membrane (matches native)', async () => {
    const targetBase = `http://${targetHost}:${targetPort}`;
    const directBrowser = await puppeteer.launch({ headless: true, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let direct;
    try {
      const directPage = await directBrowser.newPage();
      await directPage.goto(`${targetBase}/xinsert`, { waitUntil: 'domcontentloaded' });
      await directPage.waitForFunction(() => window.__xinsert, { timeout: 60000, polling: 100 });
      direct = await directPage.evaluate(() => window.__xinsert);
    } finally {
      await directBrowser.close();
    }
    const fresh = await openProxiedPage(`${targetBase}/xinsert`);
    let proxied;
    try {
      await fresh.waitForFunction(() => window.__xinsert, { timeout: 120000, polling: 100 });
      proxied = await fresh.evaluate(() => window.__xinsert);
    } finally {
      await fresh.close();
    }
    fs.writeFileSync(path.join(artifacts, 'insertion-doors.json'), JSON.stringify({ direct, proxied }, null, 2));
    assert.ok(!direct.__fatal, `native reference died: ${direct.__fatal}`);
    assert.ok(!proxied.__fatal, `proxied fixture died: ${proxied.__fatal}`);
    // The reference itself: every door runs the script, in the page's own URL.
    assert.ok(Object.keys(direct).length >= 19, `the fixture lost doors: ${Object.keys(direct)}`);
    for (const [door, where] of Object.entries(direct)) assert.equal(where, 'virtual', `${door}: the native reference changed`);
    assert.deepEqual(proxied, direct);
  });

  // A synchronous XHR cannot wait for the acknowledgement of a cookie write: it carries the writes the
  // worker has not confirmed, and the worker applies them before it sends.
  await t.test('a cookie written just before a synchronous XHR goes out with it (matches native)', async () => {
    const targetBase = `http://${targetHost}:${targetPort}`;
    const directBrowser = await puppeteer.launch({ headless: true, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let direct;
    try {
      const directPage = await directBrowser.newPage();
      await directPage.goto(`${targetBase}/xsyncck`, { waitUntil: 'domcontentloaded' });
      await directPage.waitForFunction(() => window.__xsyncck, { timeout: 60000, polling: 100 });
      direct = await directPage.evaluate(() => window.__xsyncck);
    } finally {
      await directBrowser.close();
    }
    const fresh = await openProxiedPage(`${targetBase}/xsyncck`);
    let proxied;
    try {
      await fresh.waitForFunction(() => window.__xsyncck, { timeout: 120000, polling: 100 });
      proxied = await fresh.evaluate(() => window.__xsyncck);
    } finally {
      await fresh.close();
    }
    fs.writeFileSync(path.join(artifacts, 'sync-xhr-cookies.json'), JSON.stringify({ direct, proxied }, null, 2));
    // The reference itself: natively the jar is synchronous and every request carries what was just written.
    assert.deepEqual(direct, { rounds: 30, uniqueMissed: [], sharedWrong: [], heldSent: true, heldAfter: 'sheld=1/sheld=1' });
    assert.deepEqual(proxied, direct);
  });

  // What an opaque document's requests carry and keep. The service worker attached the whole jar to
  // everything it forwarded and kept whatever came back.
  await t.test('a sandboxed frame sends and keeps only the cookies a cross-site context may (matches native)', async () => {
    const targetBase = `http://${targetHost}:${targetPort}`;
    const directBrowser = await puppeteer.launch({ headless: true, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let direct;
    try {
      const directPage = await directBrowser.newPage();
      await directPage.goto(`${targetBase}/xopck`, { waitUntil: 'domcontentloaded' });
      await directPage.waitForFunction(() => window.__xopck, { timeout: 90000, polling: 100 });
      direct = await directPage.evaluate(() => window.__xopck);
    } finally {
      await directBrowser.close();
    }
    const fresh = await openProxiedPage(`${targetBase}/xopck`);
    let proxied;
    try {
      await fresh.waitForFunction(() => window.__xopck, { timeout: 120000, polling: 100 });
      proxied = await fresh.evaluate(() => window.__xopck);
    } finally {
      await fresh.close();
    }
    fs.writeFileSync(path.join(artifacts, 'opaque-cookies.json'), JSON.stringify({ direct, proxied }, null, 2));
    assert.ok(!direct.__fatal, `native reference died: ${direct.__fatal}`);
    assert.ok(!proxied.__fatal, `proxied fixture died: ${proxied.__fatal}`);
    // The reference itself: the page sees every cookie; the opaque documents' requests carry fewer.
    assert.equal(direct.jarHere.split(',').includes('ss_lax'), true, 'the embedding page sends its Lax cookie');
    for (const k of ['img', 'css', 'script', 'last', 'fetch-default']) {
      assert.equal(direct[k].split(',').includes('ss_lax'), false, `${k}: a cross-site request carries no Lax cookie`);
      assert.equal(direct[k].split(',').includes('ss_strict'), false, `${k}: ... nor a Strict one`);
      assert.equal(direct[k].split(',').includes('ss_def'), false, `${k}: ... nor one with no SameSite`);
    }
    assert.equal(direct.jarAfter.split(',').includes('op_lax'), false, 'a cross-site response may not set a Lax cookie');
    assert.deepEqual(proxied, direct);
  });

  // A popup of a sandboxed frame keeps the frame's sandbox — and its opaque origin — unless the page allowed
  // popups to escape it. The browser applies the flags to the popup itself; the origin is the emulated part.
  await t.test('a popup of a sandboxed frame is as opaque as the frame (matches native)', async () => {
    const targetBase = `http://${targetHost}:${targetPort}`;
    const directBrowser = await puppeteer.launch({ headless: true, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let direct;
    try {
      const directPage = await directBrowser.newPage();
      await directPage.goto(`${targetBase}/xpopop`, { waitUntil: 'domcontentloaded' });
      await directPage.waitForFunction(() => window.__xpopop, { timeout: 120000, polling: 100 });
      direct = await directPage.evaluate(() => window.__xpopop);
    } finally {
      await directBrowser.close();
    }
    const fresh = await openProxiedPage(`${targetBase}/xpopop`);
    let proxied;
    try {
      await fresh.waitForFunction(() => window.__xpopop, { timeout: 180000, polling: 100 });
      proxied = await fresh.evaluate(() => window.__xpopop);
    } finally {
      await fresh.close();
    }
    fs.writeFileSync(path.join(artifacts, 'opaque-popups.json'), JSON.stringify({ direct, proxied }, null, 2));
    assert.ok(!direct.__fatal, `native reference died: ${direct.__fatal}`);
    assert.ok(!proxied.__fatal, `proxied fixture died: ${proxied.__fatal}`);
    // The reference itself.
    const opaque = direct['opaque popup'].report;
    assert.equal(opaque['self.origin'], 'null', 'the popup is as opaque as the frame that opened it');
    assert.equal(opaque.localStorage, 'threw:SecurityError');
    assert.equal(opaque['document.cookie'], 'threw:SecurityError');
    assert.equal(opaque['opener.document'], 'threw:SecurityError');
    assert.notEqual(direct['escaping popup'].report['self.origin'], 'null', 'an escaping popup has the site\'s origin');
    assert.equal(direct['escaping popup'].report.localStorage, '1');
    assert.equal(direct['no popups'].handle.opened, 'no', 'no allow-popups: no popup');
    assert.deepEqual(proxied, direct);
  });

  // A cross-origin fetch()/XHR the target did not allow cannot be read, and an "unsafe" one is asked about
  // first (an OPTIONS preflight) — the request itself goes out only if that answer allows it. The proxy sends
  // the page's requests itself, so these are its rules to apply; they used to be skipped, and a cross-origin
  // read the target never allowed succeeded.
  await t.test('cross-origin fetch and XHR obey CORS: who may read, when the browser asks first, redirects (matches native)', async () => {
    const targetBase = `http://${targetHost}:${targetPort}`;
    const directBrowser = await puppeteer.launch({ headless: true, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let direct;
    try {
      const directPage = await directBrowser.newPage();
      await directPage.goto(`${targetBase}/xcors`, { waitUntil: 'domcontentloaded' });
      await directPage.waitForFunction(() => window.__xcors, { timeout: 120000, polling: 100 });
      direct = await directPage.evaluate(() => window.__xcors);
    } finally {
      await directBrowser.close();
    }
    const fresh = await openProxiedPage(`${targetBase}/xcors`);
    let proxied;
    try {
      await fresh.waitForFunction(() => window.__xcors, { timeout: 180000, polling: 100 });
      proxied = await fresh.evaluate(() => window.__xcors);
    } finally {
      await fresh.close();
    }
    fs.writeFileSync(path.join(artifacts, 'cors.json'), JSON.stringify({ direct, proxied }, null, 2));
    assert.ok(!direct.__fatal, `native reference died: ${direct.__fatal}`);
    assert.ok(!proxied.__fatal, `proxied fixture died: ${proxied.__fatal}`);
    // The reference itself: the cases mean what their names say.
    assert.equal(direct['acao-origin'].type, 'cors');
    assert.match(String(direct['acao-missing']), /^threw:TypeError/);
    assert.match(String(direct['star-creds-acac']), /^threw:TypeError/);
    assert.deepEqual(direct['expose-listed'].hdr, ['cache-control', 'content-type', 'x-other', 'x-secret']);
    assert.match(String(direct['pf-put-no-acam']), /^threw:TypeError/);
    assert.deepEqual(direct.__log['pf-put-no-acam'].map(e => e.m), ['OPTIONS'], 'a failed preflight means the request is never sent');
    assert.deepEqual(direct.__log['pf-put-ok'].map(e => e.m), ['OPTIONS', 'PUT']);
    assert.deepEqual(direct.__log['pf-maxage'].map(e => e.m), ['OPTIONS', 'PUT', 'PUT'], 'a preflight answer is reused for its Max-Age');
    assert.equal(direct['same-put'].type, 'basic');
    assert.deepEqual(direct.__log['same-put'].map(e => e.m), ['PUT'], 'no preflight inside the document\'s own origin');
    assert.equal(direct['no-cors-get'].type, 'opaque');
    assert.equal(direct.__log['redir-self-star:b'][0].origin, 'null', 'after a trip through another origin the request\'s origin is null');
    assert.match(String(direct['redir-self-origin']), /^threw:TypeError/);
    assert.match(String(direct['redir-userinfo']), /^threw:TypeError/);
    assert.equal(direct['sx-fail'].threw, 'NetworkError');
    assert.equal(direct.__log['cookie-include'][0].cookies, 'xc');
    assert.equal(direct.__log['cookie-default'][0].cookies, '');
    assert.deepEqual(proxied, direct);
  });

  // While the worker cannot answer a frame itself, its parent fetches the frame's images and swaps them in; until
  // then an image holds a placeholder. The placeholder was left in place on the live element when the markup had come
  // through an inert parser copy first, and — being a stretched 1x1 semi-transparent red pixel — showed as a red block
  // where Naver's ad images belong.
  await t.test('images in frames and in markup end up as the real image, not the placeholder (matches native)', async () => {
    const targetBase = `http://${targetHost}:${targetPort}`;
    const directBrowser = await puppeteer.launch({ headless: true, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let direct;
    try {
      const directPage = await directBrowser.newPage();
      await directPage.goto(`${targetBase}/xph`, { waitUntil: 'domcontentloaded' });
      await directPage.waitForFunction(() => window.__xph, { timeout: 60000, polling: 100 });
      direct = await directPage.evaluate(() => window.__xph);
    } finally {
      await directBrowser.close();
    }
    const fresh = await openProxiedPage(`${targetBase}/xph`);
    let proxied;
    try {
      await fresh.waitForFunction(() => window.__xph, { timeout: 120000, polling: 100 });
      proxied = await fresh.evaluate(() => window.__xph);
    } finally {
      await fresh.close();
    }
    fs.writeFileSync(path.join(artifacts, 'placeholders.json'), JSON.stringify({ direct, proxied }, null, 2));
    assert.ok(!direct.__fatal, `native reference died: ${direct.__fatal}`);
    assert.ok(!proxied.__fatal, `proxied fixture died: ${proxied.__fatal}`);
    assert.deepEqual(direct, { written: '8x8', srcdoc: '8x8', top: '8x8', nested: '8x8' });
    assert.deepEqual(proxied, direct);
  });

  // A member operation on a null or undefined receiver throws what the engine throws — the rewritten ones too. The
  // membrane's helpers used to turn the receiver into an empty object, so `w.location.href` with `w === null` (a
  // blocked `open()`) quietly answered undefined and a page that catches the TypeError took another branch.
  await t.test('member operations on null and undefined throw as natively', async () => {
    const targetBase = `http://${targetHost}:${targetPort}`;
    const directBrowser = await puppeteer.launch({ headless: true, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let direct;
    try {
      const directPage = await directBrowser.newPage();
      await directPage.goto(`${targetBase}/xnullish`, { waitUntil: 'domcontentloaded' });
      await directPage.waitForFunction(() => window.__xnullish, { timeout: 60000, polling: 100 });
      direct = await directPage.evaluate(() => window.__xnullish);
    } finally {
      await directBrowser.close();
    }
    const fresh = await openProxiedPage(`${targetBase}/xnullish`);
    let proxied;
    try {
      await fresh.waitForFunction(() => window.__xnullish, { timeout: 120000, polling: 100 });
      proxied = await fresh.evaluate(() => window.__xnullish);
    } finally {
      await fresh.close();
    }
    fs.writeFileSync(path.join(artifacts, 'nullish.json'), JSON.stringify({ direct, proxied }, null, 2));
    // The reference: what the engine says, and that an uncaught one names the page, not a proxy file.
    assert.equal(direct.out['null / get location'], "TypeError: Cannot read properties of null (reading 'location') | true");
    assert.equal(direct.out['undefined / set href'], "TypeError: Cannot set properties of undefined (setting 'href') | true");
    assert.equal(direct.out['null / optional get'], 'ok:undefined');
    assert.equal(direct.out['object / get location'], 'ok:undefined');
    assert.equal(direct.uncaught.length, 2);
    assert.deepEqual(direct.uncaught.map(u => u[1]), ['page', 'page']);
    assert.deepEqual(proxied, direct);
  });

  // A frame whose sandbox forbids scripts still asks for the scripts in its document (the browser's preload
  // scanner does) — unless the document carries a CSP <meta>, which makes Chrome skip them (measured). The proxy
  // used to put one beside the CSP header, so these frames requested nothing for their <script src>.
  await t.test('a script in a frame that may not run scripts is requested as natively', async () => {
    const targetBase = `http://${targetHost}:${targetPort}`;
    const readSeen = run => new Promise((resolve, reject) => http.get(`${targetBase}/xscr-seen?run=${run}`, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve(JSON.parse(b))); }).on('error', reject));
    const directBrowser = await puppeteer.launch({ headless: true, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let direct;
    try {
      const directPage = await directBrowser.newPage();
      await directPage.goto(`${targetBase}/xscr?run=native`, { waitUntil: 'load' });
      await new Promise(r => setTimeout(r, 4000));
      direct = await readSeen('native');
    } finally {
      await directBrowser.close();
    }
    const fresh = await openProxiedPage(`${targetBase}/xscr?run=proxied`);
    let proxied;
    try {
      await new Promise(r => setTimeout(r, 8000));
      proxied = await readSeen('proxied');
    } finally {
      await fresh.close();
    }
    fs.writeFileSync(path.join(artifacts, 'scriptless-frames.json'), JSON.stringify({ direct, proxied }, null, 2));
    // The reference: every frame asks for its script and its image, scriptless or not.
    for (const tag of ['m-empty', 'm-same', 'm-forms', 'm-scripts', 'm-scripts-same', 'm-none', 'd-empty', 'd-same', 'd-scripts', 'h-empty']) {
      assert.ok(direct.includes(`${tag}-script`), `native fetches the script of ${tag}`);
      assert.ok(direct.includes(`${tag}-img`), `native fetches the image of ${tag}`);
    }
    assert.deepEqual(proxied, direct);
  });

  // CORS is not only for fetch(): an element that asks for it — `crossorigin` on <img>, <script> and <link>, a
  // module script, a font from FontFace or @font-face — is held to the target's answer the same way, and the
  // credentials it asks for decide whether cookies go along. The browser never sees the target's headers (the
  // worker answers it), so the worker has to apply the rules.
  await t.test('crossorigin elements, modules and fonts obey CORS as natively', async () => {
    const targetBase = `http://${targetHost}:${targetPort}`;
    const directBrowser = await puppeteer.launch({ headless: true, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let direct;
    try {
      const directPage = await directBrowser.newPage();
      await directPage.goto(`${targetBase}/xcorsel`, { waitUntil: 'domcontentloaded' });
      await directPage.waitForFunction(() => window.__xcorsel, { timeout: 180000, polling: 100 });
      direct = await directPage.evaluate(() => window.__xcorsel);
    } finally {
      await directBrowser.close();
    }
    const fresh = await openProxiedPage(`${targetBase}/xcorsel`);
    let proxied;
    try {
      await fresh.waitForFunction(() => window.__xcorsel, { timeout: 240000, polling: 100 });
      proxied = await fresh.evaluate(() => window.__xcorsel);
    } finally {
      await fresh.close();
    }
    fs.writeFileSync(path.join(artifacts, 'cors-elements.json'), JSON.stringify({ direct, proxied }, null, 2));
    assert.ok(!direct.__fatal, `native reference died: ${direct.__fatal}`);
    assert.ok(!proxied.__fatal, `proxied fixture died: ${proxied.__fatal}`);
    // The reference: the cases mean what their names say.
    assert.equal(direct['i-anon-acao'], 'load');
    assert.equal(direct['i-anon-missing'], 'error');
    assert.equal(direct['i-plain-missing'], 'load', 'an image without crossorigin needs no permission');
    assert.equal(direct['i-creds-star'], 'error', '* does not do for use-credentials');
    assert.equal(direct['s-anon-missing'], 'error');
    assert.equal(direct['s-plain-missing'], 'load+ran');
    assert.equal(direct['m-missing'], 'error');
    assert.equal(direct['m-acao'], 'load+ran');
    assert.equal(direct['c-anon-missing'], 'error');
    assert.equal(direct['f-acao'], 'loaded');
    assert.equal(direct['f-missing'], 'err:NetworkError');
    assert.equal(direct['fc-missing'].slice(0, 3), 'err');
    assert.equal(direct.opaque['o-origin'], 'error', 'an opaque document is not the origin the target names');
    assert.equal(direct.opaque['o-star'], 'load');
    assert.equal(direct.__log['i-anon-cookie'][0].cookies, '', 'anonymous: no cookies across origins');
    assert.equal(direct.__log['i-creds-ok'][0].cookies, 'xce');
    assert.equal(direct.__log['i-plain-cookie'][0].cookies, 'xce', 'no-cors element loads carry cookies');
    assert.equal(direct.__log['i-redir-self-star:b'][0].origin, 'null');
    assert.equal(direct['i-redir-self-origin'], 'error');
    assert.deepEqual(proxied, direct);
  });

  // Sandboxed frames without allow-same-origin have an opaque origin. Every proxied site shares one
  // physical origin, so the browser cannot give such a frame one for free: the proxy keeps the real
  // sandbox flags, adds the one that lets it serve the frame, and the membrane emulates the opacity.
  // This used to delete the frame at insertion (it could not be contained); when kept, its document
  // got a 403 and its prelude died at localStorage.
  await t.test('sandboxed frames are opaque to the page and to each other, as natively', async () => {
    const targetBase = `http://${targetHost}:${targetPort}`;
    const directBrowser = await puppeteer.launch({ headless: true, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let direct;
    try {
      const directPage = await directBrowser.newPage();
      await directPage.goto(`${targetBase}/xsandbox`, { waitUntil: 'domcontentloaded' });
      await directPage.waitForFunction(() => window.__xsandbox, { timeout: 180000, polling: 100 });
      direct = await directPage.evaluate(() => window.__xsandbox);
    } finally {
      await directBrowser.close();
    }
    const wireBefore = wireRequests.length;
    const fresh = await openProxiedPage(`${targetBase}/xsandbox`);
    let proxied;
    try {
      await fresh.waitForFunction(() => window.__xsandbox, { timeout: 240000, polling: 100 });
      proxied = await fresh.evaluate(() => window.__xsandbox);
    } finally {
      await fresh.close();
    }
    fs.writeFileSync(path.join(artifacts, 'sandboxed-frames.json'), JSON.stringify({ direct, proxied }, null, 2));
    assert.ok(!direct.__fatal, `native reference died: ${direct.__fatal}`);
    assert.ok(!proxied.__fatal, `proxied fixture died: ${proxied.__fatal}`);
    // The reference itself: what the comparison stands on.
    const attr = direct['attr.report'];
    assert.match(attr, /^origin=null\n/, 'a sandboxed document speaks as "null"');
    for (const line of ['self.origin=null', 'localStorage=threw:SecurityError', 'sessionStorage=threw:SecurityError', 'document.cookie=threw:SecurityError',
      'indexedDB.open=threw:SecurityError', 'caches=threw:SecurityError', 'parent.document=threw:SecurityError', 'top.location.href=threw:SecurityError',
      'top.location.assign=threw:SecurityError', 'frameElement=null', 'typeof frameElement=object', 'window.open=null', 'opener=null',
      'egress.img=load', 'egress.ws=open']) {
      assert.ok(attr.split('\n').includes(line), `native reference lost "${line}": ${attr}`);
    }
    for (const k of ['attr', 'property', 'tokens', 'src first', 'parsed', 'insertAdjacentHTML', 'srcdoc', 'parsed srcdoc', 'forms and popups']) {
      assert.equal(direct[k + '.connected'], 'true', `${k}: the frame survives`);
      assert.equal(direct[k + '.contentDocument'], 'null', `${k}: the embedder cannot read it`);
      assert.match(direct[k + '.report'], /^origin=null\n/, `${k}: it ran and reported`);
    }
    assert.equal(direct['inert.report'], 'no report', 'a sandbox without allow-scripts runs nothing');
    assert.equal(direct['attr.sandbox'], 'allow-scripts|allow-scripts|1|false|true', 'the page\'s own sandbox value');
    assert.equal(direct['attr.contentWindow.document'], 'threw:SecurityError');
    assert.match(direct['nav.scripts'], /top\.location\.href==threw:SecurityError/);
    assert.equal(direct['nav.pathAfter'], '/xsandbox', 'the sandbox refused to navigate the top window');
    // Every route a script has, tried from inside the sandbox, reached the upstream the way the page's own
    // requests do — by the proxy, as the target's user agent — and nothing went anywhere else (the
    // suite's last test checks every request the browser made).
    assert.ok(wireRequests.slice(wireBefore).some(u => u.startsWith(proxyOrigin + '/')), 'no proxy-origin wire request observed');
    for (const where of ['/xsb-egress-fetch', '/xsb-egress-xhr', '/xsb-egress-script.js', '/xsb-egress-style.css', '/xsb-egress-module.js', '/xsb-beacon']) {
      assert.ok(requests.some(r => r.url === where && r.userAgent === TARGET_UA), `${where}: not seen through the proxy: ${JSON.stringify(requests.filter(r => r.url === where))}`);
    }
    assert.ok(requests.some(r => r.url.startsWith('/image-probe.png?sb=') && r.userAgent === TARGET_UA), 'the image load did not go through the proxy');
    assert.ok(requests.some(r => r.upgrade && r.url === '/ws?sb=1' && r.userAgent === TARGET_UA), 'the WebSocket did not go through the proxy');
    assert.deepEqual(proxied, direct);
  });

  // Frame load events and joint history against native (the /frame-loads fixture).
  await t.test('frame load events and history match native', async () => {
    const targetBase = `http://${targetHost}:${targetPort}`;
    const directBrowser = await puppeteer.launch({ headless: true, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let direct;
    try {
      const directPage = await directBrowser.newPage();
      await directPage.goto(`${targetBase}/frame-loads`, { waitUntil: 'domcontentloaded' });
      await directPage.waitForFunction(() => window.__frameLoads, { timeout: 30000, polling: 100 });
      direct = await directPage.evaluate(() => window.__frameLoads);
    } finally {
      await directBrowser.close();
    }
    await page.evaluate(u => { __zp_get(globalThis, 'location').href = u; }, `${targetBase}/frame-loads`);
    await page.waitForFunction(() => window.__frameLoads, { timeout: 45000, polling: 100 });
    const proxied = await page.evaluate(() => window.__frameLoads);
    fs.writeFileSync(path.join(artifacts, 'frame-loads.json'), JSON.stringify({ direct, proxied }, null, 2));
    assert.ok(!direct.__fatal, `native reference died: ${direct.__fatal}`);
    assert.ok(!proxied.__fatal, `proxied fixture died: ${proxied.__fatal}`);
    // The reference itself: one load per navigation, one history entry per change.
    assert.deepEqual(direct, {
      staticOnload: '1', staticListener: '1',
      srcBeforeAppend: 'Lo', srcAfterAppend: 'LoLo', rapidSwap: 'LoLo|fh',
      srcChange: 'LoLo', historyDelta: '1',
    }, 'the native reference changed — re-measure before trusting the comparison');
    assert.deepEqual(proxied, direct);
  });

  // T1: 미검증 표면 실측 (`/surface-probes` fixture, window.__surfaceProbes).
  // 첫 실행으로 실측값을 보고 divergence/누출을 핀한다.
  await t.test('surface suite', async t => {
    await page.evaluate(u => { __zp_get(globalThis, 'location').href = u; }, `http://${targetHost}:${targetPort}/surface-probes`);
    try {
      await page.waitForFunction(() => window.__surfaceProbes && window.__surfaceProbes.done && window.__surfaceProbes.moduleDone, { timeout: 60000 });
    } catch (e) {
      console.log('surface probes wait failed');
      throw e;
    }
    const probes = await page.evaluate(() => window.__surfaceProbes);
    const errs = await page.evaluate(() => window.__surfaceErrs);
    fs.writeFileSync(path.join(artifacts, 'surface-probes.json'), JSON.stringify({ probes, errs }, null, 2));
    assert.ok(!probes.__fatal, `surface fixture died: ${probes.__fatal}`);
    // The same fixture in plain Chrome. Every divergence below is deliberate
    // (fail-closed by design) or a documented ERRATA residual, each with its
    // reason; any other difference is a regression. Pins further down were
    // once written from proxy-only runs — five of them encoded divergences.
    await t.test('surface probes match native Chrome except documented divergences', async () => {
      // The native reference occasionally stalls (this fixture drives mailto:,
      // WebAuthn and protocol-handler UIs that headless Chrome may sit on). It
      // is the REFERENCE, not the system under test, so bound each attempt
      // (hard kill) and retry once with a fresh browser — never the proxy side.
      const collectNative = async () => {
        const directBrowser = await puppeteer.launch({ headless: true, protocolTimeout: 20000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const killer = setTimeout(() => { try { directBrowser.process().kill('SIGKILL'); } catch {} }, 40000);
        try {
          const dp = await directBrowser.newPage();
          // Native alert/confirm/prompt block the page; dismissing them yields
          // exactly the stubs' values (undefined / false / null).
          dp.on('dialog', d => { d.dismiss().catch(() => {}); });
          // ★The fixture calls navigator.credentials.create({publicKey}). Natively
          // on Windows that goes to the OS (Windows Security / passkey dialog,
          // CredentialUIBroker.exe) — a system modal on the developer's desktop
          // that a headless browser can never dismiss, and the stall behind the
          // intermittent 140 s reference runs (2026-09-29). A CDP virtual
          // authenticator keeps WebAuthn inside the browser. The proxied side
          // never reaches native WebAuthn (the facade fails closed).
          const cdp = await dp.target().createCDPSession();
          await cdp.send('WebAuthn.enable', { enableUI: false });
          await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
          await dp.goto(`http://${targetHost}:${targetPort}/surface-probes`, { waitUntil: 'domcontentloaded', timeout: 15000 });
          // Default `raf` polling starved in the background headless page (140 s).
          await dp.waitForFunction(() => window.__surfaceProbes && window.__surfaceProbes.done && window.__surfaceProbes.moduleDone, { timeout: 30000, polling: 100 });
          return await dp.evaluate(() => window.__surfaceProbes);
        } finally {
          clearTimeout(killer);
          await directBrowser.close().catch(() => {});
        }
      };
      let direct;
      try { direct = await collectNative(); } catch (e) {
        console.log('native surface reference retried after:', e && e.message);
        direct = await collectNative();
      }
      fs.writeFileSync(path.join(artifacts, 'surface-differential.json'), JSON.stringify({ direct, proxied: probes }, null, 2));
      const expected = {
        // Fail-closed by design (PHASE2_STATUS divergence table, ERRATA Q7).
        webAuthn: 'credentials.create → NotAllowedError: the RP would be the proxy origin',
        credGet: 'credentials.get → NotAllowedError, same reason',
        webkitFS: 'legacy FS/quota removed: a proxy-origin filesystem shared across targets',
        paSurfaces: 'Privacy Sandbox APIs removed: keyed to the proxy origin',
        swRegs: 'the virtual SW facade always reports one fake registration (D3 fail-soft)',
        dynamicBase: "base-uri 'none': a runtime <base> does not move the virtual base",
        // Documented residuals (ERRATA).
        framesByName: 'a srcdoc child reports the parent virtual URL, not about:srcdoc',
        windowByName: 'same as framesByName',
        framesItem: 'V8 names the rewritten callee in "is not a function" messages',
        withEvalScope: 'direct eval inside with() does not see the with-object',
        // Contained blank pages run page code through the membrane, so they
        // report a virtual URL instead of about:blank. Raw — equal to native —
        // they ran unrewritten code at the proxy origin (2026-10-01).
        staleBlankEval: 'a contained about:blank child reports the parent virtual URL, as framesByName',
        pendingRouteEval: 'the blank page in front of a pending route is contained; it reports the destination',
        parseHTMLUnsafeHook: 'a base-less parsed document resolves anchor href against the virtual base',
        ownKeysLeak: 'a var from a script rejected for redeclaration survives (eval instantiation)',
        // Not a divergence: the probe folds in a clock reading.
        realProps: 'includes a clock-derived field',
      };
      assert.deepEqual(Object.keys(probes).sort(), Object.keys(direct).sort(), 'surface probe key sets differ');
      const unexpected = Object.keys(direct).filter(k => probes[k] !== direct[k] && !(k in expected))
        .map(k => `${k}: native=${direct[k]} proxy=${probes[k]}`);
      assert.deepEqual(unexpected, [], unexpected.join('\n'));
      // A documented divergence that stops diverging means the behavior moved —
      // re-audit ERRATA instead of letting the entry rot.
      const healed = Object.keys(expected).filter(k => k !== 'realProps' && probes[k] === direct[k]);
      assert.deepEqual(healed, [], `now match native — update ERRATA and this list: ${healed.join(', ')}`);
    });
    // T1-1: transformer 잔여 — 전부 리라이트/클린
    // Read-back is deproxied like native text; the rewrite itself is proven by
    // importmapBare (the module resolves through the proxy) and the wire check.
    assert.equal(probes.importmapText, 'v:raw');
    assert.equal(probes.specrulesText, 'v:raw');
    assert.match(probes.shadowDom, /^v:shadow-img:clean/);
    assert.match(probes.svgImage, /^v:clean:/);
    assert.match(probes.svgAnchor, /^v:clean:/);
    assert.match(probes.importmapBare, /^v:1\|http:\/\/localhost/);
    // T1-2: clone/transfer — 네이티브처럼 DataCloneError (전송 불가 = fail-closed)
    for (const k of ['cloneLocation', 'portMsgLocation', 'cloneDocument', 'cloneWindow']) {
      assert.match(probes[k], /DataCloneError/, `${k}: ${probes[k]}`);
    }
    assert.equal(probes.weakRefLocation, 'v:same-proxy');
    // T1-3: 명명/인덱스 프레임 — frames['nf']/window['nf'] 는 contained 자식
    assert.match(probes.framesByName, /^v:clean:/, `framesByName: ${probes.framesByName}`);
    assert.match(probes.windowByName, /^v:clean:/, `windowByName: ${probes.windowByName}`);
    assert.match(probes.selfIndex, /^v:clean/);
    assert.match(probes.thisIndex, /^v:clean/);
    // frames.item 은 네이티브에도 없다 (Chrome: "frames.item is not a function")
    assert.match(probes.framesItem, /^threw:TypeError/);
    // T1-4: 레거시 접근자 — location 재정의는 non-configurable 이라 TypeError (네이티브 parity)
    assert.match(probes.defineGetterLoc, /threw:TypeError/);
    assert.match(probes.defineSetterLoc, /threw:TypeError/);
    assert.equal(probes.lookupGetterLoc, 'v:fn');
    assert.equal(probes.lookupSetterLoc, 'v:fn');
    // T1-5: getOwnPropertyNames(window) — 동작해야 하되 __zp_* 는 숨긴다
    assert.match(probes.ownKeysLeak, /^v:clean:\d+$/, `ownKeysLeak: ${probes.ownKeysLeak}`);
    // T1-6: the browser never pings on its own (the attribute is stashed and
    // E1 fires it through the proxy), yet every read surface answers like
    // native: getAttribute/prop show the value, the data-zp marker stays hidden.
    assert.equal(probes.anchorPing, 'v:attr:https://evil.example/track|marker:none|prop:https://evil.example/track');
    // import.meta.resolve 는 가상 타깃 URL 기준 해석
    assert.match(probes.importMetaResolve, /^v:http:\/\/localhost:\d+\/x$/, `importMetaResolve: ${probes.importMetaResolve}`);
    // T1-7: document.write 두 번째 문서 — 스크립트가 가상 location 아래 실행
    assert.match(probes.docWriteFrame, /^v:clean:/);
    // T1-8: iframe 잔여
    assert.match(probes.iframeCspAttr, /^v:attr:/);
    assert.equal(probes.iframeCredentialless, 'v:set');
    for (const k of ['targetFramename', 'baseTargetFrame']) {
      assert.match(probes[k], /^v:navigated:http:\/\/localhost:\d+\/frame-dest\|not found$/, `${k}: ${probes[k]}`);
    }
    // target is read back as written (it used to come back '_self').
    assert.match(probes.targetFramenameAttr, /^v:navigated:http:\/\/localhost:\d+\/frame-dest\|not found\|tfn2\|tfn2$/, `targetFramenameAttr: ${probes.targetFramenameAttr}`);
    assert.equal(probes.targetAttrReadback, 'v:_blank|_blank|_top|x');
    assert.match(probes.parentTargetLink, /^v:navigated:http:\/\/localhost:\d+\/frame-plain\|plain$/, `parentTargetLink: ${probes.parentTargetLink}`);
    assert.match(probes.formTargetGet, /^v:navigated:http:\/\/localhost:\d+\/frame-plain\?q=one\+two\|plain$/, `formTargetGet: ${probes.formTargetGet}`);
    assert.match(probes.formTargetPost, /^v:navigated:http:\/\/localhost:\d+\/post-echo\|a=b\+c$/, `formTargetPost: ${probes.formTargetPost}`);
    assert.match(probes.popupRouted, /^v:fp\|(http:\/\/localhost:\d+\/frame-plain)\|\1$/, `popupRouted: ${probes.popupRouted}`);
    assert.match(probes.namedOpen, /^v:navigated:http:\/\/localhost:\d+\/frame-dest\|not found\|true$/, `namedOpen: ${probes.namedOpen}`);
    // The child keeps its own membrane: both of its reads and the parent's.
    assert.match(probes.childLocAssign, /^v:(http:\/\/localhost:\d+\/frame-html)\|\1\|\1$/, `childLocAssign: ${probes.childLocAssign}`);
    // Escapes: a routed page with no prelude anchor, a routed frame moved to
    // about:blank, and the blank page in front of a pending route all ran page
    // code raw at the proxy origin. Contained, `location` is virtual.
    assert.match(probes.routedPlainEval, /^v:http:\/\/localhost:\d+\/frame-plain$/, `routedPlainEval: ${probes.routedPlainEval}`);
    assert.match(probes.staleBlankEval, /^v:http:\/\/localhost:\d+\/surface-probes$/, `staleBlankEval: ${probes.staleBlankEval}`);
    assert.match(probes.pendingRouteEval, /^v:http:\/\/localhost:\d+\/frame-plain$/, `pendingRouteEval: ${probes.pendingRouteEval}`);
    assert.match(probes.childSharedWorker, /^v:clean:/, `childSharedWorker: ${probes.childSharedWorker}`);
    // T2-1: with(obj) — own dangerous name 은 obj 우선, document 경유
    // location 은 wrapped identity, document.location= 쓰기는 PutForwards.
    assert.equal(probes.withShadow, 'v:obj-first', `withShadow: ${probes.withShadow}`);
    assert.equal(probes.withDocIdentity, 'v:identity-ok', `withDocIdentity: ${probes.withDocIdentity}`);
    assert.match(probes.withDocWrite, /^v:forwarded/, `withDocWrite: ${probes.withDocWrite}`);
    // eval 은 with 오브젝트를 못 본다 — pinned divergence.
    assert.equal(probes.withEvalScope, 'v:virtual', `withEvalScope: ${probes.withEvalScope}`);
    // T2-2: 스코프 모델 — 선언이 있으면 로컬 우선 (호이스트/TDZ/catch/destructuring)
    assert.equal(probes.scopeHoistVar, 'v:threw:TypeError', `scopeHoistVar: ${probes.scopeHoistVar}`);
    assert.equal(probes.scopeTDZ, 'v:threw:ReferenceError', `scopeTDZ: ${probes.scopeTDZ}`);
    assert.equal(probes.scopeCatch, 'v:bound:42', `scopeCatch: ${probes.scopeCatch}`);
    assert.equal(probes.scopeDestructParam, 'v:bound', `scopeDestructParam: ${probes.scopeDestructParam}`);
    // cross-script: var 지속은 물론 let/const/class 도 공유 전역 렉시컬 환경에 지속 (R1).
    assert.equal(probes.crossScriptVar, 'v:number:8', `crossScriptVar: ${probes.crossScriptVar}`);
    assert.equal(probes.crossScriptLet, 'v:number', `crossScriptLet: ${probes.crossScriptLet}`);
    assert.equal(probes.crossScriptConst, 'v:9', `crossScriptConst: ${probes.crossScriptConst}`);
    assert.equal(probes.crossScriptClass, 'v:function', `crossScriptClass: ${probes.crossScriptClass}`);
    assert.equal(probes.crossScriptLetWrite, 'v:42', `crossScriptLetWrite: ${probes.crossScriptLetWrite}`);
    assert.ok(probes.crossScriptConstWrite && probes.crossScriptConstWrite.startsWith('threw:TypeError'), `crossScriptConstWrite: ${probes.crossScriptConstWrite}`);
    // let 재선언 + var-vs-const 충돌 — 둘 다 SyntaxError 로 죽어야 한다.
    assert.equal(probes.lexRedeclare, 'v:2', `lexRedeclare: ${probes.lexRedeclare} errs=${JSON.stringify(errs.slice(0, 4))}`);
    // R2: direct eval 이 호출자 스코프를 본다 — desc 접근자 + 진짜 direct
    // eval(헬퍼 파라미터 intrinsic)로 네이티브 parity.
    assert.equal(probes.evalCallerScope, 'v:LOCAL', `evalCallerScope: ${probes.evalCallerScope}`);
    assert.equal(probes.evalCallerWrite, 'v:7', `evalCallerWrite: ${probes.evalCallerWrite}`);
    assert.equal(probes.evalCallerVar, 'v:VV', `evalCallerVar: ${probes.evalCallerVar}`);
    assert.equal(probes.evalCallerConst, 'v:TypeError:C', `evalCallerConst: ${probes.evalCallerConst}`);
    assert.equal(probes.evalThis, 'v:obj', `evalThis: ${probes.evalThis}`);
    assert.equal(probes.evalArgs, 'v:3', `evalArgs: ${probes.evalArgs}`);
    assert.equal(probes.evalNonString, 'v:[42,null,true,null]', `evalNonString: ${probes.evalNonString}`);
    assert.equal(probes.evalVirtual, 'v:LOCALLOC', `evalVirtual: ${probes.evalVirtual}`);
    assert.equal(probes.evalVirtualGlobal, `v:${targetHost}`, `evalVirtualGlobal: ${probes.evalVirtualGlobal}`);
    assert.equal(probes.evalIndirectNoScope, 'v:global-only', `evalIndirectNoScope: ${probes.evalIndirectNoScope}`);
    assert.equal(probes.evalOptionalNoScope, 'v:global-only', `evalOptionalNoScope: ${probes.evalOptionalNoScope}`);
    assert.equal(probes.evalShadowed, 'v:shadow:x', `evalShadowed: ${probes.evalShadowed}`);
    // R4: sloppy Annex B — 블록/레이블 함수 선언의 varEnv 바인딩이
    // `typeof` 에 'function' 으로 보여야 한다(구버전은 가상 location
    // object 를 돌려줬다 — strict 식 열화).
    assert.equal(probes.annexBSloppy, 'v:function', `annexBSloppy: ${probes.annexBSloppy}`);
    assert.equal(probes.labeledFnDecl, 'v:function', `labeledFnDecl: ${probes.labeledFnDecl}`);
    // R3: sloppy eval 의 `var` 는 호출자 varEnv 에 호이스트 — 'number'.
    assert.equal(probes.evalVarLocal, 'v:number', `evalVarLocal: ${probes.evalVarLocal}`);
    // T2-4: strict-mode `with` — 네이티브와 동일한 파스 에러 parity.
    assert.equal(probes.strictWith, 'v:SyntaxError', `strictWith: ${probes.strictWith}`);
    // T2-8: CSS 잔여 — StyleSheet.href 는 가상 타깃으로 디프록시, url() 은
    // 쓰기 시 프록시 + 되읽기 시 타깃 (round-trip).
    assert.match(probes.sheetHref, /\/site\.css$/, `sheetHref: ${probes.sheetHref}`);
    assert.ok(!/proxy\.localhost|\/zp\//.test(probes.sheetHref), `sheetHref leaked: ${probes.sheetHref}`);
    assert.ok(/css-leak\.example\/a\.png/.test(probes.insertRuleUrl) && !/\/zp\//.test(probes.insertRuleUrl), `insertRuleUrl: ${probes.insertRuleUrl}`);
    assert.ok(/css-leak\.example\/b\.png/.test(probes.styleAttrUrl) && !/\/zp\//.test(probes.styleAttrUrl), `styleAttrUrl: ${probes.styleAttrUrl}`);
    // CSS url() 이 실제 fetch 를 프록시 경로로 보냈는지 — 직접 egress 금지.
    const cssDirect = wireRequests.filter(u => /^https?:\/\/css-leak\.example/.test(u));
    const cssProxied = wireRequests.filter(u => /css-leak\.example/.test(u) && u.includes('/zp/'));
    assert.equal(cssDirect.length, 0, `CSS direct egress: ${JSON.stringify(cssDirect)}`);
    assert.ok(cssProxied.length >= 1, `CSS url() not proxied: ${JSON.stringify(wireRequests.filter(u => /css-leak/.test(u)))}`);
    // T3-1: sealing — mailto 는 외부 핸들러 경로로 살아남고, 다이얼로그는
    // headless parity 스텁, 동적 base 는 CSP base-uri 'none' 이 차단.
    assert.match(probes.mailtoNav, /^v:(no-throw|e:\w+)/, `mailtoNav: ${probes.mailtoNav}`);
    assert.equal(probes.dialogStubs, 'v:alert:undefined|confirm:false|prompt:null', `dialogStubs: ${probes.dialogStubs}`);
    // WebAuthn — 네이티브로 통과해 RP-ID=proxy 로 생성 거부돼야 한다
    // (loud fail — silent credential 은 없어야 한다).
    assert.match(probes.webAuthn, /^v:(e:\w+|absent|created|pending)/, `webAuthn: ${probes.webAuthn}`);
    assert.ok(/localhost|t\.example/.test(probes.dynamicBase) && !/evil-base/.test(probes.dynamicBase), `dynamicBase: ${probes.dynamicBase}`);
    // T3-2: identity/semantic parity — location identity 는 통일되어야 하고,
    // optional-call/delete 는 네이티브 parity. new eval / anchorLiteral 은
    // divergence 핀.
    assert.equal(probes.locIdentity, 'v:true', `locIdentity: ${probes.locIdentity}`);
    assert.equal(probes.optCallChain, 'v:undefined|undefined', `optCallChain: ${probes.optCallChain}`);
    assert.equal(probes.deleteLoc, 'v:false|false', `deleteLoc: ${probes.deleteLoc}`);
    // `new eval()` — 네이티브는 TypeError(eval 은 생성자가 아님). R5 수정으로
    // parity — new.target 가드가 TypeError 를 던진다.
    assert.equal(probes.newEval, 'v:e:TypeError', `newEval: ${probes.newEval}`);
    // getAttribute('href') — R6 리터럴 stash 로 작성자 원문 parity.
    assert.equal(probes.anchorLiteral, 'v:/rel-x', `anchorLiteral: ${probes.anchorLiteral}`);
    // T4-1: 지문 — String(location)/navigation entry.name 은 가상 URL.
    // withDocWrite 프로브가 앞서 #withfrag 로 fragment nav 를 했으므로
    // fragment suffix 는 허용 — 핵심은 proxy 오리진이 아니라는 것.
    const virtURL = `v:http://${targetHost}:${targetPort}/surface-probes`;
    assert.ok(probes.consoleString === virtURL || probes.consoleString === virtURL + '#withfrag', `consoleString: ${probes.consoleString}`);
    // ── P0: 잔여 표면 가드 ──
    // ShadowRealm — 이 Chrome 은 미탑재(absent). 탑재 브라우저에서는
    // evaluate/importValue 가 fail-closed 여야 한다 — 어느 쪽이든 미리라이트
    // 실행('evaluated:*')이나 직접 egress('imported')는 불허.
    assert.match(probes.shadowRealmEval, /^v:(absent|e:NotSupportedError)|^threw:NotSupportedError/, `shadowRealmEval: ${probes.shadowRealmEval}`);
    assert.match(probes.shadowRealmImport, /^v:(absent|e:|timeout)/, `shadowRealmImport: ${probes.shadowRealmImport}`);
    // navigator.credentials — 저장소 접근은 NotAllowedError (프록시 오리진
    // 공용 저장소 노출 방지). 'got:' 이 나오면 실제 저장소가 읽힌 것.
    assert.equal(probes.credGet, 'v:e:NotAllowedError', `credGet: ${probes.credGet}`);
    // instantiateStreaming(문자열) — 네이티브도 TypeError (Promise<Response>
    // 아님). egress 없음 확인 = parity 핀.
    assert.match(probes.wasmStreamUrl, /^v:(e:TypeError|absent)/, `wasmStreamUrl: ${probes.wasmStreamUrl}`);
    // navigator.locks — 타깃 네임스페이스로 격리되며 정상 동작해야 한다.
    assert.equal(probes.navLocks, 'v:got:held', `navLocks: ${probes.navLocks}`);
    // ── P4–P13: 가상 표면 감사 항목 ──
    // P4: http://localhost 타깃은 네이티브도 potentially-trustworthy → true.
    assert.equal(probes.secureCtx, 'v:true', `secureCtx: ${probes.secureCtx}`);
    // P5: webkitURL 은 ZPURL 별칭 — 가상 베이스로 해석, 프록시 URL 미노출.
    assert.equal(probes.webkitURLAlias, `v:http://${targetHost}:${targetPort}/wk-page`, `webkitURLAlias: ${probes.webkitURLAlias}`);
    // P6: webkitIndexedDB — 이 Chrome 에는 네이티브 부재(not-alias)가 parity,
    // 탑재 브라우저에서는 네임스페이스 파사드 별칭이어야 한다.
    assert.match(probes.webkitIDB, /^v:(alias|not-alias:undefined)$/, `webkitIDB: ${probes.webkitIDB}`);
    // P7: 레거시 FS/quota API — 전부 제거.
    assert.equal(probes.webkitFS, 'v:undefined|undefined|undefined|undefined', `webkitFS: ${probes.webkitFS}`);
    // P9: fetchLater — 프록시 봉투 keepalive 에뮬레이션.
    if (probes.fetchLaterType !== 'v:absent') {
      assert.equal(probes.fetchLaterType, 'v:function', `fetchLaterType: ${probes.fetchLaterType}`);
      assert.match(probes.fetchLaterCall, /^v:activated:(true|false)/, `fetchLaterCall: ${probes.fetchLaterCall}`);
    }
    // P10: OPFS — 타깃 해시 서브디렉터리 (마커/오리진 문자열 미노출).
    assert.match(probes.opfsName, /^v:name:$|^v:absent$/, `opfsName: ${probes.opfsName}`);
    // P11: customElements — 네이티브 레지스트리 그대로. 레지스트리는 Window 마다
    // 있고 문서를 넘지 않으므로(크롬 152 실측) 타깃별 접두어는 격리가 아니었다.
    assert.equal(probes.customEl, 'v:ctor:true|up:true|names:x-probe-el|X-PROBE-EL|qs:true|tag:1', `customEl: ${probes.customEl}`);
    assert.equal(probes.customElUpgrade, 'v:same:true|up:true|target:{"ok":1}|matches:true|w:7px', `customElUpgrade: ${probes.customElUpgrade}`);
    // P12: permissions.query — 프록시 오리진 grant 미노출, 추적 권한은 prompt.
    assert.match(probes.permGeo, /^v:(state:prompt|state:denied|e:\w+|absent)/, `permGeo: ${probes.permGeo}`);
    // P13: Privacy Sandbox — fail-closed. browsingTopics 는 빈 배열 게이트.
    assert.equal(probes.paSurfaces, 'v:undefined|fn:[]|undefined|undefined|undefined|fn-gated', `paSurfaces: ${probes.paSurfaces}`);
    // P8: Sanitizer 경로도 transformHTML 경유 — href 게터는 가상 타깃으로 푼다.
    if (probes.setHTMLHook !== 'v:absent') {
      assert.equal(probes.setHTMLHook, `v:http://${targetHost}:${targetPort}/set-html-probe.png`, `setHTMLHook: ${probes.setHTMLHook}`);
    }
    if (probes.parseHTMLUnsafeHook !== 'v:absent') {
      assert.equal(probes.parseHTMLUnsafeHook, `v:http://${targetHost}:${targetPort}/parse-unsafe.png`, `parseHTMLUnsafeHook: ${probes.parseHTMLUnsafeHook}`);
    }
    if (probes.getHTMLClean !== 'v:absent') {
      assert.match(probes.getHTMLClean, /^v:clean:/, `getHTMLClean: ${probes.getHTMLClean}`);
      assert.ok(!/data-zp-|\/zp\/|proxy\.localhost/.test(probes.getHTMLClean), `getHTML leaked internals: ${probes.getHTMLClean}`);
    }
    // ShadowRealm importValue / wasmStreamUrl 이 직접 egress 를 낳았는지 wire 확인.
    const p0Direct = wireRequests.filter(u => /^https?:\/\/(sr-leak|wasm-leak)\.invalid/.test(u) && !u.includes('/zp/'));
    assert.equal(p0Direct.length, 0, `P0 direct egress: ${JSON.stringify(p0Direct)}`);
    // The navigation entry keeps the LOAD url — a later hash write doesn't move it.
    assert.equal(probes.perfNavEntry, virtURL, `perfNavEntry: ${probes.perfNavEntry}`);
    // getRegistrations 는 프록시 SW 자체를 보여선 안 되고 registerPH 는
    // 프록시 오리진 등록이 거부돼야 한다.
    assert.match(probes.swRegs, /^v:(count:\d+|no-sw)/, `swRegs: ${probes.swRegs}`);
    assert.match(probes.registerPH, /^v:(e:\w+|ok|absent)/, `registerPH: ${probes.registerPH}`);
    // E4: 가상 오리진 URL 등록은 silent-success — 브라우저 UI 에 프록시
    // 오리진을 노출하지 않으면서 네이티브 검증(오리진 동일성)은 지킨다.
    assert.match(probes.registerPHSameOrigin, /^v:(ok|absent)/, `registerPHSameOrigin: ${probes.registerPHSameOrigin}`);
    assert.match(probes.realProps, /^v:(mem|no-mem)\|\d+\|(?:\d+|undefined)\|UTF-8\|/, `realProps: ${probes.realProps}`);
    // 에러/거부 이벤트 인자에 프록시 표식이 없어야 한다
    for (const e of errs) {
      assert.ok(!/__zp_|\/zp\/api|proxy\.localhost|worker-script/.test(e), `error arg leaked: ${e}`);
    }
    assert.ok(errs.some(e => e.startsWith('rej:')), 'unhandledrejection 인자가 관측되지 않았다');
    assert.ok(errs.some(e => e.startsWith('err:')), 'window.onerror 인자가 관측되지 않았다');
    // wire 수준 직접 egress 없음 — ping 도메인으로 나간 요청이 없어야 한다
    const egress = wireRequests.filter(u => /evil\.example/.test(u));
    assert.equal(egress.length, 0, `ping egress: ${JSON.stringify(egress)}`);
  });

  await t.test('error and truncated documents still transform', async () => {
    // 500 에러 문서 — 인라인 스크립트가 리라이트되어 location 이 가상이어야 한다.
    await page.evaluate(u => { __zp_get(globalThis, 'location').href = u; }, `http://${targetHost}:${targetPort}/err-doc`);
    await page.waitForFunction(() => window.__errDoc !== undefined, { timeout: 15000 });
    const errDoc = await page.evaluate(() => window.__errDoc);
    assert.ok(!String(errDoc).includes('proxy.localhost') && !String(errDoc).includes('/zp/'), `err-doc location leaked proxy: ${errDoc}`);
    // 잘린 HTML — 닫힘 없는 문서도 변환 경로를 탄다.
    await page.evaluate(u => { __zp_get(globalThis, 'location').href = u; }, `http://${targetHost}:${targetPort}/trunc-doc`);
    await page.waitForFunction(() => window.__truncDoc !== undefined, { timeout: 15000 });
    const truncDoc = await page.evaluate(() => window.__truncDoc);
    assert.ok(!String(truncDoc).includes('proxy.localhost') && !String(truncDoc).includes('/zp/'), `trunc-doc location leaked proxy: ${truncDoc}`);
    assert.equal(new URL(page.url()).origin, proxyOrigin, `page escaped proxy: ${page.url()}`);
  });

  await t.test('cross-virtual-origin frames cannot read parent Location', async () => {
    const result = await page.evaluate(url => new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      const finish = event => {
        if (!event.data || event.data.type !== 'cross-origin-location') return;
        clearTimeout(timer);
        window.removeEventListener('message', finish);
        frame.remove();
        resolve(event.data);
      };
      const timer = setTimeout(() => {
        window.removeEventListener('message', finish);
        frame.remove();
        reject(new Error('cross-origin Location probe timed out'));
      }, 5000);
      window.addEventListener('message', finish);
      frame.src = url;
      document.body.appendChild(frame);
    }), `http://127.0.0.1:${targetPort}/cross-origin-location-probe`);
    assert.deepEqual(result, { type: 'cross-origin-location', read: 'SecurityError', replace: 'function' });
  });

  await t.test('target-authored srcdoc contains cross-origin top navigation', async () => {
    // This probe intentionally destroys its document. Never share its page or
    // SW/tab state with the rest of E1, and never execute the attack via CDP.
    const context = await browser.createBrowserContext();
    const probePage = await context.newPage();
    try {
      await observeTarget(probePage.target());
      await probePage.goto(proxyOrigin + '/', { waitUntil: 'domcontentloaded' });
      await probePage.waitForFunction(() => navigator.serviceWorker?.controller && document.querySelector('#status')?.textContent === 'Ready.', { timeout: 30000 });
      await probePage.type('#url', `http://${targetHost}:${targetPort}/srcdoc-probe`);
      await probePage.click('button');
      await probePage.waitForFunction(() => window.__srcdocProbe, { timeout: 30000 });
      const initial = await probePage.evaluate(() => window.__srcdocProbe);
      assert.deepEqual(initial, { type: 'srcdoc-ready', href: `http://${targetHost}:${targetPort}/srcdoc-probe`, origin: `http://${targetHost}:${targetPort}` });
      await probePage.click('#navigate');
      await probePage.waitForFunction(() => document.title === 'E2E Next', { timeout: 30000 });
      assert.equal(new URL(probePage.url()).origin, proxyOrigin);
      const virtualHref = await probePage.evaluate(() => window.__nextHref);
      assert.equal(virtualHref, `http://127.0.0.1:${targetPort}/next`);
      assert.ok(requests.some(r => r.url === '/next' && r.host === `127.0.0.1:${targetPort}` && r.userAgent === TARGET_UA));
    } finally {
      try {
        const progress = await probePage.evaluate(() => ({ sent: window.__srcdocSent, progress: window.__srcdocProgress }));
        fs.writeFileSync(path.join(artifacts, 'srcdoc-progress.json'), JSON.stringify(progress, null, 2));
      } catch {}
      await saveArtifacts('srcdoc', probePage);
      await context.close();
    }
  });

  // D3: SW facade is fail-soft — register() resolves to a fake registration
  // so target init code doesn't crash, but the security invariant holds:
  // no real SW controls the origin (controller === null) and the fake
  // registration's .active is null (no actual worker bound). Sync /
  // periodicSync register cleanly (no event ever fires; matches native
  // throttling). Push subscribe rejects NotAllowedError (graceful denial).
  await t.test('service worker and push isolation', async () => {
  const serviceWorkerPolicy = await page.evaluate(async () => {
    const out = {
      exposed: 'serviceWorker' in navigator,
      controller: navigator.serviceWorker && navigator.serviceWorker.controller,
      registrationCount: null,
      registerError: '',
      registeredScope: '',
      registeredActive: 'missing',
      syncRegister: '',
      pushSubscribeError: '',
      pushSubscription: 'missing',
    };
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) out.registrationCount = (await navigator.serviceWorker.getRegistrations()).length;
    try {
      const reg = await navigator.serviceWorker.register('/target-sw.js');
      out.registeredScope = String(reg && reg.scope || '');
      out.registeredActive = reg && reg.active === null ? 'null' : String(reg && reg.active);
      if (reg && reg.sync && reg.sync.register) out.syncRegister = String(await reg.sync.register('zp-test'));
      if (reg && reg.pushManager) {
        try { await reg.pushManager.subscribe({ userVisibleOnly: true }); }
        catch (err) { out.pushSubscribeError = err && err.name || String(err); }
        out.pushSubscription = (await reg.pushManager.getSubscription()) === null ? 'null' : 'leaked';
      }
    } catch (err) { out.registerError = err && err.name || String(err); }
    return out;
  });
  assert.equal(serviceWorkerPolicy.exposed, true);
  // Security invariants: no real SW controls the origin, fake reg's .active is null.
  assert.equal(serviceWorkerPolicy.controller, null);
  assert.equal(serviceWorkerPolicy.registeredActive, 'null', 'fake registration must have null .active (no real SW)');
  // Fail-soft surface: register resolves, scope is virtual origin, sync
  // registers no-op, push subscribe rejects gracefully, getSubscription null.
  assert.equal(serviceWorkerPolicy.registerError, '');
  assert.equal(serviceWorkerPolicy.registrationCount, 1, 'facade getRegistrations should surface the single fake reg');
  assert.match(serviceWorkerPolicy.registeredScope, /^https?:\/\//, 'registration.scope should be the virtual origin');
  assert.equal(serviceWorkerPolicy.pushSubscribeError, 'NotAllowedError', 'PushManager.subscribe must reject NotAllowedError');
  assert.equal(serviceWorkerPolicy.pushSubscription, 'null', 'PushManager.getSubscription must resolve null');
  });
  await t.test('bootstrap secrets stay hidden', async () => {
  const bootLeak = await page.evaluate(() => ({
    bootType: typeof window.__ZP_BOOT,
    scriptContainsRuntimeToken: Array.from(document.scripts).some(s => s.textContent.includes('runtimeToken')),
  }));
  assert.equal(bootLeak.bootType, 'undefined');
  assert.equal(bootLeak.scriptContainsRuntimeToken, false);
  });


  async function submitFormFixture(kind) {
    // Every encoding starts at the same valid target document; a failed
    // navigation must not poison the next encoding's action/base resolution.
    await page.goto(homeProxyURL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.title === 'E2E Home', { timeout: 30000 });
    await page.evaluate(kind => window.__submitFormFixture(kind), kind);
    await page.waitForFunction(k => window.__formEcho && window.__formEcho.kind === k, { timeout: 30000 }, kind);
    return page.evaluate(() => { const loc = __zp_get(globalThis, 'location'); return { echo: window.__formEcho, virtualHref: loc.href, virtualHash: loc.hash, documentURL: __zp_get(document, 'URL'), baseURI: __zp_get(document, 'baseURI') }; });
  }
  await t.test('URL-encoded form submission', async () => {
  const urlencodedForm = await submitFormFixture('urlencoded');
  assert.equal(urlencodedForm.echo.method, 'POST');
  assert.match(urlencodedForm.echo.contentType, /^application\/x-www-form-urlencoded/);
  assert.equal(urlencodedForm.echo.body, 'alpha=one&submitter=urlencoded');
  assert.ok(requests.some(r => r.url.startsWith('/form-echo?kind=urlencoded') && r.contentType.startsWith('application/x-www-form-urlencoded')), `target requests: ${JSON.stringify(requests)}`);
  });
  await t.test('plain-text form submission', async () => {
  const plainForm = await submitFormFixture('plain');
  assert.match(plainForm.echo.contentType, /^text\/plain/);
  assert.equal(plainForm.echo.method, 'POST');
  assert.equal(plainForm.echo.body, 'alpha=one\r\nsubmitter=plain\r\n');
  assert.ok(requests.some(r => r.url.startsWith('/form-echo?kind=plain') && r.contentType.startsWith('text/plain')), `target requests: ${JSON.stringify(requests)}`);
  });
  await t.test('multipart form submission and private navigation metadata', async () => {
  const multipartForm = await submitFormFixture('multipart');
  assert.match(multipartForm.echo.contentType, /^multipart\/form-data; boundary=/);
  assert.equal(multipartForm.echo.method, 'POST');
  assert.match(multipartForm.echo.body, /name="alpha"\r\n\r\none\r\n/);
  assert.match(multipartForm.echo.body, /name="submitter"\r\n\r\nmultipart\r\n/);
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
  assert.ok(requests.some(r => r.url.startsWith('/form-echo?kind=multipart') && r.contentType.startsWith('multipart/form-data')), `target requests: ${JSON.stringify(requests)}`);
  });
  await t.test('link navigation after form submissions', async () => {
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
  await t.test('anchor ping fires through proxy transport', async () => {
  // E1: `<a ping>` 은 브라우저의 직접 POST 를 끊고(data-zp-blocked-ping 스태시)
  // 클릭 시 프록시 transport 로 POST 'PING' 을 발사한다 — upstream 이 봐야 한다.
  await page.evaluate(base => {
    const a = document.createElement('a');
    a.href = base + '/ping-dest';
    a.ping = base + '/ping-track';
    a.textContent = 'go';
    a.id = 'ping-a';
    document.body.appendChild(a);
  }, `http://${targetHost}:${targetPort}`);
  await page.click('#ping-a');
  // ping 은 fire-and-forget — 클릭 직후 네비게이션과 독립적으로 upstream 에 도착.
  const deadline = Date.now() + 10000;
  while (!requests.some(r => r.url === '/ping-track')) {
    if (Date.now() > deadline) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const ping = requests.find(r => r.url === '/ping-track');
  assert.ok(ping, `ping 이 upstream 에 도착하지 않았다: ${JSON.stringify(requests.slice(-8))}`);
  assert.equal(ping.method, 'POST');
  assert.equal(ping.contentType, 'text/ping');
  // 직접 egress 없음 — ping 도 프록시 오리진 wire 만 탄다(최종 단언이 커버).
  });
  });
  await t.test('all browser and worker network stays on the proxy origin', () => {
    assert.deepEqual(wireRequests.filter(url => /^https?:|^wss?:/.test(url) && new URL(url).host !== new URL(proxyOrigin).host), []);
  });
});
