import { canonicalTarget, POLICY_VERSION } from "../generated/policy.mjs";

export const COORDINATOR_DB_NAME = "zeroproxy-v2-coordinator";
export const COORDINATOR_DB_VERSION = 6;

const STORE_DEFINITIONS = Object.freeze([
  ["profiles", "profile_id", []],
  ["origin_map", ["profile_id", "canonical_origin"], [
    ["by_origin_id", ["profile_id", "origin_id"], { unique: true }],
    ["by_profile", "profile_id", { unique: false }],
  ]],
  ["cookies", "cookie_id", [["by_profile", "profile_id", { unique: false }]]],
  ["sessions", "session_id", [["by_profile", "profile_id", { unique: false }]]],
  ["tabs", ["profile_id", "tab_id"], [
    ["by_profile", "profile_id", { unique: false }],
    ["by_session", ["profile_id", "session_id"], { unique: false }],
  ]],
  ["history", ["profile_id", "tab_id", "entry_id"], [
    ["by_tab", ["profile_id", "tab_id"], { unique: false }],
  ]],
  ["routes", "route_hash", [
    ["by_tab", ["profile_id", "tab_id"], { unique: false }],
    ["by_expiry", "expires_at", { unique: false }],
  ]],
  ["session_storage", ["profile_id", "tab_id", "origin_id", "key"], [
    ["by_origin", ["profile_id", "tab_id", "origin_id"], { unique: false }],
  ]],
  ["origin_kernel_meta", "schema_version", []],
  ["relay_capabilities", ["profile_id", "origin_id", "relay_profile_digest"], [["by_profile", "profile_id", { unique: false }]]],
  ["handoffs", "id", [["by_expiry", "expires_at", { unique: false }]]],
  ["v1_import_nonces", "nonce", [["by_expiry", "expires_at", { unique: false }]]],
  ["cookie_journal", ["profile_id", "cookie_seq"], [
    ["by_profile", "profile_id", { unique: false }],
    ["by_operation", ["profile_id", "op_id"], { unique: true }],
  ]],
  ["target_worker_journal", ["profile_id", "origin_id"], [["by_profile", "profile_id", { unique: false }]]],
]);

