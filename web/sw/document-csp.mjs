import { DISABLED_PERMISSIONS_POLICY_FEATURES } from "../generated/emerging-network-capabilities.mjs";

const ORIGIN_ID = /^[a-z2-7]{32}$/u;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/u;
const DEPLOYMENT_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const MAX_MAPPED_ORIGINS = 128;
const MAX_RELAYS = 8;
const TRUSTED_TYPES_POLICY = /^[A-Za-z0-9#=_/@.%-]{1,128}$/u;

function invalid(message) {
  return new DOMException(message, "SecurityError");
}

function hostRole({ destinationHost, destinationOriginID, syntheticOrigin }) {
  if (!ORIGIN_ID.test(destinationOriginID)) throw invalid("Browsing origin identity rejected");
  let origin;
  try { origin = new URL(syntheticOrigin); } catch { throw invalid("Browsing origin rejected"); }
  if (origin.protocol !== "https:" || origin.username !== "" || origin.password !== "" || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
    throw invalid("Browsing origin rejected");
  }
  if (origin.host !== destinationHost) throw invalid("Browsing host binding rejected");
  const prefix = `o-${destinationOriginID}.browse.`;
  if (!origin.hostname.startsWith(prefix)) throw invalid("Browsing host role rejected");
  const deploymentDomain = origin.hostname.slice(prefix.length);
  if (deploymentDomain.length === 0 || deploymentDomain.length > 205 || deploymentDomain.split(".").some(label => !DEPLOYMENT_LABEL.test(label))) {
    throw invalid("Browsing deployment domain rejected");
  }
  return Object.freeze({ deploymentDomain, origin, port: origin.port });
}

function mappedOrigins(role, originIDs) {
  if (!Array.isArray(originIDs) || originIDs.length > MAX_MAPPED_ORIGINS) throw invalid("Mapped origin set rejected");
  const origins = new Set();
  for (const originID of originIDs) {
    if (!ORIGIN_ID.test(originID)) throw invalid("Mapped origin identity rejected");
    const port = role.port === "" ? "" : `:${role.port}`;
    const origin = `https://o-${originID}.browse.${role.deploymentDomain}${port}`;
    if (origin !== role.origin.origin) origins.add(origin);
  }
  return [...origins].sort();
}

function relayOrigins(relayURLs) {
  if (!Array.isArray(relayURLs) || relayURLs.length < 1 || relayURLs.length > MAX_RELAYS) throw invalid("Relay origin set rejected");
  const origins = new Set();
  for (const relayURL of relayURLs) {
    let relay;
    try { relay = new URL(relayURL); } catch { throw invalid("Relay URL rejected"); }
    if (!["https:", "wss:"].includes(relay.protocol) || relay.username !== "" || relay.password !== "" || relay.origin === "null") {
      throw invalid("Relay URL rejected");
    }
    origins.add(relay.origin);
  }
  return [...origins].sort();
}

function sourceList(prefix, values, suffix = []) {
  return [prefix, ...values, ...suffix].join(" ");
}

export function documentTrustedTypesPolicyName(nonce) {
  if (typeof nonce !== "string" || !NONCE.test(nonce)) throw invalid("Document nonce rejected");
  return `zp-${nonce}`;
}

function trustedTypesDirectives(documentPolicy, internalPolicyName) {
  if (documentPolicy === undefined) return [];
  const keys = Object.keys(documentPolicy);
  const trustedTypes = documentPolicy?.trusted_types;
  if (keys.length !== 4
    || !keys.includes("version")
    || !keys.includes("trusted_types")
    || !keys.includes("enforced_report_endpoint_count")
    || !keys.includes("report_only_endpoint_count")
    || documentPolicy.version !== 1
    || !Number.isSafeInteger(documentPolicy.enforced_report_endpoint_count)
    || documentPolicy.enforced_report_endpoint_count < 0
    || documentPolicy.enforced_report_endpoint_count > 4096
    || !Number.isSafeInteger(documentPolicy.report_only_endpoint_count)
    || documentPolicy.report_only_endpoint_count < 0
    || documentPolicy.report_only_endpoint_count > 4096
    || !trustedTypes
    || typeof trustedTypes !== "object"
    || Array.isArray(trustedTypes)
    || Object.keys(trustedTypes).length !== 5
    || typeof trustedTypes.directive_present !== "boolean"
    || typeof trustedTypes.allow_any !== "boolean"
    || typeof trustedTypes.allow_duplicates !== "boolean"
    || typeof trustedTypes.require_for_script !== "boolean"
    || !Array.isArray(trustedTypes.allowed_policy_names)
    || trustedTypes.allowed_policy_names.length > 128
    || trustedTypes.allowed_policy_names.some(name => typeof name !== "string" || !TRUSTED_TYPES_POLICY.test(name))) {
    throw invalid("Target document policy rejected");
  }
  const directives = [];
  if (trustedTypes.directive_present) {
    const names = trustedTypes.allow_any
      ? ["*"]
      : [...new Set(trustedTypes.allowed_policy_names)].sort();
    names.push(internalPolicyName);
    if (trustedTypes.allow_duplicates) names.push("'allow-duplicates'");
    directives.push(`trusted-types ${names.join(" ")}`);
  }
  if (trustedTypes.require_for_script) directives.push("require-trusted-types-for 'script'");
  return directives;
}

function permissionDirective(rawDirective) {
  const directive = rawDirective.trim();
  if (directive === "") return null;
  const match = /^([a-z][a-z0-9-]{0,63})\s*=\s*(\*|\((?:\s*(?:self|"self"|\*|"https?:\/\/[^"\s]+"|'none'))*\s*\))$/u.exec(directive);
  if (!match) throw invalid("Target permissions policy rejected");
  const allowed = new Set();
  if (match[2] === "*") allowed.add("*");
  else {
    const tokens = match[2].slice(1, -1).trim().match(/self|"self"|\*|"https?:\/\/[^"\s]+"|'none'/gu) ?? [];
    for (const token of tokens) {
      if (token === "self" || token === "\"self\"") allowed.add("self");
      if (token === "*") allowed.add("*");
    }
  }
  return [match[1], allowed];
}

function intersectPermissionAllowlists(existing, allowed) {
  if (existing === undefined || allowed.has("*")) return existing ?? allowed;
  if (existing.has("*")) return allowed;
  return new Set([...existing].filter(token => allowed.has(token)));
}

export function translatePermissionsPolicy(values) {
  if (!Array.isArray(values) || values.length > 16 || values.some(value => typeof value !== "string" || value.length > 64 << 10 || /[^\x09\x20-\x7e]/u.test(value))) {
    throw invalid("Target permissions policy rejected");
  }
  const policies = new Map();
  for (const value of values) {
    for (const rawDirective of value.split(",")) {
      const parsed = permissionDirective(rawDirective);
      if (parsed === null) continue;
      const [feature, allowed] = parsed;
      policies.set(feature, intersectPermissionAllowlists(policies.get(feature), allowed));
    }
  }
  for (const feature of DISABLED_PERMISSIONS_POLICY_FEATURES) policies.set(feature, new Set());
  return [...policies]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([feature, allowed]) => allowed.has("*") ? `${feature}=*` : `${feature}=(${[...allowed].sort().join(" ")})`)
    .join(", ");
}

function reportingURL(value) {
  let url;
  try { url = new URL(value); } catch { throw invalid("Target reporting policy rejected"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "") throw invalid("Target reporting policy rejected");
  return url;
}

function reportToEndpointCount(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw invalid("Target reporting policy rejected"); }
  const groups = Array.isArray(parsed) ? parsed : [parsed];
  let count = 0;
  for (const group of groups) {
    if (!group || typeof group !== "object" || Array.isArray(group)) throw invalid("Target reporting policy rejected");
    if (group.endpoints === undefined) continue;
    if (!Array.isArray(group.endpoints) || group.endpoints.length > 64) throw invalid("Target reporting policy rejected");
    for (const endpoint of group.endpoints) {
      reportingURL(endpoint?.url);
      count += 1;
    }
  }
  return count;
}

function reportingEndpointsCount(value) {
  let count = 0;
  for (const entry of value.split(",")) {
    const match = /^\s*[A-Za-z0-9_-]{1,64}\s*=\s*"([^"]+)"\s*$/u.exec(entry);
    if (!match) throw invalid("Target reporting policy rejected");
    reportingURL(match[1]);
    count += 1;
  }
  return count;
}

function reportHeaderEndpointCount(reportToValues, reportingEndpointsValues) {
  if (!Array.isArray(reportToValues)
    || !Array.isArray(reportingEndpointsValues)
    || reportToValues.length > 16
    || reportingEndpointsValues.length > 16
    || [...reportToValues, ...reportingEndpointsValues].some(value => typeof value !== "string" || value.length > 64 << 10)) {
    throw invalid("Target reporting policy rejected");
  }
  const count = reportToValues.reduce((total, value) => total + reportToEndpointCount(value), 0)
    + reportingEndpointsValues.reduce((total, value) => total + reportingEndpointsCount(value), 0);
  if (count > 4096) throw invalid("Target reporting policy rejected");
  return count;
}

export function responseIsolationHeaders({
  coopValues = [],
  coepValues = [],
  permissionsPolicyValues = [],
  reportToValues = [],
  reportingEndpointsValues = [],
} = {}) {
  const exact = (values, allowed, name) => {
    if (!Array.isArray(values) || values.length > 16 || values.some(value => typeof value !== "string" || value.length > 256)) throw invalid(`${name} rejected`);
    let effective = null;
    for (const value of values) {
      const token = value.split(";", 1)[0].trim().toLowerCase();
      if (!allowed.includes(token)) throw invalid(`${name} rejected`);
      if (effective !== null && effective !== token) throw invalid(`${name} conflict`);
      effective = token;
    }
    return effective;
  };
  return Object.freeze({
    coop: exact(coopValues, ["unsafe-none", "same-origin-allow-popups", "same-origin", "noopener-allow-popups"], "Target COOP"),
    coep: exact(coepValues, ["unsafe-none", "require-corp", "credentialless"], "Target COEP"),
    permissionsPolicy: translatePermissionsPolicy(permissionsPolicyValues),
    reportEndpointHeaderCount: reportHeaderEndpointCount(reportToValues, reportingEndpointsValues),
  });
}

export function crossOriginResourcePolicyAllows(value, relationship) {
  const token = typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
  if (token === "cross-origin") return true;
  if (token === "same-site") return relationship === "same-origin" || relationship === "same-site";
  if (token === "same-origin") return relationship === "same-origin";
  return false;
}

export function xFrameOptionsAllows(values, relationship) {
  if (!Array.isArray(values) || values.length > 16 || !["same-origin", "cross-origin"].includes(relationship)) throw invalid("Target frame policy rejected");
  return values.every(value => {
    if (typeof value !== "string" || value.length > 256) throw invalid("Target frame policy rejected");
    const token = value.trim().toLowerCase();
    if (token === "deny") return false;
    if (token === "sameorigin") return relationship === "same-origin";
    return false;
  });
}

function validDocumentPolicy(documentPolicy, nonce) {
  const internalPolicyName = documentTrustedTypesPolicyName(nonce);
  return trustedTypesDirectives(documentPolicy, internalPolicyName);
}

export function generateDocumentCSP({
  destinationHost,
  destinationOriginID,
  documentPolicy,
  mappedOriginIDs = [],
  nonce,
  relayURLs,
  syntheticOrigin,
} = {}) {
  const trustedTypes = validDocumentPolicy(documentPolicy, nonce);
  const role = hostRole({ destinationHost, destinationOriginID, syntheticOrigin });
  const mapped = mappedOrigins(role, mappedOriginIDs);
  const relays = relayOrigins(relayURLs);
  return [
    "default-src 'none'",
    `script-src 'self' blob: 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    `script-src-elem 'self' blob: 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' blob:",
    "img-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    sourceList("connect-src 'self'", relays),
    "worker-src 'self' blob:",
    sourceList("frame-src 'self'", mapped, ["blob:", "data:"]),
    sourceList("form-action 'self'", mapped),
    "object-src 'none'",
    "base-uri 'none'",
    ...trustedTypes,
  ].join("; ");
}
