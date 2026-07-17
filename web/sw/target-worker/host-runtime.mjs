import { VirtualEventDispatcher } from "./event-runtime.mjs";
import { deferred, equalBinding, invalid, normalizeBinding, requireFunction, requireInteger, requireObject, requireString, transferables } from "./validation.mjs";

const FORWARDED_EVENTS = new Set(["fetch", "install", "activate", "message"]);

function requirePort(value) {
  const port = requireObject(value, "host port");
  return Object.freeze({
    addEventListener: requireFunction(port.addEventListener, "host port.addEventListener").bind(port),
    postMessage: requireFunction(port.postMessage, "host port.postMessage").bind(port),
    start: typeof port.start === "function" ? port.start.bind(port) : null,
  });
}

const MAX_COMMAND_BODY_BYTES = 256 << 10;
const nativeArrayFrom = Array.from;
const nativeStructuredClone = globalThis.structuredClone?.bind(globalThis);

function prepareMessage(message, transferOrOptions) {
  if (!nativeStructuredClone) throw invalid("structured clone is unavailable", "NotSupportedError");
  let rawTransfer;
  if (transferOrOptions === undefined) rawTransfer = [];
  else if (Array.isArray(transferOrOptions)) rawTransfer = transferOrOptions;
  else rawTransfer = requireObject(transferOrOptions, "postMessage options").transfer ?? [];
  let transfer;
  try { transfer = transferables(nativeArrayFrom(rawTransfer), "postMessage transfer list"); }
  catch (error) { throw error?.name === "DataCloneError" ? error : invalid("postMessage transfer list is invalid", "TypeError"); }
  return transfer.length === 0
    ? { message: nativeStructuredClone(message), transfer: [] }
    : nativeStructuredClone({ message, transfer }, { transfer });
}

function commandBytes(value, label) {
  if (value === undefined || value === null) return null;
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_COMMAND_BODY_BYTES) throw invalid(`${label} exceeds limit`, "QuotaExceededError");
    return value;
  }
  if (value instanceof ArrayBuffer) return commandBytes(new Uint8Array(value), label);
  throw invalid(`${label} is invalid`, "TypeError");
}

async function requestRecord(input, init = undefined) {
  const request = new Request(input, init);
  const headers = [...request.headers];
  const body = request.method === "GET" || request.method === "HEAD" ? null : commandBytes(new Uint8Array(await request.arrayBuffer()), "request body");
  return {
    body,
    credentials: request.credentials,
    headers,
    method: request.method,
    mode: request.mode,
    redirect: request.redirect,
    url: request.url,
  };
}

async function responseRecord(value) {
  if (!(value instanceof Response)) throw invalid("cache response must be a Response", "TypeError");
  return {
    body: commandBytes(new Uint8Array(await value.arrayBuffer()), "response body"),
    headers: [...value.headers],
    status: value.status,
    status_text: value.statusText,
    url: value.url,
  };
}

function responseFromRecord(value) {
  const response = requireObject(value, "response");
  if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599 || !Array.isArray(response.headers)) {
    throw invalid("response record is invalid", "SecurityError");
  }
  return new Response(commandBytes(response.body, "response body"), { headers: response.headers, status: response.status, statusText: typeof response.status_text === "string" ? response.status_text : "" });
}

function responseFromPreloadRecord(value) {
  const response = requireObject(value, "navigation preload response");
  if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599 || !Array.isArray(response.headers)
    || (response.body !== null && typeof response.body?.getReader !== "function")) {
    throw invalid("navigation preload response is invalid", "SecurityError");
  }
  return new Response(response.body, {
    headers: response.headers,
    status: response.status,
    statusText: typeof response.status_text === "string" ? response.status_text : "",
  });
}
function controlledClassicGatewayRoute(value, gatewayID, token) {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) {
    throw invalid("classic import gateway route rejected", "SecurityError");
  }
  let parsed;
  try {
    parsed = new URL(value, "https://route.invalid");
  } catch {
    throw invalid("classic import gateway route rejected", "SecurityError");
  }
  const segments = parsed.pathname.split("/");
  if (
    value !== parsed.pathname
    || parsed.search
    || parsed.hash
    || segments.length !== 5
    || segments[0] !== ""
    || segments[1] !== "_zp"
    || segments[2] !== "wi"
    || segments[3] !== gatewayID
    || segments[4] !== token
  ) {
    throw invalid("classic import gateway route rejected", "SecurityError");
  }
  return value;
}

