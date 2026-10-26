# Phase 2 Strict-Mode Acceptance Status

This document records the current verification baseline, security gate evidence, and intentional compatibility trade-offs for the ZeroProxy "No-Escape Jail" isolation model. Each gate lists the source files and automated tests that enforce its contract.

## Current Verification Baseline

The table below lists the verification commands and baseline metrics across all test suites.

| Suite | Command | Scope and Baseline |
| :--- | :--- | :--- |
| **JavaScript unit and policy** | `npm run test:js` | Policy rules, core helpers, Service Worker routing, and prelude contracts (185 tests) |
| **Rust workspace** | `cargo test --workspace` | OXC rewriter matrix (3,360 combinations), HTML/CSS transforms, codecs, and shared policy (329 passing, 3 ignored) |
| **Go server and host** | `go test ./...` | HTTP host handler, relay bridge, share URL parity, and TURN/WebTransport gateways (all packages pass) |
| **WASM bundle integration** | `npm run test:wasm:ci` | Contract checks against compiled WASM artifacts in `dist/` (18 passing tests) |
| **Browser E2E** | `npm run test:e2e` | E1 containment escape matrix and native-vs-proxy differential suite (269 passing tests with site-isolated frames on, the default; the suite also passes with `ZP_E2E_SITE_FRAMES=0`) |
| **TLS ClientHello parity** | `npm run check:chrome-hello` | Verifies extension set and `trust_anchors` payload match installed Chrome (155.0.8059.85) |
| **Real-site script corpus** | `node --experimental-vm-modules scripts/rewrite-corpus-check.cjs <tape>` | Rewrites 705 cached scripts from 13 live sites and validates V8 parsing (0 failures) |
| **Real-site rendering** | `taskweaver` (`--id zp`) | Loads Wikipedia, GitHub, Guardian, BBC, MDN, CNN, NAVER, NYT, Stack Overflow, Reddit, Apple, npm, and IMDb |

Open compatibility residuals are tracked in the Residuals section of [`ERRATA.md`](ERRATA.md).

Marker key: `[x]` closed · `[~]` partial or tracked in a follow-up workstream · `[ ]` open.

---

## P0: Outer Perimeter (Hard Egress and Dynamic Code Gates)

P0 gates enforce Content Security Policy headers, per-tab capability token verification, and fail-closed dynamic code compilation.

| Gate | Status | Evidence |
| :--- | :--- | :--- |
| **A1** CSP unification and tightening (`connect-src 'self' <ws>`, no `script-src blob:/data:`) | `[x]` | [`internal/headers/csp.go`](internal/headers/csp.go), [`crates/zp-shared/src/csp.rs`](crates/zp-shared/src/csp.rs), [`test/js/static-policy.test.js`](test/js/static-policy.test.js) (`fixedCSP` projection and Go parity). A target's enforced Trusted Types directives (header and `<meta>`) bind the proxied document: [`web/membrane/02-trusted-types.js`](web/membrane/02-trusted-types.js), `trusted_types_directives` in [`csp.rs`](crates/zp-shared/src/csp.rs), unit tests `trusted types: …` in [`test/js/prelude-units.test.js`](test/js/prelude-units.test.js), and the e2e tests "… Trusted Types …" in [`test/e2e/proxy.test.js`](test/e2e/proxy.test.js) (every sink's default-policy call and refusal message equal native; report-only enforces nothing) |
| **A2** Capability-token validation (`event.source.id` required, no `firstTab` fallback) | `[x]` | [`web/sw.js`](web/sw.js) (`runtimeMessageAuthorized`), [`test/js/static-policy.test.js`](test/js/static-policy.test.js) (`firstTab` absence test) |
| **A3** `blob:` and `data:` script and worker sealing | `[x]` | [`web/membrane/17-workers.js`](web/membrane/17-workers.js) (`installWorkerHooks`), empty-MIME and `application/octet-stream` rejection branch, [`test/js/static-policy.test.js`](test/js/static-policy.test.js) |
| **A4** Fail-closed dynamic compilation (`eval`, `Function`, string timers, constructor chains) | `[x]` | `dynamicEval`, `dynamicFunction`, `compileScoped`, and `compileDynamic` in [`web/membrane/`](web/membrane). Every non-function timer handler (strings, objects with `toString()`, arrays, and `TrustedScript` instances) is rewritten in both page and worker realms, and `eval(TrustedScript)` compiles rewritten code ([`ERRATA.md`](ERRATA.md) items 77 and 78, [trap notebook](.ai/trap-notebook/rewriter.md)). |
| **A5** Isolated `/__zp/error?code=...` error page (`safeError` and `ERROR_INFO`) | `[x]` | [`web/sw.js`](web/sw.js) (`safeError`), [`web/zp-core.js`](web/zp-core.js) (`ERROR_INFO` with 19 pinned error codes) |
| **A6** P0 regression suite in escape matrix | `[x]` | [`test/e2e/proxy.test.js`](test/e2e/proxy.test.js) (`escape matrix - strict mode`) |

