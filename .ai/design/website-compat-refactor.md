# Website Compatibility Design and Refactor Tracks

This document defines the architecture, layer ownership boundaries, and refactor tracks (`R0` through `R5`) for improving real-world website compatibility while preserving ZeroProxy's containment guarantees. Resolved defects and open residuals are tracked in [`ERRATA.md`](../../ERRATA.md) and [`PHASE2_STATUS.md`](../../PHASE2_STATUS.md).

## 1. Core Compatibility Mechanisms

The transport layer, Service Worker, and page membrane enforce the following compatibility contracts:

- **Request Snapshots and Per-Hop Redirect Handling**: `transportFetch` in [`web/sw.js`](../../web/sw.js) snapshots the document context, history entry, referrer, and request body view before delegating each hop to `transportFetchHop`. Redirects preserve HTTP methods, replayable request bodies (307 and 308), headers, and cookie credentials.
- **Fetch Metadata and Response Identity**: Page and worker `fetch` calls forward the active entry, document URL, `credentials`, `mode`, `redirect`, and `referrerPolicy`. `manual` and `error` redirect modes, final response URLs, `clone()`, and opaque responses preserve native `Response` identity.
- **Window Method Binding and Receiver Preservation**: Native `window` methods execute with the expected receiver while preserving function identity, constructor semantics, and `this` bindings for page-defined functions ([trap notebook](../trap-notebook/rewriter.md)).
- **WebSocket Closing Lifecycle**: Open WebSockets do not impose an artificial idle timeout. Only the closing handshake applies a Service Worker-owned 30-second upper bound; if the peer never responds, `WsClient.abort()` terminates the underlying transport via `surface_close(1006)` ([trap notebook](../trap-notebook/sw-integration.md)).
- **ES Module Singleton Identity**: Static `import` declarations and dynamically inserted `<script type="module">` elements evaluate a shared module URL once and preserve singleton identity across `history` state changes.
- **Streaming Response Marker Isolation**: The kernel strips any upstream `X-ZP-Body-Stream` or `X-ZP-Stream` headers and sets internal streaming markers exclusively from actual kernel transport state, aligning completion lifetimes across buffered responses, raw streams, truncated bodies, and progressive HTML transforms.

## 2. Layer Ownership Boundaries

Compatibility changes must respect the following component boundaries:

- **Rust/WASM Layer**: Comprises `zp-shared` (shared policy and URL encryption), `zp-rewriter` (OXC AST rewriting), `zp-htmltx` and `zp-css` (HTML and CSS transformations), `zp-kernel-bundle` (SOCKS5, TLS, HTTP/1.1, HTTP/2, and WebSockets), `zp-transport-codec` (wire codecs), and `zp-engine` (unified transform facade).
- **Page Bundle vs. Service Worker Bundle Separation**: Synchronous page URL policy uses the raw WASM ABI in `zp-page-rt` and `web/zp-rt.js`, dynamic page script rewriting uses `zp-page-bundle`, and Service Worker transformations use `zp-bundle`. Never add TLS or HTTP transport dependencies to `zp-page-bundle`, which must stay under the 500 KB per-navigation size ceiling.
- **JavaScript Layer**: [`web/sw.js`](../../web/sw.js) coordinates request classification and tab state, while [`web/membrane/`](../../web/membrane), [`web/worker-prelude.js`](../../web/worker-prelude.js), and [`web/zp-core.js`](../../web/zp-core.js) wrap native browser APIs and enforce realm containment.
- **Go Host Layer**: [`internal/httphost`](../../internal/httphost) and [`cmd/zeroproxy-server`](../../cmd/zeroproxy-server) serve static assets, bridge WebSocket byte pipes to SOCKS5, relay synchronous XHR tasks, and host optional WebTransport and TURN gateways. Never move target HTTP parsing, TLS termination, cookie storage, or HTML rewriting into the Go server.
- **Single Source of Truth for Policy**: Reuse `url_surfaces.json`, build-time policy projections ([`scripts/build.mjs`](../../scripts/build.mjs)), the lazily loaded transport kernel, and streaming `HtmlTxn` transforms. Do not introduce duplicate URL attribute lists or secondary rewrite engines.

## 3. Compatibility Refactor Tracks (`R0` to `R5`)

Each track targets a distinct subsystem contract and verification boundary.

