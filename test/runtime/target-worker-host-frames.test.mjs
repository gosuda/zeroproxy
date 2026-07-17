import assert from "node:assert/strict";
import test from "node:test";
import { TargetWorkerHostFrames } from "../../web/control/target-worker-hosts.mjs";

function realm({ mutateReady = value => value } = {}) {
  const globalListeners = new Map();
  const frames = [];
  const eventTarget = {
    addEventListener(type, listener) { globalListeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (globalListeners.get(type) === listener) globalListeners.delete(type);
    },
  };
  const document = {
    documentElement: {
      append(frame) {
        frames.push(frame);
        queueMicrotask(() => frame.listeners.get("load")?.());
      },
    },
    createElement(name) {
      assert.equal(name, "iframe");
      const listeners = new Map();
      const frame = {
        contentWindow: {
          postMessage(message, targetOrigin) {
            frame.configuration = structuredClone(message);
            frame.targetOrigin = targetOrigin;
            queueMicrotask(() => globalListeners.get("message")?.({
              source: frame.contentWindow,
              origin: targetOrigin,
              data: mutateReady({ ...message, operation: "TARGET_WORKER_HOST_READY" }),
            }));
          },
        },
        hidden: false,
        listeners,
        referrerPolicy: "",
        removed: false,
        src: "",
        addEventListener(type, listener) { listeners.set(type, listener); },
        remove() { this.removed = true; },
      };
      return frame;
    },
  };
  const manager = new TargetWorkerHostFrames({
    crypto: { getRandomValues(bytes) { bytes.fill(frames.length + 1); return bytes; } },
    document,
    eventTarget,
    timeoutMS: 1_000,
  });
  return { frames, manager };
}

const destination = new URL("https://o-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.browse.example.test/#handoff=secret");

test("control shell retains one persistent target-worker host frame per bound synthetic origin", async () => {
  const { frames, manager } = realm();
  const first = await manager.ensure({ destination, profile_id: "profile", client_epoch: 7 });
  assert.equal(frames.length, 1);
  assert.equal(first.frame, frames[0]);
  assert.equal(frames[0].removed, false, "ready execution host remains owned by the control shell");
  assert.equal(frames[0].hidden, true);
  assert.equal(frames[0].referrerPolicy, "no-referrer");
  assert.equal(frames[0].src, `${destination.origin}/_zp/target-worker-host`);
  assert.equal(frames[0].targetOrigin, destination.origin);
  assert.deepEqual(frames[0].configuration, {
    v: 2,
    operation: "CONFIGURE_TARGET_WORKER_HOST",
    profile_id: "profile",
    synthetic_origin: destination.origin,
    client_epoch: 7,
    capability: first.capability,
  });
  assert.match(first.capability, /^[A-Za-z0-9_-]{43}$/u);

  const reused = await manager.ensure({ destination, profile_id: "profile", client_epoch: 7 });
  assert.equal(reused.frame, first.frame);
  assert.equal(frames.length, 1, "same binding does not create a transient replacement frame");

  const rotated = await manager.ensure({ destination, profile_id: "profile", client_epoch: 8 });
  assert.equal(frames.length, 2);
  assert.equal(first.frame.removed, true, "stale client epoch is removed before replacement");
  assert.equal(rotated.frame.removed, false);
  assert.notEqual(rotated.capability, first.capability);
});

test("control shell rejects a forged host readiness binding and removes the frame", async () => {
  const { frames, manager } = realm({ mutateReady: value => ({ ...value, client_epoch: value.client_epoch + 1 }) });
  await assert.rejects(
    manager.ensure({ destination, profile_id: "profile", client_epoch: 3 }),
    error => error?.name === "SecurityError",
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0].removed, true);
});
