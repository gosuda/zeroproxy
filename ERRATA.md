# ZeroProxy — Compatibility & Containment Errata

Risk inventory for JavaScript / iframe / eval / scope / rewriter / CSP behavior,
first produced to build the long-tail test set (commit `6633629` — the original
analysis text for every item below is there). This is a **risk inventory, not a
fix record**: an item counts as resolved only when a current test proves it.

Security-critical means a path that can produce a **real, unproxied target
navigation/request or a leaked real object** — an escape from the no-escape
jail. Compatibility-only means site breakage without an escape.

---

## Status — audit of 2026-09-29

Every item below now carries a **status** and the **evidence** that backs it,
re-verified on current `main`. Where native behavior is the question, the
evidence is a **direct-vs-proxy differential**: the same fixture runs in plain
Chrome and through the proxy, and every probe must match unless it is listed as
an intended divergence with its reason. (Pins that were written from proxy-only
runs turned out to certify divergences as "design" — see
[trap-notebook rewriter.md#프록시-단독-핀](.ai/trap-notebook/rewriter.md#프록시-단독-핀).)

| Differential (all in `test/e2e/proxy.test.js`) | Probes | Diverging |
|---|---|---|
| `direct-vs-proxy compatibility differential` (B, C, I, A5, J) | 63 | 0 |
| `dyn probes match native Chrome (direct-vs-proxy)` (E, G) | 52 | 0 |
| `surface probes match native Chrome except documented divergences` (F, H, J, L, Q) | 116 | 15, each listed with a reason |
| `J: every URL form loads through the proxy exactly when it loads natively` | 12 | 0 |
| `window.name stays with its own frame and lock queries stay inside the site` (an unnamed, a cross-site and a named frame; the parent's name before and after a child names itself; `navigator.locks.query()`) | 7 | 0 |
| `cookies set by fetch and XHR responses are visible to the page and match native` (a plain response, HttpOnly, XHR, a redirect hop, `credentials: omit`, update, `Max-Age=0`, `cookieStore`, change events, what the next request carries) | 12 | 0 |
| `storage events stay inside the writing site and match native` (cross-site and same-site writes, an unchanged value, update, remove, `onstorage`, the frames' own view, a synthetic event) | 9 | 0 |
| `cross-site frame and popup access matches native` (frames and a popup in both directions, `postMessage`, named lookups, replies) | 150 | 2 — a same-site child's `top`/`parent` read through a local alias (residual, below) |

Suite totals (2026-10-02): e2e 197/197 — including the WebTransport gateway
(`test/e2e/wt-gateway.test.js`) and relay-only WebRTC (`test/e2e/rtc-relay.test.js`)
round trips in a real browser — `npm run test:js` 126, `test:wasm:ci` 13,
`cargo test --workspace` 293, `go test ./...` green. Real sites (paired
`test/browser/rendercheck.sh`, cold profile): GitHub height 100% / elements
1811 of 1811 / err 0, Wikipedia 100% / err 0, NAVER 95% / err 1, Stack Overflow
110% / err 6 (FedCM policy block, an ad partner's 502s, one sandboxed-frame
notice), CNN 100% / 4093 of 4095 / err 22 (ad and ID-sync hosts refusing proxied
requests, strict-MIME refusals of those error bodies, sandboxed-frame notices —
no script exceptions), Cloudflare-fronted gosuda.org and MDN 100% / err 0.
Re-checked after the cross-site work (2026-10-02, items 29–32): GitHub 100% /
1809 of 1809, Wikipedia 100% / 2410 of 2411, CNN 100% / about 4050 of 4050 in
five rounds on an idle machine (three earlier rounds taken while a compile was
running read about 3915 elements and 35 of 41 above the fold; twenty structure
captures and six growth curves afterwards show no difference from the previous
build, and the cause of those three was not isolated), NAVER 79–103% (the
previous build 91–97%; native Chrome itself swings 2983–3606 px and 1060–1445
elements between two loads, so only the spread says anything). The two
`pm-drop` records NAVER leaves in `__zp_diagnostics` are native behaviour: its
React effect posts `updateTheme` to an iframe it has just created, whose window
is still the initial `about:blank` with the embedder's origin — native drops
it too (the child's own receive log never sees it).

**Status vocabulary** — **fixed** (closed; evidence names the pin) · **parity**
(measured identical to native Chrome) · **not a bug** (the original claim was
wrong; reason given) · **intentional** (deliberate fail-closed or scoped
divergence, pinned) · **residual** (known, documented, not fixed — reason given)
· **unverified** (no current evidence either way).

### Found and fixed during this audit

1. Top-level `const x = {…}` written without a semicolon: the R1 `__zp_lex_bind`
   call was glued onto the initializer (`{…}__zp_lex_bind(`), a SyntaxError that
   killed the whole script. — `e96f1e9`, matrix `lex_registry_for_classic_toplevel`.
2. `el.onclick = 'code'` / `window.onX = 'code'` were **compiled and executed**;
   Chrome turns a string on an `on*` property into `null`. — `dc232a4`, dyn `handlerPropString`, `winHandlerString`.
3. Indirect `eval` evaluated non-strings (`eval\`x\``, `(0,eval)(obj)` ran
   `obj.toString()`). — `dc232a4`, dyn `evalTagged`, `evalObjectArg`.
4. Indirect `eval` **re-executed** code that threw at runtime (a `catch {}` +
   Function-body fallback); the same fallback made `eval('return 1')` return 1.
   — `dc232a4`, dyn `evalRuntimeOnce`, `evalReturnStmt`, prelude-units.
5. Parse failures in `eval`/`Function` threw `NotSupportedError` (native:
   `SyntaxError`); `setTimeout('bad')` threw at registration (native: reported
   when the timer fires); `eval('')` threw. — `dc232a4`.
6. Literal `import('data:…')` / `import('blob:…')` bypassed the rewriter (only CSP
   stopped it). — `dc232a4`, matrix `dynamic_import_data_blob_literals_take_runtime_path`.
7. `Reflect.setPrototypeOf(window, x)` succeeded on the facade (native: immutable
   prototype). — `dc232a4`, compat `setProto*`.
8. Reading `innerHTML`/`outerHTML`/`getHTML`/`XMLSerializer` **fetched
   resources** and **ran custom-element constructors**: the scrub copy was a live
   `cloneNode`. Now an inert-document copy. — compat `serParsed` + wire check.
9. Serialization turned relative URLs absolute, and runtime `transformHTML`
   never stashed literals (the server htmltx did). — compat `ser*`, surface `getHTMLClean`.
10. IDL writes that skip the `setAttribute` hook — `input.src`, `body.background`,
    SVG `href.baseVal` — found by measuring every `url_surfaces.json` pair in
    Chrome. — compat `jInputSrcProp`, `jBodyBgProp`, `jSvgBaseVal`, `jSvgHrefShape` + J loads.
11. `new SharedWorker(u)` got the name `'default'` (native `''`, and it collided
    with `{name:'default'}`); the legacy string form lost its name. — static-policy
    `prefixedSharedWorkerOptions`, surface `childSharedWorker`.
12. The OPFS root handle's `.name` read `zp:o:<hash>` (native `''`). — surface/worker `opfsName`.
13. The navigation performance entry followed later hash writes (native: the load URL). — surface `perfNavEntry`.
14. `<script type=importmap|speculationrules>` read-back returned the rewritten
    JSON with proxy URLs. — surface `importmapText`, `specrulesText`.
15. `<a ping>`: `getAttribute`/`hasAttribute`/`getAttributeNames`/serialization
    read `null` (the value is stashed so the browser never pings on its own). — surface `anchorPing`.

Found by the real-site pass that followed (a cold GitHub load showed eight
errors; each fix exposed the next layer):

16. `<script type=module>` was rewritten as **classic** — the SW cannot tell a
    module fetch from a `crossorigin` classic one — so the R1 lexical prologue
    made modules collide on their own top-level names (GitHub
    `global-banner-disable`: "Identifier 'e' has already been declared"; NAVER at
    8% height). The kind now travels in the URL, byte-identical to static
    `import`; dynamic scripts re-derive it at insertion. — htmltx
    `module_script_src_carries_module_kind`, dyn `staticModuleLex`,
    `dynModuleTypeAfterSrc`, matrix `module_syntax_under_classic_request_gets_module_semantics`.
17. `customElements` per-target prefixing (2026-09-24) was **removed**: the
    registry is per Window and never outlives its document (measured in Chrome
    152, including initial-`about:blank` reuse), so it isolated nothing — while
    `closest`/`matches`, CSS type selectors and element identity broke, and all
    six GitHub React partials died ("No embedded data provided"). — surface `customElUpgrade`.
18. React's `Error.prepareStackTrace` save/restore bound our hook to itself:
    after the first restore **every** `.stack` overflowed the stack (page and
    worker copies). — prelude-units stack-sanitizer tests.
19. The worker realm lacked 15 helpers the rewriter emits (`Object.keys(o)`,
    `delete o[k]`, `Reflect.get`, `o?.[k]` all threw `ReferenceError`), and
    about:blank child frames lacked the R1 lexical helpers. — static-policy
    helper-coverage guard (page × worker × child), browser differentials.
20. Optional chains lost short-circuiting: `a?.[k]` became `__zp_oget(a,k)`,
    which evaluates `k` first, and `a?.[k].b` threw on a nullish `a`. GitHub's
    landing app drew its error page on `e.poster?.[!e.poster.mobile …]`. Chains
    now rewrite into continuations (`__zp_ochain`). — rewriter.test.js
    optional-chain differential (25 cases vs native), matrix optional-chain pins.

Found on CNN (Permutive and Rubicon SDKs):

21. An arrow's expression body got the statement-position ASI guard `0,`:
    `(e,t)=>t[e]??=[]` became `(e,t)=>0,(…)` — a SyntaxError that killed the
    script, or (`return(d="")=>e[d]||=…`) valid syntax that read the arrow's
    parameter outside it (`d is not defined`). — matrix
    `arrow_expression_body_is_not_a_statement_position`.
22. `new Worker(u); URL.revokeObjectURL(u)` — natively safe, but our worker read
    its source after the page had revoked it. The source is now fixed at
    construction through a proxy-owned copy URL. — dyn `blobWorkerRevoked`.
23. In workers, native methods reached through `self`/`globalThis`
    (`self.addEventListener`, `self.setTimeout`, `self.atob`) threw `Illegal
    invocation` — the scope proxy handed them out unbound — and the `Function`
    facade's `prototype` was an empty object, so `Function.prototype.toString`
    returned `[object Function]`. — dyn `workerSelfMethods`.

Found chasing the one CI failure left after those (2026-10-01) — `targetFramename`
passed locally and failed on GitHub's runner. It had never measured what it
claimed:

24. A link with `target=<frame name>` loaded the `?via=` **launcher** into the
    frame. The parent's sweep then contained the launcher, its `URL` facade
    decoded `via=`, and it redirected to `proxy.localhost:<target port>` —
    CSP-blocked. The frame never reached the target; the probe passed by reading
    the launcher URL, which decodes to the target. `setAttribute('target', name)`
    (neutralized to `_self`) navigated the **whole page** instead, `<base target>`
    was ignored, and `window.open(url, name)` also parked the launcher in the
    frame. All four now take the proxied frame route. — surface `targetFramename`,
    `targetFramenameAttr`, `baseTargetFrame`, `namedOpen` (each waits for the
    destination document).
25. The parent's containment **overwrote a child's own membrane** on the first
    `contentWindow`/`contentDocument` read (or sweep) — `define` may overwrite a
    writable slot. Only `src`-routed frames were spared, by their
    `data-zp-target-url` stash; a frame sent by `contentWindow.location`, by
    itself or by a named target ran the parent's helpers: its code read the
    parent's location and storage partition, and the parent read the child's
    location as its own URL. — surface `childLocAssign`.
26. **Escapes**: `iframe.contentWindow.eval(…)` ran unrewritten code at the
    proxy origin (raw storage of every target, the real `/zp/p/` URL) in three
    windows — the blank page in front of a pending `src` route, a routed frame
    later moved to `about:blank` (the stash exemption was sticky), and a routed
    HTML document with none of `html`/`head`/`body`/`script` (the streaming
    transform had no anchor, so it got **no prelude at all** — no membrane, no
    CSP meta). Containment is now decided by the current document; htmltx always
    injects. — surface `pendingRouteEval`, `staleBlankEval`, `routedPlainEval`;
    htmltx `prelude_is_injected_into_tagless_documents`.
27. Navigation targets end to end. `target` was rewritten to `_self` on every
    link and form (a May rule that predates the `?via=` launcher), so
    `target=_blank` opened in place, `_top`/`_parent` inside a frame moved only
    the frame, and `getAttribute('target')` read `_self`. Forms ignored
    `target`/`formtarget` entirely — a POST into an iframe (3-D Secure, embedded
    checkout) replaced the whole page. Popups ran the share launcher before
    their document (raw to the opener's handle while it redirected), and a
    `noopener` popup never navigated at all (it opened about:blank and got
    `null` back). Now nothing rewrites `target`; links and forms resolve it per
    "choosing a navigable" — frames take the frame route, ancestors navigate
    through their own membrane, new windows open natively (`_blank` with
    noopener); a POST carries its body into whichever window loads it; popups
    are routed up front (OPEN_SHARE from the opener). — surface
    `targetFramenameAttr`, `targetAttrReadback`, `parentTargetLink`,
    `formTargetGet`, `formTargetPost`, `popupRouted` (all native-identical).
28. Frame `load` events and history. A frame loaded through `src` ran its `load`
    handlers once per placeholder page and once per routed document — an inline
    `onload` on a parsed `<iframe src>` three times, native once — and every
    placeholder navigation added a joint-history entry. A frame that already
    shows a routed document now keeps it until the new route is ready; any other
    frame keeps the placeholder, whose `load` is swallowed. — e2e `frame load
    events and history match native` (native reference values pinned).
29. **Windows of another site.** Every proxied frame shares one physical origin,
    so the browser's same-origin policy cannot tell two sites apart. A parent could
    read a cross-site child's `document`, storage, `eval` and name; the child could
    read the same off its parent, and reach the embedder's DOM through
    `frameElement` (native: `null`). The membrane now does what the browser cannot:
    a window whose *virtual* origin differs is handed out only as a stand-in that
    follows the HTML cross-origin rules — thirteen names, `SecurityError` for the
    rest including every mutation, empty `Object.keys`, null prototype — from every
    source: `iframe.contentWindow`, `contentDocument` (`null`), `frames[i]` and
    named lookups, `window.open()`, `event.source`, and `parent`/`top`/`opener` seen
    from the other side. — e2e `cross-site frame and popup access matches native`
    (150 probes, both directions, frames and a popup).
30. Same-site `parent.document` / `top.document` read `undefined` (the ancestor
    stand-in returned own expandos only) and `'document' in parent` was false —
    legacy frames resize themselves with `parent.document.getElementById(…)`. The
    stand-in now forwards to that ancestor's own page-facing window. — `c2p.same.*`.
31. **`postMessage` target origin.** Every http(s) target origin was rewritten to
    the proxy's own, which every frame shares: a message addressed to one site
    reached any other site's frame (your own origin, `'/'` and the one-argument
    form sent to a cross-site frame all arrived; native drops them). The options
    form `postMessage(msg, { targetOrigin, transfer })` threw a `SyntaxError`
    (the object was stringified). Now compared with the destination's virtual
    origin, and both signatures work. — `pm.*`.
32. Message events as the receiver sees them. `e.origin` of a message from the
    parent, a sibling or an opener was the proxy's own origin (the lookup used a
    per-realm `Symbol`, invisible across realms): widgets that check their
    embedder's origin rejected it, and the proxy address leaked. A bare
    `addEventListener("message", f)` (undefined receiver) skipped the wrapper
    altogether. The event was rebuilt — `isTrusted` false, no `target`,
    `stopImmediatePropagation` inert — and is now the real event with
    non-enumerable `origin`/`source` overrides; `e.source` is the very handle the
    page holds (`=== iframe.contentWindow`, `=== parent`). `postMessage.name`
    read a minified `n` and `.length` 3 (native 1). — `reply.*`, `source.*`.
33. **`storage` events crossed sites.** Every proxied site shares one physical
    origin, so the browser fired its own `storage` event in every frame of every
    site for any site's write: one site heard another's `localStorage` writes —
    the physical key (our prefix) **and the new value** — and, ten times a second
    per window, our own `__zp_hb` heartbeat and `__zp_trace_log` (a 6 KB internal
    trace); events of its own site carried the prefixed key and a raw `Storage`
    as `storageArea` (`e.storageArea === localStorage` was false). Every window
    now registers a first, capture-phase listener that swallows what is not its
    namespace's and presents what is under the page's own key with its own
    `Storage` as `storageArea`; the page's `addEventListener`, `onstorage` and
    `<body onstorage>` all run after it. `dispatchStorageEvents`, which looked like
    the mechanism and had no caller, is gone. — e2e `storage events stay inside the
    writing site and match native`.
34. **Cookies a server set in answer to the page's own `fetch` / XHR were not in
    `document.cookie` or `cookieStore`.** The page's copy of the jar is a snapshot
    taken at load plus the document's own writes; the service worker kept the
    response's cookies for the next request (they were sent) but never told the
    page. A script that reads an anti-forgery token or a session marker the
    server just issued saw nothing until the next load. The service worker now
    returns, in the fetch metadata it already sends, the non-HttpOnly cookie
    lines each hop set (every redirect hop, `credentials` honored); the page
    applies them before the promise resolves — same domain/path rules, `cookieStore`
    change events included, cookies of another host not kept. Beacons go the same
    way. — e2e `cookies set by fetch and XHR responses are visible to the page and
    match native`.
35. **A same-site frame's `window.name` was its parent's, and `navigator.locks.query()`
    listed every site's locks.** Both are state keyed on the shared physical origin.
    The name store was keyed by tab and origin hash, so a frame read its parent's
    name instead of its own (and, in a tab that had already shown that site, a
    stale name an earlier document left) — a name belongs to a browsing context, not
    to an origin. A frame now uses its real `name` (the iframe's, as natively); only
    the top window keeps the store. `LockManager.query()` filtered nothing: other
    sites' locks came back under their raw `zp:lk:<hash>:` names (other sites' names,
    and a prefix that names the proxy). Now only the site's own, unprefixed. — e2e
    `window.name stays with its own frame and lock queries stay inside the site`.

### Residuals (documented, not fixed)

| Residual | Why it stays | Pin |
|---|---|---|
| A srcdoc child reports the parent's virtual URL, not `about:srcdoc` | Needs the document URL split from the origin identity that drives storage, cookies and `postMessage` (100+ uses of `virtualURL`). | surface `framesByName`, iframe `srcdocLocation` |
| V8 names the rewritten callee in some messages (`__zp_get(...).item is not a function`) | V8 renders the call-site AST; matching it needs per-call emission changes. Only buggy call sites surface it. | surface `framesItem` |
| Direct `eval` inside `with(o)` does not see `o` | The eval descriptor carries lexical bindings, not with-objects. Rare (legacy templating uses `new Function`). | surface `withEvalScope` |
| A `var` from a script rejected for redeclaration survives as `undefined` | Eval declaration instantiation runs before the emitted conflict check; splitting the check trades this for registrations surviving a syntax error. | surface `ownKeysLeak` |
| An uninitialized-lexical (TDZ) `ReferenceError` is thrown from the prelude, so `ErrorEvent.filename` is the prelude URL | Moving the throw into emitted code means emitting a check per read. | [trap 에러-filename-누출](.ai/trap-notebook/rewriter.md#에러-filename-누출) |
| `Document.parseHTMLUnsafe` anchors resolve against the virtual base (native: no base, raw text) | Inert parsed documents share the realm's URL hooks. Minor. | surface `parseHTMLUnsafeHook` |
| import-map / speculation-rules read-back returns relative URLs as absolute | The server does not stash the original JSON; read-back is deproxied. | surface `importmapText` (checks no proxy URL) |
| Worker-realm hooks are not `toString`-masked | `worker-prelude.js` has no masking helper; hook sources are visible to worker code. | — |
| CSS attribute selectors / XPath can detect `data-zp-*` stash attributes | Getters are filtered; selector matching is not. Fingerprint only. | — |
| `while (true) { await … }` without `break` dies silently at 10M iterations | Deliberate hang protection; hours of wall time in practice. | [trap loop-cap-비상수-정책](.ai/trap-notebook/rewriter.md#loop-cap-비상수-정책) |
| `navigator.storage.estimate()` reports proxy-origin-wide usage | Quota is per real origin; usage leaks only a byte count across targets. | — |
| Storage Access API answers as first-party in every frame | All targets share the proxy origin. | — |
| Optional chains with `await`/`yield` after the first `?.`, or with a `Reflect.get?.()`-style special form at a split, keep per-link emission (keys/args evaluated even when short-circuited) | A continuation arrow cannot hold `await`/`yield`; unwrapping a special form would hand out the unmediated native. | matrix optional-chain negative controls |
| `<link rel=preload as=script>` for a module script is fetched again by the module | The preload goes to the classic route; the module needs `kind=module` in its URL. | [trap module-kind-url](.ai/trap-notebook/rewriter.md#module-kind-url) |
| Ad and ID-sync hosts (Google ads, Amazon, FreeWheel, Optimizely events, …) refuse proxied requests | Their decision, not request shape: `sendBeacon`/`fetch(keepalive)`/form POST bodies and content types arrive byte-identical to native (measured). IP reputation and fingerprint — Phase 3. | — |
| The prelude logs "Blocked script execution in 'about:blank'" while touching sandboxed ad frames | Console noise only; the frame is sandboxed without `allow-scripts` either way. | — |
| **Escape window:** a routed HTML document (frame or popup) is unmembraned between its commit and its prelude's first script — tens of ms, at least one task boundary. A hostile page holding the window (`iframe.contentWindow`, an `open()` handle) and polling for the new document can call that realm's raw `eval`, or copy its natives out with `Object.values(w)`, in the gap. | No in-document fix exists: the gap opens before the first byte parses. Containing the window there leaves a pre-instrumented realm (the parent's `fetch`/XHR bound in, non-configurable prototype hooks over the child's), which breaks the child. Closing it means the membrane wraps every foreign window handle (`contentWindow`, `open()`, `opener`, `event.source`, `frames[i]`) — a redesign. Bounded: once loaded, a document that never booted is contained; the popup launcher's longer raw stretch is gone (item 27). | [trap 라우팅-프레임-탈출](.ai/trap-notebook/rewriter.md#라우팅-프레임-탈출) |
| A frame that navigated itself (or was sent by a descendant) to a document with no prelude (text/plain, an image) reads back the URL it was first sent to | The parent maps only routes it opened; another realm's `/zp/p/` token is not decryptable here. HTML documents report their own URL. | — |
| A window handle read while the window was still **same-origin** keeps working after it navigates to another site | The raw window cannot be revoked; only handles the membrane gives out after the origin is known are restricted. Covered: a frame sent to another site (restricted from the start, its blank placeholder too) and a popup opened with a URL. Not covered: the blank page of a frame read BEFORE its `src` is set, or a popup opened blank and navigated later. | — |
| A frame reached by a **bare identifier** (`fname.document`) is the raw window | A free identifier resolves through the browser's own global lookup, which no hook sees. Lookups through `window`, `self`, `top`, `frames` — bracket or dot — are covered. | — |
| `w.top` / `w.parent` read through a **local alias** of a same-site child window are raw windows, not `=== window` | The rewriter leaves window-chain members unwrapped on local aliases: the ancestor-climbing loops of ad and consent code froze the renderer when they were wrapped (CNN, 2026-08-24). Same-site only; cross-site handles are stand-ins, so every read is intercepted. | e2e `cross-site frame and popup access matches native` (`p2c.same.top`, `p2c.same.parent`) |
| A message event carries own `origin`/`source` properties (non-enumerable) | `Object.getOwnPropertyNames(e)` lists them; `Object.keys(e)`, `isTrusted`, `target` and `currentTarget` match native. | — |
| `localStorage.clear()` of a same-site window arrives as **one event per removed key** (native: a single event with `key: null`) | The facade clears only its own namespace, key by key — the real `clear()` would wipe every site's. Visible only to a second same-site window that listens. | — |
| `e.url` of a storage event is the **receiving** document's virtual URL, not the writer's | The physical URL of the writer is a share route the receiver cannot read. The origin is right. | — |
| A storage event carries own `key`/`storageArea`/`url` properties (non-enumerable) | `Object.getOwnPropertyNames(e)` lists them; `Object.keys(e)`, `isTrusted`, `target` match native. | — |
| A cookie set by **another document's** response — a frame's navigation, another tab — or by an **`<img>` / `<script>` / synchronous XHR** response is not in a document's `document.cookie` until it reloads; same-site frames keep **separate copies** of what scripts write at runtime | The page's copy of the jar is a load-time snapshot plus its own writes and its own fetch / XHR responses (item 34); the service worker holds the real jar and sends it with every request, so requests are right. Sharing the copy needs the worker to push changes to every client of the tab and a rule for racing writers. Measured 2026-10-02: a parent does not see a same-site child's `document.cookie` write, nor the child the parent's; `localStorage` is shared. | — |
| An iframe sandboxed **without `allow-same-origin`** (`sandbox="allow-scripts"`, `sandbox=""`) is **removed from the DOM** the moment it is inserted | Fail-closed, and old — the build before the 2026-10-02 work does the same. The parent can neither read nor patch an opaque-origin window; `instrumentIframe` takes that for a containment failure and removes the frame. Lifting the guard is not enough (measured 2026-10-02): the frame's own document drew a 403 from the proxy, and its prelude aborts at the first origin-restricted API (`localStorage` throws `SecurityError`), which would leave a half-installed document running page scripts. Supporting it needs an opaque-origin mode in the prelude (storage, cookies and `caches` throw, origin `null`) and a decision on the server's policy for `Origin: null` requests. Sandboxes that include `allow-same-origin` are virtualized and work. | — |
| `iframe.sandbox` (the `DOMTokenList`) is empty for a value the membrane virtualized (`allow-scripts allow-same-origin`: native length 2, ours 0) | `getAttribute('sandbox')` is right. The real attribute is removed so the browser does not enforce flags that would let the frame escape; the list is the real element's. | — |

---

## A. Security-critical escape vectors

Evidence for this section: e2e `A-section escapes stay virtual or fail closed`
(browser, every probe reads virtual or fails closed), `escape matrix`, and the
rewriter emission tests in `crates/zp-rewriter/tests/matrix.rs`.

### A1. Top-level `var`/`function` shadowing a dangerous global — **fixed**

References to a dangerous name stay mediated even after a top-level `var` /
`function` declaration of it: `var location = …` syncs through
`__zp_set(globalThis,"location",…)`, `function location(){}` is renamed to a
temp. Verified for every dangerous global (`location`, `document`, `window`,
`top`, `parent`, `frames`, `self`, `globalThis`, `opener`, `history`, `eval`,
`Function`). Pins: matrix `var_function_shadowing_neutralized`,
`declaration_targets_sync_via_temp`; e2e `varShadow`/`letShadow`/`fnDeclShadow`.
`class location {}` at top level now fails with the native SyntaxError (R1
registry sees the unforgeable global).

- Module goal (`function location(){}` in a module) — **not a bug**: top-level
  module declarations are module-scoped, so `location` really is the local
  binding (native semantics). Pin: matrix `var_function_shadowing_neutralized` (module case).

### A2. Computed member access — **fixed**

`x[k]`, `x['location']`, `this['location']`, `frames[i]`, `x?.[k]` all route
through `__zp_get`/`__zp_set`/`__zp_call`/`__zp_oget`/`__zp_ocall`. Pins: matrix
`computed_member_reads`, `computed_member_writes_and_calls`,
`dangerous_method_calls_stay_bound`; e2e `thisComputed`, `globalComputed`, `computedAccess`.

### A3. `new Function('return this')()` — **fixed**

Sloppy dynamic functions get the scope facade as `this`, never the real window;
the Async/Generator constructors are gated the same way. Pins: e2e `fnThis`,
`fnThisNull`, dyn `fnThis`, `fnThisIsWindow`, escape matrix `asyncFunctionEscape`.

### A4. eval-expression path — **fixed**

Expression bodies go through the rewriter before the `with(__zp_scope)` wrapper.
Pins: e2e `evalHref`, `evalArith`; dyn `evalLocation`, `evalStrict`, `evalIndirect`.

### A5. Reflect / descriptor paths — **fixed**

Computed `Reflect.get/set/has/deleteProperty/ownKeys`,
`Object.getOwnPropertyDescriptor(s)`, `Reflect.getOwnPropertyDescriptor`,
`__lookupGetter__`/`__defineGetter__` are mediated or return membrane getters.
Pins: matrix `reflect_object_routing`; e2e `gopdHref`, `lookupGetter`,
`locationDescriptor(Flags)`; surface `defineGetterLoc`, `lookupGetterLoc`.
`Reflect.setPrototypeOf(window, x)` no longer touches the real window and now
refuses like native (immutable prototype); `Reflect.defineProperty(window,
'location', …)` returns false like native. Pins: compat `setProtoReflect`,
`setProtoSame`, `setProtoObject`, `protoIsWindow`, `defPropLocReflect`,
`defPropLocObject`, `preventExtWindow` — all **parity**.

### A6. `open()` returned window — **fixed**

The http branch gets network containment; `javascript:` URLs do not execute.
Pins: e2e `openJs`, `openEscaped`.

### A7. Non-root `Document.location` — **fixed**

`contentDocument.location` / `ownerDocument.location` resolve to the child's
virtual location, never a proxy URL. Pins: e2e `contentDocLocation`, iframe suite `srcVirtual`.

### A8. `window.navigation` — **fixed**

A `VirtualNavigation` facade: entry URLs read virtual, `navigate()` goes through
the virtual-location pipeline, `javascript:` is refused. Pins: e2e
`navigationJs`, `navEscaped`, `navCurrentEntry`.

### A9. Dynamic `<meta http-equiv="refresh">` — **fixed**

Both attribute orders are rewritten before the browser can arm the refresh.
Pin: e2e `metaRefresh` (neutralized).

### A10. Other real-object leak paths — **fixed / parity**

- `document.write`/`open()` second document — **fixed** (surface `docWriteFrame`).
- `window.name` — **intentional** virtual store (compat `winName` parity).
- `cookieStore` — **fixed**, backed by the jar.
- `<a ping>` — **fixed**: fired through proxy transport, never by the browser;
  read-back matches native (surface `anchorPing`, e2e `anchor ping fires through proxy transport`).
- `structuredClone`/`WeakRef`/`MessagePort` transfer — **parity**: real objects
  throw `DataCloneError` like native (surface `cloneLocation`, `portMsgLocation`).
- `frames['name']`, `self[0]`, `this[0]` — **fixed** (surface `framesByName`, `selfIndex`, `thisIndex`).
- `frames.item(0)` — **parity** (native has no `frames.item` either); the error
  *message* names the rewritten callee — **residual** (see table).
- Legacy `__lookup/__define*` accessors — **fixed** (surface `defineGetterLoc` …).
- `Object.getOwnPropertyNames(window)` — **fixed**: no `__zp_*` names (surface `ownKeysLeak`).

---

## B. Syntax-kill (whole script fails to parse) — **fixed**

Dangerous-name assignment targets (`for (location of a)`, `[location] = arr`,
`({a: location} = o)`, nested, rest, defaults, `for await`, catch, switch,
labels) emit through the `__zp_get.d` write sinks. Pins: matrix
`assignment_targets_route_through_write_facade` (re-parse checked); compat
`forOf`, `forIn`, `arrayTarget`, `objTarget`, `nestedTarget`, `forOfArr`,
`forOfObj`, `defaultTarget`, `restTarget`, `memberTarget`, `catchParam`,
`switchTarget`, `labelLoop`, `forAwait` — all **parity**.

A new syntax-kill found in this audit — R1 bind calls glued to ASI declarations
— is **fixed** (see the audit list, item 1).

---

## C. Rewriter scope/binding semantics — **fixed / parity**

| Case | Status | Evidence |
|---|---|---|
| `import location from 'x'` / named / star | **parity** — module bindings are declared locals | surface Q5 notes |
| `class location {}` | **parity** — native SyntaxError via the R1 registry | emission check above |
| `f(){ location.x; var location; }` / function hoisting / block TDZ | **parity** | matrix `local_scope_bindings_not_mediated`; compat `hoistedVar`; surface `scopeHoistVar`, `scopeTDZ` |
| direct `eval('x')` caller scope | **fixed** (R2) | compat `evalDirectLocal`; surface `evalCallerScope`, `evalCallerWrite`, `evalCallerVar` |
| `delete obj.location` | **parity** | compat `deleteMember`; surface `deleteLoc` |
| `x?.location?.()`, `x?.location`, `x?.location.href` | **parity** | compat `optCallNull`, `optMemberNull`, `optChainNull`; surface `optCallChain` |
| `for(let i=0;;i++)` | **fixed** — capped | perf `cappedFor` |
| `while(true){await x()}` | **residual** — silent stop at 10M (see table) | perf `asyncPollBreak`, `asyncPollFlag` |
| `new.target` in dynamic functions | **parity** | compat `newTargetFn` |
| `({[location]:1})` | **parity** | compat `computedKey` |
| `location ??= u`, `super.location`, `x?.m()` | **parity** | compat `nullishAssign`, `superProp`, `plainOptCall` |

Scope variants: `function f(location=location)` (compat `paramDefault`),
`function f({location})` (surface `scopeDestructParam`), `catch(location)`
(surface `scopeCatch`), labeled function declarations and Annex B (surface
`labeledFnDecl`, `annexBSloppy`), `arguments` aliasing (compat
`argumentsAlias`), eval-created bindings (dyn `evalVarVisible`), cross-script
`let`/`const`/`class`/`var` (surface `crossScript*`, `lexRedeclare`) — all
**parity**. `using` / `await using`, `eval`/`Function` bodies with `using`,
`DisposableStack` — **parity** (surface `usingDecl`, `awaitUsing`, `usingEval`,
`usingFunction`, `disposableStack`).

---

## D. `with` statement — **fixed**, one residual

Dangerous names inside `with(o)` consult `o` first (innermost-first chain);
`with(document)` keeps identity and PutForwards semantics; strict-mode `with` is
the native SyntaxError. Pins: matrix `with_body_dangerous_names_chain_innermost_first`;
surface `withShadow` (obj-first), `withDocIdentity`, `withDocWrite`,
`strictWith`; dyn `fnWith`. Direct `eval` inside `with` not seeing `o` —
**residual** (surface `withEvalScope`).

---

## E. eval / dynamic code — **fixed** (native differential: 49 probes, 0 diverging)

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
Module-scope `eval` reifying the module environment — **residual** (Q5).

---

## F. iframe / child realm

| Case | Status | Evidence |
|---|---|---|
| `contentWindow.location`, `contentDocument.location` | **fixed** | iframe `srcVirtual`; e2e `contentDocLocation` |
| `frames[i]`, `window[i]`, named frames, `iframe['contentWindow']` | **fixed** | e2e `framesIndex`; surface `framesByName`, `windowByName` |
| `iframe.src = blob:/data:/javascript:` | **intentional** — sealed (legit blob/data frames break) | iframe `blobBlocked`; CSP suite sealed-path pins |
| `srcdoc` | **fixed** (prelude injected, scripts run) | iframe `srcdocLoad`, `srcdocScript`, `nested` |
| srcdoc `location.href` | **residual** — parent virtual URL instead of `about:srcdoc` | iframe `srcdocLocation` |
| `sandbox` | **fixed** | iframe `sandboxOpaque` |
| dynamic creation / insert-remove race | **fixed** | iframe `createBlank`, `removeRace` |
| `document.write` second document | **fixed** | surface `docWriteFrame` |
| `open()` window | **fixed** | A6 |
| `postMessage` origin / source | **fixed** | iframe `postMessage` |
| identity (`contentWindow === frames[0]`) | **fixed** | iframe `identityStable` |
| `<object>/<embed>/<portal>/<fencedframe>` | **intentional** | Q7 |
| `iframe.csp` | **residual** — passes through as inert data | surface `iframeCspAttr` |
| `credentialless` | **parity** | surface `iframeCredentialless` |
| `<a target=framename>`, `setAttribute('target')`, `<base target>`, `open(url, name)` | **fixed** 2026-10-01 — the 2026-09 "fixed" rested on a probe that read the launcher URL (item 24) | surface `targetFramename`, `targetFramenameAttr`, `baseTargetFrame`, `namedOpen` |
| `target=_parent`/`_top` from a frame, `<form target>`/`formtarget` (GET and POST), popups | **fixed** 2026-10-01 (item 27) | surface `parentTargetLink`, `formTargetGet`, `formTargetPost`, `popupRouted`, `targetAttrReadback` |
| a child's own membrane survives the parent's `contentWindow` reads | **fixed** 2026-10-01 (item 25) | surface `childLocAssign` |
| blank / routed / prelude-less child windows are never raw | **fixed** 2026-10-01 (item 26) | surface `pendingRouteEval`, `staleBlankEval`, `routedPlainEval` |
| SharedWorker from a child realm | **fixed** | surface `childSharedWorker` |
| child **storage** between same-site frames, and a parent's own storage seen from a child | **parity** (measured 2026-10-01 and again 2026-10-02: keys, quota names, IndexedDB and cache names, locks, `BroadcastChannel`, events — storage events are item 33) | e2e `storage events stay inside the writing site and match native` |
| child **cookies** between same-site frames written after the other frame loaded | **residual** — each document keeps its own copy (the 2026-10-01 "parity" read cookies set before the child loaded) | See Residuals. |
| iframe `load` events and joint session history for a frame sent through `src` | **fixed** 2026-10-01 — one `load` per navigation and one history entry per change, as native; a parsed `<iframe src onload>` fires once (it fired three times) | e2e `frame load events and history match native`. See [trap 프레임-load-두-번](.ai/trap-notebook/rewriter.md#프레임-load-두-번). |
| a detached frame's window | **parity** for `eval` and `closed`; `document.URL` reports the virtual URL where native reports `about:blank` | Same virtual-URL split as srcdoc (see Residuals). |
| frames and popups of **different sites** | **fixed** 2026-10-02 (items 29–32) — a cross-site window is a stand-in that follows the HTML cross-origin rules, in both directions; `postMessage` honors the target origin; `e.origin`/`e.source` are right on the receiving side | e2e `cross-site frame and popup access matches native`. Residuals below. See [trap 교차-사이트-프레임](.ai/trap-notebook/rewriter.md#교차-사이트-프레임). |
| CSP inheritance into child frames | **unverified** | — |

---

## G. Worker realm — **fixed**, residuals noted

The worker suite pins dedicated, module and shared workers: virtual `location`,
`fetch`/XHR/sync-XHR relay, brokered WebSocket, EventSource, rewrite-then-execute
`eval`/`Function`/string timers, `importScripts` (http, `data:`, `blob:`),
namespaced storage (IndexedDB, Cache, cookieStore, OPFS, BroadcastChannel),
sanitized error stacks, W8–W12 surfaces (`self.origin`, `isSecureContext`,
BroadcastChannel prefix, `webkit*` aliases, OPFS). SharedWorker per-target name
prefix — **fixed** (static-policy `prefixedSharedWorkerOptions`). Rewriter
helpers missing from the worker realm (`__zp_okeys`, `__zp_delete`, `__zp_oget`,
`__zp_rget`, `__zp_with_*` …) — **fixed** (item 19; static-policy guard).
Native methods through `self`, the `Function.prototype` facade, and blob
sources revoked right after `new Worker()` — **fixed** (items 22, 23).
Residuals: worker hooks are not `toString`-masked; `navigator` is the spoofed
build identity (intentional); termination mid-request and multi-target workers
— **unverified**.

---

## H. Unhooked / partially hooked API surface

| API | Status | Evidence |
|---|---|---|
| `window.navigation` | **fixed** | A8 |
| `window.name` | **intentional** — virtual store | compat `winName` |
| `cookieStore` | **fixed** — jar-backed | worker/page cookieStore pins |
| `new URL(rel)` single-argument | **parity** | compat `urlCtorRel`, worker `urlResolve` |
| `import.meta.resolve` | **fixed** | surface `importMetaResolve` |
| `alert`/`confirm`/`prompt`/`print` | **intentional** — stubs (same values a dismissed dialog gives) | surface `dialogStubs` |
| `navigator.serviceWorker.getRegistrations()` | **fixed** — ZeroProxy's own SW is never exposed; **intentional** — the facade always reports one fake registration | surface `swRegs` |
| `location.ancestorOrigins` | **fixed** | membrane `07-membrane.js` |
| `history` length / traversal | **residual** (Q2) | — |
| bar props, `featurePolicy`, XPath, `ElementInternals` | **parity** — native, no URL or navigation surface | — |
| `XMLSerializer` | **fixed** | compat `serXML` |
| `Object.getOwnPropertyNames(window)` | **fixed** | surface `ownKeysLeak` |
| `el.onclick = 'code'` | **fixed** — a string is null like native | dyn `handlerPropString` |
| `adoptedStyleSheets`, `new CSSStyleSheet()` | **fixed-ish, monitor** (Q4) | — |
| `webkitTemporaryStorage`/`webkitPersistentStorage` | **intentional** — removed | surface `webkitFS` |
| file pickers, WebAuthn, PaymentRequest | **intentional** (D6 / Q7) | surface `webAuthn`, `credGet` |
| `hasStorageAccess`/`requestStorageAccess` | **residual** — first-party everywhere | — |
| `registerProtocolHandler` | **fixed** — virtual-origin facade | surface `registerPH`, `registerPHSameOrigin` |

---

## I. URL / navigation semantics — **parity**

`location === document.location`, `location.href === document.URL`,
`document.baseURI`, hash writes, `new URL` (relative / absolute / statics),
`window.name`, `document.cookie`, anchor property vs attribute, `ping`,
`history.pushState`, same-origin `fetch` — compat differential, all identical to
native. `mailto:` delegation — **fixed** (surface `mailtoNav`). Dynamic `<base>`
— **intentional** (`base-uri 'none'`; surface `dynamicBase`).

Measured against plain Chrome on 2026-10-01 with a one-off differential (not
pinned — the probes need seconds of settling per case): `location.pathname` /
`search` / `hash` writes in a child frame, `location.host` / `hostname` writes
(`SecurityError` in both), `location.replace` and `assign` joint-history
deltas, form `action` / `formAction` with an attribute set, `a.download` /
`referrerPolicy`, `window.open(url, name, 'noopener')` (returns `null` in
both) — **parity**. Two small residuals came out of the same run:

| Residual | Native / proxy | Why it stays |
|---|---|---|
| `submitter.formAction` with no `formaction` attribute | document URL / `''` | The URL-property hook returns the attribute's absence as `''`; the native getter falls back to the document URL. Cosmetic. |
| `window.open(url, name, features).opener === window` | `true` / `false` | The returned handle's `opener` is the membrane's window facade, which is not `===` the page's own `window` reference. Needs window-identity unification across facades. |

---

## J. HTML/CSS transformer residuals

Every `url_surfaces.json` pair (the single source of truth for URL-bearing
attributes) was measured in Chrome for a reflecting IDL property — the property
write that bypasses the `setAttribute` hook. The three unhooked ones
(`input.src`, `body.background`, SVG `href.baseVal`) are **fixed**. Load parity
is checked from the target server's own request log (native requests carry the
browser UA, proxied ones the proxy's): `poster`, `input[type=image]`, table
`background`, `link[imagesrcset]`, SVG `<image>` (attribute and `baseVal`),
`image-set()`, `mask-image`, `content: url()`, `shape-outside`, `@import`,
`body.background` — **parity**. Serialization keeps the author's literal text
— **fixed** (compat `ser*`).

| Item | Status | Evidence |
|---|---|---|
| `srcset` with comma-containing `data:` | **fixed** (historical trap) | static-policy srcset tests |
| `importmap` / `speculationrules` | **fixed**; read-back relative-as-absolute is **residual** | surface `importmapBare`, `importmapText` |
| `<template>` contents | **fixed** for serialization (the scrub walks template content) and `template.innerHTML` writes; URLs inside a template nested in inserted HTML are rewritten only when instantiated into the document — **unverified** | e2e `template link suppression preserves DOM absence` |
| declarative shadow DOM | **fixed** | surface `shadowDom` |
| SVG `href` / `xlink:href` | **fixed** | surface `svgImage`, `svgAnchor`; compat `jSvgBaseVal` |
| `<meta http-equiv=refresh>` | **fixed** | A9 |
| `origin-trial` http-equiv | **fixed** — neutralized | `b602610` |
| `<script>` text read-back | **fixed** — deproxied | surface `importmapText` path |
| CSS `insertRule`/`replaceSync`/`cssText`/Typed OM/`style` | **fixed** | surface `insertRuleUrl`, `styleAttrUrl`, `sheetHref` |
| error / truncated documents | **fixed** | e2e `error and truncated documents still transform` |
| `<base>` static | **parity** | compat `baseURI` |
| `charset` transcoding (EUC-KR, Shift_JIS) | **residual** (Q4) | — |
| `cursor: url()`, `@font-face src`, `<noscript>`, MathML `href`, `set-cookie`/`default-style` http-equiv, `link[disabled]`/`media`, `nonce`/`crossorigin`/`referrerpolicy`/`fetchpriority`, split-tag `document.write`, srcdoc entity decoding, double-rewrite of unknown shapes | **unverified** | — |
| `xml:base`, microdata URLs, `<applet>`, appcache | out of scope | — |

---

## K. CSP over-restriction — **fixed**

The CSP suite checks both directions in a real browser: legitimate resources
load (inline `<script type=module>` via `blob:` — the top-priority check —
`fetch('data:')`, `fetch(blob:)`, `data:` images/styles; `data:` fonts and media
raise no violation), blocked ones raise `securitypolicyviolation`
(`object-src`, `base-uri`), sealed paths fail before CSP (`frame-src data:`,
`worker-src blob:` — **intentional**), `unsafe-inline`/`unsafe-eval` paths
work, CSP `<meta>` is intersected rather than dropped, reports reach the server
log. Prefetch/manifest raise no violation in headless Chrome (no fetch at
insertion time; the directive's absence is pinned by the header check).

---

## L. Fingerprint / identity leakage — **fixed**, residuals listed above

Error stacks and `ErrorEvent.filename` (sanitized + `sourceURL` tagging — dyn
`leak*`, surface error probes), `arguments.callee` / `fn.toString()` on dynamic
functions, `console.log(location)` (surface `consoleString`), performance entry
names (including the navigation entry's load URL — surface `perfNavEntry`),
`document.scripts`, `__zp_*` own names, hook `.name`/`.length`/`.toString()`,
prototype shapes (`test/browser/protoshape.sh`), SharedWorker and OPFS names —
**fixed**. Real device/environment values are **intentional** (Q6). Residuals:
V8 call-printer messages, worker-realm `toString`, `data-zp-*` selector
oracles, TDZ filename (see the residual table).

---

## M. Performance / hang risks — measured

Loop caps: `while(true)`/`for(;;)`/`for(init;;update)` capped at 10M,
`do{}while(true)` at 10M+1, non-constant tests deliberately uncapped (perf
`cappedWhile`, `cappedFor`, `cappedDo`, `normalLoop`, `nestedLoops`).
Async polls keep `await`/`break` semantics (perf `asyncPollBreak`,
`asyncPollFlag`). Membrane hot loop ~1.1 s per 6.8M reads, MutationObserver
~40 ms per 2k nodes, bulk DOM 5k nodes ~30 ms, five iframes ~0.5 s (perf
`membraneRead`, `moOverhead`, `bulkDom`, `iframes`). Prelude re-parse per frame
and rewriter latency on large bundles — **residual** (performance track).

---

## N. Confirmed-correct behaviors (do not regress)

All still hold on 2026-09-29 and are now pinned by the differentials above.
(The list in `6633629` said `baseURI` lived on `Document.prototype`; it lives on
`Node.prototype` — the prototype-shape axis caught it on 2026-09-14.)

---

## O. Test-suite proposal — **delivered**

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

## P. Priority tiers — closed

Every P0 security item (A1–A9) is **fixed** with a browser pin; P0
compatibility items (`script-src blob:` for inline modules, `new URL(rel)`,
`location === document.location`, `connect-src data:`) are **parity**. P1/P2
are statused in their sections.

---

## Q. 2026-09-24 surface audit

Q1–Q4, Q6–Q8 as written below remain accurate, with these 2026-09-29 updates:
Q1 `self.name` — **fixed** (SharedWorker requested name; dedicated workers pass
through natively); Q4 script-text writes — **fixed**, `link.disabled`/`media`,
MathML, `<noscript>`, exotic `http-equiv`, exotic `srcset`, double-rewrite —
**unverified** (J table); Q5 `with(obj)` is no longer statically bound (D), the
`eval\`x\`` tagged template was *not* parity until this audit (E, item 3),
`x?.location?.()` — **parity**, `arguments.callee` — **fixed**.

### Q1. Worker realm surface

- `self.origin`, `self.isSecureContext`, `BroadcastChannel`, `webkit*` aliases, OPFS — fixed (W8–W12).
- `self.crossOriginIsolated` — residual (target header set not tracked).
- `self.indexedDB`/`caches`/`cookieStore`/`locks`/`credentials`/`ShadowRealm` — fixed.
- `navigator.userAgent`/`appVersion`/`platform` — fixed (spoofed to the captured build).
- `self.EventSource`, sync `XMLHttpRequest` — residual (reconnect / readyState fidelity approximate).
- `self.WebSocket` brokered, `WebSocketStream` blocked; `RTCPeerConnection`/`WebTransport` gateway wrapper or `NotSupportedError` stub — intentional.
- Permission-gated and hardware APIs — fingerprint / intentional.

### Q2. Page realm — isolation / origin leaks

`isSecureContext`, `webkitURL`, `webkitIndexedDB`/`webkitIDB*`, legacy
filesystem/quota, OPFS, `permissions.query`, Privacy Sandbox, `fetchLater` —
fixed (P4–P13). `customElements` — **not a bug** (the registry is per Window, not
per origin; the P11 prefixing was removed, item 17). `history` traversal, `window.open('javascript:')`
realm, `iframe.csp`/`credentialless`, `XSLTProcessor` — residual.
`document.implementation.createHTMLDocument()` — fine.

### Q3. Sanitizer / serialization surface

`setHTML`, `parseHTMLUnsafe`, `getHTML*`, `XMLSerializer`, filtered collections
— fixed; serialization is now literal-exact and side-effect free (audit items 8, 9).

### Q4. Script scheduling / HTML transform

Inline scripts execute natively in place; `nomodule` fine; `document.write`
transformed (split tags unverified); `charset` transcoding residual; dynamic
`<base>` intentional.

### Q5. Language-semantics residuals

Dangerous-name write targets, cross-script lexicals, direct eval, Annex B,
`new.target`, eval completion values — fixed. TDZ filename, module-scope eval,
direct eval inside `with` — residual.

### Q6. Fingerprint / real-environment surfaces — Phase-3 track

Screen/viewport, `Intl`, device, media, sensors, hardware — real by design;
`speechSynthesis` voices, memory/concurrency, canvas/audio — spoofed or noised
(intentional); copy/drag `text/uri-list` shows the proxy URL string and
sourcemap line mapping is approximate — residual.

### Q7. Still intentional fail-closed — do not "fix" without a design

`credentials.*`, `ShadowRealm`, `serviceWorker.register`, notifications,
worker `WebSocketStream`, `iframe.src` `blob:`/`data:`/`javascript:`,
`<object>`/`<embed>`/`<portal>`/`<fencedframe>`, `frame-src data:` /
`worker-src blob:` seal, non-http `location.assign` targets other than
delegatable schemes, `new Function`/`eval` rewrite failures, `PaymentRequest`,
dialog stubs, `document.domain` no-op, `registerProtocolHandler` facade,
`window.name` store, `navigation` facade, `cookieStore` jar — pinned in
`PHASE2_STATUS.md`.

### Q8. Fix list spawned by the 2026-09-24 audit — all landed

W8–W12, P4–P14 — see `test/e2e/proxy.test.js` (`worker virtual surfaces
(W8-W12)`, `surface suite`) and the `PHASE2_STATUS.md` divergence table.
