import assert from "node:assert/strict";
import test from "node:test";
import { approveAndMint, createV1Importer, inspectV1Fragment, V1_IMPORT_SUNSET } from "../../web/control/v1-importer.mjs";

function fragment(value) {
  return "#v1=" + Buffer.from(JSON.stringify(value)).toString("base64url");
}

function memoryNonceStore(states = new Map()) {
  return {
    async reserve(nonce) {
      if (states.has(nonce)) return false;
      states.set(nonce, "pending");
      return true;
    },
    async commit(nonce) {
      if (states.get(nonce) !== "pending") throw new DOMException("reservation lost", "InvalidStateError");
      states.set(nonce, "consumed");
    },
    async release(nonce) {
      if (states.get(nonce) === "pending") states.delete(nonce);
    }
  };
}

test("migration is local until explicit approval", async () => {
  const input = inspectV1Fragment(fragment({v:1,url:"https://example.test/path",expires_at:2000,nonce:"0123456789abcdef"}), 1000);
  let calls = 0;
  assert.deepEqual(await approveAndMint(input, false, async () => { calls++; }), {approved:false});
  assert.equal(calls, 0);
  const result = await approveAndMint(input, true, async request => { calls++; return request.targetURL; });
  assert.equal(result.result, "https://example.test/path");
  assert.equal(calls, 1);
});

test("migration rejects malformed expired and unsafe input", () => {
  assert.throws(() => inspectV1Fragment("#v1=%%%"), {name:"DataError"});
  assert.throws(() => inspectV1Fragment(fragment({v:1,url:"https://u:p@example.test",nonce:"0123456789abcdef"})), {name:"SecurityError"});
  assert.throws(() => inspectV1Fragment(fragment({v:1,url:"https://example.test",expires_at:999,nonce:"0123456789abcdef"}), 1000), {name:"InvalidStateError"});
  assert.throws(() => inspectV1Fragment(fragment({v:2,url:"https://example.test",nonce:"0123456789abcdef"})), {name:"NotSupportedError"});
});

test("migration-oversize rejects before decoding", () => {
  assert.throws(() => inspectV1Fragment("#v1=" + "A".repeat(16 * 1024 + 1)), {name:"DataError"});
});

test("migration-replay consumes nonce exactly once", async () => {
  const importer = createV1Importer({now: () => 1000, mint: async ({targetURL}) => targetURL, nonceStore: memoryNonceStore()});
  const input = importer.inspect(fragment({v:1,url:"https://example.test",nonce:"replay-nonce-0001"}));
  await importer.approve(input, true);
  await assert.rejects(importer.approve(input, true), {name:"InvalidStateError"});
});

test("migration-fragment-privacy performs no request or log before approval", async () => {
  const observations = [];
  const importer = createV1Importer({now: () => 1000, mint: async request => { observations.push(request); }, nonceStore: memoryNonceStore()});
  const input = importer.inspect(fragment({v:1,url:"https://secret.example/path?q=private",nonce:"privacy-nonce-001"}));
  assert.deepEqual(observations, []);
  await importer.approve(input, false);
  assert.deepEqual(observations, []);
});

test("migration mint failure rolls back nonce consumption", async () => {
  let attempts = 0;
  const importer = createV1Importer({now: () => 1000, nonceStore: memoryNonceStore(), mint: async () => {
    attempts++;
    if (attempts === 1) throw new Error("mint failed");
    return "v2-share";
  }});
  const input = importer.inspect(fragment({v:1,url:"https://example.test",nonce:"rollback-nonce-01"}));
  await assert.rejects(importer.approve(input, true), /mint failed/);
  assert.equal((await importer.approve(input, true)).result, "v2-share");
});

test("migration-sunset disables decoding and minting exactly at sunset", async () => {
  let now = V1_IMPORT_SUNSET - 1;
  const importer = createV1Importer({now: () => now, mint: async () => "ok", nonceStore: memoryNonceStore()});
  const raw = fragment({v:1,url:"https://example.test",nonce:"sunset-nonce-0001"});
  const input = importer.inspect(raw);
  now = V1_IMPORT_SUNSET;
  assert.throws(() => importer.inspect(raw), {name:"NotSupportedError"});
  await assert.rejects(importer.approve(input, true), {name:"NotSupportedError"});
});

test("incompatible V1 artifacts are never read", () => {
  for (const extra of ["cookies", "storage", "profile_id", "relay_capability", "history"]) {
    assert.throws(() => inspectV1Fragment(fragment({v:1,url:"https://example.test",nonce:"incompatible-0001",[extra]:{}})), {name:"NotSupportedError"});
  }
});

test("migration nonce state survives importer recreation and rejects concurrent reserve", async () => {
  const states = new Map();
  const first = createV1Importer({now: () => 1000, mint: async () => "ok", nonceStore: memoryNonceStore(states)});
  const second = createV1Importer({now: () => 1000, mint: async () => "unexpected", nonceStore: memoryNonceStore(states)});
  const input = first.inspect(fragment({v:1,url:"https://example.test",nonce:"durable-nonce-001"}));
  await first.approve(input, true);
  await assert.rejects(second.approve(input, true), {name:"InvalidStateError"});

  const pendingStates = new Map();
  let releaseMint;
  const waitingMint = new Promise(resolve => { releaseMint = resolve; });
  const a = createV1Importer({now: () => 1000, mint: () => waitingMint, nonceStore: memoryNonceStore(pendingStates)});
  const b = createV1Importer({now: () => 1000, mint: async () => "unexpected", nonceStore: memoryNonceStore(pendingStates)});
  const pendingInput = a.inspect(fragment({v:1,url:"https://example.test",nonce:"concurrent-nonce1"}));
  const pendingApproval = a.approve(pendingInput, true);
  await assert.rejects(b.approve(pendingInput, true), {name:"InvalidStateError"});
  releaseMint("ok");
  await pendingApproval;
});
