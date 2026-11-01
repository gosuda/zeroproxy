# ZeroProxy Architecture

ZeroProxy is a set of embeddable components across Rust, JavaScript, and Go. A host application can embed the Rust transformation engine, inject a custom network dialer into the WebAssembly transport kernel, attach a custom message bridge to the browser membrane, or mount the Go HTTP relay as a standard `http.Handler`.

This document describes what is true now: the layers, the contracts between them, and the invariants that keep a proxied page contained. Verification evidence for each containment gate is in [`containment-gates.md`](containment-gates.md), known residuals are in [`errata.md`](errata.md), day-to-day engineering workflow is in [`engineering-guide.md`](engineering-guide.md), and the release checklist is in [`rollout.md`](rollout.md). Subtle browser behaviors and the reasons behind individual fixes live in the [trap notebook](../.ai/trap-notebook/README.md).

## 1. Layers

Policy and transformation, transport, realm containment, and host orchestration are separate layers:

| Layer | Owning crates / packages | Responsibility |
| :--- | :--- | :--- |
| **`zp-core`** | [`crates/zp-shared`](../crates/zp-shared), [`crates/zp-transport-codec`](../crates/zp-transport-codec), [`web/zp-core.js`](../web/zp-core.js) | Route constants, `ZP.MSG` message types, the binary fetch envelope, CSP builders, share URL encryption. |
| **`zp-engine`** | [`crates/zp-engine`](../crates/zp-engine), [`crates/zp-bundle`](../crates/zp-bundle) | One Rust facade over OXC script rewriting, streaming `lol_html` transformation, SWC CSS rewriting, and Source Map v3 composition. |
| **`zp-transport`** | [`crates/zp-kernel-bundle`](../crates/zp-kernel-bundle) | Browser-side transport kernel with an injectable `Dialer`: TLS (`rustls`), HTTP/1.1, HTTP/2, WebSocket streams, yamux, SOCKS5. |
| **`zp-membrane`** | [`web/membrane/`](../web/membrane), [`web/worker-prelude.js`](../web/worker-prelude.js) | The virtual browser realm that isolates `window`, `location`, `document`, storage, and networking. |
| **`zp-host`** | [`web/sw.js`](../web/sw.js), [`pkg/httphost`](../pkg/httphost), [`pkg/wtproxy`](../pkg/wtproxy), [`pkg/rtcgw`](../pkg/rtcgw), [`cmd/zeroproxy-server`](../cmd/zeroproxy-server) | The Service Worker request router and the Go HTTP host: static assets, the WebSocket relay tunnel, optional WebTransport and TURN gateways. |

## 2. Components

### 2.1 `zp-engine` (Rust transformation facade)

[`crates/zp-engine`](../crates/zp-engine) is the single native API over [`zp-rewriter`](../crates/zp-rewriter), [`zp-htmltx`](../crates/zp-htmltx), [`zp-css`](../crates/zp-css), and [`zp-shared`](../crates/zp-shared). `TransformEngine` owns a reusable rewriter arena for full-source and patch-envelope rewrites. Its script methods take a typed `ScriptKind`; the string names (`"classic"`, `"module"`, `"worker"`, ...) are parsed by `parse_script_kind` at the JavaScript boundary only. Errors are `EngineError` (`UnknownScriptKind`, `Rewrite`, `Html`, `Css`). Rewrites fail closed: there is no option to let an unparsable script through.

- **Service Worker bundle ([`zp-bundle`](../crates/zp-bundle))** exports thin `wasm-bindgen` shims over a thread-local `TransformEngine`: `bundleVersion`, `rewriteScript`, `rewriteScriptPatches`, `composeSourceMap`, `composeSourceMapChained`, `transformHtml`, `HtmlTxn`, `rewriteCSS`, `buildCSP`, `buildCSPWith`, `isChallengeDocument`.
- **Native callers** link `zp-engine` directly for benchmarks or conformance tests.
- **Page-realm bundle ([`zp-page-bundle`](../crates/zp-page-bundle))** links `zp-rewriter` directly and exports only `bundleVersion` and `rewriteScript`. Keeping `lol_html` and SWC out of it holds `zp-page-bundle-wbg.wasm` under the 540 KB per-navigation budget.
- **CSS** (`zp_css::rewrite_css`) returns `Result<CssRewriteOutput, CssError>`.

### 2.2 `Dialer` seam in the transport kernel

[`crates/zp-kernel-bundle/src/dial.rs`](../crates/zp-kernel-bundle/src/dial.rs) holds the host-portable contract, so it compiles and is tested on every target:

- `AsyncIo`: the stream trait used by the connection pool.
- `TargetAddr`: host, port, and the isolation key.
- `DialError`: `RelaySession`, `TargetConnect`, and `Custom`, each with a wire code and detail.
- `Dialer`: opens a byte stream to a `TargetAddr`. Futures are `LocalBoxFuture` and the injected dialer is an `Rc`, because the kernel is single-threaded.
- `set_dialer`, `clear_dialer`, `injected_dialer`: the embedder hook.

[`kernel/transport/dialer.rs`](../crates/zp-kernel-bundle/src/kernel/transport/dialer.rs) (`wasm32` only, re-exported as `zp_kernel_bundle::dialer`) adds `RelayDialer`, the default: a shared yamux session over `/zp/ws-pipe` with a SOCKS5 `CONNECT` per stream. `dialer()` returns the injected dialer or a fresh `RelayDialer`. `fetch.rs` and `ws_client.rs` only see `Dialer`.

The rest of the kernel (TLS, HTTP, `JsValue` streams) targets `wasm32-unknown-unknown`. Its exports are `kernelVersion`, `kernelInit`, `kernelSetCapturedSpec`, `kernelFetch`, and `kernelStream`.

### 2.3 `web/membrane/` (virtual browser membrane)

The page membrane is 23 ordered fragments that [`scripts/build.mjs`](../scripts/build.mjs) concatenates into one IIFE (`dist/web/runtime-prelude.js`). They are concatenation units, not ES modules: the hooks share private lexical state in one closure.

| Fragment | Responsibility |
| :--- | :--- |
| `00-head.js`, `01-boot.js` | Entry, global scrub, boot config, native API capture, the private realm state `ctx`, and the public `realmHandle`. |
| `02-masking.js`, `02-trusted-types.js`, `03-urls.js` | Function `toString` branding, descriptor helpers, Trusted Types policy, share/proxy URL encoding, attribute URL policy. |
| `04-navigation.js`, `05-messaging.js` | Virtual `history`/`location`, the bridge adapter, and the Service Worker `postMessage` channel. |
| `06-install.js`, `07-membrane.js` | Installation runner, error stack sanitizer, core `window`/`location`/`document` membrane. |
| `08-http.js`, `09-nav-net.js`, `10-swless.js` | Virtual `fetch`, XHR, `WebSocket`, `EventSource`, beacon, client hints, popup/frame `postMessage`, SW-less fallback. |
| `11-cookies.js`, `12-storage.js` | Virtual cookie jar, `cookieStore`, `localStorage`, `sessionStorage`, IndexedDB, Cache Storage, OPFS, permissions. |
| `13-attrs.js`, `14-dom.js`, `15-scripts-css.js` | Attribute stashing (`data-zp-lit-*`), DOM insertion hooks, script/CSS rewriting, `importmap`, `<meta>` CSP intersection. |
| `16-policy.js`, `17-workers.js`, `18-iframes.js` | Subtree observers, `Worker`/`SharedWorker` bootstrap wrapping, cross-origin and sandboxed `iframe` containment. |
| `19-gateways.js`, `20-containment.js`, `21-surface.js`, `22-tail.js` | WebTransport and WebRTC TURN wrappers, network blockers, residual API guards, `__zp_realm` publication. |

**Realm handle.** The membrane keeps its mutable state (virtual URL, cookie jar, bridge, timers) in the closure. The only object it publishes to the page realm is `window.__zp_realm`, a frozen `ZPRealmHandle` ([`web/zp-core.d.ts`](../web/zp-core.d.ts)):

```ts
interface ZPRealmHandle {
  readonly tabId: string;
  readonly entryId: string;     // live: follows same-document navigation
  getVirtualURL(): string;
  getBaseURL(): string;
  setBridge(bridge: unknown): void;
  dispose(): void;
}
```

`__zp_realm` is hidden from page enumeration by `ZP_HIDDEN_RE`. A bridge factory passed to `ZP.configureBridge` receives this handle.

### 2.4 `zp-core.js` runtime table

`zp-core.js` publishes two non-enumerable globals:

- `ZP` is the frozen embedder contract described by [`web/zp-core.d.ts`](../web/zp-core.d.ts): share links, control/API/asset paths, the fetch envelope, the bridge protocol, and `configureBridge`.
- `__zp_internal` is the full table the Service Worker, worker prelude, membrane, and launcher page use (user-agent tables, CSP builders, Trusted Types helpers, site-frame helpers, the fetch response adapter, ...). Each consumer captures it into a closure binding and deletes the property; the membrane and the worker prelude also delete `ZP`, so target scripts cannot enumerate either. It carries no stability promise.

