import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GateFailure, canonicalDigest, invariant } from "../common.mjs";

const STARTUP_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 20_000;

function requiredEnvironment(name, environment = process.env) {
  const value = environment[name];
  invariant(typeof value === "string" && value.length > 0, `${name} is required for real browser evidence`, "evidence_prerequisite_missing");
  return value;
}

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  invariant(address && typeof address === "object", "could not allocate a loopback debugging port", "browser_unavailable");
  return address.port;
}

function waitForChildExit(child) {
  return new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
}

export class CdpConnection {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.socket = null;
  }

  async open() {
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new GateFailure("timed out connecting to browser DevTools", "browser_unavailable")), COMMAND_TIMEOUT_MS);
      this.socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timeout); reject(new GateFailure("browser DevTools connection failed", "browser_unavailable")); }, { once: true });
    });
    this.socket.addEventListener("message", event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new GateFailure(`CDP ${pending.method} failed: ${message.error.message}`, "browser_protocol_error"));
        else pending.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new GateFailure(`browser DevTools disconnected while running ${pending.method}`, "browser_unavailable"));
      }
      this.pending.clear();
    });
  }

  command(method, params = {}, sessionId = undefined) {
    invariant(this.socket && this.socket.readyState === WebSocket.OPEN, "browser DevTools is not connected", "browser_unavailable");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new GateFailure(`CDP ${method} timed out`, "browser_protocol_error"));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { method, resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  subscribe(listener) {
    invariant(typeof listener === "function", "CDP event listener must be a function");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }


  waitForEvent(method, predicate = () => true, timeoutMs = COMMAND_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new GateFailure(`CDP event ${method} timed out`, "browser_protocol_error"));
      }, timeoutMs);
      const listener = message => {
        if (message.method !== method || !predicate(message)) return;
        clearTimeout(timeout);
        this.listeners.delete(listener);
        resolve(message.params ?? {});
      };
      this.listeners.add(listener);
    });
  }

  close() {
    this.socket?.close();
  }
}

function browserIdentity(product) {
  const match = /(?:Chrome|Chromium)\/([0-9]+(?:\.[0-9]+){1,3})/.exec(product);
  invariant(match, `unsupported browser product for CDP evidence: ${product}`, "browser_unavailable");
  return { family: "chromium", exact_build: match[1] };
}

const PERFORMANCE_INSTRUMENTATION = `(() => {
  const state = { inp_ms: 0, interaction_count: 0 };
  globalThis.__zeroproxyGatePerformance = state;
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (entry.interactionId > 0) { state.interaction_count += 1; state.inp_ms = Math.max(state.inp_ms, entry.duration || 0); }
    }).observe({ type: "event", buffered: true, durationThreshold: 16 });
  } catch (error) {
    globalThis.__zeroproxyGatePerformanceObserverError = String(error);
  }
})();`;

function finiteMetric(value, label) {
  invariant(typeof value === "number" && Number.isFinite(value) && value >= 0, `browser page did not provide finite ${label}`, "measurement_unavailable");
  return value;
}

export class BrowserEvidenceSession {
  constructor({ child, childExit, cdp, directory, browser, browserVersion, buildProof }) {
    this.child = child;
    this.childExit = childExit;
    this.cdp = cdp;
    this.directory = directory;
    this.browser = browser;
    this.browserVersion = browserVersion;
    this.buildProof = buildProof;
    this.closed = false;
  }

