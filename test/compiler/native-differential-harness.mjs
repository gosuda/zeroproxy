import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ABI_IDENTIFIER = "__zp_abi_9d5e1aa229f6498e2f4b7c5803d2af021661eb2945416a7c";
let compilerPromise;

export async function pathExists(candidate) {
  if (!candidate) return false;
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function loadProductCompiler({
  bindingPath = path.join(ROOT, "dist/bindings/js_compiler/js_compiler.js"),
  wasmPath = path.join(ROOT, "dist/bindings/js_compiler/js_compiler_bg.wasm"),
} = {}) {
  if (!compilerPromise) {
    compilerPromise = (async () => {
      const module = await import(`${new URL(`file://${bindingPath}`).href}?differential=1`);
      module.initSync({ module: await readFile(wasmPath) });
      return Object.freeze({
        abiIdentifier: ABI_IDENTIFIER,
        compile(source, sourceKind) {
          let encoded;
          try {
            encoded = module.compile_json(source, sourceKind, ABI_IDENTIFIER);
          } catch (error) {
            throw new Error(`product compiler failed: ${String(error)}`, { cause: error });
          }
          const result = JSON.parse(encoded);
          if (result?.ok !== true) {
            throw new Error(result?.error?.code ?? "INVALID_COMPILER_RESULT");
          }
          assert.equal(result.schema_version, 1, "compiler must return the supported schema");
          assert.equal(typeof result.code, "string", "compiler must return executable output");
          assert.ok(Array.isArray(result.edits), "compiler must return edit metadata");
          assert.ok(Array.isArray(result.edit_map), "compiler must return byte edit maps");
          assert.equal(result.source_map?.version, 3, "compiler must return Source Map v3");
          return Object.freeze(result);
        },
        compileDynamicFunction(parameters, body, sourceKind) {
          let encoded;
          try {
            encoded = module.compile_dynamic_function_json(
              JSON.stringify(parameters),
              body,
              sourceKind,
              ABI_IDENTIFIER,
            );
          } catch (error) {
            throw new Error(`product dynamic compiler failed: ${String(error)}`, { cause: error });
          }
          const result = JSON.parse(encoded);
          if (result?.ok !== true) {
            throw new Error(result?.error?.code ?? "INVALID_DYNAMIC_COMPILER_RESULT");
          }
          assert.ok(Array.isArray(result.parameters), "dynamic compiler must return parameters");
          assert.equal(result.schema_version, 1, "dynamic compiler must return the supported schema");
          assert.equal(typeof result.body?.code, "string", "dynamic compiler must return a body");
          return Object.freeze(result);
        },
      });
    })();
  }
  return compilerPromise;
}

function launchOptions(lane) {
  return {
    browser: lane.family === "firefox" ? "firefox" : "chrome",
    executablePath: lane.binaryPath,
    headless: true,
    protocol: lane.family === "firefox" ? "webDriverBiDi" : "cdp",
    args: lane.family === "chromium" ? ["--disable-gpu", "--no-sandbox"] : [],
  };
}

export async function withBrowserLane(lane, callback) {
  assert.match(lane.family, /^(?:chromium|firefox)$/u);
  assert.equal(await pathExists(lane.binaryPath), true, `${lane.family} binary is unavailable: ${lane.binaryPath}`);
  const browser = await puppeteer.launch(launchOptions(lane));
  try {
    return await callback(browser);
  } finally {
    await browser.close();
  }
}

function normalizeRealmObservation(value) {
  if (typeof value === "string") return value.replaceAll(/blob:(?:https?:\/\/[^/]+|null)\/[0-9a-f-]{36}/gu, "blob:<realm-module>");
  if (Array.isArray(value)) return value.map(normalizeRealmObservation);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeRealmObservation(entry)]));
}

