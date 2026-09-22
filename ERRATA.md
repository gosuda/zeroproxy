# ZeroProxy — Compatibility & Containment Errata

Comprehensive inventory of remaining JavaScript/iframe/eval/scope/rewriter/CSP
issues, produced for building the long-tail test set. This is a **risk inventory**,
not a fix record: every item states its evidence level, and nothing here is
claimed fixed or verified-compatible until a current test proves it.

Evidence grades:

- **[confirmed-emit]** — verified in this audit by inspecting actual rewriter
  output (`crates/zp-rewriter/tests/scratch.rs`, `cargo test -p zp-rewriter
  --test scratch -- --nocapture`).
- **[confirmed-trace]** — verified by tracing current source paths
  (`web/runtime-prelude.js`, `web/worker-prelude.js`, `crates/*`).
- **[analysis]** — strong code-path reasoning, not yet executed.
- **[historical]** — recorded in `.ai/trap-notebook/`; may be fixed, regressed,
  or stale. Never treat as current evidence.
- **[unverified]** — plausible risk, needs a probe.

Security-critical means a path that can produce a **real, unproxied target
navigation/request or a leaked real object** — i.e. an escape from the
no-escape jail. Compatibility-only means site breakage without an escape.

---

## A. Security-critical escape vectors

### A1. Top-level `var`/`function` declarations shadow dangerous globals — [confirmed-emit, escape]

`var`/`function` declarations cannot create a binding over an unforgeable
global property; the declaration is silently skipped at runtime. The rewriter
still records the name as shadowed and emits every later reference **bare**:

```js
var location; location.href = 'https://t/';   // → var location; __zp_set(location,"href",…)
// bare `location` = real window.location → __zp_set(realLoc) → Reflect.set → real navigation
```

Confirmed variants:

- `var location = {…}` — the initializer itself performs `location = obj` → real navigation
- `function location(){}; location.href = …` — same
- `var document` → `document['location']` → real document → escape
- `var window` / `var top` / `var parent` / `var frames` / `var self` / `var globalThis` / `var opener` / `var history` — bare references resolve to real objects
- `var eval` → `eval('x')` bare → resolves to `root.eval` = dynamicEval (contained only by accident of the override, not by static guarantee)
- `var Function` → `Function('x')()` bare → dynamicFunction (same caveat)
- Module goal: `function location(){}` at module top level is also marked shadowed → bare emission → module `location` still resolves through the real global object

The escape works because top-level `var`/`function`/`class`(? check class) names in DANGEROUS_GLOBALS must never be treated as local bindings — the binding silently fails on unforgeable globals.

### A2. Computed member access — `base["dangerous"]` is never mediated — [confirmed-emit, escape]

There is no visitor for `ComputedMemberExpression`/`OptionalMemberExpression`
computed access:

```js
this['location']                          // emitted raw → real window.location
document['location'].href = 'https://t/'; // → __zp_set(realDoc['location'],"href",…)
iframe['contentDocument']                 // → real child document → .location → escape
frames[0] / window[0] / window['name']    // → real child window → ['location'] → escape
for (k in window) window[k]               // escapes on real objects (scope proxy covers only the facade)
```

`get()`'s `isNativeLocation` second line of defense only guards **reads of URL
properties**. On a leaked real `Location`:

- `.href =` / `.assign()` / `.replace()` / `.reload()` → `__zp_set`/`__zp_call` → `Reflect.set`/`Reflect.apply` → real navigation
- `.toString()` / `String()` / `+loc` → real proxy URL string leak (identity/fingerprint)
- `.constructor`, `==` identity, `Symbol.toPrimitive` → native surface

### A3. `new Function('return this')()` returns the real window — [confirmed-trace, escape]

The prelude's anonymous wrapper is strict (prelude IIFE is strict), so
`f()` → `this === undefined` → `nestedCall` → `Reflect.apply(compiled,
undefined)` → `__zp_dyn__.apply(this)` — sloppy `__zp_dyn__` coerces
undefined/null `this` to the real global object:

```js
new Function('return this')()['location'].href = 'https://t/'  // escape
new Function('return ()=>this')()()                            // arrow `this` same chain
(async function(){}).constructor('return this')()              // Async/Generator variants same
```

Native sloppy `Function('return this')()` also returns the global object, so
semantics are correct but the returned object is real — chains into A2.

### A4. eval-expression path — expression bodies are not rewritten — [confirmed-trace, escape]

`dynamicEval` wraps non-statement input as `with(__zp_scope){return (EXPR)}`
and compiles it **without rewriting**. `this` inside is the real root window:

```js
eval('this.location')                                    // → realLoc
eval('document["location"]')                             // → realLoc
eval('this["location"].href="https://t/"')               // → real navigation
eval('({}).constructor.constructor("return this")()')    // → real window → chained escape
```

