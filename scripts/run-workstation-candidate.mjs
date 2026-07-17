import { spawn } from "node:child_process";
import { createHash, createPrivateKey, randomBytes, sign, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { canonicalDigest, canonicalJson, collectBuildIdentity, invariant, parseArgs, readJson } from "./gates/common.mjs";

const root = path.resolve(import.meta.dirname, "..");
const CONTROL_HOST = "control.zeroproxy.localhost";
const ASSET_HOST = "assets.zeroproxy.localhost";
const RELAY_HOST = "relay.zeroproxy.localhost";
const BROWSE_DOMAIN = "zeroproxy.localhost";

async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  invariant(address && typeof address === "object", "could not allocate a workstation port");
  return address.port;
}

function runCommand(executable, args, { input = null, environment = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", code => {
      const output = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (code === 0) resolve(output);
      else reject(new Error(`${executable} exited ${code}: ${output.stderr.toString("utf8")}`));
    });
    if (input === null) child.stdin.end();
    else child.stdin.end(input);
  });
}

function processRecord(child) {
  const record = {
    child,
    exited: new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal }))),
    output: "",
  };
  const capture = chunk => {
    record.output += String(chunk);
    if (record.output.length > 16_384) record.output = record.output.slice(-16_384);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return record;
}

async function terminateProcess(record) {
  if (!record) return;
  if (record.child.exitCode === null && !record.child.killed) record.child.kill("SIGTERM");
  const result = await Promise.race([
    record.exited,
    new Promise(resolve => setTimeout(() => resolve(null), 5_000)),
  ]);
  if (result === null && record.child.exitCode === null) {
    record.child.kill("SIGKILL");
    await record.exited;
  }
}

function waitForOutput(record, predicate, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`${label} readiness timed out: ${output.slice(-4000)}`)), timeoutMs);
    const inspect = chunk => {
      output += chunk;
      if (!predicate(output)) return;
      clearTimeout(timeout);
      resolve(output);
    };
    record.child.stdout.setEncoding("utf8");
    record.child.stderr.setEncoding("utf8");
    record.child.stdout.on("data", inspect);
    record.child.stderr.on("data", inspect);
    record.child.once("error", error => { clearTimeout(timeout); reject(error); });
    record.child.once("close", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`${label} exited before readiness code=${code} signal=${signal}: ${output.slice(-4000)}`));
    });
  });
}

async function waitForPort(port, record, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (record.child.exitCode !== null) throw new Error(`${label} exited before opening port ${port}: ${record.output.slice(-4000)}`);
    const connected = await new Promise(resolve => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${label} did not open port ${port}`);
}

async function generateCertificate(directory) {
  const key = path.join(directory, "candidate-key.pem");
  const certificate = path.join(directory, "candidate-cert.pem");
  await runCommand("/usr/bin/openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", certificate, "-subj", `/CN=${CONTROL_HOST}`,
    "-addext", `subjectAltName=DNS:${CONTROL_HOST},DNS:${ASSET_HOST},DNS:${RELAY_HOST},DNS:*.browse.${BROWSE_DOMAIN}`,
  ]);
  const parsed = new X509Certificate(await readFile(certificate));
  const publicKey = parsed.publicKey.export({ format: "der", type: "spki" });
  const spki = createHash("sha256").update(publicKey).digest("base64");
  return { key, certificate, spki };
}
async function writeWorkstationRelayProfile(directory, serverPort) {
  const profileDirectory = path.join(root, "protocol/relay-profiles");
  const templates = (await readdir(profileDirectory)).filter(name => name.endsWith(".json"));
  invariant(templates.length === 1, "workstation candidate requires exactly one checked relay profile template");
  const template = JSON.parse(await readFile(path.join(profileDirectory, templates[0]), "utf8"));
  const profile = {
    ...template,
    allowed_browse_domain: BROWSE_DOMAIN,
    display_name: "ZeroProxy workstation relay",
    profile_id: "zeroproxy-workstation-relay",
    relay_wss_origin: `wss://${RELAY_HOST}:${serverPort}`,
  };
  const canonical = canonicalJson(profile).slice(0, -1);
  const digest = createHash("sha256").update(canonical).digest("hex");
  const profilePath = path.join(directory, `${digest}.json`);
  const signaturesPath = path.join(directory, `${digest}.sig`);
  const keys = JSON.parse(await readFile(path.join(root, "protocol/release-signing-keys.json"), "utf8"));
  invariant(keys.development_only === true && keys.threshold === 2 && keys.keys.length === 2, "workstation relay requires the checked development trust set");
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const bytes = Buffer.from(canonical);
  const signatures = {
    algorithm: "Ed25519",
    canonicalization: "RFC8785",
    key_epoch: keys.key_epoch,
    development_only: true,
    signatures: keys.keys.map(key => {
      invariant(key.owner.endsWith("-fixture"), `workstation relay refuses non-fixture key ${key.id}`);
      const seed = createHash("sha256").update(`zeroproxy-development-only-ed25519-fixture:${key.id}`).digest();
      const privateKey = createPrivateKey({ key: Buffer.concat([prefix, seed]), format: "der", type: "pkcs8" });
      return { key_id: key.id, signature: sign(null, bytes, privateKey).toString("base64url") };
    }),
  };
  await Promise.all([
    writeFile(profilePath, canonical, { mode: 0o600 }),
    writeFile(signaturesPath, canonicalJson(signatures), { mode: 0o600 }),
  ]);
  return { profilePath, signaturesPath };
}


