import { clone, equalBinding, invalid, requireInteger, requireObject, requireString, sameOriginURL } from "./validation.mjs";

export const WORKER_STATES = Object.freeze(["INSTALLING", "INSTALLED_WAITING", "ACTIVATING", "ACTIVE", "REDUNDANT"]);

export function emptyTargetWorkerState(binding) {
  return {
    binding: clone(binding),
    clients: [],
    operations: {},
    registrations: [],
    schema_version: 1,
  };
}

function validateOperations(operations, binding) {
  for (const [operationID, operation] of Object.entries(operations)) {
    requireString(operationID, "journal operation id", { max: 256 });
    const record = requireObject(operation, "journal operation record");
    if (!equalBinding(record.binding, binding)) throw invalid("journal operation binding mismatch", "SecurityError");
    requireObject(record.result, "journal operation result");
    if (record.binding.registration_id !== undefined)
      requireString(record.binding.registration_id, "journal operation registration_id", { max: 256 });
    if (record.binding.worker_version !== undefined)
      requireString(record.binding.worker_version, "journal operation worker_version", { max: 256 });
  }
}

function validateUnique(records, idField, validator, duplicateMessage) {
  const ids = new Set();
  for (const record of records) {
    validator(record);
    if (ids.has(record[idField])) throw invalid(duplicateMessage, "SecurityError");
    ids.add(record[idField]);
  }
}

export function validateState(value, binding, targetOrigin) {
  const state = requireObject(value, "journal state");
  if (state.schema_version !== 1) throw invalid("unsupported target-worker journal schema", "SecurityError");
  if (!equalBinding(state.binding, binding)) throw invalid("journal binding mismatch", "SecurityError");
  if (!Array.isArray(state.registrations)
    || !Array.isArray(state.clients)
    || !state.operations
    || typeof state.operations !== "object"
    || Array.isArray(state.operations))
    throw invalid("journal state shape is invalid", "SecurityError");
  validateOperations(state.operations, binding);
  validateUnique(state.registrations, "registration_id", registration =>
    validateRegistration(registration, targetOrigin), "duplicate registration");
  validateUnique(state.clients, "client_id", client =>
    validateClient(client, targetOrigin), "duplicate client");
  return state;
}

function registrationVersionIDs(registration,targetOrigin) {
  if (!Array.isArray(registration.versions)) throw invalid("registration.versions is invalid", "SecurityError");
  const versions = new Set();
  for (const version of registration.versions) {
    validateVersion(version,targetOrigin);
    if (versions.has(version.worker_version)) throw invalid("duplicate worker version", "SecurityError");
    versions.add(version.worker_version);
  }
  return versions;
}

function validateRegistrationPointers(registration, versions) {
  for (const field of ["active_version", "waiting_version", "installing_version"]) {
    if (registration[field] !== null && !versions.has(registration[field]))
      throw invalid(`registration.${field} is invalid`, "SecurityError");
  }
  const expectedStates = [
    ["active_version", "ACTIVE", "active version state mismatch"],
    ["waiting_version", "INSTALLED_WAITING", "waiting version state mismatch"],
    ["installing_version", "INSTALLING", "installing version state mismatch"],
  ];
  for (const [field, expected, message] of expectedStates) {
    const version = registration[field] && versionFor(registration, registration[field]);
    if (version && version.state !== expected) throw invalid(message, "SecurityError");
  }
}

function validateNavigationPreload(value) {
  const state = requireObject(value, "registration.navigation_preload");
  if (typeof state.enabled !== "boolean") throw invalid("navigation preload enabled state is invalid", "SecurityError");
  const headerValue = requireString(state.header_value, "navigation preload header value", { min: 0, max: 1024 });
  if (!/^[\t\x20-\x7e\x80-\xff]*$/u.test(headerValue)) throw invalid("navigation preload header value is invalid", "SecurityError");
  return state;
}

export function validateRegistration(value, targetOrigin) {
  const registration = requireObject(value, "registration");
  requireString(registration.registration_id, "registration.registration_id", { max: 256 });
  const scope = sameOriginURL(registration.scope_url, targetOrigin, "registration.scope_url");
  if (scope.search) throw invalid("registration scope must not contain a query", "SecurityError");
  if (!scope.pathname.endsWith("/") && registration.scope_url.endsWith("/"))
    throw invalid("invalid registration scope", "SecurityError");
  sameOriginURL(registration.script_url, targetOrigin, "registration.script_url");
  if (!["classic", "module"].includes(registration.type))
    throw invalid("invalid service worker type", "TypeError");
  if (!["all", "imports", "none"].includes(registration.update_via_cache))
    throw invalid("invalid updateViaCache", "TypeError");
  validateNavigationPreload(registration.navigation_preload);
  validateRegistrationPointers(registration, registrationVersionIDs(registration,targetOrigin));
  return registration;
}

