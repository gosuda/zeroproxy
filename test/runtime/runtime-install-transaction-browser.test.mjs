import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DIST = path.join(ROOT, "dist/web");
const FIXTURE = path.join(ROOT, "test/browser/runtime-transaction-rollback-oracle.html");
const UNBOUND_FIXTURE = path.join(ROOT, "test/browser/runtime-unbound-command-oracle.html");
const PINNED_CHROMIUM = path.join(
  ROOT,
  ".puppeteer-cache/chrome/mac_arm-150.0.7871.124/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
);
const PINNED_FIREFOX = path.join(
  ROOT,
  ".puppeteer-cache/firefox/mac_arm-stable_152.0.6/Firefox.app/Contents/MacOS/firefox",
);
const chromium = process.env.ZP_CHROMIUM_PATH
  ?? process.env.CHROME_BIN
  ?? (existsSync(PINNED_CHROMIUM) ? PINNED_CHROMIUM : null);
const firefox = process.env.ZP_FIREFOX_PATH
  ?? (existsSync(PINNED_FIREFOX) ? PINNED_FIREFOX : null);

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

async function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      const file = pathname === "/runtime-transaction-rollback-oracle.html"
        ? FIXTURE
        : pathname === "/runtime-unbound-command-oracle.html"
          ? UNBOUND_FIXTURE
          : path.resolve(DIST, `.${pathname}`);
      if (file !== FIXTURE && file !== UNBOUND_FIXTURE && !file.startsWith(`${DIST}${path.sep}`)) throw new Error("invalid path");
      const body = await readFile(file);
      response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": contentType(file) });
      response.end(body);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

for (const lane of [
  { browser: "chrome", executablePath: chromium, family: "chromium", protocol: "cdp" },
  { browser: "firefox", executablePath: firefox, family: "firefox", protocol: "webDriverBiDi" },
]) {
  test(`runtime transaction reverses required hooks, listeners, globals, and ABI in ${lane.family}`, {
    skip: lane.executablePath ? false : `pinned ${lane.family} unavailable`,
    timeout: 30_000,
  }, async () => {
    const server = await startServer();
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const browser = await puppeteer.launch({
      browser: lane.browser,
      executablePath: lane.executablePath,
      headless: true,
      protocol: lane.protocol,
      args: lane.family === "chromium" ? ["--disable-gpu", "--no-sandbox"] : [],
    });
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${address.port}/runtime-transaction-rollback-oracle.html`, { waitUntil: "load" });
      await page.waitForFunction(() => globalThis.__zp_transaction_rollback_result !== undefined, { timeout: 15_000 });
      const result = await page.evaluate(() => globalThis.__zp_transaction_rollback_result);
      assert.equal(result.ok, true, JSON.stringify(result));
      await page.goto(`http://127.0.0.1:${address.port}/runtime-unbound-command-oracle.html`, { waitUntil: "load" });
      await page.waitForFunction(() => globalThis.__zp_unbound_command_result !== undefined, { timeout: 5_000 });
      const unbound = await page.evaluate(() => globalThis.__zp_unbound_command_result);
      assert.equal(unbound.ok, true, JSON.stringify(unbound));
    } finally {
      await browser.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
