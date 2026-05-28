# ZeroProxy Architecture

Assessment basis: the current repository implementation as of 2026-05-28, plus the cutover target described in `PHASE3_PLAN.md`.

ZeroProxy is a client-owned virtual browsing prototype. The browser renders target pages as same-origin proxy documents, while target HTTP/TLS/WebSocket traffic is intended to leave only through the controlled transport stack below:

```text
Browser top-level target document
  ├─ /zp/sw.js Service Worker
  │   ├─ request classifier for every controlled fetch under `/zp/`
  │   ├─ in-memory tab/history/context state plus inherited relay-server list
  │   ├─ encrypted /zp/p route activation
  │   └─ Go WASM kernel exports
  │       ├─ __go_jshttp(request)      -> target HTTP/2 or HTTP/1.1 fetch
  │       ├─ __zp_stream(options)      -> target WebSocket stream
  │       ├─ __zp_kernel_init()        -> transport readiness
  │       └─ __zp_cookie_set(request)  -> document.cookie bridge
  ├─ /zp/assets/rust-rewriter.js
  │   └─ Rust WASM AST walker returning rewritten JavaScript
  ├─ /zp/assets/runtime-prelude.js
  │   ├─ fetch/XHR/EventSource/WebSocket/sendBeacon wrappers routed through same-origin runtime APIs
  │   ├─ navigation, form, history, location, and getter masking hooks
  │   ├─ storage namespace facades
  │   ├─ worker and iframe containment hooks
  │   ├─ dynamic HTML parser traversal and stealth membrane
  │   └─ WebRTC/WebTransport/device API blocking stubs plus `WebSocketStream`
  └─ transformed target HTML as the top-level document

Proxy origin server
  ├─ static assets: /zp/, /zp/sw.js, /zp/assets/*, /zp/kernel.wasm
  └─ /zp/ws-pipe WebSocket endpoint
      └─ yamux server session
          └─ per-stream SOCKS5 handling
              ├─ external Tor SOCKS5 byte bridge (`-socks host:port`)
              └─ internal SOCKS5 parser + direct relay dialer (`-socks internal`, tests only)
```
The relay server terminates only the browser WebSocket and yamux session. It uses `github.com/gorilla/websocket` for `/zp/ws-pipe`, disables WebSocket compression, wraps binary WebSocket messages as a stream-oriented `net.Conn`, and either byte-bridges yamux streams to the configured Tor SOCKS5 listener or, when launched with `-socks internal`, parses the kernel's SOCKS5 greeting/auth/CONNECT request itself and directly dials the requested target from the relay process. It does not parse target HTTP, TLS, redirects, cookies, or HTML. Those responsibilities live in the Go WASM kernel and browser runtime. Internal mode is a non-anonymous test/development mode.

## Core invariants

- Target document navigations use encrypted `/zp/p/<encrypted>#k=<key>&server=...` routes on the proxy origin.
- The `#k` fragment is decrypted in the browser shell, removed with `history.replaceState`, and not sent to the server.
- Every Service Worker-controlled request is classified. Unknown requests are blocked; there is no native `fetch(event.request)` fallback.
- Privileged runtime-to-Service-Worker control messages require a per-tab capability token injected into the runtime prelude and removed from target-visible DOM before target code runs.
- Target TCP connections are opened through WebSocket -> yamux -> SOCKS5 DOMAINNAME. With a Tor `-socks` address the relay byte-bridges to Tor; with `-socks internal` the relay validates the SOCKS5 CONNECT bytes and direct-dials the target for Tor-free testing. The kernel does not call `http.Transport` for target egress.
- HTTPS uses uTLS over the SOCKS5 stream with ALPN selecting HTTP/2 when available and HTTP/1.1 fallback; target WebSocket upgrade pins HTTP/1.1.
- Target response headers are passed through a constructor policy before the browser receives a `Response`.
- Anti-bot spoofing is not a project goal. The runtime applies limited self-fingerprint masking only to reduce trivial detection of its own hooks and host-resource leaks (`Function.prototype.toString`, Canvas/Audio extraction jitter, and speech voice lists).

## Main components

