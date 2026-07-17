import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";

import { createContentAddressedModuleGraph } from "../../web/sw/executable-routes.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const pinnedChromium = path.join(
  root,
  ".puppeteer-cache/chrome/mac_arm-150.0.7871.124/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
);
const chromium = process.env.ZP_CHROMIUM_PATH
  ?? process.env.CHROME_BIN
  ?? (existsSync(pinnedChromium) ? pinnedChromium : null);
const ABI = "__zp_abi_222222222222222222222222222222222222222222222222";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compile(source, sourceKind, abiIdentifier) {
  const code = source
    .replace(/\bimport\.meta\b/gu, `${abiIdentifier}.importMeta`)
    .replace(/\bimport\s*\(\s*(?!["'])/gu, `${abiIdentifier}.importModule(`);
  const moduleSpecifiers = [];
  const expression = /(?:from\s*|import\s+|import\s*\(\s*)(["'])([^"']+)\1/gu;
  for (const match of code.matchAll(expression)) {
    const start = match.index + match[0].indexOf(match[1]);
    const end = start + match[1].length + match[2].length + match[1].length;
    moduleSpecifiers.push({
      original_start: Buffer.byteLength(source.slice(0, Math.min(start, source.length))),
      original_end: Buffer.byteLength(source.slice(0, Math.min(end, source.length))),
      generated_start: Buffer.byteLength(code.slice(0, start)),
      generated_end: Buffer.byteLength(code.slice(0, end)),
      module_type: /\b(?:with|assert)\s*\{\s*type\s*:\s*["']json["']/u.test(code.slice(end, end + 96))
        ? "json"
        : "javascript",
      specifier: match[2],
    });
  }
  return JSON.stringify({
    schema_version: 1,
    ok: true,
    code,
    edits: [],
    edit_map: [],
    source_map: {
      version: 3,
      file: `authored-${sourceKind}.js`,
      sources: [`authored-${sourceKind}.js`],
      sourcesContent: [source],
      names: [],
      mappings: "",
    },
    module_specifiers: moduleSpecifiers,
    source_url: `authored-${sourceKind}.js`,
    source_mapping_url: null,
    diagnostics: [],
  });
}

const compiler = Object.freeze({
  compile_json: compile,
  source_map_base64() { return "Y29udHJvbGxlZA=="; },
});

const targetRoot = "https://target.example/app/root.mjs";
const sources = new Map([
  [targetRoot, `
    import * as depNamespace from "./dep.mjs";
    import * as depAgain from "./dep.mjs";
    import * as sameA from "./same-a.mjs";
    import * as sameB from "./same-b.mjs";
    import { cycle } from "./cycle-a.mjs";
    await Promise.resolve();
    export { depAgain, depNamespace, sameA, sameB };
    export const cycleValue = cycle;
    export const metaURL = import.meta.url;
    export const resolvedURL = import.meta.resolve("./dep.mjs");
    export const tlaReady = true;
    export function load(specifier, options) { return import(specifier, options); }
  `],
  ["https://target.example/app/dep.mjs", `
    globalThis.__zpDepLoads = (globalThis.__zpDepLoads ?? 0) + 1;
    export let counter = 0;
    export function bump() { counter += 1; }
  `],
  ["https://target.example/app/same-a.mjs", "export const value = 1;"],
  ["https://target.example/app/same-b.mjs", "export const value = 1;"],
  ["https://target.example/app/cycle-a.mjs", `
    import { getB } from "./cycle-b.mjs";
    export function getA() { return "a"; }
    export const cycle = getB();
  `],
  ["https://target.example/app/cycle-b.mjs", `
    import { getA } from "./cycle-a.mjs";
    export function getB() { return "b" + getA(); }
  `],
  ["https://target.example/app/data.json", JSON.stringify({ value: 7 })],
]);

test("browser module map preserves target identity, MIME, cycles, live bindings, TLA, and dynamic imports", {
  skip: chromium ? false : "pinned Chromium unavailable",
  timeout: 30_000,
}, async () => {
  let graph, rootRouteURL;
  const serverFailures = [];
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
        return;
      }
      if (url.pathname === "/") {
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><title>module identity</title>${rootRouteURL ? `<link rel="modulepreload" href="${rootRouteURL}">` : ""}`);
        return;
      }
      if (url.pathname === "/allocate") {
        const referrer = url.searchParams.get("referrer");
        const specifier = url.searchParams.get("specifier");
        assert.equal(typeof referrer, "string");
        assert.equal(typeof specifier, "string");
        const targetURL = new URL(specifier, referrer).href;
        const source = sources.get(targetURL);
        if (source === undefined) throw new Error("unknown dynamic module");
        const moduleType = targetURL.endsWith(".json") ? "json" : "javascript";
        const rewritten = await graph.rewriteRoot(source, targetURL, "ModuleScript", moduleType);
        response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" });
        response.end(JSON.stringify({ module_type: moduleType, target_url: targetURL, url: rewritten.route.url }));
        return;
      }
      const match = /^\/modules\/browser-identity\/([a-f0-9]{64})\.mjs$/u.exec(url.pathname);
      if (!match) throw new Error("unknown route");
      const entry = await graph.sourceFor(match[1]);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": entry.module_type === "json" ? "application/json" : "text/javascript; charset=utf-8",
      });
      response.end(entry.source);
    } catch (error) {
      serverFailures.push(`${request.url}: ${error}`);
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(String(error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  graph = createContentAddressedModuleGraph({
    abiIdentifier: ABI,
    compiler,
    digest,
    graphID: "browser-identity",
    load: ({ module_type: moduleType, target_url: targetURL }) => ({
      module_type: moduleType,
      source: sources.get(targetURL),
      target_url: targetURL,
    }),
    moduleRoute: (graphID, moduleID) => `/modules/${graphID}/${moduleID}.mjs`,
    policyVersion: 2,
    requestContext: Object.freeze({
      cache: "no-store",
      credentials: "same-origin",
      integrity: "",
      mode: "cors",
      referrer: targetRoot,
    }),
  });
  const rewritten = await graph.rewriteRoot(sources.get(targetRoot), targetRoot, "ModuleScript");
  rootRouteURL = rewritten.route.url;
  const rootResponse = await fetch(`${origin}${rewritten.route.url}`);
  assert.equal(rootResponse.status, 200);
  const rootSource = await rootResponse.text();
  assert.match(rootSource, /from "\/modules\/browser-identity\/[a-f0-9]{64}\.mjs"/u);
  const browser = await puppeteer.launch({
    args: ["--disable-gpu", "--no-sandbox"],
    executablePath: chromium,
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("console", message => errors.push(`console:${message.type()}:${message.text()}`));
  page.on("requestfailed", request => errors.push(`request:${request.url()}:${request.failure()?.errorText}`));
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(origin, { waitUntil: "load" });
    let result;
    try {
      result = await page.evaluate(async ({ abiName, rootURL }) => {
      const moduleContexts = new WeakMap();
      const moduleMeta = new WeakMap();
      const abi = Object.freeze({
        dynamicFunction() { throw new Error("unused"); },
        evalSource(value) { return value; },
        indirectEval: globalThis.eval,
        moduleContext(nativeMeta, originalURL) {
          const existing = moduleContexts.get(nativeMeta);
          if (existing) return existing;
          let meta = moduleMeta.get(nativeMeta);
          if (!meta) {
            meta = Object.freeze({ resolve: value => new URL(String(value), originalURL).href, url: originalURL });
            moduleMeta.set(nativeMeta, meta);
          }
          const context = Object.freeze({
            ...abi,
            importMeta: meta,
            importModule(value, options) {
              return Promise.resolve().then(async () => {
                const specifier = String(value);
                const allocation = new URL("/allocate", location.origin);
                allocation.searchParams.set("referrer", originalURL);
                allocation.searchParams.set("specifier", specifier);
                const plan = await fetch(allocation).then(response => response.json());
                return import(plan.url, options);
              });
            },
            scope: globalThis,
            thisValue(value) { return value; },
          });
          moduleContexts.set(nativeMeta, context);
          return context;
        },
        scope: globalThis,
        thisValue(value) { return value; },
      });
      Object.defineProperty(globalThis, abiName, { configurable: false, value: abi, writable: false });
      const first = await import(rootURL);
      const second = await import(rootURL);
      let synchronous = true;
      let coercionPhase = "missing";
      const dynamicPromise = first.load({
        toString() {
          coercionPhase = synchronous ? "sync" : "async";
          return "./dep.mjs";
        },
      });
      synchronous = false;
      const dynamicDep = await dynamicPromise;
      let optionReads = 0;
      const optionDep = await first.load("./dep.mjs", { get with() { optionReads += 1; return {}; } });
      let threwSynchronously = false;
      let rejectedAsynchronously = false;
      try {
        const rejected = first.load({ toString() { throw new Error("coercion"); } });
        try { await rejected; } catch { rejectedAsynchronously = true; }
      } catch { threwSynchronously = true; }
      first.depNamespace.bump();
      return {
        coercionPhase,
        cycleValue: first.cycleValue,
        depLoads: globalThis.__zpDepLoads,
        duplicateStaticIdentity: first.depNamespace === first.depAgain,
        dynamicIdentity: dynamicDep === first.depNamespace,
        optionIdentity: optionDep === first.depNamespace,
        optionReads,
        liveCounter: first.depNamespace.counter,
        metaURL: first.metaURL,
        namespaceIdentity: first === second,
        rejectedAsynchronously,
        resolvedURL: first.resolvedURL,
        sameBytesDifferentURL: first.sameA !== first.sameB,
        threwSynchronously,
        tlaReady: first.tlaReady,
      };
      }, { abiName: ABI, rootURL: rewritten.route.url });
    } catch (error) {
      assert.fail(`${error}\n${serverFailures.join("\n")}\n${errors.join("\n")}\n${rootSource}`);
    }
    assert.deepEqual(result, {
      coercionPhase: "async",
      cycleValue: "ba",
      depLoads: 1,
      duplicateStaticIdentity: true,
      dynamicIdentity: true,
      optionIdentity: true,
      optionReads: 1,
      liveCounter: 1,
      metaURL: targetRoot,
      namespaceIdentity: true,
      rejectedAsynchronously: true,
      resolvedURL: "https://target.example/app/dep.mjs",
      sameBytesDifferentURL: true,
      threwSynchronously: false,
      tlaReady: true,
    });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
