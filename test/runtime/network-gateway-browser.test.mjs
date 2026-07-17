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
const capability = "r".repeat(32);
const abi = `__zp_abi_${"a".repeat(48)}`;
const runtimeSnapshot = {
  cookie_seq: 0,
  jar_or_delta: {
    kind: "SNAPSHOT",
    cookies: [{ name: "sid", value: "browser", domain: "127.0.0.1", path: "/", secure: false, http_only: false, same_site: "LAX", creation_seq: 0 }],
  },
};

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

function readRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
    request.on("aborted", () => reject(new Error("request aborted")));
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

async function startTarget(name, corsOrigin) {
  const requests = [];
  let sseConnections = 0;
  let cacheValue = 1;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://target.invalid");
    let body;
    try {
      body = await readRequest(request);
    } catch {
      return;
    }
    requests.push({ name, method: request.method, path: url.pathname, headers: request.headers, body: body.toString("utf8") });
    const cors = () => ({
      "Access-Control-Allow-Origin": request.headers.origin ?? corsOrigin(),
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Expose-Headers": "X-Cors-Visible",
    });
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        ...cors(),
        "Access-Control-Allow-Methods": "GET, POST, PUT",
        "Access-Control-Allow-Headers": "x-cors-trace, content-type",
        "Access-Control-Max-Age": "600",
      }).end();
      return;
    }
    if (url.pathname === "/data") {
      response.writeHead(200, { "Content-Type": "text/plain", "X-Target": "same" }).end("same-data");
      return;
    }
    if (url.pathname === "/echo") {
      response.writeHead(200, { "Content-Type": "application/json", "X-Target": "echo" }).end(JSON.stringify({ body: body.toString("utf8"), headers: request.headers }));
      return;
    }
    if (url.pathname === "/cors" || url.pathname.startsWith("/cors-safelist-")) {
      response.writeHead(200, { ...cors(), "Content-Type": "text/plain", "X-Cors-Visible": "yes", "X-Cors-Hidden": "no" }).end("cross-cors");
      return;
    }
    if (url.pathname === "/cors-denied") {
      response.writeHead(200, { "Content-Type": "text/plain", "X-Cors-Visible": "no" }).end("denied");
      return;
    }
    if (url.pathname === "/redirect-absolute") {
      response.writeHead(302, { ...cors(), Location: url.searchParams.get("to") }).end();
      return;
    }
    if (url.pathname === "/redirect") {
      response.writeHead(302, { Location: "/final" }).end();
      return;
    }
    if (url.pathname === "/final") {
      response.writeHead(200, { "Content-Type": "text/plain", "X-Target": "final" }).end("redirect-final");
      return;
    }
    if (url.pathname === "/latin1") {
      response.writeHead(200, { "Content-Type": "text/plain;charset=windows-1252" }).end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
      return;
    }
    if (url.pathname === "/json") {
      response.writeHead(200, { "Content-Type": "application/json" }).end('{"answer":42}');
      return;
    }
    if (url.pathname === "/xml") {
      response.writeHead(200, { "Content-Type": "application/xml" }).end("<root><answer>42</answer></root>");
      return;
    }
    if (url.pathname === "/cache") {
      if (request.headers["x-advance-cache"] === "1") cacheValue += 1;
      const etag = `"cache-${cacheValue}"`;
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { ETag: etag, "Cache-Control": "max-age=60" }).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "max-age=60", ETag: etag }).end(`cache-${cacheValue}`);
      return;
    }
    if (url.pathname === "/chunk") {
      response.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "19", "X-Target": "chunk" });
      response.write("chunk-one|");
      await delay(20);
      response.end("chunk-two");
      return;
    }
    if (url.pathname === "/range-data") {
      const source = Buffer.from("0123456789");
      const match = /^bytes=([0-9]+)-([0-9]*)$/.exec(request.headers.range ?? "");
      if (match) {
        const start = Number(match[1]), end = match[2] === "" ? source.length - 1 : Number(match[2]);
        if (start >= source.length || end < start) {
          response.writeHead(416, { "Content-Range": `bytes */${source.length}` }).end();
          return;
        }
        const selected = source.subarray(start, Math.min(end + 1, source.length));
        response.writeHead(206, { "Accept-Ranges": "bytes", "Content-Length": String(selected.length), "Content-Range": `bytes ${start}-${start + selected.length - 1}/${source.length}`, "Content-Type": "text/plain" }).end(selected);
        return;
      }
      response.writeHead(200, { "Accept-Ranges": "bytes", "Content-Length": String(source.length), "Content-Type": "text/plain" }).end(source);
      return;
    }
    if (url.pathname === "/slow-chunk") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.write("first");
      await delay(500);
      if (!response.destroyed) response.end("second");
      return;
    }
    if (url.pathname === "/slow") {
      await delay(500);
      if (!response.destroyed) response.writeHead(200, { "Content-Type": "text/plain" }).end("slow");
      return;
    }
    if (url.pathname === "/sse") {
      sseConnections += 1;
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      if (sseConnections === 1) response.end("id: one\r\nevent: custom\r\ndata: before\r\ndata: after\r\nretry: 1\r\n\r\n");
      else response.end("id: two\ndata: reconnect\n\n");
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain" }).end("missing");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${address.port}`, requests };
}