| Track | Scope and Invariants |
| :--- | :--- |
| **R0** | Document authoritative component ownership and supported, blocked, and unsupported browser contracts so stale notes never override live code. |
| **R1** | Separate document identity (generation ID), `history` URL, effective `<base>` URL, and per-request snapshots. Attribute requests to the right document across tabs opening the same URL, child frames, and Service Worker restarts without falling back to URL-keyed maps. |
| **R1-S** | Apply OXC semantic scope and reference analysis with typed AST lowering. Preserve variable declarations, hoisting, TDZ, function receivers, evaluation counts, short-circuiting, `Reflect` semantics, and classic/module/`eval` scoping rules. |
| **R2** | Consolidate request, redirect, and cookie policies in the shared Rust layer. Preserve method and body replay, credentials, `manual`/`error` redirects, target-to-target CORS, Public Suffix List (PSL) domain checks, `SameSite`, storage partitioning, and cookie revisions. |
| **R3** | Decouple native realm hook installation from `Document` generation. Guarantee containment before first script execution, idempotent hook installation, native brand/receiver/`postMessage` source preservation, WebSocket close lifetimes, and classic/module/shared worker identity. |
| **R4** | Unify URL resolution, proxy route encoding, first `<base>` handling, module and `importmap` identity, and static/dynamic markup transforms while preserving raw text, HTML entities, SVG attributes, `srcset`, and document character encodings. |
| **R5** | Unify HTTP/1.1 and HTTP/2 header, body stream, completion, cancellation, and error lifecycles. Minimize time-to-first-byte for SSE and media streams, enforce bounded backpressure, propagate immediate stream cancellation, and clean up decoders and Service Worker lifetimes. |

### Detailed Track Rules

- **Incremental Path Migration**: Migrate one complete call path end-to-end and delete the obsolete branch before starting the next. Keep pure file-move commits separate from behavioral changes.
- **R1 (Service Worker Restart Safety)**: Never assume client heartbeats prevent Service Worker termination. When context recovery fails, fail closed rather than guessing another active tab or leaking encryption keys or capabilities to the target server.
- **R2 (Target-Origin CORS and Session Continuity)**: Proxy-origin delivery headers are distinct from target-to-target CORS access checks. Relabeling `Response.type` as `cors` or `opaque` without enforcing actual cross-origin read restrictions does not satisfy target CORS isolation. Preserve IndexedDB cookie store compatibility across schema updates so existing login sessions are not wiped.
- **R3 (Idempotent Hook Installation and Raw ABI Memory)**: Distinguish locked property descriptors from completed membrane installation. Never substitute asynchronous `MutationObserver` callbacks for pre-execution script rewriting, and always refresh typed-array views after WASM `memory.grow` events in the raw ABI.
- **R4 (Canonical Module URLs vs. Referrers)**: Keep canonical module cache keys distinct from request referrers ([trap notebook](../trap-notebook/rewriter.md)). Do not introduce a third URL resolver alongside the Rust and core helpers.
- **R5 (Streaming Framing and Connection Pool Hygiene)**: Distinguish `HEAD`/204/304 bodyless responses, `Content-Length`/chunked/EOF framing, gzip trailers, truncated streams, and malformed HTML. Keep `Accept-Encoding` headers aligned with supported decoders, and never treat a closing `</html>` tag as stream EOF. Return HTTP/1.1 connections to the pool only after clean framing completion; discard connections on cancellation or error. Never attach `X-ZP-Stream=1` HTML transform markers to non-HTML byte streams, and never introduce Rust WASM timer futures that trigger runtime panics.

## 4. Verification and Resource Discipline

- **Memory-Constrained Hosts and Remote CI**: On machines with limited RAM, avoid parallel local Rust compilations or multiple headless browser instances. Run fast Node checks (`npm run test:js`) locally and rely on the [GitHub Actions CI workflow](../../.github/workflows/ci.yml) for full WASM and Chromium E2E verification.
- **Multi-Axis Browser Probes**: Use the E1 and E2 suites in [`test/e2e/proxy.test.js`](../../test/e2e/proxy.test.js) alongside [`test/browser/hole-matrix`](../../test/browser/hole-matrix/README.md) and the diagnostic scripts in [`test/browser/README.md`](../../test/browser/README.md) (`audit.mjs`, `rendercheck.sh`, `protoshape.sh`, `layout-probe.js`). Treat failed measurements (`NO_MEASUREMENT`) as failures, and inspect rendered layout rather than relying solely on document titles or HTTP status codes.
- **Native Control Comparisons**: When diagnosing live websites in the shared `taskweaver` `zp` instance, compare native loads and proxied loads sequentially under identical conditions. Separate upstream site errors from proxy defects, and distinguish `csp-only` blocks from rewriter containment.
- **Behavioral Verification Over Source Regexes**: Verify behavior through compiled WASM artifacts, runtime execution, and wire-level observations rather than regex-matching source files.

## 5. Security Prohibitions

- Never relax strict Content Security Policy directives, permit direct network egress, or fall back to executing unrewritten code when transformation fails.
- Never add site-specific empty JSON, image, or module stubs, and never mask runtime failures as silent no-op successes.
- Never wrap every cross-origin `window` in an unfiltered proxy, overwrite document entry state on subresource requests, or block synchronous DOM getters on asynchronous Service Worker RPCs.
- Never disguise synchronous loop-cap termination (10M iterations) as normal loop completion.
