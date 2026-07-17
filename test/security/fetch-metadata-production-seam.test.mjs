import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createBoundedRewriteCache } from "../../web/compiler-cache.mjs";

const root = path.resolve(import.meta.dirname, "../..");

async function loadFetchMetadataSeam() {
  const source = (await readFile(path.join(root, "web/sw/sw.mjs"), "utf8")).replace(/^(?:import [^\n]*;\n)+/, "");
  const context = {
    createBoundedRewriteCache,
    DOMException,
    Headers,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    clearTimeout,
    crypto: globalThis.crypto,
    setTimeout,
    structuredClone,
    self: {
      addEventListener() {},
      clients: { claim: async () => {}, matchAll: async () => [] },
      location: { hostname: "o-origin-a.browse.test", origin: "https://o-origin-a.browse.test" },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(`${source}
    globalThis.__targetHeaderSeam = (kind, value) => JSON.stringify(
      kind === "metadata" ? targetFetchMetadata(value)
        : kind === "seed" ? targetRequestHeaderSeed(value)
          : kind === "informational" ? validKernelInformational(value)
            : kind === "referrer" ? referrerForRequest(...value)
              : kind === "referrer-policy" ? redirectedReferrerPolicy(...value)
                : fetchSiteFloor(...value),
    );`, context, { filename: "web/sw/sw.mjs" });
  const invoke = (kind, value) => JSON.parse(context.__targetHeaderSeam(kind, value));
  return {
    floor: sites => invoke("floor", sites),
    informational: value => invoke("informational", value),
    metadata: route => invoke("metadata", route),
    referrer: values => invoke("referrer", values),
    referrerPolicy: values => invoke("referrer-policy", values),
    seed: route => invoke("seed", route),
  };
}

test("trusted routes synthesize Chrome fetch metadata by request class", async () => {
  const { metadata } = await loadFetchMetadataSeam();
  assert.deepEqual(metadata({ kind: "document", target_url: "https://target.example/" }), [
    ["Upgrade-Insecure-Requests", "1"],
    ["Sec-Fetch-Site", "none"],
    ["Sec-Fetch-Mode", "navigate"],
    ["Sec-Fetch-User", "?1"],
    ["Sec-Fetch-Dest", "document"],
    ["Priority", "u=0, i"],
  ]);
  assert.deepEqual(metadata({
    fetch_destination: "iframe",
    kind: "navigation",
    source_url: "https://target.example/page",
    target_url: "https://target.example/frame",
  }), [
    ["Upgrade-Insecure-Requests", "1"],
    ["Sec-Fetch-Site", "same-origin"],
    ["Sec-Fetch-Mode", "navigate"],
    ["Sec-Fetch-Dest", "iframe"],
    ["Priority", "u=0, i"],
  ]);
  assert.deepEqual(metadata({
    kind: "api",
    priority: "high",
    request_mode: "cors",
    source_url: "https://source.example/",
    target_url: "https://target.invalid/data",
  }), [
    ["Sec-Fetch-Site", "cross-site"],
    ["Sec-Fetch-Mode", "cors"],
    ["Sec-Fetch-Dest", "empty"],
    ["Priority", "u=0"],
  ]);
  assert.deepEqual(metadata({
    fetch_destination: "image",
    kind: "resource",
    source_url: "https://target.example/page",
    target_url: "https://target.example:8443/image.png",
  }), [
    ["Sec-Fetch-Site", "same-site"],
    ["Sec-Fetch-Mode", "no-cors"],
    ["Sec-Fetch-Dest", "image"],
    ["Priority", "u=1"],
  ]);
});

test("network-owned request headers are replaced exactly once", async () => {
  const { seed } = await loadFetchMetadataSeam();
  const headers = seed({
    kind: "api",
    request_mode: "cors",
    source_url: "https://source.example/",
    target_url: "https://target.example/",
    request_headers: [
      ["Accept", "application/json"],
      ["sEc-FeTcH-sItE", "forged"],
      ["SEC-FETCH-MODE", "navigate"],
      ["Priority", "u=9"],
      ["Upgrade-Insecure-Requests", "forged"],
      ["User-Agent", "forged"],
      ["Accept-Encoding", "compress"],
      ["Sec-CH-UA", "forged"],
    ],
  });
  assert.deepEqual(headers, [["Accept", "application/json"]]);
});

test("redirect Fetch Metadata taint is monotonic across three hops", async () => {
  const { floor } = await loadFetchMetadataSeam();
  const first = floor(["same-origin"]);
  const second = floor([first, "cross-site"]);
  const third = floor([second, "same-site"]);
  assert.equal(first, "same-origin");
  assert.equal(second, "cross-site");
  assert.equal(third, "cross-site");
});

test("redirect referrers are recomputed under the effective response policy", async () => {
  const { referrer, referrerPolicy } = await loadFetchMetadataSeam();
  const source = "https://source.example/private/page?token=one#fragment";
  assert.equal(
    referrer([source, "https://source.example/next", "strict-origin-when-cross-origin"]),
    "https://source.example/private/page?token=one",
  );
  assert.equal(
    referrer([source, "https://cross.example/next", "strict-origin-when-cross-origin"]),
    "https://source.example/",
  );
  assert.equal(
    referrer([source, "http://cross.example/next", "strict-origin-when-cross-origin"]),
    "",
  );
  assert.equal(
    referrerPolicy([[["Referrer-Policy", "invalid, origin"], ["referrer-policy", "same-origin"]], "unsafe-url"]),
    "same-origin",
  );
});

test("kernel informational responses require exact bounded status and header records", async () => {
  const { informational } = await loadFetchMetadataSeam();
  assert.equal(informational([
    { status: 100, headers: [] },
    { status: 103, headers: [["Link", "</app.js>; rel=preload"]] },
  ]), true);
  assert.equal(informational([{ status: 200, headers: [] }]), false);
  assert.equal(informational([{ status: 103, headers: [], extra: true }]), false);
  assert.equal(informational(Array.from({ length: 17 }, () => ({ status: 103, headers: [] }))), false);
});
