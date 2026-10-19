# Trap Notebook Archive

This file preserves the technical detail entries referenced by `LOG.md#<id>` in [`INDEX.md`](INDEX.md). New trap entries belong in their respective category files (`rewriter.md`, `sw-integration.md`, `wasm-page-rt.md`, `tls-fingerprint.md`, `transport-regression.md`, `real-site-compat.md`, `build-deploy.md`).

## [2026-08-24-1] membrane / frame

**Returning a cross-window proxy as its own `parent` causes ancestor-walk loops (`while (w !== w.parent)`) to spin forever.**

- **Root Cause**: The `safeCrossWindow` proxy returned itself for both `top` and `parent`. Standard consent management platform (CMP) ancestor-walk loops (`while (!found) { if (w === window.top) break; w = w.parent; }`) spin infinitely inside depth-2+ grandchild frames because `window.top` and `window.parent` are distinct proxies while `parent.parent` remains stationary (`w === window.top` never becomes true).
- **Fix**: `climbCrossWindow` walks one step up the real frame hierarchy (`top` and `parent` are readable across origins, and keying the facade cache by the underlying raw window ensures traversal converges on the same facade instance as `window.top`).

## [2026-08-24-2] membrane / fingerprint

**Never test whether an object-returning getter is installed by comparing return value identity across repeated reads (`navigator.userAgentData`).**

- **Root Cause**: `defineOnProto` installed an accessor on the prototype and verified installation via `instance[key] === get.call(instance)`. Because `virtualUserAgentData` allocated a fresh object on every invocation, the identity comparison always evaluated to `false` and fell back to defining `userAgentData` as an own property on the `navigator` instance (`Object.getOwnPropertyNames(navigator)` exposed `['userAgentData']` instead of `[]`).
- **Fix**: Verify installation via `Object.getOwnPropertyDescriptor` without invoking the getter, and inherit from the real `NavigatorUAData.prototype` so the instance has zero own properties, matching native browser descriptors.

## [2026-08-24-4] membrane / performance

**Match native `HTMLCollection` and `NodeList` descriptors and memoize filtered snapshots to avoid $O(N^2)$ traversal overhead.**

- **Root Cause**: The filtered collection Proxy wrapping `querySelectorAll` (to hide internal proxy `<script>` tags) rescanned the entire underlying collection on every `length` and `nth(i)` read. Iterating `for (const el of list)` performed two full scans per element ($O(N^2)$ total), invoking `getAttribute` millions of times on pages with ratusan `<script>` tags.
- **Fix**: Snapshot and memoize the filtered list per collection instance (invalidating when the underlying `length` changes for live collections), and expose only properties present on the raw collection (`prop in raw`) while delegating iterator methods directly to `Array.prototype`.

## [2026-08-22-7] membrane / storage

**`sessionStorage` follows tab session lifetime, and internal diagnostic keys and `BroadcastChannel` names must respect virtual site boundaries.**

- **Root Cause**: Because all proxied targets share a single browser origin, storage and broadcast surfaces must be partitioned by virtual origin/site in the membrane. Storing diagnostic trace keys in `localStorage` or leaving `BroadcastChannel` names unprefixed leaks state across virtual origins within the same tab.
- **Fix**: Partition `localStorage`, `sessionStorage`, `IndexedDB`, `CacheStorage`, and `BroadcastChannel` names by the active virtual origin/site key, and keep internal diagnostic buffers out of page-visible storage enumeration.

## [2026-08-21-9] sw-integration / redirect

**Never pass raw `3xx` responses to the browser when a redirect chain exceeds the hop cap; the final `Location` escapes the proxy.**

- **Root Cause**: Document responses served through the WASM kernel and Service Worker bypass the Go server's `ConstructorPolicy` header stripper. Returning the raw `3xx` response when a redirect chain exceeded the hop limit exposed the upstream `Location` header to the browser, which then followed the redirect directly outside the proxy.
- **Fix**: Strip `Location` and return a synthetic `502` error response whenever the Service Worker redirect loop reaches the maximum hop count.

## [2026-08-21-10] wasm-page-rt / policy

**Project URL surfaces from a single shared specification while verifying static HTML and dynamic DOM execution coverage independently.**

- **Root Cause**: Maintaining separate handwritten URL-bearing attribute tables in Rust (`zp-htmltx`) and JavaScript (`web/membrane/`) caused drift on attributes such as `background`, SVG `feImage[href]`, and `image-set()`.
- **Fix**: Consolidate all URL-bearing element/attribute pairs in `crates/zp-shared/testdata/url_surfaces.json`, inject the table into the build via `__ZP_URL_SURFACES__`, and enforce parity across static HTML transformation and dynamic DOM setter hooks in tests.

