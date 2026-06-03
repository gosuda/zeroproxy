# ZeroProxy

ZeroProxy is a privacy layer for browsing real websites in a real browser.

You type a URL, interact with the page normally, and ZeroProxy keeps the target
site behind a controlled privacy boundary.

## Key Features

- Browse through an ordinary browser UI instead of a fake remote-browser shell.
- Keep target traffic on a single controlled network path.
- Open shared encrypted routes with `/zp/p/<route>#k=...` links.
- Run modern sites with support for scripts, styles, frames, workers, and
  dynamic code.
- Preserve common browser features such as navigation, forms, storage, fetch,
  XHR, WebSocket, iframe messaging, and workers.
- Reduce fingerprint signals with browser persona masking and canvas
  randomization.
- Fail closed when a request or execution path is unknown or unsafe.
- Verify compatibility with native-browser-vs-ZeroProxy browser tests.

## How It Works

ZeroProxy loads the target page inside its own controlled origin, prepares the
page before it runs, and routes network traffic through:

```text
Service Worker -> Go WASM kernel -> WebSocket/smux -> SOCKS5 -> uTLS
```

For local development, the built-in SOCKS mode exercises the same browser
pipeline without requiring Tor. For private browsing experiments, point
ZeroProxy at a Tor SOCKS5 listener.

## Quick Start

```sh
npm ci
npm run build
./dist/zeroproxy-server -addr :8080 -socks internal
```

Open:

```text
http://proxy.localhost:8080/
```

Use `proxy.localhost` so the shell, Service Worker, and `/zp/p/...` routes share
one origin.

For Tor-backed browsing, point `-socks` at a Tor SOCKS5 listener:

```sh
./dist/zeroproxy-server -addr :8080 -socks 127.0.0.1:9050
```

`-socks internal` is for local development and CI. It is not an anonymity mode.

## Requirements

- Go version from `go.mod`;
- Rust stable with `wasm32-unknown-unknown`;
- `wasm-bindgen-cli`;
- Node.js and npm;
- a browser with Service Worker and WebAssembly support.

## Verification

Full local gate:

```sh
npm test
npm run test:wasm
npm run lint:go
npm run lint:rust
npm run lint:js
cargo test --manifest-path rewriter-rs/Cargo.toml
```

Useful shorter loops:

```sh
npm run test:js
npm run test:e2e
npm run build
```

Use the npm scripts instead of invoking `node --test` directly.

## Repository Map

| Path | Purpose |
|---|---|
| `web/` | Browser shell, Service Worker, runtime membrane, worker prelude. |
| `rewriter-rs/` | Rust WASM HTML/CSS/JS/import-map rewriter. |
| `cmd/wasm-kernel/` | Go WASM transport kernel. |
| `cmd/zeroproxy-server/` | Static asset server and WebSocket/smux relay. |
| `internal/htmltx/` | Thin Go adapter into the Rust HTML rewriter. |
| `internal/zphttp/`, `internal/socks5/`, `internal/wsproto/` | Target transport path. |
| `test/js/`, `test/e2e/` | Policy, build, runtime, and browser compatibility tests. |
