const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const manifest = () =>
  JSON.parse(fs.readFileSync('test/fixtures/delivery-versioning-minification.json', 'utf8'));

test('delivery/versioning/minification manifest matches build surfaces', () => {
  const m = manifest();
  const build = fs.readFileSync('scripts/build.mjs', 'utf8');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(typeof pkg.version, 'string');
  assert.equal(m.packageVersionSource, 'package.json#version');
  assert.ok(build.includes('const minify = args.minify === true'));
  assert.ok(build.includes("case '--minify':"));
  assert.ok(build.includes(`const VERSION = '${m.rewriterVersion}';`));
  for (const asset of m.runtimeAssetNames)
    assert.ok(build.includes(asset) || fs.existsSync(`web/${asset}`), asset);
});

test('delivery/minification manifest keeps ABI-safe defaults explicit', () => {
  const m = manifest();
  assert.equal(m.bundling.hashNames, false);
  assert.equal(m.minification.default, false);
  assert.equal(m.minification.flag, '--minify');
  assert.match(m.minification.abiSafeRequirement, /stable/);
});
