import { canonicalTarget } from "../generated/policy.mjs";
import { opaqueID } from "./client.mjs";
import { browseHost } from "./origin.mjs";

export async function mintNavigation({ command, config, issueRelayCapabilities, profile, targetURL }) {
  if (typeof command !== "function" || typeof issueRelayCapabilities !== "function" || !config || !profile) {
    throw new TypeError("invalid navigation mint dependencies");
  }
  const target = await canonicalTarget(targetURL);
  const mapping = await command("MAP_ORIGIN", { profile_id: profile.profile_id, target_url: target.networkURL });
  const tabID = opaqueID();
  const entryID = opaqueID();
  const destinationHost = browseHost(mapping.origin_id, config.browse_domain);
  const destinationAuthority = location.port ? `${destinationHost}:${location.port}` : destinationHost;
  const relayCapabilities = await issueRelayCapabilities(`https://${destinationAuthority}`);
  if (!Array.isArray(relayCapabilities) || relayCapabilities.length < 1 || relayCapabilities.length > 8) {
    throw new TypeError("invalid ordered relay capability set");
  }
  for (const capability of relayCapabilities) {
    await command("SET_RELAY_CAPABILITY", {
      profile_id: profile.profile_id,
      origin_id: mapping.origin_id,
      capability,
    });
  }
  const handoff = await command("CREATE_HANDOFF", {
    profile_id: profile.profile_id,
    tab_id: tabID,
    entry_id: entryID,
    source_origin_id: "control",
    destination_origin_id: mapping.origin_id,
    capability_epoch: profile.capability_epoch,
    destination_host: destinationAuthority,
    target_url: target.url,
  });
  const destination = new URL(`https://${destinationAuthority}/`);
  destination.hash = new URLSearchParams({ handoff: handoff.handoff_id, nonce: handoff.bridge_nonce }).toString();
  return Object.freeze({ destination, entryID, mapping, tabID });
}
