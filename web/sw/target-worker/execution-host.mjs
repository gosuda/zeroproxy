import {
  byteLength,
  clone,
  deferred,
  equalBinding,
  invalid,
  normalizeBinding,
  requireFunction,
  requireInteger,
  requireObject,
  requireString,
  structuredByteLength,
  transferables,
} from "./validation.mjs";

const FORWARDED_PROTOCOL = new Set([
  "WORKER_READY",
  "RESPOND_WITH_CLAIMED",
  "NO_RESPONSE",
  "RESPONSE_HEADERS",
  "RESPONSE_CHUNK",
  "RESPONSE_END",
  "WAIT_UNTIL_ADD",
  "WAIT_UNTIL_SETTLED",
  "DISPATCH_CLOSED",
  "LIFETIME_CLOSED",
  "EVENT_FAIL",
]);
const OUTBOUND_PROTOCOL = new Set([
  "EVENT_START",
  "EVENT_COMPLETE",
  "EVENT_FAIL",
  "STREAM_PULL",
  "STREAM_CANCEL",
]);
const CLIENT_COMMANDS = new Set([
  "CLIENT_FOCUS",
  "CLIENT_NAVIGATE",
  "CLIENT_OPEN_WINDOW",
  "CLIENT_POST_MESSAGE",
  "CONTROLLER_CHANGE",
]);
const ROOT_LIFECYCLE_EVENTS = new Set(["install", "activate", "message"]);

function versionBinding(binding, registrationID, workerVersion) {
  return Object.freeze({ ...binding, registration_id: registrationID, worker_version: workerVersion });
}

function defaultSessionID() {
  if (typeof globalThis.crypto?.randomUUID !== "function") throw invalid("secure session identifier is unavailable", "SecurityError");
  return globalThis.crypto.randomUUID();
}

function portAdapter(value) {
  const port = requireObject(value, "private capability port");
  const postMessage = requireFunction(port.postMessage, "private capability port.postMessage").bind(port);
  const addEventListener = requireFunction(port.addEventListener, "private capability port.addEventListener").bind(port);
  const start = typeof port.start === "function" ? port.start.bind(port) : null;
  const close = typeof port.close === "function" ? port.close.bind(port) : null;
  return Object.freeze({ addEventListener, close, postMessage, start });
}

function protocolBinding(message) {
  const envelope = requireObject(message, "protocol message");
  const binding = requireObject(envelope.binding, "protocol binding");
  const registrationID = requireString(envelope.registration_id ?? binding.registration_id, "registration_id", { max: 256 });
  const workerVersion = requireString(envelope.worker_version ?? binding.worker_version, "worker_version", { max: 256 });
  return { binding, registration_id: registrationID, worker_version: workerVersion };
}

function replyError(error) {
  return error instanceof DOMException ? error.name : "SecurityError";
}

function transferableResponseRecord(value) {
  if (!(value instanceof Response)) throw invalid("navigation preload did not return Response", "NetworkError");
  return {
    body: value.body,
    headers: [...value.headers],
    status: value.status,
    status_text: value.statusText,
  };
}

export class TargetWorkerExecutionHost {
  #binding;
  #broker = null;
  #capabilities;
  #compiler;
  #completedCommands = new Map();
  #id;
  #hostPings = new Map();
  #journal;
  #limits;
  #pingSequence = 0;
  #pendingCommands = new Map();
  #port;
  #sessions = new Map();
  #timer;

