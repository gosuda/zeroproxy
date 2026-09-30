// D5 end to end: a proxied page opens a data channel to a native peer through
// the target's own signaling, and the peer must see only the TURN relay —
// never the page's own address.
//
// Until 2026-09-30 D5 was a pion signaling bridge whose target side was never
// negotiated; page code still received the native connection's own SDP and
// candidates, so with D5 enabled the peer connected to the user directly
// (host↔host). The embedded TURN server also refused every credential it
// minted. WebRTC now runs relay-only through that TURN server.
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const freeTCP = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const freeUDP = host => new Promise((resolve, reject) => {
  const s = dgram.createSocket('udp4');
  s.once('error', reject);
  s.bind(0, host, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
// Chrome's WebRTC skips the loopback adapter, so a TURN server there is
// unreachable — the relay needs a routable interface.
function routableIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
  }
  return '';
}

const COMMON = `
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const send = (to, m) => fetch('/sig?room=' + ROOM + '&to=' + to, { method: 'POST', body: JSON.stringify(m) });
  const inbox = async me => (await (await fetch('/sig?room=' + ROOM + '&for=' + me, { cache: 'no-store' })).json()).map(s => JSON.parse(s));
  async function selectedPair(pc) {
    const st = await pc.getStats(); let pair = null; const c = {};
    st.forEach(s => {
      if (s.type === 'candidate-pair' && (s.nominated || s.selected) && s.state === 'succeeded') pair = s;
      if (s.type === 'local-candidate' || s.type === 'remote-candidate') c[s.id] = s;
    });
    if (!pair) return 'none';
    return 'local=' + (c[pair.localCandidateId] || {}).candidateType + ' remote=' + (c[pair.remoteCandidateId] || {}).candidateType;
  }`;

function pageA(room) {
  return `<!doctype html><title>A</title><body><script>
  const ROOM = ${JSON.stringify(room)}; ${COMMON}
  (async () => {
    const out = { candTypes: [] };
    try {
      const pc = new RTCPeerConnection();
      pc.addEventListener('icecandidate', e => {
        if (!e.candidate) return;
        out.candTypes.push(e.candidate.type || (e.candidate.candidate.match(/ typ ([a-z]+)/) || [])[1]);
        send('b', { cand: e.candidate.toJSON() });
      });
      const dc = pc.createDataChannel('x');
      const got = new Promise(res => { dc.onmessage = e => res(String(e.data)); });
      dc.onopen = () => dc.send('hi');
      await pc.setLocalDescription(await pc.createOffer());
      await send('b', { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
      const until = Date.now() + 25000;
      while (Date.now() < until && dc.readyState !== 'open') {
        for (const m of await inbox('a')) {
          if (m.sdp) await pc.setRemoteDescription(m.sdp);
          if (m.cand) { try { await pc.addIceCandidate(m.cand); } catch {} }
        }
        await sleep(150);
      }
      out.dc = dc.readyState;
      out.echo = await Promise.race([got, sleep(8000).then(() => 'timeout')]);
      out.pair = await selectedPair(pc);
    } catch (e) { out.error = e.name + ':' + String(e.message).slice(0, 160); }
    window.__rtc = out;
  })();
  </script></body>`;
}

function pageB(room) {
  return `<!doctype html><title>B</title><body><script>
  const ROOM = ${JSON.stringify(room)}; ${COMMON}
  (async () => {
    const pc = new RTCPeerConnection();
    pc.addEventListener('icecandidate', e => { if (e.candidate) send('a', { cand: e.candidate.toJSON() }); });
    pc.ondatachannel = e => { const ch = e.channel; ch.onmessage = m => ch.send('echo:' + m.data); };
    const until = Date.now() + 40000;
    while (Date.now() < until) {
      for (const m of await inbox('b')) {
        if (m.sdp) {
          await pc.setRemoteDescription(m.sdp);
          await pc.setLocalDescription(await pc.createAnswer());
          await send('a', { sdp: { type: 'answer', sdp: pc.localDescription.sdp } });
        }
        if (m.cand) { try { await pc.addIceCandidate(m.cand); } catch {} }
      }
      if (pc.connectionState === 'connected') { await sleep(1500); break; }
      await sleep(150);
    }
    window.__rtcB = await selectedPair(pc);
  })();
  </script></body>`;
}

test('D5: proxied WebRTC runs relay-only through the embedded TURN server', { timeout: 240000, concurrency: false }, async t => {
  const dist = path.resolve(process.env.ZP_E2E_DIST || 'dist');
  const artifacts = path.resolve(process.env.ZP_E2E_ARTIFACTS || 'artifacts/e2e');
  fs.mkdirSync(artifacts, { recursive: true });
  const serverPath = path.join(dist, process.platform === 'win32' ? 'zeroproxy-server.exe' : 'zeroproxy-server');
  assert.ok(fs.existsSync(serverPath), `missing ${serverPath} — build first`);
  const ip = routableIPv4();
  assert.ok(ip, 'no routable IPv4 interface — Chrome cannot reach a loopback TURN server');

  let browser;
  let proxy;
  let target;
  let serverLog = '';
  t.after(async () => {
    try { if (browser) await browser.close(); } catch {}
    try { if (target) target.close(); } catch {}
    try { if (proxy) proxy.kill(); } catch {}
    fs.writeFileSync(path.join(artifacts, 'rtc-relay-server.log'), serverLog);
  });

  const proxyPort = await freeTCP();
  const turnPort = await freeUDP(ip);
  proxy = childProcess.spawn(serverPath, [
    '-addr', `127.0.0.1:${proxyPort}`, '-web', path.join(dist, 'web'), '-socks', 'internal',
    '-rtc-enable', '-rtc-turn-addr', `${ip}:${turnPort}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  proxy.stderr.on('data', d => { serverLog += d; });

  const mail = new Map();
  target = http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x');
    if (u.pathname === '/sig') {
      const key = u.searchParams.get('room') + '/' + (u.searchParams.get('to') || u.searchParams.get('for'));
      if (q.method === 'POST') {
        let b = '';
        q.on('data', d => { b += d; });
        q.on('end', () => { (mail.get(key) || mail.set(key, []).get(key)).push(b); r.writeHead(204); r.end(); });
        return;
      }
      const msgs = mail.get(key) || [];
      mail.set(key, []);
      r.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      r.end(JSON.stringify(msgs));
      return;
    }
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    r.end(u.pathname === '/b' ? pageB(u.searchParams.get('room')) : pageA(u.searchParams.get('room')));
  });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const base = `http://localhost:${target.address().port}`;

  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 60000,
    // A real remote peer advertises public (srflx/relay) candidates; mDNS
    // names would give the relay-only side no address to permit.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--host-resolver-rules=MAP proxy.localhost 127.0.0.1',
      '--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
  const results = {};
  for (const mode of ['native', 'proxied']) {
    await t.test(mode, async () => {
      const room = mode + '-' + Date.now();
      const b = await browser.newPage();
      await b.goto(`${base}/b?room=${room}`);
      const ctx = await browser.createBrowserContext();
      const a = await ctx.newPage();
      if (mode === 'native') {
        await a.goto(`${base}/a?room=${room}`);
      } else {
        await a.goto(`http://proxy.localhost:${proxyPort}/zp/`, { waitUntil: 'domcontentloaded' });
        await a.type('input', `${base}/a?room=${room}`);
        await Promise.all([
          a.waitForNavigation({ timeout: 45000 }).catch(() => {}),
          a.click('button, input[type=submit]').catch(() => a.keyboard.press('Enter')),
        ]);
      }
      await a.waitForFunction(() => window.__rtc, { timeout: 60000, polling: 200 }).catch(() => {});
      await b.waitForFunction(() => window.__rtcB, { timeout: 45000, polling: 200 }).catch(() => {});
      const rA = await a.evaluate(() => window.__rtc || null);
      const rB = await b.evaluate(() => window.__rtcB || null);
      results[mode] = { a: rA, b: rB };
      await ctx.close();
      await b.close();
      assert.ok(rA && !rA.error, `${mode}: page A failed: ${JSON.stringify(rA)}`);
      assert.equal(rA.dc, 'open', `${mode}: data channel never opened: ${JSON.stringify(rA)}`);
      assert.equal(rA.echo, 'echo:hi', `${mode}: no echo: ${JSON.stringify(rA)}`);
      if (mode === 'proxied') {
        // Relay only: no candidate — and so no packet — from the page's own address.
        assert.ok(rA.candTypes.length > 0 && rA.candTypes.every(c => c === 'relay'), `proxied page gathered non-relay candidates: ${rA.candTypes}`);
        assert.match(String(rB), /remote=relay$/, `the peer connected to something other than the relay: ${rB}`);
      }
    });
  }
  fs.writeFileSync(path.join(artifacts, 'rtc-relay.json'), JSON.stringify(results, null, 2));
});
