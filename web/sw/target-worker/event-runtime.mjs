import { deferred, invalid, requireFunction, requireInteger, requireObject, requireString } from "./validation.mjs";

const RESPONSE_CHUNK_LIMIT = 64 << 10;

function protocol(event, type, fields = {}) {
  return Object.freeze({
    v: 1,
    type,
    event_id: event.event_id,
    registration_id: event.registration_id,
    worker_version: event.worker_version,
    ...fields,
  });
}

function responsePlan(response) {
  return {
    body_present: response.body !== null,
    status: response.status,
    status_text: response.statusText,
    headers: [...response.headers].map(([name, value]) => [name, value]),
  };
}

function requiredEventStart(value) {
  const event = requireObject(value, "event");
  if(event.v!==1)throw invalid("unsupported event protocol version","SecurityError");
  const dispatchDeadline=requireInteger(event.dispatch_deadline,"event.dispatch_deadline",{min:0}),lifetimeDeadline=requireInteger(event.lifetime_deadline,"event.lifetime_deadline",{min:0});
  if(dispatchDeadline>lifetimeDeadline)throw invalid("event deadlines are invalid","SecurityError");
  return {
    v:1,
    event_id: requireString(event.event_id, "event.event_id", { max: 256 }),
    registration_id: requireString(event.registration_id, "event.registration_id", { max: 256 }),
    worker_version: requireString(event.worker_version, "event.worker_version", { max: 256 }),
    event_type: requireString(event.event_type, "event.event_type", { max: 64 }),
    dispatch_deadline:dispatchDeadline,
    lifetime_deadline:lifetimeDeadline,
    ...(event.client_id===undefined?{}:{client_id:requireString(event.client_id,"event.client_id",{max:256})}),
    ...(event.resulting_client_id===undefined?{}:{resulting_client_id:requireString(event.resulting_client_id,"event.resulting_client_id",{max:256})}),
    ...(event.request_plan===undefined?{}:{request_plan:requireObject(event.request_plan,"event.request_plan")}),
    ...(event.preload_handle===undefined?{}:{preload_handle:requireString(event.preload_handle,"event.preload_handle",{max:256})}),
  };
}

export class VirtualEventDispatcher {
  #send;
  #preloadResponse = null;
  #queueMicrotask;
  #responseCredit;

  constructor({ send, queueMicrotask: enqueue = queueMicrotask, preloadResponse = null, responseCredit = null } = {}) {
    this.#send = requireFunction(send, "send");
    this.#queueMicrotask = requireFunction(enqueue, "queueMicrotask");
    if (preloadResponse !== null) this.#preloadResponse = requireFunction(preloadResponse, "preloadResponse");
    if (responseCredit !== null) this.#responseCredit = requireFunction(responseCredit, "responseCredit");
  }

