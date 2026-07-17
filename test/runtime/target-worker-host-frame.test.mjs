import assert from "node:assert/strict";
import test from "node:test";

class FakePort {
  constructor() {
    this.onmessage = null;
    this.peer = null;
    this.closed = false;
  }
  postMessage(data) { queueMicrotask(() => this.peer?.onmessage?.({ data })); }
  close() { this.closed = true; }
  start() {}
}

class FakeMessageChannel {
  constructor() {
    this.port1 = new FakePort();
    this.port2 = new FakePort();
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

async function waitFor(predicate, nativeSetTimeout) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("target worker host frame oracle timed out");
    await new Promise(resolve => nativeSetTimeout(resolve, 0));
  }
}

test("persistent execution-host frame announces readiness then retries its bound root attachment", async (t) => {
  const original = new Map();
  const install = (name, value) => {
    original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const nativeSetTimeout = globalThis.setTimeout;
  t.after(() => {
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  const origin = "https://o-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.browse.example.test";
  const controlOrigin = "https://control.test";
  const listeners = new Map();
  const sequence = [];
  const workers = [];
  const status = { value: "" };
  let timerID = 0;
  let attachAttempts = 0;
  const controller = {
    scriptURL: `${origin}/_zp/sw.js`,
    postMessage(message, ports) {
      assert.equal(ports[0], message.replyPort);
      if (message.operation === "ATTACH_TARGET_WORKER_HOST") {
        attachAttempts += 1;
        sequence.push(`attach:${attachAttempts}`);
        assert.deepEqual(Object.keys(message.payload).sort(), ["capability", "client_epoch", "profile_id", "synthetic_origin"]);
        assert.equal(message.payload.synthetic_origin, origin);
        assert.equal(message.payload.client_epoch, 9);
        assert.match(message.payload.capability, /^[A-Za-z0-9_-]{43}$/u);
        message.replyPort.postMessage(attachAttempts === 1
          ? {
            v: 2,
            request_id: message.command_id,
            ok: false,
            error: {
              code: "TARGET_WORKER_HOST_UNAVAILABLE",
              stage: "VIRTUAL_SERVICE_WORKER",
              retryable: true,
              request_id: message.command_id,
              message_key: "virtual_service_worker_unavailable",
            },
          }
          : { v: 2, request_id: message.command_id, ok: true, result: { attached: true, client_epoch: 9 } });
        return;
      }
      if (message.operation === "PROBE_TARGET_WORKER_HOST") {
        message.replyPort.postMessage({ v: 2, request_id: message.command_id, ok: true, result: { attached: true } });
        return;
      }
      throw new Error(`unexpected host command ${message.operation}`);
    },
  };
  const serviceWorker = {
    controller,
    addEventListener() {},
    removeEventListener() {},
    async register(path, options) {
      assert.equal(path, "/_zp/sw.js");
      assert.deepEqual(options, { scope: "/", type: "module", updateViaCache: "none" });
      return { scope: `${origin}/` };
    },
  };
  const parent = {
    postMessage(message, targetOrigin) {
      sequence.push("ready");
      assert.equal(targetOrigin, controlOrigin);
      assert.deepEqual(message, {
        v: 2,
        operation: "TARGET_WORKER_HOST_READY",
        profile_id: "profile",
        synthetic_origin: origin,
        client_epoch: 9,
        capability: "A".repeat(43),
      });
    },
  };
  const self = {};

  install("document", {
    documentElement: { dataset: {} },
    querySelector(selector) { assert.equal(selector, "#status"); return status; },
  });
  install("location", { origin, pathname: "/_zp/target-worker-host", search: "", hash: "" });
  install("navigator", { serviceWorker });
  install("MessageChannel", FakeMessageChannel);
  install("Worker", class {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.terminated = false;
      workers.push(this);
    }
    postMessage(message, ports) {
      assert.deepEqual(message, { v: 1, type: "ATTACH_TARGET_WORKER_PORT" });
      assert.equal(ports.length, 1);
    }
    terminate() { this.terminated = true; }
  });
  install("crypto", { getRandomValues(bytes) { bytes.fill(0); return bytes; } });
  install("fetch", async url => {
    if (url === "/_zp/config") return {
      ok: true,
      async json() { return { control_host: "control.test", browse_domain: "example.test" }; },
    };
    assert.equal(url, "/_zp/version.json");
    return {
      ok: true,
      async json() {
        return {
          version: 2,
          selectors: {
            "target-worker-host-classic.js": `/_zp/assets/${"f".repeat(64)}/target-worker-host-classic.js`,
          },
        };
      },
    };
  });
  install("addEventListener", (type, listener) => listeners.set(type, listener));
  install("removeEventListener", (type, listener) => {
    if (listeners.get(type) === listener) listeners.delete(type);
  });
  install("setTimeout", (callback, milliseconds) => {
    const id = ++timerID;
    if (milliseconds === 100) queueMicrotask(callback);
    return id;
  });
  install("clearTimeout", () => {});
  install("parent", parent);
  install("top", {});
  install("self", self);

  await import(`../../web/target-worker-host.mjs?oracle=${Date.now()}`);
  await waitFor(() => listeners.has("message"), nativeSetTimeout);
  listeners.get("message")({
    source: parent,
    origin: controlOrigin,
    data: {
      v: 2,
      operation: "CONFIGURE_TARGET_WORKER_HOST",
      profile_id: "profile",
      synthetic_origin: origin,
      client_epoch: 9,
      capability: "A".repeat(43),
    },
  });
  await waitFor(() => attachAttempts === 2, nativeSetTimeout);

  assert.deepEqual(sequence, ["ready", "attach:1", "attach:2"]);
  assert.equal(workers.length, 2);
  assert.equal(workers[0].terminated, true, "rejected host worker is disposable");
  assert.equal(workers[1].terminated, false);
  assert.equal(status.value, "Execution host attached");
});
