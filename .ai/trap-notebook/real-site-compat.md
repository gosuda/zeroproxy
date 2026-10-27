# Real-Site Compatibility Patterns: Historical Category Summary

Historical records of root causes, fixes, and disproved hypotheses observed on live sites; **not a current approved specification**. All measurements and verifications reflect results at the time of recording, with no new runtime executions during documentation edits. Past proposed tests and implementation gaps are unverified historical notes rather than active TODOs. Removed `ARCHITECTURE` and `PHASE` status documents remain historical references rather than authoritative specs. Later corrections supersede earlier hypotheses.

Current status (measured 2026-09-29 with a cold profile): **The GitHub error page is resolved** (the landing app renders at 100% height, 1811/1811 elements, and 0 errors). Multiple defects contributed: [module kind](rewriter.md#module-kind-url), [custom element prefixing](rewriter.md#ce-prefix-strip), [prepareStackTrace recursion](rewriter.md#prepare-stack-recursion), and [optional-chain short-circuiting](rewriter.md#contiguous-optional-chain). Behind Cloudflare, `gosuda.org` and MDN render at 100% with 0 errors on a cold profile, whereas interactive Turnstile challenges still receive environment rejections from Cloudflare (see the Turnstile entry below, Phase 3). CNN renders at 100% height with 0 script exceptions; remaining console errors come from ad and ID-sync hosts rejecting proxied requests (request bodies were measured byte-identical to native). The second CNN freeze remains unreproducible. Distinguish Cloudflare's historical [eval fix](LOG.md#2026-08-18-15) from the [warm clearance false positive](LOG.md#2026-08-18-18).

<a id="2026-07-30-all-get-form-submit-targeted-proxy-itself-naver-search-not-found"></a>
## 2026-07-30: GET and POST form submissions targeted the proxy itself

- **Cause**: `htmltx` rewrote `action` and `formaction` to `<proxy>/zp/?via=<target>`, and `submitFormNavigation()` then read back the raw attribute. GET submissions replaced the query string with form data, destroying `via`, while POST submissions passed the malformed launcher URL as `ZP_SUBMIT_PREPARE.targetUrl`. `TARGET_CONNECT_FAILED` on NAVER search was a cross-site form submission bug rather than a token or transport failure.
- **Fix and invariants**: `submissionActionURL(form, submitter)` in [web/runtime-prelude.js](../../web/runtime-prelude.js) resolves the target URL in the same order as click navigation: `urlMeta`, `data-zp-target-url`, and finally the raw attribute. The raw attribute is a fallback only for unrewritten JS-created or relative forms. Rewritten attributes are output for native browser UI and must never be read back as internal truth. Hovering, middle-clicking, opening in a new tab, or copying link addresses must never expose or connect directly to the target host. Launcher targets for GET form actions must reside in the URL path rather than the query string.
- **Evidence and verification**: `form.action` appeared valid because it was virtualized, while the stashed attribute was hidden from `getAttribute` by the stealth membrane. Both English and Korean NAVER searches succeeded, and `static-policy` passed 70/70. [test/js/static-policy.test.js](../../test/js/static-policy.test.js) enforces routing through the helper and forbids raw `formaction || action` reads.

<a id="2026-06-05-naver-probe-shape-windowzpzeroproxyrt-visible-tight-loop-probe-taskweaver-env-noise-root-fix-1"></a>
## 2026-06-05: NAVER fingerprint exposure, loop caps, and `taskweaver` environment noise

- **Cause**: The warm-session wedge persisted after the [June 4 entry](#2026-06-04). Although native `toString` masking on membrane functions worked, non-enumerable `window.ZP` and `ZeroProxyRT` properties remained visible to `getOwnPropertyNames(window)`. In addition, `taskweaver` runs on WebView2 + Tauri rather than Chrome and injects unmanaged host globals (`__TASKWEAVER_*`, `__TAURI*`, `ipc`).
- **Fix and rules**: Made globals in [web/zp-core.js](../../web/zp-core.js) and [web/zp-rt.js](../../web/zp-rt.js) configurable, captured them in closures inside the [prelude IIFE](../../web/runtime-prelude.js), and deleted them from `window`. The Symbol installation marker remains visible to `getOwnPropertySymbols`. The [rewriter](../../crates/zp-rewriter/src/lib.rs) adds iteration caps to constant infinite `for`, `while`, and `do` loops while leaving finite conditions untouched, preserving `break`, `continue`, and closure semantics with isolated counters for nested loops.
- **Verification and limits**: All 7 loop unit tests passed. Manual verification in `msedge` rendered ads, news, shopping, and weather without wedging, whereas `taskweaver` still wedged. Host environment fingerprinting was identified as the primary factor masking the fix in `taskweaver`. Parity in Chrome was inferred, Firefox was unverified, and loop cap triggers were not observed on NAVER. SDK sandboxing, chained reflection adjustments, and recursive timeout caps remained unverified proposals. See the [previous-day SDK mitigation](#2026-06-04-naver-warm-session-v8-wedge-wtmncpt-block-insufficient-gfpnacveta-sdk-wedge-ad-unrendered-trade-off).

<a id="2026-06-04-naver-warm-session-v8-wedge-wtmncpt-block-insufficient-gfpnacveta-sdk-wedge-ad-unrendered-trade-off"></a>
## 2026-06-04: NAVER warm-session wedge and SDK blocking trade-offs

- **Cause**: Persisting cookies in IndexedDB via [web/sw.js sharedJars/openCookieDb](../../web/sw.js) restored `NACT` cookies, causing the server to deliver heavy trusted bundles that triggered a V8 tight-loop wedge. Cold sessions stayed interactive without wedging but left some sections unrendered. Blocking external trackers and WTM/NCPT alone was insufficient; GFP, NAC, and Veta scripts also contributed, though intermittent reproduction prevented bisecting a single root cause.
- **Mitigation at the time**: Commit `edd98d4` blocked `pm.pstatic.net/resources/js/{main,polyfill,preload,search}.*.js` and `ssl.pstatic.net/{tveta/libs/glad/,melona/libs/gfp-nac-module/,tveta/libs/assets/}`. News, login, and navigation menus reached `complete`, but SDK ad slots stayed empty. Re-enabling GFP alone or all SDKs restored the incomplete load and wedge, and adding a `userAgentData` stub had no further effect.
- **Evidence and follow-up**: Recorded under the [web/sw.js NAVER block](../../web/sw.js). Native-code checks and Client Hints were observed, while additional fingerprint vectors remained unconfirmed. Earlier fixes (WTM/NCPT on June 1, `installSafeFrameResizeShim` on May 31, and SafeFrame loader / `decode_common_html_entities` on May 30) were insufficient on their own. AST probe neutralization and iframe/isolate sandboxing remained unverified proposals; see the June 5 entry for the subsequent standard Edge verification.

<a id="2026-05-30-github-home-page-partial-render-webpack-publicpath-unresolved"></a>
## 2026-05-30: Partial GitHub `publicPath` fix; `ErrorPage` unresolved

- **Cause**: Webpack Automatic `publicPath` stripped the query string and final path segment from `/zp/api/fetch?url=...`, requesting chunks from `/zp/api/<chunk>` and failing with `ChunkLoadError`. Addressed by adding `absolute_target_url` and `data-zp-target-url` in `crates/zp-htmltx/src/lib.rs` and returning the original target URL from `script` and `link` getters.
- **Final correction**: The hypothesis that `transform` or element handlers never ran and failed to plant stashes was false. A sentinel in Service Worker `transformHtml` confirmed attribute injection; the attribute was absent in DOM inspection only because of [intentional attribute masking](membrane.md#2026-05-30-zp-attr-masking-circuit). `publicPath` resolved properly through `urlMeta`, `Native.getAttribute`, and the native getter fallback.
- **Verification and unresolved state**: The `external_stylesheet_link_rewritten` unit test passed, multiple chunks loaded, the Rspack queue activated, and React reached `loaded`. However, GitHub still rendered `ErrorPage`. Data fetches, router state, or SSR/CSR mismatches remained unverified hypotheses, with no regressions observed on other sites. Switching to path-based URLs remained a historical proposal.

<a id="2026-05-29-wikipedia-bbc-broad-site-compatibility"></a>
## 2026-05-29: Wikipedia and BBC compatibility verification

- **Conditions and result**: After fixing POST bodies, `Referer`/`Origin`, and `User-Agent` forwarding, main Wikipedia views and the BBC homepage rendered cleanly with zero console errors on Wikipedia.
- **Related trap**: A BBC SDK assigned to `fn.constructor` and threw on the read-only lock in `dynamicConstructorWrappers`, though the error was non-fatal. Prototype mutations by libraries such as Axios or Lodash can break boot chains, so visual rendering does not prove the absence of script errors.
- **Scope**: See [User-Agent smuggle](sw-integration.md#2026-05-29--user-agent-forbidden-header-smuggle). The claim at the time that header smuggling resolves most anti-bot checks exceeded the evidence from these two sites and did not resolve GitHub or Cloudflare challenges.

<a id="2026-05-29-naver-center-ad-iframe-gray-placeholder"></a>
## 2026-05-29: Gray placeholder in NAVER premium ad iframe

- **Observation and hypothesis**: The `https://shopsquare.naver.com/` target URL was accurate, but `sandbox=""` disabled scripts and created an opaque origin, causing `contentDocument` access to throw `SecurityError`. At the time, the `MutationObserver` attribute filter omitted `sandbox`, though whether that caused the ad-loader failure was not confirmed.
- **Unconfirmed branches**: `postMessage` injection, upstream blocking prior to sandbox removal, or `gfp-bridge.js` failure remained possible causes. Other ads and `recoshopping` rendered normally in this run, isolating the issue to the premium slot. Stripping `sandbox` restrictions is not an approved fix.
- **Status**: Recorded as an unresolved missing ad at the time. Do not conflate this with the later closure of raw `shopad` URL leaks.

<a id="2026-05-29-naver-top-right-recoshopping-nextjs-iframe-application-error"></a>
## 2026-05-29: Next.js `Application error` in `recoshopping` iframe

- **Root cause**: Chunk loading, script rewriting, RSC payloads, and product APIs were intact. However, Rust `kernel_fetch` sent an empty `Vec::new()` for POST bodies and `new Request` stripped `Referer` and `Origin`, causing `/api/v1/collect/exlogcr` to return 400. Calling `concat(undefined)` on the missing `exposeContents` field inserted `undefined` into component state, and the subsequent `adCntsSeq` read triggered the React error boundary.
- **Correction and fix**: Initial hypotheses involving React timing, SWR races, synchronous fetch behavior, or RSC mangling were superseded by this transport bug. Fixed POST body forwarding and forbidden header smuggling; see the "Missing POST body and Referer/Origin" entry in `sw-integration`.
- **Verification and evidence**: Rebuilding restored the recommendation header and product cards with 0 diagnostic errors. Scope was narrowed by inspecting `__zp_diagnostics` in `runtime-prelude.js` and `__zp_get` in `webpackChunk_N_E`. See [membrane.md](membrane.md) and [rewriter.md](rewriter.md).

<a id="2026-05-29-naver-searchbar-transparent-placeholder"></a>
## 2026-05-29: Transparent NAVER search placeholder

- **Pattern**: The native `::placeholder` pseudo-element is intentionally transparent and paired with a JS overlay and `#autoFrame`. Evaluate input element presence, geometry, and computed style separately.
- **Correction**: Treating a transparent placeholder as proof of JS initialization failure was invalid. Subsequent inspection showed the blank idle state is intentional by design and typing triggers autocomplete normally.
- **Diagnostic limit**: Using the absence of `veta`, `N`, or `jindo` globals as evidence of initialization failure was also retired by the globals correction below. Do not classify hidden UI widgets as proxy regressions without comparing against native behavior.

<a id="2026-05-29-navercom-smoke-test-actual-globals-revised"></a>
## 2026-05-29: Corrected NAVER smoke-test globals

- **Actual surface**: Verified initialization indicators on NAVER were `gladsdk.cmd`, `ndpsdk.cmd`, `ntm`, `nsc === 'navertop.v5'`, `nmain.jsOrigin === 'www'`, `webpackChunkpc`, and `EAGER-DATA`/`ELECTION-DATA`.
- **Retired assumption**: Assuming NAVER defines `veta`, `N`, `jindo`, or `NDPCorePostCmd` on `window` was wrong. Never use non-existent globals as failure criteria.
- **Evidence and security**: Distinguished malformed script targets ([setScriptSource regression](membrane.md#2026-05-29-setscriptsource-absolute-proxy-url-truncation)) from missing `__zp_get` rewrites ([missing script destination](sw-integration.md#2026-05-29-zpapifetch-script-destination-undetected)). Smoke verification confirmed that all external scripts routed through the proxy without raw URL leaks or direct bypasses.

<a id="2026-06-02-naver-main-dynamic-ad-slots-unfilled-pc-main-ad-div-p_main_-ntmpstaticnet-block-attempt-reject"></a>
## 2026-06-02: Unfilled dynamic ad slots and rejected `ntm` block

- **Observation**: Dynamic slots (`pc-main-ad-div-p_main_knowledge-*`, `p_main_rightside_understock`, `p_main_rightbottom_widget`, `right-ad-1`) remained empty while pre-bid ads in the SSR inline waterfall rendered. The empty slots required live calls to `tivan.naver.com` that never fired.
- **Refutation and rule**: Suspecting long `ntm` resource durations of causing starvation similar to WTM/NCPT and blocking `ntm.pstatic.net` broke existing premium, side, and Veta ads. Because `ntm` provides functional dependencies for bid tokens and impression keys, **do not block `ntm` like WTM/NCPT**. Whether the long duration reflected real starvation or a measurement artifact remained unconfirmed.
- **Status and evidence**: The `ntm` block was reverted and dynamic ad slots remained unfilled. Differences in ad inventory across anonymous, regional, or authenticated cookies or skipped `displayAd` calls remained open hypotheses. See [sw.js:395-401](../../web/sw.js#L395-L401), [sw.js:382-401](../../web/sw.js#L382-L401), and [naver-main-inline-11](https://www.naver.com/).

<a id="2026-05-29-navercom-post-fix-1-verification-correction"></a>
## 2026-05-29: Post-fix NAVER verification corrections

- **Verification at the time**: After fixing storage recursion, script destination detection, `scriptProxyPath`, `fetchThroughRuntime`, and `workerBootstrapURL`, verification confirmed proxied script routing, core globals, webpack entry execution, and SSR news, widget, ad, and login sections with zero raw script URL leaks.
- **Correction**: Earlier reports that the search bar, ads, and widgets failed to render and that entry scripts never ran were wrong. Search autocomplete worked when typing, ads and widgets loaded progressively, and entry side effects were confirmed.
- **Follow-up priority**: The remaining `recoshopping` failure was initially attributed to React 19 RSC hydration or stream mangling, but was later resolved by the POST body and `Origin`/`Referer` fix above. References to `PHASE2_PLAN.md` B3/site-quirks mapping and stream diagnostics are historical context, not active TODOs.

<a id="recommended-sites-for-new-categories-e2-matrix-candidates"></a>
## Historical E2 matrix candidate sites

- **Baseline candidates at the time**: `https://www.naver.com/` (ads and iframes), `https://gosuda.org/` (home regression), `https://news.ycombinator.com/` (plain HTML baseline).
- **Complex and adversarial candidates**: `https://github.com/` (React and dynamic imports), `https://www.google.com/` (anti-bot and fingerprinting).
- **Status**: Historical candidate list from `PHASE2` E2 planning, neither an active approved matrix nor proof that these sites pass.

<a id="2026-08-20-naver-shopad-residual-closed-20-armed-runs-raw-url-0-hits"></a>
## 2026-08-20: Closure of residual raw `shopad` URL observations

- **Verification**: Confirmed `--record --enforce-csp` and `csp_bypassed:false`, and armed `.ai/dogfood/wtm/zpraw-observer.js` at `document-start` via `inject-script --world isolated`. Across 20 consecutive runs of `.ai/dogfood/wtm/shopad-hunt.sh`, every frame was armed, `shopad` loaded, and both CSP violations and raw URL hits stayed at 0.
- **Scope**: Closed at the time as unreproducible. Either the August 18 `setAttributeNS` fix or the August 20 static `<iframe src>` fix resolved the leak, without pinpointing which one.
- **Correction**: The earlier claim that server A/B testing rarely attached the ad module contradicted the 20/20 attachment rate observed here. Past low reproduction rates were likely observation failures caused by disabled CSP. After fixing an observer, re-verify baseline attachment rates as well as failure symptoms.

## Missing CNN APS frames (2026-08-25, partially corrected, residual unresolved) {#cnn-aps-frame}

- **Narrowed causal chain**: Even after fixing the `document.location` leak restored `turner_getGuid`, ad frame counts stayed low. The creator of `apstag-iframe` was BounceExchange (`ads-v2` and `main-v2`) rather than Amazon directly, gated on `bouncex.website.sspConfig.aps`. Because the prelude captures DOM methods at boot, creation tracing had to hook `Document.prototype.createElement` at `document-start` rather than installing an instance wrapper.
- **Configuration and storage observations**: The proxy trace showed no requests for `sspConfig`, `bouncex.state`, or `state/js`. The cached bundle `cache/7291/website-<hash>.js` never contained `sspConfig` statically; instead, it fetched `api.bounceexchange.com/state/js` using the `device_id` supplied by the storage frame. `bcx_local_storage_frame` had a complete rewritten `src` attribute in the DOM but remained an empty document.
- **Refutations**: Target `#7291` loss, child `location.href`/`hash`/`search` corruption, `apstag` load failure, and CSP `frame-src` blocking were all ruled out. Response header CSP was active, and console warnings only reflected ignored `<meta>` CSP tags placed outside `<head>`. Reading `contentWindow.location` from the parent returning the parent URL was a separate surface issue. Fetching without the URL fragment returning a 200 landing page was also ruled out as the navigation failure cause.
- **Follow-up correction (Service Worker deadlock)**: The initial conclusion that the browser never requested the iframe document was wrong. CDP showed the Document request, and after the Service Worker constructed the 200 response, `respondWith` hung at `await clients.get(resultingClientId)`. See [clients.get deadlock](sw-integration.md#clients-get-deadlock). `src` rewriting during adoption/insertion and missing browsing contexts during streaming were both ruled out. Inspecting the real `src` required a native accessor captured at `document-start` because page getters and late descriptors were already virtualized.
- **Final verification and residual gap**: Resolving the deadlock alone did not restore the `state` request, but after the [postMessage incumbent fix](rewriter.md#postmessage-incumbent), `device_id`, `sspConfig`, prebid, bid requests, and GPT slots matched the control group. **Only the "ad auction never runs" failure branch was closed.** Total frame counts still differed and fluctuated across control runs, so this neither proves full CNN parity nor guarantees identical single-run counts. Multi-run distribution comparisons remained a proposal.

## <a id="cnn-second-freeze-unreproducible"></a>Unreproducible second CNN freeze (2026-08-26)

- **Status at the time**: The recorded symptom was a renderer process surviving with a large heap while CDP stopped responding. Across 9 reproduction attempts covering the front page, articles, cold starts, and extended scrolling, every run reached `complete` with normal responsiveness, healthy GC, and 0 automatic hang dumps under `--record --watch-hang`. **The root cause remains unconfirmed, and non-reproduction is not proof of a fix.**
- **Refutation and hypothesis**: Intentionally re-introducing `await self.clients.get(resultingClientId)` from `1bcae09` stalled document loading at `interactive`, but the renderer remained responsive to CDP. That ruled out `clients.get` as the cause of the second freeze, and the test mutation was reverted immediately (**never commit fault-injection mutations**). The hypothesis that an only partially memoized `filteredCollection` $O(N^2)$ allocation storm in `5004b5e` caused the freeze remains unverified.
- **Diagnostic notes and residual gap**: Running `--record --watch-hang --auto-dump-dir <dir>` preserves ring buffers and `hang.json`. Proposed diagnostics at the time included `pause --symbolize --samples 6` (with `--download-symbols` and `dbghelp.dll`/`symsrv.dll` next to the binary), `--full-memory --only-pid` for heap inspection, and `debugger-arm --strategy exceptions --sample-every N` for engine exceptions. Page-level `Error` wrappers cannot catch V8 internal `TypeError` throws. Element counts matched the control group closely, though a shortfall in ad iframes remained.

## <a id="missing-layout-axis"></a>Missing layout regression axis and false-positive GitHub pass (2026-09-04)

- **Cause of missed regression**: The August 26 `<style>` HTML-escaping bug corrupted page height while passing element count, raw URL, CSP, and console error checks. `rendercheck.sh` was updated to compare `styleEntities`, height ratios, and above-the-fold visible elements across paired direct and proxied runs. Because `<style>` is parsed as raw text, HTML entities inside it are never decoded by the CSS parser. CSS rule counts (`cssRules.length`) were not used as an oracle because same-origin proxying allows reading cross-origin stylesheets that throw `SecurityError` in direct runs.
- **Verification**: Comparing the fixed build against a positive control with the single-line escaping bug restored confirmed that only the new `styleEntities` and height axes caught the regression; element count, raw URL, and CSP checks passed on the broken build. Threshold constants used at the time are historical test settings rather than normative specifications.
- **GitHub false positive and correction**: In the initial site comparison, GitHub replaced the page body with its `ErrorPage` while keeping `title`, raw URLs, CSP, and console error counts clean, causing repeated false reports that GitHub worked. Never judge rendering success from `document.title` alone; compare body content, layout height, and visible elements. The root cause was not investigated in that session, and GitHub `ErrorPage` remained unresolved until the September 29 fixes noted at the top of this file.
Follow-up correction: In the [non-HTTP scheme investigation](rewriter.md#non-http-scheme-three-layers), repeated comparisons with matched wait times showed no total frame count gap on CNN. Do not reuse the earlier frame shortfall numbers as a permanent defect baseline, though this does not explain or close the unreproducible second CNN freeze.

<a id="turnstile-arming-verification"></a>
## 2026-09-22: Turnstile per-tab arming gate verification (gate intact, Cloudflare verdict rejects environment)

- **Measurement**: Loaded `turnstile.zeroclover.io` with per-tab arming enabled (`#challenge-compat`). Only the challenge document (`403` with `cf-mitigated: challenge`) received the armed CSP allowing `https://challenges.cloudflare.com` in `script-src`, `frame-src`, `child-src`, and `connect-src`, while all other responses in the same tab remained disarmed. The internal `X-ZP-Challenge-Compat` marker header was stripped before reaching the page (B4 strip intact). The two-signal gate `challenge_subresource_skip(armed && !is_doc && classifier)` was verified on the wire.
- **Challenge execution**: `_cf_chl_opt` initialized 32 keys and the `orchestrate/chl_page/v1` script loaded with status 200 and executed through the proxy. However, `window._cf_chl`, `turnstile`, and the challenge iframe were never created; Cloudflare rendered its `"Browser not supported"` UI and terminated the flow. This is an **environment rejection by Cloudflare against the headless/membrane runtime** rather than a gating failure, matching the earlier Stack Overflow observations.
- **Rule**: The verification contract for per-tab arming is that only armed challenge documents receive the allowlisted CSP and no internal marker leaks to the page; both invariants passed. Passing the interactive challenge verdict belongs to the Phase 3 fingerprint hardening track.
- **Verification**: Checked with `scripts/turnstile-probe.cjs` (one-off diagnostic) and the `turnstile` target in `real-site-regression` (which checks the arm box automatically). CNN, `gosuda.org`, and MDN all passed after the membrane fix batch, and the historical second CNN freeze did not reproduce.

<a id="smoke-order-and-turnstile-demo-2026-10-23"></a>
## 2026-10-23: The smoke harness failed from the second site on (a click on a disabled button), and the Turnstile demo's origin answers 502 natively {#smoke-order-and-turnstile-demo-2026-10-23}

- **What was reported:** MDN, gosuda.org, CNN and the Turnstile demo timed out at baseline, and several sites in one harness process failed from the second on. Both were looked at as possible compatibility defects.
- **Harness race, not a product defect:** `real-site-regression.test.js` clicked the first `button` as soon as `navigator.serviceWorker.controller` existed. The launcher keeps Open disabled ("Preparing isolated transport…") for a while after that, and a click on a disabled button is dropped: the tab stays on the launcher with "Ready." and the typed URL, title `ZeroProxy`. Whether it won the race depended on the context. A diagnostic (`.lean-ctx/ctx-seq.js`, sequential BrowserContexts) printed the button state at the click. The harness now waits for `#open button:not([disabled])` (interval polling: a covered page gets no animation frames) and clicks that. Six sites (Wikipedia, example.com, Hacker News, MDN, gosuda.org, CNN) pass in one process.
- **MDN, gosuda.org, CNN:** pass alone and together with the wait. For CNN that was only the title: its renderer died 10 to 30 s later (see [site-frame-route-loop-2026-10-24](rewriter.md#site-frame-route-loop-2026-10-24)), which the title-only harness could not see; the harness now also asks the page to answer after it loaded.
- **Turnstile demo (`turnstile.zeroclover.io`):** real Chrome with no proxy at all ends the same way: `307`, `403` challenge, the widget solves it, the form `POST` answers `502: Bad gateway` (a Cloudflare error page for the demo's own origin). The proxied run reaches the same page. The target cannot show a pass while its origin is down; Glassdoor (`.lean-ctx/full-proxied5.js`) is the working interactive check. The harness target stays as it was (opt-in, not in the matrix).

## 2026-10-24: Yahoo home: the first hydration stalled on a stripped preload; what still differs {#yahoo-home-2026-10-24}

- **Before:** the proxied home page stopped after its server HTML (1 226 elements against 2 958 natively, 6 iframes against 44, no header menu, no widgets, no feed), with no page error. Cause and fix: [yahoo-preload-hint-2026-10-24](rewriter.md#yahoo-preload-hint-2026-10-24).
- **After (25 s, headless Chrome, `.lean-ctx/site-diff.js`, `dom-diff.js`, `react-state.js`):** the React root commits (3 801 fibers, no pending lanes), 2 144 elements, 43 iframes against 44, header with Sign in, widget row, Trending list and carousel as natively; ad creatives and the weather panel differ per load natively too.
- **Still different, not investigated:** the header menus and sidebar (`#module-uh` 88 against 579 elements, `#expanded-sidebar-nav-uh`, the `*-submenu` blocks), the second half of the feed (`#strm` 462 against 893), Taboola widgets (`#trc_wrapper_*`), `InContextLoginController` loaded where natively `MoreMenuDropDown` is (the signed-in/out header state), `udc.yahoo.com` and `guce.yahoo.com/v1/consentRecord` requests that Chrome reports as aborted through the proxy (natively 204/200), the video API calls (`video-api.yql.yahoo.com`, `tb.pbs.yahoo.com`) that are never made, and one right-rail ad iframe that shows the ZeroProxy launcher page.

- **Correction (2026-10-25), supersedes the "still different" list above:** the native runs behind it were headless Chrome, which Yahoo serves as a bot (its feed modules mount at once, its menus and video modules are server-rendered). Against a native page with the same User-Agent minus `Headless` the feed, the header menus and the portals are identical; what really differed were four membrane defects (the Navigation API facade recursed, `localStorage` did not inherit from `Object.prototype`, protocol-relative URLs in runtime CSS never reached the proxy, a style filled through the tree was rewritten too late), fixed and pinned: [yahoo-second-pass-2026-10-25](rewriter.md#yahoo-second-pass-2026-10-25). Left: ad creatives and comment counts differ per load natively too; the ad-frame "Could not reach target" pages are unreachable hosts or legacy TLS (ERRATA).

## 2026-10-25: Bing home: 262 elements against 470, no widgets {#bing-home-2026-10-25}

- **Baseline:** headless Chrome with and without `Headless` in the User-Agent gives the same Bing page (unlike Yahoo); 469 to 480 elements, 132 to 134 container kinds, one page error (`_w is not defined`) natively.
- **Before:** 262 elements, 81 container kinds, two page errors, a refused script. Missing: the right-hand header, the visual-search dialog, the MSN widget area.
- **Causes and fixes:** a strict inline script redeclaring a var an earlier one made (`var _w = _w || {}`) read its own `undefined`; an external script (real, not `eval`) whose own var the helper then wrapped in an accessor that called itself; `<script type=module src=blob:>` refused, so es-module-shims took the browser for one without modules; and a containment gap the blob work exposed (a static `import` of a blob ran unrewritten). All in [bing-strict-redeclare-and-blob-modules-2026-10-25](rewriter.md#bing-strict-redeclare-and-blob-modules-2026-10-25).
- **After:** 472 elements, 134 container kinds each side, the same single page error; the container kinds still missing are a per-load random id and an "enlarge image" button label. Requests to `msn.com` hosts: 71 against 86 in one 20 s window.
- **Left:** `/identity/idtokenv2` answers an empty body and the service worker returns 502 `MALFORMED_HTML`; the page matches native with it. Not investigated.

## 2026-10-26: Google home: 429 elements against 530, `_DumpException` {#google-home-2026-10-26}

- **Baseline:** headless Chrome, UA with and without `Headless`: 530 to 552 elements, no page error natively.
- **Before:** 429 elements, one page error; the consent and terms dialogs missing.
- **Cause and fix:** the page redefines `window.setInterval` with `Object.defineProperty` and every membrane hook was non-configurable: [hook-configurable-2026-10-26](rewriter.md#hook-configurable-2026-10-26).
- **After:** 547 against 552, no page error; the elements still missing are per-load random ids.

## 2026-10-26: YouTube home: 421 elements against 2 017 {#youtube-home-2026-10-26}

- **Survey of the same day (native with the UA minus `Headless`, proxied, 15 to 20 s):** Amazon 2 044 against 2 043 (one cold first load rendered 11 elements, not reproduced), Reddit and GitHub identical, Stack Overflow more elements proxied (ads), NYTimes a bot wall in both (9 elements). YouTube was the one real gap.
- **Causes and fixes:** a rewriter table that printed a marker into the main bundle, a window receiver, an accessor that could not be redefined: [youtube-home-2026-10-26](rewriter.md#youtube-home-2026-10-26).
- **After:** 2 019 against 2 017, no page error.

## 2026-10-26: second survey (native with the UA minus `Headless`, 15 s) {#second-survey-2026-10-26}

- Naver 1 187 against 1 187; Pinterest 985 against 985; LinkedIn 772 against 760; Netflix 1 107 against 1 086; Twitch 1 612 against 1 688 (not investigated: 4 percent, no page error on either side).
- Medium: fixed, [inline-module-origin-2026-10-26](rewriter.md#inline-module-origin-2026-10-26).
- eBay: the native run was served an error page, the proxied one the real page; its one page error is an Akamai sensor script (not pursued).
- IMDb: the native headless run was served a human-verification page, the proxied one the real page (4 987 elements).

## 2026-10-26: the recorded sites measured again with the fair baseline (native with the UA minus `Headless`, 20 s) {#recorded-sites-recheck-2026-10-26}

- **Same or within a native run's own spread:** Wikipedia 2 446 against 2 445 elements, BBC 2 723 against 2 734, Hacker News, MDN, gosuda.org, CNN (3 996 against 3 997, 30 frames each), GitHub, Stack Overflow, Google, YouTube (2 016 against 2 019), Bing (475 against 470, the same single `_w` page error). NAVER 938 to 1 111 natively across three runs against 935 to 1 186 proxied (ad counts differ per load). Yahoo's text length differs between native runs too (4 022 to 5 528), its Taboola widget counts are equal.
- **Found:** a loader that checks for its own element by attribute selector found nothing through the proxy and added a second one (BBC 11 scripts twice, Medium's reCAPTCHA twice, Yahoo 24 links twice): [url-attribute-selectors-2026-10-26](rewriter.md#url-attribute-selectors-2026-10-26). Fixed.
- **Medium's 84 extra elements (374 against 290) were that:** 76 `<link rel=modulepreload as=script>` Vite's preload helper added because its `link[href="…"]` check found nothing, plus a second reCAPTCHA badge. After the fix 97 links against 99.

## 2026-10-26: do stylesheet selectors on URL attributes need rewriting? No: measured {#stylesheet-url-selectors-2026-10-26}

- **Question:** after the JS query methods were made to match the page's URL values ([url-attribute-selectors-2026-10-26](rewriter.md#url-attribute-selectors-2026-10-26)), a style rule such as `a[href^="http"]::after` still reads the real attribute (the proxy address). Does that change what a page looks like?
- **Method** (`.lean-ctx/css-attr-sel.js`, not committed): the rules come from the proxied page's CSSOM; every selector that names a URL attribute with an operator, minus pseudo-elements and states the page is not in, is evaluated by the engine itself (CDP `DOM.querySelectorAll`, so physical attributes are matched exactly as a style rule would) in a native page (UA without `Headless`) and in the proxied one.
- **Result, 19 sites** (Wikipedia, MDN, GitHub, BBC, Stack Overflow, CNN, Yahoo, NAVER, Medium, Reddit, Amazon, Google, Bing, YouTube, Hacker News, LinkedIn, Pinterest, Netflix, Twitch): 68 such selectors in about 126 000 rules; 5 match anything natively (MDN's `textPath[href="#circle1"]` to `#circle5`, fragments, which are never rewritten); none matches differently. Sites reach for classes, not URL attributes, in rules.
- **Decision: not rewritten.** It would mean the same transform in the Service Worker's CSS rewriter, the HTML transformer's `<style>`, and every runtime path (`textContent`, `insertRule`, CSSOM), over stylesheets of up to 38 809 rules (GitHub), with a cascade risk, for no measured effect. If a site shows it, the transform is the one the query methods use (`:is([data-zp-lit-href OP v],[href OP v]:where(:not([data-zp-lit-href])))`; `:where` keeps the specificity).
- **Found on the way:** `content: attr(href)` paints the proxy address (Wikipedia's print stylesheet; print only), recorded in ERRATA. Not a selector: the engine reads the attribute inside `attr()`.
- **Limits of the measurement:** the loaded state of a home page after 12 s; sheets that load later, rules for states or elements that appear later, and old CMS sites (where `a[href^="http"]` icons live) are not covered.

## 2026-10-27: ten Korean sites (native with the UA minus `Headless`, 20 s) {#korean-sites-2026-10-27}

- **Same or within a run's spread:** Daum 3 419 against 3 442 elements, NAVER Cafe 1 562 against 1 559, Kakao 1 166 against 1 166, Namu Wiki 1 034 against 1 029, NAVER News 3 961 against 3 749 (not looked into), Coupang 972 against 957 (images and text length equal).
- **Gmarket:** the native headless run was served the "잠시만 기다리십시오…" interstitial (49 elements), the proxied one the real page; not comparable.
- **DCInside could not be reached:** [tls-legacy-suite-retry-2026-10-27](tls-fingerprint.md#tls-legacy-suite-retry-2026-10-27). After: 1 589 against 1 583 elements.
- **Tistory rendered its own error page:** [child-window-operations-2026-10-27](rewriter.md#child-window-operations-2026-10-27). After: 972 against 972. The same pass closed a gap in the containment of child windows' string timers.
- **Looked at, not changed:** Coupang's two page errors (`Function.prototype.apply was called on undefined`, through `__zp_call`) come from the Akamai bot-manager sensor (the script path is a random string, as on eBay), natively none; the page is the same (images, text). 11st: one `<script type=module src="data:text/javascript,…">` (a feature detector that sets `data-modern` from `import.meta.resolve`) is blocked, as every `data:` script is (unrewritten code does not run); the page renders identically (the same height, 6 010 px, screenshots compared); its one unhandled rejection (`undefined`) was not traced; one 502 on its `analytics.iife.js` was seen once and not reproduced (the script rewrites and parses fine).

## 2026-10-27: the leftovers of the Korean-site pass {#korean-leftovers-2026-10-27}

- **Twitch** (1 590 to 1 595 elements proxied against 1 682 natively, steady): fixed, [media-session-metadata-2026-10-27](rewriter.md#media-session-metadata-2026-10-27). After: 1 682 to 1 687 on both sides, the stream player present.
- **Bing**: the 92 failing `fast-…{…}` requests are gone, [inert-document-images-2026-10-27](rewriter.md#inert-document-images-2026-10-27); 466 to 469 elements against 469, the one page error (`_w is not defined`) is native's too. `/identity/idtokenv2` (a `200` with no bytes through a hidden frame) passes through without a 502 now; the 2026-10-25 note is not current. A related defect of the same shape (an empty document with a non-UTF-8 charset) was real and is fixed: [empty-document-charset-2026-10-27](sw-integration.md#empty-document-charset-2026-10-27).
- **NAVER News**: 3 864 and 3 867 elements in two of three 20 s runs against 4 041 to 4 050 natively; five runs at 25 s gave 4 108 to 4 118 against 4 126. A slower start, not a defect.
- **11st, `data:` script: tried and reverted.** Its `<script type="module" src="data:text/javascript,…">` (a feature detector that sets `data-modern` from `import.meta.resolve`) is blocked, so the page runs its non-modern path and renders identically (9 758 against 9 819 elements, equal text and images). Running the detector (decoded by the HTML transformer into an inline module; the unit and fixture tests passed, five shapes identical to native) made `data-modern` true and the app took its modern path, which starts with `import 'data:text/javascript,"pc.main.index.….js";if(!import.meta.resolve)throw Error(…)'`: a static `data:` import in a module the service worker serves, which fails closed by design (ERRATA). The page blanked (38 elements). So the detector stays blocked; supporting it needs the static `data:` import in served modules first. **Done properly the same day:** the service worker's script route serves `data:` addresses (decoded and rewritten), the rewriter sends static `data:` imports there, and the HTML transformer and the membrane do the same for `<script src=data:…>`; 11st then runs its modern path (9 688 against 9 689 elements, 300 images on both sides, no errors), see [data-scripts-2026-10-27](rewriter.md#data-scripts-2026-10-27) and [twelve-sites-2026-10-27](#twelve-sites-2026-10-27).
- **Coupang**: the one thing seen, `Function.prototype.apply was called on undefined`, is a call `obj.O(…)` on an instance of the sensor's own class (`JQ`), made through `__zp_call`; `O` is not a DOM member, so an earlier step of the sensor's probing went differently. Not pursued (the Akamai sensor; the page is the same).

## 2026-10-27: twelve more sites (native with the UA minus `Headless`, 20 s) {#twelve-sites-2026-10-27}

X, Facebook, Instagram, Spotify, Discord, TikTok, DuckDuckGo, Apple, Microsoft, OpenAI, Notion, Figma. Elements / images / frames / text characters / page errors, native against proxied.

| Site | First run | After the fixes |
|---|---|---|
| X | 495 / 1 / 2 / 252 / 0 on both sides | unchanged |
| Spotify | 2 980 / 56 / 3 / 1 818 / 1 error on both sides | unchanged |
| Discord, DuckDuckGo, Apple, OpenAI | equal (Discord 1 210 and 1 211 elements) | unchanged |
| Microsoft | 887 / 20 / 2 / 2 518, the same `querySelectorAllDeep` error natively | unchanged |
| Instagram | 510 / 1 / 0 / 715 against 499 / 3 / 0 / **0**, `__d is not defined` 8 times | 510 / 1 / 0 / 715 on both sides, no errors: [data-scripts-2026-10-27](rewriter.md#data-scripts-2026-10-27) |
| Facebook | 378 / 1 / 0 / 349 against 356 / 0 / 0 / 330 | 380 against 378 elements, 1 image and 349 characters on both sides: the same fix |
| TikTok | 730 / 4 / 0 / 217 against 156 / 0 / 0 / **0**, English title, `Illegal invocation` | 730 against 734, 217 characters on both sides, no errors: [window-receivers-2026-10-27](rewriter.md#window-receivers-2026-10-27) |
| Notion | 863 / 50 / 1 / 1 392 against 851 / 50 / 1 / 1 392, 2 errors | the same text, 851 against 863, one error left (`innerHTML` is not redefinable): [stack-hook-alias-2026-10-27](rewriter.md#stack-hook-alias-2026-10-27), [cookie-store-event-methods-2026-10-27](rewriter.md#cookie-store-event-methods-2026-10-27) |
| Figma | 1 598 against 1 577, no errors | equal in text and images; native alone varies 1 586 to 1 600 elements and 95 to 109 scripts (third-party tags), so nothing to fix |

- **11st measured again** after the `data:` scripts started to run (the case that made the first attempt fail): 9 688 against 9 689 elements, 300 images on both sides, no errors. The modern path works now that the static `data:` import is served.
- **Native-only detail worth keeping:** Figma's link and meta counts were equal on both sides (119 and 37); the first tag count of a single run suggested otherwise and was a different moment of the page.