---

## P1: Transform Pipeline and Inline Script Containment

P1 gates govern streaming HTML and script transformation, `srcdoc` execution ordering, request body caps, and relay connection draining.

| Gate | Status | Evidence |
| :--- | :--- | :--- |
| **B1** `zp-htmltx` and `zp-rewriter` Rust integration (inline `<script>` and `on*` attributes) | `[x]` | [`crates/zp-htmltx/src/lib.rs`](crates/zp-htmltx/src/lib.rs), `__ZP_EXEC_INLINE_REWRITTEN` and `__ZP_EXEC_INLINE_REWRITTEN_MODULE` paths, Rust unit tests |
| **B2** `srcdoc` ordering guarantee (inline scripts and `body onload` cannot run before the prelude) | `[x]` | [`test/e2e/proxy.test.js`](test/e2e/proxy.test.js) (`srcdocEchoPromise` fixture) |
| **B3** Page-realm OXC dual delivery (bundle plus `text/zp-pending` deferred fallback) | `[x]` | `__ZP_EXEC_INLINE_REWRITTEN*` wrappers and closure-private rewriter in [`web/membrane/15-scripts-css.js`](web/membrane/15-scripts-css.js) |
| **B4** `EventSource` fidelity (auto-reconnect, `Last-Event-ID`, `retry:`, `Content-Type` validation) | `[x]` | [`web/membrane/08-http.js`](web/membrane/08-http.js) (`ZPEventSource`), [`test/js/static-policy.test.js`](test/js/static-policy.test.js) (`SSE auto-reconnect + Last-Event-ID fidelity`) |
| **B5** Request body size cap and `REQUEST_BODY_TOO_LARGE` | `[x]` | [`web/sw.js`](web/sw.js) (`MAX_REQUEST_BODY_BYTES = 8 MB`), [`crates/zp-shared/src/errors.rs`](crates/zp-shared/src/errors.rs), E2E oversized payload test |
| **B6** 307/308 redirect body replay (`REDIRECT_BODY_NONREPLAYABLE` fail-closed) | `[x]` | [`web/sw.js`](web/sw.js) (`transportFetchHop`): snapshots the request body (`bodyU8`) before the first hop so 307/308 method-preserving redirects replay intact bytes and fail closed with [`crates/zp-shared/src/errors.rs`](crates/zp-shared/src/errors.rs) when non-replayable. |
| **B7** Bidirectional relay drain on context cancellation (zero goroutine leaks) | `[x]` | [`internal/httphost/`](internal/httphost) (`bridgeConns`), `TestBridgeToTorClosesBothEndsOnContextCancel`, `TestBridgeInternalSOCKSConnectsToTarget` |

---

## P2: Protocol Fidelity, Malformed HTML Sealing, and Rewrite Cache

P2 gates verify WebSocket frame handling, malformed HTML blocking, share URL scheme validation, and the Service Worker script rewrite cache.

