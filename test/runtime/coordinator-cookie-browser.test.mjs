import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJSON } from "../../web/control/relay-profile.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dist = path.join(root, "dist/web");
const cookieOraclePath = path.join(root, "test/browser/coordinator-cookie-oracle.html");
const handoffOraclePath = path.join(root, "test/browser/coordinator-oracle.html");
const relayHexDigest = "e466728411805ea3c97c9ba046b0d88d6e0477c0683078c441854bce65801e24";
const relayProfile = JSON.parse(await readFile(path.join(root, `protocol/relay-profiles/${relayHexDigest}.json`), "utf8"));
const releaseSigningKeys = JSON.parse(await readFile(path.join(root, "protocol/release-signing-keys.json"), "utf8"));
const addressPolicy = JSON.parse(await readFile(path.join(root, "protocol/address-policy.json"), "utf8"));

async function createRelayConfig() {
  const keyPairs = await Promise.all(releaseSigningKeys.keys.map(
    () => webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]),
  ));
  const keys = {
    ...releaseSigningKeys,
    keys: await Promise.all(releaseSigningKeys.keys.map(async (key, index) => ({
      ...key,
      public_key: Buffer.from(await webcrypto.subtle.exportKey("raw", keyPairs[index].publicKey)).toString("base64url"),
    }))),
  };
  const profiles = [
    relayProfile,
    {
      ...structuredClone(relayProfile),
      profile_id: "zeroproxy-development-fallback",
      display_name: "ZeroProxy development fallback relay",
      deployment_id: "fallback_relay_deployment_000000000000000000",
      relay_wss_origin: "wss://relay-fallback.example.test",
    },
  ];
  const records = await Promise.all(profiles.map(async profile => {
    const canonical = Buffer.from(canonicalJSON(profile));
    const digest = createHash("sha256").update(canonical).digest("base64url");
    const signatures = await Promise.all(keyPairs.map(async (pair, index) => ({
      key_id: keys.keys[index].id,
      signature: Buffer.from(await webcrypto.subtle.sign("Ed25519", pair.privateKey, canonical)).toString("base64url"),
    })));
    return {
      digest,
      profile,
      signatures: {
        algorithm: "Ed25519",
        canonicalization: "RFC8785",
        key_epoch: keys.key_epoch,
        development_only: true,
        signatures,
      },
    };
  }));
  const canonicalAddressPolicy = Buffer.from(canonicalJSON(addressPolicy));
  const addressPolicySignatures = {
    algorithm: "Ed25519",
    canonicalization: "RFC8785",
    key_epoch: keys.key_epoch,
    development_only: true,
    signatures: await Promise.all(keyPairs.map(async (pair, index) => ({
      key_id: keys.keys[index].id,
      signature: Buffer.from(
        await webcrypto.subtle.sign("Ed25519", pair.privateKey, canonicalAddressPolicy),
      ).toString("base64url"),
    }))),
  };
  return JSON.stringify({
    development_mode: true,
    installed_relay_profile_digests: records.map(record => record.digest),
    release_signing_keys: keys,
    address_policy: addressPolicy,
    address_policy_signatures: addressPolicySignatures,
    relay_profiles: records,
  });
}

const relayConfig = await createRelayConfig();

function chromiumPath() {
  return [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
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
    try { return await readFile(file, "utf8"); }
    catch { await new Promise(resolve => setTimeout(resolve, 25)); }
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
      if (!message.id) {
        this.events.push(message);
        return;
      }
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
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
  return cdp;
}

async function waitForOracle(cdp) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await cdp.call("Runtime.evaluate", {
      expression: "document.querySelector('#result')?.textContent || ''",
      returnByValue: true,
    });
    if (response.result.value) return JSON.parse(response.result.value);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`cookie coordinator oracle timed out: ${JSON.stringify(cdp.events)}`);
}

