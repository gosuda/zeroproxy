const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const matrix = () =>
  JSON.parse(fs.readFileSync('test/fixtures/observer-input-event-parity-matrix.json', 'utf8'));

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