| Gate | Status | Evidence |
| :--- | :--- | :--- |
| **C1** WebSocket fidelity (subprotocol §4.2.2, close code/reason §7.4, closing handshake drain §7.1.6, `binaryType`, `bufferedAmount`) | `[x]` | [`web/membrane/08-http.js`](web/membrane/08-http.js) (`installWebSocket`), [`web/sw.js`](web/sw.js) (`openRuntimeStream`), and [`crates/zp-kernel-bundle/src/kernel/transport/ws_client.rs`](crates/zp-kernel-bundle/src/kernel/transport/ws_client.rs) (RFC 6455 handshake, client frame masking, and `WsClient`). `ZPWebSocket.close()` sends the close frame, arms a 30-second guard, and waits for the `{type:'close'}` acknowledgment from the Rust client before firing `finish()` so in-flight `message` events drain before entering `CLOSED`. |
| **C2** Malformed HTML fail-closed (`MALFORMED_HTML`, no raw passthrough) | `[x]` | [`web/sw.js`](web/sw.js) (`transformDocumentResponse`), [`test/js/static-policy.test.js`](test/js/static-policy.test.js) (`fails closed on malformed HTML`) |
| **C3** Share URL scheme validation and cross-language parity | `[x]` | 27-case fixture in [`crates/zp-shared/testdata/shareurl_cases.json`](crates/zp-shared/testdata/shareurl_cases.json), [`internal/shareurl/parity_test.go`](internal/shareurl/parity_test.go) |
| **C4** Service Worker rewrite cache (SHA-256 keyed, LRU 200 entries / 50 MB cap) | `[x]` | [`web/sw.js`](web/sw.js) (`rewriteCache`), [`test/js/static-policy.test.js`](test/js/static-policy.test.js) (`rewrite cache enforces strict invariants`) |

---

## D: Routing Gateways and Origin/Storage Virtualization

D gates cover `javascript:` URLs, source map composition, background service stubs, WebTransport and WebRTC gateways, and per-origin storage and permission isolation.

