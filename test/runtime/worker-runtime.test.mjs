import assert from "node:assert/strict";
import test from "node:test";
import { createClassicWorkerBootstrap } from "../../web/worker/classic.mjs";
import {
  createExecutableSourceRegistry,
  installWorkerRuntime,
  WorkerBootstrapProtocol,
} from "../../web/worker/common.mjs";
import { createModuleWorkerBootstrap } from "../../web/worker/module.mjs";
import { createSharedWorkerClassicBootstrap } from "../../web/worker/shared-classic.mjs";
import { createSharedWorkerModuleBootstrap } from "../../web/worker/shared-module.mjs";
import { createWorkletModuleBootstrap } from "../../web/worker/worklet.mjs";

const ABI = "__zp_abi_111111111111111111111111111111111111111111111111";

class FakeMessagePort {
  #closed = false;
  #listeners = [];
  #queued = [];
  #started = false;
  #peer = null;

  constructor() {
    this.sent = [];
  }

  connect(peer) {
    this.#peer = peer;
  }

  addEventListener(type, listener, options = {}) {
    assert.equal(type, "message");
    this.#listeners.push({ listener, once: options.once === true });
  }

  close() {
    this.#closed = true;
  }

  postMessage(data, transfer = []) {
    if (this.#closed) throw new DOMException("Port is closed", "InvalidStateError");
    this.sent.push(data);
    this.#peer.#enqueue({ data, ports: transfer });
  }

  start() {
    this.#started = true;
    this.#flush();
  }

  #enqueue(event) {
    if (this.#closed) return;
    this.#queued.push(event);
    this.#flush();
  }

  #flush() {
    if (!this.#started || this.#closed) return;
    while (this.#queued.length > 0) {
      const event = this.#queued.shift();
      const listeners = [...this.#listeners];
      for (const entry of listeners) {
        entry.listener(event);
        if (entry.once) this.#listeners.splice(this.#listeners.indexOf(entry), 1);
      }
    }
  }
}

function messageChannel() {
  const port1 = new FakeMessagePort();
  const port2 = new FakeMessagePort();
  port1.connect(port2);
  port2.connect(port1);
  return { port1, port2 };
}

function tick() {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function fakeGlobal() {
  const imports = [];
  const messages = [];
  const revoked = [];
  const timers = new Map();
  const trace = [];
  const globalListeners = new Map();
  let nextBlob = 0;
  let nextTimer = 0;
  class FakeURL extends URL {}
  Object.defineProperties(FakeURL, {
    createObjectURL: {
      configurable: true,
      value() { return `blob:fake/${++nextBlob}`; },
      writable: true,
    },
    revokeObjectURL: {
      configurable: true,
      value(url) { revoked.push(url); },
      writable: true,
    },
  });
  function FakeWorker(url, options) {
    this.options = options;
    this.url = url;
  }
  FakeWorker.prototype.terminate = function terminate() { this.terminated = true; };
  function RTCPeerConnection(configuration, constraints) {
    this.configuration = configuration;
    this.constraints = constraints;
  }
  function RTCDataChannel(label) {
    this.label = label;
  }
  function RTCIceCandidate(initialization) {
    this.initialization = initialization;
  }
  function RTCIceTransport() {}
  function WebTransport(url, options) {
    this.options = options;
    this.url = url;
  }
  function UDPSocket(options) {
    this.options = options;
  }
  function IdentityCredential() {}
  IdentityCredential.disconnect = function disconnect() {};
  function Notification(title, options) {
    this.options = options;
    this.title = title;
  }
  Notification.requestPermission = function requestPermission() {};
  function MediaDevices() {}
  MediaDevices.prototype.getUserMedia = function getUserMedia() {};
  const navigator = { mediaDevices: new MediaDevices() };
  class FakeMessageEvent {
    constructor(type, initialization = {}) {
      this.data = initialization.data;
      this.ports = initialization.ports ?? [];
      this.type = type;
    }
  }
  const fakeCache = { async match() { return undefined; } };
  const caches = {
    async delete() { return false; },
    async has() { return false; },
    async keys() { return []; },
    async match() { return undefined; },
    async open() { return fakeCache; },
  };
  const indexedDB = { open() { throw new Error("fake IndexedDB is not exercised"); } };
  const global = {
    Blob,
    Function,
    caches,
    indexedDB,
    URL: FakeURL,
    MessageEvent: FakeMessageEvent,
    Worker: FakeWorker,
    IdentityCredential,
    MediaDevices,
    navigator,
    Notification,
    RTCDataChannel,
    RTCIceTransport,
    RTCIceCandidate,
    RTCPeerConnection,
    UDPSocket,
    WebTransport,
    webkitRTCPeerConnection: RTCPeerConnection,
    addEventListener(type, listener) {
      let listeners = globalListeners.get(type);
      if (!listeners) {
        listeners = new Set();
        globalListeners.set(type, listeners);
      }
      listeners.add(listener);
    },
    clearInterval(id) { timers.delete(id); },
    clearTimeout(id) { timers.delete(id); },
    close() { global.closed = true; },
    dispatchEvent(event) {
      for (const listener of [...(globalListeners.get(event.type) ?? [])]) listener(event);
      return true;
    },
    eval(source) { global.evaluated = source; return source; },
    importScripts(url) {
      imports.push(url);
      trace.push(`import:${url}`);
    },
    postMessage(...arguments_) { messages.push(arguments_); },
    queueMicrotask(callback) { queueMicrotask(callback); },
    removeEventListener(type, listener) {
      globalListeners.get(type)?.delete(listener);
    },
    setInterval(callback, delay, ...arguments_) {
      const id = ++nextTimer;
      timers.set(id, { arguments_, callback, delay, type: "interval" });
      return id;
    },
    setTimeout(callback, delay, ...arguments_) {
      const id = ++nextTimer;
      timers.set(id, { arguments_, callback, delay, type: "timeout" });
      return id;
    },
  };
  const emit = (type, data, ports = []) => {
    for (const listener of [...(globalListeners.get(type) ?? [])]) listener({ data, ports });
  };
  const offer = (data, ports = []) => emit("message", data, ports);
  const connect = (port) => emit("connect", undefined, [port]);
  return { global, imports, messages, offer, connect, revoked, timers, trace };
}

function compilerSuccess(source, code = source) {
  return {
    schema_version: 1,
    ok: true,
    code,
    edits: [],
    edit_map: [],
    source_map: {
      version: 3,
      file: "zeroproxy://test/worker",
      sources: ["zeroproxy://test/worker"],
      sourcesContent: [source],
      names: [],
      mappings: "",
    },
    module_specifiers: [],
    source_url: null,
    source_mapping_url: null,
    diagnostics: [],
  };
}

function compilerFailure(sourceKind) {
  return {
    schema_version: 1,
    ok: false,
    code: null,
    edits: [],
    edit_map: [],
    source_map: null,
    module_specifiers: [],
    source_url: null,
    source_mapping_url: null,
    error: {
      code: "PARSE_FAILED",
      source_kind: sourceKind,
      stage: "parse",
      recoverability: "none",
    },
    diagnostics: [],
  };
}

function compiler(calls, failingSource = null) {
  return {
    compile(source, sourceKind, abiIdentifier, metadata) {
      calls.push({ abiIdentifier, metadata, source, sourceKind });
      if (source === failingSource) return compilerFailure(sourceKind);
      return compilerSuccess(source, `/* rewritten:${sourceKind} */${source}`);
    },
    compileDynamicFunction(parameters, body, sourceKind, abiIdentifier) {
      calls.push({
        abiIdentifier,
        body,
        dynamic: true,
        parameters: [...parameters],
        sourceKind,
      });
      if (body === failingSource) return compilerFailure(sourceKind);
      return {
        schema_version: 1,
        ok: true,
        body: compilerSuccess(body),
        parameters: parameters.map((parameter) => compilerSuccess(parameter)),
        diagnostics: [],
      };
    },
  };
}

function classicRoutes(events) {
  return {
    classic(context) {
      events.push(`route:${context.rawURL}`);
      return { controlled: true, url: `/_zp/classic/${context.rawURL}` };
    },
    classicRoot(context) {
      events.push(`root:${context.root_precompiled ? "precompiled" : context.compiled.code}`);
      return { controlled: true, url: "/_zp/classic/root" };
    },
    fetch() { return Promise.resolve(new Response()); },
    message() { return true; },
    resolveModule() { return { controlled: true, url: "/_zp/module/resolved" }; },
    worker(context) {
      events.push(`worker:${context.executable.kind}`);
      return { controlled: true, url: "/_zp/worker/bootstrap" };
    },
  };
}

function createFactory(createBootstrap, global, calls, events, options = {}) {
  return createBootstrap({
    global,
    createRuntimeConfiguration(initialization, port) {
      options.onConfiguration?.(initialization, port);
      return {
        abiIdentifier: ABI,
        compiler: options.compiler ?? compiler(calls),
        routes: options.routes ?? classicRoutes(events),
      };
    },
  });
}

async function initialize(factory, transferPort, sourceKind, source, targetURL = "https://target.example/worker.js", initialization = {}) {
  const { port1: parentPort, port2: workerPort } = messageChannel();
  const controlMessages = [];
  parentPort.addEventListener("message", (event) => controlMessages.push(event.data));
  parentPort.start();
  if (["SharedClassicWorker", "SharedModuleWorker"].includes(sourceKind)) {
    transferPort(workerPort);
  } else {
    transferPort({ v: WorkerBootstrapProtocol.version, operation: WorkerBootstrapProtocol.port }, [workerPort]);
  }
  await tick();
  parentPort.postMessage({
    bootstrap: initialization.bootstrap ?? {},
    root_precompiled: initialization.root_precompiled ?? true,
    v: WorkerBootstrapProtocol.version,
    operation: WorkerBootstrapProtocol.initialize,
    sequence: 0,
    source_kind: sourceKind,
    source,
    string_compilation_allowed: initialization.string_compilation_allowed ?? true,
    target_origin: "https://target.example",
    target_url: targetURL,
    worker_abi_identifier: initialization.worker_abi_identifier ?? ABI,
  });
  const runtime = await factory.ready;
  await tick();
  return { controlMessages, parentPort, runtime };
}
function assertDisabledNetworkSurface(global, runtime) {
  const expected = [
    ["IdentityCredential", "IdentityCredential"],
    ["Notification", "Notification"],
    ["RTCDataChannel", "RTCDataChannel"],
    ["RTCIceCandidate", "RTCIceCandidate"],
    ["RTCIceTransport", "RTCIceTransport"],
    ["RTCPeerConnection", "RTCPeerConnection"],
    ["UDPSocket", "UDPSocket"],
    ["WebTransport", "WebTransport"],
    ["webkitRTCPeerConnection", "RTCPeerConnection"],
  ];
  const rtcFacade = runtime.scope.RTCPeerConnection;
  assert.notEqual(rtcFacade, global.RTCPeerConnection);
  for (const [name, canonicalName] of expected) {
    const nativeConstructor = global[name];
    const facade = runtime.scope[name];
    assert.equal(typeof facade, "function");
    assert.equal(runtime.scope.globalThis[name], facade);
    assert.equal(facade.name, nativeConstructor.name);
    assert.equal(facade.length, nativeConstructor.length);
    assert.equal(facade.prototype, nativeConstructor.prototype);
    assert.equal(facade.prototype.constructor, facade);
    assert.throws(
      () => Reflect.apply(facade, undefined, []),
      error => error instanceof DOMException
        && error.name === "NotSupportedError"
        && error.message === `${canonicalName} is disabled by ZeroProxy policy`,
    );
    assert.throws(
      () => Reflect.construct(facade, []),
      error => error instanceof DOMException
        && error.name === "NotSupportedError"
        && error.message === `${canonicalName} is disabled by ZeroProxy policy`,
    );
    for (const owner of [runtime.scope, runtime.scope.globalThis]) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      assert.equal(descriptor.value, facade);
      assert.equal(descriptor.configurable, false);
      assert.equal(descriptor.writable, false);
    }
    const constructorDescriptor = Object.getOwnPropertyDescriptor(
      nativeConstructor.prototype,
      "constructor",
    );
    assert.equal(constructorDescriptor.value, facade);
    assert.equal(constructorDescriptor.configurable, false);
    assert.equal(constructorDescriptor.writable, false);
  }
  assert.equal(runtime.scope.RTCIceGatherer, undefined);
  assert.equal(runtime.scope.globalThis.RTCIceGatherer, undefined);
  assert.equal(global.RTCPeerConnection.name, "RTCPeerConnection");
  for (const [facade, label] of [
    [runtime.scope.IdentityCredential.disconnect, "IdentityCredential.disconnect"],
    [runtime.scope.Notification.requestPermission, "Notification.requestPermission"],
    [global.navigator.mediaDevices.getUserMedia, "MediaDevices.getUserMedia"],
  ]) {
    assert.throws(
      () => Reflect.apply(facade, undefined, []),
      error => error instanceof DOMException
        && error.name === "NotSupportedError"
        && error.message === `${label} is disabled by ZeroProxy policy`,
    );
  }
  assert.equal(global[ABI].runtimeHealth(), true);
}

test("worker and worklet realms expose only native-shaped disabled network capabilities", async () => {
  const worker = fakeGlobal();
  const workerFactory = createFactory(
    createClassicWorkerBootstrap,
    worker.global,
    [],
    [],
  );
  const { runtime: workerRuntime } = await initialize(
    workerFactory,
    worker.offer,
    "ClassicWorker",
    "self.ready = true",
  );
  assertDisabledNetworkSurface(worker.global, workerRuntime);
  workerRuntime.terminate();

  const worklet = fakeGlobal();
  const workletRuntime = installWorkerRuntime({
    abiIdentifier: ABI,
    compiler: compiler([]),
    global: worklet.global,
    routes: { message() { return true; } },
    sourceKind: "WorkletModule",
    stringCompilationAllowed: true,
    targetOrigin: "https://target.example",
    targetURL: "https://target.example/worklet.mjs",
  });
  assertDisabledNetworkSurface(worklet.global, workletRuntime);
  workletRuntime.terminate();
});


test("classic Worker accepts source only through the transferred port and preserves synchronous importScripts order", async () => {
  const { global, imports, offer, trace } = fakeGlobal();
  const calls = [];
  const factory = createFactory(createClassicWorkerBootstrap, global, calls, trace);
  assert.equal(factory.state, "AWAITING_PORT");

  offer({
    v: WorkerBootstrapProtocol.version,
    operation: WorkerBootstrapProtocol.port,
    source: "self.direct = true",
  });
  await tick();
  assert.equal(factory.state, "AWAITING_PORT");
  assert.deepEqual(calls, []);

  const { controlMessages, runtime } = await initialize(
    factory,
    offer,
    "ClassicWorker",
    "self.ready = true",
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(controlMessages.map((message) => message.operation), [
    WorkerBootstrapProtocol.portReady,
    WorkerBootstrapProtocol.ready,
  ]);
  const abiNames = Reflect.ownKeys(global)
    .filter((key) => typeof key === "string" && /^__zp_abi_[a-f0-9]{48}$/u.test(key));
  const abiDescriptor = Object.getOwnPropertyDescriptor(global, ABI);
  assert.deepEqual(abiNames, [ABI]);
  assert.equal(abiDescriptor.configurable, false);
  assert.equal(abiDescriptor.enumerable, false);
  assert.equal(abiDescriptor.writable, false);
  assert.equal(Object.isFrozen(abiDescriptor.value), true);
  assert.equal(abiDescriptor.value.scope.self !== global, true);
  assert.equal(runtime.location.href, "https://target.example/worker.js");
  assert.equal(runtime.origin, "https://target.example");

  runtime.scope.importScripts("first.js", "second.js");
  assert.deepEqual(trace, [
    "root:precompiled",
    "import:/_zp/classic/root",
    "route:first.js",
    "import:/_zp/classic/first.js",
    "route:second.js",
    "import:/_zp/classic/second.js",
  ]);
  assert.deepEqual(imports, [
    "/_zp/classic/root",
    "/_zp/classic/first.js",
    "/_zp/classic/second.js",
  ]);
  runtime.terminate();
});
test("dedicated workers fail closed when native persistent storage is unavailable", async () => {
  for (const storageName of ["caches", "indexedDB"]) {
    const { global, offer } = fakeGlobal();
    delete global[storageName];
    const factory = createFactory(createClassicWorkerBootstrap, global, [], []);
    await assert.rejects(
      initialize(factory, offer, "ClassicWorker", "self.ready = true"),
      error => error?.name === "SecurityError",
    );
  }
});

test("module Worker installs its ABI before the port-authorized controlled module graph executes", async () => {
  const { global, offer } = fakeGlobal();
  const calls = [];
  const events = [];
  const marker = `__zp_module_worker_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  let configuredPort;
  const controlPayloads = [];
  const factory = createFactory(createModuleWorkerBootstrap, global, calls, events, {
    onConfiguration(_initialization, port) {
      configuredPort = port;
      port.addEventListener("message", (event) => controlPayloads.push(event.data.sequence));
      port.start();
    },
    routes: {
      message() { return true; },
      module(context) {
        events.push({ specifier: context.specifier, targetURL: context.targetURL });
        return { controlled: true, url: "data:text/javascript,export default 7" };
      },
      moduleRoot(context) {
        events.push(context.root_precompiled);
        assert.equal("compiled" in context, false);
        assert.equal(Object.getOwnPropertyDescriptor(global, ABI).value.scope.globalThis !== global, true);
        return {
          controlled: true,
          url: `data:text/javascript,globalThis[${JSON.stringify(marker)}]=true`,
        };
      },
      resolveModule() { return { controlled: true, url: "/_zp/module/resolved" }; },
    },
  });
  try {
    const { parentPort, runtime } = await initialize(
      factory,
      offer,
      "ModuleWorker",
      "export const ready = true",
      "https://target.example/worker.mjs",
    );
    assert.deepEqual(calls, []);
    assert.equal(configuredPort instanceof FakeMessagePort, true);
    assert.equal(parentPort instanceof FakeMessagePort, true);
    assert.deepEqual(events, [true]);
    assert.equal(globalThis[marker], true);
    const nestedURL = "https://target.example/nested/child.mjs";
    const nativeMeta = Object.freeze({ url: "data:text/javascript,controlled" });
    const nestedABI = global[ABI].moduleContext(nativeMeta, nestedURL);
    assert.equal(global[ABI].moduleContext(nativeMeta, nestedURL), nestedABI);
    assert.equal(nestedABI.importMeta.url, nestedURL);
    assert.equal(nestedABI.importMeta.resolve("./dependency.mjs"), "https://target.example/nested/dependency.mjs");
    let coerced = false;
    const imported = nestedABI.importModule({
      toString() {
        coerced = true;
        return "./dynamic.mjs";
      },
    });
    assert.equal(coerced, false, "dynamic import coercion remains asynchronous");
    assert.equal((await imported).default, 7);
    assert.equal(coerced, true);
    assert.deepEqual(events.at(-1), { specifier: "./dynamic.mjs", targetURL: nestedURL });
    parentPort.postMessage({ sequence: 1 });
    parentPort.postMessage({ sequence: 2 });
    await tick();
    assert.deepEqual(controlPayloads, [1, 2]);
    runtime.terminate();
  } finally {
    delete globalThis[marker];
  }
});

test("malformed initialization and compiler failure reject before a target route or target execution", async () => {
  const invalid = fakeGlobal();
  const invalidCalls = [];
  const invalidFactory = createFactory(createClassicWorkerBootstrap, invalid.global, invalidCalls, []);
  const invalidChannel = messageChannel();
  const invalidMessages = [];
  invalidChannel.port1.addEventListener("message", (event) => invalidMessages.push(event.data));
  invalidChannel.port1.start();
  invalid.offer({ v: WorkerBootstrapProtocol.version, operation: WorkerBootstrapProtocol.port }, [invalidChannel.port2]);
  invalidChannel.port1.postMessage({
    v: WorkerBootstrapProtocol.version,
    operation: WorkerBootstrapProtocol.initialize,
    sequence: 1,
    source_kind: "ClassicWorker",
    source: "self.never = true",
    target_origin: "https://target.example",
    target_url: "https://target.example/worker.js",
  });
  await assert.rejects(invalidFactory.ready, (error) => error.name === "SecurityError");
  assert.deepEqual(invalidCalls, []);
  assert.equal(invalid.global.closed, true);
  assert.equal(invalidMessages.at(-1).operation, WorkerBootstrapProtocol.rejected);
  const failed = fakeGlobal();
  const failedCalls = [];
  const failedEvents = [];
  const failedFactory = createFactory(createClassicWorkerBootstrap, failed.global, failedCalls, failedEvents, {
    compiler: compiler(failedCalls, "malformed"),
  });

  const { runtime: failedRuntime } = await initialize(
    failedFactory,
    failed.offer,
    "ClassicWorker",
    "malformed",
  );
  assert.throws(
    () => failedRuntime.scope.eval("malformed"),
    (error) => error instanceof SyntaxError,
  );
  assert.equal(failedCalls.at(-1).source, "malformed");
  assert.deepEqual(failed.imports, ["/_zp/classic/root"]);
  failedRuntime.terminate();
});

test("port bootstrap requires the explicit fixed-ABI precompiled-root contract before target routing", async () => {
  const raw = fakeGlobal();
  const calls = [];
  const events = [];
  const factory = createFactory(createClassicWorkerBootstrap, raw.global, calls, events);
  await assert.rejects(
    initialize(
      factory,
      raw.offer,
      "ClassicWorker",
      "self.raw = true",
      "https://target.example/worker.js",
      { root_precompiled: false },
    ),
    error => error.name === "SecurityError",
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);
  assert.deepEqual(raw.imports, []);
  assert.equal(raw.global.closed, true);
});

test("worker direct eval requires and forwards caller strictness metadata", async () => {
  const raw = fakeGlobal();
  const intrinsicEval = raw.global.eval;
  const calls = [];
  const factory = createFactory(createClassicWorkerBootstrap, raw.global, calls, []);
  const { runtime } = await initialize(
    factory,
    raw.offer,
    "ClassicWorker",
    "self.ready = true",
  );
  const abi = raw.global[ABI];
  const rawDescriptor = Object.getOwnPropertyDescriptor(raw.global, "eval");
  const scopeDescriptor = Object.getOwnPropertyDescriptor(runtime.scope, "eval");
  const facadeDescriptor = Object.getOwnPropertyDescriptor(runtime.scope.globalThis, "eval");
  for (const descriptor of [rawDescriptor, scopeDescriptor, facadeDescriptor]) {
    assert.equal(descriptor.configurable, false);
    assert.equal(descriptor.enumerable, true);
    assert.equal(descriptor.writable, false);
  }
  assert.equal(rawDescriptor.value, intrinsicEval);
  assert.equal(scopeDescriptor.value, runtime.scope.eval);
  assert.equal(facadeDescriptor.value, runtime.scope.eval);
  assert.equal(abi.runtimeHealth(), true);

  let attackerCalled = false;
  const attacker = () => { attackerCalled = true; };
  assert.equal(Reflect.set(raw.global, "eval", attacker), false);
  assert.equal(Reflect.deleteProperty(raw.global, "eval"), false);
  assert.equal(Reflect.set(runtime.scope, "eval", attacker), false);
  assert.equal(Reflect.deleteProperty(runtime.scope, "eval"), false);
  assert.equal(Reflect.set(runtime.scope.globalThis, "eval", attacker), false);
  assert.equal(Reflect.deleteProperty(runtime.scope.globalThis, "eval"), false);
  const directSource = abi.evalSource("direct", { caller_strict: false });
  assert.equal(Reflect.apply(raw.global.eval, raw.global, [directSource]), directSource);
  assert.equal(raw.global.evaluated, directSource);
  assert.equal(attackerCalled, false);
  assert.throws(
    () => raw.global[ABI].evalSource("value"),
    error => error.name === "SecurityError",
  );
  assert.equal(
    raw.global[ABI].evalSource("value", { caller_strict: true }),
    "/* rewritten:DirectEvalScript */value",
  );
  assert.deepEqual(calls.at(-1), {
    abiIdentifier: ABI,
    metadata: { caller_strict: true },
    source: "value",
    sourceKind: "DirectEvalScript",
  });
  runtime.terminate();
});

test("worker bootstrap rejects accessor-backed eval without invoking it", async () => {
  const raw = fakeGlobal();
  const calls = [];
  let getterCalls = 0;
  Object.defineProperty(raw.global, "eval", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      return () => undefined;
    },
  });
  const factory = createFactory(createClassicWorkerBootstrap, raw.global, calls, []);
  await assert.rejects(
    initialize(
      factory,
      raw.offer,
      "ClassicWorker",
      "self.ready = true",
    ),
    error => error.name === "SecurityError",
  );
  assert.equal(getterCalls, 0);
  assert.equal(Object.hasOwn(raw.global, ABI), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(raw.imports, []);
});

test("worker Function families compile converted formals with the body", async () => {
  const raw = fakeGlobal();
  const nativeConstructors = {
    AsyncFunction: Object.getPrototypeOf(async function () {}).constructor,
    AsyncGeneratorFunction: Object.getPrototypeOf(async function* () {}).constructor,
    Function,
    GeneratorFunction: Object.getPrototypeOf(function* () {}).constructor,
  };
  const calls = [];
  const factory = createFactory(createClassicWorkerBootstrap, raw.global, calls, [], {
    compiler: compiler(calls, "invalid body"),
  });
  const { runtime } = await initialize(
    factory,
    raw.offer,
    "ClassicWorker",
    "self.ready = true",
  );
  const conversionOrder = [];
  const parameter = {
    toString() {
      conversionOrder.push("parameter");
      return "fetch";
    },
  };
  const body = {
    toString() {
      conversionOrder.push("body");
      return "return fetch";
    },
  };
  const dynamic = runtime.scope.Function(parameter, body);
  assert.deepEqual(conversionOrder, ["parameter", "body"]);
  assert.equal(dynamic(37), 37);
  assert.equal(
    Function.prototype.toString.call(dynamic),
    "function anonymous(fetch\n) {\nreturn fetch\n}",
  );
  assert.deepEqual(calls.at(-1), {
    abiIdentifier: ABI,
    body: "return fetch",
    dynamic: true,
    parameters: ["fetch"],
    sourceKind: "FunctionBody",
  });
  const families = [
    {
      body: "return 7",
      name: "Function",
      sourceKind: "FunctionBody",
      verify: async (value) => assert.equal(value(), 7),
    },
    {
      body: "return 7",
      name: "AsyncFunction",
      sourceKind: "AsyncFunctionBody",
      verify: async (value) => assert.equal(await value(), 7),
    },
    {
      body: "yield 7",
      name: "GeneratorFunction",
      sourceKind: "GeneratorFunctionBody",
      verify: async (value) => assert.deepEqual(value().next(), { done: false, value: 7 }),
    },
    {
      body: "yield 7",
      name: "AsyncGeneratorFunction",
      sourceKind: "AsyncGeneratorFunctionBody",
      verify: async (value) => assert.deepEqual(
        await value().next(),
        { done: false, value: 7 },
      ),
    },
  ];
  for (const family of families) {
    const facade = runtime.scope[family.name];
    const native = nativeConstructors[family.name];
    assert.equal(facade.name, native.name);
    assert.equal(facade.length, native.length);
    assert.equal(Object.getPrototypeOf(facade), Object.getPrototypeOf(native));
    assert.equal(facade.prototype, native.prototype);
    assert.equal(facade.prototype.constructor, facade);
    assert.equal(
      Function.prototype.toString.call(facade),
      Function.prototype.toString.call(native),
    );
    assert.doesNotMatch(
      Function.prototype.toString.call(facade),
      /DynamicFunctionFacade/u,
    );
    const called = Reflect.apply(facade, { ignored: true }, [family.body]);
    const constructed = Reflect.construct(facade, [family.body]);
    for (const value of [called, constructed]) {
      const source = Function.prototype.toString.call(value);
      assert.match(source, new RegExp(family.body, "u"));
      assert.doesNotMatch(source, /__zp_abi_|rewritten:/u);
    }
    assert.equal(Object.getPrototypeOf(called), native.prototype);
    assert.equal(Object.getPrototypeOf(constructed), native.prototype);
    assert.equal(called instanceof facade, true);
    assert.equal(constructed instanceof facade, true);
    await family.verify(called);
    await family.verify(constructed);
    function CustomNewTarget() {}
    const customPrototype = Object.create(null);
    CustomNewTarget.prototype = customPrototype;
    const custom = Reflect.construct(facade, [family.body], CustomNewTarget);
    assert.equal(Object.getPrototypeOf(custom), customPrototype);
    assert.equal(custom instanceof CustomNewTarget, true);
    await family.verify(custom);
    assert.equal(calls.at(-1).sourceKind, family.sourceKind);
  }
  assert.equal(
    Object.getPrototypeOf(function () {}).constructor,
    runtime.scope.Function,
  );
  assert.equal(
    Object.getPrototypeOf(async function () {}).constructor,
    runtime.scope.AsyncFunction,
  );
  assert.equal(
    Object.getPrototypeOf(function* () {}).constructor,
    runtime.scope.GeneratorFunction,
  );
  assert.equal(
    Object.getPrototypeOf(async function* () {}).constructor,
    runtime.scope.AsyncGeneratorFunction,
  );
  assert.equal(runtime.scope.Function()(), undefined);
  assert.deepEqual(calls.at(-1), {
    abiIdentifier: ABI,
    body: "",
    dynamic: true,
    parameters: [],
    sourceKind: "FunctionBody",
  });
  const compilerCalls = calls.length;
  assert.throws(() => runtime.scope.Function(Symbol("body")), TypeError);
  const sentinel = new Error("coercion stopped");
  const first = {
    [Symbol.toPrimitive]() {
      conversionOrder.push("first");
      return "value";
    },
  };
  const second = {
    [Symbol.toPrimitive]() {
      conversionOrder.push("second");
      throw sentinel;
    },
  };
  assert.throws(() => runtime.scope.Function(first, second), (error) => error === sentinel);
  assert.deepEqual(conversionOrder.slice(-2), ["first", "second"]);
  assert.equal(calls.length, compilerCalls);
  assert.throws(() => runtime.scope.Function("invalid body"), SyntaxError);
  runtime.terminate();
});

test("worker indirect eval and timer strings retain native conversion and realm semantics", async () => {
  const raw = fakeGlobal();
  const calls = [];
  const factory = createFactory(createClassicWorkerBootstrap, raw.global, calls, [], {
    compiler: compiler(calls, "return invalid"),
  });
  const { runtime } = await initialize(
    factory,
    raw.offer,
    "ClassicWorker",
    "self.ready = true",
  );
  const indirectEval = runtime.scope.eval;
  assert.equal(runtime.scope.globalThis.eval, indirectEval);
  assert.equal(runtime.scope.self.eval, indirectEval);
  assert.notEqual(raw.global.eval, indirectEval);
  assert.equal(indirectEval.name, raw.global.eval.name);
  assert.equal(indirectEval.length, raw.global.eval.length);
  assert.equal(
    Function.prototype.toString.call(indirectEval),
    Function.prototype.toString.call(raw.global.eval),
  );
  const nonString = Object.freeze({ value: 1 });
  assert.throws(() => indirectEval("return invalid"), SyntaxError);
  const compilerCalls = calls.length;
  assert.equal(indirectEval(nonString), nonString);
  assert.equal(calls.length, compilerCalls);
  const evaluations = [
    indirectEval("location.href"),
    (0, indirectEval)("self.location.href"),
    indirectEval?.("globalThis.location.href"),
    indirectEval.call({ ignored: true }, "typeof fetch"),
    indirectEval.apply(null, ["typeof postMessage"]),
    Reflect.apply(indirectEval, undefined, ["typeof Function"]),
  ];
  assert.deepEqual(evaluations, [
    "/* rewritten:IndirectEvalScript */location.href",
    "/* rewritten:IndirectEvalScript */self.location.href",
    "/* rewritten:IndirectEvalScript */globalThis.location.href",
    "/* rewritten:IndirectEvalScript */typeof fetch",
    "/* rewritten:IndirectEvalScript */typeof postMessage",
    "/* rewritten:IndirectEvalScript */typeof Function",
  ]);
  assert.deepEqual(
    calls.slice(compilerCalls).map(({ source, sourceKind }) => ({ source, sourceKind })),
    [
      { source: "location.href", sourceKind: "IndirectEvalScript" },
      { source: "self.location.href", sourceKind: "IndirectEvalScript" },
      { source: "globalThis.location.href", sourceKind: "IndirectEvalScript" },
      { source: "typeof fetch", sourceKind: "IndirectEvalScript" },
      { source: "typeof postMessage", sourceKind: "IndirectEvalScript" },
      { source: "typeof Function", sourceKind: "IndirectEvalScript" },
    ],
  );

  let functionTimerInvocation = null;
  function functionHandler(...arguments_) {
    functionTimerInvocation = { arguments_, receiver: this };
  }
  const beforeFunctionTimer = calls.length;
  const functionTimerID = runtime.scope.setTimeout(functionHandler, 9, "first", 2);
  assert.equal(calls.length, beforeFunctionTimer);
  const functionTimer = raw.timers.get(functionTimerID);
  assert.equal(typeof functionTimer.callback, "function");
  functionTimer.callback(...functionTimer.arguments_);
  assert.deepEqual(functionTimerInvocation.arguments_, ["first", 2]);
  assert.equal(functionTimerInvocation.receiver, raw.global);

  let stringConversions = 0;
  const stringHandler = {
    toString() {
      stringConversions += 1;
      return "postMessage('timer')";
    },
  };
  const stringTimerID = runtime.scope.setInterval(stringHandler, 11, "extra");
  assert.equal(stringConversions, 1);
  assert.deepEqual(calls.at(-1), {
    abiIdentifier: ABI,
    metadata: undefined,
    source: "postMessage('timer')",
    sourceKind: "TimerString",
  });
  assert.deepEqual(raw.timers.get(stringTimerID), {
    arguments_: ["extra"],
    callback: "/* rewritten:TimerString */postMessage('timer')",
    delay: 11,
    type: "interval",
  });
  runtime.terminate();
});

test("worker string compilation policy denies every string path after native coercion", async () => {
  const raw = fakeGlobal();
  const calls = [];
  const factory = createFactory(createClassicWorkerBootstrap, raw.global, calls, []);
  const { runtime } = await initialize(
    factory,
    raw.offer,
    "ClassicWorker",
    "self.ready = true",
    "https://target.example/worker.js",
    { string_compilation_allowed: false },
  );
  const compilerCalls = calls.length;
  const nonString = Object.freeze({ sentinel: true });
  assert.equal(runtime.scope.eval(nonString), nonString);
  assert.equal(raw.global[ABI].evalSource(nonString, { caller_strict: false }), nonString);
  let attackerEvalErrorCalled = false;
  runtime.scope.globalThis.EvalError = function AttackerEvalError() {
    attackerEvalErrorCalled = true;
  };
  assert.throws(
    () => runtime.scope.eval("location.href"),
    (error) => error.constructor === EvalError,
  );
  assert.equal(attackerEvalErrorCalled, false);
  assert.throws(() => runtime.scope.eval("location.href"), EvalError);
  assert.throws(
    () => raw.global[ABI].evalSource("location.href", { caller_strict: false }),
    EvalError,
  );
  const constructors = [
    runtime.scope.Function,
    runtime.scope.AsyncFunction,
    runtime.scope.GeneratorFunction,
    runtime.scope.AsyncGeneratorFunction,
  ];
  for (const constructor of constructors) {
    assert.throws(() => constructor("return 1"), EvalError);
    assert.throws(() => Reflect.construct(constructor, ["return 1"]), EvalError);
  }
  let conversions = 0;
  assert.throws(() => runtime.scope.Function({
    toString() {
      conversions += 1;
      return "return 1";
    },
  }), EvalError);
  assert.equal(conversions, 1);
  assert.throws(() => runtime.scope.Function(Symbol("body")), TypeError);
  assert.throws(
    () => runtime.scope.Function("value", "value", "'use strict';return value"),
    EvalError,
  );
  let timerConversions = 0;
  assert.throws(() => runtime.scope.setTimeout({
    toString() {
      timerConversions += 1;
      return "postMessage('blocked')";
    },
  }, 0), EvalError);
  assert.equal(timerConversions, 1);
  assert.equal(raw.timers.size, 0);
  let functionTimerCalled = false;
  const timerID = runtime.scope.setTimeout(() => {
    functionTimerCalled = true;
  }, 0);
  raw.timers.get(timerID).callback();
  assert.equal(functionTimerCalled, true);
  assert.equal(calls.length, compilerCalls);
  runtime.terminate();
});

test("executable source registry follows Fetch data decoding and module MIME boundaries", () => {
  const { global } = fakeGlobal();
  const registry = createExecutableSourceRegistry(global);
  assert.equal(
    registry.capture("data:,postMessage('%E9')", "ClassicWorker").source,
    "postMessage('é')",
  );
  assert.equal(
    registry.capture("data:text/javascript,postMessage('%ZZ')", "ClassicWorker").source,
    "postMessage('%ZZ')",
  );
  assert.equal(
    registry.capture("data:text/javascript;charset=windows-1252,postMessage('%E9')", "ModuleWorker").source,
    "postMessage('é')",
  );
  assert.equal(
    registry.capture("data:text/javascript;charset=invalid-label,postMessage('fallback')", "ModuleWorker").source,
    "postMessage('fallback')",
  );
  const fragmented = registry.capture(
    "data:text/javascript,postMessage('fragment')#ignored-source",
    "ClassicWorker",
  );
  assert.equal(fragmented.source, "postMessage('fragment')");
  assert.equal(fragmented.url, "data:text/javascript,postMessage('fragment')#ignored-source");
  assert.throws(
    () => registry.capture("data:text/plain,export default 1", "ModuleWorker"),
    error => error.name === "SecurityError",
  );
  const blobURL = registry.createObjectURL(new global.Blob([], { type: "text/plain" }));
  const classicBlob = registry.capture(blobURL, "ClassicWorker");
  classicBlob.release();
  assert.throws(
    () => registry.capture(blobURL, "ModuleWorker"),
    error => error.name === "SecurityError",
  );
  class ForgedBlob extends global.Blob {
    get type() { return "text/javascript"; }
  }
  const forgedURL = registry.createObjectURL(new ForgedBlob([], { type: "text/plain" }));
  assert.throws(
    () => registry.capture(forgedURL, "ModuleWorker"),
    error => error.name === "SecurityError",
  );
  registry.revokeObjectURL(forgedURL);
  registry.revokeObjectURL(blobURL);
});

test("blob and data worker sources are captured once at consumption and revocation remains native-compatible", async () => {
  const { global, offer, revoked } = fakeGlobal();
  const calls = [];
  const events = [];
  const factory = createFactory(createClassicWorkerBootstrap, global, calls, events);
  const { runtime } = await initialize(factory, offer, "ClassicWorker", "self.ready = true");
  const blob = new global.Blob(["postMessage('blob')"], { type: "text/javascript" });
  const blobURL = global.URL.createObjectURL(blob);
  const nested = new runtime.scope.Worker(blobURL);
  assert.equal(nested.url, "/_zp/worker/bootstrap");
  assert.deepEqual(events, [
    "root:precompiled",
    "worker:blob",
  ]);

  global.URL.revokeObjectURL(blobURL);
  assert.deepEqual(revoked, [blobURL]);
  assert.throws(
    () => new runtime.scope.Worker(blobURL),
    (error) => error.name === "SecurityError",
  );

  new runtime.scope.Worker("data:text/javascript,postMessage('rewritten')");
  assert.equal(calls.at(-1).source, "postMessage('rewritten')");
  assert.equal(calls.at(-1).sourceKind, "ClassicWorker");
  assert.equal(events.at(-1), "worker:data");
  new runtime.scope.Worker("data:text/plain,unclassified");
  assert.equal(calls.at(-1).source, "unclassified");
  new runtime.scope.Worker("data:text/javascript;charset=windows-1252,postMessage('%E9')");
  assert.equal(calls.at(-1).source, "postMessage('é')");
  new runtime.scope.Worker("data:text/javascript,postMessage('%ZZ')");
  assert.equal(calls.at(-1).source, "postMessage('%ZZ')");
  runtime.terminate();
  assert.equal(nested.terminated, true);
});

test("port-authorized worker messaging retains transfers and terminate cancels timers and controlled work", async () => {
  const { global, messages, offer, timers } = fakeGlobal();
  const calls = [];
  const events = [];
  let aborted = false;
  const factory = createFactory(createClassicWorkerBootstrap, global, calls, events, {
    routes: {
      ...classicRoutes(events),
      fetch({ signal }) {
        return new Promise((resolve) => signal.addEventListener("abort", () => {
          aborted = true;
          resolve("aborted");
        }, { once: true }));
      },
    },
  });
  const { runtime } = await initialize(factory, offer, "ClassicWorker", "self.ready = true");
  const transfer = { transferable: true };
  runtime.scope.postMessage({ value: 1 }, [transfer]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0][1][0], transfer);

  const asyncConstructor = Object.getPrototypeOf(async function () {}).constructor;
  assert.equal(typeof asyncConstructor("return 1"), "function");
  assert.equal(calls.at(-1).sourceKind, "AsyncFunctionBody");
  runtime.scope.setTimeout("postMessage('timer')", 10);
  assert.equal(calls.at(-1).sourceKind, "TimerString");
  assert.equal(timers.size, 1);
  const pending = runtime.scope.fetch("https://target.example/data");
  runtime.terminate();
  assert.equal(await pending, "aborted");
  assert.equal(aborted, true);
  assert.equal(timers.size, 0);
  assert.equal(global.closed, true);
});

test("unsupported SharedWorker and worklet module initializations fail closed without target-module dispatch", async () => {
  const shared = fakeGlobal();
  const sharedCalls = [];
  let targetModuleRequests = 0;
  const sharedFactory = createFactory(
    createSharedWorkerModuleBootstrap,
    shared.global,
    sharedCalls,
    [],
    { routes: { message() { return true; } } },
  );
  await assert.rejects(
    initialize(sharedFactory, shared.connect, "SharedModuleWorker", "export const value = 1", "https://target.example/shared.mjs"),
    (error) => error.name === "SecurityError",
  );
  assert.equal(targetModuleRequests, 0);
  assert.deepEqual(shared.imports, []);

  const worklet = fakeGlobal();
  const workletCalls = [];
  const workletFactory = createFactory(
    createWorkletModuleBootstrap,
    worklet.global,
    workletCalls,
    [],
    {
      compiler: compiler(workletCalls, "broken module"),
      routes: {
        message() { return true; },
        moduleRoot() {
          targetModuleRequests += 1;
          return { controlled: true, url: "/_zp/worklet/root" };
        },
      },
    },
  );
  await assert.rejects(
    initialize(workletFactory, worklet.offer, "WorkletModule", "broken module", "https://target.example/worklet.mjs"),
    (error) => error.name === "SecurityError",
  );
  assert.equal(targetModuleRequests, 1);
}
);

test("direct configuration is rejected and the classic SharedWorker factory uses its distinct typed port protocol", async () => {
  const direct = fakeGlobal();
  assert.throws(
    () => createClassicWorkerBootstrap({
      global: direct.global,
      source: "self.not_allowed = true",
      createRuntimeConfiguration() { return {}; },
    }),
    (error) => error.name === "SecurityError",
  );

  const shared = fakeGlobal();
  const calls = [];
  const factory = createFactory(createSharedWorkerClassicBootstrap, shared.global, calls, []);
  const { runtime } = await initialize(
    factory,
    shared.connect,
    "SharedClassicWorker",
    "onconnect = () => {}",
    "https://target.example/shared.js",
  );
  assert.deepEqual(calls, []);
  runtime.terminate();
});