Only identifiers go through the with-scope; members/computed/`this` are raw.

### A5. Reflect/Object descriptor paths — [confirmed-emit, escape]

- `Reflect.get(window,'location')` — literal → routed to `__zp_get` ✓
- `Reflect.get(doc, k)` computed — `'get'` is not a dangerous method → raw `Reflect.get` → realLoc → escape
- `Reflect.set(doc,k,v)` computed → raw → real set → escape
- `Object.getOwnPropertyDescriptor(document,'location')` → **diagnostic only, passes through** (`lib.rs` ~1232) → real accessor → `.get.call(document)` → realLoc → escape
- `Object.getOwnPropertyDescriptor(iframe,'contentDocument')` → only `'location'` is special-cased in `__zp_getOwnPropertyDescriptor` → real getter → real child doc → `.location` → escape
- `Reflect.getOwnPropertyDescriptor` → not intercepted at all → same escape
- `document.__lookupGetter__('location')` → not intercepted → real getter → `.call(document)` → escape
- `Object.getOwnPropertyDescriptors` (plural) → not intercepted
- `Reflect.setPrototypeOf(scope, x)` → forwarded to real root proto → mutates the real window prototype (corruption/DoS)
- `Reflect.defineProperty(window,'location',{…})` → trap redirects to scopeTarget → silently "succeeds" where native throws (semantic edge, not escape)

### A6. `open('https://t')` returns a raw real window — [confirmed-trace, escape]

`open()` (runtime-prelude ~3681): http URL → `Native.open('about:blank')` →
async `shareNavURL` → `child.location.href = proxyURL`. **The returned value is
the real window** in the gap:

```js
const w = open('https://t/');
w.document.write('<script>location="https://t"</script>');  // raw script in real doc → escape
w['location']                                                // realLoc
```

Only the `about:blank` branch gets `installNetworkContainment`; the http branch
does not.

### A7. Non-root Document `.location` — [confirmed-trace, escape]

`__zp_get`'s `base === document` special case covers only the **root document
binding**:

```js
iframe.contentDocument.location.href = 'x'   // __zp_get(childDoc,'location') → realLoc → real child nav
iframe.contentDocument.location.assign('x')  // __zp_call(realLoc,'assign') → real nav
el.ownerDocument.location.href = 'x'         // 'ownerDocument' is not a dangerous member → real doc → escape
event.target.ownerDocument.location          // same
document.implementation.createHTMLDocument().location  // real (in-memory: no nav, but value/identity leak)
document.write-created docs, DOMParser docs, xhr.responseXML, cloned/adopted docs — all real
```

`iframe.contentWindow.location` is wrapped (`wrappedLocationFor`), but
`contentDocument.location` is asymmetrically raw.

### A8. `window.navigation` (Navigation API) unhooked — [confirmed-trace, likely escape]

Zero prelude hits for the `navigation` object. `'navigate'` is not a dangerous
method:

```js
navigation.navigate('https://t/');   // real navigation → escape (Chrome/Edge)
navigation.reload(); navigation.back(); navigation.traverseTo(key)  // real history ops
```

Needs browser verification but the hook is absent by construction.

### A9. Dynamic `<meta http-equiv="refresh">` — [analysis, escape candidate]

The MutationObserver backstop's `attributeFilter` is
`['src','srcset','poster','href']` — `http-equiv`/`content` not watched.
Static refresh metas are neutralized by htmltx, but a dynamically created
`<meta http-equiv="refresh" content="0;url=https://t">` is unverified — if it
fires, real navigation.

### A10. Other real-object leak paths — [analysis/unverified]

- `document.write`/`document.open()` → new document → raw scripts execute before hooks attach (historical trap — partial)
- `window.name` — not virtualized → cross-target data bleed within a tab session (isolation)
- `cookieStore` (CookieStore API) — unhooked → real proxy-origin cookies → bypasses the jar → cross-target bleed (isolation)
- `<a ping="https://t">` → browser POST ping on click — whether connect-src blocks it is unverified
- `structuredClone`, `WeakRef`, postMessage transfer of real objects — unverified
- `frames['name']`, `frames.item(0)`, `self[0]`, `this[0]` — A2 pattern
- `window.__lookupGetter__`, `__defineGetter__`, `__lookupSetter__`, `__defineSetter__` — legacy accessors unhooked
- `Object.getOwnPropertyNames(window)` → `nativeOwnKeys(root)` — whether `__zp_*` names are filtered is unverified (comment claims 0 in an exec-js check)

---

## B. Syntax-kill (whole script fails to parse → fail-closed death)

Emitted code is invalid JS — confirmed by rewriter output:

```js
for (location of a) {}      → for (__zp_get(globalThis,"location") of a) {}   ✗
for (location in a) {}      → same                                          ✗
[location] = arr;           → [__zp_get(...)] = arr                           ✗
({a: location} = obj);      → ({a: __zp_get(...)} = obj)                     ✗
```