| Gate | Status | Evidence |
| :--- | :--- | :--- |
| **D1** `javascript:` URL routing (`data-zp-jsurl` stash and delegated execution) | `[x]` | [`crates/zp-htmltx/src/lib.rs`](crates/zp-htmltx/src/lib.rs), [`web/membrane/13-attrs.js`](web/membrane/13-attrs.js) |
| **D2** Source map composition and chaining | `[x]` | [`crates/zp-rewriter/src/sourcemap.rs`](crates/zp-rewriter/src/sourcemap.rs) (VLQ and Source Map v3 writer), `compose_source_map`, [`web/sw.js`](web/sw.js) `/zp/api/sourcemap` route, and [`internal/headers/policy.go`](internal/headers/policy.go) header stripping. Embeds `sourcesContent` so DevTools breakpoints map back to original source lines. |
| **D3** Background Sync and Push virtualization | `[x]` | [`web/membrane/17-workers.js`](web/membrane/17-workers.js) (`installTargetServiceWorkerBlocker`): `register`, `ready`, and `getRegistration` resolve to virtual objects, `sync.register` is a no-op, and `pushManager.subscribe` rejects with `NotAllowedError`. |
| **D4** WebTransport gateway | `[x]` | Server [`internal/wtproxy/listener.go`](internal/wtproxy/listener.go) (`quic-go` and `webtransport-go` HTTP/3 listener bridging bidirectional streams, unidirectional streams, and datagrams) and client [`web/membrane/19-gateways.js`](web/membrane/19-gateways.js) (`ZPWebTransport` wrapper routing via `?target=` query string, or rejecting with `WT_UNSUPPORTED` when disabled). Verified by [`test/e2e/wt-gateway.test.js`](test/e2e/wt-gateway.test.js) across page and worker realms including certificate hash pinning. Operational note: QUIC cannot traverse TCP SOCKS5/Tor, so the gateway dials targets directly ([trap notebook](.ai/trap-notebook/transport-regression.md)). |
| **D5** WebRTC TURN relay enforcement | `[x]` | Server [`internal/rtcgw/turn.go`](internal/rtcgw/turn.go) (`pion/turn/v4` embedded TURN server issuing RFC 7635 short-term credentials) and client [`web/membrane/19-gateways.js`](web/membrane/19-gateways.js) (wrapping `RTCPeerConnection` with server-issued TURN credentials and forcing `iceTransportPolicy: 'relay'`). Remote peers observe only the relay IP, and the relay forwards only encrypted DTLS/SRTP packets. Without TURN credentials the same native connection is configured with no ICE servers at all (still relay-only): it gathers no candidate and sends no packet, while its local API (`createOffer`, `createDataChannel`) works as in a browser, which a page that reads codecs from an offer needs; the E1 matrix probe and the iframe isolation test ask for a STUN server and every candidate type and count zero candidates, in the page and in its frames. Verified by [`test/e2e/rtc-relay.test.js`](test/e2e/rtc-relay.test.js) and `TestTURNServerAcceptsItsOwnCredentials` ([trap notebook](.ai/trap-notebook/transport-regression.md)). |
| **D6** Physical hardware API pass-through (Bluetooth, USB, Serial, HID, NFC, Sensor) | `[x]` | Left unwrapped because native browser permission prompts act as the user consent boundary. Verified in the E1 escape matrix. |
| **D7** Origin and storage virtualization (`localStorage`, `sessionStorage`, IndexedDB, CacheStorage, cookies, `origin`, `BroadcastChannel`, `SharedWorker`, `Notification`, OPFS, permissions, Privacy Sandbox, `webkit*` aliases) | `[x]` | [`web/membrane/11-cookies.js`](web/membrane/11-cookies.js), [`web/membrane/12-storage.js`](web/membrane/12-storage.js) (`installStorageFacades`), and [`web/worker-prelude.js`](web/worker-prelude.js). Verified contracts:<br>• Filters `storage` events per virtual origin and unwraps namespaced keys ([`ERRATA.md`](ERRATA.md) item 33).<br>• Mirrors `Set-Cookie` headers from `fetch` and XHR responses into the page cookie jar before resolving responses, and broadcasts cookie deltas only to frames and tabs of the same virtual origin ([`ERRATA.md`](ERRATA.md) items 34, 36, and 40).<br>• Emulates opaque origins (`origin === "null"`, denied storage/cookies/OPFS/locks, and cross-origin window handles) for sandboxed iframes without `allow-same-origin` ([`ERRATA.md`](ERRATA.md) item 37).<br>• Computes cross-origin frame `featurePolicy` and `permissions` from the virtual frame tree so embedder permissions never leak ([`ERRATA.md`](ERRATA.md) item 84). |

---

## E: Verification Suites and Performance Baselines

E gates cover the hostile escape matrix, real-site regression suite, and WebAssembly bundle size and rewriter latency bounds.

