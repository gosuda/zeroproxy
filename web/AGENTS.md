# AGENTS.md - web

## OVERVIEW

Browser shell, Service Worker, runtime membrane, and worker bootstrap sources.

## STRUCTURE

```text
web/
+-- index.html                 # browser control shell and inline bootstrap
+-- runtime-prelude.mjs        # large target-page runtime membrane
+-- runtime-prelude-entry.mjs  # Vite entry for runtime-prelude.js output
+-- worker-prelude.js          # worker membrane prelude
+-- worker-prelude-entry.mjs   # Vite entry for worker-prelude.js output
+-- sw.js                      # service-worker body bundled into sw.js output
+-- sw-entry.mjs               # Vite entry for service worker bundle
+-- sw/                        # service-worker modules
`-- runtime/                   # split membrane helpers and facades
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Page bootstrap / share route UI | `index.html` | Biome complexity override is file-scoped. |
| Runtime DOM/network/fingerprint membrane | `runtime-prelude.mjs`, `runtime/**` | Behavior-preserving edits need differential/browser evidence. |
| Worker interception | `worker-prelude.js`, `runtime/workers/` | One top-level Biome complexity ignore is intentional. |
| Service-worker routing | `sw.js`, `sw/**` | Complexity gate stays hard here. |
| Built browser output shape | `scripts/build.mjs` | Emits `dist/web/*.js`; source remains in `web/`. |
| Static policy tests | `test/js/static-policy.test.js`, `test/js/membrane-invariants.test.js` | Fast guardrail for membrane invariants. |

## CONVENTIONS

- `web/**` has Biome formatter disabled, but Biome lint still applies.
- Do not run broad formatting here. Keep hand-shaped membrane layout unless a
  dedicated differential-harness decomposition proves behavior preservation.
- `web/runtime-prelude.mjs` and `web/index.html` have file-level Biome
  complexity overrides. Every other production web file remains under the hard
  cognitive-complexity gate, including `sw.js`.
- `web/worker-prelude.js` has the only inline web complexity ignore. It covers
  wrapper-aggregate complexity; no inner function should exceed 15.
- Asset names matter: `runtime-prelude-entry.mjs` builds `runtime-prelude.js`,
  `worker-prelude-entry.mjs` builds `worker-prelude.js`, and `sw-entry.mjs`
  builds `sw.js`.

## ANTI-PATTERNS

- Do not add new Biome complexity ignores or widen the existing overrides.
- Do not edit generated `dist/web/` assets as source.
- Do not replace the npm build path with ad hoc Vite commands; `scripts/build.mjs`
  injects virtual sources for wasm, rust rewriter, and service-worker body.
- Do not treat a green `npm test` as enough for browser behavior changed here;
  run the specific JS/e2e/build surface that exercises the changed membrane.
