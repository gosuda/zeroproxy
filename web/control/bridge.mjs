const nonceMatch = /^#nonce=([A-Za-z0-9_-]{24})$/.exec(location.hash);
const expectedNonce = nonceMatch?.[1] ?? null;
history.replaceState(null, "", location.pathname + location.search);

const config = await fetch("/control/config.json", {
  cache: "no-store",
  credentials: "same-origin",
}).then((response) => {
  if (!response.ok) throw new DOMException("Coordinator configuration unavailable", "NetworkError");
  return response.json();
});

const escapedDomain = config.browse_domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const browseAuthority = location.port ? `${escapedDomain}:${location.port}` : escapedDomain;
const parentOriginPattern = new RegExp(`^https://o-[a-z2-7]{32}\\.browse\\.${browseAuthority}$`);

function exactAttachRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = ["v", "operation", "handoff_id", "nonce"];
  return Object.keys(value).length === fields.length
    && fields.every((field) => field in value)
    && value.v === 2
    && value.operation === "ATTACH"
    && /^[A-Za-z0-9_-]{32}$/.test(value.handoff_id)
    && value.nonce === expectedNonce;
}

function rejectAttach(origin, code, port) {
  try {
    parent.postMessage({
      v: 2,
      operation: "ATTACH_FAILED",
      error: { code },
    }, origin);
  } finally {
    port?.close();
  }
}

async function consumeHandoff(port, event) {
  const requestID = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new DOMException("Coordinator timeout", "TimeoutError"));
    }, 10_000);
    port.onmessage = (message) => {
      if (message.data?.request_id !== requestID) return;
      clearTimeout(timeout);
      resolve(message.data);
    };
    port.start();
    port.postMessage({
      v: 2,
      request_id: requestID,
      operation: "CONSUME_HANDOFF",
      expected_revision: null,
      payload: {
        handoff_id: event.data.handoff_id,
        bridge_nonce: event.data.nonce,
        destination_host: new URL(event.origin).host,
      },
    });
  });
}

async function attach(event) {
  if (event.source !== parent || !parentOriginPattern.test(event.origin)
    || expectedNonce === null || !exactAttachRequest(event.data)) return;
  removeEventListener("message", attach);

  if (typeof SharedWorker !== "function") {
    rejectAttach(event.origin, "BROWSER_UNSUPPORTED");
    return;
  }
  let port;
  try {
    const worker = new SharedWorker("/control/coordinator.mjs", {
      type: "module",
      name: "zeroproxy-v2-profile-coordinator",
    });
    port = worker.port;
    const response = await consumeHandoff(port, event);
    if (response?.ok !== true || !Number.isSafeInteger(response.revision)) {
      rejectAttach(event.origin, "COORDINATOR_UNAVAILABLE", port);
      return;
    }
    port.onmessage = null;
    parent.postMessage({
      v: 2,
      operation: "ATTACHED",
      state: { ...response.result, coordinator_revision: response.revision },
    }, event.origin, [port]);
  } catch {
    rejectAttach(event.origin, "COORDINATOR_UNAVAILABLE", port);
  }
}

addEventListener("message", attach);
