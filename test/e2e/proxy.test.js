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
    if (url.pathname === '/dyn-probes') {
      // O9: dynamic code suite — §E eval/Function/timers/event handlers/DOM
      // insertion paths. Three assertion kinds per case: success (runs through
      // the mediated path), exception (correct error surfaces), source-leak
      // (no __zp_* / /zp/ internals visible to page JS).
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>ZP Dynamic Probes</title><body>
      <button id="staticHandler" onclick="window.__staticHandlerRan = 1"></button>
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
          // D2/D3: 재작성 코드는 import(__zp_module_url(spec,ref)) 로 번역된다 —
          // evaluate 는 미리라이트라 여기서 그 경로를 그대로 흉낸다. 네이티브
          // import('data:…') 자체는 CSP(script-src 에 data: 없음)가 막는다.
          await P('importData', async () => { try { const m = await import(__zp_module_url('data:text/javascript,export%20default%201', location.href)); return 'v:' + (m && m.default); } catch (e) { return 'threw:' + (e && e.name || e); } });
          await P('importBlob', async () => { try { const u = URL.createObjectURL(new Blob(['export default 3'], { type: 'text/javascript' })); const m = await import(__zp_module_url(u, location.href)); return 'v:' + (m && m.default); } catch (e) { return 'threw:' + (e && e.name || e); } });

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
            const ks = Object.getOwnPropertyNames(window);
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
          await P('targetFramename', async () => {
            const f = document.createElement('iframe');
            f.name = 'tfn'; f.srcdoc = '<p>home</p>';
            document.body.appendChild(f);
            const a = document.createElement('a');
            a.href = '/frame-dest'; a.target = 'tfn'; a.textContent = 'go';
            document.body.appendChild(a);
            a.click();
            await new Promise(r => setTimeout(r, 800));
            try {
              const href = f.contentWindow && f.contentWindow.location ? String(f.contentWindow.location.href) : 'none';
              return href.includes('/frame-dest') ? 'navigated:' + href : 'not-navigated:' + href;
            } catch (e) { return 'threw:' + e.name; }
          });
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
      // OPFS — 프록시 오리진 공유 대신 타깃 해시 서브디렉터리.
      assert.match(d.opfsName, /^v:name:zp:o:[0-9a-f]{8}$/, `opfsName: ${d.opfsName}`);
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

    await t.test('eval success and virtual scope', () => {
      assert.equal(probes.evalBasic, 'v:2', `evalBasic: ${probes.evalBasic}`);
      assert.equal(probes.evalLocation, `v:${targetBase}/dyn-probes`, `evalLocation: ${probes.evalLocation}`);
      assert.equal(probes.evalStrict, `v:${targetBase}`, `evalStrict: ${probes.evalStrict}`);
      assert.equal(probes.evalNonString, 'v:[123,null,null]', `evalNonString: ${probes.evalNonString}`);
    });
    await t.test('eval exceptions and edge forms', () => {
      // eval 소스가 파스 불가면 리라이트도 불가 — 네이티브 SyntaxError 대신
      // fail-closed NotSupportedError 가 나오는 것이 설계된 발화다.
      assert.equal(probes.evalSyntaxError, 'threw:NotSupportedError', `evalSyntaxError: ${probes.evalSyntaxError}`);
      assert.equal(probes.evalIndirect, `v:${targetBase}`, `evalIndirect: ${probes.evalIndirect}`);
      assert.equal(probes.evalCall, 'v:5', `evalCall: ${probes.evalCall}`);
      // R5 parity — 네이티브 eval 은 non-constructor, `new eval()` 은 TypeError.
      assert.equal(probes.evalAsCtor, 'threw:TypeError', `evalAsCtor: ${probes.evalAsCtor}`);
      assert.equal(probes.evalTagged, 'v:undefined', `evalTagged: ${probes.evalTagged}`);
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
      // 리라이트 불가 타이머 문자열은 등록 시점에 fail-closed — 비동기 에러
      // 이벤트가 아니라 동기 throw.
      assert.equal(probes.timerBad, 'e:NotSupportedError', `timerBad: ${probes.timerBad}`);
    });
    await t.test('event handlers', () => {
      assert.equal(probes.handlerStatic, 'v:1', `handlerStatic: ${probes.handlerStatic}`);
      assert.equal(probes.handlerPropFn, `v:${targetBase}`, `handlerPropFn: ${probes.handlerPropFn}`);
      // §E 미검증이던 onclick 프로퍼티-문자열 경로 — 실행된다(마커 확인).
      assert.equal(probes.handlerPropString, 'v:9', `handlerPropString: ${probes.handlerPropString}`);
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
    // T1-1: transformer 잔여 — 전부 리라이트/클린
    assert.equal(probes.importmapText, 'v:rewritten');
    assert.equal(probes.specrulesText, 'v:rewritten');
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
    // T1-6: ping 은 속성이 제거되고 요청이 안 나간다. marker 는 data-zp-* 라
    // 페이지 getAttribute 에서 숨겨진다('none' 이 정상). prop 은 저장값을 돌린다.
    assert.match(probes.anchorPing, /^v:attr:null\|marker:none\|prop:/);
    // import.meta.resolve 는 가상 타깃 URL 기준 해석
    assert.match(probes.importMetaResolve, /^v:http:\/\/localhost:\d+\/x$/, `importMetaResolve: ${probes.importMetaResolve}`);
    // T1-7: document.write 두 번째 문서 — 스크립트가 가상 location 아래 실행
    assert.match(probes.docWriteFrame, /^v:clean:/);
    // T1-8: iframe 잔여
    assert.match(probes.iframeCspAttr, /^v:attr:/);
    assert.equal(probes.iframeCredentialless, 'v:set');
    assert.match(probes.targetFramename, /^v:navigated:/, `targetFramename: ${probes.targetFramename}`);
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
    assert.match(probes.opfsName, /^v:name:zp:o:[0-9a-f]{8}$|^v:absent$/, `opfsName: ${probes.opfsName}`);
    // P11: customElements — 프리픽스 레지스트리 + 이름 마스킹 + 쿼리 변환.
    assert.equal(probes.customEl, 'v:ctor:true|up:true|names:x-probe-el|X-PROBE-EL|qs:true|tag:1', `customEl: ${probes.customEl}`);
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
    assert.ok(probes.perfNavEntry === virtURL || probes.perfNavEntry === virtURL + '#withfrag', `perfNavEntry: ${probes.perfNavEntry}`);
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
