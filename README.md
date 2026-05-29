# ZeroProxy

ZeroProxy is a client-owned virtual browsing prototype that runs target pages on the proxy origin without a browser extension. Its design goal is that target-site HTTP, TLS, and WebSocket traffic leaves only through this path:

```text
Service Worker -> Go WASM kernel -> WebSocket/yamux -> SOCKS5 CONNECT -> uTLS -> HTTP/2 or HTTP/1.1
```

The relay server terminates only the browser WebSocket/yamux pipe. In production it byte-bridges each yamux stream to a Tor SOCKS5 listener; for local compatibility tests `-socks internal` makes the relay parse the kernel's SOCKS5 CONNECT itself and dial the requested target directly. Target HTTP parsing, redirects, cookies, header policy, HTML rewriting, and target WebSocket framing are owned by the Go WASM kernel and browser-side runtime.

## Status

Status: **Prototype / acceptance-grade Phase 3 implementation for the covered browser paths**.

Implemented core spine:

- Encrypted active/share route format: `/zp/p/<encrypted>#k=<key>&server=...`.
- AES-256-CBC + HMAC-SHA256 URL envelope with HKDF-separated encryption/MAC keys and HMAC verification before decryption.
- Service Worker request classifier that handles every controlled request, blocks unknown requests instead of falling back to native `fetch(event.request)`, and requires a per-tab runtime capability token on privileged runtime bridge messages.
- Go WASM exports: `__go_jshttp`, `__zp_stream`, `__zp_kernel_init`, and `__zp_cookie_set`.
- A single browser WebSocket pipe carrying yamux streams to the relay server, then SOCKS5 DOMAINNAME CONNECT, uTLS for HTTPS, HTTP/2 when ALPN selects `h2`, and HTTP/1.1 fallback/direct handling. `-socks 127.0.0.1:9050` preserves the Tor bridge; `-socks internal` is a Tor-free development/test mode that parses SOCKS5 on the relay and dials targets directly from the relay process.
- Tokenizer-based streaming HTML transform that injects the runtime prelude, launders executable external scripts through `/zp/api/script?u=...`, rewrites iframe/frame document URLs to encrypted `/zp/p` routes with inherited `server=` relay fragments, preserves author-visible anchor/form attributes for runtime navigation interception, proxies stylesheets through `/zp/api/fetch`, removes or neutralizes preload/preconnect/manifest hints, drops dangerous tags and headers, statically rewrites inline executable scripts through the Rust WASM rewriter, fail-closes inline event attributes under strict CSP, and handles `srcdoc`.
- Runtime containment for main-window `fetch`, XHR, EventSource, WebSocket, `sendBeacon`, navigation, forms, history/location masking, IndexedDB-backed storage facades, workers, iframes, and high-risk device/network APIs. Main-window and worker `fetch` paths are bridged through `/zp/api/fetch` with per-tab runtime capability tokens and tab IDs, so strict `connect-src 'self'` does not block target API calls before the Service Worker can route them. The runtime also applies basic self-fingerprint masking for patched function source strings, Canvas/Audio extraction jitter, and speech voice lists; broad anti-bot spoofing is not a project goal.
- Rust WASM rewriting is the only static compiler pipeline: target-response CSP no longer permits `connect-src *`, external, module, worker, imported, and inline scripts are parsed before execution, dangerous global/window/location access is rewritten to runtime membrane helpers, parse/transform failures fail closed, constructor-constructor escapes are routed through runtime helpers instead of blocked, and blob/data worker scripts remain blocked when they cannot be rewritten synchronously. The foreground target document no longer loads the Rust WASM rewriter; document CSP is strict `script-src 'self' 'nonce-zp'`, while Service Worker/WASM asset execution uses a separate CSP path.
- Rust SWC CSS rewriting runs for external stylesheets, stylesheet responses fetched through `/zp/api/fetch`, inline `<style>`, and dynamic style attributes. It rewrites real `url(...)` and `@import` resources to same-origin `/zp/api/fetch?url=...` requests while preserving comments, data/blob/about URLs, and ordinary string content such as `content: "url(...)"`.
- Request bodies are streamed through an explicit MessagePort/BroadcastChannel upload protocol and Go WASM `ReadableStream` bridge. The old 8 MB request cap and whole-body Service Worker buffering path have been removed; current manual verification transferred a 500 MB `ReadableStream` upload with flat page JS heap growth.
- Server-side `Set-Cookie` updates from target fetches are synchronized back to the foreground runtime as structured non-HttpOnly cookie records, while `document.cookie` writes still flow back into the Go cookie jar. Runtime cookie projection preserves domain/path/secure/expiry metadata closely enough for the covered E2E reconciliation cases.
- Relay server static asset service and `/zp/ws-pipe` WebSocket endpoint.
- Go and JavaScript share URL implementations that use the same envelope format.

Not complete enough for production or high-assurance acceptance:

