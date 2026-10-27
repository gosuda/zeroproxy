# Service Worker Integration Regressions: Historical Category Summary

Historical incident summaries for `classify`, `handleFetch`, `runtimeAPI`, `transportFetch`, and message routing in `web/sw.js`; **not an active normative specification**. Measurements and verifications reflect results at the time of recording, with no new runtime executions during documentation edits. Past test proposals and implementation gaps are unverified historical notes rather than active TODOs. Later corrections supersede earlier hypotheses, and individual fixes do not imply full compatibility across GitHub, Cloudflare, or CNN.

<a id="2026-08-21-go-call-0-go"></a>
## 2026-08-21: Go response header policy was dead code

- **Cause and correction:** `ConstructorPolicy`, `HiddenHeader`, `ApplyChallengeCompat`, and `ChallengeSubresourceSkip` had zero callers outside tests. The only `internal/headers` function called by `main.go` was `BuildCSP`. The August 20 note claiming that only document responses bypassed the Go policy was wrong: **no response ever passed through that policy**.
- **Fix and rules:** Deleted `policy.go`, `challenge.go`, and their tests while keeping `csp.go`. The build injects the `reporting`, `directive`, and `hop_by_hop` header lists from `crates/zp-shared/testdata/response_header_policy.json` into `__ZP_*_HEADERS__`, shared by the Service Worker header-stripping loop. Fixed invalid CORS combinations (`*` with credentials) so `Access-Control-Allow-Credentials` is enabled only when reflecting a specific `Origin` (previously triggered on originless requests without observed breakage).
- **Verification at the time:** Deleting the dead files had no impact on Go builds or tests. Confirmed no `Access-Control-*` headers on `/zp/`, `/zp/api/sync-fetch`, or `/__zp/*.wasm`, and no residual reporting headers, `Link`, `Location`, or `Clear-Site-Data` on `/hdrprobe`; hole, static, Cargo, and Go tests passed. Replaced the dead Go list comparison guard with a test that **verifies build injection from the shared fixture and forbids reintroducing the Go copy**. Always verify that guarded code paths actually execute (matching the earlier `internal/htmltx` dead-copy cleanup).

<a id="2026-05-30-iframe-document-referer-parenttargeturl-ad-iframe-unblocked"></a>
## 2026-05-30: Using parent target URL as iframe `Referer`

- **Cause:** NAVER `shopsquare.naver.com` ad documents required the embedder `Referer`, but `transportFetch` sent the iframe's own `entry.baseUrl`, resulting in `POLICY_BLOCKED` or 404 responses.
- **Fix:** `activatedFrameURL` in `web/runtime-prelude.js` includes `parentTargetUrl: virtualURL.href` in `ZP_FRAME_ROUTE`, which `web/sw.js` canonicalizes and stores. When `opt.document && entry.parentTargetUrl` holds, `transportFetch` sends `entry.parentTargetUrl` as `X-ZP-Referer`.
- **Status:** Unblocked the ad iframe at the time. This recorded the parent referrer selection fix rather than a general replacement for later `Referrer-Policy` enforcement.

<a id="2026-05-30--3xx-redirect-server-side-following-rtroundtrip--followredirects"></a>
## 2026-05-30: Server-side 3xx redirect following

- **Cause:** `rt.RoundTrip` returned raw relative `303 Location` headers from ad iframes directly to the browser, which resolved them against the proxy origin and triggered Service Worker `UNKNOWN` errors or blocks.
- **Fix at the time:** Applied `followRedirects(ctx, rt, req, jar)` in `cmd/zeroproxy-server/relay.go` across both `bridgeRelayWS` and `bridgeMuxRelayWS`. At the time, it followed up to 10 hops, converted 301/302/303 to GET, preserved bodies on 307/308 (returning the response if not replayable), collected cookies per hop, stripped `Authorization` and `Cookie` across host changes, and stripped the final `Location` header.
- **Correction and status:** Never leaking raw `Location` headers to the browser is the core invariant. Do not treat the method-conversion summary above as the active specification: later fixes for redirect cap escapes and the September 6 request contract refined and corrected those rules.

<a id="2026-05-29--user-agent-forbidden-header-smuggle"></a>
## 2026-05-29: Missing `User-Agent` forwarding

