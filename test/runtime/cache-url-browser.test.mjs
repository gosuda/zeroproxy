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
const capability = "c".repeat(32);
const abi = `__zp_abi_${"c".repeat(48)}`;

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

function contentType(file) {
  if (file.endsWith(".html")) return "text/html;charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript;charset=utf-8";
  if (file.endsWith(".json")) return "application/json;charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function startTarget() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://target.invalid");
    if (url.pathname === "/cache-data") {
      response.writeHead(200, { "Content-Type": "text/plain" }).end("cache-data");
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain" }).end("missing");
  });
  const port = await listen(server);
  return { server, origin: `http://127.0.0.1:${port}` };
}

function apiError(response, code) {
  response.writeHead(502, { "Content-Type": "text/plain;charset=utf-8", "X-ZP-API-ERROR": code }).end(`gateway error: ${code}`);
}

async function startGateway(target) {
  const failures = [];
  const [bootstrap, worker, oracle, version] = await Promise.all([
    readFile(path.join(root, "test/browser/network-gateway-bootstrap.html"), "utf8"),
    readFile(path.join(root, "test/browser/network-gateway-plan-sw.js"), "utf8"),
    readFile(path.join(root, "test/browser/cache-url-oracle.html"), "utf8"),
    readFile(path.join(dist, "_zp/version.json"), "utf8").then(JSON.parse),
  ]);
  const runtimeAsset = version.selectors?.["runtime-prelude.js"];
  assert.equal(typeof runtimeAsset, "string", "built runtime prelude asset is required");
  const server = http.createServer((request, response) => void (async () => {
    try {
      const port = server.address().port;
      const origin = `http://127.0.0.1:${port}`;
      const url = new URL(request.url, origin);
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204).end();
        return;
      }
      if (url.pathname === "/network-gateway-bootstrap.html") {
        response.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" }).end(bootstrap);
        return;
      }
      if (url.pathname === "/network-gateway-plan-sw.js") {
        response.writeHead(200, { "Content-Type": "text/javascript;charset=utf-8", "Cache-Control": "no-store", "Service-Worker-Allowed": "/" }).end(worker);
        return;
      }
      if (url.pathname === "/cache-url-oracle.html") {
        const runtimeURL = `${runtimeAsset}#abi=${abi}&url=${encodeURIComponent(`${target.origin}/app/index.html`)}&ports=${[port, new URL(target.origin).port].join(",")}&cookie=${capability}&strings=0`;
        const runtimeBootstrap = runtimeBootstrapFixture({
          capability,
          entryID: "c".repeat(32),
          targetURL: `${target.origin}/app/index.html`,
          approvedPorts: [port, Number(new URL(target.origin).port)],
        });
        const rendered = oracle
          .replaceAll("__ZP_RUNTIME_URL__", runtimeURL.replaceAll("&", "&amp;"))
          .replace("__ZP_RUNTIME_BOOTSTRAP__", runtimeBootstrap)
          .replace("__ZP_CACHE_CONFIG__", JSON.stringify({ target: target.origin }));
        response.writeHead(200, {
          "Content-Type": "text/html;charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'; base-uri 'none'",
        }).end(rendered);
        return;
      }
      if (url.pathname.startsWith("/_zp/api/")) {
        let plan;
        try {
          plan = JSON.parse(Buffer.from(url.pathname.slice("/_zp/api/".length), "base64url").toString("utf8"));
          if (plan?.target_url !== `${target.origin}/cache-data`) throw new Error("unexpected plan");
        } catch {
          apiError(response, "PLAN_INVALID");
          return;
        }
        const targetResponse = await fetch(plan.target_url, { method: plan.method, redirect: "manual" });
        const headers = Object.fromEntries(targetResponse.headers);
        headers["X-ZP-Target-URL"] = plan.target_url;
        headers["X-ZP-Redirected"] = "0";
        headers["X-ZP-Response-Type"] = "basic";
        response.writeHead(targetResponse.status, headers);
        response.end(Buffer.from(await targetResponse.arrayBuffer()));
        return;
      }
      const file = path.resolve(dist, `.${decodeURIComponent(url.pathname)}`);
      if (!file.startsWith(`${dist}${path.sep}`)) throw new Error("invalid asset path");
      response.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" }).end(await readFile(file));
    } catch (error) {
      failures.push(error?.stack ?? error?.message ?? String(error));
      if (!response.headersSent) response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("not found");
    }
  })());
  const port = await listen(server);
  return { server, origin: `http://127.0.0.1:${port}`, failures };
}

