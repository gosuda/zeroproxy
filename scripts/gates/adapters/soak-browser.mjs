import { spawn } from "node:child_process";
import { GateFailure, readJson, canonicalDigest, invariant, validateJsonSchema } from "../common.mjs";
import { browserEvidenceLaunchOptions, requiredEnvironment, startBrowserEvidence } from "./browser-evidence.mjs";

function validUrl(value) {
  return typeof value === "string" && /^https?:\/\//.test(value);
}
function validDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function validWebSocketUrl(value) {
  return typeof value === "string" && /^wss?:\/\//.test(value);
}

function networkOrigin(value) {
  const url = new URL(value);
  if (url.protocol === "ws:") return `http://${url.host}`;
  if (url.protocol === "wss:") return `https://${url.host}`;
  return url.origin;
}

function validateManifest(manifest, config) {
  invariant(manifest && manifest.schema_version === 1 && manifest.release_id === config.release_id, "soak workload manifest must have schema_version 1 and match the release", "evidence_prerequisite_missing");
  invariant(Array.isArray(manifest.origins) && manifest.origins.length === config.soak.origins, `soak workload manifest must enumerate exactly ${config.soak.origins} origins`, "evidence_prerequisite_missing");
  invariant(validUrl(manifest.telemetry_url), "soak workload manifest requires an absolute telemetry_url", "evidence_prerequisite_missing");
  invariant(validUrl(manifest.workload_provenance_url), "soak workload manifest requires an absolute workload_provenance_url", "evidence_prerequisite_missing");
  invariant(new URL(manifest.telemetry_url).origin === new URL(manifest.workload_provenance_url).origin, "soak telemetry and workload provenance must share an authenticated origin", "evidence_prerequisite_missing");
  invariant(validDigest(manifest.workload_server_sha256), "soak workload manifest requires a server artifact digest", "evidence_prerequisite_missing");
  invariant(manifest.fault_driver && typeof manifest.fault_driver.command === "string" && Array.isArray(manifest.fault_driver.args), "soak workload manifest requires a non-shell fault_driver command and args", "evidence_prerequisite_missing");
  const ids = new Set();
  const pageOrigins = new Set();
  for (const origin of manifest.origins) {
    invariant(origin && typeof origin.id === "string" && origin.id.length > 0 && !ids.has(origin.id), "soak origin ids must be unique", "evidence_prerequisite_missing");
    ids.add(origin.id);
    invariant(validDigest(origin.fixture_sha256), `soak origin ${origin.id} requires a fixture digest`, "evidence_prerequisite_missing");
    for (const field of ["page_url", "short_stream_url", "sse_url"])
      invariant(validUrl(origin[field]), `soak origin ${origin.id} requires absolute ${field}`, "evidence_prerequisite_missing");
    invariant(validWebSocketUrl(origin.websocket_url), `soak origin ${origin.id} requires an absolute websocket_url`, "evidence_prerequisite_missing");
    const pageOrigin = networkOrigin(origin.page_url);
    pageOrigins.add(pageOrigin);
    for (const field of ["short_stream_url", "sse_url", "websocket_url"])
      invariant(networkOrigin(origin[field]) === pageOrigin, `soak origin ${origin.id} ${field} must share its page origin`, "evidence_prerequisite_missing");
  }
  invariant(pageOrigins.size === manifest.origins.length, "soak workload must use a distinct origin for every configured origin", "evidence_prerequisite_missing");
  return manifest;
}

