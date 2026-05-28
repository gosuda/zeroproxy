# ZeroProxy

ZeroProxy is a client-owned virtual browsing prototype that runs target pages on the proxy origin without a browser extension. Its design goal is that target-site HTTP, TLS, and WebSocket traffic leaves only through this path:

```text
Service Worker -> Go WASM kernel -> WebSocket/yamux -> SOCKS5 CONNECT -> uTLS -> HTTP/2 or HTTP/1.1
```

The relay server terminates only the browser WebSocket/yamux pipe. In production it byte-bridges each yamux stream to a Tor SOCKS5 listener; for local compatibility tests `-socks internal` makes the relay parse the kernel's SOCKS5 CONNECT itself and dial the requested target directly. Target HTTP parsing, redirects, cookies, header policy, HTML rewriting, and target WebSocket framing are owned by the Go WASM kernel and browser-side runtime.

## Status

Status: **Phase 0 prototype / partial implementation**.

Implemented core spine:

- Encrypted active/share route format: `/p/<encrypted>#k=<key>`.
- AES-256-CBC + HMAC-SHA256 URL envelope with HKDF-separated encryption/MAC keys and HMAC verification before decryption.
- Service Worker request classifier that handles every controlled request, blocks unknown requests instead of falling back to native `fetch(event.request)`, and requires a per-tab runtime capability token on privileged runtime bridge messages.
- Go WASM exports: `__go_jshttp`, `__zp_stream`, `__zp_kernel_init`, and `__zp_cookie_set`.
- A single browser WebSocket pipe carrying yamux streams to the relay server, then SOCKS5 DOMAINNAME CONNECT, uTLS for HTTPS, HTTP/2 when ALPN selects `h2`, and HTTP/1.1 fallback/direct handling. `-socks 127.0.0.1:9050` preserves the Tor bridge; `-socks internal` is a Tor-free development/test mode that parses SOCKS5 on the relay and dials targets directly from the relay process.
- Tokenizer-based HTML transform that injects the runtime prelude, launders executable external scripts through `/__zp/api/script?u=...`, rewrites iframe/frame document URLs to encrypted `/p` routes, preserves author-visible anchor/form attributes for runtime navigation interception, removes or neutralizes preload/preconnect/manifest hints, drops dangerous tags and headers, strips executable event attributes through the JS rewriter, and handles `srcdoc`.
- Runtime containment for main-window `fetch`, XHR, EventSource, WebSocket, `sendBeacon`, navigation, forms, history/location masking, storage facades, workers, iframes, and high-risk device/network APIs. Main-window and worker `fetch` paths are bridged through `/__zp/api/fetch` so strict `connect-src 'self'` does not block target API calls before the Service Worker can route them. Runtime-to-Service-Worker control messages carry a closure-held per-tab capability token. The runtime also applies basic self-fingerprint masking for patched function source strings, Canvas/Audio extraction jitter, and speech voice lists; broad anti-bot spoofing is not a project goal.
- Phase 2 JavaScript rewriting is wired through an OXC parser/WASM service: target-response CSP no longer permits `connect-src *`, external, module, worker, and imported script sources are parsed before execution, dangerous global/window/location access is rewritten to runtime membrane helpers, parse/transform failures fail closed, dynamic compilation paths such as `Function`, constructor-constructor escapes, `eval`, and string timers execute under the runtime's virtual global scope, and blob/data worker scripts remain blocked when they cannot be rewritten synchronously.
- Relay server static asset service and `/__zp/ws-pipe` WebSocket endpoint.
- Go and JavaScript share URL implementations that use the same envelope format.

Not complete enough for production or high-assurance acceptance:

- Browser E2E tests cover internal SOCKS5 relay mode, dynamic script laundering, module-script worker bootstrap, inert dynamic preload/preconnect link handling, compound location assignments, iframe postMessage delivery, iframe clean-realm containment, forms, cookies, streaming responses, and basic fingerprint-masking checks, but do not yet prove every worker, direct navigation, device API, and unclassified subresource non-escape path.
- Dynamic iframe containment is synchronous for `contentWindow`/`contentDocument` reads and common insertion APIs, but remains prototype-level and should keep gaining adversarial browser coverage.
- Main-window runtime API compatibility is prototype-level for `fetch`, XHR, EventSource, WebSocket, `sendBeacon`, forms, uploads, descriptor edge cases, and fingerprinting surface fidelity. The wrappers preserve the ZeroProxy transport boundary, but they are not browser-native semantic clones for every option, event, redirect, credential, cache, progress, or close/error edge case.
- Response bodies are streamed into JavaScript `Response` objects, but request/upload bodies are buffered through the Service Worker/WASM bridge with an explicit size cap. Streaming uploads, large multipart/file uploads, request cancellation, and browser backpressure behavior are still prototype-level.
- Form navigation compatibility is limited: GET submissions become ZeroProxy navigations, while non-GET submissions are replayed through the runtime fetch path and write the transformed response back into the current document rather than following the browser's native navigation algorithm.
- Worker compatibility is partial: Worker/SharedWorker constructors bootstrap through ZeroProxy, dedicated worker `fetch` and `importScripts` are bridged, rewritten worker code receives the Phase 2 membrane helpers it may reference, and worker XHR, WebSocket, EventSource, native device/network APIs, full worklet/module-worker parity, and unrewritable blob/data worker scripts are blocked or prototype-level rather than fully emulated.
- Cookie, storage, and history semantics are not yet reconciled across runtime state, Service Worker state, and the Go kernel cookie jar. Encrypted IndexedDB persistence is not implemented.
- Tor daemon deployment and real Tor-egress E2E validation are not included in this repository.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the implementation map and acceptance boundary. See [`PHASE2_PLAN.md`](./PHASE2_PLAN.md) for the Phase 2 Service Worker/OXC JavaScript rewriting plan.

