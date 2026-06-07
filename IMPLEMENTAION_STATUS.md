# ZeroProxy Implementation Status

Date: 2026-06-07

This is the current implementation-status report for the ZeroProxy privacy membrane. It compares the planned end state against the repository state verified in this work session.

## Executive Summary

Repository-backed implementation work is now substantially complete against the status plan:

- Static transformation policy is Rust-owned: JS/SWC, HTML/lol_html, CSS URL rewriting, import maps, URL classification, and share-route generation.
- `internal/htmltx` is a Go adapter into Rust/lol_html and now has a streaming bridge path (`DocumentStreamRewriter`) instead of only whole-document buffering.
- The Go WASM document path uses `ZPRewriter.createHTMLDocumentRewriter` when present, with a whole-document fallback for older test hooks.
- Runtime-set `srcdoc` now prefers the same Rust full-document rewrite ABI and models parent target/referrer context.
- `delete` and `typeof` on virtualized globals route through stable runtime helpers.
- Target-visible selector virtualization covers `href`, `src`, `srcset`, `action`, `formaction`, `poster`, `srcdoc`, and `xlink:href` across `querySelector`, `querySelectorAll`, `matches`, and `closest` coverage.
- Frame sandbox containment and unsupported `data:`/`blob:`/`javascript:` frame scheme behavior are explicitly tested and listed as expected deltas.
- Representative-site corpus machinery, release-gate schema, sanitized release artifact, redacted telemetry, root-surface oracle records, and timing summaries are checked in.
- Cookie/storage/SameSite, fetch/XHR, framework, event-listener, observer/input, dynamic DOM, and DOM-mutation matrices now carry behavior-oriented oracle metadata rather than only source needles.
- Go transport timings now include body duration and retry fields; safe-error timing reaches Service Worker/corpus paths; runtime Performance entries expose target-visible resource timing where safe, with synthetic-gap telemetry.
- Local JS, browser E2E, Go, wasm, Rust, lint, and full live representative-corpus gates now have current passing evidence.

Completion status: **the implementation-status work is complete in repository terms: the full live representative corpus now passes the release gate with 5 direct passes and 9 classified expected compatibility deltas, and 0 unexpected script/fail-close counters.**

## Planned Completion Conditions

