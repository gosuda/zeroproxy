import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createBoundedRewriteCache } from "../../web/compiler-cache.mjs";
import { DISABLED_PERMISSIONS_POLICY_FEATURES } from "../../web/generated/emerging-network-capabilities.mjs";
import { crossOriginResourcePolicyAllows, documentTrustedTypesPolicyName, generateDocumentCSP, responseIsolationHeaders, xFrameOptionsAllows } from "../../web/sw/document-csp.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const disabledPermissionsPolicy = DISABLED_PERMISSIONS_POLICY_FEATURES
  .map(feature => `${feature}=()`)
  .join(", ");

function decodeBase64URL(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

async function loadCookieBootstrapSeam() {
  const source = (await readFile(path.join(root, "web/sw/sw.mjs"), "utf8")).replace(/^(?:import [^\n]*;\n)+/, "");
  const context = {
    POLICY_VERSION: 2,
    DOMException,
    Headers,
    ReadableStream,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    canonicalTarget: async value => ({ canonicalOrigin: new URL(value).origin, canonicalSite: new URL(value).origin }),
    createBoundedRewriteCache,
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
      location: {
        hostname: "o-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.browse.example.test",
        origin: "https://o-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.browse.example.test",
      },
    },
  };
  Object.assign(context, { crossOriginResourcePolicyAllows, documentTrustedTypesPolicyName, generateDocumentCSP, responseIsolationHeaders, xFrameOptionsAllows });
  context.globalThis = context;
  vm.runInNewContext(`${source}
    globalThis.__responseCookieBootstrap = async ({ securityHeaders = [], ancestorURLs = [] } = {}) => {
      originState = {
        capability_epoch: 1,
        destination_origin_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        destination_host: "o-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.browse.example.test",
        entry_id: "e".repeat(32),
        profile_id: "p".repeat(24),
        isolation_username: "U".repeat(43),
        isolation_password: "P".repeat(43),
        relay_profile_digests: ["A".repeat(43)],
        relay_profiles: [{ relay_wss_origin: "wss://relay.example.test", carrier_path: "/_zp/carrier", expires_at: "2099-01-01T00:00:00Z", allowed_target_ports: [80, 443] }],
        relay_capabilities: [{ relay_profile_digest: "A".repeat(43), allowed_target_ports: [80, 443], claims_digest: "c".repeat(64), relay_url: "wss://relay.example.test/_zp/carrier", expires_at: "2099-01-01T00:00:00Z" }],
        tab_id: "t".repeat(32),
        target_url: "https://target.example/",
      };
      cookieContext = { profile_id: originState.profile_id, origin_id: originState.destination_origin_id, tab_id: originState.tab_id, capability_epoch: 1 };
      cookieTopLevelSite = "https://target.example";
      cookieSequence = 0;
      const cookies = [];
      const mutations = [];
      let committedSequence = 0;
      coordinatorCall = async (operation, payload) => {
        if (operation === "COOKIE_MUTATE") {
          mutations.push({ header_index: payload.header_index, raw: payload.raw_set_cookie_or_document_cookie });
          committedSequence += 1;
          const [pair] = payload.raw_set_cookie_or_document_cookie.split(";");
          const separator = pair.indexOf("=");
          cookies.push({ name: pair.slice(0, separator), value: pair.slice(separator + 1), domain: "target.example", path: "/", secure: true, http_only: false, same_site: "LAX", creation_seq: committedSequence });
          return { cookie_seq: committedSequence };
        }
        if (operation === "COOKIE_SNAPSHOT_REQUEST") {
          return { cookie_seq: committedSequence, jar_or_delta: { kind: "SNAPSHOT", cookies } };
        }
        throw new Error(operation);
      };
      let runtimeURL = null;
      versionManifest = async () => ({ selectors: { "runtime-prelude.js": "/_zp/assets/${"a".repeat(64)}/runtime-prelude.js" } });
      decodeTargetSource = () => ({ text: "<!doctype html><html><head></head><body></body></html>", encoding_used: "utf-8", replacement: false, source: "transport" });
      rewriters = {
        html: {
          extract_meta_csp_json() { return "[]"; },
          extract_import_maps_json() { return "[]"; },
          rewrite_html(_source, _context, candidate) { runtimeURL = candidate; return "<!doctype html><html><body>rewritten</body></html>"; },
        },
        importMap: {
          import_map_register_json(existing) {
            return JSON.stringify({ version: 1, registered: existing.length === 0, handle: existing });
          },
        },
        policy: {
          canonicalize_json() { return JSON.stringify({ origin: "https://target.example", site: "https://target.example" }); },
          csp_allows_eval_json() { return true; },
          csp_document_policy_json(contextJSON) {
            const restricted = JSON.parse(contextJSON).target_csp.some(value => value.includes("trusted-types"));
            return JSON.stringify({ version: 1, trusted_types: { directive_present: restricted, allow_any: !restricted, allowed_policy_names: restricted ? ["target"] : [], allow_duplicates: restricted, require_for_script: restricted }, enforced_report_endpoint_count: restricted ? 1 : 0, report_only_endpoint_count: 0 });
          },
          csp_allows_frame_ancestors_json(policiesJSON, _targetURL, ancestorsJSON) {
            return JSON.parse(ancestorsJSON).length === 0 || !JSON.parse(policiesJSON).some(value => value.includes("frame-ancestors 'none'"));
          },
        },
      };
      const route = {
        abi_identifier: "__zp_abi_${"b".repeat(48)}",
        entry_id: originState.entry_id,
        kind: "document",
        method: "GET",
        origin_id: originState.destination_origin_id,
        profile_id: originState.profile_id,
        runtime_capability: "r".repeat(32),
        tab_id: originState.tab_id,
        target_url: originState.target_url,
        ancestor_urls: ancestorURLs,
        source_url: ancestorURLs.at(-1),
        fetch_destination: ancestorURLs.length ? "iframe" : "document",
      };
      const firstResult = { headers: [["Set-Cookie", "sid=target; Path=/; Secure"]] };
      const secondResult = { headers: [["Set-Cookie", "theme=dark; Path=/; Secure"]] };
      const nextIndex = await applyResponseCookies(route, firstResult, "response-chain");
      const finalIndex = await applyResponseCookies(route, secondResult, "response-chain", nextIndex);
      const response = await rewriteDocument(route, { headers: [["Content-Type", "text/html"], ...securityHeaders], status: 200 }, { resultingClientId: "client-a" });
      return { final_index: finalIndex, mutations, response_csp: response.headers.get("content-security-policy"), response_coep: response.headers.get("cross-origin-embedder-policy"), response_coop: response.headers.get("cross-origin-opener-policy"), response_permissions_policy: response.headers.get("permissions-policy"), response_status: response.status, runtime_url: runtimeURL };
    };
    globalThis.__documentCrossOriginPolicy = documentCoepAllows;
    globalThis.__responseHeaderProjection = result => [...responseHeaders(result)];`, context, { filename: "web/sw/sw.mjs" });
  return { coep: context.__documentCrossOriginPolicy, run: context.__responseCookieBootstrap, project: context.__responseHeaderProjection };
}

