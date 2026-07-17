import assert from "node:assert/strict";
import test from "node:test";

const originID = "a".repeat(32);
const browseOrigin = `https://o-${originID}.browse.example.test`;
const rootWorkerURL = `${browseOrigin}/_zp/sw.js`;

class FakePort {
  constructor() {
    this.onmessage = null;
    this.peer = null;
    this.closed = false;
  }
  postMessage(data) {
    queueMicrotask(() => this.peer?.onmessage?.({ data }));
  }
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

function installBootstrapRealm({ sharedWorker = true } = {}) {
  const original = new Map();
  const install = (name, value) => {
    original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const states = [];
  const commands = [];
  const replacements = [];
  const globalListeners = new Map();
  const workerListeners = new Map();
  const status = { value: "" };
  const dataset = new Proxy({}, {
    set(target, key, value) {
      target[key] = value;
      if (key === "bootstrapState") states.push(value);
      return true;
    },
  });
  let iframe;
  const coordinatorPort = new FakePort();
  coordinatorPort.close = () => {};
  const attachedState = {
    profile_id: "profile",
    session_id: "session",
    tab_id: "t".repeat(32),
    entry_id: "e".repeat(32),
    destination_origin_id: originID,
    destination_host: `o-${originID}.browse.example.test`,
    capability_epoch: 1,
    document_capability: "capability",
    lineage_revision: 1,
    target_url: "https://target.example/",
    ancestor_urls: [],
    form_submission: null,
    isolation_username: "U".repeat(43),
    isolation_password: "P".repeat(43),
    relay_profile_digests: ["A".repeat(43)],
    relay_profiles: [{ profile_id: "relay-profile" }],
    relay_capabilities: [{ capability_id: "relay", relay_profile_digest: "A".repeat(43) }],
    coordinator_revision: 7,
  };

  const controller = {
    scriptURL: rootWorkerURL,
    postMessage(message) {
      commands.push(message.operation);
      const result = message.operation === "ALLOCATE_DOCUMENT_ROUTE"
        ? { path: `/_zp/p/document/${"r".repeat(32)}` }
        : { accepted: true };
      message.replyPort.postMessage({ v: 2, request_id: message.command_id, ok: true, result });
    },
  };
  const serviceWorker = {
    controller: null,
    addEventListener(type, listener) { workerListeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (workerListeners.get(type) === listener) workerListeners.delete(type);
    },
    async register(path, options) {
      assert.equal(path, "/_zp/sw.js");
      assert.deepEqual(options, { scope: "/", type: "module", updateViaCache: "none" });
      this.controller = controller;
      workerListeners.get("controllerchange")?.();
      return { scope: `${browseOrigin}/` };
    },
  };

  install("document", {
    documentElement: {
      dataset,
      append(element) { iframe = element; },
    },
    querySelector(selector) {
      assert.equal(selector, "#status");
      return status;
    },
    createElement(name) {
      assert.equal(name, "iframe");
      const listeners = new Map();
      const contentWindow = {
        postMessage(message, targetOrigin) {
          assert.equal(targetOrigin, "https://control.test");
          assert.deepEqual(message, {
            v: 2,
            operation: "ATTACH",
            handoff_id: "h".repeat(32),
            nonce: "n".repeat(24),
          });
          queueMicrotask(() => globalListeners.get("message")?.({
            source: contentWindow,
            origin: targetOrigin,
            data: { v: 2, operation: "ATTACHED", state: attachedState },
            ports: [coordinatorPort],
          }));
        },
      };
      return {
        hidden: false,
        referrerPolicy: "",
        src: "",
        contentWindow,
        addEventListener(type, listener) {
          listeners.set(type, listener);
          if (type === "load") queueMicrotask(listener);
        },
        remove() { this.removed = true; },
      };
    },
  });
  install("location", {
    hash: `#handoff=${"h".repeat(32)}&nonce=${"n".repeat(24)}`,
    pathname: "/",
    search: "",
    origin: browseOrigin,
    hostname: `o-${originID}.browse.example.test`,
    host: `o-${originID}.browse.example.test`,
    replace(path) { replacements.push(path); },
  });
  install("history", {
    replaceState(state, title, path) { assert.deepEqual([state, title, path], [null, "", "/"]); },
  });
  install("navigator", { serviceWorker });
  install("MessageChannel", FakeMessageChannel);
  install("Worker", class {});
  install("SharedWorker", sharedWorker ? class {} : undefined);
  install("fetch", async (url) => {
    assert.equal(url, "/_zp/config");
    return {
      ok: true,
      async json() { return { control_host: "control.test", browse_domain: "example.test" }; },
    };
  });
  install("addEventListener", (type, listener) => globalListeners.set(type, listener));
  install("removeEventListener", (type, listener) => {
    if (globalListeners.get(type) === listener) globalListeners.delete(type);
  });

  return {
    commands,
    replacements,
    states,
    status,
    iframe: () => iframe,
    restore() {
      for (const [name, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("bootstrap oracle timed out");
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

test("bootstrap follows the exact fail-closed sequence and sole worker path", async (t) => {
  const realm = installBootstrapRealm();
  t.after(() => realm.restore());
  await import(`../../web/bootstrap.mjs?order=${Date.now()}`);
  await waitFor(() => realm.replacements.length === 1);
  assert.deepEqual(realm.states, [
    "UNCONTROLLED",
    "REGISTERING_SW",
    "WAITING_FOR_CONTROLLER",
    "CONNECTING_COORDINATOR",
    "VERIFYING_HOST_BINDING",
    "HYDRATING_ORIGIN_STATE",
    "WARMING_REWRITERS",
    "WARMING_KERNEL",
    "READY_TO_NAVIGATE",
  ]);
  assert.deepEqual(realm.commands, [
    "ATTACH_COORDINATOR",
    "WAIT_TARGET_WORKER_HOST",
    "WARM_REWRITERS",
    "WARM_KERNEL",
    "ALLOCATE_DOCUMENT_ROUTE",
  ]);
  assert.equal(realm.iframe().removed, true, "control bridge is removed before target navigation");
  assert.deepEqual(realm.replacements, [`/_zp/p/document/${"r".repeat(32)}`]);
});

test("bootstrap reports BROWSER_UNSUPPORTED before registration fallback", async (t) => {
  const realm = installBootstrapRealm({ sharedWorker: false });
  t.after(() => realm.restore());
  await import(`../../web/bootstrap.mjs?unsupported=${Date.now()}`);
  await waitFor(() => realm.states.at(-1) === "BLOCKED");
  assert.deepEqual(realm.states, ["UNCONTROLLED", "BLOCKED"]);
  assert.equal(realm.status.value, "Blocked safely: BROWSER_UNSUPPORTED");
  assert.deepEqual(realm.commands, []);
});
