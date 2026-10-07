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
| `cookies reach every document that can see them, and no other (matches native)` (another document's response, an image, a script, a synchronous XHR, a sibling frame's write, the other site's frame, `cookieStore` change events) | 8 | 0 |
| `a cookie reaches the other tab of the same site (matches native)` (a script's write and a response, both directions) | 4 | 0 |
| `window.name stays with its own frame and lock queries stay inside the site` (an unnamed, a cross-site and a named frame; the parent's name before and after a child names itself; `navigator.locks.query()`) | 7 | 0 |
| `cookies set by fetch and XHR responses are visible to the page and match native` (a plain response, HttpOnly, XHR, a redirect hop, `credentials: omit`, update, `Max-Age=0`, `cookieStore`, change events, what the next request carries) | 12 | 0 |
| `storage events stay inside the writing site and match native` (cross-site and same-site writes, an unchanged value, update, remove, `onstorage`, the frames' own view, a synthetic event) | 9 | 0 |
| `cross-site frame and popup access matches native` (frames and a popup in both directions, `postMessage`, named lookups, replies) | 150 | 2 — a same-site child's `top`/`parent` read through a local alias (residual, below) |

Suite totals (2026-10-02): e2e 199/199 — including the WebTransport gateway
(`test/e2e/wt-gateway.test.js`) and relay-only WebRTC (`test/e2e/rtc-relay.test.js`)
round trips in a real browser — `npm run test:js` 130, `test:wasm:ci` 13,
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
    changes each hop made (every redirect hop, `credentials` honored; item 36 says
    what a change is); the page applies them before the promise resolves — same domain/path rules, `cookieStore`
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
36. **The page's copy of the cookie jar learned only its own writes and its own
    fetches.** A cookie set by another document's response (a frame's navigation),
    by an `<img>` or `<script>` response, by a synchronous XHR, by a sibling frame's
    `document.cookie`, or in another tab of the same site never reached a document's
    `document.cookie` / `cookieStore` until it reloaded (the requests carried the
    cookie — the service worker's jar was right). The jar now reports every change it
    accepts as a **record** — name, value, domain, host-only, path, secure, expiry,
    deleted, an id — and the worker pushes it to every window client whose host can see
    the cookie: in this tab and in every tab sharing the jar. A third-party frame is
    never handed another site's cookie, and HttpOnly changes never leave the worker.
    A page applies each id once (the same change arrives with the response and as a
    push), by the same domain/path rules; the document that wrote a cookie is not sent
    its own write. A synchronous XHR gets its changes in a response header (the Go
    relay lets `X-ZP-Cookie-Delta` through), because its caller reads the cookie as soon
    as it returns. Records replace the raw `Set-Cookie` lines of item 34: the jar's
    decision (rejected `Domain`, session cookies, deletion) is the only one. — e2e
    `cookies reach every document that can see them, and no other` and `a cookie reaches
    the other tab of the same site`; prelude unit tests for applying records.
37. **Frames sandboxed without `allow-same-origin` were deleted at insertion; they now run as the
    opaque-origin documents they are.** The browser gives such a frame (`sandbox="allow-scripts"`,
    `sandbox=""`) an opaque origin: its document cannot be read or patched from the embedder, is not
    controlled by the service worker — so the proxy cannot serve it — and cannot read `localStorage`, so the
    prelude cannot boot in it. The membrane could not contain it and removed it as it was inserted (ad and
    widget frames were simply missing); keeping it anyway gave a document that drew a 403 and a prelude that
    died at `localStorage`, leaving page scripts running in a half-installed realm. The proxy needs the
    opposite of what the page asked for, so the frame keeps the page's flags — the browser still refuses
    scripts, forms, popups, modals and top navigation as asked — plus `allow-same-origin`, the element is
    marked, and the frame's prelude, asking its embedder, behaves as the document the page described.
    `self.origin`, `location.origin` and `e.origin` read `"null"` (underneath, a token per document: two
    opaque documents are cross-origin to each other and to their embedder); `localStorage`,
    `sessionStorage`, `document.cookie`, `indexedDB`, `caches`, `cookieStore`, `navigator.serviceWorker`,
    OPFS and `locks.request` refuse as the browser does — a `SecurityError` with its message, or a rejection —
    and `storage.estimate()` rejects with a `TypeError` and `document.domain` reads `""`, as natively;
    `Notification.permission` and `permissions.query` read `denied`; `parent`, `top`, `frameElement` and
    every sibling are cross-origin stand-ins; navigating the top window or the embedder is a
    `SecurityError` without `allow-top-navigation*` (user activation honored), as is anything but itself and
    its descendants; frames it creates are opaque too (measured natively); runtime `fetch`/XHR carry
    `Origin: null` and send cookies only for `credentials: 'include'`. The page's own `sandbox` value reads
    back as written — attribute, property, a real `DOMTokenList`, `outerHTML` — and the embedder's
    `contentDocument` is `null`. The sandbox is rewritten before the frame's first navigation, which is when
    the browser fixes its flags: before any `src`, and for markup before the string is inserted. Every
    namespace of the frame is private to it, so a gap in the list above would still leave nothing of any
    site's to read. — e2e `sandboxed frames are opaque to the page and to each other, as natively` (nine ways
    of making the frame, about forty probes in each, siblings, navigation of the top window, and egress
    attempts by every route a script has, checked by the suite's wire assertion); prelude unit tests for the
    opaque primitives, the flag rules and window handles.
38. **Frames made from markup never loaded.** `host.innerHTML = '<iframe src="/x">'` — and
    `insertAdjacentHTML`, a `<template>` clone, `document.write`, `setHTMLUnsafe`, `outerHTML`, a fragment —
    produced a frame that stayed `about:blank`: the page-side HTML walker rewrites markup in an inert copy
    of the document, opened the frame's route there, and the route completed onto the copy, not onto the
    frame the markup becomes. (Measured native-vs-proxy at the commit before this work for the first
    three; the others share the walker.) A frame in an inert document — the walker's copy, a template's
    content, a `DOMParser` document — is now **parked** as the server's rewriter parks one: the page's text
    waits in `data-zp-frame-src` and `src` holds the blank placeholder in its place (removing it moved it to
    the end of the element's attributes, which `innerHTML` shows). The paths that activate markup — the HTML
    setters, `insertAdjacentHTML`, `document.write`, node insertion — restore parked frames through the
    hooked `setAttribute`, after the sandbox rewrite; a `src` the page sets itself drops the parked text;
    reads (`getAttribute`, `.src`, serialization) answer with the page's text meanwhile. The page's
    `srcdoc` text was lost the same way (the walker kept it in a map on its copy): `frame.srcdoc` read the
    document the proxy injects, prelude tags and boot JSON included; the stash that survives the
    serialization puts it back. — e2e `frames made from markup load and read back as natively`; prelude unit
    tests for parking and restoring.
39. **A bare `frameElement` handed out the embedder's `<iframe>`.** `window.frameElement` and
    `self.frameElement` were stand-ins (`null` across sites), but the free identifier resolved through the
    browser's own global lookup: `frameElement.ownerDocument` was the embedder's DOM, from a cross-site
    child as much as from a sandboxed one. It is a dangerous global now (the rewriter routes it through the
    scope facade). — Rust `rewrites_bare_frame_element`; e2e `sandboxed frames are opaque…`
    (`frameElement`, `typeof frameElement`, an aliased `window`).
40. **A request made right after `document.cookie = x` could miss the cookie.** The jar is in the service
    worker; the write (a message) and the request (a fetch) travel different routes and either may arrive
    first — a window of milliseconds that the suite's `cookies set by fetch and XHR` test fell into on one
    machine, repeatedly (natively the jar is synchronous and the request always carries the cookie). A
    runtime request now waits for the acknowledgement of the writes still in flight; a failed write settles
    too and never holds a request back. Synchronous XHR and navigations cannot wait (see the residual). —
    prelude unit test `cookie writes: a runtime request waits…`; e2e as above.
41. **Scripts put in by `replaceChildren`, `insertAdjacentElement` or `Range.insertNode` — or by
    `before`/`after`/`replaceWith` on a text node — ran raw.** The insertion hooks (`appendChild`,
    `insertBefore`, `replaceChild`, and `append`, `prepend`, `before`, `after`, `replaceWith` on elements)
    prepare an inserted script — its text rewritten, its `src` routed — before the browser sees it. These
    doors had no hook, so an inline script that came in through one reached the browser as the page wrote it
    and ran outside the membrane (measured native-vs-proxy 2026-10-02: `location.href` read the proxy's URL
    where it reads the page's own through `appendChild`); outside the membrane `location` is the real one,
    and assigning it is a real navigation to the target. Every door a node can come through is hooked now,
    and the wrappers report the native method's `length` (they read 0). — e2e `scripts put in by every
    insertion door run through the membrane (matches native)` (nineteen doors, shadow roots and clones
    included; three mutations checked).
42. **A sandboxed frame's requests carried the site's cookies, and its responses set them.** Natively a
    document with an opaque origin is cross-site to everything: of the jar only `SameSite=None` cookies
    travel with its requests (`<img>`, stylesheets, scripts and runtime `fetch`/XHR alike), and only those
    may be set by its responses. The service worker attached the tab's whole jar to every request it
    forwarded. Every route a document registers now says whether the document is opaque (`FRAME_ROUTE`,
    `HISTORY_UPDATE`, `OPEN_SHARE`), the tab's entry keeps it, and the transport filters the jar both
    ways (`cookiesForURL(…, crossSite)`, `setCookieLine(…, { crossSite })`). Found on the way: a `Secure`
    cookie was never sent to `http://localhost` — Chrome sends it to loopback (`localhost`, `*.localhost`,
    127/8, `::1`) — in the jar or in `document.cookie`. — e2e `a sandboxed frame sends and keeps only the
    cookies a cross-site context may (matches native)` (image, stylesheet, fetch with and without
    credentials, cookies an opaque frame's responses set; three mutations checked).
43. **A popup opened by a sandboxed frame was not itself opaque.** The browser applies the opener's sandbox
    flags to the popup either way; the origin is what the membrane emulates, and the popup path knew its
    opener's site, not its sandbox. `OPEN_SHARE` now carries `opaque` and the worker's boot JSON hands it to
    the popup's prelude (`allow-popups-to-escape-sandbox` leaves the popup unsandboxed, with its real
    origin). A frame the popup makes is opaque too. — e2e `a popup of a sandboxed frame is as opaque as the
    frame (matches native)` (opaque, escaping and no-popups variants; two mutations checked).
44. **A synchronous XHR made right after `document.cookie = x` could miss the cookie.** Item 40 made
    runtime `fetch` and asynchronous XHR wait for the write's acknowledgement; a synchronous call cannot wait.
    It carries the writes the worker has not acknowledged (the newest 32, `dv` + `ck` query values, bounded
    and shape-checked by the Go relay) and the worker applies them before it reads the jar. A write has an
    id, so the worker applies it once whichever route arrives first and the writing document ignores the
    push of its own. — e2e `a cookie written just before a synchronous XHR goes out with it (matches native)` (the message is
    held back on purpose, so the race is deterministic; mutation checked), prelude unit tests, Go
    `TestParsePendingCookies`.
45. **CORS was not enforced: a cross-origin `fetch`/XHR the target never allowed resolved.** The proxy sends
    the page's requests itself, so the browser's rules are its to apply — they were skipped, and every
    response read `basic`. The worker now applies the Fetch Standard to a page's cors-mode request, against
    the document's *virtual* origin (`null` for an opaque one): the request is tainted once it leaves the
    origin (redirects included); an "unsafe" one (method other than GET/HEAD/POST, a header outside the
    safelist, a `Content-Type` other than form/text) is preflighted first — an OPTIONS without
    credentials, answered 2xx, passing the CORS check, allowing the method and every header, cached per tab
    for `Max-Age` (default 5 s, at most 2 h) — and the request is sent only if that answer allows it;
    every hop's response passes the CORS check (`Access-Control-Allow-Origin` naming the origin, or `*`
    without credentials; `Access-Control-Allow-Credentials: true` with); after a redirect between two
    other origins the request says `Origin: null`; a redirect to another origin with credentials in the
    URL is refused; the response reads `cors` and shows the page only the safelisted headers and what
    `Access-Control-Expose-Headers` names (`*` only without credentials). A refusal is one `fetch()`
    rejection (`TypeError: Failed to fetch`) — a typed answer from the worker, because a bare network
    error looked like a dead endpoint and the page asked again over the v1 path, which sent every refused
    request twice. Synchronous XHR goes the same way (it used to send cookies on every request,
    `withCredentials` or not) and `send()` throws `NetworkError`; the headers it may read now reach the
    page whole (the relay passed five header names). Chrome 148, the reference, lets `*` in
    `Access-Control-Allow-Headers` cover `Authorization` (the Standard does not), so it does here. Not
    CORS requests, and so not checked: an `<a ping>` (the browser sends it whatever the target answers),
    and the `Cache-Control: no-cache` an `EventSource` carries counts as the browser's own header, not the
    page's, so it never makes a stream need a preflight. Refusals are listed by `__zp_refusals()`
    (`CORS_PREFLIGHT_FAILED`, `CORS_CHECK_FAILED`, `CORS_REDIRECT_CREDENTIALS`) — GitHub, CNN, NAVER, the
    Guardian, BBC and Wikipedia render as before; what they refuse is telemetry (`sendBeacon` with
    credentials to endpoints that send no `Access-Control-Allow-Origin`, or `*`), which native refuses
    too. — e2e
    `cross-origin fetch and XHR obey CORS: who may read, when the browser asks first, redirects (matches
    native)` (about seventy cases — origins, credentials, exposure, preflight, redirects, async and sync XHR
    — identical to native, request logs included; five mutations checked).
46. **A `<script src>` in a frame whose sandbox forbids scripts was never requested.** The browser still asks
    for the scripts of such a frame (its preload scanner does — measured natively for `sandbox=""`,
    `allow-same-origin`, `allow-forms`, and the scripts-enabled flags alike), but not when the document carries
    a CSP `<meta http-equiv>`: a header CSP leaves it alone, a meta CSP — permissive or `default-src 'none'` —
    makes Chrome 148 skip every script of the document. The prelude put such a meta beside the CSP header
    (a second layer added on a premise that turned out wrong, kept as defense in depth), so these frames
    requested their images and styles but not their scripts, which only a server's request log could tell.
    The meta is gone; the header is the one policy (it covers the whole document from the commit, the meta
    only what follows it, so nothing is weakened), and a CSP the target put in its own `<meta>` is kept as
    before. — e2e `a script in a frame that may not run scripts is requested as natively` (ten ways of
    making frames across six sandboxes, script and image of each, markup, `createElement` and `innerHTML`;
    one mutation checked), `request-policy` unit test on the prelude.
47. **Ad images showed as red blocks (Naver's main page).** A frame the worker does not control — an ad frame
    written with `document.write`, a `srcdoc` frame — gets its images through its parent, which fetches them and
    swaps in a blob; until then the image holds a placeholder, so nothing leaves the frame for the target. The
    markup is first rewritten in an inert parser copy, and the copy stamped the placeholder into it; the swap then
    went to the copy's element, while the live element, which holds the same placeholder, was never given a
    second look (the sweep that swaps skips what is not a proxy URL). The placeholder itself — documented as a
    transparent pixel — decodes to `rgba(255, 0, 0, 127)`: stretched to its slot, a red block. Measured on the
    pushed `8a9ee8e` and on `99f3bf4` (before this session's first commit): 5–8 stretched placeholders on the
    Naver main page (ad banners and the right-hand ad). A live element holding the placeholder now starts over
    from the target URL it carries (a blob in a worker-less document, the proxy path elsewhere), markup walked for
    a `srcdoc` frame — which loads its images itself — is not stamped at all, and the placeholder is transparent.
    — e2e `images in frames and in markup end up as the real image, not the placeholder (matches native)` (a
    written frame, a srcdoc frame, a plain document, a written frame inside a written frame; two mutations
    checked).
48. **CORS was not applied to elements that ask for it.** A `crossorigin` image, script or stylesheet, a module
    script, a font from `FontFace` or `@font-face` (and `mask-image`, preloads…) is a cors-mode request of its
    document, held to the target's answer exactly like a `fetch()` (item 45): the browser only sees the worker's
    reply, which always allows its own origin, so a load the target never allowed succeeded. The worker now
    judges the browser's request (`req.mode === 'cors'` with a destination) against the document's virtual
    origin and takes its credentials mode from the element (`anonymous` sends no cookies across origins,
    `use-credentials` does and needs `Access-Control-Allow-Credentials`). It never preflights — the headers are the
    browser's — and an element names its `Origin` even to its own site, as Chrome does (measured). Two things
    found on the way: `new FontFace(family, 'url(…)')` was never routed through the proxy at all (the browser
    fetched the target directly, which the CSP refused, so every URL font failed, same-origin ones included) — it
    goes through the same rewrite as an `@font-face` rule now; and the parent of a worker-less frame fetches that
    frame's images with a plain `fetch()`, which has no destination and must not be taken for an element.
    — e2e `crossorigin elements, modules and fonts obey CORS as natively` (images, scripts, modules, stylesheets,
    fonts, redirects, credentials, `Origin: null` from an opaque frame: identical to native, request logs
    included; six mutations checked), `request-policy` unit tests. Real sites (Wikipedia, GitHub, the Guardian,
    CNN, NAVER, BBC, MDN): no element load refused — what is refused is still telemetry.
49. **A member operation on `null`/`undefined` answered `undefined` instead of throwing.** `__zp_get`, `__zp_set`,
    `__zp_delete` and the descriptor/keys helpers did `Reflect.…(Object(base), …)`, and `Object(null)` is `{}`:
    every rewritten member operation — `w.location.href` with `w === null` (a blocked `open()`), `e.target.href`,
    `n.href++`, `delete n.location`, `Object.keys(n)` — quietly produced `undefined`, so code that catches the
    `TypeError` took another branch. They throw now, and what they throw is the engine's own: the failing operation
    is performed in eval'd code tagged `//# sourceURL=<virtual document URL>`, so V8 words the message exactly as
    natively and an uncaught one names the page in `ErrorEvent.filename` (a `throw` in the prelude would name the
    proxy's asset — the earlier `에러-filename-누출` trap). `Reflect.has`/`Reflect.get`/`Reflect.set`/`Reflect.ownKeys`
    refuse any non-object, as natively. `?.` forms are unchanged. Measured on seven real sites, in every frame:
    no nullish operation reaches the helpers (native Chrome reports zero uncaught errors on the same sites), so
    nothing relied on the old answer. — e2e `member operations on null and undefined throw as natively` (88
    cases across `null`, `undefined`, a plain object and a number: identical to native, uncaught errors'
    `filename` included; nine guards mutation-checked).
50. **Elements in a frame the worker does not answer itself were not held to CORS.** A blank frame a script
    writes into (Naver's ad frames are these) gets its images from its parent (a placeholder first, then a blob),
    its stylesheets through the synchronous relay and its scripts through the parent's fetch; none of those is the
    element's own request, so item 48's rules never saw it: a `crossorigin` image, stylesheet or script the target did
    not allow loaded, with no `Origin` and with cookies. The parent now says what the element asked for
    (`X-ZP-Element-CORS` on the fetch, `cors=` on the relay URL, a third argument of the script loader), the worker
    judges it as it judges the browser's own request, and an image it refuses ends in an error, not in the
    placeholder. A fetch with no destination and no such header is still not an element. — e2e `crossorigin
    elements, modules and fonts obey CORS as natively` (a written frame and a srcdoc frame, each with an image, a
    stylesheet and a script, allowed and not, and a DOM-made image; request logs identical to native), five
    mutations checked. `blob:` frames stay sealed (intentional, see the table above).
51. **An external script in a `srcdoc` frame never ran** — nor did a module's imports, nor anything that needed
    them. A srcdoc frame is controlled for its fetches, yet `navigator.serviceWorker.controller` is `null` inside
    it, so it cannot bind itself to its tab with a message as other frames do; its script URL carried no `tab`, so
    the worker answered `SW_NOT_READY` (503). (Images in the same frame worked: their URLs carry the tab.) Markup
    walked for a srcdoc frame now names the tab and the entry in each script URL, and the first script request binds
    the frame's client — as a worker's first request does — so a module's later imports, which carry nothing, find
    their frame. — e2e `scripts in a srcdoc frame run in order, external ones included (matches native)` (inline,
    external, a script that needs the external one, a module with an import; two mutations checked).
52. **Request bodies went out without a `Content-Length` over HTTP/2.** The kernel strips the page's own
    `content-length` (it frames the request itself), and its HTTP/2 path never put one back — an HTTP/2 POST
    carried a body of unstated length, which Chrome never sends. Servers that frame a body by its length refuse it:
    Optimizely's event endpoint answered every POST of CNN's page `400` (eleven per load; `204` for the same bytes
    with a length — replayed directly over HTTP/2 to be sure), and a bodiless POST or PUT lacked Chrome's
    `Content-Length: 0` over HTTP/1.1 as well. One rule now serves both transports (`wants_content_length`: a body,
    or a POST/PUT without one), and over HTTP/2 the header follows the pseudo-headers as Chrome's does. CNN's load:
    no Optimizely `400`. The e2e target speaks plain HTTP, whose framing Go sets itself, so the HTTPS/HTTP-2 half is
    pinned by the codec's unit tests and the real site, not by the suite. — `zp-transport-codec` tests; e2e `request
    bodies are framed as natively` (bodies, types and lengths of eleven kinds of request).
53. **A script created by a script in a frame the worker does not answer itself never loaded.** A srcdoc frame
    cannot bind itself to its tab (item 51), and the URL of a script its own code creates — not the markup walked for
    it — carried no tab either: `apstag.js`, the script that feeds CNN's ad slots, got `SW_NOT_READY` (503). Every
    script URL a srcdoc realm builds now names its tab and entry (only a srcdoc realm's boot config carries
    `proxyOrigin`). In a blank frame written with `document.write` the frame is no client at all, so a script element
    its code creates asked the server directly and was refused (403: CNN's PubMatic ad layer script, so no ad drew in
    those frames, and a `Refused to execute script … text/html` in the console); such a script now goes through the
    synchronous relay, which answers with the rewritten script and, being a real load, fires `load`/`error` as the
    page expects. A module and a script of an ordinary document keep their URLs. — e2e `scripts in a srcdoc frame run
    in order…` (a dynamic script as a frame's first request, one mutation checked), `a script a written frame creates
    is loaded, with its load event` (also three image beacons).
54. **`Reflect.get`/`Reflect.set` on a dangerous name were rewritten into a member read/write.** A literal key
    (`'location'`…) went to `__zp_get`/`__zp_set`, so a non-object target did not throw `Reflect.get called on
    non-object`, `Reflect.set` answered the value instead of `true`, and the receiver argument was dropped. They go
    through `__zp_rget`/`__zp_rset` like a computed key does. — e2e `member operations on null and undefined throw as
    natively` (literal, computed and receiver forms on four receivers).
55. **A global read inside an assignment target read as `undefined`.** In a destructuring or `for-of` target the rewriter
    sends a dangerous global that *is* the target (`[location] = a`) to a write-only sink, which reads back
    `undefined` by design. But it also sent the ones that are only read there — a member's receiver
    (`[window.dotcom.k] = a`), a computed key (`[t[location.href]] = a`), a default value (`[v = document.title] = []`) —
    so `[,,,window.dotcom.data.pillar] = path.split('/')` became `undefined.dotcom` and threw. BBC's ad script
    (`dotcom-ads.js`) died on exactly that: no ad layer, plus an empty `Uncaught (in promise)` in the console. Only the
    identifier that is itself the target takes the sink now; anything nested in it is a read. — rewriter test
    `globals_read_inside_assignment_targets_are_not_sunk` (twelve forms, three emission checks); e2e `globals read inside
    destructuring and for-of targets read through the membrane` (thirteen forms, proxied == native; reverts to the BBC
    error with the fix removed). A corpus of 11 real scripts (3 MB of ad, analytics and library code) rewrites with no
    read through the sink.
56. **A complete document lost its html, head and body tags wherever the page parsed it.** The page-side markup walker parsed
    in a `<template>`, which drops those start tags — and with them `<body class style data-*>`, `<html lang>` and the
    doctype. A srcdoc frame, `new DOMParser().parseFromString(doc, 'text/html')`, `Document.parseHTMLUnsafe` and a document
    written with `document.write` all came out in quirks mode (`BackCompat`) without their body attributes, and an inline
    script in a srcdoc body found `document.body` null — a creative's first act is `document.body.appendChild`. A complete
    document (srcdoc, DOMParser, parseHTMLUnsafe) is now parsed as one; the doctype stays in front of the injected prelude.
    A `document.write` chunk that opens with a doctype or an html/head/body tag is parsed as a document too (the browser's
    parser merges a later `<body>` onto the body it has), and a bare doctype is passed on. Fragments (`innerHTML`,
    `insertAdjacentHTML`) keep the template: those tags are not part of a fragment. — e2e `complete documents keep html, head
    and body when parsed by DOMParser and srcdoc` (DOMParser, parseHTMLUnsafe, srcdoc, a document written whole and in
    pieces: lang, classes, style, data, compatMode, and a script's view of the body; proxied == native).
57. **A script a hidden frame's creative made kept the observer busy for ever (NYT froze).** Item 53 sent a script created in a
    frame the worker does not answer itself through the synchronous relay, whose URL carries a fresh request id. The
    membrane's observer re-enforces a script's `src` when the attribute changes, and a new id *is* a change: set the source,
    observe the change, set the source… a microtask loop that starved the page (Geoedge's tag in NYT's hidden ad frames).
    Three guards now: the observer treats a relay for the same target as settled; the setter reuses the relay already on the
    element; and a write of the value already there is skipped (a same-value write is still a mutation record). The first
    alone suffices, the other two keep a second observer from starting it. This shipped in `a1b2e0a` and was found by the
    real-site sweep; the fixture is the shape that froze it (a creative in a srcdoc ad frame writes a script into hidden
    blank frames, three ways) with a heartbeat for the main thread. — e2e `a script a written frame creates is loaded`
    (mutation: with the guards removed it wedges for 50 s and fails).
58. **A video's HLS playlist reached the browser unrewritten, so the video never played.** `<video src="….m3u8">` is
    played by the browser's own HLS player, which fetches the playlist's variants, keys, init segments and segments itself,
    in the media stack, where no hook reaches: absolute target URLs (refused by `media-src 'self' blob:`, so no leak) or
    relative ones resolved against the proxy's route (a 404 on `/zp/api/<segment>`). A playlist a media element loads
    (destination video/audio, a playlist type or path) is now rewritten whole — every URI line and every `URI="…"` attribute
    becomes the proxy route for its absolute target, `data:` and other non-http(s) URIs are left alone — and a `Range`
    request is answered from the rewritten bytes (206, `Content-Range`, 416 past the end). A page that plays HLS through
    `fetch` (hls.js) is not touched. The transport copies the browser's own request headers, `Range: bytes=0-` among them,
    and a CDN (NYT's Fastly) answers that with a 206 of the *original* bytes: `noRange` keeps it off a playlist's request.
    On NYT the hero video now plays (readyState 4, 608×1080, advancing). — e2e `a playlist a media element loads…` (master →
    variant → key → segment through the proxy, a CDN that 206s a ranged playlist; mutation: without `noRange` upstream sees the
    Range), unit tests in `test/js/playlist.test.js`.
59. **`for(;;update)` came out as a SyntaxError.** The loop cap for a `for` with no init and no test put the
    `let __zp_lc_N=0;` prefix at the statement's start and a marker over `stmt.start..update.start` — the marker's range
    swallowed the prefix, its first `;` was the prefix's, and `for(;;e++){…}` became
    `let c=0;let c=0;c++<10000000||(…)for(;;e++)`. NYT's video player (hls.js) did not parse and its 28 uncaught errors were
    all this. The region now starts after the `for` keyword. — `loop_cap_constant_true` (the shapes) and
    `loop_cap_headers_always_parse`: 3,360 combinations of init × test × update × body × position, each re-parsed, none with a
    repeated counter (mutation: the old start fails on the first). 697 real scripts (47.9 MB of ad, analytics and library code
    from thirteen sites' network tapes) rewrite to output V8 accepts.
60. **`innerHTML` on a script (React Helmet) was read as markup.** `script.innerHTML = code` is how React Helmet puts an inline
    script in the head (NYT's ad config). The membrane ran the code through its HTML transform, which read `n<i;n++)for(var o in
    t…` as a tag with attributes and handed the script back with attributes for code. Natively the fragment parser, with a raw-text
    or RCDATA context element, makes one text node: `script`, `textarea`, `title`, `xmp`, `plaintext`, `noembed`, `noframes`
    and `noscript` (raw text where scripting is enabled) now pass the string to the native setter. A script's text is wrapped
    when it is inserted, as before. — e2e `innerHTML on a script, textarea, title and noscript sets text` (mutation checked).
61. **The wire and the persona had drifted from the browser again.** Opened both ways, `tls.peet.ws/api/all` showed the
    proxy's ClientHello missing a GREASE signature algorithm and a GREASE key share, carrying a lone X25519 share on every
    connection after the first (rustls's `kx_hint`; Chrome always offers ML-KEM and X25519), and an ECH GREASE of constant
    config id 0 and payload 192 (Chrome: a random id, 144/176/208/240). Worse, the GREASE draws and the ECH noise started from a
    fixed constant, so the first hello after every worker start was byte-identical for every user. All fixed in the rustls fork
    (`seed_entropy` called from `kernelSetCapturedSpec`; GREASE sig alg and key share on an initial hello only; the hint
    ignored when a spec is installed; Chrome's ECH GREASE shape). The persona moves 151 → 154 with the machine's browser, and
    `sec-ch-ua` is now computed by Chromium's rule rather than typed (the typed 151 list had Chromium first; by the rule
    Chrome 151's order is GREASE, Google Chrome, Chromium). Result, fresh session, same browser opened both ways: JA4
    `t13d1516h2_8daaf6152771_806a8c22fdea`, peetprint `8f568b2a…`, HTTP/2 hash `52d84b11…` — equal; ten hellos each:
    key-share shape, 12 signature algorithms, ECH sizes — equal. Naver (nid, mail: 8 of 8), Google, GitHub load. —
    `crates/zp-kernel-bundle/tests/tls_entropy.rs`, `test/js/core.test.js` (the brand rule against six lists real Chrome
    sent; the worker's copy of the UA).
62. **Dynamic code did not declare globals the way the browser does, and `this` was not the window.** A challenge's bootstrap
    defines its decoder with `eval("function name(…){…}")` and calls it by name from another script. A sloppy direct eval at
    the top level of a classic script ran inside the helper that gives an eval its caller's bindings, so its `var`s and
    functions were the helper's locals and vanished with it; a string timer ran its code through a path that did the same.
    Both now run as global code (the DEVAL marker carries a "global site, sloppy" flag; the helper takes the global path for
    it, and a strict or function-site eval keeps the local one). Also `this`: at the top level of a classic script, in an
    arrow there, and in a string eval's own top level it reads the facade like `window` does (`this === window`,
    `eval('this') === window`, `var self = this; self.location = …` through the membrane). A function body, a method, a class
    member and a module keep theirs, and a function-site direct eval keeps its caller's `this` (`ScriptKind::ClassicLocal`;
    `eval('this')` in a method is the object). — rewriter `global_this_reads_like_window`, `eval_literal_nested_rewrite`; e2e
    `dynamic code declares globals as natively, and the file-system entry points exist` and the surface probe `evalThis`
    (mutation checked).
63. **A cross-origin frame saw no embedder.** `document.referrer` was empty and `location.ancestorOrigins` was an empty list;
    a challenge widget reads both. A frame's referrer is now what the browser gives it (the embedder's URL if same-origin, its
    origin and `/` if not, empty on an https→http downgrade) and `ancestorOrigins` walks the parent chain through each
    embedder's virtual origin. — e2e `a cross-origin frame sees its embedder and a native-shaped stack`.
64. **`Error.stack` was not a browser's stack.** The membrane's own frames (`__zp_call`, `__zp_get`, …) sat between the page's,
    and the `:line:column` of every URL was dropped with the URL. The frames of the prelude's own files are filtered out of a
    stack and a frame's text keeps its positions (those of the code that actually ran, the rewritten one). — same e2e test (an external
    script's callback run inside a membrane call, frame for frame against native; the filter is mutation checked, the
    position-keeping is not separately pinned — that fixture keeps positions either way) (frame names and positions, native against proxied).
65. **`webkitRequestFileSystem` and `webkitResolveLocalFileSystemURL` did not exist.** They were removed with the rest of the
    legacy storage entry points, but the browser has them (a script probing for them reads the absence). They are back as
    functions of the native shape (name, length, masked `toString`) that call the error callback with a `SecurityError`
    asynchronously — the proxy gives a page no persistent file system, and a denied request is the honest answer. — same e2e
    test as 62.

### Residuals (documented, not fixed)

| Residual | Why it stays | Pin |
|---|---|---|
| A srcdoc child reports the parent's virtual URL, not `about:srcdoc` | Needs the document URL split from the origin identity that drives storage, cookies and `postMessage` (100+ uses of `virtualURL`). | surface `framesByName`, iframe `srcdocLocation` |
| V8 names the rewritten callee in some messages (`__zp_get(...).item is not a function`) | V8 renders the call-site AST; matching it needs per-call emission changes. Only buggy call sites surface it. | surface `framesItem` |
| Direct `eval` inside `with(o)` does not see `o` | The eval descriptor carries lexical bindings, not with-objects. Rare (legacy templating uses `new Function`). | surface `withEvalScope` |
| A `var` from a script rejected for redeclaration survives as `undefined` | Eval declaration instantiation runs before the emitted conflict check; splitting the check trades this for registrations surviving a syntax error. | surface `ownKeysLeak` |
| An uninitialized-lexical (TDZ) `ReferenceError` is thrown from the prelude, so `ErrorEvent.filename` is the prelude URL | Moving the throw into emitted code means emitting a check per read. | [trap 에러-filename-누출](.ai/trap-notebook/rewriter.md#에러-filename-누출) |
| An inline script's `Error.stack` ends in `eval (url:L:C)` + `eval (<anonymous>)`, an anonymous function in it is `eval`, `new Function` code is two frames, a `this` of the window facade prints `Proxy.` | The proxy runs inline and dynamic code through `eval` with a `sourceURL`; V8 names those frames itself. The prelude is minified, so a frame cannot be told from its function name which entry point ran it, and a native eval has frames of its own that a rewrite would also have to invent. External scripts are frame for frame native. | e2e `a cross-origin frame sees its embedder and a native-shaped stack` pins the external-script case; the inline case is not pinned |
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
| A cookie another document wrote or a response set reaches this one **after a service-worker round trip** (milliseconds), not within the same task | A write in one frame is readable from a sibling frame once the worker has pushed it; natively the shared jar answers at once. Code that writes a cookie and reads it back through another frame in the same task sees the old value. | — |
| A frame sandboxed without `allow-same-origin` is **same-origin with the proxy underneath**; its opacity is the prelude's | The proxy cannot serve a document that has a real opaque origin (no service worker, no `localStorage`). The browser keeps every other flag, the frame's namespaces are private to it, and every other window sees it as a cross-origin stand-in — but the denial list is code: a gap in it would let the frame read what any same-origin frame can read of its **own** namespace, never of a site's. | e2e `sandboxed frames are opaque to the page and to each other, as natively` |
| A cloned frame, read before it is inserted, shows the rewritten `sandbox` and an absolute `src` | The page's text lives in element-keyed maps that `cloneNode` does not carry; insertion restores the sandbox, not the `src` text. | — |
| A cookie written by `document.cookie` may miss a navigation or an `<img>` request made in the same task | Runtime `fetch` and asynchronous XHR wait for the write's acknowledgement (item 40) and a synchronous XHR carries the write (item 44); these cannot wait. | — |
| `Reflect.getOwnPropertyDescriptor(null, k)` throws `Cannot convert undefined or null to object` (the `Object.` message; native: `Reflect.getOwnPropertyDescriptor called on non-object`) | The rewriter sends `Object.getOwnPropertyDescriptor` and `Reflect.getOwnPropertyDescriptor` to one helper. Always a `TypeError`; only the text differs. | — |
| A Cloudflare managed challenge (Stack Overflow's) does not complete | Cloudflare challenges automated Chrome the same way: a fresh headed puppeteer Chrome stays on "Just a moment…" with no proxy in the way, while this machine's own Edge WebView2 is not challenged at all. The proxy's wire now equals that WebView2's (JA4, peetprint, HTTP/2 hash, TCP/IP — item 61), so the decision is made on the browser's environment, not the request. Chasing it found five real divergences from the browser (items 62–65: dynamic-code globals, `this`, an iframe's referrer and ancestor origins, stack shape, the file-system entry points), all fixed, and the challenge still stops: the widget iframe's VM never evaluates the decoder it should define (`window.ulgk5` is later undefined). There is no native run to compare with — automated Chrome gets the same verdict and WebView2 is not challenged — so the first diverging host call is not named. Opt-in: the launcher's "Challenge compatibility" checkbox. | [trap 2026-08-16](.ai/trap-notebook/LOG.md) |
| Reddit's "Prove your humanity" wall on a cold profile | The same wall appears on a cold native load in the same browser (1 of 3), then passes with the cookie it sets. | — |
| `iframe.sandbox` (the `DOMTokenList`) is empty for a value the membrane virtualized (`allow-scripts allow-same-origin`: native length 2, ours 0) | `getAttribute('sandbox')` is right. The real attribute is removed so the browser does not enforce flags that would let the frame escape; the list is the real element's. (A sandbox without `allow-same-origin` is not this case: its list is a real `DOMTokenList` holding the page's value — item 37.) | — |

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
| child **cookies** between same-site frames, written after the other frame loaded | **fixed** 2026-10-02 (item 36); delivery is asynchronous (Residuals) | e2e `cookies reach every document that can see them, and no other` |
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
| `webkitRequestFileSystem`/`webkitResolveLocalFileSystemURL` | present as functions, always `SecurityError` (item 65) | surface `webkitFS` (equals native) |
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