test("private Set-Cookie commits before the next document bootstrap snapshot", async () => {
  const { run } = await loadCookieBootstrapSeam();
  const result = await run();
  assert.equal(result.response_status, 200);
  assert.equal(result.final_index, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(result.mutations)), [
    { header_index: 0, raw: "sid=target; Path=/; Secure" },
    { header_index: 1, raw: "theme=dark; Path=/; Secure" },
  ]);
  const parameters = new URLSearchParams(result.runtime_url.split("#")[1]);
  const bootstrap = decodeBase64URL(parameters.get("bootstrap"));
  assert.equal(bootstrap.runtime_capability, "r".repeat(32));
  assert.equal(bootstrap.entry_id, "e".repeat(32));
  assert.deepEqual(bootstrap.decode_metadata, { encoding_used: "utf-8", replacement: false, source: "transport" });
  assert.equal(bootstrap.document_policy.version, 1);
  assert.match(parameters.get("tt"), /^zp-[A-Za-z0-9_-]{32}$/u);
  assert.equal(new URLSearchParams(result.runtime_url.split("#")[1]).get("strings"), "1");
  assert.equal(result.response_csp, [
    "default-src 'none'",
    `script-src 'self' blob: 'nonce-${result.response_csp.match(/nonce-([^']+)/)[1]}' 'wasm-unsafe-eval'`,
    `script-src-elem 'self' blob: 'nonce-${result.response_csp.match(/nonce-([^']+)/)[1]}'`,
    "style-src 'self' 'unsafe-inline' blob:",
    "img-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self' wss://relay.example.test",
    "worker-src 'self' blob:",
    "frame-src 'self' blob: data:",
    "form-action 'self'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; "));
  assert.deepEqual(bootstrap.snapshot, {
    cookie_seq: 2,
    jar_or_delta: {
      kind: "SNAPSHOT",
      cookies: [
        {
          name: "sid",
          value: "target",
          domain: "target.example",
          path: "/",
          secure: true,
          http_only: false,
          same_site: "LAX",
          creation_seq: 1,
        },
        {
          name: "theme",
          value: "dark",
          domain: "target.example",
          path: "/",
          secure: true,
          http_only: false,
          same_site: "LAX",
          creation_seq: 2,
        },
      ],
    },
  });
});