| Area | Files | Responsibility |
|---|---|---|
| Static shell | `web/index.html`, `web/zp-core.js` | Service Worker registration, target URL canonicalization, share URL encryption/decryption, initial target open. |
| Share URL envelope | `web/zp-core.js`, `internal/shareurl/*` | Compatible JavaScript and Go implementations of `/zp/p/<encrypted>#k=<key>` using AES-256-CBC, HMAC-SHA256, HKDF, raw base64url, and inherited relay-server fragments. |
| Service Worker | `web/sw.js` | Classifies every controlled request under `/zp/`, blocks unknowns, manages in-memory tab/entry state and inherited relay servers, requires per-tab capability tokens on privileged runtime bridge messages, calls the WASM kernel, exposes runtime bridge APIs. |
| Runtime prelude | `web/runtime-prelude.js`, `web/worker-prelude.js` | Installs target-realm containment hooks before target scripts run. Main-window fetch/XHR/EventSource/WebSocket/sendBeacon, navigation/form/history/location/storage/worker/iframe/device APIs are hooked; main-window and worker `fetch` bridge through `/zp/api/fetch` to satisfy strict proxy-origin CSP while preserving the Tor/yamux/uTLS transport path. Runtime membrane helpers (`__zp_get`, `__zp_set`, `__zp_call`, `__zp_construct`, `__zp_getOwnPropertyDescriptor`, `__zp_ownKeys`) and dynamic compilation wrappers execute `Function`/`eval`/string timer bodies under the virtual global scope. Rust WASM rewrite helpers are loaded before runtime hooks so static and dynamic inline scripts can be rewritten or blocked fail-closed. |
| WASM kernel | `cmd/wasm-kernel/main.go`, `internal/swhttp/*` | Converts JS `Request`/`Response`, initializes transport, owns target HTTP and WebSocket execution. |
| Transport | `internal/wsconn/*`, `internal/yamuxconn/*`, `internal/socks5/*`, `internal/utlskernel/*`, `internal/zphttp/*`, `internal/wsproto/*` | Browser WebSocket `net.Conn`, yamux streams, SOCKS5 DOMAINNAME CONNECT, uTLS, HTTP/2 and HTTP/1.1 target fetch, target WebSocket upgrade/framing. |
| HTML/header/cookie policy | `internal/htmltx/*`, `internal/headers/*`, `internal/cookiejar/*`, `internal/zpiso/*` | HTML transformation, inline script/event-handler rewrite wrappers, safe response header constructor policy, target cookie jar, and relay-server inheritance metadata. |
| Relay server | `cmd/zeroproxy-server/main.go` | Serves prefixed assets, accepts `/zp/ws-pipe` with Gorilla WebSocket, and routes yamux streams either to the configured Tor SOCKS5 address or the `-socks internal` SOCKS5 parser/direct dialer. |

## Request flow

1. The shell registers `/zp/sw.js` with `scope: '/zp/'`, waits for a controller, canonicalizes an `http:` or `https:` target, encrypts it, and navigates to `/zp/p/<encrypted>#k=<key>` on the proxy origin.
2. The shell loaded on `/zp/p/<encrypted>#k=<key>` decrypts the fragment key in window context, validates the HMAC before decryption, normalizes repeated `server=` relay fragments, removes the fragment from the visible URL when policy allows, and sends `ZP_OPEN_SHARE` to the Service Worker.
3. The Service Worker stores the decrypted target plus relay-server list in in-memory tab/entry maps and activates `/zp/p/<encrypted>` as a proxy document route.
4. A `/zp/p/<encrypted>` document request is resolved back to the target URL. The Service Worker calls `__go_jshttp` with `X-ZP-*` internal metadata plus inherited relay-server headers.
5. The WASM kernel ensures one long-lived WebSocket connection to the selected relay server or `/zp/ws-pipe`, wraps it in a yamux client, and opens one yamux stream per target TCP connection.
6. Each target connection performs SOCKS5 `CONNECT` with DOMAINNAME ATYP and a Tor `IsolateSOCKSAuth` username derived from the tab stream-isolation key and target site. In `-socks internal` mode the relay accepts that same binary SOCKS5 handshake locally and direct-dials the requested host:port; no external Tor process is used.
7. HTTPS fetch targets advertise `h2` and `http/1.1` through uTLS ALPN; target WebSocket connections advertise only `http/1.1`.
8. `internal/zphttp` dispatches negotiated `h2` connections through `golang.org/x/net/http2.ClientConn`; HTTP/1.1 fallback writes a direct request and reads the response with `http.ReadResponse`.
9. Redirects are followed inside the kernel so raw `Location` headers are not exposed to browser code.
10. HTML document responses are transformed: Rust/JS rewrite assets plus runtime prelude are injected, document navigation URLs are rewritten to encrypted `/zp/p/<encrypted>#k=<key>` routes, risky tags and headers are removed, and the browser receives a same-origin `Response` with ZeroProxy CSP.