  dispatch(eventStart, listeners = []) {
    const event = requiredEventStart(eventStart);
    if (!Array.isArray(listeners) || listeners.some((listener) => typeof listener !== "function")) {
      throw invalid("listeners must be functions", "TypeError");
    }
    const state = {
      ...event,
      claimed: false,
      dispatch_open: true,
      dispatch_closed: false,
      failed: null,
      final_wait_seq: 0,
      lifetime_closed: false,
      lifetime_failure: null,
      pending: 0,
      response_finished: false,
      settling: new Set(),
    };
    const lifetime = deferred();
    const readPreload = this.#preloadResponse;
    let preloadPromise = null;
    const emit = (type, fields) => {
      const message = protocol(state, type, fields);
      try {
        const sent = this.#send(message);
        Promise.resolve(sent).catch((error) => {
          if (!state.failed) state.failed = error instanceof Error ? error : new Error("event transport failed");
        });
      } catch (error) {
        if (!state.failed) state.failed = error instanceof Error ? error : new Error("event transport failed");
      }
    };
    const fail = (phase, code) => {
      if (state.failed) return;
      state.failed = invalid(code, "OperationError");
      emit("EVENT_FAIL", { phase, code });
    };
    const closeLifetime = () => {
      if (state.lifetime_closed || state.pending !== 0) return;
      this.#queueMicrotask(() => {
        if (state.lifetime_closed || state.pending !== 0) return;
        state.lifetime_closed = true;
        const failure=state.lifetime_failure??state.failed,outcome = failure ? "rejected" : "fulfilled";
        emit("LIFETIME_CLOSED", { final_wait_seq: state.final_wait_seq, outcome });
        if (failure) lifetime.reject(failure);
        else lifetime.resolve({ final_wait_seq: state.final_wait_seq, outcome });
      });
    };
    const settleWait = (record, outcome) => {
      if (record.settled) return;
      record.settled = true;
      state.settling.delete(record);
      state.pending -= 1;
      if (outcome === "rejected"&&!state.lifetime_failure)state.lifetime_failure=invalid("WAIT_UNTIL_REJECTED","OperationError");
      emit("WAIT_UNTIL_SETTLED", {
        wait_seq: record.wait_seq,
        promise_id: record.promise_id,
        outcome,
        pending_count: state.pending,
      });
      if (state.dispatch_closed && state.pending === 0) closeLifetime();
    };
    const facade = Object.freeze({
      get type() { return state.event_type; },
      get clientId() { return state.client_id??""; },
      get resultingClientId() { return state.resulting_client_id??""; },
      get requestPlan() { return state.request_plan; },
      get preloadHandle() { return state.preload_handle; },
      get preloadResponse() {
        if (preloadPromise === null) {
          if (state.preload_handle === undefined) preloadPromise = Promise.resolve(undefined);
          else if (readPreload === null) preloadPromise = Promise.reject(invalid("navigation preload is unavailable", "InvalidStateError"));
          else preloadPromise = Promise.resolve().then(() => readPreload({
            event_id: state.event_id,
            preload_handle: state.preload_handle,
          }));
        }
        return preloadPromise;
      },
      respondWith: (value) => {
        if (!state.dispatch_open || state.claimed) throw invalid("respondWith may only be called once during dispatch");
        state.claimed = true;
        emit("RESPOND_WITH_CLAIMED");
        void this.#sendResponse(state, value, emit, fail);
      },
      waitUntil: (value, promiseID = undefined) => {
        if (!state.dispatch_open && (state.lifetime_closed || state.pending === 0)) {
          throw invalid("waitUntil is no longer active");
        }
        if (state.lifetime_closed) throw invalid("waitUntil is no longer active");
        const wait_seq = ++state.final_wait_seq;
        const promise_id = promiseID === undefined
          ? `${state.event_id}:wait:${wait_seq}`
          : requireString(promiseID, "promiseID", { max: 256 });
        const record = { promise_id, settled: false, wait_seq };
        state.pending += 1;
        state.settling.add(record);
        emit("WAIT_UNTIL_ADD", { wait_seq, promise_id, pending_count: state.pending });
        Promise.resolve(value).then(
          () => settleWait(record, "fulfilled"),
          () => settleWait(record, "rejected"),
        );
      },
    });
    for (const listener of listeners) {
      try {
        listener(facade);
      } catch (error) {
        fail("dispatch", "LISTENER_THROW");
      }
    }
    state.dispatch_open = false;
    state.dispatch_closed = true;
    if (!state.claimed) emit("NO_RESPONSE");
    emit("DISPATCH_CLOSED", { max_wait_seq: state.final_wait_seq, pending_count: state.pending });
    if (state.pending === 0) closeLifetime();
    return Object.freeze({
      claimed: state.claimed,
      event: facade,
      lifetime: lifetime.promise,
    });
  }

  async #sendResponse(state, value, emit, fail) {
    let response;
    try {
      response = await value;
    } catch {
      fail("response", "RESPOND_WITH_REJECTED");
      return;
    }
    if (!(response instanceof Response)) {
      fail("response", "RESPOND_WITH_NON_RESPONSE");
      return;
    }
    await this.#streamResponse(state,response,emit,fail);
  }

  async #streamResponse(state,response,emit,fail) {
    emit("RESPONSE_HEADERS", { response_plan: responsePlan(response) });
    if (!response.body) {
      emit("RESPONSE_END", { sequence: 0 });
      state.response_finished = true;
      return;
    }
    const reader = response.body.getReader();
    let sequence = 0;
    try {
      while (true) {
        if (this.#responseCredit) await this.#responseCredit({ event_id: state.event_id, sequence });
        const read = await reader.read();
        if (read.done) break;
        const bytes = read.value instanceof Uint8Array ? read.value : new Uint8Array(read.value);
        if (bytes.byteLength > RESPONSE_CHUNK_LIMIT) throw invalid("response chunk exceeds limit", "QuotaExceededError");
        emit("RESPONSE_CHUNK", { sequence, bytes });
        sequence += 1;
      }
      emit("RESPONSE_END", { sequence });
      state.response_finished = true;
    } catch {
      try { await reader.cancel(); } catch {}
      fail("stream", "RESPONSE_STREAM_FAILED");
    }
  }
}

export function dispatchVirtualEvent(configuration, eventStart, listeners) {
  return new VirtualEventDispatcher(configuration).dispatch(eventStart, listeners);
}

export function validateWaitMessage(message) {
  const value = requireObject(message, "message");
  requireInteger(value.wait_seq, "wait_seq", { min: 1 });
  requireString(value.promise_id, "promise_id", { max: 256 });
  requireInteger(value.pending_count, "pending_count", { min: 0 });
  return value;
}
