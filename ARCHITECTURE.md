# ZeroProxy Architecture

Assessment basis: `PLAN.md` and the current repository implementation as of 2026-05-25.

ZeroProxy is a client-owned virtual browsing prototype. The browser renders target pages as same-origin proxy documents, while target HTTP/TLS/WebSocket traffic is intended to leave only through the controlled transport stack below:

```text
Browser top-level target document
  ├─ /sw.js Service Worker
  │   ├─ request classifier for every controlled fetch
  │   ├─ in-memory tab/history/context state
  │   ├─ encrypted /p route activation
  │   └─ Go WASM kernel exports
  │       ├─ __go_jshttp(request)      -> target HTTP/1.1 fetch
  │       ├─ __zp_stream(options)      -> target WebSocket stream
  │       ├─ __zp_kernel_init()        -> transport readiness
  │       └─ __zp_cookie_set(request)  -> document.cookie bridge
  ├─ /__zp/runtime-prelude.js
  │   ├─ fetch / XHR / WebSocket / EventSource / sendBeacon wrappers
  │   ├─ navigation, form, history, location, and getter masking hooks
  │   ├─ storage namespace facades
  │   ├─ worker and iframe containment hooks
  │   └─ WebRTC/WebTransport/device API blocking stubs
  └─ transformed target HTML as the top-level document

Proxy origin server
  ├─ static assets: /, /sw.js, /__zp/*, /__zp/kernel.wasm
  └─ /__zp/ws-pipe WebSocket endpoint
      └─ yamux server session
          └─ per-stream byte bridge to Tor SOCKS5
              └─ Tor circuit -> target host
```

The relay server terminates only the browser WebSocket and yamux session. It dials only the configured Tor SOCKS5 listener and does not parse target HTTP, TLS, redirects, cookies, or HTML. Those responsibilities live in the Go WASM kernel and browser runtime.

## Core invariants

- Target document navigations use encrypted `/p/<encrypted>#k=<key>` routes on the proxy origin.
- The `#k` fragment is decrypted in the browser shell, removed with `history.replaceState`, and not sent to the server.
- Every Service Worker-controlled request is classified. Unknown requests are blocked; there is no native `fetch(event.request)` fallback.
- Target TCP connections are opened through WebSocket -> yamux -> Tor SOCKS5 DOMAINNAME. The kernel does not call `http.Transport` for target egress.
- HTTPS uses uTLS over the Tor stream with HTTP/1.1 selected.
- Target response headers are passed through a constructor policy before the browser receives a `Response`.
- Runtime code does not install anti-bot deception hooks such as `Function.prototype.toString` masking.

## Main components

| Area | Files | Responsibility |
|---|---|---|
| Static shell | `web/index.html`, `web/zp-core.js` | Service Worker registration, target URL canonicalization, share URL encryption/decryption, initial target open. |
| Share URL envelope | `web/zp-core.js`, `internal/shareurl/*` | Compatible JavaScript and Go implementations of `/p/<encrypted>#k=<key>` using AES-256-CBC, HMAC-SHA256, HKDF, and raw base64url. |
| Service Worker | `web/sw.js` | Classifies every controlled request, blocks unknowns, manages in-memory tab/entry state, calls the WASM kernel, exposes runtime bridge APIs. |
| Runtime prelude | `web/runtime-prelude.js`, `web/worker-prelude.js` | Installs target-realm wrappers and containment hooks before target scripts run. |
| WASM kernel | `cmd/wasm-kernel/main.go`, `internal/swhttp/*` | Converts JS `Request`/`Response`, initializes transport, owns target HTTP and WebSocket execution. |
| Transport | `internal/wsconn/*`, `internal/yamuxconn/*`, `internal/socks5/*`, `internal/utlskernel/*`, `internal/http1/*`, `internal/wsproto/*` | Browser WebSocket `net.Conn`, yamux streams, SOCKS5 DOMAINNAME CONNECT, uTLS, HTTP/1.1, target WebSocket upgrade/framing. |
| HTML/header/cookie policy | `internal/htmltx/*`, `internal/headers/*`, `internal/cookiejar/*`, `internal/zpiso/*` | HTML transformation, safe response header constructor policy, target cookie jar, Tor isolation token derivation. |
| Relay server | `cmd/zeroproxy-server/main.go` | Serves assets and bridges yamux streams to the configured Tor SOCKS5 address. |

