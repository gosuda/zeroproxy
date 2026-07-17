import { createJournalPort } from "./journal.mjs";
import {
  assertStateTransition,
  clientFor,
  controlledClientCount,
  emptyTargetWorkerState,
  matchesScope,
  newRegistration,
  newVersion,
  registrationFor,
  resolveRegistration,
  validateState,
  versionFor,
} from "./model.mjs";
import {
  byteLength,
  bytes,
  clone,
  deadline,
  deferred,
  equalBinding,
  invalid,
  isPast,
  normalizeBinding,
  normalizeOrigin,
  parseURL,
  requireFunction,
  requireInteger,
  requireObject,
  requireString,
  sameOriginURL,
  structuredByteLength,
  transferables,
} from "./validation.mjs";

const DEFAULT_LIMITS = Object.freeze({
  dispatch_claim_ms: 5_000,
  event_lifetime_ms: 30_000,
  host_start_ms: 5_000,
  max_event_bytes: 256 << 10,
  max_fetch_event_bytes: 17 << 20,
  max_events_per_registration: 32,
  max_stream_chunk_bytes: 64 << 10,
  max_stream_chunks: 4_096,
  response_headers_ms: 10_000,
  stream_idle_ms: 15_000,
});
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1_000;
const MAX_CAS_RETRIES = 8;

function sessionKey(registrationID, workerVersion) {
  return `${registrationID}\0${workerVersion}`;
}

function eventBinding(binding, registrationID, workerVersion) {
  return Object.freeze({ ...binding, registration_id: registrationID, worker_version: workerVersion });
}

function normalizeLimits(value = {}) {
  const limits = requireObject(value, "limits");
  const output = {};
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    output[key] = requireInteger(limits[key] ?? fallback, `limits.${key}`, { min: 1, max: 1 << 30 });
  }
  return Object.freeze(output);
}

function normalizeGraph(value) {
  const graph = requireObject(value, "graph");
  const type = graph.type ?? "classic";
  const normalized = {
    graph_hash: requireString(graph.graph_hash, "graph.graph_hash", { max: 256 }),
    resources: graph.resources,
    type: requireString(type, "graph.type", { max: 16 }),
    update_hash:requireString(graph.update_hash??graph.graph_hash,"graph.update_hash",{max:256}),
    update_resources:graph.update_resources??graph.resources,
  };
  if (normalized.graph_hash.trim().length === 0
    || normalized.update_hash.trim().length === 0
    || !Array.isArray(normalized.resources)
    || normalized.resources.length === 0
    || !Array.isArray(normalized.update_resources)
    || normalized.update_resources.length === 0
    || !["classic", "module"].includes(normalized.type)) {
    throw invalid("graph is invalid", "TypeError");
  }
  if (graph.classic_gateway !== undefined) normalized.classic_gateway = clone(requireObject(graph.classic_gateway, "graph.classic_gateway"));
  if (normalized.type === "module") {
    normalized.abi_identifier = requireString(graph.abi_identifier, "graph.abi_identifier", { max: 128 });
    normalized.module_graph_id = requireString(graph.module_graph_id, "graph.module_graph_id", { max: 128 });
    normalized.module_referrer = requireString(graph.module_referrer, "graph.module_referrer", { max: 16_384 });
  }
  return clone(normalized);
}

function responseBodyPresent(plan){
  const value=requireObject(plan,"response_plan");
  if(typeof value.body_present!=="boolean")throw invalid("response_plan.body_present is invalid","TypeError");
  return value.body_present;
}

function responseFromPlan(plan, body, bodyPresent = responseBodyPresent(plan)) {
  const value = requireObject(plan, "response_plan");
  const status = requireInteger(value.status, "response_plan.status", { min: 200, max: 599 });
  if(bodyPresent&&(status===204||status===205||status===304))throw invalid("response status forbids a body","TypeError");
  const statusText = value.status_text === undefined ? "" : requireString(value.status_text, "response_plan.status_text", { min: 0, max: 512 });
  if (!Array.isArray(value.headers) || value.headers.length > 256) throw invalid("response_plan.headers is invalid", "TypeError");
  const headers = new Headers();
  for (const entry of value.headers) {
    if (!Array.isArray(entry) || entry.length !== 2) throw invalid("response header is invalid", "TypeError");
    headers.append(requireString(entry[0], "response header name", { max: 256 }), requireString(entry[1], "response header value", { min: 0, max: 8192 }));
  }
  return new Response(bodyPresent ? body : null, { headers, status, statusText });
}

function operationID(value) {
  return requireString(value, "operation_id", { max: 256 });
}

function clientController(registration, workerVersion, revision) {
  return { registration_id: registration.registration_id, revision, worker_version: workerVersion };
}

function controllerEqual(left, right) {
  return left?.registration_id === right?.registration_id && left?.worker_version === right?.worker_version;
}

function promoteControlledClients(state,registration,previous,workerVersion){
  if(!previous)return[];
  const changes=[];
  for(const client of state.clients){
    if(client.controller?.registration_id!==registration.registration_id||client.controller.worker_version!==previous.worker_version)continue;
    client.controller_revision+=1;
    client.controller=clientController(registration,workerVersion,client.controller_revision);
    changes.push({client_id:client.client_id,controller:clone(client.controller),controller_revision:client.controller_revision});
  }
  return changes;
}

function targetURL(value, origin, label) {
  return sameOriginURL(value, origin, label).href;
}

function navigationPreloadHeaderValue(value) {
  const headerValue = requireString(value, "navigation preload header value", { min: 0, max: 1024 });
  if (!/^[\t\x20-\x7e\x80-\xff]*$/u.test(headerValue)) throw invalid("navigation preload header value is invalid", "TypeError");
  return headerValue;
}

function noDirectFallback() {
  throw invalid("controlled fallback is unavailable", "NetworkError");
}

const LIFECYCLE_EVENTS = Object.freeze(["install", "activate", "message"]);
const TIMEOUT_FAILURE_CODES = new Set(["HOST_START_TIMEOUT", "DISPATCH_TIMEOUT", "RESPONSE_HEADERS_TIMEOUT", "STREAM_IDLE_TIMEOUT", "EVENT_LIFETIME_TIMEOUT"]);

function protocolFailureCode(cause) {
  return cause?.name === "TimeoutError" && TIMEOUT_FAILURE_CODES.has(cause.message)
    ? cause.message
    : cause?.name ?? "EVENT_FAILURE";
}

function validLifecycleState(eventType, registration, version, workerVersion) {
  if (eventType === "install") return version.state === "INSTALLING";
  if (eventType === "activate") return version.state === "ACTIVATING";
  return registration.active_version === workerVersion && version.state === "ACTIVE";
}

function createLifecycleEvent(value, eventID, eventType, registrationID, workerVersion, registration, state) {
  return {
    claimed: false,
    client_id: value.client_id === undefined ? undefined : requireString(value.client_id, "client_id", { max: 256 }),
    complete_sent: false,
    decision: deferred(),
    dispatch_closed: false,
    event_id: eventID,
    source_client: value.client_id === undefined ? null : clone(clientFor(state, value.client_id)),
    event_type: eventType,
    failed: null,
    final_wait_seq: 0,
    headers: deferred(),
    headers_received: false,
    lifetime: deferred(),
    lifetime_closed: false,
    lifetime_failed: false,
    lifetime_timer: null,
    max_wait_seq: 0,
    pending_bytes: 0,
    pending_chunk: null,
    pending_count: 0,
    preload: null,
    request_plan: value.payload === undefined ? {} : requireObject(value.payload, "lifecycle payload"),
    resulting_client_id: value.resulting_client_id === undefined ? undefined : requireString(value.resulting_client_id, "resulting_client_id", { max: 256 }),
    response: null,
    sequence: 0,
    session: null,
    stream: null,
    stream_controller: null,
    stream_end: false,
    stream_pulled: false,
    stream_timer: null,
    url: registration.scope_url,
    transfer: transferables(value.transfer, "lifecycle transfer list"),
    waits: new Map(),
    worker_version: workerVersion,
  };
}

