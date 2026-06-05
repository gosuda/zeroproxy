# ZeroProxy Implementation Status

Date: 2026-06-05

This document is a standalone implementation-status report. It summarizes the current compatibility and privacy-membrane plan, then compares that plan against the implementation that exists in this repository today.

## Executive Summary

ZeroProxy is already well aligned with the planned architecture. The strongest completed areas are the fail-closed Service Worker classification model, the Go WASM transport kernel, the SOCKS/uTLS target egress path, the Rust rewrite engine, the bundled browser runtimes, and broad runtime facade coverage.

The current implementation has moved most static transformation policy into `rewriter-rs`: JavaScript AST rewriting, HTML document rewriting, CSS URL rewriting, import-map rewriting, URL policy classification, and share-route generation are all Rust-owned or Rust-exposed. `internal/htmltx` is now effectively a Go adapter that prepares boot configuration and delegates document rewriting to the Rust engine.

The main remaining gaps are not small bugs; they are completion gaps against the plan’s stricter end state:

- HTML transformation is Rust/lol_html based, but the Go bridge still reads the whole document before rewriting, so end-to-end streaming partial-flush behavior is not complete.
- `srcdoc` handling is not yet the same as a full document transform; the static path currently prefixes runtime prelude content rather than running a complete contextual document rewrite.
- The runtime has a central artifact masking layer, but not every wrapper/facade is mechanically proven to be centrally registered or documented through expected deltas.
- Native-vs-ZeroProxy differential tests exist and are broad, but the checked-in expected-delta file is still narrow compared with the full planned oracle surface.
- Performance tests exist for Rust rewriter initialization, rewrite size buckets, dynamic function rewriting, and runtime bundle compilation, but the full performance plan is not yet covered by gates.
- Final corpus-level claims such as “0 rewrite-induced script failures” and “0 generated JavaScript syntax errors” are not proven by the current repository alone.

Overall status: approximately 70-80% complete against the plan. The core architecture is in place; the remaining work is mostly about closing strict compatibility proof, streaming semantics, frame/srcdoc edge cases, and performance/oracle completeness.

## The Plan

The planned end state is a human-in-the-loop virtual browsing privacy membrane. A real user drives a real browser, but target traffic must only egress through this path:

```text
Service Worker -> Go WASM kernel -> WebSocket/smux -> SOCKS5 -> uTLS
```

The plan preserves three security invariants:

- no direct target egress outside the membrane transport path;
- no native `fetch(event.request)` fallback for unknown requests;
- no wildcard `connect-src`, direct fetch escape, or fail-open script execution.

The compatibility goal is corpus-defined script compatibility approaching 100%, plus strong primary-flow website compatibility. It is not a claim about the entire public web.

### Planned Architecture

Transformation policy should converge into `rewriter-rs`:

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

The browser runtime should become the execution ABI for rewritten code, not a second independent static rewriting policy. Public helper names such as `__zp_get`, `__zp_set`, `__zp_call`, `__zp_construct`, `__zp_has`, `__zp_ownKeys`, `__zp_getOwnPropertyDescriptor`, and `__zp_module_url` are ABI surface and must remain stable unless the Rust rewriter and runtime are versioned together.

### Planned HTML Transform

The planned HTML transformer is Rust-owned and backed by `lol_html`, so malformed and streaming HTML can be rewritten without a full-document parser. Static document policy should cover:

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

The Go `internal/htmltx` package should become a thin adapter or streaming bridge with no independent rewrite policy. Behavior-preserving migration is expected to use a temporary differential harness during development, followed by permanent characterization/adversarial tests.

### Planned Rewrite Surface

Static rewriting and runtime facades should cover:

- free globals: `window`, `self`, `globalThis`, `location`, `origin`, `document`, `history`, `top`, `parent`, `opener`, `frames`;
- network and dynamic constructors: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `Worker`, `SharedWorker`, `sendBeacon`, `eval`, `Function`, async/generator function constructors, string timers;
- member and reflective access: `window.location`, `location.href`, `location.hash`, `document.defaultView`, `contentWindow`, `contentDocument`, `postMessage`, `Object.getOwnPropertyDescriptor`, `Reflect.ownKeys`, `Object.keys`, `Object.defineProperty`, `in`, `delete`, `typeof`;
- module syntax: static import/export sources, dynamic `import()`, `import.meta.url`, import maps, module workers;
- frame and event boundaries: `event.source`, `event.view`, iframe `parent/top/opener`, `srcdoc`, and nested frame messaging.

The rewriter must preserve local bindings, strings, comments, JSON content, class/object keys outside executable value position, target challenge tokens/configuration, and anything that would require manufacturing target CSP permission.

### Planned Runtime Facades

The runtime should expose explicit facade objects for window, location, history, document, workers, network constructors, events, and frame boundaries. Static rewritten code and dynamic code compiled under a scoped runtime environment should observe the same facade semantics.

Proxy objects are acceptable for plain facade targets and virtual scopes. Native browser objects with non-configurable properties must not be proxied in ways that violate ECMAScript proxy invariants.

### Planned Frame Model

Ordinary `http:` and `https:` iframe/frame navigations should use the same encrypted `/zp/p/<route>#k=...` document route used by top-level documents. Child documents should then pass through the same HTML/JS/CSS/import-map transform and the same runtime ABI.

Frame-specific code should be limited to:

- initial `about:blank` containment before navigation;
- `srcdoc` transformation;
- `contentWindow` and `contentDocument` facade installation;
- `parent`, `top`, `opener`, and `frames` mapping;
- `postMessage` target-origin/source/origin mapping;
- original sandbox semantics preservation;
- explicit blocking of dangerous non-document navigations such as `javascript:`, unsafe `data:`, and unsupported `blob:` cases.

The frame layer should not become a second script or network policy. Sandbox alterations should be explicit, tested against native behavior, and recorded as intentional security deltas.

### Planned Bundling and Injection

Runtime source should be split by responsibility, then bundled for delivery:

- runtime ABI modules;
- facade modules;
- network modules;
- DOM modules;
- frame modules;
- worker modules;
- dynamic-code modules;
- Service Worker modules;
- Rust rewriter modules for JS, HTML, CSS, and import maps.

Delivery should use one target-document bootstrap injection, one bundled runtime asset for target documents, one bundled worker runtime asset, one bundled Service Worker asset, and a Rust rewriter WASM path that is embedded or loaded through a single versioned runtime asset. Minification/mangling should only apply to non-ABI internals. Injection inventory should be snapshot tested.

### Planned Artifact Minimization

ZeroProxy injection and polyfill surfaces should not break normal site compatibility checks that inspect:

- function source strings;
- descriptors;
- enumerability;
- property keys;
- prototypes;
- stack-visible names;
- frame/global identity.

Every injected wrapper or facade should be registered with a central artifact-masking layer or documented as an expected visible delta. The masking layer should cover `Function.prototype.toString`, descriptors, `ownKeys`, global enumeration, frame wrappers, worker wrappers, dynamic-code wrappers, network wrappers, storage wrappers, history/location/document wrappers, and runtime-owned helper surfaces.

The compatibility oracle should also compare the JavaScript root visible surface against the native host browser. Starting from `globalThis`/`window`, it should inventory visible objects, visible properties, descriptors, prototype chains, function source strings, accessor source strings, constructor names, `Symbol.toStringTag`, enumerable keys, own property names, own symbols, `Reflect.ownKeys`, and target-visible string values. The comparison should classify each delta as:

- expected security delta;
- expected privacy/persona delta;
- known compatibility gap;
- implementation bug;
- native/browser-version delta.

This root-surface comparison should recurse through safe, bounded object graphs only. It must avoid invoking arbitrary page getters with side effects unless the probe is explicitly designed for that surface.

### Planned CSP and Policy Handling

ZeroProxy-controlled documents and assets should receive ZeroProxy CSP through response headers or Service Worker response construction, not committed HTML meta CSP.

Target CSP must not control the proxy-origin execution environment. Upstream CSP and report-only headers should be stripped before browser `Response` construction. Target HTML meta CSP should be removed or made inert during static and dynamic HTML transformation.