Only shorthand `({location} = obj)` is handled via the `__zp_get.d` write-sink.

Uncovered target-position variants to test:

- `({a: {b: location}} = o)` nested non-shorthand
- `([location, x] = y)` array targets
- `for ([location] of y)`, `for await (location of y)`, `for ({a: location} of y)`
- `try{}catch(location){}` — if catch targets are patched as identifier references
- Assignment targets inside `switch`/`case`/labels
- `[location.x] = y` / `[...location] = y` spread/rest targets
- `({location = d} = o)` default-in-target

---

## C. Rewriter scope/binding semantic breaks — [confirmed-emit]

The scope stack is sequential — no hoisting, TDZ, or declaration-timing model:

| Source | Emitted | Native | Result |
|---|---|---|---|
| `import location from 'x'` | binding not declared | module binding | later `location` → virtual location (wrong value) |
| `import {x as location}` | same | | same |
| `import * as location` | same | | same |
| `class location {}` | not declared | class binding | later refs → virtual |
| `f(){ location.x; var location; }` | `__zp_get` | var hoists → local undefined → TypeError | returns virtual (wrong) |
| `f(){ location.x; function location(){} }` | `__zp_get` | function decl hoists → local | returns virtual (wrong) |
| `{ location.x; let location; }` | `__zp_get` | TDZ ReferenceError | returns virtual (exception becomes a value) |
| `eval('x')` direct call | `__zp_get(g,'eval')('x')` | caller scope | global scope only → local reads fail |
| `delete obj.location` | `delete __zp_get(...)` | real delete / false / strict throw | always `true` |
| `x?.location?.()` | `__zp_call` | nullish → undefined | TypeError |
| `x?.location` | `__zp_get` | nullish → undefined | `Object(null)={}` → undefined (accidentally correct) |
| `x?.location.href` | `__zp_get` twice | undefined | undefined (accidentally correct) |
| `for(let i=0;;i++)` | uncapped | infinite | loop-cap bypass — hang-protection gap |
| `while(true){await x()}` | capped 10M | permanent poll | silently exits after 10M |
| `super.location` | skipped ✓ | | correct |
| `new.target` (dynamic fns) | `__zp_new_target__`→undefined | real value | undefined (documented limit) |
| `({[location]:1})` | `{[__zp_get…]:1}` | realLoc string key | virtual URL string key (subtle) |
| `location?.reload()` | `__zp_get(...)?.reload()` | real reload | works (proxy trap supplies reload) ✓ |
| `location ??= u` | `__zp_assign` | | eval-order preserved ✓ |
| `x?.["location"]` | raw computed | | facade→virtual / real object→real (A2) |
| `x?.m()` (non-dangerous) | untouched | | correct ✓ |

Scope variants needing tests: `function f(location=location)`, `function
f({location})`, `catch(location)` target, `for (const {location} of xs)`,
`using location = r`, `await using`, labeled function declarations, Annex B
block-level functions, `arguments`/parameter aliasing, eval-created bindings,
`let`/`const` in `for` heads vs bodies, sibling-block shadowing, global `var`
vs `let` cross-script interplay.

---

## D. `with` statement — [confirmed-emit]

`with(o){ location.href='x' }` → `with(o){ __zp_set(__zp_get(globalThis,"location"),"href",'x') }`

Identifiers are bound **statically** to global — `o` is never consulted.
Containment holds; semantics break whenever `o` owns (or shadows) the name.

Required `with` matrix:

- `with(obj)` where obj owns a dangerous name: `{location: fake}` → `location` must read `fake`, reads virtual instead
- obj lacks the name → fall-through → accidentally correct
- `Symbol.unscopables` — prelude's `withScope` honors it in `has`, but the **rewritten** `with` never reaches that proxy
- `with` nested in functions, blocks, arrows, closures
- `with` + `eval` (`with(o){eval('location')}` → dynamicEval cannot see `o`)
- `with` + `this`, `with` + `delete`, `typeof`, `in`, `instanceof`
- `with` + destructuring / default parameters / rest
- `with(realWin)` — real window operand (obtainable via A2)
- `with(document)` — `with(document){location}` → static virtual vs dynamic `doc.location`
- strict mode `with` — must produce the native parse error, not a silent rewrite
- `with` inside dynamically compiled bodies (Function/eval)
- `with` + assignment to dangerous names (`with(o){location = x}`)
- `with` + update operators (`with(o){location++}`)

---

## E. eval / dynamic code coverage gaps

