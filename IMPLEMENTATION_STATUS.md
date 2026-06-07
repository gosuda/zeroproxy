# ZeroProxy Implementation Status

Date: 2026-06-07

This document is the current repository-backed implementation-status report for ZeroProxy. It preserves the compatibility/privacy-membrane plan, compares it against the implementation present in this repository today, and updates the older partial-status language against the code and checked-in verification artifacts now present.

## Executive Summary

ZeroProxy is now aligned with the planned human-in-the-loop virtual-browsing architecture at repository release-gate scope. A real user drives a real browser, while target traffic is kept on the membrane path:

```text
Service Worker -> Go WASM kernel -> WebSocket/smux -> SOCKS5 -> uTLS
```

Current repository-backed status:

- Static transformation policy is Rust-owned: JavaScript/SWC rewriting, HTML/lol_html rewriting, CSS URL rewriting, import maps, URL policy classification, and share-route generation.
- `internal/htmltx` is a Go adapter into Rust/lol_html. It now has a streaming `DocumentStreamRewriter` bridge path and retains the old whole-document hook only as a fallback for older test hooks.
- The Go WASM document path uses `ZPRewriter.createHTMLDocumentRewriter` when available and falls back to `ZPRewriter.rewriteHTMLDocument` only when the streaming hook is unavailable.
- Runtime-set `srcdoc` prefers the same Rust full-document rewrite ABI and models parent target/referrer context.
- Runtime helper ABI is stable and includes `__zp_get`, `__zp_set`, `__zp_call`, `__zp_construct`, `__zp_has`, `__zp_delete`, `__zp_typeof`, `__zp_ownKeys`, `__zp_getOwnPropertyDescriptor`, and `__zp_module_url`.
- Target-visible selector virtualization covers `href`, `src`, `srcset`, `action`, `formaction`, `poster`, `srcdoc`, and `xlink:href` across `querySelector`, `querySelectorAll`, `matches`, and `closest`.
- Service Worker request classification is fail-closed: unknown navigations are policy-blocked, unknown subresources return `Response.error()`, and there is no native `fetch(event.request)` fallback.
- Frame sandbox containment and unsupported `data:`, `blob:`, and `javascript:` frame scheme behavior are tested and listed as expected deltas.
- Representative-site corpus machinery, release-gate schema, redacted release artifact, redacted failure telemetry, root-surface oracle records, and transport timing summaries are checked in.
- Cookie/storage/SameSite, fetch/XHR, framework, event-listener, observer/input, dynamic DOM, DOM-mutation, frame/srcdoc/sandbox, performance, delivery-versioning, and rewrite long-tail matrices are checked in and pinned to source or oracle metadata.
- Go transport timings include queue wait, connection acquisition, stream open, SOCKS/TLS, first-byte, body duration, total duration, retry count/reason, reuse, protocol, and failure class where available.
- Runtime Performance entries expose target-visible resource timing where safe, wrap `PerformanceObserver`, and count synthetic timing gaps.

Completion status: **repository release-gate complete for the current status plan**. The checked-in live representative corpus release artifact records 14 compared sites, 5 direct passes, 9 classified expected compatibility deltas, 0 triage sites, 0 unexpected script rewrite-induced failures, 0 generated JavaScript syntax errors, and 0 unexpected script fail-close fallbacks.

The remaining risk is operational rather than unclassified: the 9 checked-in representative-site expected deltas must be maintained and ideally reduced as future compatibility work lands.

## The Plan

### Security Invariants

ZeroProxy preserves three load-bearing security invariants:

- no direct target egress outside the membrane transport path;
- no native `fetch(event.request)` fallback for unknown target requests;
- no wildcard `connect-src`, direct fetch escape, or fail-open script execution.

### Planned Architecture

Transformation policy converges into `rewriter-rs`:

```text
HTML / CSS / JS / import-map source
  -> Rust transform engine
     -> JS AST transform and codegen
     -> HTML transform
     -> CSS URL transform
     -> import-map transform
     -> dynamic code transform
  -> runtime facade ABI
  -> Service Worker / Go WASM kernel transport
```

The browser runtime is the execution ABI for rewritten code, not a second independent static rewriting policy. Public helper names such as `__zp_get`, `__zp_set`, `__zp_call`, `__zp_construct`, `__zp_has`, `__zp_delete`, `__zp_typeof`, `__zp_ownKeys`, `__zp_getOwnPropertyDescriptor`, and `__zp_module_url` are ABI surface and must remain stable unless the Rust rewriter and runtime are versioned together.

### Planned HTML Transform

The planned HTML transformer is Rust-owned and backed by `lol_html`, so malformed and streaming HTML can be rewritten without a full-document parser. Static document policy covers:

- `srcdoc`;
- inline scripts;
- event handlers;
- inline styles;
- import maps;
- external script URLs;
- frame URLs;
- base and meta policy handling;
- preload/preconnect suppression;
- object/embed blocking;
- target-visible backup and masking attributes.

The Go `internal/htmltx` package is a thin adapter/streaming bridge with no independent rewrite policy. Behavior-preserving membrane/protocol migrations are expected to use a temporary differential harness during development, followed by permanent characterization/adversarial tests; temporary harnesses are not committed.

### Planned Rewrite Surface

Static rewriting and runtime facades cover:

- free globals: `window`, `self`, `globalThis`, `location`, `origin`, `document`, `history`, `top`, `parent`, `opener`, `frames`;
- network and dynamic constructors: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `Worker`, `SharedWorker`, `sendBeacon`, `eval`, `Function`, async/generator function constructors, string timers;
- member and reflective access: `window.location`, `location.href`, `location.hash`, `document.defaultView`, `contentWindow`, `contentDocument`, `postMessage`, `Object.getOwnPropertyDescriptor`, `Reflect.ownKeys`, `Object.keys`, `Object.defineProperty`, `in`, `delete`, `typeof`;
- module syntax: static import/export sources, dynamic `import()`, `import.meta.url`, import maps, module workers;
- frame and event boundaries: `event.source`, `event.view`, iframe `parent/top/opener`, `srcdoc`, and nested frame messaging.

The rewriter preserves local bindings, strings, comments, JSON content, class/object keys outside executable value position, target challenge tokens/configuration, and anything that would require manufacturing target CSP permission.

### Planned Runtime Facades

The runtime exposes explicit facade behavior for window, location, history, document, workers, network constructors, events, frame boundaries, storage, dynamic code, and fingerprinting/performance surfaces. Static rewritten code and dynamic code compiled under a scoped runtime environment observe the same facade semantics.

Proxy objects are acceptable for plain facade targets and virtual scopes. Native browser objects with non-configurable properties must not be proxied in ways that violate ECMAScript proxy invariants.

### Planned Frame Model

