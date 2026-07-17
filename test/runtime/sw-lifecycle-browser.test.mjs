import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { REQUEST_PHASES } from "../../web/sw/request-lifecycle.mjs";

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
  if (file.endsWith(".mjs") || file.endsWith(".js")) return "text/javascript;charset=utf-8";
  if (file.endsWith(".json")) return "application/json;charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function durableCrashHook() {
  return `
self.addEventListener("message", event => {
  if (event.data?.operation !== "__ZERO_PROXY_TEST_STAGE_DOCUMENT") return;
  event.stopImmediatePropagation();
  const replyPort = event.ports[0];
  const operation = (async () => {
    const payload = event.data.payload;
    const requestEvent = {
      request: new Request(self.location.origin + "/_zp/test-stage-document"),
      resultingClientId: payload.client_id,
      waitUntil() {},
    };
    const authority = requestLifecycleAuthority("target-route", requestEvent);
    await authority.advanceTo("TRANSFORMING_IF_REQUIRED");
    const route = {
      id: payload.route_id,
      kind: "resource",
      profile_id: originState.profile_id,
      tab_id: originState.tab_id,
      entry_id: payload.entry_id,
      origin_id: originState.destination_origin_id,
      target_url: originState.target_url,
      abi_identifier: "__zp_abi_" + "b".repeat(48),
      expires_at: Date.now() + 300000,
      consumed: false,
    };
    await stageDocumentRoutes([route], requestEvent);
    await bindDocumentClient(requestEvent, route, payload.runtime_capability);
    replyPort.postMessage({ ok: true, request_id: authority.snapshot().id });
  })().catch(error => replyPort.postMessage({ ok: false, error: error?.stack ?? String(error) }));
  event.waitUntil(operation);
});
`;
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

