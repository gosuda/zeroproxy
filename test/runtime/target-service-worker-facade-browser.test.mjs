import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimeBootstrapFixture } from "./runtime-bootstrap-fixture.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dist = path.join(root, "dist/web");
const fixtures = path.join(root, "test/browser");
const capability = "s".repeat(32);
const abi = `__zp_abi_${"a".repeat(48)}`;

function chromiumPath() {
  return [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find(candidate => candidate && existsSync(candidate));
}

function contentType(file) {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript;charset=utf-8";
  if (file.endsWith(".json")) return "application/json;charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) { return new Promise(resolve => server.close(resolve)); }

async function waitForFile(file) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try { return await readFile(file, "utf8"); } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  throw new Error("DevToolsActivePort unavailable");
}

class CDP {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.pending = new Map();
    this.next = 0;
    this.events = [];
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (!message.id) { this.events.push(message); return; }
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!pending) return;
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    });
  }
  async ready() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }
  call(method, params = {}) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket.close(); }
}

async function openTarget(debugPort, url) {
  const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: "PUT" }).then(response => response.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.call("Runtime.enable");
  await cdp.call("Page.enable");
  return cdp;
}

async function waitForOracle(cdp) {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    const value = await cdp.call("Runtime.evaluate", { expression: "globalThis.__targetServiceWorkerFacadeOracle ?? null", returnByValue: true });
    if (value.result.value) return value.result.value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const diagnostic = await cdp.call("Runtime.evaluate", { expression: "({href:location.href,oracle:typeof globalThis.__targetServiceWorkerFacadeOracle})", returnByValue: true });
  throw new Error(`facade oracle timed out: ${JSON.stringify(diagnostic)}`);
}

test("production navigator.serviceWorker facade follows durable lifecycle notifications", { timeout: 35_000 }, async t => {
  const chrome = chromiumPath();
  assert.ok(chrome, "supported Chromium executable is required");
  let targetRequests = 0;
  const failures = [];
  const [oracle, plan, version] = await Promise.all([
    readFile(path.join(fixtures, "target-service-worker-facade-oracle.html"), "utf8"),
    readFile(path.join(fixtures, "target-service-worker-plan-sw.js"), "utf8"),
    readFile(path.join(dist, "_zp/version.json"), "utf8").then(JSON.parse),
  ]);
  const runtimeAsset = version.selectors?.["runtime-prelude.js"];
  assert.equal(typeof runtimeAsset, "string", "built runtime prelude asset is required");
  const server = http.createServer((request, response) => void (async () => {
    try {
      const port = server.address().port;
      const origin = `http://127.0.0.1:${port}`;
      const pathname = new URL(request.url, origin).pathname;
      if (pathname === "/target-service-worker-facade-oracle.html") {
        const targetURL = `${origin}/target/app/index.html`;
        const runtimeURL = `${runtimeAsset}#abi=${abi}&url=${encodeURIComponent(targetURL)}&ports=${port}&cookie=${capability}&strings=0`;
        const bootstrap = runtimeBootstrapFixture({ capability, entryID: "s".repeat(32), targetURL, approvedPorts: [port] });
        const rendered = oracle.replace("__ZP_CONFIG__", JSON.stringify({
          bootstrap,
          origin,
          runtimeURL,
          scope: `${origin}/target/app/`,
          scriptURL: `${origin}/target/worker.mjs`,
        }));
        response.writeHead(200, {
          "Content-Type": "text/html;charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'; base-uri 'none'",
        }).end(rendered);
        return;
      }
      if (pathname === "/target-service-worker-plan-sw.js") {
        response.writeHead(200, { "Content-Type": "text/javascript;charset=utf-8", "Cache-Control": "no-store", "Service-Worker-Allowed": "/" }).end(plan);
        return;
      }
      if (pathname === "/target/worker.mjs") {
        targetRequests += 1;
        response.writeHead(418, { "Content-Type": "text/plain" }).end("direct target request denied");
        return;
      }
      if (pathname === "/favicon.ico") {
        response.writeHead(204).end();
        return;
      }
      const file = path.resolve(dist, `.${decodeURIComponent(pathname)}`);
      if (!file.startsWith(`${dist}${path.sep}`)) throw new Error("invalid asset path");
      response.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" }).end(await readFile(file));
    } catch (error) {
      failures.push(error?.stack ?? error?.message ?? String(error));
      if (!response.headersSent) response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("missing");
    }
  })());
  const port = await listen(server);
  const profile = await mkdtemp(path.join(os.tmpdir(), "zeroproxy-target-sw-facade-"));
  let processHandle;
  let cdp;
  t.after(async () => {
    cdp?.close();
    processHandle?.kill("SIGKILL");
    await close(server);
    await rm(profile, { recursive: true, force: true });
  });
  processHandle = spawn(chrome, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore" });
  const [debugPort] = (await waitForFile(path.join(profile, "DevToolsActivePort"))).trim().split("\n");
  cdp = await openTarget(debugPort, `http://127.0.0.1:${port}/target-service-worker-facade-oracle.html`);
  const result = await waitForOracle(cdp);
  const exceptions = cdp.events.filter(event => event.method === "Runtime.exceptionThrown");
  assert.deepEqual(failures, []);
  assert.equal(result.ok, true, JSON.stringify({ exceptions, result }));
  assert.equal(result.passed, result.total, JSON.stringify(result));
  assert.equal(targetRequests, 0, "virtual registration must never directly request the target script");
  assert.deepEqual(result.checks.filter(check => !check.pass), []);
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
});
