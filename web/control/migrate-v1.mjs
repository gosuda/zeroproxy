import { createCoordinatorClient } from "./client.mjs";
import { openImportNonceStore } from "./import-nonce-store.mjs";
import { mintNavigation } from "./navigation.mjs";
import { verifyRelayProfileSet } from "./relay-profile.mjs";
import { createV1Importer, inspectV1Fragment, V1_IMPORT_SUNSET } from "./v1-importer.mjs";

export function initializeV1Migration({
  pageDocument = document,
  pageWindow = window,
  now = Date.now,
  openNonceStore = openImportNonceStore,
  createClient = createCoordinatorClient,
  fetchImpl = fetch,
  mint = mintNavigation,
  verifyProfiles = verifyRelayProfileSet,
} = {}) {
  const proposal = pageDocument.querySelector("#proposal");
  const targetHost = pageDocument.querySelector("#target-host");
  const approve = pageDocument.querySelector("#approve");
  const reject = pageDocument.querySelector("#reject");
  const deleteLocal = pageDocument.querySelector("#delete-local");
  const status = pageDocument.querySelector("#status");
  if (![proposal, targetHost, approve, reject, deleteLocal, status].every(Boolean)) throw new TypeError("migration controls are incomplete");

  let sourceFragment = pageWindow.location.hash;
  let inspected;
  let nonceStore;
  let coordinator;
  let deleted = false;

  pageWindow.history.replaceState(null, "", `${pageWindow.location.pathname}${pageWindow.location.search}`);

  const closeLocalResources = () => {
    nonceStore?.close();
    nonceStore = undefined;
    coordinator?.close();
    coordinator = undefined;
  };

  const disableDecision = () => {
    approve.disabled = true;
    reject.disabled = true;
  };

  try {
    if (now() >= V1_IMPORT_SUNSET) throw new DOMException("V1 import has ended", "NotSupportedError");
    inspected = inspectV1Fragment(sourceFragment, now());
    targetHost.textContent = new URL(inspected.targetURL).hostname;
    proposal.hidden = false;
    status.value = "Review the target host and choose whether to import.";
  } catch (error) {
    disableDecision();
    status.value = `Import unavailable: ${error.name}`;
  }

  approve.addEventListener("click", async () => {
    if (!inspected || deleted || approve.disabled) return;
    disableDecision();
    status.value = "Creating a fresh isolated profile and relay request…";
    try {
      nonceStore ??= await openNonceStore();
      const importer = createV1Importer({
        now,
        nonceStore,
        mint: async ({ targetURL }) => {
          coordinator = createClient();
          const config = await fetchImpl("/control/config.json", { credentials: "same-origin", cache: "no-store" }).then((response) => {
            if (!response.ok) throw new DOMException("Configuration unavailable", "NetworkError");
            return response.json();
          });
          const installed = await verifyProfiles(config);
          if (!Array.isArray(config.installed_relay_profile_digests)
            || config.installed_relay_profile_digests.length !== 1
            || installed.size !== 1
            || !installed.has(config.installed_relay_profile_digests[0])) {
            throw new DOMException("A single verified relay profile is required", "SecurityError");
          }
          const relayProfileDigest = config.installed_relay_profile_digests[0];
          const profile = await coordinator.command("CREATE_PROFILE");
          await coordinator.command("APPROVE_RELAY_SET", {
            profile_id: profile.profile_id,
            relay_profile_digests: [relayProfileDigest],
          });
          return mint({
            command: coordinator.command,
            config,
            profile,
            targetURL,
            issueRelayCapabilities: async (origin) => {
              const response = await fetchImpl("/control/capability", {
                method: "POST",
                credentials: "same-origin",
                cache: "no-store",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  origin,
                  relay_profile_digest: relayProfileDigest,
                  approved_visibility: true,
                }),
              });
              if (!response.ok) throw new DOMException("Approved relay capability unavailable", "SecurityError");
              return [await response.json()];
            },
          });
        },
      });
      const result = await importer.approve(inspected, true);
      sourceFragment = "";
      inspected = undefined;
      status.value = "Import approved. Opening the isolated destination…";
      pageWindow.location.assign(result.result.destination.href);
    } catch (error) {
      approve.disabled = false;
      reject.disabled = false;
      status.value = `Import failed: ${error.name}`;
    }
  });

  reject.addEventListener("click", () => {
    if (!inspected || deleted) return;
    disableDecision();
    status.value = "Import rejected. No profile or relay request was created.";
  });

  deleteLocal.addEventListener("click", () => {
    deleted = true;
    sourceFragment = "";
    inspected = undefined;
    targetHost.textContent = "";
    proposal.hidden = true;
    disableDecision();
    closeLocalResources();
    status.value = "Local import data deleted.";
  });

  pageWindow.addEventListener("pagehide", closeLocalResources, { once: true });
  return Object.freeze({ close: closeLocalResources });
}

if (typeof document !== "undefined" && typeof window !== "undefined") initializeV1Migration();
