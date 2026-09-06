# ZeroProxy

ZeroProxy is a client-owned virtual browsing prototype that runs target pages on the proxy origin without a browser extension. **Compatibility refactoring is in progress; this is not a production-acceptance declaration.** The current scope, known gaps, and planned behavior are in the [website compatibility refactor plan](.ai/design/website-compat-refactor.md).

## Architecture and security boundary

Target HTTP, HTTPS, and WebSocket requests use the browser-side transport path:

```text
Service Worker -> Rust WASM kernel -> WebSocket/yamux -> SOCKS5 CONNECT
                                                       -> rustls for HTTPS -> HTTP/2 or HTTP/1.1
```

The Go relay serves built assets and terminates the browser WebSocket/yamux pipe. With an external SOCKS5 listener it bridges each stream to that listener; with `-socks internal` it parses SOCKS5 CONNECT and dials the target directly. Target HTTP parsing, HTTPS TLS, cookies, redirects, and content rewriting remain browser-side responsibilities, not a server-side HTTP proxy. Optional WebTransport and WebRTC gateways are separate, explicitly configured Go services; their configuration is defined in [`cmd/zeroproxy-server/main.go`](cmd/zeroproxy-server/main.go).

Keep these boundaries when changing compatibility behavior:

- Target documents use encrypted `/zp/p/<encrypted>#k=<key>&server=...` routes. The fragment key stays client-side. URL envelopes use AES-256-CBC, HMAC-SHA256, and HKDF-separated keys, with MAC verification before decryption.
- Service Worker-controlled requests must be classified; unknown traffic must not fall back to native target fetches.
- Privileged runtime bridge operations require the document/tab capability context. Target code must not gain native networking or an uncontained clean realm.
- Executable target JavaScript goes through the Rust OXC rewriter and runtime membrane. Rewrite failures must fail closed, not execute the original source or relax CSP.
- `-socks internal` is **not an anonymity mode**. Target connections originate directly from the relay process. Tor egress and isolation need separate deployment verification.

These are design constraints, not proof that every browser API and website currently preserves native semantics. Fetch/redirect/credential behavior, document state, cookies, realm installation, AST semantics, and streaming lifetime are the active refactor areas. A historical test count or screenshot does not establish current acceptance.

## Repository map

| Path | Responsibility |
|---|---|
| [`Cargo.toml`](Cargo.toml) | Current Rust workspace and dependencies. |
| [`crates/zp-bundle`](crates/zp-bundle) | Service Worker rewriting/HTML/CSS/shared-policy WASM exports. |
| [`crates/zp-kernel-bundle`](crates/zp-kernel-bundle) | Lazily loaded browser-side transport kernel: yamux, SOCKS5, rustls, HTTP, and target WebSocket handling. |
| [`crates/zp-rewriter`](crates/zp-rewriter), [`crates/zp-htmltx`](crates/zp-htmltx), [`crates/zp-css`](crates/zp-css) | JavaScript AST, HTML, and CSS transformations. |
| [`crates/zp-shared`](crates/zp-shared), [`crates/zp-transport-codec`](crates/zp-transport-codec) | Shared policy/URL contracts and transport codecs. |
| [`crates/zp-page-bundle`](crates/zp-page-bundle), [`crates/zp-page-rt`](crates/zp-page-rt), [`web/zp-rt.js`](web/zp-rt.js) | Page-realm rewriting bundle and raw-WASM URL-policy runtime/glue. |
| [`web/index.html`](web/index.html), [`web/zp-core.js`](web/zp-core.js) | Launcher and shared browser URL/policy helpers. |
| [`web/sw.js`](web/sw.js) | Request classification, document/tab state, runtime bridge, transformation, and kernel integration. |
| [`web/runtime-prelude.js`](web/runtime-prelude.js), [`web/worker-prelude.js`](web/worker-prelude.js) | Page/worker containment and browser API compatibility. |
| [`cmd/zeroproxy-server`](cmd/zeroproxy-server), [`internal`](internal) | Go host, relay, optional gateways, and supporting packages. |
| [`scripts/build.mjs`](scripts/build.mjs), [`scripts/test.mjs`](scripts/test.mjs) | Build and test entry points. |
| [`test/js`](test/js), [`test/e2e`](test/e2e) | JavaScript contract/policy checks and real-browser E2E scenarios, including the E1 escape matrix. |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | Remote build and verification workflow; use its current steps rather than historical command lists. |

## Requirements

