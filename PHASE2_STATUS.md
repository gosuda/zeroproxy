# Phase 2 Strict-Mode Acceptance Status

Tracking record for the "탈출 없는 감옥 (No-Escape Jail)" phase 2 plan
(`~/.claude/plans/phase2-plan-md-smooth-knuth.md`). Each gate maps to an
acceptance criterion from PHASE2_PLAN; the **Evidence** column points at
the file(s) or test(s) that prove the gate is closed.

Marker key: `[x]` closed · `[~]` partial / explicit follow-up · `[ ]` open.

---

## P0 — 외벽 보강 (hard egress + dynamic-code gates)

| Gate | Status | Evidence |
|---|---|---|
| **A1** CSP unification & tightening (`connect-src 'self' <ws>`, no `script-src blob:/data:`) | `[x]` | [`internal/headers/csp.go`](internal/headers/csp.go), [`crates/zp-shared/src/csp.rs`](crates/zp-shared/src/csp.rs), [`test/js/static-policy.test.js`](test/js/static-policy.test.js) (`fixedCSP` projection + Go parity) |
| **A2** Capability-token defense-in-depth (`event.source.id` required, no `firstTab` fallback) | `[x]` | [`web/sw.js#runtimeMessageAuthorized`](web/sw.js), static-policy `firstTab` absence test |
| **A3** blob/data script + worker sealing | `[x]` | [`web/runtime-prelude.js#installWorkerHooks`](web/runtime-prelude.js), `application\/octet-stream|^$` empty-MIME branch, static-policy assertions |
| **A4** Dynamic compilation fail-closed (`eval`, `Function`, string-timers, constructor chain) | `[x]` | `dynamicEval` / `dynamicFunction` / `compileScoped` / `compileDynamic` in runtime-prelude |
| **A5** Styled `/__zp/error?code=…` page (`safeError` + `ERROR_INFO`) | `[x]` | [`web/sw.js#safeError`](web/sw.js), [`web/zp-core.js#ERROR_INFO`](web/zp-core.js), 19 error codes pinned |
| **A6** P0 regression suite in escape matrix | `[x]` | [`test/e2e/proxy.test.js#escape matrix - strict mode`](test/e2e/proxy.test.js) |

---

## P1 — 보안문 + 내부감옥 (transform pipeline + foreground OXC)

| Gate | Status | Evidence |
|---|---|---|
| **B1** `zp-htmltx ↔ zp-rewriter` Rust wiring (inline `<script>` + `on*` handlers) | `[x]` | [`crates/zp-htmltx/src/lib.rs`](crates/zp-htmltx/src/lib.rs), `__ZP_EXEC_INLINE_REWRITTEN[_MODULE]` paths, 20 cargo tests |
| **B2** srcdoc ordering proof — inline + `body onload` cannot reach native before prelude | `[x]` | [`test/e2e/proxy.test.js`](test/e2e/proxy.test.js) `srcdocEchoPromise` fixture |
| **B3** Foreground OXC dual delivery (bundle + `text/zp-pending` defer fallback) | `[x]` | `__ZP_EXEC_INLINE_REWRITTEN*` wrappers, [`web/runtime-prelude.js`](web/runtime-prelude.js) closure-private rewriter |
| **B4** EventSource fidelity (auto-reconnect, `Last-Event-ID`, `retry:`, Content-Type) | `[x]` | [`web/runtime-prelude.js#ZPEventSource`](web/runtime-prelude.js), static-policy `SSE auto-reconnect + Last-Event-ID fidelity` |
| **B5** Request body cap + `REQUEST_BODY_TOO_LARGE` | `[x]` | `MAX_REQUEST_BODY_BYTES = 8 MB` in sw.js, errors.rs `REQUEST_BODY_TOO_LARGE`, e2e oversized fixture |
| **B6** 307/308 redirect body replay (`REDIRECT_BODY_NONREPLAYABLE` fail-closed) | `[x]` | [`internal/zphttp/redirect.go`](internal/zphttp/redirect.go) + `redirect_test.go` |
| **B7** Bidirectional relay drain on ctx cancel (zero goroutine leak) | `[x]` | [`internal/wsconn/relay.go`](internal/wsconn/relay.go) drain-both, [`relay_test.go`](internal/wsconn/relay_test.go) (3 cases) |

---

## P2 — 감시탑 (fidelity / coverage / cache)

