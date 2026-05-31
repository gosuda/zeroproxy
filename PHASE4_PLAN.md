# ZeroProxy Phase 4 Plan: Browser API Fidelity, Cookie Parity, Dynamic Rewrite Compatibility, and Stealth Cleanup

Status: proposed.

Phase 4 upgrades ZeroProxy from Phase 3's strict containment baseline toward practical web compatibility. The goal is not to widen the target Service Worker or plugin surface. The goal is to make the runtime APIs that common sites actually use behave much closer to a native browser while preserving the ZeroProxy transport boundary:

```text
target page API -> ZeroProxy runtime/SW -> Go WASM kernel -> relay WebSocket/yamux -> SOCKS5 -> uTLS/HTTP
```

Phase 4 keeps the current Service Worker memory-state model unchanged. Cold route restore, encrypted persistent tab state, and durable `shareRoutes` are explicitly deferred. Target Service Worker compatibility is also out of scope for this phase.

## Goals

- Refine the main-window `fetch` shim so it preserves browser-visible request and response semantics more accurately.
- Add a dedicated synchronous XHR path for `XMLHttpRequest.open(..., false)` using native same-origin sync XHR to `/zp/api/fetch`, not native target networking.
- Improve XHR download progress, upload progress, timeout, abort, error, and event-order fidelity.
- Re-enable dynamic compilation compatibility for pages whose original target policy permits `eval` / `new Function`, while preserving original target CSP blocking when the target policy forbids dynamic compilation.
- Make `eval`, `Function`, async/generator function constructors, and string timers execute rewritten code under the virtual global membrane instead of the current simple-expression-only compatibility path.
- Align ZeroProxy cookie behavior with browser cookie behavior as closely as possible: domain, path, expiry, Max-Age, Secure, HttpOnly, SameSite, credential mode, redirect, deletion, ordering, and `document.cookie` projection.
- Make generated `Origin` and `Referer` headers match native browser behavior for the actual request context instead of always forcing target origin and full target URL.
- Keep the fixed user-agent behavior. The Phase 4 UA remains intentionally pinned.
- Keep `object` and `embed` blocking. That is an intentional compatibility tradeoff, not a Phase 4 defect.
- Improve bootstrap and control-artifact trace removal beyond Phase 3's basic stealth membrane.
- Add browser differential tests against native Chrome behavior for the Phase 4 surfaces.

## Non-goals

- Do not redesign Service Worker memory state, tab recovery, `shareRoutes`, or cold restore.
- Do not support target Service Worker registration or target-controlled Service Worker lifecycle APIs.
- Do not unblock `object`, `embed`, WebRTC, WebTransport, or unrestricted device APIs.
- Do not remove the fixed UA profile.
- Do not claim full anti-bot or fingerprint indistinguishability. Phase 4 targets compatibility and obvious ZeroProxy artifact cleanup, not complete browser fingerprint cloning.
- Do not allow native target networking outside the ZeroProxy transport path, even for compatibility.

## Hard Feasibility Gates

### Sync XHR

Main-window synchronous XHR cannot be implemented by awaiting the existing async `fetchThroughRuntime()` path on the page thread. Phase 4 must implement sync XHR by delegating to the browser's native synchronous XHR against the same-origin runtime API:

```text
target XHR sync call
  -> runtime XHR shim
  -> native XMLHttpRequest("POST or method", "/zp/api/fetch?url=<target>", false)
  -> Service Worker runtime API
  -> Go WASM kernel
  -> target response
```

This preserves the transport boundary because the native sync XHR only talks to the proxy origin. It must never open the target URL directly.

Acceptance gate:

- If a browser does not dispatch same-origin sync XHR through the active Service Worker correctly, Phase 4 must detect it and return the closest spec-compatible failure rather than silently using native target networking.
- Sync XHR support is main-window only unless worker support can be proven separately.

### Dynamic Compile CSP Preservation

Phase 4 must not blindly relax dynamic compilation policy. It must derive a ZeroProxy execution CSP from the original target response policy:

```text
original target permits eval/new Function  -> ZeroProxy permits eval/new Function after rewrite
original target blocks eval/new Function   -> ZeroProxy blocks eval/new Function
```

When the original target policy allows dynamic compilation, ZeroProxy may add the internal CSP allowances it needs, such as `'unsafe-eval'` and `'wasm-unsafe-eval'`, but every dynamic compile path must still route through the foreground rewriter first. Raw target source must not be compiled directly as a fallback.

