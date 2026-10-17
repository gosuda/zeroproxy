# zp-page-rt: Historical Trap Category Summary

**Historical record** concerning raw `extern "C"` exports, linear memory management, and associated URL rewriting paths in `crates/zp-page-rt` and `web/zp-rt.js`; **not a currently approved specification**. All measurements and verifications reflect results at the time of recording, with no new runtime execution performed during this documentation pass. Previously proposed tests and implementation gaps are historical notes rather than active TODOs. Subsequent corrections supersede earlier hypotheses, and localized regression checks do not imply resolution of broader GitHub, Cloudflare, or CNN compatibility issues.

Background: [.ai/zp-page-rt-design.md](../zp-page-rt-design.md), [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md).

<a id="2026-05-30-scratchpad-mid-classify-call-silent-overwrite-wasm-trap"></a>
## 2026-05-30: Mid-batch scratchpad overwrite

- **Cause:** Calling `rt.classOf()` after JS had written `[lens][bytes][out]` into the shared scratchpad caused `writeScratch()` to overwrite the buffer from offset 0. The subsequent batch call interpreted URL bytes as huge lengths and triggered a WASM bounds trap.
- **Fix and rule:** Perform any warmup calls first and populate the scratch layout immediately before invoking the bulk WASM export. Never interleave other WASM calls between writing scratch memory, invoking the export, and reading the result.
- **Evidence and status:** Found in [test/bench/url-classify.bench.mjs](../../test/bench/url-classify.bench.mjs) batch benchmarks. Proposals for an atomic `withScratch()` helper or a secondary scratch buffer were historical suggestions without implementation records.

<a id="2026-05-30-memorygrow-all-uint8array-views-detach"></a>
## 2026-05-30: `memory.grow` detaches cached typed array views

- **Cause:** When the WASM allocator grew linear memory, the existing `ArrayBuffer` detached, invalidating cached `Uint8Array` views.
- **Fix and rule:** `memU8()` in `web/zp-rt.js` checks whether `ex.memory.buffer` changed and recreates both the full view and the scratch subarray. Never cache typed array views across WASM calls in long-lived outer variables.
- **Evidence and status:** Required across all hot paths and `test/bench/url-classify.bench.mjs`. Any code reading WASM memory after a call must re-check the buffer reference.

<a id="2026-05-30-static-mut-direct-ref-rust-2024-edition-lint-failure"></a>
## 2026-05-30: `static mut` shared reference lint in Rust 2024

