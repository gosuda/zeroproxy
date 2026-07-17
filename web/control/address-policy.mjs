import { ADDRESS_POLICY_ID, BLOCKED_ADDRESS_SUFFIXES } from "../generated/address-policy.mjs";

function addressPolicyError() {
  return new DOMException("Target host rejected by address policy", "SecurityError");
}

function validLabel(label) {
  return label.length >= 1 && label.length <= 63
    && !label.startsWith("-") && !label.endsWith("-")
    && /^[a-z0-9-]+$/u.test(label);
}

export function canonicalEgressHost(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 253
    || raw.trim() !== raw || raw.endsWith(".")) throw addressPolicyError();
  let host;
  try {
    const parsed = new URL(`https://${raw}/`);
    if (parsed.username || parsed.password || parsed.port || parsed.pathname !== "/") throw addressPolicyError();
    host = parsed.hostname.toLowerCase();
  } catch {
    throw addressPolicyError();
  }
  if (host.length === 0 || host.length > 253 || host.includes(":") || /^\d+(?:\.\d+)*$/u.test(host)
    || /^0x[0-9a-f]+$/u.test(host)) throw addressPolicyError();
  const labels = host.split(".");
  if (labels.length < 2 || labels.some(label => !validLabel(label))) throw addressPolicyError();
  if (BLOCKED_ADDRESS_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) {
    throw addressPolicyError();
  }
  return host;
}

export { ADDRESS_POLICY_ID };
