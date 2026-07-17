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
const capability = "n".repeat(32);
const abi = `__zp_abi_${"b".repeat(48)}`;

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
  if (file.endsWith(".json")) return "application/json;charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
function closeServer(server) { server.closeAllConnections?.(); return new Promise(resolve => server.close(resolve)); }

function readRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
    request.on("aborted", () => reject(new Error("request aborted")));
  });
}

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

async function openTarget(port, url) {
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" }).then(response => response.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.call("Runtime.enable");
  await cdp.call("Network.enable");
  await cdp.call("Page.enable");
  return cdp;
}

async function waitForFile(file, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { return await readFile(file, "utf8"); } catch { await delay(25); }
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function waitForResult(cdp, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await cdp.call("Runtime.evaluate", { expression: "globalThis.__advancedNetworkResult ?? null", returnByValue: true });
    if (value.result.value) return value.result.value;
    await delay(25);
  }
  const diagnostic = await cdp.call("Runtime.evaluate", { expression: "({ href: location.href, text: document.body?.innerText, stage: sessionStorage.getItem('navigation-stage'), captures: globalThis.__advancedNetworkResult ?? null })", returnByValue: true });
  const exceptions = cdp.events.filter(event => event.method === "Runtime.exceptionThrown").map(event => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);
  const navigationEvents = cdp.events.filter(event => event.method === "Page.frameNavigated" || event.method === "Network.requestWillBeSent" && event.params.request.url.includes("/_zp/navigation/")).map(event => event.method === "Page.frameNavigated" ? { method: event.method, frame: event.params.frame } : { method: event.method, frameId: event.params.frameId, type: event.params.type, url: event.params.request.url });
  throw new Error(`advanced network oracle timed out: ${JSON.stringify({ diagnostic: diagnostic.result.value, exceptions, navigationEvents })}`);
}

async function waitForGlobal(cdp, name, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await cdp.call("Runtime.evaluate", { expression: `globalThis[${JSON.stringify(name)}] ?? null`, returnByValue: true });
    if (value.result.value) return value.result.value;
    await delay(25);
  }
  throw new Error(`${name} timed out`);
}

async function startTarget() {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers });
    response.writeHead(599, { "Content-Type": "text/plain" }).end("direct target egress");
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, origin: `http://127.0.0.1:${server.address().port}`, requests };
}

function advancedRuntimeURL(server, runtimeAsset, targetOrigin) {
  const ports = [server.address().port, new URL(targetOrigin).port].join(",");
  return `${runtimeAsset}#abi=${abi}&url=${encodeURIComponent(`${targetOrigin}/app/index.html`)}&ports=${ports}&cookie=${capability}&strings=0`;
}

