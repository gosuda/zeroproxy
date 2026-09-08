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

function createTargetServer(requests, pendingResponses) {
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
  if (silentClose) socket.once('close', () => requests.push({ url: req.url, socketClosed: true, at: Date.now() }));
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

test('built proxy browser contracts and E1 escape matrix', { timeout: 300000, concurrency: false }, async t => {
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
      if (!['page', 'service_worker', 'shared_worker'].includes(target.type())) return;
      const session = await target.createCDPSession();
      session.on('Network.requestWillBeSent', event => wireRequests.push(event.request.url));
      session.on('Network.webSocketCreated', event => wireRequests.push(event.url));
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
  await t.test('E1 escape matrix and runtime integrations', { timeout: 180000 }, async t => {
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
  assert.deepEqual(home.faviconProbe && {
    rel: home.faviconProbe.rel,
    href: home.faviconProbe.href,
    hrefProp: home.faviconProbe.hrefProp,
    hrefAttrValue: home.faviconProbe.hrefAttrValue,
  }, {
    rel: 'icon',
    href: `http://${targetHost}:${targetPort}/site-icon.png`,
    hrefProp: `http://${targetHost}:${targetPort}/site-icon.png`,
    hrefAttrValue: `http://${targetHost}:${targetPort}/site-icon.png`,
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
  assert.equal(home.imageProbe.src, `http://${targetHost}:${targetPort}/image-probe.png`);
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
        return after === initial ? 'unchanged:' + initial : 'changed:' + after;
      } catch (err) { return 'throw:' + (err && err.message || err); }
    })();

    // D7 document.origin must be the virtual target origin, never proxy.
    out.documentOrigin = (() => {
      try {
        const d = __zp_get(globalThis, 'document');
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
  await t.test('blobWorker', () => { assert.notEqual(escapeMatrix.blobWorker, 'ran'); });
  await t.test('dataWorker', () => { assert.notEqual(escapeMatrix.dataWorker, 'ran'); });
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
  // D7 document.origin reports the virtual target origin.
  await t.test('documentOrigin', () => { assert.match(escapeMatrix.documentOrigin, /^virtual:/, `document.origin leak: ${escapeMatrix.documentOrigin}`); });
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
  });
  await t.test('all browser and worker network stays on the proxy origin', () => {
    assert.deepEqual(wireRequests.filter(url => /^https?:|^wss?:/.test(url) && new URL(url).host !== new URL(proxyOrigin).host), []);
  });
});