`'unsafe-eval'` should only be present when target policy allows dynamic compilation and the dynamic body is rewritten before execution. The original target source must never execute on parse or rewrite failure.

### Planned Compatibility Oracle

The plan calls for native-browser-vs-ZeroProxy E2E oracle tests covering:

- descriptors, `ownKeys`, prototypes, `toString`, and global identity;
- centralized artifact masking;
- `window`, `self`, `globalThis`, `location`, and `history`;
- iframe `contentWindow`, `contentDocument`, `parent`, `top`, `opener`, `srcdoc`, nested frames, and `about:blank`;
- ordinary frame document loads using the same `/zp/p` route and transport path as top-level documents;
- `postMessage`, `event.origin`, `event.source`, and cross-frame delivery;
- request headers, response constructor policy, referrer policy, and CSP/header behavior;
- fetch, XHR, WebSocket, EventSource, workers, importScripts, dynamic import, `eval`, `Function`, and string timers.

Expected differences should be listed in a checked-in expected-delta file. Raw script bodies, challenge tokens, clearance cookies, request bodies, challenge configuration, and raw challenge URLs should not be logged.

### Planned Representative Site Corpus

The compatibility plan should include a small, versioned, rate-limited representative-site corpus that runs in two modes:

- native host browser mode;
- ZeroProxy mode through the full membrane.

The corpus should be treated as an external compatibility signal, not as a deterministic unit-test suite. Site failures should be categorized by surface and compared against native-host-browser behavior before being classified as ZeroProxy regressions.

Initial seed corpus:

| Site | Required primary-flow checks |
|---|---|
| `https://naver.com` | Desktop homepage load, full primary content load, ad iframe discovery, ad iframe nonblank/load-state check, major navigation/search entry points visible. |
| `https://m.naver.com` | Mobile homepage load under a mobile viewport/user-agent profile, full primary content load, ad iframe discovery, ad iframe nonblank/load-state check, major navigation/search entry points visible. |
| `https://www.google.com/search?q=zeroproxy` | Search result page render, result links visible, no unexpected script fail-close. |
| `https://www.youtube.com` | Shell render, script graph load, media/player container visible without requiring playback success. |
| `https://www.wikipedia.org` | Static-heavy baseline render, search input visible, navigation links visible. |
| `https://github.com` | Modern app shell render, navigation/header visible, unauthenticated content visible. |
| `https://news.ycombinator.com` | Low-JS baseline, link list render, navigation visible. |
| `https://www.reddit.com` | JS-heavy app shell render, feed/container visible, console/runtime failures compared with native. |
| `https://x.com` | JS-heavy app shell render, unauthenticated landing/login boundary behavior compared with native. |
| `https://www.amazon.com` | Commerce-style homepage render, image/script/css load state, navigation/search controls visible. |
| `https://www.nytimes.com` | News/media layout render, image/script/css load state, paywall/consent behavior compared with native. |
| `https://www.cloudflare.com` | CDN/security/challenge-adjacent baseline, script and navigation render compared with native. |

The corpus should capture only redacted operational data. It must not log raw page bodies, raw scripts, request bodies, cookies, challenge tokens, clearance cookies, challenge configuration, or sensitive URLs beyond normalized site identifiers and coarse failure categories.

### Planned Browser-Comparison Verification Pipeline

The verification pipeline should compare native host-browser behavior and ZeroProxy behavior for every representative site. It should record:

- console messages by level and normalized message fingerprint;
- uncaught exceptions and `pageerror` fingerprints;
- request failures grouped by resource type, scheme, host class, and failure reason;
- response status buckets and content-type buckets;
- DOM readiness and load milestones;
- screenshot and layout-health snapshots;
- key selector visibility for primary content;
- visible text length and major container dimensions;
- iframe count, ad iframe candidates, and iframe load/nonblank state;
- script/style/image/font/media load completion status;
- Service Worker/runtime fail-close categories;
- transport connection counts, reuse rates, and per-origin concurrency.
- real load/performance timings propagated from the Go network engine, Service Worker, runtime, and browser page context.

Rendering comparison should not require exact pixel equality. It should use tolerances and site-specific probes:

- page is not blank;
- primary content containers are visible;
- major navigation/search controls are visible where native shows them;
- console error count and normalized error classes do not exceed native by an allowed threshold;
- blocked/fail-closed paths are either expected deltas or classified compatibility failures;
- ad iframes for `https://naver.com` and `https://m.naver.com` are discovered and reach a loaded/nonblank state when native does.

The pipeline should produce a per-site triage record:

- site;
- viewport/profile;
- primary flow;
- first failing surface;
- native result;
- ZeroProxy result;
- normalized console delta;
- rendering delta;
- timing delta;
- transport delta;
- owner module;
- status.

### Planned Redacted Failure Telemetry

The compatibility pipeline should include redacted failure telemetry that explains why a page broke without logging sensitive source material. The telemetry must never record raw script bodies, raw HTML bodies, request bodies, cookies, challenge tokens, clearance cookies, challenge configuration, or raw challenge URLs.

Allowed telemetry fields should be limited to coarse classifications such as:

- rewrite kind: classic, module, event handler, dynamic function body, worker, module worker;
- source size bucket;
- parser/rewrite error kind;
- retry path attempted;
- blocked URL scheme;
- blocked resource type;
- target content-type and charset;
- facade helper that threw;
- failed runtime API surface;
- Service Worker classification result;
- transport failure class;
- response status bucket;
- page lifecycle phase when failure occurred.

Telemetry output should be joinable with the representative-site triage records, so a broken site can be mapped to the first failing surface without exposing target secrets.

### Planned Safe Parse-Failure Recovery

Parse/rewrite failures must remain fail-closed. The original target source must never execute after a parse or rewrite failure. However, the rewriter can attempt additional safe rewrite paths before returning the final blocking script.

Planned recovery attempts:

- broaden SWC syntax support/options where safe;
- retry with legacy charset decoding when response/document charset evidence supports it;
- retry classic/module classification when the browser request context and script type disagree;
- retry event-handler and dynamic function-body wrapping with safer wrapper variants;
- track known syntax proposal support and add parser fixtures before allowing new syntax through;
- record only redacted retry outcome telemetry.

The final fallback remains a blocking script such as a `DOMException` throw.

### Planned Dynamic DOM Insertion Priority

Dynamic DOM insertion should become a first-priority compatibility milestone because many real sites execute more policy through runtime mutation paths than through static HTML.

The plan should expand parity tests for:

- `innerHTML`;
- `outerHTML`;
- `insertAdjacentHTML`;
- `document.write` and `document.writeln`;
- `Range.createContextualFragment`;
- `DOMParser.parseFromString`;
- `appendChild(script)`;
- `insertBefore(script)`;
- `replaceChild(script)`;
- template parsing and template cloning;
- framework hydration that rewrites or reuses DOM nodes;
- dynamic `srcdoc`.

The runtime insertion path should be compared with the static Rust document policy and native host-browser behavior. Failures should be classified separately from static HTML rewrite failures.

The plan should maintain a complete DOM manipulation hook inventory. Every DOM API that can create, insert, replace, clone, parse, adopt, import, serialize, or mutate executable/URL-bearing markup should be either hooked, proven irrelevant, or listed as an expected limitation.

Required API families include:

- node insertion/removal/replacement: `appendChild`, `insertBefore`, `replaceChild`, `removeChild`, `append`, `prepend`, `before`, `after`, `replaceWith`, `remove`;
- HTML parsing sinks: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `document.writeln`, `DOMParser.parseFromString`, `Range.createContextualFragment`, template `innerHTML`;
- node creation/import/adoption: `createElement`, `createElementNS`, `createTextNode` where relevant, `cloneNode`, `importNode`, `adoptNode`;
- attribute mutation: `setAttribute`, `setAttributeNS`, `removeAttribute`, `toggleAttribute`, reflected URL/script/style/event-handler properties;
- collection/template movement: `DocumentFragment`, `template.content`, fragment insertion, table-specific insertion behavior;
- frame-specific sinks: `iframe.src`, `frame.src`, `srcdoc`, sandbox mutation, initial `about:blank` document writes;
- script/style/link sinks: script `src`, inline script text, module scripts, stylesheet links, inline styles, import maps, preload/preconnect-like links.

