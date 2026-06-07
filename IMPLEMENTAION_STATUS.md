# ZeroProxy Implementation Status

Date: 2026-06-07

This document is a standalone implementation-status report. It summarizes the current compatibility and privacy-membrane plan, then compares that plan against the implementation that exists in this repository today.

## Executive Summary

ZeroProxy is already well aligned with the planned architecture. The strongest completed areas are the fail-closed Service Worker classification model, the Go WASM transport kernel, the SOCKS/uTLS target egress path, the Rust rewrite engine, the bundled browser runtimes, and broad runtime facade coverage.

The current implementation has moved most static transformation policy into `rewriter-rs`: JavaScript AST rewriting, HTML document rewriting, CSS URL rewriting, import-map rewriting, URL policy classification, and share-route generation are all Rust-owned or Rust-exposed. `internal/htmltx` is now effectively a Go adapter that prepares boot configuration and delegates document rewriting to the Rust engine.

The main remaining gaps are not small bugs; they are completion gaps against the plan’s stricter end state:

- HTML transformation is Rust/lol_html based, but the Go bridge still reads the whole document before rewriting, so end-to-end streaming partial-flush behavior is not complete.
- `srcdoc` handling is not yet the same as a full document transform at runtime; the static Rust path now rewrites `srcdoc` through `rewrite_document`, but runtime-set `srcdoc` still uses the JS injection path.
- The runtime has a central artifact masking layer, but not every wrapper/facade is mechanically proven to be centrally registered or documented through expected deltas.
- Native-vs-ZeroProxy differential tests exist and are broad, but the checked-in expected-delta file is still narrow compared with the full planned oracle surface.
- Performance tests exist for Rust rewriter initialization, rewrite size buckets, dynamic function rewriting, and runtime bundle compilation, but the full performance plan is not yet covered by gates.
- Final corpus-level claims such as “0 rewrite-induced script failures” and “0 generated JavaScript syntax errors” are not proven by the current repository alone.

Overall status: approximately 70-80% complete against the architecture plan, but only about 55-60% complete against the stricter final release-completion conditions. The core architecture is in place; the remaining work is mostly about closing strict compatibility proof, streaming semantics, frame/srcdoc edge cases, behavior-level matrices, and performance/oracle completeness.

Verification update on 2026-06-07: local proof still supports the architecture-level estimate, but it also confirms that many “done” items are inventory, matrix, or runner completion rather than end-to-end native-vs-ZeroProxy behavior gates. The main shortfalls are:

- Representative-site corpus runs are encoded, but no committed native-vs-ZeroProxy pass/fail artifact proves Naver, Google Maps, embedded Maps, ipleak, or the broader seed corpus.
- Multiple compatibility matrices are checked in, but per-row behavior fixtures are still pending for dynamic DOM insertion, DOM mutation, cookie/storage/SameSite, fetch/XHR, framework fixtures, event listeners, observer/input events, and frame/srcdoc/sandbox.
- HTML transformation still lacks true streaming first-byte/partial-flush behavior because the Go adapter reads the whole document before calling the Rust transformer.
- Runtime-set `srcdoc`, sandbox deltas, unsupported frame edge cases, and third-party widget/ad/login iframe behavior remain below the planned frame milestone.
- Root-surface and expected-delta coverage is bounded and selective; it does not yet recursively classify visible object/property/string deltas across a safe object graph.
- Real timing now flows through important paths, but navigation/static resources, body duration, retry count, synthetic timing-gap telemetry, and PerformanceObserver delivery are not complete.
- `npm run lint` passes, but Biome currently emits warning-level cleanup findings; they do not fail the gate, but they are not evidence of zero-warning JS hygiene.

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

The corpus should capture only redacted operational data. It must not log raw page bodies, raw scripts, request bodies, cookies, challenge tokens, clearance cookies, challenge configuration, raw IP addresses, raw DNS resolver values, or sensitive URLs beyond normalized site identifiers and coarse failure categories.

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
- ad iframes for `https://naver.com` and `https://m.naver.com` are discovered and reach a loaded/nonblank state when native does;
- Google Maps and embedded Google Maps reach a nonblank map/tile state when native does, with frame, postMessage, console, tile/API, and permission deltas classified;
- `https://ipleak.net` renders its leak-test result containers and classifies IP/DNS/WebRTC-related differences without logging raw IP addresses or resolver values.

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

### Planned Event Listener Compatibility Matrix

The compatibility plan should include a dedicated event-listener matrix because event delivery and listener bookkeeping are core to framework hydration, navigation interception, ads, widgets, login flows, and cross-frame messaging.

The current architecture should preserve the useful simplification that native DOM event dispatch remains native where possible. ZeroProxy-owned internal listeners should remain hidden from target code and should not be removable through ordinary page JavaScript. At the same time, target-visible listener APIs must behave like the host browser.

The matrix should cover:

- `EventTarget.prototype.addEventListener`;
- `EventTarget.prototype.removeEventListener`;
- `EventTarget.prototype.dispatchEvent`;
- listener identity and duplicate-registration behavior;
- function listeners and object listeners with `handleEvent`;
- options object behavior for `capture`, `once`, `passive`, and `signal`;
- boolean capture argument compatibility;
- `AbortSignal` removal behavior;
- listener ordering across capture, target, and bubble phases;
- `stopPropagation`, `stopImmediatePropagation`, and `preventDefault`;
- `defaultPrevented`, cancelable events, and passive-listener warnings/deltas;
- `on*` property handlers such as `onclick`, `onload`, `onerror`, and `onmessage`;
- rewritten inline event-handler attributes;
- cross-frame `message` events, `event.origin`, `event.source`, and `MessageEvent.source`;
- facade event targets such as XHR, XHR upload, EventSource, WebSocket, workers, service-worker facade objects, and storage events;
- listener behavior across window, document, elements, shadow roots, frames, popups, and initial `about:blank` documents;
- descriptor, `toString`, own-key, symbol, and property-name visibility of listener hooks and internal stores.

The matrix should explicitly prove that ZeroProxy internal listeners cannot be enumerated, obtained, or removed by target code through standard DOM APIs. Any unavoidable DevTools-only visibility should be documented as outside the target-page threat model, while target-page-visible leakage should be classified as a compatibility or stealth bug.

Expected implementation direction:

- keep native DOM listener dispatch for ordinary DOM targets where the host browser can safely own ordering and phase behavior;
- virtualize only the listener APIs that need target-visible event objects, such as `message` source/origin mapping;
- keep original listener identity mappings in weak storage so target `removeEventListener` works when ZeroProxy wraps a listener;
- avoid target-visible symbol or expando listener stores on native DOM objects;
- make ZeroProxy-created facade event targets match native `EventTarget` semantics instead of using a simplified listener list;
- add native-vs-ZeroProxy oracle fixtures for every matrix row.