## Request flow

1. The shell registers `/sw.js`, waits for a controller, canonicalizes an `http:` or `https:` target, encrypts it, and navigates to `/p/<encrypted>#k=<key>` on the proxy origin.
2. The shell loaded on `/p/<encrypted>#k=<key>` decrypts the fragment key in window context, validates the HMAC before decryption, removes `#k` with `history.replaceState`, and sends `ZP_OPEN_SHARE` to the Service Worker.
3. The Service Worker stores the decrypted target in in-memory tab/entry maps and activates `/p/<encrypted>` as a proxy document route.
4. A `/p/<encrypted>` document request is resolved back to the target URL. The Service Worker calls `__go_jshttp` with `X-ZP-*` internal metadata.
5. The WASM kernel ensures one long-lived WebSocket connection to `/__zp/ws-pipe`, wraps it in a yamux client, and opens one yamux stream per target TCP connection.
6. Each target connection performs SOCKS5 `CONNECT` with DOMAINNAME ATYP and a Tor `IsolateSOCKSAuth` username derived from the tab stream-isolation key and target site.
7. HTTPS targets run uTLS over that stream with ALPN pinned to `http/1.1`.
8. `internal/http1` writes an HTTP/1.1 request directly and reads the target response with `http.ReadResponse`.
9. Redirects are followed inside the kernel so raw `Location` headers are not exposed to browser code.
10. HTML document responses are transformed: runtime prelude is injected, document navigation URLs are rewritten to encrypted `/p/<encrypted>#k=<key>` routes, risky tags and headers are removed, and the browser receives a same-origin `Response` with ZeroProxy CSP.

## Shared URL flow

Shared links use this envelope:

```text
/p/<base64url(iv || AES-256-CBC(ciphertext) || HMAC-SHA256 tag)>#k=<base64url 64-byte seed>
```

`web/zp-core.js` and `internal/shareurl` derive separate HKDF-SHA256 AES-CBC and HMAC keys from the 64-byte seed. The MAC covers a fixed version prefix, IV, and ciphertext. Decryption verifies HMAC first, then decrypts and canonicalizes the target URL. Only `http:` and `https:` targets are accepted for document/fetch traffic; WebSocket wrappers accept only `ws:` and `wss:`.

The Go HTML transformer uses `internal/shareurl.New` when laundering document-navigation attributes, so transformed links/forms/frames keep using encrypted `/p` routes instead of legacy virtual URL paths.

## Service Worker classification

`web/sw.js` calls `event.respondWith(handleFetch(event))` for every fetch event. Classification currently distinguishes:

- internal assets under `/`, `/sw.js`, and `/__zp/*`;
- activated encrypted `/p/<route>` proxy documents;
- runtime APIs under `/__zp/api/*`;
- virtual subresources with an existing client or referrer context;
- unknown requests, which are blocked with a safe error page for navigations or `Response.error()` for subresources.

The Service Worker keeps tab, entry, client-context, route, and stream maps in memory. It tracks active entries, scroll positions, and a document-cookie bridge, but does not persist encrypted state to IndexedDB.

## Transport and HTTP behavior

The Go WASM kernel exposes `__zp_kernel_init`, `__go_jshttp`, `__zp_stream`, and `__zp_cookie_set` to the Service Worker. Initialization creates a WebSocket to `/__zp/ws-pipe` and a yamux client session. Per-target connections open yamux streams that the relay server bridges to Tor SOCKS5.