export class TargetWorkerBroker {
  #binding;
  #clientCommands;
  #clock;
  #controlledFetch;
  #events = new Map();
  #host;
  #journal;
  #limits;
  #sessions = new Map();
  #targetOrigin;
  #timer;

  constructor({
    binding,
    clientCommands = null,
    clock = { now: () => Date.now() },
    controlledFetch = noDirectFallback,
    host,
    journal,
    limits = {},
    targetOrigin,
    timer = globalThis,
  } = {}) {
    this.#binding = normalizeBinding(binding);
    this.#targetOrigin = normalizeOrigin(targetOrigin);
    this.#journal = createJournalPort(journal, this.#binding, this.#targetOrigin);
    this.#host = this.#normalizeHost(host);
    this.#controlledFetch = requireFunction(controlledFetch, "controlledFetch");
    if (clientCommands !== null) this.#clientCommands = this.#normalizeClientCommands(clientCommands);
    const clockObject = requireObject(clock, "clock");
    this.#clock = Object.freeze({ now: requireFunction(clockObject.now, "clock.now").bind(clockObject) });
    const timerObject = requireObject(timer, "timer");
    this.#timer = Object.freeze({
      clearTimeout: requireFunction(timerObject.clearTimeout, "timer.clearTimeout").bind(timerObject),
      setTimeout: requireFunction(timerObject.setTimeout, "timer.setTimeout").bind(timerObject),
    });
    this.#limits = normalizeLimits(limits);
  }

  get binding() { return this.#binding; }
  get limits() { return this.#limits; }

  #normalizeHost(value) {
    const host = requireObject(value, "host");
    const output = {
      hydrate: requireFunction(host.hydrate, "host.hydrate").bind(host),
      send: requireFunction(host.send, "host.send").bind(host),
      terminate: typeof host.terminate === "function" ? host.terminate.bind(host) : null,
    };
    return Object.freeze(output);
  }

  #normalizeClientCommands(value) {
    const commands = requireObject(value, "clientCommands");
    return Object.freeze({ command: requireFunction(commands.command, "clientCommands.command").bind(commands) });
  }

  async #state() {
    return this.#journal.load();
  }

  async #mutate(id, mutate) {
    const operation = operationID(id);
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
      const loaded = await this.#state();
      const previous = loaded.state.operations[operation];
      if (previous !== undefined) {
        const record = requireObject(previous, "journal operation record");
        if (!equalBinding(record.binding, this.#binding)) throw invalid("journal operation binding mismatch", "SecurityError");
        return Object.freeze({ replayed: true, result: clone(record.result) });
      }
      const state = clone(loaded.state);
      const result = mutate(state);
      const controller = result.client?.controller ?? result.controller_change?.controller ?? result.controller ?? null;
      const registrationID = result.registration_id ?? controller?.registration_id;
      const workerVersion = result.worker_version ?? controller?.worker_version;
      const operationBinding = {
        ...this.#binding,
        ...(registrationID === undefined ? {} : { registration_id: registrationID }),
        ...(workerVersion === undefined ? {} : { worker_version: workerVersion }),
      };
      state.operations[operation] = { binding: operationBinding, result: clone(result) };
      validateState(state, this.#binding, this.#targetOrigin);
      const committed = await this.#journal.compareAndSwap(loaded.revision, state, operation, operationBinding);
      if (committed.applied) return Object.freeze({ replayed: false, result: clone(result) });
    }
    throw invalid("journal compare-and-swap contention", "AbortError");
  }

  async register(input) {
    const value = requireObject(input, "register input");
    const registrationID = requireString(value.registration_id, "registration_id", { max: 256 });
    const workerVersion = requireString(value.worker_version, "worker_version", { max: 256 });
    const scopeURL = targetURL(value.scope_url, this.#targetOrigin, "scope_url");
    const scriptURL = targetURL(value.script_url, this.#targetOrigin, "script_url");
    const type = value.type ?? "classic";
    const updateViaCache = value.update_via_cache ?? "imports";
    if (!["classic", "module"].includes(type) || !["all", "imports", "none"].includes(updateViaCache)) throw invalid("registration options are invalid", "TypeError");
    const graph = normalizeGraph(value.graph);
    const mutation = await this.#mutate(value.operation_id, (state) => {
      if (registrationFor(state, registrationID)) throw invalid("registration already exists", "InvalidStateError");
      if (state.registrations.some((registration) => registration.scope_url === scopeURL && !registration.unregistered)) {
        throw invalid("scope is already registered", "InvalidStateError");
      }
      const registration = newRegistration({ registration_id: registrationID, scope_url: scopeURL, script_url: scriptURL, type, update_via_cache: updateViaCache, now: this.#clock.now() });
      registration.versions.push(newVersion({ worker_version: workerVersion, graph, script_url:scriptURL, now: this.#clock.now() }));
      registration.installing_version = workerVersion;
      state.registrations.push(registration);
      return { registration_id: registrationID, state: "INSTALLING", worker_version: workerVersion };
    });
    return mutation.result;
  }

  async update(input) {
    const value = requireObject(input, "update input");
    const registrationID = requireString(value.registration_id, "registration_id", { max: 256 });
    const workerVersion = requireString(value.worker_version, "worker_version", { max: 256 });
    const scriptURL=value.script_url===undefined?null:targetURL(value.script_url,this.#targetOrigin,"script_url");
    const type=value.type??null,updateViaCache=value.update_via_cache??null;
    if(type!==null&&!["classic","module"].includes(type)||updateViaCache!==null&&!["all","imports","none"].includes(updateViaCache))throw invalid("registration options are invalid","TypeError");
    const graph = normalizeGraph(value.graph);
    const mutation = await this.#mutate(value.operation_id, (state) => {
      const registration = this.#requireRegistration(state, registrationID);
      if (registration.unregistered) throw invalid("registration is unregistered");
      const existing = versionFor(registration, workerVersion);
      if (existing) {
        if (existing.graph.graph_hash !== graph.graph_hash) throw invalid("worker version is pinned to a different graph", "SecurityError");
        return { registration_id: registrationID, state: existing.state, worker_version: workerVersion };
      }
      if (registration.installing_version !== null) throw invalid("an install is already in progress", "InvalidStateError");
      const active = registration.active_version && versionFor(registration, registration.active_version);
      registration.script_url=scriptURL??registration.script_url;
      registration.type=type??registration.type;
      registration.update_via_cache=updateViaCache??registration.update_via_cache;
      if (active?.graph.update_hash === graph.update_hash) {
        registration.last_update_check = this.#clock.now();
        return { registration_id: registrationID, state: active.state, unchanged: true, worker_version: active.worker_version };
      }
      registration.versions.push(newVersion({ worker_version: workerVersion, graph, script_url:registration.script_url, now: this.#clock.now() }));
      registration.installing_version = workerVersion;
      registration.last_update_check = this.#clock.now();
      return { registration_id: registrationID, state: "INSTALLING", worker_version: workerVersion };
    });
    return mutation.result;
  }

  async shouldSoftUpdate(registrationID, now = this.#clock.now()) {
    const id = requireString(registrationID, "registration_id", { max: 256 });
    requireInteger(now, "now", { min: 0 });
    const loaded = await this.#state();
    const registration = this.#requireRegistration(loaded.state, id);
    return now - registration.last_update_check >= UPDATE_CHECK_INTERVAL;
  }
  async getNavigationPreloadState(registrationID) {
    const id = requireString(registrationID, "registration_id", { max: 256 });
    const loaded = await this.#state();
    const registration = this.#requireRegistration(loaded.state, id);
    if (registration.unregistered) throw invalid("registration is unregistered", "InvalidStateError");
    return clone(registration.navigation_preload);
  }

  async configureNavigationPreload(input) {
    const value = requireObject(input, "navigation preload input");
    const registrationID = requireString(value.registration_id, "registration_id", { max: 256 });
    if (value.enabled === undefined && value.header_value === undefined) throw invalid("navigation preload update is empty", "TypeError");
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw invalid("navigation preload enabled state is invalid", "TypeError");
    const headerValue = value.header_value === undefined ? undefined : navigationPreloadHeaderValue(value.header_value);
    const mutation = await this.#mutate(value.operation_id, (state) => {
      const registration = this.#requireRegistration(state, registrationID);
      if (registration.unregistered) throw invalid("registration is unregistered", "InvalidStateError");
      if (value.enabled !== undefined) registration.navigation_preload.enabled = value.enabled;
      if (headerValue !== undefined) registration.navigation_preload.header_value = headerValue;
      return { registration_id: registrationID, navigation_preload: clone(registration.navigation_preload) };
    });
    return mutation.result.navigation_preload;
  }


  async completeInstall(input) {
    const value = requireObject(input, "completeInstall input");
    const registrationID = requireString(value.registration_id, "registration_id", { max: 256 });
    const workerVersion = requireString(value.worker_version, "worker_version", { max: 256 });
    if (typeof value.success !== "boolean") throw invalid("success must be boolean", "TypeError");
    const mutation = await this.#mutate(value.operation_id, (state) => {
      const registration = this.#requireRegistration(state, registrationID);
      const version = this.#requireVersion(registration, workerVersion);
      if (registration.installing_version !== workerVersion || version.state !== "INSTALLING") throw invalid("worker is not installing");
      registration.installing_version = null;
      if (!value.success) {
        assertStateTransition(version, "REDUNDANT");
        return { registration_id: registrationID, state: "REDUNDANT", worker_version: workerVersion };
      }
      assertStateTransition(version, "INSTALLED_WAITING");
      if (registration.waiting_version !== null) throw invalid("waiting worker already exists", "InvalidStateError");
      registration.waiting_version = workerVersion;
      return {
        activation_eligible: version.skip_waiting_requested || registration.active_version === null || controlledClientCount(state, registrationID, registration.active_version) === 0,
        registration_id: registrationID,
        state: "INSTALLED_WAITING",
        worker_version: workerVersion,
      };
    });
    return mutation.result;
  }

  async beginActivation(input) {
    const value = requireObject(input, "beginActivation input");
    const registrationID = requireString(value.registration_id, "registration_id", { max: 256 });
    const workerVersion = requireString(value.worker_version, "worker_version", { max: 256 });
    const mutation = await this.#mutate(value.operation_id, (state) => {
      const registration = this.#requireRegistration(state, registrationID);
      const version = this.#requireVersion(registration, workerVersion);
      if (registration.waiting_version !== workerVersion || version.state !== "INSTALLED_WAITING") throw invalid("worker is not waiting");
      const activeClients = registration.active_version === null ? 0 : controlledClientCount(state, registrationID, registration.active_version);
      if (!value.force && !version.skip_waiting_requested && registration.active_version !== null && activeClients !== 0) {
        throw invalid("activation is not eligible");
      }
      assertStateTransition(version, "ACTIVATING");
      registration.waiting_version = null;
      return { registration_id: registrationID, state: "ACTIVATING", worker_version: workerVersion };
    });
    return mutation.result;
  }

  async skipWaiting(input) {
    const value = requireObject(input, "skipWaiting input");
    const registrationID = requireString(value.registration_id, "registration_id", { max: 256 });
    const workerVersion = requireString(value.worker_version, "worker_version", { max: 256 });
    const mutation = await this.#mutate(value.operation_id, (state) => {
      const registration = this.#requireRegistration(state, registrationID);
      const version = this.#requireVersion(registration, workerVersion);
      if (registration.installing_version === workerVersion && version.state === "INSTALLING") {
        version.skip_waiting_requested = true;
        return { registration_id: registrationID, skip_waiting_requested: true, state: "INSTALLING", worker_version: workerVersion };
      }
      if (registration.waiting_version !== workerVersion || version.state !== "INSTALLED_WAITING") throw invalid("skipWaiting requires an installing or waiting worker");
      version.skip_waiting_requested = true;
      assertStateTransition(version, "ACTIVATING");
      registration.waiting_version = null;
      return { registration_id: registrationID, skip_waiting_requested: true, state: "ACTIVATING", worker_version: workerVersion };
    });
    return mutation.result;
  }

  async completeActivation(input) {
    const value = requireObject(input, "completeActivation input");
    const registrationID = requireString(value.registration_id, "registration_id", { max: 256 });
    const workerVersion = requireString(value.worker_version, "worker_version", { max: 256 });
    if (typeof value.success !== "boolean") throw invalid("success must be boolean", "TypeError");
    const mutation = await this.#mutate(value.operation_id, (state) => {
      const registration = this.#requireRegistration(state, registrationID);
      const version = this.#requireVersion(registration, workerVersion);
      if (version.state !== "ACTIVATING") throw invalid("worker is not activating");
      if (!value.success) {
        assertStateTransition(version, "REDUNDANT");
        return { registration_id: registrationID, state: "REDUNDANT", worker_version: workerVersion };
      }
      const previous = registration.active_version && this.#requireVersion(registration, registration.active_version);
      if (previous && previous !== version) assertStateTransition(previous, "REDUNDANT");
      assertStateTransition(version, "ACTIVE");
      registration.active_version = workerVersion;
      const controllerChanges=previous===version?[]:promoteControlledClients(state,registration,previous,workerVersion);
      return { controller_changes:controllerChanges, registration_id: registrationID, state: "ACTIVE", worker_version: workerVersion };
    });
    const {controller_changes:controllerChanges=[],...result}=mutation.result;
    await this.#deliverControllerChanges(value.operation_id,controllerChanges);
    return result;
  }

  async unregister(input) {
    const value = requireObject(input, "unregister input");
    const registrationID = requireString(value.registration_id, "registration_id", { max: 256 });
    const mutation = await this.#mutate(value.operation_id, (state) => {
      const registration = this.#requireRegistration(state, registrationID);
      if(registration.unregistered)return { registration_id: registrationID, unregistered: false };
      registration.unregistered = true;
      return { registration_id: registrationID, unregistered: true };
    });
    return mutation.result;
  }

  async getRegistration(url) {
    const loaded = await this.#state();
    const registration = resolveRegistration(loaded.state, targetURL(url, this.#targetOrigin, "url"));
    return registration === null ? null : clone(registration);
  }

  async getRegistrations() {
    const loaded = await this.#state();
    return loaded.state.registrations.filter((registration) => !registration.unregistered).map((registration) => clone(registration));
  }

  async updateFound(registrationID) {
    const loaded = await this.#state();
    const registration = this.#requireRegistration(loaded.state, registrationID);
    if (registration.installing_version === null) return null;
    return clone(this.#requireVersion(registration, registration.installing_version));
  }

  async ready(clientID) {
    const loaded = await this.#state();
    const client = this.#requireClient(loaded.state, clientID);
    if (!client.controller) return null;
    const registration = this.#requireRegistration(loaded.state, client.controller.registration_id);
    return clone(registration);
  }

  async commitClient(input) {
    const value = requireObject(input, "commitClient input");
    const clientID = requireString(value.client_id, "client_id", { max: 256 });
    const url = targetURL(value.url, this.#targetOrigin, "url");
    const type = value.type ?? "window";
    if (!["window", "worker"].includes(type)) throw invalid("client type is invalid", "TypeError");
    const mutation = await this.#mutate(value.operation_id, (state) => {
      let client = clientFor(state, clientID);
      const registration = resolveRegistration(state, url);
      const controller = registration?.active_version ? clientController(registration, registration.active_version, (client?.controller_revision ?? 0) + 1) : null;
      if (!client) {
        client = { client_id: clientID, controller: null, controller_revision: 0, created_at: this.#clock.now(), type, url };
        state.clients.push(client);
      }
      const controllerChanged = !controllerEqual(client.controller, controller);
      client.url = url;
      client.type = type;
      if (controllerChanged) {
        client.controller_revision += 1;
        client.controller = controller === null ? null : clientController(registration, registration.active_version, client.controller_revision);
      }
      return {
        client: clone(client),
        controller_change: controllerChanged ? { client_id: clientID, controller: clone(client.controller), controller_revision: client.controller_revision } : null,
      };
    });
    if (mutation.result.controller_change) await this.#deliverControllerChanges(value.operation_id, [mutation.result.controller_change]);
    return mutation.result.client;
  }

  async releaseClient(input) {
    const value = requireObject(input, "releaseClient input");
    const clientID = requireString(value.client_id, "client_id", { max: 256 });
    const mutation = await this.#mutate(value.operation_id, (state) => {
      const client = this.#requireClient(state, clientID);
      state.clients.splice(state.clients.indexOf(client), 1);
      const activation = [];
      for (const registration of state.registrations) {
        if (registration.unregistered || !registration.waiting_version || !registration.active_version) continue;
        if (controlledClientCount(state, registration.registration_id, registration.active_version) !== 0) continue;
        const waiting = this.#requireVersion(registration, registration.waiting_version);
        assertStateTransition(waiting, "ACTIVATING");
        registration.waiting_version = null;
        activation.push({ registration_id: registration.registration_id, worker_version: waiting.worker_version });
      }
      return { activation_required: activation, client_id: clientID };
    });
    return mutation.result;
  }

  async claim(input) {
    const value = requireObject(input, "claim input");
    const registrationID = requireString(value.registration_id, "registration_id", { max: 256 });
    const workerVersion = requireString(value.worker_version, "worker_version", { max: 256 });
    const mutation = await this.#mutate(value.operation_id, (state) => {
      const registration = this.#requireRegistration(state, registrationID);
      if (registration.active_version !== workerVersion || this.#requireVersion(registration, workerVersion).state !== "ACTIVE") {
        throw invalid("clients.claim requires the active worker");
      }
      const changes = [];
      for (const client of state.clients) {
        if (!matchesScope(registration, client.url) || controllerEqual(client.controller, { registration_id: registrationID, worker_version: workerVersion })) continue;
        client.controller_revision += 1;
        client.controller = clientController(registration, workerVersion, client.controller_revision);
        changes.push({ client_id: client.client_id, controller: clone(client.controller), controller_revision: client.controller_revision });
      }
      return { changes, registration_id: registrationID, worker_version: workerVersion };
    });
    await this.#deliverControllerChanges(value.operation_id, mutation.result.changes);
    return mutation.result;
  }

  async matchAll(input = {}) {
    const value = requireObject(input, "matchAll input");
    const includeUncontrolled = value.include_uncontrolled === true;
    const type = value.type ?? "all";
    if (!["all", "window", "worker"].includes(type)) throw invalid("client type is invalid", "TypeError");
    const registrationID = value.registration_id === undefined ? null : requireString(value.registration_id, "registration_id", { max: 256 });
    const workerVersion = value.worker_version === undefined ? null : requireString(value.worker_version, "worker_version", { max: 256 });
    if ((registrationID === null) !== (workerVersion === null)) throw invalid("client match controller is incomplete", "TypeError");
    const loaded = await this.#state();
    return loaded.state.clients
      .filter((client) => {
        const controlled = registrationID === null
          ? client.controller !== null
          : client.controller?.registration_id === registrationID && client.controller.worker_version === workerVersion;
        return (includeUncontrolled || controlled) && (type === "all" || client.type === type);
      })
      .sort((left, right) => left.created_at - right.created_at || left.client_id.localeCompare(right.client_id))
      .map((client) => clone(client));
  }

  async getClient(input) {
    const value = requireObject(input, "getClient input");
    const clientID = requireString(value.client_id, "client_id", { max: 256 });
    const loaded = await this.#state();
    const client = clientFor(loaded.state, clientID);
    return client === null ? null : clone(client);
  }

  async focus(input) {
    const value = requireObject(input, "focus input");
    const client = await this.#clientForCommand(value.client_id);
    if (client.type !== "window") throw invalid("client is not a WindowClient", "TypeError");
    const response = await this.#clientCommand("CLIENT_FOCUS", value.operation_id, client, {});
    if (requireString(response.client_id, "client command response client_id", { max: 256 }) !== client.client_id) {
      throw invalid("focused client identity mismatch", "SecurityError");
    }
    return { client, response };
  }

  async navigate(input) {
    const value = requireObject(input, "navigate input");
    const client = await this.#clientForCommand(value.client_id);
    if (client.type !== "window") throw invalid("client is not a WindowClient", "TypeError");
    const url = targetURL(value.url, this.#targetOrigin, "url");
    const response = await this.#clientCommand("CLIENT_NAVIGATE", value.operation_id, client, { url });
    if (response.client_id === null) return { client: null, response };
    if (requireString(response.client_id, "client command response client_id", { max: 256 }) !== client.client_id) {
      throw invalid("navigated client identity mismatch", "SecurityError");
    }
    const committed = await this.commitClient({ operation_id: `${operationID(value.operation_id)}:commit`, client_id: client.client_id, type: client.type, url });
    return { client: committed, response };
  }

  async openWindow(input) {
    const value = requireObject(input, "openWindow input");
    const clientID = requireString(value.client_id, "client_id", { max: 256 });
    const url = targetURL(value.url, this.#targetOrigin, "url");
    const response = await this.#clientCommand("CLIENT_OPEN_WINDOW", value.operation_id, null, { client_id: clientID, url });
    if (response.client_id === null) return { client: null, response };
    const openedID = requireString(response.client_id, "client command response client_id", { max: 256 });
    return this.commitClient({ operation_id: `${operationID(value.operation_id)}:commit`, client_id: openedID, type: "window", url }).then((client) => ({ client, response }));
  }

  async postMessage(input) {
    const value = requireObject(input, "postMessage input");
    const client = await this.#clientForCommand(value.client_id);
    const transfer = transferables(value.transfer, "client message transfer list");
    if (!("message" in value) || structuredByteLength({ message: value.message, transfer }, this.#limits.max_event_bytes) > this.#limits.max_event_bytes) {
      throw invalid("message exceeds limit", "QuotaExceededError");
    }
    return this.#clientCommand("CLIENT_POST_MESSAGE", value.operation_id, client, { message: value.message, transfer }, transfer);
  }
  async dispatchLifecycle(input) {
    const value = requireObject(input, "lifecycle input");
    const eventID = requireString(value.event_id, "event_id", { max: 256 });
    const eventType = requireString(value.event_type, "event_type", { max: 32 });
    if (!LIFECYCLE_EVENTS.includes(eventType)) throw invalid("unsupported lifecycle event", "NotSupportedError");
    const registrationID = requireString(value.registration_id, "registration_id", { max: 256 });
    const workerVersion = requireString(value.worker_version, "worker_version", { max: 256 });
    const operation = operationID(value.operation_id);
    if (this.#events.has(eventID)) throw invalid("event is already active", "InvalidStateError");
    const loaded = await this.#state();
    const registration = this.#requireRegistration(loaded.state, registrationID);
    const version = this.#requireVersion(registration, workerVersion);
    if (!validLifecycleState(eventType, registration, version, workerVersion)) throw invalid("lifecycle event state mismatch");
    const event = createLifecycleEvent(value, eventID, eventType, registrationID, workerVersion, registration, loaded.state);
    void event.lifetime.promise.catch(() => {});
    this.#events.set(eventID, event);
    try {
      event.session = await this.#queueForSession(event, registration, version);
      await this.#host.send(Object.freeze({
        v: 1,
        type: "EVENT_START",
        binding: eventBinding(this.#binding, registrationID, workerVersion),
        session_id: event.session.session_id,
        event_id: eventID,
        event_type: eventType,
        client_id: event.client_id,
        resulting_client_id: event.resulting_client_id,
        request_plan: event.request_plan,
        source_client: event.source_client,
        transfer: event.transfer,
        dispatch_deadline: deadline(this.#clock, this.#limits.dispatch_claim_ms),
        lifetime_deadline: deadline(this.#clock, this.#limits.event_lifetime_ms),
      }), event.transfer);
      event.transfer = [];
      this.#armLifetimeTimer(event);
      const decision = await this.#withTimeout(event.decision.promise, this.#limits.dispatch_claim_ms, "DISPATCH_TIMEOUT");
      if (decision !== "NO_RESPONSE") throw invalid("lifecycle event attempted to claim a response", "InvalidStateError");
      await event.lifetime.promise;
      if (eventType === "install") {
        return await this.completeInstall({ operation_id: `${operation}:complete`, registration_id: registrationID, success: true, worker_version: workerVersion });
      }
      if (eventType === "activate") {
        return await this.completeActivation({ operation_id: `${operation}:complete`, registration_id: registrationID, success: true, worker_version: workerVersion });
      }
      return Object.freeze({ event_id: eventID, outcome: "completed" });
    } catch (error) {
      if (eventType === "install") await this.completeInstall({ operation_id: `${operation}:failed`, registration_id: registrationID, success: false, worker_version: workerVersion });
      if (eventType === "activate") await this.completeActivation({ operation_id: `${operation}:failed`, registration_id: registrationID, success: false, worker_version: workerVersion });
      throw error;
    } finally {
      this.#events.delete(eventID);
      this.#clearLifetimeTimer(event);
    }
  }


  admitNativeFetch(nativeEvent, input) {
    const event = requireObject(nativeEvent, "native event");
    const respondWith = requireFunction(event.respondWith, "nativeEvent.respondWith").bind(event);
    const waitUntil = requireFunction(event.waitUntil, "nativeEvent.waitUntil").bind(event);
    const dispatch = this.startFetch(input);
    respondWith(dispatch.response);
    waitUntil(dispatch.lifetime);
    return dispatch;
  }

  async controlsFetch(input) {
    const value = requireObject(input, "controlsFetch input");
    const url = targetURL(value.url, this.#targetOrigin, "url");
    const clientID = value.client_id === undefined ? undefined : requireString(value.client_id, "client_id", { max: 256 });
    const loaded = await this.#state();
    const registration = resolveRegistration(loaded.state, url);
    if (!registration || registration.unregistered) return false;
    const version = this.#resolveVersionForEvent(loaded.state, registration, clientID);
    return version?.state === "ACTIVE";
  }

  #fetchDispatch(event) {
    return Object.freeze({
      get claimed() { return event.claimed; },
      lifetime: event.lifetime.promise,
      response: event.response,
    });
  }

  startFetch(input) {
    const value = requireObject(input, "fetch input");
    const eventID = requireString(value.event_id, "event_id", { max: 256 });
    const url = targetURL(value.url, this.#targetOrigin, "url");
    const registration = value.registration_id === undefined ? null : requireString(value.registration_id, "registration_id", { max: 256 });
    const workerVersion = value.worker_version === undefined ? null : requireString(value.worker_version, "worker_version", { max: 256 });
    const existing = this.#events.get(eventID);
    if (existing) return this.#fetchDispatch(existing);
    const event = {
      claimed: false,
      client_id: value.client_id === undefined ? undefined : requireString(value.client_id, "client_id", { max: 256 }),
      complete_sent: false,
      decision: deferred(),
      dispatch_closed: false,
      event_id: eventID,
      event_type: "fetch",
      failed: null,
      fallback_started: false,
      fallback_response: null,
      final_wait_seq: 0,
      headers: deferred(),
      headers_received: false,
      lifetime: deferred(),
      lifetime_closed: false,
      lifetime_timer: null,
      lifetime_failed: false,
      max_wait_seq: 0,
      pending_bytes: 0,
      pending_chunk: null,
      pending_count: 0,
      preload: this.#preparePreload(value.preload, eventID),
      registration_id: registration,
      request_plan: clone(value.request_plan ?? {}),
      resulting_client_id: value.resulting_client_id === undefined ? undefined : requireString(value.resulting_client_id, "resulting_client_id", { max: 256 }),
      response: null,
      response_body_present: false,
      sequence: 0,
      session: null,
      stream: null,
      stream_controller: null,
      stream_end: false,
      stream_pulled: false,
      stream_timer: null,
      url,
      waits: new Map(),
      worker_version: workerVersion,
    };
    void event.decision.promise.catch(() => {});
    void event.headers.promise.catch(() => {});
    void event.lifetime.promise.catch(() => {});
    event.response = this.#runFetch(event);
    this.#events.set(eventID, event);
    return this.#fetchDispatch(event);
  }

  async #runFetch(event) {
    let registration;
    let version;
    try {
      const loaded = await this.#state();
      registration = event.registration_id ? this.#requireRegistration(loaded.state, event.registration_id) : resolveRegistration(loaded.state, event.url);
      if (!registration || registration.unregistered) return this.#controlledFallback(event, "NO_REGISTRATION", true);
      version = event.worker_version ? this.#requireVersion(registration, event.worker_version) : this.#resolveVersionForEvent(loaded.state, registration, event.client_id);
      if (!version || version.state !== "ACTIVE") return this.#controlledFallback(event, "NO_ACTIVE_WORKER", true);
      event.registration_id = registration.registration_id;
      event.worker_version = version.worker_version;
      this.#activatePreload(event, registration);
      event.session = await this.#queueForSession(event, registration, version);
      await this.#host.send(Object.freeze({
        v: 1,
        type: "EVENT_START",
        binding: eventBinding(this.#binding, registration.registration_id, version.worker_version),
        session_id: event.session.session_id,
        event_id: event.event_id,
        event_type: "fetch",
        client_id: event.client_id,
        resulting_client_id: event.resulting_client_id,
        request_plan: event.request_plan,
        preload_handle: event.preload?.handle,
        dispatch_deadline: deadline(this.#clock, this.#limits.dispatch_claim_ms),
        lifetime_deadline: deadline(this.#clock, this.#limits.event_lifetime_ms),
      }));
      this.#armLifetimeTimer(event);
      const decision = await this.#withTimeout(event.decision.promise, this.#limits.dispatch_claim_ms, "DISPATCH_TIMEOUT");
      if (decision === "NO_RESPONSE") return event.fallback_response;
      return await this.#withTimeout(event.headers.promise, this.#limits.response_headers_ms, "RESPONSE_HEADERS_TIMEOUT");
    } catch (error) {
      if (!event.claimed) {
        if(event.fallback_started)throw this.#fetchFailure(error);
        return this.#controlledFallback(event, error?.message ?? "PRECLAIM_FAILURE", true);
      }
      this.#terminal(event, error, "response");
      throw this.#fetchFailure(error);
    }
  }

  #preparePreload(value, eventID) {
    if (value === undefined || value === null) return null;
    const preload = requireObject(value, "preload");
    return {
      cancel: preload.cancel === undefined ? null : requireFunction(preload.cancel, "preload.cancel"),
      handle: preload.handle === undefined ? undefined : requireString(preload.handle, "preload.handle", { max: 256 }),
      response: null,
      start: requireFunction(preload.start, "preload.start"),
      state: "pending",
      event_id: eventID,
    };
  }

  #activatePreload(event, registration) {
    const preload = event.preload;
    if (!preload) return;
    if (registration.navigation_preload.enabled !== true) {
      event.preload = null;
      return;
    }
    preload.state = "available";
    try {
      preload.response = Promise.resolve(preload.start(Object.freeze({
        binding: this.#binding,
        event_id: preload.event_id,
        header_value: registration.navigation_preload.header_value,
      })));
    } catch (error) {
      preload.state = "failed";
      throw error;
    }
  }

  #cancelPreload(event, reason) {
    const preload = event.preload;
    if (!preload || preload.state !== "available") return;
    preload.state = "canceled";
    if (preload.cancel) void Promise.resolve(preload.cancel(reason)).catch(() => {});
  }

  #fallbackPreload(event) {
    const preload = event.preload;
    if (!preload || preload.state !== "available") return undefined;
    preload.state = "fallback-reserved";
    return Object.freeze({
      then(resolve, reject) {
        if (preload.state !== "fallback-reserved") {
          reject(invalid("navigation preload is unavailable", "InvalidStateError"));
          return;
        }
        preload.state = "fallback";
        preload.response.then(resolve, reject);
      },
    });
  }

  async consumePreload(input) {
    const value = requireObject(input, "preload input");
    const eventID = requireString(value.event_id, "event_id", { max: 256 });
    const registrationID = requireString(value.registration_id, "registration_id", { max: 256 });
    const workerVersion = requireString(value.worker_version, "worker_version", { max: 256 });
    const handle = requireString(value.preload_handle, "preload_handle", { max: 256 });
    const event = this.#events.get(eventID);
    if (!event || event.registration_id !== registrationID || event.worker_version !== workerVersion) {
      throw invalid("navigation preload event is stale", "SecurityError");
    }
    const preload = event.preload;
    if (!preload || preload.handle !== handle || preload.state !== "available") {
      throw invalid("navigation preload is unavailable", "InvalidStateError");
    }
    preload.state = "transferred";
    const response = await preload.response;
    if (!(response instanceof Response)) throw invalid("navigation preload did not return Response", "NetworkError");
    return response;
  }

  async #controlledFallback(event, reason, closeLifetime = false) {
    if (event.claimed) throw this.#fetchFailure(invalid("claimed response cannot fall back", "NetworkError"));
    if (event.fallback_started) throw this.#fetchFailure(invalid("controlled fallback already started", "NetworkError"));
    event.fallback_started = true;
    try {
      const response = await this.#controlledFetch(Object.freeze({
        binding: this.#binding,
        event_id: event.event_id,
        preload_response: this.#fallbackPreload(event),
        reason,
        request_plan: event.request_plan,
        url: event.url,
      }));
      if (!(response instanceof Response)) throw invalid("controlled fallback did not return Response", "NetworkError");
      return response;
    } finally {
      if (event.preload?.state === "fallback-reserved") event.preload.state = "available";
      this.#cancelPreload(event, reason);
      if (closeLifetime && !event.lifetime.settled) {
        event.lifetime_closed = true;
        this.#clearLifetimeTimer(event);
        event.lifetime.resolve({ fallback: reason });
        this.#maybeCloseEvent(event);
      }
    }
  }

  #resolveVersionForEvent(state, registration, clientID) {
    if (clientID) {
      const client = clientFor(state, clientID);
      if (client?.controller?.registration_id === registration.registration_id) return versionFor(registration, client.controller.worker_version);
    }
    return registration.active_version ? versionFor(registration, registration.active_version) : null;
  }

  async #queueForSession(event, registration, version) {
    const hasUpload=event.event_type==="fetch"&&event.request_plan?.body instanceof Uint8Array,eventLimit=hasUpload?this.#limits.max_fetch_event_bytes:this.#limits.max_event_bytes;
    const eventBytes=structuredByteLength({request_plan:event.request_plan,transfer:event.transfer},eventLimit);
    if(eventBytes>eventLimit)throw invalid("event request plan exceeds limit","QuotaExceededError");
    const session=this.#ensureSession(registration,version),queueLimit=Math.max(this.#limits.max_event_bytes,this.#limits.max_fetch_event_bytes);
    if(session.queue.length>=this.#limits.max_events_per_registration||session.queue_bytes+eventBytes>queueLimit){
      throw invalid("worker event queue limit exceeded","QuotaExceededError");
    }
    const queueEntry = { event, bytes: eventBytes };
    session.queue.push(queueEntry);
    session.queue_bytes += eventBytes;
    try {
      return await this.#withTimeout(session.ready.promise, this.#limits.host_start_ms, "HOST_START_TIMEOUT");
    } catch (error) {
      this.#crashSession(session, error);
      throw error;
    } finally {
      const index = session.queue.indexOf(queueEntry);
      if (index >= 0) session.queue.splice(index, 1);
      session.queue_bytes -= eventBytes;
    }
  }

  #ensureSession(registration, version) {
    const key = sessionKey(registration.registration_id, version.worker_version);
    const current = this.#sessions.get(key);
    if (current && !current.crashed) return current;
    const session = {
      crashed: false,
      graph_hash: version.graph.graph_hash,
      queue: [],
      queue_bytes: 0,
      ready: deferred(),
      registration_id: registration.registration_id,
      session_id: null,
      seen_message_ids: new Set(),
      worker_version: version.worker_version,
    };
    this.#sessions.set(key, session);
    void Promise.resolve(this.#host.hydrate(Object.freeze({
      v: 1,
      type: "HYDRATE_WORKER",
      binding: eventBinding(this.#binding, registration.registration_id, version.worker_version),
      graph: clone(version.graph),
    }))).then((reply) => {
      const value = requireObject(reply, "host hydrate reply");
      if (!equalBinding(value.binding, eventBinding(this.#binding, registration.registration_id, version.worker_version), { requireRegistration: true, requireVersion: true })) {
        throw invalid("host hydration binding mismatch", "SecurityError");
      }
      if (value.graph_hash !== version.graph.graph_hash) throw invalid("host hydration graph hash mismatch", "SecurityError");
      session.session_id = requireString(value.session_id, "host session_id", { max: 256 });
    }).catch((error) => this.#crashSession(session, error));
    return session;
  }

  async receiveWorkerMessage(message) {
    const envelope = requireObject(message, "worker message");
    if(envelope.v!==1)throw invalid("unsupported worker protocol version","SecurityError");
    const type = requireString(envelope.type, "worker message type", { max: 64 });
    const registrationID = requireString(envelope.registration_id ?? envelope.binding?.registration_id, "registration_id", { max: 256 });
    const workerVersion = requireString(envelope.worker_version ?? envelope.binding?.worker_version, "worker_version", { max: 256 });
    const session = this.#sessions.get(sessionKey(registrationID, workerVersion));
    if (!session || session.crashed || session.session_id === null) throw invalid("stale worker session", "SecurityError");
    const expected = eventBinding(this.#binding, registrationID, workerVersion);
    if (!equalBinding(envelope.binding, expected, { requireRegistration: true, requireVersion: true }) || envelope.session_id !== session.session_id) {
      throw invalid("worker capability binding mismatch", "SecurityError");
    }
    const messageID = requireString(envelope.message_id, "message_id", { max: 256 });
    if (session.seen_message_ids.has(messageID)) return Object.freeze({ duplicate: true });
    if (session.seen_message_ids.size >= this.#limits.max_stream_chunks) throw invalid("worker message limit exceeded", "QuotaExceededError");
    session.seen_message_ids.add(messageID);
    if (type === "WORKER_READY") {
      if (envelope.graph_hash !== session.graph_hash) throw invalid("worker graph hash mismatch", "SecurityError");
      session.ready.resolve(session);
      return Object.freeze({ ready: true });
    }
    const eventID = requireString(envelope.event_id, "event_id", { max: 256 });
    const event = this.#events.get(eventID);
    if (!event || event.session !== session) throw invalid("stale event", "SecurityError");
    switch (type) {
      case "RESPOND_WITH_CLAIMED": return this.#claim(event);
      case "NO_RESPONSE": return this.#noResponse(event);
      case "RESPONSE_HEADERS": return this.#headers(event, envelope);
      case "RESPONSE_CHUNK": return this.#chunk(event, envelope.sequence, envelope.bytes);
      case "RESPONSE_END": return this.#end(event, envelope.sequence);
      case "WAIT_UNTIL_ADD": return this.#waitAdd(event, envelope);
      case "WAIT_UNTIL_SETTLED": return this.#waitSettled(event, envelope);
      case "DISPATCH_CLOSED": return this.#dispatchClosed(event, envelope);
      case "LIFETIME_CLOSED": return this.#lifetimeClosed(event, envelope);
      case "EVENT_FAIL": return this.#eventFail(event, envelope);
      default: throw invalid("worker protocol message is unsupported", "SecurityError");
    }
  }

  #claim(event) {
    if (event.event_type !== "fetch") throw invalid("respondWith is not available for this event", "InvalidStateError");
    if (event.claimed || event.decision.settled) throw invalid("response already decided", "InvalidStateError");
    event.claimed = true;
    event.decision.resolve("CLAIMED");
    return Object.freeze({ claimed: true });
  }

  #noResponse(event) {
    if (event.claimed || event.decision.settled) throw invalid("response already decided", "InvalidStateError");
    event.fallback_response = this.#controlledFallback(event, "NO_RESPONSE");
    void event.fallback_response.catch(() => {});
    event.decision.resolve("NO_RESPONSE");
    return Object.freeze({ no_response: true });
  }

  async #headers(event, message) {
    if (!event.claimed || event.headers_received) throw invalid("response headers are invalid", "InvalidStateError");
    const plan = message.response_plan;
    const bodyPresent=responseBodyPresent(plan);
    event.headers_received = true;
    event.response_body_present=bodyPresent;
    event.stream = bodyPresent?new ReadableStream({
      start: (controller) => { event.stream_controller = controller; this.#flushStream(event); },
      pull: () => {
        event.stream_pulled = true;
        this.#flushStream(event);
        void this.#sendStreamControl(event, "STREAM_PULL", { sequence: event.sequence });
      },
      cancel: () => {
        this.#clearStreamTimer(event);
        void this.#sendStreamControl(event, "STREAM_CANCEL", {});
      },
    }, { highWaterMark: 0 }):null;
    try {
      const response = responseFromPlan(plan,event.stream,bodyPresent);
      event.headers.resolve(response);
      if(bodyPresent)this.#resetStreamTimer(event);
    } catch (error) {
      this.#terminal(event, error, "headers");
      throw error;
    }
    return Object.freeze({ headers: true });
  }

  #chunk(event, sequence, value) {
    if (!event.claimed || !event.headers_received || !event.response_body_present || event.stream_end) throw invalid("response chunk is invalid", "InvalidStateError");
    requireInteger(sequence, "sequence", { min: 0 });
    if (sequence !== event.sequence) throw invalid("response chunk sequence mismatch", "SecurityError");
    const chunk = bytes(value, "response chunk", this.#limits.max_stream_chunk_bytes);
    if (event.pending_chunk !== null) {
      const error = invalid("response stream exceeded backpressure", "QuotaExceededError");
      this.#terminal(event, error, "stream");
      throw error;
    }
    event.sequence += 1;
    event.pending_chunk = chunk;
    event.pending_bytes = chunk.byteLength;
    this.#flushStream(event);
    this.#resetStreamTimer(event);
    return Object.freeze({ chunk: sequence });
  }

  #end(event, sequence) {
    if (!event.claimed || !event.headers_received || event.stream_end) throw invalid("response end is invalid", "InvalidStateError");
    requireInteger(sequence, "sequence", { min: 0 });
    if(sequence!==event.sequence)throw invalid("response end sequence mismatch","SecurityError");
    event.stream_end = true;
    this.#flushStream(event);
    if(!event.response_body_present)this.#maybeCloseEvent(event);
    return Object.freeze({ ended: true, sequence });
  }

  #flushStream(event) {
    if (!event.stream_controller) return;
    if (event.stream_pulled && event.pending_chunk !== null) {
      const chunk = event.pending_chunk;
      event.pending_chunk = null;
      event.pending_bytes = 0;
      event.stream_pulled = false;
      try { event.stream_controller.enqueue(chunk); } catch (error) { this.#terminal(event, error, "stream"); return; }
    }
    if (event.stream_end && event.pending_chunk === null) {
      this.#clearStreamTimer(event);
      try { event.stream_controller.close(); } catch {}
      this.#maybeCloseEvent(event);
    }
  }

  #resetStreamTimer(event) {
    this.#clearStreamTimer(event);
    event.stream_timer = this.#timer.setTimeout(() => this.#terminal(event, invalid("STREAM_IDLE_TIMEOUT", "TimeoutError"), "stream"), this.#limits.stream_idle_ms);
  }

  #clearStreamTimer(event) {
    if (event.stream_timer !== null) this.#timer.clearTimeout(event.stream_timer);
    event.stream_timer = null;
  }

  #armLifetimeTimer(event) {
    this.#clearLifetimeTimer(event);
    event.lifetime_timer = this.#timer.setTimeout(
      () => this.#terminal(event, invalid("EVENT_LIFETIME_TIMEOUT", "TimeoutError"), "lifetime"),
      this.#limits.event_lifetime_ms,
    );
  }

  #clearLifetimeTimer(event) {
    if (event.lifetime_timer !== null) this.#timer.clearTimeout(event.lifetime_timer);
    event.lifetime_timer = null;
  }

  #waitAdd(event, message) {
    if (event.lifetime_closed) throw invalid("event lifetime is closed", "InvalidStateError");
    const sequence = requireInteger(message.wait_seq, "wait_seq", { min: 1 });
    const promiseID = requireString(message.promise_id, "promise_id", { max: 256 });
    const count = requireInteger(message.pending_count, "pending_count", { min: 1 });
    if (sequence <= event.max_wait_seq || event.waits.has(sequence) || count !== event.pending_count + 1) throw invalid("waitUntil add sequence mismatch", "SecurityError");
    event.max_wait_seq = sequence;
    event.pending_count = count;
    event.waits.set(sequence, promiseID);
    return Object.freeze({ pending_count: count });
  }

  #waitSettled(event, message) {
    const sequence = requireInteger(message.wait_seq, "wait_seq", { min: 1 });
    const promiseID = requireString(message.promise_id, "promise_id", { max: 256 });
    const count = requireInteger(message.pending_count, "pending_count", { min: 0 });
    if (event.waits.get(sequence) !== promiseID || count !== event.pending_count - 1 || !["fulfilled", "rejected"].includes(message.outcome)) {
      throw invalid("waitUntil settlement mismatch", "SecurityError");
    }
    event.waits.delete(sequence);
    event.pending_count = count;
    if (message.outcome === "rejected") event.lifetime_failed=true;
    return Object.freeze({ pending_count: count });
  }

  #dispatchClosed(event, message) {
    const maximum = requireInteger(message.max_wait_seq, "max_wait_seq", { min: 0 });
    const count = requireInteger(message.pending_count, "pending_count", { min: 0 });
    if (event.dispatch_closed || maximum !== event.max_wait_seq || count !== event.pending_count) throw invalid("dispatch close mismatch", "SecurityError");
    event.dispatch_closed = true;
    return Object.freeze({ dispatch_closed: true });
  }

  #lifetimeClosed(event, message) {
    const final = requireInteger(message.final_wait_seq, "final_wait_seq", { min: 0 });
    const expectedOutcome=event.lifetime_failed?"rejected":"fulfilled";
    if (!event.dispatch_closed || event.lifetime_closed || event.pending_count !== 0 || final !== event.max_wait_seq || message.outcome!==expectedOutcome) {
      throw invalid("lifetime close mismatch", "SecurityError");
    }
    event.lifetime_closed = true;
    this.#clearLifetimeTimer(event);
    event.final_wait_seq = final;
    if (event.lifetime_failed) event.lifetime.reject(invalid("worker lifetime rejected", "OperationError"));
    else event.lifetime.resolve({ final_wait_seq: final });
    this.#maybeCloseEvent(event);
    return Object.freeze({ lifetime_closed: true });
  }

  #eventFail(event, message) {
    const phase = requireString(message.phase, "phase", { max: 64 });
    const code = requireString(message.code, "code", { max: 128 });
    const error = invalid(`${phase}:${code}`, "OperationError");
    if (!event.claimed) {
      event.failed = this.#fetchFailure(error);
      event.decision.reject(event.failed);
      return Object.freeze({ failed: true });
    }
    this.#terminal(event, error, phase);
    return Object.freeze({ failed: true });
  }

  #terminal(event, cause, phase) {
    if (event.failed) return;
    const error = this.#fetchFailure(cause);
    event.failed = error;
    this.#clearStreamTimer(event);
    this.#clearLifetimeTimer(event);
    if (!event.decision.settled) event.decision.reject(error);
    if (!event.headers.settled) event.headers.reject(error);
    if (event.stream_controller) {
      try { event.stream_controller.error(error); } catch {}
    }
    if (!event.lifetime_closed) event.lifetime.reject(error);
    event.lifetime_closed = true;
    void this.#sendProtocol(event, "EVENT_FAIL", { phase, code: protocolFailureCode(cause) });
    void this.#sendStreamControl(event, "STREAM_CANCEL", {});
    this.#maybeCloseEvent(event);
  }

  async #sendProtocol(event, type, fields) {
    if (!event.session || event.session.crashed) return;
    try {
      await this.#host.send(Object.freeze({
        v: 1,
        type,
        binding: eventBinding(this.#binding, event.registration_id, event.worker_version),
        session_id: event.session.session_id,
        event_id: event.event_id,
        ...fields,
      }));
    } catch {
      this.#crashSession(event.session, invalid("host send failed", "NetworkError"));
    }
  }

  async #sendStreamControl(event, type, fields) {
    await this.#sendProtocol(event, type, fields);
  }

  #maybeCloseEvent(event) {
    if (!event.lifetime_closed) return;
    this.#clearLifetimeTimer(event);
    if (event.claimed && !event.stream_end && !event.failed) return;
    if(!event.failed&&!event.complete_sent){
      event.complete_sent=true;
      if(event.lifetime_failed)void this.#sendProtocol(event,"EVENT_FAIL",{phase:"lifetime",code:"WAIT_UNTIL_REJECTED"});
      else void this.#sendProtocol(event,"EVENT_COMPLETE",{final_wait_seq:event.final_wait_seq,response_sequence:event.sequence});
    }
    this.#cancelPreload(event, event.failed ? "EVENT_FAILED" : "EVENT_COMPLETE");
    this.#events.delete(event.event_id);
  }

  #crashSession(session, cause) {
    if (session.crashed) return;
    session.crashed = true;
    session.ready.reject(this.#fetchFailure(cause));
    this.#sessions.delete(sessionKey(session.registration_id, session.worker_version));
    const affected = new Set(session.queue.map((entry) => entry.event));
    for (const event of this.#events.values()) {
      if (event.session === session) affected.add(event);
    }
    for (const event of affected) {
      if (event.claimed) this.#terminal(event, cause, "host");
      else event.decision.reject(this.#fetchFailure(cause));
    }
    if (session.session_id && this.#host.terminate) void this.#host.terminate(Object.freeze({
      v: 1,
      type: "TERMINATE_WORKER",
      binding: eventBinding(this.#binding, session.registration_id, session.worker_version),
      session_id: session.session_id,
    })).catch(() => {});
  }

  close() {
    const error = invalid("target worker broker closed", "AbortError");
    for (const session of [...this.#sessions.values()]) this.#crashSession(session, error);
    for (const event of [...this.#events.values()]) {
      if (event.failed || event.session) continue;
      event.decision.reject(this.#fetchFailure(error));
      event.lifetime.reject(this.#fetchFailure(error));
      this.#clearLifetimeTimer(event);
      this.#events.delete(event.event_id);
    }
  }

  async crashWorker(input) {
    const value = requireObject(input, "crashWorker input");
    const registrationID = requireString(value.registration_id, "registration_id", { max: 256 });
    const workerVersion = requireString(value.worker_version, "worker_version", { max: 256 });
    const session = this.#sessions.get(sessionKey(registrationID, workerVersion));
    if (session) this.#crashSession(session, invalid("execution worker crashed", "NetworkError"));
  }

  async #withTimeout(promise, milliseconds, code) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = this.#timer.setTimeout(() => reject(invalid(code, "TimeoutError")), milliseconds);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      this.#timer.clearTimeout(timer);
    }
  }

  #fetchFailure(cause) {
    return cause instanceof DOMException && cause.name === "NetworkError" ? cause : invalid(cause?.message ?? "virtual worker fetch failure", "NetworkError");
  }

  #requireRegistration(state, registrationID) {
    return registrationFor(state, registrationID) ?? (() => { throw invalid("registration not found", "NotFoundError"); })();
  }

  #requireVersion(registration, workerVersion) {
    return versionFor(registration, workerVersion) ?? (() => { throw invalid("worker version not found", "NotFoundError"); })();
  }

  #requireClient(state, clientID) {
    return clientFor(state, requireString(clientID, "client_id", { max: 256 })) ?? (() => { throw invalid("client not found", "NotFoundError"); })();
  }

  async #clientForCommand(clientID) {
    const loaded = await this.#state();
    return clone(this.#requireClient(loaded.state, clientID));
  }

  async #clientCommand(type, id, client, payload, transfer = []) {
    if (!this.#clientCommands) throw invalid("virtual client command port is unavailable", "InvalidStateError");
    const operation = operationID(id);
    const commandBinding = client?.controller
      ? eventBinding(this.#binding, client.controller.registration_id, client.controller.worker_version)
      : this.#binding;
    const response = await this.#clientCommands.command(Object.freeze({
      v: 1,
      type,
      message_id: `${operation}:${type}:${client?.client_id ?? payload.client_id}`,
      binding: commandBinding,
      client_id: client?.client_id ?? payload.client_id,
      client_revision: client?.controller_revision ?? 0,
      capability: this.#binding.capability,
      ...payload,
    }), transfer);
    if (!response || response.binding === undefined || !equalBinding(response.binding, commandBinding, { requireRegistration: client?.controller !== null && client?.controller !== undefined, requireVersion: client?.controller !== null && client?.controller !== undefined })) {
      throw invalid("client command binding mismatch", "SecurityError");
    }
    return clone(response);
  }

  async #deliverControllerChanges(id, changes) {
    if (!changes.length) return;
    if (!this.#clientCommands) throw invalid("virtual client command port is unavailable", "InvalidStateError");
    const operation = operationID(id);
    for (const change of [...changes].sort((left, right) => left.controller_revision - right.controller_revision || left.client_id.localeCompare(right.client_id))) {
      const commandBinding = change.controller
        ? eventBinding(this.#binding, change.controller.registration_id, change.controller.worker_version)
        : this.#binding;
      const response = await this.#clientCommands.command(Object.freeze({
        v: 1,
        type: "CONTROLLER_CHANGE",
        message_id: `${operation}:controller:${change.client_id}:${change.controller_revision}`,
        binding: commandBinding,
        capability: this.#binding.capability,
        ...change,
      }));
      if (!response || response.binding === undefined || !equalBinding(response.binding, commandBinding, { requireRegistration: change.controller !== null, requireVersion: change.controller !== null })) {
        throw invalid("controller change binding mismatch", "SecurityError");
      }
    }
  }
}

export function createTargetWorkerBroker(configuration) {
  return new TargetWorkerBroker(configuration);
}

export { emptyTargetWorkerState };