  constructor({
    binding,
    capabilities = null,
    compiler,
    journal,
    limits = {},
    privatePort,
    sessionID = defaultSessionID,
    timer = globalThis,
  } = {}) {
    this.#binding = normalizeBinding(binding);
    if (capabilities !== null) {
      const port = requireObject(capabilities, "capabilities");
      this.#capabilities = Object.freeze({ dispatch: requireFunction(port.dispatch, "capabilities.dispatch").bind(port) });
    } else {
      this.#capabilities = null;
    }
    const compilerPort = requireObject(compiler, "compiler");
    this.#compiler = Object.freeze({ rewriteGraph: requireFunction(compilerPort.rewriteGraph, "compiler.rewriteGraph").bind(compilerPort) });
    const journalPort = requireObject(journal, "journal");
    this.#journal = Object.freeze({ hydrateVersion: requireFunction(journalPort.hydrateVersion, "journal.hydrateVersion").bind(journalPort) });
    this.#port = portAdapter(privatePort);
    this.#id = requireFunction(sessionID, "sessionID");
    const timerPort = requireObject(timer, "timer");
    this.#timer = Object.freeze({
      clearTimeout: requireFunction(timerPort.clearTimeout, "timer.clearTimeout").bind(timerPort),
      setTimeout: requireFunction(timerPort.setTimeout, "timer.setTimeout").bind(timerPort),
    });
    const limitObject = requireObject(limits, "limits");
    this.#limits = Object.freeze({
      command_timeout_ms: requireInteger(limitObject.command_timeout_ms ?? 10_000, "limits.command_timeout_ms", { min: 1, max: 1 << 30 }),
      host_ping_timeout_ms: requireInteger(limitObject.host_ping_timeout_ms ?? 2_000, "limits.host_ping_timeout_ms", { min: 1, max: 1 << 30 }),
      max_command_bytes: requireInteger(limitObject.max_command_bytes ?? (256 << 10), "limits.max_command_bytes", { min: 1, max: 1 << 30 }),
      max_pending_commands: requireInteger(limitObject.max_pending_commands ?? 128, "limits.max_pending_commands", { min: 1, max: 65_536 }),
      max_sessions: requireInteger(limitObject.max_sessions ?? 64, "limits.max_sessions", { min: 1, max: 65_536 }),
    });
    this.#port.addEventListener("message", (event) => { void this.#onMessage(event?.data).catch((error) => this.#rejectPortMessage(event?.data, error)); });
    this.#port.start?.();
  }

  get binding() { return this.#binding; }

  get clientCommands() {
    return Object.freeze({ command: (message, transfer = []) => this.#command(message, transfer) });
  }

  get host() {
    return Object.freeze({
      hydrate: (message) => this.#hydrate(message),
      send: (message, transfer = []) => this.#send(message, transfer),
      terminate: (message) => this.#terminate(message),
    });
  }

  ping() {
    const messageID = `host-ping:${++this.#pingSequence}`;
    const reply = deferred();
    const timer = this.#timer.setTimeout(() => {
      const pending = this.#hostPings.get(messageID);
      if (!pending) return;
      this.#hostPings.delete(messageID);
      pending.reply.reject(invalid("execution host heartbeat timed out", "TimeoutError"));
    }, this.#limits.host_ping_timeout_ms);
    this.#hostPings.set(messageID, { reply, timer });
    try {
      this.#post(Object.freeze({
        v: 1,
        type: "HOST_RUNTIME_PING",
        message_id: messageID,
        binding: this.#binding,
      }));
    } catch (error) {
      this.#timer.clearTimeout(timer);
      this.#hostPings.delete(messageID);
      reply.reject(error);
    }
    return reply.promise;
  }

  attachBroker(broker) {
    const value = requireObject(broker, "broker");
    requireFunction(value.receiveWorkerMessage, "broker.receiveWorkerMessage");
    if (this.#broker !== null && this.#broker !== value) throw invalid("execution host is already attached", "InvalidStateError");
    this.#broker = value;
    return this;
  }

  async dispatchRootEvent(input) {
    const value = requireObject(input, "root event input");
    const eventType = requireString(value.event_type, "event_type", { max: 32 });
    const broker = this.#requireBroker();
    if (eventType === "fetch") {
      const nativeEvent = requireObject(value.native_event, "native fetch event");
      return broker.admitNativeFetch(nativeEvent, value.dispatch);
    }
    if (!ROOT_LIFECYCLE_EVENTS.has(eventType)) throw invalid("unsupported root event", "NotSupportedError");
    const nativeEvent = value.native_event;
    const dispatch = requireObject(value.dispatch, "lifecycle dispatch");
    const lifetime = broker.dispatchLifecycle({ ...dispatch, event_type: eventType });
    if (nativeEvent !== undefined) requireFunction(requireObject(nativeEvent, "native lifecycle event").waitUntil, "nativeEvent.waitUntil").call(nativeEvent, lifetime);
    return lifetime;
  }

  close() {
    try { this.#broker?.close?.(); } catch {}
    for (const entry of this.#pendingCommands.values()) {
      this.#timer.clearTimeout(entry.timer);
      entry.reply.reject(invalid("execution host closed", "AbortError"));
    }
    for (const entry of this.#hostPings.values()) {
      this.#timer.clearTimeout(entry.timer);
      entry.reply.reject(invalid("execution host closed", "AbortError"));
    }
    this.#hostPings.clear();
    this.#pendingCommands.clear();
    this.#sessions.clear();
    this.#port.close?.();
  }

  async #hydrate(message) {
    const envelope = requireObject(message, "hydrate message");
    if(envelope.v!==1)throw invalid("unsupported hydrate protocol version","SecurityError");
    if (envelope.type !== "HYDRATE_WORKER") throw invalid("invalid host hydrate message", "SecurityError");
    const { binding, registration_id: registrationID, worker_version: workerVersion } = protocolBinding(envelope);
    const expected = versionBinding(this.#binding, registrationID, workerVersion);
    if (!equalBinding(binding, expected, { requireRegistration: true, requireVersion: true })) throw invalid("host hydrate binding mismatch", "SecurityError");
    const graph = requireObject(envelope.graph, "worker graph");
    const graphHash = requireString(graph.graph_hash, "graph.graph_hash", { max: 256 });
    const hydrated = requireObject(await this.#journal.hydrateVersion(Object.freeze({
      v: 1,
      type: "TARGET_WORKER_HYDRATE_VERSION",
      binding: expected,
      graph_hash: graphHash,
    })), "journal hydration reply");
    if (!equalBinding(hydrated.binding, expected, { requireRegistration: true, requireVersion: true }) || hydrated.graph_hash !== graphHash) {
      throw invalid("journal hydration version mismatch", "SecurityError");
    }
    const rewritten = requireObject(await this.#compiler.rewriteGraph(Object.freeze({
      v: 1,
      type: "TARGET_SERVICE_WORKER_REWRITE",
      binding: expected,
      graph: clone(graph),
    })), "compiler rewrite reply");
    if (rewritten.graph_hash !== graphHash) throw invalid("compiler graph hash mismatch", "SecurityError");
    if (byteLength(rewritten) > this.#limits.max_command_bytes) throw invalid("rewritten graph exceeds host limit", "QuotaExceededError");
    if (this.#sessions.size >= this.#limits.max_sessions) throw invalid("execution session limit exceeded", "QuotaExceededError");
    const sessionID = requireString(this.#id(), "session identifier", { max: 256 });
    if (this.#sessions.has(sessionID)) throw invalid("duplicate execution session identifier", "SecurityError");
    const session = Object.freeze({ binding: expected, graph_hash: graphHash, session_id: sessionID });
    this.#sessions.set(sessionID, session);
    try {
      this.#post(Object.freeze({
        v: 1,
        type: "HYDRATE_WORKER",
        message_id: `hydrate:${sessionID}`,
        binding: expected,
        session_id: sessionID,
        graph: rewritten,
      }));
    } catch (error) {
      this.#sessions.delete(sessionID);
      throw error;
    }
    return Object.freeze({ binding: expected, graph_hash: graphHash, session_id: sessionID });
  }

  async #send(message, transfer = []) {
    const envelope = requireObject(message, "host message");
    if(envelope.v!==1)throw invalid("unsupported host protocol version","SecurityError");
    const type = requireString(envelope.type, "host message type", { max: 64 });
    if (!OUTBOUND_PROTOCOL.has(type)) throw invalid("unsupported host protocol message", "SecurityError");
    const { binding, registration_id: registrationID, worker_version: workerVersion } = protocolBinding(envelope);
    const expected = versionBinding(this.#binding, registrationID, workerVersion);
    if (!equalBinding(binding, expected, { requireRegistration: true, requireVersion: true })) throw invalid("host protocol binding mismatch", "SecurityError");
    const sessionID = requireString(envelope.session_id, "session_id", { max: 256 });
    const session = this.#sessions.get(sessionID);
    if (!session || !equalBinding(session.binding, expected, { requireRegistration: true, requireVersion: true })) throw invalid("stale execution session", "SecurityError");
    const payload = { ...envelope, message_id: envelope.message_id ?? `host:${sessionID}:${type}:${envelope.event_id ?? ""}` };
    if (byteLength(payload) > this.#limits.max_command_bytes) throw invalid("host message exceeds limit", "QuotaExceededError");
    this.#post(Object.freeze(payload), transfer);
  }

  async #terminate(message) {
    const envelope = requireObject(message, "terminate message");
    if(envelope.v!==1)throw invalid("unsupported terminate protocol version","SecurityError");
    if (envelope.type !== "TERMINATE_WORKER") throw invalid("invalid terminate message", "SecurityError");
    const { binding, registration_id: registrationID, worker_version: workerVersion } = protocolBinding(envelope);
    const expected = versionBinding(this.#binding, registrationID, workerVersion);
    const sessionID = requireString(envelope.session_id, "session_id", { max: 256 });
    const session = this.#sessions.get(sessionID);
    if (!session || !equalBinding(binding, expected, { requireRegistration: true, requireVersion: true }) || !equalBinding(session.binding, expected, { requireRegistration: true, requireVersion: true })) {
      throw invalid("stale execution session", "SecurityError");
    }
    this.#sessions.delete(sessionID);
    this.#post(Object.freeze({ v: 1, type: "TERMINATE_WORKER", message_id: `terminate:${sessionID}`, binding: expected, session_id: sessionID }));
  }

  async #command(message, rawTransfer = []) {
    const envelope = requireObject(message, "client command");
    if(envelope.v!==1)throw invalid("unsupported client command protocol version","SecurityError");
    const type = requireString(envelope.type, "client command type", { max: 64 });
    if (!CLIENT_COMMANDS.has(type)) throw invalid("unsupported client command", "SecurityError");
    if (!equalBinding(envelope.binding, this.#binding)) throw invalid("client command binding mismatch", "SecurityError");
    if (envelope.capability !== this.#binding.capability) throw invalid("client command capability mismatch", "SecurityError");
    const messageID = requireString(envelope.message_id, "client command message_id", { max: 256 });
    const complete = this.#completedCommands.get(messageID);
    if (complete !== undefined) return clone(complete);
    const pending = this.#pendingCommands.get(messageID);
    if (pending) return pending.reply.promise;
    const transfer = transferables(rawTransfer, "client command transfer list");
    if (this.#pendingCommands.size >= this.#limits.max_pending_commands || structuredByteLength(envelope, this.#limits.max_command_bytes) > this.#limits.max_command_bytes) {
      throw invalid("client command limit exceeded", "QuotaExceededError");
    }
    const reply = deferred();
    const timer = this.#timer.setTimeout(() => {
      const entry = this.#pendingCommands.get(messageID);
      if (!entry) return;
      this.#pendingCommands.delete(messageID);
      entry.reply.reject(invalid("client command timeout", "TimeoutError"));
    }, this.#limits.command_timeout_ms);
    this.#pendingCommands.set(messageID, { binding: envelope.binding, reply, timer });
    try {
      this.#post(Object.freeze({ ...envelope, v: 1, type: "CLIENT_COMMAND", command: type }), transfer);
    } catch (error) {
      this.#timer.clearTimeout(timer);
      this.#pendingCommands.delete(messageID);
      reply.reject(error);
    }
    return reply.promise;
  }
  #hostCapability(expected,command,messageID,payload){
    if(!this.#capabilities)throw invalid("host command capability is unavailable","NotSupportedError");
    return this.#capabilities.dispatch(Object.freeze({
      binding:expected,
      command,
      message_id:messageID,
      payload:clone(payload),
    }));
  }
  #skipWaiting(broker,expected,messageID,payload,registrationID,workerVersion){
    if(this.#capabilities)return this.#hostCapability(expected,"REGISTRATION_SKIP_WAITING",messageID,payload);
    return broker.skipWaiting({operation_id:messageID,registration_id:registrationID,worker_version:workerVersion});
  }
  async #navigationPreloadCommand(broker,registrationID,messageID,command,payload){
    if(command==="NAVIGATION_PRELOAD_GET_STATE")return {state:await broker.getNavigationPreloadState(registrationID)};
    if(command==="NAVIGATION_PRELOAD_ENABLE")return {state:await broker.configureNavigationPreload({operation_id:messageID,registration_id:registrationID,enabled:true})};
    if(command==="NAVIGATION_PRELOAD_DISABLE")return {state:await broker.configureNavigationPreload({operation_id:messageID,registration_id:registrationID,enabled:false})};
    if(command==="NAVIGATION_PRELOAD_SET_HEADER")return {state:await broker.configureNavigationPreload({operation_id:messageID,registration_id:registrationID,header_value:requireString(payload.value,"navigation preload header value",{min:0,max:1024})})};
    throw invalid("navigation preload command is unsupported","NotSupportedError");
  }
  async #executeHostCommand(broker,expected,registrationID,workerVersion,messageID,command,payload){
    const transfer=[];
    let result;
    if(command==="NAVIGATION_PRELOAD"){
      const response=transferableResponseRecord(await broker.consumePreload({
        event_id:requireString(payload.event_id,"event_id",{max:256}),
        preload_handle:requireString(payload.preload_handle,"preload_handle",{max:256}),
        registration_id:registrationID,
        worker_version:workerVersion,
      }));
      result={response};
      if(response.body!==null)transfer.push(response.body);
    }else if(command==="CLIENTS_CLAIM"){
      result=await broker.claim({operation_id:messageID,registration_id:registrationID,worker_version:workerVersion});
    }else if(command==="CLIENTS_MATCH_ALL"){
      const options=requireObject(payload.options??{},"client match options");
      result={clients:await broker.matchAll({
        include_uncontrolled:options.includeUncontrolled===true,
        type:options.type??"all",
        registration_id:registrationID,
        worker_version:workerVersion,
      })};
    }else if(command==="CLIENTS_GET"){
      result={client:await broker.getClient({client_id:requireString(payload.client_id,"client_id",{max:256})})};
    }else if(command==="CLIENT_FOCUS"){
      result=await broker.focus({operation_id:messageID,client_id:requireString(payload.client_id,"client_id",{max:256})});
    }else if(command==="CLIENT_NAVIGATE"){
      result=await broker.navigate({operation_id:messageID,client_id:requireString(payload.client_id,"client_id",{max:256}),url:requireString(payload.url,"url",{max:16_384})});
    }else if(command==="CLIENT_OPEN_WINDOW"){
      result=await broker.openWindow({operation_id:messageID,client_id:requireString(payload.client_id,"client_id",{max:256}),url:requireString(payload.url,"url",{max:16_384})});
    }else if(command==="CLIENT_POST_MESSAGE"){
      const messageTransfer=transferables(payload.transfer,"client message transfer list");
      result=await broker.postMessage({operation_id:messageID,client_id:requireString(payload.client_id,"client_id",{max:256}),message:payload.message,transfer:messageTransfer});
    }else if(command.startsWith("NAVIGATION_PRELOAD_")){
      result=await this.#navigationPreloadCommand(broker,registrationID,messageID,command,payload);
    }else if(command==="REGISTRATION_SKIP_WAITING"){
      result=await this.#skipWaiting(broker,expected,messageID,payload,registrationID,workerVersion);
    }else{
      result=await this.#hostCapability(expected,command,messageID,payload);
    }
    return {result,transfer};
  }
  async #hostCommand(message) {
    const { binding, registration_id: registrationID, worker_version: workerVersion } = protocolBinding(message);
    const expected = versionBinding(this.#binding, registrationID, workerVersion);
    const sessionID = requireString(message.session_id, "session_id", { max: 256 });
    const session = this.#sessions.get(sessionID);
    const messageID = requireString(message.message_id, "host command message_id", { max: 256 });
    if (!session || !equalBinding(binding, expected, { requireRegistration: true, requireVersion: true }) || !equalBinding(session.binding, expected, { requireRegistration: true, requireVersion: true })) {
      throw invalid("host command capability binding mismatch", "SecurityError");
    }
    if (structuredByteLength(message, this.#limits.max_command_bytes) > this.#limits.max_command_bytes) throw invalid("host command exceeds limit", "QuotaExceededError");
    const command = requireString(message.command, "host command", { max: 64 });
    const payload = requireObject(message.payload, "host command payload");
    const broker = this.#requireBroker();
    const {result,transfer}=await this.#executeHostCommand(broker,expected,registrationID,workerVersion,messageID,command,payload);
    this.#post(Object.freeze({
      v: 1,
      type: "HOST_COMMAND_RESULT",
      binding: expected,
      session_id: sessionID,
      reply_to: messageID,
      ok: true,
      result: transfer.length === 0 ? clone(result ?? {}) : result,
    }), transfer);
  }


  async #onMessage(payload) {
    const message = requireObject(payload, "private port message");
    if(message.v!==1)throw invalid("unsupported private port protocol version","SecurityError");
    const type = requireString(message.type, "private port message type", { max: 64 });
    if (type === "HOST_RUNTIME_PONG") {
      if (!equalBinding(message.binding, this.#binding)) throw invalid("execution host heartbeat binding mismatch", "SecurityError");
      const replyTo = requireString(message.reply_to, "execution host heartbeat reply", { max: 256 });
      const pending = this.#hostPings.get(replyTo);
      if (!pending) throw invalid("unknown execution host heartbeat", "SecurityError");
      this.#timer.clearTimeout(pending.timer);
      this.#hostPings.delete(replyTo);
      pending.reply.resolve(Object.freeze({ binding: this.#binding }));
      return;
    }
    if (type === "CLIENT_COMMAND_RESULT") {
      this.#onClientResult(message);
      return;
    }
    if (type === "HOST_COMMAND") {
      try {
        await this.#hostCommand(message);
      } catch (error) {
        const { binding, registration_id: registrationID, worker_version: workerVersion } = protocolBinding(message);
        this.#post(Object.freeze({
          v: 1,
          type: "HOST_COMMAND_RESULT",
          binding: versionBinding(this.#binding, registrationID, workerVersion),
          session_id: requireString(message.session_id, "session_id", { max: 256 }),
          reply_to: requireString(message.message_id, "host command message_id", { max: 256 }),
          ok: false,
          code: replyError(error),
          result: {},
        }));
      }
      return;
    }
    if (!FORWARDED_PROTOCOL.has(type)) throw invalid("private port protocol message is unsupported", "SecurityError");
    const { binding, registration_id: registrationID, worker_version: workerVersion } = protocolBinding(message);
    const expected = versionBinding(this.#binding, registrationID, workerVersion);
    const sessionID = requireString(message.session_id, "session_id", { max: 256 });
    const session = this.#sessions.get(sessionID);
    if (!session || !equalBinding(binding, expected, { requireRegistration: true, requireVersion: true }) || !equalBinding(session.binding, expected, { requireRegistration: true, requireVersion: true })) {
      throw invalid("private port capability binding mismatch", "SecurityError");
    }
    if (byteLength(message) > this.#limits.max_command_bytes) throw invalid("private port message exceeds limit", "QuotaExceededError");
    await this.#requireBroker().receiveWorkerMessage(message);
  }

  #onClientResult(message) {
    if (!equalBinding(message.binding, this.#binding)) throw invalid("client command result binding mismatch", "SecurityError");
    const messageID = requireString(message.reply_to, "client command reply_to", { max: 256 });
    const entry = this.#pendingCommands.get(messageID);
    if (!entry) throw invalid("unknown client command reply", "SecurityError");
    const scoped = entry.binding.registration_id !== undefined || entry.binding.worker_version !== undefined;
    if (!equalBinding(message.binding, entry.binding, { requireRegistration: scoped, requireVersion: scoped })) {
      this.#timer.clearTimeout(entry.timer);
      this.#pendingCommands.delete(messageID);
      const error = invalid("client command result binding mismatch", "SecurityError");
      entry.reply.reject(error);
      throw error;
    }
    this.#timer.clearTimeout(entry.timer);
    this.#pendingCommands.delete(messageID);
    if (message.ok !== true) {
      entry.reply.reject(invalid(requireString(message.code ?? "CLIENT_COMMAND_REJECTED", "client command code", { max: 128 }), "InvalidStateError"));
      return;
    }
    try {
      const result = requireObject(message.result, "client command result");
      if (!equalBinding(result.binding, entry.binding, { requireRegistration: scoped, requireVersion: scoped })) throw invalid("client command response binding mismatch", "SecurityError");
      const copy = clone(result);
      this.#completedCommands.set(messageID, copy);
      if (this.#completedCommands.size > this.#limits.max_pending_commands) this.#completedCommands.delete(this.#completedCommands.keys().next().value);
      entry.reply.resolve(copy);
    } catch (error) {
      entry.reply.reject(error);
      throw error;
    }
  }

  #post(message, transfer = []) {
    if (transfer.length === 0) this.#port.postMessage(message);
    else this.#port.postMessage(message, transfer);
  }

  #rejectPortMessage(message, error) {
    try {
      const messageID = typeof message?.message_id === "string" ? message.message_id : undefined;
      this.#post(Object.freeze({ v: 1, type: "HOST_REJECT", reply_to: messageID, code: replyError(error) }));
    } catch {}
  }

  #requireBroker() {
    if (this.#broker === null) throw invalid("execution host broker is unattached", "InvalidStateError");
    return this.#broker;
  }
}

export function createTargetWorkerExecutionHost(configuration) {
  return new TargetWorkerExecutionHost(configuration);
}
