# Rewriter Regressions

Summary of past root causes, fixes, and verifications; not the current full accepted spec. Verifications apply only to the scope at that time, with no new runs during this consolidation. Later corrections supersede earlier hypotheses; for current E1, see the [plan](../design/website-compat-refactor.md).

<a id="worker-url-wrapper-internal-absorb"></a>
## Worker `self.URL` wrapper also intercepted internal `new URL` calls in prelude (2026-09-24)

- **Cause:** Replacing `self.URL` with a virtual base wrapper (`ZPWorkerURL`) caused every `new URL(value, realLocation.href)` inside the prelude to go through the wrapper. Its `unleaked()` unwrapped `/zp/*` inputs, turning `importScripts('/zp/assets/zp-page-bundle.js')` into a target URL: bundle loading failed and all dynamic code nearly died fail-closed.
- **Fix:** Capture `const NativeURLCtor = self.URL` at the top of the file and replace **every** `new URL(` inside the prelude with `new NativeURLCtor(`. This is the worker variant of the page `const URL = Native.URL` shadowing trap ([#native-url-shadowing](#native-url-shadowing)), except workers do not have an IIFE scope so bare `URL` hits the global directly.
- **Rule:** When wrapping a realm global constructor, obey the order: **capture first, switch internal calls, then install the wrapper**. After a bulk `perl` replacement, verify that the capture declaration precedes all uses (TDZ): inverted `const` declaration order kills boot.

<a id="sharedworker-name-masking"></a>
## SharedWorker `self.name` exposed the isolation prefix (2026-09-24)

- **Cause:** We prepend `zp:w:<hash>:` to isolate native SharedWorkers per target, but `self.name` inside the worker exposed the prefixed name verbatim: native returns only the name requested by the page.
- **Fix:** At boot, `worker-prelude` strips the `^zp:w:[0-9a-f]{8}:` prefix from `self.name` and redefines it. Updated the e2e pin from `zp:w:*` exposure to `swprobe` masking while keeping prefix isolation intact.
- **Rule:** Keep isolation prefixes strictly at the transport boundary (actual API arguments) and restore the requested value on every surface read back by the page or worker: `BroadcastChannel.name`, `SharedWorker` name, and OPFS `handle.name` all obey this rule.

<a id="opfs-name-marker-leak"></a>
## OPFS `handle.name` leaked the namespace marker and raw origin (2026-09-24)

- **Cause:** Namespacing `navigator.storage.getDirectory()` into a `ZP|<origin>` subdirectory caused the returned handle's `.name` to expose `ZP|http://target` verbatim, leaking both the internal proxy scheme and the raw target origin.
- **Fix:** Changed the subdirectory name to a `zp:o:<fnv1a-8>` hash (identical across page and worker). Only the hash is visible on `.name`, and the origin string does not leak. Residual gap: native root `.name` is `''`, whereas ours exposes the hash name as an approximation.
- **Rule:** Every surface read back by the page (handle names, channel names, DB name lists) must expose a hash or the requested value, never the raw namespace string.

<a id="localhost-secure-context-parity"></a>
## `isSecureContext` on `http://localhost` targets is `true` natively too (2026-09-24)

- **Cause:** Asserting `false` on an `http` target to verify `isSecureContext` virtualization failed: `localhost`/`127.0.0.1`/`.localhost` are potentially trustworthy origins, so native `isSecureContext` is `true` even over `http`.
- **Fix:** Updated the e2e assertion to `v:true` and noted in comments that the virtualized getter follows scheme+host rules and returns `false` on non-localhost `http`.
- **Rule:** Before asserting secure-context state, check whether the target host qualifies as potentially trustworthy: `http://` does not unconditionally mean `false`.

<a id="meta-csp-sync-arming"></a>
## Dynamic meta CSP arming race: MutationObserver is too slow (2026-09-23)

- **Cause:** `setAttribute('http-equiv','Content-Security-Policy')` only stashed the value without writing the native attribute, so a subsequent `setAttribute('content',…)` saw no `http-equiv` and wrote the raw attribute on the normal path. Because `http-equiv` restoration ran in `MutationObserver` (microtask), an image load started via `img.src=` immediately after `appendChild` fired without policy enforcement: `img-loaded` despite `img-src 'none'`.
- **Fix:** On the `content` set path, inspect both live and stashed `http-equiv`; if it is a CSP directive, perform content recording, filtering, and `http-equiv` restoration **synchronously** (armed before append). The observer path remains as a fallback for `innerHTML` and other reachability paths.
- **Verification:** E2E `metaStricter` (`createElement` + `setAttribute` + `append` followed by immediate `Image` load) passes with `img-blocked`.

<a id="lit-stash-substring-false-positive"></a>
## `data-zp-lit-*` caused false positives in "no raw URL" assertions (2026-09-23)

- **Cause:** The R6 literal stash `data-zp-lit-href="https://example.com/x"` contains `href="https://example.com/x"` as a substring after the `lit-` prefix. All 13 negative assertions in `zp-htmltx` tripped on it.
- **Fix:** Test helper `strip_lit` removes `data-zp-lit-*="…"` spans before running assertions. Because `"` inside attribute values is escaped as `&quot;`, the span extends to the first closing quote.
- **Rule:** Assertions checking that a raw URL is absent from output must always strip literal stash attributes first.

<a id="worker-internal-path-target-resolve"></a>
## Worker `importScripts` resolved internal `/zp/*` assets against the target URL (2026-09-23)

- **Cause:** In W1, the bootstrap loads `zp-page-bundle.js` via `importScripts('/zp/assets/…')`, but the prelude's `importScripts` override resolved **all** arguments against the virtual base, turning `/zp/assets/zp-page-bundle.js` into an upstream fetch to `https://target/zp/assets/…` (404, missing `ZPBundle`, `__zp_runSrcu` never ran).
- **Fix:** The override passes `/zp/` prefixes through **before** target resolution.
- **Rule:** No URL rewriting site in the worker realm may treat internal `/zp/*` paths as target URLs; the same mistake can recur in `importScripts`, `fetch`, or XHR.

<a id="worker-sync-xhr-route"></a>
## Worker sync XHR relay misclassified as a target request in SW (2026-09-23)

- **Cause:** Native sync XHR in workers is relayed via `POST /zp/api/sync-fetch`, but the SW fetch handler classified that path as a **target request** and sent `POST /zp/api/sync-fetch` upstream, resulting in a 404.
- **Fix:** Handle `/zp/api/sync-fetch` first as a dedicated relay in SW `classify`. On the worker side, when `async=false`, send a synchronous POST via `Native.XHR` and populate `xhr.getResponseHeader`/`responseText` from the relay response.
- **Rule:** Every new `/zp/api/*` route **must** be explicitly registered in the SW classification table: the default classification forwards to the target, turning omissions into silent upstream leaks.

<a id="worker-ws-base-mapping"></a>
## Worker WebSocket relative URLs must not pass an `http:` base directly (2026-09-23)

- **Cause:** Resolving `new WebSocket('/ws?w=worker')` against `base.href` (`http:`) and passing the result to `canonicalWebSocketURL` threw an Error because the `http:` scheme was rejected. The page side maps `base.href.replace(/^http/,'ws')` to a `ws:` base first.
- **Fix:** Apply the same order in workers: map the `http`/`https` base to `ws`/`wss` before resolving and validating.
- **Rule:** WebSocket (`ws`/`wss`) canonicalization functions require a **scheme-mapped base**; callers own that mapping.

<a id="srcset-comma-and-numeric-entity-caused-56-image-400s-2026-08-24-cnn"></a>
## `srcset` commas and numeric entities corrupted image requests (2026-08-24, CNN)

- **Cause:** Rust `split_srcset_candidates` and JS `splitSrcsetCandidates` truncated URLs at the first comma, corrupting CNN's `?c=16x9&q=h_1080,w_1920,c_fill`. Separately, the manual table in `decode_url_html_entities` failed to decode `&#x3D;`, encoding `&` while leaving `#x3D;original` as a fragment.
- **Fix:** A candidate URL is a non-whitespace run up to whitespace, with only trailing commas acting as separators. Removed the `data:` special case in both implementations and applied the general rule. Added `numeric_entity_char` to decode decimal and hex numeric entities (`&#61;`, `&#x3D;`, `&#X3D;`) while preserving malformed sequences like `&#zz;`. **This correction supersedes the August 21 `data:`-only workaround.**
- **Verification and residual state at the time:** Added measured `srcset` parity cases; JS and Rust mutations passed. Image 400s on `media.cnn` disappeared, though other 400s remained. Missing ad frames, blocked sandbox scripts, `__zp_get(...).turner_getGuid is not a function`, and `NotSupportedError: Blocked by ZeroProxy rewrite policy` remained uninvestigated at the time.

<a id="cnn-real-parent-2026-08-24"></a>
## Root cause of CNN freeze: cross-window `parent` returned itself (2026-08-24)

- **Cause and correction:** `top`/`parent` on the `safeCrossWindow` proxy returned the proxy itself. At depth 2 or deeper, the parent proxy differed from `window.top`, causing CMP ancestor traversal loops to spin forever. **The earlier "frame-chain hypothesis refuted" conclusion based on shallow fixture convergence was wrong.**
- **Fix:** `climbCrossWindow(targetWindow, prop, fallback)` climbs one step up the real window chain. A cache keyed by the real window preserves `window.top` object identity. If reading fails or returns the window itself, it terminates the chain.
- **Evidence and status:** With DOM counters quiet, an unending `v8.run` in CDP Tracing and temporary `__ZP_EXEC_INLINE_SCRIPT` logs pinpointed a PubMatic inline script. A separate-thread CPU sampler showing `runtime-prelude.js` / `get top` and decompiled CMP ancestor loops confirmed the cause. Verified CNN survival after the fix and caught 3/4 mutations in a 3-level window CMP guard (the remaining one was benign due to caching). **Missing frames remained unresolved**, and the nested fixture created only one level despite the requested depth.

<a id="val-failure-navigatoruseragentdata-2026-08-24"></a>
## Value comparison on object getters broke installation verification: UAData (2026-08-24)

- **Cause:** `defineOnProto` verified installation via `instance[key] === get.call(instance)`, invoking the getter before `let cachedUADataBrands` was initialized. Moving the declaration fixed the TDZ, but because `virtualUserAgentData` returns a fresh object on every call, the equality check still failed and fell back to defining an own property on the `navigator` instance.
- **Fix and rejected idea:** Verify prototype accessor installation and absence of own shadowing via property descriptors without executing the getter. Virtual `UAData` inherits from the real `NavigatorUAData.prototype` with value accessors on an intermediate prototype. Direct instance assignment conflicts with read-only accessors and alters the own-property surface. **A proposal to pin `UAData` object identity was rejected because consecutive reads return `false` in a direct browser too.**
- **Evidence and status:** `debugger-arm --strategy exceptions` caught the engine TDZ in `runtime-prelude.js` (unobservable via page `Error` wrapping). After the fix, own properties, brands, and prototypes matched the control group. This was not the cause of the CNN freeze; the incomplete PubMatic investigation and the claim refuting the frame-chain hypothesis were corrected in the entry above. Removed temporary inline instrumentation.

<a id="real-2026-08-24"></a>
## Fake surface and method identity on filtered collections (2026-08-24)

- **Cause:** Applying the same fake method surface across all six filtered collection call sites caused `'forEach' in c` to contradict actual property access. Direct measurement shows only `NodeList` has `forEach`/`values`/`keys`/`entries`, while `HTMLCollection` and `NamedNodeMap` do not. All three use `Array.prototype.values` as their iterator, and `NodeList` methods are the `Array` methods themselves, operating without brand checks.
- **Fix:** Expose only the real surface via `prop in raw` and return the `Array` methods directly for iteration, preserving filter traps, live updates, and method identity. Removed snapshot loops, cached `item`/`getNamedItem` and fallback binds per instance, and used a real `NodeList` from native `qSA` on a detached element for empty results. Deleted the dead `inRaw` gate that never fired because all three collections have iterators.
- **Evidence and residual state:** Zero detections across 7 sites at the time; 8/8 mutations caught. Closed the guard gap on fallback bind identity. Named-getter bypass for hidden nodes was **not reproduced and left unfixed**: `clearBootConfig()` in `runtime-prelude.js` removes `__zp-boot`, and no other hidden nodes had `id` or `name`. A latent bypass condition remains if hidden nodes ever acquire `id` or `name` in the future.

<a id="quadratic-filtered-collection-froze-cnn-renderer-2026-08-24"></a>
## $O(N^2)$ filtered collections: first CNN defect (2026-08-24)

- **Cause:** `nth` and `length` on `filteredCollection` scanned the entire collection on every call, and iteration invoked both repeatedly. GPT `pubads_impl.js`, `Proxy`, `qSA` filters, `isZPAssetNode`, and script `getAttribute` calls exploded. The multi-frame boot-cost hypothesis was refuted by a synthetic fixture.
- **Fix and verification conditions:** Memoized filtered results and invalidated on raw length changes. Mutation testing confirmed memoization accounted for the speedup, whereas loop rewriting was redundant (removed in the subsequent collection fix). Because reusing a wedged daemon distorted initial freeze timing, probes required `taskweaver kill/start`. Starting a fresh daemon alone still left stale SW caches, requiring `clear-site-data` and **running build ID verification**.
- **Evidence and correction:** Document-start main-world counters and CDP console stacks confirmed the call explosion and its sharp drop after the fix. However, CNN still froze, so **interpreting this fix alone as a complete resolution was wrong**. The second cause, which barely touches the DOM, was identified in the cross-window chain entry above.
- **Separate unverified observation:** `/zp/error/POLICY_BLOCKED…` appeared in `document.scripts` on Reddit. `blockExecutableURL` cleared `urlMeta` and left `data-zp-target-url` empty, leaving no basis to restore `.src`, and `deproxyURL` did not map the error path. Recorded only as a potentially pre-existing issue without comparing against older builds.

<a id="cause-2026-08-24"></a>
<a id="apparent-race"></a>
## Document compression record eviction: shared FIFO capacity, not a race (2026-08-24)

- **Removed 2026-10-23 (339bb32):** the whole encoded-size relay is gone (the kernel's `X-ZP-Encoded-Size` and `X-ZP-Stream-Id`, the Service Worker's response wrapping and size maps, the page's size store and document size query), with the timing-value overrides that read it. It served only `encodedBodySize`/`transferSize` fidelity; no page was recorded to break, and every proxied response used to pass through an extra wrapper and a `postMessage`. Kept as history; see `prune-fidelity-2026-10-23`.
- **Cause and rejected hypotheses:** Missing compressed size display on MDN cold loads happened because beacons filled the bounded FIFO shared between documents and subresources, evicting the document record. On warm boots, the query beat eviction. Uncontrolled-SW and instance-replacement hypotheses were refuted by observation, and initial probes that inspected only the first few keys missed the full picture.
- **Fix and prohibition:** Store document records in a separate `docEncodedByUrl` map and query it first. Pass `isNavigationRequest(event.request)` on both buffered and streaming paths. Removed `encodedKeys: [...streamEncodedByUrl.keys()]` from diagnostic `__zpTraceDump` and added a guard against its return because it **exposed other tabs' target URLs (A2 multi-tab leak)**. Querying one's own already-known URL differs in security impact from dumping all keys.
- **Verification at the time:** Cold load display recovered after the fix. Isolated-world values remained unchanged, confirming that only the page-realm view was masked without altering the browser's actual measurement.

<a id="serializer-walks-where-scrubber-cannot-2026-08-24-reddit"></a>
<a id="template"></a>
## Serialization scrubber missed `<template>` contents (2026-08-24, Reddit)

- **Cause:** Parallel `qSA` traversal in `scrubbedClone` does not reach `template.content` (a separate `DocumentFragment`), whereas the serializer outputs its contents. This is the same observation mismatch as the earlier bug where membrane `qSA` hid internal assets from the scrubber.
- **Fix and invariant:** Capture `Native.fragmentQuerySelectorAll` and `Native.templateContent`, and branch on `nodeType === 11`. Misusing `Element`/`Document` methods throws and skips scrubbing inside `catch`, and the scrubber must not rely on page-mutable `el.content`. Handle nested template recursion (capped at depth 8 at the time) and the case where a `<template>` itself is the serialization root. **The scrubbed node set must match the node set visited by the serializer, without mutating the live DOM.**
- **Evidence and residual state:** Real internal attributes and URLs remained intact in the isolated world while disappearing from main-world serialization with structure preserved. Zero detections on Reddit and comparison sites; `static-policy` and new guard mutations passed. Declarative shadow roots were not observed on Reddit and remained **unverified**.

<a id="2026-08-22-fingerprint-axis-global-scrubber-missed-24-names-via-rewritten-access"></a>
## Global scrubber failed to recognize the virtual `window` (2026-08-22)

- **Cause:** Actual detection runs in `test/browser/fingerprint/detect.js` exposed globals, even though direct `exec-js` probes looked clean. In rewritten `eval`, `window` is a scope proxy, whereas `isGlobalObj` only checked identity against raw `globalThis`/`root`/`self`. The "Measured … correctly clean" comment reflected a measurement taken when target code was not looking through the proxy.
- **Fix:** Use the same `o.window === o` check as the membrane so subsequently created scope proxies are also recognized. Verified zero global leaks through both direct and rewritten access and corrected the stale comment. `navigator`, `Location.prototype`, and window symbols matched at both points and were outside the scope of this defect.
- **Status at the time:** `static-policy`, the hole matrix, and the bounded real-site axis passed. Internal attributes and injected assets in `outerHTML`, as well as resource-timing asset names, remained open. A `null` path of the form `http://127.0.0.1:18099/null/zp/api/fetch?url=…` was noted as a separate suspected bug without resolution evidence in this entry.

### Follow-up: Serialization stripped the `<html>` wrapper

- **Cause and fix:** Round-tripping the string through `div.innerHTML` caused the HTML parser to strip `<html>`/`<head>`/`<body>`. Switched to scrubbing internal attributes on a `cloneNode(true)` copy and serializing via the native getter, preserving document structure.
- **Evidence and gap at the time:** The `<html` prefix of `documentElement.outerHTML` matched the control group. Remaining `data-zp-target-url` occurrences were inside escaped `<iframe srcdoc="…">` markup rather than live element attributes. A missing hook on `new XMLSerializer().serializeToString(document.documentElement)` was also recorded as a separate exposure surface. That was a **gap at the time** and does not assert current unimplemented status here.

<a id="2026-08-22-storage-cookie-isolation-axis-two-bugs-and-one-false-leak"></a>
## Storage and cookie isolation: two defects and one false leak verdict (2026-08-22)

- **Instrumentation correction:** In the A-to-B-to-A check under `test/browser/storage-matrix/`, cookie sharing across different ports on `127.0.0.1` is standard browser behavior. Even after splitting into `localhost` and `127.0.0.1`, stale fixture cookies remained in SW storage and produced false leaks. Verdicts must be taken against a control group after `clear-site-data` and a hard reload.
- **Defects and fixes:** `boot.tabId` in the `sessionStorage` prefix changed on every navigation, losing persistence when returning within the same tab. Switched to a session ID stored once in native `sessionStorage` while keeping target isolation keyed by `originHash`. Diagnostic keys `__zp_hb` and `__zp_trace_log` appeared in both native and target-prefixed copies due to child-realm capture ordering. Hid `__zp_` names from facade `length`, `key()`, `getItem`, and enumeration.
- **Verification at the time:** Isolation, persistence, and internal-key hygiene passed across `localStorage`, named property access, `sessionStorage`, `cookie`, `CacheStorage`, and `IndexedDB`. Because that alone did not prove live channel isolation, the concurrent liveness test below was run separately.

### Follow-up: `BroadcastChannel`, `SharedWorker`, and frame misidentification

- **Cause and rule:** Sequential `run.mjs` cannot measure non-persistent channels, so `crossdoc.mjs` launched same-target and cross-target frames concurrently. Assuming `--frame 1` was target B failed because `/page` already contained an existing iframe.
- **Fix and evidence:** Use a minimal `/hdrprobe` page, verify identity via `document.baseURI` before installing receivers, and abort as inconclusive if not found. Never treat a cross-target `0` as proof of isolation without a positive control showing same-target reception. At the time, `BroadcastChannel` received only from the same target, and `SharedWorker` shared instances within the same target while isolating across different targets.

<a id="2026-08-21-reproducibility-axis-needed-deliberate-classification"></a>
## Added expected-blocked classification to the reproducibility axis (2026-08-21)

- **Cause:** The runner merely printed 7 permanently failing cells without distinguishing them from new regressions. Unlike the isolation axis in `url_surfaces.json`, reproducibility lacked declared intent and rationale. Two worker cases were intentional restrictions where the `URL.createObjectURL` hook replaced JS Blobs with a blocking stub: **unrewritten code must never execute in a worker outside the membrane.**
- **Fix:** Declare ID-to-reason mappings in `EXPECT_BLOCKED` in `server.mjs` and expose them via `/cases`. Undeclared failures fail as regressions, while declared passes fail as stale declarations (bidirectional check). `static-policy` enforced non-trivial reason strings. Declarations from that time are not treated as the current approved blocklist.
- **Verification and rejected test:** Caught mutations removing the `c7-worker` declaration, falsely declaring passing `a10-static-iframe`, and shortening reason strings. An initial mutation against non-existent `a1-static-img` was invalid. Because prior guards had pinned implementation details (`srcset` `split(',')`, pre-normalization expected values, `usesRaw` ternaries, `encodeURIComponent` regexes), we also checked for staleness of the expected set itself.

<a id="2026-08-21-preconnect-cause-not"></a>
## `preconnect` instrumentation: socket reuse and early-close omission (2026-08-21)

- **Cause:** Sharing an origin with `prefetch`/`preload` caused `preconnect` sockets to be reused, and rapid `close` events on unused sockets canceled the counting timer. The initial interpretation blaming the browser environment alone was wrong.
- **Fix:** Use a dedicated origin for `preconnect` and count each socket once on whichever fires first: timeout or early close. Report `unused/total` together; if control `total` is 0, the hint did not fire (**inconclusive**), and if `total > 0` with `unused == 0`, suspect the instrumentation.
- **Verification and correction at the time:** Consecutive runs confirmed positive controls and 0 target sockets under the proxy, supplementing the earlier instability note below. **`dns-prefetch` remained unmeasured**: it opens no sockets, and numeric IPs perform no DNS lookup.

<a id="2026-08-21-sri-meta-csp-page-realm"></a>
## Missing server-side SRI stripping and missing page-realm meta CSP filtering (2026-08-21)

- **SRI cause and fix:** Rewritten response bodies no longer match original `integrity` hashes, causing the browser to block execution. Because static parser fetches start before the prelude sweep, `htmltx` had to strip `integrity` from `script` and `link` elements and stash it in a shared `data-zp-integrity` attribute. Verified execution recovery and original read-back via attr/prop/`hasAttribute` on `/sripage`.
- **Meta CSP cause and fix:** Dynamically inserted `<meta>` CSP tags took effect and could block runtime scripts or relays. Because multiple CSP policies intersect, this was not a policy-relaxation escape, and Chrome ignores `report-uri` in `<meta>`, so no target hits occurred. Neutralized dynamic tags in the prelude using `data-zp-blocked-http-equiv` across all three paths: `setAttribute`, `HTMLMetaElement.httpEquiv`, and `transformHTML`. **Property assignment bypasses the `setAttribute` hook, and our own policy `<meta>` must be preserved.**
- **Verification at the time:** Target CSP injections were neutralized while our policy remained active and image loading recovered. The hole matrix, new `static-policy` guard mutations, full `cargo` (including `zp-htmltx`), `go test ./...`, and the bounded real-site axis all passed. Because each implementation lacked what the other had, one-way checks were insufficient.

<a id="2026-08-21-link-rel-server-missing"></a>
## Missing `<base href>` tracking and non-defect verdict on server `link rel` (2026-08-21)

- **`base` defect and fix:** `htmltx` always resolved relative URLs against the document URL, picking the wrong origin or path when `<base href>` was present (no leak occurred because requests still went through the proxy). Updated the streaming base in `Rc<RefCell<String>>` upon encountering `<base href>` and applied it to subsequent parsed elements. Left the `<base>` attribute itself unrewritten so `updateVirtualBase` reads the original value. Verified request parity against the control group and unit tests at the time.
- **`link rel` correction:** The absence of a page-realm-style `rel` stripping branch on the server was **not a leak defect**. Rewriting `("link","href")` in `htmltx` routed static `prefetch`/`preload`/`modulepreload` through the proxy. The asymmetry where static links work while runtime-created links are swallowed was left unchanged at the time.
- **Instrumentation and follow-up:** `preconnect` and `dns-prefetch` cannot be judged on the HTTP byte axis, and raw connection counts mixed in proxy server dials. Initial instability in unused-socket instrumentation was diagnosed and fixed in the follow-up above, while DNS remained unmeasured. Verified in build artifacts that `importScripts('/zp/assets/worker-prelude.js?v=__ZP_BUILD_ID__')` in the worker bootstrap was already substituted properly. SRI and meta CSP, unmeasured at the time, were investigated in the separate entry above.
- **Verification at the time:** Hole matrix, `static-policy`, full `cargo`, `go test ./...`, and the bounded axis on NAVER/Wikipedia/GitHub passed.

<a id="2026-08-21-url-four-builders-swallowed-fragments-leaving-svg-use-blank"></a>
## Proxy URL builder mismatch swallowed SVG fragments (2026-08-21)

- **Cause:** Among the four URL builders, only `htmltx` preserved `#fragment` outside `?url=`. When CSS or the prelude encoded `#i` as `%23i` inside the query parameter, the browser could not select the SVG symbol, leaving `<use>` blank. Differences in space and punctuation encoding were absorbed by SW `URLSearchParams` without visible failures, but risked cache-key and downstream decoder mismatches.
- **Fix and evidence:** Unified `htmltx` and `zp-css` on a single builder in `crates/zp-shared/src/proxyurl.rs` and aligned JS on the same `encodeURLParam` and fragment-splitting rules. Verified via byte parity against `proxy_url_cases.json`, mutations on both sides, and rendered SVG bounding boxes.
- **Separate instrumentation defects:** `a20-static-use` and `g7-realm-use` failed even in the control group due to cross-origin external `<use>` restrictions and a broken PNG response from the test server. Replaced them with same-origin valid SVGs. The navigation runner also read stale IDs due to a race between prior proxy navigations, `/reset`, and the next control run; navigating to `about:blank` first restored positive controls.
- **Status at the time:** Zero leak or reproducibility regressions on the measured axes of the hole and navigation matrices; `static-policy`, full `cargo`, `go test ./...`, and the bounded real-site axis passed. Zeros from broken control cases are excluded from this verification.

<a id="2026-08-21-resolve_against_base-did-not-fold-dot-segments-audit-severity-overstated"></a>
## Unnormalized dot segments: actual impact was consistency (2026-08-21)

- **Cause and severity correction:** Only `resolve_against_base` in `htmltx` concatenated strings and left `.`/`..` intact. However, SW `canonicalTargetURL` normalized URLs before upstream transmission, so the 404 predicted by the audit never occurred. The real impact was consistency of `?url=` strings, cache keys, `alreadyMapped`, and context keys between the server and the page realm.
- **Fix:** Applied RFC 3986 section 5.2.4 `normalize_dot_segments` at both path-construction sites while preserving query and fragment. Fixed the expected value in `relative_subresource_resolved_against_target`, which had pinned the unnormalized `%2F.%2F` output as expected.
- **Verification and residual state at the time:** Unit tests, full `cargo`, `static-policy`, and matrices showed no regressions, and browser checks confirmed byte parity with page-realm values. A one-off Wikipedia error did not reproduce; whether it was related to the existing l10n 404 remained **unverified**.

<a id="2026-08-21-srcset-four-parsers-three-used-split-and-two-hooks-missed-srcset"></a>
## Duplicate `srcset` parsers and missing attribute hooks (2026-08-21)

- **Cause:** `setAttribute('srcset', …)` treated the entire candidate list as a single URL, and `img.srcset` property assignment bypassed rewriting altogether, leaving raw URLs (`csp-only`). HTML injection and sweeps used `split(',')`, splitting `data:` URLs at internal commas. A comment claiming `split(',')` was safe because proxy URLs contain no commas ignored **pre-rewrite inputs**.
- **Fix:** Consolidated parsing into Rust `split_srcset_candidates` and JS `splitSrcsetCandidates`, preserving descriptors via `lead + url + tail` reconstruction. Unified `enforceSrcsetAttribute`, `upgradeSWLessSrcset`, and `applySWLessRelay`, and added hooks for `setAttribute` plus the `img.srcset`, `source.srcset`, and `link.imageSrcset` properties. Keyed the getter stash by **(element, attribute)** so `srcset` does not overwrite `src`.
- **Evidence and later correction:** Measured actual attributes from the isolated world. Shared `crates/zp-shared/testdata/srcset_cases.json` between Rust and `static-policy.test.js`; mutations, hole matrix cases `g9` through `g12`, and the full suite passed. Replaced source-pinning guards that required literal `String(raw).split(',')` and `indexOf(ZP.apiPath('fetch')) >= 0) return part` with behavioral checks. **At the time, the `data:`-exception parser still broke on commas inside regular query strings, which was fixed on August 24 using the whitespace-run and trailing-comma rule.**

<a id="2026-07-30-shorthand-object-prop-keyless-collapsed-whole-file-syntaxerror"></a>
## 2026-07-30: Shorthand property collapse caused whole-file `SyntaxError`

- **Cause:** Shorthand identifiers in `{ window, document, navigator }` share a single AST span for both key and value. The general reference visitor replaced the span with `__zp_get(...)`, producing a keyless property `{ __zp_get(...) }` and causing all of NAVER `ntm_*.js` to fail parsing and lose unrelated symbols.
- **Fix and invariant:** `visit_object_property` in [zp-rewriter/src/lib.rs](../../crates/zp-rewriter/src/lib.rs) emits `SHORTHAND_GLOBAL_GET` for dangerous-global shorthands and stops visiting the value. `apply_patches` expands it to `window:__zp_get(globalThis,"window")`. Always check the syntactic role of shared spans and re-parse rewritten output.
- **Verification at the time:** V8 parsing passed on `ntm_ec8638b0efc1.js` and `ntm_d2d2463c73f0.js`, the NAVER search `SyntaxError` disappeared, Wikipedia showed no regressions, and Rust/JS tests passed. Verified that shadowed shorthands and method/getter keys remain untouched and that computed keys, explicit properties, spreads, class fields, and arrow-returned objects emit valid JS.
- **Separate open item and security prohibition:** At the time, assignment targets like `({ location } = obj)` used a different AST node (`AssignmentTargetPropertyIdentifier`) and emitted broken syntax. The later [September 6 write-reference fix](#ci-write-reference) addressed this, so do not read that historical gap as currently unimplemented. Leaving global `location` writes unrewritten is forbidden because it permits navigation escapes, and `LegacyUnforgeable` prevents blocking it via property redefinition. Exposing the scope `Proxy` directly or rewriting whole assignments with `__zp_set` + temporaries were separate design questions involving evaluation order and multi-property destructuring.
- **Build trap:** `npm run build:web` does not rebuild WASM. Verifying Rust changes required `npm run build` after stopping the running server to release the executable lock.

<a id="2026-06-07-split-bundle-c1-step-21-shadow-compare-found-modern-rewriter-two-regressions-patch-mode-marker-resolution-missing-function-global-unprotected"></a>
## 2026-06-07: Split-bundle shadow-compare: marker and `Function` regressions

- **Patch-mode cause and proposal at the time:** On `ndp-loader.js`, [Rust `rewrite_script_patches`](../../crates/zp-rewriter/src/lib.rs) returned raw `GLOBAL_GET`/`MEMBER_GET`/`MEMBER_SET`/`METHOD_CALL` markers, while [SW `applyScriptPatches`](../../web/sw.js) performed a plain string splice, producing a `SyntaxError`. This fallback defect had lain dormant behind the legacy primary rewriter. Proposals included resolving final replacements in Rust, porting the JS resolver, or using full re-emit only; this entry records no completed fix or re-comparison run.
- **`Function` cause and security rule:** Comparing `cross-domain-storage-remote-3.0.0.js` showed the modern rewriter left `Function.prototype` untouched. `Function` was missing from [modern `DANGEROUS_GLOBALS`](../../crates/zp-rewriter/src/lib.rs#L86) though present in [legacy](../../rewriter-rs/src/lib.rs). Accessing `eval`-equivalent constructors via `Function.prototype.constructor` bypasses the membrane and is forbidden. Adding `Function`, regression tests, and auditing `eval` sibling paths were proposed at the time without completion evidence here.
- **Comparison evidence and status:** Using `shadowCompareRewriters`/`recordShadowDivergence`, a circular buffer, and `/zp/api/__shadow_log` in [web/sw.js](../../web/sw.js), observed two divergences on NAVER and zero on Wikipedia. Fixed a closure bug that read mutated `code` in a microtask and reported false pragma diffs by snapshotting `const legacyForShadow = code`.
- **Separate build bug:** `npm run build -- --skip-rust` wiped `dist/web`, deleting the WASM output directory `dist/web/__zp/` and causing 503s during SW registration. Updated `cleanSelectedOutputs`/`rmWebPreserveZp` in `scripts/build.mjs` to preserve `dist/web/__zp/` when skipping Rust. Resolving divergences before swapping the primary rewriter was the strategy at that time, not a current task list.

---

<a id="2026-06-07-split-bundle-c1-step-2a-sw-swap-naver-renderer-wedge-zprewriterrewritescript-legacy-primary-path-zpbundle-modern-oxc-0133-when-replaced-naver-main-hydration-stage-webview2-renderer-full-wedge-revert-step-2-strategy-redesign"></a>
## 2026-06-07: NAVER renderer wedge after SW modern swap; reverted

- **Observation and unknown cause:** Swapping the legacy primary in [web/sw.js](../../web/sw.js) to modern `ZPBundle` left only the search box on NAVER main and wedged the WebView2 renderer. Captured upstream 404 HTML in place of `ndp-loader.js` via `/zp/api/__debug_ndp`. Although the strict parser rejects HTML, the exact runtime path that let raw HTML through as script code remained undetermined, and stale SW activation prevented capturing a fresh trace.
- **Hypothesis and action:** The chain from cold `await initBundle()` latency to anti-bot/CDN 404s to ad/SafeFrame/`postMessage`/hydration timing collapse was a **hypothesis at the time, not a confirmed root cause**. Reverted the primary swap completely. Because subsequent shadow-compare found missing marker resolution and the unprotected `Function` global, timing alone does not explain the failure, though the exact causal chain of the wedge was not proven either.
- **Preserved evidence and verification limits:** Added `html_body_must_parse_error_under_strict_mode` and `naver_ndp_loader_round_trips_as_valid_js` in [crates/zp-rewriter/src/lib.rs](../../crates/zp-rewriter/src/lib.rs) and saved [ndp-loader-fixture.js](../../crates/zp-rewriter/src/ndp-loader-fixture.js). `cargo` tests for HTML rejection and output equivalence/re-parsing do not substitute for real SW lifecycle and renderer verification.
- **Strategy and gaps at the time:** Proposed an SW boot warm-up/ready gate, legacy fallback, and shadow-compare before swapping. In the page realm, reliance on `root.ZPRewriter` without `ZPBundle` loaded was a historical gap requiring classic-script glue and synchronous WASM boot. While symptoms resembled the 2026-06-06 iframe rewrite wedge, a shared root cause was not established.

---

<a id="2026-06-06-anchorformformaction-raw-target-url-escape-vector-middle-click-ctrlclick-target_blank-right-click-open-in-new-tab-copy-link-address-ip-leak-zp-htmltx-navigation-url-attribute-rewrite-added-proxy-origin-via-data-zp-target-url"></a>
## 2026-06-06: Navigation raw URL escape and missing hydration hooks

- **Cause and security prohibition:** [zp-htmltx](../../crates/zp-htmltx/src/lib.rs) rewrote only subresources and relied on [click interception](../../web/runtime-prelude.js#L1699) for anchors and forms. While plain left-clicks stayed inside the proxy, middle/Ctrl-click, `target=_blank`, and right-click "Open in new tab" connected directly to the raw target URL (leaking the client IP), and hover/copy exposed the raw address. **Never assume native attribute surfaces are safe based on event interception alone.**
- **SSR fix and rules:** Added `proxied_navigation_url` to rewrite raw attributes on `a/area[href]`, `form[action]`, and `input/button[formaction]` to proxy-origin `?via=<encoded target>` while stashing the original absolute URL in `data-zp-target-url`. [clickNavigationTarget](../../web/runtime-prelude.js#L1786) uses the [metadata fast path](../../web/runtime-prelude.js#L1795). Fragment-only URLs are left intact, and an empty `proxy_origin` skips rewriting for host-test compatibility. Excluded `iframe`/`frame` to avoid colliding with the child-realm pipeline ([SafeFrame notes](#2026-05-30)).
- **Ruled-out misdiagnoses and verification at the time:** The proxy URL bar, [virtualized `document.URL`](../../web/runtime-prelude.js#L1975), and the [SW controller facade](../../web/runtime-prelude.js#L3118) were not leak sources. NAVER 404s on proxy diagnostic URLs were an expected result of [target-relative routing](../../web/runtime-prelude.js#L1159). Navigation unit tests in Rust, the workspace suite, and JS `static-policy` passed.
- **Follow-up correction (launcher):** Initially, opening a new tab stayed on the launcher home screen because no `?via=` handler existed, which was **completed in a separate commit** (hash unrecorded). [`handleVia` in `web/index.html`](../../web/index.html) calls `registerShare` followed by `location.replace(sharePath + fragment)`, verified at the time via taskweaver reaching the encrypted share URL. Do not read the initial gap as currently unimplemented.
- **Follow-up correction (hydration):** SSR rewriting alone was insufficient because NAVER and GitHub hydration overwrote anchors with raw URLs via the `href` setter and `setAttribute`. Hooked the [URL property setter](../../web/runtime-prelude.js#L1985), [setAttribute](../../web/runtime-prelude.js#L2556), and [setAttributeNS](../../web/runtime-prelude.js#L2602) to rewrite via `proxyViaURL(t)` while stashing the absolute target in `urlMeta`/metadata. The JS helper passes fragments, inert schemes, and non-HTTP(S) URLs through; minor percent-encoding byte differences from Rust did not affect launcher decoding.
- **Backstop and separate wedge:** [Navigation backstop helpers](../../web/runtime-prelude.js) added initial/deferred scans and child-realm installation, restoring closure-private `urlMeta` even if page scripts stripped attribute metadata ([NAVER fingerprint hide](real-site-compat.md)). An initial `MutationObserver` draft wedged the renderer during NAVER hydration and was removed; an infinite microtask loop from attribute re-mutation was the working hypothesis, replaced by two scans (install and idle).
- **Final root-cause correction:** Residual raw anchors persisted even after the two scans. Instead of guessing about cloning or late insertion, inspection showed that a hidden autocomplete widget in the main document mounted via `innerHTML`, and the JS walker in [page-side `transformHTML`](../../web/runtime-prelude.js#L3006) lacked a navigation branch (it does not call the same-named server-side WASM transform). Added `applyNavigationBackstop(node)` after `enforceLinkPolicy(node)` in the walker, covering HTML setters, `insertAdjacentHTML`, `document.write`, `Range`, and `DOMParser` paths together.
- **Final verification and limits at the time:** Raw external anchors on NAVER dropped to **0**. Earlier statements claiming the primary setter fix or backstop scans alone eliminated raw anchors are superseded by this walker fix. `static-policy` tests pinning the Rust transform, prelude setter/attribute/walker, and launcher passed. This reflects the NAVER observation at that time and does not prove universal resolution across all sites or separate GitHub hydration issues. [Follow-up reference](#2026-06-06--anchorformformaction-raw-target-url-escape-vector), `PHASE3_PLAN` line 129, and the escape-matrix proposal in `.ai/PHASE2_STATUS.md` are historical references.

### Separate historical regression: applying `?via=` to `iframe`/`frame` and reverting

- **Observation and hypothesis:** Including `iframe`/`frame` in the navigation rewrite branch passed Rust, `static-policy`, and build checks, but caused NAVER main content to disappear. The working hypothesis at the time was that asynchronous launcher-to-share-encrypt-to-nested-SW navigation across multiple iframes broke SDK assumptions about synchronous `contentWindow` readiness.
- **Action and rule:** Reverted the branch, added tests, and policy changes, keeping the [`iframe_src_still_left_alone` guard](../../crates/zp-htmltx/src/lib.rs). Do not apply the user-click launcher model directly to page-load iframes. Server-side share encryption (AES-256-CBC + HMAC-SHA256) or setting the share URL after an initial `about:blank` (`activatedFrameURL` style) were recorded as alternatives at the time, not approved implementations.
- **Verification limit:** Slow cold loads after the revert prevented completing final visual confirmation of NAVER rendering in that session.

---

<a id="2026-05-31-lol_html-attrvalue-html-entity-undecoded-wikipedia-stylesheet-url-broken"></a>
## 2026-05-31: Undecoded `lol_html` entities broke Wikipedia CSS URLs

- **Cause:** `Attribute::value()` in `lol_html` v2 returns the raw attribute value without decoding character references. Percent-encoding `&amp;modules=` verbatim caused the upstream server to misparse the query key, returning an empty stylesheet and breaking the Vector skin. Whether this surfaced due to entering the production path newly or a v1-to-v2 behavior change was an estimate at the time.
- **Fix and rule:** Applied [`decode_url_html_entities`](../../crates/zp-htmltx/src/lib.rs#L441-L490) [before URL attribute processing](../../crates/zp-htmltx/src/lib.rs#L106-L114) so both scheme checks and URL wrapping see the decoded value. The helper is a bounded decoder covering common named and numeric entities with a fast path when `&` is absent, preserving unknown sequences. Never assume a tokenizer attribute getter decodes HTML entities.
- **Evidence and open items at the time:** [`stylesheet_link_with_html_entity_decoded`](../../crates/zp-htmltx/src/lib.rs#L719-L737) and `cargo` tests passed, Wikipedia Vector skin rendering recovered, and NAVER ads showed no regressions. The error screen and raw React payload on the GitHub homepage remained a **separate unresolved issue**, with hydration, membrane, or module-loading causes noted only as hypotheses.

---

<a id="2026-05-31--gfp-naver-non-safeframe-ad-installsafeframeresizeshim"></a>
## 2026-05-31: Height shim for GFP non-SafeFrame ads

- **Final root-cause correction:** NAVER GFP ad content rendered inside the iframe, but its height stayed at 0. Deeper than the earlier V8 incumbent-realm / `e.source` gate hypothesis, **the `sf-resized` sender itself was never loaded on the `forceSafeFrame=false` branch**: `gfp-bridge.js` handles tracking only, whereas the resize sender lives exclusively in the SafeFrame container. Having the host listener and `sf-init` frame name in place does not complete the resize protocol on its own.
- **Fix and rule:** [`installSafeFrameResizeShim`](../../web/runtime-prelude.js#L2840-L2900) targets only `sf-init` frames and prevents duplicate installation via a [Symbol marker](../../web/runtime-prelude.js#L72). It polls and listens for image `load` events, applying the maximum `scrollHeight`/`offsetHeight` of `body` and `documentElement` directly while deduplicating identical heights. Because an initial draft using only a cross-realm `ResizeObserver` got stuck at the pre-image-load height, polling was added.
- **Evidence and open items at the time:** After applying the [implementation and `instrumentIframe` call](../../web/runtime-prelude.js#L2839-L2900), verified non-zero heights and screenshot visibility across three target ads on NAVER without regressing non-target ads. Why the fluid/non-SafeFrame combination was selected under the proxy unlike direct NAVER remained **unresolved**. Trade-offs included continuous polling overhead and picking a height larger than `body` due to `documentElement`/margins; stopping polling after stabilization was only a proposal at the time.

---

<a id="2026-05-31-v8-incumbent-realm-leak-postmessage-source-corruption-sender-queue-parent-facade-fix-partial"></a>
## 2026-05-31: `postMessage` source corruption: sender queue and parent facade (partial)

- **Cause:** NAVER GFP SafeFrame content was injected, but its height remained 0. When a child called `parent.postMessage` through a parent-realm wrapper, `e.source` was observed as `root` instead of the child window, causing SDK slot identification (`e.source === iframe.contentWindow`) to fail.
- **Fix:** Recorded the sender via a [sender FIFO and facade store](../../web/runtime-prelude.js#L60-L69) and [parent/top redirect](../../web/runtime-prelude.js#L2748-L2799) before invoking native root `postMessage`. Removed the queued entry on exception and consumed the queue only in the root listener to patch `e.source`. Because a `Proxy` get trap over a Chromium `Window` failed brand checks, replaced it with a null-prototype facade delegating window properties.
- **Separate defect and status:** Also fixed [membrane `get`](../../web/runtime-prelude.js#L773-L797) returning the child itself for `parent`/`top` and bypassing the facade. While source correction and dispatch were confirmed for three resize messages at the time, **zero height and invisible ads remained unresolved**. SDK registration and additional identity checks remained unverified candidates; no regressions were observed on Wikipedia, GitHub, or NAVER main content.

<a id="2026-05-30-naver-gfp-safeframe-ad-iframe-script-execution-sw-control-reset-child-realm-loader-pattern"></a>

<a id="2026-05-30-naver-gfp-safeframe-ad-iframe-script-execution-sw-control-reset-child-realm-loader-pattern"></a>
## 2026-05-30: SafeFrame document reset and child realm loader

- **Cause:** Calling `document.write` on `about:blank` reset the document and caused iframe fetches to bypass the Service Worker. SafeFrame requests reached the Go server directly (which had no `/zp/api/script` handler and returned `403`), and delegating execution to the parent inline wrapper ran code in the parent global, breaking `window.onerror` and `name.adm` inside the iframe.
- **Fix:** Execute child scripts in the child realm using `w.Function` captured before wrapping, fetch external scripts via the Service-Worker-controlled parent's native `fetch`, and pass `inIframe` through `transformHTML` for DOM insertion and `document.write`/`writeln`.
- **Status and limits:** Banner injection and visual rendering recovered without regressing Wikipedia or GitHub, though asynchronous external script loading can introduce ordering races for synchronous dependents.

<a id="2026-05-30-transformhtml-const-root-outer-root-window-tdz-shadow-silent-referenceerror-debug-logger-call-misidentified"></a>
## 2026-05-30: TDZ shadowing in `transformHTML` debug logger

- **Cause:** An inner `const root` declaration inside `transformHTML` shadowed the outer `window` alias, causing the entry logger to throw a TDZ `ReferenceError` that was silently swallowed by an empty `catch` block and misdiagnosed as `transformHTML` never being called.
- **Fix and rule:** Access debug globals through `globalThis` or an explicit unshadowed alias, and check for local redeclarations of `root`, `self`, `window`, or `document` inside helper functions.

<a id="2026-05-30--documentprototypewritewriteln-proto-level-wrap--iframe-mo--transformhtml-external-script-routing"></a>
## 2026-05-30: Document prototype wrapping, iframe observer, and script routing

- **Cause:** Wrapping only the parent `document` instance allowed child `document.write`/`writeln` calls to bypass transformation, and `transformHTML` blocked external script `src` attributes with an inline stub.
- **Fix:** Wrap `Document.prototype.write` and `writeln` per realm, attach per-document `MutationObserver` instances tracked in a `WeakSet`, route external scripts through `prepareScriptElement`, and forward browser-set request headers in `transportFetch`.

<a id="2026-05-30-decode_common_html_entities-string-literal-in-entity-data-corruption-parse_failed"></a>
## 2026-05-30: Unconditional HTML entity decoding corrupted external JS string literals

- **Cause:** Running `decode_common_html_entities` across all script sources decoded `&quot;` inside external JS string literals (such as SafeFrame escape maps), turning string contents into invalid syntax (`PARSE_FAILED`).
- **Fix:** Remove HTML entity decoding from `rewrite_script` so external scripts are parsed raw, and restrict `decodeInlineEntities` to inline HTML script paths where entity-encoded source occurs.

<a id="2026-05-30-iframe-__zp_-helper-missing-sw-rewrite-external-silent-failure"></a>
## 2026-05-30: Missing `__zp_*` helpers in `about:blank` iframes

- **Cause:** Installing `__zp_*` helpers only on the top-level root realm caused Service-Worker-rewritten external scripts inside `about:blank` iframes (which lack their own prelude tag) to fail with `ReferenceError`.
- **Fix:** Install parent-delegating `__zp_*` helpers during `installNetworkContainment` on child frames so rewritten scripts preserve membrane semantics before a full child prelude loads.

<a id="2026-05-30--contextual-paren-prefix-method_callmember_getmember_setglobal_get-emission"></a>
## 2026-05-30: Contextual parenthesis prefix in rewriter emission

- **Cause:** Emitting helper calls without a leading space or parenthesis after keywords caused `return__zp_call` token merging, whereas unconditionally wrapping helper calls in parentheses broke automatic semicolon insertion (ASI) across newlines and misparsed `new globalThis.Request` argument binding.
- **Fix:** Emit a prefix parenthesis in `apply_patches` only when the preceding byte is an identifier-continue character or when the preceding non-whitespace token is `new`.

<a id="2026-05-30--super-keyword-rewrite-skip"></a>
## 2026-05-30: Exclude `super` expressions from member and call rewriting

- **Cause:** Passing `super` as a value argument into `__zp_get`, `__zp_set`, or `__zp_call` is a JavaScript `SyntaxError` because `super` is only valid as a lexical keyword in member or constructor call position.
- **Fix:** Skip `Expression::Super` receivers in the member, assignment, and call visitors in `crates/zp-rewriter/src/lib.rs`.

<a id="2026-05-30-relative-url-subresource-resolution-proxied_subresource_url-target_url-base-use"></a>
## 2026-05-30: Resolve relative subresource URLs against the target base URL

- **Cause:** Leaving relative subresource URLs unrewritten caused the browser to resolve them against the proxy origin outside `/zp/`, bypassing the Service Worker target router.
- **Fix:** Resolve host-relative, path-relative, and query-relative URLs against `target_url` in `proxied_subresource_url` and `absolute_target_url` in `crates/zp-htmltx/src/lib.rs`.

<a id="2026-05-29-inline-script-double-rewrite-zp-htmltx-rewrite-prelude-wrap-rewrite"></a>
## 2026-05-29: Avoid double-rewriting inline scripts

- **Cause:** Rewriting inline scripts in `zp-htmltx` on the server and then rewriting the already-rewritten output a second time in the page prelude corrupted `__zp_*` helper calls and broke page hydration.
- **Fix and rule:** Wrap raw inline script source in a JSON payload in `zp-htmltx` (escaping `</` to prevent premature tag closure) so the runtime rewrites the payload once, or mark pre-rewritten large scripts with `__ZP_EXEC_INLINE_REWRITTEN` so they are never rewritten twice.

<a id="2026-05-29--rewriter-parse_failed-on-html-entity-encoded-js-react-dangerouslysetinnerhtml"></a>
## 2026-05-29: HTML-entity-encoded inline JavaScript

- **Cause:** Inline scripts containing HTML-encoded operators (`=&gt;`, `&amp;&amp;`) failed OXC parsing with `PARSE_FAILED`.
- **Fix:** Decode HTML entities only on inline script fallback paths when raw parsing fails, never unconditionally on external script files.

<a id="categories-to-record"></a>
## Recorded Categories

- Historical taxonomy covering AST visitor omissions, URL attribute/element surface gaps, `proxy_origin` propagation, `module` vs. `classic` script classification, and source-map composition regressions.

<a id="2026-08-22-fingerprint-axis-round-2-serialization-surfaces-and-blind-scrubber"></a>
## 2026-08-22: Serialization surface gaps and blind scrubber traversal

- **`srcdoc` masking:** Stash original `srcdoc` strings in `srcdocMeta` before calling `setInjectedSrcdoc` and return the original markup from `getAttribute`, the `.srcdoc` getter, and HTML serialization.
- **`XMLSerializer` and native traversal:** Hook `XMLSerializer.prototype.serializeToString` via `scrubbedClone`, and traverse clones using pre-captured native `querySelectorAll` rather than the membrane's filtered `querySelectorAll` (which hides internal proxy nodes from the scrubber itself).
- **Attribute restoration:** Restore original target URLs on cloned nodes during serialization and pass `srcset` through `deproxyURL`.

<a id="2026-08-22-integration-2"></a>
## 2026-08-22: Consolidate `deproxyURL` and internal asset lists

- **Unified deproxying:** Consolidate navigation, performance-timing, and serialization URL unwrapping into `deproxyURL(raw, { scan, fallback })` so `?url=`, `&u=`, `?via=`, and `/zp/p/` routes are decoded consistently across all readback surfaces.
- **Shared asset table:** Centralize internal asset script names in `INTERNAL_ASSET_SCRIPTS` and `isInternalPath` in `web/zp-core.js`, and remove the unused `sanitizeSerializedHTML` helper.

<a id="2026-08-22-inline"></a>
## 2026-08-22: Preserve original `<style>` and `<script>` textContent on readback

- **Style and script text masking:** Record original `<style>` text in a `WeakMap` on write and deproxy server-rewritten CSS on readback. Pass inline scripts up to 256 KB as raw source to `__ZP_EXEC_INLINE_SCRIPT` so reading `script.textContent` returns the original unrewritten source rather than the execution wrapper.

<a id="2026-08-22-own"></a>
## 2026-08-22: Deproxy cached style/srcset values on readback and narrow fingerprint assertions

- **Readback invariant:** Always run `deproxyURL(..., { scan: true })` when returning stashed `style`, `srcset`, or `script` values, because values captured during an initial DOM sweep may already contain server-rewritten proxy URLs.
- **Detector precision:** Narrow function `toString` fingerprint checks to look for internal identifiers (`__zp`, `ZeroProxy`, `/zp/`) rather than flagging third-party pages (such as GitHub) that wrap their own `window.fetch`.

<a id="2026-08-22-timing-axis-contradiction-between-reported-state-and-timing"></a>
## 2026-08-22: Resource timing consistency with virtualized Service Worker state

- **Cause:** Because `navigator.serviceWorker.controller` is virtualized as `null`, exposing positive `workerStart` timestamps or `deliveryType: 'cache'` on `PerformanceResourceTiming` entries creates a self-contradictory fingerprint.
- **Fix:** Normalize `workerStart` to `0`, report `nextHopProtocol` consistent with the target scheme, clear `deliveryType`, and populate `secureConnectionStart` on `https:` targets.

<a id="2026-08-23-sw-page-0200-198200"></a>
## 2026-08-23: Plumb upstream compressed byte counts to `encodedBodySize`

- **Removed 2026-10-23 (339bb32):** see the entry above; this plumbing no longer exists. Kept as history; see `prune-fidelity-2026-10-23`.
- **Cause:** Because the WASM transport kernel decompresses upstream responses before handing them to the Service Worker, synthetic `Response` bodies reported `encodedBodySize === decodedBodySize` (appearing uncompressed).
- **Fix:** Attach the pre-decompression byte length in `X-ZP-Encoded-Size` inside the kernel, strip the header in the Service Worker, and send the size only to the requesting client (`event.clientId`) to avoid cross-tab URL leaks.

<a id="2026-08-23-document-compression-closed-and-prior-infeasibility-diagnosis-refuted"></a>
## 2026-08-23: Streaming document `encodedBodySize` via pull lookup

- **Cause:** Streaming navigation responses send headers before the full compressed stream finishes, and `clients.get(resultingClientId)` is not yet resolvable when the stream flushes.
- **Fix:** Record `total_in` from the kernel decompression pump by stream ID in the Service Worker upon stream completion, and let the page query its own `virtualURL.href` to populate navigation `encodedBodySize`.

<a id="2026-08-23-script-src-missing"></a>
## 2026-08-23: Stash target URLs when `setScriptSource` receives pre-proxied URLs

- **Cause:** When `setScriptSource` received a URL that already started with `CONTROL_PREFIX` (`/zp/`), it passed the URL through without recording the decoded target URL in `urlMeta` or `data-zp-target-url`, causing `document.scripts[i].src` and `getAttribute('src')` to expose `/zp/api/script?u=...`.
- **Fix:** Recover the underlying target URL via `deproxyURL` and stash it in `urlMeta` and `data-zp-target-url`, and add an explicit `script:src` branch in the `getAttribute` hook.

### Stack Overflow re-verification and readback defense {#stackoverflow-recheck}

- **Readback defense:** Because write stashes only cover assignments that pass through the membrane, `.src`, `getAttribute`, and `outerHTML` also run `deproxyURL(..., { scan: true })` on un-stashed attribute values so server-rewritten tags never leak proxy URLs.

## `<base href>` navigation escape prevention (2026-08-25) {#base-href-escape}

- **Cause:** Passing root-relative proxy paths (`/zp/p/...`) to `location.assign`, `location.replace`, or `history.pushState` on a document containing a `<base href="https://target.example/">` tag caused the browser to resolve `/zp/p/...` against the external `<base>` origin, escaping the proxy on navigation.
- **Fix:** Always construct full proxy-origin absolute URLs via `proxyAbsoluteURL()` across `navigateToTarget`, `commitVirtualHistory`, `replaceVisibleProxyURL`, and form submission routes.

## `document.location` alias protection without over-wrapping frame chains (2026-08-25) {#document-location-leak}

- **Cause:** Skipping member rewrites on shadowed local variables allowed `doc.location.protocol` on a local `doc` alias to read the raw proxy `http:` protocol, while wrapping `top`/`parent`/`frames` on every local object triggered expensive brand-check exceptions in tight loops.
- **Fix:** Virtualize `document.location` across `get`, `set`, `has`, and `getOwnPropertyDescriptor`, confirm `Location` brand via pre-captured native getters cached in a `WeakSet`, and restrict local-alias wrapping to URL-bearing properties.

## <a id="postmessage-incumbent"></a>Preserving incumbent realm on cross-window `postMessage` (2026-08-25)

- **Cause:** Installing a parent-realm wrapper function as an own `postMessage` property on a child window caused calls from the child to execute with the parent as the incumbent realm, inverting `event.source` and `event.origin` on the receiving window.
- **Fix:** Leave the window's own `postMessage` property native and perform `targetOrigin` normalization inside the membrane's property-get wrapper bound to the caller's realm.

## <a id="csp-meta-body"></a>Injecting CSP `<meta>` before `<body>` on headless documents (2026-08-26)

- **Cause:** In HTML documents that omit an explicit `<head>` tag, matching only `head` or `body` placed the injected `<meta http-equiv="Content-Security-Policy">` tag inside `<body>`, where browsers ignore meta CSP directives.
- **Fix:** Anchor prelude and CSP injection on `html, head, body, script` so the HTML parser creates an implicit `<head>` and places the CSP `<meta>` inside it before `<body>` opens.

## <a id="data-zp-namespace"></a>Hiding the `data-zp-*` attribute namespace across all DOM surfaces (2026-08-26)

- **Cause:** Filtering `data-zp-*` only in `getAttribute` and `getAttributeNames` left the attributes visible via `NamedNodeMap` named access, `Attr`, `*NS` methods, and `element.dataset`, and allowed page scripts to overwrite or delete internal metadata.
- **Fix:** Enforce `isZPAttrName` across all attribute read, write, deletion, `NamedNodeMap`, `Attr`, `dataset`, and `filteredCollection` surfaces so internal `data-zp-*` attributes are invisible and immutable to page code.

## <a id="non-http-scheme-three-layers"></a>Preserving non-HTTP schemes (`blob:`, `data:`, `mailto:`) across getters, `createObjectURL`, and `fetch` (2026-08-26)

- **Cause:** Routing `blob:`, `data:`, `about:`, `mailto:`, and `tel:` URLs through HTTP-only target URL builders corrupted getter readbacks, replaced `MediaSource` object URLs with HTML error pages, and sent `blob:`/`data:` `fetch()` calls to the upstream proxy route.
- **Fix:** Pass non-HTTP(S) absolute URLs through unchanged in `nonHTTPAbsoluteURL`, delegate `blob:` and `data:` `fetch()` calls to `Native.fetch`, and enforce Worker blob rewriting at `Worker` construction time (`workerBootstrapURL`) rather than breaking `URL.createObjectURL`.

## <a id="style-raw-text-escape"></a>Emitting `<style>` rewritten text as raw HTML to preserve `>` child combinators (2026-08-26)

- **Cause:** Emitting rewritten `<style>` contents with `ContentType::Text` in `lol_html` escaped `>` child combinators into `&gt;`, which CSS parsers inside raw-text `<style>` elements do not decode, dropping CSS grid rules and breaking page layout.
- **Fix:** Emit rewritten `<style>` text with `ContentType::Html` in `crates/zp-htmltx/src/lib.rs` so CSS combinators remain unescaped while `rewrite_css` percent-encodes URLs safely.

## <a id="dual-module-urls"></a>Canonicalizing static and dynamic ES module proxy URLs (2026-09-04)

- **Cause:** Static `import` statements rewritten by Rust and dynamic `import()` calls rewritten by JS produced different query parameter orderings and `ref` parameters for the same upstream ES module, causing the browser module map to instantiate duplicate singletons (such as React).
- **Fix:** Canonicalize `/zp/api/script` module URLs identically in Rust and JS without volatile `ref` parameters so static and dynamic imports share a single module map key.

## <a id="ci-write-reference"></a>Preserving assignment targets and evaluation order in WASM rewriter (2026-09-06)

- **Cause:** Visiting static member expressions inside compound assignments and destructuring targets as ordinary reads rewrote assignment left-hand sides into `__zp_get(...)` call expressions, producing invalid JavaScript syntax (`SyntaxError`).
- **Fix:** Visit only the receiver expression in `visit_simple_assignment_target` and emit temporary-backed accessor references for sensitive assignment targets so native operators preserve evaluation order, short-circuiting, and numeric coercion.

## <a id="absent-url-attribute"></a>Returning `null` or empty string for absent or empty URL attributes before consulting the URL stash (2026-09-06)

- **Cause:** Passing a native `null` attribute value into `deproxyURL` or returning a stashed URL after `removeAttribute` caused `getAttribute('href')` on unconfigured `<link>` elements to return `""` or a stale URL instead of `null`.
- **Fix:** Read the native raw attribute first and return `null` or `""` immediately when the attribute is absent or empty before consulting `urlMeta` or `deproxyURL`.

## <a id="runtime-entrypoints"></a>Preserving `WebSocketStream` and routing `Attr` / `NamedNodeMap` mutations through URL policy (2026-09-06)

- **Cause:** `installBlockers` overwrote the working `WebSocketStream` facade with a blocker stub, and setting URL attributes via `setAttributeNode` or `Attr.prototype.value` bypassed `setAttribute` URL rewriting.
- **Fix:** Preserve the virtual `WebSocketStream` implementation across parent and child realms, and route `Attr.prototype.value` and `NamedNodeMap.prototype.setNamedItem` writes through the element attribute setter policy while preserving `Attr` node identity.

## <a id="destructive-navigation-probes"></a>Isolating destructive navigation probes and preserving form submission semantics (2026-09-06)

- **Cause:** Running top-level navigation probes inside a shared test document navigated the page away before subsequent form submission assertions ran, and child `about:blank` protection copied the parent's `eval`/`Function` wrappers instead of wrapping the child's own realm constructors.
- **Fix:** Isolate destructive navigation tests in dedicated contexts, preserve native `requestSubmit` validation and `CRLF` `text/plain` form encoding, and wrap each child frame's own native `eval` and `Function`.

## <a id="window-method-binding-list"></a>Scope Proxy bound only allowlisted `window` methods, causing `globalThis (2026-09-04) {#window-method-binding-list}

- **Category:** `membrane`
- **Invariant and fix:** Scope Proxy bound only allowlisted `window` methods, causing `globalThis.structuredClone(x)` to throw `Illegal invocation` and render GitHub `ErrorPage`.

## <a id="css-identity-readback"></a>Rewriting CSS `url()` without deproxying on read leaked proxy URLs across 16 read surfaces (2026-09-10) {#css-identity-readback}

- **Category:** `CSS / security`
- **Invariant and fix:** Rewriting CSS `url()` without deproxying on read leaked proxy URLs across 16 read surfaces. Enumerate and wrap all style accessors.

## <a id="hook-source-exposure"></a>Hook source leaked across 368 surfaces (2026-09-10) {#hook-source-exposure}

- **Category:** `fingerprint / rule`
- **Invariant and fix:** Hook source leaked across 368 surfaces. Mask accessors at install time; scanning via `propertyDescriptor` promoted 144 inherited properties to own properties.

## <a id="rewritten-source-exposure"></a>Stringifying page functions exposed rewritten source code (17 on NAVER, 89 on GitHub) (2026-09-10) {#rewritten-source-exposure}

- **Category:** `fingerprint / rule`
- **Invariant and fix:** Stringifying page functions exposed rewritten source code (17 on NAVER, 89 on GitHub). Restore original source strings in `Function.prototype.toString`.

## <a id="typed-om"></a>Style attribute hooks miss CSS Typed OM (2026-09-10) {#typed-om}

- **Category:** `CSS / security`
- **Invariant and fix:** Style attribute hooks miss CSS Typed OM. Hook read-deproxying and write-rewriting together on the `StylePropertyMapReadOnly` prototype.

## <a id="prototype-shape-axis"></a>Added the prototype-shape measurement axis, immediately catching 6 divergences (4 caused by... (2026-09-10) {#prototype-shape-axis}

- **Category:** `fingerprint / probe`
- **Invariant and fix:** Added the prototype-shape measurement axis, immediately catching 6 divergences (4 caused by thin prototypes on replacement classes).

## <a id="withscope-get-hiding"></a>Hiding `__zp_*` in `withScope (2026-09-22) {#withscope-get-hiding}

- **Category:** `membrane / fix`
- **Invariant and fix:** Hiding `__zp_*` in `withScope.get` breaks every rewritten script immediately; hide internal names only on the page-facing scope object.

## <a id="native-url-shadowing"></a>`root (2026-09-22) {#native-url-shadowing}

- **Category:** `membrane / fix`
- **Invariant and fix:** `root.URL` wrapper intercepted prelude-internal `new URL` calls and misread share URLs as targets; shadow `const URL = Native.URL` inside the IIFE.

## <a id="native-own-accessor-misidentification"></a>Native own accessors on Chrome `window` (`performance`, etc (2026-09-22) {#native-own-accessor-misidentification}

- **Category:** `membrane / fix`
- **Invariant and fix:** Native own accessors on Chrome `window` (`performance`, etc.) were mistaken for page-installed and called with `this = scope`; snapshot own names at boot.

## <a id="install-order-tdz"></a>`let` declarations placed after the install sequence crashed the entire prelude via TDZ;... (2026-09-22) {#install-order-tdz}

- **Category:** `membrane / fix`
- **Invariant and fix:** `let` declarations placed after the install sequence crashed the entire prelude via TDZ; declare referenced bindings above their first call site.

## <a id="worker-readonly-globals"></a>Strict assignment to getter-only worker globals (`indexedDB`, etc (2026-09-22) {#worker-readonly-globals}

- **Category:** `worker / fix`
- **Invariant and fix:** Strict assignment to getter-only worker globals (`indexedDB`, etc.) crashes worker boot; install overrides with `Object.defineProperty`.

## <a id="assign-eval-order"></a>Eager RHS evaluation in `x[k] op= v` broke evaluation order, and `call(null)` in sloppy... (2026-09-22) {#assign-eval-order}

- **Category:** `rewriter / fix`
- **Invariant and fix:** Eager RHS evaluation in `x[k] op= v` broke evaluation order, and `call(null)` in sloppy wrappers leaked `this`. Emit accessor adapters for native eval order.

## <a id="e2e-rewritten-doc-probe"></a>Run escape probes inside rewritten documents; `page (2026-09-22) {#e2e-rewritten-doc-probe}

- **Category:** `e2e / rule`
- **Invariant and fix:** Run escape probes inside rewritten documents; `page.evaluate` bypasses the rewriter and tests the wrong execution path.

## <a id="getattribute-usesraw-leak"></a>`getAttribute` on `usesRaw` anchors leaked the raw share URL to the page; return the... (2026-09-22) {#getattribute-usesraw-leak}

- **Category:** `membrane / fix`
- **Invariant and fix:** `getAttribute` on `usesRaw` anchors leaked the raw share URL to the page; return the stashed and deproxied target URL instead.

## <a id="differential-measurement-browser-isolation"></a>Run direct-vs-proxy differential control groups in a separate browser instance because... (2026-09-22) {#differential-measurement-browser-isolation}

- **Category:** `e2e / rule`
- **Invariant and fix:** Run direct-vs-proxy differential control groups in a separate browser instance because `targetcreated` listeners intercept every context in the same browser.

## <a id="foreign-document-location"></a>`contentDocument (2026-09-22) {#foreign-document-location}

- **Category:** `membrane / fix`
- **Invariant and fix:** `contentDocument.location` returned the parent URL; resolve foreign `Location` objects from the frame's `data-zp-target-url` attribute.

## <a id="fixture-script-closing-tag"></a>Literal `</script>` inside fixture scripts terminates the tag even inside JS comments;... (2026-09-22) {#fixture-script-closing-tag}

- **Category:** `e2e / rule`
- **Invariant and fix:** Literal `</script>` inside fixture scripts terminates the tag even inside JS comments; split the string or place it in a `<textarea>`.

## <a id="module-worker-importscripts-stub"></a>`importScripts` exists as a throwing stub in module workers, making `typeof` checks... (2026-09-22) {#module-worker-importscripts-stub}

- **Category:** `worker / fix`
- **Invariant and fix:** `importScripts` exists as a throwing stub in module workers, making `typeof` checks useless; detect module workers explicitly via `mod=1` in the bootstrap hash.

## <a id="worker-client-tab-binding"></a>Worker clients lack a referrer context; call `bindClientContext` on `?tab=` worker-script... (2026-09-22) {#worker-client-tab-binding}

- **Category:** `worker / fix`
- **Invariant and fix:** Worker clients lack a referrer context; call `bindClientContext` on `?tab=` worker-script requests. Sub-dependency failures report the top `import()` URL.

## <a id="csp-two-policy-distinction"></a>Two CSP policies coexist on `/zp/`, so identify the document policy by `report-uri` (2026-09-22) {#csp-two-policy-distinction}

- **Category:** `e2e / rule`
- **Invariant and fix:** Two CSP policies coexist on `/zp/`, so identify the document policy by `report-uri`. Headless Chromium lazy-fetches manifests/prefetches without SPV events.

## <a id="stack-frame-double-leak"></a>Stack frames leak via both URLs and function names: V8 embeds raw URLs in `eval` text and... (2026-09-22) {#stack-frame-double-leak}

- **Category:** `membrane / fix`
- **Invariant and fix:** Stack frames leak via both URLs and function names: V8 embeds raw URLs in `eval` text and exposes `__zp_*` helper names. Sanitize the final stack string.

## <a id="loop-cap-boundary-semantics"></a>Loop-cap bounds vary by +/-1 per form: `for(init;;update)` is also capped (refuting section... (2026-09-22) {#loop-cap-boundary-semantics}

- **Category:** `rewriter / measurement`
- **Invariant and fix:** Loop-cap bounds vary by +/-1 per form: `for(init;;update)` is also capped (refuting section L), and `do-while` runs `10M + 1` times due to post-test checks.

## <a id="crosswindow-dummy-absorb"></a>Cross-window facades absorbed raw member writes (`__zp_get(parent) (2026-09-22) {#crosswindow-dummy-absorb}

- **Category:** `membrane / fix`
- **Invariant and fix:** Cross-window facades absorbed raw member writes (`__zp_get(parent).x = v`); forward only own expandos via Proxy traps.

## <a id="child-realm-boot-side-effect"></a>Child realm boot side effect: `w (2026-09-22) {#child-realm-boot-side-effect}

- **Category:** `membrane / fix`
- **Invariant and fix:** Child realm boot side effect: `w.name = ''` erased browsing context names and double-wrapped containment. Detect top-level realms via `w.top === w`.

## <a id="stylesheet-href-deproxy"></a>`stylesheet (2026-09-22) {#stylesheet-href-deproxy}

- **Category:** `membrane / fix`
- **Invariant and fix:** `stylesheet.href` returned the proxy URL; deproxy CSSOM `StyleSheet` accessors separately from DOM element attribute hooks.

## <a id="loop-cap-nonconst-policy"></a>Loops with non-constant test expressions are uncapped by design; only break-free async... (2026-09-22) {#loop-cap-nonconst-policy}

- **Category:** `rewriter / policy`
- **Invariant and fix:** Loops with non-constant test expressions are uncapped by design; only break-free async `while(true)` retains the 10M-iteration silent-termination divergence.

## <a id="zero-width-patch-swallow"></a>`apply_patches` swallowed same-start zero-width insertions into statement patches; sort... (2026-09-23) {#zero-width-patch-swallow}

- **Category:** `rewriter / fix`
- **Invariant and fix:** `apply_patches` swallowed same-start zero-width insertions into statement patches; sort patches with insert-first priority.

## <a id="fixture-comment-backtick"></a>Backticks or `${` inside comments in `res (2026-09-23) {#fixture-comment-backtick}

- **Category:** `e2e / rule`
- **Invariant and fix:** Backticks or `${` inside comments in `res.end` template fixtures close the template literal early while reporting the parse error at the opening line.

## <a id="error-filename-leak"></a>Throwing inside a prelude helper leaks the prelude URL as the error `filename`; throw from... (2026-09-23) {#error-filename-leak}

- **Category:** `membrane / fix`
- **Invariant and fix:** Throwing inside a prelude helper leaks the prelude URL as the error `filename`; throw from emitted code tagged with `//# sourceURL`.

## <a id="lex-bind-asi"></a>Appending `__zp_lex_bind` after an ASI declaration threw `SyntaxError` across the entire script (2026-09-29) {#lex-bind-asi}

- **Category:** `rewriter / fix`
- **Invariant and fix:** Appending `__zp_lex_bind` after an ASI declaration threw `SyntaxError` across the entire script. Six runner failures masked 1 real bug while CI stayed red.

## <a id="proxy-only-pin"></a>Proxy-only test expectations enshrined 6 divergences as intended design (`on*` string... (2026-09-29) {#proxy-only-pin}

- **Category:** `verification / rule`
- **Invariant and fix:** Proxy-only test expectations enshrined 6 divergences as intended design (`on*` string execution, double `eval`, etc.). Derive expectations from native diffs.

## <a id="surface-differential"></a>Reading `innerHTML` triggered network requests via a live `cloneNode` copy (2026-09-29) {#surface-differential}

- **Category:** `membrane / fix`
- **Invariant and fix:** Reading `innerHTML` triggered network requests via a live `cloneNode` copy. Exhaustive `url_surfaces` differential tests caught 3 IDL bypasses (`input.src`).

## <a id="module-kind-url"></a>`<script type="module">` without `import`/`export` was rewritten as classic script (R1... (2026-09-29) {#module-kind-url}

- **Category:** `htmltx / fix`
- **Invariant and fix:** `<script type="module">` without `import`/`export` was rewritten as classic script (R1 prologue), colliding across modules. Pass `&kind=module` in the URL.

## <a id="ce-prefix-strip"></a>Prefixing `customElements` names by target gave no isolation (registries are per-Window)... (2026-09-29) {#ce-prefix-strip}

- **Category:** `membrane / removal`
- **Invariant and fix:** Prefixing `customElements` names by target gave no isolation (registries are per-Window) and broke `closest`, CSS, and tag identity on GitHub. Removed prefix.

## <a id="prepare-stack-recursion"></a>React's save/restore of `Error (2026-09-29) {#prepare-stack-recursion}

- **Category:** `membrane / fix`
- **Invariant and fix:** React's save/restore of `Error.prepareStackTrace` bound our hook to itself, causing infinite recursion on every subsequent `.stack` read.

## <a id="worker-helper-missing"></a>Workers lacked 15 emitted helpers (`__zp_okeys`, `__zp_delete`, `__zp_oget`, etc (2026-09-29) {#worker-helper-missing}

- **Category:** `worker / fix`
- **Invariant and fix:** Workers lacked 15 emitted helpers (`__zp_okeys`, `__zp_delete`, `__zp_oget`, etc.), throwing `ReferenceError` on `Object.keys(o)`. Guard helpers across realms.

## <a id="contiguous-optional-chain"></a>Rewriting `a? (2026-09-29) {#contiguous-optional-chain}

- **Category:** `rewriter / fix`
- **Invariant and fix:** Rewriting `a?.[k]` to `__zp_oget(a,k)` evaluated `k` eagerly and broke short-circuiting (GitHub ErrorPage). Emit contiguous per-chain `__zp_ochain` calls.

## <a id="child-lexical-scope"></a>Child `about:blank` windows lacked R1 `__zp_lex_*` helpers, crashing scripts with top-level... (2026-09-29) {#child-lexical-scope}

- **Category:** `membrane / fix`
- **Invariant and fix:** Child `about:blank` windows lacked R1 `__zp_lex_*` helpers, crashing scripts with top-level `let` on line 1. Install a lexical registry per child realm.

## <a id="arrow-body-stmt"></a>Prepending the `_STMT` ASI guard `0,` to arrow expression bodies broke arrow syntax,... (2026-09-29) {#arrow-body-stmt}

- **Category:** `rewriter / fix`
- **Invariant and fix:** Prepending the `_STMT` ASI guard `0,` to arrow expression bodies broke arrow syntax, causing `SyntaxError` (Permutive) or silent `ReferenceError` (Rubicon).

## <a id="blob-worker-revoke"></a>`new Worker(u); URL (2026-09-29) {#blob-worker-revoke}

- **Category:** `worker / fix`
- **Invariant and fix:** `new Worker(u); URL.revokeObjectURL(u)` failed closed when the worker fetched its source later; clone the blob into a proxy-owned URL at construction time.

## <a id="worker-self-receiver"></a>Native methods like `self (2026-09-29) {#worker-self-receiver}

- **Category:** `worker / fix`
- **Invariant and fix:** Native methods like `self.addEventListener` threw `Illegal invocation` in workers (scope Proxy receiver), and wrapper `Function.prototype` was an empty object.

## <a id="named-target-frame"></a>`<a target=frame>` loaded the `?via=` launcher inside the frame, which CSP... (2026-10-01) {#named-target-frame}

- **Category:** `membrane / fix`
- **Invariant and fix:** `<a target=frame>` loaded the `?via=` launcher inside the frame, which CSP `frame-ancestors` blocked (while surface probes only read the URL). Route as a frame.

## <a id="child-membrane-overwrite"></a>Every parent read of `contentWindow` overwrote the child's membrane with the parent's... (2026-10-01) {#child-membrane-overwrite}

- **Category:** `membrane / security`
- **Invariant and fix:** Every parent read of `contentWindow` overwrote the child's membrane with the parent's (`define` overwrites writable slots). Preserve the child's own membrane.

## <a id="routed-frame-escape"></a>`contentWindow (2026-10-01) {#routed-frame-escape}

- **Category:** `membrane / security`
- **Invariant and fix:** `contentWindow.eval` ran raw code in the proxy origin across pending blank frames, frames at `about:blank`, and anchorless docs. Contain by active document.

## <a id="navigation-target"></a>Rewriting all `target` attributes to `_self` broke `_blank`, `_top`, form targets, and popups (2026-10-01) {#navigation-target}

- **Category:** `membrane / fix`
- **Invariant and fix:** Rewriting all `target` attributes to `_self` broke `_blank`, `_top`, form targets, and popups. Removed target rewriting; route links/forms/`open` by navigable.

## <a id="cross-site-frame"></a>Cross-site frames lacked isolation; enforce per-virtual-origin window handle policies... (2026-10-02) {#cross-site-frame}

- **Category:** `membrane / security`
- **Invariant and fix:** Cross-site frames lacked isolation; enforce per-virtual-origin window handle policies (returning `SecurityError` stand-ins across sites).

## <a id="postmessage-target-origin"></a>`postMessage` did not filter `targetOrigin` (delivering messages to wrong-site frames) and... (2026-10-02) {#postmessage-target-origin}

- **Category:** `membrane / security`
- **Invariant and fix:** `postMessage` did not filter `targetOrigin` (delivering messages to wrong-site frames) and mishandled options objects. Enforce virtual-origin matching.

## <a id="message-event-receiver"></a>Parent `postMessage` events exposed the proxy origin in `e (2026-10-02) {#message-event-receiver}

- **Category:** `membrane / fix`
- **Invariant and fix:** Parent `postMessage` events exposed the proxy origin in `e.origin` because bare `addEventListener` bypassed the wrapper. Stamp virtual origin on the real event.

## <a id="storage-event-cross-site"></a>`localStorage` writes on one site leaked `storage` events (physical keys, values, internal... (2026-10-02) {#storage-event-cross-site}

- **Category:** `membrane / security`
- **Invariant and fix:** `localStorage` writes on one site leaked `storage` events (physical keys, values, internal keys) to other sites' frames. Translate or swallow in capture phase.

## <a id="fetch-set-cookie-mirror"></a>`Set-Cookie` headers on `fetch`/XHR responses never updated `document (2026-10-02) {#fetch-set-cookie-mirror}

- **Category:** `membrane / fix`
- **Invariant and fix:** `Set-Cookie` headers on `fetch`/XHR responses never updated `document.cookie` (snapshotted at load). Send per-hop cookie deltas in SW metadata before resolving.

## <a id="cookie-change-push"></a>Cookies set by other docs, `img`, `script`, sync XHR, sibling frames, or other tabs were... (2026-10-02) {#cookie-change-push}

- **Category:** `membrane / fix`
- **Invariant and fix:** Cookies set by other docs, `img`, `script`, sync XHR, sibling frames, or other tabs were invisible to `document.cookie`. Push jar deltas to eligible windows.

## <a id="window-name-locks-origin-sharing"></a>Same-site child frames read the parent's `window (2026-10-02) {#window-name-locks-origin-sharing}

- **Category:** `membrane / security`
- **Invariant and fix:** Same-site child frames read the parent's `window.name`, and `navigator.locks.query()` leaked all site locks. Isolate `name` per frame and locks by prefix.

## <a id="sandbox-opaque-frame-emulation"></a>Emulate `<iframe sandbox>` without `allow-same-origin` as an opaque origin (`null` origin,... (2026-10-02) {#sandbox-opaque-frame-emulation}

- **Category:** `membrane / fix`
- **Invariant and fix:** Emulate `<iframe sandbox>` without `allow-same-origin` as an opaque origin (`null` origin, storage denial, cross-origin window) while keeping SW control.

## <a id="markup-created-frame-parking"></a>`<iframe>` nodes created via `innerHTML`, `insertAdjacentHTML`, `<template>`, or `document (2026-10-02) {#markup-created-frame-parking}

- **Category:** `membrane / fix`
- **Invariant and fix:** `<iframe>` nodes created via `innerHTML`, `insertAdjacentHTML`, `<template>`, or `document.write` stayed blank (routed on inert clone). Park `src` until live.

## <a id="bare-frameelement-leak"></a>Bare identifier `frameElement` leaked the embedder's `<iframe>` element to cross-site and... (2026-10-02) {#bare-frameelement-leak}

- **Category:** `membrane / security`
- **Invariant and fix:** Bare identifier `frameElement` leaked the embedder's `<iframe>` element to cross-site and opaque children. Added `frameElement` to `DANGEROUS_GLOBALS`.

## <a id="request-immediately-after-cookie-write"></a>Cookies written right before `fetch` could miss the request because writes and fetches take... (2026-10-02) {#request-immediately-after-cookie-write}

- **Category:** `membrane / fix`
- **Invariant and fix:** Cookies written right before `fetch` could miss the request because writes and fetches take separate paths to the SW. Await pending write acks before `fetch`.

## <a id="inserted-statement-script"></a>Scripts inserted via `replaceChildren`, `insertAdjacentElement`, `Range (2026-10-02) {#inserted-statement-script}

- **Category:** `membrane / security`
- **Invariant and fix:** Scripts inserted via `replaceChildren`, `insertAdjacentElement`, `Range.insertNode`, or Text `before`/`after` ran unrewritten. Completed the hook table.

## <a id="opaque-cookie-secure-loopback"></a>Requests from opaque frames sent full site cookies and dropped `Secure` cookies on... (2026-10-06) {#opaque-cookie-secure-loopback}

- **Category:** `membrane / security`
- **Invariant and fix:** Requests from opaque frames sent full site cookies and dropped `Secure` cookies on `http://localhost`. Mark SW entries `opaque` and treat loopback as secure.

## <a id="opaque-popup"></a>Popups opened by opaque frames were not opaque (2026-10-06) {#opaque-popup}

- **Category:** `membrane / fix`
- **Invariant and fix:** Popups opened by opaque frames were not opaque. Carry `opaque` in `OPEN_SHARE` and pass it through the SW boot JSON into the popup prelude.

## <a id="cookie-sync-xhr"></a>Sync XHR immediately after `document (2026-10-06) {#cookie-sync-xhr}

- **Category:** `membrane / fix`
- **Invariant and fix:** Sync XHR immediately after `document.cookie` writes missed the new cookie. Relay carries unacked writes (latest 32); Go previously truncated after the first 16.

## <a id="cors-enforcement"></a>Missing CORS enforcement allowed unauthorized cross-origin reads (2026-10-06) {#cors-enforcement}

- **Category:** `membrane / security`
- **Invariant and fix:** Missing CORS enforcement allowed unauthorized cross-origin reads. Enforce virtual-origin CORS and preflights in the SW, returning `Response.error()` on denial.

## <a id="tls-fingerprint-drift"></a>Wire fingerprint and persona drifted: two GREASE slots, `key_share` hints, ECH constants,... (2026-10-07) {#tls-fingerprint-drift}

- **Category:** `tls / fix`
- **Invariant and fix:** Wire fingerprint and persona drifted: two GREASE slots, `key_share` hints, ECH constants, and fixed RNG seed (identical first ClientHello). Synced to Chrome.

## <a id="hls-playlist-range"></a>HLS playback failed: player fetches playlist URLs directly (2026-10-07) {#hls-playlist-range}

- **Category:** `sw / fix`
- **Invariant and fix:** HLS playback failed: player fetches playlist URLs directly. Rewrite playlists and serve `Range` slices locally; upstream 206 returned raw bytes (`noRange`).

## <a id="for-empty-test-loop-cap"></a>`for(;;e++)` loop cap declared the same `let` twice, throwing `SyntaxError` (2026-10-07) {#for-empty-test-loop-cap}

- **Category:** `rewriter / fix`
- **Invariant and fix:** `for(;;e++)` loop cap declared the same `let` twice, throwing `SyntaxError`. Verified against a 697-script real corpus and 3,360 combinational tests.

## <a id="raw-text-innerhtml"></a>`script (2026-10-07) {#raw-text-innerhtml}

- **Category:** `membrane / fix`
- **Invariant and fix:** `script.innerHTML = code` (React Helmet) parsed code as HTML markup and split tags. Route raw-text elements (`script`/`style`) to the native setter.

## <a id="document-parse-template"></a>Parsing full documents via `<template>` stripped `html`/`head`/`body` and doctype... (2026-10-07) {#document-parse-template}

- **Category:** `membrane / fix`
- **Invariant and fix:** Parsing full documents via `<template>` stripped `html`/`head`/`body` and doctype (`srcdoc`, `DOMParser`, `document.write`), leaving `document.body` null.

## <a id="relay-observer-loop"></a>Dynamic script relay URLs generated a fresh request ID each time, spinning... (2026-10-07) {#relay-observer-loop}

- **Category:** `membrane / fix`
- **Invariant and fix:** Dynamic script relay URLs generated a fresh request ID each time, spinning `MutationObserver` forever (freezing NYT). Same-value writes still queue records.

## <a id="target-read-sink"></a>Global reads inside destructuring and `for-of` targets (`[window (2026-10-06) {#target-read-sink}

- **Category:** `rewriter / fix`
- **Invariant and fix:** Global reads inside destructuring and `for-of` targets (`[window.a.b]=x`, defaults, computed keys) hit write-only sinks and threw `undefined.a` (BBC ads).

## <a id="h2-content-length"></a>HTTP/2 POST lacked `Content-Length`, causing Optimizely to return 400 after the kernel... (2026-10-06) {#h2-content-length}

- **Category:** `transport / fix`
- **Invariant and fix:** HTTP/2 POST lacked `Content-Length`, causing Optimizely to return 400 after the kernel stripped it without re-adding. Unified rule across H1 and H2.

## <a id="swless-dynamic-script"></a>Scripts created inside blank or `srcdoc` frames failed with 403/503 (2026-10-06) {#swless-dynamic-script}

- **Category:** `membrane / fix`
- **Invariant and fix:** Scripts created inside blank or `srcdoc` frames failed with 403/503. Attach `tab` to `srcdoc` URLs and route blank-frame scripts via relay (fixed blank ads).

## <a id="srcdoc-script-binding"></a>External scripts in `srcdoc` frames never ran because `controller` was null (2026-10-06) {#srcdoc-script-binding}

- **Category:** `membrane / fix`
- **Invariant and fix:** External scripts in `srcdoc` frames never ran because `controller` was null. Embed `tab` and `entry` in script URLs and bind on the first request.

## <a id="swless-element-cors"></a>`crossorigin` elements in frames not controlled by the SW (`document (2026-10-06) {#swless-element-cors}

- **Category:** `membrane / fix`
- **Invariant and fix:** `crossorigin` elements in frames not controlled by the SW (`document.write`) skipped CORS checks. Pass element mode via header and relay parameters.

## <a id="null-receiver-throw"></a>Rewritten member access on `null`/`undefined` receivers returned `undefined`... (2026-10-06) {#null-receiver-throw}

- **Category:** `membrane / fix`
- **Invariant and fix:** Rewritten member access on `null`/`undefined` receivers returned `undefined` (`Object(null)` is `{}`). Run the real access inside tagged `eval` so V8 throws.

## <a id="element-cors"></a>`crossorigin` elements, modules, and fonts bypassed CORS (2026-10-06) {#element-cors}

- **Category:** `membrane / security`
- **Invariant and fix:** `crossorigin` elements, modules, and fonts bypassed CORS. Apply shared options across both SW paths (`fetch` GET and `script`), and proxy `FontFace` URLs.

## <a id="swless-placeholder-red"></a>NAVER ad images rendered as red blocks: the SW-less red placeholder stayed on live elements (2026-10-06) {#swless-placeholder-red}

- **Category:** `membrane / fix`
- **Invariant and fix:** NAVER ad images rendered as red blocks: the SW-less red placeholder stayed on live elements. Restart with the target URL and use a transparent 1x1 pixel.

## <a id="csp-meta-script-preload"></a>Sandboxed frames blocking scripts never requested `<script src>` under the proxy because... (2026-10-06) {#csp-meta-script-preload}

- **Category:** `membrane / fix`
- **Invariant and fix:** Sandboxed frames blocking scripts never requested `<script src>` under the proxy because prelude `<meta>` CSP stopped preloading; keep CSP in headers only.

## <a id="frame-double-load"></a>`src`-routed frames fired `load` twice and added two history entries (three for parsed... (2026-10-01) {#frame-double-load}

- **Category:** `membrane / fix`
- **Invariant and fix:** `src`-routed frames fired `load` twice and added two history entries (three for parsed `onload`). Keep the routed document and swallow the placeholder `load`.

## <a id="dynamic-code-global-this"></a>Global declarations and top-level `this` in `eval`, iframe `referrer`/`ancestorOrigins`,... (2026-10-07) {#dynamic-code-global-this}

- **Category:** `membrane / fix`
- **Invariant and fix:** Global declarations and top-level `this` in `eval`, iframe `referrer`/`ancestorOrigins`, stack format, and webkit FS diverged; keep in-function `eval` `this`.

## <a id="chrome-hello-trust-anchors"></a>Cloudflare challenge cause: Chrome UA lacked `trust_anchors` (`0xCA34`) in ClientHello (2026-10-07) {#chrome-hello-trust-anchors}

- **Category:** `tls / fix`
- **Invariant and fix:** Cloudflare challenge cause: Chrome UA lacked `trust_anchors` (`0xCA34`) in ClientHello. Matching WebView2 is not matching Chrome; diff against real Chrome.

## <a id="coep-worker-bootstrap"></a>`COEP: require-corp` documents blocked all spawned workers because the worker bootstrap... (2026-10-12) {#coep-worker-bootstrap}

- **Category:** `sw / fix`
- **Invariant and fix:** `COEP: require-corp` documents blocked all spawned workers because the worker bootstrap response lacked COEP. Attach inherited security headers to bootstrap.

## <a id="lol-html-raw-attr-value"></a>`lol_html` `get_attribute` returns unparsed entities: `;` inside `&#39;` truncated `<meta>`... (2026-10-12) {#lol-html-raw-attr-value}

- **Category:** `htmltx / fix`
- **Invariant and fix:** `lol_html` `get_attribute` returns unparsed entities: `;` inside `&#39;` truncated `<meta>` CSP down to `'`. Decode HTML entities before parsing values.

## <a id="worker-hook-placement"></a>Worker members live on `WorkerGlobalScope (2026-10-12) {#worker-hook-placement}

- **Category:** `worker / fix`
- **Invariant and fix:** Worker members live on `WorkerGlobalScope.prototype`: instance hooks created own properties and leaked source. Install native-shaped hooks on prototype last.

## <a id="trusted-script-is-code"></a>Native compiled object, array, and `TrustedScript` timer handlers without rewriting (2026-10-12) {#trusted-script-is-code}

- **Category:** `membrane / escape`
- **Invariant and fix:** Native compiled object, array, and `TrustedScript` timer handlers without rewriting. Unexecuted `eval(TrustedScript)` crashed Glassdoor.

## <a id="deterministic-canvas-farbling"></a>Canvas noise changed on every read and mutated the page canvas; make noise deterministic... (2026-10-12) {#deterministic-canvas-farbling}

- **Category:** `membrane / fix`
- **Invariant and fix:** Canvas noise changed on every read and mutated the page canvas. The noise is removed: canvas and audio reads are the browser's own, and no read mutates the page canvas.

## <a id="prepare-stack-trace-page-view"></a>`Error (2026-10-12) {#prepare-stack-trace-page-view}

- **Category:** `membrane / fix`
- **Invariant and fix:** `Error.prepareStackTrace`: our sanitizer on V8's slot was visible to pages and removable via `delete`. Keep the page-facing slot separate via the rewriter.

## <a id="prelude-script-remnant"></a>Prelude self-removal regex looked for nonexistent `/__zp/` and never matched (2026-10-12) {#prelude-script-remnant}

- **Category:** `membrane / fix`
- **Invariant and fix:** Prelude self-removal regex looked for nonexistent `/__zp/` and never matched. Hiding only covers partial APIs; remove the `<script>` node after execution.

## <a id="referrer-single-source"></a>Prelude recomputed `document (2026-10-12) {#referrer-single-source}

- **Category:** `sw / fix`
- **Invariant and fix:** Prelude recomputed `document.referrer` under the default policy, diverging from the SW `Referer` header. Pass the exact SW-computed value in boot config.

## <a id="client-hints-negotiation"></a>Dropping Client Hints and never retrying on `Critical-CH` exposed a non-negotiating client (2026-10-13) {#client-hints-negotiation}

- **Category:** `sw / fix`
- **Invariant and fix:** Dropping Client Hints and never retrying on `Critical-CH` exposed a non-negotiating client. Forward response hints so the browser re-requests the document.

## <a id="transport-failure-is-network-error"></a>Runtime `fetch` returned 502 on connection failures (widget IPv6 probe read it as... (2026-10-13) {#transport-failure-is-network-error}

- **Category:** `sw / fix`
- **Invariant and fix:** Runtime `fetch` returned 502 on connection failures (widget IPv6 probe read it as "Cloudflare 502"). Unreachable upstreams must return a network error.

## <a id="control-group-quic"></a>Control Chrome uses HTTP/3: Chrome with `--disable-quic` also gets interactive challenges... (2026-10-13) {#control-group-quic}

- **Category:** `method / measurement`
- **Invariant and fix:** Control Chrome uses HTTP/3: Chrome with `--disable-quic` also gets interactive challenges on Glassdoor. Compare against `--disable-quic` and log `cType`.

## <a id="busy-renderer-loses"></a>Matching fingerprints still lose if slow: slowing native 8x also triggers interactive challenge (2026-10-13) {#busy-renderer-loses}

- **Category:** `membrane / perf`
- **Invariant and fix:** Matching fingerprints still lose if slow: slowing native 8x also triggers interactive challenge. Widget calls `__zp_get` 15.1M times; fast-path data bases.

## <a id="icon-link-race"></a>HTML parser prefetched icon URLs before `MutationObserver` ran (flaky favicon E2E) (2026-10-13) {#icon-link-race}

- **Category:** `htmltx / fix`
- **Invariant and fix:** HTML parser prefetched icon URLs before `MutationObserver` ran (flaky favicon E2E). Neutralize parser-active attributes during HTML transformation.

## <a id="cross-origin-frame-permissions"></a>Cross-origin frames read top-level permissions, all 76 features, `Notification (2026-10-13) {#cross-origin-frame-permissions}

- **Category:** `membrane / fix`
- **Invariant and fix:** Cross-origin frames read top-level permissions, all 76 features, `Notification.permission = 'default'`, and proxy origin in allowlists. Compute from frame tree.

## <a id="helper-name-response"></a>Page code answered helper names that pass the real global via local bindings, `window`... (2026-10-13) {#helper-name-response}

- **Category:** `rewriter / escape`
- **Invariant and fix:** Page code answered helper names that pass the real global via local bindings, `window` writes, or `with` objects. Deny reads, block writes, bind in block.

## <a id="names-inside-with"></a>Free names inside `with` hit Proxy traps on every lookup (5s in widget) (2026-10-13) {#names-inside-with}

- **Category:** `rewriter / perf`
- **Invariant and fix:** Free names inside `with` hit Proxy traps on every lookup (5s in widget). Bind `__zp_*` helpers as block constants inside the `with` body.

## <a id="inline-guard"></a>Inline guard traps: zero-width insertion at function end absorbed into value span,... (2026-10-13) {#inline-guard}

- **Category:** `rewriter / perf`
- **Invariant and fix:** Inline guard traps: zero-width insertion at function end absorbed into value span, statement-start `0,` becoming an argument, and function name inference.

## <a id="same-source-rerewrite"></a>1 (2026-10-13) {#same-source-rerewrite}

- **Category:** `membrane / perf`
- **Invariant and fix:** 1.3M-char whitespace `eval` timing probes and repeated `eval` calls re-ran the rewriter each time (1.4s). Cache rewritten sources and split leading whitespace.

## <a id="worker-global-names"></a>Worker facade copied page globals, returning `window`/`top`/`parent` with `in` returning true (2026-10-14) {#worker-global-names}

- **Category:** `worker / compat`
- **Invariant and fix:** Worker facade copied page globals, returning `window`/`top`/`parent` with `in` returning true. Copy only worker globals (`typeof === 'undefined'`).
- **Reference:** See [`ERRATA.md`](../../ERRATA.md) (ERRATA 95).

## <a id="cross-origin-window-child-names"></a>Cross-origin windows still answer child frame names (`get` and descriptor; `in` throws) (2026-10-14) {#cross-origin-window-child-names}

- **Category:** `membrane / frame`
- **Invariant and fix:** Cross-origin windows still answer child frame names (`get` and descriptor; `in` throws). reCAPTCHA challenge frame locates its anchor via `parent['a-...']`.
- **Reference:** See [`ERRATA.md`](../../ERRATA.md) (ERRATA 94).

## <a id="sealed-table"></a>Building tables with raw `new Map()` lets pages wrap `Map (2026-10-13) {#sealed-table}

- **Category:** `membrane / escape`
- **Invariant and fix:** Building tables with raw `new Map()` lets pages wrap `Map.prototype` to inspect keys/values or recurse on global reads. Seal tables via a factory.
- **Reference:** See [`ERRATA.md`](../../ERRATA.md) (ERRATA 93).

## <a id="strict-eval-inside-with"></a>Strict direct `eval` cannot contain `with`; emit a strict arrow + block `const eval` inside... (2026-10-13) {#strict-eval-inside-with}

- **Category:** `rewriter / eval`
- **Invariant and fix:** Strict direct `eval` cannot contain `with`; emit a strict arrow + block `const eval` inside the `with` block, and return true in `env.has` only for real names.
- **Reference:** See [`ERRATA.md`](../../ERRATA.md) (ERRATA 92).

## <a id="window-self-accessor"></a>Window `frameElement`/`parent` are self properties redefinable by the page (2026-10-13) {#window-self-accessor}

- **Category:** `membrane / escape`
- **Invariant and fix:** Window `frameElement`/`parent` are self properties redefinable by the page. The membrane reads them exclusively through `winGet` (boot-captured getter).
- **Reference:** See [`ERRATA.md`](../../ERRATA.md) (ERRATA 91).

## <a id="child-booted-with-parent-facade"></a>A child in a reused `about:blank` window captures its parent's `Function` facade as native,... (2026-10-13) {#child-booted-with-parent-facade}

- **Category:** `membrane / fix`
- **Invariant and fix:** A child in a reused `about:blank` window captures its parent's `Function` facade as native, so our wrapper must also pass through the rewriter.

## <a id="window-property-page-definition"></a>When a page redefines or assigns `window (2026-10-14) {#window-property-page-definition}

- **Category:** `membrane / compat`
- **Invariant and fix:** When a page redefines or assigns `window.frameElement`/`parent`/`self`, that definition must answer (used by Cloudflare). Membrane values shadowed it.
- **Reference:** See [`ERRATA.md`](../../ERRATA.md) (ERRATA 97).

## <a id="cross-origin-denial-message"></a>Cross-origin Window/Location denials match exact browser wording (`from`/`on`, index,... (2026-10-14) {#cross-origin-denial-message}

- **Category:** `membrane / frame`
- **Invariant and fix:** Cross-origin Window/Location denials match exact browser wording (`from`/`on`, index, symbol, or closing-only). Pinned via 130-probe A/B diff.
- **Reference:** See [`ERRATA.md`](../../ERRATA.md) (ERRATA 98).

## <a id="replacement-class-shape"></a>`define` mutates function names, leaking native constructor names when aliasing (2026-10-14) {#replacement-class-shape}

- **Category:** `membrane / compat`
- **Invariant and fix:** `define` mutates function names, leaking native constructor names when aliasing. Replacement classes drop static constants; `bind` drops own members.
- **Reference:** See [`ERRATA.md`](../../ERRATA.md) (ERRATA 99).

## <a id="frame-realm-and-internal-calls"></a>Each frame owns its realm (`eval`/`Function`, function prototypes, classes) (2026-10-14) {#frame-realm-and-internal-calls}

- **Category:** `membrane / frame`
- **Invariant and fix:** Each frame owns its realm (`eval`/`Function`, function prototypes, classes). Internal DOM scans call boot-captured natives to bypass page hooks.
- **Reference:** See [`ERRATA.md`](../../ERRATA.md) (ERRATA 100~101).

## <a id="challenge-payload-read"></a>Read challenge payloads via `XHR (2026-10-14) {#challenge-payload-read}

- **Category:** `real-site / method`
- **Invariant and fix:** Read challenge payloads via `XHR.send` breakpoints (in-page instrumentation triggers blocks). Table/field diff tool; stack depth is not the cause.

## <a id="membrane-path-cost"></a>Measure slowdowns per operation: inline script `with` made free identifiers 132x slower and... (2026-10-14) {#membrane-path-cost}

- **Category:** `membrane / perf`
- **Invariant and fix:** Measure slowdowns per operation: inline script `with` made free identifiers 132x slower and `toString`/`document`/`location.href` 20-680x slower.
- **Reference:** See [`ERRATA.md`](../../ERRATA.md) (ERRATA 103).

## <a id="transport-only-control-comparison"></a>Native page + our kernel alone passes Glassdoor (13/13), ruling out transport as the cause (2026-10-15) {#transport-only-control-comparison}

- **Category:** `real-site / method`
- **Invariant and fix:** Native page + our kernel alone passes Glassdoor (13/13), ruling out transport as the cause. Watch for the intercepted POST body trap.

## <a id="cross-origin-frame-policy-gated-apis"></a>Policy-gated APIs stayed open in cross-origin frames, unlike native (2026-10-15) {#cross-origin-frame-policy-gated-apis}

- **Category:** `membrane / fix`
- **Symptom:** Every proxied frame is the same real origin, so the browser's own Permissions-Policy check passes for a frame that is cross-origin natively. Built-in AI (`Translator`, `Summarizer`, ...) answered `downloadable` after seconds instead of `unavailable` at once; MIDI, USB, HID, serial, sensors, `PaymentRequest`, `getUserMedia`, `fullscreenEnabled` and about twenty more behaved as in a top frame; WebGL reported `default` instead of `low-power`. Turnstile's widget reads these answers.
- **Invariant and fix:** `featureDeniedHere(feature)` (the virtual policy) now gates the members in `gatedMembers`/`gatedConstructors` in `12-storage.js` with the exact rejection the browser gives in a cross-origin frame. A frame that is delegated the feature via `allow`, or whose document header allows it, still reaches the native call. Constructors are wrapped in a `Proxy` with a `construct` trap and the prototype's `constructor` is re-pointed at it. In a cross-origin frame `getContext('webgl'|'webgl2')` requests `powerPreference: 'low-power'`.
- **Traps:** APIs that check user activation before policy (`IdleDetector.requestPermission`, `getScreenDetails`) throw the gesture error natively without a gesture, so they are not overridden. Non-policy cross-origin rules (`share`, `canShare`, file pickers) use `feature === null`. Sensor permissions stay `granted` in `permissions.query` even where the constructor is refused. Do not call constructors that are absent in headless Chrome (`Magnetometer`): V8 prints the rewritten call in the error message.
- **Method:** call each API inside a cross-origin iframe natively, record the resolve shape or the thrown name and message, make the same calls in the proxied page and diff the two (92 calls).
- **Closed by:** `test/e2e/proxy.test.js` (`/xfp` probe, compared against native Chrome). See [`ERRATA.md`](../../ERRATA.md) (ERRATA 104).

## <a id="xml-node-serialization-scrub-copy"></a>XML nodes serialized through the HTML serializer lost CDATA and `xmlns` (2026-10-15) {#xml-node-serialization-scrub-copy}

- **Category:** `membrane / fix`
- **Symptom:** `new DOMParser().parseFromString('<br/><![CDATA[x]]>', 'application/xml').documentElement.outerHTML` is `<br/>...<![CDATA[x]]>` natively and `<br></br>...x` through the proxy, with `xmlns` attributes dropped.
- **Invariant and fix:** `scrubbedClone` (`13-attrs.js`) imports the node into an inert document and the copy's document picks the serializer. XML nodes (`/xml/i` on `ownerDocument.contentType`) are copied into an inert XML document (`Native.createXMLDocument`); `text/plain` documents keep the HTML one.
- **Closed by:** `test/e2e/proxy.test.js` (`an XML document from DOMParser serializes as XML`). In e2e fixtures never write an entity inside an inline script string; build it as `'&' + 'amp;'`.

## <a id="widget-payload-stage-diff"></a>Reading and comparing a challenge widget's payload stage by stage (2026-10-15) {#widget-payload-stage-diff}

- **Category:** `real-site / method`
- **Invariant and fix:** Read the widget's final POST object with a CDP `Debugger.setBreakpointOnFunctionCall` breakpoint on `XMLHttpRequest.prototype.send` and take the largest JSON-serialized object from the call frame scope; nothing is injected into the page. The membrane replaces `send` late, so re-arm the breakpoint several times after context creation. Stages (`"1"`, `"2"`, ...) shuffle between runs, so pair them by key set and keep only fields that are constant within each mode and differ between modes. Document-start hooks (`page.evaluateOnNewDocument`) also reach the out-of-process widget frame and can wrap `JSON.stringify`, `createPolicy` or sink setters.
- **Traps:** a debugger attached to the native parent breaks it (a 57 s stall, then error 300031), so read only the widget. A hook that formats its log with the global `JSON.stringify` recurses into itself. Temporary patches left in `dist` make unrelated e2e tests fail; rebuild clean before running e2e. Bash heredocs and `node -e` halve backslashes, so write regex-bearing files with the editor tools.
- **Status:** the categorical differences found this way are fixed or ruled out in [the inverse experiment](#inverse-experiment-add-differences-to-a-passing-run); the remaining ones are listed in the ERRATA residual rows.

## <a id="challenge-class-depends-on-http3"></a>The challenge class a human receives depends on HTTP/3 (2026-10-15) {#challenge-class-depends-on-http3}

- **Category:** `real-site / measurement`
- **Invariant and fix:** `window._cf_chl_opt.cType` was `managed` (auto-pass) 8/8 for default Chrome (document over HTTP/3), 2/5 for the same Chrome with QUIC disabled, and `interactive` (checkbox) 7/7 through the kernel, which speaks HTTP/2 only. The wire identity read from an echo service (JA4, extensions, ECH, H2 frames and header order, TCP/IP) is equal. A bridge that intercepts through puppeteer cannot send `Sec-Fetch-*`, `Accept-Language` or `Priority`, so its document GETs lack them.
- **Status:** the checkbox flow passes natively and fails through the proxy, so HTTP/3 settles which flow a person sees but does not explain the failure. Adding HTTP/3 to the kernel means a UDP path and a QUIC stack.

## <a id="inverse-experiment-add-differences-to-a-passing-run"></a>Inverse experiment: add the proxy's differences to a passing run (2026-10-15) {#inverse-experiment-add-differences-to-a-passing-run}

- **Category:** `real-site / method`
- **Invariant and fix:** To tell which measured difference causes a rejection, start from the configuration that passes (native page plus the proxy kernel) and make only the widget frame look like the proxied one, one factor at a time: a document-start hook scoped to the `challenges.cloudflare.com` frame (built-in AI answers `downloadable`, WebGL power preference, open gated APIs, audio noise, `connection.rtt = 0`) or a header the bridge strips (CSP, and with it `sandbox`). Verify that each hook really ran in the widget frame before trusting a pass; run the unmodified baseline first.
- **Result:** every factor alone, all together, and all together under 5x CPU throttling still passed 3/3. None of these differences is the cause, which was read as Trusted Types not mattering. It had removed the header CSP only: the widget document carries the same Trusted Types directives in a `<meta>`, which stayed, so Trusted Types was still enforced in every one of those runs (see [the Trusted Types entry](#widget-needs-trusted-types)).
- **Status:** the process model is a cause; see [the process-model entry](#widget-process-model-inverse). Untested: a non-uniform timing profile and HTTP/3.

## <a id="widget-process-model-inverse"></a>A widget that shares its embedder's process fails even with no membrane (2026-10-19) {#widget-process-model-inverse}

- **Category:** `real-site / measurement`
- **Invariant and fix:** With the native page and the proxy kernel (passes), launching Chrome with `--disable-site-isolation-trials --disable-features=IsolateOrigins,site-per-process` puts the Turnstile frame in its embedder's process and the check fails 4 of 4; a Chrome with an unrelated flag passes. No rewriter, membrane or proxy origin is involved, so a proxied widget (always in its embedder's process: one real origin) cannot pass while this holds. The remedy is giving cross-site targets different real sites, so the browser isolates their frames.
- **What it is not:** in the shared process `performance.memory` reads fixed coarse buckets (`10000000/14300000/3760000000`), and the widget reads it eight times in one stage. Bucketed values fail 3 of 3 when injected into the isolated widget, but precise values (`--enable-precise-memory-info`, or a hook) leave the shared-process run failing 3 of 3, and inflated or churned heap numbers like the proxied widget's pass. `measureUserAgentSpecificMemory` and long-task attribution (`containerType` `iframe` against `window`, the proxy URL as `containerSrc`) also differ by process model, but the widget never calls the first and registers no long-task observer. The remaining process-dependent observable is not identified.
- **Resource Timing:** the widget registers a live observer for `resource` and `navigation`. The proxied widget's list is 13 entries against 4 natively (initiator types `fetch`/`img` for XHR and `<link>`, the proxy's `/__zp/zp_page_rt.wasm` fetch, three `script` and several negative-duration `other` entries, and a POST to `.../new/undefined` answered 405). Remapping the initiator types, or adding four genuine fetches to the isolated widget, still passes. Synthetic entry objects hang the widget on their own, so they cannot test the rest.
- **Method traps:** a replacement getter must be a `Proxy` of the native one (a plain function fails the widget's native check even with real values). The widget's payload now carries opaque per-stage tokens, so field-by-field payload comparison is no longer possible; use black-box inverse experiments.

## <a id="localhost-label-sites"></a>Which hostnames Chrome isolates from each other, and what a framed worker costs (2026-10-19) {#localhost-label-sites}

- **Category:** `design / measurement`
- **Invariant and fix:** On a local relay, `<label>.localhost` hostnames resolve to loopback, are secure contexts and each is its own site: a frame at `b.localhost` inside `a.localhost`, `proxy.localhost` or `127.0.0.1` is in another process (postMessage round trip 0.4 ms against 0 in-process), while `x.a.localhost` and `a.localhost` share a site and a process. The relay answers under any Host (its CSP and origin checks follow `r.Host`). A cold origin registers its service worker and is controlled in about 170 ms.
- **Limits:** service workers and storage are partitioned by top-level site. A framed `b.localhost` does not see the worker `b.localhost` registered as a top-level page, registers its own once per top-level site, and is controlled only after the frame reloads. Subdomains of one registrable domain share a site, so a deployment on a real domain (`x.proxy.example`) gets no isolation unless every site has its own registrable domain.
- **Method:** a throwaway page server with iframes for the process question, and a minimal worker for the partition question; the proxy was not changed.

## <a id="site-frame-traps"></a>Site frames: five ways a frame at its own real origin broke, and the lab trap that hid them (2026-10-19) {#site-frame-traps}

- **Category:** `membrane / frame`
- **Invariant and fix:** (1) The frame's first response, served by the relay before any worker exists, must carry `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: cross-origin`, and so must the launcher page the worker serves for a route it does not know, or a COEP parent (the Cloudflare challenge page) cannot embed it (`ERR_BLOCKED_BY_RESPONSE`). (2) A target's `<meta>` CSP is merged with the plumbing it needs, and must also admit the site hosts in `frame-src` and `child-src`. (3) `containFrameWindow` on a window the browser holds as cross-origin used to throw on its first read and remove the frame; unreachable windows are left alone. (4) The relay's synchronous-XHR queue was one queue: a worker of another origin took the job and failed it with `SW_NOT_READY`; it is per host now (symptom: scripts written into blank frames missing only in a long suite run). (5) A site frame's first request comes from its own launcher (`Referrer-Policy: no-referrer`); the embedder's policy travels in the fragment.
- **Lab trap:** with the Chrome window occluded every puppeteer `mouse.move` takes 5 s, so a person-order click took 100 s and read as a hang. Start Chrome with `--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`.
- **Closed by:** `test/e2e/proxy.test.js` (`with site frames on, a frame of another site runs at a real origin of its own...`) and the whole e2e suite, which runs with site frames on by default and also passes with `ZP_E2E_SITE_FRAMES=0`; Go `siteframe_test.go` and `TestSyncFetchJobsAreScopedByOriginHost`; unit tests in `core.test.js` and `prelude-units.test.js`. Design: [`site-frames.md`](../design/site-frames.md).

## <a id="replacement-invalid-calls"></a>A replacement must fail where the member fails: receivers, argument counts, and the proxy's own requests (2026-10-20) {#replacement-invalid-calls}

- **Removed 2026-10-23 (bcab7e0):** the guard layer (`guardMethod`, `guardGetter`, `guardSetter`) is gone. What stays: `sendBeacon()` without arguments throws instead of POSTing to `.../undefined` (a real request the origin answered 405), and an XMLHttpRequest keeps its state in a record the instance does not expose. Kept as history; see `prune-fidelity-2026-10-23`.

- **Category:** `membrane / fidelity`
- **Invariant and fix:** The engine refuses a call a WebIDL member cannot take: a receiver without the interface's internal slots (`Illegal invocation`) and fewer arguments than the operation requires (`1 argument required, but only 0 present`). A membrane replacement that ignores `this` or the argument count answers instead. It also does work the page never asked for: `navigator.sendBeacon()` sent a POST to `.../undefined` (the 405 in the proxied Turnstile flow). `02-masking.js` now wraps each replacement of a native member (`guardMethod`, `guardGetter`, `guardSetter`, applied by `define`, `defineAccessor`, `defineMasked`, `definePropertiesMasked`, `replaceNativeMethod`): an invalid call goes to the replaced member, which throws the real error before it does anything; a valid call reaches the replacement. The receiver is checked with a getter of the same interface the membrane leaves alone (`Node`, `Element`, `HTMLElement`, `Document`, `Navigator`, `History` only: the membrane hands out stand-ins for `NamedNodeMap`, `HTMLCollection` and the storage facades, which keep the argument check only). A replacement class (`XMLHttpRequest`) brands its instances itself and hands arity failures to the native member on a spare native instance (`guardClassMembers`).
- **Also fixed on the way:** `XMLHttpRequest` kept its state in `_zp*` own properties and exposed setters for read-only attributes; the state is now a `WeakMap` record, an instance owns no properties and `readyState`, `status`, `response*` have no setter. `URL()` without `new`, `new URL()`, `URL.canParse()`/`parse()`/`revokeObjectURL()` without arguments, and `__defineGetter__`/`__defineSetter__` with a non-function now throw the engine's own messages. The shared `EventTarget` shim checks its argument count.
- **Probe:** `.lean-ctx`-style lab scripts call every function reachable from the widget's window with a null and a plain-object receiver and zero arguments in the native and the proxied frame and diff the answers: 142 differences of 3664 members before, 0 after.
- **Not the cause of the Glassdoor failure:** the proxied person-order flow still fails 0/5 with all of this in. The same applies to the other things measured against it in the same pass: a native page with the same 687 platform members answering invalid receivers with a value fails 0/3 against 2/3 for the same Proxy wrappers rethrowing (too few runs to separate the wrapper from the answer), a native page with the proxied page's 330 descriptor-flag differences applied passes 3/3, one extra history entry passes 3/3, and the prelude's diagnostics switched off (trace log, 100 ms heartbeat, `console.error` capture) still fails 0/5.
- **Still different (shape, not behavior):** `console.error` is a plain function (the diagnostics capture), `Object.prototype.__defineGetter__`-family and `Object.keys` replacements are constructible and carry a `prototype`, and the replacement classes' constructors inherit from `Function.prototype` instead of their parent interface constructor.

## <a id="hybrid-native-parent-proxied-widget"></a>Native parent, proxied widget: the failure does not need a proxied parent (2026-10-20) {#hybrid-native-parent-proxied-widget}

- **Category:** `real-site / method`
- **Invariant and fix:** To tell whether the parent page or the widget frame is what the server rejects, the Glassdoor page runs natively (its network answered by the proxy kernel over CDP, as in the passing control) and only the Turnstile frame is served by the proxy as a site frame. The bridge answers the widget document's navigation with a `302` to `siteFrameOrigin(...)` plus the share path and fragment the membrane would have built (computed outside a page with `zp-core.js`), with `Cross-Origin-Resource-Policy: cross-origin` on the redirect; it fetches the site frame's first document itself over loopback (Node cannot resolve `*.localhost`, and the request needs `Sec-Fetch-Dest: iframe` for the relay to answer as a bootstrap) with `frame-ancestors` removed; it adds the site host to the `frame-src`/`child-src` of the challenge page's `<meta>` CSP; and it patches `api.js` twice (`pt()` returns the site-frame origin for the widget URL, `wi()` accepts it) because the parent addresses and validates the frame by the origin of its `src`.
- **Result:** native parent plus proxied widget fails the person-order flow 0 of 4 (the checkbox shows, the click is made), as the fully proxied page does. The proxied parent is not what makes the check fail. The same hybrid with the widget served untransformed (no prelude, no rewriter, through the service worker's transport only) also fails 0 of 4, but that run cannot separate the membrane from the rest: an unvirtualized widget reads `location` and reports the site-frame host.
- **Also measured:** the installed Chrome had moved to 155 while the persona (user agent, `Sec-CH-UA` brands, full version) said 154; `check:chrome-hello` reports the ClientHello unchanged, the persona is now 155, and the flow still fails 0 of 5. Rewritten scripts run inside `with(__zp_lex_scope)`, and each free name (`Math`, `document`) costs about 0.5 µs there against about 1 ns natively (700 to 1000 times in a micro-benchmark, while arithmetic, array and property reads cost the same); running the widget's inline script without the `with` also still fails 0 of 5.
- **Wire of a subresource POST (echo service, native against proxied):** the proxied request has no `priority` header (Chrome sends `u=1, i` on `fetch`; the service worker adds `priority` only to documents) and the script's custom headers sorted by name where Chrome interleaves them with its own in its own order; the TLS hello differs only by the resumption extension (`pre_shared_key`) the proxy kernel adds on a second connection. The passing control sends no `priority`, `sec-fetch-*` or `accept-language` either, so these are not what the server rejects.
- **Status:** what remains on the widget side is the service worker's transport (headers, timing, Resource Timing entries), the widget's real origin (`http://s-...localhost:PORT`), and rewriting itself. An exact-origin platform (a lab HTTPS server answering as `challenges.cloudflare.com`) would separate them.

## <a id="widget-needs-trusted-types"></a>The Turnstile widget needs its Trusted Types policy; the proxy drops it (2026-10-20) {#widget-needs-trusted-types}

- **Category:** `real-site / measurement`
- **Invariant and fix:** The Turnstile widget document declares `trusted-types <name> default; require-trusted-types-for 'script'` in its header **and** in a `<meta>` CSP. Natively its `default` policy runs on every string sink (`eval(string)`, `innerHTML`, `script.src`) and its own helpers use a named policy; the proxy sends its own header CSP and keeps only plumbing and resource directives of a `<meta>` CSP (`filter_meta_csp_with`), so none of it is enforced. The native run that passes (3 of 3) fails **0 of 4** when only the `trusted-types` and `require-trusted-types-for` directives are removed from the widget document's header and `<meta>` (bridge option removing exactly those two, verified in both places). The earlier inverse experiment that removed "the CSP" stripped the header only (and matched an old `/h/g/` path), so it had not removed Trusted Types.
- **How it was found:** a bisect on a platform where the proxied widget runs at the widget's own origin: a lab TLS front for the relay, Chrome's `--host-resolver-rules` and an SPKI-pinned certificate, the Glassdoor page native. That platform fails 0 of 4 (so origin, scheme and host are not the cause); the widget served untransformed through the service worker passes 4 of 4 (transport is not either); the membrane without rewriting, no prelude at all, and groups of membrane steps skipped each fail 0 of 4 (the membrane and the rewriter are not it); the remaining difference between the untransformed and the transformed document is the HTML transformation, and the part of it the widget can observe is the CSP.
- **What enforcing it takes:** keep `trusted-types` and `require-trusted-types-for` from the target's CSP (header and `<meta>`) in the proxied document and make the membrane's own string sinks Trusted-Types-clean: a proxy-owned policy name added to the allowed list, and `TrustedScript`/`TrustedHTML`/`TrustedScriptURL` values from it wherever the membrane hands a string to `eval`, `Function`, `innerHTML` and its relatives, `script.src`/`text`, `Worker` URLs, `srcdoc`, `document.write`. Page-supplied strings must still go through the page's default policy first, and a page-supplied `Trusted*` object must survive the membrane's rewriting. A first lab attempt that kept the directives with no membrane at all made the widget throw an `EvalError` of its own, so the membrane is not the only place a string reaches a sink.
- **Status:** implemented (see [the enforcement entry](#trusted-types-enforced)); the fix is general (any document that declares Trusted Types), not specific to this widget. The proxied person-order flow still fails with it in.

## <a id="trusted-types-enforced"></a>Trusted Types are enforced natively in proxied documents; what that did and did not change (2026-10-21) {#trusted-types-enforced}

- **Category:** `membrane / csp`
- **Invariant and fix:** a target's `require-trusted-types-for 'script'` and `trusted-types` list now bind the proxied document itself. The service worker appends one Trusted-Types-only policy per target policy to the proxy's CSP header (`ZP.trustedTypesPolicies`, comma-joined, so the target's directives are not unioned with ours), the `<meta>` filter keeps both directives (`trusted_types_directives` in `zp-shared`, `trustedTypesDirectives` in `zp-core.js`), and both add the membrane's policy name `zp-internal` to a `trusted-types` list (`'none'` becomes that name; `*` already admits it). `02-trusted-types.js` creates that identity policy first; every string the membrane hands a native sink is a `Trusted*` value from it (`ttWrapNatives` at capture, `ttHTML`/`ttScript`/`ttScriptURL` where it builds source itself). A string from the page goes to the page's `default` policy of the realm that owns the node, called as the engine calls it (`createX(string, 'TrustedX', sink)`), or is refused with the engine's message when there is none (`ttCompliant`). A document that does not enforce is untouched.
- **Traps found on the way:** `new Function(TrustedScript)` is an `EvalError` in Chrome 155 although `eval(TrustedScript)` works, so the membrane's own `Function` is `eval` of the source it would have compiled (`ttFunction`); a frame has its own `default` policy, so the sink's node decides which realm's policy is called (`ttOfNode`); a `<meta>` Trusted Types directive can arrive after scripts that already created policies, so enforcement is re-read when the number of `<meta>` elements changes; the engine's `Function` sink reports the whole synthesized source (`(function anonymous(a,b\n) {\n...\n})`), not the body. The meta filter no longer adds `blob:`/`data:` to `connect-src` (the target's policy decides whether `fetch('data:,')` is refused, and Turnstile probes exactly that and listens for the violation event); the proxy's header still admits them.
- **A blob worker inherits its creator's Trusted Types, and the first version missed it (found 2026-10-21 by probing a worker inside the live widget frame):** natively a blob or data worker is bound by the policies of the document that started it (`eval` and `new Function` throw `EvalError`, a string for `setTimeout` or `importScripts` throws `TypeError`, `createPolicy` honours the inherited name list), while a worker started from a URL has only its own response's policy. The proxied worker's script is a bootstrap served by the service worker whose CSP carried none, so its workers were not bound at all (`eval('1 + 1')` answered 2). The membrane now lists the creator's policies (response header and `<meta>`) as `tt` in the bootstrap fragment of a blob or data worker (`ttInheritedPolicies`); the bootstrap response carries them (only Trusted Types directives are taken from the list), makes the worker's own `zp-internal` policy and loads the prelude through it; `worker-prelude.js` hands Trusted values to its own `eval`, `Function` and `importScripts` and checks a page's strings against the worker's `default` policy as the page-realm code does (`workerBuildFunction`, `ttCompliant`, the `WorkerGlobalScope setTimeout`/`setInterval`/`importScripts` sinks). A srcdoc frame needed nothing: it inherits the physical policy and the e2e test pins that. In the live widget a blob worker started through its named policy answers identically native and proxied. It did not change the Glassdoor result (still 0 of 3).
- **Parity measured on the widget:** the default policy and the policy `YKcu9` receive the same inputs, types and sinks natively and proxied, in the main frame and in a `srcdoc` child; the widget's own integrity probes (`createPolicy()`, `policy.createHTML()` and the other two with no receiver) throw `Illegal invocation` in both; no Trusted Types violation event fires in either.
- **Not the cause of the Glassdoor failure** (the proxied person-order flow still fails, 0/3 with this in): measured on the native passing run, each 3/3 unless noted: the header's `sandbox` removed, widened to every flag, or cut to two (the widget's iframe carries its own `sandbox` attribute, which the header intersects with); `data:`/`blob:` added to `connect-src` (the proxied header has them); `script-src-attr 'none'` loosened; one policy (header or `<meta>`) instead of two, which gives one violation event per probe like the proxied document (native two, proxied one); the proxy's exact header and filtered `<meta>` imposed with the document's nonce kept; the CPU throttled 2x and 4x (23 s end to end). Skipping each of four groups of membrane steps on the proxied platform with Trusted Types in place still fails 0/2 each. Cookies are no factor either: the widget sends and receives none natively. Native stripped of Trusted Types fails 4/4 in runs interleaved with passing controls.
- **Numbers to compare:** the `ci` reply is 2540 B on a native pass, 593 B with Trusted Types stripped and 4490 B proxied; the widget's reply to the click is 5676 B, 14160 B and 16888 B; the parent's reply to the token is 4044 B, 3756 B and 3756 B. The proxied stages are slower (first `fo` POST to `ci`: 4.1 s against 1.2 s), but a native run passes at 4x throttling.
- **Method trap:** an early native sweep failed 0/3 and 1/3 for header edits that later passed 3/3 and 3/3 minutes apart. A window of failures that no edit explains happens; interleave a control with every variant and rerun a surprising failure before building on it.

## <a id="worker-importscripts-error-url"></a>A failed importScripts in a proxied worker names the proxy's URL, not the target's (2026-10-21) {#worker-importscripts-error-url}

- **Category:** `membrane / fidelity`
- **Invariant and fix:** not fixed, recorded to handle later. `importScripts('/missing.js')` in a worker started from a URL throws `NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at 'http://proxy.localhost:PORT/zp/api/worker-script?tab=...&u=...' failed to load.` Natively the message names the target URL (`http://target/missing.js`). The worker prelude rewrites the URL to the proxy route before calling the native `importScripts`, and the engine words the error with the URL it was given. Found while comparing worker behavior under Trusted Types (the e2e probe for it reports only the error name for that reason).
- **Scope:** the message carries the proxy's origin string, which is concealment (not a goal) unless a site reads or compares it; a fix would catch the `NetworkError` in the `self.importScripts` wrapper and rethrow it with the target URL in the message.

## <a id="event-window-identity"></a>The page's `window` is not the window events hand out, and UI events refused `view: window` (2026-10-21) {#event-window-identity}

- **Category:** `membrane / fidelity`
- **Invariant and fix:** the page's `window` is the membrane's facade (`scope`); the native event surface speaks of the real window. An event's `view`, `target`, `currentTarget`, `srcElement` and `composedPath()` returned the real one (`e.currentTarget === window` false, `e.view === window` false on every UI event), and every UI event constructor with `view: window` threw `Failed to convert value to 'Window'` (`MouseEvent`, `PointerEvent`, `KeyboardEvent`, `FocusEvent`, `InputEvent`, `WheelEvent`, `UIEvent`, `CompositionEvent`), as did the legacy `initMouseEvent(…, window, …)`. `new MouseEvent('click', { view: window })` is how a script simulates a click. `installEventWindowIdentity` (end of `installPhase2Membrane`, `07-membrane.js`) maps the real window to the facade in those getters, replaces the constructors with Proxies that hand the real window to the native class (so `new.target`, subclassing, statics, `length` and `name` stay native, with `prototype.constructor` and the parent link pointing at the replacements) and wraps the four legacy `init*Event` methods.
- **How it was found:** probing as page code. A CDP-evaluated probe is not rewritten and reads the real `location`, so it shows differences the page never sees (`location.href` in the exact-origin frame is such a mirage); the same probe run through `__zp_eval` with a `TrustedScript` of the widget's own policy sees what the page sees. A scan of about 9,200 properties of events, documents, elements, observers and timeline entries for a self-window that is not `window` finds none now.
- **Not the cause of the Glassdoor failure:** the proxied flow still fails 0 of 3 with this fixed.
- **Tests:** the e2e test "window identity holds across events" compares 18 readings with native.

## <a id="performance-entry-fidelity"></a>Timeline entries serialized the proxy's URL, and long-animation-frame attribution listed the membrane (2026-10-21) {#performance-entry-fidelity}

- **Removed 2026-10-23 (4c616c0):** the `toJSON`, `sourceURL`, `invoker` and long-animation-frame `scripts` hooks are gone; `entry.name` still reads the target URL (older behavior), `JSON.stringify(performance.getEntries())` carries the proxy path again. Concealment of a proxy string, and no page was recorded to break. Kept as history; see `prune-fidelity-2026-10-23`.

- **Category:** `membrane / fidelity`
- **Invariant and fix:** `entry.name` was virtualized but `toJSON()` was not: `PerformanceResourceTiming.prototype.toJSON` shadowed the generic override and only rewrote timing keys, and `PerformanceNavigationTiming` has its own native `toJSON`. `JSON.stringify(performance.getEntries())` therefore carried `/zp/api/v2/fetch?url=…` for a resource and `…/zp/p/<token>#k=<share key>` for the navigation entry. Long-animation-frame script attribution (`PerformanceScriptTiming`) listed the membrane's own handlers (the prelude's `message` listener, its promise reactions: 5 of 14 entries in the proxied widget, 9 natively, all the document's) with `sourceURL` = `runtime-prelude.js`, and a page script's `sourceURL` was the proxy route. `12-storage.js` now gives `toJSON()` the virtualized name and timing overrides for resource and navigation entries, makes `sourceURL` name the target, hides scripts under `/zp/assets/` and `/__zp/` from `scripts` (one frozen array per entry, as natively) and keeps `toJSON()` of both in step.
- **Also seen, not changed:** in the exact-origin lab platform the proxy origin is the target origin, so the infrastructure filter hides the widget's own resource entries (an artifact of that platform; a real deployment's proxy origin differs).
- **Not the cause of the Glassdoor failure:** still 0 of 3. The proxied widget's verdict is explicit: its `fail` event carries `code: "600010"` about 0.75 s after the click, where a native pass sends `complete` with a token 0.25 s after `interactiveEnd`.
- **Tests:** the e2e test "the performance timeline a page serializes" compares names and serialized names with native and checks that no proxy route appears.

## <a id="trusted-types-compilation-rules"></a>Trusted Types: what the engine does when a default policy changes a string (2026-10-21) {#trusted-types-compilation-rules}

- **Category:** `membrane / csp`
- **Invariant and fix:** measured on Chrome 155 with controlled policies. When the `default` policy returns text that differs from its input, `eval`, indirect `eval` and the `Function` constructor all throw `EvalError` (a `null` or empty answer too); a timer runs the returned text and markup uses it; a policy that answers the same text lets a compilation through. The first version of `ttCompliant` evaluated the changed text for `Function` and returned the result, so `new Function('…')` gave `undefined` and `new Function('…')()` a `TypeError: (intermediate value) is not a function`; it now refuses a changed compilation in both realms (`02-trusted-types.js`, `worker-prelude.js`). The e2e fixture's default policy had returned its input, which is why the tests missed it.
- **Not matched, known:** the public `policy.createHTML()` turns a callback's `null` into an empty `TrustedHTML`, so a default policy that answers `null` for a markup sink reads as an empty string where the engine refuses; and Chrome does not consult the default policy for `eval`/`Function` from a script element whose text was a `TrustedScript` inside a subframe (a clean-room page shows it; the same strings are consulted from a parser-inserted script, and V8's eval cache hides repeats), where the membrane consults it for every page string. The widget's own flow is unaffected: its default-policy call counts match (40 and 40, all returning the text unchanged), and its policy returns `''` for anything asked after its start, so a probe that evals a string late in the widget frame sees `undefined`.
- **Tests:** the e2e test "a default policy that changes a string" and a unit test.

## <a id="glassdoor-cleared-2026-10-21"></a>What was cleared natively and what is still open for the Glassdoor flow (2026-10-21) {#glassdoor-cleared-2026-10-21}

- **Category:** `real-site / measurement`
- **Method:** the native passing run (Glassdoor native, its requests answered by the proxy kernel) with one proxied property applied in the widget frame, verified at click time, 3 to 4 runs each, a control alongside; and the reverse, a proxied widget probed as page code.
- **Cleared (the native run still passes):** the header `sandbox` removed, widened to every flag or cut to two; `data:`/`blob:` in `connect-src`; `script-src-attr`; one CSP policy instead of two; the proxy's exact header and filtered `<meta>` imposed; a 2x/4x CPU slowdown and 6x on the main thread only; the proxied two-voice `speechSynthesis` list (the native widget saw 2 voices instead of 20: 4 of 4); the proxied `document.referrer` (4 of 4); 123 bare zero-argument global calls and eight rendering, audio, math and locale fingerprints (the same); the widget's console output and unhandled errors (the same `%c%d` console probe in both); heartbeat latency between widget and parent (0.4 to 0.7 ms in both); cookies (the widget sends and receives none).
- **Hook artifacts, not findings:** the resource-timing hooks that hand the widget synthetic entries built with `Object.create(PerformanceResourceTiming.prototype)` fail the native widget for every variant (it calls real getters on them); the `brand` hook (platform members answering invalid receivers with a value) emulates the membrane before its guard layer and fails natively, and the `flags` hook hides that by making properties non-configurable. Do not read them as proxied properties.
- **Wire (a genuine Chrome against the service worker):** the proxied requests lack `priority: u=1, i` and the `pat` request's `cache-control: max-age=0`, carry `sec-ch-ua*` on the worker-originated `pat` request where Chrome sends none, and send `accept: */*` for the `ci` image where Chrome sends the image list. The control sends none of `sec-fetch-*`, `accept-language`, `priority` and passes, so presence is not what the server needs.
- **What a proxied run says:** `ci` reply 4490 B against 2540 B, a `fail` event with code 600010 after the click (a native pass sends `complete`), the widget's POSTs about 3.4 KB smaller than a pass at the same stages, the widget reaching its first marks about 3.4 s later than natively.
- **Open:** what the server rates differently is not found. Not yet measured: the widget's own worker environment as a whole (only the Trusted Types behaviour of a blob worker is compared). The stack positions of compiled code and the timing profile were measured next, see [the stack entry](#stack-fidelity-2026-10-21).

## <a id="stack-fidelity-2026-10-21"></a>The widget reads error stacks; what it reads, what differed, what was cleared (2026-10-21) {#stack-fidelity-2026-10-21}

- **Removed 2026-10-23 (8a3d12d):** the object-literal declaration of the four dynamic constructor wrappers and the builtin-frame text of the stack sanitizer are gone, with the e2e that compared about 60 stack shapes with native. `Function.prototype.constructor` stays a writable data property: less code, and the native shape. Kept as history; see `prune-fidelity-2026-10-23`.

- **Category:** `membrane / fidelity`
- **What the widget reads:** a prepareStackTrace hook in the native passing run shows about 183 stack reads, almost all of one shape: the `TypeError` of `Function.prototype.toString` called on `Object.create(Function.prototype)` (the receiver's type name is `Function`), plus `Function.prototype.toString.call(window)` and `String.prototype.toString.call(window)` once each. The proxied widget makes the same calls (about 182 reads in each of its frames).
- **Fixed (three real differences in exactly those stacks):** (1) `Function.prototype.constructor` (and the async, generator and async-generator prototypes) was a get/set accessor, so V8 could not read a `constructor` data property to name the receiver's type and printed `Object.toString` where a browser prints `Function.toString`; it is a writable data property again, as the worker prelude already had it (main realm, child realms). (2) The wrappers' debug names are renamed by the minifier (`function Function` became `x`, so `x.toString`); V8 names the type from the function's debug name, not its `name` property, so the four wrappers (membrane, child realm, worker prelude) are declared under object-literal keys, which the minifier keeps. (3) The stack sanitizer printed a builtin frame whose receiver is a Proxy (the window facade) as `toString (<anonymous>:null:null)`; V8 prints `toString (<anonymous>)`.
- **Measured, not the cause (the proxied flow still fails 0/3):** frame depth (V8 spends its 10 captured frames before the membrane's frames are dropped, so proxied stacks hold 6 to 7 frames where native holds 10; restoring 10 with a larger capture limit and a cap changed nothing); positions (the native widget still passes with its whole inline script moved one line, 7 columns or 4093 columns); slowness (the native widget passes at 10x CPU and ends in `overrunBegin`, a different outcome from `fail 600010`, at 25x); runtime rewriting off with the install steps of every non-network group skipped (0/2, 17 steps skipped).
- **Known gaps (listed in the e2e test, each measured):** frames of code compiled by `eval` or `new Function` (native `eval at <anonymous> (URL:L:C), <anonymous>:1:1`, proxied membrane frames and positions of the rewritten text; `sourceURL=` in eval'd text is ignored); the getter frame (`Object.get g [as g]` against `get g`); the `SyntaxError` message of `eval('var =')` lacks the token (`Unexpected token` against `Unexpected token '='`); `Error.captureStackTrace(plainObject)` heads the stack `[object Object]` where Chrome writes `Error`; frames with a `Location`, `Storage` or Proxy receiver lose their type name; `location.toString.call({})`, the `Location.prototype.href` getter and `setTimeout.call({}, …)` do not reject an invalid receiver. A custom `Error.prepareStackTrace` also sees `getFileName()` undefined for frames of inline scripts.
- **Platform trap found on the way:** the service worker forwards the browser's `navigator.languages` as `Accept-Language`, while the native bridge control drops the header, so on this Korean machine the proxied widget document is served in Korean (`translationInit` carries `displayLanguage: "ko-kr"`) and the control's is English. With Chrome forced to `--lang=en-US --accept-lang=en-US,en` the proxied flow passed once in 3 (with the message hook on, in a slow, loaded session) and failed in all 4 runs that followed, so it is not shown to matter. A busy host makes the native control itself fail (`overrunBegin`, 160 s), so a timing-sensitive run needs a quiet machine and an interleaved control.
- **Tests:** the e2e test "stacks of page code and of builtin frames match native, page positions aside" compares 44 probes (plain, nested, thrown, class, timer and promise frames, `JSON.parse`, builtin `toString` family, illegal invocations) and lists 18 known gaps, which must leave the list when they start to match.


## <a id="glassdoor-resolved-2026-10-22"></a>The Glassdoor Turnstile check passes through the proxy: three missing behaviors, found by bisecting the transformation (2026-10-22) {#glassdoor-resolved-2026-10-22}

- **Category:** `real-site / resolution`
- **Result:** the exact-origin lab platform (native Glassdoor page, widget proxied at `https://challenges.cloudflare.com`) passes **6 of 6** (it failed in every run before, with `fail 600010`); the same platform with the widget document served untransformed passed 3 of 3 throughout. **Correction (2026-10-23):** the real-path figure first recorded here, "2 of 6", counted any change of the tab title as a pass; those runs ended on Chrome's `ERR_INVALID_RESPONSE` page (see `form-submission-fidelity-2026-10-23` in sw-integration.md). Measured properly, with a click made when the checkbox is visible, the real path (Glassdoor opened through the launcher, parent and widget both proxied, site-isolated frames, challenge compatibility on) lands on the Glassdoor home page in **8 of 8** runs since the form fixes. An intermediate figure of "about 40%" was the harness clicking before the checkbox existed (see the harness trap in sw-integration.md). There is no remaining difference between the lab platform and the real path.
- **How it was found:** the bisect that had not been possible while Trusted Types were missing. A switch in the service worker serves the widget document as `raw` (untransformed: 3 of 3), as `prelude` (the transformed document with the widget's own script put back, so it runs natively under the installed membrane: 0 of 4) or as `full`; a switch around each install step (`__zpStep`) and around pieces of `installPhase2Membrane` and `installIframeHooks` skips them. Skipping `Phase2Membrane` passed 3 of 3; with it on and the other 18 steps skipped the widget passed; enabling the steps one at a time, with the group that restores brand checks (`SurfaceGuards`) on, failed for `Blockers` (0 of 3) and `IframeHooks` (0 of 4), and each was split further until a single behavior was left. Replicate every cell (6 runs when the first 3 disagree) and keep a control in the interleave: a cell that failed 0 of 3 passed 3 of 3 in another configuration minutes apart.
- **Cause 1, WebRTC:** the widget builds `new RTCPeerConnection({ iceServers: [stun …] })`, `createDataChannel('')`, `createOffer({ offerToReceiveAudio, offerToReceiveVideo })` and `setLocalDescription`, then probes the same methods with a wrong receiver for `Illegal invocation`. Without TURN credentials the membrane replaced `RTCPeerConnection` with a stub whose `createOffer` rejects and `createDataChannel` throws, which no browser does, and the offer (about 3.4 KB of codecs and extensions) never reached the server; that is the "3.4 KB smaller" of an earlier measurement. `makeRTCPeerConnectionConstructor` now keeps the native connection without TURN credentials too, configured with no ICE servers and `iceTransportPolicy: 'relay'`: it gathers no candidate and sends no packet, and the local API works. The page's own servers and policy, also through `setConfiguration`, never reach the engine. The E1 matrix probe and the iframe isolation test ask for a STUN server and every candidate type and count candidates (zero), in the page and in its frames.
- **Cause 2, the target's refusal of eval:** the widget makes a `srcdoc` frame whose `<meta>` policy is `script-src 'nonce-…'` (no `'unsafe-eval'`) and a nonce script that installs an identity `default` Trusted Types policy, then calls `cw.eval`, `(0, cw.eval)` and `new cw.Function` on it. Natively all three throw `EvalError` and the document hears three `securitypolicyviolation` events (`script-src`, blocked URI `eval`, disposition `enforce`); the proxy rewrote every policy to allow eval for the membrane, so all three ran. The membrane now enforces a target policy that refuses string evaluation (`ZP.evalBlockingPolicy`: `script-src`, else `default-src`, without `'unsafe-eval'`): in `eval`, direct and indirect, the `Function` constructors, and a string timer (dropped when it fires), in the page's realm and in the frames it contains. The policy comes from the response header (the proxy's header replaces the target's, so `addCSP` reads the refusing policy first and hands it to the document transform as a property of the response, `__zpEvalRefusal`, as `__zpFetchMeta` is; it was an internal header `X-ZP-Eval-CSP` until 2026-10-23, which a page's `fetch()` of such a document could read back), from every `<meta>` policy (the original the transformer keeps in `data-zp-blocked-content`), and for a frame without a response of its own from its embedder; a `srcdoc` frame boots its own membrane, which cannot read the originals (the natives it captured are its embedder's wrappers), so `injectSrcdoc` puts the policy in the frame's boot config. The error is the engine's, with its exact text (`Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script: <directive>".` and a newline; the Trusted Types wording when the document enforces them) and the event is dispatched after the frame's load when the document is still loading, as the engine's is.
- **Cause 3, a blank frame is not at the embedder's address:** the widget makes `about:blank` frames and reads their `contentWindow` and `contentDocument`; natively such a frame's `location.href`, `document.URL` and `documentURI` are `about:blank` (`about:srcdoc` for a srcdoc frame), its `location.origin` is `null` and its `document.referrer` is the embedder's URL (cut to its origin when the referrer policy says so). The membrane answered with the embedder's virtual URL, a documented contract (ERRATA "An about:blank / srcdoc frame reports its embedder's address"). It was taken out once as unneeded and the lab fell from 4 of 4 to 0 of 4, so it stays: the `Location` facade of an `about:` document answers from the document's own native location (`isAboutLocation` in `07-membrane.js`), and `document.URL`, `documentURI` and `referrer` follow (`09-nav-net.js`); the origin identity that drives storage, cookies and `postMessage` is untouched. The earlier note in ERRATA that the native values "did not change Glassdoor's outcome" was measured with the WebRTC and CSP-eval causes still present; the three are needed together (each alone leaves the widget failing).
- **Two instances share one window:** a frame the membrane contains (its `eval` and `Function` are installed by the embedder's membrane) and the membrane that boots inside that frame are separate instances in one window, and the second captures the first's wrappers as its "natives". The membrane's own evaluations (which carry a Trusted script from its own policy) therefore pass through the page-facing facade and must not be refused: such a script carries the registry symbol `Symbol.for('zeroproxy.ownScript')` (a Trusted script object is extensible, and a registry symbol is read across realms), and building a function with strings runs under a counter. Without that policy (a browser with no Trusted Types) the membrane cannot tell its calls from the page's and enforces nothing.
- **Fidelity defects fixed on the way (each also differs from native on its own):** `HTMLIFrameElement.prototype.src` and `srcdoc` were ordinary functions (a `prototype`, constructible, `new d.get()` throwing `Illegal invocation` instead of "is not a constructor") that threw a WeakMap error for a `null` or primitive receiver and accepted a `div`; they are accessors of an object literal that brand-check first. `AsyncFunction('…').name` (and the other dynamic kinds) read the minifier's name instead of `anonymous`.
- **Cleared on the way (not the cause):** the three install groups and each of `Beacon`, `ProtocolHandlerFacade`, `PopupHooks`, `TargetServiceWorkerBlocker`, `NavigationBackstop`, `NavigationTraps`, `StealthMembrane`, `StorageFacades`, `DOMHooks`, `WorkerHooks`; each of the insertion hooks, the `createElement` hook, the `contentWindow` handle, the child-realm containment and the `sandbox` accessor of `IframeHooks`; the global `eval`, `Function`, timer and event-identity installs; the replacement of `eval('this')` (the widget calls `(0, eval)('this')` 3.8 million times in a no-rewrite run, about 12 µs a call in the membrane against a fraction of that natively, and a fast path made no difference); rewriting itself, the `with` scope and the facade as an execution path; the page language (the service worker forwards the browser's `Accept-Language` while the lab control drops it, so a Korean machine got a Korean widget document: no difference); frame depth, stack positions, the CPU (native passes at 10x and ends in `overrunBegin` at 25x).
- **Known gaps left (not what the widget measures):** a `report-only` policy fires no event for a string it would refuse; the refusal is not made in a worker, for `WebAssembly.compile` or for a string timer of a contained frame; in a `srcdoc` frame that boots its own membrane `Function.prototype.toString.call(cw.eval)` shows the membrane's source (the masking table of the frame's embedder does not know the frame's own function) and `cw.Function.prototype.constructor === cw.Function` is false; a `<meta>` policy's `content` reads with the membrane's additions (`'self' 'unsafe-inline' 'unsafe-eval' …`).
- **Lab platform against the real path (settled 2026-10-23):** the real path passes 8 of 8 with a click made when the checkbox is visible (the lab 12 of 12; the native parent with the widget at its real site-frame host 6 of 6). The earlier "2 of 6", and later "about 40%", were harness artifacts, not a difference between the platforms.
- **Tests:** two e2e tests compare with native ("a policy that refuses string evaluation refuses it here too: header, meta, and a srcdoc frame" with the allowed control, and "a blank or srcdoc frame reports its own URL, and the iframe accessors are built-ins that reject a wrong receiver"), the E1 matrix and the iframe isolation test for the contained `RTCPeerConnection`, and a unit test of `ZP.evalBlockingPolicy`; the assertions that pinned the old blank-frame answer and the surface divergence list (`framesByName`, `windowByName`, `staleBlankEval`, `pendingRouteEval`) were updated to native. A page that leaves a `<meta>` policy refusing eval (an earlier suite does) now refuses `page.waitForFunction` too, as it would natively: the suites after it poll with `evaluate` (`pollPage`).

- **Forbidden invariant found in review (2026-10-23):** whether a `srcdoc` already carries the membrane's prelude (`srcdocHasPrelude`, used by the observer in `16-policy.js`) must be decided by the prelude up to the end of its boot config, which holds this tab's own keys that a page cannot know. A first version tested for the substring `id="__zp-boot"` because the boot config now varies per srcdoc (`extraBoot`); page text can contain that substring, and a page that gets it past the check skips the injection and runs unrewritten markup (containment rule 4).

## <a id="lex-prelude-duplicated-2026-10-23"></a>The top-level declaration prelude was copied into a rewritten first statement (2026-10-23) {#lex-prelude-duplicated-2026-10-23}

- **Symptom:** an inline script such as `history.replaceState(null, '', '/x'); var f;` died with `SyntaxError: Unexpected token ';'` only through the proxy. The rewritten text was `;{const __zp_bad=…}__zp_call(;{const __zp_bad=…}__zp_get(globalThis,"history"),"replaceState",[…])`: the prelude twice, the second inside the helper call.
- **Cause:** `emit_lex_registry` puts a zero-width prelude at the start of the first statement. `apply_patches` rebuilds the receiver, key and arguments of a call or assignment rewrite from the patches inside that sub-range (`rewrite_range`, inclusive at both ends), and when the first statement is such a rewrite its receiver starts at the same byte, so the prelude was applied again inside `__zp_call(` / `__zp_set(`. It needs a script with a top-level `var` or function declaration (otherwise there is no prelude) and a first statement that is rewritten (`history.pushState(…)`, `location.href = …`, `window.x(…)`); `foo.bar(1); var f;` was not affected. A fail-closed rewrite error, but a site whose inline script starts that way did not run at all. **The same mechanism hit the helper bindings of an unbraced `with` body** (`with (o) history.replaceState(1,'','/x');`, `with (o) location.href = '/y';`): they are a zero-width insertion where the body starts, and `const{__zp_get,…}=(function(){return this})();` was printed a second time inside the call, also a SyntaxError.
- **Fix:** the cause is general, so the rule is positional, not by the text of a patch (a first version recognized the prelude by the prefix of its replacement and fixed only that case): `inner_patches` leaves out of a sub-range every zero-width insertion on an edge of the marker patch itself (`q.start == p.start || q.start == p.end`), because the outer pass already prints it next to `p`. Both sub-range builders (`rewrite_range`, `rewrite_range_ov`) call it.
- **Closed by:** `lexical_prelude_appears_once_when_the_first_statement_is_rewritten` and `unbraced_with_body_gets_one_helper_prefix` in `crates/zp-rewriter/src/lib.rs` (both red without the rule, checked 2026-10-23); `cargo test --workspace` and the e2e suite pass. Found while writing the form-submission e2e fixture; not related to the Glassdoor failure.
- **Method:** `.lean-ctx/rewrite-snippet.js` runs the built `zp_bundle_sw` WASM on a file in node (lab only), which shows the rewritten text without a browser.

## <a id="prune-fidelity-2026-10-23"></a>Serving pages unchanged: what the hunt added to look native, and what was taken out again (2026-10-23) {#prune-fidelity-2026-10-23}

- **Category:** `membrane / pruning`
- **Rule applied:** a change the page can see has to protect one of the four containment rules or fix a page that was shown to break (CLAUDE.md "Work Selection Criterion"). Making an API look native (error wording, `name`, descriptor shape, stack text, a proxy string in a serialization) is concealment, a non-goal, and every hook is also a place for a bug (`iframe.setAttribute('srcdoc', html)` below) and a cost on a hot path.
- **Method:** each piece was removed alone, with the tests that only pinned it, and checked with `.lean-ctx/verify-step.sh` (lab only): the full e2e, the real path on Glassdoor (launcher, parent and widget proxied, a click once the checkbox is visible) 6 runs, the exact-origin lab 3 runs, and a real-site smoke of three sites. Baseline before any removal: real path 6/6, lab 3/3. Every step kept 6/6 and 3/3.
- **Removed (one commit each):** stack-text-only code (`8a3d12d`); the HTMLIFrameElement `src`/`srcdoc` accessor reshaping, restoring the pre-`1b8082d` function byte for byte (`53d7424`); the timeline serialization hooks (`4c616c0`); the cross-origin denial sentences, now one `SecurityError` sentence, with the e2e comparing error names and no wording (`1d69158`); the invalid-call guard layer (`bcab7e0`, net -242 lines).
- **Kept on purpose, although they look like fidelity:** `Function.prototype.constructor` as a plain data property (fewer lines, the native shape); the XMLHttpRequest state record (the page sees no `_zp*` own properties); `sendBeacon()` throwing without arguments; the cross-origin denial itself (rule 3); everything that fixed a measured cause of the Glassdoor check or a measured request difference (contained native `RTCPeerConnection`, the target CSP's refusal of eval, `about:` frame addresses, the bare form `Content-Type`, the Referer and Origin of a form); client hints and header order (the proxy re-sends requests, and sending what the browser would send is the unchanged choice); the event `view`/`target` getters (rule 2); site-isolated frames (a widget in its embedder's process fails natively 4 of 4); the persona version.
- **Traps met while pruning:**
  - A smoke harness that runs several sites in one process failed from the second site on with the unchanged build too (45 s timeouts). It was a harness race (a click on a still-disabled Open button), fixed in the harness; see `real-site-compat.md#smoke-order-and-turnstile-demo-2026-10-23`, which also covers MDN, gosuda.org, CNN (pass) and the Turnstile demo (its origin answers 502 natively).
  - `git revert -n` of a commit that mixed a guard layer with a state refactor reverted both; read what a revert takes along (here the XMLHttpRequest record, which makes the page see less of the proxy).
  - The stack sanitizer is not only cosmetics: it turns proxy paths in frames back into target URLs and hides the membrane's own frames, which scripts that read their caller or their own URL from a stack rely on. Remove its formatting, not its URL and frame handling.
- **Reviewed and kept (2026-10-23), with the reason each stays:**
  - `127f09e`: `pageDefined` (a page's own definition of `frameElement`, `parent`, `opener`, … answers; a behavior defect), the own members copied onto bound window methods (`Proxy.revocable` was `undefined`; immer calls it), `postMessage()` without arguments throwing (without it an `undefined` message is really posted, like `sendBeacon()`), no setter on read-only window attributes, the unrenamed native constructors (`__zp_realBC`) and the `webkitRTCPeerConnection` alias. `nameLike`/`lengthLike` stay: they only set `name` and `length` on the membrane's own hook functions and replace no built-in the page can see; removing them makes `fetch.name` read `""`, which is a change.
  - `b776a00`: the policy-gated members and constructors (keyboard map, MIDI, USB, HID, sensors, payment, `getUserMedia`, …) and the per-origin `Notification.permission`. With site frames the browser decides (`browserDecidesPolicy` skips them); without site frames (a non-loopback relay) every frame shares the proxy origin, and these are the only thing that keeps a cross-origin frame without `allow` from a capability granted to that one origin. Containment. The DOMParser XML serialization fix is a real defect. `screen.isExtended` and the WebGL `powerPreference` wrappers were values only and went in `ad29e6f`.
  - The stack sanitizer: URL deproxy and membrane-frame hiding are what error reporters and caller or script-URL detection read; the `eval`-frame normalization of inline scripts is part of the same (the bottom frame must be the script). What is left of it is the routing of `Error.prepareStackTrace` through the membrane (the rewriter patch, `pageStackHook`, the worker twin): it makes the one property read, delete and enumerate as natively. It does not reduce what the page sees, it only adds layers, so it was left; it is the place to look if the rewriter's member list is ever cut.
  - Trusted Types wrappers installed in every document: `ttEnforced()` is dynamic (a `<meta>` policy can appear later), so installing them only when the header enforces would miss that case. No page-visible change; a cost question only.
  - `3f5e63a`: the `pushState` refusal kind and wording. It also stopped accepting URLs with user info, and the error kind (`SecurityError`, not `Error`) is what `catch` code reads.
  - The worker's `userAgentData` shim (it makes a worker agree with the persona the page reports).
- **Worker realm, resource timing and the encoded-size relay (done 2026-10-23, one commit each):**
  - Worker hook shape (`10659af`): the source mask (`Function.prototype.toString` hook), `name`/`length` mirroring and flag normalization went; the move of each hook onto the object that owns the native member stayed. **That move is containment, not shape.** ERRATA 79 said the natives behind the hooks were "contained in practice"; a probe (`.lean-ctx/worker-escape.js`) showed otherwise: without the move, `WorkerGlobalScope.prototype.setTimeout.call(undefined, code)` takes WebIDL's undefined-receiver rule (the realm's global object) and runs `code` unrewritten with the real global as `this` (`this === self` true, `__zp_get` visible). With the move the same call lands on the hook. Rule 4. The `caches`/`indexedDB` accessors on the prototype are the same door for rule 3.
  - Worker key lists (`1bde685`): the three wrappers around `Object.getOwnPropertyNames`, `Reflect.ownKeys`, `Object.getOwnPropertyDescriptors` went (they filtered names, they never denied access: `scope.get` returns the helpers). `hideZPNames` (non-enumerable) stays.
  - Resource timing (`421c90a`): the `PerformanceResourceTiming` value overrides, the infrastructure-entry filter and the `PerformanceObserver` wrapper went in both realms; `name` mapping, `toJSON` name and `getEntriesByName` on mapped names stay (compat). The filter had also hidden that `fallback: 'share'` named every `/zp/` load as the document URL; entries of the proxy's own loads now keep their own name.
  - Encoded-size relay (`339bb32`): the kernel headers and stream table, the Service Worker wrapping, size maps and query, the page store; see the two history entries it is noted on.
  - Frame realm shape (`af4ec90`): `sameRealmAs`/`realmInstallFP` (the [[Prototype]] of functions put into a frame), `realmCopyOf` (a frame's own XMLHttpRequest, WebSocket, EventSource constructors) and the frame's key-list wrappers went. Kept from `48fd45c`: the frame's own `eval`/`Function`/`globalThis` (code must not run in the parent's realm) and the membrane's internal DOM scans on captured natives (a page that wraps `querySelectorAll` to return nothing could hide frames and scripts from the sweep; rules 1 and 4).
  - Lab trap: a Chrome window that is covered gets `visibilityState` hidden, `requestAnimationFrame` stops, and a puppeteer `waitForSelector` (raf polling) called before the page is ready never returns; the lab scripts now start Chrome with `--disable-features=CalculateNativeWinOcclusion` and the background-throttling switches.
- **Bug found on the way, fixed in `ec4b067` (not caused by the pruning):** `iframe.setAttribute('srcdoc', '<p>hello</p>')` gave a frame whose document was the text `http://<proxy>/zp/api/fetch...` instead of the markup. `iframe:srcdoc` is on the URL surface list (the parser path stashes the author's markup through it and `cloneNode` reads that stash back), so `setAttribute` resolved the markup as a URL before it reached the srcdoc branch. The srcdoc branch now runs first. Pin: e2e `frames made from markup load and read back as natively` (`setAttribute.srcdoc.*`). Do not take `srcdoc` off the list to fix this: the literal stash `18-iframes.js` reads for cloned frames comes from it.

## <a id="site-frame-route-loop-2026-10-24"></a>The observer routed the address it had just written, and CNN's renderer died of it (2026-10-24) {#site-frame-route-loop-2026-10-24}

- **Category:** `membrane / frames`
- **Symptom:** through the proxy, CNN loaded (the title shows after 3 s, 3981 elements as natively) and 10 to 30 s later its renderer ran at 100% CPU with 1.8 to 7 GB of memory and answered nothing, with site frames on or off. Present long before the 2026-10-23 cleanup (the assets of `6a32c80` wedge 7 runs of 8). The smoke harness looked at the title only, so it never saw it; the earlier "CNN times out at baseline" was this.
- **Cause (measured):** the argument of the share-URL function (`ZP.encryptShareURL`) grew 1.33 times per call (7.9, 10.5, 14.0, 18.7 MB): a loop, not a busy page. A frame routed to a site host gets `src = http://s-<site>-<hash>.localhost:PORT/zp/p/<token>`. The MutationObserver that `installBaseObserver` puts on the document of a contained child frame (the blank frame an ad container builds its creative in) saw that write, found the address did not start with `proxyOrigin`, took it for the page's own URL and called `routeFrameSrc(el, 'src', address, false)`: a new token, the site label derived from the previous one (`s-s-s-...`), a new write, and again. Only a frame that stays connected and sits in such a child document does it (CNN's Dianomi widget); the top document has no such observer.
- **Fix:** `enforceObservedAttribute` leaves a frame's `src` alone when it is the address of a frame we routed: a share path on a host `ZP.isSiteFrameOrigin(mainProxyOrigin, origin)` recognises (`isSiteFrameAddress` in `18-iframes.js`; the predicate sits next to `siteFrameOrigin` in `zp-core.js`). The proxy-origin form was already skipped (`startsWith(proxyOrigin)`).
- **Pins:** e2e `a frame of another site made inside a blank child frame is routed once and is not wrapped again` (fixture `/xnested`): the pre-fix build wedges, and it also starved the three tests after it. The frame's visible address may legitimately be replaced once by its own document (new token of the same length, a fragment added), so the test asserts the loop's signature: one routed frame, no `s-s-` host, the token's length not growing. The smoke harness now asks each page to answer 18 s after the title (`ZP_SETTLE_MS`), which fails the pre-fix build on CNN.
- **Tools (lab, `.lean-ctx/`):** `cnn-eval.js` (evaluate every few seconds with the CPU and memory of the busiest Chrome processes), `cnn-pause.js` (`Debugger.pause` sampling of a wedged page, works while JS runs), `cnn-zcalls.js` and `cnn-ca.js` (breakpoints that record arguments and callers and resume), `frame-loop-repro.js`, `nested-repeat.js`.
- **Lesson:** a title that matched says nothing about a page that dies afterwards; probe that the page still answers. `Runtime.evaluate` starves on a busy page, `Debugger.pause` does not.

## <a id="with-scope-exploration-2026-10-24"></a>The with-scope: a lookup costs 340 ns, pages hardly notice, and the same design leaves four real gaps (2026-10-24) {#with-scope-exploration-2026-10-24}

- **Category:** `membrane / lexical scope` (exploration; no code changed)
- **The design:** an inline classic script runs through an indirect `eval` inside `with(__zp_lex_scope){…}`, because an `eval` discards its top-level `let`/`const`/`class` when it returns. The rewriter registers those names (`__zp_lex_decl`, `__zp_lex_bind` with get/set closures into the script's own bindings) in `zpLex`; the with-object is a Proxy whose `has` claims registry names and named child frames. A strict script cannot sit in a `with`, so it runs as a plain strict `eval`. External scripts are real scripts: no `with`, native speed.
- **Cost, measured (Chrome 155, 200 000 iterations, `.lean-ctx/with-cost.js`):** only free identifiers are slow. Locals 1.0x; `Math.floor` per iteration 333x; `document.body` 30x; about 340 ns per free-identifier lookup, in an inline script and in every function it defines. An external script is 1.0x. Where it goes (V8 alone, `with-floor.js`): `with({})` costs 600 ns against 7 ns for no `with` (85x: V8 does not cache lookups through a with-object); the Proxy doubles that; our `has` body (Map lookup, then `Reflect.getOwnPropertyDescriptor(root, name)`, which allocates) triples it. Trimming the body gains at most 1.6 to 3x. Native speed only comes from not having a `with`.
- **Exposure, measured:** trap calls per page load on 21 sites (`with-count.js`, a counting lab build): CNN 21 524, NYT 4 729, IMDb 10 974, Twitch 24 771, Amazon 653 669 (about 0.22 s), everything else under 3 000 (under 1 ms). Registry reads (`get`) were 0 on all 21. Inline code is rarely hot; the cost shows only in inline-resident VMs (every Turnstile widget; ERRATA residual "challenge VM phases 3-4x slower"), which is measured and not the cause of the Glassdoor verdict.
- **The four gaps (`lex-semantics.js`, the same page native and proxied; only these readings differ):**
  1. **Strict inline scripts lose their top-level `var` and function declarations (fixed the same day, see [strict-var-export-2026-10-24](#strict-var-export-2026-10-24)).** A strict `eval` keeps them to itself, so a later script (inline or external), or an `onclick`, finds them undefined. Real: **Bing**: all 7 of its executed inline classic scripts (of 17 inline `<script>` elements; the rest are JSON and templates) are strict (`//<![CDATA[` then `"use strict";`) and declare `var _d`, `sj_b`, `sj_log`, `function sj_pt`…; script 2 reads `_d` of script 1, and the proxied page throws `_d is not defined` (BBC has one such script).
  2. **External scripts do not see inline `const`/`let`/`class`** (undefined; they are not in the global lexical environment, only in the registry that only the with-scope reads).
  3. **Event-handler attributes** (`onclick="…"`) do not see them either, nor strict-declared vars.
  4. **A free identifier that names an iframe:** inline scripts get the membrane's handle (`=== iframe.contentWindow`), external scripts the browser's real WindowProxy of a cross-origin site frame (a compat gap for `postMessage` origin mapping, not an escape: the browser's own cross-origin rules hold).
  Same as native: inline to inline and a name declared later (the TDZ is kept), `window.X`, `'X' in window`, `globalThis.X`, `this.X`, `(0,eval)`, `new Function`.
- **Prototypes (lab builds, not committed):** (a) exposing each registered name as an accessor on the real global (`configurable`, not enumerable, getter and setter call the registry closures, so TDZ and `const` stay exact) fixes gap 2 (the external script reads the value) and, with the facade left alone, leaks `window.X`; keeping `window.X` undefined means filtering seven traps of the `scope` facade (`has`, `get`, `getOwnPropertyDescriptor`, `ownKeys`, `set`, `defineProperty`, `deleteProperty`); names that already exist on the global (`name`, `status`, `event`…) cannot take an accessor. (b) Exporting a strict script's top-level var/function names (the list `__zp_lex_decl` already receives) as accessors onto the global fixes gap 1: the strict reading matches native and Bing's `_d is not defined` is gone. Real files: the runtime patch used a regex on the rewritten text; the right place is `emit_lex_registry` (it has the AST and `has_use_strict`).
- **Not the with-scope (found on the way, not investigated):** Bing still renders 266 elements against 462 native with both prototypes in (no right-hand header, no Image Creator; its own getter reads `performance` of an undefined `_w`); Yahoo renders 1 212 elements and 6 frames against 2 888 and 44 native with no page error, and the same with the accessor prototype; Google shows one `_._DumpException is not a function`.
- **Options, in the order I would take them:** (1) fix gap 1 in the rewriter, small and pinned by the strict readings of `lex-semantics.js`; (2) gaps 2 and 3 with the global accessors plus the facade filter, if a site shows it (none of the 21 does); (3) leave the cost alone, or trim `has`; (4) the only way to native speed and exact semantics for static inline scripts is to serve them as same-origin scripts the Service Worker answers from memory (the HTML would carry `<script src=/zp/api/inline…>` with the original text as the element's body): real global lexical scope, no `with`, no registry for them, `currentScript` real; costs a worker round trip per script, a store that must outlive the document stream, hiding `src` from the page, and runtime-created scripts keep the eval path. A hash-based CSP cannot do it (the headers go out before the streamed body is rewritten) and a nonce would be readable by the page.

## <a id="strict-var-export-2026-10-24"></a>A strict inline script's `var` and function declarations stayed inside its `eval`; they are now handed to the global (2026-10-24) {#strict-var-export-2026-10-24}

- **Category:** `rewriter / lexical scope` (fixes gap 1 of [the with-scope exploration](#with-scope-exploration-2026-10-24))
- **Symptom:** a script starting with `"use strict"` cannot sit in the `with(__zp_lex_scope)` wrapper, so it runs as a plain strict `eval`, and a strict `eval` keeps its top-level `var`/function declarations to itself. A later inline script, an external script or an `onclick` found them undefined. Bing: all 7 of its executed inline classic scripts are strict; the proxied page threw `_d is not defined` 2x and `_w is not defined` 4x (native 2x).
- **Fix:** `emit_lex_registry` (crates/zp-rewriter/src/lib.rs) appends `__zp_export_vars([names],[()=>n],[__zp_v=>{n=__zp_v}],replace)` after the conflict check, only for a script that is strict (`!cur_sloppy`) and not a module. The helper (membrane `07-membrane.js`, child realms `20-containment.js`, workers `worker-prelude.js`; also in `ZP_WITH_HELPERS` in all three places that must equal the Rust list) defines each name on the realm's global as a configurable, enumerable accessor whose getter and setter close over the script's own binding, so reads, writes, `window.X`, `'X' in window` and `Object.keys(window)` match native and every script shares the one binding. Functions are exported separately with `replace=true`: a later strict script's `function f(){}` replaces an earlier export of the same name, as natively. Names in `DANGEROUS_GLOBALS` (`location`, `window`, `document`, `history`, `top`, `parent`, `opener`, `frames`…) are never exported, modules are not touched (only `ScriptKind::Classic` reaches `emit_lex_registry`), and a script with only `let`/`const`/`class` exports nothing.
- **Containment:** the closures are the script's own and reach nothing of the proxy; nothing is exposed that the script did not declare. Names the page already has as own properties of the global (`name`, `onload`, an earlier plain property) are skipped, never overwritten, unless the earlier definition was one of these exports and the new one is a function.
- **Known limits (documented, not fixed):** (1) a name two strict scripts both declare with `var` is not one binding: the first export wins, the second script keeps its local; (2) the idiom `var x = x || []` at the top of a strict script reads its own hoisted local (undefined), where native reads the global, so two strict scripts that share a namespace this way each start fresh; (3) the descriptor is an accessor (`configurable: true`), native is a data property (`configurable: false`); `delete window.X` succeeds here and fails natively. Hiding the descriptor shape is not a goal and the shape is not extended. Gaps 2 to 4 (inline `const`/`let`/`class` unseen by external scripts and handlers; a free identifier that names a cross-origin iframe) are unchanged.
- **Closed by:** test/e2e/proxy.test.js `a strict inline script's var and function declarations are global, as natively` (fixture `/xstrict`: two strict inline scripts, a sloppy reader, an external script and an `onclick`; proxied deep-equals native; with the helper disabled the inline reader sees `undef` and the external script and handler read a stale value); crates/zp-rewriter/tests/matrix.rs `strict_classic_exports_toplevel_var_and_function` (emission order, functions vs vars, Bing's shape, sloppy/module/unforgeable/lexical-only negatives); test/js/rewriter.test.js harness extended with the helper.
- **Verification (2026-10-24, headless Chrome from the repo's puppeteer):** `lex-semantics.js` native vs proxied: `stVar` and `stFn` now read the same in external scripts and handlers (only the lexical readings still differ: gaps 2 and 3). Bing `page-errors.js`: `_d is not defined` 2 -> 0, `_w` 4 -> 1, elements 265 -> 270 (native 461; the rest is the separate, uninvestigated Bing difference).

## <a id="yahoo-preload-hint-2026-10-24"></a>Yahoo never finished hydrating: a stylesheet preload the page made at runtime was stripped, and React waited on its events (2026-10-24) {#yahoo-preload-hint-2026-10-24}

- **Category:** `membrane / link policy` (real-site compatibility: the Yahoo home page)
- **Symptom:** through the proxy the page showed its server HTML and then stopped: 1 226 elements against 2 958 natively, 6 iframes against 44, 38 images against 203, no header menu, no widget row, no feed. No page error, an idle main thread, a healthy Scheduler channel (552 messages posted, 552 delivered). `document.__reactContainer$….stateNode` showed it: the root had **committed nothing** (`current` the bare HostRoot, 1 fiber; native 5 655 fibers, 50 Suspense boundaries), `suspendedLanes` 128 (the transition hydration lane), no scheduled callback. The five `React.lazy` loaders the page had started were all resolved, so React was not waiting on a promise it tracked.
- **How it was found (lab tools in the ignored `.lean-ctx/`, nothing committed):** (1) a bisect over the 22 named install steps of the prelude: skipping only `DOMHooks` lets the root commit; (2) the prelude reassembled from `web/` in a lab (byte-identical to the shipped build, checked) and a statement-level bisect inside `installDOMHooks`: only the `Element.prototype.setAttribute` hook; (3) bypassing branches of that hook: only `link` with `rel` **and** `href` together; (4) a census of `<link>` elements: the proxied page held 20 `<link as="style">` with **no `rel` and no `href`**, natively none.
- **Root cause, two steps:** (a) React 19 adopts a server-rendered stylesheet by `querySelector('link[rel="stylesheet"][href="…"]')` built from the page-visible URL. Through the proxy the real `href` attribute is the proxy path (`/zp/api/fetch?url=…`) while `getAttribute` returns the original URL, so the selector found **0 of 10** (native 11 of 11). (b) React therefore made its own `<link rel="preload" as="style">` for each stylesheet and holds its first commit until that link's `load` or `error` marks the resource settled. The membrane stripped `rel` and `href` from every runtime-created `preload` (`isBlockedLinkRelValue`, in place since the first policy commit f46d5ed; the hole-matrix note called it a precaution against a direct request), so no event ever fired. The asymmetry was already known and left open: static `preload` links were routed by `htmltx`, runtime ones swallowed ([2026-08-21 entry](#2026-08-21-link-rel-server-missing)).
- **Fix:** `preload` is no longer in `isBlockedLinkRelValue` (web/membrane/13-attrs.js). A runtime preload link takes the generic URL-bearing path of the `setAttribute` hook and the `href`/`rel` property hooks, which gives it the shape a static one has (`href` = `/zp/api/fetch?url=…`, `data-zp-lit-href`, `data-zp-target-url`), so it loads through the service worker and fires `load` or `error`. Still stripped, as before: `prefetch`, `modulepreload` (the static path sends it to the module route `/zp/api/script?…&kind=module`, which the generic path does not), `preconnect`, `dns-prefetch`, `prerender`, `manifest`.
- **Containment:** unchanged. A preload link depends on the same `href` rewriting every `rel=stylesheet` link already depends on; a raw `href` on a link would leak under either `rel`. Hole matrix (`test/browser/hole-matrix`, `--enforce-csp`, recorded network): `b8-preload-link` is `O O ok` (bytes arrive, no direct attempt), the new `b8b-prefetch-link` stays `O X ok` (declared blocked); no direct leak, nothing caught only by CSP, preconnect sockets to the target 0/0 through the proxy (control 1/1). `c7-worker` and `c8-worker-cross` are reported stale in `EXPECT_BLOCKED` and were before this change (they load through the proxy); not touched here.
- **Measured (25 s after open, same headless Chrome):** root fibers 1 -> 3 801 (native 5 630), pending lanes 0; elements 1 226 -> 2 144 (native 2 958); iframes 6 -> 43 (44); same-site fetch/XHR endpoints 7 -> 28 (native 15); scripts added natively and never through the proxy 37 -> 5. The header (Sign in), widget row, Trending list and carousel match natively in a screenshot.
- **Not fixed (found on the way):** (1) an attribute selector on a URL-bearing attribute (`link[href="/a.css"]`, `[src^="…"]`) does not match the page-visible value through the proxy, so React still duplicates every server-rendered stylesheet; the same would hold for CSS attribute selectors such as `a[href^="http"]` (not measured). Rewriting selectors is only possible for `=`; recorded in ERRATA. (2) Yahoo still differs: the header menus (`#module-uh` 88 against 579 elements), the second half of the feed (`#strm` 462 against 893), the Taboola widgets, `InContextLoginController` loaded where natively `MoreMenuDropDown` is, beacon-style requests (`udc.yahoo.com`, `guce…/consentRecord`) reported aborted, and one ad iframe that shows the ZeroProxy launcher page. Separate defects, uninvestigated.
- **Closed by:** test/e2e/proxy.test.js `a preload link a page makes at runtime loads through the proxy and fires its events, as natively` (fixture `/xpreload`: a stylesheet preload awaited by its events, the loadCSS idiom that switches `rel` in `onload`, and the `rel`-last `setAttribute` order; proxied deep-equals native and every request reaches the target through the proxy; with the previous prelude it times out); hole matrix cases `b8-preload-link`, `b8b-prefetch-link`.

## <a id="yahoo-second-pass-2026-10-25"></a>The Yahoo home, second pass: the native baseline was a bot, and four more membrane defects (2026-10-25) {#yahoo-second-pass-2026-10-25}

- **Category:** `membrane / real-site compatibility` (follows [yahoo-preload-hint-2026-10-24](#yahoo-preload-hint-2026-10-24))
- **The baseline was wrong first.** The native runs of the first pass were headless Chrome. Yahoo's `ViewportMount` renders its children at once when the request context says `bot` (`children` if `bot || inView`) and the server sets that from the `HeadlessChrome` User-Agent; the proxy sends the browser persona and gets the human page (modules mounted when scrolled to). With the native page given the same UA minus `Headless` the feed is **identical**: 15 stories, 45 images, 5 462 px at load in both (59 stories and 9 901 px for the bot page), 46 against 48 stories and 12 239 px after scrolling. Every "native has more" figure of the first pass that came from the feed, the header menus or the video modules was this, not the proxy. The lab scripts (`.lean-ctx/feed-scroll.js`, `dom-diff.js`, `dom-diff2.js`) now set the native UA that way; use it for any site that serves bots differently.
- **Defect 1, the Navigation API facade recursed.** `addNavListener` (web/membrane/07-membrane.js) built the wrapper `w` that calls the page's `listener` and then did `listener = w`, so the wrapper called itself until `Maximum call stack size exceeded` on every event a page listener received (Yahoo: 2 page errors). Fixed with a separate variable; no test had touched it. Known and not fixed (ERRATA): the membrane's own address refresh adds one more `navigate` event (a replace to the current URL), and a `location.hash` assignment while the document loads reads `push` where it reads `replace` natively.
- **Defect 2, `localStorage`/`sessionStorage` did not inherit.** The facade's Proxy answered every name except the six members with a stored-key lookup, so `localStorage.hasOwnProperty`, `toString`, `valueOf`, `constructor`, `__proto__` were `undefined`, `String(localStorage)` threw, `constructor === Storage` was false. Taboola's `TBOptimization` calls `localStorage.hasOwnProperty(key)` (`this.zc = window.localStorage`; `for (c in zc) if (zc.hasOwnProperty(c) …)`) and threw `pmglb.g.bb.zc.hasOwnProperty is not a function`. Fixed in `prefixedStorage` (web/membrane/12-storage.js) with WebIDL's named-property visibility: a name the prototype chain has (`p in target`) is the chain's, whatever is stored; `has`, `deleteProperty`, `getOwnPropertyDescriptor`, `ownKeys` follow; `getPrototypeOf` reports `Storage.prototype`; the members are enumerable in native order (`length, clear, getItem, key, removeItem, setItem`), so `for…in` matches. Not fixed: key order (`a,b` natively, `b,a` here: Chrome lists the real, prefixed keys in its own hash order).
- **Defect 3, protocol-relative URLs in runtime CSS never reached the proxy.** `cssProxyURL` (web/membrane/15-scripts-css.js) mapped only `http(s)://` URLs and left the rest to the service worker, which maps path-relative URLs back through the proxy origin. `//host/a.css` resolves to *another* origin (`http:`, the proxy's real scheme), so it left for the network and only the CSP stopped it; Taboola's `<style>@import url('//cdn.taboola.com/…')</style>` (4 stylesheets and an image) was the visible case. Measured with a local target over 9 routes (`textContent` before/after insertion, text node appended before/after, `innerHTML`, `insertRule`, `replaceSync`, element style property, `style` attribute) plus `@import`: absolute and root-relative URLs loaded through the proxy in all of them, **protocol-relative in none**. Fixed: `cssProxyURL` resolves a `//` URL against the target base (`targetURLIfHTTP`) first, as `zp-css` already does for a static stylesheet. CSP console messages on Yahoo 31 -> 10; the rest are ad frames' own meta CSP refusing `data:`/`blob:` images.
- **Defect 4 (found by the new test, older than it): a style filled through the tree was rewritten too late.** `appendChild(createTextNode(css))`, `insertBefore`, `append(…)` into a `<style>` were rewritten only by the `MutationObserver`. The browser parses the CSS as it goes in and fetches its `url()`s at the next style recalculation, which a layout read (`getComputedStyle`, `offsetHeight`) brings forward of the observer: with one forced recalculation **every** text-node route made a direct request for absolute and protocol-relative URLs alike (CSP stopped them: "missed by the rewriter, blocked only by CSP"). The full e2e run caught it as `all browser and worker network stays on the proxy origin`. Fixed in `patchInsertion` (web/membrane/18-iframes.js, which already wraps every insertion method): `rewriteStyleTextForInsertion` (web/membrane/16-policy.js) rewrites the text before it goes in, in place on the page's own text node (so `removeChild(node)` in styled-components finds it, and a sheet built rule by rule is not re-read each time), and the text of a style element or fragment passed as an argument. The observer stays as the backstop for `text.data = …` and `appendData`. Not hidden: the page reads `textNode.data` back rewritten, and `style.textContent` back with the proxy's URLs turned back to the original but the rewriter's quoting (`url("…")` for `url(…)`).
- **Looked at and not defects (so nobody re-chases them):** the "Could not reach target" pages in ad frames are unreachable natively too (`match.rundsp.com`, `j.mrpdata.net` NXDOMAIN, `visitor.omnitagjs.com` reset, `ads.yieldmo.com` timeout from this machine) except Rubicon: `token.rubiconproject.com` is TLS 1.2 with CBC and static-RSA suites only (with only ECDHE-GCM it hangs), `pixel.rubiconproject.com` is a pool with some members like that, and rustls implements neither, so a handshake that selects one of the advertised decoy suites fails as `SelectedUnofferedCipherSuite` (ERRATA). `ERR_ABORTED` on `udc.yahoo.com`, `noa.yahoo.com`, `geo.yahoo.com` is a beacon whose envelope response body is dropped after the head. `…/zp/` launcher pages inside an ad slot appeared in two of the first loads and in none of about 20 later ones; undiagnosed. The service-worker diag endpoint answers `POLICY_BLOCKED` on site-frame origins; read a worker's `refusalLog` and `__zpRustTrace` over CDP (`.lean-ctx/sw-errors.js`).
- **Measured after (headless Chrome, native with the matching UA):** page errors 2 -> 0; feed identical; 16 of about 130 container kinds differ, all of them which ads the auction served and comment counts; Taboola's `trc_wrapper`/`outer`/`internal_trc` containers no longer differ, and its `hasOwnProperty` TypeError is gone from the thrown-error list (final build, 15 s of thrown errors captured with the debugger).
- **Closed by:** test/e2e/proxy.test.js `a protocol-relative URL in CSS the page makes at runtime loads through the proxy, as natively` (11 routes and `@import`, a layout read after each, direct wire attempts asserted empty; without the fixes it fails naming the routes), `Navigation API listeners a page adds run and see its navigations (the wrapper no longer recurses)`, `localStorage and sessionStorage inherit from Object.prototype and Storage.prototype, as natively`; hole matrix `d8-style-textnode`, `d9-style-textnode-cross` (`O O ok`, no direct leak, nothing caught only by CSP).

## <a id="bing-strict-redeclare-and-blob-modules-2026-10-25"></a>Bing: a redeclared strict var, a real script's own var, and blob modules that ran as written (2026-10-25) {#bing-strict-redeclare-and-blob-modules-2026-10-25}

- **Category:** `rewriter / lexical`, `membrane / script policy`, `containment` (follows [strict-var-export-2026-10-24](#strict-var-export-2026-10-24))
- **Symptom:** Bing rendered 262 elements against 470 native (the fair baseline: the same headless Chrome with `Headless` removed from the User-Agent changes nothing here, unlike Yahoo), with no right-hand header, no widgets, `Cannot read properties of undefined (reading 'performance')` and a refused script (`/zp/error/POLICY_BLOCKED`). After the three fixes below: 472 against 469, 134 container kinds each, the same single page error (`_w is not defined`, natively too).
- **Cause 1, a strict script redeclared a var an earlier one had made.** Bing's inline script 7 is `"use strict"; var _w=window,…`, script 9 is `"use strict"; var perf;…(function(){… _w[s] …})();…var _w = _w || {};`. Natively that is one global binding. Through `eval` each strict script has its own, and `__zp_export_vars` (D1) skipped a name the global already had, so script 9 read its own `_w`, hoisted and `undefined`, ahead of that line. Fixed in `exportStrictVars` (web/membrane/07-membrane.js; the child-frame copy in 20-containment.js calls it, web/worker-prelude.js has its own): a later script's copy starts from the value the global has (`var x;` changes nothing, `var _w = _w || {}` keeps the earlier `_w`), a write through the global reaches every script's copy (the accessors chain their setters), a function declaration replaces the value and the earlier scripts' copies take the new function, and a configurable data property the page made is taken over the same way. A native accessor or a non-configurable property stays alone as before. **Not kept in step** (ERRATA): an assignment made by an *earlier* script's own code after a later script redeclared the name reaches only its own copy.
- **Cause 2, a real script exporting itself into recursion (found by the first fix).** An external script is not run through `eval`; its `var __assign` is the global's own property. The helper then made an accessor whose getter was `()=>__assign`, which reads the accessor: `Maximum call stack size exceeded` in every `__assign(…)` call (Bing's tslib header, four errors). Before the first fix this was hidden because the name already existed, so the helper skipped it. The helper now writes a probe object through the script's setter and reads the global back: if the probe shows up there, the closures are the global's own and the name is left alone. Without the probe the unit test never finishes.
- **Cause 3, a blob script was refused, so es-module-shims took the browser for one without modules.** Bing loads `es-module-shims`, which feature-detects with `<script type=module src=blob:…>` (`import*as m from'blob:inner';self._esmsi=m`, inner `export default u=>import(u)`). The membrane refused every `<script src=blob:>` (`hasContextBlockedScheme`), the detection failed and the Peregrine widget (`widget-initializer.js` through an import map) never started. Now `blockExecutableURL` first calls `routeBlobScript` (web/membrane/03-urls.js): it reads the blob with a same-origin synchronous request (as `import(blob:)` already did), rewrites it for the element's kind, and points the element at a copy of the result; `src` still reads back as the page's blob, the copy is remembered per element so the observer and insertion do not make another, and anything unreadable or unrewritable stays blocked. A copy of ours is the one blob a script may load (`rewrittenScriptBlobs`).
- **A containment gap found on the way (older than all of this):** a rewritten module that *statically* imports a `blob:` or `data:` URL loaded that module as it was written, because `rewrite_module_specifier` skipped both schemes ("the service worker cannot proxy them"). Measured before the fix (a fixture served by the target, so its code is rewritten page code, run against a build with the previous rewriter and the same runtime): a module that statically imported an inner blob made the inner source read `location.href` as the proxy's own address (`http://proxy.localhost:…/zp/p/…`) where native reads the page's; it ran with the real globals, and only the CSP stood between it and the network. (An earlier probe evaluated through the debugger protocol showed the same, but that code is not rewritten, so it proved nothing and is not the measurement.) Rule 4 (unrewritten code never executes) was open for any page that builds two blobs. Fixed by making the rewriter leave no such specifier: it writes `'zp-import:<percent-encoded original>'`, a scheme that cannot load, and the page's rewriter (`rewriteCore`, kind `module`) swaps it for a rewritten copy through `virtualModuleURL`, the function `import('blob:…')` already used, to a depth of 8 (a cycle ends with the placeholder in place, which fails closed). Anywhere else (the service worker rewriting a server module, a worker) the placeholder stays and the import fails to load.
- **Decision recorded:** the E1 matrix row `scriptBlobSrc` said "`<script src=blob:…>` must not execute". The property it protects is rule 4, not the refusal; a blob script now runs only as a rewritten copy, and the row asserts exactly that (`ran-rewritten`: the blob reads `location.href` and must see the page's address, not the proxy's, which contains `/zp/`). `staticBlobImport` is the new row for the gap above.
- **Not defects / left:** the `idtokenv2` frame (`/identity/idtokenv2`) answers an empty body and the service worker returns `MALFORMED_HTML` 502 for an empty transform output. The page matches native with it still in place; not investigated. Bing's remaining page error is native.
- **Closed by:** test/js/rewriter.test.js `strict scripts that redeclare a global var share one binding with the script that made it` (includes the real-script case), `a strict script takes over a configurable data property of the global and leaves a fixed one alone`; crates/zp-rewriter `static_data_and_blob_imports_become_placeholders_that_cannot_load`; test/e2e/proxy.test.js `a strict inline script's var and function declarations are global, as natively` (third script redeclares `sObj`/`sVar`), `code a page builds in blobs runs rewritten, including what a blob module imports, as natively` (dynamic import of a module that imports a blob, a data: import, a blob module script made the es-module-shims way, a blob classic script, and a computed `import()` inside a blob module), E1 rows `scriptBlobSrc` and `staticBlobImport`.

## <a id="javascript-urls-2026-10-25"></a>`javascript:` links and forms never ran, and the first fix would have run forged code as written (2026-10-25) {#javascript-urls-2026-10-25}

- **Category:** `membrane / navigation`, `containment` (found while checking Bing's links, a generic defect)
- **Symptom:** `<a href="javascript:f()">` and `<form action="javascript:f()">` did nothing when clicked or submitted, in the server's HTML and when made at runtime (`setAttribute`, `.href =`, `innerHTML`); natively they run `f()`. A link made by markup with `href="javascript:void(0)"` also swallowed the click: neither its own `onclick` nor a document-level listener saw it.
- **Cause 1, dead handlers.** The delegated click and submit handlers (web/membrane/09-nav-net.js) looked for `data-zp-jsurl` with the page-facing `getAttribute`/`hasAttribute`, which answer `null`/`false` for every `data-zp-*` name, so they never found it. No end-to-end test checked that a `javascript:` link runs (the E1 matrix checks that nothing escapes through one; the HTML transformer has unit tests).
- **Cause 2, an out-of-scope call hidden by a `try`.** The runtime path (`blockExecutableURL`, 03-urls.js), `location = 'javascript:…'` (04-navigation.js) and `open('javascript:…')` (09-nav-net.js) called `callPageRewriter` and `execGlobalScript`, which are declared inside `installPhase2Membrane`. From those files they are a `ReferenceError`, caught by the `try`; measured for the link path, where the link fell through to the generic block (`href="#"`), the other two have the same shape and were not measured before the change. Code outside the install function reaches the rewriter only through the hook table `pageRewriteHooks` (`rewrite`, `decodeEntities`, `exportStrictVars`, `runClassic`).
- **Cause 3, every executable-scheme link was a navigation.** `clickNavigationTarget` returns `{ href: '' }` for such an `href`, and the capture-phase handler then calls `preventDefault` and `stopImmediatePropagation`, so the page's handlers on the link never ran.
- **A containment hazard in the first fix (measured, then removed).** The first version made the handler read the *rewritten code* from `data-zp-jsurl` and run it with the prelude's private `Function`. Any author or script can write that attribute: a `data-zp-jsurl="window.__forged = location.href"` in the page's markup ran as written and read the proxy's real address. The handler now never takes code from an attribute. It takes the URL from the record the membrane made (`javascriptURLs`), from the author's literal the HTML transformer keeps in `data-zp-lit-*` (now written for `javascript:` too), or from the no-op `javascript:void(0)` itself, and rewrites it at the moment it runs (`pageRewriteHooks.runClassic`, kind `classic`). An attribute the page writes can at most make the page run its own code, rewritten, which it could do anyway. The `data-zp-jsurl` code the transformer still emits is not read.
- **Semantics kept from the platform:** the URL is the link's or form's default action. It runs in a task after the event has been dispatched (`setTimeout 0`), not when a listener cancelled the event, and nothing is stopped, so the link's own `onclick` and document listeners run first and in their usual order. A click on a button inside a form belongs to the form's submit event, so the click handler only looks at anchors. The observer leaves the no-op alone (processing it again replaced the recorded URL with `void(0)`). The `href`/`action` read-back is the original.
- **Found while writing the fixture, not changed:** `decodeInlineEntities` decodes `&quot;` and other entities inside an inline script's text (a deliberate help for markup pasted into scripts); a script string containing `&quot;` therefore differs from native. The fixture avoids it.
- **Closed by:** test/e2e/proxy.test.js `javascript: links and forms run as the default action of a click, in the markup and made at runtime, as natively` (static link and form, a `void(0)` link with `onclick`, a cancelled click, `innerHTML`, `setAttribute`, `.href =`, and three forged `data-zp-jsurl` forms: in the markup, through `innerHTML`, through `dataset`/`setAttributeNode`; proxied equals native for the event order, the read-back of `href` and `action`, and that nothing forged ran; the forged case ran as written before the final design), E1 row `forgedJavascriptURL`, crates/zp-htmltx `javascript_url_anchor_routed` (the literal is kept).

## <a id="hook-configurable-2026-10-26"></a>Google: a page could not wrap `setInterval` because every hook was non-configurable (2026-10-26) {#hook-configurable-2026-10-26}

- **Category:** `membrane / descriptors` (found on Google's home page, generic)
- **Symptom:** Google rendered 429 elements against 530 natively (the consent and terms dialogs missing) with one page error, `_._DumpException is not a function`. The thrown errors of the load, natively against proxied: `TypeError: 'defineProperty' on proxy: trap returned falsish for property 'setInterval'`, thrown by a function of Google's own bundle, and the `_DumpException` error after it (its handler module had not loaded).
- **Cause:** `define()` (web/membrane/02-masking.js) installed every hook with `configurable: false`, "so page scripts cannot delete membrane hooks to uncover native accessors". `Object.getOwnPropertyDescriptor` over `window` and 26 prototypes and constructors, natively against proxied, differed in 146 own properties: `setTimeout`, `setInterval`, `fetch`, `eval`, `Function`, `XMLHttpRequest`, `Element.prototype.setAttribute`, `EventTarget.prototype.addEventListener`, `History.prototype.pushState` and so on. A page that wraps one of them with `Object.defineProperty(o, k, { value, configurable: true, … })` (Google, and the usual fetch/timer instrumentation) got a `TypeError`; plain assignment still worked. Making only `setInterval`, `setTimeout` and `fetch` configurable in a lab build was enough: 546 elements against 552 and no page error.
- **Fix:** a data hook that replaces a native method in place keeps the native's `configurable` bit (`define`, and `defineMasked` / `definePropertiesMasked` for data descriptors), unless a property of that name exists further up the prototype chain or the hook is a new own property (deleting it would then uncover that member). `propertyLocked` knows such hooks by a registry (`installedHooks`), because its idempotence guards (`addEventListener`, `ping`, `background`, `httpEquiv`, …) used to rely on the descriptor being non-configurable. The difference fell from 146 properties to 54.
- **Why this does not open anything:** the page could already replace a data hook by assignment (they are writable), so redefining or deleting one gives it nothing more; and deleting leaves nothing underneath (the e2e deletes eleven of them and reads `name in object` as false, as natively). **Accessor hooks stay non-configurable** on purpose: `innerHTML`, `cookie`, `contentWindow`, `src`, `href`, `localStorage`, …: the membrane reads some of them through the page-facing property, and a getter the page puts in their place would answer for the membrane. The 54 remaining differences are those, the replaced `XMLHttpRequest` class's attributes, `webkitURL`/`webkitRTCPeerConnection`, and `HTMLScriptElement.prototype.textContent`/`innerText` (an ancestor has the name). Before making an accessor configurable, audit the membrane's own reads of it (precedent: ERRATA 100).
- **Measured after:** Google 547 elements against 552, no page error, the rest random ids.
- **Closed by:** test/e2e/proxy.test.js `members the page wraps with Object.defineProperty read, redefine and call as natively` (flags of fifteen members, wrappers on `setTimeout`, `setInterval`, `fetch`, `setAttribute`, `addEventListener` called in the same order as natively, eleven deletions that leave nothing underneath; the accessor flags pinned as the documented deviation; with the old hooks it fails because the wrappers never install).

## <a id="youtube-home-2026-10-26"></a>YouTube home: a rewriter table that leaked a marker into an 11 MB bundle, a window receiver, and `innerText` (2026-10-26) {#youtube-home-2026-10-26}

- **Category:** `rewriter`, `membrane / receivers`, `membrane / descriptors`
- **Symptom:** the YouTube home rendered 421 elements against 2 017 natively, with no images and no text, and two page errors: `Illegal invocation` from an `addEventListener` and `SyntaxError: Invalid or unexpected token` with no stack.
- **Defect 1, the whole bundle failed to parse.** `kevlar_base` (10.8 MB native, 11.9 MB rewritten) came out of the rewriter with control characters in it. The script debugger event `scriptFailedToParse` gave the script, `node --check` on the saved source gave the line, and the line held a marker the rewriter had not expanded: `__zp_set(…,"top",\u0001MEMBER_A\u0001…)`. The source is `v[0].top=v[1].top+=U.height;` (Polymer's iron-fit-behavior). The rewriter emits markers with source spans and expands them at the end; a marker inside a range that is expanded on its own is first rebased by `shift_marker_positions`, which lists which fields of each marker are positions. For `MEMBER_A` and `MEMBER_A_STMT` (a compound write to a dangerous member) it listed 2, 3, 5, 6, copied from `MEMBER_SET`; the operator sits between the property and the value spans, so the value spans are 6 and 7. A compound write to a dangerous member (`top`, `location`, `href`, …) inside another rewritten range (the value of a plain write to one, a call's arguments: `location.assign(a.href += 'x')`) kept a stale end position, failed the span check, and was printed as it was. Minimal: `a.top = b.top += 1`; `a.top = b.y += 1` and `a.x = b.top += 1` were fine. Fixed by the table (crates/zp-rewriter/src/lib.rs), with eight shapes pinned.
- **Defect 2, a native method called with the page's window.** Polymer's shady DOM keeps `EventTarget.prototype.addEventListener` and calls `window.__shady_native_addEventListener(a, fn, true)`, and libraries call `EventTarget.prototype.addEventListener.call(window, …)`. The receiver there is the page-facing window, a Proxy, which the native method rejects (`Illegal invocation`; the method reached through `window.addEventListener` is bound and worked). Measured with a local page: `.call(window)`, `.apply(window)` and a copy called on `window` failed for `addEventListener` and `removeEventListener`; `bareThis`, `document` and `self.addEventListener` were fine. The `EventTarget.prototype` hooks now map the facade to the real window (`pageRewriteHooks.unwrapScope`), and `dispatchEvent` is hooked the same way. A child frame's own facade is not mapped (left).
- **Defect 3, `innerText`.** The bundle wraps it with `Object.defineProperty(HTMLElement.prototype, "innerText", { configurable: true, get: g.get, set: wrapper })`; the accessor hook was non-configurable ([hook-configurable-2026-10-26](#hook-configurable-2026-10-26)). The membrane never reads or writes `innerText` through the page-facing property (it keeps the native descriptor from boot), so `REDEFINABLE_ACCESSORS` (web/membrane/02-masking.js) lists it: the first audited accessor. The audit to repeat before adding another: the membrane's `.name` reads, `[name]` reads and `Reflect.get`. `textContent` and `innerHTML` do have membrane reads and writes and stay locked.
- **Measured after:** 2 019 elements against 2 017, 292 container kinds each, no page error, 8 images and 2 frames each; the two kinds missing are svg ids with a per-load suffix.
- **Closed by:** crates/zp-rewriter `nested_compound_member_assignment_leaves_no_marker` (fails with the old table: the marker is printed), test/js/rewriter.test.js `a compound write to a dangerous member nested in another write keeps its value and its order`, test/e2e/proxy.test.js `EventTarget methods the page keeps and calls on window register, fire and remove as natively` (eleven shapes, which listeners heard which events), and `members the page wraps with Object.defineProperty read, redefine and call as natively` extended with the `innerText` wrapper.

## <a id="inline-module-origin-2026-10-26"></a>Medium: an inline module's imports were root-relative and a blob cannot resolve them (2026-10-26) {#inline-module-origin-2026-10-26}

- **Category:** `membrane / modules` (found on Medium, generic: React Router and Remix pages)
- **Symptom:** Medium rendered 278 elements against 290, with the title `Medium` where the page sets `Medium: Read and write stories.` (its hydration never ran), and one unhandled rejection with no stack: `Failed to resolve module specifier "/zp/api/script?u=https%3A%2F%2Fcdn-client.medium.com%2Flite%2Fstatic%2Fmanifest-fa70beee.js&kind=module". Invalid relative url or base scheme isn't hierarchical.` It showed in `Runtime.exceptionThrown` (the debugger's pause-on-exception never fires for a module graph error); the physical DOM (`DOM.getOuterHTML`) showed the page's inline `<script type="module" async>__ZP_EXEC_INLINE_MODULE("import \"https://cdn-client.medium.com/lite/static/manifest-…\"; import * as route0 from …")`.
- **Cause:** the membrane runs an inline module by rewriting it in the page and importing the result as a blob. The page-side call was `ZPBundle.rewriteScript(source, kind, href)`: three arguments, and the wrapper defaults the fourth, the proxy origin, to the empty string. With an empty origin the rewriter writes module specifiers root-relative (`/zp/api/script?…`, documented for host tests in `RewriteOpts::proxy_origin`). A module loaded from a `blob:` URL has no hierarchical base, so the browser cannot resolve a root-relative specifier and the whole module graph fails. Every page-side module rewrite had this form: inline modules, the copies `virtualModuleURL` and `routeBlobScript` make, `eval`/`Function` with dynamic imports.
- **Fix:** `rewriteCore` (web/membrane/07-membrane.js) passes `proxyOrigin` as the fourth argument, so the specifiers are absolute.
- **Measured after:** Medium's title reads as natively and there is no page error (374 elements against 290: the page hydrates, which the native headless run's consent state does not necessarily match).
- **Looked at and not changed:** eBay's one page error (`Function.prototype.apply was called on undefined`) comes from an obfuscated Akamai bot-manager script (`/Vs7sobCM6/…`); in the same session the native run was served eBay's error page and the proxied one the real page. Telling bots apart is not a goal here.
- **Closed by:** test/e2e/proxy.test.js `an inline module that imports its own site by absolute address runs, as natively` (a static and a dynamic import of the page's own site from an inline module; fails after 30 s with the three-argument call), test/js/prelude-units.test.js (the harness now provides `proxyOrigin`).
