# ZeroProxy

ZeroProxy is a client-owned virtual browsing prototype that runs target pages on the proxy origin without a browser extension. Its design goal is that target-site HTTP, TLS, and WebSocket traffic leaves only through this path:

```text
Service Worker -> Go WASM kernel -> WebSocket/yamux -> Tor SOCKS5 -> uTLS -> HTTP/1.1
```

The relay server terminates only the browser WebSocket/yamux pipe. Target HTTP parsing, redirects, cookies, header policy, HTML rewriting, and target WebSocket framing are owned by the Go WASM kernel and browser-side runtime.

## Status

Status: **Phase 0 prototype / partial implementation**.

Implemented core spine:

- Encrypted active/share route format: `/p/<encrypted>#k=<key>`.
- AES-256-CBC + HMAC-SHA256 URL envelope with HKDF-separated encryption/MAC keys and HMAC verification before decryption.
- Service Worker request classifier that handles every controlled request and blocks unknown requests instead of falling back to native `fetch(event.request)`.
- Go WASM exports: `__go_jshttp`, `__zp_stream`, `__zp_kernel_init`, and `__zp_cookie_set`.
- A single browser WebSocket pipe carrying yamux streams to the relay server, then Tor SOCKS5 DOMAINNAME CONNECT, uTLS for HTTPS, and direct HTTP/1.1 request/response handling.
- Tokenizer-based HTML transform that injects the runtime prelude, launders document navigation URLs through encrypted `/p` routes, drops dangerous tags and headers, and handles `srcdoc`.
- Runtime prelude hooks for `fetch`, XHR, WebSocket, EventSource, `sendBeacon`, navigation, forms, history/location masking, storage facades, workers, iframes, and high-risk device/network APIs.
- Relay server static asset service and `/__zp/ws-pipe` WebSocket endpoint.
- Go and JavaScript share URL implementations that use the same envelope format.

Not complete enough for production or high-assurance acceptance:

- Browser E2E tests do not yet prove dynamic iframe, worker, direct navigation, native WebSocket, WebRTC/WebTransport, device API, form, and unclassified subresource non-escape.
- Dynamic iframe clean-realm containment is still weaker than the synchronous hardening required for acceptance.
- Runtime API compatibility is prototype-level for XHR, WebSocket, EventSource, uploads, and descriptor edge cases.
- JavaScript `Response` construction still buffers target bodies instead of streaming all responses end-to-end.
- Encrypted IndexedDB persistence is not implemented.
- Tor daemon deployment and real Tor-egress E2E validation are not included in this repository.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the implementation map and acceptance boundary.

## Requirements

- Go toolchain matching `go.mod`.
- Node.js for the JavaScript tests.
- A Tor SOCKS5 listener configured with stream isolation.

Example Tor setting:

```text
SocksPort 127.0.0.1:9050 IsolateSOCKSAuth
```

## Run locally

Build the WASM kernel and start the relay server:

```sh
GOOS=js GOARCH=wasm go build -o bin/kernel.wasm ./cmd/wasm-kernel
go run ./cmd/zeroproxy-server -addr :8080 -kernel bin/kernel.wasm -socks 127.0.0.1:9050
```

Open the browser shell on the proxy origin:

```text
http://proxy.localhost:8080/
```

The shell accepts only `http:` and `https:` targets. It creates an encrypted `/p/<encrypted>#k=<key>` route and then removes the fragment before activating the route with the Service Worker.

## Verification commands

```sh
go test ./...
npm test
GOOS=js GOARCH=wasm go build -o /tmp/zeroproxy-kernel.wasm ./cmd/wasm-kernel
go build -o /tmp/zeroproxy-server ./cmd/zeroproxy-server
```

These checks cover source/unit policy invariants and buildability. They do not prove browser E2E non-escape, Tor deployment behavior, or production traffic compatibility.

## Repository map

| Path | Purpose |
|---|---|
| `web/index.html`, `web/zp-core.js` | Browser shell, shared URL encryption/decryption, fixed CSP helper. |
| `web/sw.js` | Service Worker classifier, in-memory tab state, runtime API bridge, WASM kernel calls. |
| `web/runtime-prelude.js`, `web/worker-prelude.js` | Target-realm containment hooks and worker bootstrap. |
| `cmd/wasm-kernel` | Go WASM transport kernel exposed to the Service Worker. |
| `cmd/zeroproxy-server` | Static asset server and WebSocket/yamux-to-Tor relay. |
| `internal/http1`, `internal/socks5`, `internal/utlskernel`, `internal/wsproto`, `internal/yamuxconn`, `internal/wsconn` | Target transport path. |
| `internal/htmltx`, `internal/headers`, `internal/cookiejar`, `internal/shareurl`, `internal/zpiso` | HTML rewriting, response header policy, cookie handling, share URL envelope, Tor isolation tokens. |
| `test/js`, `internal/*/*_test.go` | JavaScript source-policy tests and Go unit tests. |