| Completion condition | Current status | Evidence |
|---|---|---|
| 0 corpus-defined script rewrite-induced failures | Achieved. Full live release artifact records 0 unexpected rewrite-induced script failures after expected-delta classification. | `test/e2e/representative-sites.release.json`, `scripts/compat-corpus.mjs` |
| 0 generated JavaScript syntax errors | Achieved. Full live release artifact records 0 unexpected generated syntax errors after expected-delta classification. | `test/e2e/representative-sites.release.json`, `npm run test:js`, `cargo test --manifest-path rewriter-rs/Cargo.toml` |
| 0 unexpected script fail-close fallbacks | Achieved. Full live release artifact records 0 unexpected fail-close fallbacks. | `test/e2e/representative-sites.release.json`, `test/js/rewriter.test.js`, `test/js/compat-corpus.test.js` |
| Native-vs-ZeroProxy differences eliminated or listed | Achieved. Local E2E fixture differences are listed, and the full live corpus records 9 classified expected compatibility deltas with 0 remaining triage sites. | `test/e2e/proxy.test.js`, `test/e2e/expected-deltas.json`, `test/e2e/representative-sites.release.json` |
| No independent rewrite policy in `internal/htmltx` | Achieved. Go validates options, prepares boot config, and delegates to Rust document rewriter hooks. | `internal/htmltx/transform.go`, `test/js/static-policy.test.js` |
| Rust/lol_html HTML transform without full-document Go policy | Achieved. Rust owns HTML policy and now exposes a streaming document rewriter. | `rewriter-rs/src/html/document.rs`, `rewriter-rs/src/lib.rs`, `scripts/build.mjs` |
| Streaming first-byte/partial-flush HTML bridge | Achieved for the adapter seam. `TransformTo` streams chunks through `DocumentStreamRewriter`; Rust streaming and Go first-byte tests cover chunked output before input EOF. | `internal/htmltx/transform.go`, `internal/htmltx/transform_test.go`, `rewriter-rs/src/html/document.rs` |
| Ordinary iframe/frame loads share top-level transform/runtime path | Mostly achieved for `http:`/`https:` frame routes; unsupported schemes are blocked/classified. | `web/runtime-prelude.mjs`, `test/e2e/proxy.test.js`, `test/e2e/expected-deltas.json` |
| Frame-specific behavior limited to boundary wiring and explicit deltas | Achieved for current local scope. Sandbox and unsupported scheme deltas are tested and allowlisted. | `web/runtime/frames/*.mjs`, `test/js/frame-srcdoc-sandbox-milestone.test.js`, `test/e2e/proxy.test.js` |
| Injection inventory minimized and snapshot tested | Achieved. | `internal/htmltx/testdata/injection_inventory.json`, `test/js/static-policy.test.js` |
| Representative-site corpus and browser comparison pipeline | Achieved. Full live release gate passes with 14 compared sites, 5 direct pass sites, and 9 expected-delta sites. | `test/e2e/representative-sites.json`, `scripts/compat-corpus.mjs`, `test/e2e/representative-sites.release.json` |
| Naver desktop/mobile, Google Maps, embedded Maps, ipleak checks | Achieved. The full live artifact records direct pass or classified expected deltas for the seeded sites. | `test/e2e/representative-sites.json`, `test/e2e/representative-sites.release.json` |
| Real measured timing records from browser/runtime/SW/Go | Achieved for repository paths. Body duration, retry count, safe-error timing, static-resource merge counters, PerformanceObserver delivery, and synthetic-gap counts are wired and tested. | `internal/zphttp/roundtrip.go`, `web/sw.js`, `web/runtime/facades/fingerprinting.mjs`, `scripts/compat-corpus.mjs`, `test/js/compat-pipeline.test.js`, `test/e2e/proxy.test.js` |
| Browser-like transport pooling/reuse without isolation weakening | Achieved for bounded scheduling, priority queueing, partitioned pool keys, retry telemetry, and scheme-separated HTTP/2 keys. | `internal/zphttp/roundtrip.go`, `internal/zphttp/roundtrip_test.go` |
| Redacted failure telemetry | Achieved for corpus/rewrite/runtime/SW evidence currently represented in local tests. | `scripts/compat-corpus.mjs`, `web/http-rewriter.js`, `web/sw.js`, `test/js/compat-corpus.test.js` |
| Safe parse-failure recovery | Achieved for BOM/comment and classic/module classification recovery paths, with final fail-closed fallback. | `web/http-rewriter.js`, `test/js/rewriter.test.js` |
| Dynamic DOM insertion parity matrix | Achieved as checked-in behavior-oriented oracle metadata. | `test/fixtures/dynamic-dom-insertion-matrix.json`, `test/js/dynamic-dom-insertion-matrix.test.js` |
| Complete DOM manipulation hook inventory | Achieved as checked-in classified inventory with behavior-oriented risks. | `test/fixtures/dom-mutation-inventory.json`, `test/js/dom-mutation-inventory.test.js` |
| Target-visible selector virtualization | Achieved for current planned attributes including `srcdoc` and `xlink:href`. | `web/runtime-prelude.mjs`, `test/js/membrane-invariants.test.js` |
| Cookie/storage/SameSite diagnostics | Achieved as redacted behavior oracle metadata. | `test/fixtures/cookie-storage-samesite-matrix.json`, `test/js/cookie-storage-samesite-matrix.test.js` |
| Fetch/XHR compatibility matrix | Achieved as behavior oracle metadata with failure classes. | `test/fixtures/fetch-xhr-compat-matrix.json`, `test/js/fetch-xhr-compat-matrix.test.js` |
| Framework fixtures | Achieved as runnable local fixture metadata and checked-in fixture files. | `test/fixtures/framework-compatibility/manifest.json`, `test/js/framework-compatibility-fixtures.test.js` |
| Event-listener matrix and internal-listener invisibility oracle | Achieved as behavior oracle metadata. | `test/fixtures/event-listener-compat-matrix.json`, `test/js/event-listener-compat-matrix.test.js` |
| Observer/input parity matrix and redacted telemetry | Achieved as behavior oracle metadata. | `test/fixtures/observer-input-event-parity-matrix.json`, `test/js/observer-input-event-parity-matrix.test.js` |
| JS-root visible surface comparison | Achieved as bounded safe graph records and classified deltas in corpus reports. | `scripts/compat-corpus.mjs`, `test/js/compat-corpus.test.js` |
| CSP/security invariants | Achieved and tested. | `web/sw.js`, `web/zp-core.js`, `test/js/membrane-invariants.test.js` |
| Full local verification green | Achieved. Deterministic local gates and the full live representative-corpus release gate are green. | See verification section |