The hook inventory should be validated by native-vs-ZeroProxy fixtures that exercise each API family and compare visible DOM strings, executed behavior, loaded resources, and console errors.

Selector APIs also need target-visible virtualization, not just ZeroProxy-artifact filtering. Selectors that refer to target-visible URL attributes must behave as if the DOM contained target URLs, even when the raw browser DOM contains `/zp/...` routes or backup `data-zp-*` attributes. For example, `querySelector('a[href="/next"]')`, `querySelectorAll('script[src="/app.js"]')`, `matches('iframe[src="https://target.example/frame"]')`, and `closest('form[action="/submit"]')` should match based on the target-visible attribute value where native browser behavior would match.

Selector virtualization should cover:

- `Document.prototype.querySelector`;
- `Document.prototype.querySelectorAll`;
- `Element.prototype.querySelector`;
- `Element.prototype.querySelectorAll`;
- `Element.prototype.matches`;
- `Element.prototype.closest`;
- URL-bearing attribute selectors for `href`, `src`, `srcset`, `action`, `formaction`, `poster`, `xlink:href`, `srcdoc`, and relevant reflected properties;
- equality, prefix, suffix, substring, includes-token, and dash-match selector operators where feasible;
- selector lists and nested selectors where browser parsing permits them.

Unsupported selector cases should be documented as expected compatibility gaps. The implementation must not expose `data-zp-*` internals or route selectors to target code while adding this virtualization.

### Planned Cookie, Storage, and SameSite Diagnostics

The oracle should include a dedicated state-management matrix because many sites render but fail login/session flows.

Planned diagnostics:

- redirect-chain `Set-Cookie` capture and replay;
- `SameSite=Lax`, `SameSite=Strict`, `SameSite=None`, and `Secure` behavior;
- iframe cookie visibility and third-party-cookie-shaped cases;
- `document.cookie` reads/writes vs network `Cookie` header behavior;
- cookie expiry/domain/path handling;
- storage namespace sharing across reload, popup, iframe, same-origin frame, and cross-origin frame;
- localStorage/sessionStorage event behavior;
- IndexedDB and CacheStorage namespace visibility.

The diagnostics must keep cookie values redacted. Tests should compare presence, name-level behavior where safe, policy decisions, and same-site context classification without logging secret values.

### Planned Fetch/XHR Compatibility Matrix

The oracle should include a dedicated fetch/XHR matrix because many real-site failures appear as API-call failures rather than initial render failures.

Planned matrix dimensions:

- `mode`;
- `credentials`;
- `redirect`;
- `referrerPolicy`;
- `cache`;
- `integrity`;
- `keepalive`;
- `no-cors` and opaque response behavior;
- abort before headers;
- abort during body streaming;
- XHR timeout and abort events;
- upload stream behavior;
- replayable body behavior;
- range requests;
- response URL and redirected state;
- response header filtering;
- sync XHR allowed vs blocked by policy.

The matrix should compare native and ZeroProxy behavior, then classify deltas as expected security policy, implementation bug, unsupported browser surface, or external/native site behavior.

### Planned Framework Compatibility Fixtures

The fixture suite should include common frontend runtime patterns beyond jQuery. The goal is to catch framework-level breakage before testing external sites.

Planned fixtures:

- React hydration;
- Next-style or Vite-style module graph and dynamic chunks;
- Vue hydration and event binding;
- Angular zone/timer patching;
- Webpack runtime dynamic chunk loading;
- import maps;
- framework-driven `innerHTML` and template cloning;
- framework worker/module-worker loading where relevant.

Each framework fixture should verify render completion, console/runtime errors, dynamic script/chunk loading, event handling, and representative network calls through the membrane.

### Planned Frame, Srcdoc, and Sandbox Milestone

Frame behavior should be split out as its own compatibility milestone instead of being treated as only part of general runtime work. Real breakage is likely to occur in iframe ads, login widgets, payment widgets, embeds, challenge pages, and `srcdoc` content.

The milestone should include:

- full-document-style `srcdoc` transformation;
- initial `about:blank` containment;
- ordinary `http:`/`https:` frame document routing;
- same-origin and cross-origin frame relation checks;
- `contentWindow` and `contentDocument` facade parity;
- `parent`, `top`, `opener`, and `frames` mapping;
- `postMessage` target-origin/source/origin mapping;
- sandbox token preservation;
- explicit expected security deltas for sandbox changes;
- ad iframe and widget iframe load-state checks in the representative-site corpus.

### Planned Performance Work

Major transform changes should be measured for:

- JS rewrite latency by size bucket;
- dynamic `eval`, `Function`, and string timer rewrite latency;
- HTML transform first-byte delay and total time;
- WASM rewriter initialization time;
- runtime bootstrap cost;
- page-load overhead on the compatibility corpus.

Dynamic code needs a synchronous path because `eval`, `Function`, and string timers are synchronously observable.

The performance plan should use real measured data, not only source-level or coarse unit-test budgets. End-to-end performance records should combine:

- browser navigation timing and resource timing;
- runtime bootstrap timing;
- Rust WASM rewriter initialization timing;
- static and dynamic rewrite timing;
- Service Worker classification and dispatch timing;
- Go WASM bridge timing;
- Go network engine timing;
- SOCKS5, TLS, HTTP/1.1, HTTP/2, and WebSocket timing phases;
- queue delay and connection reuse data from the pooled network engine.

The Go network engine should be the source of truth for target-side transport timings. It should emit redacted per-request timing metadata upward through:

```text
Go network engine -> Go WASM kernel -> Service Worker response metadata -> runtime/browser comparison report
```

Required Go-side timing fields:

- request id;
- tab/isolation id hash or redacted correlation id;
- target origin hash or normalized host class;
- queue wait duration;
- connection acquisition duration;
- connection reused vs newly opened;
- SOCKS connect duration;
- TLS handshake duration;
- negotiated protocol;
- request header write duration;
- time to first response byte;
- response body duration;
- total request duration;
- retry count;
- failure class;
- stream id or HTTP/2 session reuse class where safe.

These timings must not expose raw URLs, cookies, request bodies, response bodies, or target secrets. Browser-comparison reports should use them to explain whether a page broke because of rewrite/runtime failure, excessive connection churn, queue starvation, target transport failure, or ordinary native-site behavior.

The page-visible Performance API should expose real measured ZeroProxy timing data in a browser-compatible shape. It should not remain only a masking layer or synthetic fallback. The Performance facade should map internal proxy resources to target-visible entries while preserving real timing phases where safe:

- `performance.getEntries()`;
- `performance.getEntriesByType('navigation')`;
- `performance.getEntriesByType('resource')`;
- `performance.getEntriesByName()`;
- `PerformanceObserver`;
- `PerformanceObserverEntryList`;
- `toJSON()` on performance entries.

For rewritten target resources, the facade should combine browser resource timing with Go-originated transport timing when browser timing only sees `/zp/...` proxy routes. It should keep names target-visible, hide ZeroProxy assets, and expose timing values that are internally consistent with browser Performance APIs. Synthetic entries should be reserved for cases where no real timing can be recovered, and those cases should be counted in telemetry.

### Planned Browser-Equivalent Network Engine

The transport engine should avoid excessive simultaneous target connections and behave closer to a modern browser network stack while preserving the membrane egress path. The plan should add a browser-equivalent pooling/reuse engine with:

- per-origin HTTP/1.1 connection pooling and reuse limits;
- HTTP/2 session reuse and request multiplexing where negotiated;
- bounded global and per-origin concurrency;
- request queuing/backpressure instead of unbounded stream opening;
- idle timeout, connection health, and retry behavior modeled after browser behavior;
- priority-aware scheduling where request priority is available;
- connection coalescing only when it is safe under target origin, certificate, and isolation constraints;
- per-tab or per-isolation-key partitioning so privacy isolation is not weakened by reuse;
- metrics for opened connections, reused connections, queue delay, stream count, failure class, and target origin.

The engine must still route through:

```text
Service Worker -> Go WASM kernel -> WebSocket/smux -> SOCKS5 -> uTLS
```

WebRTC and WebTransport remain out of scope. Failures on those no-goal surfaces should be classified separately as unsupported direct-network surfaces, not as pooled-network-engine regressions.