## Shared URL flow

Shared links use this envelope:

```text
/zp/p/<base64url(iv || AES-256-CBC(ciphertext) || HMAC-SHA256 tag)>#k=<base64url 64-byte seed>&server=<wss relay>...
```

`web/zp-core.js` and `internal/shareurl` derive separate HKDF-SHA256 AES-CBC and HMAC keys from the 64-byte seed. The MAC covers a fixed version prefix, IV, and ciphertext. Decryption verifies HMAC first, then decrypts and canonicalizes the target URL. Only `http:` and `https:` targets are accepted for document/fetch traffic; WebSocket wrappers accept only `ws:` and `wss:`.

The Go HTML transformer uses `internal/shareurl.New` when laundering document-navigation attributes, so transformed links/forms/frames keep using encrypted `/zp/p` routes instead of legacy virtual URL paths.

## Service Worker classification

`web/sw.js` calls `event.respondWith(handleFetch(event))` for every fetch event. Classification currently distinguishes:

- internal assets under `/`, `/sw.js`, and `/__zp/*`;
- activated encrypted `/p/<route>` proxy documents;
- runtime APIs under `/__zp/api/*`;
- virtual subresources with an existing client or referrer context;
- unknown requests, which are blocked with a safe error page for navigations or `Response.error()` for subresources.

The Service Worker keeps tab, entry, client-context, route, and stream maps in memory. It tracks active entries, scroll positions, and a document-cookie bridge, but does not persist encrypted state to IndexedDB.

## Transport and HTTP behavior

The Go WASM kernel exposes `__zp_kernel_init`, `__go_jshttp`, `__zp_stream`, and `__zp_cookie_set` to the Service Worker. Initialization creates a browser WebSocket to `/__zp/ws-pipe`; the relay accepts it with Gorilla WebSocket and adapts binary messages to a stream-oriented `net.Conn`. A yamux client/server session runs over that connection. Per-target yamux streams always carry a SOCKS5 CONNECT from the kernel. The relay either forwards those bytes to Tor unchanged or, in `-socks internal`, consumes the SOCKS5 handshake, accepts no-auth or username/password auth, reads IPv4/domain/IPv6 CONNECT addresses, sends a SOCKS5 success/failure reply, and pumps bytes to a direct `net.Dialer` connection.

`internal/zphttp` builds sanitized target requests, applies the cookie jar, follows redirects up to `MaxRedirects`, dispatches HTTPS fetches to HTTP/2 when ALPN selects `h2`, and falls back to direct HTTP/1.1 request/response handling otherwise. HTTP/2 client connections and reusable HTTP/1.1 idle connections are pooled only within the same target authority, tab, and Tor isolation token. Idle target connections use a browser-style 90 second timeout; HTTP/1.1 connections are reused only after the response body reaches EOF and are closed on partial body cancellation or `Connection: close`. Target WebSocket support stays HTTP/1.1 Upgrade through `internal/wsproto` and the runtime `WebSocket` wrapper.

`internal/swhttp.ResponseToJS` constructs JavaScript `Response` objects with a `ReadableStream` backed by the Go response body. Document HTML transformation uses `htmltx.TransformTo` through an `io.Pipe`, so transformed HTML can flow to the browser without first buffering the full document. Request/upload body conversion and browser backpressure/cancellation fidelity are still prototype-level.

## HTML, header, and runtime policy