function apiError(response, code) {
  response.writeHead(502, { "Content-Type": "text/plain;charset=utf-8", "X-ZP-API-ERROR": code }).end(`gateway error: ${code}`);
}

function corsUnsafeRequestHeaderByte(byte) {
  return byte < 0x20 && byte !== 0x09 || [0x22, 0x28, 0x29, 0x3a, 0x3c, 0x3e, 0x3f, 0x40, 0x5b, 0x5c, 0x5d, 0x7b, 0x7d, 0x7f].includes(byte);
}
function corsSafelistedRequestHeader(name, value) {
  if (value.length > 128) return false;
  const bytes = Array.from(value, character => character.charCodeAt(0));
  if (name === "accept") return !bytes.some(corsUnsafeRequestHeaderByte);
  if (name === "accept-language" || name === "content-language") return bytes.every(byte =>
    byte >= 0x30 && byte <= 0x39 || byte >= 0x41 && byte <= 0x5a || byte >= 0x61 && byte <= 0x7a ||
    [0x20, 0x2a, 0x2c, 0x2d, 0x2e, 0x3b, 0x3d].includes(byte));
  if (name === "range") return /^bytes=[0-9]+-[0-9]*$/.test(value);
  if (name !== "content-type") return false;
  const essence = value.split(";", 1)[0].trim().toLowerCase();
  return !bytes.some(corsUnsafeRequestHeaderByte) && ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"].includes(essence);
}

function corsRequestHeaderNames(headers) {
  const safe = new Set(["accept", "accept-language", "content-language", "content-type", "range"]);
  return headers
    .filter(([name, value]) => {
      const lower = name.toLowerCase();
      return !safe.has(lower) || !corsSafelistedRequestHeader(lower, value);
    })
    .map(([name]) => name.toLowerCase())
    .filter((name, index, values) => values.indexOf(name) === index)
    .sort();
}

function headersAllowOrigin(headers, origin, credentials) {
  const allowedOrigin = headers.get("access-control-allow-origin");
  if (credentials === "include") return allowedOrigin === origin && headers.get("access-control-allow-credentials")?.trim().toLowerCase() === "true";
  return allowedOrigin === "*" || allowedOrigin === origin;
}

function projectHeaders(headers, crossOrigin, logicalOrigin, credentials, corsTainted = crossOrigin) {
  const projected = new Headers();
  if (!corsTainted) {
    for (const [name, value] of headers) if (name !== "set-cookie" && name !== "set-cookie2") projected.append(name, value);
    return projected;
  }
  if (crossOrigin && !headersAllowOrigin(headers, logicalOrigin, credentials)) throw new Error("CORS_RESPONSE_DENIED");
  const exposed = new Set(["cache-control", "content-language", "content-length", "content-type", "expires", "last-modified", "pragma"]);
  for (const token of (headers.get("access-control-expose-headers") ?? "").split(",")) if (token.trim()) exposed.add(token.trim().toLowerCase());
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (exposed.has(lower) && lower !== "set-cookie" && lower !== "set-cookie2") projected.append(name, value);
  }
  return projected;
}

