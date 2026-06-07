const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = 'test/fixtures/framework-compatibility';
const manifest = () => JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const readText = (file) => fs.readFileSync(file, 'utf8');
const localProbeFiles = (row) =>
  row.runner.networkProbes
    .filter((probe) => probe.startsWith('./'))
    .map((probe) => path.join(root, probe.slice(2)));
const fixtureSources = (row) =>
  [path.join(root, row.entry), ...localProbeFiles(row)].map((file) => readText(file)).join('\n');
const selectorNeedles = (selector) => {
  const fixtureMatch = selector.match(/^\[data-fixture="([^"]+)"\]$/);
  if (fixtureMatch)
    return [
      `data-fixture="${fixtureMatch[1]}"`,
      `dataset.fixture = '${fixtureMatch[1]}'`,
      `'data-fixture': '${fixtureMatch[1]}'`,
      `"data-fixture": "${fixtureMatch[1]}"`,
    ];
  const idMatch = selector.match(/^#([^\s]+)$/);
  if (idMatch) return [`id="${idMatch[1]}"`];
  return [selector];
};

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
  for (const row of rows) assert.ok(row.runner, `${row.id} runner`);
});

test('framework compatibility fixtures have checked-in entry files and probes', () => {
  for (const row of manifest()) {
    const entry = path.join(root, row.entry);
    assert.ok(fs.existsSync(entry), `${row.id} missing entry`);
    const source = readText(entry);
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

test('framework compatibility manifest records runnable local fixture coverage', () => {
  for (const row of manifest()) {
    const source = fixtureSources(row);
    assert.ok(row.runner.readySelector, `${row.id} readySelector`);
    assert.ok(row.runner.readyText, `${row.id} readyText`);
    assert.ok(Array.isArray(row.runner.consoleFailureClasses), `${row.id} consoleFailureClasses`);
    assert.ok(row.runner.consoleFailureClasses.length >= 2, `${row.id} consoleFailureClasses`);
    assert.ok(Array.isArray(row.runner.networkProbes), `${row.id} networkProbes`);
    assert.ok(row.runner.networkProbes.length >= 1, `${row.id} networkProbes`);
    for (const file of localProbeFiles(row))
      assert.ok(fs.existsSync(file), `${row.id} missing ${file}`);
    for (const probe of row.runner.networkProbes)
      assert.ok(source.includes(probe), `${row.id} missing probe ${probe}`);
    assert.ok(source.includes(row.runner.readyText), `${row.id} missing readyText`);
    assert.equal(
      selectorNeedles(row.runner.readySelector).some((needle) => source.includes(needle)),
      true,
      `${row.id} missing readySelector`,
    );
    for (const action of row.runner.actions || []) {
      assert.equal(action.type, 'click', `${row.id} action type`);
      assert.equal(
        selectorNeedles(action.selector).some((needle) => source.includes(needle)),
        true,
        `${row.id} missing action selector ${action.selector}`,
      );
      assert.ok(
        typeof action.expectedText === 'string' && action.expectedText.length > 0,
        `${row.id} action text`,
      );
    }
  }
});