When the original target policy blocks dynamic compilation, ZeroProxy must preserve that block even if its own runtime could technically compile rewritten code. The runtime should fail with native-like CSP behavior for `eval`, `Function`, async/generator constructors, and string timers.

## Workstream 1: Fetch Shim Fidelity

Current problem:

- `fetchThroughRuntime()` builds a new `Request`, forwards through `/zp/api/fetch`, and forces several runtime options such as `credentials: 'same-origin'`, `cache: 'no-store'`, and `redirect: 'follow'`.
- Many native request semantics are either lost or flattened.

Required behavior:

- Preserve and forward the visible `Request` fields:
  - `method`
  - `headers`
  - `body`
  - `signal`
  - `credentials`
  - `mode`
  - `cache`
  - `redirect`
  - `referrer`
  - `referrerPolicy`
  - `integrity`
  - `keepalive`
  - `priority` where available
  - `duplex` where required
- Implement browser-like URL and mode validation before transport:
  - reject unsupported protocols with a native-like `TypeError`;
  - preserve `no-cors` opaque-response behavior where feasible;
  - reject invalid method/body combinations;
  - preserve abort timing.
- Stop unconditionally forcing `redirect: 'follow'` at the runtime layer. The runtime and kernel must represent:
  - `follow`
  - `manual`
  - `error`
- Stop unconditionally forcing `cache: 'no-store'` as a fetch API semantic. The response constructor may still apply ZeroProxy's storage policy headers, but `Request.cache` should remain visible and should affect conditional/cache-like behavior only where ZeroProxy explicitly implements it.
- Treat `credentials` as the source of cookie inclusion:
  - `omit`: no Cookie header and no Set-Cookie reconciliation for this request's visible cookie store;
  - `same-origin`: include cookies only when the target request is same-origin relative to the virtual document origin;
  - `include`: include eligible cookies for the target URL.
- Preserve response shape:
  - `url`
  - `redirected`
  - `type`
  - status/statusText
  - header exposure rules
  - body stream cancellation
  - `clone()` behavior

Implementation notes:

- Add explicit ZeroProxy metadata headers for fetch options, for example `X-ZP-Fetch-Credentials`, `X-ZP-Fetch-Redirect`, `X-ZP-Fetch-Referrer`, and `X-ZP-Fetch-Referrer-Policy`.
- These headers are internal only and must be stripped before target egress.
- Move redirect policy decisions into the Go kernel so browser-visible redirect semantics are consistent for fetch and XHR.

Acceptance tests:

- `fetch(url, { credentials: 'omit' })` does not send cookies and does not update `document.cookie` from `Set-Cookie`.
- `credentials: 'same-origin'` sends cookies only for virtual same-origin requests.
- `credentials: 'include'` sends cross-origin target cookies when domain/path/SameSite rules allow.
- `redirect: 'error'` rejects on redirect.
- `redirect: 'manual'` exposes a browser-compatible filtered redirect response or the nearest documented ZeroProxy equivalent.
- `AbortController` aborts before headers, during body upload, and during body download with native-like error names.

## Workstream 2: XHR Sync, Progress, Upload, and Event Ordering

Current problem:

- Async XHR is implemented as a light wrapper over `fetchThroughRuntime()`.
- Sync XHR is explicitly unsupported.
- Upload/download progress and event ordering are prototype-level.

Required async XHR behavior:

- Implement ready-state transitions matching native XHR:
  - `UNSENT`
  - `OPENED`
  - `HEADERS_RECEIVED`
  - `LOADING`
  - `DONE`
- Stream response bodies for `responseType === ''` and `responseType === 'text'` so `responseText` grows during `LOADING`.
- Fire download `progress` events with `loaded`, `total`, and `lengthComputable` when Content-Length is available.
- Implement upload progress for:
  - `Blob`
  - `ArrayBuffer`
  - `TypedArray`
  - `DataView`
  - `URLSearchParams`
  - `FormData` where browser APIs expose chunking metadata sufficiently.
- Implement `loadstart`, `progress`, `abort`, `error`, `timeout`, `load`, and `loadend` on both `xhr` and `xhr.upload`.
- Enforce native restrictions around `responseType`, `timeout`, and sync mode.
- Preserve `withCredentials` by mapping it to fetch credential policy and cookie inclusion.

Required sync XHR behavior:

- For `open(method, url, false)`, use captured native `XMLHttpRequest` to perform a synchronous same-origin request to `/zp/api/fetch?url=<target>`.
- Set runtime capability headers on the same-origin sync request.
- Serialize supported request bodies without using async APIs.
- Return response headers, status, statusText, responseText, and responseXML where feasible.
- Match native sync XHR restrictions:
  - disallow `timeout` on main-window sync XHR;
  - disallow non-empty `responseType` except text-compatible values;
  - throw native-like `InvalidAccessError` / `InvalidStateError` where appropriate.

Important limitation:

- Sync XHR upload streaming is not realistic because the API is blocking. Phase 4 should support fixed in-memory body types for sync XHR and document that streaming uploads remain async-only.

Acceptance tests:

- A page using `xhr.open('GET', '/api', false); xhr.send();` receives a target response through ZeroProxy.
- Sync XHR request appears at the target server with target URL, fixed UA, native-like Origin/Referer, and correct cookies.
- Sync XHR does not use native target networking when the Service Worker is unavailable.
- Async XHR fires event order matching native Chrome for success, 404, redirect, abort, timeout, and network failure.
- Async XHR upload progress fires for large Blob and FormData bodies.
- `responseText` is observable during `LOADING`.

## Workstream 3: Dynamic Foreground Rewriter and CSP Preservation

Current problem:

- Phase 3 strict CSP removed foreground dynamic rewrite dependency.
- Current dynamic `eval` / `Function` support is intentionally narrow and rejects most real dynamic source.
- Many production sites still use controlled dynamic compilation paths through libraries, template engines, analytics, tag managers, and legacy bundles.
- Some production sites intentionally block dynamic compilation through target CSP. ZeroProxy must preserve that block.

Required behavior:

- Reintroduce the Rust rewriter in the foreground target realm, loaded before target code can call dynamic compile APIs.
- Keep the foreground rewriter hidden from target DOM observability APIs.
- Parse the original target CSP and compute a target dynamic-compile permission bit before header construction.
- If the original target CSP allows dynamic compilation, update the ZeroProxy document CSP to include the internal allowances required for rewritten dynamic compile:
  - `'unsafe-eval'`
  - `'wasm-unsafe-eval'`
- If the original target CSP blocks dynamic compilation, keep dynamic compile blocked in the runtime even if the constructed ZeroProxy CSP needs separate internal allowances for ZeroProxy-owned assets.
- Rewrite before compile for all dynamic paths:
  - `eval(source)`
  - indirect eval
  - `new Function(...)`
  - `Function(...)`
  - `AsyncFunction`
  - `GeneratorFunction`
  - `AsyncGeneratorFunction`
  - string `setTimeout`
  - string `setInterval`
- Compile rewritten source under the existing virtual global membrane.
- Never compile original target source if parsing or rewriting fails.
- If the target dynamic-compile permission bit is blocked, do not invoke the rewriter for dynamic source; fail as a native CSP block would.
- Preserve direct eval vs indirect eval behavior as closely as possible:
  - direct eval should see local lexical scope only where safely representable;
  - otherwise fall back to global-scope semantics or fail closed with documented behavior.

Implementation notes:

- Add a foreground rewriter bootstrap that initializes before target inline and external scripts.
- Inject the target dynamic-compile permission into boot config as an internal, hidden value.
- Avoid visible `script[src*="zp"]`, `window.ZPRewriter`, or stable boot IDs where possible.
- If a global API must exist internally, keep it non-enumerable and hide it through `ownKeys`, descriptors, selectors, script collections, and serialization.
- Replace current `unsupportedDynamicCompile()` path with either `target-CSP-block` or `rewrite -> compile -> run`, depending on the original target CSP.

Acceptance tests:

- `Function('return location.href')()` returns the virtual target URL.
- `Function('location.href="/next"; return location.href')()` navigates through ZeroProxy and returns virtual state.
- `eval('fetch("/api").then(...)')` routes through ZeroProxy after rewrite.
- A fixture whose original target CSP omits dynamic compile permission blocks `eval` and `new Function`.
- A fixture whose original target CSP permits dynamic compile keeps `eval` and `new Function` working through the rewriter.
- Constructor-constructor paths still return wrapped dynamic constructors, not raw native escape hatches.
- Rewrite failure throws and does not execute source.
- CSP violation behavior matches the original target policy: no violation for target-allowed dynamic compile paths, native-like block for target-blocked paths.

## Workstream 4: Browser-Compatible Cookie Engine

Current problem:

- The Go cookie jar and runtime `document.cookie` ledger are close but not browser-complete.
- Cookie inclusion currently does not fully depend on Fetch/XHR credentials, SameSite request context, redirect context, top-level navigation context, and method safety.