### Planned Phases

1. Freeze baseline tests, add redacted rewrite-failure telemetry, and classify fail-close paths.
2. Define and enforce the rewrite surface model and runtime ABI.
3. Split runtime source files while preserving bundled behavior.
4. Build single-injection bundled runtime delivery with ABI-safe mangling.
5. Implement Rust JS AST transform/codegen and choose the parser/codegen stack.
6. Move HTML policy into Rust `lol_html` streaming rewriting.
7. Move CSS, import-map, inline script, event handler, and external script rewriting policy into Rust.
8. Collapse iframe/frame handling to ordinary document routing plus explicit boundary wiring.
9. Expand dynamic code and worker support for blob/data workers, module workers, import maps, and importScripts.
10. Add native-vs-ZeroProxy oracle E2E tests and expected deltas.
11. Reduce injection inventory and remove HTML/meta CSP reliance.
12. Add performance budgets and regression gates.
13. Add the representative-site corpus and native-vs-ZeroProxy browser-comparison pipeline.
14. Add the browser-equivalent pooled/reuse network engine and connection-concurrency gates.
15. Add redacted failure telemetry and safe parse-failure recovery paths.
16. Add dynamic DOM insertion parity tests.
17. Add cookie/storage/SameSite diagnostics and fetch/XHR compatibility matrices.
18. Add framework compatibility fixtures.
19. Split frame, `srcdoc`, and sandbox work into a dedicated milestone.
20. Add real performance telemetry propagation from the Go network engine through the browser-comparison reports.
21. Make the page-visible Performance API expose real measured target-resource timing data where safe.
22. Add a complete DOM manipulation hook inventory and parity matrix.
23. Add a JS-root visible surface oracle comparing visible objects, properties, and strings against native browser behavior.
24. Add target-visible selector virtualization for rewritten URL attributes.

### Planned Completion Conditions

The planned final state requires:

- 0 corpus-defined script rewrite-induced failures;
- 0 generated JavaScript syntax errors;
- 0 unexpected script fail-close fallbacks, excluding explicit unsupported policy cases;
- native-vs-ZeroProxy oracle differences either eliminated or listed as expected deltas;
- no independent rewrite policy remaining in `internal/htmltx`;
- centralized Rust/lol_html HTML transformation without full-document HTML policy dependencies;
- ordinary iframe/frame document loads sharing the top-level transform/runtime path;
- frame-specific behavior limited to documented boundary wiring;
- minimized and snapshot-tested injection inventory;
- representative-site corpus produces triage records for native and ZeroProxy runs, including console, rendering, iframe, and transport deltas;
- `https://naver.com` and `https://m.naver.com` pass desktop/mobile full-content and ad-iframe load checks, or failures are classified as expected external/native deltas;
- real measured timing records are collected from browser, runtime, Service Worker, Go WASM bridge, and Go network engine layers;
- target transport uses bounded browser-like connection pooling/reuse without weakening isolation;
- redacted failure telemetry identifies first failing surfaces without logging target secrets;
- parse/rewrite recovery attempts are safe and final failure remains blocked;
- dynamic DOM insertion paths have parity coverage against static policy and native behavior;
- all DOM manipulation APIs that can affect executable or URL-bearing markup are inventoried, hooked, or explicitly classified;
- selector APIs match target-visible URL attributes for rewritten DOM where native selectors would match;
- cookie, storage, SameSite, fetch, and XHR matrices are covered by compatibility oracles;
- framework fixtures cover modern hydration, module graphs, dynamic chunks, and timer patching;
- frame, `srcdoc`, and sandbox behavior is tracked as a separate milestone with explicit expected deltas;
- Performance API entries expose target-visible names with real measured timing data where safe, falling back to synthetic entries only as an explicit telemetry-counted limitation;
- JS root visible objects, visible properties, visible strings, descriptors, prototypes, symbols, and function/accessor source strings are compared against a native host-browser baseline;
- green ZeroProxy CSP/security invariants;
- green full local verification, including JS/E2E tests, wasm tests, Go lint, Rust lint/tests, and the E2E corpus.

## Current Implementation

### Browser and Runtime Assets

The current browser asset organization mostly matches the planned source split.

- Runtime entry: `web/runtime-prelude-entry.mjs`
- Page runtime source: `web/runtime-prelude.mjs`, `web/runtime/**`
- Worker runtime entry/source: `web/worker-prelude-entry.mjs`, `web/worker-prelude.js`, `web/runtime/workers/facades.mjs`
- Service Worker entry/source: `web/sw-entry.mjs`, `web/sw.js`, `web/sw/**`
- Shared core: `web/zp-core.js`
- HTTP/Rust rewriter bridge: `web/http-rewriter.js`, generated `rust-rewriter.js`

`scripts/build.mjs` writes:

- `runtime-prelude.js` as one Vite IIFE bundle;
- `worker-prelude.js` as one Vite IIFE bundle;
- `sw.js` as one Vite IIFE bundle;
- `rust-rewriter.js` plus `rust-rewriter.wasm`;
- classic `zp-core.js`, `http-rewriter.js`, `wasm_exec.js`;
- Go `kernel.wasm`;
- native `zeroproxy-server`.

The build script supports `--minify`, but default build output is not minified. ABI-safe mangling is therefore not a completed default delivery feature.

### Rust Rewriter Engine

`rewriter-rs/src/lib.rs` exports the public WASM ABI:

- `rewrite_script`
- `rewrite_script_with_context`
- `rewrite_css`
- `rewrite_import_map`
- `rewrite_html_document`
- `make_share_url`
- `rewrite_script_url`
- `rewrite_fetch_url`
- `rewrite_srcset`
- `resolve_target_url`
- classification helpers for link rel, blocked elements, meta policy, attr policy, script type, and event handler attrs

`rewriter-rs/src/js/swc_rewriter.rs` uses SWC parsing, resolver marks, and codegen. It rewrites free globals, selected constructors, member/call/assignment/update/in/optional-chain surfaces, static imports/exports, dynamic imports, and `import.meta.url`. Local shadowing is preserved through resolver marks.

`rewriter-rs/src/html/document.rs` uses `lol_html` and currently handles runtime prelude injection, script URL rewriting, inline script rewriting, event-handler rewriting, style rewriting, import-map rewriting, passive resource URLs, navigation attributes, `srcset`, base/meta policy, link policy, object/embed blocking, and backup attributes.

`internal/htmltx/transform.go` validates options, builds boot prelude HTML, reads the source, calls a supplied Rust document rewriter hook, and writes the rewritten output. It no longer contains the old independent static HTML policy body.

### Runtime Facade

The page runtime installs a large facade/membrane in `web/runtime-prelude.mjs` using modules under `web/runtime/**`.

Implemented areas include:

- central artifact masking in `web/runtime/abi/artifact-masking.mjs`;
- native capture in `web/runtime/abi/native-capture.mjs`;
- dynamic code facade in `web/runtime/dynamic-code/*`;
- DOM attribute policy and dynamic HTML/script/style insertion hooks;
- document, location, history, navigator, storage, event, and fingerprinting facades;
- HTTP fetch, Request, XHR, EventSource, sendBeacon handling;
- WebSocket and WebSocketStream facades;
- Worker, SharedWorker, blob worker, data worker, and module worker hooks;
- frame accessors, child rewrite helpers, postMessage mapping, and sandbox containment.

The public helper ABI required by the plan is present and installed non-enumerably, including:

- `__zp_get`
- `__zp_set`
- `__zp_call`
- `__zp_construct`
- `__zp_has`
- `__zp_ownKeys`
- `__zp_getOwnPropertyDescriptor`
- `__zp_module_url`

Additional helpers exist, including `__zp_assign`, `__zp_update`, `__zp_optionalGet`, `__zp_optionalCall`, `__zp_nav_assign`, `__zp_nav_replace`, `__zp_runClassic`, and `__zp_runEvent`.

### Service Worker and Transport

`web/sw.js` classifies every request before target transport:

- internal assets;
- proxy document routes under `/zp/p/<route>`;
- runtime APIs under `/zp/api/*`;
- virtual subresources recovered from context;
- unknown requests.

