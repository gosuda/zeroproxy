const tag = value => Object.prototype.toString.call(value);
const noInternalURL = value => typeof value !== "string" || !value.includes("/_zp/") && !value.includes("__zp_abi_");

const observations = {
  "worker-global-equality": globalThis === self,
  "worker-global-brand": tag(globalThis),
  "worker-location-brand": tag(location),
  "worker-location-url": noInternalURL(location.href),
  "worker-fetch-source": Function.prototype.toString.call(fetch),
  "worker-error-brand": tag(new Error("probe")),
  "worker-error-url": noInternalURL(new Error("probe").stack ?? ""),
  "worker-performance-urls": performance.getEntriesByType("resource").every(entry => noInternalURL(entry.name)),
  "worker-service-worker-absent": navigator.serviceWorker === undefined,
  "worker-injected-names": Reflect.ownKeys(globalThis).filter(key => typeof key === "string" && key.startsWith("__zp_")).sort(),
};
postMessage(observations);
