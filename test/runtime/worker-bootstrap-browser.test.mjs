import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DISABLED_CAPABILITY_METHODS } from "../../web/generated/emerging-network-capabilities.mjs";
import { DISABLED_NETWORK_GLOBALS } from "../../web/generated/owned-globals.mjs";

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
  if (file.endsWith(".html")) return "text/html;charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript;charset=utf-8";
  if (file.endsWith(".json")) return "application/json;charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}
function closeServer(server) {
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(resolve));
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
  await cdp.call("Page.enable");
  await cdp.call("Log.enable");
  return cdp;
}

async function waitForResult(cdp, requests) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await cdp.call("Runtime.evaluate", { expression: "globalThis.__workerBootstrapResult ?? null", returnByValue: true });
    if (value.result.value) return value.result.value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const diagnostic = await cdp.call("Runtime.evaluate", { expression: "({href:location.href,html:document.documentElement?.outerHTML,readyState:document.readyState,resources:performance.getEntriesByType('resource').map(({name})=>name)})", returnByValue: true });
  throw new Error(`worker bootstrap oracle timed out: ${JSON.stringify({ page: diagnostic.result.value, requests, events: cdp.events })}`);
}

function controlledWorkerSource(type, abiIdentifier, targetURL) {
  const rootKind = `${type}-root`;
  const dynamicKind = `${type}-dynamic`;
  const timerKind = `${type}-dynamic-timer`;
  const timerSource = `postMessage({kind:${JSON.stringify(timerKind)},value:location.href})`;
  return `
const __zpRuntime = globalThis[${JSON.stringify(abiIdentifier)}];
const __zpScope = __zpRuntime.scope;
__zpScope.postMessage({ kind: ${JSON.stringify(rootKind)} });
__zpScope.onmessage = event => __zpScope.postMessage({ echo: event.data });
void (async () => {
  const targetURL = ${JSON.stringify(targetURL)};
  const indirectEval = __zpScope.eval;
  const nonString = Object.freeze({ sentinel: true });
  const evalValues = [
    indirectEval("location.href"),
    (0, indirectEval)("location.href"),
    indirectEval?.("location.href"),
    indirectEval.call(null, "location.href"),
    indirectEval.apply(undefined, ["location.href"]),
    Reflect.apply(indirectEval, undefined, ["location.href"]),
  ];
  const families = [
    ["Function", __zpScope.Function, "return location.href"],
    ["AsyncFunction", Object.getPrototypeOf(async function () {}).constructor, "return location.href"],
    ["GeneratorFunction", Object.getPrototypeOf(function* () {}).constructor, "yield location.href"],
    ["AsyncGeneratorFunction", Object.getPrototypeOf(async function* () {}).constructor, "yield location.href"],
  ];
  const familyResults = [];
  for (const [name, facade, body] of families) {
    const called = Reflect.apply(facade, { ignored: true }, [body]);
    const constructed = Reflect.construct(facade, [body]);
    const bound = facade.bind({ ignored: true }, body)();
    function CustomNewTarget() {}
    const customPrototype = Object.create(null);
    CustomNewTarget.prototype = customPrototype;
    const custom = Reflect.construct(facade, [body], CustomNewTarget);
    let values;
    if (name === "Function") {
      values = [called(), constructed(), bound(), custom()];
    } else if (name === "AsyncFunction") {
      values = await Promise.all([called(), constructed(), bound(), custom()]);
    } else if (name === "GeneratorFunction") {
      values = [
        called().next().value,
        constructed().next().value,
        bound().next().value,
        custom().next().value,
      ];
    } else {
      values = [
        (await called().next()).value,
        (await constructed().next()).value,
        (await bound().next()).value,
        (await custom().next()).value,
      ];
    }
    familyResults.push({
      backReference: facade.prototype.constructor === facade,
      boundInstance: bound instanceof facade,
      calledInstance: called instanceof facade,
      constructedInstance: constructed instanceof facade,
      customInstance: custom instanceof CustomNewTarget,
      customPrototype: Object.getPrototypeOf(custom) === customPrototype,
      constructorConstructor: facade.constructor === __zpScope.Function,
      length: facade.length,
      name: facade.name,
      reflectedNative: Function.prototype.toString.call(facade).includes("[native code]"),
      values,
    });
  }
  const disabledNetwork = {};
  for (const name of ${JSON.stringify(DISABLED_NETWORK_GLOBALS)}) {
    const facade = __zpScope[name];
    if (typeof facade !== "function") {
      disabledNetwork[name] = { present: false };
      continue;
    }
    const copied = facade;
    let callError;
    let constructError;
    try { Reflect.apply(copied, undefined, []); }
    catch (error) { callError = { message: error.message, name: error.name }; }
    try { Reflect.construct(copied, []); }
    catch (error) { constructError = { message: error.message, name: error.name }; }
    const scopeDescriptor = Object.getOwnPropertyDescriptor(__zpScope, name);
    const globalDescriptor = Object.getOwnPropertyDescriptor(__zpScope.globalThis, name);
    disabledNetwork[name] = {
      backReference: facade.prototype?.constructor === facade,
      callError,
      constructError,
      copied: copied === facade,
      globalIdentity: __zpScope.globalThis[name] === facade
        && __zpScope.self[name] === facade,
      globalProtected: globalDescriptor?.configurable === false
        && globalDescriptor?.writable === false
        && globalDescriptor?.value === facade,
      length: facade.length,
      name: facade.name,
      present: true,
      reflectedNative: Function.prototype.toString.call(facade).includes("[native code]"),
      scopeProtected: scopeDescriptor?.configurable === false
        && scopeDescriptor?.writable === false
        && scopeDescriptor?.value === facade,
    };
  }
  const storageValue = ${JSON.stringify(type)};
  const databaseName = \`zp-worker-storage-\${storageValue}\`;
  const database = await new Promise((resolve, reject) => {
    const opening = __zpScope.indexedDB.open(databaseName, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore("values");
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => resolve(opening.result);
  });
  const transaction = database.transaction("values", "readwrite");
  const valueRequest = transaction.objectStore("values").put(storageValue, "value");
  await new Promise((resolve, reject) => {
    valueRequest.onerror = () => reject(valueRequest.error);
    transaction.onabort = () => reject(transaction.error);
    transaction.oncomplete = resolve;
  });
  database.close();
  const cacheName = \`zp-worker-storage-\${storageValue}\`;
  const cacheRequest = new Request(\`\${targetURL}?worker-storage=\${storageValue}\`);
  const cache = await __zpScope.caches.open(cacheName);
  await cache.put(cacheRequest, new Response(storageValue));
  const cachedResponse = await __zpScope.caches.match(cacheRequest);
  const cachedValue = await cachedResponse.text();
  const publicCacheNames = await __zpScope.caches.keys();
  let reservedCacheBlocked = false;
  try { await __zpScope.caches.open("__zeroproxy_internal_probe"); }
  catch (error) { reservedCacheBlocked = error.name === "SecurityError"; }
  await __zpScope.caches.delete(cacheName);
  const storage = {
    cacheStorage: cachedValue === storageValue && publicCacheNames.includes(cacheName),
    cacheStorageBrand: __zpScope.caches instanceof CacheStorage,
    indexedDB: typeof __zpScope.indexedDB.open === "function",
    localStorageUnavailable: __zpScope.localStorage === undefined,
    reservedCacheBlocked,
    sessionStorageUnavailable: __zpScope.sessionStorage === undefined,
  };
  const closure = Object.freeze({ retained: true });
  const functionTimerRetained = await new Promise(resolve => {
    __zpScope.setTimeout(value => resolve(value === closure), 0, closure);
  });
  __zpScope.postMessage({
    kind: ${JSON.stringify(dynamicKind)},
    evalIdentity: __zpScope.globalThis.eval === indirectEval
      && __zpScope.self.eval === indirectEval,
    evalName: indirectEval.name,
    evalNonString: indirectEval(nonString) === nonString,
    evalReflectedNative: Function.prototype.toString.call(indirectEval).includes("[native code]"),
    evalThis: indirectEval("this") === __zpScope.globalThis,
    evalValues,
    disabledNetwork,
    dynamicPaths: {
      constructorConstructor: __zpScope.Function.constructor(
        "return location.href",
      )() === targetURL,
      global: indirectEval("Function('return location.href')()") === targetURL,
      sloppyThis: __zpScope.Function("return this")() === __zpScope.globalThis,
      strictThis: __zpScope.Function("'use strict';return this")() === undefined,
    },
    familyResults,
    functionTimerRetained,
    storage,
    targetURL,
  });
  __zpScope.setTimeout(${JSON.stringify(timerSource)}, 0);
})().catch(error => {
  __zpScope.postMessage({
    kind: ${JSON.stringify(dynamicKind)},
    error: \`\${error.name}:\${error.message}\`,
  });
});
${type === "module" ? "export {};" : ""}
`;
}