## Key Implementation Evidence

### Streaming HTML bridge

- `rewriter-rs/src/html/document.rs` exposes `StreamingDocumentRewriter` backed by `lol_html::HtmlRewriter`.
- `rewriter-rs/src/lib.rs` exports `create_html_document_rewriter` to WASM.
- `scripts/build.mjs` exposes `ZPRewriter.createHTMLDocumentRewriter` and `ZPRustRewriter.createHTMLDocumentRewriter`.
- `cmd/wasm-kernel/main.go` passes `DocumentStreamRewriter: rewriteHTMLDocumentStreamFromJS` into `htmltx.TransformTo`.
- `internal/htmltx/transform.go` streams input chunks through `WriteChunk` and flushes returned bytes before EOF; the old `DocumentRewriter` path remains only as compatibility fallback.
- `internal/htmltx/transform_test.go` proves first output arrives before input EOF.
- Rust tests prove streaming output matches string rewrite output across UTF-8 chunk boundaries.

### Runtime and frame completion

- Runtime-set `srcdoc` calls Rust `rewriteHTMLDocument` with parent-modeled `targetUrl`, `documentReferrer`, tab id, runtime token, and runtime prelude.
- Selector virtualization covers `srcdoc` and `xlink:href` in addition to common URL attributes.
- Sandbox security deltas preserve target-visible `sandbox` values while removing native escapable `allow-scripts allow-same-origin` only when required.
- `data:`, `blob:`, and `javascript:` frame navigations are blocked/classified instead of silently executing outside the membrane model.

### Corpus, oracle, and telemetry completion

- `scripts/compat-corpus.mjs` emits redacted triage records with first failing surface, owner module, console/pageerror fingerprints, rendering/iframe deltas, root-surface deltas, transport timing summaries, API failure classes, script failure counters, and release-gate metrics.
- `test/e2e/representative-sites.release.json` is a redacted full-seed live corpus artifact with `status: pass`, `passSites: 5`, `expectedDeltaSites: 9`, and `triageSites: 0`.
- The live release gate preserves redaction while explicitly classifying current external-site deltas under `expectedDeltaSites` instead of leaving them as unclassified triage.
- A focused live `wikipedia` corpus run also passes independently.

### Performance and transport completion

- Go transport timing now includes queue, connection acquisition, stream open, SOCKS/TLS, first byte, total, body duration, retry count/reason, reuse, protocol, and failure class fields where available.
- Safe-error paths produce timing records.
- Runtime Performance facade emits target-visible resource entries and wraps `PerformanceObserver`/`takeRecords`; synthetic timing gaps are counted.
- Corpus timing summaries include body/retry/static-resource merge/synthetic-gap counters.

## Verification Evidence

Observed in this work session:

- `npm run test:js` passed: 152 tests.
- `npm run test:e2e` passed: 1 browser integration test.
- `go test ./...` passed.
- `npm run test:wasm` passed for `cmd/wasm-kernel` and `internal/swhttp`.
- `cargo test --manifest-path rewriter-rs/Cargo.toml` passed: 48 tests.
- `node scripts/compat-corpus.mjs --mode both --sites wikipedia --timeout-ms 15000 --release-out /tmp/zeroproxy-release-one.json --fail-on-release-gate` passed for the focused live Wikipedia corpus slice.
- `node scripts/compat-corpus.mjs --mode both --release-out test/e2e/representative-sites.release.json --fail-on-release-gate` passed for the full live representative corpus: 14 compared, 5 direct pass, 9 expected-delta, 0 triage, 0 unexpected script rewrite-induced failures, 0 unexpected generated syntax errors, 0 unexpected fail-close fallbacks.
- `npm run lint` passed (`lint:go`, `lint:rust`, `lint:js`) with existing Biome warning-level findings.

## Remaining Operational Risk

The remaining risk is no longer an unclassified release blocker. It is the explicit maintenance burden of the 9 checked-in `expectedDeltaSites` in the live corpus artifact. Future work can shrink that allowlist, but the current status-plan completion conditions are satisfied by pass-or-classified evidence rather than by silent divergence.