function redirectedMethod(status, method) {
  return (status === 303 && method !== "GET" && method !== "HEAD") || ((status === 301 || status === 302) && method === "POST") ? "GET" : method;
}

function responseMaxAge(response) {
  const match = /(?:^|,)\s*max-age\s*=\s*([0-9]+)/i.exec(response.headers.get("cache-control") ?? "");
  return match ? Number(match[1]) * 1000 : 0;
}

function freshCachedResponse(entry) {
  return Date.now() - entry.storedAt <= responseMaxAge(entry.response);
}

function mergedNotModifiedResponse(cached, revalidated) {
  const headers = new Headers(cached.headers);
  for (const [name, value] of revalidated.headers) headers.set(name, value);
  return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
}

async function gatewayFetch(plan, body, logicalOrigin, requestSignal, httpCache, preflightCache) {
  let current = { ...plan, headers: plan.headers.map(pair => [...pair]) };
  let redirected = false;
  let opaqueTainted = false;
  let corsTainted = false;
  for (let hop = 0; hop <= 20; hop += 1) {
    const target = new URL(current.target_url);
    const crossOrigin = target.origin !== logicalOrigin;
    opaqueTainted ||= plan.mode === "no-cors" && crossOrigin;
    corsTainted ||= plan.mode === "cors" && crossOrigin;
    const headerNames = corsRequestHeaderNames(current.headers);
    const needsPreflight = plan.mode === "cors" && crossOrigin && (!["GET", "HEAD", "POST"].includes(current.method) || headerNames.length > 0);
    const preflightKey = `${logicalOrigin}\0${target.href}\0${current.credentials}\0${current.method}\0${headerNames.join(",")}`;
    if (needsPreflight && (preflightCache.get(preflightKey) ?? 0) <= Date.now()) {
      const preflightHeaders = {
        "Access-Control-Request-Method": current.method,
        "Access-Control-Request-Headers": headerNames.join(", "),
      };
      const preflight = await fetch(target, { method: "OPTIONS", headers: preflightHeaders, signal: requestSignal });
      const methods = (preflight.headers.get("access-control-allow-methods") ?? "").toLowerCase();
      const allowedHeaders = (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase();
      if (!preflight.ok || !headersAllowOrigin(preflight.headers, logicalOrigin, current.credentials) || !(methods.includes("*") || methods.split(",").map(value => value.trim()).includes(current.method.toLowerCase())) || !headerNames.every(name => allowedHeaders.includes("*") || allowedHeaders.split(",").map(value => value.trim()).includes(name))) throw new Error("CORS_PREFLIGHT_DENIED");
      const maxAge = Number(preflight.headers.get("access-control-max-age"));
      if (Number.isFinite(maxAge) && maxAge > 0) preflightCache.set(preflightKey, Date.now() + Math.min(7_200, maxAge) * 1_000);
    }
    const cacheEligible = plan.request_kind === "fetch" && current.method === "GET" && !current.body_expected;
    const cached = cacheEligible ? httpCache.get(current.target_url) : undefined;
    if (cacheEligible && current.cache === "only-if-cached" && !cached) throw new Error("CACHE_MISS");
    if (cached && (current.cache === "force-cache" || current.cache === "only-if-cached" || current.cache === "default" && freshCachedResponse(cached))) {
      const response = cached.response.clone();
      const responseType = opaqueTainted ? "opaque" : corsTainted ? "cors" : "basic";
      const headers = opaqueTainted ? new Headers() : projectHeaders(response.headers, crossOrigin, logicalOrigin, current.credentials, corsTainted);
      return { response, headers, targetURL: current.target_url, redirected, responseType };
    }
    const headers = new Headers(current.headers);
    if (current.credentials === "include") headers.set("Cookie", "gateway_session=include");
    if (cacheEligible && current.cache === "no-cache" && cached) {
      const etag = cached.response.headers.get("etag");
      const modified = cached.response.headers.get("last-modified");
      if (etag) headers.set("If-None-Match", etag);
      else if (modified) headers.set("If-Modified-Since", modified);
    }
    let response = await fetch(target, {
      method: current.method,
      headers,
      body: current.body_expected ? body : undefined,
      redirect: "manual",
      signal: requestSignal,
    });
    if (response.status === 304 && cached) {
      response = mergedNotModifiedResponse(cached.response.clone(), response);
      httpCache.set(current.target_url, { response: response.clone(), storedAt: Date.now() });
    } else if (cacheEligible && current.cache !== "no-store" && !/(?:^|,)\s*no-store(?:\s*(?:,|$))/i.test(response.headers.get("cache-control") ?? "") && response.status === 200 && !response.headers.has("vary")) {
      httpCache.set(current.target_url, { response: response.clone(), storedAt: Date.now() });
    }
    const isRedirect = response.status >= 300 && response.status < 400 && response.headers.has("location");
    if (isRedirect && plan.redirect === "manual") {
      await response.body?.cancel();
      return { opaque: true, targetURL: current.target_url, redirected: false, responseType: "opaqueredirect" };
    }
    if (isRedirect && plan.redirect === "error") {
      await response.body?.cancel();
      throw new Error("REDIRECT_DISALLOWED");
    }
    if (!isRedirect) {
      const responseType = opaqueTainted ? "opaque" : corsTainted ? "cors" : "basic";
      const headers = opaqueTainted ? new Headers() : projectHeaders(response.headers, crossOrigin, logicalOrigin, current.credentials, corsTainted);
      return { response, headers, targetURL: current.target_url, redirected, responseType };
    }
    if (hop === 20 || plan.redirect !== "follow") {
      await response.body?.cancel();
      throw new Error("REDIRECT_LIMIT_EXCEEDED");
    }
    const next = new URL(response.headers.get("location"), current.target_url);
    await response.body?.cancel();
    const method = redirectedMethod(response.status, current.method);
    current = {
      ...current,
      target_url: next.href,
      method,
      body_expected: method === current.method ? current.body_expected : false,
      headers: method === current.method ? current.headers : current.headers.filter(([name]) => !["content-length", "content-type", "content-encoding", "transfer-encoding"].includes(name.toLowerCase())),
    };
    redirected = true;
  }
  throw new Error("REDIRECT_LIMIT_EXCEEDED");
}

async function startGateway({ sameOrigin, crossOrigin }) {
  const httpCache = new Map();
  const preflightCache = new Map();
  const plans = [];
  const nativeCacheRequests = [];
  let nativeCacheValue = 1;
  const bootstrap = await readFile(path.join(root, "test/browser/network-gateway-bootstrap.html"), "utf8");
  const oracle = await readFile(path.join(root, "test/browser/network-gateway-oracle.html"), "utf8");
  const worker = await readFile(path.join(root, "test/browser/network-gateway-plan-sw.js"), "utf8");
  const version = JSON.parse(await readFile(path.join(dist, "_zp/version.json"), "utf8"));
  const runtimeAsset = version.selectors?.["runtime-prelude.js"];
  assert.equal(typeof runtimeAsset, "string", "built runtime prelude asset is required");
  const server = http.createServer((request, response) => void (async () => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const url = new URL(request.url, origin);
      if (url.pathname === "/network-native-cors.html") {
        response.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" }).end("<!doctype html><title>Native CORS oracle</title>");
        return;
      }
      if (url.pathname === "/network-native-cache") {
        nativeCacheRequests.push({ headers: request.headers });
        if (request.headers["x-advance-cache"] === "1") nativeCacheValue += 1;
        const etag = `"native-cache-${nativeCacheValue}"`;
        if (request.headers["if-none-match"] === etag) {
          response.writeHead(304, { "Cache-Control": "max-age=60", ETag: etag }).end();
          return;
        }
        response.writeHead(200, { "Cache-Control": "max-age=60", "Content-Type": "text/plain", ETag: etag }).end(`native-cache-${nativeCacheValue}`);
        return;
      }
      if (url.pathname === "/network-gateway-bootstrap.html") {
        response.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self'; base-uri 'none'" }).end(bootstrap);
        return;
      }
      if (url.pathname === "/network-gateway-plan-sw.js") {
        response.writeHead(200, { "Content-Type": "text/javascript;charset=utf-8", "Cache-Control": "no-store", "Service-Worker-Allowed": "/" }).end(worker);
        return;
      }
      if (url.pathname === "/network-gateway-oracle.html") {
        const runtimeURL = `${runtimeAsset}#abi=${abi}&url=${encodeURIComponent(`${sameOrigin}/app/index.html`)}&ports=${[server.address().port, new URL(sameOrigin).port, new URL(crossOrigin).port].join(",")}&cookie=${capability}&strings=0`;
        const approvedPorts = [server.address().port, Number(new URL(sameOrigin).port), Number(new URL(crossOrigin).port)];
        const runtimeBootstrap = runtimeBootstrapFixture({
          capability,
          entryID: "g".repeat(32),
          targetURL: `${sameOrigin}/app/index.html`,
          approvedPorts,
          referrerURL: `${sameOrigin}/previous.html`,
          snapshot: runtimeSnapshot,
        });
        const config = { same: sameOrigin, cross: crossOrigin, sameHost: new URL(sameOrigin).host, referrer: `${sameOrigin}/previous.html`, reload: url.searchParams.get("reloaded") === "1" };
        const rendered = oracle
          .replaceAll("__ZP_RUNTIME_URL__", runtimeURL.replaceAll("&", "&amp;"))
          .replaceAll("__ZP_RUNTIME_BOOTSTRAP__", runtimeBootstrap)
          .replace("__ZP_CONFIG__", JSON.stringify(config));
        response.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'; base-uri 'none'" }).end(rendered);
        return;
      }
      if (url.pathname.startsWith("/_zp/api/")) {
        const token = url.pathname.slice("/_zp/api/".length);
        let plan;
        try {
          plan = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
          if (!plan || typeof plan.target_url !== "string" || !Array.isArray(plan.headers)) throw new Error("invalid plan");
        } catch {
          apiError(response, "PLAN_INVALID");
          return;
        }
        plans.push({ ...plan, internal_path: url.pathname, admission_body_handle: request.headers["x-zp-body-handle"] ?? "" });
        let body;
        try {
          body = await readRequest(request);
        } catch {
          return;
        }
        const controller = new AbortController();
        request.once("aborted", () => controller.abort());
        try {
          const result = await gatewayFetch(plan, body, sameOrigin, controller.signal, httpCache, preflightCache);
          if (result.opaque) {
            response.writeHead(200, {
              "X-ZP-Target-URL": result.targetURL,
              "X-ZP-Redirected": "0",
              "X-ZP-Response-Type": result.responseType,
            }).end();
            return;
          }
          const headers = Object.fromEntries(result.headers);
          headers["X-ZP-Target-URL"] = result.targetURL;
          headers["X-ZP-Redirected"] = result.redirected ? "1" : "0";
          headers["X-ZP-Response-Type"] = result.responseType;
          response.writeHead(result.response.status, result.response.statusText, headers);
          if (!result.response.body) {
            response.end();
            return;
          }
          for await (const chunk of result.response.body) {
            if (response.destroyed) break;
            response.write(chunk);
          }
          response.end();
        } catch (error) {
          if (!response.destroyed) apiError(response, error?.message === "CORS_RESPONSE_DENIED" || error?.message === "CORS_PREFLIGHT_DENIED" ? "CORS_DENIED" : "NETWORK_FAILED");
        }
        return;
      }
      const file = path.resolve(dist, `.${decodeURIComponent(url.pathname)}`);
      if (!file.startsWith(`${dist}${path.sep}`)) throw new Error("invalid asset path");
      const body = await readFile(file);
      response.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" }).end(body);
    } catch {
      if (!response.headersSent) response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("not found");
    }
  })());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { nativeCacheRequests, plans, server };
}