test("target security headers become bounded synthetic policy without endpoint leakage", async () => {
  const { run } = await loadCookieBootstrapSeam();
  const result = await run({ securityHeaders: [
    ["Content-Security-Policy", "trusted-types target 'allow-duplicates'; require-trusted-types-for 'script'; report-to private"],
    ["Cross-Origin-Opener-Policy", "same-origin; report-to=private"],
    ["Cross-Origin-Embedder-Policy", "credentialless"],
    ["Permissions-Policy", "geolocation=(self \"https://target.example\"), camera=()"],
    ["Report-To", JSON.stringify({ group: "private", endpoints: [{ url: "https://reports.target.example/csp" }] })],
    ["Reporting-Endpoints", "audit=\"https://reports.target.example/audit\""],
  ] });
  assert.equal(result.response_status, 200);
  assert.equal(result.response_coop, "same-origin");
  assert.equal(result.response_coep, "credentialless");
  assert.equal(result.response_permissions_policy, disabledPermissionsPolicy);
  assert.match(result.response_csp, /trusted-types target zp-[A-Za-z0-9_-]{32} 'allow-duplicates'/u);
  assert.match(result.response_csp, /require-trusted-types-for 'script'/u);
  assert.equal(result.response_csp.includes("target.example"), false);
});

test("target frame ancestors reject embedded documents before rewrite", async () => {
  const { run } = await loadCookieBootstrapSeam();
  const result = await run({
    ancestorURLs: ["https://parent.example/frame"],
    securityHeaders: [["Content-Security-Policy", "frame-ancestors 'none'"]],
  });
  assert.equal(result.response_status, 403);
  assert.equal(result.response_csp, null);
  assert.equal(result.runtime_url, null);
});

test("target CORP and COEP gate cross-origin bytes before synthetic delivery", async () => {
  const { coep } = await loadCookieBootstrapSeam();
  const route = { source_url: "https://parent.example/page", target_url: "https://resource.example/image.png", kind: "resource", cors_mode: null, credentials: "include" };
  assert.equal(await coep(route, { headers: [] }), true);
  assert.equal(await coep(route, { headers: [["Cross-Origin-Resource-Policy", "same-origin"]] }), false);
  assert.equal(await coep(route, { headers: [["Cross-Origin-Resource-Policy", "cross-origin"]] }), true);
  assert.equal(await coep({ ...route, document_security_policy: { coep: "require-corp" } }, { headers: [] }), false);
  assert.equal(await coep({ ...route, credentials: "omit", document_security_policy: { coep: "credentialless" } }, { headers: [] }), true);
});

test("executable target response headers never reach the browser projection", async () => {
  const { project } = await loadCookieBootstrapSeam();
  const projected = project({ headers: [
    ["Content-Type", "text/plain"], ["ETag", "\"validator\""], ["Accept-Ranges", "bytes"],
    ["Set-Cookie", "secret=1"], ["Location", "https://target.example/next"],
    ["Refresh", "0;url=https://target.example/"], ["Link", "<https://target.example>; rel=preconnect"],
    ["Alt-Svc", "h3=\":443\""], ["Report-To", "{}"], ["Reporting-Endpoints", "default=\"https://target.example\""],
    ["NEL", "{}"], ["Content-Security-Policy", "default-src *"], ["Permissions-Policy", "geolocation=*"],
    ["Cross-Origin-Opener-Policy", "same-origin"], ["X-Frame-Options", "DENY"],
    ["SourceMap", "https://target.example/source.map"], ["Service-Worker-Allowed", "/"],
    ["Clear-Site-Data", "\"cookies\""], ["X-ZP-Internal", "forged"],
  ] });
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), [
    ["accept-ranges", "bytes"], ["content-type", "text/plain"], ["etag", "\"validator\""],
  ]);
});