async function handleAdvancedGatewayRequest(context, request, response) {
  const origin = `http://127.0.0.1:${context.server.address().port}`;
  const url = new URL(request.url, origin);
  if (url.pathname === "/advanced-network-oracle.html") {
    const runtimeURL = advancedRuntimeURL(context.server, context.runtimeAsset, context.targetOrigin);
    const runtimeBootstrap = runtimeBootstrapFixture({
      capability,
      entryID: "e".repeat(32),
      targetURL: `${context.targetOrigin}/app/index.html`,
      approvedPorts: [context.server.address().port, Number(new URL(context.targetOrigin).port)],
    });
    const rendered = context.fixtures[url.pathname].toString()
      .replaceAll("__ZP_RUNTIME_URL__", runtimeURL.replaceAll("&", "&amp;"))
      .replace("__ZP_RUNTIME_BOOTSTRAP__", runtimeBootstrap)
      .replace("__ZP_CONFIG__", JSON.stringify({ target: context.targetOrigin }));
    response.writeHead(200, {
      "Content-Type": "text/html;charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src *; worker-src 'self'; frame-src 'self'; form-action *; base-uri 'none'",
    }).end(rendered);
    return;
  }
  if (context.runtimeAssets.has(url.pathname)) {
    response.writeHead(200, { "Content-Type": contentType(url.pathname), "Cache-Control": "no-store" })
      .end(context.runtimeAssets.get(url.pathname));
    return;
  }
  if (context.fixtures[url.pathname]) {
    response.writeHead(200, {
      "Content-Type": contentType(url.pathname),
      "Cache-Control": "no-store",
      "Service-Worker-Allowed": "/",
    }).end(context.fixtures[url.pathname]);
    return;
  }
  if (url.pathname === "/_zp/advanced-capture" && request.method === "POST") {
    context.captures.push(JSON.parse((await readRequest(request)).toString("utf8")));
    response.writeHead(204, { "Cache-Control": "no-store" }).end();
    return;
  }
  const file = path.resolve(dist, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${dist}${path.sep}`)) throw new Error("invalid asset path");
  response.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" }).end(await readFile(file));
}

function advancedGatewayHandler(context, request, response) {
  void handleAdvancedGatewayRequest(context, request, response).catch(() => {
    if (!response.headersSent) response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("missing");
  });
}

async function startGateway(targetOrigin) {
  const fixtures = Object.freeze({
    "/advanced-network-bootstrap.html": await readFile(path.join(root, "test/browser/advanced-network-bootstrap.html")),
    "/advanced-network-oracle.html": await readFile(path.join(root, "test/browser/advanced-network-oracle.html")),
    "/advanced-network-plan-sw.js": await readFile(path.join(root, "test/browser/advanced-network-plan-sw.js")),
  });
  const version = JSON.parse(await readFile(path.join(dist, "_zp/version.json"), "utf8"));
  const runtimeAsset = version.selectors?.["runtime-prelude.js"];
  assert.equal(typeof runtimeAsset, "string", "built runtime prelude asset is required");
  const runtimeBundle = await readFile(path.resolve(dist, `.${runtimeAsset}`));
  const compilerMatch = /\/_zp\/assets\/[a-f0-9]{64}\/js_compiler_classic\.wasm/.exec(runtimeBundle.toString("utf8"));
  assert.ok(compilerMatch, "runtime prelude must reference its compiler WASM asset");
  const runtimeAssets = new Map([
    [runtimeAsset, runtimeBundle],
    [compilerMatch[0], await readFile(path.resolve(dist, `.${compilerMatch[0]}`))],
  ]);
  const captures = [];
  const context = { captures, fixtures, runtimeAsset, runtimeAssets, server: null, targetOrigin };
  const server = http.createServer((request, response) => advancedGatewayHandler(context, request, response));
  context.server = server;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, captures };
}

test("navigation, beacon, form, ping, and download facades use sealed opaque routes", { timeout: 45_000 }, async t => {
  const chrome = chromiumPath();
  assert.ok(chrome, "supported Chromium executable is required");
  const target = await startTarget();
  const gateway = await startGateway(target.origin);
  const profile = await mkdtemp(path.join(os.tmpdir(), "zeroproxy-advanced-network-"));
  let browser;
  let cdp;
  t.after(async () => {
    cdp?.close();
    browser?.kill("SIGKILL");
    await Promise.all([closeServer(gateway.server), closeServer(target.server)]);
    await rm(profile, { recursive: true, force: true });
  });
  browser = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const [debugPort] = (await waitForFile(path.join(profile, "DevToolsActivePort"))).trim().split("\n");
  cdp = await openTarget(Number(debugPort), `http://127.0.0.1:${gateway.server.address().port}/advanced-network-bootstrap.html`);
  const bootstrap = await waitForGlobal(cdp, "__advancedNetworkBootstrap");
  assert.equal(bootstrap.ok, true, bootstrap.error);
  await cdp.call("Runtime.evaluate", { expression: "__launchAdvancedNetworkOracle()" });
  const result = await waitForResult(cdp);
  assert.equal(result.ok, true, JSON.stringify({ error: result.error, stack: result.stack, lastCases: result.cases.slice(-4), navigationRequests: cdp.events.filter(event => event.method === "Network.requestWillBeSent" && event.params.request.url.includes("/_zp/navigation/")).map(event => ({ frameId: event.params.frameId, type: event.params.type, url: event.params.request.url })), frames: cdp.events.filter(event => event.method === "Page.frameNavigated").slice(-6).map(event => event.params.frame) }));
  assert.deepEqual(result.cases.filter(entry => !entry.pass), []);
  await delay(250);
  const gatewayOrigin = `http://127.0.0.1:${gateway.server.address().port}`;
  const sealedPath = /^\/_zp\/(?:beacon|form|ping|download|navigation)\/[0-9a-f]{48}\/[^/]+$/;
  const sealedCaptures = gateway.captures.filter(capture => /-(?:fetch)$/.test(capture.kind));
  assert.ok(sealedCaptures.length >= 16, `sealed route fixture observed ${sealedCaptures.length}: ${sealedCaptures.map(capture => capture.kind).join(",")}; requests=${cdp.events.filter(event => event.method === "Network.requestWillBeSent").map(event => event.params.request.url).filter(value => value.includes("/_zp/download/")).join(",")}`);
  assert.ok(sealedCaptures.every(capture => sealedPath.test(capture.path) && /^[0-9a-f]{48}$/.test(capture.operation) && typeof capture.token === "string" && capture.token !== ""), "every egress must use an opaque operation-bound route");
  assert.ok(sealedCaptures.every(capture => !JSON.stringify(capture).includes(target.origin)), "sealed captures must not expose target URLs");

  const beacons = gateway.captures.filter(capture => capture.kind === "beacon-fetch");
  assert.equal(beacons.length, 5, "each accepted beacon BodyInit must reach the sealed native beacon route");
  assert.ok(beacons.some(capture => capture.body === "q=a+b"), "URLSearchParams beacon must preserve native request encoding");
  assert.ok(beacons.some(capture => Buffer.from(capture.body).equals(Buffer.from([7, 8]))), "binary beacon must preserve body bytes");
  assert.ok(beacons.some(capture => capture.body === "blob-body" && /^text\/plain/i.test(capture.content_type)), "Blob beacon must preserve body and MIME type");
  assert.ok(beacons.some(capture => capture.body.includes("form") && capture.body.includes("body") && /^multipart\/form-data/i.test(capture.content_type)), "FormData beacon must preserve native multipart body");

  const formFetches = gateway.captures.filter(capture => capture.kind === "form-fetch");
  assert.equal(formFetches.length, 6, "only uncancelled, successfully sealed forms may navigate");
  assert.ok(formFetches.some(capture => capture.method === "GET" && capture.body === ""), "GET forms must submit an empty body through sealed navigation");
  assert.ok(formFetches.some(capture => capture.method === "GET" && capture.search === "?q=hello+world"), "GET form controls must replace the action query through the sealed route");
  assert.ok(formFetches.some(capture => capture.method === "POST" && /^application\/x-www-form-urlencoded/i.test(capture.content_type) && capture.body === "a=one&go=yes"), "requestSubmit POST must retain urlencoded body");
  assert.ok(formFetches.some(capture => capture.method === "POST" && /^text\/plain/i.test(capture.content_type) && capture.body.includes("note=user")), "user POST submit must retain text/plain encoding");
  assert.ok(formFetches.some(capture => /^multipart\/form-data/i.test(capture.content_type) && capture.body.includes("file-body") && capture.body.includes('filename="résumé.txt"') && capture.body.includes('name="augmented"') && capture.body.includes("yes") && capture.body.includes('name="send"') && capture.body.includes("go")), "multipart forms preserve files, submitter fields, and formdata-event mutations");
  assert.ok(formFetches.some(capture => capture.method === "POST" && capture.body.includes("window=capture")), "window-capture stopPropagation cannot bypass form sealing");
  assert.ok(formFetches.some(capture => capture.method === "POST" && capture.body.includes("race=initial")), "action/formaction mutation race must remain on a sealed form route");

  const pings = gateway.captures.filter(capture => capture.kind === "ping-fetch");
  assert.equal(pings.length, 1, "only the uncancelled hyperlink activation may issue a ping");
  assert.ok(pings.every(capture => capture.method === "POST" && capture.body === "PING" && /^text\/ping/i.test(capture.content_type)), "anchor pings retain the native POST body and MIME shape");
  assert.ok(pings.every(capture => capture.origin === "" && capture.referer === ""), `native ping admission must omit Origin and Referer: ${JSON.stringify(pings)}`);
  assert.ok(pings.every(capture => capture.ping_from.startsWith(`${new URL(gatewayOrigin).origin}/`) && capture.ping_to.startsWith(`${new URL(gatewayOrigin).origin}/_zp/navigation/`)), `native ping headers must expose only sealed gateway URLs: ${JSON.stringify(pings)}`);

  const navigations = gateway.captures.filter(capture => capture.kind === "navigation-fetch");
  assert.equal(navigations.length, 3, "light-DOM, ping-destination, and closed-shadow activations use sealed routes while raced and area activations are blocked");
  assert.ok(navigations.every(capture => capture.method === "GET"), "navigation activations must use sealed native GET routes");

  const downloads = gateway.captures.filter(capture => capture.kind === "download-fetch");
  assert.equal(downloads.length, 2, "later defaultPrevented must cancel a sealed download while window capture stopPropagation cannot bypass one");
  assert.ok(downloads.every(capture => capture.method === "GET"), "downloads must use sealed native GET routes");

  const directTargetURLs = cdp.events.filter(event => event.method === "Network.requestWillBeSent").map(event => event.params.request.url).filter(value => new URL(value).origin === target.origin);
  assert.deepEqual(directTargetURLs, [], `browser direct target egress: ${JSON.stringify(directTargetURLs)}`);
  assert.deepEqual(target.requests, [], `target server direct requests: ${JSON.stringify(target.requests)}`);
  const privateURLs = cdp.events.filter(event => event.method === "Network.requestWillBeSent").map(event => event.params.request.url).filter(value => new URL(value).origin === `http://127.0.0.1:${gateway.server.address().port}` && sealedPath.test(new URL(value).pathname));
  for (const kind of ["navigation", "beacon", "form", "ping", "download"]) {
    assert.ok(privateURLs.some(value => new URL(value).pathname.startsWith(`/_zp/${kind}/`)), `${kind} must use a sealed private path`);
  }
  const downloadResponse = cdp.events.filter(event => event.method === "Network.responseReceived").map(event => event.params.response).find(response => new URL(response.url).pathname.startsWith("/_zp/download/"));
  assert.match(downloadResponse?.headers?.["content-disposition"] ?? downloadResponse?.headers?.["Content-Disposition"] ?? "", /^attachment;/i, "private download route must return attachment disposition");
});