async function waitForFile(file, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      return await readFile(file, "utf8");
    } catch {
      await delay(25);
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
  await cdp.call("Network.enable");
  await cdp.call("Page.enable");
  return cdp;
}

async function waitForGlobal(cdp, name, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const evaluation = await cdp.call("Runtime.evaluate", { expression: `globalThis[${JSON.stringify(name)}] ?? null`, returnByValue: true });
    if (evaluation.result.value) return evaluation.result.value;
    await delay(25);
  }
  const diagnostic = await cdp.call("Runtime.evaluate", { expression: "({ href: location.href, body: document.body?.innerText, result: globalThis.__cacheURLOracle ?? null })", returnByValue: true });
  const exceptions = cdp.events.filter(event => event.method === "Runtime.exceptionThrown").map(event => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);
  throw new Error(`${name} timed out: ${JSON.stringify({ diagnostic: diagnostic.result.value, exceptions })}`);
}

const expectedContracts = [
  "mediated response exposes virtual target URL before Cache.put",
  "Cache.put accepts mediated Response",
  "Cache.match returns a Response for mediated request",
  "Cache.match preserves mediated Response body",
  "Cache.matchAll returns mediated Response",
  "Cache.matchAll preserves mediated Response body",
  "Cache Request and Response URL accessors retain virtual target URLs",
  "serialized Cache Request and Response URLs retain virtual target URLs",
  "Cache URL projection hides gateway and synthetic origins",
];

test("Cache APIs preserve virtual target URL identity for mediated responses", { timeout: 35_000 }, async t => {
  const chrome = chromiumPath();
  assert.ok(chrome, "supported Chromium executable is required");
  const target = await startTarget();
  const gateway = await startGateway(target);
  const profile = await mkdtemp(path.join(os.tmpdir(), "zeroproxy-cache-url-"));
  let processHandle;
  let cdp;

  t.after(async () => {
    cdp?.close();
    processHandle?.kill("SIGKILL");
    await Promise.all([closeServer(gateway.server), closeServer(target.server)]);
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
  cdp = await openTarget(debugPort, `${gateway.origin}/network-gateway-bootstrap.html`);
  const bootstrap = await waitForGlobal(cdp, "__networkGatewayBootstrap");
  assert.equal(bootstrap.ok, true, bootstrap.error);
  await cdp.call("Page.navigate", { url: `${gateway.origin}/cache-url-oracle.html` });
  const result = await waitForGlobal(cdp, "__cacheURLOracle", 20_000);
  const exceptions = cdp.events
    .filter(event => event.method === "Runtime.exceptionThrown")
    .map(event => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);
  const browserRequests = cdp.events.filter(event => event.method === "Network.requestWillBeSent").map(event => event.params.request.url);

  assert.equal(result.ok, true, JSON.stringify({ result, failures: gateway.failures, browserRequests }));
  assert.deepEqual(result.cases.map(entry => entry.name), expectedContracts);
  assert.deepEqual(result.cases.filter(entry => !entry.pass), []);
  assert.equal(exceptions.length, 0, exceptions.join("\n"));
  assert.deepEqual(browserRequests.filter(url => new URL(url).origin === target.origin), [], `direct target browser requests: ${JSON.stringify(browserRequests)}`);
  assert.ok(browserRequests.some(url => new URL(url).pathname.startsWith("/_zp/api/")), "mediated Cache fetch must use the gateway API path");
});