Ordinary `http:` and `https:` iframe/frame navigations use the same encrypted `/zp/p/<route>#k=...` document route used by top-level documents. Child documents then pass through the same HTML/JS/CSS/import-map transform and runtime ABI.

Frame-specific code is limited to:

- initial `about:blank` containment before navigation;
- `srcdoc` transformation;
- `contentWindow` and `contentDocument` facade installation;
- `parent`, `top`, `opener`, and `frames` mapping;
- `postMessage` target-origin/source/origin mapping;
- original sandbox semantics preservation plus explicit security deltas;
- explicit blocking/classification of dangerous non-document navigations such as `javascript:`, unsafe `data:`, and unsupported `blob:` cases.

### Planned Bundling and Injection

Runtime source is split by responsibility, then bundled for delivery:

- runtime ABI modules;
- facade modules;
- network modules;
- DOM modules;
- frame modules;
- worker modules;
- dynamic-code modules;
- Service Worker modules;
- Rust rewriter modules for JS, HTML, CSS, and import maps.

Delivery uses one target-document bootstrap injection, one bundled runtime asset for target documents, one bundled worker runtime asset, one bundled Service Worker asset, and a Rust rewriter WASM path exposed through the build output. Minification/mangling must not rename public ABI helpers.

### Planned Artifact Minimization

ZeroProxy injection and polyfill surfaces should not break normal site compatibility checks that inspect:

- function source strings;
- descriptors;
- enumerability;
- property keys;
- prototypes;
- stack-visible names;
- frame/global identity.

Every injected wrapper or facade should be centrally masked or documented as an expected visible delta. The masking layer covers `Function.prototype.toString`, descriptors, `ownKeys`, global enumeration, frame wrappers, worker wrappers, dynamic-code wrappers, network wrappers, storage wrappers, history/location/document wrappers, and runtime-owned helper surfaces.

The compatibility oracle compares the JavaScript root visible surface against the native host browser. Starting from `globalThis`/`window`, it inventories visible objects, properties, descriptors, prototype chains, function source strings or redacted fingerprints/lengths, accessor source strings where safe, constructor names, `Symbol.toStringTag`, enumerable keys, own names, own symbols, `Reflect.ownKeys`, and target-visible string values. The comparison classifies deltas as expected security deltas, privacy/persona deltas, known compatibility gaps, implementation bugs, or native/browser-version deltas.

The root-surface comparison recurses only through safe, bounded object graphs and avoids invoking arbitrary page getters with side effects unless a probe is explicitly designed for that surface.

### Planned CSP and Policy Handling

ZeroProxy-controlled documents and assets receive ZeroProxy CSP through response headers or Service Worker response construction, not committed HTML meta CSP.

Target CSP must not control the proxy-origin execution environment. Upstream CSP and report-only headers are stripped before browser `Response` construction. Target HTML meta CSP is removed or made inert during static and dynamic HTML transformation.

`'unsafe-eval'` is present only when target policy allows dynamic compilation and the dynamic body is rewritten before execution. Original target source must never execute on parse or rewrite failure.

### Planned Compatibility Oracle

Native-browser-vs-ZeroProxy E2E oracle tests cover:

- descriptors, `ownKeys`, prototypes, `toString`, and global identity;
- centralized artifact masking;
- `window`, `self`, `globalThis`, `location`, and `history`;
- iframe `contentWindow`, `contentDocument`, `parent`, `top`, `opener`, `srcdoc`, nested frames, and `about:blank`;
- ordinary frame document loads using the same `/zp/p` route and transport path as top-level documents;
- `postMessage`, `event.origin`, `event.source`, and cross-frame delivery;
- request headers, response constructor policy, referrer policy, and CSP/header behavior;
- fetch, XHR, WebSocket, EventSource, workers, importScripts, dynamic import, `eval`, `Function`, and string timers.

Expected differences are listed in checked-in expected-delta data. Raw script bodies, challenge tokens, clearance cookies, request bodies, challenge configuration, and raw challenge URLs must not be logged.

### Planned Representative Site Corpus

The representative-site corpus runs in native host-browser mode and ZeroProxy mode through the full membrane. It is an external compatibility signal, not a deterministic unit-test substitute. Site failures are categorized by surface and compared against native-host-browser behavior before being classified as ZeroProxy regressions.

Seed corpus:

| Site | Required primary-flow checks |
|---|---|
| `https://naver.com` | Desktop homepage load, full primary content load, ad iframe discovery, ad iframe nonblank/load-state check, major navigation/search entry points visible. |
| `https://m.naver.com` | Mobile homepage under mobile viewport/user-agent profile, full primary content load, ad iframe discovery, ad iframe nonblank/load-state check, major navigation/search entry points visible. |
| `https://www.google.com/search?q=zeroproxy` | Search result page render, result links visible, no unexpected script fail-close. |
| `https://www.google.com/maps` | Maps shell render, search box and map controls visible, map canvas/tile container nonblank, geolocation/permission behavior compared with native, tile/API request failures classified. |
| Embedded Google Maps fixture | Checked-in host fixture embedding a Google Maps embed URL in an iframe; iframe load, map content nonblank state, postMessage/frame behavior, sandbox/CSP deltas, and third-party widget console errors compared with native. |
| `https://www.wikipedia.org` | Static-heavy baseline render, search input visible, navigation links visible. |
| `https://github.com` | Modern app shell render, navigation/header visible, unauthenticated content visible. |
| `https://news.ycombinator.com` | Low-JS baseline, link list render, navigation visible. |
| `https://www.reddit.com` | JS-heavy app shell render, feed/container visible, console/runtime failures compared with native. |
| `https://x.com` | JS-heavy app shell render, unauthenticated landing/login boundary behavior compared with native. |
| `https://www.amazon.com` | Commerce-style homepage render, image/script/css load state, navigation/search controls visible. |
| `https://www.nytimes.com` | News/media layout render, image/script/css load state, paywall/consent behavior compared with native. |
| `https://www.cloudflare.com` | CDN/security/challenge-adjacent baseline, script and navigation render compared with native. |
| `https://ipleak.net` | Leak-test surface render, IP/DNS/WebRTC result containers visible, WebRTC/WebTransport no-goal behavior classified separately, raw IP/DNS values redacted and compared only by coarse consistency classes. |

The corpus captures only redacted operational data. It must not log raw page bodies, raw scripts, request bodies, cookies, challenge tokens, clearance cookies, challenge configuration, raw IP addresses, raw DNS resolver values, or sensitive URLs beyond normalized site identifiers and coarse failure categories.

### Planned Browser-Comparison Verification Pipeline

The comparison pipeline records:

- console messages by level and normalized message fingerprint;
- uncaught exceptions and `pageerror` fingerprints;
- request failures grouped by resource type, scheme, host class, and failure reason;
- response status buckets and content-type buckets;
- DOM readiness and load milestones;
- screenshot/layout-health snapshots;
- key selector visibility for primary content;
- visible text length and major container dimensions;
- iframe count, ad iframe candidates, and iframe load/nonblank state;
- script/style/image/font/media load status;
- Service Worker/runtime fail-close categories;
- transport connection counts, reuse rates, per-origin concurrency, and Go-originated timing summaries;
- real load/performance timings propagated from the Go network engine, Service Worker, runtime, and browser page context.

Rendering comparison is tolerant, not pixel-perfect. It checks blankness, primary containers, major controls, normalized console deltas, classified blocked/fail-closed paths, ad iframe state for Naver, map/tile state for Google Maps, and coarse/redacted leak-test state for ipleak.

Per-site triage records include site, viewport/profile, primary flow, first failing surface, native result, ZeroProxy result, normalized console delta, rendering delta, timing delta, transport delta, owner module, and status.

### Planned Redacted Failure Telemetry

Telemetry explains failures without logging sensitive source material. It must not record raw script bodies, raw HTML bodies, request bodies, cookies, challenge tokens, clearance cookies, challenge configuration, or raw challenge URLs.

Allowed fields include coarse classifications such as rewrite kind, source size bucket, parser/rewrite error kind, retry path attempted, blocked URL scheme, blocked resource type, target content-type and charset, facade helper that threw, failed runtime API surface, Service Worker classification result, transport failure class, response status bucket, and lifecycle phase.

Telemetry is joinable with representative-site triage records so a broken site maps to its first failing surface without exposing target secrets.

### Planned Safe Parse-Failure Recovery

Parse/rewrite failures remain fail-closed. The original target source never executes after a parse or rewrite failure. Safe retry paths may run before returning the final blocking script.

Recovery attempts include BOM stripping, classic-script HTML comment normalization, safe classic/module classification retry, future charset reinterpretation when response/document evidence supports it, event-handler and dynamic function wrapper variants, and syntax-proposal fixtures before allowing new syntax through.

The final fallback remains a blocking script such as a `DOMException` throw.

### Planned Dynamic DOM Insertion and Hook Inventory

Dynamic DOM insertion is a first-priority compatibility milestone. Runtime insertion paths are compared with static Rust document policy and native host-browser behavior.

Planned dynamic surfaces include:

- `innerHTML`, `outerHTML`, `insertAdjacentHTML`;
- `document.write` and `document.writeln`;
- `Range.createContextualFragment`;
- `DOMParser.parseFromString`;
- `appendChild(script)`, `insertBefore(script)`, `replaceChild(script)`;
- template parsing and cloning;
- framework hydration that rewrites or reuses DOM nodes;
- dynamic `srcdoc`.

The DOM manipulation inventory classifies every API family that can create, insert, replace, clone, parse, adopt, import, serialize, or mutate executable/URL-bearing markup as hooked, partial, irrelevant, expected limitation, or expected delta. Required families include node insertion/removal/replacement, HTML parsing sinks, node creation/import/adoption, attribute mutation, collection/template movement, frame-specific sinks, and script/style/link sinks.

### Planned Selector Virtualization

Selector APIs should match target-visible URL attributes where native browser behavior would match, even when the raw browser DOM contains `/zp/...` routes or backup `data-zp-*` attributes.

Coverage includes:

- `Document.prototype.querySelector`;
- `Document.prototype.querySelectorAll`;
- `Element.prototype.querySelector`;
- `Element.prototype.querySelectorAll`;
- `Element.prototype.matches`;
- `Element.prototype.closest`;
- URL-bearing attribute selectors for `href`, `src`, `srcset`, `action`, `formaction`, `poster`, `srcdoc`, `xlink:href`, and relevant reflected properties;
- equality, prefix, suffix, substring, includes-token, and dash-match selector operators where feasible;
- selector lists and nested selectors where browser parsing permits them.

Unsupported selector cases are documented as expected compatibility gaps. The implementation must not expose `data-zp-*` internals or route selectors to target code while adding virtualization.

### Planned Cookie, Storage, SameSite, Fetch, and XHR Diagnostics

Cookie/storage/SameSite diagnostics cover redirect-chain `Set-Cookie`, SameSite Lax/Strict/None/Secure behavior, iframe and third-party-shaped cookie visibility, `document.cookie` vs network `Cookie` header behavior, expiry/domain/path handling, storage namespace sharing across reload/popup/iframe/same-origin/cross-origin cases, storage events, IndexedDB, and CacheStorage.

Fetch/XHR diagnostics cover `mode`, `credentials`, `redirect`, `referrerPolicy`, `cache`, `integrity`, `keepalive`, `no-cors` and opaque response behavior, abort before headers, abort during body streaming, XHR timeout/abort events, upload stream behavior, replayable body behavior, range requests, response URL/redirected state, response header filtering, and sync XHR policy.

Cookie values, typed secrets, request bodies, and sensitive state are redacted.

### Planned Framework, Event, Observer, and Input Fixtures

Framework fixtures cover React hydration, Next/Vite-style module graphs and dynamic chunks, Vue hydration/event binding, Angular zone/timer patching, Webpack runtime dynamic chunk loading, import maps, framework-driven `innerHTML` and template cloning, and worker/module-worker loading where relevant.

Event-listener compatibility covers `addEventListener`, `removeEventListener`, `dispatchEvent`, listener identity, duplicate registration, function/object listeners, options objects, `AbortSignal`, ordering across phases, propagation/default prevention, `on*` properties, rewritten inline handlers, cross-frame message events, facade event targets, and descriptor/toString/own-key visibility. ZeroProxy internal listeners and listener stores must not be enumerable, obtainable, or removable by target code through standard page APIs.

Observer/input parity covers MutationObserver, IntersectionObserver, ResizeObserver, pointer/mouse/touch/keyboard/composition/input/focus/wheel/scroll events, callback/event ordering, framework hydration, lazy loading, infinite scroll, maps, drag interactions, menus, mobile layouts, IME-style text input, and contenteditable editors. Telemetry must not log typed text, clipboard data, selected text, raw pointer paths, or sensitive form values.

### Planned Performance and Browser-Equivalent Network Engine

Performance work measures JS rewrite latency, dynamic eval/Function/string timer rewrite latency, HTML transform first-byte delay and total time, WASM rewriter initialization time, runtime bootstrap cost, and page-load overhead on the compatibility corpus.

The Go network engine is the source of truth for target-side transport timings and emits redacted per-request metadata upward through:

```text
Go network engine -> Go WASM kernel -> Service Worker response metadata -> runtime/browser comparison report
```

Required fields include request id, tab/isolation id hash, target origin hash or normalized host class, queue wait, connection acquisition, connection reused vs newly opened, SOCKS connect, TLS handshake, negotiated protocol, request header write, first response byte, response body duration, total duration, retry count, failure class, and stream/session reuse class where safe.

