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
const entryID = "e".repeat(32);
const abi = `__zp_abi_${"a".repeat(48)}`;
const rootTarget = "https://target.example/application/root?secret=root#root-fragment";
const replaceTarget = "https://target.example/application/replace?secret=replace#replace-fragment";
const pushedTarget = "https://target.example/application/pushed?secret=pushed#pushed-fragment";

const runtimeBootstrap = runtimeBootstrapFixture({
  capability,
  entryID,
  targetURL: rootTarget,
  approvedPorts: [80, 443],
});
function chromiumPath() {
  return [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ].find(candidate => candidate && existsSync(candidate));
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html;charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript;charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".json")) return "application/json;charset=utf-8";
  return "application/octet-stream";
}

function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
function closeServer(server) { server.closeAllConnections?.(); return new Promise(resolve => server.close(resolve)); }

class CDP {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextID = 1;
    this.pending = new Map();
    this.events = [];
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (!message.id) { this.events.push(message); return; }
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
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
  close() { this.socket.close(); }
}

async function waitForFile(file, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { return await readFile(file, "utf8"); } catch { await delay(25); }
  }
  throw new Error(`timed out waiting for ${file}`);
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
    const result = await cdp.call("Runtime.evaluate", { expression: `globalThis[${JSON.stringify(name)}] ?? null`, returnByValue: true });
    if (result.result.value) return result.result.value;
    await delay(25);
  }
  const diagnostic = await cdp.call("Runtime.evaluate", { expression: "({href:location.href,documentURL:document.URL,text:document.body?.innerText})", returnByValue: true });
  throw new Error(`${name} timed out: ${JSON.stringify(diagnostic.result.value)}`);
}

async function waitForBody(cdp, expected, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await cdp.call("Runtime.evaluate", { expression: "document.body?.innerText ?? ''", returnByValue: true });
    if (result.result.value?.includes(expected)) return;
    await delay(25);
  }
  throw new Error(`body did not contain ${expected}`);
}

async function waitForRehydratedRuntime(cdp, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await cdp.call("Runtime.evaluate", {
      expression: `({documentURL:document.URL,state:history.state,ready:Boolean(globalThis[${JSON.stringify(abi)}])})`,
      returnByValue: true,
    });
    const value = result.result.value;
    if (value?.ready && value.documentURL === pushedTarget) return value;
    await delay(25);
  }
  throw new Error("rehydrated runtime did not expose the virtual pushed target");
}

async function startGateway() {
  const [bootstrap, oracle, worker] = await Promise.all([
    readFile(path.join(root, "test/browser/sealed-history-bootstrap.html"), "utf8"),
    readFile(path.join(root, "test/browser/sealed-history-oracle.html"), "utf8"),
    readFile(path.join(root, "test/browser/sealed-history-sw.js"), "utf8"),
  ]);
  const version = JSON.parse(await readFile(path.join(dist, "_zp/version.json"), "utf8"));
  const runtimeAsset = version.selectors?.["runtime-prelude.js"];
  const historyWasm = version.selectors?.["share_crypto_classic.wasm"];
  assert.equal(typeof runtimeAsset, "string", "current runtime selector is required");
  assert.equal(typeof historyWasm, "string", "current history crypto selector is required");
  const server = http.createServer((request, response) => void (async () => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const url = new URL(request.url, origin);
      if (url.pathname === "/sealed-history-bootstrap.html") {
        const swURL = `/sealed-history-sw.js?runtime=${encodeURIComponent(runtimeAsset)}`;
        response.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; worker-src 'self'; connect-src 'self'; base-uri 'none'" }).end(bootstrap.replace("__SW_URL__", swURL));
        return;
      }
      if (url.pathname === "/sealed-history-oracle.html") {
        const runtimeURL = `${runtimeAsset}#abi=${abi}&url=${encodeURIComponent(rootTarget)}&ports=443&cookie=${capability}&strings=0`;
        const rendered = oracle
          .replace("__RUNTIME_URL__", runtimeURL.replaceAll("&", "&amp;"))
          .replace("__RUNTIME_BOOTSTRAP__", runtimeBootstrap)
          .replace("__ABI_NAME__", abi);
        response.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; base-uri 'none'" }).end(rendered);
        return;
      }
      if (url.pathname === "/sealed-history-sw.js") {
        const rendered = worker
          .replaceAll("__ENTRY_ID__", entryID)
          .replaceAll("__CAPABILITY__", capability)
          .replaceAll("__ABI__", abi)
          .replaceAll("__RUNTIME_ASSET__", runtimeAsset)
          .replaceAll("__RUNTIME_BOOTSTRAP__", runtimeBootstrap);
        response.writeHead(200, { "Content-Type": "text/javascript;charset=utf-8", "Cache-Control": "no-store", "Service-Worker-Allowed": "/" }).end(rendered);
        return;
      }
      const file = path.resolve(dist, `.${decodeURIComponent(url.pathname)}`);
      if (!file.startsWith(`${dist}${path.sep}`)) throw new Error("asset path escaped dist");
      response.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" }).end(await readFile(file));
    } catch {
      if (!response.headersSent) response.writeHead(404, { "Content-Type": "text/plain;charset=utf-8" });
      response.end("missing");
    }
  })());
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server;
}