| Case | Status | Note |
|---|---|---|
| `eval('x')` direct-call scope | [confirmed-emit] unimplemented | indirect only → caller scope lost |
| `(0,eval)`, `e=eval;e()`, `eval?.()`, `eval.call(t,'x')` | same path | indirect is correct for these, but A4 expression path is raw |
| `eval('var x=1')` visible in next script | [analysis] partial | top-level `let`/`const`/`class` don't land in shared global lexical scope (documented limit) |
| `eval('"use strict";…')` strict eval | unverified | strict eval scope rules |
| eval-thrown SyntaxError propagation | unverified | |
| `Function` param parsing: default/rest/destructuring/comments/unicode | unverified | `new Function('a=1',…)`, `('{x,y}',…)`, `('/*c*/a',…)`, `('한',…)` |
| `new Function` `new.target` | [historical] always undefined | documented limit |
| `new Function` `this` | [confirmed-trace] real window | A3 |
| `arguments.callee` on dynamic fn | unverified | exposes `__zp_dyn__` → possible toString source leak |
| `setTimeout('…')`/`setInterval('…')` | hooked ✓ | but `this`/`["x"]` inside the string share A2/A3 holes |
| event-handler attributes `onclick="…"` | `__ZP_EXEC_EVENT` ✓ | `el.onclick='code'` property-string path unverified |
| `import()` dynamic: relative/absolute/data:/blob: | partial | `data:`/`blob:` → NotSupportedError; native allows `data:` module import → compat break |
| `import.meta.url` | ✓ virtual | `.resolve` and other props unverified |
| `import()` inside eval-expression | [analysis] raw | expression path → specifier unrewritten |
| `new Function` containing `with`/`eval` | unverified | recursive dynamic code |
| `AsyncFunction`/`GeneratorFunction`/`AsyncGeneratorFunction` ctor chains | mostly masked ✓ | `arguments`/`this`/`new.target` share A3 limits |
| `eval` in module code | unverified | strict-eval + module scope |
| `eval` returning completion values (objects, `undefined`, non-strings) | unverified | `eval(123)`, `eval(undefined)`, `eval({})` |
| `new eval()` / `eval` as constructor/tag | unverified | `eval\`x\`` tagged template |
| String timer `this` | unverified | `setTimeout('this["location"]…')` → A2 |

---

## F. iframe / child realm

| Case | Status |
|---|---|
| `iframe.contentWindow.location` | ✓ `wrappedLocationFor` |
| `iframe.contentDocument.location` | **A7 escape** |
| `iframe['contentWindow']`/`['contentDocument']` | A2 computed escape |
| `frames[0]`, `window[0]`, `window['name']`, `frames['name']`, `frames.item(0)` | A2 — real child → computed escape |
| `iframe.src = blob:`/`data:`/`javascript:` | blocked ✓ → **legit blob/data frames break** (compat) |
| `iframe.srcdoc` | `data-zp-srcdoc` pipeline ✓ |
| `sandbox` attribute | `sanitizeFrameSandbox` ✓ |
| dynamic iframe creation/insertion | `patchInsertion`+`instrumentDescendantIframes` ✓ — insert→script→remove race unverified |
| `document.write` → new document | historical trap — partial |
| `open()` returned window | A6 escape |
| `postMessage` child↔parent | ✓ + early mapping — `ev.source`/`origin` virtualized |
| `iframe.contentWindow === frames[0]` | identity unverified |
| `top.location`/`parent.location`/`opener` | facade ✓ |
| child `document.cookie`/storage isolation | unverified |
| sandboxed frame `allow-same-origin`+`allow-scripts` | historical: naver shopad opaque-origin break — partial |
| `<object>`/`<embed>`/`portal`/`fencedframe` | `object-src 'none'` + attr blocking — compat break (legacy sites) |
| `iframe.csp` attribute | unverified |
| `credentialless` | unverified |
| `<a target=framename>` click navigation | unverified |
| iframe `onload`/`onerror` + inline handlers | unverified |
| child CSP inheritance | unverified |
| SharedWorker created from child realm | unverified |
| stale realm cleanup after child navigation | unverified |

---

## G. Worker realm — thin containment — [confirmed-trace]

```js
self.XMLHttpRequest = undefined;          // XHR removed — axios fallback/pdf.js etc. break
self.WebSocket = function(){blocked()};   // worker WS/ES/RTC/WebTransport all blocked
eval/Function → blockedDynamic            // emscripten-style loaders using Function break
```

- `location` = plain `URL` object — no `assign`/`replace`/`reload` (native `WorkerLocation` has no methods either — close approximation; toString/enumerability shape needs verification)
- `setTimeout('code')`/`setInterval('code')` — unhooked → natively compiled → runs against real globals → semantic break (egress contained by CSP — unverified)
- `importScripts` → proxied ✓ — `importScripts('data:')`/`('blob:')` → non-http → throw → break
- `indexedDB`/`caches`/`cookieStore` — no worker-side facade → real proxy-origin storage → cross-target bleed
- `navigator` — real (fingerprint-consistent, but unvirtualized)
- module worker `import.meta.url`, static import resolution — unverified
- SharedWorker per-target prefix — restored 2026-09-14, needs regression test
- Worker `onerror`/`error.stack` — may leak proxy URLs
- `postMessage` + transferables — wrapped; port paths unverified
- Worker termination mid-request, worker errors, uncaught exceptions — unverified
- multiple workers with different targets/tabs — unverified

