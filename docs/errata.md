# ZeroProxy: Compatibility & Containment Errata

This file is the current-state inventory of containment and compatibility risks: what is closed, what is a residual, and the evidence for each. It is not a change log.

It covers JavaScript, iframe, eval, scope, rewriter and CSP behavior. An item counts as resolved only when a current test proves it.

Security-critical means a path that can produce a **real, unproxied target
navigation/request or a leaked real object**: an escape from the no-escape
jail. Compatibility-only means site breakage without an escape.

**Scope (see CLAUDE.md "Scope").** The project guards containment and compatibility. Making the proxy
undetectable to the page's own JavaScript: stack text, descriptor shapes, canvas/audio fingerprints, the proxy origin or
the page's own share URL being readable, passing a bot wall: is **not a goal**: the masking already in place stays, new
work on it is not started. A residual row that is only about that is *accepted*, not open.

---

## Verification Status and Differential Coverage

Every item below carries a **status** and the **evidence** that backs it,
verified on current `main`. Where native behavior is the question, the
evidence is a **direct-vs-proxy differential**: the same fixture runs in plain
Chrome and through the proxy, and every probe must match unless it is listed as
an intended divergence with its reason. (Pins that were written from proxy-only
runs turned out to certify divergences as "design": see
[trap-notebook rewriter.md#proxy-only-pin](../.ai/trap-notebook/rewriter.md#proxy-only-pin).)

| Differential (all in `test/e2e/proxy.test.js`) | Probes | Diverging |
|---|---|---|
| `direct-vs-proxy compatibility differential` (B, C, I, A5, J) | 63 | 0 |
| `dyn probes match native Chrome (direct-vs-proxy)` (E, G) | 52 | 0 |
| `surface probes match native Chrome except documented divergences` (F, H, J, L, Q) | 116 | 15, each listed with a reason |
| `J: every URL form loads through the proxy exactly when it loads natively` | 12 | 0 |
| `cookies reach every document that can see them, and no other (matches native)` (another document's response, an image, a script, a synchronous XHR, a sibling frame's write, the other site's frame, `cookieStore` change events) | 8 | 0 |
| `a cookie reaches the other tab of the same site (matches native)` (a script's write and a response, both directions) | 4 | 0 |
| `window.name stays with its own frame and lock queries stay inside the site` (an unnamed, a cross-site and a named frame; the parent's name before and after a child names itself; `navigator.locks.query()`) | 7 | 0 |
| `cookies set by fetch and XHR responses are visible to the page and match native` (a plain response, HttpOnly, XHR, a redirect hop, `credentials: omit`, update, `Max-Age=0`, `cookieStore`, change events, what the next request carries) | 12 | 0 |
| `storage events stay inside the writing site and match native` (cross-site and same-site writes, an unchanged value, update, remove, `onstorage`, the frames' own view, a synthetic event) | 9 | 0 |
| `cross-site frame and popup access matches native` (frames and a popup in both directions, `postMessage`, named lookups, replies) | 150 | 2: a same-site child's `top`/`parent` read through a local alias (residual, below) |

Suite totals: e2e 199/199: including the WebTransport gateway
(`test/e2e/wt-gateway.test.js`) and relay-only WebRTC (`test/e2e/rtc-relay.test.js`)
round trips in a real browser: `npm run test:js` 130, `test:wasm:ci` 13,
`cargo test --workspace` 293, `go test ./...` green. Real sites (paired
`test/browser/rendercheck.sh`, cold profile): GitHub height 100% / elements
1811 of 1811 / err 0, Wikipedia 100% / err 0, NAVER 95% / err 1, Stack Overflow
110% / err 6 (FedCM policy block, an ad partner's 502s, one sandboxed-frame
notice), CNN 100% / 4093 of 4095 / err 22 (ad and ID-sync hosts refusing proxied
requests, strict-MIME refusals of those error bodies, sandboxed-frame notices:
no script exceptions), Cloudflare-fronted gosuda.org and MDN 100% / err 0.
Real-site results: GitHub 100% / 1809 of 1809, Wikipedia 100% / 2410 of 2411, CNN 100% / about 4050 of 4050 in five rounds on an idle machine (rounds taken while a compile was running read about 3915 elements and 35 of 41 above the fold; the cause was not isolated), NAVER 79-103% (native Chrome itself swings 2983-3606 px and 1060-1445 elements between two loads, so only the spread says anything). The two
`pm-drop` records NAVER leaves in `__zp_diagnostics` are native behaviour: its
React effect posts `updateTheme` to an iframe it has just created, whose window
is still the initial `about:blank` with the embedder's origin: native drops
it too (the child's own receive log never sees it).

**Status vocabulary**: **fixed** (closed; evidence names the pin) · **parity**
(measured identical to native Chrome) · **not a bug** (the original claim was
wrong; reason given) · **intentional** (deliberate fail-closed or scoped
divergence, pinned) · **residual** (known, documented, not fixed: reason given)
· **unverified** (no current evidence either way).

### Residuals (documented, not fixed)

| Residual | Why it stays | Pin |
|---|---|---|
| V8 names the rewritten callee in some messages (`__zp_get(...).item is not a function`) | V8 renders the call-site AST; matching it needs per-call emission changes. Only buggy call sites surface it. | surface `framesItem` |
| Direct `eval` inside `with(o)` does not see `o` | The eval descriptor carries lexical bindings, not with-objects. Rare (legacy templating uses `new Function`). | surface `withEvalScope` |
| A direct `eval` in a srcless child frame sees the caller's locals but not a caller local that is named like a dangerous global (`location`, `top`, …) when the eval code reads it bare | The page realm consults the caller's bindings inside `__zp_get` for those names (`__zp_eval_desc`); the child realm delegates the helpers to the parent, which does not know this realm's caller. A local named `location` read by name from eval code is vanishingly rare. | `web/membrane/20-containment.js` `childDirectEval` |
| **Accepted (concealment, not a goal): the membrane's calls on strings, arrays and plain objects go through prototypes a page can patch**: `String.prototype.indexOf`/`startsWith`/`slice`, `RegExp.prototype.exec`/`test`, `Array.prototype.push`/`@@iterator`, `JSON.parse`/`stringify`, `Object.assign`, `Reflect.*`. A page that wraps one sees the strings the membrane handles. Measured on a page patching one built-in at a time: the proxy origin, this document's own share URL with its `#k=` key and relay pipe, the tab and entry ids, the URLs of the page's own requests, blob URLs of the proxy, the boot configuration and the install trace. **No real window or Location object was observed**, as a receiver, argument or result, by spies on about a hundred built-in methods and some forty getters on `Object.prototype`, through about thirty membrane paths (location, history, storage, cookies, markup, fetch, XHR, eval, timers, frames, `document.write`, workers, popups, error stacks), with every spy group on and three cross-site paths added (an iframe and a popup of another origin, a message round trip with it). There the cross-site handles behave as a native cross-origin window (`location.href` and `document` throw SecurityError, `contentDocument` is null, `event.source` is the handle the page holds). What the strings are worth to a hostile page is nothing the containment rules depend on: the proxy's name and the page's own route, not a way to reach anything. Wrapping built-ins with a function that reads a global was measured in 84 runs, one built-in each, with every wrapper bumping a top-level counter: a wrapper made in an ordinary script did not kill the page in 81 runs. The other three (`Reflect.set`, `Reflect.getOwnPropertyDescriptor`, `RegExp.prototype.test` inside `new Function`/`eval` wrappers) are closed by sealing `scopeTraps`, `withScope`, `zpDirectEval`, `zpLexScope`, `ZP_HIDDEN_RE` and `ZP_RESERVED_NAME_RE` with captured `Reflect` and `RegExp` natives in `web/membrane/00-head.js` and `web/membrane/07-membrane.js`. The membrane's own tables are sealed as well. | Closing the strings needs every method call the membrane makes on a string, array or JSON text to go through a captured native (`Reflect.apply(nativeIndexOf, s, [x])`, as Node core does with its primordials): thousands of sites, and no build-time tool that tells a string receiver from a page object. The other way is a realm of its own for the membrane, which must then be given every main-realm class its code tests with `instanceof`. The decision is not to close it. | e2e `/xtables` |
| A bare read of a name a worker lacks (`window`, `document`, `top`) is `undefined`, natively a ReferenceError | The rewriter emits the same `__zp_get(globalThis,"window")` for the bare name and for `globalThis.window`, and the helper cannot tell them apart; a separate helper for bare reads of absent names would (rewriter, both runtimes, the parity list). `typeof window`, `'window' in self` and `self.window` (the forms code uses to tell) are exact. | e2e `a worker sees the environment…` |
| A strict caller's `eval("this")` is the window (facade), not `undefined` | The runners are sloppy functions (a parameter named `eval` is illegal in strict code), so an `undefined` `this` is coerced to the global before the eval sees it; the rewriter turns the real global back into the facade, so nothing leaks. | `web/membrane/07-membrane.js` `zpDirectEval` |
| A function a guarded site assigns is named after the temp in V8's own inferred names (profiles, stack frames before sanitizing); `.name` is native (`""`) | V8 infers a debug name from the nearest assignment; the stack sanitizer already turns `__zp_*` frame names into `<anonymous>`, as for the helper form before. | rewriter.test `inline-guarded members…` (`.name`) |
| The page WASM is 527 KB (budget raised from 500 to 540 KB) | The rewriter itself grew: the reserved-name scan (8.7 KB: OXC's walker is monomorphized per visitor), the `with` bindings, the guards. It runs in the page because evals are rewritten there. | static-policy `E3 size guard` |
| A `var` from a script rejected for redeclaration survives as `undefined` | Eval declaration instantiation runs before the emitted conflict check; splitting the check trades this for registrations surviving a syntax error. | surface `ownKeysLeak` |
| An uninitialized-lexical (TDZ) `ReferenceError` is thrown from the prelude, so `ErrorEvent.filename` is the prelude URL | Moving the throw into emitted code means emitting a check per read. | [trap error-filename-leak](../.ai/trap-notebook/rewriter.md#error-filename-leak) |
| A page's own `eval`/`new Function` code prints as a script frame (`at url:L:C`), not as native eval code (`at eval (eval at f (url:L:C), <anonymous>:1:1)`) | The proxy runs dynamic code with a `sourceURL` naming the virtual document; reproducing V8's eval-origin text means knowing the caller's position at compile time. Inline scripts, which are far more common, match native. | e2e `/xstack` (inline), `/xframe-env` (external) |
| `Document.parseHTMLUnsafe` anchors resolve against the virtual base (native: no base, raw text) | Inert parsed documents share the realm's URL hooks. Minor. | surface `parseHTMLUnsafeHook` |
| import-map / speculation-rules read-back returns relative URLs as absolute | The server does not stash the original JSON; read-back is deproxied. | surface `importmapText` (checks no proxy URL) |
| CSS attribute selectors / XPath can detect `data-zp-*` stash attributes | Getters are filtered; selector matching is not. Fingerprint only. | N/A |
| `while (true) { await … }` without `break` dies silently at 10M iterations | Deliberate hang protection; hours of wall time in practice. | [trap loop-cap-nonconst-policy](../.ai/trap-notebook/rewriter.md#loop-cap-nonconst-policy) |
| `navigator.storage.estimate()` reports proxy-origin-wide usage | Quota is per real origin; usage leaks only a byte count across targets. | N/A |
| Storage Access API answers as first-party in every frame | All targets share the proxy origin. | N/A |
| Optional chains with `await`/`yield` after the first `?.`, or with a `Reflect.get?.()`-style special form at a split, keep per-link emission (keys/args evaluated even when short-circuited) | A continuation arrow cannot hold `await`/`yield`; unwrapping a special form would hand out the unmediated native. | matrix optional-chain negative controls |
| `<link rel=preload as=script>` for a module script is fetched again by the module | The preload goes to the classic route; the module needs `kind=module` in its URL. | [trap module-kind-url](../.ai/trap-notebook/rewriter.md#module-kind-url) |
| Ad and ID-sync hosts (Google ads, Amazon, FreeWheel, Optimizely events, …) refuse proxied requests | Their decision, not request shape: `sendBeacon`/`fetch(keepalive)`/form POST bodies and content types arrive byte-identical to native (measured). IP reputation and fingerprint: Phase 3. | N/A |
| The prelude logs "Blocked script execution in 'about:blank'" while touching sandboxed ad frames | Console noise only; the frame is sandboxed without `allow-scripts` either way. | N/A |
| A frame that navigated itself (or was sent by a descendant) to a document with no prelude (text/plain, an image) reads back the URL it was first sent to | The parent maps only routes it opened; another realm's `/zp/p/` token is not decryptable here. HTML documents report their own URL. | N/A |
| A message event carries own `origin`/`source` properties (non-enumerable) | `Object.getOwnPropertyNames(e)` lists them; `Object.keys(e)`, `isTrusted`, `target` and `currentTarget` match native. | N/A |
| `localStorage.clear()` of a same-site window arrives as **one event per removed key** (native: a single event with `key: null`) | The facade clears only its own namespace, key by key: the real `clear()` would wipe every site's. Visible only to a second same-site window that listens. | N/A |
| `e.url` of a storage event is the **receiving** document's virtual URL, not the writer's | The physical URL of the writer is a share route the receiver cannot read. The origin is right. | N/A |
| A storage event carries own `key`/`storageArea`/`url` properties (non-enumerable) | `Object.getOwnPropertyNames(e)` lists them; `Object.keys(e)`, `isTrusted`, `target` match native. | N/A |
| A cookie another document wrote or a response set reaches this one **after a service-worker round trip** (milliseconds), not within the same task | A write in one frame is readable from a sibling frame once the worker has pushed it; natively the shared jar answers at once. Code that writes a cookie and reads it back through another frame in the same task sees the old value. | N/A |
| A frame sandboxed without `allow-same-origin` is **same-origin with the proxy underneath**; its opacity is the prelude's | The proxy cannot serve a document that has a real opaque origin (no service worker, no `localStorage`). The browser keeps every other flag, the frame's namespaces are private to it, and every other window sees it as a cross-origin stand-in: but the denial list is code: a gap in it would let the frame read what any same-origin frame can read of its **own** namespace, never of a site's. | e2e `sandboxed frames are opaque to the page and to each other, as natively` |
| A cloned frame, read before it is inserted, shows the rewritten `sandbox` and an absolute `src` | The page's text lives in element-keyed maps that `cloneNode` does not carry; insertion restores the sandbox, not the `src` text. | N/A |
| A cookie written by `document.cookie` may miss a navigation or an `<img>` request made in the same task | Runtime `fetch` and asynchronous XHR wait for the write's acknowledgement and a synchronous XHR carries the write; a navigation or an image request cannot wait. | N/A |
| `Reflect.getOwnPropertyDescriptor(null, k)` throws `Cannot convert undefined or null to object` (the `Object.` message; native: `Reflect.getOwnPropertyDescriptor called on non-object`) | The rewriter sends `Object.getOwnPropertyDescriptor` and `Reflect.getOwnPropertyDescriptor` to one helper. Always a `TypeError`; only the text differs. | N/A |
| `navigator.connection.rtt` is 0 | Chrome's network-quality estimate has no samples for a loopback origin, so `rtt` reads 0 (native 100-150) and `downlink` 1.45-1.65; the widget reads both. An honest value would be the proxy's measured round trip to the target, which the kernel does not report. A page treating `rtt === 0` as automation sees it. | N/A |
| Inline-script text is HTML-entity decoded (`&amp;`, `&lt;`, `&quot;`, ...) | `decodeInlineEntities` (a documented compromise: a React page shipped operators as `=&gt;`) decodes every inline script, so a legitimate literal `'&amp;'` in an inline script reads `'&'`. A decode only when the unmodified text fails to parse would keep both. An inline script carrying entity text in a string is changed. | trap-notebook rewriter.md |
| `DOMParser`/`innerHTML` on `<noscript>` and event-handler attributes | The membrane's HTML transform (lol_html) tokenizes `<noscript>` content as markup where the browser, scripting on, reads text, so `div.innerHTML = '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'` serializes differently; and a handler attribute of a parsed document reads back as the rewritten text (`onerror="return (function(){...}).__ZP_EXEC_EVENT(...)"`). The widget's parser probes (`<p>FpDs9</div><p>DwoXA1</p>`, `<div data-foo="&#34;">`, `<select>`) match native. A parser-differential probe on those two shapes differs. | N/A |
| A cross-origin frame can see the proxy's service worker and call credentials | `navigator.serviceWorker.getRegistration()` returns the proxy's registration (natively none); `credentials.get` is refused with `Blocked by ZeroProxy policy` where natively the sentence names the missing policy (a deliberate block, kept); `PublicKeyCredential.isConditionalMediationAvailable()` is `false`; `PaymentRequest` with a URL payment method fails a CSP check on the proxy's `connect-src`. A page enumerating these reads the proxy's answers. | N/A |
| `window.setTimeout !== setTimeout` (and addEventListener, requestAnimationFrame, alert, Proxy…) | A static inline script reads a bare name from the real global (our replacement or the native); `window.X`/`globalThis.X` through the facade return a bound copy: a native called with the facade as `this` (`window.requestAnimationFrame.call(window, f)`) throws Illegal invocation, which is why the facade binds. Measured in a static script: `setTimeout`, `Proxy`, `alert`, `addEventListener`, `requestAnimationFrame` differ (and `postMessage` against a copy taken earlier); `fetch`, `Function`, `Object`, `Image` do not. Names and lengths match. A page comparing `window.setTimeout === setTimeout` reads false. No site known to do it. | N/A |
| Refusals the window facade cannot tell apart: `Object.prototype.hasOwnProperty.call(crossOriginWindow, 'document')`, and a refused `Object.defineProperty` on the page's own window | `hasOwnProperty` and `Object.getOwnPropertyDescriptor` reach the same trap; natively the first throws only the closing sentence, the second names the property. A refused `Object.defineProperty(window, 'top', …)` throws a TypeError whose message says `'defineProperty' on proxy: trap returned falsish` where natively it says `Cannot redefine property: top` (the window is a Proxy for the page). One probe of 130 differs; the second needs a page that reads the message. | e2e `a page may redefine and assign its own window attributes (matches native)` |
| A frame of another virtual origin is the same real origin as its embedder, so gated APIs follow the real one | `screen.isExtended` is `true` in a frame without site isolation (a multi-monitor machine; natively `false` in a cross-origin frame; a site frame is a real cross-origin frame, so the browser answers as natively there, and no wrapper emulates it), a third-party `document.cookie = 'a=1'` is accepted (natively rejected without `SameSite=None; Secure`), `history.length` counts the proxy's own landing page (+1), the widget's viewport rounds 1 device pixel differently at a fractional zoom (65 vs 66). A page reading those sees the real frame tree. | N/A |
| `frame.contentWindow.parent` and `.top` of an about:blank or srcdoc frame are not the page's `window` | The address of such a frame matches native: `document.URL`, `documentURI` and `location.href` are `about:blank` (`about:srcdoc` for a srcdoc frame), `location.protocol` is `about:`, `location.origin` is `null`, and `document.referrer` is the embedder's URL (cut to its origin when the referrer policy says so). Natively `W.parent === window` and `W.top === window` are true. `W.parent`/`W.top` are still the real parent window, not the page-facing one: the rewriter leaves `.parent`/`.top` member reads alone, and `top` is unforgeable. A page comparing `frame.contentWindow.parent === window` reads false. | N/A |
| The challenge's VM phases run 3-4× slower through the proxy | The payload carries every probe's wall time: 39 probes natively 1.3 s in all, through the proxy 5.1-6.0 s; the top-level phase timers 2-4×; the pre-click phase 9.5 s against 1.6 s. A CPU profile of the proxied widget: `runtime-prelude.js` self time (2.8-4.2 s) exceeds the challenge script's own (2.0-2.2 s): the eval facade (0.9 s: the VM evals a 1.3 MB whitespace-padded string every ~560 ms, 8-17 ms through the facade against 5.4 ms natively), then `get`/`call`/`set`. Native at 10× CPU throttle still passes, so absolute slowness is not the verdict. The `Function.prototype.toString`, `document` and `location.href` paths were 20-130× native and are fixed; with them the spans did not move (5.8-6.0 s) and the outcome is the same, so a non-uniform slowdown of those operations is not the cause either. The calls are almost all no-ops in outcome: classified in the widget (get/set, one run of 1.7 M), 92 % took the fast path, 6.6 % went the long way and ended at a plain `base[prop]`, 0.3 % (window, document, location, Function, eval, postMessage, parent, name) were answered by the membrane. By call site (sampled 1/256), about two thirds are `__zp_call(base, key, [args])` in the VM's decoder loops (`out.push(String.fromCharCode(…))`, `Reflect.apply(f, this, […])`) that the rewriter could not guard because the arguments hold guards of their own (they would be copied into both arms); the rest are guarded reads and writes whose `__zp_fast` check is itself a call. A dynamic member operation needs one helper call whatever the base, because its kind is not known statically. What is left is the broad per-call cost of the membrane: with the plain-object path in, the widget's profile is the challenge script 3.0 s + the membrane 3.6 s (eval facade 1.2 s, the fast-path checks themselves ~0.8 s, `call`/`get` ~0.4 s) + the host page; natively the widget is the script 1.7 s + compile 1.2 s. Time-based signals in the payload differ from native by the membrane's cost per operation. | N/A |
| An inline `<script>` runs inside `with(__zp_lex_scope)`, so every free identifier in it (and in every function it defines) is a dynamic lookup through a Proxy | `Math.floor(i / 3)` in a loop: 355 ns an iteration against 2.7 ns natively (132×); the same loop in an external script is native speed. The `with` is how a later script sees the `let`/`const`/`class` an earlier inline script declared (an indirect eval's lexical scope is discarded). Run as a real script element instead (native global lexical scope, no `with`) the loop is 1.3×, but 13 e2e tests fail: scripts in a srcdoc frame run out of order, an inline script's stack gains the bootstrap frame, a `MutationObserver` sees the inserted element, `currentScript` has to be forged. A plain null-prototype object instead of the Proxy is 2.4× cheaper, not native. Measured on the widget with the plain-object path also in: spans 4.7-5.5 s against 5.2-6.0 s, the whole VM 5.8-6.9 s against 7.5 s, and the challenge fails the same way in three person-order runs: about 10 % there, so the change is not worth its risk for this. Not done. On 21 sites the trap time is at most 0.22 s (Amazon), usually under 10 ms. The same design leaves these correctness gaps: strict inline `var`/function declarations were lost (as on Bing) and are exported to the global; external scripts and event-handler attributes do not see inline `let`/`const`/`class`; and a free identifier naming an iframe is not virtualized in external scripts. The with-scope entry of the trap notebook is in `rewriter.md`. Inline-script-heavy pages (every Turnstile widget is one) spend their time in lookups natively free. | N/A |
| Other operations still several times the native cost | `window.setTimeout` ~450 ns (the facade's descriptor walk + a bound-function lookup), `window.innerWidth` 4×, `document.location` 8×, `el.style.x = v` 7× (the style hook), `el.getAttribute` 6×, `new Error().stack` 5.5× (the sanitizer), `obj[key]` on an object 6×, `Function.prototype.toString` of a native 2×. None is a hang; each is a per-call hook doing its work. A loop made of these runs several times slower than the browser's. | N/A |
| A page function's text still shows the rewrite for a few shapes | Found by the text probe (`functionTextProbe`): an arrow whose body is a guarded read (`(a, b) => a[b] \|\| x` reads `(a)[(b)] \|\| x`), a compound assignment on a member (`o[k] += 2` is a getter/setter object) and `delete o[k]` (`__zp_delete((o),(k))`). The restore (`unrewriteSourceText`) knows the other shapes. Hiding the rewrite is not a goal; the shapes are not extended. A page that prints its own function source sees these three. | `proxy.test.js` `functionTextProbe` (not asserted) |
| HTTP/3: a default Chrome reaches Cloudflare sites over QUIC, the proxy over TCP + TLS + HTTP/2 | Not the cause of the Glassdoor failure: a native page over the proxy's own TCP + TLS + HTTP/2 kernel passes (13 of 13, [trap notebook](../.ai/trap-notebook/rewriter.md#transport-only-control-comparison)). The transport has no QUIC (a UDP path through the relay, a QUIC stack in the kernel, Chrome's QUIC fingerprint). Cloudflare scores it: on Glassdoor a native Chrome with QUIC off gets the interactive challenge the proxy gets. Counted on `_cf_chl_opt.cType`: Chrome over HTTP/3 `managed` 8 of 8, over HTTP/2 `managed` 2 of 5, the kernel `interactive` 7 of 7. The proxy reports `nextHopProtocol` `h2` consistently. | N/A |
| `iframe.featurePolicy.getAllowlistForFeature` (an embedder reading a child's container policy) names the embedder's origin where natively it names the frame's | The allowlist mapping puts the reading document's virtual origin in place of the proxy origin; for a container policy that should be the frame's `src` origin. `allowedFeatures`/`allowsFeature` of it are right. Rarely read. | N/A |
| An attribute selector on a URL-bearing attribute is translated to match the value the page sees (see the URL-attribute selector entry in the trap notebook, `rewriter.md`); what is still read from the real attribute: a selector in a stylesheet (`a[href^="http"]::after`; measured on 19 sites: 68 such selectors, 5 match anything natively, all `textPath[href="#circle1"]` fragments that are not rewritten, and none matches differently), a query on a `DocumentFragment` or `ShadowRoot`, a namespaced name (`xlink\|href`), `webkitMatchesSelector`, and the `href` of a runtime `modulepreload` link (its `rel` and `href` are parked, so a selector and `getAttribute('href')` find nothing; the link is inert in the proxy) | The real attribute holds the proxy path; the page's value is kept in `data-zp-lit-<name>` and the four query methods (`querySelector`, `querySelectorAll`, `matches`, `closest`) rewrite `[href OP v]` to `:is([data-zp-lit-href OP v],[href OP v]:where(:not([data-zp-lit-href])))`. A rule in an author stylesheet that picks links by their URL (external-link icons) would not apply to a rewritten element (none found on the measured sites); a library that queries a fragment by URL attribute finds nothing. | N/A |
| A native `EventTarget` method called with a *child frame's* page-facing window as its receiver (`EventTarget.prototype.addEventListener.call(frame.contentWindow, …)`) is rejected with `Illegal invocation` | The hooks map the page's own window facade to the real window; a child realm has a facade of its own that the hook table does not know. Not measured on a site. A library that does this to a frame's window fails there. | N/A |
| A CSS `attr(href)` paints the real attribute, the proxy address: Wikipedia's print stylesheet `a.external.text::after { content: " (" attr(href) ")" }` | Measured with a screenshot in print media: natively `(https://en.wikipedia.org/w/index.php?title=Mechanic&action=edit)`, through the proxy `(http://proxy.localhost:18080/zp/?via=https%3A%2F%2Fen.wikipedia.org%2F…)`. `getComputedStyle(a, '::after').content` reads the same on both sides because the membrane answers computed values with the original address, so only the painted text differs. Of 11 site stylesheets looked at, this was the only declaration that reads a URL attribute through `attr()` (the rest read `data-*`); screen rendering is unaffected. Printing or saving as PDF a page whose print stylesheet shows link addresses prints proxy addresses. A possible fix is to rewrite `attr(href)` to read `data-zp-lit-href`, which the page's own value lives in; not done. | N/A |
| Accessor members the membrane replaces are non-configurable (except `HTMLElement.prototype.innerText`, the one audited): `Object.defineProperty(Element.prototype, 'innerHTML', …)`, `…(Document.prototype, 'cookie', …)`, `…(window, 'localStorage', …)` throw `TypeError`; so do the same on `HTMLIFrameElement.prototype.contentWindow`, `src`, `href` and the replaced `XMLHttpRequest` attributes | Data members (methods) keep the native's `configurable` bit (`setInterval`, `fetch`, `setAttribute`, … can be wrapped and deleted as natively). Accessor hooks stay locked: the membrane reads some of them through the page-facing property, and a page getter installed in their place would answer for the membrane. 53 own properties still differ from native in this bit (measured by comparing `getOwnPropertyDescriptor` over `window` and 26 prototypes and constructors). A page or library that instruments a DOM accessor by redefining it fails there: Transcend's airgap on Notion throws once on `innerHTML` (its text is identical and 851 of 863 elements are present). Making `innerHTML`, `outerHTML` and `textContent` redefinable first needs the audit `REDEFINABLE_ACCESSORS` asks for. `window.onmessage` is non-configurable for the same reason, with no site known. | N/A |
| A strict script's top-level `var` that a later strict script declares again is two bindings joined at the global, not one: an assignment made by the *earlier* script's own code after the redeclaration reaches only its own copy | A strict script run through `eval` keeps its vars in its own scope. The later script's copy starts from the global's value, and the global's accessor reads the later copy and writes through every copy, so every access through the global (another script, a handler, `window.x`) agrees; but the earlier script's closures assign its own variable directly. Measured: Bing's `var _w = _w \|\| {}` after `var _w = window` (same object, no divergence). Example: `var x = 1` in script A, `var x` in script B, then A's function does `x = 2`: B and the global still read 1. Objects shared by identity are unaffected. | N/A |
| A static `import … from 'blob:…'` in a module the service worker serves, or in a worker, fails to load | The rewriter replaces such a specifier with `zp-import:<escaped original>`, which only the page's own rewriter can swap for a rewritten copy (it can read the blob); anywhere else the unknown scheme fails closed. A `data:` specifier is not part of this: it goes to the service worker's script route, which decodes and rewrites it. A server module with `import 'blob:…'` does not run; a page-built blob module that imports another blob works. `<script src="data:…">` runs, rewritten (Instagram, Facebook, 11st). | N/A |
| `navigation.addEventListener('navigate', …)` sees one `navigate` event more than natively, and the first reads `push` where a load-time hash change reads `replace` | Measured: three page navigations (hash change, `pushState`, `replaceState`) reach a function, an object and an `onnavigate` listener as four events, the first as `push` and the extra one a `replace` to the current URL. The extra event is consistent with the membrane's own refresh of the visible proxy address (`replaceVisibleProxyURL`, a real `replaceState`), which the facade does not hide from page listeners; why the first reads `push` is not established. A router that handles every `navigate` handles the address refresh too. | N/A |
| `Object.keys(localStorage)` and `for…in` list the stored keys in a different order than natively (`b,a` for keys set as `a`, `b`) | The facade stores each key under the origin prefix in the real `localStorage`, and Chrome lists real keys in its own hash order, which the prefix changes. Everything else of the facade follows native (prototype chain, `hasOwnProperty`, `toString`, `constructor`, enumerable members). Code that depends on the key order of `localStorage` sees another one. | N/A |
| A TLS 1.2 server that offers only CBC or static-RSA cipher suites cannot be reached; a server that merely *prefers* one of the advertised decoy suites is reached by one retry with a hello that lists only what the stack can negotiate | The ClientHello advertises Chrome's legacy suites (`0xC013`, `0xC014`, `0x9C`, `0x9D`, `0x2F`, `0x35`) as decoys; the TLS stack (rustls) implements neither CBC nor static-RSA key exchange. A handshake that fails with `SelectedUnofferedCipherSuite` is made again on a new stream without the decoys and the host is remembered (trap notebook `tls-fingerprint.md`, the legacy suite retry); DCInside works that way. Measured: `token.rubiconproject.com` is TLS 1.2 with the legacy suites only, so no hello helps there; `pixel.rubiconproject.com` is a pool where some members are. A host that offers no AEAD suite is unreachable through the proxy; a host reached by the retry sees a ClientHello without the decoys (a different JA3) on its connections. | N/A |
| A text node the page put into a `<style>` reads back rewritten: `textNode.data` holds the proxy's URLs, `style.textContent` the original URLs but with the rewriter's quoting (`url("https://x.test/a.png")` for `url(https://x.test/a.png)`) | The CSS is rewritten in place before the node is inserted (so the node is the page's own and a later `removeChild(node)` finds it). `style.textContent` is de-proxied on read, `CharacterData.data` is not, and only the `textContent =` route remembers the page's exact string. Hiding the proxy is not a goal and the read is not hooked. A page that reads back the text of its own style node sees the proxy's address (`data`) or a re-quoted URL (`textContent`). | N/A |
| A sub-request's header order outside the measured name sets is approximate | Blink keeps a request's headers in a hash table, so the order changes with the set of names (Cloudflare's `cf-chl-ra` swaps `sec-ch-ua-model` and `-mobile`). Three sets are exact (no high-entropy hints, Cloudflare's nine, all of them); a page's own header goes where `cf-chl` did. Exact for every set means emulating Blink's string hash and table. | e2e `/xch` |
| Client hints from `<meta http-equiv="Accept-CH">`, their `Permissions-Policy` delegation (`ch-ua-*=(…)`), `Width`/`Sec-CH-Width`, and `priority` on sub-requests | The SW negotiates from the response header only and sends `priority` on documents only; natively Cloudflare's `fo` POST carries `priority: u=1, i`. | N/A |
| A blob URL carries the proxy's origin (`blob:http://proxy.localhost:18080/…`; natively the document's) | `URL.createObjectURL` is the browser's: the blob store is keyed by the real origin. Handing out a virtual URL means mapping it back in every consumer (DOM URL attributes, `fetch`/XHR, workers, CSS `url()`, media, `import()`) and forward in every read-back. Known since the URL-gate design. | env-diff `blobUrl` |
| The target's header CSP is replaced by the proxy's policy. Trusted Types directives (`require-trusted-types-for`, `trusted-types`) are applied; header-only `sandbox` and nonce-only or stricter source lists are not. | A `<meta>` CSP of the target is intersected with the proxy's policy. Trusted Types bind the membrane's own sinks through a policy of ours (`zp-internal`, `web/membrane/02-trusted-types.js`), the target's directives are carried by `trusted_types_directives` (`crates/zp-shared/src/csp.rs`), and enforcement is described in the trap notebook (`rewriter.md`, `trusted-types-enforced`). The page's strings are checked against the page's policy in the membrane; the e2e tests compare every sink's default-policy call and every refusal message with native, for a header and for a `<meta>` directive. Only the enforced `Content-Security-Policy` header is carried, a `Content-Security-Policy-Report-Only` one is not (GitHub sends Trusted Types that way). Two differences remain (trap notebook, `trusted-types-compilation-rules`): a `default` policy that answers `null` for a markup sink reads as an empty string (the public API cannot tell them apart; the engine refuses), and Chrome skips the policy for `eval`/`Function` from a script element whose text was a `TrustedScript` inside a subframe, where the membrane consults it for every page string. A nonce policy also refuses the prelude's inline scripts, and the header `sandbox` is not applied: natively `document.domain = …` throws `SecurityError` in Turnstile's document, through the proxy it does not. | env-diff `evalString`, `ttCreateOther`, `sandboxed` |
| Reddit's "Prove your humanity" wall on a cold profile | Parity: checked with a fresh, unautomated Chrome (no proxy): it gets the same wall, and so does the proxy. | N/A |
| `iframe.sandbox` (the `DOMTokenList`) is empty for a value the membrane virtualized (`allow-scripts allow-same-origin`: native length 2, ours 0) | `getAttribute('sandbox')` is right. The real attribute is removed so the browser does not enforce flags that would let the frame escape; the list is the real element's. (A sandbox without `allow-same-origin` is not this case: its list is a real `DOMTokenList` holding the page's value.) | N/A |

---

## A. Security-critical escape vectors

Evidence for this section: e2e `A-section escapes stay virtual or fail closed`
(browser, every probe reads virtual or fails closed), `escape matrix`, and the
rewriter emission tests in `crates/zp-rewriter/tests/matrix.rs`.

### A1. Top-level `var`/`function` shadowing a dangerous global: **fixed**

References to a dangerous name stay mediated even after a top-level `var` /
`function` declaration of it: `var location = …` syncs through
`__zp_set(globalThis,"location",…)`, `function location(){}` is renamed to a
temp. Verified for every dangerous global (`location`, `document`, `window`,
`top`, `parent`, `frames`, `self`, `globalThis`, `opener`, `history`, `eval`,
`Function`). Pins: matrix `var_function_shadowing_neutralized`,
`declaration_targets_sync_via_temp`; e2e `varShadow`/`letShadow`/`fnDeclShadow`.
`class location {}` at top level fails with the native SyntaxError (the lexical
registry sees the unforgeable global).

- Module goal (`function location(){}` in a module): **not a bug**: top-level
  module declarations are module-scoped, so `location` really is the local
  binding (native semantics). Pin: matrix `var_function_shadowing_neutralized` (module case).

### A2. Computed member access: **fixed**

`x[k]`, `x['location']`, `this['location']`, `frames[i]`, `x?.[k]` all route
through `__zp_get`/`__zp_set`/`__zp_call`/`__zp_oget`/`__zp_ocall`. Pins: matrix
`computed_member_reads`, `computed_member_writes_and_calls`,
`dangerous_method_calls_stay_bound`; e2e `thisComputed`, `globalComputed`, `computedAccess`.

### A3. `new Function('return this')()`: **fixed**

Sloppy dynamic functions get the scope facade as `this`, never the real window;
the Async/Generator constructors are gated the same way. Pins: e2e `fnThis`,
`fnThisNull`, dyn `fnThis`, `fnThisIsWindow`, escape matrix `asyncFunctionEscape`.

### A4. eval-expression path: **fixed**

Expression bodies go through the rewriter before the `with(__zp_scope)` wrapper.
Pins: e2e `evalHref`, `evalArith`; dyn `evalLocation`, `evalStrict`, `evalIndirect`.

### A5. Reflect / descriptor paths: **fixed**

Computed `Reflect.get/set/has/deleteProperty/ownKeys`,
`Object.getOwnPropertyDescriptor(s)`, `Reflect.getOwnPropertyDescriptor`,
`__lookupGetter__`/`__defineGetter__` are mediated or return membrane getters.
Pins: matrix `reflect_object_routing`; e2e `gopdHref`, `lookupGetter`,
`locationDescriptor(Flags)`; surface `defineGetterLoc`, `lookupGetterLoc`.
`Reflect.setPrototypeOf(window, x)` does not touch the real window and
refuses like native (immutable prototype); `Reflect.defineProperty(window,
'location', …)` returns false like native. Pins: compat `setProtoReflect`,
`setProtoSame`, `setProtoObject`, `protoIsWindow`, `defPropLocReflect`,
`defPropLocObject`, `preventExtWindow`: all **parity**.

### A6. `open()` returned window: **fixed**

The http branch gets network containment; `javascript:` URLs do not execute.
Pins: e2e `openJs`, `openEscaped`.

### A7. Non-root `Document.location`: **fixed**

`contentDocument.location` / `ownerDocument.location` resolve to the child's
virtual location, never a proxy URL. Pins: e2e `contentDocLocation`, iframe suite `srcVirtual`.

### A8. `window.navigation`: **fixed**

A `VirtualNavigation` facade: entry URLs read virtual, `navigate()` goes through
the virtual-location pipeline, `javascript:` is refused. Pins: e2e
`navigationJs`, `navEscaped`, `navCurrentEntry`.

### A9. Dynamic `<meta http-equiv="refresh">`: **fixed**

Both attribute orders are rewritten before the browser can arm the refresh.
Pin: e2e `metaRefresh` (neutralized).

### A10. Other real-object leak paths: **fixed / parity**

- `document.write`/`open()` second document: **fixed** (surface `docWriteFrame`).
- `window.name`: **intentional** virtual store (compat `winName` parity).
- `cookieStore`: **fixed**, backed by the jar.
- `<a ping>`: **fixed**: fired through proxy transport, never by the browser;
  read-back matches native (surface `anchorPing`, e2e `anchor ping fires through proxy transport`).
- `structuredClone`/`WeakRef`/`MessagePort` transfer: **parity**: real objects
  throw `DataCloneError` like native (surface `cloneLocation`, `portMsgLocation`).
- `frames['name']`, `self[0]`, `this[0]`: **fixed** (surface `framesByName`, `selfIndex`, `thisIndex`).
- `frames.item(0)`: **parity** (native has no `frames.item` either); the error
  *message* names the rewritten callee: **residual** (see table).
- Legacy `__lookup/__define*` accessors: **fixed** (surface `defineGetterLoc` …).
- `Object.getOwnPropertyNames(window)`: **fixed**: no `__zp_*` names (surface `ownKeysLeak`).

---

## B. Syntax-kill (whole script fails to parse): **fixed**

Dangerous-name assignment targets (`for (location of a)`, `[location] = arr`,
`({a: location} = o)`, nested, rest, defaults, `for await`, catch, switch,
labels) emit through the `__zp_get.d` write sinks. Pins: matrix
`assignment_targets_route_through_write_facade` (re-parse checked); compat
`forOf`, `forIn`, `arrayTarget`, `objTarget`, `nestedTarget`, `forOfArr`,
`forOfObj`, `defaultTarget`, `restTarget`, `memberTarget`, `catchParam`,
`switchTarget`, `labelLoop`, `forAwait`: all **parity**.

Lexical bind calls (`__zp_lex_bind`) glued to a declaration by ASI are **fixed**.

---

## C. Rewriter scope/binding semantics: **fixed / parity**

| Case | Status | Evidence |
|---|---|---|
| `import location from 'x'` / named / star | **parity**: module bindings are declared locals | surface Q5 notes |
| `class location {}` | **parity**: native SyntaxError via the lexical registry | emission check above |
| `f(){ location.x; var location; }` / function hoisting / block TDZ | **parity** | matrix `local_scope_bindings_not_mediated`; compat `hoistedVar`; surface `scopeHoistVar`, `scopeTDZ` |
| direct `eval('x')` caller scope | **fixed** | compat `evalDirectLocal`; surface `evalCallerScope`, `evalCallerWrite`, `evalCallerVar` |
| `delete obj.location` | **parity** | compat `deleteMember`; surface `deleteLoc` |
| `x?.location?.()`, `x?.location`, `x?.location.href` | **parity** | compat `optCallNull`, `optMemberNull`, `optChainNull`; surface `optCallChain` |
| `for(let i=0;;i++)` | **fixed**: capped | perf `cappedFor` |
| `while(true){await x()}` | **residual**: silent stop at 10M (see table) | perf `asyncPollBreak`, `asyncPollFlag` |
| `new.target` in dynamic functions | **parity** | compat `newTargetFn` |
| `({[location]:1})` | **parity** | compat `computedKey` |
| `location ??= u`, `super.location`, `x?.m()` | **parity** | compat `nullishAssign`, `superProp`, `plainOptCall` |

Scope variants: `function f(location=location)` (compat `paramDefault`),
`function f({location})` (surface `scopeDestructParam`), `catch(location)`
(surface `scopeCatch`), labeled function declarations and Annex B (surface
`labeledFnDecl`, `annexBSloppy`), `arguments` aliasing (compat
`argumentsAlias`), eval-created bindings (dyn `evalVarVisible`), cross-script
`let`/`const`/`class`/`var` (surface `crossScript*`, `lexRedeclare`): all
**parity**. `using` / `await using`, `eval`/`Function` bodies with `using`,
`DisposableStack`: **parity** (surface `usingDecl`, `awaitUsing`, `usingEval`,
`usingFunction`, `disposableStack`).

---

## D. `with` statement: **fixed**, one residual

Dangerous names inside `with(o)` consult `o` first (innermost-first chain);
`with(document)` keeps identity and PutForwards semantics; strict-mode `with` is
the native SyntaxError. Pins: matrix `with_body_dangerous_names_chain_innermost_first`;
surface `withShadow` (obj-first), `withDocIdentity`, `withDocWrite`,
`strictWith`; dyn `fnWith`. Direct `eval` inside `with` not seeing `o`:
**residual** (surface `withEvalScope`). The rewritten code inside a page's `with` body names our
helpers too, so the body starts by binding them before `o` can answer for them (e2e `/xhelper`).

---

## E. eval / dynamic code: **fixed** (native differential: 49 probes, 0 diverging)

The whole dyn fixture runs natively and through the proxy
(`dyn probes match native Chrome (direct-vs-proxy)`). Covered: direct / indirect
/ `eval.call` / optional / tagged eval, non-string completion values, strict
eval, syntax errors (`SyntaxError`, `instanceof` holds), `new eval()`
(TypeError), `Function` parameter forms (defaults, comments, bad params),
`this`, nested eval, Async/Generator constructors, string timers (including a
syntax error reported at fire time), `setInterval`, inline and property event
handlers, DOM-insertion scripts (silent like native), `document.write`,
`import()` of http / `data:` / `blob:`, and source/path leak checks
(`leakFnToString`, `leakCallee`, `leakDynStack`, `leakFnStack`).
Module-scope `eval` reifying the module environment: **residual** (Q5).

---

## F. iframe / child realm

| Case | Status | Evidence |
|---|---|---|
| `contentWindow.location`, `contentDocument.location` | **fixed** | iframe `srcVirtual`; e2e `contentDocLocation` |
| `frames[i]`, `window[i]`, named frames, `iframe['contentWindow']` | **fixed** | e2e `framesIndex`; surface `framesByName`, `windowByName` |
| `iframe.src = blob:/data:/javascript:` | **intentional**: sealed (legit blob/data frames break) | iframe `blobBlocked`; CSP suite sealed-path pins |
| `srcdoc` | **fixed** (prelude injected, scripts run) | iframe `srcdocLoad`, `srcdocScript`, `nested` |
| srcdoc `location.href` | **fixed**: `about:srcdoc`, as natively | iframe `srcdocLocation` |
| `sandbox` | **fixed** | iframe `sandboxOpaque` |
| dynamic creation / insert-remove race | **fixed** | iframe `createBlank`, `removeRace` |
| `document.write` second document | **fixed** | surface `docWriteFrame` |
| `open()` window | **fixed** | A6 |
| `postMessage` origin / source | **fixed** | iframe `postMessage` |
| identity (`contentWindow === frames[0]`) | **fixed** | iframe `identityStable` |
| `<object>/<embed>/<portal>/<fencedframe>` | **intentional** | Q7 |
| `iframe.csp` | **residual**: passes through as inert data | surface `iframeCspAttr` |
| `credentialless` | **parity** | surface `iframeCredentialless` |
| `<a target=framename>`, `setAttribute('target')`, `<base target>`, `open(url, name)` | **fixed** | surface `targetFramename`, `targetFramenameAttr`, `baseTargetFrame`, `namedOpen` |
| `target=_parent`/`_top` from a frame, `<form target>`/`formtarget` (GET and POST), popups | **fixed** | surface `parentTargetLink`, `formTargetGet`, `formTargetPost`, `popupRouted`, `targetAttrReadback` |
| a child's own membrane survives the parent's `contentWindow` reads | **fixed** | surface `childLocAssign` |
| blank / routed / prelude-less child windows are never raw | **fixed** | surface `pendingRouteEval`, `staleBlankEval`, `routedPlainEval` |
| SharedWorker from a child realm | **fixed** | surface `childSharedWorker` |
| child **storage** between same-site frames, and a parent's own storage seen from a child | **parity** (keys, quota names, IndexedDB and cache names, locks, `BroadcastChannel`, events) | e2e `storage events stay inside the writing site and match native` |
| child **cookies** between same-site frames, written after the other frame loaded | **fixed**; delivery is asynchronous (Residuals) | e2e `cookies reach every document that can see them, and no other` |
| iframe `load` events and joint session history for a frame sent through `src` | **fixed**: one `load` per navigation and one history entry per change, as native; a parsed `<iframe src onload>` fires once | e2e `frame load events and history match native`. See [trap frame-double-load](../.ai/trap-notebook/rewriter.md#frame-double-load). |
| a detached frame's window | **parity** for `eval` and `closed`; `document.URL` reports the virtual URL where native reports `about:blank` (not re-measured after the `about:blank` address fix) | N/A |
| frames and popups of **different sites** | **fixed**: a cross-site window is a stand-in that follows the HTML cross-origin rules, in both directions; `postMessage` honors the target origin; `e.origin`/`e.source` are right on the receiving side | e2e `cross-site frame and popup access matches native`. Residuals below. See [trap cross-site-frame](../.ai/trap-notebook/rewriter.md#cross-site-frame). |
| CSP inheritance into child frames | **unverified** | N/A |

---

## G. Worker realm: **fixed**, residuals noted

The worker suite pins dedicated, module and shared workers: virtual `location`,
`fetch`/XHR/sync-XHR relay, brokered WebSocket, EventSource, rewrite-then-execute
`eval`/`Function`/string timers, `importScripts` (http, `data:`, `blob:`),
namespaced storage (IndexedDB, Cache, cookieStore, OPFS, BroadcastChannel),
sanitized error stacks, W8-W12 surfaces (`self.origin`, `isSecureContext`,
BroadcastChannel prefix, `webkit*` aliases, OPFS). SharedWorker per-target name
prefix: **fixed** (static-policy `prefixedSharedWorkerOptions`). Rewriter
helpers missing from the worker realm (`__zp_okeys`, `__zp_delete`, `__zp_oget`,
`__zp_rget`, `__zp_with_*` …): **fixed** (static-policy guard).
Native methods through `self`, the `Function.prototype` facade, and blob
sources revoked right after `new Worker()`: **fixed**.
Worker hooks: **fixed**. Each hook sits on the object that owns the native member, which is containment; the hooks do not mirror the native's source, name, length or flags. Residuals: `navigator` is the spoofed
build identity (intentional); termination mid-request and multi-target workers
: **unverified**.

---

## H. Unhooked / partially hooked API surface

| API | Status | Evidence |
|---|---|---|
| `window.navigation` | **fixed** | A8 |
| `window.name` | **intentional**: virtual store | compat `winName` |
| `cookieStore` | **fixed**: jar-backed | worker/page cookieStore pins |
| `new URL(rel)` single-argument | **parity** | compat `urlCtorRel`, worker `urlResolve` |
| `import.meta.resolve` | **fixed** | surface `importMetaResolve` |
| `alert`/`confirm`/`prompt`/`print` | **intentional**: stubs (same values a dismissed dialog gives) | surface `dialogStubs` |
| `navigator.serviceWorker.getRegistrations()` | **fixed** (ZeroProxy's own SW is never exposed; **intentional**) the facade always reports one fake registration | surface `swRegs` |
| `location.ancestorOrigins` | **fixed** | membrane `07-membrane.js` |
| `history` length / traversal | **residual** (Q2) | N/A |
| bar props, `featurePolicy`, XPath, `ElementInternals` | **parity**: native, no URL or navigation surface | N/A |
| `XMLSerializer` | **fixed** | compat `serXML` |
| `Object.getOwnPropertyNames(window)` | **fixed** | surface `ownKeysLeak` |
| `el.onclick = 'code'` | **fixed**: a string is null like native | dyn `handlerPropString` |
| `adoptedStyleSheets`, `new CSSStyleSheet()` | **fixed-ish, monitor** (Q4) | N/A |
| `webkitTemporaryStorage`/`webkitPersistentStorage` | **intentional**: removed | surface `webkitFS` |
| `webkitRequestFileSystem`/`webkitResolveLocalFileSystemURL` | present as functions, always `SecurityError` | surface `webkitFS` (equals native) |
| file pickers, WebAuthn, PaymentRequest | **intentional** (Q7) | surface `webAuthn`, `credGet` |
| `hasStorageAccess`/`requestStorageAccess` | **residual**: first-party everywhere | N/A |
| `registerProtocolHandler` | **fixed**: virtual-origin facade | surface `registerPH`, `registerPHSameOrigin` |

---

## I. URL / navigation semantics: **parity**

`location === document.location`, `location.href === document.URL`,
`document.baseURI`, hash writes, `new URL` (relative / absolute / statics),
`window.name`, `document.cookie`, anchor property vs attribute, `ping`,
`history.pushState`, same-origin `fetch`: compat differential, all identical to
native. `mailto:` delegation: **fixed** (surface `mailtoNav`). Dynamic `<base>`
: **intentional** (`base-uri 'none'`; surface `dynamicBase`).

Measured against plain Chrome with a one-off differential (not
pinned: the probes need seconds of settling per case): `location.pathname` /
`search` / `hash` writes in a child frame, `location.host` / `hostname` writes
(`SecurityError` in both), `location.replace` and `assign` joint-history
deltas, form `action` / `formAction` with an attribute set, `a.download` /
`referrerPolicy`, `window.open(url, name, 'noopener')` (returns `null` in
both): **parity**. Two small residuals came out of the same run:

| Residual | Native / proxy | Why it stays |
|---|---|---|
| `submitter.formAction` with no `formaction` attribute | document URL / `''` | The URL-property hook returns the attribute's absence as `''`; the native getter falls back to the document URL. Cosmetic. |
| `window.open(url, name, features).opener === window` | `true` / `false` | The returned handle's `opener` is the membrane's window facade, which is not `===` the page's own `window` reference. Needs window-identity unification across facades. |

---

## J. HTML/CSS transformer residuals

Every `url_surfaces.json` pair (the single source of truth for URL-bearing
attributes) was measured in Chrome for a reflecting IDL property: the property
write that bypasses the `setAttribute` hook. The three unhooked ones
(`input.src`, `body.background`, SVG `href.baseVal`) are **fixed**. Load parity
is checked from the target server's own request log (native requests carry the
browser UA, proxied ones the proxy's): `poster`, `input[type=image]`, table
`background`, `link[imagesrcset]`, SVG `<image>` (attribute and `baseVal`),
`image-set()`, `mask-image`, `content: url()`, `shape-outside`, `@import`,
`body.background`: **parity**. Serialization keeps the author's literal text
: **fixed** (compat `ser*`).

| Item | Status | Evidence |
|---|---|---|
| `srcset` with comma-containing `data:` | **fixed** | static-policy srcset tests |
| `importmap` / `speculationrules` | **fixed**; read-back relative-as-absolute is **residual** | surface `importmapBare`, `importmapText` |
| `<template>` contents | **fixed** for serialization (the scrub walks template content) and `template.innerHTML` writes; URLs inside a template nested in inserted HTML are rewritten only when instantiated into the document: **unverified** | e2e `template link suppression preserves DOM absence` |
| declarative shadow DOM | **fixed** | surface `shadowDom` |
| SVG `href` / `xlink:href` | **fixed** | surface `svgImage`, `svgAnchor`; compat `jSvgBaseVal` |
| `<meta http-equiv=refresh>` | **fixed** | A9 |
| `origin-trial` http-equiv | **fixed**: neutralized | N/A |
| `<script>` text read-back | **fixed**: deproxied | surface `importmapText` path |
| CSS `insertRule`/`replaceSync`/`cssText`/Typed OM/`style` | **fixed** | surface `insertRuleUrl`, `styleAttrUrl`, `sheetHref` |
| error / truncated documents | **fixed** | e2e `error and truncated documents still transform` |
| `<base>` static | **parity** | compat `baseURI` |
| `charset` transcoding (EUC-KR, Shift_JIS) | **residual** (Q4) | N/A |
| `cursor: url()`, `@font-face src`, `<noscript>`, MathML `href`, `set-cookie`/`default-style` http-equiv, `link[disabled]`/`media`, `nonce`/`crossorigin`/`referrerpolicy`/`fetchpriority`, split-tag `document.write`, srcdoc entity decoding, double-rewrite of unknown shapes | **unverified** | N/A |
| `xml:base`, microdata URLs, `<applet>`, appcache | out of scope | N/A |

---

## K. CSP over-restriction: **fixed**

The CSP suite checks both directions in a real browser: legitimate resources
load (inline `<script type=module>` via `blob:`: the top-priority check:
`fetch('data:')`, `fetch(blob:)`, `data:` images/styles; `data:` fonts and media
raise no violation), blocked ones raise `securitypolicyviolation`
(`object-src`, `base-uri`), sealed paths fail before CSP (`frame-src data:`,
`worker-src blob:`: **intentional**), `unsafe-inline`/`unsafe-eval` paths
work, CSP `<meta>` is intersected rather than dropped, reports reach the server
log. Prefetch/manifest raise no violation in headless Chrome (no fetch at
insertion time; the directive's absence is pinned by the header check).

---

## L. Fingerprint / identity leakage: **fixed**, residuals listed above

Error stacks and `ErrorEvent.filename` (sanitized + `sourceURL` tagging: dyn
`leak*`, surface error probes), `arguments.callee` / `fn.toString()` on dynamic
functions, `console.log(location)` (surface `consoleString`), performance entry
names (including the navigation entry's load URL: surface `perfNavEntry`),
`document.scripts`, `__zp_*` own names, hook `.name`/`.length`/`.toString()`,
prototype shapes (`test/browser/protoshape.sh`), SharedWorker and OPFS names:
**fixed**. Real device/environment values are **intentional** (Q6). Residuals:
V8 call-printer messages, worker-realm `toString`, `data-zp-*` selector
oracles, TDZ filename (see the residual table).

---

## M. Performance / hang risks: measured

Loop caps: `while(true)`/`for(;;)`/`for(init;;update)` capped at 10M,
`do{}while(true)` at 10M+1, non-constant tests deliberately uncapped (perf
`cappedWhile`, `cappedFor`, `cappedDo`, `normalLoop`, `nestedLoops`).
Async polls keep `await`/`break` semantics (perf `asyncPollBreak`,
`asyncPollFlag`). Membrane hot loop ~1.1 s per 6.8M reads, MutationObserver
~40 ms per 2k nodes, bulk DOM 5k nodes ~30 ms, five iframes ~0.5 s (perf
`membraneRead`, `moOverhead`, `bulkDom`, `iframes`). Prelude re-parse per frame
and rewriter latency on large bundles: **residual** (performance track). Rewritten code's own cost:
helper names looked up through `with` traps, one megamorphic helper per computed member, dynamic code rewritten on
every evaluation (on Turnstile's widget the renderer is busy for 6.9 s of 15).

---

## N. Confirmed-correct behaviors (do not regress)

All hold and are pinned by the differentials above.
(`baseURI` lives on `Node.prototype`, not `Document.prototype`; the prototype-shape axis checks it.)

---

## O. Test-suite proposal: **delivered**

| Proposal | Delivered as |
|---|---|
| O1 rewriter matrix | `crates/zp-rewriter/tests/matrix.rs` |
| O2 prelude units | `test/js/prelude-units.test.js` |
| O3 static-policy extensions | `test/js/static-policy.test.js` (CSP matrix, forbidden patterns) |
| O4 escape (E1 extension) | e2e `A-section escapes stay virtual or fail closed` |
| O5 compat differential | e2e `direct-vs-proxy compatibility differential` (+ J loads) |
| O6 iframe | e2e `iframe suite` |
| O7 worker | e2e `worker suite` |
| O8 CSP | e2e `csp suite` |
| O9 dynamic | e2e `dynamic code suite` + native differential |
| O10 perf | e2e `perf suite` |

---

## P. Priority tiers: closed

Every P0 security item (A1-A9) is **fixed** with a browser pin; P0
compatibility items (`script-src blob:` for inline modules, `new URL(rel)`,
`location === document.location`, `connect-src data:`) are **parity**. P1/P2
are statused in their sections.

---

## Q. Surface Coverage Summary

Summary of surface status across realms:
Q1 `self.name`: **fixed** (SharedWorker requested name; dedicated workers pass
through natively); Q4 script-text writes: **fixed**, `link.disabled`/`media`,
MathML, `<noscript>`, exotic `http-equiv`, exotic `srcset`, double-rewrite:
**unverified** (J table); Q5 `with(obj)` is not statically bound (D), the
`eval\`x\`` tagged template is parity (E),
`x?.location?.()` is parity (C).

### Q1. Worker realm surface

- `self.origin`, `self.isSecureContext`, `BroadcastChannel`, `webkit*` aliases, OPFS: fixed (W8-W12).
- `self.crossOriginIsolated`: residual (target header set not tracked).
- `self.indexedDB`/`caches`/`cookieStore`/`locks`/`credentials`/`ShadowRealm`: fixed.
- `navigator.userAgent`/`appVersion`/`platform`: fixed (spoofed to the captured build).
- `self.EventSource`, sync `XMLHttpRequest`: residual (reconnect / readyState fidelity approximate).
- `self.WebSocket` brokered, `WebSocketStream` blocked; `WebTransport` gateway wrapper or `NotSupportedError` stub: intentional. `RTCPeerConnection` is native and relay-only: with TURN credentials it gathers relay candidates, without them it gathers none (its local API works), and the rejecting stub remains only for a browser that has no `RTCPeerConnection` (a Turnstile widget builds an offer and reads its codecs).
- Permission-gated and hardware APIs: fingerprint / intentional.

### Q2. Page realm: isolation / origin leaks

`isSecureContext`, `webkitURL`, `webkitIndexedDB`/`webkitIDB*`, legacy
filesystem/quota, OPFS, `permissions.query`, Privacy Sandbox, `fetchLater`:
fixed (P4-P13). `customElements`: **not a bug** (the registry is per Window, not
per origin; per-target prefixing would isolate nothing). `history` traversal, `window.open('javascript:')`
realm, `iframe.csp`/`credentialless`, `XSLTProcessor`: residual.
`document.implementation.createHTMLDocument()`: fine.

### Q3. Sanitizer / serialization surface

`setHTML`, `parseHTMLUnsafe`, `getHTML*`, `XMLSerializer`, filtered collections
: fixed; serialization is literal-exact and side-effect free.

### Q4. Script scheduling / HTML transform

Inline scripts execute natively in place; `nomodule` fine; `document.write`
transformed (split tags unverified); `charset` transcoding residual; dynamic
`<base>` intentional.

### Q5. Language-semantics residuals

Dangerous-name write targets, cross-script lexicals, direct eval, Annex B,
`new.target`, eval completion values: fixed. TDZ filename, module-scope eval,
direct eval inside `with`: residual.

### Q6. Fingerprint / real-environment surfaces: Phase-3 track

Screen/viewport, `Intl`, device, media, sensors, hardware: real by design;
`speechSynthesis` voices, memory/concurrency: spoofed
(intentional); copy/drag `text/uri-list` shows the proxy URL string and
sourcemap line mapping is approximate: residual.

### Q7. Still intentional fail-closed: do not "fix" without a design

`credentials.*`, `ShadowRealm`, `serviceWorker.register`, notifications,
worker `WebSocketStream`, `iframe.src` `blob:`/`data:`/`javascript:`,
`<object>`/`<embed>`/`<portal>`/`<fencedframe>`, `frame-src data:` /
`worker-src blob:` seal, non-http `location.assign` targets other than
delegatable schemes, `new Function`/`eval` rewrite failures, `PaymentRequest`,
dialog stubs, `document.domain` no-op, `registerProtocolHandler` facade,
`window.name` store, `navigation` facade, `cookieStore` jar: pinned in
[docs/containment-gates.md](containment-gates.md).

### Q8. Landed Surface Fixes

W8-W12, P4-P14: see `test/e2e/proxy.test.js` (`worker virtual surfaces
(W8-W12)`, `surface suite`) and [docs/containment-gates.md](containment-gates.md).
