# Design — Streaming HTML Rewrite (progressive document render)

Status: ✅ LANDED (all 3 phases) · Owner: transport+SW+htmltx · Date: 2026-06-16

## Landed result (2026-06-16)

All three phases shipped + verified in real Chrome. NAVER main document renders
in **~2 s** (was ~60 s), `bodyLen` 125 KB, `window.__zp_get` present (prelude
injected at `<head>` by the streaming `HtmlTxn`), zero `unreachable` crashes.
The remaining 2 console errors are an unrelated NAVER ad-module dynamic import.
Tests: zp-htmltx 30 (chunk-invariance size 1–100k + prelude), static-policy 67.
See trap-notebook INDEX 2026-06-16 `streaming-render` for the full record +
the non-obvious invariants (prelude on r2, chunk-invariance, fail-closed via
`controller.error`, the `X-ZP-Stream` gate). Implementation notes below were the
plan; a few details shifted (kernel returns an `H2Response{Buffered,Streaming}`
enum; the SW gates on the `X-ZP-Stream` marker rather than sniffing `resp.body`).

## Problem

NAVER (and similar edges) deliver the whole HTML document body early (~130 ms) but
**withhold the last DEFLATE block + gzip footer with the h2 END_STREAM frame for
~60 s** (an idle/anti-bot timer). ZeroProxy currently **buffers the whole body →
decodes → rewrites (zp-htmltx) → returns one Response**, so the visible page is
blocked until that tail arrives (~60 s). A real browser **streams**: it
decompresses + renders as bytes arrive and never waits on the trailing block, so
the page is visible in ~1 s.

Read-side completion tricks (Content-Length, DEFLATE-end) cannot help the
document — the tail is genuinely withheld. A `setTimeout` idle timer is BANNED:
it traps the wasm (`RuntimeError: unreachable`) in real Chrome — confirmed twice
(see trap-notebook 2026-06-16). **Progressive streaming is the only correct fix.**

## Goal / Non-goals

- GOAL: the main `text/html` document renders progressively (visible in ~1 s),
  matching a browser. The h2 stream still stays open until END_STREAM (~60 s) —
  that only delays the page `load` event, exactly as in a native browser.
- NON-GOAL (phase 1): streaming scripts/CSS. They complete fast (decode-end) and
  the script rewriter needs the full source for its SHA-256 rewrite-cache key.
  Leave them buffered.
- NON-GOAL: changing redirect / cookie / CSP / challenge-compat handling. All are
  header-only and already stream-safe.

## Current pipeline (buffered) — confirmed by code map

```
naver ─h2 chunks→ http2::send_request  [buffer Vec<u8>, decode gzip]   (kernel, Rust→wasm)
        → HttpResponse{status,headers,body:Vec<u8>} → build_js_response → web_sys::Response(buffer)
SW transportFetch → addCSP(headers only, body passthrough) → returns Response
   document? → transformDocumentResponse:
        html = await resp.text()                 ← BUFFER #1 (waits 60 s)
        out  = ZPBundle.transformHtml(html, url)  ← whole-string rewrite
        injectPrelude(out, prelude) → new Response(string)
page ← respondWith
```

Buffering points: `http2.rs` body loop (kernel), `sw.js:1444 resp.text()` (SW).
The htmltx rewriter is `transform_html_js(html,target,origin)->String` in
`crates/zp-bundle/src/lib.rs:177`; internally Pass 1 = `rewrite_str`
(whole-string), Pass 2 = `HtmlRewriter::new + write + end` (ALREADY streaming).

## Target pipeline (streaming)

```
naver ─h2 chunks→ http2 streaming  [incremental gzip decode, NO buffer, NO timer]
        → web_sys::Response{ body: ReadableStream<decoded HTML bytes>, headers }
SW transportFetch → addCSP(passthrough) → Response(stream)
   document(2xx text/html, body is stream)? →
        resp.body.pipeThrough( HtmlTxnTransformStream(targetUrl, origin, preludeHtml) )
        → new Response(rewritten stream, {headers})
page ← respondWith   (renders progressively)
```

The kernel still **decodes gzip** (so the SW/page see plaintext) — just
incrementally. The htmltx runs as a streaming `write/end` transform. Prelude is
injected by the htmltx at `<head>` open (early), not by string concat.

## Why no timer is needed

The h2 stream is driven by `RecvStream::data().await` in a normal async loop. As
chunks arrive we decode + enqueue. When naver withholds the tail, the loop simply
`await`s with nothing buffered on our side — no setTimeout, no future-cancel. The
page already has the bytes and renders. On END_STREAM (~60 s) we close the stream.
This is exactly a browser's behavior and sidesteps the wasm-trap entirely.

## Work breakdown (phased; each phase ends `npm run build` + tests green)

### Phase A — Kernel streaming response (Rust, `zp-kernel-bundle`)
1. web-sys feature: add `ReadableStreamDefaultController` (and verify
   `Response::new_with_opt_readable_stream_and_init`). `ReadableStream` already on.
2. `decode::StreamingGunzip` — stateful incremental gzip inflater: parse RFC 1952
   header once (reuse `gzip_header_len`), feed deflate chunks to `flate2::Decompress`,
   emit decoded bytes. (br/zstd: phase-1 falls back to buffered path — naver doc is
   gzip; keep scope tight.)
3. `fetch::build_streaming_js_response(status, reason, headers, body_stream)` —
   builds a `Response` with a `ReadableStream` body; carries the SAME header logic
   as `build_js_response` (Set-Cookie sidechannel, challenge-compat marker, strip
   `Content-Encoding`, drop `Content-Length`). Headers are fully known after the h2
   HEADERS frame, before body — so this is clean.
