import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createBoundedRewriteCache } from "../../web/compiler-cache.mjs";
import {
  crossOriginResourcePolicyAllows,
  documentTrustedTypesPolicyName,
  generateDocumentCSP,
  responseIsolationHeaders,
  xFrameOptionsAllows,
} from "../../web/sw/document-csp.mjs";

const root = path.resolve(import.meta.dirname, "../..");

async function loadAdmissionScenario() {
  const source = (await readFile(path.join(root, "web/sw/sw.mjs"), "utf8")).replace(/^(?:import [^\n]*;\n)+/, "");
  const context = {
    POLICY_VERSION: 2,
    DOMException,
    Headers,
    ReadableStream,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    canonicalTarget: async value => ({ canonicalOrigin: new URL(value).origin, canonicalSite: new URL(value).origin }),
    clearTimeout,
    createBoundedRewriteCache,
    crypto: globalThis.crypto,
    setTimeout,
    structuredClone,
    self: {
      addEventListener() {},
      clients: { claim: async () => {}, matchAll: async () => [] },
      location: {
        hostname: "o-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.browse.example.test",
        origin: "https://o-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.browse.example.test",
      },
    },
  };
  Object.assign(context, {
    crossOriginResourcePolicyAllows,
    documentTrustedTypesPolicyName,
    generateDocumentCSP,
    responseIsolationHeaders,
    xFrameOptionsAllows,
  });
  context.globalThis = context;
  vm.runInNewContext(`${source}
    globalThis.__runAPIAdmissionScenario = async () => {
      originState = {
        capability_epoch: 7,
        destination_origin_id: "a".repeat(32),
        document_capability: "isolation-capability",
        entry_id: "e".repeat(32),
        profile_id: "p".repeat(24),
        session_id: "s".repeat(32),
        tab_id: "t".repeat(32),
        target_url: "https://top.example/",
      };
      const client = {
        capability_epoch: originState.capability_epoch,
        entry_id: originState.entry_id,
        origin_id: originState.destination_origin_id,
        profile_id: originState.profile_id,
        runtime_capability: "d".repeat(32),
        tab_id: originState.tab_id,
        target_url: "https://frame.example/app",
      };
      const bodyHandle = "b".repeat(48);
      const plan = {
        api_kind: "xhr",
        body_expected: true,
        body_handle: bodyHandle,
        capability_epoch: originState.capability_epoch,
        capability_id: "relay-capability",
        consumed: false,
        document_id: client.runtime_capability,
        entry_id: originState.entry_id,
        expires_at: Date.now() + 60_000,
        id: "plan",
        isolation_key_ref: originState.document_capability,
        kind: "api",
        method: "POST",
        request_headers: [],
        cors_request_headers: [],
        one_shot: true,
        origin_id: originState.destination_origin_id,
        persona: TRANSPORT_PERSONA,
        policy_epoch: POLICY_VERSION,
        profile_id: originState.profile_id,
        revision: 0,
        session_id: originState.session_id,
        source_client_id: "client",
        source_url: client.target_url,
        tab_id: originState.tab_id,
        xhr_native_content_type: true,
      };
      let stored = structuredClone(plan);
      let authorizedClient = client;
      const store = {
        delete(id) { if (stored?.id === id) stored = null; },
        get(id) { return stored?.id === id ? stored : null; },
        put(value) { stored = value; },
      };
      database = async () => ({ transaction: () => ({ abort() {}, objectStore: () => store }) });
      request = async value => value;
      complete = async () => {};
      primaryRelayCapability = () => ({ capability_id: "relay-capability" });
      commonRelayPorts = () => [80, 443];
      authorizeDocumentClient = async clientID => {
        if (clientID !== "client") throw new DOMException("rejected", "SecurityError");
        return authorizedClient;
      };
      const requestWith = ({ body = {}, handle = bodyHandle, method = "POST" } = {}) => ({
        body,
        headers: new Headers({
          ...(handle === null ? {} : { "X-ZP-Body-Handle": handle }),
          "Content-Type": "text/plain;charset=UTF-8",
        }),
        method,
      });
      const absent = await consumeAPIPlan("absent", "client", requestWith());
      const wrongClient = await consumeAPIPlan("plan", "wrong", requestWith());
      const wrongMethod = await consumeAPIPlan("plan", "client", requestWith({ method: "PUT" }));
      const missingBody = await consumeAPIPlan("plan", "client", requestWith({ body: null }));
      const wrongHandle = await consumeAPIPlan("plan", "client", requestWith({ handle: "c".repeat(48) }));
      authorizedClient = { ...client, runtime_capability: "x".repeat(32) };
      const wrongDocument = await consumeAPIPlan("plan", "client", requestWith());
      authorizedClient = client;
      stored.expires_at = Date.now() - 1;
      const expired = await consumeAPIPlan("plan", "client", requestWith());
      const retainedAfterFailures = stored?.id === "plan";
      stored.expires_at = Date.now() + 60_000;
      const accepted = await consumeAPIPlan("plan", "client", requestWith());
      const reused = await consumeAPIPlan("plan", "client", requestWith());
      const oneShotStored = stored?.id ?? null;
      const eventID = "v".repeat(32);
      stored = {
        ...plan,
        api_kind: "eventsource",
        attempt_budget: 1_000,
        body_expected: false,
        body_handle: "",
        cors_referrer_policy: "no-referrer",
        cors_request_headers: [],
        credentials: "include",
        credentials_mode: "include",
        expires_at: Date.now() + 60_000,
        id: eventID,
        instance_id: "a".repeat(48),
        last_event_id: "",
        live_attempt: false,
        method: "GET",
        min_attempt_interval_ms: 100,
        one_shot: false,
        original_url: "https://frame.example/events",
        referrer_policy: "no-referrer",
        request_headers: [["Accept", "text/event-stream"]],
        revision: 0,
        target_url: "https://frame.example/events",
        xhr_native_content_type: false,
        attempt_count: 0,
      };
      const eventRequest = { body: null, headers: new Headers(), method: "GET" };
      const firstEventAttempt = await consumeAPIPlan(eventID, "client", eventRequest);
      await persistTrustedEventSourceID(firstEventAttempt, "trusted-one");
      await releaseEventSourceAttempt(firstEventAttempt);
      let forgedReconnectRejected = false;
      try { await eventSourcePlanCommand("client", { id: eventID, last_event_id: "page-forged" }, false); }
      catch { forgedReconnectRejected = true; }
      await eventSourcePlanCommand("client", { id: eventID }, false);
      const rateLimitedAttempt = await consumeAPIPlan(eventID, "client", eventRequest);
      stored.last_attempt_at -= stored.min_attempt_interval_ms;
      const secondEventAttempt = await consumeAPIPlan(eventID, "client", eventRequest);
      const trustedRetryHeader = secondEventAttempt?.request_headers.find(([name]) => name.toLowerCase() === "last-event-id")?.[1] ?? null;
      return {
        accepted: accepted?.id ?? null,
        accepted_content_type: accepted?.request_headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? null,
        absent,
        expired,
        missingBody,
        retainedAfterFailures,
        reused,
        stored: oneShotStored,
        wrongClient,
        wrongDocument,
        wrongHandle,
        wrongMethod,
        event_source: {
          first_attempt: firstEventAttempt?.attempt_count ?? null,
          forged_reconnect_rejected: forgedReconnectRejected,
          rate_limited: rateLimitedAttempt === null,
          second_attempt: secondEventAttempt?.attempt_count ?? null,
          trusted_retry_header: trustedRetryHeader,
        },
      };
    };
    globalThis.__runWebSocketProtocolScenario = async () => {
      const calls = [], posts = [];
      let cancelCount = 0, portCloses = 0;
      kernelHandle = "kernel";
      applyResponseCookies = async () => {};
      self.__zeroproxyKernelWebSocketSendV2 = async (_kernel, requestID, seq, kind, data) => {
        calls.push("send:" + seq + ":" + kind + ":" + data.byteLength);
        return { v: 2, request_id: requestID, seq, acknowledged: true };
      };
      self.__zeroproxyKernelWebSocketCloseV2 = async (_kernel, requestID, code, reason) => {
        calls.push("close:" + code + ":" + reason);
        return { v: 2, request_id: requestID, code, closed: true };
      };
      self.__zeroproxyKernelWebSocketCancelV2 = async () => { cancelCount += 1; };
      const plan = { id: "socket-plan", protocols: ["chat"] };
      const port = {
        close() { portCloses += 1; },
        postMessage(message) { posts.push(message); },
      };
      const state = {
        closed: false, closeRequested: false, commandChain: Promise.resolve(), errorSent: false,
        opened: false, pendingBytes: 0, pendingCount: 0, plan, port, portClosed: false,
        sequence: 0, start: { max_message_bytes: 8, send_high_water_mark: 16 },
      };
      await handleWebSocketKernelEvent(state, {
        v: 2, type: "open", request_id: plan.id, protocol: "chat", set_cookies: [],
      });
      handleWebSocketPortCommand(state, {
        v: 2, type: "send", request_id: plan.id, seq: 0, kind: "text", data: new Uint8Array([1, 2]),
      });
      handleWebSocketPortCommand(state, {
        v: 2, type: "send", request_id: plan.id, seq: 1, kind: "binary", data: new Uint8Array([3]),
      });
      handleWebSocketPortCommand(state, {
        v: 2, type: "close", request_id: plan.id, code: 1005, reason: "",
      });
      await state.commandChain;
      await handleWebSocketKernelEvent(state, {
        v: 2, type: "message", request_id: plan.id, data_kind: "text", data: new Uint8Array([4]),
      });
      await handleWebSocketKernelEvent(state, {
        v: 2, type: "error", request_id: plan.id, error: "READ",
      });
      await handleWebSocketKernelEvent(state, {
        v: 2, type: "close", request_id: plan.id, code: 1005, reason: "", was_clean: true,
      });
      await handleWebSocketKernelEvent(state, {
        v: 2, type: "close", request_id: plan.id, code: 1006, reason: "", was_clean: false,
      });
      const invalidPosts = [];
      const invalidState = {
        ...state, closed: false, closeRequested: false, errorSent: false, opened: true,
        pendingBytes: 0, pendingCount: 0, portClosed: false, sequence: 0,
        port: { close() {}, postMessage(message) { invalidPosts.push(message); } },
      };
      handleWebSocketPortCommand(invalidState, {
        v: 2, type: "send", request_id: plan.id, seq: 0, kind: "binary", data: new Uint8Array(9),
      });
      await Promise.resolve();
      return {
        calls,
        cancel_count: cancelCount,
        invalid_types: invalidPosts.map(message => message.type),
        port_closes: portCloses,
        post_types: posts.map(message => message.type),
        terminal_closed: state.closed,
      };
    };
    globalThis.__parseTrustedEventSourceIDs = chunks => {
      const parser = new TrustedEventSourceIDParser();
      const values = [];
      for (const chunk of chunks) {
        const value = parser.push(new TextEncoder().encode(chunk));
        if (value !== undefined) values.push(value);
      }
      const finalValue = parser.finish();
      if (finalValue !== undefined) values.push(finalValue);
      return values;
    };`, context, { filename: "web/sw/sw.mjs" });
  return {
    parseTrustedIDs: context.__parseTrustedEventSourceIDs,
    run: context.__runAPIAdmissionScenario,
    runWebSocket: context.__runWebSocketProtocolScenario,
  };
}

