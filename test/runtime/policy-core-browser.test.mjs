import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "../..");
const dist = path.join(root, "dist/web");

function chromiumPath() {
  return [
    process.env.CHROME_BIN,
    path.join(root, ".puppeteer-cache/chrome/mac_arm-150.0.7871.124/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].find(candidate => candidate && existsSync(candidate));
}

function contentType(file) {
  if (file.endsWith(".mjs") || file.endsWith(".js")) return "text/javascript;charset=utf-8";
  if (file.endsWith(".json")) return "application/json;charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

test("shipped policy-core WASM is the browser URL, origin, and site authority", async (t) => {
  const executablePath = chromiumPath();
  assert.ok(executablePath, "pinned Chromium is required");
  const server = http.createServer((request, response) => void (async () => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/oracle") {
      response.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" }).end("<!doctype html><title>policy oracle</title>");
      return;
    }
    const file = path.resolve(dist, `.${url.pathname}`);
    if (!file.startsWith(`${dist}${path.sep}`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  })());
  const port = await listen(server);
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  t.after(async () => {
    await browser.close();
    await close(server);
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/oracle`, { waitUntil: "load" });
  const observed = await page.evaluate(async () => {
    const policy = await import("/generated/policy.mjs");
    const idna = await policy.canonicalTarget("../x?q=1#f", "https://BÜCHER.example:8443/a/b");
    const ipv6 = await policy.canonicalTarget("http://[2001:db8::1]/");
    const failures = [];
    for (const value of ["https://u:p@example.test/", "ftp://example.test/"]) {
      try { await policy.canonicalTarget(value); }
      catch (error) { failures.push(error.name); }
    }
    return { failures, idna, ipv6 };
  });
  assert.deepEqual(observed.idna, {
    url: "https://xn--bcher-kva.example:8443/x?q=1#f",
    networkURL: "https://xn--bcher-kva.example:8443/x?q=1",
    fragment: "f",
    canonicalOrigin: "https://xn--bcher-kva.example:8443",
    canonicalSite: "https://xn--bcher-kva.example",
    scheme: "https",
    host: "xn--bcher-kva.example",
    port: 8443,
    origin: "https://xn--bcher-kva.example:8443",
  });
  assert.equal(observed.ipv6.canonicalOrigin, "http://[2001:db8::1]:80");
  assert.equal(observed.ipv6.canonicalSite, "http://[2001:db8::1]");
  assert.deepEqual(observed.failures, ["SecurityError", "SecurityError"]);
});