4. `http2::send_request` gains a streaming arm, gated: **only when 2xx AND
   `content-type` starts with `text/html` AND coding is gzip/identity**. Else the
   existing buffered path runs unchanged. The streaming arm:
   - reads headers, creates a `ReadableStream` whose underlying source pulls,
   - drives an async pump: `data().await` → `release_capacity` → gunzip → controller
     `.enqueue(Uint8Array)`; on END_STREAM or error → controller `.close()`.
   - NO timer. NO buffering beyond the in-flight chunk + gunzip window.
5. `fetch::fetch` / `cold_request` wire the streaming Response through unchanged.
   3xx/non-HTML keep surfacing buffered to the SW (redirect logic intact).

Phase-A acceptance: page still loads identically (SW still buffers via
`resp.text()` — the streaming Response is consumed the old way → no regression,
no benefit yet). Verifies the kernel stream is correct end-to-end.

### Phase B — htmltx streaming binding (Rust, `zp-htmltx` + `zp-bundle`)
1. Refactor `zp_htmltx`: unify Pass 1 (attributes) + Pass 2 (inline scripts) into a
   single `HtmlRewriter<'static, _>` with all handlers + a `<head>` prelude-inject
   handler. Sink = `Rc<RefCell<Vec<u8>>>` owned by a session struct.
2. New `pub struct HtmlTxn` (wasm-bindgen exported) with:
   - constructor `HtmlTxn::new(target_url, proxy_origin, prelude_html)`,
   - `write(&mut self, chunk: &[u8]) -> Vec<u8>` (feeds rewriter, drains sink),
   - `end(self) -> Vec<u8>` (calls `.end()`, drains final sink).
   Inline-script per-element buffering stays internal (proven in current Pass 2).
3. Keep `transformHtml(html,target,origin)->String` as a thin wrapper over the
   streaming primitives (backward-compatible; still used for the buffered fallback).
4. Host unit test: feeding the SAME html in N chunks through `write*/end` yields
   byte-identical output to the whole-string `transform`. (Critical correctness pin.)

Phase-B acceptance: `cargo test` proves chunked == whole-string output; wasm builds.

### Phase C — SW streaming pipe (JS, `web/sw.js`)
1. In `transformDocumentResponse`: if `resp.body` is a `ReadableStream` AND
   `ZPBundle.HtmlTxn` exists AND response is HTML →
   - `const txn = new ZPBundle.HtmlTxn(targetUrl, ORIGIN, buildRuntimePrelude(...))`
   - `const ts = new TransformStream({ transform(chunk,ctrl){ ctrl.enqueue(txn.write(chunk)) }, flush(ctrl){ ctrl.enqueue(txn.end()) } })`
   - `return new Response(resp.body.pipeThrough(ts), { status, statusText, headers })`
     with `Content-Length` deleted, `Content-Type: text/html; charset=utf-8`.
2. Fallback: if any precondition fails (ZPBundle not ready, body not a stream,
   non-HTML) → the existing buffered `resp.text()`+`transformHtml` path. Zero
   regression risk: streaming is purely additive behind a feature check.
3. The post-redirect CSS host-rewrite (sw.js:1477) is an edge case (host mismatch
   after redirect). Phase 1: if `X-ZP-Final-URL` indicates a mismatch, **skip the
   streaming path and use the buffered path** for that response (rare). Port later.

Phase-C acceptance: real Chrome — document/menu visible in ~1 s, no crash, no
garbage; headless probe page renders (bodyLen large), no `unreachable`.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| wasm trap from timers | NONE used — pure async `data().await` pump. Hard ban kept in tests. |
| Prelude must run before page scripts | Inject at `<head>` open via lol_html element handler (fires early). |
| Inline script spans chunks | lol_html buffers per `<script>` element internally (already proven). |
| Truncated/partial HTML if tail never comes | Browser-tolerant; stream closes on END_STREAM/err; page shows what arrived. |
| Set-Cookie / challenge-compat headers | Known before body; emitted in streaming Response headers up-front. |
| Script/CSS cache needs full source | Out of scope — scripts/CSS stay buffered. |
| Streaming bug breaks a site | Feature-gated; buffered fallback always available → graceful degrade. |
| `HtmlRewriter` lifetime in a wasm struct | Use `'static` handlers (owned Strings) + `Rc<RefCell<Vec<u8>>>` sink. |
| h1 fallback path | Phase 1 streams h2 only; h1 (rare) stays buffered. |

## Open questions (resolve during impl)

- `Response::new_with_opt_readable_stream_and_init` availability in the pinned
  web-sys — confirm exact constructor / may need `ResponseInit.body` route.
- Does any consumer rely on `Content-Length` on the document Response? (We delete
  it for chunked streaming — browsers are fine; verify no internal assumption.)
- Backpressure: ReadableStream pull vs h2 flow control — release_capacity already
  paces us; confirm the controller's desiredSize is respected (or accept push).

## Rollout

1. Land Phase A (no behavior change) → ship, verify no regression.
2. Land Phase B (Rust-only, tested) → ship.
3. Land Phase C behind the feature check → verify in real Chrome; this is the
   phase that delivers the visible win. Keep buffered fallback for one release.

## Test matrix additions

- static-policy: pin `HtmlTxn` streaming binding exists; pin SW uses `pipeThrough`
  for HTML when available; keep the NO-`with_timeout`/`BODY_IDLE_MS` ban.
- htmltx host test: chunked write/end == whole-string transform (byte-identical).
- native/headless: naver document renders progressively (bodyLen large early).
