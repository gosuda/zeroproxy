const capability = "w".repeat(32);
let client = null;
const bootstrapModuleURL = __BOOTSTRAP_MODULE_URL__;
const bootstrapClassicURL = __BOOTSTRAP_CLASSIC_URL__;
const workletModuleURL = "/controlled-worklet-module.mjs";

function root(kind, payload, directSource) {
  const routedSource = directSource;
  const preparedSource = routedSource === null
    ? null
    : routedSource.replaceAll(
      "location.href",
      `globalThis[${JSON.stringify(payload.worker_abi_identifier)}].scope.location.href`,
    );
  const directPath = preparedSource === null ? null : `/controlled-worker-direct.js?source=${encodeURIComponent(preparedSource)}`;
  const abiQuery = `?abi=${encodeURIComponent(payload.worker_abi_identifier)}`;
  const isolated = /\/target-shared-worker-isolated-([ab])\.js$/u.exec(new URL(payload.target_url).pathname);
  const classicRootURL = isolated
    ? `/controlled-shared-worker-isolated-${isolated[1]}.js`
    : kind === "SharedClassicWorker" ? "/controlled-shared-worker-classic.js" : `/controlled-worker-classic.js${abiQuery}`;
  const moduleRootURL = kind === "SharedModuleWorker" ? "/controlled-shared-worker-module.mjs" : `/controlled-worker-module.mjs${abiQuery}`;
  const classicRoot = Object.freeze({ controlled: true, url: directPath ?? classicRootURL });
  const moduleRoot = Object.freeze({ controlled: true, url: directPath ?? moduleRootURL });
  return {
    abi_identifier: payload.worker_abi_identifier,
    classic: Object.freeze({}),
    classic_root: classicRoot,
    gateway: Object.freeze({
      expires_at: Date.now() + 60_000,
      id: "g".repeat(32),
      key: "k".repeat(32),
      lease_generation: 1,
    }),
    message_allowed: true,
    module_root: moduleRoot,
    modules: Object.freeze({}),
    root_precompiled: true,
    resolved_modules: Object.freeze({}),
  };
}

function source(kind) {
  if (kind === "SharedClassicWorker") return "onconnect=e=>{const p=e.ports[0];p.start();p.postMessage({kind:'shared-classic-root'});p.onmessage=e=>p.postMessage({echo:e.data})}";
  if (kind === "SharedModuleWorker") return "onconnect=e=>{const p=e.ports[0];p.start();p.postMessage({kind:'shared-module-root'});p.onmessage=e=>p.postMessage({echo:e.data})};export {};";
  if (kind === "ModuleWorker") return "postMessage({kind:'module-root'});onmessage=e=>postMessage({echo:e.data});setInterval(()=>postMessage({kind:'module-heartbeat'}),30);export {};";
  return "postMessage({kind:'classic-root'});onmessage=e=>postMessage({echo:e.data});setInterval(()=>postMessage({kind:'classic-heartbeat'}),30);";
}
function executableSource(payload) {
  const executable = payload.executable_source;
  if (!executable || !executable.bytes) return null;
  const essence = executable.media_type.split(";", 1)[0].trim().toLowerCase();
  const moduleKind = ["ModuleWorker", "SharedModuleWorker", "WorkletModule"].includes(payload.source_kind);
  if (
    moduleKind
    && !["application/ecmascript", "application/javascript", "application/x-javascript", "text/ecmascript", "text/javascript"].includes(essence)
  ) {
    throw new DOMException("Worker executable MIME rejected", "SecurityError");
  }
  const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/iu.exec(executable.media_type);
  const label = charset?.[1] ?? charset?.[2] ?? "utf-8";
  let decoder;
  try { decoder = new TextDecoder(label || "utf-8"); }
  catch { decoder = new TextDecoder(); }
  return decoder.decode(executable.bytes);
}


self.addEventListener("fetch", event => {
  const target = new URL(event.request.url);
  if (target.pathname === "/controlled-worker-direct.js" && target.searchParams.has("source")) {
    event.respondWith(new Response(target.searchParams.get("source"), { headers: { "Content-Type": "text/javascript; charset=utf-8" } }));
  }
});

self.addEventListener("message", event => {
  const message = event.data;
  if (message?.operation !== "BIND_RUNTIME_PORT" || message?.payload?.runtime_capability !== capability || event.ports.length !== 1) return;
  client = event.source;
  const port = event.ports[0];
  port.start();
  port.postMessage({ v: 2, operation: "RUNTIME_PORT_READY" });
  port.addEventListener("message", request => {
    const value = request.data;
    if (value?.v !== 2 || value.operation !== "TARGET_WORKER_BOOTSTRAP_ALLOCATE") return;
    const payload = value.payload;
    const valid = payload
      && typeof payload.target_url === "string"
      && ["SharedClassicWorker", "SharedModuleWorker", "ClassicWorker", "ModuleWorker", "WorkletModule"].includes(payload.source_kind)
      && payload.options
      && typeof payload.options === "object"
      && /^__zp_abi_[0-9a-f]{48}$/.test(payload.worker_abi_identifier);
    if (!valid || typeof bootstrapModuleURL !== "string" || typeof bootstrapClassicURL !== "string") {
      port.postMessage({ v: 2, request_id: value.request_id, ok: false });
      return;
    }
    client?.postMessage({ type: "WORKER_BOOTSTRAP_PLAN", payload });
    if (payload.source_kind === "WorkletModule") {
      port.postMessage({
        v: 2,
        request_id: value.request_id,
        ok: true,
        result: {
          abi_identifier: payload.worker_abi_identifier,
          module_url: workletModuleURL,
          root_precompiled: true,
          source_kind: payload.source_kind,
          target_url: payload.target_url,
        },
      });
      return;
    }
    const module = ["ModuleWorker", "SharedModuleWorker", "WorkletModule"].includes(payload.source_kind);
    let executable;
    try { executable = executableSource(payload); }
    catch {
      port.postMessage({ v: 2, request_id: value.request_id, ok: false });
      return;
    }
    const result = {
      abi_identifier: payload.worker_abi_identifier,
      bootstrap: root(payload.source_kind, payload, executable),
      bootstrap_url: module ? bootstrapModuleURL : bootstrapClassicURL,
      root_precompiled: true,
      source: executable ?? source(payload.source_kind),
      source_kind: payload.source_kind,
      target_origin: new URL(payload.target_url).origin,
      target_url: payload.target_url,
    };
    port.postMessage({ v: 2, request_id: value.request_id, ok: true, result });
  });
});

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
