# ZeroProxy Embedding Refactor — Architecture Plan

**Status:** in-progress design + execution record.
**Constraint:** behavioral compatibility is absolute — every step keeps
`test:js` (102), `static-policy` (57), `cargo test --workspace`, and
`test:e2e` (181) green. The wire contract (`/zp/api/*` routes, `/__zp/*`
control paths, `ZP_*` message types, wasm export names, `dist/web` file
layout) is **frozen** — embedders and existing deployments share it.

## 1. Goal

Turn ZeroProxy from a single-purpose server+browser product into
embeddable components:

- **Virtual browser membrane** — a realm factory that virtualizes
  `location`/`window`/storage/network surface on any `window` or
  `WorkerGlobalScope` the host supplies, driven by an injected context
  object instead of page-globals and ServiceWorker postMessage alone.
- **Network backend** — a `Transport`/`Dialer` abstraction in the Rust
  kernel so hosts can swap egress (SOCKS5+Tor today; direct dial,
  CONNECT, in-process fake, or custom egress tomorrow) without touching
  the fetch/stream code paths.
- **Transform engine** — a `zp-engine` facade crate exposing
  rewrite/transform/sourcemap as a plain library, usable natively
  (non-wasm) for server-side prerender or test harnesses.
- **Host orchestration** — the service worker and Go listener become
  thin adapters over the three layers above.

Non-goals: no wire-protocol changes, no rewrite-semantics changes, no
changes to the Phase-2 isolation model.

## 2. Current coupling (measured)

| Point | Coupling | Embedding barrier |
|---|---|---|
| `web/runtime-prelude.js` (~10.7k LOC) | module-scope mutable state (`virtualURL`, `baseURL`, `activeEntryId`, `boot`, `activeServers`, `proxyOrigin`, `originHash`) read by ~60 `install*` functions | realm state is ambient; no injectable entry point |
| `postMessageToSW` | hard-wired to `navigator.serviceWorker.controller.postMessage`; 15 `ZP_*` message types | unusable where no SW controller exists |
| `web/sw.js` (~3.6k LOC) | route table + classification + transport + runtime API + worker bootstrap + message protocol in one file | no partial adoption |
| `web/worker-prelude.js` | surface-virtualization rules duplicated from the page prelude | drift risk (W8–W12 were ported by hand) |
| WASM bundles | `zp-bundle` (SW eager: rewriter/htmltx/css/sourcemap/csp) · `zp-kernel-bundle` (lazy: fetch/stream/WS/transport) · `zp-page-bundle` (page rewriter) · `zp-page-rt` (raw-ABI hot policy) | exports are the de-facto ABI but undocumented |
| `cmd/zeroproxy-server` | listener + WS bridge + sync-fetch relay + CSP report + gateway flags in `main.go` | not importable as a library |
| fetch envelope | `body` carried as base64-in-JSON | ~33% wire overhead + encode CPU |

## 3. Target architecture

```
┌─ zp-core ──────── zp-shared, zp-transport-codec, web/zp-core.js  (unchanged)
├─ zp-engine ────── Rust facade: rewriter + htmltx + css + sourcemap
│                    feature "wasm" → identical export names
│                    feature "native" → plain lib for hosts/tests
├─ zp-transport ─── Rust: trait Dialer + trait Transport
│                    default impl = today's kernel (SOCKS5+rustls+yamux+h1/h2)
│                    embedders inject Dialer (direct/Tor/CONNECT/in-memory)
├─ zp-membrane ──── JS: createRealm(scope, ctx) factory
│                    ctx = { targetURL, proxyOrigin, tabId, entryId,
│                            bridge, transport, rewriter, ... }
│                    all mutable realm state lives on ctx — no page globals
└─ zp-host ──────── orchestration
                     web/sw.js        → thin SW adapter (routes + dispatch)
                     internal/httphost→ NewHandler(Config) http.Handler
                     zeroproxy-server → flag parsing + assembly only
```

### 3.1 Layer 1 — `zp-engine` (Rust facade)

