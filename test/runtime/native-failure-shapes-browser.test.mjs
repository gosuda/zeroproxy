import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { createNavigationFailureResponse } from "../../web/sw/navigation-failure.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const pinnedChromium = path.join(
  root,
  ".puppeteer-cache/chrome/mac_arm-150.0.7871.124/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
);
const pinnedFirefox = path.join(
  root,
  ".puppeteer-cache/firefox/mac_arm-stable_152.0.6/Firefox.app/Contents/MacOS/firefox",
);
const chromium = process.env.ZP_CHROMIUM_PATH
  ?? process.env.CHROME_BIN
  ?? (existsSync(pinnedChromium) ? pinnedChromium : null);
const firefox = process.env.ZP_FIREFOX_PATH
  ?? (existsSync(pinnedFirefox) ? pinnedFirefox : null);
const failurePageScript = await readFile(path.join(root, "web/native-failure-page.mjs"));
const executableOracle = `<!doctype html><meta charset="utf-8"><title>failure shapes</title>
<script type="module">
const result={classicErrors:0,classicLoads:0,classicExecuted:false,moduleExecuted:false,moduleRejected:false,moduleError:null,moduleAsynchronous:false,cssErrors:0,cssLoads:0,cssApplied:false};
const classic=new Promise(resolve=>{const script=document.createElement("script");script.src="/failed-classic.js";script.addEventListener("error",()=>{result.classicErrors+=1;resolve()});script.addEventListener("load",()=>{result.classicLoads+=1;resolve()});document.head.append(script)});
let moduleSynchronous=true;const moduleFailure=import("/failed-module.mjs").then(()=>{result.moduleExecuted=true},error=>{result.moduleRejected=true;result.moduleError=error?.name;result.moduleAsynchronous=!moduleSynchronous});moduleSynchronous=false;
const css=new Promise(resolve=>{const link=document.createElement("link");link.rel="stylesheet";link.href="/failed.css";link.addEventListener("error",()=>{result.cssErrors+=1;resolve()});link.addEventListener("load",()=>{result.cssLoads+=1;resolve()});document.head.append(link)});
await Promise.all([classic,moduleFailure,css]);result.classicExecuted=globalThis.__failedClassicExecuted===true;result.moduleExecuted||=globalThis.__failedModuleExecuted===true;result.cssApplied=getComputedStyle(document.body).backgroundColor==="rgb(1, 2, 3)";globalThis.__nativeFailureResult=result;
</script>`;

async function startServer() {
  const retryRequests = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/failure") {
      const failure = createNavigationFailureResponse({
        code: "REWRITE_FAILED",
        requestID: "request_identifier_1234",
        retryPath: "/retry",
        scriptPath: "/native-failure-page.mjs",
        stage: "REWRITE_HTML",
        targetURL: "https://target.example/private?secret=value#fragment",
      });
      response.writeHead(failure.status, Object.fromEntries(failure.headers));
      response.end(await failure.text());
      return;
    }
    if (url.pathname === "/native-failure-page.mjs") {
      response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/javascript; charset=utf-8" });
      response.end(failurePageScript);
      return;
    }
    if (url.pathname === "/executable") {
      response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" });
      response.end(executableOracle);
      return;
    }
    if (url.pathname === "/failed-classic.js" || url.pathname === "/failed-module.mjs") {
      response.writeHead(502, { "Cache-Control": "no-store", "Content-Type": "text/javascript; charset=utf-8", "X-Content-Type-Options": "nosniff" });
      response.end(url.pathname.includes("classic")
        ? "globalThis.__failedClassicExecuted=true"
        : "globalThis.__failedModuleExecuted=true;export default true");
      return;
    }
    if (url.pathname === "/failed.css") {
      response.writeHead(502, { "Cache-Control": "no-store", "Content-Type": "text/css; charset=utf-8", "X-Content-Type-Options": "nosniff" });
      response.end("body{background:rgb(1,2,3)}");
      return;
    }
    if (url.pathname === "/retry") retryRequests.push(url.href);
    response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>${url.pathname}</title>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { retryRequests, server };
}

for (const lane of [
  { browser: "chrome", executablePath: chromium, family: "chromium", protocol: "cdp" },
  { browser: "firefox", executablePath: firefox, family: "firefox", protocol: "webDriverBiDi" },
]) {
  test(`native failure shapes hold in pinned ${lane.family}`, {
    skip: lane.executablePath ? false : `pinned ${lane.family} unavailable`,
    timeout: 30_000,
  }, async () => {
    const { retryRequests, server } = await startServer();
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await puppeteer.launch({
      browser: lane.browser,
      executablePath: lane.executablePath,
      headless: true,
      protocol: lane.protocol,
      args: lane.family === "chromium" ? ["--disable-gpu", "--no-sandbox"] : [],
    });
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/origin`, { waitUntil: "load" });
      await page.goto(`${origin}/failure`, { waitUntil: "load" });
      assert.equal(await page.$$("script:not([src])").then(elements => elements.length), 0);
      assert.equal(await page.$eval("#zp-code", element => element.textContent), "REWRITE_FAILED");
      assert.equal(await page.$eval("#zp-host", element => element.textContent), "target.example");
      assert.equal(await page.$eval("#zp-stage", element => element.textContent), "REWRITE_HTML");
      assert.equal(await page.$eval("#zp-request", element => element.textContent), "request_identifier_1234");
      await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("#zp-back")]);
      assert.equal(new URL(page.url()).pathname, "/origin");

      await page.goto(`${origin}/failure`, { waitUntil: "load" });
      await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("#zp-home")]);
      assert.equal(new URL(page.url()).pathname, "/");

      await page.goto(`${origin}/failure`, { waitUntil: "load" });
      await Promise.all([
        page.waitForNavigation({ waitUntil: "load" }),
        page.evaluate(() => {
          document.querySelector("#zp-retry").click();
          document.querySelector("#zp-retry").click();
        }),
      ]);
      const retryURL = new URL(page.url());
      assert.equal(retryURL.pathname, "/retry");
      assert.match(retryURL.searchParams.get("_zp_retry"), /^[0-9a-f-]{36}$/u);
      assert.equal(retryRequests.length, 1);

      await page.goto(`${origin}/executable`, { waitUntil: "load" });
      await page.waitForFunction(() => globalThis.__nativeFailureResult !== undefined);
      assert.deepEqual(await page.evaluate(() => globalThis.__nativeFailureResult), {
        classicErrors: 1,
        classicLoads: 0,
        classicExecuted: false,
        moduleExecuted: false,
        moduleRejected: true,
        moduleError: "TypeError",
        moduleAsynchronous: true,
        cssErrors: 1,
        cssLoads: 0,
        cssApplied: false,
      });
    } finally {
      await browser.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