### Planned Observer and Input Event Parity

The compatibility plan should include a dedicated observer and input-event parity matrix because modern app shells depend on observers and high-fidelity input events for hydration, lazy loading, infinite scroll, editors, maps, drag interactions, menus, and mobile layouts.

Observer parity should cover:

- `MutationObserver` constructor shape, callback timing, record shape, subtree behavior, attribute filters, old-value options, `takeRecords`, and `disconnect`;
- `IntersectionObserver` constructor shape, root/rootMargin/threshold behavior, callback timing, entry shape, visibility transitions, lazy-loading sentinel behavior, and frame/scroll-container cases;
- `ResizeObserver` constructor shape, callback timing, entry box sizes, loop-limit behavior, hidden/display-none transitions, SVG/iframe edge cases, and framework layout recalculation behavior;
- observer callback ordering relative to microtasks, animation frames, timers, DOM mutations, layout, and navigation;
- descriptor, `toString`, own-key, symbol, and visible-string parity for observer constructors, prototypes, callbacks, and entries.

Input-event parity should cover:

- pointer events: `pointerdown`, `pointermove`, `pointerup`, `pointercancel`, `pointerenter`, `pointerleave`, pointer capture, pressure/tilt/twist metadata, primary pointer state, and mouse compatibility events;
- mouse events: click/dblclick/contextmenu ordering, button/buttons, coordinates, relatedTarget, capture/bubble behavior, and prevented-default effects;
- touch events: `touchstart`, `touchmove`, `touchend`, `touchcancel`, touch lists, passive listener behavior, preventDefault restrictions, mobile viewport behavior, and scroll interaction;
- keyboard events: key/code/location/repeat/modifier state, keydown/keypress/keyup ordering, focus target behavior, shortcut handling, and editable-field behavior;
- composition and text input events: `compositionstart`, `compositionupdate`, `compositionend`, `beforeinput`, `input`, selection state, IME behavior, textarea/contenteditable behavior, and framework-controlled input reconciliation;
- focus/blur/focusin/focusout ordering across frames, popups, shadow roots, and dynamically inserted controls;
- wheel/scroll events, passive behavior, infinite-scroll sentinel behavior, and native-vs-ZeroProxy scroll state.

The matrix should compare native host-browser behavior and ZeroProxy behavior using fixture pages that exercise framework hydration, lazy images, infinite scrolling, map pan/zoom, autocomplete/search fields, drag/drop-like pointer flows, IME-style text input, and contenteditable editors. Expected deltas should be explicit, especially where privacy/persona choices intentionally clamp high-entropy device metadata.

Telemetry should classify observer/input failures separately from script rewrite, DOM insertion, network, frame, and rendering failures. It must not log typed text, clipboard data, selected text, raw pointer paths, or sensitive form values; it should record only redacted event type, target class, phase, option flags, and coarse failure categories.

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
25. Add an event-listener compatibility matrix and internal-listener invisibility oracle.
26. Add observer and input-event parity matrices for hydration, lazy loading, infinite scroll, maps, and editable controls.

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
- Google Maps and embedded Google Maps pass nonblank map/tile, frame, postMessage, permission, and widget-console checks, or failures are classified as expected external/native deltas;
- `https://ipleak.net` passes leak-test surface rendering checks with raw IP/DNS values redacted and WebRTC/WebTransport no-goal behavior classified separately;
- real measured timing records are collected from browser, runtime, Service Worker, Go WASM bridge, and Go network engine layers;
- target transport uses bounded browser-like connection pooling/reuse without weakening isolation;
- redacted failure telemetry identifies first failing surfaces without logging target secrets;
- parse/rewrite recovery attempts are safe and final failure remains blocked;
- dynamic DOM insertion paths have parity coverage against static policy and native behavior;
- all DOM manipulation APIs that can affect executable or URL-bearing markup are inventoried, hooked, or explicitly classified;
- selector APIs match target-visible URL attributes for rewritten DOM where native selectors would match;
- cookie, storage, SameSite, fetch, and XHR matrices are covered by compatibility oracles;
- framework fixtures cover modern hydration, module graphs, dynamic chunks, and timer patching;
- event-listener APIs match native behavior for listener identity, options, ordering, handler properties, wrapped message events, and facade event targets;
- ZeroProxy internal listeners and listener stores are not enumerable, obtainable, or removable by target code through standard page APIs;
- observer APIs and input events match native behavior for callback timing, record/entry shape, ordering, pointer/mouse/touch/keyboard/composition/input semantics, and scroll/focus interactions;
- observer/input telemetry uses redacted event classes and never logs typed text, clipboard data, selected text, raw pointer paths, or sensitive form values;
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
- `srcdoc` is partially migrated to the document-transform model. The static Rust path now runs `srcdoc` through `rewrite_document`, while runtime-set `srcdoc` still uses the JS injection path.
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

Status: partially implemented in the representative corpus runner.

Current evidence:

- Existing native-vs-ZeroProxy E2E probes cover selected descriptors, own keys, function source strings, global artifact leakage, frame wrappers, worker wrappers, and dynamic-code wrappers.
- Existing tests verify that obvious ZeroProxy globals and helper names are hidden from common enumeration and descriptor probes.
- `scripts/compat-corpus.mjs` now records a bounded root-surface oracle for each native or ZeroProxy page observation.
- The oracle starts at `globalThis`, records own-key/name/symbol counts, a bounded sorted name sample, `Symbol.toStringTag`, and descriptors for planned high-risk globals such as `window`, `self`, `globalThis`, `location`, `document`, `history`, frame relations, `fetch`, XHR, WebSocket, Worker, `PerformanceObserver`, and `Function`.
- The probe avoids invoking arbitrary page getters beyond `Object.getOwnPropertyDescriptor` on `globalThis` and selected descriptor metadata.

Difference from plan:

- A bounded root-surface comparison input now exists in the native-vs-ZeroProxy representative-site records.
- The implementation does not yet recurse through broader safe object graphs or classify every delta as security, privacy/persona, compatibility gap, implementation bug, or native browser-version delta.
- Function/accessor source strings are currently represented by source length for redaction; full source-string fingerprints and prototype-chain traversal are still pending.

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

Status: partially implemented with real Go transport resource entries.

Current evidence:

