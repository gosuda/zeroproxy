# ZeroProxy Component Boundaries and Embedding Architecture

ZeroProxy is structured as a set of modular, embeddable components across Rust, JavaScript, and Go. Host applications can embed the Rust transformation engine, inject custom network dialers into the WebAssembly transport kernel, attach custom message bridges to the browser membrane, or mount the Go HTTP relay as a standard `http.Handler`.

All component boundaries preserve the frozen wire contract: `/zp/api/*` routes, `/__zp/*` asset paths, `ZP_*` message types (`ZP.MSG` in [`web/zp-core.js`](web/zp-core.js)), WebAssembly export names, and the `dist/web` directory layout.

## 1. Layered Architecture Overview

ZeroProxy separates policy and transformation, network transport, realm containment, and host orchestration into five layers:

| Layer | Owning Crates / Packages | Responsibility |
| :--- | :--- | :--- |
| **`zp-core`** | [`crates/zp-shared`](crates/zp-shared), [`crates/zp-transport-codec`](crates/zp-transport-codec), [`web/zp-core.js`](web/zp-core.js) | Shared route constants, `ZP.MSG` message types, binary fetch envelope codec, CSP builders, and share URL encryption. |
| **`zp-engine`** | [`crates/zp-engine`](crates/zp-engine), [`crates/zp-bundle`](crates/zp-bundle) | Unified Rust library facade over OXC script rewriting, streaming `lol_html` transformation, SWC CSS rewriting, and Source Map v3 composition. |
| **`zp-transport`** | [`crates/zp-kernel-bundle`](crates/zp-kernel-bundle) | Browser-side transport kernel with an injectable `Dialer` trait backing TLS (`rustls`), HTTP/1.1, HTTP/2, WebSocket streams, and cookie storage. |
| **`zp-membrane`** | [`web/membrane/`](web/membrane), [`web/worker-prelude.js`](web/worker-prelude.js) | Virtual browser realm (`ctx` state object and `ctx.bridge` adapter) isolating `window`, `location`, `document`, storage, and networking. |
| **`zp-host`** | [`web/sw.js`](web/sw.js), [`internal/httphost`](internal/httphost), [`cmd/zeroproxy-server`](cmd/zeroproxy-server) | Service Worker request router and embeddable Go `http.Handler` serving static assets, WebSocket relay tunnels, and optional gateways. |

## 2. Component Boundaries

Each layer exposes an explicit boundary so embedders and test suites can use individual subsystems without booting the full browser and relay stack.

### 2.1 `zp-engine` (Rust Transformation Facade)

[`crates/zp-engine`](crates/zp-engine) provides a single native Rust API over [`crates/zp-rewriter`](crates/zp-rewriter), [`crates/zp-htmltx`](crates/zp-htmltx), [`crates/zp-css`](crates/zp-css), and [`crates/zp-shared`](crates/zp-shared). It owns a reusable `RewriterInstance` arena (`TransformEngine`) alongside `DocCtx`, `EngineError`, `parse_script_kind`, and `patches_to_json`.

- **Service Worker WASM bundle ([`crates/zp-bundle`](crates/zp-bundle))**: Exports thin `wasm-bindgen` shims (`rewriteScriptPatches`, `transformHtml`, `HtmlTxn`, `rewriteCSS`, `buildCSP*`, `isChallengeDocument`, `composeSourceMap*`) backed by a thread-local `TransformEngine`.
- **Native Rust callers**: Link `zp-engine` directly for server-side transformation benchmarks or native conformance tests without WebAssembly overhead.
- **Page-realm bundle exception ([`crates/zp-page-bundle`](crates/zp-page-bundle))**: Links `zp-rewriter` directly rather than `zp-engine`. Avoiding `zp-htmltx` (`lol_html`) and `zp-css` (SWC) in the page bundle keeps `zp_page_bundle_bg.wasm` at 375 KB, under the 500 KB per-navigation budget.

### 2.2 `Dialer` Seam in the Transport Kernel

[`crates/zp-kernel-bundle/src/kernel/transport/dialer.rs`](crates/zp-kernel-bundle/src/kernel/transport/dialer.rs) decouples connection establishment from upper-layer TLS, HTTP/1.1, HTTP/2, and WebSocket framing:

- `AsyncIo` is the stream trait used by `PooledConn` across the connection pool.
- `Dialer` defines how the kernel opens a byte stream to a `TargetAddr`.
- `RelayDialer` is the default implementation, multiplexing streams over `yamux` and framing SOCKS5 `CONNECT` requests over the relay WebSocket.
- `set_dialer` lets WASM embedders inject a custom `Dialer` (such as an in-memory pipe or custom tunnel) while keeping [`fetch.rs`](crates/zp-kernel-bundle/src/kernel/transport/fetch.rs) and [`ws_client.rs`](crates/zp-kernel-bundle/src/kernel/transport/ws_client.rs) unchanged.

### 2.3 `web/membrane/` (Virtual Browser Membrane)

The page membrane source is organized into 23 ordered fragments under [`web/membrane/`](web/membrane) that [`scripts/build.mjs`](scripts/build.mjs) concatenates into a single IIFE (`dist/web/runtime-prelude.js`):

| Fragment | Responsibility |
| :--- | :--- |
| `00-head.js`, `01-boot.js` | IIFE entry, global scrub, boot config parsing, native API capture, and live `ctx` state view. |
| `02-masking.js`, `03-urls.js` | Function `toString` branding, descriptor helpers, share/proxy URL encoding, and attribute URL policy. |
| `04-navigation.js`, `05-messaging.js` | Virtual `history`/`location` navigation, `BridgeAdapter` (`ctx.bridge`), and Service Worker `postMessage` channel. |
| `06-install.js`, `07-membrane.js` | Installation step runner, error stack sanitizer, and core `window`/`location`/`document` membrane. |
| `08-http.js`, `09-nav-net.js`, `10-swless.js` | Virtual `fetch`, XHR, `WebSocket`, `EventSource`, beacon, client hints, popup/frame `postMessage`, and SW-less fallback. |
| `11-cookies.js`, `12-storage.js` | Virtual cookie jar, `cookieStore`, `localStorage`, `sessionStorage`, IndexedDB, Cache Storage, OPFS, and permissions. |
| `13-attrs.js`, `14-dom.js`, `15-scripts-css.js` | DOM attribute stashing (`data-zp-lit-*`), DOM insertion hooks, script/CSS rewriting, `importmap`, and `<meta>` CSP intersection. |
| `16-policy.js`, `17-workers.js`, `18-iframes.js` | Subtree observers, `Worker`/`SharedWorker` bootstrap wrapping, and cross-origin/sandboxed `iframe` containment. |
| `19-gateways.js`, `20-containment.js`, `21-surface.js`, `22-tail.js` | WebTransport and WebRTC TURN wrappers, network blockers, residual API guards, canvas/audio farbling, and `__zp_realm` export. |

The fragments are concatenation units of a single IIFE rather than ES modules so that all membrane hooks share private lexical state inside the closure while exposing the live `ctx` handle on `window.__zp_realm` (hidden from page enumeration by `ZP_HIDDEN_RE`).

### 2.4 Binary Fetch Envelope (`POST /zp/api/v2/fetch`)

To avoid the 33% payload size overhead and CPU cost of base64-encoding request bodies inside JSON, the page membrane, worker prelude, and Service Worker communicate over a binary envelope format (`application/zp-envelope`) defined by `ZP.encodeEnvelope` and `ZP.decodeEnvelope` in [`web/zp-core.js`](web/zp-core.js):

```text
[u32le headLen][JSON head bytes][raw request body bytes]
```

- **Protocol negotiation**: The page and worker realms send `POST /zp/api/v2/fetch` first. If an older Service Worker responds with HTTP `404` without an `X-ZP-Fetch-Meta` header, the realm automatically downgrades to the legacy JSON `/zp/api/fetch` endpoint for the remainder of its lifetime. Upstream `404` responses from target servers always include `X-ZP-Fetch-Meta`, keeping detection unambiguous.
- **Backward compatibility**: The v1 `/zp/api/fetch` endpoint (including `GET /zp/api/fetch?url=...` subresource loads) remains active and unchanged.

### 2.5 `internal/httphost` (Go HTTP Host Library)