`internal/htmltx` uses `golang.org/x/net/html` tokenization. It injects `zp-core.js`, inert JSON boot data, and `runtime-prelude.js`; removes base/meta refresh/ping/preload-style escape vectors from static documents; rewrites iframe/frame document URLs to encrypted `/p` routes; preserves author-visible anchor/form attributes for runtime click/submit interception; proxies executable external script sources through `/__zp/api/script?u=<absolute-target>&kind=<classic|module>`; calls the Service Worker-resident OXC rewriter for inline scripts and event handlers from the Go WASM kernel; injects prelude code into `srcdoc`; and replaces blocked embed/object content with inert placeholders.

`internal/headers.ConstructorPolicy` strips target-controlled policy, storage, network-control, hop-by-hop, redirect, and transformed-body headers before constructing a browser `Response`. It defaults cache behavior to `Cache-Control: no-store`.

`web/runtime-prelude.js` installs hooks for high-risk browser APIs from inside the target realm. Main-window fetch, XHR, EventSource, WebSocket, `sendBeacon`, navigation, forms, history/location masking, storage facades, Worker/SharedWorker constructors, service worker registration blocking, high-risk device/network API blockers, and synchronous iframe containment are present. Click navigation handles normal anchors, hash-only virtual navigation, and script-created elements that carry a URL-valued `href` property. The runtime also masks patched function source strings for its virtual location and network wrappers where target scripts commonly inspect `toString()`.

### Client-side replacement matrix

Service Worker:

- `/p/<encrypted>` document requests are resolved from in-memory route state and fetched through `__go_jshttp`; unknown navigations receive safe ZeroProxy errors and unknown subresources receive `Response.error()`.
- `/__zp/api/fetch` accepts runtime `fetch`/XHR/EventSource/sendBeacon payloads, adds `X-ZP-*` tab metadata, enforces the request-body size limit, and routes through the WASM kernel.
- `/__zp/api/script?u=...` fetches the absolute target script through the kernel and returns same-origin JavaScript with `Content-Security-Policy: ZP.fixedCSP()`. By default it runs the OXC rewriter and fails closed to a throwing script on parse/rewrite failure; the current code also carries an explicit compatibility passthrough allowlist for selected third-party challenge/tag-manager scripts, which is an acceptance-boundary exception rather than a general fallback.
- `/__zp/api/worker-script?u=...` does the same for worker and imported worker scripts. Worker bootstrap URLs carry the target script URL and tab id in the hash; `worker-prelude.js` preserves internal `/__zp/api/worker-script` imports without double-wrapping them.

HTML transform:

- `<script src>` with an executable classic/module type becomes `/__zp/api/script?u=<absolute target>&kind=<kind>` and stores the original URL in `data-zp-target-url`; `integrity` is moved to `data-zp-integrity`.
- Inline `<script>` and event attributes are sent through the OXC rewriter when available; otherwise classic inline code is wrapped in `__zp_runClassic` / `__zp_runEvent`, and modules fail closed.
- `<iframe src>` and `<frame src>` become encrypted `/p` routes. `<a href>`, `<area href>`, `<form action>`, and submitter `formaction` keep author-visible attributes, but runtime click/submit interception resolves them against the virtual target URL and converts the actual navigation into a `/p` route. `javascript:`, `data:`, and `vbscript:` navigations are blocked.
- `<base>` is replaced by a small `__ZP_SET_BASE` script; meta refresh, ping, object, and embed are removed or replaced with inert placeholders. Static preload/prefetch/preconnect/dns-prefetch/prerender/manifest links are removed. Dynamic HTML and attribute/property hooks preserve the link element shape when needed for framework compatibility, but suppress active `rel`/`href` and store the original values in `data-zp-blocked-rel` / `data-zp-blocked-url`.
- `srcdoc` receives the runtime boot prelude so its clean realm is hooked before target markup executes.

Runtime prelude:

- Main-window `fetch`, XHR, EventSource, WebSocket, and sendBeacon are replaced with same-origin runtime API clients; target WebSocket frames are bridged through `ZP_WS_OPEN` and `__zp_stream`.
- Dynamic `document.createElement('script')`, `script.src = ...`, `setAttribute('src', ...)`, `createElementNS`, and insertion of detached script nodes launder executable script URLs to `/__zp/api/script?u=...`; proxy internal `/__zp/*` assets are left untouched.
- Dynamic `iframe`/`frame` `src` is converted to an encrypted `/p` route, `srcdoc` is prepended with runtime hooks and has dynamic scripts/events neutralized, clean about:blank frames receive network/device blockers synchronously, and `contentWindow`/`contentDocument` access installs containment before returning the child realm.
- `postMessage` calls on `parent`, `top`, and iframe `contentWindow` are routed through membrane helpers so virtual target origins are mapped to the real proxy origin for delivery, while received message events from known proxied frames expose the child target origin to page listeners.
- Location/history helpers expose virtual target URL state; `location.href =`, `window.location =`, `location.hash =`, `assign`, `replace`, `pushState`, and `replaceState` update the virtual state machine and activate `/p` routes when a real navigation is required. Compound assignments such as `location.href += '#x'` and `window.location.hash += '-tail'` are rewritten to `__zp_assign(...)` and update the same virtual state instead of throwing `BLOCK_EXPR`.
- Dynamic `Function`, constructor-constructor access, `eval`, and string timers run under the virtual global scope; rewritten worker scripts receive worker-side `__zp_get` / `__zp_set` / `__zp_call` / `__zp_construct` helpers; blob/data worker scripts that cannot be synchronously rewritten are replaced with throwing worker bodies.

Browser `window.location` cannot be made indistinguishable from the target origin from ordinary page JavaScript in a same-origin proxy document: many `Location` properties are browser-owned/unforgeable and the real address bar origin remains the proxy origin. ZeroProxy therefore uses best-effort getter masking plus navigation traps, and treats Service Worker/CSP classification as the security boundary.

Current limitation: spoofing is deliberately narrow. These masking hooks reduce obvious proxy/runtime fingerprints and host-resource contradictions, but they are not a complete CreepJS/FingerprintJS anti-detection system and should not be treated as an anonymity proof.

### Browser API compatibility notes

ZeroProxy's replacement APIs are designed to preserve the transport/security boundary first. They intentionally trade exact browser-native semantics for fail-closed routing when the two conflict.