Unknown navigation returns a `POLICY_BLOCKED` response. Unknown subresources return `Response.error()`. There is no direct `fetch(event.request)` fallback. Native fetch is bound only for first-party asset and kernel loads.

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

## Detailed Gap Analysis

### 1. Security Invariants

Status: substantially achieved.

Current evidence:

- `web/sw.js` default fetch branch fails closed.
- `test/js/membrane-invariants.test.js` verifies unknown request classification, unknown navigation blocking, unknown subresource `Response.error()`, and absence of raw `fetch(event.request)`.
- `web/zp-core.js` builds default-deny CSP without wildcard `connect-src`.
- `test/js/membrane-invariants.test.js` checks CSP default-deny posture and connect-src confinement.
- Target egress path is implemented through `cmd/wasm-kernel/main.go`, `internal/zphttp/roundtrip.go`, `internal/wsproto/client.go`, `internal/socks5/client.go`, and `internal/utlskernel/dial.go`.

Difference from plan:

- The implementation matches the intended invariant model well.
- The remaining difference is proof scope: the full verification gate still needs to be run after any behavior-changing work.

### 2. Transformation Policy Convergence

Status: mostly achieved.

Current evidence:

- JS AST rewrite is in Rust/SWC.
- HTML document transform is in Rust/lol_html.
- CSS URL rewrite is in Rust.
- Import-map rewrite is in Rust.
- Static URL policy classifiers are exported from Rust.
- `internal/htmltx` is an adapter into the Rust document transform.
- `test/js/rewriter.test.js` verifies Rust ownership of script, HTML, CSS, import-map, and static URL/classification paths.

Difference from plan:

- Static transformation policy has largely converged.
- Dynamic runtime enforcement still contains substantial policy for DOM mutations, inserted markup, network facades, frames, workers, and artifact masking. That is partly expected because runtime behavior cannot be purely static, but it means the implementation is not a pure Rust-policy system.
- No checked-in artifact was found documenting the parser/codegen selection comparison that the plan anticipated. The implementation has selected SWC.

### 3. HTML Transform Migration

Status: mostly migrated, not complete.

Current evidence:

- `rewriter-rs/src/html/document.rs` is backed by `lol_html`.
- Static HTML policy lives in Rust.
- `internal/htmltx/transform.go` is a thin adapter and no longer holds the old policy body.
- Rust tests consume `internal/htmltx/testdata/injection_inventory.json`.
- JS tests assert that the Go wrapper delegates to Rust and that Rust owns the document rewrite surface.

Difference from plan:

- The largest gap is streaming. The adapter still uses `io.ReadAll`, then calls a string-based document rewrite. That does not satisfy end-to-end streaming partial-flush behavior.
- `srcdoc` is not fully migrated to the same document-transform model. The static Rust path currently prefixes the runtime prelude to raw `srcdoc` text.
- The current repository can show permanent characterization tests, but it cannot prove that the temporary differential harness required during migration was run and deleted.

### 4. Rewrite Surface Coverage

Status: broad but not complete.

Current evidence:

- Rust rewriter handles many planned free globals and helper surfaces.
- Runtime implements fetch/XHR/EventSource/WebSocket/WebSocketStream/Worker/SharedWorker/sendBeacon/dynamic code.
- Module imports, dynamic imports, import maps, and module workers are covered.
- Frame and message boundaries have runtime modules and E2E coverage.

Difference from plan:

- Explicit `delete` and `typeof` virtualization is less clearly implemented/tested than `in`, descriptor, `ownKeys`, member access, calls, assignments, constructors, and optional chains.
- Preservation of challenge tokens/config, JSON, comments, and strings is structurally helped by AST rewriting, but full adversarial coverage for all target-challenge cases is not visible in this repository.

### 5. Runtime Facade Model

Status: substantially implemented.

Current evidence:

- Location, history, document, worker, network, event, frame, storage, and fingerprinting facades are present.
- Static rewritten code and dynamic code share runtime helper surfaces.
- Dynamic `Function` and string timers rewrite through `ZPHTTPRewriter.rewriteFunctionBody`.
- `eval` uses a scoped native eval path.
- Tests verify descriptor assignability, dynamic eval path, function masking, and many runtime hooks.

Difference from plan:

- The planned model names explicit facade objects such as `WindowFacade` and `LocationFacade`. The implementation has concrete facade modules and objects, but not always as named classes/constructors.
- Browser-native parity for every descriptor/prototype/toString detail is not fully proven. Some tests are source-presence checks rather than behavioral oracle checks.

### 6. Frame Loading Model

Status: partially to substantially implemented.

Current evidence:

- Static HTML treats iframe/frame `src` as navigation and rewrites to encrypted share routes.
- Runtime hooks dynamic frame `src` mutations and frame insertion.
- Service Worker handles `ZP_FRAME_ROUTE`.
- Frame accessors and postMessage mapping exist under `web/runtime/frames/*`.
- E2E covers dynamic iframe document loads, same/cross frame relation, frame postMessage origin/source, and target transport request evidence.

Difference from plan:

- Ordinary `http:`/`https:` frame navigation is close to the planned model.
- `srcdoc` is not yet equivalent to a full transformed child document.
- Initial `about:blank` containment and sandbox handling exist, but the planned explicit security-delta documentation is not complete.
- Unsupported `blob:` frame behavior is not clearly closed to the planned level.
- Frame code still contains nontrivial containment behavior, so it has not fully collapsed to only boundary wiring.

### 7. Bundling and Injection

Status: mostly achieved.

Current evidence:

- Runtime, worker runtime, and Service Worker are split by responsibility and bundled by Vite.
- Tests assert bundled classic assets and absence of visible multi-script runtime injection.
- Injection inventory snapshot exists.
- Srcdoc injection inventory is tested.

Difference from plan:

- Default minification/mangling is not enabled.
- ABI-safe mangling is not documented as complete.
- The Rust WASM asset is a separate `rust-rewriter.wasm` file loaded by `rust-rewriter.js`; it is not visibly versioned in the path.

### 8. Target-Visible Artifact Minimization

Status: substantially implemented, not fully closed.

Current evidence:

- `createArtifactMasking` provides central native-looking `Function.prototype.toString` masking.
- Runtime hides `ZP`, `ZPRewriter`, `ZPRustRewriter`, `ZPHTTPRewriter`, `__ZP_*`, `__zp_*`, and ZeroProxy-marked symbols from enumeration and descriptor probes.
- DOM serialization, selector, and attribute masking are implemented and documented in `docs/masking-surfaces.md`.
- Worker runtime has matching masking.
- E2E differential probes include descriptors, ownKeys, toString, globals, frame wrappers, workers, and dynamic code.

Difference from plan:

- Some wrappers still call `maskNativeFunction` locally. The central layer exists, but there is no mechanical registry proving every injected wrapper is accounted for.
- The expected-delta file does not comprehensively enumerate all visible limitations.
- The plan requires every new wrapper to be centrally registered or explicitly documented as an expected delta; the current system relies on convention plus tests.

### 8a. JavaScript Root Visible Surface Comparison

Status: not started as a complete root-surface oracle.

Current evidence:

- Existing native-vs-ZeroProxy E2E probes cover selected descriptors, own keys, function source strings, global artifact leakage, frame wrappers, worker wrappers, and dynamic-code wrappers.
- Existing tests verify that obvious ZeroProxy globals and helper names are hidden from common enumeration and descriptor probes.

Difference from plan:

- There is no complete bounded graph walk starting at `globalThis`/`window`.
- Visible objects, visible properties, visible strings, descriptors, prototype chains, constructor names, symbols, `Symbol.toStringTag`, and function/accessor source strings are not exhaustively compared against a native host-browser baseline.
- Delta classification is not yet systematic across expected security deltas, privacy/persona deltas, compatibility gaps, implementation bugs, and native browser-version deltas.
- Getter side-effect safety rules for root-surface probing are not yet defined.

### 9. CSP and Policy Handling

Status: substantially achieved.

Current evidence:

- Tests forbid committed HTML CSP meta.
- Response helpers set ZeroProxy CSP.
- Upstream policy headers are stripped through response policy handling.
- Static Rust HTML drops CSP/report-only meta.
- Runtime suppresses dynamic meta policy insertion.
- Unsafe eval is gated by the dynamic-compile branch.
- Script rewrite failures produce blocking code instead of executing original source.

