const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = 'test/fixtures/framework-compatibility';
const manifest = () => JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

test('framework compatibility fixtures cover planned frameworks', () => {
  const rows = manifest();
  const ids = new Set(rows.map((row) => row.id));
  for (const id of [
    'react-hydration',
    'next-vite-module-graph',
    'vue-reactivity',
    'angular-zone-timer',
    'webpack-dynamic-chunk',
  ])
    assert.equal(ids.has(id), true, id);
  assert.ok(rows.filter((row) => row.priority === 'p0').length >= 2);
});

test('framework compatibility fixtures have checked-in entry files and probes', () => {
  for (const row of manifest()) {
    const entry = path.join(root, row.entry);
    assert.ok(fs.existsSync(entry), `${row.id} missing entry`);
    const source = fs.readFileSync(entry, 'utf8');
    assert.ok(
      source.includes('data-fixture') ||
        source.includes('id="app"') ||
        source.includes('webpack-root'),
      `${row.id} missing visible probe`,
    );
    assert.ok(Array.isArray(row.surfaces) && row.surfaces.length > 0, `${row.id} surfaces`);
    assert.ok(row.expectedDelta, `${row.id} expectedDelta`);
  }
});