Single facade over `zp-rewriter`, `zp-htmltx`, `zp-css`, sourcemap
composition:

```rust
pub struct DocCtx { pub target_url: String, pub proxy_origin: String, /* flags */ }
pub struct TransformEngine { /* owns RewriterInstance arena (reuse kept) */ }
impl TransformEngine {
    pub fn rewrite_script(&mut self, src: &str, kind: Kind, ctx: &DocCtx) -> Result<Patches>;
    pub fn transform_html(&mut self, ctx: &DocCtx, prelude: &str) -> HtmlStream; // streaming
    pub fn rewrite_css(&mut self, src: &str, ctx: &DocCtx) -> Result<String>;
    pub fn compose_source_map(&mut self, ...) -> Result<String>;
}
```

- `feature = "wasm"`: `zp-bundle` keeps exporting the same names
  (`rewriteScriptPatches`, `transformHtml`, `HtmlTxn`, `rewriteCSS`,
  `buildCSP*`, `isChallengeDocument`, `composeSourceMap*`) — implemented
  as thin shims over `zp-engine`. `web/sw.js` is untouched.
- `feature = "native"`: hosts link the engine without wasm for
  server-side transform or conformance harnesses.

### 3.2 Layer 2 — `zp-transport` (network backend)

The kernel transport stack (`kernel/transport/*`: socks5, tls, http1,
http2, pool, yamux, ws_client, ws_stream) moves behind two traits:

```rust
#[async_trait]
pub trait Dialer: Send + Sync {
    async fn connect(&self, target: &TargetAddr, tls: &TlsProfile)
        -> io::Result<Box<dyn AsyncIo>>;
}

pub trait Transport: Send + Sync {
    fn fetch(&self, req: FetchRequest) -> BoxStream<'static, Result<ResponseChunk>>;
    fn open_stream(&self, kind: StreamKind, req: StreamRequest)
        -> BoxFuture<'static, Result<Duplex>>;
    fn cookie_jar(&self) -> &CookieJar;
}
```

- Default `KernelTransport` = today's pipeline (SOCKS5 → TLS → h1/h2 →
  yamux pool), including JA3 capture and cookie jar — zero behavior delta.
- `kernelFetch`/`kernelStream`/`kernelCookieSet`/`kernelSetCapturedSpec`
  exports keep their signatures; internally they call
  `TRANSPORT.fetch(...)` on a lazily-installed `KernelTransport`.
- Embedders construct `KernelTransport::with_dialer(my_dialer)` for
  custom egress; wasm embedders may also implement `Transport` directly.

### 3.3 Layer 3 — `zp-membrane` (virtual browser component)

Source split (build-time only — `dist/web` artifacts stay identical;
`scripts/build.mjs` concatenates the fragments sorted with `\n` before
esbuild). The fragments are **concatenation units of a single IIFE**, not
ES modules — closure state is the realm state, by design:

```
web/membrane/
  00-head.js       — IIFE open, global-scrub, boot, Native capture, ctx
  01-boot.js       — readBootConfig / clearBootConfig / captureNative
  02-masking.js    — define*/mask*/toString machinery, brandLikeNative
  03-urls.js       — share/proxy URL helpers, URL-classify, attr policy
  04-navigation.js — virtual history/location set, nav activation
  05-messaging.js  — postMessageToSW, BridgeAdapter, keepalive, window.name
  06-install.js    — __zpStep install sequence + stack sanitizer
  07-membrane.js   — installPhase2Membrane: virtual window/location/document
  08-http.js       — fetch/XHR/HTTP APIs, WebSocket, WebSocketStream
  09-nav-net.js    — beacon, protocol handlers, nav traps, navigator id,
                     UA/brands, chrome fingerprint, popup + postMessage hooks
  10-swless.js     — SW-less relay path + navigation backstop
  11-cookies.js    — cookie records + virtual cookieStore
  12-storage.js    — storage facades, IDB, caches, CE ns, permissions, PA
  13-attrs.js      — link/attr policy, zp-attr ns, dataset, collections,
                     deproxy, script stash, clone/serialize
  14-dom.js        — installStealthMembrane, installDOMHooks
  15-scripts-css.js— script proxy path, CSS rewrite, TypedOM, style hooks,
                     inline wrappers, srcset, importmap, document.write,
                     meta policy, transformHTML, bootJSON
  16-policy.js     — base observer + enforce* subtree policies
  17-workers.js    — Worker/SharedWorker hooks, bootstrap URL, SW blocker
  18-iframes.js    — iframe hooks, frame instrumentation, resize shim
  19-gateways.js   — WebTransport/RTC/virtual-gateway constructors
  20-containment.js— network containment + installBlockers
  21-surface.js    — residual surface guards
  22-tail.js       — canvas/audio anti-fingerprint, __zp_realm, IIFE close
```