`internal/http1` builds target HTTP/1.1 requests directly, applies the cookie jar, follows redirects up to `MaxRedirects`, and closes target connections through response body closure. HTTPS uses `internal/utlskernel`; target WebSocket support is implemented through `internal/wsproto` and the runtime `WebSocket` wrapper.

Current limitation: `internal/swhttp.ResponseToJS` reads the full target body before constructing the JavaScript `Response`. HTML document transformation also reads the full document body. This is correct for the prototype but is not full end-to-end streaming.

## HTML, header, and runtime policy

`internal/htmltx` uses `golang.org/x/net/html` tokenization. It injects `zp-core.js`, a `__ZP_BOOT` object, and `runtime-prelude.js`; removes base/meta refresh/ping/preload-style escape vectors; rewrites document navigation attributes; injects prelude code into `srcdoc`; and replaces blocked embed/object content with inert placeholders.

`internal/headers.ConstructorPolicy` strips target-controlled policy, storage, network-control, hop-by-hop, redirect, and transformed-body headers before constructing a browser `Response`. It defaults cache behavior to `Cache-Control: no-store`.

`web/runtime-prelude.js` installs hooks for high-risk browser APIs from inside the target realm. It routes `fetch`, XHR, WebSocket, EventSource, and `sendBeacon` through Service Worker runtime APIs; rewrites navigations and forms; masks location/history getters; provides storage facades; wraps Worker and SharedWorker constructors; blocks service worker registration and high-risk device/network APIs; and attempts iframe containment.

Current limitation: dynamic iframe hardening is not yet the synchronous clean-realm containment required for acceptance. Some paths instrument iframes after creation or insertion, which leaves a high-risk gap that must be closed or proven blocked by browser E2E tests.

## Plan implementation assessment

Overall status: **Phase 0 prototype / partial implementation**. The repository implements the primary architecture spine and many security-critical primitives from `PLAN.md`, but it is not yet complete enough to treat as an accepted high-assurance browsing engine.

