// T6-3 진단: Turnstile armed 로드 시 wire/console/response 수집.
// 사용: node scripts/turnstile-probe.cjs
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const puppeteer = require('puppeteer');

const PROXY_PORT = String(30000 + Math.floor(Math.random() * 20000));
const SERVER_BIN = path.resolve(process.platform === 'win32' ? 'dist/zeroproxy-server.exe' : 'dist/zeroproxy-server');
const DIST_WEB = path.resolve('dist/web');
const TARGET = 'https://turnstile.zeroclover.io/';

function waitForHTTP(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => fetch(url).then(r => resolve()).catch(retry);
    const retry = () => Date.now() - start > timeoutMs ? reject(new Error('boot timeout')) : setTimeout(tick, 200);
    tick();
  });
}

(async () => {
  const server = spawn(SERVER_BIN, ['-web', DIST_WEB, '-addr', '127.0.0.1:' + PROXY_PORT, '-socks', 'internal'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', c => serverLog += c);
  server.stderr.on('data', c => serverLog += c);
  await waitForHTTP(`http://127.0.0.1:${PROXY_PORT}/zp/`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-ts-'));
  const browser = await puppeteer.launch({
    headless: 'new', userDataDir, protocolTimeout: 300000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--host-resolver-rules=MAP proxy.localhost 127.0.0.1'],
  });

  const wire = [];
  const console_ = [];
  const failed = [];
  const observe = async target => {
    if (!['page', 'service_worker', 'shared_worker', 'worker'].includes(target.type())) return;
    try {
      const s = await target.createCDPSession();
      s.on('Network.requestWillBeSent', e => wire.push(`${target.type()} REQ ${e.request.url}`));
      s.on('Network.responseReceived', e => {
        const h = e.response.headers;
        wire.push(`${target.type()} RESP ${e.response.status} ${e.response.url} ${(h['content-type']||'').slice(0,40)}`);
        if (h['content-security-policy']) {
          const cf = /challenges\.cloudflare\.com/.test(h['content-security-policy']) ? 'ARMED' : 'disarmed';
          wire.push(`  CSP[${cf}]: ${h['content-security-policy'].slice(0, 300)}`);
        }
        if (h['x-zp-challenge-compat']) wire.push(`  X-ZP-Challenge-Compat: ${h['x-zp-challenge-compat']}  ← PAGE SAW MARKER!`);
      });
      s.on('Network.loadingFailed', e => failed.push(`${target.type()} FAIL ${e.errorText} blocked=${e.blockedReason || ''}`));
      s.on('Runtime.consoleAPICalled', e => console_.push(`${target.type()} ${e.type}: ${e.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`));
      s.on('Runtime.exceptionThrown', e => console_.push(`${target.type()} EXC ${JSON.stringify(e.exceptionDetails).slice(0, 500)}`));
      s.on('Log.entryAdded', e => console_.push(`${target.type()} LOG ${e.entry.level}: ${(e.entry.text||'').slice(0,300)}`));
      await s.send('Log.enable');
      await s.send('Network.enable');
      await s.send('Runtime.enable');
    } catch {}
  };

  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await observe(page.target());
  browser.on('targetcreated', t => observe(t).catch(() => {}));

  await page.goto(`http://proxy.localhost:${PROXY_PORT}/zp/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, { timeout: 30000 });
  await page.evaluate((url) => {
    const input = document.querySelector('input#url');
    input.value = url;
    const cc = document.getElementById('challenge-compat');
    if (cc && !cc.checked) { cc.checked = true; cc.dispatchEvent(new Event('change', { bubbles: true })); }
  }, TARGET);
  await page.waitForFunction(() => { const b = document.querySelector('#open button'); return b && !b.disabled; }, { timeout: 60000 });
  await page.click('#open button');

  // 공유 URL 로 네비게이션될 때까지 대기 (런처가 location.assign 한다).
  await page.waitForFunction(() => location.pathname.startsWith('/zp/p/'), { timeout: 30000 }).catch(e => console.log('NAV-TIMEOUT', e.message));

  // 45 초간 챌린지 클리어 대기 — title/url 변화를 폴링.
  const deadline = Date.now() + 45000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const title = await page.title();
      const url = page.url();
      const cur = `${title}|${url.slice(-60)}`;
      if (cur !== last) { console.log('STATE', cur); last = cur; }
      if (!/just a moment/i.test(title) && title && title !== 'ZeroProxy') break;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }

  // 챌린지 상태 덤프 — _cf_chl_opt, body 내용.
  try {
    const st = await page.evaluate(() => ({
      cfOpt: typeof window._cf_chl_opt !== 'undefined' ? Object.keys(window._cf_chl_opt).length : 'absent',
      cfChl: typeof window._cf_chl !== 'undefined',
      turnstile: typeof window.turnstile,
      bodyLen: document.body ? document.body.innerHTML.length : -1,
      iframes: document.querySelectorAll('iframe').length,
      scripts: [...document.scripts].map(s => (s.src || 'inline').slice(0, 120)),
    }));
    console.log('--- PAGE-STATE', JSON.stringify(st, null, 1));
  } catch (e) { console.log('--- PAGE-STATE-ERR', e.message); }

  console.log('--- FINAL', last);
  console.log('--- WIRE (all) ---');
  for (const w of wire) console.log(w);
  console.log('--- FAILED ---');
  for (const f of failed) console.log(f);
  console.log('--- CONSOLE ---');
  for (const c of console_.slice(0, 60)) console.log(c);
  console.log('--- SERVER ---');
  console.log(serverLog.slice(-3000));

  await page.screenshot({ path: '.ai/dogfood/turnstile-probe.png' }).catch(() => {});
  await browser.close();
  server.kill('SIGKILL');
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