const COVERED_NATIVE_HOSTS = Object.freeze([
  ["ClassicScriptExternal", "classic-script-external"],
  ["ClassicScriptInline", "classic-script-inline"],
  ["ModuleScript", "module-script"],
  ["DirectEvalScript", "direct-eval"],
  ["IndirectEvalScript", "indirect-eval"],
  ["TimerString", "timer-string"],
  ["FunctionBody", "function-body"],
  ["AsyncFunctionBody", "async-function-body"],
  ["GeneratorFunctionBody", "generator-function-body"],
  ["AsyncGeneratorFunctionBody", "async-generator-function-body"],
  ["EventHandler", "event-handler"],
  ["JavaScriptURL", "javascript-url"],
  ["ClassicWorker", "classic-worker"],
  ["ModuleWorker", "module-worker"],
  ["SharedClassicWorker", "shared-classic-worker"],
  ["SharedModuleWorker", "shared-module-worker"],
  ["TargetServiceWorkerClassic", "service-worker-classic"],
  ["TargetServiceWorkerModule", "service-worker-module"],
  ["WorkletModule", "worklet-module"],
].map(([sourceKind, host]) => Object.freeze({ sourceKind, host })));

const DEFERRED_NATIVE_HOSTS = Object.freeze([]);

export const NATIVE_HOST_COVERAGE = Object.freeze({
  covered: COVERED_NATIVE_HOSTS,
  deferred: DEFERRED_NATIVE_HOSTS,
});

const NATIVE_HOST_BY_SOURCE_KIND = new Map(COVERED_NATIVE_HOSTS.map((entry) => [entry.sourceKind, entry.host]));
const DEFERRED_HOST_BY_SOURCE_KIND = new Map(DEFERRED_NATIVE_HOSTS.map((entry) => [entry.sourceKind, entry.reason]));

export class NativeHostUnavailableError extends Error {
  constructor(sourceKind, reason) {
    super(`NATIVE_HOST_UNSUPPORTED: ${sourceKind}: ${reason}`);
    this.name = "NativeHostUnavailableError";
    this.code = "NATIVE_HOST_UNSUPPORTED";
    this.sourceKind = sourceKind;
  }
}

function nativeHostFor(sourceKind) {
  const host = NATIVE_HOST_BY_SOURCE_KIND.get(sourceKind);
  if (host) return host;
  const reason = DEFERRED_HOST_BY_SOURCE_KIND.get(sourceKind);
  if (reason) throw new NativeHostUnavailableError(sourceKind, reason);
  throw new NativeHostUnavailableError(sourceKind, "source kind is not in the exact wire enum");
}

function realmHarnessSource(source, abiIdentifier, suffix) {
  return `globalThis.effects=[];{
const scope=new Proxy(Object.create(null),{
get(_target,property){return globalThis[property]},
set(_target,property,value){return Reflect.set(globalThis,property,value)},
deleteProperty(_target,property){return Reflect.deleteProperty(globalThis,property)},
has(_target,property){return Reflect.has(globalThis,property)}
});
const abi=Object.freeze({
scope,
thisValue(value){return value},
evalSource(value){return value},
indirectEval(value){return typeof value==="string"?(0,eval)(value):value},
dynamicFunction(_family,_callKind,_newTarget,rawArgs){return Function(...rawArgs)},
importOperand(value){return value},
moduleMeta(nativeMeta,originalURL){const resolve=nativeMeta.resolve;return Object.freeze({url:originalURL,resolve:typeof resolve==="function"?resolve.bind(nativeMeta):undefined})},
moduleContext(nativeMeta,originalURL){return Object.freeze({...abi,importMeta:abi.moduleMeta(nativeMeta,originalURL),importModule:(value,options)=>import(value,options)})},
sourceRegistry:new Map(),
runtimeHealth(){return Object.freeze({ready:true,abi_identifier:${JSON.stringify(abiIdentifier)}})}
});
Object.defineProperty(globalThis,${JSON.stringify(abiIdentifier)},{value:abi,configurable:true});
}
${source}
${suffix}`;
}

async function startOracleServer(serviceWorkerSource) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/oracle-sw.js") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/javascript; charset=utf-8",
        "Service-Worker-Allowed": "/",
      });
      response.end(serviceWorkerSource);
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end("<!doctype html><meta charset=utf-8><title>compiler oracle</title>");
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return Object.freeze({
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  });
}