| Surface | Current behavior | Compatibility implications |
|---|---|---|
| `fetch` / `sendBeacon` | Main-window and worker `fetch` calls are bridged through `/__zp/api/fetch`; request bodies are fully read, base64url encoded, and bounded by the Service Worker request-size cap. The runtime records fetch options, but the Service Worker currently forwards method, headers, body, tab, and entry metadata to the WASM kernel. | `mode`, `redirect`, `cache`, `integrity`, and browser credential handling are not one-for-one native semantics. Kernel redirects are followed before browser exposure, target cookies are applied from the Go jar rather than the browser cookie store, and target probe hosts that are unreachable from the current relay environment surface as ZeroProxy safe errors rather than browser-native network errors. |
| XHR | Main-window XHR is an async wrapper over the runtime fetch bridge with basic text, JSON, Blob, and ArrayBuffer response handling. | Synchronous XHR is unsupported, upload/progress events are not browser-complete, and timeout/error/load sequencing is prototype-level. |
| EventSource | EventSource is implemented as a `text/event-stream` fetch and parses `event`, `data`, and `id` fields from the stream. | Native retry, reconnect timing, `Last-Event-ID`, cache, credential, and network-error semantics are not complete. |
| WebSocket | Main-window WebSocket opens a runtime message channel, then the WASM kernel performs an HTTP/1.1 target upgrade through `__zp_stream`. Text, binary, protocol selection, ping/pong, and a basic close path exist. | Browser-exact `bufferedAmount`, close code/reason propagation, error ordering, extension negotiation, and very large-frame behavior are limited. |
| Navigation, forms, history, and location | Clicks, `location` assignments, hash changes, `pushState`, and `replaceState` update virtual URL state and activate `/p` routes. GET forms navigate; non-GET forms are submitted through the runtime fetch path and write transformed HTML back into the current document. | The real address bar remains proxy-origin-backed, active history entries currently stay on encrypted `/p` routes rather than a separate stable-entry namespace, POST navigation is not the browser's native algorithm, and descriptor edge cases require more browser coverage. |
| Workers and worklets | Worker/SharedWorker constructors bootstrap through ZeroProxy; worker script URLs are resolved against the target URL even when module code constructs them from same-origin proxy script URLs; worker `fetch` and `importScripts` are routed through runtime APIs; service worker registration is rejected; rewritten worker code receives the runtime membrane helpers it may reference; and blob/data worker scripts that cannot be rewritten synchronously fail closed. | Worker XHR, WebSocket, EventSource, WebRTC/WebTransport, device APIs, full module-worker semantics, and worklet behavior are not full browser emulations. |
| Dynamic HTML and script insertion | Initial documents use the Go tokenizer transform. Dynamic script element `src` mutations are laundered through `/__zp/api/script`; dynamic HTML sinks are transformed conservatively before insertion. | Dynamic HTML transformation is not a second full tokenizer pass; script-heavy fragments, inline handler edge cases, and malformed markup can behave differently from the browser parser. |
| Cookies, storage, and cache APIs | The Go kernel cookie jar owns target request cookies and `Set-Cookie`; runtime `document.cookie` mirrors non-HttpOnly cookies through the Service Worker bridge. `localStorage` and `sessionStorage` are in-memory facades; IndexedDB and CacheStorage are namespaced by prefix. | SameSite, `credentials`, storage events, quota/persistence, encrypted IndexedDB state, and full reconciliation across runtime/SW/kernel state are not complete. |
| Headers, CSP, and subresources | Target CSP, reporting, Alt-Svc, Link, Refresh, Set-Cookie constructor exposure, hop-by-hop headers, and transformed-body length/encoding headers are stripped before browser `Response` construction. Static preload/prefetch/preconnect/dns-prefetch/prerender/manifest links are removed; dynamic blocked link elements keep inert `data-zp-blocked-*` metadata without active `rel`/`href`; ping, object, and embed are removed or replaced. Script `integrity` is moved to `data-zp-integrity`. | PWA manifests, SRI enforcement, preload performance, HTTP/3/QUIC upgrade hints, object/embed content, target-controlled CSP behavior, and some reporting/security integrations will differ from the target site in a native browser. |
| Context recovery | The Service Worker recovers target context from client id, referrer, resource-context cache, and in-memory route state; when no context exists it may fall back to the first in-memory tab. | Multi-tab, no-referrer, popup, and detached-resource edge cases need dedicated compatibility coverage to avoid routing under the wrong virtual base or cookie context. |

## Implementation assessment

Overall status: **Prototype / partial implementation**. The repository implements the primary architecture spine and many security-critical primitives, but it is not yet complete enough to treat as an accepted high-assurance browsing engine. `PHASE3_PLAN.md` is the current cutover plan for route-prefix consolidation, strict script compatibility, navigation integrity, stealth membrane coverage, and `WebSocketStream` compatibility.

