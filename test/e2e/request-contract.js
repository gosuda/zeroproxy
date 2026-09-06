const assert = require('node:assert/strict');

// Served by the real upstream, then rewritten as target code. Puppeteer only
// clicks controls and reads their rendered results; it never calls runtime APIs.
function handleRequestContract(req, res, requests) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!url.pathname.startsWith('/compat/')) return false;
  if (url.pathname === '/compat/index') {
    const crossOrigin = `http://127.0.0.1:${url.port}`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'unsafe-url' });
    res.end(`<!doctype html><html><head><title>Request contract</title></head><body>
      <h1>Request contract</h1>
      <button id="methods">Redirect methods and bodies</button><pre id="methods-result"></pre>
      <button id="credentials">Credential isolation</button><pre id="credentials-result"></pre>
      <button id="redirects">Redirect visibility</button><pre id="redirects-result"></pre>
      <button id="history">History context</button><pre id="history-result"></pre>
      <script>
        const crossOrigin = ${JSON.stringify(crossOrigin)};
        async function json(url, init) { const response = await fetch(url, init); return response.json(); }
        function bind(id, run) {
          document.getElementById(id).addEventListener('click', async () => {
            const result = document.getElementById(id + '-result');
            try { result.textContent = JSON.stringify(await run()); }
            catch (error) { result.textContent = JSON.stringify({ error: error.name, message: error.message }); }
          });
        }
        bind('methods', async () => {
          const out = {};
          for (const [name, method, status] of [['put302', 'PUT', 302], ['patch302', 'PATCH', 302], ['post303', 'POST', 303], ['post307', 'POST', 307], ['post308', 'POST', 308]]) {
            out[name] = await json('/compat/redirect?status=' + status + '&case=' + name, {
              method, body: 'payload-' + name + '-π',
              headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Content-Language': 'ko', 'Content-Location': '/payload', 'Content-Encoding': 'identity' }
            });
          }
          const head = await fetch('/compat/redirect?status=303&case=head303', { method: 'HEAD' });
          out.head303 = { status: head.status, body: await head.text() };
          return out;
        });
        bind('credentials', async () => {
          const out = {};
          await json('/compat/echo?set=same_seed', { credentials: 'include' });
          out.same = await json('/compat/echo', { credentials: 'same-origin' });
          out.omit = await json('/compat/echo?set=omit_poison', { credentials: 'omit' });
          out.afterOmit = await json('/compat/echo', { credentials: 'include' });
          await json(crossOrigin + '/compat/echo?set=cross_seed', { credentials: 'include' });
          out.crossInclude = await json(crossOrigin + '/compat/echo', { credentials: 'include' });
          out.crossSame = await json(crossOrigin + '/compat/echo?set=cross_poison', { credentials: 'same-origin' });
          out.crossAfter = await json(crossOrigin + '/compat/echo', { credentials: 'include' });
          return out;
        });
        bind('redirects', async () => {
          const out = {};
          try { await fetch('/compat/redirect?status=302&case=error', { redirect: 'error' }); out.error = 'resolved'; }
          catch (error) { out.error = error.name; }
          const response = await fetch('/compat/redirect?status=302&case=manual', { redirect: 'manual' });
          out.manual = { type: response.type, status: response.status, ok: response.ok, redirected: response.redirected, url: response.url, headers: Array.from(response.headers), body: await response.text() };
          return out;
        });
        bind('history', async () => {
          history.pushState({}, '', '/compat/moved/before?state=one#private-fragment');
          const pending = json('echo?case=history', { referrerPolicy: 'unsafe-url' });
          history.replaceState({}, '', '/compat/moved/after?state=two');
          const first = await pending;
          const second = await json('echo?case=history-after', { referrerPolicy: 'unsafe-url' });
          const hidden = await json('echo?case=no-referrer', { referrerPolicy: 'no-referrer' });
          return { first, second, hidden, href: location.href };
        });
      </script></body></html>`);
    return true;
  }
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const record = { url: req.url, method: req.method, body: Buffer.concat(chunks).toString('utf8'), headers: req.headers };
    requests.push(record);
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Credentials': 'true' };
    if (url.pathname === '/compat/redirect') {
      res.writeHead(Number(url.searchParams.get('status')), { ...headers, Location: '/compat/echo?case=' + url.searchParams.get('case') });
      res.end();
      return;
    }
    const cookie = url.searchParams.get('set');
    if (cookie) headers['Set-Cookie'] = `${cookie}=present; Path=/; SameSite=Lax`;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(record));
  });
  return true;
}

