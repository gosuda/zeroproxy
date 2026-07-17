import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "../..");
const dist = path.join(root, "dist/web");
const fixtureDirectory = path.join(root, "test/browser");
const fixtures = new Map([
  ["/synthetic-origin-realm-oracle.html", "synthetic-origin-realm-oracle.html"],
  ["/synthetic-origin-realm-child.html", "synthetic-origin-realm-child.html"],
  ["/synthetic-origin-realm-popup.html", "synthetic-origin-realm-popup.html"],
  ["/synthetic-origin-realm-blank.html", "synthetic-origin-realm-blank.html"],
  ["/synthetic-origin-realm-sw.js", "synthetic-origin-realm-sw.js"],
]);
const pinnedFirefox = path.join(root, ".puppeteer-cache/firefox/mac_arm-stable_152.0.6/Firefox.app/Contents/MacOS/firefox");
const firefoxPath = process.env.ZP_FIREFOX_PATH ?? (existsSync(pinnedFirefox) ? pinnedFirefox : null);

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
  if (file.endsWith(".mjs") || file.endsWith(".js")) return "text/javascript;charset=utf-8";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function redirectPopup(state, request, response) {
  const plan = [
    { targetPath: "/popup", virtualOrigin: "https://alpha.example" },
    { targetPath: "/popup", virtualOrigin: "https://beta.example" },
    { targetPath: "/popup", virtualOrigin: "https://alpha.example" },
    { targetPath: "/popup-reloaded", virtualOrigin: "https://alpha.example" },
    { targetPath: "/popup", virtualOrigin: "https://beta.example" },
  ][state.popupSequence++] ?? { targetPath: "/popup", virtualOrigin: "https://beta.example" };
  const syntheticHost = plan.virtualOrigin === "https://alpha.example"
    ? "o-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.browse.realm.localhost"
    : "o-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.browse.realm.localhost";
  const port = new URL(`http://${request.headers.host}`).port;
  const parameters = new URLSearchParams({ parent_virtual: "https://alpha.example", target_path: plan.targetPath, virtual: plan.virtualOrigin });
  response.writeHead(302, {
    Location: `http://${syntheticHost}:${port}/synthetic-origin-realm-popup.html?${parameters}`,
  }).end();
}

async function serveRealmFixture(pathname, response) {
  const fixture = fixtures.get(pathname);
  const source = fixture ? path.join(fixtureDirectory, fixture) : path.resolve(dist, `.${pathname}`);
  if (!fixture && !source.startsWith(`${dist}${path.sep}`)) {
    response.writeHead(404).end("not found");
    return;
  }
  try {
    const body = await readFile(source);
    const headers = { "Cache-Control": "no-store", "Content-Type": contentType(source) };
    if (pathname === "/synthetic-origin-realm-sw.js") headers["Service-Worker-Allowed"] = "/";
    response.writeHead(200, headers).end(body);
  } catch {
    response.writeHead(404).end("not found");
  }
}

async function handleRealmFixture(state, request, response) {
  const pathname = decodeURIComponent(new URL(request.url, "http://fixture.realm.localhost").pathname);
  if (/^\/_zp\/navigation\/[0-9a-f]{48}\/[A-Za-z0-9_-]+$/u.test(pathname)) {
    redirectPopup(state, request, response);
    return;
  }
  if (pathname === "/cookie-request-after-write") {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain;charset=utf-8",
      "X-ZP-Redirected": "0",
      "X-ZP-Response-Type": "basic",
      "X-ZP-Target-URL": "https://alpha.example/cookie-request-after-write",
    }).end("cookie-sequenced");
    return;
  }
  await serveRealmFixture(pathname, response);
}

function fixtureServer() {
  const state = { popupSequence: 0 };
  const server = http.createServer((request, response) => {
    void handleRealmFixture(state, request, response);
  });
  server.realmState = state;
  return server;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}
async function waitForPopupSequence(server, expected, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (server.realmState.popupSequence === expected) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`popup route sequence remained ${server.realmState.popupSequence}; expected ${expected}`);
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
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
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

  close() { this.socket.close(); }
}

async function waitForFile(file, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { return await readFile(file, "utf8"); }
    catch { await new Promise(resolve => setTimeout(resolve, 25)); }
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

async function waitForOracle(cdp) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await cdp.call("Runtime.evaluate", {
      expression: "globalThis.__syntheticOriginRealmOracle ?? null",
      returnByValue: true,
    });
    if (response.result.value) return response.result.value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const diagnostic = await cdp.call("Runtime.evaluate", {
    expression: "({href:location.href,body:document.body?.innerText,oracle:globalThis.__syntheticOriginRealmOracle ?? null})",
    returnByValue: true,
  });
  throw new Error(`realm oracle timed out: ${JSON.stringify(diagnostic.result.value)}`);
}

