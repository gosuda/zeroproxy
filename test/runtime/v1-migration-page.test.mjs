import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { initializeV1Migration } from "../../web/control/migrate-v1.mjs";

class FakeElement {
  constructor() {
    this.disabled = false;
    this.hidden = true;
    this.textContent = "";
    this.value = "";
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  async dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) await listener({ target: this, type });
  }
}

function migrationFixture() {
  const elements = Object.fromEntries(["proposal", "target-host", "approve", "reject", "delete-local", "status"].map((id) => [`#${id}`, new FakeElement()]));
  const record = { v: 1, url: "https://example.test/private?q=secret", expires_at: Date.parse("2026-09-01T00:00:00Z"), nonce: "0123456789abcdef" };
  const fragment = `#v1=${Buffer.from(JSON.stringify(record)).toString("base64url")}`;
  const events = new Map();
  const assigned = [];
  const replaced = [];
  const pageWindow = {
    location: {
      hash: fragment,
      pathname: "/migrate/v1",
      search: "?local=1",
      assign(value) { assigned.push(value); },
    },
    history: { replaceState(...args) { replaced.push(args); } },
    addEventListener(type, listener) { events.set(type, listener); },
  };
  return {
    assigned,
    elements,
    events,
    fragment,
    pageDocument: { querySelector(selector) { return elements[selector] ?? null; } },
    pageWindow,
    replaced,
  };
}

const beforeSunset = () => Date.parse("2026-08-01T00:00:00Z");

test("V1 migration inspects locally and rejection performs no external action", async () => {
  const fixture = migrationFixture();
  let fetches = 0;
  let clients = 0;
  let stores = 0;
  let mints = 0;
  initializeV1Migration({
    ...fixture,
    now: beforeSunset,
    fetchImpl: async () => { fetches += 1; throw new Error("unexpected fetch"); },
    createClient: () => { clients += 1; throw new Error("unexpected client"); },
    openNonceStore: async () => { stores += 1; throw new Error("unexpected store"); },
    mint: async () => { mints += 1; throw new Error("unexpected mint"); },
  });

  assert.deepEqual(fixture.replaced, [[null, "", "/migrate/v1?local=1"]]);
  assert.equal(fixture.pageWindow.location.hash, fixture.fragment, "the source link object is not mutated");
  assert.equal(fixture.elements["#target-host"].textContent, "example.test");
  assert.equal(fixture.elements["#proposal"].hidden, false);
  assert.deepEqual({ fetches, clients, stores, mints }, { fetches: 0, clients: 0, stores: 0, mints: 0 });

  await fixture.elements["#reject"].dispatch("click");
  await fixture.elements["#approve"].dispatch("click");
  assert.deepEqual({ fetches, clients, stores, mints }, { fetches: 0, clients: 0, stores: 0, mints: 0 });
  assert.match(fixture.elements["#status"].value, /No profile or relay request/);
});