Difference from plan:

- Core mechanics match the plan.
- The remaining gap is broad corpus proof: the current tests do not prove all target CSP combinations across a compatibility corpus.

### 10. Compatibility Oracle

Status: partially to substantially implemented.

Current evidence:

- `test/e2e/proxy.test.js` includes native-vs-ZeroProxy differential behavior.
- `test/e2e/expected-deltas.json` records accepted differences.
- The E2E fixture probes policy headers, descriptors, function source strings, ownKeys/global artifacts, frame document/srcdoc observations, workers/shared workers, fetch/XHR/EventSource/WebSocket, request headers, and fingerprinting surfaces.

Difference from plan:

- The oracle is broad, but it is still centered on a finite fixture, not a declared compatibility corpus.
- Expected deltas are currently narrow: mostly CSP/report-only/permissions headers and selected fingerprint persona/canvas deltas.
- Frame sandbox, `srcdoc`, unsupported blob/data behavior, and target-visible wrapper limitations are not comprehensively listed as expected deltas.

### 11. Performance Plan

Status: partially implemented for coarse local budgets; real end-to-end telemetry is not started.

Current evidence:

- Rust rewriter initialization budget test exists.
- JS rewrite latency size-bucket budgets exist.
- Dynamic `rewriteFunctionBody` budget exists.
- Runtime bundle size and VM compile coarse budget exist.

Difference from plan:

- Existing performance checks are mostly synthetic/coarse tests, not representative-site real-load measurements.
- HTML transform first-byte delay is not measured.
- HTML transform total time is not a full gate.
- Runtime bootstrap cost and page-load overhead on a compatibility corpus are not fully gated.
- Dynamic `eval` and string timer latency are not measured as comprehensively as dynamic `Function` body rewriting.
- Go network engine timings are not propagated into Service Worker/runtime/browser-comparison reports.
- There is no per-request timing model for queue wait, connection acquisition, SOCKS connect, TLS handshake, protocol negotiation, first byte, body duration, reuse status, and failure class.

### 11a. Performance API Real Data Facade

Status: partially implemented as masking; real-data timing exposure is not started.

Current evidence:

- `web/runtime/facades/fingerprinting.mjs` installs `PerformanceObserver` and wraps `performance.getEntries`, `getEntriesByType`, and `getEntriesByName`.
- The current facade maps internal `/zp/api/*` and asset names to target-visible names or hides ZeroProxy assets.
- Synthetic script timing entries are generated when no native browser entry exists.
- E2E checks that ZeroProxy performance artifacts such as `/zp/assets/`, `/zp/kernel.wasm`, and `/zp/api/script` do not leak through `performance.getEntriesByType('resource')`.

Difference from plan:

- The Performance API facade is currently primarily a masking/fingerprinting compatibility layer.
- It does not expose Go-originated real transport timings for rewritten target resources.
- It does not merge browser resource timing with Go network engine timing.
- Synthetic entries are not counted or reported as telemetry gaps.
- Navigation/resource timing values are not yet validated against native browser timing shape beyond artifact hiding.

### 12. Representative Site Corpus and Browser Comparison

Status: not started.

Current evidence:

- Existing E2E tests use local fixture servers and a native-vs-ZeroProxy differential fixture.
- No checked-in representative external-site corpus was found.
- No pipeline currently compares native host-browser and ZeroProxy console errors, rendering health, screenshot/layout state, iframe load state, or ad iframe behavior across a named site list.

Difference from plan:

- `https://naver.com` and `https://m.naver.com` are not currently part of the verification pipeline.
- Desktop/mobile profile comparison is not currently encoded as a reusable corpus runner.
- Ad iframe discovery and full-content-load checks are not currently encoded.
- Console-error and rendering-state comparison against native host-browser behavior is not currently a gate.
- No per-site triage record exists for first failing surface, owner module, native result, ZeroProxy result, and normalized deltas.

### 13. Browser-Equivalent Network Engine

Status: not started.

Current evidence:

- `internal/zphttp.Engine` has HTTP/1.1 idle connection reuse and HTTP/2 connection reuse primitives.
- The current transport already preserves the membrane path through Go WASM, smux, SOCKS5, and uTLS.
- No explicit browser-level network scheduler, bounded per-origin/global concurrency policy, queueing/backpressure layer, or connection reuse metrics were found.

Difference from plan:

- The current engine is not yet a browser-equivalent network engine.
- There is no explicit guard against excessive concurrent target connection use across a page load.
- Connection pooling/reuse exists in pieces, but not as a measured, browser-like policy with per-origin limits, request queues, priority handling, and regression gates.
- The current engine does not emit a complete real timing record upward from Go to the browser-comparison pipeline.
- WebRTC and WebTransport remain intentionally unsupported, but unsupported-surface failures are not yet cleanly separated from ordinary network-engine compatibility failures in the planned external-site pipeline.

### 14. Real Performance Telemetry Propagation

Status: not started.

Current evidence:

- Some tests measure Rust rewriter initialization and rewrite latency.
- Existing network code has transport phases that could be measured, but no complete timing envelope was found.

Difference from plan:

- No redacted per-request timing schema exists across Go network engine, Go WASM kernel, Service Worker, runtime, and browser reports.
- No Go-originated timing fields are attached to responses or side-channel reports for the browser-comparison pipeline.
- Representative-site reports cannot yet distinguish rewrite failure from slow queueing, connection churn, SOCKS/TLS delay, first-byte delay, body streaming delay, or native-site slowness.
- Network reuse and concurrency behavior is not yet backed by real timing data.

### 15. Redacted Failure Telemetry

Status: not started.

Current evidence:

- Existing tests verify fail-closed behavior and redacted failure classifications in some rewrite paths.
- No general telemetry layer was found that records page-break reasons across rewrite, runtime facade, Service Worker, and transport failures.

Difference from plan:

- There is no unified redacted failure event schema.
- There is no per-site aggregation of rewrite kind, source size bucket, parser error kind, blocked URL scheme, failed facade helper, failed API surface, target content-type, or charset.
- Broken-site triage still requires manual inspection instead of first-failing-surface telemetry.

### 16. Safe Parse-Failure Recovery

Status: not started.

Current evidence:

- Parse failures are fail-closed and return blocking code.
- Rust rewriter tests verify parse-failure reporting.

Difference from plan:

- There are no safe retry paths for alternate parser options, legacy charset reinterpretation, classic/module misclassification, event-handler wrapper variants, or dynamic function-body wrapper variants.
- Known syntax proposal support is not tracked as a compatibility matrix.
- Recovery attempts are not represented in telemetry because the telemetry layer does not yet exist.

### 17. Dynamic DOM Insertion Priority

Status: partially implemented, not yet a dedicated milestone.

Current evidence:

- Runtime hooks exist for dynamic insertion surfaces such as script creation, HTML insertion, `document.write`, DOMParser, contextual fragments, and observed attribute enforcement.
- Existing E2E covers several dynamic insertion paths.

Difference from plan:

- Dynamic DOM insertion is not yet prioritized as a separate compatibility workstream.
- There is no matrix that compares static Rust policy, runtime insertion policy, and native behavior across all insertion APIs.
- Framework hydration and template cloning are not covered deeply enough for sites that build most executable DOM dynamically.
- Dynamic `srcdoc` remains part of a broader frame/runtime gap instead of a dedicated insertion-path target.

### 17a. Complete DOM Manipulation Hook Inventory

Status: partially implemented, not complete as an audited inventory.

Current evidence:

- Runtime hooks exist for many insertion and mutation paths, including script creation, URL-bearing attributes, observed attribute enforcement, HTML insertion, document write, DOMParser, contextual fragments, frame accessors, and resource URL properties.
- Source-level tests assert the presence of many escape-vector hooks.

Difference from plan:

- There is no complete checked-in inventory of every DOM API that can create, insert, clone, parse, adopt, import, serialize, or mutate executable/URL-bearing markup.
- Each API family is not yet classified as hooked, irrelevant, unsupported, or expected limitation.
- Native-vs-ZeroProxy fixtures do not yet exercise every DOM manipulation API family.
- Visible DOM strings, executed behavior, loaded resources, and console deltas are not systematically compared for every hook family.