function validateGraphResources(resources,label){
  if(!Array.isArray(resources)||resources.length===0)throw invalid(`${label} are invalid`,"SecurityError");
  const identities=new Set();
  for(const resource of resources){
    const entry=requireObject(resource,`${label} resource`);
    const url=requireString(entry.url,`${label} resource url`,{max:16384}),hash=requireString(entry.hash,`${label} resource hash`,{max:256}),identity=`${url}\0${hash}`;
    if(identities.has(identity))throw invalid(`duplicate ${label} resource`,"SecurityError");
    identities.add(identity);
  }
}

export function validateVersion(value,targetOrigin) {
  const version = requireObject(value, "worker version");
  requireString(version.worker_version, "worker_version", { max: 256 });
  sameOriginURL(version.script_url,targetOrigin,"version.script_url");
  if (!WORKER_STATES.includes(version.state)) throw invalid("worker state is invalid", "SecurityError");
  const graph = requireObject(version.graph, "worker graph");
  requireString(graph.graph_hash, "graph_hash", { max: 256 });
  requireString(graph.update_hash, "update_hash", { max: 256 });
  if (graph.graph_hash.trim().length === 0 || graph.update_hash.trim().length === 0) throw invalid("graph hash is invalid", "SecurityError");
  validateGraphResources(graph.resources,"graph resources");
  validateGraphResources(graph.update_resources,"graph update resources");
  requireInteger(version.created_at, "version.created_at", { min: 0 });
  requireInteger(version.state_revision, "version.state_revision", { min: 1 });
  return version;
}

export function validateClient(value, targetOrigin) {
  const client = requireObject(value, "client");
  requireString(client.client_id, "client.client_id", { max: 256 });
  sameOriginURL(client.url, targetOrigin, "client.url");
  if (!["window", "worker"].includes(client.type)) throw invalid("client type is invalid", "TypeError");
  requireInteger(client.controller_revision, "client.controller_revision", { min: 0 });
  if (client.controller !== null) {
    const controller = requireObject(client.controller, "client controller");
    requireString(controller.registration_id, "controller.registration_id", { max: 256 });
    requireString(controller.worker_version, "controller.worker_version", { max: 256 });
    requireInteger(controller.revision, "controller.revision", { min: 1 });
    if (controller.revision !== client.controller_revision) throw invalid("client controller revision mismatch", "SecurityError");
  }
  return client;
}

export function newRegistration({ registration_id, scope_url, script_url, type, update_via_cache, now }) {
  return {
    active_version: null,
    installing_version: null,
    last_update_check: now,
    navigation_preload: { enabled: false, header_value: "true" },
    registration_id,
    scope_url,
    script_url,
    type,
    unregistered: false,
    update_via_cache,
    versions: [],
    waiting_version: null,
  };
}

export function newVersion({ worker_version, graph, script_url, now }) {
  return {
    created_at: now,
    graph: clone(graph),
    script_url,
    skip_waiting_requested: false,
    state_revision: 1,
    state: "INSTALLING",
    worker_version,
  };
}

export function versionFor(registration, workerVersion) {
  return registration.versions.find((version) => version.worker_version === workerVersion) ?? null;
}

export function registrationFor(state, registrationID) {
  return state.registrations.find((registration) => registration.registration_id === registrationID) ?? null;
}

export function clientFor(state, clientID) {
  return state.clients.find((client) => client.client_id === clientID) ?? null;
}

export function matchesScope(registration, targetURL) {
  const scope = new URL(registration.scope_url);
  const target = new URL(targetURL);
  return target.origin === scope.origin && target.pathname.startsWith(scope.pathname);
}

export function resolveRegistration(state, targetURL) {
  const target = new URL(targetURL);
  let match = null;
  for (const registration of state.registrations) {
    if (registration.unregistered || !matchesScope(registration, target)) continue;
    if (!match || new URL(registration.scope_url).pathname.length > new URL(match.scope_url).pathname.length) match = registration;
  }
  return match;
}

export function controlledClientCount(state, registrationID, workerVersion) {
  return state.clients.filter((client) => client.controller?.registration_id === registrationID && client.controller?.worker_version === workerVersion).length;
}

export function assertStateTransition(version, next) {
  const expected = {
    INSTALLING: ["INSTALLED_WAITING", "REDUNDANT"],
    INSTALLED_WAITING: ["ACTIVATING", "REDUNDANT"],
    ACTIVATING: ["ACTIVE", "REDUNDANT"],
    ACTIVE: ["REDUNDANT"],
    REDUNDANT: [],
  };
  if (!expected[version.state].includes(next)) throw invalid(`invalid state transition ${version.state} -> ${next}`);
  version.state_revision += 1;
  version.state = next;
}
