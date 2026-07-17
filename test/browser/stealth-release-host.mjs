import { runStealthReleaseProbes } from "/stealth-release-probes.mjs";

const parameters = new URLSearchParams(location.search);
const mode = parameters.get("mode");
const role = parameters.get("role") ?? "top";
const abiName = `__zp_abi_${"a".repeat(48)}`;
const rawCreateElement = Document.prototype.createElement;
const rawSetAttribute = Element.prototype.setAttribute;
const rawAppendChild = Node.prototype.appendChild;
const rawRemoveChild = Node.prototype.removeChild;
const rawOpen = window.open;
const rawPostMessage = window.postMessage;
let view = window;
try {
if (mode === "mediated") {
  const runtime = document.createElement("script");
  runtime.src = `${parameters.get("runtime")}#abi=${abiName}&url=${encodeURIComponent(parameters.get("target"))}&ports=80%2C443`;
  runtime.nonce = "zp-oracle-runtime";
  if (parameters.get("integrity")) {
    runtime.integrity = parameters.get("integrity");
    runtime.crossOrigin = "anonymous";
  }
  await new Promise((resolve, reject) => {
    runtime.addEventListener("load", resolve, { once: true });
    runtime.addEventListener("error", () => reject(new Error("runtime load failed")), { once: true });
    document.head.append(runtime);
  });
  view = globalThis[abiName].scope.window;
}
await new Promise(resolve => document.readyState === "complete" ? resolve() : addEventListener("load", resolve, { once: true }));

function childURL(childRole, crossOrigin = false) {
  const url = new URL("/oracle", crossOrigin ? parameters.get("cross_origin") : location.origin);
  for (const name of ["mode", "policy", "runtime", "integrity", "cross_origin"]) {
    const value = parameters.get(name);
    if (value) url.searchParams.set(name, value);
  }
  url.searchParams.set("role", childRole);
  const target = new URL(url);
  target.searchParams.set("mode", "native");
  target.searchParams.delete("target");
  url.searchParams.set("target", target.href);
  return url.href;
}

function waitForChild(childRole, launch) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      removeEventListener("message", onMessage);
      reject(new Error(`${childRole} context timed out`));
    }, 10_000);
    function onMessage(event) {
      if (event.data?.type !== "stealth-release-context" || event.data.role !== childRole) return;
      clearTimeout(timeout);
      removeEventListener("message", onMessage);
      resolve(event.data.result);
    }
    addEventListener("message", onMessage);
    launch();
  });
}

async function frameContext(childRole, crossOrigin) {
  let frame;
  const result = await waitForChild(childRole, () => {
    frame = rawCreateElement.call(document, "iframe");
    rawSetAttribute.call(frame, "hidden", "");
    rawSetAttribute.call(frame, "src", childURL(childRole, crossOrigin));
    rawAppendChild.call(document.body, frame);
  });
  rawRemoveChild.call(frame.parentNode, frame);
  return result;
}

async function popupContext(childRole, crossOrigin) {
  let popup;
  const result = await waitForChild(childRole, () => {
    popup = rawOpen.call(window, childURL(childRole, crossOrigin), `_zp_oracle_${mode}_${childRole}`);
    if (!popup) throw new Error(`${childRole} popup blocked`);
  });
  popup?.close();
  return result;
}

async function blankRealmContext() {
  const frame = view.document.createElement("iframe");
  frame.hidden = true;
  const loaded = new Promise(resolve => frame.addEventListener("load", resolve, { once: true }));
  view.document.body.append(frame);
  await loaded;
  const childView = frame.contentWindow;
  const result = await runStealthReleaseProbes(childView);
  frame.remove();
  return result;
}

async function workerContext() {
  try {
    const worker = new view.Worker("/stealth-release-worker.mjs", { type: "module", name: "stealth-release-oracle" });
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("worker context timed out")), 10_000);
      worker.addEventListener("message", event => { clearTimeout(timeout); resolve(event.data); }, { once: true });
      worker.addEventListener("error", event => { clearTimeout(timeout); reject(new Error(event.message)); }, { once: true });
    });
    worker.terminate();
    return result;
  } catch (error) {
    return { "worker-constructor-error": { name: error?.name ?? null } };
  }
}

  const observations = await runStealthReleaseProbes(view);
  const result = { ok: true, mode, role, observations };
  if (role === "top") {
    const contexts = {};
    contexts.top = structuredClone(observations);
    globalThis.__stealthReleaseProgress = "same-frame";
    contexts["same-frame"] = await frameContext("same-frame", false);
    globalThis.__stealthReleaseProgress = "cross-frame";
    contexts["cross-frame"] = await frameContext("cross-frame", true);
    globalThis.__stealthReleaseProgress = "same-popup";
    contexts["same-popup"] = await popupContext("same-popup", false);
    globalThis.__stealthReleaseProgress = "cross-popup";
    contexts["cross-popup"] = await popupContext("cross-popup", true);
    globalThis.__stealthReleaseProgress = "about-blank-realm";
    contexts["about-blank-realm"] = await blankRealmContext();
    globalThis.__stealthReleaseProgress = "worker";
    result.contexts = contexts;
    result.worker = await workerContext();
    globalThis.__stealthReleaseProgress = "complete";
    globalThis.__stealthReleaseOracle = result;
  } else {
    const destination = opener ?? parent;
    rawPostMessage.call(destination, { type: "stealth-release-context", role, result: observations }, "*");
  }
} catch (error) {
  const result = { ok: false, mode, role, error: { name: error?.name, message: error?.message, stack: error?.stack } };
  if (role === "top") globalThis.__stealthReleaseOracle = result;
  else {
    const destination = opener ?? parent;
    rawPostMessage.call(destination, { type: "stealth-release-context", role, result }, "*");
  }
}
