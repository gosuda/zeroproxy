const origins = Object.freeze({
  "https://alpha.example": "o-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.browse.realm.localhost",
  "https://beta.example": "o-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.browse.realm.localhost",
});
let cookieSequence = 2;
let cookieMutationSettled = false;
const cookieRows = [
  { name: "same", value: "unpartitioned", domain: "alpha.example", path: "/", secure: true, http_only: false, same_site: "LAX", creation_seq: 1 },
  { name: "same", value: "partitioned", domain: "alpha.example", path: "/", secure: true, http_only: false, same_site: "NONE", partition_key: "https://beta.example", creation_seq: 2 },
];

function cookieSnapshot() {
  return { cookie_seq: cookieSequence, jar_or_delta: { kind: "SNAPSHOT", cookies: cookieRows } };
}

function reply(port, requestID, ok, result) {
  port?.postMessage(ok
    ? { v: 2, request_id: requestID, ok: true, result }
    : { v: 2, request_id: requestID, ok: false, error: { code: "UNKNOWN_MAPPING" } });
}

function mapOrigin(targetURL) {
  const target = new URL(targetURL);
  const host = origins[target.origin];
  if (!host) return null;
  const syntheticOrigin = `${self.location.protocol}//${host}${self.location.port ? `:${self.location.port}` : ""}`;
  return Object.freeze({ synthetic_origin: syntheticOrigin, virtual_origin: target.origin });
}

function plannedPath(targetURL, mapping) {
  const target = new URL(targetURL);
  if (target.pathname === "/blank") return `${mapping.synthetic_origin}/synthetic-origin-realm-blank.html`;
  const page = target.pathname === "/popup" ? "synthetic-origin-realm-popup.html" : "synthetic-origin-realm-child.html";
  const parameters = new URLSearchParams({
    parent_virtual: "https://alpha.example",
    virtual: mapping.virtual_origin,
  });
  parameters.set("target_path", target.pathname);
  return `${mapping.synthetic_origin}/${page}?${parameters}`;
}

function trace(client, stage, value = {}) {
  client?.postMessage({ type: "MOCK_REALM_TRACE", stage, ...value });
}

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("message", event => {
  const message = event.data;
  const client = event.source;
  trace(client, "message", { operation: message?.operation });
  if (message?.v !== 2 || typeof message.operation !== "string") return;
  if (message.operation === "BIND_RUNTIME_PORT") {
    const port = event.ports[0];
    if (!port) return;
    port.onmessage = runtimeEvent => {
      const runtime = runtimeEvent.data;
      trace(client, "runtime-port-message", { operation: runtime?.operation, payload: runtime?.payload });
      if (runtime?.v !== 2 || typeof runtime.operation !== "string") return;
      if (runtime.operation === "DOCUMENT_COOKIE_MUTATE") {
        cookieMutationSettled = false;
        cookieSequence += 1;
        const accepted = runtime.payload?.raw?.startsWith("same=") === true;
        if (accepted) cookieRows[1] = { ...cookieRows[1], value: "updated" };
        setTimeout(() => {
          cookieMutationSettled = true;
          reply(port, runtime.request_id, true, {
            commit: { operation: "COOKIE_COMMIT", op_id: runtime.payload?.op_id, cookie_seq: cookieSequence, accepted, ...(accepted ? {} : { reason: "HTTP_ONLY_DOCUMENT" }), visible_delta: [], http_only_delta_digest: "mock" },
            snapshot: cookieSnapshot(),
          });
        }, 80);
        return;
      }
      if (runtime.operation === "DOCUMENT_COOKIE_SNAPSHOT") {
        reply(port, runtime.request_id, true, cookieSnapshot());
        return;
      }
      if (runtime.operation === "ALLOCATE_API_PLAN") {
        trace(client, "api-plan-cookie-fence", { cookie_settled: cookieMutationSettled });
        reply(port, runtime.request_id, true, { path: "/cookie-request-after-write", body_handle: runtime.payload?.body_handle });
        return;
      }
      if (runtime.operation === "ALLOCATE_RESOURCE_ROUTE") {
        const mapping = mapOrigin(runtime.payload?.target_url);
        const target = mapping ? new URL(runtime.payload.target_url) : null;
        const routeID = target?.pathname === "/stale-slow" ? "stale-slow-route" : crypto.randomUUID();
        const send = () => reply(port, runtime.request_id, Boolean(mapping), mapping && {
          ...mapping,
          path: plannedPath(runtime.payload.target_url, mapping),
          route_id: routeID,
          policy_revision: 2,
          client_bound: true,
        });
        if (target?.pathname === "/stale-slow") setTimeout(send, 150);
        else send();
        return;
      }
      if (runtime.operation === "REVOKE_RESOURCE_ROUTE") {
        reply(port, runtime.request_id, true, { revoked: runtime.payload?.route_id === "stale-slow-route" });
        return;
      }
      reply(port, runtime.request_id, false);
    };
    port.start();
    port.postMessage({ v: 2, operation: "RUNTIME_PORT_READY" });
    return;
  }
  if (message.operation === "MAP_ORIGIN") {
    const mapping = mapOrigin(message.payload?.target_url);
    reply(event.ports[0], message.request_id, Boolean(mapping), mapping);
  }
});
