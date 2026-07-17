import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const dist = path.join(root, "dist/web");
const oraclePath = path.join(root, "test/browser/coordinator-database-oracle.html");

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
  if (file.endsWith(".html")) return "text/html;charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript;charset=utf-8";
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

async function waitForFile(file, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      return await readFile(file, "utf8");
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for ${file}`);
}

class CDP {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextID = 1;
    this.pending = new Map();
    this.events = [];
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        this.events.push(message);
        return;
      }
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
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
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function openTarget(port, url) {
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  }).then(response => response.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.call("Runtime.enable");
  return cdp;
}

async function waitForOracle(cdp) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await cdp.call("Runtime.evaluate", {
      expression: "document.querySelector('#result')?.textContent || ''",
      returnByValue: true,
    });
    if (response.result.value) return JSON.parse(response.result.value);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`coordinator database oracle timed out: ${JSON.stringify(cdp.events)}`);
}

const expectedContracts = [
  "schema-version-and-store-inventory",
  "profile-key-version-migrated",
  "origin-map-normalized",
  "cookie-value-encrypted-at-rest",
  "tab-record-normalized",
  "history-record-normalized",
  "auxiliary-records-normalized",
  "failed-migration-rolls-back-atomically",
];

test("coordinator database migrates normalized state and atomically rolls back failures", { timeout: 35_000 }, async t => {
  const chrome = chromiumPath();
  assert.ok(chrome, "supported Chromium executable is required");
  const oracle = await readFile(oraclePath);
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://database.localhost").pathname;
      if (pathname === "/coordinator-database-oracle.html") {
        response.writeHead(200, {
          "Content-Type": "text/html;charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'; base-uri 'none'",
        }).end(oracle);
        return;
      }
      const file = path.resolve(dist, `.${decodeURIComponent(pathname)}`);
      if (!file.startsWith(`${dist}${path.sep}`)) {
        response.writeHead(403).end("forbidden");
        return;
      }
      response.writeHead(200, {
        "Content-Type": contentType(file),
        "Cache-Control": "no-store",
      }).end(await readFile(file));
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  const port = await listen(server);
  const profile = await mkdtemp(path.join(os.tmpdir(), "zeroproxy-database-migration-"));
  let processHandle;
  let cdp;
  t.after(async () => {
    cdp?.close();
    if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
      const exited = new Promise(resolve => processHandle.once("exit", resolve));
      processHandle.kill("SIGKILL");
      await exited;
    }
    await close(server);
    await rm(profile, { recursive: true, force: true });
  });
  processHandle = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: "ignore" });
  const [debugPort] = (await waitForFile(path.join(profile, "DevToolsActivePort"))).trim().split("\n");
  cdp = await openTarget(debugPort, `http://127.0.0.1:${port}/coordinator-database-oracle.html`);
  const result = await waitForOracle(cdp);
  const exceptions = cdp.events
    .filter(event => event.method === "Runtime.exceptionThrown")
    .map(event => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.tests.map(entry => entry.id), expectedContracts);
  assert.deepEqual(result.tests.filter(entry => !entry.ok), []);
  assert.deepEqual(exceptions, []);
});