## [2026-08-20-2] sw-integration / navigation

**HTTP `Refresh` response headers and `<meta http-equiv="refresh">` are both navigation boundaries; never assume CSP blocks them.**

- **Root Cause**: Chrome honors the non-standard `Refresh: 0; url=...` HTTP response header as a client navigation trigger. Because response headers bypass `zp-htmltx` HTML rewriting and are not blocked by Content Security Policy, an unstripped `Refresh` header navigated the tab directly to the target origin.
- **Fix**: Strip `Refresh` headers in the Service Worker response filter (or rewrite their target URLs through the proxy navigation route) alongside `<meta http-equiv="refresh">` rewriting in `zp-htmltx` and the DOM membrane.

## [2026-08-20-7] wasm-page-rt / instrumentation

**Distinguish `csp-only` blocks from direct egress; always verify verdict columns, observer arming, and `csp_bypassed: false`.**

- **Root Cause**: Chrome DevTools Protocol (CDP) network logs emit `Network.requestWillBeSent` even for requests subsequently blocked by Content Security Policy (`Network.loadingFailed` with `blockedReason: "csp"`). Counting raw `requestWillBeSent` events without correlating completion/failure misclassified `csp-only` blocks and delayed membrane rewrites as direct network leaks.
- **Fix**: Correlate CDP request events with their terminal response or failure reason, and distinguish prevented direct egress from `csp-only` fallback blocks in the hole-matrix classifier.

## [2026-08-19-1] tls-fingerprint

**Verify per-connection TLS extension shuffling (including ECH GREASE) on the wire rather than relying on a static extension order.**

- **Root Cause**: Holding ECH GREASE (`0xfe0d`) at a fixed tail position while shuffling other TLS extensions created a static wire signature distinct from modern Chrome, which shuffles `0xfe0d` alongside other non-PSK extensions.
- **Fix**: Include ECH GREASE (`0xfe0d`) in the per-connection shuffle permuter while keeping only `pre_shared_key` (`0x0029`) pinned to the final extension slot as required by RFC 8446 Section 4.2.11.

## [2026-08-18-5] wasm-page-rt / security

**Rejected unlocking `configurable: false` on security descriptors to evade fingerprinting; never weaken containment for site compatibility.**

- **Root Cause**: Locking hooked DOM/Window descriptors with `configurable: false` prevents target scripts from deleting or replacing membrane hooks (`Object.defineProperty`), whereas native browser prototype properties are `configurable: true`.
- **Decision**: Retain `configurable: false` on containment-critical descriptors and virtualize `Object.getOwnPropertyDescriptor` reporting where needed instead of relaxing descriptor immutability.

## [2026-08-18-6] tls-fingerprint

**Advertised TLS extensions such as ALPS (`0x4469`) must implement their full handshake semantics; advertising code points alone breaks connections.**

- **Root Cause**: Advertising Application-Layer Protocol Settings (ALPS, `0x4469` / `17613`) in ClientHello without emitting the client's `EncryptedExtensions` message in the second handshake flight caused servers that negotiated ALPS to terminate the connection with `unexpected_message`.
- **Fix**: Implement full ALPS client handshake framing in the `rustls` fork so negotiating servers receive the expected `EncryptedExtensions` payload before `Finished`.

## [2026-08-18-15] membrane / eval

**Preserve global declarations and completion values in indirect `eval`; this fix alone does not mean all Cloudflare challenges pass.**

- **Root Cause**: Wrapping rewritten `eval` code in an IIFE or `new Function` made top-level `var` and `function` declarations local to the wrapper function and altered the script completion value expected by obfuscated VM dispatchers.
- **Fix**: Hoist top-level `var` and `function` declarations to `window` properties and preserve the expression completion value across indirect `eval` execution.

## [2026-08-18-18] real-site-compat / cloudflare

**Passing with a warm `cf_clearance` cookie is not cold challenge verification; separate historical scope fixes from active anti-bot compatibility.**

- **Root Cause**: Reusing a browser profile or cookie jar that already holds a valid `cf_clearance` token bypasses the interactive/managed challenge VM path entirely.
- **Rule**: Always verify anti-bot and challenge compatibility from a cold state (fresh cookie jar and isolated circuit) and confirm that the challenge VM script actually executed.

## [2026-08-16-7] sw-integration

**HTML bodies on `4xx`/`5xx` error responses must still undergo containment and rewriting; never pass error HTML through raw.**

- **Root Cause**: Skipping `transformDocumentResponse` when `resp.status >= 300` meant `403`/`404`/`500` HTML pages (including Cloudflare `403` challenge interstitials) were rendered by the browser without the injected CSP meta tag, runtime prelude, or HTML/JS rewrites.
- **Fix**: Transform all HTML document responses regardless of HTTP status code, skipping only bodyless statuses (`101`, `204`, `205`, `304`) and `3xx` redirects.