function request(value) {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

function createStore(db, transaction, [name, keyPath, indexes]) {
  const store = db.createObjectStore(name, { keyPath });
  for (const [indexName, indexKeyPath, options] of indexes) {
    store.createIndex(indexName, indexKeyPath, options);
  }
  return transaction.objectStore(name);
}

function createSchema(db, transaction) {
  for (const definition of STORE_DEFINITIONS) createStore(db, transaction, definition);
}

function requiredLegacyRecord(record, fields, storeName) {
  if (!record || typeof record !== "object" || fields.some(field => !Object.hasOwn(record, field))) {
    throw new DOMException(`Invalid legacy ${storeName} record`, "DataError");
  }
  return record;
}

function uniqueMappings(records) {
  const byOrigin = new Map();
  const byID = new Map();
  for (const candidate of records) {
    const record = requiredLegacyRecord(candidate, ["profile_id", "canonical_origin", "origin_id"], "origin_map");
    const originKey = `${record.profile_id}\0${record.canonical_origin}`;
    const idKey = `${record.profile_id}\0${record.origin_id}`;
    const priorOrigin = byOrigin.get(originKey);
    const priorID = byID.get(idKey);
    if ((priorOrigin && priorOrigin.origin_id !== record.origin_id)
      || (priorID && priorID.canonical_origin !== record.canonical_origin)) {
      throw new DOMException("Conflicting legacy origin mapping", "ConstraintError");
    }
    if (!priorOrigin) {
      const normalized = {
        profile_id: record.profile_id,
        canonical_origin: record.canonical_origin,
        canonical_site: record.canonical_site ?? record.canonical_origin,
        origin_id: record.origin_id,
        collision_counter: record.collision_counter ?? 0,
        version: record.version ?? 2,
      };
      byOrigin.set(originKey, normalized);
      byID.set(idKey, normalized);
    }
  }
  return [...byOrigin.values()];
}

function normalizeProfile(record) {
  requiredLegacyRecord(record, ["profile_id", "cookie_seq", "capability_epoch", "created_at", "updated_at"], "profiles");
  const relayProfileDigests = record.relay_profile_digests
    ?? (record.relay_profile_digest == null ? [] : [record.relay_profile_digest]);
  const relayProfiles = record.relay_profiles
    ?? (record.relay_profile == null ? [] : [record.relay_profile]);
  if (!Array.isArray(relayProfileDigests)
    || !Array.isArray(relayProfiles)
    || relayProfileDigests.length !== relayProfiles.length) {
    throw new DOMException("Invalid legacy relay profile set", "DataError");
  }
  const normalized = {
    ...record,
    key_version: record.key_version ?? 1,
    relay_profile_digests: relayProfileDigests,
    relay_profiles: relayProfiles,
    telemetry_opt_in: record.telemetry_opt_in === true,
  };
  delete normalized.relay_profile_digest;
  delete normalized.relay_profile;
  return normalized;
}

function normalizeTab(record) {
  requiredLegacyRecord(record, ["profile_id", "tab_id", "capability_epoch"], "tabs");
  return {
    ...record,
    session_id: record.session_id ?? `legacy-${record.tab_id}`,
    opener_tab_id: record.opener_tab_id ?? null,
    encrypted_stream_key: record.encrypted_stream_key ?? null,
    top_level_site: record.top_level_site ?? "",
    state: record.state ?? "ACTIVE",
    last_seen_at: record.last_seen_at ?? record.created_at ?? Date.now(),
  };
}

function normalizeHistory(record) {
  requiredLegacyRecord(record, ["profile_id", "tab_id", "entry_id", "origin_id", "encrypted_target_url", "created_at"], "history");
  return {
    ...record,
    parent_entry_id: record.parent_entry_id ?? null,
    base_url: record.base_url ?? null,
    referrer_url: record.referrer_url ?? null,
    state_clone: record.state_clone ?? null,
    scroll_x: record.scroll_x ?? 0,
    scroll_y: record.scroll_y ?? 0,
  };
}

function normalizeJournal(record) {
  requiredLegacyRecord(record, ["profile_id", "cookie_seq", "op_id", "commit"], "cookie_journal");
  return { ...record };
}

function normalizeTargetWorkerJournal(record) {
  requiredLegacyRecord(record, ["profile_id", "origin_id", "revision", "state"], "target_worker_journal");
  const { key: _key, ...normalized } = record;
  return normalized;
}

function normalizeRelayCapabilities(profiles) {
  const records = [];
  for (const profile of profiles) {
    const [relayProfileDigest] = profile.relay_profile_digests;
    const legacy = Object.entries(profile.relay_capabilities ?? {});
    if (legacy.length !== 0 && profile.relay_profile_digests.length !== 1) {
      delete profile.relay_capabilities;
      continue;
    }
    for (const [originID, encrypted_capability] of legacy) {
      records.push({
        profile_id: profile.profile_id,
        origin_id: originID,
        relay_profile_digest: relayProfileDigest,
        encrypted_capability,
      });
    }
    delete profile.relay_capabilities;
  }
  return records;
}

function normalizeLegacyCookies(records, profiles) {
  const profileIDs = new Set(
    profiles.filter(profile => profile.capability_root).map(profile => profile.profile_id),
  );
  const normalized = [];
  for (const record of records) {
    requiredLegacyRecord(record, ["profile_id", "state_json"], "cookies");
    const state = JSON.parse(record.state_json);
    if (
      !profileIDs.has(record.profile_id)
      || state?.version !== 1
      || !Array.isArray(state.cookies)
      || !state.journal
      || typeof state.journal !== "object"
    ) {
      throw new DOMException("Invalid legacy cookie state", "DataError");
    }
    normalized.push({
      cookie_id: `legacy:${record.profile_id}`,
      profile_id: record.profile_id,
      legacy_state_json: record.state_json,
      version: record.version ?? 1,
      updated_at: record.updated_at ?? Date.now(),
    });
  }
  return normalized;
}

function normalizedSessions(existing, tabs, profiles) {
  const sessions = new Map(existing.map(session => [session.session_id, session]));
  const profileByID = new Map(profiles.map(profile => [profile.profile_id, profile]));
  for (const tab of tabs) {
    if (sessions.has(tab.session_id)) continue;
    const profile = profileByID.get(tab.profile_id);
    if (!profile) throw new DOMException("Legacy tab profile unavailable", "DataError");
    sessions.set(tab.session_id, {
      session_id: tab.session_id,
      profile_id: tab.profile_id,
      protocol_epoch: 2,
      compiler_epoch: null,
      kernel_epoch: null,
      capability_root: profile.capability_root,
      browser_feature_probes: null,
      active_origin_inventory: [tab.origin_id],
      state: tab.state,
      created_at: tab.created_at ?? tab.last_seen_at,
      updated_at: tab.last_seen_at,
    });
  }
  return [...sessions.values()];
}

function migrationMetadata(from) {
  return {
    schema_version: COORDINATOR_DB_VERSION,
    sw_version: null,
    compiler_version: null,
    policy_version: POLICY_VERSION,
    coordinator_revision: 0,
    last_migration: { from, to: COORDINATOR_DB_VERSION, completed_at: Date.now() },
  };
}

function normalizeRelayCapabilityRecords(records, profiles) {
  const profileByID = new Map(profiles.map(profile => [profile.profile_id, profile]));
  return records.map((record) => {
    if (typeof record.relay_profile_digest === "string") return record;
    const profile = profileByID.get(record.profile_id);
    if (!profile || profile.relay_profile_digests.length !== 1) {
      throw new DOMException("Ambiguous legacy relay capability", "DataError");
    }
    return { ...record, relay_profile_digest: profile.relay_profile_digests[0] };
  });
}

function normalizedSnapshots(snapshots) {
  const profiles = (snapshots.profiles ?? []).map(normalizeProfile);
  const tabs = (snapshots.tabs ?? []).map(normalizeTab);
  return {
    profiles,
    origin_map: uniqueMappings(snapshots.origin_map ?? []),
    cookies: normalizeLegacyCookies(snapshots.cookies ?? [], profiles),
    sessions: normalizedSessions(snapshots.sessions ?? [], tabs, profiles),
    tabs,
    history: (snapshots.history ?? []).map(normalizeHistory),
    routes: snapshots.routes ?? [],
    session_storage: snapshots.session_storage ?? [],
    relay_capabilities: [
      ...normalizeRelayCapabilityRecords(snapshots.relay_capabilities ?? [], profiles),
      ...normalizeRelayCapabilities(profiles),
    ],
    handoffs: snapshots.handoffs ?? [],
    v1_import_nonces: snapshots.v1_import_nonces ?? [],
    cookie_journal: (snapshots.cookie_journal ?? []).map(normalizeJournal),
    target_worker_journal: (snapshots.target_worker_journal ?? []).map(
      normalizeTargetWorkerJournal,
    ),
  };
}

function replaceSchema(db, transaction, names, snapshots, oldVersion) {
  const records = normalizedSnapshots(snapshots);
  for (const name of names) db.deleteObjectStore(name);
  createSchema(db, transaction);
  for (const [name, values] of Object.entries(records)) {
    const store = transaction.objectStore(name);
    for (const value of values) store.add(value);
  }
  transaction.objectStore("origin_kernel_meta").add(migrationMetadata(oldVersion));
}

function migrateLegacySchema(db, transaction, oldVersion) {
  const names = [...db.objectStoreNames];
  if (names.length === 0) {
    createSchema(db, transaction);
    transaction.objectStore("origin_kernel_meta").add(migrationMetadata(0));
    return;
  }
  const snapshots = Object.create(null);
  let remaining = names.length;
  for (const name of names) {
    const reading = transaction.objectStore(name).getAll();
    reading.onerror = () => transaction.abort();
    reading.onsuccess = () => {
      snapshots[name] = reading.result;
      remaining -= 1;
      if (remaining !== 0) return;
      try {
        replaceSchema(db, transaction, names, snapshots, oldVersion);
      } catch {
        transaction.abort();
      }
    };
  }
}

async function readHydrationState(db) {
  const transaction = db.transaction(
    ["profiles", "origin_map", "cookies", "cookie_journal"],
    "readonly",
  );
  const [profiles, mappings, cookies, journal] = await Promise.all([
    request(transaction.objectStore("profiles").getAll()),
    request(transaction.objectStore("origin_map").getAll()),
    request(transaction.objectStore("cookies").getAll()),
    request(transaction.objectStore("cookie_journal").getAll()),
  ]);
  return { profiles, mappings, cookies, journal };
}

function mergeJournalEntry(journalRows, legacy, opID, entry) {
  const key = `${legacy.profile_id}\0${opID}`;
  const existing = journalRows.get(key);
  if (existing) {
    existing.journal_entry = entry;
    return;
  }
  if (!entry?.commit?.cookie_seq) return;
  journalRows.set(key, {
    profile_id: legacy.profile_id,
    cookie_seq: entry.commit.cookie_seq,
    op_id: opID,
    commit: entry.commit,
    journal_entry: entry,
    committed_at: legacy.updated_at,
  });
}

function collectLegacyCookieState(profiles, legacyCookies, journal) {
  const profileByID = new Map(profiles.map(profile => [profile.profile_id, profile]));
  const cookieRows = [];
  const journalRows = new Map(journal.map(record => [`${record.profile_id}\0${record.op_id}`, record]));
  for (const legacy of legacyCookies) {
    const profile = profileByID.get(legacy.profile_id);
    if (!profile?.capability_root) {
      throw new DOMException("Legacy cookie profile unavailable", "DataError");
    }
    const state = JSON.parse(legacy.legacy_state_json);
    if (
      !state
      || state.version !== 1
      || !Array.isArray(state.cookies)
      || typeof state.journal !== "object"
    ) {
      throw new DOMException("Invalid legacy cookie state", "DataError");
    }
    for (const cookie of state.cookies) cookieRows.push({ profile, cookie });
    for (const [opID, entry] of Object.entries(state.journal)) {
      mergeJournalEntry(journalRows, legacy, opID, entry);
    }
  }
  return { cookieRows, journalRows };
}

async function writeHydratedRecords(db, sites, legacyCookies, sealedRows, journalRows) {
  const writing = db.transaction(
    ["origin_map", "cookies", "cookie_journal"],
    "readwrite",
    { durability: "strict" },
  );
  for (const { key, site } of sites) {
    const record = await request(writing.objectStore("origin_map").get(key));
    if (record) {
      record.canonical_site = site;
      writing.objectStore("origin_map").put(record);
    }
  }
  const cookieStore = writing.objectStore("cookies");
  for (const legacy of legacyCookies) cookieStore.delete(legacy.cookie_id);
  for (const row of sealedRows) cookieStore.put(row);
  const journalStore = writing.objectStore("cookie_journal");
  for (const row of journalRows.values()) journalStore.put(row);
  await new Promise((resolve, reject) => {
    writing.oncomplete = resolve;
    writing.onabort = () => reject(writing.error);
    writing.onerror = () => reject(writing.error);
  });
}

async function hydrateMigratedRecords(db) {
  const { profiles, mappings, cookies, journal } = await readHydrationState(db);
  const legacyCookies = cookies.filter(record => typeof record.legacy_state_json === "string");
  const staleMappings = mappings.filter(
    record => record.canonical_site === record.canonical_origin,
  );
  if (legacyCookies.length === 0 && staleMappings.length === 0) return db;
  const sites = await Promise.all(staleMappings.map(async record => ({
    key: [record.profile_id, record.canonical_origin],
    site: (await canonicalTarget(record.canonical_origin)).canonicalSite,
  })));
  const { cookieRows, journalRows } = collectLegacyCookieState(
    profiles,
    legacyCookies,
    journal,
  );
  const sealedRows = await Promise.all(
    cookieRows.map(({ profile, cookie }) => sealCookieRecord(profile, cookie)),
  );
  await writeHydratedRecords(db, sites, legacyCookies, sealedRows, journalRows);
  return db;
}

export function cookieIdentity(cookie) {
  return JSON.stringify([
    cookie.domain,
    cookie.path,
    cookie.name,
    cookie.partition_key ?? "",
  ]);
}

function cookieAAD(profileID, cookie) {
  return `zeroproxy-cookie-v2\0${profileID}\0${cookieIdentity(cookie)}`;
}

export async function sealCookieRecord(profile, cookie) {
  const key = await crypto.subtle.importKey("raw", profile.capability_root, "AES-GCM", false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(cookieAAD(profile.profile_id, cookie)) },
    key,
    new TextEncoder().encode(cookie.value),
  ));
  const { value: _value, ...metadata } = cookie;
  return {
    cookie_id: `${profile.profile_id}\0${cookieIdentity(cookie)}`,
    profile_id: profile.profile_id,
    ...metadata,
    encrypted_value: { nonce, ciphertext },
    access_seq: cookie.access_seq ?? cookie.creation_seq,
  };
}