- Rust and the `wasm32-unknown-unknown` target specified by [`rust-toolchain.toml`](rust-toolchain.toml).
- `wasm-bindgen-cli` matching the `wasm-bindgen` version resolved in [`Cargo.lock`](Cargo.lock); the CI workflow records its installation procedure.
- Go matching [`go.mod`](go.mod), Node.js LTS, and npm. npm dependencies provide the JavaScript build tools and Puppeteer.
- A browser with Service Worker and WebAssembly support. Browser E2E uses Puppeteer's Chrome for Testing.
- For anonymous target browsing, a Tor SOCKS5 listener with stream isolation. Tor is not required for internal-relay compatibility tests.

## Remote verification first

On memory-constrained machines, keep local work to editing and lightweight inspection. Push the working branch and use the [CI workflow](.github/workflows/ci.yml) for compilation and actual browser E2E instead of starting parallel local Rust builds, browser processes, or language servers. Do not run a local build merely to duplicate an in-flight CI run.

CI builds deployable assets once and reuses them for WASM checks and serial Chromium E2E, including the E1 escape matrix. The workflow runs on branch pushes, pull requests, and manual dispatch. Relevant entry points in [`package.json`](package.json):

- `npm run test:js`: lightweight Node behavior checks without compiling or starting a browser.
- `npm run test:wasm:ci`: WASM checks against already-built `dist/` assets; does not build.
- `npm run test:e2e:ci`: actual browser proxy/E1/request-contract scenarios against built assets; does not build. `ZP_E2E_DIST` and `ZP_E2E_ARTIFACTS` select the build and evidence directories.

The real-site runner, [`test/e2e/real-site-regression.test.js`](test/e2e/real-site-regression.test.js) (`npm run dogfood:real-site`), is a **separate opt-in run**, not part of deterministic CI. For the exact commit under review, inspect both the CI/browser result and any separately collected real-site evidence. A launcher title, successful build, or old green run is not evidence that the target page rendered correctly. Review screenshots and reported failures, and keep missing evidence explicit.

Internal-relay tests do not start Tor or prove Tor anonymity, production deployment safety, or compatibility with every site. Operational dogfood guidance is in [`PRODUCTION_ROLLOUT.md`](PRODUCTION_ROLLOUT.md).

## Build and run locally

When local resources permit, build from the repository root:

```sh
npm ci
npm run build
```

The build writes the Go server and browser assets under `dist/`:

```text
dist/zeroproxy-server                  relay server (.exe on Windows)
dist/web/                              built browser assets
dist/web/__zp/zp_bundle_sw_bg.wasm      Service Worker rewrite bundle
dist/web/__zp/zp_kernel_sw_bg.wasm      lazy transport kernel
dist/web/__zp/zp_page_bundle_bg.wasm    page-realm bundle
dist/web/__zp/zp_page_rt.wasm           raw page runtime
```

The build can clean existing artifacts before compiling. Confirm toolchain availability first if `dist/` contains your only runnable build. Always serve **`dist/web`**, not the source `web/` directory: the source directory lacks generated WASM/glue assets.

For Tor-free compatibility testing:

```sh
./dist/zeroproxy-server -web dist/web -addr :8080 -socks internal
```

For Tor egress, configure a listener with stream isolation, for example:

```text
SocksPort 127.0.0.1:9050 IsolateSOCKSAuth
```

A development listener can be started separately:

```sh
mkdir -p /tmp/zeroproxy-tor
tor --SocksPort "127.0.0.1:9050 IsolateSOCKSAuth" --DataDirectory /tmp/zeroproxy-tor
```

Wait for Tor to report `Bootstrapped 100% (done)`, then start the relay:

```sh
./dist/zeroproxy-server -web dist/web -addr :8080 -socks 127.0.0.1:9050
```

After building browser assets, `go run ./cmd/zeroproxy-server` accepts the same server flags. Core defaults are `-addr :8080`, `-web dist/web`, and `-socks 127.0.0.1:9050`; see the server source for optional gateway flags.

Open **`http://proxy.localhost:8080/zp/`** from the start so launcher, Service Worker, and encrypted target routes share one origin. The server can start without Tor being reachable; browsing still requires the selected SOCKS5 transport.

## Historical records

[`.ai/trap-notebook`](.ai/trap-notebook) preserves past failures, fixes, and later corrections. Its old paths and measurements are historical references, not the current architecture or acceptance checklist. Retired specifications are available in repository history; current work is tracked by the [compatibility refactor plan](.ai/design/website-compat-refactor.md).