function startProofServer(buildTreeSha256) {
  const server = http.createServer((request, response) => {
    if (request.url !== "/build-proof.json") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json");
    response.end(canonicalJson({ build_tree_sha256: buildTreeSha256 }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      invariant(address && typeof address === "object", "build proof server did not bind");
      resolve({ server, url: `http://127.0.0.1:${address.port}/build-proof.json` });
    });
  });
}

async function verifyCandidateBuildProof(port, certificate, expectedDigest) {
  const ca = await readFile(certificate);
  const value = await new Promise((resolve, reject) => {
    const request = https.request({
      hostname: "127.0.0.1",
      port,
      path: "/control/build-proof.json",
      method: "GET",
      servername: CONTROL_HOST,
      ca,
      rejectUnauthorized: true,
      headers: { Host: `${CONTROL_HOST}:${port}` },
    }, response => {
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.byteLength;
        if (size > 4096) {
          request.destroy(new Error("candidate build proof exceeded 4096 bytes"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        try {
          invariant(response.statusCode === 200, `candidate build proof returned HTTP ${response.statusCode}`);
          invariant(response.headers["cache-control"] === "no-store", "candidate build proof is cacheable");
          invariant(response.headers["content-type"]?.startsWith("application/json"), "candidate build proof is not JSON");
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error("candidate build proof timed out")));
    request.once("error", reject);
    request.end();
  });
  invariant(value && Object.keys(value).length === 1 && value.build_tree_sha256 === expectedDigest, "running candidate build proof does not match the current build");
  return value;
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function waitForSignal() {
  return new Promise(resolve => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

function usage() {
  return "Usage: node scripts/run-workstation-candidate.mjs --ready <new-readiness.json>";
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ["help"], values: ["ready"] });
  invariant(args._.length === 0, "unexpected positional arguments");
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  invariant(typeof args.ready === "string" && args.ready.length > 0, "--ready is required");
  const readyPath = path.resolve(args.ready);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "zeroproxy-workstation-candidate-"));
  let tor;
  let candidate;
  let proof;
  try {
    await runCommand(process.execPath, [path.join(root, "scripts/build.mjs")], { environment: { ...process.env, GOTOOLCHAIN: "go1.26.3" } });
    const build = await collectBuildIdentity(path.join(root, "dist"));
    const config = (await readJson(path.join(root, "protocol/performance-gates.json"))).value;
    const toolchains = (await readJson(path.join(root, "protocol/toolchains.json"))).value;
    const torToolchain = toolchains.tools.find(toolchain => toolchain.name === "tor");
    invariant(torToolchain?.path, "the pinned Tor toolchain is unavailable");
    const [serverPort, socksPort] = await Promise.all([freeLoopbackPort(), freeLoopbackPort()]);
    const httpPort = await freeLoopbackPort();
    const tls = await generateCertificate(temporary);
    const relayProfile = await writeWorkstationRelayProfile(temporary, serverPort);
    const torData = path.join(temporary, "tor");
    tor = processRecord(spawn(torToolchain.path, [
      "--ClientOnly", "1",
      "--DataDirectory", torData,
      "--SocksPort", `127.0.0.1:${socksPort}`,
      "--Log", "notice stdout",
    ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }));
    await waitForOutput(tor, output => output.includes("Bootstrapped 100%"), "Tor", 180_000);
    const serverConfig = {
      Listen: `127.0.0.1:${serverPort}`,
      HTTPListen: `127.0.0.1:${httpPort}`,
      TLSCert: tls.certificate,
      TLSKey: tls.key,
      ControlHost: `${CONTROL_HOST}:${serverPort}`,
      AssetHost: `${ASSET_HOST}:${serverPort}`,
      RelayHost: `${RELAY_HOST}:${serverPort}`,
      BrowseDomain: BROWSE_DOMAIN,
      TorSOCKS: `127.0.0.1:${socksPort}`,
      StaticDir: path.join(root, "dist/web"),
      BuildTreeSHA256: build.tree_sha256,
      DeploymentSalt: randomBytes(32).toString("base64url"),
      ReplayLedgerPath: path.join(temporary, "replay-ledger.json"),
      RelayProfile: relayProfile.profilePath,
      RelayProfileSignatures: relayProfile.signaturesPath,
      ReleaseSigningKeys: path.join(root, "protocol/release-signing-keys.json"),
      MigrationDisposition: path.join(root, "protocol/v1-migration-disposition.json"),
      MigrationSignatures: path.join(root, "protocol/v1-migration-disposition.sig"),
      CompatibilityDeltas: path.join(root, "protocol/compatibility-deltas.json"),
      CompatibilitySignatures: path.join(root, "protocol/compatibility-deltas.sig"),
      DevelopmentMode: true,
      AllowAnonymousCapabilities: true,
      Capabilities: [],
    };
    const configPath = path.join(temporary, "server.json");
    await writeFile(configPath, canonicalJson(serverConfig), { mode: 0o600 });
    candidate = processRecord(spawn(path.join(root, "dist/zeroproxy-server"), ["-config", configPath], {
      cwd: root,
      env: { ...process.env, ZEROPROXY_DEVELOPMENT_DIAGNOSTICS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }));
    await waitForPort(serverPort, candidate, "ZeroProxy candidate");
    const candidateBuildProof = await verifyCandidateBuildProof(serverPort, tls.certificate, build.tree_sha256);
    proof = await startProofServer(candidateBuildProof.build_tree_sha256);
    const readiness = {
      schema_version: 1,
      test_mode: true,
      certification_claimed: false,
      control_url: `https://${CONTROL_HOST}:${serverPort}/`,
      build_proof_url: proof.url,
      candidate_build_proof_url: `https://${CONTROL_HOST}:${serverPort}/control/build-proof.json`,
      candidate_build_proof_sha256: canonicalDigest(candidateBuildProof),
      browser_binary: config.browser_lanes[0].binary_path,
      browser_test_certificate_spki: tls.spki,
      candidate_endpoints: [
        `${CONTROL_HOST}:${serverPort}`,
        `${ASSET_HOST}:${serverPort}`,
        `${RELAY_HOST}:${serverPort}`,
      ],
      build_tree_sha256: build.tree_sha256,
      limitations: ["development-only signatures", "test-only certificate pin", "no packet capture certification", "no V1 comparison"],
    };
    await writeFile(readyPath, canonicalJson(readiness), { encoding: "utf8", mode: 0o600, flag: "wx" });
    process.stdout.write(canonicalJson(readiness));
    await waitForSignal();
  } finally {
    await closeServer(proof?.server);
    await terminateProcess(candidate);
    await terminateProcess(tor);
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(readyPath, { force: true });
  }
}

main().catch(error => {
  process.stderr.write(`workstation candidate failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