### 17b. Selector Virtualization

Status: partially implemented for artifact hiding; target-visible selector matching is not started.

Current evidence:

- Runtime selector hooks exist for `querySelector`, `querySelectorAll`, `matches`, and `closest`.
- Current selector hooks filter ZeroProxy artifact selectors such as `data-zp-*`, `/zp/assets/`, `/zp/api/`, `src*=zp`, and `zeroproxy`.
- Current selector hooks filter returned ZeroProxy asset nodes.

Difference from plan:

- Selector matching is not virtualized against target-visible URL attributes.
- Selectors such as `querySelector('a[href="/next"]')` can fail when the raw DOM attribute has been rewritten to a `/zp/p/...` route even though page getters expose the target-visible `href`.
- Attribute selector operators for rewritten `href`, `src`, `srcset`, `action`, `formaction`, `poster`, `xlink:href`, and `srcdoc` are not implemented as target-visible matching.
- There is no native-vs-ZeroProxy selector parity matrix for rewritten URL attributes.

### 18. Cookie, Storage, and SameSite Diagnostics

Status: not started as a dedicated matrix.

Current evidence:

- Cookie jar, document cookie sync, storage facades, IndexedDB, and CacheStorage namespacing exist.
- Existing tests cover some cookie/storage behavior.

Difference from plan:

- No dedicated redirect-chain cookie oracle was found.
- Iframe cookie visibility and third-party-cookie-shaped cases are not a first-class matrix.
- `document.cookie` vs network `Cookie` header behavior is not comprehensively compared.
- SameSite Lax/Strict/None/Secure behavior is not comprehensively covered by native-vs-ZeroProxy diagnostics.
- Storage namespace sharing across reload, popup, iframe, same-origin frame, and cross-origin frame is not a complete matrix.

### 19. Fetch/XHR Compatibility Matrix

Status: not started as a dedicated matrix.

Current evidence:

- Runtime fetch, Request, XHR, EventSource, upload streams, abort, and response facade behavior exist.
- Existing E2E and JS tests cover important pieces of these APIs.

Difference from plan:

- There is no complete matrix over `mode`, `credentials`, `redirect`, `referrerPolicy`, `cache`, `integrity`, `keepalive`, `no-cors`, opaque responses, abort phases, upload streams, replayable bodies, range requests, response URL, redirected state, header filtering, and sync XHR policy.
- API-call failures are not yet classified separately from render/script failures in the representative-site pipeline.

### 20. Framework Compatibility Fixtures

Status: not started.

Current evidence:

- jQuery fixture coverage exists.
- Module worker and dynamic script fixtures exist.

Difference from plan:

- No React hydration fixture was found.
- No Next/Vite module-graph fixture was found.
- No Vue fixture was found.
- No Angular zone/timer fixture was found.
- No Webpack dynamic chunk loading fixture was found.
- Import maps are tested at the rewriter level, but not as part of a framework-style app fixture.

### 21. Frame, Srcdoc, and Sandbox Dedicated Milestone

Status: partially implemented, not separated as a milestone.

Current evidence:

- Frame routing, accessors, postMessage mapping, sandbox handling, and frame E2E checks exist.
- `srcdoc` has runtime/static handling.

Difference from plan:

- Frame, `srcdoc`, and sandbox work is currently spread across runtime, HTML transform, and E2E coverage instead of tracked as a separate milestone.
- `srcdoc` is not yet close enough to full document transformation.
- Sandbox changes are not comprehensively recorded as expected security deltas.
- Ad/login/widget/payment/challenge iframe patterns are not covered by a dedicated corpus or fixture matrix.

## Phase Status

| Phase | Status | Difference from plan |
|---|---|---|
| Baseline tests, redacted failures, fail-close classification | Mostly done | Tests and fail-close behavior exist; full operational telemetry is limited. |
| Rewrite surface model and runtime ABI | Mostly done | ABI helpers exist; `delete`/`typeof` and adversarial non-rewrite cases need stronger proof. |
| Runtime source split | Done | Runtime and SW source are split and bundled. |
| Single-injection bundled delivery with ABI-safe mangling | Mostly done | Bundled delivery exists; default ABI-safe mangling is not complete. |
| Rust JS AST transform/codegen | Mostly done | SWC implementation exists; selection comparison is not documented. |
| Move HTML policy to Rust/lol_html streaming | Mostly done | Policy moved; end-to-end streaming partial flush remains incomplete. |
| Move CSS/import-map/inline/external script policy to Rust | Mostly done | Static paths moved; dynamic mutation policy remains runtime-owned. |
| Collapse iframe/frame behavior to document routing plus boundary wiring | Partially done | Document routing exists; `srcdoc`, sandbox deltas, and edge cases remain. |
| Expand dynamic code and workers | Mostly done | Function/eval/timers/workers/module workers/blob/data handling exists; some cases intentionally fail closed. |
| Native-vs-ZeroProxy oracle and expected deltas | Partially done | Strong fixture exists; expected deltas are not comprehensive. |
| Reduce injection inventory and remove HTML/meta CSP reliance | Mostly done | Snapshot and CSP tests exist. |
| Performance budgets and regression gates | Partially done | Coarse budgets exist; full plan is not gated and real load timing is not collected. |
| Performance API real-data facade | Not started | Current Performance API facade masks names and creates synthetic script entries, but does not expose Go/network real timing data. |
| Representative-site corpus and browser comparison pipeline | Not started | No external site list, native-vs-ZeroProxy console/render comparison, or Naver desktop/mobile ad-iframe/full-content checks are currently checked in. |
| Browser-equivalent pooled/reuse network engine | Not started | Some reuse primitives exist, but there is no browser-like scheduler, concurrency policy, queueing/backpressure gate, or transport reuse metric gate. |
| Real performance telemetry propagation | Not started | No Go-network-engine-to-browser timing envelope exists. |
| Redacted failure telemetry | Not started | No unified redacted failure event schema or first-failing-surface aggregation exists. |
| Safe parse-failure recovery | Not started | Parse failure blocks correctly, but no alternate safe rewrite attempts are implemented. |
| Dynamic DOM insertion parity | Partially done | Runtime hooks exist, but there is no dedicated insertion API parity matrix or framework hydration coverage. |
| Complete DOM manipulation hook inventory | Not started as an audited inventory | Many hooks exist, but there is no complete API inventory with native-vs-ZeroProxy parity coverage. |
| Target-visible selector virtualization | Not started | Artifact filtering exists, but selectors like `a[href="/next"]` are not matched against target-visible rewritten URL attributes. |
| Cookie/storage/SameSite diagnostics | Not started | Cookie/storage components exist, but no dedicated native-vs-ZeroProxy state matrix exists. |
| Fetch/XHR compatibility matrix | Not started | Fetch/XHR components exist, but no complete option/error matrix exists. |
| Framework compatibility fixtures | Not started | jQuery exists, but React/Next/Vite/Vue/Angular/Webpack fixture coverage is absent. |
| Frame/srcdoc/sandbox dedicated milestone | Partially done | Frame pieces exist, but `srcdoc`, sandbox deltas, and iframe-pattern coverage are not separated into a dedicated milestone. |
| JS-root visible surface comparison | Not started | Selected artifact probes exist, but no bounded root graph comparison against native browser visible objects/properties/strings exists. |

## Final Completion Conditions

