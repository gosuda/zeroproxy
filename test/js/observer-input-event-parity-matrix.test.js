const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const matrix = () =>
  JSON.parse(fs.readFileSync('test/fixtures/observer-input-event-parity-matrix.json', 'utf8'));

const byId = (id) => matrix().find((row) => row.id === id);

test('observer/input-event parity matrix covers planned surfaces', () => {
  const ids = new Set(matrix().map((row) => row.id));
  for (const id of [
    'mutation-observer',
    'intersection-observer',
    'resize-observer',
    'pointer-mouse-wheel',
    'keyboard-focus-composition',
    'touch-input-selection',
  ])
    assert.equal(ids.has(id), true, id);
});

test('observer/input-event parity matrix records probes and expected browser APIs', () => {
  for (const row of matrix()) {
    assert.ok(row.priority === 'p0' || row.priority === 'p1', `${row.id} priority`);
    assert.ok(row.probes.length >= 3, `${row.id} probes`);
    assert.ok(row.existingNeedles.length >= 2, `${row.id} browser API needles`);
  }
});

test('observer/input-event parity matrix records callback order and redacted telemetry metadata', () => {
  for (const row of matrix()) {
    const oracle = row.behaviorOracle;
    assert.ok(oracle?.fixture, `${row.id} fixture`);
    assert.ok(
      Array.isArray(oracle.callbackOrder) && oracle.callbackOrder.length >= 4,
      `${row.id} callbackOrder`,
    );
    assert.ok(
      oracle.redactedTelemetry && typeof oracle.redactedTelemetry === 'object',
      `${row.id} redactedTelemetry`,
    );
    const redacted = JSON.stringify(oracle.redactedTelemetry);
    for (const forbidden of oracle.forbiddenTelemetry || [])
      assert.equal(redacted.includes(forbidden), false, `${row.id} leaked ${forbidden}`);
  }

  assert.deepEqual(byId('mutation-observer').behaviorOracle.callbackOrder, [
    'sync-dom-write',
    'mutation-microtask',
    'promise-microtask-after-observe',
    'animation-frame',
  ]);
  assert.deepEqual(
    byId('intersection-observer').behaviorOracle.redactedTelemetry.thresholdBuckets,
    ['0', '0.5', '1'],
  );
  assert.deepEqual(byId('resize-observer').behaviorOracle.callbackOrder, [
    'style-write',
    'layout',
    'resize-callback',
    'animation-frame',
  ]);
  assert.deepEqual(byId('pointer-mouse-wheel').behaviorOracle.callbackOrder, [
    'pointerdown',
    'mousedown',
    'pointermove',
    'mousemove',
    'wheel',
    'pointerup',
    'mouseup',
    'click',
  ]);
  assert.equal(
    byId('keyboard-focus-composition').behaviorOracle.forbiddenTelemetry.includes('typedText'),
    true,
  );
  assert.equal(
    byId('touch-input-selection').behaviorOracle.forbiddenTelemetry.includes('selectedText'),
    true,
  );
});