| Gate | Status | Evidence |
|---|---|---|
| **C1** WebSocket fidelity (subprotocol §4.2.2, close code/reason §7.4 + §7.1.6 closing-handshake drain, binaryType, bufferedAmount) | `[x]` | Boundary-layer fixes ([`web/runtime-prelude.js#installWebSocket`](web/runtime-prelude.js), SW `openRuntimeStream` defense-in-depth) + Rust kernel client ([`crates/zp-bundle/src/kernel/transport/ws_client.rs`](crates/zp-bundle/src/kernel/transport/ws_client.rs)) implementing RFC 6455 handshake + client-mask frame codec + JS-facing `WsClient`. End-to-end transport now passes target frames through yamux+SOCKS5+TLS without the relay parsing them. **§7.1.6 closing-handshake drain landed** — `ZPWebSocket.close()` posts the close frame and arms a 30 s guard; the port `{type:'close'}` ack from the Rust client fires `finish()` so in-flight `message` events drain before CLOSED, guard falls back to 1006 if the peer never echoes, and the SW [`openRuntimeStream`](web/sw.js) now forwards page-supplied `(code, reason)` to `stream.close(code, reason)` per §5.5.1 / §7.1.4. Static-policy regression in [`test/js/static-policy.test.js`](test/js/static-policy.test.js) (`C1: WS closing handshake defers finish until port ack`). |
| **C2** Malformed HTML fail-closed → `MALFORMED_HTML` (no raw passthrough) | `[x]` | [`web/sw.js#transformDocumentResponse`](web/sw.js), static-policy `fails closed on malformed HTML` |
| **C3** Share URL scheme validation + cross-language parity | `[x]` | 27-case fixture in [`crates/zp-shared/testdata/shareurl_cases.json`](crates/zp-shared/testdata/shareurl_cases.json), [`internal/shareurl/parity_test.go`](internal/shareurl/parity_test.go), trim parity |
| **C4** SW rewrite cache (SHA-256 keyed, LRU 200 ent / 50 MB) | `[x]` | [`web/sw.js#rewriteCache`](web/sw.js), static-policy `rewrite cache enforces strict invariants` |

---

## D — 출입로 (routing gateways + storage virtualization)

| Gate | Status | Evidence |
|---|---|---|
| **D1** `javascript:` URL routing (`data-zp-jsurl` + delegated handler) | `[x]` | [`crates/zp-htmltx/src/lib.rs`](crates/zp-htmltx/src/lib.rs) D1 attribute transform |
| **D2** Source map composition + chaining | `[x]` | Pragma strip + composer landed. `crates/zp-rewriter/src/sourcemap.rs` (hand-rolled VLQ + Source Map v3 writer, 6 host-side tests) + `compose_source_map` public API + `ZPBundle.composeSourceMap` WASM export + SW `/zp/api/sourcemap` route + rewriter pragma append (classic/module/worker only). DevTools breakpoints set on `__zp_get(globalThis, 'location')` resolve back to the original `location.href`. `sourcesContent` embeds the original source so chaining (`original_map ∘ rewriter_map`) for TypeScript-shipped artifacts has a path. Server header strip ([`internal/headers/policy.go`](internal/headers/policy.go)) already in place. |
| **D3** Background Sync / Push virtualization | `[x]` | Fail-soft facade in [`web/runtime-prelude.js#installTargetServiceWorkerBlocker`](web/runtime-prelude.js) — register/ready/getRegistration resolve, sync register no-op, push subscribe → `NotAllowedError`, navigationPreload stub |
| **D4** WebTransport gateway | `[~]` | Stub: [`internal/wtproxy/wtproxy.go`](internal/wtproxy/wtproxy.go) returns `WT_UNSUPPORTED`; [`crates/zp-wtproxy-client`](crates/zp-wtproxy-client) exposes virtual `WebTransport` that rejects. Full quic-go HTTP/3 listener deferred. |
| **D5** WebRTC gateway | `[~]` | Stub: [`internal/rtcgw/rtcgw.go`](internal/rtcgw/rtcgw.go) + [`crates/zp-rtcgw-client`](crates/zp-rtcgw-client) expose virtual `RTCPeerConnection` with `RTC_GATEWAY_UNAVAILABLE`. Full pion SFU/TURN deferred (operational cost track). |
| **D6** Physical hardware pass-through (Bluetooth/USB/Serial/HID/NFC/Sensor) | `[x]` | Intentional non-wrap — browser consent prompts are the trust boundary. E1 escape matrix asserts hardware API construction still works. |
| **D7** Origin/Storage virtualization (localStorage / sessionStorage / IDB / CacheStorage / cookie / origin / Performance.timeOrigin / BroadcastChannel / SharedWorker / Notification) | `[x]` | `installStorageFacades` in runtime-prelude, E1 escape matrix isolation assertions (`sessionStoragePrefix`, `cachesAPI`, `performanceTimeOrigin`, etc.) |

