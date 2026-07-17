export function runtimeBootstrapFixture({ capability, entryID, targetURL, approvedPorts, referrerURL = null, snapshot = { cookie_seq: 0, jar_or_delta: { kind: "SNAPSHOT", cookies: [] } } }) {
  const target = new URL(targetURL);
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  const canonicalOrigin = `${target.protocol}//${target.hostname}:${port}`;
  return Buffer.from(JSON.stringify({
    runtime_capability: capability,
    entry_id: entryID,
    cookie_top_level_site: `${target.protocol}//${target.hostname}`,
    policy_context: {
      profile_id: "test-profile",
      tab_id: "test-tab",
      document_id: entryID,
      virtual_origin: canonicalOrigin,
      virtual_site: `${target.protocol}//${target.hostname}`,
      target_url: target.href,
      effective_base_url: target.href,
      referrer_url: referrerURL,
      referrer_policy: "strict-origin-when-cross-origin",
      document_charset: "utf-8",
      target_csp: [],
      target_csp_report_only: [],
      relay_profile: "test-relay-profile",
      approved_target_ports: approvedPorts,
      policy_version: 2,
    },
    document_policy: {
      version: 1,
      trusted_types: {
        directive_present: false,
        allow_any: true,
        allowed_policy_names: [],
        allow_duplicates: false,
        require_for_script: false,
      },
      enforced_report_endpoint_count: 0,
      report_only_endpoint_count: 0,
    },
    decode_metadata: { encoding_used: "utf-8", replacement: false, source: "test" },
    snapshot,
  })).toString("base64url");
}