The page-visible Performance API exposes target-visible names with real measured timing data where safe:

- `performance.getEntries()`;
- `performance.getEntriesByType('navigation')`;
- `performance.getEntriesByType('resource')`;
- `performance.getEntriesByName()`;
- `PerformanceObserver`;
- `PerformanceObserverEntryList`;
- `toJSON()` on performance entries.

The transport engine avoids excessive target connections and behaves closer to a modern browser stack while preserving the membrane egress path. It includes per-origin HTTP/1.1 pooling/reuse limits, HTTP/2 session reuse and multiplexing where negotiated, bounded global/per-origin concurrency, request queueing/backpressure, idle timeout, health/retry behavior, priority-aware scheduling where available, isolation-aware pool keys, and reuse/queue/failure metrics.

WebRTC and WebTransport remain out of scope and are classified separately as unsupported direct-network surfaces.

## Current Implementation

### Browser and Runtime Assets

The browser asset organization matches the planned source split:

- Runtime entry: `web/runtime-prelude-entry.mjs`
- Page runtime source: `web/runtime-prelude.mjs`, `web/runtime/**`
- Worker runtime entry/source: `web/worker-prelude-entry.mjs`, `web/worker-prelude.js`, `web/runtime/workers/facades.mjs`
- Service Worker entry/source: `web/sw-entry.mjs`, `web/sw.js`, `web/sw/**`
- Shared core: `web/zp-core.js`
- HTTP/Rust rewriter bridge: `web/http-rewriter.js`, generated `rust-rewriter.js`

`scripts/build.mjs` writes runtime, worker runtime, Service Worker, Rust rewriter JS/WASM, `zp-core.js`, `http-rewriter.js`, `wasm_exec.js`, Go `kernel.wasm`, and native `zeroproxy-server`. `--minify` remains opt-in; fixed-name/no-hash delivery and ABI-sensitive public helper names are documented in `test/fixtures/delivery-versioning-minification.json`.

### Rust Rewriter Engine

`rewriter-rs/src/lib.rs` exports the public WASM ABI:

- `rewrite_script`
- `rewrite_script_with_context`
- `rewrite_css`
- `rewrite_import_map`
- `rewrite_html_document`
- `create_html_document_rewriter`
- `make_share_url`
- `rewrite_script_url`
- `rewrite_fetch_url`
- `rewrite_srcset`
- `resolve_target_url`
- classifiers for link rel, blocked elements, meta policy, attr policy, script type, and event handler attrs

`rewriter-rs/src/js/swc_rewriter.rs` uses SWC parsing, resolver marks, and codegen. It rewrites free globals, selected constructors, member/call/assignment/update/`in`/`delete`/`typeof`/optional-chain surfaces, static imports/exports, dynamic imports, and `import.meta.url`. Local shadowing is preserved through resolver marks.

`rewriter-rs/src/html/document.rs` uses `lol_html` and handles runtime prelude injection, script URL rewriting, inline script rewriting, event-handler rewriting, style rewriting, import-map rewriting, passive resource URLs, navigation attributes, `srcset`, `srcdoc`, base/meta policy, link policy, object/embed blocking, and backup attributes. It exposes both string and streaming document rewriting; streaming tests assert parity with the string path across chunk boundaries.

### Go HTML Adapter and WASM Bridge

`internal/htmltx/transform.go` validates options, builds boot prelude HTML, and delegates to supplied Rust document rewriter hooks. `TransformTo` prefers `DocumentStreamRewriter`, streams chunks through `WriteChunk`, flushes returned bytes before EOF, then calls `End`. If the stream factory is unavailable and a string `DocumentRewriter` hook exists, it falls back to the compatibility string path.

`cmd/wasm-kernel/main.go` passes both `DocumentStreamRewriter: rewriteHTMLDocumentStreamFromJS` and `DocumentRewriter: rewriteHTMLDocumentFromJS` into `htmltx.TransformTo`. The streaming hook calls `ZPRewriter.createHTMLDocumentRewriter`.

### Runtime Facade

The page runtime installs a large facade/membrane in `web/runtime-prelude.mjs` using modules under `web/runtime/**`.

Implemented areas include:

- central artifact masking in `web/runtime/abi/artifact-masking.mjs`;
- native capture in `web/runtime/abi/native-capture.mjs`;
- dynamic code facade in `web/runtime/dynamic-code/*`;
- DOM attribute policy and dynamic HTML/script/style insertion hooks;
- document, location, history, navigator, storage, event, performance, and fingerprinting facades;
- HTTP fetch, Request, XHR, EventSource, sendBeacon handling;
- WebSocket and WebSocketStream facades;
- Worker, SharedWorker, blob worker, data worker, and module worker hooks;
- frame accessors, child rewrite helpers, postMessage mapping, and sandbox containment;
- target-visible selector virtualization for rewritten URL-bearing attributes.

Additional helper ABI includes `__zp_assign`, `__zp_update`, `__zp_optionalGet`, `__zp_optionalCall`, `__zp_nav_assign`, `__zp_nav_replace`, `__zp_runClassic`, and `__zp_runEvent`.

### Service Worker and Transport

`web/sw.js` classifies every request before target transport:

- internal assets;
- proxy document routes under `/zp/p/<route>`;
- runtime APIs under `/zp/api/*`;
- virtual subresources recovered from context;
- unknown requests.

Unknown navigation returns a `POLICY_BLOCKED` response. Unknown subresources return `Response.error()`. Native fetch is bound only for first-party asset and kernel loads.

Target document/subresource fetches call:

```text
transportFetch -> self.__go_jshttp(new Request(target, init))
```

The Go WASM kernel exposes `__go_jshttp`, `__zp_stream`, `__zp_kernel_init`, and `__zp_cookie_set` from `cmd/wasm-kernel/main.go`.

The Go transport path then routes through:

```text
zphttp.Engine -> Mux.OpenStream -> SOCKS5 DOMAINNAME CONNECT -> uTLS/HTTP or WebSocket upgrade
```

Important properties:

- `internal/zphttp/roundtrip.go` rejects non-http(s) target schemes for HTTP.
- `internal/wsproto/client.go` rejects non-ws/wss schemes for WebSocket and upgrades over `Engine.DialTarget`.
- `internal/socks5/client.go` requires DOMAINNAME targets and rejects IP literals.
- `internal/zphttp/roundtrip.go` sets target browser identity headers and strips internal/self-set headers.
- `internal/zphttp.Engine.RoundTrip` uses browser-like per-origin/global active request scheduling with priority/FIFO queueing and cancellation cleanup.

## Detailed Status Against the Plan

### 1. Security Invariants

Status: achieved for current repository gates.

Evidence:

- `web/sw.js` default fetch branch fails closed.
- `test/js/membrane-invariants.test.js` verifies unknown request classification, unknown navigation blocking, unknown subresource `Response.error()`, and absence of raw `fetch(event.request)` fallback.
- `web/zp-core.js` builds default-deny CSP without wildcard `connect-src`.
- Target egress path is implemented through `cmd/wasm-kernel/main.go`, `internal/zphttp/roundtrip.go`, `internal/wsproto/client.go`, `internal/socks5/client.go`, and `internal/utlskernel/dial.go`.

### 2. Transformation Policy Convergence

Status: achieved for static transformation policy.

Evidence:

- JS AST rewrite is in Rust/SWC.
- HTML document transform is in Rust/lol_html.
- CSS URL rewrite is in Rust.
- Import-map rewrite is in Rust.
- Static URL policy classifiers are exported from Rust.
- `internal/htmltx` is an adapter into the Rust document transform.
- `test/js/rewriter.test.js` verifies Rust ownership of script, HTML, CSS, import-map, and static URL/classification paths.

Runtime enforcement still contains policy for DOM mutations, inserted markup, network facades, frames, workers, and artifact masking. That is expected runtime membrane behavior rather than a remaining independent static parser policy.

### 3. HTML Transform Migration and Streaming

Status: achieved for the adapter seam.

Evidence:

- `rewriter-rs/src/html/document.rs` is backed by `lol_html` and exposes `StreamingDocumentRewriter`.
- `rewriter-rs/src/lib.rs` exports `create_html_document_rewriter` to WASM.
- `scripts/build.mjs` exposes `ZPRewriter.createHTMLDocumentRewriter` and `ZPRustRewriter.createHTMLDocumentRewriter`.
- `cmd/wasm-kernel/main.go` passes `DocumentStreamRewriter: rewriteHTMLDocumentStreamFromJS` into `htmltx.TransformTo`.
- `internal/htmltx/transform.go` streams input chunks through `WriteChunk` and writes returned output before EOF.
- `internal/htmltx/transform_test.go` proves first output arrives before input EOF.
- Rust tests prove streaming output matches string rewrite output across UTF-8 chunk boundaries.

### 4. Rewrite Surface Coverage

Status: broad and repository-gated.

Evidence:

- Rust rewriter handles planned free globals and helper surfaces, including long-tail `delete` and `typeof` helpers.
- Runtime implements fetch/XHR/EventSource/WebSocket/WebSocketStream/Worker/SharedWorker/sendBeacon/dynamic code.
- Module imports, dynamic imports, import maps, and module workers are covered.
- Frame and message boundaries have runtime modules and E2E coverage.
- `test/fixtures/rewrite-surface-long-tail.json` classifies document/domain, base URL, service worker, worklet, CSP/reporting, WebTransport/WebRTC, and storage/cache/IndexedDB long-tail surfaces.

### 5. Runtime Facade Model

Status: substantially implemented and tested.

Evidence:

- Location, history, document, worker, network, event, frame, storage, performance, and fingerprinting facades are present.
- Static rewritten code and dynamic code share runtime helper surfaces.
- Dynamic `Function`, `eval`, and string timers route through rewritten/scoped runtime paths.
- Tests verify descriptor assignability, dynamic eval path, function masking, and many runtime hooks.

### 6. Frame Loading, `srcdoc`, and Sandbox

Status: mostly achieved with explicit deltas.

Evidence:

- Static HTML treats iframe/frame `src` as navigation and rewrites to encrypted share routes.
- Runtime hooks dynamic frame `src` mutations and frame insertion.
- Service Worker handles `ZP_FRAME_ROUTE`.
- Frame accessors and postMessage mapping exist under `web/runtime/frames/*`.
- Static Rust HTML rewrites `srcdoc` through `rewrite_document`.
- Runtime-set `srcdoc` routes through `injectSrcdoc`/Rust document rewrite path and stores target-visible backup attributes.
- `test/fixtures/frame-srcdoc-sandbox-milestone.json` tracks ordinary frame routing, static/dynamic `srcdoc`, sandbox token deltas, and third-party widget/login/payment/challenge frame patterns.
- `test/e2e/expected-deltas.json` allowlists current long-tail frame/sandbox/unsupported-scheme deltas.

### 7. Bundling, Injection, Versioning, and Minification

Status: bundled delivery achieved; default minification remains opt-in and documented.

Evidence:

- Runtime, worker runtime, and Service Worker are split by responsibility and bundled by Vite.
- Tests assert bundled classic assets and absence of visible multi-script runtime injection.
- Injection inventory snapshot exists.
- `test/fixtures/delivery-versioning-minification.json` documents package version source, fixed runtime asset names, classic-IIFE delivery, fixed-name/no-hash asset policy, opt-in `--minify`, and Rust rewriter version string.

### 8. Target-Visible Artifact Minimization and Root-Surface Oracle

Status: implemented for current repository oracle scope.

Evidence:

- `createArtifactMasking` provides central native-looking `Function.prototype.toString` masking.
- Runtime hides `ZP`, `ZPRewriter`, `ZPRustRewriter`, `ZPHTTPRewriter`, `__ZP_*`, `__zp_*`, and ZeroProxy-marked symbols from enumeration and descriptor probes.
- DOM serialization, selector, and attribute masking are implemented and documented in `docs/masking-surfaces.md`.
- Worker runtime has matching masking.
- E2E differential probes include descriptors, ownKeys, toString, globals, frame wrappers, workers, and dynamic code.
- `scripts/compat-corpus.mjs` records bounded root-surface oracle data and classifies deltas in corpus reports.

### 9. CSP and Policy Handling

Status: achieved for current gates.

Evidence:

- Tests forbid committed HTML CSP meta.
- Response helpers set ZeroProxy CSP.
- Upstream policy headers are stripped through response policy handling.
- Static Rust HTML drops CSP/report-only meta.
- Runtime suppresses dynamic meta policy insertion.
- Unsafe eval is gated by the dynamic-compile branch.
- Script rewrite failures produce blocking code instead of executing original source.

### 10. Compatibility Oracle and Expected Deltas

Status: achieved for current repository/local/corpus scope.

Evidence:

- `test/e2e/proxy.test.js` includes native-vs-ZeroProxy differential behavior.
- `test/e2e/expected-deltas.json` records accepted local differences and long-tail frame/worker/wrapper limitations.
- The E2E fixture probes policy headers, descriptors, function source strings, ownKeys/global artifacts, frame document/srcdoc observations, workers/shared workers, fetch/XHR/EventSource/WebSocket, request headers, and fingerprinting surfaces.
- `test/e2e/representative-sites.release.json` records the live corpus release gate with 0 triage sites and 9 classified expected-delta sites.

### 11. Performance and Real Timing

Status: achieved for current measurable repository paths; future work can improve precision and shrink synthetic gaps.

Evidence:

- Rust rewriter initialization, JS rewrite latency, dynamic `rewriteFunctionBody`, runtime bundle size, and compile budgets are represented in tests/manifests.
- `internal/zphttp.TransportTiming` defines redacted per-request timing with body duration and retry fields.
- `internal/zphttp.Engine.RoundTrip` populates timing from scheduler, connection, SOCKS/TLS, response-header/body, and retry observations where available.
- `internal/swhttp.ResponseToJS` moves timing metadata into non-enumerable `Response.__zpTransportTiming` and removes the internal handoff header before browser `Response` construction.
- `web/sw.js` stores bounded redacted timing records and serves them through `ZP_TRANSPORT_TIMINGS`.
- `web/runtime/network/http.mjs` records hidden Go transport timing metadata from runtime fetch responses.
- `web/runtime/facades/fingerprinting.mjs` exposes Go-backed resource timing entries, wraps `PerformanceObserver`/`takeRecords`, and counts synthetic gaps.
- `scripts/compat-corpus.mjs` joins Service Worker timing summaries into representative-site reports.

### 12. Representative Site Corpus and Browser Comparison

Status: achieved as a checked-in runner and current release artifact.

Evidence:

- `test/e2e/representative-sites.json` checks in the representative seed corpus.
- `test/fixtures/representative-sites/embedded-google-maps.html` is the embedded Maps host fixture.
- `scripts/compat-corpus.mjs` runs native, ZeroProxy, or comparison mode and emits redacted triage/release records.
- `test/js/compat-corpus.test.js` verifies seed completeness, redaction, triage classification, release gate schema, root-surface, and timing/failure telemetry behavior.
- `test/e2e/representative-sites.release.json` records 14 compared sites, 5 direct pass sites, 9 expected-delta sites, and 0 triage sites.

### 13. Browser-Equivalent Network Engine

Status: implemented for bounded/priority-aware scheduling and reuse telemetry; safe coalescing remains an intentional future extension.

Evidence:

- `internal/zphttp.Engine` has HTTP/1.1 idle connection reuse and HTTP/2 connection reuse primitives.
- `RoundTrip` acquires a browser-style request slot before target transport work and releases it when the response body reaches EOF or is closed.
- Scheduler limits are partitioned by target authority plus tab/isolation key.
- Over-limit requests queue by Fetch priority (`X-Zp-Fetch-Priority`) and FIFO order within the same priority.
- Canceled contexts are removed from the queue without leaking scheduler state.
- Tests cover per-origin queueing/backpressure, priority ordering, canceled queued requests, retry telemetry, and scheme-separated HTTP/2 keys.

### 14. Redacted Failure Telemetry and Safe Parse Recovery

Status: achieved for current corpus/rewrite/runtime/SW evidence.

Evidence:

- `scripts/compat-corpus.mjs` emits `zp.failure.telemetry.v1` records with first failing surface, owner module, severity, console/pageerror deltas, request/response delta keys, missing selectors, iframe deltas, timing buckets, Go timing availability, and native/ZeroProxy OK state.
- Records declare redaction properties and avoid raw URLs, raw console text, raw IP addresses, raw source/body/cookie/token data.
- `web/http-rewriter.js` retries safe parse-recovery variants before the final block fallback.
- Recovery variants include leading BOM stripping, classic-script HTML-comment normalization, and classic/module classification retry where safe.
- Final fallback remains blocked.

### 15. Dynamic DOM, Selector, Cookie/Storage, Fetch/XHR, Framework, Event, Observer/Input Matrices

Status: checked in and pinned to implementation/oracle metadata.

Evidence:

- `test/fixtures/dynamic-dom-insertion-matrix.json` and `test/js/dynamic-dom-insertion-matrix.test.js`.
- `test/fixtures/dom-mutation-inventory.json` and `test/js/dom-mutation-inventory.test.js`.
- `test/fixtures/cookie-storage-samesite-matrix.json` and `test/js/cookie-storage-samesite-matrix.test.js`.
- `test/fixtures/fetch-xhr-compat-matrix.json` and `test/js/fetch-xhr-compat-matrix.test.js`.
- `test/fixtures/framework-compatibility/manifest.json` and `test/js/framework-compatibility-fixtures.test.js`.
- `test/fixtures/event-listener-compat-matrix.json` and `test/js/event-listener-compat-matrix.test.js`.
- `test/fixtures/observer-input-event-parity-matrix.json` and `test/js/observer-input-event-parity-matrix.test.js`.
- `test/fixtures/frame-srcdoc-sandbox-milestone.json` and `test/js/frame-srcdoc-sandbox-milestone.test.js`.

## Phase Status

| Phase | Status | Difference from plan |
|---|---|---|
| 1. Freeze baseline tests, add redacted rewrite-failure telemetry, classify fail-close paths | Achieved | Fail-close tests, telemetry records, and corpus release counters exist. |
| 2. Define/enforce rewrite surface model and runtime ABI | Achieved | ABI helpers including `delete`/`typeof` are installed and long-tail surfaces are classified. |
| 3. Split runtime source files | Done | Runtime and SW source are split and bundled. |
| 4. Single-injection bundled delivery with ABI-safe mangling | Mostly done | Bundled delivery exists; default minification is opt-in and documented rather than enabled by default. |
| 5. Rust JS AST transform/codegen | Done | SWC implementation exists and is tested. |
| 6. Move HTML policy into Rust/lol_html streaming rewriting | Achieved for adapter seam | Policy moved; streaming bridge and first-byte tests exist. |
| 7. Move CSS/import-map/inline/external script policy to Rust | Achieved for static policy | Dynamic mutation policy remains runtime-owned by design. |
| 8. Collapse iframe/frame handling to document routing plus boundary wiring | Mostly achieved | Frame routes and boundary wiring exist; unsupported schemes/sandbox cases are explicit expected deltas. |
| 9. Expand dynamic code and worker support | Mostly achieved | Function/eval/timers/workers/module workers/blob/data handling exists; unsupported cases fail closed/classified. |
| 10. Native-vs-ZeroProxy oracle and expected deltas | Achieved for current scope | Local fixture and live corpus expected deltas are checked in. |
| 11. Reduce injection inventory and remove HTML/meta CSP reliance | Achieved | Snapshot and CSP tests exist. |
| 12. Performance budgets and regression gates | Achieved for current measurable surfaces | First-byte/body/retry/timing paths are represented; future work can lower synthetic-gap counts. |
| 13. Representative-site corpus and browser-comparison pipeline | Achieved | Runner, seed corpus, embedded Maps fixture, release artifact, and redacted triage/release records exist. |
| 14. Browser-equivalent pooled/reuse network engine | Partially achieved | Bounded scheduling, priority queueing, reuse timing, and isolation-aware keys exist; safe coalescing remains future work. |
| 15. Redacted failure telemetry and safe parse-failure recovery | Achieved for current scope | Corpus telemetry, rewrite recovery, and fail-closed fallback are wired. |
| 16. Dynamic DOM insertion parity | Matrix/oracle metadata achieved | Per-row behavior fixtures can continue to expand, but current inventory is checked in and pinned. |
| 17. Cookie/storage/SameSite diagnostics and fetch/XHR matrices | Matrix/oracle metadata achieved | Dedicated redacted matrices exist and are wired to source. |
| 18. Framework compatibility fixtures | Achieved as checked-in fixtures | Fixtures exist; external-site corpus remains the broader signal. |
| 19. Dedicated frame/srcdoc/sandbox milestone | Achieved as milestone matrix plus implementation | Static/runtime `srcdoc`, sandbox, and unsupported schemes are tracked. |
| 20. Real performance telemetry propagation | Achieved for repository paths | Go timing reaches hidden Response metadata, Service Worker buffer, runtime Performance, and corpus reports. |
| 21. Page-visible Performance API real data | Achieved for Go-backed resource entries | Runtime fetch entries use real Go phases; synthetic gaps are counted. |
| 22. Complete DOM manipulation hook inventory | Achieved | Classified inventory exists. |
| 23. JS-root visible surface oracle | Achieved for bounded safe graph scope | Corpus records/classifies bounded root-surface deltas. |
| 24. Target-visible selector virtualization | Achieved for planned current attrs | Includes `srcdoc` and `xlink:href`. |
| 25. Event-listener compatibility matrix and internal-listener invisibility oracle | Matrix/oracle metadata achieved | Dedicated matrix exists; message wrapping and internal-listener invisibility are represented. |
| 26. Observer and input-event parity matrices | Matrix/oracle metadata achieved | Dedicated matrix exists with redaction constraints. |

