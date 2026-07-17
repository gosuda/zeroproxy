export function install(scope) {
  scope.addEventListener("fetch", event => event.respondWith(new Response("host-response")));
}

export function installBlocked(scope) {
  scope.importScripts("https://target.example/escape.js");
}

export function installCapabilities(scope) {
  scope.addEventListener("activate", event => event.waitUntil((async () => {
    const cache = await scope.caches.open("runtime");
    await cache.put("https://target.example/cache", new Response("cached"));
    const response = await scope.fetch("https://target.example/data");
    await response.text();
    const clients = await scope.clients.matchAll();
    if (clients.length > 0) {
      const same = await scope.clients.get(clients[0].id);
      if (same !== clients[0]) throw new Error("client identity rejected");
      const focused = await clients[0].focus();
      if (focused !== clients[0]) throw new Error("WindowClient focus identity rejected");
    }
    await scope.skipWaiting();
  })()));
}

export function installClassic(scope) {
  if (arguments.length !== 1) throw new Error("classic target worker received a private host capability");
  scope.importScripts("./first.js", "/second.js");
  scope.addEventListener("activate", event => event.waitUntil(Promise.resolve()));
}

export function installModule(scope, importModule) {
  scope.addEventListener("install", event => event.waitUntil(
    importModule(
      "4".repeat(64),
      "https://target.example/sw.mjs",
      "./dependency.mjs",
    ).then(plan => {
      if (plan.url !== "/_zp/wm/graph/module.mjs") throw new Error("module plan rejected");
    }),
  ));
}

export function installNavigationPreload(scope) {
  scope.addEventListener("activate", event => event.waitUntil((async () => {
    const initial = await scope.registration.navigationPreload.getState();
    if (initial.enabled !== false || initial.headerValue !== "true") throw new Error("navigation preload default rejected");
    await scope.registration.navigationPreload.setHeaderValue("worker-v1");
    await scope.registration.navigationPreload.enable();
    const enabled = await scope.registration.navigationPreload.getState();
    if (enabled.enabled !== true || enabled.headerValue !== "worker-v1") throw new Error("navigation preload update rejected");
    await scope.registration.navigationPreload.disable();
  })()));
}

export const messageObservations = [];

export function installMessage(scope) {
  scope.addEventListener("message", event => {
    messageObservations.push({
      data: event.data,
      origin: event.origin,
      ports: event.ports.length,
      source_id: event.source?.id,
      source_type: event.source?.type,
      source_url: event.source?.url,
    });
    event.ports[0]?.postMessage({ via: "virtual-message-event" });
    event.source?.postMessage({ echo: event.data }, { transfer: event.ports });
  });
}