test("shipped worker persists cold state and leaves compatible update waiting", { timeout: 30_000 }, async (t) => {
  const executablePath = chromiumPath();
  assert.ok(executablePath, "pinned Chromium is required");
  const manifest = JSON.parse(await readFile(path.join(dist, "_zp/version.json"), "utf8"));
  const initialWrapper = await readFile(path.join(dist, "_zp/sw.js"), "utf8");
  const workerModulePath = /import "([^"]+\/sw\/sw\.mjs)";/.exec(initialWrapper)?.[1];
  assert.ok(workerModulePath, "service-worker module asset is discoverable");
  const workerModule = await readFile(path.resolve(dist, `.${workerModulePath}`), "utf8");
  const instrumentedWorkerModule = `${durableCrashHook()}\n${workerModule}`;
  const updateHash = "e".repeat(64);
  const updateArtifactHash = "f".repeat(64);
  const updatedWrapper = initialWrapper
    .replace(manifest.compatibility_tuple.artifact_set_sha256, updateArtifactHash)
    .replace(manifest.compatibility_hash, updateHash);
  assert.notEqual(updatedWrapper, initialWrapper);
  let serveUpdate = false;
  const requests = [];

  const server = http.createServer((request, response) => void (async () => {
    const url = new URL(request.url, "http://127.0.0.1");
    requests.push(url.pathname);
    if (url.pathname === "/oracle") {
      response.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" })
        .end("<!doctype html><title>lifecycle oracle</title>");
      return;
    }
    if (url.pathname === "/_zp/target-worker-host") {
      response.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" })
        .end("<!doctype html><title>persistent execution host fixture</title>");
      return;
    }
    if (url.pathname === "/_zp/sw.js") {
      response.writeHead(200, {
        "Content-Type": "text/javascript;charset=utf-8",
        "Cache-Control": "no-cache",
        "Service-Worker-Allowed": "/",
      }).end(serveUpdate ? updatedWrapper : initialWrapper);
      return;
    }
    if (url.pathname === workerModulePath) {
      response.writeHead(200, {
        "Content-Type": "text/javascript;charset=utf-8",
        "Cache-Control": "no-store",
      }).end(instrumentedWorkerModule);
      return;
    }
    const file = path.resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(`${dist}${path.sep}`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  })());
  const port = await listen(server);
  const originID = "a".repeat(32);
  const syntheticHost = `o-${originID}.browse.localhost:${port}`;
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  t.after(async () => {
    await browser.close();
    await close(server);
  });

  const page = await browser.newPage();
  await page.goto(`http://${syntheticHost}/oracle`, { waitUntil: "load" });
  try {
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/_zp/sw.js", {
        scope: "/",
        type: "module",
        updateViaCache: "none",
      });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
      }
    });
  } catch (error) {
    throw new Error(`service worker startup failed after ${JSON.stringify(requests)}`, { cause: error });
  }

  const initial = await page.evaluate(async (workerHash) => {
    const db = await new Promise((resolve, reject) => {
      const opening = indexedDB.open("zeroproxy-v2-origin", 6);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const read = key => new Promise((resolve, reject) => {
      const request = db.transaction("meta", "readonly").objectStore("meta").get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = {
      active: await read("lifecycle:active"),
      lifecycle: await read(`lifecycle:${workerHash}`),
      controller: navigator.serviceWorker.controller.scriptURL,
    };
    db.close();
    return result;
  }, manifest.compatibility_hash);
  assert.equal(initial.active.worker_version, manifest.compatibility_hash);
  assert.equal(initial.lifecycle.state, "READY_COLD");
  assert.equal(initial.lifecycle.transition_revision, 4);
  assert.match(initial.controller, /\/_zp\/sw\.js$/);

  const attachmentPayload = {
    profile_id: "profile",
    session_id: "session",
    tab_id: "tab",
    entry_id: "entry",
    destination_origin_id: originID,
    destination_host: syntheticHost,
    capability_epoch: 1,
    coordinator_revision: 1,
    document_capability: "document-capability",
    lineage_revision: 1,
    target_url: "https://example.test/",
    ancestor_urls: [],
    form_submission: null,
    isolation_username: "U".repeat(43),
    isolation_password: "P".repeat(43),
    relay_profile_digests: ["A".repeat(43)],
    relay_profiles: [{
      profile_id: "relay-profile",
      relay_wss_origin: "wss://relay.example.test",
      carrier_path: "/_zp/carrier",
      expires_at: "2099-01-01T00:00:00.000Z",
      allowed_target_ports: [443],
    }],
    relay_capabilities: [{
      capability_id: "relay-capability",
      relay_profile_digest: "A".repeat(43),
      relay_url: "wss://relay.example.test/_zp/carrier",
      expires_at: "2099-01-01T00:00:00.000Z",
      allowed_target_ports: [443],
    }],
  };
  const commandID = "r".repeat(32);
  async function attachCoordinator() {
    return page.evaluate(async (payload, id) => {
      const coordinator = new MessageChannel();
      coordinator.port1.onmessage = event => {
        const request = event.data;
        let result;
        if (request.operation === "TARGET_WORKER_JOURNAL_LOAD") {
          globalThis.__targetWorkerJournalFixture ??= {
            revision: 0,
            state: {
              binding: request.payload.binding,
              clients: [],
              operations: {},
              registrations: [],
              schema_version: 1,
            },
          };
          result = structuredClone(globalThis.__targetWorkerJournalFixture);
        } else if (request.operation === "TARGET_WORKER_JOURNAL_CAS") {
          globalThis.__targetWorkerJournalFixture = {
            revision: request.payload.expected_revision + 1,
            state: structuredClone(request.payload.state),
          };
          result = { applied: true, ...structuredClone(globalThis.__targetWorkerJournalFixture) };
        } else {
          result = {
            profile_id: payload.profile_id,
            origin_id: payload.destination_origin_id,
            tab_id: payload.tab_id,
            capability_epoch: payload.capability_epoch,
            cookie_capability: "cookie-capability",
            top_level_site: "https://example.test",
          };
        }
        coordinator.port1.postMessage({
          v: 2,
          request_id: request.request_id,
          ok: true,
          revision: 2,
          result,
        });
      };
      coordinator.port1.start();
      const reply = new MessageChannel();
      const response = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("attach timeout")), 3000);
        reply.port1.onmessage = event => {
          clearTimeout(timeout);
          resolve(event.data);
        };
        reply.port1.start();
      });
      navigator.serviceWorker.controller.postMessage({
        v: 2,
        command_id: id,
        operation: "ATTACH_COORDINATOR",
        payload,
        replyPort: reply.port2,
      }, [reply.port2, coordinator.port2]);
      return response;
    }, attachmentPayload, commandID);
  }
  assert.deepEqual(await attachCoordinator(), { v: 2, request_id: commandID, ok: true, result: { attached: true } });
  const hostBinding = {
    profile_id: attachmentPayload.profile_id,
    synthetic_origin: `http://${syntheticHost}`,
    client_epoch: attachmentPayload.capability_epoch,
    capability: "H".repeat(43),
  };
  const hostPage = await browser.newPage();
  await hostPage.goto(`http://${syntheticHost}/_zp/target-worker-host`, { waitUntil: "load" });
  async function hostCommand(operation, id) {
    return hostPage.evaluate(async ({ operation, id, binding }) => {
      const reply = new MessageChannel();
      const response = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${operation} timeout`)), 3000);
        reply.port1.onmessage = event => {
          clearTimeout(timeout);
          resolve(event.data);
        };
        reply.port1.start();
      });
      const message = {
        v: 2,
        command_id: id,
        operation,
        payload: binding,
        replyPort: reply.port2,
      };
      const transfers = [reply.port2];
      if (operation === "ATTACH_TARGET_WORKER_HOST") {
        const privateChannel = new MessageChannel();
        privateChannel.port1.onmessage = event => {
          const ping = event.data;
          if (ping?.type !== "HOST_RUNTIME_PING") return;
          privateChannel.port1.postMessage({
            v: 1,
            type: "HOST_RUNTIME_PONG",
            reply_to: ping.message_id,
            binding: ping.binding,
          });
        };
        privateChannel.port1.start();
        globalThis.__targetWorkerHostTestPort = privateChannel.port1;
        transfers.push(privateChannel.port2);
      }
      navigator.serviceWorker.controller.postMessage(message, transfers);
      return response;
    }, { operation, id, binding: hostBinding });
  }
  assert.deepEqual(await hostCommand("ATTACH_TARGET_WORKER_HOST", "h".repeat(32)), {
    v: 2,
    request_id: "h".repeat(32),
    ok: true,
    result: { attached: true, client_epoch: 1 },
  });
  assert.deepEqual(await hostCommand("PROBE_TARGET_WORKER_HOST", "p".repeat(32)), {
    v: 2,
    request_id: "p".repeat(32),
    ok: true,
    result: { attached: true },
  });
  const waitedForHost = await page.evaluate(async () => {
    const reply = new MessageChannel();
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("host wait timeout")), 3000);
      reply.port1.onmessage = event => {
        clearTimeout(timeout);
        resolve(event.data);
      };
      reply.port1.start();
    });
    navigator.serviceWorker.controller.postMessage({
      v: 2,
      command_id: "w".repeat(32),
      operation: "WAIT_TARGET_WORKER_HOST",
      payload: {},
      replyPort: reply.port2,
    }, [reply.port2]);
    return response;
  });
  assert.deepEqual(waitedForHost, {
    v: 2,
    request_id: "w".repeat(32),
    ok: true,
    result: { attached: true, client_epoch: 1 },
  });
  const abandonedRouteID = "y".repeat(32);
  const abandonedEntryID = "x".repeat(32);
  const abandonedClientID = "abandoned-client";
  const staged = await page.evaluate(async payload => {
    const reply = new MessageChannel();
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("durable stage timeout")), 3000);
      reply.port1.onmessage = event => {
        clearTimeout(timeout);
        resolve(event.data);
      };
      reply.port1.start();
    });
    navigator.serviceWorker.controller.postMessage({
      operation: "__ZERO_PROXY_TEST_STAGE_DOCUMENT",
      payload,
    }, [reply.port2]);
    return response;
  }, {
    client_id: abandonedClientID,
    entry_id: abandonedEntryID,
    route_id: abandonedRouteID,
    runtime_capability: "r".repeat(32),
  });
  assert.equal(staged.ok, true, staged.error);
  const abandonedRequestID = staged.request_id;
  const beforeCrash = await page.evaluate(async ({ id, routeID, entryID, clientID }) => {
    const db = await new Promise((resolve, reject) => {
      const opening = indexedDB.open("zeroproxy-v2-origin", 6);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const transaction = db.transaction(["request_journal", "routes", "clients", "history_keys"], "readonly");
    const read = request => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const requests = [
      read(transaction.objectStore("request_journal").get(id)),
      read(transaction.objectStore("routes").get(routeID)),
      read(transaction.objectStore("clients").get(clientID)),
      read(transaction.objectStore("history_keys").get(entryID)),
    ];
    const result = await Promise.all(requests);
    db.close();
    return result;
  }, {
    id: abandonedRequestID,
    routeID: abandonedRouteID,
    entryID: abandonedEntryID,
    clientID: abandonedClientID,
  });
  assert.equal(beforeCrash[0].state, "TRANSFORMING_IF_REQUIRED");
  assert.deepEqual(beforeCrash[0].resources, [
    { type: "route_ids", ids: [abandonedRouteID] },
    { type: "document_binding", client_id: abandonedClientID, entry_id: abandonedEntryID },
  ]);
  assert.equal(beforeCrash[1].id, abandonedRouteID);
  assert.equal(beforeCrash[2].client_id, abandonedClientID);
  assert.equal(beforeCrash[3].entry_id, abandonedEntryID);

  const rootSession = await browser.target().createCDPSession();
  const targets = await rootSession.send("Target.getTargets");
  const workerTarget = targets.targetInfos.find(target => target.type === "service_worker"
    && target.url.endsWith("/_zp/sw.js"));
  assert.ok(workerTarget, "active service-worker target is observable before forced stop");
  await rootSession.send("Target.closeTarget", { targetId: workerTarget.targetId });
  await new Promise(resolve => setTimeout(resolve, 100));

  assert.deepEqual(await attachCoordinator(), { v: 2, request_id: commandID, ok: true, result: { attached: true } });
  assert.deepEqual(await hostCommand("PROBE_TARGET_WORKER_HOST", "q".repeat(32)), {
    v: 2,
    request_id: "q".repeat(32),
    ok: true,
    result: { attached: false },
  });
  assert.deepEqual(await hostCommand("ATTACH_TARGET_WORKER_HOST", "i".repeat(32)), {
    v: 2,
    request_id: "i".repeat(32),
    ok: true,
    result: { attached: true, client_epoch: 1 },
  });
  assert.deepEqual(await hostCommand("PROBE_TARGET_WORKER_HOST", "j".repeat(32)), {
    v: 2,
    request_id: "j".repeat(32),
    ok: true,
    result: { attached: true },
  });
  const unknown = await page.evaluate(async () => {
    const response = await fetch("/_zp/not-a-route");
    return { status: response.status, body: await response.text() };
  });
  assert.deepEqual(unknown, { status: 403, body: "ZeroProxy blocked: UNKNOWN_REQUEST" });
  const replayed = await page.evaluate(async id => {
    const version = await fetch("/_zp/version.json").then(response => response.json());
    const db = await new Promise((resolve, reject) => {
      const opening = indexedDB.open("zeroproxy-v2-origin", 6);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const transaction = db.transaction(["command_journal", "meta", "request_journal", "routes", "clients", "history_keys"], "readonly");
    const commandRequest = transaction.objectStore("command_journal").get(id);
    const requestJournalRequest = transaction.objectStore("request_journal").getAll();
    const abandonedRouteRequest = transaction.objectStore("routes").get("y".repeat(32));
    const abandonedClientRequest = transaction.objectStore("clients").get("abandoned-client");
    const abandonedHistoryRequest = transaction.objectStore("history_keys").get("x".repeat(32));
    const lifecycleRequest = transaction.objectStore("meta").get(
      `lifecycle:${version.compatibility_hash}`,
    );
    const read = request => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const commandPromise = read(commandRequest);
    const lifecyclePromise = read(lifecycleRequest);
    const requestsPromise = read(requestJournalRequest);
    const abandonedRoutePromise = read(abandonedRouteRequest);
    const abandonedClientPromise = read(abandonedClientRequest);
    const abandonedHistoryPromise = read(abandonedHistoryRequest);
    const result = {
      command: await commandPromise,
      lifecycle: await lifecyclePromise,
      requests: await requestsPromise,
      abandonedRoute: await abandonedRoutePromise,
      abandonedClient: await abandonedClientPromise,
      abandonedHistory: await abandonedHistoryPromise,
    };
    db.close();
    return result;
  }, commandID);
  assert.equal(replayed.command.state, "REPLIED");
  assert.equal(replayed.command.attempt, 1, "commit-before-reply replay does not repeat durable work");
  assert.equal(replayed.lifecycle.state, "HYDRATING");
  assert.ok(replayed.requests.length > 0, "native fetch checkpoints are durable");
  assert.ok(replayed.requests.every(record => [
    "COMPLETE", "POLICY_BLOCKED", "ABORTED", "TIMED_OUT", "TRANSPORT_FAILED",
    "REWRITE_FAILED", "CLIENT_GONE", "VERSION_MISMATCH",
  ].includes(record.state)), "no request checkpoint remains live after response consumption");
  const policyBlockedRequest = replayed.requests.find(record => record.state === "POLICY_BLOCKED");
  assert.equal(policyBlockedRequest?.request_class, "unknown");
  assert.deepEqual(policyBlockedRequest?.checkpoints.map(record => record.state), [
    "CLASSIFIED", "POLICY_BLOCKED",
  ]);
  const completeRequest = replayed.requests.find(record => record.state === "COMPLETE");
  assert.deepEqual(completeRequest?.checkpoints.map(record => record.state), REQUEST_PHASES);
  const abandoned = replayed.requests.find(record => record.id === abandonedRequestID);
  assert.equal(abandoned?.state, "CLIENT_GONE");
  assert.equal(abandoned?.error_code, "SERVICE_WORKER_RESTART");
  assert.equal(abandoned?.resource_count, 0);
  assert.equal(replayed.abandonedRoute, undefined);
  assert.equal(replayed.abandonedClient, undefined);
  assert.equal(replayed.abandonedHistory, undefined);

  serveUpdate = true;
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    await registration.update();
  });
  await page.waitForFunction(() => navigator.serviceWorker.getRegistration("/").then(registration => Boolean(registration?.waiting)), { timeout: 3000 }).catch(async error => {
    const diagnostic = await page.evaluate(async workerHash => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const db = await new Promise((resolve, reject) => {
        const opening = indexedDB.open("zeroproxy-v2-origin", 6);
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error);
      });
      const request = db.transaction("meta", "readonly").objectStore("meta").get(`lifecycle:${workerHash}`);
      const lifecycle = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return {
        active: registration.active?.state,
        installing: registration.installing?.state,
        waiting: registration.waiting?.state,
        lifecycle,
      };
    }, updateHash);
    throw new Error(`${error.message}: ${JSON.stringify(diagnostic)}`);
  });

  const update = await page.evaluate(async (workerHash) => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const db = await new Promise((resolve, reject) => {
      const opening = indexedDB.open("zeroproxy-v2-origin", 6);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const read = key => new Promise((resolve, reject) => {
      const request = db.transaction("meta", "readonly").objectStore("meta").get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = {
      active: await read("lifecycle:active"),
      lifecycle: await read(`lifecycle:${workerHash}`),
      hasWaiting: Boolean(registration.waiting),
      controller: navigator.serviceWorker.controller.scriptURL,
    };
    db.close();
    await registration.unregister();
    return result;
  }, updateHash);
  assert.equal(update.hasWaiting, true);
  assert.equal(update.lifecycle.state, "INSTALLED_WAITING");
  assert.equal(update.lifecycle.previous_worker_version, manifest.compatibility_hash);
  assert.equal(update.active.worker_version, manifest.compatibility_hash, "waiting update never replaces active worker");
  assert.equal(update.controller, initial.controller, "existing document remains on compatible active worker");
});