function controlledTargetWorkerExecutableRoute(value, expected) {
  if (typeof value !== "string" || typeof expected !== "string" || value.length === 0 || value.length > 16_384) {
    throw invalid("target worker executable route rejected", "SecurityError");
  }
  let parsed;
  try {
    parsed = new URL(value, "https://route.invalid");
  } catch {
    throw invalid("target worker executable route rejected", "SecurityError");
  }
  if (value !== expected || value !== parsed.pathname || parsed.search || parsed.hash) {
    throw invalid("target worker executable route rejected", "SecurityError");
  }
  return value;
}




export class TargetWorkerHostRuntime {
  #binding = null;
  #hostBinding = null;
  #credits = new Map();
  #commands = new Map();
  #clients = new Map();
  #commandSequence = 0;
  #dispatcher = null;
  #events = new Map();
  #gatewaySealer;
  #loadRouteBuilder;
  #routeBuilder;
  #importModule;
  #listeners = new Map();
  #messageSequence = 0;
  #port = null;
  #nativeImportScripts;
  #classicGateway = null;
  #sessionID = null;
  #terminated = false;

  constructor({
    importModule = (url) => import(url),
    loadGatewaySealer = null,
    loadRouteBuilder = null,
    routeBuilder = null,
    nativeImportScripts = typeof globalThis.importScripts === "function" ? globalThis.importScripts.bind(globalThis) : null,
  } = {}) {
    if (routeBuilder !== null && loadRouteBuilder !== null) throw invalid("classic import route builder is ambiguous", "TypeError");
    this.#importModule = requireFunction(importModule, "importModule");
    this.#gatewaySealer = loadGatewaySealer === null ? null : requireFunction(loadGatewaySealer, "loadGatewaySealer");
    this.#loadRouteBuilder = loadRouteBuilder === null ? null : requireFunction(loadRouteBuilder, "loadRouteBuilder");
    this.#routeBuilder = routeBuilder === null ? null : requireFunction(routeBuilder, "routeBuilder");
    this.#nativeImportScripts = nativeImportScripts === null ? null : requireFunction(nativeImportScripts, "nativeImportScripts");
  }

  attach(port) {
    if (this.#port !== null) throw invalid("host runtime is already attached", "InvalidStateError");
    this.#port = requirePort(port);
    this.#port.addEventListener("message", (event) => { void this.#onMessage(event?.data).catch((error) => this.#fail(error)); });
    this.#port.start?.();
    return this;
  }

  async #policyRouteBuilder() {
    const routeBuilder = this.#routeBuilder ?? (this.#loadRouteBuilder === null ? null : requireFunction(await this.#loadRouteBuilder(), "target worker route builder"));
    if (routeBuilder === null) throw invalid("target worker route builder is unavailable", "SecurityError");
    return routeBuilder;
  }