Embedding surface (additive — page path unchanged):

```js
// host-driven realm wiring — the prelude still auto-installs on load;
// embedders supply the channel BEFORE evaluation:
win.__zp_bridge_factory = (ctx) => ({
  send: (msg) => Promise.resolve({ ok: true, … }),
  onMessage: (fn) => channel.on('data', fn),  // optional inbound
});
// after evaluation: win.__zp_realm is the live RealmCtx handle
// (boot/virtualURL/baseURL/activeRouteKey/documentCookie/…, bridge).
```

Worker prelude keeps its own prelude file this round — full
worker/page surface dedup is deferred (see §6).

### 3.4 Layer 4 — `zp-host`

- `web/sw.js` keeps only: classification, route table, `ZP_*` message
  dispatch, CSP/doc-response wiring, worker-bootstrap synthesis. Engine
  and transport calls delegate to the facade objects so a different host
  can reuse the same table.
- Go: new `internal/httphost` package exports
  `NewHandler(Config{Addr, WebRoot, Socks, WtGateway, RtcGateway, …})
  http.Handler`. `cmd/zeroproxy-server/main.go` becomes flag parsing +
  handler assembly.

## 4. Migration steps (each lands green)

| Step | Change | Risk | Gate |
|---|---|---|---|
| R1 | Route-table + `ZP_*` message constants → `zp-core.js` single source | low | unit+static |
| R2 | Prelude ambient state → `ctx` object; expose `__zpCreateRealm` embed entry (auto-boot preserved) | medium | full matrix |
| R3 | `runtime-prelude.js` → `web/membrane/*` modules; esbuild single-file output identical | medium-high (install-order TDZ) | full matrix |
| R4 | `Dialer`/`Transport` traits in kernel; default impl = current pipeline | low | cargo+static |
| R5 | `zp-engine` facade crate; `zp-bundle` exports become shims | low | cargo+static+e2e |
| R6 | `BridgeAdapter` — prelude calls `ctx.bridge.send`; SW channel is impl #1 | low-medium | full matrix |
| R7 | `internal/httphost` package; `main.go` slim | low | go test+e2e |
| R8 | Embedding example + contract doc (`EMBEDDING.md` content folded here) | — | review |

Deferred (documented, not in this round):
- Full worker/page surface unification beyond shared helpers
  (worker-prelude keeps its transport specifics).
- performance-timeOrigin virtualization remains intentionally pinned to
  real values (D7 tradeoff).

## 5. Compatibility guarantees

1. **Wire contract frozen**: `/zp/api/{fetch,script,worker-script,sourcemap,sync-fetch,…}`, `/__zp/*` control paths, `worker-bootstrap.js` hash params (`u`,`ref`,`tab`,`srcu`,`mod`,`server`,`wtg`,`rtcg`,`ice`), `ZP_*` postMessage types, wasm export names, `dist/web` layout. `/zp/api/v2/fetch` was added additively (R9) — the v1 path keeps its exact semantics.
2. **Every step is an internal-move commit**; behavior changes are forbidden inside refactor commits.
3. Regression net = the full matrix after each step; e2e count must stay ≥181.
4. Trap-notebook consulted for each touched file; new traps recorded on
   fix.

