# AGENTS.md - test

## OVERVIEW

JavaScript policy tests, Puppeteer e2e tests, and compatibility fixture corpus
for the browser membrane and build pipeline.

## STRUCTURE

```text
test/
+-- js/        # node:test policy, corpus, static, and build checks
+-- e2e/       # Puppeteer browser flow and representative-site manifests
`-- fixtures/  # JSON/HTML/SVG compatibility data
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Test runner behavior | `../scripts/test.mjs` | Canonical runner for JS and e2e. |
| Static membrane assertions | `js/static-policy.test.js`, `js/membrane-invariants.test.js` | Reads web sources directly. |
| Build and rewriter checks | `js/rewriter.test.js`, `js/compat-pipeline.test.js` | Often depends on build output. |
| Browser flow | `e2e/proxy.test.js`, `e2e/helpers.js` | Heavy Puppeteer surface. |
| Release/representative-site data | `e2e/*.json`, `fixtures/representative-sites/` | Corpus inputs, not generated output. |
| Compatibility matrices | `fixtures/*.json`, `fixtures/framework-compatibility/` | Keep schemas stable for tests. |

## CONVENTIONS

- Use `npm test`, `npm run test:js`, or `npm run test:e2e`; do not invoke
  `node --test test/js` or `node --test test/e2e` on the directory.
- `scripts/test.mjs` runs `node --test test/js/*.test.js` and
  `node --test test/e2e/*.test.js`; it retries e2e only for known transient
  browser/relay failures.
- Biome gives `test/**` Node globals and turns off
  `noExcessiveCognitiveComplexity` for test bodies. Production complexity gates
  are not relaxed by this.
- Fixture files are behavioral contracts. When changing a fixture matrix, update
  the corresponding test expectations in the same change.

## ANTI-PATTERNS

- Do not weaken or delete failing tests to make a build green.
- Do not treat a migrating timeout between the two heavy e2e tests as a
  deterministic regression without rerunning or isolating the test.
- Do not blanket-regenerate fixtures unless the corpus script or release gate is
  the explicit task.
- Do not place production membrane policy in tests only; tests should guard
  source behavior, not become hidden implementation state.