async function observeSource(browser, { source, sourceKind, abiIdentifier }) {
  const host = nativeHostFor(sourceKind);
  const serviceWorkerSource = realmHarnessSource(
    source,
    abiIdentifier,
    `addEventListener("message",event=>event.ports[0].postMessage({effects}));`,
  );
  const oracleServer = await startOracleServer(serviceWorkerSource);
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const network = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:")
      && url.hostname !== "127.0.0.1") {
      network.push({ method: request.method(), protocol: url.protocol, host: url.host, pathname: url.pathname });
    }
  });
  try {
    await page.goto(oracleServer.origin, { waitUntil: "load" });
    const observed = await page.evaluate(async ({ source, host, abiIdentifier, oracleOrigin }) => {
      const effects = [];
      const events = [];
      const sourceRegistry = new Map();
      globalThis.effects = effects;
      globalThis.__zpEvents = events;

      function installAbi(target) {
        const scope = new Proxy(Object.create(null), {
          get(_target, property) { return target[property]; },
          set(_target, property, value) { return Reflect.set(target, property, value); },
          deleteProperty(_target, property) { return Reflect.deleteProperty(target, property); },
          has(_target, property) { return Reflect.has(target, property); },
        });
        const abi = Object.freeze({
          scope,
          thisValue(value) { return value; },
          evalSource(value) { return value; },
          indirectEval(value) { return typeof value === "string" ? (0, target.eval)(value) : value; },
          dynamicFunction(_family, _callKind, _newTarget, rawArgs) { return target.Function(...rawArgs); },
          importOperand(value) { return value; },
          moduleMeta(nativeMeta, originalURL) {
            const resolve = nativeMeta.resolve;
            return Object.freeze({
              resolve: typeof resolve === "function" ? resolve.bind(nativeMeta) : undefined,
              url: originalURL,
            });
          },
          moduleContext(nativeMeta, originalURL) {
            return Object.freeze({
              ...abi,
              importMeta: abi.moduleMeta(nativeMeta, originalURL),
              importModule: (value, options) => import(value, options),
            });
          },
          sourceRegistry,
          runtimeHealth() { return Object.freeze({ ready: true, abi_identifier: abiIdentifier }); },
        });
        Object.defineProperty(target, abiIdentifier, { value: abi, configurable: true });
      }
      installAbi(globalThis);

      const seen = new WeakMap();
      let nextIdentity = 1;
      function encode(value, depth = 0) {
        if (value === undefined) return { type: "undefined" };
        if (value === null) return { type: "null" };
        if (typeof value === "number") {
          if (Number.isNaN(value)) return { type: "number", value: "NaN" };
          if (Object.is(value, -0)) return { type: "number", value: "-0" };
          if (value === Infinity) return { type: "number", value: "Infinity" };
          if (value === -Infinity) return { type: "number", value: "-Infinity" };
          return { type: "number", value };
        }
        if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
        if (typeof value === "string" || typeof value === "boolean") return { type: typeof value, value };
        if (typeof value === "symbol") return { type: "symbol", value: String(value), global: Symbol.keyFor(value) ?? null };
        if ((typeof value !== "object" && typeof value !== "function") || depth >= 5) return { type: typeof value, value: String(value) };
        if (seen.has(value)) return { type: "reference", identity: seen.get(value) };
        const identity = nextIdentity++;
        seen.set(value, identity);
        if (typeof value === "function") {
          const prototypeDescriptor = Object.getOwnPropertyDescriptor(value, "prototype");
          return {
            type: "function",
            identity,
            name: value.name,
            length: value.length,
            source: Function.prototype.toString.call(value),
            prototype: prototypeDescriptor ? { writable: prototypeDescriptor.writable, enumerable: prototypeDescriptor.enumerable, configurable: prototypeDescriptor.configurable } : null,
          };
        }
        const properties = {};
        for (const key of Reflect.ownKeys(value).filter((key) => typeof key === "string").toSorted()) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          properties[key] = {
            configurable: descriptor.configurable,
            enumerable: descriptor.enumerable,
            writable: Object.hasOwn(descriptor, "writable") ? descriptor.writable : null,
            value: Object.hasOwn(descriptor, "value") ? encode(descriptor.value, depth + 1) : null,
            getter: descriptor.get ? encode(descriptor.get, depth + 1) : null,
            setter: descriptor.set ? encode(descriptor.set, depth + 1) : null,
          };
        }
        return { type: "object", identity, brand: Object.prototype.toString.call(value), properties };
      }

      let asynchronousError = null;
      function captureAsynchronousError(event, timing) {
        if (!asynchronousError) {
          asynchronousError = {
            error: event.error ?? event.reason ?? new Error(String(event.message ?? event.reason ?? "host execution failed")),
            timing,
          };
        }
        event.preventDefault?.();
      }
      const onError = (event) => captureAsynchronousError(event, "event");
      const onUnhandledRejection = (event) => captureAsynchronousError(event, "promise");
      globalThis.addEventListener("error", onError);
      globalThis.addEventListener("unhandledrejection", onUnhandledRejection);

      function waitForTurn() {
        return new Promise((resolve) => setTimeout(resolve, 0));
      }

      async function executeClassicScript(external) {
        const script = document.createElement("script");
        script.async = false;
        let blobURL = null;
        try {
          if (external) {
            blobURL = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
            const result = await new Promise((resolve) => {
              script.addEventListener("load", () => resolve("load"), { once: true });
              script.addEventListener("error", () => resolve("error"), { once: true });
              script.src = blobURL;
              document.head.append(script);
            });
            return Object.freeze({ delivery: result });
          }
          script.textContent = source;
          document.head.append(script);
          await waitForTurn();
          return Object.freeze({ delivery: "inline" });
        } finally {
          script.remove();
          if (blobURL) URL.revokeObjectURL(blobURL);
        }
      }

      async function executeJavaScriptURL() {
        const frame = document.createElement("iframe");
        document.body.append(frame);
        let target;
        let onTargetError;
        let onTargetUnhandledRejection;
        try {
          target = frame.contentWindow;
          onTargetError = (event) => captureAsynchronousError(event, "event");
          onTargetUnhandledRejection = (event) => captureAsynchronousError(event, "promise");
          target.addEventListener("error", onTargetError);
          target.addEventListener("unhandledrejection", onTargetUnhandledRejection);
          installAbi(target);
          target.effects = effects;
          target.__zpEvents = events;
          target.location.href = `javascript:${encodeURIComponent(source)}`;
          await waitForTurn();
          return Object.freeze({ document: target.document.body?.textContent ?? null });
        } finally {
          target?.removeEventListener("error", onTargetError);
          target?.removeEventListener("unhandledrejection", onTargetUnhandledRejection);
          frame.remove();
        }
      }

      async function executeEventHandler() {
        const target = document.createElement("button");
        globalThis.__zpHandlerElement = target;
        document.body.append(target);
        try {
          target.setAttribute("onclick", source);
          const event = new Event("click", { bubbles: true, cancelable: true });
          const dispatched = target.dispatchEvent(event);
          await waitForTurn();
          return Object.freeze({ dispatched, defaultPrevented: event.defaultPrevented, returnValue: event.returnValue });
        } finally {
          delete globalThis.__zpHandlerElement;
          target.remove();
        }
      }

      function isolatedRealmSource(suffix) {
        return `globalThis.effects=[];{
const scope=new Proxy(Object.create(null),{
get(_target,property){return globalThis[property]},
set(_target,property,value){return Reflect.set(globalThis,property,value)},
deleteProperty(_target,property){return Reflect.deleteProperty(globalThis,property)},
has(_target,property){return Reflect.has(globalThis,property)}
});
const abi=Object.freeze({
scope,
thisValue(value){return value},
evalSource(value){return value},
indirectEval(value){return typeof value==="string"?(0,eval)(value):value},
dynamicFunction(_family,_callKind,_newTarget,rawArgs){return Function(...rawArgs)},
importOperand(value){return value},
moduleMeta(nativeMeta,originalURL){const resolve=nativeMeta.resolve;return Object.freeze({url:originalURL,resolve:typeof resolve==="function"?resolve.bind(nativeMeta):undefined})},
moduleContext(nativeMeta,originalURL){return Object.freeze({...abi,importMeta:abi.moduleMeta(nativeMeta,originalURL),importModule:(value,options)=>import(value,options)})},
sourceRegistry:new Map(),
runtimeHealth(){return Object.freeze({ready:true,abi_identifier:${JSON.stringify(abiIdentifier)}})}
});
Object.defineProperty(globalThis,${JSON.stringify(abiIdentifier)},{value:abi,configurable:true});
}
${source}
${suffix}`;
      }

      function appendRealmEffects(message) {
        if (!message || !Array.isArray(message.effects)) {
          throw new Error("isolated realm returned malformed effects");
        }
        effects.push(...message.effects);
      }

      async function executeDedicatedWorker(module) {
        const workerSource = isolatedRealmSource(`postMessage({effects});`);
        const workerURL = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
        const worker = new Worker(workerURL, { type: module ? "module" : "classic" });
        try {
          const message = await new Promise((resolve, reject) => {
            worker.addEventListener("message", (event) => resolve(event.data), { once: true });
            worker.addEventListener("error", (event) => reject(event.error ?? new Error(event.message)), { once: true });
          });
          appendRealmEffects(message);
          return Object.freeze({ delivery: module ? "module-worker" : "classic-worker" });
        } finally {
          worker.terminate();
          URL.revokeObjectURL(workerURL);
        }
      }

      async function executeSharedWorker(module) {
        const workerSource = isolatedRealmSource(
          `addEventListener("connect",event=>event.ports[0].postMessage({effects}));`,
        );
        const workerURL = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
        const worker = new SharedWorker(workerURL, {
          name: `zp-oracle-${module ? "module" : "classic"}-${crypto.randomUUID()}`,
          type: module ? "module" : "classic",
        });
        try {
          const message = await new Promise((resolve) => {
            worker.port.addEventListener("message", (event) => resolve(event.data), { once: true });
            worker.port.start();
          });
          appendRealmEffects(message);
          return Object.freeze({ delivery: module ? "shared-module-worker" : "shared-classic-worker" });
        } finally {
          worker.port.close();
          URL.revokeObjectURL(workerURL);
        }
      }

      async function activatedServiceWorker(registration) {
        const worker = registration.installing ?? registration.waiting ?? registration.active;
        if (!worker) throw new Error("service worker installation did not produce a worker");
        if (worker.state !== "activated") {
          await new Promise((resolve, reject) => {
            worker.addEventListener("statechange", () => {
              if (worker.state === "activated") resolve();
              if (worker.state === "redundant") reject(new Error("service worker became redundant"));
            });
          });
        }
        return registration.active ?? worker;
      }

      async function executeServiceWorker(module) {
        const registration = await navigator.serviceWorker.register(
          `${oracleOrigin}/oracle-sw.js?module=${module ? "1" : "0"}`,
          {
            scope: `${oracleOrigin}/oracle-scope-${module ? "module" : "classic"}/`,
            type: module ? "module" : "classic",
            updateViaCache: "none",
          },
        );
        try {
          const worker = await activatedServiceWorker(registration);
          const channel = new MessageChannel();
          const message = new Promise((resolve) => {
            channel.port1.addEventListener("message", (event) => resolve(event.data), { once: true });
            channel.port1.start();
          });
          worker.postMessage(null, [channel.port2]);
          const observed = await message;
          channel.port1.close();
          appendRealmEffects(observed);
          return Object.freeze({ delivery: module ? "service-worker-module" : "service-worker-classic" });
        } finally {
          await registration.unregister();
        }
      }

      async function executeWorkletModule() {
        const AudioContextConstructor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
        if (typeof AudioContextConstructor !== "function") {
          throw new Error("AudioWorklet host unavailable");
        }
        const audio = new AudioContextConstructor();
        const workletSource = isolatedRealmSource(
          `if(effects.length!==1||effects[0]!==true)throw new Error("worklet effects mismatch");`,
        );
        const workletURL = URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" }));
        try {
          await audio.audioWorklet.addModule(workletURL);
          return Object.freeze({ delivery: "worklet-module" });
        } finally {
          URL.revokeObjectURL(workletURL);
          await audio.close();
        }
      }

      let completion;
      let exception = null;
      let timing = "sync";
      try {
        let value;
        if (host === "module-script") {
          timing = "promise";
          const moduleSource = `const ${abiIdentifier}=globalThis[${JSON.stringify(abiIdentifier)}].moduleContext(import.meta,import.meta.url);\n${source}`;
          const moduleURL = URL.createObjectURL(new Blob([moduleSource], { type: "text/javascript" }));
          try { value = await import(moduleURL); } finally { URL.revokeObjectURL(moduleURL); }
        } else if (host === "classic-script-external") {
          value = await executeClassicScript(true);
        } else if (host === "classic-script-inline") {
          value = await executeClassicScript(false);
        } else if (host === "direct-eval") {
          function directEval(text) { return eval(text); }
          value = directEval(source);
        } else if (host === "indirect-eval") {
          value = (0, eval)(source);
        } else if (host === "timer-string") {
          await new Promise((resolve) => {
            setTimeout(source, 0);
            setTimeout(resolve, 0);
          });
          value = undefined;
        } else if (host === "javascript-url") {
          value = await executeJavaScriptURL();
        } else if (host === "event-handler") {
          value = await executeEventHandler();
        } else if (host === "classic-worker") {
          timing = "promise";
          value = await executeDedicatedWorker(false);
        } else if (host === "module-worker") {
          timing = "promise";
          value = await executeDedicatedWorker(true);
        } else if (host === "shared-classic-worker") {
          timing = "promise";
          value = await executeSharedWorker(false);
        } else if (host === "shared-module-worker") {
          timing = "promise";
          value = await executeSharedWorker(true);
        } else if (host === "service-worker-classic") {
          timing = "promise";
          value = await executeServiceWorker(false);
        } else if (host === "service-worker-module") {
          timing = "promise";
          value = await executeServiceWorker(true);
        } else if (host === "worklet-module") {
          timing = "promise";
          value = await executeWorkletModule();
        } else {
          const constructor = host === "async-function-body" ? Object.getPrototypeOf(async function(){}).constructor
            : host === "generator-function-body" ? Object.getPrototypeOf(function*(){}).constructor
            : host === "async-generator-function-body" ? Object.getPrototypeOf(async function*(){}).constructor
            : Function;
          const callable = constructor(source);
          value = callable.call(globalThis);
          if (host === "generator-function-body" || host === "async-generator-function-body") {
            timing = host === "async-generator-function-body" ? "promise" : timing;
            value = await value.next();
          }
        }
        if (value && typeof value.then === "function") {
          timing = "promise";
          value = await value;
        }
        await Promise.resolve();
        await waitForTurn();
        if (asynchronousError) {
          timing = asynchronousError.timing;
          throw asynchronousError.error;
        }
        completion = encode(value);
      } catch (error) {
        const constructor = typeof error?.constructor?.name === "string" ? error.constructor.name : typeof error;
        exception = {
          constructor,
          realm: typeof globalThis[constructor] === "function" && Object.getPrototypeOf(error) === globalThis[constructor].prototype ? "execution" : "foreign",
          timing,
          message_class: String(error?.message ?? error).replaceAll(/\d+/gu, "#"),
        };
        completion = null;
      } finally {
        globalThis.removeEventListener("error", onError);
        globalThis.removeEventListener("unhandledrejection", onUnhandledRejection);
      }
      return {
        completion,
        exception,
        effects: encode(effects),
        descriptors: encode(globalThis.__zpDescriptors ?? null),
        events_promises: encode(events),
        module_identity: encode(globalThis.__zpModuleIdentity ?? null),
        source_reflection: encode(globalThis.__zpSourceReflection ?? null),
      };
    }, { source, host, abiIdentifier, oracleOrigin: oracleServer.origin });
    return Object.freeze(normalizeRealmObservation({ ...observed, network }));
  } finally {
    await context.close();
    await oracleServer.close();
  }
}

export async function observeNativeSource(browser, { source, sourceKind }) {
  nativeHostFor(sourceKind);
  return observeSource(browser, { source, sourceKind, abiIdentifier: ABI_IDENTIFIER });
}

export async function differential(browser, fixture, compiler) {
  nativeHostFor(fixture.sourceKind);
  const productCompiler = compiler ?? await loadProductCompiler();
  const compiled = productCompiler.compile(fixture.source, fixture.sourceKind);
  const originalObservation = await observeSource(browser, { ...fixture, abiIdentifier: productCompiler.abiIdentifier });
  const compiledObservation = await observeSource(browser, { source: compiled.code, sourceKind: fixture.sourceKind, abiIdentifier: productCompiler.abiIdentifier });
  assert.deepEqual(compiledObservation, originalObservation, `${fixture.id}: compiler output diverged from native source`);
  if (fixture.requiresEdit) assert.ok(compiled.edits.length > 0, `${fixture.id}: fixture did not exercise compiler output edits`);
  return Object.freeze({ id: fixture.id, sourceKind: fixture.sourceKind, edits: compiled.edits.length, observation: compiledObservation });
}

export { ABI_IDENTIFIER, ROOT };