## 6. Execution log

- **R0** — this document.
- **R1 (landed)** — `ZP.MSG` frozen map added to `web/zp-core.js`; all
  `ZP_*` message-type literals in `sw.js` / `runtime-prelude` (now
  `web/membrane/*`) / `index.html` reference the single source.
- **R2 (landed)** — ambient realm state aggregated into a live-view
  `ctx` object (`web/membrane/00-head.js`); `root.__zp_realm` handle
  exposed at end of install (`22-tail.js`). The `__zp_` name keeps it
  inside the `ZP_HIDDEN_RE` scrub, so enumeration surfaces stay clean.
- **R3 (landed)** — `web/runtime-prelude.js` split into 23 concat
  fragments under `web/membrane/`. They are *concatenation units of one
  IIFE*, not ES modules — shared closure state is intentional (it IS the
  realm). `scripts/build.mjs` joins them sorted with `\n`;
  `test/js/_prelude.cjs::preludeSource()` mirrors the rule; build-id now
  hashes every fragment.
- **R4 (landed)** — `kernel/transport/dialer.rs`: `AsyncIo` marker trait,
  `TargetAddr`, `Dialer` (`LocalBoxFuture`, wasm single-thread model),
  `RelayDialer` (today's yamux→SOCKS5 verbatim), `set_dialer` embedder
  hook. `PooledConn` generalized from `MuxStream` to `Box<dyn AsyncIo>`;
  `fetch.rs::open_fresh` and `ws_client::open_target_stream` both route
  through `dialer()`. Error codes identical (`jserr` reused).
- **R5 (landed)** — `crates/zp-engine` facade crate (`DocCtx`,
  `EngineError`, `parse_script_kind`, `patches_to_json`,
  `TransformEngine` w/ arena-reusing `RewriterInstance`). `zp-bundle`
  wasm exports are now thin shims over a thread-local shared engine —
  export names and error strings unchanged. `zp-page-bundle`
  intentionally NOT converted: pulling `zp-engine` would drag
  `zp-htmltx`(lol_html)+`zp-css`(SWC) into the page bundle and undo the
  E3 size win; it shares `zp-rewriter` directly instead.
- **R6 (landed)** — `ctx.bridge` adapter in `web/membrane/05-messaging.js`.
  Default impl = existing `postMessageToSW` (token sealing + `{ok,error}`
  reply contract). Embeddable hook: `root.__zp_bridge_factory(ctx)` →
  `{send, onMessage?}` evaluated before install; custom bridges get
  unsealed messages and own their auth. Inbound `ENCODED_SIZE` routed via
  `onBridgeMessage` (SW listener + optional `bridge.onMessage`).
- **R7 (landed)** — `internal/httphost` package owns the HTTP surface
  (`NewHandler(Config) http.Handler`; server struct + ws-pipe bridge +
  sync-fetch hub + CSP report + SOCKS5 parser moved verbatim). `main.go`
  is flag parsing + gateway assembly only. Go tests moved with the code.
- **R8 (landed)** — `internal/httphost/example_test.go` embed example;
  contract doc = §7 below.
- **R9 (landed)** — `POST /zp/api/v2/fetch`: binary fetch envelope
  `[u32le headLen][JSON head][raw body]` (`ZP.encodeEnvelope` /
  `ZP.decodeEnvelope` in `zp-core.js`, MIME `application/zp-envelope`).
  The head keeps the v1 payload shape minus `init.body`; the raw tail is
  the body — removes the base64 33% wire inflation and the encode/decode
  CPU on the page↔SW hop. `/zp/api/fetch` stays frozen (GET `?url=` form
  untouched; v2 is POST-only). Negotiation is self-serving: the page tries
  v2 first; a 404 *without* `X-ZP-Fetch-Meta` means a pre-v2 SW answered
  (unmatched `/zp/api/*` → `POLICY_BLOCKED` 404), so the realm downgrades
  to v1 for its lifetime (`v2FetchOK` in `08-http.js`, mirrored in
  `worker-prelude.js`). A real upstream 404 always carries
  `X-ZP-Fetch-Meta`, so the discriminator is unambiguous. Senders:
  `fetchThroughRuntime`, `fetchLater` keepalive, worker `self.fetch` — all
  through `postRuntimeEnvelope`/equivalent. Deproxy matchers
  (`encodedSizeKey`, resource-timing `?url=` labels, srcset guard) accept
  both paths.

### Deferred (unchanged by this refactor)

- **Worker/page surface dedup** — membrane fragments are concat units,
  not importable modules; `worker-prelude.js` keeps its own copies.
  Converting to ES modules requires `ctx`-parameterizing ~60 install
  functions — a later, larger pass.
- **Transport trait for fetch/stream** — `Dialer` covers the raw-byte
  seam (the embedder-critical part). A full `Transport` trait covering
  fetch/stream/cookie-jar is deferred; kernel is wasm-only today.
- `performance.timeOrigin` stays real (documented D7 tradeoff).

## 7. Embedding contract (as built)

### JS — virtual browser membrane

```js
// host sets the bridge factory BEFORE evaluating the prelude source:
win.__zp_bridge_factory = (ctx) => ({
  send: (msg) => Promise.resolve({ ok: true, /* reply fields */ }),
  onMessage: (fn) => myChannel.on('data', fn),   // optional
});
// evaluate web/membrane concat (or dist/web/runtime-prelude.js) inside
// the realm; afterwards:
win.__zp_realm            // live ctx handle: virtualURL, baseURL,
                          // activeRouteKey, documentCookie, …
win.__zp_realm.bridge     // the installed bridge
```

Without a factory the membrane uses the SW controller channel — fully
backwards compatible with the shipped product.

### Rust — transform engine

```rust
let mut engine = zp_engine::TransformEngine::new();
let ctx = zp_engine::DocCtx::new(target_url, proxy_origin);
engine.rewrite_script(src, "classic", &ctx)?;          // String
engine.rewrite_script_patches_json(src, kind, &ctx)?;  // patch envelope
engine.transform_html(html, &ctx)?;                    // one-shot
let mut txn = engine.html_txn(&ctx, &prelude);         // streaming
txn.write(chunk)?; txn.end()?;
engine.rewrite_css(css, base_url, "/zp/", &ctx)?;
engine.build_csp_with(ws_origin, challenge_compat);
```

### Rust — transport dialer (kernel crate, wasm)

```rust
struct MyDialer;
impl zp_kernel_bundle::kernel::transport::dialer::Dialer for MyDialer {
    fn connect<'a>(&'a self, t: &'a TargetAddr, relay: &'a str, t0: f64)
        -> LocalBoxFuture<'a, Result<Box<dyn AsyncIo>, JsValue>> { … }
}
zp_kernel_bundle::kernel::transport::dialer::set_dialer(Rc::new(MyDialer));
```

### Go — HTTP host

```go
handler := httphost.NewHandler(httphost.Config{
    WebDir: "dist/web", SocksAddr: "internal" /* or 127.0.0.1:9050 */,
})
// mount under your own mux/listener/TLS/middleware stack.
```

### Frozen wire contract (do NOT break)

`/zp/api/{fetch,v2/fetch,script,worker-script,sourcemap,sync-fetch*,csp-report,config}`,
`/zp/assets/*`, `/__zp/*` wasm artifacts, `/zp/p/<share>` routes,
`worker-bootstrap.js` hash params (`u`,`ref`,`tab`,`srcu`,`mod`,`server`,
`wtg`,`rtcg`,`ice`), `ZP_*` message types (`ZP.MSG` is the single source),
wasm export names (`rewriteScript*`, `transformHtml`, `HtmlTxn`,
`rewriteCSS`, `buildCSP*`, `isChallengeDocument`, `kernel*`), `dist/web`
file layout.