test("approval consumes the nonce only after a fresh V2 profile and relay mint", async () => {
  const fixture = migrationFixture();
  const calls = [];
  let nonceState = "unused";
  const store = {
    async reserve(nonce) { calls.push(["reserve", nonce]); if (nonceState !== "unused") return false; nonceState = "pending"; return true; },
    async commit(nonce) { calls.push(["commit", nonce]); assert.equal(nonceState, "pending"); nonceState = "consumed"; },
    async release(nonce) { calls.push(["release", nonce]); nonceState = "unused"; },
    close() { calls.push(["close"]); },
  };
  const command = async (operation, payload) => {
    calls.push(["command", operation]);
    if (operation === "CREATE_PROFILE") return { profile_id: "profile", capability_epoch: 1 };
    assert.equal(operation, "APPROVE_RELAY_SET");
    assert.deepEqual(payload, { profile_id: "profile", relay_profile_digests: ["A".repeat(43)] });
    return { relay_profile_digests: ["A".repeat(43)], profile_ids: ["relay"] };
  };
  initializeV1Migration({
    ...fixture,
    now: beforeSunset,
    openNonceStore: async () => { calls.push(["open-store"]); return store; },
    createClient: () => ({ command, close() { calls.push(["close-client"]); } }),
    fetchImpl: async (url, init) => {
      calls.push(["fetch", url, init]);
      if (url === "/control/config.json") {
        return {
          ok: true,
          async json() {
            return {
              browse_domain: "example",
              installed_relay_profile_digests: ["A".repeat(43)],
            };
          },
        };
      }
      assert.equal(url, "/control/capability");
      const request = JSON.parse(init.body);
      assert.deepEqual(request, {
        origin: "https://o-test.browse.example",
        relay_profile_digest: "A".repeat(43),
        approved_visibility: true,
      });
      return { ok: true, async json() { return { capability_id: "approved" }; } };
    },
    verifyProfiles: async () => new Map([["A".repeat(43), { digest: "A".repeat(43) }]]),
    mint: async ({ issueRelayCapabilities, targetURL, profile }) => {
      calls.push(["mint", targetURL, profile.profile_id]);
      assert.equal(typeof issueRelayCapabilities, "function");
      assert.deepEqual(await issueRelayCapabilities("https://o-test.browse.example"), [{ capability_id: "approved" }]);
      return { destination: new URL("https://isolated.example/#handoff=fresh") };
    },
  });

  assert.equal(calls.length, 0, "inspection has no storage, worker, fetch, or mint side effect");
  await fixture.elements["#approve"].dispatch("click");
  assert.deepEqual(calls.map((call) => call[0]), ["open-store", "reserve", "fetch", "command", "command", "mint", "fetch", "commit"]);
  assert.equal(nonceState, "consumed");
  assert.deepEqual(fixture.assigned, ["https://isolated.example/#handoff=fresh"]);
});

test("local deletion closes opened migration resources after a failed mint", async () => {
  const fixture = migrationFixture();
  let closed = 0;
  const store = {
    async reserve() { return true; },
    async commit() { throw new Error("unexpected commit"); },
    async release() {},
    close() { closed += 1; },
  };
  initializeV1Migration({
    ...fixture,
    now: beforeSunset,
    openNonceStore: async () => store,
    createClient: () => ({ command: async () => ({ profile_id: "profile", capability_epoch: 1 }), close() { closed += 1; } }),
    fetchImpl: async () => { throw new DOMException("offline", "NetworkError"); },
    mint: async () => { throw new Error("unexpected mint"); },
  });

  await fixture.elements["#approve"].dispatch("click");
  assert.equal(fixture.elements["#approve"].disabled, false, "failed imports remain retryable");
  await fixture.elements["#delete-local"].dispatch("click");
  assert.equal(closed, 2, "nonce storage and coordinator client are both closed");
  assert.equal(fixture.elements["#proposal"].hidden, true);
  assert.equal(fixture.elements["#target-host"].textContent, "");
  assert.equal(fixture.elements["#status"].value, "Local import data deleted.");
});

test("migration decoder is absent from shipped bootstrap, runtime, worker, service-worker, and kernel artifacts", async () => {
  const root = new URL("../../dist/web/", import.meta.url);
  const version = JSON.parse(await readFile(new URL("_zp/version.json", root), "utf8"));
  const logicalAssets = ["runtime-prelude.js", "worker-bootstrap.mjs", "service-worker.mjs", "target-worker-host.mjs", "kernel.wasm"];
  const paths = [new URL("bootstrap.mjs", root), ...logicalAssets.map((name) => new URL(version.selectors[name].replace(/^\/+/, ""), root))];
  for (const path of paths) {
    const bytes = await readFile(path);
    const text = bytes.toString("latin1");
    assert.doesNotMatch(text, /(?:migrate-v1|v1-importer|import-nonce-store)\.mjs/, path.pathname);
  }
});