- `web/runtime/facades/fingerprinting.mjs` installs `PerformanceObserver` and wraps `performance.getEntries`, `getEntriesByType`, and `getEntriesByName`.
- The current facade maps internal `/zp/api/*` and asset names to target-visible names or hides ZeroProxy assets.
- Synthetic script timing entries are generated when no native browser entry exists.
- E2E checks that ZeroProxy performance artifacts such as `/zp/assets/`, `/zp/kernel.wasm`, and `/zp/api/script` do not leak through `performance.getEntriesByType('resource')`.
- Runtime fetch now records hidden `Response.__zpTransportTiming` metadata into a non-enumerable `__zpPerformanceTimings` store.
- The Performance facade turns those Go-originated timing records into target-visible resource entries with real queue/connect/SOCKS/TLS/first-byte/total phases and `serverTiming` phase metrics.
- `performance.getEntries()`, `getEntriesByType('resource')`, and `getEntriesByName(targetURL, 'resource')` include those real transport-backed entries.
- `test/js/compat-pipeline.test.js` pins the runtime/SW wiring for real transport timing metadata, and `npm run test:e2e` covers hidden ZeroProxy assets plus runtime integration.

Difference from plan:

- The Performance API facade is no longer only a masking/fingerprinting compatibility layer for runtime fetches that receive Go timing metadata.
- Go-originated transport timings are exposed as target-visible resource entries where the runtime fetch facade observes the response metadata.
- Browser resource timing and Go timing are not fully merged for every static/document resource yet; current Go-backed entries are synthesized from real Go phases rather than merged with all browser fields.
- Synthetic fallback entries are still not counted as telemetry gaps.
- Navigation timing, `PerformanceObserver` delivery of the synthesized Go entries, body duration, retry count, and committed native-vs-ZeroProxy shape fixtures remain incomplete.

### 12. Representative Site Corpus and Browser Comparison

Status: implemented as a checked-in runner; full external corpus gate not yet release-green.

Current evidence:

- Existing E2E tests use local fixture servers and a native-vs-ZeroProxy differential fixture.
- `test/e2e/representative-sites.json` now checks in the representative seed corpus, including Naver desktop/mobile, Google Search, Google Maps, an embedded Google Maps fixture, Wikipedia, GitHub, Hacker News, Reddit, x.com, Amazon, NYTimes, Cloudflare, and ipleak.net.
- `test/fixtures/representative-sites/embedded-google-maps.html` is the checked-in embedded Maps host fixture.
- `scripts/compat-corpus.mjs` runs native, ZeroProxy, or native-vs-ZeroProxy comparison mode and emits redacted per-site triage records with site id, profile, primary flow, native result, ZeroProxy result, first failing surface, owner module, normalized console/pageerror fingerprints, request-failure buckets, response buckets, selector/rendering state, screenshot digest, iframe/ad/map state, timing delta, and browser-observed transport deltas.
- `npm run test:corpus` invokes the runner for operational corpus runs.
- `test/js/compat-corpus.test.js` verifies the checked-in seed list, redaction of raw URLs/IPs/tokens, and triage classification.

Difference from plan:

- The named representative sites are now encoded in a reusable corpus runner.
- Native-vs-ZeroProxy console-error, rendering-state, screenshot-digest, iframe-state, first-failing-surface, owner-module, and normalized-delta records are now produced by the runner.
- Naver desktop/mobile ad-iframe checks, Google Maps map/frame checks, embedded Maps iframe checks, and ipleak redaction/no-goal classification are encoded as corpus expectations, but they are not yet a release gate with committed pass/fail artifacts.
- Transport delta is currently based on browser-observed request failures and response buckets; Go-originated timing/reuse data is still pending the later real performance telemetry and pooled-network-engine goals.

### 13. Browser-Equivalent Network Engine

Status: implemented for bounded and priority-aware HTTP request scheduling; reuse metrics and safe coalescing remain pending telemetry work.

Current evidence:

- `internal/zphttp.Engine` has HTTP/1.1 idle connection reuse and HTTP/2 connection reuse primitives.
- `internal/zphttp.Engine.RoundTrip` now acquires a browser-style request slot before target transport work and releases it when the response body reaches EOF or is closed.
- The scheduler enforces `maxBrowserRequestsPerOrigin = 6` and `maxBrowserGlobalRequests = 64`, keyed by target authority plus tab/isolation key so reuse limits do not cross privacy partitions.
- Over-limit requests queue by Fetch priority (`X-Zp-Fetch-Priority`) and FIFO order within the same priority; they are unblocked when an active response releases its slot.
- Canceled contexts are removed from the queue without leaking scheduler state.
- `internal/zphttp/roundtrip_test.go` covers per-origin queueing/backpressure, queued-priority ordering, and canceled queued requests.

Difference from plan:

- The engine now has an explicit guard against excessive concurrent HTTP target requests across a page load.
- Connection pooling/reuse still uses the existing HTTP/1.1 idle pool and HTTP/2 session reuse; safe connection coalescing is not yet implemented.
- The current engine does not yet emit measured connection-open, reuse, queue-delay, or failure-class metrics upward; that remains part of the real performance telemetry propagation goal.
- WebRTC and WebTransport remain intentionally unsupported, but unsupported-surface failures are not yet cleanly separated from ordinary network-engine compatibility failures in the planned external-site pipeline.

### 14. Real Performance Telemetry Propagation

Status: partially implemented for Go-to-Service-Worker-to-corpus timing records.

Current evidence:

- Some tests measure Rust rewriter initialization and rewrite latency.
- `internal/zphttp.TransportTiming` defines a redacted per-request timing schema with request id, tab id hash, target origin hash, queue wait, connection acquisition, stream open, SOCKS connect, TLS handshake, first byte, total duration, reuse state, negotiated protocol, and failure class.
- `internal/zphttp.Engine.RoundTrip` populates timing records from real scheduler, connection, SOCKS/TLS, and response-header observations, then attaches them to the internal `X-Zp-Transport-Timing` handoff header.
- `internal/swhttp.ResponseToJS` moves the timing record into a non-enumerable `Response.__zpTransportTiming` property and removes the handoff header before browser `Response` construction.
- `web/sw.js` records those timing objects in a bounded Service Worker buffer and exposes redacted records through `ZP_TRANSPORT_TIMINGS`.
- `scripts/compat-corpus.mjs` queries the Service Worker timing buffer and joins timing summaries into representative-site records and transport deltas.
- Tests cover Go timing JSON, hidden WASM response timing properties, corpus timing summaries, JS tests, wasm tests, and Go lint for the touched packages.

Difference from plan:

- Redacted Go-originated timing now propagates through the Go WASM bridge, Service Worker, and browser-comparison runner.
- Timing records include queue wait, connection acquisition, SOCKS connect, TLS handshake, protocol, first-byte, total duration, and reuse/new-connection state where a target response is produced.
- Response body duration, retry count, and timing records for failures that produce only a synthetic safe error response are not yet propagated.
- The page-visible Performance API does not yet merge these Go timing records into `PerformanceEntry` data; that remains the next goal.
- Network reuse and concurrency behavior is now backed by initial per-response timing records, but not yet by body-duration/retry telemetry or committed external-corpus trend gates.

### 15. Redacted Failure Telemetry

Status: partially implemented in corpus comparison reports.

Current evidence:

- Existing tests verify fail-closed behavior and redacted failure classifications in some rewrite paths.
- `scripts/compat-corpus.mjs` now emits `failureTelemetry` records with schema `zp.failure.telemetry.v1` for native-vs-ZeroProxy comparisons.
- The telemetry records include first failing surface, owner module, severity, console/pageerror deltas, request/response delta keys, missing visible selectors, iframe deltas, timing buckets, Go timing availability, and native/ZeroProxy OK state.
- Records explicitly declare redaction properties: no raw URLs, raw console text, raw IP addresses, or raw source/body/cookie/token data; console/pageerror details remain fingerprint/bucket based.
- `test/js/compat-corpus.test.js` verifies schema, surface, redaction flags, and evidence fields.

Difference from plan:

- A unified redacted failure event schema now exists for the representative-site comparison runner.
- Per-site first-failing-surface and owner-module aggregation exists in corpus comparison reports.
- Rewrite-specific fields such as parser error kind, source size bucket, content-type, charset, and failed helper/API surface are not yet emitted by all rewrite/runtime/SW paths.

### 16. Safe Parse-Failure Recovery

Status: partially implemented for safe classic-script retry variants.

Current evidence:

- Parse failures are fail-closed and return blocking code.
- Rust rewriter tests verify parse-failure reporting.
- `web/http-rewriter.js` now retries safe parse-recovery variants before the final block fallback.
- Current recovery variants strip a leading BOM and normalize classic-script HTML comment sentinels (`<!--` / `-->`) into JS comments before retrying.
- `rewriteScriptOutcome` reports which redacted recovery variants were attempted and which variant, if any, succeeded.
- `test/js/rewriter.test.js` verifies that a classic HTML-comment parse failure retries safely before blocking.

Difference from plan:

- Safe retry paths exist for BOM stripping and classic-script HTML-comment normalization.
- Final fallback remains blocked when recovery does not produce a successful rewrite.
- Legacy charset reinterpretation, classic/module misclassification recovery, event-handler wrapper variants, dynamic function-body wrapper variants, and syntax-proposal tracking are not yet implemented.

### 17. Dynamic DOM Insertion Priority

Status: prioritized as a checked-in matrix; behavior fixtures remain incomplete.

Current evidence:

- Runtime hooks exist for dynamic insertion surfaces such as script creation, HTML insertion, `document.write`, DOMParser, contextual fragments, and observed attribute enforcement.
- Existing E2E covers several dynamic insertion paths.
- `test/fixtures/dynamic-dom-insertion-matrix.json` now prioritizes `innerHTML`/`outerHTML`, `document.write`, programmatic script insertion, templates, contextual fragments, DOMParser, framework hydration/dynamic chunks, and dynamic `srcdoc`.
- Each matrix row records priority, fixture class, probes, expected delta, and runtime hook needles.
- `test/js/dynamic-dom-insertion-matrix.test.js` verifies matrix completeness and keeps rows wired to runtime hooks.

Difference from plan:

- Dynamic DOM insertion is now a separate compatibility workstream with P0/P1 rows.
- Framework hydration, template cloning, and dynamic `srcdoc` have explicit rows and expected deltas.
- Native-vs-ZeroProxy behavior fixtures for every row are not yet implemented.

### 17a. Complete DOM Manipulation Hook Inventory

Status: checked-in inventory added; parity fixtures are still incomplete.

Current evidence:

- Runtime hooks exist for many insertion and mutation paths, including script creation, URL-bearing attributes, observed attribute enforcement, HTML insertion, document write, DOMParser, contextual fragments, frame accessors, and resource URL properties.
- Source-level tests assert the presence of many escape-vector hooks.
- `test/fixtures/dom-mutation-inventory.json` now inventories create, insert/replace, HTML-string sinks, document write/fragment parsing, attribute mutation, template content, frame source properties, clone/import/adopt, serialization, and removal families.
- Each inventory row records the affected APIs, status (`hooked`, `partial`, `expected-limitation`, or `irrelevant`), source needles for hooked/partial rows, and coverage notes.
- `test/js/dom-mutation-inventory.test.js` verifies that every planned API family has a classified row and that hooked/partial rows still match runtime source.

Difference from plan:

- A complete checked-in DOM manipulation hook inventory exists and is mechanically pinned to runtime source for hooked/partial families.
- Native-vs-ZeroProxy behavioral fixtures do not yet exercise every DOM manipulation API family.
- Visible DOM strings, executed behavior, loaded resources, and console deltas are not systematically compared for every hook family.

### 17b. Selector Virtualization

Status: partially implemented for target-visible URL attribute selectors.

Current evidence:

- Runtime selector hooks exist for `querySelector`, `querySelectorAll`, `matches`, and `closest`.
- Selector hooks still filter ZeroProxy artifact selectors such as `data-zp-*`, `/zp/assets/`, `/zp/api/`, `src*=zp`, and `zeroproxy`.
- Selector hooks still filter returned ZeroProxy asset nodes.
- `web/runtime-prelude.mjs` now virtualizes selector matching for target-visible URL-bearing attributes by broadening native selectors, then filtering against visible `href`, `src`, `action`, `formaction`, `poster`, and `srcset` values.
- The virtualization path covers `querySelector`, `querySelectorAll`, `matches`, and `closest`, while preserving native syntax errors through the broadened native selector.
- `test/js/membrane-invariants.test.js` pins the target-visible selector virtualization hooks.

Difference from plan:

- Selectors like `a[href=\"/next\"]`, `img[src*=...]`, `form[action=...]`, and `button[formaction=...]` can now match against the target-visible value rather than only the rewritten raw DOM route.
- `srcdoc` and `xlink:href` selector virtualization are not yet implemented.
- There is no native-vs-ZeroProxy selector parity matrix for rewritten URL attributes.

### 18. Cookie, Storage, and SameSite Diagnostics

Status: checked-in diagnostics matrix; behavior fixtures remain incomplete.

Current evidence:

- Cookie jar, document cookie sync, storage facades, IndexedDB, and CacheStorage namespacing exist.
- Existing tests cover some cookie/storage behavior.
- `test/fixtures/cookie-storage-samesite-matrix.json` now covers redirect-chain `Set-Cookie`, `document.cookie` vs network cookies, SameSite Lax/Strict/None, iframe cookie visibility, storage sharing across reload/popup/frame, and redacted cookie failure telemetry.
- Each row defines priority, probes, redaction rules, and source needles.
- `test/js/cookie-storage-samesite-matrix.test.js` verifies matrix coverage, redaction constraints, and source wiring.

Difference from plan:

- Cookie/storage/SameSite diagnostics now have a dedicated redacted matrix.
- Behavior fixtures and native-vs-ZeroProxy state comparisons for every row are not yet implemented.

### 19. Fetch/XHR Compatibility Matrix

Status: checked-in compatibility matrix; behavior fixtures remain incomplete.

