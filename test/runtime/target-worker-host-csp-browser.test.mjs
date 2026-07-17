import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const browserFixtures = path.join(root, "test/browser");
const workerSource = path.join(root, "web/sw/target-worker");
const executableHash = "c".repeat(64);

function chromePath() {
  return [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(value => value && existsSync(value));
}
function wait(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
function close(server) { return new Promise(resolve => server.close(resolve)); }
async function waitForFile(file) { for (let i = 0; i < 400; i += 1) { try { return await readFile(file, "utf8"); } catch { await wait(25); } } throw new Error("DevToolsActivePort unavailable"); }
class CDP {
  constructor(url) { this.socket = new WebSocket(url); this.id = 0; this.pending = new Map(); this.events = []; this.socket.addEventListener("message", event => { const message = JSON.parse(event.data); if (!message.id) { this.events.push(message); return; } const pending = this.pending.get(message.id); this.pending.delete(message.id); message.error ? pending?.reject(new Error(message.error.message)) : pending?.resolve(message.result); }); }
  async ready() { if (this.socket.readyState === WebSocket.OPEN) return; await new Promise((resolve, reject) => { this.socket.addEventListener("open", resolve, { once: true }); this.socket.addEventListener("error", reject, { once: true }); }); }
  call(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  close() { this.socket.close(); }
}
async function oracle(cdp) {
  for (let i = 0; i < 800; i += 1) { const value = await cdp.call("Runtime.evaluate", { expression: "globalThis.__targetWorkerHostCSPOracle ?? null", returnByValue: true }); if (value.result.value) return value.result.value; await wait(25); }
  throw new Error("target worker CSP oracle timed out");
}

test("target worker host loads only controlled internal executable modules under strict CSP", { timeout: 35_000 }, async t => {
  const chrome = chromePath();
  assert.ok(chrome, "supported Chromium executable is required");
  const sources = new Map([
    ["/host/host-entry.mjs", path.join(workerSource, "host-entry.mjs")],
    ["/host/host-runtime.mjs", path.join(workerSource, "host-runtime.mjs")],
    ["/host/event-runtime.mjs", path.join(workerSource, "event-runtime.mjs")],
    ["/host/validation.mjs", path.join(workerSource, "validation.mjs")],
    [`/_zp/target-worker-exec/${executableHash}.mjs`, path.join(browserFixtures, "target-worker-host-csp-executable.mjs")],
  ]);
  const gatewayRequests = [];
  const html = await readFile(path.join(browserFixtures, "target-worker-host-csp-oracle.html"));
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://fixture.localhost").pathname;
    if (pathname === "/target-worker-host-csp-oracle.html") {
      response.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'self' 'nonce-oracle'; worker-src 'self'; connect-src 'self'; base-uri 'none'" }).end(html);
      return;
    }
    if (pathname === "/_zp/version.json") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ version: 2, selectors: { "policy_core.js": "/host/policy-core.mjs", "policy_core.wasm": "/host/policy-core.wasm", "share_crypto.js": "/host/share-crypto.mjs", "share_crypto.wasm": "/host/share-crypto.wasm" } }));
      return;
    }
    if (pathname === "/host/share-crypto.mjs") {
      response.writeHead(200, { "Content-Type": "text/javascript;charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; base-uri 'none'" }).end("export default async()=>{};export function seal_history_v2(){return 'sealedgatewaytoken'}");
      return;
    }
    if (pathname === "/host/policy-core.mjs") {
      response.writeHead(200, { "Content-Type": "text/javascript;charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; base-uri 'none'" }).end(`export default async()=>{};export function executable_route_path_result_json(kind,routeID){return JSON.stringify({ok:true,path:kind==="target-worker"?"/_zp/target-worker-exec/"+routeID+".mjs":""})}export function worker_gateway_path_result_json(kind,routeID,token){return JSON.stringify({ok:true,path:"/_zp/"+(kind==="classic"?"wi":"wmi")+"/"+routeID+"/"+token})}`);
      return;
    }
    if (/^\/_zp\/wi\/[A-Za-z0-9_-]{32}\/[A-Za-z0-9_-]{1,16384}$/.test(pathname)) {
      gatewayRequests.push(pathname);
      response.writeHead(200, { "Content-Type": "text/javascript;charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; base-uri 'none'" }).end("self.__targetWorkerClassicImportLoaded=true;");
      return;
    }
    if (pathname === "/host/host-classic.js") {
      const classic = (await readFile(path.join(workerSource, "host-classic.js"), "utf8")).replaceAll("__ZP_TARGET_WORKER_HOST_MODULE_URL__", "/host/host-entry.mjs");
      response.writeHead(200, { "Content-Type": "text/javascript;charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; base-uri 'none'" }).end(classic);
      return;
    }
    const source = sources.get(pathname);
    if (!source) { response.writeHead(404).end("missing"); return; }
    try {
      response.writeHead(200, { "Content-Type": "text/javascript;charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; base-uri 'none'" }).end(await readFile(source));
    } catch { response.writeHead(500).end("fixture unavailable"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  const profile = await mkdtemp(path.join(os.tmpdir(), "zeroproxy-target-host-csp-"));
  let child;
  let cdp;
  t.after(async () => { cdp?.close(); child?.kill("SIGKILL"); await close(server); await rm(profile, { recursive: true, force: true }); });
  child = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const [debugPort] = (await waitForFile(path.join(profile, "DevToolsActivePort"))).trim().split("\n");
  const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/target-worker-host-csp-oracle.html`)}`, { method: "PUT" }).then(response => response.json());
  cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.call("Runtime.enable");
  const result = await oracle(cdp);
  const exceptions = cdp.events.filter(event => event.method === "Runtime.exceptionThrown");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  assert.equal(gatewayRequests.length, 1, JSON.stringify(gatewayRequests));
});
