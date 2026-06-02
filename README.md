# ZeroProxy

ZeroProxy is a prototype of a browser that loads target pages on the proxy
origin, with traffic intended to egress only through:

```text
Service Worker -> Go WASM kernel -> WebSocket/yamux -> SOCKS5 -> uTLS
```

The relay server terminates the browser WebSocket/yamux pipe. With a Tor SOCKS5
listener it byte-bridges streams to Tor; with `-socks internal` it runs a local
SOCKS5 parser/direct dialer for CI and local compatibility tests.

## Status

Prototype. The main spine is implemented, but browser API compatibility and
high-assurance acceptance are still incomplete.

Implemented:

- encrypted `/zp/p/<encrypted>#k=<key>&server=...` routes;
- Service Worker request classification with fail-closed unknown requests;
- Go WASM HTTP/WebSocket transport through yamux, SOCKS5, uTLS, HTTP/2, and
  HTTP/1.1 fallback;
- response header policy, cookie jar, redirects, and safe response construction;
- HTML transformation for document routing, scripts, styles, frames, forms, and
  blocked embed/object surfaces;
- Rust WASM JavaScript/CSS rewriting for external, inline, module, worker,
  imported, event-handler, and dynamic function-body paths;
- runtime facades for fetch, XHR, EventSource, WebSocket, sendBeacon,
  navigation, forms, history/location, storage, workers, iframes, and dynamic
  code;
- streaming response bodies and MessagePort/BroadcastChannel upload relay;
- JavaScript and Go share URL implementations using the same envelope format.

Known gaps:

- browser API semantics are not complete for every fetch/XHR/WebSocket option,
  event ordering, redirect, cache, credential, upload, and progress case;
- worker, module-worker, worklet, blob/data worker, and iframe edge cases need
  broader coverage;
- form navigation, storage, cookies, history, and cancellation/backpressure
  behavior remain prototype-level in several paths;
- real Tor deployment validation is outside the automated test suite.

## Requirements

- Go version from `go.mod`;
- Rust stable, `wasm32-unknown-unknown`, and `wasm-bindgen-cli`;
- Node.js LTS and npm;
- a browser with Service Worker and WebAssembly support;
- optional Tor SOCKS5 listener for anonymized manual browsing.

Tor example:

```text
SocksPort 127.0.0.1:9050 IsolateSOCKSAuth
```

For Tor-free local testing, use:

```sh
./dist/zeroproxy-server -addr :8080 -socks internal
```

Internal mode is not an anonymity mode. It exists to exercise the browser ->
Service Worker -> WASM -> WebSocket/yamux -> SOCKS5 pipeline without an
external proxy daemon.

## Build And Run

```sh
npm ci
npm run build
./dist/zeroproxy-server -addr :8080 -socks 127.0.0.1:9050
```

Open:

```text
http://proxy.localhost:8080/
```

Use `proxy.localhost` so the shell, Service Worker, and `/zp/p/...` routes share
one origin.

Useful server flags:

- `-addr`: HTTP listen address, default `:8080`;
- `-web`: built web asset directory, default `dist/web`;
- `-kernel`: Go WASM kernel path, default `dist/kernel.wasm`;
- `-socks`: SOCKS5 address or `internal`, default `127.0.0.1:9050`.

## Verification

```sh
npm ci
go test ./...
cargo test --manifest-path rewriter-rs/Cargo.toml
npm run test:js
npm run build
npm run test:e2e
```

Additional gates used by maintainers:

```sh
npm run lint:go
npm run lint:rust
npm run lint:js
npm run test:wasm
```

Use the npm test scripts instead of running `node --test test/js` directly.

## Repository Map

| Path | Purpose |
|---|---|
| `web/index.html`, `web/zp-core.js` | Browser shell and share URL helpers. |
| `web/sw.js` | Service Worker classifier, tab state, runtime APIs, WASM kernel calls. |
| `web/http-rewriter.js`, `web/runtime-prelude.js`, `web/worker-prelude.js` | Browser-side rewriter facade and runtime membrane. |
| `rewriter-rs` | Rust WASM JavaScript/CSS rewriter. |
| `scripts/build.mjs` | Web, Rust WASM, Go WASM, and relay build pipeline. |
| `scripts/test.mjs` | JavaScript and Puppeteer E2E test runner. |
| `cmd/wasm-kernel` | Go WASM transport kernel. |
| `cmd/zeroproxy-server` | Static asset server and WebSocket/yamux relay. |
| `internal/htmltx`, `internal/headers`, `internal/cookiejar`, `internal/shareurl`, `internal/zpiso` | HTML transform, header policy, cookies, share URLs, isolation tokens. |
| `internal/zphttp`, `internal/socks5`, `internal/utlskernel`, `internal/wsproto`, `internal/yamuxconn`, `internal/wsconn` | Target transport path. |
| `test/js`, `test/e2e`, `internal/*/*_test.go` | JS policy tests, browser E2E tests, and Go unit tests. |

See `GOAL.md` for the current compatibility refactor target.