- **Cause:** `Request` construction dropped the `User-Agent` header so the relay sent either an empty value or `Go-http-client/1.1`, triggering bot blocks on sites such as Wikipedia. Browser treatment of `User-Agent` as a forbidden header varies across engines.
- **Fix:** Shared `TARGET_USER_AGENT` from [web/zp-core.js](../web/zp-core.js). [web/sw.js](../web/sw.js) sets `X-ZP-User-Agent`, both relay paths in [cmd/zeroproxy-server/relay.go](../cmd/zeroproxy-server/relay.go) promote it to `User-Agent` with the same fallback constant, and [web/runtime-prelude.js](../web/runtime-prelude.js) exposes the identical constant to page JS.
- **Verification at the time:** Wikipedia articles rendered and NAVER showed no regressions. `"Please set a user-agent"` responses or Go default UA strings served as regression signals. Forwarding `Cookie`, `Sec-Fetch-*`, and Client Hints was noted for follow-up and did not constitute proof of passing Cloudflare challenges. See [POST body + Referer/Origin](#2026-05-29-post-body-refererorigin-missing).

<a id="2026-05-29-post-body-refererorigin-missing"></a>
## 2026-05-29: Missing POST body and `Referer`/`Origin`

- **Cause 1 and fix:** `kernel_fetch` in [crates/zp-kernel/src/lib.rs](../crates/zp-kernel/src/lib.rs) always passed an empty body. Fixed by passing the `extract_body_bytes` result to `sess.fetch` for all non-GET/HEAD requests.
- **Cause 2 and fix:** Setting `Referer` and `Origin` directly on `new Request` in [web/sw.js](../web/sw.js) stripped both headers. Fixed by smuggling them via `X-ZP-Referer` and (for non-GET/HEAD) `X-ZP-Origin`, promoting them in the relay, and **stripping all internal `x-zp-*` headers before forwarding upstream**.
- **Verification at the time:** NAVER `recoshopping` API returned 200 and rendered recommendation widgets. `body-set=false` and empty referer fields in relay logs distinguished the two defects. See [build-deploy.md](build-deploy.md) and [real-site-compat.md](real-site-compat.md#2026-05-29-naver-top-right-recoshopping-nextjs-iframe-application-error).

<a id="2026-05-29-target-script-error-diagnostics"></a>
## 2026-05-29: Target script error diagnostics

- **Cause:** Silent throws and fallbacks inside iframe runtimes required manual console context switching, and page reloads wiped externally attached hooks.
- **Fix:** [web/runtime-prelude.js](../web/runtime-prelude.js) records capture-phase `error`, `unhandledrejection`, and `console.error` events into a per-window `__zp_diagnostics` ring buffer (capped at 200 entries), guarded against duplicate installation by `Symbol.for('zeroproxy.runtime.installed')`.
- **Status:** Proposed checking the installation marker and ring buffer presence as regression signals to detect page overwrites or partial installs; no separate runtime test was added at the time.

<a id="2026-05-29--ws-mux-1-ws--n-stream"></a>
## 2026-05-29: WebSocket multiplexing (`1 WS = N streams`)

- **Cause:** `crates/zp-kernel/src/lib.rs` opened a new `/zp/relay` WebSocket for every request and the server closed it after each response, so server-side transport pooling alone could not eliminate WebSocket upgrade overhead.
- **Fix and invariants:** Binary frames on `/zp/relay-mux` encode a big-endian `u32` stream ID, frame type (`ENVELOPE`, `BODY_UP`, `HEAD`, `BODY_DOWN`, `ERROR`, `CANCEL`), and payload. A single read loop in `cmd/zeroproxy-server/relay.go` dispatches frames to per-stream goroutines via `chanBodyReader`, while **all writes serialize through `sendMu`**. The singleton `MuxSession` in `crates/zp-kernel/src/mux.rs` manages per-stream slots and a pre-connection pending queue.
- **Verification and limits at the time:** Confirmed faster NAVER loads and WebSocket reuse, though an initial navigation race could still open a legacy connection. Failed session acquisition falls back to `relay_fetch_owned`, and socket closure calls `mark_dead` to reject pending streams before reconnecting lazily. Potential `u32` stream ID wrap collisions and head-of-line blocking on bounded upload buffers remained known limits at the time. See the [server pool fix](build-deploy.md#2026-05-29-upstream-connection-pool-missing).

<a id="2026-05-29-zpapifetch-script-destination-undetected"></a>
## 2026-05-29: Undetected script destination on `/zp/api/fetch`

- **Cause:** `zp-htmltx` unified absolute script URLs under `/zp/api/fetch`, but the handler only processed CSS and raw pass-through responses. Unrewritten JS accessed native `window` and `location` directly, bypassing the `__zp_get` membrane.
- **Fix:** Updated the GET branch in [web/sw.js#L228](../../web/sw.js) and [web/sw.js#L266](../../web/sw.js) to detect `script`, `worker`, and `sharedworker` via `req.destination` or `Sec-Fetch-Dest` and route them through `rewriteScriptResponse` with `scriptKindFromRequest`.
- **Status:** Proposed E2E assertions for `__zp_get` in responses and a new `test/js/sw-runtime.test.js` suite remained **unverified proposals at the time**. Watch for missing destination checks whenever `classify`, handlers, and rewrite paths are split across API routes.

<a id="2026-05-29-iframe-boottargeturl-parent-url-misregistered-membrane-cascade-failure-p1"></a>
## 2026-05-29: Hypothesis on iframe `boot.targetUrl` misregistration as parent URL

- **Symptom:** NAVER menu, shopping, and ad iframes rendered blank or showed `Application error`, and `eval('location.href')` and `documentBaseURI` inside the iframes returned the parent root URL.
- **Hypothesis at the time:** Suspected `activatedFrameURL` fallbacks, parent entry lookup in `proxyDocument`, or mutable `tab.activeEntryId` pollution. Resolving relative URLs against the parent base URL is itself normal and was not confirmed as the failure cause.
- **Follow-up and status:** The concrete fix was recorded under the missing `/zp/api/fetch` navigation entry below. Internal state dumps and full iframe URL E2E tests remained proposals at the time, and expecting a single fix to resolve all iframe widgets simultaneously was unverified.

<a id="2026-05-29-iframe-zpapifetch-navigation-entry-not-created"></a>
## 2026-05-29: Missing navigation entry creation for iframes on `/zp/api/fetch`

- **Cause:** The runtime GET handler in [web/sw.js#L228](../../web/sw.js) treated iframe navigations as subresources and reused the parent entry, causing wrong `baseURI` values and `SW_NOT_READY` races on subresources before iframe `clientContext` binding completed.
- **Fix:** Updated [web/sw.js#L237](../../web/sw.js) to detect `navigate`, `iframe`, `document`, and `frame` requests, create a dedicated entry for the iframe, bind `clientContext`, select document `Accept` headers, and run `transformDocumentResponse` to inject the prelude and CSP.
- **Status:** An E2E test verifying virtual URLs and subresource loading in cross-host iframes remained an unverified proposal at the time. Passing parent-document tests alone never proves iframe navigation paths.

<a id="2026-08-20-real-refresh"></a>
## 2026-08-20: Escape via `Refresh` response header

- **Cause and follow-up correction:** Only `<meta http-equiv="refresh">` was rewritten, allowing HTTP `Refresh` response headers to trigger unproxied navigations. Although `internal/headers/policy.go` listed `Refresh` as hidden, the August 21 audit showed that Go header policy was never called on any response.
- **Fix and rule:** Handled `Refresh`, `Link`, `Clear-Site-Data`, `Alt-Svc`, `Service-Worker-Allowed`, `SourceMap`, and `Set-Cookie` in `ZP_TARGET_POLICY_HEADERS` inside the Service Worker. Never allow direct preloads, proxy storage wipes, or alternative endpoint redirects. Because stripping `Refresh` outright breaks expected page redirects, rewrite its `url=` target to the launcher `?via=` route.
- **Verification and correction:** Reproduced both the direct escape and broken landing before confirming zero escapes and working landings after the fix. The comparison guard between Go hidden headers and the Service Worker was later retired and replaced. Always verify both `<meta>` and HTTP header delivery channels alongside containment and landing behavior.

<a id="2026-08-21-css-in-url-sw-less-403"></a>
## 2026-08-21: 403 on CSS `url()` inside Service-Worker-less documents

- **Cause:** CSS fetched via `/zp/api/sync-fetch` inside documents not controlled by the Service Worker kept Service-Worker-only `/zp/api/fetch` URLs inside `url(...)`, which the Go server rejected with 403. Element-attribute blob upgrades did not rewrite stylesheet text.
- **Fix:** Rewrote internal `/zp/api/fetch` URLs inside relay `kind=style` responses to relay URLs. Capped concurrent rewrites at 12 with overflow logging because HTTP/1.1 connection exhaustion had previously delayed stylesheets and caused `deadSheets`. Never assume URLs beyond the cap were rewritten.
- **Verification at the time:** `e6-adframe-css-link` only verified stylesheet arrival, and error-free NAVER runs proved nothing when ad image paths were absent. Toggling the Service Worker fix line on the deterministic `e7-adframe-css-image` fixture confirmed causality (failing when disabled, passing when enabled).

<a id="2026-08-21-redirect-cap-masked-underlying-bug"></a>
## 2026-08-21: Redirect cap escape and masked compatibility limit

- **Cause:** When a redirect chain exceeded the hop limit, the final `3xx` response and raw `Location` header were returned to the browser. Absolute URLs escaped directly to the target host, while relative URLs hit unrouted proxy paths and lost their share context. `Connection`, `Keep-Alive`, `Trailer`, and `Proxy-Authenticate` also survived header probes. The assumption that Go stripped these headers was refuted by the August 21 dead-code audit above.
- **Fix and rule:** Never pass an over-cap `3xx` response to the browser. Blocking over-cap redirects exposed that the previous 5-hop limit was too low for real sites, so the cap was raised to 20 hops. Because the browser had previously masked the low cap by following the leaked `3xx` natively, do not misdiagnose failures exposed immediately after closing a leak as new regressions.
- **Verification and divergence:** Observed both the raw escape and the `n13` landing failure. Control-group Chrome completed 25 hops despite the standard 20-hop spec limit; stopping at 20 hops in the proxy was accepted as a known bound rather than exact browser parity.

## Subresource redirects corrupting the document entry (2026-08-25) {#redirect-entry}

- **Cause:** Unconditional entry URL updates in `transportFetch` allowed tracking-pixel redirects to overwrite the document entry URL. Valid `opt.refOverride` values were then discarded as cross-origin against the corrupted entry. `micro.rubiconproject.com` selected its Prebid bundle based on `Referer`, serving v4 instead of the v11 bundle expected by CNN `adfuel` and halting the ad auction. Overwriting the entry also caused an **information leak** by sending another embed's query URL as `Referer` to third-party hosts.
- **Fix:** Restricted entry URL updates to `if (entry && opt.document)`. Updated `/zp/api/script` and `/zp/api/worker-script` to prefer the requesting client context over the mutable `tab.activeEntryId`. The bug lay in the mutated base state rather than the same-origin guard itself.
- **Verification and residual gap:** Fixing entry selection alone still served Prebid v4; adding the `opt.document` guard restored Prebid v11, ad auctions, and bid requests. **Total CNN frame counts still remained below the control group.** Cross-origin full-URL `Referer` leaks observed in `scratchpad/redir2.mjs` were addressed in the `Referrer-Policy` fix below.

## Ignored `Referrer-Policy` headers and attributes (2026-08-25) {#referrer-policy}

- **Cause:** The proxy ignored both the default referrer policy and explicit `no-referrer`, `origin`, `same-origin`, and element-level policies, sending full URLs across origins. That leaked sensitive query parameters and diverged from browser behavior. The concern that Go's proxy-level `no-referrer` header always overwrote target policies was disproved by measurement.
- **Fix:** Implemented all 8 referrer policies and HTTPS-to-HTTP downgrade rules in `refererForPolicy`, stripping credentials and fragments even when sending full URLs. Policy precedence follows: explicit page override, browser-computed request policy, document entry response header, and default policy. Because proxy-bound `fetch` requests carry proxy-origin computed policies, the prelude forwards `init.referrerPolicy` explicitly.
- **Verification and follow-up:** Matched control-group behavior across subresource types for default, four explicit policies, and element overrides without regressing CNN Prebid. Meta-only page `fetch` policies and top-level self-referential `Referer` headers remained open on August 25 and were fixed on August 26 below. Does not represent full CNN parity.

### Control-group contamination correction in `nav-matrix` {#nav-matrix-control-group}

- **Refuted diagnosis:** Missing control-group landings were initially blamed on a legacy runner instrumentation bug. Manual reproduction and reruns without code changes confirmed clean landings and reproducible results; the remaining non-landings were genuine browser popup blocks.
- **Actual cause and rule:** Running a CNN probe concurrently against the shared `--id zp` daemon contaminated the `nav-matrix` measurement. Always run `nav-matrix`, `hole-matrix`, and `rendercheck` exclusively, and never manipulate the shared browser instance from another process.
- **Measurement rule:** Do not reuse historical root causes based on superficial symptom similarity. Empty log files produced when `nohup ... &` terminates with its parent shell are never proof of a passing run.

## <a id="clients-get-deadlock"></a>`clients.get` response deadlock (2026-08-25, CNN)

- **Cause:** `reportEncodedSize` awaited `clients.get(resultingClientId)` on the response path, creating a circular wait because client creation blocks on response commit. Although the Service Worker built a 200 response, buffered document iframes stayed at `about:blank` without firing `load` or `error`. Streaming responses did not hit the `await` and completed normally.
- **Fix and verification:** **Never `await clients.get()` on the response commit path.** Dispatch diagnostic messages asynchronously and record encoded sizes through the pull stream path. Verified with a `static-policy.test.js` ban and a unit test using a never-resolving `clients.get` mock. Unresponsive document frames disappeared across two consecutive clean-build CNN runs, though this did not resolve all CNN issues.
- **Instrumentation correction:** The instrumented `dist` wrapper increased contention compared to the uninstrumented bundle, and the global `self.__ZPNAV_REC` overwritten concurrent request records, producing the false `"tf-pre-kernelFetch hang"` diagnosis. Always compare against uninstrumented baselines and pass per-request trace records.
- **Related fix:** The transport deadline added in the same commit implemented the caller timeout previously only mentioned in Rust comments. The deadline never fired during this deadlock, confirming the hang lived outside the kernel. The initial 20-second budget was revised in the August 26 entry below.

## <a id="self-referer"></a>Self-referential `Referer` on top-level documents (2026-08-26)

- **Cause:** When no parent entry existed, the Service Worker fell back to `entry.targetUrl` as the referrer base, causing initial address-bar loads to send their own target URL as `Referer`. An intermediate fix that read only the `Referer` request header stripped legitimate link-click referrers instead.
- **Fix and rule:** Read navigation referrers from **`request.referrer`** rather than `request.headers.get('Referer')` and deproxy routed URLs back to the target URL. Omit `Referer` when `request.referrer` is empty or `about:client`.
- **Verification at the time:** Verified against local echo server `:18211` that address-bar loads sent no `Referer` while link clicks sent the previous page URL, matching the control group and closing the August 25 gap.

## <a id="meta-referrer"></a>Missing `<meta name="referrer">` policy on page `fetch` calls (2026-08-26)

- **Cause:** Browser-initiated image and script requests carried the computed `<meta name="referrer">` policy, but page `fetch` calls left `Request.referrerPolicy` empty. Sending `ZP_REFERRER_POLICY` on `DOMContentLoaded`, `load`, or a timer still arrived after early `fetch` calls executed during HTML parsing.
- **Fix:** Read `req.referrerPolicy || documentReferrerPolicy()` synchronously from the DOM when constructing the request. Keep the async message as a fallback for XHR and other paths that cannot attach request metadata directly, and accept only valid policy tokens in the Service Worker.
- **Verification at the time:** Local meta-only `fetch` tests matched the control group across `no-referrer`, `origin`, and `unsafe-url`, closing the August 25 gap. Never mistake a default fallback on unrecognized policy strings for actual policy enforcement.

## <a id="csp-streaming-correction"></a>Correction: streaming responses also enforce CSP headers (2026-08-26)

- **Refuted hypothesis:** The comment in `sw.js` claiming that browsers ignore CSP headers on Service Worker streaming responses was wrong. CSP was inactive only because `taskweaver` enabled `Page.setBypassCSP` by default.
- **Verification and correction:** In a build with `<meta>` CSP removed, running with `--enforce-csp` blocked both streaming external fetches/images and buffered external fetches, whereas the default bypass daemon allowed them. The HTTP response header is the primary enforcement mechanism, and `<meta>` CSP is defense-in-depth rather than a workaround for ignored headers.
- **Measurement rule:** Check `csp_bypassed` in `taskweaver list` before testing CSP. Stop the daemon and start a fresh instance with `start --enforce-csp` for enforcement tests. Because isolated worlds still obey page CSP, raw `fetch` or `<img>` probes in an isolated world test CSP enforcement without rewriter interference.

## <a id="transport-deadline-measurement"></a>Transport deadline bounds the entire HTTP/1.1 response (2026-08-26)

- **Cause and correction:** The `kernelFetch` deadline introduced in `1bcae09` was not a time-to-first-byte (TTFB) timeout. Only HTTP/2 (`finish_h2_response`) resolved headers before body completion; HTTP/1.1 buffered the entire response body before resolving, so slow transfers hit the deadline.
- **Fix and verification:** Tested against local fixtures with delayed headers, slow bodies, and silent upstreams. Raised the budget from 20 seconds (which truncated valid slow bodies with 504) to 90 seconds, confirming that slow downloads completed while silent upstreams still terminated cleanly. The deadline exists to prevent infinite hangs rather than penalize slow downloads.
- **Unresolved limits at the time:** Bounding TTFB separately required header-arrival notifications in the HTTP/1.1 path (later addressed on September 6). A JS-side timeout did not cancel the underlying Rust future, and user-facing error codes mapped to `TARGET_CONNECT_FAILED` (distinguished only by `TRANSPORT_DEADLINE` in `refusalLog`).

## <a id="request-context-redirect"></a>Lost request context and body view across redirect boundaries (2026-09-06)

- **Cause:** Reading `bodyU8.buffer` ignored `Uint8Array` subarray offsets and lengths. Recursive redirect handling converted all non-307/308 methods to GET and dropped header and referrer policies when reassembling options manually. Runtime POST requests ignored caller-supplied `credentials`, `redirect`, and `mode`, and resolved document context from the mutable active entry after async initialization.
- **Fix and rules:** `transportFetch` normalizes the entry/referrer snapshot and byte slice up front, and `transportFetchHop` preserves that context across hops. Implemented exact method transitions (301/302 POST-to-GET conversion, 303 GET/HEAD rules), entity-header stripping on body drop, cross-origin `Authorization` stripping, `credentials`-scoped `Cookie`/`Set-Cookie` handling, and `manual`/`error` redirect modes. Page and worker responses keep a native `Response` while restoring `url`, `type`, `redirected`, and `clone` behavior from internal metadata. Declare decoder state before top-level install calls to avoid prelude TDZ errors.
- **Verification:** Reproduced the pre-fix PUT regression in `test/js/request-policy.test.js` and passed the full lightweight JS suite after the fix. In Chromium on [CI run 34020783071](https://github.com/gosuda/zeroproxy/actions/runs/34020783071), all four groups in `test/e2e/request-contract.js` (method/body, credentials, error/manual, and history/referrer) plus direct-egress checks passed, though **the overall CI workflow failed due to unrelated WASM/E1 failures in the same run**.
- **Scope boundary:** Initial reproduction used a lightweight kernel double rather than a live site, and local Rust/Go compilation and Chromium runs were skipped under host memory limits. Service Worker restart recovery, Public Suffix List / `SameSite` / cookie partitioning, and full CORS enforcement remained separate roadmap items. **Never work around request failures by allowing direct target egress or weakening CSP.**

## <a id="pull-stream-lifetime"></a>Response lifetime preserving time-to-first-byte and cancellation (2026-09-06)
- **Cause:** Full-response buffering in HTTP/1.1 delayed the first chunk. Treating HTTP/2 codec completion as HTTP framing completion skipped integrity checks, and reconstructing `Response` objects in the Service Worker dropped the HTML stream completion promise.
- **Fix:** Unified HTTP/1.1 and HTTP/2 pull streams with backpressure and `Abortable` cancellation. Return HTTP/1.1 connections to the pool only after framing and decompression verification succeed. Verify `gzip` and `deflate` incrementally, keep bounded buffering for `br`, `zstd`, and executable scripts, and hold `event.waitUntil` at the final Service Worker response boundary until EOF, error, or cancellation.
- **Contract:** Reserve `X-ZP-Body-Stream` for body stream lifetime and `X-ZP-Stream` for progressive HTML transformation, stripping both before delivering the response to the page. CI covers `HEAD`, `204`, `304`, trailers, truncated bodies, and idle cancellation.
- **Response reconstruction:** Even when the browser exposes an empty `ReadableStream` on incoming `204`, `205`, or `304` responses, pass `null` as the body when constructing a new `Response`.

## <a id="websocket-request-identity"></a>Document identity on WebSocket handshakes (2026-09-06)
- **Cause:** WebSocket handshakes omitted `User-Agent` and `Cookie` headers and derived `Origin` from the WebSocket server URL instead of the requesting document.
- **Fix:** The Service Worker captures the verified document entry's `Origin`, the fixed browser persona `User-Agent`, and destination cookie jar entries before handshake initialization and passes them to the kernel. The kernel allowlists permitted headers and rejects values containing `CR`, `LF`, or `NUL`.
- **Verification:** Verify `User-Agent`, `Origin`, `Cookie`, subprotocol echoing, and explicit close codes in E2E handshakes. Accurate handshake headers do not by themselves guarantee passing remote anti-bot checks.
- **Close boundary:** Sending a yamux `FIN` immediately after a WebSocket Close frame caused the Go relay's bidirectional teardown to truncate the peer's Close echo and surface code `1006`. Flush the Close frame first and wait for the peer Close frame before closing the stream, reporting only the peer's code and reason (or `1006` / `wasClean: false` on transport failure or early cancellation).
- **CI verification:** In [a484e7b CI](https://github.com/gosuda/zeroproxy/actions/runs/34025734224), WebSocket echo, `User-Agent`, `Origin`, `Cookie`, clean `1000` closure, explicit `3001`/`finished` closure, and early-cancel `1006`/unclean closure all passed. In the same run, HTTP/1.1 time-to-first-chunk measured 3.3 ms and framing, decompression error, and idle cancellation tests passed.

## <a id="stream-marker-ownership"></a>Upstream headers polluting kernel stream markers (2026-09-08)

- **Cause and reproduction:** Copying an upstream `X-ZP-Body-Stream` header before appending `1` in the kernel produced `untrusted, 1`. In a lightweight Node reproduction running the real Service Worker and shared response policy, `completeBodyResponse` skipped completion promise attachment and marker stripping when the header value was not `'1'`. (This reproduced the logic bug in Node rather than measuring premature Service Worker termination in a live browser.)
- **Fix:** Reject upstream `X-ZP-Body-Stream` and `X-ZP-Stream` headers case-insensitively at the shared kernel response-header copy boundary. Buffered responses never carry forged markers, and streaming responses set markers strictly from kernel body lifetime and HTML classification.
- **Distinction and rule:** A forged `X-ZP-Stream` header alone only disables progressive HTML streaming without dropping body completion tracking. Never work around marker collisions with loose substring checks (`includes('1')`) or by stripping markers before the Service Worker consumes them.
- **Verification:** In [cef5e7d CI](https://github.com/gosuda/zeroproxy/actions/runs/34201550912), marker hiding and body completion passed across buffered Brotli, raw streaming, truncated bodies, and progressive HTML responses.

## <a id="websocket-close-deadline"></a>Page Close guard did not close the underlying connection (2026-09-08)

- **Cause:** Waiting for the peer's Close echo before tearing down the stream removed bounded termination when the peer never responded. The page-side 30-second timer only synthesized a local `CloseEvent` while leaving the Rust reader/writer tasks and Service Worker `streams` entry alive.
- **Fix:** The Service Worker starts a single 30-second deadline on the first Close request and calls `WsClient.abort()` on expiry, invoking `surface_close(1006)`, both abort handles, and the terminal cleanup callback. Repeated `close()` calls do not extend the deadline, whereas a timely peer Close response clears the timer and preserves the peer's status code and reason. Both the page guard and late-arriving cancelled open handshakes trigger `abort()`.
- **Verification:** Executing the real Service Worker code in a lightweight Node test confirmed that before the fix, drivers remained active with 0 aborts after 30 seconds, and after the fix, streams were released with 1 abort and a `1006` event (included in the 58/58 lightweight JS suite). In [cef5e7d Chromium CI](https://github.com/gosuda/zeroproxy/actions/runs/34201550912), an unresponsive peer observed one upstream TCP EOF and one socket close at 30,001 ms after receiving Close, and the page received `1006` with `wasClean: false`.
- **Prohibitions:** Never replace the close deadline with an idle timeout on open sockets, an immediate `FIN` after Close, termination of the shared yamux session, or a Rust timer `Future` race. Do not claim hard 30-second wall-clock guarantees in environments that suspend Service Workers or throttle timers.

## <a id="upgraded-socket-eof"></a>Unresponsive WebSocket fixture did not observe TCP EOF as closure (2026-09-08)

- **Symptom:** In [ec307ee CI](https://github.com/gosuda/zeroproxy/actions/runs/34200315989), all 12 WASM tests and the module, receiver, and stream-marker regressions passed, but the WebSocket close-deadline test failed because the upstream fixture never recorded a `close` event after the page received `1006`. That fixture failure did not mean kernel cancellation failed.
- **Cause and comparison:** Node HTTP `upgrade` sockets enable `allowHalfOpen=true` and disable automatic EOF teardown. Sending a client TCP `FIN` to the fixture in a standalone Node probe left `readableEnded=true`, `writableEnded=false`, and `close=false`. Recording only `close` events missed the peer's EOF because the fixture kept its own write half open.
- **Fix and verification:** Updated the fixture to record `end` on the readable stream and call `socket.end()` to close its write half, transitioning the probe to `writableEnded=true` and `close=true`. Preserved the E2E assertions for socket closure, the 30-second wait bound, and single termination while adding an explicit assertion that **the upstream server received the client TCP EOF**. The fixture still withholds WebSocket Close frames and never fabricates passes via fixture timers or context teardown. In [cef5e7d CI](https://github.com/gosuda/zeroproxy/actions/runs/34201550912), both TCP EOF and socket close were observed and all 117/117 E2E tests passed.

## <a id="form-submission-fidelity-2026-10-23"></a>A submitted form must look like the browser's own: bare Content-Type, the document's own Referer and Origin (2026-10-23) {#form-submission-fidelity-2026-10-23}

- **Symptom:** on the real Glassdoor path the Turnstile widget passed (the tab began to navigate) and then Chrome showed `ERR_INVALID_RESPONSE` for `/zp/p/<route>?zp_submit=…`. The first harness (`full-proxied.js`, lab only) counted "the title is no longer the interstitial" as a pass, so that error page was reported as a success and the earlier "real path 2 of 6" was wrong: the widget's own success rate on the real path had never been measured. A harness has to classify the widget's state and the landing page separately.
- **Measured with:** a worker patched in `dist` (lab only, never committed) that logged the POST of `submittedDocument` and the response. The worker POSTed to `https://www.glassdoor.com/` and got `405`, `Allow: GET, HEAD` (the origin's answer to a POST that Cloudflare did not take as a challenge answer). The native POST, recorded through the lab bridge (`BRIDGE_DUMP`), got `308` then `302`: same URL, three fields, `Content-Type: application/x-www-form-urlencoded`, `Referer: https://www.glassdoor.com/?__cf_chl_tk=…`, cookies `cf_clearance` and `__cf_bm`.
- **Cause (the one that mattered):** `serializeFormSubmission` sent `application/x-www-form-urlencoded;charset=UTF-8` (`text/plain;charset=UTF-8` for that enctype). A form posts the bare media type; the charset parameter is what `fetch` adds to a string body. Cloudflare did not recognize the answer. Changing only that took the POST from 405 to 200 and the tab to `Glassdoor | Relevant Job Matches and Company Research` in every run where the widget passed (3 of 3 in one batch, 4 of 4 in the next).
- **Two more gaps, each different from native, found on the way (not shown necessary for Cloudflare: with the Referer fix alone the POST still got 405):** the Referer of a submission came from the browser's navigation request, that is the old route's original address, so it lacked what the page had put into its address with `history.replaceState` (a challenge adds `?__cf_chl_tk=…` and sends it back as the Referer); `SUBMIT_PREPARE` carried the page's current virtual URL and the worker dropped it. And a cross-origin form carried the destination's origin as `Origin`, because the submission's entry is made for the address it posts to; natively it is the submitting document's origin.
- **Fix:** `09-nav-net.js` sends `fromEntryId` with the existing `referrer`; `sw.js` (`SUBMIT_PREPARE`) keeps it only when it is an http(s) address in the origin of that entry (the rule a fetch's `documentURL` follows), stores it with the pending submission, and `transportFetch` takes it as the Referer and as the origin of the request (`submitReferrer`). Anything that fails the check keeps the old derivation.
- **Result (2026-10-23, finished build):** the real path (launcher, parent and widget proxied, site frames, challenge compatibility) lands on the Glassdoor home page in every run where the widget passes. With a harness that clicked at a fixed delay the widget seemed to pass in only about 40% of runs (7 of 18); that was the harness (next bullet), and with a person-like click the real path lands in **8 of 8** runs, one click each.
- **Harness trap (cost an hour of bisecting a gap that did not exist):** Turnstile shows a "verifying" spinner first and the checkbox only after its first large `fo` POST (about 90 KB). A click at a fixed delay after the iframe appears lands on the spinner in a slower run and is ignored; the widget then shows the checkbox and waits. The traces gave it away: the failing runs have the same hops as the passing ones up to the first large POST and then nothing, where a passing run sends a second large POST right after the click; and one verbose run had the click at 20.0 s and the checkbox at 20.5 s. Click when the checkbox state has been visible for a moment, and click again after 12 s if nothing happened, as a person would (`.lean-ctx/full-proxied5.js`). Also: the `PASS` of a harness must be the landing page, never "the title changed". The native parent with the widget at its real site-frame host (`.lean-ctx/stageC.sh`) passes 6 of 6, so the site-frame host and its own process were not a cause either; that platform needs the bridge's site-document path, because the server answers a site frame's launcher with `frame-ancestors http://*.localhost:<port>` and a native `glassdoor.com` may not embed it.
- **Closed by:** e2e `a form submission carries the submitting document's current address as its Referer, redirect hops included (matches native)` (`test/e2e/proxy.test.js`): it compares Referer, Origin, Content-Type, `Sec-Fetch-Site` and body at both hops of a 308 then 302 chain, same-origin and cross-origin, with native (it caught the `Origin` gap). 258 of 258 e2e pass in both site-frame modes.
- **Left open:** a `405` navigation document delivered by the worker ended as `ERR_INVALID_RESPONSE` instead of showing its body; why was not investigated.

## <a id="empty-document-charset-2026-10-27"></a>An empty document with a charset other than UTF-8 became a 502 "Malformed HTML" page (2026-10-27) {#empty-document-charset-2026-10-27}

- **Category:** `service worker / documents`
- **Symptom:** a frame whose document answers `200` with no bytes and `Content-Type: text/html; charset=iso-8859-1` showed ZeroProxy's "Malformed HTML" error page; natively it is a blank document. Found chasing Bing's hidden token frame (`POST /identity/idtokenv2` answers `200` with 0 bytes): that request does not reproduce the 502 recorded for it on 2026-10-25 (it passes through with a UTF-8 or no charset), so Bing was not the cause, but this path was real.
- **Cause:** `transformDocumentResponse` (web/sw.js) treats an empty transform output as a failure, so that a rewriter that fails cannot let unrewritten inline scripts through. A response in UTF-8 is piped through the streaming transformer and never gets there; one with another charset is buffered, and the transform of no bytes is no bytes. Variants measured with the old code, native against proxied in an iframe by GET and by a form POST: `Content-Length: 0`, chunked, no length, whitespace only, an empty gzip body: identical; `charset=iso-8859-1`: the error page.
- **Fix:** an empty output is a failure only for a document that had content (`html.length === 0` is fine).
- **Closed by:** test/e2e/proxy.test.js `a document with no bytes loads as a blank document, as natively` (fixture `/xemptyframe`; with the old code it fails).
