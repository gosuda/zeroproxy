# ZeroProxy

ZeroProxy is a client-owned virtual browsing prototype that runs target pages on the proxy origin without a browser extension. Its design goal is that target-site HTTP, TLS, and WebSocket traffic leaves only through this path:

```text
Service Worker -> Go WASM kernel -> WebSocket/yamux -> Tor SOCKS5 -> uTLS -> HTTP/2 or HTTP/1.1
```

The relay server terminates only the browser WebSocket/yamux pipe. Target HTTP parsing, redirects, cookies, header policy, HTML rewriting, and target WebSocket framing are owned by the Go WASM kernel and browser-side runtime.

## Status

Status: **Phase 0 prototype / partial implementation**.

Implemented core spine:

- Encrypted active/share route format: `/p/<encrypted>#k=<key>`.
- AES-256-CBC + HMAC-SHA256 URL envelope with HKDF-separated encryption/MAC keys and HMAC verification before decryption.
- Service Worker request classifier that handles every controlled request and blocks unknown requests instead of falling back to native `fetch(event.request)`.
- Go WASM exports: `__go_jshttp`, `__zp_stream`, `__zp_kernel_init`, and `__zp_cookie_set`.
- A single browser WebSocket pipe carrying yamux streams to the relay server, then Tor SOCKS5 DOMAINNAME CONNECT, uTLS for HTTPS, HTTP/2 when ALPN selects `h2`, and HTTP/1.1 fallback/direct handling.
- Tokenizer-based HTML transform that injects the runtime prelude, launders document navigation URLs through encrypted `/p` routes, drops dangerous tags and headers, and handles `srcdoc`.
- Runtime containment for WebSocket, `sendBeacon`, navigation, forms, history/location masking, storage facades, workers, iframes, and high-risk device/network APIs. Main-window `fetch`, XHR, and EventSource currently rely on Service Worker interception rather than runtime polyfills; worker `fetch` is bridged through `/__zp/api/fetch`. The runtime also applies basic self-fingerprint masking for patched function source strings, Canvas/Audio extraction jitter, and speech voice lists; broad anti-bot spoofing is not a project goal.
- Relay server static asset service and `/__zp/ws-pipe` WebSocket endpoint.
- Go and JavaScript share URL implementations that use the same envelope format.

Not complete enough for production or high-assurance acceptance:

- Browser E2E tests cover the current iframe clean-realm and basic fingerprint-masking checks, but do not yet prove every worker, direct navigation, form, device API, and unclassified subresource non-escape path.
- Dynamic iframe containment is synchronous for `contentWindow`/`contentDocument` reads and common insertion APIs, but remains prototype-level and should keep gaining adversarial browser coverage.
- Main-window runtime API compatibility is prototype-level for fetch, XHR, EventSource, WebSocket, uploads, descriptor edge cases, and fingerprinting surface fidelity.
- Response bodies are streamed into JavaScript `Response` objects, but request/upload body handling and browser backpressure/cancellation behavior are still prototype-level.
- Encrypted IndexedDB persistence is not implemented.
- Tor daemon deployment and real Tor-egress E2E validation are not included in this repository.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the implementation map and acceptance boundary. See [`PHASE2_PLAN.md`](./PHASE2_PLAN.md) for the proposed Service Worker/SWC JavaScript rewriting phase.

## Requirements

- Go 1.26 or the Go toolchain version required by `go.mod`.
- Node.js LTS and npm for the JavaScript and Puppeteer E2E tests.
- A browser with Service Worker and WebAssembly support. CI uses Puppeteer's pinned Chrome for Testing.
- A Tor SOCKS5 listener configured with stream isolation for manual target browsing. CI uses an in-process test SOCKS5 proxy instead of Tor.

Example Tor setting:

```text
SocksPort 127.0.0.1:9050 IsolateSOCKSAuth
```

Start a local Tor listener for development:

```sh
mkdir -p /tmp/zeroproxy-tor
tor --SocksPort "127.0.0.1:9050 IsolateSOCKSAuth" --DataDirectory /tmp/zeroproxy-tor
```