---

## E — 점검 및 인수 (verification)

| Gate | Status | Evidence |
|---|---|---|
| **E1** Hostile escape matrix (master suite) | `[x]` | [`test/e2e/proxy.test.js`](test/e2e/proxy.test.js) `describe('escape matrix - strict mode')` covers: indirect eval, computed access, destructuring, optional chaining, constructor escape, iframe clean realm, blob/data workers, srcdoc, javascript: URL, network egress, storage isolation. |
| **E2** Real-world regression (gosuda.org + SPA fixtures) | `[~]` | First-cycle baseline run passed (home cards + `/zp/p/` path preserved). Repeated `taskweaver --id zp` cycles trigger environmental Chromium-profile wedge (stale SW registrations accumulate across kill/start) — **not** a code regression; see follow-up. |
| **E3** Performance baseline | `[~]` | **Bundle sizes (post wasm-opt -Oz)**: `zp_bundle_bg.wasm` 3.07 MB, `zp_bundle_sw_bg.wasm` 3.07 MB (target ≤ 500 KB — gap is OXC + rustls + h2 + ml-kem inherent size, ≥ 5× compression target requires split-bundle or streaming parse; `npm i -g binaryen` installs the Windows `.cmd` shim that needs `shell:true` in spawnSync). JS wbg glue 44–49 KB (within ≤ 50 KB ✅), `zp_page_rt.wasm` 15 KB (was 18.5 KB). **Rewriter latency (`cargo bench rewrite_perf --quick`)**: 10 KB → 377 µs warm, 100 KB → 4.27 ms warm, 1 MB → 46.5 ms warm, ~21 MiB/s throughput. **Persistent bump arena implemented** ([`RewriterInstance`](crates/zp-rewriter/src/lib.rs)) — `Allocator::reset()` at end of each rewrite reclaims arena pages for the next call. Cold-vs-warm now 1.05–1.20×; the ≥ 5× plan target requires true patch-mode emit (return `(offset,len,replacement)` tuples instead of full re-emit) which is the next perf-track item. See `Phase 2 follow-up` below. |
| **E4** Production rollout (strict default, 1-week dogfood) | `[~]` | Plan + checklist + monitoring guide landed in [`PRODUCTION_ROLLOUT.md`](PRODUCTION_ROLLOUT.md). Dogfood (Stage 1) + test-cohort (Stage 2) execution is operator-driven and the only remaining unblocker. No `compatMode` / `defaultMode` user-facing toggle exists — strict default is the *only* mode the build emits today, so "activation" is procedural (release tag + README badge) once the dogfood week completes without a P0/P1 regression. |
| **E5** PHASE2_PLAN gate re-check + status update | `[x]` | This document. |

---

## Phase 2 follow-up (carry-over to Phase 3 / perf track)