`test/js/core.test.js` pins that `Object.keys(ZP)` equals the members declared in `zp-core.d.ts`.

### 2.5 `pkg/httphost`, `pkg/wtproxy`, `pkg/rtcgw` (Go host)

The packages under [`pkg/`](../pkg) are the public Go surface. They define their own types (`Config`, `Server`, `TransportMode`, `TargetPolicy`, `TURNConfig`, `ICEServerCred`, `Listener`) and convert to the implementations in [`internal/`](../internal); none of the public types is an alias of an internal one.

- `httphost.NewServer(Config)` is the only constructor. It validates the configuration, so an unknown `TransportMode` or `TargetPolicy` is an error, and returns a `*Server` that is an `http.Handler` and an `io.Closer`.
- `TargetPolicy` decides whether direct egress may reach private targets: `TargetPolicyDefault` follows the transport (`-socks internal` permits them, `TransportDirect` and `-socks direct` block them), `TargetPolicyAllowPrivate` permits loopback and RFC 1918 targets, `TargetPolicyBlockPrivate` blocks them in every direct mode. Link-local and unspecified addresses are always blocked.
- `Config.RtcTURN` is a `*rtcgw.TURNServer`; nil disables the credential routes.
- [`cmd/zeroproxy-server`](../cmd/zeroproxy-server) parses the flags and assembles the optional WebTransport and TURN gateways. They dial directly (neither QUIC nor UDP can ride a SOCKS upstream), so the command lets them reach private targets only under `-socks internal` without `-disallow-private-targets`.

## 3. Wire contract

All proxy-owned routes live under `/zp/`. The Service Worker answers most `/zp/api/*` routes itself; the Go host answers the rest.

| Route | Method | Served by | Purpose |
| :--- | :--- | :--- | :--- |
| `/zp/` | GET | host | Launcher page (`index.html`). `/` redirects here. |
| `/zp/p/<encrypted>` | GET | host | Share route; serves the launcher, which opens the encrypted target. The key stays in the URL fragment. |
| `/zp/sw.js` | GET | host | Service Worker script; the launcher registers it with scope `/zp/`. |
| `/zp/Asset/<name>` | GET | host | Runtime assets, from an allowlist: `zp-core.js`, `runtime-prelude.js`, `worker-prelude.js`, `zp-page-bundle.js`, `favicon.ico`, `manifest.webmanifest` from `dist/web/`, and `zp-bundle.js`, `zp-bundle.wasm`, `zp-kernel.js`, `zp-kernel.wasm`, `zp-rt.wasm` from `dist/web/Asset/`. Any other name is `403`. |
| `/zp/api/v2/fetch` | POST | Service Worker | Runtime `fetch` from a page or worker. Body is the binary envelope below; the response carries `X-ZP-Fetch-Meta`. |
| `/zp/api/v2/fetch?url=<target>` | GET | Service Worker | Element subresources (rewritten CSS `url()` and `@import`, media playlists) and iframe navigations. |
| `/zp/api/sync-fetch?u=<target>&...` | GET | host + Service Worker | Synchronous XHR bridge. A Service Worker cannot intercept a synchronous XHR, so the page issues it against this same-origin route and the host parks the request. |
| `/zp/api/sync-fetch/poll`, `/zp/api/sync-fetch/result` | GET, POST | host | The Service Worker long-polls `poll` for parked jobs and answers each with a POST to `result`: `X-ZP-Sync-*` headers carry the metadata and the body is the raw response bytes. |
| `/zp/api/script?u=<url>&kind=<kind>` | GET | Service Worker | Server-side rewrite of `<script src>` and `import()` targets. |
| `/zp/api/worker-script` | GET | Service Worker | Rewritten worker script behind the worker bootstrap. |
| `/zp/api/sourcemaps?u=<url>&k=<kind>` | GET | Service Worker | Source Map v3 composed for a rewritten script. |
| `/zp/api/csp-report` | POST | host | Sink for CSP violation reports; answers `204`. |
| `/zp/api/config` | GET | host | Runtime configuration read by the Service Worker: WebTransport gateway URL and pin, TURN credentials. |
| `/zp/worker-bootstrap.js` | GET | host | Bootstrap that loads the worker prelude and the rewritten worker script. |
| `/zp/error/<code>` | GET | host | Isolated error page for a pinned error code. |
| `/zp/ws-pipe` | GET (WebSocket) | host | The relay tunnel: yamux streams, each bridged to a SOCKS5 `CONNECT`. Same-origin only. |
| `/zp/wt` | CONNECT (HTTP/3) | `-wt-addr` listener | WebTransport gateway. On the TCP listener the route answers `501 WT_UNSUPPORTED`. |
| `/zp/rtc/turn-credentials` | GET | host | One short-lived TURN credential tuple; `501 RTC_GATEWAY_UNAVAILABLE` without an embedded TURN server. |
| `/zp/rtc/offer` | any | host | Always `501 RTC_GATEWAY_UNAVAILABLE`: WebRTC is relay-only through the TURN server and has no signaling bridge. |