| Gate | Status | Evidence |
| :--- | :--- | :--- |
| **E1** Hostile escape matrix (master suite) | `[x]` | Comprehensive browser verification in [`test/e2e/proxy.test.js`](test/e2e/proxy.test.js):<br>• **Strict-mode escape prevention**: indirect `eval`, computed member access, destructuring, optional chaining, constructor chains, iframe clean realms, `blob:`/`data:` workers, `srcdoc`, `javascript:` URLs, direct network egress, and storage isolation.<br>• **Native-vs-proxy differential suite (`/compat-probes`)**: compares native and proxied execution in isolated browser contexts and asserts zero direct target network requests.<br>• **Frame and popup isolation (`/iframe-probes`)**: returns `crossOriginHandle` stand-ins enforcing HTML cross-origin rules across `contentWindow`, `frames[i]`, `parent`, `top`, `opener`, and `frameElement`, and checks `postMessage` `targetOrigin` against the recipient's virtual origin. Enforces membrane installation across pending route frames, `about:blank` transitions, tagless HTML documents, opaque sandboxed frames, and all DOM insertion methods (`replaceChildren`, `insertAdjacentElement`, `Range.insertNode`, `before`, `after`, `replaceWith`) ([`ERRATA.md`](ERRATA.md) items 38, 39, and 41).<br>• **Worker suite (`__workerProbes`)**: dedicated, module, and shared workers with virtual `location`, proxied transport, synchronous XHR bridge, dynamic code rewriting, and stack sanitization.<br>• **CSP and dynamic code suites (`/csp-probes`, `/dyn-probes`)**: inline modules, `<meta>` CSP intersection, violation reporting, `eval`/`Function`/timer/`import()` rewriting, and stack frame masking.<br>• **Helper name and internal collection sealing (`/xhelper`)**: rejects page scripts that bind or overwrite `__zp_*` helper names, blocks window property redefinition of internal helpers, and seals membrane `Map`/`Set`/`WeakMap`/`WeakSet` instances against prototype tampering ([`ERRATA.md`](ERRATA.md) items 86, 91, and 93).<br>• **Loop cap and surface suites (`/perf-probes`, `/surface-probes`)**: 10M iteration cap on synchronous infinite loops (`while(true)`, `for(;;)`, `do{}while`), import maps, declarative shadow DOM, SVG `href`/`xlink:href`, `<a ping>` rewriting, and cross-window Proxy facades. |
| **E2** Real-world site regression (`npm run dogfood:real-site`) | `[x]` | [`test/e2e/real-site-regression.test.js`](test/e2e/real-site-regression.test.js): boots `dist/zeroproxy-server` on an ephemeral port, launches Puppeteer with a fresh profile, submits live target URLs (`en.wikipedia.org`, `example.com`, and optional targets) through the launcher, and verifies target document titles, rendering, and absence of fatal proxy errors. |
| **E3** Bundle size and rewriter performance baseline | `[x]` | • **Page-realm WASM footprint**: `zp_page_bundle_bg.wasm` is **375 KB**, below the 500 KB ceiling enforced by `E3 size guard: zp_page_bundle_bg.wasm <= 500 KB` in [`test/js/static-policy.test.js`](test/js/static-policy.test.js). CSS and HTML transformers live only in the Service Worker bundle.<br>• **Service Worker WASM split**: `zp_bundle_sw_bg.wasm` (~1.34 MB) loads on activation, while the transport kernel `zp_kernel_sw_bg.wasm` (~2.37 MB) loads lazily on the first outbound network request (`initKernel()`).<br>• **Arena reuse and patch-mode emit**: `RewriterInstance` reuses its bump `Allocator` across warm calls, and the Service Worker applies span patches (`rewriteScriptPatches` and `applyScriptPatches`) rather than re-emitting full script source strings. |
| **E4** Operational rollout and automated regression | `[x]` | Strict mode is the single default runtime mode. Operator dogfood procedures and rollback steps live in [`PRODUCTION_ROLLOUT.md`](PRODUCTION_ROLLOUT.md). `third_party-rustls-fork` tolerates unknown TLS 1.3 `CertificateEntry` extensions (such as RFC 6962 SCT extensions). |
| **E5** Gate status and documentation alignment | `[x]` | Maintained in this document ([`PHASE2_STATUS.md`](PHASE2_STATUS.md)) and [`ERRATA.md`](ERRATA.md). |

---

## Intentional Divergences (Parity Pins)

General compatibility gaps between native execution and ZeroProxy have been closed (`expectedDivergences` in the native-vs-proxy differential suite is empty). The tables below list behaviors that intentionally diverge from native browsers to preserve security containment or single-origin virtualization. Each item is pinned by assertions in [`test/e2e/proxy.test.js`](test/e2e/proxy.test.js).

### Security-Driven Blocks (Fail-Closed Priority)

These surfaces reject or namespace calls to prevent proxy-origin leakage or unrewritten code execution.