---

## H. Unhooked / partially hooked API surface — [confirmed-trace/analysis]

| API | Status | Risk |
|---|---|---|
| `window.navigation` | **unhooked** | A8 escape |
| `window.name` | **not virtualized** | cross-target bleed |
| `cookieStore` | **unhooked** | jar bypass + bleed |
| `new URL('rel')` single-arg | **unverified — likely unhooked** | resolves against real document base (proxy URL) → wrong resolution → breakage |
| `import.meta.resolve` | unhooked | proxy-relative resolution |
| `alert`/`confirm`/`prompt`/`print` | stubs (confirm→false, prompt→null) | dialog-dependent flows break silently |
| `navigator.serviceWorker.getRegistrations()` | real | exposes ZeroProxy's own SW → fingerprint |
| `location.ancestorOrigins` | unverified | real value |
| `history.go/back/forward`, `history.length` | real | session history — minor fingerprint |
| `locationbar`/`menubar`/etc. bar props | real | minor |
| `document.featurePolicy`/`policy` | real | minor |
| `ElementInternals` | real | unverified |
| `XMLSerializer.serializeToString` | unverified | needs de-proxy pass |
| `Object.getOwnPropertyNames(window)` | `nativeOwnKeys(root)` | `__zp_*` leak unverified |
| `el.onclick='code'` string setter | unverified | native compilation → real globals |
| `document.write` second document | historical | partial |
| `adoptedStyleSheets`, `CSSStyleSheet` ctor | CSS hooks partial | `url()` rewrite unverified |
| `document.createExpression`/`evaluate` XPath | real | minor |
| `webkitTemporaryStorage`/`webkitPersistentStorage` | real | proxy-origin shared |
| `showOpenFilePicker`/`showDirectoryPicker`/`showSaveFilePicker` | real (intentional per D6) | consent-gated |
| `WebAuthn`/`Credentials`/`PaymentRequest` | real | RP ID = proxy host → breaks by nature |
| `document.hasStorageAccess`/`requestStorageAccess` | real | unverified |
| `navigator.registerProtocolHandler` | real | registers proxy-origin handler |

---

## I. URL / navigation semantics

- `location === document.location` — `wrappedLocationFor` proxy vs `virtualLocation` object → **almost certainly `false`** (native `true`) [analysis]
- `location.assign('mailto:')`/`'tel:'` → `targetURL` non-http → `TARGET_PROTOCOL_BLOCKED` throw — native navigates → minor break
- `history.pushState` cross-origin → SecurityError — matches native ✓
- `history.pushState(state,title)` no URL → keeps current virtual URL ✓
- Dynamic `<base>` creation → `base-uri 'none'` + no JS hook → Angular-style `<base href>` apps: element blocked, resolution falls back to virtual baseURL — subtle breakage
- `location.protocol/host/hostname/port/pathname/search` writes → URL merge → assign — needs per-prop regression
- `location.ancestorOrigins` — real
- `window.open(url,'name','features')` — features/window-reuse semantics lost
- `form.requestSubmit()`/`form.submit()` — hooked; `submitter.formaction` override unverified
- `<form>` + `enctype=multipart` + large body → `REQUEST_BODY_TOO_LARGE` path exists
- `a.download`, `a.ping`, `a.referrerpolicy` — unverified
- `window.event` (legacy), `external`, `showModalDialog` — absent/real
- hash-only navigation (`#x`) → `updateVirtualHash` ✓
- `location.reload()` → local `locReload` → virtual reload ✓
- `location.replace` history semantics under proxy URL — unverified
- `beforeunload`/`pagehide`/`visibilitychange` — real ✓
- `location.hash` write → virtual ✓; `location.search`/`pathname`/`port`/`hostname`/`host`/`protocol` writes → merge→assign — per-prop tests needed
- `new URL(rel, base)` explicit base → correct when base is virtual ✓; single-arg `new URL(rel)` → real doc base → **proxy path leak/break** [unverified]
- `URL.createObjectURL` hooked; `URL.revokeObjectURL` hooked; `URL.canParse`/`URL.parse` statics — unverified

---

## J. HTML/CSS transformer residuals