| Area | Current status | Evidence / gap |
|---|---|---|
| Top-level document model | Partial | Target pages render as top-level proxy-origin documents; encrypted `/p` route activation, AES-CBC+HMAC share envelope, limited runtime self-fingerprint masking, strict `connect-src`, direct-egress browser E2E coverage for current wrappers, and synchronous iframe clean-realm containment are present. Broader adversarial coverage is still required. |
| System goals | Partial | Client memory state, unknown-request blocking, Tor/yamux/uTLS path, and safe errors exist. Encrypted IndexedDB persistence and full escape-vector coverage are absent. |
| Overall architecture | Mostly implemented | Static shell, Service Worker, Go WASM kernel, relay WebSocket pipe, yamux, SOCKS5, uTLS, HTTP/2 and HTTP/1.1 fetch, HTML transform, cookie jar, and runtime prelude exist. |
| URL and encryption | Implemented | `web/zp-core.js` and `internal/shareurl` implement HKDF, AES-256-CBC, HMAC verification-before-decrypt, raw base64url, and protocol allowlists. Tests cover JS tamper rejection and Go envelope construction. |
| Active URL and tab state | Partial | Active browsing uses encrypted `/p` routes. Tab/entry maps are in memory; title/state clone/origin map/storage namespace behavior is minimal; persistence is absent. The single `/zp/` controlled-prefix cutover is planned but not implemented in this snapshot. |
| Service Worker boot | Mostly implemented | The shell waits for Service Worker control; `sw.js` tracks readiness and waits for `__go_jshttp`, `__zp_stream`, and `__zp_kernel_init`. |
| Fetch handler policy | Mostly implemented | `sw.js` classifies internal/share/runtime/subresource/unknown requests and has no `return fetch(event.request)` fallback. Privileged runtime `postMessage` operations require a per-tab capability token. Subresource base recovery is simple and should be browser-tested. |
| Go WASM transport kernel | Mostly implemented | The kernel opens `/__zp/ws-pipe`, uses yamux streams, SOCKS5 DOMAINNAME CONNECT, uTLS, HTTP/2 when ALPN selects `h2`, and HTTP/1.1 fallback. Target WebSocket upgrade/framing exists and remains HTTP/1.1-only. Target response bodies are exposed to JavaScript through `ReadableStream`; request/upload body conversion is still prototype-level. |
| HTML transform | Partial | Tokenizer-based transform injects the runtime prelude, removes base/meta refresh/ping/static preload hints, rewrites document navigation attrs to encrypted `/p` routes, proxies external scripts through `/__zp/api/script`, rewrites inline scripts/event handlers through the Service Worker OXC rewriter when running in the Go WASM kernel, handles `srcdoc`, and blocks object/embed. Runtime dynamic HTML sinks preserve blocked preload/preconnect link node shape but remove active `rel`/`href`. Malformed-markup recovery and direct navigation attributes need stronger proof. |
| Tor stream isolation | Implemented at code level | `zpiso.Token` derives site-granular HMAC tokens; SOCKS5 rejects IP literals and sends DOMAINNAME ATYP. Deployment still requires correctly configured Tor. |
| Response header policy | Implemented | `internal/headers` strips target CSP, cookies, reporting, Alt-Svc, Link, Refresh, Location, hop-by-hop headers, transformed lengths/encoding, and defaults to `Cache-Control: no-store`. |
| CSP | Mostly implemented | The shell and server apply strict proxy-origin CSP headers. The server's `zeroCSP` and `web/zp-core.js` both restrict `connect-src` to `'self'` plus the proxy WebSocket origin; target responses no longer permit `connect-src *`. Script CSP still carries temporary compatibility exceptions for inline bootstrap and OXC/WASM initialization. |
| Runtime prelude | Partial | Main-window fetch/XHR/EventSource/WebSocket/sendBeacon, navigation/form/history/location, storage, worker, iframe, device blockers, basic patched-function/Canvas/Audio/speech masking, synchronous iframe containment, runtime membrane helpers, scoped `Function`/`eval`/string-timer dynamic compilation wrappers, and dynamic HTML/event-handler neutralization hooks exist. XHR/EventSource/WebSocket and fingerprinting-surface fidelity remain prototype-level, and direct `location.href` defense relies on layered CSP/SW enforcement where descriptors cannot be replaced. |
| Worker containment | Partial | Worker/SharedWorker constructors, data/blob workers, service worker registration blocking, worklet addModule wrapping, worker script URL recovery from module/proxy URLs, worker `fetch`/`importScripts` bridging, worker-side runtime membrane helpers, and worker prelude exist. Worker APIs are not all routed with browser-native fidelity; several are blocked. |
| Dynamic iframe containment | Partial | Iframe creation/insertion/src/srcdoc hooks and synchronous `contentWindow`/`contentDocument` containment exist for clean about:blank realms. Broader browser coverage is still needed for adversarial descriptor and navigation edge cases. |
| History/location | Partial | `pushState`, `replaceState`, `popstate`, scroll restore, bound `location.assign`/`replace` navigation helpers, click-time navigation capture, and best-effort getter masking are present. Native `window.location` cannot be fully spoofed to another origin in a standard same-origin proxy document, so browser descriptor edge cases need E2E coverage. |
| Cookie jar | Mostly implemented | Go jar stores `Set-Cookie`, excludes HttpOnly from `document.cookie`, enforces path/domain/secure, and projects cookies onto target requests. Runtime document.cookie has a lightweight parallel model and should be reconciled with the Go jar behavior. |
| Safe error pages | Mostly implemented | Required error class names and safe HTML pages exist in core, Service Worker, kernel, and server. Error mapping is coarse and should be made more precise. |
| Successor review coverage | Not complete | Source/unit tests cover selected invariants, and browser E2E covers dynamic iframe containment, basic fingerprint masking, OXC-rewritten virtual location reads, direct-egress fetch/XHR/EventSource/WebSocket fixtures, dynamic script laundering, module-script worker bootstrap, inert dynamic preload/preconnect link handling, blob/data worker blocking, form/cookie/stream/WebSocket integrations, forged Service Worker messages, and `/p` navigation. Broader adversarial browser compatibility remains prototype-level. |