Current evidence:

- Runtime fetch, Request, XHR, EventSource, upload streams, abort, and response facade behavior exist.
- Existing E2E and JS tests cover important pieces of these APIs.
- `test/fixtures/fetch-xhr-compat-matrix.json` now covers fetch mode/credentials, redirect/referrer policy, no-cors/opaque behavior, abort/upload/replayable bodies, XHR sync/async states, XHR headers/errors/progress, and range/cache/content-encoding axes.
- `test/js/fetch-xhr-compat-matrix.test.js` verifies matrix coverage and keeps rows wired to implementation surfaces.

Difference from plan:

- Fetch/XHR now has a dedicated option/error matrix.
- API-call failures are not yet classified separately from render/script failures in all representative-site telemetry.
- Per-row native-vs-ZeroProxy behavior fixtures are still pending.

### 20. Framework Compatibility Fixtures

Status: fixture set checked in; native-vs-ZeroProxy framework runs remain pending.

Current evidence:

- jQuery fixture coverage exists.
- Module worker and dynamic script fixtures exist.
- `test/fixtures/framework-compatibility/manifest.json` now defines React hydration, Next/Vite-style ESM module graph, Vue reactivity, Angular/Zone timer patching, and Webpack dynamic chunk fixtures.
- The fixture directory includes checked-in HTML/JS entry files for those rows, including local module/dynamic chunk files for the Vite/Webpack-style cases.
- `test/js/framework-compatibility-fixtures.test.js` verifies fixture coverage, checked-in entry files, visible probes, surfaces, priorities, and expected deltas.

Difference from plan:

- React hydration, Next/Vite module graph, Vue, Angular/Zone timer, Webpack dynamic chunk, and framework import-map-style fixture entries now exist.
- These fixtures are not yet wired into the representative-site native-vs-ZeroProxy runner as a committed behavior gate.

### 20a. Event Listener Compatibility Matrix

Status: checked-in matrix; behavior oracle remains incomplete.

Current evidence:

- Native DOM event dispatch is mostly preserved for ordinary page DOM targets.
- Runtime navigation hooks install internal `click`, `popstate`, and `scroll` listeners before target code runs.
- Standard page JavaScript cannot enumerate native browser listener lists, and ZeroProxy internal listener function references are closure-local, so they are not normally removable through `removeEventListener`.
- `message` listeners are wrapped so `MessageEvent` source/origin can be virtualized while original listener identity is tracked for `removeEventListener`.
- Rewritten inline event-handler attributes are moved to ZeroProxy-controlled backing attributes and rebound as listeners.
- ZeroProxy-created facade targets such as XHR, XHR upload, EventSource, and WebSocket use a simplified internal listener implementation.
- `test/fixtures/event-listener-compat-matrix.json` now covers listener identity, duplicate registration, options, dispatch/propagation order, inline/on-property handlers, message wrapping, and internal-listener invisibility.
- `test/js/event-listener-compat-matrix.test.js` verifies matrix coverage and source wiring.

Difference from plan:

- Event-listener compatibility now has a dedicated matrix.
- Native-vs-ZeroProxy behavior fixtures and focused invisibility/removal attempts for every row are not yet implemented.
- Facade event targets still may not match native `EventTarget` semantics for all listener options and ordering rules.
- Event-listener failures are not yet classified separately in all representative-site telemetry.

### 20b. Observer and Input Event Parity

Status: checked-in matrices; behavior fixtures remain incomplete.

Current evidence:

- Runtime uses `MutationObserver` internally for policy enforcement.
- Frameworks rely heavily on observer and input-event timing for lazy loading, hydration, controlled inputs, and virtualized lists.
- `test/fixtures/observer-input-event-parity-matrix.json` now covers `MutationObserver`, `IntersectionObserver`, `ResizeObserver`, pointer/mouse/wheel events, keyboard/focus/composition events, and touch/input/selection events.
- `test/js/observer-input-event-parity-matrix.test.js` verifies coverage, priorities, and probe/API rows.

Difference from plan:

- Observer/input-event parity now has a dedicated matrix.
- Native-vs-ZeroProxy behavior fixtures and callback/event-order checks are not yet implemented for each row.

### 21. Frame, `srcdoc`, and Sandbox Dedicated Milestone

Status: checked-in dedicated milestone matrix; implementation work remains incomplete.

Current evidence:

- Frame routing, accessors, postMessage mapping, sandbox handling, and frame E2E checks exist.
- `srcdoc` has runtime/static handling.
- `test/fixtures/frame-srcdoc-sandbox-milestone.json` now separates ordinary frame routing, dynamic `srcdoc`, sandbox-token deltas, widget/login/payment/challenge frames, and static `srcdoc` transformation into milestone rows.
- `test/js/frame-srcdoc-sandbox-milestone.test.js` verifies milestone row coverage, expected deltas, and source wiring.

Difference from plan:

- Frame, `srcdoc`, and sandbox work is now tracked as a dedicated milestone matrix.
- `srcdoc` is not yet close enough to full document transformation.
- Sandbox changes and third-party frame provider behaviors still need behavior fixtures and expected-delta classification.
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
| Performance API real-data facade | Partially implemented | Runtime fetch timing metadata becomes target-visible resource entries with Go queue/connect/SOCKS/TLS/first-byte/total phases; navigation/static merge and observer delivery remain incomplete. |
| Representative-site corpus and browser comparison pipeline | Implemented as runner; not release-gated | Seed corpus, embedded Maps fixture, redacted runner, and triage records exist; full external corpus pass/fail artifacts are not committed. |
| Browser-equivalent pooled/reuse network engine | Partially implemented | RoundTrip now has per-origin/global request limits plus priority-aware queueing/backpressure and reuse-state timing; coalescing and corpus trend gates remain pending. |
| Real performance telemetry propagation | Partially implemented | Redacted Go timing records propagate to hidden Response metadata, Service Worker timing buffer, and corpus reports; body duration, retry count, and safe-error timing remain pending. |
| Redacted failure telemetry | Partially implemented | Corpus comparison reports now emit `zp.failure.telemetry.v1` first-failing-surface records with redacted bucket/fingerprint evidence; rewrite/runtime/SW path-specific fields remain pending. |
| Safe parse-failure recovery | Partially implemented | HTTP script rewriting retries safe BOM/comment recovery variants and still blocks on final failure; charset/classification/wrapper variants remain pending. |
| Dynamic DOM insertion parity | Matrix checked in | `test/fixtures/dynamic-dom-insertion-matrix.json` prioritizes HTML-string sinks, document.write, script insertion, templates, fragments, DOMParser, hydration, and dynamic srcdoc; row-level behavior fixtures remain pending. |
| Complete DOM manipulation hook inventory | Inventory checked in | `test/fixtures/dom-mutation-inventory.json` classifies create/insert/parse/attribute/frame/template/clone/serialize/remove families and `test/js/dom-mutation-inventory.test.js` pins hooked rows to runtime source; full behavior fixtures remain pending. |
| Target-visible selector virtualization | Partially implemented | `querySelector`, `querySelectorAll`, `matches`, and `closest` now compare selected URL attributes through target-visible values; `srcdoc`/`xlink:href` and full parity matrix remain pending. |
| Cookie/storage/SameSite diagnostics | Matrix checked in | `test/fixtures/cookie-storage-samesite-matrix.json` covers redirect cookies, document-vs-network cookies, SameSite variants, iframe visibility, storage sharing, and redacted diagnostics; behavior fixtures remain pending. |
| Fetch/XHR compatibility matrix | Matrix checked in | `test/fixtures/fetch-xhr-compat-matrix.json` covers mode, credentials, redirect, referrerPolicy, no-cors/opaque, abort, upload streams, replayable bodies, range/cache headers, and sync XHR policy; behavior fixtures remain pending. |
| Framework compatibility fixtures | Fixtures checked in | React hydration, Next/Vite-style module graph, Vue reactivity, Angular/Zone timer patching, and Webpack dynamic chunk fixtures exist under `test/fixtures/framework-compatibility`; native-vs-ZeroProxy fixture runs remain pending. |
| Frame/srcdoc/sandbox dedicated milestone | Milestone matrix checked in | `test/fixtures/frame-srcdoc-sandbox-milestone.json` separates frame routing, dynamic/static srcdoc, sandbox-token deltas, and third-party widget/login/payment/challenge iframe patterns; implementation/behavior fixtures remain pending. |
| Event-listener compatibility matrix | Matrix checked in | `test/fixtures/event-listener-compat-matrix.json` covers listener identity, options, dispatch ordering, inline/on-property handlers, message wrapping, and internal-listener invisibility; behavior oracle remains pending. |
| Observer and input-event parity matrix | Matrix checked in | `test/fixtures/observer-input-event-parity-matrix.json` covers observer constructors and pointer/mouse/touch/wheel/keyboard/focus/composition/beforeinput/input surfaces; behavior fixtures remain pending. |
| JS-root visible surface comparison | Partially implemented | Corpus records now include bounded `globalThis` own-key counts, descriptor samples, constructor names, toStringTag, and function source lengths; recursive graph walk and delta classification remain pending. |

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
| Representative-site corpus with browser comparison | Implemented as `scripts/compat-corpus.mjs` with checked-in seed corpus; full external run not committed as a release gate. |
| `https://naver.com` desktop full-content and ad-iframe checks | Encoded in corpus expectations; not release-gated with a committed run artifact. |
| `https://m.naver.com` mobile full-content and ad-iframe checks | Encoded in corpus expectations; not release-gated with a committed run artifact. |
| `https://www.google.com/maps` nonblank map/tile checks | Encoded in corpus expectations; not release-gated with a committed run artifact. |
| Embedded Google Maps iframe/widget checks | Checked-in fixture and corpus expectations exist; not release-gated with a committed run artifact. |
| `https://ipleak.net` leak-test surface checks with redacted IP/DNS comparison | Encoded in corpus expectations with coarse IP/DNS redaction; not release-gated with a committed run artifact. |
| Browser-equivalent pooled/reuse network engine | Partially achieved: bounded per-origin/global HTTP request scheduling, priority queueing, and reuse-state timing are implemented; safe coalescing remains pending. |
| Real performance telemetry from Go network engine to browser reports | Partially achieved: queue/connect/SOCKS/TLS/first-byte/total/reuse/protocol records reach the corpus report path; body duration and retry count are pending. |
| Performance API exposes real measured target timing data | Partially achieved for runtime fetch resource entries backed by Go transport timing; navigation/static resources and body-duration/retry phases are pending. |
| Redacted failure telemetry | Partially achieved in corpus comparison reports; full rewrite/runtime/SW telemetry fields remain pending. |
| Safe parse-failure recovery paths | Partially achieved for BOM stripping and classic-script HTML-comment normalization; charset/classification/wrapper variants remain pending. |
| Dynamic DOM insertion parity matrix | Achieved as a checked-in prioritized matrix; per-row native-vs-ZeroProxy behavior fixtures remain pending. |
| Complete DOM manipulation hook inventory | Achieved as a checked-in classified inventory; per-family native-vs-ZeroProxy behavior fixtures remain pending. |
| Target-visible selector virtualization | Partially achieved for `href`, `src`, `srcset`, `action`, `formaction`, and `poster`; `srcdoc`, `xlink:href`, and parity fixtures remain pending. |
| Cookie/storage/SameSite diagnostics | Achieved as a checked-in redacted matrix; per-row native-vs-ZeroProxy state fixtures remain pending. |
| Fetch/XHR compatibility matrix | Achieved as a checked-in matrix; per-row native-vs-ZeroProxy behavior fixtures remain pending. |
| Framework compatibility fixtures | Achieved as checked-in fixture entries; behavior-gated native-vs-ZeroProxy runs remain pending. |
| Frame/srcdoc/sandbox dedicated milestone | Achieved as a dedicated milestone matrix; srcdoc upgrade and behavior fixtures remain pending. |
| Event-listener compatibility matrix and internal-listener invisibility oracle | Achieved as a checked-in matrix; behavior oracle remains pending. |
| Observer and input-event parity matrix | Achieved as a checked-in matrix; callback/event-order fixtures remain pending. |
| JS-root visible object/property/string comparison | Partially achieved through corpus root-surface records; recursive graph traversal and systematic delta classification remain pending. |
| CSP/security invariants green | Strongly implemented and tested; still requires running gates before claiming release readiness. |
| Full local verification green | Re-verified on 2026-06-07 with `npm run test:js`, `npm run test:e2e`, `go test ./...`, `npm run test:wasm`, `cargo test --manifest-path rewriter-rs/Cargo.toml`, and `npm run lint`; lint passed with Biome warnings. |

## High-Value Existing Tests

- `test/js/membrane-invariants.test.js`: no direct native fetch fallback, fail-closed unknown requests, masking hooks, CSP invariants.
- `test/js/static-policy.test.js`: source-level policy invariants, thin Go wrapper over Rust HTML policy, `lol_html` backing, CSP/meta policy constraints, unsafe-eval constraints.
- `test/js/rewriter.test.js`: Rust WASM public API, JS rewrite latency budgets, HTML/CSS/import-map/static URL policy, module graph URL rewriting, fail-close classification.
- `test/js/compat-pipeline.test.js`: runtime network shims, streaming response/upload bridge, WebSocket SW/kernel isolation.
- `test/e2e/proxy.test.js`: browser integration, runtime network APIs, workers/module workers, frames/postMessage/frame relation, native-vs-ZeroProxy differential oracle.
- Go tests under `internal/*` and `cmd/*`: transport, headers, cookies, share URLs, bridge, and wasm-kernel behavior.
- Rust tests under `rewriter-rs/src/*`: parser, rewriter, CSS, import-map, and share URL behavior.