## Final Completion Conditions

| Completion condition | Current status | Evidence |
|---|---|---|
| 0 corpus-defined script rewrite-induced failures | Achieved. Full live release artifact records 0 unexpected rewrite-induced script failures after expected-delta classification. | `test/e2e/representative-sites.release.json`, `scripts/compat-corpus.mjs` |
| 0 generated JavaScript syntax errors | Achieved. Full live release artifact records 0 unexpected generated syntax errors after expected-delta classification. | `test/e2e/representative-sites.release.json`, `test/js/rewriter.test.js`, `rewriter-rs/src/*` tests |
| 0 unexpected script fail-close fallbacks | Achieved. Full live release artifact records 0 unexpected fail-close fallbacks. | `test/e2e/representative-sites.release.json`, `test/js/rewriter.test.js`, `test/js/compat-corpus.test.js` |
| Native-vs-ZeroProxy differences eliminated or listed | Achieved for current scope. Local E2E fixture differences are listed; live corpus has 9 classified expected deltas and 0 triage sites. | `test/e2e/proxy.test.js`, `test/e2e/expected-deltas.json`, `test/e2e/representative-sites.release.json` |
| No independent rewrite policy in `internal/htmltx` | Achieved. Go validates options, prepares boot config, and delegates to Rust hooks. | `internal/htmltx/transform.go`, `test/js/static-policy.test.js` |
| Rust/lol_html HTML transform without full-document Go policy | Achieved. Rust owns HTML policy and exposes string + streaming rewriters. | `rewriter-rs/src/html/document.rs`, `rewriter-rs/src/lib.rs` |
| Streaming first-byte/partial-flush HTML bridge | Achieved for adapter seam. | `internal/htmltx/transform.go`, `internal/htmltx/transform_test.go`, `rewriter-rs/src/html/document.rs` |
| Ordinary iframe/frame loads share top-level transform/runtime path | Mostly achieved. Unsupported schemes are blocked/classified. | `web/runtime-prelude.mjs`, `test/e2e/proxy.test.js`, `test/e2e/expected-deltas.json` |
| Frame-specific behavior limited to boundary wiring and explicit deltas | Achieved for current local scope. | `web/runtime/frames/*.mjs`, `test/fixtures/frame-srcdoc-sandbox-milestone.json`, `test/e2e/expected-deltas.json` |
| Injection inventory minimized and snapshot tested | Achieved. | `internal/htmltx/testdata/injection_inventory.json`, `test/js/static-policy.test.js` |
| Representative-site corpus with browser comparison | Achieved. Full live release gate passes. | `test/e2e/representative-sites.json`, `scripts/compat-corpus.mjs`, `test/e2e/representative-sites.release.json` |
| Naver desktop/mobile full-content and ad-iframe checks | Pass or classified expected delta in live artifact. | `test/e2e/representative-sites.release.json` |
| Google Maps and embedded Maps checks | Pass or classified expected delta in live artifact. | `test/e2e/representative-sites.release.json`, `test/fixtures/representative-sites/embedded-google-maps.html` |
| ipleak surface rendering and redacted IP/DNS classification | Pass or classified expected delta in live artifact. | `test/e2e/representative-sites.release.json` |
| Real measured timing records from browser/runtime/SW/Go | Achieved for repository paths. | `internal/zphttp/roundtrip.go`, `internal/swhttp/bridge_js.go`, `web/sw.js`, `web/runtime/facades/fingerprinting.mjs`, `scripts/compat-corpus.mjs` |
| Browser-equivalent pooled/reuse network engine | Partially achieved. Bounded scheduling, priority queueing, partitioned keys, retry/reuse timing exist; safe coalescing remains future work. | `internal/zphttp/roundtrip.go`, `internal/zphttp/roundtrip_test.go` |
| Redacted failure telemetry | Achieved for current corpus/rewrite/runtime/SW scope. | `scripts/compat-corpus.mjs`, `web/http-rewriter.js`, `web/sw.js`, `test/js/compat-corpus.test.js` |
| Safe parse-failure recovery paths | Achieved for BOM/comment and safe classic/module recovery variants, final fail-closed fallback. | `web/http-rewriter.js`, `test/js/rewriter.test.js` |
| Dynamic DOM insertion parity matrix | Achieved as checked-in prioritized matrix/oracle metadata. | `test/fixtures/dynamic-dom-insertion-matrix.json`, `test/js/dynamic-dom-insertion-matrix.test.js` |
| Complete DOM manipulation hook inventory | Achieved as checked-in classified inventory. | `test/fixtures/dom-mutation-inventory.json`, `test/js/dom-mutation-inventory.test.js` |
| Target-visible selector virtualization | Achieved for `href`, `src`, `srcset`, `action`, `formaction`, `poster`, `srcdoc`, and `xlink:href`. | `web/runtime-prelude.mjs`, `test/js/membrane-invariants.test.js` |
| Cookie/storage/SameSite diagnostics | Achieved as checked-in redacted matrix/oracle metadata. | `test/fixtures/cookie-storage-samesite-matrix.json`, `test/js/cookie-storage-samesite-matrix.test.js` |
| Fetch/XHR compatibility matrix | Achieved as checked-in matrix/oracle metadata. | `test/fixtures/fetch-xhr-compat-matrix.json`, `test/js/fetch-xhr-compat-matrix.test.js` |
| Framework compatibility fixtures | Achieved as checked-in fixture entries. | `test/fixtures/framework-compatibility/manifest.json`, `test/js/framework-compatibility-fixtures.test.js` |
| Frame/srcdoc/sandbox dedicated milestone | Achieved as dedicated milestone matrix with implementation evidence. | `test/fixtures/frame-srcdoc-sandbox-milestone.json`, `test/js/frame-srcdoc-sandbox-milestone.test.js` |
| Event-listener matrix and internal-listener invisibility oracle | Achieved as checked-in matrix/oracle metadata. | `test/fixtures/event-listener-compat-matrix.json`, `test/js/event-listener-compat-matrix.test.js` |
| Observer/input parity matrix and redacted telemetry | Achieved as checked-in matrix/oracle metadata. | `test/fixtures/observer-input-event-parity-matrix.json`, `test/js/observer-input-event-parity-matrix.test.js` |
| Performance API exposes real measured target timing data | Achieved for Go-backed resource entries with target-visible names; synthetic gaps are counted. | `web/runtime/facades/fingerprinting.mjs`, `web/runtime/network/http.mjs`, `test/js/compat-pipeline.test.js` |
| JS-root visible objects/properties/strings comparison | Achieved for bounded safe graph records and classified corpus deltas. | `scripts/compat-corpus.mjs`, `test/js/compat-corpus.test.js` |
| CSP/security invariants green | Achieved and tested. | `web/sw.js`, `web/zp-core.js`, `test/js/membrane-invariants.test.js` |
| Full local verification green | Achieved in the recorded work-session evidence. | See verification section. |