async function runFaultDriver(driver, { kind, phase }) {
  const args = driver.args.map(argument => String(argument).replaceAll("{kind}", kind).replaceAll("{phase}", phase));
  return new Promise((resolve, reject) => {
    const child = spawn(driver.command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => reject(new Error(`fault driver could not start: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (code !== 0) reject(new Error(`fault driver failed with ${code ?? signal}: ${stderr}`));
      else resolve({ command_sha256: canonicalDigest({ command: driver.command, args }), stdout_sha256: canonicalDigest(stdout), stderr_sha256: canonicalDigest(stderr) });
    });
  });
}

async function startEventSource(browser, page, url) {
  const expression = `new Promise((resolve, reject) => {
    const source = new EventSource(${JSON.stringify(url)});
    const timeout = setTimeout(() => { source.close(); reject(new Error("SSE open timeout")); }, 10000);
    source.addEventListener("open", () => { clearTimeout(timeout); globalThis.__zeroproxyGateSse = source; resolve(true); }, { once: true });
    source.addEventListener("error", () => { clearTimeout(timeout); source.close(); reject(new Error("SSE failed")); }, { once: true });
  })`;
  invariant(await browser.evaluate(page, expression) === true, `SSE did not open for ${url}`, "measurement_unavailable");
}

async function startWebSocket(browser, page, url) {
  const expression = `new Promise((resolve, reject) => {
    const socket = new WebSocket(${JSON.stringify(url)});
    const timeout = setTimeout(() => { socket.close(); reject(new Error("WebSocket open timeout")); }, 10000);
    socket.addEventListener("open", () => { clearTimeout(timeout); globalThis.__zeroproxyGateWebSocket = socket; resolve(true); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timeout); socket.close(); reject(new Error("WebSocket failed")); }, { once: true });
  })`;
  invariant(await browser.evaluate(page, expression) === true, `WebSocket did not open for ${url}`, "measurement_unavailable");
}

async function fetchShortStream(browser, page, url) {
  const expression = `fetch(${JSON.stringify(url)}, { cache: "no-store", credentials: "include" }).then(async response => {
    await response.arrayBuffer();
    if (!response.ok) throw new Error("short stream HTTP " + response.status);
    return true;
  })`;
  invariant(await browser.evaluate(page, expression) === true, `short stream did not complete for ${url}`, "measurement_unavailable");
}

async function readWorkloadProvenance(manifest, context, token, schema, manifestSha256) {
  let response;
  try {
    response = await fetch(manifest.workload_provenance_url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new GateFailure(`soak workload provenance unavailable: ${error.message}`, "measurement_unavailable");
  }
  invariant(response.ok, `soak workload provenance returned HTTP ${response.status}`, "measurement_unavailable");
  const provenance = await response.json();
  const validation = validateJsonSchema(provenance, schema.value);
  invariant(validation.valid, `soak workload provenance schema validation failed: ${validation.errors.join("; ")}`, "measurement_unavailable");
  invariant(provenance.release_id === context.config.release_id
    && provenance.build_tree_sha256 === context.build.tree_sha256
    && provenance.manifest_sha256 === manifestSha256
    && provenance.workload_server_sha256 === manifest.workload_server_sha256,
  "soak workload provenance release/build/manifest/server identity mismatch", "measurement_unavailable");
  const expectedOrigins = [...manifest.origins].map(origin => ({ id: origin.id, origin: networkOrigin(origin.page_url), fixture_sha256: origin.fixture_sha256 })).sort((left, right) => left.id.localeCompare(right.id));
  const observedOrigins = [...provenance.origins].sort((left, right) => left.id.localeCompare(right.id));
  invariant(JSON.stringify(observedOrigins) === JSON.stringify(expectedOrigins), "soak workload provenance origin fixture coverage mismatch", "measurement_unavailable");
  return provenance;
}

async function readTelemetry(manifest, context, token, telemetrySchema) {
  const response = await fetch(manifest.telemetry_url, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(error => {
    throw new GateFailure(`soak telemetry request failed: ${error.message}`, "measurement_unavailable");
  });
  invariant(response.ok, `soak telemetry returned HTTP ${response.status}`, "measurement_unavailable");
  const telemetry = await response.json().catch(error => {
    throw new GateFailure(`soak telemetry returned invalid JSON: ${error.message}`, "measurement_unavailable");
  });
  const schemaResult = validateJsonSchema(telemetry, telemetrySchema.value);
  invariant(schemaResult.valid, `soak telemetry schema validation failed: ${schemaResult.errors.join("; ")}`, "measurement_unavailable");
  invariant(
    telemetry?.schema_version === 1
      && telemetry.release_id === context.config.release_id
      && telemetry.build_tree_sha256 === context.build.tree_sha256,
    "soak telemetry release/build identity mismatch",
    "measurement_unavailable",
  );
  return telemetry;
}

/**
 * Production adapter selected with --adapter scripts/gates/adapters/soak-browser.mjs.
 * Required environment: ZEROPROXY_GATE_BROWSER_BIN, ZEROPROXY_GATE_BUILD_PROOF_URL,
 * and ZEROPROXY_GATE_SOAK_MANIFEST plus ZEROPROXY_GATE_TELEMETRY_TOKEN. The
 * manifest supplies real origins/endpoints and a no-shell external fault driver;
 */
export async function createSoakEvidenceAdapter(context) {
  invariant(Number.isFinite(context.config.soak.max_memory_bytes) && Number.isFinite(context.config.soak.max_queue_depth), "performance-gates.json must configure soak memory and queue bounds before a real soak can start", "resource_limits_missing");
  const manifestPath = requiredEnvironment("ZEROPROXY_GATE_SOAK_MANIFEST");
  const manifestRecord = await readJson(manifestPath);
  const manifestSchema = await readJson(new URL("../../../protocol/soak-workload-manifest.schema.json", import.meta.url));
  const manifestValidation = validateJsonSchema(manifestRecord.value, manifestSchema.value);
  invariant(manifestValidation.valid, `soak workload manifest schema validation failed: ${manifestValidation.errors.join("; ")}`, "evidence_prerequisite_missing");
  const manifest = validateManifest(manifestRecord.value, context.config);
  const telemetryToken = requiredEnvironment("ZEROPROXY_GATE_TELEMETRY_TOKEN");
  const telemetrySchema = await readJson(new URL("../../../protocol/soak-telemetry.schema.json", import.meta.url));
  const provenanceSchema = await readJson(new URL("../../../protocol/soak-workload-provenance.schema.json", import.meta.url));
  const workloadProvenance = await readWorkloadProvenance(manifest, context, telemetryToken, provenanceSchema, manifestRecord.sha256);
  const browser = await startBrowserEvidence(browserEvidenceLaunchOptions(context));
  const clients = [];
  let started = false;
  let activeStreams = 0;

  async function openClient(origin, streamKind = null) {
    const page = await browser.createPage();
    await browser.navigate(page, origin.page_url);
    const client = { page, origin, streamKind };
    clients.push(client);
    return client;
  }

  async function closeClient(client) {
    const index = clients.indexOf(client);
    if (index >= 0) clients.splice(index, 1);
    if (client.streamKind !== null) activeStreams -= 1;
    await browser.closePage(client.page);
  }
  
  async function openOwnedStream(client) {
    if (client.streamKind === "sse") await startEventSource(browser, client.page, client.origin.sse_url);
    if (client.streamKind === "websocket") await startWebSocket(browser, client.page, client.origin.websocket_url);
    if (client.streamKind !== null) activeStreams += 1;
  }
  
  async function replaceClient(client) {
    const { origin, streamKind } = client;
    await closeClient(client);
    const replacement = await openClient(origin, streamKind);
    await openOwnedStream(replacement);
  }
  
  async function renavigateClient(client) {
    if (client.streamKind !== null) activeStreams -= 1;
    await browser.navigate(client.page, client.origin.page_url);
    await openOwnedStream(client);
  }
  
  async function shortStreamBurst(count) {
    await Promise.all(Array.from({ length: count }, (_, index) => {
      const client = clients[index % clients.length];
      return fetchShortStream(browser, client.page, client.origin.short_stream_url);
    }));
  }

  return {
    async describe() {
      return {
        browser: browser.browser,
        toolchain: {
          kind: "chromium-cdp-browser-soak-v1",
          browser_product: browser.browserVersion.product,
          build_proof: browser.buildProof,
          soak_manifest: manifestPath,
          fault_driver_sha256: canonicalDigest(manifest.fault_driver),
          telemetry_schema_sha256: telemetrySchema.sha256,
          soak_manifest_sha256: manifestRecord.sha256,
          workload_provenance_schema_sha256: provenanceSchema.sha256,
          workload_provenance_sha256: canonicalDigest(workloadProvenance),
          workload_server_sha256: workloadProvenance.workload_server_sha256,
          workload_origin_count: workloadProvenance.origins.length,
          workload_origins_sha256: canonicalDigest([...workloadProvenance.origins].sort((left, right) => left.id.localeCompare(right.id))),
        },
      };
    },
    async start({ shape, seed }) {
      invariant(!started, "soak adapter cannot start twice", "adapter_invalid");
      invariant(shape.clients === context.config.soak.clients && shape.origins === context.config.soak.origins, "soak runner supplied an unexpected production shape", "adapter_invalid");
      for (let index = 0; index < shape.clients; index += 1)
        await openClient(manifest.origins[index % manifest.origins.length]);
      await shortStreamBurst(shape.short_streams);
      for (let index = 0; index < shape.sse_streams; index += 1)
        clients[index].streamKind = "sse";
      for (let index = 0; index < shape.websockets; index += 1)
        clients[shape.sse_streams + index].streamKind = "websocket";
      await Promise.all(clients.filter(client => client.streamKind !== null).map(openOwnedStream));
      started = true;
      return { status: "started", details: { client_count: clients.length, seed } };
    },
    async sample() {
      invariant(started, "soak sample called before workload start", "adapter_invalid");
      const observations = await Promise.all(clients.map(async client => {
        const heap = await browser.cdp.command("Runtime.getHeapUsage", {}, client.page.sessionId);
        return { heap: heap.usedSize, queueDepth: client.page.pending_requests.size };
      }));
      const telemetry = await readTelemetry(manifest, context, telemetryToken, telemetrySchema);
      return {
        ...telemetry,
        queue_depth: telemetry.queue_depth + observations.reduce((sum, observation) => sum + observation.queueDepth, 0),
        active_clients: clients.length,
        active_origins: new Set(clients.map(client => client.origin.id)).size,
        active_streams: activeStreams,
        browser_heap_bytes: observations.reduce((sum, observation) => sum + observation.heap, 0),
      };
    },
    async churn({ abort_fraction }) {
      invariant(started, "soak churn called before workload start", "adapter_invalid");
      const count = Math.max(1, Math.round(clients.length * abort_fraction));
      await Promise.all(clients.slice(0, count).map(replaceClient));
      const navigationClients = manifest.origins.flatMap(origin =>
        clients.filter(client => client.origin.id === origin.id).slice(0, context.config.soak.navigations_per_origin_per_minute));
      await Promise.all(navigationClients.map(renavigateClient));
      await shortStreamBurst(context.config.soak.short_streams);
      return { status: "completed", details: { aborted_clients: count, navigations: navigationClients.length, active_clients: clients.length } };
    },
    async injectFault({ kind, phase }) {
      invariant(started, "soak fault injection called before workload start", "adapter_invalid");
      const proof = await runFaultDriver(manifest.fault_driver, { kind, phase });
      return { status: "injected", details: { kind, ...proof } };
    },
    async quiesce() {
      for (const client of [...clients]) {
        await browser.evaluate(client.page, "globalThis.__zeroproxyGateSse?.close(); globalThis.__zeroproxyGateWebSocket?.close(); true");
        await closeClient(client);
      }
      invariant(activeStreams === 0, "soak stream accounting did not quiesce", "measurement_unavailable");
      return { status: "quiescing", details: { remaining_clients: clients.length } };
    },
    async terminalState() {
      const telemetry = await readTelemetry(manifest, context, telemetryToken, telemetrySchema);
      const ownedCountsZero = ["route", "port", "stream", "worker", "realm"].every(owner => telemetry[`${owner}_count`] === 0);
      return {
        ...telemetry,
        all_terminal: clients.length === 0 && activeStreams === 0 && telemetry.outstanding_requests === 0 && ownedCountsZero,
        active_streams: activeStreams,
      };
    },
    async close() {
      for (const client of [...clients]) await closeClient(client);
      activeStreams = 0;
      await browser.close();
    },
  };
}

export { validateManifest as validateSoakWorkloadManifest };
