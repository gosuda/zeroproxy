# ZeroProxy Architecture

기준: `PLAN.md`와 현재 저장소 구현을 2026-05-24에 대조했다.

ZeroProxy는 사용자가 설치 없이 브라우저에서 실행하는 클라이언트 보유형 가상 브라우징 엔진이다. 목표는 대상 사이트로 향하는 HTTP/TLS/WebSocket 트래픽을 브라우저의 직접 네트워크 경로가 아니라 다음 경로로만 내보내는 것이다.

```text
Browser top-level target document
  ├─ /sw.js Service Worker
  │   ├─ request classifier
  │   ├─ in-memory tab/history state
  │   ├─ share-link gate
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

The relay server terminates only the browser WebSocket and yamux session. Target TLS, HTTP parsing, redirects, cookies, header policy, and HTML rewriting are implemented in the Go WASM kernel. The relay dials only the configured Tor SOCKS5 listener and does not parse target HTTP/TLS.

## Main components

| Area | Files | Responsibility |
|---|---|---|
| Static shell | `web/index.html`, `web/zp-core.js` | Service Worker registration, share URL encryption/decryption, initial target open. |
| Service Worker | `web/sw.js` | Classifies every controlled request, blocks unknowns, manages in-memory tab state, calls WASM kernel, exposes runtime bridge APIs. |
| Runtime prelude | `web/runtime-prelude.js`, `web/worker-prelude.js` | Installs target-realm wrappers and containment hooks before target scripts run. |
| WASM kernel | `cmd/wasm-kernel/main.go`, `internal/swhttp/*` | Converts JS `Request`/`Response`, initializes transport, owns target HTTP/WebSocket execution. |
| Transport | `internal/wsconn/*`, `internal/yamuxconn/*`, `internal/socks5/*`, `internal/utlskernel/*`, `internal/http1/*`, `internal/wsproto/*` | Browser WebSocket net.Conn, yamux streams, SOCKS5 DOMAINNAME CONNECT, uTLS, HTTP/1.1, target WebSocket upgrade/framing. |
| HTML/header/cookie policy | `internal/htmltx/*`, `internal/headers/*`, `internal/cookiejar/*`, `internal/zpiso/*` | HTML transformation, safe response header constructor policy, target cookie jar, Tor isolation token derivation. |
| Relay server | `cmd/zeroproxy-server/main.go` | Serves assets and bridges yamux streams to the configured Tor SOCKS5 address. |

## Request flow

1. The bridge shell registers `/sw.js`, waits for a controller, encrypts a canonical `http:` or `https:` target, and navigates to the proxy origin at `/p/<encrypted>#k=<key>`.
2. The proxy-origin shell decrypts `#k` in the window context, removes the fragment with `history.replaceState`, and registers the `/p/<encrypted>` route with the Service Worker.
3. `/p/<encrypted>` is resolved back to the target URL in the Service Worker. It calls `__go_jshttp` with `X-ZP-*` internal metadata.
4. The WASM kernel ensures one long-lived WebSocket connection to `/__zp/ws-pipe`, wraps it in a yamux client, and opens one yamux stream per target TCP connection.
5. Each target connection performs SOCKS5 `CONNECT` with DOMAINNAME ATYP and a Tor `IsolateSOCKSAuth` username derived from the tab stream-isolation key and target site.
6. HTTPS targets run uTLS over that stream with ALPN pinned to `http/1.1`.
7. `internal/http1` writes an HTTP/1.1 request directly and reads the target response with `http.ReadResponse`; it does not use `http.Transport` for target egress.
8. Redirects are followed inside the kernel so raw `Location` headers are not exposed to browser code.
9. HTML document responses are transformed: runtime prelude is injected, document navigation URLs are laundered to `/p/<encrypted>#k=<key>`, risky tags/headers are removed, and the browser receives a same-origin `Response` with ZeroProxy CSP.

## Shared URL flow

Shared links use the corrected `PLAN.md` envelope:

```text
/p/<base64url(iv || AES-256-CBC(ciphertext) || HMAC-SHA256 tag)>#k=<base64url 64-byte seed>
```

`web/zp-core.js` derives separate HKDF-SHA256 AES-CBC and HMAC keys, verifies HMAC before decrypting, canonicalizes the target URL, and allows only `http:` and `https:`. `web/index.html` removes `#k` with `history.replaceState` before activating the `/p/<encrypted>` route.

## Plan implementation assessment

Overall status: **Phase 0 prototype / partial implementation**. The repository implements the primary architecture spine and many security-critical primitives from `PLAN.md`, but it is not yet complete enough to treat as an accepted high-assurance browsing engine. The largest remaining gaps are browser end-to-end bypass tests, clean-realm iframe hardening, and production-grade runtime API fidelity.

| PLAN.md section | Current status | Evidence / gap |
|---|---|---|
| 0. Correction directives | Mostly implemented | Top-level target document, `/p` route shape, AES-CBC+HMAC share envelope, fixed CSP, and no anti-bot spoofing hooks are present. Browser direct egress prevention is implemented by classifier/runtime/kernel structure but still needs browser E2E proof. |
| 1. System goals | Partial | Client memory state, unknown-request blocking, Tor/yamux/uTLS path, and safe errors exist. No encrypted IndexedDB persistence; runtime and clean-realm escape coverage is incomplete. |
| 2. Overall architecture | Mostly implemented | Static shell, Service Worker, Go WASM kernel, relay WebSocket pipe, yamux, SOCKS5, uTLS, HTTP/1.1, HTML transform, cookie jar, and runtime prelude exist. |
| 3. URL and encryption | Implemented | `web/zp-core.js` implements HKDF, AES-256-CBC, HMAC verification-before-decrypt, raw base64url, and protocol allowlist; JS tests cover round-trip and HMAC tamper rejection. |
| 4. Active URL and tab state | Partial | `/p/<encrypted>` active routes are implemented with in-memory maps; legacy `/v` handling remains for pending form-navigation compatibility. Title/state clone/origin map/storage namespace behavior is minimal; persistence is absent. |
| 5. Service Worker boot | Mostly implemented | The shell waits for Service Worker control; `sw.js` has readiness states and waits for `__go_jshttp`, `__zp_stream`, and `__zp_kernel_init`. |
| 6. Fetch handler policy | Mostly implemented | `sw.js` calls `event.respondWith(handleFetch(event))` for every fetch, classifies internal/share/virtual/runtime/subresource/unknown, and has no `return fetch(event.request)` fallback. Subresource base recovery is simple and should be browser-tested. |
| 7. Go WASM transport kernel | Mostly implemented | The kernel opens `/__zp/ws-pipe`, uses yamux streams, SOCKS5 DOMAINNAME CONNECT, uTLS, and direct HTTP/1.1. Target WebSocket upgrade/framing exists. HTTP responses are currently buffered before JS `Response` construction, so streaming is not complete. |
| 8. HTML transform | Partial | Tokenizer-based transform injects the runtime prelude, removes base/meta refresh/ping/preload hints, rewrites document navigation attrs to `/p/<encrypted>#k=<key>`, handles `srcdoc`, and blocks object/embed. It does not yet provide full malformed-markup recovery proof. |
| 9. Tor stream isolation | Implemented at code level | `zpiso.Token` derives site-granular HMAC tokens; SOCKS5 rejects IP literals and sends DOMAINNAME ATYP. Requires a correctly configured Tor daemon in deployment. |
| 10. Response header policy | Implemented | `internal/headers` strips target CSP, cookies, reporting, Alt-Svc, Link, Refresh, Location, hop-by-hop headers, transformed lengths/encoding, and defaults to `Cache-Control: no-store`. |
| 11. Phase 0 CSP | Implemented | Server, Service Worker, and core helper generate the fixed Phase 0 CSP with strict `connect-src`, `form-action`, and `navigate-to`. |
| 12. Runtime prelude | Partial | Fetch/XHR/WebSocket/EventSource/sendBeacon, navigation/form/history/location, storage, worker, iframe, and device blockers exist. XHR/EventSource/WebSocket fidelity is prototype-level, and direct `location.href` defense relies on layered CSP/SW enforcement where descriptors cannot be replaced. |
| 13. Worker containment | Partial | Worker/SharedWorker constructors, data/blob workers, service worker registration blocking, worklet addModule wrapping, and worker prelude exist. Worker APIs are not all routed with browser-native fidelity; several are blocked. |
| 14. Dynamic iframe containment | Partial / high risk | Iframe creation/insertion/src/srcdoc hooks and about:blank containment exist, but `createElement` instrumentation uses a microtask and is not the synchronous hardening required by `PLAN.md` for clean-realm escape acceptance. |
| 15. History/location | Partial | `pushState`, `replaceState`, `popstate`, scroll restore, location assign/replace, and getter masking are present. Browser descriptor edge cases need E2E coverage. |
| 16. Cookie jar | Mostly implemented | Go jar stores `Set-Cookie`, excludes HttpOnly from `document.cookie`, enforces path/domain/secure, and projects cookies onto target requests. Runtime document.cookie has a lightweight parallel model and should be reconciled with the Go jar behavior. |
| 17. Safe error pages | Mostly implemented | Required error class names and safe HTML pages exist in core, SW, kernel, and server. Error mapping is coarse and should be made more precise. |
| 18. Mandatory successor review | Not complete | Source/unit tests cover selected invariants, but the required browser E2E bypass tests for dynamic iframes, workers, and direct navigation have not been implemented. |

## Verification observed

The following checks passed during this assessment:

```sh
go test ./...
npm test
GOOS=js GOARCH=wasm go build -o /tmp/zeroproxy-kernel.wasm ./cmd/wasm-kernel
go build -o /tmp/zeroproxy-server ./cmd/zeroproxy-server
```

These checks prove unit/source policy coverage and buildability. They do not prove browser E2E non-escape, Tor deployment behavior, or production traffic compatibility.

## Current acceptance boundary

The implementation should be treated as a working Phase 0 prototype until these conditions are satisfied:

1. Browser E2E tests prove that target pages cannot escape through dynamic iframes, workers, direct navigation, native WebSocket, WebRTC, WebTransport, device APIs, forms, or unclassified subresources.
2. Iframe instrumentation is made synchronous for clean about:blank realms or those iframes are blocked before target script regains control.
3. Runtime wrapper behavior is hardened for expected browser API fidelity, especially XHR, WebSocket close/error semantics, EventSource streaming, FormData/file uploads, and descriptor edge cases.
4. Target response streaming to JS `Response` is implemented where required instead of full buffering.
5. Cookie/storage/history semantics are reconciled across runtime state, Service Worker state, and Go kernel state.
6. Deployment tests run against a Tor daemon configured with `SocksPort 127.0.0.1:9050 IsolateSOCKSAuth`.
