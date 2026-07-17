const own = (value, key) => Object.getOwnPropertyDescriptor(value, key);
const tag = value => Object.prototype.toString.call(value);
const functionShape = value => ({
  length: value.length,
  name: value.name,
  prototype: Object.getPrototypeOf(value)?.constructor?.name ?? null,
  source: Function.prototype.toString.call(value),
});
const descriptorShape = descriptor => descriptor ? {
  configurable: descriptor.configurable,
  enumerable: descriptor.enumerable,
  getter: typeof descriptor.get === "function",
  setter: typeof descriptor.set === "function",
  valueType: "value" in descriptor ? typeof descriptor.value : null,
  writable: "writable" in descriptor ? descriptor.writable : null,
} : null;
const errorShape = action => {
  try { action(); return null; } catch (error) {
    return { name: error?.name ?? null, tag: tag(error), type: error?.constructor?.name ?? null };
  }
};
const noInternalURL = value => typeof value !== "string" || !value.includes("/_zp/") && !value.includes("__zp_abi_");

export async function runStealthReleaseProbes(view) {
  const observations = {};
  const put = (id, value) => { observations[id] = value; };
  const document = view.document;
  const location = view.location;

  put("globalthis-window", view.globalThis === view);
  put("window-self", view.window === view && view.self === view);
  put("window-frames", view.frames === view);
  put("window-top-parent", { parent: view.parent === view, top: view.top === view });
  put("document-defaultview", document.defaultView === view);
  put("window-location", location === document.location);

  put("window-location-descriptors", {
    location: descriptorShape(own(view, "location")),
    window: descriptorShape(own(view, "window")),
  });
  put("window-location-prototypes", {
    location: Object.getPrototypeOf(location)?.constructor?.name,
    window: Object.getPrototypeOf(view)?.constructor?.name,
  });
  put("window-location-own-keys", {
    abi: Reflect.ownKeys(view).some(key => typeof key === "string" && key.startsWith("__zp_abi_")),
    location: Reflect.ownKeys(location).map(String).sort(),
  });
  put("window-location-brands", { location: tag(location), window: tag(view) });
  put("window-location-illegal-receivers", errorShape(() => own(view.Location.prototype, "href").get.call({})));

  for (const [id, Collection] of [["map-wrapper-key", Map], ["set-wrapper-key", Set], ["weakmap-wrapper-key", WeakMap]]) {
    const collection = new Collection();
    if (id === "set-wrapper-key") collection.add(view); else collection.set(view, true);
    put(id, id === "set-wrapper-key" ? collection.has(document.defaultView) : collection.get(document.defaultView) === true);
  }
  put("wrapper-instanceof", { document: document instanceof view.Document, location: location instanceof view.Location, window: view instanceof view.Window });
  put("wrapper-tostringtag", { document: tag(document), location: tag(location), window: tag(view) });

  const fetchShape = functionShape(view.fetch);
  put("function-source", fetchShape.source);
  put("function-name", fetchShape.name);
  put("function-length", fetchShape.length);
  put("function-prototype", fetchShape.prototype);
  put("function-tostring", view.Function.prototype.toString.call(view.fetch));

  const host = document.createElement("section");
  host.id = "stealth-probe-host";
  host.setAttribute("data-visible", "yes");
  host.innerHTML = "<span class='probe-child'>text</span>";
  document.body.append(host);
  put("target-attributes", { names: host.getAttributeNames(), value: host.getAttribute("data-visible") });
  put("target-nodes", { child: host.firstElementChild?.localName, parent: host.parentNode === document.body });
  const collection = host.getElementsByClassName("probe-child");
  const before = collection.length;
  host.append(document.createElement("span"));
  host.lastElementChild.className = "probe-child";
  put("target-live-collections", { before, after: collection.length, same: collection === host.getElementsByClassName("probe-child") });
  put("target-selectors", { one: document.querySelector("#stealth-probe-host") === host, all: document.querySelectorAll(".probe-child").length });
  put("target-serialization", { html: host.outerHTML, internal: !noInternalURL(host.outerHTML) });
  const mutationRecords = [];
  const observer = new view.MutationObserver(records => mutationRecords.push(...records.map(record => ({ name: record.attributeName, type: record.type }))));
  observer.observe(host, { attributes: true });
  host.setAttribute("title", "visible");
  await Promise.resolve();
  observer.disconnect();
  put("target-mutation-records", mutationRecords);

  put("parser-current-script", document.currentScript === null);
  put("parser-ready-state", ["interactive", "complete"].includes(document.readyState));
  put("parser-domcontentloaded", document.readyState !== "loading");
  put("parser-load", document.readyState === "complete");
  const microtasks = [];
  queueMicrotask(() => microtasks.push("queue"));
  Promise.resolve().then(() => microtasks.push("promise"));
  await Promise.resolve();
  await Promise.resolve();
  put("parser-microtask-order", microtasks);

  const stack = new view.Error("probe").stack ?? "";
  put("error-stack-urls", { internal: !noInternalURL(stack), name: stack.startsWith("Error: probe") });
  put("script-source-urls", noInternalURL(import.meta.url));
  put("source-map-urls", !stack.includes("sourceMappingURL"));
  put("error-brand-message", { error: tag(new view.Error("probe")), type: errorShape(() => view.Location.prototype.assign.call({})) });

  const resources = view.performance.getEntriesByType("resource").map(entry => entry.name);
  put("resource-timing", resources.every(noInternalURL));
  put("performance-observer", typeof view.PerformanceObserver === "function" && typeof view.PerformanceObserver.prototype.observe === "function");
  put("navigation-timing", view.performance.getEntriesByType("navigation").map(entry => ({ nameInternal: !noInternalURL(entry.name), type: entry.type })));

  put("csp-violations", { constructor: typeof view.SecurityPolicyViolationEvent === "function", policy: document.querySelector("meta[http-equiv='Content-Security-Policy']") === null });
  put("trusted-types-violations", { available: typeof view.trustedTypes === "object", policy: document.querySelector("meta[http-equiv='Content-Security-Policy']") === null });
  const sri = document.createElement("script");
  sri.integrity = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  put("sri-violations", { reflected: sri.integrity.startsWith("sha256-"), supported: "integrity" in sri });

  put("target-sw-controller", view.navigator.serviceWorker?.controller === null);
  put("target-sw-registrations", typeof view.navigator.serviceWorker?.getRegistrations === "function");
  put("target-sw-state", view.navigator.serviceWorker === undefined ? "unsupported" : "available");

  put("raw-route-urls", [location.href, document.URL, document.baseURI].every(noInternalURL));
  put("raw-runtime-urls", resources.every(noInternalURL));
  put("raw-proxy-urls", document.documentElement.outerHTML.includes("/_zp/") === false);

  put("root-descriptor-graph", {
    document: descriptorShape(own(view, "document")),
    eval: descriptorShape(own(view, "eval")),
    location: descriptorShape(own(view, "location")),
  });
  put("injected-global-names", Reflect.ownKeys(view).filter(key => typeof key === "string" && key.startsWith("__zp_")).sort());
  put("injected-dom-names", document.querySelectorAll("[data-zp-m-v2],[data-zp-style-v2],[data-zp-runtime-v2]").length);
  host.remove();
  return observations;
}