- `srcset` + data-URI (`data:…,AAA 1x` contains a comma) — historical trap; variants unverified
- `<script type="importmap">` — URL JSON map — unverified (if unrewritten, specifier resolution breaks)
- `<script type="speculationrules">` — prefetch/prerender URLs → potential direct loads — unverified
- `<template>` contents — historical bug; current state needs verification
- Declarative shadow DOM (`<template shadowrootmode>`) — unverified
- `srcdoc` entity double-decoding — unverified
- SVG `<script href>`, `<image href>`, `<use href>`, `xlink:href` — unverified
- `button/input formaction`, `area href`, `q/blockquote/del/ins cite`, `body/table/td/th background`, `video poster`, `track src`, `input.src`, `link imagesrcset` — attribute coverage list needs enumeration
- `<noscript>` — raw-text under scripting — unverified
- `<meta http-equiv="refresh">` — static ✓ / dynamic A9
- `<meta charset>`/transcoding — unverified
- Other `http-equiv` (`set-cookie`, `origin-trial`, `default-style`) — unverified
- MathML `href`/`annotation-xml` — unverified
- Double-rewrite prevention (proxy URL fed back as input) — unverified
- `document.write` fragment payloads (tags split across calls) — unverified
- `<script>` `.text`/`.textContent`/`.innerText` assignment, `appendChild(textNode)` — descriptors captured (scriptText/textContent); hook coverage needs verification
- CSS: `@import` in `<style>`/cssRules, `insertRule`/`deleteRule`, `cssText`, Typed OM ✓ (2026-09-10), `adoptedStyleSheets`, `style` attr on SVG, `image-set()`, `cursor: url()`, `-webkit-mask-image`, `shape-outside`, `content: url()`, `@font-face` src — each needs read/write round-trip tests
- `<link rel=stylesheet disabled>`, `media` attribute switching — unverified
- `nonce`/`integrity`/`crossorigin`/`referrerpolicy`/`fetchpriority` on scripts/links — integrity stripped ✓; rest unverified
- `<html manifest>` (appcache, legacy), `<applet>` — dead platforms, skip
- Error documents (4xx/5xx HTML), truncated/malformed HTML — transformer must still apply — unverified
- `<base>` static handling — htmltx rebases; verify `document.baseURI` after strip
- `xml:base`, `xmlns` — XML documents — likely out of scope
- `itemprop`/`itemid` microdata URLs — passive, cosmetic

---

## K. CSP over-restriction → legitimate-site breakage — [analysis]

| Directive | Missing | Breakage |
|---|---|---|
| `media-src 'self' blob:` | **no `data:`** | `<audio/video src="data:…">`, `data:` VTT `<track>` → blocked |
| `connect-src 'self' ws:` | **no `data:`/`blob:`** | `fetch('data:…')`, `fetch(blobURL)`, `XHR(data:)` → blocked (historical comment claims a blob fetch worked — browser behavior needs re-verification) |
| `script-src` | **no `blob:`** | if `__ZP_EXEC_INLINE_MODULE` reaches `import(blob:)` → **all inline `<script type=module>` blocked** — top-priority verification |
| `default-src 'none'` | prefetch-src fallback | `<link rel=prefetch>` blocked — perf loss |
| `frame-src` + setter | `blob:`/`data:` in CSP but setter blocks | intentional sealing — legit blob/data frames break |
| `worker-src blob:` | scriptish blob → blockedWorkerBlob | legit blob workers break |
| `base-uri 'none'` | | runtime `<base>` creation breaks (Angular) |
| `object-src 'none'` | | `<object>`/`<embed>` break (intentional) |
| `form-action 'self'` | | rewritten actions pass; missed rewrites blocked (intentional loud fail) |
| `manifest-src 'self'` | | `data:` manifests blocked — minor |
| `img-src`/`font-src`/`style-src` | no `http(s):` | missed rewrites blocked (intentional loud fail) |

Also:

- CSP `<meta>` injection neutralized ✓
- `frame-ancestors` correctly absent on proxied docs ✓, `'none'` on control surface ✓
- `report-uri` → `/zp/api/csp-report` — verify the report itself isn't blocked by classification
- Turnstile origin arming — per-tab gating correctness unverified
- **Two-sided tests required**: legitimate resources (must load) × missed rewrites (must block + report) × every directive
- `script-src-attr`/`script-src-elem` fall back to `script-src` — inline handlers rely on `'unsafe-inline'` — verify no regression if split
- `trusted-types`, `require-trusted-types-for`, `sandbox`, `upgrade-insecure-requests`, `block-all-mixed-content` — correctly absent ✓
- `webrtc-src`, `navigate-to` — not real directives, skip

---

## L. Fingerprint / identity leakage residuals — [historical + analysis]