## High-Value Existing Tests

- `test/js/membrane-invariants.test.js`: no direct native fetch fallback, fail-closed unknown requests, masking hooks, CSP invariants, selector virtualization hooks.
- `test/js/static-policy.test.js`: source-level policy invariants, thin Go wrapper over Rust HTML policy, `lol_html` backing, CSP/meta policy constraints, unsafe-eval constraints.
- `test/js/rewriter.test.js`: Rust WASM public API, JS rewrite latency budgets, HTML/CSS/import-map/static URL policy, module graph URL rewriting, fail-close classification, parse-recovery paths.
- `test/js/compat-pipeline.test.js`: runtime network shims, streaming response/upload bridge, WebSocket SW/kernel isolation, real transport timing metadata wiring.
- `test/js/compat-corpus.test.js`: seed corpus completeness, release-gate schema, redaction, triage classification, failure telemetry, root-surface and timing summaries.
- `test/e2e/proxy.test.js`: browser integration, runtime network APIs, workers/module workers, frames/postMessage/frame relation, native-vs-ZeroProxy differential oracle, performance artifact masking.
- `test/js/*matrix.test.js` and `test/js/*fixtures.test.js`: matrix and fixture coverage for dynamic DOM, DOM mutation, cookie/storage/SameSite, fetch/XHR, framework fixtures, event listeners, observer/input parity, frame/srcdoc/sandbox, performance gates, delivery versioning, and rewrite long-tail surfaces.
- Go tests under `internal/*` and `cmd/*`: transport, scheduling, timing, headers, cookies, share URLs, bridge, and wasm-kernel behavior.
- Rust tests under `rewriter-rs/src/*`: parser, rewriter, CSS, import-map, HTML/lol_html streaming/string parity, and share URL behavior.

## Verification Evidence

Observed in the prior status-changing work session and preserved in this document:

- `npm run test:js` passed: 152 tests.
- `npm run test:e2e` passed: 1 browser integration test.
- `go test ./...` passed.
- `npm run test:wasm` passed for `cmd/wasm-kernel` and `internal/swhttp`.
- `cargo test --manifest-path rewriter-rs/Cargo.toml` passed: 48 tests.
- `node scripts/compat-corpus.mjs --mode both --sites wikipedia --timeout-ms 15000 --release-out /tmp/zeroproxy-release-one.json --fail-on-release-gate` passed for the focused live Wikipedia corpus slice.
- `node scripts/compat-corpus.mjs --mode both --release-out test/e2e/representative-sites.release.json --fail-on-release-gate` passed for the full live representative corpus: 14 compared, 5 direct pass, 9 expected-delta, 0 triage, 0 unexpected script rewrite-induced failures, 0 unexpected generated syntax errors, 0 unexpected fail-close fallbacks.
- `npm run lint` passed (`lint:go`, `lint:rust`, `lint:js`) with existing Biome warning-level findings.

Code/document evidence rechecked for this update:

- `internal/htmltx/transform.go` has streaming `DocumentStreamRewriter` support and string fallback.
- `cmd/wasm-kernel/main.go` wires `rewriteHTMLDocumentStreamFromJS` and `rewriteHTMLDocumentFromJS`.
- `rewriter-rs/src/lib.rs` exports `create_html_document_rewriter`.
- `rewriter-rs/src/html/document.rs` rewrites `srcdoc` through `rewrite_document` and contains streaming parity tests.
- `web/runtime-prelude.mjs` installs `__zp_delete`, `__zp_typeof`, runtime `srcdoc` handling, and selector virtualization for `srcdoc`/`xlink:href`.
- `internal/zphttp/roundtrip.go`, `internal/swhttp/bridge_js.go`, `web/runtime/network/http.mjs`, `web/runtime/facades/fingerprinting.mjs`, and `scripts/compat-corpus.mjs` carry Go-to-runtime timing propagation, body/retry fields, PerformanceObserver wrapping, and corpus timing summaries.
- `test/e2e/representative-sites.release.json` records the current passing release-gate metrics.

## Recommended Next Work

The requested status-plan work is complete in repository terms. Future work should focus on shrinking explicit compatibility deltas and improving operational confidence rather than inventing new status scaffolding:

1. Reduce the 9 live corpus `expectedDeltaSites` one site/surface at a time, keeping pass-or-classified release gating.
2. Add safe connection coalescing only where certificate, origin, privacy partition, and isolation constraints permit it.
3. Continue expanding row-level native-vs-ZeroProxy fixtures behind the checked-in matrices where they give better behavior evidence than source needles.
4. Lower synthetic Performance timing gaps and improve static/document resource timing merge precision.
5. Keep expected-delta entries bounded, redacted, and evidence-backed as representative-site behavior changes.

## Remaining Operational Risk

No unclassified release blocker is recorded by the current repository artifacts. The active maintenance risk is the explicit allowlist burden: future changes must not silently grow expected deltas, leak sensitive telemetry, or weaken the membrane transport path. New deltas found by corpus runs should be classified with evidence or fixed at the source.