Required behavior:

- Define one canonical cookie algorithm shared between Go and JS:
  - domain matching
  - public suffix rejection or documented equivalent
  - host-only cookies
  - path defaulting
  - path matching
  - Max-Age precedence over Expires
  - deletion
  - Secure
  - HttpOnly projection
  - SameSite Strict/Lax/None/default-Lax
  - creation time and path-length ordering
  - duplicate name/domain/path replacement
- Apply fetch credential mode before cookie inclusion.
- Apply SameSite based on virtual top-level site, target request URL, request method, and navigation/fetch context.
- Reconcile `Set-Cookie` after:
  - document load
  - fetch
  - XHR
  - redirect hops where native browsers would store cookies
  - form submissions
- `document.cookie` must expose only non-HttpOnly cookies valid for the current virtual URL.
- JS-side `document.cookie = ...` must use the same parser and matching rules as the Go jar.
- Downstream sync from Go jar to runtime must carry structured records, not only a joined cookie string.

Implementation notes:

- Add a cookie policy package that accepts a request context:

```text
request URL
virtual top-level URL
initiator type: document | fetch | xhr | form | websocket
method
credentials mode
redirect depth
is top-level navigation
current time
```

- Port the same logic to JS or generate test vectors that both implementations must pass.
- Use web-platform-test style cookie fixtures where possible.

Acceptance tests:

- Host-only and domain cookies match native Chrome behavior.
- Path ordering and duplicate cookie names match native request header ordering.
- `Max-Age=0`, negative Max-Age, and expired Expires delete correctly.
- HttpOnly cookies are sent on requests but hidden from `document.cookie`.
- Secure cookies are hidden/suppressed on `http:` virtual origins.
- SameSite Lax/Strict/None behavior matches native Chrome for same-site fetch, cross-site fetch, top-level GET navigation, and POST.
- `credentials: omit/same-origin/include` matches native cookie inclusion.
- XHR `withCredentials` maps correctly.

## Workstream 5: Native-Like Origin and Referer

Current problem:

- The kernel currently strips page-provided `Origin` and `Referer`, then sets:

```text
Origin: <target origin> for non-GET/non-HEAD
Referer: <full target URL>
```

- This is intentionally safe but not native-compatible.

Required behavior:

- Implement a referrer policy engine:
  - `no-referrer`
  - `no-referrer-when-downgrade`
  - `origin`
  - `origin-when-cross-origin`
  - `same-origin`
  - `strict-origin`
  - `strict-origin-when-cross-origin`
  - `unsafe-url`
- Use the virtual document URL as the browser-visible referrer source.
- Respect fetch `referrer` and `referrerPolicy` options.
- Respect document-level `<meta name="referrer">` and response `Referrer-Policy` where ZeroProxy policy permits.
- Generate `Origin` only when native browsers would:
  - CORS/fetch context requiring Origin;
  - non-simple/cross-origin cases;
  - POST/form submissions;
  - WebSocket handshake Origin;
  - avoid Origin for same-origin GET navigations where native Chrome omits it.
- Preserve fixed UA independently from Origin/Referer changes.

Acceptance tests:

- Same-origin virtual GET subresource sends native-like Referer and no unnecessary Origin.
- Cross-origin virtual fetch sends Origin based on mode and method.
- `referrerPolicy: 'no-referrer'` suppresses Referer.
- Downgrade `https:` virtual source to `http:` target follows strict-origin-when-cross-origin defaults.
- WebSocket handshake Origin matches native target-origin expectations.

## Workstream 6: Bootstrap and Artifact Trace Removal

Current problem:

- Phase 3 hides many `data-zp-*` attributes and control assets, but bootstrapping still leaves detectable surfaces.
- The runtime self-removal check currently targets legacy asset paths and must be corrected for `/zp/assets/...`.

Required behavior:

- Remove or hide bootstrap script nodes after execution:
  - boot data script
  - runtime script
  - rewriter script
  - rewriter WASM bootstrap artifacts
- Avoid stable DOM IDs such as `__zp-boot` in steady state.
- Move boot config into an immediately consumed closure or non-enumerable symbol-backed storage.
- Delete public boot globals after initialization.
- Hide internal symbols and globals from:
  - `Object.keys`
  - `Reflect.ownKeys`
  - `Object.getOwnPropertyNames`
  - `Object.getOwnPropertyDescriptors`
  - `for...in`
  - selectors
  - `document.scripts`
  - `getElementsByTagName`
  - `NodeIterator`
  - `TreeWalker`
  - serialized `innerHTML` / `outerHTML`
  - PerformanceResourceTiming entries where feasible
