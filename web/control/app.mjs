import { createCoordinatorClient } from "./client.mjs";
import { mintNavigation } from "./navigation.mjs";
import { verifyRelayProfileSet } from "./relay-profile.mjs";
import { base64url, openShare, sealShare } from "./share-crypto.mjs";
import { TargetWorkerHostFrames } from "./target-worker-hosts.mjs";

const SHARE_PREFIX = "/_zp/s/v2/";
const APPROVED_RELAYS_KEY = "zeroproxy.approved-relays.v2";

let incomingShareURL = location.pathname.startsWith(SHARE_PREFIX) ? location.href : null;
if (incomingShareURL !== null) history.replaceState(null, "", "/");

const coordinator = createCoordinatorClient();
const targetWorkerHosts = new TargetWorkerHostFrames();
const command = coordinator.command;
const form = document.querySelector("#open-form");
const targetInput = document.querySelector("#target");
const profileMode = document.querySelector("#profile-mode");
const telemetryOptIn = document.querySelector("#telemetry-opt-in");
const relaySelect = document.querySelector("#relay-profile");
const createShareButton = document.querySelector("#create-share");
const shareOutput = document.querySelector("#share-output");
const status = document.querySelector("#status");
const approvalDialog = document.querySelector("#relay-approval");
const approvalDigest = document.querySelector("#approval-digest");

function securityError(message) {
  return new DOMException(message, "SecurityError");
}

function decodeDigest(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(text)) {
    throw securityError("Invalid relay profile digest");
  }
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=";
  let bytes;
  try {
    bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw securityError("Invalid relay profile digest");
  }
  if (bytes.length !== 32 || base64url(bytes) !== text) {
    throw securityError("Invalid relay profile digest");
  }
  return bytes;
}

