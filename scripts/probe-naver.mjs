// NAVER-specific diagnostic: load launcher, wait for SW, take a
// baseline kernel trace, submit NAVER, wait, take another trace.
// Designed to surface what stage of the transport / rewriter is
// returning the user-visible 403.

import puppeteer from 'puppeteer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROXY = process.env.ZP_PROXY || 'http://proxy.localhost:18080';
const TARGET = process.argv[2] || 'https://www.naver.com/';
const PORT = (new URL(PROXY)).port || '18080';

const userDataDir = mkdtempSync(join(tmpdir(), 'zp-naver-'));
const browser = await puppeteer.launch({
  headless: 'new',
  userDataDir,
  protocolTimeout: 300000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', `--host-resolver-rules=MAP proxy.localhost 127.0.0.1`],
});

async function probe(page, label) {
  const r = await page.evaluate(async () => {
    const ctrl = navigator.serviceWorker.controller;
    if (!ctrl) return { err: 'no controller' };
    return await new Promise(resolve => {
      const ch = new MessageChannel();
      ch.port1.onmessage = ev => resolve(ev.data);
      ctrl.postMessage({ type: '__zpKernelProbe' }, [ch.port2]);
      setTimeout(() => resolve({ err: 'probe timeout' }), 8000);
    });
  });
  console.log(`\n=== ${label} ===`);
  if (r && r.probe && r.probe.rustTrace) {
    for (const line of r.probe.rustTrace) console.log(`  ${line}`);
  } else {
    console.log(`  ${JSON.stringify(r, null, 2)}`);
  }
}

try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', msg => {
    const text = msg.text();
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleErrors.push(`[${msg.type()}] ${text}`);
    }
  });
  page.on('pageerror', err => consoleErrors.push(`[pageerror] ${String(err.message || err)}`));

  await page.goto(`${PROXY}/zp/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => navigator.serviceWorker && navigator.serviceWorker.controller,
    { timeout: 30000 },
  );
  await probe(page, 'BASELINE (launcher loaded, SW ready)');

  // Submit target URL via launcher form.
  await page.evaluate((url) => {
    const input = document.querySelector('input');
    if (input) { input.value = url; input.dispatchEvent(new Event('input', { bubbles: true })); }
  }, TARGET);
  const openBtn = await page.$('button');
  if (openBtn) await openBtn.click();

  // Give the document fetch time to fail/succeed.
  await new Promise(r => setTimeout(r, 8000));

  // The page realm may have navigated; controller should still apply.
  const state = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    bodyLen: (document.body && document.body.innerText || '').length,
    bodyHead: (document.body && document.body.innerText || '').slice(0, 800),
  })).catch(e => ({ err: String(e.message || e) }));

  console.log(`\n=== PAGE STATE POST-SUBMIT ===`);
  console.log(JSON.stringify(state, null, 2));

  // After the navigation lands, SW controller should be available
  // again in the new doc realm.
  try {
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, { timeout: 15000 });
    await probe(page, 'POST-NAVER-FETCH');
  } catch (e) {
    console.log(`\n=== PROBE FAILED: ${e.message} ===`);
  }

  console.log(`\n=== CONSOLE ERRORS / WARNINGS (${consoleErrors.length}) ===`);
  for (const line of consoleErrors) console.log(`  ${line}`);

  const outPath = `.ai/dogfood/naver-probe-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify({ state, consoleErrors }, null, 2));
  console.log(`\nartifacts: ${outPath}`);
} finally {
  await browser.close();
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}
