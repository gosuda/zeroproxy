// Drives the launcher page the way a user does: wait for the runtime, type the
// target, press Open.
//
// The launcher keeps Open disabled — and its submit handler a no-op ("Runtime is
// still loading") — until the service worker's runtime reports ready. A fresh
// browser context starts cold, so clicking straight away races that: the click
// does nothing, no navigation happens and the test sits out its timeouts. A CI
// run lost exactly that way (no navigation, no gateway session, 105 s).
//
// Returns whether the click led to a navigation, so a caller that then finds no
// result can say which stage stalled.
async function openThroughLauncher(page, proxyOrigin, targetUrl, { navigationTimeout = 45000 } = {}) {
  await page.goto(`${proxyOrigin}/zp/`, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(() => { const b = document.querySelector('button'); return b && !b.disabled; }, { timeout: 90000, polling: 100 });
  } catch {
    throw new Error(`launcher never became ready: ${JSON.stringify(await pageText(page))}`);
  }
  await page.type('input', targetUrl);
  let navigated = true;
  await Promise.all([
    page.waitForNavigation({ timeout: navigationTimeout }).catch(() => { navigated = false; }),
    page.click('button, input[type=submit]').catch(() => page.keyboard.press('Enter')),
  ]);
  return navigated;
}

// What the page is showing — a stuck launcher, an error page and a silent
// script all look the same from "no result".
async function pageText(page) {
  return page.evaluate(() => ({ url: location.href.slice(0, 90), text: document.body.innerText.slice(0, 160) })).catch(e => ({ error: String(e) }));
}

module.exports = { openThroughLauncher, pageText };