- **Cause:** Expressions such as `SCRATCH.0.as_ptr()` created an implicit shared reference to a `static mut`, failing Rust 2024 edition lints.
- **Fix and rule:** Obtain raw pointers via `addr_of!(SCRATCH)` without creating an intermediate reference.
- **Evidence and status:** `crates/zp-page-rt/src/lib.rs:46`; see [Rust 2024 static-mut-references](https://doc.rust-lang.org/edition-guide/rust-2024/static-mut-references.html).

<a id="2026-05-30-thread_local-const-non-const-constructor-conflict"></a>
## 2026-05-30: `thread_local!` `const` initializer conflict

- **Cause:** The inner builder inside `const { RefCell::new(UrlPool::new()) }` in `thread_local!` was non-`const` under the toolchain at the time, failing compilation.
- **Fix and rule:** Removed `const {}` in favor of lazy initialization on first access. Whether `const` initialization compiles depends on the entire constructor chain and active Rust toolchain.
- **Status:** Historical build fix; do not generalize remarks about `HashMap` const constructors to all Rust versions.

<a id="2026-05-30-no_std-extern-crate-alloc-alone-wasm32-build-fails"></a>
## 2026-05-30: Missing allocator when building `wasm32` with `no_std` + `alloc` alone

- **Cause:** `extern crate alloc` provides collection types but neither a `#[global_allocator]` nor a `#[panic_handler]`, causing the initial PoC build to fail.
- **Fix and rule:** Switched the PoC to `std` with default `dlmalloc` and workspace `panic = "abort"`.
- **Status:** Reintroducing `no_std` with a custom allocator and panic handler remained an unverified size-optimization candidate.

<a id="2026-05-30-headless-chrome-textencoderencodeinto-node-v8-vs-355-slower"></a>
## 2026-05-30: Headless Chrome `TextEncoder.encodeInto` overhead

- **Cause and hypothesis:** `TextEncoder.encodeInto` in headless Chrome measured slower than in Node V8, attributed to Blink binding and `page.evaluate` realm overhead.
- **Rule:** Absolute microbenchmark numbers are environment-dependent; evaluate browser hot paths using headless browser measurements rather than Node benchmarks alone.
- **Evidence and status:** [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md) Section 2.1. Later encoder isolation confirmed the speed gap without proving the exact internal Blink mechanism.

<a id="2026-05-30-wasm-bindgen-output-raw-extern-c-cdylib-coexistence-dead-strip-risk"></a>
## 2026-05-30: Separating raw `cdylib` exports from `wasm-bindgen` post-processing

- **Anticipated risk:** Combining raw `extern "C"` exports and `wasm-bindgen` in the same `cdylib` risked dead-stripping raw exports or conflicting initialization order during `wasm-bindgen` post-processing.
- **Mitigation:** Kept `zp-page-rt` as a separate raw `cdylib` instantiated directly via `WebAssembly.instantiate()`, while `zp-bundle` retained `wasm-bindgen`.
- **Evidence and status:** `build.mjs` processes `zp_bundle*.wasm`/`.js` separately from copy-only `zp_page_rt.wasm`.

<a id="2026-05-30--classifybatch-single-pass--ascii-fast-path--result-no-copy--lens-manual-write"></a>
## 2026-05-30: `classifyBatch` alignment layout, allocation, and result lifetime

- **Cause:** Placing the `out` array after variable-length `bytes` broke 4-byte alignment for `Uint32Array`, while per-string temporary buffers and result copies added allocation overhead.
- **Fix and rule:** Laid out the scratch buffer as `[lens 4N][out 4N][bytes]` using aligned Rust scratch memory, with single-pass ASCII encoding, a grow-on-demand length cache, and manual little-endian writes. Callers **must consume the raw result view before the next WASM call**.
- **Evidence and status:** [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md) Section 3.7. In production, single-URL `schemeOnly` calls outperformed batching unless interning/handles were needed; later `schemeOnly` records supersede early MutationObserver batching notes.

<a id="2026-05-30-textencoderencodeinto-chrome-charcodeat-loop-vs-237-slower-blink-cross-realm-cost-ascii-fast-path-production-applied"></a>
## 2026-05-30: ASCII encoder fast path

- **Cause:** Isolation benchmarks showed manual `charCodeAt` loops outperforming native `TextEncoder.encodeInto` in Chrome while Node showed the reverse.
- **Fix and rule:** Applied an ASCII `charCodeAt` copy fast path in `writeScratch` and `classifySchemeOnly` in [web/zp-rt.js](../../web/zp-rt.js), falling back to `encodeInto` on the first non-ASCII code unit without assuming URLs are purely ASCII.
- **Evidence and status:** [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md) Section 3.6; `encodeManual`/`encodeAsciiFast` in `url-classify.bench.mjs` and `.browser.mjs`.

<a id="2026-05-30-runtime-prelude-integration-pattern-recipe-213-trap-catalog"></a>
## 2026-05-30: `runtime-prelude` integration invariants

- **Cause and fix:** Provided an `rt = null` JS fallback before async RT load completes or if loading fails. Cleared the MutationObserver per-tick cache in a `finally` block and avoided caching HTTP/WS classifications by enum alone because callers require the canonicalized target URL.
- **Invariants:** Preserve the `urlMeta: el to target string` contract while keeping raw-to-target caching in a separate `urlClassifyCache`. `build.mjs` must concatenate `zp-rt.js` before the prelude, and `/__zp/zp_page_rt.wasm` must remain on the [Go static asset allowlist](../../cmd/zeroproxy-server/main.go#L120) so policy checks do not block it.
- **Historical implementation:** Applied single-parse `targetURLIfHTTP`, MutationObserver non-HTTP pre-classification, and `targetURLForElement` reuse in [web/runtime-prelude.js](../../web/runtime-prelude.js).
- **Verification:** [static-policy](../../test/js/static-policy.test.js) and [workspace tests](../../Cargo.toml) passed at the time.
- **References:** [.ai/zp-page-rt-design.md](../zp-page-rt-design.md), [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md), [.ai/zp-page-rt-applicability.md](../zp-page-rt-applicability.md).

<a id="2026-05-30-scheme-only-fast-path-length-flatness-except-short-url-no-savings"></a>
## 2026-05-30: Bounded-length `schemeOnly` probe

- **Cause and fix:** Passed only the first 16 bytes to `url_classify_scheme_only` to avoid `O(N)` full-string encoding costs when checking URL schemes, with Rust bounds checks for empty or oversized inputs.
- **Observation and correction:** Initial measurements confirmed flat cost on long URLs, and subsequent ASCII fast-path encoding resolved the overhead on short URLs in Chrome.
- **Evidence and status:** `crates/zp-page-rt/src/lib.rs`, `web/zp-rt.js`; [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md) Section 3.5.

<a id="2026-05-30-js-regex-raw-string-wasm-faster-in-general"></a>
## 2026-05-30: Rejecting naive 1:1 replacement of JS regex helpers with raw-string WASM

- **Cause:** Simple regular expressions execute in V8's native JIT without string-encoding or WASM boundary overhead.
- **Rule and correction:** Do not mechanically replace one-shot JS string helpers with WASM calls unless work is amortized across handles or combined with the ASCII `schemeOnly` fast path.
- **Evidence and status:** [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md).

<a id="2026-05-30-mo-callback-tickurlcache-lifecycle-throw-safety-gap"></a>
## 2026-05-30: MutationObserver `tickUrlCache` throw-safety scope

- **Cause:** Creating `tickUrlCache` and running the `schemeOnly` pre-pass outside the main `try/finally` block left the per-tick cache alive if a WASM trap occurred.
- **Fix and rule:** Wrapped the entire pre-classification and main loop in an outer `try/finally` and caught per-URL WASM errors so individual failures fall back to JS classification. Match cleanup scope to allocation scope.
- **Evidence and status:** [web/runtime-prelude.js:2415-2435](../../web/runtime-prelude.js#L2415-L2435), [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md) Section 3.7.

<a id="2026-05-30-classifyschemeonly-like-internal-sub-api-external-sanity-script-inaccessible"></a>
## 2026-05-30: Instance-scoped `classifySchemeOnly` API boundary

- **Cause:** `globalThis.ZeroProxyRT` exposes only `load` and `UrlClass`, whereas `classifySchemeOnly` lives on the loaded runtime instance.
- **Rule:** Retain the instance returned by `load()` in benchmark or sanity scripts rather than exposing internal scratch buffers on the global object.
- **Evidence and status:** Export surface in [web/zp-rt.js](../../web/zp-rt.js).

<a id="2026-05-30-hook-chain-helper-fn-like-derived-val-localkey-tag-n-recompute"></a>
## 2026-05-30: Deduplicating derived `localKey` and `tag` across attribute hook chains

- **Cause:** Attribute hook chains repeatedly computed `attrLocalName`, native `localName`, and `usesRawURLAttribute` for the same arguments, dominating URL classification time.
- **Fix and rule:** Computed `localKey`, `tag`, and `usesRaw` once in `setAttribute`/`setAttributeNS`/`getAttribute`/`removeAttribute` and forwarded them as optional parameters, checking `!= null` so empty strings remain valid.
- **Evidence and status:** [web/runtime-prelude.js:1448, 1962-2003, 2029-2057, 2284](../../web/runtime-prelude.js), [bench report Section 3.9](../zp-page-rt-bench-report.md#39-t-round-element-specific-path-setattribute-hook-chain-attrlocalname-localname-duplicate).

<a id="2026-05-30-mo-record-path-enforceobservedattribute-usesrawurlattribute-3x-duplicate-call"></a>
## 2026-05-30: Deduplicating helper calls in MutationObserver `enforceObservedAttribute`

- **Cause:** `enforceObservedAttribute` called `usesRawURLAttribute` three times per record and recomputed `localKey` inside `isSVGURLBearing`.
- **Fix and rule:** Cached the `usesRaw` boolean and passed precomputed `localKey` and `tag` through the helper chain.
- **Evidence and status:** [web/runtime-prelude.js:2454-2496, 2284](../../web/runtime-prelude.js), [bench report Section 3.10](../zp-page-rt-bench-report.md#310-t2-round-mo-record-path-enforceobservedattribute-issvgurlbearing).

<a id="2026-05-30-zp-htmltx-same-helper-chain-duplicate-pattern-to_ascii_lowercase-per-attribute-lol_html-lowercase-invariant-dependency"></a>
## 2026-05-30: Avoiding per-attribute lowercase allocations in `zp-htmltx`

- **Cause:** Every URL scheme check allocated a lowercased copy and recomputed the element tag name per attribute.
- **Fix and invariant:** Shared byte-prefix `starts_with_ascii_ci` and `is_inert_scheme` helpers in [crates/zp-htmltx/src/lib.rs](../../crates/zp-htmltx/src/lib.rs) and read the element tag once per element. Note that relying on `lol_html` tag/attribute normalization requires care around case-sensitive SVG attributes.
- **Verification and correction:** Early notes treating missing `xlink:href` rewriting as benign were **superseded in August when static SVG subresource holes were fixed**.
- **Reference:** [bench report Section 4](../zp-page-rt-bench-report.md#4-zp-htmltx-handle-pipeline).

<a id="2026-05-30-wasm-handle-pipeline-zp-htmltx-zp-page-rt-true-shared-memory-impossible-recipe-5-marginal-value-limit"></a>
## 2026-05-30: Evaluating cross-instance handle sharing between Service Worker and page

- **Cause:** `zp-htmltx` in the Service Worker and `zp-page-rt` in the page run in separate WASM instances with separate linear memories and pools. **Handles from one instance must never be dereferenced in another.**
- **Security and design:** Raw target URLs are already stashed via `data-zp-target-url`. Sharing memory via `SharedArrayBuffer` would require `COOP`/`COEP` headers that conflict with target compatibility, so cross-realm shared-memory handle pipelines were rejected.
- **Reference:** [bench report Section 4.2](../zp-page-rt-bench-report.md#42-wasm-handle-pipeline-roi).

<a id="2026-05-30-server-side-criterion-bench-inline-script-oxc-parse-hot-path-hypothesis-rejected-real-hot-path-subresource-processing"></a>
## 2026-05-30: Criterion benchmark refuted inline-script OXC hot-path hypothesis

- **Cause and refutation:** In the Criterion HTML transform fixture, dispatching and rewriting URL-bearing subresource elements dominated throughput rather than inline script parsing.
- **Fix:** Applied lazy attribute filtering, streaming percent-encoding, and case-insensitive ASCII scheme checks to the subresource path.
- **Evidence and status:** [bench report Section 4.4](../zp-page-rt-bench-report.md#44-v-round-server-side-throughput-criterion-bench-hot-path), [crates/zp-htmltx/benches/transform.rs](../../crates/zp-htmltx/benches/transform.rs).

<a id="2026-05-30-format-per-element-utf8_percent_encodeto_string-server-side-hot-path-real-cost-v-round"></a>
## 2026-05-30: Eliminating temporary allocations in the Rust URL builder

- **Cause:** Undersized string capacities, intermediate `.to_string()` allocations during percent-encoding, repeated `format!()` calls, and base-URL lowercasing accumulated per-element overhead.
- **Fix:** Updated [crates/zp-htmltx/src/lib.rs](../../crates/zp-htmltx/src/lib.rs) to preallocate capacity, push percent-encoder chunks directly into the output `String`, use ASCII case-insensitive prefix checks, and split query/fragment in a single pass.
- **Evidence and status:** [bench report Section 4.4.3](../zp-page-rt-bench-report.md#443-applied-v-wins-3-additional).

<a id="2026-05-31-w-round-post-compat-fast-path-cow-return-per-msg-event-fast-exit-adaptive-backoff-polling"></a>
## 2026-05-31: Post-compatibility fast paths (`Cow` entity decode, `message` fast exit, adaptive polling)

- **Cause:** Following location virtualization, HTML entity decoding, SafeFrame resize, and incumbent realm fixes, owned string copies on entity-free URLs, unnecessary `message` event wrapper work, and fixed-rate layout polling remained on hot paths.
- **Fix:** Changed `decode_url_html_entities` to return `Cow::Borrowed` when no entities are present; added a fast exit in the `message` listener when `source` is unchanged and `origin` is non-proxy; and gave SafeFrame resize polling adaptive backoff with reset on size change.
- **Evidence and status:** [bench report Section 5](../zp-page-rt-bench-report.md#5-w-round-2026-05-31-hot-path).

<a id="2026-08-20-six-parse-time-subresource-holes-found-in-static-matrix"></a>
## 2026-08-20: Six static subresource holes and SVG fragment loss

- **Cause:** Omissions in `zp-htmltx` attribute filters and `(tag, attr)` tables left `input[type=image][src]`, `video[poster]`, SVG `image[href]`/`[xlink:href]`, legacy `<image src>`, and `background` attributes unrewritten at parse time. HTML tokenizers also emit `<image>` whereas DOM parsers normalize it to `<img>`.
- **Fix and security:** Added all missing surfaces plus `use[href]` and `body`/`table`/`td`/`th`/`tr` `background` attributes to both tables. CSP is a second line of defense and must never excuse missing URL rewrites.
- **Fragment bug:** Percent-encoding the entire `s.svg#icon` URL into the query string stripped the `#icon` fragment from the browser's SVG `<use>` reference. Fixed `proxied_subresource_url` to split off the fragment and append `#icon` outside the proxied query string.
- **Evidence and status:** Verified across static matrix fixtures `a10` through `a20`.

<a id="2026-08-20-not"></a>
## 2026-08-20: Leak classifier false positives and under-reporting guards

- **Cause:** The hole-matrix runner counted CSP-blocked direct requests as leaks and multiplied them by subsequent proxied fetches reaching the target server.
- **Fix and verification:** Correlated direct request outcomes by `kind` and `request_id` in `--output` JSON. Re-evaluating the pre-fix state confirmed 7 `csp-only` blocks (`a11` through `a16`, `a20`) and 0 actual leaks.
- **Safety rules:** `response` = leak, `failed-only` = `csp-only`, **no terminal event = `indeterminate`**. Any single direct response among multiple attempts counts as a leak, proxied requests are not direct leaks, and `dropped.network > 0` invalidates isolation verdicts.
- **Evidence and status:** Extracted classifier logic into `classify.cjs` with synthetic tape unit tests.

<a id="2026-08-20-real"></a>
## 2026-08-20: Top-level escape via `<meta http-equiv="refresh">`

- **Cause:** `<meta http-equiv="refresh" content="0;url=...">` navigated the top-level browsing context directly to the target origin because CSP `form-action` does not govern meta refresh and `navigate-to` was absent. Subresource arrival probes alone did not detect top-level navigation escapes.
- **Fix and security:** Added `proxied_meta_refresh` to rewrite the `url=` target inside `content` to the `?via=` navigation route used by anchors and forms. For `<meta http-equiv="refresh">`, rewriting is the sole containment barrier against direct target navigation.
- **Verification and gaps:** Confirmed in fixture tests that top-level navigation remains on the proxy with zero direct target requests. Identified `feImage[href]`/`[xlink:href]` and bare strings in CSS `image-set()` as `csp-only` gaps, while leaving `importmap` and `object[codebase]` classified as `known-gap`/`deliberate` at that point.

<a id="2026-08-20-like"></a>
## 2026-08-20: Third divergent implementation of meta refresh in child frames

- **Cause:** Meta refresh rewriting was implemented separately in Rust `zp-htmltx`, the Service Worker `proxiedRefreshValue` response-header handler, and `transformHTML` in the page prelude. Fixing Rust `zp-htmltx` alone left `srcdoc` frame `f10-frame-meta-refresh` unrewritten and blocked by `frame-src 'self'`.
- **Fix and rule:** Updated the response-header and page-realm HTML transform paths to rewrite refresh URLs consistently, and verified both containment and landing-page reproducibility per path.
- **Verification:** Distinguished headless Chrome's user-gesture popup blocking on `_blank`/`window.open` (which also failed in the native control group) from proxy regressions.

<a id="2026-08-21-dual-implementations-require-paired-matrices"></a>
## 2026-08-21: Paired static (`a*`) and page-realm (`g*`) URL surface matrices

- **Cause:** Running page-realm `srcdoc` fixtures (`g*`) exposed `csp-only` gaps where the JS prelude missed `background`, case-preserving SVG `feImage`, and bare strings in CSS `image-set()`.
- **Fix and rule:** Paired static (`a*`) and page-realm (`g*`) fixtures with inventory and CSS (`image-set`/`@import`) parity guards, documenting legitimate parser differences (such as DOM normalization of `<image>` to `<img>`).
- **Verification:** Confirmed all three predicted gaps in browser runs and verified that mutating the `background` table entry triggered the parity guard.

<a id="2026-08-21-objectdata-correction-and-misleading-broken-image-metric"></a>
## 2026-08-21: `object[data]` rewrite correction and misleading broken-image metric

- **Correction and security:** Blocking plugin execution via `object-src 'none'` is distinct from leaving raw target URLs in the DOM. Reclassified `object[data]` from `deliberate` to a rewritten surface in `zp-htmltx`, closing `a23-static-object-cross`.
- **Measurement traps:** `plugin_surface_stays_unrewritten_by_design` had matched the target hostname substring inside the percent-encoded proxy query string, passing vacuous assertions; tests must inspect the unencoded attribute structure. Similarly, counting `img.complete && img.naturalWidth === 0` included URL-less placeholder `<img>` elements, skewing broken-image counts.
- **Actual root cause of 403s:** The failing requests originated from `/zp/api/sync-fetch` documents where SW-less child frames requested relayed CSS `url()` assets via the SW-only `/zp/api/fetch` endpoint and received HTTP 403 from Go. Resolved subsequently in [the SW-less CSS fix](sw-integration.md#2026-08-21-css-in-url-sw-less-403).

<a id="2026-08-21-url-surface-single-source-refactor-guarded-by-matrix"></a>
## 2026-08-21: Single-source `url_surfaces.json` refactor and SVG `feImage` case regression

- **Change and audit:** Consolidated URL-bearing attribute tables into `crates/zp-shared/testdata/url_surfaces.json`, injected at build time and guarded by Rust transform tests. The audit classified `iframe[src]`, `frame[src]`, and `iframe[srcdoc]` as document-creating `special` surfaces and SVG `script[href]` as a `known-gap` in `zp-htmltx`.
- **Regression caught by matrix:** Flattening the lookup table to lowercase keys mismatched case-preserved SVG `localName === "feImage"` in the DOM, causing `g5-realm-feimage` to regress to `csp-only`. Caught immediately by the paired `a*`/`g*` matrix.
- **Guards:** Added static-policy checks preventing hand-maintained list resurrection and verifying that built `dist/` bundles match `url_surfaces.json`.

<a id="2026-08-22-rt-wasm-server-1-9"></a>
## 2026-08-22: `zp_page_rt.wasm` requests leaking to the target server from pre-instrumented child realms

- **Cause:** In `srcdoc` and `blob:` frames, the virtual `<base>` element resolved the root-relative `/__zp/zp_page_rt.wasm?v=...` fetch against the target origin. Even after switching to an absolute proxy URL, child realms pre-instrumented by the parent had already wrapped `Native.fetch`, which re-mapped the request to the target server.
- **Fix and security:** Built the WASM URL from `proxyOrigin + '/__zp/...'` and skipped `zp-page-rt` boot entirely in realms where `typeof root.__zp_get === 'function'` at prelude start, falling back to JS classification rather than risking proxy build-ID exposure to target servers.
- **Evidence and status:** Matched 9 leaked `/__zp/zp_page_rt.wasm` requests on the fixture server to the 9 pre-instrumented child frames. Do not assume `captureNative` holds unwrapped native functions when a parent frame has already initialized the child realm.