Any other path is refused with `403 POLICY_BLOCKED`. There are no redirects from older layouts: `/p/...`, `/sw.js`, `/index.html`, `/__zp/*`, `/zp/assets/*`, `/zp/api/fetch`, `/zp/api/sourcemap`, and `/zp/api/rtc/signal` are all refused.

**Fetch envelope** (`ZP.encodeEnvelope` / `ZP.decodeEnvelope`, content type `application/zp-envelope`):

```text
[u32 little-endian head length][JSON head][raw body]
```

The head names the tab, entry, target URL, and request init (method, headers, credentials, mode, redirect, referrer); the body is the request body, unencoded. A malformed length is `BAD_ENVELOPE` and answers `400 MALFORMED_ROUTE`. Upstream HTTP errors still carry `X-ZP-Fetch-Meta`, so a target's own `404` is distinguishable from a missing route.

## 4. Rewriter and membrane ABI

`zp-rewriter` emits calls to global helpers that the membrane (`web/membrane/`) and the worker prelude install on the real global object. `RUNTIME_HELPERS` in [`crates/zp-rewriter/src/lib.rs`](../crates/zp-rewriter/src/lib.rs) is the authoritative list; `ZP_WITH_HELPERS` in `web/membrane/00-head.js` and `web/worker-prelude.js` must match it (`test/js/static-policy.test.js` compares them).

| Group | Helpers |
| :--- | :--- |
| Property, call, and operator traps | `__zp_get`, `__zp_set`, `__zp_call`, `__zp_this`, `__zp_assign`, `__zp_update`, `__zp_delete`, `__zp_has`, `__zp_fast`, `__zp_fastset` |
| Optional-chain and receiver traps | `__zp_oget`, `__zp_ocall`, `__zp_ocallv`, `__zp_ochain`, `__zp_odelete`, `__zp_okeys`, `__zp_rget`, `__zp_rset` |
| Reflect and `Object` introspection | `__zp_ownKeys`, `__zp_getOwnPropertyDescriptor`, `__zp_getOwnPropertyDescriptors`, `__zp_getOwnPropertyNames` |
| Modules | `__zp_module_url` |
| `with` scopes | `__zp_with_get`, `__zp_with_set`, `__zp_with_assign`, `__zp_with_update`, `__zp_with_delete`, `__zp_with_d` |
| Lexical registry and dynamic code | `__zp_lex_decl`, `__zp_lex_bind`, `__zp_export_vars`, `__zp_eval` |

Inline scripts and handlers run through `__ZP_EXEC_INLINE_SCRIPT`, `__ZP_EXEC_INLINE_MODULE`, `__ZP_EXEC_INLINE_REWRITTEN`, `__ZP_EXEC_INLINE_REWRITTEN_MODULE`, and `__ZP_EXEC_EVENT`.

Two rules protect the ABI. A page cannot bind or assign a name in `RUNTIME_HELPERS` or a `__ZP_*` name (`reserved_name_violation`), because the helpers receive the real global object. And the helpers are non-enumerable and masked from `Object.keys`, `Reflect.ownKeys`, and `for..in` (`ZP_HIDDEN_RE`).

## 5. WebAssembly ABIs

**`zp-page-rt`** is a raw `extern "C"` module (no `wasm-bindgen`) loaded by [`web/zp-rt.js`](../web/zp-rt.js). Exports return only `u32` or `u64`. The URL pool is append-only: handle = index + 1, `0` means invalid, and handles survive until `pool_reset`.

- `bulk_intern_and_classify(lens_ptr, count, bytes_ptr, out_ptr)` writes one `u32` per URL: `(class & 0xF) << 28 | (handle & 0x0FFF_FFFF)`. The class is 4 bits (`UrlClass` has 11 values) and the handle gets 28 bits, so the pool stops issuing handles at `0x0FFF_FFFF` rather than truncating. JS decodes with `batchClass(p) = p >>> 28` and `batchHandle(p) = p & 0x0FFFFFFF`.
- Two URLs whose 64-bit hashes collide keep distinct handles: colliding entries are chained and compared byte by byte.
- The pool and packing logic compile and are tested on the host (`crates/zp-page-rt/src/pool.rs`); only the exports are `wasm32`-only.