## [2026-08-16-8] wasm-page-rt / realm

**Moving `observedDocuments` to avoid a temporal dead zone exposed double instrumentation; make realm installation idempotent first.**

- **Root Cause**: `installBaseObserver` was called both during early network containment setup and during later DOM observer installation. A temporal dead zone (`ReferenceError`) on `observedDocuments` had been silently caught by `try/catch`, accidentally preventing the first call from running.
- **Fix**: Declare `observedDocuments` before any caller runs and guard all realm/document observer installations with `WeakSet` membership checks so repeated calls are idempotent.

## [2026-08-16-12] wasm-page-rt / sw-less

**Emitting Service-Worker-only API URLs inside uncontrolled documents causes server `403` errors; separate transport and execution boundaries.**

- **Root Cause**: Child frames created via `document.write` or `about:blank` before Service Worker control is established cannot intercept `/zp/api/fetch` requests in the Service Worker; those requests fall through to the Go server and fail with `403`.
- **Fix**: Detect uncontrolled (`SW-less`) documents at rewrite/hook time and route their subresource fetches through the `/zp/api/sync-fetch` relay or attach Service Worker control via blob/frame bootstrap.

## [2026-08-15-9] wasm-page-rt / realm

**Do not rely solely on `WeakSet` wrapper identity to check whether locked prototypes are hooked; inspect property descriptors as well.**

- **Root Cause**: Because the membrane may encounter distinct wrapper references for the same underlying prototype chain, a `WeakSet` guard alone can miss that a non-configurable property (`configurable: false`) was already installed, causing `Object.defineProperty` or `delete` to throw `TypeError`.
- **Fix**: Check `Object.getOwnPropertyDescriptor(target, prop)` before defining or deleting locked properties so re-instrumentation of an already-locked prototype is a safe no-op.

## [2026-08-14-1] wasm-page-rt / dom

**Observe the `Document` node itself so `document.write` replacement documents stay observed instead of clinging to a detached `documentElement`.**

- **Root Cause**: Attaching a `MutationObserver` to `doc.documentElement` on an initial `about:blank` frame loses visibility as soon as `document.write()` replaces the root `<html>` element with a new DOM tree.
- **Fix**: Attach the `MutationObserver` to `doc` (`observer.observe(doc, { childList: true, subtree: true })`) so mutations across `document.open()` / `document.write()` root replacements remain observed.

## [2026-08-13-10] transport / cookie

**Missing `Cookie` header forwarding and an origin-only cookie jar are distinct login defects; verify both domain scoping and wire headers.**

- **Root Cause**: The WASM kernel's header sanitizer stripped `cookie` alongside framing headers (`host`, `origin`, `referer`), but only promoted `X-ZP-Origin` and `X-ZP-Referer` back onto the upstream request—dropping `X-ZP-Cookie` entirely. In addition, keying the Service Worker cookie jar by full origin instead of eTLD+1 / `Domain` attribute prevented cross-subdomain login cookies (such as `nid.naver.com` to `.naver.com`) from being sent.
- **Fix**: Promote `X-ZP-Cookie` to `Cookie` in the WASM kernel and implement RFC 6265 domain/path matching in the Service Worker cookie jar.

## [2026-08-13-13] build-deploy

**Clearing site data alone does not guarantee an outdated Service Worker was replaced; verify the active bundle version at runtime.**

- **Root Cause**: An existing Service Worker registration can remain active across reloads if `clear-site-data` or cache clearing runs while a client tab still holds the registration open.
- **Rule**: Verify the active Service Worker build hash (`?v=<buildId>` or diagnostic version header) at runtime before attributing behavior to newly built code.

## [2026-08-10-3] verification

**A wedge disappearing when a stub ran in place of the real script is not proof of a fix; verify that the trigger script actually executed.**

- **Root Cause**: Restoring default tracker blocking caused a 40-byte stub (`/* ZP_TRACKER_BLOCKED */`) to be served instead of the 200 KB script under investigation, making the renderer freeze disappear only because the script never ran.
- **Rule**: Confirm that the target script body was delivered and executed (via size, side effects, or execution counters) before concluding a hang or crash is resolved.

## [2026-08-03-7] verification

**Source-text substring pins do not verify runtime semantics; delete tests that pass by matching comments in dead code.**

- **Root Cause**: A regex test in `static-policy.test.js` matched a deleted code pattern inside the comment explaining why the code was removed, producing a false pass.
- **Rule**: Test runtime behavior by executing the target function against inputs rather than grepping source files for code substrings.

## [2026-07-30-10] transport-regression