## Recommended Next Work

1. Add the representative-site corpus and browser-comparison runner. **Done as a checked-in runner.**
   - `test/e2e/representative-sites.json` seeds the corpus with `https://naver.com`, `https://m.naver.com`, Google Search, `https://www.google.com/maps`, an embedded Google Maps fixture, `https://ipleak.net`, and the broader planned seed sites.
   - `scripts/compat-corpus.mjs` captures native and ZeroProxy console/pageerror fingerprints, rendering health, screenshot digest, iframe/ad/map state, request/response buckets, browser-observed transport deltas, first failing surface, owner module, and normalized deltas.
   - `test/js/compat-corpus.test.js` covers seed completeness, redaction, and triage classification.
   - Remaining limitation: the runner exists, but full external-site pass/fail artifacts are not committed as a release gate until later verification work.

2. Add the browser-equivalent pooled/reuse network engine. **Partially done for bounded and priority-aware HTTP scheduling.**
   - `internal/zphttp.Engine` now enforces per-origin and global active-request limits before target egress.
   - Over-limit HTTP requests queue by Fetch priority and FIFO order within the same priority, then release by response-body EOF/close.
   - Canceled queued requests are removed without leaking scheduler state.
   - `internal/zphttp/roundtrip_test.go` verifies queueing/backpressure, priority ordering, and cancellation.
   - Remaining limitation: safe coalescing and corpus trend gates are deferred to the telemetry/performance goals below.

3. Add real performance telemetry propagation. **Partially done for response-producing target requests.**
   - `internal/zphttp.Engine` measures queue wait, connection acquisition, stream open, SOCKS connect, TLS handshake, first-byte, total duration, reuse state, negotiated protocol, and redacted request/origin/tab identifiers.
   - `internal/swhttp.ResponseToJS` moves timing metadata to hidden `Response.__zpTransportTiming` without exposing the internal timing header to target code.
   - `web/sw.js` stores bounded redacted timing records and serves them through `ZP_TRANSPORT_TIMINGS`.
   - `scripts/compat-corpus.mjs` joins Service Worker timing summaries into representative-site reports.
   - Remaining limitation: body duration, retry count, and synthetic safe-error timing are not yet propagated.

4. Make the Performance API expose real measured data. **Partially done for runtime fetch resource entries.**
   - `web/runtime/network/http.mjs` records hidden Go transport timing metadata from runtime fetch responses.
   - `web/runtime/facades/fingerprinting.mjs` exposes those records through target-visible `PerformanceResourceTiming`-shaped entries and phase `serverTiming` metrics.
   - Target-visible names are preserved while ZeroProxy assets remain hidden.
   - `test/js/compat-pipeline.test.js`, `npm run test:js`, and `npm run test:e2e` cover the wiring and integration.
   - Remaining limitation: full browser-resource/Go timing merge for static/document resources, `PerformanceObserver` delivery, synthetic-gap telemetry, body duration, and retry count are still pending.

5. Add the JS-root visible surface oracle. **Partially done in the corpus runner.**
   - `scripts/compat-corpus.mjs` captures bounded `globalThis`/window visible-surface records for native and ZeroProxy runs.
   - Records include own-key/name/symbol counts, bounded visible-name samples, selected descriptors, constructor names, `Symbol.toStringTag`, and function source lengths.
   - The probe avoids arbitrary getter invocation by default.
   - Remaining limitation: recursive safe graph traversal, full source-string fingerprints, prototype chains, and systematic delta classification are still pending.

6. Add a complete DOM manipulation hook inventory. **Done as a checked-in inventory.**
   - `test/fixtures/dom-mutation-inventory.json` inventories create/insert/replace/remove/clone/import/adopt/parse/serialize/attribute families.
   - Each row is classified as hooked, partial, irrelevant, or expected limitation with coverage notes.
   - `test/js/dom-mutation-inventory.test.js` pins hooked/partial rows to runtime source needles.
   - Remaining limitation: native-vs-ZeroProxy behavior fixtures for every API family are still pending under the dynamic DOM parity work.

7. Add target-visible selector virtualization. **Partially done for common URL attributes.**
   - `web/runtime-prelude.mjs` virtualizes `querySelector`, `querySelectorAll`, `matches`, and `closest` for target-visible `href`, `src`, `srcset`, `action`, `formaction`, and `poster` selectors.
   - Existing filtering for `data-zp-*`, `/zp/assets/`, `/zp/api/`, and other ZeroProxy internals is preserved.
   - `test/js/membrane-invariants.test.js` pins the hook wiring.
   - Remaining limitation: `srcdoc`, `xlink:href`, complex CSS escape parity, and native-vs-ZeroProxy selector fixtures are still pending.

8. Add redacted failure telemetry. **Partially done in corpus reports.**
   - `scripts/compat-corpus.mjs` emits `zp.failure.telemetry.v1` records with first failing surface, owner module, severity, redacted deltas, selector evidence, iframe deltas, and timing buckets.
   - Raw source, bodies, cookies, tokens, challenge data, IPs, console text, and sensitive URLs are excluded from telemetry records.
   - `test/js/compat-corpus.test.js` pins schema/redaction/evidence behavior.
   - Remaining limitation: rewrite kind, parser error kind, source size bucket, failed helper/API surface, content-type, and charset are not yet emitted across every rewrite/runtime/SW path.

9. Add safe parse-failure recovery. **Partially done for safe classic-script variants.**
   - `web/http-rewriter.js` retries BOM stripping and classic HTML-comment normalization on `PARSE_FAILED`.
   - `rewriteScriptOutcome` reports attempted/used recovery variants without logging source.
   - Final fallback remains blocked.
   - Remaining limitation: charset reinterpretation, classic/module misclassification, event-handler wrapper variants, dynamic function-body wrapper variants, and syntax-proposal matrix are still pending.

10. Prioritize dynamic DOM insertion parity. **Done as a checked-in matrix.**
   - `test/fixtures/dynamic-dom-insertion-matrix.json` covers `innerHTML`, `document.write`, script insertion, templates, contextual fragments, DOMParser, hydration/dynamic chunks, and dynamic `srcdoc`.
   - Rows include priority, probes, runtime hook needles, and expected deltas.
   - `test/js/dynamic-dom-insertion-matrix.test.js` pins the matrix.
   - Remaining limitation: native-vs-ZeroProxy behavior fixtures for every row are still pending.