Keep that process running and wait until Tor logs `Bootstrapped 100% (done)` before expecting target browsing to work. If Tor is managed by your OS service manager instead, use the same `SocksPort` setting in `torrc` and start the service before starting ZeroProxy.

## Build and run locally

Build the WASM kernel and relay server from the repository root:

```sh
mkdir -p bin
GOOS=js GOARCH=wasm go build -o bin/kernel.wasm ./cmd/wasm-kernel
go build -o bin/zeroproxy-server ./cmd/zeroproxy-server
```

Start the relay server in another terminal:

```sh
./bin/zeroproxy-server -addr :8080 -web web -kernel bin/kernel.wasm -socks 127.0.0.1:9050
```

Equivalent `go run` form:

```sh
go run ./cmd/zeroproxy-server -addr :8080 -web web -kernel bin/kernel.wasm -socks 127.0.0.1:9050
```

Server flags:

- `-addr`: HTTP listen address. Default: `:8080`.
- `-web`: static web asset directory containing `index.html`, `sw.js`, and `/__zp/*` assets. Default: `web`.
- `-kernel`: compiled Go WASM kernel served at `/__zp/kernel.wasm`. Default: `bin/kernel.wasm`.
- `-socks`: Tor SOCKS5 address. Default: `127.0.0.1:9050`.

Open the browser shell on the proxy origin:

```text
http://proxy.localhost:8080/
```

Use `proxy.localhost` from the start so the shell, Service Worker, and encrypted `/p/<encrypted>#k=<key>` routes share one origin. The server starts even if Tor is not reachable, but target browsing needs the configured Tor SOCKS5 listener.

## Verification commands

The local verification surface matches the GitHub Actions CI workflow:

```sh
npm ci
go test ./...
npm test
GOOS=js GOARCH=wasm go build -o /tmp/zeroproxy-kernel.wasm ./cmd/wasm-kernel
go build -o /tmp/zeroproxy-server ./cmd/zeroproxy-server
```

`npm test` runs both JavaScript source-policy tests and the Puppeteer E2E suite. The E2E test builds temporary ZeroProxy binaries, starts a local target HTTP server, starts an in-process SOCKS5 proxy, launches Puppeteer's Chrome, and verifies browser traffic through the ZeroProxy server without requiring Tor.

CI is defined in `.github/workflows/ci.yml` and runs on pushes to `main`, pull requests, and manual dispatch. It uses an Ubuntu 24.04 LTS runner, installs Go from `go.mod`, installs the current Node.js LTS release, runs `npm ci`, runs the Go and full JavaScript/Puppeteer test suites, and builds both deployable binaries.

These checks cover source/unit policy invariants, buildability, and a local-browser E2E path through a test SOCKS5 proxy. They do not start Tor, validate real Tor deployment behavior, or prove production traffic compatibility.

## Repository map

| Path | Purpose |
|---|---|
| `web/index.html`, `web/zp-core.js` | Browser shell, shared URL encryption/decryption, Phase 0 CSP helper. |
| `web/sw.js` | Service Worker classifier, in-memory tab state, runtime API bridge, WASM kernel calls. |
| `web/runtime-prelude.js`, `web/worker-prelude.js` | Target-realm containment hooks and worker bootstrap. |
| `cmd/wasm-kernel` | Go WASM transport kernel exposed to the Service Worker. |
| `cmd/zeroproxy-server` | Static asset server and Gorilla WebSocket/yamux-to-Tor relay. |
| `internal/http1`, `internal/socks5`, `internal/utlskernel`, `internal/wsproto`, `internal/yamuxconn`, `internal/wsconn` | Target transport path. |
| `internal/htmltx`, `internal/headers`, `internal/cookiejar`, `internal/shareurl`, `internal/zpiso` | HTML rewriting, response header policy, cookie handling, share URL envelope, Tor isolation tokens. |
| `test/js`, `test/e2e`, `internal/*/*_test.go` | JavaScript source-policy tests, Puppeteer browser E2E tests, and Go unit tests. |
| `.github/workflows/ci.yml` | GitHub Actions CI for Go tests, JavaScript/Puppeteer tests, WASM build, and relay server build. |