[`internal/httphost`](internal/httphost) encapsulates the Go HTTP server surface: static asset delivery, WebSocket-to-SOCKS5 stream bridging, synchronous XHR relay coordination, CSP violation reporting, and `/zp/api/config` generation. [`cmd/zeroproxy-server/main.go`](cmd/zeroproxy-server/main.go) parses CLI flags, initializes optional WebTransport and TURN gateways, and mounts `httphost.NewHandler(cfg)`.

## 3. Embedding Interfaces

Host applications can integrate ZeroProxy at four boundaries depending on their runtime environment.

### 3.1 JavaScript: Custom Membrane Bridge

Set `window.__zp_bridge_factory` before evaluating `dist/web/runtime-prelude.js` to intercept control messages between the membrane and the host without requiring a Service Worker controller:

```js
// Configure the custom bridge factory before evaluating the prelude:
win.__zp_bridge_factory = (ctx) => ({
  send: (msg) => Promise.resolve({ ok: true /* reply fields */ }),
  onMessage: (fn) => myChannel.on("data", fn), // optional inbound listener
});

// After evaluating dist/web/runtime-prelude.js inside the realm:
const realm = win.__zp_realm;        // live context handle (virtualURL, baseURL, documentCookie, ...)
const bridge = win.__zp_realm.bridge; // active bridge instance
```

When `window.__zp_bridge_factory` is not defined, the membrane defaults to the Service Worker `postMessage` channel with capability token sealing.

### 3.2 Rust: Native Transformation Engine

Use [`crates/zp-engine`](crates/zp-engine) in Rust applications or test suites to rewrite scripts, stream HTML transformations, and rewrite CSS:

```rust
let mut engine = zp_engine::TransformEngine::new();
let ctx = zp_engine::DocCtx::new(target_url, proxy_origin);

let rewritten_js = engine.rewrite_script(src, "classic", &ctx)?;
let patch_json = engine.rewrite_script_patches_json(src, kind, &ctx)?;
let transformed_html = engine.transform_html(html, &ctx)?;

let mut txn = engine.html_txn(&ctx, &prelude);
txn.write(chunk)?;
txn.end()?;

let rewritten_css = engine.rewrite_css(css, base_url, "/zp/", &ctx)?;
let csp_header = engine.build_csp_with(ws_origin, challenge_compat);
```

### 3.3 Rust (WASM): Custom Transport Dialer

Implement the `Dialer` trait in [`crates/zp-kernel-bundle`](crates/zp-kernel-bundle) to route outbound connections over a custom byte stream transport:

```rust
struct CustomDialer;

impl zp_kernel_bundle::kernel::transport::dialer::Dialer for CustomDialer {
    fn connect<'a>(
        &'a self,
        target: &'a TargetAddr,
        relay: &'a str,
        t0: f64,
    ) -> LocalBoxFuture<'a, Result<Box<dyn AsyncIo>, JsValue>> {
        // Return a boxed AsyncIo stream connected to target
    }
}

zp_kernel_bundle::kernel::transport::dialer::set_dialer(Rc::new(CustomDialer));
```

### 3.4 Go: Embeddable HTTP Handler

Mount `httphost.NewHandler` inside any standard Go HTTP server, router, or middleware stack (see [`internal/httphost/example_test.go`](internal/httphost/example_test.go)):

```go
handler := httphost.NewHandler(httphost.Config{
    WebDir:    "dist/web",
    SocksAddr: "internal", // or "127.0.0.1:9050" for Tor SOCKS5
})
```

## 4. Intentional Design Trade-Offs

Three boundaries remain intentionally separate:

- **Worker and page prelude separation**: [`web/worker-prelude.js`](web/worker-prelude.js) maintains its own worker-specific transport and global surface hooks rather than sharing concatenation fragments with [`web/membrane/`](web/membrane), because worker bootstrap scripts run without DOM APIs and use dedicated worker-to-SW message channels.
- **WASM-bound transport kernel**: While `Dialer` abstracts raw stream connections, the upper HTTP/TLS transport pipeline in [`crates/zp-kernel-bundle`](crates/zp-kernel-bundle) targets `wasm32-unknown-unknown` and browser `JsValue` streams.
- **Unmodified `performance.timeOrigin`**: The membrane preserves the browser's native `performance.timeOrigin` timestamp as a documented compatibility trade-off (see Gate D7 in [`PHASE2_STATUS.md`](PHASE2_STATUS.md)).
