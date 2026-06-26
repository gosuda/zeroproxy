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

const userDataDir = process.env.ZP_USERDATADIR
  ? process.env.ZP_USERDATADIR
  : mkdtempSync(join(tmpdir(), 'zp-naver-'));
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
  if (r && r.probe) {
    if (r.probe.rustTrace) {
      console.log(`  -- rustTrace --`);
      for (const line of r.probe.rustTrace) console.log(`    ${line}`);
    }
    if (r.probe.rewriteStats) {
      console.log(`  -- rewriteStats --`);
      console.log(`    ${JSON.stringify(r.probe.rewriteStats)}`);
    }
    if (r.probe.outgoingHeaders && r.probe.outgoingHeaders.length) {
      console.log(`  -- outgoingHeaders (last ${r.probe.outgoingHeaders.length}) --`);
      for (const ent of r.probe.outgoingHeaders) {
        console.log(`    ▸ ${ent.method} ${ent.target}`);
        for (const [k, v] of ent.headers) console.log(`      ${k}: ${v}`);
      }
    }
    if (r.probe.transportStats) {
      console.log(`  -- transportStats --`);
      console.log(`    ${JSON.stringify(r.probe.transportStats)}`);
    }
    if (r.probe.transportLatency && r.probe.transportLatency.length) {
      // Top 10 slowest (descending), then a chronological tail of 10
      // for sequencing context.
      const tx = r.probe.transportLatency.slice();
      const slow = tx.slice().sort((a, b) => b.latencyMs - a.latencyMs).slice(0, 10);
      console.log(`  -- transportLatency slowest 10 --`);
      for (const ent of slow) {
        console.log(`    ${String(ent.latencyMs).padStart(5)}ms  ${ent.status}  ${ent.method}  ${ent.target}  (${ent.bytes}B)`);
      }
      console.log(`  -- transportLatency chronological tail (last ${Math.min(10, tx.length)}) --`);
      for (const ent of tx.slice(-10)) {
        console.log(`    ${String(ent.latencyMs).padStart(5)}ms  ${ent.status}  ${ent.method}  ${ent.target}  (${ent.bytes}B)`);
      }
    }
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
  // 2026-06-11: 25s 로 확대 — NAVER cold path 가 60s document slow-lane 후
  // hydration 진행하므로 8s 면 page state evaluate 시 "Execution context
  // destroyed" 발생 (page navigation 진행 중). 25s wait 면 cache hit
  // path 일 때 hydration 안정화 + garbage detection 실행 가능.
  await new Promise(r => setTimeout(r, 25000));

  // The page realm may have navigated; controller should still apply.
  // 2026-06-11: retry 로직 — NAVER share URL 의 광고 SDK 가 history.pushState
  // 로 entry 자주 변경. evaluate 시점에 page realm 이 새 entry 로 가는 중
  // 이면 "Execution context destroyed" 발생. 최대 3 번 retry.
  let state = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    state = await page.evaluate(() => {
    const garbage = [];
    if (document.body) {
      document.body.querySelectorAll('*').forEach(el => {
        if (el.children.length > 0) return;
        const t = el.textContent || '';
        if (t.length > 100) {
          let bad = 0;
          for (const c of t) {
            const cc = c.charCodeAt(0);
            if (!(cc >= 0x20 && cc <= 0x7E) && !(cc >= 0xAC00 && cc <= 0xD7A3) &&
                !(cc >= 0x3040 && cc <= 0x309F) && !(cc >= 0x30A0 && cc <= 0x30FF) &&
                !(cc >= 0x4E00 && cc <= 0x9FFF) && cc !== 0x0A && cc !== 0x0D && cc !== 0x09) bad++;
          }
          if (bad / t.length > 0.3 && garbage.length < 3) {
            garbage.push({ tag: el.tagName, cls: (el.className||'').toString().slice(0,40), len: t.length, sample: t.slice(0,80) });
          }
        }
      });
    }
    return {
      title: document.title,
      url: location.href,
      bodyLen: (document.body && document.body.innerText || '').length,
      bodyHead: (document.body && document.body.innerText || '').slice(0, 200),
      garbageElements: garbage,
    };
    }).catch(e => ({ err: String(e.message || e) }));
    if (!state || !state.err) break;
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log(`\n=== PAGE STATE POST-SUBMIT ===`);
  console.log(JSON.stringify(state, null, 2));

  // Open a fresh launcher tab so the SW controller is in a known state
  // (the proxy.localhost share-URL page may still be navigating or
  // detaching). The SW lifetime + outgoingHeaderLog persists across
  // tabs, so the headers we sent for NAVER are still captured.
  try {
    const launcherPage = await browser.newPage();
    await launcherPage.goto(`${PROXY}/zp/`, { waitUntil: 'domcontentloaded' });
    await launcherPage.waitForFunction(
      () => navigator.serviceWorker && navigator.serviceWorker.controller,
      { timeout: 15000 },
    );
    await probe(launcherPage, 'POST-NAVER-FETCH (via fresh launcher tab)');
    await launcherPage.close();
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
  if (!process.env.ZP_USERDATADIR) {
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}