| Surface | Proxy Behavior | Rationale and Test Pin |
| :--- | :--- | :--- |
| `navigator.credentials.get/store/create` | Rejects with `NotAllowedError` | Prevents exposing credentials tied to the shared proxy host RP-ID (`credGet` pin) |
| `navigator.locks` | Prefixes lock names with an FNV origin hash | Prevents cross-target lock contention and observation (`navLocks` pin) |
| Storage facades (`localStorage`, `sessionStorage`, IndexedDB, Cache) | Prefixes keys and database names per target origin | Prevents cross-target storage contamination on the shared proxy origin (`storagePrefix`, `sessionStoragePrefix`, `cachesAPI` pins) |
| `BroadcastChannel` | Prefixes channel names per target origin | Isolates broadcast messages by target site (`broadcastChannelName` pin) |
| `frame-src data:` and `worker-src blob:` | Attribute and constructor policies block before CSP | Seals unrewritten execution vectors ahead of CSP evaluation (`sealed paths fail before CSP` pin) |
| Unrewritable dynamic code (`eval`, timer strings) | Throws `NotSupportedError` (instead of `SyntaxError`) | Enforces fail-closed rejection when AST rewriting fails (`dynamic code suite` pin) |
| `ShadowRealm.prototype.evaluate` / `importValue` | Throws `NotSupportedError` | Blocks unrewritten code execution in separate realms |
| `<a ping>` | Stashes URLs in `data-zp-ping` and dispatches a proxied keepalive POST on click | Prevents native background direct POST egress (`anchorPing` and wire assertions) |
| `navigator.registerProtocolHandler` | Validates virtual origin and returns without native registration | Prevents registering the proxy origin in browser protocol handler UI (`registerPH` pin) |

### Compatibility Trade-Offs (Virtualization Differences)

These surfaces remain functional while differing in specific return values or timing due to single-origin virtualization.