function opaqueRoute(entry) {
  const url = new URL(entry.url);
  return /^\/_zp\/history\/e{32}\/[A-Za-z0-9_-]{32,16384}$/.test(url.pathname);
}

function tamper(pathname) {
  const last = pathname.at(-1);
  return `${pathname.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

test("sealed history routes remain opaque and rehydrate through the service worker", { timeout: 60_000 }, async t => {
  const chrome = chromiumPath();
  assert.ok(chrome, "supported Chromium executable is required");
  const server = await startGateway();
  const profile = await mkdtemp(path.join(os.tmpdir(), "zeroproxy-sealed-history-"));
  let browser;
  let cdp;
  t.after(async () => {
    cdp?.close();
    browser?.kill("SIGKILL");
    await closeServer(server);
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  browser = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const [debugPort] = (await waitForFile(path.join(profile, "DevToolsActivePort"))).trim().split("\n");
  cdp = await openTarget(Number(debugPort), `http://127.0.0.1:${server.address().port}/sealed-history-bootstrap.html`);
  const initial = await waitForGlobal(cdp, "__sealedHistoryInitial");
  assert.equal(initial.ok, true, initial.error);
  assert.deepEqual(initial.replace, { href: replaceTarget, documentURL: replaceTarget, state: { phase: "replace", visible: "replace" } });
  assert.deepEqual(initial.pushed, { href: pushedTarget, documentURL: pushedTarget, state: { phase: "push", visible: "push" } });
  assert.deepEqual(initial.back, initial.replace, "back must restore the virtual replace entry");
  assert.deepEqual(initial.forward, initial.pushed, "forward must restore the virtual push entry");

  const history = await cdp.call("Page.getNavigationHistory");
  const opaque = history.entries.filter(opaqueRoute);
  assert.equal(opaque.length, 2, JSON.stringify(history.entries));
  assert.ok(opaque.every(entry => !entry.url.includes("target.example") && !entry.url.includes("secret=")), "browser history must not carry a plaintext target");
  const current = history.entries[history.currentIndex];
  assert.ok(opaqueRoute(current), "current native route must be the opaque pushed history route");
  const routes = opaque.map(entry => ({ path: new URL(entry.url).pathname, target: entry.id === current.id ? pushedTarget : replaceTarget }));
  await cdp.call("Runtime.evaluate", { expression: `globalThis.__sealedHistoryStoreRoutes(${JSON.stringify(routes)})`, awaitPromise: true, returnByValue: true });
  await cdp.call("Runtime.evaluate", { expression: "globalThis.__sealedHistoryResetMock()", awaitPromise: true, returnByValue: true });
  await cdp.call("Page.reload", { ignoreCache: true });
  const rehydrated = await waitForRehydratedRuntime(cdp);
  const rehydratedHref = await cdp.call("Runtime.evaluate", { expression: `globalThis[${JSON.stringify(abi)}].scope.window.location.href`, returnByValue: true });
  assert.equal(rehydratedHref.result.value, pushedTarget, "cold route rehydrate must restore the virtual target URL");
  assert.equal(rehydrated.documentURL, pushedTarget, "document URL facade must remain virtual after reload");
  assert.deepEqual(rehydrated.state, { phase: "push", visible: "push" }, "history state must survive opaque-route reload");

  const currentPath = new URL(current.url).pathname;
  await cdp.call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}${tamper(currentPath)}` });
  await waitForBody(cdp, "HISTORY_ROUTE_UNAVAILABLE");
  const wrongEntryPath = currentPath.replace(`/${entryID}/`, `/${"z".repeat(32)}/`);
  await cdp.call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}${wrongEntryPath}` });
  await waitForBody(cdp, "HISTORY_ROUTE_UNAVAILABLE");

  const directTargets = cdp.events
    .filter(event => event.method === "Network.requestWillBeSent")
    .map(event => event.params.request.url)
    .filter(url => new URL(url).origin === "https://target.example");
  assert.deepEqual(directTargets, [], `direct target egress: ${JSON.stringify(directTargets)}`);
});