test("one-shot API admission validates every binding before atomic consumption", async () => {
  const { run } = await loadAdmissionScenario();
  const result = await run();
  assert.equal(result.absent, null);
  assert.equal(result.wrongClient, null);
  assert.equal(result.wrongMethod, null);
  assert.equal(result.missingBody, null);
  assert.equal(result.wrongHandle, null);
  assert.equal(result.wrongDocument, null);
  assert.equal(result.expired, null);
  assert.equal(result.retainedAfterFailures, true);
  assert.equal(result.accepted, "plan");
  assert.equal(result.accepted_content_type, "text/plain;charset=UTF-8");
  assert.deepEqual({ ...result.event_source }, {
    first_attempt: 1,
    forged_reconnect_rejected: true,
    rate_limited: true,
    second_attempt: 2,
    trusted_retry_header: "trusted-one",
  });
  assert.equal(result.stored, null);
  assert.equal(result.reused, null);
});

test("WebSocket stream protocol is ordered, bounded, and singly terminal", async () => {
  const { runWebSocket } = await loadAdmissionScenario();
  const result = await runWebSocket();
  assert.deepEqual(Array.from(result.calls), ["send:0:text:2", "send:1:binary:1", "close:1005:"]);
  assert.deepEqual(Array.from(result.post_types), ["open", "ack", "ack", "message", "error", "close"]);
  assert.deepEqual(Array.from(result.invalid_types), ["error", "close"]);
  assert.equal(result.cancel_count, 1);
  assert.equal(result.port_closes, 1);
  assert.equal(result.terminal_closed, true);
});

test("trusted EventSource ID parsing is bounded and chunk-stable", async () => {
  const { parseTrustedIDs } = await loadAdmissionScenario();
  const values = parseTrustedIDs([
    "id: first\r",
    "\ndata: payload\n\nid: page\0forged\n",
    `id: ${"x".repeat(4097)}\n`,
    "id: second",
  ]);
  assert.deepEqual(Array.from(values), ["first", "second"]);
});