  async #configureClassicGateway(graph) {
    this.#classicGateway = null;
    if (graph.classic_gateway === undefined) return;
    const gateway = requireObject(graph.classic_gateway, "classic import gateway");
    const id = requireString(gateway.id, "classic import gateway id", { min: 32, max: 32 });
    const key = requireString(gateway.key, "classic import gateway key", { min: 32, max: 32 });
    if (!/^[A-Za-z0-9_-]{32}$/u.test(id) || !/^[A-Za-z0-9_-]{32}$/u.test(key) || !Number.isSafeInteger(gateway.lease_generation) || gateway.lease_generation < 1 || !Number.isSafeInteger(gateway.expires_at) || gateway.expires_at <= Date.now() || this.#gatewaySealer === null || this.#nativeImportScripts === null) {
      throw invalid("classic import gateway is unavailable", "SecurityError");
    }
    const routeBuilder = await this.#policyRouteBuilder();
    const root = requireObject(graph.resources?.[0], "classic import root");
    const scriptURL = requireString(root.url, "classic import root URL", { min: 1, max: 16_384 });
    const seal = await this.#gatewaySealer();
    this.#classicGateway = Object.freeze({ expires_at: gateway.expires_at, id, key, lease_generation: gateway.lease_generation, route_builder: routeBuilder, script_url: scriptURL, seal: requireFunction(seal, "classic import gateway sealer") });
  }

  #importScripts(...rawURLs) {
    const gateway = this.#classicGateway;
    if (!gateway || gateway.expires_at <= Date.now() || rawURLs.length === 0 || rawURLs.length > 64) throw invalid("classic import gateway is unavailable", "SecurityError");
    const routes = rawURLs.map(rawURL => {
      const target = new URL(requireString(String(rawURL), "importScripts URL", { min: 1, max: 16_384 }), gateway.script_url);
      if ((target.protocol !== "http:" && target.protocol !== "https:") || target.username || target.password || target.hash) throw invalid("importScripts URL rejected", "SecurityError");
      let token;
      try { token = gateway.seal(gateway.key, gateway.id, target.href); } catch { throw invalid("importScripts gateway sealing failed", "SecurityError"); }
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,16384}$/u.test(token)) throw invalid("importScripts gateway sealing failed", "SecurityError");
      let route;
      try { route = gateway.route_builder("classic", gateway.id, token); } catch { throw invalid("classic import gateway route rejected", "SecurityError"); }
      return controlledClassicGatewayRoute(route, gateway.id, token);
    });
    return this.#nativeImportScripts(...routes);
  }

  #client(record) {
    const value = requireObject(record, "client record");
    const clientID = requireString(value.client_id, "client_id", { max: 256 });
    const type = requireString(value.type, "client type", { max: 16 });
    const url = requireString(value.url, "client URL", { max: 16_384 });
    if (!["window", "worker"].includes(type)) throw invalid("client type is invalid", "SecurityError");
    const current = this.#clients.get(clientID);
    if (current) {
      if (current.type !== type) throw invalid("client identity changed type", "SecurityError");
      current.record = value;
      return current.facade;
    }
    const holder = { facade: null, record: value, type };
    const facade = {};
    const descriptors = {
      id: { enumerable: true, get: () => holder.record.client_id },
      type: { enumerable: true, get: () => holder.record.type },
      url: { enumerable: true, get: () => holder.record.url },
      postMessage: {
        enumerable: true,
        value: (message, transferOrOptions = undefined) => {
          const prepared = prepareMessage(message, transferOrOptions);
          void this.#command("CLIENT_POST_MESSAGE", {
            client_id: holder.record.client_id,
            message: prepared.message,
            transfer: prepared.transfer,
          }, prepared.transfer).catch(error => this.#fail(error));
        },
      },
    };
    if (type === "window") {
      descriptors.focus = {
        enumerable: true,
        value: async () => {
          const result = requireObject(await this.#command("CLIENT_FOCUS", { client_id: holder.record.client_id }), "client focus result");
          return this.#client(result.client ?? holder.record);
        },
      };
      descriptors.navigate = {
        enumerable: true,
        value: async target => {
          const result = requireObject(await this.#command("CLIENT_NAVIGATE", { client_id: holder.record.client_id, url: String(target) }), "client navigate result");
          return result.client === null ? null : this.#client(result.client ?? holder.record);
        },
      };
    }
    Object.defineProperties(facade, descriptors);
    if (type === "window" && globalThis.WindowClient?.prototype) Object.setPrototypeOf(facade, globalThis.WindowClient.prototype);
    else if (globalThis.Client?.prototype) Object.setPrototypeOf(facade, globalThis.Client.prototype);
    holder.facade = Object.freeze(facade);
    this.#clients.set(clientID, holder);
    return holder.facade;
  }

  #messageEvent(event, message) {
    const plan = requireObject(message.request_plan ?? {}, "message event plan");
    const transfer = transferables(message.transfer ?? [], "message event transfer list");
    const ports = transfer.filter(value => typeof value?.postMessage === "function" && typeof value?.start === "function");
    const facade = Object.create(event);
    Object.defineProperties(facade, {
      data: { enumerable: true, value: plan.message },
      origin: { enumerable: true, value: typeof plan.origin === "string" ? plan.origin : "" },
      ports: { enumerable: true, value: Object.freeze([...ports]) },
      source: { enumerable: true, value: message.source_client === null || message.source_client === undefined ? null : this.#client(message.source_client) },
    });
    return Object.freeze(facade);
  }

  #scope() {
    const addEventListener = (type, listener) => {
      if (!FORWARDED_EVENTS.has(type) || typeof listener !== "function") throw invalid("unsupported target worker listener", "NotSupportedError");
      const listeners = this.#listeners.get(type) ?? [];
      listeners.push(listener);
      this.#listeners.set(type, listeners);
    };
    const unsupported = operation => Promise.reject(invalid(`unsupported target worker ${operation}`, "NotSupportedError"));
    const unsupportedManager = operations => Object.freeze(Object.fromEntries(operations.map(operation => [
      operation,
      () => unsupported(operation),
    ])));
    const cache = name => Object.freeze({
      delete: async request => this.#command("CACHE_DELETE", { cache_name: String(name), request: await requestRecord(request) }),
      keys: async request => (await this.#command("CACHE_KEYS", { cache_name: String(name), request: request === undefined ? null : await requestRecord(request) })).map(value => new Request(value.url, { headers: value.headers, method: value.method })),
      match: async request => {
        const result = await this.#command("CACHE_MATCH", { cache_name: String(name), request: await requestRecord(request) });
        return result.response === null ? undefined : responseFromRecord(result.response);
      },
      put: async (request, response) => this.#command("CACHE_PUT", { cache_name: String(name), request: await requestRecord(request), response: await responseRecord(response) }),
    });
    
    const navigationPreloadState = value => {
      const state = requireObject(requireObject(value, "navigation preload result").state, "navigation preload state");
      if (typeof state.enabled !== "boolean" || typeof state.header_value !== "string") throw invalid("navigation preload state is invalid", "SecurityError");
      return Object.freeze({ enabled: state.enabled, headerValue: state.header_value });
    };
    const navigationPreload = Object.freeze({
      disable: async () => { navigationPreloadState(await this.#command("NAVIGATION_PRELOAD_DISABLE", {})); },
      enable: async () => { navigationPreloadState(await this.#command("NAVIGATION_PRELOAD_ENABLE", {})); },
      getState: async () => navigationPreloadState(await this.#command("NAVIGATION_PRELOAD_GET_STATE", {})),
      setHeaderValue: async value => { navigationPreloadState(await this.#command("NAVIGATION_PRELOAD_SET_HEADER", { value: String(value) })); },
    });
    const scope = {
      addEventListener,
      caches: Object.freeze({
        delete: async name => this.#command("CACHE_STORAGE_DELETE", { cache_name: String(name) }),
        has: async name => (await this.#command("CACHE_STORAGE_HAS", { cache_name: String(name) })).value === true,
        keys: async () => (await this.#command("CACHE_STORAGE_KEYS", {})).keys,
        open: async name => {
          const cacheName = String(name);
          await this.#command("CACHE_OPEN", { cache_name: cacheName });
          return cache(cacheName);
        },
      }),
      clients: Object.freeze({
        claim: async () => this.#command("CLIENTS_CLAIM", {}),
        get: async id => {
          const result = await this.#command("CLIENTS_GET", { client_id: String(id) });
          return result.client === null ? undefined : this.#client(result.client);
        },
        matchAll: async options => (await this.#command("CLIENTS_MATCH_ALL", { options: options ?? {} })).clients.map(record => this.#client(record)),
        openWindow: async url => {
          const result = await this.#command("CLIENT_OPEN_WINDOW", { client_id: `window:${this.#sessionID}:${++this.#commandSequence}`, url: String(url) });
          return result.client === null ? null : this.#client(result.client);
        },
      }),
      fetch: async (input, init) => responseFromRecord((await this.#command("FETCH", { request: await requestRecord(input, init) })).response),
      importScripts: (...urls) => this.#importScripts(...urls),
      location: Object.freeze({ href: this.#binding?.synthetic_origin ?? "" }),
      navigator: Object.freeze({}),
      postMessage: message => this.#command("POST_MESSAGE", { message }),
      skipWaiting: async () => this.#command("REGISTRATION_SKIP_WAITING", {}),
      registration: Object.freeze({
        backgroundFetch: unsupportedManager(["fetch", "get", "getIds"]),
        getNotifications: () => unsupported("getNotifications"),
        navigationPreload,
        paymentManager: Object.freeze({
          enableDelegations: () => unsupported("enableDelegations"),
          instruments: unsupportedManager(["clear", "delete", "get", "has", "keys", "set"]),
        }),
        periodicSync: unsupportedManager(["getTags", "register", "unregister"]),
        pushManager: unsupportedManager(["getSubscription", "permissionState", "subscribe"]),
        showNotification: () => unsupported("showNotification"),
        sync: unsupportedManager(["getTags", "register"]),
        unregister: async () => (await this.#command("REGISTRATION_UNREGISTER", {})).value === true,
        update: async () => this.#command("REGISTRATION_UPDATE", {}),
      }),
    };
    scope.globalThis = scope;
    scope.self = scope;
    return Object.freeze(scope);
  }
  async #execute(graph) {
    if (!["classic", "module"].includes(graph.type) || !Array.isArray(graph.resources) || graph.resources.length === 0) throw invalid("target worker graph resources are invalid", "SecurityError");
    const routeBuilder = await this.#policyRouteBuilder();
    const scope = this.#scope();
    const importModule = graph.type === "module"
      ? (moduleID, referrerURL, specifier) => this.#command("MODULE_IMPORT", {
        module_id: String(moduleID),
        referrer_url: String(referrerURL),
        specifier: String(specifier),
      })
      : null;
    for (const resource of graph.resources) {
      const entry = requireObject(resource, "target worker graph resource");
      const contentID = requireString(entry.hash, "target worker executable digest", { min: 64, max: 64 });
      let expected;
      try { expected = routeBuilder("target-worker", contentID, null); } catch { throw invalid("target worker executable route rejected", "SecurityError"); }
      const moduleURL = controlledTargetWorkerExecutableRoute(requireString(entry.module_url, "target worker executable route", { min: 1, max: 16_384 }), expected);
      const route = new URL(moduleURL, this.#binding.synthetic_origin);
      if (route.origin !== this.#binding.synthetic_origin) throw invalid("target worker executable route rejected", "SecurityError");
      const module = requireObject(await this.#importModule(route.href), "target worker executable module");
      const install = module.install ?? module.default;
      if (typeof install !== "function") throw invalid("target worker executable installer is unavailable", "SecurityError");
      if (importModule === null) await install(scope);
      else await install(scope, importModule);
    }
  }

  async #hydrate(message) {
    const envelope = requireObject(message, "hydrate message");
    const binding = requireObject(envelope.binding, "hydrate binding");
    const registrationID = requireString(binding.registration_id, "registration_id", { max: 256 });
    const workerVersion = requireString(binding.worker_version, "worker_version", { max: 256 });
    const sessionID = requireString(envelope.session_id, "session_id", { max: 256 });
    const graph = requireObject(envelope.graph, "target worker graph");
    const hostBinding = normalizeBinding(binding);
    if (this.#hostBinding === null) this.#hostBinding = hostBinding;
    else if (!equalBinding(this.#hostBinding, hostBinding)) throw invalid("target worker host binding mismatch", "SecurityError");
    requireString(graph.graph_hash, "target worker graph hash", { max: 256 });
    this.#listeners.clear();
    this.#events.clear();
    this.#credits.clear();
    this.#clients.clear();
    this.#binding = Object.freeze({ ...binding, registration_id: registrationID, worker_version: workerVersion });
    this.#sessionID = sessionID;
    this.#terminated = false;
    await this.#configureClassicGateway(graph);
    await this.#execute(graph);
    this.#dispatcher = new VirtualEventDispatcher({
      preloadResponse: async ({ event_id, preload_handle }) => responseFromPreloadRecord((await this.#command("NAVIGATION_PRELOAD", {
        event_id,
        preload_handle,
      })).response),
      send: (protocol) => this.#send(protocol),
      responseCredit: ({ event_id, sequence }) => this.#awaitCredit(event_id, sequence),
    });
    this.#send({ type: "WORKER_READY", graph_hash: graph.graph_hash });
  }

  #awaitCredit(eventID, sequence) {
    const key = `${eventID}\0${sequence}`;
    const existing = this.#credits.get(key);
    if (existing === true) {
      this.#credits.delete(key);
      return Promise.resolve();
    }
    const wait = deferred();
    this.#credits.set(key, wait);
    return wait.promise;
  }

  #grantCredit(eventID, sequence) {
    const key = `${eventID}\0${sequence}`;
    const existing = this.#credits.get(key);
    if (existing && existing !== true) {
      this.#credits.delete(key);
      existing.resolve();
      return;
    }
    this.#credits.set(key, true);
  }

  #command(command, payload, rawTransfer = []) {
    if (!this.#port || !this.#binding || !this.#sessionID || this.#terminated) return Promise.reject(invalid("target worker command channel is unavailable", "InvalidStateError"));
    const transfer = transferables(rawTransfer, "target worker command transfer list");
    const messageID = `command:${this.#sessionID}:${++this.#commandSequence}`;
    const reply = deferred();
    this.#commands.set(messageID, reply);
    const message = Object.freeze({
      v: 1,
      type: "HOST_COMMAND",
      command,
      payload,
      binding: this.#binding,
      registration_id: this.#binding.registration_id,
      worker_version: this.#binding.worker_version,
      session_id: this.#sessionID,
      message_id: messageID,
    });
    if (transfer.length === 0) this.#port.postMessage(message);
    else this.#port.postMessage(message, transfer);
    return reply.promise;
  }

  #commandResult(message) {
    const replyTo = requireString(message.reply_to, "command reply_to", { max: 256 });
    const reply = this.#commands.get(replyTo);
    if (!reply) throw invalid("unknown target worker command reply", "SecurityError");
    this.#commands.delete(replyTo);
    if (message.ok !== true) {
      reply.reject(invalid(requireString(message.code ?? "HOST_COMMAND_REJECTED", "command code", { max: 128 }), "InvalidStateError"));
      return;
    }
    reply.resolve(requireObject(message.result, "command result"));
  }

  #heartbeat(message) {
    const binding = normalizeBinding(message.binding);
    if (this.#hostBinding === null) this.#hostBinding = binding;
    else if (!equalBinding(this.#hostBinding, binding)) throw invalid("execution host heartbeat binding mismatch", "SecurityError");
    this.#port.postMessage(Object.freeze({
      v: 1,
      type: "HOST_RUNTIME_PONG",
      reply_to: requireString(message.message_id, "execution host heartbeat message", { max: 256 }),
      binding: this.#hostBinding,
    }));
  }

  async #dispatch(message) {
    if (this.#terminated || this.#dispatcher === null || this.#binding === null) throw invalid("target worker is not ready", "InvalidStateError");
    const eventType = requireString(message.event_type, "event_type", { max: 64 });
    if (!FORWARDED_EVENTS.has(eventType)) throw invalid("unsupported target worker event", "NotSupportedError");
    const eventID=requireString(message.event_id,"event_id",{max:256});
    if(this.#events.has(eventID))throw invalid("target worker event is already active","InvalidStateError");
    const eventStart = {
      v:message.v,
      event_id:eventID,
      event_type: eventType,
      registration_id: this.#binding.registration_id,
      worker_version: this.#binding.worker_version,
      dispatch_deadline:message.dispatch_deadline,
      lifetime_deadline:message.lifetime_deadline,
      ...(message.client_id===undefined?{}:{client_id:message.client_id}),
      ...(message.resulting_client_id===undefined?{}:{resulting_client_id:message.resulting_client_id}),
      ...(message.request_plan===undefined?{}:{request_plan:message.request_plan}),
      ...(message.preload_handle===undefined?{}:{preload_handle:message.preload_handle}),
    };
    const listeners = this.#listeners.get(eventType) ?? [];
    const dispatched = this.#dispatcher.dispatch(eventStart, eventType === "message"
      ? listeners.map(listener => event => listener(this.#messageEvent(event, message)))
      : listeners);
    this.#events.set(eventID,dispatched);
    void dispatched.lifetime.catch(() => {});
  }
  #clearEvent(eventID,error=null){
    this.#events.delete(eventID);
    const prefix=`${eventID}\0`;
    for(const [key,credit] of this.#credits){
      if(!key.startsWith(prefix))continue;
      this.#credits.delete(key);
      if(error&&credit!==true)credit.reject(error);
    }
  }
  async #completeEvent(message){
    const eventID=requireString(message.event_id,"event_id",{max:256}),dispatched=this.#events.get(eventID);
    if(!dispatched)throw invalid("target worker event completion is stale","SecurityError");
    const finalWaitSequence=requireInteger(message.final_wait_seq,"final_wait_seq",{min:0});
    requireInteger(message.response_sequence,"response_sequence",{min:0});
    const lifetime=await dispatched.lifetime;
    if(lifetime.final_wait_seq!==finalWaitSequence)throw invalid("target worker event completion mismatch","SecurityError");
    this.#clearEvent(eventID);
  }
  #failEvent(message){
    const eventID=requireString(message.event_id,"event_id",{max:256});
    requireString(message.phase,"event failure phase",{max:64});
    const code=requireString(message.code,"event failure code",{max:128}),error=invalid(code,"OperationError");
    if(!this.#events.has(eventID))throw invalid("target worker event failure is stale","SecurityError");
    this.#clearEvent(eventID,error);
  }

  #send(protocol) {
    if (!this.#port || !this.#binding || !this.#sessionID || this.#terminated) return;
    this.#port.postMessage(Object.freeze({
      v: 1,
      ...protocol,
      binding: this.#binding,
      registration_id: this.#binding.registration_id,
      worker_version: this.#binding.worker_version,
      session_id: this.#sessionID,
      message_id: `worker:${this.#sessionID}:${++this.#messageSequence}`,
    }));
  }

  #terminate() {
    this.#terminated = true;
    for (const reply of this.#commands.values()) reply.reject(invalid("target worker terminated", "AbortError"));
    this.#commands.clear();
    for (const credit of this.#credits.values()) if (credit !== true) credit.reject(invalid("target worker terminated", "AbortError"));
    this.#credits.clear();
    this.#events.clear();
    this.#listeners.clear();
  }

  async #onMessage(message) {
    const envelope = requireObject(message, "private host message");
    if(envelope.v!==1)throw invalid("unsupported private host protocol version","SecurityError");
    const type = requireString(envelope.type, "private host message type", { max: 64 });
    if (type === "HOST_RUNTIME_PING") return this.#heartbeat(envelope);
    if (type === "HYDRATE_WORKER") return this.#hydrate(envelope);
    if (this.#binding === null || this.#sessionID === null || envelope.session_id !== this.#sessionID) throw invalid("stale target worker message", "SecurityError");
    if(!equalBinding(envelope.binding,this.#binding,{requireRegistration:true,requireVersion:true}))throw invalid("target worker message binding mismatch","SecurityError");
    if (type === "HOST_COMMAND_RESULT") return this.#commandResult(envelope);
    if (type === "EVENT_START") return this.#dispatch(envelope);
    if (type === "EVENT_COMPLETE") return this.#completeEvent(envelope);
    if (type === "EVENT_FAIL") return this.#failEvent(envelope);
    if (type === "STREAM_PULL") return this.#grantCredit(requireString(envelope.event_id, "event_id", { max: 256 }), requireInteger(envelope.sequence,"sequence",{min:0}));
    if (type === "STREAM_CANCEL") return this.#clearEvent(requireString(envelope.event_id,"event_id",{max:256}),invalid("response stream canceled","AbortError"));
    if (type === "TERMINATE_WORKER") return this.#terminate();
    throw invalid("unsupported private host message", "SecurityError");
  }

  #fail(error) {
    if (!this.#binding || !this.#sessionID || this.#terminated) return;
    this.#send({ type: "EVENT_FAIL", event_id: "host", phase: "host", code: error?.name ?? "HOST_FAILURE" });
    this.#terminate();
  }
}

export function startTargetWorkerHost(port, options = {}) {
  return new TargetWorkerHostRuntime(options).attach(port);
}