11. Add cookie/storage/SameSite diagnostics. **Done as a checked-in matrix.**
   - `test/fixtures/cookie-storage-samesite-matrix.json` covers redirect-chain cookies, iframe cookie visibility, SameSite variants, `document.cookie` vs network cookies, storage sharing across reload/popup/frame, and redacted diagnostics.
   - `test/js/cookie-storage-samesite-matrix.test.js` pins matrix coverage and source wiring.
   - Remaining limitation: per-row native-vs-ZeroProxy behavior fixtures are still pending.

12. Add the fetch/XHR compatibility matrix. **Done as a checked-in matrix.**
   - `test/fixtures/fetch-xhr-compat-matrix.json` covers mode, credentials, redirect, referrerPolicy, no-cors/opaque, abort, upload stream, replayable body, range/cache/content-encoding, and sync XHR policy.
   - `test/js/fetch-xhr-compat-matrix.test.js` pins matrix coverage and implementation wiring.
   - Remaining limitation: per-row native-vs-ZeroProxy behavior fixtures and API-failure telemetry classes are still pending.

13. Add framework compatibility fixtures. **Done as checked-in fixture entries.**
   - `test/fixtures/framework-compatibility/manifest.json` lists React hydration, Next/Vite-style module graph, Vue, Angular/Zone timer patching, Webpack dynamic chunks, and import-map/module-graph coverage.
   - HTML/JS fixture files are checked in under `test/fixtures/framework-compatibility/`.
   - `test/js/framework-compatibility-fixtures.test.js` pins fixture coverage and entry files.
   - Remaining limitation: representative native-vs-ZeroProxy behavior runs for these fixtures are still pending.

14. Add the event-listener compatibility matrix. **Done as a checked-in matrix.**
   - `test/fixtures/event-listener-compat-matrix.json` covers `addEventListener`, `removeEventListener`, `dispatchEvent`, listener identity, duplicate registration, `handleEvent`, options, propagation, inline handlers, `on*` properties, message wrapping, and internal-listener invisibility.
   - `test/js/event-listener-compat-matrix.test.js` pins matrix coverage and source wiring.
   - Remaining limitation: native-vs-ZeroProxy behavior fixtures and removal/invisibility attempts for every row are still pending.

15. Add observer and input-event parity matrices. **Done as checked-in matrices.**
   - `test/fixtures/observer-input-event-parity-matrix.json` covers `MutationObserver`, `IntersectionObserver`, `ResizeObserver`, pointer, mouse, touch, wheel, keyboard, focus, composition, `beforeinput`, and `input` surfaces.
   - `test/js/observer-input-event-parity-matrix.test.js` pins matrix coverage.
   - Remaining limitation: native-vs-ZeroProxy callback/event-order behavior fixtures are still pending.
   - Keep observer/input telemetry redacted and avoid logging typed text, clipboard data, selected text, raw pointer paths, or sensitive form values.

16. Split frame, `srcdoc`, and sandbox into a dedicated milestone. **Done as a checked-in milestone matrix.**
   - `test/fixtures/frame-srcdoc-sandbox-milestone.json` tracks ordinary frame routing, dynamic/static `srcdoc`, sandbox-token deltas, and ad/login/widget/payment/challenge iframe patterns.
   - `test/js/frame-srcdoc-sandbox-milestone.test.js` pins row coverage, expected deltas, and source wiring.
   - Remaining limitation: `srcdoc` upgrade and native-vs-ZeroProxy iframe behavior fixtures are still pending.

17. Finish end-to-end streaming HTML transformation. **Closed by explicitly documenting the non-streaming limitation.**
   - `internal/htmltx.Transform` still uses `io.ReadAll`, so first-byte/partial-flush streaming is not claimed.
   - `test/js/static-policy.test.js` pins that the non-streaming adapter path and document limitation stay explicit until a real streaming Rust/lol_html bridge lands.
   - Remaining limitation: true streaming bridge, first-byte tests, and partial-flush tests are still pending implementation.

18. Upgrade `srcdoc` handling. **Partially done for static Rust document policy.**
   - `rewriter-rs/src/html/document.rs` now rewrites static `iframe/frame srcdoc` through the same Rust `rewrite_document` policy instead of only prefixing runtime prelude bytes.
   - Rust tests now verify that scripts inside static `srcdoc` are routed through `/zp/api/script` with tab/runtime context and runtime prelude injection.
   - Remaining limitation: runtime-set `srcdoc`, parent/context modeling, and native-vs-ZeroProxy iframe behavior fixtures remain pending.

19. Expand expected-delta coverage. **Done for the currently named long-tail deltas.**
   - `test/e2e/expected-deltas.json` now classifies frame sandbox containment, `srcdoc` runtime/static gaps, data/blob worker and frame limits, and target-visible wrapper artifacts.
   - `test/js/expected-deltas.test.js` pins the new allowlist IDs and bounded/redacted reasons.
   - Remaining limitation: new deltas found by future representative-site runs still need to be added with evidence.

20. Close rewrite-surface long tail. **Done as a checked-in classified matrix.**
   - `test/fixtures/rewrite-surface-long-tail.json` classifies document/domain, base URL, service worker, worklet, CSP/reporting, WebTransport/WebRTC, and storage/cache/IndexedDB long-tail surfaces.
   - `test/js/rewrite-surface-long-tail.test.js` pins classifications and ties rows back to source/docs.
   - Remaining limitation: rows marked expected-limitation/expected-delta still need behavior fixtures before release readiness.

21. Complete performance gates. **Done as a checked-in gate manifest for current measurable surfaces.**
   - `test/fixtures/performance-gates.json` records HTML transform, runtime bootstrap, Rust rewriter init, script rewrite, dynamic function body, and representative-site load timing gate status.
   - `test/js/performance-gates.test.js` pins the gate manifest to existing budget tests and real corpus transport timing.
   - Remaining limitation: HTML first-byte is explicitly `null` while the Go adapter remains non-streaming; representative-site gates are runner-only until external corpus runs are committed.

22. Clarify delivery versioning and minification. **Done as a checked-in manifest.**
   - `test/fixtures/delivery-versioning-minification.json` documents package version source, fixed runtime asset names, classic-IIFE delivery, fixed-name/no-hash asset policy, opt-in `--minify`, and the current Rust rewriter version string.
   - `test/js/delivery-versioning-minification.test.js` pins the manifest to `scripts/build.mjs` and `package.json`.
   - Remaining limitation: ABI-safe default minification is still not enabled by default.
23. Run the full verification gate after status-changing work. **Re-verified 2026-06-07.**
   - `npm run test:js` passed: 130 tests.
   - `npm run test:e2e` passed: 1 browser integration test.
   - `go test ./...` passed.
   - `npm run test:wasm` passed for `cmd/wasm-kernel` and `internal/swhttp`.
   - `cargo test --manifest-path rewriter-rs/Cargo.toml` passed: 46 tests.
   - `npm run lint` passed (`lint:go`, `lint:rust`, `lint:js`); Biome emitted warning-level findings only.
