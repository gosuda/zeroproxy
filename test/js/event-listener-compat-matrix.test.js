const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const matrix = () =>
  JSON.parse(fs.readFileSync('test/fixtures/event-listener-compat-matrix.json', 'utf8'));
const source = () =>
  [
    fs.readFileSync('web/runtime/dom/virtual-dom.mjs', 'utf8'),
    fs.readFileSync('web/runtime-prelude.mjs', 'utf8'),
    fs.readFileSync('web/runtime/facades/events.mjs', 'utf8'),
    fs.readFileSync('rewriter-rs/src/html/document.rs', 'utf8'),
    fs.readFileSync('test/js/virtual-dom.test.js', 'utf8'),
  ].join('\n');

const byId = (id) => matrix().find((row) => row.id === id);

test('event-listener compatibility matrix covers planned listener surfaces', () => {
  const ids = new Set(matrix().map((row) => row.id));
  for (const id of [
    'add-remove-identity',
    'listener-options',
    'dispatch-propagation-order',
    'inline-and-onproperty',
    'message-event-wrapping',
    'internal-listener-invisibility',
  ])
    assert.equal(ids.has(id), true, id);
});

test('event-listener compatibility matrix rows stay wired', () => {
  const text = source();
  for (const row of matrix()) {
    assert.ok(row.apis.length > 0, `${row.id} apis`);
    assert.ok(row.probes.length > 0, `${row.id} probes`);
    for (const needle of row.existingNeedles)
      assert.ok(text.includes(needle), `${row.id} missing ${needle}`);
  }
});

test('event-listener compatibility matrix records concrete identity/options/invisibility oracles', () => {
  for (const row of matrix()) {
    const oracle = row.behaviorOracle;
    assert.ok(oracle?.fixture, `${row.id} fixture`);
    assert.ok(
      Array.isArray(oracle.scenarios) && oracle.scenarios.length >= 4,
      `${row.id} scenarios`,
    );
    assert.ok(
      Array.isArray(oracle.expectedOrder) && oracle.expectedOrder.length >= 1,
      `${row.id} expectedOrder`,
    );
    assert.ok(Array.isArray(oracle.targetVisibleKeys), `${row.id} targetVisibleKeys`);
  }

  assert.equal(
    byId('add-remove-identity').behaviorOracle.scenarios.some(
      (scenario) =>
        scenario.case === 'duplicate-registration-deduped' && scenario.expectedCalls === 1,
    ),
    true,
  );
  assert.equal(
    byId('listener-options').behaviorOracle.scenarios.some(
      (scenario) =>
        scenario.case === 'passive-prevent-default' && scenario.expectedDefaultPrevented === false,
    ),
    true,
  );
  assert.deepEqual(byId('dispatch-propagation-order').behaviorOracle.expectedOrder, [
    'parent-capture',
    'target-capture',
    'target-bubble',
    'parent-bubble',
  ]);
  assert.equal(
    byId('inline-and-onproperty').behaviorOracle.scenarios.some(
      (scenario) => scenario.case === 'property-clear' && scenario.expectedCallsAfterClear === 0,
    ),
    true,
  );
  assert.deepEqual(byId('message-event-wrapping').behaviorOracle.expectedOrder, [
    'child-post',
    'parent-message',
  ]);
  assert.deepEqual(
    byId('internal-listener-invisibility').behaviorOracle.scenarios.find(
      (scenario) => scenario.case === 'ownKeys',
    ).forbiddenKeys,
    ['__zp', 'hiddenGlobalKey', 'messageListenerWrappers'],
  );
  assert.deepEqual(byId('internal-listener-invisibility').behaviorOracle.targetVisibleKeys, [
    'addEventListener',
    'removeEventListener',
    'dispatchEvent',
  ]);
});
