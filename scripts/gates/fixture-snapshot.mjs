import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { GateFailure, canonicalDigest, collectBuildIdentity, invariant, sha256 } from "./common.mjs";

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"], [".htm", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"], [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"], [".json", "application/json"],
  [".svg", "image/svg+xml"], [".png", "image/png"], [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"],
  [".avif", "image/avif"], [".ico", "image/x-icon"], [".wasm", "application/wasm"],
  [".woff", "font/woff"], [".woff2", "font/woff2"], [".ttf", "font/ttf"],
  [".mp4", "video/mp4"], [".webm", "video/webm"], [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"], [".wav", "audio/wav"], [".xml", "application/xml"],
]);

export function safeRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && !path.isAbsolute(value)
    && !value.includes("\\")
    && !value.split("/").includes("..");
}

function contentType(relativePath) {
  return CONTENT_TYPES.get(path.extname(relativePath).toLowerCase()) ?? "application/octet-stream";
}

async function loadSnapshotAssets(fixturePath, identity, label) {
  const assets = new Map();
  for (const asset of identity.assets) {
    const bytes = await readFile(path.join(fixturePath, asset.path));
    invariant(sha256(bytes) === asset.sha256, `${label} changed while snapshotting`, "fixture_evidence_invalid");
    assets.set(asset.path, { bytes, content_type: contentType(asset.path) });
  }
  return assets;
}

export async function snapshotFixtureTree({ fixtureRoot, fixturePath, entryPath, expectedSha256, label }) {
  invariant(safeRelativePath(fixturePath), `${label} fixture path must be a safe relative path`, "fixture_evidence_invalid");
  invariant(safeRelativePath(entryPath), `${label} entry path must be a safe relative path`, "fixture_evidence_invalid");
  const root = path.resolve(fixtureRoot);
  const absoluteFixturePath = path.resolve(root, fixturePath);
  invariant(absoluteFixturePath.startsWith(`${root}${path.sep}`), `${label} fixture path escapes fixture root`, "fixture_evidence_invalid");
  const identity = await collectBuildIdentity(absoluteFixturePath);
  invariant(identity.tree_sha256 === expectedSha256, `${label} fixture digest does not match vendored bytes`, "fixture_evidence_invalid");
  const assets = await loadSnapshotAssets(absoluteFixturePath, identity, label);
  invariant(assets.has(entryPath), `${label} entry path is absent from the verified fixture`, "fixture_evidence_invalid");
  return Object.freeze({
    assets,
    report: Object.freeze({
      status: "verified",
      verified: true,
      tree_sha256: identity.tree_sha256,
      asset_count: identity.assets.length,
      served_from_snapshot: true,
      entry_path: entryPath,
    }),
  });
}

function requestAsset(requestUrl, snapshots) {
  const parts = decodeURIComponent(new URL(requestUrl, "http://fixture.invalid").pathname).split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "fixture") return null;
  return snapshots.get(parts[1])?.assets.get(parts.slice(2).join("/")) ?? null;
}

function handleRequest(request, response, snapshots) {
  try {
    const asset = requestAsset(request.url, snapshots);
    if (!asset) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-length": asset.bytes.byteLength,
      "content-type": asset.content_type,
      "x-content-type-options": "nosniff",
    });
    response.end(asset.bytes);
  } catch {
    response.writeHead(400).end();
  }
}

export function remoteFixtureUrl(baseUrl, id, relativePath) {
  invariant(safeRelativePath(relativePath), "remote fixture asset path must be safe", "fixture_evidence_invalid");
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new GateFailure("remote fixture base URL is invalid", "fixture_evidence_invalid");
  }
  invariant((base.protocol === "https:" || base.protocol === "http:") && base.username === "" && base.password === "" && base.search === "" && base.hash === "", "remote fixture base URL is invalid", "fixture_evidence_invalid");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const encodedPath = relativePath.split("/").map(encodeURIComponent).join("/");
  return new URL(`fixture/${encodeURIComponent(id)}/${encodedPath}`, base).href;
}

function immutableCacheHeader(value) {
  if (typeof value !== "string") return false;
  const directives = value.toLowerCase().split(",").map(part => part.trim());
  const maxAge = directives.find(directive => directive.startsWith("max-age="));
  const seconds = Number(maxAge?.slice("max-age=".length));
  return directives.includes("immutable") && Number.isInteger(seconds) && seconds >= 31_536_000;
}

export async function verifyRemoteFixtureOrigin({ snapshots, baseUrl, fetchImpl = fetch, requireHttps = true, requireImmutable = requireHttps }) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new GateFailure("remote fixture base URL is invalid", "fixture_evidence_invalid");
  }
  invariant(!requireHttps || parsed.protocol === "https:", "production mediated fixture origin must use HTTPS", "fixture_evidence_invalid");
  const assets = [];
  let immutableCache = true;
  const entries = [...snapshots.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [id, snapshot] of entries) {
    const snapshotAssets = [...snapshot.assets.entries()].sort(([left], [right]) => left.localeCompare(right));
    for (const [relativePath, asset] of snapshotAssets) {
      const url = remoteFixtureUrl(baseUrl, id, relativePath);
      let response;
      try {
        response = await fetchImpl(url, { cache: "no-store", redirect: "error" });
      } catch (error) {
        throw new GateFailure(`remote fixture asset ${id}/${relativePath} is unreachable: ${error.message}`, "fixture_evidence_invalid");
      }
      invariant(response.status === 200, `remote fixture asset ${id}/${relativePath} returned ${response.status}`, "fixture_evidence_invalid");
      invariant(response.headers.get("content-type") === asset.content_type, `remote fixture asset ${id}/${relativePath} has the wrong content type`, "fixture_evidence_invalid");
      const immutable = immutableCacheHeader(response.headers.get("cache-control"));
      invariant(!requireImmutable || immutable, `remote fixture asset ${id}/${relativePath} is not served with a one-year immutable cache policy`, "fixture_evidence_invalid");
      immutableCache = immutableCache && immutable;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const digest = sha256(bytes);
      invariant(digest === sha256(asset.bytes), `remote fixture asset ${id}/${relativePath} differs from the checked snapshot`, "fixture_evidence_invalid");
      assets.push({ id, path: relativePath, sha256: digest });
    }
  }
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return Object.freeze({
    status: "verified",
    verified: true,
    https: parsed.protocol === "https:",
    immutable_cache: immutableCache,
    base_url_sha256: canonicalDigest(parsed.href),
    asset_evidence_sha256: canonicalDigest(assets),
    asset_count: assets.length,
    urlFor(id, relativePath) { return remoteFixtureUrl(baseUrl, id, relativePath); },
  });
}

export async function startFixtureSnapshotServer(snapshots) {
  if (snapshots.size === 0) return Object.freeze({ origin: null, urlFor() { return null; }, async close() {} });
  const server = createServer((request, response) => handleRequest(request, response, snapshots));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  invariant(address && typeof address === "object", "fixture server did not bind an address", "fixture_evidence_invalid");
  const origin = `http://127.0.0.1:${address.port}`;
  return Object.freeze({
    origin,
    urlFor(id, entryPath) {
      const encodedPath = entryPath.split("/").map(encodeURIComponent).join("/");
      return `${origin}/fixture/${encodeURIComponent(id)}/${encodedPath}`;
    },
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  });
}