const expectedChecks = [
  "mock-private-plan-map-origin",
  "partitioned-cookie-optimistic-identity",
  "request-after-document-cookie-commit",
  "rejected-cookie-reconciles-before-request",
  "same-synthetic-origin-dom-identity",
  "cross-synthetic-origin-native-sop",
  "same-origin-navigation-refreshes-held-facade",
  "same-to-cross-navigation-downgrades-stable-facade",
  "frame-targetorigin-translation",
  "postmessage-url-options-and-default-targetorigin",
  "message-event-origin-source-identity",
  "messagechannel-transfer-through-cross-realm-facade",
  "unknown-target-origin-rejected",
  "frame-parent-top-relationships",
  "same-and-cross-popup-relationships",
  "popup-focus-close",
  "aboutblank-and-srcdoc-inherit-contained-realm",
  "canonical-contained-window-accessors",
  "compiler-owned-globals-use-canonical-facades",
  "dynamic-srcdoc-blocks-uninstrumented-code",
  "sandbox-attribute-preserved-with-native-isolation",
  "stale-frame-route-generation-suppressed",
  "stale-frame-route-revoked",
  "named-popup-reuses-native-context",
  "noopener-popup-preserves-native-null-return",
];

test("synthetic-origin realm mapping preserves browser SOP while virtualizing mapped messages", { timeout: 45_000 }, async t => {
  const chrome = chromiumPath();
  assert.ok(chrome, "supported Chromium executable is required");
  const server = fixtureServer();
  const port = await listen(server);
  const profile = await mkdtemp(path.join(os.tmpdir(), "zeroproxy-synthetic-realm-"));
  let processHandle;
  let cdp;
  t.after(async () => {
    cdp?.close();
    processHandle?.kill("SIGKILL");
    await new Promise(resolve => server.close(resolve));
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
    "--host-resolver-rules=MAP *.realm.localhost 127.0.0.1",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: "ignore" });
  const [debugPort] = (await waitForFile(path.join(profile, "DevToolsActivePort"))).trim().split("\n");
  cdp = await openTarget(debugPort, `http://o-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.browse.realm.localhost:${port}/synthetic-origin-realm-oracle.html`);
  const oracle = await waitForOracle(cdp);
  await waitForPopupSequence(server, 5);
  const exceptions = cdp.events
    .filter(event => event.method === "Runtime.exceptionThrown")
    .map(event => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);
  const requests = cdp.events
    .filter(event => event.method === "Network.requestWillBeSent")
    .map(event => event.params.request.url);
  const loadingFailures = cdp.events
    .filter(event => event.method === "Network.loadingFailed")
    .map(event => ({ error: event.params.errorText, requestId: event.params.requestId, type: event.params.type }));
  const requestTrace = cdp.events
    .filter(event => event.method === "Network.requestWillBeSent")
    .map(event => ({ frameId: event.params.frameId, type: event.params.type, url: event.params.request.url }));
  const frameTree = await cdp.call("Page.getFrameTree");
  if (oracle.error) {
    t.diagnostic(JSON.stringify({ exceptions, frameTree: frameTree.frameTree, loadingFailures, oracle, requestTrace }, null, 2));
  }

  assert.equal(oracle.error, undefined, JSON.stringify(oracle));
  assert.equal(oracle.ok, true, JSON.stringify(oracle));
  assert.deepEqual(oracle.checks.map(check => check.id), expectedChecks);
  assert.deepEqual(oracle.checks.filter(check => !check.pass), []);
  assert.deepEqual(exceptions, []);
  assert.deepEqual(requests.filter(url => /^https:\/\/(?:alpha|beta|unmapped)\.example\b/u.test(url)), []);
});

test("contained realm membrane preserves native SOP and canonical facades in Firefox", {
  skip: firefoxPath ? false : "pinned Firefox unavailable",
  timeout: 45_000,
}, async () => {
  const server = fixtureServer();
  const port = await listen(server);
  const browser = await puppeteer.launch({
    browser: "firefox",
    executablePath: firefoxPath,
    headless: true,
    protocol: "webDriverBiDi",
  });
  const page = await browser.newPage();
  const requests = [];
  page.on("request", request => requests.push(request.url()));
  try {
    await page.goto(`http://o-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.browse.realm.localhost:${port}/synthetic-origin-realm-oracle.html`, { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.__syntheticOriginRealmOracle !== undefined, { timeout: 30_000 });
    const oracle = await page.evaluate(() => globalThis.__syntheticOriginRealmOracle);
    assert.equal(oracle.error, undefined, JSON.stringify(oracle));
    assert.equal(oracle.ok, true, JSON.stringify(oracle));
    assert.deepEqual(oracle.checks.map(check => check.id), expectedChecks);
    assert.deepEqual(oracle.checks.filter(check => !check.pass), []);
    await waitForPopupSequence(server, 5);
    assert.deepEqual(oracle.trace.filter(entry => entry?.stage === "window-error" || entry?.stage === "unhandledrejection"), []);
    assert.deepEqual(requests.filter(url => /^https:\/\/(?:alpha|beta|unmapped)\.example\b/u.test(url)), []);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
