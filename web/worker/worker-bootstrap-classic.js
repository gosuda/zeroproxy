(() => {
const sourceKind = new URLSearchParams(globalThis.location.hash.slice(1)).get("source_kind");
const shared = sourceKind === "SharedClassicWorker";
const eventType = shared ? "connect" : "message";
const pendingPortEvents = [];
let bootstrapLoaded = false;
function capturePort(event) {
  if (bootstrapLoaded) return;
  if (event.ports.length !== 1 || (!shared && pendingPortEvents.length !== 0) || pendingPortEvents.length >= 64) {
    try { globalThis.close(); } catch {}
    return;
  }
  pendingPortEvents.push({ data: event.data, ports: [event.ports[0]] });
  event.stopImmediatePropagation();
}
globalThis.addEventListener(eventType, capturePort);
void import("./worker-bootstrap.mjs").then(() => {
  bootstrapLoaded = true;
  globalThis.removeEventListener(eventType, capturePort);
  for (const pending of pendingPortEvents) {
    globalThis.dispatchEvent(new MessageEvent(eventType, pending));
  }
}).catch(() => {
  try { globalThis.close(); } catch {}
});
})();
