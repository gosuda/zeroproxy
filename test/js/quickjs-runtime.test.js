const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRuntime } = require('./quickjs-test-helpers.js');

test('QuickJS-NG source build evaluates classic scripts and modules', async () => {
  const runtime = await loadRuntime();
  assert.match(runtime.version, /^0\.15\./);
  const realm = runtime.createRealm();
  try {
    assert.equal(realm.evalClassic('6 * 7'), 42);
    const moduleResult = realm.evalModule(
      'globalThis.moduleValue = 13; export default "ok";',
      'fixture.mjs',
    );
    assert.equal(moduleResult.type, 'object');
    assert.equal(realm.getGlobal('moduleValue'), 13);
  } finally {
    realm.destroy();
  }
});

test('QuickJS eval errors include exception name and message', async () => {
  const runtime = await loadRuntime();
  const realm = runtime.createRealm();
  try {
    assert.throws(
      () => realm.evalClassic('throw new TypeError("missing api")', 'error-fixture.js'),
      (error) => {
        assert.equal(error.envelope.error, 'EVAL_FAILED');
        assert.equal(error.envelope.name, 'TypeError');
        assert.equal(error.envelope.message, 'missing api');
        assert.match(error.message, /EVAL_FAILED: TypeError: missing api/);
        return true;
      },
    );
  } finally {
    realm.destroy();
  }
});

test('QuickJS host ABI calls host functions and drains promise jobs', async () => {
  const runtime = await loadRuntime();
  const realm = runtime.createRealm();
  try {
    realm.defineHostFunction('hostAdd', (a, b) => a + b);
    assert.equal(realm.evalClassic('hostAdd(20, 22)'), 42);
    assert.equal(
      realm.evalClassic(
        'globalThis.done = 0; Promise.resolve().then(() => { done = hostAdd(4, 5); }); done',
      ),
      0,
    );
    assert.ok(realm.drainJobs() >= 1);
    assert.equal(realm.getGlobal('done'), 9);
  } finally {
    realm.destroy();
  }
});

test('QuickJS handle table preserves wrapper identity and tears down realms', async () => {
  const runtime = await loadRuntime();
  const realm = runtime.createRealm();
  const obj = realm.evalClassic('globalThis.obj = { answer: 42 }; obj');
  const same = realm.getGlobal('obj');
  assert.equal(obj, same);
  assert.equal(obj.get('answer'), 42);
  assert.equal(realm.refcount(obj), 2);
  assert.equal(obj.release(), true);
  assert.equal(realm.refcount(same), 1);
  assert.equal(same.release(), true);
  assert.equal(realm.refcount(same), 0);
  realm.destroy();
  assert.throws(() => realm.evalClassic('1'), /QUICKJS_REALM_DESTROYED/);
});
