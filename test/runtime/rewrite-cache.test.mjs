import assert from "node:assert/strict";
import test from "node:test";

import { createBoundedRewriteCache } from "../../web/compiler-cache.mjs";

test("rewrite cache coalesces concurrent work and evicts LRU entries", async () => {
  let calls = 0;
  const cache = createBoundedRewriteCache({
    maxEntries: 2,
    maxBytes: 8,
    maxAgeMs: 1_000,
    sizeOf: value => value.length,
  });
  const factory = async () => {
    calls += 1;
    return "abcd";
  };
  assert.deepEqual(await Promise.all([
    cache.getOrCreate("one", factory),
    cache.getOrCreate("one", factory),
  ]), ["abcd", "abcd"]);
  assert.equal(calls, 1);
  await cache.getOrCreate("two", async () => "efgh");
  await cache.getOrCreate("one", factory);
  await cache.getOrCreate("three", async () => "ijkl");
  assert.equal(await cache.getOrCreate("two", async () => "recomputed"), "recomputed");
  assert.deepEqual(cache.snapshot(), { bytes: 8, entries: 2, inFlight: 0 });
});

test("rewrite cache expires entries and does not retain oversized values", async () => {
  let clock = 0;
  const cache = createBoundedRewriteCache({
    maxEntries: 2,
    maxBytes: 4,
    maxAgeMs: 10,
    now: () => clock,
    sizeOf: value => value.length,
  });
  await cache.getOrCreate("small", async () => "four");
  clock = 10;
  assert.equal(await cache.getOrCreate("small", async () => "next"), "next");
  assert.equal(await cache.getOrCreate("large", async () => "oversized"), "oversized");
  assert.deepEqual(cache.snapshot(), { bytes: 4, entries: 1, inFlight: 0 });
});

test("rewrite cache validates every hit and clears stale epoch work", async () => {
  let epoch = 1;
  let validVersion = 1;
  let release;
  const cache = createBoundedRewriteCache({
    epoch: () => epoch,
    maxAgeMs: 1_000,
    maxBytes: 64,
    maxEntries: 4,
    sizeOf: value => value.payload.length,
    validate: value => value.version === validVersion,
  });
  const first = cache.getOrCreate("same", () => new Promise(resolve => {
    release = resolve;
  }));
  epoch = 2;
  const second = await cache.getOrCreate("same", async () => ({ payload: "new", version: 1 }));
  release({ payload: "old", version: 1 });
  assert.deepEqual(await first, { payload: "old", version: 1 });
  assert.deepEqual(second, { payload: "new", version: 1 });
  assert.equal(cache.snapshot().entries, 1);

  validVersion = 2;
  let calls = 0;
  assert.deepEqual(await cache.getOrCreate("same", async () => {
    calls += 1;
    return { payload: "v2", version: 2 };
  }), { payload: "v2", version: 2 });
  assert.equal(calls, 1);
});

test("rewrite cache supports bounded synchronous compiler work", () => {
  let calls = 0;
  const cache = createBoundedRewriteCache({
    maxAgeMs: 1_000,
    maxBytes: 4,
    maxEntries: 1,
    sizeOf: value => value.length,
  });
  const factory = () => {
    calls += 1;
    return "code";
  };
  assert.equal(cache.getOrCreateSync("source", factory), "code");
  assert.equal(cache.getOrCreateSync("source", factory), "code");
  assert.equal(calls, 1);
  assert.equal(cache.snapshot().bytes, 4);
});