### Current implementation choices before the cutover

- Active and shared document routes currently stay on encrypted `/p` paths.
- Static HTML navigation laundering calls `internal/shareurl.New`, so links/forms/frames become fresh encrypted `/p` share routes.
- The injected topbar/virtual address bar was intentionally removed; `internal/htmltx/topbar.go` documents that target pages stay on `/p` routes while runtime getters mask target location values.
- Target responses no longer emit `connect-src *`; continued `'unsafe-eval'` / `'wasm-unsafe-eval'` is a compatibility exception for inline bootstrap and OXC/WASM initialization.
- Target response bodies stream into JavaScript `Response` objects, but request/upload body handling, broader dynamic iframe edge cases, encrypted IndexedDB persistence, and required browser E2E escape tests are not acceptance-grade.

## Verification surface

The repository's automated CI is `.github/workflows/ci.yml`.

CI triggers:

- push to `main`;
- pull request;
- manual `workflow_dispatch`.

CI environment and gates:

- Ubuntu 24.04 LTS GitHub-hosted runner.
- Go installed from `go.mod` through `actions/setup-go`.
- Current Node.js LTS through `actions/setup-node`.
- `npm ci`, including Puppeteer's pinned Chrome for Testing.
- `go test ./...`.
- `npm test`, via `scripts/test.mjs`, which runs `test/js/*.test.js` and `test/e2e/proxy.test.js`.
- `npm run build`, which bundles browser assets, copies generated WASM support files into `dist/web`, builds `dist/kernel.wasm`, and builds the relay server.

The Puppeteer E2E test does not require Tor. It builds temporary ZeroProxy artifacts through `scripts/build.mjs`, starts a local target HTTP server, starts the relay with `-socks internal`, launches Chrome against `proxy.localhost`, and verifies that proxied navigation stays on `/p` routes while target HTTP requests carry the configured Windows Chrome User-Agent. It covers the relay's internal SOCKS5 parser/direct dialer, dynamic script laundering for GTM-style insertion, module-script worker bootstrap through `/__zp/worker-bootstrap.js` and `/__zp/api/worker-script`, inert dynamic preload/preconnect link handling, compound location/hash assignments, iframe postMessage delivery, dynamic srcdoc non-escape behavior, synchronous dynamic-iframe containment, form/cookie/stream/WebSocket integrations, and basic runtime fingerprint-masking invariants.

Equivalent local commands:

```sh
npm ci
go test ./...
npm test
npm run build
```

These checks prove unit/source policy coverage, buildability, and one local browser path through the WebSocket/yamux/SOCKS5 transport when they pass. They do not start Tor, validate real Tor deployment behavior, prove production traffic compatibility, or satisfy every high-assurance browser E2E non-escape matrix item listed below.

## Current acceptance boundary

Treat the implementation as a working prototype until all of these are satisfied:

1. Browser E2E tests prove that target pages cannot escape through dynamic iframes, workers, direct navigation, native WebSocket, WebRTC, WebTransport, device APIs, forms, or unclassified subresources.
2. Broader adversarial iframe descriptor, navigation, and nested-realm edge cases are browser-tested beyond the current clean about:blank coverage.
3. Runtime wrapper behavior is hardened for expected browser API fidelity, especially XHR, WebSocket close/error semantics, EventSource streaming, FormData/file uploads, and descriptor edge cases.
4. Request/upload body streaming, cancellation, and backpressure semantics are hardened where required.
5. Cookie, storage, and history semantics are reconciled across runtime state, Service Worker state, and Go kernel state.
6. Deployment tests run against a Tor daemon configured with `SocksPort 127.0.0.1:9050 IsolateSOCKSAuth`.