| PLAN.md section | Current status | Evidence / gap |
|---|---|---|
| 0. Correction directives | Mostly implemented | Top-level target document, encrypted `/p` route shape, AES-CBC+HMAC share envelope, fixed CSP, and no anti-bot spoofing hooks are present. Browser direct-egress prevention still needs E2E proof. |
| 1. System goals | Partial | Client memory state, unknown-request blocking, Tor/yamux/uTLS path, and safe errors exist. Encrypted IndexedDB persistence and full escape-vector coverage are absent. |
| 2. Overall architecture | Mostly implemented | Static shell, Service Worker, Go WASM kernel, relay WebSocket pipe, yamux, SOCKS5, uTLS, HTTP/1.1, HTML transform, cookie jar, and runtime prelude exist. |
| 3. URL and encryption | Implemented | `web/zp-core.js` and `internal/shareurl` implement HKDF, AES-256-CBC, HMAC verification-before-decrypt, raw base64url, and protocol allowlists. Tests cover JS tamper rejection and Go envelope construction. |
| 4. Active URL and tab state | Partial | Active browsing uses encrypted `/p` routes and static tests reject legacy `/v` route generation. Tab/entry maps are in memory; title/state clone/origin map/storage namespace behavior is minimal; persistence is absent. |
| 5. Service Worker boot | Mostly implemented | The shell waits for Service Worker control; `sw.js` tracks readiness and waits for `__go_jshttp`, `__zp_stream`, and `__zp_kernel_init`. |
| 6. Fetch handler policy | Mostly implemented | `sw.js` classifies internal/share/runtime/subresource/unknown requests and has no `return fetch(event.request)` fallback. Subresource base recovery is simple and should be browser-tested. |
| 7. Go WASM transport kernel | Mostly implemented | The kernel opens `/__zp/ws-pipe`, uses yamux streams, SOCKS5 DOMAINNAME CONNECT, uTLS, and direct HTTP/1.1. Target WebSocket upgrade/framing exists. HTTP responses are currently buffered before JS `Response` construction. |
| 8. HTML transform | Partial | Tokenizer-based transform injects the runtime prelude, removes base/meta refresh/ping/preload hints, rewrites document navigation attrs to encrypted `/p` routes, handles `srcdoc`, and blocks object/embed. Malformed-markup recovery still needs stronger proof. |
| 9. Tor stream isolation | Implemented at code level | `zpiso.Token` derives site-granular HMAC tokens; SOCKS5 rejects IP literals and sends DOMAINNAME ATYP. Deployment still requires correctly configured Tor. |
| 10. Response header policy | Implemented | `internal/headers` strips target CSP, cookies, reporting, Alt-Svc, Link, Refresh, Location, hop-by-hop headers, transformed lengths/encoding, and defaults to `Cache-Control: no-store`. |
| 11. Phase 0 CSP | Implemented | Server, Service Worker, and core helper generate the fixed Phase 0 CSP with strict `connect-src`, `form-action`, and `navigate-to`. |
| 12. Runtime prelude | Partial | Fetch/XHR/WebSocket/EventSource/sendBeacon, navigation/form/history/location, storage, worker, iframe, and device blockers exist. XHR/EventSource/WebSocket fidelity is prototype-level, and direct `location.href` defense relies on layered CSP/SW enforcement where descriptors cannot be replaced. |
| 13. Worker containment | Partial | Worker/SharedWorker constructors, data/blob workers, service worker registration blocking, worklet addModule wrapping, and worker prelude exist. Worker APIs are not all routed with browser-native fidelity; several are blocked. |
| 14. Dynamic iframe containment | Partial / high risk | Iframe creation/insertion/src/srcdoc hooks and about:blank containment exist, but clean about:blank realm hardening is not yet synchronous enough for acceptance. |
| 15. History/location | Partial | `pushState`, `replaceState`, `popstate`, scroll restore, location assign/replace, and getter masking are present. Browser descriptor edge cases need E2E coverage. |
| 16. Cookie jar | Mostly implemented | Go jar stores `Set-Cookie`, excludes HttpOnly from `document.cookie`, enforces path/domain/secure, and projects cookies onto target requests. Runtime document.cookie has a lightweight parallel model and should be reconciled with the Go jar behavior. |
| 17. Safe error pages | Mostly implemented | Required error class names and safe HTML pages exist in core, Service Worker, kernel, and server. Error mapping is coarse and should be made more precise. |
| 18. Mandatory successor review | Not complete | Source/unit tests cover selected invariants, but required browser E2E bypass tests for dynamic iframes, workers, direct navigation, and native escape vectors have not been implemented. |

## Verification surface

Current repository checks:

```sh
go test ./...
npm test
GOOS=js GOARCH=wasm go build -o /tmp/zeroproxy-kernel.wasm ./cmd/wasm-kernel
go build -o /tmp/zeroproxy-server ./cmd/zeroproxy-server
```

These checks prove unit/source policy coverage and buildability when they pass. They do not prove browser E2E non-escape, Tor deployment behavior, or production traffic compatibility.

## Current acceptance boundary

Treat the implementation as a working Phase 0 prototype until all of these are satisfied:

1. Browser E2E tests prove that target pages cannot escape through dynamic iframes, workers, direct navigation, native WebSocket, WebRTC, WebTransport, device APIs, forms, or unclassified subresources.
2. Iframe instrumentation is made synchronous for clean about:blank realms or those iframes are blocked before target script regains control.
3. Runtime wrapper behavior is hardened for expected browser API fidelity, especially XHR, WebSocket close/error semantics, EventSource streaming, FormData/file uploads, and descriptor edge cases.
4. Target response streaming to JavaScript `Response` is implemented where required instead of full buffering.
5. Cookie, storage, and history semantics are reconciled across runtime state, Service Worker state, and Go kernel state.
6. Deployment tests run against a Tor daemon configured with `SocksPort 127.0.0.1:9050 IsolateSOCKSAuth`.
