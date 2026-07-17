function broadcast(message) {
  return fetch("/_zp/advanced-capture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  }).catch(() => {});
}

async function requestText(request) {
  return request.body ? request.text() : "";
}

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("message", event => {
  const message = event.data;
  if (message?.v !== 2 || message.operation !== "BIND_RUNTIME_PORT" || event.ports.length !== 1) return;
  const runtimePort = event.ports[0];
  runtimePort.start();
  runtimePort.postMessage({ v: 2, operation: "RUNTIME_PORT_READY" });
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  const route = /^\/_zp\/(beacon|form|ping|download|navigation)\/([0-9a-f]{48})\/([^/]+)$/.exec(url.pathname);
  if (!route) return;
  const [, kind, operation, token] = route;
  const response = (async () => {
    const capture = {
      kind: `${kind}-fetch`,
      method: event.request.method,
      content_type: event.request.headers.get("content-type") || "",
      body: await requestText(event.request),
      operation,
      path: url.pathname,
      search: url.search,
      origin: event.request.headers.get("origin") || "",
      referer: event.request.headers.get("referer") || "",
      ping_from: event.request.headers.get("ping-from") || "",
      ping_to: event.request.headers.get("ping-to") || "",
      token,
    };
    await broadcast(capture);
    if (kind === "beacon" || kind === "ping") return new Response(null, { status: 204 });
    if (kind === "download") {
      return new Response("download", {
        status: 200,
        headers: {
          "Content-Disposition": "attachment; filename*=UTF-8''mock.txt",
          "Content-Type": "text/plain",
        },
      });
    }
    return new Response(`${kind} response`, {
      status: 200,
      headers: { "Content-Type": "text/html;charset=utf-8" },
    });
  })();
  event.respondWith(response);
  event.waitUntil(response.then(() => {}, () => {}));
});