  async createPage() {
    const target = await this.cdp.command("Target.createTarget", { url: "about:blank" });
    const attached = await this.cdp.command("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    await this.cdp.command("Target.activateTarget", { targetId: target.targetId });
    const page = { targetId: target.targetId, sessionId: attached.sessionId, pending_requests: new Set(), lcp_times: [], unsubscribe: null };
    await this.cdp.command("Page.enable", {}, page.sessionId);
    await this.cdp.command("Runtime.enable", {}, page.sessionId);
    await this.cdp.command("Performance.enable", {}, page.sessionId);
    await this.cdp.command("Network.enable", {}, page.sessionId);
    page.unsubscribe = this.cdp.subscribe(message => {
      if (message.sessionId !== page.sessionId) return;
      if (message.method === "PerformanceTimeline.timelineEventAdded") {
        const event = message.params?.event;
        if (event?.type === "largest-contentful-paint" && Number.isFinite(event.time)) page.lcp_times.push(event.time);
        return;
      }
      const requestId = message.params?.requestId;
      if (!requestId) return;
      if (message.method === "Network.requestWillBeSent") page.pending_requests.add(requestId);
      if (message.method === "Network.loadingFinished" || message.method === "Network.loadingFailed") page.pending_requests.delete(requestId);
    });
    return page;
  }

  async closePage(page) {
    if (!page) return;
    page.unsubscribe?.();
    try { await this.cdp.command("Target.closeTarget", { targetId: page.targetId }); } catch { /* Browser shutdown is still fail-closed at call sites. */ }
  }

  async evaluate(page, expression) {
    const outcome = await this.cdp.command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, page.sessionId);
    if (outcome.exceptionDetails) throw new GateFailure(`browser page evaluation failed: ${outcome.exceptionDetails.text}`, "measurement_unavailable");
    invariant(outcome.result && Object.hasOwn(outcome.result, "value"), "browser page evaluation returned no value", "measurement_unavailable");
    return outcome.result.value;
  }
  async waitForExpression(page, expression, timeoutMs = 30_000) {
    invariant(typeof expression === "string" && expression.length > 0, "performance readiness expression is required", "measurement_unavailable");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate(page, `Boolean(${expression})`).catch(() => false)) return;
      await sleep(50);
    }
    throw new GateFailure("performance fixture readiness timed out", "measurement_unavailable");
  }
  async dispatchInteraction(page, interaction) {
    invariant(interaction && typeof interaction === "object" && typeof interaction.selector === "string" && interaction.selector.length > 0, "performance interaction is invalid", "measurement_unavailable");
    if (interaction.kind === "click") {
      const serialized = await this.evaluate(page, `JSON.stringify((()=>{const element=document.querySelector(${JSON.stringify(interaction.selector)});if(!element)return null;const rect=element.getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2,width:rect.width,height:rect.height}})())`);
      const box = JSON.parse(serialized);
      invariant(box && box.width > 0 && box.height > 0, "performance click target is absent or not rendered", "measurement_unavailable");
      await this.cdp.command("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y }, page.sessionId);
      await this.cdp.command("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, page.sessionId);
      await this.cdp.command("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 }, page.sessionId);
      return;
    }
    invariant(interaction.kind === "type" && typeof interaction.text === "string" && interaction.text.length > 0, "performance interaction kind is unsupported", "measurement_unavailable");
    const focused = await this.evaluate(page, `(()=>{const element=document.querySelector(${JSON.stringify(interaction.selector)});if(!(element instanceof HTMLElement))return false;element.focus();if("value" in element)element.value="";if(element.isContentEditable){const selection=getSelection(),range=document.createRange();range.selectNodeContents(element);range.collapse(false);selection.removeAllRanges();selection.addRange(range)}return document.activeElement===element})()`);
    invariant(focused === true, "performance typing target could not be focused", "measurement_unavailable");
    for (const character of interaction.text) {
      await this.cdp.command("Input.dispatchKeyEvent", { type: "keyDown", key: character, text: character }, page.sessionId);
      await this.cdp.command("Input.dispatchKeyEvent", { type: "keyUp", key: character }, page.sessionId);
    }
    if (interaction.submit === true) {
      await this.cdp.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, page.sessionId);
      await this.cdp.command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, page.sessionId);
    }
  }



  async navigate(page, url, { instrument = false } = {}) {
    invariant(typeof url === "string" && /^https?:\/\//.test(url), `evidence URL must be absolute HTTP(S): ${url}`, "measurement_unavailable");
    if (instrument) await this.cdp.command("Page.addScriptToEvaluateOnNewDocument", { source: PERFORMANCE_INSTRUMENTATION }, page.sessionId);
    const loaded = this.cdp.waitForEvent("Page.loadEventFired", message => message.sessionId === page.sessionId);
    const navigation = await this.cdp.command("Page.navigate", { url }, page.sessionId);
    invariant(!navigation.errorText, `browser navigation failed for ${url}: ${navigation.errorText}`, "measurement_unavailable");
    await loaded;
  }

  async measureNavigation(url, gate, protocol) {
    invariant(protocol && typeof protocol === "object", "performance measurement protocol is required", "measurement_unavailable");
    invariant(typeof protocol.ready_expression === "string" && protocol.ready_expression.length > 0, "performance readiness expression is required", "measurement_unavailable");
    invariant(typeof protocol.postcondition_expression === "string" && protocol.postcondition_expression.length > 0, "performance postcondition expression is required", "measurement_unavailable");
    invariant(protocol.settle_ms === 1000, "performance settle interval must be 1000ms", "measurement_unavailable");
    const page = await this.createPage();
    try {
      const beforePerformance = await this.cdp.command("Performance.getMetrics", {}, page.sessionId);
      const beforeTaskDuration = beforePerformance.metrics.find(metric => metric.name === "TaskDuration")?.value;
      await this.navigate(page, url, { instrument: true });
      await this.waitForExpression(page, protocol.ready_expression);
      await this.cdp.command("PerformanceTimeline.enable", { eventTypes: ["largest-contentful-paint"] }, page.sessionId);
      await sleep(100);
      await this.dispatchInteraction(page, protocol.interaction);
      await this.waitForExpression(page, protocol.postcondition_expression);
      await sleep(protocol.settle_ms);
      const pageMetrics = await this.evaluate(page, `JSON.stringify((() => {
        const nav = performance.getEntriesByType("navigation")[0];
        const state = globalThis.__zeroproxyGatePerformance;
        return {
          duration_ms: nav?.duration,
          transfer_bytes: nav?.transferSize,
          dcl_ms: nav ? nav.domContentLoadedEventEnd - nav.startTime : null,
          time_origin_s: performance.timeOrigin / 1000,
          inp_ms: state?.inp_ms,
          interaction_count: state?.interaction_count,
          observer_error: globalThis.__zeroproxyGatePerformanceObserverError ?? null,
        };
      })())`);
      let metrics;
      try { metrics = JSON.parse(pageMetrics); } catch { throw new GateFailure("browser measurement page returned invalid metric JSON", "measurement_unavailable"); }
      invariant(metrics.observer_error === null, `browser page did not support performance observers: ${metrics.observer_error}`, "measurement_unavailable");
      invariant(Number.isInteger(metrics.interaction_count) && metrics.interaction_count > 0, "browser measurement observed no trusted INP interaction", "measurement_unavailable");
      const lcpMs = Number(page.lcp_times
        .filter(value => value >= metrics.time_origin_s)
        .reduce((maximum, value) => Math.max(maximum, (value - metrics.time_origin_s) * 1000), 0)
        .toFixed(6));
      invariant(lcpMs > 0, "browser measurement observed no largest contentful paint", "measurement_unavailable");
      const heap = await this.cdp.command("Runtime.getHeapUsage", {}, page.sessionId);
      const performanceMetrics = await this.cdp.command("Performance.getMetrics", {}, page.sessionId);
      const taskDuration = performanceMetrics.metrics.find(metric => metric.name === "TaskDuration")?.value;
      const duration = finiteMetric(metrics.duration_ms, "navigation duration");
      const transferBytes = finiteMetric(metrics.transfer_bytes, "navigation transfer bytes");
      const value = gate.endsWith("throughput_mib_s")
        ? (transferBytes / 1_048_576) / (duration / 1000)
        : gate === "warm_asset_transfer_bytes" ? transferBytes : duration;
      return {
        value: finiteMetric(value, "gate value"),
        memory_bytes: finiteMetric(heap.usedSize, "JavaScript heap usage"),
        queue_depth: finiteMetric(page.pending_requests.size, "CDP-observed in-flight request count"),
        site_metrics: {
          dcl_ms: finiteMetric(metrics.dcl_ms, "DOMContentLoaded"),
          lcp_ms: finiteMetric(lcpMs, "largest contentful paint"),
          inp_ms: finiteMetric(metrics.inp_ms, "interaction to next paint"),
          cpu_ms: finiteMetric((taskDuration - beforeTaskDuration) * 1000, "main-thread task duration"),
        },
      };
    } finally {
      await this.closePage(page);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.cdp.close();
    if (this.child.exitCode === null && !this.child.killed) this.child.kill("SIGTERM");
    const exited = await Promise.race([this.childExit, sleep(2_000).then(() => null)]);
    if (exited === null && this.child.exitCode === null) {
      this.child.kill("SIGKILL");
      await Promise.race([this.childExit, sleep(2_000)]);
    }
    await rm(this.directory, { recursive: true, force: true });
  }
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.once("error", reject);
    stream.on("data", chunk => hash.update(chunk));
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

export async function verifyServedBuild(build, proofUrl) {
  const response = await fetch(proofUrl, { redirect: "error", signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS) }).catch(error => {
    throw new GateFailure(`cannot retrieve server build proof ${proofUrl}: ${error.message}`, "build_proof_unavailable");
  });
  invariant(response.ok, `server build proof returned HTTP ${response.status}`, "build_proof_unavailable");
  let proof;
  try { proof = await response.json(); } catch (error) { throw new GateFailure(`server build proof is not JSON: ${error.message}`, "build_proof_unavailable"); }
  invariant(proof && proof.build_tree_sha256 === build.tree_sha256, "server build proof does not match hashed current build", "build_proof_mismatch");
  return { url: proofUrl, build_tree_sha256: proof.build_tree_sha256, response_sha256: canonicalDigest(proof) };
}

export function chromiumBrowserLane(config) {
  const lanes = config?.browser_lanes?.filter(lane => lane.family === "chromium" && lane.availability === "available") ?? [];
  invariant(lanes.length === 1, "exactly one available Chromium browser lane is required", "browser_pin_missing");
  return lanes[0];
}

export function browserEvidenceLaunchOptions(context) {
  return {
    build: context.build,
    expectedBrowserLane: chromiumBrowserLane(context.config),
    testMode: context.test_mode === true,
  };
}

async function verifyBrowserExecutable(browserExecutable, expectedBrowserLane) {
  invariant(expectedBrowserLane?.availability === "available"
    && typeof expectedBrowserLane.binary_sha256 === "string"
    && /^[a-f0-9]{64}$/u.test(expectedBrowserLane.binary_sha256),
  "an available browser lane with a binary digest is required", "browser_pin_missing");
  const digest = await hashFile(browserExecutable);
  invariant(digest === expectedBrowserLane.binary_sha256, "browser executable digest does not match performance-gates.json", "browser_pin_mismatch");
  return digest;
}

export function browserProxyArguments(environment, testMode) {
  const value = environment.ZEROPROXY_GATE_TEST_PROXY_URL;
  if (value === undefined) return [];
  invariant(testMode, "ZEROPROXY_GATE_TEST_PROXY_URL is forbidden for certifying browser evidence", "evidence_prerequisite_invalid");
  let proxy;
  try {
    proxy = new URL(value);
  } catch {
    throw new GateFailure("ZEROPROXY_GATE_TEST_PROXY_URL must be an absolute loopback HTTP URL", "evidence_prerequisite_invalid");
  }
  invariant(proxy.protocol === "http:"
    && (proxy.hostname === "127.0.0.1" || proxy.hostname === "[::1]")
    && proxy.port !== ""
    && proxy.username === "" && proxy.password === ""
    && proxy.pathname === "/" && proxy.search === "" && proxy.hash === "",
  "ZEROPROXY_GATE_TEST_PROXY_URL must be an origin-only loopback HTTP URL", "evidence_prerequisite_invalid");
  return [`--proxy-server=${proxy.origin}`, "--proxy-bypass-list=<-loopback>"];
}
export function browserTestCertificateArguments(environment, testMode) {
  const value = environment.ZEROPROXY_GATE_TEST_CERT_SPKI;
  if (value === undefined) return [];
  invariant(testMode, "ZEROPROXY_GATE_TEST_CERT_SPKI is forbidden for certifying browser evidence", "evidence_prerequisite_invalid");
  invariant(/^[A-Za-z0-9+/]{43}=$/u.test(value), "ZEROPROXY_GATE_TEST_CERT_SPKI must be one canonical SHA-256 SPKI pin", "evidence_prerequisite_invalid");
  return [`--ignore-certificate-errors-spki-list=${value}`];
}


export async function startBrowserEvidence({ build, expectedBrowserLane, environment = process.env, testMode = false }) {
  const browserExecutable = requiredEnvironment("ZEROPROXY_GATE_BROWSER_BIN", environment);
  const buildProofUrl = requiredEnvironment("ZEROPROXY_GATE_BUILD_PROOF_URL", environment);
  const browserBinarySha256 = await verifyBrowserExecutable(browserExecutable, expectedBrowserLane);
  const buildProof = await verifyServedBuild(build, buildProofUrl);
  const port = await freeLoopbackPort();
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeroproxy-gate-browser-"));
  const browserArguments = [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-networking",
    "--disable-client-side-phishing-detection",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-domain-reliability",
    "--disable-sync",
    "--disable-features=DnsOverHttpsUpgrade,OptimizationHints,MediaRouter,AutofillServerCommunication,CertificateTransparencyComponentUpdater",
    "--disable-quic",
    "--metrics-recording-only",
    "--no-pings",
    "--safebrowsing-disable-auto-update",
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${directory}`,
    ...browserProxyArguments(environment, testMode),
    ...browserTestCertificateArguments(environment, testMode),
    "about:blank",
  ];
  const child = spawn(browserExecutable, browserArguments, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let launchError = null;
  child.once("error", error => { launchError = error; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  const childExit = waitForChildExit(child);
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let version;
  try {
    while (Date.now() < deadline) {
      if (launchError) throw new GateFailure(`cannot launch browser ${browserExecutable}: ${launchError.message}`, "browser_unavailable");
      if (child.exitCode !== null) throw new GateFailure(`browser exited before DevTools was available: ${stderr}`, "browser_unavailable");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
        if (response.ok) {
          version = await response.json();
          break;
        }
      } catch { /* Poll while Chromium brings up DevTools. */ }
      await sleep(50);
    }
    invariant(version?.webSocketDebuggerUrl && typeof version.Browser === "string", `browser DevTools was unavailable: ${stderr}`, "browser_unavailable");
    const cdp = new CdpConnection(version.webSocketDebuggerUrl);
    await cdp.open();
    const browserVersion = await cdp.command("Browser.getVersion");
    const browser = browserIdentity(browserVersion.product);
    invariant(browser.family === expectedBrowserLane.family && browser.exact_build === expectedBrowserLane.exact_build, "launched browser identity does not match the configured browser lane", "browser_pin_mismatch");
    browser.binary_sha256 = browserBinarySha256;
    return new BrowserEvidenceSession({ child, childExit, cdp, directory, browser, browserVersion, buildProof });
  } catch (error) {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export { requiredEnvironment };
