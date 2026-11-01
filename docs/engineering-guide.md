# ZeroProxy Engineering Guide

This guide summarizes ZeroProxy's active engineering scope, real-site compatibility status, TLS persona maintenance, and browser diagnostic workflows. Read [`CLAUDE.md`](../CLAUDE.md) and scan the first 40 lines of [`.ai/trap-notebook/INDEX.md`](../.ai/trap-notebook/INDEX.md) before modifying code.

## 1. Engineering Scope: Containment and Compatibility

ZeroProxy enforces two core properties:

1. **Containment**: Target code cannot open native network connections, obtain the real `window`/`Location` or an uncontained realm, read another target's storage or proxy control surfaces, or execute unrewritten code.
2. **Compatibility**: Websites that load and function in a standard browser load and function through ZeroProxy.

Hiding the proxy's existence from target JavaScript (concealment) is **not** a project goal. Existing masking (such as the fixed speech-synthesis voice list) remains in place, but new concealment features are out of scope. Before starting any task, verify which containment invariant it protects or which broken website it fixes. If it does neither, do not implement it.

### Accepted Non-Goals and Residuals

The following items are documented in [`errata.md`](errata.md) as intentional residuals rather than active defects:

- **`eval` and `new Function` stack formatting**: Dynamic code evaluated by a target page formats stack frames as script frames rather than V8's native `eval at ...` text. Reproducing V8's exact eval stack strings requires per-call source URLs and column remapping purely for bot-scoring scripts.
- **Membrane string inspection via monkey-patched primitives**: A target page that overrides `String`, `RegExp`, `Array`, or `JSON` prototype methods can observe internal URLs (such as the proxy origin or the page's own `/zp/p/` route) as strings pass through membrane helpers. Real `window` and `Location` objects never leak through these paths, and all internal membrane `Map`, `Set`, `WeakMap`, and `WeakSet` tables are sealed against page-supplied prototype wrappers .
- **Third-party bot walls that reject unautomated browsers**: Interstitials that block traffic based on IP reputation or headless browser traits equally in native Chrome and ZeroProxy (such as Reddit's IP-level interstitial) are outside proxy compatibility scope once all JavaScript and worker exceptions are resolved ([`errata.md`](errata.md) items 94 and 95).

## 2. Current Verification and Compatibility Status

All security and compatibility gates in [`containment-gates.md`](containment-gates.md) are closed:

- **Automated suites**: Rust workspace tests (`cargo test --workspace`), Go host and relay tests (`go test ./...`), Node policy and unit checks (`npm run test:js` and `test/js/static-policy.test.js`), WASM bundle checks (`npm run test:wasm:ci`), and the Chromium E2E suite (`npm run test:e2e`) pass.
- **Real-site corpus and rendering**: All 705 cached real-site scripts rewrite to valid JavaScript accepted by V8 (`scripts/rewrite-corpus-check.cjs`). Across the 13-site verification matrix (Wikipedia, GitHub, Guardian, BBC, MDN, CNN, NAVER, NYT, Stack Overflow, Reddit, Apple, npm, and IMDb), every site loads and responds, with zero proxy errors on Wikipedia, GitHub, Guardian, MDN, NAVER, Apple, and npm.
- **Containment and compatibility mechanisms**: Detailed root causes and test pins live in [`errata.md`](errata.md) and [`.ai/trap-notebook/rewriter.md`](../.ai/trap-notebook/rewriter.md). Key mechanisms include TLS `trust_anchors` alignment for Cloudflare challenges, `Sec-Fetch-*` header parity, `COEP: require-corp` worker bootstrapping, `TrustedScript` compilation in `eval` and timers, `WorkerGlobalScope.prototype` hook placement, `Accept-CH` and `Critical-CH` client-hint negotiation, cross-origin frame `featurePolicy` and permissions isolation, runtime `__zp_*` helper name protection, window accessor getter protection, direct `eval` lexical binding resolution, and sealed internal collection tables.

### Maintenance and Survey Tracks

1. **TLS Persona Maintenance (Chrome 155)**:
   Run `npm run check:chrome-hello` after any local Chrome upgrade. This script launches the installed Chrome browser against a local TCP listener and compares its TLS `ClientHello` extensions and `trust_anchors` payload against `CAPTURED_FINGERPRINT_B64` in [`web/sw.js`](../web/sw.js) and [`third_party-rustls-fork/src/ja3.rs`](../third_party-rustls-fork/src/ja3.rs) (exit code `1` indicates drift; `2` indicates Chrome is not installed). When updating the persona version, update [`web/zp-core.js`](../web/zp-core.js) (`TARGET_CHROME_FULL_VERSION`, read from `navigator.userAgentData.getHighEntropyValues(['uaFullVersion'])`), [`web/worker-prelude.js`](../web/worker-prelude.js), [`third_party-rustls-fork/src/ja3.rs`](../third_party-rustls-fork/src/ja3.rs), and [`crates/zp-kernel-bundle/tests/client_hello.rs`](../crates/zp-kernel-bundle/tests/client_hello.rs) together.
2. **Interactive Challenge Compatibility (Glassdoor)**:
   A human who passes an interactive challenge in a native browser must pass it through the proxy; a divergence is an in-scope compatibility defect. The Turnstile check on Glassdoor completes on the real path (the launcher, the parent page, and the widget all proxied). The method that located the divergences: run the widget natively through the transport kernel to rule out TLS, HTTP/2 framing, and headers; compare the widget's payload with the native one stage by stage; bisect the transformation in a lab page; then confirm on the real path. Causes, measurements, and the reviewed list of fidelity code that stays are in the trap notebook ([`rewriter.md`](../.ai/trap-notebook/rewriter.md#glassdoor-cleared-2026-10-21), [`rewriter.md`](../.ai/trap-notebook/rewriter.md#glassdoor-resolved-2026-10-22), [`sw-integration.md`](../.ai/trap-notebook/sw-integration.md#form-submission-fidelity-2026-10-23)). The remaining differences (no QUIC, slower challenge VM phases) are residuals in [`errata.md`](errata.md).
3. **Real-site survey: divergences found and left open (rolling)**:
   The survey compares each site with a native Chrome that has the same User-Agent minus `Headless` (a headless native run is served a bot page by some sites, so it is not a fair baseline). Fixed ones are in [`.ai/trap-notebook/rewriter.md`](../.ai/trap-notebook/rewriter.md); the ones below were measured and not fixed, in the order they are worth picking up when a site needs them (details in [`errata.md`](errata.md) and [`real-site-compat.md`](../.ai/trap-notebook/real-site-compat.md)):
   - `content: attr(href)` in a print stylesheet paints the proxy address (Wikipedia; print and PDF only). Candidate fix: rewrite `attr(href)` to read `data-zp-lit-href`.
   - A child frame's own window facade is not mapped for native `EventTarget` calls (`EventTarget.prototype.addEventListener.call(frame.contentWindow, …)` throws `Illegal invocation`). Not measured on a site.
   - A runtime `modulepreload` link is suppressed with its `rel` and `href` removed, so a selector or `getAttribute('href')` on it finds nothing (inert in the proxy).
   - Notion: Transcend's airgap throws once on `Object.defineProperty(…, 'innerHTML', …)` because the membrane's `innerHTML`, `outerHTML` and `textContent` accessors are non-configurable (natively configurable); text is identical and 851 of 863 elements are present. Redefinable needs the audit that `REDEFINABLE_ACCESSORS` (web/membrane/02-masking.js) asks for; `window.onmessage` is non-configurable too, with no site known.
   - Coupang and eBay: the Akamai bot-manager sensor throws `Function.prototype.apply was called on undefined` only when proxied; on Coupang it is `obj.O(…)` on an instance of the sensor's own class, so an earlier probe of the sensor went differently (page unaffected). Not pursued: the script is obfuscated and telling bots apart is not a goal.
   - A server that offers only CBC or static-RSA cipher suites is unreachable (the TLS stack implements neither); a server that prefers one is reached by the retry.
   - Looked at and decided against: attribute selectors inside stylesheets (68 selectors on 19 sites, none matches differently; [`real-site-compat.md`](../.ai/trap-notebook/real-site-compat.md#stylesheet-url-selectors-2026-10-26)).

## 3. Build, Run, and Diagnostic Workflow

Use these commands to build assets, run the local relay, and inspect live pages.

### Building and Starting the Server

Stop any running `zeroproxy-server` process before a full build so the binary is not locked, then build and start the server:

```bash
node scripts/build.mjs                        # Full build (Rust WASM + JS + Go server)
node scripts/build.mjs --web-only --no-clean  # Fast web-only rebuild (also restores clean dist/web)
./dist/zeroproxy-server -web "$(realpath dist/web)" -addr 127.0.0.1:18080 -socks internal
```

Ensure the single shared `taskweaver` browser instance (`zp`) is running:

```bash
taskweaver list
taskweaver start --id zp --width 1200 --height 800  # Run only if 'zp' is not listed
```

### Comparing Against an Unautomated Chrome Instance

When diagnosing anti-bot or protocol differences, compare ZeroProxy against a manually launched Chrome process rather than a `puppeteer.launch()` instance (automated launch flags alter bot-detection scores):

1. **Launch a clean Chrome profile manually**: Start Chrome with `--user-data-dir=<temp_dir> --remote-debugging-port=<port> --no-first-run about:blank` and attach via `puppeteer.connect({ browserURL })`. Clean up the temporary directory and terminate that specific process when finished.
2. **Compare raw wire bytes**: Follow the pattern in [`scripts/check-chrome-hello.mjs`](../scripts/check-chrome-hello.mjs), where a local TCP listener records the initial TLS flight from both native navigation and proxied navigation.
3. **Compare per-hop HTTP headers**: On the proxied side, inspect the Service Worker logs via `taskweaver exec-js --target sw --script "return outgoingHeaderLog.map(...)"` (which also exposes `refusalLog`, `tabs`, and `shareRoutes`). On the native side, inspect `Network.requestWillBeSentExtraInfo` over CDP.
4. **Distinguish challenge types**: Check whether the server issues `orchestrate/precursor_interstitial` (lightweight in-page check) versus `orchestrate/chl_page` with a Turnstile iframe (interactive challenge).

### TaskWeaver CLI Reference

The `taskweaver` browser CLI supports the following diagnostic features on the shared `zp` instance:

- **Cross-origin frame console capture**: `taskweaver console-logs -i zp --frame <frame_id> --text <pattern>` captures console output and errors from both same-origin and cross-origin (out-of-process) iframes. Use `taskweaver start --console-buffer 5000` to increase the ring buffer capacity beyond the 500-entry default.
- **Navigation and request timelines**: `taskweaver nav-log -i zp` shows per-hop navigation events, frame hierarchies, and COEP/CSP blocking reasons. `taskweaver failed-requests -i zp` lists failed network loads.
- **Cookie inspection**: `taskweaver cookies list -i zp` returns cookie attributes in `snake_case` (`http_only`, `host_only`, `same_site`, `priority`, `source_scheme`).
- **Shared profile safety**: `taskweaver reset` and `taskweaver cookies clear --all` refuse to wipe a shared profile unless `--force-shared` is passed. Always prefer `--dry-run`, `reset --keep-browsing-data`, or clearing site data only for the proxy origin ([`test/browser/_zp-session.sh`](../test/browser/_zp-session.sh)).

## 4. Operational and Debugging Pitfalls

Keep these technical constraints in mind when debugging or running test suites:

- **Verify which browser engine you are matching**: `taskweaver` on Windows uses WebView2 (Edge), whose TLS `ClientHello` differs from Chrome by one extension. Always verify Chrome TLS parity with `npm run check:chrome-hello` against actual Chrome.
- **Park `zp` on `about:blank` before running E2E tests**: Leaving the shared `zp` browser tab on a CPU-heavy or polling page starves background worker probes during `npm run test:e2e` and causes false timeouts in the E1 suite.
- **Distinguish E2E timeout budgets from functional failures**: If `npm run test:e2e` fails only with `test timed out` on the outer suite while individual subtests pass, compare per-test durations against a clean run before suspecting a code regression.
- **Space out repeated requests to rate-limited sites**: Rapidly reloading Cloudflare-protected pages escalates IP blocking from interactive challenges to hard block pages, invalidating A/B comparisons.
- **`dist/web/sw.js` inlines `zp-core.js`**: Editing `dist/web/zp-core.js` directly does not affect the Service Worker. Edit the source files under `web/` and run `node scripts/build.mjs --web-only --no-clean`.
- **`crates/zp-kernel-bundle` targets `wasm32` only**: Native `cargo test` runs on the host architecture cannot invoke `cfg(target_arch = "wasm32")` kernel functions directly; keep host-side test mirrors (such as `captured_spec_from_json` in [`crates/zp-kernel-bundle/tests/client_hello.rs`](../crates/zp-kernel-bundle/tests/client_hello.rs)) synchronized with the WASM implementation.
- **Direct `eval` inside functions uses `ScriptKind::ClassicLocal`**: The rewriter distinguishes top-level classic scripts from direct `eval` inside functions (`"classic-local"`) so `this` bindings inside function-scoped `eval` preserve caller semantics.
- **Never kill all Chrome processes indiscriminately**: Do not run a blanket `killall chrome` or `taskkill /IM chrome.exe` command, which terminates the user's primary browser session. Always filter temporary test processes by their `--user-data-dir` command-line argument.
- **Use `page.evaluate` when attaching Puppeteer to a manually started Chrome**: In Chrome 154 with Puppeteer 25, `ElementHandle` helpers (`page.click`, `page.type`) can time out inside `Runtime.callFunctionOn` on self-started browser instances. Perform form fills and clicks inside `page.evaluate` instead.
- **Treat `TrustedScript` as executable code**: Browser APIs that accept code strings (`eval`, `setTimeout`, `setInterval`) also accept `TrustedScript` instances and objects with custom `toString()` methods. All non-function timer handlers and `TrustedScript` arguments must pass through the rewriter .
