// Drives the launcher page: wait for the runtime button to enable, enter the target URL, and submit.
// The launcher keeps Open disabled until the service worker runtime reports ready.
// Returns whether the click triggered a navigation.
async function openThroughLauncher(page, proxyOrigin, targetUrl, { navigationTimeout = 45000 } = {}) {
  // Do not await goto: when the service worker starts during this navigation, goto's wait can hang
  // even after the page is complete and controlled. Wait on the button state instead.
  page.goto(`${proxyOrigin}/zp/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
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

// Captures the current URL and visible body text for timeout diagnostics.
async function pageText(page) {
  return page.evaluate(() => ({ url: location.href.slice(0, 90), text: document.body.innerText.slice(0, 160) })).catch(e => ({ error: String(e) }));
}

module.exports = { openThroughLauncher, pageText };