| Completion condition | Current status |
|---|---|
| 0 corpus-defined script rewrite-induced failures | Not proven. |
| 0 generated JavaScript syntax errors | Partially proven by rewriter tests and E2E, not corpus-proven. |
| 0 unexpected script fail-close fallbacks | Partially proven; full corpus classification is absent. |
| All native-vs-ZeroProxy differences eliminated or listed | Partially achieved; expected deltas are narrow. |
| No independent rewrite policy in `internal/htmltx` | Achieved for static policy. |
| Rust/lol_html HTML transform without full-document policy parser | Mostly achieved; streaming adapter is incomplete. |
| Ordinary iframe/frame loads share top-level transform/runtime path | Mostly achieved for `http:`/`https:` `src`; incomplete for `srcdoc` and some security deltas. |
| Injection inventory minimized and snapshot tested | Mostly achieved. |
| Representative-site corpus with browser comparison | Not started. |
| `https://naver.com` desktop full-content and ad-iframe checks | Not started. |
| `https://m.naver.com` mobile full-content and ad-iframe checks | Not started. |
| Browser-equivalent pooled/reuse network engine | Not started. |
| Real performance telemetry from Go network engine to browser reports | Not started. |
| Performance API exposes real measured target timing data | Not started. |
| Redacted failure telemetry | Not started. |
| Safe parse-failure recovery paths | Not started. |
| Dynamic DOM insertion parity matrix | Not started as a dedicated matrix. |
| Complete DOM manipulation hook inventory | Not started as an audited inventory. |
| Target-visible selector virtualization | Not started. |
| Cookie/storage/SameSite diagnostics | Not started as a dedicated matrix. |
| Fetch/XHR compatibility matrix | Not started as a dedicated matrix. |
| Framework compatibility fixtures | Not started. |
| Frame/srcdoc/sandbox dedicated milestone | Not started as a separate milestone. |
| JS-root visible object/property/string comparison | Not started. |
| CSP/security invariants green | Strongly implemented and tested; still requires running gates before claiming release readiness. |
| Full local verification green | Not run as part of this document update. |

## High-Value Existing Tests

- `test/js/membrane-invariants.test.js`: no direct native fetch fallback, fail-closed unknown requests, masking hooks, CSP invariants.
- `test/js/static-policy.test.js`: source-level policy invariants, thin Go wrapper over Rust HTML policy, `lol_html` backing, CSP/meta policy constraints, unsafe-eval constraints.
- `test/js/rewriter.test.js`: Rust WASM public API, JS rewrite latency budgets, HTML/CSS/import-map/static URL policy, module graph URL rewriting, fail-close classification.
- `test/js/compat-pipeline.test.js`: runtime network shims, streaming response/upload bridge, WebSocket SW/kernel isolation.
- `test/e2e/proxy.test.js`: browser integration, runtime network APIs, workers/module workers, frames/postMessage/frame relation, native-vs-ZeroProxy differential oracle.
- Go tests under `internal/*` and `cmd/*`: transport, headers, cookies, share URLs, bridge, and wasm-kernel behavior.
- Rust tests under `rewriter-rs/src/*`: parser, rewriter, CSS, import-map, and share URL behavior.

## Recommended Next Work

1. Add the representative-site corpus and browser-comparison runner.
   - Seed the corpus with `https://naver.com` and `https://m.naver.com` first.
   - Capture native and ZeroProxy console errors, rendering health, screenshot/layout state, iframe state, and transport deltas.
   - Add Naver desktop/mobile full-content and ad-iframe load checks as `Not started` work items until implemented.

2. Add the browser-equivalent pooled/reuse network engine.
   - Define per-origin and global concurrency limits.
   - Add request queueing/backpressure.
   - Measure connection opens, reuse, queue delay, and failure classes.
   - Keep WebRTC and WebTransport classified as unsupported no-goal surfaces.

3. Add real performance telemetry propagation.
   - Measure timing in the Go network engine.
   - Propagate redacted request timing through the Go WASM kernel, Service Worker, and runtime report.
   - Include queue wait, connection acquisition, reuse/new connection state, SOCKS connect, TLS handshake, protocol negotiation, first byte, body duration, total duration, retry count, and failure class.
   - Join timing records with representative-site console/render/iframe reports.

4. Make the Performance API expose real measured data.
   - Preserve target-visible entry names while using real browser and Go-originated timing phases where safe.
   - Merge `/zp/...` browser resource timing with Go transport timing for rewritten target resources.
   - Count synthetic fallback entries as telemetry gaps.
   - Add native-vs-ZeroProxy tests for navigation/resource entry shape, `toJSON`, `PerformanceObserver`, and hidden ZeroProxy assets.

5. Add the JS-root visible surface oracle.
   - Compare visible objects, properties, descriptors, prototypes, symbols, `toString` output, constructor names, `Symbol.toStringTag`, and visible strings against a native host-browser baseline.
   - Use bounded graph traversal and avoid unsafe getter invocation by default.
   - Classify deltas as security, privacy/persona, compatibility gap, implementation bug, or native browser-version delta.

6. Add a complete DOM manipulation hook inventory.
   - Inventory every create/insert/replace/remove/clone/import/adopt/parse/serialize/attribute API that can affect executable or URL-bearing markup.
   - Mark each API as hooked, irrelevant, unsupported, or expected limitation.
   - Add native-vs-ZeroProxy fixtures for each API family.

7. Add target-visible selector virtualization.
   - Make `querySelector`, `querySelectorAll`, `matches`, and `closest` compare rewritten URL attributes through their target-visible values.
   - Cover cases like `querySelector('a[href="/next"]')`, `script[src]`, `iframe[src]`, `form[action]`, `button[formaction]`, `img[src]`, `srcset`, and `srcdoc`.
   - Preserve existing filtering for `data-zp-*`, `/zp/assets/`, `/zp/api/`, and other ZeroProxy internals.
   - Add native-vs-ZeroProxy selector parity fixtures.

8. Add redacted failure telemetry.
   - Record first failing surface, rewrite kind, size bucket, parser error kind, blocked scheme, failed helper/API surface, content-type, charset, and transport class.
   - Keep raw source, bodies, cookies, tokens, challenge data, and sensitive URLs out of logs.

9. Add safe parse-failure recovery.
   - Retry safe parser/charset/classification/wrapper variants.
   - Keep final fallback blocked.

10. Prioritize dynamic DOM insertion parity.
   - Add a matrix for `innerHTML`, `document.write`, script insertion, templates, contextual fragments, DOMParser, hydration, and dynamic `srcdoc`.

11. Add cookie/storage/SameSite diagnostics.
   - Cover redirect-chain cookies, iframe cookie visibility, SameSite variants, `document.cookie` vs network cookies, and storage sharing across reload/popup/frame.

12. Add the fetch/XHR compatibility matrix.
   - Cover mode, credentials, redirect, referrerPolicy, no-cors/opaque, abort, upload stream, replayable body, range requests, and sync XHR policy.

13. Add framework compatibility fixtures.
   - Add React hydration, Next/Vite module graph, Vue, Angular zone/timer patching, Webpack dynamic chunks, and framework import-map coverage.

14. Split frame, `srcdoc`, and sandbox into a dedicated milestone.
   - Track ad/login/widget/payment/challenge iframe patterns.
   - Move `srcdoc` toward full document transformation.
   - Record sandbox security deltas explicitly.

15. Finish end-to-end streaming HTML transformation.
   - Replace the current `io.ReadAll` adapter path with a streaming Rust/lol_html bridge, or explicitly document the non-streaming limitation.
   - Add first-byte and partial-flush tests.

16. Upgrade `srcdoc` handling.
   - Run `srcdoc` through the same Rust document policy with explicit parent/context handling.
   - Add native-vs-ZeroProxy expected deltas for any intentional containment.

17. Expand expected-delta coverage.
   - Cover frame sandbox containment, `srcdoc`, data/blob worker and frame limits, and target-visible wrapper artifacts.

18. Close rewrite-surface long tail.
   - Add explicit tests or implementation for `typeof` and `delete`.
   - Add adversarial tests for challenge-token/config preservation and non-rewriting of JSON/comment/string content.

19. Complete performance gates.
   - Add HTML first-byte and total-time budgets.
   - Add runtime bootstrap and page-load overhead budgets.
   - Add dynamic eval/string timer latency coverage.
   - Base representative-site performance gates on real timing records, not only synthetic unit budgets.

20. Clarify delivery versioning and minification.
   - Decide whether minification should be default.
   - Document ABI helper preservation under minification.
   - Version or otherwise document the Rust rewriter/runtime asset compatibility strategy.

21. Run the full verification gate after status-changing work.
   - `npm test`
   - `npm run test:wasm`
   - `npm run lint:go`
   - `npm run lint:rust`
   - `npm run lint:js`
   - `cargo test --manifest-path rewriter-rs/Cargo.toml`
