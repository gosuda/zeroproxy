import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const fixtureDirectory = path.join(root, "test/browser");
const fixtures = new Map([
  ["/synthetic-origin-storage-oracle.html", "synthetic-origin-storage-oracle.html"],
  ["/synthetic-origin-storage-child.html", "synthetic-origin-storage-child.html"],
  ["/synthetic-origin-storage-frame.html", "synthetic-origin-storage-frame.html"],
  ["/synthetic-origin-session-popup.html", "synthetic-origin-session-popup.html"],
]);

function chromiumPath() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find(candidate => candidate && existsSync(candidate));
}

function fixtureServer() {
  return http.createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://fixture.localhost").pathname;
    if (pathname === "/synthetic-origin-storage-shared-worker.js") {
      response.writeHead(200, {
        "Content-Type": "text/javascript;charset=utf-8",
        "Cache-Control": "no-store",
      }).end("let value=null;onconnect=event=>{const port=event.ports[0];port.onmessage=message=>{const data=message.data;if(data.command==='set')value=data.value;port.postMessage({request:data.request,value})};port.start()}");
      return;
    }
    const fixture = fixtures.get(pathname);
    if (!fixture) {
      response.writeHead(404).end("not found");
      return;
    }
    try {
      const body = await readFile(path.join(fixtureDirectory, fixture));
      response.writeHead(200, {
        "Content-Type": "text/html;charset=utf-8",
        "Cache-Control": "no-store",
      }).end(body);
    } catch {
      response.writeHead(500).end("fixture unavailable");
    }
  });
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
      if (message.id) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (!pending) return;
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else {
        this.events.push(message);
      }
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
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" }).then(response => response.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.call("Runtime.enable");
  await cdp.call("Page.enable");
  return cdp;
}

async function waitForOracle(cdp) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await cdp.call("Runtime.evaluate", {
      expression: "globalThis.__syntheticOriginStorageOracle ?? null",
      returnByValue: true,
    });
    if (response.result.value) return response.result.value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const diagnostic = await cdp.call("Runtime.evaluate", {
    expression: "({ href: location.href, readyState: document.readyState, body: document.body?.innerText, oracle: globalThis.__syntheticOriginStorageOracle ?? null })",
    returnByValue: true,
  });
  const exceptions = cdp.events
    .filter(event => event.method === "Runtime.exceptionThrown")
    .map(event => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);
  throw new Error(`storage realm oracle timed out: ${JSON.stringify({ diagnostic: diagnostic.result.value, exceptions })}`);
}

const expectedContracts = [
  "required-browser-storage-apis-available",
  "same-synthetic-origin-shares-localstorage-indexeddb-and-cachestorage",
  "different-synthetic-host-cannot-read-storage",
  "same-synthetic-host-different-port-cannot-read-storage",
  "same-synthetic-origin-shares-sharedworker",
  "different-synthetic-host-isolates-sharedworker",
  "same-synthetic-host-different-port-isolates-sharedworker",
  "same-synthetic-origin-broadcastchannel-delivers",
  "different-synthetic-host-broadcastchannel-isolated",
  "same-synthetic-host-different-port-broadcastchannel-isolated",
  "same-synthetic-origin-weblocks-contend",
  "different-synthetic-host-weblocks-isolated",
  "same-synthetic-host-different-port-weblocks-isolated",
  "same-synthetic-origin-iframe-window-access",
  "cross-synthetic-origin-windowproxy-sop",
  "same-synthetic-origin-popup-clones-sessionstorage",
  "same-synthetic-origin-popup-sessionstorage-is-independent-after-clone",
  "different-synthetic-origin-popup-sessionstorage-is-partitioned",
  "sessionstorage-persists-through-same-origin-popup-navigation-and-back",
  "same-synthetic-origin-storage-event-reports-source-url",
  "different-synthetic-host-does-not-receive-storage-event",
  "same-synthetic-host-different-port-does-not-receive-storage-event",
];

test("synthetic origins retain native browser storage and realm isolation", { timeout: 35_000 }, async t => {
  const chrome = chromiumPath();
  assert.ok(chrome, "supported Chromium executable is required");

  const primaryServer = fixtureServer();
  const alternateServer = fixtureServer();
  const primaryPort = await listen(primaryServer);
  const alternatePort = await listen(alternateServer);
  const profile = await mkdtemp(path.join(os.tmpdir(), "zeroproxy-synthetic-storage-"));
  let processHandle;
  let cdp;

  t.after(async () => {
    cdp?.close();
    processHandle?.kill("SIGKILL");
    await Promise.all([close(primaryServer), close(alternateServer)]);
    await rm(profile, { recursive: true, force: true });
  });

  processHandle = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--disable-popup-blocking",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--host-resolver-rules=MAP *.storage.localhost 127.0.0.1",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: "ignore" });

  const [debugPort] = (await waitForFile(path.join(profile, "DevToolsActivePort"))).trim().split("\n");
  const controlOrigin = `http://control.storage.localhost:${primaryPort}`;
  cdp = await openTarget(debugPort, `${controlOrigin}/synthetic-origin-storage-oracle.html?alternatePort=${alternatePort}`);
  const oracle = await waitForOracle(cdp);
  const frameTree = oracle.error ? await cdp.call("Page.getFrameTree") : undefined;
  const exceptions = cdp.events
    .filter(event => event.method === "Runtime.exceptionThrown")
    .map(event => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);

  assert.equal(oracle.error, undefined, JSON.stringify({ oracle, frameTree }));
  assert.equal(oracle.ok, true, JSON.stringify(oracle));
  assert.equal(oracle.passed, oracle.total, JSON.stringify(oracle));
  assert.deepEqual(oracle.checks.map(check => check.id), expectedContracts);
  assert.deepEqual(oracle.checks.filter(check => !check.pass), []);
  assert.equal(exceptions.length, 0, exceptions.join("\n"));
});
