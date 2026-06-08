// One-off diagnostic: navigate the launcher, submit a URL, then ask
// the SW for the rust-side trace ring buffer via the __zpKernelProbe
// message. Dumps `rustTrace` so we can see which transport stage
// failed (mux/socks5/tls/h2/h1).
//
// Usage: node scripts/probe-kernel-trace.mjs https://example.com/

import puppeteer from 'puppeteer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const target = process.argv[2] || 'https://example.com/';
const PROXY = process.env.ZP_PROXY || 'http://proxy.localhost:18080';

const userDataDir = mkdtempSync(join(tmpdir(), 'zp-probe-'));
const browser = await puppeteer.launch({
  headless: 'new',
  userDataDir,
  protocolTimeout: 60000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--host-resolver-rules=MAP proxy.localhost 127.0.0.1'],
});
try {
  const page = await browser.newPage();
  await page.goto(`${PROXY}/zp/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => navigator.serviceWorker && navigator.serviceWorker.controller,
    { timeout: 30000 },
  );

  await page.evaluate((url) => {
    const input = document.querySelector('input');
    if (input) { input.value = url; input.dispatchEvent(new Event('input', { bubbles: true })); }
  }, target);
  const openBtn = await page.$('button');
  if (openBtn) await openBtn.click();

  // Give the document fetch + (failed) transport stage time to complete.
  await new Promise(r => setTimeout(r, 6000));

  // Re-wait for the controller — page navigated off the launcher,
  // and on slower hardware the new doc realm may not have inherited
  // the controller yet at evaluate-time.
  try {
    await page.waitForFunction(
      () => navigator.serviceWorker && navigator.serviceWorker.controller,
      { timeout: 20000 },
    );
  } catch {}

  const probe = await page.evaluate(() => {
    return new Promise(resolve => {
      const ctrl = navigator.serviceWorker.controller;
      if (!ctrl) return resolve({ err: 'no controller' });
      const ch = new MessageChannel();
      ch.port1.onmessage = ev => resolve(ev.data);
      ctrl.postMessage({ type: '__zpKernelProbe' }, [ch.port2]);
      setTimeout(() => resolve({ err: 'probe timeout' }), 8000);
    });
  });

  console.log(JSON.stringify({ target, probe }, null, 2));
} finally {
  await browser.close();
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}