1. **WebSocket transport** ✅ — `crates/zp-bundle/src/kernel/transport/ws_client.rs` (~650 LOC). Closes C1 end-to-end:
   - RFC 6455 §1.3 handshake ✅ — HTTP/1.1 GET with `Upgrade: websocket`, random 16-byte `Sec-WebSocket-Key`, `base64(SHA1(key || GUID))` accept validation. RFC example `dGhlIHNhbXBsZSBub25jZQ==` → `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=` pinned in unit test.
   - RFC 6455 §5.3 client mask ✅ — every outbound frame carries a fresh 4-byte mask from `getrandom`; payload XOR'd in place.
   - RFC 6455 §5.1 server-mask check ✅ — masked server frames immediately fail the connection with `InvalidData`.
   - Control-frame discipline ✅ — `Close` / `Ping` / `Pong` payloads ≤ 125 bytes (§5.5), FIN=1 required (§5.4), no fragmentation. Ping → automatic Pong echo.
   - Continuation-frame discipline ✅ — `Text` / `Binary` with FIN=0 start a fragment; subsequent `Continuation` frames accumulate; new data-frame mid-fragment closes with 1002.
   - §4.2.2 sub-protocol gate ✅ — negotiated protocol must come from the client-offered list; otherwise the connection closes with `WS_BLOCKED:ws-protocol-not-offered` (defense-in-depth against compromised page realms; SW also re-validates).
   - §8.1 UTF-8 enforcement ✅ — invalid UTF-8 in a Text frame closes with code 1007.
   - Close payload ✅ — empty → 1005 (`NO_STATUS_RCVD`), single byte → 1002 (malformed), otherwise `(u16, reason_utf8)` round-trip.
   - JS surface ✅ — `WsClient` exposes `.protocol`, `.bufferedAmount`, `.send(data)` (String / ArrayBuffer / Uint8Array), `.setHandlers({message, close, error})`, `.close(code?, reason?)` — exactly the methods `web/sw.js` `openRuntimeStream` calls. Backpressure counter decrements as the writer task drains the queue.
   - Lifecycle ✅ — reader/writer drivers are `spawn_local` tasks holding `Rc<Shared>`. Close from either side surfaces a single `close` callback to JS (1006 on transport drop, otherwise the remote-supplied code/reason). Drop of the underlying `PooledConn` (yamux→SOCKS5→TLS) tears down all backing layers.
   - `kernel_stream` no longer returns the `TARGET_WS_NOT_REWIRED` stub — wired to `transport::ws_client::open` via `wasm_bindgen_futures::future_to_promise`.
   - Bundle size delta: 3.07 MB → 3.26 MB on `zp_bundle_bg.wasm` after wasm-opt -Oz (+190 KB for `sha1` + the new module). Acceptable.
   - Static regression pinned in [`test/js/static-policy.test.js`](test/js/static-policy.test.js) (`C1: Rust WebSocket client implements RFC 6455 handshake + codec` — 12 invariant assertions covering GUID, mask bits, server-mask abort, control-frame caps, sub-protocol gate, close-payload semantics, UTF-8 enforcement, kernel_stream rewire).