- `Error().stack` — `/zp/api/script?u=…` URLs + rewritten line/col → stack fingerprint — unverified
- `window.onerror`/`unhandledrejection` filename/lineno — same
- `arguments.callee`/`fn.toString()` on dynamic fns — `__zp_dyn__` source exposure possible (outside toStringMap coverage)
- `console.log(location)` → proxy object printed — devtools fingerprint
- `JSON.stringify(window)`/`Object.values` — virtualized values by design
- `navigator.serviceWorker.getRegistrations` → exposes ZP SW
- `performance.getEntriesByType('resource')` `.name` — masked (~4644); `navigation`/`paint`/`worker` entry types unverified
- `document.scripts` — filtered ✓
- `__zp_*` own-name leak — comment claims 0 via exec-js; `define()` mechanism unverified — needs regression guard
- `new URL(rel)` base — proxy path exposure
- Hook `.name`/`.length`/`.toString()` — `maskNativeFunction` covers most; dynamically generated wrappers unverified
- `performance.memory`, `hardwareConcurrency`, `deviceMemory` — real (consistent fingerprint, acceptable)
- `Intl`/timezone — real — verify persona consistency if applicable
- `document.lastModified`, `characterSet` — real response values — verify consistency after transcoding
- `window.chrome`, `speechSynthesis`, `fonts`, `WebGL`, canvas, `userAgentData` — masked per trap notes; keep regression coverage

---

## M. Performance / hang risks

- `for(let i=0;;i++)`, `for(i=0;x();i++)` — loop cap not applied → real infinite loops possible
- `while(true){await}` capped at 10M → long-lived polls die silently
- `__zp_get`/`__zp_set` per-access proxy cost — `location.href` in hot loops
- Prelude ~8.5k LOC — re-parsed per document/iframe → many-frame pages slow
- MutationObserver whole-DOM watch + instrumentation — large DOM churn
- Rewriter WASM per-script call latency — large bundles/many scripts
- `tickURLCache`/`urlClassifyCache` miss patterns — needs measurement
- SharedWorker/Worker double-bootstrap overhead
- Ignored perf tests in zp-rewriter (4) — run them before any hot-path change

---

## N. Confirmed-correct behaviors (do not regress)

Verified correct in this audit (emitted output or traced code):

- `{ location }` object shorthand → explicit `{location: __zp_get(...)}`
- `({location} = o)` → `__zp_get.d` write-sink
- `location ??= u` → `__zp_assign` eval-order preserved
- `obj.location ??= u` → accessor-object trick preserves receiver/eval-order
- `import.meta.url` → marker → `__zp_module_url`
- `super` member/call — correctly skipped
- `import()` → `__zp_import` + specifier rewrite
- `label: for(;;)` → loop cap applied
- `for(let location of x)` → binding declared → correct shadow
- `typeof`/`void`/`instanceof`/`switch`/`yield`/`await`/tagged-template on dangerous idents → all mediated
- `this.location` (static member) → `__zp_get(this,'location')` → virtual (isWindowLike)
- `location?.reload()` → virtual proxy supplies reload → works
- `x?.location` on nullish → accidentally correct via `Object(null)={}`
- `x ||= y`, `loc ||= y` (non-dangerous) → untouched
- `new Function` body → rewritten + `with(__zp_scope)` nested scope (params/arguments not hidden)
- `eval`/`Function` globals → dynamicEval/dynamicFunction overrides
- `history.pushState`/`replaceState` → `commitVirtualHistory` (same-origin check matches native)
- `document.URL`/`documentURI`/`baseURI`/`referrer`/`cookie` → `defineAccessor` on Document.prototype
- `window.origin` → `defineMasked` → virtualURL.origin
- `sendBeacon` → `fetchThroughRuntime`
- `open('about:blank')`/`open('')` → containment installed
- `open(http-url)` → proxied via shareNavURL (but see A6)
- `iframe.src`/`srcdoc` → `installFrameProp` + `setInjectedSrcdoc`
- iframe/frame `src` `data:`/`javascript:`/`blob:` → blocked (`hasExecutableURLScheme`/`hasContextBlockedScheme`)
- `contentWindow`/`contentDocument` → `containFrameWindow` + `installNetworkContainment`
- `postMessage` → wrapped incl. `MessageEvent.source`/`origin` virtualization
- `Worker`/`SharedWorker` → ZPWorker/ZPSharedWorker
- `audioWorklet`/`paintWorklet`/`layoutWorklet`/`animationWorklet` `addModule` → `workerBootstrapURL`
- `createObjectURL` → scriptish-blob tracking → `blockedWorkerBlob`
- CSP meta injection → `neutralizeCSPMeta`
- `alert`/`confirm`/`prompt`/`print` → stubs (compat tradeoff)
- `DOMParser.parseFromString`/`Range.createContextualFragment` → `transformHTML`
- `innerHTML`/`outerHTML`/`insertAdjacentHTML` → `transformHTML` on write, de-proxy on read
- `getComputedStyle`, `cssText`, Typed OM, `attributes`/`dataset`/Attr.value → de-proxy/filtered
- `document.scripts` → filtered collection
- `PerformanceObserver` entry `name` → masked
- `chrome` object → masked
- WebSocket/EventSource/XHR/fetch → runtime-mediated
- WebTransport/RTCPeerConnection → fail-closed virtual gateways
- `BroadcastChannel` → facade with target prefix
- storage facades (local/session/IDB/Cache) → target-prefixed
- `document.cookie` → jar + `ZP_COOKIE_SET` to SW

