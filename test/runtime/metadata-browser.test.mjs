import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runtimeBootstrapFixture } from "./runtime-bootstrap-fixture.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dist = path.join(root, "dist/web");
const bootstrapCapability = "R".repeat(32);
const bootstrapEntry = "E".repeat(32);
const bootstrapPayload = runtimeBootstrapFixture({
  capability: bootstrapCapability,
  entryID: bootstrapEntry,
  targetURL: "https://example.test/index.html",
  approvedPorts: [80, 443],
  referrerURL: "https://referrer.test/from",
});
const ledgerScriptSources = new Map([
  ["/ledger-sync.js", 'globalThis.parserLedgerOrder.push("sync");globalThis.parserSyncCurrentScript=document.currentScript?.id'],
  ["/ledger-defer.js", 'globalThis.parserLedgerOrder.push("defer");globalThis.parserDeferCurrentScript=document.currentScript?.id'],
  ["/ledger-module.js", 'globalThis.parserLedgerOrder.push("module");globalThis.parserModuleCurrentScript=document.currentScript'],
  ["/ledger-async.js", 'globalThis.parserLedgerOrder.push("async");globalThis.parserAsyncCurrentScript=document.currentScript?.id'],
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

function contentType(file) {
  if (file.endsWith(".html")) return "text/html;charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript;charset=utf-8";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

async function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      if (pathname.includes("projected.css") || pathname.includes("imported.css")) {
        const css = pathname.includes("projected.css") ? "#projected-css{outline-color:rgb(1 2 3)}" : "#projected-css{border-left-color:rgb(4 5 6)}";
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/css;charset=utf-8" }).end(css);
        return;
      }
      const ledgerSource = ledgerScriptSources.get(pathname);
      if (ledgerSource !== undefined) {
        if (pathname === "/ledger-async.js") await new Promise(resolve => setTimeout(resolve, 75));
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/javascript;charset=utf-8" }).end(ledgerSource);
        return;
      }
      if (pathname.startsWith("/_zp/navigation/")) {
        response.writeHead(204, { "Cache-Control": "no-store" }).end();
        return;
      }
      const file = path.resolve(dist, `.${pathname}`);
      if (!file.startsWith(`${dist}${path.sep}`)) throw new Error("invalid path");
      const body = await readFile(file);
      response.setHeader("Content-Type", contentType(file));
      if (pathname === "/metadata-oracle.html" || pathname === "/trusted-types-oracle.html") {
        const trustedTypes = pathname === "/trusted-types-oracle.html" ? `; require-trusted-types-for 'script'; trusted-types oracle zp-${"t".repeat(32)} 'allow-duplicates'` : "";
        response.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'self' 'nonce-internal-nonce' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; form-action 'self'; object-src 'none'; base-uri 'self'${trustedTypes}`);
      }
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function generateOracle(origin) {
  const version = JSON.parse(await readFile(path.join(dist, "_zp/version.json"), "utf8"));
  const asset = value => path.join(dist, value);
  const html = await import(`${pathToFileURL(asset(version.selectors["html_rewriter.js"]))}?fresh=${Date.now()}`);
  html.initSync({ module: await readFile(asset(version.selectors["html_rewriter.wasm"])) });
  const abi = "__zp_abi_222222222222222222222222222222222222222222222222";
  const context = JSON.stringify({ profile_id: "p", tab_id: "t", document_id: "d", virtual_origin: "https://example.test:443", virtual_site: "https://example.test", target_url: "https://example.test/index.html", effective_base_url: "https://example.test/index.html", referrer_url: "https://referrer.test/from", referrer_policy: "strict-origin-when-cross-origin", document_charset: "utf-8", target_csp: [], target_csp_report_only: [], relay_profile: "test-relay-profile", approved_target_ports: [80, 443], policy_version: 2 });
  const runtime = `${version.selectors["runtime-prelude.js"]}#abi=${abi}&url=https%3A%2F%2Fexample.test%2Findex.html&ports=80%2C443&strings=0&tt=zp-${"t".repeat(32)}&bootstrap=${bootstrapPayload}`;
  const allocateStaticRoute = (target, kind) => {
    const parsed = new URL(target);
    return parsed.hostname === "example.test" && ledgerScriptSources.has(parsed.pathname) ? parsed.pathname : `/_zp/p/${kind}/${encodeURIComponent(target)}`;
  };
  for (const fixture of ["metadata-oracle.html", "trusted-types-oracle.html"]) {
    try {
      const source = await readFile(path.join(root, "test/browser", fixture), "utf8");
      const output = html.rewrite_html(source, context, runtime, `${origin}/_zp/vbase/d/`, abi, "internal-nonce", allocateStaticRoute);
      await writeFile(path.join(dist, fixture), output);
    } catch (error) {
      throw new Error(`failed to generate ${fixture}: ${error?.message ?? error}`, { cause: error });
    }
  }
  const secrecyRuntime = runtime;
  const secrecySource = `<!doctype html><html><head></head><body><script>
    setTimeout(() => {
      const firstNeedle = ["boot", "strap="].join("");
      const secondNeedle = ["data-zp-cookie-", "bootstrap"].join("");
      const frame = document.createElement("iframe");
      document.body.append(frame);
      setTimeout(() => {
        const scriptSurfaces = root => [...root.querySelectorAll("script")].flatMap(script => [
          script.outerHTML,
          script.getAttribute("src") ?? "",
          script.src,
          JSON.stringify(script.dataset),
          String(Object.getOwnPropertyDescriptor(script, "src")?.value ?? ""),
        ]);
        let wrapperStack = "";
        try { Function("return 1")(); } catch (error) { wrapperStack = String(error?.stack ?? error); }
        const surfaces = [
          document.documentElement.outerHTML,
          ...scriptSurfaces(document),
          frame.contentDocument.documentElement.outerHTML,
          ...scriptSurfaces(frame.contentDocument),
          ...performance.getEntriesByType("resource").map(entry => entry.name),
        ];
        globalThis.__bootstrapSecrecyOracle = {
          wrapperStack,
          ok: surfaces.every(value => !value.includes(firstNeedle) && !value.includes(secondNeedle)),
          surfaces,
        };
      }, 0);
    }, 0);
  </script></body></html>`;
  const secrecyOutput = html.rewrite_html(secrecySource, context, secrecyRuntime, `${origin}/_zp/vbase/d/`, abi, "internal-nonce", (target, kind) => `/_zp/p/${kind}/${encodeURIComponent(target)}`);
  await writeFile(path.join(dist, "runtime-bootstrap-secrecy-oracle.html"), secrecyOutput);
  const attackerSource = `<!doctype html><html><head></head><body><script>globalThis.__runtimeLoadAttacker={html:document.documentElement.outerHTML,scripts:[...document.scripts].map(script=>script.outerHTML)}</script></body></html>`;
  for (const [fixture, runtimePath] of [
    ["runtime-missing-load-oracle.html", "/missing-runtime-prelude.js"],
    ["runtime-invalid-load-oracle.html", "/invalid-runtime-prelude.js"],
  ]) {
    const guardedRuntime = `${runtimePath}#abi=${abi}&url=https%3A%2F%2Fexample.test%2Findex.html&ports=80%2C443&strings=0&cookie=${"C".repeat(32)}&bootstrap=${bootstrapPayload}`;
    const guardedOutput = html.rewrite_html(attackerSource, context, guardedRuntime, `${origin}/_zp/vbase/d/`, abi, "internal-nonce", (target, kind) => `/_zp/p/${kind}/${encodeURIComponent(target)}`);
    await writeFile(path.join(dist, fixture), guardedOutput);
    if (fixture === "runtime-invalid-load-oracle.html") {
      const unrelatedFailure = guardedOutput.replace("</script><script nonce=", "</script><script src=\"/missing-unrelated.js\"></script><script nonce=");
      await writeFile(path.join(dist, "runtime-unrelated-error-oracle.html"), unrelatedFailure);
    }
  }
  await writeFile(path.join(dist, "invalid-runtime-prelude.js"), "const = invalid syntax");
  for (const fixture of ["runtime-atomic-failure-oracle.html", "runtime-atomic-metadata-failure-oracle.html", "runtime-early-failure-oracle.html", "runtime-guard-oracle.html", "native-markup-oracle.html"]) {
    await writeFile(path.join(dist, fixture), await readFile(path.join(root, "test/browser", fixture)));
  }
}

async function waitForFile(file, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { return await readFile(file, "utf8"); } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
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

async function openTarget(port, url) {
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" }).then(response => response.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.call("Runtime.enable");
  await cdp.call("Network.enable");
  await cdp.call("Debugger.enable");
  return cdp;
}

async function waitForGlobal(cdp, name) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await cdp.call("Runtime.evaluate", { expression: `globalThis[${JSON.stringify(name)}] ?? null`, returnByValue: true });
    if (response.result.value) return response.result.value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const exceptions = cdp.events.filter(event => event.method === "Runtime.exceptionThrown").map(event => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);
  const progress = await cdp.call("Runtime.evaluate", { expression: "({ href: location.href, progress: globalThis.__runtimeGuardProgress ?? null, ready: globalThis.__runtimeGuardOracle ?? null, text: document.body?.innerText })", returnByValue: true });
  const network = cdp.events.filter(event => event.method === "Network.loadingFailed" || event.method === "Network.responseReceived").map(event => ({ method: event.method, status: event.params.response?.status, url: event.params.response?.url, error: event.params.errorText }));
  throw new Error(`timed out waiting for ${name}: ${JSON.stringify({ exceptions, network, page: progress.result.value })}`);
}

async function waitForResult(cdp) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await cdp.call("Runtime.evaluate", { expression: `document.readyState === "complete" && globalThis.__metadataOracle ? ({oracle:globalThis.__metadataOracle,resources:performance.getEntriesByType("resource").map(entry=>entry.name)}) : null`, returnByValue: true });
    if (response.result.value) return response.result.value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const diagnostic = await cdp.call("Runtime.evaluate", { expression: `({href:location.href,readyState:document.readyState,title:document.title,body:document.body?.innerText,oracle:globalThis.__metadataOracle})`, returnByValue: true });
  const exceptions = cdp.events.filter(event => event.method === "Runtime.exceptionThrown").map(event => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);
  throw new Error(`metadata browser oracle timed out: ${JSON.stringify({ diagnostic: diagnostic.result.value, exceptions })}`);
}

async function waitForRuntimeLoadBlock(cdp) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await cdp.call("Runtime.evaluate", { expression: `document.body?.innerText?.includes("privacy runtime could not be loaded") ? ({ attacker: globalThis.__runtimeLoadAttacker ?? null, html: document.documentElement.outerHTML }) : null`, returnByValue: true });
    if (response.result.value) return response.result.value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("runtime load guard did not block the document");
}

test("runtime mediates metadata, selectors, scripts, cloning, and CSP without direct egress", { timeout: 30_000 }, async t => {
  const chrome = chromiumPath();
  assert.ok(chrome, "supported Chromium executable is required");
  const server = await startServer();
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const profile = await mkdtemp(path.join(os.tmpdir(), "zeroproxy-chrome-"));
  let processHandle;
  let cdp;
  t.after(async () => {
    cdp?.close();
    processHandle?.kill("SIGKILL");
    await Promise.all(["runtime-atomic-failure-oracle.html", "runtime-atomic-metadata-failure-oracle.html", "runtime-early-failure-oracle.html", "runtime-guard-oracle.html", "native-markup-oracle.html", "trusted-types-oracle.html"].map(file => rm(path.join(dist, file), { force: true })));
    await rm(path.join(dist, "runtime-bootstrap-secrecy-oracle.html"), { force: true });
    await Promise.all(["runtime-missing-load-oracle.html", "runtime-invalid-load-oracle.html", "runtime-unrelated-error-oracle.html", "invalid-runtime-prelude.js"].map(file => rm(path.join(dist, file), { force: true })));
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true });
    await rm(path.join(dist, "metadata-oracle.html"), { force: true });
  });
  await generateOracle(origin);
  processHandle = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const [port] = (await waitForFile(path.join(profile, "DevToolsActivePort"))).trim().split("\n");
  cdp = await openTarget(port, `${origin}/metadata-oracle.html`);
  const { oracle, resources } = await waitForResult(cdp);
  const exceptions = cdp.events.filter(event => event.method === "Runtime.exceptionThrown").map(event => JSON.stringify({ description: event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text, url: event.params.exceptionDetails.url, line: event.params.exceptionDetails.lineNumber, column: event.params.exceptionDetails.columnNumber, stack: event.params.exceptionDetails.stackTrace?.callFrames }));
  assert.deepEqual(oracle.checks.filter(check => !check.pass), []);
  assert.equal(oracle.passed, oracle.total);
  assert.equal(exceptions.length, 0, exceptions.join("\n"));
  const mappedScript = cdp.events.find(event => event.method === "Debugger.scriptParsed" && event.params.url === "https://example.test/index.html" && event.params.sourceMapURL?.startsWith("data:application/json;base64,"));
  assert.ok(mappedScript, "rewritten inline script must publish an inline source map");
  const sourceMap = JSON.parse(Buffer.from(mappedScript.params.sourceMapURL.split(",")[1], "base64").toString("utf8"));
  assert.deepEqual(sourceMap.sources, ["https://example.test/index.html"]);
  assert.equal(typeof sourceMap.sourcesContent?.[0], "string");
  assert.ok(sourceMap.mappings.length > 0);
  const authoredMappedScript = cdp.events.find(event => event.method === "Debugger.scriptParsed" && event.params.url === "authored-target.js" && event.params.sourceMapURL?.startsWith("data:application/json;base64,"));
  assert.ok(authoredMappedScript, "authored sourceURL must retain identity with a controlled inline map");
  const authoredMap = JSON.parse(Buffer.from(authoredMappedScript.params.sourceMapURL.split(",")[1], "base64").toString("utf8"));
  assert.equal(authoredMap.x_zeroproxy_original_source_mapping_url, "https://example.test/authored.map");
  const dynamicMappedScript = cdp.events.find(event => {
    if (event.method !== "Debugger.scriptParsed" || event.params.url !== "https://example.test/index.html" || !event.params.sourceMapURL?.startsWith("data:application/json;base64,")) return false;
    const map = JSON.parse(Buffer.from(event.params.sourceMapURL.split(",")[1], "base64").toString("utf8"));
    return map.sourcesContent?.[0]?.includes("dynamic-stack");
  });
  assert.ok(dynamicMappedScript, "dynamic inline script must publish a controlled source map");
  const mediatedMarkup = await waitForGlobal(cdp, "__markupOracle");
  const nativeMarkupCDP = await openTarget(port, `${origin}/native-markup-oracle.html`);
  const nativeMarkup = await waitForGlobal(nativeMarkupCDP, "__nativeMarkupOracle");
  nativeMarkupCDP.close();
  assert.deepEqual(mediatedMarkup, nativeMarkup);
  const trustedTypesCDP = await openTarget(port, `${origin}/trusted-types-oracle.html`);
  const trustedTypesOracle = await waitForGlobal(trustedTypesCDP, "__trustedTypesOracle");
  const trustedTypesRequests = trustedTypesCDP.events.filter(event => event.method === "Network.requestWillBeSent").map(event => event.params.request.url);
  trustedTypesCDP.close();
  assert.equal(trustedTypesOracle.ok, true, JSON.stringify(trustedTypesOracle));
  assert.deepEqual(trustedTypesRequests.filter(url => url.startsWith("https://example.test/")), []);
  const runtimeGuardCDP = await openTarget(port, `${origin}/runtime-guard-oracle.html`);
  const runtimeGuard = await waitForGlobal(runtimeGuardCDP, "__runtimeGuardOracle");
  const runtimeGuardRequests = runtimeGuardCDP.events.filter(event => event.method === "Network.requestWillBeSent").map(event => event.params.request.url);
  const runtimeGuardExceptions = runtimeGuardCDP.events.filter(event => event.method === "Runtime.exceptionThrown").map(event => event.params.exceptionDetails.text);
  runtimeGuardCDP.close();
  assert.equal(runtimeGuard.ok, true, JSON.stringify(runtimeGuard.tests.filter(entry => !entry.ok)));
  assert.deepEqual(runtimeGuardRequests.filter(url => url.startsWith("https://escape.example/")), []);
  assert.deepEqual(runtimeGuardExceptions, []);
  const bootstrapSecrecyCDP = await openTarget(port, `${origin}/runtime-bootstrap-secrecy-oracle.html`);
  const bootstrapSecrecy = await waitForGlobal(bootstrapSecrecyCDP, "__bootstrapSecrecyOracle");
  const bootstrapScriptMetadata = bootstrapSecrecyCDP.events
    .filter(event => event.method === "Debugger.scriptParsed")
    .flatMap(event => [event.params.url, event.params.sourceMapURL ?? ""]);
  bootstrapSecrecyCDP.close();
  const secrecySurfaces = [bootstrapSecrecy.wrapperStack, ...bootstrapSecrecy.surfaces, ...bootstrapScriptMetadata];
  assert.equal(bootstrapSecrecy.ok, true, JSON.stringify(secrecySurfaces));
  for (const secret of [bootstrapCapability, bootstrapEntry, bootstrapPayload]) {
    assert.equal(secrecySurfaces.some(value => String(value).includes(secret)), false, secret);
  }
  for (const fixture of ["runtime-missing-load-oracle.html", "runtime-invalid-load-oracle.html", "runtime-unrelated-error-oracle.html"]) {
    const guardedCDP = await openTarget(port, `${origin}/${fixture}`);
    const guarded = await waitForRuntimeLoadBlock(guardedCDP);
    guardedCDP.close();
    assert.equal(guarded.attacker, null, fixture);
    for (const secret of [bootstrapCapability, bootstrapEntry, bootstrapPayload]) {
      assert.equal(guarded.html.includes(secret), false, `${fixture}: ${secret}`);
    }
  }
  for (const [fixture, globalName] of [
    ["runtime-atomic-failure-oracle.html", "__zp_atomic_failure_result"],
    ["runtime-atomic-metadata-failure-oracle.html", "__zp_atomic_metadata_failure_result"],
    ["runtime-early-failure-oracle.html", "__zp_early_failure_result"],
  ]) {
    const failureCDP = await openTarget(port, `${origin}/${fixture}`);
    const failure = await waitForGlobal(failureCDP, globalName);
    failureCDP.close();
    assert.equal(failure.ok, true, fixture);
  }
  assert.equal(resources.some(url => url.includes("/_zp/")), false);
  assert.equal(resources.some(url => url === "https://example.test/image.png"), true);
  const networkURLs = cdp.events.filter(event => event.method === "Network.requestWillBeSent").map(event => event.params.request.url);
  assert.deepEqual(networkURLs.filter(url => url.startsWith("https://example.test/")), []);
});