async function runRequestContract(t, page, targetOrigin, requests, wireRequests, proxyOrigin, saveArtifacts) {
  const groups = [
    ['methods', 'Fetch redirect method, entity headers and body replay', result => {
      for (const [name, method] of [['put302', 'PUT'], ['patch302', 'PATCH'], ['post307', 'POST'], ['post308', 'POST']]) {
        assert.equal(result[name].method, method, name);
        assert.equal(result[name].body, `payload-${name}-π`, name);
        assert.equal(result[name].headers['content-type'], 'text/plain;charset=UTF-8', name);
      }
      assert.equal(result.post303.method, 'GET');
      assert.equal(result.post303.body, '');
      for (const name of ['content-type', 'content-language', 'content-location', 'content-encoding']) assert.equal(result.post303.headers[name], undefined, name);
      assert.deepEqual(result.head303, { status: 200, body: '' });
      const head = requests.find(r => r.url === '/compat/echo?case=head303');
      assert.ok(head, 'HEAD redirect must reach the upstream destination');
      assert.equal(head.method, 'HEAD');
      assert.equal(head.body, '');
    }],
    ['credentials', 'Fetch credentials gate cookie sending and receiving by virtual origin', result => {
      assert.match(result.same.headers.cookie, /same_seed=present/);
      assert.equal(result.omit.headers.cookie, undefined);
      assert.match(result.afterOmit.headers.cookie, /same_seed=present/);
      assert.doesNotMatch(result.afterOmit.headers.cookie, /omit_poison/);
      assert.match(result.crossInclude.headers.cookie, /cross_seed=present/);
      assert.equal(result.crossSame.headers.cookie, undefined);
      assert.match(result.crossAfter.headers.cookie, /cross_seed=present/);
      assert.doesNotMatch(result.crossAfter.headers.cookie, /cross_poison|same_seed/);
    }],
    ['redirects', 'Fetch error rejects and manual hides redirect response', result => {
      assert.equal(result.error, 'TypeError');
      assert.deepEqual(result.manual, { type: 'opaqueredirect', status: 0, ok: false, redirected: false, url: targetOrigin + '/compat/redirect?status=302&case=manual', headers: [], body: '' });
      assert.equal(requests.some(r => /^\/compat\/echo\?case=(error|manual)$/.test(r.url)), false, 'error/manual must not follow Location');
    }],
    ['history', 'Fetch freezes the initiating history entry and strips referrer fragments', result => {
      assert.equal(result.first.url, '/compat/moved/echo?case=history');
      assert.equal(result.first.headers.referer, targetOrigin + '/compat/moved/before?state=one');
      assert.equal(result.second.headers.referer, targetOrigin + '/compat/moved/after?state=two');
      assert.equal(result.hidden.headers.referer, undefined);
      assert.equal(result.href, targetOrigin + '/compat/moved/after?state=two');
    }],
  ];
  for (const [id, name, check] of groups) {
    await t.test(name, async () => {
      try {
        await page.waitForSelector('#' + id, { visible: true });
        const box = await page.$eval('#' + id, element => { const r = element.getBoundingClientRect(); return { width: r.width, height: r.height }; });
        assert.ok(box.width > 0 && box.height > 0, 'fixture control must actually render');
        const start = wireRequests.length;
        await page.click('#' + id);
        await page.waitForFunction(key => document.getElementById(key + '-result').textContent !== '', { timeout: 30000 }, id);
        const result = JSON.parse(await page.$eval('#' + id + '-result', element => element.textContent));
        assert.equal(result.error && id !== 'redirects' ? result.error : undefined, undefined, JSON.stringify(result));
        check(result);
        const observed = wireRequests.slice(start);
        assert.ok(observed.some(url => url.startsWith(proxyOrigin + '/zp/api/')), 'target fetch must traverse the proxy runtime endpoint');
        assert.deepEqual(observed.filter(url => /^https?:|^wss?:/.test(url) && new URL(url).host !== new URL(proxyOrigin).host), [], 'no direct browser or service-worker egress');
      } finally {
        await saveArtifacts('request-' + id, page);
      }
    });
  }
}

module.exports = { handleRequestContract, runRequestContract };
