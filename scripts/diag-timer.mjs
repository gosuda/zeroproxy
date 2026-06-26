// Focused diagnostic: does the SW kernel's setTimeout-based idle-completion
// actually fire? Loads launcher (tab A) which we keep as a stable realm to
// poll __zpKernelProbe, opens naver in tab B to drive real fetches, and
// accumulates unique rustTrace lines across 1s polls so document-stream
// traces are captured before the ring buffer evicts them.

import puppeteer from 'puppeteer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROXY = 'http://proxy.localhost:18080';
const userDataDir = mkdtempSync(join(tmpdir(), 'zp-diag-'));
const browser = await puppeteer.launch({
  headless: 'new',
  userDataDir,
  protocolTimeout: 120000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--host-resolver-rules=MAP proxy.localhost 127.0.0.1'],
});

async function pollTraces(pollPage) {
  return await pollPage.evaluate(async () => {
    const ctrl = navigator.serviceWorker.controller;
    if (!ctrl) return [];
    return await new Promise(res => {
      const ch = new MessageChannel();
      ch.port1.onmessage = e => res((e.data && e.data.probe && e.data.probe.rustTrace) || []);
      ctrl.postMessage({ type: '__zpKernelProbe' }, [ch.port2]);
      setTimeout(() => res([]), 1500);
    });
  });
}

try {
  // Tab A — stable launcher realm for polling.
  const a = await browser.newPage();
  await a.goto(`${PROXY}/zp/`, { waitUntil: 'domcontentloaded' });
  await a.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, { timeout: 30000 });

  // Tab B — drive the naver load.
  const b = await browser.newPage();
  await b.goto(`${PROXY}/zp/`, { waitUntil: 'domcontentloaded' });
  await b.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, { timeout: 30000 });
  await b.evaluate(url => {
    const i = document.querySelector('input');
    if (i) { i.value = url; i.dispatchEvent(new Event('input', { bubbles: true })); }
  }, 'https://www.naver.com/');
  const btn = await b.$('button');
  if (btn) await btn.click();

  const seen = new Set();
  const interesting = /naver\.com|idle|cl-complete|cold-deadline|h2-ok|h2-body|tls-ok|h2-hs/;
  for (let t = 0; t < 18; t++) {
    await new Promise(r => setTimeout(r, 1000));
    let traces = [];
    try { traces = await pollTraces(a); } catch (e) {}
    for (const l of traces) if (interesting.test(l)) seen.add(l);
  }

  console.log('=== ACCUMULATED www.naver-related rustTrace (timer fire check) ===');
  const lines = [...seen].sort();
  for (const l of lines) console.log(l);
  console.log(`\n=== summary ===`);
  console.log(`idle-complete firings: ${lines.filter(l => l.includes('h2-body-idle-complete')).length}`);
  console.log(`cl-complete firings:   ${lines.filter(l => l.includes('h2-body-cl-complete')).length}`);
  console.log(`cold-deadline firings: ${lines.filter(l => l.includes('cold-deadline')).length}`);
  console.log(`www.naver h2-ok lines:`);
  for (const l of lines.filter(l => l.includes('h2-ok') && l.includes('www.naver.com'))) console.log('  ' + l);
} finally {
  await browser.close();
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}