- Keep internal access through captured native references and WeakMap/private state.

Acceptance tests:

- `document.querySelectorAll('script[src*="zp"],script[src*="zeroproxy"]').length === 0` after startup.
- `document.getElementById('__zp-boot') === null`.
- `document.documentElement.outerHTML` does not expose `data-zp-*`, `/zp/assets/runtime-prelude.js`, `/zp/assets/rust-rewriter.js`, or boot JSON.
- `Reflect.ownKeys(window)` does not expose obvious ZeroProxy runtime internals except intentionally public compatibility APIs.
- Performance resource APIs do not expose ZeroProxy asset URLs to target scripts, or they expose documented masked target names.

## Workstream 7: Verification Matrix

Phase 4 must add differential browser tests. Each test should run the same fixture in native Chrome and through ZeroProxy, then compare the expected browser-visible results.

Required test groups:

- Fetch:
  - credentials
  - redirect modes
  - referrer policies
  - abort
  - streaming request/response
  - response type/url/redirected
- XHR:
  - sync GET/POST
  - async text streaming
  - upload progress
  - download progress
  - timeout
  - abort
  - responseType restrictions
- Dynamic compile:
  - eval
  - indirect eval
  - Function
  - async/generator constructors
  - string timers
  - rewrite failure
- Cookies:
  - domain/path/expiry/deletion
  - SameSite
  - Secure/HttpOnly
  - credentials mode
  - redirect Set-Cookie
- Origin/Referer:
  - same-origin virtual request
  - cross-origin virtual request
  - downgrade
  - form POST
  - WebSocket
- Bootstrap stealth:
  - DOM selectors
  - serialized HTML
  - script collections
  - traversal APIs
  - performance entries

## Milestones

### P4.1: Fetch and Header Context

- Add internal fetch option metadata.
- Implement referrer policy and native-like Origin generation.
- Update Go request builder to stop unconditional Origin/Referer forcing.
- Add fetch credential and redirect tests.

Exit criteria:

- Fetch differential tests pass for credential, redirect, abort, Origin, and Referer fixtures.

### P4.2: XHR Parity

- Replace current XHR shim internals with a state-machine implementation.
- Add native same-origin sync XHR bridge to `/zp/api/fetch`.
- Add async download/upload progress.
- Add event-order tests.

Exit criteria:

- Sync XHR works through ZeroProxy in Chrome.
- Async XHR event order and progress match native fixtures within documented tolerance.

### P4.3: Foreground Dynamic Rewrite

- Parse and preserve original target dynamic-compile CSP policy.
- Load and hide foreground Rust rewriter.
- Rewrite and compile dynamic code paths.
- Remove simple-expression-only dynamic compile limitation.

Exit criteria:

- Real dynamic compile fixtures execute rewritten code.
- Original target CSP blocks are preserved for `eval` and `new Function`.
- Rewrite failures fail closed.
- Dynamic compile CSP behavior matches the original target policy.

### P4.4: Cookie Browser Parity

- Create shared cookie behavior test vectors.
- Align Go jar and JS runtime ledger.
- Apply credentials and SameSite request context.
- Improve downstream structured cookie sync.

Exit criteria:

- Cookie fixtures match native Chrome behavior for all Phase 4 contexts.

### P4.5: Bootstrap Stealth Cleanup

- Remove stable boot IDs.
- Correct runtime self-removal for `/zp/assets/...`.
- Hide foreground rewriter artifacts.
- Expand DOM/performance stealth tests.

Exit criteria:

- Target scripts cannot observe Phase 4 boot artifacts through the enumerated APIs.

## Acceptance Boundary

Phase 4 is accepted when:

- No target request escapes the ZeroProxy transport path.
- Main-window fetch and XHR fixtures match native Chrome behavior for the enumerated compatibility matrix.
- Dynamic compile paths follow the original target CSP: allowed paths execute only after ZeroProxy rewrite, and originally blocked paths remain blocked.
- Cookie behavior matches native Chrome for the Phase 4 cookie matrix.
- Origin and Referer generation matches native Chrome fixtures.
- Target Service Worker registration remains blocked.
- `object` and `embed` remain blocked.
- Fixed UA remains unchanged and intentional.
- Service Worker memory-state persistence remains deferred and unchanged.