function approvedRelayDigests() {
  try {
    const parsed = JSON.parse(localStorage.getItem(APPROVED_RELAYS_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function rememberRelayApproval(digest) {
  const approved = approvedRelayDigests();
  approved.add(digest);
  try {
    localStorage.setItem(APPROVED_RELAYS_KEY, JSON.stringify([...approved].sort()));
  } catch {
    // Approval still applies to this action when durable browser storage is unavailable.
  }
}

function requestRelayApproval(digest) {
  if (approvedRelayDigests().has(digest)) return Promise.resolve();
  approvalDigest.textContent = digest;
  approvalDialog.showModal();
  return new Promise((resolve, reject) => {
    approvalDialog.addEventListener("close", () => {
      if (approvalDialog.returnValue !== "approve") {
        reject(new DOMException("Relay approval cancelled", "AbortError"));
        return;
      }
      rememberRelayApproval(digest);
      resolve();
    }, { once: true });
  });
}

function installedRelay(configured, digest) {
  const profile = configured.get(digest);
  if (!profile) throw securityError("Share references an uninstalled relay profile");
  return profile;
}

function orderedApprovedRelayDigests(configured, primaryDigest) {
  const approved = approvedRelayDigests();
  const ordered = [primaryDigest];
  for (const digest of configured.keys()) {
    if (digest !== primaryDigest && approved.has(digest)) ordered.push(digest);
    if (ordered.length === 8) break;
  }
  return ordered;
}

async function issueApprovedCapability(origin, relayDigest) {
  const response = await fetch("/control/capability", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      origin,
      relay_profile_digest: relayDigest,
      approved_visibility: true,
    }),
  });
  if (!response.ok) throw securityError("Approved relay capability unavailable");
  return response.json();
}

async function fetchVerifiedRelayProfiles() {
  const currentConfig = await fetch("/control/config.json", {
    credentials: "same-origin",
    cache: "no-store",
  }).then((response) => {
    if (!response.ok) throw new Error("configuration unavailable");
    return response.json();
  });
  const profiles = await verifyRelayProfileSet(currentConfig);
  if (!Array.isArray(currentConfig.installed_relay_profile_digests)
    || currentConfig.installed_relay_profile_digests.length !== profiles.size
    || currentConfig.installed_relay_profile_digests.some((digest) => !profiles.has(digest))) {
    throw securityError("Installed relay profile set mismatch");
  }
  return { config: currentConfig, profiles };
}

const { profiles: installedRelayProfiles } = await fetchVerifiedRelayProfiles();
for (const [digest, relay] of installedRelayProfiles) {
  decodeDigest(digest);
  const option = document.createElement("option");
  option.value = digest;
  option.textContent = `${relay.profile.display_name} — ${digest.slice(0, 12)}…`;
  relaySelect.append(option);
}

let persistentProfile = null;
async function createProfile() {
  return command("CREATE_PROFILE", { telemetry_opt_in: telemetryOptIn.checked });
}
async function profileFor(mode, relayDigests) {
  if (mode === "persistent" && persistentProfile?.telemetry_opt_in !== telemetryOptIn.checked) {
    persistentProfile = null;
  }
  if (mode === "persistent") persistentProfile ??= await createProfile();
  const profile = mode === "persistent" ? persistentProfile : await createProfile();
  await command("APPROVE_RELAY_SET", {
    profile_id: profile.profile_id,
    relay_profile_digests: relayDigests,
  });
  return profile;
}

async function openTarget() {
  const relayDigest = relaySelect.value;
  const beforeApproval = await fetchVerifiedRelayProfiles();
  installedRelay(beforeApproval.profiles, relayDigest);
  await requestRelayApproval(relayDigest);
  const approved = await fetchVerifiedRelayProfiles();
  const relayDigests = orderedApprovedRelayDigests(approved.profiles, relayDigest);
  for (const digest of relayDigests) installedRelay(approved.profiles, digest);
  const profile = await profileFor(profileMode.value, relayDigests);
  const navigation = await mintNavigation({
    command,
    config: approved.config,
    profile,
    targetURL: targetInput.value,
    issueRelayCapabilities: origin => Promise.all(
      relayDigests.map(digest => issueApprovedCapability(origin, digest)),
    ),
  });
  await targetWorkerHosts.ensure({
    destination: navigation.destination,
    profile_id: profile.profile_id,
    client_epoch: profile.capability_epoch,
  });
  window.open(navigation.destination, "_blank", "noopener");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  shareOutput.replaceChildren();
  status.value = "Waiting for relay approval…";
  try {
    await openTarget();
    status.value = "Opened";
  } catch (error) {
    status.value = `Blocked: ${error.name}`;
  }
});

createShareButton.addEventListener("click", async () => {
  shareOutput.replaceChildren();
  status.value = "Encrypting share…";
  try {
    if (!form.reportValidity()) return;
    const refreshed = await fetchVerifiedRelayProfiles();
    const relayDigest = installedRelay(refreshed.profiles, relaySelect.value).digest;
    const createdAt = Date.now();
    const path = await sealShare({
      v: 2,
      target_url: targetInput.value,
      created_at: createdAt,
      expires_at: createdAt + (24 * 60 * 60 * 1000),
      relay_profile_digest: decodeDigest(relayDigest),
      requested_profile_mode: profileMode.value,
      flags: 0,
    }, location.origin);
    const link = document.createElement("a");
    link.href = path;
    link.textContent = "Encrypted share link";
    link.rel = "noreferrer";
    shareOutput.append(link);
    status.value = "Share encrypted; the key remains in the URL fragment";
  } catch (error) {
    status.value = `Blocked: ${error.name}`;
  }
});

export function applySharedRecord(shared) {
  targetInput.value = shared.target_url;
  profileMode.value = shared.requested_profile_mode;
  relaySelect.value = shared.relay_profile_digest === null
    ? ""
    : installedRelay(installedRelayProfiles, base64url(shared.relay_profile_digest)).digest;
}

if (incomingShareURL !== null) {
  try {
    const shared = await openShare(incomingShareURL, location.origin);
    incomingShareURL = null;
    applySharedRecord(shared);
    status.value = "Encrypted share opened locally; review and approve the relay to continue";
  } catch (error) {
    incomingShareURL = null;
    form.hidden = true;
    status.value = `Blocked share: ${error.name}`;
  }
}