## Requirements

- Go 1.26 or the Go toolchain version required by `go.mod`.
- Node.js LTS and npm for the JavaScript and Puppeteer E2E tests.
- A browser with Service Worker and WebAssembly support. CI uses Puppeteer's pinned Chrome for Testing.
- A Tor SOCKS5 listener configured with stream isolation for anonymized manual target browsing. Tor is not required for the automated Puppeteer suite or local compatibility checks that run the relay with `-socks internal`.

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

For Tor-free local compatibility testing, start ZeroProxy with the internal relay SOCKS5 parser instead of starting Tor:

```sh
./dist/zeroproxy-server -addr :8080 -socks internal
```

Internal mode is not an anonymity mode: target TCP connections are direct dials from the relay process. It exists so CI and local browser compatibility tests can exercise the browser → Service Worker → WASM → WebSocket/yamux → SOCKS5 parsing pipeline without an external proxy daemon.

## Build and run locally

Build the browser bundle, Go WASM kernel, and relay server from the repository root:

```sh
npm ci
npm run build
```

The build writes deployable artifacts under `dist/`:

```text
dist/web/                 built browser assets
dist/kernel.wasm          Go WASM transport kernel
dist/zeroproxy-server     relay server binary
```

Start the relay server in another terminal:

```sh
./dist/zeroproxy-server -addr :8080 -socks 127.0.0.1:9050
```

Equivalent `go run` form after `npm run build`:

```sh
go run ./cmd/zeroproxy-server -addr :8080 -socks 127.0.0.1:9050
```

Server flags:

- `-addr`: HTTP listen address. Default: `:8080`.
- `-web`: built static web asset directory containing `index.html`, `sw.js`, and `/__zp/*` assets. Default: `dist/web`.
- `-kernel`: compiled Go WASM kernel served at `/__zp/kernel.wasm`. Default: `dist/kernel.wasm`.
- `-socks`: Tor SOCKS5 address, or `internal` for the relay's built-in SOCKS5 CONNECT parser/direct dialer used by tests. Default: `127.0.0.1:9050`.

Open the browser shell on the proxy origin:

```text
http://proxy.localhost:8080/
```

Use `proxy.localhost` from the start so the shell, Service Worker, and encrypted `/p/<encrypted>#k=<key>` routes share one origin. The server starts even if Tor is not reachable. Target browsing needs either a configured Tor SOCKS5 listener or the explicit non-anonymous `-socks internal` test mode.

## Verification commands

The local verification surface matches the GitHub Actions CI workflow:

```sh
npm ci
go test ./...
npm test
npm run build
```

`npm test` runs both JavaScript source-policy tests and the Puppeteer E2E suite. The E2E test builds temporary ZeroProxy artifacts with `scripts/build.mjs`, starts a local target HTTP server, starts the relay with `-socks internal`, launches Puppeteer's Chrome, and verifies browser traffic through the ZeroProxy server without requiring Tor.

CI is defined in `.github/workflows/ci.yml` and runs on pushes to `main`, pull requests, and manual dispatch. It uses an Ubuntu 24.04 LTS runner, installs Go from `go.mod`, installs the current Node.js LTS release, runs `npm ci`, runs the Go and full JavaScript/Puppeteer test suites, and builds deployable `dist/` artifacts.

These checks cover source/unit policy invariants, buildability, and a local-browser E2E path through the relay's internal SOCKS5 parser/direct dialer. They do not start Tor, validate real Tor deployment behavior, or prove production traffic compatibility.

## Repository map

| Path | Purpose |
|---|---|
| `web/index.html`, `web/zp-core.js` | Browser shell, shared URL encryption/decryption, Phase 0 CSP helper. |
| `web/sw.js` | Service Worker classifier, in-memory tab state, runtime API bridge, WASM kernel calls. |
| `web/runtime-prelude.js`, `web/worker-prelude.js` | Target-realm containment hooks, dynamic HTML/link/script policy, and worker bootstrap/membrane helpers. |
| `scripts/build.mjs` | Full build pipeline for browser bundles, generated WASM support assets, Go WASM kernel, and relay server. |
| `scripts/test.mjs` | Stable local/CI test runner that executes JavaScript policy tests and the Puppeteer E2E suite in sequence. |
| `cmd/wasm-kernel` | Go WASM transport kernel exposed to the Service Worker. |
| `cmd/zeroproxy-server` | Static asset server and Gorilla WebSocket/yamux relay to Tor SOCKS5 or the `-socks internal` direct-dial SOCKS5 parser. |
| `internal/zphttp`, `internal/socks5`, `internal/utlskernel`, `internal/wsproto`, `internal/yamuxconn`, `internal/wsconn` | Target transport path. |
| `internal/htmltx`, `internal/headers`, `internal/cookiejar`, `internal/shareurl`, `internal/zpiso` | HTML rewriting, response header policy, cookie handling, share URL envelope, Tor isolation tokens. |
| `test/js`, `test/e2e`, `internal/*/*_test.go` | JavaScript source-policy tests, Puppeteer browser E2E tests, and Go unit tests. |
| `.github/workflows/ci.yml` | GitHub Actions CI for Go tests, JavaScript/Puppeteer tests, WASM build, and relay server build. |