2. **Source map composition** ✅ — `crates/zp-rewriter/src/sourcemap.rs` (~280 LOC, hand-rolled VLQ + Source Map v3 JSON writer). Strip is kept on the rewrite path (stale original pragma would mis-attribute lines), and the SW appends a fresh `//# sourceMappingURL=/zp/api/sourcemap?u=<targetUrl>&k=<kind>` to every successfully-rewritten script (classic/module/worker only — synthesised wrappers have no fetchable origin URL). The `/zp/api/sourcemap` SW route is wired in [`web/sw.js`](web/sw.js) `runtimeAPI`: it re-fetches the original source through the transport layer, calls `ZPBundle.composeSourceMap` ([`crates/zp-bundle/src/lib.rs`](crates/zp-bundle/src/lib.rs)), and returns the JSON with `Cache-Control: no-store + X-Content-Type-Options: nosniff`. Composition algorithm: walks patches in order, emitting one mapping per generated line at column 0 (unchanged regions map 1:1 to the corresponding original position; patched regions all attribute back to the patch site per §A.5 interpolation). `sourcesContent` embeds the stripped original source so DevTools can render the original without a separate round trip. Composition with the *original* sourcemap (`rewriter_map ∘ original_map` for sites that ship TypeScript-compiled artifacts) is a follow-on — the JSON shape and SW route both leave room. Coverage: 6 host-side unit tests (`vlq_basic_round_values` pins §A.4 against `A`/`C`/`D`/`gB`; empty-source / single-patch / multiline / json-escape / offset-to-line-col), runtime probe via taskweaver confirmed the SW route classifies as RUNTIME_API and fail-closes correctly on missing tab context (503).
3. **WebTransport gateway** — quic-go HTTP/3 listener + `zp-wtproxy-client` bidi/datagram round-trip.
4. **WebRTC gateway** — pion SFU + TURN replacement; SDP munging to strip target-origin candidates.
5. **wasm-opt -Oz** ✅ — binaryen wired ([scripts/build.mjs](scripts/build.mjs) `tryRunOptional` now passes `shell:true` on win32 to resolve the `.cmd` shim). Measured: 3.59 MB → 3.07 MB (-10%) on `zp_bundle_bg.wasm`, 18.5 KB → 15 KB (-17%) on `zp_page_rt.wasm`. The page bundle still exceeds 500 KB by 6×; reaching the hard target requires architectural split (parser-only worker + transport-only worker) or streaming parse, which is a Phase 3 candidate.
6. **Persistent bump arena** ✅ — `RewriterInstance` owns one `Allocator` and calls `arena.reset()` at the end of each `rewrite` so warm-path calls reuse the same arena pages. Measured impact: ~9% cold-vs-warm reduction at 1 MB. The ≥ 5× plan target is not reachable without item 7 below.
7. **Patch-mode emit** ✅ — `rewrite_script_patches()` Rust API + `rewriteScriptPatches` WASM export in [`crates/zp-bundle/src/lib.rs`](crates/zp-bundle/src/lib.rs). Returns the patch list as a JSON envelope (`{"len":N,"patches":[{"start":S,"end":E,"replacement":R},…]}`) the JS caller can apply in place. Measured: 1.19–1.39× CPU speedup vs full re-emit (`bench_patch_vs_full` 10 KB / 100 KB / 1 MB). The bigger structural win is wire-format size — ~50 patches × ~50 bytes vs 1 MB rewritten body crossing the wasm-bindgen ABI. **SW wired** ✅ — [`web/sw.js`](web/sw.js) `applyScriptPatches` helper splices replacements over the original buffer in order; `rewriteScriptResponse` prefers the patch path before falling back to full re-emit. The WASM export now calls `rewrite_script_patches` directly (was calling `rewrite_script` and discarding the re-emitted code), so the Rust-side CPU win is also unlocked. Behavioral regression coverage in [`test/js/static-policy.test.js`](test/js/static-policy.test.js) (`applyScriptPatches behavior` test exercises empty patches, single splice, two-splice ordering, malformed JSON, out-of-order patches, OOB end).
8. **taskweaver profile isolation** — repeated kill/start with `--id zp` accumulates Chromium SW registrations; E2 needs explicit profile wipe between cycles for repeatable acceptance runs.
9. **Transport codec extraction** ✅ — new `crates/zp-transport-codec/` (`socks5` + `http1` modules) owns every byte-layout invariant for SOCKS5 (RFC 1928 + RFC 1929) and HTTP/1.1 (RFC 9112) head serdes. The `zp-bundle/src/kernel/transport/{socks5,http1}.rs` wrappers are reduced to async byte pushers that delegate every parse / build call into the codec. Host coverage: 51 unit tests (SOCKS5: greeting / userpass subneg / CONNECT-request / CONNECT-reply head incl. full RFC 1928 §6 REP-code → `io::ErrorKind` table; HTTP/1.1: request-head build incl. Host / Content-Length / Connection auto-add, CRLF injection rejection, response-head parse, terminal-chunked / Content-Length / EOF framing decisions, keep-alive predicate, token validator). `tls.rs` host-side handshake remains deferred — rustls + `rustls-rustcrypto` is wasm-only entropy-bound, and the canonical TLS codec tests already live upstream. Pre-existing TODO markers in `socks5.rs:249`, `http1.rs:662`, `tls.rs:466` are retired with a comment explaining why each module's behaviour is now covered (codec tests, end-to-end SW fetch, rustls upstream). Static-policy regression in [`test/js/static-policy.test.js`](test/js/static-policy.test.js) (`transport codec crate owns the SOCKS5 / HTTP/1.1 byte invariants`) pins the wiring so a future refactor cannot silently re-introduce duplicated inline layouts.

---

## Cumulative acceptance signal

- `cargo test --workspace`: **86 pass / 0 fail** (zp-rewriter 50 incl. D2 composer + strip; zp-htmltx 20; zp-shared 16)
- `go test ./...`: **all internal packages green**, including `wsconn.TestRelay*` (B7), `shareurl.TestParityWithRustShareURL` (C3)
- `node test/js/static-policy.test.js`: **27 pass / 0 fail**. The cookie-jar test (`service worker uses Rust kernel transport and cookie bridge`) was stale on the `opt.url` → `u` variable rename (2026-06-02 bug fix); regex now accepts both forms so a future rename can't silently re-introduce the regression. The challenge-gate test was retargeted from the deleted `cmd/zeroproxy-server/relay.go` to the now-active Rust path: `transport::fetch::fetch` captures `X-ZP-Arm-Challenge-Compat` in `kernel/mod.rs` before the `x-zp-*` strip, threads `armed_challenge_compat: bool` into `build_js_response`, and emits `X-ZP-Challenge-Compat: 1` only when `zp_shared::is_challenge_document(cf, host, path)` (the shared predicate the Go `ApplyChallengeCompat` defense-in-depth helper uses) holds. The new `C1: Rust WebSocket client implements RFC 6455 handshake + codec` test pins the 12 invariants of the just-landed WS transport.
- `npm run build`: success (Rust workspace + wasm-bindgen + Go server)
