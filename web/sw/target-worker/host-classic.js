(() => {
  let pendingPortEvent = null;
  let hostLoaded = false;

  function capturePort(event) {
    if (hostLoaded) return;
    if (pendingPortEvent !== null || event.ports.length !== 1) {
      try { globalThis.close(); } catch {}
      return;
    }
    pendingPortEvent = { data: event.data, ports: [event.ports[0]] };
    event.stopImmediatePropagation();
  }

  globalThis.addEventListener("message", capturePort);
  void import("__ZP_TARGET_WORKER_HOST_MODULE_URL__").then(() => {
    hostLoaded = true;
    globalThis.removeEventListener("message", capturePort);
    if (pendingPortEvent !== null) globalThis.dispatchEvent(new MessageEvent("message", pendingPortEvent));
  }).catch(() => {
    try { globalThis.close(); } catch {}
  });
})();