**Passing a non-null body to `new Response()` for `HEAD`, `204`, or `304` statuses throws a `TypeError` at construction time.**

- **Root Cause**: The Fetch specification forbids attaching a response body to null-body statuses (`101`, `103`, `204`, `205`, `304`). Passing an empty `Uint8Array(0)` instead of `null` to `new Response(body, init)` in the Service Worker caused `TypeError: Response with null body status cannot have body`, turning `204` analytics beacons and `304` conditional revalidations into `502` failures.
- **Fix**: Pass `null` as the `Response` body whenever `req.method === 'HEAD'` or `[101, 103, 204, 205, 304].includes(status)`.

## [2026-07-30-12] membrane / script

**Never turn top-level global declarations in classic scripts into function-local declarations inside a `Function` wrapper.**

- **Root Cause**: Executing rewritten classic `<script>` tags via `new Function(code)()` trapped top-level `var` and `function` declarations inside the function's local scope, causing `ReferenceError` when subsequent `<script>` tags referenced those globals.
- **Fix**: Execute classic scripts through indirect `eval` with top-level `var` and `function` declarations hoisted to `window`.

## [2026-07-28-2] transport-regression

**Retracted the claim that delayed `END_STREAM` was upstream anti-bot behavior; the actual cause was a yamux lost wakeup.**

- **Root Cause**: A 60-second stall before document stream completion was previously misattributed to upstream server behavior. Direct HTTP/2 comparison showed the upstream server finished in 178 ms; the 60-second delay inside the proxy was caused by a lost waker registration in the WASM yamux stream driver that only woke up when an upstream HTTP/2 keepalive `PING` frame arrived 60 seconds later.
- **Fix**: Register the stream waker before returning `Poll::Pending` in the yamux poll loop and always compare against a direct non-proxied baseline before attributing delays to upstream servers.

## [2026-06-19-1] transport-wasm

**Calling native `Instant::now()` during HTTP/2 reset cleanup trapped in WASM; test cancellation and error paths inside the target WASM runtime.**

- **Root Cause**: On `wasm32-unknown-unknown`, `std::time::Instant::now()` panics with `time not implemented on this platform`. When a streaming HTTP/2 document was cancelled mid-stream, the `h2` crate's reset-stream accounting called `Instant::now()`, triggering `RuntimeError: unreachable`.
- **Fix**: Replace `std::time::Instant` usage in the `h2` fork with a WASM-safe monotonic clock or skip time-based reset-stream expiration on `wasm32`.

## [2026-06-16-2] wasm-crash

**A future-cancellation race in the Service Worker `setTimeout`-backed kernel timer caused WASM traps; do not add unconditional timers.**

- **Root Cause**: Racing an `h2` `body_stream.data()` future against a JS `setTimeout` future via `futures::select` dropped the `h2` future on timeout while a pending JS callback could still wake and re-poll the task in an inconsistent state, causing `RuntimeError: unreachable` in `wasm-bindgen-futures`.
- **Rule**: Do not wrap internal `h2` stream futures in `setTimeout`-backed cancellation races inside the WASM kernel.

## [2026-06-02-2] tls-fingerprint

**Installing a captured ClientHello spec is distinct from applying cipher and header order on the wire; do not pin a stale Chrome version forever.**

- **Root Cause**: Although a captured Chrome `ClientHello` specification was loaded into the TLS config, `rustls` still iterated `config.provider.cipher_suites` in default provider order rather than the captured spec's `cipher_suites` order, and outbound HTTP headers were re-sorted alphabetically by `Headers` iteration.
- **Fix**: Emit cipher suites and HTTP headers in the exact order specified by the active browser profile and verify the wire output against a TLS/HTTP2 echo observer.

## [2026-05-30-22] wasm-page-rt / memory

**Re-acquire typed-array views after `memory.grow` and copy scratch-buffer outputs before another WASM call overwrites them.**

- **Root Cause**: Whenever WASM linear memory grows (`memory.grow`), all existing JS `Uint8Array` views backed by `memory.buffer` are detached. Writing to or reading from a cached view after growth silently fails or reads stale data.
- **Fix**: Check `exports.memory.buffer !== cachedBuffer` on every access in `memU8()` and allocate a fresh `Uint8Array` view whenever the underlying `ArrayBuffer` identity changes.

## [2026-05-30-16] wasm-page-rt / perf

**Do not generalize Node microbenchmarks to browser performance; raw string round-trips across WASM can be slower than JS.**

- **Root Cause**: Encoding short strings via `TextEncoder.encodeInto` and copying them across the JS/WASM boundary costs more than V8's JIT-compiled regular expressions for single-string operations.
- **Rule**: Keep single-string fast checks in JS and reserve WASM crossings for handle-based pipelines (`zp-htmltx`) or batched operations.