export async function openCookieRecord(profile, record) {
  if (
    !record
    || record.profile_id !== profile.profile_id
    || !(record.encrypted_value?.nonce instanceof Uint8Array)
    || !(record.encrypted_value?.ciphertext instanceof Uint8Array)
  ) {
    throw new DOMException("Invalid encrypted cookie record", "DataError");
  }
  const key = await crypto.subtle.importKey("raw", profile.capability_root, "AES-GCM", false, ["decrypt"]);
  const value = new TextDecoder("utf-8", { fatal: true }).decode(await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: record.encrypted_value.nonce,
      additionalData: new TextEncoder().encode(cookieAAD(profile.profile_id, record)),
    },
    key,
    record.encrypted_value.ciphertext,
  ));
  const {
    cookie_id: _cookieID,
    profile_id: _profileID,
    encrypted_value: _encryptedValue,
    access_seq: _accessSeq,
    ...metadata
  } = record;
  return { ...metadata, value };
}

export async function openCoordinatorDatabase(
  name = COORDINATOR_DB_NAME,
  indexedDBFactory = indexedDB,
) {
  const opening = indexedDBFactory.open(name, COORDINATOR_DB_VERSION);
  opening.onupgradeneeded = event => migrateLegacySchema(opening.result, opening.transaction, event.oldVersion);
  const db = await request(opening);
  try {
    return await hydrateMigratedRecords(db);
  } catch (error) {
    db.close();
    throw error;
  }
}
