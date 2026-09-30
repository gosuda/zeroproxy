// D4 end to end: a page — and a worker — opens WebTransport to a pinned echo
// target, natively and through the proxy's gateway, and the two must agree.
//
// Until 2026-09-30 the gateway had never carried a byte to a browser: its dial
// lacked the QUIC datagram flag, its bidi bridge dropped replies,
// webtransport-go's default origin check refused the proxy page, the page's
// CSP refused the gateway's origin, and the dev certificate (30 days, a CA)
// could not be pinned. Each of those passed the Go tests, which dial without
// an Origin, a CSP or a browser. This runs the real thing.
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const puppeteer = require('puppeteer');

const freeTCP = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const freeUDP = () => new Promise((resolve, reject) => {
  const s = dgram.createSocket('udp4');
  s.once('error', reject);
  s.bind(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// The probe: connect with the target's pin, echo a bidi stream and a
// datagram, then check that a wrong pin fails the way it fails natively.
function probeSource(echoAddr, hash) {
  return `
    const b64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
    const out = {};
    try {
      const wt = new WebTransport('https://${echoAddr}/echo', { serverCertificateHashes: [{ algorithm: 'sha-256', value: b64('${hash}') }] });
      await wt.ready;
      out.ready = 'ok';
      const s = await wt.createBidirectionalStream();
      const w = s.writable.getWriter(); await w.write(new TextEncoder().encode('ping')); await w.close();
      const r = s.readable.getReader(); let txt = '';
      for (;;) { const { value, done } = await r.read(); if (done) break; txt += new TextDecoder().decode(value); }
      out.bidi = txt;
      const dw = wt.datagrams.writable.getWriter(); await dw.write(new Uint8Array([1, 2, 3]));
      const dr = wt.datagrams.readable.getReader();
      const d = await Promise.race([dr.read(), new Promise(res => setTimeout(() => res({ value: 'timeout' }), 5000))]);
      out.dgram = d.value && d.value.join ? d.value.join(',') : String(d.value);
      wt.close();
    } catch (e) { out.error = (e && e.name) + ':' + String(e && e.message).slice(0, 160); }
    try {
      const bad = new WebTransport('https://${echoAddr}/echo', { serverCertificateHashes: [{ algorithm: 'sha-256', value: new Uint8Array(32) }] });
      await Promise.race([bad.ready, new Promise((_, j) => setTimeout(() => j(new Error('ready timeout')), 10000))]);
      out.badPin = 'connected';
    } catch (e) { out.badPin = 'rejected:' + (e && e.name); }
    return JSON.stringify(out);`;
}

function fixturePage(echoAddr, hash, inWorker) {
  const body = probeSource(echoAddr, hash);
  if (!inWorker) {
    return `<!doctype html><title>wt</title><body><script>(async () => { ${body} })().then(v => { window.__wt = v; });</script></body>`;
  }
  const workerSrc = `(async () => { ${body} })().then(v => postMessage(v));`;
  return `<!doctype html><title>wt</title><body><script>
    const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerSrc)}], { type: 'text/javascript' })));
    w.onmessage = e => { window.__wt = e.data; };
    w.onerror = e => { e.preventDefault(); window.__wt = 'worker error: ' + e.message; };
  </script></body>`;
}

async function waitHTTP(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const ok = await new Promise(resolve => http.get(url, r => { r.resume(); resolve(r.statusCode === 200); }).on('error', () => resolve(false)));
    if (ok) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`${url} did not come up`);
}

test('WebTransport through the D4 gateway matches native (page and worker)', { timeout: 240000, concurrency: false }, async t => {
  const dist = path.resolve(process.env.ZP_E2E_DIST || 'dist');
  const artifacts = path.resolve(process.env.ZP_E2E_ARTIFACTS || 'artifacts/e2e');
  fs.mkdirSync(artifacts, { recursive: true });
  const serverPath = path.join(dist, process.platform === 'win32' ? 'zeroproxy-server.exe' : 'zeroproxy-server');
  assert.ok(fs.existsSync(serverPath), `missing ${serverPath} — build first`);

  // Node cannot serve WebTransport, so the echo target is a small Go program.
  // A missing Go toolchain is an error, never a reason to skip.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-wtecho-'));
  const echoBin = path.join(tmp, process.platform === 'win32' ? 'wtecho.exe' : 'wtecho');
  childProcess.execFileSync('go', ['build', '-o', echoBin, './test/wtecho'], { stdio: 'inherit' });

  const procs = [];
  let browser;
  let targetServer;
  let gatewayLog = '';
  t.after(async () => {
    try { if (browser) await browser.close(); } catch {}
    try { if (targetServer) targetServer.close(); } catch {}
    for (const p of procs) { try { p.kill(); } catch {} }
    fs.writeFileSync(path.join(artifacts, 'wt-gateway-server.log'), gatewayLog);
  });

  const echo = childProcess.spawn(echoBin, [], { stdio: ['ignore', 'pipe', 'inherit'] });
  procs.push(echo);
  const { addr, certHash } = JSON.parse(await new Promise(resolve => readline.createInterface({ input: echo.stdout }).once('line', resolve)));

  const proxyPort = await freeTCP();
  const gwPort = await freeUDP();
  const proxy = childProcess.spawn(serverPath, [
    '-addr', `127.0.0.1:${proxyPort}`, '-web', path.join(dist, 'web'), '-socks', 'internal',
    '-wt-addr', `127.0.0.1:${gwPort}`, '-wt-public-url', `https://proxy.localhost:${gwPort}/__zp/wt`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(proxy);
  proxy.stderr.on('data', d => { gatewayLog += d; });
  await waitHTTP(`http://127.0.0.1:${proxyPort}/zp/`, 15000);

  targetServer = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    r.end(fixturePage(addr, certHash, q.url.startsWith('/worker')));
  });
  await new Promise(resolve => targetServer.listen(0, '127.0.0.1', resolve));
  const targetBase = `http://localhost:${targetServer.address().port}`;

  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 60000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--host-resolver-rules=MAP proxy.localhost 127.0.0.1'],
  });
  const expected = JSON.stringify({ ready: 'ok', bidi: 'ping', dgram: '1,2,3', badPin: 'rejected:WebTransportError' });
  const results = {};

  for (const variant of ['page', 'worker']) {
    await t.test(variant, async () => {
      const url = `${targetBase}/${variant === 'worker' ? 'worker' : ''}`;
      const direct = await browser.newPage();
      await direct.goto(url);
      await direct.waitForFunction(() => window.__wt, { timeout: 45000, polling: 100 });
      const native = await direct.evaluate(() => window.__wt);
      await direct.close();
      assert.equal(native, expected, 'the native reference itself must work');

      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.goto(`http://proxy.localhost:${proxyPort}/zp/`, { waitUntil: 'domcontentloaded' });
      await page.type('input', url);
      await Promise.all([
        page.waitForNavigation({ timeout: 45000 }).catch(() => {}),
        page.click('button, input[type=submit]').catch(() => page.keyboard.press('Enter')),
      ]);
      await page.waitForFunction(() => window.__wt, { timeout: 60000, polling: 100 }).catch(() => {});
      const proxied = await page.evaluate(() => window.__wt || '(no result)');
      await ctx.close();
      results[variant] = { native, proxied };
      assert.equal(proxied, native, `${variant}: proxied WebTransport diverges from native`);
    });
  }
  fs.writeFileSync(path.join(artifacts, 'wt-gateway.json'), JSON.stringify(results, null, 2));
  // The proxied sessions went through the gateway: it made the page's
  // pinned dial itself and refused the wrong certificate.
  assert.match(gatewayLog, /matches no serverCertificateHashes/, 'gateway never performed the pinned dial');
});