---

## O. Test-suite proposal

### 1. `crates/zp-rewriter/tests/` (cargo)

- **Scope matrix**: every `var`/`let`/`const`/`function`/`class`/`import`/`catch`/param declaration × top-level/function/block/eval × each dangerous name × reference before/after declaration
- **Assignment-target matrix**: `for-of`/`for-in`, `[]`, `{}` (shorthand, non-shorthand, nested, rest, defaults), `switch`, `case`, labels
- **Operator matrix**: `?.`, `??`, `??=`, `||=`, `&&=`, `delete`, `typeof`, `void`, `in`, `instanceof`, `**`, unary, sequence, comma, conditional, labels
- **Computed-member matrix**: `x["location"]`, `x?.["location"]`, `x["location"].href=`, `.assign()`, `.replace()`, `.reload()`, `.toString()`
- **`with` matrix**: all of section D
- **Reflect/Object matrix**: get/set/gopd/gopds/lookupGetter/lookupSetter/defineProperty/ownKeys/has × literal/computed × every dangerous prop
- **import matrix**: default/named/star/alias bindings + `import.meta.*` + `import()` static/computed
- **class matrix**: decl/expr/name/field/private/computed-key/static/super
- **sourcemap**: multibyte chars, stripped pragmas, byte-vs-char offsets
- **loop-cap matrix**: `for(;;)`, `for(i=0;;i++)`, `while(true)`, `do{}while(true)`, labels, async bodies, nested loops, `while(cond)` negative control
- **`var`-shadowing matrix**: every dangerous name × `var`/`function` × module/classic goal

### 2. `test/js/runtime` (node — prelude unit)

- `dynamicEval` expression/statement classification
- `compileDynamic` parameter parsing
- `withScope` `has`/`get`/`set` traps
- `targetURL`/`nonHTTPAbsoluteURL` classification
- `isNativeLocation` spoofing (forged `Symbol.toStringTag`, revoked proxies, cross-realm Locations, objects with URL-shaped props)
- `wrappedLocationFor` local/non-local methods, virtualLocation descriptor/freeze/prototype

### 3. `test/js/static-policy` (extend)

- CSP directive × scheme matrix (explicit allow/deny per scheme)
- `dist/` artifact size/signature
- forbidden patterns inside prelude source

### 4. `test/e2e/escape` (E1 extension)

Browser-verified, per section A: `var` shadowing, computed members, `this['location']`, dynamic-Function `this`, eval-expression, GOPD/lookupGetter, `contentDocument.location`, `navigation.navigate`, `open()` window, `frames[i]`, dynamic meta refresh.
Each case: assert no navigation occurred + `__zp_diagnostics` recorded.

### 5. `test/e2e/compat` (new — direct-vs-proxy differential)

Local fixture executed directly and through the proxy; compare results, exceptions, DOM, network. Positive cases for sections B, C, I.

### 6. `test/e2e/iframe`

Creation/insertion/navigation/srcdoc/blob(blocked)/sandbox/nested/remove-race/postMessage/identity/ownerDocument.

### 7. `test/e2e/worker`

dedicated/module/shared × fetch/importScripts/timers/eval(blocked)/location/storage isolation.

### 8. `test/e2e/csp`

Allowed resources (must load) × blocked resources (must report) × every directive. Inline-module blob-import verification is top priority; `data:` media/fetch real-browser checks.

### 9. `test/e2e/dynamic`

eval/Function/timers/event handlers/DOM-insertion paths — success, exception, source-leak assertions.

### 10. `test/e2e/perf`

10M loop-cap boundary, async-poll lifetime, bulk DOM insertion, iframe count × load time.

---

## P. Priority tiers

**P0 — security (escapes confirmed in emitted code / traced paths):**

A1 `var`/`function` shadowing · A2 computed members · A4 eval-expression ·
A5 GOPD/Reflect-computed · A7 non-root `document.location` · A3 dynamic-Function
`this` · A8 `navigation` API · A6 `open()` window · A9 dynamic meta refresh

**P0 — compatibility (verify first):**

`script-src` missing `blob:` × inline-module path · `new URL(rel)` base ·
`location === document.location` · `connect-src` `data:` real-browser check

**P1:**

All of B (syntax-kill) · C scope semantics · D `with` · worker thinness ·
CSP `data:` media · E eval/direct-scope

**P2:**

Fingerprint residuals · performance · legacy APIs