async function startServer() {
  const version = JSON.parse(await readFile(path.join(dist, "_zp/version.json"), "utf8"));
  const planWorker = (await readFile(path.join(root, "test/browser/worker-bootstrap-plan-sw.js"), "utf8"))
    .replace("__BOOTSTRAP_MODULE_URL__", JSON.stringify(version.selectors["worker-bootstrap.mjs"]))
    .replace("__BOOTSTRAP_CLASSIC_URL__", JSON.stringify(version.selectors["worker-bootstrap-classic.js"]));
  const oracle = (await readFile(
    path.join(root, "test/browser/worker-bootstrap-oracle.html"),
    "utf8",
  )).replace(
    "__DISABLED_NETWORK_GLOBALS__",
    JSON.stringify(DISABLED_NETWORK_GLOBALS),
  ).replace(
    "__DISABLED_CAPABILITY_METHODS__",
    JSON.stringify(DISABLED_CAPABILITY_METHODS),
  );
  const files = Object.freeze({
    "/worker-bootstrap-browser-bootstrap.html": await readFile(path.join(root, "test/browser/worker-bootstrap-browser-bootstrap.html")),
    "/worker-bootstrap-oracle.html": Buffer.from(oracle),
    "/worker-bootstrap-plan-sw.js": Buffer.from(planWorker),
  });
  const requests = [];
  const server = http.createServer((request, response) => void (async () => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const url = new URL(request.url, origin);
      requests.push(url.pathname);
      if (files[url.pathname]) {
        response.writeHead(200, { "Content-Type": contentType(url.pathname), "Cache-Control": "no-store", "Service-Worker-Allowed": "/" }).end(files[url.pathname]);
        return;
      }
      if (
        url.pathname === "/controlled-worker-classic.js"
        || url.pathname === "/controlled-worker-module.mjs"
      ) {
        const abiIdentifier = url.searchParams.get("abi");
        if (!/^__zp_abi_[0-9a-f]{48}$/u.test(abiIdentifier ?? "")) {
          response.writeHead(400, { "Content-Type": "text/plain" }).end("invalid abi");
          return;
        }
        const type = url.pathname.endsWith(".mjs") ? "module" : "classic";
        const targetURL = `${origin}/target-worker-${type}.js`;
        response.writeHead(200, { "Content-Type": "text/javascript" }).end(
          controlledWorkerSource(type, abiIdentifier, targetURL),
        );
        return;
      }
      if (url.pathname === "/controlled-shared-worker-classic.js") {
        response.writeHead(200, { "Content-Type": "text/javascript" }).end("onconnect=e=>{const p=e.ports[0];p.start();p.postMessage({kind:'shared-classic-root'});p.onmessage=e=>p.postMessage({echo:e.data})}");
        return;
      }
      if (/^\/controlled-shared-worker-isolated-[ab]\.js$/u.test(url.pathname)) {
        const identity = url.pathname.includes("-a.") ? "a" : "b";
        response.writeHead(200, { "Content-Type": "text/javascript" }).end(`onconnect=e=>{const p=e.ports[0];p.start();p.postMessage({kind:'shared-isolated-${identity}-root'})}`);
        return;
      }
      if (url.pathname === "/controlled-shared-worker-module.mjs") {
        response.writeHead(200, { "Content-Type": "text/javascript" }).end("onconnect=e=>{const p=e.ports[0];p.start();p.postMessage({kind:'shared-module-root'});p.onmessage=e=>p.postMessage({echo:e.data})};export {};");
        return;
      }
      if (url.pathname === "/controlled-worklet-module.mjs") {
        response.writeHead(200, { "Content-Type": "text/javascript" }).end("class Probe extends AudioWorkletProcessor { process() { return false; } } registerProcessor('zp-probe', Probe);");
        return;
      }
      if (/^\/target-shared-worker-isolated-[ab]\.js$/u.test(url.pathname) || /^\/target-(?:shared-)?worker-(?:classic|module)\.js$/.test(url.pathname) || url.pathname === "/target-worklet-module.js") {
        response.writeHead(500, { "Content-Type": "text/plain" }).end("direct target request");
        return;
      }
      const file = path.resolve(dist, `.${decodeURIComponent(url.pathname)}`);
      if (!file.startsWith(`${dist}${path.sep}`)) throw new Error("invalid asset path");
      response.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" }).end(await readFile(file));
    } catch {
      if (!response.headersSent) response.writeHead(404, { "Content-Type": "text/plain" });
      if (!response.writableEnded) response.end("missing");
    }
  })());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, requests, version };
}