| Surface | Proxy Behavior | Rationale and Test Pin |
| :--- | :--- | :--- |
| `alert`, `confirm`, `prompt`, `print` | Returns `undefined`, `false`, `null`, or no-op | Prevents modal dialogs from wedging headless runs or tabs (`dialogStubs` pin) |
| Fingerprint and performance surfaces | Spoofs `performance.memory`, `hardwareConcurrency`, and `deviceMemory`; rewrites navigation entry `name` to virtual URL; sanitizes error stacks | Masks host hardware and internal `/zp/` asset paths (`realProps`, `perfNavEntry`, `consoleString` pins) |
| `document.domain` | Setter is a silent no-op; getter returns the virtual hostname | Matches modern Chrome `document.domain` setter deprecation (`documentDomainSetter` pin) |
| `navigator.sendBeacon` | Routes through `fetchThroughRuntime` keepalive | Forces beacon traffic through the Service Worker transport tunnel |
| `window.open('javascript:...')` | Executes rewritten script in the current realm | Preserves functionality without spawning an uninstrumented window |
| `<a download>` | Downloads through the proxied transport path | Prevents direct network egress while preserving filenames |
| Cross-script `let`/`const` in strict classic scripts | Registers in `__zp_lex` but cannot be read as bare identifiers across separate strict scripts | Strict-mode evaluation forbids `with(__zp_lex_scope)` wrapping |
| Top-level `var`/function in strict classic scripts | Exported to the realm's global as accessors over the script's own bindings (`__zp_export_vars`), so later inline scripts, external scripts and event-handler attributes see them; `window.X`, `'X' in window` and `Object.keys(window)` match native | A name a later strict script declares again starts from the global's value and writes reach every copy (an earlier script's own later assignment reaches only its own copy); the descriptor is a configurable accessor; native accessors and non-configurable properties are left alone; a real (external) script's own var is detected and left alone |
| Runtime-created `<link rel=preload>` | Loads through the proxy like a static preload (`href` rewritten, `data-zp-lit-href`), fires `load`/`error`; the hole matrix measures no direct request (`b8-preload-link`) | `prefetch`, `modulepreload`, `preconnect`, `dns-prefetch`, `prerender` and `manifest` are still stripped (`b8b-prefetch-link`) |
| CSS the page makes at runtime (`<style>` text through the tree, `insertRule`, `replaceSync`, `@import`, `//host` URLs) | Rewritten before the browser can fetch: tree-inserted style text synchronously in `patchInsertion`, protocol-relative URLs resolved against the target; the hole matrix measures no direct request (`d8`, `d9`) | `text.data = …` and `appendData` on a text node already inside a style are caught by the MutationObserver only |
| Blob and data modules and scripts | A `<script src=blob:>` runs only as a rewritten copy (`routeBlobScript`, `src` reads back as the page's blob); a static `import` of a `blob:`/`data:` URL in a module is swapped by the page's rewriter for a rewritten copy (`zp-import:` placeholder, depth 8) and fails to load anywhere else; E1 rows `scriptBlobSrc` (`ran-rewritten`) and `staticBlobImport` | `import()` of a blob already took the same path; a server module or a worker with a static `blob:`/`data:` import fails to load (ERRATA) |
| `javascript:` links and forms | Run as the link's or form's default action: after the event is dispatched, in a task of their own, not when a listener cancelled it, nothing stopped. The URL is rewritten when it runs and is never taken from an attribute (`data-zp-jsurl` is written by the HTML transformer but not read); E1 row `forgedJavascriptURL` | The rewritten code the HTML transformer still writes into `data-zp-jsurl` is unused |
| Descriptor flags of the membrane's method hooks | A method hook keeps the native's `configurable` bit (wrappable and deletable as natively) unless an ancestor has the name or the hook is a new own property; deleting leaves nothing underneath (e2e: `members the page wraps with Object.defineProperty read, redefine and call as natively`) | Accessor hooks stay non-configurable (ERRATA); `installedHooks` is the registry `propertyLocked` consults |
| Native `EventTarget` methods called on `window` | `EventTarget.prototype.addEventListener`, `removeEventListener` and `dispatchEvent` map the page-facing window to the real one (`pageRewriteHooks.unwrapScope`), so `.call(window, …)`, `.apply`, and kept copies work as natively; e2e `EventTarget methods the page keeps and calls on window register, fire and remove as natively` | A child frame's own facade is not mapped (ERRATA) |
| Module specifiers the page-side rewriter writes | Absolute against the proxy origin (the fourth argument of `ZPBundle.rewriteScript`), so an inline module run as a `blob:` import and the blob copies resolve them; e2e `an inline module that imports its own site by absolute address runs, as natively` | The service worker's rewrites already passed the origin |
| Compound writes to dangerous members inside another rewritten range | Rebased with the right field table (`shift_marker_positions`: `MEMBER_A` positions 2, 3, 6, 7); a leaked marker made the whole script unparseable; Rust test `nested_compound_member_assignment_leaves_no_marker` | None known |
| Uninitialized lexical reads (TDZ) | Throws `ReferenceError` with `ErrorEvent.filename` pointing to the prelude | The throw site resides inside the membrane scope helper |
| Asynchronous `while(true)` without `break` | Terminates at the 10M iteration cap | Protects the renderer thread from unbounded loop starvation |
| `history.go/back/forward`, `history.length`, window bar properties, XPath | Delegates to native browser implementation | Accepted shared session history metadata on the proxy origin |
| `document.featurePolicy`, `iframe.featurePolicy` | Computes allowed features and origins from the virtual frame tree | Prevents cross-origin frames from reading embedder permissions (`/xfp` test, [`ERRATA.md`](ERRATA.md) item 84) |
| File pickers (`showOpenFilePicker`, etc.) and `ElementInternals` | Delegates to native browser implementation | User-gesture consent APIs and Shadow DOM internals |
| `import('data:...')` and `import('blob:...')` | Rewrites module source and imports from a fresh `blob:` URL | Preserves module containment (module `import.meta.url` reflects the `blob:` URL) |
| Worker `self.location`, `self.origin`, `new URL(rel)` | Resolves against the virtual target URL and origin (`blob:`/`data:` workers inherit creator `ref`) | Masks proxy worker bootstrap URLs (`urlResolve`, `origin` pins) |
| `SharedWorker` `self.name` | Strips internal `zp:w:<hash>:` isolation prefix on read | Isolates shared workers per target while returning the caller's requested name (`shared worker isolation` pin) |
| `navigator.permissions.query` | Tracks grants per target origin; cross-origin frames receive `denied` for non-delegated features and notifications | Prevents leaking proxy-origin permission grants across sites (`permGeo` pin) |
| `navigator.storage.getDirectory()` (OPFS) | Returns a per-target `zp:o:<hash>` subdirectory handle in page and worker realms | Isolates Origin Private File System trees between targets (`opfsName` pin) |
| `fetchLater` | Dispatches a `/zp/api/v2/fetch` keepalive envelope on `pagehide` or `visibilitychange` | Prevents direct egress while approximating deferred send timing (`fetchLaterCall` pin) |
| Privacy Sandbox (`sharedStorage`, `runAdAuction`, `joinAdInterestGroup`, `browsingTopics`, `privateToken`) | Removed (`undefined`) or rejected | Prevents cross-target data mixing under the shared proxy origin (`paSurfaces`, `sharedStorageW` pins) |
| `Element.setHTML`, `setHTMLUnsafe`, `Document.parseHTMLUnsafe` | Transforms markup via `transformHTML` before calling the native method | Guarantees URL and script rewriting inside sanitized HTML insertion (`setHTMLHook` pin) |
| `Element.getHTML`, `getHTMLUnsafe`, `ShadowRoot.getHTML` | Deproxies serialized URLs and strips `data-zp-*` attributes | Prevents leaking internal stash attributes and proxy URLs (`getHTMLClean` pin) |
| `isSecureContext` (page and worker) | Evaluates based on the virtual target scheme (`https:` or `localhost`) | Prevents `http:` targets from observing `true` from `proxy.localhost` (`secureCtx` pin) |
| `webkitURL`, `webkitIndexedDB`, `webkitIDB*` | Aliases to the virtual `URL` wrapper and namespaced IndexedDB facade | Prevents legacy vendor aliases from bypassing membrane hooks (`webkitURLAlias`, `webkitIDB` pins) |
| `webkitRequestFileSystem`, `webkitResolveLocalFileSystemURL` | Rejects with `SecurityError` in pages; removed (`undefined`) in workers | Blocks shared proxy-origin filesystem access while matching native presence on `window` (`webkitFS` pin, [`ERRATA.md`](ERRATA.md) item 65) |
| `webkitPersistentStorage`, `webkitTemporaryStorage` | Removed (`undefined`) | Prevents shared storage quota inspection across targets (`webkitFS` pin) |
| Iframe `csp` attribute, `XSLTProcessor`, non-UTF-8 transcoding, `<script nomodule>` | Retained as accepted residuals | Frame CSP is governed by the proxy header; legacy XSLT and non-UTF-8 transcoding are not emulated |

### Resolved Parity Items (No Longer Divergent)

The following behaviors match native browser semantics:

- Direct `eval` inside functions accesses caller lexical bindings in both sloppy and strict code (`ScriptKind::ClassicLocal` and descriptor accessors).
- Sloppy `eval` `var` declarations hoist into the caller's variable environment (`varEnv`).
- Top-level `let`, `const`, and `class` bindings persist across classic scripts, throw `SyntaxError` on redeclaration, and throw `TypeError` on `const` reassignment (`__zp_lex` registry).
- Sloppy Annex B block-scoped function declarations and labeled functions hoist per specification.
- `new eval()` throws `TypeError` matching native engines.
- `getAttribute` returns the original unrewritten literal attribute string (`data-zp-lit-*` stash).
- Static and dynamically inserted `<meta http-equiv="Content-Security-Policy">` elements intersect with the proxy CSP header synchronously.
- `import.meta.resolve` resolves specifiers against the virtual target URL.
- `location === document.location` identity holds, and `location.ancestorOrigins` returns virtual ancestor origins.
- `XMLSerializer` deproxies serialized markup, and `cookieStore` shares the same virtual cookie jar as `document.cookie`.