- Browser E2E tests cover internal SOCKS5 relay mode, dynamic script laundering, module-script worker bootstrap, inert dynamic preload/preconnect link handling, compound location assignments, iframe postMessage delivery, iframe clean-realm containment, forms, cookie reconciliation, persistent storage preload/write-through, streaming responses, streaming uploads, and basic fingerprint-masking checks, but do not yet prove every worker, direct navigation, device API, and unclassified subresource non-escape path.
- Dynamic iframe containment is synchronous for `contentWindow`/`contentDocument` reads and common insertion APIs, but remains prototype-level and should keep gaining adversarial browser coverage.
- Main-window runtime API compatibility is prototype-level for `fetch`, XHR, EventSource, WebSocket, `sendBeacon`, forms, uploads, descriptor edge cases, and fingerprinting surface fidelity. The wrappers preserve the ZeroProxy transport boundary, but they are not browser-native semantic clones for every option, event, redirect, credential, cache, progress, or close/error edge case.
- Response bodies stream into JavaScript `Response` objects, and request/upload bodies stream through the runtime upload relay. Cancellation, multipart/file upload fidelity, and browser-exact progress/backpressure events are still prototype-level.
- Form navigation compatibility is limited: GET submissions become ZeroProxy navigations, while non-GET submissions are replayed through the runtime fetch path and write the transformed response back into the current document rather than following the browser's native navigation algorithm.
- Worker compatibility is partial: Worker/SharedWorker constructors bootstrap through ZeroProxy, dedicated worker `fetch` and `importScripts` are bridged, rewritten worker code receives the runtime membrane helpers it may reference, and worker XHR, WebSocket, EventSource, native device/network APIs, full worklet/module-worker parity, and unrewritable blob/data worker scripts are blocked or prototype-level rather than fully emulated.
- Cookie, storage, and history semantics are improved but still not browser-complete. IndexedDB-backed local/session storage preload and write-through exist, and cookie reconciliation is covered for common path/domain/HttpOnly/deletion cases, but quota, storage events, encrypted persistence, SameSite edge behavior, and every history/state edge case remain prototype-level.
- Tor daemon deployment and real Tor-egress E2E validation are not included in this repository.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the implementation map and acceptance boundary. See [`PHASE3_PLAN.md`](./PHASE3_PLAN.md) for the current cutover plan.

## Requirements

- Go 1.26 or the Go toolchain version required by `go.mod`.
- Rust stable, the `wasm32-unknown-unknown` target, and `wasm-bindgen-cli` for the Rust SWC rewriter build.
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
- `-web`: built static web asset directory containing `index.html`, `sw.js`, and `/zp/assets/*` assets. Default: `dist/web`.
- `-kernel`: compiled Go WASM kernel served at `/zp/kernel.wasm`. Default: `dist/kernel.wasm`.
- `-socks`: Tor SOCKS5 address, or `internal` for the relay's built-in SOCKS5 CONNECT parser/direct dialer used by tests. Default: `127.0.0.1:9050`.

Open the browser shell on the proxy origin:

```text
http://proxy.localhost:8080/
```

Use `proxy.localhost` from the start so the shell, Service Worker, and encrypted `/zp/p/<encrypted>#k=<key>&server=...` routes share one origin. The server starts even if Tor is not reachable. Target browsing needs either a configured Tor SOCKS5 listener or the explicit non-anonymous `-socks internal` test mode.

## Verification commands

The local verification surface matches the GitHub Actions CI workflow:

```sh
npm ci
go test ./...
cargo test --manifest-path rewriter-rs/Cargo.toml
npm run test:js
npm run build
npm run test:e2e
```

`npm test` is still available as a shorthand for the JavaScript source-policy tests and Puppeteer E2E suite. The E2E test builds temporary ZeroProxy artifacts with `scripts/build.mjs`, starts a local target HTTP server, starts the relay with `-socks internal`, launches Puppeteer's Chrome, and verifies browser traffic through the ZeroProxy server without requiring Tor.

CI is defined in `.github/workflows/ci.yml` and runs on pushes to `main`, pull requests, and manual dispatch. It uses an Ubuntu 24.04 LTS runner, installs Go from `go.mod`, installs Rust stable with `wasm32-unknown-unknown`, installs `wasm-bindgen-cli`, installs the current Node.js LTS release, runs `npm ci`, runs the Rust, Go, and full JavaScript/Puppeteer test suites, and builds deployable `dist/` artifacts.

These checks cover source/unit policy invariants, buildability, and a local-browser E2E path through the relay's internal SOCKS5 parser/direct dialer. They do not start Tor or validate real Tor deployment behavior.


## Repository map

| Path | Purpose |
|---|---|
| `web/index.html`, `web/zp-core.js` | Browser shell, shared URL encryption/decryption, and ZeroProxy CSP helper. |
| `web/sw.js` | Service Worker classifier, in-memory tab state, runtime API bridge, WASM kernel calls. |
| `web/runtime-prelude.js`, `web/worker-prelude.js` | Target-realm containment hooks, dynamic HTML/link/script policy, and worker bootstrap/membrane helpers. |
| `rewriter-rs` | Rust SWC JavaScript/CSS rewriter built to WASM and embedded in `rust-rewriter.js`. |
| `scripts/build.mjs` | Full build pipeline for browser bundles, generated Rust rewriter WASM support asset, Go WASM kernel, and relay server. |
| `scripts/test.mjs` | Stable local/CI test runner that executes JavaScript policy tests and the Puppeteer E2E suite in sequence. |
| `cmd/wasm-kernel` | Go WASM transport kernel exposed to the Service Worker. |
| `cmd/zeroproxy-server` | Static asset server and Gorilla WebSocket/yamux relay to Tor SOCKS5 or the `-socks internal` direct-dial SOCKS5 parser. |
| `internal/zphttp`, `internal/socks5`, `internal/utlskernel`, `internal/wsproto`, `internal/yamuxconn`, `internal/wsconn` | Target transport path. |
| `internal/htmltx`, `internal/headers`, `internal/cookiejar`, `internal/shareurl`, `internal/zpiso` | HTML rewriting, response header policy, cookie handling, share URL envelope, Tor isolation tokens. |
| `test/js`, `test/e2e`, `internal/*/*_test.go` | JavaScript source-policy tests, Puppeteer browser E2E tests, and Go unit tests. |
| `.github/workflows/ci.yml` | GitHub Actions CI for Go tests, JavaScript/Puppeteer tests, WASM build, and relay server build. |