test("Worker, SharedWorker, blob/data, and worklet facades use sealed bootstrap plans", { timeout: 45_000 }, async t => {
  const chrome = chromiumPath();
  assert.ok(chrome, "supported Chromium executable is required");
  const gateway = await startServer();
  const address = gateway.server.address();
  const userData = await mkdtemp(path.join(os.tmpdir(), "zeroproxy-worker-bootstrap-"));
  const udpSocket = dgram.createSocket("udp4");
  let udpPackets = 0;
  udpSocket.on("message", () => { udpPackets += 1; });
  await new Promise((resolve, reject) => {
    udpSocket.once("error", reject);
    udpSocket.bind(0, "127.0.0.1", resolve);
  });
  t.after(() => udpSocket.close());
  const udpPort = udpSocket.address().port;
  const netLog = path.join(userData, "network-log.json");
  const browser = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", `--log-net-log=${netLog}`, "--net-log-capture-mode=IncludeSensitive", "--remote-debugging-port=0", `--user-data-dir=${userData}`, "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
  const browserExit = new Promise(resolve => browser.once("exit", resolve));
  t.after(async () => {
    browser.kill("SIGKILL");
    await rm(userData, { force: true, recursive: true });
    await closeServer(gateway.server);
  });
  let debugPort;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const active = (await readFile(path.join(userData, "DevToolsActivePort"), "utf8")).trim().split("\n");
      debugPort = Number(active[0]);
      if (Number.isInteger(debugPort) && debugPort > 0) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(debugPort, "Chrome debugging endpoint unavailable");
  const cdp = await openTarget(debugPort, `http://127.0.0.1:${address.port}/worker-bootstrap-browser-bootstrap.html?udp=${udpPort}`);
  t.after(() => cdp.close());
  const result = await waitForResult(cdp, gateway.requests);
  assert.equal(result.error, undefined, JSON.stringify({ result, requests: gateway.requests, workerEvents: cdp.events.filter(event => event.method === "Runtime.exceptionThrown").map(event => ({ description: event.params?.exceptionDetails?.exception?.description, text: event.params?.exceptionDetails?.text, url: event.params?.exceptionDetails?.url })) }));
  const capabilityInventory = JSON.parse(await readFile(
    path.join(root, "protocol/emerging-network-capabilities.json"),
    "utf8",
  ));
  const expectedCapabilityPresence = new Map(
    capabilityInventory.capabilities.map(capability => [
      capability.id,
      capability.native_presence.chromium,
    ]),
  );
  for (const [realmName, observations] of Object.entries({
    fresh: result.realtime.fresh,
    main: result.realtime.main,
    pristine: result.realtime.pristine,
  })) {
    assert.deepEqual(Object.keys(observations), DISABLED_NETWORK_GLOBALS);
    assert.equal(observations.RTCPeerConnection?.present, true);
    for (const [name, observation] of Object.entries(observations)) {
      if (!observation.present) continue;
      assert.equal(observation.backReference, true, `${realmName} ${name} prototype escape`);
      assert.equal(observation.copied, true, `${realmName} ${name} copied constructor drift`);
      assert.equal(observation.globalProtected, true, `${realmName} ${name} global descriptor drift`);
      assert.equal(
        observation.globalConfigurable,
        realmName !== "main",
        `${realmName} ${name} WindowProxy descriptor shape drift`,
      );
      assert.equal(observation.prototypeProtected, true, `${realmName} ${name} prototype descriptor drift`);
      assert.equal(observation.reflectedNative, true, `${realmName} ${name} reflection drift`);
      assert.deepEqual(observation.callError, observation.constructError);
      assert.equal(observation.callError?.name, "NotSupportedError");
      assert.match(
        observation.callError?.message ?? "",
        / is disabled by ZeroProxy policy$/u,
      );
      assert.equal(Number.isInteger(observation.length), true);
    }
    assert.deepEqual(observations.RTCPeerConnection.callError, {
      message: "RTCPeerConnection is disabled by ZeroProxy policy",
      name: "NotSupportedError",
    });
  }
  for (const [realmName, observations] of Object.entries(
    result.realtime.capabilityMethods,
  )) {
    assert.deepEqual(
      Object.keys(observations),
      DISABLED_CAPABILITY_METHODS.map(definition => definition.id),
    );
    for (const definition of DISABLED_CAPABILITY_METHODS) {
      const observation = observations[definition.id];
      assert.equal(
        observation.present,
        expectedCapabilityPresence.get(definition.id),
        `${realmName} ${definition.id} availability drift`,
      );
      if (!observation.present) continue;
      assert.deepEqual(observation.callError, {
        message: `${definition.label} is disabled by ZeroProxy policy`,
        name: "NotSupportedError",
      });
      assert.equal(observation.protected, true, `${realmName} ${definition.id} descriptor escape`);
      assert.equal(Number.isInteger(observation.length), true);
      if (realmName === "main") {
        assert.equal(observation.reflectedNative, true, `${definition.id} reflection drift`);
      }
    }
  }
  assert.deepEqual(result.realtime.iceProbe, {
    message: "RTCPeerConnection is disabled by ZeroProxy policy",
    name: "NotSupportedError",
  });
  assert.equal(result.classic.identity, true);
  assert.equal(result.module.identity, true);
  assert.equal(result.classic.ready.kind, "classic-root");
  assert.equal(result.module.ready.kind, "module-root");
  assert.equal(result.classic.echo.echo, "roundtrip-classic");
  assert.equal(result.module.echo.echo, "roundtrip-module");
  for (const type of ["classic", "module"]) {
    const workerResult = result[type];
    const expectedTarget = `http://127.0.0.1:${address.port}/target-worker-${type}.js`;
    assert.equal(workerResult.dynamic.error, undefined);
    assert.deepEqual(workerResult.dynamic.dynamicPaths, {
      constructorConstructor: true,
      global: true,
      sloppyThis: true,
      strictThis: true,
    });
    assert.deepEqual(
      Object.keys(workerResult.dynamic.disabledNetwork),
      DISABLED_NETWORK_GLOBALS,
    );
    for (const [name, observation] of Object.entries(workerResult.dynamic.disabledNetwork)) {
      if (!observation.present) continue;
      assert.equal(observation.backReference, true, `${type} ${name} prototype escape`);
      assert.equal(observation.copied, true, `${type} ${name} copied constructor drift`);
      assert.equal(observation.globalIdentity, true, `${type} ${name} global identity drift`);
      assert.equal(observation.globalProtected, true, `${type} ${name} global descriptor drift`);
      assert.equal(observation.reflectedNative, true, `${type} ${name} reflection drift`);
      assert.equal(observation.scopeProtected, true, `${type} ${name} scope descriptor drift`);
      assert.deepEqual(observation.callError, observation.constructError);
      assert.equal(observation.callError?.name, "NotSupportedError");
      assert.match(
        observation.callError?.message ?? "",
        / is disabled by ZeroProxy policy$/u,
      );
      assert.equal(Number.isInteger(observation.length), true);
    }
    assert.equal(workerResult.dynamic.evalIdentity, true);
    assert.equal(workerResult.dynamic.evalName, "eval");
    assert.equal(workerResult.dynamic.evalNonString, true);
    assert.equal(workerResult.dynamic.evalReflectedNative, true);
    assert.equal(workerResult.dynamic.evalThis, true);
    assert.deepEqual(workerResult.dynamic.evalValues, Array(6).fill(expectedTarget));
    assert.equal(workerResult.dynamic.functionTimerRetained, true);
    assert.deepEqual(workerResult.dynamic.storage, {
      cacheStorage: true,
      cacheStorageBrand: true,
      indexedDB: true,
      localStorageUnavailable: true,
      reservedCacheBlocked: true,
      sessionStorageUnavailable: true,
    });
    assert.equal(workerResult.dynamic.targetURL, expectedTarget);
    assert.deepEqual(
      workerResult.dynamic.familyResults,
      ["Function", "AsyncFunction", "GeneratorFunction", "AsyncGeneratorFunction"]
        .map(name => ({
          backReference: true,
          boundInstance: true,
          calledInstance: true,
          constructedInstance: true,
          customInstance: true,
          customPrototype: true,
          constructorConstructor: true,
          length: 1,
          name,
          reflectedNative: true,
          values: Array(4).fill(expectedTarget),
        })),
    );
    assert.deepEqual(workerResult.timer, {
      kind: `${type}-dynamic-timer`,
      value: expectedTarget,
    });
  }
  assert.deepEqual(result.data, { kind: "data-root" });
  assert.deepEqual(result.dataCharset, { kind: "data-charset-root", value: "é" });
  assert.deepEqual(result.dataInvalidCharset, { kind: "data-invalid-charset-root", value: "fallback" });
  assert.deepEqual(result.dataFragment, {
    href: "data:text/javascript,postMessage({kind%3A'data-fragment-root'%2Chref%3Alocation.href})#ignored-source",
    kind: "data-fragment-root",
  });
  assert.deepEqual(result.dataPercent, { kind: "data-percent-root", value: "%ZZ" });
  assert.deepEqual(result.dataPlain, { kind: "data-plain-root" });
  assert.deepEqual(result.blob, { kind: "blob-root" });
  assert.deepEqual(result.blobPlain, { kind: "blob-plain-root" });
  const asyncLoadError = {
    boundary: "async",
    bubbles: false,
    cancelable: true,
    errorType: "undefined",
    filenameType: "undefined",
    interface: "Event",
    isErrorEvent: false,
    messageType: "undefined",
    type: "error",
  };
  assert.deepEqual(result.malformedData, asyncLoadError);
  assert.deepEqual(result.modulePlainData, asyncLoadError);
  assert.deepEqual(result.modulePlainBlob, asyncLoadError);
  assert.deepEqual(result.subclassRejected, { boundary: "async", overrideCalls: 0 });
  assert.equal(result.sharedClassic.identity, true);
  assert.equal(result.sharedModule.identity, true);
  assert.equal(result.sharedClassic.ready.kind, "shared-classic-root");
  assert.equal(result.sharedModule.ready.kind, "shared-module-root");
  assert.equal(result.sharedClassic.reused.kind, "shared-classic-root");
  assert.equal(result.sharedModule.reused.kind, "shared-module-root");
  assert.equal(result.sharedClassic.restarted.kind, "shared-classic-root");
  assert.equal(result.sharedModule.restarted.kind, "shared-module-root");
  assert.equal(result.sharedClassic.echo.echo, "roundtrip-classic");
  assert.equal(result.sharedModule.echo.echo, "roundtrip-module");
  assert.deepEqual(result.sharedIsolation, {
    first: "shared-isolated-a-root",
    identity: true,
    second: "shared-isolated-b-root",
  });
  for (const target of [
    "/target-shared-worker-classic.js",
    "/target-shared-worker-module.js",
    "/target-shared-worker-isolated-a.js",
    "/target-shared-worker-isolated-b.js",
  ]) {
    assert.equal(
      result.plans.filter(plan => new URL(plan.target_url).pathname === target).length,
      target.includes("isolated") ? 1 : 2,
      `SharedWorker host allocation identity drift: ${target}`,
    );
  }
  assert.equal(result.controlHidden, true);
  assert.deepEqual(result.rejected, [true, true]);
  const sourceKinds = new Set(result.plans.map(plan => plan.source_kind));
  for (const sourceKind of ["ClassicWorker", "ModuleWorker", "SharedClassicWorker", "SharedModuleWorker"]) {
    assert.ok(sourceKinds.has(sourceKind), `missing ${sourceKind} plan`);
  }
  assert.ok(result.plans.every(plan => /^__zp_abi_[0-9a-f]{48}$/.test(plan.worker_abi_identifier)), "each allocation must have a per-construction ABI identifier");
  assert.equal(
    new Set(result.plans.map((plan) => plan.worker_abi_identifier)).size,
    result.plans.length,
    "each worker realm must receive one distinct ABI identifier",
  );
  const executablePlans = result.plans.filter(plan => plan.executable_source);
  assert.deepEqual(executablePlans.map(plan => plan.executable_source.kind).sort(), [
    "blob",
    "blob",
    "blob",
    "data",
    "data",
    "data",
    "data",
    "data",
    "data",
    "data",
  ]);
  assert.ok(executablePlans.every(plan => plan.executable_source.bytes && typeof plan.executable_source.media_type === "string"), "blob/data allocations must carry retained executable bytes and MIME");
  const workerPlans = result.plans.filter(plan => ["ClassicWorker", "ModuleWorker", "SharedClassicWorker", "SharedModuleWorker"].includes(plan.source_kind));
  assert.ok(workerPlans.length > 0, "worker plan coverage must not be empty");
  assert.ok(workerPlans.every(plan => plan.options.credentials === "omit" || plan.options.credentials === "same-origin"), "worker option defaults must remain native-compatible");
  assert.equal(result.worklet.supported, true, "certified Chrome must execute the AudioWorklet module oracle");
  assert.ok(sourceKinds.has("WorkletModule"), "worklet must request a dedicated module plan");
  assert.ok(gateway.requests.includes("/controlled-worklet-module.mjs"), "native addModule must receive the sealed worklet module URL");
  for (const target of ["/target-worker-classic.js", "/target-worker-module.js", "/target-shared-worker-classic.js", "/target-shared-worker-module.js", "/target-shared-worker-isolated-a.js", "/target-shared-worker-isolated-b.js", "/target-worklet-module.js"]) {
    assert.equal(gateway.requests.includes(target), false, `direct target request: ${target}`);
  }
  for (const selector of ["worker-bootstrap.mjs", "worker-bootstrap-classic.js"]) {
    const bootstrapPath = new URL(gateway.version.selectors[selector], `http://127.0.0.1:${address.port}`).pathname;
    assert.ok(gateway.requests.includes(bootstrapPath), `hashed trusted ${selector} was requested`);
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(udpPackets, 0, "disabled ICE must emit no UDP/STUN packets");
  cdp.close();
  browser.kill("SIGTERM");
  await Promise.race([
    browserExit,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("Chrome did not flush its network log")),
      5_000,
    )),
  ]);
  const networkLog = await readFile(netLog, "utf8");
  assert.equal(
    networkLog.includes("realtime-egress-probe.invalid"),
    false,
    "disabled ICE must emit no DNS request",
  );
  assert.equal(
    networkLog.includes("emerging-egress-probe.invalid"),
    false,
    "disabled emerging capabilities must emit no DNS request",
  );
});