async function waitForFile(file, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { return await readFile(file, "utf8"); } catch { await delay(25); }
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
  const diagnostic = await cdp.call("Runtime.evaluate", { expression: "({ href: location.href, body: document.body?.innerText, phase: globalThis.__networkGatewayPhase ?? null, reloadReady: globalThis.__networkGatewayReloadReady ?? null, result: globalThis.__networkGatewayResult ?? null, session: sessionStorage.getItem('network-opaque-reload-v2') })", returnByValue: true });
  const exceptions = cdp.events.filter(event => event.method === "Runtime.exceptionThrown").map(event => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);
  throw new Error(`${name} timed out: ${JSON.stringify({ diagnostic: diagnostic.result.value, exceptions })}`);
}

test("runtime network facades use the gateway plan seam without direct target egress", { timeout: 45_000 }, async t => {
  const chrome = chromiumPath();
  assert.ok(chrome, "supported Chromium executable is required");
  let same;
  const sameOrigin = () => same.origin;
  same = await startTarget("same", sameOrigin);
  const cross = await startTarget("cross", sameOrigin);
  const gateway = await startGateway({ sameOrigin: same.origin, crossOrigin: cross.origin });
  const gatewayAddress = gateway.server.address();
  const browserOrigin = `http://127.0.0.1:${gatewayAddress.port}`;
  const profile = await mkdtemp(path.join(os.tmpdir(), "zeroproxy-network-gateway-"));
  let processHandle;
  let cdp;
  t.after(async () => {
    cdp?.close();
    processHandle?.kill("SIGKILL");
    await Promise.all([closeServer(gateway.server), closeServer(same.server), closeServer(cross.server)]);
    await rm(profile, { recursive: true, force: true });
  });
  processHandle = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const [port] = (await waitForFile(path.join(profile, "DevToolsActivePort"))).trim().split("\n");
  cdp = await openTarget(port, `${browserOrigin}/network-native-cors.html`);
  const nativeCorsCorpus = [
    ["accept-safe", "Accept", "text/html;q=0.9"],
    ["accept-byte-boundary", "Accept", "é".repeat(128)],
    ["language-safe", "Accept-Language", "en-US, fr;q=0.8"],
    ["content-type-safe", "Content-Type", "text/plain;charset=UTF-8"],
    ["multipart-safe", "Content-Type", "multipart/form-data; boundary=abc123"],
    ["range-safe", "Range", "bytes=0-99"],
    ["accept-unsafe", "Accept", "text/plain("],
    ["language-unsafe", "Accept-Language", "en_US"],
    ["content-type-unsafe", "Content-Type", "application/json"],
    ["content-type-quoted", "Content-Type", "text/plain; charset=\"utf-8\""],
    ["range-unsafe", "Range", "bytes=0-1, 4-5"],
    ["accept-long", "Accept", "é".repeat(129)],
  ];
  const nativeCorsResult = await cdp.call("Runtime.evaluate", {
    expression: `Promise.allSettled(${JSON.stringify(nativeCorsCorpus)}.map(([path,name,value])=>fetch(${JSON.stringify(cross.origin)}+"/cors-safelist-"+path,{headers:{[name]:value}})))`,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(nativeCorsResult.exceptionDetails, undefined, "native Chromium CORS oracle must execute");
  const nativeCacheURL = `${browserOrigin}/network-native-cache`;
  const nativeCacheResult = await cdp.call("Runtime.evaluate", {
    expression: `(async()=>{const url=${JSON.stringify(nativeCacheURL)},text=async options=>(await fetch(url,options)).text(),values=[];values.push(await text());values.push(await text());values.push(await text({cache:"reload",headers:{"X-Advance-Cache":"1"}}));values.push(await text({cache:"no-cache"}));values.push(await text({cache:"force-cache"}));values.push(await text({cache:"no-store",headers:{"X-Advance-Cache":"1"}}));values.push(await text({cache:"force-cache"}));values.push(await text({cache:"only-if-cached",mode:"same-origin"}));try{await text({cache:"only-if-cached",mode:"cors"});values.push("resolved")}catch(error){values.push(error.name)}return values})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(nativeCacheResult.exceptionDetails, undefined, "native Chromium cache oracle must execute");
  assert.deepEqual(nativeCacheResult.result.value, ["native-cache-1", "native-cache-1", "native-cache-2", "native-cache-2", "native-cache-2", "native-cache-3", "native-cache-2", "native-cache-2", "TypeError"], "native Chromium cache mode characterization changed");
  assert.equal(gateway.nativeCacheRequests.length, 4, "native Chromium cache request count changed");
  assert.ok(gateway.nativeCacheRequests.some(request => request.headers["if-none-match"] === '"native-cache-2"'), "native Chromium no-cache validator changed");
  const nativeSocketResult = await cdp.call("Runtime.evaluate", {
    expression: `(()=>{const socket=new WebSocket("ws://127.0.0.1:9/native-shape"),result={binaryType:socket.binaryType};try{socket.binaryType="invalid";result.binaryTypeAfter=socket.binaryType}catch(error){result.binaryTypeError=error.name}try{socket.close(1001);result.closeCode="accepted"}catch(error){result.closeCode=error.name}try{socket.close(1000,"x".repeat(124));result.closeReason="accepted"}catch(error){result.closeReason=error.name}socket.close();return result})()`,
    returnByValue: true,
  });
  assert.equal(nativeSocketResult.exceptionDetails, undefined, "native Chromium WebSocket shape oracle must execute");
  assert.deepEqual(nativeSocketResult.result.value, { binaryType: "blob", binaryTypeAfter: "blob", closeCode: "InvalidAccessError", closeReason: "SyntaxError" }, "native Chromium WebSocket validation characterization changed");
  const nativePreflightPaths = [...new Set(cross.requests.filter(request => request.method === "OPTIONS" && request.path.startsWith("/cors-safelist-")).map(request => request.path))].sort();
  cross.requests.length = 0;
  await delay(100);
  cdp.events.length = 0;
  const gatewayEventStart = 0;
  await cdp.call("Page.navigate", { url: `${browserOrigin}/network-gateway-bootstrap.html` });
  const bootstrap = await waitForGlobal(cdp, "__networkGatewayBootstrap");
  await cdp.call("Page.navigate", { url: `${browserOrigin}/network-gateway-oracle.html` });
  let reloadReady;
  try { reloadReady = await waitForGlobal(cdp, "__networkGatewayReloadReady", 30_000); }
  catch (error) { throw new Error(`${error.message}; plans=${JSON.stringify(gateway.plans)}; network=${JSON.stringify(cdp.events.filter(event => event.method === "Network.requestWillBeSent" || event.method === "Network.loadingFailed").map(event => ({ method: event.method, url: event.params.request?.url, error: event.params.errorText })))}`); }
  assert.equal(reloadReady.ok, true);
  await cdp.call("Page.navigate", { url: `${browserOrigin}/network-gateway-oracle.html?reloaded=1` });
  await delay(100);
  let result;
  try { result = await waitForGlobal(cdp, "__networkGatewayResult", 30_000); }
  catch (error) { throw new Error(`${error.message}; plans=${JSON.stringify(gateway.plans)}; network=${JSON.stringify(cdp.events.filter(event => event.method === "Network.requestWillBeSent" || event.method === "Network.loadingFailed").map(event => ({ method: event.method, url: event.params.request?.url, error: event.params.errorText })))}`); }

  assert.equal(result.ok, true, JSON.stringify(result));
  const gatewayURLs = cdp.events.slice(gatewayEventStart).filter(event => event.method === "Network.requestWillBeSent").map(event => event.params.request.url);
  assert.deepEqual(gatewayURLs.filter(value => {
    const origin = new URL(value).origin;
    return origin === same.origin || origin === cross.origin;
  }), [], `direct target browser requests: ${JSON.stringify(gatewayURLs)}`);
  assert.ok(gatewayURLs.some(value => new URL(value).pathname.startsWith("/_zp/api/")), "facades must issue browser requests only to gateway API paths");

  assert.ok(gateway.plans.some(plan => plan.request_kind === "fetch" && plan.credentials === "include"), "fetch credentials must reach the gateway plan");
  assert.ok(gateway.plans.some(plan => plan.request_kind === "fetch" && plan.mode === "no-cors"), "no-cors mode must reach the gateway plan");
  assert.ok(gateway.plans.some(plan => plan.request_kind === "fetch" && plan.keepalive === true && plan.priority === "high"), `keepalive and priority must reach the gateway plan: ${JSON.stringify(gateway.plans)}`);
  assert.deepEqual(new Set(gateway.plans.filter(plan => plan.request_kind === "fetch" && plan.target_url.endsWith("/cache")).map(plan => plan.cache)), new Set(["default", "reload", "no-cache", "force-cache", "no-store", "only-if-cached"]), "all Fetch cache modes must reach the gateway plan");
  assert.ok(gateway.plans.some(plan => plan.request_kind === "xhr" && plan.credentials === "include"), "XHR credentials must reach the gateway plan");
  assert.ok(gateway.plans.filter(plan => plan.body_expected).every(plan => /^[a-f0-9]{48}$/u.test(plan.body_handle) && plan.admission_body_handle === plan.body_handle), "streamed request bodies must carry their registered one-shot handle");
  assert.ok(gateway.plans.filter(plan => !plan.body_expected).every(plan => plan.body_handle === "" && plan.admission_body_handle === ""), "bodyless requests must not carry a body handle");
  assert.ok(gateway.plans.some(plan => plan.request_kind === "eventsource" && plan.headers.some(([name]) => name.toLowerCase() === "last-event-id")), "EventSource retry must carry Last-Event-ID through the plan");
  const eventSourcePlans = gateway.plans.filter(plan => plan.request_kind === "eventsource");
  assert.equal(eventSourcePlans.length, 2, "EventSource must perform two gateway attempts");
  assert.equal(new Set(eventSourcePlans.map(plan => plan.mock_lease)).size, 1, "EventSource reconnect must reuse one stable lease");
  assert.equal(new Set(eventSourcePlans.map(plan => plan.instance_id)).size, 1, "EventSource reconnect must retain one instance binding");
  assert.match(eventSourcePlans[0].instance_id, /^[a-f0-9]{48}$/u, "EventSource instance binding must be opaque");
  const tracedPreflights = cross.requests.filter(request => request.method === "OPTIONS" && request.path === "/cors" && request.headers["access-control-request-headers"]?.includes("x-cors-trace"));
  assert.equal(tracedPreflights.length, 1, "successful CORS preflight grant must be cached");
  const gatewayPreflightPaths = [...new Set(cross.requests.filter(request => request.method === "OPTIONS" && request.path.startsWith("/cors-safelist-")).map(request => request.path))].sort();
  assert.deepEqual(gatewayPreflightPaths, nativePreflightPaths, "gateway CORS safelist decisions must match native Chromium");
  const sseRequests = same.requests.filter(request => request.path === "/sse");
  assert.equal(sseRequests[1]?.headers["last-event-id"], "one", "gateway must forward only the trusted parsed EventSource ID");
  assert.ok(sseRequests.every(request => request.headers["last-event-id"] !== "page-forged"), "page-owned EventSource fields must not forge Last-Event-ID");
  const cacheRequests = same.requests.filter(request => request.path === "/cache");
  assert.equal(cacheRequests.length, 4, "cache modes must avoid unnecessary target requests");
  assert.ok(cacheRequests.some(request => request.headers["if-none-match"] === '"cache-2"'), "no-cache must revalidate with the cached validator");
  assert.deepEqual(result.cases.filter(entry => !entry.pass), []);
});