const expectedContracts = [
  "cookie-context-binds-top-level-site",
  "profile-isolated-broadcasts",
  "durable-monotonic-concurrent-sequencing",
  "cross-kernel-cookie-commit-broadcast",
  "idempotent-duplicate-replay",
  "duplicate-payload-conflict-rejected",
  "redirect-set-cookie-batch-order",
  "max-age-deletion-commits",
  "durable-contiguous-delta",
  "durable-commit-journal",
  "document-projection-excludes-http-only",
  "target-domain-shared-across-mapped-origins",
  "restart-hydrates-durable-cookie-state",
  "cross-profile-context-rejected",
  "forged-top-level-cookie-site-rejected",
  "stale-causal-operation-rejected",
];
const expectedHandoffContracts = [
  "telemetry-consent-is-explicit-profile-state",
  "durable-response-revisions-monotonic",
  "exact-envelope-rejects-unknown-fields",
  "malformed-message-size-rejected",
  "request-replay-rejected-before-processing",
  "responses-use-exact-success-failure-shapes",
  "parallel-map-stable",
  "origin-not-path-keyed",
  "profile-keyed-isolation",
  "stale-sensitive-revision-rejected-before-payload",
  "handoff-rejects-uuid-identifiers",
  "form-handoff-rejects-mismatched-body-digest",
  "handoff-accepts-opaque-identifiers",
  "lineage-created-before-handoff",
  "handoff-payload-sealed-at-rest",
  "handoff-host-bound",
  "handoff-restores-encrypted-target",
  "form-handoff-restores-exact-encoded-body",
  "consume-rotates-document-capability-atomically",
  "handoff-one-shot",
  "history-revision-is-monotonic",
  "later-lineage-revokes-stale-pending-work",
  "destination-capability-rotates-per-commit",
  "same-origin-history-commits-monotonic-lineage",
  "restart-preserves-mapping-but-rejects-unbound-port",
  "durable-revision-matches-last-response",
];

test("coordinator owns durable ordered cookie authority and document projections", { timeout: 35_000 }, async t => {
  const chrome = chromiumPath();
  assert.ok(chrome, "supported Chromium executable is required");
  const cookieOracle = await readFile(cookieOraclePath);
  const handoffOracle = await readFile(handoffOraclePath);
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://cookie.localhost").pathname;
      if (pathname === "/coordinator-cookie-oracle.html") {
        response.writeHead(200, {
          "Content-Type": "text/html;charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; script-src 'self' 'nonce-cookie-oracle'; worker-src 'self'; connect-src 'self'; base-uri 'none'",
        }).end(cookieOracle);
        return;
      }
      if (pathname === "/coordinator-oracle.html") {
        response.writeHead(200, {
          "Content-Type": "text/html;charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; worker-src 'self'; connect-src 'self'; base-uri 'none'",
        }).end(handoffOracle);
        return;
      }
      if (pathname === "/control/config.json") {
        response.writeHead(200, { "Content-Type": "application/json;charset=utf-8", "Cache-Control": "no-store" }).end(relayConfig);
        return;
      }
      const file = path.resolve(dist, `.${decodeURIComponent(pathname)}`);
      if (!file.startsWith(`${dist}${path.sep}`)) {
        response.writeHead(403).end("forbidden");
        return;
      }
      response.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" }).end(await readFile(file));
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  const port = await listen(server);
  const profile = await mkdtemp(path.join(os.tmpdir(), "zeroproxy-cookie-authority-"));
  let processHandle;
  let cdp;
  t.after(async () => {
    cdp?.close();
    if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
      const exited = new Promise(resolve => processHandle.once("exit", resolve));
      processHandle.kill("SIGKILL");
      await exited;
    }
    await close(server);
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
  cdp = await openTarget(debugPort, `http://127.0.0.1:${port}/coordinator-cookie-oracle.html`);
  const result = await waitForOracle(cdp);
  const exceptions = cdp.events
    .filter(event => event.method === "Runtime.exceptionThrown")
    .map(event => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.tests.map(entry => entry.id), expectedContracts);
  assert.deepEqual(result.tests.filter(entry => !entry.ok), []);
  assert.deepEqual(exceptions, []);
  cdp.close();
  cdp = await openTarget(debugPort, `http://127.0.0.1:${port}/coordinator-oracle.html`);
  const handoffResult = await waitForOracle(cdp);
  const handoffExceptions = cdp.events
    .filter(event => event.method === "Runtime.exceptionThrown")
    .map(event => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);
  assert.equal(handoffResult.ok, true, JSON.stringify(handoffResult));
  assert.deepEqual(handoffResult.tests.map(entry => entry.id), expectedHandoffContracts);
  assert.deepEqual(handoffResult.tests.filter(entry => !entry.ok), []);
  assert.deepEqual(handoffExceptions, []);
});