**`zp-kernel-bundle`** exports `kernelVersion`, `kernelInit`, `kernelSetCapturedSpec`, `kernelFetch`, and `kernelStream` (section 2.2). **`zp-bundle`** and **`zp-page-bundle`** export the `wasm-bindgen` surface in section 2.1.

## 6. Embedding

### 6.1 JavaScript: custom membrane bridge

Call `ZP.configureBridge(win, bridgeOrFactory)` before evaluating `dist/web/runtime-prelude.js` to carry the membrane's control messages without a Service Worker controller. The factory receives the realm handle. After evaluation `win.__zp_realm` supports `setBridge` and `dispose`:

```js
ZP.configureBridge(win, (realm) => ({
  send: (msg) => Promise.resolve({ ok: true /* reply fields */ }),
  onMessage: (fn) => myChannel.on('data', fn), // optional inbound listener
  dispose: () => myChannel.close(),            // optional cleanup
}));

// After the prelude ran in the realm:
win.__zp_realm.setBridge(nextBridge);
win.__zp_realm.dispose();
```

Without a configured bridge the membrane uses the Service Worker `postMessage` channel.

### 6.2 Rust: native transformation engine

```rust
use zp_engine::{DocCtx, ScriptKind, TransformEngine};

let mut engine = TransformEngine::new();
let ctx = DocCtx::new(target_url, proxy_origin).with_control_prefix("/zp/");

let rewritten_js = engine.rewrite_script(src, ScriptKind::Classic, &ctx)?;
let patch_json = engine.rewrite_script_patches_json(src, ScriptKind::Module, &ctx)?;
let transformed_html = engine.transform_html(html, &ctx)?;

let mut txn = engine.html_txn(&ctx, &prelude);
txn.write(chunk)?;
txn.end()?;

let rewritten_css = engine.rewrite_css_with_ctx(css, base_url, &ctx)?;
let csp_header = engine.build_csp_with(ws_origin, challenge_compat);
```

### 6.3 Rust (WASM): custom transport dialer

```rust
use std::rc::Rc;
use futures_util::future::LocalBoxFuture;
use zp_kernel_bundle::dial::{set_dialer, AsyncIo, DialError, Dialer, TargetAddr};

struct CustomDialer;

impl Dialer for CustomDialer {
    fn connect<'a>(
        &'a self,
        target: &'a TargetAddr,
        relay_url: &'a str,
    ) -> LocalBoxFuture<'a, Result<Box<dyn AsyncIo>, DialError>> {
        // Return a boxed AsyncIo stream connected to `target`.
    }
}

set_dialer(Rc::new(CustomDialer));
```

### 6.4 Go: embeddable HTTP server

```go
srv, err := httphost.NewServer(httphost.Config{
    WebDir:       "dist/web",
    Transport:    httphost.TransportSOCKS5,
    SocksAddr:    "127.0.0.1:9050", // or TransportDirect for direct TCP
    TargetPolicy: httphost.TargetPolicyDefault,
})
if err != nil {
    log.Fatal(err)
}
defer srv.Close()
// srv is an http.Handler: mount it on any server, router, or middleware stack.
```

See [`pkg/httphost/httphost_test.go`](../pkg/httphost/httphost_test.go) and [`internal/httphost/example_test.go`](../internal/httphost/example_test.go).

## 7. Invariants

- **Containment**: target code never obtains native networking, the real `window` or `Location`, another origin's cookies, storage, or DOM, or the proxy control surface, and unrewritten code never runs. Rewrite failures fail closed (a script that fails to parse is replaced by a throw; an event-handler attribute is removed).
- **One wire contract**: every proxy-owned route is under `/zp/` and appears in the table in section 3. There are no fallbacks to older routes or response formats.
- **No stability promise beyond `ZP`, `ZPRealmHandle`, the routes above, and the ABIs in sections 4 and 5.**

Intentional boundaries:

- **Worker and page preludes stay separate.** [`web/worker-prelude.js`](../web/worker-prelude.js) has its own transport and global-surface hooks because worker bootstrap scripts have no DOM and use dedicated worker-to-Service-Worker channels.
- **The transport pipeline above the `Dialer` is `wasm32`-bound.** TLS, HTTP, and `JsValue` streams run only in the browser.
- **`performance.timeOrigin` is not virtualized.** This is a documented compatibility trade-off (gate D7 in [`containment-gates.md`](containment-gates.md)).
